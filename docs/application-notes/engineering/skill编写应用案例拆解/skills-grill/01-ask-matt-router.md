---
sidebar_position: 2
title: "ask-matt：路由型 Skill 怎样组织一组工程工作流"
description: 沿 ask-matt 的任务分支、能力委托和阶段边界，解释路由如何推荐下一入口，以及上下文与产物怎样接续。
---

# ask-matt：路由型 Skill 怎样组织一组工程工作流

:::info 版本基线与源码入口

项目：[`mattpocock/skills`](https://github.com/mattpocock/skills)。`package.json` 版本：`1.2.3`；commit：`84fdeffd12f2ee307994d1eb6feb48173b6e0502`。

| 项目相对路径 | 真实入口 | 阅读用途 |
| --- | --- | --- |
| `skills/engineering/ask-matt/SKILL.md` | `The main flow: idea → ship`、`On-ramps`、`Phase boundaries`、`Precondition` | 路径选择、上下文处理与前置条件 |
| `skills/engineering/ask-matt/PHASE-BOUNDARIES.md` | `The tree`、`These are judgement calls` | 阶段边界的判断顺序 |
| `skills/engineering/ask-matt/agents/openai.yaml` | `policy.allow_implicit_invocation` | 配套调用配置 |
| `.agents/invocation.md` | `Model-invoked vs user-invoked`、`Dependencies between them` | 人工入口与能力委托的边界 |
| `skills/engineering/implement/SKILL.md` | 正文 `Use /tdd where possible`、`Once done` 两段，无章节标题 | 核对实现阶段的内部委托 |
| `skills/engineering/code-review/SKILL.md` | `Process / 1. Pin the fixed point` | 审查范围与固定点要求 |
| `docs/engineering/ask-matt.md` | `What it does`、`Prerequisites`、`Common questions` | 配套说明中的行为边界与已知问题 |

以下摘录保留英文指令，中文解释紧随其后。Markdown 中的章节是模型阅读入口，不是程序函数。

:::

## 一、路由的结果是一项建议

`ask-matt` 接收用户对当前处境的描述，给出适合的 skill 或工作路径，以及哪些地方需要用户选择、保留上下文或切换会话。它的工作止于推荐；用户再显式进入相应流程。

这一边界在配套说明中比 `SKILL.md` 更明确。`docs/engineering/ask-matt.md` → `What it does`：

```markdown
It recommends and stops.
```

这里的停止指不启动所推荐的目标流程，并不禁止读取自身参考文件：`skills/engineering/ask-matt/SKILL.md` → `Phase boundaries` 明确要求阅读 `PHASE-BOUNDARIES.md`。推荐范围是本项目人工维护的流程地图，不是扫描已安装的全部 skill 后生成的清单。

因此，一次路由前后的变化是“用户不知道从哪里开始”变成“用户拿到下一入口和选择依据”。规格、工作项、代码和审查报告尚未产生。源码也没有路由注册表、条件执行器或工作流状态存储；模型阅读一张人工维护的流程地图，再结合用户描述作判断。

这里的 **flow（工作路径）** 是多个 skill 之间有条件的衔接。例如“想法需要跨多个会话实现”，对应澄清、规格、任务拆分和逐项实现；“只是一个已经明确的小改动”，则不必支付整条路径的文档成本。命令名相似并不是选路依据，任务阶段和缺少的材料才是。

## 二、人工入口怎样限制委托范围

### 1、调用配置与说明面向不同读者

`skills/engineering/ask-matt/SKILL.md` → frontmatter（文件头部元数据）：

```yaml
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
```

`skills/engineering/ask-matt/agents/openai.yaml` → `policy`：

```yaml
policy:
  allow_implicit_invocation: false
```

按本仓库 `.agents/invocation.md` 的约定，这两处配置共同表达“由用户显式调用”。其中 `description` 给浏览入口的人说明用途；允许模型调用的 skill 则在描述中保留丰富的触发条件，帮助模型判断何时使用。这是该快照的入口约定，`SKILL.md` 本身不实现权限检查。

### 2、推荐用户调用与指示模型使用要分开

`.agents/invocation.md` → `Model-invoked vs user-invoked`：

```markdown
A user-invoked skill may invoke model-invoked skills, but it can never reach another user-invoked skill.
```

人工入口可以要求模型使用允许模型调用的能力；另一个人工入口仍由用户发起。`ask-matt` 提到 `/grill-with-docs`、`/to-spec`、`/to-tickets`、`/implement` 时是在推荐路径，不代表模型可以自行连续启动它们。

同文件 → `Dependencies between them`：

```markdown
Dependencies are expressed as **`/skill`-style prose invocation** ("Run the `/grilling` skill"), not deep `../other-skill/FILE.md` cross-references. Shared reference docs live inside the skill that owns them; other skills reach that material by invoking the skill, not by linking across folders.
```

`/grilling` 这样的名字表达能力依赖，内部参考文件由该 skill 负责组织。这能让调用方避开被依赖方的目录细节，但它仍是文本指令：没有依赖解析器保证目标已安装、已加载或已执行。写自用路由时，需要分别表达“建议用户进入某流程”和“当前流程应使用某能力”，不能把两者都画成自动调用箭头。

## 三、主路径怎样把讨论变成可执行工作

### 1、先判断问题能否通过讨论解决

`skills/engineering/ask-matt/SKILL.md` → `The main flow: idea → ship`，第 2 步中的原型往返指令：

```markdown
   - **`/handoff`** out, then open a fresh session against that file,
   - **`/prototype`** to answer the question with throwaway code,
   - **`/handoff`** back what you learned, and reference it from the original idea thread.
```

主路径从 `/grill-with-docs` 开始，在项目中访谈并留下术语与必要决策记录；没有项目工作目录时，地图推荐 `/grill-me`。当问题必须运行状态逻辑、查看界面或体验交互才能回答时，才进入上述原型分支。

`/handoff` 负责把交接信息写成可携带的 Markdown 文件；原型使用独立目录和会话，回答一个设计问题；返回时把结论带回原讨论。这里有两个方向的信息流：出去的是待验证问题、约束和背景，回来的是实验结论。路由器只说明这条路径，不创建原型或交接文件。

例如讨论“长表单还是分步填写”已经无法继续推进时，继续增加访谈问题不会产生界面体验证据。原型分支补的正是这类输入，而不是提前开始正式实现。

### 2、再判断实现是否需要跨会话

同文件、同章节的第 3 步按 `is this a multi-session build?` 分支。长分支要求先用 `/to-spec` 把讨论整理为规格，再用 `/to-tickets` 拆分任务；短分支的源码为：

```markdown
   - **No** → **`/implement`** right here, in the same context window.
```

跨会话分支中的 **tracer-bullet ticket（贯穿端到端行为的工作项切片）** 要贯穿一个可验证行为所需的层次，并能在一次新会话内实现。每个工作项声明 **blocking edges（阻塞依赖）**：哪些其他工作项完成后，它才能开始。这里讨论的是工作项产物的依赖，不能与 skill 之间的文本委托混为一谈。

| 路径位置 | 消费什么 | 留下什么 | 下一步怎样接续 |
| --- | --- | --- | --- |
| 访谈 | 用户想法、项目事实 | 会话中的决策，已澄清术语和必要 ADR | 在同一会话继续整理 |
| 规格 | 当前讨论及代码理解 | 描述目标、实现与测试取舍的规格 | 用户进入任务拆分 |
| 任务拆分 | 规格、计划或已有讨论 | 自包含工作项及阻塞依赖 | 选择阻塞项已完成的工作项 |
| 逐项实现 | 一个工作项的完整要求 | 代码、测试与审查结果 | 完成后切换到下一工作项 |

ADR 是架构决策记录，用来保存值得长期保留的选择及原因。术语表和 ADR 不覆盖所有访谈答案，不能用这两个文件替代完整讨论；这也是规格形成前保留会话的原因。

### 3、测试和审查属于实现内部的委托

`skills/engineering/implement/SKILL.md` → 正文，以下为不连续摘录，中间省略了检查频率指令：

```markdown
Use /tdd where possible, at pre-agreed seams.
```

```markdown
Once done, use /code-review to review the work.

Commit your work to the current branch.
```

TDD（测试驱动开发）在预先约定的测试边界上，以失败测试和最小实现逐步推进；`/code-review` 在实现完成后检查编码规范与需求符合情况。两者在此版本都允许模型调用，因此 `/implement` 可以指示模型使用它们。

主路径应理解为“用户进入 `/implement`，模型在其中使用 `/tdd`，完成后使用 `/code-review`，再提交”，而不是“实现完毕，用户另起一轮 TDD，再另起一轮审查”。`where possible` 也应保留：具体实现入口没有保证所有工作一律测试先行。

这段交接仍有缺口：`skills/engineering/code-review/SKILL.md` → `Process / 1. Pin the fixed point` 使用 `git diff <fixed-point>...HEAD`，不涵盖未提交内容，而 `implement` 也没有传递审查固定点，不能据此假定提交前审查已经完整覆盖本次修改；详见 [05：实现与反馈](./05-tdd-diagnosing-bugs-implement.md) 和 [06：审查范围](./06-code-review-codebase-design-architecture.md)。

## 四、旁路按缺少什么材料来选

`On-ramps` 指那些从不同处境进入主流程的入口，不能被压成一条必经链。`skills/engineering/ask-matt/SKILL.md` → `On-ramps` 对误用 `/triage` 有明确限制：

```markdown
  Triage is only for issues **you didn't create** — bug reports, incoming feature requests, anything that arrives raw. Tickets that `/to-tickets` produced are already agent-ready, so **don't triage them**.
```

外部 bug 报告和新需求缺少整理，需要 `/triage` 补成可执行问题；`/to-tickets` 已经完成这项整理，再分诊一次只会重复工作。

| 当前缺口 | 推荐入口 | 接回主路径的条件 |
| --- | --- | --- |
| 外部报告缺少执行所需信息 | `/triage` | 整理成 agent 能接手的问题后进入 `/implement` |
| 故障原因未知，缺少稳定反馈 | `/diagnosing-bugs` | 先获得能复现该问题的失败命令，再定位和修复 |
| 工作太大，连设计问题之间的关系都不清楚 | `/wayfinder` | 用决策票据逐步弄清方向，再进入 `/to-spec` |
| 尚未选中要改进的架构位置 | `/improve-codebase-architecture` | 选中候选后，以新想法进入 `/grill-with-docs` |

`wayfinder` 分支还保留了小范围例外。相同源码章节中的原文句子：

```markdown
Looping the map straight into `/implement` skips that collapse and throws the linked detail away — go straight to `/implement` only when the effort turned out genuinely small.
```

大范围探索的决策分散在多张决策票据中，需要规格把它们合成可实现方案；如果探索后发现事情很小，允许直接实现。因此“必须经过规格”不是无条件规则。

`Vocabulary underneath` 单列 `/domain-modeling` 和 `/codebase-design`，分别处理项目领域语言和模块设计词汇；`Standalone` 收纳研究、原型、教学等可直接使用的能力。分组的作用是让用户知道“我缺一种能力”与“我进入交付下一阶段”是两类选择，而非要求每个请求遍历整个目录。

## 五、上下文切换怎样服从阶段边界

### 1、讨论材料先形成任务，再允许丢弃

`skills/engineering/ask-matt/SKILL.md` → `Context hygiene`：

```markdown
Keep steps 1–3 in **one unbroken context window** — don't compact or clear until after `/to-tickets` — so the grilling, spec, and tickets all build on the same thinking. Each `/implement` then starts fresh, working from the ticket.
```

这条规则对应材料的变化：访谈到任务拆分依赖同一段推理，工作项形成后才有可以独立消费的输入。多任务实现之间清空上下文，是建立在工作项自包含的前提上；如果关键约束只留在上一个会话，清空就会丢失依据。

同节也给了例外：当会话接近所谓 **smart zone（仍能有效推理的上下文范围）** 时，在最近的阶段边界压缩后继续。源码写了约 `150k tokens` 的经验值，但没有容量检测、自动切换或跨模型保证；实际应用应把它看作作者的会话管理启发，而非固定安全阈值。

### 2、五个选项有顺序，第一项匹配即选中

`skills/engineering/ask-matt/PHASE-BOUNDARIES.md` → `The tree`：

```markdown
Work top to bottom at the boundary. The first **yes** wins.
```

| 顺序 | 原文问题 | 选择后的信息变化 |
| --- | --- | --- |
| 1 | `Can you continue in this session?` | 继续使用完整会话；下阶段需要原始推理，或容量仍足够时优先考虑 |
| 2 | `Is the context irrelevant to what comes next?` | `/clear` 让后续工作从空上下文开始，要求当前信息可丢弃 |
| 3 | `Do you need to hand off?` | `/handoff` 把必要信息写成可带走的文件 |
| 4 | `Can the task be done AFK?` | subagent 在独立上下文执行明确任务并回报，父会话保留 |
| 5 | `Otherwise, /compact` | 以面向下一阶段的摘要替换完整上下文 |

AFK 指用户离开键盘、不必持续指导；subagent 指单独承担限定任务并返回结果的子 agent。`/handoff` 的适用条件则是更换 harness（承载 agent 的运行宿主）、更换目录或仓库、交给同事，或在阶段中途分出支线任务。它不承担所有相邻步骤之间的交接。

这张表描述的是交给模型和用户遵循的判断顺序。参考文件 `These are judgement calls` 明说这些问题依赖判断，同一边界也可能作出不同选择。尤其不能把所有切换都理解成“摘要”：`/clear` 丢弃当前窗口内容，subagent 保留父窗口，只有压缩与交接主要面对摘要损失。

## 六、手写地图的维护成本与使用边界

### 1、前置条件不会自动校验

`skills/engineering/ask-matt/SKILL.md` → `Precondition` 要求首次工程流程前使用 `/setup-matt-pocock-skills` 配置工作项跟踪系统（Issue tracker）、标签和文档布局。路由没有前置条件检测；配套说明 `Prerequisites` 明确指出，即使尚未配置，它仍可能推荐依赖这些条件的路径，也不负责安装所推荐的 skill。

同一说明的 `Common questions` 记录了另一个风险：模型可能把“当前可见的 skill 列表没有该入口”误判为“未安装”。人工入口的可见性与安装状态不能等同，路由文本更不能当成环境探测结果。这些是该基线配套文档记录的局限，不代表路由器已经提供恢复分支。

### 2、摘要能导航，关键行为仍以目标指令为准

路由文件用短说明覆盖整套流程，读起来集中，代价是与各 skill 正文形成两份需要同步的知识。配套说明 `Where it fits` 对冲突给出优先级：

```markdown
Where the router and a `SKILL.md` disagree, the `SKILL.md` is right.
```

例如路由摘要把 `/to-spec` 概括为“把讨论变成规格”，而 `skills/engineering/to-spec/SKILL.md` → `Process` 还要求提出测试边界并与用户核对。仅根据摘要决定跳过它，可能同时跳过这项确认。选路时应保留这些条件，依赖某个具体行为时则读目标 skill；不能让导航说明代替能力定义。

自编同类 skill 时，值得沿用的是这里的分支依据：是否有项目目录、能否通过讨论解决、是否跨会话、后续是否需要原始上下文。它们让用户能解释自己为什么走这条路。需要补强的是手写地图无法保证的部分，例如在重要推荐前核对目标能力和前置条件，并写清缺失时的处理方式。只有一两个明确入口的项目则可以直接使用目标 skill，未必需要增加一层导航。
