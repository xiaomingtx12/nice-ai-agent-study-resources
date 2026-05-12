---
sidebar_position: 3
---

# 怎么把它和 Learn Claude Code 区分开来看

- 来源：[https://ccb.agent-aura.top/docs/introduction/what-is-claude-code](https://ccb.agent-aura.top/docs/introduction/what-is-claude-code)
- 参考仓库：[https://github.com/claude-code-best/claude-code](https://github.com/claude-code-best/claude-code)

## 它们都在讲 Claude Code，但不是一回事

如果只看标题，很容易把 `Learn Claude Code` 和 `CCB` 当成一类资源。

但我现在会很明确地把它们分开：

- `Learn Claude Code` 更像教学式 harness 拆解
- `CCB` 更像逆向式架构剖析

这不是措辞差异，而是学习目标差异。

## Learn Claude Code 更像“怎么搭”

`Learn Claude Code` 的优势在于它会从一个最小 loop 往外长，逐步挂工具、待办、子代理、技能、压缩、任务和团队协作。

它更像一门课程，适合建立手感和实现路径。

## CCB 更像“它为什么长这样”

`CCB` 则更偏分析口径。它把 Claude Code 当成现成产品来拆，重点是解释：

- 为什么是 terminal-native
- 为什么要有 QueryEngine 这一层
- 为什么权限链路要这样走
- 为什么要做压缩、Provider 抽象、遥测和远程配置

它给我的不是“怎么一步步写出来”，而是“这个成熟系统为什么会收敛成现在这个样子”。

## 我会怎么搭配着看

如果我现在想建立 Claude Code 的实现心智，我会先读 `Learn Claude Code`。

如果我已经有了最基本实现感，开始关心产品级边界和治理，我会再读 `CCB`。

一个很实际的用法是：

- 先在 `Learn Claude Code` 里理解 loop、tools、planning、subagents 这些能力怎么挂上去
- 再到 `CCB` 里看这些能力在成熟产品里是怎么被包进更完整的架构里的

这样看，两条资源就不会互相重复，反而会互相补位。
