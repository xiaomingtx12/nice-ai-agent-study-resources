---
title: OpenWiki：LLM Wiki 的一个真实实现
description: 先讲清楚 LLM Wiki 这个概念（编译而不是检索），再逐层拆解 OpenWiki 项目的真实实现：编译流水线、Grounded Claims、检索、OKF 收尾与连接器。
sidebar_position: 0
---

# OpenWiki：LLM Wiki 的一个真实实现

OpenWiki 是 LangChain 开源的一个 Deep Agents 应用（[langchain-ai/openwiki](https://github.com/langchain-ai/openwiki)）。它读取一个代码仓库（或你的个人知识来源），把散落在源码、配置和测试里的知识**编译**成一组互相链接的 Markdown 页面，放在仓库的 `openwiki/` 目录里。这些页面由 git 版本控制，工程师可以直接读，编程 Agent 也可以按问题检索。

它不是"帮你总结一下这个仓库"的一次性工具。代码变了，它会基于每条事实记录的证据判断哪些页面需要重新核对；知识会随时间累积，而不是每次从零开始。

## 先建立概念，再读实现

如果你还不清楚"LLM Wiki"和普通 RAG 的区别，先读 [00：什么是 LLM Wiki](./00-llm-wiki-concept.md)。那一篇讲三件事：

- 普通检索式 RAG 的三个毛病：每次重新理解、知识不累积、跨文档关联弱；
- LLM Wiki 的另一条路：**主动编译**——读资料、提取概念、写成结构化页面，三层分离（raw / wiki / schema），`index.md` 导航、`log.md` 审计，git 做版本控制；
- 三种基本操作：Ingest（导入编译）、Query（查询）、Lint（维护）。

OpenWiki 就是这套思想的一个完整工程实现。后面的文章按这三种操作展开它的真实源码。

## 目录

| 篇目 | 内容 | 对应概念 |
| --- | --- | --- |
| [00 什么是 LLM Wiki](./00-llm-wiki-concept.md) | 概念本身，以及 OpenWiki 如何逐条落地 | — |
| [01 项目全景](./01-project-overview.md) | 项目产出什么、源码怎么分层、两条执行路径 | 整体 |
| [02 编译：一次生成的完整生命周期](./02-generation-lifecycle.md) | begin → 规划 → 逐页写作 → 提交 → finish，以及三个持久化状态文件 | Ingest |
| [03 编译：规划器与页面 worker 的装配](./03-agents-and-tools.md) | Deep Agents 工厂参数、工具权限、并发与失败处理 | Ingest |
| [04 证据层：Grounded Claims](./04-claims.md) | 每条事实如何挂上版本化源码证据，代码变化后如何被重新核对 | Ingest / Lint |
| [05 检索与跨仓库工作区](./05-retrieval-and-workspaces.md) | `openwiki_search` / `openwiki_read` 的 FTS5 排序、工作区范围选择 | Query |
| [06 Lint 与收尾：OKF、front matter 与校验](./06-finalize-and-okf.md) | 确定性收尾五步：mermaid、index、链接、证据投影、来源戳记 | Lint |
| [07 个人 Wiki 与连接器](./07-personal-wiki-and-connectors.md) | personal 模式的另一条 Ingest 流水线 | Ingest |
| [08 宿主集成与运行环境](./08-host-integration-and-runtime.md) | 安装注册表、MCP 契约、宿主会话管理、模型配置、遥测与 CLI | 运行环境 |

只想看懂怎么用，读 00 和 01 就够。想理解"知识为什么不健忘"，重点读 02 和 04。想理解"生成的东西怎么被别的 Agent 用上"，读 05。

## 源码基线

本系列对照本地源码逐行核对，基线固定：

- OpenWiki `0.7.2`，提交 `27b3c76cb9b28bc3bb31ccbeb4f0192b0802cf96`
- `deepagents@1.13.2`（JavaScript/TypeScript 版 Deep Agents），`langchain@1.5.10`，以锁文件为准
- Node `>= 22.22.0`

文中代码片段都来自这个提交，标注了文件与函数名，可直接在仓库里定位。省略处用注释标明，保留的英文注释译成中文。

文中引用的"真实样本"来自两个实际生成的 wiki：

- Open SWE 仓库里实际生成的 `openwiki/`，用来展示页面、Claims、`.last-update.json` 的真实样子；
- OpenWiki 给自己生成的 `openwiki/`，用来展示 `.page-manifest.json`。

`.run.json` 在运行结束时会被删除，没有真实样本，相应字段按 schema 构造并注明。
