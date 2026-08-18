---
sidebar_position: 2
sidebar_label: 00 项目总览与仓库结构
description: 用一个最小 StateGraph 对照 monorepo 包边界和核心目录，建立从公开 API 到运行时源码的第一条阅读路线。
---

# LangGraph 源码 00：先从一个最小图走进仓库

## 源码定位

> **适用版本**：`langgraph` 1.2.10、`langgraph-prebuilt` 1.1.0、`langgraph-checkpoint` 4.1.1
>
> **核心路径**：
>
> - **图声明与编译**：`libs/langgraph/langgraph/graph/state.py`（`StateGraph`、`compile()`、`CompiledStateGraph`）
> - **运行入口**：`libs/langgraph/langgraph/pregel/main.py`（`invoke()`、`stream()`）
> - **包边界**：`libs/langgraph/pyproject.toml`、`libs/checkpoint/pyproject.toml`、`libs/prebuilt/pyproject.toml`

## 这一篇要解决什么

这组文章拆的是 LangGraph Runtime。Runtime 的问题有三个：

1. 哪些节点现在可以运行；
2. 多个节点返回结果后，状态怎样变；
3. 暂停或失败后，怎样继续同一条执行。

先写出最小图，再回到源码。否则 `StateGraph`、`compile()`、`Pregel` 很容易只剩一串名词。

## 一、最小图：先看 API 实际做了什么

```python
from typing_extensions import TypedDict
from langgraph.graph import END, START, StateGraph

class State(TypedDict):
    count: int

def increment(state: State):
    return {"count": state["count"] + 1}

builder = StateGraph(State)
builder.add_node("increment", increment)
builder.add_edge(START, "increment")
builder.add_edge("increment", END)

graph = builder.compile()
print(graph.invoke({"count": 0}))
# {"count": 1}
```

这段代码先不要联想 Agent。它只做了一件事：把输入的 `count=0` 交给 `increment`，得到局部更新 `{"count": 1}`，然后返回最终状态。

| 代码 | 现在建立的直觉 | 后面去哪里追 |
| --- | --- | --- |
| `State` | 节点从状态读取数据，返回局部更新 | [01 State、Channel 与 Reducer](./01-state-schema-channels-and-reducers.md) |
| `increment()` | 节点是普通函数；返回值不是直接改全局变量 | [02 Builder 与编译](./02-stategraph-builder-and-compilation.md) |
| `add_node()` / `add_edge()` | 先声明节点与连接关系，尚未运行 | [02 Builder 与编译](./02-stategraph-builder-and-compilation.md) |
| `compile()` | 把声明变成可运行图 | 本篇下一节 |
| `invoke()` | 启动执行，取得最终结果 | [03 Pregel 调度](./03-pregel-supersteps-and-scheduling.md) |

后面的 Channel、`Send`、checkpoint 和 interrupt 都是对这个最小图加约束：出现并行、分支、暂停或恢复时，仍然知道哪些节点该运行，以及状态该怎样处理。

## 二、第一条源码链：`compile()` 到底做了什么

`StateGraph` 是构建器。`add_node()` 和 `add_edge()` 只记录声明；真正把图变为可运行对象的是 `compile()`。

```python
# libs/langgraph/langgraph/graph/state.py:1164
class StateGraph(StateGraphBase[StateT, ContextT, InputT, OutputT]):
    def compile(
        self,
        checkpointer: Checkpointer = None,
        *,
        cache: BaseCache | None = None,
        store: BaseStore | None = None,
        interrupt_before: All | list[str] | None = None,
        interrupt_after: All | list[str] | None = None,
        ...
    ) -> CompiledStateGraph[StateT, ContextT, InputT, OutputT]:
        """Compiles the `StateGraph` into a `CompiledStateGraph` object."""
```

签名已经说明两件事：

- 产物是 `CompiledStateGraph`，不是简单保存节点列表的 Builder；
- checkpointer、Store、静态中断都在编译时交给可执行图，之后由运行时使用。

继续看 `compile()` 的末尾：

```python
# libs/langgraph/langgraph/graph/state.py:1333-1388
compiled = CompiledStateGraph(
    builder=self,
    channels={**self.channels, **self.managed, START: EphemeralValue(...)},
    checkpointer=checkpointer,
    interrupt_before_nodes=interrupt_before,
    interrupt_after_nodes=interrupt_after,
    store=store,
    cache=cache,
    ...
)

compiled.attach_node(START, None)
for key, node in self.nodes.items():
    compiled.attach_node(key, node)
for start, end in self.edges:
    compiled.attach_edge(start, end)
for starts, end in self.waiting_edges:
    compiled.attach_edge(starts, end)
for start, branches in self.branches.items():
    for name, branch in branches.items():
        compiled.attach_branch(start, name, branch)

return compiled.validate()
```

这段代码把最小图里的三个声明真正接到可执行图上：

- `attach_node()` 接入 `increment`；
- `attach_edge()` 接入 `START → increment → END`；
- 没有条件边时，`attach_branch()` 循环不会做事。

`CompiledStateGraph` 在同文件 `state.py:1391` 定义，并继承 `Pregel`。这就是为什么 `compile()` 后的 `graph` 才拥有 `invoke()`、`stream()`、checkpoint 和中断能力。

```text
StateGraph
  └─ 记录节点、边、状态结构
        ↓ compile()
CompiledStateGraph
  └─ 接入节点、边、字段规则与基础设施
        ↓ invoke() / stream()
Pregel Runtime
  └─ 决定本轮运行哪些节点，统一处理结果
```

**测试证据**：`tests/test_pregel.py::test_invoke_single_process_in_out` 与 `::test_invoke_two_processes_in_out` 覆盖单节点、两节点图从编译到执行的最小路径。

## 三、为什么 Runtime 不能只是“按边调用函数”

最小图只有一个节点，看起来完全可以直接调用 `increment()`。但下面任一情况出现后，普通函数链就不够了：

| 新需求 | 运行时需要额外决定什么 | 对应文章 |
| --- | --- | --- |
| `left` 和 `right` 同时更新 `items` | 冲突、合并或拒绝哪种更新 | [01](./01-state-schema-channels-and-reducers.md) |
| 一个节点完成后触发两个下游 | 哪些节点在同一轮运行，何时提交结果 | [03](./03-pregel-supersteps-and-scheduling.md) |
| 节点需要动态派发独立输入，或同时更新 State 并跳转 | `Send`、`Command` 如何形成 Runtime task | [04](./04-dynamic-routing-and-send.md) |
| 人工审批后继续执行 | 当前状态、待执行任务与恢复值怎样保存 | [06](./06-checkpoints-store-and-recovery.md)、[07](./07-interrupts-and-command.md) |

因此 Runtime 的重点不是“把函数串起来”，而是在每轮执行时维持三个事实：**现在能跑什么、结果怎样合并、之后怎样恢复。**

## 四、仓库只按这四层读

先不要被 monorepo 目录数量分散注意力。本系列只需把源码放进四层：

```text
libs/
├─ langgraph/                 # 图声明与核心运行时
│  └─ langgraph/
│     ├─ graph/               # StateGraph、节点、边、条件路由
│     ├─ channels/            # 每个状态字段的更新规则
│     ├─ pregel/              # 执行轮次、任务、写入提交、恢复
│     ├─ stream/              # 把执行过程变成不同事件流
│     ├─ types.py             # Send、Command、interrupt 等控制原语
│     └─ runtime.py           # 节点运行时注入对象
├─ checkpoint/                # 执行快照与 Store 的抽象协议
├─ checkpoint-sqlite/         # SQLite 后端
├─ checkpoint-postgres/       # PostgreSQL 后端
└─ prebuilt/                  # ToolNode 等可复用的高层节点
```

`langgraph` 包依赖 `langgraph-checkpoint` 和 `langgraph-prebuilt`，这在 `libs/langgraph/pyproject.toml:25-32` 可见；但它们的责任不同：

| 包 | 这一系列关心什么 | 不展开什么 |
| --- | --- | --- |
| `langgraph` | 图声明、状态更新、调度、中断、事件流 | 上层 Agent 策略 |
| `langgraph-checkpoint` | Saver、Store 与序列化协议 | 具体业务记忆设计 |
| `langgraph-prebuilt` | `ToolNode` 的并行边界 | 预制 Agent 的完整装配 |
| SQLite/Postgres 后端 | 协议怎样落盘 | 图怎样路由或调度 |

SDK 和 CLI 也在同一仓库，但它们处理远端 API 与部署，不在这七篇的主链中。

## 五、LangGraph、LangChain、Deep Agents 分别补哪一层

```text
LangGraph
  → 提供状态、图和运行时语义

LangChain create_agent()
  → 装配常见的模型—工具循环与 Middleware

Deep Agents create_deep_agent()
  → 在同一基础上预装长任务常用的文件、上下文与治理策略
```

`create_agent()` 主要回答“标准 Agent 图包含哪些节点和边”；LangGraph 回答“这些节点怎样被调度、合并、保存和恢复”。所以本系列不重新拆 LangChain 工厂，而是为读 [LangChain 源码 03](../langchain/03-create-agent-assembly.md) 准备运行时坐标。

工具并行也按这个边界理解：

1. 多个图节点同时运行，是 LangGraph Runtime 的图级并发；
2. 一个 `ToolNode` 同时处理多个工具调用，是 `langgraph-prebuilt` 的节点内部并发；
3. 工具函数自己开启线程池或批量 I/O，是工具实现的资源控制。

三者会在[第 03 篇](./03-pregel-supersteps-and-scheduling.md)展开。此处只需避免把它们都叫作“工具并行”。

## 六、从这里怎样继续读

```text
最小图的状态字段怎样处理
  → 01 State、Channel 与 Reducer

最小图的节点和边怎样接到可执行图
  → 02 StateGraph Builder 与编译

最小图怎样进入一轮一轮的实际执行
→ 03 Pregel 调度与执行轮次

需要动态路由或拆子流程
  → 04 Branch、Send 与子图

需要暂停、恢复或跨执行保存数据
→ 05 Checkpoint、Store 与恢复
  → 06 暂停、恢复与事件流
```

## 读完后你应该能判断什么

- 最小 `StateGraph` 中每个公开 API 分别对应哪个源码阶段；
- 该从 `graph/state.py`、`channels/`、`pregel/` 还是 checkpoint 包开始排查；
- 一个问题属于图运行时、预制节点，还是 LangChain/Deep Agents 的上层装配。
