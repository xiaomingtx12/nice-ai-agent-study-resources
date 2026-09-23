---
sidebar_position: 4
sidebar_label: 02 Builder 与编译
description: 从两节点图的 compile 与 invoke 出发，解释节点如何获得输入、触发条件和结果处理方式，再理解普通边、等待边与条件路由的使用边界。
---

# LangGraph 源码 02：compile 究竟给节点和边做了什么

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 声明与编译：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.add_node()`、`add_edge()`、`compile()`、`CompiledStateGraph.attach_node()`、`attach_edge()`、`attach_branch()`。
> - 执行链与写入：`libs/langgraph/langgraph/pregel/_read.py` → `PregelNode.node`；`libs/langgraph/langgraph/pregel/_write.py` → `ChannelWrite.do_write()`、`_assemble_writes()`。
> - 等待边：`libs/langgraph/langgraph/channels/named_barrier_value.py` → `NamedBarrierValue.update()`、`is_available()`、`consume()`。
> - 条件路由：`libs/langgraph/langgraph/graph/_branch.py` → `BranchSpec._route()`、`_finish()`。
> - 局部读取与任务输入：`libs/langgraph/langgraph/pregel/_algo.py` → `local_read()`、`_proc_input()`。

调用 `add_node()` 时，我们已经把函数交给了框架；调用 `add_edge()` 时，也已经说明了执行顺序。为什么还需要一次 `compile()`？

因为一个函数能被调用，还不足以说明它在图里该怎样运行。框架还需要知道：这次输入从哪里取，什么条件下调用它，返回结果怎样更新状态，又怎样让下一个节点开始工作。**`compile()` 把节点和边的声明装配成这些执行规则。业务函数要等到 `invoke()` 等执行入口中才会运行。**

下面用一张“加一，再生成结果说明”的图，跟踪这些规则如何产生。读完应当能解释两个现象：为什么下游收到的是合并后的状态，以及为什么两条普通边不能替代“等待两个上游”的关系。

## 一、从一段会写的代码开始

这是完整的应用示例，不是框架内部源码。我们只使用字典状态，不引入模型、工具、持久化和重试。

```python
from typing_extensions import TypedDict
from langgraph.graph import START, END, StateGraph

class State(TypedDict):
    count: int
    message: str

def increment(state: State):
    return {"count": state["count"] + 1}

def report(state: State):
    return {"message": f"当前计数为 {state['count']}"}

builder = StateGraph(State)
builder.add_node("increment", increment)
builder.add_node("report", report)
builder.add_edge(START, "increment")
builder.add_edge("increment", "report")
builder.add_edge("report", END)

graph = builder.compile()
result = graph.invoke({"count": 0, "message": ""})
# result == {"count": 1, "message": "当前计数为 1"}
```

`increment` 只返回 count 的更新；`report` 只返回 message 的更新。最终结果却保留了两个字段，因为节点返回的是局部更新，框架负责把它们合入状态。

把声明、编译和执行分开看，先不要追内部类名：

| 写到哪一步 | 已经确定的事情 | 尚未发生的事情 |
| --- | --- | --- |
| `add_node()`、`add_edge()` | 有哪些函数、字段和先后关系 | 还没有执行 increment 或 report |
| `compile()` | 节点怎样取输入、处理返回值，边怎样触发下游 | 还没有收到这次 count=0 的输入 |
| `invoke(...)` | 为本次输入执行节点，合并更新并返回结果 | 运行结束后才知道具体结果 |

这篇主要拆第二行，并用第三行检验编译规则的效果。

## 二、从“记下函数”到“装配可执行图”

### add_node 先保存节点描述

`add_node("increment", increment)` 会把节点名、函数、输入结构及执行配置保存在 `builder.nodes` 中。每个条目的类型叫 `StateNodeSpec`，它是“这个节点由哪个函数实现、采用哪些配置”的记录。

函数会经过 `coerce_to_runnable()` 包装。Runnable 是统一同步、异步调用方式的执行接口，包装后，框架可以用同一种调用方式处理普通函数和其他可执行对象。此时保存的是调用能力，并没有执行 increment。

节点从哪些字段取输入，也在这个阶段确定。显式传入 `input_schema` 时采用它；没有显式配置时，框架尝试从函数参数标注推断，再回退到整图状态结构。示例中的两个函数都声明了 `state: State`，所以都会读取 count 和 message。

### compile 将这些描述装进另一个对象

`compile()` 创建的对象叫 `CompiledStateGraph`，也就是返回给我们的 graph。它继承 `Pregel`；Pregel 在这里是提供 `invoke()`、`stream()` 等图执行逻辑的基类。编译器把字段通道、节点配置和触发关系交给这套运行时，运行时再按这些配置准备任务、执行函数和合并结果。

builder 中，`nodes` 按名字保存节点描述，`edges` 保存普通边的起点与终点，`waiting_edges` 保存需要同时等待的一组起点，`branches` 按源节点保存条件路由。编译会把这些声明转换成下表中的对象；下表是主例的配置说明，不是框架伪代码。

| 编译结果中的位置 | 主例对应内容 | 执行时怎样使用 |
| --- | --- | --- |
| `channels` | count、message 状态字段；START 输入通道；两个节点的触发通道 | 分别保存业务值、本次输入和待处理信号 |
| `nodes` | 隐藏 START、increment、report 的节点配置 | 为被触发的节点构造一次任务 |
| `input_channels` | START | 将 `invoke()` 的输入送入图 |
| `output_channels` | count、message | 完成后从这些字段读取返回值 |

主例没有单独指定输入或输出结构，所以对外读写都采用 State 的字段。若配置 `input_schema`、`output_schema`，编译器会据此选择入口可接收、出口可返回的字段；图内部仍可以拥有其他中间字段。

创建编译图后，`compile()` 按登记内容装配节点与边。下面的 `self` 是 builder，`compiled` 是即将返回的 graph：

源码：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.compile`，第 1360–1362、1378–1388 行。中间的输出类型转换配置省略。

```python
# 装配输入入口，再装配用户登记的节点。
compiled.attach_node(START, None)
for key, node in self.nodes.items():
    compiled.attach_node(key, node)

# ……省略输出类型转换配置……

for start, end in self.edges:
    compiled.attach_edge(start, end)

for starts, end in self.waiting_edges:
    compiled.attach_edge(starts, end)

for start, branches in self.branches.items():
    for name, branch in branches.items():
        compiled.attach_branch(start, name, branch)

return compiled.validate()
```

这里出现的三个方法分别处理三种声明：`attach_node()` 装配节点，`attach_edge()` 装配普通边或等待边，`attach_branch()` 装配条件路由。它们是编译阶段的内部方法，应用通常通过 `add_node()`、`add_edge()`、`add_conditional_edges()` 表达意图。

后面的几节就沿着这三种装配展开。每看到一个内部对象，都把它对应回示例里的 increment 或 report。

## 三、一个节点要配好输入、函数和返回值处理

`attach_node()` 会生成 `PregelNode`。这是供执行阶段读取的节点配置，保存函数、输入来源、触发条件和结果处理方式。它和 `StateNodeSpec` 的区别是：前者已经补齐执行规则，后者主要保存用户声明。

以 increment 为例，核心配置只有四项：

| 配置项 | increment 对应的内容 | 解决什么问题 |
| --- | --- | --- |
| `channels` | count、message 两个字段 | 从哪里构造函数输入 |
| `bound` | 包装后的 increment 函数 | 真正要调用什么 |
| `writers` | 提取返回字典中的字段更新 | 函数返回后怎样记录结果 |
| `triggers` | 指向 increment 的触发信号 | 什么情况下准备一次调用 |

Channel（通道）是保存某个值并处理更新的对象；这里的字段通道保存 count 或 message。writer（输出写入器）则负责处理节点返回值。writer 产生的“写入”会先被当前调用记录下来，不能直接理解成写数据库。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node`，第 1518–1533 行节选。元数据、重试、缓存、错误处理和超时参数省略。

```python
self.nodes[key] = PregelNode(
    # 收到指向该节点的信号后，才准备调用。
    triggers=[branch_channel],
    # 读取状态字段，以及由运行时计算并提供的辅助值。
    channels=("__root__" if is_single_input else input_channels),
    # 必要时将状态字典转换成结构类，例如 Pydantic 模型。
    mapper=mapper,
    # 将节点返回值转换成状态字段的写入。
    writers=[ChannelWrite(write_entries)],
    # ……省略元数据及执行策略参数……
    bound=node.runnable,  # type: ignore[arg-type]
    # ……省略超时参数……
)
```

`key` 是节点名；`input_channels` 是它要读的字段列表。示例使用普通多字段 State，所以关注这个列表即可，`__root__` 是单根值状态的另一条处理路径。`mapper` 负责输入类型转换，`bound` 则保存之前包装好的业务函数。

`ChannelWrite` 是 writer 的具体实现。它根据 `write_entries` 中的转换规则提取返回值，把更新交给执行阶段，而不会在编译时修改 count。

### 隐藏 START 把外部输入接进同一套写入流程

`compile()` 先创建名为 START 的临时输入通道，并把 `input_channels` 指向它。`attach_node(START, None)` 再为这个通道安装一个隐藏节点：

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node`，第 1494–1501 行。前面的写入规则定义和后面的普通节点分支省略。

```python
# 添加节点及输出通道。
if key == START:
    self.nodes[key] = PregelNode(
        tags=[TAG_HIDDEN],  # 内部入口节点带有隐藏标记。
        triggers=[START],  # 新输入到达后触发。
        channels=START,  # 读取这次调用传入的值。
        writers=[ChannelWrite(write_entries)],
    )
```

这个节点没有用户业务函数。它把输入交给 writer，按输入结构提取 count、message 更新；`START → increment` 普通边还会给它追加触发 increment 的写入。输入处理完成并合并后，increment 才能从状态通道读取到 count=0、message 为空字符串。入口处理和业务节点由此共用字段更新与边触发机制。

### 返回字典如何变成字段更新

increment 返回 `{"count": 1}` 后，`_get_updates()` 会从中提取已登记字段。这个辅助函数定义在 `attach_node()` 内部，并被配置到 writer 中。

它的参数名叫 `input`，但这里接到的是 **writer 的输入，也就是节点的返回值**；`output_keys` 是允许提取的状态字段集合。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node._get_updates`，第 1443–1449 行。处理控制对象和其他返回形式的分支省略。

```python
def _get_updates(
    input: None | dict | Any,
) -> Sequence[tuple[str, Any]] | None:
    if input is None:
        return None
    elif isinstance(input, dict):
        # 只提取图已登记的字段。
        return [(k, v) for k, v in input.items() if k in output_keys]
```

在这个例子中，提取结果是 `[("count", 1)]`。框架记录这次更新，等当前一轮执行结束后再合并状态。message 没有出现在返回字典里，因此保持原值。

这也直接影响代码怎么写：**节点通常只返回自己要更新的字段。** 把旧输入字典全部返回，会把并未修改的字段也作为更新再次提交；并行节点这样做时，可能产生原本不需要的字段冲突。合并规则在[第 01 篇](./01-state-schema-channels-and-reducers.md)展开。

另一个边界藏在 `if k in output_keys` 中：未知字段会被过滤。把 count 拼成 cuont，可能看不到状态变化，也未必得到拼写错误提示。节点的输入结构只限定它读到哪些字段；这里仍按图登记的可写字段提取更新，不能把 `input_schema` 当作写权限限制。

### writer 如何把更新交给当前任务

`ChannelWriteTupleEntry` 是一条“用转换函数提取多组通道更新”的规则；这里将 `_get_updates` 设为它的 `mapper`。`ChannelWrite` 运行时把节点返回值填入规则，`_assemble_writes()` 再调用 mapper，将结果整理成 `(通道名, 值)` 列表。

`ChannelWrite.do_write()` 最终调用运行时注入的写入函数：

源码：`libs/langgraph/langgraph/pregel/_write.py` → `ChannelWrite.do_write`，第 125–126 行。前面的写入合法性校验省略。

```python
# 从当前任务配置中取得写入函数，再交出整理好的更新。
write: TYPE_SEND = config[CONF][CONFIG_KEY_SEND]
write(_assemble_writes(writes))
```

`CONF`、`CONFIG_KEY_SEND` 是内部配置键，`TYPE_SEND` 表示接收一批通道更新的函数类型。正常任务准备时，`_algo.py` 把这里的写入函数设为 `writes.extend`：把更新追加到当前任务的队列。此时 count 通道仍保存旧值，整轮收尾时才会应用队列中的更新。任务准备、失败处理和提交的完整过程分别在第 03、04 篇展开。

业务函数和这些 writer 会由 `PregelNode.node` 组合成执行链。这个属性先取得整理后的 writers，再区分是否有业务函数：

源码：`libs/langgraph/langgraph/pregel/_read.py` → `PregelNode.node`，第 222–234 行。装饰器省略。

```python
def node(self) -> Runnable[Any, Any] | None:
    """取得组合了 bound 和 writers 的可执行对象。"""
    writers = self.flat_writers
    if self.bound is DEFAULT_BOUND and not writers:
        return None
    elif self.bound is DEFAULT_BOUND and len(writers) == 1:
        return writers[0]
    elif self.bound is DEFAULT_BOUND:
        return RunnableSeq(*writers)
    elif writers:
        return RunnableSeq(self.bound, *writers)
    else:
        return self.bound
```

`DEFAULT_BOUND` 表示没有配置业务函数，隐藏 START 就采用这条路径。`RunnableSeq` 是按顺序调用多个可执行对象的内部组合器；普通节点通过它先运行 `bound`，再执行 writers。`flat_writers` 会合并末尾相邻的 `ChannelWrite`，减少重复调用，但仍保留各项通道写入。

`ChannelWrite._write()` 记录更新后仍返回原输入，因此后续普通边、条件路由也能继续处理这次结果。条件路由读取本任务刚产生的更新，正是依赖前一个 writer 已经填好了这份队列。

## 四、边怎样让下游开始运行

现在 increment 已经知道怎样取输入和返回更新，但 report 为什么会接着运行？

编译器为每个普通节点准备一个触发通道。report 对应的名字是 `branch:to:report`，可以读成“有执行路径指向 report”。它保存的是触发标记；count、message 通道保存的才是业务数据。

### 临时信号为什么使用 EphemeralValue

`EphemeralValue` 是一个收到空更新时清除旧值的临时通道。它用于保存随执行轮次变化的触发标记；没有新写入时清除旧信号，而业务字段通常需要继续保留旧值。

下面的 `key` 若是 report，`branch_channel` 就是 `branch:to:report`。示例没有设置 `defer=True`，会进入 `else` 分支。另一分支的 `LastValueAfterFinish` 用于延迟节点，等运行时其他工作暂时耗尽后才开放读取。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_node`，第 1512–1517 行。

```python
branch_channel = _CHANNEL_BRANCH_TO.format(key)
self.channels[branch_channel] = (
    LastValueAfterFinish(Any)
    if node.defer
    else EphemeralValue(Any, guard=False)
)
```

`guard=False` 允许一轮收到多份触发写入；`Any` 是值类型标注。普通边写入的值为 `None`：这里的 None 仍然表示一个已经到达的信号，与“没有收到写入”不同。临时通道的具体更新规则见[第 01 篇](./01-state-schema-channels-and-reducers.md)。

### 普通边给上游追加一个触发下游的 writer

`add_edge("increment", "report")` 会让 `attach_edge()` 在 increment 的结果处理过程中追加一个动作：向 report 的触发通道写信号。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_edge`，第 1537–1545 行。

```python
def attach_edge(self, starts: str | Sequence[str], end: str) -> None:
    if isinstance(starts, str):
        # 接入上游：由它向下游的触发通道写入信号。
        if end != END:
            self.nodes[starts].writers.append(
                ChannelWrite(
                    (ChannelWriteEntry(_CHANNEL_BRANCH_TO.format(end), None),)
                )
            )
```

`starts` 是上游名 increment，`end` 是下游名 report。`ChannelWriteEntry` 描述一次通道写入，上面的两个参数指定“写入哪个通道”和“写入什么值”。

于是 increment 完成时产生两类记录：一类是 `("count", 1)` 这样的业务更新，另一类是写向 `branch:to:report` 的触发信号。信号让 report 获得运行资格，输入则从更新后的状态中重新读取。

**边表达执行依赖，下游参数来自状态。** 在本例中，report 收到 `{"count": 1, "message": ""}`，而非 increment 单独返回的 `{"count": 1}`。所以新增一条边时，应同时确认上游写了什么字段、下游需要读什么字段；连通执行顺序并不会自动完成字段映射。

目标为 `END` 时，这段代码不安装后继写入。END 是结束标记，没有一个同名业务函数要被调用；某条分支走到 END，也不会取消其他已经可以执行的分支。

## 五、回到 invoke，把编译结果走一遍

编译后的配置仍没有 count=0 这份本次输入。进入 `invoke()` 后，执行阶段才据此准备具体调用，源码把这样的调用记录称为 task。task 带着本次输入、调用身份和结果记录；前面的 `PregelNode` 则是它依据的节点配置。

这里无需先展开全部调度实现，只看示例的状态变化：

| 执行阶段 | 本次发生的动作 | 合并后的状态 |
| --- | --- | --- |
| 输入入口 | 隐藏的 START 处理输入，并产生指向 increment 的信号 | `{"count": 0, "message": ""}` |
| increment 所在轮次 | 从状态取输入，调用函数，记录 count 更新和 report 的触发信号 | `{"count": 1, "message": ""}` |
| report 所在轮次 | 从新状态取输入，调用函数，记录 message 更新 | `{"count": 1, "message": "当前计数为 1"}` |
| 没有后继任务 | 读取输出字段并返回 | 调用方得到最终结果 |

表格把 START 的内部输入处理合在第一行。正常图执行会等当前一轮任务收束后合并更新，再准备下一轮；它不会在 increment 刚返回时，就把返回字典直接塞给 report。

这条过程也说明了为什么“字段变化”与“节点运行”要分开配置：report 读取 count，但只有触发关系使它进入待执行范围。仅有一个节点更新 count，不会自动调用所有读取 count 的节点。触发版本检查和轮次提交见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)。

## 六、两个上游都连过来，是否就会等待它们

把顺序图扩展为并行处理时，最容易把两种声明混在一起。下面是应用配置片段，假设 left、right、report 已经登记。允许任一上游触发 report 时，可以写两条普通边：

```python
# 两条独立普通边：任一上游都可以触发 report。
builder.add_edge("left", "report")
builder.add_edge("right", "report")
```

如果必须等两个上游都完成，则改用一条等待边，不再添加上面的两条普通边：

```python
# 指定的两个上游都完成后再触发 report。
builder.add_edge(["left", "right"], "report")
```

两条普通边都会写向 `branch:to:report`。如果 left、right 恰好同轮完成，普通触发信号会合并，下一轮通常只准备一次 report。这个现象很像“等两个都完成”，但它没有记录“必须等 left 和 right”这项条件。

如果两个上游在不同轮次完成，第一条普通信号就可能使 report 提前运行，后来的信号还可能再次触发它。**需要等待指定上游全部完成时，应明确使用列表形式的等待边。**

等待边会创建 `NamedBarrierValue`。这是保存“预期名字”和“已经到达名字”的通道；barrier（屏障）在这里就是到齐才允许下游运行的条件。编译器让 left、right 分别写入自己的名字，并让 report 等待这个通道。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_edge`，第 1546–1561 行。保留完整的等待边装配分支。

```python
elif end != END:
    channel_name = f"join:{'+'.join(starts)}:{end}"
    # 注册屏障通道；延迟节点使用等待其他工作耗尽的变体。
    if self.builder.nodes[end].defer:
        self.channels[channel_name] = NamedBarrierValueAfterFinish(
            str, set(starts)
        )
    else:
        self.channels[channel_name] = NamedBarrierValue(str, set(starts))
    # 订阅通道：把屏障追加到下游的触发列表。
    self.nodes[end].triggers.append(channel_name)
    # 写入通道：每个上游完成时交出自己的名字。
    for start in starts:
        self.nodes[start].writers.append(
            ChannelWrite((ChannelWriteEntry(channel_name, start),))
        )
```

`NamedBarrierValueAfterFinish` 是给延迟节点使用的屏障变体，到齐后还要等待运行时通知其他工作已经耗尽。主例没有启用 defer，采用普通 `NamedBarrierValue`。通道名是 `join:left+right:report`：left 的 writer 写入自己的名字，right 也向同一通道写入自己的名字；通道的 `update()` 将这些名字加入 `seen` 集合。report 不需要逐个询问上游是否完成，调度器检查屏障是否可读即可。

真正决定是否到齐的代码很短：

源码：`libs/langgraph/langgraph/channels/named_barrier_value.py` → `NamedBarrierValue.is_available / consume`，第 74–81 行。

```python
def is_available(self) -> bool:
    # 已到达的名字与预期集合相等，才可以读取。
    return self.seen == self.names

def consume(self) -> bool:
    if self.seen == self.names:
        # 本次汇合被消费后复位，为后续汇合重新收集。
        self.seen = set()
        return True
    return False
```

`names` 保存 left、right 这两个预期名字，`seen` 保存已经报到的名字。因此 left 报到两次不能代替 right；上游可以分轮到达，但这个集合也不会替你统计同名 worker 的多个动态任务。按输入数量派发工作时，应继续看[第 05 篇](./05-dynamic-routing-and-send.md)的汇合边界。

屏障是追加到 report 的触发列表中的，原有 `branch:to:report` 仍然存在。运行时只要发现一个可用的新触发就能准备 report，所以另外一条普通边或条件路由仍可提前触发它。需要严格汇合时，应检查 report 的全部入口，而不只是补上一条等待边。

等待条件和状态合并仍是两件事。即使两边按要求到齐，如果它们同轮覆盖同一个未配置 reducer 的字段，状态合并仍可能报错。等待边解决“什么时候运行”，reducer（归并函数）解决“多份更新怎样合成新值”。

## 七、条件路由怎样看到节点刚产生的结果

再回到主例。如果希望 increment 后按 count 决定是否进入 report，可以在编译前，用下面的配置替换原来的 `add_edge("increment", "report")`。这是应用代码变体，其他节点与边保持原来的声明。

```python
def route(state: State):
    return "report" if state["count"] >= 1 else END

builder.add_conditional_edges("increment", route)
```

输入 count=0 时，increment 返回 count=1，route 应据此进入 report。此时源节点的更新可能尚未完成整轮合并，路由为什么能看到 1？

`add_conditional_edges()` 先把路由函数保存为 `BranchSpec`，即负责调用路由、解释返回目标的分支描述。`attach_branch()` 把它接到源节点的结果处理过程中，并配置一个 `fresh=True` 的状态读取函数。

源码：`libs/langgraph/langgraph/graph/state.py` → `CompiledStateGraph.attach_branch`，第 1599–1610 行。字段选择、类型转换器的准备过程，以及不配置 reader 时的分支省略。

```python
reader: Callable[[RunnableConfig], Any] | None = partial(
    ChannelRead.do_read,
    select=channels[0] if channels == ["__root__"] else channels,
    fresh=True,
    # 将状态字典转换成结构类，例如 Pydantic 模型。
    mapper=mapper,
)
# ……省略不配置 reader 时的分支……
# 把分支发布器接到源节点的 writers 中。
self.nodes[start].writers.append(branch.run(get_writes, reader))
```

`ChannelRead.do_read()` 是从当前运行中读取指定状态的入口；`partial()` 预先绑定字段、fresh 和类型转换参数，得到供路由调用的 reader。`branch.run()` 包装“读取状态 → 调用 route → 处理目标”的过程，并把它作为源节点的一个 writer。route 因此在 increment 的返回值处理阶段运行，不会为自己单独占用下一轮节点任务。

这里的 fresh 表示“读入源节点本次更新后的值”。实际读取由 `local_read()` 完成：它收集当前 task 的更新，在通道副本上应用这些更新，再把新值交给路由。

下段代码中的 `channels` 是原状态通道，`updated[k]` 是源节点对字段 k 的更新列表，`select` 是路由要读取的字段。`BaseChannel` 是各类通道共同遵守的接口。

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `local_read`，第 211–219 行。前面收集当前任务更新、后面处理普通读取及返回值的代码省略。

```python
if fresh:
    # 将本任务的更新应用到通道副本。
    local_channels: dict[str, BaseChannel] = {}
    for k in channels:
        cc = channels[k].copy()
        cc.update(updated[k])
        local_channels[k] = cc
    # 从副本中读取包含本次更新的值。
    values = read_channels(local_channels, select)
```

对本例，原值 count=0 加上当前更新 count=1，使 route 读到 1。其他并行节点的更新没有混入当前任务的更新列表，因此不能把这个局部读取当成“全图所有并行工作都已完成”。

### 路由返回的名字如何触发下游

`BranchSpec._route()` 用 reader 得到状态，再调用包装后的 route。`_finish()` 将返回值统一成目标列表：没有配置 `path_map` 时，字符串直接表示节点名；有映射时，先将业务标签换成节点名。例如 `path_map={"ready": "report", "done": END}` 允许 route 返回 ready，而不必直接返回 report。

`attach_branch()` 中的 `get_writes()` 接收目标列表，将 report 转为写向 `branch:to:report` 的标记；END 被过滤，不产生后继写入。`_finish()` 再通过前面同一个 `ChannelWrite.do_write()` 把这些写入记入当前任务。目标是 `Send`（携带目标节点和独立输入的派发对象）时会保留独立输入，交给第 05 篇介绍的动态派发机制。

所以本例的整条链是：increment 返回 count=1 → 字段 writer 暂存 count 更新 → reader 在通道副本上应用它 → route 读到 1 并返回 report → 分支 writer 暂存 report 的触发信号 → 整轮提交 → report 从新状态读取输入。局部读取解释了路由何以立即判断，轮次提交解释了下游何以拿到已合并状态。

这个实现还有两个使用后果。其一，路由读取副本时也会应用字段的更新规则，所以 reducer 可能再次被调用；不要让 reducer 发请求或写数据库。其二，条件路由与已有普通边各自生成触发写入；如果没有移除原来的 `increment → report` 普通边，即使 route 返回 END，普通边仍可能触发 report。互斥选择应只保留表达这项选择的路由关系。

## 八、compile 成功，究竟保证了什么

`compile()` 会校验声明中的节点引用、起点终点和静态中断配置，并完成节点与边的装配。具体输入下的正确性仍要通过运行验证。

对照本例，可以明确三个边界：

- **能装配，不等于返回值一定正确。** increment 拼错 count，可能在提取字段时被过滤；编译阶段并没有执行函数来验证这次输出。
- **有执行路径，不等于路径一定结束。** 条件路由可以形成循环，是否退出取决于实际数据和业务判断；运行轮数限制在第 03 篇解释。
- **重新修改 builder，需要重新编译。** 旧 graph 的节点和触发写入已经装配完成，后来再调用 `builder.add_edge()` 不会替旧 graph 重装这些关系。

工程上可以复用已经编译好的图处理多次输入；每次调用的状态和恢复身份另行管理。调整节点或路由结构后，应生成新的编译结果，再检查受影响的状态更新与触发路径。
