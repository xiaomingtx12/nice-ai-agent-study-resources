---
sidebar_position: 11
sidebar_label: 09 上下文与隐私治理
description: 对照摘要、上下文编辑和 PII 脱敏的源码实现，区分 State、模型请求和流式事件三条内容治理路径。
---

# LangChain 源码解析 09：上下文与隐私治理——摘要、历史编辑与 PII

> 固定提交与已阅读测试见[源码基线](source-baseline.md)。

**源码定位**

> **阅读基线**：`langchain` 1.3.7、`langchain-core` 1.4.6（仓库快照 `langchain-core==1.4.6-2-g76c32db9b3`）。
> 路径相对 LangChain 仓库根目录；版本说明见 [系列导读](index.md)。
>
> - 摘要与截断：`libs/langchain_v1/langchain/agents/middleware/summarization.py` → SummarizationMiddleware.before_model()、_find_safe_cutoff_point()、_create_summary()。
> - 请求副本编辑：`libs/langchain_v1/langchain/agents/middleware/context_editing.py` → ClearToolUsesEdit.apply()、ContextEditingMiddleware.wrap_model_call()。
> - 状态与流事件脱敏：`libs/langchain_v1/langchain/agents/middleware/pii.py` → PIIMiddleware.before_model()、after_model()、_PIIStreamTransformer.process()。
> - 检测与替换策略：`libs/langchain_v1/langchain/agents/middleware/_redaction.py` → RedactionRule、apply_strategy()、PIIDetectionError。

## 一、先区分 State、请求和事件三个数据位置

这三个中间件都在控制“模型或调用方能看到什么”，但修改位置不同：

| 中间件 | 修改位置 | 是否改变图内 State | 主要代价 |
| --- | --- | --- | --- |
| `SummarizationMiddleware` | `before_model` | 是 | 额外调用摘要模型，存在信息损失 |
| `ContextEditingMiddleware` | `wrap_model_call` | 否，默认只改 Request 副本 | 可能丢失旧工具结果细节 |
| `PIIMiddleware` | `before_model`、`after_model`、流式事件 | State Hook 会改，Transformer 只改事件视图 | 覆盖范围和执行顺序容易漏配 |

不要把“减少 token”和“隐私脱敏”归为同一种消息处理。前者改变模型上下文，后者控制敏感值在哪些边界被释放。

## 二、摘要：重建历史，而不是删除几条消息

`SummarizationMiddleware` 在 `before_model` 判断是否达到摘要条件。触发条件支持三种基本单位：

- `("messages", n)`：消息数量达到 `n`。
- `("tokens", n)`：token 数达到 `n`。
- `("fraction", f)`：达到模型最大输入 token 的比例 `f`。

还可以使用 `TriggerClause` 同时声明多个条件。一个子句内是 AND（同时满足），多个子句之间是 OR（任一满足）。

源码：`summarization.py:163-189`

```python
class TriggerClause(TypedDict, total=False):
    tokens: int
    messages: int
```

构造函数还区分“何时触发”和“触发后保留多少”：

源码：`summarization.py:216-226`

```python
def __init__(
    self,
    model: str | BaseChatModel,
    *,
    trigger: (
        ContextSize
        | TriggerClause
        | list[ContextSize | TriggerClause]
        | None
    ) = None,
    keep: ContextSize = ("messages", _DEFAULT_MESSAGES_TO_KEEP),
    token_counter: TokenCounter = count_tokens_approximately,
    summary_prompt: str = DEFAULT_SUMMARY_PROMPT,
    trim_tokens_to_summarize: int | None = _DEFAULT_TRIM_TOKEN_LIMIT,
    **deprecated_kwargs: Any,
) -> None:
    if isinstance(model, str):
        model = init_chat_model(model)

    self.model = model
    self.trigger = self._copy_trigger(trigger)
    self._trigger_clauses = self._normalize_trigger(self.trigger)
    self.keep = self._validate_context_size(keep, "keep")
    # 默认计数器会按模型类型调整近似参数
    if token_counter is count_tokens_approximately:
        self.token_counter = _get_approximate_token_counter(self.model)
        self._partial_token_counter = partial(
            self.token_counter,
            use_usage_metadata_scaling=False,
        )
    else:
        self.token_counter = token_counter
        self._partial_token_counter = token_counter
    self.summary_prompt = summary_prompt
    self.trim_tokens_to_summarize = trim_tokens_to_summarize
```

fraction 使用中间件 self.model 的 profile["max_input_tokens"]，这里是传入的摘要模型，不会自动读取主 Agent 本轮切换后的模型窗口。若两者不同，应显式选择适合主请求的阈值。缺少所需 profile 信息时构造期报错。默认近似计数主要观察 messages，并不因此覆盖全部系统提示词、工具 schema 与输出预留。

### 1、触发后如何替换消息

核心逻辑在 `before_model`：

源码：`summarization.py:358-394`

```python
@override
def before_model(
    self, state: AgentState[Any], runtime: Runtime[ContextT]
) -> dict[str, Any] | None:
    messages = state["messages"]
    self._ensure_message_ids(messages)

    total_tokens = self.token_counter(messages)
    if not self._should_summarize(messages, total_tokens):
        return None

    cutoff_index = self._determine_cutoff_index(messages)
    if cutoff_index <= 0:
        return None

    messages_to_summarize, preserved_messages = self._partition_messages(
        messages, cutoff_index
    )

    summary = self._create_summary(messages_to_summarize)
    new_messages = self._build_new_messages(summary)

    return {
        "messages": [
            RemoveMessage(id=REMOVE_ALL_MESSAGES),
            *new_messages,
            *preserved_messages,
        ]
    }
```

这里不是简单返回一条摘要消息，而是：

1. 确保消息有 ID，供 `add_messages` Reducer（归约器）定位。
2. 计算截断点，把旧消息分成“送去摘要”和“继续保留”两段。
3. 返回 `RemoveMessage(id=REMOVE_ALL_MESSAGES)` 清空旧消息，再写入摘要消息和保留消息。

摘要消息实际是一个带来源标记的 `HumanMessage`：

源码：`summarization.py:709-716`

```python
@staticmethod
def _build_new_messages(summary: str) -> list[HumanMessage]:
    return [
        HumanMessage(
            content=f"Here is a summary of the conversation to date:\n\n{summary}",
            additional_kwargs={"lc_source": "summarization"},
        )
    ]
```

摘要 Prompt 要求模型输出会话意图、重要上下文、产物和下一步。它不是无损压缩，摘要模型的判断会决定哪些信息继续存在。

### 2、截断不能拆开 AI 和 Tool 消息对

cutoff_index 把列表分为 messages[:cutoff_index]（待摘要）和 messages[cutoff_index:]（保留）。若切点落在 ToolMessage 上，源码向前找配对的 AIMessage，将切点移到它的位置，使调用与结果一起留在保留区：

源码：`summarization.py:751-785`

```python
@staticmethod
def _find_safe_cutoff_point(
    messages: list[AnyMessage],
    cutoff_index: int,
) -> int:
    if cutoff_index >= len(messages) or not isinstance(messages[cutoff_index], ToolMessage):
        return cutoff_index

    # 收集截断点之后连续工具结果的 ID
    tool_call_ids: set[str] = set()
    idx = cutoff_index
    while idx < len(messages) and isinstance(messages[idx], ToolMessage):
        tool_msg = cast("ToolMessage", messages[idx])
        if tool_msg.tool_call_id:
            tool_call_ids.add(tool_msg.tool_call_id)
        idx += 1

    # 向前寻找包含这些工具调用的 AIMessage
    for i in range(cutoff_index - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, AIMessage) and msg.tool_calls:
            ai_tool_call_ids = {
                tc.get("id") for tc in msg.tool_calls if tc.get("id")
            }
            if tool_call_ids & ai_tool_call_ids:
                return i

    # 找不到匹配的 AIMessage 时，向后越过工具结果，避免留下孤立响应
    return idx
```

例如原序列为用户消息、AI 调用、工具结果、AI 回答，目标切点位于工具结果时，会前移到 AI 调用，后面三条一起保留。因此 keep 的消息数量不是严格的最终条数上限。这个算法处理切点附近的配对，不会修复整段历史中所有缺失或重复的工具消息。

### 3、摘要本身会再调用一次模型

源码通过独立模型生成摘要，并给这次调用加上 `lc_source="summarization"` 元数据：

源码：`summarization.py:787-811`

```python
def _create_summary(self, messages_to_summarize: list[AnyMessage]) -> str:
    if not messages_to_summarize:
        return "No previous conversation history."

    trimmed_messages = self._trim_messages_for_summary(messages_to_summarize)
    if not trimmed_messages:
        return "Previous conversation was too long to summarize."

    formatted_messages = get_buffer_string(trimmed_messages)

    try:
        response = self.model.invoke(
            self.summary_prompt.format(messages=formatted_messages).rstrip(),
            config={"metadata": {"lc_source": "summarization"}},
        )
        return response.text.strip()
    except Exception as e:
        return f"Error generating summary: {e!s}"
```

因此摘要会增加模型调用、延迟和费用。失败分支返回的错误文本仍会作为 summary 进入前面的 RemoveMessage 更新，旧历史不会因摘要失败而自动保留。要改变这一行为，需要让失败跳过替换、停止运行或从可信归档恢复。当前中间件也不负责删除已经存在的旧检查点。

## 三、上下文编辑：只改模型请求副本

`ContextEditingMiddleware` 的默认策略是 `ClearToolUsesEdit`：

源码：`context_editing.py:57-77`

```python
@dataclass(slots=True)
class ClearToolUsesEdit(ContextEdit):
    trigger: int = 100_000
    clear_at_least: int = 0
    keep: int = 3
    clear_tool_inputs: bool = False
    exclude_tools: Sequence[str] = ()
    placeholder: str = DEFAULT_TOOL_PLACEHOLDER
```

它与摘要的差别是：不生成新摘要，只清理旧工具结果的内容。

### 1、清理保留了消息协议

源码：`context_editing.py:79-155`

```python
def apply(
    self,
    messages: list[AnyMessage],
    *,
    count_tokens: TokenCounter,
) -> None:
    tokens = count_tokens(messages)
    if tokens <= self.trigger:
        return

    candidates = [
        (idx, msg)
        for idx, msg in enumerate(messages)
        if isinstance(msg, ToolMessage)
    ]

    if self.keep >= len(candidates):
        candidates = []
    elif self.keep:
        candidates = candidates[: -self.keep]

    cleared_tokens = 0
    excluded_tools = set(self.exclude_tools)

    for idx, tool_message in candidates:
        if tool_message.response_metadata.get("context_editing", {}).get("cleared"):
            continue

        # 找到该工具结果之前最近的 AIMessage
        ai_message = next(
            (
                m
                for m in reversed(messages[:idx])
                if isinstance(m, AIMessage)
            ),
            None,
        )
        if ai_message is None:
            continue

        # 用 tool_call_id 找回原始工具调用
        tool_call = next(
            (
                call
                for call in ai_message.tool_calls
                if call.get("id") == tool_message.tool_call_id
            ),
            None,
        )
        if tool_call is None:
            continue

        if (tool_message.name or tool_call["name"]) in excluded_tools:
            continue

        messages[idx] = tool_message.model_copy(
            update={
                "artifact": None,
                "content": self.placeholder,
                "response_metadata": {
                    **tool_message.response_metadata,
                    "context_editing": {
                        "cleared": True,
                        "strategy": "clear_tool_uses",
                    },
                },
            }
        )

        if self.clear_tool_inputs:
            messages[messages.index(ai_message)] = (
                self._build_cleared_tool_input_message(
                    ai_message,
                    tool_message.tool_call_id,
                )
            )

        if self.clear_at_least > 0:
            new_token_count = count_tokens(messages)
            cleared_tokens = max(0, tokens - new_token_count)
            if cleared_tokens >= self.clear_at_least:
                break
```

清理结果仍保留 `ToolMessage`，只把 `content` 替换成占位符，并在 `response_metadata` 中标记已清理。这样 `tool_call_id` 配对关系仍然存在，下一轮模型知道这里曾经有工具结果。

`clear_tool_inputs=True` 时，源码还会把对应 `AIMessage` 中该工具调用的 `args` 替换为空字典。默认值是 `False`，因为工具参数可能仍是后续推理所需的上下文。

### 2、为什么它不直接改 State

中间件在 `wrap_model_call` 中先深复制消息，再把编辑后的消息放进新的 `ModelRequest`：

源码：`context_editing.py:220-255`

```python
def wrap_model_call(
    self,
    request: ModelRequest[ContextT],
    handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
) -> ModelResponse[ResponseT] | AIMessage:
    if not request.messages:
        return handler(request)

    if self.token_count_method == "approximate":
        def count_tokens(messages: Sequence[BaseMessage]) -> int:
            return count_tokens_approximately(messages)
    else:
        system_msg = [request.system_message] if request.system_message else []

        def count_tokens(messages: Sequence[BaseMessage]) -> int:
            return request.model.get_num_tokens_from_messages(
                system_msg + list(messages),
                request.tools,
            )

    edited_messages = deepcopy(list(request.messages))
    for edit in self.edits:
        edit.apply(edited_messages, count_tokens=count_tokens)

    return handler(request.override(messages=edited_messages))
```

这建立了两个视图：

- 图内 State 仍保留原始历史，便于检查点、审计和后续策略使用。
- 当前模型只收到清理后的消息副本。

approximate 分支按传入消息估算；model 分支把 system_message 与 request.tools 一并交给当前模型的统计方法。后者是否准确、是否需要远端调用，取决于模型适配器。ClearToolUsesEdit 仅在超过 trigger 时尝试清理候选，受 keep、exclude_tools 和可配对结果数量限制，不保证处理后一定低于 trigger。

## 四、PII：状态 Hook 与流式 Transformer 两条路径

PII（Personally Identifiable Information，个人身份信息）中间件先解析一条脱敏规则：

- 内置类型：`email`、`credit_card`、`ip`、`mac_address`、`url`。
- 自定义类型：传入正则字符串或检测 callable。
- 策略：`block`、`redact`、`mask`、`hash`。

策略实现位于 `_redaction.py`：

源码：`_redaction.py:306-337`

```python
def apply_strategy(
    content: str,
    matches: list[PIIMatch],
    strategy: RedactionStrategy,
) -> str:
    if not matches:
        return content
    if strategy == "redact":
        return _apply_redact_strategy(content, matches)
    if strategy == "mask":
        return _apply_mask_strategy(content, matches)
    if strategy == "hash":
        return _apply_hash_strategy(content, matches)
    if strategy == "block":
        raise PIIDetectionError(matches[0]["type"], matches)
    raise ValueError(f"Unknown redaction strategy: {strategy}")
```

四种策略的边界：

| 策略 | 行为 | 适合场景 |
| --- | --- | --- |
| `block` | 检测到 PII 就抛 `PIIDetectionError` | 禁止敏感值继续流转 |
| `redact` | 替换为类型占位符 | 脱敏后继续运行 |
| `mask` | 保留部分字符 | 需要人工识别部分内容 |
| `hash` | 使用确定性哈希替换 | 需要关联分析但不暴露原文 |

### 1、State 路径的覆盖范围不是“所有消息”

构造参数决定三类 State Hook：

源码：`pii.py:556-567`

```python
def __init__(
    self,
    pii_type: Literal["email", "credit_card", "ip", "mac_address", "url"] | str,
    *,
    strategy: Literal["block", "redact", "mask", "hash"] = "redact",
    detector: Callable[[str], list[PIIMatch]] | str | None = None,
    apply_to_input: bool = True,
    apply_to_output: bool = False,
    apply_to_tool_results: bool = False,
) -> None:
    super().__init__()

    self.apply_to_input = apply_to_input
    self.apply_to_output = apply_to_output
    self.apply_to_tool_results = apply_to_tool_results

    self._resolved_rule = RedactionRule(
        pii_type=pii_type,
        strategy=strategy,
        detector=detector,
    ).resolve()
    self.pii_type = self._resolved_rule.pii_type
    self.strategy = self._resolved_rule.strategy
    self.detector = self._resolved_rule.detector
```

`before_model` 的实际范围是：

- `apply_to_input=True`：从后向前找**最后一条** `HumanMessage`，只处理这条消息的内容。
- `apply_to_tool_results=True`：找到最后一条 `AIMessage`，处理其后面的 `ToolMessage`。
- `apply_to_output=True`：由 `after_model` 处理最后一条 `AIMessage` 的 `content`。

输出 Hook 保留工具调用字段：

源码：`pii.py:807-846`

```python
@override
def after_model(
    self,
    state: AgentState[Any],
    runtime: Runtime[ContextT],
) -> dict[str, Any] | None:
    if not self.apply_to_output:
        return None

    messages = state["messages"]
    if not messages:
        return None

    # 从后向前找到最后一条 AIMessage
    last_ai_msg = None
    last_ai_idx = None
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, AIMessage):
            last_ai_msg = msg
            last_ai_idx = i
            break

    if last_ai_idx is None or not last_ai_msg or not last_ai_msg.content:
        return None

    content = str(last_ai_msg.content)
    new_content, matches = self._process_content(content)
    if not matches:
        return None

    updated_message = AIMessage(
        content=new_content,
        id=last_ai_msg.id,
        name=last_ai_msg.name,
        tool_calls=last_ai_msg.tool_calls,
    )

    new_messages = list(messages)
    new_messages[last_ai_idx] = updated_message
    return {"messages": new_messages}
```

State Hook 不检查全部历史，也不改 AIMessage.tool_calls 参数。上面重建消息时只保留 content、id、name 和 tool_calls；发生替换后，原 usage_metadata、response_metadata 等字段不会由此构造自动保留。它还对 content 做 str 转换，多模态列表命中时可能变成字符串，需要按业务消息类型核对。

事件 Transformer 可以处理它所消费的工具参数展示，但这不会修改实际派发工具的参数。若敏感值不得发送给外部工具，应在工具执行边界另行检查。

### 2、流式路径使用滑动缓冲

当 `apply_to_output` 或 `apply_to_tool_results` 为真时，构造函数注册 `_PIIStreamTransformer`：

源码：`pii.py:638-656`

```python
if self.apply_to_output or self.apply_to_tool_results:
    self.transformers = (
        partial(
            _PIIStreamTransformer,
            rule=self._resolved_rule,
        ),
    )
```

Transformer 会处理 `messages`、`tools` 和 `values` 三种事件流：

源码：`pii.py:65-98`

```python
before_builtins: ClassVar[bool] = True
required_stream_modes: ClassVar[tuple[str, ...]] = (
    "messages",
    "tools",
    "values",
)

def __init__(
    self,
    scope: tuple[str, ...] = (),
    *,
    rule: ResolvedRedactionRule,
    lookback: int = _DEFAULT_STREAM_LOOKBACK,
) -> None:
    super().__init__(scope)
    self._rule = rule
    self._lookback = lookback
    self._buffers: dict[tuple[str, int], str] = {}
    self._tool_buffers: dict[str, str] = {}

def process(self, event: ProtocolEvent) -> bool:
    method = event["method"]
    if method == "messages":
        return self._process_messages_event(event)
    if method == "tools":
        return self._process_tools_event(event)
    if method == "values":
        return self._process_values_event(event)
    return True
```

文本按 delta（增量片段）传输时，一个邮箱或 URL 可能被拆到多个片段。Transformer 默认保留末尾 128 个字符，等待后续片段拼接后再检测。这会延迟部分展示；缓冲长度有限，不能保证任意长度、跨任意分片的自定义模式都能在释放前识别。

源码：`pii.py:201-218`

```python
def _mutate_tool_output_delta(
    self,
    data: dict[str, Any],
    tool_call_id: str,
) -> None:
    delta = data.get("delta")
    if isinstance(delta, str):
        held = self._tool_buffers.get(tool_call_id, "")
        combined = held + delta

        matches = self._rule.detector(combined)
        if matches:
            combined = apply_strategy(
                combined,
                matches,
                self._rule.strategy,
            )

        emit_end = max(0, len(combined) - self._lookback)
        self._tool_buffers[tool_call_id] = combined[emit_end:]
        data["delta"] = combined[:emit_end]
    elif isinstance(delta, (dict, list)):
        data["delta"] = self._redact_value(delta)
```

`values` 事件的处理会生成脱敏后的新结构，原始 State 仍留给 State Hook 在下一轮独立处理。流式 Transformer 保护的是事件消费者，不是自动修改图内状态。

## 五、三种治理策略如何组合

可以用三个问题区分它们：

| 问题 | 选型 |
| --- | --- |
| 历史太长，需要保留摘要后的任务上下文 | `SummarizationMiddleware` |
| 旧工具结果太占 token，但不值得再摘要 | `ContextEditingMiddleware` |
| 需要处理特定文本中的敏感值 | 按 PII Hook 和 Transformer 的实际字段范围配置，并检查其他出口 |

组合时要特别关注顺序：

- 如果摘要模型也不能看到原始 PII，应让输入脱敏发生在摘要之前，并确认 `before_model` 节点顺序。
- 上下文编辑只改模型请求副本，不能代替 State 级脱敏。
- 流式脱敏只保护事件消费者，不能代替模型调用前的 State Hook。
- 摘要生成的是新的模型文本，不能保证永远不重建或生成敏感值；必要时还要检测摘要输出。

这三种策略的持久性不同：

```text
SummarizationMiddleware
  → RemoveMessage + 摘要消息
  → 改变图内 State 和后续检查点

ContextEditingMiddleware
  → deepcopy(messages) + request.override(messages=edited_messages)
  → 只改变当前模型请求

PIIMiddleware 的 State Hook
  → 返回新的消息列表
  → 改变图内 State

PIIMiddleware 的 Stream Transformer
  → 改写 messages/tools/values 事件
  → 只改变调用方看到的事件视图
```

## 六、工程判断

用同一段工具结果可以看出三条路径的差别：摘要可能将它归纳后从当前 messages 移除；上下文编辑把本次请求中的正文换成占位符；PII 处理则只针对检测规则覆盖的内容。三者的产物、可恢复细节和存储残留都不同。

隐私检查应按数据实际经过的位置进行。输入到达 before_model 前可能已写入检查点或追踪；after_model 修正消息也不会删除旧版本。配置 PII 不能直接承诺原文从未入库，更不能用 UI 上看不到原文来证明所有出口已处理。

流式场景应覆盖敏感值横跨两个片段、长于缓冲、出现在工具参数以及出现在多模态块中的情况。确定性 hash 保留可关联性，也可能被枚举，适合的处理方式由数据用途决定。

长任务中的文件卸载和记忆快照见 [Deep Agents 10](../deepagents/10-summarization-and-context-offloading.md) 与 [13](../deepagents/13-memory-middleware.md)。那些机制改变数据位置，也仍需要区分模型可见内容与实际保存内容。
