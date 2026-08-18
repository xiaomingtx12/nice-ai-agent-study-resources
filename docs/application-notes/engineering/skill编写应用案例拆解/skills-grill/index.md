---
sidebar_position: 1
title: "Matt Pocock Skills：一套工程 Skill 如何组织成工作流"
description: 以 mattpocock/skills 源码为对象，按 Skill 职责拆解路由、访谈、上下文沉淀、规格拆分、实现反馈和发布边界，为后续编写 Skill 积累可迁移经验。
---

# Matt Pocock Skills：一套工程 Skill 如何组织成工作流

:::info 版本基线

本文拆解 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills)，对应版本 `v1.2.3`。分析对象包括各目录中的 `SKILL.md`、bucket README、`agents/openai.yaml`、`.agents/`、`.claude-plugin/`、脚本和 ADR。本文的目的，是从真实项目中积累后续编写、拆分、组合和验证 Skill 的工程经验。

:::

## 这组案例要回答什么

这里不写 Skill 使用教程，也不按文件顺序翻译 `SKILL.md`。要拆的是一个更具体的问题：一组 Markdown 指令如何被组织成可选择、可组合、可交付的工程工作流。

每篇文章按“源码分析 → 为什么这样组织 → 迁移边界”的顺序展开。原始 `SKILL.md` 只作为事实来源，不当作可直接复用的成品；文章会解释入口、流程、产物和约束，以及这些设计在其他项目中需要哪些改造。代码块会明确标注为“源码摘录”，避免把分析对象和通用结论混淆。

## 先分清三层分类

`mattpocock/skills` 同时使用三套分类标准，不能把它们混成“工程化 Skill”和“产品化 Skill”两类。

### 目录分类：Skill 放在哪个 bucket

```text
engineering/   日常代码工程工作
productivity/  通用生产力和非代码工作流
misc/          保留但较少使用的 Skill
in-progress/   在建、用于收集反馈的 Skill
deprecated/    已废弃的 Skill
```

当前专栏主要分析 `engineering/` 和 `productivity/` 下的已发布 Skill。`productivity` 表示生产力与通用工作流，不表示“产品化”；仓库当前没有独立的 `product/` 或 `productization/` 分类。

目录还决定发布状态：正式 bucket 中的 Skill 需要同步顶层 README、对应 bucket README 和 Claude Code 插件清单；`misc/`、`in-progress/`、`deprecated/` 不进入同一套正式发布清单。

### 调用分类：谁可以触发 Skill

| 类型 | 触发方式 | 典型职责 |
| --- | --- | --- |
| `user-invoked` | 用户输入 Skill 名称后显式调用；模型不能隐式调用 | 工作流入口、阶段切换、交接、需要用户决定的操作 |
| `model-invoked` | 用户可以显式调用，模型也可以根据 description 自动调用 | 访谈、领域建模、测试、调试、研究和代码审查 |

例如，`ask-matt`、`grill-me`、`grill-with-docs`、`to-spec`、`to-tickets`、`implement`、`triage` 和 `wayfinder` 属于用户显式调用入口；`grilling`、`domain-modeling`、`tdd`、`code-review`、`diagnosing-bugs`、`research` 和 `prototype` 可以被模型自动触发。

### 工作流分类：Skill 在整条链路中的职责

`ask-matt` 又从运行时职责组织这组 Skill：

```text
Main flow              从 idea 到 ship 的默认主流程
On-ramps               从外部 Issue、Bug 或大型未知工作接入主流程
Codebase health        代码库架构维护
Vocabulary underneath  供其他 Skill 使用的共享术语和设计词汇
Standalone              不要求先经过主流程的独立工具
Precondition            使用工程 Skill 前的一次性项目配置
```

这三层分类分别回答不同问题：目录分类回答“文件放在哪里、是否正式发布”；调用分类回答“谁能触发”；工作流分类回答“当前任务中承担什么职责”。后续文章会在每篇开头同时标出这三个维度。

## 需要分析的 Skill

下面按工作流中的职责列出本专栏要分析的 Skill。它们共同组成一条从模糊想法到实现交付的工程链路。

### 入口与路由

- **`ask-matt`**：用户显式调用的路由 Skill。根据任务阶段和不确定性推荐下一个入口，同时说明主流程、旁路、独立工具和上下文切换方式。首篇文章已完成。
- **`setup-matt-pocock-skills`**：工程 Skill 的前置配置入口。负责设置 Issue tracker、triage 标签和文档目录，使后续 Skill 具备共同的运行前提。

### 需求澄清与领域语言

- **`grilling`**：访谈原语。通过 frontier（当前未解决的问题边界）、round（提问轮次）和 design tree（设计分支）逐步缩小不确定性。
- **`grill-with-docs`**：带项目文档沉淀的访谈入口。在 `grilling` 基础上维护 `CONTEXT.md` 和 ADR，把讨论结果留在工作目录。
- **`grill-me`**：无状态的访谈入口。适合没有项目目录的场景，不写入项目上下文。
- **`domain-modeling`**：领域建模和术语校准。挑战模糊或重载词汇，记录不可逆决策，并维护项目共享语言。
- **`wait-what`**：会话内纠偏工具。当解释没有被理解时，根据已有上下文重新表达问题，不开启新的交付阶段。

### 方案、拆分与大任务规划

- **`wayfinder`**：处理一个会话无法容纳、且从当前位置到目标的路径还不清晰的大型工作。它先建立决策票据地图，逐项解决未知问题，再回到规格阶段。
- **`to-spec`**：把当前会话中已经讨论的内容整理成规格说明，并发布到项目约定的 Issue tracker。
- **`to-tickets`**：把规格或计划拆成 tracer-bullet tickets（纵向可交付票据），为票据声明阻塞关系，交给后续实现阶段。
- **`to-questionnaire`**：当关键信息掌握在其他人手中时，生成面向对方的问卷，收集结果后再回到澄清或规格阶段。
- **`prototype`**：用一次性程序或页面回答单个设计问题。它提供运行证据，不替代正式实现。
- **`research`**：把资料阅读工作交给后台 agent，基于 primary sources（主要来源）产出带引用的 Markdown，供后续澄清和方案设计使用。

### 实现、测试与维护

- **`implement`**：消费 spec 或 tickets，按既定 seam 推进实现，内部组合 `tdd`，提交前调用 `code-review`。
- **`tdd`**：以 red-green-refactor（红—绿—重构）循环推进一个纵向行为切片，形成测试和实现反馈。
- **`diagnosing-bugs`**：处理难复现 bug、回归和性能问题。先建立能在当前问题上变红的反馈环，再最小化、假设、加观测、修复并补回归测试。
- **`code-review`**：对固定范围的 diff 做 Standards 和 Spec 两个维度的审查，减少实现完成但偏离规范或原始需求的情况。
- **`codebase-design`**：提供 deep module、interface、depth、seam、adapter 等代码库设计词汇和判断框架，供测试和架构维护 Skill 使用。
- **`improve-codebase-architecture`**：扫描代码库中的架构加深机会，先输出候选，再把选中的问题送回澄清流程。
- **`resolving-merge-conflicts`**：处理进行中的 merge 或 rebase 冲突，按双方变更意图逐块解决，完成当前 Git 操作。

### 需求入口与人工操作

- **`triage`**：处理外部进入、尚未整理的 bug 和需求，通过角色状态机把它们变成可交给 agent 的 Issue。它不重复处理 `to-tickets` 已经生成的票据。
- **`grilling`、`prototype`、`research`、`wizard` 等独立 Skill**：不要求先经过主流程即可单独调用。
- **`handoff`**：把目标、事实、未决问题、文件位置和下一步写成可携带的交接材料，服务于换 harness、换目录、协作者或分叉任务。
- **`wizard`**：处理只能由人完成的凭据配置、第三方控制台操作、CI secret 设置和一次性迁移。
- **`teach`**：以当前目录为状态工作区，跨会话学习一个概念。
- **`writing-for-agents`**：面向 Skill、`AGENTS.md` 和其他 agent 消费文档的写作参考。

以上列表是专栏的分析范围。后续文章会按依赖关系逐步核验，不把尚未分析的专题提前写成实现结论。

## 源码里的五层结构

| 层次 | 目录或文件 | 要确认的事实 |
| --- | --- | --- |
| Skill 本体 | `skills/*/*/SKILL.md` | 名称、触发描述、流程指令、输出边界和依赖关系是什么？ |
| 调用协议 | `.agents/invocation.md`、`agents/openai.yaml` | user-invoked 与 model-invoked 如何区分？两个 harness 的调用策略是否一致？ |
| 工作流路由 | `skills/engineering/ask-matt/` | Skill 清单如何变成主流程、分支和阶段边界？ |
| 状态与词汇 | `CONTEXT.md`、`.agents/adr/`、`domain-modeling/` | 什么知识会跨会话留下来，什么决定需要被记录？ |
| 发布与安装 | `.claude-plugin/`、`scripts/link-skills.sh`、`package.json` | 本地链接、Claude Code 插件和版本同步各自维护什么不变量？ |

这张地图用于定位后续文章的证据，不把目录层次直接等同于运行时架构。每个结论都要回到具体文件、调用关系或配置约束。

## 当前正文

- [ask-matt：路由型 Skill 怎样组织一组工程工作流](./01-ask-matt-router.md)
- [grilling：用 frontier 和 design tree 组织多轮需求访谈](./02-grilling-interview.md)
- [grill-with-docs 与 domain-modeling：把访谈结果留下来](./03-grill-with-docs-domain-modeling.md)
- [to-spec → to-tickets：从对话到可执行工作单元](./04-to-spec-to-tickets.md)
- [tdd、diagnosing-bugs 与 implement：把实现变成可反馈的交付闭环](./05-tdd-diagnosing-bugs-implement.md)
- [code-review、codebase-design 与 improve-codebase-architecture：从审查到架构改进](./06-code-review-codebase-design-architecture.md)
- [triage 与 wayfinder：从外部请求到决策地图](./07-triage-wayfinder.md)
- [prototype、research 与 to-questionnaire：把未知变成可用证据](./08-prototype-research-questionnaire.md)
- [handoff、teach、writing-for-agents 与 wait-what：上下文怎样移动、累积和纠偏](./09-handoff-teach-writing-wait-what.md)

## 后续分析顺序

| 顺序 | Skill / 专题 | 重点源码 | 要回答的问题 |
| --- | --- | --- | --- |
| 1 | `ask-matt` | `skills/engineering/ask-matt/SKILL.md`、`PHASE-BOUNDARIES.md` | 路由器怎样表达主流程、旁路、独立工具和阶段切换？ |
| 2 | `grilling` | `skills/productivity/grilling/SKILL.md` | frontier、round 和 design tree 怎样控制一次访谈的提问顺序？ |
| 3 | `grill-with-docs` + `domain-modeling` | 两个 Skill 的 `SKILL.md`、`CONTEXT.md`、ADR 格式 | 同一套澄清工作为什么要分成访谈原语、文档入口和领域语言层？ |
| 4 | `to-spec` → `to-tickets` | 对应 `SKILL.md`、Issue tracker 配置 | 对话如何变成带阻塞关系、可交给实现阶段的工作单元？ |
| 5 | `tdd` + `diagnosing-bugs` + `implement` | 对应 `SKILL.md` 和依赖关系 | 测试反馈怎样覆盖正常实现、困难调试和多步交付？ |
| 6 | `code-review` + `codebase-design` + `improve-codebase-architecture` | 对应 `SKILL.md` | 标准审查、规格审查、模块设计和架构维护怎样分工？ |
| 7 | `triage` + `wayfinder` | 对应 `SKILL.md`、Issue tracker 状态约定 | 外部需求和大型未知工作如何接入主流程？ |
| 8 | `prototype` + `research` + `to-questionnaire` | 对应 `SKILL.md`、交接和引用产物 | 运行实验、资料研究和外部信息收集怎样为后续方案提供证据？ |
| 9 | `handoff` + `teach` + `writing-for-agents` + `wait-what` | 对应 `SKILL.md`、`.agents/` 文档 | 上下文移动、学习状态、agent 文档和会话纠偏如何独立成能力？ |
| 10 | 插件与安装面 | `.claude-plugin/`、`.agents/adr/0002-*.md`、`scripts/` | promoted Skill、插件显式清单和其他 harness 的能力差异如何影响发布结构？ |

这条路线先读“怎么选”，再读“怎么问”和“怎么留下决策”，最后读“怎么执行、反馈和验收”。它按工作流依赖排列，不按目录字母序排列。

## 和相邻专栏的边界

本目录下的两个子专栏研究对象不同：

- [Anthropic Skills](../anthropic-skills) 继续作为另一份本地 Skill 目录的独立案例；
- 本专栏分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills)。`D:\open_code\skills-grill` 只是本地目录名；文章中的版本、项目名和源码结论以 GitHub 项目及对应快照为准。
- 本专栏的落点是从这些 Skill 中提炼后续编写时可以复用的设计经验：触发边界、流程编排、Skill 组合、上下文沉淀、反馈闭环和发布约束。

两者都可以讨论 Skill 的加载和调用，但不能互相充当事实来源，也不能把一套仓库的文章结构或规则推成另一套仓库的实现结论。

## 后续文章的判断标准

每篇具体拆解至少要交代五件事：

1. **源码位置**：结论落在哪个文件、哪个入口或哪条依赖关系；
2. **运行边界**：输入从哪里来，状态写到哪里，下一步由谁消费；
3. **工程代价**：这套拆法减少了什么混乱，又增加了哪些配置、上下文或维护成本；
4. **复用经验**：哪些设计经验值得迁移到新 Skill，迁移时需要补哪些上下文，哪些只适用于 `mattpocock/skills` 的 harness 和工作流。

README 只用于建立目录和产品叙述的背景。涉及触发、组合、退化或发布不变量时，以 `SKILL.md`、配置、脚本和 ADR 为准；尚未逐篇核验的内容保持在“待拆问题”层，不提前写成结论。
