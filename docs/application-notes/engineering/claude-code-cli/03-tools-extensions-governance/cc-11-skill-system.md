---
slug: /application-notes/engineering/claude-code-cli/cc-11-skill-system
sidebar_position: 11
title: "Skill 发现、加载与执行系统"
description: "拆解 Skill 从 Command 注册、元数据搜索、权限检查到正文注入的完整链路，并区分 inline、fork 和 MCP 远程 Skill。"
---

> Skill 不是一段永远塞在 system prompt 里的长说明，而是“短描述用于发现，完整正文按需加载”的领域指令模块。
>
> **Harness 层定位**：Skill 位于上下文组装层，把领域流程从常驻提示词中拆出来，再通过 `Skill` 工具接入 Agent Loop。

# Skill 发现、加载与执行系统

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变动，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **Command 注册**：`src/commands.ts` 的 `getSkills()`、`getCommands()`、`getSkillToolCommands()` 和 `getSlashCommandToolSkills()` —— 把 bundled、磁盘、插件和内置命令统一整理成 `Command`。
> - **Skill 文件解析**：`src/skills/loadSkillsDir.ts` 的 `parseSkillFrontmatterFields()`、`createSkillCommand()` 和目录加载函数 —— 解析 `SKILL.md` 的 frontmatter（文件头元数据），并生成 `type: 'prompt'` 的命令对象。
> - **本地搜索**：`src/services/skillSearch/localSearch.ts` 的 `getSkillIndex()`、`searchSkills()`、`tokenize()`、`computeWeightedTf()` 和 `cosineSimilarity()` —— 建立缓存索引，使用字段加权的 TF-IDF（词频-逆文档频率）匹配 Skill。
> - **自动发现**：`src/services/skillSearch/prefetch.ts` 的 `startSkillDiscoveryPrefetch()`、`getTurnZeroSkillDiscovery()`、`extractQueryFromMessages()` 和 `enrichResultsForAutoLoad()` —— 区分首轮阻塞发现与轮间异步发现。
> - **跨语言查询**：`src/services/skillSearch/intentNormalize.ts` 的 `normalizeQueryIntent()` —— 仅在满足条件的首轮路径中调用 Haiku，把中文查询补充为英文关键词。
> - **描述预算**：`packages/builtin-tools/src/tools/SkillTool/prompt.ts` 的 `formatCommandsWithinBudget()` —— 控制常驻 Skill 列表的字符预算和单条描述长度。
> - **Skill 工具执行**：`packages/builtin-tools/src/tools/SkillTool/SkillTool.ts` 的 `validateInput()`、`checkPermissions()` 和 `call()` —— 校验 Skill 是否存在、检查权限，再选择远程、fork 或 inline 执行路径。
> - **来源与安全**：`src/skills/bundledSkills.ts` 的 `extractBundledSkillFiles()` / `safeWriteFile()`、`src/skills/loadSkillsDir.ts` 的 `createSkillCommand()`、`src/skills/mcpSkills.ts` 的 `fetchMcpSkillsForClient()` —— 处理内置、磁盘和 MCP `skill://` 技能来源。
> - **上下文落点**：`src/utils/attachments.ts` 生成 `skill_listing`、`skill_discovery` 和 `invoked_skills` 附件，`src/utils/messages.ts` 渲染 `invoked_skills`，再结合 `src/query.ts` 收集发现附件 —— 区分 Skill 描述、发现结果和完整正文。

## 一、先回答：Skill 到底是什么

Skill 可以理解成一份带元数据的领域工作流说明。

它通常由一个目录和 `SKILL.md` 组成：

```text
.claude/skills/review-pr/
└── SKILL.md
```

`SKILL.md` 中通常包含两部分：

```markdown
---
name: review-pr
description: Review a pull request for correctness and maintainability.
when_to_use: Use when the user asks to review a pull request.
allowed-tools: Read, Grep, Bash
context: inline
---

# Review Pull Request

这里是完整的审查步骤、检查项和输出格式。
```

需要先区分三个概念：

```text
Skill 文件
  领域知识和执行流程的原始载体

Command
  系统内部统一表示“可调用提示词命令”的对象

Skill 工具
  模型调用 `Skill` 时使用的执行适配器
```

因此，Skill 本身不是普通函数，也不是只有一段静态 Prompt。它要经过：

```text
SKILL.md
  → frontmatter 解析
  → Command 注册
  → 描述索引和搜索
  → Skill 工具权限检查
  → 正文注入或 fork 执行
```

### 1.1 Skill 和其他机制的边界

**Skill 与 CLAUDE.md：**

```text
CLAUDE.md
  永远成立的项目规则，适合常驻

Skill
  只在特定任务中成立的领域流程，适合按需加载
```

把所有审查规范、发布流程和排障步骤都塞进 CLAUDE.md，会让每轮请求都携带大量当前用不到的内容。

**Skill 与 Tool（工具）：**

```text
Tool
  直接执行外部动作，例如读文件、编辑文件、执行命令

Skill
  指导模型如何完成一类任务，必要时再调用工具
```

Skill 可以声明 `allowed-tools`，但这只是在执行 Skill 期间提供工具许可信息，不会把 Skill 变成一个新的底层工具。

**Skill 与 Hook（钩子）：**

```text
Skill
  模型主动或系统发现后加载的领域流程

Hook
  在工具或生命周期事件发生时自动执行的拦截逻辑
```

Hook 更适合不可绕过的安全和格式检查；Skill 更适合需要模型理解并遵循的工作步骤。

**Skill 与子 Agent：**

```text
inline
  把 Skill 正文注入主 Agent 上下文

fork
  创建隔离的子 Agent 上下文，主 Agent 只接收结果
```

不是“内容长就一定 fork”。真正的选择取决于 Skill 是否需要独立工具权限、独立推理过程和上下文隔离。

## 二、Skill 在上下文组装层的位置

Skill 解决的是“哪些领域指令应该进入当前模型视野”。

```text
用户输入
  ↓
Skill 描述列表
  ↓
本地搜索 / 用户显式调用 / 自动发现
  ↓
SkillTool
  ↓
完整 Skill 正文
  ↓
主上下文或 fork 上下文
  ↓
模型继续调用工具或输出答案
```

这里存在两个不同的上下文对象：

```text
描述上下文
  只放 Skill 名称和简短说明
  目的是让模型知道“有哪些 Skill 可以选”

执行上下文
  放被触发 Skill 的完整正文、参数和必要目录信息
  目的是让模型真正按照流程工作
```

如果把完整正文全部放到描述上下文，发现成本会变成常驻成本；如果只在执行时才告诉模型 Skill 名称，模型又无法主动发现它。

### 2.1 一次 Skill 使用的全景图

```text
┌────────────────────────────────────────────────────────┐
│ 1. 来源层                                               │
│    bundled / .claude/skills / plugin / MCP skill://      │
└──────────────────────┬─────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────────┐
│ 2. 注册层                                               │
│    parse frontmatter → createSkillCommand()             │
│    → Command { type: 'prompt', ... }                     │
└──────────────────────┬─────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────────┐
│ 3. 发现层                                               │
│    skill_listing → TF-IDF / CJK bigram / turn-zero       │
│    → Skill discovery attachment                         │
└──────────────────────┬─────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────────┐
│ 4. 执行层                                               │
│    SkillTool.validateInput()                            │
│    → 权限 → remote / fork / inline                      │
└──────────────────────┬─────────────────────────────────┘
                       ↓
┌────────────────────────────────────────────────────────┐
│ 5. 注入层                                               │
│    参数替换 → shell 预处理 → 完整正文                   │
│    → 主上下文 user message 或子 Agent 上下文             │
└────────────────────────────────────────────────────────┘
```

前两层回答“Skill 是否存在”；第三层回答“当前任务是否应该推荐”；后两层回答“这次调用如何执行”。

## 三、注册层：不同来源如何统一成 `Command`

### 3.1 `getCommands()` 是统一入口

`src/commands.ts` 的 `getSkills()` 会分别加载：

- Skill 目录中的技能；
- 插件提供的 Skill；
- bundled Skill（内置技能）；
- 内置插件 Skill。

随后 `loadAllCommands()` 还会合并工作流命令、插件命令和内置命令，最后由 `getCommands()` 处理可用性和启用状态。

```typescript
// src/commands.ts：把多个来源合并成统一命令列表
const [
  { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
  pluginCommands,
  workflowCommands,
] = await Promise.all([
  getSkills(cwd),
  getPluginCommands(),
  getWorkflowCommands ? getWorkflowCommands(cwd) : Promise.resolve([]),
])

return [
  ...bundledSkills,
  ...builtinPluginSkills,
  ...skillDirCommands,
  ...(workflowCommands as Command[]),
  ...(pluginCommands as Command[]),
  ...pluginSkills,
  ...COMMANDS(),
]
```

`getCommands()` 不是简单缓存一个数组。命令加载本身会 memoize（记忆化缓存），但 `meetsAvailabilityRequirement()` 和 `isCommandEnabled()` 每次仍会重新判断，以便登录状态、模型服务商和功能开关变化后及时生效。

### 3.2 `Command` 如何区分 Skill 和系统命令

Skill 被表示成 `type: 'prompt'` 的 `Command`。

```typescript
// src/skills/loadSkillsDir.ts：Skill 统一生成 prompt 类型的 Command
return {
  type: 'prompt',
  name: skillName,
  description,
  whenToUse,
  allowedTools,
  disableModelInvocation,
  userInvocable,
  context: executionContext,
  model,
  effort,
  source,
  loadedFrom,
  skillRoot: baseDir,
  async getPromptForCommand(args, toolUseContext) {
    // 具体正文会在调用时再生成
    return [{ type: 'text', text: finalContent }]
  },
}
```

这个类型分边很重要：

```text
type: 'prompt'
  可以作为模型可调用的 Skill 或 Prompt 命令

type: 'local' / 'local-jsx' / 其他类型
  由本地 CLI 直接处理，不应被 Skill 搜索当成领域 Skill
```

### 3.3 `getSkillToolCommands()` 负责模型可见的 Skill 集合

不是所有 `Command` 都会进入 Skill 工具描述列表。

`getSkillToolCommands()` 会过滤：

- 非 `prompt` 类型；
- `disableModelInvocation` 为真的命令；
- `source === 'builtin'` 的系统命令；
- 没有足够描述信息的部分插件或 MCP 命令。

```typescript
// src/commands.ts：只向 Skill 工具暴露可被模型调用的 prompt 命令
return allCommands.filter(
  cmd =>
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&
    cmd.source !== 'builtin' &&
    (
      cmd.loadedFrom === 'bundled' ||
      cmd.loadedFrom === 'skills' ||
      cmd.hasUserSpecifiedDescription ||
      cmd.whenToUse
    ),
)
```

这解释了一个常见现象：

```text
磁盘上存在 SKILL.md
  ≠
模型一定能在 Skill 列表中看到它
```

如果 Skill 设置了 `disable-model-invocation: true`，它可以保留用户手动调用能力，但不会出现在模型自动选择路径中。

### 3.4 `SKILL.md` 的 frontmatter 是控制面

`parseSkillFrontmatterFields()` 会把文件头字段转换成统一属性。

| 字段 | 作用 |
| --- | --- |
| `name` | Skill 的调用名称 |
| `description` | Skill 的简短说明 |
| `when_to_use` | 适合触发的场景，搜索时权重高于普通描述 |
| `allowed-tools` | Skill 执行期间可使用的工具规则 |
| `disable-model-invocation` | 是否禁止模型自动调用 |
| `user-invocable` | 是否允许用户通过斜杠命令调用 |
| `context: fork` | 是否放到隔离的子 Agent 上下文 |
| `agent` | fork 路径使用的 Agent 类型 |
| `model` / `effort` | Skill 的模型或推理投入覆盖 |
| `hooks` | Skill 关联的生命周期钩子 |
| `shell` | Skill 内联命令的 shell 设置 |

这些字段不是普通注释，而是后续搜索、权限和执行路径的输入。

## 四、描述层：为什么 Skill 列表和全文必须分开

### 4.1 `formatCommandsWithinBudget()` 只格式化发现信息

Skill 工具的 Prompt 会告诉模型：

```text
当前有哪些 Skill
每个 Skill 适合做什么
如何通过 Skill 工具调用
```

它不会把每个 Skill 的完整 `SKILL.md` 都放进去。

`formatCommandsWithinBudget()` 使用字符预算控制列表大小：

```typescript
// packages/builtin-tools/src/tools/SkillTool/prompt.ts
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000
export const MAX_LISTING_DESC_CHARS = 1536

export function getCharBudget(
  contextWindowTokens?: number,
): number {
  if (contextWindowTokens) {
    // 描述列表最多使用上下文窗口约 1% 的字符预算
    return Math.floor(
      contextWindowTokens *
        CHARS_PER_TOKEN *
        SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  return DEFAULT_CHAR_BUDGET
}
```

它的处理顺序是：

```text
完整描述总大小没有超预算
  → 全部保留

超预算
  → bundled Skill 的描述优先保留
  → 其他 Skill 统一压缩描述

预算极端不足
  → 非 bundled Skill 只保留名称
```

单条描述还有 1536 字符上限，避免一个 Skill 的 `when_to_use` 描述吞掉整个列表预算。

这层解决的是“模型知道有哪些能力”，不是“模型已经加载了完整流程”。

### 4.2 Skill 列表不等于 Skill 正文

可以把一次 Skill 的上下文分成三种消息：

```text
skill_listing
  Skill 工具的可发现列表

skill_discovery
  自动搜索命中的 Skill 及其发现结果

invoked_skills
  已经真正加载过的 Skill，用于状态和压缩恢复
```

`skill_listing` 里只有描述；`skill_discovery` 可能包含自动加载的有限正文；显式调用 Skill 时，完整正文由 `getPromptForCommand()` 产生。

如果把这三种消息都叫成“Skill 注入”，读者就很难判断哪一段内容真的会占用主上下文。

## 五、搜索层：TF-IDF 如何找到合适的 Skill

### 5.1 索引是按需建立并按工作目录缓存的

`getSkillIndex(cwd)` 首次调用时加载 `getCommands(cwd)`，只索引：

```text
type === 'prompt'
且
disableModelInvocation !== true
```

它不会把完整 Skill 正文放进索引，只保存：

- 名称；
- 描述；
- `whenToUse`；
- `allowedTools`；
- 来源和目录；
- 内容长度；
- token 列表和 TF-IDF 向量。

```typescript
// src/services/skillSearch/localSearch.ts
export async function getSkillIndex(
  cwd: string,
): Promise<SkillIndexEntry[]> {
  if (cachedIndex && cachedCwd === cwd) {
    return cachedIndex
  }

  const { getCommands } = await import('../../commands.js')
  const commands = await getCommands(cwd)

  const entries: SkillIndexEntry[] = []
  for (const cmd of commands) {
    if ((cmd as Record<string, unknown>).type !== 'prompt') continue
    if ((cmd as Record<string, unknown>).disableModelInvocation) continue

    const name = cmd.name
    const description = cmd.description ?? ''
    const whenToUse = (cmd as Record<string, unknown>).whenToUse as
      | string
      | undefined
    const allowedTools =
      (
        (cmd as Record<string, unknown>).allowedTools as
          | string[]
          | undefined
      )?.join(' ') ?? ''

    const nameTokens = tokenizeAndStem(name)
    const descTokens = tokenizeAndStem(description)
    const whenTokens = tokenizeAndStem(whenToUse ?? '')
    const toolsTokens = tokenizeAndStem(allowedTools)

    // 索引保存元数据，不读取完整正文参与匹配
    entries.push({
      name,
      normalizedName: normalizeSkillName(name),
      description,
      whenToUse,
      source: ((cmd as Record<string, unknown>).source as string) ?? 'unknown',
      loadedFrom: (cmd as Record<string, unknown>).loadedFrom as
        | string
        | undefined,
      skillRoot: (cmd as Record<string, unknown>).skillRoot as
        | string
        | undefined,
      contentLength: (cmd as Record<string, unknown>).contentLength as
        | number
        | undefined,
      tokens: [...new Set([
        ...nameTokens,
        ...descTokens,
        ...whenTokens,
        ...toolsTokens,
      ])],
      tfVector: computeWeightedTf([
        { tokens: nameTokens, weight: FIELD_WEIGHT.name },
        { tokens: whenTokens, weight: FIELD_WEIGHT.whenToUse },
        { tokens: descTokens, weight: FIELD_WEIGHT.description },
        { tokens: toolsTokens, weight: FIELD_WEIGHT.allowedTools },
      ]),
    })
  }

  const idf = computeIdf(entries)
  for (const entry of entries) {
    for (const [term, tf] of entry.tfVector) {
      // 将词频乘以逆文档频率，得到 TF-IDF 权重
      entry.tfVector.set(term, tf * (idf.get(term) ?? 0))
    }
  }

  cachedIndex = entries
  cachedCwd = cwd
  return entries
}
```

索引按 `cwd`（当前工作目录）缓存。新增 Skill 后，如果没有清理 Skill 索引缓存，当前进程可能仍然使用旧索引。

### 5.2 字段权重：名称比描述更重要

Skill 搜索使用四个字段：

```typescript
// src/services/skillSearch/localSearch.ts
const FIELD_WEIGHT = {
  name: 3.0,         // 名称最能代表 Skill 的用途
  whenToUse: 2.0,    // 明确说明适用场景
  description: 1.0,  // 普通描述
  allowedTools: 0.3, // 工具信息只作为弱信号
}
```

`computeWeightedTf()` 并不是简单把四个字段的词频相加，而是对每个字段先归一化，再取同一词在不同字段中的最大加权值：

```typescript
// 同一个词出现在多个字段时，避免重复累加造成过度放大
for (const field of fields) {
  const value = (count / max) * field.weight
  const existing = weighted.get(term) ?? 0
  if (value > existing) {
    weighted.set(term, value)
  }
}
```

查询阶段再用余弦相似度（向量方向相似度）比较查询向量和 Skill 向量：

```typescript
// src/services/skillSearch/localSearch.ts
const queryTokens = tokenizeAndStem(query)
const queryTf = new Map<string, number>()
for (const token of queryTokens) {
  queryTf.set(token, (queryTf.get(token) ?? 0) + 1)
}

const queryTfIdf = new Map<string, number>()
for (const [term, count] of queryTf) {
  // 查询向量同样乘以 IDF，降低常见词的影响
  queryTfIdf.set(term, count * (idf.get(term) ?? 0))
}

for (const entry of index) {
  const score = cosineSimilarity(queryTfIdf, entry.tfVector)

  if (score >= DISPLAY_MIN_SCORE) {
    results.push({
      name: entry.name,
      description: entry.description,
      score,
    })
  }
}

results.sort((a, b) => b.score - a.score)
return results.slice(0, limit)
```

当前默认展示阈值是 `0.10`，默认最多返回 5 个结果。

### 5.3 CJK 查询为什么使用 bigram

CJK（中日韩字符）没有天然的空格分词。源码遇到连续中文字符时，会按相邻两个字符切分：

```text
代码审查
  → 代码
  → 码审
  → 审查
```

这样中文查询可以和中文 Skill 描述产生局部重叠。

搜索结果还要求至少两个 CJK bigram（双字片段）匹配；如果没有足够的中文匹配，但存在 ASCII（拉丁字母和数字）关键词匹配，也可以保留结果。

此外，Skill 名称如果至少 4 个字符，并且查询文本直接包含名称，分数会被抬到至少 `0.75`：

```typescript
// 名称直接命中时，保证显式提到 Skill 名称的查询不会被低分过滤
if (entry.name.length >= NAME_MATCH_MIN_LENGTH) {
  if (queryLower.includes(entry.normalizedName)) {
    score = Math.max(score, 0.75)
  }
}
```

所以 Skill 搜索不是单纯的“向量相似度”：

```text
TF-IDF 相似度
  + CJK bigram 过滤
  + Skill 名称直接命中加分
```

### 5.4 TF-IDF 的边界

TF-IDF 擅长术语明确、数量较小的 Skill 集合。

它不擅长：

- 同义词匹配；
- 需要深层语义理解的查询；
- 大规模 Skill 库中的复杂意图路由；
- 描述写得过于模糊的 Skill。

因此 `when_to_use` 的质量很重要。它不是给用户看的装饰文本，而是搜索索引的一部分。

## 六、触发层：三种发现路径如何协作

Skill 有三种触发方式：

```text
用户显式调用
  /review-pr 123

模型调用 Skill 工具
  Skill({ skill: "review-pr", args: "123" })

系统自动发现
  根据当前用户消息和已加载 Skill 做本地搜索
```

### 6.1 turn-zero：首轮阻塞发现

`getTurnZeroSkillDiscovery()` 处理首轮用户输入。

流程是：

```text
用户第一条消息
  → getSkillIndex()
  → normalizeQueryIntent()
  → searchSkills()
  → enrichResultsForAutoLoad()
  → skill_discovery attachment
```

首轮路径允许做一次更高成本的查询归一化，因为这是模型还没有开始工作的阶段。

### 6.2 `normalizeQueryIntent()`：中文查询补充英文关键词

当查询包含中文且功能开关允许时，`normalizeQueryIntent()` 会调用 Haiku 生成英文关键词，并把关键词拼接回原查询：

```typescript
// src/services/skillSearch/intentNormalize.ts
export async function normalizeQueryIntent(
  query: string,
): Promise<string> {
  const trimmed = query.trim()
  if (!trimmed) return trimmed

  // 纯 ASCII 查询已经适合本地索引，不额外调用模型
  if (!/[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed
  }

  const keywords = await callHaiku(trimmed.slice(0, MAX_QUERY_CHARS))

  // 保留原文，同时追加英文关键词，避免翻译结果覆盖原始意图
  return keywords
    ? `${trimmed} ${keywords}`
    : trimmed
}
```

这不是把 Skill 正文交给 Haiku 总结，而是只做搜索查询改写。

如果调用失败、超时或功能开关关闭，函数返回原始查询，不会让 Skill 搜索异常向上抛出。

### 6.3 inter-turn：轮间异步发现

`startSkillDiscoveryPrefetch()` 在模型流式处理和工具执行期间启动。

```typescript
// src/query.ts：每轮开始时启动异步 Skill 发现
const pendingSkillPrefetch =
  skillPrefetch?.startSkillDiscoveryPrefetch(
    null,
    messages,
    toolUseContext,
  )
```

轮间路径只做本地索引和搜索，不等待 Haiku 翻译。原因是它已经处在主循环中：

```text
首轮还没有其他工作可以隐藏延迟
  → 可以接受一次阻塞式查询归一化

轮间已经在流式生成和执行工具
  → 发现必须异步，不能再增加主循环等待
```

查询文本由 `extractQueryFromMessages()` 向后寻找最近的真实用户文本，并跳过 `tool_result` 等没有发现信号的消息。

### 6.4 去重和自动加载

prefetch 结果会用会话级集合去重：

```typescript
// src/services/skillSearch/prefetch.ts
const discoveredThisSession = new Set<string>()

const newResults = results.filter(
  result => !discoveredThisSession.has(result.name),
)

for (const result of newResults) {
  addBoundedSessionEntry(
    discoveredThisSession,
    result.name,
  )
}
```

集合不是无限增长的。源码设置了最大容量，超过后删除较早的部分，避免长会话中的去重集合持续占用内存。

自动加载还有三层限制：

```text
最低分数：默认 0.30
每次最多自动加载：默认 2 个
单个正文最大字符数：默认 12000
```

自动发现可以把有限正文放进 `skill_discovery` 附件，但它和显式 `SkillTool.call()` 仍是两条不同路径：

```text
自动发现
  让模型提前看到少量候选内容

显式 Skill 调用
  经过 validateInput、权限和执行分支后加载完整内容
```

## 七、SkillTool：从调用名称到正文注入

### 7.1 `validateInput()` 先验证 Skill 是否能执行

Skill 工具的输入主要是：

```typescript
{
  skill: string
  args?: string
}
```

`SkillTool.validateInput()` 会确认：

- Skill 名称格式正确；
- Skill 可以找到；
- Skill 可以加载；
- Skill 没有设置 `disable-model-invocation`；
- 找到的命令确实是 prompt 类型。

因此，模型即使输出了一个字符串，也不能直接跳过命令注册层进入正文执行。

### 7.2 `checkPermissions()` 的决策顺序

Skill 也有自己的权限边界。

```text
1. 规范化 Skill 名称，去掉开头的 /
2. 检查 deny 规则
3. 检查实验性远程 Skill 的特殊路径
4. 检查 allow 规则
5. 只有安全属性时自动允许
6. 否则询问用户
```

源码还支持前缀规则：

```text
review-pr
  只允许精确的 Skill 名称

review-pr:*
  允许 Skill 名称及其参数变体
```

默认情况下，不能因为 Skill 只是 Prompt 就跳过用户审批：

```typescript
// packages/builtin-tools/src/tools/SkillTool/SkillTool.ts
return {
  behavior: 'ask',
  message: `Execute skill: ${commandName}`,
  suggestions: [
    // 可以建议用户把精确名称或名称前缀加入允许规则
  ],
  updatedInput: { skill, args },
}
```

只有明确的 allow 规则，或 Skill 只包含安全属性时，才会自动放行。

### 7.3 `call()` 的三个执行分支

`SkillTool.call()` 的入口会先去掉兼容用的 `/`：

```typescript
// src/.../SkillTool.ts：/skill-name 和 skill-name 统一成同一个名称
const trimmed = skill.trim()
const commandName = trimmed.startsWith('/')
  ? trimmed.substring(1)
  : trimmed
```

之后按上下文选择路径。

#### 路径一：远程 canonical（规范化标识）Skill

实验性远程 Skill 会先识别 `_canonical_` 前缀，从远程 Skill 模块加载 Markdown 内容并直接注入。

这条路径是内部实验能力，不等价于普通本地 Skill，也不执行本地 `!command` 替换。

#### 路径二：fork Skill

如果 `command.context === 'fork'`，Skill 会交给 `executeForkedSkill()`：

```text
主 Agent
  → 创建 fork 子 Agent
  → 子 Agent 使用 Skill 正文和自己的上下文执行
  → 主 Agent 接收结果
```

fork 适合需要独立工具权限、较长内部步骤或不希望污染主上下文的 Skill。

#### 路径三：inline Skill

普通 Skill 走 `processPromptSlashCommand()`，处理：

- Skill 参数；
- `allowed-tools`；
- Skill 指定模型；
- `effort`；
- Skill 正文；
- 必要的 shell 预处理。

最终正文作为消息内容回到主 Agent 的上下文。

## 八、Skill 正文是如何生成的

### 8.1 `createSkillCommand()` 的延迟正文生成

`createSkillCommand()` 不在注册时就把最终正文固定下来，而是把 `getPromptForCommand()` 挂到 Command 上。

```typescript
// src/skills/loadSkillsDir.ts：调用时再生成最终正文
async getPromptForCommand(args, toolUseContext) {
  let finalContent = baseDir
    ? `Base directory for this skill: ${baseDir}\n\n${markdownContent}`
    : markdownContent

  finalContent = substituteArguments(
    finalContent,
    args,
    true,
    argumentNames,
  )

  // 让 Skill 正文可以引用自身目录中的脚本或参考文件
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SKILL_DIR\}/g,
    skillDir,
  )

  // 把当前会话 ID 注入正文
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g,
    getSessionId(),
  )

  return [{ type: 'text', text: finalContent }]
}
```

这说明 Skill 正文不是“读取文件后原样拼接”这么简单，它可能经过：

```text
目录前缀
  → 参数替换
  → Skill 目录变量替换
  → 会话变量替换
  → shell 内联命令处理
```

### 8.2 参数替换和 `!command` 预处理

Skill 可以通过参数占位符接收用户输入，也可以使用 `!` 语法执行 shell 命令，把命令输出写入正文。

这个能力让 Skill 从静态文档变成动态工作流，例如：

```markdown
当前分支状态：

!`git status --short`
```

但它也带来真实的执行风险。`createSkillCommand()` 会把 Skill 的 `allowed-tools` 作为命令权限上下文的一部分，再调用 `executeShellCommandsInPrompt()`。这里的 shell（命令解释器）预处理不是普通文本替换。

因此：

```text
Skill 正文里出现命令
  ≠ 命令只是示例文本

它可能在 Skill 执行期间真的被执行
```

Skill 作者和来源必须被视为权限边界的一部分。

### 8.3 MCP Skill 禁止执行内联命令

MCP（Model Context Protocol，模型上下文协议）Skill 来自远程服务端，信任等级低于本地文件。

源码会在 `loadedFrom === 'mcp'` 时跳过 `executeShellCommandsInPrompt()`：

```typescript
// 远程 MCP Skill 的正文只作为文本使用
if (loadedFrom !== 'mcp') {
  finalContent = await executeShellCommandsInPrompt(
    finalContent,
    toolUseContext,
    `/${skillName}`,
    shell,
  )
}
```

这条防线要单独记住：

```text
MCP Skill 可以提供领域指令
  但其中的 !`command` 不会在本地执行
```

## 九、三个 Skill 来源和各自的安全边界

### 9.1 磁盘 Skill：目录扫描和 frontmatter 解析

磁盘来源通常遵循：

```text
<skill-root>/<skill-name>/SKILL.md
```

加载器会扫描 managed、user、project、`--add-dir` 等目录，并把每个有效文件解析成统一的 `Command`。

相同的 `SKILL.md` 格式因此可以在不同目录来源中复用。

### 9.2 Bundled Skill：懒提取参考文件

Bundled Skill 的正文可以随程序打包，但 Skill 目录中的参考文件不一定在启动时写入磁盘。

首次调用需要参考文件时，`extractBundledSkillFiles()` 才会提取：

```text
首次调用 Skill
  → 创建本进程专属目录
  → 写入参考文件
  → 给正文添加 Base directory
  → 模型再通过 Read / Grep 按需读取
```

写文件使用了多层防护：

```typescript
// src/skills/bundledSkills.ts
const SAFE_WRITE_FLAGS =
  process.platform === 'win32'
    ? 'wx' // Windows 使用字符串标志，避免 libuv 对数字标志的兼容问题
    : fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      O_NOFOLLOW

async function safeWriteFile(
  path: string,
  content: string,
): Promise<void> {
  // 0600：只允许当前用户读写
  const file = await open(path, SAFE_WRITE_FLAGS, 0o600)
  try {
    await file.writeFile(content, 'utf8')
  } finally {
    await file.close()
  }
}
```

同时，目录使用 0700 权限，路径解析会拒绝绝对路径和 `..` 穿越。

这里防的是：

```text
攻击者提前创建 symlink（符号链接）
  → 让 CLI 把文件写到不该写的位置

Skill files 路径包含 ..
  → 逃出当前 Skill 目录
```

### 9.3 MCP Skill：`skill://` 资源转 Command

`fetchMcpSkillsForClient()` 会：

```text
resources/list
  → 过滤 skill:// URI
  → resources/read
  → Unicode 消毒
  → frontmatter 解析
  → createSkillCommand()
```

```typescript
// src/skills/mcpSkills.ts：远程资源也转换成统一 Command
const skillResources = result.resources.filter(
  resource => resource.uri.startsWith('skill://'),
)

const readResult = await client.client.request(
  {
    method: 'resources/read',
    params: { uri: resource.uri },
  },
  ReadResourceResultSchema,
)

const sanitizedContent =
  recursivelySanitizeUnicode(textContent)

const { frontmatter, content } =
  parseFrontmatter(sanitizedContent)

commands.push(
  createSkillCommand({
    ...parseSkillFrontmatterFields(
      frontmatter,
      content,
      skillName,
    ),
    skillName,
    markdownContent: content,
    source: 'mcp',
    loadedFrom: 'mcp',
    baseDir: undefined,
    paths: undefined,
  }),
)
```

`recursivelySanitizeUnicode()` 的目的，是移除不可见格式控制符、Tag 字符和其他可能绕过人工审查的 Unicode（统一码）内容。

MCP Skill 还会使用带服务端名称的命名空间，例如：

```text
mcp__deploy-tools__release-checklist
```

这样不同 MCP 服务端暴露同名 Skill 时不会互相覆盖。

需要注意，MCP Skill 被转换成同一种 `Command`，不代表它和本地 Skill 拥有同样的信任等级。来源信息 `source` 和 `loadedFrom` 会继续参与后续执行分支。

## 十、发现结果、完整正文与压缩恢复

### 10.1 自动发现不是完整加载

系统自动发现时，通常先把结果包装成 `skill_discovery` 附件：

```text
Skill 名称
  + 描述
  + 匹配分数
  + 是否自动加载
  + 需要时才附带有限正文
```

显式调用 Skill 后，`getPromptForCommand()` 才生成完整正文。

因此，发现结果不应该被理解成“Skill 已经完整执行”。它更像是给当前模型的一张候选卡片。

### 10.2 已调用 Skill 会留下状态记录

自动加载或显式执行后，系统会记录已调用 Skill 的名称、路径和内容摘要，用于：

- 当前会话去重；
- 分析和遥测；
- 上下文压缩后的恢复；
- 避免同一个 Skill 在每轮重复注入。

这类 `invoked_skills` 状态不是长期记忆，也不意味着模型永久保留 Skill 正文。

更准确的理解是：

```text
Skill 描述
  用于发现

Skill 正文
  用于当前执行

invoked_skills
  用于记录和恢复曾经加载过什么
```

### 10.3 压缩后恢复仍受预算限制

长会话压缩后，系统可能依据已调用 Skill 记录重新补回 Skill 上下文。

但恢复仍然受单个 Skill 和总恢复预算约束。过长 Skill 不会因为“曾经调用过”就无限制重新注入。

这也是 Skill 正文必须保持结构清晰、把关键约束放在前部的原因：正文可能在长会话治理中被截短或摘要化。

## 十一、常见误区和边界

### 11.1 Skill 文件存在，不代表模型能自动调用

以下任一条件都可能让它不进入模型可见集合：

- 不是 `type: 'prompt'`；
- 设置了 `disable-model-invocation: true`；
- 描述不足，无法通过 `getSkillToolCommands()` 的过滤；
- 当前来源未被启用；
- Skill 索引仍使用旧缓存。

### 11.2 `when_to_use` 不是普通备注

它直接参与搜索权重，写得越具体，自动发现越容易命中。

不推荐：

```yaml
when_to_use: Useful skill
```

更好的写法是：

```yaml
when_to_use: Use when the user asks to review a pull request for bugs, tests, or maintainability.
```

### 11.3 `allowed-tools` 不是完整沙箱

它可以影响 Skill 内联命令的允许规则，但不是完整的操作系统沙箱，也不能替代全局权限系统。

危险 Skill 仍然需要：

```text
来源可信
  + 权限规则正确
  + Hook 检查
  + 工具自身权限
```

### 11.4 fork 不是“自动更安全”

fork 提供上下文隔离，但子 Agent 仍然可能拥有工具和文件访问能力。隔离解决的是上下文污染和执行边界，不会自动消除权限风险。

### 11.5 MCP Skill 的正文不能当作可信指令

MCP Skill 已经做了 Unicode 消毒和内联命令禁用，但正文仍然来自远程对端。

模型应该把它当成外部资料和建议，而不是自动获得更高权限的系统规则。

### 11.6 Skill 不是记忆系统

Skill 描述和正文是任务能力模块，记忆系统保存的是跨会话事实、偏好或历史信息。

```text
Skill
  告诉模型“应该如何做一类任务”

Memory（记忆）
  告诉模型“过去发生过什么、用户偏好什么”
```

两者都可能进入上下文，但生命周期和触发条件完全不同。

## 十二、把完整链路串起来

一次 Skill 使用可以这样回放：

```text
1. getCommands(cwd)
   读取 bundled、磁盘、插件和内置命令

2. parseSkillFrontmatterFields()
   把 SKILL.md 元数据解析成 Command

3. getSkillToolCommands()
   过滤可被模型调用的 prompt Skill

4. formatCommandsWithinBudget()
   把名称和描述放进 Skill 列表

5. getSkillIndex() / searchSkills()
   使用字段加权 TF-IDF 查找候选

6. turn-zero 或 inter-turn discovery
   把搜索结果作为 skill_discovery 附件注入

7. SkillTool.validateInput()
   检查 Skill 存在、可加载且允许模型调用

8. SkillTool.checkPermissions()
   应用 deny、allow、安全属性和用户审批

9. SkillTool.call()
   选择 remote、fork 或 inline 分支

10. getPromptForCommand()
    替换参数、目录变量、会话变量和允许的内联命令

11. 主上下文或 fork 上下文继续执行
    模型遵循 Skill 正文并调用工具
```

## 十三、读完后应该能回答的问题

### 问题一：为什么 Skill 要拆成描述和全文？

描述用于发现，全文用于执行。描述常驻但必须很短；全文按需注入，避免所有 Skill 的完整内容永久占用上下文。

### 问题二：TF-IDF 为什么给 `name` 更高权重？

因为 Skill 名称通常是最明确的能力标签，`description` 里的通用词可能很多；名称权重高可以避免通用词压过真正的 Skill 标识。

### 问题三：中文查询为什么还能匹配英文 Skill？

本地搜索先使用 CJK bigram 处理中文字符；首轮阻塞路径还可以调用 `normalizeQueryIntent()` 追加英文关键词。轮间异步路径不调用翻译，优先保证主循环不被阻塞。

### 问题四：`disable-model-invocation` 和 `user-invocable` 有什么区别？

前者控制模型是否能自动调用；后者控制用户是否能通过手动命令调用。它们分别约束两种触发入口。

### 问题五：SkillTool 为什么还要做权限检查？

因为 Skill 正文可能触发工具、读取文件或执行内联命令。Skill 是 Prompt，不代表它天然可信，也不代表它可以绕过工具权限。

### 问题六：inline 和 fork 如何选择？

inline 适合希望主 Agent 直接遵循流程的 Skill；fork 适合需要独立上下文、多轮内部步骤或隔离中间过程的 Skill。

### 问题七：MCP Skill 和本地 Skill 最大的差异是什么？

MCP Skill 来自远程资源，因此会做 Unicode 消毒，并禁止执行正文中的内联 shell 命令。它可以复用同一套 Command 和搜索模型，但不能默认享有本地文件的信任等级。

## 总结

Skill 系统的核心不是“多了一种 Markdown 文件”，而是把领域能力拆成了两条生命周期：

```text
发现生命周期
  Command 注册
  → 元数据预算
  → TF-IDF / CJK 搜索
  → skill_discovery

执行生命周期
  SkillTool.validateInput()
  → 权限检查
  → remote / fork / inline
  → 参数和变量替换
  → 完整正文进入上下文
```

真正值得记住的是四个边界：

```text
Skill 描述
  负责让模型发现能力

Skill 正文
  负责让模型执行流程

SkillTool
  负责把调用名称转成受控执行

权限和来源
  决定这份领域指令是否值得信任、能做什么
```

这样理解后，Skill 就不再是“隐藏在命令系统里的 Prompt”，而是一个具备注册、搜索、权限、执行上下文和恢复状态的 Agent 能力模块。
