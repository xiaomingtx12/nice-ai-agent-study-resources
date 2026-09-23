---
sidebar_position: 7
sidebar_label: 05 Send 与动态控制流
description: 沿状态更新、控制写入和 TASKS 通道追踪动态派发，解释独立输入、共享状态合并与静态边叠加。
---

# LangGraph 源码 05：Send 和 Command 如何产生下一步任务

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 控制对象：`libs/langgraph/langgraph/types.py` → `Send`、`Command`。
> - 返回值拆解：`libs/langgraph/langgraph/graph/state.py` → `attach_node()`、`attach_branch()`、`_control_branch()`。
> - 派发任务：`libs/langgraph/langgraph/pregel/_algo.py` → `prepare_next_tasks()`、`prepare_push_task_send()`。

固定边可以表达“处理完就进入下一步”。如果待处理的主题数量到运行时才知道，想让同一个 worker 分别处理每个主题，就需要为每次调用提供不同输入。本篇从这个问题解释 `Send` 和 `Command`。

`Send` 描述一次“把独立输入交给指定节点”的调用；`Command` 描述状态更新和控制动作。它们本身不执行下游函数，而是由编译后的 writer 转换为通道写入，再由运行时准备任务。

两者的区别可以从输入理解：`Command(goto="worker")` 触发 worker 从图状态读取输入；`Command(goto=Send("worker", {"item": "A"}))` 则把 `{"item": "A"}` 直接作为本次 worker 的输入。后者适合按数据数量动态创建任务。

## 一、主题有几个，就派发几次 summarize

下面是完整应用示例。主图保存主题列表与汇总结果，summarize 每次只接收一个主题；这里用固定字符串生成摘要，便于观察派发与汇合，不依赖模型。

```python
import operator
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import START, END, StateGraph
from langgraph.types import Send

class State(TypedDict):
    topics: list[str]
    summaries: Annotated[list[str], operator.add]
    report: str

class WorkerInput(TypedDict):
    topic: str

def dispatch(state: State):
    if not state["topics"]:
        return "collect"  # 没有 worker 时，也要生成空结果。
    return [Send("summarize", {"topic": topic}) for topic in state["topics"]]

def summarize(state: WorkerInput):
    return {"summaries": [f"{state['topic']}：已整理"]}

def collect(state: State):
    return {"report": "；".join(sorted(state["summaries"])) or "没有主题"}

builder = StateGraph(State)
builder.add_node("summarize", summarize)
builder.add_node("collect", collect)
builder.add_conditional_edges(START, dispatch, ["summarize", "collect"])
builder.add_edge("summarize", "collect")
builder.add_edge("collect", END)
graph = builder.compile()
result = graph.invoke({"topics": ["A", "B"], "summaries": [], "report": ""})
assert result["report"] == "A：已整理；B：已整理"
empty = graph.invoke({"topics": [], "summaries": [], "report": ""})
assert empty["report"] == "没有主题"
```

`dispatch` 是条件路由函数，它的返回值用来选择下一步，不是业务状态更新。两份 Send 指向同一个节点定义，却携带不同的 `topic`；worker 返回的 `summaries` 则是主图字段，按列表拼接规则合并。

| 这次调用经过的位置 | 具体数据 | 接下来发生什么 |
| --- | --- | --- |
| dispatch 返回 | 两份 Send，参数分别为 A、B | 写入用于收集派发请求的 TASKS 通道 |
| 准备下一轮 | 两份 summarize 任务，各有自己的输入和 ID | Runner 可以并行执行 |
| summarize 返回 | `["A：已整理"]`、`["B：已整理"]` 两份字段更新 | 本轮结束后归并到 summaries |
| collect 输入 | 已合并的 summaries | 返回 report，再结束 |

如果 topics 为空，路由直接触发 collect。仅返回空 Send 列表不会让 summarize 执行，也不会自动触发它后面的 collect。

### 同时更新状态与选择下一步时，用 Command

示例中路由只选择目标，所以直接返回 Send。若一个业务节点还要写入审核结果，再决定去哪，就可以返回 Command；下面沿源码看它如何拆开处理。

### Command 的返回值被拆成两组写入

`Command` 的 `update` 携带状态更新，`goto` 携带目标节点名或 `Send`。例如一次审核返回 `Command(update={"approved": True}, goto="publish")` 时，运行时分别提取 `approved` 字段写入和 `branch:to:publish` 触发信号。

`attach_node()` 内的 `_get_updates()` 只保留图已登记的状态键；`_control_branch()` 再处理目的地：

源码：`libs/langgraph/langgraph/graph/state.py` → `_control_branch`（第 1745–1761 行节选；未展示部分省略）。

```python
rtn: list[tuple[str, Any]] = []
for command in commands:
    if command.graph == Command.PARENT:
        raise ParentCommand(command)

    goto_targets = (
        [command.goto] if isinstance(command.goto, (Send, str)) else command.goto
    )

    for go in goto_targets:
        if isinstance(go, Send):
            rtn.append((TASKS, go))
        elif isinstance(go, str) and go != END:
            # END 是结束标记，没有实际需要调度的节点。
            # 因此不生成指向 END 的触发写入。
            rtn.append((_CHANNEL_BRANCH_TO.format(go), None))
return rtn
```

这里的 `commands` 是从节点返回值中取出的命令集合，`rtn` 是即将交给运行时的通道写入列表。`TASKS` 是派发通道的内部名字，不是 Python 的任务线程池。

`_CHANNEL_BRANCH_TO.format(go)` 生成 `branch:to:<目标>`。字符串目标写入触发通道，`Send` 写入 `TASKS`；状态更新与控制写入一起进入当前任务的写入队列。字段更新仍受 reducer 约束，`Command` 不能绕过并行写冲突。

这里的 `END` 只是不再添加这条动态后继。**Command.goto 不会覆盖已有静态边。** 若 `review` 还有一条固定到 `audit` 的边，返回 `goto="publish"` 仍可能让两个节点都运行；`goto=END` 也不会取消固定边或其他活跃任务。

节点返回值经过状态转换和控制转换两层检查。虽然 `_control_branch()` 能识别裸 `Send`，普通多字段 StateGraph 的 `_get_updates()` 并不把裸 `Send` 当合法状态更新。因此节点动态派发应返回 `Command(goto=Send(...))`，或由条件路由返回 `Send`，不能只看一个内部函数便推断所有节点都能直接返回 `Send`。

## 二、Send 从通道中的数据变成独立任务

`Send(node, arg)` 包含目标名和本次输入，还可携带本次调用的超时策略。多份 `Send` 写入 `TASKS`，这是收集派发数据的 `Topic` 通道。下一轮 `prepare_next_tasks()` 遍历它，为每个下标创建 `(PUSH, idx)` 任务路径。

`prepare_push_task_send()` 根据路径重新取出数据包，确认类型和目标节点。套回示例，`sends` 是两份派发请求，`idx` 选中其中一份，`packet.node` 为 summarize，`packet.arg` 为单个主题字典；`processes` 则保存已编译的节点定义：

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `prepare_push_task_send`（第 964–979 行节选；未展示部分省略）。

```python
idx = cast(int, task_path[1])
if not channels[TASKS].is_available():
    return
sends: Sequence[Send] = channels[TASKS].get()
if idx < 0 or idx >= len(sends):
    return
packet = sends[idx]
if not isinstance(packet, Send):
    logger.warning(
        f"Ignoring invalid packet type {type(packet)} in pending sends"
    )
    return

if packet.node not in processes:
    logger.warning(f"Ignoring unknown node name {packet.node} in pending sends")
    return
```

这个基线的内部防御分支对无效包或未知节点记录警告并跳过，不保证所有动态拼错的目的地都在编译期报错。因此动态目标宜来自明确的节点集合，而不是未经检查的模型文本。

通过检查后，任务 ID 结合检查点、命名空间、轮次、目标名和派发下标生成。相同 worker 的两份 `Send` 拥有不同任务身份；恢复时可按身份匹配各自的结果。

同一函数第 1060 行开始构造 `PregelExecutableTask`（运行时任务记录），第二个参数直接传入 `packet.arg`。worker 不会自动得到所有主图字段；它要用到用户身份或业务参数，就必须由派发方显式带上或通过运行上下文提供。

PULL 与 PUSH 是调度来源的区别，不是线程与进程的区别，也不提供对象深拷贝或权限隔离。普通触发信号同轮可能合并成一个 PULL task，多份 `Send` 则保留各自的任务输入。

## 三、动态输入独立，输出仍汇入图状态

回到开头示例，条件路由为两个主题各发送一份 `Send("summarize", {"topic": ...})`，两个 worker 都返回 `{"summaries": [本次摘要]}`：

| 位置 | 保存的数据 | 作用 |
| --- | --- | --- |
| `TASKS` | 两份 `Send` | 下一轮创建两个任务 |
| 每个任务的 input | 单个主题 | 让同名 worker 处理不同工作 |
| 每个任务的 writes | 一份 `summaries` 更新 | 记录各自执行结果 |
| `summaries` 字段通道 | reducer 合并后的摘要集合 | 提供下游可读取状态 |

输出不会自动回填到 `Send.arg`，也不会为每个 worker 创建独立的 State 存储空间。两个任务写同一默认 `LastValue` 字段仍会冲突；收集多份摘要应定义相应 reducer。

同一超级步的 worker 都完成后，才能正常进入下一轮。若这些 worker 都通过普通边触发 `collect`，同轮触发会汇成一次普通下游调用。名字屏障不能按动态任务数量计数，`add_edge(["summarize"], "collect")` 不表示“等待任意 N 个独立分支全部结束”。

当动态分支跨不同轮次、还包含循环时，必须重新设计汇合条件，例如显式记录预期 ID 与完成 ID，或在适合“等全图其他工作耗尽”的情况下使用延迟节点。`Send` 数量为零时也不会凭空触发 worker 的后继，空输入路径要单独定义。

## 四、按输入和控制边界选择入口

`Command(graph=Command.PARENT, ...)` 将控制交给父图。上面的 `ParentCommand` 是传出该命令的内部控制异常；父子状态、命名空间和异常传播需要放在一起理解，完整链路见[子图篇](./08-subgraphs-and-cross-graph-control.md)。

`Command(resume=...)` 是另一个入口：由调用方向图传入恢复值，而非节点选择下一跳。它按中断身份匹配，详见[暂停与恢复](./07-interrupts-and-command.md)。固定依赖用边，动态独立输入用 `Send`，一次业务判断同时产生更新与下一跳时用 `Command`；选择依据应是数据与执行边界。
