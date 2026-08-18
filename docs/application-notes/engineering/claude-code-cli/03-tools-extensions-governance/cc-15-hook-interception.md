---
slug: /application-notes/engineering/claude-code-cli/cc-15-hook-interception
sidebar_position: 15
title: "Hook 事件与拦截：生命周期规则如何进入 Agent"
description: "从 27 个事件、输入输出契约、配置匹配、并行执行和结果合并出发，拆解 Claude Code Hook 的真实实现边界。"
---

> Hook 的价值不是“再加一个回调函数”，而是把原本需要模型记住的确定性规则，放到 Agent Loop（Agent 循环）之外，在关键生命周期节点重新检查。
>
> **Harness 层定位**：Hook 位于 Agent Loop 的生命周期扩展边界。它可以观察事件、阻止继续、修改工具输入、注入上下文或返回权限建议，但每种事件能做什么由自己的输入输出契约决定。

# Hook 事件与拦截：生命周期规则如何进入 Agent

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **事件定义**：`src/entrypoints/sdk/coreSchemas.ts` 的 `HOOK_EVENTS` 和各类 `*HookInputSchema` —— 当前定义 27 个 Hook 事件，以及每个事件的输入字段。
> - **统一执行器**：`src/utils/hooks.ts` 的 `executeHooks()` —— 负责全局开关、workspace trust（工作区信任）、配置匹配、并行执行和结果回灌。
> - **非 REPL 执行器**：同文件的 `executeHooksOutsideREPL()` —— 处理通知、会话结束等不需要向模型 yield 结果的场景。
> - **事件入口**：`executePreToolHooks()`、`executePostToolHooks()`、`executeStopHooks()`、`executeSessionStartHooks()` 等 `executeXxxHooks()` 函数 —— 负责构造事件专属 `hookInput`，并调用统一执行器。
> - **配置合并与匹配**：`src/utils/hooks/hooksConfigSnapshot.ts` 的托管配置闸门，以及 `hooks.ts` 的 `getHooksConfig()`、`hasHookForEvent()`、`getMatchingHooks()` —— 处理 snapshot、注册 Hook、session Hook、matcher、`if` 条件和去重。
> - **输出解析**：`src/utils/hooks.ts` 的 `parseHookOutput()`、`parseHttpHookOutput()`、`processHookJSONOutput()` —— 把命令、Prompt、HTTP 和 callback 的结果转换成统一的 Hook 结果。
> - **执行体**：`src/utils/hooks/execPromptHook.ts`、`execAgentHook.ts`、`execHttpHook.ts`，以及 `hooks.ts` 中的命令、callback、function Hook 分支。
> - **Goal 边界**：`src/hooks/useGoalContinuation.ts`、`src/services/goal/goalState.ts`、`src/services/goal/prompts.ts` —— `/goal` 使用 idle continuation（空闲后自动续跑）和状态机，不是 `executeHooks()` 的另一种 Hook。

## 为什么需要 Hook

有些规则不适合写进 Prompt。

例如：

- 每次执行 `Bash` 前都检查命令是否符合组织策略；
- 每次 `Write` 后运行格式化或审计脚本；
- 工具调用命中敏感目录时必须阻止；
- Agent 想结束时，先检查测试结果；
- MCP server 请求用户确认时，交给外部策略决定接受还是拒绝。

如果这些规则只存在于 Prompt 中，会遇到三个问题。

### 1. 模型可能忘记

长会话会发生摘要、上下文裁剪和消息重排。规则即使写进 system prompt，也不能把它变成一个具有强制执行力的程序。

Hook 直接在生命周期节点执行，不依赖模型是否记得那段文字。

### 2. 模型可能误判

模型会根据语义推理“这次应该没问题”，但格式校验、路径限制和审计记录往往需要确定性判断。

例如“禁止删除 `.git` 目录”不应该交给模型判断“这个路径是不是临时目录”，而应该让 Hook 对路径做直接匹配。

### 3. 规则不应该重复消耗 token

所有请求都携带同一套长规则，会增加 Prompt 体积和 token 消耗。把规则放到外部 Hook 后，模型只接收当前事件真正需要回灌的结果。

因此，Hook 不是为了替代模型，而是把“确定性约束”从模型推理中拿出来。

---

## 一、先分清事件模型

### 1.1 当前不是 21 个事件，而是 27 个

当前 `HOOK_EVENTS` 定义了 27 个事件：

```text
PreToolUse
PostToolUse
PostToolUseFailure
Notification
UserPromptSubmit
SessionStart
SessionEnd
Stop
StopFailure
SubagentStart
SubagentStop
PreCompact
PostCompact
PermissionRequest
PermissionDenied
Setup
TeammateIdle
TaskCreated
TaskCompleted
Elicitation
ElicitationResult
ConfigChange
WorktreeCreate
WorktreeRemove
InstructionsLoaded
CwdChanged
FileChanged
```

旧稿把事件数量写成 21 个，已经跟当前 `src/entrypoints/sdk/coreSchemas.ts` 不一致。更适合按职责分组理解：

| 分组 | 事件 | 关注点 |
|---|---|---|
| 工具与权限 | `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied` | 工具调用前后、权限请求和权限拒绝 |
| Prompt 与循环 | `UserPromptSubmit`、`Stop`、`StopFailure`、`PreCompact`、`PostCompact` | 用户输入、循环停止、压缩前后 |
| 会话生命周期 | `SessionStart`、`SessionEnd`、`Setup`、`ConfigChange`、`InstructionsLoaded`、`CwdChanged`、`FileChanged` | 会话启动、配置变化、指令加载和工作目录变化 |
| 子 Agent 与协作 | `SubagentStart`、`SubagentStop`、`TeammateIdle`、`TaskCreated`、`TaskCompleted` | 子 Agent 和协作任务状态 |
| MCP 与工作树 | `Elicitation`、`ElicitationResult`、`WorktreeCreate`、`WorktreeRemove` | MCP 询问、工作树创建和清理 |
| 通知 | `Notification` | 对外通知，不一定回到模型循环 |

分组只是帮助阅读，不代表这些事件共享完全相同的输入输出能力。

### 1.2 事件能做什么，取决于契约

可以把事件按“拦截时机”粗略分成三类：

```text
执行前：
  PreToolUse、PermissionRequest、TaskCreated 等
  还有机会阻止、要求确认或修改输入

执行后：
  PostToolUse、PostToolUseFailure、PermissionDenied 等
  主要用于注入上下文、替换结果或触发重试

生命周期转换：
  Stop、SubagentStop、TeammateIdle、SessionEnd 等
  影响循环是否继续、任务是否结束或资源是否清理
```

这不是一个“所有 Hook 都能返回 block”的系统。

例如：

- `PreToolUse` 可以通过 `permissionDecision` 返回 `allow`、`deny` 或 `ask`，也可以返回 `updatedInput`；
- `PostToolUse` 发生在工具调用之后，不能撤销已经发生的副作用，但可以补充上下文或替换 MCP 工具输出；
- `Stop` 可以通过 `decision: "block"` 或 `continue: false` 阻止结束；
- `SessionEnd` 通常在 REPL（交互循环）之外执行，结果不会通过 generator 直接回灌给模型；
- `Elicitation` 和 `ElicitationResult` 返回的是 MCP 交互动作，不是普通工具权限结果。

所以阅读 Hook 时，第一步不是看执行器，而是先看对应的 `HookInputSchema` 和输出字段。

### 1.3 四种“结果语义”不要混在一起

Hook 结果至少包含四种不同性质的信号：

| 信号 | 作用 | 典型消费者 |
|---|---|---|
| `permissionBehavior` | 工具调用权限建议 | 权限与工具执行链路 |
| `blockingError` | 阻止当前生命周期动作，并提供原因 | Agent Loop 或任务执行器 |
| `additionalContext` | 给后续模型上下文增加信息 | 下一轮模型消息 |
| `updatedInput` | 修改工具输入或特定结果 | 工具执行器 |

`deny` 不一定等于“整个 Agent 终止”，`additionalContext` 也不等于“允许工具继续”。它们由不同字段表达，不能用一个统一的布尔值替代。

---

## 二、输入输出契约

### 2.1 所有事件共享一组基础字段

`createBaseHookInput()` 会为 Hook 输入提供一组公共字段：

```typescript
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  agentInfo?: { agentId?: string; agentType?: string },
) {
  return {
    session_id: sessionId ?? getSessionId(),
    transcript_path: getTranscriptPathForSession(sessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: agentInfo?.agentType,
  }
}
```

这些字段表达的是 Hook 运行上下文：

- `session_id`：当前主会话或子会话标识；
- `transcript_path`：对话记录文件路径；
- `cwd`：当前工作目录；
- `permission_mode`：当前权限模式；
- `agent_id`：如果事件发生在子 Agent 内，表示具体子 Agent；
- `agent_type`：Agent 类型名称，例如代码审查 Agent。

`agent_id` 和 `agent_type` 不是同一个概念。一个主线程可以带有 `agent_type`，但没有 `agent_id`；真正发生在子 Agent 内时，通常两者都会出现。

### 2.2 `PreToolUse` 的输入和输出

`executePreToolHooks()` 会先做 fast-skip（快速跳过）：

```typescript
export async function* executePreToolHooks(
  toolName,
  toolUseID,
  toolInput,
  toolUseContext,
  permissionMode,
) {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()

  // 没有任何可能匹配的 Hook 时，不创建完整 hookInput
  if (!hasHookForEvent('PreToolUse', appState, sessionId)) return

  const hookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    toolUseContext,
  })
}
```

`PreToolUse` 的专属输出可以是：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "禁止删除 .git 目录",
    "updatedInput": {
      "command": "git status"
    },
    "additionalContext": "已执行安全检查"
  }
}
```

这里的三个字段职责不同：

- `permissionDecision`：建议允许、拒绝或询问；
- `updatedInput`：希望工具使用的新输入；
- `additionalContext`：传递给后续模型上下文的补充内容。

Hook 返回 `updatedInput` 并不代表一定会执行新输入。最终是否采用，仍由调用方对 `permissionBehavior` 和工具执行结果的处理决定。

### 2.3 Stop 与 SubagentStop 的输入不同

`executeStopHooks()` 根据是否传入 `subagentId`，选择 `Stop` 或 `SubagentStop`：

```typescript
const hookEvent = subagentId ? 'SubagentStop' : 'Stop'

const hookInput = subagentId
  ? {
      ...createBaseHookInput(permissionMode),
      hook_event_name: 'SubagentStop',
      stop_hook_active: stopHookActive,
      agent_id: subagentId,
      agent_transcript_path: getAgentTranscriptPath(subagentId),
      agent_type: agentType ?? '',
      last_assistant_message: lastAssistantMessage,
    }
  : {
      ...createBaseHookInput(permissionMode),
      hook_event_name: 'Stop',
      stop_hook_active: stopHookActive,
      last_assistant_message: lastAssistantMessage,
    }
```

`stop_hook_active` 是防递归标记。它表达“Stop Hook 已经参与过一次停止判断”，用于避免 Stop Hook 每次阻止停止后又无限触发自己。

### 2.4 输出分为同步和异步

`hookJSONOutputSchema` 支持两种顶层形态：

```json
{
  "async": true,
  "asyncTimeout": 30000
}
```

或普通同步 JSON：

```json
{
  "decision": "approve",
  "reason": "检查通过",
  "continue": true,
  "systemMessage": "审计完成"
}
```

`async: true` 的含义是“先让主流程继续，Hook 在后台运行”。配置型命令 Hook 默认可以被 background（转入后台）；某些调用方通过 `forceSyncExecution` 强制等待异步 Hook 完成。

异步不是“Hook 返回值以后再自动参与当前决策”。它的关键语义是把执行生命周期和当前 Agent Loop 解耦，适合日志、通知等不应该阻塞主流程的工作。

### 2.5 JSON、纯文本和退出码

命令 Hook 的解析顺序可以概括为：

```text
stdout 为空或不以 "{" 开头
  → 视为普通文本

stdout 以 "{" 开头且符合 schema
  → 进入结构化结果解析

stdout 以 "{" 开头但不符合 schema
  → validationError，记为 non_blocking_error
```

在此基础上，退出码决定命令执行层的语义：

| 情况 | 结果 | 是否默认阻止 |
|---|---|---|
| 退出码 `0` + 合法 JSON | 解析 `decision`、`additionalContext` 等字段 | 由 JSON 决定 |
| 退出码 `0` + 普通文本 | 作为普通成功输出 | 否 |
| 以 `{` 开头但 JSON schema 不合法 | 返回校验错误 | 否，属于 non-blocking error |
| 退出码 `2` | 生成 `blockingError` | 是 |
| 其他非零退出码 | 生成 `non_blocking_error` | 否 |
| 进程被取消 | 生成 cancelled 结果 | 否，交给调用方处理 |

这里的 `non_blocking_error` 可以翻译为“非阻塞错误”：Hook 自己失败了，但不会仅因为 Hook 进程失败就阻止 Agent 继续。

这与 Hook 主动返回 `decision: "block"` 不同：

```text
Hook 主动返回 block
  → 表达“我判断这次动作不应该继续”

Hook 进程异常 / schema 错误 / 普通非零退出码
  → 表达“Hook 没有正常完成”
  → 默认不把执行故障升级为业务阻断
```

这是一项重要的边界：**Hook 业务决策可以阻止，Hook 传输或执行故障默认不自动阻止。**

---

## 三、一次 Hook 事件如何走完生命周期

以 `PreToolUse` 为例，完整路径可以写成：

```text
工具调用前
  → 事件入口 fast-skip
  → 全局关闭开关
  → workspace trust 检查
  → 合并并匹配 Hook
  → 并行执行各个 Hook
  → 解析 JSON / 文本 / 退出码
  → 聚合 permission、阻断、改参和上下文
  → yield 给工具执行器或 Agent Loop
```

### 3.1 第一步：事件入口先做 fast-skip

每个 `executeXxxHooks()` 入口通常先调用 `hasHookForEvent()`。

它只做轻量存在性检查：

```typescript
function hasHookForEvent(hookEvent, appState, sessionId) {
  const snapshot = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snapshot && snapshot.length > 0) return true

  const registered = getRegisteredHooks()?.[hookEvent]
  if (registered && registered.length > 0) return true

  return Boolean(appState?.sessionHooks.get(sessionId)?.hooks[hookEvent])
}
```

这个函数是“可能有 Hook 吗”的近似判断，不负责最终 matcher 过滤。

源码注释特别强调了一个取舍：

- false negative（漏报）会错误跳过 Hook，不能接受；
- false positive（误报）只会让程序继续进入完整匹配流程，代价是多做一次检查。

所以它宁可多返回几次 `true`，也不能把可能存在的 Hook 错误地挡掉。

### 3.2 第二步：全局闸门决定是否进入执行阶段

`executeHooks()` 开头有三类早返回：

```typescript
async function* executeHooks({ hookInput, ... }) {
  // 企业托管策略可以关闭包括 managed hook 在内的全部 Hook
  if (shouldDisableAllHooksIncludingManaged()) return

  // 极简运行模式不执行 Hook
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return

  // 交互模式下必须先接受 workspace trust
  if (shouldSkipHookDueToTrust()) return

  // 之后才会读取状态、匹配配置和执行 Hook
}
```

三道闸门分别解决不同问题：

| 闸门 | 作用 |
|---|---|
| `shouldDisableAllHooksIncludingManaged()` | 管理员关闭整个 Hook 子系统 |
| `CLAUDE_CODE_SIMPLE` | 极简模式跳过扩展逻辑 |
| `shouldSkipHookDueToTrust()` | 未信任工作区时不执行可能带来 RCE（远程代码执行）风险的 Hook |

`shouldSkipHookDueToTrust()` 的逻辑是：

- 交互模式：必须通过 `checkHasTrustDialogAccepted()`；
- 非交互模式：信任被视为隐式成立，直接允许继续。

这不是说非交互环境“更安全”，而是把信任责任交给 SDK 或宿主程序。无 UI 的调用方必须自己决定工作区和 Hook 配置是否可信。

这些闸门不仅存在于 `executeHooks()`，`executeHooksOutsideREPL()`、StatusLine 和 FileSuggestion 等外部入口也会执行相同的 trust 检查。

### 3.3 第三步：从三类运行时来源收集 Hook

`getHooksConfig()` 会把运行时 Hook 组合成三类来源：

```text
snapshot
  → 设置文件快照，内部已经完成设置来源合并

registered
  → SDK 注册的 callback 和 plugin native Hook

session
  → 当前 session 的 Agent / Skill frontmatter Hook
```

并不是所有来源在所有策略下都有效。

- `allowManagedHooksOnly: true` 时，只使用托管 Hook；
- managed-only 模式会跳过 plugin Hook；
- session Hook 只有在允许非托管 Hook 且存在 `appState` 时才合并；
- 非托管设置中的 `disableAllHooks` 不能关闭管理员 Hook，因此会退化成只运行 managed Hook；
- managed policy 中的 `disableAllHooks` 才能关闭包括 managed Hook 在内的全部 Hook。

这和普通权限规则的 managed policy 逻辑相似，但 Hook 有自己的 `hooksConfigSnapshot.ts`。

### 3.4 第四步：按事件字段和 matcher 过滤

`getMatchingHooks()` 会根据事件类型选择匹配查询值：

| 事件 | matcher 查询值 |
|---|---|
| `PreToolUse`、`PostToolUse`、`PermissionRequest` | `tool_name` |
| `SessionStart` | `source` |
| `Setup`、`PreCompact`、`PostCompact` | `trigger` |
| `Notification` | `notification_type` |
| `SessionEnd` | `reason` |
| `StopFailure` | `error` |
| `SubagentStart`、`SubagentStop` | `agent_type` |
| `Elicitation`、`ElicitationResult` | `mcp_server_name` |
| `ConfigChange` | `source` |
| `InstructionsLoaded` | `load_reason` |
| `FileChanged` | 文件名 |

如果某个事件没有匹配查询值，就只根据事件是否存在配置来决定。

Hook 的 `matcher` 解决的是“事件值是否匹配”；`if` 条件则是另一层过滤。对于命令、Prompt、Agent 和 HTTP Hook，`if` 可以进一步判断工具输入是否满足条件，例如只对 `Bash(git *)` 执行。

如果 `if` 条件无法在当前事件上评估，Hook 会被过滤掉，而不是乐观执行。

### 3.5 第五步：去重不是简单的字符串去重

当前实现会对 command、prompt、agent 和 HTTP Hook 分别去重：

```text
command：shell + command + if
prompt： prompt + if
agent：  prompt + if
http：   url + if
callback / function：不做同样的 Map 去重
```

去重键还会带上 pluginRoot 或 skillRoot 等来源命名空间。这样两个不同 plugin 即使使用相同命令，也不会因为模板相同而互相删除。

同一命名空间发生冲突时，`Map` 保留后出现的条目。对设置来源来说，这意味着后合并的作用域可能覆盖前面的同名 Hook。

去重之后还会处理两个特殊边界：

- `SessionStart` 和 `Setup` 当前不支持 HTTP Hook；
- 没有 matcher 或 matcher 为空的 Hook，可以对该事件的所有查询值生效。

### 3.6 第六步：匹配到的 Hook 并行执行

`executeHooks()` 会为每个匹配结果创建独立执行任务：

```typescript
const hookPromises = matchingHooks.map(async function* (
  { hook, pluginRoot, pluginId, skillRoot },
  hookIndex,
) {
  const { signal: abortSignal, cleanup } =
    createCombinedAbortSignal(signal, {
      timeoutMs: hook.timeout ? hook.timeout * 1000 : timeoutMs,
    })

  try {
    if (hook.type === 'prompt') {
      yield await execPromptHook(...)
      return
    }

    if (hook.type === 'agent') {
      yield await execAgentHook(...)
      return
    }

    if (hook.type === 'http') {
      yield await execHttpHook(...)
      return
    }

    // command Hook 通过子进程执行
    yield await executeCommandHook(...)
  } finally {
    cleanup()
  }
})
```

当前实际存在的执行体至少包括：

| 类型 | 执行方式 | 典型用途 |
|---|---|---|
| `command` | 启动 Shell 子进程，输入 JSON | 格式化、审计、脚本检查 |
| `prompt` | 调用独立模型进行判断 | 语义检查、计划评估 |
| `agent` | 委派给子 Agent | 测试、较重的验证任务 |
| `http` | 请求外部 HTTP endpoint | 外部策略服务、远程审计 |
| `callback` | 进程内注册函数 | SDK 或 plugin native 扩展 |
| `function` | session 级函数 Hook | 当前 session 的内部函数逻辑 |

旧稿只列出四类执行体，漏掉了 `http` 和 `function`。

默认 Hook 超时是 `10 * 60 * 1000` 毫秒，但每个 Hook 可以通过自己的 timeout 覆盖。SessionEnd 使用更短的专用超时，因为此时进程正在关闭，不能长时间等待清理脚本。

### 3.7 callback fast-path 只适用于全是内部 callback

如果匹配结果中的 Hook 全都是 internal callback，执行器会走简化路径：

```text
全部是 internal callback
  → 不做 JSON 序列化
  → 不走命令进程、输出解析和完整结果循环
  → 直接调用 callback
```

只要混入一个 command、prompt、agent 或 HTTP Hook，就会回到完整路径。

这条 fast-path 不能理解成“callback 永远比其他 Hook 更快”。它只在**全部匹配项都是内部 callback**时生效。混合场景仍然会走完整的统一执行器。

### 3.8 第七步：通过 `all()` 流式收集结果

多个 Hook 是并行启动的，但结果通过 `all(hookPromises)` 逐个交错（interleave）收集。

因此：

- 各 Hook 的完成顺序不固定；
- 聚合器不能依赖配置数组顺序；
- `deny` 必须具有粘性，不能被后完成的 allow 覆盖；
- reason、additionalContext 等字段要明确谁负责累积，谁允许后写覆盖。

---

## 四、结果如何合并和回灌

### 4.1 `deny > ask > allow` 在这里是准确的

在 `executeHooks()` 的**多个 Hook 决策聚合阶段**，源码确实使用：

```text
deny > ask > allow > passthrough
```

对应实现是：

```typescript
let permissionBehavior: PermissionResult['behavior'] | undefined

for await (const result of all(hookPromises)) {
  switch (result.permissionBehavior) {
    case 'deny':
      // 一旦出现 deny，后面的 allow 或 ask 不能覆盖它
      permissionBehavior = 'deny'
      break

    case 'ask':
      // ask 可以覆盖 allow，但不能覆盖 deny
      if (permissionBehavior !== 'deny') {
        permissionBehavior = 'ask'
      }
      break

    case 'allow':
      // 只有此前没有任何决策时，allow 才生效
      if (!permissionBehavior) {
        permissionBehavior = 'allow'
      }
      break

    case 'passthrough':
      // 观察型 Hook 不参与权限决策
      break
  }
}
```

这和上一篇权限文章需要区分：

- 在上一篇中，不能把整个权限系统简单说成固定的 `deny > ask > allow`；
- 在本文这里，`executeHooks()` 对多个 Hook 返回的权限建议，确实按这个顺序聚合。

原因也很明确：Hook 是并行安全检查。只要一个安全 Hook 发现问题，就不应该因为其他 Hook 返回 allow 而被多数投票淹没。

### 4.2 `passthrough` 不是 allow

`passthrough` 的语义是：

> 这个 Hook 不做权限决定，让其他 Hook 或调用方继续判断。

它不会：

- 把当前结果变成 allow；
- 清除其他 Hook 的 ask 或 deny；
- 覆盖工具输入的最终权限结论。

但它仍然可以单独返回 `updatedInput`。源码会区分两种情况：

```text
Hook 同时返回 allow / ask + updatedInput
  → 在带 permissionBehavior 的结果中回灌 updatedInput

Hook 不返回 permissionBehavior，但返回 updatedInput
  → 单独 yield updatedInput
  → 让调用方决定是否采用
```

### 4.3 `updatedInput` 不是任意修改都自动生效

对于 PreToolUse，Hook 可以建议修改工具输入：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "path": "src/safe-file.ts"
    }
  }
}
```

执行器会把它包装成 `updatedInput` yield 给上层。

但这不是“Hook 直接重新调用工具”。它只是把一个结构化改参结果传给调用方。工具执行器还要负责：

- 是否接受新输入；
- 是否重新进行 Schema 校验；
- 是否重新执行权限和 Hook；
- 是否保留原始 tool_use 的关联 ID。

Hook 层只负责产生结果，不负责替代工具执行器。

### 4.4 其他字段分别流向不同消费者

`executeHooks()` 不是只 yield 一个布尔值，而是按字段分流：

| 字段 | 作用 |
|---|---|
| `blockingError` | 把阻断原因交给当前生命周期调用方 |
| `permissionBehavior` | 传递 Hook 对工具权限的建议 |
| `hookPermissionDecisionReason` | 保留决策说明 |
| `updatedInput` | 传递修改后的工具输入 |
| `additionalContexts` | 收集后续模型要看到的补充上下文 |
| `initialUserMessage` | 会话开始时提供初始用户侧消息 |
| `updatedMCPToolOutput` | 允许 PostToolUse 替换 MCP 工具输出 |
| `permissionRequestResult` | PermissionRequest 的结构化决定 |
| `retry` | PermissionDenied 是否建议重试 |
| `elicitationResponse` | MCP elicitation 的响应 |
| `preventContinuation` | 请求 Agent Loop 不再继续 |

这种设计是“一个事件、多个下游消费者”的结果。把所有结果压缩成一个 `{allowed: boolean}`，反而会丢掉输入改写、上下文注入和 MCP 响应等信息。

### 4.5 外部 REPL 的结果处理不同

`executeHooksOutsideREPL()` 不使用和 `executeHooks()` 相同的 yield 语义。

它主要返回：

```typescript
type HookOutsideReplResult = {
  command: string
  succeeded: boolean
  output: string
  blocked: boolean
  watchPaths?: string[]
  systemMessage?: string
}
```

适用场景包括：

- `Notification`；
- `SessionEnd`；
- `PreCompact` / `PostCompact` 的外部调用；
- MCP elicitation 的非 REPL 路径；
- 工作树或配置相关事件。

由于 REPL 可能已经结束，这些结果不会直接通过 `yield` 送回模型。调用方需要自行决定是写入 stderr、更新文件监视路径、返回 MCP 响应，还是记录日志。

---

## 五、安全边界与失败策略

### 5.1 Trust Gate 是所有 Hook 的统一前置保护

Hook 可以执行用户配置中的命令，因此配置文件本身就是潜在的代码执行入口。

当前实现把 trust 检查集中在执行器内，而不是只在某几个事件入口检查。这样可以覆盖：

- 新增事件；
- SessionEnd 等非 REPL 路径；
- SubagentStop 等容易被遗漏的生命周期路径；
- 未来新增的 Hook 执行体。

在交互模式中，未接受工作区信任时，所有 Hook 都跳过。非交互模式则默认信任，宿主程序需要自己管理输入来源。

### 5.2 managed hook 与用户 Hook 不是同一个策略层

Hook 配置至少受到以下策略影响：

```text
policySettings.disableAllHooks === true
  → 所有 Hook 都关闭，包括 managed Hook

policySettings.allowManagedHooksOnly === true
  → 只运行托管 Hook

非托管设置 disableAllHooks === true
  → 非托管 Hook 关闭，但 managed Hook 仍可运行
```

这体现了一个企业配置原则：

> 用户侧可以减少自己的 Hook，但不能用普通设置关闭管理员要求必须执行的 Hook。

具体的 snapshot 读取和更新由 `hooksConfigSnapshot.ts` 管理。它会在启动时捕获配置快照，并在 Hook 设置发生变化时重新读取。

### 5.3 “合并 fail-closed”和“执行故障不阻断”并不矛盾

`fail-closed` 可以翻译为“失败时默认关闭”。在 Hook 系统中，它主要体现在**已经拿到多个明确决策后，deny 不能被 allow 覆盖**。

但 Hook 进程本身失败时，当前实现通常不会自动把它升级成 deny：

```text
明确 decision: block
  → blockingError，阻止当前动作

命令超时、普通非零退出码、JSON 校验失败
  → non_blocking_error，记录错误但不自动阻断
```

这样做是两个层面的取舍：

| 层面 | 策略 | 原因 |
|---|---|---|
| 决策合并 | 偏 fail-closed | 一个明确 deny 不应被其他 allow 覆盖 |
| Hook 进程故障 | 偏 fail-open | 一个格式错误或卡住的审计脚本不应永久锁死 Agent |

如果某个 Hook 是绝对安全护栏，不能依赖“进程故障默认不阻断”这一通用策略。它应该让脚本在正常执行时明确返回 `decision: "block"`，并结合托管策略、权限规则或更硬的 sandbox 保护。

### 5.4 `exit code 2` 的语义是显式阻断

传统命令 Hook 不一定输出 JSON，因此源码保留了退出码约定：

```text
exit 0 → 普通成功
exit 2 → blockingError
其他非零 → non_blocking_error
```

这使得一个简单 Shell 脚本也可以通过 stderr 提供阻断原因：

```bash
if [[ "$dangerous" == "true" ]]; then
  echo "禁止执行危险操作" >&2
  exit 2
fi

exit 0
```

如果脚本只是因为依赖缺失退出 `1`，它不会自动把 Agent 操作判定为危险。这是业务决策与执行故障的区分。

### 5.5 Prompt Hook 和 Agent Hook 仍然不是确定性规则

Hook 层支持 `prompt` 和 `agent` 执行体，但它们只是被 Hook 生命周期调用，并不会因此变成确定性逻辑。

- `command` 和 callback 可以实现确定性检查；
- `prompt` 仍然是一次模型判断；
- `agent` 仍然是一次子 Agent 委派；
- `http` 的可信度取决于外部服务；
- 最终是否阻断，仍然要看返回的结构化决策。

因此 Hook 是“确定性入口”，不代表 Hook 内的每种执行方式都确定。

---

## 六、Hook 与其他 Harness 组件如何分工

### 6.1 Hook 与 Permission

权限系统解决：

```text
当前工具和输入，在通用权限规则下能不能执行？
```

Hook 解决：

```text
在某个生命周期事件上，外部规则是否要补充、阻止或改写这次动作？
```

两者都可能产生 `allow`、`ask`、`deny`，但它们不是同一个决策器。

- Permission 的核心是规则来源、mode 和工具自身安全检查；
- Hook 的核心是生命周期事件、外部执行体和结果回灌；
- `PreToolUse` Hook 可以返回权限建议，但它仍要由工具执行调用方消费；
- Hook 的 `PermissionRequest` 事件用于回应权限请求，不等于替代整个 Permission 引擎。

### 6.2 Hook 与 Skill

Skill 是模型可发现、可调用的能力说明和流程模板。

Hook 是生命周期自动触发的外部拦截。

```text
Skill：
  需要模型或用户主动采用

Hook：
  配置匹配后自动触发
```

如果规则必须在每次工具调用前执行，不能只写成 Skill。Skill 更适合指导模型，Hook 更适合强制接入生命周期。

### 6.3 Hook 与 Subagent

`agent` 类型 Hook 可以委派子 Agent 做检查，但这不等于普通的 Subagent 任务。

- 普通 Subagent 是主 Agent 主动委派的执行者；
- Agent Hook 是 Hook 事件触发后自动启动的检查者；
- Agent Hook 的返回结果仍要转换成 Hook 输出；
- 子 Agent 做了多少推理，不会自动改变 Hook 的阻断语义。

### 6.4 Hook 与 sandbox

Hook 可以执行 Shell 或 HTTP，但它自身的执行边界仍需要由宿主和 sandbox 控制。

Trust Gate 解决“是否允许执行这类配置”；

Permission 解决“工具动作是否被授权”；

sandbox 解决“进程启动后能访问什么”。

三者不是替代关系。

---

## 七、Goal 为什么不应写成 Stop Hook

当前 `/goal` 是一个容易与 Hook 混淆的综合功能。

它确实也围绕“每轮结束后是否继续”展开，但源码实现不是 `executeStopHooks()` 的特殊分支。

### 7.1 Goal 的真实实现路径

```text
/goal <objective>
  → commands/goal/goal.tsx
  → setGoal()
  → persistCurrentGoal()
  → 注入 <goal-objective-updated> meta-message

每轮 isLoading 从 true 变成 false
  → useGoalContinuation.ts 的 useLayoutEffect
  → 检查当前 GoalState
  → buildContinuationPrompt()
  → enqueue({ isMeta: true, origin: 'goal-continuation' })
  → 下一轮继续查询
```

`useGoalContinuation()` 的触发条件包括：

- 当前 Query 已经结束；
- 本轮没有被用户中止；
- 没有活动中的本地 UI；
- 当前不在 plan mode；
- 用户命令队列为空；
- Goal 状态仍为 `active`；
- 没有达到最大 turn 数。

用户消息优先级高于自动续跑。如果用户在 Goal 执行过程中输入 `/goal pause`，续跑 Hook 会先让用户消息处理，避免自动消息饿死用户命令。

### 7.2 Goal 使用的是 Prompt 注入，不是 Hook 输出合并

`buildContinuationPrompt()` 生成 `<goal-steering type="continuation">` 文本，其中包含：

- 当前目标；
- 已用 token；
- 已执行 turn 数；
- Completion Audit（完成审计）；
- Blocked Audit（阻塞审计）。

这段文本作为 `isMeta: true` 的消息进入下一轮 Prompt。

因此 Goal 的决策者仍然是主模型。Goal 状态机负责控制“是否再发起一轮”，而不是像 Hook 那样收集多个执行体结果后计算 `deny > ask > allow`。

### 7.3 Goal 的状态保护

`goalState.ts` 当前提供以下限制：

```typescript
export const BLOCKED_CONSECUTIVE_THRESHOLD = 3
export const MAX_GOAL_TURNS = 150
```

并且支持：

- token budget（token 预算）达到上限后进入 `budget_limited`；
- `MAX_GOAL_TURNS` 达到上限后进入 `max_turns`；
- 连续相同阻塞原因达到阈值后进入 `blocked`；
- 用户显式 `/goal continue` 后重置 turn 计数；
- Goal 按 sessionId 存储，避免并发 session 互相污染。

`useGoalContinuation()` 还对 budget-limited 状态注入一次收尾 Prompt，让模型停止新工作并总结进度。

这里需要纠正旧稿的表述：

- Goal 不注册一个 Stop Hook 来完成续跑；
- Goal 不调用 `processHookJSONOutput()`；
- Goal 没有多个 Hook 的并行决策合并；
- `stopHookActive` 是 Stop Hook 的递归保护，不应被写成 Goal 自己的第一道闸门；
- Goal 的核心是 React idle effect、session 状态和 meta-message 队列。

### 7.4 Hook 与 Goal 的对照

| 维度 | Hook | Goal |
|---|---|---|
| 触发 | 事件入口调用 `executeXxxHooks()` | React 监听 Query 从 loading 到 idle |
| 执行体 | command、prompt、agent、http、callback、function | 主模型下一轮继续查询 |
| 输出 | 结构化权限、阻断、改参、上下文 | `goal-steering` meta-message |
| 多源合并 | matcher、来源、去重和 `deny > ask > allow` | 单个 session GoalState |
| 失败保护 | trust、timeout、退出码和结果聚合 | token、turn、blocked 和用户优先队列 |
| 关系 | 生命周期拦截机制 | 使用 Prompt 和状态机实现的自动续跑功能 |

Goal 可以借鉴 Hook 的“把控制逻辑外置”的思想，但它不是 Hook 机制本身。

---

## 八、几个容易写错的结论

### 8.1 “Hook 只有 21 个事件”

不准确。

当前 `HOOK_EVENTS` 是 27 个。随着 MCP、协作任务、工作树和配置变化能力进入运行时，事件集合已经扩展。

### 8.2 “Hook 只有 command、prompt、agent、callback 四种执行体”

不准确。

当前统一执行器还处理 `http` 和 `function`。其中 callback 和 function 还可能走不需要完整 JSON 处理的内部路径。

### 8.3 “所有 Hook 失败都会阻止 Agent”

不准确。

退出码 `2` 或结构化 `block` 会阻断；普通非零退出、超时、JSON 校验失败通常记录为 non-blocking error。

### 8.4 “JSON 输出错误会自动当成普通文本”

不准确。

不以 `{` 开头的输出可以当普通文本；以 `{` 开头但不满足 Hook schema 的输出会产生 validationError，并进入非阻塞错误路径。

### 8.5 “多个 Hook 的结果按照配置文件顺序合并”

不准确。

Hook 会并行启动，结果按完成顺序通过 `all()` 交错收集。权限行为使用 sticky 的 `deny > ask > allow` 聚合，不依赖配置顺序。

### 8.6 “Goal 就是一个 Stop Hook”

不准确。

Goal 是独立的状态机和自动续跑功能，使用 `useGoalContinuation()`、GoalTool 和 meta-message，不走通用 Hook 执行器。

---

## 总结

Hook 系统可以沿着一条清晰主线理解：

```text
事件入口
  → fast-skip
  → managed / simple / trust 闸门
  → snapshot + registered + session Hook 合并
  → matcher / if 条件过滤
  → 去重
  → command / prompt / agent / http / callback / function 并行执行
  → JSON、纯文本、退出码和 async 解析
  → deny > ask > allow 聚合
  → blockingError / updatedInput / additionalContext 等字段分流
  → 返回给具体生命周期调用方
```

最重要的三个边界是：

1. **事件数量和执行体数量要以当前 schema 和执行器为准**，不能继续沿用旧版的 21 个事件、四类执行体说法。
2. **明确的业务阻断和 Hook 进程故障是两种不同语义**。`block` 或退出码 `2` 表示主动阻止；普通执行错误默认不会自动阻断。
3. **Goal 不属于通用 Hook 执行器**。它通过 idle effect、GoalState 和 meta-message 实现自动续跑，不能用 Stop Hook 的输入输出模型解释。

**相关源码**：`src/entrypoints/sdk/coreSchemas.ts` · `src/utils/hooks.ts` · `src/utils/hooks/hooksConfigSnapshot.ts` · `src/utils/hooks/execPromptHook.ts` · `src/utils/hooks/execAgentHook.ts` · `src/utils/hooks/execHttpHook.ts` · `src/hooks/useGoalContinuation.ts` · `src/services/goal/goalState.ts` · `src/services/goal/prompts.ts`
