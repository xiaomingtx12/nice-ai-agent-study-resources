---
sidebar_position: 1
title: "Matt Pocock Skills：一套工程 Skill 如何组织成工作流"
description: 沿触发、指令组合、项目配置和产物交接，理解 mattpocock/skills 怎样组织工程工作流，以及这些写法适合怎样复用。
---

# Matt Pocock Skills：一套工程 Skill 如何组织成工作流

:::info 源码基线与入口

项目为 `mattpocock/skills`，`package.json` 版本 `1.2.3`，源码快照为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。全系列以这一快照为准。表中路径均相对项目根目录；`SKILL.md` 是交给 agent 阅读的指令文件，入口用真实章节或正文定位，没有对应的程序函数。

| 相对路径 | 入口 | 用途 |
| --- | --- | --- |
| `.agents/invocation.md` | `Model-invoked vs user-invoked`、`Dependencies between them` | 触发方式和 skill 之间的依赖写法 |
| `skills/engineering/ask-matt/SKILL.md` | `The main flow: idea → ship`、`On-ramps` | 按任务状态选择工作流入口 |
| `skills/engineering/setup-matt-pocock-skills/SKILL.md` | `Process` | 把项目环境转成后续 skill 可读取的配置 |
| `skills/engineering/grill-with-docs/SKILL.md` | frontmatter 后的正文 | 组合访谈与领域建模 |
| `skills/engineering/implement/SKILL.md` | frontmatter 后的正文 | 组合实现、测试和审查 |

:::

这组 skill 把工程任务拆成不同粒度的指令：`ask-matt` 负责选入口，`grilling` 负责逐轮澄清，`domain-modeling` 负责维护术语和决策，`implement` 负责消费已明确的工作。它们通过会话内容、项目文档和 Issue（工作项）交换信息，由宿主中的 agent 阅读指令、选择工具并执行。

理解这套实现，需要同时看两个问题：一份 `SKILL.md` 如何约束当前任务，以及它把什么结果留给下一份指令。只记住命令名称，会漏掉“谁来决定下一步”和“换会话后还能读到什么”。

## 一、skill 的执行逻辑写在哪里

### 1、元数据决定何时发现，正文决定发现后怎样做

`SKILL.md` 头部的 YAML 元数据称为 frontmatter，存放名称、描述和触发配置。正文则告诉 agent 如何工作。`.agents/invocation.md` 将两类入口明确分开，以下摘录用户入口的定义：

```markdown
- **User-invoked** — reachable **only by the human typing its name**. Set `disable-model-invocation: true` in the frontmatter (Claude Code) and `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex). The `description` is **human-facing**: a one-line summary read by a person browsing slash-commands. Strip trigger lists ("Use when the user says…").
```

这是该项目的调用约定。用户显式入口的描述用于帮助人选择；允许模型调用的 skill 则在 `description` 中写清触发场景。比如“需要澄清设计决策”可以命中 `grilling`，“生成可执行 Issue”则是用户选择的 `to-tickets` 阶段。配套的 `agents/openai.yaml` 承载界面元数据及对应宿主的隐式调用策略。

这些文件不实现模型，也不提供独立调度器。宿主指运行 agent、加载指令并提供文件、终端等工具的环境。配置如何生效取决于宿主支持；正文中的“等待回答”“调用其他 skill”需要 agent 遵循，不能仅凭 Markdown 指令推断存在程序锁或异常处理器。

### 2、短入口把复用行为交给另一个 skill

`skills/engineering/grill-with-docs/SKILL.md` 的执行正文只有一句：

```markdown
Run a `/grilling` session, using the `/domain-modeling` skill.
```

`grilling` 规定提问顺序、事实调查和结束条件；`domain-modeling` 规定怎样澄清领域术语、更新 `CONTEXT.md`、记录 ADR。ADR 是架构决策记录，用来保存一项重要决定、采用理由和被放弃的方案。入口将两套行为一起带入当前会话，无须再复制它们的细则。

调用关系由自然语言表达。`.agents/invocation.md` 要求依赖写成 `/skill`，共享参考材料放在拥有它的 skill 内部。领域建模格式变化时只需改所属文件；代价是宿主必须能找到被依赖的 skill，模型也必须实际读取其指令。仓库没有一个包管理器自动解析这些依赖。

### 3、阶段衔接和内部调用要分开看

`ask-matt` 把 `/to-spec → /to-tickets → /implement` 列为工作路线，但这三个都是用户显式入口。路线表示上一阶段的产物适合交给下一阶段，由用户决定何时切换。

`implement` 的正文则要求使用可由模型调用的能力。以下是 `skills/engineering/implement/SKILL.md` 的连续摘录：

```markdown
Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
```

`tdd` 是测试驱动开发指令，该版本按一个行为的失败测试和最小实现推进，把重构放到审查阶段；seam 指事先约定的模块交界或测试入口。这里的 “where possible” 保留了使用条件，源码没有要求任何修改都强制走完整测试流程。`code-review` 在实现结束后按规范和规格两条线审查，随后正文要求提交当前分支。

这段组合存在一个交接缺口：`code-review` 要求固定比较基准，并使用 `git diff <fixed-point>...HEAD`；`implement` 没有提供这个基准，提交前的新修改也不会进入该差异。调用方需要明确待审状态和比较范围，才能让审查覆盖本次实现。第五、六篇会展开这一问题。源码还没有定义发现问题后的自动修复次数、提交失败重试或回滚协议；无人值守的变体需要补齐停止条件和恢复材料。

## 二、项目配置怎样成为公共输入

### 1、setup 把环境差异写成下游能读取的文件

Issue tracker（工作项跟踪系统）负责保存和跟踪工作项；Issue 指其中一项需求、缺陷、规格或实现工作。不同项目可能用 GitHub、GitLab，也可能以 Markdown 文件记录。`to-spec` 不应在执行到一半时猜测结果要写到哪里。

`setup-matt-pocock-skills` 负责建立这层约定。它在 `Process` 之前声明：

```markdown
This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.
```

执行从读取 Git 远端、既有 `CLAUDE.md` 或 `AGENTS.md`、文档目录及已安装能力开始。agent 据此提出 Issue tracker 建议；安装了 `triage` 才询问角色标签；只有发现多包仓库信号，才提供多领域文档布局选项。普通项目默认使用根目录的 `CONTEXT.md` 和 `docs/adr/`。

它展示拟写入的配置，接收用户修改，再更新项目指令文件中的 `Agent skills` 区块。结果分成几个可独立维护的文件：

| 产物 | 保存什么 | 谁消费 |
| --- | --- | --- |
| `docs/agents/issue-tracker.md` | 创建、读取和更新 Issue 的方式 | `to-spec`、`to-tickets`、`triage`、`wayfinder` |
| `docs/agents/triage-labels.md` | 分诊角色与实际标签字符串的映射 | `triage`，以及发布时使用 `ready-for-agent` 的 `to-spec`、`to-tickets` |
| `docs/agents/domain.md` | 术语文档及 ADR 的位置、读取规则 | 探索代码和维护领域知识的 skill |
| `CLAUDE.md` 或 `AGENTS.md` 中的引用 | 上述配置的入口 | 进入项目工作的 agent |

`Process → 4. Write` 规定：已有 `CLAUDE.md` 时修改它，否则使用已有 `AGENTS.md`；两者都没有才询问要创建哪个。已有 `Agent skills` 区块应原位更新，并保留周围的用户内容。这里的重复执行策略写在指令中，由 agent 实施，不能当成脚本已经完成了结构化合并。

标签配置还有一处条件不匹配：setup 仅在安装了 `triage` 时生成映射，而 `to-spec`、`to-tickets` 也要求提供标签词汇。如果只安装后两者，setup 可能省略它们需要的配置，重复运行也不保证补齐。编写这种公共配置入口时，生成条件需要覆盖所有消费者，不能只按文件名称判断它属于哪个 skill。

### 2、配置缺失是否阻塞，要看后果

`.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md` 区分两种依赖：`to-spec`、`to-tickets`、`triage` 缺少发布位置或标签映射，会把输出写错，因此明确提示先 setup；术语表和历史 ADR 则能提高测试、诊断或架构分析的准确度，缺失时仍可工作。

`skills/engineering/setup-matt-pocock-skills/domain.md` 的 `Before exploring, read these` 给出实际降级行为：

```markdown
If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.
```

因此 setup 主要确定“文档应该在哪里、怎样读取”，不会为了填满目录而预先生成全部领域知识。术语得到确认时再写术语表，重要决策落定时再写 ADR。对新 skill 而言，前置条件应绑定错误后果：缺了会写错位置就阻塞，缺了只少一层背景就允许降级。

## 三、一项需求怎样经过这些 skill

### 1、同一份信息在不同阶段变成不同产物

以下以“给已有服务增加某项能力”为说明场景，表格归纳 `ask-matt` 的路线，不代表仓库实现了自动调度这些阶段的程序。

| 当前材料 | 处理入口 | 新增或变化的状态 | 下一阶段怎样使用 |
| --- | --- | --- | --- |
| 模糊目标、现有代码和约束 | 用户选择 `grill-with-docs` | 会话中的未决问题逐轮减少；确认的术语和重要决定写入文档 | 继续澄清，或判断是否需要运行证据 |
| 纸面上难以判断的设计问题 | `prototype` | 生成可操作的实验，保留问题、运行方式和结论 | 将实验结果带回原讨论 |
| 已明确的行为和边界 | 用户选择 `to-spec` | 形成发布到 Issue tracker 的规格 | 拆分时以规格为共同依据 |
| 规格、预期验收行为 | 用户选择 `to-tickets` | 形成纵向实现 Issue，声明阻塞关系 | 选择前置工作已完成的 Issue |
| 可执行 Issue、已有实现 | 用户选择 `implement` | agent 按需使用 `tdd`，产生实现和测试，再调用 `code-review` | 结合审查结果收尾和提交 |

纵向实现 Issue 指一次穿过必要模块、交付一个可验证行为的工作单元。例如一个请求从入口到数据读取再到返回值的最小链路，比把“所有接口”“所有存储”分成两张大 Issue 更早暴露模块连接问题。源码将这种切片称为 tracer bullet，相关拆分准则在第四篇展开。

如果工作能在当前会话内说清并完成，`ask-matt` 允许从澄清直接进入 `implement`。跨会话交付需要更完整的规格和 Issue；把每个小改动都塞进全部阶段，会增加写文档和重新读取的成本。

### 2、状态保存在会话、文件和 Issue 中

访谈中的 design tree（设计决策树）和 frontier（前提已满足的待决问题集合）由模型在会话中维护；仓库没有为它们定义序列化对象或数据库表。用户回答后，agent 重新判断哪些问题已解决、哪些后续问题可以提问。

跨会话信息需要外部载体。`CONTEXT.md` 保存稳定术语，ADR 保存重要决策，规格保存要实现的行为，Issue 保存当前工作单元及其依赖。`handoff` 另外生成可携带的交接文件，用于换目录、换宿主、交给协作者或分出旁支任务。

`ask-matt` 建议澄清到拆分尽量保留连续上下文，使规格继承讨论理由；Issue 足够自包含后，各次实现可以从新会话开始。若规格只写“按上面讨论实现”，清理会话就会丢掉真正的约束。这也是拆分篇强调单张 Issue 必须独立可读的原因。

### 3、不同未知问题从不同入口处理

外部提交的原始需求先由 `triage` 判断信息是否齐全、谁适合接手；它不应再处理 `to-tickets` 已经整理好的 Issue。大型工作连决策路径都不清楚时，`wayfinder` 建立决策地图，以研究、原型和访谈逐步回答问题。地图清晰后通常先进入 `to-spec`，把分散决定整理为构建方案。

困难缺陷进入 `diagnosing-bugs`，先建立能观察到当前故障的反馈，再调查原因。外部资料不足可使用 `research`，只有他人才掌握的信息可通过 `to-questionnaire` 收集。这些入口补齐不同类型的证据，不要求用户把所有问题都重新包装成需求访谈。

## 四、按要理解的机制选择正文

| 正文 | 核心问题 |
| --- | --- |
| [01 · ask-matt](./01-ask-matt-router.md) | 路由如何推荐入口，何时保留或交接上下文？ |
| [02 · grilling](./02-grilling-interview.md) | 依赖关系如何决定提问轮次，事实调查如何与用户决策并行？ |
| [03 · grill-with-docs 与 domain-modeling](./03-grill-with-docs-domain-modeling.md) | 一句组合指令如何把访谈结果沉淀成术语和 ADR？ |
| [04 · to-spec 与 to-tickets](./04-to-spec-to-tickets.md) | 如何把讨论写成规格，再拆成可独立实现的 Issue？ |
| [05 · tdd、diagnosing-bugs 与 implement](./05-tdd-diagnosing-bugs-implement.md) | 测试和诊断怎样约束实现推进，失败反馈怎样进入下一轮？ |
| [06 · code-review、codebase-design 与架构改进](./06-code-review-codebase-design-architecture.md) | 固定审查范围、共享模块词汇和架构调查如何配合？ |
| [07 · triage 与 wayfinder](./07-triage-wayfinder.md) | Issue 角色和决策地图如何表达等待、认领、阻塞与完成？ |
| [08 · prototype、research 与 to-questionnaire](./08-prototype-research-questionnaire.md) | 运行实验、资料研究和他人反馈各自产生什么证据？ |
| [09 · handoff、teach、writing-for-agents 与 wait-what](./09-handoff-teach-writing-wait-what.md) | 上下文如何移动、跨会话积累和重新解释？ |
| [10 · 发布、安装与版本同步](./10-release-install-versioning.md) | 指令文件如何进入发布集合，维护脚本实际检查了什么？ |
| [11 · 怎样编写个人 skill](./11-writing-personal-skills.md) | 如何从重复任务写出第一版，并通过实际使用改进触发、过程和完成条件？ |
| [可直接使用 · source-walkthrough](./source-walkthrough/SKILL.md) | 一份完整的源码解析与文章改写 skill，可交给 agent 读取执行或迁移到目标宿主。 |

## 五、复用这套组织方式需要付出什么

`skills/` 下的 bucket 是目录分组：`engineering/`、`productivity/` 收纳正式发布能力；`misc/`、`in-progress/`、`deprecated/` 分别收纳较少使用、在建和退役的能力。目录分组与调用权限无关，`productivity/grill-me` 是用户入口，同组的 `grilling` 可以被模型调用。正式发布目录又不同于工作流顺序，`ask-matt` 单独维护它们之间的路线。

这套拆法让 `grill-me` 和 `grill-with-docs` 共享访谈规则，让 `triage`、`wayfinder` 也能复用 `grilling`；同时增加了名称依赖、配置入口和发布清单的维护成本。改名一个 skill，需要连同路由和调用方一起更新；修改一种产物格式，需要检查读取它的后续 skill。

编写自己的 skill 时，可以从一个具体任务开始：写清 agent 接到什么材料、需要补查哪些事实、哪些决定留给用户、产生什么可检查的结果、满足什么条件才结束。等多个入口确实重复同一种行为，再把它抽成共享 skill。`grill-with-docs` 的短正文能成立，是因为被调用的访谈和领域建模规则已经完整；脱离这些依赖，只复制那一句话不会得到同样的执行过程。
