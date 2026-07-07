---
sidebar_position: 1
---

# Claude Code Architecture（CCB）

- 官网：[https://ccb.agent-aura.top/docs/introduction/what-is-claude-code](https://ccb.agent-aura.top/docs/introduction/what-is-claude-code)
- 项目仓库：[https://github.com/claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)
- 我当前的定位：把它当作一份 Claude Code 的逆向架构白皮书，而不是教学式入门课

## 这条资源在讲什么

这条资源不是在教你怎么从零写一个最小 agent loop，也不是普通的使用手册。它的重心很明确：直接把 Claude Code 当作一个 terminal-native agentic coding system 来拆，去看它到底由哪些层、哪些机制、哪些边界组成。

官网导言和架构总览已经把主线拉得很清楚：Claude Code 不是 IDE 插件，不是云端聊天，也不只是一个 API wrapper；它是一个本地终端里的 agentic coding system，核心能力来自交互层、编排层、核心循环层、工具层和通信层这五层配合。

再往下看，站点并不只停在主循环上，还继续拆了：

- QueryEngine 和 transcript、成本、压缩
- 50+ 工具与权限边界
- 多 Provider 通信层
- Telemetry、远程配置、设置同步
- 管道模式、权限模型、Plan Mode 之类的运行时机制

所以这条资源真正关心的问题是：Claude Code 这样一个成熟 coding agent，到底是怎样被一层层工程化出来的。

## 适合谁

- 已经在用 Claude Code、Codex、Aider 或类似工具，想看更硬核架构拆解的人
- 想从真实产品反推 agent system 边界、权限和运行时设计的人
- 对工具系统、上下文压缩、Provider 抽象、遥测与配置治理感兴趣的人

## 不太适合谁

- 现在只想先知道“Agent 是什么”的人
- 只想快速学一个最小 demo，不想碰大型工程机制的人
- 对逆向分析、架构审计、系统边界没兴趣的人

## 我为什么把它收进来

- 它的视角和前面几条明显不同，更像技术白皮书和架构审计
- 它把 Claude Code 不太显眼但非常关键的部分也掀开了，比如权限、压缩、Provider、遥测和远程配置
- 它很适合拿来训练一种能力：把“这个产品为什么顺手”拆回具体工程部件

## 建议怎么用

我不会把它当作第一条 Claude Code 学习材料。

我更推荐这样用：

1. 先看“什么是 Claude Code”和五层架构总览，先把整体图搭起来。
2. 再看 QueryEngine、核心 loop、工具层和 API 通信层，理解一条主数据流怎么跑完。
3. 最后再按需补权限模型、压缩链路、Telemetry 和远程配置这些更偏治理和基础设施的问题。

## 版权说明

这里记录的是我自己的笔记和判断，不搬运原站点或仓库内容。使用时以原项目说明为准。
