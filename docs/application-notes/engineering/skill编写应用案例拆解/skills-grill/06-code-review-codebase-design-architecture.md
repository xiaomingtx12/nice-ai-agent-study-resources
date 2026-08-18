---
sidebar_position: 7
title: "code-review、codebase-design 与 improve-codebase-architecture：从审查到架构改进"
description: 从 mattpocock/skills 源码拆解标准审查、规格审查、深模块设计和架构维护如何分工并形成后续反馈闭环。
---

# code-review、codebase-design 与 improve-codebase-architecture：从审查到架构改进

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先看这条反馈流

前一篇的 `/implement` 在完成代码、测试和提交前会调用 `/code-review`。审查发现的结构性问题，再进入 `improve-codebase-architecture`；架构 Skill 不直接替用户决定接口，而是先展示候选，用户选定后才调用 `/grilling` 和 `/domain-modeling` 深入设计。

```text
实现完成
    │
    ▼
/code-review
    │  Standards + Spec 两条审查轴
    ├──────────────┐
    ▼              ▼
标准问题       规格问题
    │              │
    └──────┬───────┘
           ▼
结构性摩擦或浅模块
           │
           ▼
/improve-codebase-architecture
           │
           ▼
临时 HTML 候选报告
           │
           ▼
用户选择一个候选
           │
           ├── /grilling
           ├── /domain-modeling
           └── /codebase-design
```

三个 Skill 处理的对象不同：

| Skill | 处理对象 | 主要动作 | 主要产物或状态 |
| --- | --- | --- | --- |
| `/code-review` | 固定比较点之后的代码差异 | 并行检查标准和规格 | 两轴审查报告 |
| `/codebase-design` | 模块的 interface、implementation 和 seam | 提供深模块设计词汇和原则 | 共享设计判断 |
| `/improve-codebase-architecture` | 近期变更暴露出的架构摩擦 | 扫描候选、生成视觉报告、进入用户选定的设计讨论 | 临时 HTML 报告、架构决策和后续方案 |

`code-review` 回答“这次变更是否符合标准、是否实现了规格”；`codebase-design` 提供判断模块形状的语言；`improve-codebase-architecture` 负责把代码库中的摩擦整理成可以讨论的候选。

## `code-review`：把质量拆成两条独立审查轴

### 先固定比较点，再启动审查

`code-review/SKILL.md` 把输入定义为固定点和当前 `HEAD` 之间的差异：

```markdown
Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code follow this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?
```

流程第一步要求解析用户给出的 commit、branch、tag 或 merge-base，并运行三点 diff：

```markdown
git diff <fixed-point>...HEAD
```

同时记录从固定点到当前分支的提交列表。固定点解析失败或差异为空时，流程应在启动审查子 agent 之前停止。

**源码直接证明：**审查对象不是“当前工作区看起来怎么样”，而是用户指定基线之后的变更集。三点 diff 以 merge-base 为比较基准，避免把无关的历史分叉混进结果。

**工程推导：**固定比较点使审查结果可复查。同一分支后来增加提交时，可以重新以同一个基线运行，比较报告变化；没有固定点的审查容易混入旧问题，也无法清楚说明审查覆盖了哪一段代码。

### 先找规格来源，再找标准来源

`code-review` 要按顺序寻找规格：

1. 从提交信息中的 Issue 引用查找；
2. 使用用户传入的路径；
3. 在 `docs/`、`specs/` 或 `.scratch/` 中按分支名或 feature 匹配；
4. 找不到时询问用户；如果确实没有规格，Spec 轴明确报告没有规格可用。

标准来源则包括仓库中的编码规范、贡献指南和其他说明代码写法的文件。除此之外，Skill 还带有一组 Fowler 代码坏味道基线，例如神秘命名、重复代码、Feature Envy、Primitive Obsession、Shotgun Surgery 和 Speculative Generality。

这里有一个重要的优先级：仓库明确写出的标准优先于通用坏味道基线；坏味道只是判断提示，不自动等于违规。Skill 还要求跳过工具已经强制检查的内容，避免把格式化器或类型检查器的结论重复报告成审查发现。

### Standards 和 Spec 为什么并行

源码明确要求两条轴由并行子 agent 执行，最后分别聚合：

```markdown
Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.
```

Standards 子 agent 检查每个文件或代码块是否违反仓库标准，并标注坏味道属于判断性意见还是硬性规则。Spec 子 agent 检查规格要求是否缺失、是否有范围外行为、以及看似实现但逻辑可能错误的部分。

最终报告必须保留两个标题：

```markdown
## Standards
## Spec
```

不能把两类发现合并后重新排序，也不选择一条轴作为“更重要”的总结果。

这种分离对应两种不同的失败：代码可以完全符合编码规范，却实现了错误需求；也可以正确实现 Issue，却破坏仓库的设计约定。并行执行减少上下文污染，分开汇报则防止一个维度的通过掩盖另一个维度的问题。

### `code-review` 不负责直接重构

Skill 的职责是建立固定范围、找到证据、运行两轴审查并呈现结果。它没有把架构重写塞进审查流程。发现浅模块、重复边界或耦合泄漏时，报告提供的是后续行动依据；是否启动架构改进，需要另一个显式入口和用户选择。

这保持了审查的可验证性：一份 review 应该说明当前 diff 的问题，不能在同一过程中改变被审查对象并让问题消失在新 diff 中。

## `codebase-design`：用共享词汇判断模块深度

### 这些词汇描述的是设计关系

`codebase-design/SKILL.md` 首先要求统一术语：

```markdown
Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface.
```

它定义了八个核心概念：

| 术语 | 在源码中的含义 |
| --- | --- |
| module（模块） | 任何拥有 interface 和 implementation 的东西，可以是函数、类、包或跨层切片 |
| interface（接口） | 调用者正确使用模块必须知道的全部事实，包括类型、约束、错误模式和性能特征 |
| implementation（实现） | 模块内部的代码，与描述 seam 角色的 adapter 区分 |
| depth（深度） | 调用者学习单位 interface 后能获得多少行为能力 |
| seam（接缝） | 可以改变行为而不在调用位置修改的 interface 所在位置 |
| adapter（适配器） | 在 seam 上满足 interface 的具体实现 |
| leverage（杠杆） | 一个 interface 为多个调用者提供能力的收益 |
| locality（局部性） | 变更、bug、知识和验证集中在一个位置的维护收益 |

源码要求使用这些词汇，不用 `component`、`service`、`API` 或 `boundary` 替换它们。术语约束本身就是一种组合协议：`tdd`、架构扫描和后续 grilling 使用同一套词汇描述测试入口和模块关系，减少同一个设计问题在不同 Skill 中换名重述。

### deep 和 shallow 的判断依据

源码把 deep module 描述成“小 interface + 大量隐藏 implementation”，shallow module 则是 interface 几乎和 implementation 一样复杂。判断重点不是代码行数，而是调用者从一个稳定入口获得了多少行为。

Skill 提供三个判断原则：

```markdown
- **Depth is a property of the interface, not the implementation.**
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam.
```

删除测试用于识别只做透传的浅模块：删除后复杂度消失，说明这个模块没有集中逻辑；删除后复杂度分散到多个调用者，说明它确实提供了 locality 和 leverage。

“interface 是测试面”与上一篇的 TDD seam 直接相连。调用者和测试应该穿过同一个接口观察行为。如果测试必须越过接口进入内部状态，问题可能出在模块形状，而不是测试写得不够多。

### seam 需要真实的变化理由

`codebase-design` 规定：一个 adapter 只能说明存在假想 seam，两个 adapter 才能证明 seam 有真实变化。架构设计不应为了“方便测试”凭空增加一层接口。

它还区分 external seam 和 internal seam：深模块内部可以有只供实现和内部测试使用的 internal seam，但不能因为测试使用了它，就把它暴露到模块的 external interface。这样既保留测试能力，也不扩大调用者必须理解的 interface。

源码给出的可测试性建议包括：

- 通过依赖注入传入依赖，不在函数内部自行创建外部对象；
- 返回结果，让调用者观察结果，少把关键行为藏在无法验证的副作用中；
- 缩小 interface，让调用者和测试需要准备的参数更少。

这些建议服务于深度和测试，不是要求所有模块都抽象出可替换接口。没有第二个 adapter 的单一实现，通常只增加间接层。

## `DEEPENING.md`：依赖类别决定怎样跨 seam 测试

`codebase-design/DEEPENING.md` 把待改进的依赖分为四类：

| 依赖类别 | 例子 | 深化后的测试方式 |
| --- | --- | --- |
| in-process | 纯计算、内存状态、无 I/O | 合并模块，直接在新 interface 上测试 |
| local-substitutable | 有本地测试替身的数据库或文件系统 | 在测试套件中运行替身，通常不把 port 暴露到外部 interface |
| remote but owned | 自己控制的内部服务或网络接口 | 在 seam 定义 port，生产使用 HTTP/gRPC/队列 adapter，测试使用内存 adapter |
| true external | 第三方支付、短信等服务 | 注入外部 port，测试提供 mock adapter |

这个分类把“是否可以抽象”与“如何验证”放在一起。远程但自有的依赖可以由内存 adapter 复现；真正外部的依赖只能隔离；纯进程内逻辑则不需要为了测试额外创建 adapter。

文档同时要求 replace, don't layer：深化之后，在新模块 interface 上写行为测试，并删除已经被新测试覆盖的旧浅模块测试。保留两套测试会让旧 interface 继续约束实现，增加维护成本，也掩盖新模块真正提供的行为面。

**源码直接证明：**深模块的 external interface 是调用者和测试共同跨越的 seam；internal seam 不能替代它。

**工程推导：**如果一次架构改进只新增了一个更深的模块，却保留所有旧测试和旧透传模块，代码库得到的是另一层叠加，而不是 locality。删除旧层是深化过程的一部分。

## `DESIGN-IT-TWICE.md`：避免第一种接口过早定型

当用户已经选定一个架构候选，并且需要探索多个 interface 形状时，`DESIGN-IT-TWICE.md` 规定采用并行子 agent：

```markdown
Spawn 3+ sub-agents in parallel. Each must produce a **radically different** interface for the deepened module.
```

每个子 agent 都要输出：

1. interface 的类型、方法、参数、不变量、顺序约束和错误模式；
2. 调用者如何使用它；
3. interface 后面隐藏哪些 implementation；
4. 依赖策略和 adapter；
5. depth、leverage 和 trade-off。

并行方案使用不同约束：有的最小化 interface，有的追求扩展能力，有的为最常见调用者优化，有的围绕 ports & adapters 设计。之后按三项标准比较：

- **depth**：interface 是否以较少知识承载更多行为；
- **locality**：变化和 bug 是否集中在一个模块；
- **seam placement**：interface 放置的位置是否能隔离变化并支撑测试。

这一步的用途是打破“第一个看起来能用的接口”带来的锁定。它仍然是方案探索，不是架构 Skill 自动选择并落地某个接口。最终推荐由当前会话综合，具体决定要经过用户确认。

## `improve-codebase-architecture`：先呈现候选，再开始设计

### 扫描范围由变更热点限定

`improve-codebase-architecture/SKILL.md` 的第一条流程约束是先定范围：

```markdown
**Scope before you scan — YAGNI.** Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed.
```

如果用户点名模块、子系统或痛点，就直接使用该方向；没有指定方向时，先读取一段较长的提交历史，找到反复变更的热点，再围绕这些路径自然探索。

探索阶段还要求先读项目的 `CONTEXT.md` 和相关 ADR，并由子 agent 观察理解代码时遇到的实际摩擦：概念是否分散在过多浅模块中、接口是否几乎和实现一样复杂、测试是否只能进入错误层级、耦合是否泄漏穿过 seam。

Skill 用 deletion test 过滤候选：删除一个模块后复杂度是否重新分散到多个调用者？如果删除只会让复杂度消失，这个模块可能只是透传，不值得作为深化候选。

### 报告是临时产物，不直接写入仓库

扫描完成后，Skill 要求写一个独立 HTML 文件到操作系统临时目录：

```markdown
Write a self-contained HTML file to the OS temp directory so nothing lands in the repo.
```

文件名带时间戳，报告使用 Tailwind CDN 和 Mermaid CDN，展示每个候选的文件、问题、解决方向、收益、before/after 图和推荐强度，最后给出 Top recommendation。`HTML-REPORT.md` 进一步要求报告保持静态，只保留 Tailwind 和 Mermaid 两个脚本，不把应用代码或交互产品混入其中。

这一设计把架构扫描和代码库状态分开：扫描报告是当前观察的临时视图，不会因为每次探索都在仓库中留下草稿文件。用户可先比较多个候选，再决定哪个问题值得进入真正的设计流程。

### 为什么报告阶段禁止直接提出接口

源码明确写着：

```markdown
Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"
```

候选报告只描述当前摩擦和可能的深化方向，不提前锁定 interface。原因有三点：

1. 架构扫描的输入是代码摩擦，输出是待选择的候选，不是用户已经批准的设计；
2. 不同候选的收益、影响范围和依赖类别需要先比较；
3. interface 是架构决策，应该在用户选择候选后结合约束、依赖和测试要求讨论。

报告阶段的输出是 HTML 文件和用户可选择的候选列表，状态仍属于当前探索过程。它没有修改代码，也没有自动创建 ADR。

### 选择之后才进入 grilling 和 domain-modeling

用户选定候选后，Skill 才运行 `/grilling`，讨论约束、依赖、deepened module 的形状、seam 后隐藏什么以及哪些测试可以保留。设计过程中继续使用 `/domain-modeling`：

- 新的领域术语进入 `CONTEXT.md`；
- 模糊术语在讨论中被收紧；
- 用户拒绝候选的理由只有在未来架构审查需要避免重复提议时，才建议记录 ADR；
- 需要探索多个 interface 时，调用 `/codebase-design` 的 design-it-twice 模式。

这条调用链说明 `improve-codebase-architecture` 不是一个自动重构器。它先把架构摩擦变成候选，再把选中的候选交给访谈、领域建模和接口设计能力。

## 三者如何组合

### `code-review` 发现问题，架构 Skill 管理后续决策

一次实现交付可以沿着这条链运行：

```text
spec / tickets
      ↓
implement
      ↓
code-review
      ├─ Standards：仓库标准和坏味道
      └─ Spec：需求覆盖和范围
                 ↓
       需要长期处理的结构性问题
                 ↓
improve-codebase-architecture
                 ↓
       候选报告 → 用户选择 → grilling
                 ↓
       codebase-design + domain-modeling
```

`code-review` 报告当前 diff 的问题，不能替用户决定一个深模块应该怎样设计。`improve-codebase-architecture` 整理候选，也不能在用户选择前提出接口。`codebase-design` 提供设计语言和比较标准，但它本身是参考 Skill，不承担扫描、报告或自动改造。

### 审查发现不等于架构任务已经成立

标准审查中的 Shotgun Surgery、Divergent Change 或 Message Chains 可以提示结构摩擦，但它们仍是审查发现。是否值得架构改进，要结合变更热点、未来收益、依赖类别和真实测试困难判断。

反过来，架构候选也未必是当前 diff 的错误。一个模块可能暂时浅，但没有重复变化、没有调用者摩擦，也没有测试问题。`improve-codebase-architecture` 以近期变更和实际理解阻力限定范围，就是为了避免把所有理论上的重构都列入候选。

### 配置层表达不同的状态副作用

三个 Skill 的调用配置体现了不同副作用：

- `code-review/agents/openai.yaml` 只声明显示名称和简介；
- `codebase-design/agents/openai.yaml` 只声明设计词汇能力；
- `improve-codebase-architecture/agents/openai.yaml` 明确 `allow_implicit_invocation: false`，frontmatter 也设置 `disable-model-invocation: true`。

审查和设计词汇可以作为其他实现过程的参考能力。架构改进会写临时报告、打开外部文件、等待用户选择，并在后续可能更新 `CONTEXT.md` 或 ADR，所以入口必须由用户显式调用。

Skill 之间仍通过 `/skill-name` 表达能力依赖，不通过 `../` 深层路径耦合内部文件。这样 `codebase-design` 可以被 TDD、架构改进和其他 Skill 共享，而不要求调用方了解它的目录布局。

## 运行边界与工程代价

| 阶段 | 状态归属 | 主要副作用 | 下游消费者 |
| --- | --- | --- | --- |
| 固定 review point | 当前分支历史和用户输入 | 读取 diff、提交列表、规格和标准文件 | 两个审查子 agent |
| Standards / Spec 审查 | 两个相互隔离的子 agent | 生成两份独立发现 | review 聚合器、开发者 |
| 架构探索 | 当前代码库、`CONTEXT.md` 和 ADR | 读取提交历史、扫描热点 | 架构候选报告 |
| 候选报告 | 操作系统临时目录 | 写 HTML、调用 CDN、打开文件 | 用户选择 |
| 设计深入 | 当前会话和项目文档 | grilling、词汇更新、必要时 ADR | 后续规格、实现或架构票据 |

这套拆法减少了三种误判：

- 把代码风格合规当成需求正确；
- 把一次 review 的坏味道直接当成必须重构的架构任务；
- 在没有用户选择和约束确认时，直接锁定一个 interface。

代价同样明确：

- review 需要可靠的固定点、规格来源和标准文件；
- 两条审查轴使用并行子 agent，运行和聚合逻辑更复杂；
- 架构扫描需要生成视觉报告，并依赖本地打开文件和 CDN；
- 用户必须在候选报告后做一次选择，设计过程因此不会完全自动推进；
- 领域词汇、ADR、规格和架构候选之间需要维护清楚的状态归属。

`improve-codebase-architecture` 把 HTML 写入操作系统临时目录，避免把探索草稿带入仓库。迁移到无浏览器、无外网或禁止写临时文件的环境时，需要替换报告呈现方式，但应保留“先展示候选、再选择、后设计”的状态边界。

## 迁移边界

### 可以采用

- 把 code review 拆成 Standards 和 Spec 两条独立审查轴；
- 要求 review 先固定比较点，并显式寻找规格和标准来源；
- 用统一的 module、interface、depth、seam、adapter、leverage、locality 词汇讨论架构；
- 用 deletion test 识别没有提供 locality 或 leverage 的浅模块；
- 只有存在真实变化时才建立 seam 和 adapter；
- 架构扫描先给出候选报告，用户选定后再进入 grilling 和接口设计；
- 通过多个差异明显的 interface 方案比较 depth、locality 和 seam placement。

### 需要改造

- 固定点、Issue tracker、规格位置和编码标准要映射到目标项目；
- 没有子 agent 并行能力时，保留两条审查轴的独立输入和独立输出，按顺序运行；
- 没有 `CONTEXT.md` 或 ADR 的项目，需要定义等价的领域词汇和决策记录位置；
- 无浏览器、无 CDN 或只读环境，需要替换 HTML 报告呈现方式；
- 依赖类别和 adapter 必须按目标系统的真实部署边界重新分类；
- 不能自动打开临时文件的 harness，需要把报告路径作为显式产物交给用户。

### 不应照搬

- 不要在没有固定比较点时声称 review 覆盖了完整变更；
- 不要把 Standards 和 Spec 发现混在一个列表里重新排序；
- 不要把通用坏味道基线当作高于仓库标准的硬规则；
- 不要为了测试方便给只有一个实现的依赖强行加 seam；
- 不要在架构候选报告阶段直接设计和实施 interface；
- 不要把所有浅模块都视为必须深化的对象，先看近期变化和实际摩擦；
- 不要把 HTML 报告、CDN 或临时路径误写成项目运行时能力。

## 编写审查与架构型 Skill 的检查清单

- [ ] review 是否要求用户提供并验证固定 point？
- [ ] diff 是否使用明确的 merge-base 比较方式，并记录提交列表？
- [ ] 是否先寻找规格来源，再寻找仓库标准和通用坏味道基线？
- [ ] Standards 与 Spec 是否由独立上下文分别审查、分别汇报？
- [ ] 仓库标准是否覆盖通用启发式规则，工具已经检查的内容是否跳过？
- [ ] 架构 Skill 是否定义稳定且可复用的 module、interface、depth、seam、adapter、leverage、locality 词汇？
- [ ] 是否使用 deletion test 判断模块是否真正提供 locality 和 leverage？
- [ ] 是否区分 external seam 和 internal seam，并避免暴露仅供内部测试的接口？
- [ ] 是否根据依赖类别选择真实、内存或 mock adapter？
- [ ] 架构扫描是否先限定范围并优先检查近期变更热点？
- [ ] 候选阶段是否只生成可比较的报告，没有过早锁定 interface？
- [ ] 用户选择候选后，是否通过 grilling 确认约束、依赖和测试？
- [ ] 新术语和不可逆的架构理由是否分别进入 `CONTEXT.md` 与 ADR？
- [ ] 需要多种接口方案时，是否按 depth、locality 和 seam placement 比较，而不是只选第一方案？
