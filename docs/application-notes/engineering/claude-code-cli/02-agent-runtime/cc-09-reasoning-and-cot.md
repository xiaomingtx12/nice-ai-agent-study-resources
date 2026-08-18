---
slug: /application-notes/engineering/claude-code-cli/cc-09-reasoning-and-cot
sidebar_position: 9
title: "模型思考机制与推理控制"
description: "从 ThinkingConfig 三态配置出发，拆解 thinking 参数翻译、流式内容块、签名清理、上下文窗口治理、Effort 和 sideQuery 的协作边界。"
---

# 模型思考机制与推理控制

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变动，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **思考配置**：`src/utils/thinking.ts` 的 `ThinkingConfig`、`modelSupportsThinking()`、`modelSupportsAdaptiveThinking()` 和 `shouldEnableThinkingByDefault()` —— 统一表达思考开关、模型能力和默认值。
> - **启动装配**：`src/main.tsx` 的 thinkingConfig 初始化逻辑 —— 合并 CLI、环境变量和设置文件。
> - **循环透传**：`src/query.ts` 的 `queryLoop()` —— 将 `thinkingConfig`、`messages`、`tools` 和请求选项交给模型调用层。
> - **provider 分发**：`src/services/api/claude.ts` 的 `queryModel()` —— 按 provider 分发到 Anthropic、OpenAI、Gemini 和 Grok 路径。
> - **Anthropic 请求**：`src/services/api/claude.ts` 的 thinking 参数构造和流式事件处理 —— 负责 adaptive、固定预算、内容块和签名。
> - **OpenAI 兼容请求**：`src/services/api/openai/requestBody.ts` 的 `isOpenAIThinkingEnabled()`、`buildOpenAIRequestBody()`，以及 `src/services/api/openai/index.ts` —— 处理 DeepSeek、MiMo 等模型的 thinking 字段和工具调用。
> - **Responses API 适配**：`src/services/api/openai/responsesAdapter.ts` 的 `buildResponsesRequest()`、`adaptResponsesStreamToAnthropic()` —— 把 reasoning effort 和推理流转换成内部内容块。
> - **Gemini 请求**：`src/services/api/gemini/index.ts` 的 `queryModelGemini()` —— 将 `thinkingConfig` 转换成 Gemini 的 `generationConfig`。
> - **Grok 请求**：`src/services/api/grok/index.ts` 的 `queryModelGrok()` —— 复用 OpenAI 兼容的消息和工具调用，不额外发送 thinking 参数。
> - **消息清理**：`src/utils/messages.ts` 的消息规范化、AssistantMessage 合并、`filterOrphanedThinkingOnlyMessages()` 和 `stripSignatureBlocks()` —— 处理流式拆块、孤立 thinking 和签名失效。
> - **上下文治理**：`src/services/tokenEstimation.ts`、`src/utils/context.ts`、`src/services/compact/autoCompact.ts` —— 计算 thinking 占用、模型窗口和自动压缩阈值。
> - **裁剪与遗忘**：`src/services/compact/snipCompact.ts`、`src/commands/force-snip.ts` —— 通过 `snip_boundary` 和 UUID 改变模型可见消息投影。
> - **第三方兼容策略**：`src/services/providerRegistry/providerCompatMatrix.ts` 的 `applyCompatRule()` —— 定义 `thinking`、`reasoning_content` 等字段的保留或剥离规则。
> - **旁路调用**：`src/utils/sideQuery.ts` 和 `src/utils/sideQuestion.ts` —— 区分独立副查询与继承主上下文的临时 fork。

Claude Code 里的 thinking 不是一个简单的“打开 / 关闭”按钮。

它至少同时涉及：

- 应用层如何表达“允许思考、固定预算思考、完全关闭”；
- API 层如何把应用配置翻译成模型服务商能识别的参数；
- 流式响应如何把思考、文本和工具调用拆成内容块；
- 消息恢复时如何重新合并这些内容块；
- 为什么有些 thinking 必须清理，有些 thinking 只是暂时不显示；
- thinking 如何参与 token 估算、模型窗口检测和上下文压缩；
- Effort（推理投入程度）和 sideQuery（副查询）为什么不属于同一套开关。

本文不把 CoT（Chain of Thought，思维链）算法当作主线，而是分析 Claude Code 如何把模型原生 thinking（思考）能力接入 Agent Loop，并把它转换成可传输、可清理、可压缩和可控制的工程数据流。

## 一、先区分几个容易混淆的概念

### 1. thinking 不等于最终答案

一次模型响应可能包含三类内容：

```text
thinking  → 模型的思考内容块，用来分析当前任务
text      → 面向用户的自然语言回答
tool_use  → 面向工具层的调用请求
```

这三类内容可能出现在同一个 API 响应中，但职责不同。

例如，模型可以先输出 thinking，接着发起 `Read` 工具调用；工具返回结果后，模型再次思考，然后继续调用 `Edit`。因此，thinking 不是“最终答案前面的一段固定前缀”，而是 Agent Loop（Agent 循环）中间的一种内容块。

### 2. thinking 不是提示词里的“请一步一步思考”

Claude Code 的主 Agent 主要依赖模型原生的 thinking 能力。它不是把大段 `<analysis>` 文本拼进主提示词，再把这段文本当成思考。

不过，在一些旁路场景中仍然会使用提示词级的草稿区：

- compact 总结器可能要求模型先写 `<analysis>`，然后在写入摘要前剥离；
- 权限分类器在关闭原生 thinking 时，可能要求模型输出 `<thinking>`；
- Plan 模式把“先想后做”提升为一个独立流程，而不是只依靠模型自发思考。

这三类机制要分开理解：

```text
原生 thinking：API 内容块，进入消息处理链
提示词级草稿：文本标签，用完后剥离
流程级计划：独立 Agent 或审批流程，作为执行门槛
```

### 3. 常用但容易漏掉的术语

本文后面会反复使用以下术语：

- **content block（内容块）**：API 响应中最小的内容单元，例如 `thinking`、`text`、`tool_use`。
- **signature（签名）**：服务端为 thinking 内容生成的校验信息，用来证明该内容由对应凭证生成。
- **redacted thinking（遮蔽后的思考）**：服务端不返回明文，只返回密文数据的思考块。
- **interleaved thinking（交错式思考）**：工具结果返回后，模型可以立刻再次生成 thinking，而不是等整个轮次结束。
- **orphan message（孤立消息）**：找不到对应文本或工具调用兄弟消息的 thinking-only 消息。
- **fork（分叉 Agent）**：从主 Agent 的上下文创建一个临时执行分支。
- **provider（模型服务商）**：Anthropic、OpenAI、DeepSeek 等提供模型 API 的服务端。
- **wire shape（协议参数形状）**：真正发送到 API 请求体里的字段结构。
- **snip_boundary（裁剪边界标记）**：告诉后续消息投影哪些历史消息不再发送给模型的系统标记。
- **transcript（会话原始记录）**：保存完整消息和事件的持久化记录，不等于当前发送给模型的消息投影。
- **reasoning_content（推理内容字段）**：部分第三方模型在助手消息中返回的推理文本字段。
- **reasoning_text.delta（推理文本增量事件）**：Responses API 逐段返回推理文本的流式事件。
- **schema（调用结构）**：工具或参数必须遵守的字段、类型和层级约束。

`token`、`prompt cache`、`API` 这类常见技术词保留英文，避免把已有工程术语强行翻译成不自然的中文。

## 二、应用层：三态 ThinkingConfig 如何产生

### 2.1 三态不是三个 API 参数

`src/utils/thinking.ts` 中的 `ThinkingConfig` 有三个应用层状态：

```typescript
// src/utils/thinking.ts
export type ThinkingConfig =
  | { type: 'adaptive' }                    // 自适应思考
  | { type: 'enabled'; budgetTokens: number } // 固定思考预算
  | { type: 'disabled' }                    // 应用层关闭思考
```

这里的 `enabled` 表示“启用思考并给出预算”，并不意味着所有模型最终都会收到固定预算。

最终发送什么，要到 API 边界才能确定：

```text
应用层 adaptive
  → 支持 adaptive 的模型：{ type: "adaptive" }
  → 不支持 adaptive 的模型：{ type: "enabled", budget_tokens: N }

应用层 enabled + budgetTokens
  → 支持 adaptive 的模型：仍可能被翻译成 adaptive
  → 旧模型：使用固定 budget_tokens

应用层 disabled
  → 请求中省略 thinking 字段
```

所以，应用层三态和协议层的实际形状不是一一对应关系。

### 2.2 默认值、CLI 和环境变量

`main.tsx` 在启动阶段把多个入口收敛成一个 `thinkingConfig`。下面是保留主要逻辑后的代码：

```typescript
// src/main.tsx：启动阶段装配统一的 thinkingConfig
let thinkingEnabled = shouldEnableThinkingByDefault()

let thinkingConfig: ThinkingConfig =
  thinkingEnabled !== false
    ? { type: 'adaptive' }   // 默认允许自适应思考
    : { type: 'disabled' }   // 设置文件明确关闭时禁用

// CLI 参数优先于默认设置
if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
  thinkingConfig = { type: 'adaptive' }
} else if (options.thinking === 'disabled') {
  thinkingConfig = { type: 'disabled' }
}

// 环境变量优先于旧的 CLI budget 参数
const maxThinkingTokens = process.env.MAX_THINKING_TOKENS
  ? parseInt(process.env.MAX_THINKING_TOKENS, 10)
  : options.maxThinkingTokens

if (maxThinkingTokens !== undefined && maxThinkingTokens > 0) {
  thinkingConfig = {
    type: 'enabled',
    budgetTokens: maxThinkingTokens,
  }
}
```

这里有两个容易误读的地方。

第一，`--thinking enabled` 在 CLI 层会被映射成 `adaptive`。CLI 只表达“开启思考”，模型是否支持自适应由后面的能力判断负责。

第二，`MAX_THINKING_TOKENS` 只表示固定预算入口。它不会直接保证服务端一定按这个预算执行，因为支持 adaptive 的模型可能在 API 边界被翻译成自适应思考。

默认值来自 `shouldEnableThinkingByDefault()`：

```typescript
// src/utils/thinking.ts：没有显式关闭时默认开启
export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  return true
}
```

装配层只记录用户意图，不在这里判断模型能力。这是有意的职责分离：

```text
main.tsx：我想不想启用 thinking？
claude.ts：当前模型能不能用，应该用哪种协议形状？
```

### 2.3 模型能力判断：thinking 和 adaptive thinking（自适应思考）是两件事

模型能力至少要分两层：

```text
modelSupportsThinking(model)
  判断模型是否具备 thinking 能力

modelSupportsAdaptiveThinking(model)
  判断模型是否支持服务端自适应分配 thinking
```

一个模型可能支持 thinking，但不支持 adaptive thinking。此时仍然可以使用固定预算。

`thinking.ts` 的判断主要考虑：

- 3P 模型能力覆盖表；
- Anthropic 第一方模型；
- Foundry 代理模型；
- 已知模型名称的允许列表；
- 对未知模型字符串的 provider 默认策略。

因此不能简单写成“模型名里包含 `claude` 就支持 thinking”。模型名称、provider 和能力覆盖表共同决定结果。

### 2.4 native thinking、CoT 与 ReAct 的关系

这三个词经常被放在一起，但它们描述的不是同一层问题。

**CoT（Chain of Thought，思维链）**关注的是“模型如何表达推理过程”。

它可以通过提示词要求模型先分析再回答，也可以表现为模型输出的一段推理文本。CoT 本身不规定模型如何调用工具，也不规定这段推理是否能被下一轮 API 原样回放。

**ReAct（Reasoning and Acting，推理与行动）**关注的是 Agent 的控制流程：

```text
模型判断
  → 发起工具调用
  → 获得工具结果
  → 根据新结果再次判断
  → 继续调用工具或输出答案
```

因此，ReAct 不要求模型必须支持独立的 thinking 内容块。一个不支持 native thinking 的模型，只要还支持工具调用，也可以运行这种“模型调用 → 工具执行 → 结果回传”的循环。

**native thinking（模型原生思考能力）**关注的是模型 API 是否提供专门的思考协议。

例如 Anthropic 使用 `thinking` 内容块和 `thinking_delta` 流式事件；部分 OpenAI 兼容模型使用 `reasoning_content` 或 `thinking` 字段；ChatGPT Responses API 则使用 `reasoning.effort`（推理投入程度）请求参数和 `reasoning_text.delta` 事件。

可以用下面的关系理解：

```text
CoT
  解决“模型怎样表达推理”

ReAct
  解决“Agent 怎样和外部工具循环交互”

native thinking
  解决“API 怎样传输和控制模型原生推理”
```

它们可以叠加，但不能互相替代：

- native thinking 可以发生在 ReAct 循环内部；
- ReAct 可以在没有 native thinking 的模型上运行；
- 提示词 CoT 可以让普通模型尝试分步分析，但不会自动获得 thinking 签名、预算控制或专用流式事件；
- `thinking`、`reasoning_content` 和 `reasoning_text` 是不同 provider 的协议字段，不能直接当成同一个 API 参数。

## 三、Agent Loop 与 API 边界

### 3.1 `query.ts` 只透传，不做模式选择

Agent Loop 的任务是组织消息、调用工具、继续循环。它不应该重新解释 thinking 配置。

```typescript
// src/query.ts：Agent Loop 只把配置交给模型调用层
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    // 其他请求选项
  },
})) {
  // 消费模型流式消息
}
```

这样做的好处是，未来增加新的 thinking 模式时，Agent Loop 不需要知道协议细节。

### 3.2 `claude.ts` 把应用语义翻译成 wire shape

真正的翻译点在 `src/services/api/claude.ts`。核心判断可以简化为：

```typescript
// src/services/api/claude.ts：thinkingConfig → API thinking 参数
const hasThinking =
  thinkingConfig.type !== 'disabled' &&
  !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)

let thinking: BetaMessageStreamParams['thinking'] | undefined

if (hasThinking && modelSupportsThinking(options.model)) {
  const adaptiveEnabled =
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
    modelSupportsAdaptiveThinking(options.model)

  if (adaptiveEnabled) {
    // 支持 adaptive 的模型不发送固定 budget
    thinking = { type: 'adaptive' }
  } else {
    // 旧模型或被强制关闭 adaptive 时使用固定预算
    let thinkingBudget = getMaxThinkingTokensForModel(options.model)

    if (
      thinkingConfig.type === 'enabled' &&
      thinkingConfig.budgetTokens !== undefined
    ) {
      thinkingBudget = thinkingConfig.budgetTokens
    }

    // 至少给最终答案留出一个 token 的空间
    thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget)
    thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    }
  }
}

// disabled、全局关闭或模型不支持时，thinking 保持 undefined
```

这里有四个关键边界：

1. **关闭不是 `{ type: 'disabled' }`**。主循环 API 请求会直接省略 `thinking` 字段。
2. **支持 adaptive 的模型不会使用固定 budget**。这是服务端能力选择，不是客户端疏漏。
3. **固定预算不能等于 `maxOutputTokens`**。否则思考耗尽后没有空间生成文本。
4. **模型不支持 thinking 时不会强行发送参数**。能力判断先于参数构造。

最终请求对象使用条件字段：

```typescript
// 关闭 thinking 时，请求体中不出现 thinking 字段
return {
  model: normalizeModelStringForAPI(options.model),
  messages: messagesForAPI,
  system,
  tools: allTools,
  max_tokens: maxOutputTokens,
  ...(thinking !== undefined && { thinking }),
}
```

### 3.3 第三方模型不支持 thinking 时会怎样

先看结论：

```text
不支持 native thinking
  ≠ 不支持 ReAct
  ≠ 不支持工具调用
  ≠ Claude Code 完全无法运行
```

真正会发生什么，取决于第三方模型走哪条 provider 路径，以及它是否还支持工具调用。

#### 情况一：Anthropic 兼容端点不支持 thinking

对于仍然走 `claude.ts` 通用 Anthropic 请求路径的模型，能力判断会阻止 `thinking` 参数进入请求体：

```typescript
// src/services/api/claude.ts：模型不支持 thinking 时保持 undefined
const hasThinking =
  thinkingConfig.type !== 'disabled' &&
  !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)

let thinking: BetaMessageStreamParams['thinking'] | undefined

// 只有模型能力判断通过，才构造 thinking 参数
if (hasThinking && modelSupportsThinking(options.model)) {
  if (modelSupportsAdaptiveThinking(options.model)) {
    thinking = { type: 'adaptive' } // 支持自适应思考
  } else {
    const thinkingBudget = getMaxThinkingTokensForModel(options.model)
    thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget, // 旧模型使用固定预算
    }
  }
}

return {
  model: options.model,
  messages: messagesForAPI,
  tools: allTools,
  // thinking 为 undefined 时，请求体中完全不出现 thinking 字段
  ...(thinking !== undefined && { thinking }),
}
```

这条路径下的结果是：

- 不会产生 `thinking` 内容块；
- 不会产生 `thinking_delta` 和 `signature_delta`；
- UI 不会进入原生 thinking 的展示状态；
- `thinking budget` 对该模型不起作用；
- 如果模型仍支持 `tool_use`，Agent Loop 仍可以继续执行工具。

也就是说，执行路径会退化为：

```text
普通文本或 tool_use
  → tool_result
  → 下一轮模型调用
```

这是“没有 native thinking 的 ReAct 式循环”，而不是“没有 thinking 就不能循环”。

#### 情况二：OpenAI 兼容端点不支持 thinking

OpenAI 兼容路径不会直接使用 Anthropic 的 `ThinkingConfig` 生成请求。它会在 `requestBody.ts` 中通过模型名和环境变量判断是否开启兼容格式：

```typescript
// src/services/api/openai/requestBody.ts：判断是否给 OpenAI 兼容模型注入 thinking 字段
export function isOpenAIThinkingEnabled(model: string): boolean {
  // 显式关闭优先级最高
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) {
    return false
  }

  // 显式开启
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) {
    return true
  }

  // 默认只对已知的 DeepSeek / MiMo 模型自动开启
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}
```

当 `enableThinking` 为 `false` 时，请求体不会注入这些扩展字段：

```typescript
// thinking 关闭时，只保留普通 Chat Completions 请求
return {
  model,
  messages,
  tools,
  max_tokens: maxTokens,
  stream: true,
  stream_options: { include_usage: true },
  // 不发送 thinking、enable_thinking、chat_template_kwargs
}
```

如果模型支持工具调用，Agent Loop 仍然可以正常工作。区别主要在于：

- 不会得到统一的 `thinking` 内容块；
- OpenAI 流式适配器只会转出 `text` 和 `tool_use` 等已有事件；
- 复杂任务的规划、长链路错误恢复和工具选择质量可能下降；
- `OPENAI_ENABLE_THINKING=1` 不能把一个本身不支持 reasoning（推理能力）的模型变成推理模型。

如果用户强制开启，而端点又不认识这些自定义字段，就可能出现两种结果：

```text
端点忽略未知字段
  → 请求继续，但实际没有 native thinking

严格端点拒绝未知字段
  → 返回 400 等请求参数错误
```

因此，第三方模型接入时不能只看“是否能返回文本”，还要确认它接受哪些请求字段。

#### 情况三：模型支持 reasoning，但协议名称不同

第三方模型的“思考”不一定叫 `thinking`。

DeepSeek 可能返回 `reasoning_content`（推理内容字段），ChatGPT Responses API 则可能返回 `reasoning_text.delta`。Claude Code 会在适配层把它们转换成内部统一的 thinking 流：

```typescript
// src/services/api/openai/responsesAdapter.ts：
// Responses API 的 reasoning 文本转换成内部 thinking_delta
if (type === 'response.reasoning_text.delta') {
  yield {
    type: 'content_block_delta',
    index: currentContentIndex,
    delta: {
      type: 'thinking_delta',
      thinking: String(event.delta ?? ''),
    },
  }
}
```

但这只是协议适配，不代表所有 OpenAI 兼容模型都支持 reasoning（推理能力）。`providerCompatMatrix.ts` 定义了历史消息回放时的兼容策略：

```typescript
// src/services/providerRegistry/providerCompatMatrix.ts：
// 严格端点不接受 reasoning_content 时，回放前将其剥离
if (
  profile.reasoningContentEcho === 'strip' &&
  Array.isArray(result.messages)
) {
  result.messages = result.messages.map(msg => {
    if ('reasoning_content' in msg) {
      const { reasoning_content: _dropped, ...rest } = msg
      return rest
    }
    return msg
  })
}
```

这里的核心目的，是避免把一个推理模型留下的 `reasoning_content` 原样发送给不支持该字段的普通模型或严格端点。该文件提供的是纯函数和策略定义，是否在具体请求路径执行，要看调用方是否调用 `applyCompatRule()`。DeepSeek 还需要区分：

```text
thinking-only
  有 reasoning_content，没有工具调用

thinking+tools
  同时有 reasoning_content 和工具调用

normal
  两者都没有
```

#### 情况四：Gemini 和 Grok 的行为不同

Gemini 路径会把应用层配置转换成 Gemini 自己的 `generationConfig.thinkingConfig`：

```typescript
// src/services/api/gemini/index.ts：把应用层配置转换成 Gemini 协议
generationConfig: {
  ...(thinkingConfig.type !== 'disabled' && {
    thinkingConfig: {
      includeThoughts: true, // 请求返回思考内容
      ...(thinkingConfig.type === 'enabled' && {
        thinkingBudget: thinkingConfig.budgetTokens, // 固定预算
      }),
    },
  }),
}
```

这条路径当前没有完全复用 `modelSupportsThinking()` 的 Anthropic 能力判断。因此，某个 Gemini 模型是否支持该字段，最终由 Gemini 端点和模型能力决定：可能忽略，也可能返回参数错误。文章不能把 Anthropic 路径的“自动省略”规则直接套到所有 provider。

Grok 路径则直接使用 OpenAI 兼容的消息和工具协议，不额外发送 thinking 参数。它仍可以返回普通文本和工具调用；某些模型的 reasoning 由服务端自动完成，客户端不一定能看到独立的 thinking 内容块。

#### 最终要看两层能力

第三方模型接入时，应分别确认：

```text
第一层：模型是否支持 native thinking
  决定是否有 thinking / reasoning 内容、预算和专用流式事件

第二层：模型是否支持工具调用
  决定 Agent 是否能继续执行 Read、Edit、Bash 等工具
```

因此可能出现下面几种组合：

```text
支持 thinking + 支持工具
  → 完整的 native thinking + ReAct 循环

不支持 thinking + 支持工具
  → 没有 thinking 内容块，但仍可运行 ReAct 式工具循环

支持 thinking + 不支持工具
  → 可以回答和推理，但不能完成依赖外部操作的任务

不支持 thinking + 不支持工具
  → 只能作为普通问答模型使用，工具任务无法推进
```

这也解释了为什么接入第三方模型后，最常见的现象不是 Claude Code 立即崩溃，而是“工具还能用，但复杂任务质量下降”。只有在请求字段、工具调用 schema（调用结构）或历史 `reasoning_content` 与端点不兼容时，才更容易直接出现 400 错误。

### 3.4 主循环和 sideQuery 的关闭语义不同

主循环关闭 thinking 时是：

```typescript
thinking === undefined
```

而 `sideQuery()` 为了构造独立 API 请求，可以显式设置：

```typescript
// src/utils/sideQuery.ts：副查询自己构造独立的 thinking 参数
let thinkingConfig: BetaThinkingConfigParam | undefined

if (thinking === false) {
  thinkingConfig = { type: 'disabled' }
} else if (thinking !== undefined) {
  thinkingConfig = {
    type: 'enabled',
    budget_tokens: Math.min(thinking, max_tokens - 1),
  }
}
```

这不是互相矛盾，而是两个调用层的协议职责不同：

- 主循环由 `claude.ts` 统一决定“是否省略字段”；
- sideQuery 是一次性 API 包装器，自己拥有完整的请求参数构造权。

## 四、流式响应：一个响应为什么会变成多条 AssistantMessage

### 4.1 API 事件与应用消息不是同一层抽象

Anthropic streaming（流式传输）大致按下面的顺序发送事件：

```text
message_start
  → content_block_start
  → content_block_delta
  → content_block_stop
  → message_delta
  → message_stop
```

其中 `content_block_delta` 可能是：

- `thinking_delta`：追加思考文本；
- `signature_delta`：追加签名；
- `text_delta`：追加面向用户的文本；
- `input_json_delta`：追加工具调用参数的 JSON 片段。

应用层不会把所有内容等到 `message_stop` 才交给下游，而是以内容块为单位逐步产出。

### 4.2 `thinking_delta` 和 `signature_delta` 如何合并

`claude.ts` 会先在 `content_block_start` 阶段创建可变的块，再在 delta 阶段追加内容：

```typescript
// src/services/api/claude.ts：开始一个 thinking 内容块
case 'thinking':
  contentBlocks[part.index] = {
    ...part.content_block,
    thinking: '',    // 后续 thinking_delta 追加到这里
    signature: '',   // 即使暂时没有 signature_delta，也保留字段
  }
  break
```

```typescript
// src/services/api/claude.ts：处理 thinking 内容块的增量事件
case 'signature_delta':
  if (contentBlock.type !== 'thinking') {
    throw new Error('Content block is not a thinking block')
  }
  contentBlock.signature = delta.signature
  break

case 'thinking_delta':
  if (contentBlock.type !== 'thinking') {
    throw new Error('Content block is not a thinking block')
  }
  contentBlock.thinking += delta.thinking
  break
```

这里的 `signature` 不是普通文本。它是服务端校验 thinking 块的元数据，不能像普通字符串一样随便改写。

### 4.3 每个内容块先成为一条消息

一次响应如果包含 thinking、text 和 tool_use，流式过程中可能暂时表现为：

```text
AssistantMessage(id=msg_1, content=[thinking])
AssistantMessage(id=msg_1, content=[text])
AssistantMessage(id=msg_1, content=[tool_use])
```

这样做是为了尽早让 UI 和 Agent Loop 看到进度。

如果必须等整条响应结束，用户要等到所有 thinking 和工具调用都完成后才能看到任何中间状态；按内容块产出后，UI 可以立即进入“正在思考”状态，工具层也可以尽早准备。

因此，“同一个 API 响应”与“流式期间的一条 AssistantMessage”不是一对一关系。

### 4.4 `mergeAssistantMessages()` 负责还原完整 turn

流式拆块之后，下游仍然需要一条完整的助手消息。`messages.ts` 用相同的 API `message.id` 合并内容：

```typescript
// src/utils/messages.ts：合并同一个 API 响应拆出的消息
export function mergeAssistantMessages(
  a: AssistantMessage,
  b: AssistantMessage,
): AssistantMessage {
  return {
    ...a,
    message: {
      ...a.message,
      content: [
        ...(Array.isArray(a.message.content) ? a.message.content : []),
        ...(Array.isArray(b.message.content) ? b.message.content : []),
      ],
    },
  }
}
```

合并后才恢复为：

```text
AssistantMessage(
  id=msg_1,
  content=[thinking, text, tool_use]
)
```

这也是为什么下游不能简单使用：

```typescript
messages.find(message => message.type === 'assistant')
```

在 adaptive thinking 开启时，找到的第一条 AssistantMessage 可能只有 thinking，没有 text。`sideQuestion.ts` 中专门保留了这个问题的修复说明：提取副问题答案时，必须遍历所有 assistant content block，再拼接 text。

## 五、签名、孤立消息与凭证变化后的清理

### 5.1 为什么 thinking 不能像普通文本一样修改

普通 `text` 内容可以在应用层重新组织。

thinking block 则同时包含：

```text
thinking：思考文本
signature：与生成凭证绑定的校验签名
```

如果客户端修改了 thinking 文本却保留旧签名，服务端可能认为这个内容已经被篡改。

如果用户重新登录、切换 API key 或 OAuth token，旧凭证生成的签名也可能不再有效。此时不是“重新解释旧 thinking”，而是需要删除这些签名绑定块。

### 5.2 orphan thinking：真正无法合并的纯思考消息

流式过程中，每个内容块都是独立消息；恢复会话时，如果中间插入了 user message、附件或其他边界，就可能阻止同一个 `message.id` 的兄弟消息重新靠在一起。

于是历史里可能出现：

```text
assistant(id=msg_1, content=[thinking])
assistant(id=msg_1, content=[text])
```

如果 text 兄弟仍然存在，后续合并可以恢复。

如果只剩下：

```text
assistant(id=msg_1, content=[thinking])
```

这就是 orphan thinking-only message（孤立的纯思考消息）。

### 5.3 `filterOrphanedThinkingOnlyMessages()`

清理逻辑分两遍：

1. 先记录哪些 `message.id` 存在非 thinking 内容；
2. 再删除找不到非 thinking 兄弟的 thinking-only 消息。

```typescript
// src/utils/messages.ts：第一遍，收集有文本或工具调用的 message.id
const messageIdsWithNonThinkingContent = new Set<string>()

for (const msg of messages) {
  if (msg.type !== 'assistant') continue

  const content = msg.message?.content
  if (!Array.isArray(content)) continue

  const hasNonThinking = content.some(
    block =>
      block.type !== 'thinking' &&
      block.type !== 'redacted_thinking',
  )

  if (hasNonThinking && msg.message?.id) {
    messageIdsWithNonThinkingContent.add(msg.message.id)
  }
}
```

```typescript
// 第二遍：只删除真正没有兄弟可合并的 thinking-only 消息
const filtered = messages.filter(msg => {
  if (msg.type !== 'assistant') return true

  const content = msg.message?.content
  if (!Array.isArray(content) || content.length === 0) return true

  const allThinking = content.every(
    block =>
      block.type === 'thinking' ||
      block.type === 'redacted_thinking',
  )

  if (!allThinking) return true

  // 还有非 thinking 兄弟，保留给 normalizeMessagesForAPI() 合并
  if (msg.message?.id &&
      messageIdsWithNonThinkingContent.has(msg.message.id)) {
    return true
  }

  // 真正的孤立思考块会导致 API 拒绝修改 thinking blocks
  return false
})
```

这个规则不是“看到 thinking 就删除”，而是：

```text
有可合并的非 thinking 兄弟 → 保留
没有任何可合并兄弟 → 删除
```

### 5.4 `stripSignatureBlocks()`：凭证变化后的整块移除

`stripSignatureBlocks()` 会从 assistant 消息中移除：

- `thinking`；
- `redacted_thinking`；
- 开启 Connector Text 功能时的 `connector_text`。

```typescript
// src/utils/messages.ts：签名绑定内容不能跨凭证复用
export function stripSignatureBlocks(messages: Message[]): Message[] {
  let changed = false

  const result = messages.map(msg => {
    if (msg.type !== 'assistant') return msg

    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const filtered = content.filter(block => {
      if (isThinkingBlock(block)) return false
      if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(block)) {
        return false
      }
      return true
    })

    if (filtered.length === content.length) return msg

    changed = true
    return {
      ...msg,
      message: {
        ...msg.message,
        content: filtered,
      },
    }
  })

  return changed ? result : messages
}
```

这里返回空内容消息是有原因的：流式阶段的 thinking-only 消息可能只是同一个 API 响应的拆分兄弟。先把内容清空，后续合并和 orphan 清理才能继续处理，而不是让旧签名残留。

### 5.5 `redacted thinking` 为什么不能当作普通缺失数据

服务端可能把一部分思考返回为：

```typescript
{
  type: 'redacted_thinking',
  data: '<encrypted data>',
}
```

客户端看不到明文，但这块数据仍然是协议内容的一部分。

因此：

- UI 可以只显示“正在思考”；
- token 估算仍然会计算 `data`；
- 消息合并时把它视为 thinking 内容；
- 不能因为看不到文本就任意删除；
- 只有孤立、凭证失效或明确的上下文清理流程才会移除。

## 六、交错式 thinking、Ultrathink 与 Effort

这三个概念都和“模型更愿意推理”有关，但控制层次不同。

### 6.1 interleaved thinking：轮内分布方式

`interleaved thinking（交错式思考）`控制思考出现在一轮中的什么位置。

普通形态可能是：

```text
thinking → tool_use → tool_result → text
```

交错式形态可以是：

```text
thinking
  → tool_use
  → tool_result
  → thinking
  → tool_use
  → tool_result
  → text
```

它的价值是让模型在每个工具结果后重新判断方向，适合探索性任务。

`DISABLE_INTERLEAVED_THINKING=1` 只关闭对应的 beta header，不等于关闭 thinking：

```text
关闭 interleaved thinking
  ≠ 关闭 thinking
```

### 6.2 Ultrathink：提示词通道的当轮抬档

Ultrathink 不是新的 ThinkingConfig 类型，也不是新的 API `thinking` 参数。

它的触发链是：

```text
用户输入包含 ultrathink
  → 关键词检测
  → 生成 ultrathink_effort attachment
  → 渲染成 system-reminder
  → 告诉模型当前轮使用 high effort
```

关键词检测代码如下：

```typescript
// src/utils/thinking.ts：单词边界匹配，大小写不敏感
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}
```

它和 `/effort high` 的差异是：

```text
/effort high
  → 参数通道
  → session 内持续
  → 影响 output_config.effort

ultrathink
  → 提示词 attachment 通道
  → 只影响当前 turn
  → 不直接修改 thinking 字段
```

因此不能把 Ultrathink 解释成“固定增加 N 个 thinking token”。它表达的是当轮提高整体推理投入的意图。

### 6.3 Effort：整体推理投入程度

Effort 是第二个推理强度旋钮。它不等于 thinking budget：

```text
thinking budget
  约束思考内容最多使用多少 token

effort
  表达模型整体愿意投入多少推理和完成度
```

支持的档位是：

```typescript
// src/utils/effort.ts
export const EFFORT_LEVELS = [
  'low',    // 低投入
  'medium', // 中等投入
  'high',   // 高投入
  'xhigh',  // 极高投入
  'max',    // 最大投入
] as const
```

### 6.4 Effort 的来源和优先级

`resolveAppliedEffort()` 把不同入口收敛成最终值：

```typescript
// src/utils/effort.ts：环境变量 > session 状态 > 模型默认值
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()

  // unset / auto 表示明确不发送 effort 参数
  if (envOverride === null) {
    return undefined
  }

  const resolved =
    envOverride ??
    appStateEffortValue ??
    getDefaultEffortForModel(model)

  // OpenAI Responses 的最高公开档是 xhigh
  if (
    resolved === 'max' &&
    getAPIProvider() === 'openai' &&
    isChatGPTAuthMode() &&
    modelSupportsXhighEffort(model)
  ) {
    return 'xhigh'
  }

  return resolved
}
```

调用优先级可以写成：

```text
CLAUDE_CODE_EFFORT_LEVEL
  → /effort 或 session 状态
  → 当前模型默认档
  → undefined
```

当最终值为 `undefined` 时，API 不发送用户指定的 effort 参数，服务端使用默认行为。

### 6.5 Effort 的 API 接线

Effort 是 API 的输出配置，不是 `thinking` 对象的子字段：

```typescript
// src/services/api/claude.ts：Effort 通过 output_config 接入
if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
  return
}

if (typeof effortValue === 'string') {
  outputConfig.effort = effortValue
  betas.push(EFFORT_BETA_HEADER)
}
```

这解释了为什么下面两种请求不能混写：

```typescript
thinking: {
  type: 'enabled',
  budget_tokens: 4096,
}

output_config: {
  effort: 'high',
}
```

前者控制思考块的预算模式，后者控制整体推理投入。两者可以同时存在，也可以分别关闭。

## 七、thinking 如何影响上下文窗口和“遗忘”

这一节是全文最容易被误解的部分。

### 7.1 thinking 会占用上下文窗口

`microCompact.ts` 的本地估算会计算：

- 普通 `thinking` 的文本；
- `redacted_thinking` 的 `data`；
- 文本、工具调用和工具结果。

但它不会把 thinking 的 JSON 包装层和 signature 元数据当作模型文本重复计算。

```typescript
// src/services/compact/microCompact.ts：思考内容参与 token 估算
if (block.type === 'thinking') {
  // 统计思考文本，不统计 JSON wrapper 和 signature
  totalTokens += roughTokenCountEstimation(block.thinking)
} else if (block.type === 'redacted_thinking') {
  // 看不到明文，也仍然要估算遮蔽数据占用
  totalTokens += roughTokenCountEstimation(block.data)
}
```

因此，“thinking 不占 context window”是不正确的。

### 7.2 模型窗口检测不是一个简单的 `token > max`

模型窗口检测至少涉及三层：

```text
模型原始 context window
  - compact 摘要输出预留
  = effective context window（有效上下文窗口）

有效上下文窗口
  - 自动压缩 buffer
  = 常规自动压缩阈值

有效上下文窗口
  - 本轮预计增长
  = 预测式自动压缩阈值
```

`getContextWindowForModel()` 会综合：

- 模型名称中的 `[1m]` 显式后缀；
- 模型能力表中的 `max_input_tokens`；
- 1M context beta；
- 1M 实验灰度；
- `CLAUDE_CODE_DISABLE_1M_CONTEXT`；
- 内部用户的 context window 覆盖值。

```typescript
// src/utils/context.ts：模型窗口的解析顺序
export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  if (process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    const override = parseInt(
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      10,
    )
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] 是显式的客户端选择
  if (has1mContext(model)) {
    return 1_000_000
  }

  const capability = getModelCapability(model)
  if (capability?.max_input_tokens &&
      capability.max_input_tokens >= 100_000) {
    return capability.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) &&
      modelSupports1M(model)) {
    return 1_000_000
  }

  return MODEL_CONTEXT_WINDOW_DEFAULT
}
```

自动压缩还要为摘要输出预留空间：

```typescript
// src/services/compact/autoCompact.ts
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    20_000,
  )

  return getContextWindowForModel(model, getSdkBetas()) -
    reservedTokensForSummary
}
```

查询循环还会提前预测本轮增长：

```typescript
// src/query.ts：在真正请求 API 前做预测式自动压缩
const currentTokens =
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed

const estimatedGrowth = estimateMaxTurnGrowth(model)
const predictiveThreshold =
  getEffectiveContextWindowSize(model) - estimatedGrowth

if (currentTokens > predictiveThreshold) {
  // 预计本轮会越过有效窗口，先尝试压缩
  await deps.autocompact(messagesForQuery, toolUseContext, ...)
}
```

这也是为什么 `tokenCountWithEstimation()` 要特别处理 thinking 和流式拆分的 AssistantMessage：它需要估算“下一次请求将要发送的完整上下文”，而不是只看最后一条输出。

### 7.3 snip_boundary：按 UUID 裁剪，不负责总结

`snip_boundary` 与自动摘要不是同一种压缩。

`/force-snip` 会创建一条系统消息，并记录待删除消息的 UUID：

```typescript
// src/commands/force-snip.ts：插入裁剪边界
const boundaryMessage: Message = {
  type: 'system',
  subtype: 'snip_boundary',
  content: '[snip] Conversation history before this point has been snipped.',
  isMeta: true,
  timestamp: new Date().toISOString(),
  uuid: randomUUID(),
  snipMetadata: {
    removedUuids,
  },
}
```

下一次查询时，`snipCompactIfNeeded()` 根据这些 UUID 生成面向模型的消息投影：

```typescript
// src/services/compact/snipCompact.ts：只过滤指定 UUID
const removedSet = new Set(removedUuids)
const kept: Message[] = []

for (const msg of messages) {
  if (removedSet.has(msg.uuid)) {
    tokensFreed += estimateMessageTokens(msg)
    continue
  }
  kept.push(msg)
}

return {
  messages: kept,
  executed: true,
  tokensFreed,
  boundaryMessage,
}
```

`snip_boundary` 的语义是：

```text
后续模型请求不再看到这些消息
```

它不等于：

```text
完整历史已经从所有存储中物理删除
```

REPL 仍可能保留完整滚动历史，transcript 也可能保留原始记录；snip 主要改变的是“模型可见消息投影”。

### 7.4 compaction 会怎样“遗忘” thinking

thinking 的遗忘不是单一动作，而是有几种不同结果：

#### 情况一：UI 隐藏，但消息仍然存在

`AssistantThinkingMessage` 在非 verbose 模式下可以只显示“Thinking”，甚至在一段时间后隐藏内容。

这只是渲染层行为：

```text
UI 不显示
  ≠ messages 中不存在
  ≠ transcript 中不存在
```

#### 情况二：microCompact 清理旧工具结果，但不等于摘要 thinking

microCompact 主要处理旧工具结果和大块上下文。thinking 是否会被删除，要看具体清理规则，不能笼统说“microCompact 会删除所有思考”。

#### 情况三：auto compact 用摘要替换旧上下文

长会话触发自动压缩后，旧消息会被摘要消息替代。此时模型下一轮看到的是：

```text
摘要后的历史
  + 压缩点之后保留的消息
```

早期 thinking 的原文通常不再出现在模型上下文里，但它可能仍然存在于 transcript 或归档文件中。

#### 情况四：snip 直接让指定消息离开模型投影

snip 不生成摘要，不解释被裁剪内容。被 snip 的 thinking 和其他消息一样，直接不再进入后续模型请求。

#### 情况五：凭证变化或孤立清理导致 thinking 被移除

旧 signature 失效、thinking-only 消息找不到非 thinking 兄弟时，客户端会主动清理。

所以，“遗忘”应当分成三层：

```text
显示遗忘：UI 隐藏
上下文遗忘：压缩或 snip 后不再发给模型
存储遗忘：transcript 或归档文件也被删除
```

Claude Code 的这些路径并不总是同时发生。很多时候只是上下文遗忘，原始 transcript 仍然存在。

## 八、sideQuery 与 sideQuestion：两种隔离方式

### 8.1 sideQuery：不读主会话，也不写主会话

`sideQuery()` 是独立 API 包装器，典型用途包括：

- 从记忆目录中挑出相关文件；
- 把中文查询转换成英文检索关键词；
- 给权限弹窗生成风险解释；
- 给 auto mode 做安全分类；
- 生成会话标题或工具摘要。

调用方现场构造一次性 `messages`，拿到结果后立即解析：

```typescript
// src/utils/sideQuery.ts：一次性旁路调用
const response = await sideQuery({
  querySource: 'session_search',
  model,
  system: SEARCH_PROMPT,
  messages: [
    {
      role: 'user',
      content: query,
    },
  ],
  max_tokens: 1024,
  thinking: false,
})
```

sideQuery 的隔离契约是：

```text
不进入主 messages
不写主 transcript
不改变主 Agent 的 prompt cache
独立记录 querySource、token 和耗时
```

它还负责统一处理 OAuth attribution（归因头）、模型 provider 路由和 beta header。调用方不应该直接散落 `client.beta.messages.create()`，否则容易漏掉这些基础设施。

### 8.2 sideQuestion：读取主上下文，但不回写主上下文

`/btw` 使用 `runSideQuestion()`。它不是完全无状态的 sideQuery，而是从主 Agent fork 出一个临时分支：

```typescript
// src/utils/sideQuestion.ts：副问题使用 fork，但不覆盖 thinkingConfig
const agentResult = await runForkedAgent({
  promptMessages: [createUserMessage({ content: wrappedQuestion })],
  cacheSafeParams,
  canUseTool: async () => ({
    behavior: 'deny',
    message: 'Side questions cannot use tools',
    decisionReason: {
      type: 'other',
      reason: 'side_question',
    },
  }),
  querySource: 'side_question',
  forkLabel: 'side_question',
  maxTurns: 1,
  skipCacheWrite: true,
})
```

它有三个边界：

1. **继承主线程的 thinkingConfig**。因为 thinkingConfig 是 Prompt Cache key 的一部分，覆盖它会破坏缓存前缀。
2. **禁止工具**。副问题只能基于已有上下文回答。
3. **只跑一轮并跳过 cache write**。这个分支不会成为未来主线程的缓存前缀。

两者可以用一句话区分：

```text
不需要主会话上下文 → sideQuery
需要主会话上下文，但不希望打扰主循环 → sideQuestion
```

### 8.3 副查询为什么通常关闭 thinking

很多 sideQuery 是格式转换、命名、检索词生成等低风险任务。它们的请求通常会设置：

```text
小模型
较小 max_tokens
thinking disabled
结构化输出或强制工具输出
```

这样做不是说旁路模型不能推理，而是把推理预算留给错误代价更高的任务。例如安全分类失败时可能 fail-closed（失败即拦截），而普通关键词转换失败则可以返回原文。

## 九、用户控制入口

### 9.1 Thinking 开关

常见入口和作用如下：

```text
--thinking adaptive|enabled|disabled
  启动时的临时选择

--max-thinking-tokens N
  固定预算入口

MAX_THINKING_TOKENS=N
  环境级固定预算覆盖

CLAUDE_CODE_DISABLE_THINKING=1
  全局关闭 thinking

CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
  保留 thinking，但强制固定预算路径

DISABLE_INTERLEAVED_THINKING=1
  关闭交错式 thinking，不关闭普通 thinking
```

三个环境变量的语义相互独立：

```text
关闭 adaptive
  不等于关闭 interleaved

关闭 interleaved
  不等于关闭 thinking

关闭 thinking
  会让 thinking 内容块不再产生
```

### 9.2 Effort 入口

```text
/effort low
/effort medium
/effort high
/effort xhigh
/effort max

CLAUDE_CODE_EFFORT_LEVEL=low
```

外部用户的 `max` 可能只在当前 session 生效，不能简单假定所有档位都会落盘。

### 9.3 UI 可见性

UI 处理 thinking 时要区分“状态”和“正文”：

```text
thinking_delta
  → 累积到 streamingThinking
  → 不写入普通 streamingText

完整 thinking block
  → AssistantThinkingMessage
  → 非 verbose 模式可以只显示状态

UI 超时隐藏
  → 只影响渲染
  → 不代表消息从 transcript 消失
```

因此，用户在终端看不到完整 thinking，不代表模型没有产生 thinking，也不代表上下文中已经删除。

## 十、把整条链路串起来

一个完整 turn 可以概括为：

```text
1. main.tsx
   CLI / 环境变量 / settings
   → ThinkingConfig 三态

2. query.ts
   → 原样透传给 callModel

3. claude.ts
   → 判断模型能力
   → adaptive / fixed / omitted
   → 组装 API 请求

4. streaming
   → thinking_delta / signature_delta / text_delta / tool input
   → 按 content block 产出 AssistantMessage

5. messages.ts
   → 按 message.id 合并
   → 过滤 orphan thinking
   → 凭证变化时移除签名绑定块

6. context governance（上下文治理）
   → thinking 计入 token 估算
   → 模型窗口检测
   → predictive autocompact
   → compact 或 snip 投影

7. UI / transcript
   → UI 选择性显示
   → transcript 持久化
```

其中最重要的工程边界有五条：

1. **应用配置不等于 API 参数**。三态 `ThinkingConfig` 要经过模型能力判断才能变成协议形状。
2. **流式拆块不等于消息最终形态**。同一个 API 响应可能暂时对应多条 AssistantMessage，必须按 `message.id` 合并。
3. **thinking 文本不等于 signature**。文本和签名的生命周期不同，凭证变化时必须整块处理。
4. **UI 隐藏不等于上下文删除**。显示、模型投影和 transcript 持久化是三个不同层次。
5. **压缩不等于一种“遗忘”**。摘要、snip、孤立清理、凭证清理分别对应不同的删除或替换语义。
6. **没有 native thinking 不等于没有 Agent 循环**。只要工具调用协议仍然可用，模型仍可以通过 ReAct 式循环完成工具任务。

## 十一、读完后应该能回答的问题

### 问题一：为什么我配置了固定 budget，模型却走 adaptive？

因为应用层的 `enabled + budgetTokens` 只是意图。API 边界发现模型支持 adaptive 后，会优先发送：

```typescript
{ type: 'adaptive' }
```

只有模型不支持 adaptive，或者显式设置 `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`，才会走固定 `budget_tokens`。

### 问题二：为什么 thinking-only 消息会被清理？

因为流式响应按内容块拆消息。一个只有 thinking 的消息可能只是完整 AssistantMessage 的拆分兄弟；如果恢复后找不到任何 text 或 tool_use 兄弟，它就无法安全回传给 API，可能触发：

```text
thinking blocks cannot be modified
```

此时清理的是孤立块，不是所有 thinking。

### 问题三：模型窗口检测是否只计算 text？

不是。thinking、redacted thinking、tool_use、tool_result 都会进入本地 token 估算。模型窗口检测还要扣除摘要输出预留和本轮预计增长。

### 问题四：`snip_boundary` 是不是已经删除了完整历史？

不是。它主要改变后续模型请求的消息投影，利用 UUID 列表排除指定消息。UI 或 transcript 是否保留完整历史，要看对应的持久化和展示路径。

### 问题五：长会话后 thinking 到底有没有“遗忘”？

要看是哪一种：

```text
UI 隐藏       → 只是不显示
compact 摘要  → 模型上下文中被摘要替换
snip          → 被指定消息离开模型投影
orphan 清理   → 无法合并的孤立 thinking 被删除
凭证变化      → 旧签名绑定块被删除
```

不能把这些行为统称为“模型把思维链忘了”，更准确的说法是：不同清理路径让 thinking 在不同层次停止显示、停止发送或被替换。

### 问题六：第三方模型不支持 thinking，还能不能使用 Claude Code？

通常可以，但要分开检查两个能力：

```text
不支持 native thinking
  → 不产生 thinking 内容块，thinking budget 不生效

仍支持工具调用
  → Agent Loop 继续执行 Read、Edit、Bash 等工具

连工具调用也不支持
  → 只能完成普通问答，工具任务无法推进
```

如果第三方端点是严格协议，还要确认它不会拒绝 `thinking`、`enable_thinking` 或 `reasoning_content` 等未知字段。自动关闭字段和强制开启字段的结果可能完全不同。

## 总结

Claude Code 的 thinking 系统可以看成一条“配置到上下文治理”的数据链：

```text
用户意图
  → ThinkingConfig
  → provider / 模型能力判断
  → provider 专用 thinking / reasoning 参数
  → streaming 内容块
  → AssistantMessage 合并
  → signature / orphan 清理
  → token 估算和窗口检测
  → compact / snip
  → UI 与 transcript
```

Effort 是独立的整体推理投入参数，Ultrathink 是当轮提示词通道，sideQuery 是旁路模型调用，sideQuestion 是继承上下文的临时 fork。第三方模型即使没有 native thinking，只要保留工具调用能力，也可以运行 ReAct 式 Agent Loop；只是推理内容、预算控制和复杂任务质量可能不同。

真正值得记住的不是某个环境变量，而是三个判断：

```text
这个配置属于应用层还是协议层？
这个内容块属于流式中间态还是最终消息？
这次“遗忘”发生在 UI、模型上下文，还是持久化历史？
```
