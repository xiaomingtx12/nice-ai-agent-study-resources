---
sidebar_position: 1
sidebar_label: LangChain 源码解析导读
description: 从 LangChain monorepo 的包边界、核心抽象与 Runnable 协议，到 LCEL 表达式、create_agent()、Middleware、RAG 和 Deep Agents 装配，建立 LangChain v1 的源码阅读坐标。
---

# LangChain 源码解析：从核心抽象到 Agent 装配

这一组先从 LangChain 的组件协议和 Runnable 组合原语进入，再沿 `create_agent()` 的真实装配顺序拆开模型、工具、状态、Middleware 与 LangGraph Runtime 的边界。

:::tip 先抓住一句话
LangChain 的核心价值不是替模型调用提供一层包装，而是把模型、消息、Prompt、工具、文档、Retriever 和 Agent Middleware 收敛到可组合的协议；`create_agent()` 再把这些协议装配成一张运行在 LangGraph 上的标准 Agent 状态图。
:::

## 推荐顺序

1. [00：项目概览与仓库结构](./00-project-overview-and-repository-structure.md)：先确认 `core`、`langchain_v1`、Classic 和集成包的责任边界。
2. [01：Runnable 抽象与 LCEL](./01-runnable-and-lcel.md) → [02：聊天模型、消息与工具](./02-core-abstractions.md)：先理解统一的 Runnable 执行协议和组合语法，再追踪核心对象如何实现这套协议。
3. [03：`create_agent()` 如何组装 Agent 图](./03-create-agent-assembly.md) → [04：Middleware 执行边界](./04-middleware-control-plane.md) → [05：State、Graph 与运行时](./05-state-graph-runtime.md)：沿工厂、扩展点和 LangGraph 执行边界读 Agent 主线。
4. [06：内置中间件总览](./06-middleware-overview.md) → [07：调用治理](./07-call-governance.md) → [08：HITL](./08-human-in-the-loop.md) → [09：上下文与隐私](./09-context-and-privacy.md) → [10：工具注入](./10-tool-injection.md) → [11：工具动态化](./11-tool-dynamics.md)：按治理问题选择中间件专题。
5. [12：RAG 组件与检索链路](./12-rag-components-and-retrieval.md) → [13：RAG 高级检索技术](./13-advanced-retrieval-techniques.md)：沿 Loader、Document、Splitter、Embedding、VectorStore 和 Retriever 追踪外部知识。

## 与相邻专栏的边界

- LangGraph 负责图状态、调度、持久化、中断和事件；LangChain 负责把标准 Agent 循环装配到这套 Runtime 上。
- Deep Agents 复用 LangChain 的 Agent 与 Middleware 扩展面，增加面向长任务的 Backend、Skills、Memory、SubAgent、Summarization 和评测装配。
