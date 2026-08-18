---
sidebar_position: 8
sidebar_label: 06 执行历史：保存、恢复与分叉
description: 追踪 LangGraph 如何保存执行快照、继续未完成任务、重放旧节点、创建分支，并区分 Checkpoint 与 Store。
---

# LangGraph 源码 06：执行历史如何保存、恢复与分叉

## 源码定位

> **适用版本**：`langgraph` 1.2.10、`langgraph-checkpoint` 4.1.1。
>
> **核心路径**：
>
> - 执行快照和保存协议：`libs/checkpoint/langgraph/checkpoint/base/__init__.py`
> - 内存保存器：`libs/checkpoint/langgraph/checkpoint/memory/__init__.py`
> - Runtime 恢复与轮次快照：`libs/langgraph/langgraph/pregel/_loop.py`
> - 查询状态、历史和手动分叉：`libs/langgraph/langgraph/pregel/main.py`
> - 业务 Store：`libs/checkpoint/langgraph/store/base/__init__.py`

## 这一篇的主题

[第 03 篇](./03-pregel-supersteps-and-scheduling.md)讲过任务怎样执行和写回，[第 04 篇](./04-dynamic-routing-and-send.md)讲过动态路由怎样产生任务。本篇继续追踪任务结果如何留下可恢复的执行历史：

```text
graph.invoke(input, {thread_id})
  → 读取该执行线的最新 checkpoint
  → 写入输入或恢复信号
  → 执行任务并提交 State
  → 保存新的 checkpoint
  → 后续调用继续、重放或从旧点分叉
```

Checkpoint（检查点）保存一条图执行线的现场；Store（业务存储）保存跨执行共享的数据。两者的查询身份、写入时机和用途都不同。

## 一、先固定一次执行的身份

Checkpoint Saver（检查点保存器）通过三个配置字段定位历史：

| 字段 | 中文理解 | 作用 |
| --- | --- | --- |
| `thread_id` | 执行线 ID | 区分会话、订单或工作流实例 |
| `checkpoint_ns` | 检查点命名空间 | 区分父图、子图和子图调用路径 |
| `checkpoint_id` | 某个历史快照 ID | 选择最新点或指定旧点 |

最常见的调用只需要 `thread_id`：

```python
checkpointer = InMemorySaver()
graph = builder.compile(checkpointer=checkpointer)

config = {"configurable": {"thread_id": "order-42"}}
graph.invoke({"status": "draft"}, config)
```

相同 `thread_id` 表示同一条执行线。换一个 `thread_id`，Saver 会读取另一条历史。

`InMemorySaver.get_tuple()` 展示了查找顺序：

```python
# libs/checkpoint/langgraph/checkpoint/memory/__init__.py:250-255, 281-285
thread_id: str = config["configurable"]["thread_id"]
checkpoint_ns: str = config["configurable"].get("checkpoint_ns", "")

if checkpoint_id := get_checkpoint_id(config):
    if saved := self.storage[thread_id][checkpoint_ns].get(checkpoint_id):
        checkpoint, metadata, parent_checkpoint_id = saved
        writes = self.writes[(thread_id, checkpoint_ns, checkpoint_id)].values()
else:
    if checkpoints := self.storage[thread_id][checkpoint_ns]:
        checkpoint_id = max(checkpoints.keys())
        checkpoint, metadata, parent_checkpoint_id = checkpoints[checkpoint_id]
        writes = self.writes[(thread_id, checkpoint_ns, checkpoint_id)].values()
```

源码先看配置中是否指定 `checkpoint_id`。没有指定时，读取当前命名空间下的最新快照；指定后，读取那个历史点。`parent_config` 把当前快照和上一快照连接起来。

`checkpoint_ns` 在子图场景尤其重要。[第 05 篇](./05-subgraphs-and-cross-graph-control.md)中的子图会沿父图执行路径生成命名空间，查询子图状态时需要带上对应的 namespace。

## 二、Checkpoint 保存什么

`Checkpoint` 是某个时间点的状态快照；`CheckpointTuple` 把快照和查询、恢复所需的附加信息放在一起：

```python
# libs/checkpoint/langgraph/checkpoint/base/__init__.py:92-146
class Checkpoint(TypedDict):
    """State snapshot at a given point in time."""

    v: int
    id: str
    ts: str
    channel_values: dict[str, Any]
    channel_versions: ChannelVersions
    versions_seen: dict[str, ChannelVersions]
    updated_channels: list[str] | None


class CheckpointTuple(NamedTuple):
    config: RunnableConfig
    checkpoint: Checkpoint
    metadata: CheckpointMetadata
    parent_config: RunnableConfig | None = None
    pending_writes: list[PendingWrite] | None = None
```

各字段解决的问题不同：

| 字段 | 恢复用途 |
| --- | --- |
| `channel_values` | 恢复各 Channel 当前保存的值 |
| `channel_versions` | 记录各 Channel 的版本 |
| `versions_seen` | 判断节点已经读过哪些版本，决定下一步触发 |
| `updated_channels` | 标记本次快照更新过的 Channel |
| `metadata` | 记录 `input`、`loop`、`update`、`fork` 等快照来源和执行轮次 |
| `parent_config` | 沿历史链回到父快照 |
| `pending_writes` | 保存已写入 Saver、尚未并入当前快照的任务结果 |

`pending_writes` 属于 `CheckpointTuple` 的附加恢复信息，字段表中的 `Checkpoint` 本身不包含它。这个区别决定了"快照里的 State"和"任务已经产生但还没完成统一提交的写入"可以分开处理。

## 三、Saver 协议

`BaseCheckpointSaver` 定义了五个核心操作，不同存储后端（InMemory、SQLite、Postgres）实现同一组接口：

| 方法 | 作用 |
| --- | --- |
| `get_tuple(config)` | 读取一个快照及其 pending writes |
| `list(config, filter, limit)` | 按 thread、命名空间、时间查询历史 |
| `put(config, checkpoint, metadata)` | 保存完整 checkpoint |
| `put_writes(config, writes, task_id)` | 把任务中间写入挂到某个 checkpoint |
| `delete_thread(thread_id)` | 清理一条执行线的全部历史 |

## 四、什么时候保存 checkpoint

一次调用在两个时刻保存快照：

- **输入快照**（`source="input"`）：用户输入写入 `START` Channel 后，在 `_first()` 中保存
- **轮次快照**（`source="loop"`）：每轮 `after_tick()` 统一提交 writes 后保存

两个快照的保存都调用 `_put_checkpoint()`，内部走 Saver 的 `put()` 和 `put_writes()`。

## 五、两种恢复入口

```python
graph.invoke(Command(resume="approved"), config)  # 提供 interrupt 恢复值
graph.invoke(None, config)                         # 继续待处理任务
```

Runtime 通过 `PregelLoop._first()` 判断是否为恢复调用（`Command`、`input=None` 或相同 `run_id`），决定是新建执行线还是继续已有快照。`Command(resume=...)` 需要 checkpointer 将恢复值与 interrupt ID 绑定。

## 六、pending writes：恢复已完成任务的写入

一轮里可能出现这种结果：

```text
node_a 成功，产生 State 更新
node_b 失败或 interrupt
```

Saver 会把任务写入单独记录为 pending writes。这样恢复时可以保留 `node_a` 的成功结果，让 `node_b` 重新执行。

```python
# libs/langgraph/langgraph/pregel/_loop.py:736-749
def _reapply_writes_to_succeeded_nodes(
    self, tasks: Mapping[str, PregelExecutableTask]
) -> None:
    for tid, k, v in self.checkpoint_pending_writes:
        if k in (ERROR, ERROR_SOURCE_NODE, INTERRUPT, RESUME):
            continue
        if task := tasks.get(tid):
            task.writes.append((k, v))
```

控制信号会被跳过，成功任务的普通 State 写入会重新挂回对应 task。第 03 篇的 `apply_writes()` 随后把这些写入和本次恢复产生的新写入一起提交。

本地测试验证了这个边界：并行节点中一个节点成功、另一个节点重试失败时，恢复后成功节点只调用一次，失败节点继续尝试；`get_state()` 看到的最新状态会包含成功节点的写入。

注意两个查询视图：

```python
# libs/langgraph/langgraph/pregel/main.py:1428-1434
saved = checkpointer.get_tuple(config)
return self._prepare_state_snapshot(
    config,
    saved,
    recurse=checkpointer if subgraphs else None,
    apply_pending_writes=CONFIG_KEY_CHECKPOINT_ID not in config[CONF],
)
```

查询当前最新状态时，Runtime 会应用 pending writes；明确指定历史 `checkpoint_id` 时，返回该快照本身，不自动叠加后续 pending writes。

pending writes 只处理图内已记录的写入。HTTP 请求、扣费、发货、发邮件等外部副作用仍需要幂等键、业务事务或 outbox（待发送操作表）。

## 七、重放和分叉：从旧快照重新开始

`get_state_history()` 返回一条执行线的历史快照。先找到某个旧点，再决定是原样重放还是先修改状态：

```python
history = list(graph.get_state_history(config))
before_b = next(state for state in history if state.next == ("node_b",))

# replay：从旧点重新执行 node_b
graph.invoke(None, before_b.config)

# fork：先修改旧点的 State，再从新分支继续
fork_config = graph.update_state(before_b.config, {"value": ["x"]})
graph.invoke(None, fork_config)
```

两种操作的区别：

| 操作 | 入口 | 后续行为 |
| --- | --- | --- |
| 继续 | 当前执行线的最新配置 | 处理当前未完成任务或提供 resume 值 |
| 重放（replay，重执行旧点之后的任务） | 旧 checkpoint 配置 | 按旧状态重新执行后续节点 |
| 分叉（fork，从旧点创建新执行分支） | `update_state()` 返回的新配置 | 先写入修改，再执行后续节点 |

本地 time-travel（时间旅行）测试验证了三个结果：

- `before_b` 的 `next` 是 `("node_b",)` 时，重放只执行 `node_b`；
- 完成态快照的 `next == ()`，重放不会调用节点；
- 从同一个旧点创建两次 fork，两个分支互不影响。

`update_state()` 的公开入口很薄，实际工作交给批量状态更新：

```python
# libs/langgraph/langgraph/pregel/main.py:2515-2526
def update_state(
    self,
    config: RunnableConfig,
    values: dict[str, Any] | Any | None,
    as_node: str | None = None,
    task_id: str | None = None,
) -> RunnableConfig:
    return self.bulk_update_state(
        config,
        [[StateUpdate(values, as_node, task_id)]],
    )
```

`as_node` 用来指定这次手动更新模拟哪个节点产生；省略时，Runtime 会从最近更新状态的节点推断，存在歧义时会报错。这样分叉后的下一跳仍能沿原图结构计算。

## 八、Store：跨执行的业务数据

Store 按 `namespace + key` 组织业务数据（用户偏好、资料、索引），与 checkpoint 不同：

```text
Checkpoint  → thread_id + checkpoint_ns + checkpoint_id  → 图执行线的恢复历史
Store       → namespace + key                              → 跨执行共享，不参与图恢复
```

核心操作：`get(namespace, key)` / `put(namespace, key, value, index, ttl)` / `search(namespace, query)` / `delete(namespace, key)`。Store 中的数据不会自动进入 Graph State，是否读入 State 或 prompt 由节点逻辑决定。

## 工程判断

- **照搬**：为可恢复执行配置稳定的 `thread_id`，把 checkpoint 查询、状态历史和恢复入口保留在 Runtime 提供的协议内。
- **换实现**：生产环境根据事务、并发、备份和保留策略选择 Saver/Store 后端；业务数据需要查询、TTL 或向量检索时使用 Store。
- **别碰**：不要把 Store 当作任务完成记录，也不要把 checkpoint 当作长期业务数据库。
- **不适用时**：一次性、无恢复要求的短任务可以不配置 checkpointer；需要中断、重放或分叉时必须先建立可持久化的执行身份。

## 读完后应该能判断什么

- `thread_id`、`checkpoint_ns` 和 `checkpoint_id` 分别定位哪一层历史；
- `Checkpoint` 和 `CheckpointTuple` 各自保存什么；
- pending writes 如何让恢复跳过已经成功的任务；
- 继续、重放、分叉分别从哪个配置开始；
- `Store` 为什么适合跨执行业务数据，不能替代 checkpoint。
