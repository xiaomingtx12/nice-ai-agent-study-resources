---
sidebar_position: 8
sidebar_label: 06 Thread、检查点与恢复
description: 从同一 thread 的多次调用解释状态延续与隔离，追踪 thread_id 如何定位检查点，再分析任务结果保存、恢复、分叉和生命周期。
---

# LangGraph 源码 06：Thread 如何串起多次调用与状态恢复

## 源码定位

> **源码基线**：langgraph 1.2.10、langgraph-checkpoint 4.1.1。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 保存协议：`libs/checkpoint/langgraph/checkpoint/base/__init__.py` → `Checkpoint`、`CheckpointTuple`、`BaseCheckpointSaver`。
> - 保存器实例：`libs/checkpoint/langgraph/checkpoint/memory/__init__.py` → `InMemorySaver.get_tuple()`（236 行，按 thread_id / checkpoint_ns / checkpoint_id 读取）、`put()`（427 行，保存归属与父位置）、`put_writes()`、`delete_thread()`（511 行）。
> - 运行时保存与加载：`libs/langgraph/langgraph/pregel/_loop.py` → `put_writes()`、`_put_checkpoint()`、`_suppress_interrupt()`、`SyncPregelLoop.__enter__()`、`_first()`。
> - 查询与修改：`libs/langgraph/langgraph/pregel/main.py` → `get_state()`、`get_state_history()`、`update_state()`、`bulk_update_state()`。
> - 业务数据：`libs/checkpoint/langgraph/store/base/__init__.py` → `BaseStore`。

同一个 graph 连续调用两次，第二次能否接着使用第一次的状态？如果两个人共用这个 graph，又该怎样分开各自的历史？

LangGraph 用 **thread（会话或工作流实例的执行历史）** 关联多次调用，再由 checkpointer（检查点保存器）保存和读取其中的状态。应用通过 `thread_id` 选择这条历史；一次 `invoke()` 可以产生多个检查点，多次 `invoke()` 也可以属于同一个 thread。

本篇从同一 thread 的连续调用开始，再解释状态保存、失败恢复和历史分叉。底层关注两份信息：状态已经合并到哪里，以及当前一轮哪些节点调用已经成功。

## 一、同一个 thread 怎样延续状态

可以把 thread 理解成一份有身份的执行档案。聊天应用常把一段会话对应到一个 thread；其他工作流也可以把一次审核流程对应到一个 thread。它的生命周期可以跨越多次函数调用。

下面这些对象各自承担一件事：

| 名字 | 本篇中的含义 | 与其他对象的关系 |
| --- | --- | --- |
| graph | 编译好的节点、边和执行规则 | 一份 graph 可以服务多个 thread |
| thread | 用同一身份关联的状态与执行历史 | 一条历史可以承接多次调用 |
| 一次运行 | 一次 invoke 或异步调用的执行过程 | 完成、失败或暂停后，这次调用可以退出，历史继续保留 |
| checkpoint | 某个执行位置保存的检查点 | 一次调用中就可能产生多个检查点 |

这里的 thread 不指操作系统线程；选择 thread_id 不会启动或占用一个专属工作线程。它也不等于用户 ID：一个用户可以有多段会话，分别使用不同的 thread_id。

### 用两次累计，看清新输入和旧状态

下面是完整应用示例。`InMemorySaver` 是把检查点放在当前进程内的保存器，用来观察调用之间的状态延续；它的内容不会因进程重启而自动保留。

```python
from typing_extensions import TypedDict
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, END, StateGraph

class State(TypedDict):
    delta: int
    total: int

def accumulate(state: State):
    return {"total": state["total"] + state["delta"]}

builder = StateGraph(State)
builder.add_node("accumulate", accumulate)
builder.add_edge(START, "accumulate")
builder.add_edge("accumulate", END)

saver = InMemorySaver()
graph = builder.compile(checkpointer=saver)
thread_a = {"configurable": {"thread_id": "thread-A"}}
thread_b = {"configurable": {"thread_id": "thread-B"}}

first = graph.invoke({"delta": 2, "total": 0}, thread_a)
second = graph.invoke({"delta": 3}, thread_a)
other = graph.invoke({"delta": 10, "total": 0}, thread_b)

assert first["total"] == 2
assert second["total"] == 5
assert other["total"] == 10
assert graph.get_state(thread_a).values["total"] == 5
```

三次调用复用同一个 graph 和 saver，变化的是 thread_id 与输入。它们都在前一次调用正常结束后再开始，没有并发更新。

| 调用 | 调用前的历史 | 本次输入的作用 | 最终 total |
| --- | --- | --- | --- |
| A 第一次 | 尚无状态 | 设置 delta=2、total=0，再执行累计 | 2 |
| A 第二次 | 读取 A 已保存的 total=2 | 只更新 delta=3，total 保留旧值，再执行累计 | 5 |
| B 第一次 | B 没有 A 的状态 | 设置自己的 delta=10、total=0 | 10 |

第二次没有再次传 total=0，否则默认字段更新会覆盖旧 total，本次结果就会变成 3。**同一个 thread 会读取已有状态，新输入仍按字段规则应用更新。** 它不会把每个字段都自动追加，也不会忽略调用方明确提供的新值。

聊天里的多轮消息遵循同样的关系：thread_id 选中会话历史，messages 字段的 reducer 决定新消息怎样合并。使用 `add_messages` 时可以提交本轮消息，由这个消息归并函数按消息 ID 更新或追加；具体规则见[第 01 篇](./01-state-schema-channels-and-reducers.md)。

### thread_id 和保存器缺一不可

示例把 ID 放在调用配置的 `configurable` 中，而不是放进业务 State。accumulate 不需要手工查找 A 的历史，图执行入口会把这份配置传给保存器。

`thread_id` 负责选历史，保存器负责实际保存。仅复用 graph 对象，或只传同一个 thread_id 而没有配置保存器，都不能获得这里展示的跨调用恢复能力。要跨进程延续状态，还需要连接到能够保留记录的持久后端，并使用兼容的图结构、状态定义及执行身份。

## 二、源码怎样用 thread_id 找到执行历史

每次进入图调用，运行时都会根据配置向保存器读取记录。`SyncPregelLoop.__enter__()` 是同步执行的加载入口：有历史时恢复已有状态，没有历史时创建空检查点。它不会用 graph 这个 Python 对象的身份来区分 A、B。

保存器看到的定位信息分成三个层次：

| 字段 | 定位对象 | 影响 |
| --- | --- | --- |
| `thread_id` | 同一保存后端中的一条执行历史 | A、B 分别访问自己的检查点与任务结果 |
| `checkpoint_ns` | 根图或子图命名空间 | 同一执行线内划分嵌套图历史 |
| `checkpoint_id` | 指定历史检查点 | 省略时通常读取该命名空间下最新记录 |

根图通常使用空字符串 `checkpoint_ns`，子图在同一 thread 下使用各自的命名空间。省略 checkpoint_id 时读取最新位置；指定它时，才是在这条历史中选择某个明确的检查点。

### 读取和写入使用同一组身份

`InMemorySaver.get_tuple()` 的查找路径直接体现了这三个层次。`self.storage` 是保存检查点记录的内部映射，`get_checkpoint_id()` 从配置中取出可选的历史位置。

源码：`libs/checkpoint/langgraph/checkpoint/memory/__init__.py` → `InMemorySaver.get_tuple`，第 250–254、281–285 行。返回对象的组装及反序列化等代码省略。

```python
thread_id: str = config["configurable"]["thread_id"]
checkpoint_ns: str = config["configurable"].get("checkpoint_ns", "")
if checkpoint_id := get_checkpoint_id(config):
    # 指定位置时，在这个 thread 的命名空间内精确查找。
    if saved := self.storage[thread_id][checkpoint_ns].get(checkpoint_id):
        checkpoint, metadata, parent_checkpoint_id = saved
        # ……省略该分支的解析与返回……
else:
    if checkpoints := self.storage[thread_id][checkpoint_ns]:
        # 没有指定位置时，取当前命名空间下最新的检查点。
        checkpoint_id = max(checkpoints.keys())
        checkpoint, metadata, parent_checkpoint_id = checkpoints[checkpoint_id]
        writes = self.writes[(thread_id, checkpoint_ns, checkpoint_id)].values()
```

所以 A 的第二次调用能取回旧状态，B 则会进入另一组记录。内存保存器的索引里没有 graph 对象或图名；两张根图若共用这个保存器、同一 thread_id 和默认命名空间，也不会仅因 graph 对象不同而自动隔离历史。应用应划分执行身份或后端存储范围。

保存时使用同样的 thread_id、checkpoint_ns，将新检查点放入这条历史，并记下它的父检查点。

源码：`libs/checkpoint/langgraph/checkpoint/memory/__init__.py` → `InMemorySaver.put`，第 449–450、456–464 行。字段值的独立保存和返回配置省略。

```python
thread_id = config["configurable"]["thread_id"]
checkpoint_ns = config["configurable"]["checkpoint_ns"]
# ……省略按通道版本保存字段值……
self.storage[thread_id][checkpoint_ns].update(
    {
        checkpoint["id"]: (
            self.serde.dumps_typed(c),
            self.serde.dumps_typed(get_checkpoint_metadata(config, metadata)),
            config["configurable"].get("checkpoint_id"),  # 父检查点。
        )
    }
)
```

这里的 c 是检查点的副本；字段值已在省略部分按版本单独保存，`serde` 负责序列化。一次运行会在输入和执行轮次等位置保存记录，因此 thread 是一组有先后或分支关系的历史，不是只有一个最终状态字典。

### 找到记录后，还要恢复哪些信息

`CheckpointTuple` 是保存器返回的组合记录，包含检查点本体、父位置与待合并任务结果。`BaseCheckpointSaver` 定义这套保存协议；InMemorySaver 是其中一个实现，其他后端按同一协议提供读取与保存。

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

## 三、两条保存路径分别对应任务和轮次

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

## 四、加载时恢复通道与待合并结果

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

## 五、查询当前状态与查询历史快照不同

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

## 六、同一 thread 的新输入、恢复和重放如何区分

thread_id 相同，只能说明访问同一条历史；这次要做什么，还由输入形式和 checkpoint_id 决定。前面的累计例子是在上次运行完成后提交新输入，属于在旧状态基础上开始新一轮业务处理。

| 入口 | 运行含义 | 任务结果复用 |
| --- | --- | --- |
| 同一 thread 的最新配置加新输入字典 | 在已有状态上应用新输入，再从图入口处理 | 保留历史状态；不能把它当成未完成任务的恢复指令 |
| 最新配置加 `invoke(None, config)` | 继续未完成现场 | 可复用已保存成功写入 |
| drain 后的执行线加 `invoke(None, config)`，不复用已停止的 control | 继续尚未执行的后续轮次 | 从停止时实际保存的现场重新准备任务 |
| 最新配置加 `Command(resume=...)` | 继续并给中断提供值 | 恢复对应暂停任务 |
| 历史配置加 `invoke(None, historical_config)` | 从选定历史点重新执行后续流程 | 有意重放后续任务，不等同于失败恢复 |
| `update_state(historical_config, values, as_node=...)` | 以某节点身份应用一次更新，返回新配置 | 由更新结果计算下一步 |

`PregelLoop._first()` 区分这些入口。None 或带恢复值的控制输入可以进入继续执行分支；普通新输入字典会走输入处理分支，对上一现场中的未完成任务有丢弃处理。因此失败或暂停后，不应通过重发普通业务输入来代替恢复。

成功运行已经到达 END 时，`invoke(None, config)` 也不会凭空再执行一次累计；要开始下一次业务处理，应提交新的输入。动态审批中断还需要提供恢复值，单靠 thread_id 和 None 无法回答审批问题。

`update_state()` 转交给 `bulk_update_state()`，执行指定节点的 writers，经过字段 reducer、控制写入和检查点保存；它不运行该节点的业务函数。已有 `items=["A"]` 且 reducer 为拼接时，手工写 `["B"]` 得到 `["A", "B"]`，并非替换成 `["B"]`。

`as_node` 决定模拟哪个节点产生更新，因而影响触发的后继；运行时推断不唯一时要求调用方明确指定。返回的新配置应作为继续入口，不能丢掉后仍假定旧配置会指向同一分支。

历史记录通过父配置形成分支关系，而不只是不断覆盖一条 State。重放会再次调用外部服务，动态中断也可以重新触发。并行操作同一个 thread 不自动获得业务串行化；API 调用方应对同一工作流实例的更新和恢复安排一致的并发策略。

## 七、thread 的创建、结束与并发由谁管理

本篇讨论本地 Python 的 graph.invoke 路径。使用一个尚无记录的 thread_id 提交有效输入，就会从空状态开始并在运行中保存历史；这里不要求先创建一个操作系统线程，也不要求先调用部署服务的 thread 管理接口。

一次运行到达 END，表示这次没有待执行节点，保存器仍保留该 thread 的历史。后续可以继续提交新输入。取消一次调用或让它暂停，也不会自动删除历史。

常见的生命周期操作应分别处理：

| 应用意图 | 本地调用方式或处理原则 |
| --- | --- |
| 开始新会话或新工作流实例 | 使用新的 thread_id，提交所需初始输入 |
| 查询现有进度 | `graph.get_state(config)`；需要历史时用 `get_state_history(config)` |
| 继续之前的业务实例 | 使用原 thread_id，并按上节区分新输入与恢复输入 |
| 清理内存保存器中的历史 | 由应用决定时机，调用该保存器的 `delete_thread(thread_id)`；其他后端核对其清理接口与保留策略 |

切换到新 ID 只是选择另一份历史，不会顺便删除旧 ID 的记录。应用还需要保存“用户、业务实例与 thread_id”的关联；thread_id 本身只是查找键，不表达调用者是否有权访问这条历史。

同一个 thread 的并发调用也需要应用安排。两个请求可能读取同一份旧状态，再分别写入各自的后续记录；thread_id 的分组并不自动把整个业务运行串行化。对同一会话排队或拒绝重叠运行，是本地集成时可以采用的策略；检查点写入完成与业务操作完成也仍是不同边界。

## 八、Store 保存业务数据，不参与执行回滚

`BaseStore` 按 `namespace + key` 提供 `get/put/search/delete` 等接口，适合用户偏好、资料或跨会话信息。检查点保存的是 thread 的执行现场；Store 数据由节点主动读取和写入，不会自动进入 State。

从旧检查点重放时，节点可能读到 Store 的当前值，而不是历史当时的值。若业务要求可复现，应把必要的版本或数据快照记录到状态中。Store、支付服务、邮件服务等都不因图回退而撤销修改，任务级恢复也不保证这些系统“恰好执行一次”。

`DeltaChannel` 还可能通过历史写入重建字段，清理检查点时不能只看当前 `channel_values` 是否完整。生产保存策略需要同时考虑任务结果、祖先依赖与业务保留要求。
