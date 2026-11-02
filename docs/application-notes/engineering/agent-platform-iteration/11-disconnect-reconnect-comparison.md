---
sidebar_position: 15
sidebar_label: mydify 与 Octop 断线重连
description: 对照 mydify 与 Octop 普通聊天在任务继续、实时续传和历史补读上的实现，说明事件水位、消息归档、重连入口及进程重启边界。
---

# mydify 与 Octop 断线重连：任务继续、输出续传与历史补读

mydify 是本专栏的自建 Agent 应用开发平台，Octop 提供与 Agent 对话的本地面板。本文比较两边普通聊天在网页断线后怎样继续执行、恢复输出和补读历史。

## 一、回答到一半断线，恢复的究竟是什么

假设 Agent 正在回答“请给我一个文件分析方案”。页面已经显示“方案分三步：”，随后网络断开；服务端继续生成“读取文件、检查依赖，”；网页重新连上时，Agent 正准备输出“生成报告。”这是解释机制的假设场景，不是断线实测。

**任务继续**关心服务端：浏览器断开后，模型与工具调用是否仍在执行。只要服务端进程存活，连接断开可以只影响输出交付。

**实时续传**关心重连通道：页面能否通过重新建立的流式连接，补上断线期间产生的“读取文件、检查依赖，”，再接新输出。任务继续执行，并不自动提供这种能力。

**历史补读**关心已经保存的内容：若流式通道不补发，页面能否重新请求历史，读回消息当前的完整状态。它依赖归档时机，也需要前端提供刷新和合并入口。

下文分别沿 mydify 和 Octop 的调用链解释这三件事。Octop 的默认 legacy 历史与可选 v2 归档会在保存环节分开说明；trajectory（执行轨迹）SSE 放在工程改造部分讨论。

本文依据 mydify 前后端当前工作区与 Octop `v1.0.2` 源码作静态分析，具体 commit 和未提交修改范围列在文末。各段源码证明对应函数的行为，跨函数得出的页面恢复结果属于静态推断，未经过真实断线测试。网络恢复的讨论均以服务端进程存活、执行未被取消为前提。

## 二、mydify：从后台执行到快照接续

mydify 把发起执行和查看输出拆成两个请求。一次用户提问对应一条问答记录 `conversation_turn`；负责这轮执行的记录是 `agent_execution`，对外称为 Run。浏览器用 `run_id` 查看同一次运行。

下面是调用关系示意，具体源码在各步骤中展开：

```text
HTTP command
  → AgentExecutionService.start_run
  → _submit_execution / _execute_run
  → AgentExecutionEventBuffer.emit
      ├─ tracker.publish_events → 当前 SSE 订阅者
      └─ _run_writer → _record_events → _append_events
          → agent_execution_event + last_event_sequence

SSE recovery: snapshot
  → _build_recovery_snapshot
  → 先交付 snapshot.sequence 以内的快照
  → _stream_events 查询 sequence > cursor 的事件
  → 前端 recoverySeedEvents / applyRunEvent 组装页面
```

### 1、发消息启动 Run，事件连接只负责查看

用户发消息时，HTTP 命令创建 Run，把执行提交给后台线程池，然后返回 `run_id`。浏览器再用这个 ID 订阅输出。

后台提交的核心调用如下，省略了前面的并发槽位检查：

```python
# 后端 internal/service/agent/agent_execution_service.py
# _submit_execution 节选：执行交给后台线程池。
self._run_executor.submit(
    self._execute_background_run,
    current_app._get_current_object(),
    run,
)
```

命令回执还带一个序号，表示命令已生效到哪个事件位置。支持游标订阅的客户端可以据此接续，覆盖“命令已返回、订阅尚未建立”的时间间隔。

订阅使用 SSE（Server-Sent Events，服务端向浏览器单向推送事件的格式）。连接关闭只会结束这次查看，不会取消线程池中的执行。用户再次订阅同一个 `run_id`，查看的仍是原来的 Run。

### 2、生成的输出保存在哪里

后台把消息开始、文本增量、工具执行和运行状态等变化转换为协议事件。恢复这些输出涉及三张表，所属会话是 `conversation`：

| 表 | 关键字段与约束 | 保存什么 | 恢复时怎么用 |
| --- | --- | --- | --- |
| `conversation_turn` | `id` 主键；`conversation_id`；`query`、`answer` | 一轮问答正文及累计用量 | 为聊天历史和快照提供问答正文 |
| `agent_execution` | `id` 主键；`turn_id` 唯一；`status`、`display_state`、`last_event_sequence` | 一次逻辑 Run 的状态、展示投影和已提交事件位置 | 选定恢复水位，判断继续订阅还是结束当前连接 |
| `agent_execution_event` | `(execution_id, sequence)` 联合主键；`payload` | 每一次协议变化 | 读取水位前的事件来构建快照，读取水位后的事件来追赶输出 |

mydify 使用 SQLAlchemy，把 Python 模型字段映射为数据库列。下面摘录当前模型，省略归属、时间和其他字段。它们用于说明当前表结构，数据库迁移还需按仓库的迁移链执行。

```python
# 后端 internal/model/agent_execution.py
# AgentExecution 节选：省略部分字段、索引及主键约束声明。
class AgentExecution(db.Model):
    __tablename__ = "agent_execution"

    # 省略 __table_args__ 等声明。
    id = Column(UUID, nullable=False, server_default=text("uuid_generate_v4()"))
    # 省略应用与会话归属字段。
    turn_id = Column(
        UUID, ForeignKey("conversation_turn.id", ondelete="CASCADE"), nullable=False
    )  # 承载本轮问答与累计用量；归属三元组一致性由创建服务保证
    # 省略输入消息标识等字段。
    status = Column(
        String(32), nullable=False, server_default=text("'running'")
    )  # AgentExecutionStatus，独立于消息展示状态；建行即已分配执行权
    # 省略错误、运行选项与表单字段。
    # 当前轮消息和页面进度投影；历史问答、运行选项、表单与图 checkpoint 不在这里复制。
    display_state = Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    last_event_sequence = Column(Integer, nullable=False, server_default=text("0"))  # 已持久化事件游标，供流式重连续传
```

`turn_id` 把运行关联到问答记录，模型中的唯一约束使一轮问答只对应一个 Run。另一个条件唯一索引限制同一会话最多有一个处于 `running` 或 `waiting_input` 的 Run。`display_state` 是页面展示投影，保存消息、待办、文件和异步任务等展示状态；图的执行位置由单独的检查点保存。

事件表的结构更直接，下面保留主键和载荷字段，省略创建时间：

```python
# 同文件 AgentExecutionEvent 节选。
class AgentExecutionEvent(db.Model):
    """持久化协议事件，供流式重连续传和执行过程历史查询。"""

    __tablename__ = "agent_execution_event"
    __table_args__ = (
        PrimaryKeyConstraint(
            "execution_id",
            "sequence",
            name="pk_agent_execution_event_run_sequence",
        ),
    )

    execution_id = Column(UUID, ForeignKey("agent_execution.id", ondelete="CASCADE"), nullable=False)
    sequence = Column(Integer, nullable=False)  # 事件顺序与续传游标，同一 Run 内唯一
    payload = Column(JSONB, nullable=False)  # 必须显式提供经校验的 AgentProtocolEvent，空对象不是有效事件
    # 省略 created_at。
```

这里要记住的是联合主键：同一个 Run 的第 101 条、第 102 条事件分别占一行。协议把顺序编号叫作 `seq`，入库列名是 `sequence`；API 的 `run_id` 对应 `agent_execution.id`，在事件表中写入 `execution_id`。新 Run 从同会话、同入口已有的最大水位继续分配序号，但事件表的主键和查询仍按单个 Run 隔离。

`last_event_sequence` 记录已经提交到数据库的位置，本文称为“水位”。它与事件记录一起提交，才能用来判断哪些内容已可靠保存。

事件缓冲由 `AgentExecutionEventBuffer` 管理，它把同一事件交给实时发布与后台持久化两条路径。写线程的 `_run_writer` 提交批次，进入服务层 `_record_events`，再调用 `_append_events`；此时调用方已经锁定 Run，并持有事务。

```python
# 后端 internal/service/agent/agent_execution_service.py
# _append_events 节选；省略开头的空列表判断。
payloads = {
    event.seq: {"execution_id": row.id, "sequence": event.seq, "payload": event.model_dump(mode="json")}
    for event in events
}
statement = pg_insert(AgentExecutionEvent).values(list(payloads.values()))
self.db.session.execute(statement.on_conflict_do_nothing(index_elements=["execution_id", "sequence"]))
row.last_event_sequence = max(int(row.last_event_sequence or 0), max(payloads))
```

输入是一批事件，输出是 `agent_execution_event` 中的事件行，以及 `agent_execution.last_event_sequence` 的更新。`pg_insert` 使用 PostgreSQL 的插入语句；冲突判断正好对应前面看到的联合主键，重试同一批次不会重复插入。

事务由同文件的 `_record_events` 打开；它在 `with self.db.auto_commit():` 内锁定 Run、更新展示快照并调用 `_append_events(row, events)`。因此事件行与水位共用事务，提交成功才表示这批事件已保存。

mydify 的实时交付可以领先数据库提交。事件进入待写队列后先实时发布，独立写线程再合批提交。

| 参数 | 当前值 | 用途 |
| --- | --- | --- |
| 持久化批次 | 最多 128 条 | 减少逐事件事务开销 |
| 未满批等待时间 | 约 250ms | 避免少量事件长时间留在队列 |
| 待写队列上限 | 512 条 | 写入跟不上时让生产端等待，限制内存增长 |
| 实时缓冲容量 | 2048 条 | 支持低延迟订阅，超出范围再回库补 |

这些参数共同保证正常运行时的衔接：待写队列有上限，实时缓冲又比它大，被缓冲淘汰的旧事件已经提交，可以从数据库找回。

但进程突然崩溃时，浏览器已经看到、数据库尚未提交的尾部事件仍可能丢失。因此，本文所说的自动补齐，前提是执行与写入链路正常；它不包含进程骤停后的未提交数据恢复。

正常完成时，服务端先排空事件写队列，再在事务里提交回答、用量、Run 状态和终态事件，提交成功后才通知订阅者。客户端看到 `completed` 时，回答与完成状态已经提交。若排空失败后转为 `failed`，则不能据此保证此前所有实时事件都已保存。

### 3、重连时，用快照水位接上后续事件

例如，浏览器断线前收到第 100 条事件。重连时，数据库已经提交到第 120 条。服务端可以生成一份水位为 120 的快照，把已保存的状态与执行过程交给页面，然后从第 121 条继续。`snapshot.sequence` 就是这份快照采用的已提交水位。

快照和水位必须配套。只给一份内容、却不说明它覆盖到哪条事件，客户端就无法判断后续增量应该接在哪里。

工作台订阅时要求 `recovery: "snapshot"`。服务端先读取 `agent_execution`，通过 `turn_id` 关联 `conversation_turn`，再取已提交水位以内的事件。

```python
# 后端 internal/service/agent/agent_execution_query.py
# _build_recovery_snapshot 节选；上文已关联读取 run 与 turn。
sequence = int(run.last_event_sequence or 0)
summary = self._run_summary(run, fallback_error=turn.error)
# 2.会话正文从业务表恢复，执行细节只使用公开字段。
values = select_public_snapshot(run.public_snapshot)
values["messages"] = self._turn_messages(turn, run)
values["runs"] = [summary.model_dump(mode="json")]
# 3.只合并固定水位之内的事件；水位之后由实时流继续交付。
events = compact_execution_events(self._recovery_events(run_id, sequence))
```

这段代码把三类表连起来：`ConversationTurn` 提供问答正文，`AgentExecution` 提供公开展示状态和水位，`AgentExecutionEvent` 提供生成中的消息与执行过程。`compact_execution_events` 合并连续内容块，保留恢复展示所需的事件边界。

服务端把快照作为 SSE 的第一帧，再把订阅游标移到快照水位：

```python
# 后端 internal/service/agent/agent_execution_query.py
# _stream_events 节选：先交付快照，再从快照水位之后读取。
cursor = stream_request.since
if stream_request.recovery == "snapshot":
    try:
        snapshot = self._build_recovery_snapshot(run_id)
    finally:
        self.db.session.close()
    yield snapshot.model_dump(mode="json")
    cursor = snapshot.sequence
    if snapshot.run.status in _SSE_FINISHED_STATUSES:
        return
```

这里的输入是要查看的 Run 和恢复模式，输出是快照首帧，以及它后面的事件。快照若已表明运行完成、失败、取消或正在等待用户输入，当前连接就可以正常结束。

如果快照水位是 120，生成快照期间又出现了第 121、122 条事件，这两条不会被塞进旧快照，而是交给后续订阅循环。快照覆盖已有前缀，事件流补上后续变化。

订阅循环优先读取进程内的实时缓冲。浏览器落后太多，缓冲已覆盖不到它要的位置，就回数据库读取。下面是数据库查询的核心部分，省略了外层订阅循环：

```python
# 同文件 _stream_events 节选：读取当前游标之后的事件。
rows = (
    self.db.session.query(AgentExecutionEvent.sequence, AgentExecutionEvent.payload)
    .filter(
        # 归属已在响应开始前验证，执行身份与归属创建后不可变。
        AgentExecutionEvent.execution_id == run_id,
        AgentExecutionEvent.sequence > cursor,
    )
    .order_by(AgentExecutionEvent.sequence.asc())
    .limit(self._SSE_BATCH_SIZE)
    .all()
)
```

这条查询回答的是“这次运行在某个位置之后发生了什么”。内存缓冲用于减少查库和等待，数据库保存可回读的事件记录。

### 4、前端拿到快照，还要恢复消息的组装过程

快照里包含当前运行摘要、展示状态，以及合并后的事件。连续的文本分片会整理成内容块，工具执行也保留恢复展示所需的边界，客户端无需从第一条 token 开始逐条播放。

聊天记录中的问答正文由业务表恢复；生成中的消息组装和执行阶段内容，仍会使用快照中的合并事件。不能把这一步理解为“只取最终答案，不再处理消息事件”。

前端还要照顾消息 SDK。这里使用的 `@langchain/vue` 提供消息流组装能力：它需要知道一条消息何时开始、后续分片属于哪个内容块。断线后直接塞入新分片，开始事件已经错过，消息可能接不起来。

因此，前端的 `recoverySeedEvents` 会从快照中为当前消息补齐组装上下文，再交付完整状态、待填表单与当前运行状态，之后才接实时增量。恢复用的事件换用新 ID，避免被 SDK 当成已经消费过的旧事件过滤。

工作台也不会直接信任网络层记住的最后一个序号。它在订阅时明确清掉旧游标，重新取得配套的快照与水位：

```ts
// 前端 src/services/workbench-sse-fetch.ts
// createResumableWorkbenchFetch 节选。
// 每次重连重新取得配套快照与水位，不采用尚未应用到页面的网络字节游标。
payload = { ...payload, run_id: binding.runId, recovery: 'snapshot' }
delete payload.since
headers.delete('Last-Event-ID')
```

原因很具体：浏览器收到了某段网络数据，不代表页面已经成功应用了对应事件。若按网络字节的接收进度跳过数据，页面可能漏掉尚未渲染的内容。

应用快照前，前端还会检查 Run 身份、快照水位和事件顺序。恢复执行过程时，只替换水位以内的旧内容，保留已经收到的水位之后的实时事件，避免快照覆盖更新的数据。

SSE 的正常关闭也有标记。服务端正常结束订阅时发送 `: stream-end` 注释；前端遇到缺少这个标记的意外流结束，会把错误交给上层 SDK 重试。连接结束与 Run 结束分别判断，等待表单时正常关流也不会被当成网络故障。SDK 重试有上限，耗尽后界面仍会进入连接失败状态。

## 三、Octop：重新订阅与历史补读怎样配合

Octop 用 `thread` 表示会话，用 `turn` 表示一次交互轮次。浏览器通过 WebSocket 提交用户消息并接收 chunk（聊天输出分片）；服务端在进程内维护连接、订阅和活动轮次。重连先恢复订阅，缺失内容由历史读取提供。

以下是普通聊天的调用关系示意。保存分支中的逐分片归档只适用于 v2 轮次：

```text
WebSocket user_turn
  → ws_channel.handle_inbound
  → hub.subscribe + mark_turn_active
  → processor.iter_turn_chunks
      ├─ history_tracker.observe → flush_tracker → v2 消息文档更新
      └─ hub.push_to_thread → 当前订阅者；无订阅者时不排队

WebSocket reconnect
  → ws.py subscribe(thread_id)
  → 登记订阅，可能补发团队成员或 steer 状态
  → turn_status.active，接收后续普通聊天 chunk

history refresh
  → history.service.page
  → v2 store.message_page / legacy projection
  → 前端 useChat 合并当前消息
```

### 1、断开连接，只注销这个订阅者

服务端处理 WebSocket 断开的收尾代码很短：

```python
# Octop src/octop/api/routers/chat/ws.py，收尾块节选。
finally:
    # 断开不得取消在途轮；客户端可重连并订阅后续分片，即弱恢复。
    hub.unregister(connection_id)
```

`hub` 是 `WebSocketHub` 实例，负责管理进程内的连接、订阅与活动轮次。这里移除的是一个浏览器连接，不会取消正在运行的 turn。

执行过程向 WebSocket 投递分片时，也会单独捕获推送异常。发送失败只记日志，后台继续生成。源码注释给出的理由是，网络闪断不应让生成停在节点中途，留下未完成的图状态。

如果某个线程没有订阅者，`push_to_thread` 直接返回。这一批聊天帧不会进入一个等待重连后回放的队列。重连之后恢复的是接收后续输出的能力。

### 2、重新订阅时，服务端告诉页面这一轮还在不在跑

客户端的 `attachThread` 在新连接打开时，发送 `subscribe`，指定原来的 `thread_id`。服务端校验会话归属、登记订阅，然后返回 `turn_status`：

```python
# Octop src/octop/api/routers/chat/ws.py
# subscribe 分支节选，省略了前面的归属校验与订阅登记。
await send_frame({
    "type": "turn_status",
    "thread_id": thread_id,
    "active": hub.is_turn_active(thread_id),
})
```

`active` 来自服务端进程内的活动轮次集合。为真时，前端进入或保持流式显示，接收之后到达的分片；为假时，前端可以结束仍挂着的本地生成状态。

这次握手没有携带“我已收到第几条聊天分片”的游标，也不会按游标回放断线窗口中的普通聊天分片；团队成员文本补发与 steer（运行中追加指令）的队列快照处理的是特定内容，不构成普通聊天 chunk 的通用回放。

前端自动重订阅有明确范围：意外断开、当前会话仍在流式状态、会话 ID 有效，而且用户正在查看该会话。首次重新绑定后，若仍然断开，可再递增重试最多 8 次，间隔固定为 400ms。后台会话先记下待恢复状态，用户切回来再处理。

另一个看门狗负责清理长时间悬着的页面状态。用户正在查看的会话中，连接既未打开、也不在建立中，而且无活动时间达到 20 秒等条件成立时，前端会结束本地的流式显示。重试耗尽也可能更早结束显示。**这些动作只收起页面上的生成状态，不会取消服务端任务，也不会补齐缺失文字。** 活连接仍在时，工具执行很久没有输出属于正常情况，不受这条规则影响。

### 3、断线期间的内容存在哪里

**默认 legacy 路径：收尾记录与历史投影。**

Octop 需要分清旧版历史路径与 v2 独立归档。默认 `history_v2_enabled=False`，旧版路径使用控制面数据库中的 `thread_messages` 和 `thread_history_projection`。控制面数据库还保存会话等业务数据。

下面摘录 SQLite 控制面迁移中的旧版历史建表 SQL，省略索引和初始化语句：

```sql
-- Octop src/octop/infra/db/migrations/010_thread_message_projection.sql
-- 面板历史读模型；省略建表之后的索引与回填。
CREATE TABLE IF NOT EXISTS thread_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  message_id    TEXT,
  role          TEXT NOT NULL,
  message_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(thread_id, seq),
  UNIQUE(thread_id, message_id)
);

CREATE TABLE IF NOT EXISTS thread_history_projection (
  thread_id    TEXT PRIMARY KEY REFERENCES threads(thread_id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  error        TEXT
);
```

`thread_messages.message_json` 保存供历史接口读取的消息。`seq` 排列消息先后，用于翻页。`thread_history_projection.status` 表示历史列表是否已整理好，不能用来判断 Agent 此刻是否仍在运行。

旧线程可以从检查点回填消息列表。检查点保存图的执行状态，整理出来供页面读取的消息列表称为“历史投影”。运行中的普通聊天分片没有因为这两张表存在，就获得逐分片回放能力。

**v2 路径：更新消息当前状态。**

v2 在独立 SQLite 数据库 `history_v2.sqlite` 中归档消息与轨迹。下面摘录其建表定义，省略元数据表和索引：

```sql
-- Octop src/octop/infra/history/store.py，_SCHEMA 节选。
CREATE TABLE segments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 format TEXT NOT NULL CHECK(format IN ('legacy','v2')),
 legacy_start INTEGER NOT NULL, legacy_end INTEGER, anchor TEXT,
 trajectory_start INTEGER NOT NULL, trajectory_end INTEGER
);
CREATE TABLE turns (
 id TEXT PRIMARY KEY, segment_id INTEGER NOT NULL REFERENCES segments(id),
 status TEXT NOT NULL, error TEXT, started_at REAL NOT NULL, finished_at REAL
);
CREATE TABLE bodies (digest TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id),
 kind TEXT NOT NULL CHECK(kind IN ('message','event')), seq INTEGER NOT NULL,
 data TEXT NOT NULL, UNIQUE(thread_id,kind,seq)
);
CREATE TABLE body_refs (
 owner TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
 digest TEXT NOT NULL REFERENCES bodies(digest), PRIMARY KEY(owner,digest)
);
```

区段表 `segments` 衔接同一会话中的不同历史格式，`turns` 记录归档轮次。`documents` 保存文档，`bodies` 与 `body_refs` 按内容摘要保存和引用正文块。

`documents` 同时容纳 `kind='message'` 和 `kind='event'`。本篇比较普通聊天恢复时，关注的是 **message 文档**，不能把另一种轨迹文档当成普通聊天帧。

v2 归档要求控制面数据库使用 SQLite。环境变量 `OCTOP_HISTORY_V2_ENABLED` 决定新轮采用哪种格式；关闭开关后，已有归档仍可读，暂停中的 v2 轮恢复时也沿用原格式。后文所说的转发前归档，均指实际格式为 v2 的轮次。

Octop 的历史记录器把文字、推理内容和工具调用片段并入消息当前状态。处理 Agent 输出的循环先观察分片，再等待归档刷新，之后才交给 WebSocket 发送层。下面省略外层循环与后续轨迹记录：

```python
# Octop src/octop/infra/gateway/process/processor.py
# iter_turn_chunks 节选：发生在 WS 通道转发当前分片之前。
usage_tracker.observe(chunk)
history_tracker.observe(chunk)
await flush_tracker(history_tracker)
```

记录器的 `flush` 只为 v2 轮保存发生变化的消息；未变化的消息按内容摘要去重：

```python
# Octop src/octop/infra/history/recorder.py
# flush 开头节选，后续是脏消息检测与保存。
async def flush(self) -> None:
    if self.turn["format"] != "v2":
        return
```

保存路径进入 `HistoryArchive.save_message_updates`。下面截取消息 ID 与序号选择部分，省略外层事务和后续 `put_document` 调用：

```python
# Octop src/octop/infra/history/service.py
# save_message_updates 节选。
for index, wire in updates:
    doc_id = f"message:{turn['id']}:{index}"
    old = conn.execute("SELECT seq FROM documents WHERE id=?", (doc_id,)).fetchone()
    seq = (
        int(old[0])
        if old
        else int(
            conn.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM documents WHERE thread_id=? AND kind='message'",
                (turn["thread_id"],),
            ).fetchone()[0]
        )
    )
```

输入 `updates` 包含消息位置与新内容。已有文档沿用旧 `seq`，只有新消息才分配下一个消息序号。随后 `HistoryStore.put_document` 编码正文并写入 `documents`，冲突时只更新 `data`：

```python
# Octop src/octop/infra/history/store.py
# put_document 节选；正文块已经编码，旧引用在后续代码清理。
conn.execute(
    "INSERT INTO documents VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
    "data=excluded.data",
    (doc_id, thread_id, turn_id, kind, seq, encoded),
)
```

`documents.id` 标识同一条消息，追加文字更新其内容；`bodies` 与 `body_refs` 复用仍被引用的正文块，释放失效引用。它没有为每次文本追加再建一条消息文档。

| 归档方式 | 何时保存消息 | 对断线补齐的影响 |
| --- | --- | --- |
| v2 轮次 | 有内容变化的分片在转发前刷新消息归档 | 重拉历史可以读到已归档的消息状态，普通聊天帧仍不回放 |
| legacy 轮次 | 通常在成功、失败或取消收尾时写入历史 | 不具备上述逐分片归档保证，内容由收尾记录、检查点与历史投影等路径提供 |

所以，核对部署能力时要看当前轮次的格式。即便默认关闭 v2，历史接口也可能仍在读取旧归档或混合格式的历史。

### 4、页面通过历史请求补齐内容

断线期间的文字即使已经写进 v2 归档，重新订阅也不会把它变成一批补发的聊天帧。页面接到重连后的新文字，先前的缺口仍可能存在。

补齐入口是历史读取。整页刷新或显式下拉刷新会请求最近一页历史，用已保存的消息状态重建时间线。同一网页内切走再切回，可能直接复用缓存，不能保证重新请求历史。重连成功提示也会提醒用户，显示不完整时可以下拉刷新。

v2 路径按区段读取消息文档，下面是 `message_page` 的查询，省略外层连接、参数绑定与后续正文解码：

```sql
-- Octop src/octop/infra/history/store.py，message_page 查询。
-- before 用来向更早的消息翻页。
SELECT d.seq,d.data FROM documents d JOIN turns t ON t.id=d.turn_id
WHERE d.thread_id=? AND t.segment_id=? AND d.kind='message'
  AND (? IS NULL OR d.seq<?) ORDER BY d.seq DESC LIMIT ?
```

输入是会话、区段和消息分页位置，输出是这一页消息的当前内容。这里同时用到了上面的 `documents` 和 `turns`，读取方向是按消息序号向前翻页；旧版区段则读取控制面的历史投影。

前端特意允许断线后的刷新。判断只阻止“仍在流式显示，而且有活连接”的情况：

```ts
// Octop dashboard/src/pages/Chat/hooks/wsResumeGate.ts
// 断线后即使本地仍标记为流式，也允许重拉历史。
export function shouldBlockHistoryRefresh(opts: {
  isStreaming: boolean;
  hasLiveSocket: boolean;
}): boolean {
  return opts.isStreaming && opts.hasLiveSocket;
}
```

这条规则避免了死循环：如果页面因为漏掉结束帧而一直认为“正在生成”，又因为“正在生成”拒绝刷新，用户就没有机会把回答补完整。

历史投影尚未就绪时，接口可以返回加载标记与建议重试时间，客户端继续轮询。拉回的历史也要与本地内容合并，保留较早分页和请求期间的新消息。

## 四、把同一次断线放回两套实现

回到开头的例子：页面已有“方案分三步：”，错过了“读取文件、检查依赖，”，重连后还要接收“生成报告。”沿前面的调用链，可以得到以下静态推断：

| 环节 | mydify | Octop v2 普通聊天 | Octop legacy 普通聊天 |
| --- | --- | --- | --- |
| 断线期间任务 | 后台 Run 继续执行 | 活动 turn 继续执行 | 与 v2 相同 |
| 缺失文字保存在哪里 | 协议事件批量提交到事件表，推进已提交水位 | 变化消息在转发前更新归档中的同一文档 | 依赖收尾记录、检查点与历史投影路径 |
| 重新连上 | 同一 `run_id` 请求快照，再接水位之后的事件 | 同一 `thread_id` 重新订阅，接后续 chunk | 与 v2 相同；握手不读取历史投影 |
| 怎样补上中间那段文字 | 已提交部分随快照自动恢复，前端接回消息组装过程 | 历史请求读回消息当前内容，与本地消息合并 | 历史可读或投影就绪后补读，必要时重试 |
| 用户需要做什么 | 正常重连无需刷新；连接重试失败仍需处理 | 显示不完整时下拉或整页刷新；有活连接且正在流式时刷新会被门控阻止 | 同样需要历史补读，并可能等待收尾或投影就绪 |
| 恢复依据 | 事件 `seq`、数据库 `sequence` 与已提交水位 | `documents.seq` 标识消息位置，内容更新保留序号 | 历史消息位置；没有与重订阅绑定的分片游标 |

mydify 的快照与后续事件共同覆盖已提交前缀和新的变化。Octop 的消息文档保存当前内容，WebSocket 握手没有把这些文档转换为缺失帧；归档可读与聊天帧可回放是两项不同能力。团队成员或 steer 的局部补发也不改变这条普通聊天路径。

## 五、进程重启后，还能恢复什么

前文的重连结论都假设服务端进程仍在运行。进程重启会清空执行线程、连接订阅表和其他内存对象，数据库里留下的 Run 或检查点不会自动重建模型调用。已提交内容可以继续读取，执行线程和内存中的登记则需要另外处理：

| 边界场景 | mydify | Octop | 对本文结论的影响 |
| --- | --- | --- | --- |
| 进程重启中的活动任务 | 后台线程消失；Run 可能仍是 `running`，后续 `start_run`/`cancel_run` 才可能触发孤儿收敛 | `WebSocketHub._active_turns` 清空；重新订阅得到 `active=false`，归档不会重建执行 | 不能把数据库可读误写成任务自动续跑 |
| 进程骤停时的输出尾部 | 实时发布先于事件提交；可能丢掉浏览器已看到但尚未落库的事件 | v2 的变化消息在转发前已刷新归档；legacy 没有逐分片归档保证，未保存的尾部可能丢失 | 恢复范围取决于保存时机与轮次格式，不能把两边都概括为先发送后落库 |
| 等待用户输入 | `waiting_input`、`pending_inputs` 和持久化检查点共同保存可操作状态；`memory`/`disabled` 检查点不提供跨重启保证 | 审批注册在进程内；同一进程内可按有效期重拉，进程重启后旧 `pending_id` 可能失效 | 执行位置、表单/审批记录和消息历史需要分别保存 |


等待输入时，mydify 还用 `agent_execution_submission` 记录已接受的表单答案，以 `(execution_id, input_batch_id)` 去重。它保存的是输入提交事实，能否跨重启继续执行仍取决于持久化检查点。

## 六、工程上怎样选择和验收

上面的源码证明了两种不同的恢复行为。下面是据此作出的工程判断。

### 1、需要自动补齐执行过程时，事件序号与快照值得借鉴

如果产品要求用户重连后自动看到完整的工具过程、运行状态和回答进度，mydify 这套做法提供了明确的恢复依据：事件可回读，快照有水位，后续变化能接在水位之后。

成本也落在具体实现上。每条事件都要存储，写线程要处理积压与失败，快照要合并事件，前端要校验身份与水位。网络可能重复交付，同一个 `(run_id, seq)` 也要能被客户端识别，不能把它当成全链路“恰好一次”的保证。

当前 `_recovery_events` 用 `sequence <= 水位` 读取事件前缀，`yield_per` 只控制查库批次；合并后的快照仍作为一帧交付，未见明确的总体积上限。大 Run 应增加恢复载荷限制或分段协议。崩溃后的收敛依赖后续写请求，执行存活判据也绑定单进程；需要多进程部署时，应补充共享租约或心跳，再调整收敛逻辑。

### 2、允许重拉历史时，可以采用消息状态归档，但要给用户明确出口

如果产品主要要求回答能够找回，并接受刷新后补齐，Octop 的消息状态归档是一条可用路径。实现时要把三个条件一起交代清楚：运行中的内容是否已经归档，什么时候允许重拉，以及页面如何退出卡住的生成状态。

Octop 的下拉刷新门控、重连后的提示和本地超时收尾，都是这条路径的配套。只增加 WebSocket 自动重连，无法补上已经错过的普通聊天分片。

这种方式也不等于没有逐分片写入成本。v2 轮次会在转发前等待消息归档更新，同一条消息可能反复写入；内容摘要和正文分块会减少重复存储。默认 legacy 路径与 v2 路径的恢复能力不同，产品说明必须对应实际配置和轮次格式。

### 3、Octop 已有序号协议，可作为改造参考，仍需核对读写链路

Octop 的 trajectory（执行轨迹）观察流已经使用事件序号，SSE 端点接受 `after_seq` 与 `Last-Event-ID`，能够回读历史再接实时输出。这提供了协议参考，普通聊天 chunk 尚未接入同样的恢复路径。

该参考也有版本内的限制：轨迹回放最多取 2000 条；启用归档后，部分轨迹事件写入独立归档，而续传读取的 `list_from_seq` 仍读取控制面事件表，读写路径没有完整对齐。把聊天内容接入前，应先补齐这处读取，再设计回放上限、消息组装和历史切换，不能只增加一个序号字段。

### 4、按缺失内容是否找回验收

对于第一节那次断线，验收条件可以写得很具体：重新连上后，页面能否自动出现“读取文件、检查依赖，”；若需要用户刷新，界面是否明确提示，而且刷新确实能读到这段内容。恢复方案应按这两个结果验收。

还应单独检查取消入口。mydify 通过独立 HTTP 命令取消，SSE 断开不妨碍提交该命令；Octop 的 `cancel` 通过 WebSocket 发送，没有活连接时不能沿原通道送达。两者都需要可用网络，不能把断开查看连接等同于停止服务端任务。

## 七、源码版本与核验范围

| 对象 | 本文核验范围 |
| --- | --- |
| mydify 后端 | 本专栏的自建 Agent 应用开发平台；以 HEAD `4e21eae6006c719a560a0b2f1af0aeba58d9b9ed` 为基线的当前工作区，含其他未提交修改 |
| mydify 前端 | 工作台恢复相关实现；以 HEAD `eb71e50757c7e350c299f342eed431e0c0b5a5c3` 为基线的当前工作区，含其他未提交修改 |
| mydify 后端依赖声明 | `deepagents==0.6.12`、`langgraph==1.2.9`、`langgraph-checkpoint-postgres==3.0.5`；未核验运行中进程的安装环境 |
| Octop | `v1.0.2`，commit `dd9dce470844c25d59effb50615bb3c667ea25cd`；面板聊天服务端、前端重连门控与历史归档调用链 |
| 验证方式 | 静态阅读源码、配置与项目文档；未运行服务、构建、断线测试或模型调用 |

mydify 的主要源码位置如下，均为对应前后端仓库内的相对路径：

```text
后端
internal/service/agent/agent_execution_service.py       启动、后台执行、结算与孤儿收敛
internal/service/agent/agent_execution_runtime.py       实时发布与批量持久化
internal/service/agent/agent_execution_event_hub.py     实时尾部缓冲
internal/service/agent/agent_execution_query.py         快照与 SSE 订阅
internal/service/agent_protocol/recovery_snapshot.py   合并恢复事件
internal/model/agent_execution.py                      运行、事件与答案提交记录
internal/model/conversation.py                         会话与问答正文

前端
src/services/workbench-sse-fetch.ts                    重连请求与正常流结束判断
src/services/workbench-recovery.ts                     快照校验与消息组装上下文
src/hooks/use-workbench-runs.ts                        快照与实时执行过程合并
```

Octop 的公开源码可从 [v1.0.2 快照](https://github.com/TencentCloud/Octop/tree/dd9dce470844c25d59effb50615bb3c667ea25cd)查看。关键路径如下：

```text
src/octop/api/routers/chat/ws.py                       断开处理与订阅握手
src/octop/infra/gateway/ws/ws_hub.py                    订阅表与活动轮次
src/octop/infra/gateway/ws/ws_channel.py                执行与连接投递分离
src/octop/infra/gateway/process/processor.py            分片处理与归档调用
src/octop/infra/history/recorder.py                    按消息跟踪与刷新
src/octop/infra/history/service.py                     轮次格式与历史读取
src/octop/infra/history/store.py                       独立归档建表、消息覆盖与分页
src/octop/infra/db/migrations/010_thread_message_projection.sql  旧版历史投影建表
src/octop/infra/gateway/hitl/store.py                  进程内审批记录
src/octop/api/routers/chat/trajectory.py                轨迹 SSE 回放
src/octop/infra/history/trajectory_compat.py            轨迹归档兼容层

dashboard/src/pages/Chat/hooks/chatStore.ts            attachThread 与流式状态
dashboard/src/pages/Chat/hooks/wsResumeGate.ts          重连、刷新与超时门控
dashboard/src/pages/Chat/hooks/useChat.ts               历史重拉入口
```
