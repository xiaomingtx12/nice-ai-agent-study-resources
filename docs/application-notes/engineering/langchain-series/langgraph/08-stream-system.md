---
sidebar_position: 10
sidebar_label: 08 流式输出与事件系统
description: 追踪 LangGraph 的 7 种 StreamMode、Transformer 转换链路、v3 GraphRunStream 的调用方驱动模型，以及自定义事件如何穿过 Runtime。
---

# LangGraph 源码 08：流式输出与事件系统

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - `stream()` 与 `stream_events()` 入口：`libs/langgraph/langgraph/pregel/main.py`
> - 七种 Transformer：`libs/langgraph/langgraph/stream/transformers.py`
> - 流通道：`libs/langgraph/langgraph/stream/stream_channel.py`
> - v3 运行流：`libs/langgraph/langgraph/stream/run_stream.py`
> - 多路复用：`libs/langgraph/langgraph/stream/_mux.py`

## 这一篇的主题

[第 07 篇](./07-interrupts-and-command.md)讲图的暂停与恢复——状态从哪里停下来、怎样继续。本篇讲图的观察——运行过程怎样被调用方看见：

> **`stream()` 和 `stream_events()` 提供了七种观察模式，从 State 快照到模型 token 到自定义进度。v3 协议让调用方的迭代直接驱动图推进。**

流式数据是运行过程的投影，不是恢复状态的来源。中断恢复仍依赖[第 06 篇](./06-checkpoints-store-and-recovery.md)的 checkpointer。

## 一、`stream()`：选择要观察的运行数据

`stream()` 是 Runtime 的观察出口。源码支持这些 `stream_mode`：

```python
# libs/langgraph/langgraph/types.py:121-133
StreamMode = Literal[
    "values",
    "updates",
    "checkpoints",
    "tasks",
    "debug",
    "messages",
    "custom",
]
```

| 想观察什么 | `stream_mode` | 适合场景 |
| --- | --- | --- |
| 每轮完整 State | `values` | 状态面板、过程展示 |
| 节点或 task 的局部更新 | `updates` | 流程 UI、节点追踪 |
| 模型消息 token | `messages` | 对话逐 token 输出 |
| 节点主动写出的进度 | `custom` | 检索、解析、外部调用进度 |
| checkpoint 创建事件 | `checkpoints` | 持久化观测 |
| task 启动、完成和错误 | `tasks` | 运行诊断 |
| checkpoint 与 task 的组合调试信息 | `debug` | 排障 |

多个 mode 时，v1 以 `(mode, data)` 形式输出；v2 使用带 `type`、`ns` 和 `data` 的结构化流片段。

`stream()` 的完整签名：

```python
# libs/langgraph/langgraph/pregel/main.py:2655-2671
def stream(
    self,
    input: InputT | Command | None,
    config: RunnableConfig | None = None,
    *,
    context: ContextT | None = None,
    stream_mode: StreamMode | Sequence[StreamMode] | None = None,
    output_keys: str | Sequence[str] | None = None,
    interrupt_before: All | Sequence[str] | None = None,
    interrupt_after: All | Sequence[str] | None = None,
    subgraphs: bool = False,
    version: Literal["v1", "v2"] = "v1",
    ...
) -> Iterator[dict[str, Any] | Any]:
```

`subgraphs=True` 时，事件增加 namespace（命名空间路径），用于定位父图节点和子图节点：

```python
for chunk in graph.stream(
    {"draft": "release plan", "approved": False},
    config,
    stream_mode=["updates", "messages"],
    subgraphs=True,
):
    print(chunk)
    # ((parent_node,), "updates", {"child_key": "child_value"})
    # ((parent_node, child_node), "updates", {"key": "value"})
```

### 自定义进度：`stream_mode="custom"`

通过 `StreamWriter` 写入 custom mode：

```python
def retrieve(state: State, *, stream_writer):
    stream_writer({"stage": "retrieving"})
    return {"documents": load_documents(state["query"])}
```

`custom` 数据来自节点主动写入，Runtime 不会替节点解释业务含义。`StreamWriter` 来自运行上下文注入（`get_stream_writer()`），与 `config` 和 `runtime` 属于同一注入机制。

## 二、Stream Transformer：每种 mode 背后的转换器

`libs/langgraph/langgraph/stream/transformers.py` 定义了七种 Transformer，每种负责把 Pregel 原始事件转换成对应 stream mode 的输出：

| Transformer | 对应 mode | 作用 |
| --- | --- | --- |
| `ValuesTransformer` | `values` | 捕获每轮 State 快照，形成可排空的流 |
| `UpdatesTransformer` | `updates` | 捕获节点或 task 产生的局部更新 |
| `MessagesTransformer` | `messages` | 捕获模型流式消息的 token 级别输出 |
| `CustomTransformer` | `custom` | 捕获节点通过 `StreamWriter` 写入的业务事件 |
| `CheckpointsTransformer` | `checkpoints` | 捕获 Saver 创建的 checkpoint 事件 |
| `TasksTransformer` | `tasks` | 捕获 task 启动、完成和错误生命周期 |
| `DebugTransformer` | `debug` | 组合 checkpoint 和 task 的调试信息 |
| `LifecycleTransformer` | — | 捕获图的开始、结束、中断等生命周期事件 |
| `SubgraphTransformer` | — | 包装子图事件，注入 namespace |

所有 Transformer 都继承 `StreamTransformer`，它定义了统一的事件处理接口：

```python
# libs/langgraph/langgraph/stream/_types.py
class StreamTransformer:
    _native: bool = False  # 是否直接暴露为 run stream 的属性
    required_stream_modes: tuple[str, ...] = ()  # 需要 Pregel 开启哪些 stream_mode

    def __init__(self, scope: tuple[str, ...] = ()) -> None:
        self.scope = scope  # 当前 transformer 所属的命名空间范围

    def on_event(self, event: ProtocolEvent) -> None:
        """处理一个协议事件。"""
        raise NotImplementedError

    def drain(self) -> Iterator[Any]:
        """排空累积的输出。"""
        raise NotImplementedError
```

`_native = True` 的 Transformer 会在 v3 的 `GraphRunStream` 上暴露为直接属性（如 `run.values`、`run.messages`）。

### 转换链路

Pregel 在运行时产生原始事件（task 完成、checkpoint 创建、消息 chunk），送入 `StreamMux`（多路复用器）。Mux 按事件类型分发给注册的 Transformer，每个 Transformer 独立处理自己关心的模式：

```text
Pregel 原始事件
  → StreamMux 多路分发
  → ValuesTransformer  (mode="values")
  → UpdatesTransformer (mode="updates")
  → MessagesTransformer (mode="messages")
  → ...
  → 各 Transformer 输出被收集
  → 返回给调用方
```

## 三、事件流不会替代恢复

`stream()` 输出的是执行过程中的观察数据。它不会改变节点调度、字段提交或 checkpoint 的保存顺序。

```text
节点执行
  → task writes
  → apply_writes()
  → checkpoint
  → stream 输出对应事件
```

客户端保留 stream chunk 只能用于展示或日志。中断恢复仍依赖[第 06 篇](./06-checkpoints-store-and-recovery.md)的 checkpointer、`thread_id` 和 checkpoint。

## 四、`stream_events(version="v3")`：调用方驱动的实验性协议

当前源码将 `stream_events()` 分成两类：

- `version="v1"` / `"v2"`：返回 `StreamEvent` 字典迭代器；
- `version="v3"`：返回调用方驱动的 `GraphRunStream`。

源码明确将 v3 标为 experimental（实验性）：

```python
# libs/langgraph/langgraph/pregel/main.py:3638-3659
def stream_events(
    self,
    input: InputT | Command | None,
    config: RunnableConfig | None = None,
    *,
    version: Literal["v1", "v2", "v3"] = "v2",
    ...
) -> Any:
    """Stream events from this graph.

    For `version="v1"` / `"v2"`, yields `StreamEvent` dicts.
    For `version="v3"`, returns a `GraphRunStream` whose typed
    projections the caller drives by iterating — no background thread.

    !!! warning
        The `version="v3"` API is experimental and may change.
    """
```

对应的 `GraphRunStream` 说明了驱动方式：

```python
# libs/langgraph/langgraph/stream/run_stream.py:36-45
@beta(message="The v3 streaming protocol on Pregel is experimental.")
class GraphRunStream:
    """Sync run stream with caller-driven pumping.

    The caller's iteration on any projection drives the graph forward.
    Projections are single-consumer.
    """
```

v3 的几个关键点：

- 调用方迭代 projection（投影）时，图才继续推进——不需要后台线程；
- projection 默认单消费者，迭代两次会抛异常；
- 需要多个消费者时使用 `projection.tee(n)`；
- v3 自己管理 `stream_mode` 和子图 namespace，调用方不能再覆盖这两个参数。

### v3 的使用示例

```python
run = graph.stream_events(input, config, version="v3")

# 迭代 values 投影，每次迭代驱动图向前一步
for snapshot in run.values:
    print(snapshot)

# 最终输出
result = run.output
```

生产代码需要稳定协议时，优先使用常规 `stream()` 或 v1/v2 `stream_events()`，将 v3 作为实验性能力单独评估。

## 五、选择表

| 需求 | 优先选择 |
| --- | --- |
| UI 展示完整 State 变化 | `stream_mode="values"` |
| UI 展示节点增量 | `stream_mode="updates"` |
| UI 展示模型 token | `stream_mode="messages"` |
| 展示业务处理进度 | `stream_mode="custom"` |
| 观测持久化时机 | `stream_mode="checkpoints"` |
| 排查任务生命周期 | `stream_mode="tasks"` 或 `"debug"` |
| 需要调用方驱动图推进 | `stream_events(version="v3")` |

## 工程判断

- **照搬**：根据观察目的选择对应的 `stream_mode`；生产环境用 v1/v2 的稳定协议。
- **换实现**：长时间运行的任务用 `stream_mode="custom"` 暴露阶段性进度；需要多个消费者时使用 v3 的 `tee(n)`。
- **别碰**：不要把 stream 数据当作恢复状态；不要在 Transformer 里修改 State。
- **不适用时**：只拿最终结果用 `invoke()`；只需要最终 State 不需要过程观察时不要开 stream。

## 读完后应该能判断什么

- 七种 `stream_mode` 分别观察什么维度的运行数据；
- Stream Transformer 的转换链路：Pregel 事件 → Mux 分发 → Transformer → 输出；
- v3 `GraphRunStream` 如何让调用方迭代驱动图推进；
- `subgraphs=True` 时 namespace 如何沿调用路径嵌套；
- stream 数据为什么不能替代 checkpoint 恢复。
