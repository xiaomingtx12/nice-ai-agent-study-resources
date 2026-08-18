---
sidebar_position: 4
sidebar_label: 02 Builder 与编译
description: 追踪 StateGraph 如何登记节点和边，compile() 如何生成 CompiledStateGraph(Pregel)，以及三类边分别形成怎样的触发关系。
---

# LangGraph 源码 02：节点和边如何变成可运行图

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - 图声明与编译：`libs/langgraph/langgraph/graph/state.py`（`StateGraph`、`add_node()`、`add_edge()`、`compile()`、`CompiledStateGraph`）
> - 条件路由配置：`libs/langgraph/langgraph/graph/_branch.py`（`BranchSpec`）
> - 节点输出转换：`libs/langgraph/langgraph/pregel/_write.py`（`ChannelWrite`）

## 先抓住一条转换链

`StateGraph` 是构建器——`add_node()`、`add_edge()` 只记录声明。`compile()` 把这些声明安装到可调度的 `CompiledStateGraph(Pregel)`。节点函数要等 `invoke()` 才会执行。

```
StateGraph(...)          创建 Builder 和字段 Channel
add_node / add_edge       登记图声明
compile()                 生成 CompiledStateGraph(Pregel)
invoke()                  交给 Runtime 调度
```

本文讲第二阶段（声明→编译），第三阶段（执行）见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)。

## 一、`add_node()`：登记节点，不运行

```python
builder.add_node("increment", increment)
```

`add_node()` 在 `state.py` 中做了几件事：校验名称不重复且不是保留字；把函数包装成 Runnable（调用 `coerce_to_runnable()`）；确定输入 Schema（优先级：显式传入 > 函数参数标注 > 整图 state_schema）；保存 retry、cache、timeout 策略。

核心流程是输入 Schema 的三级选择：

```python
# libs/langgraph/langgraph/graph/state.py（节选）
if input_schema is not None:
    self.nodes[node] = StateNodeSpec(..., input_schema=input_schema, ...)
elif inferred_input_schema is not None:
    self.nodes[node] = StateNodeSpec(..., input_schema=inferred_input_schema, ...)
else:
    self.nodes[node] = StateNodeSpec(..., input_schema=self.state_schema, ...)
```

`add_node()` 把函数包装为 Runnable、保存 retry/cache/timeout 策略后存入 `self.nodes[node]`。`compile()` 读取后创建 `PregelNode`，再由 `attach_node()` 安装输入 Channel 和 writer。函数本身要等 `invoke()` 才执行。

> `compile()` 之后再调 `add_node()` 不会生效——需要先完成所有声明，再一次性 `compile()`。

## 二、三类边，三种触发关系

### 普通边

```python
builder.add_edge("load", "answer")
```

编译时 `attach_edge()` 给上游装一个 writer，写入 `branch:to:answer`；下游订阅此 Channel，下一轮获得触发资格。这不等于在 `load()` 里直接调 `answer()`，而是"上游完成 → 写入触发信号 → Runtime 准备下游 task"。

### 等待边

```python
builder.add_edge(["search", "profile"], "answer")
```

编译器创建一个 `NamedBarrierValue(str, {"search", "profile"})`（见[第 01 篇](./01-state-schema-channels-and-reducers.md)），两个节点各报到一次，全部到齐后 `answer` 获得触发资格。等待边只管到齐条件，不管结果合并——合并仍由字段 Channel 的 reducer 处理。

### 条件边

```python
def route(state: State) -> str:
    return "tools" if state["needs_tool"] else "answer"


builder.add_conditional_edges("model", route)
```

Builder 把 `route` 包装成 `BranchSpec` 存到 `self.branches`。编译时 `attach_branch()` 做三件事：根据 branch 的输入 Schema 创建 State reader；用 `BranchSpec.run()` 包装路由函数，使其在源节点完成后才被调用；把包装后的 writer 挂到源节点。核心约束：**路由函数读取的是运行时 State，不能用组图阶段的变量预先决定路径。**

`path_map` 或 `Literal` 返回值标注可以让静态分析收窄目标集合，但不是运行时的必须条件。条件边在这里完成声明和编译；节点运行时返回 `Command`，以及 `Send` 如何形成 PUSH task，见[第 04 篇](./04-dynamic-routing-and-send.md)。

## 三、`validate()`：编译前检查图结构

`compile()` 先调 `validate()`，检查四项：

| 检查项 | 校验内容 |
| --- | --- |
| 起点存在 | 边不能从未注册节点出发 |
| 入口存在 | 至少一条从 `START` 出发的路径 |
| 终点存在 | 边不能指向未注册节点 |
| 中断节点 | `interrupt_before/after` 不能引用未知节点 |

校验通过只证明引用关系完整，不保证业务逻辑正确。循环收敛、reducer 语义、外部服务可靠性需要单独验证。

## 四、`compile()`：生成 CompiledStateGraph

`compile()` 创建 `CompiledStateGraph` 并逐一接入 Builder 中登记的所有元素：

```python
# libs/langgraph/langgraph/graph/state.py（节选）
compiled = CompiledStateGraph(
    builder=self,
    channels={**self.channels, **self.managed, START: EphemeralValue(...)},
    checkpointer=checkpointer, store=store, cache=cache,
)

compiled.attach_node(START, None)
for key, node in self.nodes.items():
    compiled.attach_node(key, node)
for start, end in self.edges:
    compiled.attach_edge(start, end)
for starts, end in self.waiting_edges:
    compiled.attach_edge(starts, end)
for start, branches in self.branches.items():
    for name, branch in branches.items():
        compiled.attach_branch(start, name, branch)
return compiled.validate()
```

四次转换：

```text
State 字段  → 编译结果中的 Channel
节点函数    → PregelNode（含输入 Channel、writer、triggers）
固定边      → writer + trigger（普通边）/ barrier（等待边）
条件边      → BranchSpec writer
```

`START` 也被安装为 `EphemeralValue` Channel（见[第 01 篇](./01-state-schema-channels-and-reducers.md)），调用 `invoke(input)` 时输入写入 `START` 触发入口节点，入口跑完自动清空。

`CompiledStateGraph` 继承 `Pregel`，因此编译结果可以直接调用 `invoke()`、`stream()`。

## 五、`attach_node()`：节点如何获得读写能力

`attach_node()` 把一个 `StateNodeSpec` 转为 `PregelNode`：

```python
# libs/langgraph/langgraph/graph/state.py（节选）
self.nodes[key] = PregelNode(
    channels=input_channels,          # 读哪些字段
    triggers=[branch_channel],        # 谁触发它运行
    writers=[ChannelWrite([
        ChannelWriteTupleEntry(mapper=_get_updates),    # 状态写入
        ChannelWriteTupleEntry(mapper=_control_branch),  # 控制信息
    ])],
    bound=node.runnable,              # 实际执行的函数
    retry_policy=node.retry_policy,
    cache_policy=node.cache_policy,
    timeout=node.timeout,
)
```

`branch_channel` 来自边的编译结果——普通边是 `branch:to:<target>`，条件边写入路由决定的 Channel，等待边是 barrier Channel 名（如 `join:search+profile:answer`）。节点订阅这个 Channel，Runtime 在它可读时准备 task。

### 节点读哪些字段、写什么、返回值怎么处理

读：`input_channels` 来自节点的输入 Schema，Runtime 按这个视图组装输入。下面 `search` 只读 `question`，但可以写 `documents`：

```python
class GraphState(TypedDict):
    question: str
    documents: list[str]
    answer: str


def search(state: SearchInput):    # SearchInput 只有 question
    return {"documents": ["..."]}  # 写入 State 中已声明的 documents
```

写：`_get_updates()` 提取返回值中图已知的字段，未知 key 被忽略：

```python
def _get_updates(input):
    if isinstance(input, dict):
        return [(k, v) for k, v in input.items() if k in output_keys]
    elif isinstance(input, Command):
        return [(k, v) for k, v in input._update_as_tuples() if k in output_keys]
```

返回值可选三种——局部 State 更新（`dict`）、本轮不写（`None`）、携带控制信号（`Command`，见[第 04 篇](./04-dynamic-routing-and-send.md)）。节点返回的 dict 不直接改全局 State——它先变成 Runtime writes，在本轮结束后由 `apply_writes()` 更新 Channel（[第 03 篇](./03-pregel-supersteps-and-scheduling.md)）。

## 六、Builder 与编译结果分开维护

| 操作 | 作用对象 | 结果 |
| --- | --- | --- |
| `add_node()` / `add_edge()` | `StateGraph` | 增加待编译声明 |
| `compile()` | `StateGraph` | 生成新的 `CompiledStateGraph` |
| `invoke()` / `stream()` | `CompiledStateGraph` | 执行已编译结构 |

常见错误：`compile()` 后继续调 `add_node()`，复用旧的编译结果——新增节点不会生效。正确做法是先完成 Builder 的所有声明，再一次性 `compile()`。

## 工程判断

- **照搬**：用 `StateGraph` 集中声明节点和边，在编译阶段暴露结构错误（缺入口、未知节点）。
- **换实现**：节点只读少量字段时用专用 `input_schema`，减少无关状态进入节点；需要动态扇出时用条件边返回 `Send`。
- **别碰**：不要在节点里手动调下游节点；不要 `compile()` 后改 Builder 再复用旧图。
- **不适用时**：图结构需频繁变化时，先在构建阶段生成完整 Builder 再统一编译缓存。

## 读完后应该能判断什么

- `add_node()` 保存了哪些配置，输入 Schema 的三级优先级顺序；
- 普通边、等待边、条件边分别形成怎样的触发关系；
- `compile()` 如何把声明安装为可调度的 `CompiledStateGraph(Pregel)`；
- 节点返回的 dict 为什么先成为 Runtime writes 再统一提交；
- Builder（构建期）和编译结果（运行期）为何必须分开管理。
