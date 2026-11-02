---
sidebar_position: 0
description: 按项目类型整理工程源码解析，覆盖运行时与框架、应用构建平台、完整应用、质量基础设施和扩展生态。
---

# 工程化源码解析

本栏以单个项目为主语，选择其中有代表性的工程问题深入源码。项目可以是 Agent 框架、开发平台、完整应用或配套基础设施；收录依据是具体实现价值和可核验证据。

一组解析不要求覆盖项目全貌。Dify 可以只深挖应用配置和工作流执行，Coze Studio 可以先研究编辑对象怎样发布为运行版本，AgentScope 可以先追 Agent 循环与人工确认。其他模块在产生明确问题后再补。

## 项目类型只是索引

项目类型用于建立阅读坐标，不决定文章结构。跨项目比较栏目待建，用户路径与业务效果进入[产品业务](../product/index.md)。

| 项目类型 | 主要研究对象 | 已有内容 | 候选项目与方向 |
| --- | --- | --- | --- |
| 运行时与框架 | Agent 循环、状态、工具、中间件、多 Agent、恢复 | [LangChain 系列](./langchain-series/index.md) | AgentScope：循环、上下文、人工确认；Pydantic AI：类型契约、运行与测试 |
| 应用构建平台 | 应用、工作流、知识库、插件、发布、租户 | [Agent 平台迭代记录](./agent-platform-iteration/index.md)（自建平台后端的时间线复盘） | Coze Studio：业务对象与发布链路；FastGPT：知识库与 Flow 编排；RAGFlow：文档处理与检索链路 |
| 完整 Agent 应用 | 任务入口、执行环境、结果交付、人在环路 | [OpenWiki](./deepagents应用案例解析/openwiki/index.md)、[Open SWE](./deepagents应用案例解析/open-swe/index.md)、[Octop](./octop/index.md) | OpenHands：代码任务与工作区；其他项目按具体任务价值加入 |
| 质量与运行基础设施 | Trace、评测、数据集、实验、提示词与线上反馈 | 暂无独立系列 | Coze Loop、Langfuse、Phoenix、Opik |
| Agent 开发平台应用 | 平台上搭建的应用：编排、知识库、工具、发布配置 | 暂无已发布案例 | Dify、Coze、FastGPT 上的官方模板或公开应用定义 |

表中的候选项目只是研究池。正式立项前需要固定仓库、commit、依赖和待验证问题。在线商业版本与开源仓库分别记录，不用一方推断另一方。
