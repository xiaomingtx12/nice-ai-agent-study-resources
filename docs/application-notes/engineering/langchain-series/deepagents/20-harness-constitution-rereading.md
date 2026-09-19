---
sidebar_position: 22
sidebar_label: 20 Harness 架构与运行边界
description: 从预算、权限、恢复、隔离和结果校验出发，区分 Deep Agents 的默认能力、可扩展策略与业务系统责任。
---

# Deep Agents 源码解析 20：Harness 架构与运行边界

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12 源码快照，详见 [源码版本与路径约定](source-baseline.md)。
>
> - 默认装配与运行配置：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`、`_merge_fs_interrupt_on()`
> - 父子状态与结果：`libs/deepagents/deepagents/middleware/subagents.py` → `_validate_and_prepare_state()`、`_return_command_with_state_update()`
> - 消息修补：`libs/deepagents/deepagents/middleware/patch_tool_calls.py` → `PatchToolCallsMiddleware.before_agent()`
> - 远端启动：`libs/deepagents/deepagents/middleware/async_subagents.py` → `_build_start_tool()`
> - 上下文装配：`libs/deepagents/deepagents/middleware/memory.py` → `before_agent()`、`modify_request()`；`libs/deepagents/deepagents/middleware/summarization.py` → `wrap_model_call()`
> - 预算与自评：`libs/deepagents/deepagents/profiles/harness/_nvidia_nemotron_3_ultra.py` → `NemotronProgressBudgetMiddleware`；`libs/deepagents/deepagents/middleware/rubric.py` → `RubricMiddleware.after_agent()`

判断一个 Deep Agents 应用能否交付，需要把默认能力、可接入的策略和业务事实分开。例如，文件工具可以拒绝一个路径；但某个订单是否属于当前租户，需要业务工具查询订单归属。两者不能用“已有权限中间件”一并回答。

本篇用“读取材料、委派核验、写出 report.md”串起前面的机制。任务交付依赖模型、图状态、文件和业务检查共同完成，随后再分析各层的限制。故障条件与验收方法见 [21：故障路径与边界验证](21-production-failure-validation.md)。

## 二、一份报告怎样穿过整个 Harness

假设应用配置了 Memory 文件、一个核验子代理和文件 Backend，并显式加入 RubricMiddleware。Memory 路径、子代理职责与评分标准来自应用配置，不是所有 Agent 都天然具备的业务规则。

| 执行阶段 | 组件实际做的事 | 数据去了哪里 |
| --- | --- | --- |
| 进入 Agent | Memory 的 before_agent 加载配置文件，后续 modify_request 将快照加入系统消息 | 文件内容形成 State 快照，再进入本轮模型请求 |
| 主模型制定行动 | 模型返回带工具调用的 AIMessage，图转向工具节点 | messages 记录调用名称、参数和 ID |
| 委派核验 | task 工具筛选父状态，把入口消息替换为核验描述，调用子图 | 子代理有自己的消息过程；允许回传的状态和最终结果进入父图 |
| 写出报告 | 文件工具解析路径、检查权限，再调用 Backend.write | StateBackend 返回文件状态更新；外部文件 Backend 则写入各自存储 |
| 历史变长 | 摘要中间件按上下文阈值组织历史、归档并改写本轮请求视图 | 模型看到的请求与持久化的完整状态可能不同 |
| 主模型结束 | Rubric 按标准评分，必要时注入反馈并请求修订 | 评分状态和评估记录写回 State |
| 应用交付 | 调用方取得最终状态，检查指定 Backend 中的报告和任务条件 | 形成可交付的文件版本及业务结果 |

这里最容易混淆的是“写出文件”与“报告通过评分”。使用 StateBackend 时，文件内容属于图状态；使用宿主机文件 Backend 时，内容在外部目录。即使 messages 中都有一条写入成功的 ToolMessage，恢复和核验的方法也不同。交付检查必须读取这次任务实际使用的 Backend，不能随便检查另一个同名文件。

同样，子代理文本称“核验通过”只是一条返回结果，Rubric 的 satisfied 是另一项评分信号。应用若要求报告引用特定版本的材料，应核对这些材料与产物版本；框架不会从自然语言任务中自动建立这条业务约束。

一次实现可以沿三个对象排查：图状态保存了什么、请求视图给模型看了什么、外部资源实际发生了什么。后面的预算、权限、上下文、恢复与隔离问题，分别发生在这三个对象之间。

## 三、预算：谁能在超支之前拒绝下一次动作

`graph.py` 的 `create_deep_agent()` 将 `recursion_limit` 设为 9_999。它限制图步数，不限定秒数、token、金额或整棵子代理树的费用。

Nemotron Profile 中的 `NemotronProgressBudgetMiddleware` 在下一次模型调用前检查消息数量和连续相同工具签名。其默认阈值是 16 条 AIMessage、48 条 ToolMessage、3 次连续相同签名。消息数不等于 provider 请求数，检查又发生在工具批次执行之后，因此不能把 48 当作逐个工具调用前的准入配额。

`RubricMiddleware` 在主 Agent 自然结束时启动评分。它可以要求修订，但无法保证主 Agent 在到达结束点前不空转；其评分器本身也可能调用模型和工具。两类控制的触发点不同，详见 [19](19-loop-budget-and-termination.md) 和 [14](14-rubric-self-evaluation-loop.md)。

业务若要求“整个任务最多花费某个金额”，应在发起主、子任务调用前预留额度，完成后结算，并定义超限时保留哪些产物。任务级截止时间还需要外部执行控制；只在模型入口检查时间，无法中断已经阻塞的工具。

## 四、权限：批准了哪个动作，校验了哪个实体

文件权限和人工审批已经有接入位置，但各自只能证明检查过的条件。

| 检查位置 | 源码能证明什么 | 仍需应用核验什么 |
| --- | --- | --- |
| Filesystem 的路径检查 | 对指定文件工具应用路径规则 | Shell、自定义工具和直接 Backend 访问是否也受约束 |
| `_merge_fs_interrupt_on()` | 合并自动生成的文件审批与用户配置；用户同名项可覆盖 | 最终有效配置是否保留了业务要求的审批 |
| 同步子代理的 `_return_command_with_state_update()` | 过滤部分状态字段，并序列化结构化响应或最终文本 | 返回的订单、租户、资源版本是否属于本次任务 |

人工审批应绑定动作的规范化参数、租户和有效期；恢复后参数或目标版本变化时，需要重新判断审批是否仍有效。文件中声称“管理员已批准”不能替代审批记录。

子代理返回合法 JSON，只解决格式交接问题。实体归属、金额范围和可执行状态应由确定性的业务校验完成；Rubric 可以辅助评审文本，不能替代这类检查。实现位置见 [08](08-filesystem-middleware-and-permissions.md) 与 [09](09-subagent-sync.md)。

## 五、上下文：省下的内容还能从哪里找回

正常历史摘要主要改变本轮模型请求视图，检查点可以保留图状态中的消息。工具结果卸载、参数截断和溢出回退还有各自的处理路径，不能用“所有压缩都不改变历史”概括。详见 [10](10-summarization-and-context-offloading.md)。

Skills 通过元数据索引引导按需读取，Memory 从文件加载快照并注入请求。它们减少或组织模型需要处理的内容，却不会自动实现一套按业务重要性分配的预算。Memory 快照过期、归档路径丢失、摘要遗漏事实，都需要不同的验证。

系统提示词通常不参与历史切分，是因为它通过 `system_message` 单独传递。若自定义中间件改写这段内容，仍应检查关键约定是否保留。供应商缓存只影响请求复用与计费条件，不能作为规则未丢失或 Memory 已刷新的证据。

生产验证应记录实际窗口峰值、摘要次数、回读成功率和任务正确率。工具数量阈值、分层预算比例和末尾提醒可以作为实验候选；只有在当前模型和任务集上获得证据后，才适合作为默认配置。

## 六、恢复：恢复了状态，还是确认了外部动作

`_messages_delta_reducer()` 按稳定消息 ID 合并写入，LangGraph Checkpointer 负责保存和恢复执行状态。`PatchToolCallsMiddleware` 为缺少结果的工具调用补充合成消息，使消息协议闭合。

以报告任务为例，外部 Backend 已写入 report.md、ToolMessage 尚未保存时发生故障，恢复的消息可能缺少写入结果，而文件已经存在。补丁中的 `cancelled` 描述的是消息缺口，不会撤销文件，也不能证明写入没有发生。若同一任务还要发布报告或发送通知，直接重试更可能重复产生业务动作。实现和验证位置见 [03](03-state-reducers-and-recovery.md) 与 [11](11-patch-tool-calls.md)。

幂等键应标识稳定的业务动作，在首次提交前保存，跨重试、恢复和重复投递复用，并绑定参数摘要。运行编号与轮次可以用于追踪，但 `run_id:turn:call_index` 在重启后若改变，就无法直接去重同一个业务动作。执行端还需要原子认领、结果查询或补偿机制。

异步子代理有另一处窗口：`start_async_task` 先创建远端 Thread 和 Run，再返回更新任务索引的 Command。两端没有同一事务。客户端未收到响应时直接重试，可能创建另一个 Run；启动失败窗口与对账要求见第 21 篇 F3。

## 七、隔离：分开的消息不等于分开的文件和凭据

同步子代理使用筛选后的状态字典，入口消息替换为任务描述，允许传播的字段在返回时写回父状态。`subagents.py` 的状态筛选不会创建进程、文件系统或凭据隔离。

这条边界可以直接从 `_validate_and_prepare_state()` 看出。下面保留状态筛选与消息替换，省略子图选择和返回：

```python
# 创建新的状态字典，避免修改父状态字典。
subagent_state = {k: v for k, v in runtime.state.items() if k not in _EXCLUDED_STATE_KEYS}
subagent_state = {k: v for k, v in subagent_state.items() if k not in private_state_keys}
subagent_state["messages"] = [HumanMessage(content=description)]
```

第一轮过滤排除框架固定不传播的字段，第二轮排除带私有标记的字段，随后用任务描述替换消息历史。例如普通 `project_id` 可以进入子状态，而父对话不会原样传入。这里创建的是新字典，不是新操作系统环境，也不是全部字段值的深拷贝。若子代理使用共享 Backend，仍可能访问同一批文件。

Backend 的能力接口也只说明能否调用操作。`LocalShellBackend` 使用宿主机 Shell；`LangSmithSandbox` 包装调用方提供的沙箱实例，不会仅凭换一个 `thread_id` 自动创建新的执行环境。源码细节见 [05](05-backend-sandbox-and-isolation.md)。

是否共享 Backend，要按资源冲突决定：互不相关的任务可使用独立工作目录或沙箱；共享数据库记录应通过工具执行条件更新。独立文件副本不能防止两个任务同时修改同一条远端记录，也不能代替服务端并发控制。

## 八、把补充策略放到有能力执行它的位置

| 风险 | 框架已有入口 | 应由哪一层补充 | 验证依据 |
| --- | --- | --- | --- |
| 超时、超预算 | 图步数配置、模型与工具中间件 | 应用账本和外部执行控制 | 包含辅助调用、重试和子任务的消耗记录 |
| 重复外部写入 | 工具执行边界、检查点恢复 | 业务工具与执行服务 | 同一业务动作重试后只有一笔有效流水 |
| 错误实体通过 schema | 结构化返回、子代理回写 | 接收结果或执行写入的业务服务 | 实体归属、版本和状态校验 |
| 审批后参数变化 | HITL 中断与恢复 | 可信审批服务和执行端 | 审批绑定参数与实际调用一致 |
| 文件快照过期 | Memory 加载与请求注入 hook | 应用刷新策略 | 文件版本、State 快照与最终请求分别可查 |
| 归档不可回读 | 摘要事件与 Backend 路径 | 存储保留策略和异常处理 | 归档存在且在当前权限下可读 |
| 任务恢复后重复启动远端 Run | 异步任务索引 | 远端启动契约与对账服务 | 稳定动作 ID、远端 Run 和本地索引一致 |
| 评分达标但产物缺失 | Rubric 评分事件 | 独立业务验收 | 产物存在、内容合规、交付对象正确 |

在报告任务中，待办项“报告已生成”、messages 中的成功回复、Rubric 的通过记录和 Backend 中的文件是不同证据。应用应先决定哪一项事实允许交付，再选择检查位置；不必为一个只读研究助手预先引入完整的业务事务系统。

这张表中的措施是按风险选择的扩展方案，不属于框架默认提供的完整防线。应用需要对关键业务不变量执行故障验证，不能仅根据组件名称判定是否适合交付。

## 九、延伸阅读

- [19：循环预算与终止](19-loop-budget-and-termination.md)：计量单位与终止方式。
- [21：故障路径与边界验证](21-production-failure-validation.md)：故障条件、源码行为和交付判据。
- [15：better-harness](15-examples-better-harness.md)：限制可修改范围并用评测筛选候选。
- [Agent 系统设计：权限与后置条件](../../../../notes/agent-system-design/05-action/agent-permission-and-postconditions.md)：工具返回之后还需要验证什么。
