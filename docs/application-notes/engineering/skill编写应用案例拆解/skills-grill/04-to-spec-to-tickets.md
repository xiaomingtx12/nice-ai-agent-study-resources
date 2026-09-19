---
sidebar_position: 5
title: "to-spec → to-tickets：从对话到可执行工作单元"
description: 从 mattpocock/skills 源码拆解 to-spec 如何整理规格、to-tickets 如何拆分纵向工作单元并声明阻塞关系。
---

# to-spec → to-tickets：从对话到可执行工作单元

:::info 版本与源码入口

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。路径均相对项目根目录；Markdown 指令没有函数入口，按真实章节定位。

| 文件 | 阅读入口 | 负责的约定 |
| --- | --- | --- |
| `skills/engineering/to-spec/SKILL.md` | 开篇、`Process`、`<spec-template>` | 综合上下文、确认测试接缝、发布规格 |
| `skills/engineering/to-tickets/SKILL.md` | `Process` 第 1–5 步、两个票据模板 | 切分行为、确认依赖、发布工作单元 |
| `skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md` | `Conventions` | 文件型工作项跟踪系统的产物位置 |
| `skills/engineering/setup-matt-pocock-skills/triage-labels.md` | `Triage Labels` | 标签角色与项目标签的对应关系 |
| `.agents/invocation.md` | `Model-invoked vs user-invoked` | 谁能启动一个 skill |

:::

## 一、两次整理分别留下什么

`to-spec` 把已经谈清的目标、设计决定和测试边界写成规格（spec）；`to-tickets` 把这些内容变成可独立验证的工作单元（ticket），并声明各单元开始前必须完成什么。前者保留整件事的语义，后者保留执行粒度和依赖关系。

两者都是交给模型遵循的 Markdown 指令，没有解析规格、计算任务图或自动派发实现的程序。读写由宿主提供的文件、终端或工作项跟踪工具完成；文中的“先做、等待、发布”是指令要求，不能理解成脚本强制的状态转换。

| 阶段 | 输入 | 输出 | 下一步由谁推进 |
| --- | --- | --- | --- |
| 整理规格 | 对话、代码库、领域词汇、架构决定 | 规格及 `ready-for-agent` 标签 | 用户决定是否拆票据 |
| 起草票据 | 规格、计划或当前对话 | 标题、交付行为、阻塞关系草案 | 用户确认粒度与依赖 |
| 发布票据 | 批准后的草案、跟踪系统配置 | 每张票据独立保存，包含验收条件 | 用户或外部调度者选择可开始项 |

调用边界见 `.agents/invocation.md` → `Model-invoked vs user-invoked`，摘录：

```markdown
A user-invoked skill may invoke model-invoked skills, but it can never reach another user-invoked skill.
```

`to-spec`、`to-tickets` 和下游 `implement` 的 frontmatter（文件头元数据）均设置 `disable-model-invocation: true`，相邻 `agents/openai.yaml` 均设置 `policy.allow_implicit_invocation: false`。“规格 → 票据 → 实现”表示产物接续，用户分别调用这些入口；写完规格不会自动启动拆分，发布票据也不会自动开始编码。

## 二、to-spec：从已有决定到已发布规格

### 1、输入是已讨论内容，代码和领域文档负责约束措辞

来源：`skills/engineering/to-spec/SKILL.md` → 开篇及 `Process` 第 1 步。以下为两个摘录，中间省略跟踪系统配置提示和章节标题。

```markdown
This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the user — just synthesize what you already know.

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.
```

模型先利用会话里的决定；代码库尚未探索时，再读取现状。领域词汇表约束名词含义，ADR（Architecture Decision Record，架构决策记录）约束已有的长期选择。例如，项目把“取消订单”和“退款”区分为不同概念，规格不能为了措辞顺滑把二者合成一个行为。

“不要访谈”限制的是重新开启需求探索，不能解释成“整个过程不与用户交流”，因为下一步明确要求确认测试接缝。源码也没有定义需求仍然模糊时的完整回退流程；使用时应把未决项留作未决，回到需求讨论，而不能靠模板补出用户从未做过的决定。

### 2、先确定怎样观察行为，再撰写规格

来源：`skills/engineering/to-spec/SKILL.md` → `Process` 第 2 步，完整摘录该步骤。

```markdown
2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.
```

seam（测试接缝）是测试输入条件、观察行为的公共接口位置。例如测试“订单提交后可查询到确认状态”，可以穿过订单提交和查询接口，避免分别锁定内部校验函数、存储辅助函数与通知函数的调用顺序。这个例子用于解释接缝，不是仓库内的业务实现。

指令优先复用已有接缝，尽可能从较高层观察完整行为，确需新增时再提出新接缝。理想数量为一个，是减少测试与内部结构耦合的偏好，不是自动计算最优接缝数的算法。

确认后产生的是共同约定：哪些可观察行为会成为后续实现的测试面。`tdd` 要求只在预先约定的接缝上写测试，规格中的 `Testing Decisions` 因而承担跨会话传递约定的作用。入口越高，准备环境和定位失败原因可能越困难；使用时应连同覆盖的行为与成本一起确认，不能只让用户挑接口名字。

### 3、模板保存决定，原型片段是有限例外

`skills/engineering/to-spec/SKILL.md` → `<spec-template>` 包含七部分：

| 部分 | 应保存的信息 |
| --- | --- |
| `Problem Statement` | 用户遇到的问题 |
| `Solution` | 用户会得到的解决方式 |
| `User Stories` | 角色、期望能力及收益，编号覆盖功能各方面 |
| `Implementation Decisions` | 要改动的模块、接口、数据约束和架构选择 |
| `Testing Decisions` | 行为测试原则、被测模块、已有相似测试 |
| `Out of Scope` | 明确排除的行为 |
| `Further Notes` | 前面没有容纳的必要上下文 |

“实现决定”不等于复制当前代码。来源：同文件 → `Implementation Decisions`，摘录规则与例外：

```markdown
Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.
```

默认省去具体文件路径，让后续实现仍能按当时的代码结构定位模块。例外允许保留原型中表达决定的最小片段，例如状态转换条件，或 schema（数据结构与约束定义）。reducer 指根据当前状态和输入计算新状态的函数；如果它比散文更准确地定义允许的转换，可以注明原型来源后内嵌，但不能把完整演示程序当规格。

`Testing Decisions` 则要求只测试外部行为，指出被测模块和可借鉴的现有测试。规格需要说明验收的行为，不应把内部方法调用次数当作用户目标。

### 4、发布同时赋予可供 agent 消费的标签

来源：`skills/engineering/to-spec/SKILL.md` → `Process` 第 3 步：

```markdown
3. Write the spec using the template below, then publish it to the project issue tracker. Apply the `ready-for-agent` triage label - no need for additional triage.
```

Issue tracker（工作项跟踪系统）保存项目的规格、票据及状态。前置 setup skill 将操作方式写入 `docs/agents/issue-tracker.md`；仅在已安装 `triage` 且执行过 Section B 时，才生成标签映射 `docs/agents/triage-labels.md`。单独安装 `to-spec` 或 `to-tickets` 时，它们需要的映射仍可能缺失，原样重跑 setup 也不保证补齐，需另行明确项目采用的标签。文件型跟踪系统把规格放在 `.scratch/<feature-slug>/spec.md`；这些是项目内的产物约定，不是 `to-spec` 自己实现的一套数据库。

从这一刻起，其他会话可以读取规格。`ready-for-agent` 表示内容已足够明确、无需再分诊，不等于自动批准实现整个规格。如果外部调度者只按标签领取工作，可能同时看到大规格和拆出来的小票据。该版本没有为父规格定义独立的“仅供参考”类型。

源码没有在成文后再设置一次“整份规格批准”步骤，也没有规定发布失败后的回滚、重试去重或与旧规格同步。规格是这次讨论的快照，不能认为它会随实现自动保持最新。

## 三、to-tickets：从行为切片到真实依赖关系

### 1、读完整来源，再寻找预重构机会

来源：`skills/engineering/to-tickets/SKILL.md` → `1. Gather context`：

```markdown
Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.
```

没有外部引用时直接使用会话，因此 `to-spec` 不是必需前置步骤。给出规格、工作项编号或 URL 时，正文和评论都要读：评论可能包含范围调整或已经否决的方案。对于没有评论机制的文件，读取完整文件即可。

第 2 步仅在尚未探索代码库时补充探索，并要求使用领域词汇、遵守 ADR，寻找 prefactoring（预重构）机会：在改变行为前，先让现有结构便于修改。它没有强制每个任务都先重构；准备工作应来自当前结构与目标改动之间的真实阻力。

### 2、一张票据覆盖一条可验证的完整路径

来源：`skills/engineering/to-tickets/SKILL.md` → `3. Draft vertical slices`，摘录切片规则与依赖定义，中间仅省略标记闭合行。

```markdown
- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.
```

tracer bullet（示踪弹）在这里指一条很窄但贯穿所需层次的行为路径。例如“用户能导出当前订单为 CSV”可以同时涉及入口、数据读取、序列化和测试；完成票据就能验证导出行为。按“数据库一张、接口一张、页面一张”拆分，则每张都要等其他层完成后才能验证整体效果。源码列出的 schema、API、UI、tests 是跨层示意，并不要求没有界面的改动人为增加 UI。

一张票据要能放进全新的上下文窗口，意味着后续 agent 不应依赖起草会话中的隐含推理。交付行为和验收条件要写进票据，整体设计理由仍由规格承载。规格与票据分别解决了“为什么这样做”和“本次要完成哪一块”。

blocking edge（阻塞关系）只表达真正的开始条件：B 开始前必须有 A 的成果，则 B 的 `Blocked by` 指向 A。两个不互相依赖的行为可以同时开始。预重构如果确实是前提，应表现为先行任务及对应依赖，不能仅靠标题排列暗示。

### 3、机械性大改动走 expand–contract

当字段重命名或共享类型替换会破坏大量调用点时，单张纵向票据可能无法保持可验证。第 3 步为这类 wide refactor（影响面很广的机械性重构）定义 expand–contract（先扩展兼容形式，再迁移，后收缩旧形式）：

- 扩展票据增加新形式，暂时保留旧形式。
- 每个迁移批次是一张票据，都被扩展票据阻塞；旧形式仍存在，使各批次有机会保持检查通过。
- 收缩票据删除旧形式，等待所有迁移批次完成。

来源：同文件 → `3. Draft vertical slices`，摘录这段规则的末句，前面的扩展与迁移说明省略：

```markdown
When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.
```

如果连迁移批次都不能独立通过检查，指令允许共享集成分支，并让这些工作共同阻塞最终的集成验证票据。此时只承诺最终集成点通过，不能再把中间票据描述为可独立上线。“纵向切片”因此不能被误用成不允许任何过渡状态的绝对规则。

### 4、用户确认的是拆分结构，发布前仍只是草案

来源：`skills/engineering/to-tickets/SKILL.md` → `4. Quiz the user`，摘录提问与完成条件，前面的展示字段省略：

```markdown
- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.
```

模型先按编号展示标题、`Blocked by` 和交付行为，再让用户调整粒度、依赖及拆并关系。批准前的编号用于讨论，还不一定是跟踪系统中的真实工作项 ID。

这一步审任务结构，也不能替代验收条件的质量判断：模板虽然要求复选框，却没有要求逐条证明“起始版本会失败、完成后会通过”。使用时可检查：什么可观察结果能够证明这条条件尚未满足？如果答案依赖另一张票据，当前切片或阻塞关系很可能还没划清。

### 5、先发布阻塞项，让依赖项拿到真实标识

`skills/engineering/to-tickets/SKILL.md` → `5. Publish the tickets to the configured tracker` 按跟踪系统分两支：

| 跟踪系统 | 一张票据如何保存 | 依赖如何保存 |
| --- | --- | --- |
| 文件型 | `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 按依赖顺序编号 | `Blocked by` 写所依赖票据的编号或标题 |
| 平台型 | 每张票据创建一个工作项，先创建阻塞项 | 优先使用平台原生阻塞或子任务关系；不支持时才退回正文引用 |

同文件 → `<local-ticket-template>`，摘录状态与验收部分，省略标题、交付行为和依赖字段：

```markdown
**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

文件型输出是一张票据一个文件；平台型模板使用 `Parent`、`What to build`、`Acceptance criteria`、`Blocked by`。只有来源本来就是工作项时才保留 `Parent`。父子关系说明归属，阻塞关系说明开始条件；仅有父工作项引用并不能表达兄弟票据之间谁先谁后。

先发布阻塞项，使依赖项创建时能引用真实 ID。两个模板都继续避免易过期的实现路径与代码，只保留原型片段的同类例外。平台分支还要求默认应用 `ready-for-agent` 标签，除非另有指示。

来源：同文件 → 第 5 步，摘录两条收尾约束：

```markdown
Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close or modify any parent issue.
```

frontier（当前可推进集合）是所有前置票据已经完成的工作单元。这里给出了选择规则，没有实现领取、锁定或并行调度的程序。`ready-for-agent` 也不代表没有 blocker；调度者必须同时读取标签和完成状态。

## 四、产物接上了，哪些状态仍需显式维护

### 1、发布、领取和完成是三个不同动作

`to-tickets` 的终点是产物。下游 `implement` 要求实现、测试、审查和提交，却没有更新票据状态、勾选验收项或关闭工作项的指令。即使代码已经交付，跟踪系统里的 blocker 仍可能显示未完成，后继票据便不会自然进入可推进集合。

`to-tickets` 明令不得修改父工作项，也不能指望它顺手去掉父规格的 `ready-for-agent` 标签。按标签领取任务的执行者需要另行区分父规格与工作票据；文件型跟踪系统需要另行定义完成状态怎样记录。这里缺少的是跨 skill 的状态交接协议，增加流程箭头无法补上。

### 2、依赖图和发布错误没有程序保证

源码要求先发 blocker、后发依赖项，但没有检查循环依赖的脚本，也没有发布事务。A 依赖 B、B 又依赖 A 时，没有可开始项；创建到一半失败时，已经创建的工作项不会按文档自动回滚。重跑如果不核对已发布对象，还可能制造重复项。

自编同类 skill 时，应把“草案编号 → 已发布 ID”的对应关系、循环依赖如何处理、部分成功如何续发写在发布步骤附近。若这些约束必须可靠执行，就应交给能校验输入和报告结果的脚本或工具，再让模型解释结果；仅在 Markdown 中写“正确发布”仍然只是行为要求。

### 3、规格层是否值得保留，取决于上下文会不会丢失

工作能在一个会话内完成时，对话本身已经携带决定，未必需要同时生成规格和票据。跨会话、多人协作或分批交付时，规格才承担保存设计理由的价值，票据则约束单次上下文中的工作范围。

模板也有适用边界：大量用户故事适合行为丰富的功能；纯架构调整更应把篇幅放在接口、不变量和测试决定上，不能为填满故事列表虚构用户需求。长期有效的术语与架构取舍应分别进入词汇表和 ADR，不应要求一份交付规格永久兼任所有知识文档。
