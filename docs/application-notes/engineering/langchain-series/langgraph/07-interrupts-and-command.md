---
sidebar_position: 9
sidebar_label: 07 中断、停止与恢复
description: 沿 interrupt、RunControl 和执行器退出路径解释人工暂停、协作式停止、任务取消，以及检查点恢复与外部副作用的边界。
---

# LangGraph 源码 07：Agent 如何中断、停止和恢复

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 动态暂停：`libs/langgraph/langgraph/types.py` → `interrupt()`、`Interrupt`、`Command`。
> - 记录中断：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.commit()`。
> - 恢复入口：`libs/langgraph/langgraph/pregel/_loop.py` → `_first()`、`_suppress_interrupt()`。
> - 恢复匹配与静态断点：`libs/langgraph/langgraph/pregel/_algo.py` → `_scratchpad()`、`should_interrupt()`。
> - 协作式停止：`libs/langgraph/langgraph/runtime.py` → `RunControl.request_drain()`；`libs/langgraph/langgraph/pregel/_loop.py` → `tick()`；`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream()`。
> - 取消与退出：`libs/langgraph/langgraph/pregel/_executor.py` → `BackgroundExecutor.__exit__()`、`AsyncBackgroundExecutor.__aexit__()`；`libs/langgraph/langgraph/errors.py` → `GraphDrained`、`NodeCancelledError`。

Agent 的“停止”发生在不同执行边界：人工审批暂停一个业务步骤，服务下线可以等当前轮次收尾，用户取消则可能要求打断正在执行的模型或工具调用。LangGraph 分别用中断记录、运行控制信号和执行器取消处理它们，恢复方式也不同。

| 意图 | 框架入口 | 停在哪里 | 继续执行的条件 |
| --- | --- | --- | --- |
| 等待审批或补充输入 | `interrupt(value)` | 节点内声明的业务位置 | 已保存现场，再传 `Command(resume=...)` |
| 固定节点前后调试 | `interrupt_before/after` | 轮次执行前或提交后 | 通常用 `invoke(None, config)` 继续 |
| 当前轮次收尾后停止 | `RunControl.request_drain()` | 后续一轮任务执行前 | 已保存现场，使用新的运行控制对象继续 |
| 尽快取消本次运行 | 异步任务取消、运行流 `abort()` | 执行代码可响应取消的位置 | 根据实际保存记录恢复，未完成节点可能重跑 |
| 超时或正常完成 | `TimeoutPolicy`、`END` 等 | 当前尝试失败，或图无后续任务 | 超时可能重试；正常完成没有待继续任务 |

`interrupt(value)` 不会把 Python 函数挂在原地等待用户。它抛出运行时识别的控制信号，保存恢复信息并结束本次调用；恢复后节点从入口重新执行，在相同的中断位置取得调用方提供的值。协作式停止与取消则由执行中的外部控制触发，不要求节点先运行到一个审批问题。

`Interrupt` 是暴露给调用方的暂停记录，包含待处理数据和 ID；`Command(resume=...)` 是调用方提交恢复值的输入对象。恢复跨两次图调用发生，因此需要保存器、稳定的 `thread_id`，以及能按相同顺序重跑的节点逻辑。

## 一、一次审批的状态变化

以下为完整应用示例，用来观察暂停前后的数据，不是框架实现片段：

```python
from typing_extensions import TypedDict
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, END, StateGraph
from langgraph.types import Command, interrupt

class State(TypedDict):
    draft: str
    approved: bool

def approve(state: State):
    decision = interrupt({"draft": state["draft"], "question": "是否批准？"})
    return {"approved": decision}

graph = (
    StateGraph(State)
    .add_node("approve", approve)
    .add_edge(START, "approve")
    .add_edge("approve", END)
    .compile(checkpointer=InMemorySaver())
)
config = {"configurable": {"thread_id": "review-42"}}
first = graph.invoke({"draft": "发布计划", "approved": False}, config)
pending = first["__interrupt__"][0]
second = graph.invoke(Command(resume={pending.id: True}), config)
# second == {"draft": "发布计划", "approved": True}
```

第一次调用中，`approve` 尚未返回状态更新，所以 `approved` 仍为 `False`；暂停数据另存为中断记录。第二次调用加载现场，重建 approve 任务，`interrupt()` 返回 `True`，节点才产生 `approved=True` 的正常写入。

示例使用默认的 v1 结果结构；其他流式版本可能把中断放在专门字段中。ID 应从实际返回的中断记录获取，不能用示意字符串代替真实 ID。

## 二、interrupt 根据调用序号取值或抛出信号

运行时为每个 task 注入 `PregelScratchpad`，即保存调用计数和恢复值的任务暂存区。`interrupt_counter()` 为本次重跑中的中断依次编号。

源码：`libs/langgraph/langgraph/types.py` → `interrupt`（第 910–934 行节选；未展示部分省略）。

```python
conf = get_config()["configurable"]
# 为本任务中的中断调用分配顺序索引。
scratchpad = conf[CONFIG_KEY_SCRATCHPAD]
idx = scratchpad.interrupt_counter()
# 重跑到已解决的中断时，直接返回对应的旧恢复值。
if scratchpad.resume:
    if idx < len(scratchpad.resume):
        conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
        return scratchpad.resume[idx]
# 消费本次提供的单个恢复值，并保存到任务恢复列表。
v = scratchpad.get_null_resume(True)
if v is not None:
    assert len(scratchpad.resume) == idx, (scratchpad.resume, idx)
    scratchpad.resume.append(v)
    conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
    return v
# 没有对应恢复值，抛出包含业务数据和命名空间身份的暂停信号。
raise GraphInterrupt(
    (
        Interrupt.from_ns(
            value=value,
            ns=conf[CONFIG_KEY_CHECKPOINT_NS],
        ),
    )
)
```

`CONFIG_KEY_SEND` 指向当前任务的写入回调；向 `RESUME` 写入列表，是为了下一次重跑仍能记住之前已经回答的问题。它不会把审批值直接写进业务 State，只有节点返回的更新才会进入字段通道。

`GraphInterrupt` 是内部控制异常。Runner 的 `commit()` 将它转换为 `INTERRUPT` 控制写入，顶层 Loop 捕获并输出暂停信息；嵌套图继续向外传播。它不会按普通节点错误进入重试，也不应被业务代码的宽泛异常处理转换成“默认同意”。

## 三、多个中断有两层匹配

同一任务内按调用顺序匹配；不同任务之间按中断 ID 匹配。假设节点依次询问“确认内容”和“确认收件人”：

| 调用 | 已保存恢复列表 | 重跑行为 |
| --- | --- | --- |
| 初次执行 | `[]` | 第 0 个中断没有值，暂停 |
| 第一次恢复 | `[内容确认值]` | 第 0 个直接返回旧值，第 1 个暂停 |
| 第二次恢复 | `[内容确认值, 收件人确认值]` | 两个位置都能返回，节点继续 |

若在恢复前改变条件分支，让第 0 个中断变成了另一道问题，旧值可能被用在错误的位置。因此中断的数量和顺序必须在重放时保持一致；中断前读取时间、随机数或不稳定外部数据，都可能改变控制路径。

并行节点同时暂停时，`Command(resume={interrupt_id: value, ...})` 指定每个任务的值。`_first()` 识别 ID 映射并放入运行配置；`_scratchpad()` 依据任务命名空间哈希找到对应值，将它追加到该任务的恢复列表。

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `_scratchpad`（第 1311–1314 行节选；未展示部分省略）。

```python
# 用当前任务命名空间对应的中断 ID 匹配恢复值。
if resume_map and namespace_hash in resume_map:
    mapped_resume_write = resume_map[namespace_hash]
    task_resume_write.append(mapped_resume_write)
```

单个待处理中断允许直接 `Command(resume=True)`。多个待处理中断却提交匿名值时，`_first()` 抛错，避免把回答交给错误任务。普通业务字典不一定被识别为 ID 映射：此基线检查键是否符合内部 ID 格式，应用应直接使用返回记录中的 ID。

`resume=None` 在此实现中表示没有提供恢复值。若业务答案可以为空，使用明确的结构，例如 `{"answer": None}`，避免把“空答案”和“未恢复”混为一谈。恢复值的业务类型和授权仍应由应用验证。

## 四、静态断点暂停在轮次边界

`interrupt_before=["publish"]` 在准备好本轮任务后、执行前检查；`interrupt_after=["review"]` 在本轮状态合并并创建检查点后检查。它们按节点名选择暂停位置，适合调试和固定断点，不需要节点内部调用 `interrupt()`。

源码：`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.tick`（第 666–671 行节选；未展示部分省略）。

```python
# 本轮任务执行前判断是否命中静态断点。
if self.interrupt_before and should_interrupt(
    self.checkpoint, self.interrupt_before, self.tasks.values()
):
    self.status = "interrupt_before"
    raise GraphInterrupt()
```

`should_interrupt()` 同时比较当前通道版本与上次中断时已记录的版本。继续执行时 Loop 将中断已读版本推进到当前值，避免对同一批未变化信号立刻再次暂停；后续循环产生新版本后，断点仍可能再次命中。

静态断点没有需要交给节点的问答值，通常以 `graph.invoke(None, config)` 继续。动态中断没有恢复值就仍会暂停，不能用 `None` 输入代替审批答案。

“before 某节点”也不是只冻结该节点、其余同轮节点照常执行的独立断点；检查位于 Loop 的轮次边界。若要表达业务审批，动态中断能明确给出问题、上下文与恢复值，通常比静态节点名更易维护。

## 五、重跑覆盖哪些代码

节点内位于 `interrupt()` 之前的代码会再次运行；多次暂停时，已经处理过的中断之前的代码仍会重跑。将扣费语句放在第一个中断后，也不能保证它不会在第二次恢复时再执行。

应将不可重复操作安排在有明确任务结果记录的步骤，并让外部系统支持幂等。检查点保存和外部副作用不是一个原子事务：操作完成后、成功结果尚未保存前仍可能崩溃。

包装函数调用子图时，子图中断会让父包装函数也从入口重跑；子图按自身命名空间恢复内部现场。中断参数和恢复值需要能被所用保存器序列化，不能把打开的连接、文件句柄或 Python 调用栈当作暂停数据。

`input()` 或等待用户的长轮询会占用进程资源，也无法表达这套跨调用恢复关系。`interrupt()` 将待办事项交回调用方，后续由新的调用加载执行现场，这是长时间人工介入可以脱离原执行进程的前提。

## 六、协作式停止让当前轮次收尾

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

`GraphDrained` 是携带停止原因的控制异常。它与 `GraphInterrupt` 不同：后者在顶层被转换为中断结果，前者会传给调用方；二者都属于 `GraphBubbleUp` 控制异常族，不作为普通节点服务错误进入重试。

### 2. 停止请求与停止完成之间还有一轮收尾

假设图的顺序是 `model → tools → model`，在 tools 执行期间请求停止：

| 时间点 | 执行动作 | 状态与下一步 |
| --- | --- | --- |
| tools 正在运行 | 外部调用 `request_drain()` | 控制标志改变，工具仍可继续 |
| 本轮任务完成 | Runner 记录结果，`after_tick()` 合并写入 | 工具结果进入已提交状态，准备检查点 |
| 下一次 `tick()` | 准备 model 任务后检查停止标志 | model 不交给 Runner 执行 |
| 退出清理完成 | 等待相应保存和资源退出，抛出 `GraphDrained` | 调用方才能确认这次运行已停止 |

同轮有多个任务时，要等本轮执行收束；其中某个失败或中断，仍按对应的异常路径退出，drain 不是覆盖所有退出原因的最高优先级开关。节点一直阻塞时，仅设置标志不能保证停止延迟。

当前任务为了完成自身逻辑，仍可以调用 `@task` 创建函数式子任务并等待它们。这条动态调度路径不经过下一超级步的 drain 检查，因此“停止后续轮次”不等于“请求后禁止创建任何任务”。它允许正在执行的入口收尾，代价是停止时间取决于当前工作及其依赖。

### 3. 恢复依靠检查点，停止标志属于本次运行

根图配置保存器、保存成功且退出清理完成后，可以使用相同执行线的 `graph.invoke(None, config)` 继续。刚才未执行的 model 会根据保存的通道版本重新准备，不需要 `Command(resume=...)`，因为这里没有等待回答的动态中断。

`RunControl` 为一次运行设计，调用 `request_drain()` 后没有自动复位逻辑。恢复时应省略旧控制对象或创建新对象，不能把已停止的 control 再传入，否则新运行仍可能在入口轮次被挡住。`thread_id` 标识可跨调用恢复的执行线，control 则控制其中某一次调用，不能混用生命周期。

`durability="exit"` 也有正常退出时的检查点保存路径，但进程被强制终止、保存失败或没有持久后端时，不能保证当前进度可恢复。具体保存时机见[第 06 篇](./06-checkpoints-store-and-recovery.md)。

## 七、运行中取消由执行器处理

需要尽快打断模型或工具调用时，应用可以取消承载图执行的异步任务，或使用[流式运行对象的 abort](./08-stream-system.md)。取消信号沿协程调用传播，运行时退出时由执行器取消其管理的任务并等待清理。

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

## 八、超时、预算耗尽与正常结束各有退出结果

`TimeoutPolicy` 是节点尝试的时间限制，可约束总运行时间或无进展时间。监控任务超时后，运行时关闭该次尝试的受控写入入口、清除暂存写入、取消节点，再抛出 `NodeTimeoutError`。它随后仍可能匹配重试策略，所以一次超时不一定终止整次 Agent 调用；源码链路见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)。

`recursion_limit` 则限制超级步数量，耗尽后抛出 `GraphRecursionError`；它无法让正在阻塞的单个节点立即返回。正常结束由路由不再产生后继、最终没有可运行任务来表达。`END` 是结束标记，不是全局取消信号；某一分支到达 END 不会杀掉其他活跃任务，`Command(goto=END)` 也不会撤销已有的静态边。

应用需要分别处理暂停、受控停止、取消、超时失败和正常完成。将这些情况都记录为“成功”，会丢失是否仍有待执行任务、是否需要人工回答以及是否适合重试的信息。

## 九、停止按钮需要定位到一次具体运行

下面是基于这些执行边界的应用设计建议，不是 LangGraph 已实现的 HTTP 接口。服务端应将一次运行的标识关联到它的 control、异步任务或运行流对象；收到停止请求后，调用对应控制入口，并在执行退出与必要保存完成后更新运行状态。

| 产品交互 | 应用接入方式 | 何时可以报告停止完成 |
| --- | --- | --- |
| 停止并保留当前轮次结果 | `request_drain()`，同时具备保存器 | 图退出清理完成，已确认保存结果 |
| 尽快取消本次生成 | 取消实际图执行任务，或对持有的运行流调用 abort | 执行任务及受管理资源完成退出 |
| 等待审批后继续 | 展示中断记录，再按 ID 提交 resume 值 | 它是暂停状态，不能标记为业务完成 |

“已收到停止请求”与“已停止”应是不同阶段：前者可以立即返回，后者需要执行方确认。多进程部署还需要把请求传到持有运行对象的 worker；`RunControl` 是内存对象，本身不提供跨进程消息传递。

若应用规定“用户取消后永远不能继续”，应另存业务终止状态并校验后续恢复请求。一次取消只结束当前运行，不会自动删除 thread 的检查点，也不会把工作流永久封死。浏览器停止渲染 token 或断开事件连接同样只是展示、传输层动作，是否继续后台执行必须由应用明确决定。
