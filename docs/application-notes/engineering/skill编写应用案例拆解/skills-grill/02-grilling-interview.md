---
sidebar_position: 3
title: "grilling：用 frontier 和 design tree 组织多轮需求访谈"
description: 从 grilling 的指令解释设计树、frontier 和轮次如何控制提问顺序，以及并行调查、用户决策与访谈结束的边界。
---

# grilling：用 frontier 和 design tree 组织多轮需求访谈

:::info 版本基线与源码入口

项目：[`mattpocock/skills`](https://github.com/mattpocock/skills)。`package.json` 版本：`1.2.3`；commit：`84fdeffd12f2ee307994d1eb6feb48173b6e0502`。

| 项目相对路径 | 真实入口 | 阅读用途 |
| --- | --- | --- |
| `skills/productivity/grilling/SKILL.md` | 无章节标题；正文依次以 `Interview the user`、`Work the tree`、`Each round`、`Finding _facts_`、`The session is done` 开头 | 设计树、轮次、事实调查和完成条件 |
| `skills/productivity/grill-me/SKILL.md` | frontmatter、正文 `Run a` 一句，无章节标题 | 仅访谈的人工入口 |
| `skills/engineering/grill-with-docs/SKILL.md` | frontmatter、正文 `Run a` 一句，无章节标题 | 组合访谈与领域建模 |
| `.agents/invocation.md` | `Model-invoked vs user-invoked` | 入口与可复用能力的调用关系 |
| `docs/productivity/grilling.md` | `The round, the frontier, and who decides`、`Common questions` | 依赖判断、加载失败等边界 |
| `docs/productivity/grill-me.md` | `Grillable and ungrillable` | 讨论无法解决的问题怎样处理 |

本文保留英文指令，并用中文解释行为。正文中的状态名称是对访谈过程的分析，不是仓库里已经实现的数据结构或状态机。

:::

## 一、输入是待澄清的问题，输出是用户确认的理解

`grilling` 把一个计划、决策或想法拆成有依赖关系的决策，分轮询问用户。每轮只问前置条件已经明确的问题，为每个问题给出推荐答案，然后等待用户回答。环境能查明的事实由 agent 调查，真正的选择留给用户。

它是一份可复用的**访谈原语**：所谓原语，是其他 skill 可以共同使用的一组基础过程指令。源码没有问题队列类、树节点类型、问卷数据库或调度函数。设计树和轮次由模型依据对话维护，实际暂停、工具调用和子 agent 执行则依赖宿主能力。

`skills/productivity/grilling/SKILL.md` → frontmatter：

```yaml
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
```

这里没有禁止模型调用的字段，描述也写明了触发场景。按照 `.agents/invocation.md` 的分类，它可以由用户直接使用，也可以被其他 skill 要求使用。`grill-me` 和 `grill-with-docs` 则是人工入口：前者只要求运行访谈，后者同时引入领域建模。

“无状态访谈”只表示不负责保存项目文件。它仍依赖当前会话记住已确认答案、尚未解决的分支和调查中的事实；输出也不是固定格式的规格或工作项，而是经用户确认的共同理解。把它接到其他工作流时，需要另外规定这些信息如何交给下一阶段。

## 二、设计树、frontier 与 round 怎样配合

### 1、设计树表达决策依赖

`skills/productivity/grilling/SKILL.md` → 正文 `Interview the user`：

```markdown
Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.
```

**design tree（设计树）** 用决策之间的前置关系组织讨论。它没有要求模型输出一张图，也没有规定只能使用严格的单父节点树；重点是知道“这个问题的答案会改变哪些后续问题”。这些依赖由模型判断，没有程序校验图结构。

例如分析“订单能否取消”时，需要区分现有系统支持什么，以及这次希望支持什么。如果“是否支持部分取消”尚未决定，就不宜直接追问“部分取消时运费退多少”：用户可能根本不选择部分取消。设计树让这个后续问题保持未就绪，避免把待定方向写进问题前提。

### 2、frontier 只包含当前可以回答的决策

同文件 → `Work the tree` 段，截取定义句：

```markdown
The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet.
```

**frontier（当前可问的决策集合）** 随着新事实和用户回答变化。一个问题需要的事实未查清，或需要的用户决策尚未确认，就不能进入当前集合。后续源码还限制同轮内的依赖：

同文件 → `Each round` 段，截取末句：

```markdown
A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.
```

因此，同轮不是“同一主题的一批问题”，而是一批彼此不依赖尚未收到答案的问题。关于取消粒度和取消后的退款规则虽然都属于取消功能，却可能必须分轮；通知文案语气若不依赖取消粒度，则可以同时讨论。

这里的“计算 frontier”指模型依据上下文重新判断依赖。配套说明 `docs/productivity/grilling.md` → `The round, the frontier, and who decides` 直说它不是程序计算出的图；模型仍可能误把有依赖的问题放进同一轮，用户指出后需要重新打开受影响的分支。

### 3、一轮的边界是提出问题后等待回答

`skills/productivity/grilling/SKILL.md` → `Work the tree` 段，截取轮次要求：

```markdown
Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.
```

**round（轮次）** 包含当前 frontier 的全部问题及随后的用户回答。源码没有固定题数或轮数上限，也没有规定必须逐题发送。批量提出彼此独立的问题可以减少来回等待，代价是 frontier 很宽时，用户一次要处理很多选择。

紧随其后的 `Each question should be formatted like so` 给出真实输出模板：

```text
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

编号让用户能按题回答；标题帮助定位决策；正文提供必要背景；单独一行的推荐答案表达模型判断。源码没有要求每题必须选择题，也没有要求用户必须接受推荐。推荐仍是待确认建议，不能直接写入“已决定”的状态。

## 三、事实调查怎样与用户访谈交错推进

### 1、调查交给 subagent，等待只影响相关分支

`skills/productivity/grilling/SKILL.md` → `Finding _facts_` 段，摘录调查指令：

```markdown
When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now.
```

subagent 是被委派调查任务、完成后向主 agent 回报的子 agent。这里不仅规定“自己查资料”，还规定了调查期间的行为：把调查视为尚未满足的前置条件，保留其下游问题，同时继续询问其他已经就绪的问题。

例如取消流程是否已经产生独立退款记录，是代码能回答的事实；这次是否允许部分取消，是用户决定的产品范围。调查前者时，模型不应停掉所有访谈，也不应把猜测中的实现当作后者的依据。报告返回后，它成为重新判断问题的输入，并不替用户作出选择。

同段末句明确了决定权：

```markdown
The _decisions_ are the user's — put each to them and wait.
```

用户已经表达过的取舍可以作为已知上下文；未明确的取舍则要提出并等待。这里需要区分两种证据：代码证明当前行为，用户回答确定目标行为。代码与目标不一致时，差异本身就是下一步应澄清的内容。

### 2、用连续场景看状态怎样变化

下面是对源码规则的说明性例子，不是仓库自带案例或执行日志。假设用户想修改订单取消流程，模型发现四项待处理内容：现有退款实现、是否支持部分取消、取消通知的语气、部分取消的运费规则。

| 时点 | 已知输入 | 仍未就绪的内容 | 当前可以做什么 |
| --- | --- | --- | --- |
| 调查启动 | 用户要调整取消流程；现有退款路径待查 | 依赖现有实现作成本判断的取消粒度问题；依赖粒度的运费问题 | 派子 agent 查退款路径，同时询问独立的通知语气 |
| 用户回答通知问题 | 已确认通知使用中性语气 | 退款调查仍未返回，粒度与运费仍等待 | 保留已确认答案；不能因当前没有别的问题就宣布结束 |
| 调查报告返回 | 当前只支持整单退款 | 目标取消粒度仍未决定 | 解释现状和改造影响，询问本次是否增加部分取消 |
| 用户选择部分取消 | 粒度已确认 | 运费处理尚未决定 | 运费问题进入下一轮，并给出有依据的建议 |
| 用户反向改选整单取消 | 上游决策变化 | 旧的部分取消运费分支已不再适用 | 重整设计树，不继续沿已失效前提追问 |

推动下一轮的不只是“收到了几条答案”，而是某个前置条件是否已经明确。原文 `Each round` 段的动作是：

```markdown
Recompute the frontier and ask the next round.
```

这要求每轮之后重新判断，不能在访谈开始时预写好三轮问题，再按顺序照读。用户回答可能使某个分支就绪，也可能让整条分支失去意义。

### 3、部分回答和调查失败没有现成恢复程序

如果用户只回答一半，本轮剩余决策仍然未确认；其下游问题不能靠模型推荐自动补齐。如果用户说“不知道”，这个答案揭示了信息缺口，并不使选择本身成立。这是“前置条件已明确才可询问”的直接推论，源码没有单独实现漏答检测或重试计数。

调查失败、工具不可用、报告互相矛盾时也一样：`SKILL.md` 没有超时、重试或同步调查的降级条款。按该机制使用时，应保留未知状态、说明缺少的事实，并继续不依赖它的部分；自编变体则可以明确补上调查失败后如何重试、请求必要资料或收窄范围。这些恢复策略需要另行设计，不能宣称已经由原 skill 保证。

## 四、没有问题可问之后，还剩一道确认边界

`skills/productivity/grilling/SKILL.md` → 最后一段 `The session is done`：

```markdown
The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
```

这两句共同限定结束：设计树的各分支已经走过，没有隐含假设；在依讨论采取行动前，用户还要确认双方理解一致。只读第一句中的 `frontier is empty` 会产生误判：如果所有未决问题都在等待调查，当前可问集合也可能暂时为空，但分支并未解决，不能收尾。

因此需要区分三个时刻：

| 时刻 | 代表什么 | 尚不代表什么 |
| --- | --- | --- |
| 当前无就绪问题 | 可能在等事实、回答或外部输入 | 所有分支已经澄清 |
| 各分支已澄清 | 模型认为没有未处理的假设 | 用户已经同意其理解 |
| 用户确认理解一致 | 访谈产物可以交给已约定的后续工作 | 无条件获得任意改代码、发布或提交的授权 |

源码没有实现对这一条件的程序检查；它仍要求模型遵循。配套说明记录了模型过早开始实现的偏差，因此自编访谈型 skill 时，“直到共同理解”这样的目标最好同时配上可辨认的完成条件和停止动作，而不是只写“深入提问”。如果某些问题被用户明确排除范围，也应保留这个范围决定，不能把未回答悄悄改成已解决。

有些问题靠讨论无法解决。`docs/productivity/grill-me.md` → `Grillable and ungrillable` 建议遇到交互体验、界面观感等问题时先做原型，再带着观察结果回来。`skills/productivity/grilling/SKILL.md` 没有自动启动 `/prototype` 的指令；这是工作流选择，不能写成访谈循环自带的工具调用。

## 五、同一个访谈过程如何被不同入口使用

### 1、入口决定增加哪些职责

`skills/productivity/grill-me/SKILL.md` → 全部正文：

```markdown
Run a `/grilling` session.
```

`skills/engineering/grill-with-docs/SKILL.md` → 全部正文：

```markdown
Run a `/grilling` session, using the `/domain-modeling` skill.
```

两份入口都设置 `disable-model-invocation: true`，而 `grilling` 与 `domain-modeling` 允许模型使用。这种组合符合仓库的调用约定：用户选择入口，入口要求模型使用基础能力。

`grill-me` 的配套说明将其定义为不写文件的访谈，适合没有项目文档需求的讨论；`grill-with-docs` 在访谈中加入领域建模，即校准业务术语、更新 `CONTEXT.md` 术语表并提议记录必要的 ADR（架构决策记录）。它不是先完成全部访谈，再启动一次文档总结；写入规则会在术语或决策明确时介入。

这让“每轮怎么提问”只有一个定义，保存什么则由组合的能力决定。代价是入口正文很短，依赖加载一旦遗漏，模型可能仅凭“grill”这个名字临时编出访谈。`docs/productivity/grilling.md` → `Common questions` 记录了这一情况：文本提到另一个 skill，并不能可靠保证它已被加载。

### 2、复用的是约束，仍要适配人的阅读节奏

这套方法适合决策之间存在依赖、用户愿意参与且事实可以调查的设计讨论。对于目标和实现都已经明确的小任务，完整访谈可能增加无必要的往返；对于不能与用户交互的后台任务，它也不能用模型自己的答案冒充用户选择。

“询问整个 frontier”减少等待，却没有控制单轮认知负担。配套说明允许用户通过自己的指令改为一次一题；如果自编变体选择限量提问，应保留“前置条件明确后才提问”的规则，并把单轮规模写成显式策略。另一个容易忽略的细节是推荐方向：问题问“是否启用”，推荐却写“不要启用”时，用户一句“同意”可能歧义。把用户确认还原为明确选择，才能让下一轮建立在正确前提上。

使用时最有价值的反馈是指出依赖和范围：“这个答案取决于上一题”“这个事实可以从代码查”“这条分支暂不考虑”。它们直接修正模型维护的设计树。自编 skill 时也应围绕这些会改变行为的约束组织正文，再根据需要增加持久化、失败恢复或交接格式；复制一份长问题清单无法替代它们。
