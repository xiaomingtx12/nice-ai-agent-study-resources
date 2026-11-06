---
sidebar_position: 8
sidebar_label: 06 Thread、检查点与恢复
description: 从多次调用的状态延续讲起，用一项成功、一项失败的例子解释检查点、任务结果与恢复，再区分历史重放、持久化策略和 Store。
---

# LangGraph 源码 06：Thread 如何串起多次调用与状态恢复

同一张图可以处理很多段会话。某段会话调用结束后再传入新消息，需要接上旧状态；一轮并行任务只成功了一半，需要保留成功结果、继续失败项。这两种情况都依赖检查点，但调用方式不同。

先记住三个分工：**thread 标识哪段执行历史，checkpointer（检查点保存器）负责保存和读取执行进度，Store 保存应用主动读写的业务数据。** 本文沿“找到历史 → 保存进度 → 恢复任务”解释它们怎样配合。

> **源码基线**：LangGraph Python，`langgraph 1.2.10`、`langgraph-checkpoint 4.1.1`。本地快照没有可确认的 commit，身份与验证范围见[源码基线](<./source-baseline.md>)。本文核对了实现和测试断言，未执行框架测试或应用示例。
>  - 保存格式：Checkpoint、CheckpointTuple
  libs/checkpoint/langgraph/checkpoint/base/__init__.py
> - 保存器：InMemorySaver.get_tuple / put / put_writes
  libs/checkpoint/langgraph/checkpoint/memory/__init__.py
> - 运行时：put_writes / _put_checkpoint / _first / SyncPregelLoop.__enter__
  libs/langgraph/langgraph/pregel/_loop.py
> - 查询与修改：get_state / get_state_history / update_state
  libs/langgraph/langgraph/pregel/main.py
> - 恢复测试：test_pending_writes_resume
  libs/langgraph/tests/test_pregel.py
> - 业务数据接口：BaseStore
  libs/checkpoint/langgraph/store/base/__init__.py

## 一、同一个 thread，怎样接上上次的状态

thread 是由 `thread_id` 标识的一段执行历史，可以跨越多次 `invoke()`。它不指操作系统线程，也不等于用户：一个用户的两段会话通常使用不同的 thread_id。

下面的完整应用示例只做累计，不调用模型。`InMemorySaver` 是内存检查点保存器；将它传给 `compile()` 后，运行时会在调用之间保存状态。

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
graph = builder.compile(checkpointer=InMemorySaver())

thread_a = {"configurable": {"thread_id": "thread-A"}}
thread_b = {"configurable": {"thread_id": "thread-B"}}

assert graph.invoke({"delta": 2, "total": 0}, thread_a)["total"] == 2
assert graph.invoke({"delta": 3}, thread_a)["total"] == 5
assert graph.invoke({"delta": 10, "total": 0}, thread_b)["total"] == 10
```

A 的第二次调用读取旧的 `total=2`，只把 `delta` 更新为 3，所以结果为 5。B 使用另一条历史，从自己的 `total=0` 开始。若第二次仍传 `total=0`，它会覆盖 A 的旧值，结果就变成 3。

**thread_id 决定读取哪份旧状态，字段更新规则决定新输入怎样合并。** 聊天消息也一样：使用 `add_messages` 时，新消息按消息 ID 追加或更新，具体规则见[第 01 篇](<./01-state-schema-channels-and-reducers.md>)。

这里有两个容易混淆的生命周期：一次调用到达 END，只表示本次执行结束，thread 历史仍然保留；进程退出后，`InMemorySaver` 的内容则会丢失。跨进程恢复需要持久化后端，以及兼容的图结构和状态定义。只有 thread_id、没有配置保存器，也不会自动保存历史。

本地 Python 调用无需先创建 thread：新 ID 配上有效输入即可开始。换 ID 不会删除旧记录，清理历史应由应用按后端接口与保留策略处理。同一 thread 的并发调用也需要应用排队或限制；thread_id 只是查找键，不提供业务串行化或访问授权。

## 二、检查点里保存什么，怎样找到它

一次 `invoke()` 可以经过多个执行轮次，每轮又可能包含多个并行任务，因此一次调用中就可能产生多个 checkpoint（检查点）。运行时用以下三个字段定位记录：

| 字段 | 回答的问题 | 例子 |
| --- | --- | --- |
| `thread_id` | 哪段执行历史？ | `thread-A` |
| `checkpoint_ns` | 这段历史中的哪张图？ | 根图通常为 `""`，子图使用各自的命名空间 |
| `checkpoint_id` | 哪个保存位置？ | 省略时读取该命名空间下的最新记录 |

`InMemorySaver.get_tuple()` 是读取检查点及其关联数据的方法。它的查找逻辑直接体现了这三层身份。以下摘自该方法第 250–254、281–284 行，省略解析与返回对象的代码：

```python
thread_id: str = config["configurable"]["thread_id"]
checkpoint_ns: str = config["configurable"].get("checkpoint_ns", "")
if checkpoint_id := get_checkpoint_id(config):
    # 带 ID：查找指定位置。
    if saved := self.storage[thread_id][checkpoint_ns].get(checkpoint_id):
        checkpoint, metadata, parent_checkpoint_id = saved
        # ……省略解析与返回……
else:
    if checkpoints := self.storage[thread_id][checkpoint_ns]:
        # 不带 ID：取这个命名空间下最新的检查点。
        checkpoint_id = max(checkpoints.keys())
        checkpoint, metadata, parent_checkpoint_id = checkpoints[checkpoint_id]
        # ……省略解析与返回……
```

这里没有 graph 对象或图名。两张根图若共用保存器、thread_id 和默认命名空间，不会因为 Python 对象不同就自动隔离历史。

找到记录后，运行时还需要知道“有哪些数据”和“哪些节点该执行”。`Checkpoint` 保存通道值 `channel_values`、通道版本 `channel_versions`，以及节点已处理过的版本 `versions_seen` 等调度信息。只存一份业务 State，无法判断某个触发信号是否已经消费。

保存器返回的 `CheckpointTuple` 在检查点之外还携带元数据、父检查点配置和 `pending_writes`。其中 **pending writes 是关联到该检查点的任务写入记录**，可以包含成功输出、错误或中断信息。成功输出即使尚未合并成下一份检查点，也能先单独保存，这是部分失败后不必全部重跑的关键。

## 三、一项成功、一项失败，为什么只重跑失败项

设 left 和 right 在同一轮并行整理材料，left 成功返回 A，right 抛出异常。两项都完成后，图才会合并结果并进入下一轮；但 left 的成功结果可以先保存。

### 1、任务结果和轮次状态分开保存

Loop 是管理图状态与轮次的运行时对象。任务完成后，Loop 的 `put_writes()` 记录任务写入；整轮成功后，`after_tick()` 合并更新，`_put_checkpoint()` 保存新的检查点。

| 时点 | 检查点状态 | 关联的任务写入 |
| --- | --- | --- |
| left、right 开始前 | C：本轮的起始状态 | 尚无结果 |
| left 成功，right 失败 | 仍是 C，本轮未整体提交 | left 的成功输出、right 的错误 |
| 恢复后 right 成功 | 合并两项结果，形成 C' | 使用 left 的旧结果和 right 的新结果 |

对应到保存器接口，`put_writes()` 保存任务记录，`put()` 保存检查点。**恢复能否复用 left，取决于它的成功写入是否已经保存。** 具体何时等待保存完成，由第五节的 durability 策略决定。

### 2、恢复时，按任务 ID 找回成功输出

使用原 thread 调用 `graph.invoke(None, config)` 时，配置不要带 `checkpoint_id`。运行时加载最新检查点，重建通道和待执行任务，再把已保存的成功写入放回对应任务。

核心操作是 `PregelLoop._reapply_writes_to_succeeded_nodes()`，下面摘录第 745–749 行，其余代码省略：

```python
for tid, k, v in self.checkpoint_pending_writes:
    # 错误、中断、恢复值属于控制记录，不算成功输出。
    if k in (ERROR, ERROR_SOURCE_NODE, INTERRUPT, RESUME):
        continue
    if task := tasks.get(tid):
        task.writes.append((k, v))
```

`tid` 是任务 ID，`k` 是写入的通道名，`v` 是写入值。left 匹配到已有输出后，不再交给执行器调用；right 没有成功输出，从任务入口重新运行。它不会从异常发生的那一行继续，也不会因为输入相同就按缓存规则复用结果。缓存机制见[第 03 篇](<./03-pregel-supersteps-and-scheduling.md>)。

### 3、为什么查询能看到 A，却仍然没有整轮检查点

`get_state()` 返回面向调用方的 `StateSnapshot`（状态视图），其中 `values` 是状态值，`next` 是待执行节点，`tasks` 包含任务结果、错误和中断信息。这个视图可以叠加成功任务的写入，未必等于检查点本体。

`Pregel.get_state()` 明确区分是否指定检查点 ID。下面摘录第 1428–1434 行，其余代码省略：

```python
saved = checkpointer.get_tuple(config)
return self._prepare_state_snapshot(
    config,
    saved,
    recurse=checkpointer if subgraphs else None,
    # 查询最新状态时，叠加成功任务的待合并写入。
    apply_pending_writes=CONFIG_KEY_CHECKPOINT_ID not in config[CONF],
)
```

仓库测试 `test_pending_writes_resume`（第 877–973 行）用整数加法验证了这一行为：初始值为 1，one 成功返回增量 2，two 抛出连接异常，每次运行最多尝试两次。one、two 分别对应前面的 left、right。

| 操作 | 测试断言 | 原因 |
| --- | --- | --- |
| 首次执行失败 | one 调用 1 次，two 调用 2 次 | one 已成功，two 重试耗尽 |
| `state = graph.get_state(thread1)`，不带检查点 ID | value 为 3，next 只有 two | 当前视图叠加了 one 的成功输出 |
| `graph.get_state(state.config)`，带返回的检查点 ID | value 为 1，next 包含 one、two | 指定位置的视图不自动叠加成功任务写入 |
| `graph.invoke(None, thread1)`，two 仍失败 | one 仍为 1 次，two 累计 4 次 | 恢复跳过 one，只重跑 two |
| 将 two 改为返回增量 3，再恢复 | 最终 value 为 6 | 起始 1 + 已保存的 2 + 本次的 3 |

所以，界面显示 A 的结果和 B 的失败可以同时成立。不能只看 `values` 中已有 A 就把整轮标为完成，还要看 `next` 和 `tasks`。这些是仓库测试中的断言，不代表已经验证了进程突然崩溃的场景。

## 四、新输入、失败恢复和历史重放，入口有什么区别

下面的 `config` 只选择 thread，不带 `checkpoint_id`；`past.config` 来自 `get_state_history()` 返回的历史快照，包含具体检查点 ID。

| 目的 | 调用方式 | 行为 |
| --- | --- | --- |
| 上次已完成，开始下一轮业务处理 | `graph.invoke(new_input, config)` | 读取旧状态，合并新输入，从图入口处理 |
| 继续失败或停止的执行 | `graph.invoke(None, config)` | 加载最新现场，复用已保存的成功任务结果 |
| 回答动态中断的问题 | `graph.invoke(Command(resume=answer), config)` | 提供恢复值，继续暂停的任务 |
| 从指定历史位置重放 | `graph.invoke(None, past.config)` | 重新执行该位置之后的流程 |
| 修改历史状态后分叉 | `new_config = graph.update_state(past.config, values, as_node=...)` | 生成新检查点，再用返回配置继续 |

`Command(resume=...)` 是给 `interrupt()` 动态中断提供回答的控制输入，审批示例见[第 07 篇](<./07-interrupts-and-command.md>)。普通异常恢复不需要审批值；动态中断也不能只靠 `None` 得到用户答案。

普通输入字典会走新输入分支，并对旧现场的未完成任务作丢弃处理，所以失败后不要用重发业务输入代替恢复。反过来，图已经到达 END 后，`invoke(None, config)` 不会自动开启新一轮累计。

**调用 `invoke(None, ...)` 时，显式传入 checkpoint_id 就是在选择重放位置，即使这个 ID 恰好是最新的。** 它与不带 ID 的失败恢复不同。不要直接拿 `get_state()` 返回的 `state.config` 当作“恢复最新进度”的配置。

`update_state()` 则是手工产生一次状态更新：它不执行指定节点的业务函数，但会经过字段的 reducer（归并函数），并以 `as_node` 指定的节点身份计算后继。例如列表采用拼接规则时，旧值 `["A"]` 加更新 `["B"]` 得到 `["A", "B"]`。无法唯一推断节点时需要明确传入 `as_node`；继续执行应使用返回的 `new_config`，以选中这条新分支。

## 五、保存到了哪里，决定故障后还能恢复多少

检查点数据已经生成、事件已经发给界面，都不等于后端保存已经完成。`durability` 决定保存与后续执行如何重叠：

| 模式 | 保存策略 | 主要取舍 |
| --- | --- | --- |
| `sync` | 下一轮推进前等待检查点保存完成 | 多一段写入等待，缩小轮次间的丢失窗口 |
| `async`（默认） | 后台保存与后续执行重叠 | 等待少，进程突然退出可能丢失未完成的保存 |
| `exit` | 在执行退出时集中保存，包括正常完成、中断或异常退出清理 | 写入少，但执行中强杀进程可能来不及保存 |

同步等待位于 `Pregel.stream()` 第 2984–2988 行。`exit` 模式还会跳过常规任务写入的即时保存，退出时再处理。`async` 在正常退出清理时也会等待后台保存；上表的丢失风险针对来不及清理的突发退出。内存保存器即使使用 `sync`，也不会因此具备跨进程保留能力。

受控停止通过 `RunControl.request_drain()` 请求不再推进后续轮次，机制见[第 03 篇](<./03-pregel-supersteps-and-scheduling.md>)。保存成功后，可以用原 thread 和 `None` 继续，但不要复用已请求停止的 control 对象。这仍以退出清理执行完、后端数据可读为前提。

还有一个独立于保存策略的风险：**外部动作已经成功，任务成功记录却还没保存。** 例如节点发出了邮件，随即进程退出，恢复时节点可能再次发送。检查点无法让邮件服务自动回滚或去重；需要用稳定的业务键防重复，或先查询动作是否已完成。从旧检查点主动重放也要考虑同一问题。

## 六、Store 为什么与检查点分开

假设用户开了两段会话。每段会话的消息和执行进度应各自保存，但“回复尽量简短”这个偏好可以共用。前者用不同 thread 的检查点，后者适合放进 Store。

`BaseStore` 是按 `namespace + key` 读写业务数据的接口，提供 `get/put/search/delete` 等操作。下面是应用代码示例：

```python
from langgraph.store.memory import InMemoryStore

store = InMemoryStore()
namespace = ("user-123", "preferences")
store.put(namespace, "reply_style", {"length": "short"})
item = store.get(namespace, "reply_style")
assert item is not None
assert item.value == {"length": "short"}
```

两段会话只要访问同一个 Store 和这个 namespace，就能读取同一份偏好。Store 不会自动按 thread_id 隔离，也不会自动把数据注入 State。编译时传入 `store=store` 后，节点可以通过运行时参数 `runtime.store` 主动读写；这里的内存实现同样不能跨进程保留数据。

从旧检查点重放时，Store 不随图一起回退，节点可能读到今天更新过的偏好。若要求重现当时的行为，应把所需数据或版本记录进状态。检查点负责恢复执行进度，Store 数据的版本与保留策略仍由应用管理。
