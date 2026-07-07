# 流式输出与渲染

> **本章目标**：理解 Claude Code 流式输出的完整机制——LLM 逐 token 输出和用户等不了之间的矛盾如何被解决，5 层链路如何用 AsyncGenerator 串起来而不需要事件总线，状态机如何在 SSE 字节流和 React 渲染之间架起桥梁，Idle Stall 如何被双层 Watchdog 检测和兜底。
>
> **读完本章你应该能回答**：
> - 为什么 LLM 的逐 token 输出在客户端是"工程问题"而不是"物理问题"？流式相比非流式换来什么、付出什么？
> - 5 层链路用 AsyncGenerator 串起来，每一层做什么？为什么不用事件总线 / RxJS？
> - `queryModel` 状态机怎么把 SSE 字节流解析成 AssistantMessage？半截 JSON 怎么拼回？
> - 多 Block 交错推送时，按 `part.index` 分桶如何保证最终渲染顺序？
> - Idle Stall 的双层 Watchdog（90s 主动 abort + 30s 被动 metrics）各负责什么？fallback 为什么要切非流式？
> - 为什么渲染层只需要一个 `useDeferredValue` 节流点？`messages` 和 `streamingText` 为什么走不同路径？
> - 错误扣留（withhold）和 Partial JSON 不渲染 UI 的设计动机是什么？

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 流式要解决的核心问题（5 个工程问题） | 必读，建立问题意识 |
| 二 | 流式在架构中的位置、AsyncGenerator 简介 | 必读，建立全局坐标 |
| 三 | 5 层链路的整体结构与职责分工 | 必读，理解每一层做什么 |
| 四 | `queryModel` 状态机：SSE 事件流转、累积策略 | **核心章节**，先看骨架再看细节 |
| 五 | UI dispatch 与渲染节流：handleMessageFromStream + useDeferredValue | 必读，理解 React 渲染层的调度 |
| 六 | 全局视角：流式与上游循环、下游工具执行的衔接 | 建立与其它文档的关联 |
| 七 | 设计决策与权衡 | 理解为什么这样设计 |
| 八 | 可复用的模式 | 提炼可迁移的设计模式 |
| 附录 | AsyncGenerator 跨语言对照（Java/Python） | 按需查阅 |

---

## 一、它在解决什么问题

LLM 的生成是逐 token 的——Transformer 自回归机制决定了第 t 个 token 必须等前 t-1 个 token 算完才能产出。这是一个**物理约束**，没有并行捷径。

但客户端拿到响应并不一定要等所有 token 生成完。所有主流 LLM API（Anthropic / OpenAI / Gemini / Grok / Bedrock / Vertex）都**同时提供流式（`stream: true`）和非流式（`stream: false`）两种调用模式**。Claude Code 选了流式：

| 指标 | 流式 | 非流式 |
|------|------|--------|
| TTFT（首字延迟） | ~300ms | 1-30s（取决于响应长度） |
| 最大响应长度 | 几乎无限（流式无 buffer 上限） | 受服务端超时限制（通常 5-10 分钟） |
| 适合场景 | 长响应 / 实时 UI / Agent 思考过程 | 短响应 / 批处理 / 服务器对服务器 |

TTFT 是关键考量：人眼对 100ms 内的延迟"即时"、300ms"有响应"、超过 1.5s"觉得卡"。非流式意味着 1-30s 一直觉得卡——CLI 体验像 90 年代 BBS。

流式换来 UX，但引入了 5 个必须解决的工程问题：

**问题 1：半截 JSON。** tool_use 的 `input` 字段是 JSON，但 SSE 是逐字符到达的。`{"path": "/home/user/file.txt"}` 会被切成 `{"path": "`、`/ho`、`me/u`、`ser/`、`file`、`.txt`、`"` 这样的字符片段。一拿到 `{` 就 `JSON.parse` 永远失败；等攒齐再 parse 又无法显示"正在构造参数"的状态。

**问题 2：多 Block 并行。** 一次 assistant message 可以包含多个 content block——一段 `text` + 一个 `tool_use` + 一段 `thinking`。这些 block 在 SSE 流里**按 index 交错**推送，stop 事件到达顺序也和 start 不一致。客户端怎么保证最终显示顺序与 API 生成顺序一致？

**问题 3：Idle Stall（流静止）。** LLM 流可能因网络抖动、API 端 GC、模型推理长尾而静默 10-60s 不返回任何事件。如果用户盯着黑屏等 60s，会以为 Agent 挂了；如果无限等，连接永远不释放。需要一个检测 + 兜底机制。

**问题 4：渲染抖动。** 每个 token 触发 setState 会让整个 REPL 重渲染。但 REPL 同时要响应用户键入、滚动、工具权限弹窗——流式不能独占渲染资源。需要一个节流机制让"流式更新"让位给"用户交互"。

**问题 5：跨进程边界的语义。** SDK 客户端（cowork/desktop）收到任何带 `error` 字段的消息会立即终止 session。如果错误是 transient（如 prompt_too_long 可被 reactive compact 修复），提前 yield 会让 SDK 误判为不可恢复而终止整个会话。

---

## 二、它放在架构的哪个位置

流式输出是 API 层和 UI 层之间的桥梁。它把 LLM 的字节流转换成 React 渲染所需的 state 变化。

```
上下文层                              API 层 (流式)
  │ 准备 system prompt + messages       │ 发送请求 → 接收 SSE 字节流
  │                                    │ 累积 token + 解析 JSON
  ▼                                    ▼
┌──────────────────────────────────────────┐
│              Agent 循环                   │
│                                          │
│   while (true) {                         │
│     ① 组装上下文 → ② 调用 LLM →           │
│     ③ 有 tool_use？→ ④ 执行工具 →         │
│     ⑤ 结果注入 → 回到 ①                   │
│   }                                      │
└──────────────────────────────────────────┘
  │                                    │
  ▼                                    ▼
工具层                              UI dispatch 层
  │ 执行工具                           │ 路由 stream_event 到 React setter
  │                                   │
  ▼                                   ▼
                                   渲染层 (REPL.tsx + Ink)
```

**5 层流式链路**——从字节到屏幕的完整路径：

```
┌────────────────────────────────────────────────────────────────────┐
│ Layer 1: API 客户端 (claude.ts:queryModel)                        │
│   职责：SSE 字节 → SDK event → 累积 text/input_json               │
│         → 构造 AssistantMessage                                    │
│   关键设施：Idle Watchdog（90s 主动 + 30s 被动）                   │
│   输出：AsyncGenerator<stream_event | AssistantMessage | Error>    │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ yield (AsyncGenerator)
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 2: 循环层 (query.ts:queryLoop)                               │
│   职责：消费 stream_event；决定是否 withhold 错误；                 │
│         是否需要 fallback；收集 tool_use 块                        │
│   输出：AsyncGenerator<Message>                                    │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ yield
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 3: UI dispatch (messages.ts:handleMessageFromStream)         │
│   职责：把 SDK event 路由到 7 个 React setter                      │
│   输出：setState 触发                                              │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ setState
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 4: 渲染层 (REPL.tsx + Messages.tsx)                          │
│   职责：StreamingMarkdown 增量渲染 streamingText                    │
│         useDeferredValue 节流 messages re-render                   │
│         React.memo 自定义 comparator 跳过无关重渲染                │
│   输出：虚拟 DOM 变更                                               │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ diff
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 5: Ink 渲染框架 (packages/@ant/ink/)                        │
│   职责：虚拟 DOM → ANSI 转义序列 → stdout                          │
│   关键能力：terminal capability 检测 / raw mode / cursor 定位      │
└────────────────────────────────────────────────────────────────────┘
```

**传输机制只有一个**：AsyncGenerator + `for await`。**没有事件总线、没有 RxJS、没有订阅模型**。原因：

| 候选方案 | 选用 | 否决原因 |
|---------|------|---------|
| EventEmitter / EventBus | ❌ | 单生产者-单消费者；不需要多订阅者；需要反向取消语义 |
| RxJS Observable | ❌ | 多一层依赖；项目里没有 RxJS；generator 已能表达 |
| callback 数组（onXxx[]） | ❌ | 没有多订阅者需求；回调通过 props 单向传 |
| **AsyncGenerator yield + for-await** | ✅ | 天然 backpressure、组合性、错误传播、取消语义都满足 |

**AsyncGenerator 满足流式传输的 4 个关键特性**：

1. **Backpressure（反压）**——如果消费者处理慢，生产者自然被减慢。`for await` 消费速度决定 SSE 读取速度，渲染慢则 SDK 自动 pause。
2. **组合性**——多个 `yield*` 链可以嵌套。`query.ts` 用 `yield* yieldMissingToolResultBlocks()` 嵌入辅助 generator。
3. **错误传播**——`throw` 一次冒泡到任意层级的 try/catch。
4. **取消语义**——`break` 即取消，generator 的 `finally` 仍执行清理（关闭 fetch AbortController、释放连接）。

---

## 三、5 层链路的整体结构

### 3.1 Layer 1：API 客户端 `queryModel`

Layer 1 是整个流式链路的源头。它消费 SSE 字节流，产出可被上层消费的 stream_event 和 AssistantMessage。

```typescript
// src/services/api/claude.ts:1049
async function* queryModel(
  messages, systemPrompt, thinkingConfig, tools, signal, options
): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void>
```

`queryModel` 是 `claude.ts` 的核心函数。它实现一个状态机，把 Anthropic SDK 的 6 种 SSE event 转换成上层的 stream_event / AssistantMessage。详细的状态机和事件处理在第四章展开。

**Layer 1 的关键基础设施**：

| 设施 | 位置 | 职责 |
|------|------|------|
| Idle Watchdog（主动层） | claude.ts:1976-2031 | 90s 无 chunk → `releaseStreamResources()` 主动断开 → catch 后切非流式 |
| Idle Watchdog（被动层） | claude.ts:2038-2068 | 30s 无 chunk → 仅 `stallCount++` 记 metrics，不中断 |
| input_json 累积器 | claude.ts:2215 | 字符串拼接，到 stop 时一次 parse |
| text_deltas 累积器 | claude.ts:2229 | `Map<index, string[]>` + 末尾 join |
| 多 Block 路由 | claude.ts:2097 | 按 `part.index` 分桶累积 |

### 3.2 Layer 2：循环层 `queryLoop`

Layer 2 是 Agent 循环的核心（详见 [03-agent-loop](cc-03-agent-loop.md)）。在流式语境下，它消费 Layer 1 yield 的 stream_event，做两类决策：

**错误扣留（withhold）。** `prompt_too_long` 和 `max_output_tokens` 错误经常是可恢复的——通过 reactive compact 或 fallback 模型能修复。如果立刻 yield 错误消息，cooperate-style SDK 客户端会立即终止 session。Layer 2 的循环会先调用 `isWithheldPromptTooLong` / `isWithheldMaxOutputTokens` 判断是否扣留，扣留则不 yield，让恢复路径有机会修复。

```typescript
// src/query.ts:1041-1078
let withheld = false
if (feature('CONTEXT_COLLAPSE')) {
  if (contextCollapse?.isWithheldPromptTooLong(message, isPromptTooLongMessage, querySource)) {
    withheld = true
  }
}
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
if (isWithheldMaxOutputTokens(message)) withheld = true

if (!withheld) yield yieldMessage
```

**tool_use 收集。** Layer 2 监听 `content_block_stop` 事件，识别 tool_use block，push 到 `toolUseBlocks[]`。一轮结束后驱动工具执行。

### 3.3 Layer 3：UI dispatch `handleMessageFromStream`

Layer 3 是 REPL/SDK 边界的统一调度器。所有从 `query()` 流出的消息都过这里分发到 React setter。

```typescript
// src/utils/messages.ts:3285
export function handleMessageFromStream(
  message: StreamMessage,
  callbacks: {
    onMessage: (message: Message) => void,
    onStreamingText?: (f: (current: string | null) => string | null) => void,
    onSetStreamMode?: (mode: StreamMode) => void,
    onStreamingToolUses?: (f: (current: StreamingToolUse[]) => StreamingToolUse[]) => void,
    onStreamingThinking?: (f: (current: StreamingThinking | null) => StreamingThinking | null) => void,
    onUpdateLength?: (text: string) => void,
    onApiMetrics?: (metrics: { ttftMs?: number }) => void,
  },
): void
```

7 个回调的语义和触发时机在第五章展开。

### 3.4 Layer 4：渲染层

Layer 4 把 Layer 3 的 setState 转换成 Ink 终端输出。三个关键组件：

- **StreamingMarkdown**：流式 markdown 渲染组件，边收边渲染（Messages.tsx:954）
- **useDeferredValue**：唯一的 throttle 点（REPL.tsx:1625），把 `messages` 数组的更新分类成低优先级 transition
- **React.memo + 自定义 comparator**（Messages.tsx:1004-1043）：跳过无关重渲染，`Set<string>` 字段用 `setsEqual` 深比较

渲染层的节流机制在第五章展开。

### 3.5 Layer 5：Ink 渲染框架

Ink 是 React 的自定义终端渲染器——把 React 组件树转为 ANSI 转义序列输出到 stdout。Claude Code 内部 fork 了一份（`packages/@ant/ink/`），**不是** `src/ink/`。

| 目录 | 职责 |
|------|------|
| `packages/@ant/ink/components/` | Box / Text / Static 等基础终端元素 |
| `packages/@ant/ink/core/` | reconciler、output buffer、diff 算法 |
| `packages/@ant/ink/hooks/` | `useInput` / `useApp` / `useStdin` |
| `packages/@ant/ink/keybindings/` | 键盘事件处理 |

Ink 的关键能力：
- **terminal capability 检测**：自动适配不同终端（颜色、宽字符、cursor 定位）
- **raw mode**：让 REPL 能接收键盘事件
- **virtual DOM diff**：每次 render 只更新变化的区域，避免整屏重绘
- **FpsMetrics**：追踪渲染帧率，调试用——流式场景下若 FPS 跌到 30 以下说明渲染跟不上 token 速度

---

## 四、API 层状态机：`queryModel` 的事件流转

Layer 1 的核心是 `queryModel` 状态机。它把 SSE 字节流解析成上层可消费的 stream_event 和 AssistantMessage。

### 4.1 状态机字段

```typescript
// claude.ts:1862-1876
let newMessages: AssistantMessage[] = []          // 累积本请求的 assistant 输出
let ttftMs: number | undefined                     // time-to-first-token
let partialMessage: BetaMessage | null = null     // 来自 message_start 的元数据
let contentBlocks: ContentBlock[] = []             // 按 part.index 索引
let textDeltas: Map<number, string[]> = new Map() // text_deltas 按 index 累积
let usage: NonNullableUsage = EMPTY_USAGE          // 累积的 usage
let stopReason: BetaStopReason | null = null      // 来自 message_delta
let streamIdleAborted = false                      // idle watchdog 触发标记
let stallCount = 0                                  // 静默 stall 计数（仅观测）
```

每个字段的用途：
- `newMessages` — 本次 API 请求完整结束时一次性 yield 给上游
- `partialMessage` — `message_start` 携带的元数据（model、usage 初始值），后续在 `message_delta` 中更新
- `contentBlocks` + `textDeltas` — 解决问题 2（多 Block 并行）的核心数据结构：按 index 分桶
- `stopReason` — 最终 stop reason（`end_turn` / `tool_use` / `max_tokens` 等），驱动 withhold 判断

### 4.2 6 种 SSE 事件处理

| 事件 | 行号 | 处理 |
|------|-----|------|
| `message_start` | claude.ts:2082 | 初始化 `partialMessage`、捕获 TTFT、记录初始 usage |
| `content_block_start` | claude.ts:2097 | 按 type 初始化 block：`tool_use` 设 `input: ''`；`text` 留空 |
| `content_block_delta` | claude.ts:2156 | 累积：`input_json_delta` 字符串拼接；`text_delta` push 到 `textDeltas.get(index)`；`thinking_delta` 累加；`signature_delta` 写入 signature |
| `content_block_stop` | claude.ts:2276 | text_deltas.join('')；JSON.parse input；构造 AssistantMessage；yield + push |
| `message_delta` | claude.ts:2325 | `stopReason = part.delta.stop_reason`；**直接 mutate** `lastMsg.message.usage`（避免 transcript 写队列断引用） |
| `message_stop` | claude.ts:2410 | no-op（仅结束信号） |

每个 event 末尾都 `yield { type: 'stream_event', event: part }`，让上游可以观察原始事件做 metrics。

### 4.3 半截 JSON 累积（问题 1 详解）

**痛点**：`{"path": "/home/user/file.txt"}` 被 SSE 切成字符片段。一拿到 `{` 就 `JSON.parse` 永远失败；等攒齐再 parse 又无法显示"正在构造参数"。

**机制**：

```typescript
// claude.ts:2213-2216
case 'input_json_delta':
  if (contentBlock.type !== 'tool_use' && contentBlock.type !== 'server_tool_use') { throw }
  if (typeof contentBlock.input !== 'string') { throw }
  contentBlock.input += delta.partial_json    // 始终是字符串
```

直到 `content_block_stop` 才在 `normalizeContentFromAPI` 中 `JSON.parse`（claude.ts:2307）。解析失败也不污染累积状态——可以丢弃整个 input 重新生成。

**为什么不"攒齐再 parse"？** 三条反作用：

1. **失去流式感**——用户在 LLM 思考 tool 参数时看不到 spinner
2. **错误处理复杂度转移**——怎么知道 JSON 完整？必须等 `content_block_stop`，但事件顺序是网络依赖的，`content_block_stop` 可能比最后一个 `input_json_delta` 早到
3. **无法增量展示**——若想"实时显示已接收的字符数"，只能依赖字符串累积

**结论**：字符串 + parse-once-at-stop 是流式感知的最小代价。

### 4.4 text_deltas 用 Map 而非数组

```typescript
// claude.ts:1866 + 2229
const textDeltas: Map<number, string[]> = new Map()
textDeltas.get(part.index)?.push(delta.text!)
```

注释（line 2297）："O(n) join instead of O(n^2) +=`"——数组 push + 末尾 `deltas.join('')` 而非每个 delta 触发字符串拼接。配合按 index 分桶（解决问题 2），让多 block 并行累积时仍是 O(n) 复杂度。

### 4.5 message_delta 的延迟 mutate

```typescript
// claude.ts:2356-2360
if (lastMsg) {
  lastMsg.message.stop_reason = stopReason    // 直接 mutate
  if (Object.keys(usage).length > 0) {
    lastMsg.message.usage = usage
  }
}
```

为什么 mutate 而不是 `{ ...lastMsg, message: { ...lastMsg.message, usage } }`？注释（line 2348-2353）解释：`sessionStorage.ts` 的 transcript 写队列靠对象引用做懒序列化，对象替换会断引用链；原地 mutate 才能让 transcript 看到完整的 usage。

### 4.6 Stop Reason 分类处理

```typescript
// claude.ts:2354 + 2373-2407
stopReason = part.delta.stop_reason
const errorMessageIfRefusal = getErrorMessageIfRefusal(stopReason, options.model)
if (errorMessageIfRefusal) {
  yield createAssistantAPIErrorMessage({ apiError: 'refusal', ... })
}
if (stopReason === 'max_tokens') {
  yield createAssistantAPIErrorMessage({ apiError: 'max_output_tokens', ... })
}
if (stopReason === 'model_context_window_exceeded') {
  yield createAssistantAPIErrorMessage({ apiError: 'max_output_tokens', ... })  // 共用恢复路径
}
```

`model_context_window_exceeded` 与 `max_tokens` 共用恢复路径（query.ts:1475-1543 的升级 / recovery 逻辑），只是触发源头不同。

### 4.7 Idle Watchdog 双层保护（问题 3 详解）

| 层 | 行号 | 阈值 | 行为 | 触发后 |
|----|-----|------|------|-------|
| **主动 abort（Active）** | claude.ts:1976-2031 | `STREAM_IDLE_TIMEOUT_MS = 90_000`（90s） | `releaseStreamResources()` 主动断开（line 2028） | throw `Error('Stream idle timeout')`（line 2449） → catch 后切非流式 fallback |
| **被动 stall 记录（Passive）** | claude.ts:2038-2068 | `STALL_THRESHOLD_MS = 30_000`（30s） | 仅 `stallCount++`、`totalStallTime += delta`、记录 `tengu_streaming_stall` 事件 | 流结束（line 2482-2495）记录总 stall 数到 metrics |

```typescript
// claude.ts:1976-2031
if (Date.now() - lastEventTime > STREAM_IDLE_TIMEOUT_MS) {
  streamIdleAborted = true
  releaseStreamResources()    // 主动 abort fetch
  break   // 退出 for-await
}
```

**为什么 fallback 用非流式？** 所有 LLM API 都同时提供流式/非流式两种模式，`executeNonStreamingRequest` 是统一的 Provider-agnostic 入口。流已卡死重试无用，非流式重新发起更简单。

**为什么不做单层？**

| 单层方案 | 问题 |
|---------|------|
| 只做主动 90s | 太长，用户盯着黑屏以为 Agent 挂 |
| 只做被动 30s | 慢速模型（如 Sonnet 在超长上下文）合法花 30s+ 思考会被误断 |
| 只做被动 | 无 hard limit，连接永远不释放 |

**双层各司其职**：被动层（30s metrics）观测而非干预——把 stall 数据上报 metrics，避免误判慢速模型；主动层（90s abort）是保守的安全网——只有"真的完全没动静"才中断。被动层只观测不断流，避免级联重试（主动 abort 会触发 fallback 重试）。

---

## 五、UI dispatch 与渲染节流

### 5.1 Layer 3 的 7 个回调

`handleMessageFromStream` 路由 stream_event 到 7 个 React setter：

| 回调 | 触发时机 | 用途 |
|------|---------|------|
| `onMessage(msg)` | 完整 AssistantMessage / UserMessage 到达 | 推到 `messages: Message[]`，触发 MessageRow 渲染 |
| `onStreamingText(_ => string)` | 每个 text_delta | 增量拼接 streaming 文本，渲染 StreamingMarkdown |
| `onSetStreamMode(mode)` | block type 切换 | 切 spinner 模式（requesting / thinking / responding / tool-input） |
| `onStreamingToolUses(_ => StreamingToolUse[])` | tool_use start / input_json_delta | 维护 streaming tool_use 列表（用于 tool_result 渲染关联） |
| `onStreamingThinking(_ => StreamingThinking)` | thinking_delta / thinking block 完整 | 累加或完成 thinking 渲染（默认隐藏，30s 窗口） |
| `onUpdateLength(text)` | 每个 delta | 更新 token 计数器和 OTPS 动画 |
| `onApiMetrics({ttftMs})` | message_start | 上报 time-to-first-token 指标 |

**注意**：这些"回调"是父组件 REPL 通过 props 注入的 React 状态 setter 函数，不是事件总线风格的多订阅者订阅。每个会话独立，REPL 销毁时一并 GC。

### 5.2 主 dispatch switch

```typescript
// src/utils/messages.ts:3389-3482
switch (streamMsg.event.type) {
  case 'content_block_start':
    onStreamingText?.(() => null)            // 重置文本累积器
    switch (streamMsg.event.content_block.type) {
      case 'thinking':
      case 'redacted_thinking':
        onSetStreamMode('thinking')
        return
      case 'text':
        onSetStreamMode('responding')
        return
      case 'tool_use': {
        onSetStreamMode('tool-input')         // spinner 切到接收参数
        onStreamingToolUses(_ => [..._, {
          index, contentBlock, unparsedToolInput: '',
        }])
        return
      }
      // ...
    }

  case 'content_block_delta':
    switch (streamMsg.event.delta.type) {
      case 'text_delta': {
        onUpdateLength(deltaText)             // token 计数器（动画条）
        onStreamingText?.(text => (text ?? '') + deltaText)
        return
      }
      case 'input_json_delta': {
        onUpdateLength(delta)
        onStreamingToolUses(_ => {
          // 累积 unparsedToolInput，但不渲染 UI
        })
        return
      }
      // ...
    }
}
```

### 5.3 完成态原子切换（问题 5 核心机制）

**痛点**：当 assistant message 完整到达（`content_block_stop` + `message_delta` + `message_stop` 三连），需要把 streaming 草稿切换成最终消息。两者必须在**同一个 React render batch** 内完成——否则用户看到：先显示草稿 → 突然空白 → 出现完整消息（含 markdown 重新解析）。

**机制**：

```typescript
// src/utils/messages.ts:3319-3345
if (message.type === 'assistant') {
  const assistMsg = message as Message
  const contentArr = Array.isArray(assistMsg.message?.content) ? assistMsg.message.content : []
  const thinkingBlock = contentArr.find(b => typeof b !== 'string' && b.type === 'thinking')
  if (thinkingBlock && typeof thinkingBlock !== 'string' && thinkingBlock.type === 'thinking') {
    const tb = thinkingBlock as ThinkingBlock
    onStreamingThinking?.(() => ({
      thinking: tb.thinking,
      isStreaming: false,                          // 标记为完成
      streamingEndedAt: Date.now(),
    }))
  }
}
// Clear streaming text NOW so the render can switch displayedMessages
// from deferredMessages to messages in the same batch.
onStreamingText?.(() => null)        // ← 先清流式
onMessage(message as Message)        // ← 再 push final
```

**关键顺序**：先清 streaming text 再 push final message。注释（line 3340-3342）解释：`useDeferredValue` 让 `displayedMessages` 在 streaming 期间用 `deferredMessages`，final message 到来时必须**同一 batch** 内清 streaming + push message，避免 React 显示空白帧。

### 5.4 Layer 4 的唯一 throttle：`useDeferredValue`

**问题 4 详解**：每个 token 触发 setState 会让整个 REPL 重渲染。但 REPL 同时要响应用户键入、滚动、工具权限弹窗——流式不能独占渲染资源。

**机制**：

```typescript
// REPL.tsx:1620-1631
const DEFERRED_CAP = 500
const cappedMessages = React.useMemo(
  () => (messages.length > DEFERRED_CAP ? messages.slice(-DEFERRED_CAP) : messages),
  [messages],
)
const deferredMessages = useDeferredValue(cappedMessages)  // ← 唯一 throttle
```

```typescript
// REPL.tsx:5541 — 何时用同步 messages（跳过 defer）
const usesSyncMessages = showStreamingText || !isLoading
const displayedMessages = usesSyncMessages ? messages : deferredMessages
```

`useDeferredValue`（React 18 hook）节流的不是单次 setState 的频率，而是把"昂贵的渲染工作"（整个 `messages` 数组 re-render）让位给高优先级更新（用户键入）。

| 状态 | 渲染源 | 原因 |
|------|--------|------|
| `isLoading` 时（生成完整消息前） | `deferredMessages` | 让 React 18 并发渲染调度在空闲时处理 |
| streaming 文本可见时（`showStreamingText`） | 同步 `messages` | 防"白闪"——final 消息不被推到下一帧 |
| turn 结束（`!isLoading`） | 同步 `messages` | 防"spinner 消失但答案还没出现"的空白帧 |

注释（`REPL.tsx:5536-5540`）显式说明：只有 `reducedMotion` 用户在 loading 期间才走 deferred 路径——他们宁可减少 motion 也要立刻看到答案。

### 5.5 为什么单 throttle 就够？

**4 条理由**：

1. **不需要 per-event throttle**：每条 streaming token **不**触发 `setMessages`——`messages` 数组只在 `content_block_stop` 时 push 一次（一个 complete assistant message）。真正高频的 delta 只走 `streamingText` 这条同步 setState——StreamingMarkdown 渲染便宜（纯文本 append），无需节流。

2. **不需要 `setTimeout` 批处理**：React 18 的 concurrent scheduler 已经把"低优先级 setState"合并到下一批 idle frame。`useDeferredValue` 让 `messages` 的 update 被分类成 `transition`，自动获得 batching + interruption。

3. **不需要 `useTransition`**：`useDeferredValue` 是**被动**节流（"什么时候渲染新值由 React 决定"），`useTransition` 是**主动**节流（"我包一层 startTransition"）。REPL 的渲染逻辑天然适配被动——UI 在 `messages` 变化时重新订阅"新值何时显示"。

4. **没有 cascading deferrals**：派生 state（`isLoading` / `showStreamingText` / `viewedAgentTask`）全是同步的，不走 deferred。一次 throttle 解锁了"messages 在 typing 时不卡键入"这一痛点，其他都不需要。

**User-perceivable lag**：典型滞后 0–16ms（一帧）。仅在 React 调度器饱和（如用户极速打字同时 agent 在 streaming 一个很长 message）时会出现"打字的字落下 1-2 帧"的现象。两个强 sync 开关确保 turn 结束/streaming 收尾时不出现 jitter。

### 5.6 Messages 自定义 memo comparator

```typescript
// Messages.tsx:1004-1043
const Messages = React.memo(MessagesImpl, (prev, next) => {
  return prev.messages === next.messages
    && setsEqual(prev.inProgressToolUseIDs, next.inProgressToolUseIDs)
    && setsEqual(prev.streamingToolUseIDs, next.streamingToolUseIDs)
})
```

跳过 React 默认浅比较，`Set<string>` 用 `setsEqual` 深比较，避免每次 stream event 触发整个消息列表重渲染。

### 5.7 Partial JSON 永不渲染到 UI

```typescript
// messages.ts:3448
onStreamingToolUses(_ => [..._, { ...element, unparsedToolInput: element.unparsedToolInput + delta }])
```

`unparsedToolInput` 累积在 React state 中但**没有消费者**——保留仅为未来调试。UI 渲染 tool_use 卡片只看 `contentBlock`（name + 已解析 input）。**为什么？** JSON 不完整时显示无意义（`{"path": "` 对用户来说就是乱码）；显示完整后才有价值。

---

## 六、全局视角：流式与上下游的衔接

流式链路不是孤立的。它的两端——上游的循环层和下游的工具执行层——都需要流式提供的特定能力。

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Agent 循环 (queryLoop)                       │
│                                                                     │
│  while (true) {                                                      │
│    ① 上下文准备 ──────────────────────────────────────────────────  │
│    │                                                               │
│    ▼                                                               │
│    ② API 调用                                                      │
│    │   ┌─────────────────────────────────────────────────────────┐ │
│    │   │  for-await (stream_event of queryModel)                 │ │
│    │   │    ├─ content_block_delta (text) → 透传给 UI 逐字渲染     │ │
│    │   │    ├─ content_block_delta (json) → 累积 tool_use 参数   │ │
│    │   │    ├─ content_block_stop     → 触发下游处理             │ │
│    │   │    ├─ message_delta          → stop_reason + usage     │ │
│    │   │    └─ 90s 无事件             → abort + 切非流式 fallback │ │
│    │   └─────────────────────────────────────────────────────────┘ │
│    │                                                               │
│    ▼                                                               │
│    ③ 判断去向 ─── 有 tool_use？──── 否 ──► 退出判断 ──► return      │
│    │ 是                                                            │
│    ▼                                                               │
│    ④ 工具执行                                                      │
│    │                                                               │
│    │   ┌─────────────────────────────────────────────────────────┐ │
│    │   │  if (streamingToolExecutor enabled) {                  │ │
│    │   │    // 流式工具执行：收到 tool_use 立即启动执行           │ │
│    │   │    // 与 LLM 收尾 prompt 重叠，最大化总吞吐              │ │
│    │   └─────────────────────────────────────────────────────────┘ │
│    │                                                               │
│    ▼                                                               │
│    ⑤ 下一轮准备                                                    │
│  }                                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

**流式与上游的衔接：扣留与恢复**

`queryLoop`（Layer 2）消费 stream_event 时，根据 stop_reason 和错误类型决定是否扣留。扣留的错误不会 yield 给调用方，而是让恢复路径（collapse drain / reactive compact / max_tokens 升级）有机会默默修复。这是 Layer 1 + Layer 2 协同的结果——Layer 1 只管产生事件，决策在 Layer 2。

**流式与下游的衔接：流式工具执行**

正常工具执行需要等整个 LLM 响应结束（所有 tool_use block 收集完毕），才启动执行。但当 `streamingToolExecutor` gate 打开时，系统不会等整个响应结束——收到一个 tool_use block 就立刻启动执行。这样工具执行和 LLM 推理可以重叠：LLM 在输出最后一个 tool_use 时，第一个 tool_use 可能已经执行完了。详见 [05-tool-execution-pipeline](cc-05-tool-execution-pipeline.md)。

**一个 token 的完整旅程**（证明"零事件总线"）：

```
Anthropic Server              claude.ts                query.ts              messages.ts                REPL.tsx                  Ink
       │                         │                        │                      │                          │                       │
       │ SSE "text":"hello"     │                        │                      │                          │                       │
       │ ─────────────────────► │ for await event        │                      │                          │                       │
       │                         │ textDeltas[0].push    │                      │                          │                       │
       │                         │ yield stream_event     │                      │                          │                       │
       │                         │ ────────────────────► │ for await yield      │                          │                       │
       │                         │                        │ yield                 │                          │                       │
       │                         │                        │ ──────────────────► │ switch 'text_delta'       │                       │
       │                         │                        │                      │ onStreamingText(t+δ)      │                       │
       │                         │                        │                      │ ──────────────────────►  │ setStreamingText      │
       │                         │                        │                      │                          │ StreamingMarkdown     │
       │                         │                        │                      │                          │ ───────────────────► │ ANSI → stdout
       │                         │                        │                      │                          │                       │ "hello"
```

整条链路**没有 emit、没有订阅、没有事件映射表**——只有 `for await` 和 `yield`。

---

## 七、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| 流式协议 | SSE | WebSocket | Anthropic API 原生提供；单向数据流足够 |
| 传输机制 | AsyncGenerator | EventBus / RxJS | backpressure / 错误传播 / 取消语义天然满足；零依赖 |
| 渲染策略 | 逐 token + useDeferredValue | 按行/按句渲染 | 终端渲染延迟极低（&lt;1ms），逐 token 给最即时反馈 |
| 工具调用渲染 | 卡片式（展开/折叠） | 内联 JSON | 参数可能很长（如 file content） |
| 流式中断恢复 | 主动 90s abort + 被动 30s metrics | 单一阈值 | 防真断连 vs 记录慢响应 |
| Fallback 模式 | 非流式 | 流式重试 | 流已卡死重试无用；非流式更简单 |
| Thinking 渲染 | 默认隐藏，30s 窗口短暂可见 | 始终显示 | 内容是 LLM 内部推理，对用户通常无意义 |
| input_json 累积 | 字符串 + parse-once | 增量 JSON.parse | parse 失败可重试；累积期间不暴露不完整数据 |
| text_deltas 累积 | Map + 末尾 join | 每 delta += | O(n) vs O(n²) |
| 错误扣留 | prompt-too-long / max-tokens 不立刻 yield | 立即 yield | SDK 收到错误会终止 session |
| Partial JSON UI | unparsedToolInput 私有 state 不渲染 | 边累积边显示 | JSON 不完整时无意义 |
| UI 节流 | 单一 useDeferredValue | setTimeout / useTransition | passive 节流足够；React 18 并发调度自动 batching |
| 同步开关 | showStreamingText / !isLoading 跳过 defer | 全程 deferred | 防"白闪" |
| Tombstone 清空 | 流式 fallback 时 yield tombstone 删之前的部分消息 | 让 SDK 自己处理 | thinking signature 不完整会导致后续 API 拒绝 |

---

## 八、可复用的模式

- **流式状态机模式**：用状态机（`IDLE → STREAMING_TEXT → ACCUMULATING_TOOL_JSON → EXECUTING → DONE`）管理流式输出的不同阶段，每阶段有独立的渲染和错误处理逻辑。适用任何需要处理长连接 + 多阶段状态的场景。

- **渐进式渲染模式**：先展示确定内容（文本 token 逐字），延迟展示不确定内容（tool_use JSON 累积中不渲染参数）。用户体验：先给反馈，再给完整。

- **Idle Watchdog 双层模式**：主动 abort（90s）防止真断连，被动 metrics（30s）记录慢响应。不同阈值不同响应——"真断连"用 hard limit 兜底，"慢但还在动"用 metrics 观测。适用任何长连接可靠性保障。

- **多层 yield 模式**：API 层 yield `stream_event`（原始事件）→ 循环层 yield `stream_event` 或 `assistant` → UI 层 `handleMessageFromStream` 调度。每层可以过滤和转换事件，解耦各层的关注点。

- **错误扣留（Withhold）模式**：可恢复错误不立刻 yield，等恢复路径决定——避免 SDK 边界过早终止会话。适用任何跨进程边界的错误处理。

- **流式 + 工具并行执行**：通过 `streamingToolExecutor` 让收到 tool_use 立即启动执行，与模型收尾 prompt 重叠，最大化总吞吐。

- **同步消息数组切换**：`displayedMessages = usesSyncMessages ? messages : deferredMessages`——streaming 期间用 deferred 减少 React 工作，但 streamingText 可见时切回 sync 保证渲染顺序。适用 React 18 + 流式渲染场景。

---


## 附录：AsyncGenerator 跨语言对照

本文中 `query()` 返回 `AsyncGenerator`，调用方用 `for await` 消费。如果你主要写 Java 或 Python，这些概念可能不熟悉。

**async/await** — JavaScript 单线程事件循环模型。`async` 标记异步函数（返回值自动包装为 `Promise`），`await` 挂起当前函数等结果就绪，不阻塞线程。

| 概念 | JavaScript | Java | Python |
|------|-----------|------|--------|
| 异步值 | `Promise<T>` | `CompletableFuture<T>` | `Future` |
| 标记异步函数 | `async function` | 返回 `CompletableFuture` 的方法 | `async def` |
| 等待异步值 | `await promise` | `future.thenAccept(cb)` 不阻塞；`future.get()` 阻塞线程 | `await coroutine` |
| 并发 | `Promise.all([a,b])` | `CompletableFuture.allOf(a,b).thenAccept(...)` | `asyncio.gather(a,b)` |

Java 的 `get()` 阻塞的是**调用它的那个线程**，不是整个程序——可以放在专门的等待线程中。Java 21 虚拟线程让 `get()` 在虚拟线程中只阻塞虚拟线程（廉价），不阻塞载体 OS 线程（昂贵），行为上接近 JavaScript `await`。

**AsyncGenerator** — `async function*` + `yield`，可以多次暂停并异步产出值，调用方用 `for await` 逐个消费。本项目 `query()` 每收到 LLM 的一个 token / 执行完一个工具就 yield 一条消息。

| 概念 | JavaScript | Java | Python |
|------|-----------|------|--------|
| 同步 Generator | `function*` + `yield` | `Iterator<T>` | `def` + `yield` |
| 异步 Generator | `async function*` + `yield` | 无原生支持，用 Reactive Streams `Publisher<T>` 或 `BlockingQueue<T>` | `async def` + `yield` (PEP 525) |
| 消费异步流 | `for await (const x of gen)` | `Flow.subscribe(subscriber)` 回调式 | `async for x in gen` |

Java 最接近的是 Reactive Streams，但是回调式（`onNext`/`onError`/`onComplete`），不像 `for await` 是线性可读的控制流。Python 的 `async for` 和 JavaScript 几乎一一对应。
