# Skill：Prompt 模块化封装

> **本章目标**：理解 Skill 系统的完整设计——它如何把领域指令从"常驻 System Prompt"解放为"按需加载的模块"，TF-IDF 搜索如何在不调用 Embedding 模型的情况下定位 Skill，以及 Skill 描述与全文在上下文生命周期中的不同角色。
>
> **读完本章你应该能回答**：
> - Skill 与 CLAUDE.md、Slash Command、子 Agent 的边界在哪里？什么场景选什么？
> - Skill 描述（精简版）常驻 System Prompt，全文按需注入对话——这两种"上下文"有什么区别？
> - TF-IDF 索引怎么构建？为什么 name 比 description 权重高？
> - 触发 Skill 的三条路径（手动 / LLM tool_use / 系统自动 prefetch）如何协作？
> - Turn-zero 阻塞搜索与 inter-turn 异步 prefetch 的设计权衡？
> - CJK 查询怎么匹配英文 Skill 描述？bigram + Haiku 翻译的组合机制是什么？

## 阅读导航

本文按"问题 → 定位 → 全貌 → 细节 → 收束"五段递进组织。前两段建立问题意识与坐标，第三段（宏观全景）给出端到端心智模型，第四段（核心运行时细节）沿一次 Skill 调用的生命周期下沉到机制层面，最后以设计权衡、边界局限、可复用模式三段收束。建议第一遍读至第三段即可建立全局认知，第四段按需查阅。

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一、解决什么问题 | CLAUDE.md 膨胀、Skills vs Slash Commands 边界、CJK 搜索等五类痛点 | 必读，建立问题意识 |
| 二、在整体架构中的位置 | Skill 在上下文组装层的坐标，与 Hook / 子 Agent 的互补关系 | 必读，建立全局坐标 |
| 三、宏观全景：系统完整样貌 | 端到端全景链路 + 核心抽象 + 版图分类 + 注册机制 + 对外接口 | 必读，建立心智模型 |
| 四、核心运行时细节 | 索引构建 / 查询匹配 / 触发执行 / 上下文生命周期 / 动态注入，沿生命周期展开 | 核心章节，每机制按"为什么需要 → 怎么做 → 具体实例"三段式 |
| 五、设计决策与权衡 | 14 个关键决策点的取舍原因 | 理解为什么这样设计 |
| 六、边界与局限 | 当前实现的 8 类不足与已知约束 | 了解能力边界 |
| 七、可复用的模式 | 6 个可迁移的设计模式 | 提炼方法论 |

> **配套阅读标注**：文中 `file:line` 为源码定位点，可对照阅读；常量名（如 `SKILL_BUDGET_CONTEXT_PERCENT`）首次出现时附"意图说明"；每个核心机制末尾的"具体实例"为可选读段，已熟悉原理可跳过。

---

## 一、解决什么问题

给 Agent 写指令有三种常见方式：零散地写在聊天里（每次都重写），写在 CLAUDE.md 里（一直占着上下文），或者封装成 Skill 模块（需要时自动或手动触发，用完释放上下文）。Skill 是第三种方式——把一段完整的领域指令封装成模块（`SKILL.md` 文件），它的精简描述常驻 System Prompt，完整内容在触发时作为单条消息注入对话。它解决的根问题是：**领域知识如何模块化管理而不永久占用 token 预算**。

### 具体痛点拆解

**痛点 1：CLAUDE.md 无限膨胀**

一个真实用户可能有：代码审查规范、错误日志格式、k8s debug 步骤、安全审计 checklist、提交规范……全部塞 CLAUDE.md 会让 system prompt 涨到 30K+ tokens，且大部分内容在 90% 的对话里都用不到。更隐蔽的代价是：System Prompt 越长，LLM 对其中每一条指令的"注意力"被稀释——重要规范淹没在噪声里。Skill 通过"描述常驻 + 全文按需加载"两步分离解决这个问题——LLM 始终知道有哪些 Skill 可用（仅花几十字符的描述），但完整指令只在相关场景才注入。

**痛点 2：Skills vs Slash Commands 边界模糊**

Claude Code 同时支持 `/command`（手工执行的内置命令，如 `/clear`、`/help`）和 Skill（prompt 模板）。两者都用 `/skill-name` 触发，但 Skills 关注"领域行为引导"，slash commands 关注"系统行为"。混在一起会导致：
- 用户用 `/search-docs` 时，分不清它是工具还是 prompt
- LLM 决策时，不知道哪些是"被自动管理的"（系统命令），哪些是"我可以建议用户触发的"（Skill）

解决方案：Skill 类型为 `'prompt'`，slash command 类型为 `'local'` 或 `'builtin'`，工具类型为 `'tool'`。三者在 `getCommands()` 中明确分类（`src/services/skillSearch/localSearch.ts:306` 的 `cmd.type === 'prompt'` 过滤）。类型分边后，LLM 的决策空间清晰：`prompt` 类可被自动触发，其余不可。

**痛点 3：中文 skill 搜索匹配差**

英文分词靠空格 + 词干化（Porter-like），中文没有空格。如果用户的 query 是中文"代码审查"，而 Skill 描述全是英文（"Review pull requests for style and bugs"），直接 TF-IDF 匹配几乎全部为零——中文字符与英文 token 在词表里完全不重叠。解决方案是双管齐下：bigram 处理（把"代码审查"切成"代码""码审""审查"，至少让中文 query 之间能自匹配）+ 在 turn-zero 阻塞路径调用 Haiku 把中文翻译成英文关键词（让中文 query 能跨语言命中英文描述）。

**痛点 4：不知道哪个 Skill 适合当前任务**

完全靠用户手动调 `/skill-name`，太依赖用户记忆——用户得先记住自己装了哪些 Skill、名字叫什么、什么场景用。这对 Skill 数量增长到几十个时不可持续。需要自动发现——根据用户当前消息和 Skill 的描述/触发条件（whenToUse）做语义匹配。系统在 turn-zero（首轮阻塞）和 inter-turn（每轮工具执行后异步）两个时机做这件事，前者付得起延迟所以能调翻译模型，后者必须快所以只用本地 TF-IDF。

**痛点 5：单个 Skill 内容大小不可控**

Skill 可以是 50 行也可以是 5MB 的复杂 prompt。没有预算约束容易撑爆 context window。但这里有个微妙区分：描述侧必须硬约束（因为它要常驻所有 Skill 的描述，累加起来影响每轮 token），全文侧则"信任作者"——因为全文只在触发时注入一条，作者写太大是自己选择牺牲上下文。因此：描述侧用 `MAX_LISTING_DESC_CHARS = 1536` 字符上限 + `SKILL_BUDGET_CONTEXT_PERCENT = 0.01`（占 context window 1%）做硬约束；全文侧不设限。

> 小结：五个痛点归结为两条主线——**上下文经济学**（痛点 1、5：如何不浪费 token）与**可发现性**（痛点 3、4：如何让对的 Skill 在对的时候出现），中间夹着**分类清晰性**（痛点 2：让 LLM 和用户都知道边界）。下一章我们看 Skill 在整体架构中落在哪一层，为什么由它而不是别的机制来承担这两条主线。

---

## 二、在整体架构中的位置

Skill 位于**上下文组装层**——它不参与模型推理本身，而是在推理发生前决定"哪些指令该进入 LLM 的视野"。这一层有三类参与者，各自承担不同职责：

- **CLAUDE.md**：永久常驻的基线指令，每次会话都加载，适合"永远成立的规范"。
- **Skill**：按需加载的领域指令，描述常驻、全文触发注入，适合"特定场景才用的流程"。
- **Hook**：透明约束，在工具调用前后执行，LLM 甚至感知不到它的存在，适合"强制安全/格式检查"。

三者的关系是互补而非替代：CLAUDE.md 提供"默认值"，Skill 提供"扩展能力"，Hook 提供"不可绕过的护栏"。Skill 与子 Agent（上下文隔离）也不同——子 Agent 是把任务连同上下文一起隔离出去执行，Skill 是把指令注入主上下文让主 Agent 自己执行。

Skill 横跨两个时机：**启动时**构建索引（一次性，把磁盘上的 SKILL.md 变成可搜索的 TF-IDF 向量），**每轮 turn** 时根据当前查询做匹配（增量，决定是否把某条 Skill 的全文注入对话）。前者是"准备阶段"，后者是"触发阶段"。理解这两阶段的边界，是理解整个 Skill 系统的关键——下一章的端到端全景图正是围绕这两个阶段展开的。

---

## 三、宏观全景：系统完整样貌

前两章我们知道了 Skill 解决什么问题、坐在哪一层。但要把整张图装进脑子，还需要一次端到端的俯瞰。本章先给一张全景图建立心智模型，再从链路、抽象、版图、注册、接口五个侧面逐个展开。

### 3.1 端到端全景链路

下图把 Skill 系统的两个阶段、三条触发路径、两条注入通道压缩在一张视图里。先不求读懂每个细节，只需记住：**左半是准备阶段（一次性建索引），右半是触发阶段（每轮匹配+注入）**，两者通过"TF-IDF 索引"这个数据结构衔接。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  Skill 系统端到端全景                                    │
└─────────────────────────────────────────────────────────────────────────┘

【准备阶段 · 一次性 / per-cwd 缓存】
  磁盘 .claude/skills/*/SKILL.md
        │  getCommands(cwd)                          src/commands.ts
        ▼
  所有 commands (type: tool | prompt | local | builtin | plugin)
        │  过滤 type==='prompt' && !disableModelInvocation
        ▼                                            localSearch.ts:298  getSkillIndex
  TF-IDF 向量索引 (lazy 构建, cached per cwd)
        │
        ├──►【描述通道】formatCommandsWithinBudget ──► System Prompt block
        │    (1% context window 预算;  prompt.ts:21 SKILL_BUDGET_CONTEXT_PERCENT
        │                             prompt.ts:79-180 截断策略)
        │
        └──►【全文通道】留在磁盘, 触发时才读取 SKILL.md 正文

【触发阶段 · 每轮增量】
  用户消息 / LLM tool_use / 每轮工具执行后
        │
        ├─[路径1 手动]── /skill-name ──────────────────────────┐
        ├─[路径2 模型]── SkillTool.call (SkillTool.ts:584) ───┤
        └─[路径3 系统]── searchSkills (TF-IDF 余弦相似度)      │
                          ├ score ≥ 0.30 自动加载 ────────────┤  prefetch.ts:308 turn-zero
                          └ score ∈ [0.10,0.30) 提示用户       │  prefetch.ts:249 inter-turn
                                                              ▼
                                          processPromptSlashCommand
                                                  │
                          ┌───────────────────────┴───────────────────┐
                          ▼                                           ▼
                   !`command` 预处理                          context:'fork' ?
                   变量替换(${CLAUDE_SESSION_ID})               ├ 是 → executeForkedSkill
                          │                                    │      → 子 Agent 执行
                          │                                    └ 否 → inline 注入
                          ▼                                           ▼
                   单条 user message                          主 / 子 Agent 上下文
                   注入对话历史
                          │
                          ▼
                   成为对话历史一部分 (autoCompact 压缩时可能被移除)
```

这张图藏着三个关键衔接点，后续各节会逐一拆解：(1) 磁盘文件如何变成 TF-IDF 向量（§4.1）；(2) 用户消息如何变成匹配分数（§4.2）；(3) 匹配成功后内容如何进入对话并随对话演化（§4.3–§4.4）。下面先跳出链路，看支撑这套流程的核心抽象。

### 3.2 核心抽象

Skill 系统的一切行为都建立在三个抽象之上，理解它们就理解了 Skill 的"形状"。

**抽象一：Skill = 目录 + SKILL.md**。Skill 不是一个函数或一个类，而是一个文件目录。目录里必须有一个 `SKILL.md`（指令主体），可选 `templates/`（模板文件）和 `scripts/`（辅助脚本）。这个抽象的意图是让 Skill 可独立分发、独立更新——它就是一个自包含的"指令包"，复制目录即完成安装。SKILL.md 的 frontmatter 声明 `name`、`description`、`whenToUse`、`allowedTools`、`context` 等元数据，正文是给 LLM 看的 prompt。

**抽象二：描述 / 全文二元性**。同一个 Skill 有两面：**描述面**（`description + whenToUse`，精简，常驻 System Prompt）和**全文面**（SKILL.md 正文，完整，按需注入）。这二元性是 Skill 区别于 CLAUDE.md 的本质——CLAUDE.md 是"描述即全文"，而 Skill 把两者分离，描述负责"被发现"，全文负责"被执行"。具体场景：用户装了 30 个 Skill，每个描述 ~200 字符共 6K 字符常驻 System Prompt（受 1% 预算约束），但任一时刻只有 1–2 个 Skill 的全文（可能各 5K tokens）真正注入对话。如果用 CLAUDE.md 方式，30 个 Skill 全文常驻会轻松突破 100K tokens。

**抽象三：两种"上下文"**。这个词在 Skill 系统里有两种含义，混用就会困惑：
- **System Prompt 上下文**：常驻，Skill 描述注入这里，受 1% 预算硬约束。
- **对话消息上下文**：动态，Skill 全文触发后作为单条 user message 加入，**Skill 加载 = Skill 内容变成消息 = 占用对话历史**。

预算控制、触发判断、压缩影响都在这两种上下文之间发生。§4.4 会沿这条线讲清楚生命周期。

### 3.3 版图分类

Skill 不是孤岛，它生存在一个工具生态里。下表把 Skill 与相邻机制放在同一坐标系，明确各自领地：

| 维度 | Skill | Slash Command | 子 Agent (AgentTool) | Hook |
|------|-------|---------------|---------|------|
| 类型字段 | `prompt` | `local` / `builtin` | `tool` | （事件驱动，非 command） |
| 执行位置 | 主 Agent 上下文（inline）或子 Agent（fork） | 系统直接执行 | 独立上下文 | Agent 外部 |
| Agent 感知 | 是（主动读到 Prompt） | 部分 | 是（被调用，看到结果） | 否（透明） |
| 上下文影响 | 占用主上下文（内容成为消息） | 不占用 | 不占用（仅结果回传） | 不占用 |
| 适用场景 | 引导行为（领域知识） | 系统行为（clear/help） | 隔离任务（探索、分析） | 强制约束（安全检查） |
| 触发方式 | 手动 + 自动 + 模型 | 用户手动 | 模型调用 AgentTool | 事件驱动 |

这个分类回答了一个常见困惑：**何时选 Skill 而不是别的？**
- 选 Skill 而非 CLAUDE.md：只在特定场景需要（TF-IDF 自动触发）、内容太大（> 5K tokens 常驻浪费）、内容变化频繁。
- 选 Skill 而非子 Agent：内容 &lt; 1000 tokens、不需要隔离、简单 prompt 模板。
- 选 Skill 而非 Hook：需要 LLM 主动决策（Hook 是被动的"条件 → 动作"）、内容需随上下文变化。
- 选 Skill 而非 Slash Command：需要被自动发现和模型调用（Slash Command 只能手动）。

### 3.4 注册机制

Skill 要被系统发现，必须先"注册"进 commands 列表。注册流程由 `getCommands(cwd)` 驱动（`src/commands.ts`），它扫描多个来源：bundled 内置 Skill、`.claude/skills/` 用户 Skill、插件提供的 Skill。所有来源合并成统一的 command 列表，每条带 `type` 字段区分种类。

注册的关键约束在过滤环节——不是所有 command 都能成为可搜索的 Skill。`getSkillIndex(cwd)`（`src/services/skillSearch/localSearch.ts:298`）做两道过滤：

1. `type === 'prompt'`——只保留 Skill，排除 slash command 和 tool。这呼应 §3.3 的版图分类：只有 `prompt` 类才允许被自动触发，避免 LLM 自动触发 `/clear` 这类系统命令。
2. `!disableModelInvocation`——尊重作者声明。Skill 作者可以通过 frontmatter 关掉"被模型自动调用"的权限，强制只能手动触发。这是一个"逃生口"，用于 Skill 内容敏感或成本高的场景。

注册结果会被 per-cwd 缓存（`cachedIndex` / `cachedCwd`），同一工作目录内多次搜索零成本，切换目录自动重建——因为不同目录的 `.claude/skills/` 内容不同。这个缓存策略的意图是平衡"启动开销"与"目录敏感性"，§4.1 会展开其 lazy 构建细节。

### 3.5 对外接口

Skill 系统对外暴露三套接口，对应三条触发路径，覆盖"谁知道要用 Skill"的三种情况：

| 接口 | 调用方 | 入口 | 适用场景 |
|------|--------|------|---------|
| Slash 命令 | 用户 | `/skill-name`（`src/commands.ts:656-666` 解析） | 用户明确知道要什么 |
| SkillTool | LLM | `SkillTool.call({skill, args})`（`SkillTool.ts:584`） | LLM 推理中自主判断需要 |
| 自动发现 | 系统 | `getTurnZeroSkillDiscovery` / `startSkillDiscoveryPrefetch`（`prefetch.ts:308` / `:249`） | 用户不熟悉 Skill 名字 |

三套接口互补：用户知道要什么时用 Slash（最准确）；LLM 在推理中判断需要用 SkillTool（最灵活）；都不主动时系统猜测用自动发现（最方便）。这就是"双模式触发"模式的核心——单一触发方式不够灵活，必须组合使用。§4.3 会沿这三条路径讲它们的协作与优先级。

> 小结：本章从全景图出发，拆出链路、抽象、版图、注册、接口五个侧面。现在你应该能在脑子里"放电影"：磁盘上的 SKILL.md → 被 getCommands 扫描注册 → 过滤成 prompt 类 → 建成 TF-IDF 索引 → 描述注入 System Prompt → 用户/LLM/系统三路触发 → 全文注入对话 → 随对话演化直至被压缩。下一章我们放慢镜头，沿这条链路的每个机制下沉到代码层面，看每一步具体怎么做、为什么这么做。

---

## 四、核心运行时细节

第三章给的是"地图"，本章给的是"行车手册"。我们沿一次 Skill 调用的生命周期展开：先建索引（§4.1），再匹配查询（§4.2），再触发执行（§4.3），再讲内容在对话里的生命周期（§4.4），最后补一个横切能力——动态注入（§4.5）。每个机制遵循"**为什么需要 → 怎么做 → 具体实例**"三段式，已熟悉原理的读者可跳过"具体实例"段。

### 4.1 索引构建：把 Skill 目录变成可搜索向量

**为什么需要**：每轮 turn 都可能要搜索 Skill，若每次都重新读磁盘、分词、算权重，几十个 Skill 的开销会累积。更重要的是，TF-IDF 的 IDF（逆文档频率）依赖"全语料统计"——必须先知道每个 term 在多少个 Skill 里出现，才能算它的区分度。这要求一次性扫完全部 Skill 再建索引，不能逐条查询时才算。因此需要一个"构建一次、多次查询"的索引结构。

**怎么做**：`getSkillIndex(cwd)`（`src/services/skillSearch/localSearch.ts:298-381`）分四步建索引，并做了三个关键设计选择。

```
getSkillIndex(cwd) (src/services/skillSearch/localSearch.ts:298)
  ├─► [cache hit] if cachedIndex && cachedCwd === cwd → 直接返回
  ├─► [cache miss]
  │     ├─► const { getCommands } = await import('../../commands.js')   ← lazy import
  │     ├─► const commands = await getCommands(cwd)
  │     ├─► filter: type === 'prompt' && !disableModelInvocation
  │     ├─► 对每个 Skill:
  │     │     ├─► nameTokens = tokenizeAndStem(name)
  │     │     ├─► nameParts  = splitHyphenatedName(name)   ← "code-review" → ["code","review"]
  │     │     ├─► descTokens = tokenizeAndStem(description)
  │     │     ├─► whenTokens = tokenizeAndStem(whenToUse)
  │     │     └─► computeWeightedTf([name, whenToUse, description, tools])
  │     └─► computeIdf(entries) → log(N / df[term])
  ├─► [mutate] 每个 entry.tfVector *= idf.get(term) → tf-idf 向量
  └─► [cache] cachedIndex=entries, cachedIdf=idf, cachedCwd=cwd
```

三个设计选择各有意图：

1. **Lazy import**：`getSkillIndex` 不在启动时跑。`--version`、`--help` 这类快速路径根本不搜索 Skill，不该付读 Skills 的代价。Lazy import 把开销推迟到第一次真正搜索时。意图：保护快速路径的延迟。
2. **就地修改 tfVector**：构建完 IDF 后直接 `entry.tfVector *= idf`，把 TF 向量变成 TF-IDF 向量。这破坏了纯函数性——同一个 `cmd` 第二次构建时如果 IDF 变了，结果也不同。但因为 cache 是 per-cwd 缓存，正常使用中不会触发。意图：避免再多开一个 map 的内存开销。
3. **缓存 per cwd**：用 `cachedCwd === cwd` 判断。切换工作目录后自动重建，因为不同目录的可用 Skill 可能不同（`.claude/skills/` 在子目录和父目录的内容不同）。意图：在缓存复用与目录敏感性之间取平衡。

描述侧的预算控制在另一处：`formatCommandsWithinBudget`（`prompt.ts:79-180`）把 Skill 列表格式化为可读的 Markdown（不是 JSON，是给 LLM 看的表格），并保证总字符数不超过 context window 的 1%（`prompt.ts:21` `SKILL_BUDGET_CONTEXT_PERCENT = 0.01`）。意图：常驻部分必须可控，否则 Skill 一多就挤压用户对话预算。如果 Skill 太多装不下，会按字段权重从高到低依次截断——name 和 whenToUse 优先保留，description 可能在最后被砍掉一部分。

**具体实例**：假设当前 cwd 下有 3 个 Skill（code-review / write-tests / deploy）。第一次用户发消息触发搜索时，`getSkillIndex` 执行 lazy import → 调 `getCommands` 拿到 3 条 prompt 命令 → 对每条分词加权 → 算 IDF → 就地乘 IDF → 写入 `cachedIndex`。整个过程一次性 ~50ms。之后这个会话里所有搜索都直接读 `cachedIndex`，零重建。若用户 `cd` 到另一个目录，`cachedCwd !== cwd`，索引自动重建。

### 4.2 查询匹配：TF-IDF 余弦相似度与 CJK 兜底

**为什么需要**：索引建好了，但"用户消息"和"Skill 描述"都是自然语言，没有结构化字段可直接相等比较。需要一个函数把"查询文本"和"每个 Skill"都投影到同一向量空间，再用距离衡量相似度。选 TF-IDF 而非 Embedding 的原因：Skill 数量小（&lt; 100）、纯本地计算无 API 延迟、可解释性强。代价是无法识别同义词（"review code" vs "audit code" 靠字面匹配）——这是有意识的取舍。

**怎么做**：匹配由 `searchSkills(query, index, limit=5)`（`src/services/skillSearch/localSearch.ts:383-443`）完成，内部分四层：字段加权 TF → IDF → 余弦相似度 → CJK/名称兜底。

**(a) 字段加权 TF**（`computeWeightedTf` at `localSearch.ts:212-228`）：

```typescript
const FIELD_WEIGHT = {
  name: 3.0,        // Skill 名字最重要
  whenToUse: 2.0,   // 触发条件次之
  description: 1.0, // 描述
  allowedTools: 0.3, // 工具约束最不重要
} as const

export function computeWeightedTf(
  fields: { tokens: string[]; weight: number }[],
): Map<string, number> {
  const weighted = new Map<string, number>()
  for (const field of fields) {
    const freq = new Map<string, number>()
    for (const t of field.tokens) freq.set(t, (freq.get(t) ?? 0) + 1)

    let max = 1
    for (const v of freq.values()) if (v > max) max = v

    for (const [term, count] of freq) {
      const val = (count / max) * field.weight
      const existing = weighted.get(term) ?? 0
      if (val > existing) weighted.set(term, val)   // ← max() 而非 sum()
    }
  }
  return weighted
}
```

两个常量的意图：
- **name=3.0 最高**：Skill 名字是 LLM 识别 Skill 的最直接线索——"code-review" 比它的 description "Review pull requests" 更能标识用途。whenToUse 排第二（"When the user wants to..." 这类短语面向查询场景，与用户意图同构），description 排第三（更详细的散文，噪声多），tools 排最末（"bash, read" 这类纯约束信息，几乎不承载语义）。
- **max() 而非 sum()**：避免跨字段重复 term 多次计入。"code-review" 的 name 已含 "code"，description 里又出现 "code" 时不该双倍。max() 保证每个 term 只取它出现过的最高字段权重，保持 name 的主导地位。

**(b) IDF**（`computeIdf` at `localSearch.ts:230-247`）：

```typescript
export function computeIdf(index: { tokens: string[] }[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const entry of index) {
    const seen = new Set<string>()  // 同一 entry 内 term 只算一次
    for (const t of entry.tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) ?? 0) + 1)
        seen.add(t)
      }
    }
  }
  const N = index.length
  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log(N / count))
  }
  return idf
}
```

核心思想"稀有词更有区分度"——term 在越少 Skill 中出现，区分能力越强，`log(N/df)` 中 df 越小 idf 越大。**为什么 `log(N/df)` 不加 1 平滑？** Skill 数量小（&lt; 100），df 差异大，平滑反而引入噪声。对短小语料，简单公式更稳。

**(c) 余弦相似度**（`cosineSimilarity` at `localSearch.ts:249-268`）：衡量两个向量的"方向一致性"。TF-IDF 场景下所有权重非负，score 范围 [0, 1]，越接近 1 越相关。

**(d) CJK 与名称兜底**（`localSearch.ts:406-420`）：

```typescript
if (queryCjkTokens.length > 0 && score > 0) {
  const matchingCjk = queryCjkTokens.filter(t => entry.tfVector.has(t))
  if (matchingCjk.length < CJK_MIN_BIGRAM_MATCHES) {  // 2
    const hasAsciiMatch = queryAsciiTokens.some(t => entry.tfVector.has(t))
    if (!hasAsciiMatch) score = 0
  }
}
if (entry.name.length >= NAME_MATCH_MIN_LENGTH) {  // 4
  if (queryLower.includes(entry.normalizedName)) {
    score = Math.max(score, 0.75)
  }
}
```

- **CJK_MIN_BIGRAM_MATCHES = 2**：若 query 含 CJK bigram，entry 必须匹配 ≥ 2 个 bigram **或**至少 1 个 ASCII token，否则 score 清零。意图：bigram 切分会产生大量重叠 token（"中文代码" 切成 "中文""文代""代码"），单 bigram 匹配噪声极大——"代码" 单 bigram 会误匹配所有含 "代" 的 skill。要求 ≥ 2 个把噪声过滤掉。
- **NAME_MATCH_MIN_LENGTH = 4 + score 0.75**：用户消息直接包含 Skill 名字时，给 0.75 兜底分（高于 AUTO_LOAD 阈值 0.30）。意图：名字精确包含是最强信号，即便 TF-IDF 向量因分词细节没算出高分，也不该漏掉。
- **两个阈值**：`AUTO_LOAD_MIN_SCORE = 0.30`（≥ 自动加载）、`DISPLAY_MIN_SCORE = 0.10`（≥ 在 UI 提示用户）。意图：0.30 是"系统有把握"的分界线，0.10 是"值得一提示"的分界线，中间地带交给用户决策。两者都可通过环境变量 `SKILL_SEARCH_AUTOLOAD_MIN_SCORE` / `SKILL_SEARCH_DISPLAY_MIN_SCORE` 覆盖，方便实验调优。

CJK 还有一条"翻译 fallback"：`normalizeQueryIntent` 调用 Haiku 把中文 query 翻译为英文关键词，英文搜索天然命中率高。但只有 turn-zero 阻塞路径才付得起这个 latency（见 §4.3）。

分词与词干化是匹配的前置步骤：`tokenize`（`localSearch.ts:151-182`）对 CJK 按 bigram 切、对英文按 `[a-z0-9\-_]+` 切并去停用词；`stem`（`localSearch.ts:184-198`）是简化版 Porter stemmer，处理 ing/tion/ness/ment 等常见后缀（带 `length > 5` 保护，避免 "is"/"as" 被误切），CJK 直接返回原词（中文没有词形变化）。

**具体实例**：3 个 Skill——A:code-review / B:write-tests / C:deploy。索引构建后（N=3）：

| term | df | idf = log(3/df) |
|------|-----|---------|
| code | 2 | log(1.5) ≈ 0.405 |
| review | 1 | log(3) ≈ 1.099 |
| test | 2 | log(1.5) ≈ 0.405 |
| write | 2 | log(1.5) ≈ 0.405 |
| deploy | 1 | log(3) ≈ 1.099 |

用户查询 "review this code" → tokens: ["review", "code"]，`queryTfIdf: { review: 1.099, code: 0.405 }`。

```
cosineSimilarity(queryTfIdf, entryA.tfVector) ≈ 0.95  ← 高匹配，自动加载
cosineSimilarity(queryTfIdf, entryB.tfVector) ≈ 0.30  ← 只有 code 重叠，临界值
```

注意 "review" 的 IDF（1.099）远高于 "code"（0.405）——"review" 只出现在 Skill A 中，区分度极高；"code" 在 A 和 B 都出现，区分度低。最终 A 的 score 接近 1.0，B 只有 0.3。这正是字段加权 + IDF 组合的效果：稀有词把最相关的 Skill 顶到最前。

### 4.3 触发与执行：三条路径如何协作

**为什么需要**：§3.5 已展示三条触发路径，但它们不是各自为政——必须明确优先级与协作关系，否则三条路径同时命中同一个 Skill 会重复加载、或互相抢夺触发权。需要一个调度逻辑决定"谁先、谁后、谁让位"。

**怎么做**：三条路径的优先级如下：

| 方式 | 触发者 | 触发条件 | 证据 |
|------|--------|---------|------|
| 用户调用 | 用户 | 输入 `/skill-name` | `SkillTool.ts:584` |
| 模型自动 (tool_use) | LLM | SkillTool 作为 tool 被调用 | `SkillTool.ts:584` |
| Turn-zero 发现 | 系统 | 用户首条消息触发 TF-IDF | `prefetch.ts:308` |
| Inter-turn 发现 | 系统 | 每轮工具执行后触发 | `prefetch.ts:249` |
| Slash 命令匹配 | 用户/LLM | `/skill-name` 解析 | `src/commands.ts:656-666` |

优先级排序与协作逻辑：

1. **明确 `/skill-name`** 最优先——用户主动，直接匹配命令名，即使 TF-IDF 评分低也执行。
2. **LLM tool_use** 次之——LLM 在思考后通过 `SkillTool.call` 调用。这与自动 prefetch 形成补充：LLM 可基于自己的判断加载 Skill，即使系统没匹配到。
3. **系统自动 prefetch** 最低——系统猜测 LLM 可能需要，自动加载。最低优先级但最及时。

系统自动发现又分两个子路径，设计权衡不同：

- **turn-zero 阻塞路径**（`getTurnZeroSkillDiscovery` at `prefetch.ts:308`）：必须在 Agent 第一轮 LLM 调用前完成。阻塞带来两个特权：(1) 可调用 Haiku 翻译中文 query（额外 latency 可接受）；(2) 自动加载的 Skill 内容进入第一轮对话视野。代价是用户首条消息的响应延迟增加。
- **inter-turn 非阻塞路径**（`startSkillDiscoveryPrefetch` at `prefetch.ts:249`）：每轮工具执行后 fire-and-forget，调用方在合适时机（如阶段 5 收割 prefetch）`await`。不能调 Haiku 翻译（latency 不可接受），所以 CJK query 匹配度更差。收益是不阻塞主循环。

`SkillTool` 在 `getTools()`（`src/tools.ts`）中注册为 LLM 可调用的工具，其描述随 System Prompt 注入让 LLM 知道"有这个工具可用"。当 LLM 决定调用某 Skill 时，执行环节由 `SkillTool.call({skill, args})`（`SkillTool.ts`）统一承接，分三条分支：

```
SkillTool.call({skill, args})
  ├─► 远程 Skill 路径 (ant-only experimental, remote URL)
  ├─► Forked Skill 路径 (command.context === 'fork')
  │     └─► executeForkedSkill() → runAgent() 子 Agent
  │           └─► Skill 内容在子 Agent 上下文, 结果回传主 Agent
  └─► Inline Skill 路径 (默认)
        └─► processPromptSlashCommand() → Skill 内容注入为 user message
```

Forked vs Inline 的选择本质是"上下文隔离 vs 透明度"的权衡：
- **Forked**（`context: 'fork'`）：长 Skill 内容（> 5K tokens）不污染主上下文、内部多轮思考不暴露给用户、可独立计费。代价是子进程 IPC 延迟。
- **Inline**（默认）：零额外延迟、主 Agent 可见所有中间状态（调试友好）、用户可见 Skill prompt（透明）。代价是占用主上下文。

选择应基于 Skill 内容大小和是否需要隔离，而不是默认选一个。这一权衡在 §7 模式 4 会进一步提炼。

**具体实例**：用户在中文环境输入"帮我审查这段代码的代码审查规范"。turn-zero 路径阻塞执行：`extractQueryFromMessages` 提取意图 → `normalizeQueryIntent` 检测到 CJK 字符 → 调 Haiku 翻译为 "code review" → `searchSkills("code review", index)` → code-review Skill score ≈ 0.95 ≥ 0.30 → 自动加载，其 SKILL.md 全文作为 attachment 注入第一轮对话。同时 LLM 在推理中也可能自主调 `SkillTool.call({skill: "code-review"})`——但若 turn-zero 已加载，去重逻辑（`discoveredThisSession.has(name)`）会避免重复注入。三条路径在此协作：系统先猜中、LLM 后确认、用户全程无感。

### 4.4 上下文生命周期：描述常驻与全文注入

**为什么需要**：Skill 不是"调用一次就结束"的函数，它的内容一旦注入对话就成了对话历史的一部分，会随后续压缩、跨轮引用、会话存档而演化。不理解这个生命周期，就会误以为"改了 SKILL.md 立刻生效"或"Skill 加载不占 token"。需要一张时序图说清两种上下文的命运。

**怎么做**：先重申 §3.2 的两种上下文，它们的生命周期完全不同：

```
会话开始
  │
  ├─► Skill 索引构建 (lazy, on first search)
  │     └─► Skill 描述按 budget 注入 System Prompt block   ← 描述侧：常驻
  │
  ├─► 用户发首条消息
  │     ├─► turn-zero: getTurnZeroSkillDiscovery()
  │     │     ├─► normalizeQueryIntent (Haiku 翻译, feature-gated)
  │     │     ├─► searchSkills(query, index)
  │     │     ├─► score >= 0.30 → Skill 内容作为 attachment 注入对话  ← 全文侧：触发注入
  │     │     └─► score in [0.10, 0.30) → UI 提示用户手动触发
  │     └─► 对话开始, Agent 用 Skill 内容工作
  │
  ├─► 每轮循环 (inter-turn prefetch)
  │     └─► startSkillDiscoveryPrefetch(input, messages, context)
  │           ├─► extractQueryFromMessages 获取当前上下文摘要
  │           ├─► searchSkills(query)
  │           └─► 新发现的 Skill 作为附件注入
  │
  ├─► 会话中
  │     └─► Skill 已加载的部分成为对话历史一部分
  │           │  即使 SKILL.md 文件被修改, 注入的消息不变  ← 全文已"冻结"为消息
  │           └─► 需要重载: 用户必须重新触发 skill
  │
  ├─► 上下文压缩 (autoCompact)
  │     └─► Skill 注入的消息可能被压缩算法移除
  │           │  autoCompact 不智能判断 "Skill 是否仍重要"
  │           └─► 若 Skill 仍相关, LLM 需重新触发
  │
  └─► 会话结束
        └─► Skill 内容随对话历史存档到 transcript (本地磁盘)
              └─► 不主动清理
```

两种上下文的对比是理解 Skill 系统最重要的概念：

| 维度 | Skill 描述（注入 System Prompt） | Skill 全文（注入对话） |
|------|----------------------------------|------------------------|
| 字段 | description + whenToUse | SKILL.md 完整正文 |
| Token 预算 | 1% context window | 无限制（信任作者） |
| 触发条件 | 始终存在 | TF-IDF score ≥ 0.30 或 manual |
| Cache 影响 | 触发 cache_creation | 加入 messages 后增量 |
| 修改即时性 | 启动时读一次 | 不重读（除非重新触发） |

**关键差异**：描述改了几乎不影响（启动时读），内容改了必须重新触发才生效。很多误解来源于把两者混为一谈——描述的预算是硬约束（`SKILL_BUDGET_CONTEXT_PERCENT = 0.01`），全文没有预算（信任作者）。修改 SKILL.md 后，会话中的 LLM 看不到新内容，因为全文已在加载时被冻结成 user message。

**具体实例**：用户会话中途编辑了 code-review 的 SKILL.md，加了一条新规范"检查错误处理"。此刻已注入对话的 Skill 内容不会更新——LLM 仍按旧版本工作。要让新规范生效，用户必须重新触发该 Skill（如再次 `/code-review`），让新内容作为新消息注入。另一个场景：会话很长触发 autoCompact，早期注入的 Skill 消息可能被压缩算法摘要掉，LLM"忘了"自己加载过 Skill——此时若任务仍需 Skill，LLM 得通过 inter-turn prefetch 或自主 tool_use 重新加载。

### 4.5 动态注入：`!`command`` 预处理

**为什么需要**：Skill 本质是静态 Prompt——SKILL.md 写什么，注入就是什么。但很多领域指令需要嵌入实时数据，如"当前 git 状态""最近 5 个 commit"。若没有动态能力，用户每次触发 Skill 都得自己手动粘贴这些数据，违背"模块化封装"的初衷。需要一个机制让 Skill 模板在加载时拉取实时数据，同时不破坏 Skill 的"幂等"特性（同一 Skill 在不同时间触发的上下文不同，但模板结构是确定的）。

**怎么做**：`!`command`` 语法在 Skill 内容发送给 Claude 之前（`processPromptSlashCommand` 阶段）预处理：命令立即执行 → 输出替换占位符 → Claude 收到实际数据。同时替换 `${CLAUDE_SESSION_ID}` 等变量。

```
# SKILL.md
当前 Git 状态：
!`git status --short`

最近 5 个 commit：
!`git log --oneline -n 5`

请基于以上状态帮用户处理任务。
```

处理后传给 Claude 的实际内容：

```
当前 Git 状态：
M  src/foo.ts
A  src/bar.ts

最近 5 个 commit：
a1b2c3d  feat: add baz
e4f5g6h  fix: qux
...

请基于以上状态帮用户处理任务。
```

这是 Skill 与 CLAUDE.md 的关键差异：CLAUDE.md 完全静态（每次加载都是磁盘原文），Skill 可通过 `!`command`` 在加载时注入实时数据，把 Skill 从纯静态 Prompt 升级为"模板 + 动态数据"的混合体。

**安全风险**：执行任意命令有注入风险，当前实现没有 sandbox——用户在 SKILL.md 里写 `!`rm -rf /`` 会被认真执行。因此该机制只适用于受信 Skill 来源。这是一个"灵活性换安全"的取舍，§6 会列入边界局限。

**具体实例**：一个 k8s-debug Skill 模板里写 `!`kubectl get pods --namespace=prod``，每次触发都拉取当前生产环境 pod 列表注入对话。LLM 拿到的是实时状态而非静态示例，debug 建议才有效。代价是命令执行有副作用风险，作者必须谨慎选择只读命令。

> 小结：本章沿"建索引 → 匹配查询 → 触发执行 → 内容生命周期 → 动态注入"的生命周期走完了一遍 Skill 的运行时。每个机制都是"为什么需要 → 怎么做 → 具体实例"三段式。下一章我们退一步，把这些机制背后的设计决策汇成一张权衡表，看每个选择放弃了什么、为什么这样选。

---

## 五、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 触发方式 | 手动 + 自动（TF-IDF）+ LLM tool_use | 纯手动或纯自动 | 三种触发方式覆盖不同场景：用户知道要什么（手动）、系统猜测（自动）、LLM 自主判断（模型） |
| 上下文策略 | 单条 user message 注入 + System Prompt 描述常驻 | System Prompt 常驻全文 | Skill 是"临时指令"，用完应释放上下文；System Prompt 常驻全文会持续消耗 token |
| 索引结构 | 字段加权 TF (name=3.0, whenToUse=2.0, desc=1.0, tools=0.3) | 简单 TF | name 比 description 更能标识 Skill 用途；whenToUse 比 description 更面向查询 |
| 字段聚合 | max() 而非 sum() | sum() | 避免跨字段重复 term 多次计入 |
| Tokenization | Porter-like stemmer + CJK bigram | 外部 NLP 库 | Skills 数量 &lt; 100，复杂 NLP 收益低；自己实现可控制 |
| IDF 平滑 | 不平滑 (log(N/df)) | 加 1 平滑 | 小语料 + df 差异大，平滑反而干扰 |
| CJK 处理 | bigram + 必须 ≥ 2 匹配 OR 1 ASCII 匹配 | 整句翻译 | 翻译准确但慢，bigram 简单快速 |
| Turn-zero 翻译 | Haiku 调用 (feature-gated) | 不翻译 | turn-zero 阻塞路径，能付得起 Haiku latency；其他路径不调用 |
| 索引缓存 | 进程内 (cachedIndex, cachedCwd) | 磁盘 / Embedding DB | Skills 数量小，索引构建 &lt; 50ms，缓存收益有限 |
| 预算限制 | 1% context window 字符 (SKILL_BUDGET_CONTEXT_PERCENT=0.01) | token 预算 | 字符预算更简单，避免 tokenizer 依赖 |
| 描述截断 | MAX_LISTING_DESC_CHARS = 1536 字符 | 不截断 | 避免单个 Skill 吞掉整个预算 |
| Slash 命令 vs Skill 区分 | type: 'prompt'/'local'/'builtin'/'tool' | 同一 type | 三种类型明确分边，LLM 决策不模糊 |
| Forked vs Inline | 可选 fork (context: 'fork') | 强制一种 | 复杂 Skill 需要隔离，简单 Skill inline 更轻量 |
| 预处理语法 | !`command` | 无 | Skill 是静态模板，动态数据必须靠预处理插入 |

### 为什么索引按需构建而不是启动时构建？

```typescript
export async function getSkillIndex(cwd: string): Promise<SkillIndexEntry[]> {
  if (cachedIndex && cachedCwd === cwd) return cachedIndex

  const { getCommands } = await import('../../commands.js')  // lazy import
  const commands = await getCommands(cwd)
  // ...
}
```

**原因**：`getSkillIndex` 在 turn-zero / inter-turn 时调用，不一定启动时调用。Lazy import 让 `--version` 之类的快速路径不付出读 Skills 的代价。这是"按需付费"原则——只有真正用到的功能才付开销。

### 为什么不缓存 IDF by 命令？

每个命令的 `tfVector` 都被 `* idf` 原地修改（`localSearch.ts:368-371`）：

```typescript
for (const entry of entries) {
  for (const [term, tf] of entry.tfVector) {
    entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
  }
}
```

**这破坏了纯函数性**——同一个 `cmd` 两次构建的 tf-idf 不同。第一次构建后缓存的是 tf-idf 值，下次虽然仍是这个 cmd，但语义不变（同样的 input 同样的 output），只是不能再用裸 TF 重新加权。如果想改 IDF 算法（比如加平滑），需要重新构建 cache，已经通过 `clearSkillIndexCache()` 提供手动 invalidate。取舍意图：省一个 map 的内存，代价是失去"TF 与 IDF 可独立缓存"的灵活性——在当前小语料场景下值得。

---

## 六、可复用的模式

### 1. Prompt 模块化模式

**问题**：领域指令需要"按需用、用完释放"。

**方案**：把领域指令封装为可触发的模块（目录 + SKILL.md），描述常驻 System Prompt（精简版），完整内容按需注入。

**模板**：
```
Skill/
├── SKILL.md         ← 指令主体 (user-triggered 才会 load)
├── templates/       ← 模板文件 (可选)
└── scripts/         ← 辅助脚本 (可选)
```

**优势**：
- 模块化：每个 Skill 一个目录，独立更新
- 可发现性：描述常驻，LLM 知道有哪些 Skill 可用
- 节省 token：常用 Skill 的描述（~200 chars）一直有用，全文按需加载

### 2. 双模式触发模式（手动 + 自动 + 模型）

**问题**：单一触发方式不够灵活。

**方案**：同时支持
- 手动调用（`/skill-name`）
- 系统自动（TF-IDF 搜索 + LLM tool_use）
- 模型决策（LLM 通过 SkillTool.tool_use 调用）

**为什么需要三种**：
- 手动：用户明确知道要什么
- 系统自动：用户不熟悉 Skill 名字时
- 模型：LLM 在推理中自主判断需要

### 3. 预处理注入模式（!`command`）

**问题**：静态 Skill Prompt 无法包含动态信息。

**方案**：`!`command`` 语法在内容发送前执行命令获取实时数据，结果替换占位符。

```
当前 Git 状态：!`git status --short`
```

**注意**：没有 sandbox——只适用于受信 Skill 来源。

### 4. Fork/Inline 双模式

**问题**：有些 Skill 简单到不值得启子进程，有些 Skill 太长需要隔离。

**方案**：`context: 'fork'` 字段控制是 fork 到子 Agent 还是 inline 注入。SKILL.md frontmatter 不声明 context 时默认 inline。

**何时 fork**：
- Skill 内容 > 5K tokens
- Skill 内部的迭代思考不应暴露给用户

### 5. 字段加权 TF-IDF（names > whenToUse > description）

**问题**：平铺 TF（所有字段权重一样）让 Skill 的核心标识（name）不能脱颖而出。

**方案**：按字段重要性加权，tf-idf 计算前先聚合。name=3.0 表示"Skill 名字里的 token 比 description 里同样 token 重要 3 倍"。

**优势**：
- code-review 名字里的 "review" 比 description 里偶然出现的 "review" 更能标识 Skill
- whenToUse（"When the user wants to..."）面向查询场景，权重高于 description

### 6. Lazy 索引构建（on first search）

**问题**：启动时构建索引浪费（--version 等快速路径不需要）。

**方案**：用 lazy import + 内存 cache 让索引只在第一次搜索时构建，缓存 per cwd。

```typescript
if (cachedIndex && cachedCwd === cwd) return cachedIndex
const { getCommands } = await import('../../commands.js')  // dynamic
// ... build ...
cachedIndex = entries
```

**优势**：
- 启动延迟不受 Skill 数量影响
- 同 cwd 内多次搜索零成本
- 切换 cwd 后自动重建

