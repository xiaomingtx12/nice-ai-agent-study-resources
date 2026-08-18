---
sidebar_position: 9
sidebar_label: 07 暂停、恢复与 interrupt
description: 追踪 LangGraph 如何暂停节点、匹配恢复值，以及静态中断边界如何与 checkpoint、thread_id 配合。
---

# LangGraph 源码 07：暂停、恢复与 interrupt

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - 动态中断和恢复：`libs/langgraph/langgraph/types.py`（`interrupt()`、`GraphInterrupt`）
> - 静态中断判断：`libs/langgraph/langgraph/pregel/_algo.py`（`should_interrupt()`）
> - 中断、恢复和轮次边界：`libs/langgraph/langgraph/pregel/_loop.py`（`_first()`、`tick()`、`after_tick()`）
> - 恢复入口：`libs/langgraph/langgraph/types.py`（`Command.resume`）

## 这一篇的主题

本篇追踪图的暂停与恢复机制——不是流式输出（那是[第 08 篇](./08-stream-system.md)的主题），而是：

> **图暂停后怎样恢复，节点为什么会从入口重跑，以及恢复值怎样匹配到正确的 interrupt。**

三套原语位于 Runtime 边界，职责不同：

```text
interrupt(value)
  → 节点主动暂停，向调用方暴露待处理事项

interrupt_before / interrupt_after
  → Runtime 在指定节点前后暂停

Command(resume=...)
  → 调用方把恢复值交还给暂停任务
```

中断恢复依赖[第 06 篇](./06-checkpoints-store-and-recovery.md)的 checkpointer、`thread_id` 和 checkpoint。

## 一、动态 `interrupt()`：节点主动暂停

最小用法：

```python
from typing_extensions import TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt


class State(TypedDict):
    draft: str
    approved: bool


def approve(state: State):
    decision = interrupt(
        {"draft": state["draft"], "question": "是否批准？"}
    )
    return {"approved": decision}


graph = (
    StateGraph(State)
    .add_node("approve", approve)
    .add_edge(START, "approve")
    .add_edge("approve", END)
    .compile(checkpointer=InMemorySaver())
)

config = {"configurable": {"thread_id": "review-42"}}
first = graph.invoke(
    {"draft": "release plan", "approved": False},
    config,
)
# first 暴露 interrupt 信息，approve 尚未返回 approved 更新

second = graph.invoke(Command(resume=True), config)
# {"draft": "release plan", "approved": True}
```

这段流程依赖两个条件：图配置了 checkpointer；恢复调用使用同一个 `thread_id`。`interrupt()` 负责抛出可恢复的暂停信号；`Command(resume=...)` 负责把恢复值送回同一条执行线。

## 二、`interrupt()` 为什么会让节点从入口重跑

Runtime 保存 checkpoint 和任务恢复信息，Python 函数调用栈会在本次运行结束后释放。恢复时，Runtime 重新调用节点，执行到同一个 `interrupt()` 位置后取恢复值。

源码核心逻辑如下：

```python
# libs/langgraph/langgraph/types.py:910-934
conf = get_config()["configurable"]
scratchpad = conf[CONFIG_KEY_SCRATCHPAD]
idx = scratchpad.interrupt_counter()

# 先读取这个任务之前已经匹配过的恢复值。
if scratchpad.resume:
    if idx < len(scratchpad.resume):
        conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
        return scratchpad.resume[idx]

# 再读取本次调用新提供的恢复值。
v = scratchpad.get_null_resume(True)
if v is not None:
    assert len(scratchpad.resume) == idx, (scratchpad.resume, idx)
    scratchpad.resume.append(v)
    conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
    return v

# 找不到恢复值时，抛出暂停信号。
raise GraphInterrupt(
    (
        Interrupt.from_ns(
            value=value,
            ns=conf[CONFIG_KEY_CHECKPOINT_NS],
        ),
    )
)
```

`scratchpad` 是任务暂存区，`interrupt_counter()` 为当前任务记录调用序号。恢复值按同一任务内的调用顺序匹配：

```python
def approve(state: State):
    draft = build_draft(state)
    decision = interrupt({"draft": draft})
    return {"approved": decision}
```

恢复后 `build_draft()` 会再次执行。放在第一次 `interrupt()` 前的外部副作用需要可重放，邮件、扣费、创建工单等操作应使用幂等键、事务或 outbox（待发送操作表）。

## 三、多个中断怎样匹配恢复值

同一任务内的多个 `interrupt()` 按调用顺序匹配。多个任务同时暂停时，调用方需要使用 interrupt ID 到恢复值的映射：

```python
graph.invoke(
    Command(
        resume={
            "interrupt-id-a": True,
            "interrupt-id-b": False,
        }
    ),
    config,
)
```

`PregelLoop._first()` 负责把 `Command.resume` 转成任务写入：

```python
# libs/langgraph/langgraph/pregel/_loop.py:902-931
if input_is_command:
    if (resume := cast(Command, self.input).resume) is not None:
        if not self.checkpointer:
            raise RuntimeError(
                "Cannot use Command(resume=...) without checkpointer"
            )

        if resume_is_map := (
            isinstance(resume, dict)
            and all(is_xxh3_128_hexdigest(k) for k in resume)
        ):
            self.config[CONF][CONFIG_KEY_RESUME_MAP] = resume
        else:
            if len(self._pending_interrupts()) > 1:
                raise RuntimeError(
                    "When there are multiple pending interrupts, "
                    "you must specify the interrupt id when resuming."
                )
```

匿名恢复值适合单个待处理中断。并行中断需要 ID 映射，Runtime 才能把值放回正确 task。

## 四、静态中断：在节点边界暂停

静态中断由节点名决定暂停位置：

```python
graph = builder.compile(
    checkpointer=checkpointer,
    interrupt_before=["send_email"],
)

result = graph.invoke(
    input_data,
    config,
    interrupt_after=["review"],
)
```

`interrupt_before` 在任务执行前检查，`interrupt_after` 在任务完成、State 提交和 checkpoint 保存后检查：

```python
# libs/langgraph/langgraph/pregel/_loop.py:666-671
if self.interrupt_before and should_interrupt(
    self.checkpoint,
    self.interrupt_before,
    self.tasks.values(),
):
    self.status = "interrupt_before"
    raise GraphInterrupt()
```

```python
# libs/langgraph/langgraph/pregel/_loop.py:719-724
if self.interrupt_after and should_interrupt(
    self.checkpoint,
    self.interrupt_after,
    self.tasks.values(),
):
    self.status = "interrupt_after"
    raise GraphInterrupt()
```

`should_interrupt()` 还会检查自上次静态中断后是否发生过 Channel 更新：

```python
# libs/langgraph/langgraph/pregel/_algo.py:155-185
seen = checkpoint["versions_seen"].get(INTERRUPT, {})
any_updates_since_prev_interrupt = any(
    version > seen.get(chan, null_version)
    for chan, version in checkpoint["channel_versions"].items()
)

return (
    [
        task
        for task in tasks
        if (
            (
                not task.config
                or TAG_HIDDEN not in task.config.get("tags", EMPTY_SEQ)
            )
            if interrupt_nodes == "*"
            else task.name in interrupt_nodes
        )
    ]
    if any_updates_since_prev_interrupt
    else []
)
```

选择方式：

| 需求 | 原语 |
| --- | --- |
| 固定在某个节点前审批 | `interrupt_before` |
| 固定在某个节点后观察结果 | `interrupt_after` |
| 节点运行到某个业务问题时暂停 | `interrupt(value)` |

`input()`、sleep 和长轮询会占用执行资源，也无法复用 checkpoint 的恢复边界。

## 五、恢复入口：`Command(resume=...)`

`Command` 还有 `update`、`goto` 和 `graph` 等控制字段；它们属于运行时控制流，统一放在[第 04 篇：条件边、`Send` 与 `Command`](./04-dynamic-routing-and-send.md)中。本篇只保留恢复入口：

```python
from langgraph.types import Command

# 单个待处理中断：直接提供恢复值
graph.invoke(Command(resume=True), config)

# 多个并行中断：按 interrupt ID 提供恢复值
graph.invoke(
    Command(
        resume={
            "interrupt-id-a": True,
            "interrupt-id-b": False,
        }
    ),
    config,
)
```

恢复调用的 `Command` 不是节点返回的“下一跳命令”。它是调用方传给 Runtime 的输入，Runtime 根据当前 checkpoint 中的 pending interrupts，把值写回对应任务；节点随后从入口重新执行，直到再次走到原来的 `interrupt()`。

## 六、选择表

| 需求 | 优先选择 |
| --- | --- |
| 固定在节点前暂停 | `interrupt_before` |
| 固定在节点后暂停 | `interrupt_after` |
| 节点中等待审批或补充输入 | `interrupt(value)` + `Command(resume=...)` |
| 多个任务同时暂停 | 带 interrupt ID 映射的 `Command(resume={...})` |
| 恢复暂停的节点 | `Command(resume=...)` |

## 工程判断

- **照搬**：把人工输入建模为 `interrupt()`，把恢复入口固定为同一 `thread_id` 下的 `Command(resume=...)`。
- **换实现**：审批前的计算保持可重放；不可重复的外部副作用放到确认后的独立节点。
- **别碰**：不要用长轮询占住节点，也不要用 `input()` 替代 `interrupt()`。
- **不适用时**：只需要固定节点边界时使用静态中断；需要把业务问题和上下文交给调用方时使用动态中断。

## 读完后应该能判断什么

- `interrupt()` 为什么暂停后会从节点入口重跑；
- 同一任务内的多个中断如何按顺序匹配，并行中断为什么需要 ID 映射；
- 静态中断在任务执行前后检查什么；
- `Command(resume=...)` 为什么是调用方的恢复输入，而不是节点内的下一跳；
- `input()`、sleep 为什么不能替代 interrupt。
