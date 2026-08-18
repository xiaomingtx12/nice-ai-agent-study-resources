---
slug: /application-notes/engineering/claude-code-cli/cc-08-compaction-subsystem
sidebar_position: 8
title: "压缩子系统"
description: "上下文压缩不是简单删除旧消息，而是由五级减量、摘要生成、状态恢复和失败兜底组成的一条生命周期管线。"
---

> *压缩改变的是模型本轮能看到的上下文视图，不等于把会话历史从磁盘上删除。*
>
> **Harness 层定位**：**[02 §三 组件 5.5 上下文压缩](../01-architecture-lifecycle/cc-02-harness-design.md)** —— 在 Agent Loop 每次调用模型前，按成本从低到高回收上下文空间，并在压缩后重建运行环境。

# 上下文压缩子系统

## 源码定位

> **阅读基线**：Claude Code Best 当前源码。正文引用的是本地实现，行号会随版本变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **循环接线**：`src/query.ts` —— 在每次 API 请求之前依次执行工具结果预算、snip、microcompact 和自动压缩。
> - **自动触发**：`src/services/compact/autoCompact.ts` —— 计算有效上下文窗口、触发阈值、预测性增长和连续失败熔断。
> - **摘要编排**：`src/services/compact/compact.ts` 的 `compactConversation()` —— 生成摘要、处理 PTL 重试、恢复附件并创建 `compact_boundary`。
> - **压缩提示词**：`src/services/compact/prompt.ts` —— 规定摘要结构，并在写入会话前剥离 `<analysis>` 草稿区。
> - **轻量压缩**：`src/services/compact/snipCompact.ts`、`microCompact.ts` 和 `apiMicrocompact.ts`。
> - **响应式兜底**：`src/services/compact/reactiveCompact.ts` —— API 已经返回 Prompt Too Long（提示过长）后再压缩一次。
> - **恢复与重连**：`src/utils/sessionStorage.ts` 的 `applyPreservedSegmentRelinks()` —— resume 时在内存中重写保留段的消息链。
> - **压缩后清理**：`src/services/compact/postCompactCleanup.ts` 的 `runPostCompactCleanup()` —— 失效缓存和临时状态，但不主动清掉已调用的技能内容。

## 为什么读这一篇

长会话的上下文增长，通常不是某一条消息单独超大，而是多个来源不断追加：

- system prompt、工具 schema 和 `CLAUDE.md` 形成稳定前缀；
- 文件读取、搜索、Shell 输出和工具结果按轮次追加；
- assistant 指令、用户反馈和附件消息继续增长；
- 子 Agent、计划模式、技能和 MCP 工具说明会改变运行环境。

如果只在 API 返回错误后处理，模型可能已经因为 Prompt Too Long（上下文超限）被迫中断。Claude Code 因此把压缩放进 Agent Loop 的“请求前准备”阶段，并且采用逐级降级：

```text
单条工具结果过大
  → Stage 1：预算裁剪并把完整内容保留到替换记录

某段试错历史已经没有价值
  → Stage 2：按 snip_boundary 删除指定消息

旧工具结果跨多轮累积
  → Stage 3：microcompact 清空旧结果，或让服务端跳过缓存块

服务端具备 context management 能力
  → Stage 4：通过 API 配置让服务端清理旧工具块

整段历史逼近上下文窗口
  → Stage 5：调用模型生成摘要，并重建运行时状态
```

读完后，应该能够回答：

- 五个阶段分别看什么信号、修改什么数据；
- 为什么 Stage 5 不能只保留一条 summary（摘要）；
- `compact_boundary`、`Preserved Segment`（保留段）和 `logicalParentUuid` 如何配合 resume；
- 压缩后的“遗忘”到底发生在哪里；
- compact 自己超窗口、API 仍然超窗口、连续失败时分别如何处理。

## 先建立一个重要区分：视图、状态与历史

压缩系统至少同时维护三层东西：

| 层次 | 代表数据 | 压缩时发生什么 |
| --- | --- | --- |
| **模型视图** | 发给 API 的 `messages` | 可以裁剪、摘要、替换或重新拼装 |
| **运行时状态** | `readFileState`、计划、技能、后台任务、工具增量 | 压缩后需要清理并按需恢复 |
| **持久化历史** | JSONL transcript（会话追加日志） | 通常继续追加 boundary 和 summary，不等于物理删除旧行 |

所以，“模型现在看不到”不等于“系统没有保存”。反过来，“系统还保存着”也不等于模型会自动知道。模型能否恢复细节，还取决于摘要是否留下线索、附件是否重新注入，以及模型是否主动读取归档文件。

---

## 一、压缩在 Agent Loop 的什么位置

### 1.1 所有压缩都发生在 API 调用之前

`query.ts` 的每一轮准备阶段大致如下：

```text
读取当前 messages
  │
  ├─ Stage 1  applyToolResultBudget()
  ├─ Stage 2  snipCompactIfNeeded()
  ├─ Stage 3  microcompact()
  ├─ 可选：Context Collapse（上下文折叠特性）
  ├─ Stage 4  API context management（服务端上下文管理）
  └─ Stage 5  autoCompactIfNeeded()
       │
       └─ 用压缩后的 messages 调用模型
```

顺序体现了成本分层：

- Stage 1 主要是本地内容替换；
- Stage 2 和 Stage 3 是本地遍历、清空或生成缓存编辑；
- Stage 4 把清理动作交给 API 服务端；
- Stage 5 才需要额外调用模型生成摘要。

当前版本还可能启用 Context Collapse（上下文折叠）：它把旧消息投影成可回放的折叠视图，和这里的五级压缩并列为可选能力。本文重点放在稳定存在的压缩子系统，避免把实验性折叠逻辑和 Stage 5 摘要混成同一条机制。

### 1.2 前四级和 Stage 5 的根本差别

前四级尽量保留消息结构，只减少内容体积。Stage 5 则会改变历史表达方式：

```text
原始历史
  → boundary marker（边界标记）
  → summary message（摘要消息）
  → 最近保留消息
  → 文件 / 计划 / 技能 / Agent / 工具增量附件
```

Stage 5 因此不是“更大的 microcompact”，而是一次上下文重建。它必须同时回答两件事：

1. 旧任务做到了什么；
2. 压缩之后，模型还能继续使用哪些环境能力。

---

## 二、五级压缩策略

### 2.1 Stage 1：工具结果预算

Stage 1 处理的是**单条 user message（用户消息）内部的 tool_result（工具结果）过大**。典型场景是一次 `Read` 读入很大的文件，或者 Shell 输出了大量日志。

`applyToolResultBudget()` 会：

1. 统计一条消息中多个工具结果的总大小；
2. 对超出预算的结果选择性替换；
3. 把完整内容写入内容替换记录；
4. 在发送给模型的消息中留下较短的预览或恢复提示。

它解决的是“一个大结果拖垮这一轮”，不是整段历史的摘要。重要的是，源码在 `query.ts` 中先做这一步，再做 microcompact；因为缓存感知的 microcompact 主要按 `tool_use_id`（工具调用 ID）工作，不依赖原始内容文本。

### 2.2 Stage 2：snip 删除无价值分支

`snipCompactIfNeeded()` 读取最近的 `snip_boundary`（裁剪边界）消息，并根据其中的 `removedUuids` 过滤消息：

```typescript
// src/services/compact/snipCompact.ts：snip 是按 UUID 删除，不生成摘要
const removedSet = new Set(removedUuids)
const kept: Message[] = []
let tokensFreed = 0

for (const message of messages) {
  if (removedSet.has(message.uuid)) {
    // 只估算释放量，用于后续自动压缩阈值判断。
    tokensFreed += estimateMessageTokens(message)
    continue
  }
  kept.push(message)
}

return {
  messages: kept,
  executed: true,
  tokensFreed,
  boundaryMessage,
}
```

snip 有三个容易讲错的地方：

- 它不是 LLM summary，不会替用户归纳被删除内容；
- 它通常没有 token 阈值，关键条件是已经存在 `snip_boundary`；
- 被删除的 UUID 会进入持久化元数据，resume 时还需要对消息链做对应的断链修复。

因此，snip 只适合明确知道“这段试错已经没有价值”的场景，例如失败的探索分支或已经确认无关的跑题内容。

#### 2.2.1 `snip_boundary` 从哪里来

边界标记通常由 `/force-snip` 命令写入，而不是由 `snipCompactIfNeeded()` 自己推断。命令先收集需要删除的 UUID，再追加一条 `system` 类型的 meta 消息：

```typescript
// src/commands/force-snip.ts：只写入“将来如何裁剪”的指令，不立即删除数组内容。
const removedUuids = messages.map(message => message.uuid)

const boundaryMessage: Message = {
  type: 'system',
  subtype: 'snip_boundary',
  content: '[snip] Conversation history before this point has been snipped.',
  isMeta: true,
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
  snipMetadata: {
    // 下一个 query cycle 会根据这个列表过滤旧消息。
    removedUuids,
  },
} as Message

// 保留完整历史给 UI 和 transcript；这里只追加边界标记。
setMessages(previous => [...previous, boundaryMessage])
```

这个设计有意把“标记”和“执行”分开：

1. `/force-snip` 记录要删除哪些 UUID；
2. 下一轮 `query.ts` 调用 `snipCompactIfNeeded()`；
3. 模型发送视图过滤这些 UUID，但保留 `snip_boundary`；
4. `sessionStorage.ts` 在 resume 时重放同一份删除记录并修复父链。

因此，`snip_boundary` 不是“已经从所有地方删除”的通知，而是一条**面向后续消息投影的裁剪指令**。完整历史仍可能存在于 UI 状态和 JSONL transcript 中。

源码还提供 `shouldNudgeForSnips()`：消息数量达到约 30 条时，可以向模型提示考虑 snip。但这个数量只是提醒阈值，不是执行条件；真正执行仍然依赖已经存在的 boundary。

### 2.3 Stage 3：microcompact 清理旧工具结果

microcompact（微压缩）针对的是跨多轮累积的旧工具结果，主要有两条路径：

| 路径 | 判断信号 | 本地动作 |
| --- | --- | --- |
| **Time-based**（按时间） | 距离上一个 assistant 消息超过配置间隔 | 把旧工具结果替换成占位文本 |
| **Cached**（按缓存） | 活跃工具结果达到缓存编辑条件 | 本地消息尽量不动，把要删除的块记录为 `cache_edits` |

缓存编辑的关键是“本地视图”和“服务端缓存”分开：

```text
本地 messages 保留原结构
  +
cache_edits：告诉 API 哪些旧缓存块可以跳过
  ↓
本轮 API 响应返回实际删除量
  ↓
query.ts 再写入 microcompact boundary
```

这样做是为了避免原地修改已经缓存的消息前缀。Prompt Cache（提示缓存）依赖前缀内容稳定，直接改写消息可能让整段缓存失配；`cache_edits` 则允许服务端清理，同时保留本地消息语义。

### 2.4 Stage 4：服务端 context management

Stage 4 不是本地删除，而是 `apiMicrocompact.ts` 生成 API 请求中的上下文管理配置。服务端收到配置后，可以按规则清理旧的工具调用块。

它和 Stage 3 的区别是：

- Stage 3 在客户端决定哪些工具结果需要缩减；
- Stage 4 把清理策略表达成 API 参数，由服务端依据实际输入 token 执行；
- Stage 4 不一定修改 Claude Code 内存中的 `messages`，所以客户端仍然需要维护自己的边界和状态账本。

因此不能把 Stage 4 理解成“Claude Code 已经把本地历史删掉”。它更接近请求传输层的减量。

### 2.5 Stage 5：自动摘要和重建

当轻量策略仍无法把上下文压回安全范围，`autoCompactIfNeeded()` 才会进入 Stage 5：

```typescript
// src/query.ts：snip 释放量必须传给阈值判断
let snipTokensFreed = 0

const snipResult = snipCompactIfNeeded(messagesForQuery)
messagesForQuery = snipResult.messages
snipTokensFreed = snipResult.tokensFreed

const microResult = await microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microResult.messages

// Stage 5 看到的是前面几级已经处理过的消息视图。
const compactResult = await autoCompactIfNeeded(
  messagesForQuery,
  toolUseContext,
  cacheSafeParams,
  querySource,
  tracking,
  snipTokensFreed,
)
```

这里的 `snipTokensFreed` 很重要。snip 已经删掉消息，但被保留下来的 assistant usage（assistant 上报用量）可能仍反映删除前的上下文。如果不把释放量传给自动压缩，Stage 5 可能拿旧数据误判，过早触发摘要。

---

## 三、自动压缩什么时候触发

### 3.1 先扣除摘要输出预算

压缩调用本身也需要上下文窗口。`getEffectiveContextWindowSize()` 先从模型窗口中预留摘要输出空间：

```typescript
// src/services/compact/autoCompact.ts
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  // 摘要输出最多预留 20K，不能把输入塞到模型完全没有输出空间。
  const reserved = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )

  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  return contextWindow - reserved
}
```

也就是说，自动压缩不是等“整个模型窗口完全用满”才开始，而是要为摘要请求留下输出空间。

### 3.2 buffer（安全余量）随窗口大小变化

默认阈值可以概括为：

```text
自动压缩阈值
  = 有效上下文窗口
  - 自动压缩 buffer
```

当前实现根据有效窗口选择不同余量：

- 普通窗口：约 `13,000 tokens`；
- 更大的窗口：约 `30,000 tokens`；
- 超大窗口：约 `50,000 tokens`。

余量的作用是覆盖下一轮可能产生的模型输出和工具结果增长。触发太晚，会让摘要模型在接近满载的压力下总结很长历史；触发太早，又会增加摘要调用成本。

`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 可以把阈值提前到有效窗口的某个百分比，但源码仍会取不超过默认阈值的结果：

```typescript
// 例如设置 60，表示在有效窗口约 60% 处就开始考虑压缩。
const percentageThreshold = Math.floor(
  effectiveContextWindow * (parsed / 100),
)
return Math.min(percentageThreshold, autocompactThreshold)
```

### 3.3 session memory 优先于 LLM 摘要

自动压缩触发后，并不一定马上调用模型。`autoCompactIfNeeded()` 先尝试 `trySessionMemoryCompaction()`：

```text
达到自动压缩阈值
  ↓
尝试复用 session memory（会话记忆）产生的可用摘要
  ├─ 成功：直接裁剪并重建结果，跳过一次 LLM 调用
  └─ 失败：进入 compactConversation() 生成新摘要
```

这条路径利用了后台已经生成的会话记忆，减少重复总结。带用户自定义指令的手动 `/compact` 不适合直接复用通用 session memory，因为它需要按照用户指定的重点重新总结。

### 3.4 连续失败三次后熔断

自动压缩失败不会在同一轮无限重试。`autoCompact.ts` 保存 `consecutiveFailures`（连续失败次数），达到 3 次后暂停本会话的自动尝试：

```typescript
// 防止上下文已经不可恢复时，每一轮都重复调用失败的压缩 API。
if (
  tracking?.consecutiveFailures !== undefined &&
  tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
) {
  return { wasCompacted: false }
}
```

这叫 circuit breaker（熔断器）：它不是说上下文已经恢复，而是停止继续浪费 API 调用，把控制权交给用户的 `/compact`、`/clear` 或重新启动会话。

### 3.5 模型窗口检测：常规阈值之外还有预测线

自动压缩至少有两类检测：

- **常规阈值检测**：当前 token 已经达到 `effectiveWindow - buffer`；
- **预测式检测**：当前 token 加上本轮可能产生的模型输出和工具结果，预计会超过有效窗口。

查询循环里的预测式检测大致如下：

```typescript
// src/query.ts：snip 后的 token 估算才是当前发送视图的有效用量。
const currentTokens =
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed

// 有效窗口已经扣除了摘要输出预留。
const effectiveWindow = getEffectiveContextWindowSize(model)

// 估算本轮增长：模型输出上限 + 工具结果增长余量。
const estimatedGrowth = estimateMaxTurnGrowth(model)
const predictiveThreshold = effectiveWindow - estimatedGrowth

if (currentTokens > predictiveThreshold) {
  // 不等 API 报 Prompt Too Long，先做一次自动压缩。
  await deps.autocompact(
    messagesForQuery,
    toolUseContext,
    cacheSafeParams,
    querySource,
    tracking,
    snipTokensFreed,
  )
}
```

因此，模型窗口检测不是一个单独的 `if token > max`：

```text
原始模型窗口
  - 摘要输出预留
  = 有效窗口

有效窗口
  - 自动压缩 buffer
  = 常规自动压缩阈值

有效窗口
  - 本轮预计增长
  = 预测式自动压缩阈值
```

如果自动压缩关闭，系统还会使用 `blocking limit` 留出手动 `/compact` 的空间；如果自动压缩开启，则尽量在预测线提前压缩。只有本地估算低于实际服务端计数时，才会进入后面的 Reactive Compact（响应式压缩）。

---

## 四、Stage 5 的完整生命周期

`compactConversation()` 的职责可以压缩成一条八步流程：

```text
1. 执行 PreCompact hook（压缩前钩子）
2. 生成摘要请求，优先尝试复用主线程 Prompt Cache
3. 调用模型生成 summary
4. compact 自身超窗口时，截掉最老 API round 并重试
5. 清理读取状态，准备压缩后附件
6. 创建 compact_boundary 和摘要消息
7. 执行 PostCompact hook 与统一清理
8. 返回 boundary + summary + 保留消息 + attachments
```

### 4.1 Phase 1：PreCompact hook 先修改总结上下文

源码先执行：

```typescript
const hookResult = await executePreCompactHooks(
  {
    trigger: isAutoCompact ? 'auto' : 'manual',
    customInstructions: customInstructions ?? null,
  },
  context.abortController.signal,
)

// 用户指令和 hook 指令会合并，用户指令排在前面。
customInstructions = mergeHookInstructions(
  customInstructions,
  hookResult.newCustomInstructions,
)
```

这意味着 PreCompact hook（压缩前钩子）可以改变摘要质量，例如要求摘要重点保留：

- 当前修改过的文件和未提交 diff；
- 测试失败的完整堆栈；
- 用户最近一次修改过的要求；
- 当前计划的下一步。

它不是摘要之后的补救，而是摘要生成之前的输入增强。

### 4.2 Phase 2：摘要请求尽量复用 Prompt Cache

`streamCompactSummary()` 有两条调用路径：

1. **forked agent（分叉 Agent）路径**：复用主线程的缓存前缀；
2. **普通 streaming（流式）路径**：fork 失败或功能关闭时的降级方案。

分叉路径要求 system prompt、tools、模型和前缀消息保持一致。源码明确不能随意设置不同的 `maxOutputTokens`，否则 thinking config（思考配置）变化会破坏缓存键。

这不是为了让摘要 Agent 继续使用工具。压缩期间工具调用被拒绝，摘要模型只需要读取已有上下文并输出文本。

### 4.3 Phase 3：摘要 Prompt 强制要求九个部分

`prompt.ts` 的 `BASE_COMPACT_PROMPT` 要求摘要至少覆盖：

1. 用户的主要请求和意图；
2. 关键技术概念；
3. 读取、修改或创建过的文件和代码位置；
4. 遇到的错误与修复；
5. 已解决问题和仍在排查的问题；
6. 所有重要用户消息；
7. 待完成任务；
8. 压缩前正在进行的工作；
9. 下一步行动。

其中第 6、7、8 项尤其关键。只总结“技术结论”而没有用户反馈、未完成任务和当前工作，恢复后的 Agent 很容易产生“已经完成”的错觉。

摘要 Prompt 要求模型输出 `<analysis>` 和 `<summary>` 两个区块，但 `formatCompactSummary()` 会在写入 transcript 前移除 `<analysis>`：

```typescript
// 摘要分析区只用于生成过程，不应该成为下一轮上下文的一部分。
const summary = text
  .replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
  .trim()

// 最终写入的是 summary，不是模型的草稿推理。
return summary
```

这体现了一个简单边界：可以让摘要模型先整理思路，但不能把未经筛选的草稿继续污染主会话。

### 4.4 Phase 4：compact 自身超窗口时的 PTL 重试

PTL 是 Prompt Too Long（提示过长）错误。它可能发生在**压缩请求本身**：原始历史已经太长，连“请总结这段历史”的请求都无法送进模型。

`truncateHeadForPTLRetry()` 会把消息按 API round（一次 API 往返）分组，从最老的一组开始截掉：

```typescript
const groups = groupMessagesByApiRound(input)
if (groups.length < 2) return null

// 有服务端报告的 token 缺口时，逐组累加直到覆盖缺口；
// 无法解析时，退化为删除约 20% 的最老分组。
let dropCount = 0
if (tokenGap !== undefined) {
  let accumulated = 0
  for (const group of groups) {
    accumulated += roughTokenCountEstimationForMessages(group)
    dropCount += 1
    if (accumulated >= tokenGap) break
  }
} else {
  dropCount = Math.max(1, Math.floor(groups.length * 0.2))
}

// 至少保留一组，避免没有任何内容可供摘要。
const sliced = groups.slice(
  Math.min(dropCount, groups.length - 1),
).flat()
```

如果截掉头部后第一条变成 assistant 消息，源码会插入一个合成的 meta user marker（元用户标记），避免 API 收到不合法的 assistant-first 序列。这个过程最多重试 3 次，仍然失败就返回“无法总结”的错误。

注意：这一步是**损失性兜底**。它的目标是让用户摆脱卡死状态，不是保证摘要包含全部历史。

### 4.5 Phase 5：清理旧缓存并准备恢复附件

摘要成功后，源码先保存当前的文件读取状态，再清空：

```typescript
// 先快照，再清理；否则压缩后没有办法恢复最近读过的文件。
const preCompactReadFileState = cacheToObject(context.readFileState)

context.readFileState.clear()
context.loadedNestedMemoryPaths?.clear()

// 已调用的 skill 内容不主动清空，后面仍可能需要恢复。
// 这样可以避免每次压缩都重新注入完整 skill_listing。
```

随后并行准备压缩后的附件：

- 最近读取过的文件，默认受文件数和 token 预算限制；
- 正在运行或已完成但尚未取回的后台 Agent；
- 当前 plan 文件；
- plan mode（计划模式）状态；
- 已调用的 skill 内容；
- deferred tools、Agent listing、MCP instructions 的增量；
- `processSessionStartHooks('compact')` 返回的 hook 消息。

最近文件恢复不是“恢复所有文件”。`createPostCompactFileAttachments()` 会按最近访问时间排序，最多恢复有限数量，并且跳过已经存在于保留消息中的 `Read` 结果，避免同一份内容重复占用 token。

### 4.6 Phase 6：创建 boundary、summary 和统一消息顺序

压缩结果不是一条字符串，而是一个 `CompactionResult`：

```typescript
export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
}
```

最终消息顺序由 `buildPostCompactMessages()` 固定：

```typescript
// 统一顺序：边界 → 摘要 → 最近保留消息 → 恢复附件 → hook 消息
export function buildPostCompactMessages(
  result: CompactionResult,
): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...stripToolUseResults(result.messagesToKeep),
    ...result.attachments,
    ...result.hookResults,
  ]
}
```

这里的 `stripToolUseResults()` 只移除用于 UI 展示的大型 `toolUseResult` 字段，不会把 API 需要的 `tool_result` 内容误删。

### 4.7 Phase 7：PostCompact hook 和统一清理

压缩成功后还会执行 PostCompact hook，并调用 `runPostCompactCleanup()`。它主要清理：

- system prompt section 缓存；
- memory 文件缓存；
- microcompact 状态；
- classifier approval（分类器审批）状态；
- speculative check（预检查）状态；
- beta tracing（实验追踪）状态；
- session message cache。

但它**不会**主动清掉已经调用的 skill 内容。原因是后续压缩附件仍可能需要提供这些技能的正文；如果每次都重置，就会反复注入完整 skill listing，既耗 token 又破坏缓存。

子 Agent 的压缩还需要区分主线程状态。源码会根据 `querySource` 判断是否可以清理进程级模块状态，避免子 Agent 的压缩把主线程的 memory cache 或上下文折叠状态一起重置。

### 4.8 Phase 8：返回给调用方，由循环替换发送视图

`compactConversation()` 返回结果后，调用方把新消息组装为下一轮的发送视图。自动压缩成功会重置失败计数；手动压缩则可以保留用户指定的聚焦指令。

因此 Stage 5 的核心产物不是“删除后的数组”，而是一组能够继续运行的消息：

```text
boundary
  + summary
  + messagesToKeep
  + restored attachments
  + hook messages
```

---

## 五、压缩后的“遗忘”到底发生在哪里

### 5.1 摘要是有损的，但磁盘 transcript 通常仍在

摘要一定可能丢失细节。模型本轮只看到 summary 和保留尾部，旧消息的完整内容不再自动参与推理。

但这不等于 JSONL transcript 被物理删除。压缩会追加 boundary、summary 和后续消息；resume 仍可以读取这些记录，再按照边界关系构造内存视图。

所以应该分开描述：

```text
摘要遗漏细节
  ≠
磁盘历史删除
  ≠
运行时缓存清空
```

### 5.2 `readFileState.clear()` 是运行时缓存清理

`readFileState` 记录 Agent 最近读过哪些文件及其内容。压缩后清空它，主要是为了避免继续持有几十 MB 的旧文件内容，并让压缩后的附件恢复流程重新选择少量最近文件。

它不表示文件被删除，也不表示模型永远不能恢复。完整文件仍在工作区，模型可以通过 `Read` 再次读取；如果文件被重新作为附件恢复，则会再次进入模型上下文。

### 5.3 memory 的“不再注入”不等于永久遗忘

压缩后 `loadedNestedMemoryPaths` 会清空，memory 文件缓存也会在主线程压缩后失效。下一轮上下文装配可以重新加载需要的 memory。

已调用 skill 的内容则有意保留，不会每次压缩都当成未使用过。这里的策略是：

- 当前 summary 负责保留任务叙事；
- attachment 负责恢复运行环境；
- 原始文件和 memory 仍然可以通过路径重新读取。

### 5.4 真正不可逆的是 summary 没有留下恢复线索

如果一段历史既没有进入保留尾部，也没有被摘要提及，模型本轮就无法凭空知道它。即使 transcript 还在，模型也需要：

1. 从摘要知道旧事实可能存在；
2. 获得 transcript 或文件路径；
3. 主动调用工具读取细节。

因此压缩质量的核心不是“摘要看起来很完整”，而是“重要信息是否有可恢复入口”。这也是为什么 Prompt 强制要求文件路径、错误、用户反馈和待完成任务。

---

## 六、Preserved Segment：压缩后为什么不会把最近消息弄丢

### 6.1 JSONL 是追加式日志，不能靠物理删除重排

Claude Code 的 transcript 是追加式 JSONL。压缩时如果直接删除旧行，会破坏审计记录、resume 和分叉 Agent 的关系。

压缩因此写入一个 `compact_boundary`，并给保留段写入元数据：

```typescript
// src/services/compact/compact.ts：为保留消息记录三枚锚点
compactMetadata: {
  preservedSegment: {
    headUuid: keep[0].uuid,     // 保留段第一条消息
    anchorUuid,                 // 它逻辑上接在哪条消息之后
    tailUuid: keep.at(-1).uuid, // 保留段最后一条消息
  },
}
```

`Preserved Segment`（保留段）就是“物理上仍然位于旧边界之前，但逻辑上要接到新摘要之后的最近消息集合”。

### 6.2 `logicalParentUuid` 保留物理父链和逻辑父链

写入 compact boundary 时，源码会把正常 `parentUuid` 设为 `null`，再把原来的父关系写到 `logicalParentUuid`：

```typescript
const transcriptMessage = {
  // boundary 是新逻辑根，避免旧历史继续被完整遍历。
  parentUuid: isCompactBoundary ? null : effectiveParentUuid,

  // 保存 boundary 在原始日志中的逻辑父节点，供恢复重连。
  logicalParentUuid: isCompactBoundary ? parentUuid : undefined,

  ...message,
}
```

这样做的目的不是展示，而是让加载器知道：

- 新 boundary 从哪里切断旧主链；
- 保留段的第一条消息原来属于哪一条旧链；
- resume 时应该如何把保留段接到新摘要后面。

### 6.3 resume 时如何重写内存 DAG

DAG（有向无环图）在这里指消息通过 `parentUuid` 形成的分叉消息图。`applyPreservedSegmentRelinks()` 的逻辑可以概括为：

```text
1. 找到最后一个带 preservedSegment 的 boundary
2. 从 tailUuid 沿 parentUuid 向前走，确认能走到 headUuid
3. 保留这条 segment 内的 UUID
4. 把 head 的 parentUuid 改到 anchorUuid
5. 把 anchor 的其他子分支接到 tail，避免出现孤儿分支
6. 删除最后一个 boundary 之前、且不在保留段中的旧消息
```

源码先验证保留段能否从尾走到头；元数据损坏或链走不通时会选择 no-op（不执行重连），避免错误地删掉更多消息。

完成重连后，磁盘上的追加日志仍然保留原始 parent 关系，内存中的 `Map<UUID, TranscriptMessage>` 才是供当前会话使用的逻辑视图。这就是“源状态”和“派生视图”分离。

### 6.4 snip 也需要恢复时重连

snip 和 compact 的区别是：

- compact 通常截断历史前缀，并通过 preserved segment 保留一段尾部；
- snip 可以删除中间的一段消息，后续消息的 `parentUuid` 可能直接指向已删除节点。

因此 `sessionStorage.ts` 还会执行 `applySnipRemovals()`，删除被记录在 `removedUuids` 中的消息，并把后续幸存消息的父指针重新接回删除区间之前的节点。

如果只在内存数组里过滤，而不处理 resume 时的链路，重新加载会把 JSONL 中的旧分支重新拼回来，导致上下文再次膨胀。

---

## 七、Prompt Cache 与 partial compact

### 7.1 不能把缓存前缀直接改写

Prompt Cache（提示缓存）通常依赖稳定前缀。压缩确实要减少上下文，但不能简单地对已经缓存的前缀做原地字符串替换，否则下一次请求可能从 cache hit（缓存命中）退化成 cache creation（重新创建缓存）。

Claude Code 的处理方式有两种：

- microcompact 使用 `cache_edits`，让服务端跳过旧缓存块；
- Stage 5 尽量用 fork 路径复用主线程缓存前缀，失败后才走普通 streaming。

这是“本地消息语义保持稳定，远端请求视图按规则减量”的设计。

### 7.2 `partialCompactConversation()` 为什么有两个方向

部分压缩允许围绕一个 pivot index（枢轴位置）只总结一侧消息：

| 方向 | 被总结部分 | 保留部分 | 缓存影响 |
| --- | --- | --- | --- |
| `from` | pivot 之后的近期消息 | pivot 之前的前缀 | 保留前缀，适合继续复用缓存 |
| `up_to` | pivot 之前的历史前缀 | pivot 之后的尾部 | 摘要位于保留消息之前，缓存前缀会变化 |

两个方向不能只靠一个 Prompt 参数替代，因为摘要结尾语义不同：

- `from` 要说明最近工作做到哪里、下一步是什么；
- `up_to` 要说明前缀已经完成了什么，后续保留消息从哪里继续。

部分压缩同样会恢复最近文件、计划、技能和工具增量，并为 boundary 标记正确的 anchor。

---

## 八、失败与兜底

### 8.1 预测性压缩漏判：Reactive Compact

本地 token 估算可能因为图片、复杂 content block 或服务端计数差异而低估。API 返回 Prompt Too Long 后，`reactiveCompact.ts` 会尝试一次响应式压缩：

```typescript
// 只允许一次响应式尝试，避免“失败 → 压缩 → 失败”的无限循环。
if (hasAttempted || aborted) {
  return null
}

try {
  return await compactConversation(
    messages,
    params.toolUseContext,
    params,
    true,   // 抑制压缩期间的追问
    undefined,
    true,   // 按自动压缩路径处理
    recompactionInfo,
  )
} catch (error) {
  // 响应式压缩失败时，把控制权交还给上层错误处理。
  logError(error)
  return null
}
```

这条路径是事后兜底，不是默认触发机制。默认仍应尽量在 API 请求前通过阈值判断完成压缩。

### 8.2 compact 请求本身 PTL

这是第四章已经说明的“截头重试”路径：按 API round 丢弃最老分组，最多重试 3 次；如果仍然无法生成摘要，就提示用户手动 `/compact` 或 `/clear`。

### 8.3 fork 摘要失败

如果复用主线程缓存的 fork Agent 失败，`streamCompactSummary()` 会退回普通流式请求。退回路径不再要求和主线程共享同一缓存前缀，因此可以使用独立的输出预算。

如果普通流式路径也没有拿到 assistant 文本，compact 会返回 incomplete response（响应不完整）错误，不会伪造一条空摘要。

### 8.4 连续自动压缩失败

自动压缩失败会增加 `consecutiveFailures`；成功后重置为 0。达到 3 次熔断后，本会话不再每轮自动重试。

这几个失败层次的边界要分清：

| 失败类型 | 处理方式 |
| --- | --- |
| 估算漏判，普通 API PTL | 响应式压缩一次 |
| compact 自己 PTL | 截掉最老 API round，最多重试 3 次 |
| fork 无法复用缓存 | 退回普通 streaming |
| 自动压缩连续失败 | 达到 3 次后熔断 |
| 摘要为空或流式响应不完整 | 返回明确错误，不写入伪摘要 |

---

## 九、手动调优与边界

### 9.1 什么时候主动 `/compact`

默认自动压缩通常接近有效窗口上限才触发。对于复杂重构、长时间调试或需要保留错误细节的任务，主动压缩通常更稳：

```text
一个阶段完成
  → /compact 聚焦在下一阶段
  → 让摘要记录已完成工作、当前 diff、失败原因和下一步
  → 在历史尚未接近满载时开始下一阶段
```

带聚焦指令的 `/compact` 会跳过通用 session memory 摘要，直接调用 LLM 按用户要求总结。例如：

```text
/compact 聚焦 auth 模块重构，保留 login.ts 和 middleware.ts 的改动、
所有测试错误堆栈，以及用户关于保留错误处理的反馈。
```

### 9.2 `/force-snip` 和 `/compact` 的区别

| 操作 | 是否调用 LLM | 是否保留摘要 | 适合场景 |
| --- | --- | --- | --- |
| `/force-snip` | 否 | 否 | 已确认无价值的试错或跑题分支 |
| `/compact` | 是 | 是 | 需要保留任务脉络和下一步 |

如果用户已经知道某段内容完全不需要，就不应该让模型再花一次调用去总结它。

### 9.3 常用环境变量

| 变量 | 作用 |
| --- | --- |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 提前或调整自动压缩触发百分比 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 用更小的窗口模拟更早触发 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 调整手动 compact 的阻塞红线 |
| `DISABLE_AUTO_COMPACT=1` | 关闭自动压缩，但保留手动 `/compact` |
| `DISABLE_COMPACT=1` | 关闭所有压缩 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | 禁用 1M 上下文窗口 |

提前压缩会增加摘要调用次数，但通常能改善摘要质量；关闭压缩则把上下文超限风险直接交给用户和上层错误处理。

### 9.4 当前实现的真实边界

压缩成功不等于后续推理一定完整，主要边界包括：

- 摘要是有损的，细粒度操作和未提交改动可能被概括；
- 触发太晚时，摘要模型要总结的历史过长，细节更容易丢；
- 最近文件恢复受文件数和 token 预算限制，不会恢复全部读取内容；
- session memory 或文件归档线索缺失时，模型未必知道去哪里找旧事实；
- 响应式压缩只尝试一次，失败后仍可能返回 PTL；
- 连续熔断后，系统不会继续自动尝试，需要人工处理会话。

因此，压缩系统的正确承诺不是“永远不遗忘”，而是：

```text
尽量提前减量
  + 把重要历史压成可继续工作的摘要
  + 保留可恢复的文件与 transcript 入口
  + 在失败时停止无限重试
```

---

## 本篇小结

Claude Code 的上下文压缩可以记成五级：

```text
第一层：限制单条工具结果的体积
第二层：删除用户明确标记的无价值分支
第三层：清理跨多轮累积的旧工具结果
第四级：把清理策略交给 API 服务端
第五级：在整段历史过长时生成摘要并重建环境
```

最重要的阅读结论有五条：

1. 压缩发生在 Agent Loop 的 API 调用之前，优先执行低成本减量。
2. Stage 5 不是删除消息，而是 `boundary + summary + 保留消息 + 附件` 的重建。
3. 摘要改变模型视图；JSONL transcript、工作区文件和部分运行状态仍有恢复入口。
4. `Preserved Segment` 和 `logicalParentUuid` 解决的是追加式日志与逻辑消息链之间的矛盾。
5. “遗忘”主要发生在摘要未覆盖且没有恢复线索的细节上，不应和缓存清理、磁盘删除混为一谈。

下一篇进入[推理与思维链](cc-09-reasoning-and-cot.md)，继续看模型输出中的思考内容、签名块和消息规范化如何进入 Agent Loop。
