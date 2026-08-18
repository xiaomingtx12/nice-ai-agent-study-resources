---
sidebar_position: 10
sidebar_label: 08 人在环路：HITL 审批协议
description: 拆解 HumanInTheLoopMiddleware 的审批协议：如何筛选工具调用、构造 interrupt 请求、处理四种人工决策并恢复 Agent 执行。
---

# LangChain 源码 08：人在环路——HITL 审批协议

## 源码定位

> **阅读基线**：`langchain` 1.3.7（`libs/langchain_v1/`）。
>
> **核心路径**：
>
> - 审批请求、决策类型、工具筛选和 `HumanInTheLoopMiddleware`：`langchain/agents/middleware/human_in_the_loop.py`。
> - `interrupt()`、`Command(resume=...)` 和中断恢复协议：`langgraph/types.py`。
> - `after_model` 节点如何连接到工具节点和下一轮模型调用：`langchain/agents/factory.py`。

## 先记住一条判断

HITL（Human in the loop，人在环路）不是在工具函数里弹出一个确认框，而是一条完整的图执行协议：

```text
模型生成 tool_calls
  → after_model 筛选需要审批的调用
  → interrupt(HITLRequest) 暂停图
  → 调用方使用 Command(resume=...) 提交人工决策
  → after_model 根据决策重建工具调用和 ToolMessage
  → tools 节点只执行最终保留下来的调用
```

`HumanInTheLoopMiddleware` 选择 `after_model`，因为这时模型已经给出了工具名和参数，但工具节点还没有执行副作用。

## 一、审批请求不是原始 ToolCall

源码把“模型要执行什么”和“人类可以做什么”拆成两套结构：

- `ActionRequest`：展示给人类看的工具名、参数和说明。
- `ReviewConfig`：这次操作允许哪些决策，以及对应的策略信息。
- `HITLRequest`：一次中断中聚合的全部审批动作。

源码：`human_in_the_loop.py:28-74`

```python
class Action(TypedDict):
    name: str
    args: dict[str, Any]


class ActionRequest(TypedDict):
    name: str
    args: dict[str, Any]
    description: NotRequired[str]


class ReviewConfig(TypedDict):
    action_name: str
    allowed_decisions: list[DecisionType]
    args_schema: NotRequired[dict[str, Any]]


class HITLRequest(TypedDict):
    action_requests: list[ActionRequest]
    review_configs: list[ReviewConfig]
```

人工恢复值也有明确的联合类型（union type，联合类型）：

源码：`human_in_the_loop.py:77-132`

```python
class ApproveDecision(TypedDict):
    type: Literal["approve"]


class EditDecision(TypedDict):
    type: Literal["edit"]
    edited_action: Action


class RejectDecision(TypedDict):
    type: Literal["reject"]
    message: NotRequired[str]


class RespondDecision(TypedDict):
    type: Literal["respond"]
    message: str


Decision = ApproveDecision | EditDecision | RejectDecision | RespondDecision


class HITLResponse(TypedDict):
    decisions: list[Decision]
```

一次 `HITLRequest` 可以包含多个工具调用。人工返回的 `decisions` 必须与被中断工具调用一一对应，顺序也必须保持一致。

## 二、`interrupt_on`：默认放行，显式收紧

构造函数会把 `interrupt_on` 里的配置归一化：

- 没有配置的工具：直接放行。
- `False`：直接放行。
- `True`：允许 `approve`、`edit`、`reject`、`respond` 四种决策。
- `InterruptOnConfig`：只允许配置中列出的决策。

源码：`human_in_the_loop.py:219-261`

```python
def __init__(
    self,
    interrupt_on: dict[str, bool | InterruptOnConfig],
    *,
    description_prefix: str = "Tool execution requires approval",
) -> None:
    super().__init__()
    resolved_configs: dict[str, InterruptOnConfig] = {}

    for tool_name, tool_config in interrupt_on.items():
        if isinstance(tool_config, bool):
            if tool_config is True:
                resolved_configs[tool_name] = InterruptOnConfig(
                    allowed_decisions=["approve", "edit", "reject", "respond"]
                )
        elif tool_config.get("allowed_decisions"):
            resolved_configs[tool_name] = tool_config

    self.interrupt_on = resolved_configs
    self.description_prefix = description_prefix
```

`InterruptOnConfig` 还支持三类附加字段：

- `description`：静态文本或动态生成审批说明的 callable（可调用对象）。
- `when`：根据工具调用参数决定本次是否中断。
- `args_schema`：声明编辑参数的 Schema（结构）。

当前源码中的 `_create_action_and_config()` 只把 `action_name` 和 `allowed_decisions` 写入 `ReviewConfig`，没有把 `args_schema` 继续传给它。因此，不能把 `args_schema` 误读成当前实现已经执行的编辑参数校验。

动态条件由 `_should_interrupt()` 执行：

源码：`human_in_the_loop.py:351-382`

```python
def _should_interrupt(
    self,
    tool_call: ToolCall,
    config: InterruptOnConfig,
    state: AgentState[Any],
    runtime: Runtime[ContextT],
) -> bool:
    when = config.get("when")
    if when is None:
        return True

    try:
        runnable_config = get_config()
    except RuntimeError:
        runnable_config = {}

    # 为 when 构造工具请求上下文
    tool_runtime = ToolRuntime(
        state=state,
        context=runtime.context,
        config=runnable_config,
        stream_writer=runtime.stream_writer,
        tool_call_id=tool_call["id"],
        store=runtime.store,
        execution_info=runtime.execution_info,
        server_info=runtime.server_info,
    )
    req = ToolCallRequest(
        tool_call=tool_call,
        tool=None,
        state=state,
        runtime=tool_runtime,
    )
    return when(req)
```

`when` 应该只做判断。它位于 `interrupt()` 之前，不能在里面写数据库、发送消息或执行工具，否则恢复时可能重复产生副作用。

## 三、`after_model` 如何组织一次审批

`after_model` 首先找到最后一条 `AIMessage`，再只收集命中 `interrupt_on` 且通过 `when` 判断的工具调用。未命中的调用会保留原样，自动进入后续流程。

源码：`human_in_the_loop.py:384-443`

```python
def after_model(
    self, state: AgentState[Any], runtime: Runtime[ContextT]
) -> dict[str, Any] | None:
    messages = state["messages"]
    if not messages:
        return None

    last_ai_msg = next(
        (msg for msg in reversed(messages) if isinstance(msg, AIMessage)),
        None,
    )
    if not last_ai_msg or not last_ai_msg.tool_calls:
        return None

    # 收集需要审批的工具调用
    action_requests: list[ActionRequest] = []
    review_configs: list[ReviewConfig] = []
    interrupt_indices: list[int] = []

    for idx, tool_call in enumerate(last_ai_msg.tool_calls):
        if (config := self.interrupt_on.get(tool_call["name"])) is not None:
            if not self._should_interrupt(tool_call, config, state, runtime):
                continue
            action_request, review_config = self._create_action_and_config(
                tool_call, config, state, runtime
            )
            action_requests.append(action_request)
            review_configs.append(review_config)
            interrupt_indices.append(idx)

    # 本轮没有需要审批的工具调用，直接继续
    if not action_requests:
        return None

    # 一次中断聚合本轮所有需要审批的动作
    hitl_request = HITLRequest(
        action_requests=action_requests,
        review_configs=review_configs,
    )

    decisions = interrupt(hitl_request)["decisions"]

    # 决策数量必须与被中断的工具调用数量一致
    if (decisions_len := len(decisions)) != (
        interrupt_count := len(interrupt_indices)
    ):
        msg = (
            f"Number of human decisions ({decisions_len}) does not match "
            f"number of hanging tool calls ({interrupt_count})."
        )
        raise ValueError(msg)
```

这段代码有三个工程含义：

1. 一轮中可以批量审批多个工具调用，不是每个工具调用都单独触发一次中断。
2. 审批决策只按 `interrupt_indices` 对应的顺序消费，未配置审批的工具不会占用决策位置。
3. 决策数量不匹配时直接抛错，避免把一个工具的决策错误应用到另一个工具。

恢复后，源码按原始工具调用顺序重建消息：

源码：`human_in_the_loop.py:445-471`

```python
# 按原顺序重建工具调用和人工生成的 ToolMessage
revised_tool_calls: list[ToolCall] = []
artificial_tool_messages: list[ToolMessage] = []
decision_idx = 0

for idx, tool_call in enumerate(last_ai_msg.tool_calls):
    if idx in interrupt_indices:
        config = self.interrupt_on[tool_call["name"]]
        decision = decisions[decision_idx]
        decision_idx += 1

        revised_tool_call, tool_message = self._process_decision(
            decision, tool_call, config
        )
        if revised_tool_call is not None:
            revised_tool_calls.append(revised_tool_call)
        if tool_message:
            artificial_tool_messages.append(tool_message)
    else:
        # 未进入审批的工具调用保持原样
        revised_tool_calls.append(tool_call)

# AIMessage 只保留最终允许继续处理的工具调用
last_ai_msg.tool_calls = revised_tool_calls

return {"messages": [last_ai_msg, *artificial_tool_messages]}
```

这里没有直接调用工具。Hook 返回的是新的消息状态，后续是否进入工具节点由 Agent 图的条件边判断。

## 四、四种决策怎样改变执行

核心逻辑在 `_process_decision()`：

源码：`human_in_the_loop.py:300-349`

```python
@staticmethod
def _process_decision(
    decision: Decision,
    tool_call: ToolCall,
    config: InterruptOnConfig,
) -> tuple[ToolCall | None, ToolMessage | None]:
    allowed_decisions = config["allowed_decisions"]

    if decision["type"] == "approve" and "approve" in allowed_decisions:
        return tool_call, None

    if decision["type"] == "edit" and "edit" in allowed_decisions:
        edited_action = decision["edited_action"]
        return (
            ToolCall(
                type="tool_call",
                name=edited_action["name"],
                args=edited_action["args"],
                id=tool_call["id"],
            ),
            None,
        )

    if decision["type"] == "reject" and "reject" in allowed_decisions:
        content = decision.get("message") or (
            f"User rejected the tool call for `{tool_call['name']}` "
            f"with id {tool_call['id']}. "
            "The tool was not executed. Do not retry this tool call unless "
            "the user explicitly requests it."
        )
        tool_message = ToolMessage(
            content=content,
            name=tool_call["name"],
            tool_call_id=tool_call["id"],
            status="error",
        )
        return tool_call, tool_message

    if decision["type"] == "respond" and "respond" in allowed_decisions:
        # 人类直接提供工具结果，跳过真实工具执行
        tool_message = ToolMessage(
            content=decision["message"],
            name=tool_call["name"],
            tool_call_id=tool_call["id"],
            status="success",
        )
        return tool_call, tool_message

    msg = (
        f"Unexpected human decision: {decision}. "
        f"Decision type '{decision.get('type')}' "
        f"is not allowed for tool '{tool_call['name']}'. "
        f"Expected one of {allowed_decisions} based on the tool's configuration."
    )
    raise ValueError(msg)
```

四种决策的真实语义：

| 决策 | `revised_tool_call` | `ToolMessage` | 工具是否执行 |
| --- | --- | --- | --- |
| `approve` | 保留原调用 | 无 | 是 |
| `edit` | 新建调用，保留原 `id` | 无 | 是 |
| `reject` | 保留原调用 | `status="error"` | 否 |
| `respond` | 保留原调用 | `status="success"` | 否 |

`reject` 和 `respond` 仍然返回原始 `ToolCall`，但同时生成了同一个 `tool_call_id` 的 `ToolMessage`。后续路由会把这次调用视为已有结果，因此不会再把它派发到工具节点。

`edit` 必须保留原始 `id`。这个 ID（标识符）是模型工具调用和 `ToolMessage` 的配对键；修改工具名或参数不等于创建一条新的工具调用协议。

如果决策类型没有出现在 `allowed_decisions` 中，源码直接抛出 `ValueError`。人工端不能通过提交未授权的决策绕过工具策略。

## 五、为什么中断放在 `after_model`

LangChain Agent 的相关图路径是：

```text
model
  → after_model
  → tools
  → model
```

`HumanInTheLoopMiddleware` 在 `after_model` 调用 `interrupt()`，此时具备两个条件：

- 已经有完整的工具名、参数和 `tool_call_id`；
- 工具节点尚未执行，因此审批前还没有工具副作用。

恢复时，LangGraph 会从发生中断的节点开头重放。`interrupt()` 第一次调用抛出中断，调用方用 `Command(resume=...)` 提供恢复值；同一节点再次执行到相同位置时，运行时返回已保存的恢复值，然后继续执行 `_process_decision()`。

启用 Checkpointer 时，恢复调用必须继续使用同一个 `thread_id`。换用新的线程 ID，运行时会得到另一条状态链，无法接上原来的审批中断。

因此，`interrupt()` 前的代码必须可重放：

- 读取 State、构造 `ActionRequest`、执行纯函数判断可以重复。
- 写数据库、发送邮件、提交任务等副作用不能放在 `interrupt()` 前，除非操作本身具备幂等性（idempotency，重复执行结果一致）。

这也是它没有放进 `wrap_tool_call` 的原因：工具包装器位于单次工具执行内部，恢复时不应把“审批”和“工具 handler 已执行一半”混在一起。

## 六、与 `interrupt_before=["tools"]` 的区别

两者都能在工具执行前暂停，但控制粒度不同：

| 方式 | 暂停位置 | 审批粒度 | 决策结果 |
| --- | --- | --- | --- |
| `interrupt_before=["tools"]` | 图级 `tools` 节点之前 | 整个工具节点输入 | 调用方自行处理恢复后的状态 |
| `HumanInTheLoopMiddleware` | `after_model` 节点内 | 按工具名和 `when` 条件 | 中间件重建 `ToolCall` 和 `ToolMessage` |

需要对所有工具统一停一次，可以使用图级中断；需要按工具配置 `approve/edit/reject/respond`，使用中间件。

两者也可以组合，但要明确暂停职责。若同一批工具调用同时触发两套中断，恢复流程会变成两阶段，调用方必须保存并匹配两次恢复状态。

## 工程判断

### 值得照搬

- 把人工审批定义成结构化请求和结构化决策，不让 UI 文本直接改变图状态。
- 在工具副作用发生前暂停，并让恢复后的流程继续走统一 `ToolNode`。
- 用 `tool_call_id` 保持模型调用、人工生成结果和工具消息之间的配对。
- 对批量审批校验决策数量，避免顺序错位。

### 需要补一层

- `args_schema` 当前没有在 `_create_action_and_config()` 中传入 `ReviewConfig`，编辑参数校验不能只依赖这个字段声明。
- `edit` 允许修改工具名，应用仍需检查编辑后的工具是否已注册、是否有权限、参数是否符合工具 Schema。
- 审批请求中的 `description` callable 应保持纯函数，不能在生成展示文本时访问外部系统并产生副作用。
- 需要审计时，应记录原始 `ToolCall`、人工决策、编辑后的调用和最终 `ToolMessage`，而不是只记录一条“已批准”日志。

### 不要照搬

- 不要在 `interrupt()` 前执行不可重复的外部操作。
- 不要把 `reject` 当成普通工具异常；源码会明确告诉模型“工具未执行，除非用户要求，否则不要重试”。
- 不要丢弃或重新生成 `tool_call_id`。
- 不要把图级 `interrupt_before` 和中间件级审批当成同一种恢复协议。

## 读完后应该能判断什么

- 为什么 HITL 要放在 `after_model`，而不是工具 handler 内部。
- `HITLRequest` 如何把多个工具调用和各自的审批策略聚合到一次中断中。
- `approve`、`edit`、`reject`、`respond` 分别如何改变 `ToolCall` 和 `ToolMessage`。
- 为什么恢复前的逻辑必须可重放，审批前不能产生不可逆副作用。
- 何时使用图级 `interrupt_before`，何时使用 `HumanInTheLoopMiddleware`。
