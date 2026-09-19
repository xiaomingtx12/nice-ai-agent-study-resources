---
sidebar_position: 10
sidebar_label: 08 流式输出与事件
description: 区分普通流与事件投影，沿事件产生、消费、abort 和执行器清理解释观察时机、运行取消与连接断开的边界。
---

# LangGraph 源码 08：运行事件如何到达调用方

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 事件出口：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`、`_output()`、`stream_events()`、`_pregel_stream_v3()`。
> - 状态事件：`libs/langgraph/langgraph/pregel/_loop.py` → `output_writes()`、`after_tick()`、`_emit()`。
> - 消息回调：`libs/langgraph/langgraph/pregel/_messages.py` → `StreamMessagesHandler`。
> - v3 消费与退出：`libs/langgraph/langgraph/stream/run_stream.py` → `GraphRunStream._pump_next()`、`GraphRunStream.abort()`、`AsyncGraphRunStream.abort()`；`libs/langgraph/langgraph/stream/_mux.py` → `StreamMux.push()`。

流式输出将图执行过程中的数据交给调用方。不同事件产生于不同时间：模型 token 可以在节点尚未结束时输出，任务更新可以在同轮其他任务未完成时输出，完整状态则通常在轮次提交后输出。**看到事件，不等于看到整轮成功或检查点已经落盘。**

`stream()` 本身也是执行入口，调用方迭代它会推进运行；`invoke()` 只是消费同一执行机制并返回最终结果。选择 mode 决定观察什么，不改变字段 reducer 的含义。

## 一、三个接口层次不能混用版本号

| 入口 | 本文基线下的输出 | 实现路径 |
| --- | --- | --- |
| `stream(version="v1" / "v2")` | 状态、消息或进度片段 | 运行时事件队列 → `_output()` |
| `stream_events(version="v1" / "v2")` | Runnable 事件字典 | 委托父类事件接口 |
| `stream_events(version="v3")` | `GraphRunStream` 运行流对象 | 普通 v2 流 → 协议事件 → 转换器与投影 |

`stream` 的 v2 与 `stream_events` 的 v2 不是同一种事件外形。`GraphRunStream` 则是实验性接口，提供 `values`、`messages` 等可独立消费的投影；它不是普通 stream 的所有 mode 默认都会经过的中间层。

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

Loop 的 `_emit()` 将数据组织成 `(namespace, mode, payload)`，放入流队列。`messages` 通过 `StreamMessagesHandler` 接收模型回调；`custom` 通过运行上下文中的 `stream_writer` 写入同一出口。主循环在 Runner 让出控制权以及轮次结束时排空队列。

这解释了为什么 `updates` 可早于整轮提交：A 完成时就能显示 A 的结果，B 之后仍可能失败。前端若展示“当前已提交状态”，应使用相应的状态视图；若展示“任务进展”，则应保留开始、成功、失败和暂停等区别。

## 三、_output 决定片段形状

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

## 四、custom 进度来自节点主动写入

节点可通过 `get_stream_writer()` 获取当前运行的 writer。下面是应用片段，`load_documents` 是业务函数：

```python
from langgraph.config import get_stream_writer

def retrieve(state):
    writer = get_stream_writer()
    writer({"stage": "retrieving", "query": state["query"]})
    documents = load_documents(state["query"])
    writer({"stage": "retrieved", "count": len(documents)})
    return {"documents": documents}
```

调用方选择 `stream_mode="custom"` 或把 custom 加入 mode 列表。writer 的调用只产生观察事件，真正状态更新仍来自返回值。节点重试或恢复重跑可能再次输出同一进度，所以消费端不能用“一条进度消息只出现一次”作为业务正确性条件。

`messages` 依赖模型适配器及回调上下文，任意第三方 SDK 自己吐出的字节不会自动进入这个模式。流式事件也可能包含上下文或工具结果，业务展示应选择所需字段，不要把 debug 状态直接当作用户界面协议。

## 五、v3 在普通流之上建立类型化投影

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

`convert_to_protocol_event()` 将普通 v2 片段转换为协议事件，`_observe_event()` 更新最终状态与中断记录，`StreamMux.push()` 依注册顺序调用转换器的 `process()`，再按处理结果写入主事件日志。转换器提供的 `StreamChannel` 保存各投影可消费的项目。

迭代一次投影可能需要拉取多个底层事件，不能理解为“一次 next 恰好执行一个节点或一轮”。同步运行流无需额外后台线程来驱动这条拉取链，但节点执行和检查点保存仍可能使用执行器。

## 六、消费、异常与停止也是接口语义

### 1. 获取最终值会继续驱动运行

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

### 2. 同步 abort 关闭底层图迭代器

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

该方法吞掉关闭过程中的普通异常，并提供重复调用时的空操作；不能把“abort 返回”解释成所有外部工具都已成功撤销。尤其同步线程任务已经开始后，执行器可能仍需等待其结束。跨线程请求在轮次边界停止，可使用第 07 篇的 `RunControl`，不能把同步迭代器的 close 当成通用线程终止接口。

### 3. 异步 abort 先取消正在进行的事件拉取

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

如果界面希望保留当前轮次结果，应请求 drain 并继续消费到运行受控退出，而不是立刻 abort。drain 与 abort 的保存、恢复和退出信号区别见[第 07 篇](./07-interrupts-and-command.md)。

### 4. 事件连接与后台运行需要分别管理

浏览器停止渲染 token 或断开事件连接，只改变消费或传输层。图运行是否随之取消，取决于服务端是否把断线事件传给真实运行任务、运行流或 control。若服务端选择继续后台执行，应保留运行身份供稍后查询；若选择取消，应等待执行清理后再报告终态。这是应用需要制定的策略，普通 stream 接口不会替 HTTP 服务决定。

流事件可以用于界面和日志，但不能代替检查点中的通道版本、任务写入和恢复值。断线后继续显示事件与从保存现场恢复图，是两个需要分别设计的流程。v3 在此源码基线中标为实验性；采用它时应固定版本并验证消费与终止行为，而不只验证 token 能否显示。
