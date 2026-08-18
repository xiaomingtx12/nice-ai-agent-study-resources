---
sidebar_position: 3
sidebar_label: 01 State、Channel 与 Reducer
description: 从并行节点写同一字段的报错开始，完整追踪八种 Channel 类型的更新协议、Reducer 的解析链路、消息合并，以及 State/Input/Output 的 Schema 边界。
---

# LangGraph 源码 01：同一字段如何接收节点更新

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心实现**：
>
> - State Schema 解析：`libs/langgraph/langgraph/graph/state.py`，`_get_channels()`、`_get_channel()`、`_is_field_channel()`、`_is_field_binop()`
> - Channel 抽象：`libs/langgraph/langgraph/channels/base.py`，`BaseChannel`
> - 单写字段：`libs/langgraph/langgraph/channels/last_value.py`，`LastValue`
> - Reducer 字段：`libs/langgraph/langgraph/channels/binop.py`，`BinaryOperatorAggregate`
> - 一轮写入提交：`libs/langgraph/langgraph/pregel/_algo.py`，`apply_writes()`
> - 消息合并：`libs/langgraph/langgraph/graph/message.py`，`add_messages()`

## 先抓住三个词

**State Schema** 是你在 `TypedDict` 里声明的字段集合。LangGraph 把每个字段转成一个 **Channel**——运行时负责存储该字段、定义写入规则、处理持久化的对象。**Reducer** 是一小段逻辑，告诉 Channel "收到多份更新时怎么合并"。

当你在 Schema 里写 `Annotated[list[str], add]` 时，LangGraph 会为这个字段创建一个 **`BinaryOperatorAggregate`**——它的内部实现是：存一个当前值和一个二元函数（你的 Reducer，比如 `add`），`update()` 被调用时把每份新值依次与当前值做 `add(current, update)`，最终得到一个合并后的结果。

默认情况下，普通字段（不加 `Annotated`）选 `LastValue`：一轮只接受一份更新，多了报错。

---

**本文分两条线。** 一到六节讲你在 `TypedDict` 里声明的字段对应的 Channel——LastValue、Reducer、消息合并、可见性、Schema 边界。第七节讲 Runtime 自己在幕后创建的六种内部 Channel——你写代码时看不到它们，但理解后面 Pregel 调度、等待边和 `Send` 时需要知道。

先从第一条线入手：报错 → 为什么报错 → 怎么修。

## 一、默认规则：`LastValue` 只接受单写

让两个节点从 `START` 同时运行，都写 `items`：

```python
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph


class SingleWriteState(TypedDict):
    items: list[str]


def left(_: SingleWriteState):
    return {"items": ["left"]}


def right(_: SingleWriteState):
    return {"items": ["right"]}


def build_graph(schema: type[dict]):
    builder = StateGraph(schema)
    builder.add_node("left", left)
    builder.add_node("right", right)
    builder.add_edge(START, "left")
    builder.add_edge(START, "right")
    builder.add_edge("left", END)
    builder.add_edge("right", END)
    return builder.compile()


graph = build_graph(SingleWriteState)
graph.invoke({"items": []})
# InvalidUpdateError: At key 'items': Can receive only one value per step.
```

出错的原因是默认 Channel——`LastValue`：

```python
# libs/langgraph/langgraph/channels/last_value.py
def update(self, values: Sequence[Value]) -> bool:
    if len(values) == 0:
        return False
    if len(values) != 1:
        raise InvalidUpdateError(...)
    self.value = values[-1]
    return True
```

`values[-1]` 只在 `len(values) == 1` 时才会执行。

要保留两份结果，把合并规则写进 Schema：

```python
from operator import add
from typing import Annotated


class MergedState(TypedDict):
    items: Annotated[list[str], add]


merged_graph = build_graph(MergedState)
merged_graph.invoke({"items": []})
# {"items": ["left", "right"]}
```

注意必须**重新 `build_graph()`**——Channel 在 `StateGraph` 初始化时解析，已编译的图不会自动换 Channel。

## 二、`Annotated` 里的 Reducer 是怎么被识别的

每个字段的类型标注经过三层判断，优先级从高到低：

| 优先级 | 判断条件 | 选择的 Channel | 示例 |
| --- | --- | --- | --- |
| 1 | 是 Managed Value（如 `RemainingSteps`） | 托管值，运行时注入 | 本篇不展开 |
| 2 | `Annotated[T, SomeChannel]`，metadata 中有 `BaseChannel` 子类 | 显式 Channel | `Annotated[int, EphemeralValue]` |
| 3 | `Annotated[T, reducer]`，metadata 最后一项是二元 callable | `BinaryOperatorAggregate(T, reducer)` | `Annotated[list[str], add]` |
| — | 以上都不匹配 | `LastValue`（默认） | `items: list[str]` |

值得展开的是第三步——`_is_field_binop()` 怎样判断 `Annotated` 里有没有合法的 Reducer：

```python
# libs/langgraph/langgraph/graph/state.py:1890-1908（节选）
if hasattr(typ, "__metadata__"):
    meta = typ.__metadata__
    if len(meta) >= 1 and callable(meta[-1]):
        sig = signature(meta[-1])
        params = list(sig.parameters.values())
        if (
            sum(
                p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
                for p in params
            )
            == 2
        ):
            return BinaryOperatorAggregate(typ, meta[-1])
        else:
            raise ValueError(
                f"Invalid reducer signature. Expected (a, b) -> c. Got {sig}"
            )
return None
```

Reducer 必须表达为 `(current, update) -> new_value`：

```python
items: Annotated[list[str], add]          # 合法
items: Annotated[list[str], "tag"]        # 无 reducer，回退 LastValue
items: Annotated[list[str], lambda x: x]  # 非法：参数数量不对
```

## 三、Reducer 的合并逻辑：逐份应用二元函数

Reducer 的核心更新逻辑：

```python
# libs/langgraph/langgraph/channels/binop.py
def update(self, values: Sequence[Value]) -> bool:
    if not values:
        return False
    if self.value is MISSING:
        self.value = values[0]
        values = values[1:]

    for value in values:
        self.value = self.operator(self.value, value)
    return True
```

首次写入直接设置当前值，后续逐个应用 `operator(current, update)`。

Reducer 不限于 `operator.add`——任何接收 `(current, update)` 两个参数并返回新值的函数都可以：

```python
def keep_latest(current: list[str], update: list[str]) -> list[str]:
    """只保留最新一份更新，忽略旧值"""
    return update


def merge_scores(current: dict[str, int], update: dict[str, int]) -> dict[str, int]:
    """合并两个字典，同 key 取大值"""
    return {k: max(current.get(k, 0), update.get(k, 0)) for k in current | update}


class State(TypedDict):
    last_query: Annotated[str, keep_latest]
    scores: Annotated[dict[str, int], merge_scores]
    events: Annotated[list[str], add]
```

Reducer 必须满足三个工程条件：

1. **结果可解释**：多份更新为什么这样合并，读者能理解；
2. **无外部副作用**：不要在 reducer 里写数据库、发请求或改全局变量；
3. **可恢复**：checkpoint 恢复时不依赖任务完成时间和外部状态。

## 四、消息的特殊处理：按 ID 合并而非简单追加

消息列表不能用 `operator.add`——消息带唯一 ID，`add`（等同 `list + list`）会出三类问题：模型重试时同 ID 消息重复出现、人工编辑时新旧版本并列、checkpoint 恢复后同一批消息追加两遍。根因是 `add` 只看顺序不看 ID。

`add_messages` 按 ID 合并：同 ID 替换，新 ID 追加。用法：

```python
from langgraph.graph import add_messages


class State(TypedDict):
    messages: Annotated[list, add_messages]
```

核心实现（`libs/langgraph/langgraph/graph/message.py`，省略了类型转换和 ID 补全）：

```python
# 先把 left（已有消息）的 ID 编成索引
merged = left.copy()
merged_by_id = {m.id: i for i, m in enumerate(merged)}
ids_to_remove = set()

for m in right:                           # 遍历本轮新消息
    if m.id in merged_by_id:
        if isinstance(m, RemoveMessage):
            ids_to_remove.add(m.id)       # → 标记待删除
        else:
            merged[merged_by_id[m.id]] = m  # → 替换旧消息
    else:
        if isinstance(m, RemoveMessage):
            raise ValueError(...)         # 要删的消息不存在，报错
        merged.append(m)                  # → 新 ID，追加

merged = [m for m in merged if m.id not in ids_to_remove]  # 最后统一删除
```

`RemoveMessage` 是 LangChain 内置的一种特殊消息类型，只带一个消息 ID，表示"删掉这条消息"。节点返回它的典型场景：清除过期的系统提示。它不是和 `add_messages` 对等的独立概念——它是 `add_messages` 能识别和处理的一种**输入**。上面代码里可以看到：遍历 `right` 时遇到 `RemoveMessage`，不追加也不替换，而是把对应的 ID 放进 `ids_to_remove`，最后统一过滤掉。

Channel 的写入规则讲完了。但在实际使用中还有一个容易被误解的点：同一轮内，并行节点互相看不到对方刚写入的值。这不是 Channel 的问题，是 Pregel 一轮提交的约束。

## 五、并行节点读的是同一版快照，互相不可见

Channel 只管"多份更新怎么处理"，不管更新何时对其他节点可见——这由 Pregel 一轮提交控制：

```text
第 N 轮：所有节点读同一版 State
  left  返回 {"items": ["left"]}
  right 返回 {"items": ["right"]}
              ↓
       apply_writes() 分组
              ↓
       items Channel.update(["left"], ["right"])
              ↓
第 N+1 轮：下游读合并后的 State
```

所以 `right` 要读 `left` 的结果时，用边建立依赖：

```python
builder.add_edge("left", "right")   # right 在 left 完成后执行
```

Reducer 只负责同一轮结果的合并，不能替代图边表达的顺序依赖。

讲清楚单字段的规则后，最后一个用户侧的问题：一张图可以同时有三个 Schema，分别控制输入、内部和输出边界。它们共用同一份运行时状态。

## 六、一张图可以有三套 Schema：Input / State / Output

`StateGraph` 可以分别接收三个 Schema：

```python
class InputState(TypedDict):
    question: str


class State(InputState):
    documents: list[str]
    answer: str


class OutputState(TypedDict):
    answer: str


builder = StateGraph(State, input_schema=InputState, output_schema=OutputState)
```

- `InputState` 限定调用方可以提交什么；
- `State` 描述图内部完整的可读可写字段；
- `OutputState` 限定调用方最终拿到什么。

三者共用一份运行时状态，不会产生三份副本。注意：如果用父类继承定义 State（`class State(InputState)`），子类同名字段不能偷偷改 reducer——`_add_schema()` 只允许新的 `LastValue` 不覆盖已有 Channel，其他类型冲突直接报错。要改规则就在最终的 State 里直接声明。

---

下面六种 Channel 由编译器或 Pregel Runtime 在幕后创建——你写 `StateGraph` 时看不到它们，但理解后面的调度和触发机制时需要知道每种承担什么角色。

## 七、Runtime 自己在内部创建的六种 Channel

| Channel | 写入规则 | 触发行为 | Runtime 中的用途 |
| --- | --- | --- | --- |
| `Topic` | 多生产者写入；`accumulate=False` 每轮自动清空 | 有值时触发订阅者 | `TASKS` Channel，存放 `Send` 产生的 PUSH task |
| `NamedBarrierValue` | 只接受预注册的名字，拒绝未知值 | 全部到齐后触发 | 等待边（`add_edge(["a","b"], "c")`） |
| `EphemeralValue` | 单写；收到空写入自动清除为 `MISSING` | 有值时触发，下一轮无新写自动失效 | `START` Channel（接收用户输入，入口节点跑完自动清空） |
| `AnyValue` | 多写不报错，只取最后一份 | 有值触发 | 多上游可能写同一字段、不要求互斥 |
| `DeltaChannel` | 浅合并字典，每份更新逐个 key 并入当前值 | 有更新触发 | 多节点各改 State 子字段，自动合并 |
| `UntrackedValue` | 单写 | 不触发依赖节点 | 只读配置或缓存，更新不应引起新任务 |

### `Topic`（发布订阅）

```python
# libs/langgraph/langgraph/channels/topic.py（节选核心方法）
class Topic(Generic[Value], BaseChannel[Sequence[Value], Value | list[Value], list[Value]]):
    def __init__(self, typ: type[Value], accumulate: bool = False) -> None:
        self.accumulate = accumulate
        self.values = list[Value]()

    def update(self, values: Sequence[Value | list[Value]]) -> bool:
        if not self.accumulate:
            self.values = list()            # 先清空旧值
        self.values.extend(_flatten(values))  # 再追加新值
        return True
```

`accumulate=False`（默认）时每轮自动清空，契合 `TASKS` Channel 的语义——上一轮的 `Send` 已经在 `prepare_next_tasks()` 中被取走，下一轮不需要保留。

### `NamedBarrierValue`（命名屏障）

```python
# libs/langgraph/langgraph/channels/named_barrier_value.py（节选核心方法）
class NamedBarrierValue(Generic[Value], BaseChannel[Value, Value, set[Value]]):
    def __init__(self, typ: type[Value], names: set[Value]) -> None:
        self.names = names           # 期待的值集合
        self.seen: set[str] = set()  # 已收到的值

    def update(self, values: Sequence[Value]) -> bool:
        for v in values:
            if v not in self.names:
                raise InvalidUpdateError(
                    f"At key '{self.key}': Value {v} not in {self.names}"
                )
            self.seen.add(v)
        return True

    def is_available(self) -> bool:
        return self.seen == self.names  # 全部到齐
```

`builder.add_edge(["search", "profile"], "answer")` 创建 `NamedBarrierValue(str, {"search", "profile"})`。两个节点各报到一次，全部到齐后 `answer` 获得触发资格。屏障只管到齐条件，不管合并结果——结果合并由字段 Channel 的 reducer 处理。

### `EphemeralValue`（临时值）

```python
# libs/langgraph/langgraph/channels/ephemeral_value.py（节选核心方法）
class EphemeralValue(Generic[Value], BaseChannel[Value, Value, Value]):
    def update(self, values: Sequence[Value]) -> bool:
        if len(values) == 0:
            if self.value is not MISSING:
                self.value = MISSING   # 无新写就清除
                return True
            return False
        if len(values) != 1 and self.guard:
            raise InvalidUpdateError(
                f"At key '{self.key}': EphemeralValue(guard=True) can "
                f"receive only one value per step."
            )
        self.value = values[-1]         # 有新写就替换
        return True
```

存活一轮：有写入时下游可读，到下一轮无新写入自动变为 `MISSING`。`START` Channel 就靠它——`invoke(input)` 写入 `START` 触发入口节点，入口跑完 `START` 自动清空，不会在后续轮次残留初始输入。

### `AnyValue` / `DeltaChannel` / `UntrackedValue`

`AnyValue` 与 `LastValue` 的共同父类是 `BaseChannel[Value, Value, Value]`，区别仅在于 `update()` 对多写不抛错，只取最后一份。适合多上游可写同一字段但无需严格互斥。

`DeltaChannel` 的更新语义是浅合并而不是替换——`update()` 把每份 dict 中的键值对逐一并入当前值。适合多节点各改 State 不同子字段。

`UntrackedValue` 的 `update()` 与普通 Channel 相同，但不会更新 `channel_versions`。因此 Runtime 不会因为它变化而触发依赖节点，适合只读配置或缓存。

## 八、速查与选择

| 场景 | 选什么 |
| --- | --- |
| 单生产者、覆盖写入 | 普通字段 → `LastValue` |
| 多生产者、可定义二元合并 | `Annotated[T, reducer]` → `BinaryOperatorAggregate` |
| 消息历史（替换/删除/去重） | `Annotated[list, add_messages]` |
| 多生产者写入、消费者独立取用 | `Topic`（通常 Runtime 内部用） |
| 多上游到齐后才触发 | `NamedBarrierValue`（编译等待边时内部用） |
| 只存活一轮的临时值 | `EphemeralValue`（`START` 通道） |
| 多写不报错、取最后值 | `AnyValue` |
| 自动浅合并字典更新 | `DeltaChannel` |
| 更新不触发新任务 | `UntrackedValue` |

## 工程判断

- **照搬**：把字段更新规则放进 Schema，让 `LastValue` 在并行写时暴露结构错误；reducer 保持纯函数。
- **换实现**：日志、事件、候选答案用 reducer，但给元素带 ID 或序号，不要默认 `list + list` = 业务顺序。
- **别碰**：不要所有字段都标 `operator.add`；不要用 reducer 替代本应由图边表达的依赖；不要用父类继承偷改 reducer。
- **不适用时**：单生产者、覆盖即业务语义时 `LastValue` 比 reducer 更清楚；消息历史不要用普通 reducer 替代 `add_messages`。

## 读完后应该能判断什么

- 并行写入报错是字段规则（LastValue）不匹配，还是图结构缺依赖边；
- `Annotated[T, reducer]` 如何被解析成 `BinaryOperatorAggregate`，Reducer 必须满足什么签名；
- `add_messages` 与 `operator.add` 的区别——为什么消息历史必须用前者；
- 六种内部 Channel 各自在 Runtime 中充当什么角色（`TASKS` / 等待边 / `START` / 缓存等）；
- `InputState`、`State`、`OutputState` 如何共享同一份运行时状态而不产生副本。
