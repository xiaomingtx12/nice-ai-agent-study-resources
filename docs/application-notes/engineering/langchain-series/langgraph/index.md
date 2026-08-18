---
sidebar_position: 1
sidebar_label: 导读：图状态机与 Agent 运行时
description: 从项目包边界、StateGraph 编译与 Pregel 调度，到控制流、持久化、中断和流式事件，建立 LangGraph Runtime 的源码阅读坐标。
---

# LangGraph 源码解析：图状态机与 Agent 运行时

> **源码基线**：`langgraph` 1.2.10、`langgraph-prebuilt` 1.1.0、`langgraph-checkpoint` 4.1.1。

LangGraph 是这组三层源码分析的起点。它不替应用决定 Agent 应该有哪些工具、记忆或权限策略，而是提供一套可执行的图状态机：节点产生局部状态更新，Channel/Reducer 合并更新，边决定下一步，Pregel Runtime 负责调度、持久化、中断和事件输出。

```text
LangGraph Runtime
  ↓ 提供图、状态与执行语义
LangChain create_agent()
  ↓ 组装标准模型—工具循环
Deep Agents create_deep_agent()
  ↓ 预装长任务 Harness
业务 Agent
```

:::tip 先抓住一句话
`StateGraph` 描述图；编译后的 `CompiledStateGraph(Pregel)` 执行图。把两者分开，才能分清声明错误、调度错误和恢复错误。
:::

## 一、源码边界

| 源码坐标 | 重点对象 | 核心问题 |
| --- | --- | --- |
| `libs/langgraph/langgraph/graph/` | `StateGraph`、`BranchSpec`、`START`、`END` | 图如何声明与编译 |
| `channels/` | `LastValue`、聚合 Channel、Reducer | 多节点更新怎样形成下一版状态 |
| `pregel/` | task、step、write、retry | 节点以什么顺序运行，写入何时可见 |
| `libs/checkpoint/langgraph/` | Saver、Store、thread、checkpoint | 状态怎样保存、恢复与分叉 |
| `types.py` / `stream/` | `Send`、`Command`、`interrupt()`、stream mode | 动态编排、人工输入与事件怎样穿过 Runtime |
| `libs/prebuilt/` | `ToolNode`、预制 Agent | 可复用节点如何建立在 core Runtime 之上 |

公共 API 用来确认使用契约，内部 Runtime 用来解释调度与恢复。`ToolNode` 也是 LangGraph monorepo 的组件，但不属于 core Pregel 调度器；它的多工具调用并行与图 task 并行是两层机制。

## 二、文章地图

| 文章 | 主题 | 先解决什么 |
| --- | --- | --- |
| [00：项目总览与仓库结构](./00-project-overview-and-repository-structure.md) | 包边界、目录地图、主调用链 | 该从哪个包、哪个执行层开始追源码 |
| [01：State Schema、Channel 全类型与 Reducer](./01-state-schema-channels-and-reducers.md) | Schema、八种 Channel、更新合并 | 同字段为什么会合并或报错；每种 Channel 解决什么问题 |
| [02：`StateGraph` Builder 与编译](./02-stategraph-builder-and-compilation.md) | node、edge、branch 到编译图 | 声明如何降低为可调度结构 |
| [03：Pregel 调度与执行轮次](./03-pregel-supersteps-and-scheduling.md) | task、并行、write、retry | 节点何时并发，写入何时可见，工具并行在哪层 |
| [04：Send 与 Command：动态派发与控制信号](./04-dynamic-routing-and-send.md) | Send、Command、Command.PARENT、PULL/PUSH task | 节点如何更新 State、动态派发任务和跨图返回控制 |
| [05：子图：流程复用与状态边界](./05-subgraphs-and-cross-graph-control.md) | 子图作为节点、父子状态边界、checkpointer、streaming namespace | 如何封装嵌套流程，以及子图状态和事件如何划分 |
| [06：执行历史：保存、恢复与分叉](./06-checkpoints-store-and-recovery.md) | checkpoint、pending writes、replay、fork | 执行现场如何保存，旧状态如何继续或分叉 |
| [07：暂停、恢复与 interrupt](./07-interrupts-and-command.md) | interrupt、静态中断、恢复值匹配、节点重放 | 中断为何重放，调用方如何把恢复值交还给正确任务 |
| [08：流式输出与事件系统](./08-stream-system.md) | 七种 StreamMode、Transformer、v3 GraphRunStream | 运行过程怎样被调用方观察 |
| [09：Prebuilt 工具执行层](./09-prebuilt-tool-layer.md) | ToolNode、InjectedState/Store、ToolRuntime | 工具怎样注册、注入、并行执行 |
| [10：Func API 函数式工作流](./10-func-api-entrypoint-and-task.md) | @entrypoint、@task、entrypoint.final | 如何用函数定义替代显式 StateGraph 构建 |

## 三、四条阅读路线

### 1. 从图声明读到真正执行

[00 项目总览](./00-project-overview-and-repository-structure.md) → [01 State/Channel](./01-state-schema-channels-and-reducers.md) → [02 Builder/编译](./02-stategraph-builder-and-compilation.md) → [03 Pregel 调度](./03-pregel-supersteps-and-scheduling.md)

这条路线回答：节点和边如何变成 Runtime task；同一步并发时，为何状态不是"谁先完成谁先改"。

### 2. 动态控制流与子图

[02 Builder/编译](./02-stategraph-builder-and-compilation.md) → [04 Send/Command](./04-dynamic-routing-and-send.md) → [05 子图](./05-subgraphs-and-cross-graph-control.md)

这条路线回答：`Send` 和 `Command` 如何进入 Runtime；子图如何组合，又如何划分父子状态边界。

### 3. 持久化、中断与观察

[06 Checkpoint & Store](./06-checkpoints-store-and-recovery.md) → [07 Interrupt & Resume](./07-interrupts-and-command.md) → [08 Stream 系统](./08-stream-system.md)

这条路线回答：checkpoint 如何保存执行现场；interrupt 和 `Command(resume=...)` 如何暂停和恢复；运行过程怎样被 stream 输出。

### 4. 扩展层：工具与函数式 API

[09 Prebuilt 工具层](./09-prebuilt-tool-layer.md) → [10 Func API](./10-func-api-entrypoint-and-task.md)

这条路线回答：ToolNode、注入机制、tools_condition 如何建立在 core Runtime 之上；@entrypoint/@task 如何用函数语法替代显式 StateGraph。

## 四、与 LangChain 文章的边界

本分类分析 **LangGraph 自身如何定义并执行图**。已有的 [LangChain 05：State、Graph 与运行时边界](../langchain/05-state-graph-runtime.md) 分析 **LangChain `create_agent()` 如何声明 State Schema、条件边，并把 Checkpointer、Store、Cache 交给 LangGraph**。

```text
LangChain：预设 Agent 图怎么装配
LangGraph：这张图怎么调度、合并、保存和恢复
```

模型一次返回多个 tool calls 时，还需再分三层：Pregel 调度多个图 task；`ToolNode` 可在一个节点调用内并行工具；工具本身也可能有线程池或批量 I/O。完整边界见[第 03 篇](./03-pregel-supersteps-and-scheduling.md)。

读完这一分类后，再进入 [LangChain `create_agent()` 装配主线](../langchain/03-create-agent-assembly.md)，可以把 Agent 工厂里的节点、边和 Middleware 放回明确的 Runtime 语义中。
