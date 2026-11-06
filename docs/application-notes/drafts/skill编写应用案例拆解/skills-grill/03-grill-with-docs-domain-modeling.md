---
sidebar_position: 4
title: "grill-with-docs 与 domain-modeling：把访谈结果留下来"
description: 从 mattpocock/skills 源码拆解 grilling、grill-with-docs 和 domain-modeling 的职责边界，以及 CONTEXT.md 与 ADR 如何承载澄清结果。
---

# grill-with-docs 与 domain-modeling：把访谈结果留下来

:::info 版本基线与源码入口

项目：[`mattpocock/skills`](https://github.com/mattpocock/skills)。`package.json` 版本：`1.2.3`；commit：`84fdeffd12f2ee307994d1eb6feb48173b6e0502`。

| 项目相对路径 | 真实入口 | 阅读用途 |
| --- | --- | --- |
| `skills/engineering/grill-with-docs/SKILL.md` | frontmatter、正文 `Run a` 一句，无章节标题 | 人工入口与能力组合 |
| `skills/productivity/grilling/SKILL.md` | 正文 `Work the tree`、`Finding _facts_`、`The session is done`，无章节标题 | 提问顺序、事实调查和行动前确认 |
| `skills/engineering/domain-modeling/SKILL.md` | `File structure`、`During the session` 下的六个小节 | 选定上下文、澄清语言、即时写入 |
| `skills/engineering/domain-modeling/CONTEXT-FORMAT.md` | `Structure`、`Rules`、`Single vs multi-context repos` | 术语格式、文件定位 |
| `skills/engineering/domain-modeling/ADR-FORMAT.md` | `Template`、`Optional sections`、`Numbering`、`When to offer an ADR` | 决策记录的门槛和格式 |
| `docs/engineering/grill-with-docs.md`、`docs/engineering/domain-modeling.md` | `The paper trail`、`Common questions`；`Cross-referencing, and where it stops` | 状态覆盖范围和配套说明中的局限 |

以下保留英文指令，正文用中文解释。它们是模型应遵循的约定；入口文件没有实现函数调用、文件事务或强制状态迁移。

:::

## 一、一行入口怎样组合访谈与文档职责

`grill-with-docs` 把同一次讨论交给两组规则约束：`grilling` 决定现在能问什么、何时等待用户；`domain-modeling` 决定哪些用词需要澄清、哪些内容应该写入项目。二者在访谈中交错使用，不存在先完成访谈、再批量整理文档的固定流水线。

`skills/engineering/grill-with-docs/SKILL.md` → frontmatter 与唯一正文句；以下分别摘录：

```yaml
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
```

```markdown
Run a `/grilling` session, using the `/domain-modeling` skill.
```

按仓库 `.agents/invocation.md` 的约定，`grill-with-docs` 是用户显式选择的入口；`grilling` 与 `domain-modeling` 允许模型调用，所以可以被这句正文要求使用。它没有重复写入两套底层规则，改进访谈顺序或术语格式时，只需修改各自的定义。

输入包括用户要澄清的计划、当前会话，以及可供核对的项目代码和领域文档。输出分成三种，不能笼统称为“保存访谈结果”：

| 讨论中形成的内容 | 所在位置 | 写入条件 |
| --- | --- | --- |
| 本项目一个概念的规范名称与定义 | `CONTEXT.md` 术语表 | 含义已经澄清，就地更新 |
| 值得长期保留的架构选择及原因 | ADR 文件 | 同时通过三项门槛后提议创建 |
| 一般需求、临时选择、数值约束和未决问题 | 当前会话 | 此入口没有为它们规定持久化文件 |

ADR 是 Architecture Decision Record，即架构决策记录。所谓**领域模型**，在这里指项目概念、含义和边界形成的共同理解，例如 Customer 究竟指购买方还是登录用户；它不是自动生成的数据模型或类图。

对照 `skills/productivity/grill-me/SKILL.md`，其正文只要求运行 `/grilling` 访谈。配套说明把它定义为不保存项目文件的入口。两者的访谈过程相同，差别来自 `grill-with-docs` 增加了 `domain-modeling` 的主动维护规则，而非换了另一套问法。

## 二、文档写到哪里，取决于已有领域边界

### 1、先定位上下文，再按需创建文件

`skills/engineering/domain-modeling/SKILL.md` → `File structure`：

```markdown
Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.
```

**按需创建**把文件生成绑定到真实内容：第一个术语明确后才创建术语表，第一个需要记录的架构决定出现后才创建 ADR 目录。开始访谈不等于创建一套空文档；没有新术语、没有合格的 ADR 时，可以没有文件变化。

默认布局是根目录 `CONTEXT.md` 和 `docs/adr/`。多个业务领域共存时，**context（领域上下文）** 表示一组拥有一致概念含义的范围，例如 Ordering（订购）和 Billing（计费）可以分别维护自己的语言。`CONTEXT-MAP.md` 是这些范围及其关系的索引。

`skills/engineering/domain-modeling/CONTEXT-FORMAT.md` → `Single vs multi-context repos`，结构选择规则：

```markdown
- If `CONTEXT-MAP.md` exists, read it to find contexts
- If only a root `CONTEXT.md` exists, single context
- If neither exists, create a root `CONTEXT.md` lazily when the first term is resolved

When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.
```

因此，多个上下文时先读地图，再把术语写入当前话题所属的 `CONTEXT.md`；归属不清楚要询问。不能因为根目录最容易写，就把订购与计费的概念都堆进去。`SKILL.md` 的目录示例也区分了根目录的系统级 ADR 和各上下文内的 `docs/adr/`，记录位置应跟决策影响范围一致。

### 2、文件位置规则没有变成自动初始化器

源码通过“如果存在”“如果不清楚”等自然语言要求模型判断，没有脚本检查地图链接有效性，也没有自动创建上下文地图的固定步骤。地图指向错误目录、项目已有另一套 ADR 约定、工作区不能写入时，原 skill 都没有完整的恢复流程。

这些条件影响实际使用：已经有规范的项目应明确提供文档位置和格式；不能写文件时，应说明哪些内容尚未保存，不能把聊天中的条目称为已更新的术语表。自编类似 skill 时，可以围绕“目标文件无法定位或无法写入”补上处理规则，而不是让模型猜一个目录继续。

## 三、领域建模在每一轮中怎样介入

### 1、先发现含义冲突，再让用户确定目标语义

`skills/engineering/domain-modeling/SKILL.md` → `During the session / Challenge against the glossary`：

```markdown
When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"
```

已有术语表提供的是当前共享定义。当用户把 cancellation（取消）用作另一种含义时，模型需要把冲突明确摆出来，不能悄悄用旧定义覆盖用户目标，也不能把新说法直接覆盖到文档中。

同文件 → `Sharpen fuzzy language`：

```markdown
When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."
```

**canonical term（规范术语）** 是同一概念在当前上下文中选定的名称。原文的 account 例子展示了两个不同问题：同一个概念有多个近义词时，需要选定一个；同一个词同时指 Customer 和 User 两个概念时，需要拆清概念。不能只把所有词列为同义词，以为已经完成建模。

这些澄清会改变访谈的后续问题。若 account 尚未分清，直接讨论“账户删除后订单怎么办”会把登录身份与购买主体混在一起。应先确定概念边界，再讨论删除、所有权或历史数据保留。

### 2、用具体场景和代码检验说法

`skills/engineering/domain-modeling/SKILL.md` → `Discuss concrete scenarios`，截取场景要求：

```markdown
Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.
```

这里允许提出假设场景来检验概念，例如“登录用户离职后，企业购买方的订单是否仍属于原企业”。场景是用于澄清的例子，不能当成已经发生的事实。它的结果是让用户收紧概念之间的关系，而非要求写出一份完整测试计划。

同文件 → `Cross-reference with code`：

```markdown
When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"
```

这一规则补充了事实来源：用户说“支持部分取消”，代码却只实现整单取消时，需要确认用户在描述现状还是提出目标。读取代码证明当前实现，不代表当前实现就是正确需求；用户的新要求也不代表仓库已经具备对应行为。两者之间的差距应显式保留。

此时 `grilling` 的并行调查规则仍然适用。`skills/productivity/grilling/SKILL.md` → `Finding _facts_` 段中的原文约束是：

```markdown
a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now.
```

**frontier** 指前置条件已满足、当前能问的决策集合。涉及取消实现的分支等待调查报告，其他独立的产品决策可以继续问。报告、用户回答和术语校准共同成为下一轮输入；源码没有在三个 skill 之间传递固定 JSON 对象，它们依赖模型在同一上下文中综合这些信息。

## 四、术语明确后怎样形成稳定文件

### 1、更新发生在术语解决时

`skills/engineering/domain-modeling/SKILL.md` → `Update CONTEXT.md inline`：

```markdown
When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).
```

触发点是“一个术语已经明确”，不是访谈全部结束。用户刚确认 Customer 指购买主体，模型就应更新对应条目，再继续其他问题。这样后续对话和文件使用同一个定义，也减少最后总结时漏掉术语的机会。

这里的 `CONTEXT-FORMAT.md` 是 skill 内部的参考文件：正文保留执行时机，格式细节通过相邻文件提供。与跨 skill 使用 `/domain-modeling` 名称委托不同，内部相对链接用于获取该能力拥有的具体写法。

### 2、定义、同义词与业务边界各有位置

`skills/engineering/domain-modeling/CONTEXT-FORMAT.md` → `Structure`，截取两个示例条目：

```markdown
**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

条目由规范名称、简短定义和 `_Avoid_` 组成；`_Avoid_` 列出在该上下文中不再使用的替代说法。上面的 Invoice 定义是模板示例，并不是所有业务都应采用“交付后付款”的规则。实际使用时必须按项目含义确定定义。

同文件 `Rules` 要求定义最多一两句话，只纳入本项目特有概念；超时、错误类型、工具函数等通用编程概念不因项目大量使用就进入术语表。自然形成分组时可以加小标题，单一紧密领域则保持平铺列表。

这使一次写入从“用户整段回答”收窄成“已经达成一致的概念定义”。例如用户确认 Customer 是购买主体，并补充本次查询默认分页 50 条：前半句可能更新术语表，分页默认值仍是需求信息，不应一起塞进 Customer 定义。

### 3、术语表不承担实现规格

`skills/engineering/domain-modeling/SKILL.md` → `Update CONTEXT.md inline` 的第二段：

```markdown
`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.
```

这一内容边界比文件名更重要。`CONTEXT.md` 容易被理解为“凡是上下文都可保存”，但规则只允许它承担术语表职责。数据库设计、接口细节、实现顺序和完整需求不能因为已经讨论过就写进去。

随术语明确而即时写入，代价是共享文档会在访谈过程中变化：讨论后来改口时，需要修正条目。原 skill 没有版本化的决策账本，也不提供从旧定义自动迁移代码名称的逻辑。文档更新只改变共享语言，并不自动重命名类、字段或表。

## 五、ADR 从候选决定到记录有哪些门槛

### 1、三项同时满足，才提议创建

`skills/engineering/domain-modeling/SKILL.md` → `Offer ADRs sparingly`：

```markdown
Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in `ADR-FORMAT.md`.
```

三个条件分别筛选更改成本、解释必要性和真实权衡。数据库选择可能很难更换，但仍要说明未来读者为什么会疑惑，以及当初在什么替代方案之间作了选择；仅有“很重要”不够。

原文用的是 `offer to create`，因此满足门槛后进入“向用户提议记录”的阶段，不能直接解释为必然新增文件。配套说明 `docs/engineering/domain-modeling.md` → `Two artifacts, two bars` 也将 ADR 的写入方式标为 `Offered, not assumed`。它没有定义统一批准按钮、确认消息格式或自动批准机制。

`ADR-FORMAT.md` → `When to offer an ADR` 列举了架构形态、上下文之间的集成方式、绑定成本高的技术选择、范围边界、反直觉取舍及代码看不到的约束。这些只是合格候选的类型，仍要经过三项判断。可以轻易调整的分页默认值通常不需要 ADR，但它依然可能是需要保留在规格里的重要需求。

### 2、记录只要求背景、决定与原因

`skills/engineering/domain-modeling/ADR-FORMAT.md` → `Template`：

```markdown
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

最小产物是一段一到三句话的决策记录。`Optional sections` 允许按需要增加状态、被否决方案、后果；它没有要求每份 ADR 都填满模板。可选状态包括 proposed、accepted、deprecated、superseded by ADR-NNNN，分别表示提议、接受、废弃或由其他记录取代。这些是文档字段，并没有对应的强制状态迁移代码。

同文件 → `Numbering`：

```markdown
Scan `docs/adr/` for the highest existing number and increment by one.
```

写入时先查看目标 ADR 目录中的最大编号，再加一，形成 `0001-slug.md` 这类文件名。这个规则适合顺序维护，没有分配锁或原子编号服务：两个 agent 同时读取相同最大值，可能选中同一编号。多写入者场景需要额外协调，不能把“扫描后加一”当成并发安全保证。

## 六、一次讨论怎样留下文件，又怎样留下缺口

### 1、按时间看会话状态与文件状态

下面沿源码中的整单取消、部分取消例子展开；表内业务选择是说明性情境，不是项目自带执行记录。

| 进展 | 对话中新增的理解 | 文件层面的结果 |
| --- | --- | --- |
| 用户说“取消可按商品进行” | 与已有整单取消定义冲突，含义待澄清 | 保留旧条目，提出冲突 |
| 调查代码只支持整单取消 | 现状已查清，目标仍由用户决定 | 读取事实不会自动改文档或代码 |
| 用户确认这是新增能力，并明确部分取消的定义 | 目标语义成立，可推进退款规则问题 | 按格式即时补充或修正术语 |
| 用户决定取消与退款跨业务上下文通过事件传递，并解释替代方案 | 出现架构决定候选 | 判断是否难逆转、需解释且有真实权衡；满足时提议 ADR |
| 用户确认记录该决定 | 该选择及理由值得保留 | 在对应 ADR 目录分配编号并写入 |
| 用户还确定通知次数和数值默认值 | 一般需求也已明确 | 不强塞进术语表；不够 ADR 门槛时留在会话 |

输出有选择地保存知识。没有 ADR 可能说明没有符合条件的决定；没有文件变化也可能因为本次没有新术语，不能仅凭文件数量判断访谈是否成功。反过来，术语已经明确却没有更新，才需要检查模型是否实际加载并遵循了领域建模指令。

### 2、访谈结束不等于需求已经完整持久化

`skills/productivity/grilling/SKILL.md` → `The session is done` 段末句：

```markdown
Do not act on it until the user confirms you have reached a shared understanding.
```

这限制的是按讨论结果继续采取行动。与组合入口的文档规则一起读，术语维护可以随访谈进行，但模型不能把“已经写了词汇表”当成用户已经同意开始实现。访谈自身还要求所有分支已经处理、没有默默带入的假设；调查未返回造成的暂时无题可问不满足这个条件。

`docs/engineering/grill-with-docs.md` → `The paper trail` 明确把其余决定留在会话。后续若要生成规格，应由用户在同一会话进入 `/to-spec`；该 skill 的 `Process` 会使用项目术语并尊重涉及的 ADR。这是消费关系，`grill-with-docs` 正文没有自动调用 `/to-spec` 的步骤。

因此，即使术语表和 ADR 都存在，清空会话仍可能丢失通知次数、默认值、负面需求和已否决方案。原 skill 没有“每个答案都能追踪到规格、工作项和测试”的账本。需要强追溯能力的团队，应另行设计需求记录及交接产物；不能通过扩大 `CONTEXT.md` 的内容边界来补这个缺口。

## 七、这种组合适合怎样使用和改写

### 1、简短入口把维护成本转移到依赖加载

`grill-with-docs` 的一行正文避免重复访谈和文档规则，也让它依赖两个能力都实际加载。配套说明 `docs/engineering/grill-with-docs.md` → `Common questions` 区分了两类偏差：两者都未加载时，模型可能一次抛出所有问题、不给推荐；只加载 `grilling` 时，访谈可能正常但术语写入缺失。

这类组合适合能发现和读取依赖 skill 的宿主。自编入口时，可以明确要求先加载所列能力，缺少依赖时说明缺口，再执行组合任务；这是对原入口的加强建议，原文没有依赖完整性检查。也应区分“本次没有满足写入条件”与“写入职责遗漏”，否则会为了证明执行成功而制造空文档。

### 2、共享术语需要维护，不会随代码自动保持正确

`domain-modeling` 明确检查代码与语言是否一致，但没有要求搜索历史工作项中的命名决定。配套说明 `Cross-referencing, and where it stops` 也记录了这一边界：如果重要理由只存在于旧工作项讨论中，模型可能再次提出已经解决的冲突。要让这类证据参与判断，需要额外提供来源，或在自编规则中加入历史决策的检索条件。

同样，术语表没有自动去重、跨会话隔离或并发写入协调。它适合在概念确实影响命名、业务边界和团队协作时维护；短期一次性任务未必值得建立一套长期文档。已有成熟 ADR 规范的团队需要显式适配格式和位置，因为本版把术语表维护与 ADR 记录放在同一个 skill 中。

这套写法可复用的部分是具体的写入触发点：`When a term is resolved` 绑定即时更新，`Only offer … when all three are true` 限制决策记录，`If unclear, ask` 处理上下文归属不明。自编 skill 时，把同样精度的条件写在动作旁边，才能让“维护项目知识”落实为可判断的行为；只有“把重要内容记下来”无法约束文件写什么、何时写和何时应跳过。
