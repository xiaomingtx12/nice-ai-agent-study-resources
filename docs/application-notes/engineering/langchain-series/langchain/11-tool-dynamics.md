---
sidebar_position: 13
sidebar_label: 11 工具动态化：选择、模拟与 provider 搜索
description: 看 wrap_model_call 怎样在"编译期固定工具列表"的边界内动态改写模型视图，以及 wrap_tool_call 怎样模拟工具执行。
---

# LangChain 源码 11：工具动态化——选择、模拟与 provider 搜索

## 源码定位

> **阅读基线**：`langchain` 1.3.7（`libs/langchain_v1/`）。  
>
> **核心路径**：
>
> - **选择器实现**：`libs/langchain_v1/langchain/agents/middleware/tool_selection.py`——`LLMToolSelectorMiddleware` 在 `wrap_model_call` 里用小模型预选工具，正文一节展开。
> - **模拟器实现**：`libs/langchain_v1/langchain/agents/middleware/tool_emulator.py`——`LLMToolEmulator` 用 `wrap_tool_call` 拦截并模拟工具输出，正文二节展开。
> - **provider 搜索实现**：`libs/langchain_v1/langchain/agents/middleware/provider_tool_search.py`——`ProviderToolSearchMiddleware` 注入 provider 端搜索工具并延迟加载工具 Schema，正文三节展开。

## 为什么读这一篇

[03 篇](./03-create-agent-assembly.md) 有一条硬边界：工具列表在 `create_agent()` 编译期固定，`wrap_model_call` 只能改已注册工具的参数，不能添加新工具。

本篇三个中间件都在这个边界内做"工具动态化"：

- **选择器**是减少工具数量；
- **模拟器**是改变工具行为；
- **provider 搜索**是改变工具 Schema 的加载时机。

三条路径都遵守"编译期注册、运行期调整"的约束。

## 一、选择器：用小模型预选工具

`LLMToolSelectorMiddleware` 处理"工具很多、每轮全量发送太贵"的问题。真实实现（`tool_selection.py:273-313`）：

```python
def wrap_model_call(self, request, handler):
    selection_request = self._prepare_selection_request(request)
    if selection_request is None:
        return handler(request)          # 无工具或无需选择：直接透传

    # 用结构化输出约束选择模型的返回：工具名做成 Literal 枚举
    type_adapter = _create_tool_selection_response(selection_request.available_tools)
    schema = type_adapter.json_schema()
    structured_model = selection_request.model.with_structured_output(schema)

    response = structured_model.invoke(
        [
            {"role": "system", "content": selection_request.system_message},
            selection_request.last_user_message,   # 取最近一条 HumanMessage
        ]
    )

    if not isinstance(response, dict):
        raise AssertionError(f"Expected dict response, got {type(response)}")

    modified_request = self._process_selection_response(
        response, selection_request.available_tools,
        selection_request.valid_tool_names, request,
    )
    return handler(modified_request)     # override 生成精简后的请求
```

设计要点：

- **没有新增工具**——`selected` 是已注册工具的子集，完全符合"编译期固定"边界；
- **`always_include` 工具不参与选择**，且构造期校验其确实存在于绑定工具集（`tool_selection.py:181-188`）——不在则抛 `ValueError`；
- **`max_tools` 截断**：选择模型超量输出时只取前 N 个，`system_prompt` 会显式告知模型这一规则（第 201-207 行）；`always_include` 工具不计入 `max_tools`（第 144-146 行）；
- **选择也是一次模型调用**：`wrap_model_call` 内部先调选择模型、再调主模型——嵌套模型调用是拦截器线的合法用法。选择模型的返回被 `with_structured_output` 约束成工具名枚举的 dict，非法返回直接断言失败。

## 二、模拟器：用模型假装工具

`LLMToolEmulator` 反过来——工具本身存在，但执行被替换。真实实现（`tool_emulator.py:109-157`）：

```python
def wrap_tool_call(self, request, handler):
    tool_name = request.tool_call["name"]

    # 只模拟声明过的工具，其余走真实执行
    should_emulate = self.emulate_all or tool_name in self.tools_to_emulate
    if not should_emulate:
        return handler(request)

    # 构造模拟提示词
    prompt = (
        f"You are emulating a tool call for testing purposes.\n\n"
        f"Tool: {tool_name}\n"
        f"Description: {request.tool.description if request.tool else 'No description available'}\n"
        f"Arguments: {request.tool_call['args']}\n\n"
        f"Generate a realistic response that this tool would return "
        f"given these arguments.\n"
        f"Return ONLY the tool's output, no explanation or preamble."
    )

    response = self.model.invoke([HumanMessage(prompt)])

    # 短路：不调用 handler，直接返回模拟的 ToolMessage
    return ToolMessage(
        content=response.content,
        tool_call_id=request.tool_call["id"],
        name=tool_name,
    )
```

这是 [04 篇](./04-middleware-control-plane.md) 介绍的"拦截器可以短路 handler"的完整用例：`wrap_tool_call` 不调用 `handler`，而是用一次模型调用生成 `ToolMessage`。用途是测试工具调用链、原型阶段避免真实副作用。注意模拟消息的 `tool_call_id` 仍取自原请求——配对协议不被破坏。

**边界提醒**：模拟器输出的是模型"想象"的结果，不是真实执行结果。它验证的是"Agent 对工具结果的消费逻辑"，不是工具本身正确性——混淆两者会让测试产生假阳性。

## 三、Provider 搜索：延迟加载工具 Schema

`ProviderToolSearchMiddleware` 解决"绑定了大量工具、每轮全量发送 Schema 太大"的问题。核心逻辑在 `_prepare_request`（`provider_tool_search.py:104-154`）：

```python
def _prepare_request(self, request):
    # 1. 校验 searchable_tools 都真实绑定在模型上，否则 ValueError
    #    （provider_tool_search.py:125-132）
    # 2. 无延迟工具时原样返回（无论 provider 是否支持）
    # 3. 有延迟工具时：
    #    - 推断模型 provider（当前支持 Anthropic / OpenAI）
    #    - 把目标工具标记 defer_loading（Schema 不随请求发送）
    #    - 注入 provider 的服务端工具搜索工具 dict
    bound_tools = [_defer_tool_if_needed(tool, self.searchable_tool_names) for tool in tools]
    return request.override(tools=[*bound_tools, dict(_SERVER_TOOL_SEARCH_TOOLS[provider])])
```

与选择器的差别：选择器是**减少本轮工具**，provider 搜索是**减少本轮工具 Schema 体积**——工具仍在声明列表里，但完整 Schema 只在模型需要时由 provider 端按需取回。`extras["defer_loading"]` 标记是实现机制。

**这条边界直接依赖 provider 能力**：

- Anthropic / OpenAI 之外有延迟工具时抛 `ValueError`；
- 没有延迟工具时无论 provider 都透传。

动态化的可用范围由下游能力决定——不是所有 provider 都支持服务端工具搜索。

## 四、三个动态化方向的边界

| 中间件 | 改什么 | 用哪个 Hook | 边界 |
| --- | --- | --- | --- |
| `LLMToolSelectorMiddleware` | 工具数量（子集） | `wrap_model_call` | 不新增工具，构造期校验 always_include |
| `LLMToolEmulator` | 工具行为（模拟） | `wrap_tool_call` | 短路 handler，输出非真实结果 |
| `ProviderToolSearchMiddleware` | 工具 Schema 加载时机 | `wrap_model_call` | 依赖 provider 服务端搜索能力 |

共同约束来自 [03 篇](./03-create-agent-assembly.md) 的编译期固定工具列表：三者都只调整"模型视图"（数量、行为、Schema），不向 `request.tools` 添加未注册工具——这正是 `DYNAMIC_TOOL_ERROR_TEMPLATE` 想要维持的并发安全边界。

## 读完后应该能判断什么

- 在"编译期固定工具"边界内，工具动态化只能调整哪些维度；
- 选择器为什么排除 dict 形式的 provider 工具；
- 模拟器短路 handler 的用途与假阳性风险；
- provider 搜索与选择器解决的是不同问题（Schema 体积 vs 工具数量）；
- 实现自己的工具动态化中间件时，先检查改的是数量、行为还是加载时机，再选 Hook。
