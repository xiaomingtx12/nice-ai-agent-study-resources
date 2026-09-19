---
sidebar_position: 3
sidebar_label: 01 State、Channel 与 Reducer
description: 沿 Schema 解析、写入分组和通道更新解释并行冲突、消息合并、增量持久化与状态边界。
---

# LangGraph 源码 01：字段更新怎样合并成下一版状态

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - Schema 解析：`libs/langgraph/langgraph/graph/state.py` → `_get_channels()`、`_get_channel()`、`_is_field_binop()`。
> - 提交入口：`libs/langgraph/langgraph/pregel/_algo.py` → `apply_writes()`。
> - 字段合并：`libs/langgraph/langgraph/channels/last_value.py` → `LastValue.update()`；`libs/langgraph/langgraph/channels/binop.py` → `BinaryOperatorAggregate.update()`。
> - 消息与持久化：`libs/langgraph/langgraph/graph/message.py` → `add_messages()`；`libs/langgraph/langgraph/channels/delta.py` → `DeltaChannel`；`libs/langgraph/langgraph/channels/untracked_value.py` → `UntrackedValue`。

节点返回 `{"items": ["left"]}` 时，运行时不会立刻把这份字典覆盖到全局状态。返回值先转换为字段写入，本轮结束后按字段分组，再交给对应 Channel（通道）的 `update()`。**同一字段能否接收多份更新，由它的通道规则决定。**

State Schema（状态结构声明）定义字段及类型；Channel 保存字段值和更新规则；reducer（归并函数）定义当前值与更新怎样合成新值。`BinaryOperatorAggregate` 是调用二元 reducer 的通道，例如以 `operator.add` 将列表更新逐份拼接。

## 一、Schema 在构建阶段决定字段规则

`StateGraph` 初始化时通过 `_add_schema()` 登记结构；`_get_channels()` 保留 `Annotated` 元数据，为每个字段调用 `_get_channel()`。`Annotated[T, metadata]` 是 Python 的类型标注形式，LangGraph 从 metadata 中读取通道或 reducer 配置。

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
elif channel := _is_field_binop(annotation):
    channel.key = name
    return channel

fallback: LastValue = LastValue(annotation)
fallback.key = name
return fallback
```

选择顺序是托管值、显式通道、二元 reducer，均不匹配时采用 `LastValue`。托管值由运行时计算，例如剩余轮数，不属于普通节点写回的业务字段。

显式通道可以在元数据中给出实例或通道类；二元 reducer 则要求元数据最后一项可调用。`_is_field_binop()` 检查它是否恰有两个位置参数，形如 `(current, update) -> new_value`。这个检查只验证签名，不证明 reducer 满足结合律，也不验证每份更新都符合类型标注。

例如 `items: list[str]` 使用 `LastValue`；`items: Annotated[list[str], operator.add]` 使用 `BinaryOperatorAggregate`。更改声明后需要重新构建、编译图，不能期待已有运行图自动更换通道规则。

## 二、一轮写入如何到达字段通道

假设 `left` 与 `right` 在同一轮运行，分别返回 `{"items": ["left"]}` 和 `{"items": ["right"]}`。`apply_writes()` 按任务路径确定应用顺序，再将两份更新归到 `items`。

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

### 1. 默认通道为什么拒绝并行覆盖

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

### 2. 聚合通道怎样调用 reducer

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

这里有两个容易漏掉的动作：追加时更新 `merged_by_id`，使同一批后续相同 ID 的消息能替换刚追加的消息；已有消息被重新写入时，`ids_to_remove.discard()` 撤销之前的删除标记。删除不存在的 ID 会抛错，而不是静默忽略。

例如旧列表含 `id="a"` 的消息，更新中再出现 `id="a"` 就覆盖原位置；出现 `id="b"` 则追加。两条内容相同但 ID 不同的消息仍会共存。每次重试都生成新 ID 时，`add_messages` 也不会自动实现业务去重。

纯追加场景可以用列表拼接，但编辑、删除、重放同 ID 消息需要 `add_messages` 的语义。恢复机制本身不等于重复追加消息；重复与否还取决于任务是否重跑、返回的 ID 是否稳定以及 reducer 如何处理更新。

## 四、字段值与调度信号使用不同通道

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

### 1. UntrackedValue 不保存值，但仍可触发

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

### 2. DeltaChannel 用重建成本换保存体积

`DeltaChannel` 的 reducer 接收 `(state, [write1, write2, ...])`，一次处理整批更新。它不是预设的字典浅合并器。

源码：`libs/langgraph/langgraph/channels/delta.py` → `DeltaChannel.update`（第 181–183 行节选；未展示部分省略）。

```python
base = self.typ() if self.value is MISSING else self.value
self.value = self.reducer(base, list(values))
return True
```

常规轮次主要保存写入，恢复时从祖先检查点收集历史写入，经 reducer 重建状态；运行时按快照策略间隔保存完整值，以限制重建深度。该实现处于 beta，且需要保存器支持增量历史读取。

批次可能在恢复时被重新组合，因此 reducer 必须满足 `reduce(reduce(state, xs), ys) == reduce(state, xs + ys)`。减少大消息列表的重复保存可能有收益，但代价是更复杂的恢复、迁移和历史保留要求，不能将普通二元 reducer 原样换进去。

## 五、输入、内部状态与输出是不同视图

`StateGraph(state_schema, input_schema=..., output_schema=...)` 通过不同字段集合限制入口写入和结果输出。节点还可声明自己的 `input_schema`：例如 `search` 只读取 `question`，但仍可返回图已登记的 `documents` 字段。

运行时维护的是通道集合，并按需要构造输入对象，不是同时维护三份独立状态。`TypedDict` 主要提供结构元数据，不会因此获得完整的运行时类型校验；未知输出键可能被过滤。Pydantic 模型会在转换节点输入时提供相应校验，但也不等于所有字段写入都经过业务验证。

普通并行节点读取的是轮次开始时的已提交值。条件路由有一条特殊路径：它可以在通道副本上应用**当前源节点自己的写入**，读取更新后的局部视图，以便根据刚生成的结果选择分支；它仍看不到其他并行节点尚未提交的结果。这个局部读取机制在[编译章节](./02-stategraph-builder-and-compilation.md)展开。
