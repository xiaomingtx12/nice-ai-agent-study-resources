---
slug: /application-notes/engineering/claude-code-cli/cc-04-agent-loop
sidebar_position: 4
title: "Agent 主循环"
description: "queryLoop 的 while(true) 是整个 Harness 的中枢。本篇拆它的十字段状态机、五阶段迭代、四层防失控，以及七种继续与十种终止。"
---

# Agent 主循环引擎

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2（逆向工程复刻仓库 `claude-code-best/claude-code`，V5 主线，HEAD `d0713bdd`）。该仓库是对 Anthropic Claude Code CLI 的工程复刻，行为层接近原项目，源码组织可能不同。正文统一使用相对路径、函数名和关键代码片段定位，源码变动后优先沿这些语义锚点阅读。
>
> **核心路径**：
>
> - **主循环三层**：`src/query.ts` 的 `query()` 创建或复用本轮追踪，并在 `finally` 中清理资源；`queryLoop()` 承载真正的 `while (true)` 状态机；`State` 类型保存跨迭代状态。正文第二、三节展开。
> - **出口类型中枢**：`src/query/transitions.ts` 定义 `Continue` 与 `Terminal` 两组联合类型，继续和终止分支通过这些原因对象向外报告状态。正文第六节展开。
> - **会话适配层**：`src/QueryEngine.ts` 的 `QueryEngine.submitMessage()` 处理用户输入，构造 `QueryParams`，调用并消费 `query()`，维护 `mutableMessages`，写入 transcript，并把内部消息转换成 SDK 消息和 result 终态。正文第二节展开。
> - **工具执行层**：`src/services/tools/toolOrchestration.ts` 的 `runTools()` 调用 `partitionToolCalls()`，按 `isConcurrencySafe` 把连续的并发安全调用合并成并发批次，其余调用按顺序执行，并把工具返回的新上下文交回 `queryLoop()`。正文第四节展开。
> - **运行时上下文**：`src/Tool.ts` 的 `ToolUseContext` 是运行时对象的 TypeScript 类型约束，字段覆盖工具、模型、取消控制器、应用状态回调和追踪信息。正文第三节结合 `State.toolUseContext` 说明它的字段和更新过程。
> - **模型流与消息归一化**：`src/services/api/claude.ts` 的 `queryModelWithStreaming()` 负责建立流式模型请求并产出内部消息；`src/utils/messages.ts` 的 `mergeAssistantMessages()` 在消息归一化阶段合并同一 assistant 响应的内容块。正文第四、七节展开。

## 为什么读这一篇

Claude Code 的 `query.ts` 很长，而这份代码里几乎没有一行是在“让循环转起来”——大量实现都在防止它转不停、转崩，或者转到一半把上下文撑爆。

这一篇回答三个问题：

- **`while(true)` 凭什么能稳定收敛？**——四层防失控机制（硬中断、轮次护栏、决策分叉、恢复守卫）如何层层兜底。
- **为什么循环要拆成三个函数？**——`queryLoop()` / `query()` / `QueryEngine` 各自解决什么，合并任意两层会丢什么。
- **一次迭代到底发生了什么？**——五个阶段的输入输出，以及消息为什么必须按 `tool_use_id` 严格配对。

上一篇 [03 入口与生命周期](../01-architecture-lifecycle/cc-03-entry-and-lifecycle.md) 讲进程怎么启动到能跑循环的状态。

本篇的阶段 1（上下文准备）在 [06 上下文装配](cc-06-context-assembly.md) 与 [08 压缩子系统](cc-08-compaction-subsystem.md) 里有完整展开，阶段 4（工具执行）的权限与钩子细节在 [10 工具执行管线](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)。

:::tip 一句话
`queryLoop()` 只管轮次推进，`query()` 只管资源的干净开始与结束，`QueryEngine` 只管把循环接到具体调用方的协议上。三层分开之后，复杂实现仍然可以归回“状态机”和“防失控”两类问题。API 层面的错误也会改变模型下一轮能看到的上下文。
:::

## 一、循环层要解决的六个问题

循环的核心逻辑本身很朴素：

```text
用户输入 → 模型推理 → 需要执行工具？→ 执行 → 结果回灌 → 继续推理 → … → 输出最终回答
```

但把这个朴素逻辑放进真实工程环境，会立刻撞上六个问题。

**第一，循环不会自己停下来。** 模型可能反复调同一个工具、在两个方案之间来回摇摆、陷入"再检查一遍"的死循环。需要一套从紧急（用户按 Ctrl+C）到自然（模型说完成了）的多层退出机制，见第五节。

**第二，上下文窗口是有限的。** 每一轮都在消耗 token 预算。累积消息超过窗口上限时必须在循环内部触发压缩——把旧消息折叠成摘要腾空间。压缩本身也烧 token，所以还要判断"现在压缩值不值"。

**第三，工具执行不能简单串行或全并发。** 读文件互不影响可以并行；写文件和随后的读文件有先后依赖，顺序错了结果全错。需要一个分批策略。

**第四，模型调用会失败。** 网络抖动、模型过载、提示词超长——失败原因各不相同。有些该重试同一个模型，有些该切备用模型，有些（比如提示词太长）要先压缩再重试。

**第五，循环需要与外部模块协作。** 权限审批要在工具执行前拦截，钩子（Hook）要在关键节点注入逻辑，子 Agent 要从循环中派生出去独立运行，计划模式要约束循环的行为范围。循环需要给这些模块提供接口，见第八节。

**第六，状态变更必须可审计，消息必须完整传递。** 几千行的循环里，五轮之前那次 `state.toolUseContext` 是谁改的、为什么改，事后要能查。

同时本轮的 assistant 消息和 `tool_result` 必须按 `tool_use_id` 严格配对传给下一轮，否则 API 直接拒收。`queryLoop()` 在拼接下一轮消息时会保持“assistant 的 tool_use 在前、user 的 tool_result 在后”的顺序，不能在两者之间插入普通 user 消息。

---

## 二、三层结构：为什么拆成三个函数

### 2.1 三层各管什么

| 层 | 函数 | 职责 | 不管什么 |
|---|---|---|---|
| 状态机层 | `queryLoop()` | 轮次推进：`while (true)`、状态全量替换，以及继续或返回的决策 | 不知道调用方是谁，不负责跨调用持久化 |
| 生命周期层 | `query()` | 一次循环干净地开始和结束：创建或复用追踪，并在 `finally` 中释放资源 | 不持久化跨调用状态，也不决定具体协议 |
| 会话适配层 | `QueryEngine.submitMessage()` | 把循环接到具体调用方：处理输入、维护会话、持久化消息、转换协议和输出终态 | 不介入循环内部的状态机决策 |

合并其中任意两层都会丢东西：

| 合并方案 | 丢什么 |
|---|---|
| `QueryEngine` + `query()` | 子 Agent 复用追踪（trace）的路径断掉。`runAgent()` 把父追踪注入 `toolUseContext.langfuseTrace`，需要 `query()` 入口的 `ownsTrace` 判断来决定"复用还是新建"。合并后父子层级关系丢失。 |
| `query()` + `queryLoop()` | 一千六百行循环里的每个 `continue` 路径都要复制一遍 finally 清理，漏一个就意味着追踪对象永不释放。 |
| `QueryEngine` + `queryLoop()` | SDK 适配职责——会话记录、终态包装、协议转译——会渗进循环内部，状态机被协议细节污染。 |

### 2.2 `query()` 为什么必须无状态

`query()` 接收的参数里没有任何"会话级"字段——没有 `sessionId`，没有跨轮消息数组，没有持久化路径。它的全部价值在一个 try/finally 块里：

```typescript
// src/query.ts，query()：追踪的所有权判定
// 子 Agent 复用父追踪，顶层调用才新建追踪
const ownsTrace = !params.toolUseContext.langfuseTrace
const langfuseTrace =
  params.toolUseContext.langfuseTrace ??
  (isLangfuseEnabled() ? createTrace({ sessionId: getSessionId(), ... }) : null)
```

`query()` 的 `finally` 块负责三类清理：

```typescript
// src/query.ts，query() 的 finally：无论正常返回、抛错，
// 还是被 .return() 取消，都会执行
} finally {
  // 只有自己创建的追踪才结束它 —— 子 Agent 的追踪归父级所有
  if (ownsTrace) {
    const isAborted =
      terminal?.reason === 'aborted_streaming' ||
      terminal?.reason === 'aborted_tools'
    endTrace(langfuseTrace, undefined, isAborted ? 'interrupted' : undefined)
    // 主动 flush，否则 SpanImpl 会攥着几百 KB 的序列化对话历史
    // 直到批处理定时器（默认 10 秒）触发
    await flushLangfuse()
  }

  // 切断闭包链：toolUseContext 捕获了 langfuseTrace，
  // 后者持有 SpanImpl → otperformance（那个 571MB 的 Performance 对象）
  if (paramsWithTrace !== params) {
    paramsWithTrace.toolUseContext.langfuseTrace = null
    paramsWithTrace.toolUseContext.langfuseRootTrace = null
    paramsWithTrace.toolUseContext.langfuseBatchSpan = null
  }

  // 清理 JavaScriptCore 的原生 Performance 缓冲区。
  // OpenTelemetry 引用 globalThis.performance，标记存在一个永不收缩的 C++ Vector 里
  const gPerf = globalThis.performance
  if (gPerf && typeof gPerf.clearMarks === 'function') {
    try {
      gPerf.clearMarks()
      gPerf.clearMeasures?.()
      gPerf.clearResourceTimings?.()
    } catch { /* 非关键路径，部分环境不支持全部方法 */ }
  }
}
```

这段代码解释了为什么不能把清理挪进 `queryLoop()` 的循环顶部：追踪必须包住整个轮次（含派生出去的子 Agent），挪到 `while` 顶部就变成"每轮重复创建"，父子层级立刻散架。

无状态设计带来的直接收益是可重入。同一个进程里 `query()` 要能被独立调用很多次——子 Agent 派生、同一会话的多个轮次、测试夹具并行——各份调用不能共享内存状态。

三类调用方的持久化形态也完全不同：REPL 用 React 应用状态，SDK 用会话记录文件，Agent 客户端协议（ACP）用 WebSocket 客户端状态。`query()` 内部绑死任何一种，其他两种就失能了。

### 2.3 `QueryEngine`：把 `queryLoop()` 接到 SDK

`queryLoop()` 只处理一次 Agent 循环。SDK 和 `-p` 调用方还需要会话状态、输入处理、消息持久化和协议输出。`QueryEngine` 就负责这一层适配。

`QueryEngine` 对应一个会话。一次 `submitMessage()` 对应用户发起的一次新请求；同一个实例可以连续调用多次，跨请求保存以下状态：

```typescript
// src/QueryEngine.ts，QueryEngine 的核心会话状态
private mutableMessages: Message[]       // 跨 submitMessage() 保存的消息
private abortController: AbortController // 当前会话的取消控制器
private permissionDenials: SDKPermissionDenial[] // 当前请求的权限拒绝记录
private totalUsage: NonNullableUsage     // 会话累计用量
private readFileState: FileStateCache    // 会话级文件读取缓存
private discoveredSkillNames = new Set<string>() // 当前请求发现过的 Skill
```

其中：

- `mutableMessages`、`abortController`、`totalUsage` 和 `readFileState` 跨请求保留。
- `permissionDenials` 和 `discoveredSkillNames` 在每次 `submitMessage()` 开始时清空。

一次 `submitMessage()` 的数据流如下：

```text
SDK / -p 调用方
      │
      ▼
submitMessage(prompt)
      │
      ├─ 处理用户输入和斜杠命令
      ├─ 构造 QueryParams
      ├─ 调用 query()
      │    └─ queryLoop() 执行 Agent 主循环
      ├─ 消费 query() 输出的内部消息
      ├─ 更新 mutableMessages 和会话记录
      ├─ 把内部消息转换成 SDKMessage
      └─ 产出 result 终态
```

`QueryEngine` 的职责可以按数据流分成六类：

| 职责 | 关键方法或字段 | 作用 |
|---|---|---|
| 1. 保存会话状态 | `mutableMessages`、`readFileState`、`totalUsage` | 让下一次 `submitMessage()` 继续使用之前的消息、缓存和用量 |
| 2. 处理用户输入 | `processUserInput()`、`processUserInputContext` | 处理普通 prompt、斜杠命令、附件和允许使用的工具 |
| 3. 调用并消费循环 | `query()`、`for await (const message of query(...))` | 启动 Agent 循环，逐个接收 assistant、tool、附件和流事件 |
| 4. 持久化会话 | `recordTranscript()`、`flushSessionStorage()` | 把消息写入会话记录，支持恢复和继续执行 |
| 5. 转换外部协议 | `normalizeMessage()`、`api_retry`、`result` | 把内部消息转换为 SDK 客户端能解析的 `SDKMessage` |
| 6. 维护请求附加状态 | `wrappedCanUseTool()`、文件快照、压缩边界清理 | 记录权限拒绝、支持 `/rewind`，并释放压缩前的旧消息 |

### 2.4 消息消费：QueryEngine 如何处理 queryLoop 的输出

`query()` 返回的是内部消息流。`QueryEngine.submitMessage()` 通过 `for await` 消费它，再根据消息类型分发：

```typescript
// src/QueryEngine.ts，submitMessage()：消费 query() 的内部消息流
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  querySource: 'sdk',
})) {
  switch (message.type) {
    case 'assistant':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break
    case 'user':
      this.mutableMessages.push(message)
      yield* normalizeMessage(message)
      break
    case 'stream_event':
      // 按 SDK 配置决定是否向外暴露增量事件
      break
    case 'system':
      // 处理 compact_boundary、api_retry 等控制消息
      break
  }
}
```

这段分发代码解释了 `QueryEngine` 和 `queryLoop()` 的边界：

- `queryLoop()` 决定循环是否继续、调用哪个工具、何时终止。
- `QueryEngine` 决定这些内部结果如何保存、转换和发送给 SDK。

### 2.5 压缩边界：为什么要清理 `mutableMessages`

压缩完成后，`queryLoop()` 会产出 `compact_boundary`。边界之前的消息已经被摘要替代，后续请求只需要保留边界及其后的消息。`QueryEngine` 收到边界后清理旧数组：

```typescript
// src/QueryEngine.ts，submitMessage()：收到 compact_boundary 后释放旧消息
if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
  // 边界消息刚刚加入数组，位于数组末尾。
  const mutableBoundaryIdx = this.mutableMessages.length - 1
  if (mutableBoundaryIdx > 0) {
    this.mutableMessages.splice(0, mutableBoundaryIdx)
  }
}
```

这个动作同时解决两个问题：

1. 下一次请求不会重复发送已经压缩过的历史。
2. 长会话可以释放压缩前的消息对象，避免 `mutableMessages` 无限增长。

REPL 直接使用 React 应用状态和自己的消息记录逻辑，所以不经过 `QueryEngine`。SDK 和 `-p` 需要 `QueryEngine` 提供这层会话与协议适配。

### 2.6 调用链时序

```text
调用方                 QueryEngine                query() / queryLoop()
──────                 ───────────                ─────────────────────
 │ submitMessage(prompt)     │                            │
 ├──────────────────────────►│                            │
 │                           │ 1. 处理用户输入             │
 │                           │ 2. 拼系统提示词             │
 │                           │ 3. recordTranscript()      │
 │                           │ 4. yield 初始化消息         │
 │ ◄─ {type:'system'} ───────┤                            │
 │                           │ 5. for await (query(...))  │
 │                           ├───────────────────────────►│
 │                           │   ┌─ query() 入口 ────────┐ │
 │                           │   │ 创建或复用追踪         │ │
 │                           │   │ try { yield* queryLoop│ │
 │                           │   │   ① 上下文准备        │ │
 │ ◄─ {type:'assistant'} ────┤◄──│   ② API 调用          │ │
 │                           │   │   ③ 判断去向          │ │
 │ ◄─ {type:'user'} ─────────┤◄──│   ④ 工具执行          │ │
 │                           │   │   ⑤ 下一轮准备        │ │
 │                           │   │ } finally { 清理追踪 } │ │
 │                           │   └─ 返回 Terminal ───────┘ │
 │                           │ 7. Terminal → 协议终态      │
 │ ◄─ {type:'result',        │                            │
 │     subtype:'success'} ───┤                            │
```

步骤 1 到 4 在 `query()` 启动前完成，步骤 5 之后进入稳态逐迭代，步骤 7 收敛。三层是因为模型调用的工程闭环刚好三类问题——循环本身、单次循环的生命周期、跨循环的会话——多一层就是冗余。

---

## 三、状态机底座：十个字段与全量替换

### 3.1 不可变参数与可变状态分离

进 `queryLoop` 之前，状态机底座一次性构造完毕。所有数据被两类声明管理：

```typescript
// src/query.ts，queryLoop()：不可变参数，整个循环期间不会被重新赋值
const {
  systemPrompt, userContext, systemContext, canUseTool,
  fallbackModel, querySource, maxTurns, skipCacheWrite,
} = params
```

读这一千六百行代码时，**看到 `const` 就知道这个值永远不会变，看到 `state.xxx` 就知道这值可能被本轮改掉**。把两者混在一起会导致"会话级配置被某一轮的模型决策污染"。

### 3.2 十个字段各对接一个组件

```typescript
// src/query.ts，State：跨迭代携带的可变状态
type State = {
  messages: Message[]                      // 对话历史，每轮追加 assistant + tool_result
  toolUseContext: ToolUseContext           // 工具上下文，工具执行后可能被更新
  autoCompactTracking: AutoCompactTrackingState | undefined  // 压缩追踪
  maxOutputTokensRecoveryCount: number     // 输出截断的恢复计数，上限 3
  hasAttemptedReactiveCompact: boolean     // 本轮是否已尝试过反应式压缩（守卫字段）
  maxOutputTokensOverride: number | undefined  // 输出上限的覆盖值，8K → 64K
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined  // 工具摘要
  stopHookActive: boolean | undefined      // 停止钩子是否阻塞了退出
  turnCount: number                        // 轮次，每轮加一
  // 源码注释原文：Why the previous iteration continued. Undefined on first
  // iteration. Lets tests assert recovery paths fired without inspecting
  // message contents.
  // —— 记录上一轮为什么继续。第一轮为 undefined。
  //    让测试能直接断言"某条恢复路径确实触发过"，不用去翻消息内容。
  transition: Continue | undefined         // 上一次继续的原因，供审计与测试断言
}
```

`transition` 的源码注释点明了它的真实用途：让测试断言“恢复路径确实触发了”，不用翻消息内容。这个字段用于状态机观测，不负责日志存储。

### 3.3 `State.toolUseContext`：状态机携带的运行时上下文

`State` 中的 `toolUseContext` 字段类型是 `ToolUseContext`。类型定义位于 `src/Tool.ts`：

```typescript
// src/Tool.ts，ToolUseContext 的类型声明
export type ToolUseContext = {
  options: {
    tools: Tools
    mainLoopModel: string
    mcpClients: MCPServerConnection[]
    thinkingConfig: ThinkingConfig
    // 还包括命令、Agent 定义、提示词选项等配置
  }
  abortController: AbortController
  readFileState: FileStateCache
  getAppState(): AppState
  setAppState(update: (prev: AppState) => AppState): void
  messages: Message[]
  agentId?: AgentId
  queryTracking?: QueryChainTracking
  // 还包括界面回调、记忆去重、追踪等运行时字段
}
```

`export type` 只在 TypeScript 编译阶段约束对象结构。运行时传入的是一个普通对象，`query()` 和 `queryLoop()` 通过 `toolUseContext` 读取这次 Agent 运行所需的依赖。

| 作用 | 典型字段 | 具体用途 |
|---|---|---|
| 能力配置 | `options.tools`、`options.mainLoopModel`、`options.mcpClients` | 决定当前 Agent 能调用哪些工具、使用哪个模型、连接哪些 MCP 服务 |
| 生命周期控制 | `abortController` | 用户按下 Ctrl+C 或上层取消时，停止模型请求和工具执行 |
| 应用状态 | `getAppState()`、`setAppState()`、`addNotification()` | 读取或更新 REPL、任务和通知状态 |
| 文件与消息 | `readFileState`、`messages`、`contentReplacementState` | 复用文件读取缓存、携带当前消息、控制工具结果替换 |
| Agent 身份与观测 | `agentId`、`agentType`、`queryTracking`、`langfuseTrace` | 区分主 Agent 和子 Agent，串起调用链和追踪信息 |
| 会话内辅助状态 | `loadedNestedMemoryPaths`、`discoveredSkillNames`、`toolDecisions` | 记录记忆、Skill 和权限决策，避免同一会话重复处理 |

`canUseTool()` 位于 `QueryParams`，负责权限判断；`ToolUseContext` 提供权限判断需要的工具、状态、回调和运行环境。

`ToolUseContext` 在状态机中的流转过程如下：

1. **调用方创建**：REPL、SDK 或 `QueryEngine` 准备工具、模型、MCP 客户端和应用状态回调。
2. **`query()` 补充追踪**：顶层调用创建 Langfuse trace，子 Agent 复用父级 trace。实现上通过对象浅拷贝补充追踪字段。
3. **`queryLoop()` 使用**：上下文准备、模型调用、权限判断和工具执行都读取它。
4. **工具执行更新**：工具可能返回新的上下文，或者刷新 MCP 工具列表。
5. **下一轮继续传递**：更新后的对象写回 `State.toolUseContext`，同时补充新的 `queryTracking`。

关键代码是对象浅拷贝和字段覆写：

```typescript
// src/query.ts，queryLoop()：补充当前调用链信息
toolUseContext = {
  ...toolUseContext,
  queryTracking,
}

// 工具执行返回新上下文时，使用更新后的对象
if (update.newContext) {
  updatedToolUseContext = {
    ...update.newContext,
    queryTracking,
  }
}
```

子 Agent 会基于父 Agent 的上下文创建自己的上下文，再替换 `agentId`、工具集合、模型、追踪信息或部分状态回调。这样多个 Agent 可以复用同一套 `queryLoop()`，同时保持各自的运行边界。

### 3.4 全量替换契约

状态永不原地修改。每次 `continue` 之前都构造一个全新对象，十个字段全部重写：

```typescript
// src/query.ts，queryLoop() 的源码注释：
// Continue sites write `state = { ... }` instead of 9 separate assignments.
// —— 每个继续点写一次 `state = { ... }`，集中更新全部状态字段。

// 反面：局部修改
state.messages = newMessages
state.turnCount++
// 漏改一个字段就是 bug，而且是代码审查看不出来的 bug

// 正面：全量替换，以 2043-2054 的主线出口为例
const next: State = {
  messages: messagesForQuery.concat(assistantMessages, toolResults),
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
```

全量替换的收益是**强制显式**。写这段代码时开发者必须逐字段回答"本轮它应该是什么"。

某个恢复路径忘了把 `hasAttemptedReactiveCompact` 重置成 `false`，下一次反应式压缩就会跳过本该有的尝试——这种漏写在局部修改的写法里几乎不可见，在全量替换里是代码审查三十秒内能看出来的异味。

`transition` 字段本身也是这个契约的产物：每个继续点都必须带一个新的原因，不允许沿用上一轮的值。

### 3.5 初始化

```typescript
// src/query.ts，queryLoop()：进入 while 之前一次性构造初始状态
let state: State = {
  messages: params.messages,                    // 由调用方传入的接力棒
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,               // 首次压缩失败时才创建追踪
  stopHookActive: undefined,                    // 停止钩子还没被调用，先按无阻塞处理
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,                        // 第一轮没有"上一次转换"
}
```

全部 `undefined` 和零值表示协议起始状态。任何一个字段的默认值改成“乐观假设”，第五节的四条守卫就会被绕过——比如把 `hasAttemptedReactiveCompact` 初始化成 `true`，就会跳过本轮真正需要的压缩。

### 3.6 两个 messages 的生命周期不同

`State.messages` 是 `query()` 单次调用内的内存视图，`queryLoop()` 返回时整体被回收。跨轮累积、`claude --resume` 重放，靠的是 `QueryEngine.mutableMessages`——两次 `submitMessage()` 之间由它浅拷贝一份传给下一次 `query()`。

两个名字相近，生命周期完全不同：循环层只管本轮的内存视图，跨轮一致性由会话适配层和持久化层负责。

---

## 四、一次迭代的五个阶段

```text
┌─────────────────────────────────────────────────────────┐
│ 阶段 1  上下文准备                                       │
│   压缩链路六步 → 消息过滤 → 剥离原始载荷 → 预取启动       │
├─────────────────────────────────────────────────────────┤
│ 阶段 2  API 调用                                         │
│   双层循环：备用模型重试（外层）+ 流式消费（内层）         │
├─────────────────────────────────────────────────────────┤
│ 阶段 3  判断去向                                         │
│   收到 tool_use？→ 阶段 4 ；没收到 → 走恢复与退出判断      │
├─────────────────────────────────────────────────────────┤
│ 阶段 4  工具执行                                         │
│   分批 → 权限 → 钩子 → 执行 → 结果注入                    │
├─────────────────────────────────────────────────────────┤
│ 阶段 5  下一轮准备                                       │
│   消息合并 → 预取收割 → 轮次上限检查 → 构造新状态          │
└─────────────────────────────────────────────────────────┘
```

### 4.1 阶段 1：上下文准备

这一步为 API 调用准备消息列表，跑一条**固定顺序的六步压缩链路**，每步都在前一步的输出上增量处理。顺序不可调换，原因全部写在源码注释里。

| # | 步骤 | 调用点 | 为什么必须排在这个位置 |
|---|---|---|---|
| 1 | 工具结果预算 `applyToolResultBudget` | `queryLoop()` 的上下文准备阶段 | 必须先于微压缩。缓存型微压缩只按 `tool_use_id` 操作、从不读内容，所以内容替换对它不可见，两者能干净叠加 |
| 2 | 截断压缩 `snipCompactIfNeeded` | `queryLoop()` 的压缩分支 | 需要知道第 1 步之后的预算，否则截断释放的 token 会破坏后续阈值判断 |
| 3 | 微压缩 `microcompact` | `queryLoop()` 的消息预处理 | 缓存编辑需要把边界消息推迟到 API 响应之后，用真实的 `cache_deleted_input_tokens` 替代客户端估算 |
| 4 | 上下文折叠 `applyCollapsesIfNeeded` | `queryLoop()` 的自动压缩前置分支 | 排在自动压缩之前。折叠若能把上下文压到阈值以下，昂贵的完整摘要就能省掉，只保留折叠视图 |
| 5 | 自动压缩 `autocompact` | `queryLoop()` 的自动压缩分支 | 把消息折叠成摘要、附件和钩子结果；成功后要在替换前捕获剩余任务预算 |
| 6 | 预测性自动压缩 | `queryLoop()` 的 API 调用前检查 | 仅当前面的自动压缩没有触发时才运行。阈值是有效窗口减去本轮预估增长，提前压缩避免轮次中途撞上超长错误 |

第 1 步和第 2 步的顺序约束在源码注释里说得很清楚：

```typescript
// src/query.ts，queryLoop()：为什么 snipTokensFreed 要一路传给自动压缩
// snipTokensFreed is plumbed to autocompact so its threshold check reflects
// what snip removed; tokenCountWithEstimation alone can't see it (reads usage
// from the protected-tail assistant, which survives snip unchanged).
// —— 截断释放的 token 数要一路传给自动压缩，否则它的阈值判断看不到截断的效果。
//    token 计数函数是从"受保护的尾部 assistant 消息"读用量的，
//    而那条消息在截断中原样存活，所以计数器根本感知不到删了什么。
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}
```

token 计数是从"受保护的尾部 assistant 消息"上读用量的，而那条消息在截断中原样存活，所以计数器根本看不见截断删掉了什么。只能靠一个局部变量把释放量一路传到第 5 步。

除压缩链路外，阶段 1 还做三件事。

**从压缩边界截断**。压缩把旧消息折叠成一条边界标记，但 `state.messages` 仍保留全量历史——界面滚动回溯需要看到全部。发 API 时由 `getMessagesAfterCompactBoundary()` 从边界处截断，否则已压缩的旧消息会被再发一遍，压缩白做。

**剥离原始载荷**。这是全篇最值得看的一段防御性代码：

```typescript
// src/query.ts，queryLoop()：浅拷贝剥离，不能原地删
// IMPORTANT: shallow-copy rather than mutate. messagesForQuery elements
// are references shared with mutableMessages (UI state); deleting
// toolUseResult in place strips it from the live message while React may
// still be rendering it. The next query can start within milliseconds of
// tool_result creation (model immediately calls the next tool), before
// the UI commit lands.
// —— 必须浅拷贝，不能原地改。这些元素的引用和界面状态是共享的，
//    原地删会把字段从"正在被 React 渲染的那条消息"上抹掉。
//    模型可能在工具结果产生后几毫秒就发起下一次调用，早于界面提交落地。
messagesForQuery = messagesForQuery.map(msg => {
  if (msg.type !== 'user' || !('toolUseResult' in msg) ||
      msg.toolUseResult === undefined) {
    return msg
  }
  const copy: typeof msg = { ...msg }
  delete (copy as Message & { toolUseResult?: unknown }).toolUseResult
  return copy
})
```

每条 user 消息有两个字段：`message.content` 是接口要的 tool_result 文本，`message.toolUseResult` 是界面渲染用的完整对象（可能是 400KB 的文件缓冲区）。下一轮接口只需要前者。

但**不能原地删**——这些对象的引用和界面状态共享，模型可能在工具结果产生后几毫秒就发起下一次调用，早于界面提交，原地删会让工具结果那一行渲染成空白。

**启动预取**。三类异步副作用任务用“发了就不管”的方式启动，和 API 调用并行跑。记忆预取在进入 `while` 之前启动一次，技能与工具预取在每轮迭代顶部启动。收割时机在本轮工具执行结束、进入下一轮准备时。

### 4.2 阶段 2：API 调用

结构是双层循环：

```text
外层 while (attemptWithFallback)          ← 备用模型重试
  └─► 内层 for await (event of stream)     ← 流式消费
        ├─► content_block_delta (text)     → yield 给界面逐字渲染
        ├─► content_block_delta (json)     → 累积工具调用参数
        ├─► content_block_stop             → 触发下游处理
        └─► message_delta                  → 停止原因 + token 用量
```

**外层处理备用模型切换，且只切一跳**。主模型持续过载时切到备用模型重试一次，备用再失败就报错退出，不在多个模型之间反复横跳。多级切换的收益递减明显：备用也失败通常说明问题是系统性的（密钥无效、账户限流），再多模型也没用。

**内层消费流式响应**。响应是逐 token 到达的。每收到一个文本增量就 yield 给界面，用户看到文字逐字出现；如果增量属于工具调用的 JSON 参数，就先累积，等块结束事件到达时再完整解析。

**九十秒空闲看门狗**。`src/services/api/claude.ts` 的流式请求消费逻辑会在长时间没有事件时主动断开连接，并根据配置切到非流式请求重发。重发时之前的流式内容会被墓碑（tombstone，表示这段内容不再参与后续上下文）的消息标记删除——流式响应的思考块签名不完整，直接追加到后续请求会被 API 拒绝。

**错误扣留**是这一阶段最反直觉的设计。提示词超长和输出截断这两类错误不会立刻 yield 给调用方：

```typescript
// src/query.ts，queryLoop()：为什么要先扣留错误消息
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * Is this a max_output_tokens error message? If so, the streaming loop should
 * withhold it from SDK callers until we know whether the recovery loop can
 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
 * cowork/desktop) that terminate the session on any `error` field — the
 * recovery loop keeps running but nobody is listening.
 *
 * —— 这是输出上限错误吗？是的话流式循环要把它对 SDK 调用方扣留，
 *    直到确认恢复循环能不能继续。提前 yield 会把一个中间态错误漏给
 *    SDK 调用方，而它们看到任何 `error` 字段就终止整个会话——
 *    结果是恢复循环还在跑，但已经没人在听了。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}
```

注释把后果说得很直白：SDK 客户端看到任何带 `error` 字段的消息就终止整个会话，恢复循环还在跑但已经没人在听了。所以修复成功就不告诉调用方，修复失败才把错误浮出来。

**备用模型切换时会丢弃并重建执行器**。两条 fallback 恢复路径都需要做同一件事：

```typescript
// src/query.ts，queryLoop()：切备用模型时必须丢弃在途的工具执行器
assistantMessages.length = 0
toolResults.length = 0
toolUseBlocks.length = 0
needsFollowUp = false

// Discard pending results from the failed attempt and create a
// fresh executor. This prevents orphan tool_results (with old
// tool_use_ids) from leaking into the retry.
// —— 丢弃失败那次尝试的在途结果，新建一个执行器。
//    否则带旧 tool_use_id 的孤儿 tool_result 会泄漏进重试请求。
if (streamingToolExecutor) {
  streamingToolExecutor.discard()
  streamingToolExecutor = new StreamingToolExecutor(
    toolUseContext.options.tools, canUseTool, toolUseContext,
  )
}
```

前一次尝试产生的 tool_result 用的是旧的 `tool_use_id`，重试请求里没有对应的 tool_use 块——这就是"孤儿 tool_result"，会被 API 直接拒收。

紧接着还有一步只对内部用户生效的处理：

```typescript
// src/query.ts，queryLoop()：思考签名与模型绑定
// Thinking signatures are model-bound: replaying a protected-thinking
// block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
// —— 思考签名与模型绑定：把受保护模型产出的思考块重放给不受保护的
//    备用模型，API 直接返回 400。
if (process.env.USER_TYPE === 'ant') {
  messagesForQuery = stripSignatureBlocks(messagesForQuery)
}
```

### 4.3 阶段 3：判断去向

流式消费结束后，循环面对一个分叉：**本轮模型到底有没有返回工具调用块？**

循环使用 `needsFollowUp` 判断是否进入工具执行分支，不依赖 API 返回的停止原因。源码注释在 `needsFollowUp` 的声明处写得很明确：

```typescript
// src/query.ts，queryLoop()：工具调用判定信号
// @see https://docs.claude.com/en/docs/build-with-claude/tool-use
// Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
// Set during streaming whenever a tool_use block arrives — the sole
// loop-exit signal. If false after streaming, we're done (modulo stop-hook retry).
// —— 注意：stop_reason === 'tool_use' 不可靠，它不总是被正确设置。
//    这个标志在流式过程中一旦有 tool_use 块到达就置真，是唯一的循环退出信号。
//    流式结束后仍为假，就说明本轮结束了（除非停止钩子要求重试）。
const toolUseBlocks: ToolUseBlock[] = []
let needsFollowUp = false
```

这个布尔值是整个状态机最关键的信号，其他所有判断都基于它的真假。它在进入一次流式消费时初始化为 `false`，收到工具调用块后置为 `true`，在备用模型切换前清理本次尝试的结果并重置。

```typescript
// src/query.ts，queryLoop()：收到工具调用块后置为 true
if (msgToolUseBlocks.length > 0) {
  toolUseBlocks.push(...msgToolUseBlocks)
  needsFollowUp = true
}
```

**为真**就进阶段 4 执行工具，**为假**就进入 `if (!needsFollowUp)` 分支，开始排查“为什么没收到工具调用”，见第五节。

### 4.4 阶段 4：工具执行

```text
tool_use 块到达
  ├─► findToolByName()      ← 在工具注册表里查实现
  ├─► PreToolUse 钩子        ← 用户定义的拦截逻辑，可拒绝或改写输入
  ├─► 权限检查               ← deny > ask > allow，需审批就弹提示
  ├─► tool.call()           ← 实际执行
  ├─► PostToolUse 钩子       ← 执行后审计或改写结果
  └─► tool_result 注入上下文  ← 下一轮模型看到结果
```

工具执行采用分批策略。分批逻辑在 `toolOrchestration.ts`：

```typescript
// src/services/tools/toolOrchestration.ts，partitionToolCalls()
// 把工具调用切成批次，每批要么是单个非只读工具，要么是多个连续的只读工具
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            // 判定函数自己抛错（比如 shell 引号解析失败）时保守处理，当成不安全
            return false
          }
        })()
      : false
    // 连续的并发安全工具合进上一批，否则另起一批
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })
    }
    return acc
  }, [])
}
```

关键在那个 `catch` 分支：判定函数自己抛异常时一律当作"不安全"。这是分批策略里唯一的容错点，宁可串行慢一点也不能并发跑错。

分批之后的调度是"只读批并发、写批串行"：

| 批类型 | 策略 | 例子 |
|---|---|---|
| 只读批（连续多个并发安全工具） | 并发执行 | Read + Grep + Glob 同时跑 |
| 写批（单个非并发安全工具） | 单独执行，等它完成再继续 | Bash 写文件单独跑 |
| 混合 | 按出现顺序切批 | Read→Read→Write→Read 切成三批 |

权限检查的完整规则链在 [14 权限与安全](../03-tools-extensions-governance/cc-14-permission-security.md)，钩子系统在 [15 钩子拦截](../03-tools-extensions-governance/cc-15-hook-interception.md)。

**流式工具执行**是一条可选路径。开关打开时系统不等整个响应结束才执行工具——收到一个工具调用块就立刻启动。

这样工具执行和模型推理能重叠：模型还在输出最后一个工具调用时，第一个工具可能已经跑完了。细节见 [05 流式输出与渲染](cc-05-streaming-and-rendering.md)。

### 4.5 阶段 5：下一轮准备

1. **合并消息**。本轮的 assistant 消息和 tool_result 消息追加到历史末尾。
2. **收割预取**。阶段 1 启动的三类预取此时大多已完成（典型耗时 250 到 570 毫秒，而模型调用要 2 到 30 秒），收割结果注入成下一轮的附件消息。
3. **刷新 MCP 工具列表**。模型上下文协议（MCP）服务端可能在后台注册了新工具或移除了旧的，刷新后下一轮模型看到的是最新集合。
4. **检查轮次上限**。`turnCount >= maxTurns` 就强制退出。
5. **构造新状态**。全量替换，`transition` 记为 `next_turn`。

```typescript
// src/query.ts，queryLoop()：阶段 5 的收尾
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}

const next: State = {
  messages: messagesForQuery.concat(assistantMessages, toolResults),
  // ... 其余八个字段
  transition: { reason: 'next_turn' },
}
state = next
```

---

## 五、防失控：四层机制

### 5.1 先乐观，再兜底

模型调用失败、提示词太长、输出被截断、钩子报错——这些在 Agent 场景很常见。每次遇到都直接退出，Agent 基本完不成任何超过五步的真实任务。所以循环默认按照“问题可修复”处理：

- 提示词太长 → 压缩（先折叠排空，再反应式压缩）
- 输出截断 → 扩容（输出上限 8K 升到 64K）或续推（注入元消息让模型接着写）
- 钩子报错 → 把错误注入上下文让模型自己修正

只有两类情况会**直接**退出：用户主动中断，以及所有恢复路径都试过仍然失败。

但乐观过头会失控——"修一次失败，失败又触发修复，修复又失败"。所以每条恢复路径重新进入 `while` 顶部之前都有一个守卫，这也是 `state.transition` 字段存在的全部理由。

### 5.2 四条恢复守卫

| # | 守卫 | 挡住的失控重试 |
|---|---|---|
| 1 | 折叠排空每个超长序列**最多触发一次**：判据是 `state.transition?.reason !== 'collapse_drain_retry'` | 失败的排空无限次重新触发排空 |
| 2 | 反应式压缩**每轮最多触发一次**：`hasAttemptedReactiveCompact` | 压缩 → 仍超长 → 报错 → 停止钩子 → 压缩 → … |
| 3 | 输出上限**升级只触发一次**（判据 `maxOutputTokensOverride === undefined`），**续推最多三次**（`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`） | 升级 → 还超 → 又升级 → 又超 |
| 4 | 上一条消息是 API 错误时**跳过停止钩子**，直接返回 `model_error` | 见下面的源码注释 |

第 2 条守卫的必要性有一段完整的事故复盘写在源码里：

```typescript
// src/query.ts，queryLoop()：停止钩子阻塞后为什么要保留压缩守卫
// Preserve the reactive compact guard — if compact already ran and
// couldn't recover from prompt-too-long, retrying after a stop-hook
// blocking error will produce the same result. Resetting to false
// here caused an infinite loop: compact → still too long → error →
// stop hook blocking → compact → … burning thousands of API calls.
// —— 保留反应式压缩的守卫。压缩已经跑过且救不回超长提示词，
//    停止钩子报错之后再重试只会得到同样的结果。
//    这里如果重置成 false 会造成死循环：
//    压缩 → 仍超长 → 报错 → 停止钩子阻塞 → 压缩 → …
//    历史上这个 bug 烧掉过几千次API 调用。
hasAttemptedReactiveCompact,
```

第 4 条守卫叫"死亡螺旋"防御，注释里直接用了这个词：

```typescript
// src/query.ts，queryLoop()：API 错误时跳过停止钩子
// Skip stop hooks when the last message is an API error (rate limit,
// prompt-too-long, auth failure, etc.). The model never produced a
// real response — hooks evaluating it create a death spiral:
// error → hook blocking → retry → error → …
// —— 最后一条消息是API 错误（限流、提示词超长、鉴权失败等）时跳过停止钩子。
//    模型压根没产生有效响应，让钩子去评估它会形成死亡螺旋：
//    报错 → 钩子阻塞 → 重试 → 报错 → …（每轮还会注入更多 token）
if (lastMessage?.isApiErrorMessage) {
  void executeStopFailureHooks(lastMessage, toolUseContext)
  return {
    reason: 'model_error',
    error: lastMessage.error ?? lastMessage.apiError ?? 'api_error',
  }
}
```

模型压根没产生有效响应，让钩子去评估它，每一轮都会注入更多 token，越滚越大。

> 添加新的继续原因时，务必在对应的恢复路径上加守卫。漏一个就是重试失控的入口。

### 5.3 异常分三类处置

第 5.2 节的守卫只服务于"可恢复"那一类。循环内部对异常做了更细的三层分类：

| 类型 | 例子 | 处置 | 理由 |
|---|---|---|---|
| **可恢复** | 提示词超长、输出截断、媒体过大 | **扣留不立刻 yield**，走恢复路径 | SDK 收到中间错误会终止整个会话，扣留到修复失败才浮出 |
| **不可恢复** | 网络失败、4xx/5xx、限流、鉴权失败 | **直接返回 `model_error`**，不重试 | 重试浪费 token，而根因（密钥错、临时限流）调用方更清楚该怎么办 |
| **流式抛异常** | 流式层 throw（属于程序缺陷） | API 循环的 catch 捕获：补齐缺失的 tool_result、yield 错误消息，然后返回 `model_error` | 见下面的注释 |

第三类的处理值得单看，它同时解决了"程序缺陷"和"消息配对"两件事：

```typescript
// src/query.ts，queryLoop()：流式异常时补齐消息并返回错误
// Generally queryModelWithStreaming should not throw errors but instead
// yield them as synthetic assistant messages. However if it does throw
// due to a bug, we may end up in a state where we have already emitted
// a tool_use block but will stop before emitting the tool_result.
// —— 流式函数一般不该抛异常，而应该把错误 yield 成合成的 assistant 消息。
//    但如果因为程序缺陷真抛了，就可能停在"已经吐出 tool_use 块、
//    却还没吐出对应 tool_result"的非法状态上。
yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

// Surface the real error instead of a misleading "[Request interrupted
// by user]" — this path is a model/runtime failure, not a user action.
// —— 浮出真实错误，避免显示"[请求被用户中断]"：
//    当前路径表示模型或运行时故障。
yield createAssistantAPIErrorMessage({ content: errorMessage })
return { reason: 'model_error', error }
```

已经吐出去的 `tool_use` 块必须补齐对应的 `tool_result`，否则消息历史本身就是不合法的，下一轮开始就会被 API 拒收。补齐逻辑由 `yieldMissingToolResultBlocks()` 完成：

```typescript
// src/query.ts，yieldMissingToolResultBlocks()：
// 为每个悬空的 tool_use 补一条错误结果
for (const toolUse of toolUseBlocks) {
  yield createUserMessage({
    content: [{
      type: 'tool_result',
      content: errorMessage,
      is_error: true,
      tool_use_id: toolUse.id,
    }],
    toolUseResult: errorMessage,
    sourceToolAssistantUUID: assistantMessage.uuid,
  })
}
```

**用户主动中断不算异常**。Ctrl+C 由 AbortController 的信号携带，**绕过整条恢复路径**直接走终止——用户意志高于任何自动恢复逻辑。

### 5.4 四层协同

| 层 | 机制 | 触发条件 | 代码锚点 |
|---|---|---|---|
| 第 1 层 硬中断 | 中止信号 → 立即返回 `aborted_streaming` / `aborted_tools` | 用户按 Ctrl+C 或 Esc | `queryLoop()` 的流式消费与工具执行分支 |
| 第 2 层 轮次护栏 | `turnCount >= maxTurns` → 返回 `max_turns` | 阶段 5 末尾检查 | `queryLoop()` 的 `maxTurns` 检查 |
| 第 3 层 决策分叉 | `needsFollowUp` 决定走主线还是恢复线 | 流式消费结束时 | `queryLoop()` 的工具调用分支 |
| 第 4 层 恢复守卫 | 4 条守卫防重试失控 | 恢复路径尝试时 | `transition`、`hasAttemptedReactiveCompact` 和输出恢复计数 |

四层由硬到软、由用户到状态机。以"模型反复调同一个工具"为例，三道闸依次生效：

- **工具能成功** → 第 3 层判定 `needsFollowUp = true`。模型继续调用工具属于正常推进，循环最终在模型自然结束时收敛。
- **工具报错** → tool_result 带 `is_error: true` 反馈给模型自行修正，代码层面由第 2 层的轮次上限兜底。
- **反复触发同一条恢复路径** → 第 4 层的显式计数拦截，超过即强制终止。
- **上面都没拦住** → 第 2 层的轮次上限最终兜底。

四层的设计目标是让状态机及时识别异常行为并停止。核心是把“该不该继续”变成代码可控制的状态：`needsFollowUp`、四条恢复守卫和轮次上限共同承担这个职责。

---

## 六、七种继续与十种终止

所有出口的字面量集中在一个二十行的文件里：

```typescript
// src/query/transitions.ts —— 全文
export type Terminal =
  | { reason: 'completed' }
  | { reason: 'blocking_limit' }
  | { reason: 'image_error' }
  | { reason: 'model_error'; error?: unknown }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'prompt_too_long' }
  | { reason: 'stop_hook_prevented' }
  | { reason: 'hook_stopped' }
  | { reason: 'max_turns'; turnCount: number }

export type Continue =
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }
```

两类转换是对偶关系：一个是再试一次，一个是放弃。七加十覆盖了循环出口的百分之百，缺一个就意味着状态机有静默分支。

注意其中两个原因带额外字段——`collapse_drain_retry` 带 `committed`，`max_output_tokens_recovery` 带 `attempt`。转换记录不只是标签，是带数据的对象。

### 6.1 七种继续原因

| 原因 | 触发场景 | 做了什么调整 | 位置 | 守卫 |
|---|---|---|---|---|
| `next_turn` | 正常进下一轮 | 追加 assistant + tool_result | `queryLoop()` 的正常收尾分支 | 主线，无守卫 |
| `collapse_drain_retry` | 提示词超长 | 执行折叠排空，把压缩掉的部分吐回来 | `queryLoop()` 的提示词超长恢复分支 | `transition?.reason !== 'collapse_drain_retry'` |
| `reactive_compact_retry` | 折叠排空失败 | 触发反应式压缩，更激进 | `queryLoop()` 的反应式压缩分支 | `hasAttemptedReactiveCompact === false` |
| `max_output_tokens_escalate` | 输出被上限截断 | 输出上限升到 `ESCALATED_MAX_TOKENS = 64_000` | `queryLoop()` 的输出恢复分支 | `maxOutputTokensOverride === undefined` |
| `max_output_tokens_recovery` | 升级后仍被截断 | 注入元消息让模型接着写 | `queryLoop()` 的续推分支 | `maxOutputTokensRecoveryCount < 3` |
| `stop_hook_blocking` | 停止钩子返回阻塞错误 | 把错误注入上下文让模型修正 | `queryLoop()` 的停止钩子分支 | 单次调用，无需守卫 |
| `token_budget_continuation` | token 预算超限 | 注入提醒元消息继续（软性检查） | `queryLoop()` 的预算续推分支 | 软性，无守卫 |

第 5 个原因的元消息内容本身就是一段提示词工程：

```typescript
// src/query.ts，queryLoop()：续推时注入的元消息
const recoveryMessage = createUserMessage({
  content:
    `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
    `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
  isMeta: true,
})
```

明确禁止道歉和复述，因为这两样都是在浪费本来就不够用的输出预算。

### 6.2 十种终止原因

| 原因 | 触发场景 | 还能再发新消息？ | 位置 |
|---|---|---|---|
| `completed` | 模型自然结束，无工具调用无错误 | **能** | `queryLoop()` 的自然结束分支 |
| `max_turns` | 轮次达到上限 | 否 | `queryLoop()` 的 `maxTurns` 检查 |
| `aborted_streaming` | 流式接收阶段按 Ctrl+C | 否 | `queryLoop()` 的流式中断分支 |
| `aborted_tools` | 工具执行阶段按 Ctrl+C | 否 | `queryLoop()` 的工具中断分支 |
| `stop_hook_prevented` | 无工具调用且停止钩子拒绝退出 | 否 | `queryLoop()` 的停止钩子分支 |
| `hook_stopped` | 工具执行阶段某钩子要求终止 | 否 | `queryLoop()` 的工具钩子分支 |
| `prompt_too_long` | 折叠排空与反应式压缩都失败 | 否 | `queryLoop()` 的提示词超长恢复分支 |
| `blocking_limit` | 自动压缩关闭时 token 达硬上限，发 API 前预防性阻断 | 否 | `queryLoop()` 的上下文预算检查 |
| `image_error` | 图片尺寸或缩放错误，或被扣留的媒体无法恢复 | 否 | `queryLoop()` 的媒体错误分支 |
| `model_error` | 流式抛异常，或最后一条消息是 API 错误 | 否 | `queryLoop()` 的模型错误分支 |

三个边界需要区分。

**返回 `Terminal` 不等于进程退出。** `completed` 只表示本轮对话自然结束，REPL 还在跑，用户随时能发下一条消息启动新一轮。其余九个才是"本轮异常终止"。

**`stop_hook_prevented` 与 `hook_stopped` 是两个不同的退出点。** 前者发生在没有工具调用时，停止钩子评估后拒绝退出；后者发生在有工具调用时，工具执行阶段某个钩子要求终止。前者是上下文层的失败，后者是工具层的失败，跨层的语义不能合并。

**`blocking_limit` 只在自动压缩关闭时生效。** `queryLoop()` 的上下文预算检查把它限定在自动压缩关闭的场景，用于给手动 `/compact` 预留空间。

---

## 七、消息拼装：配对约束与三道闸

阶段 2 到 4 完成一轮“推理 → 行动 → 观察”，阶段 5 构造新状态，下一轮从阶段 1 重新开始。工具结果的处理策略是**基本全量传递，再通过三道闸控制总规模**。

**第一道闸：单条消息剥离原始载荷**（已在 4.1 展开）。界面字段不进模型提示词，剥离后 `content` 字符串本身仍然全量传。

**第二道闸：单条消息的预算控制**。`applyToolResultBudget()` 检查每条消息内 `tool_result` 的总大小，超过上限时把最大的那个结果落盘，内容替换成一段预览：`Output too large (...). Full output saved to: <路径>` 加前若干字节。

这是"单条消息"级的硬上限——单个工具结果再大也撑不爆一条消息。

**第三道闸：整个会话的压缩栈**（阶段 1 的六步链路）。累积消息超限时把旧消息折叠成摘要，这是"整个会话"级的硬上限。

三道闸分属不同组件，本篇只讲循环层这一段，完整的协同见 [08 压缩子系统](cc-08-compaction-subsystem.md)。

### 7.1 配对的三个必需字段

用的是 Messages API 规定的原生格式，每一轮 tool_use 由一条对应的 tool_result 消息配对：

```typescript
yield createUserMessage({
  content: [{
    type: 'tool_result',           // API 协议规定的块类型
    content: errorMessage,         // 工具返回的字符串结果
    is_error: true,                // 或 false
    tool_use_id: toolUse.id,       // 必须与上一轮某个 tool_use 块的 id 完全匹配
  }],
  toolUseResult: errorMessage,     // 同一份结果，界面渲染用
  sourceToolAssistantUUID: assistantMessage.uuid,
})
```

三个字段缺一不可，其中 `tool_use_id` 的约束最硬：API 用它做配对，**不允许交错也不允许缺失**。`queryLoop()` 在构造下一轮消息时会检查并补齐悬空的工具结果，避免孤儿 `tool_result` 进入 API 请求。

### 7.2 每轮请求长什么样

请求由两部分组成。**系统字段**由 `appendSystemContext()` 和 `asSystemPrompt()` 组合：

```typescript
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

基础系统提示词（人格、工具列表、运行环境）加上运行时上下文（工作目录、日期、版本控制状态等键值对）。整段每轮重新构造，但**前面绝大部分内容每轮字节级不变**——这正是提示词缓存能命中的前提，详见 [06 上下文装配](cc-06-context-assembly.md)。

**消息数组**由 `messagesForQuery.concat(assistantMessages, toolResults)` 拼接，顺序是“先历史 → 再本轮 assistant → 再本轮 tool_result”。这是 API 的强制要求：`tool_use` 块必须在 `tool_result` 之前。

一个完整的推理—行动—观察循环在请求里长这样：

```text
[system]                                    ← 系统提示词
[user] 帮我看看项目结构                      ← 用户输入
[assistant] 调用 Glob(**/*.ts)              ← 第 1 轮
[user] tool_result: ["src/a.ts", ...]       ← 第 1 轮观察
[assistant] 调用 Read(src/a.ts)             ← 第 2 轮
[user] tool_result: "import ..."            ← 第 2 轮观察
[assistant] 调用 Bash(npm test)             ← 第 3 轮
[user] tool_result: "Tests passed: 12"      ← 第 3 轮观察
[assistant] "已查看 src/a.ts，所有测试通过"   ← 第 4 轮，无工具调用，自然结束
```

模型每一轮看到的是截至当前的完整观察历史加上自己的全部历史决策——推理与行动的轨迹完整保留，这就是这套循环模式的核心。

---

## 八、外部功能挂在循环的哪个节点

循环的每个关键节点都留了接口。下表按节点归类整个系列的其余篇目：

| 节点 | 挂在这里的子系统 |
|---|---|
| ① 上下文准备 | [06 上下文装配](cc-06-context-assembly.md)、[07 附件上下文总线](cc-07-attachment-context-bus.md)、[08 压缩子系统](cc-08-compaction-subsystem.md) |
| ② API 调用 | [05 流式输出与渲染](cc-05-streaming-and-rendering.md)、[09 推理与思维链](cc-09-reasoning-and-cot.md) |
| ③ 判断去向 | 停止钩子评估（[15 钩子拦截](../03-tools-extensions-governance/cc-15-hook-interception.md)） |
| ④ 工具执行 | [10 工具执行管线](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)、[13 MCP 集成](../03-tools-extensions-governance/cc-13-mcp-integration.md)、[14 权限与安全](../03-tools-extensions-governance/cc-14-permission-security.md)、[15 钩子拦截](../03-tools-extensions-governance/cc-15-hook-interception.md)、[16 人在环路](../03-tools-extensions-governance/cc-16-human-in-the-loop.md)、[17 子 Agent 隔离](../04-multi-agent-collaboration/cc-17-subagent-isolation.md)、[18 计划模式](../04-multi-agent-collaboration/cc-18-plan-mode-deep-dive.md) |
| ⑤ 下一轮准备 | 预取收割、MCP 工具刷新、[23 定时任务](../05-async-orchestration/cc-23-scheduled-tasks.md) |

三个位置的挂载方式和其他不同，值得单独说：

- **[18 计划模式](../04-multi-agent-collaboration/cc-18-plan-mode-deep-dive.md)** 是跨轮约束。进入计划模式后，循环行为被限制在“按计划执行”的范围内，约束独立于单个节点的钩子。
- **[17 子 Agent 隔离](../04-multi-agent-collaboration/cc-17-subagent-isolation.md)** 从循环中派生出独立的 `queryLoop`，有自己的上下文和轮次上限，靠覆写 `toolUseContext` 换掉工具白名单。
- **[16 人在环路](../03-tools-extensions-governance/cc-16-human-in-the-loop.md)** 让循环在权限检查处暂停，等用户决策（允许 / 拒绝 / 永久允许）。

### 复杂度都花在哪

把 `query.ts` 的复杂度按"防御机制"与"业务功能"两类拆开：

| 类别 | 大致占比 | 归属 |
|---|---|---|
| 核心 while 骨架 + 十字段状态 | ~7% | 业务：循环本身 |
| `needsFollowUp` 流式判定 | ~2% | 防御：停止原因不可靠 |
| 七种继续原因及其调用点 | ~5% | 防御：失败恢复路径 |
| 十种终止原因 | ~12% | 防御：放弃路径 |
| 输出上限升级与三次续推 | ~6% | 防御：截断自动恢复 |
| 反应式压缩重试 | ~3% | 防御：压缩失败回滚 |
| 流式工具执行器并发 | ~8% | 防御 + 性能：工具分批并发 |
| 六步压缩链路的嵌入 | ~22% | 防御：上下文爆炸 |
| QueryEngine 会话适配 | ~10% | 业务：多入口复用 |
| 配置与遥测调用 | ~25% | 业务：观测 + 配置 |

防御类合计约 38%。工具管线、权限、钩子这些业务复杂度通过 API 边界甩到了循环外面，`query.ts` 本身只专注状态机与流转控制。

---

## 读完后你应该能判断什么

- **判定该改哪一层**：轮次推进逻辑改 `queryLoop()`；资源释放改 `query()` 的 finally；调用方协议适配改 `QueryEngine`。三层的判据是"这件事跨不跨调用方"。
- **判定新状态字段放哪**：跨迭代要读的放进 `State` 十字段（且所有继续点都要显式赋值）；只在一次迭代内用的放局部变量（`taskBudgetRemaining` 就是这么处理的，源码注释写明"避免动七个继续点"）。
- **判定新恢复路径要不要守卫**：只要它会 `continue` 回 while 顶部，就必须有守卫。判据是问一句"这条路径失败后会不会再次触发它自己"。
- **定位循环不退出的问题**：先看 `state.transition.reason` 是什么——七种继续里哪一种在反复出现，就是哪条恢复路径的守卫失效了。
- **定位 API 拒收消息的问题**：查 `tool_use_id` 配对。孤儿 tool_result 通常来自备用模型切换时没有丢弃在途执行器；交错通常来自在工具结果之间插了普通 user 消息。
- **判定该看哪篇后续文档**：按第八节的节点表反查——现象出现在哪个阶段，就读挂在那个阶段的子系统文档。
