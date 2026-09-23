---
sidebar_position: 9
sidebar_label: 07 中断与恢复协议
description: 沿 interrupt 信号、恢复值匹配和节点重跑解释人工暂停，区分静态断点、协作式停止与取消的继续条件。
---

# LangGraph 源码 07：人工输入如何接回执行过程

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 动态暂停：`libs/langgraph/langgraph/types.py` → `interrupt()`、`Interrupt`、`Command`。
> - 记录中断：`libs/langgraph/langgraph/pregel/_runner.py` → `PregelRunner.commit()`。
> - 恢复入口：`libs/langgraph/langgraph/pregel/_loop.py` → `_first()`、`_suppress_interrupt()`。
> - 恢复匹配与静态断点：`libs/langgraph/langgraph/pregel/_algo.py` → `_scratchpad()`、`should_interrupt()`。

审批节点里写了 `decision = interrupt(...)` 之后，本次图调用会带着待审批信息返回。稍后提交 `Command(resume=...)`，为什么节点会从头进入，interrupt 却能取到上次提交的答案？本篇沿这两次调用解释恢复值怎样找到原来的问题。

`interrupt(value)` 不会把 Python 函数挂在原地等待用户。它抛出运行时识别的控制信号，保存恢复信息并结束本次调用；恢复后节点从入口重新执行，在相同的中断位置取得调用方提供的值。协作式停止与取消则由执行中的外部控制触发，不要求节点先运行到一个审批问题。

`Interrupt` 是暴露给调用方的暂停记录，包含待处理数据和 ID；`Command(resume=...)` 是调用方提交恢复值的输入对象。恢复跨两次图调用发生，因此需要保存器、稳定的 `thread_id`，以及能按相同顺序重跑的节点逻辑。

建议先读[持久化篇](./06-checkpoints-store-and-recovery.md)，理解执行现场和任务写入怎样保存。本篇集中解释 `interrupt()` 与 `Command(resume=...)` 的跨调用协议；协作式停止和取消保留语义对照，底层实现分别见[执行循环篇](./03-pregel-supersteps-and-scheduling.md)与[任务执行篇](./04-pregel-task-execution.md)。

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

这里有三种数据，读源码时要分别找它们的去向：

| 数据 | 示例中的内容 | 谁负责保存或使用 |
| --- | --- | --- |
| 业务状态 | draft、approved=False | 字段通道与检查点；只有正常更新才修改 approved |
| 暂停记录 | 待审批草稿、问题、pending.id | 运行时记录，调用方据此展示审批事项 |
| 恢复值 | `{pending.id: True}` | 运行时匹配到该任务，供 interrupt 返回 |

`thread_id="review-42"` 让第二次调用找到原来的执行历史；`pending.id` 再定位这份历史里等待回答的中断。换一个 thread_id，不是在回答原问题。只传 `{"approved": True}` 也不是提交审批答案：那是普通状态输入，没有给 interrupt 提供所需的 resume 值。

把两次调用逐步展开，可以看到“继续”发生在哪一行：

| 时刻 | approve 函数执行到哪里 | 调用方能观察到什么 |
| --- | --- | --- |
| 第一次 invoke | 从入口进入，interrupt 找不到恢复值 | 抛出内部暂停信号，尚未执行 return |
| 第一次 invoke 返回 | 原来的函数栈已退出 | first 含暂停记录，可释放请求并等待用户 |
| 第二次 invoke | 按同一 thread 加载历史，从 approve 入口重跑 | 不需要保留上一次 Python 进程中的函数栈 |
| 再次执行 interrupt | 找到匹配恢复值，返回 True | decision=True，节点继续执行 return |
| 本轮提交 | 合并 `{"approved": True}` | second 中 approved 变为 True |

示例使用 InMemorySaver，只能在同一进程内演示；若需要重启服务后恢复，必须将检查点存到可跨进程读取的后端。节点从入口重跑的规则不因保存器不同而改变。

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

在第一次执行中，`idx=0`，恢复列表为空，代码走到底部的 GraphInterrupt。第二次执行时计数重新从 0 开始，而运行时已把回答放入该任务的恢复数据；代码在返回分支取得 True，所以这一次不会再抛出暂停信号。

`CONFIG_KEY_SEND` 指向当前任务的写入回调；向 `RESUME` 写入列表，是为了下一次重跑仍能记住之前已经回答的问题。它不会把审批值直接写进业务 State，只有节点返回的更新才会进入字段通道。

`GraphInterrupt` 是内部控制异常。Runner 的 `commit()` 将它转换为 `INTERRUPT` 控制写入，顶层 Loop 捕获并输出暂停信息；嵌套图继续向外传播。它不会按普通节点错误进入重试，也不应被业务代码的宽泛异常处理转换成“默认同意”。

## 三、多个中断有两层匹配

同一任务内按调用顺序匹配；不同任务之间按中断 ID 匹配。假设节点依次询问“确认内容”和“确认收件人”：

| 调用 | 本次完成或再次暂停后保存的恢复列表 | 重跑行为 |
| --- | --- | --- |
| 初次执行 | `[]` | 第 0 个中断没有值，暂停 |
| 第一次恢复 | `[内容确认值]` | 第 0 个取得本次提交值，第 1 个没有值，暂停 |
| 第二次恢复 | `[内容确认值, 收件人确认值]` | 第 0 个复用旧值，第 1 个取得新值，节点继续 |

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

## 六、停止与取消如何与中断区分

Agent 的“停止”发生在不同执行边界：人工审批暂停一个业务步骤，服务下线可以等当前轮次收尾，用户取消则可能要求打断正在执行的模型或工具调用。LangGraph 分别用中断记录、运行控制信号和执行器取消处理它们，恢复方式也不同。

| 意图 | 框架入口 | 停在哪里 | 继续执行的条件 |
| --- | --- | --- | --- |
| 等待审批或补充输入 | `interrupt(value)` | 节点内声明的业务位置 | 已保存现场，再传 `Command(resume=...)` |
| 固定节点前后调试 | `interrupt_before/after` | 轮次执行前或提交后 | 通常用 `invoke(None, config)` 继续 |
| 当前轮次收尾后停止 | `RunControl.request_drain()` | 后续一轮任务执行前 | 已保存现场，使用新的运行控制对象继续 |
| 尽快取消本次运行 | 异步任务取消、运行流 `abort()` | 执行代码可响应取消的位置 | 根据实际保存记录恢复，未完成节点可能重跑 |
| 超时或正常完成 | `TimeoutPolicy`、`END` 等 | 当前尝试失败，或图无后续任务 | 超时可能重试；正常完成没有待继续任务 |

`RunControl` 是控制一次图调用的对象。它的 `request_drain()` 请求当前工作收尾，Loop 在后续一轮执行前检查标志；调用方等图退出并完成必要保存后，才能确认停止。恢复依靠检查点，应省略旧控制对象或创建新对象，以同一执行线传入 `None` 继续。这里没有等待人工回答的中断记录，无需提交 `Command(resume=...)`。标志检查与退出异常见[执行循环篇](./03-pregel-supersteps-and-scheduling.md)。

取消异步执行任务或对运行流调用 `abort()`，会请求正在运行的工作退出。它能否及时完成取决于代码是否响应取消，能恢复到哪里取决于已经保存的结果；同步线程和远端副作用也有各自边界。执行器的取消与清理见[任务执行篇](./04-pregel-task-execution.md)，运行流的 `abort()` 见[流式事件篇](./09-stream-system.md)。

`TimeoutPolicy` 是节点尝试的时间限制，可约束总运行时间或无进展时间。监控任务超时后，运行时关闭该次尝试的受控写入入口、清除暂存写入、取消节点，再抛出 `NodeTimeoutError`。它随后仍可能匹配重试策略，所以一次超时不一定终止整次 Agent 调用；源码链路见[第 04 篇](./04-pregel-task-execution.md)。

`recursion_limit` 则限制超级步数量，耗尽后抛出 `GraphRecursionError`；它无法让正在阻塞的单个节点立即返回。正常结束由路由不再产生后继、最终没有可运行任务来表达。`END` 是结束标记，不是全局取消信号；某一分支到达 END 不会杀掉其他活跃任务，`Command(goto=END)` 也不会撤销已有的静态边。

应用需要分别处理暂停、受控停止、取消、超时失败和正常完成。将这些情况都记录为“成功”，会丢失是否仍有待执行任务、是否需要人工回答以及是否适合重试的信息。

## 七、停止按钮需要定位到一次具体运行

下面是基于这些执行边界的应用设计建议，不是 LangGraph 已实现的 HTTP 接口。服务端应将一次运行的标识关联到它的 control、异步任务或运行流对象；收到停止请求后，调用对应控制入口，并在执行退出与必要保存完成后更新运行状态。

| 产品交互 | 应用接入方式 | 何时可以报告停止完成 |
| --- | --- | --- |
| 停止并保留当前轮次结果 | `request_drain()`，同时具备保存器 | 图退出清理完成，已确认保存结果 |
| 尽快取消本次生成 | 取消实际图执行任务，或对持有的运行流调用 abort | 执行任务及受管理资源完成退出 |
| 等待审批后继续 | 展示中断记录，再按 ID 提交 resume 值 | 它是暂停状态，不能标记为业务完成 |

“已收到停止请求”与“已停止”应是不同阶段：前者可以立即返回，后者需要执行方确认。多进程部署还需要把请求传到持有运行对象的 worker；`RunControl` 是内存对象，本身不提供跨进程消息传递。

若应用规定“用户取消后永远不能继续”，应另存业务终止状态并校验后续恢复请求。一次取消只结束当前运行，不会自动删除 thread 的检查点，也不会把工作流永久封死。浏览器停止渲染 token 或断开事件连接同样只是展示、传输层动作，是否继续后台执行必须由应用明确决定。
