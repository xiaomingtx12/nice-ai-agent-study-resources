---
slug: /application-notes/engineering/claude-code-cli/cc-06-context-assembly
sidebar_position: 6
title: "上下文装配"
description: "Agent 每轮看到的上下文会被分层装配到 system、messages 和 tools。本篇先拆解请求槽位、System Prompt、项目指令和 queryLoop 的装配链，再说明 SessionMemory、CLAUDE.md、Auto Memory 与 Prompt Cache 如何接入这条链路。"
---

> *Agent 每次调用模型前，都要重新决定“这一轮应该让模型看到什么”。关键在于识别内容的稳定性，并把它放到合适的位置。*
>
> **Harness 层定位**：**[02 §三 组件 5 上下文层](../01-architecture-lifecycle/cc-02-harness-design.md)**，决定模型“看到什么”。

# 上下文组装引擎

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变动，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **每轮请求的总装入口**：`src/query.ts` 的 `queryLoop()`。它先得到 `messagesForQuery`，再执行压缩、附件收割和上下文注入，最后把 `messages`、`systemPrompt`、`tools` 交给 `callModel()`。
> - **系统提示词源头**：`src/constants/prompts.ts` 的 `getSystemPrompt()`。静态行为规则和 registry-managed 动态 sections 都从这里形成 `SystemPrompt` 数组。
> - **动态段注册表**：`src/constants/systemPromptSections.ts` 的 `systemPromptSection()`、`DANGEROUS_uncachedSystemPromptSection()` 和 `resolveSystemPromptSections()`。
> - **上下文消息注入**：`src/utils/api.ts` 的 `appendSystemContext()` 和 `prependUserContext()`。前者追加到 `systemPrompt`，后者把项目指令、日期和其他上下文放进 `messages`。
> - **项目指令加载**：`src/utils/claudemd.ts` 的 `getMemoryFiles()`、`getClaudeMds()`、`processMdRules()`。它们负责寻找 `CLAUDE.md`、`CLAUDE.local.md` 和 `.claude/rules/*.md`。
> - **自动记忆**：`src/memdir/memdir.ts` 的 `loadMemoryPrompt()`，以及 `src/memdir/findRelevantMemories.ts` 的 `findRelevantMemories()`。
> - **Prompt Cache 落地**：`src/utils/api.ts` 的 `splitSysPromptPrefix()`，以及 `src/services/api/claude.ts` 的 `buildSystemPromptBlocks()`。

## 为什么读这一篇

上下文装配经常被误解成“读取几个 Markdown 文件，再拼成一个 system prompt”。在真实的 Agent Loop 中，它至少要同时处理三类问题：

1. **内容来源很多**：静态行为规则、项目里的 `CLAUDE.md`、自动记忆、Git 状态、MCP instructions、Skill 说明和当前对话并不来自同一个模块。
2. **内容稳定性不同**：静态规则可能在一个版本内长期不变，Git 状态只是一份会话快照，MCP 连接和工具列表可能在两轮之间变化。
3. **内容注入位置不同**：有些内容属于 `system`，有些内容必须成为 `messages` 中的隐藏 user message，还有些内容不能作为文本注入，而是要放进 `tools` Schema。

如果不先分清这三点，后面很容易把“项目指令”“模型行为规则”和“工具能力声明”混成一类，最终既难以解释源码，也难以定位 Prompt Cache 为什么失效。

:::tip 一句话
上下文装配不是一个“大字符串拼接函数”，而是一条把不同来源的数据投影到 `system`、`messages` 和 `tools` 三个请求槽位的流水线。`queryLoop()` 负责组织时序，具体模块负责提供内容。
:::

## 读完后应该能回答什么

- `getSystemPrompt()` 生成的内容，为什么要先保持为 `string[]`，最后才转成 API 的文本 block？
- 为什么 `prependUserContext()` 不把所有内容都追加到 system prompt？
- `queryLoop()` 在什么时候得到 `messagesForQuery`，又在什么时候加入项目指令和附件？
- `CLAUDE.md`、`.claude/rules/*.md` 和 `MEMORY.md` 的加载职责分别是什么？
- Auto Memory 中的“已展示”“过时”“忽略”和“忘记”分别代表什么？
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 如何把稳定内容和动态内容分开？
- Prompt Cache 失效时，应该先检查内容来源、段注册表，还是 API block 切分？

---

## 一、先看最终产物：一次 API 请求有三个槽位

上下文装配最重要的坐标不是文件，而是模型请求最终收到的三个字段：

```text
queryLoop()
  │
  ├─ systemPrompt + systemContext
  │       └─► system: TextBlockParam[]
  │
  ├─ messagesForQuery + userContext + attachments
  │       └─► messages: Message[]
  │
  └─ toolUseContext.options.tools
          └─► tools: Tool[]
```

这三个槽位分别承担不同职责：

| 请求字段 | 主要内容 | 由谁负责 |
| --- | --- | --- |
| `system` | Agent 身份、行为约束、工具使用原则、动态运行时说明 | `getSystemPrompt()`、`appendSystemContext()`、`buildSystemPromptBlocks()` |
| `messages` | 用户对话、`CLAUDE.md`、日期提示、工具结果、附件和 Memory Prefetch 结果 | `queryLoop()`、`prependUserContext()`、`getAttachmentMessages()` |
| `tools` | 工具名称、描述和 `input_schema`，包括部分 MCP 工具 | `ToolUseContext`、工具注册和 MCP 连接管理器 |

这里有一个容易混淆的边界：

- “怎么使用工具”通常是 `system` 中的行为规则。
- “有哪些工具、参数是什么”属于 `tools`。
- “这次工具执行产生了什么结果”属于 `messages` 中的 `tool_result`。

因此，不能把工具 Schema 当作普通 prompt 文本，也不能把项目指令当作工具配置。三者最后一起进入模型请求，但装配路径不同。

### 1.1 `QueryParams` 已经把边界写在类型里

`src/query.ts` 的 `QueryParams` 类型直接暴露了这几个输入：

```typescript
export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  querySource: QuerySource
  // 其他字段负责模型回退、turn 限制和 token budget。
}
```

这段类型直接暴露出两个边界：

1. `systemPrompt` 和 `userContext` 是两个独立输入。前者描述 Agent 的行为规则，后者承载项目级或会话级上下文。
2. `toolUseContext` 不只是“工具列表”，它还携带当前 Agent、模型、权限、AbortSignal 和运行时状态。工具 Schema 只是其中一部分。

### 1.2 `queryLoop()` 是真正的装配协调者

`queryLoop()` 不负责生成每一段 prompt 的原文，它负责把已经准备好的对象放到正确的阶段：

```typescript
// src/query.ts: 约 393 行之后
const {
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  querySource,
} = params

let state: State = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  // 其余字段记录压缩、重试和 turn 状态。
}

while (true) {
  const { messages, toolUseContext } = state

  // 先从当前会话历史得到本轮要发送的消息视图。
  let messagesForQuery = getMessagesAfterCompactBoundary(messages)

  // 这里还会依次执行 tool result 预算控制、snip、
  // microcompact、context collapse 和 autocompact。

  const fullSystemPrompt = asSystemPrompt(
    appendSystemContext(systemPrompt, systemContext),
  )

  for await (const message of deps.callModel({
    messages: prependUserContext(messagesForQuery, userContext),
    systemPrompt: fullSystemPrompt,
    tools: toolUseContext.options.tools,
    // 还会传入 model、signal、thinkingConfig 和权限回调。
  })) {
    yield message
  }
}
```

代码中的中文注释对应三个时序事实：

- `messagesForQuery` 是当前内存消息的“发送视图”，不是简单地把 `state.messages` 原样传给 API。
- `appendSystemContext()` 和 `prependUserContext()` 都发生在模型调用前，但作用于不同槽位。
- `tools` 没有经过 `prependUserContext()`，它沿着 `toolUseContext.options.tools` 单独进入请求。

---

## 二、System Prompt 的装配方式

### 2.1 静态段和动态段

`getSystemPrompt()` 返回 `string[]`，而不是一条已经拼好的字符串。它把系统提示词分成两部分：

```text
静态段
  Intro
  System
  Doing tasks
  Executing actions with care
  Using your tools
  Communication style

动态段
  mode_persona
  session_guidance
  memory
  env_info_simple
  language
  output_style
  mcp_instructions
  scratchpad
  summarize_tool_results
  token_budget
  ...
```

具体动态段会受到 feature gate、工具列表、模型、输出风格和 MCP 连接状态影响，所以不能把“动态段数量”当作永久不变的协议。稳定的是它们由注册表统一解析，再按固定顺序返回。

`getSystemPrompt()` 的核心结构如下：

```typescript
const dynamicSections = [
  systemPromptSection('mode_persona', () => getModePersonaSection()),
  systemPromptSection('session_guidance', () =>
    getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
  ),
  systemPromptSection('memory', () => loadMemoryPrompt()),
  systemPromptSection('env_info_simple', () =>
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ),
  systemPromptSection('language', () =>
    getLanguageSection(settings.language),
  ),
  DANGEROUS_uncachedSystemPromptSection(
    'mcp_instructions',
    () => getMcpInstructionsSection(mcpClients),
    'MCP servers connect/disconnect between turns',
  ),
]

const resolvedDynamicSections =
  await resolveSystemPromptSections(dynamicSections)

return [
  // 这些段尽量保持稳定，便于共享 Prompt Cache。
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  getSimpleDoingTasksSection(),
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  getOutputEfficiencySection(),

  // 动态段从这里开始。
  ...(shouldUseGlobalCacheScope()
    ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY]
    : []),
  ...resolvedDynamicSections,
].filter(section => section !== null)
```

代码后面的中文说明：

- `systemPromptSection()` 创建的是可缓存的段，缓存状态保存在 bootstrap state 中，通常在 `/clear` 或 `/compact` 时清理。
- `DANGEROUS_uncachedSystemPromptSection()` 表示这个段必须在每次 resolve 时重新计算。MCP 连接状态就是典型例子。
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 不是给模型看的自然语言，而是后续 `splitSysPromptPrefix()` 用来切分缓存范围的结构标记。

### 2.2 动态段注册表如何控制缓存

`src/constants/systemPromptSections.ts` 的实现很短，但决定了每个段的缓存语义：

```typescript
type ComputeFn = () => string | null | Promise<string | null>

export function systemPromptSection(
  name: string,
  compute: ComputeFn,
) {
  // 默认段：如果缓存里已有结果，复用上一次计算。
  return { name, compute, cacheBreak: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
) {
  // 易变化段：每次重新计算，变化时可能打破 prompt 前缀。
  return { name, compute, cacheBreak: true }
}

export async function resolveSystemPromptSections(sections) {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async section => {
      if (!section.cacheBreak && cache.has(section.name)) {
        return cache.get(section.name) ?? null
      }

      const value = await section.compute()
      setSystemPromptSectionCacheEntry(section.name, value)
      return value
    }),
  )
}
```

这套机制的价值在于：调用方只关心“注册一个段”，不用自己维护缓存键、清理时机和段的顺序。换句话说，缓存策略被放在段的元数据里，而不是散落在所有 prompt builder 中。

### 2.3 Agent、custom prompt 和默认 prompt 的优先级

`src/utils/systemPrompt.ts` 的 `buildEffectiveSystemPrompt()` 负责选择最终 system prompt。优先级可以概括为：

| 优先级 | 来源 | 语义 |
| --- | --- | --- |
| 0 | `overrideSystemPrompt` | 完全替换其他 system prompt |
| 1 | Coordinator prompt | Coordinator 模式下使用专用 prompt |
| 2 | Agent definition | Agent 有自己的 prompt 时使用 Agent prompt |
| 3 | `customSystemPrompt` | 调用方通过参数传入的自定义 prompt |
| 4 | default prompt | 标准 Claude Code prompt |

`appendSystemPrompt` 是一个例外：只要没有命中完全替换的 override，它通常会追加在选中的 prompt 后面。

```typescript
if (overrideSystemPrompt) {
  // override 是替换，不是追加。
  return asSystemPrompt([overrideSystemPrompt])
}

const agentSystemPrompt = mainThreadAgentDefinition
  ? mainThreadAgentDefinition.getSystemPrompt()
  : undefined

return asSystemPrompt([
  ...(agentSystemPrompt
    ? [agentSystemPrompt]
    : customSystemPrompt
      ? [customSystemPrompt]
      : defaultSystemPrompt),
  // appendSystemPrompt 只改变末尾，不改变前面选择出的主体。
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

阅读这段逻辑时，重点不要放在“谁优先”本身，而要放在一个后果上：**如果 Agent prompt 替换了默认 prompt，默认 prompt 中的行为规则不会自动保留**。这也是自定义 Agent 设计时最容易忽略的边界。

---

## 三、项目指令如何进入 `messages`

### 3.1 `getMemoryFiles()` 先返回结构化文件列表

`getMemoryFiles()` 不直接拼接文本。它先创建 `processedPaths`，然后按来源读取文件：

```typescript
export const getMemoryFiles = memoize(
  async (forceIncludeExternal = false): Promise<MemoryFileInfo[]> => {
    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const includeExternal =
      forceIncludeExternal ||
      getCurrentProjectConfig().hasClaudeMdExternalIncludesApproved

    // 组织级和用户级说明先进入结果。
    result.push(
      ...(await processMemoryFile(
        getMemoryPath('Managed'),
        'Managed',
        processedPaths,
        includeExternal,
      )),
    )

    // 先从当前目录向上收集路径，再反转成“根目录 → 当前目录”。
    const dirs: string[] = []
    let currentDir = getOriginalCwd()
    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // 实际源码再按根目录到当前工作目录遍历。
    for (const dir of dirs.reverse()) {
      result.push(
        ...(await processMemoryFile(
          join(dir, 'CLAUDE.md'),
          'Project',
          processedPaths,
          includeExternal,
        )),
      )
      result.push(
        ...(await processMemoryFile(
          join(dir, 'CLAUDE.local.md'),
          'Local',
          processedPaths,
          includeExternal,
        )),
      )
    }

    // Auto Memory / Team Memory 入口文件在 feature 开启且文件存在时加入。
    return result
  },
)
```

上面是为了展示装配顺序的缩略代码，实际实现还处理：

- User 级 `CLAUDE.md` 和 `.claude/rules`；
- `.claude/CLAUDE.md`；
- worktree 下避免重复读取主仓库项目文件；
- `--add-dir` 额外目录；
- 外部 include 的审批；
- 文件路径去重和循环引用。

这里有一个重要结论：**目录优先级不是通过“后面的字符串覆盖前面的字符串”实现的**。源码先保留每个文件的来源和路径，后续 `getClaudeMds()` 才根据类型包裹说明文字并合并内容。

### 3.2 无条件 rules 和条件 rules 分成两条路径

`.claude/rules/*.md` 可以不带 `paths`，也可以通过 frontmatter 指定匹配范围。

源码用 `processMdRules()` 的 `conditionalRule` 参数区分两种情况：

```typescript
const files = await processMemoryFile(
  resolvedEntryPath,
  type,
  processedPaths,
  includeExternal,
)

// conditionalRule=true 只留下带 glob 的文件；
// false 只留下不带 glob 的文件。
result.push(
  ...files.filter(file =>
    conditionalRule ? file.globs : !file.globs,
  ),
)
```

真正针对目标文件筛选时，`processConditionedMdRules()` 会：

1. 先拿到所有带 `globs` 的 rule；
2. 根据 rule 类型选择匹配基准目录；
3. 把目标路径转换成相对路径；
4. 用 glob matcher 判断是否命中。

这样设计的好处是，普通 `CLAUDE.md` 和无条件 rule 可以在会话级缓存；只有当 Agent 处理某个具体文件时，条件 rule 才根据目标路径追加。

### 3.3 `getClaudeMds()` 只负责格式化和拼接

```typescript
export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
): string => {
  const memories: string[] = []

  for (const file of memoryFiles) {
    if (!file.content) continue

    const content = file.content.trim()
    const description =
      file.type === 'Project'
        ? ' (project instructions, checked into the codebase)'
        : file.type === 'Local'
          ? " (user's private project instructions, not checked in)"
          : " (user's private global instructions for all projects)"

    memories.push(
      `Contents of ${file.path}${description}:\n\n${content}`,
    )
  }

  if (memories.length === 0) return ''
  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}
```

这段函数不负责扫描目录，也不负责判断某条规则是否命中。它只做三件事：

- 给不同类型的文件补来源说明；
- 保留文件路径，方便模型判断规则范围；
- 用统一的 `MEMORY_INSTRUCTION_PROMPT` 说明这些内容如何使用。

职责拆开后，目录遍历、规则匹配、文本格式化可以分别测试，也不会把“读取失败”混进 prompt 拼接逻辑。

### 3.4 `prependUserContext()` 为什么创建两个隐藏 user message

最终注入发生在 `src/utils/api.ts`：

```typescript
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  if (process.env.NODE_ENV === 'test') {
    return messages
  }

  const { claudeMd, ...rest } = context
  const result: Message[] = []

  if (claudeMd) {
    result.push(
      createUserMessage({
        // 项目指令单独成段，避免被普通提醒语气削弱。
        content: `<project-instructions>\n${claudeMd}\n</project-instructions>\n`,
        isMeta: true,
      }),
    )
  }

  if (Object.keys(rest).length > 0) {
    result.push(
      createUserMessage({
        // 日期、Git 相关提示等一般上下文放进 system-reminder。
        content: `<system-reminder>\n${Object.entries(rest)
          .map(([key, value]) => `# ${key}\n${value}`)
          .join('\n')}\n</system-reminder>\n`,
        isMeta: true,
      }),
    )
  }

  // 上下文消息位于当前对话历史之前。
  return [...result, ...messages]
}
```

这里的两个 message 不是普通用户输入：

- `isMeta: true` 让运行时知道这是系统注入的消息；
- `<project-instructions>` 用于提高项目指令的指令权重；
- `<system-reminder>` 明确告诉模型这些内容可能与当前任务无关，避免每条上下文都被当作当前用户问题。

如果把所有 `userContext` 都描述成“拼到 messages 头部的一段文本”，就会漏掉真实实现中的两个包装层：`claudeMd` 单独使用 `<project-instructions>`，其他上下文则放进 `<system-reminder>`。

### 3.5 运行时上下文分为 `systemContext` 和 `userContext`

`src/context.ts` 提供两个 memoize 函数：

```typescript
export const getSystemContext = memoize(async () => {
  const gitStatus =
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    !shouldIncludeGitInstructions()
      ? null
      : await getGitStatus()

  return {
    // Git 状态是会话开始时获取的快照。
    ...(gitStatus && { gitStatus }),
  }
})

export const getUserContext = memoize(async () => {
  const claudeMd = getClaudeMds(
    filterInjectedMemoryFiles(await getMemoryFiles()),
  )

  return {
    // 项目指令由 prependUserContext() 作为高权重消息注入。
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

这里的命名不是随意的：

- `systemContext` 适合放和 Agent 运行环境相关的说明，例如 Git 状态。
- `userContext` 适合放“看起来像用户提供的项目指令”的内容，例如 `CLAUDE.md`。

两者最终都会进入模型，但后续注入函数会给它们不同的消息结构和提示语气。

---

## 四、`queryLoop()` 中的一次完整装配

到这里，数据来源已经清楚。现在沿着一次模型调用，把关键阶段串起来。

### 4.1 从会话消息得到发送视图

```typescript
let messagesForQuery = getMessagesAfterCompactBoundary(messages)

// 不直接修改 UI 仍在使用的原始消息对象。
messagesForQuery = messagesForQuery.map(message => {
  if (
    message.type !== 'user' ||
    !('toolUseResult' in message) ||
    message.toolUseResult === undefined
  ) {
    return message
  }

  const copy = { ...message }
  // API 只需要 message.content 中的 tool_result，
  // 不需要保留用于界面渲染的原始 toolUseResult 对象。
  delete copy.toolUseResult
  return copy
})
```

这里的浅拷贝很关键。`state.messages` 同时被 React UI 使用，如果在发送前原地删除 `toolUseResult`，模型请求和界面渲染就会争用同一个对象。

### 4.2 对消息视图做上下文治理

在追加项目上下文之前，`queryLoop()` 还可能处理：

| 阶段 | 作用 |
| --- | --- |
| tool result budget | 控制单个工具结果占用的字符或 token |
| snip | 删除中间已经不需要的消息区间 |
| microcompact | 清理旧工具结果，尽量保留 Prompt Cache 结构 |
| context collapse | 以投影视图替代已归档的历史 |
| autocompact | 在接近上下文窗口时生成摘要并替换旧消息 |

这些步骤都作用于 `messagesForQuery`，而不是直接修改 `systemPrompt`。所以“上下文窗口不够”首先是消息视图的问题，和系统提示词缓存是两条不同的优化线。

### 4.3 模型窗口检测不是一次判断

上下文窗口检测至少有三道判断，不能简单概括成“token 超过窗口就报错”：

```text
当前消息 token 估算
  ↓
扣除 snip 已释放的 token
  ↓
硬阻塞检测
  ├─ 自动压缩关闭：到达 blocking limit → 不再发 API，请用户手动 /compact
  └─ 自动压缩开启：继续做预测式检测
       ↓
预测本轮输出 + 工具结果增长
  ├─ 预计会超过有效窗口 → 提前 autocompact
  └─ 预计仍能容纳 → 继续组装请求
       ↓
API 仍返回 Prompt Too Long
  └─ 交给 reactive compact（响应式压缩）兜底
```

核心判断使用的是 `messagesForQuery` 的 token 估算，而不是 UI 中看到的消息条数：

```typescript
// src/query.ts：同一份“当前上下文”同时用于硬阻塞和预测式压缩。
const currentTokens =
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed

// 有效窗口已经扣除了摘要输出预留。
const effectiveWindow = getEffectiveContextWindowSize(model)

// 预估本轮最多还会产生多少模型输出和工具结果。
const estimatedGrowth = estimateMaxTurnGrowth(model)
const predictiveThreshold = effectiveWindow - estimatedGrowth

if (currentTokens > predictiveThreshold) {
  // 还没有调用 API，就先压缩，避免本轮增长把窗口顶满。
  await deps.autocompact(...)
}
```

这里有三个不同的数字：

- **模型原始窗口**：由 `getContextWindowForModel()` 根据模型和 beta 配置返回；
- **有效窗口**：原始窗口减去压缩摘要需要的输出预留；
- **预测阈值**：有效窗口再减去一轮可能产生的输出和工具结果增长。

自动压缩的常规阈值还会额外减去 buffer（安全余量）。所以查询循环里要区分：

1. `blocking limit`：已经接近不能继续发请求的硬红线；
2. `autocompact threshold`：正常自动摘要的触发线；
3. `predictive threshold`：考虑本轮增长后，提前压缩的预测线。

如果自动压缩关闭，blocking limit 会保留一小段空间给用户执行 `/compact`。如果自动压缩开启，系统会优先尝试预测式压缩，真正的 API Prompt Too Long 只作为最后的响应式兜底。

### 4.4 形成 system 和 messages

```typescript
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)

const request = {
  // 项目指令、日期和其他 userContext 变成隐藏消息。
  messages: prependUserContext(messagesForQuery, userContext),

  // systemContext 被追加到 systemPrompt 数组末尾。
  systemPrompt: fullSystemPrompt,

  // 工具能力通过独立的 tools 字段发送。
  tools: toolUseContext.options.tools,
}
```

之后 `deps.callModel()` 会把 `systemPrompt` 转成 API block，把 `messages` 做协议归一化，然后发起真正的模型调用。

### 4.5 Prefetch 为什么在循环外和循环内各有一条

`queryLoop()` 在进入循环时启动一次 `startRelevantMemoryPrefetch()`，用于当前用户 turn 的记忆召回；每个 iteration 又可能启动 Skill discovery 和额外工具搜索：

```text
用户 turn 开始
  └─ startRelevantMemoryPrefetch()
       └─ 后台选择相关 Memory 文件

每次 queryLoop iteration
  ├─ startSkillDiscoveryPrefetch()
  └─ startSearchExtraToolsPrefetch()

工具执行结束后
  └─ getAttachmentMessages()
       └─ 把已经完成的结果追加回 messages
```

它们共同遵循一个原则：**能在模型流式输出和工具执行期间完成的准备工作，不要阻塞在下一次 API 调用前才开始**。但最终注入仍然要等结果准备好，不能把未完成的 Promise 直接交给模型。

---

## 五、记忆如何进入上下文

上下文装配的路径已经确定，记忆机制就有了明确的落点。记忆没有独立的“第四槽位”，不同生命周期的数据经过加载、筛选或摘要后，会重新落到 `system`、`messages` 或持久化文件上。

### 5.1 四层记忆，解决四种时间范围的问题

| 记忆层 | 代表内容 | 生命周期 | 主要作用 |
| --- | --- | --- | --- |
| **工作记忆** | `state.messages`、当前 turn、工具结果、附件 | 当前任务和当前上下文窗口 | 让 Agent 继续完成眼前的任务 |
| **会话记忆** | transcript、`session-memory/summary.md`、`compact_boundary` | 当前会话或会话恢复周期 | 记录当前任务的状态，辅助摘要和压缩 |
| **项目记忆** | `CLAUDE.md`、`.claude/rules` | 跨 turn、跨会话 | 记录项目约束、开发规则和目录级指令 |
| **长期自动记忆** | `MEMORY.md`、Auto Memory 主题文件 | 跨会话长期保存 | 沉淀用户偏好、项目事实、反馈和可复用经验 |

这四层不是四个彼此隔离的数据库。工作记忆可以被提炼成会话摘要，也可以由记忆 Agent 进一步沉淀为长期文件；长期文件在后续请求中被加载或召回，又会重新进入当前 turn 的消息视图。

记忆层和请求槽位也不是同一组概念：

| 来源 | 典型内容 | 默认落点 |
| --- | --- | --- |
| 项目记忆 | `CLAUDE.md` 和 rules | `messages` 的隐藏 user message |
| 会话记忆 | 压缩摘要或 session attachment | `messages` |
| 自动记忆说明 | `loadMemoryPrompt()` 的使用规则 | `system` 的动态段 |
| 自动记忆内容 | 按需召回的主题文件 | `messages` attachment |
| 工作记忆 | 对话历史、工具结果、压缩后的消息视图 | `messages` |

一个长期记忆文件被召回后，仍然只是当前请求里的一个 attachment。持久化位置决定它能否跨会话复用，注入位置决定它本轮如何被模型看到。

### 5.2 工作记忆：`state.messages` 是当前任务的运行时状态

工作记忆以 `Message[]` 的形式存在于 Agent Loop：

```text
用户输入
  ↓
assistant 消息
  ↓
tool_use / tool_result
  ↓
下一轮模型调用
```

每轮调用前，`queryLoop()` 都会从它构造 `messagesForQuery`，并按需：

- 丢掉已经跨过 compact boundary 的旧前缀；
- 释放不需要再次发送的原始 `toolUseResult` 对象；
- 应用 tool result 大小预算；
- 执行 microcompact、snip、context collapse 或 autocompact；
- 在真正调用 API 前追加项目指令和附件。

因此，工作记忆不是静态缓存。模型响应、工具执行、附件注入和压缩都会改变它。旧内容从发送视图中消失，也不等于持久化记忆文件被删除。

### 5.3 会话记忆：`SessionMemory` 是工作记忆的旁路摘要

源码中的 `SessionMemory` 把当前会话的重要状态写入 Markdown 摘要。它不替代完整 transcript，也不负责保存跨项目知识。完整对话仍然保存在 JSONL transcript 中，`summary.md` 只保留当前任务、文件、错误、修正和下一步等可继续执行的信息。

摘要路径由 Claude 的项目数据目录和当前会话 ID 共同决定：

```text
{CLAUDE_CONFIG_DIR 或 ~/.claude}/projects/{sanitize(cwd)}/{sessionId}/session-memory/summary.md
```

`getProjectDir(getCwd())` 指向 Claude 的项目数据目录，不是用户当前打开的工程目录。因此，`summary.md` 不会写入项目工作树。

自动初始化和更新受运行条件控制，通常需要同时满足：

- 当前进程不在远程模式，自动压缩已开启；
- `tengu_session_memory` 特性开关已开启；
- 主 REPL 完成模型采样，且当前上下文达到 token 和工具调用门槛。

默认门槛来自 `DEFAULT_SESSION_MEMORY_CONFIG`：

```typescript
export const DEFAULT_SESSION_MEMORY_CONFIG = {
  minimumMessageTokensToInit: 10_000,
  minimumTokensBetweenUpdate: 5_000,
  toolCallsBetweenUpdates: 3,
}
```

`/summary` 可以绕过更新门槛，直接创建或更新摘要。自动更新则在 post-sampling hook 中调用 `shouldExtractMemory()` 判断上下文增长和工具调用次数，满足条件后执行下面这条旁路：

```text
setupSessionMemoryFile()
  ↓
buildSessionMemoryUpdatePrompt()
  ↓
runForkedAgent()
  ↓
只允许编辑 summary.md
```

这个 forked agent 不会修改主 Agent 的 `state.messages`。摘要在主链中有两种用途：`/summary` 读取并展示它；`trySessionMemoryCompaction()` 在相关 feature gate 开启时，用它替换已经整理过的旧消息。

第一次创建摘要时，系统会写入 `Session Title`、`Current State`、`Task specification`、`Files and Functions`、`Errors & Corrections`、`Learnings` 和 `Worklog` 等字段。字段本身已经说明它的用途：记录当前任务如何继续，而不是为所有项目沉淀通用知识。

### 5.4 项目记忆和 Auto Memory 解决的问题不同

项目记忆回答“这个项目应该如何工作”。`getMemoryFiles()` 按 Managed、User、Project、Local 和额外目录等来源收集 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 和 rules，返回带有 `type`、`path`、`content` 和可选 `globs` 的 `MemoryFileInfo[]`。它随后由 `getClaudeMds()` 格式化，并通过 `prependUserContext()` 作为 `<project-instructions>` 注入 `messages`。

Auto Memory 回答“哪些偏好、事实和经验值得跨会话保留”。`loadMemoryPrompt()` 只生成记忆系统的使用规则，例如记忆类型、frontmatter、`MEMORY.md` 的索引职责，以及临时任务不应写入长期记忆等。具体主题文件由 `findRelevantMemories()` 按需召回：

```typescript
const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
  memory => !alreadySurfaced.has(memory.filePath),
)

const selectedFilenames = await selectRelevantMemories(
  query,
  memories,
  signal,
  recentTools,
  parentSpan,
)

return selectedFilenames
  .map(filename => byFilename.get(filename))
  .filter((memory): memory is MemoryHeader => memory !== undefined)
  .map(memory => ({ path: memory.filePath, mtimeMs: memory.mtimeMs }))
```

这条路径先扫描记忆文件头部，再通过独立的 `sideQuery` 选择相关文件，并把结果作为 attachment 回灌到 `messages`。当前实现还会限制候选数量、单轮选择数量、单文件大小和会话累计大小，避免记忆召回反过来挤占主任务的上下文窗口。

具体限制包括：候选扫描最多保留 200 个文件，每次最多选择 5 个文件，单个文件约限制在 4KB 以内，会话累计注入量约限制在 60KB 以内。这些数字约束的是候选集合和上下文占用，不代表系统会删除超出限制的记忆文件。

`MEMORY.md` 是入口索引，不是全部记忆内容的容器。索引可以随项目上下文加载，主题文件则按当前请求召回。两者职责不同，不能只删索引就认为记忆已经被删除。

### 5.5 “不再召回”不等于“已经遗忘”

Auto Memory 中有几类行为都会让模型后面少看到某条内容，但它们对持久化文件的影响不同：

| 机制 | 主要实现 | 实际效果 | 是否删除文件 |
| --- | --- | --- | --- |
| 召回去重 | `alreadySurfaced`、`readFileState`、`collectSurfacedMemories()` | 当前消息视图中不重复注入同一文件 | 否 |
| 新鲜度提醒 | `memoryAge()`、`memoryFreshnessText()` | 提醒模型回到当前代码验证旧事实 | 否 |
| 用户要求忽略 | 把相关索引视为当前请求不可用 | 只改变本轮应用方式 | 否 |
| 用户要求忘记 | 记忆 Agent 使用 `Edit` / `Write` 更新文件和索引 | 从持久化内容中移除、改写或取消索引 | 是，前提是写操作完成 |
| 后台整理 | `extractMemories`、`autoDream` | 合并重复内容、修正矛盾、清理过时指针 | 可能 |

`alreadySurfaced` 只是召回去重集合。`collectSurfacedMemories()` 会从当前 `messages` 重新统计已经展示过的路径和累计字节数；上下文压缩后，旧 attachment 从发送视图中消失，同一文件之后仍可能再次被召回。

同样，`memoryFreshnessText()` 只根据文件修改时间生成“几天前”的提醒，要求模型重新验证当前代码。它不会执行 `unlink`，也不会把文件移出 `memory` 目录。记忆变旧和记忆被删除是两件事。

当记忆超过一天没有更新时，附件头部会加入类似下面的提醒：

```typescript
return (
  `This memory is ${days} days old. ` +
  `Memories are point-in-time observations, not live state. ` +
  `Verify against current code before asserting as fact.`
)
```

提醒的作用是降低旧事实的可信度，促使模型重新读取当前代码；它不负责清理文件。

用户说“忽略关于 X 的记忆”时，系统只改变当前请求的应用策略；用户说“忘记关于 X 的记忆”时，记忆 Agent 才会读取主题文件和 `MEMORY.md`，再用 `Edit` 或 `Write` 同步修改它们：

```text
用户要求忘记 X
  ↓
Read：读取 MEMORY.md 和相关主题文件
  ↓
判断：X 是整条记忆、某个事实，还是索引指针
  ↓
Edit / Write：更新或移除主题文件内容
  ↓
Edit / Write：同步更新 MEMORY.md
```

只从 `MEMORY.md` 删除索引指针并不充分。`scanMemoryFiles()` 会排除 `MEMORY.md`，但仍会扫描其他主题文件；如果主题文件本体还保留旧事实，它仍可能被 `sideQuery` 选中。

记忆 Agent 的 `Bash` 通常只允许执行只读命令，持久化修改主要通过 `Edit` 和 `Write` 完成。因此，显式遗忘至少要同时检查主题文件本体和 `MEMORY.md` 索引。

`autoDream` 也不是固定 TTL 的垃圾回收任务。它在跨 session 的调度条件满足后，由后台 Agent 根据最近 session 和现有文件判断哪些内容需要合并、修正或删除。当前默认门槛大约是 24 小时和 5 个 session；是否修改文件仍然取决于这次语义整理的结果，不是由一个确定性的过期时间直接决定。

---

## 六、Prompt Cache：稳定性边界如何落地

### 6.1 `SystemPrompt` 保持为数组

`SystemPrompt` 使用 `string[]` 有三个直接收益：

1. 静态段和动态段可以保留结构；
2. 不同模块可以追加一个完整段，而不需要自己处理分隔符；
3. API 层可以按段识别 cache scope，而不是对已经拼平的字符串做脆弱的 substring 判断。

`appendSystemContext()` 也保持这个约定：

```typescript
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

可以这样理解：

- 原来的 prompt 段顺序不变；
- `systemContext` 作为新的尾部段追加；
- 空内容被过滤，不会生成空 block。

### 6.2 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 是结构标记

在 `prompts.ts` 中：

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

`getSystemPrompt()` 会把它放在静态段之后、动态段之前：

```text
[static intro]
[static system rules]
[static task guidance]
[static tool guidance]
[static communication style]
__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
[mode_persona]
[memory]
[env_info]
[mcp_instructions]
...
```

这个字符串不是希望模型理解的自然语言指令。它的用途是让 `splitSysPromptPrefix()` 找到切点：

- marker 之前的普通段可以合并为 static block；
- marker 之后的段合并为 dynamic block；
- marker 自身不会发送给模型。

### 6.3 `splitSysPromptPrefix()` 生成可缓存 block

在启用 global cache 且存在边界标记时，`splitSysPromptPrefix()` 最多生成四类 block：

| block | cache scope | 内容 |
| --- | --- | --- |
| attribution header | `null` | 计费或归因头，不参与 prompt cache |
| system prompt prefix | `null` | 特殊前缀 |
| static block | `global` | boundary 之前的稳定内容 |
| dynamic block | `null` | boundary 之后的会话动态内容 |

核心逻辑可以简化为：

```typescript
const boundaryIndex = systemPrompt.indexOf(
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
)

if (boundaryIndex !== -1) {
  const staticBlocks: string[] = []
  const dynamicBlocks: string[] = []

  for (let i = 0; i < systemPrompt.length; i++) {
    const block = systemPrompt[i]
    if (!block || block === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
      // 边界本身只用于切分，不进入最终请求。
      continue
    }

    if (i < boundaryIndex) {
      staticBlocks.push(block)
    } else {
      dynamicBlocks.push(block)
    }
  }

  return [
    { text: staticBlocks.join('\n\n'), cacheScope: 'global' },
    { text: dynamicBlocks.join('\n\n'), cacheScope: null },
  ]
}
```

实际实现还会单独识别 attribution header 和 CLI system prompt prefix，但核心原则不变：**缓存边界通过数组位置表达，内容分段由 API 层统一完成**。

### 6.4 `buildSystemPromptBlocks()` 最后才添加 `cache_control`

```typescript
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: { querySource?: QuerySource },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, options).map(block => ({
    type: 'text',
    text: block.text,
    ...(enablePromptCaching &&
      block.cacheScope !== null && {
        // 只有允许缓存的 block 才打 cache_control。
        cache_control: getCacheControl({
          scope: block.cacheScope,
          querySource: options?.querySource,
        }),
      }),
  }))
}
```

Prompt Cache 不是在 `getSystemPrompt()` 里直接完成的：

1. prompt builder 只负责生成有顺序的 `string[]`；
2. `splitSysPromptPrefix()` 根据边界计算 cache scope；
3. `buildSystemPromptBlocks()` 根据本次请求是否启用缓存，决定是否写入 `cache_control`。

因此，排查缓存问题时要分别看三件事：

- 动态内容是否错误地放到了 boundary 之前；
- `splitSysPromptPrefix()` 是否识别到了 boundary；
- `enablePromptCaching` 和当前 provider 是否允许使用对应 scope。

### 6.5 MCP 为什么可能改变 system prompt 的缓存方式

当 MCP 工具或动态工具池需要特殊处理时，API 层可能传入 `skipGlobalCacheForSystemPrompt`。这时 `splitSysPromptPrefix()` 会跳过 boundary，改用较保守的组织级缓存方式。

这里仍然会使用缓存，只是放弃 system prompt 的 global scope，避免把会话或组织相关的动态内容误判成全局稳定前缀。缓存策略要服从内容实际可共享的范围。

---

### 推荐的源码阅读顺序

如果要继续深挖，建议按下面顺序打开代码：

1. `src/query.ts`：确认一次 API 调用前 `messagesForQuery` 如何变化。
2. `src/utils/api.ts`：确认 `systemContext` 和 `userContext` 的注入形态。
3. `src/constants/prompts.ts`：查看静态段、动态段和 boundary 的产生位置。
4. `src/constants/systemPromptSections.ts`：查看动态段的缓存与清理。
5. `src/utils/claudemd.ts`：查看项目指令、rules 和 Auto Memory 入口的加载。
6. `src/services/api/claude.ts`：确认最终 API block 和 `cache_control`。
7. `src/utils/attachments.ts`：继续阅读 Memory Prefetch、工具结果和附件如何回灌到 `messages`。

---

## 读完后应该能判断什么

- 看到一段新上下文时，能判断它应该进入 `system`、`messages` 还是 `tools`。
- 看到新的动态信息时，能判断它应该是普通缓存段，还是必须使用 `DANGEROUS_uncachedSystemPromptSection()`。
- 遇到 `CLAUDE.md` 重复或规则不生效时，知道应该先查 `getMemoryFiles()`、`processedPaths` 和条件 glob，而不是直接修改 prompt 字符串。
- 遇到 Prompt Cache miss 时，能沿着 `getSystemPrompt()` → `splitSysPromptPrefix()` → `buildSystemPromptBlocks()` 检查边界。
- 读懂为什么 `queryLoop()` 要维护一个面向 API 的 `messagesForQuery` 投影视图，而不是直接发送原始会话消息。

这就是上下文层在 Harness 中的核心职责：它不决定 Agent 要不要调用工具，也不执行工具本身；它负责在每次模型调用前，把规则、记忆、环境和历史组织成一个可控、可缓存、可恢复的请求视图。
