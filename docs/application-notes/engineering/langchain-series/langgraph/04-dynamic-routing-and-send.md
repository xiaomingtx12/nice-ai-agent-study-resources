---
sidebar_position: 6
sidebar_label: 04 Send 与 Command：动态派发与控制信号
description: 集中理解 Send、Command 和 Command.PARENT 如何更新 State、创建动态任务、跨图返回控制，以及它们在 Runtime 中的共同落点。
---

# LangGraph 源码 04：`Send` 与 `Command`——动态派发与控制信号

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - `Send`、`Command` 定义：`libs/langgraph/langgraph/types.py`
> - 任务准备：`libs/langgraph/langgraph/pregel/_algo.py`（`prepare_next_tasks()`、`prepare_push_task_send()`）
> - 控制写入和 State 提取：`libs/langgraph/langgraph/graph/state.py`（`_control_branch()`、`attach_node()`）

## 这一篇的主题

第 02 篇负责图的节点、边和条件边声明；第 03 篇负责任务准备和统一提交。本篇只处理两个常用控制对象：

> **`Send` 如何把一次调用扩展为多个带独立输入的 task，`Command` 如何把 State 更新、下一跳和跨图控制放进一次返回值？**

两者都不会直接调用下游函数，而是先形成 Runtime write（运行时写入），下一轮再由 Pregel 创建 task：

```text
节点返回 Send 或 Command
  → State 更新写入字段 Channel
  → Command.goto 中的 Send 写入 TASKS
  → Command.goto 中的节点名写入目标触发 Channel
  → 下一轮准备 PULL task 或 PUSH task
```

本篇不展开普通边、等待边、条件边或 `BranchSpec`。只追踪 `Send` 进入 `TASKS` 后怎样变成 PUSH task，以及 `Command` 怎样复用同一条控制写入路径。

### 先用一张表固定边界

| 需要表达的关系 | 返回或配置 | Runtime 结果 |
| --- | --- | --- |
| 每份输入独立运行一次 worker | `Send("worker", arg)` | 写入 `TASKS`，worker 形成 PUSH task |
| 更新 State 后再选择目标 | `Command(update=..., goto=...)` | 同时写字段 Channel 和控制 Channel |
| 更新 State 后动态扇出 | `Command(update=..., goto=Send(...))` | 同时写字段 Channel 和 `TASKS` |
| 子图要求父图继续处理 | `Command(graph=Command.PARENT, ...)` | 父图接收这份控制描述 |
| 把审批值交还给已暂停任务 | 调用方传入 `Command(resume=...)` | Runtime 将恢复值匹配到 interrupt |

`Command(resume=...)` 的暂停、匹配和重放细节在[第 07 篇](./07-interrupts-and-command.md)；本篇重点是 `goto`、`Send` 与 `Command.PARENT` 怎样形成下一轮任务。

## 一、`Send`：一次派发创建多个独立调用

`Send` 是一次动态任务派发描述。它指定目标节点和本次调用的独立输入，节点可以通过 `Command(goto=...)` 一次创建多个 `Send`：

```python
from langgraph.types import Command, Send


def dispatch(state: OverallState):
    return Command(
        goto=[
            Send("generate_joke", {"subject": subject})
            for subject in state["subjects"]
        ],
    )
```

`subjects` 有两个元素时，`generate_joke` 会获得两个独立输入：

```text
dispatch(state)
  → Command(goto=[Send(...), Send(...)])
  → TASKS Channel
  → 两个 PUSH task
  → 每个 generate_joke(Send.arg)
```

每次调用都可以使用不同的 `arg`，不要求把整张主图 State 复制给目标节点。

`Send` 的核心源码如下：

```python
# libs/langgraph/langgraph/types.py:664-736
class Send:
    """A message or packet to send to a specific node in the graph."""

    __slots__ = ("node", "arg", "timeout")

    def __init__(
        self,
        /,
        node: str,
        arg: Any,
        *,
        timeout: float | timedelta | TimeoutPolicy | None = None,
    ) -> None:
        self.node = node
        self.arg = arg
        self.timeout = TimeoutPolicy.coerce(timeout)
```

`node` 是目标节点名，`arg` 是这次 PUSH task（派发型任务）的输入，`timeout` 可以为这次调用覆盖节点默认的超时策略。

### `Send` 先进入 `TASKS` Channel

节点控制写入逻辑会把 `Send` 写入 `TASKS`：

```python
# libs/langgraph/langgraph/graph/state.py:1735-1738
def _control_branch(value: Any) -> Sequence[tuple[str, Any]]:
    if isinstance(value, Send):
        return ((TASKS, value),)
```

`TASKS` 是一个 `Topic` Channel（发布订阅通道，详见[第 01 篇](./01-state-schema-channels-and-reducers.md)）。多份 `Send` 可以同时写入，消费者按序取出。下一轮由 `prepare_next_tasks()` 读取 `TASKS`，并为每个 packet（数据包）调用 `prepare_single_task()`：

```python
# libs/langgraph/langgraph/pregel/_algo.py:441-466
tasks_channel = cast(Topic[Send] | None, channels.get(TASKS))
if tasks_channel and tasks_channel.is_available():
    for idx, _ in enumerate(tasks_channel.get()):
        if task := prepare_single_task(
            (PUSH, idx),
            None,
            checkpoint=checkpoint,
            ...
        ):
            tasks.append(task)
```

### PULL task 和 PUSH task 有什么区别

| 任务类型 | 来源 | 输入 | 典型场景 |
| --- | --- | --- | --- |
| PULL task | 静态触发关系或 Channel 更新 | 图 State（按节点 input_schema 过滤） | 固定连接的下游节点 |
| PUSH task | `TASKS` Channel 中的 `Send` | `Send.arg` | 动态扇出、map/reduce |

两类任务都交给[第 03 篇](./03-pregel-supersteps-and-scheduling.md)的 `PregelRunner` 执行，差别在于输入来源。PUSH task 的输入不来自图 State，而是来自 `Send.arg`。

`prepare_push_task_send()` 会从 `TASKS` 取出 `Send`，检查目标节点，再使用 `packet.arg` 创建任务：

```python
# libs/langgraph/langgraph/pregel/_algo.py:961-1012
if len(task_path) == 2:
    # (PUSH, idx of pending send)
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
    proc = processes[packet.node]
    proc_node = proc.node
    if proc_node is None:
        return

    # 用目标节点、执行轮次和 packet 下标生成任务身份。
    triggers = PUSH_TRIGGER
    checkpoint_ns = (
        f"{parent_ns}{NS_SEP}{packet.node}" if parent_ns else packet.node
    )
    task_id = task_id_func(
        checkpoint_id_bytes,
        checkpoint_ns,
        str(step),
        packet.node,
        PUSH,
        str(idx),
    )
```

后续创建 `PregelExecutableTask` 时，源码把 `packet.arg` 作为任务输入，并把 `packet.timeout` 作为这次调用的超时覆盖值。`checkpoint_ns` 是 checkpoint namespace（检查点命名空间），用于区分父图、目标节点和具体任务。

## 二、`Command`：一次返回同时更新 State 和控制流

节点经常需要把一次业务判断产生的结果写回 State，同时决定下一步运行哪个节点。`Command` 是节点返回的控制对象，可以把 State 更新和下一跳放在同一个返回值中：

```python
# libs/langgraph/langgraph/types.py:759-808（节选）
@dataclass(**_DC_KWARGS)
class Command(Generic[N], ToolOutputMixin):
    graph: str | None = None
    update: Any | None = None
    resume: dict[str, Any] | Any | None = None
    goto: Send | Sequence[Send | N] | N = ()

    PARENT: ClassVar[Literal["__parent__"]] = "__parent__"
```

| 字段 | 作用 | Runtime 落点 |
| --- | --- | --- |
| `update` | 写入当前图的 State | 字段 Channel，仍受 reducer 约束 |
| `goto` | 指定一个或多个节点，或投递 `Send` | 目标触发 Channel 或 `TASKS` |
| `resume` | 为已有 `interrupt()` 提供恢复值 | 恢复写入和 interrupt 匹配逻辑 |
| `graph=Command.PARENT` | 把控制交给最近的父图 | 父图运行边界接收 `ParentCommand` |

### `update` 与 `goto` 由两条 Runtime 路径分别处理

```python
def review(state: State):
    return Command(
        update={"reviewed": True},
        goto="send_email",
    )
```

`attach_node()` 提取 `Command.update` 时，会过滤出当前图允许写入的字段；控制 writer 再处理 `goto`。所以 `reviewed` 仍按[第 01 篇](./01-state-schema-channels-and-reducers.md)的 Channel 和 reducer 规则合并，`send_email` 则在下一轮被调度。

`goto` 也可以携带 `Send`，把一次状态更新和动态扇出绑定起来：

```python
def plan(state: State):
    return Command(
        update={"planned": len(state["items"])},
        goto=[
            Send("worker", {"item": item})
            for item in state["items"]
        ],
    )
```

控制 writer 的关键分支如下：

```python
# libs/langgraph/langgraph/graph/state.py:1732-1758（节选）
def _control_branch(value: Any) -> Sequence[tuple[str, Any]]:
    if isinstance(value, Send):
        return ((TASKS, value),)

    commands: list[Command] = []
    if isinstance(value, Command):
        commands.append(value)

    rtn: list[tuple[str, Any]] = []
    for command in commands:
        if command.graph == Command.PARENT:
            raise ParentCommand(command)

        goto_targets = (
            [command.goto]
            if isinstance(command.goto, (Send, str))
            else command.goto
        )
        for go in goto_targets:
            if isinstance(go, Send):
                rtn.append((TASKS, go))
            elif isinstance(go, str) and go != END:
                rtn.append((_CHANNEL_BRANCH_TO.format(go), None))
    return rtn
```

原代码还处理了“多个控制对象组成的序列”，这里省略。`Command.goto` 的两个常用落点是：

```text
Command(goto="review")    → branch:to:review
Command(goto=Send(...))   → TASKS
```

两套 API 的入口不同，但都先形成 Runtime write，再由下一轮统一创建 task。节点仍然不直接调用下游函数。

### `Command.PARENT`：把控制交给父图

子图内部的节点需要更新父图 State，或让父图决定下一步时，可以返回：

```python
return Command(
    graph=Command.PARENT,
    update={"summary": "ready"},
    goto="review",
)
```

`_control_branch()` 遇到 `Command.PARENT` 会抛出 `ParentCommand`，交给父图运行边界处理。它不是对子图外任意节点的跨级调用：`update` 必须符合父图 State 字段规则，`goto` 必须是父图已注册节点。子图如何接入、父子 Schema 如何映射，见[第 05 篇](./05-subgraphs-and-cross-graph-control.md)。

## 三、动态扇出后，结果靠 reducer 合并

`Send` 创建多个任务，每个任务通过 State 字段写入结果。合并最终靠 reducer：

```text
Send("summarize", {...}) × N
  → N 个 PUSH task 各写 summaries
  → 字段 Channel 的 reducer 合并结果
```

`Send` 只负责创建调用；reducer 负责合并；等待边负责汇合时机。三者各司其职。等待边的声明与编译见[第 02 篇](./02-stategraph-builder-and-compilation.md)。

## 四、选择控制原语

| 业务关系 | 优先使用 | 详见 |
| --- | --- | --- |
| 每份输入各调用一次 worker | `Send` | 本篇 |
| 节点要同时更新 State 和决定下一跳 | `Command(update=..., goto=...)` | 本篇 |
| 子图要将更新和下一跳交还父图 | `Command(graph=Command.PARENT, ...)` | 本篇 |
| 恢复暂停的节点 | `Command(resume=...)` | [第 07 篇](./07-interrupts-and-command.md) |
| A 完成后固定进 B | 普通边 | [第 02 篇](./02-stategraph-builder-and-compilation.md) |
| 固定 A、B 完成后启动 C | 等待边 | [第 02 篇](./02-stategraph-builder-and-compilation.md) |
| 多份结果合并 | reducer | [第 01 篇](./01-state-schema-channels-and-reducers.md) |

## 工程判断

- **照搬**：让节点只返回 `dict`、`Send` 或 `Command` 等声明性结果；让 Runtime 统一创建任务和写入 Channel。
- **换实现**：节点要把一次业务判断的字段更新和跳转绑定起来时用 `Command`；动态扇出需要独立重试、恢复和观测时，用 `Send` 或 `Command(goto=Send(...))` 把每份工作提升到图 task。
- **别碰**：不要在节点函数里直接调用下游节点；不要把 `Command.PARENT` 当作绕过父图校验的捷径；不要用等待边替代 reducer。
- **不适用时**：固定的一对一触发关系应在 Builder 中声明，不需要用 `Command.goto` 模拟静态边。

## 读完后应该能判断什么

- `Command.goto="node"` 和 `Command.goto=Send(...)` 如何分别转换成目标 Channel 或 `TASKS` 写入；
- `Send` 如何进入 `TASKS` Channel，并变成带独立输入的 PUSH task；
- PULL task 和 PUSH task 的输入来源差异；
- `Command.update` 为什么仍受 State Channel 和 reducer 约束，`Command.PARENT` 为什么必须由父图接收；
- `Command` 为什么只是声明控制意图，真正的 task 仍由下一轮 Runtime 创建；
- map/reduce 中 Send、reducer 和等待边各自的职责边界。
