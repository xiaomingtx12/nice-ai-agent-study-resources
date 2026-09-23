---
sidebar_position: 13
sidebar_label: 11 扩展：工具执行与参数注入
description: 沿工具注册、参数注入、并行调用和返回值处理解释 ToolNode，连接图任务恢复边界与 LangChain 的工具装配。
---

# LangGraph 源码 11：ToolNode 如何执行工具与注入上下文

## 源码定位

> **源码基线**：langgraph-prebuilt 1.1.0、langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 工具执行主链：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode._func()`、`_parse_input()`、`_run_one()`、`_execute_tool_sync()`。
> - 注入与结果：同文件 → `_extract_state()`、`_get_all_injected_args()`、`_inject_tool_args()`、`_normalize_tool_response()`、`_combine_tool_outputs()`。
> - 路由：同文件 → `tools_condition()`；旧工厂派发：`libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py` → `create_react_agent()` 内部 `should_continue()`。

模型返回工具名和参数以后，还需要代码查找对应函数、补入用户上下文、执行调用并把结果交还模型。`ToolNode` 就是把这套处理封装成图节点的组件。本篇看它如何接住工具请求，以及图能恢复到哪一层调用。

它负责工具层协议；图的状态提交、检查点和任务恢复仍由前面几篇介绍的 Pregel 处理。

`BaseTool` 是 LangChain Core 的工具抽象，负责参数结构和统一调用；`ToolMessage` 是携带 `tool_call_id` 的工具结果消息，用来与模型的某次请求配对。ToolNode 可直接作为 StateGraph 节点，但它本身不决定模型何时再次运行，那由图边或上层 Agent 工厂决定。

建议先读[任务执行](./04-pregel-task-execution.md)、[动态派发](./05-dynamic-routing-and-send.md)和[持久化](./06-checkpoints-store-and-recovery.md)，理解图能分别记录哪些工作。本篇沿工具协议展开；模型如何选择工具并继续下一轮，接着读 [LangChain 的 Agent 装配](../langchain/03-create-agent-assembly.md)。

## 一、一条工具请求怎样变成结果消息

下面是完整应用示例，手动构造模型已经返回的工具请求，不需要模型 API。`AIMessage` 表示模型消息，里面的 tool_calls 保存待执行请求；`MessagesState` 是预先声明 messages 字段并使用 add_messages 归并规则的状态结构。`@tool` 将有类型标注和描述的函数转换为可注册工具。

```python
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.graph import START, END, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

@tool
def add(a: int, b: int) -> int:
    """计算两个整数的和。"""
    return a + b

builder = StateGraph(MessagesState)
builder.add_node("tools", ToolNode([add]))
builder.add_edge(START, "tools")
builder.add_edge("tools", END)
graph = builder.compile()

request = AIMessage(
    content="",
    tool_calls=[{
        "name": "add",
        "args": {"a": 2, "b": 3},
        "id": "call-1",
        "type": "tool_call",
    }],
)
result = graph.invoke({"messages": [request]})
reply = result["messages"][-1]
assert reply.content == "5"
assert reply.tool_call_id == "call-1"
assert reply.status == "success"
assert len(result["messages"]) == 2
```

这里的 tools 运行一次就结束，因为图没有定义回到模型的边。ToolNode 的职责是执行请求并交回结果；要让模型继续解释 5 的含义，还需在外层图中接上模型节点。

| 请求或返回字段 | 示例中的值 | 对应处理动作 |
| --- | --- | --- |
| name | add | 在注册表中找出工具对象 |
| args | a=2、b=3 | 校验并作为函数参数传入 |
| 请求 id | call-1 | 标识这一次调用，同一个工具可被请求多次 |
| 结果 tool_call_id | call-1 | 将 ToolMessage 与原请求配对 |
| 结果 content | 字符串 5 | 放入 messages 更新，再由图归并 |

ToolMessage 自身的消息 ID 用于消息列表归并，tool_call_id 用于请求与响应配对，二者不是同一个用途。图里最终保留请求和响应两条消息，不是把原 AIMessage 改成字符串 5。

### 注册时建立名称表和注入表

构造器接受 `BaseTool` 或可转换为工具的 callable。普通函数经 `create_tool()` 转换，再按工具名保存；同时解析哪些参数应由运行时注入：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode.__init__`（第 779–786 行节选；未展示部分省略）。

```python
for tool in tools:
    if not isinstance(tool, BaseTool):
        tool_ = create_tool(cast("type[BaseTool]", tool))
    else:
        tool_ = tool
    self._tools_by_name[tool_.name] = tool_
    # 初始化时一次解析 State、Store 和 Runtime 等注入参数。
    self._injected_args[tool_.name] = _get_all_injected_args(tool_)
```

在示例中，`self._tools_by_name["add"]` 指向 add 工具；`_injected_args` 记录的是隐藏参数的注入方式。add 只接收 a、b，所以没有需要额外注入的业务参数。

传入“name 加 func 的任意字典”不属于这里声明的工具注册契约。普通函数也需要符合工具转换要求，例如具备可用的参数结构和描述；不是所有 lambda 都能直接成为有效工具。

名称表用赋值维护，同名工具会覆盖之前的项。工具身份因此应在装配层保持唯一，不能依赖列表里同名对象的位置来区分权限或功能。

## 二、输入解析同时确定调用列表与状态来源

`_func()` 调用 `_parse_input()` 得到工具调用列表和输入类型，再为每个调用构造 `ToolRuntime`。ToolRuntime 是工具专用的运行上下文，包含 State、Store、调用 ID、配置和流式 writer；它在图节点使用的 `Runtime` 之外补充了当前工具调用的信息。

| ToolNode 输入 | 工具调用来源 | 注入状态来源 |
| --- | --- | --- |
| 消息列表或带 messages 的图状态 | 从后向前找到最近的 `AIMessage`，取其 tool_calls | 传入的状态 |
| 带 `type="tool_call"` 的调用列表 | 直接使用该列表 | 若在图内运行，通过内部读取回调获取当前通道值 |
| `ToolCallWithContext` | 包中的单个 tool_call | 包中内联的 state |

`ToolCallWithContext` 是为派发工具调用携带上下文的字典结构，需要 `__type="tool_call_with_context"` 标记。它是支持的兼容输入形式，不是所有 `Send` 工具调用的唯一格式，也不保证对状态进行了深拷贝。

新式调用列表本身不含完整 State，`_extract_state()` 从任务配置中的 `CONFIG_KEY_READ` 回调恢复所需通道视图；脱离图单独调用且没有该回调时，状态来源退化为 `{}`。因此仅有 tool call 的离线调用，无法凭空满足需要 State 字段的工具。

消息输入不存在、找不到 AIMessage 都有错误分支。`tools_condition()` 的行为还略有不同：它检查**最后一条消息**是否带工具调用，而不是向前搜索最近 AIMessage。路由和执行器接受的历史形态不同，不能据此把不完整消息历史当作通用输入。

## 三、单次工具调用经过包装器，再注入可信参数

示例中的 a、b 来自请求。如果工具还需要当前用户、图状态或调用 ID，这些值应由运行环境提供；不能要求模型自己猜出运行现场。参数注入就是在真正调用函数前补齐这些值。

每个调用进入 `_run_one()`，构造 `ToolCallRequest`，即包含原始调用、工具对象与上下文的请求。配置了 `wrap_tool_call` 时，包装器可修改请求、重试、缓存或短路返回，再决定是否调用实际执行函数。

实际执行前才进行参数注入：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode._execute_tool_sync`（第 952–966 行节选；未展示部分省略）。

```python
# 在实际调用之前注入 State、Store 和工具运行上下文。
injected_call = self._inject_tool_args(call, request.runtime, tool)
call_args = {**injected_call, "type": "tool_call"}

try:
    try:
        response = tool.invoke(call_args, config)
    except ValidationError as exc:
        # 参数校验失败时，过滤注入参数对应的错误信息。
        injected = self._injected_args.get(call["name"])
        filtered_errors = _filter_validation_errors(exc, injected)
        # 报告使用原始模型参数，避免把注入值暴露到错误中。
        raise ToolInvocationError(
            call["name"], exc, call["args"], filtered_errors
        ) from exc
```

下段讨论的注入对象属于 ToolNode 的扩展参数协议：`InjectedState` 声明一个参数从图状态读取，`InjectedStore` 声明一个参数来自业务数据存储，`ToolRuntime` 则提供工具调用的完整上下文。

`InjectedState("user_context")` 表示从 State 的该字段填充参数；不指定字段时注入整份状态。`InjectedStore` 请求图配置的业务 Store；`ToolRuntime` 将工具运行上下文整体注入。工具向模型暴露的调用结构隐藏这些参数，但隐藏本身还不够，执行端必须拒绝模型伪造同名值。

`_inject_tool_args()` 先构造可信注入值，再删除原始 args 中所有注入键：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode._inject_tool_args`（第 1421–1430 行节选；未展示部分省略）。

```python
# 删除调用方提供的全部注入参数键，
# 再补入可信运行时值，防止模型通过 args
# 伪造本应隐藏的注入字段。
stripped_args = {
    k: v
    for k, v in tool_call_copy["args"].items()
    if k not in injected.all_injected_keys
}
tool_call_copy["args"] = {**stripped_args, **injected_args}
return tool_call_copy
```

缺少必需 State 字段时抛出 `KeyError` 或 `AttributeError`；请求 Store 但图没有配置时抛出 `ValueError`。这些注入发生在实际工具调用的异常转换块之前，不能认为 `handle_tool_errors=True` 会把所有装配错误都转成模型可读消息。

注入参数也不等于权限校验。例如可信注入了 user_id，工具仍需要检查该用户能否访问指定订单。直接修改注入的 State 对象不构成受控状态更新，工具要改图状态应返回明确的 `Command(update=...)`。

## 四、并行发生在 ToolNode 内部还是图任务之间

同步 `_func()` 使用执行器批量调用 `_run_one`；异步路径使用 `asyncio.gather()`：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode._func`（第 819–826 行节选；未展示部分省略）。

```python
# 分发原始调用，注入留到各调用真正执行前。
input_types = [input_type] * len(tool_calls)
with get_executor_for_config(config) as executor:
    outputs = list(
        executor.map(self._run_one, tool_calls, input_types, tool_runtimes)
    )

return self._combine_tool_outputs(outputs, input_type)
```

若一个 ToolNode task 包含十个调用，图恢复协议只看到一个任务的最终写入。某个未处理异常导致该任务失败，且节点策略要求重试时，其他已执行工具也可能再次运行。内部执行器不是十份独立图检查点。

把每个调用放进独立 `Send("tools", ...)`，则得到不同图 task ID，可以分别保存成功写入和恢复未完成调用。完整检查点仍属于图轮次，收益来自任务级写入记录，代价是更多任务调度与持久化记录。

旧 `create_react_agent` 的 `version="v1"` 选择单个 tools 节点，v2 可按调用派发 Send。这是旧工厂的调度策略编号，与流式 API 版本无关。该工厂在本基线中仍存在但已标记弃用，推荐入口迁至 LangChain；不能据此说 prebuilt 已经没有 Agent 工厂实现。

## 五、异常何时成为 ToolMessage

工具参数校验失败会包装为 `ToolInvocationError`，其中保留模型可修正的参数错误信息。默认处理函数只将这类调用错误转成文字，其他错误继续抛出：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `_default_handle_tool_errors`（第 389–391 行节选；未展示部分省略）。

```python
if isinstance(e, ToolInvocationError):
    return e.message
raise e
```

| 策略或异常 | 处理结果 | 图运行含义 |
| --- | --- | --- |
| 默认策略下的调用参数错误 | 错误 ToolMessage | 模型有机会修正输入 |
| `handle_tool_errors=True` 或错误文本 | 将执行块内匹配的普通异常转成消息 | 图任务可能正常完成，但消息标记失败 |
| `False` 或不匹配的异常类型 | 向外抛出 | 由节点重试或图错误路径处理 |
| 未注册工具名 | 工具名称校验生成错误消息 | 告诉模型可用工具名 |
| `GraphBubbleUp` 控制异常，包括中断 | 始终向外传播 | 保留图暂停和跨图控制语义 |

转换后的错误消息保留请求 ID：

源码：`libs/prebuilt/langgraph/prebuilt/tool_node.py` → `ToolNode._execute_tool_sync`（第 1005–1012 行节选；未展示部分省略）。

```python
# 被策略处理的错误转为仍与原调用配对的结果消息。
content = _handle_tool_error(e, flag=self._handle_tool_errors)
return ToolMessage(
    content=content,
    name=call["name"],
    tool_call_id=call["id"],
    status="error",
)
```

此时“ToolNode task 成功返回”和“工具业务成功”是两层状态。监控不能只看图任务是否抛异常；需要按 ToolMessage 的 `status` 和业务结果判断。把所有服务错误都转给模型，也可能隐藏基础设施故障，应按异常类型划定可修正和应中止的边界。

## 六、返回值如何进入图状态

回到 add 示例：函数返回整数 5，工具调用层把它包装成 content 为字符串 5、tool_call_id 为 call-1 的 ToolMessage；ToolNode 再返回 messages 更新。负责把它和原 AIMessage 合在一起的是图的 add_messages reducer。

`BaseTool.invoke()` 处理普通工具返回值并形成相应结果；ToolNode 的 `_normalize_tool_response()` 接受 ToolMessage、Command 或符合约束的结果列表。`_combine_tool_outputs()` 将普通消息包装成 `{"messages": [...]}`，再交给图的字段 writer 和 reducer。

工具返回 Command 更新当前图的消息状态时，通常还需在 update 中包含与原 tool_call_id 匹配的 ToolMessage。否则下一次模型调用看到一项没有回应的工具请求，会破坏消息配对。源码还单独处理父图命令、清空全部消息和结果列表；结果列表要求恰好一个与外层调用配对的终结消息。

Command 继续沿图的控制写入路径处理，ToolNode 不直接跳转到另一个节点。需要重新调用模型时，图应定义 tools 到 model 的后继关系。流式工具视图可以观察单次调用进度，但不会因此改变内部工具调用的恢复粒度。

ToolNode 适合集中处理消息配对、注入、错误转换和并行调用；只有单次无状态函数调用时可以直接写业务节点。是否引入它取决于需要哪些工具协议，不能仅按工具数量判断。
