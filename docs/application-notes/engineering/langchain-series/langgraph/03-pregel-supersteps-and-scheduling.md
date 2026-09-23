---
sidebar_position: 5
sidebar_label: 03 执行循环与轮次提交
description: 沿触发版本、任务准备、执行交接和轮次提交理解状态可见性，并解释协作式停止如何让当前轮次收尾。
---

# LangGraph 源码 03：下一轮运行哪些任务，状态何时提交

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 主循环：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`。
> - 轮次管理：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.tick()`、`after_tick()`。
> - 任务与状态：`libs/langgraph/langgraph/pregel/_algo.py` → `prepare_next_tasks()`、`_triggers()`、`apply_writes()`。
> - 执行交接：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.tick()`。
> - 协作式停止：`libs/langgraph/langgraph/runtime.py` → `RunControl.request_drain()`；`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`。

第 00 篇的加一图只需要执行一次 increment；图里出现两个可并行节点时，`invoke()` 就得反复决定“这一轮运行谁，什么时候让下游读取结果”。本篇解释这个决定过程。

`Pregel` 是编译图继承的执行实现；一次调用进入它的 `stream()` 后，会创建管理本次进度的 `Loop` 和执行节点调用的 `Runner`。Loop 持有当前状态、待执行工作和轮次。它的 `tick()` 准备一轮任务，`after_tick()` 在这一轮结束后合并更新。

每个 task 是某个节点带着本次输入的一次调用记录。例如 increment 节点加上 `{"count": 0}` 的输入，就对应这次要执行的工作；`PregelExecutableTask` 是源码中这份记录的类型名。节点函数具体怎样被执行、失败怎样处理，留给[第 04 篇](./04-pregel-task-execution.md)。

先读前四节，跟完“准备调用 → 执行 → 合并”的正常过程。第五节再看外部要求停止时，循环在哪个位置收尾。

## 一、从一次汇合看状态何时变化

沿用[第 01 篇的完整示例](./01-state-schema-channels-and-reducers.md)：START 同时指向 left、right，两个节点分别返回一项 items，merge 用 `add_edge(["left", "right"], "merge")` 等待两者。这里不改图，换成调度器的视角看同一次调用。

即使 left 先完成，right 也不会因此获得包含 left 的新输入；merge 更不能提前开始。业务依赖写在边上，节点返回只表示这次任务产生了一份结果。忽略接收输入的隐藏 START 轮次后，变化如下：

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

下段代码只回答“这个节点有没有尚未处理的新信号”。`proc.triggers` 是该节点等待的信号通道；`channels[chan]` 找到一个通道；`versions` 记录信号的新旧版本，`seen` 记录这个节点上次处理到了哪个版本。可以把版本理解为更新序号，而不是业务字段的值。

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

用 left 的入口信号举例，下表的 v1、v2 只是表示新旧关系，真实版本格式由运行时和保存器决定：

| 检查时的情况 | `_triggers()` 判断 | 后续行为 |
| --- | --- | --- |
| 信号可读，left 从未读过 | 有新触发 | 准备 left 的任务 |
| 信号可读，当前 v1，left 已读 v1 | 没有更新 | 不因同一旧信号再运行 |
| 后续循环再次写信号，版本变为 v2 | v2 新于已读 v1 | 可以准备下一次 left 调用 |
| 临时信号已清空 | 不可读 | 即使留有版本记录也不触发 |

在 StateGraph 中，这里通常检查编译器生成的边信号，例如 `branch:to:left`。不是 items 一变，所有读取 items 的节点就自动运行；编译后的 triggers 才决定节点等哪些信号。

无任务时本轮循环结束。轮数超出限制时，`tick()` 将状态置为 `out_of_steps`，外层 `stream()` 抛出 `GraphRecursionError`。这里限制的是执行轮次，不是 Python 调用栈深度，也不是单个模型调用的 token 数。

准备出任务后，Loop 还会检查运行控制对象的 drain 请求和静态断点，再决定是否交给 Runner。协作式停止拦截的是下一轮执行，不会撤销刚刚完成轮次的提交；正常完成与停止请求同时出现时，无任务的完成判断优先。停止信号如何进入 Loop，在本篇第五节展开；静态断点见[第 07 篇](./07-interrupts-and-command.md)。

## 三、主循环把尚无结果的任务交给 Runner

准备出的任务放在 `loop.tasks` 中。`t.writes` 保存一个任务已有的结果记录，`not t.writes` 筛出仍需执行的任务。代码还会先匹配缓存结果，再把剩余任务交给 Runner；结果为什么可以复用，在第 06 篇展开。

下面的两个 tick 分属不同对象：`loop.tick()` 准备任务，`runner.tick(...)` 执行任务。

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

Runner 在任务完成时记录写入并输出事件。同轮兄弟任务仍读取各自准备时的输入；一个任务先完成，不会让其他任务立即读到它的新字段值。执行器怎样等待完成、处理失败和取消，见[任务执行篇](./04-pregel-task-execution.md)。

已有的成功写入或缓存结果可以让主循环跳过任务；跨调用怎样保存、匹配结果，在[持久化篇](./06-checkpoints-store-and-recovery.md)展开。这里先区分“任务已有结果”和“整轮状态已提交”。

## 四、after_tick 合并写入并推进状态

Runner 先按任务 ID 记录结果，具体协议见[第 04 篇](./04-pregel-task-execution.md)。本轮任务正常收束后，`after_tick()` 调用统一提交：

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

套回示例，left 的任务完成、items 变成合并后的列表、保存器写入检查点，是三个不同时间点：

| 位置 | 已完成什么 | 还不能据此断言什么 |
| --- | --- | --- |
| Runner 记录 left 的结果 | 得到 left 的更新，可能输出 updates 事件 | right 已成功、merge 已可运行 |
| `after_tick()` 应用本轮写入 | items 合并完成，下一轮可以读取 | 外部数据库中的检查点已保存成功 |
| 按持久化模式完成保存 | 保存器已有相应恢复记录 | 节点调用过的外部系统也参与了同一事务 |

“统一提交”表示正常调度的状态可见性边界，不是跨数据库的原子事务。reducer 抛错会中止本次推进，应用不应依赖失败调用留下的内存对象继续业务，而应依据保存器中可恢复的记录重新进入。

## 五、协作式停止让当前轮次收尾

`RunControl` 是一次图运行的控制对象，保存是否请求停止以及停止原因。drain（等待当前工作收尾的协作式停止）适合服务下线或允许当前操作完成的停止请求，不会直接取消正在执行的节点。

### 1. 请求先写入标志，再由 Loop 检查

调用方将控制对象通过 `invoke(..., control=control)` 或 `stream(..., control=control)` 传入。`Pregel.stream()` 将它放入节点运行上下文 `Runtime`，未显式指定的嵌套调用可继承父运行控制；Loop 从 Runtime 取得同一对象。节点也可通过 `runtime.drain_requested` 读取停止意图。

源码：`libs/langgraph/langgraph/runtime.py` → `RunControl.request_drain / drain_requested`（第 95–100 行节选；未展示部分省略）。

```python
def request_drain(self, reason: str = "shutdown") -> None:
    self._drain_reason = reason

@property
def drain_requested(self) -> bool:
    return self._drain_reason is not None
```

写入标志后，正在执行的任务不会跳出函数。`tick()` 在准备出下一轮任务后、交给 Runner 执行前检查它：

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.tick`（第 652–659 行节选；未展示部分省略）。

```python
# 没有后续任务时，按正常完成退出。
if not self.tasks:
    self.status = "done"
    return False

if self.control is not None and self.control.drain_requested:
    self.status = "draining"
    return False
```

检查顺序决定了一个边界：如果当前轮次已经是最后一轮，图正常完成，不必因为恰好收到停止请求就报告异常。存在后续任务时，Loop 标记 `draining`，外层入口将它转换为 `GraphDrained`，让调用方知道流程提前退出。

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 3012–3015 行节选；未展示部分省略）。

```python
elif loop.status == "draining":
    if loop.control is None:
        raise RuntimeError("Draining status requires run control")
    raise GraphDrained(loop.control.drain_reason or "shutdown")
```

`GraphDrained` 是携带停止原因的控制异常。`GraphBubbleUp` 是需传出当前任务的内部控制异常基类；`GraphDrained` 会传给调用方，不作为普通节点服务错误重试。人工暂停的 `GraphInterrupt` 在顶层转换为中断结果，具体区别见[第 07 篇](./07-interrupts-and-command.md)。

### 2. 停止请求与停止完成之间还有一轮收尾

假设图的顺序是 `model → tools → model`，在 tools 执行期间请求停止：

| 时间点 | 执行动作 | 状态与下一步 |
| --- | --- | --- |
| tools 正在运行 | 外部调用 `request_drain()` | 控制标志改变，工具仍可继续 |
| 本轮任务完成 | Runner 记录结果，`after_tick()` 合并写入 | 工具结果进入已提交状态，准备检查点 |
| 下一次 `tick()` | 准备 model 任务后检查停止标志 | model 不交给 Runner 执行 |
| 退出清理完成 | 等待相应保存和资源退出，抛出 `GraphDrained` | 调用方才能确认这次运行已停止 |

同轮有多个任务时，要等本轮执行收束；其中某个失败或中断，仍按对应的异常路径退出，drain 不是覆盖所有退出原因的最高优先级开关。节点一直阻塞时，仅设置标志不能保证停止延迟。

`@task` 是把函数调用转换为运行时任务的装饰器，详见[函数式篇](./10-func-api-entrypoint-and-task.md)。当前任务为了完成自身逻辑，仍可以创建这类子任务并等待它们。这条动态调度路径不经过下一超级步的 drain 检查，因此“停止后续轮次”不等于“请求后禁止创建任何任务”。它允许正在执行的入口收尾，代价是停止时间取决于当前工作及其依赖。

### 3. 恢复依靠检查点，停止标志属于本次运行

根图配置保存器、保存成功且退出清理完成后，可以使用相同执行线的 `graph.invoke(None, config)` 继续。刚才未执行的 model 会根据保存的通道版本重新准备，不需要 `Command(resume=...)`，因为这里没有等待回答的动态中断。

`RunControl` 为一次运行设计，调用 `request_drain()` 后没有自动复位逻辑。恢复时应省略旧控制对象或创建新对象，不能把已停止的 control 再传入，否则新运行仍可能在入口轮次被挡住。`thread_id` 标识可跨调用恢复的执行线，control 则控制其中某一次调用，不能混用生命周期。

`durability="exit"` 也有正常退出时的检查点保存路径，但进程被强制终止、保存失败或没有持久后端时，不能保证当前进度可恢复。具体保存时机见[第 06 篇](./06-checkpoints-store-and-recovery.md)。
