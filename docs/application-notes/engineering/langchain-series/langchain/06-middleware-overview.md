---
sidebar_position: 8
sidebar_label: 06 内置中间件总览
description: 按 create_agent 的装配阶段梳理 LangChain 预构建中间件，说明每个中间件如何进入工具节点、Hook、状态 Schema 和编译后的事件流。
---

# LangChain 源码 06：内置中间件总览

## 源码定位

> **阅读基线**：LangChain 1.3.7，源码位于 `libs/langchain_v1/`。
>
> **本篇重点路径：**
>
> 1. `langchain/agents/factory.py` 的 `create_agent()`：预构建中间件被扫描、收集和装配的总入口。
> 2. `langchain/agents/middleware/__init__.py`：当前内置中间件的导出清单。
> 3. `langchain/agents/middleware/types.py` 的 `AgentMiddleware`：判断一个中间件实现了哪些扩展面的协议。
> 4. `langchain/agents/middleware/model_call_limit.py`、`tool_call_limit.py`：状态字段和节点 Hook 的代表。
> 5. `langchain/agents/middleware/model_retry.py`、`model_fallback.py`、`tool_retry.py`：调用包装器的代表。
> 6. `langchain/agents/middleware/todo.py`、`shell_tool.py`、`file_search.py`：工具注入和运行资源的代表。
> 7. `langchain/agents/middleware/pii.py`：节点 Hook 与流式 Transformer 同时存在的代表。
>
> `StateGraph`、`ToolNode`、`Command` 和 `graph.compile()` 都是从 LangGraph 包导入后使用。本篇只追 LangChain 如何把中间件交给它们，不展开 LangGraph 仓库内部实现。

04 篇已经讲过中间件的 Hook 协议和组合规则，05 篇已经讲过状态更新与图边。本篇不重新解释这些机制，改为回答一个更窄的问题：

> `create_agent()` 装配一组预构建中间件时，工厂按什么阶段处理它们？每个内置中间件分别贡献了工具、包装器、节点、状态字段，还是 Transformer？

## 先说结论：没有一条“内置类的固定执行清单”

`create_agent()` 不会按照某个硬编码清单依次执行：

```text
Todo → Shell → 摘要 → 重试 → HITL
```

它做的是多次遍历 `middleware` 参数，按能力把实例放进不同集合：

```text
middleware=[A(), B(), C()]

收集 A/B/C 的 tools
收集 A/B/C 的 wrap_tool_call
收集 A/B/C 的 before_model
收集 A/B/C 的 after_model
收集 A/B/C 的 wrap_model_call
收集 A/B/C 的 state_schema
收集 A/B/C 的 transformers
```

所以需要区分两层顺序：

- **工厂装配阶段有固定顺序**：先收工具和工具包装器，再收节点 Hook 和模型包装器，之后合并状态，最后编译 Transformer。
- **同一扩展面中的内置中间件没有固定类顺序**：通常保留用户传入的 `middleware=[...]` 顺序。

例如 `TodoListMiddleware` 同时提供 `tools`、`state_schema`、`wrap_model_call` 和 `after_model`，它会被工厂在四个阶段分别识别。它不是被装配四次，而是同一个实例的四个能力分别接入不同位置。

## 一张装配总览图

下面这条链对应 `factory.py` 中 `create_agent()` 的主要处理顺序：

```text
1. 规范化 model / system_prompt / tools / response_format
   ↓
2. 收集 middleware.tools
   ↓
3. 收集并组合 wrap_tool_call
   ↓
4. 用用户工具 + 中间件工具创建 ToolNode
   ↓
5. 按能力收集 before_agent / before_model / after_model / after_agent
   ↓
6. 收集并组合 wrap_model_call
   ↓
7. 合并 middleware.state_schema 与用户 state_schema
   ↓
8. 添加 model、tools 和中间件节点，连接图边
   ↓
9. 收集 middleware.transformers，调用 graph.compile()
```

运行时则是另一条路径：

```text
START
  → before_agent
  → before_model
  → model（内部套 wrap_model_call）
  → after_model
  → tools（内部套 wrap_tool_call）
  → before_model
  → ...
  → after_agent
  → END
```

这张图只用来定位内置实现。Hook 的顺序细节、State 更新如何进入下一节点，分别看 04 和 05。

## 不传 `middleware` 时会发生什么

只调用：

```python
agent = create_agent(model=model, tools=tools)
```

不会自动装配预构建中间件。`create_agent()` 的参数默认是：

```python
middleware: Sequence[AgentMiddleware[StateT_co, ContextT]] = ()
```

因此下面这些集合都会是空的：

```text
middleware_tools
middleware_w_wrap_tool_call
middleware_w_before_agent
middleware_w_before_model
middleware_w_after_model
middleware_w_after_agent
middleware_w_wrap_model_call
middleware_transformers
```

这时工厂仍然会装配 Agent 的基础结构：

```text
model
  → 由 model 节点调用模型

tools 不为空
  → 创建 ToolNode，并形成模型—工具循环

tools 为空
  → 只有 model 节点，不创建 tools 节点

state_schema 未传
  → 使用基础 AgentState

graph.compile()
  → 仍然注册 LangChain 固定提供的 ToolCallTransformer、SubagentTransformer
```

最后一项不是“默认中间件”。它们是工厂直接传给 `graph.compile()` 的基础 Transformer；不能据此说 `create_agent()` 自动启用了某个预构建 Middleware。

可以先把两个默认 Transformer 记成：

| 默认 Transformer | 负责把什么整理到流式输出面 |
| --- | --- |
| `ToolCallTransformer` | 工具调用相关的运行事件，供调用方在流中观察工具调用及其执行过程 |
| `SubagentTransformer` | 嵌套命名 Agent 的运行事件，向父运行暴露 `run.subagents` 句柄 |

它们不负责决定“要不要调用工具”或“要不要进入子 Agent”。前者由模型输出、工具节点和图边决定，后者由应用实际调用的子图决定；Transformer 只是把这些已经发生的运行事件整理成调用方可以消费的流式接口。

如果需要内置中间件，必须显式传入实例：

```python
agent = create_agent(
    model=model,
    tools=tools,
    middleware=[
        SummarizationMiddleware(model=summary_model),
        PIIMiddleware("email", strategy="redact"),
    ],
)
```

这时工厂才会从这两个实例上分别读取 `before_model`、`after_model`、`state_schema` 或 `transformers` 等扩展面。换句话说：

```text
create_agent() 默认提供的是基础 Agent 工厂能力
预构建 Middleware 是按需显式加入的可选能力
```

## 1. 规范化基础参数

工厂先把模型、系统提示词、用户工具和结构化输出配置整理成统一对象。预构建中间件在这一阶段还没有变成图节点，但它们后面收到的 `ModelRequest` 就是在这里准备出来的。

### 系统提示词的初始位置

`system_prompt` 是字符串时，会先转换为 `SystemMessage`：

```python
# 字符串提示词在工厂入口统一转换为 SystemMessage
system_message: SystemMessage | None = None
if system_prompt is not None:
    if isinstance(system_prompt, SystemMessage):
        system_message = system_prompt
    else:
        system_message = SystemMessage(content=system_prompt)
```

每轮模型节点创建 `ModelRequest`：

```python
request = ModelRequest(
    model=model,
    tools=default_tools,
    system_message=system_message,
    response_format=initial_response_format,
    messages=state["messages"],
    tool_choice=None,
    state=state,
    runtime=runtime,
)
```

后续的 `TodoListMiddleware`、`ContextEditingMiddleware` 和 `ProviderToolSearchMiddleware` 都是在包装阶段通过 `request.override(...)` 修改本次请求。它们不会改变 `create_agent()` 入口收到的原始参数。

### 这一阶段要看哪些内置中间件

这一阶段没有专门被创建出来的内置中间件节点，重点是给后面几步准备三类基础数据：

| 基础数据 | 后续用途 |
| --- | --- |
| `system_message` | 供 Todo 或自定义模型包装器追加系统规则 |
| 用户工具和 provider 工具 | 与中间件工具合并，再创建 `ToolNode` |
| `response_format` | 后续绑定结构化输出工具，参与模型节点路由 |

## 2. 收集 `middleware.tools`

工厂第一次真正扫描中间件，是收集它们声明的客户端工具：

```python
# 取出每个中间件通过 tools 暴露的工具
middleware_tools = [
    tool
    for middleware_item in middleware
    for tool in getattr(middleware_item, "tools", [])
]
```

再与用户传入的普通工具合并：

```python
# 这些工具需要由客户端的 ToolNode 执行
available_tools = middleware_tools + regular_tools
```

当前预构建中间件中，真正通过 `tools` 增加客户端工具的有三类：

| 内置中间件 | 注入工具 | 同时贡献的其他能力 |
| --- | --- | --- |
| `TodoListMiddleware` | `write_todos` | `PlanningState`、`wrap_model_call`、`after_model` |
| `ShellToolMiddleware` | `shell` | `ShellToolState`、`before_agent`、`after_agent` |
| `FilesystemFileSearchMiddleware` | `glob_search`、`grep_search` | 文件根目录校验和搜索实现 |

### `TodoListMiddleware` 的装配贡献

`todo.py` 中的关键定义是：

```python
class PlanningState(AgentState[ResponseT]):
    """Todo 中间件增加的状态字段。"""

    todos: Annotated[NotRequired[list[Todo]], OmitFromInput]


class TodoListMiddleware(AgentMiddleware[PlanningState[ResponseT], ContextT, ResponseT]):
    state_schema = PlanningState

    def __init__(self, *, system_prompt: str = WRITE_TODOS_SYSTEM_PROMPT, ...):
        super().__init__()
        self.system_prompt = system_prompt
        self.tools = [
            StructuredTool.from_function(
                name="write_todos",
                description=WRITE_TODOS_TOOL_DESCRIPTION,
                func=_write_todos,
                coroutine=_awrite_todos,
                args_schema=WriteTodosInput,
                infer_schema=False,
            )
        ]
```

这里的重点不是重新讲 Todo 工具怎么执行，而是看工厂会从同一个实例上读到什么：

```text
TodoListMiddleware
  ├─ tools          → 进入 available_tools
  ├─ state_schema   → 进入状态 Schema 合并
  ├─ wrap_model_call → 进入模型包装栈
  └─ after_model    → 进入 after_model 图节点列表
```

### `ShellToolMiddleware` 的装配贡献

Shell 中间件除了注册工具，还要把会话资源放入 State。它的两个生命周期方法决定了它会出现在 Agent 图的起点和终点：

```python
@override
def before_agent(self, state, runtime) -> dict[str, Any] | None:
    # Agent 开始时创建或恢复持久 shell 会话
    resources = self._get_or_create_resources(state)
    return {"shell_session_resources": resources}

@override
def after_agent(self, state, runtime) -> None:
    # Agent 结束时关闭会话并释放资源
    resources = state.get("shell_session_resources")
    if not isinstance(resources, _SessionResources):
        return
    try:
        self._run_shutdown_commands(resources.session)
    finally:
        resources.finalizer()
```

因此 Shell 的装配位置是：

```text
tools
  → ToolNode 可以执行 shell
state_schema
  → State 可以保存 shell_session_resources
before_agent
  → 启动或恢复会话
after_agent
  → 关闭会话
```

`FilesystemFileSearchMiddleware` 只增加 `glob_search` 和 `grep_search`，它没有自己的状态 Schema，也没有参与模型包装。它的工程边界集中在 `root_path`、路径穿越校验、ripgrep/Python fallback 和文件大小限制。

这里还要注意：工具注入只说明“客户端有执行入口”，不等于自动获得权限控制、沙箱隔离、超时预算或输出脱敏。

## 3. 收集工具包装器

工厂第二次按能力扫描中间件时，处理 `wrap_tool_call`：

```python
middleware_w_wrap_tool_call = [
    middleware_item
    for middleware_item in middleware
    if middleware_item.__class__.wrap_tool_call is not AgentMiddleware.wrap_tool_call
    or middleware_item.__class__.awrap_tool_call is not AgentMiddleware.awrap_tool_call
]
```

然后把包装器交给 `ToolNode`：

```python
tool_node = (
    ToolNode(
        tools=available_tools,
        wrap_tool_call=wrap_tool_call_wrapper,
        awrap_tool_call=awrap_tool_call_wrapper,
    )
    if available_tools or wrap_tool_call_wrapper or awrap_tool_call_wrapper
    else None
)
```

当前属于这个装配阶段的内置中间件：

| 内置中间件 | 进入 ToolNode 后做什么 |
| --- | --- |
| `ToolRetryMiddleware` | 捕获工具异常，按策略重试，失败后返回错误 `ToolMessage` 或继续抛错 |
| `LLMToolEmulator` | 对选中的工具短路真实执行，用另一个模型生成模拟 `ToolMessage` |

这两个中间件不增加工具，它们只包住已经存在的工具执行。尤其要注意 `ToolRetryMiddleware` 的副作用边界：查询类工具和写入类工具不能默认使用同一套重试策略。

## 4. 收集节点 Hook

工具节点准备好以后，工厂分别建立四个列表：

```python
middleware_w_before_agent = [...]
middleware_w_before_model = [...]
middleware_w_after_model = [...]
middleware_w_after_agent = [...]
```

这里的 `[...]` 表示 `factory.py` 中四段结构相同的列表推导，判断条件都是“子类是否重写了对应同步或异步方法”。不是所有内置中间件都会进入所有列表。

### 各列表中的预构建中间件

| 收集列表 | 当前内置成员 | 装配目的 |
| --- | --- | --- |
| `before_agent` | `ShellToolMiddleware` | 创建或恢复运行级 shell 资源 |
| `before_model` | `ModelCallLimitMiddleware`、`SummarizationMiddleware`、`PIIMiddleware` | 在模型调用前检查次数、压缩历史或处理输入 |
| `after_model` | `ModelCallLimitMiddleware`、`ToolCallLimitMiddleware`、`HumanInTheLoopMiddleware`、`PIIMiddleware`、`TodoListMiddleware` | 处理模型刚生成的 AI 消息、工具调用和输出 |
| `after_agent` | `ShellToolMiddleware` | 释放运行级资源 |

### 一个内置中间件为什么会进入多个列表

`PIIMiddleware` 是典型例子：

```text
PIIMiddleware
  ├─ before_model → 检查用户输入和工具结果
  ├─ after_model  → 检查 AI 输出
  └─ transformers  → 检查流式输出和工具结果事件
```

`ModelCallLimitMiddleware` 也同时进入 `before_model` 和 `after_model`：

```text
ModelCallLimitMiddleware
  ├─ state_schema  → 保存 thread/run 计数
  ├─ before_model  → 判断是否已经达到上限
  └─ after_model   → 完成一次调用后递增计数
```

这不是两个中间件实例，而是工厂从同一个实例上分别读取不同方法。

### 运行时顺序只在这里做定位

如果用户传入：

```python
middleware = [A(), B(), C()]
```

四类 Hook 的连接关系是：

```text
before_agent: A → B → C
before_model: A → B → C
after_model:  C → B → A
after_agent:  C → B → A
```

这一点在 04 篇已经解释过。本篇只保留它，是为了看懂内置中间件在主循环中的落点：

```text
START
  → before_agent（一次）
  → before_model
  → model
  → after_model
  → tools
  → before_model
  → ...
  → after_agent（一次）
  → END
```

## 5. 收集模型包装器

接下来工厂扫描 `wrap_model_call` 和 `awrap_model_call`，把它们组合成模型节点内部的调用链。这个阶段不新增图节点，只改变一次模型请求的处理方式。

当前属于这个装配阶段的预构建中间件：

| 内置中间件 | 对 `ModelRequest` 做的事 |
| --- | --- |
| `ModelRetryMiddleware` | 在同一模型请求上重复调用 handler |
| `ModelFallbackMiddleware` | 失败后用 `request.override(model=备用模型)` 更换模型 |
| `ContextEditingMiddleware` | 复制消息列表，删除或编辑上下文后再调用模型 |
| `TodoListMiddleware` | 把 Todo 使用规则追加到系统提示词 |
| `LLMToolSelectorMiddleware` | 先调用选择模型，筛选主模型本轮可见的工具 |
| `ProviderToolSearchMiddleware` | 把工具延迟加载，并加入提供商原生的工具搜索定义 |

### 这个阶段的实际装配顺序

工厂只按 `middleware` 列表收集包装器，包装器的外层和内层由注册顺序决定：

```text
middleware=[A(), B(), C()]

A.wrap_model_call(
    B.wrap_model_call(
        C.wrap_model_call(
            _execute_model_sync
        )
    )
)
```

因此内置中间件之间没有一套固定的“官方先后顺序”。例如同时使用重试和回退时，应该由应用根据语义决定注册顺序：

```text
回退包住重试
  → 主模型重试耗尽后才尝试备用模型

重试包住回退
  → 每次重试都可能重新执行主模型/备用模型选择
```

这里要追的是**预构建中间件被放进哪个包装层**，而不是再学习包装器协议本身。

## 6. 收集并合并状态 Schema

模型包装器收集完成后，工厂把所有中间件的 `state_schema` 与用户显式传入的 `state_schema` 合并：

```python
base_state = state_schema if state_schema is not None else AgentState

# 中间件状态先放入列表，用户显式传入的状态 Schema 最后处理
state_schemas: list[type] = [*(m.state_schema for m in middleware), base_state]

resolved_state_schema, input_schema, output_schema = _resolve_schemas(state_schemas)
```

当前明确提供自定义状态 Schema 的内置中间件：

| 内置中间件 | 主要字段 | 这个字段服务于什么 |
| --- | --- | --- |
| `ModelCallLimitMiddleware` | `thread_model_call_count`、`run_model_call_count` | 限额判断和计数 |
| `ToolCallLimitMiddleware` | thread/run 级工具计数 | 工具调用限制 |
| `TodoListMiddleware` | `todos` | 保存任务清单 |
| `ShellToolMiddleware` | `shell_session_resources` | 复用和释放 shell 会话 |

`SummarizationMiddleware`、`ContextEditingMiddleware` 和 `PIIMiddleware` 会读写已有的 `messages`，但当前实现不靠新增业务状态字段工作。它们的差别在处理位置，不在 Schema 扩展。

这里特别值得对照 05 篇：

```text
state_schema
  → 进入图状态，字段更新会传给后续节点

request.override(...)
  → 只改变当前模型或工具 handler 看到的请求
```

例如 Todo 的 `todos` 是图状态；Todo 追加的系统提示词只是当前模型请求的临时视图。

## 7. 根据收集结果添加节点和边

工厂会固定添加 `model` 节点和有需要时的 `tools` 节点，再为四类 Hook 添加对应节点：

```python
graph.add_node("model", RunnableCallable(model_node, amodel_node, trace=False))

if tool_node is not None:
    graph.add_node("tools", tool_node)

# 对每个真正重写 before_model 的中间件添加一个图节点
graph.add_node(
    f"{middleware_item.name}.before_model",
    before_node,
    input_schema=resolved_state_schema,
)
```

这个阶段可以按内置中间件反查它们在图中的位置：

| 内置中间件 | 图中能看到的节点 |
| --- | --- |
| `ShellToolMiddleware` | `ShellToolMiddleware.before_agent`、`ShellToolMiddleware.after_agent` |
| `ModelCallLimitMiddleware` | `ModelCallLimitMiddleware.before_model`、`ModelCallLimitMiddleware.after_model` |
| `ToolCallLimitMiddleware` | `ToolCallLimitMiddleware.after_model` |
| `HumanInTheLoopMiddleware` | `HumanInTheLoopMiddleware.after_model` |
| `SummarizationMiddleware` | `SummarizationMiddleware.before_model` |
| `PIIMiddleware` | `PIIMiddleware.before_model`、`PIIMiddleware.after_model` |
| `TodoListMiddleware` | `TodoListMiddleware.after_model` |

模型包装器、工具包装器不会在这张节点表里出现。它们挂在 `model` 或 `tools` 节点内部。

图边的整体关系仍然是：

```text
START
  → before_agent
  → before_model
  → model
  → after_model
  → tools
  → before_model
```

`after_model` 根据 AI 消息里有没有 `tool_calls` 决定进入工具节点还是结束；`after_agent` 只接在最终退出路径上。于是：

- Shell 会话只在整次运行开始时创建一次；
- 模型限额每次进入模型前都检查；
- 工具限额在模型生成工具调用后统计；
- HITL 在模型已经决定调用危险工具后暂停；
- 摘要和 PII 输入处理在下一次模型调用前生效。

## 8. 最后收集 Transformer 并编译

所有节点和边准备好之后，工厂最后收集中间件的 `transformers`：

```python
middleware_transformers = [
    transformer
    for middleware_item in middleware
    for transformer in getattr(middleware_item, "transformers", ())
]

return graph.compile(
    checkpointer=checkpointer,
    store=store,
    transformers=[
        ToolCallTransformer,
        SubagentTransformer,
        *middleware_transformers,
        *(transformers or ()),
    ],
)
```

当前内置中，`PIIMiddleware` 最典型。开启模型输出或工具结果处理时，它会设置 `_PIIStreamTransformer`：

```python
if self.apply_to_output or self.apply_to_tool_results:
    # 输出侧开启脱敏时，同时处理流式事件
    self.transformers = (
        partial(
            _PIIStreamTransformer,
            rule=self._resolved_rule,
        ),
    )
```

因此 PII 的装配路径是：

```text
PIIMiddleware
  ├─ before_model  → State 中的用户输入、工具结果
  ├─ after_model   → State 中的 AI 输出
  └─ Transformer   → 编译图产生的流式事件
```

Transformer 是编译期事件处理，不是另一个 State 节点。只修改 `before_model`，不能自动保证 `stream()` 对外暴露的数据也被处理。

可以用一次嵌套 Agent 调用来理解 `SubagentTransformer`：

```text
父 Agent
  → 工具调用一个命名子 Agent
  → 子 Agent 开始运行
  → SubagentTransformer 识别这条嵌套运行边界
  → 父运行收到 run.subagents 中的子 Agent 流句柄
```

如果只是普通的 `model → tools → model` 循环，Transformer 不会替你改变图的路由；它只处理这条运行线上已经产生的事件。

## 预构建中间件的装配索引

把前面的内容压缩成一张源码索引：

| 装配阶段 | 内置中间件 |
| --- | --- |
| `middleware.tools` | `TodoListMiddleware`、`ShellToolMiddleware`、`FilesystemFileSearchMiddleware` |
| `wrap_tool_call` | `ToolRetryMiddleware`、`LLMToolEmulator` |
| `before_agent` | `ShellToolMiddleware` |
| `before_model` | `ModelCallLimitMiddleware`、`SummarizationMiddleware`、`PIIMiddleware` |
| `after_model` | `ModelCallLimitMiddleware`、`ToolCallLimitMiddleware`、`HumanInTheLoopMiddleware`、`PIIMiddleware`、`TodoListMiddleware` |
| `wrap_model_call` | `ModelRetryMiddleware`、`ModelFallbackMiddleware`、`ContextEditingMiddleware`、`TodoListMiddleware`、`LLMToolSelectorMiddleware`、`ProviderToolSearchMiddleware` |
| `state_schema` | `ModelCallLimitMiddleware`、`ToolCallLimitMiddleware`、`TodoListMiddleware`、`ShellToolMiddleware` |
| `transformers` | `PIIMiddleware` |
| `after_agent` | `ShellToolMiddleware` |

## 按内置中间件反查装配路径

### 调用限制

- `ModelCallLimitMiddleware`：先进入 `state_schema` 合并，再进入 `before_model` 和 `after_model` 节点。
- `ToolCallLimitMiddleware`：先进入 `state_schema` 合并，之后只进入 `after_model`，因为它需要读取模型刚生成的工具调用。

### 模型调用治理

- `ModelRetryMiddleware`：只进入 `wrap_model_call`，不会增加图节点。
- `ModelFallbackMiddleware`：只进入 `wrap_model_call`，通过覆盖 `request.model` 切换备用模型。

### 工具调用治理

- `ToolRetryMiddleware`：只进入 `wrap_tool_call`，由 `ToolNode` 调用。
- `LLMToolEmulator`：只进入 `wrap_tool_call`，可以绕过真实工具执行。
- `HumanInTheLoopMiddleware`：进入 `after_model`，在工具节点之前拦截待审批的工具调用。

### 上下文与隐私

- `SummarizationMiddleware`：进入 `before_model`，触发时用摘要和保留消息替换旧历史。
- `ContextEditingMiddleware`：进入 `wrap_model_call`，每次模型调用前临时编辑消息。
- `PIIMiddleware`：进入 `before_model`、`after_model`，配置输出侧时还进入 `transformers`。

### 工具注入与动态化

- `TodoListMiddleware`：同时进入 `tools`、`state_schema`、`wrap_model_call` 和 `after_model`，是扩展面最多的内置实现。
- `ShellToolMiddleware`：同时进入 `tools`、`state_schema`、`before_agent` 和 `after_agent`，负责运行级资源。
- `FilesystemFileSearchMiddleware`：只进入 `tools`，核心约束在文件根目录和路径校验。
- `LLMToolSelectorMiddleware`：进入 `wrap_model_call`，先筛选工具再调用主模型。
- `ProviderToolSearchMiddleware`：进入 `wrap_model_call`，按提供商能力把工具改成延迟加载。

## 以 Harness 思路组装一套 Agent

如果把 Agent 看成一个 Harness，模型和工具是中间的执行核心，Middleware 则是包在核心外面的运行外壳：

```text
输入边界
  → 上下文整理
  → 任务规划
  → 模型可靠性
  → 工具执行
  → 风险审批
  → 资源释放
```

这个顺序不是 LangChain 内置的固定清单，而是一套工程上的推荐组织方式。真正写入 `middleware=[...]` 时，还要考虑同一实例可能同时实现多个扩展面，以及 `after_model` 按注册顺序反向执行。

### 一套可落地的注册顺序

下面给出一套适合“需要规划、文件操作、上下文控制和危险工具审批”的 Harness 示例。代码中的模型、工具和路径只是示例，重点是 `middleware` 列表的组织方式：

```python
from langchain.agents import create_agent
from langchain.agents.middleware import (
    ClearToolUsesEdit,
    ContextEditingMiddleware,
    FilesystemFileSearchMiddleware,
    HumanInTheLoopMiddleware,
    ModelCallLimitMiddleware,
    ModelFallbackMiddleware,
    ModelRetryMiddleware,
    PIIMiddleware,
    ShellToolMiddleware,
    SummarizationMiddleware,
    TodoListMiddleware,
    ToolCallLimitMiddleware,
    ToolRetryMiddleware,
    LLMToolEmulator,
)
from langgraph.checkpoint.memory import MemorySaver

middleware = [
    # 1. 输入边界：尽早处理输入；after_model 反向执行时会最后处理输出
    PIIMiddleware(
        "email",
        strategy="redact",
        apply_to_input=True,
        apply_to_output=True,
        apply_to_tool_results=True,
    ),

    # 2. 运行预算：模型达到上限时，先结束，不再进入后续模型调用
    ModelCallLimitMiddleware(
        run_limit=20,
        thread_limit=100,
        exit_behavior="end",
    ),

    # 3. 上下文控制：只有通过预算检查后，才进行摘要
    SummarizationMiddleware(
        model=summary_model,
        trigger=("tokens", 8_000),
        keep=("messages", 20),
    ),

    # 4. 工具风险治理：先限制工具次数，再进入人工审批
    HumanInTheLoopMiddleware(
        interrupt_on={
            "shell": {"allowed_decisions": ["approve", "reject"]},
            "write_file": {"allowed_decisions": ["approve", "edit", "reject"]},
        }
    ),
    ToolCallLimitMiddleware(
        run_limit=30,
        thread_limit=200,
        exit_behavior="continue",
    ),

    # 5. 运行资源和客户端工具：会被收集到 tools / state_schema / 生命周期 Hook
    ShellToolMiddleware(workspace_root="/workspace"),
    FilesystemFileSearchMiddleware(root_path="/workspace"),

    # 6. 模型调用栈：故障回退在外，当前模型重试在内
    ModelFallbackMiddleware("anthropic:claude-sonnet-4-5"),
    ModelRetryMiddleware(max_retries=2),

    # 7. 请求整理：在真正调用模型前筛选工具、编辑历史并补充 Todo 规则
    ContextEditingMiddleware(edits=[ClearToolUsesEdit(trigger=20_000, keep=3)]),
    TodoListMiddleware(),

    # 8. 工具执行栈：模拟工具在外，真实工具重试在内
    LLMToolEmulator(tools=["search"]),
    ToolRetryMiddleware(max_retries=2),
]

agent = create_agent(
    model=main_model,
    tools=[search, write_file],
    middleware=middleware,
    # HITL 需要 Checkpointer 保存中断前的状态
    checkpointer=MemorySaver(),
)
```

这里的注册顺序是经过 Hook 方向换算后的结果，不是把“安全、上下文、工具”几个词简单排列：

```text
middleware 列表中的关键顺序
  PII
  → ModelCallLimit
  → Summarization
  → HumanInTheLoop
  → ToolCallLimit
  → ...
  → ModelFallback
  → ModelRetry
  → ContextEditing
  → TodoList
  → LLMToolEmulator
  → ToolRetry
```

### 这一个列表实际会展开成什么

同一个 `middleware` 列表会被工厂拆成不同的执行路径：

```text
before_agent
  → ShellToolMiddleware

before_model
  → PIIMiddleware
  → ModelCallLimitMiddleware
  → SummarizationMiddleware

模型包装栈（外层 → 内层）
  → ModelFallbackMiddleware
  → ModelRetryMiddleware
  → ContextEditingMiddleware
  → TodoListMiddleware

after_model（运行时反向执行）
  → TodoListMiddleware
  → ToolCallLimitMiddleware
  → HumanInTheLoopMiddleware
  → ModelCallLimitMiddleware
  → PIIMiddleware

工具包装栈（外层 → 内层）
  → LLMToolEmulator
  → ToolRetryMiddleware

after_agent
  → ShellToolMiddleware
```

因此一次带工具的运行可以这样理解：

```text
启动 shell 会话
  → 输入 PII 处理
  → 检查模型预算
  → 必要时摘要
  → ModelFallback(
       ModelRetry(
         ContextEditing(
           TodoList(
             调用模型
           )
         )
       )
     )
  → Todo 检查本轮更新
  → 检查工具预算
  → 危险工具触发人工审批
  → LLMToolEmulator(
       ToolRetry(
         执行真实工具
       )
     )
  → 回到下一轮 before_model
  → Agent 结束后关闭 shell
```

### 为什么不能只看列表从上到下

`middleware=[A(), B(), C()]` 只对不同扩展面产生不同含义：

| 扩展面 | 运行顺序 |
| --- | --- |
| `before_agent` | `A → B → C` |
| `before_model` | `A → B → C` |
| `after_model` | `C → B → A` |
| `after_agent` | `C → B → A` |
| `wrap_model_call` | 列表前面的包装器在外层 |
| `wrap_tool_call` | 列表前面的包装器在外层 |

所以 Harness 设计时要先写出每个内置中间件实现了哪些扩展面，再分别检查四条路径。尤其是下面三组关系：

- `ModelFallbackMiddleware` 放在 `ModelRetryMiddleware` 外面，表示主模型先重试，重试耗尽后才回退；
- `LLMToolEmulator` 放在 `ToolRetryMiddleware` 外面，模拟工具时可以直接短路，不触发真实工具重试；
- `PIIMiddleware` 放在注册列表前面，使输入侧尽早处理，而 `after_model` 反向执行时尽量靠后处理模型输出。

### 不是所有内置中间件都应该一起启用

上面的完整列表用于展示装配关系，不代表生产 Agent 应该全部启用。实际 Harness 通常按场景裁剪：

```text
最小可靠 Agent
  ModelCallLimit
  + ModelRetry
  + ToolRetry

带审批的执行 Agent
  ModelCallLimit
  + ToolCallLimit
  + HumanInTheLoop
  + Checkpointer

长任务 Agent
  TodoList
  + Summarization 或 ContextEditing
  + ModelRetry
  + ToolRetry

大工具集 Agent
  LLMToolSelector
  或 ProviderToolSearch
```

Harness 的价值不在于把中间件堆满，而在于让每一层责任有固定位置：输入先过边界，模型调用有预算和恢复策略，工具执行有重试和审批，运行结束后释放资源，流式事件再单独处理。

## 最后只保留一个判断方法

读任何一个预构建中间件时，沿着下面的顺序查：

```text
1. 它有没有 tools？
2. 它有没有 wrap_tool_call？
3. 它重写了哪几个 before/after Hook？
4. 它有没有 wrap_model_call？
5. 它有没有 state_schema？
6. 它有没有 transformers？
```

这六个问题就能把一个内置中间件放回 `create_agent()` 的装配流程中。至于 Hook 的调用顺序、状态更新如何合并、Interrupt 如何恢复，分别回到 04 和 05 篇，不在本篇重复展开。
