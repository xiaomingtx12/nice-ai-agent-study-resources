---
slug: /application-notes/engineering/claude-code-cli/cc-10-tool-execution-pipeline
sidebar_position: 10
title: "工具注册、调度与执行管线"
description: "拆解工具从注册、Schema 注入、调度、权限、执行到结果回灌的完整链路，并解释延迟发现、并发安全和大结果保护。"
---

> 工具不是“模型说调用就直接执行的函数”，而是一条经过工具池、参数结构、并发调度、权限审批和结果回灌的受控链路。
>
> **Harness 层定位**：工具层决定模型能调用哪些能力，也决定这些能力如何安全地影响外部世界。

# 工具注册、调度与执行管线

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变动，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **工具接口与别名**：`src/Tool.ts` 的 `toolMatchesName()`、`findToolByName()`、`Tool<Input, Output, P>`、`TOOL_DEFAULTS` 和 `buildTool()` —— 定义工具必须提供什么能力，以及缺省行为如何按保守策略补齐。
> - **工具池装配**：`src/tools.ts` 的 `getAllBaseTools()`、`getTools()`、`assembleToolPool()` 和 `getMergedTools()` —— 合并内置工具、模式过滤、权限过滤和 MCP 工具。
> - **首轮可见工具**：`src/constants/tools.ts` 的 `CORE_TOOLS` —— 决定哪些工具在工具搜索启用时始终带完整 Schema 出现在初始请求中。
> - **API Schema**：`src/utils/api.ts` 的 `toolToAPISchema()` —— 将 Zod（运行时参数校验库）或 JSON Schema 转成 API 工具定义，并按条件加入 `strict`、`defer_loading` 和缓存字段。
> - **批次调度**：`src/services/tools/toolOrchestration.ts` 的 `runTools()`、`partitionToolCalls()`、`runToolsSerially()` 和 `runToolsConcurrently()` —— 将连续的并发安全调用合并成并发批，其余调用串行执行。
> - **单次执行**：`src/services/tools/toolExecution.ts` 的 `runToolUse()`、`streamedCheckPermissionsAndCallTool()` 和 `checkPermissionsAndCallTool()` —— 完成工具查找、终止检查、参数校验、Hook、权限、调用和错误回灌。
> - **大结果保护**：`src/utils/toolResultStorage.ts` 的 `getPersistenceThreshold()`、`persistToolResult()`、`buildLargeToolResultMessage()`、`processToolResultBlock()` 和 `enforceToolResultBudget()` —— 将过大的结果落盘，用预览替代完整内容，并保持后续请求的稳定性。
> - **循环接线**：`src/query.ts` 的 `queryLoop()` —— 收集模型输出的 `tool_use`，按配置选择流式或批量执行，再把 `tool_result` 放回下一轮消息。

## 一、先建立四个边界

工具系统最容易被讲混的地方，是把几个不同问题都叫成“工具可用”。

本文中的几个核心数据块先统一口径：

```text
tool_use
  模型发出的工具调用块

tool_result
  工具执行后回灌给模型的工具结果块

Hook（钩子）
  在工具执行前后插入检查或附加逻辑的扩展点
```

实际上至少要区分四个状态：

```text
工具存在
  → 工具已经注册在完整工具池中

工具可见
  → 工具定义已经以 Schema 形式发送给当前模型

工具可执行
  → 当前模式、权限规则和 Hook 允许这次调用继续

工具可并发
  → 工具声明这次输入可以和同批调用同时执行
```

这四个状态不是同一个判断。

例如，一个工具可能已经存在于 `getAllBaseTools()`，但因为它不是 `CORE_TOOLS`，首轮只以延迟发现的形式存在；即使模型已经发现它，权限规则仍然可能拒绝执行；即使权限允许执行，它也可能因为 `isConcurrencySafe()` 返回 `false` 而被调度器放入串行批。

### 1.1 工具管线到底解决什么问题

如果把模型输出直接当成函数调用，至少会遇到五类问题。

**第一，工具太多。**

完整工具池包含内置工具、条件工具和外部 MCP（Model Context Protocol，模型上下文协议）工具。把每个工具的完整参数结构都放进每次请求，会增加 prompt token，也会让模型在大量相似工具之间选择。

**第二，同一轮调用可能有顺序依赖。**

两个独立的 `Read` 可以并发，但 `Write` 完成之前执行依赖它结果的读取，就可能看到旧内容。调度器必须保守地切批。

**第三，模型输入不总是符合参数结构。**

模型可能漏填必填字段、添加不存在的字段，或把数字和布尔值写成字符串。系统需要把错误变成模型能理解的 `tool_result`，而不是让整个 Agent Loop 直接崩溃。

**第四，工具结果可能比上下文窗口大。**

搜索日志、读取大文件和外部 API 返回都可能产生很长的文本。结果不能无条件塞回下一轮请求。

**第五，权限和 Hook 必须位于真正执行之前。**

工具注册阶段只能说明“这个工具存在”，不能代替执行前的授权。权限、自动分类器和 PreToolUse Hook 必须在 `tool.call()` 之前再次检查。

因此，工具管线的主线可以写成：

```text
工具定义
  → 工具池装配
  → Schema 注入
  → 模型输出 tool_use
  → 工具查找和参数校验
  → Hook 与权限决策
  → tool.call()
  → 结果映射和大结果保护
  → tool_result 回灌
  → Agent Loop 下一轮
```

## 二、它位于 Agent Loop 的哪里

工具管线位于模型输出和下一轮模型请求之间。

```text
┌──────────────────────────────────────────────────────┐
│ Agent Loop                                            │
│                                                      │
│  模型请求                                              │
│    ↓                                                 │
│  模型流式输出：text / thinking / tool_use             │
│    ↓                                                 │
│  ┌──────────────────────────────────────────────┐    │
│  │ 工具管线                                     │    │
│  │ 查找 → 校验 → Hook → 权限 → 调度 → call()    │    │
│  │                 ↓                            │    │
│  │        结果映射 → 预览或落盘                 │    │
│  └──────────────────────────────────────────────┘    │
│    ↓                                                 │
│  user message 中的 tool_result                       │
│    ↓                                                 │
│  下一轮模型请求                                        │
└──────────────────────────────────────────────────────┘
```

权限系统和 Hook 系统不是工具管线的替代品，而是被工具执行阶段调用的横向检查点。

### 2.1 `query.ts` 的两个执行入口

`src/query.ts` 会根据运行时开关决定使用哪条路径：

```typescript
// src/query.ts：每轮查询初始化工具执行器
const useStreamingToolExecution = config.gates.streamingToolExecution

const streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  : null
```

如果开启 `StreamingToolExecutor`，工具可以在模型流式输出 `tool_use` 的过程中提前启动。

如果没有开启流式执行，主循环会等到本轮收集完 `tool_use`，再调用：

```typescript
// src/query.ts：非流式路径交给批量编排器
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

两条路径最终都要产出同一种结果：与每个 `tool_use.id` 对应的 `tool_result`。

源码还特别提醒：`stop_reason === 'tool_use'` 并不总是可靠。循环真正依赖的是流式期间是否收到了 `tool_use` 内容块。

## 三、工具如何进入工具池

### 3.1 `Tool` 是贯穿全链路的接口契约

`Tool<Input, Output, P>` 不只是一个 `call()` 方法。它同时描述：

- 工具名称和别名；
- 参数 Schema（参数结构）；
- 工具提示词；
- 是否启用；
- 是否可以并发；
- 是否只读或有破坏性；
- 权限检查；
- 工具执行；
- 工具结果如何映射成 API 能识别的结果块；
- 工具进度和终端渲染方式。

关键字段可以抽象成下面这个结构：

```typescript
// src/Tool.ts：工具对象同时服务于模型、调度器、权限层和 UI
export type Tool<Input extends AnyObject = AnyObject, Output = unknown> = {
  name: string
  aliases?: string[]                    // 兼容旧名称的别名
  searchHint?: string                   // 延迟工具搜索时使用的关键词
  inputSchema: AnyObject                // 运行时参数校验
  inputJSONSchema?: ToolInputJSONSchema  // 已经准备好的 JSON Schema
  prompt: (context: ToolPromptContext) => Promise<string>
  strict?: boolean                      // 是否声明支持严格结构化输出

  isEnabled: () => boolean
  isConcurrencySafe: (input: Input) => boolean
  isReadOnly: (input: Input) => boolean
  isDestructive: (input: Input) => boolean
  checkPermissions: (
    input: Input,
    context: ToolUseContext,
  ) => Promise<PermissionResult>

  call: (
    input: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    assistantMessage: AssistantMessage,
    onProgress: ToolCallProgress,
  ) => Promise<ToolResult<Output>>

  mapToolResultToToolResultBlockParam: (
    result: Output,
    toolUseID: string,
  ) => ToolResultBlockParam
}
```

源码中的完整接口还包括渲染、MCP 元数据、结构化输出和上下文修改等字段。这里最值得记住的是：同一个工具对象既是模型的能力描述，也是运行时的执行单元。

### 3.2 `buildTool()` 为什么采用保守默认值

并不是每个工具都需要显式实现所有可选能力。`buildTool()` 会把 `TOOL_DEFAULTS` 和工具定义合并：

```typescript
// src/Tool.ts：缺省能力由统一入口补齐
const TOOL_DEFAULTS = {
  isEnabled: () => true,
  // 未声明并发安全时，按“不安全”处理
  isConcurrencySafe: (_input?: unknown) => false,
  isReadOnly: (_input?: unknown) => false,
  isDestructive: (_input?: unknown) => false,
  checkPermissions: async input => ({
    behavior: 'allow',
    updatedInput: input,
  }),
  toAutoClassifierInput: (_input?: unknown) => '',
  userFacingName: (_input?: unknown) => '',
}

export function buildTool(def: ToolDef) {
  return {
    ...TOOL_DEFAULTS,
    // 默认展示名称回退到工具自身 name
    userFacingName: () => def.name,
    ...def,
  }
}
```

`isConcurrencySafe()` 默认返回 `false`，是 fail-closed（默认按不安全处理）的设计。

工具作者没有明确证明“同一输入可以与其他调用并行”时，调度器宁愿牺牲一点速度，也不冒数据竞争风险。

同时，`isReadOnly()` 和 `isConcurrencySafe()` 不是同一个概念：

```text
只读
  说明工具是否修改外部状态

并发安全
  说明这次具体输入能否与同批调用同时执行
```

一个只读工具也可能因为共享连接、上下文修改或输入相关的全局状态而不能并发。反过来，某些非传统意义上的“写操作”也可能由工具自己证明是并发安全的。因此调度器应读取 `isConcurrencySafe(input)` 的结果，不要自行猜测。

### 3.3 工具池的四个函数

`src/tools.ts` 把工具装配拆成几个职责不同的函数。

**`getAllBaseTools()`：完整内置工具池。**

它返回当前环境中可能存在的内置工具，并根据环境变量和构建能力加入条件工具。例如是否有嵌入式搜索工具、是否启用 LSP、是否开启工作树模式。

**`getTools(permissionContext)`：当前直接可用的内置工具。**

它还会处理：

- `CLAUDE_CODE_SIMPLE` 简单模式；
- deny 规则；
- REPL（交互式读取-求值-输出环境）模式下隐藏原始工具；
- 每个工具自己的 `isEnabled()`。

**`assembleToolPool(permissionContext, mcpTools)`：内置工具加 MCP 工具。**

它会先过滤 MCP deny 规则，再按名称排序，并保持内置工具位于前缀位置，最后按名称去重，内置工具优先。

**`getMergedTools()`：完整合并视图。**

它适合工具搜索阈值计算和包含 MCP 工具的 token 统计。调用方不能把 `getTools()` 和 `getMergedTools()` 当成同一个集合。

可以把它们理解为：

```text
getAllBaseTools()
  当前环境可能有的内置工具

getTools()
  当前模式下可以交给主流程的内置工具

assembleToolPool()
  内置工具 + 经过过滤和去重的 MCP 工具

getMergedTools()
  需要统计或搜索时使用的完整工具视图
```

## 四、工具可见性：`CORE_TOOLS`、Schema 与延迟发现

### 4.1 `CORE_TOOLS` 不是完整工具池

`src/constants/tools.ts` 中的 `CORE_TOOLS` 是首轮常驻工具集合。源码注释明确说明：这些工具在初始化时带完整 Schema，不参与延迟加载。

其中包括常见文件操作、Shell、任务管理、计划模式、Web 工具、Skill、工具搜索本身和 `ExecuteExtraTool`。

因此，模型看到的工具列表不是简单的：

```text
getAllBaseTools() 的全部内容
```

更接近：

```text
当前工具池
  → 模式和权限过滤
  → CORE_TOOLS 保持完整 Schema
  → 其他工具在启用工具搜索时延迟发现
  → toolToAPISchema() 转成当前 provider 的请求结构
```

延迟发现的目标不是隐藏工具能力，而是减少首轮 prompt 中的 Schema 噪音。

### 4.2 `toolToAPISchema()` 做了什么

`src/utils/api.ts` 的 `toolToAPISchema()` 负责把工具对象转换成 API 的工具定义。

```typescript
// src/utils/api.ts：把工具对象转换成模型能读取的 API Schema
const input_schema = (
  'inputJSONSchema' in tool && tool.inputJSONSchema
    ? tool.inputJSONSchema
    : zodToJsonSchema(tool.inputSchema) // 没有 JSON Schema 时从 Zod 转换
)

const base = {
  name: tool.name,
  // prompt() 是工具的使用说明，不只是展示文本
  description: await tool.prompt({
    getToolPermissionContext: options.getToolPermissionContext,
    tools: options.tools,
    agents: options.agents,
    allowedAgentTypes: options.allowedAgentTypes,
  }),
  input_schema,
}
```

这里有三个重要层次。

**第一，参数结构。**

模型看到的是 JSON Schema；运行时仍会使用工具自己的 Zod `inputSchema` 再校验一次。两者分别位于“请求生成”和“执行前防线”。

**第二，工具描述。**

`prompt()` 会告诉模型什么时候应该使用这个工具、参数怎么填、哪些工具不要替代它。描述层是软约束，但对工具选择非常重要。

**第三，按条件加入能力字段。**

```typescript
// src/utils/api.ts：strict 只有三层条件同时满足才发送
if (
  strictToolsEnabled &&                 // 特性开关已打开
  tool.strict === true &&               // 工具明确声明支持
  options.model &&                      // 当前请求有模型名
  modelSupportsStructuredOutputs(options.model) // 模型支持严格结构化输出
) {
  base.strict = true
}

// 延迟工具只在当前请求的 overlay 中标记
if (options.deferLoading) {
  schema.defer_loading = true
}
```

`strict`（严格结构化输出）不是所有模型都能使用；`defer_loading`（延迟加载标记）也不是工具对象永久状态，而是当前请求的动态字段。

源码还会缓存稳定的基础 Schema，把 `defer_loading` 和 `cache_control` 作为每次请求的 overlay（请求级覆盖）。这样既能减少重复序列化，也不会因为某一轮的延迟策略污染整个会话的缓存前缀。

### 4.3 延迟工具找不到时如何自纠

当模型直接调用了尚未发现的延迟工具，`runToolUse()` 可能先找到工具对象，但参数校验失败时，`buildSchemaNotSentHint()` 会检查：

- 工具搜索是否启用；
- `SearchExtraTools` 是否可用；
- 当前工具是否确实是延迟工具；
- 当前消息中是否已经发现过它。

满足条件时，错误信息会补充两步指引：

```text
1. 先调用 SearchExtraTools 发现工具
2. 再调用目标工具
```

这比单纯返回“参数类型错误”更有用，因为模型真正缺少的不是某个参数，而是这次工具调用没有拿到完整 Schema。

## 五、一次 `tool_use` 的完整生命周期

下面用一条典型调用说明执行阶段：

```text
模型输出 tool_use
  ↓
1. 按名称或 alias（别名）查找工具
  ↓
2. 检查 abort signal（中止信号）
  ↓
3. Zod 参数校验
  ↓
4. 复制并补齐可观察输入
  ↓
5. PreToolUse Hook
  ↓
6. 权限决策和用户审批
  ↓
7. tool.call()
  ↓
8. 映射结果、执行 PostToolUse Hook
  ↓
9. 生成 tool_result 并回灌
```

### 5.1 工具查找：当前可见集合优先，旧别名有限回退

`runToolUse()` 首先从 `toolUseContext.options.tools` 查找。这个集合代表当前模型实际看到或当前上下文允许使用的工具。

```typescript
// src/services/tools/toolExecution.ts：先查当前可见工具
const toolName = toolUse.name
let tool = findToolByName(toolUseContext.options.tools, toolName)

// 当前集合没有时，只为旧别名做有限回退
if (!tool) {
  const fallbackTool = findToolByName(getAllBaseTools(), toolName)
  if (fallbackTool && fallbackTool.aliases?.includes(toolName)) {
    tool = fallbackTool
  }
}
```

别名匹配由 `toolMatchesName()` 完成：

```typescript
// src/Tool.ts：主名称或兼容别名都可以命中
export function toolMatchesName(
  tool: { name: string; aliases?: string[] },
  name: string,
): boolean {
  return tool.name === name || (tool.aliases?.includes(name) ?? false)
}
```

这里的回退不是“所有工具都可以被偷偷启用”。它只兼容旧 transcript（会话原始记录）中已经存在的旧名称，避免把当前上下文明确移除的工具重新暴露给模型。

如果最终找不到工具，系统不会直接结束循环，而是生成带 `is_error: true` 的结果：

```typescript
// 找不到工具时，让模型在下一轮自纠
{
  type: 'tool_result',
  content: `<tool_use_error>Error: No such tool available: ${toolName}</tool_use_error>`,
  is_error: true,
  tool_use_id: toolUse.id,
}
```

### 5.2 终止检查：用户中断必须生成配对结果

在真正执行前，`runToolUse()` 会检查 `abortController.signal.aborted`。

用户按下中断键、上层查询被取消或 Agent 被停止时，工具不能继续执行；但已经发出的 `tool_use` 仍然需要一个对应的 `tool_result`，否则下一次 API 请求会出现未配对的调用块。

因此中断路径通常也是：

```text
检测到 abort
  → 不调用 tool.call()
  → 为当前 tool_use 生成错误结果
  → 保持 tool_use_id 配对
```

这也是 `src/query.ts` 在流式执行中消费剩余结果的原因：队列中尚未完成的工具也必须生成合成的取消结果。

### 5.3 参数校验：模型输入不能直接信任

权限判断和工具调用都不应该直接使用模型原始输入。`checkPermissionsAndCallTool()` 首先调用：

```typescript
// src/services/tools/toolExecution.ts：执行前使用工具自己的运行时 Schema
const parsedInput = tool.inputSchema.safeParse(input)

if (!parsedInput.success) {
  const errorContent = formatZodValidationError(
    tool.name,
    parsedInput.error,
  )

  // 如果是尚未发现的延迟工具，再附加发现工具的下一步指引
  // ...
  // 最终通过 tool_result + is_error 回灌给模型
}
```

`formatZodValidationError()` 会把 Zod 原始错误转换成更适合模型修正的内容，例如：

```text
The required parameter `file_path` is missing
An unexpected parameter `foo` was provided
The parameter `limit` type is expected as `number` but provided as `string`
```

这种错误不会把整个 Agent Loop 直接判死。模型下一轮可以依据错误重新生成工具调用。

### 5.4 输入补齐：让观察者看到规范化后的输入

工具可以实现 `backfillObservableInput()`，为 Hook、权限层、SDK 输出和 transcript 补齐旧字段或派生字段。

源码会在浅拷贝上执行补齐：

```typescript
// src/services/tools/toolExecution.ts：可观察输入使用副本
const backfilledClone =
  tool.backfillObservableInput &&
  typeof processedInput === 'object' &&
  processedInput !== null
    ? { ...processedInput }
    : null

if (backfilledClone) {
  tool.backfillObservableInput(backfilledClone)
  processedInput = backfilledClone
}
```

原始 API 输入不直接修改，是为了保持消息序列化结果和 prompt cache 的稳定性。

这个边界很重要：

```text
观察输入
  给 Hook、权限、日志和 transcript 使用

调用输入
  最终传给 tool.call()
```

两者通常一致，但不应该因为补齐展示字段而无意修改模型原始消息。

### 5.5 PreToolUse Hook：执行前的可插入检查点

PreToolUse Hook（工具执行前钩子）在权限决策之前运行，可以：

- 记录或展示进度；
- 修改后续使用的输入；
- 返回额外上下文；
- 直接阻止继续执行；
- 提供 Hook 级权限决定。

如果 Hook 返回停止结果，工具执行阶段会生成一个停止类型的 `tool_result`，而不是继续调用 `tool.call()`。

因此 Hook 不是执行完成后的通知机制，而是工具调用生命周期的一部分：

```text
参数 Schema 校验
  → PreToolUse Hook
  → 权限决策
  → tool.call()
```

### 5.6 权限决策：允许、拒绝和等待审批

权限层由 `canUseTool()` 和工具自身的 `checkPermissions()` 共同参与。

权限决策可能是：

```text
allow
  继续执行

ask
  需要用户审批，等待后再决定

deny
  不调用工具，生成错误结果
```

拒绝结果仍然以 `tool_result` 形式回灌：

```typescript
// 权限拒绝也要告诉模型“这次调用没有发生”
{
  type: 'tool_result',
  content: errorMessage,
  is_error: true,
  tool_use_id: toolUseID,
}
```

这能避免模型产生“文件已经修改”或“命令已经执行”的错误假设。

需要注意，权限拒绝并不等于整个 Agent Loop 结束。默认策略是把事实反馈给模型，让它改用合理的替代方案；是否允许继续，还取决于 Hook 返回的 `preventContinuation` 和上层循环状态。

### 5.7 `tool.call()`：唯一真正产生副作用的核心调用点

通过参数校验、Hook 和权限后，`checkPermissionsAndCallTool()` 才会调用：

```typescript
// src/services/tools/toolExecution.ts：权限通过后才进入工具实现
const result = await tool.call(
  callInput,
  {
    ...toolUseContext,
    toolUseId: toolUseID,
    userModified: permissionDecision.userModified ?? false,
  },
  canUseTool,
  assistantMessage,
  progress => {
    onToolProgress({
      toolUseID: progress.toolUseID,
      data: progress.data,
    })
  },
)
```

这里有三个值得注意的点：

1. `callInput` 可能已经经过 Hook 或权限层更新；
2. 工具可以通过 `onProgress` 发送中间进度；
3. 工具返回的不一定是最终 API 文本，而是 `ToolResult<Output>`，还可能包含新消息和上下文修改器。

### 5.8 结果映射和 PostToolUse Hook

工具返回业务结果后，系统先用工具自己的映射函数转换：

```typescript
// 工具决定如何把业务输出变成 API tool_result 内容
const mappedToolResultBlock =
  tool.mapToolResultToToolResultBlockParam(
    result.data,
    toolUseID,
  )
```

随后执行 PostToolUse Hook（工具执行后钩子）。PostToolUse 可以补充消息、记录结果、触发后续流程，也可以在失败路径中由 PostToolUseFailure Hook 处理。

完整顺序不是：

```text
tool.call() → 立即回灌
```

而是：

```text
tool.call()
  → 业务结果映射
  → 大结果处理
  → PostToolUse Hook
  → 生成最终 tool_result
```

### 5.9 失败如何回到模型

工具执行抛出异常时，`runToolUse()` 会把异常转换成错误结果：

```typescript
// 执行异常也变成模型下一轮可读取的错误
{
  type: 'tool_result',
  content: `<tool_use_error>${detailedError}</tool_use_error>`,
  is_error: true,
  tool_use_id: toolUse.id,
}
```

所以以下情况通常不会直接杀死主循环：

- 工具名称不存在；
- 参数 Schema 校验失败；
- 文件不存在；
- 命令返回错误；
- 权限被拒绝；
- 工具实现抛出普通异常。

这类错误的共同处理方式是：

```text
记录事实
  → 生成 is_error: true 的 tool_result
  → 回灌模型
  → 让模型决定修正、换工具或向用户说明
```

真正需要停止时，通常来自用户中断、Hook 明确阻止继续、上层预算或上下文窗口限制，而不是任意一个工具调用失败。

## 六、同一轮多个工具如何调度

### 6.1 `partitionToolCalls()` 的原则

`src/services/tools/toolOrchestration.ts` 的 `partitionToolCalls()` 会按模型输出顺序扫描每个 `tool_use`：

```typescript
// src/services/tools/toolOrchestration.ts：先校验输入，再判断并发安全
const tool = findToolByName(
  toolUseContext.options.tools,
  toolUse.name,
)

const parsedInput = tool?.inputSchema.safeParse(toolUse.input)

const isConcurrencySafe = parsedInput?.success
  ? (() => {
      try {
        // 并发安全由工具针对这次具体输入声明
        return Boolean(tool?.isConcurrencySafe(parsedInput.data))
      } catch {
        // 判断本身出错时，也按不安全处理
        return false
      }
    })()
  : false
```

然后按“连续并发安全调用合并，否则新开批次”进行分组：

```text
[Read A, Read B, Write C, Read D]

→ [Read A, Read B]  并发批
→ [Write C]          串行批
→ [Read D]           新的并发安全批
```

它不是把所有只读调用放进一个全局并发池，而是只合并连续的安全调用。这样可以保留模型输出中的顺序边界。

### 6.2 并发批和串行批的上下文差异

`runTools()` 的两条分支如下：

```typescript
// 并发批：先同时执行，再按原顺序应用 contextModifier
if (isConcurrencySafe) {
  for await (const update of runToolsConcurrently(...)) {
    // 先产出结果
  }

  for (const block of blocks) {
    // 并发工具的上下文修改器在批次完成后统一应用
    for (const modifier of queuedContextModifiers[block.id] ?? []) {
      currentContext = modifier(currentContext)
    }
  }
} else {
  // 非并发安全批：每个工具完成后立即更新上下文
  for await (const update of runToolsSerially(...)) {
    if (update.newContext) {
      currentContext = update.newContext
    }
  }
}
```

这意味着同一并发批中的工具看到的是批次开始时的上下文；串行批中的后一个工具可以看到前一个工具的上下文修改。

### 6.3 并发上限

并发执行使用 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 控制，默认值为 `10`：

```typescript
function getMaxToolUseConcurrency(): number {
  return (
    parseInt(
      process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '',
      10,
    ) || 10
  )
}
```

这个上限是执行器级别的保护，不代表模型一次最多只能输出 10 个 `tool_use`。模型可以输出更多调用，调度器会在并发批内继续分批运行。

## 七、结果回灌：`tool_result` 如何进入下一轮

### 7.1 `tool_use_id` 是配对主键

模型输出和工具结果必须用同一个 ID 配对：

```typescript
// assistant message：模型请求调用 Read
{
  type: 'tool_use',
  id: 'toolu_123',
  name: 'Read',
  input: {
    file_path: '/workspace/app.ts',
  },
}

// user message：工具结果必须回填同一个 tool_use_id
{
  type: 'tool_result',
  tool_use_id: 'toolu_123',
  content: '1\tconst app = ...',
}
```

`tool_use_id` 不能用工具名替代，因为同一轮可能多次调用同一个工具：

```text
Read(file_a) → toolu_1
Read(file_b) → toolu_2
```

如果把结果只按工具名匹配，两个文件的结果就无法可靠区分。

### 7.2 `query.ts` 收集并规范化结果

工具编排器产出的消息会被主循环收集：

```typescript
// src/query.ts：收集工具消息，并规范化成 API 可发送的 user message
for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message

    toolResults.push(
      ...normalizeMessagesForAPI(
        [update.message],
        toolUseContext.options.tools,
      ).filter(message => message.type === 'user'),
    )
  }

  if (update.newContext) {
    updatedToolUseContext = {
      ...update.newContext,
      queryTracking,
    }
  }
}
```

随后，工具结果和本轮助手消息一起进入下一次模型请求。

```text
assistant: tool_use
user: tool_result
→ 下一轮模型请求
```

这就是 ReAct（Reasoning and Acting，推理与行动）式循环的执行侧：模型提出行动，工具返回观察结果，模型根据观察继续行动或结束。

## 八、大结果保护：不是简单截断

### 8.1 工具自己的结果阈值

每个工具可以声明 `maxResultSizeChars`。`getPersistenceThreshold()` 会结合工具声明值和运行时覆盖值，决定是否进入持久化路径。

当结果超过阈值时，系统优先考虑：

```text
完整结果落盘
  → 生成有限预览
  → tool_result 只携带文件路径和预览
```

这比直接截断更好，因为模型还可以根据路径再次调用读取工具，按 offset（偏移量）和 limit（读取数量）精确获取需要的部分。

### 8.2 `persistToolResult()` 和 2000 字节预览

```typescript
// src/utils/toolResultStorage.ts：大结果按 tool_use_id 持久化
export const PREVIEW_SIZE_BYTES = 2000

export async function persistToolResult(
  content: ToolResultBlockParam['content'],
  toolUseId: string,
) {
  await ensureToolResultsDir()

  // 每次工具调用使用自己的文件名，避免不同结果互相覆盖
  const filepath = getToolResultPath(
    toolUseId,
    Array.isArray(content),
  )

  const contentStr = Array.isArray(content)
    ? jsonStringify(content, null, 2)
    : content

  // 使用 wx：同一个 tool_use_id 已经落盘时不重复写入
  await writeFile(filepath, contentStr, {
    encoding: 'utf-8',
    flag: 'wx',
  })

  const { preview, hasMore } = generatePreview(
    contentStr,
    PREVIEW_SIZE_BYTES,
  )

  return {
    filepath,
    originalSize: contentStr.length,
    preview,
    hasMore,
  }
}
```

预览消息大致是：

```typescript
// src/utils/toolResultStorage.ts：告诉模型完整结果在哪里，以及先展示多少
export function buildLargeToolResultMessage(result) {
  return [
    PERSISTED_OUTPUT_TAG,
    `Output too large. Full output saved to: ${result.filepath}`,
    '',
    `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):`,
    result.preview,
    result.hasMore ? '\n...\n' : '',
    PERSISTED_OUTPUT_CLOSING_TAG,
  ].join('\n')
}
```

这里的“2000”是预览大小，不是完整结果的硬上限；完整内容已经被保存。

### 8.3 单个结果阈值和消息总预算是两层机制

`processToolResultBlock()` 负责把某个工具的业务结果映射并按工具阈值处理：

```typescript
// 先由工具映射，再决定是否持久化
const toolResultBlock =
  tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )

return maybePersistLargeToolResult(
  toolResultBlock,
  tool.name,
  getPersistenceThreshold(
    tool.name,
    tool.maxResultSizeChars,
  ),
)
```

`enforceToolResultBudget()` 处理的是另一件事：同一个 user message 中多个 `tool_result` 合计过大时，按消息级预算选择新的结果进行落盘替换。

它还维护每个 `tool_use_id` 的替换状态：

```text
第一次决定不替换
  → 后续轮次保持不替换

第一次决定替换
  → 后续轮次重复使用同一个预览文本
```

这样做是为了不让已经发送过的消息前缀在后续轮次突然改变，避免破坏 prompt cache。

因此要分开理解：

```text
工具级阈值
  由工具的 maxResultSizeChars 决定

消息级预算
  由多个 tool_result 的合计大小决定

模型上下文窗口
  还要包含历史消息、thinking、工具调用和本轮输出预留
```

工具结果持久化不是上下文窗口检测，也不是会话摘要。三者解决的是不同问题。

## 九、工具调用准确性的多层防御

执行管线已经能够处理错误，但系统还会尽量减少错误发生。

### 9.1 描述层：`prompt()` 告诉模型如何选工具

工具的 `prompt()` 最终会进入 API tool definition 的 `description`。

典型提示包括：

- 用专用的 `Read`、`Edit`、`Glob`、`Grep`，不要用 Shell 模拟；
- 文件编辑前先读取文件；
- 独立操作可以并发，存在依赖时保持顺序；
- 延迟工具先搜索再执行；
- 权限被拒绝后不要原样重复同一个调用。

这些内容不是 TypeScript 类型检查，而是给模型的操作手册。

### 9.2 Schema 层：严格约束和字段说明

工具参数通常同时有：

```text
JSON Schema
  给 API 和模型看

Zod inputSchema
  在运行时再次校验
```

工具还可以使用 `z.strictObject()` 拒绝未声明字段，并用 `.describe()` 解释字段什么时候应该填写。

不过 `strict` 是否真正发送，还要经过特性开关、工具声明和模型能力三层门控。不能看到工具有 `strict: true` 就假定当前请求一定启用严格模式。

### 9.3 容错层：修正无歧义的机械错误

部分工具使用 `semanticBoolean()` 和 `semanticNumber()` 在 Zod 校验前处理常见的类型形态：

```typescript
// src/utils/semanticBoolean.ts：只把两个明确字符串转换成布尔值
export function semanticBoolean(inner = z.boolean()) {
  return z.preprocess(
    value =>
      value === 'true'
        ? true
        : value === 'false'
          ? false
          : value,
    inner,
  )
}
```

```typescript
// src/utils/semanticNumber.ts：只转换格式明确的数字字符串
return z.preprocess(value => {
  if (
    typeof value === 'string' &&
    /^-?\d+(\.\d+)?$/.test(value)
  ) {
    const number = Number(value)
    if (Number.isFinite(number)) {
      return number
    }
  }
  return value
}, inner)
```

它们修正的是无歧义的机械错误，例如 `"30"` 和 `30`；不会替模型决定“这个工具是否应该被调用”。

### 9.4 反馈层：错误信息要能让模型下一轮改对

一个好的工具错误至少要说明：

```text
哪个工具失败
哪个参数有问题
期望什么类型或状态
下一步应该怎么调整
```

这也是为什么延迟工具会附加 `SearchExtraTools` 指引，权限拒绝会明确说明“本次操作没有发生”，参数错误会指出缺失、额外或类型错误字段。

准确性防御的层次可以总结为：

```text
工具描述
  降低选错工具的概率

API Schema
  限制模型输出的结构

运行时 Schema
  拒绝不合法输入

无歧义容错
  修正字符串类型等机械错误

错误反馈
  让模型在下一轮自纠
```

## 十、哪些机制不能混为一谈

### 10.1 工具注册不等于权限授权

`getTools()` 把工具交给模型，并不代表这次调用一定能执行。

真正的权限边界位于 `checkPermissionsAndCallTool()` 中，且会结合当前输入、模式、Hook 和用户审批。

### 10.2 工具可见不等于工具 Schema 永久存在

延迟工具可能只在发现后才带完整 Schema。工具对象仍然在完整池中，但当前 API 请求不一定发送它的全部参数结构。

### 10.3 并发安全不等于只读

调度器读取的是 `isConcurrencySafe(input)`。不要从工具名字、是否只读或是否没有明显副作用自行推导并发能力。

### 10.4 工具失败不等于 Agent Loop 失败

普通工具错误会变成 `tool_result`，由模型决定下一步。用户中断、Hook 停止、预算限制和上下文窗口阻塞才是更高层的停止条件。

### 10.5 落盘结果不等于会话记忆

工具结果文件只是为大输出提供可回读的外部载体。它不会自动变成长期记忆，也不等于摘要或上下文压缩。

### 10.6 `tool_result` 不等于用户最终看到的文本

`tool_result` 首先是发回模型的观察结果。终端 UI、transcript 和 SDK 还可能使用工具自己的渲染函数展示不同版本。

## 十一、把整条链路串起来

一次普通工具调用可以按下面的时间线理解：

```text
1. 启动或请求装配阶段
   getAllBaseTools()
   → getTools()
   → assembleToolPool()
   → CORE_TOOLS / 延迟发现
   → toolToAPISchema()

2. 模型响应阶段
   模型输出 tool_use(name, input, id)

3. 编排阶段
   query.ts
   → StreamingToolExecutor 或 runTools()
   → partitionToolCalls()

4. 单次执行阶段
   runToolUse()
   → 查找工具和别名
   → abort 检查
   → safeParse
   → 输入补齐
   → PreToolUse
   → 权限决策
   → tool.call()
   → 结果映射
   → PostToolUse

5. 结果保护阶段
   processToolResultBlock()
   → 工具级阈值
   → 必要时落盘和预览
   → enforceToolResultBudget()

6. 回灌阶段
   tool_result(tool_use_id)
   → 下一轮模型请求
```

## 十二、读完后应该能回答的问题

### 问题一：为什么工具已经注册了，模型却不能直接调用？

因为“存在”不等于“当前请求可见”。工具可能被模式过滤、权限 deny 过滤，或在工具搜索模式下处于延迟发现状态。

### 问题二：为什么首轮只看到部分工具？

`CORE_TOOLS` 负责首轮常驻工具。其他工具可以在工具搜索启用时通过 `SearchExtraTools` 发现，再由 `ExecuteExtraTool` 或目标工具执行。

### 问题三：为什么参数错误不会直接终止 Agent Loop？

参数错误被格式化后生成 `is_error: true` 的 `tool_result`，模型可以根据反馈修正下一次调用。直接终止会浪费一次错误反馈本来可以完成的自纠机会。

### 问题四：为什么 `Read A` 和 `Read B` 可以并发，`Write C` 后面的读取却要等？

调度器按每次输入调用 `isConcurrencySafe()`，只把连续的并发安全调用放进同一批；非安全调用独占批次，串行完成后才进入下一批。

### 问题五：大结果为什么不直接截断？

完整结果会落盘，模型先收到约 2000 字节预览和文件路径。这样既保护上下文，又保留了按需精确读取的可能。

### 问题六：为什么 `tool_use_id` 必须保留？

同一轮可能多次调用同一个工具，只有 `tool_use_id` 能把每个结果和具体调用一一对应。

### 问题七：工具调用失败后，系统什么时候才会真正停止？

普通失败通常只回灌错误；用户中断、Hook 明确阻止继续、预算耗尽或上下文窗口达到阻塞条件，才可能让更高层循环停止。

## 总结

Claude Code 的工具系统不是一个简单的“工具列表 + 函数调用”，而是一条分层管线：

```text
工具定义
  → 工具池装配
  → 工具可见性和 Schema
  → 模型 tool_use
  → 批次调度
  → 参数、Hook、权限检查
  → tool.call()
  → 结果映射和大结果保护
  → tool_result 回灌
```

最值得记住的四个判断是：

```text
工具是否存在？
工具是否对模型可见？
这次调用是否有权限执行？
这次输入是否允许并发？
```

再加上一条运行时原则：

```text
能转成 tool_result 让模型自纠的错误，不要过早升级成整个 Agent Loop 的失败。
```

这条原则把工具层从“函数调用封装”提升成了 Agent Harness 的执行边界：它既要让模型获得能力，也要把能力的风险、顺序、失败和结果大小控制在可恢复的范围内。
