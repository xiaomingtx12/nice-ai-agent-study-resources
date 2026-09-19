---
sidebar_position: 7
title: "code-review、codebase-design 与 improve-codebase-architecture：从审查到架构改进"
description: 从 mattpocock/skills 源码拆解标准与规格审查、深模块设计、架构候选筛选及多方案接口比较。
---

# code-review、codebase-design 与 improve-codebase-architecture：从审查到架构改进

:::info 版本与源码入口

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。以下路径相对项目根目录；入口均为真实 Markdown 章节，HTML 摘录是报告模板，不是架构扫描程序。

| 文件 | 阅读入口 | 作用 |
| --- | --- | --- |
| `skills/engineering/code-review/SKILL.md` | `Process` 第 1–5 步、`Why two axes` | 确定差异范围、分派审查、聚合报告 |
| `skills/engineering/codebase-design/SKILL.md` | `Glossary`、`Principles`、`Going deeper` | 共享设计词汇及条件引用 |
| `skills/engineering/codebase-design/DEEPENING.md` | `Dependency categories`、`Seam discipline`、`Testing strategy: replace, don't layer` | 按依赖选择测试方式 |
| `skills/engineering/codebase-design/DESIGN-IT-TWICE.md` | `Process` 第 1–3 步 | 为选定候选探索不同接口 |
| `skills/engineering/improve-codebase-architecture/SKILL.md` | `1. Explore`、`2. Present candidates as an HTML report`、`3. Grilling loop` | 扫描、展示候选、深入用户选择 |
| `skills/engineering/improve-codebase-architecture/HTML-REPORT.md` | `Scaffold`、`Candidate card`、`Style guidance` | 报告结构与呈现方式 |

:::

## 一、code-review：同一份差异，两份独立判断

### 1、先核对比较范围，命令固定不等于代码快照固定

`code-review` 检查一段代码差异：Standards（规范审查）判断是否遵守仓库约定，Spec（规格审查）判断是否满足原始需求。`codebase-design` 提供讨论模块结构的词汇，`improve-codebase-architecture` 则扫描架构摩擦、让用户选择值得深入的候选。三者没有组成自动修复流水线；审查报告可以成为架构讨论的输入，但扫描入口仍须由用户显式调用。

这些 skill 主体都是模型需要遵循的 Markdown 指令。下文的顺序、子 agent 分工和等待条件由宿主中的模型执行，没有函数自动检查阶段状态。实际输入输出包括 Git 差异、标准文件、规格、子 agent 报告和设计文档。

来源：`skills/engineering/code-review/SKILL.md` → `1. Pin the fixed point`，完整摘录：

```markdown
Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.
```

用户给出比较引用；没有给出时先询问，不自行猜成 `main`。三点差异 `git diff <fixed-point>...HEAD` 从两个引用的共同祖先（merge-base）比较到 `HEAD`。同时记录的两点 `git log` 列出 `HEAD` 可达、比较引用不可达的提交，帮助审查者理解这段工作。

这里有两个必须带入使用方式的限制：

- **不包含未提交修改。** 暂存区和工作区中的代码都不在这条命令内。即使 description 提到进行中的工作，正文也没有提供未提交差异分支。
- **没有冻结引用。** `git rev-parse` 在这里用于确认引用能解析；指令没有要求把结果 SHA 替换进后续命令。`main`、`HEAD~5` 和 `HEAD` 仍可能随提交或引用更新而变化。“Capture the diff command once”固定的是命令文本，不保证两个子 agent 稍后执行时读取相同快照。

因此，需保持审查期间的比较对象稳定；如果要严格可复现，自编流程应明确解析并保存两端提交，再把相同快照交给所有审查者。这是对源码协议的补充，不是当前实现已经提供的保证。

还有一个组合空档：`skills/engineering/implement/SKILL.md` 要求先调用 `/code-review`，再提交代码。如果尚无中间提交，刚写的实现不会进入审查；如果差异非空，也可能只是此前提交的内容。不能把“审查执行过”当作“本轮实现已被覆盖”。

### 2、先收集需求与规范，再把相同差异交给不同角色

`2. Identify the spec source` 依次寻找：提交信息中的工作项引用、用户传入的路径、`docs/` / `specs/` / `.scratch/` 下与分支或功能匹配的规格；仍找不到时询问用户。工作项的获取方式来自 `docs/agents/issue-tracker.md`。用户确认没有规格时，实际分派步骤跳过 Spec 子 agent，最终报告写明 `no spec available`，不会从实现反推一份需求再审自己。

`3. Identify the standards sources` 则查找仓库的编码规范与贡献说明。没有这些文件也不意味着规范审查无法开始，因为同节内置十二类 Fowler code smells（代码坏味道，即提示潜在设计问题的启发式）。例如重复逻辑、散落多处的关联修改、只做转发的中间层、为未出现的需求增加抽象。

来源：`skills/engineering/code-review/SKILL.md` → `3. Identify the standards sources`，摘录优先级：

```markdown
- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.
```

仓库标准优先，坏味道只能作为带名称的判断。例如 Feature Envy 指方法过多操作其他对象的数据，可能提示应移动职责；如果项目明确采用这种组织方式，就不能仅凭通用偏好判定违规。工具已经强制检查的规则应跳过，以免报告重复格式化器或静态检查器的结果。

这一步完成后，有三组材料：同一份差异命令与提交列表、规范文件及坏味道基线、原始规格。它们被有意分配给两个不同上下文，避免“符合需求”掩盖结构问题，或“代码漂亮”掩盖需求缺失。

### 3、子 agent 的输入必须完整，不能假设它看得到主会话

来源：`skills/engineering/code-review/SKILL.md` → `4. Spawn both sub-agents in parallel`，摘录 Standards 输入中的关键一项：

```markdown
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
```

规范文件可以按路径读取，内置坏味道清单却必须完整放进子 agent 的提示中。否则主会话读过这份清单，并不意味着新上下文也拿到了它。实际分派规则如下：

| 角色 | 独有输入 | 要报告的内容 | 每条发现的依据 |
| --- | --- | --- | --- |
| Standards | 规范来源文件、完整坏味道基线 | 违反仓库标准的位置，以及可能的坏味道 | 规范文件与具体规则；或坏味道名称与差异片段 |
| Spec | 规格路径或已获取的正文 | 缺失或部分实现、范围外行为、看似实现但做错的需求 | 对应的规格原句 |

两个角色都收到差异命令和提交列表，各自报告有 Under 400 words 的长度上限。这个限制约束报告长度，不是限制只读多少文件。完整依据仍要足以让主会话和用户定位发现。

独立提示没有禁止再次委派或重新调用 `/code-review`。所以“恰好两个子 agent”是顶层分派意图，不是全局递归上限。自编审查 skill 若需要固定开销，应在角色提示中明确直接执行审查及委派边界；当前文本未提供这种限制，也没有定义子 agent 失败后的重试策略。

### 4、聚合保留两轴，也保留未覆盖信息

来源：`skills/engineering/code-review/SKILL.md` → `5. Aggregate`，完整摘录：

```markdown
Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.
```

聚合者保留两个分区，分别给出数量和各轴最严重的问题；缺失规格时，在 Spec 区明确说明未审。规范通过与规格通过不能相互替代，也不应被压成一个模糊的总分。

这个步骤允许原样或轻度整理子报告，没有要求逐条重新核验所有引用。带证据的报告更容易检查，但不等于证据已被第二次验证。`code-review` 的输出是发现，不包含自动修改代码、修复后重试或直至零发现才结束的协议。坏味道本身又是启发式，不能把反复审查直到“完全干净”当作有收敛保证的流程。

## 二、codebase-design：先统一接口含义，再判断模块价值

### 1、词汇表定义的是使用成本，不是目录布局

`codebase-design` 主文件以参考规则为主，不负责扫描整个仓库，也不规定一开始就生成多个方案。它的 `Going deeper` 只在涉及依赖处理或替代接口时，把模型引向两个配套文件。

来源：`skills/engineering/codebase-design/SKILL.md` → `Glossary`，摘录 Interface 定义：

```markdown
**Interface** — everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, and performance characteristics. _Avoid_: API, signature (too narrow — they refer only to the type-level surface).
```

interface（接口）包含调用者必须知道的所有事实：不只方法和参数，还包括不变量、顺序、错误、配置和性能条件。一个只有两个方法的模块，如果调用者还要理解十条初始化规则，接口仍然可能很重。

这份词汇表把其余概念接在同一关系上：

| 术语 | 含义及观察对象 |
| --- | --- |
| module（模块） | 有接口和实现的单位，可以是函数、类、包或跨层切片 |
| implementation（实现） | 模块内部的代码 |
| depth（深度） | 调用者每理解一单位接口，能获得多少行为能力 |
| seam（接缝） | 接口所处的位置，在此替换行为而不改动调用处 |
| adapter（适配器） | 在某个接缝处满足接口的具体实现，描述它承担的角色 |
| leverage（复用收益） | 同一接口让多个调用者和测试获得能力 |
| locality（局部性） | 变化、bug、知识和验证集中在少数位置 |

例如源文提到的 Postgres 数据访问实现与内存替身，都可以充当 adapter；它们内部代码多少不同，并不改变 adapter 是“填在接口位置上的具体实现”这一角色。深度也不是实现行数除以接口行数，增加内部代码不会自动提高调用者收益。

源码要求设计讨论使用这组固定名词，避免把 module 随意换成 service、component，把 interface 缩窄成类型签名。自编多个会互相引用的 skill 时，共享词汇的价值就在这种具体约束上：测试、扫描和方案比较说到“接口”时，都要同时考虑错误与顺序条件。

### 2、删除测试判断是否保留抽象，透传层也可以是改进对象

来源：`skills/engineering/codebase-design/SKILL.md` → `Principles`，摘录：

```markdown
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
```

deletion test（删除测试）是一个设计推演，不是执行删除文件的命令。想象拿掉模块：如果只是少了一次无意义转发，复杂度消失，这层没有提供足够价值；如果调用者不得不各自补回隐藏逻辑，复杂度重新分散，模块就在提供复用收益与局部性。

这不能推出“透传模块应从架构候选中排除”。删除或合并透传层，可能正是把分散逻辑集中到更清楚接口后的改进。架构扫描自己的表述也不同。来源：`skills/engineering/improve-codebase-architecture/SKILL.md` → `1. Explore`，摘录：

```markdown
Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.
```

两处文字分别强调“现有模块有没有价值”和“删除后是否集中复杂度”。实际判断要描述删掉之后谁接手职责；仅仅减少文件数、或把同样复杂度搬到另一个文件，都不足以说明设计收益。

### 3、外部接缝与内部接缝承担不同责任

来源：`skills/engineering/codebase-design/SKILL.md` → `Principles`，摘录内部结构原则：

```markdown
- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, mockable, swappable parts — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface.
```

深模块可以由许多小部件构成。对调用者暴露的是外部接缝，内部测试可使用私有接缝，但不能仅因测试要用就把它加入公共接口。否则内部每个变化都会变成调用者也要理解的新事实。

`Designing for testability` 进一步建议接收依赖而非自行创建、返回可观察结果、缩小接口面积。这些是设计方向，不会自动施加语言级可见性或导入限制；仓库中的词汇表没有生成限制跨模块引用的编译器或 lint 规则。文件夹看起来像“深模块”，也不能替代实际接口约束。

### 4、依赖类别决定替身放在哪里

`Going deeper` 把依赖分析引向 `skills/engineering/codebase-design/DEEPENING.md` → `Dependency categories`。它按依赖能否在测试中真实运行、是否受项目控制，分出四种处理方式：

| 依赖类别 | 实际情形 | 指令建议的测试方式 |
| --- | --- | --- |
| `In-process`，进程内 | 纯计算、内存状态，无 I/O | 合并浅模块后直接测试新接口，无需 adapter |
| `Local-substitutable`，可用测试替身替代 | 文中举 PGLite 替代 Postgres、内存文件系统 | 替身随测试运行，接缝留在内部，不把 port 暴露给调用者 |
| `Remote but owned`，项目控制的远程依赖 | 自有网络服务 | 在接缝定义 port，生产注入 HTTP/gRPC/队列 adapter，测试注入内存 adapter |
| `True external`，无法控制的第三方依赖 | 支付、短信等 | 注入外部 port，测试提供 mock adapter |

port（端口）在这里就是为了隔离依赖而定义的接口。mock（模拟替身）用于无法控制的外部交互；自有远程依赖的内存 adapter 则需要表达该接口的行为。区分“项目内部的协作者”和“需要跨越部署边界的依赖”，才能与测试驱动开发（TDD）的 mock 原则一起使用，而不是把所有调用都模拟掉。

来源：`skills/engineering/codebase-design/DEEPENING.md` → `Seam discipline`，摘录：

```markdown
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a port unless at least two adapters are justified (typically production + test). A single-adapter seam is just indirection.
```

“两个 adapter”不要求已有两个生产后端；生产实现加上确有需要的测试实现就可以构成依据。单一实现为了可能的未来变化而增加接口，只带来额外间接层。这个判断仍需具体说明第二个 adapter 为什么必要，而不能为了凑数量再写一个无用替身。

同文件 → `Testing strategy: replace, don't layer` 要求在新模块接口上建立行为测试后，删除旧浅模块的单元测试。设计意图是让测试跟随新的职责位置，避免旧接口继续束缚实现。应用时必须先确认重要行为仍由新测试覆盖；“把旧测试删了”本身不构成验证，更不能仅因目录合并就删除尚无替代覆盖的测试。

## 三、架构扫描：从范围到候选，再等待选择

### 1、先确定值得看的区域，再让子 agent 探索

`improve-codebase-architecture` 的 frontmatter（文件头元数据）设置 `disable-model-invocation: true`，相邻 `agents/openai.yaml` 设置 `policy.allow_implicit_invocation: false`。它需要用户显式启动，但启动后可以按指令使用 `codebase-design`、`grilling`、`domain-modeling` 等模型可调用的 skill。

来源：`skills/engineering/improve-codebase-architecture/SKILL.md` → `1. Explore`，摘录范围分支：

```markdown
- If the user named a direction — a module, a subsystem, a pain point — take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the codebase's hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.
```

指定模块或痛点就直接沿该方向；否则用一段提交历史推断经常变化的区域，没有明显热点时才扩大范围。指令没有给“最近”固定天数，也没有实现按变更频率排序的算法。优先近期活跃区域，是因为把它变得更容易修改更可能很快带来收益；长期不动的区域即使结构不理想，也未必值得当前投入。

模型先读 `CONTEXT.md` 的领域词汇和相关 ADR（架构决策记录），再派一个子 agent 走读代码。探索关注理解一个概念是否要跳过很多浅模块、纯函数测试是否错过真实调用模式、耦合是否穿透接口、哪些行为缺少可测试入口。这个版本只写了“spawn a sub-agent”，没有绑定某个产品专有的工具名或参数。

### 2、候选报告给出职责变化，不提前确定具体接口

第 2 步把探索结果写成操作系统临时目录下的 `architecture-review-<timestamp>.html`，每次新建一个报告，并打开给用户、报告路径。这里描述的是 skill 的产物位置，不是被分析应用的运行时组件。

候选需要包含涉及文件、具体摩擦、职责将如何变化、局部性与复用收益、前后对照图，以及 `Strong` / `Worth exploring` / `Speculative` 三档推荐强度；末尾选出最值得优先处理的一项。

来源：`skills/engineering/improve-codebase-architecture/SKILL.md` → `2. Present candidates as an HTML report`，摘录结束条件：

```markdown
Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"
```

这里允许说明“把订单接入的分散规则集中到一个模块”，却要求把具体方法、参数、错误形状等接口设计留到选择之后。报告先帮助用户判断哪个问题值得花时间；选定候选只确定了讨论对象，还没有批准具体实现。

该步骤没有自动选第一名继续，也没有定义“找不到有价值候选”的明确退出格式。推荐强度能表达不确定性，却不能保证每次扫描都找到值得改的东西。自编扫描 skill 时，给出“没有足够证据支持改动”的合法结果，可以减少为完成报告而硬凑候选。

### 3、HTML 是一个文件，样式与图形仍依赖外部资源

`HTML-REPORT.md` 把呈现细节从扫描正文中分出去：卡片结构、图例、图形选择和配色都在配套文件里。关系和调用顺序适合 Mermaid（用文本定义图形的工具），强调模块厚薄或职责收拢时可用 CSS/SVG；每个候选都要有 before/after 对照。

来源：`skills/engineering/improve-codebase-architecture/HTML-REPORT.md` → `Scaffold`，摘录加载部分，其余 HTML 省略：

```html
<script src="https://cdn.tailwindcss.com"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
</script>
```

Tailwind 提供样式工具，Mermaid 渲染图形；两者都从 CDN（内容分发网络）加载。模板所称 self-contained 是报告集中在单个 HTML 文件，不是完全离线、自带所有资源。断网或脚本被拦截时，样式和图形可能不完整；写出并打开文件也不等于已经观察到渲染结果。

`Style guidance` 限定只有上述两个脚本，其他内容保持静态。正文虽然提到折叠动画等视觉方向，配套文件没有提供交互应用逻辑。需要离线报告时，应明确改用内嵌样式和 SVG，并保留候选比较信息；这属于呈现方式的调整，不是模板已有的降级分支。

### 4、ADR 冲突和候选拒绝，各有不同的处理时机

来源：`skills/engineering/improve-codebase-architecture/SKILL.md` → 第 2 步，摘录冲突规则：

```markdown
**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly in the card (e.g. a warning callout: _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.
```

已有 ADR 不应被悄悄绕过。真实摩擦足以支持重新讨论时，可以把候选放入报告，但必须带出冲突和重开理由；不能把所有违背旧决定的理论重构都列出来。

用户选中候选后，第 3 步才要求运行 `/grilling`，讨论约束、依赖、模块形状、接口后隐藏什么，以及哪些测试应保留。`grilling` 把决策按前置关系组织成轮次，等待用户回答后再推进；它结束时仍需要确认双方理解一致，不能把报告里的推荐视为已确认方案。

设计中还调用 `/domain-modeling` 维护领域文档：新概念确定就写入 `CONTEXT.md`，模糊术语变清楚就当场更新，文件不存在时按需创建。用户拒绝候选若有未来必须知道的实质理由，再提议记录 ADR；“现在没空做”之类短期理由不够。

这部分会写领域文档，因此整个 skill 不能笼统描述成“只生成一个 HTML、绝不改变仓库内容”。扫描阶段没有要求改业务代码，设计阶段却明确允许记录术语和决定；完整重构实现仍不在这份流程内。

## 四、需要比较接口时，再进入 Design It Twice

### 1、先给用户问题背景，同时给子 agent 独立技术材料

`skills/engineering/codebase-design/SKILL.md` → `Going deeper` 在需要探索替代接口时引用 `DESIGN-IT-TWICE.md`。它不是每次阅读设计词汇就必跑的分支，前提是已经有选定候选，用户希望比较不同接口。

第 1 步先给用户解释必须满足的约束、依赖类别，以及帮助理解约束的粗略代码草图；草图用于定位问题，不是提前提交方案。来源：`skills/engineering/codebase-design/DESIGN-IT-TWICE.md` → `1. Frame the problem space` 末尾与第 2 步开头，省略章节标题：

```markdown
Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the sub-agents work in parallel.

Spawn 3+ sub-agents in parallel. Each must produce a **radically different** interface for the deepened module.
```

这里没有第二个等待批准点：展示背景后立即并行设计，让用户阅读时子 agent 同时工作。每个子 agent 收到独立技术任务，包括文件路径、耦合细节、依赖类别与接口后隐藏的职责，还要收到设计词汇和 `CONTEXT.md` 的领域词汇。面向用户的简明说明不能替代这份完整输入。

### 2、不同约束制造不同方案，相同输出字段支持比较

来源：`skills/engineering/codebase-design/DESIGN-IT-TWICE.md` → `2. Spawn sub-agents`，摘录分派约束：

```markdown
- Agent 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Agent 2: "Maximise flexibility — support many use cases and extension."
- Agent 3: "Optimise for the most common caller — make the default case trivial."
- Agent 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."
```

前三种分别追求最小入口、扩展能力与常用场景便利；依赖跨接缝时可增加端口与适配器方案。区别来自真实优化目标，不是让三个 agent 给同一设计换名字。

每个方案统一输出接口及不变量、调用示例、隐藏的实现、依赖与 adapter 策略，以及收益薄弱处。第 3 步按顺序展示，再用 depth、locality 和 seam placement（接缝位置）比较，给出自己的推荐；不同方案的部分可兼容时允许提出组合方案。

这与两轴审查的聚合策略恰好不同：审查必须保持维度分离，接口设计则要求综合并明确推荐。两者的输出目的不同，不能抽象成一个通用“收集子 agent 结果后排序”的模板。设计步骤也没有创建文件、执行重构或自动提交的要求，产物仍是可供决策的方案。

## 五、这些写法适合怎样的使用与扩展

### 1、参考材料可以复用，过程边界不能靠词汇代替

`codebase-design` 把通用词汇与依赖策略独立出来，让 TDD、架构扫描和接口比较共享；`improve-codebase-architecture` 把 HTML 呈现细节放在配套文件，主流程仍能清楚看到“探索 → 报告 → 用户选择”。这种组织方式把每个阶段必须遵守的条件留在正文，把按情形使用的细节放到有明确引用的资料里。

自编 skill 时要同时写清引用条件和消费方式。例如“需要替代接口时读取 Design It Twice”比无条件附上一大段并行设计步骤更能避免误启动；“把完整坏味道基线传给 Standards 子 agent”比假定子 agent 继承父上下文更能保证输入完整。

### 2、报告的完成条件与改动的完成条件应分别定义

审查的终点是两份有依据的报告；扫描的首个终点是候选 HTML 与用户选择；接口比较的终点是方案与推荐。只有领域建模明确规定了何时更新词汇和提议 ADR。它们都没有提供“评审发现 → 修复 → 重试 → 更新工作项状态”的完整执行协议。

使用时，给审查提供稳定的比较对象与实际规格，给扫描提供近期要解决的变化或痛点，给接口比较提供一个明确候选。要把这些能力扩展成交付流程，还需定义可移动引用怎样冻结、未提交差异怎样纳入、缺失输入或子 agent 失败如何处理、哪些发现必须解决。把这些约定写在交接处，才能让后续使用者知道一份报告究竟证明了什么，以及它尚未完成什么。
