---
slug: /application-notes/engineering/claude-code-cli/cc-18-plan-mode-deep-dive
sidebar_position: 18
title: "Plan 模式：状态切换、方案文件与审批边界"
description: "从 EnterPlanMode 和 ExitPlanMode 的真实调用链出发，拆解 Plan 模式的权限状态、调研指令、方案文件、用户审批、auto 协同和 teammate 边界。"
---

> Plan 模式不是简单的“禁止写文件”。它是一个会话级 `permission mode`（权限模式），再叠加调研流程指令、方案文件和退出审批。
>
> **Harness 层定位**：Plan 模式位于循环层和权限层的交界处。它改变当前会话的权限上下文，并把“调研”和“执行”拆成两个阶段。

# Plan 模式：状态切换、方案文件与审批边界

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。正文引用的是本地复刻仓库中的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **工具入口**：`packages/builtin-tools/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` 的 `EnterPlanModeTool.call()` 和 `mapToolResultToToolResultBlockParam()`——进入状态并把调研流程返回给模型。
> - **命令入口**：`src/commands/plan/plan.tsx` 的 `call()`——`/plan` 命令和工具入口共用同一套状态切换逻辑。
> - **进入状态机**：`src/utils/permissions/permissionSetup.ts` 的 `prepareContextForPlanMode()`、`transitionPermissionMode()` 和 `transitionPlanAutoMode()`——保存 `prePlanMode`，协调 `auto`，处理危险权限规则。
> - **权限分流**：`src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseTool()`——判断 Plan 模式是否仍然进入 `auto classifier`、是否继承 `bypassPermissions`，以及哪些工具必须保留人工交互。
> - **方案文件**：`src/utils/plans.ts` 的 `getPlansDirectory()`、`getPlanSlug()`、`getPlanFilePath()`、`getPlan()`——决定方案文件目录、session slug（会话短标识）和主 Agent / 子 Agent 的文件名。
> - **退出与写盘**：`packages/builtin-tools/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` 的 `validateInput()`、`checkPermissions()`、`call()` 和 `mapToolResultToToolResultBlockParam()`。
> - **本地审批 UI**：`src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx`——用户批准、拒绝、编辑方案、清理上下文和选择后续权限模式。
> - **Plan 子 Agent**：`packages/builtin-tools/src/tools/AgentTool/built-in/planAgent.ts`——这是一个只读的内置 Agent Definition（Agent 声明），不要和主线程的 Plan 模式混为一谈。

## 先给结论：Plan 模式不是一个单点开关

一次完整的 Plan 工作流大致是：

```text
用户输入 /plan，或模型调用 EnterPlanMode
  │
  ├─► handlePlanModeTransition(currentMode, 'plan')
  ├─► prepareContextForPlanMode(context)
  │     ├─ 保存 prePlanMode
  │     └─ 按配置决定 auto 是否在 Plan 期间继续生效
  ├─► applyPermissionUpdate({ type: 'setMode', mode: 'plan' })
  │
  ├─► EnterPlanMode 返回调研流程
  │     ├─ 读取代码
  │     ├─ 识别已有模式
  │     ├─ 必要时询问用户
  │     └─ 把方案写入方案文件
  │
  └─► ExitPlanMode
        ├─ 普通主线程：进入本地审批 UI
        ├─ teammate + plan_mode_required：写入 leader mailbox
        └─ 批准后恢复权限模式，回灌 Approved Plan
```

这里至少有五个容易混淆的边界：

| 概念 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `mode: 'plan'` | 标识当前会话处于规划阶段，并影响权限层分流 | 不是一个单独的 Plan Manager |
| `prePlanMode` | 记录进入 Plan 之前的模式，供退出时恢复 | 不是实时的 auto 状态 |
| `EnterPlanMode` | 切换状态，并把“先调研、后提交方案”的指令交给模型 | 不负责写入方案正文 |
| `ExitPlanMode` | 读取或同步方案文件，触发审批，恢复执行阶段 | 不负责替模型设计方案 |
| 内置 `Plan` Agent | 提供一个只读的规划型子 Agent | 不等于主线程的 Plan 模式 |

因此，“Plan 模式会把所有写工具从工具列表里删除”并不是当前源码最准确的描述。主线程工具注册仍然在 `src/tools.ts` 完成，Plan 模式主要通过权限上下文、工具提示、方案文件和审批出口协作完成约束。

---

## 一、Plan 模式到底是什么

### 1.1 它首先是一个权限模式

权限模式定义在 `src/types/permissions.ts`。

当前源码把模式分成两组：

```typescript
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const

// auto 和 bubble 属于内部运行时模式，不在外部模式列表中
export type InternalPermissionMode =
  | ExternalPermissionMode
  | 'auto'
  | 'bubble'
```

阅读时要区分：

- **外部可配置模式**：用户可以通过 settings、CLI 参数或会话恢复使用；
- **内部模式**：服务内部为了分类器或消息冒泡使用，不能简单地当成用户可见选项；
- `plan` 是权限上下文中的一个值，不是另建一套 Agent Runtime（Agent 运行时）。

这也解释了为什么 Plan 模式可以和 `auto` 发生协同：当前上下文的主模式是 `plan`，但内部的 auto classifier（自动权限分类器）仍可能保持激活。

### 1.2 Plan 模式和 Plan 子 Agent 不是同一个东西

源码中有一个内置的 `PLAN_AGENT`：

```typescript
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  disallowedTools: [
    AGENT_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
    NOTEBOOK_EDIT_TOOL_NAME,
  ],
  tools: EXPLORE_AGENT.tools,
  model: 'inherit',
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
```

这个 Agent 的特点是：

- 使用独立 Agent Definition；
- 只继承 `EXPLORE_AGENT` 的探索类工具；
- 明确禁止 `Edit`、`Write`、`NotebookEdit` 和递归 Agent；
- system prompt（系统提示）中再次强调只读；
- 运行结束后把规划结果作为一个子 Agent 结果返回。

它属于 [17 子 Agent 隔离](cc-17-subagent-isolation.md) 讨论的 regular subagent 体系。

而主线程的 Plan 模式是：

```text
当前主线程
  └─► toolPermissionContext.mode = 'plan'
       ├─► EnterPlanMode
       ├─► 继续使用主线程循环
       ├─► 读取方案文件
       └─► ExitPlanMode 请求审批
```

两者都强调“先规划”，但隔离方式不同：

| 对比项 | 主线程 Plan 模式 | 内置 `Plan` 子 Agent |
| --- | --- | --- |
| 运行位置 | 当前会话主循环 | 独立子 Agent 循环 |
| 状态表达 | `toolPermissionContext.mode = 'plan'` | Agent Definition 的工具和 system prompt |
| 方案文件 | 由当前 session 的 plan slug 管理 | 如果作为子 Agent 使用，会有自己的 Agent 维度路径 |
| 退出方式 | `ExitPlanMode` + 用户或 leader 审批 | 返回规划结果，不负责主线程审批 |
| 典型用途 | 规划后继续在当前会话实现 | 把探索和设计外包给规划型子 Agent |

这一区分是理解后文的前提。

---

## 二、进入 Plan：两个入口，共用一套状态切换

### 2.1 `/plan` 命令入口

用户可以直接输入 `/plan`。`src/commands/plan/plan.tsx` 的行为分两种：

1. 当前不在 Plan 模式：进入 Plan；
2. 当前已经在 Plan 模式：显示当前方案，或者用 `/plan open` 打开编辑器。

进入分支的核心代码如下：

```typescript
if (currentMode !== 'plan') {
  // 先更新附件状态，避免快速切换时同时发送进入和退出标记
  handlePlanModeTransition(currentMode, 'plan')

  setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(
      // 在当前最新上下文上保存原模式，并处理 auto 协同
      prepareContextForPlanMode(prev.toolPermissionContext),
      {
        type: 'setMode',
        mode: 'plan',
        destination: 'session',
      },
    ),
  }))
}
```

`destination: 'session'` 表示这次切换只写入当前会话内存，不会把 `plan` 写成用户永久设置。

如果 `/plan` 后面带有任务描述，命令还可以触发一次新的 query（查询循环），让模型立即开始调研。

### 2.2 `EnterPlanMode` 工具入口

模型也可以调用 `EnterPlanMode`。这个工具的输入 schema 不需要参数：

```typescript
const inputSchema = lazySchema(() =>
  z.strictObject({
    // 进入 Plan 模式不接收业务参数
  }),
)
```

真正的状态切换发生在 `call()`：

```typescript
async call(_input, context) {
  // 子 Agent 不能直接使用主线程 Plan 模式工具
  if (context.agentId) {
    throw new Error('EnterPlanMode tool cannot be used in agent contexts')
  }

  const appState = context.getAppState()
  handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(
      prepareContextForPlanMode(prev.toolPermissionContext),
      { type: 'setMode', mode: 'plan', destination: 'session' },
    ),
  }))

  return {
    data: {
      message:
        'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
    },
  }
}
```

这里有三个关键点：

- `EnterPlanMode` 只允许主线程使用；
- 进入前先调用 `prepareContextForPlanMode()`，不能直接把 `mode` 改成 `plan`；
- `applyPermissionUpdate()` 负责把模式更新应用到当前 `ToolPermissionContext`。

### 2.3 进入是幂等的

幂等（idempotent，重复执行多次结果仍等价）处理在 `prepareContextForPlanMode()`：

```typescript
const currentMode = context.mode

if (currentMode === 'plan') {
  // 已经在 Plan 中，不能再次覆盖 prePlanMode
  return context
}

return {
  ...context,
  // 退出时依靠这个值恢复原来的权限模式
  prePlanMode: currentMode,
}
```

如果第二次进入时把 `prePlanMode` 改成了 `plan`，退出时就会出现一个典型错误：

```text
default → plan
再次进入 plan
prePlanMode 被错误覆盖成 plan
退出 plan
恢复到 plan
```

因此 `currentMode === 'plan'` 的早退不是性能优化，而是状态机正确性要求。

---

## 三、进入时的 `prePlanMode` 与 auto 协同

### 3.1 `prePlanMode` 是恢复快照，不是实时状态

`prePlanMode` 的职责很窄：记录“进入 Plan 前的模式”。

例如：

```text
default           → prePlanMode = default
acceptEdits       → prePlanMode = acceptEdits
auto              → prePlanMode = auto
bypassPermissions → prePlanMode = bypassPermissions
```

退出时通常使用：

```typescript
let restoreMode =
  prev.toolPermissionContext.prePlanMode ?? 'default'
```

但 `prePlanMode` 不能单独代表 Plan 期间的 auto 状态。用户可能在 Plan 中修改设置，导致 auto classifier 被关闭；因此退出逻辑还要读取 `autoModeStateModule.isAutoModeActive()` 这一实时信号。

### 3.2 `shouldPlanUseAutoMode()` 决定 Plan 期间是否继续使用 auto

源码中的判断大致是：

```typescript
export function shouldPlanUseAutoMode(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      hasAutoModeOptIn() &&
      isAutoModeGateEnabled() &&
      getUseAutoModeDuringPlan()
    )
  }

  return false
}
```

这里的几个术语：

- `feature flag`（功能开关）：控制一段实验或可回滚功能是否启用；
- `classifier`（分类器）：根据工具调用和上下文判断是否可以自动放行；
- `gate`（闸门）：比普通配置更高一层的可用性限制；
- `opt-in`（主动选择加入）：用户明确开启，而不是默认开启。

只有这些条件同时满足，Plan 期间才会继续使用 auto 语义。

### 3.3 进入分支

`prepareContextForPlanMode()` 的实际分支可以压缩成下面这样：

```typescript
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode

  // 幂等：不覆盖第一次进入时保存的原模式
  if (currentMode === 'plan') return context

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()

    if (currentMode === 'auto') {
      if (planAutoMode) {
        // 继续保留 auto 语义，退出时可以恢复 auto
        return { ...context, prePlanMode: 'auto' }
      }

      // 不允许 auto 穿过 Plan，先关闭分类器并恢复危险规则
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)

      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }

    if (planAutoMode && currentMode !== 'bypassPermissions') {
      // 从普通模式进入 Plan 时，可以选择在 Plan 期间开启 auto
      autoModeStateModule?.setAutoModeActive(true)

      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }

  // 普通进入：只保存原模式
  return { ...context, prePlanMode: currentMode }
}
```

可以把它整理为四种情况：

| 进入前模式 | Plan 期间允许 auto | 进入时行为 | 退出时重点 |
| --- | --- | --- | --- |
| `default` / `acceptEdits` | 否 | 只保存 `prePlanMode` | 恢复原模式 |
| `default` / `acceptEdits` | 是 | 激活 classifier，并移除危险规则 | 根据实时状态恢复 |
| `auto` | 是 | 保持 auto 活跃 | 可以恢复 `auto` |
| `auto` | 否 | 关闭 auto，恢复危险规则 | 不直接把 auto 带回去 |

`bypassPermissions` 还会被单独保护：即使 Plan 配置想启用 auto，也不能简单地把一个原本绕过权限的会话改成另一种危险规则语义。

### 3.4 Plan 中途修改设置怎么办

进入时只判断一次是不够的。源码还提供 `transitionPlanAutoMode()`，在设置变化后重新比较：

```typescript
const want = shouldPlanUseAutoMode()
const have = autoModeStateModule?.isAutoModeActive() ?? false

if (want === have) {
  return context
}

if (want) {
  // 设置打开：Plan 中途激活 auto，并重新 strip 危险规则
  autoModeStateModule?.setAutoModeActive(true)
  return stripDangerousPermissionsForAutoMode(context)
}

// 设置关闭：Plan 中途停止 auto，并恢复之前被移除的规则
autoModeStateModule?.setAutoModeActive(false)
setNeedsAutoModeExitAttachment(true)
return restoreDangerousPermissions(context)
```

因此，`prePlanMode` 和 `isAutoModeActive()` 不是重复字段：

- `prePlanMode` 回答“退出后原本想回到什么模式”；
- `isAutoModeActive()` 回答“Plan 当前是否真的正在使用 classifier”。

---

## 四、调研阶段：模型收到的不是“魔法只读模式”

### 4.1 `EnterPlanMode` 的结果会注入流程指令

`EnterPlanModeTool.mapToolResultToToolResultBlockParam()` 会把状态消息转换为 `tool_result`（工具结果消息），再回灌到模型上下文。

普通版本会注入如下流程：

```text
1. Thoroughly explore the codebase
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if clarification is needed
5. Design a concrete implementation strategy
6. Use ExitPlanMode to present the plan for approval

DO NOT write or edit any files yet.
```

这段内容是模型可见的软约束。它告诉模型：

- 现在先阅读，不要立刻实现；
- 不要只找到一个文件就开始下结论；
- 需要时用 `AskUserQuestion` 澄清用户偏好；
- 方案完成后必须调用 `ExitPlanMode`；
- “方案是否批准”由 `ExitPlanMode` 处理，不要用 `AskUserQuestion` 代替。

### 4.2 interview phase 是另一种流程注入方式

`src/utils/planModeV2.ts` 的 `isPlanModeInterviewPhaseEnabled()` 控制 interview phase（访谈阶段）开关。

开启时，`EnterPlanMode` 不立即注入完整六步流程，而是返回更短的提示：

```text
DO NOT write or edit any files except the plan file.
Detailed workflow instructions will follow.
```

后续的详细流程由 Plan 相关消息附件继续注入。这样做的目的不是改变 Plan 的核心语义，而是把“进入 Plan”“澄清需求”“整理方案”拆成多个阶段，避免第一次工具结果携带过多指令。

### 4.3 SOP 是软约束，审批是硬出口

SOP（Standard Operating Procedure，标准操作流程）只能影响模型下一轮行为。模型理论上仍可能尝试调用写工具。

因此必须区分：

```text
EnterPlanMode 的 tool_result
  → 告诉模型应该怎样做

权限层 + ExitPlanMode
  → 判断具体工具是否能执行
  → 决定什么时候进入用户审批
  → 决定什么时候真正恢复执行模式
```

当前实现没有一个叫 `PlanModeManager` 的大模块把所有限制集中处理。它把状态、权限、提示和审批分布在现有 Harness 层中。

### 4.4 不要把主线程 Plan 写成“工具列表被替换”

主线程的工具注册仍在 `src/tools.ts`：

```typescript
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    AskUserQuestionTool,
    EnterPlanModeTool,
    // 其他工具继续注册
  ]
}
```

另外，`EnterPlanModeTool.isReadOnly()` 返回 `true`，表示这个“进入 Plan”工具自身没有文件写入副作用；`ExitPlanModeV2Tool.isReadOnly()` 则返回 `false`，因为退出时可能把用户编辑后的方案重新写入磁盘。这里的 `isReadOnly` 是工具元数据，不是全局工具池开关。

这说明：

- 进入 Plan 不是重新创建一份完全不同的主线程工具数组；
- `EnterPlanMode` 和 `ExitPlanMode` 仍然作为核心工具注册；
- 主线程是否允许某次具体调用，要回到权限计算和工具自检；
- 只有内置 `Plan` 子 Agent 才在 Agent Definition 中明确声明 `disallowedTools`。

这是一条重要的源码阅读纪律：不要因为 prompt 说“只读”，就反推运行时一定删除了所有写工具。

---

## 五、方案文件：Plan 的共享事实在哪里

### 5.1 方案不只存在模型上下文里

`ExitPlanMode` 的 prompt 明确要求模型先把方案写入 plan file（方案文件），再调用退出工具。

这样设计有三个原因：

1. 用户可以直接查看和编辑方案；
2. CCR（远程控制界面）可以把编辑结果传回本地；
3. 方案可以在上下文清理、恢复和验证流程中继续被读取。

方案文件是 Plan 的外部事实源，而不是只存在模型上下文中的一段文字。

### 5.2 方案目录可以配置，但必须限制在项目内

`getPlansDirectory()` 的行为是：

```typescript
export const getPlansDirectory = memoize(function getPlansDirectory() {
  const settingsDir = getInitialSettings().plansDirectory

  if (settingsDir) {
    const resolved = resolve(getCwd(), settingsDir)

    // 自定义目录必须位于当前项目根目录内
    if (!resolved.startsWith(getCwd() + sep) && resolved !== getCwd()) {
      // 路径穿越或越出项目范围时，回退到 Claude 配置目录
      return join(getClaudeConfigHomeDir(), 'plans')
    }

    return resolved
  }

  // 默认使用 Claude 配置目录下的 plans
  return join(getClaudeConfigHomeDir(), 'plans')
})
```

这里的路径限制属于文件系统边界，不是模型提示词边界。即使模型在方案中写了一个任意路径，也不能因此改变方案目录的计算规则。

### 5.3 session slug 保证方案文件可区分

`getPlanSlug()` 为当前 session（会话）生成一个单词组合形式的短标识，并放入会话级缓存：

```typescript
export function getPlanFilePath(agentId?: AgentId): string {
  const planSlug = getPlanSlug(getSessionId())

  if (!agentId) {
    // 主线程：例如 plans/quiet-river.md
    return join(getPlansDirectory(), `${planSlug}.md`)
  }

  // 子 Agent：追加 agent id，避免和主线程或其他子 Agent 冲突
  return join(
    getPlansDirectory(),
    `${planSlug}-agent-${agentId}.md`,
  )
}
```

因此方案文件不是固定名 `PLAN.md`。更准确的描述是：

```text
plansDirectory/
  ├─ quiet-river.md
  ├─ quiet-river-agent-a1b2.md
  └─ another-plan.md
```

文章中把它统一称为“方案文件”，但源码层面要记住它是由 session slug 和可选 `agentId` 组成的动态路径。

### 5.4 `/plan open` 是用户直接编辑方案的入口

在已经进入 Plan 的情况下：

```typescript
const planContent = getPlan()
const planPath = getPlanFilePath()

if (argList[0] === 'open') {
  // 使用外部编辑器修改当前 session 的方案文件
  await editFileInEditor(planPath)
  return null
}
```

这和 `AskUserQuestion` 不同：

- `AskUserQuestion` 收集结构化的用户答案；
- `/plan open` 允许用户直接修改完整方案；
- `ExitPlanMode` 负责在审批前重新读取或同步这些变化。

---

## 六、退出 Plan：先判断调用者，再决定审批路径

### 6.1 `validateInput()` 先挡住错误调用

普通主线程调用 `ExitPlanMode` 时，必须处于 `mode === 'plan'`：

```typescript
async validateInput(_input, { getAppState }) {
  if (isTeammate()) {
    // teammate 的 AppState 可能显示 leader 的 mode
    return { result: true }
  }

  const mode = getAppState().toolPermissionContext.mode

  if (mode !== 'plan') {
    return {
      result: false,
      message:
        'You are not in plan mode. This tool is only for exiting plan mode after writing a plan.',
      errorCode: 1,
    }
  }

  return { result: true }
}
```

为什么 teammate 例外？

`runAgent.ts` 创建的 teammate 上下文可能继承 leader 的部分状态，`isPlanModeRequired()` 才是 teammate 是否必须提交方案的真实来源。因此 teammate 不依赖本地 `mode` 字段判断是否可以调用退出工具。

### 6.2 `checkPermissions()` 把普通用户送进审批

退出工具对普通用户返回 `ask`：

```typescript
async checkPermissions(input, _context) {
  if (isTeammate()) {
    // teammate 由 call() 决定本地退出或写 mailbox
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  }

  return {
    behavior: 'ask',
    message: 'Exit plan mode?',
    updatedInput: input,
  }
}
```

因此 `ExitPlanMode` 本身不是“模型调用后自动退出”。对主线程来说，调用工具只是发起审批请求；用户在 UI 中选择后，`onAllow()` 或 `onReject()` 才决定下一步。

### 6.3 退出前同步方案文件

`ExitPlanModeV2Tool.call()` 先计算方案路径，再决定使用输入中的方案，还是从磁盘读取：

```typescript
const filePath = getPlanFilePath(context.agentId)

const inputPlan =
  'plan' in input && typeof input.plan === 'string'
    ? input.plan
    : undefined

const plan = inputPlan ?? getPlan(context.agentId)

if (inputPlan !== undefined && filePath) {
  // CCR 或本地编辑器提供了新内容，先覆盖本地方案文件
  await writeFile(filePath, inputPlan, 'utf-8').catch(logError)

  // 远程环境还要更新文件快照，避免恢复时拿到旧版本
  void persistFileSnapshotIfRemote()
}
```

`inputPlan` 为什么可能存在？

- 本地用户通过 `Ctrl+G` 编辑方案；
- CCR Web UI（远程控制页面）编辑方案后，把修改结果放到 `updatedInput`；
- 工具输入经过 `normalizeToolInput`（输入归一化）后，把磁盘内容或编辑内容注入到最终输入。

这里的“重写方案文件”不是重复保存，而是防止审批前后出现两个版本：

```text
旧方案已被 normalizeToolInput 快照
  ↓
用户在远程 UI 修改方案
  ↓
ExitPlanMode 收到新内容
  ↓
重新写盘 + 更新远程快照
```

---

## 七、普通用户审批：批准的不只是“离开 Plan”

### 7.1 审批 UI 还会选择后续模式

`ExitPlanModePermissionRequest.tsx` 不只显示 Yes / No。当前实现还可能根据上下文提供：

- 使用 `default` 模式继续；
- 使用 `acceptEdits`（允许常规编辑但仍保留部分确认）继续；
- 在可用时恢复 `auto`；
- 在可用时进入 `bypassPermissions`；
- 保留当前上下文继续；
- 接受方案并清理上下文后重新开始执行；
- 对方案添加反馈；
- 通过 `Ctrl+G` 编辑后再提交。

所以“用户批准方案”不能简单翻译成：

```text
mode = default
```

真实含义更接近：

```text
用户批准当前方案
  → 用户选择执行阶段的权限模式
  → 用户选择是否清理上下文
  → 可选携带方案反馈或编辑后的内容
```

### 7.2 `updatedInput` 让用户编辑回到模型

Plan V2 方案通常已经落盘，但如果用户在本地 UI 中编辑过方案，工具结果还要把编辑后的内容回灌给模型：

```typescript
// V2：没有本地编辑时，让工具从磁盘读取即可
// 如果用户编辑过，则把新内容作为 updatedInput 传回模型
const updatedInput =
  isV2 && !planEditedLocally
    ? {}
    : { plan: currentPlan }

toolUseConfirm.onAllow(
  updatedInput,
  permissionUpdates,
  acceptFeedback,
)
```

这一步解决的是“用户看到的是新方案，但模型上下文里还是旧方案”的一致性问题。

### 7.3 批准后的工具结果会包含方案正文

`mapToolResultToToolResultBlockParam()` 对普通主线程会生成类似结果：

```text
User has approved your plan. You can now start coding.

Your plan has been saved to: <filePath>
You can refer back to it if needed during implementation.

## Approved Plan:
<plan content>
```

这里的回灌作用很重要：

- 模型明确知道审批已经完成；
- 模型可以在下一轮继续按方案实现；
- 如果用户编辑过，模型看到的是标记为 edited 的方案；
- 不需要把整个方案只依赖文件系统再次拉取。

---

## 八、退出时如何恢复权限模式

### 8.1 普通恢复路径

退出时会在 `setAppState()` 中基于最新状态执行恢复：

```typescript
context.setAppState(prev => {
  if (prev.toolPermissionContext.mode !== 'plan') {
    // 可能已经被其他路径提前切出 Plan
    return prev
  }

  setHasExitedPlanMode(true)
  setNeedsPlanModeExitAttachment(true)

  let restoreMode =
    prev.toolPermissionContext.prePlanMode ?? 'default'

  return {
    ...prev,
    toolPermissionContext: {
      ...prev.toolPermissionContext,
      // 恢复进入 Plan 前的模式
      mode: restoreMode,
      // 恢复完成后清掉快照，避免下一次误用
      prePlanMode: undefined,
    },
  }
})
```

这里的两个状态标记也有作用：

- `hasExitedPlanMode`：记录当前 session 是否已经退出过 Plan；
- `needsPlanModeExitAttachment`：通知消息装配层，下一轮需要附加 Plan 退出相关信息。

它们不是权限模式本身，而是跨消息边界传递状态的辅助标记。

### 8.2 auto gate 关闭时不能强行恢复 auto

如果进入 Plan 前是 `auto`，但退出时 gate 已经关闭，源码会把恢复目标降级为 `default`：

```typescript
const prePlanRaw =
  appState.toolPermissionContext.prePlanMode ?? 'default'

if (
  prePlanRaw === 'auto' &&
  !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
) {
  // 不能在 gate 已关闭时偷偷恢复 auto
  restoreMode = 'default'

  context.addNotification?.({
    key: 'auto-mode-gate-plan-exit-fallback',
    text: 'plan exit → default · auto mode unavailable',
    priority: 'immediate',
    color: 'warning',
  })
}
```

这是一种 circuit breaker（断路器，外部能力不可用时主动降级）策略：

- 不静默恢复一个已经不可用的模式；
- 不让退出流程因为 gate 变化而卡住；
- 明确通知用户实际恢复成了 `default`。

### 8.3 危险权限规则要和实时 auto 状态一起处理

Plan 期间如果启用了 auto，可能调用 `stripDangerousPermissionsForAutoMode()` 暂时移除危险权限规则。退出时不能只看 `prePlanMode`：

```typescript
const finalRestoringAuto = restoreMode === 'auto'

// 实时状态优先于可能已经过时的 prePlanMode
const autoWasUsedDuringPlan =
  autoModeStateModule?.isAutoModeActive() ?? false

autoModeStateModule?.setAutoModeActive(finalRestoringAuto)

if (autoWasUsedDuringPlan && !finalRestoringAuto) {
  // auto 在 Plan 期间实际使用过，但退出后不再恢复
  setNeedsAutoModeExitAttachment(true)
}

if (finalRestoringAuto) {
  // 继续保持危险规则被 strip
  baseContext =
    permissionSetupModule?.stripDangerousPermissionsForAutoMode(
      baseContext,
    ) ?? baseContext
} else if (prev.toolPermissionContext.strippedDangerousRules) {
  // 退出到非 auto 模式时恢复之前被移除的规则
  baseContext =
    permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
    baseContext
}
```

这里有一个很容易写错的结论：

> `prePlanMode === 'auto'` 不等于“Plan 期间一直在使用 auto”。

用户可能在 Plan 中途关闭设置，`transitionPlanAutoMode()` 已经把 classifier 关闭，但 `prePlanMode` 仍然保留为 `auto`。因此退出时读取 `isAutoModeActive()` 才能判断实时状态。

---

## 九、teammate 的 Plan 审批：不是本地弹窗

### 9.1 teammate 的 `checkPermissions()` 直接放行

对于 teammate，`ExitPlanModeV2Tool` 不走当前进程的权限 UI：

```typescript
if (isTeammate()) {
  return {
    behavior: 'allow',
    updatedInput: input,
  }
}
```

这并不表示 teammate 已经获得用户批准，而是表示：

```text
不要在 teammate 进程里弹本地审批 UI
后续由 call() 根据 plan_mode_required 决定协议路径
```

teammate 通常没有可用的主终端交互界面。若让它等待本地用户操作，可能造成后台循环永久挂起。

### 9.2 `plan_mode_required` 会写入 leader mailbox

如果 teammate 必须先经过 leader 审批，`call()` 会执行：

```typescript
if (isTeammate() && isPlanModeRequired()) {
  if (!plan) {
    throw new Error(
      `No plan file found at ${filePath}. Please write your plan before calling ExitPlanMode.`,
    )
  }

  const requestId = generateRequestId(
    'plan_approval',
    formatAgentId(agentName, teamName || 'default'),
  )

  const approvalRequest = {
    type: 'plan_approval_request',
    from: agentName,
    timestamp: new Date().toISOString(),
    planFilePath: filePath,
    planContent: plan,
    requestId,
  }

  // 把审批请求写入 team-lead 的 mailbox，而不是弹窗
  await writeToMailbox(
    'team-lead',
    {
      from: agentName,
      text: jsonStringify(approvalRequest),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  // 更新共享任务状态，表示当前 teammate 正在等待审批
  setAwaitingPlanApproval(agentTaskId, context.setAppState, true)

  return {
    data: {
      plan,
      isAgent: true,
      filePath,
      awaitingLeaderApproval: true,
      requestId,
    },
  }
}
```

此时 teammate 还没有真正退出 Plan，也没有开始实现。返回给模型的结果会明确要求：

```text
Wait for the team lead to review your plan.
Do NOT proceed until you receive approval.
Check your inbox for response.
```

leader 后续通过 mailbox 回传批准或拒绝，teammate 再继续自己的循环。

### 9.3 为什么这条路径必须独立

普通用户和 teammate 的审批协议不同：

| 场景 | 请求发送到哪里 | 等待方式 | 谁改变执行状态 |
| --- | --- | --- | --- |
| 主线程 | 本地权限 UI | 同步等待用户选择 | 本地审批组件 |
| CCR 远程控制 | 远程 UI 与本地快照 | 远程编辑后回传 | 远程桥接 + 本地工具 |
| teammate | team-lead mailbox | 异步等待消息 | leader 与 teammate 协议 |

不能把 teammate 的 mailbox 写成“远程弹窗”。它是消息协议，包含 `requestId`、发送者、团队和方案内容，消费方还要负责把响应投递回正确的 Agent。

---

## 十、Plan 模式和权限层的真实关系

### 10.1 Plan 模式会影响权限层分流

`hasPermissionsToUseTool()` 中有两段与 Plan 相关的逻辑。

第一段：如果当前 Plan 期间仍启用了 auto classifier，则按 `auto` 路径处理：

```typescript
const useAutoClassifier =
  feature('TRANSCRIPT_CLASSIFIER') &&
  (
    appState.toolPermissionContext.mode === 'auto' ||
    (
      appState.toolPermissionContext.mode === 'plan' &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    )
  )
```

第二段：如果用户原本处于可绕过权限的上下文，Plan 可能继承这个能力：

```typescript
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (
    appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable
  )
```

这两段分别回答不同问题：

- 当前 Plan 是否沿用 auto classifier？
- 当前 Plan 是否继承 bypass 能力？

它们不能合并为一句“Plan 模式总是只读”。

### 10.2 需要用户交互的工具仍然保留交互

权限层对 `requiresUserInteraction()` 有单独保护：

```typescript
if (
  tool.requiresUserInteraction?.() &&
  result.behavior === 'ask'
) {
  // 不能因为 auto 或 Plan 就替用户回答
  return result
}
```

例如 `AskUserQuestion` 的价值就是获取用户答案，Plan 模式中的 auto classifier 不能替用户选择认证方案或产品行为。

### 10.3 “只读”要拆成三种含义

文章中经常把以下三件事写成同一件事：

1. **提示只读**：`EnterPlanMode` 的 `tool_result` 告诉模型不要修改文件；
2. **Agent Definition 只读**：内置 `Plan` 子 Agent 的 `disallowedTools` 禁止写工具；
3. **权限判断只读**：具体工具调用是否被当前权限上下文允许。

当前源码中它们是三套机制：

```text
主线程 Plan
  = mode 状态 + SOP + 权限层 + ExitPlanMode 审批

Plan 子 Agent
  = 独立 Agent Definition + 只读 system prompt + 工具黑名单
```

这样写比“Plan 模式把所有写工具删掉”更接近源码。

---

## 十一、几个容易混淆的流程

### 11.1 `AskUserQuestion` 不是方案审批

Plan 期间可以用 `AskUserQuestion` 澄清：

- 认证方式；
- 兼容性要求；
- 是否允许修改接口；
- 多种实现路线的偏好。

但不能用它问：

```text
这个 Plan 可以了吗？
要不要开始执行？
```

这些问题由 `ExitPlanMode` 审批 UI 负责。两者的结果不同：

| 工具 | 结果 | 回到哪里 |
| --- | --- | --- |
| `AskUserQuestion` | 用户答案 | 下一轮模型上下文 |
| `ExitPlanMode` | 批准、拒绝、编辑、反馈和后续权限模式 | 执行循环与权限上下文 |

### 11.2 `/plan` 不是 `EnterPlanMode` 的别名

它们最终共用 `prepareContextForPlanMode()`，但入口责任不同：

- `/plan` 是用户命令，可以显示当前方案或打开编辑器；
- `EnterPlanMode` 是模型工具，需要经过工具权限和工具调用生命周期；
- 两者都调用 `handlePlanModeTransition()`，防止附件状态重复。

### 11.3 Plan 文件不是固定的 `PLAN.md`

当前源码使用 session slug：

```text
getPlansDirectory()
  → getPlanSlug(sessionId)
  → {slug}.md
```

子 Agent 还会追加 `agentId`。因此文章里可以把它称为“方案文件”，但不要把固定文件名写成源码事实。

### 11.4 Plan 模式不是自动清理上下文

退出审批 UI 可以让用户选择清理上下文后再执行，但“是否清理上下文”是退出选项，不是进入 Plan 的必然行为。

这两个动作要分开：

```text
进入 Plan
  → 改权限模式，开始调研

批准退出
  → 用户可选择保留上下文或清理后重新执行
```

### 11.5 teammate 的 `allow` 不等于 leader 已批准

teammate 的 `checkPermissions()` 返回 `allow`，只是绕开本地权限 UI；真正的 Plan 审批仍由 `writeToMailbox('team-lead', ...)` 和后续响应完成。

---

## 十二、可复用的设计模式

### 12.1 状态快照与实时信号分离

`prePlanMode` 保存恢复目标，`isAutoModeActive()` 表示实时运行状态。

这是一种通用设计：

```text
持久字段：退出后应该恢复什么
实时信号：当前实际上启用了什么
```

适合处理用户可以在中途修改配置的状态机。

### 12.2 软约束与硬出口配合

Plan 模式没有把全部流程都编码成硬状态机，而是：

```text
SOP / system prompt
  → 引导模型探索、提问、写方案

权限层
  → 拦截不适合当前上下文的工具调用

ExitPlanMode
  → 把方案交给人或 leader 审批
```

这样既保留模型处理复杂任务的灵活性，又把真正的执行入口放在可审计的审批路径上。

### 12.3 文件是跨参与者的共享事实

方案文件同时服务：

- 模型；
- 本地用户；
- CCR Web UI；
- `VerifyPlanExecution` 等后续工具；
- session resume（会话恢复）；
- teammate leader 审批。

当多个参与者需要看到同一份方案时，文件比只放在单轮 prompt 中更容易检查、编辑和恢复。

### 12.4 不同执行形态使用不同审批协议

主线程、CCR 和 teammate 没有强行复用同一个 UI：

- 主线程适合同步终端审批；
- CCR 需要远程编辑和快照同步；
- teammate 需要异步 mailbox 协议。

审批机制应服从运行环境，而不是把所有 Agent 都当成有终端的主线程。

---

## 总结

Plan 模式的真实实现可以收束为六个动作：

```text
1. 进入：/plan 或 EnterPlanMode
2. 保存：prePlanMode 记录进入前模式
3. 协同：按配置决定 auto 是否在 Plan 期间保持激活
4. 调研：通过 tool_result 和 plan prompt 引导只读探索
5. 落盘：方案写入 session slug 对应的方案文件
6. 退出：ExitPlanMode 进入本地审批、远程同步或 teammate mailbox
```

最重要的四个判断是：

1. **主线程 Plan 模式不是 Plan 子 Agent**。前者是权限状态和审批工作流，后者是独立的只读 Agent Definition。
2. **Plan 模式不是简单删除写工具**。主线程仍使用统一工具注册，真正行为要结合权限层、工具自检和退出审批分析。
3. **`prePlanMode` 不是 auto 的实时状态**。退出时必须结合 `isAutoModeActive()`，否则设置中途变化会导致错误恢复。
4. **teammate 审批不是本地弹窗**。`plan_mode_required` 通过 leader mailbox 异步完成，teammate 需要等待响应后才能继续。

**相关源码**：`packages/builtin-tools/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts` · `packages/builtin-tools/src/tools/EnterPlanModeTool/prompt.ts` · `packages/builtin-tools/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` · `src/utils/permissions/permissionSetup.ts` · `src/utils/permissions/permissions.ts` · `src/utils/plans.ts` · `src/commands/plan/plan.tsx` · `src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx` · `packages/builtin-tools/src/tools/AgentTool/built-in/planAgent.ts`
