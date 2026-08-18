---
sidebar_position: 7
sidebar_label: 05 State、Graph 与运行时边界
description: 沿 Agent State 穿过输入、内部执行和输出三道边界，解释默认字段、Schema 合并、节点更新、模型工具循环和图编译参数。
---

# LangChain 源码 05：State、Graph 与运行时边界

## 源码定位

> **阅读基线**：`langchain` 1.3.7，源码位于 `libs/langchain_v1/`；LangGraph 作为 `langchain` 的依赖包使用。
>
> **本篇范围**：专门解释 LangChain 侧 Agent State 如何定义、合并并交给 LangGraph 建图。LangGraph 只作为被导入和调用的依赖包出现，不追踪其仓库内部实现；03 讲工厂如何组装 Agent 图，04 讲 Middleware 的执行边界。
>
> **核心包与路径**：
>
> 1. `langchain.agents.middleware.types`：`libs/langchain_v1/langchain/agents/middleware/types.py`
>    - `AgentState`、`_InputAgentState`、`_OutputAgentState`
>    - `OmitFromSchema`、`OmitFromInput`、`OmitFromOutput`、`PrivateStateAttr`
>    - **作用**：定义默认状态和可见性标记。`_InputAgentState`、`_OutputAgentState` 主要用于工厂的泛型标注；实际传给图的输入、输出 Schema 由工厂动态合成。
> 2. `langchain.agents.factory`：`libs/langchain_v1/langchain/agents/factory.py`
>    - `_resolve_schemas()`
>    - `StateGraph(...)` 初始化
>    - `model_to_tools`、`tools_to_model` 条件边
>    - `checkpointer`、`store`、`cache`、`interrupt_*` 传入 `graph.compile()`
>    - **作用**：把 LangChain 侧的状态协议、节点和运行参数交给 LangGraph 依赖包。
> 3. LangGraph 依赖包：`langgraph`
>    - **作用**：提供 `StateGraph`、`Send`、`Command`、`END` 等 API，承接建图、路由和编译。
>    - **阅读方式**：只确认 LangChain 如何导入和调用这些 API；不把 LangGraph 包内部源码作为本系列阅读范围。
> 4. LangGraph Checkpoint 依赖包：`langgraph-checkpoint`
>    - **作用**：通过 `checkpointer` 参数提供状态持久化和恢复能力。
>    - **阅读方式**：只看 LangChain 如何传入它，不展开 Saver 的具体实现。

## 先画出 State 的边界

这里的 State 不是模型上下文的另一个名字。它是图节点之间共享的数据协议，同时决定哪些数据能进入 Agent、哪些数据只在图内流转、哪些结果最终返回给调用方：

```text
调用输入
  → Input Schema
  → 内部 Agent State
  → 节点更新与 Reducer 合并
  → Output Schema
  → 调用结果
```

LangChain 负责定义字段、可见性和更新协议，再把它们交给 LangGraph 建图和执行。本文只追踪 LangChain 如何做这件事，不展开 LangGraph 内部的调度实现。

## 一、默认 Agent State 有什么

默认状态定义在 `middleware/types.py`：

```python
class AgentState(TypedDict, Generic[ResponseT]):
    # 对话和工具协议的主状态，使用消息合并器处理节点更新。
    messages: Required[Annotated[list[AnyMessage], add_messages]]
    # 只服务当前图路由，不作为输入输出暴露。
    jump_to: NotRequired[
        Annotated[JumpTo | None, EphemeralValue, PrivateStateAttr]
    ]
    # 结构化结果由 Agent 产出，调用者不需要把它作为输入传回。
    structured_response: NotRequired[
        Annotated[ResponseT, OmitFromInput]
    ]


class _InputAgentState(TypedDict):
    # 输入侧只接受消息；内部控制字段由工厂和 Middleware 产生。
    messages: Required[Annotated[list[AnyMessage | dict[str, Any]], add_messages]]


class _OutputAgentState(TypedDict, Generic[ResponseT]):
    # 输出保留消息和结构化结果，不暴露内部跳转信号。
    messages: Required[Annotated[list[AnyMessage], add_messages]]
    structured_response: NotRequired[ResponseT]
```

`AgentState` 是默认的内部状态基类；`_InputAgentState` 和 `_OutputAgentState` 只是工厂泛型中使用的默认形状。`create_agent()` 不会直接把这两个私有类型传给 `StateGraph`，而是结合 Middleware 和调用方的 `state_schema` 动态生成 `input_schema`、`output_schema`。

默认字段各自承担一项职责：

| 字段 | 作用 | 默认可见性 |
| --- | --- | --- |
| `messages` | 保存用户消息、模型消息和工具结果 | 输入输出都可见 |
| `jump_to` | Middleware 请求有限路由 | 内部字段 |
| `structured_response` | 保存结构化输出 | 不作为输入，作为输出 |

### `messages` 是协议字段

`messages` 使用 `add_messages` 作为字段元数据。对 LangChain 侧来说，重要结论是：

- 节点返回 `{"messages": [...]}` 是一次局部更新；
- 它不等于在节点里重新赋值整个对话列表；
- 工具结果必须和原始工具调用保持 `tool_call_id` 配对；
- Middleware 不应通过拼接字符串模拟工具协议。

消息具体如何合并由 LangGraph 依赖包提供的 `add_messages` 处理。本文只关注 LangChain 为什么把它声明在 `AgentState` 上。

### `jump_to` 是控制字段，不是业务状态

`jump_to` 同时携带：

```python
# EphemeralValue 表示临时值；PrivateStateAttr 表示不暴露给调用方。
EphemeralValue
PrivateStateAttr
```

这表达了两个意图：

- 它服务当前路由，不应该像消息历史一样持续累积；
- 它只供图内部使用，不应该暴露给 Agent 调用方。

`jump_to` 的 Hook 使用方式和白名单控制见 04。

### `structured_response` 是输出字段

结构化结果需要在图内部暂存，但调用方通常只希望从输出中读取它。因此它使用 `OmitFromInput`：

- 内部 State 保留；
- 输入 Schema 隐藏；
- 输出 Schema 保留。

这比把结构化结果塞回最后一条文本消息更稳定，也让调用方不需要重新解析模型文本。

## 二、State 如何形成三套 Schema

默认 State 只是内部字段的起点。工厂还要把它拆成三套边界不同的 Schema：

```text
内部 State Schema
  节点和 Middleware 实际可以读写的全部字段

Input Schema
  调用者允许传入的字段

Output Schema
  调用者可以从 Agent 结果中读取的字段
```

三套 Schema 不能简单共用一个 `TypedDict`。内部控制字段、结构化结果和 Middleware 私有账本，往往不应该同时出现在输入和输出中。工厂通过 `_resolve_schemas()` 生成三套 `TypedDict`，并把自定义 Middleware 与应用 `state_schema` 中符合可见性规则的字段合并进去。

一次调用经过的边界可以画成：

```text
调用输入
  → Input Schema 过滤
  → 内部 State
  → Output Schema 过滤
  → 调用结果
```

## 三、Schema 的合并顺序

三套 Schema 来自同一组状态定义，但合并顺序会决定同名字段采用哪一个定义。工厂先选择基础状态：

```python
# 调用方显式传入的 state_schema 是基础 Schema；没传时使用 AgentState。
base_state = state_schema if state_schema is not None else AgentState
```

合并顺序如下：

```python
# Middleware Schema 先合并，基础 Schema 最后覆盖同名字段。
state_schemas: list[type] = [
    *(m.state_schema for m in middleware),
    base_state,
]

resolved_state_schema, input_schema, output_schema = _resolve_schemas(
    state_schemas
)
```

`_resolve_schemas()` 的核心规则是：

```python
# 同一组 Schema 分别生成内部 State、Input Schema 和 Output Schema。
def _resolve_schemas(schemas: list[type]) -> tuple[type, type, type]:
    schema_hints = {
        schema: _get_schema_type_hints(schema)
        for schema in schemas
    }
    return (
        _resolve_schema(schema_hints, "StateSchema", None),
        _resolve_schema(schema_hints, "InputSchema", "input"),
        _resolve_schema(schema_hints, "OutputSchema", "output"),
    )
```

字段按顺序合并，同名字段由后面的定义覆盖前面的定义。因此，调用方的 `state_schema` 可以覆盖 Middleware 的同名字段，后注册的 Middleware 也会覆盖先注册的 Middleware。内部 State 保留合并后的字段，输入和输出 Schema 再根据 `OmitFromSchema` 元数据过滤。

## 四、字段可见性由注解决定

合并顺序确定字段定义后，注解中的可见性标记再决定字段能否穿过调用边界。源码定义了三个常用标记：

```python
@dataclass
class OmitFromSchema:
    # 两个标记分别控制字段是否从输入和输出 Schema 中剔除。
    input: bool = True
    output: bool = True


OmitFromInput = OmitFromSchema(input=True, output=False)
OmitFromOutput = OmitFromSchema(input=False, output=True)
PrivateStateAttr = OmitFromSchema(input=True, output=True)
```

三个标记的区别如下：

| 标记 | 内部 State | 调用输入 | 调用输出 | 用途 |
| --- | --- | --- | --- | --- |
| 无标记 | 保留 | 保留 | 保留 | 普通业务状态 |
| `OmitFromInput` | 保留 | Input Schema 会过滤该字段 | 保留 | `structured_response` |
| `OmitFromOutput` | 保留 | 保留 | Output Schema 会过滤该字段 | 只服务输入或内部流程的字段 |
| `PrivateStateAttr` | 保留 | Input Schema 会过滤该字段 | Output Schema 会过滤该字段 | `jump_to`、内部控制字段 |

这里的“隐藏”不只是序列化时少显示一个键。字段被 Input Schema 过滤后，即使调用方在 `invoke()` 输入中提交它，它也不会作为初始内部 State 传给节点；字段被 Output Schema 过滤后，内部 Middleware 仍可读写它，只是调用结果不包含它。`OmitFromInput` 字段也可以由 Middleware 在图内写入，随后出现在输出中。

工程上不要把“是否让调用方看到”交给节点实现临时判断。它应该写进状态 Schema 的类型元数据，让工厂在装配期统一生成边界。

## 五、节点如何更新 State

### 节点返回的是局部更新

边界确定后，节点只需要返回本次执行产生的局部更新：

```python
def before_model(self, state, runtime):
    # 只返回本次 Hook 改变的字段，未返回的字段继续保留。
    return {
        "model_calls": state.get("model_calls", 0) + 1,
    }
```

下面两种写法的语义不同：

```python
# 推荐：只声明本次节点要改变的字段。
return {"model_calls": next_count}

# 不推荐：节点不应该复制和重建整个 Agent State。
return {
    "messages": state["messages"],
    "model_calls": next_count,
    "jump_to": state.get("jump_to"),
}
```

返回完整 State 不是框架绝对禁止的操作，但会把所有字段再次作为写入提交，副作用更难判断：

- `messages` 会再次进入 `add_messages` 合并逻辑，并不是“原样保留”；
- 普通字段会再次按其 Channel 或 Reducer 规则写入；并行步骤中，无 Reducer 字段的多次写入还可能产生冲突；
- 读代码的人很难判断哪些字段是这次节点真正修改的。

### 三类节点返回形态

LangChain Agent 中常见的节点返回形态可以这样看：

| 节点 | 返回什么 | 更新内容 |
| --- | --- | --- |
| `before_*` / `after_*` | `dict`、`Command` 或 `None` | Middleware 的局部 State 更新或控制信号 |
| `model` | `list[Command]` | 模型消息、结构化结果和包装器附加更新 |
| `tools` | 工具结果消息或控制指令 | `ToolMessage`、工具产生的 State 更新 |

模型节点不会直接返回一个裸 `AIMessage` 给图，而是由工厂统一包装：

```python
def _build_commands(
    model_response: ModelResponse,
    middleware_commands: list[Command[Any]] | None = None,
) -> list[Command[Any]]:
    # 第一条 Command 承载模型节点自己的消息和结构化结果。
    state: dict[str, Any] = {"messages": model_response.result}

    if model_response.structured_response is not None:
        # structured_response 是独立状态字段，不塞进 messages。
        state["structured_response"] = model_response.structured_response

    # Middleware 的附加 Command 保持为独立更新，交给后续状态协议处理。
    commands: list[Command[Any]] = [Command(update=state)]
    commands.extend(middleware_commands or [])
    return commands
```

这段代码说明了模型结果的状态流：

```text
AIMessage / ModelResponse
  → {"messages": [...]}
  → 可选的 {"structured_response": ...}
  → Command(update=...)
  → 交给图执行层合并
```

### “更新”不等于“覆盖”

节点返回 `{"messages": [new_message]}` 时，LangChain 只声明了消息字段的局部更新。`messages` 字段上的 `add_messages` 元数据会告诉 LangGraph 依赖包如何合并它：

- 新消息通常追加到已有消息；
- 拥有相同消息 ID 时可以更新已有消息；
- 工具结果通过 `tool_call_id` 和模型工具调用配对。

对于自定义字段，是否追加、覆盖或使用 Reducer，取决于字段 Schema 的声明。文章在 LangChain 侧只关注“Reducer 元数据如何被声明”，不追踪依赖包内部的合并实现。

### State 更新如何进入下一节点

一次节点执行可以画成：

```text
当前 State
  → 节点读取
  → 节点返回局部更新
  → 图执行层按字段规则合并
  → 新 State
  → 下一节点读取
```

Middleware 的 `before_model` 能更新计数，模型节点能追加消息，工具节点能追加 `ToolMessage`，原因相同：它们都遵守“读取 State，返回局部更新”的协议。

## 六、自定义状态放在哪一层

局部更新遵守同一套字段规则，自定义状态也应按归属放到合适的位置。有两种扩展 Agent State 的方式：

### 1. 由 Middleware 携带状态

```python
class LimitState(AgentState):
    # 计数属于 Agent 执行期间的共享状态，不应塞进 messages。
    model_calls: int
    tool_calls: int


class CallLimitMiddleware(AgentMiddleware):
    # Middleware 可以携带自己的状态 Schema，并由工厂统一合并。
    state_schema = LimitState

    def before_model(self, state, runtime):
        # 每次模型调用前更新计数，是否终止由 Middleware 的生命周期 Hook 决定。
        return {"model_calls": state.get("model_calls", 0) + 1}
```

这种方式把状态字段和使用它的 Hook 放在一起，适合可复用能力。

### 2. 由调用方传入 `state_schema`

```python
class ApplicationState(AgentState):
    # 应用必须拥有的字段直接扩展 AgentState。
    request_id: str
    risk_level: str


agent = create_agent(
    model=model,
    state_schema=ApplicationState,
)
```

这种方式适合应用层必须拥有的字段，但要注意它会覆盖同名 Middleware 字段的定义。

### 状态字段的选择原则

- 节点之间需要共享、并且属于本次 Agent 执行的数据，放 State；
- 只属于一个包装器内部的临时变量，放 Request 或局部变量；
- 跨多次会话共享的数据，使用 `store`；
- 需要作为运行时依赖传入但不应写入 State 的数据，使用 `context_schema`。

不要为了方便把所有数据都塞进 `messages`。消息字段承载的是对话和工具协议，不是通用的状态字典。

## 七、StateGraph 在 LangChain 工厂中的位置

Schema 已经生成后，工厂才把合并结果交给从 LangGraph 依赖包导入的 `StateGraph`：

```python
# LangChain 只把合并后的 Schema 和 Context 交给 LangGraph 建图。
graph = StateGraph(
    state_schema=resolved_state_schema,
    input_schema=input_schema,
    output_schema=output_schema,
    context_schema=context_schema,
)
```

随后按实际配置注册节点：

```text
model
tools
Middleware.before_agent
Middleware.before_model
Middleware.after_model
Middleware.after_agent
```

常见的控制流可以概括为：

```text
START
  → before_agent 链（存在时）
  → before_model 链（存在时）/ model
  → after_model 链（存在时）
  → tools 或退出
  → after_agent 链（存在时）
  → END
```

这不是每个 Agent 都完全相同的静态图。是否存在 `tools` 节点、各类 Middleware 节点、结构化输出重试边和返回模型的边，都取决于传入的工具、响应格式和 Middleware。这里的阅读重点是 LangChain 工厂如何决定：

- 哪些节点存在；
- 哪个节点是一次性入口；
- 哪个节点是循环入口；
- 哪些条件边可能指向 `model`、`tools` 或结束；
- 哪套 Schema 被传入建图 API。

图构建器和执行器的内部实现属于 LangGraph 包本身，不在本系列中继续下钻。

## 八、模型—工具循环如何读 State

图已经确定节点和边后，循环是否继续仍要由当前 State 决定。模型出口的 `_make_model_to_tools_edge()` 按下面的优先级路由：

```python
# 1. Middleware 写入 jump_to 时，优先使用工厂可识别的有限跳转。
if jump_to := state.get("jump_to"):
    return _resolve_jump(
        jump_to,
        model_destination=model_destination,
        end_destination=end_destination,
    )

# 2. 从消息状态找到最近一轮模型输出及其工具结果。
last_ai_message, tool_messages = _fetch_last_ai_and_tool_messages(
    state["messages"]
)

if last_ai_message is None:
    # 没有模型消息时无法继续工具循环，结束。
    return end_destination

if len(last_ai_message.tool_calls) == 0:
    # 模型没有请求工具，结束本轮循环。
    return end_destination

tool_message_ids = [message.tool_call_id for message in tool_messages]

# 3. 只把尚未由 ToolMessage 配对完成、且不是结构化输出工具的调用派发到 tools。
pending_tool_calls = [
    c
    for c in last_ai_message.tool_calls
    if c["id"] not in tool_message_ids
    and c["name"] not in structured_output_tools
]

if pending_tool_calls:
    return [Send("tools", [tool_call]) for tool_call in pending_tool_calls]

# 4. 已得到结构化结果时结束；否则回模型处理人工注入或已完成的工具消息。
if "structured_response" in state:
    return end_destination

return model_destination
```

这里的路由规则比“有工具调用就进 tools，没有就结束”多两层边界：

- `jump_to` 优先于消息判断；
- 最后一条 `AIMessage` 决定本轮模型是否提出动作；
- 后续 `ToolMessage.tool_call_id` 决定动作是否已经完成；
- 未完成的普通工具调用被拆成多个 `Send("tools", [tool_call])`，分别派发给工具节点；
- 工具调用都已配对，但 State 还没有 `structured_response` 时，工厂会回到模型。这条边服务于人工注入的工具消息等场景，不应被简化成“工具调用完成就一定结束”。

工具出口还有一组独立判断：

```python
last_ai_message, tool_messages = _fetch_last_ai_and_tool_messages(state["messages"])

if last_ai_message is None:
    return model_destination

# 只看客户端工具；Provider 工具不注册在 ToolNode 中。
client_side_tool_calls = [
    c for c in last_ai_message.tool_calls if c["name"] in tool_node.tools_by_name
]
if client_side_tool_calls and all(
    tool_node.tools_by_name[c["name"]].return_direct for c in client_side_tool_calls
):
    return end_destination

if any(t.name in structured_output_tools for t in tool_messages):
    return end_destination

return model_destination
```

也就是说，工具节点完成后只有两类明确的直接退出条件：当前轮的客户端工具调用全部标记为 `return_direct=True`，或执行到了结构化输出工具。其他情况回到循环入口，由 `before_model` 链或 `model` 继续处理结果。模型—工具循环之所以能够继续，不是因为节点里保留了一个 Python 列表，而是因为模型消息和工具消息共同形成了可判断的状态协议。

## 九、建图与编译参数的职责边界

State、输入、输出和 Context 的归属在建图时就已经确定。`context_schema` 属于 `StateGraph(...)` 的构造参数，和 `state_schema`、`input_schema`、`output_schema` 一起定义图的类型边界；它不传给 `graph.compile()`。

图节点和边装配完成后，`create_agent()` 才把运行参数交给 `graph.compile()`：

```python
# 先收集 Middleware 声明的流事件 Transformer。
middleware_transformers = [
    transformer
    for middleware_item in middleware
    for transformer in getattr(middleware_item, "transformers", ())
]

return graph.compile(
    checkpointer=checkpointer,
    store=store,
    interrupt_before=interrupt_before,
    interrupt_after=interrupt_after,
    debug=debug,
    name=name,
    cache=cache,
    transformers=[
        ToolCallTransformer,
        SubagentTransformer,
        *middleware_transformers,
        *(transformers or ()),
    ],
).with_config(config)
```

LangChain 侧需要区分这些参数的用途和作用域：

| 参数 | LangChain 侧语义 | 不应误解为 |
| --- | --- | --- |
| `checkpointer` | 交给图执行层保存和恢复执行状态 | 自动形成长期记忆 |
| `store` | 提供跨 thread 的共享数据入口 | 自动注入模型上下文 |
| `cache` | 交给图执行层的缓存后端或配置 | Checkpoint 的替代品，或“所有 Agent 节点都会自动缓存” |
| `interrupt_before` / `interrupt_after` | 指定节点级暂停位置 | 任意业务行级断点 |
| `context_schema` | `StateGraph(...)` 的构造参数，描述运行时上下文类型 | `graph.compile()` 参数，或会自动持久化到 State 的数据 |
| `transformers` | 注册额外的流式事件处理扩展 | 直接修改 State、Reducer 或图节点 |

如果应用需要从 Store 读取用户偏好，仍然需要在 Middleware 中主动读取，再写入 State 或 `ModelRequest`。配置 `store=` 本身不会让模型自动看到数据。

编译前，工厂还会给图默认配置 `recursion_limit=9_999`，并写入 LangSmith 追踪元数据。它们通过 `.with_config(config)` 挂到已编译的图上，不属于 `StateGraph` 的状态字段。

### Transformer 不属于 State 更新链

这里的 `transformers` 容易和 State 的“转换”混在一起。它处理的是运行期间产生的流式事件，作用对象是调用方通过 `stream()` 或 `astream_events()` 看到的输出面。编译后的顺序固定为：`ToolCallTransformer`、`SubagentTransformer`、Middleware 声明的 Transformer、调用方传入的 Transformer。

```text
图节点执行
  → 产生 State 更新、模型消息块、工具事件等运行事件
  → Transformer 读取或改写流式事件
  → 调用方收到处理后的流
```

它和 State 更新不是同一条路径：

```text
节点返回 dict / Command
  → State reducer
  → 下一节点读取更新后的 State

Transformer 处理事件
  → 只影响流式输出
  → 不负责决定下一条图边
```

例如 PII 脱敏需要分别考虑两种数据面：

- `before_model` / `after_model` 处理最终写入 State 的消息；
- `transformers` 处理已经开始向外发送的流式事件。

如果只改 State，已经发给用户的流式片段不会自动被追回；如果只改流，也不代表 Checkpoint 中的 State 已经脱敏。具体的 `PIIMiddleware` 装配位置放在 06 篇说明。

## 十、几个容易混淆的边界

### State 与 `ModelRequest`

State 是节点之间共享的图数据；`ModelRequest` 是一次模型调用的输入快照。

```text
State
  → 可以跨模型调用和工具循环继续存在

ModelRequest
  → 只描述当前一次模型调用
  → 可以使用 override() 创建变体
```

不要把一次请求的临时改写直接写回长期 State。

### State 与 Context

State 适合会被节点更新、合并和判断的数据。Context 适合调用开始时提供的运行时依赖，例如用户身份、租户配置或外部客户端。

### State 与 Store

State 属于当前 Agent 执行；Store 属于跨执行共享。用户偏好、长期业务记录和跨对话数据不要伪装成 Agent State。

### `jump_to` 与图 API

Middleware 通过 `jump_to` 请求 `create_agent()` 约定的有限路由，取值是 `"model"`、`"tools"` 或 `"end"`。节点型 Hook 还应通过 `can_jump_to` 声明工厂需要为该节点装配哪些条件边。

`can_jump_to` 不是运行时逐项校验器。它用于图装配期声明目的地；`_add_middleware_edge()` 会按这份声明注册边，再由 `_resolve_jump()` 识别 `jump_to` 的值。未知值会回退到默认后继，框架可识别但未声明的值也不属于可依赖的行为。

`Command(goto=...)` 是 LangGraph 节点的更底层控制协议，要和图中已有静态边、条件边一起理解。它不是这个工厂约定下推荐的 Middleware 路由接口；需要在 Agent 生命周期中请求结束、回模型或进入工具节点时，使用 `jump_to` 并让声明与取值保持一致。

## 落地约束

- Agent 必需字段放进应用 `state_schema`；可复用能力的内部字段放进 Middleware Schema。
- 只影响一次模型调用的改写放进 `ModelRequest.override()`，不要污染 State。
- 消息、工具调用和工具结果保持协议化，不要用普通字符串替代消息结构。
- `jump_to` 只承载有限控制信号，不要把它当作任意节点跳转机制。
- `checkpointer`、`store`、`cache` 作用域不同，不能统称为记忆。
- `cache` 是否命中还取决于图节点的缓存策略，不能把传入缓存后端等同于整个 Agent 自动缓存。
- LangGraph 是本篇的下游建图依赖；排查 LangChain Agent 问题时，先确认工厂传入的 Schema、节点和参数是否正确。

## 排查状态问题

- 这个字段应该放在内部 State、Input Schema、Output Schema、Context 还是 Store。
- 同名状态字段最终由哪个 Schema 定义生效。
- `structured_response` 为什么不需要出现在输入中。
- 工具循环依赖哪些消息状态判断继续或结束。
- `checkpointer`、`store`、`cache` 和 `context_schema` 分别解决什么问题。
- 遇到图运行异常时，是否应该先回到 LangChain 工厂检查装配结果。

读 05 篇时只需要抓住一条线：LangChain 定义 State 的字段、可见性和更新方式，工厂把这套协议交给 LangGraph 建图；运行时的每次路由，都从当前 State 读出结果。
