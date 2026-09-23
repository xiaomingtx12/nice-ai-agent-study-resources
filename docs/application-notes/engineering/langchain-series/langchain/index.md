---
sidebar_position: 1
sidebar_label: LangChain 源码解析导读
description: 从组件调用、Agent 装配与状态流转进入 LangChain 源码，按调用治理、审批、上下文和检索问题选择阅读路线。
---

# LangChain 源码解析：从组件协议到 Agent 运行

本系列沿真实调用链解释 LangChain 的组件协议、Agent 装配和运行机制。正文说明关键对象、数据变化、异常分支与设计取舍，让读者不打开源码也能理解核心实现；每篇头部保留源码相对路径和函数入口，便于按需核对。

> **阅读基线**：LangChain 为 1.3.7，langchain-core 为 1.4.6；RAG 两篇还分析 langchain-classic 1.0.8、langchain-text-splitters 1.1.2。版本对应本文代码，不代表最新版。正文中的 `libs/…` 路径相对 LangChain 仓库根目录，依赖包路径另行说明。

## 一、按问题选择阅读路线

| 想理解什么 | 建议阅读 | 主线 |
| --- | --- | --- |
| 模型、工具与检索器怎样组合 | [00 仓库结构](00-project-overview-and-repository-structure.md) → [01 Runnable 与 LCEL](01-runnable-and-lcel.md) → [02 模型、消息和工具](02-core-abstractions.md) | 构造对象、传递输入、返回结果 |
| Agent 图怎样创建和运行 | [03 工厂装配](03-create-agent-assembly.md) → [04 Middleware](04-middleware-control-plane.md) → [05 State 与运行时](05-state-graph-runtime.md) | 节点与包装器、消息更新、路由和恢复 |
| 怎样组合控制策略 | [06 内置中间件总览](06-middleware-overview.md) → [07 限额、重试与回退](07-call-governance.md) | 图轮次与实际尝试、异常与兜底结果 |
| 工具执行前怎样审批 | [08 HITL](08-human-in-the-loop.md) | 待审调用、人工决定、恢复与消息配对 |
| 上下文和敏感内容在哪里被修改 | [09 上下文与隐私](09-context-and-privacy.md) | State、模型请求与流式事件分别处理 |
| 工具如何取得状态和运行资源 | [10 工具注入](10-tool-injection.md) → [11 工具动态化](11-tool-dynamics.md) | Todo、Shell、文件搜索、预选和模拟 |
| 外部资料怎样成为回答证据 | [12 RAG 组件](12-rag-components-and-retrieval.md) → [13 高级检索](13-advanced-retrieval-techniques.md) | 索引、查询、融合、父子回查和压缩 |

## 二、阅读时分清三类数据

模型请求是本轮给模型看的输入，图状态是节点之间合并和保存的数据，外部资源是工具实际访问的文件、数据库或服务。三者可以关联，但不会自动保持同一事务。

例如 ContextEditingMiddleware 只改模型请求副本；SummarizationMiddleware 会替换当前消息状态；Shell 工具则在图外产生文件或进程副作用。只看最终回答，无法判断旧历史是否仍在、命令是否重复执行或文件是否已经保存。

代码片段均用于解释对应版本的实现，省略位置会标明；应用配置示例用于说明调用方式，不充当框架内部源码。各篇的工程判断以具体分支为依据，不将默认值、模型输出或模拟结果当作业务保证。

## 三、与相邻系列的分工

- [LangGraph](../langgraph/index.md) 解释节点调度、通道、检查点、中断恢复和流事件；这里主要说明 LangChain 如何使用这些能力组装标准 Agent。
- [Deep Agents](../deepagents/index.md) 解释文件 Backend、Skills、Memory、子代理和长任务策略如何接入同一套 Agent 与 Middleware 接口。
- RAG 两篇直接分析 core 与 Classic 中的实际检索实现，可独立阅读。Classic 包归属不影响理解算法，但接入时应单独核对版本与依赖。
