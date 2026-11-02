---
sidebar_position: 9
sidebar_label: 07 调用治理：限额、重试与回退
description: 对照图节点限额与调用包装器中的重试、回退，解释计数口径、失败返回、退避延迟及外部副作用边界。
---

# LangChain 源码解析 07：调用治理——限额、重试与回退

**源码定位**

> **阅读基线**：`langchain` 1.3.7、`langchain-core` 1.4.6（仓库快照 `langchain-core==1.4.6-2-g76c32db9b3`）。
> 路径相对 LangChain 仓库根目录；版本说明见 [系列导读](index.md)。
>
> - 模型轮次：`libs/langchain_v1/langchain/agents/middleware/model_call_limit.py` → ModelCallLimitState、before_model()、after_model()。
> - 工具限额：`libs/langchain_v1/langchain/agents/middleware/tool_call_limit.py` → ToolCallLimitMiddleware._separate_tool_calls()、after_model()。
> - 模型重试：`libs/langchain_v1/langchain/agents/middleware/model_retry.py` → ModelRetryMiddleware.wrap_model_call()、_handle_failure()。
> - 工具重试：`libs/langchain_v1/langchain/agents/middleware/tool_retry.py` → ToolRetryMiddleware.wrap_tool_call()。
> - 备用模型：`libs/langchain_v1/langchain/agents/middleware/model_fallback.py` → ModelFallbackMiddleware.wrap_model_call()。
> - 异常与退避：`libs/langchain_v1/langchain/agents/middleware/_retry.py` → should_retry_exception()、calculate_delay()。

| 需求 | 机制 | 主要 Hook |
| --- | --- | --- |
| 到达次数后停止 Agent | 限额（Limit） | `before_model`、`after_model` |
| 同一次调用失败后再试 | 重试（Retry） | `wrap_model_call`、`wrap_tool_call` |
| 主模型失败后换模型 | 回退（Fallback） | `wrap_model_call` |

限额是图节点级别的状态治理，重试和回退是一次调用内部的包装治理。这个区别决定了“调用次数”到底按哪一层统计。

## 一、模型限额：检查在前，计数在后

`ModelCallLimitMiddleware` 使用两个私有状态字段：

- `thread_model_call_count`：线程（thread）级计数，随检查点（Checkpointer）跨多次运行保存。
- `run_model_call_count`：运行（run）级计数，使用 UntrackedValue 不写入检查点；从检查点恢复的新一次执行不沿用先前保存的 run 计数。

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

当 `exit_behavior="end"` 时，Hook 返回 `jump_to="end"`，并注入一条 `AIMessage`；当配置为 `"error"` 时，直接抛出 `ModelCallLimitExceededError`。前者沿结束路由返回说明文本，不代表任务已完成；后者让调用方处理异常。若结束阶段还有会请求修订的 hook，仍需结合实际图路由判断最终状态。

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

`"end"` 的边界限定在针对单个 tool_name 的实例：如果同轮还有其他名称的工具调用，分支会抛出 NotImplementedError。全局计数实例 tool_name=None 不走这个名称冲突判断。计数发生在执行前，因此允许的调用后来被审批拒绝、执行失败或未派发，都不能把计数直接当作成功执行数量。

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

延迟先按 max_delay 截断，再加入最多正负 25% 抖动，因此启用 jitter 后实际等待可能达到 max_delay 的 1.25 倍。它不是等待时间的严格上界；每次网络调用自身的超时也不包含在退避时间中。

模型请求重试可能再次计费，也可能得到不同结果，不能假设供应商自动去重。对工具要区分“服务拒绝请求”和“提交成功但响应丢失”；后者重试可能重复写入。需要稳定业务动作 ID、结果查询或执行端去重时，应先建立这些约束，再启用自动重试。

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

回退保留原请求中的消息、工具、系统提示、model_settings 和运行时上下文，只替换 model 字段。备用模型可能不支持原来的多模态内容、工具参数或结构化策略，因此“可初始化”不等于“当前请求可兼容”。触发条件是内层 handler 抛异常；普通错误文本、错误 ToolMessage 或质量较差的答案不会自动触发回退。

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

## 六、从同一笔退货请求数清楚调用次数

沿用 [00](00-project-overview-and-repository-structure.md) 的教学场景，假设回退包装器在外、重试包装器在内，`max_retries=1`、`on_failure="error"`，备用模型兼容当前工具与输出协议。下面是按源码推演的一条假设路径，未实际运行；不计 SDK 重试、摘要或工具选择器的额外模型请求。

| 模型节点轮次 | 节点内发生什么 | 内层模型执行次数 | 交回图之后 |
| --- | --- | --- | --- |
| 第 1 轮 | 主模型两次均抛可重试异常，备用模型首次成功，提出订单和政策查询 | 3 | 两个查询工具返回配对结果 |
| 第 2 轮 | 主模型提出 `submit_return`，调用 ID 为 `c_return` | 1 | 审批暂停；恢复时用户拒绝，补入配对错误消息，工具不执行 |
| 第 3 轮 | 主模型生成字段无效的结构化结果，ToolStrategy 将校验错误转成反馈 | 1 | 无最终 structured_response，图继续进入模型 |
| 第 4 轮 | 主模型修正输出，准确表示申请未提交 | 1 | 得到结构化结果并退出 |

这条业务路径经过四次正常返回的模型节点、六次内层模型执行，`submit_return` 的实际执行次数为零。备用模型只覆盖当轮请求；下一轮重新从主模型开始。第三轮修复进入新的图轮次，与第一轮包装器内部重试处于不同层次。

审批可能把业务过程拆成多次调用与恢复。这里的“四轮”是业务路径计数，不能直接写成一次 `run_model_call_count` 必定等于 4；后者还受恢复、UntrackedValue 和 hook 执行顺序影响。需要统计整笔任务成本时，应用应保留业务任务 ID，将各次恢复及底层请求关联起来。

这些组合语义有分开的测试证据：`test_three_handlers_composition` 断言包装器按外到内进入、内到外返回；`test_model_retry_succeeds_after_retries` 让测试模型前两次失败并断言第三次成功。它们未验证上表整套业务流程，定位见[源码与测试证据](source-baseline.md)。结构化错误怎样形成新一轮请求，见 [14](14-structured-output-and-repair.md)。

## 七、工程判断

以 run_limit=2、max_retries=2 为例，每轮模型节点最多可进入三次重试尝试；两轮合计可能调用内层 handler 六次。若 handler 里还有模型 SDK 自带重试，实际 HTTP 请求可能更多；摘要、工具选择器和子任务的请求也不自动计入这两个模型轮次。这个例子用于区分计量单位，不是总费用上限。

工具重试捕获的是抛出的异常。若内层已经返回 status="error" 的 ToolMessage，当前重试循环会把它当作一次正常返回；需要按结果重试时，应显式定义结果判据，并确认是否允许再次执行。

组合回退与重试时，明确哪一层保留异常、哪一层转换成消息。记录主模型、备用模型、每次尝试和最后交回图的结果，才能解释一次图计数背后的真实消耗。业务费用、截止时间和并行任务额度需要独立的计量与执行控制，参见 [Deep Agents 19](../deepagents/19-loop-budget-and-termination.md)。
