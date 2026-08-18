---
slug: /application-notes/engineering/claude-code-cli/cc-05-streaming-and-rendering
sidebar_position: 5
title: "流式输出与渲染"
description: "从模型响应事件、内容块归并到流式工具执行，理解 Claude Code 如何把一条流式请求接回 Agent 主循环。"
---

# 流式输出与渲染

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd`。本文使用相对路径、方法名和关键代码片段定位，不使用行号。
>
> **核心路径**：
>
> 1. **模型调用入口**：`src/query/deps.ts` 的 `QueryDeps`、`productionDeps()`，以及 `src/query.ts` 的 `queryLoop()`。先确认主循环怎样取得和消费模型调用函数。
> 2. **消息类型与模型流归并**：`packages/@ant/model-provider/src/types/message.ts` 定义基础 `StreamEvent`；`src/types/message.ts` 重新导出该类型；`src/services/api/claude.ts` 的 `queryModel()` 使用 Anthropic SDK 的 `Stream<BetaRawMessageStreamEvent>` 读取原始事件，并在流式循环的 `switch (part.type)` 后构造具体事件对象、归并内容块。
> 3. **第三方模型适配**：`src/services/api/openai/index.ts` 的 `queryModelOpenAI()`、`adaptOpenAIStreamToAnthropic()`。OpenAI 兼容接口先经过适配，再进入同一条消费链。
> 4. **流式工具执行**：`src/services/tools/StreamingToolExecutor.ts` 的 `TrackedTool`、`addTool()`、`processQueue()`、`getCompletedResults()` 和 `getRemainingResults()`。
> 5. **降级与释放**：`src/services/api/claude.ts` 的 `executeNonStreamingRequest()`、`releaseStreamResources()`，以及 `src/query.ts` 中调用 `StreamingToolExecutor.discard()` 的重试分支。

本文关注后端运行时。`src/utils/messages.ts`、`src/components/Messages.tsx` 和 `src/cli/print.ts` 消费内部消息并显示到界面或终端，它们不决定模型流、工具执行和下一轮请求。

## 先建立全链路

流式调用的重点不在“字符逐个显示”。后端要同时完成三件事：

1. 接收不同模型服务商的原始响应；
2. 把分片事件归并成可进入对话历史的稳定消息；
3. 在工具调用参数完整后尽早执行工具，把结果送回下一轮模型请求。

整条链路如下：

```text
queryLoop()
  -> deps.callModel()
  -> queryModelWithStreaming()
  -> Provider 原始事件
  -> 适配为统一事件
  -> claude.ts 归并内容块
  -> stream_event / AssistantMessage
  -> queryLoop() 识别 tool_use
  -> StreamingToolExecutor 执行工具
  -> tool_result 加入下一轮请求
```

`stream_event` 用于描述正在发生的增量过程；`AssistantMessage` 表示一个已经完整的内容块；`tool_result` 是工具执行后的观察结果。三种对象分工明确，不能混为一类消息。

假设用户要求“读取 `README.md` 后总结”，一次请求会按下面的顺序推进：

```text
1. queryLoop() 组装 messages、systemPrompt 和工具定义
2. deps.callModel() 建立模型流
3. 模型发送 tool_use 内容块的名称和参数增量
4. claude.ts 收齐该内容块，产出 AssistantMessage
5. queryLoop() 识别出 tool_use，交给 StreamingToolExecutor
6. Read 工具执行；模型流仍可继续接收后续事件
7. 已完成的 tool_result 提前交付，或在模型流结束后统一收尾
8. assistant 消息和 tool_result 一起加入下一轮模型请求
```

第 4 步和第 7 步是流式执行的两个边界：**内容块完整才能启动工具；工具结果完整才能加入下一轮。**

## 一、模型调用接口：主循环只依赖统一消息流

### 1.1 `deps.callModel()` 是模型调用的注入点

`queryLoop()` 不直接导入模型 SDK。它通过 `QueryDeps.callModel` 取得一个模型调用函数：

```typescript
// src/query/deps.ts
export type QueryDeps = {
  // 复用真实流式函数的参数和返回类型
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

主循环默认使用生产实现，也允许调用方传入测试实现：

```typescript
// src/query.ts，queryLoop()
const deps = params.deps ?? productionDeps()

for await (const message of deps.callModel(modelParams)) {
  // message 是统一的内部消息
  consume(message)
}
```

这属于手动依赖注入（Dependency Injection，DI）。`queryLoop()` 使用模型调用能力，生产代码或测试代码负责提供具体函数。

这里也有控制反转（Inversion of Control，IoC）的效果：循环不创建模型客户端，不选择 Provider。项目没有 IoC 容器，依赖数量很少，`QueryDeps` 对象已经能清楚表达装配关系。

### 1.2 流式与非流式，最终都要产出内部消息

`queryModelWithStreaming()` 返回异步生成器（`AsyncGenerator`）。调用方用 `for await` 逐条消费。

```typescript
// src/services/api/claude.ts
export async function* queryModelWithStreaming(params) {
  return yield* withStreamingVCR(params.messages, async function* () {
    yield* queryModel(
      params.messages,
      params.systemPrompt,
      params.thinkingConfig,
      params.tools,
      params.signal,
      params.options,
    )
  })
}
```

`queryModelWithoutStreaming()` 则等待完整响应，并返回一个 `Promise<AssistantMessage>`。它仍会消费 `queryModel()`，因此日志、统计和错误处理保持同一条实现路径。

| 方式 | HTTP 响应形态 | 调用方看到的结果 | 适用位置 |
| --- | --- | --- | --- |
| 流式 | 事件分片持续到达 | `AsyncGenerator` 逐条产出 | 交互式主循环、增量状态、提前启动工具 |
| 非流式 | 完整响应到达后返回 | `Promise<AssistantMessage>` | 无需实时过程的调用，或流式请求的降级恢复 |

流式失败后，`queryModel()` 可以通过 `executeNonStreamingRequest()` 改用完整响应请求。这个降级只改变传输方式，`queryLoop()` 继续消费同一类内部消息。

非流式入口会把生成器消费到结束，再返回最终消息：

```typescript
// src/services/api/claude.ts，queryModelWithoutStreaming() 的核心流程
let assistantMessage: AssistantMessage | undefined

for await (const message of queryModel(/* 请求参数 */)) {
  if (message.type === 'assistant') {
    // 保存最后得到的稳定 assistant 消息
    assistantMessage = message
  }
}

if (!assistantMessage) {
  throw new Error('No assistant message found')
}
return assistantMessage
```

因此，流式与非流式的差异集中在“消息何时交给调用方”。事件归并、内容规范化和 API 调用统计仍由模型服务层统一处理。

### 1.3 不同 Provider 的原始事件不能直接混用

`message_start`、`content_block_delta`、`message_stop` 是 Anthropic 路径使用的事件名称。OpenAI、Gemini、Grok 等 Provider 的原始字段和事件边界可以不同。

Claude Code 的做法是：每个 Provider 在适配层转换，自上而下只保留一条内部消费链。

```text
Anthropic 原始 SSE
  -> claude.ts 的流式循环

OpenAI 原始 chunk
  -> adaptOpenAIStreamToAnthropic()
  -> claude.ts 能理解的事件

其他 Provider 原始响应
  -> 对应适配器
  -> 同一类内部消息
```

OpenAI 路径的入口在 `src/services/api/openai/index.ts`：

```typescript
// src/services/api/openai/index.ts，按实际逻辑裁剪
const adaptedStream = adaptOpenAIStreamToAnthropic(
  await getOpenAIClient(/* 连接配置 */).chat.completions.create(
    buildOpenAIRequestBody(/* 消息、工具和模型配置 */),
    { signal },
  ),
  openaiModel,
)

// 此处开始按 Anthropic 风格事件归并内容块
for await (const event of adaptedStream) {
  switch (event.type) {
    case 'message_start':
    case 'content_block_start':
    case 'content_block_delta':
    case 'content_block_stop':
      // 更新内容块，并按需要产出内部消息
      break
  }
}
```

因此，文章中的 `content_block_*` 结构用来解释 Claude Code 的统一事件层，不应当当作所有模型服务商的原始协议。

### 1.4 `await`、`yield` 和 `yield*` 的分工

三个关键字分别承担等待、交付和转发：

```typescript
// await：等待 Promise 完成
const result = await createRequest()

// yield：从异步生成器交付一条消息
yield { type: 'stream_event', event }

// yield*：把另一个生成器的全部产出继续转发
yield* queryModel(/* ... */)
```

`await` 等待一个异步结果；`yield` 交付一条消息后暂停生成器；`yield*` 把内层生成器产出的每一条消息原样传给外层调用方。

## 二、事件归并：从原始事件到稳定消息

这一节只回答四个问题：

1. `stream`、`part` 和 `stream_event` 分别是什么；
2. `part.index` 怎样定位一个内容块；
3. 文本、工具参数和思考内容怎样完成；
4. 最终用量和停止原因为什么要回写。

### 2.1 流中读到的是 `part`，向上交付的是 `stream_event`

`queryModel()` 在 Anthropic 直连路径中读取 `Stream<BetaRawMessageStreamEvent>`。

`BetaRawMessageStreamEvent` 来自 Anthropic SDK，表示一条原始流式事件。`part` 就是当前读到的这条事件，常见的 `part.type` 包括：

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

`StreamEvent` 的基础类型定义在 `packages/@ant/model-provider/src/types/message.ts`，`src/types/message.ts` 只重新导出它。该基础类型保持开放，具体字段由模型服务层构造。

`queryModel()` 的流式循环按下面顺序执行：

```typescript
// src/services/api/claude.ts，queryModel() 的流式循环
let stream: Stream<BetaRawMessageStreamEvent> | undefined

for await (const part of stream) {
  // 先按 part.type 更新本次请求的局部状态
  switch (part.type) {
    // message_start、content_block_*、message_delta、message_stop
  }

  // 再把当前原始事件包装为内部消息，交给 queryLoop() 和下游消费者
  yield {
    type: 'stream_event',
    event: part,
    ...(part.type === 'message_start' ? { ttftMs } : undefined),
  }
}
```

这段 `yield` 位于 `queryModel()` 的 `for await (const part of stream)` 循环中，紧跟事件分支处理之后。

`ttftMs` 是首 token 延迟，只在 `message_start` 上附带。它记录请求开始到收到首个模型事件的耗时。

对象关系如下：

```text
Anthropic SDK
  -> Stream<BetaRawMessageStreamEvent>
  -> part
  -> claude.ts 归并状态
  -> { type: 'stream_event', event: part, ttftMs? }
  -> queryLoop() / SDK / 界面
```

OpenAI 路径先在 `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` 将 `ChatCompletionChunk` 转成 `BetaRawMessageStreamEvent`，再由 `queryModelOpenAI()` 的同构事件循环归并。因此，原始网络响应的字段可以不同，进入 Agent 运行时后的事件形状保持一致。

### 2.2 `part.index` 把开始、增量和结束事件连到同一个内容块

一条模型响应可以包含思考、文本和工具调用多个内容块：

```text
assistant.content[0] = thinking
assistant.content[1] = text
assistant.content[2] = tool_use
```

`content_block_start`、`content_block_delta` 和 `content_block_stop` 都携带 `part.index`。这个下标指向完整响应中的内容块位置，从 `0` 开始；它不表示网络事件的序号。

代码用 `contentBlocks[part.index]` 保存当前内容块。下面保留 `tool_use`、`text` 和 `thinking` 三类核心分支，省略 `server_tool_use`、`connector_text`、日志与遥测代码：

```typescript
// src/services/api/claude.ts，content_block_start 分支
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      // 工具参数后续通过 input_json_delta 逐段写入
      contentBlocks[part.index] = {
        ...part.content_block,
        input: '',
      }
      break

    case 'text':
      // 文本片段存入 textDeltas，结束时一次 join
      textDeltas.set(part.index, [])
      contentBlocks[part.index] = {
        ...part.content_block,
        text: '',
      }
      break

    case 'thinking':
      // 思考正文和签名独立累积
      contentBlocks[part.index] = {
        ...part.content_block,
        thinking: '',
        signature: '',
      }
      break
  }
  break
```

开始事件只负责创建容器，正文和参数都由后续增量事件写入。文本块初始化为 `''`，避免部分 SDK 同时在开始事件和增量事件中携带文本时产生重复。

```typescript
// src/services/api/claude.ts，content_block_delta 分支的核心逻辑
case 'content_block_delta': {
  const contentBlock = contentBlocks[part.index]
  if (!contentBlock) throw new RangeError('Content block not found')

  switch (part.delta.type) {
    case 'input_json_delta':
      if (contentBlock.type !== 'tool_use') {
        throw new Error('Content block is not a tool_use block')
      }
      if (typeof contentBlock.input !== 'string') {
        throw new Error('Content block input is not a string')
      }
      // 工具参数会以 JSON 文本分片到达
      contentBlock.input += part.delta.partial_json
      break

    case 'text_delta':
      if (contentBlock.type !== 'text') {
        throw new Error('Content block is not a text block')
      }
      textDeltas.get(part.index)?.push(part.delta.text)
      break

    case 'thinking_delta':
      if (contentBlock.type !== 'thinking') {
        throw new Error('Content block is not a thinking block')
      }
      contentBlock.thinking += part.delta.thinking
      break

    case 'signature_delta':
      if (contentBlock.type !== 'thinking') {
        throw new Error('Content block is not a thinking block')
      }
      contentBlock.signature = part.delta.signature
      break
  }
  break
}
```

这段代码有两个硬约束：

1. 增量事件必须找到前面的 `contentBlocks[part.index]`，否则事件顺序或内容块下标异常；
2. `input_json_delta` 只能写进 `tool_use` 块，工具参数完整前始终保持 JSON 字符串。

因此，工具参数要等 `content_block_stop` 到达后才完整。执行器不会接收到半截 JSON。

### 2.3 内容块在结束事件到达后变成 `AssistantMessage`

请求内会维护几项局部状态：

```typescript
const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
const textDeltas = new Map<number, string[]>()
const newMessages: AssistantMessage[] = []
let partialMessage: BetaMessage | undefined
let usage: NonNullableUsage = EMPTY_USAGE
let stopReason: BetaStopReason | null = null
```

它们的分工如下：

| 事件 | 状态变化 | 结果 |
| --- | --- | --- |
| `message_start` | 保存 `partialMessage`、初始用量和首 token 延迟 | 暂不产出稳定消息 |
| `content_block_start` | 在 `contentBlocks[index]` 创建文本、思考或工具调用块 | 暂不产出稳定消息 |
| `content_block_delta` | 累积文本、思考正文、签名或工具参数 | 暂不产出稳定消息 |
| `content_block_stop` | 完成当前内容块 | 产出一条 `AssistantMessage` |
| `message_delta` | 更新最终用量和停止原因 | 回写已产出的消息 |
| `message_stop` | 整条模型响应结束 | 结束本轮事件流 |

文本、工具调用和思考内容的累积方式不同：

| 内容块 | 增量字段 | 累积方式 |
| --- | --- | --- |
| 文本 | `text_delta` | 先放进 `textDeltas[index]`，结束时一次 `join('')` |
| 工具调用 | `input_json_delta` | 追加 JSON 字符串，结束时通过 `normalizeContentFromAPI()` 解析 |
| 思考内容 | `thinking_delta`、`signature_delta` | 正文和签名写入同一个思考内容块 |

文本在开始事件中初始化为空字符串。源码这样处理，是为了避开部分 SDK 同时在开始事件和增量事件中携带同一段文本时造成的重复。

内容块结束时，代码合并文本分片并创建稳定消息：

```typescript
// src/services/api/claude.ts，content_block_stop 分支
const contentBlock = contentBlocks[part.index]
const deltas = textDeltas.get(part.index)

if (deltas) {
  ;(contentBlock as { text: string }).text = deltas.join('')
  textDeltas.delete(part.index)
}

const message: AssistantMessage = {
  message: {
    ...partialMessage,
    usage: partialMessage.usage ?? { ...EMPTY_USAGE },
    content: normalizeContentFromAPI(
      [contentBlock] as BetaContentBlock[],
      tools,
      options.agentId,
    ) as MessageContent,
  },
  type: 'assistant',
  uuid: randomUUID(),
  timestamp: new Date().toISOString(),
}

newMessages.push(message)
yield message
```

`content_block_stop` 表示当前块可用，`message_stop` 表示整条模型响应可用。工具执行可以从前一个时点开始，不需要等待后一个时点。

### 2.4 `message_delta` 补齐最终字段

`AssistantMessage` 在 `content_block_stop` 时已经交付。此时的 `usage` 和 `stop_reason` 还可能是初始值；最终值在随后的 `message_delta` 到达。

```typescript
// src/services/api/claude.ts，message_delta 分支
usage = updateUsage(usage, part.usage)
stopReason = part.delta.stop_reason

const lastMsg = newMessages.at(-1)
if (lastMsg) {
  // transcript 写队列持有这个对象引用
  lastMsg.message.usage = usage
  lastMsg.message.stop_reason = stopReason
}
```

这里直接修改已交付对象。会话记录写队列延迟序列化，替换整个对象会让它继续持有旧引用，最终记录到的用量和停止原因可能过期。

## 三、主循环怎样消费模型流并启动工具

### 3.1 消费模型消息时，同时收割已完成工具

`queryLoop()` 用 `for await` 消费 `deps.callModel()`。收到 `stream_event` 时，它可以立刻向更上层转发；收到 `AssistantMessage` 时，它检查其中的 `tool_use` 内容块。

```typescript
// src/query.ts，按主流程裁剪
for await (const message of deps.callModel(modelParams)) {
  yield message

  if (message.type === 'assistant') {
    const toolBlocks = (
      Array.isArray(message.message?.content)
        ? message.message.content
        : []
    ).filter(content => content.type === 'tool_use') as ToolUseBlock[]

    for (const toolBlock of toolBlocks) {
      // 工具参数已完整，可以开始排队执行
      streamingToolExecutor?.addTool(toolBlock, message)
    }
  }

  // 模型仍在继续输出时，已完成的工具结果可以提前交付
  for (const result of streamingToolExecutor?.getCompletedResults() ?? []) {
    if (result.message) {
      yield result.message
      toolResults.push(...normalizeMessagesForAPI([result.message]))
    }
  }
}
```

真实循环还会判断当前消息能否直接向上层交付。提示词超长、输出截断、媒体过大等可恢复错误会先留在内部数组；压缩或重试成功后，调用方不必看到一次中间失败。

```text
模型消息
  -> 可恢复错误：暂存，先尝试压缩或重试
  -> 普通 stream_event：立即向上层 yield
  -> AssistantMessage：加入 assistantMessages，并提取 tool_use
```

这就是“流式工具执行”的准确含义：**某个 `tool_use` 内容块完整后就开始执行，不等待整条模型响应结束。**

本轮模型流结束后，`queryLoop()` 再调用 `getRemainingResults()`，等待尚未完成的工具，并把全部 `tool_result` 加入下一轮请求。

### 3.2 `StreamingToolExecutor` 的对象结构

`StreamingToolExecutor` 是当前一轮响应的工具队列协调器。它不处理模型协议，也不判断 Agent 是否继续；职责是管理工具生命周期、并发关系和结果交付顺序。

```typescript
// src/services/tools/StreamingToolExecutor.ts
type ToolStatus = 'queued' | 'executing' | 'completed' | 'yielded'

type TrackedTool = {
  id: string
  block: ToolUseBlock                 // 已完整的 tool_use 内容块
  assistantMessage: AssistantMessage  // 产生该调用的消息
  status: ToolStatus
  isConcurrencySafe: boolean          // 是否允许并发执行
  promise?: Promise<void>             // 实际工具执行任务
  results?: Message[]                 // 完成后等待交付的结果
  pendingProgress: Message[]          // 执行中即可交付的进度消息
}

class StreamingToolExecutor {
  private tools: TrackedTool[] = []
  private toolUseContext: ToolUseContext
  private siblingAbortController: AbortController
  private discarded = false
}
```

状态流转固定：

```text
queued -> executing -> completed -> yielded
```

`completed` 表示工具结果已保存，但还没交给 `queryLoop()`；`yielded` 表示结果已交付，执行器不会重复产出。

`ToolUseContext` 是工具执行的运行时上下文类型，包含取消信号、权限处理所需状态、正在执行的工具标记和追踪信息。`siblingAbortController` 从它的取消信号派生，用来在需要时停止同一批中的其他工具。

工具执行时，每个工具还会从 `siblingAbortController` 派生独立的 `toolAbortController`。权限拒绝、用户中断或同批 Bash 工具错误都能沿这条取消链传递到正在执行的工具。

### 3.3 入队、并发和结果顺序

`addTool()` 先找到工具定义，再校验参数并计算该调用是否并发安全：

```typescript
// src/services/tools/StreamingToolExecutor.ts，addTool()
const toolDefinition = findToolByName(this.toolDefinitions, block.name)
if (!toolDefinition) {
  // 源码在队列中写入一个 completed 的错误 tool_result
  return
}

const parsedInput = toolDefinition.inputSchema.safeParse(block.input)

const isConcurrencySafe = parsedInput.success
  ? Boolean(toolDefinition.isConcurrencySafe(parsedInput.data))
  : false

this.tools.push({
  id: block.id,
  block,
  assistantMessage,
  status: 'queued',
  isConcurrencySafe,
  pendingProgress: [],
})

void this.processQueue()
```

参数不合法时按“不可并发”处理，避免错误输入打乱执行顺序。

`processQueue()` 的关键判断是 `canExecuteTool()`：

```typescript
// src/services/tools/StreamingToolExecutor.ts，按逻辑裁剪
if (this.canExecuteTool(tool.isConcurrencySafe)) {
  // 启动执行任务；执行结果通过 tool.promise 回收
  await this.executeTool(tool)
} else if (!tool.isConcurrencySafe) {
  // 有顺序要求的工具不能越过前面尚未完成的工作
  break
}
```

效果如下：

```text
Read(a)   并发安全  ─┐
Read(b)   并发安全  ─┼─ 可同时运行
Write(c)  非并发    ─┘  等前面的工作完成后再运行
```

两个取结果方法解决不同阶段的问题：

| 方法 | 是否等待 | 作用 |
| --- | --- | --- |
| `getCompletedResults()` | 否 | 模型流还没结束时，拿走已完成的结果和进度消息 |
| `getRemainingResults()` | 是 | 本轮模型流结束后，等待全部工具收尾 |

结果按 `tools` 队列顺序交付。并发只缩短执行时间，不改变模型看到 `tool_result` 的顺序。

`getCompletedResults()` 会区分进度消息和最终结果：

```typescript
// src/services/tools/StreamingToolExecutor.ts，按核心逻辑裁剪
for (const tool of this.tools) {
  // progress 不需要等待工具结束，可立即交付
  while (tool.pendingProgress.length > 0) {
    yield { message: tool.pendingProgress.shift()! }
  }

  if (tool.status === 'completed' && tool.results) {
    tool.status = 'yielded'

    // 最终结果按队列顺序交付，随后标记工具已完成
    for (const message of tool.results) {
      yield { message }
    }
    markToolUseAsComplete(this.toolUseContext, tool.id)
  } else if (tool.status === 'executing' && !tool.isConcurrencySafe) {
    // 遇到顺序工具仍在执行，后面的结果不能越过它
    break
  }
}
```

工具调用中产生的进度消息可以在模型流尚未结束时显示；最终 `tool_result` 仍遵守工具调用顺序。这同时满足实时反馈和消息历史可重放两个要求。

## 四、失败、中断和资源释放

### 4.1 看门狗区分“记录停顿”和“主动中止”

流式循环会记录相邻事件之间的间隔，用于分析服务端或网络是否发生停顿。它只能在下一条事件到来后计算前一个间隔。

空闲看门狗（watchdog，超时保护定时器）处理另一种情况：长时间始终没有新事件。超时后它调用 `releaseStreamResources()` 主动结束底层流。

```text
停顿统计
  -> 下一条事件到来
  -> 记录之前停了多久

空闲看门狗
  -> 长时间没有下一条事件
  -> 取消流和 HTTP 响应资源
```

流因为空闲看门狗或其他可恢复故障结束时，`queryModel()` 会进入 `executeNonStreamingRequest()`：

```text
流式请求
  -> 空流、连接失败或空闲中止
  -> executeNonStreamingRequest()
  -> 得到完整 BetaMessage
  -> normalizeContentFromAPI()
  -> yield AssistantMessage
```

主循环始终看到内部消息，不需要再为非流式结果编写第二套消费协议。

### 4.2 流式降级时必须丢弃旧执行器

流式请求可能因为空流、连接异常或空闲看门狗中止而改走 `executeNonStreamingRequest()`。如果第一次尝试已经启动工具，旧工具结果不能流入重试后的对话。

`queryLoop()` 在创建新执行器前调用 `discard()`：

```typescript
// src/query.ts，流式失败后的重试分支
if (streamingToolExecutor) {
  // 中止旧工具，清空旧结果与进度
  streamingToolExecutor.discard()

  // 为重试响应创建新的工具队列
  streamingToolExecutor = new StreamingToolExecutor(
    toolUseContext.options.tools,
    canUseTool,
    toolUseContext,
  )
}
```

原因是重试响应会产生新的 `tool_use_id`。旧执行器继续交付结果，会让消息历史混入没有匹配调用的 `tool_result`，下一轮请求将失去协议完整性。

### 4.3 用户中断时仍要补齐工具结果

模型已经输出 `tool_use` 后，用户可能中断执行。消息历史中每个 `tool_use` 都需要对应的 `tool_result`。

有流式执行器时，主循环继续消费 `getRemainingResults()`。执行器会为排队中或执行中的工具生成合成结果：

```typescript
// src/query.ts，中断处理分支
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) yield update.message
    }
  } else {
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Interrupted by user',
    )
  }

  return { reason: 'aborted_streaming' }
}
```

中断优先结束当前轮次，同时保留可发送给 API 的合法消息序列。

### 4.4 `finally` 释放底层流资源

HTTP 响应持有 socket、TLS 缓冲区等底层资源。流式生成器可以正常结束、抛出异常，也可以被调用方提前停止；清理必须覆盖所有出口。

```typescript
// src/services/api/claude.ts
function releaseStreamResources(): void {
  cleanupStream(stream)
  stream = undefined

  if (streamResponse) {
    streamResponse.body?.cancel().catch(() => {})
    streamResponse = undefined
  }
}

try {
  for await (const part of stream) {
    // 读取并归并事件
  }
} finally {
  // for await 提前结束时同样会执行
  releaseStreamResources()
}
```

空闲看门狗也会调用 `releaseStreamResources()`，主动终止长时间没有新事件的响应。停顿统计负责记录两个事件之间的间隔；看门狗负责处理“下一个事件始终没有到来”的情况。

## 五、读源码时应抓住的判断点

1. **模型请求从哪里进入主循环**：`queryLoop()` 调用 `deps.callModel()`；生产环境的实现来自 `productionDeps()`。
2. **不同模型协议在哪里被消化**：Provider 适配器负责转换，`queryLoop()` 只消费统一内部消息。
3. **事件怎样对应到内容块**：看 `part.index` 和 `contentBlocks[part.index]`。
4. **工具为什么可以提前执行**：`content_block_stop` 产出完整 `AssistantMessage`，随后 `addTool()` 立即入队。
5. **工具结果怎样回到下一轮**：`getCompletedResults()` 提前收割，`getRemainingResults()` 负责收尾，二者的结果都会写入 `toolResults`。
6. **为什么重试和中断仍然复杂**：要避免旧尝试的结果泄漏，并保持每个 `tool_use` 与 `tool_result` 配对。
7. **为什么清理放在 `finally`**：生成器会被提前停止，普通顺序代码无法覆盖所有退出路径。

如果只记住一条主线：

```text
Provider 事件
  -> 内容块归并
  -> AssistantMessage
  -> tool_use 入队执行
  -> tool_result 回灌
  -> 下一轮模型请求
```

上一篇 [04 Agent 主循环](cc-04-agent-loop.md) 解释轮次状态机和继续条件。本篇解释其中一次模型调用如何产生消息和工具结果。工具权限、钩子和具体工具执行细节见 [10 工具执行管线](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)。
