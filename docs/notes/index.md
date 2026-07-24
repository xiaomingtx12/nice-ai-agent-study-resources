---
sidebar_position: 0
description: "方法与复盘栏的定位：从应用拆解里提炼能带到下一次的判断、模式和技巧，目标是封成 skill、让工程判断越攒越准，而不是写完就忘的笔记。"
---

# 方法与复盘

这一栏从应用拆解里提炼能带到下一次的判断、模式和技巧，目标是把它们封成 skill，让工程判断越攒越准。不追求记全方案，追求把关键的那几条写成下次真会回头翻、真会照着校准的文章——而不是写完就忘的笔记。

这也是跨资源、跨项目还能继续复用的东西的存放地：学习方法、踩坑复盘、对 Agent 学习路径的阶段性判断。

## 演变趋势观察

看 AI 工程和工具使用的演变脉络，提炼趋势判断。

- [从 Prompt 到 Loop：四层工程的演变脉络](./evolution-trends/agent-engineering-evolution-prompt-to-loop.md)
- [建立 Agent 设计模式元认知](./evolution-trends/agent-coding-strategy-state-reflect.md)
- [生产级 Agent 应该是什么样的](./evolution-trends/how-to-learn-agent-with-judgment.md)
- [AI 工具使用方式的阶段复盘与经验沉淀](./evolution-trends/ai-coding-learning-method-stage-review.md)

## Agent 产品思维

判断 Agent 产品的场景、形态和人机分工。产品层先回答任务应该怎么完成，再进入具体工程实现。

- [理解 + AI 与 AI Native](./agent-product-method/plus-ai-and-ai-native.md)
- [AI Native 产品怎么设计：执行杠杆、人的决策与不确定性管理](./agent-product-method/ai-native-product-design.md)
- [Agent 产品功能形态图谱：从理解输入到持续推进任务](./agent-product-method/agent-product-functional-form-atlas.md)
- [Agent 自进化：让使用经验进入下一轮](./agent-product-method/agent-self-evolution.md)

## Agent 系统设计

提炼 Agent 系统会用到的工程技巧，先从产品任务与模型不确定性建立第一性原理，再进入具体组件。工程图谱持续总结完整，单个产品按真实问题选择必要部分。Transformer 架构作为理解模型本身的前置项。

- [元组件谱系总览](./agent-system-design/index.md)
- [从 AI 应用开发者的角度理解 Transformer 架构](./agent-system-design/agent-thinking-transformer-from-prompt.md)
- [工程技巧 -> 架构层：提示词、上下文、驾驭为什么起作用](./agent-system-design/agent-engineering-to-architecture.md)
- [Agent 工程的第一性原理：用确定性外框管理不确定性模型](./agent-system-design/agent-engineering-first-principles.md)
- [Agent 大脑篇](./agent-system-design/agent-brain.md)
- [意图识别篇](./agent-system-design/agent-intent-recognition.md)
- [工具调用篇](./agent-system-design/agent-tool-calling.md)
- [Skill 经验封装篇](./agent-system-design/agent-skill-design.md)
- [上下文管理篇](./agent-system-design/agent-context-management.md)
- [多 Agent 编排篇](./agent-system-design/agent-multi-agent-orchestration.md)
- [RAG 工程篇](./agent-system-design/rag-engineering.md)
- [GraphRAG 工程篇](./agent-system-design/graph-rag-engineering.md)
- [RAG 评测篇](./agent-system-design/rag-evaluation.md)
- [Agent 评测篇（骨架）](./agent-system-design/agent-evaluation.md)
- [可观测性篇](./agent-system-design/agent-observability.md)
- [MCP *(暂缓)*](./agent-system-design/agent-mcp.md)

> 暂缓项（MCP / Hooks / 权限 / Agent 行为测评）的工程技巧需要先有真实源码样本才能写，不能凭空立条。详见 [agent-system-design/index.md](./agent-system-design/index.md) 暂缓说明。

## 工具应用与驾驭

提炼 coding agent 的驾驭方法。配置只是门槛，真正决定输出质量的是使用层的方法论和输入质量。

- [Claude Code 用户视角使用篇](./tool-mastery/agent-claude-code-user-perspective.md)
- [Claude Code 项目级集成篇](./tool-mastery/agent-claude-code-project-onboarding.md)
- [Claude Code 引擎透视篇](./tool-mastery/agent-claude-code-engine-perspective.md)
- [实操落地篇：真实任务里会遇到的问题和应对](./tool-mastery/agent-from-paradigm-to-practice.md)

## 市场观察

观察市面 AI 应用的实现形态。

- [构建 Agent Harness 系统：四条引擎路径的对比与企业落地](./market-observation/agent-harness-engine-comparison.md)
- [拆解 CordysCRM-skills：把企业系统装成 Skill 的一个样本](./market-observation/cordys-crm-skill-breakdown.md)

## 这一节该看什么

- 想看演变趋势和脉络判断：演变趋势观察
- 想看 Agent 产品的场景、形态和人机分工：Agent 产品思维
- 想看 agent 系统的元组件和方法论：Agent 系统设计
- 想看工具驾驭方法：工具应用与驾驭
- 想看市面 AI 应用的实现形态：市场观察

## 这一节不放什么

- 单条资源的总览或章节笔记（这属于资源导航）
- 为了留痕而留痕的日常流水账

这些内容都应该回到 [资源导航](../resources/) 下的具体资源目录里。

## 这一栏怎么回喂应用拆解

- 提炼出的判断和技巧，回到应用拆解：下次拆项目时带着更准的问题、更成熟的判断去。
- 目标是把反复用得上的技巧封成 skill，让下一轮真调用它——**这一步现在还没落地**，是方向不是现状。
- 只有真被用上，这一栏才算立住——不然就是条直线收进抽屉。

资源导航是拆解和复盘卡住时随时去查的参考底座。
