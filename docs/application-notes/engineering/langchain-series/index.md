---
sidebar_position: 1
sidebar_label: LangGraph / LangChain / Deep Agents 源码解析
description: 自底向上拆解 LangGraph 图状态机、LangChain 最小 Agent 与 Deep Agents 长任务 Harness，追踪工程能力如何逐层封装。
---

# 从 LangGraph 到 Deep Agents：源码解析路线

> **已锁定源码基线**：LangGraph `1.2.10`、LangChain `1.3.7`、Deep Agents `0.6.12`。三组基线用于源码阅读，不表示可直接安装的依赖组合；Deep Agents `0.6.12` 自身声明 `langchain>=1.3.12,<2.0.0`。

:::tip 阅读主线
本系列不是横向罗列三个框架的功能，而是沿 **LangGraph 运行时 → LangChain 最小 Agent 框架 → Deep Agents Harness 预置套件**，观察工程能力如何逐层封装。
:::

## 一、为什么从底层向上读源码

手写一个“模型调用工具再继续推理”的循环并不难。复杂 Agent 的成本主要来自循环之外：状态如何合并、工具如何授权、上下文如何装配、长历史如何压缩、外部能力如何接入、子 Agent 如何隔离。

框架的价值是把这些重复问题固化成协议、组件和默认装配，使业务工具与通用基础设施分离。

相应的代价：抽象越完整，越需要遵守它的状态模型、生命周期和扩展协议。性能优化或强定制场景，可能需要回到更低层实现。

| 层次 | 已提供的主要轮子 | 仍需自行决定 | 主要取舍 |
| --- | --- | --- | --- |
| LangGraph | 图调度、状态合并、条件边、持久化、中断、流式事件 | Agent 循环形态及大部分 Harness 策略 | 抽象最浅、装配最多、控制力最高 |
| LangChain | 模型与工具抽象、Runnable/LCEL、`create_agent()`、Middleware、RAG 与模型集成 | 业务策略、非标准图结构、复杂长任务治理 | 复用组件增加，但受工厂和 Middleware 协议约束 |
| Deep Agents | 文件系统、Backend、Skills、Memory、压缩、权限、子 Agent 等默认组合 | 业务工具、权限规则、存储实现和领域提示 | 默认能力最完整，低层定制空间相对更小 |

## 二、LangGraph 篇：图状态机与 Agent 运行时

**目标：理解图 API 的用法和内部运行机制。**

1. [项目总览与仓库结构](./langgraph/00-project-overview-and-repository-structure.md)：先分清 core Runtime、checkpoint、prebuilt、SDK 与 CLI 的包边界，再固定 `StateGraph → Pregel` 主调用链。
2. [State Schema、Channel 与 Reducer](./langgraph/01-state-schema-channels-and-reducers.md)：状态字段如何定义更新协议；并行节点更新同字段时为何合并或报错。
3. [StateGraph Builder 与编译](./langgraph/02-stategraph-builder-and-compilation.md)：Builder 怎样收集节点和边，编译图怎样降低为 PregelNode、Channel、writer 与 barrier。
4. [Pregel 调度与执行轮次](./langgraph/03-pregel-supersteps-and-scheduling.md)：task 怎样按 step 调度、并发运行与统一提交；同时区分图 task、ToolNode 与工具内部的三层并行。
5. [Send 与 Command：动态派发与控制信号](./langgraph/04-dynamic-routing-and-send.md)：Send 与 Command 如何更新状态、动态派发任务和跨图返回控制。
6. [子图：流程复用与状态边界](./langgraph/05-subgraphs-and-cross-graph-control.md)：编译后的子图如何接入父图，父子状态边界与事件命名空间如何划分。
7. [执行历史：保存、恢复与分叉](./langgraph/06-checkpoints-store-and-recovery.md)：thread、checkpoint、Store 的责任边界，以及 resume、replay、fork 的恢复路径。
8. [暂停、恢复与 interrupt](./langgraph/07-interrupts-and-command.md)：人工输入如何暂停和续跑，恢复值如何交还给正确任务。
9. [流式输出与事件系统](./langgraph/08-stream-system.md)：七种 StreamMode 如何把状态、消息和自定义事件逐层流出。
10. [Prebuilt 工具执行层](./langgraph/09-prebuilt-tool-layer.md)：ToolNode、注入机制与 tools_condition 如何建立在 core Runtime 之上。
11. [Func API 函数式工作流](./langgraph/10-func-api-entrypoint-and-task.md)：@entrypoint 与 @task 如何用函数语法替代显式 StateGraph。

工程定位：LangGraph 位于最底层，抽象最浅、灵活性最高；Agent loop、工具权限、上下文治理和多 Agent 策略通常仍需自行装配。

入口见 [LangGraph 源码解析导读](./langgraph/index.md)。

## 三、LangChain 篇：核心抽象、最小 Agent 与线性任务链

**目标：理解基础组件和 Middleware 控制面。**

1. [项目概览与仓库结构](./langchain/00-project-overview-and-repository-structure.md)：确认 `core`、`langchain_v1`、Classic 和集成包的责任边界。
2. [Runnable 抽象与 LCEL](./langchain/01-runnable-and-lcel.md)：Runnable 统一执行协议如何通过 `|` 运算符构造线性链、并行、分支和 Passthrough。
3. [聊天模型、消息与工具系统](./langchain/02-core-abstractions.md)：模型、消息、工具三类核心对象如何实现 Runnable 协议。
4. [`create_agent()` 装配主线](./langchain/03-create-agent-assembly.md)：工厂如何把模型、工具、状态和 Middleware 编译成 LangGraph 图。
5. [Middleware 控制面](./langchain/04-middleware-control-plane.md)：`wrap_model_call` 与 `wrap_tool_call` 的拦截协议和扩展点。
6. [State、Graph 与运行时边界](./langchain/05-state-graph-runtime.md)：LangChain 如何在 `create_agent()` 中声明 State Schema、条件边，并把 Checkpointer、Store、Cache 交给 LangGraph。
7. [内置中间件总览](./langchain/06-middleware-overview.md)：按治理问题对 LangChain 内置中间件做全景分类。
8. [调用治理——限额、重试与回退](./langchain/07-call-governance.md)：模型调用层的速率限制、重试策略与 fallback 链。
9. [人在环路——HITL 审批协议](./langchain/08-human-in-the-loop.md)：工具执行前的人工审批流程与中断恢复机制。
10. [上下文与隐私治理——摘要、历史编辑与 PII](./langchain/09-context-and-privacy.md)：历史压缩、敏感信息脱敏与上下文窗口管理。
11. [工具注入面——Todo、Shell 与文件搜索](./langchain/10-tool-injection.md)：预置工具如何通过 Middleware 注入 Agent 工具列表。
12. [工具动态化——选择、模拟与 provider 搜索](./langchain/11-tool-dynamics.md)：运行时工具选择、模拟调用与搜索 provider 机制。
13. [RAG 组件与检索链路](./langchain/12-rag-components-and-retrieval.md)：Loader、Document、Splitter、Embedding、VectorStore 和 Retriever 各自负责什么。
14. [RAG 高级检索技术——在协议边界内组合](./langchain/13-advanced-retrieval-techniques.md)：多查询、上下文压缩、Self-query 等检索策略如何在协议边界内组合。

工程定位：LangChain 在 Runtime 之上提供 AI 能力集成、线性组合原语和可配置的最小 Agent Harness。标准场景少写大量胶水代码；非标准拓扑仍可下沉到 LangGraph。

入口见 [LangChain 源码解析导读](./langchain/index.md)。

## 四、Deep Agents 篇：完整 Agent Harness 套件

**目标：重点拆解完整 Harness 的实现，确认它在 LangChain 生态上增加了什么，以及默认能力如何调整、扩展和修复。**

前置依赖：LangChain、LangGraph。

1. [项目概览与仓库结构](./deepagents/00-project-overview-and-repository-structure.md)：monorepo 包边界、核心目录地图与责任边界。
2. [`create_deep_agent()` 总装配](./deepagents/01-create-deep-agent-assembly.md)：从主工厂入口看整套组件如何接在一起。
3. [模型解析与 Profile](./deepagents/02-model-resolution-and-profiles.md)：沿配置流追踪模型 spec 从解析到 Provider Profile、Harness Profile。
4. [状态、Reducer 与恢复一致性](./deepagents/03-state-reducers-and-recovery.md)：`messages` 从写入、合并到 Checkpoint 重放的全链路。
5. [Backend 接口与实现](./deepagents/04-backend-protocol-and-implementations.md)：同一套文件工具如何接入状态、存储、本地文件系统、远端环境与 Context Hub。
6. [Backend 沙箱与隔离](./deepagents/05-backend-sandbox-and-isolation.md)：`BaseSandbox` 如何用 `execute()` 派生全部文件操作，隔离强度按哪一层判断。
7. [中间件增量与装配顺序](./deepagents/06-middleware-increments.md)：对照 LangChain 内置中间件，建立 Deep Agents 中间件栈的复用与增量地图。
8. [SkillsMiddleware](./deepagents/07-skills-middleware.md)：技能元数据如何被发现，模型如何按需读取 `SKILL.md`。
9. [FilesystemMiddleware 与文件权限](./deepagents/08-filesystem-middleware-and-permissions.md)：一次文件工具调用如何经过校验、权限判断、执行和结果卸载。
10. [同步 SubAgent](./deepagents/09-subagent-sync.md)：本地委派如何隔离 State、运行子 Agent 并回写结果。
11. [Summarization 与上下文卸载](./deepagents/10-summarization-and-context-offloading.md)：如何压缩模型看到的历史，同时保留可恢复的原始记录。
12. [PatchToolCallsMiddleware](./deepagents/11-patch-tool-calls.md)：如何修复恢复后没有结果的工具调用。
13. [异步 SubAgent](./deepagents/12-async-subagent.md)：如何创建、查询、更新和取消远程任务。
14. [上下文装配与 MemoryMiddleware](./deepagents/13-memory-middleware.md)：如何在主代理尾部加载和注入常驻文件。
15. [RubricMiddleware 自评循环](./deepagents/14-rubric-self-evaluation-loop.md)：Agent 准备结束时，如何按标准决定结束还是再修订一轮。
16. [Examples 实战——better-harness 优化闭环](./deepagents/15-examples-better-harness.md)：外层 Agent 如何修改可编辑 Surface，用 train + holdout 评测接受或拒绝候选。
17. [Evals 评测体系](./deepagents/16-deepagents-evals.md)：如何定义正确与高效、怎么跑、怎么把结果量化成雷达图和评分卡。

Deep Agents 从声明式工厂入口开始，在 LangChain Agent 工厂之上预装长任务常见策略。Harness 能力中，它已有最完整的现成实现，因此 Harness 的细节分析主要放在这一篇章。

入口见 [Deep Agents 源码解析导读](./deepagents/index.md)。

## 五、相关案例与可观测性

### OpenWiki

OpenWiki 作为 Deep Agents 实现的 Wiki 系统案例，重点检查 Harness 组件进入真实应用后的边界：任务如何拆分、资料如何存取、长上下文如何治理、最终产物如何落盘。

### LangSmith 与 Langfuse

- **LangSmith**：观察 LangChain 生态如何记录模型调用、工具执行、图节点、Trace 与评测结果，以及闭源平台与框架的接入边界。
- **Langfuse**：作为开放替代方案，对照 Trace 数据模型、SDK 接入、评测和自托管能力，区分框架绑定能力与通用可观测协议。

可观测性不单独替代调试。Trace 负责呈现执行事实；故障归属仍需回到 State、Middleware、工具和 Backend 的具体边界。
