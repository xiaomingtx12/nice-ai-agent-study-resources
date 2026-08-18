---
sidebar_position: 0
description: 围绕模型决策闭环整理 Agent 工程组件，说明每一层解决什么问题、与其他层如何协作，以及应该从哪里继续阅读。
---

# Agent 工程技巧

这一栏聚焦 Agent 系统无论使用框架还是纯代码都必须解决的工程问题。

框架可以封装模型调用、工具注册、状态保存、流程编排和多 Agent 调度，减少重复实现；但它不会替系统决定任务边界、上下文来源、权限策略、失败出口和成功标准。纯代码开发需要自己实现这些基础设施，框架开发则需要在框架提供的能力之上补齐这些语义。

因此，这一栏的核心问题是：

> 如何把参与决策的概率性模型，接入一个有状态、有边界、可恢复、可验证的确定性运行时？

这张内容地图按稳定的问题边界组织 Agent 工程。很多项目使用的名称不同，实际反复遇到的是同一类问题：任务目标没有收敛、模型缺少事实、上下文超限、决策无法终止、工具产生越权副作用、结果无法验证、任务中断后无法恢复。组件用于归类问题，代码目录可以根据项目调整。

## 这一栏的理念

MVC 主要组织请求、业务调用和展示之间的职责；DDD 主要组织领域语言、业务规则、不变量和状态变更。它们解决的是确定性业务系统如何被正确实现和维护。Agent 系统仍然需要这些传统架构承载业务内核，只是在其上增加了一个模型决策闭环：

```text
用户输入 → 任务合同 → 模型视图 → 模型决策 → 受控动作
                                      ↓
                              外部观察 → 状态更新
```

传统应用通常围绕一次请求完成事务：

```text
Request → Application Service → Domain Rules → State Commit → Response
```

Agent 应用则要持续处理模型参与决策带来的不确定性：

- 模型每轮应该看到哪些信息；
- 模型提出的下一步是否符合任务目标和权限边界；
- 工具或外部系统产生的副作用如何被限制和验收；
- 结果、错误和人的决定如何回到下一轮；
- 长任务中断后如何继续，恢复时如何避免重复执行。

Agent 工程技巧覆盖 Prompt 之外的完整运行时。Prompt 影响模型的行为倾向；状态、上下文视图、决策协议、工具治理、恢复机制和验收证据决定这些行为如何进入可控的任务流程。

### Harness：模型决策的运行时控制面

Harness 围绕一个或多个模型组织任务、状态、模型视图、决策、能力和反馈，负责让模型能力持续运行在确定性的约束中。

它主要承担六类运行时职责：

- **编排**：安排模型调用、流程步骤、工具执行和 Agent 之间的交接；
- **状态管理**：维护任务事实、进度、共享变量和运行上下文；
- **能力治理**：控制权限、资源、并发、超时和副作用；
- **协作控制**：拆分子任务、隔离上下文、合并结果和传播失败；
- **结果验证**：收集运行反馈、判断完成条件、记录失败证据；
- **策略演化**：依据 Trace 和评测结果更新提示词、路由、Skill、工具选择和协作策略。

模型能力增强后，Harness 管理的对象会逐步扩大：

```text
单次模型调用
→ 单 Agent 循环
→ Workflow 与 Agent 协作
→ 多 Agent 调度
→ 策略、能力和经验的受控演化
```

多 Agent 场景中，Harness 需要定义任务拆分、能力边界、上下文隔离、结果交接、合并规则和失败传播。自进化场景中，Harness 需要把运行轨迹转成改进候选，再经过评测、沙箱或灰度运行、版本发布和回滚：

```text
运行轨迹 → 失败归因 → 候选改动 → 评测 → 灰度运行 → 发布或回滚
```

权限、审计、资源上限和安全规则应保持在受控边界内，策略更新不能绕过这些约束。Harness 的复杂度随着模型可承担的任务范围扩大而增长，核心目标始终是让模型决策可编排、可约束、可验证、可持续运行。

## 模型决策闭环

本栏按一次任务运行时的主要边界组织内容：

```text
Task → State → View → Decision → Action → Observation
  ↑                                                   ↓
  └────────────── 任务澄清、反馈与状态归并 ──────────────┘
```

六个组件提供阅读和设计边界，也提供问题归类方式：遇到问题时，先判断它主要破坏了哪条边界，再选择对应的工程策略。

| 组件 | 核心问题 | 典型失效 |
|---|---|---|
| **Task** | 用户到底要完成什么，目标、参数和成功条件是什么 | 目标理解错误、参数缺失、错误路由 |
| **State** | 哪些事实、进度和共享变量必须持续存在 | 状态冲突、事实过期、进度丢失 |
| **View** | 当前这次模型调用应该看到什么 | 上下文污染、关键信息遗漏、证据过期 |
| **Decision** | 哪些路径由代码固定，哪些判断交给模型 | 死循环、错误重排、协作失控 |
| **Action** | 模型提案如何变成受授权、可验收的动作 | 工具误用、越权、执行结果不可验证 |
| **Observation** | 外部世界和人的反馈如何变成下一轮事实 | 结果失真、错误丢失、评测无法回流 |

运行时先建立 `State`，再由它派生当前 `View`；模型在 `Decision` 中提出下一步；`Action` 负责执行并产生副作用；`Observation` 归一化执行结果，更新下一版本状态。这个顺序解释了为什么状态要放在视图之前：模型看到的上下文必须有事实来源，不能把上下文本身当成系统的真实状态。

因此，组件的价值不只在于“系统由哪些部分组成”，还在于帮助定位问题：

| 现象 | 优先检查的组件 |
|---|---|
| 用户目标模糊、参数不全、路由错误 | `Task` |
| 任务重启后丢进度或重复执行 | `State` |
| 模型反复问已经知道的内容、遗漏关键证据 | `View` |
| 循环不停止、计划反复改写、协作无法收敛 | `Decision` |
| 工具越权、写操作不可追踪、结果没有后置验证 | `Action` |
| 工具返回失败但下一轮仍把它当成功、问题无法回放 | `Observation` |

## 组件总览

### Task：任务合同与输入路由

Task 把开放输入变成后续组件可以共同消费的任务合同，至少包括目标、参数、约束、风险、成功条件和当前运行模式。

“意图识别”属于 Task 的入口处理，可以按产品入口和风险要求采用不同实现：

- 固定产品入口可以直接把请求路由到 Workflow；
- 简单任务可以让首轮模型直接理解目标；
- 复杂或高风险任务需要结构化解析、澄清、确认和拒答；
- 低置信度进入澄清或人工接管。

Task 收敛“这次要解决什么、还缺什么、应该进入哪种运行模式”；每轮工具调用由 Decision 推进。

文章：[任务合同与输入路由](pathname:///notes/agent-system-design/task/agent-intent-recognition)

### State：贯穿闭环的事实底座

State 保存模型无法可靠记住、但系统必须持续信任的内容：任务事实、运行进度、共享变量、状态版本、来源和有效期。

状态设计需要区分不同所有权和生命周期：

- 进程级运行状态，服务重启后可以重新建立；
- 任务级状态，支持跨轮次和跨请求继续使用；
- 面向交互的响应式状态，服务界面和用户反馈；
- 派生视图与缓存，用于加速读取，不能替代事实来源。

State 负责事实、版本和共享变量；View 负责把这些事实转换成模型可消费的内容；Observation 负责把外部结果归并回 State。

文章：

- [Agent 状态：事实、进度与共享变量](pathname:///notes/agent-system-design/state/agent-state-architecture)

### View：模型上下文与知识视图

View 决定本轮模型真正看到什么。它根据任务阶段、权限、预算和证据来源构建最小充分上下文，并从原始事实中生成当前调用所需的内容。

View 关注：

- 系统指令、任务信息、当前进度和工具描述如何分层；
- 历史消息、记忆、Skill、RAG 和 GraphRAG 如何按需进入；
- 上下文超限时如何压缩、外部化、重建和回退；
- 不同阶段和不同 Agent 能看到哪些信息；
- 证据如何保留来源、时效和引用关系。

原始事实归 State，程序性经验和知识证据进入 View，权限仍由 Action 和运行时治理决定。

View 下的文章按三组组织：

#### 上下文管理

处理当前模型调用的输入组成、阶段可见性、预算和缓存。

- [上下文装配](pathname:///notes/agent-system-design/view/agent-context-management)
- [上下文压缩与外部化](pathname:///notes/agent-system-design/view/agent-context-compression)

#### 记忆与程序性经验

处理跨轮次保留的事实，以及按任务激活的工作方法。

- [记忆设计](pathname:///notes/agent-system-design/view/agent-memory-design)
- [Skill 激活与经验封装](pathname:///notes/agent-system-design/view/agent-skill-design)

#### 外部知识

处理模型需要的领域证据、结构化关系和可维护知识资产。

- [RAG 工程](pathname:///notes/agent-system-design/view/rag-engineering)
- [GraphRAG：什么时候值得建图](pathname:///notes/agent-system-design/view/graph-rag-engineering)
- [知识编译](pathname:///notes/agent-system-design/view/llm-wiki-knowledge-compilation)

推荐阅读顺序：

```text
上下文装配
→ 上下文压缩
→ 记忆设计与 Skill
→ RAG
→ GraphRAG
→ 知识编译
```

### Decision：控制平面与决策内核

Decision 负责推进任务，统一处理确定性流程和模型提案：

- 固定步骤、条件分支和重试适合 Workflow；
- 需要根据中间结果选择下一步时使用 Agent Loop；
- 复杂任务可以加入 Plan、Replan 和 Reflection；
- 需要拆分决策单元时引入主控-子 Agent、并行协作或 Agent Team；
- 需要用户澄清、审批或接管时暂停控制流，并等待明确反馈。

这一层可以拆成三个互相配合的部分：

- **决策内核**：解析模型输出，执行状态转移，处理预算、取消、终止和重复路径；
- **决策策略**：系统提示词、输出协议、思考协议和工具选择规则；
- **控制模式**：Workflow、ReAct、Plan-and-Execute、Router、Reflection、Supervisor-Worker 等。

思考链或其他 Prompt 技巧只能影响模型如何提出决策，不能替代权限检查、终止条件、状态机和结果验收。

文章：

- [控制平面](pathname:///notes/agent-system-design/decision/agent-vs-workflow-architecture)
- [决策内核](pathname:///notes/agent-system-design/decision/agent-brain)
- [人机协作：澄清、审批与接管](pathname:///notes/agent-system-design/decision/agent-human-in-the-loop)
- [多 Agent 协作：主控-子 Agent、同步/异步与 Agent Team](pathname:///notes/agent-system-design/decision/agent-multi-agent-orchestration)

### Action：能力、权限与执行空间

Action 把模型提出的动作变成真实执行，但模型不能直接获得任意副作用。执行前后都需要确定性边界：

- 工具输入要有明确合同和参数校验；
- 凭据、能力声明和真实执行句柄要分离；
- 权限、审批、网络和资源限制要在模型之外检查；
- 文件、进程、数据库和外部 API 要在限定的工作空间或沙箱中运行；
- 写操作要有幂等键、后置条件和失败补偿；
- MCP、Provider 和插件要隔离不可信扩展。

Task 决定任务目标，Action 负责“能不能做、在哪里做、怎么做和做完是否成立”。

文章：

- [工具执行](pathname:///notes/agent-system-design/action/agent-tool-calling)
- [权限、审批与结果验收](pathname:///notes/agent-system-design/action/agent-permission-and-postconditions)
- [Agent 操作空间：沙箱、工作区与资源边界](pathname:///notes/agent-system-design/action/agent-workspace-sandbox)
- [跨进程能力适配：MCP](pathname:///notes/agent-system-design/action/agent-mcp)
- [能力适配与扩展隔离](pathname:///notes/agent-system-design/action/agent-provider-extension)

### Observation：外部事实与反馈回流

Observation 汇总动作和外部世界返回的事实，把成功、失败、部分完成、审批结果、用户反馈和外部变化统一成下一轮可以消费的结果或状态更新。

这一层还承担两类反馈：

- **运行时反馈**：错误语义、重试信号、后置验收、取消和人工决定；
- **质量反馈**：Trace、回放、评测、失败归因和回归样本。

没有 Observation，模型只能重复上一轮的假设；没有可回放的 Observation，工程师也无法判断问题发生在上下文、决策、工具还是状态恢复。

文章：

- [证据与反馈](pathname:///notes/agent-system-design/observation/agent-observability)
- [Agent 评测](pathname:///notes/agent-system-design/observation/agent-evaluation)
- [知识视图专项：RAG 评测](pathname:///notes/agent-system-design/observation/rag-evaluation)

## 建议阅读顺序

按一次任务运行来阅读，比按某个框架的源码目录阅读更容易建立整体判断：

```text
任务合同
→ 状态与恢复
→ 模型视图
→ 决策与协作
→ 能力与治理
→ 观察、评测与回流
```

读完方法文章后，再回到具体框架或项目的应用拆解，确认它如何实现这些边界。框架名称、类名和目录结构会变化，但任务合同、状态所有权、上下文来源、决策控制、副作用治理和结果验收始终是 Agent 工程的核心问题。
