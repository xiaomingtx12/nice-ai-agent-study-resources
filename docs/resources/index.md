---
sidebar_position: 1
---

# 资源导航

这里放我愿意长期跟踪的 AI 学习资源。

这页的作用不是直接把你送进长文，而是先帮你判断：这条资源现在值不值得继续投入时间。

## 这页怎么用

1. 先看一句判断，判断它是不是你现在该看的东西
2. 如果值得继续看，再展开下面的摘要
3. 真准备深读时，再进入独立资源页、锐评页和学习沉淀页

## 当前收录

### HelloAgents

一句判断：把它当 Agent 学习地图，不要把它当终局答案。

- 类型：Agent 教程 / 中文主线
- 适合谁：已经能跑通模型 API，但还没把工具、记忆、上下文和评估串成系统的人
- 不太适合谁：还没跑过任何模型调用、现在只想找零门槛入门材料的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

它最值钱的地方，是愿意同时碰应用上手和系统设计，帮你先把 Agent 的主要模块串起来看。

#### 锐评

它更适合拿来纠偏和建立地图，不适合指望靠一套教程把所有工程难点一次性学透。

#### 学习沉淀

我先把沉淀集中在“为什么先把它当地图”和“怎么读更划算”这两类判断，后面再继续补正式章节笔记和实验。

- [进入资源页](./hello-agents/)
- [看锐评](./hello-agents/review.md)
- [看学习沉淀](./hello-agents/notes/)
- [官方入口](https://datawhalechina.github.io/hello-agents/)

</details>

### AI Agent Book

一句判断：更像架构和生产化手册，不是轻松顺读型教程。

- 类型：Agent 架构书 / 生产视角
- 适合谁：已经做过一些 Agent 原型，开始关心编排、预算、安全和治理的人
- 不太适合谁：现在只想先把单 Agent demo 跑起来、暂时不关心系统设计的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

它不是在教你拼一个能跑的 demo，而是一路把问题推到多 Agent、生产架构和治理层面。

#### 锐评

信息密度很高，适合带着问题去读；如果前置认知还不够，很容易只记住一堆概念名词。

#### 学习沉淀

我现在主要留下章节级锐评、读法判断和架构手册视角，后续会补多 Agent 编排和生产治理相关笔记。

- [进入资源页](./ai-agent-book/)
- [看锐评](./ai-agent-book/review.md)
- [看学习沉淀](./ai-agent-book/notes/)
- [官方入口](https://www.waylandz.com/ai-agent-book/)

</details>

### Learn Claude Code

一句判断：它最强的地方，不是讲 Agent 全景，而是把 harness 一层层拆开。

- 类型：Agent Harness 教程 / 教学仓库
- 适合谁：已经在用 Claude Code、Codex、Cursor 一类工具，想知道背后机制的人
- 不太适合谁：只想找一套中性 Agent 入门概论，或者对命令行和任务编排完全没兴趣的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

它围绕 Claude Code 这种产品，把 loop、tools、planning、skills、subagents、compression 等机制拆成可理解的教学路径。

#### 锐评

它的对象感非常强，这既是优点，也是边界。你得主动把 Claude Code 视角往通用 harness 模式上提炼。

#### 学习沉淀

我先保留“为什么它更像 harness 拆解课”和“怎么与别的资源搭配着学”两块判断，后面再补核心 session 级笔记。

- [进入资源页](./learn-claude-code/)
- [看锐评](./learn-claude-code/review.md)
- [看学习沉淀](./learn-claude-code/notes/)
- [官方入口](https://learn.shareai.run/zh/s01/)

</details>

### OpenClaw 源码解析

一句判断：它不是入门教材，而是真实 AI 助手网关系统的源码导读。

- 类型：源码导读 / 控制平面
- 适合谁：已经看过一些 Agent 概念或框架资料，想进入真实大型项目源码的人
- 不太适合谁：现在还在补最基础 Agent 心智模型、对 TypeScript 大项目和消息系统不感兴趣的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

这条资源真正值钱的地方，是把消息渠道、控制平面、运行时、扩展体系和安全模型放在同一张图里看。

#### 锐评

它门槛更高，而且和 OpenClaw 项目绑得很深。你需要有能力从具体实现里提炼可迁移的模式。

#### 学习沉淀

我先保留 control plane 视角和防止淹死在大项目细节里的读法，后面会补流水线和运行时主题的专题判断。

- [进入资源页](./openclaw-book/)
- [看锐评](./openclaw-book/review.md)
- [看学习沉淀](./openclaw-book/notes/)
- [官方入口](https://openclaw-book.myhubs.dev/)

</details>

### Claude Code Architecture（CCB）

一句判断：这条资源不是教你做，而是教你拆成熟产品的架构边界。

- 类型：逆向架构文档 / coding agent
- 适合谁：已经在用 coding agent，想继续看权限、压缩、Provider、遥测和配置治理的人
- 不太适合谁：只想最快补一个最小 agent loop、暂时不想碰大型系统治理问题的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

它把 Claude Code 当作 terminal-native agentic coding system 来拆，用五层架构帮助你建立结构感。

#### 锐评

它有很强的逆向分析色彩，需要你主动把“知道 Claude Code 长什么样”提升成“知道为什么这么长”。

#### 学习沉淀

我现在主要留下逆向架构白皮书的定位判断，以及它和 Learn Claude Code 的区分方式，后面会补五层架构与主数据流专题。

- [进入资源页](./claude-code-architecture/)
- [看锐评](./claude-code-architecture/review.md)
- [看学习沉淀](./claude-code-architecture/notes/)
- [官方入口](https://ccb.agent-aura.top/docs/introduction/what-is-claude-code)

</details>

### Easy-Vibe

一句判断：它的强项不是讲得更深，而是把更多人真正带进 AI 编程路径。

- 类型：AI 编程学习路径 / 产品导向
- 适合谁：关心 AI 编程如何入门、如何从原型一路走到部署和持续迭代的人
- 不太适合谁：现在最想补的是 Agent 底层原理、运行时和系统治理深水区的人

<details>
<summary>展开看摘要</summary>

#### 资源总览

它不是普通 Agent 教程，而是一条面向结果的学习路径：从会描述需求，到做出应用、上线、继续迭代。

#### 锐评

覆盖面很广，广度本身就是取舍。它很适合帮你上路，但不该被当成深水区终局知识库。

#### 学习沉淀

我目前重点保留它作为 AI 编程学习路径的定位判断，以及它和站里其他 Agent 资源的边界差异。

- [进入资源页](./easy-vibe/)
- [看锐评](./easy-vibe/review.md)
- [看学习沉淀](./easy-vibe/notes/)
- [官方入口](https://datawhalechina.github.io/easy-vibe/zh-cn/)

</details>
