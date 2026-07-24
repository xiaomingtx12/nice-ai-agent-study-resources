---
sidebar_position: 2
description: LangChain 1.3.7 `create_agent()` 主线拆解。按 factory.py 真实执行顺序展开五个构建阶段（归一化、中间件组合、状态解析、图拓扑组装、编译配置），逐阶段标位置、讲机制、给边界，最后给出与手写 Agent 循环的工程判断。
---

# 以 `create_agent()` 为主线：LangChain/LangGraph Agent 开发全景

> **适用版本**：`langchain` **1.3.7**（`libs/langchain_v1/`）
>
> **源码入口**：libs/langchain_v1/langchain/agents/factory.py（1981 行）
>
> **阅读路径**：本文按 `create_agent()` **真实执行顺序**展开。先给"代码地图"（§二），再按五个构建阶段逐步深入（§三 ~ §七），最后看使用模式（§八）。每个阶段涉及到的概念都嵌入到该阶段内讲解。

---

## 一、一句话定位

`create_agent()` 是 LangChain 提供的一个 Agent Harness 工厂函数。它接收 `model`（用哪个模型）、`tools`（让模型能用什么工具）、`middleware`（横切关切的拦截器）、`response_format`（要不要强制结构化输出）这些原料，吐出一个可以直接 `.invoke()` 的 LangGraph `CompiledStateGraph`——也就是一张已编译、可立即执行的状态图。图内部以"模型节点 ↔ 工具节点"循环执行，并通过中间件管道实现重试、限额、人工审核等横切关切。

调用栈自顶向下，工厂依次经历 **五个构建阶段**：

1. **归一化**（942–1056）：把字符串 `model` 转成 `BaseChatModel`、把工具划分为 `built_in` / `regular`、解析 `response_format` 包装策略。
2. **中间件收集与组合**（986–1125）：按钩子类型归类，组成 `wrap_*` 调用栈与 `before/after_*` 节点列表。
3. **状态解析**（1127–1135）：合并中间件声明的 `state_schema`，生成三套 schema（state / input / output）。
4. **图拓扑组装**（1138–1750）：构造 `StateGraph`、添加节点与边。条件边按场景动态决定目的集。
5. **编译与配置**（1752–1775）：`graph.compile(...)` 挂上 `ToolCallTransformer`、`SubagentTransformer`、中间件声明的 transformers，并通过 `with_config` 注入 `recursion_limit=9_999` 与 LangSmith 标签。

下文按这个顺序逐步展开，每节聚焦该阶段需要解释的概念。

---

## 二、代码地图：先看文件组织，再看阶段串联

钻进 `create_agent` 之前，先看一眼所有相关源码在仓库里是怎么摆的、彼此怎么引用。这张"地图"能帮你把后面所有阶段的内容定位到具体文件。

### 2.1 顶层代码树

`create_agent` 的所有实现都在一个目录里：`libs/langchain_v1/langchain/agents/`。

```
libs/langchain_v1/langchain/agents/
├── __init__.py                # 公共入口：只导出 create_agent 和 AgentState
│
├── factory.py                 # 主体工厂（≈1981 行）——五个构建阶段都在这里
│                              #   - @overload 三套签名        (line 718-784)
│                              #   - create_agent() 真正实现    (line 787-940)
│                              #   - 阶段 1 归一化             (line 942-1056)
│                              #   - 阶段 2 中间件收集与组合   (line 986-1125)
│                              #   - 阶段 3 状态解析           (line 1127-1135)
│                              #   - 阶段 4 图拓扑组装         (line 1138-1750)
│                              #   - 阶段 5 编译与配置         (line 1752-1775)
│                              #   - 路由函数（_make_*_edge） (line 1778-1928)
│                              #   - 边辅助函数 _add_middleware_edge (line 1931-1976)
│
├── structured_output.py       # 结构化输出策略（≈463 行）
│                              #   - 三种策略: AutoStrategy / ProviderStrategy / ToolStrategy
│                              #   - 绑定辅助: OutputToolBinding / ProviderStrategyBinding
│                              #   - 异常类型: StructuredOutputError 家族
│
├── _subagent_transformer.py   # SubagentTransformer 流转换器（多 Agent 嵌套时用）
│
└── middleware/                # 中间件相关
    ├── __init__.py            # 公共入口：导出所有内置中间件 + 装饰器
    ├── types.py               # AgentMiddleware 基类、六个钩子、ModelRequest/Response、装饰器（≈2161 行）
    │
    ├── _execution.py          # 共享基类：ShellToolMiddleware 用的执行策略（Host/Docker/CodexSandbox）
    ├── _redaction.py          # 共享基类：PII 中间件用的脱敏规则
    ├── _retry.py              # 共享基类：ModelRetry/ToolRetry 共用的退避/异常筛选
    │
    ├── context_editing.py     # ContextEditingMiddleware（wrap_model_call 裁剪工具结果）
    ├── file_search.py         # FilesystemFileSearchMiddleware（tools 注入 glob_search/grep_search）
    ├── human_in_the_loop.py   # HumanInTheLoopMiddleware（after_model 触发 interrupt）
    ├── model_call_limit.py    # ModelCallLimitMiddleware（before/after_model + state_schema）
    ├── model_fallback.py      # ModelFallbackMiddleware（wrap_model_call 切备用模型）
    ├── model_retry.py         # ModelRetryMiddleware（wrap_model_call 重试）
    ├── pii.py                 # PIIMiddleware（before/after_model + transformers）
    ├── provider_tool_search.py# ProviderToolSearchMiddleware（wrap_model_call 延迟加载工具）
    ├── shell_tool.py          # ShellToolMiddleware（before/after_agent + state_schema + tools）
    ├── summarization.py       # SummarizationMiddleware（before_model 压缩历史）
    ├── todo.py                # TodoListMiddleware（wrap_model_call + after_model + state_schema + tools）
    ├── tool_call_limit.py     # ToolCallLimitMiddleware（after_model + state_schema）
    ├── tool_emulator.py       # LLMToolEmulator（wrap_tool_call 用 LLM 模拟工具返回）
    ├── tool_retry.py          # ToolRetryMiddleware（wrap_tool_call 重试）
    └── tool_selection.py      # LLMToolSelectorMiddleware（wrap_model_call 动态选工具）
```

文件命名前缀 `_` 表示"内部模块"。按 Python 惯例，下划线开头意味着"对外不保证稳定 API"。不过本目录里它们其实是给同目录其他中间件共享用的工具——`_execution.py` 给 `shell_tool.py` 用，`_retry.py` 给 `model_retry.py` 和 `tool_retry.py` 共用，等等。

### 2.2 文件组织：四个职责层

把这些文件按"做什么"重新归类，会更清楚：

| 层 | 文件 | 职责 |
|---|---|---|
| **1. 入口层** | `agents/__init__.py` | 只对外暴露 `create_agent` 和 `AgentState` 两个名字。用户 `from langchain.agents import create_agent` 就是从这里拿。 |
| **2. 工厂层** | `agents/factory.py` | 主战场。五个构建阶段的代码全在这里。它依赖下面所有层，但自己对外保持单一 API。 |
| **3. 类型与中间件基础设施** | `agents/middleware/types.py` | `AgentMiddleware` 基类、六个钩子、`ModelRequest/Response`、`@before_model` 等装饰器。 |
| **4. 业务能力** | `agents/structured_output.py` | 结构化输出三策略。 |
| | `agents/_subagent_transformer.py` | 子图流转换。 |
| | `agents/middleware/*.py` | 14 个内置中间件 + 3 个共享基类（`_execution` / `_redaction` / `_retry`）。 |

依赖方向（自上而下、单向）：

```
入口层  ──→  工厂层  ──→  类型与中间件基础设施
                  │
                  ├──→  业务能力：structured_output.py
                  ├──→  业务能力：_subagent_transformer.py
                  └──→  业务能力：middleware/*.py（每个内置中间件都依赖 types.py）
```

工厂层是"汇聚点"。所有能力都从这里调用，但各能力之间不必互相依赖。

### 2.3 阶段串联：从 `create_agent()` 到返回的 `CompiledStateGraph`

把工厂内部真实的执行顺序画出来。下图是工厂从入口到返回 `CompiledStateGraph` 的完整流水线：

```
create_agent(model, tools, middleware, response_format, ...)
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 1 归一化（942–1056）                                         │
│   • 字符串 model ─→ init_chat_model() ─→ BaseChatModel 实例         │
│   • tools 划分为 built_in / regular / middleware_tools            │
│   • 裸 schema ─→ AutoStrategy；提前造好 ToolStrategy 备用            │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 2 中间件收集与组合（986–1125）                                  │
│   • 按钩子类型归类 → 4 个 before/after_* 节点列表                   │
│                → 2 个 wrap_* 调用栈（sync / async 各一份）           │
│   • traceable 包裹 + 组合成调用栈                                   │
│   • 创建 ToolNode（如果 available_tools 非空 或 有 wrap_tool_call）  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 3 状态解析（1127–1135）                                        │
│   • 合并 [m.state_schema, ..., AgentState] → resolved/input/output │
│   • 创建 StateGraph(state=..., input=..., output=..., context=...) │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 4 图拓扑组装（1138–1750）                                      │
│   • 添加节点: model / tools / 每个中间件的钩子节点                   │
│   • 添加边: START → entry、4 个条件边（用 _make_*_edge /           │
│     _add_middleware_edge）、各 before/after_* 节点之间的链式边        │
│   • 关键决策: _get_bound_model / _handle_model_output / _resolve_jump│
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 阶段 5 编译与配置（1752–1775）                                       │
│   • graph.compile(checkpointer, store, interrupt_*, debug, ...)     │
│   • 挂 transformer=[ToolCallTransformer, SubagentTransformer, ...]  │
│   • 配 recursion_limit=9_999 + ls_integration 标签                  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
   CompiledStateGraph（用户拿到这张图，调 .invoke() / .stream()）
```

后文 **§三 ~ §七** 按这个流水线从顶到底逐步展开。每个阶段都会回到 `factory.py` 的具体行号，并顺带引入它依赖的概念。

### 2.4 工厂入口的三套 `@overload` 签名

`factory.py` 顶端用 `@overload` 写了三份签名（factory.py:718-784），下面再写一份真正实现（factory.py:787+）。这是 Python 静态类型系统的工具——运行时只有最后那份实现干活，前面 `@overload` 签名只给类型检查器看，用来在不同 `response_format` 形态下推断出更精确的返回类型 `ResponseT`。

```python
# 三份签名（仅静态类型推断用，运行时是空的）：
@overload
def create_agent(model, tools=..., *, response_format: None = None, ...
                 ) -> CompiledStateGraph[AgentState[Any], ...]: ...

@overload
def create_agent(model, tools=..., *, response_format: dict[str, Any], ...
                 ) -> CompiledStateGraph[AgentState[dict[str, Any]], ...]: ...

@overload
def create_agent(model, tools=..., *, response_format: ResponseFormat[R] | type[R] | None, ...
                 ) -> CompiledStateGraph[AgentState[R], ...]: ...

# 真正实现（运行时只有这一份干活）：
def create_agent(model, tools=..., *, response_format=..., ...):
    ...
```

三份签名分别对应：`response_format` 不传 → `ResponseT=Any`；传 `dict` → `ResponseT=dict[str, Any]`；传 Pydantic 类 / `ToolStrategy[X]` / `ProviderStrategy[X]` → `ResponseT=X`。这样 IDE 能精确推断 `result["structured_response"]` 的类型。


## 三、阶段 1：模型与工具归一化（942–1056）

这一阶段把"用户输入的字符串、dict、callable"全部转换为图能直接消费的 `BaseChatModel` 和 `ToolNode`。`ToolNode` 是 LangGraph 的预制节点，负责按模型返回的 `tool_calls` 调度实际工具并把结果回灌成 `ToolMessage`。

### 3.1 model 归一化：`init_chat_model`

工厂第一步（factory.py:942-943）是把字符串形式的 model 解析为 `BaseChatModel` 实例：

```python
if isinstance(model, str):
    model = init_chat_model(model)
```

`init_chat_model` 是 LangChain 把 `"openai:gpt-5.5"`、`"anthropic:claude-haiku-4-5-20251001"` 这类字符串解析为 `BaseChatModel` 实例的统一入口。它支持的前缀有：`openai:` / `anthropic:` / `bedrock:` / `google_vertexai:` / `cohere:` / `fireworks:` / `mistralai:` / `deepseek:` / `xai:` / `perplexity:` / `upstage:`。不带前缀的"裸"模型名也能做尽力推断。

还有"可配置模型"用法——`init_chat_model(configurable_fields=["model", "model_provider"])` 允许在 `config={"configurable": {"model": ...}}` 中运行时切换。这是 LangGraph 做 A/B 实验与灰度的入口。

> **`BaseChatModel` 的继承层次**：`RunnableSerializable → BaseLanguageModel → BaseChatModel`。Runnable 是 LangChain 的"可调用 + 可流式 + 可批处理"统一接口。`BaseLanguageModel` 是所有语言模型的抽象基类。`BaseChatModel` 在它之上要求按消息列表（`BaseMessage`）输入输出。必选抽象是 `_generate(messages, stop, run_manager) → ChatResult`（同步实际生成方法）和 `_llm_type` 属性（字符串类型标识）。`bind_tools(tools, **kwargs) → Runnable` 是 create_agent 把工具清单钉到模型上的关键钩子。`profile: ModelProfile` 存储 `structured_output` 等能力标志，会被 `response_format` 阶段读取。

### 3.2 system_prompt 归一化

factory.py:946-951：

```python
if system_prompt is not None:
    if isinstance(system_prompt, SystemMessage):
        system_message = system_prompt
    else:
        system_message = SystemMessage(content=system_prompt)
```

`str` → `SystemMessage` 的转换在工厂边界就完成。下游（model_node、middleware）拿到的是统一的 `SystemMessage`。

### 3.3 工具的两类划分

factory.py:1031-1056 把用户传入的 `tools` 划分成三类：

```python
built_in_tools = [t for t in tools if isinstance(t, dict)]        # 模型服务端执行
regular_tools = [t for t in tools if not isinstance(t, dict)]    # 本地执行
middleware_tools = [t for m in middleware for t in getattr(m, "tools", [])]
available_tools = middleware_tools + regular_tools               # 进 ToolNode（注意：不含 built_in_tools）
```

为什么要这么分？三种使用模式对应完全不同的执行位置：

- **`built_in_tools`**（dict）：只通过 `bind_tools` 传给模型，告诉模型"我有这个能力"（如 OpenAI `web_search`、`code_interpreter`）。实际执行发生在模型服务端，客户端不需要也无法处理。
- **`regular_tools`**（`BaseTool` / callable）：必须注册到 `ToolNode`，在本地执行。`callable` 会被 `ToolNode` 内部转成 `BaseTool`。
- **中间件声明的 `tools`**（`m.tools`）：和 `regular_tools` 一视同仁进 `ToolNode`。中间件还可以在 `wrap_model_call` 中动态改写 `request.tools`，这部分在阶段 4 谈 `request.override()` 时再展开。

`ToolNode` 只在 `available_tools` 非空 **或** 中间件定义了 `wrap_tool_call` 时才创建（factory.py:1039-1047）。即使没有显式工具，只要有中间件想包装工具调用，工厂也会建一个空 ToolNode 作为执行壳。

`default_tools`（line 1053-1056）是 model_node 构造 `ModelRequest` 时塞的默认工具清单。`ToolNode` 已把 callable 转换为 `BaseTool`，所以这里用 `tool_node.tools_by_name.values()` 而不是原始 callable。

> **`BaseTool` 的继承层次**：`RunnableSerializable → BaseTool → Tool / StructuredTool`。三种使用模式：`@tool`（裸装饰器，名字取自函数名）、`@tool("search", return_direct=True)`（名称覆盖 + 直接返回，即调完不进入下一轮模型）、`@tool(response_format="content_and_artifact", parse_docstring=True)`（配置参数）。

> 关键字段：`name`、`description`、`args_schema`、`handle_tool_error`、`return_direct`、`handle_validation_error`、`extras`。注入机制：`InjectedToolArg`、`InjectedToolCallId` 允许工具读取 graph state 和 tool_call_id 而无需把它们暴露给模型。这样能防止模型误以为这些是可调用参数。

---

## 四、阶段 2：中间件收集与组合（986–1125）

`create_agent()` 最具特色的部分就是中间件管道。这一阶段回答两个问题：

1. **一个中间件"能做什么"**——也就是它对外暴露哪些钩子（hook），每个钩子允许它做什么、不允许它做什么。
2. **多个中间件"怎么叠在一起"**——也就是工厂在编译期如何把这些钩子分门别类，串成可执行的调用栈或节点链。

整个阶段按"钩子是什么 → 钩子拿到的数据长啥样 → 钩子如何被组装 → 如何用更简洁的形式声明一个中间件 → 内置中间件一览"展开。

### 4.1 概念：六个钩子点（同步/异步成对）

types.py:383-811 定义 `AgentMiddleware` 六个钩子。每个钩子都有同步/异步变体：

| 钩子 | 风格 | 时机 | 典型用途 |
|---|---|---|---|
| `before_agent` | 观察者 | 整个 Agent 执行前（仅一次） | 加载用户偏好、初始化内存 |
| `before_model` | 观察者 | 每次模型调用前 | 上下文压缩、调用限制、消息脱敏 |
| `wrap_model_call` | 拦截器 | 包裹模型调用 | **重试 / 缓存 / 回退 / PII 检测** |
| `after_model` | 观察者 | 每次模型调用后 | 输出校验、日志、jump_to |
| `wrap_tool_call` | 拦截器 | 包裹每次工具执行 | **重试 / HITL 中断 / 工具模拟** |
| `after_agent` | 观察者 | 整个 Agent 执行后（仅一次） | 持久化、清理 |

六个钩子分两种风格——观察者和拦截器。它们的能力边界截然不同，决定了用它能实现什么。

- **观察者**（`before_*` / `after_*`）：返回一段状态更新字典。它**改不了调用本身**，只能在调用前改上下文、或在调用后读输出。模型该调几次就调几次，无法插手。
- **拦截器**（`wrap_*`）：拿到一个 `handler` 回调，可以决定**调不调、调几次**。这是中间件能实现"重试 / 缓存 / 回退"的核心机制。同一个 `ModelRequest` 在同一函数栈里可以被复用 n 次：拦截器命中缓存就跳过模型调用直接返回，模型失败就再用同一个 `ModelRequest` 重试一次。这些都是观察者做不到的事。

每个钩子的默认实现都是 `raise NotImplementedError`（types.py:574-584、types.py:732-742）。

如果只定义了 `awrap_model_call`（异步版）却用 `agent.invoke()`（同步调用），工厂会立刻抛 NotImplementedError 并打印三种修法：

- 补同步版
- 改成 `ainvoke()`
- 改用 `@wrap_model_call` 装饰器

这样错配不会静默走空。

### 4.2 概念：拦截器的 Request-Response 不可变重写

这一节讲 `wrap_model_call` 和 `wrap_tool_call` 拿到的数据长啥样、以及怎么改它们。这两个拦截器拿到的 Request 都采用"不可变重写"模式——任何修改都通过 `.override(...)` 返回新实例，原始对象保持不动：

```python
new_request = request.override(tools=[*request.tools, extra_tool])  # 正确
request.tools = [...]  # 触发 DeprecationWarning（types.py:192-198）
```

`override()` 内部用 `dataclasses.replace`（dataclasses 模块提供的"按字段替换返回新实例"工具函数）返回新实例。

这种不可变模式对**重试安全**至关重要：每次重试都用一个干净的请求快照，前面的层不会污染后面的层。这里的"层"就是 §4.3 要讲的中间件栈：`middleware=[A, B, C]` 意味着 A 是最外层、C 是最内层包住真实模型调用。每一层都基于上一层传下来的 ModelRequest 重写自己关心的字段。

以 `ModelRequest`（types.py:85-267）为例，字段有：`model` / `messages` / `system_message` / `tool_choice` / `tools` / `response_format` / `state` / `runtime` / `model_settings`。`state` 是完整 graph state，`runtime: Runtime[ContextT]` 提供 context / store / stream_writer。

**返回类型也有三种灵活度**（`ModelCallResult = ModelResponse | AIMessage | ExtendedModelResponse`，types.py:313-323）：

- `ModelResponse`（types.py:270-285）：`result: list[BaseMessage]` + `structured_response`，最通用。
- `AIMessage`：简写形式。工厂内部 `ModelResponse(result=[ai_msg], structured_response=None)`。
- `ExtendedModelResponse`（types.py:288-310）：在 `ModelResponse` 之外多带一个 `Command`（LangGraph 的"告诉图该怎么更新 state"的指令对象）。它用于在模型自己的返回值之外再附一条状态更新——比如顺手记一条日志到 state。

  `Command` 上的三个字段在 `wrap_model_call` 里还不支持：

  - `goto`：跳到某节点
  - `resume`：从中断恢复
  - `graph`：替换子图

  这三个字段会抛 `NotImplementedError`（factory.py:215-227）。要用的话，改用 `before_model` / `after_model` 钩子里的 `jump_to` 字段即可。

### 4.3 代码：拦截器钩子的组合（"列表第一个 = 最外层"）

这是中间件设计中最容易踩坑的规则。看 factory.py:234-323 `_chain_model_call_handlers()`：

```python
# 右到左组合：handlers[-1] 是最内层
composed_handler = compose_two(handlers[-2], handlers[-1])  # 内层包住 handler
for h in reversed(handlers[:-2]):
    composed_handler = compose_two(h, composed_handler)    # 外层依次包住内层
```

**为什么右到左？** 因为 `compose_two(a, b)` 表达的是"a 包住 b"。我们想要的效果是 `handlers[0]` 在最外层、`handlers[-1]` 在最内层包住模型本身。所以必须从末尾往前两两配对：先把两个最内层合成，再让更外层的依次套上去。

调用栈示意（`middleware=[retry, fallback, cache]`）：

```
cache (最外层)  →  fallback  →  retry  →  实际模型
   ↑命中即返回      ↑捕获异常切备用  ↑重试瞬时错误
```

`ExtendedModelResponse.command` 携带的 `Command` 会按"内层先、外层后"累积应用（`_to_composed_result`，factory.py:255-271）。对于非归约器字段（如 `structured_response`），最外层中间件覆盖内层。

`_chain_tool_call_wrappers()`（factory.py:605-650）结构相同——同步版；异步版在 factory.py:653-714。

### 4.4 代码：观察者钩子的分类与 traceable 包裹

观察者钩子不需要组合成调用栈，但需要在编译期按钩子类型归类——这样工厂才知道每个 `before_model` 节点要串哪些中间件、每个 `after_model` 节点又要串哪些。

factory.py:986-1113 按钩子类型归类中间件。检测方式是比较类的 `__dict__` 是否覆盖了基类的 `wrap_tool_call` / `awrap_tool_call` 等方法：

```python
middleware_w_wrap_tool_call = [
    m for m in middleware
    if m.__class__.wrap_tool_call is not AgentMiddleware.wrap_tool_call
    or m.__class__.awrap_tool_call is not AgentMiddleware.awrap_tool_call
]
```

具体规则是：sync 节点走 `wrap_tool_call` 列表，async 节点走 `awrap_tool_call` 列表。同步/异步任一被实现都会纳入对应栈。这样既保证 `invoke()` 走到同步栈，又避免另一端静默走空。这意味着可以只实现异步版（只写 `awrap_tool_call`），sync 调用方会立刻拿到明确的报错，而不是被悄悄短路。

**traceable 包裹**：每个钩子被 `langsmith.traceable(name=..., process_inputs=_scrub_inputs)` 包裹。`traceable` 是 LangSmith 提供的追踪装饰器，把每次调用上报为 trace span。`_scrub_inputs`（factory.py:141-150）会把 `runtime` 和 `handler` 从 trace inputs 中剥离，避免敏感数据上送。

### 4.5 概念：装饰器 API —— 函数即中间件

如果不想写完整的 `AgentMiddleware` 子类，types.py:867-2161 提供 7 个装饰器：`@before_model` / `@after_model` / `@before_agent` / `@after_agent` / `@dynamic_prompt` / `@wrap_model_call` / `@wrap_tool_call`。装饰器内部用 `type(name, (AgentMiddleware,), {...})()` 动态创建 `AgentMiddleware` 子类（types.py:1058-1069），自动检测同步/异步并路由到对应钩子。

每个装饰器支持 `can_jump_to=["end" | "tools" | "model"]` 元数据。`_get_can_jump_to()`（factory.py:490-524）会读取这个元数据，在阶段 4 自动建立条件边。

`can_jump_to` 的语义是：本钩子声明自己有权把执行流切到哪几个目标节点。

- 不声明：钩子只能老老实实串到下一个钩子。
- 声明了：钩子就能在 state 里写 `jump_to` 字段把控制流引开。

### 4.6 内置中间件目录（生产就绪）

下面这张表是阶段 4 的"使用案例库"。理解每个用了哪些钩子，能帮你推断它在图中的位置：

| 中间件 | 钩子 | 用途 |
|---|---|---|
| `ModelCallLimitMiddleware` | `before_model` + `after_model` + `state_schema` | 限制每次 run 的模型调用次数（成本控制），用 `ModelCallLimitState` 计数。 |
| `ToolCallLimitMiddleware` | `after_model` + `state_schema` | 限制工具调用次数，支持 `continue` / `error` / `end` 三种超限行为。 |
| `ModelRetryMiddleware` | `wrap_model_call` | 瞬时错误重试（与 `ToolRetryMiddleware` 共用 `_retry` 模块）。 |
| `ToolRetryMiddleware` | `wrap_tool_call` | 工具失败/无效输出重试。 |
| `ModelFallbackMiddleware` | `wrap_model_call` | 主模型失败按列表切备用模型。 |
| `HumanInTheLoopMiddleware` | `after_model` | 模型产生需审核的工具调用后触发 `interrupt`（同步阻塞等人决定），等待人工 approve / edit / reject / respond。 |
| `PIIMiddleware` | `before_model` + `after_model` + `transformers` | PII（Personally Identifiable Information，个人身份信息）检测与脱敏。在模型调用前检查输入消息，调用后检查模型输出（以及工具结果），按配置的策略（阻止 / 脱敏 / 掩码 / 哈希）处理。启用输出或工具结果处理时额外注册 `_PIIStreamTransformer`。 |
| `SummarizationMiddleware` | `before_model` | 历史超过阈值时压缩。 |
| `ContextEditingMiddleware` | `wrap_model_call` | 上下文达到阈值时自动裁剪工具结果。 |
| `ShellToolMiddleware` | `before_agent` + `after_agent` + `state_schema` + `tools` | 沙箱化执行 shell；注册 `shell` 工具；管理会话启动与清理（`_execution` 模块含 Host / Docker / CodexSandbox 三种策略）。 |
| `FilesystemFileSearchMiddleware` | `tools` | 提供 `glob_search` / `grep_search` 工具。 |
| `LLMToolSelectorMiddleware` | `wrap_model_call` | 用 LLM 动态选工具。 |
| `LLMToolEmulator` | `wrap_tool_call` | LLM 模拟工具调用（测试用）。 |
| `TodoListMiddleware` | `wrap_model_call` + `after_model` + `state_schema` + `tools` | 待办事项管理（`write_todos` 工具 + `PlanningState`）。 |
| `ProviderToolSearchMiddleware` | `wrap_model_call` | 把工具延迟到提供商原生工具搜索机制按需加载。 |

> **注意**：原 LangChain 文档早期版本曾把 `HumanInTheLoopMiddleware` 描述为 `wrap_tool_call`，实际实现用的是 `after_model`。它在 `after_model` 中检查本次 AIMessage 的 `tool_calls`、对需要审核的工具名触发 `interrupt`，再用注入式 `ToolMessage` 把人工决定回灌给模型。效果上是"工具调用前必中断"，但实现位置不同。

---

## 五、阶段 3：状态解析（1127–1135）

这一阶段回答三个问题：

1. **Agent 运行期需要哪些字段？**（内部 state）
2. **用户调用时需要传哪些字段？**（input schema）
3. **用户最终能拿到哪些字段？**（output schema）

三套 schema 之所以分开，是因为内部 state 里塞了 `jump_to`、各中间件自己的计数器、配置字段等"内部信号"。这些东西运行时要用，但既不能让用户调用时传进来（怕污染输入），也不想原样暴露给用户（怕泄露内部状态）。所以工厂先把中间件声明的 `state_schema`、用户传的 `state_schema`、内置 `AgentState` 合并成"完整内部 state"，再分别过滤出 input 和 output 两套对外 schema。

合并规则只有一条：**按 `[m.state_schema for m in middleware, ..., AgentState]` 的顺序遍历，遇到同名字段时后者覆盖前者**。所以调用方传的 `state_schema` 排在最末尾，能赢过中间件的任何声明。

接下来按"字段定义 → 字段可见性 → 合并实现"三层往下看。

### 5.1 概念：`AgentState` 的三个字段与归约器

types.py:347-365 定义：

```python
class AgentState(TypedDict, Generic[ResponseT]):
    messages: Required[Annotated[list[AnyMessage], add_messages]]
    jump_to: NotRequired[Annotated[JumpTo | None, EphemeralValue, PrivateStateAttr]]
    structured_response: NotRequired[Annotated[ResponseT, OmitFromInput]]
```

三个字段对应中间件体系的三种核心机制：

| 字段 | 类型注解 | 在 Agent 中做什么 |
|---|---|---|
| `messages` | `add_messages` 归约器 | 整个对话历史。节点返回新消息时，LangGraph 用 `add_messages` 这个归约器把它追加到已有消息列表末尾，按 `id` 去重，不会覆盖。 |
| `jump_to` | `EphemeralValue` + `PrivateStateAttr` | 瞬态路由信号。中间件写入 `"tools"` / `"model"` / `"end"` 来重定向控制流。`EphemeralValue` 让它每步后自动清空；`PrivateStateAttr` 让它对用户不可见（详见 5.2）。 |
| `structured_response` | `OmitFromInput` | 配了 `response_format` 时存解析结果。`OmitFromInput` 让用户调用时无需传入（详见 5.2）。 |

> "归约器 reducer"是 LangGraph 的术语，指"节点返回状态时如何与已有 state 合并"的策略函数。`add_messages` 是 LangGraph 内置的合并函数，按 `id` 去重、按追加顺序拼接。

`InputAgentState` / `OutputAgentState`（types.py:355-365）把"用户传什么 / 用户拿到什么"做了更严格的收口：

- **输入**：允许 `messages: list[AnyMessage | dict]`。也就是说既可以传 `HumanMessage(...)` 这种对象，也可以直接传 `{"role": "user", "content": "..."}` 这种原始 dict，`add_messages` 会强转。
- **输出**：保证 `messages: list[AnyMessage]`，并把 `structured_response` 暴露出来。

### 5.2 概念：三种可见性注解

中间件声明 `state_schema = MyState` 后，`_resolve_schemas()` 会把它的字段合并到 `AgentState`。合并之后还要决定哪些字段对用户可见。LangGraph 提供三种注解来标这件事：

| 注解 | input 模式 | output 模式 | 用途 |
|---|---|---|---|
| `OmitFromInput` | 隐藏 | 可见 | 计算字段（如 `structured_response`，用户不需要传，但调用结果里能看到） |
| `OmitFromOutput` | 可见 | 隐藏 | 仅输入配置（如某些一次性配置） |
| `PrivateStateAttr` | 隐藏 | 隐藏 | 纯内部字段（如 `jump_to`、中间件计数器） |

用法举例：`jump_to` 标的是 `PrivateStateAttr`，所以内部可以读写、但用户既不能传也看不到；`structured_response` 标的是 `OmitFromInput`，所以用户不用传、调用后能拿到解析结果。

### 5.3 代码：合并顺序与 `_resolve_schemas` 的实现

factory.py:1127-1135：

```python
base_state = state_schema if state_schema is not None else AgentState
state_schemas: list[type] = [*(m.state_schema for m in middleware), base_state]
resolved_state_schema, input_schema, output_schema = _resolve_schemas(state_schemas)
```

合并顺序：中间件 schemas 在前（按注册顺序），`base_state` 最后，`base_state` 赢字段冲突。这让调用方的显式 `state_schema` 能覆盖中间件声明的注解（例如一个 `DeltaChannel` 注解能赢过 `BinaryOperatorAggregate` 而无需事后打补丁）。

`_resolve_schemas` 内部对每个 schema 都调用 `_resolve_schema`（factory.py:438-472）。后者做两件事：

1. 按 `omit_flag`（`"input"` 或 `"output"`）过滤字段注解。例如生成 input schema 时把 `OmitFromInput` / `PrivateStateAttr` 标过的字段剔除。
2. 把所有字段合并到一个新生成的 `TypedDict`。

`_get_schema_type_hints`（factory.py:417-420）则用 `lru_cache` 把已解析的 schema 缓存起来，避免每次 invoke 都重新解析。`lru_cache` 是 Python 标准库的"最近最少用"缓存装饰器。

> 这种"输入宽容、输出严格"的分离让 Agent 在边界上对调用者友好，但执行路径上的每个节点都拿到的是强类型 `AgentState`。如果要扩展状态（例如加上 `todo_list`、`retry_count`），通过中间件声明 `state_schema` 比直接继承 `AgentState` 更能保持作用域局部化。

---

## 六、阶段 4：图拓扑组装（1138–1750）

这一节把前面三阶段准备好的节点、`AgentState`、schema 拼成一张完整可执行的图。要回答的核心问题只有两个：

1. **图长什么样？**——有哪些节点、节点之间怎么连。
2. **每次走哪个分支？**——条件边按什么决定下一步。

下面按"图形状 → 节点 → 关键边"展开。

### 6.1 图的整体形状

`create_agent` 生成的图本质上是一条主线串两个循环：

```
START → entry_node → before_agent[0..n] → loop_entry_node
       → before_model[0..n] → model → after_model[n..0]
       → loop_exit_node ─┬─ 有 tool_calls → tools → loop_entry_node
                         └─ 否则 → exit_node → after_agent[n..0] → END
```

四个关键路由点把图切成段，后续代码反复引用它们：

| 路由点 | 包含的节点 | 什么时候走 |
|---|---|---|
| `entry_node` | `before_agent[0]` → `before_model[0]` → `model` | 整次 run 入口，仅一次。 |
| `loop_entry_node` | `before_model[0]` → `model`（**不含 `before_agent`**） | 工具循环返回点，每次迭代都走。 |
| `loop_exit_node` | 决策点 → `tools` / `loop_entry_node` / `exit_node` | 模型调用结束后必走。 |
| `exit_node` | `after_agent[0]` → `END` | 整次 run 出口，仅一次。 |

为什么 `entry_node` 和 `loop_entry_node` 不一样？因为 `before_agent` 是"整个 run 仅一次"的初始化（如加载用户偏好），从工具回来再跑一次就重复了；`before_model` 是"每次模型调用前"都要做的（如上下文压缩），必须保留。

### 6.2 节点的添加

`StateGraph` 接收四套独立 schema（内部 state / 用户输入 / 用户输出 / 运行时 context），这样 create_agent 用同一张图既能在边界对调用者友好、又能在内部做强类型校验。

工厂往图里挂三类节点（factory.py:1476-1564）：

- `model` 节点：`RunnableCallable(model_node, amodel_node, trace=False)`，同步/异步各一份。
- `tools` 节点（若需要）：直接挂 `ToolNode` 实例。
- 每个中间件的钩子节点（`{name}.before_agent`、`{name}.after_model` 等）：同样用 `RunnableCallable(sync_hook, async_hook, trace=False)`。

`RunnableCallable` 是 LangGraph 的小工具，让一个节点同时挂同步和异步实现，按调用方决定走哪一份。

### 6.3 `model_node`：一次模型调用

`model_node` 干三件事：

1. **打包请求**：把 state、runtime、tools 等塞进 `ModelRequest`。
2. **执行调用**：走 `_execute_model_sync` → `_get_bound_model` → `model.invoke(messages)`。
3. **打包返回**：把模型返回包成一条 `Command(update=...)`。

#### 6.3.1 `_get_bound_model`：四步决策

`_get_bound_model`（factory.py:1251-1378）的输入是 `ModelRequest`，输出是一个已经 `bind_tools` 过的 `BaseChatModel`。它做四步：

1. **客户端工具校验**：如果没 `wrap_tool_call`，抛 `DYNAMIC_TOOL_ERROR_TEMPLATE`。
2. **响应格式策略解析**：把原始 schema 包成 `AutoStrategy`，再根据 `_supports_provider_strategy()` 决定走 `ProviderStrategy` 还是 `ToolStrategy`。
3. **结构化输出工具注入**：`ToolStrategy` 时把结构化输出工具追加到 `final_tools`。
4. **bind_tools 三分支**：
   - `ProviderStrategy` → `bind_tools(..., strict=True, response_format=...)`
   - `ToolStrategy` → `bind_tools(..., tool_choice="any", ...)`
   - 无策略 → 有工具时 `bind_tools(...)`，无工具时 `bind(**model_settings)`

#### 6.3.2 `_handle_model_output`：如何处理返回

`_handle_model_output`（factory.py:1147-1249）根据响应策略与 `tool_calls` 决定后续动作：

| 输出情形 | 处理 |
|---|---|
| `ProviderStrategy` 且**无 tool_calls** | 解析 `output.content` JSON，写入 `structured_response`。 |
| `ProviderStrategy` 且**有 tool_calls** | 不解析，只把消息追加；下次再尝试。 |
| `ToolStrategy` 且调用了结构化工具 | 解析为 `structured_response`，同时回灌 `ToolMessage`。 |
| 其他 | 仅返回 `{"messages": [output]}`。 |

### 6.4 关键条件边

#### 6.4.1 `model → tools`

按以下顺序决定（`_make_model_to_tools_edge`，factory.py:1814-1865）：

1. `jump_to` 优先（中间件显式重定向）
2. 没有 AIMessage → 退出
3. `AIMessage.tool_calls` 为空 → 退出
4. 还有未完成的 `tool_calls` → 用 [Send](https://langchain-ai.github.io/langgraph/concepts/low_level/#send) 把每个派发到 `tools` 节点并行执行
5. `structured_response` 已生成 → 退出
6. 注入式 `ToolMessage`（如 HITL）→ 回 `loop_entry_node`

第 4 步是 map-reduce 模式：每个 `tool_call` 独立跑 `tools`，结果自动聚合回 state。

#### 6.4.2 `tools → model`

`_make_tools_to_model_edge`（factory.py:1895-1928）的决策只有三档：

- 所有客户端工具都 `return_direct=True` → 退出
- 执行了结构化输出工具 → 退出
- 默认 → 回 `loop_entry_node`

#### 6.4.3 中间件节点的条件边（`can_jump_to`）

中间件的 `before_model` / `after_model` / `before_agent` / `after_agent` 节点走 `_add_middleware_edge`（factory.py:1931-1976）：

- 没声明 `can_jump_to`：直接顺序连到下一个节点。
- 声明了 `can_jump_to`：建立条件边，按 `state["jump_to"]` 分流到四个目标之一。

`_resolve_jump` 把 `"tools"` / `"model"` / `"end"` 三个字符串分别映到对应目标节点。`can_jump_to` 元数据的内容和读取方式已在 §4.5 讲过，这里不再重复。

### 6.5 持久化、存储、中断

`create_agent` 还接受几个跨层参数：

- `checkpointer`：thread 级检查点，常用 `MemorySaver`（本地）或 `PostgresSaver`（生产）。配合 `interrupt_before` / `interrupt_after` 实现 HITL 和断点续跑。
- `store`：跨 thread 的 `BaseStore`，常用于"长期记忆"（用户偏好、历史任务）。
- `cache`：节点级缓存，加速重复调用。

`interrupt_before` / `interrupt_after` 的典型用法：

```python
graph = create_agent(
    model="...",
    tools=[delete_file, send_email],
    interrupt_before=["tools"],   # 调用工具前必中断
    checkpointer=MemorySaver(),
)
config = {"configurable": {"thread_id": "1"}}
for chunk in graph.stream(input, config):
    print(chunk)
# 人工批准后从快照恢复
for chunk in graph.stream(None, config):
    print(chunk)
```

更精细的控制见 `HumanInTheLoopMiddleware`——它通过 `after_model` 在特定工具名上触发 `interrupt`，而不是所有工具。


## 七、阶段 5：编译与配置（1752–1775）

```python
config: RunnableConfig = {"recursion_limit": 9_999}
config["metadata"] = {"ls_integration": "langchain_create_agent"}
if name:
    config["metadata"]["lc_agent_name"] = name

middleware_transformers = [t for m in middleware for t in getattr(m, "transformers", ())]

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

四件事：

1. **`recursion_limit=9_999`** 是 LangGraph 的"图执行最多跨多少节点"的硬上限。LangGraph 默认值是 25。一次正常的 Agent run 很容易就跑出"几十次模型调用 + 工具调用"，远不止 25 步。create_agent 把上限拉到 9_999 是为了避免一次本该成功的 Agent run 因为默认上限被打断（[GitHub issue #7313](https://github.com/langchain-ai/langgraph/issues/7313)）。
2. **`ls_integration` 标签**让 LangSmith 追踪能识别这个 trace 来自 `create_agent`。如果设置了 `name`，再挂上 **`lc_agent_name`** 用于子图嵌套时父图识别。
3. **`middleware_transformers` 收集**：通过 `getattr(m, "transformers", ())` 收集每个中间件类声明的 transformer 工厂。`AgentMiddleware.transformers` 是 `Sequence[TransformerFactory]` 字段（types.py:401-409），每个 factory 在每次 invocation 时被调用 `factory(scope)` 生成新实例，保证多 invocation 隔离。
4. **Transformer 注册与 `.with_config(config)`**：详见下一节 §7.4。

最终返回的是 `CompiledStateGraph`（不是 `StateGraph`），可以用 `.invoke()` / `.stream()` / `.astream()` / `.batch()` 五种执行模式。因为 LangGraph 节点都是 `Runnable`，所以这五种都直接可用。这一点在 `model_node` 返回 `list[Command[Any]]` 而不是 `AIMessage` 时尤其重要：LangGraph 节点可以返回 `Command(update=...)` 把状态更新合并到图中。

### 7.4 Transformer 与流

**Transformer 是 LangGraph 的流转换机制**。LangGraph 在 `stream()` 时会产生一串原始事件流（消息更新、状态更新、子图事件混在一起）。Transformer 就是挂在这条流上的中间件——它们按顺序对流过的事件做改写、拆分、重路由，让上游消费者看到更友好的事件形态。

`create_agent` 在编译时把四组 Transformer 串成一条流水线：

```
ToolCallTransformer  →  SubagentTransformer  →  中间件声明的 transformers  →  用户传入的 transformers
```

每个 Transformer 的职责：

- `ToolCallTransformer`：把消息流里的 `tool_calls` 重新组织成更友好的形态。它把分散在 `AIMessage` 里的 tool_call 列表拆成 `{name, args, id}` 三段式逐个输出，方便消费者按事件订阅。
- `SubagentTransformer`：检测 `name` 参数（多 Agent 嵌套时由父图通过 `tools=[child.invoke]` 注册子图），在 `run.subagents` 上提供类型化句柄。父 Agent 的流消费者订阅 `run.subagents["research_agent"]` 时拿到的就是子图的事件转发流，而不是整张图混在一起的输出。
- **中间件声明的 transformers**：比如 `PIIMiddleware` 注册的 `_PIIStreamTransformer`，会在流式输出时再过一次 PII 脱敏。
- **用户传入的 transformers**：通过 `create_agent(..., transformers=[...])` 追加在最末端。

---

## 八、使用模式与典型场景

下面六个场景是阶段 1–5 的"应用展示"，每个场景都对应到前面某个阶段的具体能力。

### 场景 A：最简聊天 + 工具（阶段 1 + 阶段 4）

```python
from langchain.agents import create_agent
from langchain_core.tools import tool

@tool
def search(query: str) -> str:
    """Search the web."""
    return f"Results for {query}"

agent = create_agent(
    model="anthropic:claude-haiku-4-5-20251001",
    tools=[search],
    system_prompt="You are a research assistant.",
)
result = agent.invoke({"messages": [{"role": "user", "content": "What's new in AI?"}]})
```

### 场景 B：生产级——重试 + 限额 + HITL（阶段 2 + 阶段 3）

```python
from langchain.agents import create_agent
from langchain.agents.middleware import (
    ModelRetryMiddleware, ModelCallLimitMiddleware,
    HumanInTheLoopMiddleware, SummarizationMiddleware,
)
from langgraph.checkpoint.memory import MemorySaver

agent = create_agent(
    model="openai:gpt-5.5",
    tools=[search, delete_file, send_email],
    system_prompt="You are an ops assistant.",
    middleware=[
        ModelCallLimitMiddleware(max_calls=20),         # 最外层：成本控制
        ModelRetryMiddleware(max_retries=3),            # 重试
        SummarizationMiddleware(max_tokens=4000),      # 上下文压缩
        HumanInTheLoopMiddleware(interrupt_on={"delete_file": True, "send_email": True}),
    ],
    checkpointer=MemorySaver(),
)

config = {"configurable": {"thread_id": "user-123"}}
for chunk in agent.stream(input, config=config, stream_mode="updates"):
    print(chunk)
    # 中间某次会触发 Interrupt，调用方需人工批准后 graph.stream(None, config)
```

### 场景 C：结构化输出（阶段 1 + §六.3.1）

```python
from pydantic import BaseModel, Field

class WeatherReport(BaseModel):
    city: str = Field(description="City name")
    temperature_c: float
    summary: str

agent = create_agent(
    model="openai:gpt-5.5",
    tools=[get_weather],
    response_format=WeatherReport,    # 自动选 ProviderStrategy
)
result = agent.invoke({"messages": [...]})
report = result["structured_response"]   # 类型: WeatherReport
```

### 场景 D：多 Agent 嵌套（子图，阶段 5）

```python
research_agent = create_agent(
    model="...", tools=[...],
    name="research_agent",          # 关键：让父 Agent 能识别
)
supervisor = create_agent(
    model="...", tools=[research_agent.invoke],  # 子图作为工具
    name="supervisor",
)
```

`SubagentTransformer` 会自动检测子 Agent 的 `name`，父 Agent 流式消费者通过 `run.subagents["research_agent"]` 拿到子句柄。

### 场景 E：动态工具（基于中间件，阶段 4 + §六.3.1）

```python
class DynamicToolsMiddleware(AgentMiddleware):
    def wrap_model_call(self, request, handler):
        extra = self._pick_tools(request.runtime.context)
        request = request.override(tools=[*request.tools, *extra])
        return handler(request)

    def wrap_tool_call(self, request, handler):
        if request.tool_call["name"] in self._dynamic_tool_names:
            return self._exec_dynamic(request)
        return handler(request)
```

工厂会在动态工具未注册时报 `DYNAMIC_TOOL_ERROR_TEMPLATE`（factory.py:114-138），但只要定义了 `wrap_tool_call`，工厂会跳过校验（factory.py:1283）。

### 场景 F：可观测性 / 调试（阶段 5）

```python
agent = create_agent(model=..., tools=..., debug=True)

# 三种流模式
for chunk in agent.stream(input, stream_mode="updates"): ...   # 每节点结束时的 state 增量（节点粒度）
for chunk in agent.stream(input, stream_mode="messages"): ...  # 消息流的实时切片（消息粒度）
for chunk in agent.stream(input, stream_mode="events"): ...    # 最细颗粒：LLM token、tool 开始/结束等事件

# LangSmith 自动追踪（无需额外配置，只要设置了 LANGSMITH_API_KEY）
# Trace 上会看到：create_agent → model → tools → ...
```

---

## 九、与"传统手写 Agent 循环"的对比

| 维度 | 手写循环 | `create_agent` |
|---|---|---|
| 状态管理 | 自己维护 messages 列表 | LangGraph `StateGraph` + `add_messages` 归约器 |
| 工具调用 | 手动解析 `tool_calls`、匹配工具 | `ToolNode` + `bind_tools` |
| 工具错误 | 自己写 try/except | `handle_tool_error` / `ToolRetryMiddleware` |
| 流式 | 自己写 yield | `stream_mode="updates"/"messages"/"events"` |
| 持久化 | 自己接数据库 | `Checkpointer`（thread）/ `Store`（跨 thread） |
| 中断 | 自己写暂停逻辑 | `interrupt_before/after` + `Command(resume=...)` |
| 横切关注点 | 在循环里堆代码 | `AgentMiddleware`（重试/限额/PII/HITL/摘要...） |
| 多 Agent | 自己写调度 | 子图 + `SubagentTransformer` |
| 可观测性 | 自己埋点 | `langsmith.traceable` 自动包裹 |

**结论**：`create_agent` 不只是一个 LLM 包装器。它是 LangGraph 的"agent 模式预设图"，把过去需要写几百行的循环逻辑，全部封装成一个声明式 API。

---

## 十、一段话总结

`create_agent()` 的本质是把 LangGraph 五种能力压成一个声明式 API 的胶水层。它没有发明新机制，而是把 `StateGraph` 节点/边、模型 `bind_tools`、`ToolNode`、`Checkpointer`、中间件钩子这些已有原语按"归一化 → 中间件组合 → 状态解析 → 图拓扑组装 → 编译"五步拼装起来。用户只需写 `create_agent(model=..., tools=..., middleware=[...])` 一行，工厂吐出一张可以直接 `.invoke()` 的 `CompiledStateGraph`。

理解这一点后，每次想"加个新能力"时，路径就清晰了：先看属于哪个阶段（要不要中间件？要不要扩展 state？要不要改工具集？），再按那个阶段的扩展点叠加。每加一层都不需要修改已有代码。