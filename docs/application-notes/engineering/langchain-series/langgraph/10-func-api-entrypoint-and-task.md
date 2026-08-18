---
sidebar_position: 12
sidebar_label: 10 Func API：函数式工作流
description: 拆解 @entrypoint 与 @task 装饰器如何替代 StateGraph 声明式写法，内部如何组装 Pregel 图，以及 entrypoint.final 的解耦机制。
---

# LangGraph 源码 10：Func API —— 函数式工作流定义

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - `@entrypoint` 和 `@task` 装饰器：`libs/langgraph/langgraph/func/__init__.py`
> - 内部 Runnable 包装：`libs/langgraph/langgraph/pregel/_call.py`（`get_runnable_for_entrypoint()`）
> - 通道与节点创建：直接依赖 `Pregel`、`PregelNode`、`ChannelWrite`、`EphemeralValue`、`LastValue`

## 这一篇的主题

前 09 篇文章建立了一条完整的知识链：从 State 字段声明（01）到图编译（02）到 Pregel 调度（03）到路由（04）、子图（05）、持久化（06）、中断（07）、流式（08）和工具层（09）。这条路最终走到了 "Func API"——一种**用函数定义替代显式 `StateGraph` 构建**的写法：

> **`@entrypoint` 和 `@task` 不是新的运行时，而是把前面讲的 StateGraph + Pregel + Channel 全部封装进了装饰器语法。**

## 一、传统写法 vs Func API

传统写法需要显式构建 StateGraph：

```python
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph


class State(TypedDict):
    count: int


def increment(state: State):
    return {"count": state["count"] + 1}


builder = StateGraph(State)
builder.add_node("increment", increment)
builder.add_edge(START, "increment")
builder.add_edge("increment", END)
graph = builder.compile()
result = graph.invoke({"count": 0})  # {"count": 1}
```

Func API 的等价写法：

```python
from langgraph.func import entrypoint, task


@task
def increment_task(count: int) -> int:
    return count + 1


@entrypoint()
def my_workflow(count: int) -> int:
    future = increment_task(count)
    return future.result()


result = my_workflow.invoke(0)  # 1
```

表面上看只是语法糖。但 `@task` 返回的是 Future，这意味着**可以在函数体内创建多个并行任务**。

## 二、`@task`：函数调用返回 Future

`@task` 装饰器的核心逻辑在 `_TaskFunction.__call__()`：

```python
# libs/langgraph/langgraph/func/__init__.py:86-94
def __call__(self, *args: P.args, **kwargs: P.kwargs) -> SyncAsyncFuture[T]:
    return _call_with_options(
        self.func,
        args,
        kwargs,
        retry_policy=self.retry_policy,
        cache_policy=self.cache_policy,
        timeout=self.timeout,
    )
```

调用被 `@task` 装饰的函数不会立即执行，而是返回 `SyncAsyncFuture`。这个 Future 在 `entrypoint` 的运行上下文中被解析——Runtime 会为每个 task 创建独立的 Pregel task，支持并行执行和独立重试。

```python
@entrypoint()
def parallel_workflow(numbers: list[int]) -> list[int]:
    # 所有的 increment_task 调用会并行执行
    futures = [increment_task(n) for n in numbers]
    results = [f.result() for f in futures]
    return results
```

异步版本：

```python
@entrypoint()
async def async_workflow(numbers: list[int]) -> list[int]:
    futures = [increment_task(n) for n in numbers]
    return await asyncio.gather(*futures)
```

`@task` 配置与 `add_node()` 对应：

| `@task` 参数 | 对应 `add_node()` | 作用 |
| --- | --- | --- |
| `retry_policy` | `retry_policy` | 任务失败重试策略 |
| `cache_policy` | `cache_policy` | 根据输入缓存任务结果 |
| `timeout` | `timeout` | 任务超时控制（仅异步） |
| `name` | 节点名 | 显式指定任务名 |

## 三、`@entrypoint`：一行创建 Pregel 图

`@entrypoint.__call__()` 是整个 Func API 的核心。它接收一个函数，内部直接构造 `Pregel` 图：

```python
# libs/langgraph/langgraph/func/__init__.py:576-609（节选）
graph: Pregel[Any, ContextT, Any, Any] = Pregel(
    nodes={
        func.__name__: PregelNode(
            bound=bound,
            triggers=[START],
            channels=START,
            timeout=self.timeout,
            writers=[
                ChannelWrite(
                    [
                        ChannelWriteEntry(END, mapper=_pluck_return_value),
                        ChannelWriteEntry(PREVIOUS, mapper=_pluck_save_value),
                    ]
                )
            ],
        )
    },
    channels={
        START: EphemeralValue(input_type),
        END: LastValue(output_type, END),
        PREVIOUS: LastValue(save_type, PREVIOUS),
    },
    input_channels=START,
    output_channels=END,
    stream_channels=END,
    stream_mode="updates",
    stream_eager=True,
    checkpointer=self.checkpointer,
    store=self.store,
    ...
)
```

这段代码直接把前 02 篇的 Builder 模式和 03 篇的 Pregel 拼在了一起：

1. **节点**：一个 `PregelNode`，`bound` 是包装后的用户函数，触发源是 `START`
2. **Channel**：`EphemeralValue` 接收输入（临时值通道，详见[第 01 篇](./01-state-schema-channels-and-reducers.md)），`LastValue` 保存输出和持久化值
3. **Writer**：`ChannelWrite` 把函数返回值写入 `END`，把持久化值写入 `PREVIOUS`
4. **基础设施**：checkpointer、store、cache 直接传给 Pregel

所以 `@entrypoint` 不是新运行时——它就是前面的知识链的一层薄封装。

### 注入参数

装饰的函数可以请求注入 `config`、`previous` 和 `runtime`：

| 参数 | 注入来源 | 作用 |
| --- | --- | --- |
| `config` | `RunnableConfig` | 运行配置（thread_id 等） |
| `previous` | checkpoint 中的上次返回值 | 同一 thread_id 的跨调用状态 |
| `runtime` | `Runtime` | 运行期上下文（context、store、stream_writer） |

## 四、`entrypoint.final`：解耦返回值与保存值

传统 StateGraph 中，节点返回什么就更新什么到 State。`entrypoint.final` 允许分开：

```python
# libs/langgraph/langgraph/func/__init__.py:475-514
@dataclass
class final(Generic[R, S]):
    value: R  # 返回给调用方
    save: S   # 保存到 checkpoint，下次作为 previous
```

使用：

```python
@entrypoint(checkpointer=InMemorySaver())
def my_workflow(number: int, *, previous: Any = None) -> entrypoint.final[int, int]:
    previous = previous or 0
    return entrypoint.final(value=previous, save=2 * number)


config = {"configurable": {"thread_id": "some_thread"}}
my_workflow.invoke(3, config)  # 0 (previous 为 None)
my_workflow.invoke(1, config)  # 6 (previous = 3*2)
```

这个机制解决了"调用方需要旧值、但下次执行需要新值"的需求。内部实现是两个 `ChannelWriteEntry`：一个 mapper 取 `value` 写入 `END`（返回值），一个 mapper 取 `save` 写入 `PREVIOUS`（持久化）。

## 五、与传统 StateGraph 的取舍

| 判据 | Func API | StateGraph |
| --- | --- | --- |
| 图结构 | 单节点 + 隐式子任务 | 多节点 + 显式边 |
| 控制流 | 函数体内的 if/for | 条件边、Send、等待边 |
| 并行 | `f.result()` 隐式并行 | 显式 `Send` 或并行边 |
| 可观测性 | stream_mode="updates" | 每种 stream mode 可用 |
| 复杂度上限 | 函数体内的逻辑复杂度 | 图的结构复杂度 |
| 适用场景 | 线性或简单并行的流程 | 复杂路由、多分支、子图 |

一个有明确分支、多轮工具调用、人工审批的 Agent 流程，用 StateGraph 更清晰。一个数据处理 pipeline（读入→转换→输出），Func API 更简洁。

## 六、checkpointer 与中断支持

`@entrypoint(checkpointer=...)` 启用持久化后，`interrupt()` 和 `Command(resume=...)` 同样可用：

```python
from langgraph.types import interrupt, Command


@entrypoint(checkpointer=InMemorySaver())
def review_workflow(topic: str) -> dict:
    essay_future = compose_essay(topic)
    essay = essay_future.result()
    human_review = interrupt({
        "question": "Please provide a review",
        "essay": essay,
    })
    return {"essay": essay, "review": human_review}


config = {"configurable": {"thread_id": "1"}}
for result in review_workflow.stream(topic, config):
    print(result)
# 中断后恢复
for result in review_workflow.stream(Command(resume="Great!"), config):
    print(result)
```

`compose_essay` task 的结果会被 checkpointer 缓存，恢复后不会重新执行。这和[第 07 篇](./07-interrupts-and-command.md)的机制完全一致。

## 工程判断

- **照搬**：线性或简单并行流程用 Func API；复杂路由、多轮 Agent 循环用 StateGraph。
- **换实现**：需要独立恢复和重试的任务用 `@task` 封装；需要跨调用状态用 `checkpointer` + `entrypoint.final`。
- **别碰**：不要把 Func API 当作"更简单的 StateGraph"——当流程出现四个以上的分支时，显式 StateGraph 更容易追踪和调试。
- **不适用时**：需要多节点、多条件边、Subgraph 嵌套时，StateGraph 提供了更完整的控制和可观测性。

## 读完后应该能判断什么

- `@entrypoint` 如何在内部组装 Pregel 图（节点、Channel、Writer）；
- `@task` 如何让函数调用返回 Future 并支持并行；
- `entrypoint.final` 如何解耦返回值与 checkpoint 保存值；
- Func API 与 StateGraph 的取舍边界。
