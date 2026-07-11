---
sidebar_position: 1
description: Claude Certified Architect 把 Claude Code / Agent 这套知识按认证考点重新组织一遍，多语言指南 + PDF，覆盖工具设计、MCP、结构化输出这类场景题。它不是新机制，是把 harness 拆解课的零散点串成自测用的知识体系。
---

# Claude Certified Architect（非官方 / 社区资料）

- 官网：[https://github.com/paullarionov/claude-certified-architect](https://github.com/paullarionov/claude-certified-architect)
- 我当前的定位：把它当作一份**非官方社区资料**——Claude Code / Agent 知识体系的认证梳理，而不是新的机制课。它**不是** Anthropic 官方出品的认证或教材。

## 这条资源在讲什么

这条资源的形态和前面几条都不一样：`Learn Claude Code` 是从机制往外搭，`Claude Code Architecture（CCB）` 是从产品往里逆向。这一条反过来——它把已经散落的 harness 知识按认证结构重新整理，多语言指南加 PDF 自测题，覆盖工具设计、MCP 集成、结构化输出这几类典型场景。

它的价值不在讲新东西，而在做两件事：

- 把 loop、tools、permissions、context、skills、MCP 这些零散点串成一份能自测的知识体系
- 提供场景化题目，让你判断"这种配置/这种调用方式，在 Claude Code 这类产品里到底算对还是错"

也就是说，它不是 source of truth，而是 source of self-check。

## 适合谁

- 已经用过 Claude Code / Codex / 类似 coding agent，想系统梳理一遍知识盲区的人
- 准备面试或认证考试，想用场景题自测熟练度的人
- 看完 `Learn Claude Code` 之后觉得知识点散、需要一张总图的人

## 不太适合谁

- 现在还没用过任何 coding agent，只想找零门槛入门的人
- 想靠它学到 loop / 权限 / 压缩这套机制的真实工程深度的人——它给的是考点，不是机制课
- 想找真实大型系统源码阅读的人——它是题库型资料，不是源码

## 我为什么把它收进来

- 它补的是站内当前缺的那一类资源：**知识体系化梳理 + 场景自测**
- 它跟 `Learn Claude Code`、`CCB` 不重复——`Learn` 给机制，`CCB` 给逆向白皮书，这一条给考点框架
- 它的多语言和 PDF 形态让它在复习阶段比纯站点更顺手
- 它对"我现在的 Claude Code / Agent 知识是不是真的立住了"是个不错的体检表

## 建议怎么用

我不会把它当作学习起点，也不会拿它替代机制课和逆向白皮书。

我更推荐这样用：

1. 先按 `Harness / Coding Agent` 这一组的顺序走完 `Learn Claude Code`（机制）和 `Claude Code Architecture（CCB）`（逆向），把直觉立起来。
2. 再来这一条做知识体系梳理和场景自测，找出自己其实没真正搞清的盲点。
3. 自测时重点关注工具设计、MCP 集成、结构化输出这几块——它们是认证里最容易把"会用"误判成"懂了"的区域。

## 版权说明

这里记录的是我自己的笔记和判断，不搬运原仓库内容。使用时以原项目说明为准。
