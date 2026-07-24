---
description: Agent 主循环不是简单 while True，而是带中断恢复、流式渲染、工具并发调度和上下文压缩的有状态循环。本篇拆它的状态机、continue/terminal 退出原因、ReAct 闭环与五层慢思考如何叠加。
---

# Agent 主循环引擎

> **本章目标**：理解 Agent 循环的完整运转机制——它如何从"一问一答"升级为"多轮自主执行"，状态机如何驱动每一次迭代，ReAct + CoT 思维链如何在每轮保留、跨轮累积，以及权限、Hook、子 Agent、计划模式等后续功能在循环的哪个节点嵌入。
>
> **读完本章你应该能回答**：
> - 为什么用 `while(true)` + 全量 state 替换，而不是递归或局部 mutate？
> - State 对象 9 个字段长什么样？`transition` 的 7 种取值分别代表什么？
> - 一次循环迭代经历哪几个阶段？每个阶段做了什么？阶段 1 的 prefetch 是什么、为什么能"零等待"？
> - 什么情况循环会"继续"（continue），什么情况会"退出"（return）？7 种 continue reason 和 6 种 terminal reason 如何协作？
> - ReAct 闭环下观察结果怎么传给下一轮、messages 数组怎么拼装？
> - Fallback 模型切换、流式中断恢复、prompt-too-long 重试分别在哪发生？
> - 5 层"慢思考"机制（effort / ultrathink / ultraplan / verification / Plan-Explore）怎么叠加？
> - 权限审批、Hook、子 Agent、计划模式在循环的哪个节点插入？
>
> **配套阅读**：[07-context-assembly](cc-07-context-assembly.md) 详细讲解 system prompt 的静态段 / 动态段 / 缓存边界，以及完整 prompt 文本 + 设计技巧分析 + ReAct + CoT 思维链设计。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 循环要解决的核心问题 | 必读，建立问题意识 |
| 二 | 循环在架构中的位置、AsyncGenerator 简介 | 必读，建立全局坐标 |
| 三 | 整体结构：query/queryLoop 两层、状态管理契约概览、QueryEngine | 必读，理解循环的骨架 |
| 四 | 状态机：State 对象结构 → 数据分类 → 全量替换契约 → 完整流转图 → 正常/异常两条路径 → continue/terminal 原因 | **核心章节**，先看骨架再看细节 |
| 五 | 单轮各阶段详解：上下文准备（含 prefetch 启动）→ API 调用 → 工具执行 → 下一轮准备（含 prefetch 收割）→ ReAct 闭环（观察结果 + messages 组装）→ 5 层慢思考机制 | 在第四章骨架基础上填细节。**system prompt 构造 + CoT 设计详见 [07-context-assembly](cc-07-context-assembly.md)** |
| 六 | 全局视角：后续功能如何嵌入循环 | 建立与后续文档的关联 |
| 七 | 设计决策与权衡 | 理解为什么这样设计 |
| 八 | 可复用的模式 | 提炼可迁移的设计模式 |


---

## 一、它在解决什么问题

单次 LLM 调用只能完成"一问一答"。但真实编程任务需要多步操作：读文件 → 理解代码 → 搜索相关模块 → 修改 → 运行测试 → 根据测试结果调整。每一步的产出是下一步的输入，形成一个"推理-行动-观察-再推理"的循环。

Agent 循环把这个多步过程自动化了。它的核心逻辑很简单：

```
用户输入 → LLM 推理 → 需要执行工具？→ 执行 → 结果反馈给 LLM → 继续推理 → ... → 输出最终回答
```

但简单逻辑背后有六个必须解决的工程问题：

1. **循环不会自己停下来。** LLM 可能反复调用同一工具、在多个方案间来回摇摆、或者陷入"再检查一遍"的死循环。需要一个多层退出机制——从紧急（用户按 Ctrl+C）到自然（LLM 说"完成了"）。

2. **上下文窗口是有限的。** 每轮对话都在消耗 token 预算。当累积的消息超过窗口限制时，必须在循环内部触发压缩——把旧消息折叠成摘要，为新消息腾空间。压缩本身也要消耗 token，所以需要判断"现在压缩值不值得"。

3. **工具执行不能简单串行或全并发。** 读文件可以并行（互不影响），但写文件和后续读文件有依赖关系（先写后读，顺序错了结果全错）。需要一个分批策略：把互不影响的工具放一批并发执行，有依赖的拆到不同批次串行执行。

4. **LLM 调用可能失败。** 网络抖动、模型过载、token 超限——失败原因多种多样。有些需要重试同一模型，有些需要切换到备用模型，有些（如 prompt 太长）需要触发压缩后再重试。

5. **循环不是孤立的。** 权限审批要在工具执行前拦截，Hook 要在关键节点注入逻辑，子 Agent 要从循环中 fork 出去独立运行，计划模式要约束循环的行为范围。循环需要在这些"外部参与者"之间留好接口。

6. **状态的可观测性 + ReAct 思维链保留。** 几千行的循环里，状态变更必须可审计——5 轮前某次修改了 `state.toolUseContext` 是谁改的、为什么改？同时，LLM 的推理痕迹（`<thinking>` block + 文字声明）必须跨 turn 保留，否则失败恢复路径（`max_output_tokens_recovery` / `stop_hook_blocking`）就失效。

---

## 二、它放在架构的哪个位置

Agent 循环是系统的中枢——所有其他模块都围绕它运转：

```
上下文层                              API 层
  │ 准备 system prompt + messages       │ 发送请求、接收流式响应
  │                                    │
  ▼                                    ▼
┌──────────────────────────────────────────┐
│              Agent 循环                   │
│                                          │
│   while (true) {                         │
│     ① 组装上下文 → ② 调用 LLM →           │
│     ③ 有 tool_use？→ ④ 执行工具 →         │
│     ⑤ 结果注入 → 回到 ①                   │
│   }                                      │
│                                          │
│   退出条件：LLM 自然结束 / maxTurns /      │
│            用户中断 / Token 预算耗尽        │
└──────────────────────────────────────────┘
  │                                    │
  ▼                                    ▼
工具层                              基础设施层
  │ 执行工具、权限检查                   │ 持久化 transcript
  │                                    │
  ▼                                    ▼
Hook 系统                            持久化层
  在 ②③④ 的关键节点拦截
```

循环对外只暴露一个核心接口：`query()` 函数（`src/query.ts:276`），返回 `AsyncGenerator`。调用方（REPL 的 `onQuery` 回调、SDK 的 `ask()` 入口）通过 `for await` 消费它 yield 出来的每一条消息——文本增量、工具调用、工具结果、错误信息。（SDK 路径在外层还有 `QueryEngine` 包装，详见 3.4 节。）

（文档中涉及的 AsyncGenerator、async/await 概念，跨语言对照见正文。）

---

## 三、循环的整体结构

### 3.1 两层结构：query() 生命周期外壳 + queryLoop() 循环内核

代码中有两个函数，但不是"两个循环"——是一个循环加上包裹它的生命周期管理层：

**`query()`（`src/query.ts:276`）** — 生命周期外壳，约 120 行。它不参与循环逻辑，只负责循环的"之前"和"之后"：

```
query() 的职责：
  循环之前：创建 Langfuse trace（可观测性追踪）
  循环之中：yield* queryLoop(...)  ← 把所有 yield 透传给调用方
  循环之后（finally 块）：
    - 结束 Langfuse trace
    - 清理 JSC performance 缓冲区（C++ Vector 永不缩容，长会话会 OOM）
    - 置空 trace 引用（释放 SpanImpl 持有的 571MB Performance 对象，让 GC 回收）
    - 通知命令生命周期（标记 consumed commands 为 completed）
```

`yield*` 是关键——它把 `queryLoop` 的所有 yield 逐条透传给调用方。调用方感知不到中间有一层包装。

**`queryLoop()`（`src/query.ts:393`）** — 真正的循环引擎。包含 `while (true)` 状态机，约 1600 行。所有核心逻辑都在这里：上下文准备、API 调用、工具执行、压缩触发、退出判断。

**为什么分开？** 三个原因：

1. **生命周期与循环逻辑解耦。** trace 创建/销毁、内存清理、命令通知——这些是一次 query 级别的生命周期事件，与"每轮做什么"无关。放在外层，`queryLoop` 不需要知道 Langfuse 或 JSC GC 的存在。

2. **子 Agent 复用。** 当 AgentTool fork 子 Agent 时，子 Agent 也需要跑 `queryLoop`，但 trace 应该挂在父 Agent 的 trace 下面（不是独立创建）。外层 `query()` 检查 `params.toolUseContext.langfuseTrace` 是否已存在——存在就复用，不存在才创建。

3. **finally 保证清理。** `yield*` 配合 try/finally，无论 `queryLoop` 是正常 return、throw 还是被外部 `.return()` 取消，finally 块都会执行——trace 一定被关闭、引用一定被清空。如果把这些清理逻辑塞进 `queryLoop` 的 while 循环里，反而容易遗漏。

```
query()                          ← 生命周期外壳（trace 创建/销毁、内存清理）
  │                                yield* 透传所有消息给调用方
  └─► queryLoop()                ← 真正的循环引擎（while(true) 状态机）
        │
        ├─► 上下文准备             ← 压缩栈、消息过滤
        ├─► API 调用               ← fallback 重试 + 流式消费
        ├─► 工具执行               ← 分批并行 + 权限检查
        ├─► 退出判断               ← 7 种 continue reason + 6 种退出条件
        └─► 下一轮准备             ← 消息合并、prefetch 收割
```

### 3.2 QueryEngine：SDK 路径的外层编排

`QueryEngine`（`src/QueryEngine.ts`）不是循环的第三层，而是给 SDK / headless 路径用的可选包装。REPL 路径不走它——REPL 直接消费 `query()` 的 AsyncGenerator。

它提供的能力都是"循环本身不需要但外部消费者需要"的：

**文件历史快照。** 每次 `submitMessage` 入口处，`fileHistoryMakeSnapshot()` 记录当前被跟踪文件的状态，后续 `/rewind` 命令可以回滚。

**压缩边界 GC。** 当循环 yield `compact_boundary` 时，QueryEngine 执行 `mutableMessages.splice(0, idx)` 释放压缩点之前的旧消息。循环只负责决策"什么时候压缩"，QueryEngine 负责"压缩后释放内存"。

**SDK 消息包装。** 循环 yield 的是内部消息格式，QueryEngine 包装成 SDK 格式（添加 replay、compact metadata）。

**跨 submitMessage 状态。** `mutableMessages`、`abortController`、`totalUsage` 在多次 `submitMessage` 调用间持久存在。`queryLoop` 内部的 `state` 只在单次 query 周期内有效。

三层包装的完整关系：

```
SDK / headless 调用方
  │
  ▼
QueryEngine.submitMessage()    ← SDK 包装、文件快照、压缩 GC
  │
  ▼
query()                         ← 生命周期外壳（trace 创建/销毁、内存清理）
  │
  ▼
queryLoop()                     ← 真正的循环引擎（while(true) 状态机）
```

---

## 四、状态机：一次迭代的完整流转

循环的每一次迭代（一轮 while 迭代）本质是一个状态机。理解它的关键是把"本轮结束后会发生什么"分成两类：

- **继续循环（continue）**：本轮遇到一个可恢复的问题，调整状态后跳回 while 顶部重试。`state.transition` 字段记录跳回的原因。
- **退出循环（return）**：本轮触发了不可恢复的退出条件，`queryLoop` 返回一个 `Terminal` 值。

下面用一张图展示一次迭代中所有的流转路径。但在那之前，先把承载流转的"状态机对象"展开——它长什么样、字段怎么变、谁在读谁在写。

### 4.1 状态机对象：State 结构与读写契约

状态机不是抽象概念，而是一个具体的 TypeScript 对象——`State` 类型（`query.ts:261-274`），共 9 个字段：

```typescript
// src/query.ts:261-274
type State = {
  messages: Message[]                              // 当前消息历史（每轮追加 assistant + tool_result）
  toolUseContext: ToolUseContext                   // 工具上下文（工具执行后可能更新）
  autoCompactTracking: AutoCompactTrackingState | undefined  // 压缩追踪状态
  maxOutputTokensRecoveryCount: number             // max_tokens 恢复尝试计数（最多 3 次）
  hasAttemptedReactiveCompact: boolean             // 本会话是否已尝试过 reactive compact
  maxOutputTokensOverride: number | undefined      // max_tokens 升级后的覆盖值（8k → 64k）
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined  // 工具摘要 Promise
  stopHookActive: boolean | undefined              // Stop hook 是否正在阻塞退出
  turnCount: number                                // 当前轮次（每轮 +1）
  // Why the previous iteration continued. Undefined on first iteration.
  // Lets tests assert recovery paths fired without inspecting message contents.
  transition: Continue | undefined                 // 上一次转换原因（审计用）
}
```

9 个字段按"跨轮可变"程度可以分成两组：

| 字段组 | 字段 | 谁写 | 谁读 |
|--------|------|------|------|
| **每轮必更新** | `messages`、`turnCount`、`transition` | 每次循环末尾 `state = { ... }` 全量替换 | 阶段 1-5 全部 5 个阶段都要读 messages；turnCount 仅在阶段 5 检查 |
| **状态追踪** | `autoCompactTracking`、`maxOutputTokensRecoveryCount`、`hasAttemptedReactiveCompact`、`maxOutputTokensOverride`、`pendingToolUseSummary`、`stopHookActive` | 仅在特定恢复路径里更新（如 reactive compact 路径写 `hasAttemptedReactiveCompact = true`） | 对应的判断点读（阶段 1 读 autoCompactTracking 判断是否需要压缩） |
| **工具相关** | `toolUseContext` | 工具执行后可能更新（如权限模式变化） | 阶段 4 工具执行时读；阶段 5 下一轮准备时读 |

**初始化**（`query.ts:421-432`）——state 在进入 while 循环前一次性构造：

```typescript
let state: State = {
  messages: params.messages,                       // 从调用方传入
  toolUseContext: params.toolUseContext,           // 从调用方传入
  maxOutputTokensOverride: params.maxOutputTokensOverride,  // 可能为 undefined（用默认值）
  autoCompactTracking: undefined,                  // 初始无追踪
  stopHookActive: undefined,                       // 初始无 hook 阻塞
  maxOutputTokensRecoveryCount: 0,                 // 初始未尝试恢复
  hasAttemptedReactiveCompact: false,              // 初始未尝试
  turnCount: 1,                                    // 第一轮
  pendingToolUseSummary: undefined,                // 初始无摘要
  transition: undefined,                           // 第一轮没有"上一次转换"
}
```

**Continue 类型与 7 种取值**——`state.transition` 字段的类型是 `Continue | undefined`。在源码里 `Continue` 是隐式的（未显式定义类型别名），但 7 种取值都被显式构造：

| reason | 触发场景 | 额外字段 | 代码位置 |
|--------|---------|---------|---------|
| `next_turn` | 正常进下一轮 | 无 | `query.ts:2053` |
| `collapse_drain_retry` | prompt 太长，API 拒绝 | `committed: drained.committed`（本次压缩释放的 token 数） | `query.ts:1397` |
| `reactive_compact_retry` | collapse drain 失败 | 无 | `query.ts:1449` |
| `max_output_tokens_escalate` | LLM 输出被 max_tokens 截断 | 无 | `query.ts:1504` |
| `max_output_tokens_recovery` | 升级后仍被截断 | `attempt: maxOutputTokensRecoveryCount + 1`（第几次尝试，最多 3 次） | `query.ts:1533` |
| `stop_hook_blocking` | Stop hook 返回 blocking error | 无 | `query.ts:1592` |
| `token_budget_continuation` | token 预算超限但允许继续 | 无 | `query.ts:1628` |

部分 reason 带额外字段（如 `committed` / `attempt`），这是为了在调试或 metrics 上报时携带上下文——`transition` 不只是一个标签，是带数据的对象。

**数据分类：不可变参数 vs 可变 State**

循环中有两类数据，泾渭分明：

| 类型 | 例子 | 声明 | 何时绑定 |
|------|------|------|---------|
| **不可变参数** | `systemPrompt` / `canUseTool` / `fallbackModel` / `maxTurns` | `const { ... } = params` | 进入循环前一次性解构，整个循环期间不变 |
| **跨轮可变状态** | `messages` / `turnCount` / `transition` 等 9 个字段 | `let state: State = { ... }` | 每轮迭代后全量替换 |

```typescript
// 不可变参数：进入循环前一次性解构
const {
  systemPrompt,      // 系统提示词（整个会话不变）
  canUseTool,        // 权限检查函数（整个会话不变）
  fallbackModel,     // 备用模型（整个会话不变）
  maxTurns,          // 最大轮次（整个会话不变）
} = params

// 跨轮可变状态
let state: State = {
  messages,           // 消息历史（每轮追加 assistant + tool_result）
  turnCount,          // 当前轮次（每轮 +1）
  toolUseContext,     // 工具上下文（工具执行后可能更新）
  // ... 压缩追踪、错误恢复计数等
}
```

这种分离的价值：**阅读循环代码时，看到 `const` 就知道"这个值永远不会变"，看到 `state.xxx` 就知道"这个值可能被本轮修改"**。不会出现"某个变量在几百行外被意外修改"的困惑。query.ts 整个循环约 1600 行——这种声明级别的可读性是必须的。

**关键读写契约：全量替换 vs 局部 mutate**

state 不会被原地 mutate。每次 `continue` 前都构造一个全新的 state 对象，9 个字段全量重写。同样是 while 循环，两种写法对比：

**方案 A：局部 mutate**

```typescript
let state: State = { ... }
while (true) {
  state.messages = newMessages       // 逐个字段修改
  state.turnCount++
  state.transition = { reason: 'next_turn' }
  // ...
}
```

**方案 B：全量替换**（Claude Code 选用）

```typescript
let state: State = { ... }
while (true) {
  const { messages, turnCount } = state   // 解构当前状态
  // ... 执行本轮逻辑 ...
  state = {                              // 9 个字段全量重写
    messages: newMessages,
    turnCount: turnCount + 1,
    transition: { reason: 'next_turn' },
    // ... 其余 6 个字段
  }
}
```

代码注释（`query.ts:418-420`）明确说明："Continue sites write `state = { ... }` instead of 9 separate assignments."

**为什么选全量替换？** 三个原因：

1. **可审计性。** 每次状态转换都是一个完整的"转换前 → 转换后"快照。调试时可以打印新旧 state 做 diff，精确知道这轮改了什么、没改什么。局部 mutate 模式下，"5 轮前某次修改了 `state.toolUseContext`"很难追溯——因为同一个引用被反复改写，丢失了历史。

2. **测试友好。** 测试可以断言"经过这轮后，state 的某个字段应该变成 X"，不需要 mock 中间过程。全量替换下，"未在本轮更新的字段"会被显式重置（哪怕重置成 `undefined`），断言不会被陈旧值干扰。

3. **强制显式。** 写全量替换时，开发者必须思考"这 9 个字段本轮各自应该是什么"。局部 mutate 容易遗漏——比如某轮忘了重置 `hasAttemptedReactiveCompact = false`，下次 reactive compact 路径可能跳过应有的尝试。全量替换让"哪些字段应该被重置"成为代码审查时的显式信息。

**配合 `transition` 字段记录转换原因**（见上表 7 种取值），调试时可以看到完整的转换轨迹。打开 Langfuse 调试时可以看到完整状态转换序列。

### 4.2 完整状态流转图

```
                        ┌──────────────────────┐
                        │    while (true) 顶部   │
                        │   解构 state，开始本轮  │
                        └──────────┬───────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      阶段 1: 上下文准备       │
                    │   压缩栈 → 消息过滤 → prefetch │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │      阶段 2: API 调用         │
                    │   双层循环：fallback + 流式     │
                    └──────────────┬──────────────┘
                                   │
                         用户按了 Ctrl+C？
                          │ 是              │ 否
                          ▼                 ▼
                    ┌──────────┐   ┌──────────────────┐
                    │ return   │   │ 阶段 3: 判断去向    │
                    │'aborted_ │   │ 收到了 tool_use？   │
                    │streaming'│   └────────┬─────────┘
                    └──────────┘    是            否
                                    │              │
                                    ▼              ▼
                         ┌──────────────┐  ┌─────────────────────────┐
                         │ 阶段 4: 工具执行│  │ 无 tool_use，检查能否退出 │
                         └──────┬───────┘  └────────────┬────────────┘
                                │                        │
                    用户按了 Ctrl+C？          ┌─────────┼─────────┐
                     │ 是        │ 否         │         │         │
                     ▼           ▼            ▼         ▼         ▼
               ┌──────────┐ ┌──────────┐  prompt    max_      stop    token
               │ return   │ │ 阶段 5:   │  _too_    output_   _hooks  _budget
               │'aborted_ │ │ 下一轮准备 │  _long?    tokens?   阻塞?    超限?
               │ tools'   │ └────┬─────┘    │         │         │        │
               └──────────┘      │          ▼         ▼         ▼        ▼
                          ┌──────┴──────┐  ┌──────────────────────────────────┐
                          │ maxTurns 超？│  │         尝试恢复，失败则退出       │
                          └──────┬──────┘  │                                  │
                            是       否    │ 成功 → continue                  │
                            │        │     │ 失败 → return 'prompt_too_long'   │
                            ▼        ▼     │      或 yield error message       │
                      ┌──────────┐ ┌──────────┐                              │
                      │ return   │ │ continue │  各路径的 continue reason:     │
                      │'max_    │ │ reason:  │  • collapse_drain_retry       │
                      │ turns'  │ │'next_   │  • reactive_compact_retry      │
                      └──────────┘ │ turn'   │  • max_output_tokens_escalate  │
                                   └──────────┘  • max_output_tokens_recovery  │
                                                 • stop_hook_blocking          │
                                                 • token_budget_continuation    │
                                                 └──────────────────────────────┘
```

### 4.3 两条主线：正常流转 vs 异常恢复

从上面的图可以看出，循环有两条截然不同的流转路径：

**主线（正常流转）**：上下文准备 → API 调用 → 收到 tool_use → 执行工具 → 下一轮准备 → `continue (next_turn)` → 回到顶部。这是 Agent 在正常推进任务时的路径，每一轮都在向前进展。

**支线（异常恢复）**：当没有收到 tool_use 时，循环不是直接退出，而是先检查"为什么 LLM 没有返回 tool_use"——是 prompt 太长导致模型没看到完整上下文？是输出被截断了？是 Hook 阻止了退出？这些情况都可以通过调整状态来恢复，不需要终止整个会话。

**分叉判断的依据。** 两条路径的分叉点判断不是靠 API 返回的 `stop_reason` 字段（SDK 不总是正确设置它），而是靠一个更可靠的事实：**在流式过程中是否实际收到了 tool_use block**。收到了 → 走主线执行工具，没收到 → 走支线判断退出。这是 `needsFollowUp` 标志的来源，也是整个状态机最关键的一个布尔值。

### 4.4 6 种"回到循环顶部"的原因（continue reasons）

当异常恢复路径成功调整了状态后，循环通过 `continue` 跳回 while 顶部，`state.transition` 记录原因：

| transition reason | 触发场景 | 做了什么调整 | 代码位置 |
|-------------------|---------|-------------|---------|
| `collapse_drain_retry` | prompt 太长，API 拒绝 | 执行 collapse drain，把压缩干掉的部分吐回去 | `query.ts:1397` |
| `reactive_compact_retry` | collapse drain 失败 | 触发 reactive compact，更激进地压缩上下文 | `query.ts:1449` |
| `max_output_tokens_escalate` | LLM 输出被 max_tokens 截断 | 把 max_tokens 从 8k 升级到 64k 再试 | `query.ts:1504` |
| `max_output_tokens_recovery` | 升级后仍被截断 | 注入一条 meta-message 让 LLM 继续未完成的输出（最多 3 次） | `query.ts:1533` |
| `stop_hook_blocking` | Stop hook 返回了 blocking error | 把 blocking error 注入上下文，让 LLM 看到并修正 | `query.ts:1592` |
| `token_budget_continuation` | token 预算超限 | 记录警告但允许继续（预算检查是软性的） | `query.ts:1628` |

加上正常流转的 `next_turn`（`query.ts:2053`），共 7 种 continue reason。

**关键设计**：这些恢复路径有优先级顺序。`collapse_drain_retry` 先于 `reactive_compact_retry`（先做轻量恢复，失败再做重操作）；`max_output_tokens_escalate` 先于 `max_output_tokens_recovery`（先扩容量，再续推）。不是"任意一个失败就退出"，而是"按优先级依次尝试，全部失败才退出"。

### 4.5 6 种"退出循环"的原因（terminal reasons）

当所有恢复路径都失败，或者触发了不可恢复的条件时，`queryLoop` 返回一个 `Terminal` 值：

| Terminal 值 | 触发场景 | 还能继续会话吗 |
|------------|---------|--------------|
| `'completed'` | LLM 自然结束，stop_reason=end_turn，无 tool_use | 是（调用方可以再发新消息） |
| `'max_turns'` | turnCount 达到 maxTurns 上限 | 否（本轮 query 结束） |
| `'aborted_streaming'` | 用户在流式接收阶段按了 Ctrl+C | 否 |
| `'aborted_tools'` | 用户在工具执行阶段按了 Ctrl+C | 否 |
| `'stop_hook_prevented'` | Stop hook 明确拒绝退出 | 否 |
| `'prompt_too_long'` | collapse drain + reactive compact 都失败了 | 否 |

**注意区分两个概念**：`queryLoop` 返回 `Terminal` 不等于"进程退出"。`'completed'` 表示本轮对话自然结束，但 REPL 还在运行——用户随时可以发下一条消息，启动新一轮 `query()`。其他 5 个值才是"本轮 query 异常终止"。

### 4.6 为什么这样设计——两条路径分开的意图

把"继续循环"和"退出循环"分成两条路径，背后的设计意图是**乐观恢复**：

LLM 调用失败、prompt 太长、输出被截断——这些问题在 Agent 场景下是常态，不是异常。如果每次遇到都直接退出，Agent 基本无法完成任何复杂任务。所以系统默认假设"问题可以修复"：prompt 太长就压缩，输出被截断就扩容量，hook 报错就反馈给 LLM 修正。

只有两类情况会直接退出：(1) 用户主动中断（Ctrl+C），(2) 所有恢复路径都试过了仍然失败。这种"先尝试修复，修复不了再退出"的策略，是 Agent 系统可靠性的关键。

---

## 五、单轮各阶段详解

上面状态机给出了循环的全局骨架，本章逐阶段展开——每个阶段的输入是什么、做了什么、输出是什么。

每一轮循环（一次 while 迭代）经历 5 个阶段：

```
┌──────────────────────────────────────────────────────────────┐
│ 阶段 1: 上下文准备                                            │
│   压缩栈 → 消息过滤 → tool_use_result 剥离 → prefetch 启动    │
├──────────────────────────────────────────────────────────────┤
│ 阶段 2: API 调用                                             │
│   双层循环：fallback 重试（外层）+ 流式消费（内层）             │
├──────────────────────────────────────────────────────────────┤
│ 阶段 3: 判断去向                                             │
│   有 tool_use？→ 阶段 4                                       │
│   无 tool_use？→ 退出判断（详见第四章状态机）                   │
├──────────────────────────────────────────────────────────────┤
│ 阶段 4: 工具执行                                             │
│   分批 → 权限 → Hook → 执行 → 结果注入                        │
├──────────────────────────────────────────────────────────────┤
│ 阶段 5: 下一轮准备                                           │
│   消息合并 → prefetch 收割 → maxTurns 检查 → 构造新 state     │
└──────────────────────────────────────────────────────────────┘
```

### 5.1 阶段 1：上下文准备

这一步为 API 调用准备消息列表。有四件事：

**第一，跑压缩栈。** 在发 API 之前，依次检查 5 层压缩是否需要触发（详见 [08-compaction-subsystem](cc-08-compaction-subsystem.md)）。顺序是固定的：先做省 token 的轻量操作（清除超大 tool_result），再做重量操作（调 LLM 折叠历史为摘要）。上一层没触发就不跑下一层。

**第二，从 compact_boundary 截断消息。** 压缩会把旧消息折叠为一条 `compact_boundary` 标记，但 `state.messages` 仍保留全量历史（UI 滚动回溯需要看到全部消息）。发 API 时必须从 `compact_boundary` 处截断，否则会把已压缩的旧消息再发一遍，等于压缩白做了。

**第三，剥离 tool_use_result 字段。** 大文件读取（如 400KB 的日志文件）的结果存在消息的 `toolUseResult` 字段里。这些数据在内存中占空间，但在发 API 时不需要（API 只需要 `tool_result` 的文本内容）。这里做浅拷贝剥离，注意不能原地 mutate——React 组件可能正在渲染这些字段，原地删除会导致 UI 渲染空白。

**第四，启动 prefetch。** 在发起 API 调用之前，先 fire-and-forget 启动 3 类异步副作用任务，让它们和 LLM API 调用**并行**运行（详见 §5.4 步骤 2）。收割时机是本轮工具执行结束、进入下一轮准备时。

上下文组装的具体机制（CLAUDE.md 加载、Git 状态注入、Skill 索引、工具 Schema 过滤）在 [07-context-assembly](cc-07-context-assembly.md) 中详细展开。

### 5.2 阶段 2：API 调用

这是循环中与 LLM 交互的部分。结构是双层循环：

```
外层 while (attemptWithFallback)    ← fallback 模型重试
  │
  └─► 内层 for await (event of stream)  ← 流式消费
        │
        ├─► content_block_delta (text)  → yield 给 UI 逐字渲染
        ├─► content_block_delta (json)  → 累积 tool_use 参数
        ├─► content_block_stop          → 触发下游处理
        └─► message_delta               → stop_reason + token usage
```

**外层循环处理 fallback。** 如果 API 调用失败且错误类型是 `fallback_required`（如模型持续过载），就切换到备用模型重试。注意是**单跳**——只有 primary → fallback 一次机会，fallback 再失败就报错退出。不会在多个模型间反复切换。

**内层循环消费流式响应。** LLM 的响应是逐 token 到达的，不是一次性返回。循环收到每个 `content_block_delta` 事件就 yield 给 UI 层，用户看到文字逐字出现。同时，如果 delta 属于 tool_use 的 JSON 参数，就累积起来，等 `content_block_stop` 事件到达时完成解析。

**流式中断的处理。** 如果流持续 90 秒没有任何事件（网络断开、模型卡住），系统会主动断开连接、切换到非流式请求重发。重发时之前的流式内容被 tombstone 消息标记删除——因为流式响应的 thinking block 签名不完整，直接追加到后续请求中会被 API 拒绝。

**错误扣留（withhold）机制。** `prompt_too_long` 和 `max_output_tokens` 错误不会立刻 yield 给调用方。因为 SDK 收到错误消息会终止整个 session。扣留让恢复路径（collapse drain、reactive compact）有机会默默修复——修复成功就不告诉调用方，修复失败才透传错误。

**为什么 fallback 是单跳。** 一次 fallback 已经能覆盖 99% 的临时故障（模型过载、网络分区）。多级 fallback（A→B→C→...）增加复杂度但收益递减——如果 fallback 也失败了，说明问题是系统性的（如 API key 无效），再切更多模型也没用。

**流中途降级。** 如果流已经开始消费 token 但持续 90 秒没有任何事件到达（网络断开、模型卡住），系统主动断开流连接，切换到非流式请求重发。重发前，之前流式累积的不完整内容被 tombstone 消息标记删除——因为流式响应的 thinking block 签名不完整，直接追加到后续请求中会被 API 拒绝。

### 5.3 阶段 4：工具执行

这是循环中真正"干活"的部分。当 LLM 返回 tool_use 时，执行流程是：

```
tool_use block 到达
  │
  ├─► findToolByName()           ← 在工具注册表中查找实现
  ├─► PreToolUse hooks           ← 用户定义的拦截逻辑，可拒绝/修改 input
  ├─► 权限检查                    ← deny > ask > allow，需要用户审批则弹 Prompt
  ├─► tool.call()                ← 实际执行（如 BashTool.spawn 子进程）
  ├─► PostToolUse hooks          ← 执行后审计/修改 result
  └─► tool_result 注入上下文      ← 下一轮 LLM 看到结果
```

**工具不是简单的 Promise.all 全部并发。** 读文件可以并行（互不影响），但写文件和后续读文件有依赖——必须先写后读。系统按工具自己声明的 `isConcurrencySafe` 属性分批：

| 批类型 | 策略 | 例子 |
|--------|------|------|
| 只读批（连续多个并发安全工具） | 并发执行，信号量控制并发上限 | Read + Grep + Glob 同时跑 |
| 写批（单个非并发安全工具） | 单独执行，等它完成再继续 | Bash（写文件）单独跑 |
| 混合 | 按出现顺序分批，连续只读合并、单写切批 | Read→Read→Write→Read 分成 3 批 |

每个工具调用经过完整的权限管线：`findToolByName → PreToolUse hooks → hasPermissionsToUseTool → tool.call() → PostToolUse hooks → 结果格式化`。权限检查的细节在 [06-permission-security](cc-06-permission-security.md)，Hook 系统的细节在 [12-hook-interception](cc-12-hook-interception.md)。

**streaming 工具执行**是一条可选路径。当 gate 打开时，系统不会等整个 LLM 响应结束再执行工具——收到一个 tool_use block 就立刻启动执行。这样工具执行和 LLM 推理可以重叠：LLM 在输出最后一个 tool_use 时，第一个 tool_use 可能已经执行完了。详见 [04-streaming-and-rendering](cc-04-streaming-and-rendering.md)。

### 5.4 阶段 5：下一轮准备

工具执行完成后，进入本轮最后一个阶段——为下一轮迭代做准备：

1. **合并消息。** 把本轮产出的 assistant 消息和 tool_result 消息追加到消息历史末尾。下一轮 LLM 看到完整上下文。

2. **收割 prefetch。** 在阶段 1 启动的 3 类 prefetch（memory / skill / tool）此时大部分已经完成（典型耗时 ~250-573ms vs LLM 调用 2-30s），收割结果、注入为下一轮的附件消息。**详见 §5.4.1**。

3. **刷新 MCP 工具列表。** MCP server 可能在后台注册了新工具或移除了旧工具，刷新列表让下一轮 LLM 看到最新的可用工具。

4. **检查 maxTurns。** 如果 `turnCount >= maxTurns`，强制退出循环。这是一个硬护栏——防止 Agent 无限循环烧 token。

5. **构造新 state。** 用全量替换的方式（`state = { ... }`）创建下一轮的初始状态，`transition` 字段记录为 `next_turn`。

### 5.4.1 Prefetch 机制详解

**Prefetch 是什么？** 在 agent 循环里，主循环在调用 LLM 之前会 fire-and-forget 启动几个**异步副作用任务**——这些任务和 LLM 调用**并行**运行，等 LLM 调用 + 工具执行都完成后再收割结果、注入下一轮。设计目的：**把"可以预先做的工作"和"必须等待的工作"重叠，缩短端到端延迟**。

**3 类 prefetch**（启动位置：`src/query.ts:454-493`）：

| 类型 | 启动函数 | 工作内容 | 典型耗时 | feature gate |
|------|---------|---------|---------|-------------|
| **memory prefetch** | `startRelevantMemoryPrefetch()` (line 454) | 从用户最后一条消息提取关键词，搜索相关 memory 文件（auto memory 系统的 sideQuery） | ~250ms (AKI) | `isAutoMemoryEnabled()` + `tengu_moth_copse` |
| **skill prefetch** | `startSkillDiscoveryPrefetch()` (line 484) | TF-IDF 搜索 skill 索引，返回与当前消息相关的 skill 列表 | ~573ms (Haiku) | `EXPERIMENTAL_SKILL_SEARCH` |
| **tool prefetch** | `startSearchExtraToolsPrefetch()` (line 489) | 预判当前轮可能用到的 deferred tool，预先加载 schema | 类似量级 | `EXPERIMENTAL_SEARCH_EXTRA_TOOLS` |

**memory prefetch 的细节**（`attachments.ts:2419-2478`）：

```typescript
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (!isAutoMemoryEnabled() || !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)) {
    return undefined  // feature gate 不通过 → 跳过
  }
  if (isPoorModeActive()) return undefined  // 穷鬼模式省 token → 跳过
  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) return undefined
  const input = getUserMessageText(lastUserMessage)
  if (!input || !/\s/.test(input.trim())) return undefined  // 单字 prompt 跳过

  const controller = createChildAbortController(toolUseContext.abortController)
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
    toolUseContext.langfuseTrace,
  ).catch(e => {
    if (!isAbortError(e)) logError(e)
    return []  // 失败不阻塞主循环
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {  // using 语法：循环退出时自动清理
      controller.abort()  // 中断 sideQuery
      logEvent('tengu_memdir_prefetch_collected', ...)
    }
  }
  return handle
}
```

**关键设计**：

1. **Zero-wait**：prefetch 启动后**不阻塞**主循环——主循环继续发起 LLM API 调用。收割时用 `pendingMemoryPrefetch.settledAt !== null` 判断是否完成（query.ts:1915），已完成就消费，未完成就跳过（"Prefetch gets as many chances as there are loop iterations"）。

2. **`using` 语法**：通过 TypeScript 的 `using` 声明（DisposableResource 协议），循环退出时自动调用 `[Symbol.dispose]`，abort sideQuery 并记录 telemetry。这样**不需要在每个 return / throw / 中断点手动清理**。

3. **AbortController 链**：`createChildAbortController(toolUseContext.abortController)`——prefetch 的 abort 信号链到 turn 级 AbortController，用户按 Esc 时整个 turn 的所有副作用（包括 prefetch）都立即取消。

4. **失败不阻塞**：`.catch(e => { ... return [] })`——prefetch 失败返回空数组，主循环继续。prefetch 是优化手段，不是关键路径。

**消费时机**（`query.ts:1913-1954`，在阶段 5 工具执行结束后）：

```typescript
// Memory prefetch 收割
if (
  pendingMemoryPrefetch &&
  pendingMemoryPrefetch.settledAt !== null &&       // 已完成
  pendingMemoryPrefetch.consumedOnIteration === -1 // 未消费过
) {
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,
  )
  for (const memAttachment of memoryAttachments) {
    const msg = createAttachmentMessage(memAttachment)
    yield msg
    toolResults.push(msg)
  }
  pendingMemoryPrefetch.consumedOnIteration = turnCount - 1  // 标记已消费
}

// Skill prefetch 收割
if (skillPrefetch && pendingSkillPrefetch) {
  const skillAttachments = await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
  // ... 同样 yield + push
}

// Tool prefetch 收割
if (searchExtraToolsPrefetch && pendingToolPrefetch) {
  const toolAttachments = await searchExtraToolsPrefetch.collectSearchExtraToolsPrefetch(pendingToolPrefetch)
  // ... 同样 yield + push
}
```

**3 个关键约束**：

1. **`consumedOnIteration` 防重复消费**——同一个 prefetch 只在 `settledAt !== null` 且未消费过时收割。多轮迭代时，只有第一次完成的轮次收割，后续轮次看到 `consumedOnIteration !== -1` 跳过。

2. **filterDuplicateMemoryAttachments 去重**——基于 `readFileState`（累计跨迭代的状态）过滤掉模型已经 Read/Wrote/Edited 的 memory，包括前面迭代已经用过的（这是 `toolUseBlocks` 数组看不到的）。

3. **收割结果作为 user message 的附件**——不是 system prompt 修改，是新增 user message，避免破坏 Prompt Cache 命中（user message 不在 cache 范围内）。

**为什么在阶段 5 收割而不是阶段 1？** 阶段 1 刚开始时 LLM 调用还没发起，没有"用户轮"的概念；阶段 5 时本轮的 assistant 消息 + tool_result 已经合并，下一轮的 user message 数组可以追加。这是 ReAct 范式下"观察结果传递"的自然衔接点——prefetch 的结果作为额外的"观察结果"注入下一轮。

**和 §5.6.1 提到的 `mcp_instructions_delta` 类似的设计哲学**：都是 fire-and-forget + zero-wait + 失败不阻塞。但 prefetch 是**搜索类副作用**（查 memory / 查 skill / 查 tool），而 mcp_instructions_delta 是**缓存类副作用**（标记哪些 MCP 指令需要重新加载）。

### 5.5 ReAct 闭环：观察结果如何传给下一轮、messages 怎么拼装

阶段 2-4 完成了一轮 ReAct 循环（Reason → Act → Observe）。阶段 5 构造新 state 后，下一轮的 LLM 就会用这个 state 重新跑阶段 1。本节讲清两个关键问题：

**问题 A：观察结果（tool_result）以什么形式传给下一轮？全量还是压缩？**

Claude Code 用的是 Anthropic Messages API 规定的原生格式：每一轮 tool_use 由一个对应的 tool_result user message 配对——不是文本形式，而是结构化的 content block：

```typescript
// src/query.ts:165-176 — 工具执行完后构造的 user message
yield createUserMessage({
  content: [
    {
      type: 'tool_result',
      content: errorMessage,         // 工具返回的字符串结果
      is_error: true,                // 或 false
      tool_use_id: toolUse.id,       // 对应上一轮 assistant 的 tool_use.id
    },
  ],
  toolUseResult: errorMessage,       // 同一份结果，UI 渲染用
  sourceToolAssistantUUID: assistantMessage.uuid,
})
```

三个字段缺一不可：
- `type: 'tool_result'`：API 协议规定的 block 类型
- `tool_use_id`：必须与上一轮 assistant 消息中某个 tool_use block 的 `id` 完全匹配——Anthropic API 用这个 id 配对，**不允许交错或缺失**（query.ts:1829-1830 注释明确警告）
- `content`：工具执行的字符串结果（stdout、文件内容、错误信息等）

**tool_result 是不是全量传？基本是，但有 3 道闸控制大小**：

1. **API 层剥离 raw payload（query.ts:525-553）**。每条 user message 都有两个字段：`message.content`（API 用的 tool_result 文本）和 `message.toolUseResult`（UI 渲染用的完整对象，包含原始输出如文件 buffer）。下一轮 API 只发 `content`，不发送 `toolUseResult`——避免 400KB 文件读取结果常驻消息历史。但**这个剥离只清掉 UI 字段，content 本身的字符串仍然全量传递**。

2. **每条消息的 budget 控制（query.ts:567）**。`applyToolResultBudget` 检查每条消息的 size，超过阈值的字段（如超大 stdout）替换成 `<response clipped>NOTE: ...` 占位符。这是一个"per-message"的硬上限——单个工具结果再大也不会撑爆单条消息。

3. **整个会话的 5 层压缩栈**（阶段 1 已讲，详见 [08-compaction-subsystem](cc-08-compaction-subsystem.md)）。当累积的 messages 总量超限，触发压缩把旧消息折叠成摘要。这是"per-session"的硬上限——总 token 数不能再涨。

**结论**：tool_result 在压缩前是**全量传递**的（每条完整保留），但通过 3 道闸控制总规模：单消息剥离 raw payload + per-message budget + per-session 压缩栈。

**问题 B：每轮 LLM 看到的 prompt 长什么样？**

每轮 API 调用的请求由两部分组成——`system` 字段和 `messages` 数组：

```typescript
// src/query.ts:647-649
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

**system 字段**（query.ts:647-649）：由 base system prompt + 运行时 system context 拼接：
- `systemPrompt`：基础系统提示（人格、工具列表、运行环境说明）
- `systemContext`：运行时上下文（cwd、date、git status 等键值对），通过 `appendSystemContext` 序列化成 `key: value\n...` 文本追加

整段 system prompt 每轮**重新构造**——因为 systemContext 是动态的（cwd、git status、token usage 都会变）。但**前 80% 的内容（基础 system prompt）每轮字节级不变**，这正是 Anthropic Prompt Cache 命中的关键（详见 §IV.4 Prompt Cache 复用）。

**messages 数组**（query.ts:2044）：本轮 LLM 看到的对话历史，组装顺序：

```
messagesForQuery           ← 阶段 1 压缩 + 截断 + 剥离 + budget 处理后的历史
  .concat(assistantMessages) ← 本轮 assistant 消息（含 tool_use blocks）
  .concat(toolResults)       ← 本轮所有 tool_result user messages（按 tool_use_id 配对）
```

注意拼接顺序：**先历史 → 再本轮 assistant → 再本轮 tool_results**。这是 Anthropic API 的强制要求——`tool_use` block 必须在 `tool_result` 之前，且 tool_result 的 `tool_use_id` 必须能对应到 assistant message 里的某个 tool_use。如果交错（tool_use → user_text → tool_result），API 直接报错（query.ts:1829-1830 注释）。

```typescript
// src/query.ts:2043-2054 — 构造下一轮的 state.messages
const next: State = {
  messages: messagesForQuery.concat(assistantMessages, toolResults),
  // ... 其余 8 个字段
  transition: { reason: 'next_turn' },
}
state = next
```

下一轮进入阶段 1 时，state.messages 重新经过 `getMessagesAfterCompactBoundary` → 剥离 `toolUseResult` → `applyToolResultBudget` → 5 层压缩栈处理，构造新的 `messagesForQuery` 发给 API。

**一个完整 ReAct 循环在 prompt 中的呈现**：

```
[system]                                    ← 系统提示（人格 + 工具列表 + 运行环境）
[user] 你好，帮我看看项目结构              ← 用户最初输入
[assistant] 调用 Glob(**/*.ts)              ← 第 1 轮 assistant
[user] tool_result: ["src/a.ts", ...]       ← 第 1 轮观察
[assistant] 调用 Read(src/a.ts)             ← 第 2 轮 assistant
[user] tool_result: "import ..."            ← 第 2 轮观察
[assistant] 调用 Bash(npm test)             ← 第 3 轮 assistant
[user] tool_result: "Tests passed: 12"      ← 第 3 轮观察
[assistant] "已查看 src/a.ts，所有测试通过"  ← 第 4 轮（无 tool_use，自然结束）
```

LLM 在每一轮看到的，是**截至当前的完整观察历史 + 自己的所有历史决策**——这就是 ReAct 的"Reasoning + Acting traces"完整保留。

### 5.8 让循环慢下来：5 层"慢思考"机制

主 Agent 的默认循环追求速度——能用 1 轮解决的不跑 2 轮。但有些任务（深度架构设计、复杂多文件改动、未知领域调研）需要**主动让循环慢下来**——多花几轮、多一些调研、多一些验证。Claude Code 实现了 5 层"慢思考"机制，从最轻的直接 API 参数到最重的外部会话规划，按需叠加：

| # | 机制 | 触发方式 | 影响 API？ | 文档位置 |
|---|------|---------|----------|---------|
| 1 | `--effort` CLI flag | `low / medium / high / xhigh / max` | ✅ 注入 `outputConfig.effort` | `main.tsx:1375`、`claude.ts:435-460` |
| 2 | `effortValue` 设置项 | `/effort` 命令或 appState | ✅ 同上 | `effort.ts:182` |
| 3 | `ultrathink` 关键词 | 用户 prompt 中输入 | ❌（prompt 级别告知） | `thinking.ts:30`、`messages.ts:4607` |
| 4 | `/ultraplan` 命令 | slash command | ❌（fork 到外部 CCR 会话） | `commands/ultraplan.tsx:60+` |
| 5 | `VERIFICATION_AGENT` | system prompt 强制 | ❌（多一轮独立验证） | `prompts.ts:367` |

下面对每层展开。

#### 5.8.1 `--effort` CLI flag / `effortValue` 设置项：直接注入 API

这是**最直接**的"慢思考"——把 Anthropic API 的 `outputConfig.effort` 字段设为指定等级：

```bash
claude --effort max
```

`src/main.tsx:1375-1385` 注册这个 option：

```typescript
new Option('--effort <level>', `Effort level for the current session (low, medium, high, max)`).argParser(...)
```

**API 落地**（`claude.ts:435-460`）—— `configureEffortParams()` 把 effort 值注入 Anthropic API 请求体：

```typescript
if (effortValue === undefined) {
  betas.push(EFFORT_BETA_HEADER)        // 没显式 effort：让 API 用默认 + 启用 beta
} else if (typeof effortValue === 'string') {
  outputConfig.effort = effortValue as 'high' | 'medium' | 'low' | 'max'
  betas.push(EFFORT_BETA_HEADER)
} else if (process.env.USER_TYPE === 'ant') {
  // 数值 effort override - ant-only
  extraBodyParams.anthropic_internal = { effort_override: effortValue }
}
```

**优先级链**（`effort.ts:182-203`）：

```
envOverride (MAX_EFFORT) > appState.effortValue > getDefaultEffortForModel
```

**5 个等级**（`effort.ts:23-29`）：

| 等级 | 含义 |
|------|------|
| `low` | 最快、最省 token——简单任务用 |
| `medium` | 中等 |
| `high` | 默认（API 不传时也是 high） |
| `xhigh` | 非常高——复杂推理任务 |
| `max` | 最高——把模型推到极限深度思考 |

**OpenAI 兼容性特例**：`effort.ts:194-201`——OpenAI Responses 把 `xhigh` 作为最高公开推理等级。在 ChatGPT 订阅模式下，`/effort max` 自动转成 `xhigh` 以保持兼容。

#### 5.8.2 `ultrathink` 关键词：按 turn 触发的 prompt 级告知

用户在 prompt 里输入 `ultrathink` 关键词（`thinking.ts:30` 用正则 `\bultrathink\b/i` 检测），

→ `attachments.ts:1501-1506` 触发 `ultrathink_effort` attachment（feature-gated by `ULTRAPLAN`/`ULTRATHINK` + GrowthBook `tengu_turtle_carbon`）：

```typescript
if (!isUltrathinkEnabled() || !hasUltrathinkKeyword(input)) return []
logEvent('tengu_ultrathink', {})
return [{ type: 'ultrathink_effort', level: 'high' }]
```

→ `messages.ts:4607` 把 attachment 转成 `<system-reminder>`：

```
The user has requested reasoning effort level: high. Apply this to the current turn.
```

**注意**：这个机制是**prompt 层级**的——告诉模型"用户希望深度思考"，并不直接调用 `configureEffortParams`。真正的 effort 注入仍由机制 1 决定。但因为模型收到明确的 `<system-reminder>` 指示，**通常会自发地更深入地推理**。

**UI 配套**：用户在 prompt 里输入 `ultrathink` 时，UI（`PromptInput.tsx:801-806`）会触发彩虹色高亮 + shimmer 动画——给用户"系统正在深度处理"的视觉反馈。

#### 5.8.3 `/ultraplan` 命令：fork 到外部深度规划会话

`/ultraplan` 是 slash command（`commands.ts:114-116`），feature-gated by `ULTRAPLAN`。

**核心流程**（`commands/ultraplan.tsx`）：

```
用户执行 /ultraplan "需求描述"
  │
  ├─► buildUltraplanPrompt(blurb, seedPlan?)  // 组装 CCR prompt
  │     包含: 用户 blurb + 默认指令 (prompt.txt) + 可选 draft plan
  │
  ├─► 在 CCR (Claude Code on the web) 创建 detached session
  │
  ├─► startDetachedPoll() 后台轮询  // line 86
  │     调用 pollForApprovedExitPlanMode()
  │     检测阶段: 'running' | 'needs_input' | 'approved'
  │
  ├─► 用户在浏览器 PlanModal 里批准 / 拒绝 / 修改
  │
  └─► 批准后两个执行目标:
        ├─ 'remote': 在 CCR 远程执行（结果以 PR 形式回传）
        └─ 'teleport': 把计划"传送"回本地 REPL，让用户选择执行方式
```

**prompt 模板**（`buildUltraplanPrompt` line 73-84）：

```typescript
const parts: string[] = []
if (seedPlan) {
  parts.push('Here is a draft plan to refine:', '', seedPlan, '');
}
parts.push(getPromptText(promptId!));
if (blurb) {
  parts.push('', blurb);
}
return parts.join('\n');
```

`prompt.txt`（inlined by bundler）包含默认指令——告诉远程会话"这是一个 plan refinement 任务，用户在浏览器里等你输出，输出格式必须是 `ExitPlanMode` 可解析的格式"。

**何时用 ULTRAPLAN？**
- 任务特别复杂，需要先在 CCR 里花 30 分钟仔细规划
- 当前本地 REPL 不方便深入规划（如被打断、被打断 5 次以上）
- 用户愿意切到浏览器 UI 仔细 review 计划

**对比机制 5.8.1/5.8.2**：effort/ultrathink 影响**单个 turn 的推理深度**；ULTRAPLAN 影响**整个会话的规划深度**——从"先想清楚"到"开干"的时间跨度更长。

#### 5.8.4 `VERIFICATION_AGENT`：对抗式独立验证

由 `feature('VERIFICATION_AGENT')` 控制（`DEFAULT_BUILD_FEATURES` 之一）。在 `prompts.ts:367` 的 system prompt 里强制：

```
The contract: when non-trivial implementation happens on your turn,
independent adversarial verification must happen before you report completion
— regardless of who did the implementing (you directly, a fork you spawned,
or a subagent). You are the one reporting to the user; you own the gate.

Non-trivial means: 3+ file edits, backend/API changes, or infrastructure
changes. Spawn the Agent tool with subagent_type="verification".

Your own checks, caveats, and a fork's self-checks do NOT substitute — only
the verifier assigns a verdict; you cannot self-assign PARTIAL.
```

**含义**：非平凡的实现完成后，**必须** fork 一个 verification 子 agent 做对抗式验证：

- **On FAIL**：修复 → resume verifier with findings + fix → 重复直到 PASS
- **On PASS**：spot-check（重新跑 2-3 个命令）→ 确认 PASS 项有 Command run block
- **On PARTIAL**：报告哪些通过、哪些无法验证

**触发条件**（`prompts.ts:362-367`）：

```typescript
hasAgentTool &&
feature('VERIFICATION_AGENT') &&
getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&  // 3P 默认 false（ant-only A/B）
!isPoorModeActive()  // Poor mode: 跳过 verification agent 省 token
```

**这是"让循环慢下来但更可靠"**——通过强制多一轮独立验证，避免假阳性完成。**注意是"对抗式"**（adversarial）——verifier 不应该被 main agent 的"测试都通过了"自我说服，必须独立跑命令验证。

#### 5.8.5 Plan / Explore 子 agent：多步调研

Plan / Explore 子 agent 的 prompt（已在 [10-subagent-isolation](cc-10-subagent-isolation.md) §11.2-11.3 详述）要求：

- **Explore**：发起多轮**并行** `grep`/`Read` 调用（"spawn multiple parallel tool calls"），专门做"广度优先搜索"
- **Plan**：4 步流程（理解需求 → 探索 → 设计 → 详化），专门做"深度优先规划"

主 Agent 在复杂任务上**先 fork Plan 子 agent 做深度规划**，再进入实施阶段——这是"先慢后快"的两阶段循环。

#### 5.8.6 5 层机制的相互关系

```
                  触发层次
  ┌──────────────────────────────────────────────────────┐
  │ 单个 turn 推理深度                                     │
  │   • --effort max          → 直接注入 API              │
  │   • ultrathink 关键词      → prompt 告知模型           │
  ├──────────────────────────────────────────────────────┤
  │ 单个 turn 的额外验证                                    │
  │   • VERIFICATION_AGENT    → fork 一个 verifier 子 agent │
  ├──────────────────────────────────────────────────────┤
  │ 整个会话的规划深度                                      │
  │   • Plan 子 agent          → fork 一次深度规划         │
  │   • /ultraplan 命令         → fork 到外部 CCR 长时间规划 │
  └──────────────────────────────────────────────────────┘
```

**选择哪一层？**

- **简单任务**：默认（adversarial verification 自动跳过，effort=high）
- **复杂单任务**：开 VERIFICATION_AGENT 强制验证
- **复杂多步任务**：先 fork Plan agent 规划，再开 VERIFICATION
- **特别复杂的探索任务**：用 `/ultraplan` 在外部 CCR 规划 30 分钟
- **单个深度推理任务**：`--effort max` 或 prompt 加 `ultrathink`

---

## 六、全局视角：后续功能如何嵌入循环

Agent 循环不是一个封闭的系统。它的关键节点上都有"接口"，让外部功能可以插入。下面从循环的视角，展示每个后续文档的主题是在循环的哪个节点上发挥作用的：

```
┌─────────────────────────────────────────────────────────────────┐
│                     while (true) {                               │
│                                                                  │
│  ① 上下文准备 ─────────────────────────────────────────────────  │
│     │                                                            │
│     ├── [07-context-assembly] CLAUDE.md、Git、Skill、工具 Schema  │
│     ├── [08-compaction-subsystem] 5 层压缩栈                      │
│     └── [09-skill-system] Skill TF-IDF 索引与发现                 │
│                                                                  │
│  ② API 调用 ────────────────────────────────────────────────────  │
│     │                                                            │
│     ├── [19-multi-provider-stream-adapters] 多 Provider 适配      │
│     └── [04-streaming-and-rendering] 流式解析 + 逐字渲染          │
│                                                                  │
│  ③ 有 tool_use？─── 否 ──► 退出判断 ──► return                   │
│     │ 是                                                        │
│     ▼                                                            │
│  ④ 工具执行 ────────────────────────────────────────────────────  │
│     │                                                            │
│     ├── [05-tool-execution-pipeline] 工具注册、校验、执行管线      │
│     ├── [06-permission-security] 权限规则引擎 + HITL 审批          │
│     ├── [12-hook-interception] PreToolUse / PostToolUse Hook      │
│     ├── [15-mcp-integration] MCP 外部工具协议                     │
│     ├── [16-worktree-isolation] 文件系统隔离                      │
│     │                                                            │
│     ├── [11-plan-mode-deep-dive] 计划模式                         │
│     │     Plan 是跨轮约束：进入 Plan 模式后，循环的行为被限制      │
│     │     在"按计划执行"的范围内                                   │
│     │                                                            │
│     ├── [10-subagent-isolation] 子 Agent                          │
│     │     AgentTool 从循环中 fork 出独立 queryLoop，              │
│     │     有独立的上下文和 maxTurns                                │
│     │                                                            │
│     └── [13-human-in-the-loop] 人在环路                           │
│           权限检查 fallback 到交互式 Prompt，循环在此暂停          │
│           等待用户决策（allow / deny / always allow）              │
│                                                                  │
│  ⑤ 下一轮准备 ──────────────────────────────────────────────────  │
│     │                                                            │
│     └── [14-scheduled-tasks] 定时任务                             │
│           cron 到期时，在 IDLE 状态触发新一轮 query()              │
│                                                                  │
│  }  // end while                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**理解这个嵌入关系后，阅读后续文档的顺序建议**：

- 先读 **04-streaming-and-rendering**（看懂 API 响应如何变成屏幕上的文字）
- 再读 **05-tool-execution-pipeline**（看懂工具怎么被执行）
- 然后读 **06-permission-security**（看懂权限怎么卡在工具执行前面）
- 接着读 **12-hook-interception**（看懂 Hook 怎么在权限前后拦截）
- 然后可以跳到 **11-plan-mode-deep-dive**（看懂 Plan 怎么约束循环）和 **10-subagent-isolation**（看懂子 Agent 怎么从循环中 fork）
- **07-context-assembly** 和 **08-compaction-subsystem** 是上下文管理的细节，可以按需深入

---

## 七、设计决策与权衡

### 7.1 循环骨架与状态管理

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| 循环控制 | `while(true)` | 递归 | while 复用同一栈帧（多轮可达数百轮）；递归栈溢出 + 调试困难 |
| 状态变更 | 全量替换 `state = { ... }`（9 字段全写） | 局部 mutate | 可审计（每次状态转换是完整快照）；测试友好；强制显式（不漏重置字段） |
| 状态可变性 | 不可变参数（const）+ 可变 state | 全部 let | 阅读代码时看到 const 就知道"这个值永远不会变" |
| Transition 字段 | 7 种 continue reason 显式枚举 | 仅靠日志追踪 | 测试可以断言"经过这轮后，state.transition.reason === X"；Langfuse 可以完整回放 |
| 退出判断 | needsFollowUp 标志（实际收到 tool_use） | 依赖 stop_reason | SDK 不总是正确设置 stop_reason，实际收到 tool_use 才是可靠信号 |

### 7.2 工具执行与并发

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| 工具并发 | 分批：只读并发、写串行 | 全 `Promise.all` | 写工具结果相互依赖，不能并行；只读工具无副作用可并行 |
| 流式工具执行 | `streamingToolExecutor` 启用时收到 tool_use 立即启动 | 等整个响应结束再执行 | 工具执行与 LLM 推理重叠，最大化总吞吐 |
| Tombstone 清空 | 流式 fallback 时 yield tombstone 删之前的部分消息 | 让 SDK 自己处理 | thinking signature 不完整会导致后续 API 拒绝 |

### 7.3 错误处理与恢复

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| Fallback 模型 | 单跳（primary → fallback） | 多级 fallback chain | 1 次已覆盖 99% 故障，多级复杂度收益递减 |
| 错误扣留 | `prompt_too_long` / `max_tokens` 不立刻 yield | 立刻 yield 错误 | SDK 收到错误会终止 session；扣留给恢复路径修复机会 |
| 压缩顺序 | 轻量→重量固定顺序 | 按需任意顺序 | 早做省 token 的先做；后面压缩视野越来越小 |
| Idle Watchdog | 90s 主动 abort + 30s 被动 metrics | 单一阈值 | 防真断连（hard limit）+ 记录慢响应（观测）；避免误判慢速模型 |

### 7.4 Prompt 构造与缓存

详细的 Prompt 构造机制（静态段 / 动态段 / 缓存边界 / 完整 prompt 文本 / 设计技巧 / CoT 设计）见 **[07-context-assembly](cc-07-context-assembly.md) §十一-§十四**。本节只列核心决策指针：

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| Prompt 形式 | 字符串数组（每段独立） | 字符串拼接 | Anthropic Prompt Cache 按段缓存——数组元素是独立 cache entry |
| 缓存边界 | `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记 | 不分边界 | 前缀哈希稳定锚点；前 80% 字节级不变 → 跨用户高命中率 |
| 静态段 vs 动态段 | 静态（身份/权限/防御）vs 动态（env/language/memory） | 全部动态 | 静态段每轮字节级不变 → 缓存命中；动态段随会话变化 |
| Negative constraint | "Don't X, because Y" 给具体反例 | 仅给 positive instruction | LLM 倾向"过度帮忙"；具体反例比抽象禁令有效 5-10 倍 |

### 7.5 ReAct + CoT 思维链设计

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| Native CoT | `thinkingConfig: { type: 'adaptive' }`（默认开启） | prompt 层面"先思考再回答" | API 协议层结构化（`<thinking>` block）；不占 context window；跨 turn 持久化 |
| 文字 CoT | "Before your first tool call, briefly state what you're about to do" | 完全依赖 native thinking | 用户需要可见的进度反馈；native thinking 用户看不到 |
| Traces 累积 | reasoning + acting 跨 turn 保留在 messages 数组 | 每轮结束清理历史 | 失败恢复（`max_output_tokens_recovery` / `stop_hook_blocking`）依赖 traces |
| CoT 三层叠加 | native + 文字 + traces 三层互补 | 只做某一层 | 用户反馈 + 失败恢复 + 端到端可审计——三层缺一不可 |

### 7.6 "慢思考"分层

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| 慢思考层次 | `--effort` API 参数 / `ultrathink` 关键词 / `/ultraplan` / VERIFICATION / Plan-Explore 共 5 层 | 只做 effort 参数 | 不同任务需要不同深度——API 参数调单 turn 推理；ULTRAPLAN 调到整个会话规划 |
| Effort 注入方式 | `--effort max` 直接注入 `outputConfig.effort`；`ultrathink` 关键词只注入 `<system-reminder>` | 统一用 prompt 告知 | API 参数真的让模型花更多时间推理；prompt 告知只是"建议" |
| VERIFICATION 触发 | 非平凡实现（3+ 文件编辑 / backend 改动）必须 fork verification agent | 让主 agent 自检 | 强制独立验证避免"假阳性完成"；self-check 不替代对抗验证 |

### 7.7 Prefetch 与异步优化

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| Prefetch 模式 | 启动-消费分离（阶段 1 启动，阶段 5 收割） | 同步阻塞 | prefetch 250-573ms vs LLM 调用 2-30s；并行运行缩短端到端延迟 |
| Prefetch 失败处理 | `.catch(e => return [])` 不阻塞主循环 | 失败抛出 | prefetch 是优化不是关键路径；失败不应阻塞 LLM 调用 |
| Prefetch 清理 | TypeScript `using` 语法 + `[Symbol.dispose]` | 手动 try/finally | 自动覆盖所有 return/throw/break 路径；不漏清理 |
| Abort 链 | `createChildAbortController` 链接到 turn 级 AbortController | 独立 AbortController | 用户 Esc 时整个 turn 的副作用（含 prefetch）立即取消 |

---

## 八、可复用的模式

### 8.1 循环骨架模式

- **Reason-Act-Observe 循环骨架。** Agent 系统的标准循环结构——LLM 推理 → 工具执行 → 结果观察 → 下一轮推理。本实现的关键贡献是 `transition` 字段的审计机制和 continue/terminal 两类状态转换的显式编码。

- **while(true) + 全量 state 替换。** 比递归更适合长生命周期的异步循环。state 全量替换而非逐个字段赋值，让每次状态转换都有清晰的"转换前/转换后"快照。配合 `using` 语法（DisposableResource 协议）自动覆盖所有退出路径的清理。

- **退出条件优先级链。** 多层退出条件按紧急程度排列（用户中断 > 硬护栏 > Hook 拦截 > API 错误 > 自然结束），每层独立判断，高优先级先触发。

- **不可变参数 + 可变状态分离。** 将循环参数分为"整个会话不变"和"每轮更新"两类，减少代码阅读时的认知负担。

### 8.2 错误处理与恢复模式

- **Fallback 单跳模式。** primary 失败 → 单次切 fallback → 不再重试。简单可靠，避免了多级 fallback 的复杂性。

- **错误扣留（Withhold）模式。** 可恢复错误（`prompt_too_long` / `max_tokens`）不立刻 yield，等恢复路径（collapse drain / reactive compact / max_tokens 升级）决定——避免 SDK 边界过早终止会话。

- **压缩栈顺序编码。** 5 层压缩按"轻量→重量"固定顺序排列，每层只在前层无法处理时启动，避免重复工作和无效压缩。

- **Idle Watchdog 双层模式。** 主动 abort（90s）防止真断连，被动 metrics（30s）记录慢响应——不同阈值不同响应，"真断连"用 hard limit 兜底，"慢但还在动"用 metrics 观测。

### 8.3 异步优化模式

- **Prefetch fire-and-forget + 零等待模式。** 启动副作用任务但不让它阻塞主循环；收割时检查 `settledAt`（已完成就消费，未完成就跳过）。让"可预先做的工作"和"必须等待的工作"重叠，缩短端到端延迟。配合 `using` 语法 + AbortController 链覆盖所有清理路径。

- **多层 yield 模式。** API 层 yield `stream_event`（原始事件）→ 循环层 yield `stream_event` 或 `assistant` → UI 层 `handleMessageFromStream` 调度。每层可以过滤和转换事件，解耦各层的关注点。

- **AbortController 链模式。** `createChildAbortController(parent)` 让子任务的取消跟随父任务的取消。用户 Esc 时整个 turn 的所有副作用（prefetch、流式订阅、tool 子进程）都立即收到 abort 信号。

### 8.4 Prompt 工程模式

> 详细的 Prompt 工程技巧分析见 **[07-context-assembly](cc-07-context-assembly.md) §十三 Prompt 工程设计技巧分析**（9 个技巧，含每个技巧的反例对比）。

- **Cache-aware sectioning 模式。** Prompt 用数组（每段独立）而非字符串拼接。Anthropic Prompt Cache 按段缓存——数组元素是独立 cache entry，某段变了不影响其他段命中。配合 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记做缓存作用域切换。

- **Negative constraint + 具体反例模式。** "Don't X, because Y" 格式给具体反例，比抽象禁令有效 5-10 倍。LLM 倾向"过度帮忙"，具体反例直接划定边界。

- **行为触发器模式。** "before your first tool call"、"when you find something load-bearing"——给出明确的触发时机（开始时 / 发现关键信息时 / 改变方向时），模型才能在正确时机触发正确行为。比"随时更新进度"这种抽象建议有效。

- **False-claims mitigation 模式。** 显式 anti-pattern list（"never claim X when Y"、"never suppress failing checks"）直接划定禁止行为。比"please be honest"有效——后者模型听不进去。

### 8.5 CoT 与可恢复性模式

> 详细的 CoT 思维链设计（含 3 层机制 + 失败恢复依赖 + 代价权衡）见 **[07-context-assembly](cc-07-context-assembly.md) §十四 ReAct + CoT 思维链设计**。

- **CoT 三层叠加模式。** Native extended thinking（API 层结构化）+ 文字声明（用户可见）+ Traces 累积（跨 turn 可恢复）——三层互补。用户反馈 + 失败恢复 + 端到端可审计，三层缺一不可。

- **Reasoning + Acting Traces 跨 turn 累积模式。** 每一轮的 `<thinking>` block + 文字声明 + tool_use + tool_result 全部保留在 messages 数组里，不因 compaction 丢失核心推理痕迹。失败恢复（`max_output_tokens_recovery` / `stop_hook_blocking`）依赖 traces——没有 traces 恢复路径失效。

### 8.6 "慢思考"分层模式

- **API 参数 vs Prompt 告知的混合策略。** `--effort max` 直接注入 `outputConfig.effort`（真的让模型花更多时间推理）；`ultrathink` 关键词只注入 `<system-reminder>`（建议深度思考）。两种机制效果差距很大——用户需要清楚区分。

- **多层慢思考按需叠加。** 单 turn 推理深度（effort / ultrathink）→ 单 turn 额外验证（VERIFICATION）→ 整个会话规划深度（Plan / ultraplan）——三层覆盖不同深度需求，让用户/系统根据任务复杂度选择触发层级。


---

