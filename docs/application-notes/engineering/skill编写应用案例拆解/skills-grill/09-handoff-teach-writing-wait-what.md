---
sidebar_position: 10
title: "handoff、teach、writing-for-agents 与 wait-what：上下文怎样移动、累积和纠偏"
description: 从 mattpocock/skills 源码拆解上下文交接、跨会话学习、agent 文档写作和会话纠偏如何分别管理状态与认知负载。
---

# handoff、teach、writing-for-agents 与 wait-what：上下文怎样移动、累积和纠偏

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先看四种上下文问题

前八篇文章已经覆盖了如何选择流程、澄清决定、保存领域语言、研究事实和推进实现。本篇的四个 Skill 处理工作流运行之后的上下文问题：

```text
当前会话需要换 harness、目录或协作者
                  │
                  ▼
               /handoff
                  │  临时目录中的便携文档
                  ▼
              新会话继续工作

用户要跨多个 session 学习一个概念
                  │
                  ▼
                /teach
                  │  mission + resources + lessons + records
                  ▼
             持久化学习 workspace

需要编写 Skill、AGENTS.md 或其他 agent 文档
                  │
                  ▼
          /writing-for-agents
                  │  pointer + hierarchy + completion criteria
                  ▼
             可预测的 agent 行为

解释已经发出，但用户没有理解
                  │
                  ▼
              /wait-what
                  │  简化重述 + 项目词汇
                  ▼
             回到原来的会话流程
```

四者的输入、产物和状态载体不同：

| Skill | 处理对象 | 主要产物 | 是否改变主流程 |
| --- | --- | --- | --- |
| `/handoff` | 要离开当前上下文但仍需继续的工作 | 临时目录中的 handoff Markdown | 交接上下文，通常跨越 phase boundary |
| `/teach` | 跨会话学习一个概念的长期目标 | 教学 workspace、lesson、reference、learning record | 建立独立学习状态，不并入工程交付流 |
| `/writing-for-agents` | Skill、`AGENTS.md`、`CLAUDE.md` 等 agent 消费文档 | 写作原则与 Skill packaging 规则 | 改变文档质量，不直接改变业务代码 |
| `/wait-what` | 当前解释没有被理解的会话瞬间 | 一次更清楚的重述 | 不开启新阶段，不产生持久交付物 |

`handoff` 解决上下文的位置变化，`teach` 解决知识的时间积累，`writing-for-agents` 解决指令如何进入 agent 上下文，`wait-what` 解决当前对话中的理解断点。把它们合并成一个“上下文管理 Skill”会丢失这些边界。

## `handoff`：为上下文移动制作便携交接

### 交接文档放在临时目录

`skills/productivity/handoff/SKILL.md` 的入口约束是：

```yaml
---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---
```

正文要求把当前对话总结成 handoff document，并保存到用户操作系统的临时目录，而不是当前 workspace。这个位置选择表达了产物用途：文件负责把上下文搬到另一个 harness、目录、协作者或分叉任务，不负责成为项目长期知识库。

`handoff` 的结果由下一会话消费。它应当包含目标、已确认事实、未决问题、文件或 URL 位置、下一步和 suggested skills，同时引用已经存在的 spec、plan、ADR、Issue、commit 或 diff：

```markdown
Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.
```

这里的“引用而不复制”维护了单一事实来源。交接文件只保存新会话需要的导航信息；若把规格全文、Issue 详情和 diff 再复制一遍，后续修改会产生多个版本，agent 还需要判断哪个版本更新。

### 交接同时承担安全边界

源码要求脱敏 API key、密码和个人身份信息。交接文件可能离开当前 harness、目录或协作者边界，敏感数据不能因为“只是上下文摘要”而被带走。交接时还要列出 suggested skills，帮助新 agent 先恢复正确的能力入口，而不是从摘要中重新猜测下一步。

`handoff/agents/openai.yaml` 只声明显示名称和简介，但 frontmatter 设置了 `disable-model-invocation: true`，并且要求写外部可携带文件。用户必须明确决定何时切换上下文、下一会话做什么以及哪些信息可以离开当前工作区。因此它属于显式入口，不能由模型因为看见“上下文很长”就自动创建并传播。

### 与 `/compact` 的边界

`ask-matt/SKILL.md` 把 `/handoff` 和 `/compact` 放在 phase boundary 的不同分支：

- `/compact` 适用于同一工作流、同一目录和同一 harness 内继续，只压缩当前上下文；
- `/handoff` 适用于新 harness、新目录、协作者或中途分叉，产出一个可携带文件；
- `/clear` 适用于当前上下文已经与下一步无关的情况，不承担事实交接。

这个划分按照上下文的消费者来决定工具。压缩只需要保留给当前 agent 的摘要；交接需要写出另一个 agent 能独立消费的路径、事实和下一步。两者都可以减少 token，但状态边界不同。

## `teach`：把学习变成有状态 workspace

### 学习目标先写入 mission

`skills/productivity/teach/SKILL.md` 将当前目录定义成 teaching workspace。它要求用 `MISSION.md` 记录用户为什么学习这个主题，并用 mission 指导后续资源、课程和练习选择。`MISSION-FORMAT.md` 把 mission 分成四部分：

```markdown
# Mission: {Topic}

## Why
...

## Success looks like
- ...

## Constraints
- ...

## Out of scope
- ...
```

`Why` 要写现实目标，不写抽象的“理解某概念”；`Success looks like` 要描述可观察能力；`Constraints` 限定时间、预算和已有承诺；`Out of scope` 防止课程在相邻主题上无限扩张。

源码要求 mission 只有一个，并在目标发生变化时先与用户确认，再更新文件并增加 learning record。它把“教什么”与“用户为什么需要它”分开保存，避免每个 session 根据最近一次提问临时调整课程方向。

### workspace 把知识、技能和智慧分层

`teach/SKILL.md` 列出教学 workspace 的长期状态：

```text
MISSION.md                 学习动机和成功标准
RESOURCES.md               可探索的高质量资源
reference/*.html           可打印的压缩参考资料
lessons/*.html             单一主题的交互课程
learning-records/*.md      非显然学习结果和关键纠正
NOTES.md                   用户偏好和工作笔记
assets/*                   lesson 之间复用的组件
```

这些文件不是一份大笔记的不同章节。它们由不同阶段和不同消费者使用：

| 文件或目录 | 保存什么 | 主要消费者 |
| --- | --- | --- |
| `MISSION.md` | 学习原因、成功标准、约束和范围 | 每次规划下一课的 agent |
| `RESOURCES.md` | 高信任资料清单 | 研究和课程设计 |
| `reference/` | 方便反复查阅的知识压缩 | 后续 lesson 和用户复习 |
| `lessons/` | 一个短小、可完成的交互学习单元 | 用户的技能练习 |
| `learning-records/` | 已真正掌握、纠正或确认的非显然结论 | zone of proximal development 判断 |
| `assets/` | 多个 lesson 可复用的样式、组件和练习部件 | lesson 作者 |
| `NOTES.md` | 用户表达的教学偏好和工作笔记 | 后续教学 session |

这种目录结构把“资源、教学过程、学习证据和生成组件”分开。目录名本身不能证明系统已经自动创建这些文件；它们是 `teach` Skill 规定的 workspace 契约，实际生成时仍受当前环境能力和用户许可约束。

### `MISSION.md`、`RESOURCES.md` 与 lesson 的顺序

`teach` 的哲学把学习拆成三种结果：

- **Knowledge**：从高信任资源获取知识；
- **Skills**：通过相关 lesson 和反馈练习形成可迁移能力；
- **Wisdom**：通过真实世界中的实践和社区互动获得判断。

在 `RESOURCES.md` 尚未建立之前，Skill 要先找高质量资料，不能只依赖模型记忆。lesson 只包含掌握当前技能所需的知识，然后让用户通过交互反馈练习。lesson 还应推荐一个 primary source，并链接到其他 lesson 和 reference document。

`teach` 因此维护两条不同的闭环：

```text
高信任资源 → 知识压缩 → lesson → 练习反馈
                                  │
                                  ▼
                         learning record
                                  │
                                  ▼
                    下一次 session 的难度判断

lesson / reference → 真实世界实践 → 社区交互 → wisdom
```

教学 workspace 的目标不是积累越多越好。`MISSION.md` 是指南针，`reference` 供快速回忆，`lesson` 负责技能练习，`learning-records` 只记录已经有证据的学习结果。单纯“本次讲过”不算 learning record。

## `teach` 的持久化机制：什么值得留下

### learning record 记录改变未来教学的事实

`LEARNING-RECORD-FORMAT.md` 把 learning record 定义成 ADR 类似物，保存非显然 lesson、关键洞察和已确认的先验知识。格式保持极简：标题加一到三句说明，只有真正增加价值时才加入 Status、Evidence 和 Implications。

记录条件很窄：

1. 用户展示了对非平凡概念的真实理解；
2. 用户透露已有知识，未来不应重复教学；
3. 一个误解被纠正；
4. mission 因学习发生改变。

已覆盖但没有理解证据的内容不能写入 learning record。它保存的是“未来教学应如何改变”的事实，不是 session 活动日志。编号使用 `0001-<dash-case-name>.md`，通过扫描已有记录递增。

当后续记录推翻先前理解时，旧记录标记为 `superseded by LR-NNNN`，不直接删除。学习历史本身是未来教学的信号：agent 可以知道一个概念曾经被理解过、后来又被修正。

### reference、lesson 和 learning record 不能互相替代

三者都可能涉及同一主题，但生命周期不同：

- reference 是稳定、压缩、方便查阅的知识单元；
- lesson 是短小、可交互、面向一次技能获得的课程；
- learning record 是关于用户当前掌握程度或关键纠正的状态记录。

如果把所有内容都写入 lesson，用户下次复习需要重新运行整节课程；如果把用户是否掌握写进 reference，知识文档就混入个体状态；如果把每次活动都写成 learning record，后续 agent 无法区分真正的学习证据和过程噪音。

### 学习状态与工程上下文分离

`teach` 的 workspace 可以使用当前目录，但它的 mission、resources、lesson 和 learning records 服务于长期教学目标。它与工程项目的 `CONTEXT.md`、ADR、spec 和 Issue tracker 有不同消费者。一个工程仓库可以同时承载教学文件，但不能据此把教学 workspace 当作工程 Skill 的默认状态目录，也不能把学习记录自动写入项目领域 glossary。

这种分离减少了两类污染：教学过程不会把个人掌握程度写进生产项目文档；项目的实现细节也不会无意中成为 lesson 的长期事实。需要把工程概念教给用户时，应通过 reference 或 lesson 选择性引用项目资料，而不是把整个工程状态复制进教学 workspace。

## `writing-for-agents`：把文档写成可执行上下文

### 文档的目标是稳定过程

`writing-for-agents/SKILL.md` 的开头把适用范围扩展到所有 agent 消费的文档：Skill、`AGENTS.md`、`CLAUDE.md` 和被 pointer 指向的文档。它给出一个核心判断：文档质量由 agent 是否每次采取同样的过程决定，不要求每次产生完全相同的输出。

```markdown
The same levers make each one predictable — the agent taking the same **process** every run, not producing the same output.
```

这条原则解释了后续所有术语。一个 Skill 可以允许不同输出，但输入分支、步骤顺序、完成标准和引用资料的边界应足够稳定。文档写作关注过程合同，不追求把模型变成模板填充器。

### context pointer 管理上下文负载

`writing-for-agents` 把 context pointer（上下文指针）定义为：在当前 agent 上下文中，指向外部材料并同时写明何时应该读取它的引用。Skill 的 description、`AGENTS.md` 中指向某个文档的句子，都属于 pointer。

一个合格 pointer 要完成两件事：

1. 说清楚目标材料是什么；
2. 列出触发读取的分支。

源码要求把 leading word 放在 pointer 开头，每个分支使用一个触发条件，删除正文已经携带的身份信息。指针写得含糊时，即使目标文档内容很好，agent 也可能不会在正确的阶段读取它。

### 两种负载决定怎样拆文档

文档会消耗两种不同负载：

- **context load**：始终进入 agent 上下文的材料，例如 `AGENTS.md` 一行或 Skill description；
- **cognitive load**：人需要记住有哪些文档以及什么时候调用它们。

把材料移到 pointer 后面，可以减少 context load，却增加一项人类需要知道的入口。源码没有把 cognitive load 当成必须消除的成本：涉及用户判断的入口可以保留显式 Skill，让用户决定何时触发；共享参考能力则可以设计为 model-invoked，减少人类记忆负担。

`writing-for-agents/SKILL.md` 因此要求写作者在“始终加载”和“按分支读取”之间作选择，而非机械地把所有规则塞进一个 `SKILL.md`。

### 信息层级保护步骤

源码把文档内容分成两类：

- **steps**：agent 按顺序执行的动作；
- **reference**：定义、规则和按需查阅的事实。

它们可以混在同一文件，但放置层级不同：

```text
in-file step
    ↓
in-file reference
    ↓
disclosed reference
```

progressive disclosure（渐进披露）把只有某些分支需要的资料推到单独文件，并通过 pointer 触发。所有分支都需要的规则留在主文件；特定分支才需要的细节才外置。源码强调，这首先是层级和可读性问题，其次才是 token 优化：如果步骤被藏在需要按条件读取的参考文档里，agent 容易漏掉真正的执行动作。

co-location（共置）是同一层级内的组织规则。一个概念的定义、规则和例外应放在同一标题下，避免读到定义时错过旁边的约束。它与 duplication 不同：duplication 是同一含义出现多份，co-location 处理的是一个含义被拆散到多个位置。

### 步骤需要可检查的完成条件

每个步骤都要有 completion criterion。标准包含两个维度：

- **clarity**：agent 能区分已完成和未完成；
- **demand**：标准要求覆盖哪些对象，能否迫使 agent 做完必要的调查。

“理解已经达成”是弱标准，容易让 agent 提前结束；“每个修改过的模型都已核对”才会给出可检查的范围。源码建议先收紧完成条件；只有边界无法消除且确实出现提前完成时，才通过真实上下文边界拆分序列，例如 handoff 或 subagent dispatch。单纯在同一上下文里把后续步骤放到另一个标题下，并不会真正减少后续步骤对当前 agent 的可见性。

### leading words 与 pruning

leading word（引导词）是一个已有稳定含义的短词，例如 `frontier`、`tight` 或 `red`。重复使用短词可以召回一组共享行为，减少每次重新解释整套规则的负担。自造术语也可以使用，但需要付出定义成本；优先选择 agent 已经熟悉、项目上下文又能收紧含义的词。

pruning（修剪）要求逐句检查文档：

- 同一含义只保留一个权威来源；
- 环境本身能查到的命令和配置，不要复制成容易过期的缓存；
- 删除不再相关或已经沉积的内容；
- 删除模型默认会做、但没有改变行为的 no-op 句子；
- 只有无法改成正向目标的硬性边界才保留否定句，并同时写清应该做什么。

这套规则把“写长一点更安全”的直觉反过来：额外句子会消耗注意力，也会增加 stale sediment（过期沉积）留在 Skill 中的概率。正文应承载流程和必要规则，其余材料通过明确 pointer 暴露。

## `SKILL-MECHANICS.md`：调用方式也是文档设计

### model-invoked 与 user-invoked 的取舍

`writing-for-agents/SKILL-MECHANICS.md` 专门补充 Skill packaging 的 frontmatter 和调用选择。两种模式承担不同负载：

| 类型 | 配置 | 结果 | 适用对象 |
| --- | --- | --- | --- |
| model-invoked | 保留 `description`，省略 `disable-model-invocation` | 模型可以根据描述自动调用，description 持续占用 context load | 流程必须自行发现的能力或共享参考 |
| user-invoked | 设置 `disable-model-invocation: true` | 只有用户输入名称才能调用，减少持续上下文负载 | 改变状态、需要用户决定或只应手动启动的入口 |

这里的判断不以“用户能不能显式输入”为标准。用户始终可以显式调用 model-invoked Skill；关键区别在于模型和其他 Skill 是否可以自行到达它。把一个 Skill 设为 user-invoked，会把发现成本交给人；保留 description，会让所有上下文长期承担一行额外负载。

`handoff`、`teach`、`to-questionnaire` 和 `wait-what` 都是显式入口；`writing-for-agents` 自身是可被其他 Skill 参考的 model-invoked 文档。这个配置与它们的副作用一致：前三者会建立或转移状态，`wait-what` 需要用户明确表示上一条没有落地；写作参考则适合在创建 Skill 或修改 agent 文档时被模型调用。

### router skill 减少人的索引负担

当 user-invoked Skill 数量增加，人需要记住的入口会变多。源码提出 router skill：一个显式入口列出其他 Skill 及其适用时机，降低用户记忆成本。`ask-matt` 正是这个角色；它能推荐 `/handoff`、`/teach`、`/writing-for-agents` 和 `/wait-what`，但不会因为描述了它们就隐式调用 user-invoked Skill。

router 只能提示，不能替用户触发显式入口。这保留了涉及目录切换、学习任务、文档修改和上下文重述时的人类判断。模型自动发现的能力和人类主动选择的阶段入口由 invocation 配置分开表达。

### 什么时候应该拆 Skill

`SKILL-MECHANICS.md` 给出按 invocation 拆分的边界：只有当某个独立 leading word 真正会出现在用户 prompt 中，或者另一个 Skill 必须独立调用它时，才值得拆出 model-invoked Skill。拆分会增加 cognitive load 或 context load，独立 reach 必须足以抵消成本。

这条原则也适用于当前四个 Skill：handoff、teach、wait-what 处理不同用户意图，拆分后入口清楚；writing-for-agents 承担共享参考能力，需要被文档写作流程独立指向。把四种能力合并为“context-tools”会减少文件数，却隐藏触发条件和副作用。

## `wait-what`：只修复理解断点

### 输入是上一条没有落地的信息

`wait-what/SKILL.md` 只有 frontmatter 和一条执行指令：

```yaml
---
name: wait-what
description: Stop. That last message did not land — re-pitch it.
disable-model-invocation: true
---
```

```markdown
Wait — I don't understand where you've got to here. Re-pitch that: give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md`.
```

它的输入不是新需求，也不是一个待实现 bug，而是当前会话中用户没有理解上一条解释的信号。Skill 重新组织已经存在的内容：补上必要上下文，使用简化技术英语，换成项目已确认的 ubiquitous language（通用语言）。

### 纠偏不改变工作流状态

`wait-what` 不创建 spec、Issue、ADR 或新的学习记录，也不重新运行完整 grilling。它只修复表达层的失败，然后回到原来的阶段：

```text
原流程中的解释
      │
      ▼
用户表示没有理解
      │
      ▼
/wait-what
      │  context + 简化英语 + CONTEXT vocabulary
      ▼
用户重新理解
      │
      ▼
原流程继续
```

这条边界很重要。解释失败和需求不清是两个不同问题：前者应重述已有内容，后者才需要 `/grilling`；把每次“没听懂”都升级成新访谈，会增加状态和上下文，却没有产生新的决定。

`wait-what/agents/openai.yaml` 设置 `allow_implicit_invocation: false`，与 `disable-model-invocation: true` 一致。模型不能自行判断用户已经理解失败并强制重述；用户保留触发纠偏的控制权。

## 四者如何组合

### phase boundary 决定用 handoff 还是 compact

`ask-matt` 的阶段边界把 Continue、`/clear`、`/handoff`、subagent 和 `/compact` 分成五种处理方式。这里的选择依据不是“上下文是否很多”，而是下一个消费者是谁：

- 同一会话、同一工作目录继续：Continue；
- 当前内容与下一步无关：`/clear`；
- 另一个 harness、目录、协作者或分叉任务需要继续：`/handoff`；
- 一项范围清楚的独立工作交给自己的上下文：subagent；
- 同一流程继续，但当前窗口需要压缩：`/compact`。

`handoff` 形成跨边界的便携状态，`compact` 形成同一流程内的上下文压缩。两者都可以在实现、prototype 或 wayfinder 阶段出现，但只应在相应消费者需要时使用。

### teach 是独立的长期流程

`teach` 不嵌入从 idea 到 ship 的主工程流。它可以使用项目资料作为教学资源，也可以在 lesson 中练习某个工程技能，但 mission、learning-record 和 lesson 保存的是学习状态，不是项目交付状态。

用户需要学习一个概念时，`ask-matt` 将 `/teach` 列为 standalone；用户需要把一个决定交给另一个 agent 时，使用 `/handoff`。两者都跨 session，但交接关注一次任务的连续性，教学关注长期能力的变化。

### writing-for-agents 维护所有 Skill 的文档合同

编写或修改 `SKILL.md`、`AGENTS.md`、`CLAUDE.md` 时，`/writing-for-agents` 提供统一判断框架；`SKILL-MECHANICS.md` 再处理 frontmatter、description 和 invocation。它可以被 `skill-creator` 或其他文档流程调用，但不替代具体 Skill 的领域事实。

其输出不是某个业务流程的状态文件，而是更可靠的指令结构：每个步骤有完成条件，外部资料有 pointer，持续加载内容经过 pruning，user/model invocation 与副作用相匹配。

### wait-what 可以插入任何阶段

`wait-what` 是会话内纠偏能力，能够插入 grilling、research、prototype、to-spec 或 implement 的解释节点。它不消费或修改这些流程的持久产物，只让参与者回到同一个共享语境。原流程继续时，仍应遵守原来的 phase boundary 和完成条件。

## 运行边界与工程代价

| 阶段 | 状态归属 | 主要副作用 | 下游消费者 |
| --- | --- | --- | --- |
| handoff | OS 临时目录 | 写便携 Markdown、汇总路径、脱敏上下文 | 新 harness、目录、协作者或分叉任务 |
| teach setup | 当前教学 workspace | 创建 mission、resources、reference、lesson、record 等文件 | 后续 teaching sessions |
| teach lesson | 教学 workspace 与用户交互 | 读取资源、生成课程、获取反馈和学习证据 | 下一课的难度判断与复习 |
| writing-for-agents | Skill、`AGENTS.md`、`CLAUDE.md` 文档 | 组织 pointer、步骤、reference 和 invocation | 其他 agent 和 Skill |
| wait-what | 当前对话上下文 | 重述上一条消息，不写持久文件 | 原阶段继续运行 |

这套结构减少了四种混乱：

- 把跨目录交接误当成普通摘要，导致新 agent 缺少目标和下一步；
- 把长期学习记录和工程项目上下文混在一起；
- 把 agent 文档写成面向人的说明，缺少分支、完成标准和引用层级；
- 把解释没有被理解误判成需求需要重新设计。

代价也明确：

- handoff 需要维护引用和脱敏，临时文件还必须被新消费者找到；
- teach 需要长期维护多类 workspace 文件，并判断哪些内容真的属于学习证据；
- writing-for-agents 要求作者同时考虑模型的 context load 和人的 cognitive load，短文不一定比分层文档更好；
- wait-what 依赖用户主动报告理解断点，模型不能可靠地替他们判断“已经理解”；
- user-invoked Skill 减少持续上下文负载，却增加人需要记住入口的成本；model-invoked Skill 反过来减少发现成本，却会永久占用 description 的上下文空间。

## 迁移边界

### 可以采用

- 按上下文消费者区分压缩、交接、长期学习和会话纠偏；
- handoff 只保存新会话需要的导航信息，引用 spec、ADR、Issue、commit 和 diff 的单一来源；
- 将目标、成功标准、约束和范围写入长期学习 mission；
- 把资源、课程、参考资料和学习证据分成不同生命周期；
- 用 learning record 记录真正改变未来教学的理解、纠正和先验知识；
- 为 agent 文档建立 pointer、context load、cognitive load、information hierarchy 和 completion criteria 词汇；
- 用 progressive disclosure 保护主流程，用 co-location 避免同一概念的规则和例外散落；
- 根据真实调用副作用选择 model-invoked 或 user-invoked，并用 router skill 降低用户记忆成本；
- 用一个显式的会话纠偏入口重新表达上一条内容，保持原流程状态不变。

### 需要改造

- handoff 临时目录要映射到目标 harness 可访问、可清理且权限合适的位置；
- 没有跨 session workspace 的环境要重新定义 mission、lesson 和 learning record 的持久化载体；
- `reference/*.html`、`lessons/*.html` 等教学产物要适配目标平台的渲染和发布能力；
- 项目没有 `CONTEXT.md` 或统一领域语言时，要指定 wait-what 可使用的术语来源；
- 没有 Skill frontmatter 或隐式调用策略的 harness，需要用等价的注册和路由机制表达调用边界；
- 没有 subagent/handoff 真实上下文边界时，不应把文档拆分误写成上下文隔离；
- 对 agent 文档的验证方式要结合目标模型、工具集和实际运行反馈调整。

### 不应照搬

- 不要把 handoff 文件当作 spec、ADR 或 Issue 的第二份权威事实；
- 不要把敏感凭据、密码或个人信息带入可跨边界传播的交接文档；
- 不要把每次教学活动都写成 learning record，也不要把用户掌握程度写进通用 reference；
- 不要在没有 mission 和用户目标时批量生成抽象课程；
- 不要把所有 agent 文档内容都塞进始终加载的 `SKILL.md`，也不要把必要步骤藏在弱 pointer 后面；
- 不要使用含糊的“理解完成”“检查一下”作为唯一 completion criterion；
- 不要为了减少文件数把所有 user-invoked Skill 合并成一个无法判断副作用的入口；
- 不要让 `/wait-what` 自动开启新一轮需求访谈、修改规格或改变当前阶段；
- 不要把 model-invoked 的可发现性当作无成本，description 会持续占用上下文负载。

## 编写上下文型 Skill 的检查清单

- [ ] handoff 是否说明下一会话的用途、目标、事实、未决问题、路径和下一步？
- [ ] handoff 是否引用已有 spec、ADR、Issue、commit 和 diff，而不是复制它们？
- [ ] handoff 是否写入正确的跨边界位置，并完成敏感信息脱敏？
- [ ] teach 是否先建立 mission，并定义可观察的成功标准、约束和范围？
- [ ] 教学 workspace 是否区分资源、reference、lesson、learning record、assets 和 notes？
- [ ] 是否只有有理解证据的内容才进入 learning record，并支持后续记录 supersede 旧记录？
- [ ] agent 文档是否说明 pointer 指向什么，以及每个分支何时读取？
- [ ] 是否区分 context load 和 cognitive load，并据此选择 inline、disclosed reference 或 user-invoked？
- [ ] steps 是否按顺序组织，reference 是否放在合适的层级，pointer 是否会隐藏真正需要执行的步骤？
- [ ] 每个步骤是否有清晰且有覆盖要求的 completion criterion？
- [ ] 是否使用稳定 leading words、co-location 和 pruning，删除重复、过期和 no-op 句子？
- [ ] Skill 的 model/user invocation 是否与自动调用、写文件、状态修改和用户判断边界一致？
- [ ] router 是否只推荐显式 Skill，不绕过用户直接调用？
- [ ] wait-what 是否只重述当前没有落地的信息，并使用共享词汇和简化语言？
- [ ] 纠偏后是否回到原流程，没有额外创建交付物或改变阶段状态？
