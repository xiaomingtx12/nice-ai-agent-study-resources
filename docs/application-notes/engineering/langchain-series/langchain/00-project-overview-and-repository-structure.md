---
sidebar_position: 2
sidebar_label: 00 项目概览与仓库结构
description: 从 LangChain monorepo 的包边界出发，分清 langchain-core、v1 Agent、Classic、文本切分器和服务商集成各自负责什么。
---

# LangChain 源码 00：项目概览与仓库结构

## 源码定位

> **阅读基线**：`langchain` 1.3.7。  

## 一、LangChain 在三框架中的位置

```text
LangGraph
  └─ 图调度、状态合并、Checkpoint、Interrupt
       ↓
LangChain
  └─ 模型、工具、检索等抽象；Runnable/LCEL；标准 Agent 工厂
       ↓
Deep Agents
  └─ 面向长任务预装文件、技能、记忆、子 Agent 与上下文治理
```

LangChain 的工程价值是把不同服务商与不同业务组件收敛为可组合协议。在这个收敛目标下，它内部有两条能力主线，划分依据是**数据流是否在构造期确定**：

| 主线 | 数据流形态 | 对应文章 |
| --- | --- | --- |
| core 协议 + LCEL | 步骤和输入输出在链构造时已经固定 | [01 Runnable 抽象与 LCEL](./01-runnable-and-lcel.md)、[02 聊天模型、消息与工具](./02-core-abstractions.md) |
| v1 `create_agent()` + Middleware | 下一步由模型根据中间结果临时决定 | [03 工厂](./03-create-agent-assembly.md)、[04 Middleware](./04-middleware-control-plane.md)、[05 Runtime](./05-state-graph-runtime.md) |

两条主线共享同一批 core 数据对象；区别在于循环、状态与恢复是否需要框架代为管理。RAG 横跨两条主线：检索结果既可作固定链中的一步，也可包装成 Agent 的工具（[12：RAG 组件与检索链路](./12-rag-components-and-retrieval.md)）。

## 二、`libs/` 目录地图：发布包边界先于实现细节

```text
libs/
├── core/                 # langchain-core：稳定基础协议
├── langchain_v1/         # langchain：v1 的高层入口与 Agent 装配
├── langchain/            # langchain-classic：旧 API 兼容层
├── text-splitters/       # langchain-text-splitters：文本切分实现
├── partners/             # 一部分官方维护的 provider / vector store 集成
└── standard-tests/       # 集成包要遵守的标准行为测试
```

### 1. core 是协议根

`libs/core/langchain_core/` 放的是可跨服务商复用的抽象：模型输入输出、消息与 Prompt、`Runnable` 组合原语、`BaseTool` 与参数 Schema、`Document` / Loader / Embeddings / VectorStore / Retriever 协议。v1 工厂接收这些契约，不重复实现；各协议的具体输入输出边界在 [02 聊天模型、消息与工具](./02-core-abstractions.md) 展开。

### 2. v1 `langchain` 是装配层

`libs/langchain_v1/langchain/` 的重点是 Agent、Middleware 与便利工厂：`agents/factory.py` 的 `create_agent()` 把 core 协议、LangGraph 节点和 Middleware 组装成标准 Agent 图，`chat_models/base.py` 提供 `init_chat_model()` 这类模型初始化入口。图调度、状态持久化和中断恢复仍属于 LangGraph Runtime。

### 3. `langchain`（Classic）是兼容层，不混入 v1 主线

`libs/langchain/` 发布为 `langchain-classic`，保留 `AgentExecutor`、旧 RetrievalQA / retrieval chain 等历史 API 用于存量迁移。它的 Agent 生命周期和运行时边界与 v1 不同，不用于解释 v1 的 `create_agent()`；正文遇到 `langchain_classic` 时会明确标出，避免把旧 API 当作 v1 推荐装配方式。

### 4. 实现与集成按发布边界外移

文本切分在 `libs/text-splitters/`，`RecursiveCharacterTextSplitter` 通过可选依赖进入 RAG 管道。`libs/partners/` 只包含部分官方维护的集成，OpenAI、Anthropic、向量库及很多 Loader 的具体实现是独立包甚至独立仓库。core 的责任是定义“模型 / Embedding / VectorStore 必须提供什么方法”，不维护厂商实现；`standard-tests` 用统一测试约束集成行为。

## 三、包边界决定阅读顺序

后续文章按依赖方向排列，而不是按 API 复杂度：

```text
00 仓库与包边界
  → 01 核心对象与 Runnable 协议
  → 02 LCEL 表达式如何组合确定步骤
  → 03 create_agent 如何为不确定步骤加入工具循环
  → 04 Middleware 如何在循环上加入控制面
  → 05 LangGraph Runtime 如何执行、保存和恢复该图
  → 06 RAG 如何把外部资料接入链或工具
  → 07 Deep Agents 如何在同一扩展面上增加长任务默认策略
```

这不是顺序偏好：`create_agent()` 的 `model`、`tools`、`middleware` 参数本身就是 core 协议的实例，不先读协议，工厂代码里的 `BaseChatModel`、`BaseTool`、`ToolNode` 都会成为未解释的符号。

阅读范围也可以裁剪：步骤固定、只需一次或少量模型调用的任务，LCEL 往往比 Agent 更直接；需要自定义图拓扑、复杂恢复或非标准循环时再下沉 LangGraph。选择标准见 [01 篇"Runnable 抽象与 LCEL"](./01-runnable-and-lcel.md#八runnable-在-agent-中的实际位置)。
