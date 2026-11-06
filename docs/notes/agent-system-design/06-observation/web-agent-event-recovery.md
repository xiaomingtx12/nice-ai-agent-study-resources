---
sidebar_position: 3
description: 从 Web Agent 的断线重连出发，拆解实时事件、数据库序号、恢复快照与终态提交如何组成连续的页面体验。
---

# Web Agent 断线后如何继续：事件序号、持久化与快照

> 来源：本地 `my-dify` 仓库 `deepagents-integration` 分支，提交 `4e21eae6006c719a560a0b2f1af0aeba58d9b9ed`。本文是源码分析，未运行服务或浏览器。

Web Agent 的浏览器连接可以随时断开，任务却可能继续运行。页面重新打开时，需要回答两个问题：已经确认发生了什么，以及接下来从哪里继续接收。把流式文本直接当成唯一状态，既无法解释断线期间的工具执行，也无法避免重放时重复展示。

本篇分析本地 `my-dify` 的 `deepagents-integration` 分支，源码提交 `4e21eae6006c719a560a0b2f1af0aeba58d9b9ed`。下文路径均相对于该仓库根目录；这里只核对代码，未运行服务或浏览器。该实现采用服务端事件流（SSE）向页面推送消息，同时保存可恢复的执行事件。

## 一、一次执行有三个不同的状态面

| 状态面 | 回答的问题 | 当前实现 |
| --- | --- | --- |
| 业务状态 | 本轮任务在运行、待输入、完成、取消还是失败？ | `AgentExecution` 与本轮消息记录 |
| 展示状态 | 页面应显示哪些消息、工具步骤和输入表单？ | 公开快照与按序事件 |
| 图执行状态 | 模型下一步从哪里继续？ | Agent 执行器及其检查点 |

数据库中的 `last_event_sequence` 是已提交事件的水位。实时流可以先于落库交付，因此“页面已看到”不等于“断线后可恢复”。执行服务结束时先排空事件写入，再提交消息、运行终态和结束事件；持久化失败不能作为成功结束。源码：`internal/service/agent/agent_execution_service.py` → `_execute_run()`（第 858–904 行）与 `_record_events()`（第 629–658 行）。

## 二、低延迟交付与历史补读共用序号

`AgentExecutionEventBuffer` 是实时事件与数据库写入之间的缓冲器。它先发布事件，再由独立线程按数量或时间合批保存；待写队列有上限，数据库跟不上时阻塞生产者，避免事件无限堆积。源码：`internal/service/agent/agent_execution_runtime.py` → `AgentExecutionEventBuffer.emit()`（第 151–167 行，原注释保留为中文）。

```python
def emit(self, event: AgentProtocolEvent, *, is_text_delta: bool = False) -> None:
    """登记一条统一事件并立即实时交付；写入落后时通过背压限制内存。"""
    with self._condition:
        # 待写队列包含正在提交的批次，背压不能只计算尚未取出的事件。
        self._condition.wait_for(
            lambda: len(self._pending_events) < self._MAX_PENDING
            or self._error
            or self._closing,
        )
        if self._error is not None:
            raise self._error
        if self._closing:
            raise RuntimeError("Agent event writer is closed")
        # 登记和实时发布在同一锁内完成，写线程不能抢先提交未发布的事件。
        self._pending_events.append(event)
        self._publish_realtime(event)
        self._condition.notify_all()
```

进程内的 `AgentExecutionEventHub` 保存最近 2048 条事件。`read_after()` 收到的游标比最早保留的事件还旧时返回 `None`；空列表则表示订阅者已经追上。查询服务收到 `None` 后，按相同的序号从数据库读取缺口，而不是把缺失事件当作“没有新内容”。源码：`internal/service/agent/agent_execution_event_hub.py` → `read_after()`（第 32–48 行）；`internal/service/agent/agent_execution_query.py` → `_stream_events()`（第 353–394 行）。

```python
def read_after(self, sequence: int, limit: int) -> list[AgentProtocolEvent] | None:
    """None 表示历史缺口；空列表表示已追上当前内存尾部。"""
    with self._condition:
        oldest_cursor = (
            self._events[0].seq - 1 if self._events else self._initial_sequence
        )
        if sequence < oldest_cursor:
            return None
        if not self._events or sequence >= self._events[-1].seq:
            return []
        result: deque[AgentProtocolEvent] = deque(maxlen=limit)
        # 从尾部扫到游标，只保留最早一批未读事件，积压时也不复制整个尾部。
        for event in reversed(self._events):
            if event.seq <= sequence:
                break
            result.appendleft(event)
        return list(result)
```

实时通道只覆盖本进程当前执行片段。进程重启、换到其他实例或订阅者落后太多时，都要以数据库事件和业务状态恢复；这套代码不能直接推导出跨实例实时广播或自动接管能力。

## 三、快照固定水位，后续事件继续接流

浏览器从零重放所有文本分片，恢复成本会随对话增长。当前实现允许订阅者请求 `recovery=snapshot`：先读取一次业务问答、公开执行状态和已提交事件水位；只压缩该水位以内的历史事件，然后从水位之后继续订阅。源码：`internal/service/agent/agent_execution_query.py` → `_build_recovery_snapshot()`（第 424–445 行）。

```python
sequence = int(run.last_event_sequence or 0)
summary = self._run_summary(run, fallback_error=turn.error)
# 会话正文从业务表恢复，执行细节只使用公开字段。
values = select_public_snapshot(run.public_snapshot)
values["messages"] = self._turn_messages(turn, run)
values["runs"] = [summary.model_dump(mode="json")]
# 只合并固定水位之内的事件；水位之后由实时流继续交付。
events = compact_execution_events(self._recovery_events(run_id, sequence))
return AgentProtocolRecoverySnapshotResp(
    run_id=run_id, sequence=sequence, run=summary, values=values, events=events,
)
```

这里的切分点是**数据库已经提交的序号**，不是浏览器收到的最后一个文本字符。恢复读取过程中新增的事件仍由后续流交付。查询服务还在数据库侧排除工具参数分片并裁剪重复聊天正文，避免把内部参数和大段历史重新送到页面（同文件第 447–477 行）。`AgentProtocolEventStreamReq.from_mapping()` 合并请求中的 `since` 与 SSE 的 `Last-Event-ID`，取更靠后的有效游标；订阅过滤掉某些事件时仍推进扫描游标，避免在隐藏事件上反复重读。源码：`internal/schema/agent/agent_protocol_schema.py`（第 267–295 行）；`agent_execution_query.py`（第 390–394 行）。

## 四、公开投影先过滤，再编号和压缩

图内部状态和页面状态不是同一份数据。`select_public_snapshot()` 只挑出 `todos`、`files`、`async_tasks`、`pending_inputs`、`input_history`，不把模型调用配置或内部恢复字段直接送到页面。`adapt_graph_state()` 还会改写消息和异步任务字段；它负责适配图数据，**公开白名单**由后续的快照筛选确定。源码：`internal/service/agent_protocol/state_projector.py` → `adapt_graph_state()`、`select_public_snapshot()`（第 9–70 行，节选）。

```python
_PUBLIC_STATE_KEYS = ("todos", "files", "async_tasks", "pending_inputs", "input_history")

def select_public_snapshot(snapshot: Mapping[str, Any] | None) -> dict[str, Any]:
    """只公开会话状态，过滤模型调用配置和内部表单恢复信息。"""
    source = snapshot or {}
    return {key: source[key] for key in _PUBLIC_STATE_KEYS if key in source}
```

事件也要在分配**公开序号之前**过滤。`AgentProtocolEventProjector.project_agent_event()` 丢弃根图终态（由业务终态事务另发）和工具参数增量；自定义事件先经过规范化，不能把任意内部载荷透传。恢复执行时框架来源序号可能重新开始，页面游标仍沿本 Run 的公开序号递增。源码：`internal/service/agent_protocol/event_projector.py` → `project_agent_event()`（第 36–59 行，节选）。

```python
# 不给根图终态和工具参数增量分配公开序号；末尾 create_event() 调用略。
if event.is_root_terminal:
    return None
data = event.data
match event.channel:
    case EventChannel.CUSTOM:
        data = normalize_custom_data(data)
        if data is None:
            return None
    case EventChannel.VALUES:
        data = adapt_graph_state(data)
    case EventChannel.MESSAGES:
        message = event.message
        assert message is not None
        if message.is_tool_argument_delta:
            return None
```

等待表单或结束时，`create_state_transition()` 按“状态 → 每个待填表单 → 生命周期”生成公开事件，调用方在同一业务事务提交。若先发结束事件，客户端可能停止订阅，漏掉表单或最终状态（同文件第 68–79 行）。数据库历史读取也会再次校验自定义事件的公开格式，不能因为载荷已存过一次就跳过筛选。

恢复快照只压缩水位以内的消息分片。`compact_execution_events()` 把同一内容块的增量合并到起始事件，保留起点的 `event_id` 和原 `seq`；结束帧若含完整内容，则以完整内容为准。它不重新给压缩结果编号，因此水位之后的新增量仍能沿原序号接续。`values` 事件中的 `messages` 被移除，避免与从业务消息表重建的正文重复。源码：`internal/service/agent_protocol/recovery_snapshot.py` → `compact_execution_events()`、`_with_data()`（第 61–102 行，节选）。

```python
# 内容块起点进入保留集，增量只附加到它；其他分支略。
case MessageEventKind.BLOCK_START:
    assert message.index is not None and message.content is not None
    block = _ContentBlock(event, dict(message.content))
    calls[call][message.index] = block
    kept[event.seq] = block
    continue
case MessageEventKind.BLOCK_DELTA:
    assert message.delta is not None
    calls[call][message.index].append(message.delta)
    continue
```

这层投影的边界是**页面协议**，不是对所有内部消息都做通用脱敏。新增工具或自定义事件时，要检查实时投影、持久化读取和快照压缩是否都仍只公开预期字段；尤其不能让工具参数在恢复路径重新出现。

## 五、验收与适用边界

把页面连接、事件保存和任务执行分别制造故障，检查三者是否仍能汇合：

- 文本已实时显示但数据库尾批尚未提交时断线，重新连接应从**已提交水位**补读；不能把暂时未落库的片段当作永久事实。
- 订阅者落后超过内存缓冲容量时，应转向数据库，序号连续且不重复展示同一事件。
- 等待表单输入时刷新页面，应恢复当前待填批次；提交同批答案后沿用原任务，而不是启动新轮次。运行恢复规则见[Agent 状态](../02-state/agent-state-architecture.md)。
- 事件写入失败时，不能发布成功终态；订阅者看到最终状态时，应能从持久记录解释该结果。

上述是根据源码提出的验收条件，并非已跑出的测试结果。内存事件中心、有界线程池和数据库补读可以解决单实例的即时交付与断线恢复；跨实例实时唤醒、进程故障后的自动继续执行，还需要另行设计和验证。[证据与反馈](./agent-observability.md)讨论要保留哪些运行证据，本篇聚焦这些证据怎样可靠到达 Web 页面。
