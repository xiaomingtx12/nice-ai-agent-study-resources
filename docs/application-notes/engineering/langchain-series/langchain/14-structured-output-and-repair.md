---
sidebar_position: 16
sidebar_label: 14 结构化输出与修复循环
description: 追踪 Agent 响应策略、结构化工具、解析校验与错误修复，区分图循环修复、调用包装重试和业务验收。
---

# LangChain 源码解析 14：结构化输出怎样改变调用与修复流程

订单 Agent 查询和审批结束后，应用往往需要明确的处理状态、原因与申请编号。`response_format` 将这份输出约定接入模型调用、结果解析和循环出口；它并不只是在最终文本后面追加一个 JSON 解析器。

本文沿结果从模型响应变成 `structured_response` 的过程展开，再解释错误在哪里被处理。总览中的订单案例用于业务理解，真实实现与测试均来自下述固定提交。

> 基线：LangChain `1.3.7`、langchain-core `1.4.6`，提交 `76c32db9b38dfc287c958dc2a914d4834f022c1c`。主要源码为 `libs/langchain_v1/langchain/agents/factory.py` 和 `agents/structured_output.py`；完整证据见[源码基线](./source-baseline.md)。

## 一、单次模型结构化输出与 Agent 响应格式分别做什么

`BaseChatModel.with_structured_output()` 是模型层的包装入口，返回一个按 Schema 处理模型结果的可调用对象；具体 provider 可以覆盖实现。它不因带了 Schema 就拥有订单工具循环或审批节点。

`create_agent(response_format=...)` 面向整个 Agent 输出。工厂需要让模型在业务工具与最终结果之间选择，并让路由识别结构化结果是否产生。调用方仍得到输出状态映射，从其中读取 `structured_response`，而非整个返回值直接变成 Schema 实例。

| 比较位置 | 模型层包装 | Agent 响应格式 |
| --- | --- | --- |
| 使用入口 | `model.with_structured_output(...)` | `create_agent(response_format=...)` |
| 主要处理范围 | 一次模型调用的绑定与结果解析 | 标准 Agent 中的调用、状态与出口 |
| 是否自动执行订单工具 | 否 | 由注册工具和工厂路由执行 |
| 格式错误后怎样继续 | 取决于包装器、解析器及外部调用逻辑 | 取决于策略、handle_errors、路由及中间件 |

需要核对模型层细节时回看 [02](./02-core-abstractions.md)。以下专注 Agent 路径。

## 二、策略先准备，实际模型调用时再决定绑定

### 1、三种策略对应两类结果协议

`ProviderStrategy` 使用供应商原生结构化输出；`ToolStrategy` 把结果 Schema 表达为特殊工具调用；`AutoStrategy` 保留自动选择的意图。三者都是响应策略对象，用来决定模型请求和解析方式。

| 策略 | 模型侧 | 工厂侧 |
| --- | --- | --- |
| Provider | 绑定原生结构化参数 | 从无工具调用的模型响应正文提取 JSON，再解析 |
| Tool | 把 Schema 作为特殊工具声明 | 从特殊调用的 args 解析结果，并生成配对 ToolMessage |
| Auto | 每次绑定时根据模型能力选择 | 跟随最终选中的协议 |

工厂会提前为 Auto/Tool 准备 `OutputToolBinding`，即结构化工具名称、Schema 与解析逻辑的绑定记录。它没有对应的退货写入操作；普通业务工具仍由 ToolNode 执行。

### 2、自动选择不等于出错后自动降级

`_get_bound_model` 在每次模型请求中检查 Auto 策略，调用 `_supports_provider_strategy` 决定有效策略。显式给出的 Provider 或 Tool 策略保留原意，不会因为一次解析失败就无条件换另一套协议。

当前 Provider 绑定生成 OpenAI 风格的 `response_format` 参数，再交给模型适配器。是否真正支持这些参数，需要核对具体适配器与服务；初始化成功不是兼容性保证。

中间件可以调整 response_format，但 Tool 策略使用的结构化工具必须来自创建 Agent 时已声明的集合。工厂允许在这个范围内变更，不支持任意临时新增未准备的结构化工具；源码会检查名称并拒绝未知项。

## 三、成功结果从哪里进入 State

### 1、Provider 路径先确认当前没有业务工具调用

`_handle_model_output` 遇到 Provider 策略时，只有模型响应没有 tool_calls，才尝试解析结构化正文。仍有工具调用时，先返回模型消息，让后续路由处理工具任务。

`ProviderStrategyBinding.parse` 从消息提取文本，执行 `json.loads`，再调用 `_parse_with_schema`。解析异常在工厂中被包装成 `StructuredOutputValidationError`，携带原模型消息以供上层处理。

成功时，节点更新同时包含 messages 与 structured_response。节点返回之后，还需要经过图状态更新与路由；“解析函数返回”不是业务系统的写入完成回执。

### 2、Tool 路径解析参数，不执行一个伪造业务动作

模型给出结构化工具调用时，工厂从预先登记的绑定表取解析器。下面节选 `factory.py` · `_handle_model_output` 的成功分支，省略 ToolMessage 正文选择：

```python
tool_call = structured_tool_calls[0]
try:
    structured_tool_binding = structured_output_tools[tool_call["name"]]
    structured_response = structured_tool_binding.parse(tool_call["args"])
    # ……省略成功 ToolMessage 正文的选择与后续返回。
```

随后生成与该调用 ID 配对的 ToolMessage，并写入 structured_response。这个消息告诉模型协议“结果调用已有响应”，不会调用退货提交服务。

如果同一模型响应还有未配对的普通业务工具，`_make_model_to_tools_edge` 会先派发这些工具，再考虑结构化结果的结束条件。因此有 structured_response 字段不等于本轮所有工作都已完成。

## 四、解析与校验还取决于 Schema 类型

Pydantic 模型、dataclass 和 TypedDict 会进入 `TypeAdapter.validate_python`。TypeAdapter 是 Pydantic 提供的类型解析与校验器，将原始数据按指定 Python 类型处理。

原始 JSON Schema 字典在这份版本里的本地解析分支不同。以下是 `structured_output.py` · `_parse_with_schema` 的真实核心片段，省略异常信息构造：

```python
if schema_kind == "json_schema":
    # 原始 JSON Schema 没有对应的 Python 类型可供实例化。
    return data
try:
    adapter = TypeAdapter[SchemaT](schema)
    return adapter.validate_python(data)
# ……省略异常捕获与错误包装。
```

因此不能把“提供了 JSON Schema”统一描述成“工厂在本地完整验证了全部约束”。Provider 路径还会解析 JSON 文本，供应商可能执行自己的约束；Tool 路径传入的 args 在这里直接返回。若业务必须保证字典符合 Schema，应明确增加相应校验。

即使类型校验通过，也不能验证订单属于当前用户、申请编号真实存在，或退货政策引用正确。结构验收与业务验收需要分别设计。

## 五、失败后是回到模型，还是直接抛出

### 1、ToolStrategy 可以把错误变成修复消息

一份响应中出现多个结构化调用时，工厂构造 `MultipleStructuredOutputsError`；单个调用参数解析失败时，构造 `StructuredOutputValidationError`。

这两类错误再交给 `_handle_structured_output_error`。它返回“是否允许修复”和“反馈给模型的消息内容”，不直接调用模型。

| `handle_errors` 配置 | 本次错误处理 |
| --- | --- |
| `False` | 不转成修复消息，异常向外抛出 |
| `True`，默认 | 使用默认错误反馈 |
| 字符串 | 使用指定反馈 |
| 异常类型或类型元组 | 匹配时反馈，否则抛出 |
| 可调用对象 | 调用它生成错误反馈；该回调自身也可能失败 |

允许修复时，工厂返回原 AIMessage 与配对错误 ToolMessage，但不写 structured_response。多个结构化调用各得到配对错误消息，防止丢失协议关系。

这些结构化调用不会进入普通 ToolNode；路由看到没有最终结构化结果，按对应分支再次进入模型。模型从新消息中看到错误，再尝试修正。

### 2、Provider 校验失败不走同一套 handle_errors

`_handle_structured_output_error` 仅为 ToolStrategy 提供上述配置。Provider 解析失败会抛出结构化验证异常，不会由这条 Tool 分支自动补 ToolMessage。

上层包装器可以捕获异常并重试，但要明确给模型什么修正信息。只把完全相同的请求再发一次，不等于模型已经知道哪一项字段错误。

### 3、工具消息配对是恢复对话协议，不是业务去重

订单结果里的申请编号错误，修复的是模型输出表示。不能为了修复一份结构化答复，就无条件重新执行 `submit_return`。

图路由依据消息配对决定哪些工具待处理，外部申请是否已经存在仍要由业务服务查询与幂等约束保证。特别是工具写入成功但结果未可靠保存的故障窗口，输出 Schema 无法替代外部确认。

## 六、两种修复分别消耗哪一层预算

| 机制 | 执行位置 | 发生了什么 | 应观察的计数 |
| --- | --- | --- | --- |
| ToolStrategy 错误反馈 | 模型节点正常返回后，经图边回模型 | 新的模型节点轮次读取修复消息 | 图轮次、模型节点次数 |
| wrap_model_call 内部重试 | 同一个模型节点的 handler 栈 | 内层模型执行多次，最后才返回 | handler 尝试、供应商请求 |
| SDK 自带重试 | 适配器或网络客户端内 | 一次模型执行可能产生更多请求 | 网络尝试与费用 |

ToolStrategy 的 handle_errors 没有提供独立 max_retries 字段。允许修复并不代表无限运行，图限制、中间件和应用预算仍会影响执行；应明确设置业务可接受的次数和截止条件，而不是把工厂的较大默认递归限制当作成本预算。

模型调用限额统计的是相应节点轮次，不能覆盖所有包装重试、摘要模型或工具选择器的额外请求。计数与回退组合见 [07](./07-call-governance.md)。

## 七、仓库测试怎样验证这些分支

### 1、内置 ToolStrategy 的修复

`tests/unit_tests/agents/test_response_format.py` 中，`test_multiple_structured_outputs_with_retry` 安排测试模型第一次返回两个结构化调用，第二次只返回一个。真实断言如下，省略模型、策略与 agent 的设置：

```python
# 用户消息、模型消息、两条工具消息、第二条模型消息、工具消息。
assert len(response["messages"]) == 6
assert response["structured_response"] == EXPECTED_WEATHER_PYDANTIC
```

同文件的 `test_multiple_structured_outputs_error_without_retry` 则配置 `handle_errors=False`，断言抛出 MultipleStructuredOutputsError；Provider 的 `test_validation_error_with_invalid_response` 断言无效结果抛出 StructuredOutputValidationError。

测试里的天气对象验证协议，不证明某个真实供应商的输出质量。本次阅读了测试设置和断言，没有执行。

### 2、测试自定义中间件不等于内置公开能力

`middleware/implementations/test_structured_output_retry.py` 在测试文件内定义了名为 `StructuredOutputRetryMiddleware` 的示例类。它捕获结构化异常，追加错误反馈，然后在包装器内部重新调用 handler。

该测试设置 ToolStrategy 的 `handle_errors=False`，让异常能够传到包装器；`test_structured_output_retry_first_attempt_invalid` 安排前两次参数无效、第三次成功，并断言模型调用计数为 3。

这说明自定义包装器可以控制输出修复，但不能仅凭类名就把它列为本版本可直接导入的内置中间件。测试还直接修改请求消息列表，引用其作为生产方案前，需要重新审查消息所有权与重试副作用。

## 八、工程使用时先明确验收与失败出口

适合沿用的是把结构约定接入调用和结果解析，让调用方读取明确字段。订单服务还应验证“已提交”状态必须具有可查询的申请记录，并检查用户身份、政策版本和工具结果。

如果已有明确的单次抽取任务，可以先评估模型层结构化包装；需要多轮查询、审批和工具执行时，再用 Agent 响应格式组织结果。两者解决的问题不同，不必为了返回 JSON 自动引入完整 Agent 循环。

## 九、固定源码定位

- [工厂策略与错误处理](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/factory.py) · `_get_bound_model`、`_handle_model_output`、`_handle_structured_output_error`。

- [策略与解析器](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/structured_output.py) · `ToolStrategy`、`ProviderStrategyBinding`、`_parse_with_schema`。

- [模型层结构化入口](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/core/langchain_core/language_models/chat_models.py) · `BaseChatModel.with_structured_output`。

- [响应格式测试](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/test_response_format.py)与[测试自定义修复包装器](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_structured_output_retry.py)。
