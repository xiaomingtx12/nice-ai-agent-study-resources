---
sidebar_position: 1
description: Learn Claude Code 不是通用 Agent 概论，而是把 Claude Code 这类产品回拆成 harness 机制，从 agent loop、工具、计划、技能、压缩到任务、团队、worktree 隔离一层层挂上去，看产品爽点背后的工程组成。
---

# Learn Claude Code

- 官网：[https://learn.shareai.run/zh/s01/](https://learn.shareai.run/zh/s01/)
- 项目仓库：[https://github.com/shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)

## 这条资源主要在讲什么

它不再讲一遍"Agent 是什么"，而是直接把 Claude Code 这一类产品往回拆，去讲支撑它的那套 harness 到底怎么长出来的。官方中文站从 `s01` 起，把内容分成核心闭环、系统加固、任务运行时、多 Agent 平台几层。

它关心的不是抽象概念够不够全，而是：一个最小 agent loop 怎么搭，工具、计划、技能、压缩怎么一层层挂上去，为什么 Claude Code 不是"模型突然会干活"，而是 harness 把能力组织出来了。

```mermaid
flowchart TB
  L0["最小 agent loop"]
  subgraph L1["核心闭环 s01–s06"]
    T["工具"] --> TD["待办"] --> SA["子代理"] --> SK["技能"] --> CP["上下文压缩"]
  end
  subgraph L2["运行时 + 多 Agent 平台"]
    PM["权限"] --> TK["任务 / 后台任务"] --> TM["Agent 团队 / worktree 隔离"]
  end
  L0 --> L1 --> L2
```
