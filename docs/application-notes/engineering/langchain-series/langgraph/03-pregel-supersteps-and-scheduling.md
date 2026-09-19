---
sidebar_position: 5
sidebar_label: 03 Pregel 调度与提交
description: 沿任务准备、Runner、重试与超时、写入记录和轮次提交解释状态可见性、失败清理与恢复粒度。
---

# LangGraph 源码 03：一轮任务如何运行、失败和提交

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 主循环：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`。
> - 轮次管理：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.tick()`、`after_tick()`。
> - 任务与状态：`libs/langgraph/langgraph/pregel/_algo.py` → `prepare_next_tasks()`、`_triggers()`、`apply_writes()`。
> - 执行与重试：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.tick()`、`commit()`、`_panic_or_proceed()`；`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry()`、`_arun_with_timeout()`、`_TimedAttemptScope._guard_send()`。

Pregel 使用 superstep（超级步）组织图执行：先从已提交状态准备任务，再执行这些任务，收集写入，在轮次边界合并。任务完成与状态提交是两个时刻，检查点真正保存完成又是另一个时刻。

`PregelLoop` 管理轮数、通道和检查点，`PregelRunner` 负责执行任务并处理完成、重试和异常。`PregelExecutableTask` 是某次节点调用的运行记录，包含输入、调用对象、任务 ID、触发来源和写入队列；同一个节点可以有多个任务实例。

## 一、从一次汇合看状态何时变化

设 `left` 与 `right` 同轮运行，`items` 的 reducer 为列表拼接；`merge` 通过等待边依赖二者。忽略接收输入的隐藏 `START` 轮次后，变化如下：

| 时刻 | 任务行为 | 已提交 items | 待合并写入 |
| --- | --- | --- | --- |
| 第 N 轮准备 | 为 left、right 构造输入 | `[]` | 空 |
| left 完成 | 返回 `["left"]` | `[]` | left 的结果 |
| right 完成 | 返回 `["right"]` | `[]` | 两个任务的结果 |
| 第 N 轮提交 | reducer 合并，屏障收齐名字 | `["left", "right"]` | 已用于合并 |
| 第 N+1 轮准备 | 构造 merge 的输入 | 合并后的列表 | 新一轮队列 |

表中的局部值只是输入和结果推演，不是框架伪代码。列表的应用顺序由任务路径排序确定，不能将它理解为请求完成顺序。

## 二、tick 准备哪些任务

`stream()` 调用 `loop.tick()`，后者先检查轮次上限，再调用 `prepare_next_tasks()`。任务主要有两个来源：

| 来源 | 任务种类 | 输入来源 |
| --- | --- | --- |
| 普通边、条件边或屏障通道变为可触发 | PULL（按触发关系准备的任务） | 从字段通道按节点输入结构读取 |
| `TASKS` 通道中的 `Send` | PUSH（主动派发的任务） | `Send.arg` 中的独立输入 |

`prepare_next_tasks()` 用上一轮更新的通道及 `trigger_to_nodes` 反向索引缩小候选节点范围。候选不等于必定执行，还需检查通道是否可读、版本是否比该节点上次读过的更新：

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `_triggers`（第 1267–1277 行节选；未展示部分省略）。

```python
if seen is None:
    for chan in proc.triggers:
        if channels[chan].is_available():
            return True
else:
    for chan in proc.triggers:
        if channels[chan].is_available() and versions.get(  # type: ignore[operator]
            chan, null_version
        ) > seen.get(chan, null_version):
            return True
return False
```

`channel_versions` 记录通道当前版本，`versions_seen` 记录节点上次处理过的触发版本。只检查“通道里有值”会导致旧信号被反复消费；版本比较避免无新输入时再次运行。

无任务时本轮循环结束。轮数超出限制时，`tick()` 将状态置为 `out_of_steps`，外层 `stream()` 抛出 `GraphRecursionError`。这里限制的是执行轮次，不是 Python 调用栈深度，也不是单个模型调用的 token 数。

准备出任务后，Loop 还会检查运行控制对象的 drain 请求和静态断点，再决定是否交给 Runner。协作式停止拦截的是下一轮执行，不会撤销刚刚完成轮次的提交；正常完成与停止请求同时出现时，无任务的完成判断优先。停止信号如何进入 Loop，见[第 07 篇](./07-interrupts-and-command.md)。

## 三、Runner 执行尚无结果的任务

主循环在交给 Runner 前过滤已恢复结果或命中缓存的任务：

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 2964–2972 行节选；未展示部分省略）。

```python
while loop.tick():
    for task in loop.match_cached_writes():
        loop.output_writes(task.id, task.writes, cached=True)
    for _ in runner.tick(
        [t for t in loop.tasks.values() if not t.writes],
        timeout=self.step_timeout,
        get_waiter=get_waiter,
        schedule_task=loop.accept_push,
    ):
```

普通多任务路径将任务交给执行器，使用 `FIRST_COMPLETED` 等待完成事件；单任务、无轮次超时且无流式等待器时有直接执行的快速路径。异步路径对应 `atick()`。同轮任务有并发资格，并不保证同时占用线程或连接，实际并发还受执行器和资源限制。

Runner 可以在一个任务完成时记录它的结果并输出事件，但不会因此提前把该任务的业务字段合并给同轮兄弟任务。`@task` 这类函数式子任务还可在父任务未结束时动态调度，不能将所有 PUSH 都笼统描述为“必须等下一超级步”；`Send` 经 `TASKS` 派发和函数式调用的具体路径不同。

## 四、重试清理暂存写入，不回滚外部副作用

### 1. 异常策略决定当前任务是否再试

`run_with_retry()` 在每次尝试前清除该 task 上次留下的写入，再调用完整的节点执行对象：

源码：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry`（第 613–617、641–661 行节选；未展示部分省略）。

```python
try:
    # 丢弃上一次尝试的暂存写入。
    task.writes.clear()
    # 从入口重新执行当前任务。
    return task.proc.invoke(task.input, config)

# ……省略中间实现……

except Exception as exc:
    if SUPPORTS_EXC_NOTES:
        exc.add_note(f"During task with name '{task.name}' and id '{task.id}'")
    if not retry_policy:
        raise

    # 选择第一条匹配该异常的重试策略。
    matching_policy = None
    for policy in retry_policy:
        if _should_retry_on(policy, exc):
            matching_policy = policy
            break

    if not matching_policy:
        raise

    # attempts 记录失败次数，每次失败后增加。
    attempts += 1
    # 达到尝试上限时继续向外抛出异常。
    if attempts >= matching_policy.max_attempts:
        raise
```

没有匹配策略或耗尽次数时异常向外传播；符合策略时按退避间隔重跑当前任务。`GraphInterrupt` 和跨图控制信号有专门分支，不作为普通服务错误重试。

配置节点错误处理器时，Runner 可将失败转交处理器任务；没有处理器或处理仍失败时，运行会退出并尝试取消其余任务。取消不代表已经发出的 HTTP 请求撤销，也不能强制停止任意同步线程。

### 2. 超时先封住旧尝试的写入，再发出取消

`TimeoutPolicy` 是节点每次尝试的时间限制，`run_timeout` 限制总运行时间，`idle_timeout` 限制无进展时间。默认进展检测可以由模型回调、任务写入等活动刷新；选择 `refresh_on="heartbeat"` 时，需要节点显式调用 `runtime.heartbeat()`。节点没有输出 token，不一定就代表空闲。

异步重试层的 `_arun_with_timeout()` 同时等待节点任务和超时监控任务。监控先触发时，它会关闭本次尝试、清理暂存写入、取消节点，并抛出 `NodeTimeoutError`：

源码：`libs/langgraph/langgraph/pregel/_retry.py` → `_arun_with_timeout`（第 490–502 行节选；未展示部分省略）。

```python
except asyncio.TimeoutError as exc:
    elapsed = time.monotonic() - start
    scope.close()  # 关闭本次尝试的受控写入和子任务调度入口。
    task.writes.clear()  # 本次失败尝试的更新不用于正常提交。
    bg.cancel()  # 请求节点协程取消，不保证外部服务撤销操作。
    bg.add_done_callback(_drain_cancelled)
    raise NodeTimeoutError(
        task.name,
        elapsed,
        kind=kind,
        idle_timeout=idle_timeout_s,
        run_timeout=run_timeout_s,
    ) from exc
```

`_TimedAttemptScope` 是控制一次超时尝试是否仍可写入的内部对象。取消可能需要时间，甚至有用户代码吞掉取消信号；只调用 `cancel()`，旧尝试就可能在重试开始后继续返回写入。`scope.close()` 在锁内将 `_active` 设为 False，配合注入到配置里的写入包装器拒收这些迟到结果：

源码：`libs/langgraph/langgraph/pregel/_retry.py` → `_TimedAttemptScope._guard_send`（第 228–235 行节选；未展示部分省略）。

```python
def guarded_send(writes: Sequence[tuple[str, Any]]) -> None:
    with self._lock:
        if self._active:
            if writes and self._refresh_on == "auto":
                self._last_progress = time.monotonic()
            send(writes)

return guarded_send
```

同一尝试的函数式子任务调度入口也有活动检查，关闭后不再允许继续派发。这个约束保护的是运行时注入的写入和调用接口，不会拦住业务代码直接写数据库或修改共享对象。

`NodeTimeoutError` 进入普通错误策略后可能重试；每次重试重新开始一次受限尝试，因此节点超时上限不等于整次 Agent 调用的总耗时上限。调用方主动取消异步执行时，`CancelledError` 则继续传播到资源清理路径，不能当成普通可重试超时处理。

节点的 TimeoutPolicy 在此基线下要求异步执行，同步路径显式拒绝该配置。Runner 的 `step_timeout` 限制的是整轮等待，超时后 `_panic_or_proceed()` 请求取消尚未完成的任务并抛出超时错误。两者都不能强制终止已经运行的同步线程；执行器退出与工具取消的边界见[第 07 篇](./07-interrupts-and-command.md)。

## 五、commit 先记录任务结果，after_tick 再合并

`PregelRunner.commit()` 在成功时将任务写入交给 Loop；没有字段写入也会补 `NO_WRITES` 标记，避免恢复时把“成功但无输出”误判为没运行：

源码：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.commit`（第 609–613 行节选；未展示部分省略）。

```python
if not task.writes:
    # 标记任务成功完成，即使它没有字段更新。
    task.writes.append((NO_WRITES, None))
# 按 task ID 记录写入，供恢复时匹配。
self.put_writes()(task.id, task.writes)  # type: ignore[misc]
```

错误分支保存 `ERROR`，动态中断分支保存 `INTERRUPT` 和已有恢复值。这些都是控制记录，不由普通字段 reducer 合并。配置保存器时，Loop 可通过 `put_writes()` 保存任务结果；实际落盘时机还受持久化模式影响。

本轮任务正常收束后，`after_tick()` 调用统一提交：

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.after_tick`（第 691–698、713–718 行节选；未展示部分省略）。

```python
# 本轮任务完成后统一应用写入。
self.updated_channels = apply_writes(
    self.checkpoint,
    self.channels,
    self.tasks.values(),
    self.checkpointer_get_next_version,
    self.trigger_to_nodes,
)

# ……省略中间实现……

# 本轮写入已合并，清除待合并记录。
self.checkpoint_pending_writes.clear()
# 历史重放只在第一次 tick 强制重跑已有结果的任务。
self.is_replaying = False
# 为提交后的状态创建检查点。
self._put_checkpoint({"source": "loop"})
```

`apply_writes()` 按任务路径排序，更新节点已读版本，消费触发通道，再把业务写入按通道分组。通道的 `update()` 决定覆盖、合并或拒绝；没有新写入的临时通道也会收到空更新，以清除过期信号。暂时没有下一步任务时，还会通知支持 `finish()` 的通道，让延迟节点获得执行机会。

“统一提交”表示正常调度的状态可见性边界，不是跨数据库的原子事务。reducer 抛错会中止本次推进，应用不应依赖失败调用留下的内存对象继续业务，而应依据保存器中可恢复的记录重新进入。

## 六、恢复粒度取决于任务边界

同轮 `left` 成功、`right` 失败时，保存器可保留 `left` 的 pending writes（待合并写入）。恢复后，Loop 按 task ID 挂回成功结果，过滤 `ERROR`、`INTERRUPT` 等控制记录，Runner 只执行仍无成功写入的任务。

完整检查点属于图的轮次，**不是每个任务各存一份完整检查点**。任务级恢复依赖独立身份及 `put_writes()`。这也解释了两种工具并行的差异：一个 `ToolNode` 内部并行十个工具时，图只看到一个任务；用十个 `Send` 派发时，图才能分别记录十个任务的结果。

需要独立恢复的操作适合拆成独立任务，但拆分增加调度和保存开销。无论怎样拆分，外部请求成功与成功写入保存之间仍有故障窗口，扣费、发信等操作需要稳定的业务幂等键。持久化模式和历史重放的区别见[第 06 篇](./06-checkpoints-store-and-recovery.md)。
