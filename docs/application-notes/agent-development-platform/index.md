---
sidebar_position: 1
---

# Agent 开发平台

这组文档关注的是下面这几个工程问题如何被真正做成系统：

- 一个应用配置怎么变成一条可运行的执行链
- 模型、工具、知识库、工作流怎么被装进同一套运行时
- 哪些能力属于 Agent 主链，哪些能力属于平台外部能力层
- 一个 demo 什么时候开始长出发布、治理、异步任务和租户隔离这些复杂度

沿着这条主线，读者既可以理解关键实现为什么这样拆，也可以按顺序把一套同类平台逐步复现出来；后续回看时，重点经验也更容易重新挂起来。

## 适合谁读

- 已经做过后端服务、AI 应用、自动化流程或 RAG 项目
- 已经知道 LLM、Tool Calling、Workflow、向量检索这些基本概念
- 但还没有系统做过“Agent 开发平台”这类可编辑、可发布、可复用、可运维的项目

## 如果第一次进入这组文档

- 先看 [阅读地图与关键术语](./reading-map-and-key-terms.md)
- 再看 [平台定义与总览](./platform-definition-and-overview.md)
- 然后接 [配置资产与平台底座](./configuration-assets-and-platform-foundation.md) 和 [Agent 运行时与记忆机制](./agent-runtime-and-memory.md)

如果只想先抓主线，先把上面四篇读完就够了。

## 这组文档怎么读

推荐按“先底座，再主链，再扩展能力，最后治理和场景”的顺序读：

1. [阅读地图与关键术语](./reading-map-and-key-terms.md)
2. [平台定义与总览](./platform-definition-and-overview.md)
3. [配置资产与平台底座](./configuration-assets-and-platform-foundation.md)
4. [Agent 运行时与记忆机制](./agent-runtime-and-memory.md)
5. [工具与外部能力平台](./tools-and-external-capabilities.md)
6. [知识库与检索链路](./knowledge-base-and-retrieval-pipeline.md)
7. [Workflow 编排引擎](./workflow-orchestration-engine.md)
8. [平台的 LangChain 组件抽象](./langchain-component-abstractions.md)
9. [平台的 LangGraph 编排骨架](./langgraph-orchestration-kernel.md)

按这个顺序组织，是因为这样读更容易一边理解实现，一边照着复现：

- 先把平台是什么讲清楚
- 再把运行时底座讲清楚
- 再看 Agent 主链和可复用外部能力
- 再看 Workflow 这条独立执行内核
- 最后把治理、发布和实际场景收回来

这条顺序里，第一篇是桥接页，后面六篇是主线正文，最后两篇更适合作为框架层补充回看。

## 读这组文档时最容易卡住的地方

- 一上来就把 `App` 理解成聊天配置表，而不是平台产品对象
- 一上来就钻进单篇实现细节，没有先建立 `App -> 配置资产 -> 运行时 -> 多入口` 的总链路
- 把 Workflow、Tool、RAG 分别看成孤立能力，没有看到它们最后都会回到统一运行时
- 只盯着“能不能跑起来”，没有把草稿态、发布态、运维、沉淀、租户边界一起看进去

## 原来的主线阅读顺序

这组内容的默认主线仍然是下面这条：

1. [平台定义与总览](./platform-definition-and-overview.md)
2. [配置资产与平台底座](./configuration-assets-and-platform-foundation.md)
3. [Agent 运行时与记忆机制](./agent-runtime-and-memory.md)
4. [工具与外部能力平台](./tools-and-external-capabilities.md)
5. [知识库与检索链路](./knowledge-base-and-retrieval-pipeline.md)
6. [Workflow 编排引擎](./workflow-orchestration-engine.md)

## 这一组对外只保留主线阅读路径

这一组文档默认收束为一条主线阅读路径。

主线文档希望直接回答“如果要复现一个 Agent 开发平台，应该先理解什么，再实现什么”。

因此每篇会尽量同时覆盖：

- 这一层解决什么业务问题
- 它在整个平台里的位置
- 它跟前后模块怎么协作
- 它在代码和系统里通常会落成什么结构

更细的实现材料和旧版本材料会继续保留在仓库里，主要作为补写主线文档时的内部参考，不再作为读者阅读入口展示。

## 这组文档现在盯住什么

- 不再只列能力清单，而是讲运行主线
- 不再只写“能做什么”，而是写“为什么这样拆”
- 不再把记忆、知识库、工具、工作流混成一团
- 不再把平台写成聊天壳子，而是写成一套配置资产和运行时系统

## 这里不准备做什么

- 不把所有准备文档都抬成主线正文
- 不做空泛综述式平台介绍
- 不只写页面和功能，不写状态、发布、异步任务和治理问题
