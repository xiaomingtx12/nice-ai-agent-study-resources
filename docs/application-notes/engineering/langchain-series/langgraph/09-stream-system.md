---
sidebar_position: 11
sidebar_label: 09 流式输出与事件
description: 追踪事件产生、队列传递与投影消费，区分输出事件、提交状态、停止消费和取消执行。
---

# LangGraph 源码 09：运行过程如何成为可消费事件

**源码定位**

> 快照身份与验证范围见[源码基线](./source-baseline.md)。源码节选以该快照为准，文中的应用示例不等于框架实现。

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 事件出口：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`、`_output()`、`stream_events()`、`_pregel_stream_v3()`。
> - 状态事件：`libs/langgraph/langgraph/pregel/_loop.py` → `output_writes()`、`after_tick()`、`_emit()`。
> - 消息回调：`libs/langgraph/langgraph/pregel/_messages.py` → `StreamMessagesHandler`。
> - v3 消费与退出：`libs/langgraph/langgraph/stream/run_stream.py` → `GraphRunStream._pump_next()`、`GraphRunStream.abort()`、`AsyncGraphRunStream.abort()`；`libs/langgraph/langgraph/stream/_mux.py` → `StreamMux.push()`。

调用 `graph.invoke(...)` 时，你通常等待一个最终结果；换成 `graph.stream(...)`，则能边运行边拿到输出。这些输出从哪里来，拿到一个节点的更新时，能不能认为整张图已经保存成功？本篇沿事件的产生和消费回答这些问题。

流式输出将图执行过程中的数据交给调用方。不同事件产生于不同时间：模型 token 可以在节点尚未结束时输出，任务更新可以在同轮其他任务未完成时输出，完整状态则通常在轮次提交后输出。**看到事件，不等于看到整轮成功或检查点已经落盘。**

`stream()` 本身也是执行入口，调用方迭代它会推进运行；`invoke()` 只是消费同一执行机制并返回最终结果。选择 mode 决定观察什么，不改变字段 reducer 的含义。

本篇沿 [03 的提交时序图](./03-pregel-supersteps-and-scheduling.md#result-timeline) 观察同一次执行。材料 A 的更新可以先显示，材料 B 仍在处理；报告进入审批后，也不能把最后一条 token 当成整项任务完成。前半篇解释事件产生的位置，后半篇再讲接口版本和运行流的生命周期。

## 一、同一个节点，进度、更新与状态有什么不同

下面是完整应用示例。`get_stream_writer()` 用来取得当前运行的事件写入函数，节点可用它报告业务进度。increment 先报告即将处理的 count，再返回真正的字段更新；report 节点读取提交后的 count。

```python
from typing_extensions import TypedDict
from langgraph.config import get_stream_writer
from langgraph.graph import START, END, StateGraph

class State(TypedDict):
    count: int
    message: str

def increment(state: State):
    writer = get_stream_writer()
    writer({"stage": "incrementing", "count_before": state["count"]})
    return {"count": state["count"] + 1}

def report(state: State):
    return {"message": f"当前计数为 {state['count']}"}

builder = StateGraph(State)
builder.add_node("increment", increment)
builder.add_node("report", report)
builder.add_edge(START, "increment")
builder.add_edge("increment", "report")
builder.add_edge("report", END)
graph = builder.compile()

for part in graph.stream(
    {"count": 0, "message": ""},
    stream_mode=["custom", "updates", "values"],
    version="v2",
):
    print(part["type"], part["data"])
```

`stream_mode` 选择观察内容，`version` 选择外层格式。这里显式选择 v2，让每条事件都通过 type、data 读取；没有配置保存器，事件也照样产生。

下面摘出这次执行中的几类数据，不是列出全部输出：

| type | data 示例 | 此时发生了什么 |
| --- | --- | --- |
| custom | `{"stage": "incrementing", "count_before": 0}` | increment 主动报告进度，还没返回 count 更新 |
| updates | `{"increment": {"count": 1}}` | 这次节点调用给出局部更新 |
| values | `{"count": 1, "message": ""}` | increment 所在轮次合并完成，得到当前状态 |
| updates | `{"report": {"message": "当前计数为 1"}}` | 下游根据已提交的 count 产生文本 |
| values | `{"count": 1, "message": "当前计数为 1"}` | report 所在轮次合并完成 |

writer 发出的 stage、count_before 不会出现在 State 中。写进度和返回更新走的是不同接口；即使事件里的字段也叫 count，writer 也不会替你更新状态。

`updates` 是“某节点返回了什么”，`values` 是“字段规则合并后是什么”。在[第 01 篇的并行例子](./01-state-schema-channels-and-reducers.md)中，两条 updates 各只有一项 items，轮次提交后的 values 才包含两项。

节点重试或恢复重跑可能重复输出 custom。进度事件适合展示当前活动，不能拿“一条进度只出现一次”替代业务去重。`messages` 模式则依赖模型适配器和回调上下文，任意第三方 SDK 自己吐出的字节不会自动成为模型消息事件。

## 二、普通 stream 从多个位置收集事件

公开 `StreamMode` 列出七种观察模式：

| mode | 事件来源 | 读取时需要知道的边界 |
| --- | --- | --- |
| `values` | 输入、轮次提交等时刻读取通道值 | 正常轮次是合并后视图；中断收尾还可能包含已成功任务的待合并结果 |
| `updates` | 任务结果写入映射 | 局部更新不是 reducer 合并后的整份 State |
| `messages` | 模型消息回调 | 常见负载为消息片段和 metadata；可能早于节点完成 |
| `custom` | 节点主动调用 writer | 业务进度，不自动更新 State |
| `tasks` | 任务开始和完成记录 | 可包含错误或中断，用于诊断 |
| `checkpoints` | Loop 输出检查点视图 | 不是数据库提交成功回执 |
| `debug` | 任务与检查点诊断组合 | 负载更大，可能包含完整状态 |

Loop 的 `_emit()` 将数据组织成 `(namespace, mode, payload)`，放入流队列。`StreamMessagesHandler` 是把模型回调转成消息事件的处理器，`messages` 模式通过它接收输出；`custom` 通过运行上下文中的 `stream_writer` 写入同一出口。主循环在 Runner 让出控制权以及轮次结束时排空队列。

这解释了为什么 `updates` 可早于整轮提交：A 完成时就能显示 A 的结果，B 之后仍可能失败。前端若展示“当前已提交状态”，应使用相应的状态视图；若展示“任务进展”，则应保留开始、成功、失败和暂停等区别。

## 三、_output 决定片段形状

`_output()` 是流片段离开运行时前的格式转换函数。`ns` 表示事件来自哪一层图，根图为空元组；`mode` 是 values、updates 等观察模式；`payload` 是具体数据。它们共同描述一条事件。

内部总是携带命名空间和 mode，v1 输出会按请求裁掉外层信息：

源码：`libs/langgraph/langgraph/pregel/main.py` → `_output`（第 4236–4243 行节选；未展示部分省略）。

```python
elif stream_subgraphs and isinstance(stream_mode, list):
    yield (ns, mode, payload)
elif isinstance(stream_mode, list):
    yield (mode, payload)
elif stream_subgraphs:
    yield (ns, payload)
else:
    yield payload
```

| v1 参数 | 返回形状 |
| --- | --- |
| 单一 mode，默认子图选项 | `data` |
| mode 列表，默认子图选项 | `(mode, data)` |
| 单一 mode，`subgraphs=True` | `(namespace, data)` |
| mode 列表，`subgraphs=True` | `(namespace, mode, data)` |

根图 namespace 是空元组，子图包含调用路径与任务身份。updates 的 data 通常按节点名包裹局部更新；不能把路径元组、mode 和业务字段混成一个结构。

v2 统一使用 `{"type": mode, "ns": ns, "data": payload}`。values 还把中断放到独立字段：

源码：`libs/langgraph/langgraph/pregel/main.py` → `_output`（第 4220–4228 行节选；未展示部分省略）。

```python
if version == "v2":
    if mode == "values":
        # 将中断移到独立字段，并按输出结构转换状态。
        ints: tuple[Interrupt, ...] = ()
        if isinstance(payload, dict):
            ints = payload.pop(INTERRUPT, ())
            if output_mapper:
                payload = output_mapper(payload)
        yield {"type": mode, "ns": ns, "data": payload, "interrupts": ints}
```

只切换版本、不调整解包代码，可能让原本的 `for mode, data in ...` 读取错误。前端协议应固定版本和所选模式，再处理异常与结束事件。

## 四、理解普通流以后，再区分事件接口的版本

先分清入口，再比较输出格式。`Runnable` 是图、模型等对象共用的执行接口；`GraphRunStream` 是本基线中用来消费一次运行事件、取得结果或请求退出的流对象。下面先认它们各自从哪个方法返回，后面再展开队列与事件转换。

| 入口 | 本文基线下的输出 | 实现路径 |
| --- | --- | --- |
| `stream(version="v1" / "v2")` | 状态、消息或进度片段 | 运行时事件队列 → `_output()` |
| `stream_events(version="v1" / "v2")` | Runnable 事件字典 | 委托父类事件接口 |
| `stream_events(version="v3")` | `GraphRunStream` 运行流对象 | 普通 v2 流 → 协议事件 → 转换器与投影 |

`stream` 的 v2 与 `stream_events` 的 v2 不是同一种事件外形。`GraphRunStream` 则是实验性接口，提供 `values`、`messages` 等可独立消费的投影；它不是普通 stream 的所有 mode 默认都会经过的中间层。

## 五、v3 在普通流之上建立类型化投影

这里的“投影”是从同一次运行中选取一类事件形成的可迭代视图，例如只消费 values；它不是再启动一次图运行。

`_pregel_stream_v3()` 创建 `StreamMux`（事件分发器），注册 values、messages、生命周期和子图转换器，再合并编译时与调用时提供的扩展转换器。每个转换器声明 `required_stream_modes`，运行时取并集决定底层需要开启哪些 mode。

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel._pregel_stream_v3`（第 3545–3558 行节选；未展示部分省略）。

```python
graph_iter = iter(
    self.stream(
        input,
        patch_configurable(config, {CONFIG_KEY_STREAM_MESSAGES_V2: True}),
        stream_mode=_collect_stream_modes(mux),
        subgraphs=True,
        version="v2",
        interrupt_before=interrupt_before,
        interrupt_after=interrupt_after,
        control=control,
        **kwargs,
    )
)
return GraphRunStream(graph_iter, mux)
```

这里明确使用普通 `stream(version="v2", subgraphs=True)`。v3 接管 mode 和子图选项，调用方再传 `stream_mode` 或 `subgraphs` 会被拒绝。updates、custom、tasks 等额外投影需要相应转换器注册，不能假设默认对象已经提供全部投影。

消费者迭代某个投影、而投影没有可读项时，会请求运行流继续拉取底层事件：

源码：`libs/langgraph/langgraph/stream/run_stream.py` → `GraphRunStream._pump_next`（第 131–146 行节选；未展示部分省略）。

```python
if self._exhausted or self._graph_iter is None:
    return False
try:
    part = next(self._graph_iter)
    event = convert_to_protocol_event(part)
    self._observe_event(event)
    self._mux.push(event)
    return True
except StopIteration:
    self._mux.close()
    self._exhausted = True
    return False
except Exception as e:
    self._mux.fail(e)
    self._exhausted = True
    return False
```

`convert_to_protocol_event()` 将普通 v2 片段转换为协议事件，`_observe_event()` 更新最终状态与中断记录，`StreamMux.push()` 依注册顺序调用转换器的 `process()`，再按处理结果写入主事件日志。转换器提供的 `StreamChannel` 是事件缓冲对象，保存各投影可消费的项目。它与第 01 篇保存业务字段、执行 reducer 的状态通道职责不同。

迭代一次投影可能需要拉取多个底层事件，不能理解为“一次 next 恰好执行一个节点或一轮”。同步运行流无需额外后台线程来驱动这条拉取链，但节点执行和检查点保存仍可能使用执行器。

## 六、消费、异常与停止也是接口语义

### 1、获取最终值会继续驱动运行

投影默认是单消费者，重复迭代同一个投影会报错；需要多路消费时使用 `tee(n)`，并考虑慢消费者带来的缓冲成本。v3 的 `run.output` 不是只读现有缓存，它会驱动底层流到结束后返回结果：

源码：`libs/langgraph/langgraph/stream/run_stream.py` → `GraphRunStream.output`（第 184–190 行节选；未展示部分省略）。

```python
@property
def output(self) -> dict[str, Any] | None:
    """驱动运行直到结束，再返回最终状态。"""
    _drive_until_done(self._pump_next)
    if (err := self._mux._events._error) is not None:
        raise err
    return self._latest
```

若底层失败，Mux 记录错误，消费端或读取 output 时会重新抛出。若调用方已经决定停止，不能再通过读取 output 来“顺便取个结果”，因为它可能继续驱动图运行。

### 2、同步 abort 关闭底层图迭代器

仅从投影的 for 循环中 break，不等于执行了运行对象的完整退出流程。`GraphRunStream.abort()` 会将流标记为耗尽、断开底层迭代器引用，再关闭迭代器与事件分发器：

源码：`libs/langgraph/langgraph/stream/run_stream.py` → `GraphRunStream.abort`（第 155–171 行节选；未展示部分省略）。

```python
if self._exhausted:
    return
self._exhausted = True
graph_iter = self._graph_iter
self._graph_iter = None
if (
    graph_iter is not None
    and (close := getattr(graph_iter, "close", None)) is not None
):
    try:
        close()
    except Exception:
        pass
try:
    self._mux.close()
except Exception:
    pass
```

底层图生成器收到关闭信号后退出 Loop 和执行器上下文，执行取消、等待与清理。同步流对象的 `__exit__()` 也调用 abort，因此在拥有运行流的上下文中退出 with 可以走同一路径。

该方法吞掉关闭过程中的普通异常，并提供重复调用时的空操作；不能把“abort 返回”解释成所有外部工具都已成功撤销。尤其同步线程任务已经开始后，执行器可能仍需等待其结束。跨线程请求在轮次边界停止，可使用[第 03 篇的 RunControl](./03-pregel-supersteps-and-scheduling.md)，不能把同步迭代器的 close 当成通用线程终止接口。

### 3、异步 abort 先取消正在进行的事件拉取

`AsyncGraphRunStream` 是 v3 的异步运行流。另一个协程请求停止时，事件拉取可能正阻塞在节点执行中；仅对仍在运行的异步生成器调用 aclose 不足以完成这一协调。

`abort()` 先在条件锁内标记耗尽、记录正在执行的拉取任务并唤醒等待者，随后取消并等待这次拉取，再关闭底层生成器：

源码：`libs/langgraph/langgraph/stream/run_stream.py` → `AsyncGraphRunStream.abort`（第 507–520 行节选；未展示部分省略）。

```python
if anext_task is not None and not anext_task.done():
    anext_task.cancel()
    try:
        await anext_task
    except (asyncio.CancelledError, Exception):
        pass
if (
    graph_aiter is not None
    and (aclose := getattr(graph_aiter, "aclose", None)) is not None
):
    try:
        await aclose()
    except Exception:
        pass
```

取消拉取会将信号传入正在执行的图；等待它收尾后再 aclose，可以避免一边推进、一边关闭同一个异步生成器。后续还会关闭 Mux，释放受流缓冲限制而等待的写入方；`async with` 的退出同样会等待 abort。整个过程仍要求节点和工具正确响应取消，不能替代远端服务的取消协议。

如果界面希望保留当前轮次结果，应请求 drain 并继续消费到运行受控退出，而不是立刻 abort。drain 的轮次退出见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)，取消与执行器清理见[第 04 篇](./04-pregel-task-execution.md)，停止的应用语义见[第 07 篇](./07-interrupts-and-command.md)。

### 4、事件连接与后台运行需要分别管理

浏览器停止渲染 token 或断开事件连接，只改变消费或传输层。图运行是否随之取消，取决于服务端是否把断线事件传给真实运行任务、运行流或 control。若服务端选择继续后台执行，应保留运行身份供稍后查询；若选择取消，应等待执行清理后再报告终态。这是应用需要制定的策略，普通 stream 接口不会替 HTTP 服务决定。

流事件可以用于界面和日志，但不能代替检查点中的通道版本、任务写入和恢复值。断线后继续显示事件与从保存现场恢复图，是两个需要分别设计的流程。v3 在此源码基线中标为实验性；采用它时应固定版本并验证消费与终止行为，而不只验证 token 能否显示。

## 七、材料处理界面应该依据哪一种信号

| 界面内容 | 可以使用的信号 | 不能直接推出的结论 |
| --- | --- | --- |
| A 正在处理 | 节点开始或 custom 进度 | A 已成功，或进度只会出现一次 |
| 展示 A 的局部结果 | 对应任务的 updates | B 已完成，整轮已经可靠保存 |
| 展示合并后的报告状态 | 正常轮次的 values，加上任务与运行状态 | 所有持久化后台任务已成功 |
| 展示待审批 | 中断记录及业务问题 | 流程已失败，或交付已完成 |
| 显示交付成功 | 业务节点结果与外部系统确认 | 单靠模型输出结束就能验收 |

这是基于框架事件边界的界面设计建议，不是 LangGraph 自带的前端协议。连接丢失后，应根据保存的执行状态和业务结果重新查询进度；最后一条曾经显示过的事件不能替代恢复依据。
