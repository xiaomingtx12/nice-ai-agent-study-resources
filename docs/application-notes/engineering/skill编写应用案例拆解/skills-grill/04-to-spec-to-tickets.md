---
sidebar_position: 5
title: "to-spec → to-tickets：从对话到可执行工作单元"
description: 从 mattpocock/skills 源码拆解 to-spec 如何整理规格、to-tickets 如何拆分纵向工作单元并声明阻塞关系。
---

# to-spec → to-tickets：从对话到可执行工作单元

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先看这条数据流

`to-spec` 和 `to-tickets` 处理的是澄清完成后的阶段。前者把当前会话整理成一份可以长期引用的规格，后者把规格拆成多个可以独立推进的工作单元。

```text
已澄清的会话
      │
      ▼
  /to-spec
      │  问题、方案、用户故事、实现和测试决定
      ▼
    spec
      │
      ▼
 /to-tickets
      │  纵向切片 + 阻塞关系
      ▼
 tickets / Issues
      │
      ▼
 /implement
```

两者不能合并成一个“把对话变成任务”的步骤：规格回答“要解决什么、为什么这样设计、如何验收”，ticket 回答“这一块可以怎样独立交付、被什么阻塞”。

| Skill | 输入 | 主要产物 | 下游消费者 |
| --- | --- | --- | --- |
| `/to-spec` | 当前会话、代码库理解、术语和 ADR | spec | `/to-tickets` 或后续评审 |
| `/to-tickets` | spec、计划或当前会话 | tickets / Issues 和 blocking edges | `/implement` |

## `to-spec`：只综合已经讨论过的内容

### 为什么不重新访谈

`to-spec/SKILL.md` 的开头直接规定：

```markdown
This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user — just synthesize what you already know.
```

`to-spec` 的输入前提是讨论已经完成。它不重新打开需求探索，也不替代 `/grilling`。如果规格整理过程中发现关键问题仍未解决，应该回到澄清阶段，而不是让 `to-spec` 一边写规格一边猜答案。

**运行边界：**输入是当前会话和代码库理解；当前处理是提炼已经确认的目标、约束和决定；输出是规格；未确认的产品选择不能被静默补全。

### 为什么先读代码、术语和 ADR

源码要求先了解代码库当前状态，并使用项目领域词汇、遵守相关 ADR：

```markdown
Explore the repo to understand the current state of the code, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.
```

规格不是脱离现有系统的产品愿望。当前代码决定哪些能力已经存在，领域词汇决定名称含义，ADR 说明哪些架构选择不能在规格中随意推翻。

这里也承接了前一篇的分层：`CONTEXT.md` 提供稳定术语，ADR 提供带原因的长期决策，`to-spec` 把这些上下文带入一份面向交付的文档。

### 为什么先明确测试 seam

在规格模板之前，`to-spec` 要求先画出测试 seam：

```markdown
Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.
```

seam（接缝）是测试行为可以稳定进入系统的位置。源码给出的顺序包含三个判断：

1. 优先使用已有 seam；
2. 必须新增时，选择尽可能高的 seam；
3. 尽量减少 seam 数量，理想情况是一个。

它要求用户确认 seam，是因为测试边界会影响实现范围和验收方式。这一步把“以后怎么证明功能有效”提前纳入规格，避免方案写完后才发现没有可观察的行为入口。

### 规格模板为什么包含这些部分

`to-spec` 的模板要求规格包含：

```markdown
## Problem Statement
## Solution
## User Stories
## Implementation Decisions
## Testing Decisions
## Out of Scope
## Further Notes
```

每个部分对应一个不同的问题：

| 部分 | 要固定的内容 | 缺失时的后果 |
| --- | --- | --- |
| Problem Statement | 用户遇到的问题 | 实现可能解决了错误的问题 |
| Solution | 用户视角的解决方向 | 只有问题，没有目标行为 |
| User Stories | 角色、需求和收益 | 验收范围不完整 |
| Implementation Decisions | 模块、接口、架构、交互和数据约束 | 后续实现重新发明方案 |
| Testing Decisions | 行为测试、模块范围和既有测试依据 | 代码完成后缺少验证标准 |
| Out of Scope | 明确不做的内容 | 需求边界不断膨胀 |
| Further Notes | 其他需要保留的上下文 | 边缘约束容易丢失 |

`User Stories` 被要求写成较长的编号列表，说明规格需要覆盖完整行为面；`Out of Scope` 则把明确排除项固定下来，防止“没有写出来”被误解成“以后也要做”。

### 为什么规格避免具体文件路径

`to-spec` 明确要求实现决定不要写具体文件路径和代码片段：

```markdown
Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.
```

规格保存的是问题、行为和设计决定，文件路径属于实现阶段的当前事实。把路径写进规格会让代码移动变成规格过期；把代码片段写进去也会让实现被旧代码形状绑住。

源码保留了一个例外：如果原型产生了比文字更准确的状态机、reducer、schema 或类型形状，可以只保留决定性片段，并标明来自原型。例外的标准是“表达决定所必需”，不是把 demo 复制进规格。

## `to-tickets`：把规格拆成纵向切片

### 输入可以是规格、计划或当前会话

`to-tickets/SKILL.md` 允许从三类材料开始：

```markdown
Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.
```

如果用户传入 spec 路径、Issue 编号或 URL，Skill 需要读取完整正文和评论；如果没有外部引用，就使用当前会话上下文。这样它可以接在 `/to-spec` 后面，也可以处理已经存在的计划或小型任务讨论。

### 为什么使用 tracer-bullet vertical slices

源码给出的切片规则是：

```markdown
- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first
```

tracer-bullet ticket（示踪弹票据）不是“先做数据库，再做 API，再做 UI”的水平分层。它应该从用户行为或系统行为切出一条窄但完整的路径，覆盖需要的层，并且单独可演示或验证。

这种拆法有三个目的：

- 每张 ticket 都能产生可见进展，而不是只完成某一层的半成品；
- 实现可以按 ticket 切换到新上下文，减少长会话依赖；
- 票据之间的依赖更接近真实交付顺序，而不是按目录顺序排列。

如果存在必须先完成的预重构，源码要求先单独安排；不要把预重构隐藏在第一张功能 ticket 里。

### blocking edges 如何表达依赖

每张 ticket 都要声明哪些票据阻塞它：

```markdown
Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.
```

阻塞关系回答的是“现在能不能开始”，不是“理论上哪个模块先写”。例如，依赖共享接口的行为切片应被接口扩展 ticket 阻塞；互不依赖的两张行为 ticket 可以同时进入 frontier。

源码还定义了一个例外：大范围机械重构不强行拆成纵向切片，而使用 expand–contract 顺序：先扩展兼容形式，再分批迁移，最后删除旧形式。原因是这类变更的影响面跨越整个代码库，无法让每个中间步骤都独立成为完整用户行为。

### 为什么发布前必须让用户审核拆分

`to-tickets` 不会得到一份计划就立即创建票据。它要求先展示每张 ticket 的标题、阻塞关系和交付内容，然后询问：

```markdown
- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?
```

拆分粒度和阻塞关系都可能改变实现成本和并行方式。模型可以提出初稿，但用户需要确认这些票据是否符合实际协作边界。只有用户批准后，Skill 才发布到 Issue tracker。

### 为什么按 blocker-first 顺序发布

本地 tracker 的规则是按依赖顺序从 `01` 开始编号；真实 tracker 则先发布阻塞项，再发布依赖它们的 Issue。这样后续票据创建时就已经有可引用的阻塞对象。

发布后，工作流使用 frontier：所有 blockers 已完成的 ticket 才能开始。这个 frontier 与前文 `grilling` 的 frontier 类似，但对象不同：

- `grilling` frontier 是当前可以询问的决策；
- `to-tickets` frontier 是当前可以实现的工作单元。

两者都把依赖关系转化成“当前可推进边界”，但不会把访谈决策和实现任务混成一种状态。

## 前置配置和组合边界

`to-spec` 和 `to-tickets` 都依赖 Issue tracker 和 triage label vocabulary。源码要求这些配置先由 `/setup-matt-pocock-skills` 提供；如果没有配置，不能假设应该调用 GitHub、Linear 还是本地文件。

setup Skill 的默认 domain docs 是单上下文布局：根目录一个 `CONTEXT.md`，`docs/adr/` 存放 ADR。Issue tracker 可以是 GitHub、GitLab、本地 `.scratch/` 文件或用户描述的其他系统。

两个 Skill 都是 user-invoked：它们的 `SKILL.md` 使用 `disable-model-invocation: true`，对应的 `agents/openai.yaml` 设置 `allow_implicit_invocation: false`。这与 `ask-matt` 的入口约束一致：规格和票据的发布都会改变项目状态，不能由模型在后台自行创建。

Skill 之间通过 `/skill-name` 表达依赖，不读取其他 Skill 的内部文件。`to-tickets` 可以消费 `/to-spec` 产物，但不应依赖某个规格文件的内部路径结构作为公共接口。

## 为什么要分成 spec 和 tickets 两层

### spec 保留讨论结果

spec 面向用户目标和设计判断，保存问题、解决方案、用户故事、实现决定、测试决定和范围边界。它回答“做什么、为什么做、做到什么程度算完成”。

### ticket 保留执行结构

ticket 面向实现调度，保存一个可验证的纵向切片、验收标准和阻塞边。它回答“这一块怎样独立交付、什么时候可以开始”。

### 分层避免两种损失

把所有内容直接拆成 tickets，会丢失用户问题、设计原因和整体范围；只保留一份大 spec，又无法表达并行关系和 agent 可抓取的工作边界。两层之间的转换把“需求理解”和“实现调度”分开，但通过 spec → tickets 的产物关系连接起来。

## 运行边界和工程代价

| 阶段 | 输入 | 状态归属 | 输出 | 消费者 |
| --- | --- | --- | --- | --- |
| 整理规格 | 已完成的会话、代码库、术语和 ADR | spec 或配置的 Issue tracker | 一份规格 | `/to-tickets`、评审者 |
| 审核拆分 | spec、计划或会话 | 当前对话，尚未发布 | ticket 草案和 blocking edges | 用户 |
| 发布票据 | 用户批准的草案、tracker 配置 | `.scratch` 或真实 tracker | tickets / Issues | `/implement` |
| 执行 frontier | 已发布 tickets 和完成状态 | Issue tracker | 当前可开始的工作单元 | agent 或开发者 |

这套流程减少了从聊天直接进入实现的歧义，但增加了文档、审核和 tracker 配置成本。项目规模较小、任务单一时，可以只保留一份短规格或直接实现；工作需要跨会话、多人协作或并行执行时，spec 和 tickets 的分层才有明显收益。

## 迁移边界

### 可以采用

- 把用户目标和实现调度拆成 spec 与 ticket 两种产物；
- 规格包含问题、方案、用户故事、测试决定和范围边界；
- ticket 采用可独立验证的纵向切片；
- 用最小真实阻塞关系表达执行顺序；
- 先让用户审核粒度和依赖，再创建任务；
- 使用状态 tracker 的 frontier 推进可开始工作。

### 需要改造

- Issue tracker 可以替换为目标项目的 GitHub、Linear、本地 Markdown 或其他系统；
- `ready-for-agent` 等标签需要映射到目标 tracker 的状态词汇；
- seam、测试框架和验收命令必须使用目标代码库已有的测试入口；
- 没有多层交付或协作需求的项目不必强制建立 tickets 层。

### 不应照搬

- 不要把文件路径和当前代码片段大规模写进长期规格；
- 不要把数据库、API、UI、测试机械地拆成互相等待的水平 tickets；
- 不要在用户确认前直接发布 ticket 或 Issue；
- 不要把已经由 `/to-tickets` 生成的工作单元重新送回 `/triage`；
- 不要把“有 ticket”当成“已经有规格”，两者解决的问题不同。

## 编写规格与票据 Skill 的检查清单

- [ ] `to-spec` 是否只综合已讨论内容，不在整理阶段偷偷补问或猜答案？
- [ ] 是否先读取代码库、领域术语和相关 ADR？
- [ ] 规格是否明确 Problem、Solution、User Stories、Testing Decisions 和 Out of Scope？
- [ ] 是否定义了行为测试 seam，并让用户确认？
- [ ] 是否避免把易过期的文件路径和代码片段写进规格？
- [ ] ticket 是否是窄而完整、可单独验证的纵向切片？
- [ ] 是否把真正的 blocker 写成阻塞边，而不是按模块顺序虚构依赖？
- [ ] 是否先审核粒度和 blocking edges，再发布？
- [ ] 发布顺序是否先处理 blockers？
- [ ] 下游实现者是否能从 ticket 直接知道交付行为和验收标准？
