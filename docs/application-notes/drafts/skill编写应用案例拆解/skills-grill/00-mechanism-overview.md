---
sidebar_position: 1.5
title: "机制总纲：这套 skill 的工程设计思想"
description: 提炼 mattpocock/skills 横切全部源码的设计机制——机制基座、调用分层、薄入口厚能力、产物接续、配置分离、写作方法论、上下文工程与工程化外围——并给出按机制阅读源码的顺序。
---

# 机制总纲：这套 skill 的工程设计思想

:::info 版本基线与源码入口

项目：[`mattpocock/skills`](https://github.com/mattpocock/skills)。`package.json` 版本：`1.2.3`；commit：`84fdeffd12f2ee307994d1eb6feb48173b6e0502`。

本篇是系列总纲：不逐个拆 skill，而是提炼横切全部源码的设计机制。后续各篇按 skill 组织细节，同一机制会分散出现在不同篇目；先在本篇建立框架，再读任何一份 `SKILL.md` 都能回答"这一行为什么这么写"。

| 项目相对路径 | 真实入口 | 阅读用途 |
| --- | --- | --- |
| `.agents/invocation.md` | `Model-invoked vs user-invoked`、`Dependencies between them` | 调用轴的权威定义（全文约 20 行） |
| `skills/productivity/writing-for-agents/SKILL.md` | `Context pointers`、`The two loads`、`Information hierarchy`、`Leading words`、`Steps and completion criteria`、`Pruning` | 写作方法论总纲 |
| `skills/productivity/writing-for-agents/SKILL-MECHANICS.md` | `Invocation`、`Router skills` | 写作方法论中 skill 特有的分支 |
| `skills/engineering/ask-matt/SKILL.md` | `The main flow: idea → ship`、`Context hygiene`、`Standalone` | 全局流程地图 |
| `skills/engineering/ask-matt/PHASE-BOUNDARIES.md` | `The tree`、`Primary and secondary sources` | 阶段边界的上下文切换决策树 |
| `CLAUDE.md` | 全文 | 仓库对自身的维护规则 |
| `.agents/adr/0001-explicit-setup-pointer-only-for-hard-dependencies.md` | 全文 | 配置的硬依赖/软依赖分档 |
| `.agents/adr/0002-ship-as-a-claude-code-plugin.md` | `The constraint`、`Decision` | 记录被否决的方案 |

以下摘录保留英文指令，中文解释紧随其后。宿主指运行 agent、加载指令并提供文件、终端等工具的环境；frontmatter 指 `SKILL.md` 头部的 YAML 元数据。

:::

## 一、机制基座：宿主只提供三种机制，其余全是文本约定

宿主对 skill 只提供三种机制：

1. 按 `name` 加载一份 `SKILL.md`；
2. 按 frontmatter 中的 `description` 自动触发；
3. 以 `disable-model-invocation: true` 禁止自动触发。

除此之外没有任何运行时支持：没有依赖解析器，没有调度器，没有 skill 之间的程序调用。这套仓库的全部"架构"都建立在这三种机制之上的**文本约定**——因此设计的可靠性不押在代码上，而押在指针措辞上（第六节的 context pointer 专门处理这件事）。

每个 skill 的物理形态固定为三件套：

| 组成 | 内容 | 加载方式 |
| --- | --- | --- |
| `SKILL.md` | frontmatter（名称、描述、触发配置）+ 正文指令 | 触发后全文加载 |
| 同目录参考文件 | 模板、格式、决策树等按需材料 | 正文指针引导读取 |
| `agents/openai.yaml` | Codex 宿主的镜像元数据 | Codex 界面与策略层读取 |

`agents/openai.yaml` 的全部内容只有两样东西。model-invoked 的 `grilling` 只有界面元数据：

```yaml
interface:
  display_name: "Grilling"
  short_description: "Stress-test thinking a round of questions at a time"
```

user-invoked 的 `grill-me` 多一个 policy 块：

```yaml
interface:
  display_name: "Grill Me"
  short_description: "Sharpen a plan through interview"
policy:
  allow_implicit_invocation: false
```

`policy.allow_implicit_invocation: false` 与 frontmatter 的 `disable-model-invocation: true` 成对出现。`.agents/invocation.md` 要求两边保持同步："a skill is user-invoked in both harnesses or neither"——一个 skill 要么在两个宿主都禁止自动触发，要么都不禁止，不允许出现单边状态。

## 二、调用轴：入口层与能力层，两种负载的经济学

仓库目录按 `engineering/`、`productivity/` 分桶，但那只是存放位置。真正的架构轴是 `.agents/invocation.md` 定义的两类调用；顶层 `README.md` 的 Reference 一节也按这一轴把每个桶分成两组：

- **user-invoked（用户显式入口）**：设置 `disable-model-invocation: true`，只有人敲命令才能触发。`description` 面向人，一句话摘要，删掉触发词列表。
- **model-invoked（模型可调用）**：默认状态，模型可以自主触发，人也能敲。`description` 面向模型，保留丰富的触发分支（"Use when the user wants…, mentions…, asks for…"）。

两类对应两层职责：**入口层**（user-invoked）负责编排，是流程的起点，由人决定何时进入；**能力层**（model-invoked）持有可复用的行为纪律，任何 skill 都能调用。

入口为什么不做成 model-invoked、省得人记？`writing-for-agents` 把这个权衡明确为**两种负载**：

```markdown
- **Context load** — the cost of always-loaded material on the agent's window: an `AGENTS.md` line, a skill description, anything sitting in context every turn, spending tokens and attention whether or not it fires.
- **Cognitive load** — the cost on the human: which documents exist and when to reach for each. The human is the index. Not a cost to minimise — it is the price of human agency; spend it where human judgement matters, remove it where it does not.
```

model-invoked 的 description 常驻上下文，每一轮都花 token 和注意力，无论是否触发——这是用 context load 换可发现性；user-invoked 不占上下文，但人必须记住它存在——花的是 cognitive load。作者对后者的态度值得注意：cognitive load 不是要压到最低的成本，而是"人类能动性的价格"，花在人判断有价值的地方，在没价值的地方移除。

调用方向有一条铁律：

```markdown
A user-invoked skill may invoke model-invoked skills, but it can never reach another user-invoked skill.
```

这不是君子协定，而是机制保证的：user-invoked 没有 description 就没有指针，模型物理上够不着它。入口层因此天然是树根——流程只能由人启动，启动后的每一步委托都落在能力层。目录分桶与调用权限无关：`productivity/grill-me` 是用户入口，同桶的 `grilling` 是模型可调用；桶决定的是发布面（第八节）。

## 三、薄入口、厚能力：复用单位是 skill 而不是代码

看三个入口 skill 的正文就懂了这个模式。`skills/productivity/grill-me/SKILL.md` 的正文全部内容：

```markdown
Run a `/grilling` session.
```

`skills/engineering/grill-with-docs/SKILL.md` 的正文全部内容：

```markdown
Run a `/grilling` session, using the `/domain-modeling` skill.
```

`skills/engineering/implement/SKILL.md` 的正文只有五句话：按 spec 或工作项实现、在预定 seam 上尽量用 `/tdd`、定期跑类型检查和单个测试文件、收尾跑一次全量测试并用 `/code-review` 审查、提交到当前分支。seam 指事先约定的模块交界或测试入口。

入口刻意薄到只剩"编排"，行为全部下沉到能力层。这个模式最典型的产物是 `grilling` 这个访谈原语：它以 design tree（设计决策树）组织问题——每个决策分支挂着依赖它的子决策；以 **frontier**（前提已就绪的待决问题集合）控制轮次——一轮问完整个 frontier，每题编号并附推荐答案，等用户回答后再重算 frontier。事实与决策的分工写在正文里：

```markdown
Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.
```

结束条件也可检查：frontier 为空，且用户确认达成共同理解。这一个原语被五个入口复用：`grill-me`、`grill-with-docs`、`triage`、`wayfinder`、`improve-codebase-architecture` 都在内部运行它。依赖的表达方式有配套约定：

```markdown
Dependencies are expressed as **`/skill`-style prose invocation** ("Run the `/grilling` skill"), not deep `../other-skill/FILE.md` cross-references. Shared reference docs live inside the skill that owns them; other skills reach that material by invoking the skill, not by linking across folders.
```

依赖写成 `/grilling` 这样的名字调用，不写跨目录文件链接；共享参考材料放在拥有它的 skill 内部，别的 skill 通过调用它来获取。复用的是"调用能力"，不是"引用文件"，每个 skill 因此保持可移植。代价是这套依赖没有解析器保证：目标 skill 未安装时，正文里那行调用不会报错，只会落空——第一篇详细展开了这一点。

## 四、产物接续：状态放在文件里，而不是调用链里

主流程 `grill-with-docs → to-spec → to-tickets → implement（内部驱动 tdd 和 code-review）` 之间没有任何运行时连接。串联它们的是文件产物——每个上游 skill 的输出物就是下游 skill 的输入：

| 产物 | 生产者 | 消费者 | 单一职责约束 |
| --- | --- | --- | --- |
| `CONTEXT.md` | `domain-modeling`（经 grill-with-docs 驱动） | 所有下游 skill | 只是术语表，不含实现细节，不是 spec |
| ADR | `domain-modeling` | `tdd`、`to-spec` 等 | 三门槛全满足才写：难逆转、无上下文会困惑、真实权衡 |
| 规格 Issue | `to-spec` | `to-tickets`、`implement`、`code-review` 的 Spec 审查轴 | 明确声明"不访谈，只综合已有讨论" |
| 纵向工作项 | `to-tickets` | `implement` | tracer bullet 切片，声明 blocking edges，尺寸以单个全新会话装得下为限 |
| prototype 分支 | `prototype` | 实现该功能的 Issue | 一次性代码回答一个设计问题，保留作 primary source |

这解决了三件事：**跨会话状态**——产物落在仓库里，不依赖对话记忆，`implement` 从全新会话开始也能工作；**跨宿主移动**——文件谁都能读，`handoff` 交接的也是文件；**组合性**——`to-questionnaire` 和 `research` 的返回物之所以能直接进入主流程，因为大家交换的都是文件。

每个产物都配格式模板（`CONTEXT-FORMAT.md`、`ADR-FORMAT.md`、`spec-template`、`local-ticket-template`），模板就是接口。两个值得注意的细节：

其一，单一职责是硬约束。`domain-modeling` 明确写：

```markdown
`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.
```

其二，规格和工作项模板都禁止写文件路径和代码片段（"They may end up being outdated very quickly"），唯一例外是 prototype 产出的、比散文更精确的决策性片段（状态机、schema、类型形状），且要裁剪到只剩决策部分。这是"文档要不要包含代码"的一个可借鉴判据：会过时的引用不写；编码了决策本身的片段例外。

规则也不是教条。`to-tickets` 对大范围机械重构（改列名、改共享符号类型）显式豁免了纵向切片，改为 expand–contract 序列：先加新形态、分批迁移调用点、最后删旧形态，每批一个工作项、全程保持 CI 绿——因为单个纵向切片在这种场景必然全仓飘红，而"每张工作项独立可验证"才是要守的目标。

## 五、配置分离：一个生产者，多个消费者

`setup-matt-pocock-skills` 每个仓库跑一次，把环境差异（Issue tracker 选型、triage 标签映射、领域文档布局）写成 `docs/agents/*.md` 文件，并在 `CLAUDE.md` 或 `AGENTS.md` 里加一个指向它们的 `## Agent skills` 区块。之后所有 skill 读文件，不再问用户。

对配置缺失的处理分两档，决策记录在 ADR 0001：

- **硬依赖**（`to-tickets`、`to-spec`、`triage`）——没有配置输出就是错的（发布位置错、标签字符串错），正文放一句指路："The issue tracker and triage label vocabulary should have been provided to you — run `/setup-matt-pocock-skills` if not."
- **软依赖**（`tdd`、`diagnosing-bugs`、`improve-codebase-architecture`）——只用模糊散文提"项目的领域词汇表"，缺失时降级运行，输出只是不够锐利。

分档的理由就是准则本身：

```markdown
The split keeps soft-dependency skills token-light and avoids cargo-culting the setup pointer into places where it isn't load-bearing.
```

让软依赖 skill 保持轻量，避免把 setup 指引盲目复制到不承担负载的地方。配套的降级行为写在 setup 生成的 `domain.md` 里：文件不存在就静默继续，术语或决策真正落定时由 `domain-modeling` 惰性创建。这也是一个通用模式：**运行时要问用户的问题，能变成一次性配置文件的都变成配置文件**——配置文件随后天然成为产物接续（第四节）的一员。

## 六、写作技术：writing-for-agents 是全仓库的总纲

`writing-for-agents` 是教"怎么写 agent 读的文档"的 skill；全仓库每份 `SKILL.md`、`CLAUDE.md`、docs 页都是它的实践。它是 model-invoked，本身又是被这套方法论写出来的——自举闭环。核心概念五个。

### 1、context pointer（上下文指针）

常驻上下文里的一行，命名一份够不着的材料并编码触发条件——skill 的 description 是一种，`AGENTS.md` 里指向某个文档的一行也是。关键论断：

```markdown
The pointer's _wording_, not its target, decides when the agent reaches the material — and how reliably.
```

决定 agent 何时、多可靠地够到材料的，是指针的措辞，不是目标本身。一份必须的材料配了个弱指针，被定性为 variance bug——修复顺序是先磨措辞，实在不行才把材料内联。

### 2、信息层级与渐进披露

文档内容分两类——steps（有序动作）和 reference（按需查阅的规则与事实），每块内容落在三级层级上：in-file step（正文步骤）、in-file reference（正文参考）、disclosed reference（推到独立文件、指针后面）。下推的判断准则一句话讲完：

```markdown
inline what every branch needs, and push behind a pointer what only some branches reach
```

这就是为什么 `ask-matt` 正文只有一段阶段边界摘要，五选项决策树在 `PHASE-BOUNDARIES.md` 里；`tdd` 正文只有反模式清单，例子在 `tests.md`、`mocking.md` 里。渐进披露在这套方法论里"not primarily a token optimisation: it is how the hierarchy is protected"——主要不是省 token，而是保护层级结构：正文里该被每次执行的步骤被参考材料淹没时，agent 对步骤的注意变成抛硬币。

### 3、leading words（引领词）

用模型预训练里已有的词锚定行为：`tight` loop、`deep module`、`seam`、`tracer bullet`、`fog of war`、`red`/`green`。一个 token 召回一整套先验：

```markdown
"fast, deterministic, low-overhead" → _tight_ (a _tight_ loop).

"a loop you believe in" → _red_ — a fuzzy gate becomes a binary observable state (the loop goes _red_ on the bug, or it doesn't).
```

自造词的问题在于"recruits no priors"——要用定义 token 买预训练词白给的东西，所以先选现成的词。这是这套 skill 文本风格"每个词都带电"的原因：先选词，再写句子。

### 4、完成条件（completion criteria）

每个步骤以可检查、有要求的条件收尾，两个属性各防一种失效：**clarity**（能不能分辨做完没做完）防 premature completion——后面的步骤还多时，agent 会赶眼前的；**demand**（要求多少挖掘）驱动 legwork——"every modified model accounted for" 能逼出彻底工作，"produce a change list" 不能。"The strongest criteria are both checkable and exhaustive."（最强的完成条件既可检查又穷尽。）

实例遍布全仓库：`grilling` 的 frontier 为空；`wizard` 的 "Done when: every stage is named in order, and for each captured value you know (a) where the human gets it, (b) where it's written… (c) whether it's secret"。

### 5、正向表述与修剪

禁令会把被禁止的行为拖进上下文（"_Don't think of an elephant_, and the elephant is all there is"），能写成正向目标就绝不写禁令。修剪三条：一个含义单一事实来源；环境本身（`package.json`、目录结构）也是事实来源，文档复述它就是会过时的缓存；逐句做 no-op 测试——"does it change behaviour versus the default?"——没改变默认行为的整句删除，不逐词修剪。

自举的证据：仓库自己的 `CONTEXT.md` 就是按 `domain-modeling` 规范写的自我术语表（定义了 Issue tracker、Issue、Decision ticket、Triage role）；`CLAUDE.md` 规定新增、改名或删除 skill 必须回读更新 `ask-matt`，否则是 "a router that lies"（说谎的路由器）；docs 页有独立模板 `.agents/writing-docs.md`。

## 七、上下文工程：窗口边界就是架构边界

这套系统把上下文窗口当成显式的工程对象，集中在 `ask-matt` 与 `PHASE-BOUNDARIES.md`：

- **量化约束**：smart zone——模型仍能清醒推理的窗口范围（当前约 150k token），接近时应当处理，而不是"degraded 继续"。
- **流程约束**：主路径要求 grilling → to-spec → to-tickets 在同一个不间断的上下文窗口完成（三者建立在同一思考上，实现阶段才需要原文复述而非摘要），而每个 `/implement` 从全新窗口开始（工作项自包含，上下文可弃）。
- **切换决策树**：阶段（phase）之间的边界有五个选项——Continue、`/clear`、`/handoff`、subagent、`/compact`——按代价排序逐个排除。Continue 最先排除掉，因为 primary source（原样保留的会话）换成 secondary source（摘要）是单向损失；`/compact` 排最后：

```markdown
`/compact` is the **default, not the first reach**.
```

窗口管理因此不是使用习惯而是设计的一部分：工作项尺寸以"单个全新会话装得下"为限（第四节）、`code-review` 用并行 subagent 隔离两条审查轴的上下文、`research` 整个作为后台 agent 运行——都是同一原则的应用：**给每段工作分配合适大小的窗口，窗口之间用文件交接**。

## 八、工程化外围：确定性下沉脚本，发布面显式钉死

两个收尾模式。

**确定性操作交给脚本，模型只做 scope 和 authoring。** `wizard` 生成引导人类执行手工步骤的 bash 向导；交互体验（进度、确认门、隐藏输入、幂等写 `.env`、跨平台开 URL）全部固化在 `template.sh` 的库部分：

```markdown
The library above the `STAGES` marker is identical in every wizard; that consistency is the point — never hand-edit it.
```

agent 的工作只剩两步：和用户确认阶段清单（完成条件可检查）、往模板填 stages。验证也是静态的——`bash -n`、shellcheck、人工核对每个 CI `secrets.*` 引用都有对应的 `set_secret`——"Don't run it end-to-end yourself"，因为真跑会开浏览器、阻塞等人。边界同样明确："If the agent could just do it itself, it should"——agent 自己能做的不需要 wizard。

**发布面用显式清单钉死。** `engineering/` 和 `productivity/` 是 promoted（发布）桶，`misc/`、`in-progress/`、`deprecated/` 故意不发布；`.claude-plugin/plugin.json` 用显式路径数组逐个列出 promoted skill，而不是依赖目录约定。版本用 changesets 管理，`sync-plugin-version.mjs` 保证 plugin 版本跟随 `package.json`。ADR 0002 则完整记录了一个被否决的方案：Codex 原生插件为何 deferred——其 manifest 只接受单个 skills 路径，指到 `./skills/` 会带上全部非发布桶，symlink 又活不过安装拷贝。把权衡过程本身当作仓库资产保留，这是对"ADR 记什么"的示范：不只是记结论，更记被否决的路和否决的原因。

## 九、按机制选择正文

| 机制（本篇章节） | 深入正文 |
| --- | --- |
| 调用轴、路由与委托 | [01 · ask-matt](./01-ask-matt-router.md) |
| 访谈原语 grilling | [02 · grilling](./02-grilling-interview.md) |
| 产物落盘：CONTEXT.md 与 ADR | [03 · grill-with-docs 与 domain-modeling](./03-grill-with-docs-domain-modeling.md) |
| 产物接续：规格与工作项 | [04 · to-spec 与 to-tickets](./04-to-spec-to-tickets.md) |
| 薄入口 implement 与测试纪律 | [05 · tdd、diagnosing-bugs 与 implement](./05-tdd-diagnosing-bugs-implement.md) |
| 共享词汇与双轴审查 | [06 · code-review、codebase-design 与架构改进](./06-code-review-codebase-design-architecture.md) |
| 状态机与决策地图 | [07 · triage 与 wayfinder](./07-triage-wayfinder.md) |
| 证据回流主流程 | [08 · prototype、research 与 to-questionnaire](./08-prototype-research-questionnaire.md) |
| 上下文移动与渐进披露 | [09 · handoff、teach、writing-for-agents 与 wait-what](./09-handoff-teach-writing-wait-what.md) |
| 发布面工程 | [10 · 发布、安装与版本同步](./10-release-install-versioning.md) |
| 写作方法论实操 | [11 · 怎样编写个人 skill](./11-writing-personal-skills.md) |
| 可直接使用的源码走读 skill | [source-walkthrough](./source-walkthrough/SKILL.md) |

直接读源码时的建议顺序，比按目录顺序读更有效：

1. `.agents/invocation.md`——约 20 行，两层架构的权威定义；
2. `skills/productivity/writing-for-agents/SKILL.md` + `SKILL-MECHANICS.md`——写作总纲，先学理论再看实例；
3. `README.md` 的 Reference 一节 + `skills/engineering/ask-matt/SKILL.md`——全局地图；
4. `grill-me` → `grilling` → `grill-with-docs` → `domain-modeling`——一行的入口、访谈原语、组合、产物落盘，四个文件讲完第三、四节的全部模式；
5. `to-spec` → `to-tickets` → `implement` → `tdd` → `code-review`——流水线与产物交接；
6. `wizard/SKILL.md` + `template.sh`、`setup-matt-pocock-skills/SKILL.md`——脚本模式与配置生产者；
7. `CLAUDE.md` + 两个 ADR——仓库的自我维护规则与被否决方案。
