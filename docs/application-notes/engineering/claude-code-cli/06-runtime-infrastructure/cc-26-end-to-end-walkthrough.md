---
slug: /application-notes/engineering/claude-code-cli/cc-26-end-to-end-walkthrough
sidebar_position: 26
title: "端到端走一遍"
description: "沿着一次真实请求的时间线，串起 Claude Code 的启动、输入、上下文、模型调用、工具执行、持久化与恢复。"
---

> *前面的文章按模块拆解，本篇按一次真实执行重新串起来。*
>
> **Harness 层定位**：把入口、上下文、循环、工具、权限、持久化和恢复放回同一条运行时链路。

# 端到端纵剖面：一次真实请求的完整旅程

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；本文结合函数名和调用关系定位，不把容易漂移的行号作为唯一依据。
>
> **启动链**：`src/entrypoints/cli.tsx` 的 `main()`、`startCapturingEarlyInput()` → `src/main.tsx` 的 `main()`、`run()`、Commander `preAction` hook → `src/entrypoints/init.ts` 的 `init()` → `src/replLauncher.tsx` 的 `launchRepl()`。
>
> **输入与上下文链**：`src/components/PromptInput/PromptInput.tsx` 的提交回调 → `src/utils/handlePromptSubmit.ts` 的 `handlePromptSubmit()`、`executeUserInput()` → `src/utils/processUserInput/processUserInput.ts` 的 `processUserInput()` → `processTextPrompt()` → `src/utils/attachments.ts` 的 `getAttachments()`。
>
> **上下文装配链**：`src/screens/REPL.tsx` 的 `onQueryImpl()` → `src/constants/prompts.ts` 的 `getSystemPrompt()`、`src/context.ts` 的 `getUserContext()` / `getSystemContext()` → `src/utils/systemPrompt.ts` 的 `buildEffectiveSystemPrompt()`。
>
> **循环与 API 链**：`src/query.ts` 的 `query()`、`queryLoop()` → `productionDeps()` 与 `deps.callModel()` → `src/services/api/claude.ts` 的 `queryModelWithStreaming()` → `src/utils/messages.ts` 的 `handleMessageFromStream()`、`mergeAssistantMessages()`。
>
> **工具与权限链**：`src/services/tools/toolOrchestration.ts` 的 `partitionToolCalls()`、`runToolsConcurrently()` → `src/services/tools/toolExecution.ts` 的 `runToolUse()` → `src/hooks/useCanUseTool.tsx` → `src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseTool()` → 内置工具的 `checkPermissions()` 与 `mapToolResultToToolResultBlockParam()`。
>
> **落盘与恢复链**：`src/hooks/useLogMessages.ts` 的 `useLogMessages()` → `src/utils/sessionStorage.ts` 的 `recordTranscript()` / `loadTranscriptFile()`；成本由 `src/cost-tracker.ts` 的 `addToTotalSessionCost()`、`saveCurrentSessionCosts()` 管理，恢复由 `src/utils/conversationRecovery.ts` 的 `loadConversationForResume()` 协调。
>
> **一次 query 的主调用关系**：
>
> ```text
> 用户输入
>   -> executeUserInput()
>   -> processUserInput()
>   -> onQueryImpl()
>   -> query() / queryLoop()
>   -> queryModelWithStreaming()
>   -> StreamEvent / AssistantMessage
>   -> toolUseBlock?
>        -> runToolUse()
>        -> PermissionDecision
>        -> tool_result
>        -> 回到 queryLoop()
>   -> completed
>   -> useLogMessages() -> recordTranscript()
> ```

## 本篇怎么读

前面的文章分别讲启动、Agent loop、上下文、工具、权限、压缩和持久化。本篇不再按模块重复展开，而是回答一个更具体的问题：

> 用户在终端输入一句话之后，Claude Code 内部的数据究竟经过了哪些状态？

场景设定如下：

| 项 | 场景 |
|---|---|
| 启动方式 | 终端执行 `claude`，进入交互式 REPL（Read-Eval-Print Loop，读取-求值-输出循环） |
| 权限模式 | `default`，不是 bypass，也不是 `acceptEdits` |
| 用户输入 | “npm test 挂了，帮我修一下” |
| 预期动作 | Bash 复现 → Read/Grep 定位 → Edit 修复 → Bash 验证 → 输出总结 |
| 时间约定 | `S+` 表示进程启动后的时间，`R+` 表示用户按下回车后的时间；全部是量级估计，不是性能基准 |

这条链路里有三个容易混淆的对象：

1. **REPL 的消息状态**：负责屏幕显示和交互。
2. **`query()` 的循环状态**：负责一轮一轮地请求模型、执行工具并决定是否继续。
3. **Transcript**：负责把可恢复的消息链写入 JSONL（每行一个 JSON 对象）文件。

它们会互相同步，但不是同一个对象。理解这三个状态的边界，端到端流程就不会变成一堆函数名。

## 一、启动段：从进程到 REPL 首帧

### S1 裸命令先经过快速路径

用户执行 `claude` 后，操作系统启动运行时，首先进入 `src/entrypoints/cli.tsx` 的 `main()`。

这个入口不会立即加载完整 CLI，而是先检查若干特殊路径，例如：

- `--version`
- `--dump-system-prompt`
- ACP（Agent Client Protocol，Agent 客户端协议）入口
- daemon（后台进程）和 daemon worker
- Chrome、远程控制、后台任务等特殊模式

本场景没有这些参数，因此快速路径全部跳过。这样设计的目的，是让 `--version` 这类命令不必承担完整交互式 CLI 的加载成本。

此时的数据仍然很少：

```text
process.argv
  -> 裸命令参数

环境变量
  -> 运行模式、配置目录、Provider 等原始输入

UI / session / query state
  -> 尚未建立
```

### S2 捕获早期输入并加载完整 CLI

默认路径继续调用 `startCapturingEarlyInput()`。它会暂存 CLI 加载阶段写入 stdin 的内容，避免用户输入刚好落在模块加载窗口时被丢弃。

随后 `src/entrypoints/cli.tsx` 动态加载 `src/main.tsx`，把进程从“轻量入口”切换为“完整交互式 CLI”。

这里的 dynamic import（动态导入）不是装饰性写法，它把特殊命令和默认交互路径隔开了：

```text
src/entrypoints/cli.tsx
  -> 检查快速路径
  -> 裸命令未命中
  -> startCapturingEarlyInput()
  -> 动态加载 src/main.tsx
  -> main()
```

### S3 `main()`、Commander 和一次性初始化

`src/main.tsx` 的 `main()` 建立 Commander 命令树。Commander 是 CLI 命令解析框架；真正执行命令前，`preAction` hook 会等待初始化完成。

`src/entrypoints/init.ts` 的 `init()` 使用 `memoize`（记忆化，只执行一次并缓存结果）保证初始化幂等。它会装载配置、证书、代理、GrowthBook、错误上报、Langfuse、退出清理和其他运行时服务。

这一阶段的核心变化不是“调用了多少函数”，而是配置视图建立起来了：

```text
裸 argv + 原始环境变量
  -> 配置目录和 settings
  -> provider / model / permission mode
  -> telemetry / analytics / shutdown hooks
  -> 可执行的 CLI 运行时
```

### S4 setup 与 REPL 并行建立

根命令 action 会并行加载命令、agent 定义、MCP client 和会话相关状态。并行的意义是让磁盘读取、UDS（Unix Domain Socket，本地进程间通信套接字）建立和 MCP 初始化尽可能重叠。

之后 `src/replLauncher.tsx` 的 `launchRepl()` 动态加载 `App`、错误边界和 `REPL`。

SessionStart Hook 如果还没有结束，REPL 不会盲等它完成，而是先渲染输入界面，把 pending promise（尚未完成的异步结果）继续传下去。这样用户可以尽早输入，而首次 query 仍然能等待 Hook 上下文。

启动阶段可以压缩成一句话：

> 快速路径负责尽早退出，默认路径负责延迟加载；初始化建立运行时，`launchRepl()` 建立交互界面。

## 二、输入段：从回车到 `query()`

### R1 `PromptInput` 到 `executeUserInput`

用户输入“npm test 挂了，帮我修一下”并回车，`PromptInput` 的提交回调把字符串交给 `REPL`，再进入 `handlePromptSubmit()`。

`handlePromptSubmit()` 负责处理粘贴引用、slash command（斜杠命令）、退出命令和输入模式。普通文本最终进入 `executeUserInput()`。

`executeUserInput()` 第一件重要的事，是创建本 turn 的 `AbortController` 并预留 query guard。query guard 可以理解为“单飞闸门”：同一时间只允许一个用户 turn 占据主执行槽位，避免两个输入并行修改同一份消息状态。

```text
回车
  -> handlePromptSubmit()
  -> 展开粘贴引用
  -> executeUserInput()
       -> 创建 AbortController
       -> reserve query guard
       -> processUserInput()
```

### R2 用户消息、Hook 和附件

`processUserInput()` 会先判断输入模式：

- `/xxx` 进入 slash command；
- `!xxx` 进入 bash-mode；
- 普通文本进入 `processTextPrompt()`。

`processTextPrompt()` 创建 prompt ID、记录用户 prompt 相关事件，并构造 `UserMessage`。如果输入中包含 @file、IDE 选区、todo、plan 或其他上下文，`getAttachments()` 会并行生成 attachment（附件消息）。

UserPromptSubmit Hook 也在这一段执行。Hook 可以返回：

- `blockingError`：阻断本次 turn；
- `additionalContext`：向消息流追加额外上下文；
- 正常结果：继续进入 query。

因此，模型看到的第一批消息不是一个字符串，而是一个消息数组：

```text
newMessages
  = [
      UserMessage("npm test 挂了，帮我修一下"),
      AttachmentMessage(...),
      AttachmentMessage(...)
    ]
```

### R3 上下文三件套并行装配

`REPL` 的 `onQueryImpl()` 会建立 `toolUseContext`，其中包含工具表、MCP（Model Context Protocol，模型上下文协议）client、abortController、权限状态和 `getAppState()`。

接着并行获取三类上下文：

1. `getSystemPrompt()`：静态规则、工具说明、agent 说明等。
2. `getUserContext()`：CLAUDE.md、目录信息、git 状态和记忆附件等。
3. `getSystemContext()`：运行时系统信息和平台上下文。

最后由 `buildEffectiveSystemPrompt()` 合成真正发给模型的 system prompt。

这里要特别区分 `systemPrompt` 和 `userContext`：

- system prompt 进入 API 的 `system` 字段；
- user context 通常会被拼入消息流前部；
- 二者的边界会影响 prompt cache（提示词缓存）的稳定前缀。

所以，输入阶段的数据变化是：

```text
用户字符串
  -> UserMessage
  -> UserMessage + AttachmentMessage[]
  -> toolUseContext
  -> systemPrompt + userContext + systemContext
```

### R4 `query()` 接管循环

`onQueryImpl()` 使用 `for await` 消费 `query()` 生成的事件。`query()` 负责创建或复用 Langfuse trace，然后进入 `queryLoop()`。

`queryLoop()` 内部维护自己的 `State`，至少包括：

- 当前消息视图；
- 工具上下文；
- turn count；
- `needsFollowUp`；
- 工具调用和结果；
- 压缩、预算和终态信息。

REPL 的消息数组和 `queryLoop()` 的 `State.messages` 会同步，但职责不同：

> REPL 保证用户看见什么，query loop 保证下一步要做什么。

SDK、`claude -p` 和 ACP 入口可能额外经过 `QueryEngine`，用于协议转换和非 REPL 场景的持久化；交互式 REPL 主线直接消费 `query()` 生成器。

可以用下面的伪代码理解二者的分工：

```ts
for await (const event of query(params)) {
  // 先把流事件交给 REPL，保证用户看到增量输出。
  onQueryEvent(event)

  // 出现 tool_use 后，循环不能直接结束，要进入工具阶段。
  if (event.type === 'tool_use') {
    needsFollowUp = true
  }
}
```

REPL 负责消费事件，`queryLoop()` 负责根据事件决定下一步。

## 三、第一次模型调用：压缩、请求与流式回显

### R5 每轮先做上下文窗口检查

进入每一轮之前，`queryLoop()` 会先处理上一轮留下的消息视图和压缩状态。首轮通常没有可压缩内容，但检测链仍然会执行。

这一层可能包含：

- 根据最近的 compact boundary（压缩边界）裁剪消息；
- 释放上一轮的大型 tool result；
- snip / microcompact；
- context collapse；
- 重新合成 system prompt；
- `autoCompactIfNeeded()`；
- blocking limit 检查。

在 transcript 中，`snip_boundary` 是一种边界标记，用来表示历史消息在哪个位置被截断或投影。它不是普通用户消息，也不等于“遗忘”；它记录的是当前可见消息窗口如何从历史链投影出来。

模型窗口检测由 `src/utils/context.ts` 的 `getContextWindowForModel()` 提供模型对应的窗口大小，自动压缩阈值由 `src/services/compact/autoCompact.ts` 的 `getAutoCompactThreshold()` 和 `autoCompactIfNeeded()` 判断。

这一步的关键是：

> 每轮都检测，不代表每轮都压缩；只有当前消息规模触碰阈值，才会真正改变消息数组。

### R6 组装 API 请求

`queryLoop()` 通过 `deps.callModel()` 进入 `queryModelWithStreaming()`。内部消息会被规范化为 Provider 能理解的 API 请求。

本场景中，关键字段可以这样看：

| API 字段 | 来源 | 含义 |
|---|---|---|
| `messages` | 当前消息视图 + `userContext` | 用户、附件、历史 assistant、tool result |
| `system` | `fullSystemPrompt` | 静态规则与动态上下文 |
| `tools` | `toolUseContext` 中的工具定义 | 工具 schema 数组 |
| `thinking` | thinking 配置 | 是否以及如何产生 thinking block |
| `cache_control`（缓存控制标记） | system 段和消息前缀 | 标记可复用的稳定前缀 |

请求边界大致是：

```text
REPL 内部 Message[]
  -> prependUserContext()
  -> normalizeMessagesForAPI()
  -> provider-specific request
  -> queryModelWithStreaming()
```

`provider-specific` 表示“针对不同模型服务商做适配”。它不改变上层循环，只负责把统一的内部消息翻译成具体 API 格式。

### R7 SSE 事件回到 Ink UI

模型返回的 SSE（Server-Sent Events，服务器推送事件）会被 API 层转换成 `StreamEvent` 和 `AssistantMessage`。

`queryLoop()` 逐个 yield 事件，`REPL` 的 `onQueryEvent()` 交给 `handleMessageFromStream()`，再通过 `setMessages()` 触发 Ink 增量渲染。

如果同一个 assistant message 被拆成多个 content block，`mergeAssistantMessages()` 会按 ID 合并回逻辑上的一条消息。

本场景的第一次响应可能是：

```text
AssistantMessage
  ├─ thinking block
  ├─ text: "我先跑一下测试看看错误"
  └─ tool_use:
       name: Bash
       input: { command: "npm test" }
```

当出现 `tool_use` block 时，`needsFollowUp = true`。这不是“模型还没说完”，而是循环获得了继续执行工具的信号。

## 四、工具循环：权限、执行与下一轮

### R8 `partitionToolCalls()` 决定串行还是并发

流结束后，如果 `needsFollowUp` 为 true，`queryLoop()` 把工具调用交给 `src/services/tools/toolOrchestration.ts`。

`partitionToolCalls()` 会根据工具的 `isConcurrencySafe()` 分批：

- Bash、写文件、可能改变环境的工具通常进入串行批；
- Read、Grep 等只读工具可以进入并发批；
- 并发批由 `runToolsConcurrently()` 控制上限，默认值来自 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`，没有配置时使用代码默认值。

`npm test` 不是只读命令，因此本场景的第一次工具调用进入串行路径。

### R9 权限判定是第一个 HITL 节点

HITL（Human-in-the-Loop，人在环路）表示模型提出动作后，必须等待用户或权限系统确认。

`runToolUse()` 会依次经过工具查找、abort 检查、输入校验、PreToolUse Hook 和 `canUseTool`。权限主链是：

```text
runToolUse()
  -> useCanUseTool()
  -> hasPermissionsToUseTool()
  -> tool.checkPermissions()
  -> deny / allow / ask
```

在 `default` 模式下，`npm test` 常见结果是：

1. 没有匹配的 deny rule；
2. 没有预先配置的 ask rule；
3. Bash 工具检查没有命中 allow rule；
4. `passthrough` 被转换成 `ask`；
5. REPL 展示权限弹窗。

用户选择“允许并且以后不再询问”后，系统会更新 project settings，后续相同前缀的 Bash 调用可以直接放行。

### R10 执行 Bash 并回灌 `tool_result`

内置 Bash 工具位于：

`packages/builtin-tools/src/tools/BashTool/BashTool.tsx`

它的主要阶段是：

```text
工具输入
  -> checkPermissions()
  -> 执行 shell
  -> 收集 stdout / stderr
  -> mapToolResultToToolResultBlockParam()
  -> tool_result
  -> 回到 queryLoop()
```

输出限制由 `src/utils/shell/outputLimits.ts` 控制。默认最大输出约为 30,000 字符，上限可以通过 `BASH_MAX_OUTPUT_LENGTH` 调整；过大的完整输出可以持久化到文件，tool result 只携带摘要和路径。

下一轮状态不是简单追加一条文本，而是按工具 ID 严格配对：

```text
assistant.tool_use.id
  == tool_result.tool_use_id  # 工具调用 ID 必须严格配对

state.messages
  = messagesForQuery
  + assistantMessages
  + toolResults
  + attachments
```

### R11 Read/Grep 进入并发批

第二次请求带着测试错误返回多个只读工具调用，例如：

```text
Read(test/foo.test.ts)
Read(src/foo.ts)
Grep("expected", "src/")
```

这些工具的 `isConcurrencySafe()` 返回 true，因此由 `runToolsConcurrently()` 并发执行。每个结果仍然独立校验、独立截断，最后按照原始 `tool_use` 顺序回灌。

Read 还会更新 `readFileState`。这是 Edit 工具的先读后写条件：文件在被修改前必须已经被当前会话读取，且没有被外部进程悄悄改动。

### R12 Edit 改变权限模式和文件状态

内置 Edit 工具位于：

`packages/builtin-tools/src/tools/FileEditTool/FileEditTool.ts`

它会检查：

- `old_string` 与 `new_string` 是否有效；
- 文件是否已读且仍然新鲜；
- 路径是否命中 deny 目录；
- 当前权限模式是否允许写入。

在 `default` 模式下，工作目录内的写操作通常返回 `ask`，并可能建议切换到 `acceptEdits`。用户确认后，权限上下文变为：

```text
default
  -> ask
  -> 用户确认
  -> acceptEdits
  -> 当前会话内的工作目录编辑自动放行
```

Edit 完成后会产生文件变更 attachment。下一次请求可以通过附件或上下文增量看到最新文件状态。

### R13 验证、收敛与 completed

最后一次 Bash 执行 `npm test`。如果没有新的 `tool_use`，`needsFollowUp` 为 false，`queryLoop()` 进入收敛分支：

1. 检查被暂扣的错误恢复路径；
2. 执行 Stop Hook；
3. 返回 `completed`；
4. `query()` 的 finally 结束 trace、清理资源；
5. REPL 重置 loading 状态并释放 query guard。

终态不是“模型自然停下”，而是循环明确返回了一个终止原因：

```text
tool_result: npm test passed
  -> model returns final text
  -> no tool_use
  -> needsFollowUp = false
  -> Stop hooks
  -> { reason: "completed" }
```

## 五、全程暗线：Transcript、Prompt Cache 与压缩

### D1 Transcript 是流式渲染的增量副作用

交互式 REPL 的持久化不是在 `queryLoop()` 结束时一次性完成，而是由 `useLogMessages()` 监听消息数组变化。最终写入的是 JSONL（每行一个 JSON 对象）文件。

`useLogMessages()` 通常只把新增尾部交给 `recordTranscript()`。后者按 UUID 去重，并把消息追加到项目对应的 JSONL 文件。

```text
setMessages(nextMessages)
  -> useLogMessages()
  -> 取新增尾部
  -> recordTranscript()
  -> JSONL append
```

因此，Transcript 的写入粒度更接近“每次 UI 状态更新”，不是“每个 turn 一行”。如果进程在最后一次写入前被强制终止，最多丢失尚未落盘的尾部状态；已经写入的历史不会因为模型继续生成而被覆盖。

### D2 Prompt Cache 依赖稳定前缀

一次多轮任务会反复发送：

```text
system prompt
  + tools schema
  + 历史消息
  + 新增消息
```

Claude Code 会在稳定位置设置 `cache_control`（缓存控制标记），让前面的 system prompt、工具 schema 和旧消息尽量复用。

这解释了几个看似保守的实现：

- 不随意重排历史消息；
- 不能把已有消息原地改写成不同字节；
- thinking block 的保留要尽量稳定；
- 消息回流时可能使用克隆，避免破坏原始缓存前缀。

缓存命中不是独立的“优化开关”，而是循环、消息合并和压缩策略共同维护的结果。

### D3 模型窗口检测与 `snip_boundary`

每一轮都会调用上下文窗口相关逻辑，即使本场景远未达到阈值。`getContextWindowForModel()` 先确定模型可用窗口，`getAutoCompactThreshold()` 再减去预留 buffer，`autoCompactIfNeeded()` 判断当前消息是否需要压缩。

达到阈值时，消息不会被随意删除，而是通过 compact、microcompact、snip 等机制生成新的可见投影。`snip_boundary` 记录历史投影的边界，帮助 `loadTranscriptFile()` 在恢复时知道：

- 哪些消息属于压缩前历史；
- 哪些消息是摘要或保留尾部；
- 当前有效 leaf（链末端消息）从哪里开始。

所以“记忆被遗忘”并不准确。更准确的说法是：旧消息可能不再进入当前模型窗口，但仍可能以 Transcript、摘要或边界元数据的形式保留。

## 六、收尾：成本与 resume

### E1 成本在 response 到达时记账

成本不是进程退出时才计算。每个 API response 的 usage 到达后，`addToTotalSessionCost()` 就会累加 token、模型和金额。

退出阶段由 `saveCurrentSessionCosts()` 保存 session 级成本、时长和相关统计。`src/costHook.ts` 只是把 React 生命周期与退出保存连接起来，不负责重新计算每一次 API 成本。

```text
API response
  -> usage
  -> addToTotalSessionCost()
  -> 内存累计
  -> saveCurrentSessionCosts()
  -> 配置中的 session cost state
```

### E2 `--resume` 依赖多份凭据

恢复一个会话，不是只读取一个 session ID。主要凭据链是：

```text
getSessionId()
  -> projects/<project-key>/<sessionId>.jsonl
  -> loadConversationForResume()
  -> loadTranscriptFile()
  -> 重建消息链和 parentUuid
  -> 恢复 agent / 文件历史 / 成本状态
  -> launchRepl()
```

Transcript 恢复的是消息链和可持久化状态，不会恢复当前进程的 MCP 连接、Hook 注册、AbortController 或未完成的流。这里的 `UUID`（通用唯一标识符）只负责识别消息，不等于可以恢复原来的运行时对象。

这也是为什么 resume 后看起来像“回到了原来的对话”，但运行时仍然是一个新启动的 CLI 进程。

## 七、旁路清单：同一条链路上的其他分支

本场景没有触发的分支，不代表它们不重要。可以按时间点记住这些旁路：

| 时刻 | 旁路 | 触发条件 | 主要源码 |
|---|---|---|---|
| S1 | 快速路径 | `--version`、daemon、ACP、远程控制等 | `src/entrypoints/cli.tsx` 的 `main()` |
| S4 | onboarding / trust gate | 首次进入目录或未完成信任设置 | `src/main.tsx` 的 setup 流程 |
| R2 | slash command / bash-mode | 输入以 `/` 或 `!` 开头 | `processUserInput()` |
| R4 | QueryEngine 包装层 | SDK、`claude -p`、ACP | `src/QueryEngine.ts` |
| R6 | 非流式 fallback（回退）/ 重试 | 流建立失败、限流或 Provider 错误 | `src/services/api/claude.ts` |
| R8 | auto 权限分类 | 使用 auto 权限模式 | `src/utils/permissions/permissions.ts` |
| R8 | sandbox（沙箱）自动放行 | 命令满足沙箱约束 | Bash 工具权限检查与 sandbox 模块 |
| R10 | 子 agent 委派 | 模型选择 Agent 工具 | [17 子 agent 隔离](../04-multi-agent-collaboration/cc-17-subagent-isolation.md) |
| R13 | Stop Hook 继续运行 | Stop Hook 返回继续信号 | `src/query/stopHooks.ts` |
| D3 | 自动压缩 | 消息接近模型窗口阈值 | `src/services/compact/autoCompact.ts` |

## 八、把整条链路压缩成一张图

```text
进程启动
  -> 快速路径检查
  -> init()
  -> setup / MCP / hooks
  -> launchRepl()

用户输入
  -> handlePromptSubmit()
  -> executeUserInput()
  -> processUserInput()
  -> UserMessage + attachments

上下文装配
  -> systemPrompt
  -> userContext
  -> systemContext
  -> effective prompt

Agent loop
  -> 检查模型窗口和压缩边界
  -> callModel()
  -> 流式 AssistantMessage
  -> tool_use?
       -> 权限
       -> 工具
       -> tool_result
       -> 下一轮
  -> completed

全程暗线
  -> useLogMessages()
  -> recordTranscript()
  -> 成本累计
  -> graceful shutdown / resume
```

端到端理解的关键，不是记住每个文件的调用顺序，而是抓住四次数据形态变化：

1. **字符串 → 消息数组**：输入经过 Hook 和附件装配。
2. **消息数组 → API 请求**：上下文、工具和 cache 标记被组装。
3. **API 响应 → 循环状态**：流式 block 决定是否进入工具轮。
4. **循环状态 → 可恢复文件**：消息、边界、成本和文件历史被分别持久化。

一旦这四次变化串起来，Claude Code 就不再像一个“输入一句话、神秘返回结果”的黑盒，而是一条由入口、上下文、循环、工具、权限和持久化共同组成的运行时流水线。
