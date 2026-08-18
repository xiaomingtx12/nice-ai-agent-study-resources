---
sidebar_position: 11
sidebar_label: 09 Prebuilt：工具执行与注入
description: 拆解 langgraph-prebuilt 包中的 ToolNode、InjectedState/Store、ToolRuntime 和 tools_condition——不是 Agent 工厂，而是工具执行的基础设施。
---

# LangGraph 源码 09：Prebuilt 工具执行层与注入机制

## 源码定位

> **适用版本**：`langgraph-prebuilt` 1.1.0。
>
> **核心路径**：
>
> - 工具节点：`libs/prebuilt/langgraph/prebuilt/tool_node.py`（`ToolNode`、`InjectedState`、`InjectedStore`、`ToolRuntime`、`tools_condition`）
> - Agent 工厂（已 deprecated）：`libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py`
> - 工具校验（已 deprecated）：`libs/prebuilt/langgraph/prebuilt/tool_validator.py`
> - 流式工具调用：`libs/prebuilt/langgraph/prebuilt/_tool_call_transformer.py`、`_tool_call_stream.py`

## 这一篇的主题

`langgraph-prebuilt` 是 monorepo 中的高层组件包。值得注意的变化是：`create_react_agent`、`ValidationNode` 和整套 Agent 状态类在 1.0 版本中已标记 **deprecated**，迁移到了 LangChain。留在 prebuilt 的是工具执行的基础设施：

> **prebuilt 提供的不是 Agent 工厂，而是一套让工具注册、注入、并行执行和流式输出有统一协议的执行层。**

它建立在 core Runtime 之上，被 LangChain `create_agent()` 和 Deep Agents `create_deep_agent()` 直接复用。

## 一、`ToolNode`：核心工具执行节点

`ToolNode` 是 prebuilt 的核心。它继承 `RunnableCallable`，是一个可直接接入 `StateGraph` 的节点：

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:622-628
class ToolNode(RunnableCallable):
    """A node for executing tools in LangGraph workflows.

    Handles tool execution patterns including function calls, state injection,
    persistent storage, and control flow. Manages parallel execution,
    error handling.
    """
```

### 工具注册

支持三种工具形式：

```python
from langchain_core.tools import tool
from langgraph.prebuilt import ToolNode


@tool
def search(query: str) -> str:
    """Search the web."""
    return f"Results for {query}"


# BaseTool 实例
tool_node = ToolNode([search])

# 普通 callable
tool_node = ToolNode([lambda x: x])

# 字典描述（兼容旧格式）
tool_node = ToolNode([{"name": "search", "func": search}])
```

### 并行执行

`ToolNode` 内部实现了工具调用的并行。同步路径使用 executor（任务执行器），异步路径使用 `asyncio.gather()`：

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:819-860（节选）
        with get_executor_for_config(config) as executor:
            outputs = list(
                executor.map(self._run_one, tool_calls, input_types, tool_runtimes)
            )

outputs = await asyncio.gather(
    *(
        self._arun_one(call, input_type, tool_runtime)
        for call, tool_runtime in zip(
            tool_calls,
            tool_runtimes,
            strict=False,
        )
    )
)
```

这些调用仍属于一个图节点。Runtime 看到的是一个 `ToolNode` task，工具调用内部的每个工作项没有独立的图级恢复边界。

### 并发发生在哪一层——这个区分很关键

"工具并行"听起来是一件事，实际在三层有不同的含义和恢复边界：

| 层级 | 机制 | 谁调度 | 独立 retry？ | 独立 checkpoint？ |
| --- | --- | --- | --- | --- |
| 图级 task | PregelRunner 并行提交 task | LangGraph Runtime | 是 | 是 |
| `ToolNode` 内部 | executor（sync）/ `asyncio.gather`（async） | ToolNode 自身 | 否 | 否 |
| 工具函数资源 | 线程池、Semaphore、连接池 | 工具实现 | 否 | 否 |

**为什么这个区分重要**：只有图级 task 拥有独立的 retry、checkpoint 和 interrupt 边界。ToolNode 内部的工具调用如果其中某个失败了，重试的是整个 `ToolNode` task（所有 tool calls 都会重跑）。如果你需要每个工具调用独立恢复，就要把每个 tool call 提升为独立的图 task——这正是 v2 策略做的事情。

v1 和 v2 的本质区别就在这里：

```python
# v1：整条消息交给一个 ToolNode，多个 tool calls 在节点内部并发
return "tools"

# v2：为每个 tool call 创建独立的 Send → PUSH task，进入图级调度
return [
    Send("tools", ToolCallWithContext(tool_call=call, state=state))
    for call in last_message.tool_calls
]
```

v2 借助 `Send`（[第 04 篇](./04-dynamic-routing-and-send.md)）为每个 tool call 创建独立的 PUSH task，获得图级恢复能力；`ToolCallWithContext` 携带当时的状态快照，防止暂停期间 State 过期。代价是多了一层调度开销。

### 错误处理

`ToolNode` 支持错误处理策略：

```python
# 遇到错误返回错误消息，不中断图
tool_node = ToolNode(tools, handle_tool_errors=True)

# 遇到错误返回自定义消息
tool_node = ToolNode(tools, handle_tool_errors="工具调用失败")
```

错误不会吞掉 tool call ID，返回的 `ToolMessage` 仍能匹配到对应的原始调用。

### 工具输出格式化

`msg_content_output()` 负责把工具返回值转成 `ToolMessage` 的 content 格式。它处理字符串、字典和列表的序列化，确保模型能正确解析工具返回结果。

## 二、注入机制：对模型不可见的参数

工具函数可能需要的上下文（State、Store 等）不应该暴露给模型的 tool-calling 接口。prebuilt 提供三种注入标注：

### `InjectedState`：注入图 State

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:1753
class InjectedState(InjectedToolArg):
    """Annotation for injecting graph state into tool arguments."""


def search_with_context(
    query: str,
    user_context: Annotated[dict, InjectedState("user_context")],
) -> str:
    # user_context 从图 State 注入，对模型不可见
    return f"Searching for {query} in {user_context['region']}"
```

模型看到的工具签名只有 `query: str`，`user_context` 由 `ToolNode` 在调用时自动注入。可以指定字段名，也可以省略（注入整个 State）。

### `InjectedStore`：注入跨执行 Store

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:1829
class InjectedStore(InjectedToolArg):
    """Annotation for injecting persistent store into tool arguments."""


def tool_with_memory(
    query: str,
    store: Annotated[BaseStore, InjectedStore()],
) -> str:
    preferences = store.get(("user",), "prefs")
    return f"Searching for {query} with {preferences}"
```

### `ToolRuntime`：工具运行期上下文

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:1663
class ToolRuntime(_DirectlyInjectedToolArg, Generic[ContextT, StateT]):
    """Runtime context automatically injected into tools.

    This is distinct from `Runtime` (from `langgraph.runtime`), which is injected
    into graph nodes and middleware. `ToolRuntime` includes additional tool-specific
    attributes like `config`, `state`, and `tool_call_id` that `Runtime` does not
    have.
    """
```

`ToolRuntime` 与图的 `Runtime` 不同。它额外提供：
- `state`：当前 State 快照
- `config`：RunnableConfig
- `tool_call_id`：当前工具调用的 ID
- `store`：Store 实例
- `context`：图级 context
- `stream_writer`：写自定义事件的 writer

三者共同实现了"工具函数只声明业务参数，运行时由 prebuilt 注入上下文"的模式。

## 三、`tools_condition`：标准路由函数

`tools_condition()` 是 prebuilt 提供的最常用条件路由函数。它检查最后一条 `AIMessage` 是否包含 tool calls：

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:1582-1591
def tools_condition(
    state: list[AnyMessage] | dict[str, Any] | BaseModel,
    messages_key: str = "messages",
) -> Literal["tools", "__end__"]:
    """Conditional routing function for tool-calling workflows.

    This utility function implements the standard conditional logic for ReAct-style
    agents: if the last AIMessage contains tool calls, route to the tool execution
    node; otherwise, end the workflow.
    """
```

标准用法：

```python
builder.add_conditional_edges("model", tools_condition)
# 等价于：
# builder.add_conditional_edges("model", lambda s: "tools" if s["messages"][-1].tool_calls else END)
```

它的实现直接读取消息列表中的最后一个 `AIMessage`，检查 `tool_calls` 是否非空。底层仍是条件边，只是封装了最常见的判断逻辑。

## 四、`ToolCallWithContext`：与 `Send` 的协作

`ToolCallWithContext` 是 prebuilt 为了配合 v2 策略设计的数据结构：

```python
# libs/prebuilt/langgraph/prebuilt/tool_node.py:286-296
class ToolCallWithContext(TypedDict):
    """ToolCall with additional context for graph state.

    The Send API is used in create_agent to distribute tool calls in parallel
    and support human-in-the-loop workflows where graph execution may be paused
    for an indefinite time.
    """
```

v2 策略中，每个 tool call 通过 `Send` 变为独立的 PUSH task。`ToolCallWithContext` 携带 tool call 和当时的状态快照，解决"暂停时状态可能过期"的问题：

```python
# libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py:843-859（节选）
if version == "v1":
    return "tools"
elif version == "v2":
    return [
        Send("tools", ToolCallWithContext(tool_call=call, state=state))
        for call in last_message.tool_calls
    ]
```

v1 把整条消息交给一个 `ToolNode`；v2 为每个 tool call 创建独立的 `Send`，进入图任务层，每个调用拥有独立的 retry、恢复和 checkpoint 边界。`ToolCallWithContext` 保证了即使外部状态在暂停期间改变，工具调用仍拿到调用时的状态副本。

## 五、`ToolCallTransformer`：流式工具调用

`ToolCallTransformer` 在流式输出中处理工具调用事件：

```python
# libs/prebuilt/langgraph/prebuilt/_tool_call_transformer.py
class ToolCallTransformer:
    """Project `tools` channel events into `ToolCallStream` handles."""
```

它配合 `ToolCallStream` 提供单个工具调用生命周期的流式视图：`args`、`result`、`done`。节点内的工具调用在被转换为最终消息前，可以通过流式 Transformer 以事件形式对外暴露。

## 六、`HumanResponse`：Agent Inbox 交互协议

`HumanResponse` 是 prebuilt 中唯一未标记 deprecated 的人工交互类型：

```python
# libs/prebuilt/langgraph/prebuilt/interrupt.py:87-105
class HumanResponse(TypedDict):
    type: Literal["accept", "ignore", "response", "edit"]
    args: None | str | ActionRequest
```

它配合 Agent Inbox 项目使用，不再绑定于某个特定 Agent 框架。`interrupt()` 的恢复值可以是此类型的实例。

## 七、与 core Runtime 的边界

```text
langgraph core（00-08）
  → 图声明、编译、调度、持久化、中断、流式
  → 回答了"怎么运行"的问题

langgraph-prebuilt（本篇）
  → ToolNode、注入、路由、流式工具调用
  → 回答了"工具怎么接入运行时"的问题

LangChain create_agent()
  → 装配 model→tools→model 循环 + Middleware
  → 回答了"Agent 长什么样"的问题
```

## 工程判断

- **照搬**：用 `ToolNode` 集中管理工具注册、并行和错误处理；用 `InjectedState`/`InjectedStore` 注入上下文。
- **换实现**：需要每个工具调用独立恢复时使用 v2 策略 + `Send` + `ToolCallWithContext`；工具输出需要自定义格式时替换 `msg_content_output`。
- **别碰**：不要用已 deprecated 的 `create_react_agent`、`ValidationNode` 和 `HumanInterrupt`（已迁移到 `langchain.agents`）。
- **不适用时**：图只有一两个简单工具调用、不需要并行和错误处理时，自己写工具调用节点可能比引入 `ToolNode` 更清晰。

## 读完后应该能判断什么

- `ToolNode` 的工具注册、并行执行和错误处理机制；
- `InjectedState`、`InjectedStore`、`ToolRuntime` 如何在工具调用时注入上下文；
- `tools_condition` 的底层实现；
- v1/v2 策略下 `ToolCallWithContext` 与 `Send` 的协作方式；
- prebuilt 中哪些组件已 deprecated、迁移到了哪里。
