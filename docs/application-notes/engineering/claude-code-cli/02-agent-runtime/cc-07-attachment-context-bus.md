---
slug: /application-notes/engineering/claude-code-cli/cc-07-attachment-context-bus
sidebar_position: 7
title: "附件上下文总线"
description: "动态上下文不会直接散落到 messages，而是先经过附件上下文总线（Attachment Bus）的生成、去重、预算、渲染和注入管线。本篇拆解图片、文件、记忆、任务通知、工具增量和模式提醒如何进入 Agent 循环（Agent Loop）。"
---

> *启动时的上下文负责冻结稳定前缀；附件总线负责把每轮刚刚发生的变化，以可去重、可预算、可审计的方式送进对话。*
>
> **Harness 层定位**：**[02 §三 组件 5.5 附件层](../01-architecture-lifecycle/cc-02-harness-design.md)** —— 在系统提示词（system prompt）之外补足每轮动态信息和多模态输入。

# 附件上下文总线

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd`。正文引用的是本地实现，行号可能随源码变动，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **附件值对象和生成总线**：`src/utils/attachments.ts` 的 `Attachment`、`getAttachments()`、`maybe()`。
> - **附件消息包装**：`src/utils/attachments.ts` 的 `createAttachmentMessage()`、`getAttachmentMessages()`。
> - **API 侧规范化**：`src/utils/messages.ts` 的 `normalizeMessagesForAPI()`、`normalizeAttachmentForAPI()`、`wrapInSystemReminder()`。
> - **用户输入宿主**：`src/utils/processUserInput/processUserInput.ts`，负责首轮输入中的 `@file`、IDE 选区和资源引用。
> - **循环间隙宿主**：`src/query.ts`，负责队列消息、记忆预取、技能发现和工具发现的收割。
> - **UI 隐形清单**：`src/components/messages/nullRenderingAttachments.ts`，明确哪些附件只给模型或会话记录（transcript），不在界面渲染。
> - **增量账本**：`src/utils/searchExtraTools.ts`、`src/utils/mcpInstructionsDelta.ts`，从历史附件重建已经宣告的工具或 MCP 说明集合。

## 为什么要单独有一条附件总线

第 06 篇解决的是启动时的上下文装配：默认系统提示词（system prompt）、项目指令和 `MEMORY.md` 等稳定内容如何形成请求前缀。

但 Agent 开始工作后，环境还会继续变化：

- 用户通过 `@file` 指定了一个文件或目录；
- IDE 产生了新的选区；
- 文件刚刚被 linter 或用户修改；
- 一个后台任务完成并把结果放进队列；
- MCP server 连接或断开，工具集合发生变化；
- 记忆预取、技能发现和工具发现异步完成；
- 进入 plan mode、auto mode，或者跨过了午夜；
- 上下文压缩后，需要恢复计划文件、任务状态或已调用技能。

如果每个子系统都直接往 `messages` 里追加文本，会出现三个问题：

1. **重复注入**：同一条技能列表、记忆文件或工具说明反复进入上下文。
2. **预算失控**：不同模块各自限制大小，最终没有统一的单轮预算。
3. **无法审计**：无法区分这条消息来自用户、工具、后台任务还是 Harness 注入，也无法在下一轮重建“已经宣告过什么”。

附件总线把这些动态信息先收编成 `Attachment` 值对象，再统一经过：

```text
各类动态来源
  ↓
getAttachments()
  ├─ 用户输入附件
  ├─ 所有线程共享附件
  └─ 主线程专属附件
  ↓
去重 / delta / 节流 / 字节预算
  ↓
AttachmentMessage
  ↓
normalizeAttachmentForAPI()
  ↓
<system-reminder> 包装的 isMeta user message
  ↓
messagesForQuery → 下一次模型请求
```

因此，附件不是一种业务数据，而是一条**动态上下文进入模型的统一协议**。

## 读完后应该能回答什么

- `Attachment` 和 `AttachmentMessage` 的职责有什么不同？
- `getAttachments()` 为什么要分成用户输入、线程共享和主线程专属三组？
- `maybe()` 的 1000ms deadline 和错误吞没分别解决什么问题？
- 为什么工具列表和 MCP 说明采用 delta，而文件内容和任务通知采用不同的去重方式？
- 附件为什么最终变成 `isMeta: true` 的 user 消息，而不是 system 消息？
- `query.ts` 为什么在工具执行完成后才收割附件？
- 哪些附件只进入模型和 transcript，不应该占用 UI 的消息预算？

---

## 一、先确定附件总线的边界

### 1.1 启动时上下文与逐轮附件

可以用“稳定性”和“注入时机”区分第 06 篇与本篇：

| 内容 | 典型来源 | 主要时机 | 主要目标 |
| --- | --- | --- | --- |
| 稳定上下文 | 默认 system prompt、`CLAUDE.md`、`MEMORY.md` | 会话启动或上下文重建 | 形成可缓存的请求前缀 |
| 动态附件 | 文件变化、任务通知、记忆召回、工具增量、模式提醒 | 每轮 API 调用前 | 把最新变化追加到对话尾部 |
| 工具 Schema | 内置工具、MCP 工具 | 请求构造阶段 | 告诉模型有哪些工具和参数 |
| 会话历史 | 用户、assistant、tool result | 每轮投影视图 | 保留当前任务的执行轨迹 |

附件总线不替代 `systemPrompt`，也不负责执行工具。它只负责把“需要在这一轮追加给模型的信息”转换成标准消息。

### 1.2 `Attachment` 是数据对象，不是最终 prompt

`Attachment` 是一个以 `type` 为判别字段的联合类型。它的成员很多，但可以先按数据语义分成六组：

| 类型组 | 代表类型 | 作用 |
| --- | --- | --- |
| 文件与多模态 | `file`、`directory`、`pdf_reference`、`selected_lines_in_ide` | 把用户指向的文件、目录、PDF 或选区送入上下文 |
| 记忆与恢复 | `nested_memory`、`relevant_memories`、`plan_file_reference` | 恢复项目记忆、按需记忆和压缩后的关键文件 |
| 能力增量 | `skill_listing`、`agent_listing_delta`、`mcp_instructions_delta`、`deferred_tools_delta` | 宣告新增或移除的能力 |
| 模式与提醒 | `plan_mode`、`auto_mode`、`date_change`、`token_usage` | 提醒模型当前模式、日期和预算状态 |
| 异步事件 | `queued_command`、`task_status`、`diagnostics`、`async_hook_response` | 把后台任务、队列、诊断和 Hook 结果回注到模型 |
| UI 或协议标记 | `agent_mention`、`structured_output`、部分 Hook 类型 | 参与路由、transcript 或 SDK 协议，但不一定渲染给模型或用户 |

源码里的具体类型数量会随功能开关（feature gate）和实现演进变化，不应该把“当前有多少个成员”当成稳定 API。真正稳定的是每个成员都有自己的 `type`，后续生成、渲染、UI 和会话记录（transcript）扫描都依靠这个标签分派。

```typescript
// src/utils/attachments.ts：Attachment 的核心思想是“数据先带标签，渲染后决定语义”
export type Attachment =
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        // 在创建附件时固定 header，避免相对时间变化导致 cache miss。
        header?: string
        limit?: number
      }[]
    }
  | {
      type: 'queued_command'
      prompt: string | Array<ContentBlockParam>
      commandMode?: string
      origin?: MessageOrigin
      // 区分用户插话和系统注入的队列消息。
      isMeta?: boolean
    }
  | {
      type: 'task_status'
      taskId: string
      status: TaskStatus
      description: string
    }
  // 其余成员继续使用同样的 type 判别模式。
```

`Attachment` 只描述“发生了什么”。它不在这里决定最终显示成普通文本、工具结果、图片、PDF，还是完全不进入 API。这些决定留给 `normalizeAttachmentForAPI()`。

---

## 二、生成阶段：`getAttachments()` 如何组织来源

### 2.1 三组生产者

`getAttachments()` 先判断当前调用是否需要处理附件，然后把生产者分成三组：

1. **用户输入附件**：只有 `input` 不为空时才生成，例如 `@file`、MCP resource、agent mention 和首轮技能/工具发现。
2. **线程共享附件**：主线程和子 Agent 都可能需要，例如队列消息、日期变化、工具增量、文件变化、记忆和 plan 提醒。
3. **主线程专属附件**：IDE 选区、LSP 诊断、预算、输出风格和部分任务状态。

用户输入附件必须先完成，线程共享附件才开始：

```typescript
// src/utils/attachments.ts：先处理用户输入，再处理依赖这些结果的线程附件
const userAttachmentResults = await Promise.all(userInputAttachments)

const allThreadAttachments = [
  // 队列消息已经在 query.ts 中按 Agent 路由。
  maybe('queued_commands', () =>
    getQueuedCommandAttachments(queuedCommands),
  ),
  maybe('changed_files', () => getChangedFiles(context)),
  maybe('nested_memory', () => getNestedMemoryAttachments(context)),
  // 记忆正文走独立的异步预取，这里只保留其他附件生产者。
  maybe('skill_listing', () => getSkillListingAttachments(context)),
  maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
]

// 主线程独有的 IDE、诊断、预算和任务附件。
const mainThreadAttachments = isMainThread
  ? [
      maybe('ide_selection', () => getSelectedLinesFromIDE(ideSelection, toolUseContext)),
      maybe('diagnostics', () => getDiagnosticAttachments(toolUseContext)),
      maybe('token_usage', () => getTokenUsageAttachment(messages, model)),
    ]
  : []
```

这个顺序不是纯粹的性能优化。`@file` 处理过程会更新 `nestedMemoryAttachmentTriggers`，所以必须在 `nested_memory` 生成之前完成，否则进入子目录后对应的 `CLAUDE.md` 可能不会被发现。

### 2.2 1000ms 总 deadline 与 `maybe()`

每次 `getAttachments()` 会创建一个 `AbortController`，并设置约 1000ms 的总 deadline。单个生产者被 `maybe()` 包起来：

```typescript
// src/utils/attachments.ts：附件是尽力而为（best-effort）的增强，生成失败不能中断主循环
async function maybe<A>(
  label: string,
  compute: () => Promise<A[]>,
): Promise<A[]> {
  const startTime = Date.now()

  try {
    const result = await compute()

    // 只抽样记录耗时和大小，避免每个附件都产生 telemetry。
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: Date.now() - startTime,
        attachment_count: result.length,
      })
    }

    return result
  } catch (error) {
    // 记日志，但让本轮继续发送已有的消息和工具调用。
    logError(error)
    logAntError(`Attachment error in ${label}`, error)
    return []
  }
}
```

这里有两个设计取舍：

- **超时是局部降级，不是整轮失败**：记忆检索或 IDE 读取超时，只代表这类动态上下文缺席，不应该阻塞模型回答。
- **错误被记录但不向上抛出**：附件是补充信息，不是模型调用和工具执行的必要条件。

当环境变量关闭附件时，源码不会直接返回空数组，而是保留 `queued_command`：

```typescript
if (attachmentsDisabled) {
  // query.ts 后面会无条件消费队列；直接返回 [] 会静默丢失后台任务通知。
  return getQueuedCommandAttachments(queuedCommands)
}
```

这说明队列通知和普通辅助附件的可靠性等级不同：文件变化可以漏一轮，后台任务完成消息不能被无声丢弃。

### 2.3 `getAttachments()` 与 `getAttachmentMessages()` 的边界

`getAttachments()` 返回纯数据对象；`getAttachmentMessages()` 再把每个对象包装成会话记录（transcript）可保存的消息：

```typescript
export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage<Attachment> {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

export async function* getAttachmentMessages(...): AsyncGenerator<AttachmentMessage> {
  const attachments = await getAttachments(...)

  for (const attachment of attachments) {
    // 先保留结构化 type，后面才能重建 delta 和判断 UI 是否隐形。
    yield createAttachmentMessage(attachment)
  }
}
```

这一步把“生成结果”和“消息事实”分开：

- `Attachment` 适合做过滤、排序、预算和业务判断；
- `AttachmentMessage` 适合进入 `messages`、会话记录（transcript）和 UI；
- API 侧文本直到 `normalizeMessagesForAPI()` 才生成。

---

## 三、去重与增量：为什么不是所有附件都用同一种 seen 机制

附件的去重不是一个全局 `Set` 就能解决。不同附件的“重复”定义不同，源码大致有四种姿势。

### 3.1 集合去重：技能列表和已经展示的记忆

技能列表和相关记忆通常只需要知道“这个路径或名称以前是否已经展示”。例如记忆召回会把已经展示过的路径排除，再把新结果写回 `readFileState`：

```typescript
const selected = allResults
  .flat()
  // 已经被 FileReadTool 读过，或已经作为附件展示过的记忆不重复注入。
  .filter(memory =>
    !readFileState.has(memory.path) &&
    !alreadySurfaced.has(memory.path),
  )
  // 单轮最多注入 5 个文件。
  .slice(0, 5)
```

这里的“去重”只表示当前上下文不再重复展示，不等于删除持久化文件。上下文压缩后，旧附件从发送视图消失，后续仍可能重新召回。

### 3.2 会话记录（transcript）账本：工具和 MCP 的增量（delta）

工具列表和 MCP instructions 不是每轮发送完整快照，而是比较：

```text
当前可用集合
  - 会话记录（transcript）中已经宣告过的集合
  = 本轮新增

已经宣告过的集合
  - 当前可用集合
  = 本轮移除
```

`getDeferredToolsDelta()` 和 `getMcpInstructionsDelta()` 都会扫描历史中的同类附件，重建 `announced` 集合，再生成 `addedNames` 和 `removedNames`。

这种方式适合“能力宣告”，原因有两个：

- MCP server 或延迟工具池可能在两轮之间变化；
- 压缩或恢复（resume）后，系统仍然可以从会话记录重新推导模型已经知道哪些能力。

因此 delta 附件本身就是一份上下文账本，而不是一次性事件。

### 3.3 时间戳比较：文件变化

`readFileState` 保存文件内容和 `mtime`。每轮检查时：

```text
已读文件的 mtime 没变
  → 不重复发送全文

已读文件的 mtime 变新
  → 生成 edited_text_file
  → 发送 diff 或片段
  → 保留原文件的上下文连续性
```

这类附件不需要扫描所有历史消息，因为文件系统的修改时间已经是变化信号。重点是处理原子保存造成的短暂 `ENOENT`：一次临时文件替换过程中的 stat 失败不能立刻把文件从 `readFileState` 驱逐，否则下一次 `Edit` 可能因为“没有先读取文件”而失败。

### 3.4 取走即清：队列、Hook 和诊断

后台任务完成、异步 Hook 和队友信箱属于一次性事件。它们在附件生成后会从来源处删除、标记已读或清空：

- 队列消息：从队列移除；
- 异步 Hook：移除已经交付的响应；
- LSP 诊断：清除已经取出的诊断；
- 队友信箱：按消息谓词标记已读。

这类附件的幂等性来自“源头只出一次”，而不是来自历史 diff。

> 记忆召回适合集合去重，工具能力适合 transcript delta，文件内容适合 mtime 比较，后台事件适合取走即清。先判断附件的生命周期，再选择去重方式。

---

## 四、预算：附件绕开 tool result 预算，所以必须自带限制

附件最终通常作为 `isMeta` user message 进入 `messages`。它不一定经过普通 tool result 的大小预算，因此大内容必须在生产阶段主动限流。

| 附件 | 主要限制 | 目的 |
| --- | --- | --- |
| 记忆文件 | 单轮最多 5 个、单文件约 4KB、会话累计约 60KB | 防止长期记忆持续膨胀 |
| `MEMORY.md` / 规则文本 | 行数和外部文件读取限制 | 控制常驻指令大小 |
| 目录附件 | 目录项数量上限 | 防止一次 `@directory` 产生超大列表 |
| PDF | 超过页数阈值时只发送引用 | 让模型按需读取，不在首轮内联全文 |
| IDE 选区 | 字符数上限 | 防止选区直接占满本轮上下文 |
| 技能列表 | 按上下文窗口比例限制总描述长度 | 保留可发现性，同时控制列表成本 |
| plan / auto 提醒 | 按人类 turn 节流，full 与 sparse 分级 | 避免工具密集循环中反复刷屏 |

节流计数必须以人类 turn 为单位，而不是 assistant 消息数量。`query.ts` 每次工具调用后都可能进入一次附件收割；如果按 assistant 消息计数，一个包含几十次工具调用的人类请求会被误判成几十个 turn。

还有一条容易漏掉的缓存约束：如果附件在多轮中重复出现，渲染后的文本字节必须保持稳定。相关记忆的 `header` 在创建附件时就计算好，不能在每次渲染时重新调用 `Date.now()` 生成“几天前”，否则相对时间变化会造成不必要的 Prompt Cache miss。

---

## 五、渲染契约：结构化附件怎样变成模型消息

### 5.1 `normalizeAttachmentForAPI()` 是唯一渲染入口

附件生产者只提供事实，API 文本统一由 `normalizeAttachmentForAPI()` 的 `switch` 生成。这样同一个附件可以同时服务：

- API：生成模型可读的消息；
- transcript：保留结构化 `type` 和原始字段；
- UI：根据类型决定可见或隐藏；
- compact/resume：根据结构重新渲染。

统一入口还让新增附件时必须明确选择：它应该渲染为文本、工具结果、图片、PDF，还是返回空数组。

### 5.2 为什么用 `isMeta` 的 user 消息

Anthropic Messages API 的 `system` 是顶层字段，不能在对话中途插入一条 system role 消息。附件又必须在每轮尾部追加，因此最终使用 user 消息承载，但加上 `isMeta: true` 表明这不是用户实际输入：

```typescript
// src/utils/messages.ts：附件最终进入 API 前统一转成 user 消息
case 'attachment': {
  const raw = normalizeAttachmentForAPI(message.attachment as Attachment)

  // 所有附件文本都包上 system-reminder，便于后续识别系统注入。
  const normalized = raw.map(ensureSystemReminderWrap)

  const lastMessage = last(result)
  if (lastMessage?.type === 'user') {
    // 合并相邻 user 消息，避免 API 收到无意义的连续 user turn。
    result[result.length - 1] = normalized.reduce(
      (previous, current) =>
        mergeUserMessagesAndToolResults(previous, current),
      lastMessage,
    )
  } else {
    result.push(...normalized)
  }
  return
}
```

`isMeta` 有三个作用：

1. UI 可以隐藏系统注入，不把它伪装成用户说过的话；
2. 上下文治理可以跳过这些消息，不把它们当作人类 turn；
3. transcript 仍保留完整结构，方便恢复、去重和审计。

### 5.3 `<system-reminder>` 是消息边界，不是安全魔法

附件文本通常包装为：

```typescript
export function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
```

这个标签主要解决消息规整问题：后续逻辑可以可靠识别哪些文本来自 Harness，并把它们合并到正确的 user/tool result 位置。

它本身不是权限系统。用户手动输入 `<system-reminder>fake</system-reminder>`，仍然是普通的非 meta user 消息；真正可信的边界来自：

- 附件只能由 `normalizeAttachmentForAPI()` 生成；
- `isMeta` 和消息来源字段由运行时设置；
- UI、去重和 transcript 扫描都基于结构化 `type`，而不是只看 XML 文本。

### 5.4 文件附件为什么常常渲染成伪 tool result

`@file`、目录和部分媒体输入，不一定直接渲染成“用户提供了一段文本”。源码会把它们转换成模型熟悉的文件读取结果形态，原因是：

- 文件内容更接近真实 `Read` 工具的结果；
- `readFileState` 可以继续记录它已经被读过；
- 后续文件变更可以生成 `edited_text_file`，而不是重新发送全文；
- 大文件、PDF 和图片可以沿用各自的截断或引用策略。

所以 `Attachment` 是统一入口，但不同类型仍然可以选择不同的 API 表达形态。

---

## 六、注入时序：两个宿主时刻和异步预取

### 6.1 首轮：`processUserInput.ts`

用户输入进入系统后，`processUserInput.ts` 调用 `getAttachmentMessages()`：

```typescript
// src/utils/processUserInput/processUserInput.ts
const attachmentMessages = shouldExtractAttachments
  ? await toArray(
      getAttachmentMessages(
        inputString,
        context,
        ideSelection ?? null,
        [], // 中途队列由 query.ts 处理
        messages,
        querySource,
      ),
    )
  : []
```

这里适合处理依赖当前输入的内容：`@file`、agent mention、MCP resource、首轮技能发现和 IDE 选区。

### 6.2 循环间隙：`query.ts`

模型完成一轮工具调用后，`query.ts` 在下一次 API 调用前收割动态附件：

```typescript
// src/query.ts：工具结果完成后，把新附件作为下一轮上下文的一部分
for await (const attachment of getAttachmentMessages(
  null,
  updatedToolUseContext,
  null,
  queuedAutonomyClaim.attachmentCommands,
  messagesForQuery.concat(assistantMessages, toolResults),
  querySource,
)) {
  yield attachment
  // 先写入当前 turn 的消息视图，下一轮才能看到这条附件。
  toolResults.push(attachment)
}

// 记忆预取如果还没完成，本轮零等待跳过，下一轮继续尝试收割。
if (
  pendingMemoryPrefetch?.settledAt !== null &&
  pendingMemoryPrefetch?.consumedOnIteration === -1
) {
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,
  )

  for (const attachment of memoryAttachments) {
    const message = createAttachmentMessage(attachment)
    yield message
    toolResults.push(message)
  }
}
```

这段时序有三个关键点：

- **先工具结果，后附件**：不能在未闭合的 `tool_result` 中间插入普通 user 内容，否则 API 消息顺序可能非法。
- **附件进入 `toolResults`**：虽然它不是工具执行结果，但在本轮状态中作为“下一次请求要发送的动态消息”保存。
- **异步预取不阻塞循环**：记忆、技能和工具发现可以和模型生成并行，收割点只消费已经完成的结果。

### 6.3 预取的真正意义

`startRelevantMemoryPrefetch()` 会在用户 turn 开始时启动 side query。模型流式输出、工具执行期间，记忆选择器在后台工作；如果下一次附件收割时已经完成，就把结果接回主消息流。

这种模式把一次额外检索的延迟藏到模型生成时间里，但不牺牲正确性：未完成的检索不会阻塞主循环，也不会把未完成的 Promise 当作模型上下文。

---

## 七、transcript 与 UI：同一附件的两种消费方式

### 7.1 transcript 为什么必须保留结构化附件

如果只把附件提前渲染成字符串，系统会失去三种能力：

- 无法从历史中重建 delta 的“已宣告集合”；
- 无法区分记忆、任务通知、Hook 和文件变更；
- compact/resume 时无法按类型重新生成或隐藏内容。

因此 transcript 中保存的是：

```typescript
{
  type: 'attachment',
  attachment: {
    type: 'agent_listing_delta',
    addedNames: ['researcher'],
    removedNames: [],
  },
  uuid: '...',
  timestamp: '...',
}
```

API 侧可以把它转成自然语言，delta 逻辑仍然读取结构化字段，二者互不耦合。

### 7.2 UI 隐形必须是显式选择

`nullRenderingAttachments.ts` 维护了一份类型清单，当前包括日期变化、token 预算、plan/auto mode 提醒、文件修改提示、部分 Hook 和工具增量等类型。

这些附件可能必须发送给模型，却不适合显示给用户。UI 侧先过滤它们，再应用消息数量和渲染预算：

```typescript
const NULL_RENDERING_TYPES = [
  'date_change',
  'token_usage',
  'plan_mode',
  'edited_text_file',
  'mcp_instructions_delta',
  // 其余只给模型或 transcript 的附件类型。
] as const satisfies readonly Attachment['type'][]
```

TypeScript 还要求 `AttachmentMessage` 的渲染 switch 对所有新增类型作出选择：要么增加可见渲染分支，要么把类型加入隐形清单。这样“用户看不到”是一个明确的设计决策，而不是漏写 UI 分支后的偶然结果。

---

## 八、四个典型附件链路

### 8.1 `@file`：从用户输入到文件读取上下文

```text
用户输入 @src/index.ts
  ↓
processUserInput.ts 调用 getAttachmentMessages()
  ↓
getAttachments() → processAtMentionedFiles()
  ↓
文件读取、大小限制、权限检查
  ↓
file / already_read_file / edited_text_file
  ↓
normalizeAttachmentForAPI()
  ↓
isMeta user + 文件内容或伪 tool_result
```

如果文件已经在 `readFileState` 中且 mtime 没变，就不重复发送全文；如果 mtime 变新，则发送变化片段。这样 `@file` 不只是一次性导入，也连接了后续的文件变更检测。

### 8.2 `relevant_memories`：异步召回与双层去重

记忆附件由第 06 篇中的 `findRelevantMemories()` 选择，再通过本篇的附件总线注入：

```text
用户 turn 开始
  → startRelevantMemoryPrefetch()
  → side query 选择相关文件
  → 记忆内容按 5 条 / 4KB / 会话预算读取
  → query.ts 收割已经完成的 Promise
  → filterDuplicateMemoryAttachments()
  → relevant_memories AttachmentMessage
  → <system-reminder> user message
```

这里有两层去重：

- 选择阶段用 `alreadySurfaced`，避免 side query 把已经展示的路径再次选中；
- 收割阶段用 `readFileState`，过滤本轮工具调用或前一轮已经读过的文件。

这也是附件总线的价值：记忆模块只负责“选哪些文件”，消息模块负责“何时注入、是否重复、如何进入 API”。

### 8.3 `queued_command`：后台事件的可靠回注

后台任务、用户插话和协调者消息先进入进程级队列。`query.ts` 会按主线程或子 Agent 的 `agentId` 做路由，再将消息转换成 `queued_command` 附件。

它和普通提醒的区别是：队列消息被消费后会从来源移除，若生成函数直接返回空数组，就可能造成“已经出队但没有进入模型”的消息丢失。因此关闭附件模式时，源码仍然保留队列附件。

### 8.4 `agent_listing_delta` 与 `mcp_instructions_delta`：能力宣告

工具池和 MCP 说明适合增量传播，不适合每轮发送完整列表：

```text
当前工具集合 - 已宣告工具集合 = addedNames
已宣告工具集合 - 当前工具集合 = removedNames
```

delta 附件进入 transcript 后，下一轮可以继续从历史重建宣告状态。它既减少 token，也避免动态工具变化直接修改稳定的 system prompt 前缀。

---

## 九、几个容易讲错的边界

### 9.1 Attachment Bus 不是工具执行器

附件总线可以把工具结果、任务状态或工具列表变化送进消息，但它不执行工具，也不决定模型是否调用工具。工具执行仍由 `ToolUseContext`、权限层和工具实现负责。

### 9.2 `AttachmentMessage` 不是 API 的最终形态

transcript 中的 `type: 'attachment'` 是内部结构。真正发送给模型前，还要经过 `normalizeAttachmentForAPI()`、`<system-reminder>` 包装、相邻 user 合并、tool result 配对和不可用工具引用过滤。

### 9.3 附件不是永久记忆

附件进入当前消息视图后，是否持久化、是否在压缩后恢复、是否被 UI 隐藏，取决于具体类型。不要把“本轮注入过”理解成“已经写入长期记忆”。

### 9.4 关闭附件不等于关闭所有动态消息

`CLAUDE_CODE_DISABLE_ATTACHMENTS` 和 simple mode 会跳过大多数附件生产者，但队列消息仍需保留，否则后台任务通知可能在消费时被丢弃。

### 9.5 `<system-reminder>` 不等于安全边界

它是消息规整和来源区分的约定，不是不可伪造的权限标记。真正的区分依靠结构化消息类型、`isMeta`、来源字段和运行时生成路径。

---

## 本篇小结

Attachment Bus 的核心不是“把各种内容塞到 messages”，而是给动态上下文建立统一生命周期：

```text
识别来源
  → 生成 Attachment
  → 按生命周期选择去重方式
  → 在生产阶段执行预算和超时控制
  → 包装成 AttachmentMessage 写入 transcript
  → API 侧统一渲染为 isMeta user / tool result / 多模态 block
  → UI 按类型决定可见或隐形
```

读源码时可以记住四条判断：

- 稳定行为规则进入 `systemPrompt`，每轮变化进入 Attachment Bus；
- `Attachment` 保存结构化事实，`normalizeAttachmentForAPI()` 决定模型看到的文本形态；
- 不同生命周期对应不同去重方式：集合、transcript delta、mtime、取走即清；
- UI 隐藏只是展示策略，不能据此推断附件没有进入模型或 transcript。

这条总线把“动态世界”接到了第 04 篇的 Agent Loop，也为第 08 篇的上下文压缩提供了可重建的结构化输入。
