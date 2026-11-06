---
sidebar_position: 14
sidebar_label: 源码基线与证据索引
description: 固定 LangGraph Python 本地源码快照的版本与文件哈希，区分源码推导、测试断言和实际执行验证。
---

# LangGraph 源码基线与证据索引

本页说明系列使用哪份实现、关键结论在哪里核对，以及本次实际验证了什么。它与[导读](./index.md)配合使用：导读按问题选文章，本页按证据找实现和测试。

## 一、分析的是哪一份源码

本次核对日期为 **2026-10-03**，分析对象是 LangGraph Python monorepo 的本地快照。快照中没有可用 Git 元数据，不能确认提交号；包版本也不能单独证明所有文件与某个公开发布标签完全一致。

| 项目 | 快照声明或范围 |
| --- | --- |
| `langgraph` | `1.2.10`，来自 `libs/langgraph/pyproject.toml` |
| `langgraph-checkpoint` | `4.1.1`，来自 `libs/checkpoint/pyproject.toml` |
| `langgraph-prebuilt` | `1.1.0`，来自 `libs/prebuilt/pyproject.toml` |
| 重点执行入口 | 本地 Python 的 `StateGraph`、`Pregel.invoke/stream` 与相关异步路径 |
| 证据位置 | 文件路径、类或函数名、必要行号、下方文件哈希 |
| 不直接覆盖 | 远端 Server 的任务调度、SDK 生命周期、部署平台的并发策略 |

`RunControl`、`TimeoutPolicy`、节点错误处理器和流接口的版本行为，都限定在这份快照。不能因为其他版本也叫 LangGraph，就直接套用其参数或控制语义。

本文不补造固定提交链接。以后取得来源提交，应先核对关键文件内容，再补对应链接；行号只能帮助定位，文件内容才是实现依据。

## 二、关键机制怎样回到实现

| 机制 | 核心位置 | 文章 |
| --- | --- | --- |
| 字段更新与输入结构 | `graph/state.py` 的 `_get_channel`，`channels/`，`pregel/_algo.py` 的 `apply_writes` | 01 |
| 节点与边编译 | `graph/state.py` 的 `compile`、`attach_node`、`attach_edge`、`attach_branch` | 02 |
| 轮次与结果时间线 | `pregel/main.py` 的 `stream`；`pregel/_loop.py` 的 `tick`、`after_tick` | 00、03 |
| 缓存键与命中 | `pregel/_algo.py` 的任务准备；`SyncPregelLoop.match_cached_writes`；`cache/memory/` | 03 |
| 重试、超时与错误处理 | `pregel/_retry.py`；`PregelRunner.tick/commit` | 04 |
| 保存与恢复 | `PregelLoop.put_writes`、`_put_checkpoint`、`_first`；`InMemorySaver` | 06 |
| 中断与任务身份 | `types.py` 的 `interrupt`，`pregel/_algo.py` 的 `_scratchpad` | 07、08 |
| Runtime 与业务状态 | `runtime.py` 的 `Runtime`；`Pregel.stream` 的上下文构造 | 01 |
| 事件输出 | `Pregel.stream`、`_output`，流队列及事件投影实现 | 09 |

上表中的短路径用于阅读导航。核心包文件位于 `libs/langgraph/langgraph/`；保存器、Store 和缓存位于 `libs/checkpoint/langgraph/`。每篇头部保留完整路径。

## 三、已阅读的测试证明到什么程度

这些测试来自本地仓库，**本次只阅读设置与断言，没有执行测试套件**。表中的“断言”表示源码里的预期行为，不冒充本次实测结果。

| 测试位置与函数 | 关键设置和断言 | 不能扩大为 |
| --- | --- | --- |
| `tests/test_pregel.py` · `test_pending_writes_resume` | 一项成功、一项失败；当前视图应用成功写入，具体历史视图不应用；恢复只重跑失败项 | 任意进程崩溃都不丢进度，或外部动作只执行一次 |
| `tests/test_pregel.py` · `test_in_one_fan_out_state_graph_waiting_edge_multiple` | 相同查询再次执行，启用缓存时调用计数不增加；清缓存后重新执行 | 缓存自动包含用户身份、外部数据版本或所有配置 |
| `tests/test_retry.py` · `test_arun_with_retry_timeout_discards_stale_executor_writes` | 第一尝试超时后晚到的写入被隔离，最终队列只含 fresh | 旧线程停止，或其数据库副作用已撤销 |
| `tests/test_retry.py` · `test_set_node_defaults_combined_retry_and_error_handler` | 原节点尝试两次，耗尽后处理器产生 handled 结果 | 所有异常都应该转成业务成功 |
| `tests/test_retry.py` · `test_error_handler_resumes_after_crash` | 处理器失败后恢复，原节点不再次执行，处理器再次执行 | 跨任意代码变更都能保持相同任务身份 |
| `tests/test_runtime.py` · `test_injected_runtime`、`test_context_runtime` | 分别通过注入参数与 get_runtime 读取 context | context 自动持久化、不可变或天然保密 |
| `tests/test_runtime.py` · `test_run_control_request_drain_stops_future_steps` | 前一步设置停止请求，调用抛出 GraphDrained | 对正在阻塞的节点进行强制终止 |
| `tests/test_runtime.py` · `test_drain_requested_in_terminal_step_finishes_normally` | 末节点请求停止，仍返回最终结果 | 所有停止都算正常业务完成 |
| `tests/test_runtime.py` · `test_drain_with_exit_durability_persists_resume_checkpoint` | 同进程内正常退出后，None 输入恢复后续节点 | 内存保存器可跨进程保留，或强杀也能执行清理 |
| `tests/test_subgraph_persistence.py` · `test_stateless_interrupt_resume` | 子图继承父图保存能力，中断后父调用可恢复得到 Done | 子图自动在独立父调用之间保留全部业务历史 |

测试目录的完整前缀是 `libs/langgraph/`。想复核一个结论，应同时看测试构造、执行入口与断言，不能仅凭测试函数名推断保证范围。

## 四、关键文件的 SHA-256

以下哈希根据核对时文件的**原始字节**计算，换行符变化也会改变哈希。它用于识别这份本地快照，不是发布方签名，也不能反推出 Git 提交。

<details>
<summary>展开 25 个版本、实现与测试文件的完整哈希</summary>

| 仓库相对路径 | SHA-256 |
| --- | --- |
| `libs/langgraph/pyproject.toml` | `0e56b26bc402b863133dae89e52e4ff47bdf551f9e381dd7db0c4c192897cac3` |
| `libs/checkpoint/pyproject.toml` | `8dd841e77d1c33fc2dbbc6dadf35b0a167d4ec9f6a10818ee144be6347032de6` |
| `libs/prebuilt/pyproject.toml` | `700afe262e07a0301190d07c6ff85ae03e1fd1aee2b04b52ac174f507217c0dd` |
| `libs/langgraph/langgraph/graph/state.py` | `39712e49133f2bf31ab607ac551761d396ecdbcd1ffdde1c3e0812537ddd4e6e` |
| `libs/langgraph/langgraph/graph/message.py` | `c811816a1367cd2af060a46724dbd2802ccd7c25f5d94f1d9c0dd127092be6e8` |
| `libs/langgraph/langgraph/channels/binop.py` | `85dbe7cdd3cea5f2973dbf3f358ad04c61c7b8dad5dc74a579739aa328a1b54e` |
| `libs/langgraph/langgraph/channels/last_value.py` | `36cbc586aeaac0f8c9b5a8d8b903039023a7d24294408391eb8c7f10aab3a308` |
| `libs/langgraph/langgraph/pregel/main.py` | `02651dc9471b88f9299d12f6d836e67ad1114ad84498b9ae26df6cd75be8592c` |
| `libs/langgraph/langgraph/pregel/_loop.py` | `33150cf70fc08fd01affeae0345aa20569d2705704e3d209733d9c7b43dd5c0a` |
| `libs/langgraph/langgraph/pregel/_algo.py` | `29d54dc6704e4e4a0385d36317faa74f4fa2ceefd6836aca03f1938b9fa51fa5` |
| `libs/langgraph/langgraph/pregel/_runner.py` | `316cf133c724163a18ef279322615588b3fa8b96e359289a7cadea90f0df7622` |
| `libs/langgraph/langgraph/pregel/_retry.py` | `667a74090e23fda724e74ad377586e32325510cdd9042d320d60306f783f0a9d` |
| `libs/langgraph/langgraph/pregel/_executor.py` | `5afb1e7e7bd768fc5ff7ed5e222539abb73bd11f88d8e150eb75c30a8484364d` |
| `libs/langgraph/langgraph/runtime.py` | `5a5e3aad147f67397481ea47c67cde97938d85b5762a7aa4d4ce511dcd693c42` |
| `libs/langgraph/langgraph/types.py` | `8ba8895d3c1aec51e5ef24d09d983031f52c32939876fd5c63b92fabbb1a1fee` |
| `libs/langgraph/langgraph/func/__init__.py` | `f07e4a9f9bac75e2b48ac987fb91ca8c13a0a3d40723aa1997840bcde56732b7` |
| `libs/checkpoint/langgraph/checkpoint/base/__init__.py` | `d29511015e2801630f6580353c107104d4ecc86e4bd14e15cd54e2b861a48e26` |
| `libs/checkpoint/langgraph/checkpoint/memory/__init__.py` | `4d8e07be6303cb0c937c0abb37ad7c12f4f2c31e029a8d12d5dcfe84c1543b8c` |
| `libs/checkpoint/langgraph/cache/memory/__init__.py` | `839cc985739246b03553269b3004296a3593ddac782a6a6a74b170b95f5c3367` |
| `libs/checkpoint/langgraph/store/base/__init__.py` | `fe20a8f40e21b34f0ba964e7c8b04be30e3deb3d61e7d19a43d600014175636e` |
| `libs/prebuilt/langgraph/prebuilt/tool_node.py` | `3c6380e257718a0e2753d7ae890bfcbf9edfe0f726f32a7b844f96630bf363a4` |
| `libs/langgraph/tests/test_pregel.py` | `789aa2fdb1466aa202b2eebd35ef865ae102f1824f90e7e93a422eb5dd291224` |
| `libs/langgraph/tests/test_retry.py` | `62edd0d4a5dca7e7352154595b158b4569ae0781542cd368d92ed4244aa02144` |
| `libs/langgraph/tests/test_runtime.py` | `52d7a213ae4487f4ca3774626c1f4c2f35153b6bbd2d48f2d1b6b72e1ee8ec21` |
| `libs/langgraph/tests/test_subgraph_persistence.py` | `bacced1bddc03a3e9d3093e5034170a051a7893bfe01b632a89e38f3d3736524` |

</details>

## 五、本次修订的验证范围

本次修订核对了新增机制所用的源码分支与测试断言，并对站点文章执行 Markdown/MDX、YAML、标题编号、站内文件链接及 Mermaid 语法检查。新增源码片段按所在文件比对，原英文注释在正文中翻译为中文。

没有启动模型、运行 LangGraph 工作流、执行框架测试或构建站点。正文中的应用示例和贯穿业务流程均不标记为本次运行结果；涉及持久化后端故障、跨进程取消或生产性能的结论，保留其条件与待验证范围。

后续升级系列时，应重新核对本页版本与哈希，沿受影响机制复查，而不是只替换文章头部的版本号。
