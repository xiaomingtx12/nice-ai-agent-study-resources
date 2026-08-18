---
slug: /application-notes/engineering/claude-code-cli/cc-17-subagent-isolation
sidebar_position: 17
title: "子 Agent 隔离：上下文、工具与生命周期"
description: "从 AgentTool 的 regular 和 fork 分流出发，拆解子 Agent 的上下文、工具权限、sidechain transcript、后台生命周期和 Git worktree 隔离。"
---

> 子 Agent 隔离的重点不是“再启动一个模型”，而是把一次委派拆成独立的消息、工具、权限、身份和生命周期，再决定哪些信息可以回到父 Agent。
>
> **Harness 层定位**：子 Agent 位于循环层的委派出口。它复用同一套 `query()` 循环，但可以拥有不同的上下文、工具池、权限模式和持久化身份。

# 子 Agent 隔离：上下文、工具与生命周期

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。正文引用的是本地复刻仓库中的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **统一入口**：`packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` 的 `AgentTool.call()` —— 先处理 teammate，再根据 `subagent_type` 和 feature gate 分流到 fork 或 regular。
> - **regular 执行器**：`packages/builtin-tools/src/tools/AgentTool/runAgent.ts` 的 `runAgent()` —— 解析 Agent Definition，创建 system prompt、工具池、权限视图、`createSubagentContext()` 和独立 `query()` 循环。
> - **fork 路径**：`packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` 的 `buildForkedMessages()`、`isInForkChild()` 和 `FORK_AGENT` —— 复用父上下文并维持 prompt cache（提示词缓存）前缀一致。
> - **工具过滤**：`packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts` 的 `filterToolsForAgent()`、`resolveAgentTools()`，以及 `src/utils/agentToolFilter.ts` 的 `filterParentToolsForFork()`。
> - **上下文身份**：`src/utils/forkedAgent.ts` 的 `createSubagentContext()`，以及 `src/utils/agentContext.ts` 的 `AsyncLocalStorage`（异步本地存储）包装。
> - **声明式 Agent**：`packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts` 的 Agent schema、`parseAgentFromMarkdown()` 和 `getActiveAgentsFromList()`。
> - **旁链持久化**：`src/utils/sessionStorage.ts` 的 `recordSidechainTranscript()`、`getAgentTranscriptPath()` 和 `appendEntry()` —— 通过 `agentId` 把子 Agent 消息写入独立 JSONL（逐行 JSON）文件。
> - **文件系统隔离**：`src/utils/worktree.ts` 的 worktree 创建、复用、变更检测和清理逻辑；它和消息上下文隔离是两个独立维度。

## 先给结论：隔离不是一个开关

“子 Agent 隔离”容易被理解成“子进程有自己的目录”。当前实现至少包含四个维度：

| 隔离维度 | 解决的问题 | 主要源码 |
|---|---|---|
| 消息上下文隔离 | 父 Agent 的搜索过程是否进入子 Agent，子 Agent 的中间过程是否污染父上下文 | `runAgent.ts`、`forkSubagent.ts` |
| 工具与权限隔离 | 子 Agent 能调用哪些工具、使用哪种权限模式、父级授权是否会泄漏 | `agentToolUtils.ts`、`runAgent.ts`、`permissions.ts` |
| 身份与持久化隔离 | 多个子 Agent 的消息、状态和恢复入口如何区分 | `agentId`、`sessionStorage.ts`、`agentContext.ts` |
| 文件系统隔离 | 多个 Agent 是否在同一个工作目录修改文件 | `AgentTool.tsx`、`worktree.ts` |

后台运行又是另一个维度。它决定父 Agent 是否立即继续，而不等于已经创建了独立进程。

因此，下面几句话不能互换：

- “上下文独立”不代表“文件目录独立”；
- “工具白名单不同”不代表“权限已经完全隔离”；
- “写入 sidechain 文件”不代表“子 Agent 在独立进程运行”；
- “后台运行”不代表“可以无限递归创建子 Agent”。

---

## 一、从 `AgentTool.call()` 看真实分流

### 1.1 AgentTool 先判断调用形态

父 Agent 通过 `AgentTool` 发起子任务。`AgentTool.call()` 的顺序不是简单的“读取类型 → 启动子循环”，而是先处理特殊协作形态：

```text
AgentTool.call()
  │
  ├─► team_name + name
  │     └─► spawnTeammate()
  │
  ├─► 未指定 subagent_type
  │     ├─ fork feature gate 开启 → fork path
  │     └─ feature gate 关闭 → general-purpose
  │
  └─► 指定 subagent_type
        └─► 从 activeAgents 解析 regular Agent Definition
```

teammate 是持续协作协议的一部分，拥有团队身份、mailbox（消息邮箱）和任务协作面，详细实现放在 [19 Agent Teams](cc-19-agent-teams.md)。本文的主体是普通一次性委派和 fork。

### 1.2 未指定 `subagent_type` 不一定就是 fork

当前源码采用 feature gate（功能闸门）控制隐式 fork：

```typescript
// subagent_type 明确指定时，显式类型优先
const effectiveType =
  subagent_type ??
  (isForkSubagentEnabled()
    ? undefined
    : GENERAL_PURPOSE_AGENT.agentType)

// undefined 只表示进入 fork path
const isForkPath = effectiveType === undefined
```

`isForkSubagentEnabled()` 还会检查运行环境：

- fork feature 是否开启；
- 当前是否已经是 coordinator mode（协调模式）；
- 当前是否为 non-interactive session（非交互会话）。

所以文章不能把“省略 `subagent_type`”直接解释成永久稳定的产品语义。它是当前源码中的实验性分流条件。

### 1.3 Agent 类型解析还受权限规则影响

regular 路径会从 `activeAgents` 中查找目标 Agent，并通过 `filterDeniedAgents()` 排除命中 `Agent(AgentName)` 拒绝规则的定义。

这意味着 Agent 类型本身也是权限系统的资源：

```text
AgentTool(Explore)
  → activeAgents 查找 Explore
  → Agent(Explore) 规则过滤
  → 找到且允许 → runAgent()
  → 找到但被 deny → 报权限错误
  → 不存在 → 报可用 Agent 类型列表
```

`AgentTool` 的 `checkPermissions()` 在普通模式通常返回 allow；在 auto mode（自动权限模式）下，特定构建会把“是否允许创建子 Agent”交给分类器。这与子 Agent 内部工具的权限判断是两层不同的检查。

---

## 二、regular subagent：独立上下文，但复用同一循环

### 2.1 regular subagent 不是另一套 Agent Runtime

regular subagent 仍然调用同一个 `query()`：

```text
父 Agent
  └─► AgentTool.call()
        └─► runAgent()
              ├─► 创建子 Agent system prompt
              ├─► 创建子 Agent ToolUseContext
              ├─► 写入 sidechain transcript
              └─► query({ messages, systemPrompt, ... })
```

它不是另写一套“子 Agent 推理循环”，而是在相同 Runtime 上替换上下文参数：

- `messages` 换成子任务自己的初始消息；
- `systemPrompt` 换成 Agent Definition 的提示词；
- `availableTools` 换成子 Agent 的工具池；
- `toolUseContext` 换成 `createSubagentContext()` 返回的上下文；
- `querySource` 和 `agentId` 标识当前调用来源。

这种复用让主 Agent 和子 Agent 共享消息协议、工具执行协议和压缩机制，同时又能在参数层实现隔离。

### 2.2 regular 默认只接收自己的任务描述

regular 路径通常构造：

```typescript
// regular path 不把父对话 messages 整体传给子 Agent
const promptMessages = [
  createUserMessage({
    content: prompt,
  }),
]

// 子 Agent 使用自己 Agent Definition 生成 system prompt
const agentPrompt = selectedAgent.getSystemPrompt({
  toolUseContext,
})
```

这就是上下文裁剪的第一层：父 Agent 可以把“请检查认证模块的测试覆盖率”交给 Explore，但不会自动把父 Agent 已经读过的几十个文件、每个工具结果和所有中间推理一并复制进去。

子 Agent 仍会获得运行所需的环境信息，例如工作目录和系统上下文。这里的隔离不是“什么都没有”，而是“只继承运行所需的最小输入”。

### 2.3 system prompt、模型和工具池分别决定角色

Agent Definition 不只是一个名称。当前 schema 支持：

| 字段 | 作用 |
|---|---|
| `prompt` | Agent 的角色指令 |
| `model` | 指定模型，默认可继承父 Agent |
| `tools` | 工具白名单 |
| `disallowedTools` | 工具黑名单 |
| `permissionMode` | 子 Agent 的权限模式 |
| `maxTurns` | 最大 Agentic turn（自主循环轮次） |
| `skills` | 启动时预加载的 Skill |
| `hooks` | 子 Agent 生命周期内注册的 Hook |
| `memory` | `user`、`project`、`local` 三种记忆范围 |
| `isolation` | `worktree` 或受限构建中的 `remote` |
| `background` | 是否默认后台运行 |

模型继承不是简单复制字符串。`getAgentModel()` 会根据父模型、别名和 provider（模型服务商）解析最终模型；`inherit` 的含义是“按当前运行模式解析父级模型”，而不是永远固定某个模型版本。

### 2.4 工具池是子 Agent 的第一道边界

regular Agent 的工具池由 `resolveAgentTools()` 生成，过程可以概括为：

```text
父级可用工具
  → 过滤所有 Agent 禁用工具
  → 根据 async 状态过滤后台不安全工具
  → 应用 Agent Definition 的 tools
  → 应用 disallowedTools
  → 合并 Agent 专属 MCP 工具
  → 去重后交给 query()
```

其中 `filterToolsForAgent()` 会处理公共禁用集合和 async 工具集合：

```typescript
return tools.filter(tool => {
  // MCP 工具保留，具体安全性由 MCP 和权限层继续判断
  if (tool.name.startsWith('mcp__')) return true

  // Agent、任务控制和某些主线程工具不能默认下放
  if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false

  // 后台 Agent 只保留适合无交互运行的工具
  if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
    return false
  }

  return true
})
```

工具过滤不是完整的权限系统。工具进入子 Agent 工具池后，仍会通过 `canUseTool()` 和权限模式判断；工具未进入池中，则连权限请求的机会都没有。

### 2.5 子 Agent 的权限视图不会盲目继承父级

`runAgent()` 会根据 Agent Definition 生成 `agentGetAppState()`：

- Agent Definition 指定 `permissionMode` 时，普通模式下可以覆盖子 Agent 的 mode；
- 父级处于 `bypassPermissions`、`acceptEdits` 或 auto 相关模式时，父级模式优先；
- async Agent 默认设置 `shouldAvoidPermissionPrompts`，避免后台运行时挂起等待终端；
- 显式允许的 `allowedTools` 会替换 session 级 allow 规则；
- `cliArg` 级别的允许规则仍然保留，因为它代表调用方显式传入的权限。

可以把它理解成“权限视图重建”，而不是“把父 Agent 的全部授权对象复制一份”。

一个重要的安全目标是防止父级一次点击的授权无边界泄漏到所有子 Agent。源码注释明确指出，传入 `allowedTools` 时会清理父级 session 规则，只保留子 Agent 明确声明的会话授权和 `cliArg` 授权。

---

## 三、上下文对象怎样实现隔离

### 3.1 `createSubagentContext()` 复制什么，复用什么

`createSubagentContext()` 位于 `src/utils/forkedAgent.ts`。它不是简单的对象浅拷贝，而是根据 sync/async 和 fork/regular 组合决定哪些字段共享、哪些字段新建：

| 上下文字段 | sync regular | async regular | fork |
|---|---|---|---|
| `messages` | 子任务消息 | 子任务消息 | 父消息 + fork 消息 |
| `agentId` | 新 ID | 新 ID | 新 ID |
| `readFileState` | 新缓存 | 新缓存 | clone 父缓存 |
| `abortController` | 通常共享父级 | 新建且不链接父级 | 按路径传入 |
| `setAppState` | 可共享 | 通常不直接共享 | 按调用方配置 |
| `toolPermissionContext` | 子 Agent 视图 | 子 Agent 视图 | bubble 权限视图 |
| `systemPrompt` | Agent Definition | Agent Definition | 父级已渲染 prompt |

`readFileState` 是文件读取缓存状态。fork 需要 clone 它，是因为父消息和工具结果的替换决定必须保持一致；regular 没有父消息 UUID 对齐要求，使用新缓存即可。

### 3.2 sync 与 async 的共享边界

同步子 Agent 会在父 Agent 的当前调用中持续运行，因此可以共享部分回调和取消信号。后台子 Agent 则需要独立生命周期：

```typescript
const agentAbortController = override?.abortController
  ? override.abortController
  : isAsync
    ? new AbortController()        // 后台 Agent 独立取消
    : toolUseContext.abortController // 同步 Agent 跟随父级

const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,
  agentId,
  messages: initialMessages,
  abortController: agentAbortController,
  // sync 可共享 AppState，async 默认避免直接共享
  shareSetAppState: !isAsync,
})
```

后台 Agent 不会因为用户按一次 ESC 就自动和主线程一起结束；源码注释明确说明，后台 Agent 需要通过任务控制接口显式终止。

### 3.3 用 `AsyncLocalStorage` 保存异步身份

多个后台 Agent 可以在同一个 Node.js 进程中交错运行。如果把当前 Agent 身份只放在全局 `AppState`，Agent A 的事件可能被 Agent B 覆盖。

`src/utils/agentContext.ts` 使用 `AsyncLocalStorage`（异步本地存储）把 `agentId`、Agent 类型、调用来源等信息绑定到当前异步执行链：

```typescript
const agentContextStorage = new AsyncLocalStorage<AgentContext>()

export function runWithAgentContext<T>(
  context: AgentContext,
  fn: () => T,
): T {
  // 当前 fn 以及其中创建的 await 链都读取同一个 Agent 身份
  return agentContextStorage.run(context, fn)
}
```

这解决的是“并发执行时身份串线”，不是消息内容隔离。消息隔离仍然由 `messages`、`agentId` 和 sidechain transcript 完成。

### 3.4 Explore 和 Plan 的上下文裁剪

`runAgent()` 对只读型 Explore、Plan Agent 做了额外裁剪：

- 在 feature flag 允许时移除 `CLAUDE.md` 层级上下文；
- 移除父会话启动时捕获的 `gitStatus`；
- 如果它们需要最新 Git 状态，自己调用工具读取，而不是使用可能过期的快照。

这不是权限隔离，而是上下文成本优化。主 Agent 仍然拥有完整项目规则，并负责解释子 Agent 的搜索结果。

---

## 四、fork subagent：共享父上下文，但不是共享父状态

### 4.1 fork 解决什么问题

regular subagent 适合“把一个独立问题交给另一个角色”。fork 更适合“保持当前推理背景，同时让多个 worker 分别处理不同 directive（指令）”。

fork 的目标不是最大限度减少输入，而是：

- 让子 Agent看到父 Agent 当前的工具调用和上下文；
- 让多个子 Agent 使用相同的 API 请求前缀；
- 通过 prompt cache 减少重复传输和计算；
- 把每个 worker 的新任务从父消息末尾分开。

### 4.2 `buildForkedMessages()` 如何构造消息

fork 不直接把一个新用户消息拼到父历史后面。它会复制父级完整的 assistant message，再为所有 `tool_use` 构造统一 placeholder（占位结果）：

```typescript
const fullAssistantMessage = {
  ...assistantMessage,
  // 复制消息对象，避免修改父级消息
  uuid: randomUUID(),
}

const toolResultBlocks = toolUseBlocks.map(block => ({
  type: 'tool_result' as const,
  tool_use_id: block.id,
  content: [
    {
      // 所有 fork 子 Agent 使用完全相同的占位文本
      type: 'text' as const,
      text: 'Fork started — processing in background',
    },
  ],
}))

return [
  fullAssistantMessage,
  createUserMessage({
    content: [
      ...toolResultBlocks,
      // 只有最后的 directive 因子任务而不同
      { type: 'text', text: buildChildMessage(directive) },
    ],
  }),
]
```

这样形成的结构是：

```text
父历史
  → 父 assistant message（完整保留）
  → 每个 tool_use 对应相同 placeholder tool_result
  → 当前 fork worker 的 directive
```

前面的消息和占位结果保持一致，只有最后的指令不同。这样可以最大化 prompt cache 命中。

### 4.3 为什么要使用父级已渲染 system prompt

`AgentTool.call()` 在 fork 路径优先使用 `toolUseContext.renderedSystemPrompt`。如果没有缓存的已渲染结果，才尝试重新构造。

原因是 prompt cache 依赖字节级一致：

```text
父 Agent 已发送的 system prompt 字节
  ≠ 重新调用 getSystemPrompt() 得到的字节
  → API 请求前缀不同
  → prompt cache 可能失效
```

重新构造时，GrowthBook（功能实验配置）状态、环境信息或工具顺序发生变化，都可能让前缀产生差异。因此 fork 路径更重视“复用已渲染结果”，而不是“重新得到一个看起来相同的 prompt”。

### 4.4 `useExactTools` 不是无条件继承所有工具

fork 需要父子工具定义尽量一致，所以会传入：

```typescript
{
  availableTools: filterParentToolsForFork(parentTools),
  useExactTools: true,
  forkContextMessages: toolUseContext.messages,
}
```

`useExactTools: true` 会让 `runAgent()` 跳过普通 `resolveAgentTools()` 的再次过滤。为了不因此绕过 Agent 禁用工具集合，fork 入口先调用 `filterParentToolsForFork()`。

这是两层过滤：

1. regular 路径在 `filterToolsForAgent()` 中过滤；
2. fork 路径因为必须保持精确工具数组，所以在进入 `useExactTools` 前单独过滤父工具数组。

如果只保留第一层，fork 的“精确工具”路径可能意外带入只应该留在主线程的工具。

### 4.5 fork 是共享输入，不是共享可变状态

fork 继承父消息和 system prompt，但仍然创建：

- 新的 `agentId`；
- 子 Agent 自己的 `ToolUseContext`；
- clone 后的文件读取缓存；
- 独立的 sidechain transcript；
- 自己的 query 生命周期和输出结果。

所以“共享父上下文”不等于“父子 Agent 共用同一个可变消息数组”。源码会复制或 clone 需要隔离的对象，并在 `finally` 中释放子 Agent 的缓存和 transcript 映射。

### 4.6 fork 递归保护

fork 子 Agent 仍然需要保留与父级一致的 Agent 工具定义，才能让工具数组保持 cache-identical（缓存一致）。这会带来递归风险：子 Agent 可能再次调用 Agent 工具创建 fork。

源码在调用时检查两类信号：

```typescript
if (
  toolUseContext.options.querySource === 'agent:builtin:fork' ||
  isInForkChild(toolUseContext.messages)
) {
  throw new Error(
    'Fork is not available inside a forked worker.',
  )
}
```

`isInForkChild()` 会搜索 `<FORK_BOILERPLATE_TAG>`。`querySource` 用于抵抗 compact（上下文压缩）对消息内容的改写，消息扫描则作为兼容路径。

这不是靠“希望模型不要递归”来防止爆炸，而是把递归限制放到工具调用边界。

---

## 五、Agent Definition：角色配置也是隔离边界

### 5.1 Agent Definition 从哪里来

`loadAgentsDir.ts` 会把不同来源的 Agent 合并成 `activeAgents`：

```text
built-in
  → plugin
  → userSettings
  → projectSettings
  → flagSettings
  → policySettings
```

同名 Agent 后出现的定义覆盖前面的定义。它不是简单读取一个目录，而是把内置 Agent、插件 Agent、用户配置、项目配置、命令行或策略配置合并成可解析集合。

自定义 Agent 通常通过 Markdown frontmatter（文件头元数据）声明：

```yaml
---
name: code-reviewer
description: 检查改动中的风险和测试缺口
tools: Read, Grep, Glob
model: inherit
permissionMode: default
maxTurns: 20
memory: project
---

你是代码审查 Agent，只分析问题，不直接修改文件。
```

解析后，`AgentDefinition` 决定：

- 角色提示词；
- 工具白名单和黑名单；
- 模型与 effort；
- 权限 mode；
- 最大循环轮次；
- 预加载 Skill；
- Agent 级 Hook；
- 记忆范围；
- worktree 或 remote 隔离；
- 是否默认后台运行。

### 5.2 `memory` 是能力声明，不是 transcript 隔离

自定义 Agent 的 `memory` 可以是 `user`、`project` 或 `local`。启用自动记忆后，源码会把相应记忆提示词附加到 Agent system prompt，并在需要时注入 Read、Write、Edit 工具。

这与 sidechain transcript 是两条不同的链：

```text
sidechain transcript
  → 保存这次 Agent 运行过程和恢复所需消息

Agent memory
  → 跨运行沉淀该 Agent 的长期知识或工作记录
```

不能因为 transcript 写入了子目录，就说这个 Agent 已经拥有长期记忆；也不能因为 Agent 有 `memory` 字段，就说父 Agent 的完整对话会被复制给它。

### 5.3 Agent 级 Hook 的生命周期边界

`runAgent()` 会先执行 `SubagentStart` Hook，收集额外上下文；然后注册 Agent Definition 中的 frontmatter Hook；Agent 结束时清理 session Hook。

这说明子 Agent 有自己的生命周期事件，但它们仍然受 `cc-15` 所讲的通用 Hook 执行器管理。本文只需要关注：Hook 注入的是上下文或生命周期行为，不等于把父 Agent 的全部消息自动共享给子 Agent。

---

## 六、sidechain transcript：过程存档与主上下文隔离

### 6.1 为什么要单独保存 transcript

子 Agent 的搜索过程、工具调用和中间消息通常不应该全部进入父 Agent 的下一轮上下文，但它们仍然有价值：

- 用户需要查看子 Agent 的进度；
- 后台任务完成后需要读取结果；
- `SendMessage` 继续某个 Agent 时需要恢复其历史；
- 调试和可观测性需要完整调用链。

因此源码采用 sidechain transcript（旁链对话记录）：

```text
主会话 transcript
  └─ 保留 AgentTool 的 tool_use / tool_result 和必要摘要

子 Agent sidechain
  └─ subagents/agent-<agentId>.jsonl
     保存子 Agent 自己的消息链
```

### 6.2 写入路由由 `agentId` 和 `isSidechain` 决定

`recordSidechainTranscript()` 最终调用 `insertMessageChain(..., true, agentId, ...)`。在 `appendEntry()` 中，带有 Agent 身份的旁链记录会被路由到 `getAgentTranscriptPath(agentId)`：

```typescript
const targetFile = entry.agentId
  ? getAgentTranscriptPath(entry.agentId)
  : sessionFile

// isSidechain 的消息也会按照 agentId 写入子 Agent 文件
```

文件路径位于当前项目和 session 目录下的 `subagents` 子目录中。具体路径由 `getAgentTranscriptPath()` 计算，不应在文章里写成固定的全局绝对路径。

### 6.3 旁链保存什么，父 Agent看到什么

同步 Agent完成后，`finalizeAgentTool()` 从子 Agent 消息中提取文本内容、token 使用量、工具调用次数和耗时，再包装为父 Agent 的 `tool_result`。

父 Agent通常只看到：

```text
子 Agent 的最终文本
+ 必要的 agentId / usage 信息
+ worktree 路径等元数据
```

它不会自动看到子 Agent每一次 `Read`、`Grep` 和 `Bash` 的完整过程。需要查看过程时，系统通过 transcript、输出文件或后台任务状态提供其他入口。

---

## 七、同步、后台与恢复：生命周期怎样分开

### 7.1 同步路径：当前 tool_use 等待完成

同步 regular subagent 会在 `AgentTool.call()` 内迭代 `runAgent()` 的异步生成器，直到子 Agent完成、出错或被中止：

```text
AgentTool.call()
  → runAgent()
  → query() 多轮循环
  → finalizeAgentTool()
  → status: completed
  → mapToolResultToToolResultBlockParam()
  → 父 Agent 下一轮
```

同步不是“没有异步”。`query()` 仍然是异步生成器，只是父工具调用等待它完成后才返回最终 `tool_result`。

### 7.2 后台路径：先返回 launched，再异步通知

当满足下列任一条件时，`shouldRunAsync` 可能为 true：

- 输入显式 `run_in_background: true`；
- Agent Definition 设置 `background: true`；
- coordinator mode；
- fork feature gate 强制后台；
- 某些 assistant 或 proactive 模式。

后台路径先注册 Async Agent 任务，立即返回：

```typescript
return {
  data: {
    isAsync: true,
    status: 'async_launched',
    agentId: agentBackgroundTask.agentId,
    description,
    prompt,
    outputFile: getTaskOutputPath(agentBackgroundTask.agentId),
  },
}
```

随后 `runAsyncAgentLifecycle()` 在后台运行 `runAgent()`，完成后更新任务状态并发送通知。父 Agent不会因为这次 `tool_result` 阻塞到子 Agent结束。

`async_launched` 只表示“已经登记并开始后台运行”，不表示任务成功，更不表示已经有最终答案。

### 7.3 前台运行也可能自动转后台

同步 Agent开始时会注册 foreground task（前台任务），并监听 `autoBackgroundMs`。如果任务执行时间超过阈值，系统可以：

1. 关闭当前前台迭代器；
2. 以 async 方式重新接管同一个任务；
3. 继续使用原 Agent ID 和已累积消息；
4. 返回 `async_launched`，后续用后台通知完成。

因此，前台/后台不是创建时永远固定的二选一，而是允许在运行中发生生命周期转换。

### 7.4 取消边界

同步 Agent通常跟随父级 `AbortController`；后台 Agent使用独立的取消控制器，不会因为主线程短暂取消输入就自动消失。

后台任务的终止需要通过任务控制能力执行。本文不展开后台任务框架的注册表、通知运输和输出读取，相关实现见 [21 后台任务框架](../05-async-orchestration/cc-21-background-task-framework.md)。

---

## 八、worktree：文件系统隔离是另一条轴

### 8.1 `isolation: worktree` 解决文件冲突

Agent Definition 或工具输入可以指定 `isolation: 'worktree'`。`AgentTool.call()` 会先创建 Git worktree，再通过 `runWithCwdOverride()` 让子 Agent在该目录中运行。

```text
主仓库
  │
  ├─► createAgentWorktree("agent-<id>")
  │     ├─ 创建 .claude/worktrees 下的工作树
  │     └─ 创建对应分支
  │
  └─► runWithCwdOverride(worktreePath, runAgent)
        └─ 子 Agent 的文件操作落在独立工作树
```

worktree 是 Git 层的工作目录隔离，不会自动改变：

- 子 Agent 的消息上下文；
- Agent system prompt；
- 工具白名单；
- 权限模式；
- sidechain transcript。

反过来，regular subagent 即使拥有独立 messages，也可能仍然在主工作目录中修改文件。

### 8.2 清理策略不是“任务结束就删除”

子 Agent结束后，源码会检查 worktree 是否产生变化：

- 没有变化：删除工作树并清理元数据；
- 有变化：保留 worktree 和分支，向结果中带回路径；
- Hook-based worktree：因为无法用同一套 Git 变更检测，默认保留。

这让用户可以继续查看或提取子 Agent的改动，而不是在任务结束时无条件丢弃。

### 8.3 worktree 不等于合并

worktree 只负责把文件操作分开，不能自动解决：

- 两个 Agent 修改同一逻辑的冲突；
- 哪个分支应该合并；
- 子 Agent 的结果是否通过测试；
- 父 Agent是否应该采纳这些改动。

文件系统隔离降低了互相覆盖的风险，结果审查和合并仍然属于父 Agent 或用户的决策。

---

## 九、三种 Agent 形态怎样选

| 形态 | 上下文 | 工具与权限 | 生命周期 | 适合场景 |
|---|---|---|---|---|
| regular subagent | 默认只接收任务 prompt | 独立解析工具池和权限视图 | 可同步或后台 | 探索、验证、独立子任务 |
| fork subagent | 继承父消息和已渲染 system prompt | 尽量使用父工具定义，但先做 fork 专用过滤 | 当前 gate 下通常后台运行 | 保持父背景的并行处理 |
| teammate | 不依赖父完整对话，拥有团队身份和协作协议 | 由 Team/Agent 配置决定 | 可多轮收发消息，直到显式关闭 | 持续协作、双向沟通、多成员任务 |

选择依据不是“哪个更强”，而是任务是否需要：

- 父 Agent 的完整上下文；
- 独立或共享的文件目录；
- 一次性结论还是持续通信；
- 父循环是否需要立即继续；
- 是否需要把任务状态放入团队协作面。

其中 teammate 的详细协议见 [19 Agent Teams](cc-19-agent-teams.md)，后台生命周期运输见 [21 后台任务框架](../05-async-orchestration/cc-21-background-task-framework.md)。

---

## 十、几个容易写错的结论

### 10.1 “子 Agent 一定在独立进程中运行”

不准确。

regular 和 fork 可以在同一 Node.js 进程中以异步生成器运行。`AsyncLocalStorage` 隔离的是异步身份，sidechain transcript 隔离的是持久化消息，二者都不等于 OS 进程隔离。

### 10.2 “regular subagent 会继承父 Agent 的全部对话”

不准确。

regular 默认用自己的任务 prompt 构造初始消息；fork 才会复制父 assistant message、tool placeholder 和父级上下文。

### 10.3 “fork 使用 exact tools，所以它能调用父级所有敏感工具”

不准确。

fork 在 `useExactTools` 之前通过 `filterParentToolsForFork()` 应用主线程工具禁用集合。精确继承是为了 prompt cache 一致，不是为了取消工具安全边界。

### 10.4 “子 Agent 继承父级权限规则就一定安全”

不准确。

子 Agent会重新构造权限视图。`allowedTools` 可以替换 session 规则，async Agent 还可能被设置为不显示权限提示；父级 `cliArg` 权限则按源码保留。

### 10.5 “sidechain transcript 就是长期记忆”

不准确。

sidechain 保存一次或一组 Agent运行过程；`memory` 字段才是 Agent长期记忆能力的声明，二者作用范围和读取方式不同。

### 10.6 “worktree 隔离后上下文也自然隔离”

不准确。

worktree只改变当前工作目录；消息、system prompt、工具池和权限仍由 regular/fork 路径决定。

### 10.7 “后台返回 `async_launched` 就等于任务成功”

不准确。

它只说明任务已注册并开始运行。最终结果要等后台生命周期完成，再由任务状态、通知或输出文件提供。

### 10.8 “fork 可以继续无限创建 fork”

不准确。

源码通过 `querySource` 和 `<FORK_BOILERPLATE_TAG>` 双重检查，在工具调用边界拒绝 fork 子 Agent再次 fork。

---

## 总结

子 Agent 隔离可以沿着下面的真实调用主线理解：

```text
AgentTool.call()
  → teammate / fork / regular 分流
  → 解析 Agent Definition
  → 创建子 Agent 的 prompt、工具池和权限视图
  → createSubagentContext()
  → query() 独立循环
  → sidechain transcript 持久化
  → sync completed 或 async_launched
  → tool_result、通知或恢复入口
```

最重要的四个边界是：

1. **上下文隔离**：regular 默认不复制父历史，fork 才复制父消息并追求缓存前缀一致。
2. **工具和权限隔离**：子 Agent重新构造工具池和权限视图，父级 session 授权不会无条件泄漏。
3. **持久化隔离**：`agentId`、`isSidechain` 和 `subagents/agent-<id>.jsonl` 让过程可查看、可恢复，但不会污染主 transcript。
4. **文件和生命周期隔离**：worktree 负责文件冲突，async 负责运行时机；它们都不能替代上下文、工具和权限隔离。

因此，子 Agent不是“把主 Agent复制一份”。它是同一 `query()` Runtime 上的一组可配置隔离边界：父 Agent只把真正需要的任务和结果放在主循环里，把中间过程、工具范围、身份和文件改动控制在子执行单元内部。

**相关源码**：`packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` · `packages/builtin-tools/src/tools/AgentTool/runAgent.ts` · `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` · `packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts` · `packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts` · `src/utils/forkedAgent.ts` · `src/utils/agentContext.ts` · `src/utils/agentToolFilter.ts` · `src/utils/sessionStorage.ts` · `src/utils/worktree.ts`
