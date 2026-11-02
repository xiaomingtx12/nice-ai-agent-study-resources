---
sidebar_position: 8
title: "triage 与 wayfinder：从外部请求到决策地图"
description: 从 mattpocock/skills 源码拆解 Issue triage 状态机与大型工作 wayfinding 如何分别管理需求入口、决策票据和可推进 frontier。
---

# `triage` 与 `wayfinder`：从外部请求到决策地图

:::info 版本与源码入口

本文分析 [mattpocock/skills](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，基线 commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。下列路径均相对项目根目录；这些文件提供模型指令，没有程序函数，入口按真实章节定位。

| 相对路径 | 章节入口 | 负责什么 |
| --- | --- | --- |
| `skills/engineering/triage/SKILL.md` | `Roles`、`Triage a specific issue or PR`、`Resuming a previous session` | 分类、核实、处理与恢复 |
| `skills/engineering/triage/AGENT-BRIEF.md` | `Principles`、`Template` | 可交给 agent 的任务说明 |
| `skills/engineering/triage/OUT-OF-SCOPE.md` | When to check `.out-of-scope/`、When to write to `.out-of-scope/` | 拒绝记录的复用与更新 |
| `skills/engineering/wayfinder/SKILL.md` | `The Map`、`Ticket Types`、`Invocation` | 决策地图及两种运行方式 |
| `skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md` | `Wayfinding operations` | 默认 Markdown 文件型 tracker 的读写约定 |
| `skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md` | `Wayfinding operations` | GitHub 子工作项及 task list 回退分支 |
| `skills/engineering/ask-matt/SKILL.md` | `On-ramps` | 两种入口如何接入交付流程 |

:::

## 一、两个入口管理不同的待办

`triage` 处理外部提交的工作项和按配置纳入的 PR（合并请求）：读懂诉求、验证事实、决定谁接手，并留下接手所需的说明。`wayfinder` 处理需要多次会话才能理清的大工作：确定目标，把可以明确表达的问题建成决策票据，逐项回答，直到路线清楚。

这里的 tracker 是项目使用的工作项跟踪系统，ticket 指其中的一项任务。`wayfinder` 的决策票据围绕一个问题组织，完成后留下答案。两个入口都把状态写入 tracker，但状态含义不同。

| 入口 | 最初输入 | 会话结束时留下什么 | 后续读取者 |
| --- | --- | --- | --- |
| `/triage` | 未整理的报告、评论，PR 还附带代码差异 | 类别和处理状态、任务说明或待补问题、必要的关闭原因 | 维护者、报告人、实现 agent |
| `/wayfinder` | 目标大致存在，但路线尚不明确的想法 | 地图索引、带依赖的决策票据、已回答的问题 | 下一次规划会话、规格编写者 |

两份 `SKILL.md` 的 `frontmatter`（文件头元数据）都设置 `disable-model-invocation: true`，各自的 `agents/openai.yaml` 也设置 `allow_implicit_invocation: false`。仓库将它们设计为用户显式启动的入口。**下文的执行顺序和状态迁移都是要求模型遵循的约定**：模型读取指令，再使用宿主提供的查询、评论、分配和文件工具。这里没有替模型强制执行流程的状态机程序。

`ask-matt` 的 `On-ramps` 把 `triage` 留给外部到来的原始请求；`to-tickets` 已生成的可实现任务不需要再做一次 `triage`。`wayfinder` 则只适合一轮会话装不下的不确定性，已经确定的计划应进入规格或实现拆分。

## 二、`triage`：先形成建议，再验证并落状态

### 1、类别与进度分别保存

类别 role（语义角色）只有 `bug` 和 `enhancement`，分别表示故障和改进需求；状态 role 有五种。role 是 skill 使用的标准语义，项目配置将这些语义映射到 tracker 的标签或状态字段。

源码：`skills/engineering/triage/SKILL.md` → `Roles`，节选：

```markdown
Every triaged issue should carry exactly one category role and one state role. If state roles conflict, flag it and ask the maintainer before doing anything else.
```

中间的角色映射说明省略，下面是状态迁移约定：

```markdown
State transitions: an unlabeled issue normally goes to `needs-triage` first; from there it moves to `needs-info`, `ready-for-agent`, `ready-for-human`, or `wontfix`. `needs-info` returns to `needs-triage` once the reporter replies. The maintainer can override at any time — flag transitions that look unusual and ask before proceeding.
```

“恰好一个”约束针对类别和状态角色，不禁止工作项带有其他业务标签。同一个 `bug` 可以从待评估变成待补信息，而不丢失问题性质。

| 状态 | 语义 | 后续变化 |
| --- | --- | --- |
| `needs-triage` | 维护者需要评估 | 可继续调查，也可转入其余四种状态 |
| `needs-info` | 等待报告人补充 | 报告人回复后重新评估，回到 `needs-triage` |
| `ready-for-agent` | 已足够明确，适合 agent 独立推进 | 发布 agent brief（供 agent 接手的任务说明） |
| `ready-for-human` | 需要人工接手 | 发布说明，并解释不能委派的原因 |
| `wontfix` | 不再推进本次请求 | 关闭并说明原因，部分情形更新拒绝记录 |

AFK 表示用户不必持续在场指导的工作。对 PR 而言，`ready-for-agent` 是让 agent 继续处理已有 diff；`ready-for-human` 的含义收窄为已可由人工合并。不能一概理解成“从头实现”。

### 2、发现列表只负责让维护者选择

`Show what needs attention` 要求查询三个集合，按从旧到新的顺序列出计数和一行摘要：未标记请求、`needs-triage` 请求，以及上次 triage notes（分类处理记录） 之后报告人有新活动的 `needs-info` 请求。随后让维护者选一项。

第三个集合说明了恢复机制：模型通过评论时间和历史记录判断是否有新信息，正文没有注册 webhook（事件回调）或后台监听。“回复后回到待评估”需要后续运行识别回复并落实状态变更。

若配置允许外部 PR 进入 `triage`，发现列表会增加 `[PR]` 和 `[issue]` 标识。外部作者过滤只用于发现；维护者明确点名某个 PR 时，无论作者是谁都可以处理。

### 3、单项处理从完整材料开始

`Triage a specific issue or PR` 的第一步是 `Gather context`。模型读取正文、评论、标签、作者和日期；处理 PR 时还读 diff。历史 triage notes（分类处理记录） 用来识别已回答的问题，领域词汇表和 ADR（架构决策记录）用于理解项目约束。

调查包含两个判断。重复能力检查按领域概念寻找已有实现，不能只搜索报告人的原词；历史拒绝检查读取 `.out-of-scope/*.md`，寻找相近概念。相似的旧拒绝是一条需要维护者判断的证据，不是自动关闭新请求的依据。

源码：`skills/engineering/triage/SKILL.md` → `Triage a specific issue or PR`，节选第二、三步：

```markdown
2. **Recommend.** Tell the maintainer your category and state recommendation with reasoning, plus a brief codebase summary relevant to the request — including whether it's already implemented. Wait for direction.

3. **Verify the claim.** Before any grilling, check that the claim holds up. For a bug, reproduce it from the reporter's steps. For a PR, confirm the diff does what it claims — check it out, run the relevant tests or commands. Report what happened: confirmed (with code path), failed, or insufficient detail (a strong `needs-info` signal). A confirmed verification makes a much stronger agent brief.
```

模型先报告分类和状态建议、调查理由，等待指示；继续后才验证主张。`bug` 按复现步骤检查，PR 核实代码是否实现声称的行为。结果分别报告为确认、验证失败或细节不足。验证失败不能直接写成“问题不存在”，细节不足则强烈支持请求补充信息。

请求仍缺少决定时，第四步才要求一起运行 `/grilling` 和 `/domain-modeling`。前者组织逐轮澄清，后者维护领域术语及决策记录；决定形成时更新 `CONTEXT.md` 或 ADR。这里有明确的跨 skill 指令，但没有要求每个请求都访谈，也没有要求调用完整的 `/grill-with-docs` 包装流程。

### 4、快速覆盖和暂停都属于正常路径

`Quick state override` 处理“把某项移到 `ready-for-agent`”这样的直接指令。它要求信任维护者，说明即将进行的角色修改、评论和关闭动作后执行，并跳过 `grilling`。如果没有访谈却要进入 `ready-for-agent`，还要问是否需要写 brief。该段没有把“说明将做什么”统一规定成额外一轮授权；状态异常、角色冲突和是否补 brief 才各有明确的提问条件。

普通路径的第五步也允许停在 `needs-triage`，只应用角色，必要时留言记录部分进展。因此每次运行不必强行产出一个可实现任务。还未查明、又不适合向报告人追问的问题，可以保留待评估状态。

## 三、`triage` 的产物决定下次会话能否接手

### 1、brief 把讨论收束成行为约定

`AGENT-BRIEF.md` 把 agent brief 定义为发布在工作项或 PR 下的结构化评论。它是后续 AFK agent 的权威任务说明，原始正文和讨论作为背景保存。

源码：`skills/engineering/triage/AGENT-BRIEF.md` → `Principles` / `Durability over precision`，节选：

```markdown
- **Do** describe interfaces, types, and behavioral contracts
- **Do** name specific types, function signatures, or config shapes that the agent should look for or modify
- **Don't** reference file paths — they go stale
- **Don't** reference line numbers
- **Don't** assume the current implementation structure will remain the same
```

任务可能排队数周，文件位置容易变化，接口名称和行为约定更能帮助接手者重新定位。调查时可以说明“在哪里找到证据”，写最终 brief 时则转向当前行为、期望行为、关键接口、验收条件与范围边界。

源码：同文件 → `Template`，节选期望行为和接口部分，其余字段省略：

```markdown
**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed
```

模板中的 `TypeName` 和 `functionName()` 是占位符，不是仓库实现入口。作者借它们要求模型提供有辨识度的接口信息，同时避免写死实现方法。每条验收条件必须可独立验证，范围外事项用于阻止 agent 顺手扩展相邻功能。

对 PR，`Current behavior` 描述已有 diff 做到了什么，`Desired behavior` 描述剩余缺口。配套示例中的 `--json` PR 已实现正常输出，brief 只要求补齐错误 JSON 和测试；重新要求 agent 从零设计序列化会浪费已有工作。`ready-for-human` 复用相同结构，再写明人工判断、外部访问或手动测试等委派障碍。

### 2、`needs-info` 保存已知与缺口

源码：`skills/engineering/triage/SKILL.md` → `Needs-info template`：

```markdown
## Triage Notes

**What we've established so far:**

- point 1
- point 2

**What we still need from you (@reporter):**

- question 1
- question 2
```

模板同时保存已经成立的事实，以及仍依赖报告人的问题。只留下“请提供更多信息”，下次会话还得重做调查。`Resuming a previous session` 要求读取记录，检查回复覆盖了哪些问题，先展示更新后的情况，再继续处理；已回答的问题不再提出。

每条 `triage` 发布的评论或新工作项都必须以下列声明开头。它限定的是发布内容，不是标签、分配等所有 tracker 操作。

源码：同文件 → Triage 开头的发布要求：

```markdown
> *This was generated by AI during triage.*
```

### 3、关闭原因决定是否写入拒绝知识库

`wontfix` 有三个分支：功能已存在时，评论指出现有实现，不写 `.out-of-scope/`；拒绝 `bug` 时解释后关闭；拒绝 `enhancement` 时才写入该目录，并从评论链接过去。

源码：`skills/engineering/triage/OUT-OF-SCOPE.md` → Directory structure、When to check `.out-of-scope/`，节选，两段之间省略格式说明：

```markdown
One file per **concept**, not per issue. Multiple issues requesting the same thing are grouped under one file.
```

```markdown
- **Confirm** — the new issue gets added to the existing file's "Prior requests" list, then closed
- **Reconsider** — the out-of-scope file gets deleted or updated, and the issue proceeds through normal triage
- **Disagree** — the issues are related but distinct, proceed with normal triage
```

例如 night theme 和 dark mode 可能属于同一概念，但相似匹配仍交给维护者确认。确认后把新请求加入已有文件；改变决定时更新或删除旧记录，新请求继续正常 `triage`，旧工作项不必自动重开；判断两者不同则继续调查。

拒绝原因应解释长期范围、技术约束或策略取舍。“最近太忙”属于延期，写成永久拒绝会误导未来会话。该版本没有单独表达“说明完整但被依赖阻塞”“延期”或“实现完成”的状态；brief 完整也不能等同于马上可执行，依赖信息仍需项目自己的跟踪约定承载。

## 四、`wayfinder`：用地图索引承载跨会话决策

### 1、目标、地图和决策票据分别保存什么

destination（目标终点）定义整项工作何时算路线清楚，可以是一份规格、一个待锁定的决定或一项明确变更。`wayfinder` 默认只做规划；`Plan, don't do` 允许在地图 `Notes` 中为某项工作声明携带执行，正常情况下，决策票据只解决问题，不承担产品实现切片。

主文件用带 `wayfinder:map` 标签的工作项描述地图，用子工作项承载决策票据。具体存储交给 tracker 文档的 `Wayfinding operations`：若未配置 tracker，主入口默认使用 Markdown 文件型实现，地图和票据分别对应文件。

源码：`skills/engineering/wayfinder/SKILL.md` → `The Map`，节选：

```markdown
The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.
```

地图正文有五个区域：

- `Destination`：目标终点。
- `Notes`：领域、每轮需参考的 skill 和长期偏好。
- `Decisions so far`：已解决决策票据的一行摘要与链接。
- `Not yet specified`：尚不能精确提问的范围内问题。
- `Out of scope`：排除事项及原因。

主文件要求不在地图正文枚举开放票据，需要时查询子工作项。GitHub 模板保留一个回退分支：未启用 sub-issues（子工作项关系）时，在地图正文增加 task list（任务链接清单），并在子项正文顶部写 `Part of #<map>`。查询 frontier 时按原生子项关系或这份清单限定范围。

源码：`skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md` → `Wayfinding operations`，节选：

```markdown
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
```

这份清单承担关联索引的作用，仍然只保存链接，不重复票据中的问题、完整答案和讨论。

下一次会话先读地图，看到某项历史决定与当前问题有关时再打开详情。地图随摘要增长，完整讨论留在各自票据下。链接用标题展示，读者在打开前就能判断相关性。

### 2、问题明确就能建决策票据，不必等到能回答

每张决策票据正文围绕一个 `Question`，源码给出的大小目标是一次 100K token 的 agent 会话能够处理。这是作者的切分尺度，不是程序检查的上限。

源码：`skills/engineering/wayfinder/SKILL.md` → Fog of war，节选：

```markdown
**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.
```

`fog of war` 指还看不清的问题区域。按这条规则，“某 API 是否提供撤销操作”已经足够明确，可以建成研究任务；尚未取得访问权限，就把开通权限设为前置任务。“外部整合还有哪些问题”还不够精确，则留在 `Not yet specified`。这是对规则的示意，不是源码内置案例。

一个答案可能让模糊区域分成多个新任务，也可能使它失去必要性。问题能建成票据后，要从 `Not yet specified` 删除对应内容，避免一件事留在两处。

范围之外的工作进入 `Out of scope`；如果已经建了票据，就关闭并链接过去，不记进 `Decisions so far`。扩大终点重新纳入这些工作时，源码要求另起一项工作，而非普通续跑。

### 3、依赖决定可推进集合，分配表示认领

frontier（当前可推进集合）由尚未完成、没有未完成 blocker（前置阻塞项）、且尚未认领的决策票据组成。共同语义是：开始前标记占用，答出问题后保存答案并标记完成，再更新地图索引。占用和完成如何表示，由 tracker 决定。

源码：`skills/engineering/wayfinder/SKILL.md` → `The Map` / Tickets，节选：

```markdown
A session **claims** a ticket by assigning it to the dev driving the map, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed.
```

这段 assignee（负责人）约定对应 GitHub、GitLab 等工作项平台。默认文件型分支不使用分配人或独立评论对象，实际操作如下。依赖也优先用平台原生关系，缺少该能力才回退到正文里的前置项列表。

| 操作 | Markdown 文件型 tracker | GitHub tracker |
| --- | --- | --- |
| 地图与票据 | `.scratch/<effort>/map.md`，每张票据一个 `issues/NN-<slug>.md` 文件 | 地图工作项与子工作项；未启用子项关系时用 task list |
| 类型 | 文件中的 `Type:` 行 | `wayfinder:<type>` 标签 |
| 前置依赖 | `Blocked by: NN, NN`；列出的文件均为 `resolved` 才解除阻塞 | 原生依赖；不可用时用 `Blocked by: #<n>`，所有前置项须关闭 |
| 选择顺序 | 扫描开放、未认领且未阻塞的文件，按编号取第一项 | 按地图的子项或 task list 查询，排除有未关闭 blocker 或 assignee 的项，按地图顺序取第一项 |
| 认领 | 写入并保存 `Status: claimed` | 分配给驱动地图的开发者 |
| 保存答案与完成 | 在同文件 `## Answer` 下追加答案，再设 `Status: resolved` | 发布答案评论，再关闭工作项 |
| 更新索引 | 将摘要与链接追加到 `map.md` 的已决事项区 | 追加到地图工作项的 `Decisions so far` |

源码：`skills/engineering/setup-matt-pocock-skills/issue-tracker-local.md` → `Wayfinding operations`，节选认领与完成：

```markdown
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
```

所以“关闭”在文件型分支中是更新状态，“答案评论”落成同文件的 Answer 区，而非调用一个评论接口。模板仅列出 claimed/resolved，没有单独规定新票据的初始状态字符串，不能凭空增加一个必填 open 值。

两种表示都没有在 skill 中实现原子抢占、租约过期或中断后释放。并发会话仍可能同时读到可认领状态；答案、完成标记和地图索引也不是一次事务。恢复时需要重新读取实际载体，确认哪些写入已成功，避免重复写入或遗漏索引。

## 五、`wayfinder` 的真实推进顺序

### 1、建图会话只展开已能表述的问题

`Invocation` / `Chart the map` 从用户的模糊想法出发，先要求一起使用 `/grilling` 和 `/domain-modeling` 确定 destination，再广度优先地横向找出问题空间与当前第一步。如果路线已经清楚、整件事一轮即可完成，就停止并询问用户如何继续，不创建地图。

需要地图时，建立地图工作项，填入 `Destination`、`Notes` 和初始未知区域，创建当前能准确表达的决策票据，再连接依赖。

源码：`skills/engineering/wayfinder/SKILL.md` → `Invocation` / `Chart the map`，节选四、五步：

```markdown
4. **Create the tickets you can specify now** as child issues of the map — then wire blocking edges in a **second pass** (issues need ids before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each `research` ticket you just created, spin up a `/research` subagent to resolve it in parallel, capturing its findings on a throwaway `research/<name>` branch with a context pointer from the ticket.
```

分两遍是因为依赖引用需要双方先有可引用的标识；平台用工作项 ID，文件型票据则用编号。context pointer（上下文指针）是一条说明材料用途的引用，让后续会话可以回到研究分支上的发现文件。建图会话随即停止，不亲自解决交互型决策票据；后台研究是明确允许的并行分支。

这里有一个未细化的交接点：第五步要求为每张新建的研究票据启动 subagent（子 agent），前面的 `frontier` 规则又要求先满足阻塞条件。正文没有说明被阻塞的研究任务如何排队。委派时需要一并提供依赖信息，不能把这些文字当成已实现的依赖调度器。

### 2、决策票据类型决定需要谁在场

HITL（人工参与过程）要求人亲自表达判断，AFK 允许 agent 独立推进。类型决定解决问题的方式。

| 类型 | 处理约定 | 结束条件与产物 |
| --- | --- | --- |
| `research` | AFK，由 `/research` subagent 查文档、API 等事实 | 写出发现与来源，链接到决策票据 |
| `prototype` | HITL，制作可供反馈的粗略材料；UI 或逻辑代码可用 `/prototype` | 人对具体材料形成判断，原型作为附件链接 |
| `grilling` | HITL，明确要求一起调用 `/grilling`、`/domain-modeling` | 对问题形成决定 |
| `task` | 可由 agent 完成则 AFK，否则向人提供明确步骤 | 前置操作完成，记录后续需要的事实 |

`prototype` 类型也可以产出提纲、草稿或 stub（用于占位和验证的简化材料），并非所有原型任务都生成网页。`task` 可以申请服务访问、准备可供判断的数据，但其理由是解除决策阻塞；把“开发整个功能”标成 `task` 会越过默认规划边界。

源码：`skills/engineering/wayfinder/SKILL.md` → `Ticket Types`，节选：

```markdown
Every ticket is either **HITL** — human in the loop, worked _with_ a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).
```

模型生成三个界面变体，不表示 `prototype` 决策票据已经解决，仍需人的反馈。人暂时不在时可以准备材料，但不能代替人给出最终答案。

### 3、续跑会话解决一项，再更新问题空间

`Work through the map` 的主入口接受地图 URL 或编号，也可以指定一张决策票据；文件型 tracker 则读取对应的地图或票据文件。模型先加载地图的低分辨率视图，用户点名就取该项，否则取 frontier 中排在前面的任务：文件型按编号，GitHub 按地图顺序。

认领之后展开相关票据详情，按 `Notes` 调用需参考的 skill；拿不准时用 `/grilling` 和 `/domain-modeling`。决定形成后，按 tracker 约定保存答案、标记完成，再把摘要指针追加到地图。下面主文件使用评论与关闭的表达，文件型分支对应上表中的 Answer 和 resolved。

源码：`skills/engineering/wayfinder/SKILL.md` → `Invocation` / `Work through the map`，节选四、五步：

```markdown
4. Record the resolution: post the answer as a **resolution comment**, **close** the issue, and **append a context pointer** to the map's Decisions-so-far.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.
```

原问题和答案分别保存，读者能看出“原来问了什么、最终如何回答”：平台分在正文与评论，文件型分在 Question 与 Answer 区。新答案可能解除阻塞、引出新问题，也可能让任务失效，所以更新地图不只是勾掉当前项，还需维护剩余问题的有效性。

每个会话最多解决一张决策票据，`research` 是例外。这限制的是完成范围，不禁止读取多个关联任务。路线清楚后，`ask-matt` 的 `On-ramps` 推荐用 `/to-spec` 汇总链接中的决定，再进入 `/to-tickets` 和 `/implement`；规模实际很小才可缩短流程。这是推荐给用户选择的后续路径，`wayfinder` 正文没有自动执行整条交付链。

## 六、编写同类 skill 时，哪些约定需要额外支撑

`triage` 把建议、事实验证和外部写入分开。`Recommend` 的等待点保留维护者判断，brief 的验收标准让接手者知道何时完成，`needs-info` 的双栏记录支持恢复。若要用于无人值守系统，还需真正实现回复监听、角色校验与失败重试，单靠五种标签无法补齐这些能力。

`wayfinder` 把导航、完整问题和未成形问题放在不同位置。代价是每次结论涉及多处 tracker 写入，认领冲突、半完成更新和失效引用需要宿主或团队约定处理。仅把这些文件装进能读 Markdown 的 agent，不会自动得到可靠的多会话调度。

`Plan, don't do` 还有一个具体弱点：允许执行的例外写在模型也会更新的 `Notes` 中。文字约定没有区分“用户批准的长期偏好”和“模型自行补写的说明”。若业务需要严格限制生产修改，应明确许可来源，并由工具权限限制实际动作，不能让模型写一条 `Notes` 后就将它当成自己的授权。
