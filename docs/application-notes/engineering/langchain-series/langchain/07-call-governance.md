---
sidebar_position: 9
sidebar_label: 07 调用治理：限额、重试与回退
description: 对照观察者线的限额中间件与拦截器线的重试、回退中间件，拆开调用次数、失败处理和模型切换的真实边界。
---

# LangChain 源码 07：调用治理——限额、重试与回退

## 源码定位

> **阅读基线**：`langchain` 1.3.7（`libs/langchain_v1/`）。
>
> **核心路径**：
>
> - 模型调用计数与限额退出：`langchain/agents/middleware/model_call_limit.py`。
> - 工具调用计数、分流和并行工具边界：`langchain/agents/middleware/tool_call_limit.py`。
> - 模型和工具的重试包装器：`langchain/agents/middleware/model_retry.py`、`tool_retry.py`。
> - 主模型失败后的备用模型切换：`langchain/agents/middleware/model_fallback.py`。
> - 异常筛选、退避和失败处理类型：`langchain/agents/middleware/_retry.py`。


| 需求 | 机制 | 主要 Hook |
| --- | --- | --- |
| 到达次数后停止 Agent | 限额（Limit） | `before_model`、`after_model` |
| 同一次调用失败后再试 | 重试（Retry） | `wrap_model_call`、`wrap_tool_call` |
| 主模型失败后换模型 | 回退（Fallback） | `wrap_model_call` |

限额是图节点级别的状态治理，重试和回退是一次调用内部的包装治理。这个区别决定了“调用次数”到底按哪一层统计。

## 一、模型限额：检查在前，计数在后

`ModelCallLimitMiddleware` 使用两个私有状态字段：

- `thread_model_call_count`：线程（thread）级计数，随检查点（Checkpointer）跨多次运行保存。
- `run_model_call_count`：运行（run）级计数，只在本次 `invoke` 内有效，使用 `UntrackedValue` 不写入检查点。

源码：`model_call_limit.py:24-34`

```python
class ModelCallLimitState(AgentState[ResponseT]):
    thread_model_call_count: NotRequired[Annotated[int, PrivateStateAttr]]
    run_model_call_count: NotRequired[
        Annotated[int, UntrackedValue, PrivateStateAttr]
    ]
```

构造函数只允许配置线程级或运行级限额中的至少一个，并把退出行为限制为 `"end"` 和 `"error"`：

源码：`model_call_limit.py:124-164`

```python
state_schema = ModelCallLimitState  # 使用中间件自己的状态 Schema（结构）

def __init__(
    self,
    *,
    thread_limit: int | None = None,
    run_limit: int | None = None,
    exit_behavior: Literal["end", "error"] = "end",
) -> None:
    super().__init__()

    if thread_limit is None and run_limit is None:
        msg = "At least one limit must be specified (thread_limit or run_limit)"
        raise ValueError(msg)

    if exit_behavior not in {"end", "error"}:
        msg = f"Invalid exit_behavior: {exit_behavior}. Must be 'end' or 'error'"
        raise ValueError(msg)

    self.thread_limit = thread_limit
    self.run_limit = run_limit
    self.exit_behavior = exit_behavior
```

限额检查发生在模型节点之前：

源码：`model_call_limit.py:166-210`

```python
@hook_config(can_jump_to=["end"])
@override
def before_model(
    self, state: ModelCallLimitState[ResponseT], runtime: Runtime[ContextT]
) -> dict[str, Any] | None:
    thread_count = state.get("thread_model_call_count", 0)
    run_count = state.get("run_model_call_count", 0)

    thread_limit_exceeded = (
        self.thread_limit is not None
        and thread_count >= self.thread_limit
    )
    run_limit_exceeded = (
        self.run_limit is not None
        and run_count >= self.run_limit
    )

    if thread_limit_exceeded or run_limit_exceeded:
        if self.exit_behavior == "error":
            raise ModelCallLimitExceededError(
                thread_count=thread_count,
                run_count=run_count,
                thread_limit=self.thread_limit,
                run_limit=self.run_limit,
            )
        if self.exit_behavior == "end":
            limit_message = _build_limit_exceeded_message(
                thread_count, run_count, self.thread_limit, self.run_limit
            )
            limit_ai_message = AIMessage(content=limit_message)

            return {"jump_to": "end", "messages": [limit_ai_message]}

    return None
```

模型调用完成后才递增：

源码：`model_call_limit.py:236-251`

```python
@override
def after_model(
    self, state: ModelCallLimitState[ResponseT], runtime: Runtime[ContextT]
) -> dict[str, Any] | None:
    return {
        "thread_model_call_count": state.get("thread_model_call_count", 0) + 1,
        "run_model_call_count": state.get("run_model_call_count", 0) + 1,
    }
```

这里有两个容易误判的地方：

1. 限额判断使用 `>=`，表示达到上限后不再进入下一次模型节点。
2. 计数发生在 `after_model`，它统计的是一次模型节点执行是否返回了结果，不是底层服务商（provider）实际收到了多少次 HTTP 请求。

当 `exit_behavior="end"` 时，Hook 返回 `jump_to="end"`，并注入一条 `AIMessage`；当配置为 `"error"` 时，直接抛出 `ModelCallLimitExceededError`。这两种行为分别对应“让 Agent 正常结束”和“交给调用方处理异常”。

## 二、工具限额：在模型生成工具调用后分流

`ToolCallLimitMiddleware` 的计数是字典，而不是单个整数：

源码：`tool_call_limit.py:35-49`

```python
class ToolCallLimitState(AgentState[ResponseT]):
    thread_tool_call_count: NotRequired[
        Annotated[dict[str, int], PrivateStateAttr]
    ]
    run_tool_call_count: NotRequired[
        Annotated[dict[str, int], UntrackedValue, PrivateStateAttr]
    ]
```

字典的 key 是工具名；当 `tool_name=None` 时使用 `"__all__"` 统计全部工具。这样可以同时创建多个限额中间件，分别限制不同工具。

它在 `after_model` 读取最后一条 `AIMessage` 的 `tool_calls`，再拆成允许调用和阻止调用两组：

源码：`tool_call_limit.py:347-389`

```python
# 获取消息列表；没有消息就不需要统计
messages = state.get("messages", [])
if not messages:
    return None

# 从后向前找到最后一条 AIMessage
last_ai_message = None
for message in reversed(messages):
    if isinstance(message, AIMessage):
        last_ai_message = message
        break

if not last_ai_message or not last_ai_message.tool_calls:
    return None

# 每个中间件实例使用自己的计数 key
count_key = self.tool_name or "__all__"
thread_counts = state.get("thread_tool_call_count", {}).copy()
run_counts = state.get("run_tool_call_count", {}).copy()
current_thread_count = thread_counts.get(count_key, 0)
current_run_count = run_counts.get(count_key, 0)

# 把本轮工具调用拆成 allowed / blocked 两组
allowed_calls, blocked_calls, new_thread_count, new_run_count = (
    self._separate_tool_calls(
        last_ai_message.tool_calls,
        current_thread_count,
        current_run_count,
    )
)

# 被阻止的调用不计入 thread 账本，但计入本次 run 的尝试次数
thread_counts[count_key] = new_thread_count
run_counts[count_key] = new_run_count + len(blocked_calls)

if not blocked_calls:
    if allowed_calls:
        return {
            "thread_tool_call_count": thread_counts,
            "run_tool_call_count": run_counts,
        }
    return None
```

这段实现说明了工具限额的真实位置：它不是在工具 handler 内部逐次拦截，而是在模型已经生成工具调用后，先把阻止调用的 `tool_call_id` 对应结果补成错误 `ToolMessage`。这样图路由会认为这些调用已经有结果，只有允许调用会进入工具节点。

被阻止调用的处理分为三种：

- `"continue"`：注入 `status="error"` 的 `ToolMessage`，模型收到错误后继续决定下一步。
- `"error"`：抛出 `ToolCallLimitExceededError`。
- `"end"`：注入错误 `ToolMessage` 和最终 `AIMessage`，并通过 `jump_to="end"` 结束。

源码：`tool_call_limit.py:395-462`

```python
if self.exit_behavior == "error":
    # 用假设的 thread 计数说明本次被阻止的调用会超过上限
    hypothetical_thread_count = final_thread_count + len(blocked_calls)
    raise ToolCallLimitExceededError(
        thread_count=hypothetical_thread_count,
        run_count=final_run_count,
        thread_limit=self.thread_limit,
        run_limit=self.run_limit,
        tool_name=self.tool_name,
    )

# 发给模型的错误消息不暴露 thread / run 计数细节
tool_msg_content = _build_tool_message_content(self.tool_name)
artificial_messages: list[ToolMessage | AIMessage] = [
    ToolMessage(
        content=tool_msg_content,
        tool_call_id=tool_call["id"],
        name=tool_call.get("name"),
        status="error",
    )
    for tool_call in blocked_calls
]

if self.exit_behavior == "end":
    # 目标工具之外还有待执行工具时，不能安全地立即结束
    other_tools = [
        tc
        for tc in last_ai_message.tool_calls
        if self.tool_name is not None and tc["name"] != self.tool_name
    ]

    if other_tools:
        tool_names = ", ".join({tc["name"] for tc in other_tools})
        msg = (
            f"Cannot end execution with other tool calls pending. "
            f"Found calls to: {tool_names}. Use 'continue' or 'error' behavior instead."
        )
        raise NotImplementedError(msg)

    # 给用户看的最终消息包含 thread / run 计数
    hypothetical_thread_count = final_thread_count + len(blocked_calls)
    final_msg_content = _build_final_ai_message_content(
        hypothetical_thread_count,
        final_run_count,
        self.thread_limit,
        self.run_limit,
        self.tool_name,
    )
    artificial_messages.append(AIMessage(content=final_msg_content))

    return {
        "thread_tool_call_count": thread_counts,
        "run_tool_call_count": run_counts,
        "jump_to": "end",
        "messages": artificial_messages,
    }

# exit_behavior="continue"：只阻止超限调用，让模型继续
return {
    "thread_tool_call_count": thread_counts,
    "run_tool_call_count": run_counts,
    "messages": artificial_messages,
}
```

`"end"` 的并行边界不能省略：如果同一条 `AIMessage` 还带着其他待执行工具调用，源码会抛出 `NotImplementedError`，要求调用者改用 `"continue"` 或 `"error"`。

## 三、重试：在 `wrap_*` 内重复调用 `handler`

模型重试不是重新跑一轮 Agent 图，而是在一次模型节点内部循环调用 handler：

源码：`model_retry.py:214-262`

```python
def wrap_model_call(
    self,
    request: ModelRequest[ContextT],
    handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
) -> ModelResponse[ResponseT] | AIMessage:
    # 初次调用 + max_retries 次重试
    for attempt in range(self.max_retries + 1):
        try:
            return handler(request)
        except Exception as exc:
            attempts_made = attempt + 1

            # 只对符合条件的异常重试
            if not should_retry_exception(exc, self.retry_on):
                return self._handle_failure(exc, attempts_made)

            if attempt < self.max_retries:
                # 计算退避（backoff）延迟
                delay = calculate_delay(
                    attempt,
                    backoff_factor=self.backoff_factor,
                    initial_delay=self.initial_delay,
                    max_delay=self.max_delay,
                    jitter=self.jitter,
                )
                if delay > 0:
                    time.sleep(delay)
            else:
                return self._handle_failure(exc, attempts_made)

    # 按当前循环逻辑，这里不可达
    msg = "Unexpected: retry loop completed without returning"
    raise RuntimeError(msg)
```

`ToolRetryMiddleware` 的结构相同，只是 handler 接收 `ToolCallRequest`，失败后返回 `ToolMessage`。它还可以通过 `tools` 参数只对指定工具启用重试。

源码：`tool_retry.py:305-340`

```python
tool_name = request.tool.name if request.tool else request.tool_call["name"]

# 没有命中工具过滤器时，直接执行，不进入重试循环
if not self._should_retry_tool(tool_name):
    return handler(request)

tool_call_id = request.tool_call["id"]

# 初次调用 + max_retries 次重试
for attempt in range(self.max_retries + 1):
    try:
        return handler(request)
    except Exception as exc:
        attempts_made = attempt + 1

        if not should_retry_exception(exc, self.retry_on):
            return self._handle_failure(
                tool_name, tool_call_id, exc, attempts_made
            )

        if attempt < self.max_retries:
            delay = calculate_delay(
                attempt,
                backoff_factor=self.backoff_factor,
                initial_delay=self.initial_delay,
                max_delay=self.max_delay,
                jitter=self.jitter,
            )
            if delay > 0:
                time.sleep(delay)
        else:
            return self._handle_failure(
                tool_name, tool_call_id, exc, attempts_made
            )
```

重试的边界由三个参数决定：

- `retry_on`：可以是异常类型元组，也可以是接收异常并返回布尔值的 callable（可调用对象）。
- `max_retries`：只表示初次调用之后的重试次数，总尝试次数是 `max_retries + 1`。
- `on_failure`：耗尽重试后的失败语义。`"error"` 重新抛异常，`"continue"` 注入错误消息，也可以传 callable 自定义错误文本。

共享工具位于 `_retry.py`：

源码：`_retry.py:14-34`、`_retry.py:68-84`

```python
RetryOn = tuple[type[Exception], ...] | Callable[[Exception], bool]
OnFailure = Literal["error", "continue"] | Callable[[Exception], str]

def should_retry_exception(
    exc: Exception,
    retry_on: RetryOn,
) -> bool:
    if callable(retry_on):
        return retry_on(exc)
    return isinstance(exc, retry_on)
```

退避计算是指数退避（exponential backoff）加抖动（jitter）：

源码：`_retry.py:87-125`

```python
if backoff_factor == 0.0:
    delay = initial_delay
else:
    delay = initial_delay * (backoff_factor**retry_number)

# 限制最大延迟
delay = min(delay, max_delay)

if jitter and delay > 0:
    # 加入 ±25% 的随机抖动，避免多个请求同时重试形成惊群
    jitter_amount = delay * 0.25
    delay += random.uniform(-jitter_amount, jitter_amount)
    delay = max(0, delay)
```

重试只适合可安全重复的操作。模型调用通常由服务商处理幂等与重复请求问题；工具调用则必须逐个检查副作用。查询可以重试，写入、发送消息、扣款等操作必须有幂等键（idempotency key）或明确的去重策略。

## 四、回退：换模型，不等价于重试

`ModelFallbackMiddleware` 在构造期把字符串模型初始化成 Chat Model（聊天模型）实例，并按传入顺序保存备用模型：

源码：`model_fallback.py:50-70`

```python
def __init__(
    self,
    first_model: str | BaseChatModel,
    *additional_models: str | BaseChatModel,
) -> None:
    super().__init__()

    # 保留备用模型的配置顺序
    all_models = (first_model, *additional_models)
    self.models: list[BaseChatModel] = []
    for model in all_models:
        if isinstance(model, str):
            self.models.append(init_chat_model(model))
        else:
            self.models.append(model)
```

调用时先执行 `create_agent()` 提供的主模型；主模型抛异常后，依次用 `request.override(model=...)` 替换模型：

源码：`model_fallback.py:72-104`

```python
def wrap_model_call(
    self,
    request: ModelRequest[ContextT],
    handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
) -> ModelResponse[ResponseT] | AIMessage:
    # 先调用主模型
    last_exception: Exception
    try:
        return handler(request)
    except Exception as e:
        last_exception = e

    # 主模型失败后，按配置顺序尝试备用模型
    for fallback_model in self.models:
        try:
            return handler(request.override(model=fallback_model))
        except Exception as e:
            last_exception = e
            continue

    # 所有模型都失败时抛出最后一个异常
    raise last_exception
```

回退保留原请求中的消息、工具、系统提示和运行时上下文，只替换 `model` 字段。它的默认语义是“收到异常才切换”，不会因为模型返回普通错误文本而自动切换。

## 五、组合顺序：先看生命周期，再看包装栈

模型调用的一次完整路径可以简化为：

```text
before_model
  → wrap_model_call
      → handler（真实模型调用）
  → after_model
```

这不是三层同一种 Hook：

- `before_model` 和 `after_model` 是图节点；
- `wrap_model_call` 在模型节点内部；
- `handler` 可能被重试或回退中间件调用多次。

因此，`ModelCallLimitMiddleware` 与 `ModelRetryMiddleware` 的组合不能简单写成“谁在列表前面，谁就决定是否计入重试”。模型限额的 `after_model` 统计的是模型节点返回的一轮结果，不是 handler 的每一次尝试：

- 重试成功：底层可能请求多次，但模型限额通常只递增一次。
- 重试耗尽且 `on_failure="continue"`：包装器返回错误 `AIMessage`，模型节点仍然返回，限额仍递增一次。
- 重试耗尽且 `on_failure="error"`：异常向外抛出，模型节点没有正常返回，`after_model` 不会按成功返回路径递增。

所以如果目标是限制真实服务商请求次数，`ModelCallLimitMiddleware` 不是精确工具。它限制的是 Agent 的模型节点轮次；重试和回退产生的额外 provider 请求需要单独纳入预算、速率限制或客户端层计费统计。

真正对顺序敏感的是同一包装栈中的重试与回退：

```text
回退在外层，重试在内层
  → 主模型先按重试策略耗尽
  → 只有内层以 error 重新抛异常时，外层回退才会切备用模型

重试在外层，回退在内层
  → 一次重试尝试会执行完整的“主模型 + 备用模型”序列
  → 外层再次重试时，整套回退序列可能再次执行
```

默认 `on_failure="continue"` 时，内层 `ModelRetryMiddleware` 会把失败转换成 `ModelResponse`，外层 `ModelFallbackMiddleware` 看不到异常，也就不会切换模型。这是组合配置中最容易漏掉的语义。

工具侧也有同样的层次差异：

- `ToolCallLimitMiddleware` 在模型生成 `tool_calls` 后统计一次请求；
- `ToolRetryMiddleware` 在工具节点内部重复调用同一个工具 handler；
- 工具重试不会自动让工具限额按每次底层执行递增。

## 工程判断

### 值得照搬

- 用 `thread` 和 `run` 两个生命周期字段分别表达跨运行预算和单次运行预算。
- 把重试的异常筛选、退避和参数校验抽成 `_retry.py`，模型和工具共用同一套规则。
- 用 `request.override(model=...)` 做回退，避免原地修改共享请求对象。
- 把失败后的 `"continue"` 和 `"error"` 明确区分为两种控制流，而不是统一吞掉异常。

### 需要换实现或补一层

- 需要限制真实 provider 请求次数时，不能只依赖模型调用限额；还要在客户端或服务商适配层统计重试、回退和流式重连。
- 工具涉及写入或外部副作用时，先实现幂等和去重，再开启工具重试。
- 需要“主模型重试后再回退”时，确认重试的 `on_failure="error"`；否则回退层可能永远收不到异常。
- 需要精确控制并行工具预算时，先处理 `ToolCallLimitMiddleware` 的批量分流和 `"end"` 的 `NotImplementedError` 边界。

### 不要照搬

- 不要把 `max_retries` 当成 Agent 图循环次数；它只控制一次 `handler` 调用的重试次数。
- 不要把 `ModelCallLimitMiddleware` 当成 API 请求计费器；它记录的是模型节点层面的计数。
- 不要对写入型工具默认开启“所有异常都重试”；异常可能发生在请求已提交之后。
- 不要只改 `middleware` 列表顺序就假设语义可控，先画出 Hook 生命周期和包装栈，再用失败场景做组合测试。

## 读完后应该能判断什么

- 一个需求是限制 Agent 模型轮次，还是限制底层 provider 请求次数。
- 为什么模型限额使用 `before_model` / `after_model`，而重试和回退必须使用 `wrap_model_call`。
- `ToolCallLimitMiddleware` 为什么在模型生成 `tool_calls` 后分流，而不是等工具 handler 执行后再拦截。
- `on_failure="continue"` 为什么可能阻止外层回退看到异常。
- 重试、回退、工具限额组合后，哪些次数是逻辑次数，哪些次数是真实外部调用次数。
