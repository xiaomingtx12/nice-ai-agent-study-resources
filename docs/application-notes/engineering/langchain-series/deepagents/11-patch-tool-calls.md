---
sidebar_position: 13
sidebar_label: 11 工具调用修补与状态恢复
description: 从源码拆解 PatchToolCallsMiddleware 如何修复缺少 ToolMessage 的悬空工具调用。
---

# Deep Agents 源码解析 11：工具调用修补与状态恢复

## 一、源码定位

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

> **阅读基线**：Deep Agents 0.6.12（`libs/deepagents/`）。
> 源码版本与路径约定见 [源码版本与路径约定](source-baseline.md)。


## 二、缺的是工具结果消息，还是实际执行结果

模型输出的 `AIMessage` 可以携带 `tool_calls`，每项都有工具名、参数和调用 ID。对应的 `ToolMessage` 通过 `tool_call_id` 返回结果。如果历史中有调用却没有对应结果，就形成悬空工具调用，后续模型请求可能被消息协议校验拒绝。

`PatchToolCallsMiddleware` 在 `before_agent()` 入口 hook 中扫描这个缺口，并生成合成的工具消息。它使模型可以继续读取历史，但没有执行、取消或重试实际工具。工具可能从未开始，也可能已经提交外部写入，只是结果未保存。

这里有两种 ID：消息自身的 `id` 用来在 State 中追加、替换或删除；`tool_call_id` 用来连接一次工具请求与结果。修补器按后者配对，不能根据工具名称判断是否已有结果，同名工具可以被连续调用多次。

## 三、先看一份历史怎样被修补

假设模型同时请求读取文件与搜索内容，其中读取结果已保存，搜索结果缺失。以下用消息类型和调用 ID 表示输入，不是可执行代码：

```text
HumanMessage：读取并检查配置
AIMessage：tool_calls = [call_read, call_grep]
ToolMessage：tool_call_id = call_read，内容为真实读取结果
```

修补器先得到 `answered_ids={"call_read"}`，确认只有 `call_grep` 缺少结果。随后重建成：

```text
HumanMessage：读取并检查配置
AIMessage：tool_calls = [call_read, call_grep]
ToolMessage：tool_call_id = call_grep，内容为合成的取消说明
ToolMessage：tool_call_id = call_read，内容为原有读取结果
```

新补丁紧跟产生调用的 AIMessage 插入，原消息的相对顺序保留。已有错误结果也算“有结果”：即使 `call_read` 对应 `status="error"`，修补器也不会再为它补一条消息。

这个例子说明修补关注的是配对存在性。它不会把旧的错误结果改成成功，也不会检查已有结果正文是否正确、是否重复或是否来自可信执行端。

## 四、识别缺口：有 ID，且没有对应 ToolMessage

`patch_tool_calls.py` 中的检查分为两步。下面摘录方法开头，省略函数签名：

```python
messages = state["messages"]
if not messages:
    return None

answered_ids = {msg.tool_call_id for msg in messages if msg.type == "tool"}

if not any(
    tool_call["id"] is not None and tool_call["id"] not in answered_ids
    for msg in messages
    if isinstance(msg, AIMessage)
    for tool_call in (*msg.tool_calls, *msg.invalid_tool_calls)
):
    return None
```

`invalid_tool_calls` 是模型适配层未能解析成有效参数的调用记录。它们也可能带调用 ID，因此与正常调用一起检查。没有 ID 的调用无法确定配对身份，这段代码直接跳过，不会猜测一个 ID。

`answered_ids` 从整份历史收集。它只检查工具消息类型和配对 ID，不判断正文、错误状态或排列是否合法。因此已有结果但顺序错误、重复调用 ID、没有 ID 的畸形调用，都不能指望这段检查完整修复。

空历史或没有缺口时返回 `None`，表示不提交 State 更新。这避免正常进入 Agent 时也重写整份历史。

## 五、生成补丁：保留原消息，插入合成说明

检测到缺口后，方法重新遍历历史：

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
        name = tool_call["name"] or "unknown"
        if tool_call.get("type") == "invalid_tool_call":
            content = f"Tool call {name} with id {tool_call_id} could not be executed - arguments were malformed or truncated."
        else:
            content = f"Tool call {name} with id {tool_call_id} was cancelled - another message came in before it could be completed."
        patched_messages.append(ToolMessage(content=content, name=name, tool_call_id=tool_call_id))
```

两类文本都是实现中的固定说明：无效调用提示参数损坏或截断，正常调用提示取消。代码没有读取进程状态或业务账本，因此正常调用补丁中的 `cancelled` 不能证明命令已停止、退款未发生或文件未写入。

补丁构造时也没有显式设置 `status="error"`。监控若仅凭 ToolMessage 存在，或未带 error 状态，就将动作计为成功，会把协议修补误报为业务完成。应用需要另外记录实际执行结果。

## 六、为什么返回整体重建标记

方法最后返回的不是新增补丁列表，而是完整更新：

```python
return {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *patched_messages]}
```

`RemoveMessage` 表示删除消息的控制对象；`REMOVE_ALL_MESSAGES` 是其中用于整体重置的特殊 ID。主图默认使用的 `_messages_delta_reducer()` 会丢弃旧历史和标记之前的写入，再按后续顺序重建消息。

如果只返回新补丁，消息合并通常会把它追加到历史末尾，无法保证放在对应 AIMessage 后面。即使把所有旧消息一起返回，同 ID 消息也只是原位替换，新补丁仍会追加。重置后回填解决的正是插入位置问题，代价是提交一份完整历史。

这次更新写入 State，会影响后续请求与检查点。正常历史摘要主要改 `ModelRequest.messages` 并保存摘要事件，两者不同。自定义 `state_schema` 若改变了消息字段的合并规则，应确认它仍识别这个重置标记，否则不能沿用这里的推导。

## 七、恢复与人工审批何时经过修补器

`create_deep_agent()` 把修补器加入主栈，默认通用子代理和声明式子代理也有各自的实例。它们检查自己的消息状态，不会跨图检查另一 Agent 的历史；调用方预先编译的子代理是否具备修补器，取决于其自身装配。

执行时机由图入口决定。带旧历史重新进入 `before_agent`，会发生上述扫描；从检查点或人工审批的暂停节点继续，未必重走入口。正常审批挂起时尚无 ToolMessage，是合法的中间状态，不能直接等同于取消。

| 场景 | 可以依赖的行为 | 还需要检查 |
| --- | --- | --- |
| 带悬空调用经过入口 hook | 为有 ID 且缺少结果的调用补消息 | 后续提供商对完整序列的其他约束 |
| 人工审批恢复 | 按实际恢复位置继续执行 | 审批决定、是否经过入口、工具是否真的执行 |
| 外部写入成功但响应丢失 | 修补器可能补成取消说明 | 用稳定业务动作 ID 查询执行端，避免重复提交 |
| 已有 error ToolMessage | 保留原结果，不另补消息 | 是否允许重试以及重试条件 |

需要恢复外部动作时，应先查询可信执行记录，再决定继续、重试或补偿。消息 ID 保证的是状态合并，业务动作 ID 才能用于执行端去重；不能用补丁文本代替这份记录。

## 八、如何验证修补结果

`libs/deepagents/tests/unit_tests/test_middleware.py` 中的 `TestPatchToolCallsMiddleware` 检查无工具调用、部分缺失、全部已有结果和多条缺失调用等情况。核心断言是首项带整体重置标记，原消息顺序保留，新增结果与调用 ID 配对。

业务回归还应区分“执行前取消”与“外部提交后丢失结果”：两者都可能产生同样的消息缺口，只有后者存在已完成的副作用。对修补后的历史再次执行检查，应不再增加补丁；对执行端则需单独确认动作没有重复。

## 九、延伸阅读

**下层：LangChain / LangGraph**

- [LangGraph 06：Checkpoint、Store 与恢复](../langgraph/06-checkpoints-store-and-recovery.md)——恢复时消息历史从哪里来

**本系列**

- [03：状态、Reducer 与恢复](./03-state-reducers-and-recovery.md)——消息 ID 与增量 Reducer 的一致性前提
- [10：Summarization 与上下文卸载](./10-summarization-and-context-offloading.md)——另一类历史改写

**上层：方法论与案例**

- [Agent 系统设计 02：State 架构](../../../../notes/agent-system-design/02-state/agent-state-architecture.md)——恢复要还原什么，协议完整算不算还原
