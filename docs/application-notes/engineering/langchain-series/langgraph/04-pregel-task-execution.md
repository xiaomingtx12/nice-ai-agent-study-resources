---
sidebar_position: 6
sidebar_label: 04 任务执行、重试与取消
description: 沿 Runner、执行器、重试与超时追踪任务生命周期，解释成功记录、迟到写入、取消清理和恢复粒度。
---

# LangGraph 源码 04：任务如何并发执行、重试和取消

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 任务执行：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.tick()`、`atick()`、`commit()`、`_panic_or_proceed()`。
> - 重试与超时：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry()`、`_arun_with_timeout()`、`_TimedAttemptScope._guard_send()`。
> - 执行器退出：`libs/langgraph/langgraph/pregel/_executor.py` → `BackgroundExecutor.__exit__()`、`AsyncBackgroundExecutor.__aexit__()`。
> - 结果记录：`libs/langgraph/langgraph/pregel/_loop.py` → `put_writes()`。

Loop 已经决定这轮要调用哪些节点，接下来谁负责真正执行？如果两个节点同时运行，其中一个失败，谁来记录成功结果、重试失败调用并清理还没结束的工作？

这些工作由 `PregelRunner` 组织，后文简称 Runner。它接收 task，也就是“节点函数加上本次输入”的调用记录，再借助执行器运行函数。执行器负责线程或异步任务等底层执行安排，Runner 负责这些调用在图中的成功、失败和结果记录。

沿用 increment：节点只登记一次，每次运行会准备新的 task；如果这次 task 失败后按策略重试，框架重新尝试的是这次调用。**节点定义、一次调用、调用中的某次尝试，是三个层次。** 先把这三者分开，再看下面的并发、重试和超时分支。

## 一、先观察一个失败一次的节点

下面是完整应用示例。`RetryPolicy` 是节点的重试配置，指定什么异常可以重试、最多尝试几次。例子用一个计数器让第一次调用必定失败，不依赖网络服务：

```python
from typing_extensions import TypedDict
from langgraph.graph import START, END, StateGraph
from langgraph.types import RetryPolicy

class State(TypedDict):
    count: int

# 仅用于观察尝试次数，不属于图状态，也不作为恢复依据。
attempts = []

def increment(state: State):
    attempts.append(state["count"])
    if len(attempts) == 1:
        raise TimeoutError("演示第一次请求失败")
    return {"count": state["count"] + 1}

builder = StateGraph(State)
builder.add_node(
    "increment",
    increment,
    retry_policy=RetryPolicy(
        retry_on=TimeoutError,
        max_attempts=2,
        initial_interval=0,
        jitter=False,
    ),
)
builder.add_edge(START, "increment")
builder.add_edge("increment", END)
graph = builder.compile()
result = graph.invoke({"count": 0})
assert result == {"count": 1}
assert attempts == [0, 0]
```

第一次异常在同一次图调用里被重试策略处理，调用方无需再次 invoke。两次尝试都读到 count=0；第一次没有成功返回，第二次也不会以某个“失败后的 count”继续算。`max_attempts=2` 包含首次执行，即最多再试一次。关闭等待与随机抖动只是为了让这个演示立即完成。

| 层次 | 这个例子中有几个 | 源码中要找的对象 |
| --- | --- | --- |
| increment 节点定义 | 1 个 | 编译后的节点执行描述 |
| 本轮 increment 的任务 | 1 个 | 带输入、ID、写入队列的 task |
| 该任务的执行尝试 | 2 次 | `run_with_retry()` 内的循环 |

`attempts` 的变化不会被图回滚；这正好说明框架清理写入的范围。若把同样的位置换成发邮件，邮件也不会随重试自动撤销。

### 并发任务如何交给执行器

主循环跳过已有结果的任务，将剩余任务交给 `runner.tick()`。

普通多任务路径将任务交给执行器，使用 `FIRST_COMPLETED` 等待完成事件；单任务、无轮次超时且无流式等待器时有直接执行的快速路径。异步路径对应 `atick()`。同轮任务有并发资格，并不保证同时占用线程或连接，实际并发还受执行器和资源限制。

每次提交后台执行会得到 Future，它是“稍后可取得成功结果或异常”的句柄。下面的 `futures` 保存这些句柄与对应任务；`done` 是已经完成的一批，`inflight` 是还没完成的一批。`FIRST_COMPLETED` 表示一有调用完成就返回给 Runner 处理，不必在这里等全部完成。

源码：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.tick`（第 280–289 行节选；未展示部分省略）。

```python
# 整轮等待共用一个截止时间，不为每次等待重新计时。
end_time = timeout + time.monotonic() if timeout else None
handled_futures: set[concurrent.futures.Future[Any]] = set()
while len(futures) > (1 if get_waiter is not None else 0):
    done, inflight = concurrent.futures.wait(
        futures,
        return_when=concurrent.futures.FIRST_COMPLETED,
        timeout=(max(0, end_time - time.monotonic()) if end_time else None),
    )
    if not done:
        break  # 等待超时。
```

等待返回后，Runner 从任务表中取出已完成项，处理事件和错误；其余任务可以继续运行。轮次时间耗尽时先离开等待循环，再由后续分支取消未完成任务并报告超时。流式等待器也占据任务表中的一个位置，所以循环条件会将它单独扣除。

Runner 可以在一个任务完成时记录它的结果并输出事件，但不会因此提前把该任务的业务字段合并给同轮兄弟任务。`@task` 是将函数调用交给运行时的任务装饰器，其子任务可在父任务未结束时动态调度。`Send` 则描述携带独立输入的节点派发，经 `TASKS` 通道准备后续任务。两条调度路径分别在[函数式篇](./10-func-api-entrypoint-and-task.md)和[动态控制流篇](./05-dynamic-routing-and-send.md)展开，不能将所有 PUSH 都描述为“必须等下一超级步”。

## 二、重试清理暂存写入，不回滚外部副作用

### 1. 异常策略决定当前任务是否再试

`run_with_retry()` 是带重试策略的任务调用函数。下段代码里的 `task.proc` 是包装后的节点执行对象，`task.input` 是这次调用的输入，`task.writes` 暂存这次尝试产生的更新。套回 increment，就是以同一份输入重新调用它，并清掉上次失败尝试留下的更新。清掉的是框架内的暂存结果，已经发出的 HTTP 请求仍需业务自己处理。

下面先看真正调用节点的 `task.proc.invoke(task.input, config)`，再看异常如何选择重试策略：

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

在示例中，第一次 TimeoutError 匹配策略，失败次数变为 1，小于上限 2，于是再次进入 try；第二次返回 count=1，退出重试循环。没有匹配策略或耗尽次数时异常向外传播；符合策略时按退避间隔重跑当前任务。`GraphInterrupt` 和跨图控制信号有专门分支，不作为普通服务错误重试。

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

节点的 TimeoutPolicy 在此基线下要求异步执行，同步路径显式拒绝该配置。Runner 的 `step_timeout` 限制的是整轮等待，超时后 `_panic_or_proceed()` 请求取消尚未完成的任务并抛出超时错误。两者都不能强制终止已经运行的同步线程；执行器退出与工具取消的边界在本篇第四节展开。

## 三、commit 按任务身份记录结果

`PregelRunner.commit()` 在成功时将任务写入交给 Loop；没有字段写入也会补 `NO_WRITES` 标记，避免恢复时把“成功但无输出”误判为没运行：

源码：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.commit`（第 609–613 行节选；未展示部分省略）。

```python
if not task.writes:
    # 标记任务成功完成，即使它没有字段更新。
    task.writes.append((NO_WRITES, None))
# 按 task ID 记录写入，供恢复时匹配。
self.put_writes()(task.id, task.writes)  # type: ignore[misc]
```

因此，示例中的第二次尝试成功后，Runner 交给 Loop 的是这一 task 的 count=1 更新；直到本轮正常收尾，它才进入图的已提交状态。重试不会把两次尝试当成两个节点结果累加。

错误分支保存 `ERROR`，动态中断分支保存 `INTERRUPT` 和已有恢复值。这些都是控制记录，不由普通字段 reducer 合并。配置保存器时，Loop 可通过 `put_writes()` 保存任务结果；实际落盘时机还受持久化模式影响。

这一步记录任务结果，尚未把业务字段合并为下一版状态。轮次提交由 Loop 的 `after_tick()` 完成，见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)。

## 四、运行中取消由执行器处理

需要尽快打断模型或工具调用时，应用可以取消承载图执行的异步任务，或使用[流式运行对象的 abort](./09-stream-system.md)。取消信号沿协程调用传播，运行时退出时由执行器取消其管理的任务并等待清理。

`AsyncBackgroundExecutor` 是管理图内后台异步任务的上下文管理器，其退出路径如下：

源码：`libs/langgraph/langgraph/pregel/_executor.py` → `AsyncBackgroundExecutor.__aexit__`（第 192–200 行节选；未展示部分省略）。

```python
# 完成回调可能修改任务表，退出前先复制。
tasks = self.tasks.copy()
# 仅向标记为随运行退出而取消的任务发送取消请求。
for task, (cancel, _) in tasks.items():
    if cancel:
        task.cancel(self.sentinel)
# 等待任务完成取消或其他退出清理。
if tasks:
    await asyncio.wait(tasks)
```

`task.cancel()` 是取消请求，不是强制杀死代码。协程需要在可响应取消的位置收到 `CancelledError` 并退出；吞掉取消异常、长时间不让出事件循环或在同步调用中阻塞，都会影响停止时间。清理代码应释放连接等资源后继续传播取消，不能转换成成功结果。

同步的 `BackgroundExecutor.__exit__()` 也调用 Future 的 `cancel()`，但只能取消尚未开始的线程任务，并等待已经运行的任务结束。把一个同步 SDK 包装进线程池，并不会获得可强制终止的工具调用；严格停止要求还需要工具侧超时、取消协议或应用管理的隔离执行单元。

业务节点主动 `raise asyncio.CancelledError` 也不能当成成功终止 API。在能够识别取消来源的环境中，重试层会将节点自行抛出的取消转换成 `NodeCancelledError`（节点取消错误）并报告失败；框架发起的取消则继续沿清理路径传播。

取消中途不保证整轮字段已经提交。下一次执行只能从实际保存的检查点与成功任务写入恢复，未完成操作可能重跑。模型提供方已经开始的生成、远端已经接收的扣费或邮件请求，是否能取消取决于相应服务；本地图停止不会撤销已发生的外部副作用。

## 五、恢复粒度取决于任务边界

同轮 `left` 成功、`right` 失败时，保存器可保留 `left` 的 pending writes（待合并写入）。恢复后，Loop 按 task ID 挂回成功结果，过滤 `ERROR`、`INTERRUPT` 等控制记录，Runner 只执行仍无成功写入的任务。

完整检查点属于图的轮次，任务级恢复依赖独立身份及 `put_writes()`。`ToolNode` 是把一批工具调用封装为节点执行的组件：一个 ToolNode 内部并行十个工具时，图只看到一个任务；用十个 `Send` 派发时，图才能分别记录十个任务的结果。工具内部调用的实现见[第 11 篇](./11-prebuilt-tool-layer.md)。

需要独立恢复的操作适合拆成独立任务，但拆分增加调度和保存开销。无论怎样拆分，外部请求成功与成功写入保存之间仍有故障窗口，扣费、发信等操作需要稳定的业务幂等键。持久化模式和历史重放的区别见[第 06 篇](./06-checkpoints-store-and-recovery.md)。
