---
sidebar_position: 1
---

# 资源导航

这里不是把链接堆上来的地方。

这页只做一件事：先帮你判断，你现在最该投入的是哪一类 AI 学习资源。

## 这页怎么用

1. 先按自己当前的缺口选分类，不要一上来平均扫所有资源。
2. 再看每条资源的一句判断、适合谁和不适合谁。
3. 真准备深读时，再进入它的资源页、锐评页和学习沉淀页。

## 先按需求选资源

- 想先把 Agent 的主线地图搭起来： [HelloAgents](./hello-agents/)
- 想边做项目边把 Agent 路径走通： [AI Agents From Zero](./ai-agents-from-zero/)
- 想从 AI 编程入口一路走到产品落地： [Easy-Vibe](./easy-vibe/)
- 想理解 coding agent harness 为什么能工作： [Learn Claude Code](./learn-claude-code/)
- 想拆成熟 coding agent 的架构边界： [Claude Code Architecture（CCB）](./claude-code-architecture/)
- 想补多 Agent、生产架构和治理视角： [AI Agent Book](./ai-agent-book/)
- 想看真实大型系统怎么把控制平面和运行时揉在一起： [OpenClaw 源码解析](./openclaw-book/)

## 学习地图与路径

这一组解决的不是“某个 API 怎么调”，而是“我现在该怎么上路”。

适合还在建立全局地图、学习顺序和项目切入点的人；不适合指望靠一条资源直接吃透所有工程深水区的人。

### HelloAgents

一句判断：先拿它搭 Agent 地图，再决定往哪块深挖。

- 类型：Agent 教程 / 中文主线
- 适合谁：已经能跑通模型 API，但还没把工具、记忆、上下文和评估串成系统的人
- 不适合谁：还没跑过任何模型调用、现在只想找零门槛入门材料的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：愿意同时碰应用上手和系统设计，适合先把 Agent 的主要模块串成一张图。

最容易误用的地方：把它当成终局教材，指望靠一套教程一次性吃透所有工程难点。

入口：
- [进入资源页](./hello-agents/)
- [看锐评](./hello-agents/review.md)
- [看学习沉淀](./hello-agents/notes/)
- [官方入口](https://datawhalechina.github.io/hello-agents/)

</details>

### AI Agents From Zero

一句判断：如果你想靠项目把 Agent 真正做起来，它比纯概念导览更合适。

- 类型：Agent 实战路径 / 从零到项目
- 适合谁：想从零一路做到 workflow、MCP、RAG 和项目落地的人
- 不适合谁：现在只想先建立高层地图、不准备跟着实操的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：把基础、提高、项目和知识库放在同一条主线上，逼你在动手里补 Agent 认知。

最容易误用的地方：把“项目做通一次”误解成“已经掌握了可迁移的方法和判断”。

入口：
- [进入资源页](./ai-agents-from-zero/)
- [看锐评](./ai-agents-from-zero/review.md)
- [看学习沉淀](./ai-agents-from-zero/notes/)
- [官方入口](https://didilili.github.io/ai-agents-from-zero/#/)

</details>

### Easy-Vibe

一句判断：它的强项不是系统深挖，而是把更多人真正带进 AI 编程路径。

- 类型：AI 编程学习路径 / 产品导向
- 适合谁：关心 AI 编程如何入门、如何从原型一路走到部署和持续迭代的人
- 不适合谁：现在最想补的是 Agent 底层原理、运行时和系统治理深水区的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：不是只给你原型爽感，而是试着把学习路径一直拉到真实数据、部署、知识库和持续迭代。

最容易误用的地方：把“会说需求就能做产品”的前期体验，误当成后面系统复杂度也已经被解决了。

入口：
- [进入资源页](./easy-vibe/)
- [看锐评](./easy-vibe/review.md)
- [看学习沉淀](./easy-vibe/notes/)
- [官方入口](https://datawhalechina.github.io/easy-vibe/zh-cn/)

</details>

## Harness / Coding Agent

这一组不是泛 Agent 入门，而是专门回答：Claude Code、Codex、Cursor 这类东西为什么能工作。

适合已经在用 coding agent，想继续追问 loop、tools、planning、compression、权限和架构边界的人；不适合完全没接触过这类产品、只想先补中性概论的人。

### Learn Claude Code

一句判断：它最值钱的不是结论，而是把 harness 从 loop 一层层拆开。

- 类型：Agent Harness 教程 / 教学仓库
- 适合谁：已经在用 Claude Code、Codex、Cursor 一类工具，想知道背后机制的人
- 不适合谁：只想找一套中性 Agent 入门概论，或者对命令行和任务编排完全没兴趣的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：围绕 Claude Code 这类产品，把 loop、tools、planning、skills、subagents、compression 等机制拆成可理解的教学路径。

最容易误用的地方：只记住 Claude Code 的表层对象感，却没有继续往上提炼成通用 harness 模式。

入口：
- [进入资源页](./learn-claude-code/)
- [看锐评](./learn-claude-code/review.md)
- [看学习沉淀](./learn-claude-code/notes/)
- [官方入口](https://learn.shareai.run/zh/s01/)

</details>

### Claude Code Architecture（CCB）

一句判断：这条资源不是教你做，而是教你拆成熟 coding agent 的架构边界。

- 类型：逆向架构文档 / coding agent
- 适合谁：已经在用 coding agent，想继续看权限、压缩、Provider、遥测和配置治理的人
- 不适合谁：只想最快补一个最小 agent loop、暂时不想碰大型系统治理问题的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：把 Claude Code 当成 terminal-native agentic coding system 来拆，帮你从五层架构和主数据流理解它为什么会长成这样。

最容易误用的地方：只把它看成“Claude Code 使用说明补充”，而不是一份能训练架构判断的逆向分析材料。

入口：
- [进入资源页](./claude-code-architecture/)
- [看锐评](./claude-code-architecture/review.md)
- [看学习沉淀](./claude-code-architecture/notes/)
- [官方入口](https://ccb.agent-aura.top/docs/introduction/what-is-claude-code)

</details>

## 架构与生产化

这一组关心的不是“先把 demo 跑起来”，而是多 Agent、编排、预算、安全、治理和生产环境里的长期复杂度。

适合已经做过一些 Agent 原型、开始关心系统设计的人；不适合现在还在找第一条上手路径的人。

### AI Agent Book

一句判断：它更像架构和生产化手册，不是轻松顺读型教程。

- 类型：Agent 架构书 / 生产视角
- 适合谁：已经做过一些 Agent 原型，开始关心编排、预算、安全和治理的人
- 不适合谁：现在只想先把单 Agent demo 跑起来、暂时不关心系统设计的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：不是在教你拼一个能跑的 demo，而是一路把问题推到多 Agent、生产架构和治理层面。

最容易误用的地方：前置认知还没到位时硬啃，最后只记住一堆概念名词，没有形成可用的系统判断。

入口：
- [进入资源页](./ai-agent-book/)
- [看锐评](./ai-agent-book/review.md)
- [看学习沉淀](./ai-agent-book/notes/)
- [官方入口](https://www.waylandz.com/ai-agent-book/)

</details>

## 源码与真实系统

这一组解决的是“真实大型系统到底怎么把这些概念落实到工程里”，不是轻教学、轻入门型材料。

适合已经看过一些概念和框架资料、想进入真实项目源码的人；不适合现在还在补最基础心智模型的人。

### OpenClaw 源码解析

一句判断：它不是入门教材，而是真实 AI 助手网关系统的源码导读。

- 类型：源码导读 / 控制平面
- 适合谁：已经看过一些 Agent 概念或框架资料，想进入真实大型项目源码的人
- 不适合谁：现在还在补最基础 Agent 心智模型、对 TypeScript 大项目和消息系统不感兴趣的人

<details>
<summary>展开看判断</summary>

它最值钱的地方：把消息渠道、控制平面、运行时、扩展体系和安全模型放在同一张图里看，能帮助你从真实系统里提炼结构。

最容易误用的地方：一路陷进项目细节，却没有主动抽象出可迁移的模式和工程判断。

入口：
- [进入资源页](./openclaw-book/)
- [看锐评](./openclaw-book/review.md)
- [看学习沉淀](./openclaw-book/notes/)
- [官方入口](https://openclaw-book.myhubs.dev/)

</details>
