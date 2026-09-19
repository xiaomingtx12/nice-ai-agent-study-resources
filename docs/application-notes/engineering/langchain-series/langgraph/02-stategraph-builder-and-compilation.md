---
sidebar_position: 4
sidebar_label: 02 Builder 与编译
description: 追踪节点如何获得输入、写入和触发协议，解释普通边、等待边与条件路由的实际编译结果。
---

# LangGraph 源码 02：节点和边如何编译为读写协议

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 构建与编译：`libs/langgraph/langgraph/graph/state.py` → `add_node()`、`validate()`、`compile()`、`attach_node()`、`attach_edge()`、`attach_branch()`。
> - 条件路由：`libs/langgraph/langgraph/graph/_branch.py` → `BranchSpec._route()`、`_finish()`。
> - 写入转换：`libs/langgraph/langgraph/pregel/_write.py` → `ChannelWrite.do_write()`；局部读取：`libs/langgraph/langgraph/pregel/_algo.py` → `local_read()`。

`compile()` 将图声明转换为一组读写协议：节点从哪些通道取输入、什么信号能触发它、返回值写到哪些通道。运行时据此准备任务，不需要在每次节点结束时重新解释构建器里的边。

`StateGraph` 是保存声明的构建器。`StateNodeSpec` 保存一个节点的函数、输入结构和执行策略；编译生成的 `PregelNode` 则保存运行时所需的输入通道、触发通道、函数和 writer（输出写入器）。下面沿“登记节点 → 安装读写 → 安装边 → 执行输出”追踪转换。

## 一、add_node 保存函数与执行策略

`add_node("search", search)` 检查名称和保留字，将函数经 `coerce_to_runnable()` 转换为 Runnable。Runnable 是 LangChain Core 提供的统一调用接口，使普通函数和已经编译的图都能用 `invoke/ainvoke` 调用。

节点的输入结构优先采用显式 `input_schema`，未指定时采用从函数参数推断的结构，均没有时采用整图状态结构。登记时还保存重试、缓存、超时、错误处理器、延迟执行等配置。业务函数不会在登记或编译时运行。

源码：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.add_node`（第 872–883 行节选；未展示部分省略）。

```python
if input_schema is not None:
    self.nodes[node] = StateNodeSpec[NodeInputT, ContextT](
        coerce_to_runnable(action, name=node, trace=False),  # type: ignore[arg-type]
        metadata,
        input_schema=input_schema,
        retry_policy=retry_policy,
        cache_policy=cache_policy,
        error_handler_node=handler_node_name,
        ends=ends,
        defer=defer,
        timeout=timeout,
    )
```

该片段是显式传入输入结构时的真实分支。其后的两个分支处理推断结构和默认结构，生成的仍是 `StateNodeSpec`。`ends` 保存可声明的目的地信息，帮助静态分析和绘图，不会自行创建下一跳。

`compile()` 校验起点、终点、入口和静态中断节点，应用构建器的默认策略，再生成 `CompiledStateGraph`。它继承 `Pregel`，因此可直接执行。校验不证明循环必然结束，也不证明并行字段更新不会冲突；这些是运行时数据和 reducer 的约束。

## 二、attach_node 将节点拆成输入、函数与写入器

每个普通节点先得到一个 `branch:to:<节点名>` 通道，再订阅该通道：

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node`（第 1512–1533 行节选；未展示部分省略）。

```python
branch_channel = _CHANNEL_BRANCH_TO.format(key)
self.channels[branch_channel] = (
    LastValueAfterFinish(Any)
    if node.defer
    else EphemeralValue(Any, guard=False)
)
self.nodes[key] = PregelNode(
    triggers=[branch_channel],
    # 从输入结构选定的字段和托管值读取输入。
    channels=("__root__" if is_single_input else input_channels),
    # 需要时将字典转换成结构类，例如 Pydantic 模型。
    mapper=mapper,
    # 将节点返回值转换成状态写入和控制写入。
    writers=[ChannelWrite(write_entries)],
    metadata=node.metadata,
    retry_policy=node.retry_policy,
    cache_policy=node.cache_policy,
    is_error_handler=node.is_error_handler,
    error_handler_node=node.error_handler_node,
    bound=node.runnable,  # type: ignore[arg-type]
    timeout=node.timeout,
)
```

`channels` 和 `triggers` 必须分开理解。前者决定任务输入包含什么，后者决定节点何时运行。例如 `search` 可以读取 `question`、`user_id`，却只由 `branch:to:search` 触发；状态里 `user_id` 变化不自动调用 `search`。

默认触发通道采用 `EphemeralValue(guard=False)`，一轮允许多个信号，保存任一个即可。因此两个上游同轮都指向 `answer`，下一轮通常只产生一个 `answer` 的普通任务，而不是按边数调用两次。`defer=True` 使用 `LastValueAfterFinish`，等运行时暂时没有其他可触发任务时才开放读取，用于延迟汇总。

`write_entries` 内含两类转换：`_get_updates()` 提取状态更新，`_control_branch()` 提取 `Command` 等控制对象。`ChannelWrite` 再将这些结果交给任务配置里的写入回调，暂存在 task 的写入队列。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node._get_updates`（第 1443–1455 行节选；未展示部分省略）。

```python
def _get_updates(
    input: None | dict | Any,
) -> Sequence[tuple[str, Any]] | None:
    if input is None:
        return None
    elif isinstance(input, dict):
        return [(k, v) for k, v in input.items() if k in output_keys]
    elif isinstance(input, Command):
        if input.graph == Command.PARENT:
            return None
        return [
            (k, v) for k, v in input._update_as_tuples() if k in output_keys
        ]
```

普通节点允许写图中登记的字段，而不只限于自己的输入字段。字典中的未知 key 被过滤，`None` 表示不写状态；普通多字段图返回不支持的标量会抛出 `InvalidUpdateError`。因此拼错键可能静默丢失更新，输入结构也不能当成写权限系统。

`Command.PARENT` 在这里不写子图字段，它交给控制路径向父图传播，避免同一份更新被父子图各应用一次。

## 三、普通边只安装下一轮触发信号

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_edge`（第 1537–1545 行节选；未展示部分省略）。

```python
def attach_edge(self, starts: str | Sequence[str], end: str) -> None:
    if isinstance(starts, str):
        # 在上游节点上安装向目标触发通道写入的 writer。
        if end != END:
            self.nodes[starts].writers.append(
                ChannelWrite(
                    (ChannelWriteEntry(_CHANNEL_BRANCH_TO.format(end), None),)
                )
            )
```

`add_edge("load", "answer")` 在 `load` 的 writers 中追加一项，完成后写 `branch:to:answer`。信号在轮次提交后可见，下一轮准备 `answer`。它不把 `load` 的原始返回值直接作为 `answer` 参数；下游输入来自更新后的字段通道。

目标为 `END` 时不安装后继写入。`END` 是结束标记，不是需要运行的函数。一个分支结束也不等于取消同图其他已经就绪的分支。

## 四、等待边通过名字集合表达汇合

`add_edge(["search", "profile"], "answer")` 创建 `join:search+profile:answer` 通道，使用 `NamedBarrierValue` 记录预期的上游名字。`search` 写入自己的名字，`profile` 同样写入自己的名字，`answer` 订阅该屏障。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_edge`（第 1546–1561 行节选；未展示部分省略）。

```python
elif end != END:
    channel_name = f"join:{'+'.join(starts)}:{end}"
    # 为等待边建立普通屏障或延迟屏障。
    if self.builder.nodes[end].defer:
        self.channels[channel_name] = NamedBarrierValueAfterFinish(
            str, set(starts)
        )
    else:
        self.channels[channel_name] = NamedBarrierValue(str, set(starts))
    # 目标节点在屏障可读时获得运行资格。
    self.nodes[end].triggers.append(channel_name)
    # 每个上游用自己的节点名报到。
    for start in starts:
        self.nodes[start].writers.append(
            ChannelWrite((ChannelWriteEntry(channel_name, start),))
        )
```

普通屏障收齐集合才可读，消费后清空已到达集合。上游可以在不同轮次到达；屏障不按总写入次数计数，也不识别同名 worker 的每一个动态任务。因此两条独立普通边与一条等待边并不等价：前者允许任一上游触发，后者要求给定名字全部到齐。

汇合字段仍由各自 reducer 处理。即使屏障正确到齐，两个上游同轮覆盖同一个 `LastValue` 字段仍然会在提交时失败。

## 五、条件路由读取源节点更新后的局部状态

`add_conditional_edges("model", route)` 把路由函数保存在 `BranchSpec` 中。`BranchSpec` 负责调用路由、解析返回的目标并转换成写入；编译器通过 `branch.run()` 将它接在源节点的 writers 后面。

关键在于 `attach_branch()` 创建的 reader 使用 `fresh=True`。运行时的 `local_read()` 先收集当前 task 已暂存的更新，再在通道副本上应用这些更新：

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `local_read`（第 211–224 行节选；未展示部分省略）。

```python
if fresh:
    # 只应用当前任务的写入，构造局部通道视图。
    local_channels: dict[str, BaseChannel] = {}
    for k in channels:
        cc = channels[k].copy()
        cc.update(updated[k])
        local_channels[k] = cc
    # 路由读取包含源节点本次更新的值。
    values = read_channels(local_channels, select)
else:
    values = read_channels(channels, select)
if managed_keys:
    values.update({k: managed[k].get(scratchpad) for k in managed_keys})
return values
```

例如 `model` 刚返回一条带工具调用的消息，`route` 需要立即据此选择 `tools`。局部副本保证它能看到这条消息；其他并行节点的更新不在当前 task 的队列中，所以不会提前混进路由输入。副本读取也会调用 reducer，这进一步要求 reducer 不带外部副作用。

`BranchSpec._finish()` 将返回值规范化为目标列表。有 `path_map` 时先把业务标签映射到节点名；返回 `None` 或 `START` 会报错，`Send(END, ...)` 也被拒绝。普通节点名变成 `branch:to:<目标>` 写入，`Send` 则进入动态任务通道。

动态控制不会撤销静态边。若 `model` 已有一条固定到 `audit` 的边，又通过条件边选择 `tools`，两个目标都可能运行。需要互斥路由时应把互斥关系统一放在条件路由或 `Command.goto` 中，避免额外固定边绕过判断。

## 六、编译结果与运行状态的边界

构建器可以复用来生成新的编译结果，但修改构建器不会替旧编译结果重新安装节点和 writers。正常做法是完成声明后编译，再执行该对象。

编译产物保存的是可执行结构和通道定义，每次运行从输入或检查点恢复通道实例与版本。结构层决定允许的控制路径，状态层决定这次具体走哪条路径。通过这种分工，同一张图可以服务不同 `thread_id` 的执行；会话隔离和持久化后端的并发控制仍需调用方正确配置。
