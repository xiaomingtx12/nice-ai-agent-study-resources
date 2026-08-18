---
sidebar_position: 5
sidebar_label: 03 create_agent() 组装 Agent 图
description: 沿 create_agent() 的真实顺序，追踪输入配置如何变成模型、工具、Middleware、状态 Schema、图拓扑和编译结果。
---

# LangChain 源码 03：`create_agent()` 如何组装 Agent 图

## 源码定位

> **阅读基线**：`langchain` 1.3.7，源码位于 `libs/langchain_v1/`。
>
> **本篇范围**：只沿 `create_agent()` 的装配期主线，从输入参数一路看到 `graph.compile()`。Middleware 的调用栈见 [04：Middleware 执行边界](./04-middleware-control-plane.md)；State Schema 和图状态边界见 [05：State、Graph 与运行时边界](./05-state-graph-runtime.md)。
>
> **核心包与路径**：
>
> 1. `langchain.agents.factory`：`libs/langchain_v1/langchain/agents/factory.py`
>    - **主线文件**：`create_agent()` 在这里完成输入归一化、工具准备、Middleware 收集、Schema 合并、节点和边的装配，最后调用 `graph.compile()`。
>    - `_resolve_schemas()`：调用状态 Schema 合并逻辑；具体字段可见性见 05。
>    - `_handle_model_output()`：把模型返回转换成消息更新和可选的结构化结果。
>    - `_get_bound_model()`：根据工具和 `response_format` 生成本轮真正调用的模型对象。
>    - `_build_commands()`：把模型结果和 Middleware 附加更新转换成图更新。
>    - `_make_model_to_tools_edge()`、`_make_tools_to_model_edge()`：定义模型—工具循环的退出和回环条件。
> 2. `langchain.agents.structured_output`：`libs/langchain_v1/langchain/agents/structured_output.py`
>    - **作用**：定义 `AutoStrategy`、`ProviderStrategy`、`ToolStrategy` 等响应策略。03 只说明它们如何改变模型绑定和循环出口，不展开 Schema 解析细节。
> 3. `langchain.tools.tool_node`：`libs/langchain_v1/langchain/tools/tool_node.py`
>    - **作用**：这是兼容性导入层，只重导出 `InjectedState`、`ToolCallRequest` 等 LangGraph prebuilt 类型。`create_agent()` 不经过这个文件，而是直接从 `langgraph.prebuilt.tool_node` 导入 `ToolNode`；`wrap_tool_call` 的控制边界见 04。
> 4. `langchain.chat_models.base`：`libs/langchain_v1/langchain/chat_models/base.py`
>    - **作用**：`init_chat_model()` 把模型字符串归一化为 Chat Model；provider SDK 不属于本篇主线。
> 5. LangGraph 依赖包：`langgraph`
>    - **作用**：`create_agent()` 导入 `StateGraph`、`END`、`START`、`Send`、`Command` 等 API 完成建图和编译。这里只看 LangChain 调用了什么，不追踪 LangGraph 内部实现。

## 先看工厂产出什么

`create_agent()` 接收模型、工具、Middleware、状态 Schema 和运行配置，返回一张已经编译的 `CompiledStateGraph`。中间经过的是几组可以在源码中定位的装配动作：

```text
输入参数
  → 归一化模型、工具和响应格式
  → 拆解 Middleware 的工具、Hook、包装器和状态 Schema
  → 注册 model、tools 及 Middleware 节点
  → 添加模型—工具循环和退出条件
  → graph.compile()
  → CompiledStateGraph
```

装配期决定图的形状，执行期才真正调用模型和工具。运行时，模型节点构造 `ModelRequest`，通过 `_get_bound_model()` 绑定本轮模型，再由条件边决定结束、进入工具节点，还是回到模型：

```text
model
  ├─ 没有待处理的 tool_calls → exit
  └─ 有待处理的 tool_calls → tools → model
```

后文始终区分两个时间点：装配期决定节点、工具、状态字段和边；执行期消费这些装配结果。这样读工厂代码时，不会把“创建节点”和“调用模型”混成同一个动作。

## 一、入口参数：工厂先确定 Agent 的边界

`create_agent()` 的签名已经暴露了 Agent 的主要扩展面：

```python
def create_agent(
    model: str | BaseChatModel,
    tools: Sequence[BaseTool | Callable[..., Any] | dict[str, Any]] | None = None,
    *,
    system_prompt: str | SystemMessage | None = None,
    middleware: Sequence[AgentMiddleware[StateT_co, ContextT]] = (),
    response_format: ResponseFormat[ResponseT] | type[ResponseT] | dict[str, Any] | None = None,
    state_schema: type[AgentState[ResponseT]] | None = None,
    context_schema: type[ContextT] | None = None,
    checkpointer: Checkpointer | None = None,
    store: BaseStore | None = None,
    interrupt_before: list[str] | None = None,
    interrupt_after: list[str] | None = None,
    debug: bool = False,
    name: str | None = None,
    cache: BaseCache[Any] | None = None,
    transformers: Sequence[TransformerFactory] | None = None,
) -> CompiledStateGraph[...]:
```

签名里的 `*` 表示：只有 `model` 和 `tools` 可以按位置传入，其余参数都必须使用关键字传入。返回值不是一个尚未编译的 `StateGraph` Builder，而是：

```python
CompiledStateGraph[
    AgentState[ResponseT],
    ContextT,
    _InputAgentState,
    _OutputAgentState[ResponseT],
]
```

也就是已经编译完成、带有输入状态类型、输出状态类型和运行时上下文类型的图对象。

签名里的类型和默认值先把 Agent 的边界画了出来。

| 参数 | 实现中的类型 | 默认值 |
| --- | --- | --- |
| `model` | `str \| BaseChatModel` | 无默认值，必填 |
| `tools` | `Sequence[BaseTool \| Callable[..., Any] \| dict[str, Any]] \| None` | `None` |
| `system_prompt` | `str \| SystemMessage \| None` | `None` |
| `middleware` | `Sequence[AgentMiddleware[StateT_co, ContextT]]` | `()`，空元组 |
| `response_format` | `ResponseFormat[ResponseT] \| type[ResponseT] \| dict[str, Any] \| None` | `None` |
| `state_schema` | `type[AgentState[ResponseT]] \| None` | `None` |
| `context_schema` | `type[ContextT] \| None` | `None` |
| `checkpointer` | `Checkpointer \| None` | `None` |
| `store` | `BaseStore \| None` | `None` |
| `interrupt_before` | `list[str] \| None` | `None` |
| `interrupt_after` | `list[str] \| None` | `None` |
| `debug` | `bool` | `False` |
| `name` | `str \| None` | `None` |
| `cache` | `BaseCache[Any] \| None` | `None` |
| `transformers` | `Sequence[TransformerFactory] \| None` | `None` |

这里的容器类型也有含义：

- `Sequence[...]` 表示调用方可以传列表、元组等序列；工厂主要按顺序遍历，不要求一定是 `list`；
- `list[str]` 用在 `interrupt_before` 和 `interrupt_after`，因为它们最终是要交给编译图的节点名集合；
- `type[ResponseT]` 表示可以直接传一个结构化输出 Schema 类型；
- `dict[str, Any]` 在 `tools` 中代表 provider 原生工具定义，在 `response_format` 中则是原始 JSON Schema；工厂会把后者包成 `AutoStrategy`，二者不是同一种字典。

### 1. 参数归一化：入口形态 → 内部统一结构

签名中的默认值只是入口形态。`create_agent()` 进入函数体后，先把几个可选参数转换为后续代码统一使用的结构。

**`model`：字符串变成模型对象**

```python
# 字符串模型标识只在工厂入口解析一次。
# 后续 model 节点统一接收 BaseChatModel。
if isinstance(model, str):
    model = init_chat_model(model)
```

所以 `model="openai:..."` 和直接传 `ChatOpenAI(...)`，最终都会汇合到同一个模型对象变量。

**`tools`：`None` 变成空列表**

```python
# 没有工具时使用空列表，后面的列表推导不再处理 None。
if tools is None:
    tools = []
```

之后工厂再按数据形态拆分：

```python
# 字典是 provider 原生工具定义，不由本地 ToolNode 执行。
built_in_tools = [tool for tool in tools if isinstance(tool, dict)]

# BaseTool 和普通 callable 属于客户端工具候选。
regular_tools = [tool for tool in tools if not isinstance(tool, dict)]
```

`built_in_tools` 在八节与结构化输出工具一起进入 `final_tools` 传给 `bind_tools()`；`regular_tools` 在四节与 Middleware 工具合并后创建 `ToolNode`。

**`system_prompt`：字符串变成 `SystemMessage`**

```python
system_message: SystemMessage | None = None
if system_prompt is not None:
    if isinstance(system_prompt, SystemMessage):
        system_message = system_prompt
    else:
        system_message = SystemMessage(content=system_prompt)
```

后续 `ModelRequest` 中始终使用 `SystemMessage | None`，不再保留字符串分支。

**`response_format`：裸 Schema 先变成 `AutoStrategy`**

```python
if response_format is None:
    initial_response_format = None
elif isinstance(response_format, (ToolStrategy, ProviderStrategy, AutoStrategy)):
    # 已经明确指定策略，保留原策略对象。
    initial_response_format = response_format
else:
    # 裸 Schema 暂时保留"自动选择 provider/tool 策略"的意图。
    initial_response_format = AutoStrategy(schema=response_format)
```

如果需要提前计算结构化输出工具，工厂还会把 `AutoStrategy` 暂时转换为 `ToolStrategy` 做工具绑定准备；真正调用模型时，仍可能根据模型能力切换为 `ProviderStrategy`。

**其余 `None`：表示不启用对应能力**

这些参数不会在入口被替换成复杂对象，而是原样传到图创建或编译阶段：

```text
state_schema=None → 后面使用 AgentState
context_schema=None → StateGraph 不增加用户自定义 Runtime.context Schema
checkpointer/store/cache=None → 编译图不启用对应的持久化、跨 thread 存储或缓存
interrupt_before/after=None → 不额外配置节点级中断
debug=False → 不开启调试输出
name=None → 不设置用户自定义 Agent 名称
transformers=None → 不追加用户自定义 Transformer
```

`middleware=()` 稍有不同：它不仅表示"不启用 Middleware"，还直接决定后续 `middleware_tools`、各类 Hook 列表、包装器列表和 `middleware_transformers` 是否为空。

这些参数大致分成四组：

| 参数组 | 代表参数 | 装配期决定什么 |
| --- | --- | --- |
| 调用对象 | `model`、`system_prompt` | 模型节点使用什么模型和系统消息 |
| 行为扩展 | `tools`、`middleware` | 工具节点、Hook 节点和包装栈 |
| 状态协议 | `response_format`、`state_schema`、`context_schema` | State、输入输出边界和结构化结果 |
| 运行配置 | `checkpointer`、`store`、`cache`、`interrupt_*` | 编译后的图具备哪些运行能力 |

工厂的作用是把这些入口形态归一化为后续节点可以直接消费的对象。

## 二、入口参数如何进入模型调用

这一阶段先看 `system_prompt` 如何进入模型调用链，以及用户工具如何被拆成客户端工具和 provider 原生工具。

### 1. system_prompt 的传递路径

```text
create_agent(system_prompt=...)
  → 保存为 system_message
  → ModelRequest.system_message
  → _execute_model_sync()
  → [system_message, *request.messages]
  → model.invoke(messages)
```

`system_prompt` 不会直接写进 `AgentState["messages"]`。它作为模型调用配置单独保存，直到真正调用模型时才拼到消息列表最前面。这样处理有三个直接结果：

- State 中的对话历史不混入每次调用都相同的系统消息；
- Middleware 可以在一次模型调用前通过 `ModelRequest` 改写系统消息；
- 工具循环回到模型时，工厂可以用同一个系统消息重新组装本轮模型输入。

## 三、结构化输出如何改变图的行为

`response_format` 不是"模型返回后再套一个 Parser"。它在工厂中提前介入，改变了三个关键行为：

- **模型绑定**：策略决定 `_get_bound_model()` 用 provider 原生参数还是把 Schema 伪装成特殊工具，这会改变模型调用时实际传入的参数。
- **循环出口**：条件边会检查 `state["structured_response"]`；但这个检查排在待执行的普通工具调用之后。只有没有 `pending_tool_calls` 时，已有结构化结果才会结束本轮循环。
- **输出 State**：`agent.invoke()` 仍返回图的状态映射，其中保留 `messages`，并在成功时额外包含 `structured_response`。Schema 决定的是 `result["structured_response"]` 的类型，不是把整个返回值替换成该对象。

它会在装配期准备策略和工具，在运行期影响模型绑定、结果解析和循环出口。

### 1. 裸 Schema 先归一化为 `AutoStrategy`

```python
# 初始化响应格式：裸 Schema 暂时包成 AutoStrategy，
# 显式策略则直接沿用。
if response_format is None:
    initial_response_format = None
elif isinstance(response_format, (ToolStrategy, ProviderStrategy, AutoStrategy)):
    initial_response_format = response_format
else:
    initial_response_format = AutoStrategy(schema=response_format)
```

如果是 `AutoStrategy`，工厂会先按 `ToolStrategy` 创建候选工具：

```python
# 为 AutoStrategy 预先准备 ToolStrategy，先得到结构化工具绑定信息；
# 真正调用模型时仍可能切换成 ProviderStrategy。
if isinstance(initial_response_format, AutoStrategy):
    tool_strategy_for_setup = ToolStrategy(schema=initial_response_format.schema)
elif isinstance(initial_response_format, ToolStrategy):
    tool_strategy_for_setup = initial_response_format

# 结构化输出工具单独保存，不和普通业务工具混用。
structured_output_tools: dict[str, OutputToolBinding[Any]] = {}
if tool_strategy_for_setup:
    # 先建立结构化工具的绑定信息，供后续模型绑定和结果解析使用。
    for response_schema in tool_strategy_for_setup.schema_specs:
        binding = OutputToolBinding.from_schema_spec(response_schema)
        structured_output_tools[binding.tool.name] = binding
```

这段代码先为 `AutoStrategy` 准备候选结构化工具，提前确定工具名、Schema 和错误处理；到真正调用模型时，再根据模型能力选择 Provider 或 Tool 策略。

### 2. 三种策略改变的是调用协议

| 策略 | 模型调用侧 | Agent 结果侧 |
| --- | --- | --- |
| `ProviderStrategy` | 绑定 `response_format` JSON Schema 参数 | 当模型结果没有 `tool_calls` 时，从消息内容解析 `structured_response` |
| `ToolStrategy` | 把 Schema 绑定成特殊工具 | 解析特殊工具调用并回灌 `ToolMessage` |
| `AutoStrategy` | 根据模型能力选择前两者之一 | 跟随最终策略处理结果 |

这三种策略分别会在三个位置生效：`_get_bound_model()` 负责绑定模型，`_handle_model_output()` 负责解析结果，条件边负责根据 `structured_response` 决定是否结束。

这里的 `ProviderStrategy` 是 API 层的策略名，不表示工厂会针对每个 provider 分别适配参数。`1.3.7` 的 `ProviderStrategy.to_model_kwargs()` 固定生成 OpenAI 风格的 `response_format={"type": "json_schema", ...}`，再交给模型适配器处理；阅读源码时不要把它误解成一个通用的 provider 参数转换层。

## 四、Middleware 如何进入工厂

工厂不会在这里执行 Middleware，而是把同一个实例拆成几类能力，分别接入工具节点、图节点、模型包装栈和 State Schema：

```text
middleware
  ├─ middleware_tools         → 注入 available_tools，与用户工具一起进入 ToolNode
  ├─ before_agent / after_agent  → 注册为一次性节点，在 agent 首尾各执行一次
  ├─ before_model / after_model  → 注册为循环节点，每轮模型调用前后都执行
  ├─ wrap_model_call         → 组合为洋葱 handler，由模型节点在调用前逐层包装
  ├─ wrap_tool_call          → 传入 ToolNode，在工具执行前后逐层包装
  └─ state_schema / transformers → 分别进入 State 合并和编译期事件扩展
```

每类节点型 Hook 都同时检查同步和异步方法；例如 `before_model` 的判断是：

```python
if (
    m.__class__.before_model is not AgentMiddleware.before_model
    or m.__class__.abefore_model is not AgentMiddleware.abefore_model
):
    ...
```

两个版本都继承默认实现时，工厂才不增加该 Hook 节点。`wrap_model_call` 和 `wrap_tool_call` 也按同步、异步版本分别收集并组合。Hook 内部的洋葱顺序、`ModelRequest` 替换和 `jump_to` 跳转见 [04：Middleware 执行边界](./04-middleware-control-plane.md)。

Middleware 工具收集完成后，工具节点才真正创建：

```python
available_tools = middleware_tools + regular_tools  # regular_tools 来自一.1 的归一化拆分（dict vs 非 dict）
tool_node = (
    ToolNode(tools=available_tools,
             wrap_tool_call=wrap_tool_call_wrapper,
             awrap_tool_call=awrap_tool_call_wrapper)
    if available_tools or wrap_tool_call_wrapper or awrap_tool_call_wrapper
    else None
)
```

## 五、合并 State Schema

Middleware 可以往 State 里加字段（如摘要中间件加的 `summary`），调用方也可以通过 `state_schema` 覆盖。合并顺序决定了最终谁赢：

```python
base_state = state_schema if state_schema is not None else AgentState
state_schemas: list[type] = [*(m.state_schema for m in middleware), base_state]
resolved_state_schema, input_schema, output_schema = _resolve_schemas(state_schemas)
```

Middleware Schema 在前，调用方 Schema 在最后。同名字段由调用方覆盖。合并后三套 Schema 交给 LangGraph 的 `StateGraph()`，输入/输出 Schema 可以比内部 State 更窄。字段注解、合并算法的具体规则、reducer 行为见 [05：State、Graph 与运行时边界](./05-state-graph-runtime.md)。

## 六、注册图节点和确定生命周期位置

### 1. 固定节点与扩展节点

工厂的图至少围绕两个固定节点装配：

```text
model
tools（存在客户端工具或工具包装器时）
```

Middleware 的 `before_*` / `after_*` 会被注册成命名节点，例如：

```text
MyMiddleware.before_agent
MyMiddleware.before_model
MyMiddleware.after_model
MyMiddleware.after_agent
```

模型节点同时挂同步和异步实现：

```python
graph.add_node(
    "model",
    RunnableCallable(model_node, amodel_node, trace=False),
)

if tool_node is not None:
    graph.add_node("tools", tool_node)
```

这里的重点不是 LangGraph 如何执行节点，而是工厂在编译前决定了图上有哪些名字和位置。

### 2. 一次性入口和循环入口分开

工厂会分别计算：

```text
entry_node       一次 Agent 运行的入口
loop_entry_node  每轮模型循环的入口
loop_exit_node   每轮模型循环的出口
exit_node        整次运行的最终出口
```

典型拓扑是：

```text
START
  → before_agent
  → before_model
  → model
  → after_model
       ├─ tools → before_model
       └─ after_agent → END
```

`before_agent` 不在工具循环中重复执行；`before_model` 会在每次重新调用模型前执行。这个区分直接决定摘要、计数、初始化和清理逻辑应该挂在哪个 Hook 上。

## 七、模型节点：State → 模型调用 → 结果

模型节点负责把当前 State 转成一次模型调用，再把结果写回图状态。它的内部流程分两层：

**外层：Middleware 包装判断。** 如果没有 `wrap_model_call` 中间件，直接走 `_execute_model_sync()`；有的话进入洋葱栈——Middleware 可以在 `handler(request)` 前后插入逻辑，并通过 `request.override()` 替换本次调用的任意参数。

```python
# 无中间件：直通。
if wrap_model_call_handler is None:
    model_response = _execute_model_sync(request)
    return _build_commands(model_response)

# 有中间件：洋葱栈。
result = wrap_model_call_handler(request, _execute_model_sync)
return _build_commands(result.model_response, result.commands)
```

**内层：`_execute_model_sync()` 三步走：**

```python
# ① 绑定模型：策略 + 工具 + 模型设置 → 可调用的 model_ 对象。
model_, effective_response_format = _get_bound_model(request)

# ② 组装消息：system_message 在真正调用前才拼到消息列表最前面。
messages = request.messages
if request.system_message:
    messages = [request.system_message, *messages]

# ③ invoke + 结果处理：model_ 遵循 Runnable 协议（见 01 篇）。
output = model_.invoke(messages)
handled_output = _handle_model_output(output, effective_response_format)
```

模型节点完成请求和结果转换后，条件边接管后续路由。

中间件改写系统消息是常见操作。下面这个例子只改当前这一次调用，不会污染 Agent State（回顾二节的三条好处）：

```python
request = request.override(
    system_message=SystemMessage(content="本次调用使用的临时规则")
)
return handler(request)
```

`_handle_model_output()` 在 ③ 之后根据策略做结果分发：`ProviderStrategy` → 解析 `structured_response` 写入 State；`ToolStrategy` → 解析特殊工具调用，回灌带 `tool_call_id` 的 `ToolMessage`；无策略 → 直接返回消息更新。

## 八、模型绑定和结构化结果回灌

`_get_bound_model()` 定义在装配期，但由 `_execute_model_sync()` / `_execute_model_async()` 在**每次模型调用时**执行。Middleware 可以通过 `request.override()` 改写本次请求的模型、工具、响应格式和 `model_settings`，因此不能把它理解成 `create_agent()` 时只做一次的决定。

它先为本次请求确定 `effective_response_format`，再按该结果选择对应绑定分支：

```python
# 分支 1：本次确定为 ProviderStrategy。
if isinstance(effective_response_format, ProviderStrategy):
    kwargs = effective_response_format.to_model_kwargs()
    return (
        request.model.bind_tools(final_tools, strict=True, **kwargs, **request.model_settings),
        effective_response_format,
    )

# 分支 2：本次确定为 ToolStrategy；存在预先声明的结构化工具时强制 tool_choice="any"。
if isinstance(effective_response_format, ToolStrategy):
    tool_choice = "any" if structured_output_tools else request.tool_choice
    return (
        request.model.bind_tools(final_tools, tool_choice=tool_choice, **request.model_settings),
        effective_response_format,
    )

# 分支 3：有普通工具但无结构化输出——只绑定业务工具。
if final_tools:
    return (
        request.model.bind_tools(final_tools, tool_choice=request.tool_choice, **request.model_settings),
        None,
    )

# 分支 4：无工具——原始模型直接调用。
return request.model.bind(**request.model_settings), None
```

这不是“`ProviderStrategy` 总是优先于 `ToolStrategy`”的策略排序。显式传入的 `ProviderStrategy` 或 `ToolStrategy` 会原样保留；只有 `AutoStrategy` 才会调用 `_supports_provider_strategy(request.model, tools=request.tools)` 自动选择。判断结果为真时改用 `ProviderStrategy`，否则使用 `ToolStrategy`。显式的 `ProviderStrategy` 不会因为能力探测失败而自动降级。

因此，`AutoStrategy` 在本轮被选为 `ProviderStrategy` 时走第一条；能力不支持时走 `ToolStrategy`。普通工具分支只表示本轮没有有效的结构化输出策略。

## 九、工具节点：LangGraph 的 prebuilt 执行器

`tools` 节点使用的是 LangGraph prebuilt 的 `ToolNode`。工厂直接从 `langgraph.prebuilt.tool_node` 导入它，并在四节把 `available_tools` 和 `wrap_tool_call` 包装器交给它：

```python
tool_node = ToolNode(
    tools=available_tools,
    wrap_tool_call=wrap_tool_call_wrapper,
    awrap_tool_call=awrap_tool_call_wrapper,
)
```

单个工具的执行和把结果包装成 `ToolMessage` 追加到 State 都在 `ToolNode` 内部完成；工厂不参与单个工具的执行，但会在工具节点之后通过条件边读取 State，决定回到模型还是退出。03 对工具节点的装配职责到“创建 `ToolNode` 并注册为 `tools` 节点”为止：

- 具体执行链（`invoke → run → _run → _format_output`）见 [02：聊天模型、消息与工具](./02-core-abstractions.md)；
- `wrap_tool_call` 的拦截与工具结果改写见 [04：Middleware 执行边界](./04-middleware-control-plane.md)。

## 十、条件边：Agent 的循环逻辑

模型输出后，工厂根据最后一条 `AIMessage` 中的 `tool_calls` 计算下一条边。

`_make_model_to_tools_edge()` 只会在存在 `tool_node` 时注册到 `loop_exit_node`。它的第一步是计算待处理的工具调用：

```python
pending_tool_calls = [
    call
    for call in last_ai_message.tool_calls
    if call["id"] not in tool_message_ids           # 已有 ToolMessage 配对 → 已处理
    and call["name"] not in structured_output_tools  # 结构化输出工具 → 不进入普通 tools 节点
]
```

只有同时满足"没有配对 ToolMessage"且"不是结构化输出工具"的 tool_call 才进入 `pending_tool_calls`。

**第二步：六层判断路由。**

```text
                                         ┌──────────────────┐
                   middleware 的 jump_to  │ set? → 按值解析跳转    │ (1) 最高优先级
                                         └──────────────────┘
                                                │ 无
                                         ┌──────────────────┐
                   last_ai_message 不存在  │ → END             │ (2)
                                         └──────────────────┘
                                                │ 有
                                         ┌──────────────────┐
                   AIMessage.tool_calls   │ 空 → END          │ (3)
                                         └──────────────────┘
                                                │ 非空
                                         ┌──────────────────┐
                   pending_tool_calls     │ 非空 → Send(tools) │ (4) 每个 call 独立派发
                                         └──────────────────┘
                                                │ 空
                                         ┌──────────────────┐
                   structured_response    │ 已写入 → END      │ (5)
                                         └──────────────────┘
                                                │ 未写入
                                         ┌──────────────────┐
                                          → 回到 model       │ (6) 继续处理工具结果
                                         └──────────────────┘
```

`Send("tools", [call])` 的含义：每个待处理的工具调用独立派发到 `tools` 节点（九节的 `ToolNode`），由 LangGraph 负责并行调度。这不同于 `RunnableParallel` 的固定构造期分支——Send 的数量和内容由模型运行时输出决定。

`_make_model_to_tools_edge()` 和 `_make_model_to_model_edge()` 只调用 `_resolve_jump()`，不会在这里读取某个 Hook 的 `can_jump_to` 声明。`can_jump_to` 的作用是让 `_add_middleware_edge()` 为普通 Middleware 节点注册可选目的地；不要把它理解成对所有 `jump_to` 状态更新的统一运行时鉴权。

**工具节点之后还有一条回环边。** 模型到工具的边只解决了"要不要派发工具"。工具执行完往哪走，由另一条独立的 `_make_tools_to_model_edge` 决定：

```python
def tools_to_model(state: dict[str, Any]) -> str | None:
    last_ai_message, tool_messages = _fetch_last_ai_and_tool_messages(state["messages"])

    # 1. 没有 AIMessage（如消息被清空），回到模型。
    if last_ai_message is None:
        return model_destination

    # 2. 所有客户端工具都 return_direct=True → 直接结束。
    client_side_tool_calls = [
        c for c in last_ai_message.tool_calls if c["name"] in tool_node.tools_by_name
    ]
    if client_side_tool_calls and all(
        tool_node.tools_by_name[c["name"]].return_direct for c in client_side_tool_calls
    ):
        return end_destination

    # 3. 结构化输出工具已执行 → 直接结束。
    if any(t.name in structured_output_tools for t in tool_messages):
        return end_destination

    # 4. 默认：工具结果已就绪，回到模型继续推理。
    return model_destination
```

它和模型→工具的边是**两条独立的函数**，不是一条边里的两个分支。模型→工具的边管"派发"，工具→模型的边管"回收"。

**没有 `ToolNode` 时的模型自环。** 若没有客户端工具和工具包装器，但 `ToolStrategy` 在装配期创建了 `structured_output_tools`，工厂不会为了这些特殊工具创建 `ToolNode`：结构化工具调用由 `_handle_model_output()` 在模型节点内解析。此时才会把 `_make_model_to_model_edge()` 注册到 `loop_exit_node`，用于在结构化输出未成功时再次调用模型：

```python
def model_to_model(state: dict[str, Any]) -> str | None:
    # 1. jump_to 优先。
    if jump_to := state.get("jump_to"):
        return _resolve_jump(jump_to, model_destination=model_destination, end_destination=end_destination)

    # 2. 结构化响应已生成 → 结束。
    if "structured_response" in state:
        return end_destination

    # 3. 默认：回到模型重试结构化输出。
    return model_destination
```

三套路由函数不是同时注册到同一张图：

- 有 `tool_node` 时，工厂注册 `_make_model_to_tools_edge()` 和 `_make_tools_to_model_edge()`；前者的第六个分支可直接回到模型，处理人工注入的 `ToolMessage` 或结构化输出重试。
- 没有 `tool_node`、但存在 `structured_output_tools` 时，工厂只注册 `_make_model_to_model_edge()`。
- 两者都没有且没有 `after_model` Hook 时，模型节点直接连到最终出口；存在 `after_model` Hook 时，由该 Hook 的边决定默认出口和允许的跳转。

## 十一、编译并返回图

工厂最后把运行能力作为参数交给 `graph.compile()`：

```python
# 编译期只负责把持久化、中断、缓存和事件转换配置传下去。
config: RunnableConfig = {"recursion_limit": 9_999}
config["metadata"] = {"ls_integration": "langchain_create_agent"}

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

编译结束时有几件事需要留意：

- `create_agent()` 返回的是编译后的图，不是模型包装器；
- `checkpointer`、`store`、`cache` 和 `interrupt_*` 在这里被传下去；
- `recursion_limit` 是图执行步骤的兜底，不是模型调用次数；
- `transformers` 是注册到编译图流式事件基础设施的扩展，不是图节点，也不是 Middleware Hook；
- Transformer 不参与 State 的 reducer 或节点更新；它处理的是运行时对外复用的流事件通道；
- 内置 Transformer 和 Middleware 自带 Transformer 的具体装配位置放在 06 篇。

## 十二、完整流程回放

给定：

```python
# 这个调用展示的是装配输入，返回值会是编译后的 Agent 图。
agent = create_agent(
    model=model,
    tools=[search, save_result],
    middleware=[limit_calls, summarize],
    response_format=Answer,
    state_schema=MyState,
    checkpointer=checkpointer,
)
```

可以按以下顺序回放：

1. 本例的 `model` 已是模型对象，直接进入后续流程；若传入模型字符串，工厂才调用 `init_chat_model()`。本例没有 `system_prompt`，因此不会创建 `SystemMessage`。
2. `search` 和 `save_result` 被作为客户端工具准备给 `ToolNode`。
3. `Answer` 被包装成结构化输出策略，并提前准备候选工具。
4. Middleware 的工具、节点型 Hook、包装型 Hook 和状态 Schema 被分别收集。
5. `MyState` 与 Middleware Schema 合并，生成内部、输入和输出 Schema。
6. 工厂创建 `StateGraph`，注册 `model`、`tools` 和 Middleware 节点。
7. 工厂连接入口、模型循环、工具回环和最终出口。
8. 模型节点根据最终策略绑定模型，返回消息和结构化结果。
9. 条件边根据工具调用状态选择结束、工具派发或下一轮模型调用。
10. `graph.compile()` 接收持久化、中断、缓存和流事件配置，返回 `CompiledStateGraph`。

这就是 `create_agent()` 的完整装配过程。

## 读完这篇之后

- 可以从 `create_agent()` 参数推断会出现哪些节点。
- 可以按源码顺序解释模型、工具、响应格式和 Middleware 如何进入图。
- 可以区分 `entry_node`、`loop_entry_node` 和 `exit_node`。
- 可以说明模型节点为什么只负责请求和返回，循环由条件边控制。
- 可以判断一个新能力应该放在工厂装配、Middleware 机制还是 State Schema 中。

`create_agent()` 的职责边界也就清楚了：它负责把模型、工具、Middleware 和状态配置装配成一张可编译的 Agent 图；运行这张图，则交给 LangGraph。
