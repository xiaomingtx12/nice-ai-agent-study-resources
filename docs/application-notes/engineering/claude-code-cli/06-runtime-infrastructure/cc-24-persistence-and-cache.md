---
slug: /application-notes/engineering/claude-code-cli/cc-24-persistence-and-cache
sidebar_position: 24
title: "持久化与缓存"
description: "沿着 transcript 写入、恢复、分支修复、内存 cache、Prompt Cache 和远端 hydrate，拆解 Claude Code 的会话持久化机制。"
---

> 本篇讨论“会话如何被保存、恢复和复用”。定时任务的任务文件见 [23 定时任务](../05-async-orchestration/cc-23-scheduled-tasks.md)，上下文装配、模型窗口和记忆系统见 [06 上下文装配](../02-agent-runtime/cc-06-context-assembly.md)。

# 持久化与缓存：让 Agent 会话可以继续

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；正文使用函数名和调用关系定位，不把容易漂移的行号作为唯一依据。
>
> **核心路径**：
>
> - **transcript 路径与写入**：`src/utils/sessionStorage.ts` 的 `recordTranscript()`、`insertMessageChain()`、`appendEntry()`、`drainWriteQueue()`——负责去重、补 `parentUuid`、写入 JSONL 和批量刷盘。
> - **transcript 恢复**：`src/utils/sessionStorage.ts` 的 `loadTranscriptFile()`、`buildConversationChain()`、`recoverOrphanedParallelToolResults()`——从物理日志重建当前有效消息链。
> - **大文件读取与边界扫描**：`src/utils/sessionStoragePortable.ts` 的 `readTranscriptForLoad()`、`readHeadAndTail()`、`SKIP_PRECOMPACT_THRESHOLD`——定位 `compact_boundary`，避免恢复时无条件把整个大文件加载进内存。
> - **删除和分支修复**：`src/utils/sessionStorage.ts` 的 `removeMessageByUuid()`、`insertContentReplacement()`、`insertQueueOperation()`、`insertAttributionSnapshot()`——处理尾部删除、内容替换、队列恢复和 attribution snapshot（归因快照）。
> - **transcript 类型**：`src/types/logs.ts`——定义 JSONL entry、消息、compact metadata 和其他持久化记录。
> - **resume 状态切换**：`src/bootstrap/state.ts`、`src/utils/sessionRestore.ts`——切换 session、清理相关 cache，并重新装配恢复所需的运行时状态。
> - **Prompt Cache 请求装配**：`src/services/api/claude.ts` 的 `getCacheControl()`、`addCacheBreakpoints()`、`buildSystemPromptBlocks()`——给 provider 请求前缀添加缓存标记，不改变本地 transcript。
> - **系统上下文与 memory cache**：`src/context.ts`、`src/utils/claudemd.ts` 的 `getMemoryFiles()`、`clearMemoryFileCaches()`、`resetGetMemoryFilesCache()`——读取和失效 `CLAUDE.md`、规则文件及记忆文件 cache。
> - **Skill / MCP cache**：`src/services/skillSearch/localSearch.ts`、`src/services/mcp/client.ts`——分别维护 Skill 检索索引和 MCP 连接/能力列表 cache。
> - **CCR 远端同步**：`src/services/api/sessionIngress.ts`、`src/utils/sessionStorage.ts` 的 `persistToRemote()`、`hydrateRemoteSession()`、`hydrateFromCCRv2InternalEvents()`——处理远端追加、全量灌入和 v2 internal event（内部事件）恢复。
>
> **一次会话从写入到恢复的调用关系**：
>
> ```text
> Agent turn 产生 user / assistant / tool_result
>   ↓
> recordTranscript()
>   ↓
> cleanMessagesForLogging() + getSessionMessages()
>   ↓
> insertMessageChain()
>   ↓
> appendEntry()
>   ↓
> pendingEntries / write queue
>   ↓
> drainWriteQueue()
>   ↓
> sessionId.jsonl
>   ↓
> resume
>   ↓
> readTranscriptForLoad()
>   ↓
> loadTranscriptFile()
>   ├─ compact / snip / preserved segment 投影
>   ├─ leafUuids
>   └─ buildConversationChain()
>   ↓
> 当前有效 conversation chain
>   ↓
> buildSystemPromptBlocks() + addCacheBreakpoints()
>   ↓
> provider 请求
> ```

## 先给结论

Claude Code 的持久化层不是一个简单的“把聊天记录写到文件”功能。

它同时维护三种不同性质的数据：

```text
transcript JSONL
  → 恢复会话、构建 parentUuid 链、支持 resume

进程内 cache
  → 避免重复读文件、重复解析记忆、重复连接 MCP

Prompt Cache
  → 让 provider 复用请求前缀，减少重复计算和 token 成本
```

这三种数据不能混为一谈：

- transcript 是持久化真源，进程退出后仍然存在；
- 内存 cache 是派生数据，清空后可以重新计算；
- Prompt Cache 在模型服务端生效，不能替代本地 resume；
- `CLAUDE.md`、`MEMORY.md` 等记忆文件是下一轮 prompt 的输入材料，不等于 transcript；
- compact、snip 和 context collapse 的边界会写入 transcript，但具体的 token 预算与模型窗口判断由上下文层负责。

本篇最重要的一句话是：

> **磁盘保存“发生过什么”，内存 cache 加速“怎么找到它”，Prompt Cache 优化“怎么再次发送它”。**

## 一、持久化层要解决什么问题

Agent 会话和普通聊天记录有三个不同点。

### 1.1 一轮输出不是一次性完成的

一次 Agent turn（回合）可能包含：

```text
user message
  ↓
assistant message
  ↓
tool_use
  ↓
tool_result
  ↓
assistant 继续推理
```

这些消息不是平铺的文本，而是相互引用的结构。

如果进程在中途退出，恢复时必须知道：

- 哪一条消息是当前分支的叶子；
- 下一条消息应该挂在哪个父节点；
- 哪些工具调用已经有结果；
- 哪些内容只是临时进度，不应该参与恢复；
- compact 或 snip 后，哪些旧消息仍然属于当前上下文。

### 1.2 会话可能有多个分支

`--resume`、`--fork-session`、重新生成和并行工具调用都会让一个 session 出现多个分支。

因此，transcript 更接近：

```text
消息节点 + parentUuid 引用
```

而不是：

```text
一行接一行的不可分叉聊天列表
```

### 1.3 恢复不能把所有历史都无条件加载

长 session 可能包含：

- 被 fork 后放弃的分支；
- compact 前已经被摘要替代的历史；
- snip 删除的中间区间；
- 大量 attribution snapshot；
- 已经结束但不再参与当前对话的工具进度。

如果 resume 每次都把整个文件解析成完整消息数组，再从头构建当前链，时间和内存都会随着历史增长。

所以当前实现把“正确性”和“读取成本”一起考虑：

```text
写入时保留足够的结构
  ↓
恢复时先定位有效边界
  ↓
再解析并修复当前链
```

## 二、三层数据模型

### 2.1 第一层：transcript JSONL

JSONL（JSON Lines，逐行 JSON）是会话的持久化真源。

当前 session 的路径由 `getTranscriptPath()` 计算，典型形式是：

```text
<claude-config-home>/projects/<sanitized-project>/<sessionId>.jsonl
```

如果当前 session 运行了 subagent，还会有：

```text
<project-dir>/<sessionId>/subagents/agent-<agentId>.jsonl
```

Agent 还可能有伴随元数据文件：

```text
agent-<agentId>.meta.json
```

sidecar（伴随元数据文件）保存 `agentType`、worktree 路径和原始任务描述，避免为了恢复 Agent 类型而改变主 transcript 的结构。

### 2.2 第二层：进程内 cache

内存 cache 只保存可以重新计算的数据，例如：

- 某个 session 已经有哪些 UUID；
- `CLAUDE.md` 和规则文件的解析结果；
- Skill 搜索索引；
- MCP 连接、工具、资源和命令列表；
- project path 的规范化结果。

这些 cache 的共同特点是：

```text
命中 → 少做一次 I/O 或计算
失效 → 回到磁盘或连接层重新计算
```

它们不是 resume 的真源。

### 2.3 第三层：Prompt Cache

Prompt Cache 是 API 请求层的缓存标记。

`src/services/api/claude.ts` 会在 system prompt、工具 Schema 和消息前缀上添加 `cache_control`。

它优化的是：

```text
本轮请求和上一轮请求有很长的相同前缀
  ↓
provider 尽量复用这个前缀
```

它不负责：

- 生成本地 transcript；
- 选择 resume 叶子；
- 修复 `parentUuid`；
- 从 compact boundary 恢复消息。

## 三、写入生命周期：从消息到 JSONL

写入主链可以概括为：

```text
recordTranscript(messages)
  ↓
cleanMessagesForLogging()
  ↓
getSessionMessages() 去重
  ↓
insertMessageChain()
  ↓
补 parentUuid 和 session stamp
  ↓
appendEntry()
  ↓
按文件排队
  ↓
100ms drain 批量追加 JSONL
```

### 3.1 `recordTranscript()` 先做去重

入口是：

```text
src/utils/sessionStorage.ts
```

`recordTranscript()` 不会把调用方传来的数组原样写进去。

它会先：

1. 调用 `cleanMessagesForLogging()`；
2. 读取当前 session 已有的 UUID 集合；
3. 找出真正的新消息；
4. 记录“最后一个已经存在的链参与者”作为新消息的起点；
5. 把新消息交给 `insertMessageChain()`。

```typescript
// src/utils/sessionStorage.ts
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  // allMessages 用于清理需要参考完整消息集合的日志内容。
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)

  const newMessages: typeof cleanedMessages = []
  let startingParentUuid = startingParentUuidHint
  let seenNewMessage = false

  for (const message of cleanedMessages) {
    if (messageSet.has(message.uuid as UUID)) {
      // 只有“新消息之前的连续已存在前缀”才能推进 parent。
      // compact 后保留的旧消息出现在新 boundary 之后，不能再推进旧 parent。
      if (!seenNewMessage && isChainParticipant(message)) {
        startingParentUuid = message.uuid as UUID
      }
    } else {
      newMessages.push(message)
      seenNewMessage = true
    }
  }

  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
    )
  }

  return newMessages.findLast(isChainParticipant)?.uuid ?? startingParentUuid ?? null
}
```

这里的“前缀规则”很关键。

如果所有已存在消息都可以继续推进 parent，那么 compact 之后新 boundary 可能被错误地挂回旧历史，恢复时就会出现孤链。

`recordTranscript()` 返回的 UUID 也不是“文件最后一行的 UUID”。
它返回最后一个真正参与对话链的消息，或前缀中最后一个可继续作为 parent 的消息；
`progress`、metadata 等不参与链的 entry 不会改变这个返回值。
调用方可以用它作为下一批增量消息的 `startingParentUuidHint`，避免每次从头扫描。

### 3.2 progress 不参与持久化链

当前实现把高频 progress（进度）消息视为 UI 状态，而不是 transcript 链节点。

```typescript
// src/utils/sessionStorage.ts
export function isChainParticipant(
  message: Pick<Message, 'type'>,
): boolean {
  // progress 只用于界面刷新，不应该成为后续消息的 parent。
  return message.type !== 'progress'
}
```

原因是 progress 可能每秒产生一次，且在工具完成后不会成为可恢复的对话内容。

旧 transcript 里如果已经存在 progress 节点，`loadTranscriptFile()` 会通过 `progressBridge` 把后续消息重新桥接到最近的非 progress parent。

这体现了一个兼容策略：

```text
新写入不再制造错误拓扑
旧文件读取时尽量修复旧拓扑
```

### 3.3 `insertMessageChain()` 补齐 parentUuid

`insertMessageChain()` 负责把一组消息写成一条连续链。

每条消息写入前会补充：

- `parentUuid`；
- `sessionId`；
- `cwd`；
- `timestamp`；
- `version`；
- `gitBranch`；
- `slug`；
- `promptId`；
- `isSidechain`；
- `agentId` 和团队信息。

```typescript
// src/utils/sessionStorage.ts
const transcriptMessage: TranscriptMessage = {
  // compact boundary 会切断物理 parent，但保留 logicalParentUuid。
  parentUuid: isCompactBoundary ? null : effectiveParentUuid,
  logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
  isSidechain,
  teamName: teamInfo?.teamName,
  agentName: teamInfo?.agentName,
  promptId: message.type === 'user' ? getPromptId() ?? undefined : undefined,
  agentId,
  ...message,

  // session stamp 必须放在 spread 之后，覆盖 fork/resume 带来的旧字段。
  userType: getUserType(),
  entrypoint: getEntrypoint(),
  cwd: getCwd(),
  sessionId,
  timestamp: new Date().toISOString(),
  version: VERSION,
  gitBranch,
  slug,
}
```

`parentUuid` 是当前恢复链使用的物理父指针。

`logicalParentUuid` 是 compact boundary 的逻辑关联：

```text
物理上：
compact boundary.parentUuid = null

逻辑上：
compact boundary.logicalParentUuid = 被压缩前的旧 parent
```

这样做既能让新上下文从 summary 开始，又能保留“这个 summary 替代了哪一段历史”的关系。

### 3.4 session file 延迟创建

新 session 启动时不会因为一条 metadata 就立刻创建 JSONL 文件。

`Project` 先把 entry 放进 `pendingEntries`，直到遇到第一条 user 或 assistant 消息，再由 `materializeSessionFile()`：

1. 创建 session file；
2. 重新写入当前缓存的 metadata；
3. 刷出 pending entries。

这样可以避免用户只启动 CLI、没有真正对话，却产生一个空 session 文件。

同时，`shouldSkipPersistence()` 会统一处理：

- test 环境；
- `cleanupPeriodDays=0`；
- `--no-session-persistence`；
- `CLAUDE_CODE_SKIP_PROMPT_HISTORY`。

### 3.5 `appendEntry()` 按 entry 类型分流

不是所有 JSONL 行都是 transcript message。

`appendEntry()` 会把 entry 分成几类：

| entry 类型 | 用途 |
| --- | --- |
| `user` / `assistant` / `system` / `attachment` | 对话链节点 |
| `summary` | 当前叶子的摘要 |
| `custom-title` / `tag` / `last-prompt` | session 列表和恢复元数据 |
| `file-history-snapshot` | 文件操作历史 |
| `content-replacement` | 工具结果或内容替换记录 |
| `marble-origami-commit` / `snapshot` | context collapse 的恢复状态 |
| `queue-operation` | 命令队列持久化 |
| `goal` / `goal-cleared` | session goal |

其中只有 transcript message 需要检查 UUID 去重。

metadata 允许重复追加，恢复时采用：

```text
同类字段通常 last-wins（后写入覆盖先写入）
commit 则保留顺序
```

这正是 append-only（只追加，不原地修改）文件的典型写法：修改一个 title，不回头更新旧行，而是在文件末尾追加一条新的 `custom-title`。

### 3.6 100ms 写缓冲和 per-file queue

`Project` 为每个目标文件维护一个写队列：

```typescript
// src/utils/sessionStorage.ts
private FLUSH_INTERVAL_MS = 100
private writeQueues = new Map<
  string,
  Array<{ entry: Entry; resolve: () => void }>
>()

private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) {
      queue = []
      this.writeQueues.set(filePath, queue)
    }

    if (queue.length >= 1000) {
      // 防止长时间运行的 session 让内存队列无限增长。
      // 被丢弃 entry 的 promise 会 resolve，但它们不会落盘。
      const dropped = queue.splice(0, queue.length - 999)
      for (const item of dropped) item.resolve()
    }

    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}
```

100ms 的意义是：

- 一轮 streaming 产生的多个 entry 可以合并写入；
- 不为每个 token 或 content block 单独触发磁盘 I/O；
- 正常交互下延迟仍然很低。

`drainWriteQueue()` 会把多条 JSONL 行合并成一段字符串，再调用 `appendToFile()`。

单次 chunk 上限是 100MB，超过时会先写出当前 chunk，再继续处理剩余 entry。

如果远端 CCR 已接入，`setRemoteIngressUrl()` 或 `setInternalEventWriter()` 会把 flush interval 改成 10ms，以降低远端同步延迟。

### 3.7 退出时 flush

`getProject()` 创建 `Project` 时会向 `cleanupRegistry` 注册退出处理器：

```typescript
// src/utils/sessionStorage.ts
registerCleanup(async () => {
  // 先等待 JSONL 写队列完成。
  await project?.flush()

  // 再把 title、tag 等 metadata 重新追加到文件尾部。
  // resume 的轻量读取只扫描尾部窗口，metadata 必须保持接近 EOF。
  project?.reAppendSessionMetadata()
})
```

因此，100ms 不是“最多丢 100ms 数据”的承诺。

正常退出会显式 flush；进程突然崩溃时，仍可能丢失尚未写出的队列内容。

## 四、JSONL 中的 DAG：恢复时如何找到当前对话

### 4.1 `parentUuid` 让文件变成 DAG

DAG（Directed Acyclic Graph，有向无环图）并不意味着文件本身保存了完整的图对象。

文件只是逐行保存节点，每个节点用 `parentUuid` 指向父节点：

```text
user-1
  ↓
assistant-1
  ├─ assistant-2a
  │    ↓
  │  tool_result-2a
  └─ assistant-2b
       ↓
     tool_result-2b
```

并行 tool_use 会产生多个拥有相同消息 ID、但 UUID 不同的 assistant 节点。

### 4.2 `loadTranscriptFile()` 先建 Map

恢复时，`loadTranscriptFile()` 会把 JSONL entry 分类放入多个 Map：

```text
uuid → TranscriptMessage
leafUuid → summary
sessionId → custom-title / tag / mode
messageId → file-history-snapshot
sessionId / agentId → content replacement
```

这样后续的 parent 查找是 O(1) Map 访问，而不是每次从数组重新搜索。

### 4.3 从叶子反向构建链

`buildConversationChain()` 从一个 leaf message 开始，沿 `parentUuid` 向前走，最后反转为 root → leaf。

```typescript
// src/utils/sessionStorage.ts
export function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const chain: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let current: TranscriptMessage | undefined = leafMessage

  while (current) {
    if (seen.has(current.uuid)) {
      // 防止损坏 transcript 中的 parentUuid 环造成死循环。
      break
    }
    seen.add(current.uuid)
    chain.push(current)
    current = current.parentUuid
      ? messages.get(current.parentUuid)
      : undefined
  }

  chain.reverse()

  // 单 parent walk 后，再补回并行 assistant/tool_result。
  return recoverOrphanedParallelToolResults(messages, chain, seen)
}
```

`leafUuids` 会在加载结束时计算。默认情况下，terminal message 会向后回溯到最近的 user/assistant 节点，把它作为可以继续 resume 的叶子。

如果启用了 leaf prune feature，系统还会忽略那些已经有 user/assistant 子节点的中间节点，减少把“工具进度的末端”误判成对话叶子。

### 4.4 为什么需要恢复并行 tool_result

单纯沿一条 `parentUuid` 链走，会漏掉同一个 assistant message ID 下的兄弟节点。

`recoverOrphanedParallelToolResults()` 会：

1. 按 assistant 的 `message.id` 分组；
2. 找到当前链上的最后一个 sibling；
3. 收集不在链上的兄弟 assistant；
4. 收集这些 assistant 对应的 tool_result；
5. 按 timestamp 排序；
6. 插回当前链。

这不是“重新推理”，而是利用写入时已经存在的 UUID 和 parent 关系，修复单链遍历对 DAG 的信息损失。

## 五、大文件恢复：先缩小读取范围，再解析

### 5.1 5MB 是预处理阈值，不是模型窗口

`src/utils/sessionStoragePortable.ts` 定义：

```typescript
export const SKIP_PRECOMPACT_THRESHOLD = 5 * 1024 * 1024
```

它表示：

```text
transcript > 5MB
  → 尝试利用 compact boundary 缩小读取范围
```

它不是：

- 模型 context window；
- token budget；
- `snip_boundary` 的 token 阈值；
- API provider 的上下文上限。

这是本地文件加载优化阈值。

### 5.2 `readTranscriptForLoad()` 处理 compact boundary

大文件读取时，`readTranscriptForLoad()` 以 chunk 方式扫描：

- 忽略不需要进入结果的 attribution snapshot；
- 找到 compact boundary；
- 从最新有效 boundary 之后开始积累内容；
- 对边界之前仍然有用的 metadata 做轻量扫描；
- 返回 post-boundary buffer。

```text
文件前半段
  → 旧历史，通常可以被 compact summary 替代

最新 compact boundary
  → 当前上下文的物理起点

boundary 之后
  → 当前 resume 主要需要解析的内容
```

如果 boundary 带有 preserved segment（保留片段），则不能在 parse 前简单剪掉所有旧内容，因为保留片段还需要在内存中重新 relink。

### 5.3 `walkChainBeforeParse()` 字节级剪枝

当文件足够大、调用方不要求保留所有叶子、且不存在需要延后修复的 preserved segment 时，`loadTranscriptFile()` 会调用 `walkChainBeforeParse()`。

它不会先把整个文件解析成对象，而是：

1. 按行建立轻量索引；
2. 记录每条消息的 `uuid` 和 `parentUuid`；
3. 找到最后一个非 sidechain 的候选叶子；
4. 用 UUID 在字节层面向前走 parent 链；
5. 只有预计能节省至少一半字节时，才重新拼接 buffer。

```text
// src/utils/sessionStorage.ts
walkChainBeforeParse(buf) 的真实控制流：

1. 扫描每行的顶层 parentUuid、uuid 和行范围，建立轻量索引；
2. 从最后一个非 sidechain 消息开始，沿索引中的 parentUuid 向前走；
3. 如果 parent 链断裂或出现环，就停止在当前可确认位置；
4. 只有预计丢弃的 dead branch 字节达到一半以上，才重新拼接 buffer；
5. metadata 行与保留下来的消息按原文件顺序交错输出；
6. 返回的新 buffer 再交给 loadTranscriptFile() 的 parseJSONL。
```

因此，恢复优化有一个很重要的工程判断：

> **不是“能剪就剪”，而是只有剪枝收益大于一次性复制成本时才剪。**

### 5.4 50MB 原始 transcript 读取边界

`MAX_TRANSCRIPT_READ_BYTES` 和 tombstone slow path 都使用 50MB 级别的安全边界。

需要区分两个场景：

| 场景 | 策略 |
| --- | --- |
| 正常 resume | 尽量用 boundary 和 parent chain 减少解析量 |
| 旧消息物理删除的 slow path | 文件超过 50MB 时不重写整个文件，避免 OOM |

它们共同表达的是：

```text
不要因为恢复或删除一个小消息，把多 GB session 全部复制到内存。
```

## 六、compact、snip 与 context collapse 如何落盘

本篇不重复 [06 上下文装配](../02-agent-runtime/cc-06-context-assembly.md) 对 token 和模型窗口的解释，只说明这些运行时动作如何留下可恢复的持久化边界。

### 6.1 compact boundary

compact boundary 是一个 system message：

```text
parentUuid = null
logicalParentUuid = 旧链上的 parent
compactMetadata = boundary / summary / preservedSegment 等
```

它把“下一轮对话从哪里继续”固定下来。

加载时遇到新的 compact boundary，旧的 context collapse commit 和 snapshot 会被清理，因为它们对应的是更早的上下文状态。

### 6.2 preserved segment relink

compact 可能只摘要一部分历史，同时保留一个片段。

由于保留消息原本已经写入 JSONL，写入路径不会回头重写它们的旧 `parentUuid`。恢复时，`applyPreservedSegmentRelinks()` 会：

1. 找到最新 boundary；
2. 从 preserved segment 的 tail 沿 parentUuid 走到 head；
3. 把 head 接到 boundary 的 anchor；
4. 把 anchor 的其他子节点接到 preserved segment 的 tail；
5. 清理 boundary 之前没有被保留的节点；
6. 清理旧 assistant usage，避免 resume 后立刻重复 compact。

如果保留片段的 UUID 链不完整，函数会放弃剪枝，保留完整历史，优先保证恢复正确性。

### 6.3 snip removal

snip 与 compact 不同：

```text
compact → 通常截断前缀
snip    → 删除中间区间
```

`applySnipRemovals()` 会从 boundary 的 `snipMetadata.removedUuids` 读取具体删除列表。

仅仅从 Map 删除这些 UUID 还不够，因为后面的 survivor 可能仍然指向被删除节点。

因此恢复时还会：

```text
删除 removedUuids
  ↓
沿被删除节点原来的 parentUuid 向后找
  ↓
把 survivor 的 parentUuid 重连到第一个仍存在的祖先
```

这就是持久化层对 `snip_boundary` 的责任：

```text
保存“哪些 UUID 被移除”
恢复时按记录重建 parent 链
```

具体的 snip 触发条件、模型窗口和 token 预算仍属于上下文治理层。

### 6.4 context collapse commit 与 snapshot

当前代码还会追加：

- `marble-origami-commit`：按顺序保存每次 collapse commit；
- `marble-origami-snapshot`：保存 staged queue、armed 状态和最近一次 spawn token 等状态。

恢复时：

- commit 保留写入顺序；
- snapshot 使用 last-wins；
- 遇到新的 compact boundary 时清理旧 commit/snapshot。

这说明持久化不仅保存“对话文本”，也保存恢复一个上下文治理流程所需的控制状态。

## 七、消息删除：append-only 的例外

### 7.1 代码语义中的 tombstone

tombstone（删除标记）通常意味着“追加一条删除记录，而不修改旧数据”。

当前 `removeMessageByUuid()` 的实现更具体：

- 常规消息写入仍然 append-only；
- 删除最近消息时，直接对 JSONL 做尾部定位、truncate 和重写；
- 找不到目标或目标不在尾部时，走 slow path；
- 文件超过 50MB 时，放弃全文件重写并记录 warning。

也就是说，当前实现不是纯粹的“追加 tombstone entry”，而是一个针对异常消息的物理删除优化。

### 7.2 64KB tail 快路径

`src/utils/sessionStoragePortable.ts` 中的 `LITE_READ_BUF_SIZE` 是 64KB。

`removeMessageByUuid()` 会先读取文件尾部，搜索完整的：

```text
"uuid":"<targetUuid>"
```

而不是只搜索裸 UUID。

这样可以避免把 child 的 `parentUuid` 值误认为目标消息本身。

如果目标行在尾部窗口内：

```text
truncate 到目标行之前
  ↓
把目标行之后的尾部重新写回
```

目标通常是最近一次失败 streaming 产生的孤立消息，所以快路径覆盖了最常见情况。

### 7.3 删除和恢复的一致性边界

如果目标消息已经位于文件中部，而且文件过大，系统不会为了删除一行而复制整个文件。

这时的取舍是：

```text
宁可保留一条异常历史
也不让一次清理操作把进程推向 OOM
```

## 八、恢复时的一致性检查

`checkResumeConsistency()` 会读取最近的 `turn_duration` checkpoint，把持久化记录中的 `messageCount` 与恢复后链的位置比较：

```text
delta > 0 → resume 比运行中多加载了消息
delta < 0 → resume 少加载了消息
delta = 0 → 写入与恢复一致
```

它的职责是记录偏差，不直接阻断 resume。

这类检查适合放在持久化层：

- 不改变主流程；
- 能暴露 compact、snip、parallel tool_result 的回放差异；
- 具体指标和上报出口交给 [25 可观测性](cc-25-observability.md)。

## 九、内存 cache：加速而不是记忆

### 9.1 `sessionMessagesCache`

`recordTranscript()` 频繁需要判断 UUID 是否已经写过。

如果每次都重新解析 session 文件，写入成本会随着历史增长。因此 `getSessionMessages()` 使用：

```typescript
// src/utils/sessionStorage.ts
const sessionMessagesCache = new Map<
  UUID,
  Promise<Set<UUID>>
>()

export async function getSessionMessages(
  sessionId: UUID,
): Promise<Set<UUID>> {
  const existing = sessionMessagesCache.get(sessionId)
  if (existing) {
    // 同一个 session 的并发调用共享同一个 in-flight promise。
    return existing
  }

  if (sessionMessagesCache.size >= 200) {
    // Map insertion order 作为 FIFO，淘汰最早的 session。
    const oldest = sessionMessagesCache.keys().next().value
    if (oldest !== undefined) sessionMessagesCache.delete(oldest)
  }

  const promise = loadSessionFile(sessionId).then(
    ({ messages }) => new Set(messages.keys()),
  )
  sessionMessagesCache.set(sessionId, promise)
  return promise
}
```

这个 cache 有三个设计点：

1. 缓存的是 Promise，能合并并发读取；
2. 最多保存 200 个 session；
3. compact 后可以通过 `clearSessionMessagesCache()` 清空，因为旧 UUID 集合可能已经不再代表当前文件。

### 9.2 metadata cache 与 tail re-append

`Project` 内部缓存当前 session 的：

- title；
- tag；
- last prompt；
- agent name / color / setting；
- mode；
- goal；
- worktree state；
- PR link。

这些值既用于当前 UI，也会在退出或 compact 后重新追加到 JSONL 尾部。

原因是 resume 列表的轻量读取只扫描文件尾部窗口。如果 title 只出现在很早的位置，随着新消息增长，它会离开 tail window，列表就会退回自动生成的 first prompt。

### 9.3 `CLAUDE.md` 和 memory 文件 cache

`src/utils/claudemd.ts` 使用 `memoize()` 缓存 `getMemoryFiles()`。

内存文件包括：

- Managed memory；
- User memory；
- Project memory；
- Local memory；
- `.claude/rules/*.md`；
- feature gate 打开的 AutoMem 或 TeamMem。

缓存失效分为两种：

```typescript
// src/utils/claudemd.ts
export function clearMemoryFileCaches(): void {
  // 只清除读取结果，不表示“指令重新加载了一次”。
  getMemoryFiles.cache?.clear?.()
}

export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  // compact 等真正会让 memory 重新进入上下文的场景，
  // 除了清 cache，还要让 InstructionsLoaded hook 知道原因。
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}
```

因此，memory cache 和 transcript 的关系是：

```text
CLAUDE.md / MEMORY.md
  → 读取、解析、拼接成当前 prompt 输入

session JSONL
  → 保存实际发生过的 user / assistant / tool / boundary
```

记忆文件变了，不代表旧 transcript 被修改；旧 transcript 恢复后，下一轮仍会重新装配当前有效 memory。

### 9.4 Skill index cache

`src/services/skillSearch/localSearch.ts` 使用进程级索引：

```text
cachedIndex
cachedIdf
cachedCwd
```

其中 `cachedIndex` 是 Skill 的检索索引，`cachedIdf` 是 TF-IDF（词频-逆文档频率）计算所需的数据。

`clearSkillIndexCache()` 会一次清空三者。

它不会改变 transcript，也不会让模型“忘记”已经发生的对话。

### 9.5 MCP cache

MCP 连接层有多种 cache：

- 连接对象 memoize；
- 工具、资源、命令列表的 LRU（最近最少使用）cache；
- 认证失败的 15 分钟 needs-auth 文件 cache。

其中 fetch cache 上限为 20 个 server，连接关闭或 session 过期时需要清理连接和工具列表 cache，保证下一次操作重新连接并读取新能力。

这类 cache 的失效条件是“连接状态改变”，不是“上下文被 compact”。

因此，本篇的三层数据并不是“短期记忆、长期记忆、模型记忆”这样的三级记忆系统：

```text
transcript
  保存可恢复事实，是本地 resume 的真源

进程内 cache
  保存可重新计算的索引、解析结果或连接对象

Prompt Cache
  保存 provider 可复用的请求前缀
```

它们的恢复责任不同：

- transcript 损坏，会直接影响 resume 的正确性；
- 内存 cache 丢失，通常只是多一次读取、解析或连接；
- Prompt Cache 失效，通常只是请求重新计算，不能让本地会话“失忆”。

## 十、Prompt Cache：API 请求前缀的复用

### 10.1 Prompt Cache 与本地 cache 不是一回事

本地 cache 的命中通常意味着：

```text
少读一次文件
少做一次解析
少建一次连接
```

Prompt Cache 的命中意味着：

```text
provider 侧复用请求前缀
```

它们的失效时间、计费方式和一致性边界都不同。

### 10.2 `getCacheControl()` 只负责生成标记

```typescript
// src/services/api/claude.ts
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

默认请求使用 `ephemeral`，部分符合条件的 query source 可以使用 1 小时 TTL。

要注意：

> provider 默认的短 TTL 并不是 `src/utils/sessionStorage.ts` 中的本地常量；不能把某个旧版本的“5 分钟”直接当成 Claude Code 的统一实现规则。

### 10.3 1 小时 TTL 的 eligibility 和 allowlist

`should1hCacheTTL()` 会把两个结果锁存在 session state：

- 当前用户是否 eligible；
- 当前 query source 是否在 GrowthBook allowlist 中。

这样做是为了避免一次 session 中途从短 TTL 切到长 TTL，再把同一个请求前缀拆成不同 cache key。

```text
session 开始
  ↓
确定 user eligibility
  ↓
确定 querySource allowlist
  ↓
后续请求沿用同一判断
```

这是一种“稳定性优先”的 cache key 设计。

### 10.4 system prompt、tool schema 和 message marker

请求装配主要有三处：

1. `buildSystemPromptBlocks()` 给 system prompt blocks 添加 cache control；
2. `addCacheBreakpoints()` 给消息前缀设置一个 message-level marker；
3. `userMessageToMessageParam()` 和 `assistantMessageToMessageParam()` 在目标消息上附加 cache control。

```typescript
// src/services/api/claude.ts
const markerIndex = skipCacheWrite
  ? messages.length - 2
  : messages.length - 1

const result = messages.map((message, index) => {
  // 正常请求标记最后一条消息；
  // fire-and-forget fork 则标记最后一个共享前缀。
  const addCache = index === markerIndex

  return message.type === 'user'
    ? userMessageToMessageParam(
        message,
        addCache,
        enablePromptCaching,
        querySource,
      )
    : assistantMessageToMessageParam(
        message,
        addCache,
        enablePromptCaching,
        querySource,
      )
})
```

当前实现刻意保证每个请求只有一个 message-level cache marker。

原因不是格式偏好，而是缓存生命周期：

```text
一个请求只定义一个明确的缓存前缀终点
  ↓
旧前缀可以被淘汰
  ↓
不会因为多个 marker 把已经不会复用的局部页面继续保护
```

### 10.5 `cache_edits` 与 cache reference

当启用 cached message editing 时，`addCacheBreakpoints()` 还会：

- 去重要删除的 cache reference；
- 把 pinned edits 插回原消息位置；
- 把新的 `cache_edits` 插入最后一个 user message；
- 给缓存前缀中的 tool_result 添加 `cache_reference`。

这些操作只改变发给 provider 的 MessageParam，不改变本地 transcript 的 parentUuid。

因此：

```text
本地 transcript 的结构
  ≠
API 请求中为缓存服务的结构
```

## 十一、远端会话：写入和 hydrate

Claude Code 支持本地 session 与远端 CCR（Claude Code Remote）协同。

当前持久化代码有两条远端路径：

```text
CCR v1
  → Session Ingress append / getSessionLogs

CCR v2
  → internal event writer / reader
```

### 11.1 CCR v1：Session Ingress

当：

- `ENABLE_SESSION_PERSISTENCE` 打开；
- `remoteIngressUrl` 存在；
- 没有 v2 internal event writer；

`persistToRemote()` 会把新的 transcript message 发送到 Session Ingress。

如果 append 失败，当前实现会记录事件并调用 `gracefulShutdownSync(1, 'other')`，避免本地和远端会话继续分叉。

同时，远端模式会把本地 flush interval 从 100ms 调整为 10ms，降低远端日志延迟。

### 11.2 CCR v2：Internal Event

如果注册了 `internalEventWriter`，transcript message 会作为 internal worker event 写出：

```typescript
// src/utils/sessionStorage.ts
if (this.internalEventWriter) {
  await this.internalEventWriter(
    'transcript',
    entry as Record<string, unknown>,
    {
      // compact boundary 需要让服务端知道这是 compaction 事件。
      ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
      ...(entry.agentId && { agentId: entry.agentId }),
    },
  )
  return
}
```

v2 的好处是把前台和 subagent transcript 都放进同一类内部事件模型，恢复时由 reader 拉取。

### 11.3 `hydrateRemoteSession()`：先写本地，再打开同步

hydrate（灌入）不是边读远端边执行。

`hydrateRemoteSession()` 的顺序是：

```text
切换到远端 sessionId
  ↓
从 Session Ingress 读取完整日志
  ↓
覆盖本地 session JSONL
  ↓
设置 remoteIngressUrl
  ↓
后续新消息再同步到远端
```

```typescript
// src/utils/sessionStorage.ts
const remoteLogs =
  (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []

const content = remoteLogs
  .map(entry => jsonStringify(entry) + '\n')
  .join('')

// 先把本地文件恢复到远端快照。
await writeFile(sessionFile, content, {
  encoding: 'utf8',
  mode: 0o600,
})

// 只有本地 hydrate 完成后，才打开后续写入同步。
project.setRemoteIngressUrl(ingressUrl)
```

这个顺序避免了：

```text
本地旧 transcript 还没被远端覆盖
  ↓
新消息却已经开始上传
  ↓
远端出现两个版本的写入顺序
```

### 11.4 CCR v2 resume

`hydrateFromCCRv2InternalEvents()` 会：

- 读取 foreground events；
- 写入主 session JSONL；
- 读取 subagent events；
- 按 `agent_id` 分组；
- 分别写入每个 agent 的 transcript；
- 由服务端负责返回最新 compact boundary 之后的事件。

本地持久化层负责把事件恢复成与普通 JSONL 相同的文件布局，后续仍由 `loadTranscriptFile()` 统一解析。

## 十二、完整案例：一次 turn 如何被保存和恢复

假设用户让 Agent 修改一个文件，Agent 调用一次工具后返回结果。

### 12.1 写入

```text
用户输入
  ↓
recordTranscript(user)
  ↓
insertMessageChain(parentUuid = null)
  ↓
enqueueWrite(sessionFile, user)
  ↓
100ms drain
```

接着模型输出 assistant tool_use：

```text
assistant tool_use
  ↓
recordTranscript(assistant)
  ↓
parentUuid = user.uuid
  ↓
append JSONL
```

工具返回 tool_result：

```text
tool_result
  ↓
sourceToolAssistantUUID 决定有效 parent
  ↓
append JSONL
```

### 12.2 compact

上下文层判断需要 compact 后：

```text
写入 summary
  ↓
写入 compact boundary
  ↓
parentUuid = null
logicalParentUuid = 旧 parent
  ↓
记录 preservedSegment / collapse commit
```

JSONL 不必删除所有旧行，恢复时再依据 boundary 和 metadata 选择有效部分。

### 12.3 resume

用户重新打开 session：

```text
loadTranscriptFile()
  ↓
大文件先扫描 compact boundary
  ↓
必要时 walkChainBeforeParse
  ↓
parseJSONL
  ↓
progressBridge
  ↓
applyPreservedSegmentRelinks
  ↓
applySnipRemovals
  ↓
计算 leafUuids
  ↓
buildConversationChain
  ↓
recoverOrphanedParallelToolResults
```

最终恢复的是当前有效 conversation chain，而不是把整个 JSONL 文件逐行原样展示给模型。

### 12.4 Prompt Cache

恢复后的消息进入 API 请求：

```text
system prompt + tools + conversation prefix
  ↓
buildSystemPromptBlocks()
  ↓
addCacheBreakpoints()
  ↓
最后一个共享前缀添加 cache_control
  ↓
发送给 provider
```

如果下一轮只有最后一条 user prompt 变化，provider 可能复用前面的 cache；但这不改变本地 JSONL 的内容。

## 十三、常见误区

### 13.1 “JSONL 就是一条线”

不是。

文件的物理顺序是追加顺序，语义结构由 `parentUuid` 形成 DAG。

恢复时不能简单取最后 N 行，因为最后一行可能是：

- metadata；
- tool_result；
- 另一个 fork；
- compact boundary；
- sidechain；
- 已经不属于当前叶子的分支。

### 13.2 “cache 命中就等于记住了”

不是。

cache 命中只能说明某段派生数据仍然可复用。

例如：

- `sessionMessagesCache` 清空后，可以重新读 JSONL；
- `getMemoryFiles()` cache 清空后，可以重新扫描 CLAUDE.md；
- MCP connection cache 清空后，可以重新连接；
- Prompt Cache 失效后，仍然可以从本地 transcript 重新构造请求。

### 13.3 “compact 会删除旧文件”

通常不是。

compact 更像是在 append-only transcript 上追加边界和 summary，然后在恢复时进行逻辑剪枝。

因此：

```text
磁盘上的历史可能还在
当前上下文链不一定再包含它
```

### 13.4 “Prompt Cache TTL 写在 sessionStorage 里”

不是。

本地代码只决定：

- 是否启用 prompt caching；
- 添加什么 `cache_control`；
- 是否选择 1h TTL；
- cache marker 放在哪里。

provider 的实际缓存命中和过期仍由 API 服务端决定。

### 13.5 “删除消息永远是追加 tombstone”

当前代码不是纯粹的 tombstone log。

`removeMessageByUuid()` 对最近消息使用尾部 truncate，对较早消息可能走整个文件重写；文件过大时则放弃 slow path。

## 十四、设计取舍与边界

### 14.1 为什么用 JSONL，而不是数据库

JSONL 的优势：

- 追加写简单；
- 崩溃时只影响末尾窗口；
- 可以被调试工具直接读取；
- sidechain、metadata、summary 可以共存；
- 不需要额外数据库服务。

代价：

- 恢复需要重新建立 Map 和 parent 链；
- 删除中间消息不自然；
- 多进程写入需要更谨慎；
- 文件长期增长后必须做 boundary 和字节级剪枝。

### 14.2 为什么 cache 都要有上限

Claude Code 有长时间运行、子 Agent 扩张和 daemon 场景。

没有上限时：

```text
每创建一个 session / agent / MCP server
  ↓
内存 Map 多一个 key
  ↓
长时间运行后不可回收
```

因此当前实现对不同 cache 使用不同边界：

| cache | 边界 |
| --- | --- |
| `sessionMessagesCache` | 200 个 session，FIFO |
| MCP fetch cache | 20 个 server |
| MCP needs-auth cache | 15 分钟 TTL |
| Skill index | 按 cwd 失效 |
| memory files | 显式 clear/reset |
| Prompt Cache | provider 控制 TTL，客户端保持 key 稳定 |

### 14.3 为什么恢复优先保证正确性

在 preserved segment 链损坏、parentUuid 断裂或旧 progress 拓扑异常时，代码倾向于：

```text
放弃激进剪枝
  ↓
加载更多历史
  ↓
避免恢复出错误的对话链
```

这是合理的优先级：

```text
恢复多一点历史 → 主要影响性能和 token
恢复错父节点   → 直接改变 Agent 看到的事实
```

### 14.4 持久化层不替代上下文层

持久化层保存：

- 消息；
- parentUuid；
- compact / snip 元数据；
- summary；
- collapse 状态；
- session metadata。

上下文层决定：

- 哪些内容进入本轮模型请求；
- 还剩多少 token；
- 是否触发 compact；
- 如何使用 memory；
- 如何安排 `snip_boundary`。

两者的协作关系是：

```text
context layer 决定边界
  ↓
persistence layer 保存边界和恢复所需的结构
  ↓
resume 重新构造可用链
  ↓
context layer 再次装配下一轮 prompt
```

## 总结

Claude Code 的持久化与缓存可以压缩成一条主线：

```text
recordTranscript
  → 去重
  → parentUuid 链装配
  → append-only JSONL
  → 100ms 批量刷盘
  → cleanup flush
  → compact / snip 边界恢复
  → leaf + DAG chain 重建
  → 本地 cache 加速
  → Prompt Cache 复用 API 前缀
  → CCR 可选远端同步
```

读完本篇，应该能区分：

1. JSONL transcript 是恢复真源，内存 cache 只是派生加速；
2. `parentUuid` 让消息文件形成 DAG，恢复不能只看最后几行；
3. compact 和 snip 的运行时语义在 [06 上下文装配](../02-agent-runtime/cc-06-context-assembly.md)，持久化层负责保存边界并在 resume 时修复链；
4. Prompt Cache 优化 provider 请求前缀，不负责本地会话恢复；
5. 远端 hydrate 必须先把本地 transcript 对齐，再打开后续同步；
6. cache 清空通常可以重算，transcript 损坏则会直接影响 resume 正确性。

持久化层的本质不是“把历史存下来”，而是让 Agent 在进程退出、上下文压缩、分支切换和远端恢复之后，仍然能够重建一条语义正确的下一轮输入链。
