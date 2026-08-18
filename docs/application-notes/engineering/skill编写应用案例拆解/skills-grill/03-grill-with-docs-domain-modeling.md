---
sidebar_position: 4
title: "grill-with-docs 与 domain-modeling：把访谈结果留下来"
description: 从 mattpocock/skills 源码拆解 grilling、grill-with-docs 和 domain-modeling 的职责边界，以及 CONTEXT.md 与 ADR 如何承载澄清结果。
---

# grill-with-docs 与 domain-modeling：把访谈结果留下来

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先分清三个职责

这三个 Skill 都参与需求澄清，但处理的对象不同：

| Skill | 处理对象 | 主要动作 | 状态副作用 |
| --- | --- | --- | --- |
| `/grilling` | 访谈过程 | 建立 design tree，计算 frontier，分轮提问 | 当前会话中的临时状态 |
| `/grill-with-docs` | 项目内的澄清入口 | 调用访谈原语，并要求使用领域建模 | 更新项目文档 |
| `/domain-modeling` | 项目共享语言 | 校准术语、验证场景、记录不可逆决策 | 更新 `CONTEXT.md` 和必要 ADR |

它们组成的运行链是：

```text
用户进入 /grill-with-docs
        │
        ├── 调用 /grilling：控制提问顺序
        │
        └── 使用 /domain-modeling：维护术语和决策
                    │
                    ▼
          CONTEXT.md + 必要的 ADR
```

`/grill-me` 也调用 `/grilling`，但它面向没有项目工作目录的场景，不负责把结果写回仓库。入口 Skill 决定状态副作用，访谈原语决定提问过程，领域建模决定哪些知识值得长期保留。

## 源码分析

下面按调用链阅读源码。代码块均为 `mattpocock/skills` 的源码摘录，正文随后说明输入、输出和设计原因。

### 1. `grill-with-docs` 为什么只保留入口和组合关系

`skills/engineering/grill-with-docs/SKILL.md` 的正文很短：

```yaml
---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Run a `/grilling` session, using the `/domain-modeling` skill.
```

这份文件没有重复写 frontier、round 或 ADR 规则。它只做两件事：

1. 声明这是用户显式调用的入口；
2. 把访谈原语和领域建模组合起来。

**输入：**用户在一个项目工作目录中的计划、需求或设计问题。

**处理：**启动 `/grilling`，同时要求访谈过程使用 `/domain-modeling` 维护领域语言。

**输出：**澄清后的讨论结果，以及过程中产生的 `CONTEXT.md` 更新和必要 ADR。

**为什么这样写：**入口层不复制下游规则。访谈顺序由 `/grilling` 维护，术语和决策规则由 `/domain-modeling` 维护。入口只表达组合关系，因此两个底层 Skill 改变内部写法时，入口不用同步整段正文。

### 2. `grilling` 为什么不负责写项目文档

`grilling` 的职责是多轮访谈：用 design tree 表达决策依赖，计算当前 frontier，一轮提出当前可问的问题，等待用户回答后重新计算 frontier。

它只掌握当前访谈状态，不决定哪些信息应该写进项目文件。原因有两个：

- 无状态的 `/grill-me` 也需要相同的提问过程；
- 文档写入依赖项目目录、上下文布局和宿主权限，不属于通用访谈算法。

因此，`grilling` 的输出是“新的已确认决策和未决 frontier”，而不是某种固定文件。`grill-with-docs` 再把这些结果交给领域建模，决定是否更新项目状态。

这层拆分保留了访谈原语的可复用性。把 `CONTEXT.md` 和 ADR 写入逻辑直接放进 `grilling`，会让没有项目目录的入口也被迫承担文件副作用。

### 3. `domain-modeling` 维护的不是普通笔记

`skills/engineering/domain-modeling/SKILL.md` 首先定义它的工作性质：

```markdown
Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise.
```

它还明确排除了被动读取：

```markdown
Merely *reading* `CONTEXT.md` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.
```

`domain-modeling` 的输入不是一份普通会议记录，而是访谈中正在形成或改变的项目概念。它承担四类动作：

| 动作 | 处理方式 | 目的 |
| --- | --- | --- |
| 对照术语表 | 发现用户用词与 `CONTEXT.md` 冲突时立即指出 | 避免同一个词在项目中承担多个含义 |
| 收紧模糊词 | 为重载词提出更精确的规范术语 | 建立可共享的领域语言 |
| 压测场景 | 用边界案例验证概念之间的关系 | 暴露定义中的遗漏和冲突 |
| 对照代码 | 检查用户描述是否符合现有实现 | 发现语言、代码和行为之间的矛盾 |

**为什么这样写：**领域模型的价值在于统一项目语言和边界，不在于记录每句对话。只有会影响后续设计和协作的术语，才需要进入共享状态。

### 4. `CONTEXT.md` 为什么只放领域语言

项目快照根目录的 `CONTEXT.md` 将内容分为 `Language` 和 `Relationships`，例如：

```markdown
## Language

**Issue tracker**:
The tool that hosts a repo's issues — GitHub Issues, Linear, a local `.scratch/` markdown convention, or similar.
_Avoid_: backlog manager, backlog backend, issue host
```

`domain-modeling/CONTEXT-FORMAT.md` 规定每个术语采用“规范名称 + 一到两句定义 + `_Avoid_` 词汇”的形式，并要求：

- 定义应当明确且简短；
- 只记录当前项目特有的概念；
- 同义词过多时选出一个规范用词；
- 多上下文仓库使用 `CONTEXT-MAP.md` 指向各上下文的 `CONTEXT.md`。

`domain-modeling/SKILL.md` 还写明：

```markdown
`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.
```

**输入：**访谈中已经澄清的术语、关系和边界。

**输出：**供后续 Skill 阅读的共享词汇。

**为什么这样写：**如果 `CONTEXT.md` 同时保存实现方案、临时草稿和会议记录，后续模型无法判断哪些内容是稳定语言，哪些内容已经过时。把它限定为 glossary（术语表），可以让所有 Skill 用同一套词汇工作，同时把方案和实现交给规格、Issue 或代码文件承载。

### 5. ADR 为什么有严格的记录门槛

`domain-modeling/ADR-FORMAT.md` 将 ADR（Architecture Decision Record，架构决策记录）定义为很短的决策记录：

```markdown
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

它规定只有三个条件同时满足时才应创建 ADR：

```text
1. Hard to reverse
2. Surprising without context
3. The result of a real trade-off
```

也就是说，ADR 不记录每个选择。容易修改的决定、无需解释的常规做法、没有替代方案的显然选择，都不值得单独留下记录。

**输入：**访谈中已经确认的、具有长期影响的决策。

**处理：**用短文本记录背景、决定和原因；需要时才增加状态、备选方案或后果。

**输出：**位于 `docs/adr/` 的顺序编号文件，供后续设计和实现阶段查阅。

**为什么这样写：**ADR 的价值是保留“为什么选择这个方案”，而不是增加文档数量。严格门槛减少了决策噪声，也避免 `CONTEXT.md` 变成实现方案仓库。

### 6. 能力依赖为什么用 Skill 名称表达

`.agents/invocation.md` 规定 Skill 之间使用 `/skill` 风格的文字调用，不使用跨目录的内部文件路径：

```text
Dependencies are expressed as /skill-style prose invocation,
not deep ../other-skill/FILE.md cross-references.
```

`grill-with-docs` 使用的正是这种组合方式：它调用 `/grilling`，并要求使用 `/domain-modeling`。这里的依赖关系表达的是能力，而不是文件位置。

这样可以把三个维护问题分开：

- 访谈原语可以调整内部规则；
- 领域建模可以调整 `CONTEXT.md` 或 ADR 的格式；
- 入口只需要继续调用两个能力名称。

## 运行边界：一次项目内澄清如何完成

| 阶段 | 输入 | 负责者 | 状态变化 | 下游消费 |
| --- | --- | --- | --- | --- |
| 进入 | 项目目录中的模糊需求或设计问题 | 用户调用 `/grill-with-docs` | 选择有状态入口 | `/grilling` |
| 访谈 | 当前 design tree 和用户回答 | `/grilling` | 更新已确认节点和 frontier | `/domain-modeling` |
| 语言校准 | 模糊、重载或互相冲突的术语 | `/domain-modeling` | 更新 `CONTEXT.md` | 后续 Skill |
| 决策记录 | 难以逆转且存在权衡的选择 | `/domain-modeling` | 新增必要 ADR | 规格或实现阶段 |
| 交付 | 已澄清目标、术语和决策 | 入口或用户 | 结束访谈，保留文件位置 | `/to-spec` 或原型阶段 |

这里的关键是状态归属：访谈状态属于当前会话，术语属于 `CONTEXT.md`，长期决策属于 ADR。三种状态的生命周期不同，不能用一个文件承载全部内容。

## 为什么要拆成三层

### 复用同一套访谈过程

`grilling` 可以被 `/grill-me` 和 `/grill-with-docs` 复用。无项目目录时，访谈仍然可以正常进行；有项目目录时，入口再增加文档沉淀。

### 隔离文件副作用

是否写入文件取决于入口和工作目录，而不是提问算法。无状态入口不需要创建 `CONTEXT.md` 或 ADR，项目入口则可以明确声明这些副作用。

### 让共享语言保持稳定

`domain-modeling` 专门负责术语、场景和决策边界。它不负责所有需求访谈，也不把 `CONTEXT.md` 当作规格文件。后续 Skill 只需要读取稳定的术语表，就能减少同一个概念被反复解释。

### 代价是组合关系和状态边界需要写清楚

三层结构减少了职责重叠，但增加了几个维护要求：入口必须声明调用关系，访谈结果必须交给正确的状态层，`CONTEXT.md`、ADR 和规格文件不能互相替代。项目需要为这些文件约定位置和格式，否则拆分后的职责仍然会重新混在一起。

## 与 `grill-me` 的边界

`grill-me` 的 `SKILL.md` 只有入口声明和一行组合指令：

```yaml
---
name: grill-me
description: A relentless interview to sharpen a plan or design.
disable-model-invocation: true
---

Run a `/grilling` session.
```

它与 `grill-with-docs` 使用同一个访谈原语，差异在于状态环境：

- `grill-me`：没有项目工作目录，不写项目上下文；
- `grill-with-docs`：在项目目录中工作，额外调用 `/domain-modeling`，更新术语和必要决策记录。

不要把两者理解成两套不同的提问方法。它们是同一访谈能力的两个状态入口。

## 迁移边界

### 可以采用

- 把访谈过程、项目入口和领域语言拆成不同职责；
- 将稳定术语与实现细节分开保存；
- 只在术语真正改变时更新共享上下文；
- 对不可逆、意外且经过权衡的决定创建 ADR；
- 使用能力名称表达 Skill 依赖。

### 需要改造

- `CONTEXT.md`、`CONTEXT-MAP.md` 和 `docs/adr/` 的位置要适配目标项目；
- 如果项目没有 ADR 习惯，可以采用其他短格式决策记录，但必须保留“决定和原因”；
- 文档写入需要宿主允许修改工作目录；只读环境只能输出待写入内容；
- 多上下文仓库要先确定术语属于哪个上下文，不能把所有语言堆到根目录文件中。

### 不应照搬

- 不要让 `CONTEXT.md` 变成规格、任务草稿或实现细节仓库；
- 不要为每个普通选择创建 ADR；
- 不要把 `domain-modeling` 简化成被动读取术语表；它的职责是主动挑战、验证和更新模型；
- 不要把 `grill-with-docs` 的项目文档副作用塞回无状态的 `grilling` 原语。

## 编写澄清型 Skill 的检查清单

- [ ] 访谈算法是否独立于项目文件副作用？
- [ ] 入口是否明确说明有状态或无状态？
- [ ] 是否写清 `/grilling` 和 `/domain-modeling` 各自负责什么？
- [ ] `CONTEXT.md` 是否只保存稳定领域语言？
- [ ] 是否定义了术语冲突、模糊词和边界场景的处理方式？
- [ ] 是否只有满足三个条件的长期决策才进入 ADR？
- [ ] 多上下文项目是否有 `CONTEXT-MAP.md` 或等价索引？
- [ ] 下游 Skill 是否知道应该消费术语表、ADR 还是规格文件？
