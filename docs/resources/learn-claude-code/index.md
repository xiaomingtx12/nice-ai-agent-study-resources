---
sidebar_position: 1
---

# Learn Claude Code

- 官网：[https://learn.shareai.run/zh/s01/](https://learn.shareai.run/zh/s01/)
- 项目仓库：[https://github.com/shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)
- 我当前的定位：把它当作一门“agent harness 拆解课”，而不是通用 Agent 概论

## 这条资源在讲什么

这条资源最特别的地方，不是又讲了一遍“Agent 是什么”，而是直接把 Claude Code 这一类产品往回拆，去讲支撑它的那套 harness 到底是怎么长出来的。

官方中文站从 `s01` 开始，把内容分成“核心闭环、系统加固、任务运行时、多 Agent 平台”几层来讲；仓库 README 也明确把核心主题写成 loop、tools、planning、skills、context compact、tasks、teams、worktree isolation 这些机制。

换句话说，它关心的不是抽象概念够不够全，而是：

- 一个最小 agent loop 怎么搭
- 工具、计划、技能、压缩怎么一层层挂上去
- 为什么 Claude Code 这类 agent 产品不是“模型自己突然会干活”，而是 harness 把能力组织出来了

## 适合谁

- 已经用过 Claude Code、Codex、Cursor 或类似工具，想知道它们背后机制的人
- 不满足于“能用”，想继续追问 agent harness 怎么设计的人
- 想从具体实现倒推 Agent 系统组成的人

## 不太适合谁

- 现在只想找一套泛化 Agent 入门概论的人
- 对命令行、工具执行、任务编排这些实现细节没有兴趣的人
- 还没接触过任何 agent 产品，就想靠它完成零门槛启蒙的人

## 我为什么把它收进来

- 它有非常鲜明的对象感：不是讲“所有 AI”，而是围绕 Claude Code 这种 agent harness 展开
- 它把很多产品层面的“爽点”拆回了工程机制，这一点很有学习价值
- 它不是纯源码仓库，也不是纯概念文档，而是把教学站点和参考实现绑在一起，适合边看边对照

## 建议怎么用

我不会把它当第一条 Agent 学习资源，也不会把它当成框架 API 手册来背。

我更推荐这样用：

1. 如果你已经用过 Claude Code 一类产品，先从 `s01` 到 `s06` 看核心闭环、工具、待办、子代理、技能、压缩这些基础机制。
2. 如果你正在关心更完整的运行时和协作问题，再继续看权限、任务、后台任务、Agent 团队和隔离执行。
3. 每看一节，都问自己一句：这里讲的是 Claude Code 特有实现，还是以后换产品也成立的 harness 模式。

## 版权说明

这里记录的是我自己的笔记和判断，不搬运原站点或仓库内容。使用时以原项目说明为准。
