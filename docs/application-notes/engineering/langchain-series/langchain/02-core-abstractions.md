---
sidebar_position: 4
sidebar_label: 02 聊天模型、消息与工具

description: 对照 LangChain v1 官方文档与 langchain-core 源码，追踪聊天模型、消息类型和工具系统如何交接输入、输出与工具调用协议。
---

# LangChain Core 源码 02：聊天模型、消息与工具系统

## 源码定位

> **阅读基线**：`langchain-core`，源码位于 `libs/core/langchain_core/`。
>
> **本篇范围**：聚焦聊天模型（`BaseChatModel`）、消息类型（`BaseMessage`/`AIMessage`/`ToolMessage`）和工具系统（`BaseTool`/`StructuredTool`）的协议边界。`libs/langchain_v1/langchain/` 下的 `create_agent()`、Agent 循环和 LangGraph 图装配属于 03、04、05 的范围，此处只在边界说明中出现。
>
> **核心包与路径**：
>
> 1. `langchain_core.language_models.chat_models`：`libs/core/langchain_core/language_models/chat_models.py`
>    - **主线文件**：`BaseChatModel` 规定模型适配协议，提供统一的 `invoke()`/`stream()`/`batch()` 调用面。
>    - `_convert_input()`：把字符串、消息列表、`PromptValue` 统一归一化为 PromptValue。
>    - `invoke()` → `generate_prompt()` → `_generate()`：从归一化输入到 provider 调用的完整链路。
>    - `bind_tools()`、`with_structured_output()`：模型能力声明，不包含执行。
> 2. `langchain_core.prompt_values`：`libs/core/langchain_core/prompt_values.py`
>    - `PromptValue`、`ChatPromptValue`：Prompt 模板与模型之间的交接协议。
> 3. `langchain_core.messages`：`libs/core/langchain_core/messages/`
>    - `BaseMessage`、`BaseMessageChunk`：消息公共字段和流式合并。
>    - `SystemMessage`（`system.py`）、`HumanMessage`（`human.py`）：系统指令和用户输入。
>    - `AIMessage`（`ai.py`）、`AIMessageChunk`：模型输出、工具调用（`tool_calls`）和 token 用量。
>    - `ToolMessage`（`tool.py`）：工具执行结果与原始调用的配对（`tool_call_id`）。
>    - `ToolCall`（`content.py`）：工具调用的结构化协议。
> 4. `langchain_core.tools`：`libs/core/langchain_core/tools/`
>    - `tool()`（`convert.py`）：把 Python 函数转成 `BaseTool` 对象。
>    - `BaseTool`（`base.py`）：工具协议基类，同时是 Runnable；`get_input_schema()`、`tool_call_schema` 区分模型可见 Schema 与本地执行 Schema。
>    - `invoke()` → `run()` → `_run()`：归一化输入 → 注入运行时上下文 → 执行业务逻辑 → `_format_output()`。
>    - `Tool`（`simple.py`）、`StructuredTool`（`structured.py`）：字符串工具和结构化参数工具的实现差异。
> 5. `langchain_core.outputs.chat_generation`：`libs/core/langchain_core/outputs/chat_generation.py`
>    - `ChatGeneration`、`ChatGenerationChunk`：provider 结果如何承载消息。
> 6. `langchain_core.runnables.base`：`libs/core/langchain_core/runnables/base.py`
>    - `Runnable`、`RunnableConfig`：所有执行组件共享的调用协议，仅在边界说明中出现。

代码块保留真实源码的函数边界和关键调用；为便于阅读，省略无关字段、重载和异常收尾。源码里的英文文档字符串与行内说明会翻译成中文，新增注释只用于标出输入、输出和副作用。

## 先给结论：这三个核心对象是 Agent 的协议层

`create_agent()` 的 `model`、`tools`、`messages` 参数，以及 Agent 运行时的每一次模型推理、每一次工具执行、每一次消息追加，背后都是这三组类型在交接数据：

| 对象 | Agent 里的角色 | 核心方法/字段 | 本文定位 |
| --- | --- | --- | --- |
| `BaseChatModel` | 每次推理走 `invoke(messages, config)`，产出 `AIMessage` | `_convert_input()` → `generate_prompt()` → `_generate()`；`bind_tools()` 声明工具 | 输入归一化 → provider 调用 → `AIMessage` 的完整链路 |
| `BaseMessage` 子类 | Agent State 中的消息列表，决定下一轮模型输入 | `AIMessage.tool_calls`、`ToolMessage.tool_call_id` | 角色语义 + 工具调用的结构化配对 |
| `BaseTool` | Agent 执行工具时走 `invoke(tool_call, config)` | `invoke()` → `run()` → `_run()` → `_format_output()` | Schema 生成、运行时注入、结果包装 |

不是孤立地看源码，而是追踪一条贯穿全文的链路：**外部输入 → 模型推理 → AIMessage.tool_calls → 工具执行 → ToolMessage → 回到模型**。读完这篇，再读 [03：`create_agent()` 装配主线](./03-create-agent-assembly.md) 时，每条边的输入输出已经清楚了。

## 核心调用链

下面是把一次"模型决定调用工具"的源码核心调用链，按数据流向分成四个阶段：

```text
———— 阶段一：输入归一化 ————
字符串 / Message 列表 / PromptValue
  │
  ├─→ BaseChatModel._convert_input()   ← 三类输入统一转为 PromptValue
  │
  ├─→ PromptValue.to_messages()        ← PromptValue 转成 Message 列表
  │
  ├─→ BaseChatModel.generate_prompt()  ← 对每个 PromptValue 调用 generate()
  │
———— 阶段二：模型调用与结果提取 ————
  │
  ├─→ provider._generate()             ← 子类实现的真正 provider 请求（HTTP/鉴权/响应解析）
  │
  ├─→ ChatResult.generations[0][0]     ← 取第一条候选生成结果
  │
  ├─→ ChatGeneration.message           ← 取出 provider 响应中第一条 AIMessage
  │
  ├─→ AIMessage.tool_calls             ← 工具调用不是文本，是结构化字段列表
  │
———— 阶段三：工具执行 ————
  │
  ├─→ BaseTool.invoke()                ← Runnable 入口：归一化输入，提取 tool_call_id
  │
  ├─→ BaseTool.run()                   ← 管理回调、传入运行时上下文、处理错误
  │
  ├─→ BaseTool._run()                  ← 子类实现的真正业务逻辑（函数的副作用在此发生）
  │
  ├─→ _format_output()                 ← 有 tool_call_id 时包装为 ToolMessage
  │
  ├─→ ToolMessage(tool_call_id=原始调用 ID)  ← 结果与原始调用配对，下一轮模型据此识别
  │
———— 阶段四：循环（由 Agent Runtime 控制，01 只说明协议边界）————
  │
  └─→ 下一轮 ChatModel.invoke(messages + ToolMessage)
```

这里有三个边界：

- **模型边界**：输入统一成 `PromptValue`，输出统一成 `AIMessage`。provider 的 HTTP 调用发生在 `_generate()` 内部，但上下游只看到 `PromptValue → AIMessage`。
- **消息边界**：工具调用不是普通文本，而是 `AIMessage.tool_calls` 中的结构化字段。Agent Runtime 据此决定是否进入工具执行，而不是重新解析 `AIMessage.content`。
- **执行边界**：`BaseTool` 只负责工具协议和本地调用；是否允许调用、调用几次、是否暂停由 Agent Runtime 或 Middleware 决定。

## 一、聊天模型：从输入归一化到 `AIMessage`

### 1. `BaseChatModel` 规定的是模型适配协议

源码路径：`libs/core/langchain_core/language_models/chat_models.py`

`BaseChatModel` 继承 `BaseLanguageModel[AIMessage]`，同时也是 Runnable。它规定了调用模型时使用的统一入口，但不替 provider 实现 HTTP 请求、鉴权和响应解析。

| 方法 | 是否由基类提供 | 作用 |
| --- | --- | --- |
| `invoke()` | 是 | 单次调用，最终返回 `AIMessage` |
| `ainvoke()` | 是 | 默认把同步调用放入异步执行器 |
| `stream()` / `astream()` | 是 | 返回 `AIMessageChunk` 流；没有原生实现时分别退回 `invoke()` / `ainvoke()` |
| `batch()` / `abatch()` | 是 | 批量调用；默认是并发执行多次 `invoke()` / `ainvoke()` |
| `generate_prompt()` | 是 | 把 `PromptValue` 转成 Message 列表后进入批量生成 |
| `_generate()` | 子类必须实现 | 调用具体 provider 并返回 `ChatResult` |
| `_stream()` | 子类可选实现 | 返回 `ChatGenerationChunk` 流 |
| `bind_tools()` | provider 通常实现 | 把工具 Schema 编码进模型请求 |
| `with_structured_output()` | 基类提供适配入口，provider 可覆盖 | 根据 Schema 返回结构化结果；底层可能使用 provider 原生结构化输出或工具调用 |

源码中的抽象声明：

```python
class BaseChatModel(BaseLanguageModel[AIMessage], ABC):
    # 子类必须实现真正的 provider 调用。
    # _stream、_agenerate、_astream 是可选的原生能力。
    # bind_tools 也由具体模型集成决定如何把工具转换成 provider 格式。
    ...
```

因此，`langchain-core` 只规定“调用前后应该交接什么对象”；具体模型包负责把这些对象转换成 OpenAI、Anthropic 或其他服务商的请求和响应。

### 2. `_convert_input()` 统一三类模型输入


```python
def _convert_input(self, model_input: LanguageModelInput) -> PromptValue:
    if isinstance(model_input, PromptValue):
        # Prompt 已经完成格式化，直接复用。
        return model_input
    if isinstance(model_input, str):
        # 字符串包装成 StringPromptValue，之后仍走 PromptValue 协议。
        return StringPromptValue(text=model_input)
    if isinstance(model_input, Sequence):
        # 元组、字典和 BaseMessage 列表统一转换成 ChatPromptValue。
        return ChatPromptValue(messages=convert_to_messages(model_input))
    msg = (
        f"Invalid input type {type(model_input)}. "
        "Must be a PromptValue, str, or list of BaseMessages."
    )
    raise ValueError(msg)
```

这个方法没有调用模型，也没有把输入转换成某个 provider 的 JSON。它只做一件事：把外部输入收窄成模型层内部统一消费的 `PromptValue`。

输入和输出的关系是：

```text
"请介绍 LangChain"
  → StringPromptValue(text="请介绍 LangChain")

[SystemMessage(...), HumanMessage(...)]
  → ChatPromptValue(messages=[...])

已经是 PromptValue
  → 原样复用
```

### 3. `invoke()` 取出第一条 `ChatGeneration.message`


```python
@override
def invoke(
    self,
    input: LanguageModelInput,
    config: RunnableConfig | None = None,
    *,
    stop: list[str] | None = None,
    **kwargs: Any,
) -> AIMessage:
    config = ensure_config(config)

    result = self.generate_prompt(
        # generate_prompt 接收 PromptValue 列表，以便统一批量生成入口。
        [self._convert_input(input)],
        stop=stop,
        callbacks=config.get("callbacks"),
        tags=config.get("tags"),
        metadata=config.get("metadata"),
        run_name=config.get("run_name"),
        run_id=config.pop("run_id", None),
        **kwargs,
    )

    # Runnable 的单次 invoke 只返回第一条候选消息。
    return cast("AIMessage", cast("ChatGeneration", result.generations[0][0]).message)
```

这里的 `AIMessage` 不是 provider SDK 的原始响应。它是 LangChain 统一后的对话消息，里面除了文本，还可以携带工具调用、无效工具调用和用量信息。

### 4. `generate_prompt()` 把 PromptValue 转回消息列表


```python
def generate_prompt(
    self,
    prompts: list[PromptValue],
    stop: list[str] | None = None,
    callbacks: Callbacks = None,
    **kwargs: Any,
) -> LLMResult:
    # 每个 PromptValue 都转换成 provider 可以消费的消息列表。
    prompt_messages = [prompt.to_messages() for prompt in prompts]
    return self.generate(
        prompt_messages,
        stop=stop,
        callbacks=callbacks,
        **kwargs,
    )
```

`PromptValue` 的价值在这里体现出来：Prompt 模板不用知道 provider 的请求格式，模型也不用知道模板变量如何拼接。两者通过 `PromptValue` 和 `BaseMessage` 交接。

### 5. provider 的真正实现落在 `_generate()` 和 `_stream()`


```python
def _generate(
    self,
    messages: list[BaseMessage],
    stop: list[str] | None = None,
    run_manager: CallbackManagerForLLMRun | None = None,
    **kwargs: Any,
) -> ChatResult:
    """生成一次聊天结果；provider 集成必须实现这里。"""

def _stream(
    self,
    messages: list[BaseMessage],
    stop: list[str] | None = None,
    run_manager: CallbackManagerForLLMRun | None = None,
    **kwargs: Any,
) -> Iterator[ChatGenerationChunk]:
    # 需要原生流式时，子类返回可逐步合并的 ChatGenerationChunk。
    raise NotImplementedError
```

`_generate()` 是必须实现的 provider 边界；`_stream()` 是可选的原生流式边界。基类如果没有原生流式实现，会退回到一次性 `invoke()` 的结果，而不是凭空生成 token 流。

### 6. `init_chat_model()`：多模型的统一入口

`BaseChatModel` 定的是各 provider 必须遵守的协议，但"用户传一个模型名字符串，如何解析为具体的 provider 实例"是另一层问题。这由 `langchain_v1` 提供的 `init_chat_model()` 解决：

```python
from langchain.chat_models import init_chat_model

# 前缀形式：provider:model-name
model = init_chat_model("openai:gpt-4o")
model = init_chat_model("anthropic:claude-sonnet-4-5")

# 分开传也可以
model = init_chat_model("claude-sonnet-4-5", model_provider="anthropic")

# 运行时切换：声明哪些字段可在 config 里覆盖
model = init_chat_model(
    "openai:gpt-4o-mini",
    configurable_fields=["model_name", "temperature"],
)
```

它的工作流程是：解析 `model` 字符串中的 provider 前缀 → 通过 provider 注册表找到对应的 `ChatModel` 类 → 实例化并注入 `model_name`、`temperature` 等参数。如果装了对应集成包（如 `langchain-openai`、`langchain-anthropic`），直接可用；没装则报错提示。

不传 `model_provider` 时，`init_chat_model()` 会尝试从模型名前缀推断：`gpt-*`/`o1*`/`o3*` → OpenAI，`claude*` → Anthropic，`gemini*` → Google VertexAI，`deepseek*` → DeepSeek 等。但推断是 best-effort 的——生产环境建议显式写 `"openai:gpt-4o"` 避免歧义。

> **Agent 视角**：`create_agent()` 的 `model` 参数接收的就是 `BaseChatModel` 实例，通常先通过 `init_chat_model()` 拿到。这意味着你的 Agent 在不改一行业务逻辑的情况下，换个 provider 前缀就能切模型——因为所有模型都实现了同一个 `BaseChatModel` 协议。

### 6. `bind_tools()` 只是模型层的声明接口


```python
def bind_tools(
    self,
    tools: Sequence[dict[str, Any] | type | Callable[..., Any] | BaseTool],
    *,
    tool_choice: str | None = None,
    **kwargs: Any,
) -> Runnable[LanguageModelInput, AIMessage]:
    # core 只规定工具输入和返回类型，具体 provider 自己实现绑定格式。
    raise NotImplementedError
```

不要把 `bind_tools()` 理解成“工具已经执行”。它只是返回一个绑定了工具声明的模型 Runnable；真正的工具执行仍由 Agent Runtime 调用 `BaseTool.invoke()` 完成。

### 7. `with_structured_output()` 是另一条声明式输出路径

官方文档把结构化输出作为 Chat Model 的独立能力。它和 `bind_tools()` 都会返回一个新的 Runnable，但目标不同：

| 接口 | 模型侧声明 | 调用结果 |
| --- | --- | --- |
| `bind_tools(tools)` | 模型可以请求一个或多个工具 | `AIMessage`，工具请求位于 `tool_calls` |
| `with_structured_output(schema)` | 模型应遵守给定输出 Schema | Schema 对应的结构化对象；可选 `include_raw=True` 同时保留原始 `AIMessage` |

源码中的基类入口是：

```python
def with_structured_output(
    self,
    schema: dict[str, Any] | type,
    *,
    include_raw: bool = False,
    **kwargs: Any,
) -> Runnable[LanguageModelInput, dict | BaseModel]:
    # 基类根据 bind_tools() 构造结构化输出适配器；
    # provider 可以覆盖它，以使用自己的原生 structured-output API。
    ...
```

因此，`with_structured_output()` 也不是“调用模型后再对字符串做 JSON 解析”的简单后处理。它会影响模型调用参数、输出解析和错误处理；不同 provider 的原生支持程度由具体集成包决定。Agent 使用 `response_format` 时，还会在更上层的 `create_agent()` 中选择 provider 原生策略或工具策略，详见 [03：`create_agent()` 装配主线](./03-create-agent-assembly.md)。

## 二、消息类型：把对话和工具调用结构化

### 1. `BaseMessage` 是所有消息的公共数据结构


```python
class BaseMessage(Serializable):
    # 文本消息也可以是内容块列表，用于多模态或结构化内容。
    content: str | list[str | dict[Any, Any]]

    # 保存 provider 原始扩展字段；不应把标准协议全部塞进这里。
    additional_kwargs: dict[Any, Any] = Field(default_factory=dict)

    # 保存响应头、logprobs、token 数量等模型元数据。
    response_metadata: dict[Any, Any] = Field(default_factory=dict)

    # 用于序列化时区分 system、human、ai、tool 等消息类型。
    type: str

    name: str | None = None
    id: str | None = Field(default=None, coerce_numbers_to_str=True)
```

`BaseMessage` 是数据对象，不是 Runnable。它只保存消息内容和协议字段，不负责调用模型或工具。

### 2. 角色类型是不同的协议语义

| 类型 | `type` | 产生方 | 下游作用 |
| --- | --- | --- | --- |
| `SystemMessage` | `"system"` | 应用或 Prompt | 设定模型行为，通常放在消息序列前部 |
| `HumanMessage` | `"human"` | 用户或应用 | 表示用户输入 |
| `AIMessage` | `"ai"` | Chat Model | 保存模型文本、工具调用和用量 |
| `ToolMessage` | `"tool"` | 工具执行器 | 把工具结果回传给模型 |

`SystemMessage` 和 `HumanMessage` 的具体类主要是固定 `type` 字段；真正影响 Agent 循环的是 `AIMessage` 和 `ToolMessage` 的附加协议。

### 3. `AIMessage` 的工具调用不是文本


```python
class AIMessage(BaseMessage):
    # 模型请求执行的工具列表。
    tool_calls: list[ToolCall] = Field(default_factory=list)

    # provider 返回但无法标准化的工具调用。
    invalid_tool_calls: list[InvalidToolCall] = Field(default_factory=list)

    # 跨 provider 统一的 token 用量信息。
    usage_metadata: UsageMetadata | None = None

    # 用于序列化和反序列化。
    type: Literal["ai"] = "ai"
```

`ToolCall` 是一个结构化字典协议：


```python
class ToolCall(TypedDict):
    type: Literal["tool_call"]

    # 用于把 AIMessage 中的请求和 ToolMessage 的结果配对。
    id: str | None

    # 模型选择的工具名称和参数。
    name: str
    args: dict[str, Any]

    # 流式聚合时标记调用位于响应中的哪个位置。
    index: NotRequired[int | str]
```

所以，Agent Runtime 判断“是否继续执行工具”时，读取的是 `AIMessage.tool_calls`，不是重新解析 `AIMessage.content`。

官方文档中的 `content` 还可以是内容块列表，用于文本、图片、音频、文件和工具调用等结构化内容。工程代码不要只假设 `message.content` 永远是字符串；需要跨 provider 处理多模态或标准化内容时，应优先使用 `message.content_blocks`，同时保留 `tool_calls` 作为兼容 Agent 执行协议的标准字段。

### 4. `ToolMessage` 把执行结果关联回调用


```python
class ToolMessage(BaseMessage, ToolOutputMixin):
    # 必须对应 AIMessage.tool_calls 中的某个 id。
    tool_call_id: str

    type: Literal["tool"] = "tool"

    # 可以保存不发送给模型的完整结果，例如原始文件或图片数据。
    artifact: Any = None

    # 工具异常被框架处理为消息时，可以标记为 error。
    status: Literal["success", "error"] = "success"
```

工具消息的最小配对关系是：

```text
AIMessage(
    tool_calls=[{"name": "search", "args": {"query": "..."}, "id": "call-1"}]
)
  → 执行 search
  → ToolMessage(content="...", tool_call_id="call-1")
  → 追加到消息列表
  → 再次调用 Chat Model
```

`artifact` 解决的是“工具需要保留完整结果，但不应把完整结果全部塞进模型上下文”的问题；模型只看到 `content`，应用可以继续使用 `artifact`。

### 5. 流式消息使用 `MessageChunk`


```python
class BaseMessageChunk(BaseMessage):
    def __add__(self, other: Any) -> BaseMessageChunk:
        if isinstance(other, BaseMessageChunk):
            # 两个消息 chunk 可以合并成一个完整消息。
            return self.__class__(
                id=self.id,
                type=self.type,
                content=merge_content(self.content, other.content),
                additional_kwargs=merge_dicts(
                    self.additional_kwargs, other.additional_kwargs
                ),
                response_metadata=merge_dicts(
                    self.response_metadata, other.response_metadata
                ),
            )
        raise TypeError("只能合并 BaseMessageChunk")
```

`AIMessageChunk` 还会保存 `tool_call_chunks`。流式模型返回的不是一条完整 `AIMessage`，而是一系列可以合并的 chunk；聚合结束后，工具调用才会收敛成 `AIMessage.tool_calls`。

## 三、工具系统：从函数、Schema 到本地执行

### 1. `@tool` 做的是对象转换，不是执行

源码包区：`libs/core/langchain_core/tools/convert.py`。

`tool()` 支持无参数装饰器、有名称装饰器，以及把 Runnable 转成工具。它会根据函数签名和类型注解推导参数 Schema，最后构造 `StructuredTool`；关闭 Schema 推导时才会构造简单的 `Tool`。


```python
def tool(
    name_or_callable: str | Callable[..., Any] | None = None,
    runnable: Runnable[Any, Any] | None = None,
    *,
    description: str | None = None,
    return_direct: bool = False,
    args_schema: ArgsSchema | None = None,
    infer_schema: bool = True,
    response_format: Literal["content", "content_and_artifact"] = "content",
    ...
) -> BaseTool | Callable[..., BaseTool]:
    ...

def _tool_factory(
    dec_func: Callable[..., Any] | Runnable[Any, Any],
) -> BaseTool:
    # 普通函数保存为 func，协程函数保存为 coroutine。
    if inspect.iscoroutinefunction(dec_func):
        coroutine = dec_func
        func = None
    else:
        coroutine = None
        func = dec_func

    if infer_schema or args_schema is not None:
        # 默认构造结构化工具，参数 Schema 来自函数签名或显式 args_schema。
        return StructuredTool.from_function(
            func,
            coroutine,
            name=tool_name,
            description=tool_description,
            args_schema=args_schema,
            infer_schema=infer_schema,
            response_format=response_format,
        )

    # 不推导 Schema 时，退化为字符串输入的简单 Tool。
    return Tool(name=tool_name, func=func, description=f"{tool_name} tool")
```

`@tool` 本身不会调用函数，也不会访问模型。它只是把函数包装成一个带有名称、描述和参数 Schema 的 `BaseTool` 对象。

官方文档建议为工具函数提供类型注解和清晰的描述。类型注解决定 Schema 的字段类型；函数 docstring 或显式 `description` 解释工具用途，二者都会影响模型是否正确选择工具和填充参数。Schema 解决“参数形状是否正确”，不解决“调用是否有权限”。

### 2. `BaseTool` 同时是工具协议和 Runnable


```python
class BaseTool(RunnableSerializable[str | dict[str, Any] | ToolCall, Any]):
    # 模型看到的工具名称。
    name: str

    # 告诉模型什么时候、为什么使用该工具。
    description: str

    # 校验工具参数的 Pydantic Schema 或 JSON Schema。
    args_schema: Annotated[ArgsSchema | None, SkipValidation()] = Field(
        default=None,
        description="工具参数 Schema",
    )
```

继承 `RunnableSerializable` 意味着工具可以被统一调用、追踪和组合；但它的输入类型比普通 Runnable 更复杂，至少要处理字符串、字典和带 `id` 的 `ToolCall`。

### 3. `Tool` 与 `StructuredTool` 的区别

`@tool` 装饰器内部会根据你的函数签名自动选择两种实现：

| | `Tool` | `StructuredTool` |
|---|---|---|
| **输入** | 单个字符串 `str` | 字典 `dict[str, Any]`，字段由参数 Schema 定义 |
| **Schema 来源** | 无 Schema（或用户手动传 JSON Schema） | 从函数签名的类型注解和 docstring 自动推导 Pydantic Schema |
| **适用场景** | 简单单参数工具，如 `search(query: str)` | 多参数工具，如 `create_file(path: str, content: str, encoding: str = "utf-8")` |
| **模型看到的** | 一个无结构的 `str` 参数 | 带字段名、类型和描述的 JSON Schema |
| **何时生成** | `@tool(infer_schema=False)` 或函数只有一个简单参数时 | **默认行为**：`@tool` 不加参数，自动推导 Schema |

核心原则：只要你的工具有两个或以上参数，让 `@tool` 默认选择 `StructuredTool`——模型需要知道每个字段的含义才能正确填充。单参数工具两者均可，但 `StructuredTool` 可以让模型更明确地知道参数语义。

实际代码中几乎不手动选择——`@tool` 的默认行为就是 `infer_schema=True`，会自动走到 `StructuredTool`。只用 `Tool` 的情况通常是：工具本身就是接收一段完整指令文本，不需要结构化参数。

### 3. 模型可见 Schema 与本地执行 Schema 不完全相同

`BaseTool` 有两个相关入口：

- `get_input_schema()`：工具本地调用时使用的完整输入 Schema；
- `tool_call_schema`：交给模型的工具调用 Schema，会排除注入参数。


```python
@property
def tool_call_schema(self) -> ArgsSchema:
    # 从完整输入 Schema 中筛掉运行时注入参数。
    full_schema = self.get_input_schema()
    fields = []
    for name, type_ in get_all_basemodel_annotations(full_schema).items():
        if not _is_injected_arg_type(type_):
            fields.append(name)
    return _create_subset_model(
        self.name,
        full_schema,
        fields,
        fn_description=self.description,
    )

def get_input_schema(
    self, config: RunnableConfig | None = None
) -> type[BaseModel]:
    if self.args_schema is not None:
        if isinstance(self.args_schema, dict):
            return super().get_input_schema(config)
        return self.args_schema
    # 没有显式 Schema 时，从 _run() 函数签名创建。
    return create_schema_from_function(self.name, self._run)
```

这一区分很重要：模型只需要知道 `query`、`path` 等业务参数；`run_manager`、`RunnableConfig`、`ToolRuntime` 之类的运行时上下文由框架在本地执行时注入。

### 4. `invoke()` 归一化输入，`run()` 负责执行生命周期


```python
@override
def invoke(
    self,
    input: str | dict[str, Any] | ToolCall,
    config: RunnableConfig | None = None,
    **kwargs: Any,
) -> Any:
    # ToolCall 会携带 tool_call_id；普通字典则只有业务参数。
    tool_input, kwargs = _prep_run_args(input, config, **kwargs)
    return self.run(tool_input, **kwargs)
```

`run()` 的核心执行段如下：

```python
child_config = patch_config(config, callbacks=run_manager.get_child())
with set_config_context(child_config) as context:
    # 将字典或 ToolCall 转成位置参数和关键字参数。
    tool_args, tool_kwargs = self._to_args_and_kwargs(
        tool_input, tool_call_id
    )

    # 运行时上下文只注入本地函数，不暴露给模型。
    if signature(self._run).parameters.get("run_manager"):
        tool_kwargs |= {"run_manager": run_manager}
    if config_param := _get_runnable_config_param(self._run):
        tool_kwargs |= {config_param: config}

    # _run() 才是具体工具的业务副作用入口。
    response = context.run(self._run, *tool_args, **tool_kwargs)

# 根据 response_format 和 tool_call_id 统一包装输出。
output = _format_output(content, artifact, tool_call_id, self.name, status)
run_manager.on_tool_end(output, color=color, name=self.name, **kwargs)
return output
```

执行顺序可以概括成：

```text
ToolCall / dict / str
  → _prep_run_args()
  → _to_args_and_kwargs()
  → Schema 校验
  → 注入 run_manager / config
  → _run()
  → 处理 ToolException / ValidationError
  → _format_output()
  → ToolMessage 或普通结果
```

工具有 Schema 不代表它自动拥有权限、重试、限额和人工确认。这些策略属于 [04：Middleware 控制面](./04-middleware-control-plane.md) 或更上层的 Agent Runtime。

### 5. 工具结果如何变成 `ToolMessage`


```python
def _format_output(
    content: Any,
    artifact: Any,
    tool_call_id: str | None,
    name: str,
    status: str,
) -> ToolOutputMixin | Any:
    # 已经是 ToolOutputMixin 的结果，或没有调用 ID 的普通调用，不重复包装。
    if (
        isinstance(content, list)
        and content
        and all(isinstance(item, ToolOutputMixin) for item in content)
    ):
        return content
    if isinstance(content, ToolOutputMixin) or tool_call_id is None:
        return content

    # 先把字符串、内容块列表等值规范化成 ToolMessage 可消费的内容。
    normalized_content = _normalize_message_content(content)
    content = _stringify(content) if normalized_content is None else normalized_content

    # 有 tool_call_id 时，工具结果必须带回调用关联信息。
    return ToolMessage(
        content=content,
        artifact=artifact,
        tool_call_id=tool_call_id,
        name=name,
        status=status,
    )
```

因此：

- 直接调用 `tool.invoke({"query": "..."})`，可以得到普通返回值；
- Agent 根据 `AIMessage.tool_calls` 调用工具时，通常会把 `ToolCall` 的 ID 带入，结果就会被包装成 `ToolMessage`；
- `ToolMessage.tool_call_id` 是下一轮模型识别“这条结果对应哪次调用”的关键字段。

## 四、容易混淆的边界

以下几条在上面各节已展开，这里压缩成一句话对照：

| 误解 | 实际 |
| --- | --- |
| `bind_tools()` 会立即执行工具 | 只绑定 Schema，执行由 Agent Runtime 驱动 |
| 从 `AIMessage.content` 里找工具调用 JSON | 标准协议在 `AIMessage.tool_calls` |
| `BaseTool.invoke()` 就是业务函数 | `invoke()`→`run()`→`_run()` 三层，业务逻辑在最底层 |
| `message.content` 永远是字符串 | 可以是内容块列表；`tool_calls`/`usage_metadata` 有独立字段 |
| `langchain-core` 会自动完成 Agent 循环 | 循环和状态由 `create_agent()` 上层装配

## 工程判断（Agent 视角）

### 必须理解

- `BaseChatModel.invoke()` 的完整链路：`_convert_input()` → `generate_prompt()` → `_generate()`——Agent 每次模型推理都走这条路。
- `AIMessage.tool_calls` 与 `ToolMessage.tool_call_id` 的配对关系——Agent 判断"工具是否已执行完"靠的就是这条链路。
- `BaseTool` 的三层结构（`invoke()`/`run()`/`_run()`）——写工具时你只实现 `_run()`，框架负责归一化、Schema 校验和 `ToolMessage` 包装。

### 只在写工具/Middleware 时需要关注

- `get_input_schema()` 与 `tool_call_schema` 的差异——如果工具需要接收 `RunnableConfig` 等运行时参数但不想暴露给模型，这里就是注入点。
- `BaseMessageChunk.__add__()`——排查流式 Agent "工具调用为什么没触发"时有用：流式输出未聚合完时 `tool_calls` 尚未形成。
- `_format_output()`——仅在自定义工具返回格式不符合默认 `ToolMessage` 包装规则时需要覆盖。

### 日常写 Agent 不需要关心

- `ChatGeneration` 和 `ChatResult`——框架内部对象，直接取 `.message` 即可，正常业务代码不会手动构造。
- `Tool` vs `StructuredTool` 的实现差异——用 `@tool` 装饰器自动选择合适的子类。
- `with_structured_output()` 内部的 provider 策略切换——除非你要跨 provider 做统一的 structured output，否则让框架自动选择即可。
