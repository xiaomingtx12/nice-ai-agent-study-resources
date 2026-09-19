---
sidebar_position: 6
sidebar_label: 04 Send 与 Command
description: 沿控制写入、TASKS 通道和任务准备追踪动态派发，并解释共享状态合并、静态边叠加与父图命令。
---

# LangGraph 源码 04：Send 和 Command 如何产生下一步任务

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 控制对象：`libs/langgraph/langgraph/types.py` → `Send`、`Command`。
> - 返回值拆解：`libs/langgraph/langgraph/graph/state.py` → `attach_node()`、`_control_branch()`。
> - 派发任务：`libs/langgraph/langgraph/pregel/_algo.py` → `prepare_next_tasks()`、`prepare_push_task_send()`。
> - 跨图命令：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry()`。

`Send` 描述一次“把独立输入交给指定节点”的调用；`Command` 描述状态更新和控制动作。它们本身不执行下游函数，而是由编译后的 writer 转换为通道写入，再由运行时准备任务。

两者的区别可以从输入理解：`Command(goto="worker")` 触发 worker 从图状态读取输入；`Command(goto=Send("worker", {"item": "A"}))` 则把 `{"item": "A"}` 直接作为本次 worker 的输入。后者适合按数据数量动态创建任务。

## 一、Command 的返回值被拆成两组写入

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

`_CHANNEL_BRANCH_TO.format(go)` 生成 `branch:to:<目标>`。字符串目标写入触发通道，`Send` 写入 `TASKS`；状态更新与控制写入一起进入当前任务的写入队列。字段更新仍受 reducer 约束，`Command` 不能绕过并行写冲突。

这里的 `END` 只是不再添加这条动态后继。**Command.goto 不会覆盖已有静态边。** 若 `review` 还有一条固定到 `audit` 的边，返回 `goto="publish"` 仍可能让两个节点都运行；`goto=END` 也不会取消固定边或其他活跃任务。

节点返回值经过状态转换和控制转换两层检查。虽然 `_control_branch()` 能识别裸 `Send`，普通多字段 StateGraph 的 `_get_updates()` 并不把裸 `Send` 当合法状态更新。因此节点动态派发应返回 `Command(goto=Send(...))`，或由条件路由返回 `Send`，不能只看一个内部函数便推断所有节点都能直接返回 `Send`。

## 二、Send 从通道中的数据变成独立任务

`Send(node, arg)` 包含目标名和本次输入，还可携带本次调用的超时策略。多份 `Send` 写入 `TASKS`，这是收集派发数据的 `Topic` 通道。下一轮 `prepare_next_tasks()` 遍历它，为每个下标创建 `(PUSH, idx)` 任务路径。

`prepare_push_task_send()` 根据路径重新取出数据包，确认类型和目标节点：

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

假设派发节点为两个主题各发送一份 `Send("summarize", {"topic": ...})`，两个 worker 都返回 `{"summaries": [本次摘要]}`：

| 位置 | 保存的数据 | 作用 |
| --- | --- | --- |
| `TASKS` | 两份 `Send` | 下一轮创建两个任务 |
| 每个任务的 input | 单个主题 | 让同名 worker 处理不同工作 |
| 每个任务的 writes | 一份 `summaries` 更新 | 记录各自执行结果 |
| `summaries` 字段通道 | reducer 合并后的摘要集合 | 提供下游可读取状态 |

输出不会自动回填到 `Send.arg`，也不会为每个 worker 创建独立的 State 存储空间。两个任务写同一默认 `LastValue` 字段仍会冲突；收集多份摘要应定义相应 reducer。

同一超级步的 worker 都完成后，才能正常进入下一轮。若这些 worker 都通过普通边触发 `collect`，同轮触发会汇成一次普通下游调用。名字屏障不能按动态任务数量计数，`add_edge(["summarize"], "collect")` 不表示“等待任意 N 个独立分支全部结束”。

当动态分支跨不同轮次、还包含循环时，必须重新设计汇合条件，例如显式记录预期 ID 与完成 ID，或在适合“等全图其他工作耗尽”的情况下使用延迟节点。`Send` 数量为零时也不会凭空触发 worker 的后继，空输入路径要单独定义。

## 四、Command.PARENT 沿调用边界向上传播

子图中的节点可以返回 `Command(graph=Command.PARENT, update=..., goto=...)`。子图的状态 writer 跳过这份更新，控制 writer 抛出 `ParentCommand`。它是内部控制异常，不代表业务节点失败。

`run_with_retry()` 沿图调用边界处理该异常：

源码：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry`（第 618–631 行节选；未展示部分省略）。

```python
except ParentCommand as exc:
    ns: str = config[CONF][CONFIG_KEY_CHECKPOINT_NS]
    cmd = exc.args[0]
    # 比较命名空间时去掉任务 ID，以匹配目标图。
    if cmd.graph in (ns, recast_checkpoint_ns(ns), task.name):
        # 命令属于当前边界，交给此任务的 writers 处理。
        for w in task.writers:
            w.invoke(cmd, config)
        break
    elif cmd.graph == Command.PARENT:
        # 将 PARENT 改写为具体父图命名空间。
        exc.args = (replace(cmd, graph=_checkpoint_ns_for_parent_command(ns)),)
    # 未到目标边界时继续向外传播。
    raise
```

到达目标边界后，父节点的 writers 处理命令，于是 `update` 按父图字段过滤并归并，`goto` 转换为父图触发信号。它没有在子图内部直接调用父图函数，也不做任意层级节点查找。

父图已有静态后继依然可能随 writers 一起执行。父子共享字段上的 reducer 也要按实际输出设计，尤其避免把已累计的完整列表再次作为增量返回。跨图接口最好只返回需要交给父图的结果或控制对象，减少两层对同一字段重复归并。

`Command(resume=...)` 是另一个入口：由调用方向图传入恢复值，而非节点选择下一跳。它按中断身份匹配，详见[暂停与恢复](./07-interrupts-and-command.md)。固定依赖用边，动态独立输入用 `Send`，一次业务判断同时产生更新与下一跳时用 `Command`；选择依据应是数据与执行边界。
