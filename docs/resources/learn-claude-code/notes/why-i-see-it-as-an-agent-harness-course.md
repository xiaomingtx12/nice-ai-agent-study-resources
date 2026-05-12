---
sidebar_position: 2
---

# 为什么我把它看成“agent harness 拆解课”

- 来源：[https://learn.shareai.run/zh/s01/](https://learn.shareai.run/zh/s01/)
- 参考仓库：[https://github.com/shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)

## 我的第一判断

这条资源最值得看的，不是“Claude Code”这四个字本身，而是它借 Claude Code 这类产品，去讲一套 agent harness 是怎么被搭出来的。

很多 Agent 教程讲的是概念、框架或案例，这条资源更像产品机制拆解。它不是问“Agent 是什么”，而是问：“一个好用的 coding agent，外面到底套了哪些机制，才从模型变成了工具。”

## 我为什么会这么看

有两个信号特别明显。

第一，官网中文站的章节组织方式很工程化。它不是随便列话题，而是按“核心闭环、系统加固、任务运行时、多 Agent 平台”往外长。这很像在拆系统，而不是在写一套泛化教材。

第二，仓库 README 的主线非常克制。它反复强调核心 loop，也反复强调 harness 机制是一层层加上去的，比如工具调度、待办规划、技能注入、上下文压缩、任务系统、团队协作、隔离执行。

这套讲法最打动我的地方在于：它没有把 agency 说成模型自带魔法，而是说成“模型能力 + harness 组织”的结果。

## 这对我有什么价值

如果我只是想用 Claude Code，这条资源当然不是必需的。

但如果我想进一步理解：

- 为什么某些 agent 产品用起来顺
- 为什么它们不是只靠 prompt 在撑
- 如果我要自己做一套类似东西，关键控制点在哪

那这条资源就会变得很有用。

## 一个边界提醒

它很强，但它不是全景地图。

它更像显微镜，照的是 Claude Code 这条路上的 harness 设计；如果我要补全 Agent 世界的其他面向，还是要和地图型、架构型资源搭配着看。
