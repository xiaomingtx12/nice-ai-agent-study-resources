---
sidebar_position: 2
sidebar_label: 00 项目总览与执行主线
description: 沿输入、编译、节点写入和状态提交建立 LangGraph 的执行主线，并说明各包承担的运行时责任。
---

# LangGraph 源码 00：一次调用如何穿过图运行时

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 图构建：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.compile()`、`CompiledStateGraph.attach_node()`。
> - 执行入口：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.invoke()`、`Pregel.stream()`。
> - 轮次与提交：`libs/langgraph/langgraph/pregel/_loop.py` → `tick()`、`after_tick()`；`libs/langgraph/langgraph/pregel/_algo.py` → `apply_writes()`。

LangGraph 把节点函数的返回值暂存为写入，在一轮任务结束后合并到状态，再决定下一轮运行哪些节点。理解这一过程，才能解释并行写入为什么冲突、下游什么时候读到新值，以及失败后从哪里恢复。

`StateGraph` 是声明状态字段、节点和边的构建器；`CompiledStateGraph` 是编译产物，继承负责调度的 `Pregel`。构建器记录“允许怎样运行”，编译产物在调用时创建实际任务。一次图调用可以包含多轮任务，同一节点也可以在不同轮次被多次调用。

## 一、从输入到返回值

下面是用于说明数据流的完整应用示例，不是框架实现源码：

```python
from typing_extensions import TypedDict
from langgraph.graph import START, END, StateGraph

class State(TypedDict):
    count: int

def increment(state: State):
    return {"count": state["count"] + 1}

builder = StateGraph(State)
builder.add_node("increment", increment)
builder.add_edge(START, "increment")
builder.add_edge("increment", END)
graph = builder.compile()
result = graph.invoke({"count": 0})  # {"count": 1}
```

这里至少存在三种不同的数据：调用输入 `{"count": 0}`、节点返回的局部更新 `{"count": 1}`、运行时持有的当前状态。它们在这个例子里结构接近，但不能当成一个可以随意修改的共享字典。

| 阶段 | 实际发生的事情 | count 的状态 |
| --- | --- | --- |
| 构建 | Schema（状态结构声明）把 `count` 映射为 `LastValue` 通道 | 尚未接收输入 |
| 编译 | 安装隐藏的 `START` 节点、`increment` 节点和触发通道 | 尚未调用业务函数 |
| 接收输入 | 输入写到 `START`；隐藏节点把输入拆成字段写入并触发 `increment` | 提交后为 `0` |
| 执行节点 | `increment` 读取 `0`，返回更新 `1` | 更新先存在 task 的写入队列 |
| 轮次结束 | `apply_writes()` 调用字段通道的 `update()` | 变成 `1` |
| 结束 | 没有新的可运行任务，读取输出通道 | 返回 `{"count": 1}` |

Channel（通道）是保存值并处理更新的对象；`LastValue` 是其中一种，一轮最多接收一份更新。task（任务）则是节点在某一次调度中的执行实例，持有输入、身份和写入队列。

## 二、编译把声明接到读写协议上

`compile()` 创建 `CompiledStateGraph` 后，将构建器里登记的节点安装到编译结果：

源码：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.compile`（第 1360–1362、1378–1388 行节选；未展示部分省略）。

```python
compiled.attach_node(START, None)
for key, node in self.nodes.items():
    compiled.attach_node(key, node)

# ……省略中间实现……

for start, end in self.edges:
    compiled.attach_edge(start, end)

for starts, end in self.waiting_edges:
    compiled.attach_edge(starts, end)

for start, branches in self.branches.items():
    for name, branch in branches.items():
        compiled.attach_branch(start, name, branch)

return compiled.validate()
```

`attach_node()` 为节点配置读哪些状态字段、哪个信号可以触发它、返回结果如何转换为写入。`attach_edge()` 安装普通触发信号或等待多个上游的屏障；`attach_branch()` 安装条件路由函数。此时业务函数尚未执行。

例如 `increment` 的输入通道是 `count`，触发通道是 `branch:to:increment`。隐藏的 `START` 节点处理输入时向后者写入信号。`count` 保存业务数据，`branch:to:increment` 表达调度依赖，两个通道的作用不同。只修改某个业务字段，不等于所有读取它的节点都会运行。

## 三、执行主循环把准备、运行和提交分开

`invoke()` 内部消费 `stream()` 的执行结果；即使调用方只要最终值，也会经过同一套调度过程。`PregelLoop` 管理当前状态与轮次，`PregelRunner` 执行本轮任务。

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 2964–2972、2984–2988 行节选；未展示部分省略）。

```python
while loop.tick():
    for task in loop.match_cached_writes():
        loop.output_writes(task.id, task.writes, cached=True)
    for _ in runner.tick(
        [t for t in loop.tasks.values() if not t.writes],
        timeout=self.step_timeout,
        get_waiter=get_waiter,
        schedule_task=loop.accept_push,
    ):

# ……省略中间实现……

    loop.after_tick()
    emit_graph_lifecycle_events(loop)
    # 同步持久化模式下，等本轮检查点写入完成。
    if durability_ == "sync":
        loop._put_checkpoint_fut.result()
```

`loop.tick()` 准备任务，`runner.tick()` 执行尚无结果的任务，`loop.after_tick()` 合并本轮写入并准备检查点。中间省略的是将事件交给调用方的代码，不是额外的状态提交。

这样的轮次称为 superstep（超级步）：本轮普通图任务从已提交的通道值构造输入，节点返回的更新在轮次边界合并。两个并行节点即使完成时间不同，也不会因框架提前提交其中一个节点而读到不同版本。业务代码仍必须把输入视为只读；框架并不为任意可变 Python 对象提供深拷贝隔离。

代价是慢任务会影响同轮任务的汇合。若业务要求“先到的结果立即触发后续处理”，需要重新设计任务与依赖，不能把轮次内的完成事件等同于下一轮状态已经就绪。

## 四、失败后需要保存的不只是状态字典

假设一轮中 `search` 成功、`profile` 失败，只保存轮次开始时的 State 会丢失 `search` 的结果；只保存最终 State 又无从得知哪个任务还没做完。LangGraph 用 checkpoint（检查点）保存通道值、通道版本和节点已读版本，并用 pending writes（待合并写入）记录任务已经完成的结果。

配置保存器后，恢复执行可以按 task ID 找回成功结果，再运行尚未完成的任务。外部系统里的副作用不在这套写入协议内：请求已经送达服务端，但本地还没记下成功结果时，恢复仍可能重复请求。

## 五、按执行职责看仓库

| 相对路径 | 承担的工作 | 需要区分的边界 |
| --- | --- | --- |
| `libs/langgraph/langgraph/graph/` | Schema 解析、图声明、节点和边的编译 | 不执行模型或工具策略 |
| `libs/langgraph/langgraph/channels/` | 保存字段值、合并更新、表达触发与屏障 | 通道更新规则不负责提交时机 |
| `libs/langgraph/langgraph/pregel/` | 准备任务、执行、重试、提交和恢复 | 不代替业务幂等与事务 |
| `libs/checkpoint/langgraph/checkpoint/` | 保存器与序列化协议 | 具体落盘能力取决于后端 |
| `libs/checkpoint/langgraph/store/` | 按命名空间保存跨执行业务数据 | Store 写入不随检查点回滚 |
| `libs/prebuilt/langgraph/prebuilt/` | 工具参数注入、执行、结果消息 | 工具内部并发不自动成为图任务 |
| `libs/langgraph/langgraph/func/` | 将函数入口和任务装饰器接到 Pregel | 与 StateGraph 共用运行时 |

SQLite、PostgreSQL 保存器负责将协议落到不同存储。SDK 与 CLI 面向远端调用和部署，不参与本文这条本地执行链。

LangChain 的 `create_agent()` 在这些机制上装配模型与工具循环；Deep Agents 的 `create_deep_agent()` 再加入文件、规划和上下文管理等能力。例如模型返回两个工具调用时，工具节点可以内部并行，也可以通过 `Send` 分成两个图任务；两者的恢复粒度不同，与调用的是哪家模型无关。

需要追到具体机制时，按[状态字段](./01-state-schema-channels-and-reducers.md) → [编译](./02-stategraph-builder-and-compilation.md) → [调度](./03-pregel-supersteps-and-scheduling.md)阅读；恢复执行的完整链路在[第 06 篇](./06-checkpoints-store-and-recovery.md)。
