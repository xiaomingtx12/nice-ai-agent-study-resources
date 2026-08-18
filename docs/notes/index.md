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

提炼 Agent Harness 的元组件方法。文章面向人阅读，但按问题选择合适的写法：上下文写装配和预算，记忆写生命周期，RAG 写离线/在线数据链，Skill 写激活与版本。方法正文不复述本地应用拆解，后续可沉淀成 Skill。Transformer 是理解模型本身的前置项，不计入运行时元组件。

- [元组件谱系总览](./agent-system-design/index.md)

**模型前置知识**

- [从 AI 应用开发者的角度理解 Transformer 架构](./agent-system-design/00-prerequisites/agent-thinking-transformer-from-prompt.md)
- [工程技巧 -> 架构层](./agent-system-design/00-prerequisites/agent-engineering-to-architecture.md)
- [Agent 工程的第一性原理](./agent-system-design/00-prerequisites/agent-engineering-first-principles.md)

**Task：任务合同**

- [任务合同与输入路由](./agent-system-design/01-task/agent-intent-recognition.md)

**View：上下文、知识与经验**

- [上下文装配](./agent-system-design/03-view/agent-context-management.md)
- [记忆设计：存什么，何时读，何时忘](./agent-system-design/03-view/agent-memory-design.md)
- [上下文压缩与外部化](./agent-system-design/03-view/agent-context-compression.md)
- [Skill 激活与经验封装](./agent-system-design/03-view/agent-skill-design.md)
- [RAG 工程：离线建库到在线证据链](./agent-system-design/03-view/rag-engineering.md)
- [GraphRAG：什么时候值得建图](./agent-system-design/03-view/graph-rag-engineering.md)
- [知识编译：LLM-Wiki](./agent-system-design/03-view/llm-wiki-knowledge-compilation.md)

**Decision：决策与协作**

- [控制平面：Workflow、Agent Loop 与协作](./agent-system-design/04-decision/agent-vs-workflow-architecture.md)
- [决策内核：Agent 大脑](./agent-system-design/04-decision/agent-brain.md)
- [多 Agent 协作：主控-子 Agent、同步/异步与 Agent Team](./agent-system-design/04-decision/agent-multi-agent-orchestration.md)

**Action：能力、权限与执行空间**

- [能力执行：Tool 合同与副作用](./agent-system-design/05-action/agent-tool-calling.md)
- [权限、审批与结果验收](./agent-system-design/05-action/agent-permission-and-postconditions.md)
- [Agent 操作空间：沙箱、工作区与资源边界](./agent-system-design/05-action/agent-workspace-sandbox.md)

**Observation：观察与评测**

- [证据与反馈](./agent-system-design/06-observation/agent-observability.md)
- [Agent 评测](./agent-system-design/06-observation/agent-evaluation.md)

**State：状态与恢复**

- [Agent 状态：事实连续性、恢复与执行边界](pathname:///notes/agent-system-design/state/agent-state-architecture)

**横切概念**

Harness 不单独占一个目录；它把 View、Action、Observation 和 State 中的预算、权限、沙箱、取消、恢复、验收和反馈约束串起来。

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
- [电商场景的 AI 应用：八个项目其实是一条数据链](./market-observation/ecommerce-ai-application.md)

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
