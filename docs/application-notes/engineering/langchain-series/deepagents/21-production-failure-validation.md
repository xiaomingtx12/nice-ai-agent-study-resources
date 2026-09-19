---
sidebar_position: 23
sidebar_label: 21 故障路径与边界验证
description: 从远端任务、评分器和评测报告的故障路径出发，拆解框架返回与业务交付之间的边界。
---

# Deep Agents 源码解析 21：故障路径与边界验证

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12 源码快照；评测包 `deepagents-evals` 0.0.1。版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - F1、F2 状态筛选与结果回写：`libs/deepagents/deepagents/middleware/subagents.py` → `_validate_and_prepare_state()`、`_return_command_with_state_update()`
> - F3、F4 远端任务：`libs/deepagents/deepagents/middleware/async_subagents.py` → `_build_start_tool()`、`_build_check_tool()`、`_build_cancel_tool()`
> - F5 评分与跳转：`libs/deepagents/deepagents/middleware/rubric.py` → `after_agent()`、`_compose_update()`、`_handle_grader_exception()`
> - F6 预算守卫：`libs/deepagents/deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py` → `NemotronProgressBudgetMiddleware`
> - F7 报告退出码：`libs/evals/tests/evals/pytest_reporter.py` → `pytest_sessionfinish()`
> - 轨迹提取：`libs/evals/tests/evals/utils.py` → `_trajectory_from_result()`、`TrajectoryScorer`
> - 故障注入示例：`scripts/deepagents/reproduce-boundaries.py`（相对文档仓库）

工具正常返回、模型认为完成、业务结果正确，需要分别核验。一个返回 `success` 的远端 Run 可能读不到结果；一个得到 `satisfied` 评分的任务，也可能没有生成要求交付的文件。

本篇沿 [20：Harness 架构与运行边界](20-harness-constitution-rereading.md) 的问题拆解七组故障条件，将源码行为与业务验收要求逐项对照。

## 二、先分清完成信号和证据范围

| 信号 | 能支持的判断 | 还需核验 |
| --- | --- | --- |
| 工具正常返回 | 调用按工具自身的返回契约结束 | 返回值是否含错误、实体是否正确、副作用是否重复 |
| Agent 文本宣称完成，或 Rubric 返回 `satisfied` | 模型或评分器认为满足要求 | 产物、业务记录和权限是否符合要求 |
| 独立程序核验业务状态 | 本次检查覆盖的业务条件成立 | 未检查的条件、竞态窗口和过程效率 |

工具可能用返回文本表达错误，并不一定抛异常；schema 合法也不保证实体归属正确。独立校验的覆盖面同样要写清楚：“文件存在”只能证明存在，不能证明内容正确。

七组场景是按源码提出的故障条件，不代表七组都已完成端到端运行。文末脚本只覆盖 Memory 快照、F3 启动响应丢失和 F5 评分与产物检查，且使用模拟客户端或固定评分结果。其余场景给出应如何验证的判据。

各场景关注的检查位置如下：

| 场景 | 源码入口 | 验收重点 |
| --- | --- | --- |
| F1 结构合法、实体错误 | 子代理结果回写 | 实体归属与写入前校验 |
| F2 父子共用资源 | 子代理输入状态筛选 | 字段隔离与资源权限分别检查 |
| F3 远端响应丢失后重试 | 异步任务启动工具 | 远端 Run 与调用方任务索引对账 |
| F4 取消与结果读取 | 取消工具与任务查询 | 取消请求、远端终态和结果可读性 |
| F5 评分通过但产物缺失 | Rubric 结束 hook | 评分状态与产物条件共同决定交付 |
| F6 预算遗漏和变参空转 | Nemotron 消息计数与签名实现 | 任务树总消耗与业务进度 |
| F7 失败报告与退出码 | 评测断言和报告器 | 发布门禁是否读取失败报告 |

## 三、F1：结构合法，实体却属于其他租户

任务要求处理 A 租户的订单，让子代理返回符合 schema 的 `{"status": "ok", "order_id": "B-1024"}`。接收方应在写入或交付之前，通过可信业务数据核对归属；仅解析成功不得放行。

`middleware/subagents.py` 的 `_return_command_with_state_update()` 过滤固定排除字段与私有字段，优先序列化 `structured_response`。这个函数没有订单归属检查。源码只能证明框架不会在这里补充实体校验，不能证明应用其他位置也没有检查。

验收应记录期望租户、实际租户、拒绝原因和受影响行数。归属不符时，应在产生副作用前拒绝；若写库工具本身接受了错误实体，事后验证只能发现损害，不能撤销它。校验应使用业务查询与确定性规则，不宜复用语言评分器判断实体归属。

## 四、F2：消息被隔离，文件仍然共享

父 State 同时带有私有字段和普通业务字段；父子使用同一个 Backend，并明确记录子代理的文件权限配置。让子代理读取父级字段以及其他任务目录，分别检查两种访问。

`subagents.py` 的 `_validate_and_prepare_state()` 创建新的、经字段筛选的字典，并将消息替换为任务描述。该筛选不创建进程、凭据或文件系统隔离。

预期是私有字段不通过这条 State 链传入子代理，资源访问则由实际权限控制。父级若又把私有值写进任务描述或共享文件，字段过滤也不能防止这种旁路泄漏。共用 Backend 时能否读取其他任务文件，应以真实访问结果为准，不能预先写成“一定越界”。

## 五、F3：远端已提交，客户端没收到响应

`middleware/async_subagents.py` 的 `_build_start_tool()` 创建 `start_async_task` 工具。注入“提交成功但响应丢失”的方式是替换客户端，让模拟服务先记录一个 Run，再抛出 `TimeoutError`。

下面摘录 `start_async_task()` 的远端创建与最终返回，省略类型校验、客户端取得、异常分支和任务字段构造：

```python
thread = client.threads.create()
run = client.runs.create(
    thread_id=thread["thread_id"],
    assistant_id=spec["graph_id"],
    input={"messages": [{"role": "user", "content": description}]},
)
# ……创建 task 字典和启动提示 msg……
return Command(
    update={
        "messages": [ToolMessage(msg, tool_call_id=runtime.tool_call_id)],
        "async_tasks": {task_id: task},
    }
)
```

顺序决定了故障窗口：远端 Thread、Run 已经创建，函数才构造供图合并的 `Command`。`Command` 是状态更新指令，不是两端事务的提交记录。若 `runs.create()` 在远端成功后向调用方抛超时，源码会走异常分支返回失败文本，此次调用拿不到可写入索引的 `run_id`；重试也没有复用前一次启动身份。

在这一条件下，同步工具函数的处理链可以按两份记录对照：

| 时点 | 模拟远端记录 | 调用方 State 索引 | 调用方看到什么 |
| --- | --- | --- | --- |
| 首次 runs.create 已提交，但响应丢失 | run-1 已存在 | 为空 | 启动失败文本 |
| 以相同描述重新调用启动工具 | run-1、run-2 均存在 | 尚未应用更新 | 返回记录 run-2 的 Command |
| 将第二次 Command 更新合并进测试状态 | 两个 Run | 只有 run-2 | 可以继续查询第二次任务 |

相同 description 没有在这条启动路径中充当幂等键。观察点因此应是 Run 身份与索引的对应关系，而不是两次任务描述是否相同。

模拟客户端的结果中，远端 Run 数量与任务索引数量不同：

```json
{
  "remote_stub_runs": 2,
  "local_indexed_runs": 1,
  "orphaned_stub_runs": ["run-1"],
  "retry_created_new_thread": true
}
```

该工具没有在重试前找回第一次提交的 Run。模拟客户端只用于验证这条控制路径，真实服务中的存活时间、资源消耗和恢复行为还取决于服务契约。

用稳定业务动作 ID 关联启动请求、远端 Run 与本地索引；响应不确定时先查账，再决定认领、取消或重试。服务端若不支持按业务动作查询，需要补充可查询的启动登记或其他关联机制。普通重试本身不是补救措施。

“Command 已生成但尚未持久化时进程退出”是另一处失败窗口。它需要进程中断和检查点恢复试验，单独调用工具函数不能覆盖这条恢复链。

## 六、F4：取消记录与可交付结果要分别检查

一组让取消 API 返回后，远端任务暂时仍在运行；另一组让 Run 成功，但结果读取失败。

`_build_cancel_tool()` 在 `client.runs.cancel(...)` 返回后生成本地 `cancelled` 更新，没有再查询远端终态。这个函数单独无法证明结果提交、资源释放和外部副作用都已经停止；具体时间保证取决于 SDK 与服务契约。

上游 `test_async_subagents.py` 的 `test_check_threads_get_failure_still_returns_status` 断言：Run 状态为 `success`、读取 Thread 抛错时，工具仍返回 `success`，并提供无输出的回退文本。

业务验收应分别保存取消请求、远端终态、结果读取状态和产物检查状态。若任务要求交付文件，Run 成功但没有可读文件时，应阻止交付或进入明确的重取流程。

## 七、F5：评分达标，文件却不存在

让 `RubricMiddleware.after_agent()` 使用固定评分器返回 `satisfied`，同时工作目录中没有任务要求的 `report.md`。中间件会记录通过状态，不回跳修订，也不创建或检查该文件。

应用示例增加了“评分通过且文件存在”的最小交付检查。三个条件分别检验不同分支：

| 注入条件 | 中间件状态 | 示例交付检查 | 能验证的边界 |
| --- | --- | --- | --- |
| 固定返回 satisfied，文件不存在 | satisfied，不请求修订 | 拒绝 | 评分通过不会自动生成或验证文件 |
| 固定返回 satisfied，创建目标文件 | satisfied | 允许 | 文件存在性参与了交付判断 |
| 评分器抛异常 | grader_error | 拒绝 | 评分失败不会因已有回复文本而被当成通过 |

第二行是控制逻辑的正向对照，不是对报告内容的正确性背书。这里故意只改变文件存在条件，以便定位是哪一项判据影响了交付结果。

固定评分与文件存在性检查的结果如下：

```json
{
  "rubric_status_without_artifact": "satisfied",
  "revision_requested": false,
  "missing_artifact_delivery_allowed": false,
  "present_artifact_delivery_allowed": true,
  "grader_error_delivery_allowed": false
}
```

评分器出错时，源码会记录 `grader_error`，不添加修订跳转，也不替换主 Agent 原来的回复。调用方如果只展示最后一条文本，可能漏掉评分失败。

这项存在性检查属于应用示例，不是框架内置修复。交付还需核验内容、租户、版本和发布位置。固定评分结果用于检查控制逻辑，不能据此估计真实模型的误判概率。

## 八、F6：子任务合计超支，变参查询没有推进

并行启动多个各自未超限、合计超出任务预算的子任务；另构造多次参数不同、业务状态不变的查询。

`profiles/harness/_nvidia_nemotron_3_ultra.py` 中的 `NemotronProgressBudgetMiddleware` 使用本地消息窗口计数，工具签名由名称和排序后的参数 JSON 构成。变参会打断连续相同签名的计数，但 AIMessage 或 ToolMessage 的数量上限仍可能触发。因此，不能把“连续重复检测漏过”写成“整个守卫一定漏过”。

验收应比较任务树实际消耗与共享账本，并观察业务进度。进度指标应来自可检验的完成状态或产物；仅对变化中的消息历史做哈希，可能每轮都不同，却没有业务推进。预算与完成状态的具体分工见 [19](19-loop-budget-and-termination.md)。

## 九、F7：评测失败，汇总进程仍正常退出

构造一个正确性断言失败的评测运行，记录原始测试结果、汇总报告、进程退出码和 CI 最终结论。

`libs/evals/tests/evals/utils.py` 在正确性断言失败时调用 `pytest.fail`。`pytest_reporter.py` 的 `pytest_sessionfinish()` 则有明确条件：退出码为 1，且已记录至少一个执行阶段的测试结果时，将退出码改为 0，让汇总步骤继续。其他非零退出码以及没有执行结果的情况不走这一分支。

退出码改写对应以下真实分支，省略报告生成部分，注释译为中文：

```python
# 已有执行阶段结果时，允许汇总步骤在用例失败后继续。
# 无执行结果，或退出码不是 1 时，保留原退出状态。
if session.exitstatus == 1 and _RESULTS["total"] > 0:
    session.exitstatus = 0
```

例如一条用例进入执行阶段并因正确性断言失败，`total` 大于 0、原退出码为 1，就满足这条改写条件。若测试尚未执行就发生配置错误，则不能套用同一判断。

这里的 0 可以表示汇总流程完成，并不等于所有用例通过。验收应确认后续发布门禁读取了失败报告；如果流水线仅依赖这个评测进程的退出码，就需要额外阻断逻辑。是否会放行失败用例，取决于完整的 CI 配置。

## 十、复现已提供的三个离线场景

`scripts/deepagents/reproduce-boundaries.py` 提供 Memory 快照、启动响应丢失和评分与产物检查三个场景。以下命令假设 Deep Agents 仓库与文档仓库同级，目录名为 `deepagents`，从文档仓库根目录执行：

```powershell
python scripts/deepagents/reproduce-boundaries.py --source-root "../deepagents" --output "scripts/deepagents/results/boundaries.json"
```

脚本从指定仓库导入 SDK，通过模拟客户端和固定评分结果控制故障条件，不连接真实模型或远端服务。`all_boundaries_reproduced=true` 表示这些条件下的行为符合预期，不等于业务验收通过。依赖版本见 [源码版本与路径约定](source-baseline.md)。

## 十一、把实验记录接入业务验收

优先为应用确实依赖的保证建立回归用例，并保留注入位置、预期状态与实际观测。F3 的关键断言是远端 Run 与任务索引能否对应；F5 是评分状态与产物条件是否共同控制交付；F7 是失败报告能否阻止发布。只断言“没有抛异常”，不能覆盖这些要求。故障注入代码、业务断言与被测实现还应绑定明确版本，避免比较时改变了判据。

`_trajectory_from_result()` 从最终返回的 `messages` 和 `files` 构造评测轨迹。它不会自动补上同步子代理未返回的内部消息、远程任务过程、外部文件系统或数据库记录。若验收需要知道“哪次审批允许了哪笔写入”，应另外保存动作、授权与提交结果的关联记录。

回归集优先覆盖有真实业务影响的失败；真实模型测试还应固定模型、提示词、工具 schema 和数据集版本，并重复试验。工具与 hook 的边界检查之外，还需验证资源隔离、重启恢复、业务正确性与费用控制。

## 十二、延伸阅读

- [20：Harness 架构与运行边界](20-harness-constitution-rereading.md)：默认能力、扩展策略与业务责任。
- [09：同步 SubAgent](09-subagent-sync.md)：状态筛选与结果回写。
- [12：异步 SubAgent](12-async-subagent.md)：Thread、Run 与本地任务索引。
- [13：MemoryMiddleware 与长期上下文装配](13-memory-middleware.md)：文件写入、状态快照与请求刷新的关系。
- [14：Rubric 自评循环](14-rubric-self-evaluation-loop.md)：评分状态与返回消息。
- [16：Evals](16-deepagents-evals.md)：轨迹、断言与报告口径。
- [19：循环预算与终止](19-loop-budget-and-termination.md)：计数范围与终止行为。
