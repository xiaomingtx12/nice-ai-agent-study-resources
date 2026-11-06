---
sidebar_position: 3
sidebar_label: 01 State、Channel 与 Reducer
description: 沿 Schema 解析、写入分组和通道更新解释并行冲突、消息合并、增量持久化与状态边界。
---

# LangGraph 源码 01：字段更新怎样合并成下一版状态

**源码定位**

> 快照身份与验证范围见[源码基线](./source-baseline.md)。源码节选以该快照为准，文中的应用示例不等于框架实现。

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - Schema 解析：`libs/langgraph/langgraph/graph/state.py` → `_get_channels()`、`_get_channel()`、`_is_field_binop()`。
> - 提交入口：`libs/langgraph/langgraph/pregel/_algo.py` → `apply_writes()`。
> - 字段合并：`libs/langgraph/langgraph/channels/last_value.py` → `LastValue.update()`；`libs/langgraph/langgraph/channels/binop.py` → `BinaryOperatorAggregate.update()`。
> - 临时信号：`libs/langgraph/langgraph/channels/ephemeral_value.py` → `EphemeralValue.update()`。
> - 消息与持久化：`libs/langgraph/langgraph/graph/message.py` → `add_messages()`；`libs/langgraph/langgraph/channels/delta.py` → `DeltaChannel`；`libs/langgraph/langgraph/channels/untracked_value.py` → `UntrackedValue`。

在第 00 篇，increment 返回 `{"count": 1}` 后，图的 count 从 0 变为 1。这个覆盖动作看起来很自然，但换成两个并行节点都返回 `{"items": [...]}`，框架就必须知道：保留哪一份，还是把两份合起来？

**通道保存字段值，reducer 决定多份更新怎样合并。** Channel（通道）是框架管理值和更新的对象；reducer（归并函数）是你可以提供的一条合并规则，例如用列表相加收集两个节点的结果。示例中的节点依旧收发字典，使用框架时不需要逐个操作通道对象。

下面先让两个节点各交回一份结果，再沿字段声明和提交代码解释结果如何合在一起。left、right 对应总览中的两项材料处理；消息、临时信号和恢复优化在后半篇展开，文末再区分业务状态与运行依赖。

## 一、两个节点都返回 items，应该得到什么

下面是完整应用示例，不调用模型。left 和 right 从同一个入口出发，merge 等两者完成后生成展示文本。`operator.add` 用列表相加收集结果；`Annotated` 让我们在字段类型旁声明这条合并规则。

```python
import operator
from typing import Annotated
from typing_extensions import TypedDict
from langgraph.graph import START, END, StateGraph

class State(TypedDict):
    items: Annotated[list[str], operator.add]
    report: str

def left(state: State):
    return {"items": ["left"]}

def right(state: State):
    return {"items": ["right"]}

def merge(state: State):
    return {"report": ", ".join(sorted(state["items"]))}

builder = StateGraph(State)
builder.add_node("left", left)
builder.add_node("right", right)
builder.add_node("merge", merge)
builder.add_edge(START, "left")
builder.add_edge(START, "right")
builder.add_edge(["left", "right"], "merge")
builder.add_edge("merge", END)
graph = builder.compile()
result = graph.invoke({"items": [], "report": ""})
assert sorted(result["items"]) == ["left", "right"]
assert result["report"] == "left, right"
```

两个节点各自只返回新增项，merge 才读取合并后的列表。示例显式排序展示结果，不把任务完成顺序当成业务顺序。

只修改字段声明，就会改变同一批返回值的含义：

| items 的声明或返回方式 | 本轮会发生什么 | 对应使用方式 |
| --- | --- | --- |
| `items: list[str]` | 两份并行更新冲突 | 同一轮只有一个节点负责写这个字段 |
| `Annotated[list[str], operator.add]` | 两份列表依次拼接 | 每个节点返回自己的新增项 |
| 使用拼接规则，却返回“旧列表 + 新项” | 旧数据也被当作新增数据再次拼接 | 不要把累计全量误作增量返回 |

### 1、字段声明怎样决定更新规则

沿用加一例子，`count: int` 表示没有额外合并规则，框架会选 `LastValue`，即“保留上次值，收到新值时替换”的通道。若声明 `items: Annotated[list[str], operator.add]`，则会选 `BinaryOperatorAggregate`，它把每份更新交给你提供的二元合并函数，列表相加就是其中一种用法。

`State Schema` 指这里声明字段及类型的结构，例如示例里的 `State`。`StateGraph` 初始化时通过 `_add_schema()` 登记结构；`_get_channels()` 保留 `Annotated` 元数据，为每个字段调用 `_get_channel()`。`Annotated[T, metadata]` 是 Python 的类型标注形式，LangGraph 从 metadata 中读取通道或 reducer 配置。

读下面代码时，`annotation` 是某个字段的类型标注，`name` 是字段名。先关注“发现 reducer 时创建聚合通道，否则采用 LastValue”两个分支；托管值和手动指定通道是额外配置路径。

源码：`libs/langgraph/langgraph/graph/state.py` → `_get_channel`（第 1845–1859 行节选；未展示部分省略）。

```python
if manager := _is_field_managed_value(name, annotation):
    if allow_managed:
        return manager
    else:
        raise ValueError(f"This {annotation} not allowed in this position")
elif channel := _is_field_channel(annotation):
    channel.key = name
    return channel
# 字段标注中带有 reducer 时，使用执行该 reducer 的聚合通道。
elif channel := _is_field_binop(annotation):
    channel.key = name
    return channel

# 普通字段没有附加规则时，默认使用 LastValue。
fallback: LastValue = LastValue(annotation)
fallback.key = name
return fallback
```

选择顺序是托管值、显式通道、二元 reducer，均不匹配时采用 `LastValue`。托管值由运行时计算，例如剩余轮数，不属于普通节点写回的业务字段。

显式通道可以在元数据中给出实例或通道类；二元 reducer 则要求元数据最后一项可调用。`_is_field_binop()` 检查它是否恰有两个位置参数，形如 `(current, update) -> new_value`。这个检查只验证签名，不证明 reducer 满足结合律，也不验证每份更新都符合类型标注。

例如 `items: list[str]` 使用 `LastValue`；`items: Annotated[list[str], operator.add]` 使用 `BinaryOperatorAggregate`。更改声明后需要重新构建、编译图，不能期待已有运行图自动更换通道规则。

## 二、一轮写入如何到达字段通道

假设 `left` 与 `right` 在同一轮运行，分别返回 `{"items": ["left"]}` 和 `{"items": ["right"]}`。`apply_writes()` 按任务路径确定应用顺序，再将两份更新归到 `items`。

这里的“写入”就是某个节点返回的字段更新。`pending_writes_by_channel` 按字段名收集本轮更新，例如 items 对应两份列表；`channels` 则按字段名找到负责它的通道对象。`apply_writes()` 是把这一批更新应用到状态的内部函数。

源码：`libs/langgraph/langgraph/pregel/_algo.py` → `apply_writes`（第 315–323 行节选；未展示部分省略）。

```python
# 每个字段一次接收本轮归到它的全部更新。
updated_channels: set[str] = set()
for chan, vals in pending_writes_by_channel.items():
    if chan in channels:
        if channels[chan].update(vals) and next_version is not None:
            checkpoint["channel_versions"][chan] = next_version
            # 不可读的通道不能触发任务，不加入可触发更新集合。
            if channels[chan].is_available():
                updated_channels.add(chan)
```

这里实际调用的是 `items_channel.update([["left"], ["right"]])`：外层列表代表两份写入，内层列表才是每个节点提供的字段值。`update()` 的布尔返回值表示通道是否报告了变化；通道值和通道版本是两件事，值相同也可能因一次写入而推进版本。

### 1、默认通道为什么拒绝并行覆盖

源码：`libs/langgraph/langgraph/channels/last_value.py` → `LastValue.update`（第 56–67 行节选；未展示部分省略）。

```python
def update(self, values: Sequence[Value]) -> bool:
    if len(values) == 0:
        return False
    if len(values) != 1:
        msg = create_error_message(
            message=f"At key '{self.key}': Can receive only one value per step. Use an Annotated key to handle multiple values.",
            error_code=ErrorCode.INVALID_CONCURRENT_GRAPH_UPDATE,
        )
        raise InvalidUpdateError(msg)

    self.value = values[-1]
    return True
```

`values[-1]` 只在恰有一份更新时执行。因此 `LastValue` 不是“谁最后完成谁覆盖”：零份写入保持旧值，两份写入抛出 `InvalidUpdateError`（无效更新错误）。错误发生在合并阶段，不能靠重试某个已经正常返回的节点解决。

如果两份结果都应保留，配置 reducer；如果右节点必须读取左节点的结果，应改变依赖关系，让它们分轮执行。还要移除使右节点提前运行的其他入口边，只补一条 `left → right` 不会取消原来的触发路径。

### 2、聚合通道怎样调用 reducer

`BinaryOperatorAggregate` 初始化时尝试调用字段类型的空构造器，例如 `list()` 得到 `[]`；类型无法空构造时才使用 `MISSING`（尚无值的内部标记）。因此“第一次更新必然直接赋值”并不成立。

源码：`libs/langgraph/langgraph/channels/binop.py` → `BinaryOperatorAggregate.update`（第 123–144 行节选；未展示部分省略）。

```python
def update(self, values: Sequence[Value]) -> bool:
    if not values:
        return False
    if self.value is MISSING:
        self.value = values[0]
        values = values[1:]
    seen_overwrite: bool = False
    for value in values:
        is_overwrite, overwrite_value = _get_overwrite(value)
        if is_overwrite:
            if seen_overwrite:
                msg = create_error_message(
                    message="Can receive only one Overwrite value per super-step.",
                    error_code=ErrorCode.INVALID_CONCURRENT_GRAPH_UPDATE,
                )
                raise InvalidUpdateError(msg)
            self.value = overwrite_value
            seen_overwrite = True
            continue
        if not seen_overwrite:
            self.value = self.operator(self.value, value)
    return True
```

普通写入逐份执行 `operator(current, update)`。上述列表例子得到 `[] + ["left"] + ["right"]`。排序保证同一任务结构下的应用顺序可复现，但不代表业务上的先后；要按抓取时间或原始索引排序，应把这些字段放入结果，再显式排序。

`Overwrite` 是跳过 reducer 的覆盖指令。对已初始化的聚合值（例如上述列表字段），代码接收到它后直接替换值，并忽略该轮其余普通更新；同轮出现第二份覆盖指令会报错。无法空构造的类型则先走 `MISSING` 初始化分支，首份写入不经过下面的归并循环。清空累计列表应使用明确的覆盖语义，普通更新 `[]` 对列表拼接 reducer 没有效果。

reducer 宜保持确定性且不产生外部副作用，因为正常执行、局部状态读取和历史恢复都可能应用更新。它不应依赖请求返回时间，也不应承担写数据库等业务操作。

## 三、消息按 ID 更新，不按文本去重

`add_messages()` 是消息列表专用 reducer：先把输入转换为消息对象并为缺少 ID 的消息分配 ID，再按 ID 替换或追加。`RemoveMessage` 是携带删除目标 ID 的特殊消息。

源码：`libs/langgraph/langgraph/graph/message.py` → `add_messages`（第 216–234 行节选；未展示部分省略）。

```python
merged = left.copy()
merged_by_id = {m.id: i for i, m in enumerate(merged)}
ids_to_remove = set()
for m in right:
    if (existing_idx := merged_by_id.get(m.id)) is not None:
        if isinstance(m, RemoveMessage):
            ids_to_remove.add(m.id)
        else:
            ids_to_remove.discard(m.id)
            merged[existing_idx] = m
    else:
        if isinstance(m, RemoveMessage):
            raise ValueError(
                f"Attempting to delete a message with an ID that doesn't exist ('{m.id}')"
            )

        merged_by_id[m.id] = len(merged)
        merged.append(m)
merged = [m for m in merged if m.id not in ids_to_remove]
```

`left` 是已有消息，`right` 是本次更新；`merged_by_id` 把消息 ID 映射到列表位置，避免靠文本内容判断是否为同一条消息。

这里有两个容易漏掉的动作：追加时更新 `merged_by_id`，使同一批后续相同 ID 的消息能替换刚追加的消息；已有消息被重新写入时，`ids_to_remove.discard()` 撤销之前的删除标记。删除不存在的 ID 会抛错，而不是静默忽略。

例如旧列表含 `id="a"` 的消息，更新中再出现 `id="a"` 就覆盖原位置；出现 `id="b"` 则追加。两条内容相同但 ID 不同的消息仍会共存。每次重试都生成新 ID 时，`add_messages` 也不会自动实现业务去重。

纯追加场景可以用列表拼接，但编辑、删除、重放同 ID 消息需要 `add_messages` 的语义。恢复机制本身不等于重复追加消息；重复与否还取决于任务是否重跑、返回的 ID 是否稳定以及 reducer 如何处理更新。

## 四、字段值与调度信号使用不同通道

count 的旧值需要保留，直到节点给出新值；“increment 这轮可以运行”的标记只描述当前的触发情况。框架为它们采用了不同的通道。

**`EphemeralValue` 是收到空更新时清除旧值的临时通道。** 它出现在 `compile()` 的源码中，是因为编译器需要保存短暂的节点触发信号。`LastValue` 在空更新时保留值，两者在这里的区别很具体。

下面只看 `EphemeralValue.update()` 的空更新分支。`values` 是本轮给这个通道的更新列表，`MISSING` 是表示“当前没有值”的内部标记。

源码：`libs/langgraph/langgraph/channels/ephemeral_value.py` → `EphemeralValue.update`（第 55–61 行节选；后续处理新写入的分支省略）。

```python
def update(self, values: Sequence[Value]) -> bool:
    if len(values) == 0:
        if self.value is not MISSING:
            # 没有新写入时，清除上一轮留下的临时值。
            self.value = MISSING
            return True
        else:
            return False
```

以普通节点的触发通道为例，编译器使用 `EphemeralValue(Any, guard=False)`。`Any` 表示不要求某种固定值类型；`guard=False` 允许同轮收到多份信号，取最后一份保存。

| 给通道的更新 | 更新后的状态 | 这里要理解的事 |
| --- | --- | --- |
| `[None]` | 有一个值，值恰好为 None | None 也可以表达“收到触发信号” |
| 下一轮收到 `[]` | 变成 MISSING，没有值 | 没有新信号时清空旧值 |
| 同轮收到 `[None, None]`，guard=False | 仍是一个值为 None 的信号 | 多份普通触发信号不会变成多个独立输入 |

信号何时触发任务还受通道版本检查约束，第 03 篇再解释。这里先认清“保存业务值”和“保存触发信号”各自的生命周期。

<details>
<summary>进阶查阅：其他通道、屏障与增量保存</summary>

字段通道决定“数据怎样存”，编译器生成的触发通道决定“谁可以运行”。常见实现如下，不能将这张表理解为全部通道类型：

| 通道 | 更新与生命周期 | 典型用途 |
| --- | --- | --- |
| `LastValue` | 每轮最多一份更新；无更新保留旧值 | 默认状态字段 |
| `BinaryOperatorAggregate` | 按二元 reducer 合并，支持覆盖指令 | 累加值、消息历史 |
| `EphemeralValue` | 空更新会清除值；`guard=False` 允许多写取末值 | `START` 和普通节点触发信号 |
| `Topic` | 收集一批值；`accumulate=False` 每轮替换批次 | `TASKS` 中的动态派发 |
| `NamedBarrierValue` | 记录已到达的上游名字；全部到齐才可读，消费后复位 | 等待边 |
| `AnyValue` | 多写取末值；无更新清空 | 接受任一临时值的底层通道 |
| `UntrackedValue` | 默认单写、无更新保留；不保存值到检查点 | 不要求恢复的临时对象 |
| `DeltaChannel` | 批量 reducer 加历史写入重建 | 减少大状态的重复持久化 |

`NamedBarrierValue` 记录的是名字集合。例如等待 `search` 和 `profile` 时，`search` 报到两次不能代替 `profile`；未知名字会抛出更新错误。它只表达就绪条件，不合并两个节点返回的业务数据。

### 1、UntrackedValue 不保存值，但仍可触发

源码：`libs/langgraph/langgraph/channels/untracked_value.py` → `UntrackedValue.checkpoint / from_checkpoint`（第 48–54 行节选；未展示部分省略）。

```python
def checkpoint(self) -> Value | Any:
    return MISSING

def from_checkpoint(self, checkpoint: Value) -> Self:
    empty = self.__class__(self.typ, self.guard)
    empty.key = self.key
    return empty
```

“Untracked”在这里指字段值不进入检查点。它的 `update()` 仍返回变化，`apply_writes()` 没有将它排除在通道版本更新之外。底层 Pregel 节点若订阅它作为触发通道，仍可以被它触发；恢复时它的旧值则不存在。普通 StateGraph 业务字段是否触发节点，还取决于编译后的边。

### 2、DeltaChannel 用重建成本换保存体积

`DeltaChannel` 的 reducer 接收 `(state, [write1, write2, ...])`，一次处理整批更新。它不是预设的字典浅合并器。

源码：`libs/langgraph/langgraph/channels/delta.py` → `DeltaChannel.update`（第 181–183 行节选；未展示部分省略）。

```python
base = self.typ() if self.value is MISSING else self.value
self.value = self.reducer(base, list(values))
return True
```

常规轮次主要保存写入，恢复时从祖先检查点收集历史写入，经 reducer 重建状态；运行时按快照策略间隔保存完整值，以限制重建深度。该实现处于 beta，且需要保存器支持增量历史读取。

批次可能在恢复时被重新组合，因此 reducer 必须满足 `reduce(reduce(state, xs), ys) == reduce(state, xs + ys)`。减少大消息列表的重复保存可能有收益，但代价是更复杂的恢复、迁移和历史保留要求，不能将普通二元 reducer 原样换进去。

</details>

## 五、输入、内部状态与输出是不同视图

`StateGraph(state_schema, input_schema=..., output_schema=...)` 通过不同字段集合限制入口写入和结果输出。节点还可声明自己的 `input_schema`：例如 `search` 只读取 `question`，但仍可返回图已登记的 `documents` 字段。

运行时维护的是通道集合，并按需要构造输入对象，不是同时维护三份独立状态。`TypedDict` 主要提供结构元数据，不会因此获得完整的运行时类型校验；未知输出键可能被过滤。Pydantic 模型会在转换节点输入时提供相应校验，但也不等于所有字段写入都经过业务验证。

普通并行节点读取的是轮次开始时的已提交值。条件路由有一条特殊路径：它可以在通道副本上应用**当前源节点自己的写入**，读取更新后的局部视图，以便根据刚生成的结果选择分支；它仍看不到其他并行节点尚未提交的结果。这个局部读取机制在[编译章节](./02-stategraph-builder-and-compilation.md)展开。

<a id="state-context-config-store"></a>

## 六、State、Runtime context、config 与 Store 分别放什么

材料处理函数除了读材料与结果，还可能需要数据库客户端、当前用户身份和长期偏好。把这些都塞进 State，会混淆工作流进度与运行依赖，也可能把不适合序列化的对象交给保存器。

`Runtime` 是注入节点的运行上下文对象，提供本次 context、Store、流式 writer 等能力。`RunnableConfig` 是运行配置，携带 thread_id 等执行配置以及回调等信息；当前 Runtime 类本身不包含 config，需要通过单独的参数或配置访问接口取得。

| 数据 | 建议位置 | 谁提供、如何使用 | 恢复时要注意什么 |
| --- | --- | --- | --- |
| 材料、处理结果、报告、审批结论 | State | 入口与节点通过字段更新推进 | 普通受跟踪字段参与检查点；仍有 UntrackedValue 等例外 |
| 已认证用户身份、本次数据库客户端 | Runtime context | 应用在调用入口提供，节点读取运行依赖 | 不会因作为 context 传入就自动成为 State 检查点值；跨进程恢复需重新提供适当依赖 |
| thread_id、指定 checkpoint_id、回调 | config | 应用控制执行身份、历史位置和观测 | thread_id 只是定位键，授权仍由应用检查 |
| 用户偏好、跨会话业务资料 | Store | 应用提供后端，节点显式读写 | 重放可能读到当前值，而非历史值；不会随图状态回退 |

这张表是基于运行机制的工程放置建议。context 被定位为运行期间的依赖，并不使里面所有 Python 对象天然不可变，也不自动提供秘密保护。节点若主动把 context 内容返回到 State 或日志，仍会改变数据暴露范围。

运行入口实际构造 Runtime 的代码如下。源码为 `libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 2872–2883 行）；父运行时与 server_info 的准备位于片段之前。

```python
runtime = Runtime(
    context=_coerce_context(self.context_schema, context),
    store=store,
    stream_writer=stream_writer,
    previous=None,
    execution_info=None,
    server_info=server_info,
    control=control or parent_runtime.control or RunControl(),
)
runtime = parent_runtime.merge(runtime)
config[CONF][CONFIG_KEY_RUNTIME] = runtime

```

`context_schema` 描述运行依赖的结构；`_coerce_context` 根据它处理传入值，再把 Runtime 接到本次配置供任务使用。这个过程没有调用字段 reducer，也没有把数据库连接等对象当作节点返回值合并进 State。

`libs/langgraph/tests/test_runtime.py` 的 `test_injected_runtime` 和 `test_context_runtime` 分别检查参数注入与 `get_runtime` 读取；它们只证明上下文可以到达节点，测试中的示例字符串并不应被当作生产日志设计。本次未运行这些测试。

这一区分还影响缓存：03 中的输入键来自节点输入，不会自动捕获所有 context 与 Store 依赖。如果结果随用户或资料版本变化，必须把相应身份纳入缓存设计，不能仅因输入材料相同就跨用户复用。
