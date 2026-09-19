---
sidebar_position: 8
sidebar_label: 06 检查点、恢复与分叉
description: 追踪任务写入和轮次检查点的保存、加载、重放与状态修改，区分持久化模式、查询视图和业务 Store。
---

# LangGraph 源码 06：执行现场怎样保存、恢复和分叉

## 源码定位

> **源码基线**：langgraph 1.2.10、langgraph-checkpoint 4.1.1，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 保存协议：`libs/checkpoint/langgraph/checkpoint/base/__init__.py` → `Checkpoint`、`CheckpointTuple`、`BaseCheckpointSaver`。
> - 保存器实例：`libs/checkpoint/langgraph/checkpoint/memory/__init__.py` → `InMemorySaver.get_tuple()`、`put()`、`put_writes()`。
> - 运行时保存与加载：`libs/langgraph/langgraph/pregel/_loop.py` → `put_writes()`、`_put_checkpoint()`、`_suppress_interrupt()`、`SyncPregelLoop.__enter__()`、`_first()`。
> - 查询与修改：`libs/langgraph/langgraph/pregel/main.py` → `get_state()`、`get_state_history()`、`update_state()`、`bulk_update_state()`。
> - 业务数据：`libs/checkpoint/langgraph/store/base/__init__.py` → `BaseStore`。

可恢复执行需要同时知道“状态已经提交到哪里”和“本轮哪些任务已经完成”。LangGraph 用 checkpoint（检查点）保存轮次现场，用 pending writes（待合并写入）记录任务结果。恢复时根据两者重新准备任务，而不是从序列化的 Python 调用栈接着运行。

`BaseCheckpointSaver` 定义保存协议；`InMemorySaver` 是进程内实现，适合演示和测试。SQLite、PostgreSQL 等后端负责持久保存。保存器更换不改变图的任务协议，但可靠性、事务、并发和保留策略取决于后端。

## 一、执行身份如何定位检查点

调用配置中的 `configurable` 携带三个关键字段：

| 字段 | 定位对象 | 影响 |
| --- | --- | --- |
| `thread_id` | 一条工作流执行线 | 改成新值会访问另一条历史 |
| `checkpoint_ns` | 根图或子图命名空间 | 同一执行线内划分嵌套图历史 |
| `checkpoint_id` | 指定历史检查点 | 省略时通常读取该命名空间下最新记录 |

例如 `{"configurable": {"thread_id": "order-42"}}` 表示订单执行线，不是操作系统线程。相同 ID 加新输入会继续使用已有状态，而不是自动创建空白会话；要清空或新建必须显式设计入口。

`InMemorySaver.get_tuple()` 在指定 checkpoint ID 时精确查找，否则取该命名空间最大 ID 的记录。返回的 `CheckpointTuple` 同时携带本体、父配置和待合并写入：

源码：`libs/checkpoint/langgraph/checkpoint/base/__init__.py` → `CheckpointTuple`（第 139–146 行节选；未展示部分省略）。

```python
class CheckpointTuple(NamedTuple):
    """包含检查点及其关联恢复数据的元组。"""

    config: RunnableConfig
    checkpoint: Checkpoint
    metadata: CheckpointMetadata
    parent_config: RunnableConfig | None = None
    pending_writes: list[PendingWrite] | None = None
```

检查点本体中，`channel_values` 保存通道的持久表示，`channel_versions` 保存版本，`versions_seen` 保存节点已经处理的触发版本，`updated_channels` 标记最近变化的通道。仅保存业务 State 不足以恢复调度，因为它不说明旧触发信号是否已消费。

`pending_writes` 位于元组的关联数据中，不在检查点本体字段里。任务完成后能独立追加结果，不必每完成一个任务就重写整份图状态。

## 二、两条保存路径分别对应任务和轮次

正常执行中，Runner 完成任务后调用 Loop 的 `put_writes(task_id, writes)`。Loop 将结果加入当前检查点的待合并记录，并在相应持久化模式下调用保存器的 `put_writes()`。

轮次结束后，`after_tick()` 将写入应用到通道；`_put_checkpoint()` 生成新检查点并调用保存器的 `put(config, checkpoint, metadata, new_versions)`。`new_versions` 告诉保存器本次哪些通道版本变化，可用于减少重复保存。输入到达、手工更新状态和分叉也有各自的检查点来源。

| 时间点 | 保存对象 | 已有数据能解决什么 |
| --- | --- | --- |
| 本轮开始 | 检查点 C | 恢复本轮输入和触发关系 |
| A 成功、B 尚未完成 | C 关联的 A 写入 | 恢复时保留 A 结果 |
| 整轮提交 | 新检查点 C' | 从合并后的状态准备下一轮 |

保存请求通常经后台执行器提交，并按先后关系等待前一个检查点保存，以防写入乱序。**生成检查点、输出事件、持久保存完成不能视为同一时刻。**

### 1. durability 决定保存与执行如何重叠

| 模式 | 等待策略 | 故障边界与代价 |
| --- | --- | --- |
| `sync` | 下一轮推进前等待检查点保存 | 增加写入等待，收窄轮次间丢失窗口 |
| `async`（默认） | 保存可与后续执行重叠 | 减少等待，进程突发退出时可能失去尚未完成的保存 |
| `exit` | 在退出、中断等保存边界集中落下现场 | 写入少，但执行中崩溃不能指望每轮都有落盘记录 |

同步路径的等待发生在主循环中：

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 2984–2988 行节选；未展示部分省略）。

```python
loop.after_tick()
emit_graph_lifecycle_events(loop)
# 同步模式等待本轮检查点保存完成。
if durability_ == "sync":
    loop._put_checkpoint_fut.result()
```

Loop 在 `exit` 模式下也跳过常规任务写入的即时保存。因此“成功兄弟任务恢复后一定不重跑”的前提，是相关结果已经可靠保存；不能脱离持久化模式和进程故障时机作保证。没有保存器时，配置 durability 不会凭空产生持久化能力。

### 2. 受控停止也经过退出保存路径

`RunControl.request_drain()` 请求运行时在轮次边界停止继续执行。该路径结束 Loop 的主循环后，仍会正常退出上下文管理器；`_suppress_interrupt()` 虽然名字包含 interrupt，也承担 `exit` 模式下的保存工作。

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop._suppress_interrupt`（第 1323–1334 行节选；未展示部分省略）。

```python
# 退出时保存当前检查点及相关写入。
if self.durability == "exit" and (
    # 根图退出。
    not self.is_nested
    # 或嵌套图因错误、中断等异常退出。
    or exc_value is not None
    # 或使用 checkpointer=True 的有状态子图退出。
    or all(NS_END not in part for part in self.checkpoint_ns)
):
    self._put_exit_delta_writes()
    self._put_checkpoint(self.checkpoint_metadata)
    self._put_pending_writes()
```

根图停止时，前一轮已经合并的通道值以及继续运行需要的写入可以在这里保存；退出还需等待相关后台保存完成，之后外层入口才报告 `GraphDrained`。因此 exit 模式能够支持一次正常完成清理的协作式停止，不需要等整个业务流程完成才留下现场。

这条保证依赖上下文清理实际运行且保存成功。强制杀进程、存储不可用或使用仅存于进程内的保存器，仍可能使进度无法恢复。任务取消也不等于当前轮次完整提交：恢复应依据已保存记录，不能依据界面最后显示的事件判断完成位置。

## 三、加载时恢复通道与待合并结果

`SyncPregelLoop.__enter__()` 根据配置调用 `get_tuple()`。第一次执行没有历史时创建空检查点；有历史时读取元组，再调用 `channels_from_checkpoint()` 恢复通道实例。

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `SyncPregelLoop.__enter__`（第 1675–1684 行节选；未展示部分省略）。

```python
self._initial_checkpoint_config = self.checkpoint_config
self.prev_checkpoint_config = saved.parent_config
self.checkpoint_id_saved = saved.checkpoint["id"]
self.checkpoint = saved.checkpoint
self.checkpoint_metadata = saved.metadata
self.checkpoint_pending_writes = (
    [(str(tid), k, v) for tid, k, v in saved.pending_writes]
    if saved.pending_writes is not None
    else []
)
```

`_first()` 根据已有版本和本次输入区分新输入与继续执行。`None` 表示继续当前未完成现场，`Command(resume=...)` 额外提供动态中断的恢复值；在空历史上给 `None` 并不能恢复出一次从未开始的执行。

准备任务后，Loop 按任务 ID 找回已成功结果：

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop._reapply_writes_to_succeeded_nodes`（第 745–749 行节选；未展示部分省略）。

```python
for tid, k, v in self.checkpoint_pending_writes:
    if k in (ERROR, ERROR_SOURCE_NODE, INTERRUPT, RESUME):
        continue
    if task := tasks.get(tid):
        task.writes.append((k, v))
```

`ERROR`、`INTERRUPT`、`RESUME` 等控制记录不算任务成功输出。成功写入挂回后，主循环只把仍没有成功写入的任务交给 Runner。A 成功、B 失败的例子中，A 不必再次调用，B 从任务入口重跑；后续提交使用 A 的保存结果和 B 的新结果。

## 四、查询当前状态与查询历史快照不同

`get_state()` 返回 `StateSnapshot`，即面向调用方的状态视图，含 `values`、`next`、`tasks` 和配置。它由保存记录及任务准备逻辑计算，不等于底层检查点字典原样返回。

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.get_state`（第 1428–1434 行节选；未展示部分省略）。

```python
saved = checkpointer.get_tuple(config)
return self._prepare_state_snapshot(
    config,
    saved,
    recurse=checkpointer if subgraphs else None,
    apply_pending_writes=CONFIG_KEY_CHECKPOINT_ID not in config[CONF],
)
```

未显式指定历史 ID 时，当前视图会应用成功任务的 pending writes；指定历史 ID 时不自动叠加这些后续写入。因此失败后 `get_state(config).values` 已包含 A 的结果，并不说明失败轮次曾完整提交或 B 已完成。`tasks` 中的错误和中断信息仍需一起读取。

## 五、继续、重放与修改历史各做什么

| 入口 | 运行含义 | 任务结果复用 |
| --- | --- | --- |
| 最新配置加 `invoke(None, config)` | 继续未完成现场 | 可复用已保存成功写入 |
| drain 后的执行线加 `invoke(None, config)`，不复用已停止的 control | 继续尚未执行的后续轮次 | 从停止时实际保存的现场重新准备任务 |
| 最新配置加 `Command(resume=...)` | 继续并给中断提供值 | 恢复对应暂停任务 |
| 历史配置加 `invoke(None, historical_config)` | 从选定历史点重新执行后续流程 | 有意重放后续任务，不等同于失败恢复 |
| `update_state(historical_config, values, as_node=...)` | 以某节点身份应用一次更新，返回新配置 | 由更新结果计算下一步 |

`update_state()` 转交给 `bulk_update_state()`，执行指定节点的 writers，经过字段 reducer、控制写入和检查点保存；它不运行该节点的业务函数。已有 `items=["A"]` 且 reducer 为拼接时，手工写 `["B"]` 得到 `["A", "B"]`，并非替换成 `["B"]`。

`as_node` 决定模拟哪个节点产生更新，因而影响触发的后继；运行时推断不唯一时要求调用方明确指定。返回的新配置应作为继续入口，不能丢掉后仍假定旧配置会指向同一分支。

历史记录通过父配置形成分支关系，而不只是不断覆盖一条 State。重放会再次调用外部服务，动态中断也可以重新触发。并行操作同一个 thread 不自动获得业务串行化；API 调用方应对同一工作流实例的更新和恢复安排一致的并发策略。

## 六、Store 保存业务数据，不参与执行回滚

`BaseStore` 按 `namespace + key` 提供 `get/put/search/delete` 等接口，适合用户偏好、资料或跨会话信息。检查点保存的是 thread 的执行现场；Store 数据由节点主动读取和写入，不会自动进入 State。

从旧检查点重放时，节点可能读到 Store 的当前值，而不是历史当时的值。若业务要求可复现，应把必要的版本或数据快照记录到状态中。Store、支付服务、邮件服务等都不因图回退而撤销修改，任务级恢复也不保证这些系统“恰好执行一次”。

`DeltaChannel` 还可能通过历史写入重建字段，清理检查点时不能只看当前 `channel_values` 是否完整。生产保存策略需要同时考虑任务结果、祖先依赖与业务保留要求。
