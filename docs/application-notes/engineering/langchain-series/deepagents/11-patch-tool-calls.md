---
sidebar_position: 13
sidebar_label: 11 工具调用修补与状态恢复
description: 从源码拆解 PatchToolCallsMiddleware 如何修复缺少 ToolMessage 的悬空工具调用。
---

# Deep Agents 源码解析 11：工具调用修补与状态恢复

## 源码定位

> 主代理装配：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
>
> 修补逻辑：`libs/deepagents/deepagents/middleware/patch_tool_calls.py` → `PatchToolCallsMiddleware.before_agent()`
>
> 消息类型：`langchain/libs/core/langchain_core/messages/` → `AIMessage`、`ToolMessage`、`RemoveMessage`
>
> 消息 Reducer：`libs/deepagents/deepagents/_messages_reducer.py` → `_messages_delta_reducer()`
>
> 整体重置标记：`langgraph/libs/langgraph/langgraph/graph/message.py` → `REMOVE_ALL_MESSAGES`
>
> Agent 编译：`langchain/libs/langchain_v1/langchain/agents/factory.py` → `create_agent()`

> 测试实现：`libs/deepagents/tests/unit_tests/test_middleware.py` → `TestPatchToolCallsMiddleware`

**阅读基线**：Deep Agents 0.6.12。

这篇只解决一个问题：

```text
AIMessage 声明了 tool call
但消息历史中没有同一个 tool_call_id 的 ToolMessage
```

这种消息历史称为悬空工具调用（dangling tool call）。`PatchToolCallsMiddleware` 会在 Agent 开始执行时补一条合成的 `ToolMessage`，让消息协议重新闭合。

它修补的是消息结构，不是工具业务结果。补出来的消息只告诉模型“这次调用没有正常完成”或“参数已经损坏”，不会重新执行工具，也不会恢复丢失的数据。

文章按一次修补的生命周期展开：

```text
中间件装配
  -> Agent 开始执行
  -> 收集已完成的 tool_call_id
  -> 找到悬空的 tool call
  -> 生成合成 ToolMessage
  -> 用 REMOVE_ALL_MESSAGES 整体重建 messages
  -> Agent 继续执行
```

## 这篇要回答的设计问题

恢复流程需要先得到一份语法上完整的消息历史，模型才有机会继续规划。这里的“完整”不是指每个工具都成功，而是指每个带 ID 的工具调用都有对应的工具消息。

| 问题 | `PatchToolCallsMiddleware` 是否处理 |
| --- | --- |
| `AIMessage` 缺少对应 `ToolMessage` | 是 |
| 工具是否执行成功 | 否 |
| 工具结果正文是否正确 | 否 |
| 被取消的工具是否需要重试 | 否 |
| 无效参数能否自动修正 | 否 |
| 没有 `tool_call_id` 的调用能否配对 | 否 |

用 `REMOVE_ALL_MESSAGES` 整体重建消息，是为了让修补后的历史重新经过同一个 Reducer 语义。这个动作成本更高，但比在并发写入存在时盲目追加几条补丁消息更容易保持顺序和一致性。

## 一、为什么会出现悬空工具调用

正常的工具调用消息应当成对出现：

```text
AIMessage(
    tool_calls=[{"id": "call_123", "name": "read_file", ...}]
)
  -> ToolMessage(tool_call_id="call_123", content="...")
```

`AIMessage` 声明了一个工具调用，后面就应该有相同 `tool_call_id` 的 `ToolMessage`。模型继续生成下一轮消息时，通常依赖这组配对判断工具是否完成、返回了什么。

这里的 `ToolMessage` 是 LangChain 中表示工具返回值的消息类型，`tool_call_id` 是它和 `AIMessage` 建立配对的字段。`AIMessage` 中的 `tool_calls` 表示解析成功的调用，`invalid_tool_calls` 表示结构存在但参数无法正常解析的调用。

悬空调用通常来自执行边界：

- 模型刚生成工具调用，Agent 在工具执行前被中断；
- 工具已经开始执行，但人工审批或外部事件打断了流程；
- Checkpoint 恢复时只恢复了部分消息；
- 外部系统裁剪、拼接或写回消息时漏掉了工具结果；
- 模型输出解析失败，调用进入 `invalid_tool_calls`，没有进入正常工具节点。

这些情况的共同结果是：

```text
有 AIMessage.tool_calls
没有相同 ID 的 ToolMessage
```

如果直接把这份历史交给后续 Agent，模型适配器或消息校验层可能无法继续处理。

## 二、它在 Agent 栈中的位置

主代理的核心装配顺序是：

```text
TodoListMiddleware
  -> SkillsMiddleware（配置 skills 时加入）
  -> FilesystemMiddleware
  -> SubAgentMiddleware（存在同步子代理时加入）
  -> SummarizationMiddleware
  -> PatchToolCallsMiddleware
  -> AsyncSubAgentMiddleware（配置异步子代理时加入）
  -> 用户中间件和 Harness Profile 扩展
  -> Prompt Caching Middleware
  -> MemoryMiddleware（配置 memory 时加入）
  -> HumanInTheLoopMiddleware（配置 interrupt_on 时加入）
  -> ToolExclusionMiddleware（配置排除工具时加入）
```

`create_deep_agent()` 会把它和摘要中间件一起加入主代理栈：

```python
deepagent_middleware.extend(
    [
        create_summarization_middleware(model, backend),
        PatchToolCallsMiddleware(),
    ]
)
```

配置通用子代理或声明式子代理时，子代理 Agent 也会获得对应的 `PatchToolCallsMiddleware`。最终这些中间件会随工具、状态 schema 和提示词一起交给 `create_agent()`。

### 它使用哪个 Hook

`PatchToolCallsMiddleware` 只实现 `before_agent()`：

```python
def before_agent(
    self,
    state: AgentState,
    runtime: Runtime[Any],
) -> dict[str, Any] | None:
```

这个 Hook 在一次 Agent invocation 开始时检查 State，尤其适合处理从 Checkpoint 恢复后已经存在的消息历史。它不是每次模型调用前执行，也不是工具调用包装器。没有发现悬空调用时返回 `None`，State 不发生变化。

这也是它和相邻中间件的区别：

| 中间件 | Hook | 处理对象 |
| --- | --- | --- |
| `SummarizationMiddleware` | `wrap_model_call()` | 当前模型请求的消息视图 |
| `PatchToolCallsMiddleware` | `before_agent()` | Agent State 中完整的消息协议 |
| `AsyncSubAgentMiddleware` | `wrap_model_call()` | 当前模型请求中的异步任务工具 |

### 子代理的继承边界

声明式子代理和默认的通用子代理会在 `create_deep_agent()` 中各自装配 `PatchToolCallsMiddleware`。它们拥有自己的 Agent State，因此由各自的中间件检查自己的消息历史。

已经编译好的 `CompiledSubAgent` 不会自动继承主代理的中间件。它是否具备同样的修补能力，取决于编译它时使用的 Agent 配置。

主代理的 Patch 中间件不会跨越 State 边界去读取或修补子代理内部消息。

列表中 `PatchToolCallsMiddleware` 位于摘要之后，只说明装配列表的位置。三个中间件的 Hook 不共享一条相同的运行时调用链。

## 三、`before_agent()` 如何识别缺口

源码按三个动作完成检查：

```text
读取 messages
  -> 收集所有 ToolMessage 的 tool_call_id
  -> 扫描所有 AIMessage 的 tool_calls 和 invalid_tool_calls
  -> 找出没有对应结果的调用
```

### 先建立已完成调用集合

源码先收集消息列表中所有工具结果的 ID：

```python
answered_ids = {
    msg.tool_call_id
    for msg in messages
    if msg.type == "tool"
}
```

这里判断的是消息类型和 `tool_call_id`。它不会检查 ToolMessage 的正文，也不会判断工具执行成功还是失败。只要某个 ID 已经出现在工具消息里，这次调用就被视为已经有对应结果。

因此，下面这条消息也会被视为“已回答”：

```python
ToolMessage(
    tool_call_id="call_123",
    content="permission denied",
    status="error",
)
```

PatchToolCallsMiddleware 只负责补齐协议，工具错误的含义由工具调用链和模型自行处理。

### 同时扫描正常和无效调用

判断逻辑会把两种列表合并扫描：

```python
for tool_call in (*msg.tool_calls, *msg.invalid_tool_calls)
```

只要调用存在 ID，且这个 ID 不在 `answered_ids` 中，就认为它是悬空调用：

```python
if not any(
    tool_call["id"] is not None
    and tool_call["id"] not in answered_ids
    for msg in messages
    if isinstance(msg, AIMessage)
    for tool_call in (*msg.tool_calls, *msg.invalid_tool_calls)
):
    return None
```

有两个细节：

- 没有 ID 的调用无法和 ToolMessage 配对，因此不会生成补丁；
- 判断依据是 `tool_call_id`，不是工具名称。两个不同调用可以使用同一个工具名，但它们的 ID 必须分别闭合。

## 四、补丁消息如何生成

确认存在悬空调用后，源码重新遍历原始消息，并在对应的 `AIMessage` 后面插入合成的 `ToolMessage`：

```python
patched_messages: list[AnyMessage] = []

for msg in messages:
    patched_messages.append(msg)
    if not isinstance(msg, AIMessage):
        continue

    for tool_call in (*msg.tool_calls, *msg.invalid_tool_calls):
        tool_call_id = tool_call["id"]
        if tool_call_id is None or tool_call_id in answered_ids:
            continue
        ...
        patched_messages.append(
            ToolMessage(
                content=content,
                name=name,
                tool_call_id=tool_call_id,
            )
        )
```

插入位置紧跟对应的 `AIMessage`，这样不会把补丁结果放到整段消息历史的末尾，工具调用的局部顺序仍然可读。

### 正常 tool call 的补丁内容

如果调用来自 `AIMessage.tool_calls`，源码生成的内容是：

```text
Tool call <name> with id <tool_call_id> was cancelled
- another message came in before it could be completed.
```

这表示调用没有完成，原因是后续消息已经到达或流程在调用完成前被打断。它不是工具成功返回的结果，也不会重新执行该工具。

### invalid tool call 的补丁内容

如果调用来自 `AIMessage.invalid_tool_calls`，源码根据 `type` 判断它是无效调用，并生成：

```text
Tool call <name> with id <tool_call_id> could not be executed
- arguments were malformed or truncated.
```

这表示调用参数在解析阶段就已经损坏或被截断。补丁的作用是让消息结构闭合，不能把它理解成一次真正的工具调用失败响应。

如果调用没有工具名，源码使用：

```python
name = tool_call["name"] or "unknown"
```

因此，补丁始终能携带一个可读的 `name`，但不会凭空推断真实工具名称。

### 多个并行调用如何处理

一条 `AIMessage` 可以带多个 `tool_calls`：

```text
AIMessage(
    tool_calls=[
        {"id": "call_a", "name": "read_file"},
        {"id": "call_b", "name": "grep"},
    ]
)
```

如果只有 `call_a` 已经有 `ToolMessage`，源码只为 `call_b` 补消息。每个调用单独按 ID 判断，不会因为同一条 `AIMessage` 中有一个结果，就把其他调用也视为完成。

## 五、为什么要用 `REMOVE_ALL_MESSAGES`

补丁列表不是直接追加到旧消息后面，而是这样返回：

```python
return {
    "messages": [
        RemoveMessage(id=REMOVE_ALL_MESSAGES),
        *patched_messages,
    ]
}
```

### `REMOVE_ALL_MESSAGES` 做什么

`REMOVE_ALL_MESSAGES` 是 LangGraph 消息 Reducer 识别的特殊标记。标准 `add_messages()` 在遇到它时，会丢弃哨兵之前的旧消息；Deep Agents 0.6.12 的 `_messages_delta_reducer()` 也实现了同样的重置语义。

Deep Agents 的 `DeepAgentState.messages` 使用的是：

```python
DeltaChannel(_messages_delta_reducer, snapshot_frequency=50)
```

所以这里不能简单理解成“调用了 `add_messages()`”。准确说法是：`REMOVE_ALL_MESSAGES` 被消息 Reducer 当作整体重置标记，随后把完整的 `patched_messages` 重新写入消息通道。

核心分支是：

```python
if isinstance(m, RemoveMessage) and m.id == REMOVE_ALL_MESSAGES:
    remove_all_idx = idx

if remove_all_idx is not None:
    state_msgs = []
    msgs = msgs[remove_all_idx + 1 :]
```

最终效果是：

```text
旧 State messages
  -> 整体清空
  -> 写入原消息 + 新补丁 ToolMessage
```

如果直接返回 `patched_messages`，Reducer 会把它们当成增量写入，无法把补丁放回各自的局部位置。整体清空再写入，保证 State 中只有一份修补后的消息历史。

### 为什么不只返回新增 ToolMessage

补丁消息必须插入对应 `AIMessage` 后面，而不是简单追加到末尾：

```text
错误：
AIMessage(call_a)
AIMessage(call_b)
ToolMessage(call_a)
ToolMessage(call_b)

修补后：
AIMessage(call_a)
ToolMessage(call_a)
AIMessage(call_b)
ToolMessage(call_b)
```

所以源码需要重建完整列表，再交给 Reducer 整体替换。

### 它修改的是 State，不是请求副本

`before_agent()` 返回的是 State 更新字典，最终由图的消息 Reducer 写回 `state["messages"]`。这和摘要中间件的常规路径不同：

| 机制 | 修改位置 |
| --- | --- |
| `PatchToolCallsMiddleware` | State 的 `messages` |
| 自动摘要 | `ModelRequest.messages`，并保存 `_summarization_event` |
| 工具可见性过滤 | 当前 `ModelRequest.tools` |

PatchToolCalls 的修补结果会成为后续所有模型请求的消息历史。

## 六、一次完整修补示例

假设 Agent 在恢复后得到以下 State：

```text
HumanMessage("读取配置文件")
AIMessage(
    tool_calls=[
        {"id": "call_read", "name": "read_file"},
        {"id": "call_grep", "name": "grep"},
    ]
)
ToolMessage(
    tool_call_id="call_read",
    content="..."
)
```

`before_agent()` 的判断结果是：

```text
answered_ids = {"call_read"}
悬空调用 = "call_grep"
```

它返回：

```text
RemoveMessage(REMOVE_ALL_MESSAGES)
HumanMessage("读取配置文件")
AIMessage(tool_calls=[call_read, call_grep])
ToolMessage(tool_call_id="call_read", content="...")
ToolMessage(
    tool_call_id="call_grep",
    content="Tool call grep with id call_grep was cancelled ..."
)
```

Reducer 写回后，Agent 再从这份完整消息历史继续运行。模型看到的是一个已经结束的 `grep` 调用，但能从补丁文本知道它没有产生真实结果。

## 七、它和恢复、中断、摘要的关系

### 和 Checkpoint 恢复

Checkpoint 恢复的是 Agent State。只要恢复结果包含未闭合的 `AIMessage.tool_calls`，`before_agent()` 就会再次检查并补齐缺口。

它不会重新推断中断前到底执行到了哪一步。源码只根据当前消息列表中是否存在对应 `ToolMessage` 作判断。

### 和 Human-in-the-Loop

人工审批可能发生在工具真正执行之前。如果流程在审批期间被中断，原来的 `AIMessage` 可能已经写入，但工具结果还不存在。恢复时，PatchToolCallsMiddleware 会把它标记为取消。

它不绕过审批，也不会替审批自动批准工具。人工决定是否重试，应由后续 Agent 流程处理。

### 和 Summarization

摘要和修补处理的是不同问题：

| 中间件 | 解决的问题 | 处理方式 |
| --- | --- | --- |
| `PatchToolCallsMiddleware` | AIMessage 缺少对应 ToolMessage | 修改 State，补齐消息协议 |
| `SummarizationMiddleware` | 消息历史太长 | 压缩模型请求视图，保存摘要事件 |

如果历史里存在悬空调用，摘要不能替代补丁。模型即使看到了摘要，也仍然可能面对不完整的工具调用结构。

### 和 SubAgent

主代理和子代理都有各自的消息 State。声明式子代理和默认通用子代理会由 `create_deep_agent()` 分别装配该中间件；已编译的 `CompiledSubAgent` 则不会自动继承主代理配置。

主代理的 PatchToolCallsMiddleware 不会读取或修补子代理内部的消息。

## 八、它不会做什么

PatchToolCallsMiddleware 的职责边界很窄：

- 不重新执行工具；
- 不验证工具结果内容；
- 不判断工具是否成功；
- 不恢复缺失的真实业务数据；
- 不重试被取消的调用；
- 不修复没有 `tool_call_id` 的调用；
- 不把无效参数转换成合法参数。

它只把：

```text
AIMessage.tool_calls
  -> 对应 ToolMessage 缺失
```

修复成：

```text
AIMessage.tool_calls
  -> 合成 ToolMessage
```

后续是否重新规划、重新调用工具，交给 Agent 的模型循环和业务逻辑。

## 九、测试如何验证这项机制

当前版本没有单独的 `test_patch_tool_calls.py`，相关测试集中在：

```text
libs/deepagents/tests/unit_tests/test_middleware.py
```

`TestPatchToolCallsMiddleware` 覆盖了四个关键场景：

| 测试 | 验证点 |
| --- | --- |
| `test_first_message` | 没有工具调用时返回 `None` |
| `test_missing_tool_call` | 缺少结果时插入 `ToolMessage`，并返回整体重置标记 |
| `test_no_missing_tool_calls` | 已存在同 ID 工具消息时不重复修补 |
| `test_two_missing_tool_calls` | 多条 AI 消息各自补齐，且补丁紧跟对应调用 |

测试检查的不是工具业务结果，而是消息协议：

1. 第一条更新是 `RemoveMessage(id=REMOVE_ALL_MESSAGES)`；
2. 原消息顺序保持不变；
3. 新消息带有正确的 `name` 和 `tool_call_id`。

## 排查恢复异常时的顺序

遇到恢复后模型报工具消息格式错误，可以按这个顺序定位：

```text
State 中是否存在 AIMessage.tool_calls 或 invalid_tool_calls
  -> 每个调用是否带有 id
  -> 是否存在同 id 的 ToolMessage
  -> 是否执行到 PatchToolCallsMiddleware.before_agent()
  -> 是否生成 cancelled 或 malformed/truncated 提示
  -> 是否通过 REMOVE_ALL_MESSAGES 整体写回
  -> 后续模型是否把补丁消息当作“未产生真实结果”
```

如果补丁没有出现，优先检查调用是否没有 ID、消息是否不在当前 Agent State、或者使用的是不会自动继承该中间件的编译子代理。

## 读完后的工程判断

PatchToolCallsMiddleware 可以看成 Agent 恢复流程里的消息协议修补器。它的判断依据只有一个：`AIMessage` 中带 ID 的工具调用，是否已经在消息历史里找到同 ID 的工具消息。

源码实现虽然只有一个 Hook，但有三个关键点：

- 正常和无效 tool call 都要检查；
- 补丁消息要紧跟原始 `AIMessage`；
- 用 `REMOVE_ALL_MESSAGES` 让 Reducer 整体重建消息列表。

因此，排查恢复后的 Agent 异常时，可以按下面的顺序定位：

```text
是否存在 AIMessage.tool_calls
  -> 是否有同 ID 的 ToolMessage
  -> 是否进入 PatchToolCallsMiddleware.before_agent()
  -> 是否生成对应的取消或参数损坏提示
  -> 是否通过 REMOVE_ALL_MESSAGES 整体写回 State
```

修补完成后，消息协议恢复了，但业务动作并没有被自动补做。这条边界决定了它适合放在恢复入口，却不应该被当成工具重试机制。

**配套阅读**：

- [06 中间件增量与装配顺序](./06-middleware-increments.md)
- [10 Summarization 与上下文卸载](./10-summarization-and-context-offloading.md)
- [12 异步 SubAgent](./12-async-subagent.md)
