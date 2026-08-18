---
sidebar_position: 7
sidebar_label: 05 子图：流程复用与状态边界
description: 追踪编译后的子图如何作为 Runnable 接入父图、父子状态边界如何划分、checkpointer 三种语义的区别，以及子图事件如何被观测。
---

# LangGraph 源码 05：子图、流程复用与状态边界

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - 子图作为节点接入：`libs/langgraph/langgraph/graph/state.py`（`CompiledStateGraph` 继承 `Pregel`）
> - 子图持久化：`libs/langgraph/tests/test_subgraph_persistence.py`
> - 子图事件命名空间：`libs/langgraph/langgraph/pregel/main.py`、`libs/langgraph/langgraph/stream/`

## 这一篇的主题

[第 04 篇](./04-dynamic-routing-and-send.md)已经把 `Send`、`Command` 和 `Command.PARENT` 放回同一条控制流；需要复用一段包含多个节点、边和状态规则的流程时，再使用子图。

子图关注的是流程封装：把一段内部结构编译为可调用单元，作为父图的节点接入。本篇追踪三个问题：

1. 子图怎样以 Runnable 身份接入父图；
2. 父子图的状态边界如何划分；
3. checkpointer 三种语义和 streaming namespace 如何选择。

## 一、子图是"编译后的 Runnable"作为节点接入

子图先独立构建和编译，再作为父图的一个节点接入：

```python
child = (
    StateGraph(ChildState)
    .add_node("summarize", summarize)
    .add_edge(START, "summarize")
    .add_edge("summarize", END)
    .compile()
)

parent.add_node("run_child", child)
```

源码中的 `CompiledStateGraph` 继承 `Pregel`：

```python
# libs/langgraph/langgraph/graph/state.py:1391-1407
class CompiledStateGraph(
    Pregel[StateT, ContextT, InputT, OutputT],
    Generic[StateT, ContextT, InputT, OutputT],
):
    def __init__(
        self,
        *,
        builder: StateGraph[StateT, ContextT, InputT, OutputT],
        schema_to_mapper: dict[type[Any], Callable[[Any], Any] | None],
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.builder = builder
        self.schema_to_mapper = schema_to_mapper
```

`Pregel` 提供 Runnable 的调用接口（`invoke()`、`stream()` 等），所以编译后的子图可以作为节点执行。父图接入子图时仍有一个输入边界：

- 子图的输入 Schema 决定它需要哪些输入字段；
- 子图返回的更新要符合父图字段的写入规则；
- 父子字段名或结构不匹配时，需要显式 adapter（适配层）。

### 父子状态边界：通过包装节点映射字段

如果父图只有 `article`，子图接收 `text`，就把映射写在父节点中：

```python
def run_child(state: ParentState):
    result = child.invoke({"text": state["article"]})
    return {"summary": result["summary"]}


parent.add_node("run_child", run_child)
```

这个适配层把数据边界写清楚：父图的 `article` 进入子图的 `text`，子图的 `summary` 回到父图的 `summary`。子图复用的是执行结构和状态视图，不提供进程或权限隔离。

直接以编译后的子图作为节点时，`add_node()` 看到的是一个 `Runnable`。`coerce_to_runnable()`（统一 Runnable 包装函数，见[第 02 篇](./02-stategraph-builder-and-compilation.md)）的第一条分支 `isinstance(thing, Runnable)` 直接命中，不需要额外包装。

## 二、子图 checkpointer 决定状态保留范围

`checkpointer` 是 checkpoint saver（检查点保存器）的配置。子图支持三种实际语义：

| 配置 | 当前调用中的 interrupt/resume | 多次父图调用之间 |
| --- | --- | --- |
| `False` | 不使用持久化 | 不保留子图状态，即使父图配置了 checkpointer |
| `None` | 可继承父图的 checkpointer 支持当前调用恢复 | 默认不积累子图自身 State，下次调用从干净状态开始 |
| `True` | 使用子图自己的持久化边界 | 同一个 `thread_id` 下保留并积累子图 State |

本地测试文件直接给出了这三种语义：

```python
# libs/langgraph/tests/test_subgraph_persistence.py:1-8
# checkpointer=False: no persistence, even when parent has a checkpointer
# checkpointer=None (default): "stateless" — inherits parent checkpointer for
# interrupt support, but state resets each invocation.
# checkpointer=True: "stateful" — state accumulates across invocations on the
# same thread id
```

`stateless` 指无跨调用状态积累；`stateful` 指同一线程标识下保留子图状态。它们描述子图的持久化范围，不描述子图是否能执行。

### 什么时候选哪种

- 子图只是一次性的内部流程 → `None`（默认），依赖父图的 checkpointer 处理中断恢复即可；
- 子图需要独立记住历史 → `True`，调用使用稳定的 `thread_id`；
- 子图要隔离父图的持久化 → `False`；
- 需要 interrupt/resume 时，父图本身仍必须配置 checkpointer。

跨图控制不在子图层重新定义一套调用方式：子图节点返回 `Command(graph=Command.PARENT, ...)` 时，由父图边界接收并校验。`Command.PARENT` 的字段处理和 `ParentCommand` 路径见[第 04 篇](./04-dynamic-routing-and-send.md)。

## 三、子图 streaming 的 namespace 嵌套

当父图配置 `subgraphs=True` 进行流式输出时，子图事件会携带 namespace（命名空间路径）：

```python
for chunk in graph.stream(
    input_data, config,
    stream_mode="updates",
    subgraphs=True,
):
    print(chunk)
    # ((parent_node,), "updates", {"child_key": "child_value"})
    # ((parent_node, child_node), "updates", {"key": "value"})
```

第一个元组是 namespace，沿父图→子图的调用路径逐层拼接。这允许调用方定位事件来自哪张图、哪个节点。

## 四、选择：子图还是普通节点

| 判据 | 子图 | 普通节点 |
| --- | --- | --- |
| 流程复杂度 | 内部有多节点、多边和独立状态视图 | 单一函数足够 |
| 状态边界 | 需要独立 State Schema | 使用父图 State 即可 |
| 复用范围 | 同一仓库多处或跨项目使用 | 单图内使用 |
| 可观测性 | 子图内部事件可独立追踪 | 只有节点事件 |
| 持久化 | 可独立选择 checkpointer 策略 | 依赖父图 |

父子 Schema 已经复杂到需要频繁双向转换时，先评估是否应拆成普通节点和显式数据边界，避免子图层级掩盖状态流向。

## 工程判断

- **照搬**：把子图编译为 `CompiledStateGraph`，通过包装节点或直接接入父图；用 adapter 显式处理父子字段映射。
- **换实现**：需要子图独立恢复历史时使用 `checkpointer=True`；子图内部节点多、状态规则复杂但只需要父图统一管理持久化时使用默认 `None`。
- **别碰**：不要在子图节点函数里手动调用父图节点；不要把子图当作进程或权限隔离边界。
- **不适用时**：父子 Schema 映射层已经比子图内部逻辑更复杂时，评估是否用普通节点 + 显式数据函数替代子图。

## 读完后应该能判断什么

- 编译后的子图为什么能作为 Runnable 接入父图；
- `checkpointer=False`、`None`、`True` 分别保留哪一层状态；
- 跨图控制为什么必须由父图边界接收和校验，具体机制见[第 04 篇](./04-dynamic-routing-and-send.md)；
- 子图 streaming 事件的 namespace 如何沿调用路径嵌套；
- 什么时候用子图，什么时候用普通节点。
