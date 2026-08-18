---
slug: /application-notes/engineering/claude-code-cli/cc-19-agent-teams
sidebar_position: 19
title: "Agent Teams：持久协作团队的源码实现"
description: "从 TeamCreate、teammate spawn、mailbox 到 shutdown，拆解 Agent Teams 如何把多个 Agent 组织成可通信、可审批、可清理的协作单元。"
---

> **阅读边界**：本文讲“多个 Agent 如何组成一个持久团队”。共享任务清单属于独立的任务管理专题；本文只说明 Agent Teams 如何建立成员、传递消息、维持独立循环并完成退出清理。

# Agent Teams：持久协作团队的源码实现

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。正文引用的是本地复刻仓库中的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **Team 创建**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\TeamCreateTool\TeamCreateTool.ts` 的 `TeamCreateTool.call()`——创建 Team 文件、共享任务列表和 leader context。
> - **teammate 分流**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\AgentTool\AgentTool.tsx` 的 `AgentTool.call()`——处理 `team_name + name` 分支，并决定是否进入 teammate spawn。
> - **成员创建**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\shared\spawnMultiAgent.ts` 的 `resolveSpawn()`、`spawnTeammate()`——解析成员身份、执行后端并双写运行时状态。
> - **Team 数据模型**：`D:\open_code\ai-native\claude-code\src\utils\swarm\teamHelpers.ts`——定义 `TeamFile`、成员状态和 Team 文件清理边界。
> - **执行后端**：`D:\open_code\ai-native\claude-code\src\utils\swarm\backends\registry.ts`——选择 pane backend（终端分屏执行后端）或 in-process backend。
> - **teammate 循环**：`D:\open_code\ai-native\claude-code\src\utils\swarm\inProcessRunner.ts` 的 `runInProcessTeammate()`——处理独立上下文、idle 等待和任务认领。
> - **消息传输**：`D:\open_code\ai-native\claude-code\src\utils\teammateMailbox.ts`——负责 mailbox 路径、文件锁、容量限制、读写和已读状态。
> - **消息工具**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\SendMessageTool\SendMessageTool.ts`——处理单播、广播和结构化控制消息。
> - **消息消费**：`D:\open_code\ai-native\claude-code\src\hooks\useInboxPoller.ts`——处理 process teammate、leader 的 inbox 轮询和消息分类。
> - **Plan 审批**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\ExitPlanModeTool\ExitPlanModeV2Tool.ts`——处理 teammate 的 `plan_approval_request`。
> - **Team 删除**：`D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\TeamDeleteTool\TeamDeleteTool.ts`——检查 active 成员、发送 shutdown 请求并清理 Team。

## 术语约定

本文保留源码中的类名、工具名和参数名，但第一次出现不常见的运行时术语时，会同时给出中文含义：

| 术语 | 中文解释 |
| --- | --- |
| `teammate` | Team 中的持久成员 Agent |
| `mailbox` | 以文件为载体的消息邮箱 |
| `roster` | Team 成员名册 |
| `in-process` | 在当前 Node.js 进程内运行 |
| `pane backend` | 通过终端 pane（分屏面板）启动成员的执行后端 |
| `idle` | 当前没有执行 prompt，但仍在等待新消息的空闲态 |
| `shutdown` | 成员结束前的关闭协议 |
| `poller` | 周期性检查消息的轮询器 |
| `snapshot` | 某一时刻记录下来的运行模式快照 |
| `AppState` | 当前进程内的运行状态，不是跨进程持久化真源 |

Agent Teams 不是“多开几个 subagent，然后并发执行”。

它额外建立了一个长期存在的协作边界：

- 团队有自己的名字和持久化配置；
- 每个 teammate 有稳定身份，而不是一次调用生成的临时任务；
- Agent 之间通过 mailbox（邮箱式消息通道）显式通信；
- teammate 完成一轮工作后进入 `idle`，可以继续接收新消息；
- 任务列表、成员 roster（成员名册）、消息 inbox（收件箱）和运行后端共同组成团队状态；
- 关闭团队时需要经过 shutdown（优雅关闭）和资源清理，而不是简单杀掉一个进程。

因此，Agent Teams 的核心问题不是“如何并发”，而是：

> 如何让多个拥有独立上下文的 Agent，在同一个团队命名空间中保持可寻址、可通信、可审批、可回收。

## 先给结论：Agent Teams 增加了什么

普通 subagent 通常是一次性的：

```text
主 Agent
  └─ AgentTool
       └─ runAgent()
       └─ 返回结果
```

Agent Teams 则把一次调用扩展成持久成员：

```text
TeamCreate
  ├─ Team 文件：团队身份、leader、成员 roster
  ├─ Task list：共享任务列表命名空间
  └─ AppState.teamContext：当前 leader 的运行时上下文

AgentTool(team_name + name)
  └─ spawnTeammate()
       ├─ 选择执行后端
       │    ├─ tmux / iTerm2 / Windows Terminal pane
       │    └─ in-process
       ├─ 写入成员配置
       └─ 启动 teammate 的持续循环

SendMessage
  └─ writeToMailbox()
       └─ teammate 轮询并接收新回合

TeamDelete
  └─ shutdown 检查
  └─ 删除 Team 与 task 目录
  └─ 清理 leader context、inbox 和颜色分配
```

这个结构中有四个容易混淆的概念：

| 概念 | 作用 | 生命周期 |
| --- | --- | --- |
| `regular subagent` | 主 Agent 临时委派的一次性 Agent | 通常随一次调用结束 |
| `fork subagent` | 从当前对话分叉出独立上下文的 Agent | 由 fork 调用链管理 |
| `teammate` | Team 中有名字、有身份、有 inbox 的成员 | 完成一轮后进入 `idle`，直到 shutdown |
| `team-lead` | 创建并协调 Team 的主 Agent | 随主会话存在，同时拥有 Team context |

所以，teammate 的关键特征不是“运行在另一个进程”，而是：

```text
持久身份
+ Team 命名空间
+ 显式消息协议
+ 可重复唤醒
+ 独立关闭流程
```

## 一、TeamCreate：创建的不只是一个配置文件

### 1.1 创建入口和前置检查

Team 创建由 `TeamCreateTool.call()` 完成，入口文件是：

```text
D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\TeamCreateTool\TeamCreateTool.ts
```

调用顺序可以概括为：

```text
检查 Agent Teams 开关
  ↓
检查当前 leader 是否已经管理 Team
  ↓
生成唯一 Team 名称
  ↓
创建 team-lead 身份和 TeamFile
  ↓
写入 ~/.claude/teams/<team>/config.json
  ↓
初始化共享 task list
  ↓
写入 leader 的 AppState.teamContext
```

首先会检查 `isAgentSwarmsEnabled()`。功能没有启用时，TeamCreate 直接失败，不会留下半初始化目录。

然后检查当前 `AppState.teamContext?.teamName`。源码限制一个 leader 同时只管理一个 Team：

```ts
// 先读取 leader 当前的 Team context，避免同一个 leader 同时管理多个 Team。
const appState = getAppState()
const existingTeam = appState.teamContext?.teamName

if (existingTeam) {
  // Team 已存在时直接失败，避免任务列表和 mailbox 归属产生歧义。
  throw new Error(
    `Already leading team "${existingTeam}". ` +
      `Use TeamDelete to end the current team first.`,
  )
}
```

这里的限制很重要。Team context 不只是 UI 状态，它还参与：

- `getTaskListId()` 的任务列表命名；
- leader 的成员视图；
- `SendMessage` 的默认发送者身份；
- `TeamDelete` 的清理范围。

如果一个 leader 同时挂接多个 Team，任务目录和消息归属都会出现歧义。

### 1.2 Team 名称、leader ID 与持久化文件

如果传入的 Team 名称已经存在，`generateUniqueTeamName()` 会生成新的词组名称，而不是直接覆盖旧 Team。

leader 的 ID 通过 `formatAgentId()` 按 Team 名称确定：

```ts
const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
// 中文说明：leader 的身份由“team-lead + Team 名称”确定，不是每次随机生成
```

随后构建 `TeamFile`：

```ts
const teamFile: TeamFile = {
  name: finalTeamName,
  description,
  createdAt: Date.now(),
  leadAgentId,
  leadSessionId: getSessionId(),
  members: [
    {
      agentId: leadAgentId,
      name: TEAM_LEAD_NAME,
      agentType: leadAgentType,
      model: leadModel,
      joinedAt: Date.now(),
      tmuxPaneId: '',
      cwd: getCwd(),
      subscriptions: [],
    },
  ],
}
```

`TeamFile` 的成员字段同时包含两类信息。

**身份和配置字段：**

- `agentId`
- `name`
- `agentType`
- `model`
- `prompt`
- `planModeRequired`
- `joinedAt`

**运行时字段：**

- `tmuxPaneId`
- `cwd`
- `worktreePath`
- `sessionId`
- `backendType`
- `isActive`
- `mode`

这说明 Team 文件是一个“持久化运行时投影”，不是单纯的静态配置。它既用于发现成员，也用于清理、审批和展示当前状态。

### 1.3 Team、任务列表和 AppState 的三处绑定

Team 创建完成后，源码会连续做三件事：

```ts
// Team 文件保存跨进程可发现的持久化投影。
await writeTeamFileAsync(finalTeamName, teamFile)

// Team 名称同时决定共享任务列表的命名空间。
const taskListId = sanitizeName(finalTeamName)
await resetTaskList(taskListId)
await ensureTasksDir(taskListId)

// 让 leader 后续通过 getTaskListId() 解析到同一份任务列表。
setLeaderTeamName(sanitizeName(finalTeamName))
```

这里的含义是：

```text
Team 文件
  └─ 保存成员与 Team 身份

任务列表目录
  └─ 给 Team 提供共享任务命名空间

leader team name
  └─ 让 getTaskListId() 对 leader 解析到同一个任务列表
```

如果只写 Team 文件而不调用 `setLeaderTeamName()`，leader 可能继续使用 session ID 作为任务列表 ID。这样 leader 和 teammate 虽然属于同一个 Team，却会读写不同任务目录。

最后，`TeamCreateTool.call()` 将 Team context 写入 AppState：

```ts
setAppState(prev => ({
  ...prev,
  teamContext: {
    teamName: finalTeamName,
    teamFilePath,
    leadAgentId,
    teammates: {
      [leadAgentId]: {
        name: TEAM_LEAD_NAME,
        agentType: leadAgentType,
        color: assignTeammateColor(leadAgentId),
        tmuxSessionName: '',
        tmuxPaneId: '',
        cwd: getCwd(),
        spawnedAt: Date.now(),
      },
    },
  },
}))
```

注意：源码不会给 leader 设置 `CLAUDE_CODE_AGENT_ID`。

原因是 `isTeammate()` 会根据 Agent ID 判断当前进程是否是 teammate。如果 leader 也设置了这个环境变量，leader 可能被错误识别为 teammate，进而影响 inbox 轮询和权限路由。

因此，leader 的身份主要通过：

```text
AppState.teamContext
+ leadAgentId
+ TEAM_LEAD_NAME
```

来表达，而不是把 leader 伪装成 teammate。

## 二、AgentTool：如何从普通 Agent 分流到 teammate

### 2.1 分流发生在 AgentTool，而不是 TeamCreate

TeamCreate 只负责建立 Team。

真正创建成员的是 `AgentTool.call()`：

```text
D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\AgentTool\AgentTool.tsx
```

源码先解析 Team 名称：

```ts
const teamName = resolveTeamName({ team_name }, appState)
```

`team_name` 可以来自两处：

1. 当前这次工具调用的 `team_name` 参数；
2. 当前 `AppState.teamContext` 中已经建立的 Team。

然后按以下顺序做限制和分流：

```text
解析 teamName
  ↓
teammate 不能再创建 teammate
  ↓
in-process teammate 不能创建 background agent
  ↓
teamName && name
  └─ spawnTeammate()
  ↓
否则进入 fork / regular subagent 路径
```

### 2.2 Team 成员创建条件：`team_name + name`

源码的关键判断是：

```ts
if (teamName && name) {
  // 只有同时拥有 Team 名称和稳定成员名，才进入 teammate 路径。
  const result = await spawnTeammate(
    {
      name,
      prompt,
      description,
      team_name: teamName,
      use_splitpane: true,
      plan_mode_required: spawnMode === 'plan',
      model: model ?? agentDef?.model,
      agent_type: subagent_type,
      invokingRequestId: assistantMessage?.requestId,
    },
    toolUseContext,
  )

  return {
    data: {
      // 返回结构化状态，让调用方知道这是成员创建成功，而非普通 subagent 结果。
      status: 'teammate_spawned',
      prompt,
      ...result.data,
    },
  }
}
```

这里有两个条件。

**`team_name`：**说明 Agent 要加入哪个 Team。

**`name`：**给成员一个可寻址的稳定名称，之后可以通过：

```json
{
  "to": "tester",
  "message": "请汇报测试结果"
}
```

发送消息。

如果只提供 `team_name` 而没有 `name`，不会进入 teammate spawn 分支；代码会继续走普通 Agent 分流。

### 2.3 为什么 teammate 不能创建 teammate

源码明确限制：

```ts
if (isTeammate() && teamName && name) {
  throw new Error(
    'Teammates cannot spawn other teammates — the team roster is flat.',
  )
}
```

Team roster 是扁平结构：

```text
team-lead
  ├─ researcher
  ├─ tester
  └─ reviewer
```

而不是树状结构：

```text
team-lead
  └─ researcher
       └─ tester
```

扁平结构带来三个好处：

- Team 文件只需要维护一层成员；
- 每个成员都可以直接通过名字寻址；
- shutdown、权限审批和任务回收不需要递归遍历子 Team。

它也意味着协调责任集中在 leader。teammate 可以创建普通 subagent，但不能把普通 subagent 注册为 Team teammate。

### 2.4 为什么 in-process teammate 不能创建后台 Agent

另一个限制是：

```ts
if (isInProcessTeammate() && teamName && run_in_background === true) {
  throw new Error(
    'In-process teammates cannot spawn background agents. ' +
      'Use run_in_background=false for synchronous subagents.',
  )
}
```

原因不是权限，而是生命周期绑定：

```text
leader 进程
  └─ in-process teammate
       └─ 共享同一个进程生命周期
```

如果 in-process teammate 再创建一个脱离主循环的后台 Agent，关闭、取消、权限和 AppState 更新就会出现多层嵌套，难以保证谁拥有最终控制权。

pane-based teammate 位于独立进程，可以拥有自己的后台任务生命周期，因此源码对它没有同样的限制。

## 三、spawnMultiAgent：成员创建的真实调用链

### 3.1 `resolveSpawn()`：解析身份和配置

文件：

```text
D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\shared\spawnMultiAgent.ts
```

`spawnTeammate()` 内部先调用 `resolveSpawn()`，完成以下解析：

```text
检查 name 和 prompt
  ↓
从 input 或 AppState 取得 teamName
  ↓
读取 TeamFile
  ↓
生成不重复的成员 name
  ↓
生成 agentId
  ↓
解析 model
  ↓
分配颜色
  ↓
确定工作目录
  ↓
解析 agentDefinition
```

关键代码如下：

```ts
const appState = context.getAppState()
const teamName = input.team_name || appState.teamContext?.teamName

if (!teamName) {
  throw new Error(
    'team_name is required. Call TeamCreate first.',
  )
}

const teamFile = await readTeamFileAsync(teamName)
if (!teamFile) {
  throw new Error(
    `Team "${teamName}" does not exist.`,
  )
}
```

成员名字如果已经存在，会由 `generateUniqueTeammateName()` 追加数字后缀：

```text
tester
tester-2
tester-3
```

这样做是为了保证 `SendMessage({ to: name })` 的目标唯一。

成员 ID 由成员名和 Team 名称组成：

```ts
const uniqueName = await generateUniqueTeammateName(input.name, teamName)
const sanitizedName = sanitizeAgentName(uniqueName)
const teammateId = formatAgentId(sanitizedName, teamName)
```

模型解析通过 `resolveTeammateModel()` 完成。它支持：

- 调用参数指定的模型；
- Agent definition（Agent 定义文件）中的模型；
- 全局 teammate 默认模型；
- `inherit`，表示继承 leader 的模型；
- 硬编码 fallback（兜底模型）。

### 3.2 选择执行后端

`getTeammateExecutor()` 统一返回 `TeammateExecutor`（teammate 执行器）接口。

当前源码支持：

| 后端 | 含义 |
| --- | --- |
| `tmux` | 使用 tmux pane 或 session 运行 teammate |
| `iterm2` | 使用 iTerm2 原生 pane |
| `windows-terminal` | 使用 Windows Terminal pane/tab |
| `in-process` | 在当前进程中运行，但通过上下文隔离身份 |

后端注册入口：

```text
D:\open_code\ai-native\claude-code\src\utils\swarm\backends\registry.ts
```

选择逻辑不是“pane 失败就一定回退 in-process”。实际流程受到多个条件影响：

```text
preferInProcess && isInProcessEnabled()
  └─ 使用 in-process

否则尝试 pane backend
  ├─ tmux
  ├─ iTerm2
  └─ Windows Terminal

pane backend 不可用
  └─ 只有 teammate mode snapshot 为 auto 时，
     才可能回退到 in-process
```

因此，文章中不能把执行后端简单写成“优先开 pane，失败无条件降级”。

### 3.3 成员的双写：运行时状态 + TeamFile

执行器成功返回后，`spawnMultiAgent.ts` 会写两处状态。

**第一处是 leader 的 AppState：**

```ts
// 第一份是 leader 进程立即使用的运行时状态，服务当前 UI 和路由。
context.setAppState(prev => ({
  ...prev,
  teamContext: {
    ...prev.teamContext,
    teammates: {
      ...existingTeammates,
      [spawn.teammateId]: {
        name: spawn.sanitizedName,
        agentType: spawn.agentDefinition?.agentType,
        color: spawn.teammateColor,
        tmuxSessionName: display.sessionName,
        tmuxPaneId: display.paneId,
        cwd: spawn.workingDir,
        spawnedAt: Date.now(),
      },
    },
  },
}))
```

**第二处是 TeamFile.members：**

```ts
// 第二份是跨进程共享的 Team 持久化投影，供发现成员和关闭清理使用。
teamFile.members.push({
  agentId: spawn.teammateId,
  name: spawn.sanitizedName,
  agentType: input.agent_type,
  model: spawn.model,
  prompt: input.prompt,
  color: spawn.teammateColor,
  planModeRequired: input.plan_mode_required,
  joinedAt: Date.now(),
  tmuxPaneId: display.paneId,
  cwd: spawn.workingDir,
  subscriptions: [],
  backendType: result.backendType,
})

await writeTeamFileAsync(spawn.teamName, teamFile)
```

两处数据的职责不同：

| 状态 | 适合回答的问题 |
| --- | --- |
| `AppState.teamContext` | 当前 leader UI 立即要显示什么 |
| `TeamFile.members` | 其他进程如何发现成员，关闭时如何清理 |

这也是为什么 Agent Teams 可以支持 pane-based 和 in-process 两种模式：运行时共享方式不同，但持久化 Team 投影相同。

## 四、身份和上下文边界：teammate 并不共享完整对话

### 4.1 in-process 不等于共享上下文

in-process teammate 与 leader 在同一个 Node.js 进程中运行，但这不表示它们共享完整的消息历史。

源码通过 `runWithTeammateContext()` 使用 `AsyncLocalStorage`（异步本地存储）隔离身份：

```text
同一个进程
  ├─ leader execution context
  └─ teammate execution context
       ├─ agentId
       ├─ agentName
       ├─ teamName
       ├─ color
       └─ planModeRequired
```

可以把它理解成：

```text
共享进程
≠
共享完整 transcript（对话记录）
```

更准确的表达是：

```text
in-process
= 同一进程
+ AsyncLocalStorage 身份隔离
+ 独立 teammate AppState 任务投影
+ 独立 prompt / message loop
```

### 4.2 仍然复用普通 Agent 循环

`runInProcessTeammate()` 内部仍然调用普通的 `runAgent()` 和 `query()` 循环。

这说明 Team 并没有重新实现一套 Agent 推理引擎，而是在普通循环外面增加：

- teammate identity；
- Team message 注入；
- idle 等待；
- shutdown 处理；
- 任务列表接入；
- leader 权限桥接。

这是一种典型的 harness（Agent 外围控制层）设计：

```text
复用已有 Agent loop
+ 增加角色上下文
+ 增加生命周期控制
+ 增加跨 Agent 协议
```

### 4.3 为什么 teammate 的普通输出不会自动同步给 leader

in-process runner 中有一条很容易被忽略的注释：teammate 的响应不会自动发送给 leader。

也就是说：

```text
teammate 输出结果
  └─ 保存在 teammate 自己的消息和 UI 投影中

leader 想知道结果
  └─ teammate 必须显式调用 SendMessage
```

这样可以避免每一轮普通输出都自动污染 leader 的上下文。协作信息必须经过显式协议，模型才需要承担“什么值得汇报”的判断。

## 五、in-process teammate：工作一轮后不会立即销毁

### 5.1 `runInProcessTeammate()` 的持续循环

in-process teammate 的生命周期可以表示为：

```text
spawn
  ↓
运行当前 prompt
  ↓
清理当前 work controller
  ↓
标记 isIdle = true
  ↓
发送 idle notification
  ↓
waitForNextPromptOrShutdown()
  ├─ 收到 leader 消息 → 新一轮 query
  ├─ 发现可认领任务 → 新一轮 query
  ├─ 收到 shutdown request → 交给模型决定
  └─ abort → 退出循环
```

完成一轮工作后，源码会把 `isIdle` 设为 `true`，但不会把成员标记为 completed：

```ts
updateTaskState(
  taskId,
  task => ({
    ...task,
    isIdle: true,
    onIdleCallbacks: [],
  }),
  setAppState,
)
```

这里的 `idle` 表示“当前没有正在执行的 prompt”，不是“成员已经终止”。

### 5.2 idle 时等待什么

`waitForNextPromptOrShutdown()` 每隔一段时间检查：

1. AppState 中的 pending user message；
2. mailbox 中的 shutdown request；
3. mailbox 中来自 leader 的普通消息；
4. mailbox 中来自其他 teammate 的普通消息；
5. Team task list 中可认领的任务；
6. abort signal。

源码会优先处理 shutdown request，避免大量普通消息把关闭请求一直推迟。

普通消息的优先级也有明确规则：

```text
team-lead 消息
  ↓
其他 teammate 消息
  ↓
任务列表中的可认领任务
```

这体现了 leader 的控制优先级。leader 代表用户意图，不能因为 peer-to-peer（成员之间）消息太多而长期收不到控制消息。

### 5.3 任务列表是协作面，不是消息替代品

in-process teammate 启动时会调用 `tryClaimNextTask()`：

```ts
const tasks = await listTasks(taskListId)
const availableTask = findAvailableTask(tasks)

if (!availableTask) {
  return undefined
}

const result = await claimTask(
  taskListId,
  availableTask.id,
  agentName,
)

if (!result.success) {
  return undefined
}

await updateTask(taskListId, availableTask.id, {
  status: 'in_progress',
})
```

这段代码只说明 Agent Teams 如何接入任务系统：

- teammate 启动时可以从 Team 任务列表找工作；
- 成功认领后把任务改成 `in_progress`；
- 任务 subject 和 description 会被格式化为下一轮 prompt。

`claimTask()` 的锁粒度、阻塞判断、`agent_busy` 等返回原因属于任务管理专题；本文只保留它在 teammate 启动和任务接管流程中的调用位置。

## 六、SendMessage 与 mailbox：显式的 Agent 间通信

### 6.1 SendMessage 是 Agent 可见接口

文件：

```text
D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\SendMessageTool\SendMessageTool.ts
```

工具输入支持：

```ts
{
  to: string,
  summary?: string,
  message: string | StructuredMessage
}
```

`to` 可以是：

- teammate 名称，单播给一个成员；
- `*`，广播给 Team 中其他成员；
- 某些构建中的 `uds:`、`bridge:` 或 `tcp:` 地址，用于本地或远程 peer。

普通文本消息需要配合 `summary`。summary 是展示层预览，不是传输协议本身。

结构化消息使用 `type` 区分控制语义，例如：

```ts
const StructuredMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shutdown_request'),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('shutdown_response'),
    request_id: z.string(),
    approve: semanticBoolean(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('plan_approval_response'),
    request_id: z.string(),
    approve: semanticBoolean(),
    feedback: z.string().optional(),
  }),
])
```

这里的 discriminated union（按 `type` 字段区分的联合结构）比“约定一段普通文本”更可靠：

- 接收方可以先按 `type` 路由；
- 控制消息不需要让模型猜测语义；
- 非法字段可以在 schema 层被拒绝。

### 6.2 `handleMessage()` 到 `writeToMailbox()`

发送普通消息时，工具会先取得当前发送者：

```ts
const appState = context.getAppState()
const teamName = getTeamName(appState.teamContext)
const senderName =
  getAgentName() ||
  (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
const senderColor = getTeammateColor()
```

然后调用：

```ts
// mailbox 写入只负责投递消息，不直接调用对方的模型循环。
await writeToMailbox(
  recipientName,
  {
    from: senderName,
    text: content,
    summary,
    timestamp: new Date().toISOString(),
    color: senderColor,
  },
  teamName,
)
```

`SendMessage` 本身不直接唤醒对方的模型。它只负责把消息写入目标 mailbox。

是否及时收到消息，由接收方的：

- `waitForNextPromptOrShutdown()`；
- 或 `useInboxPoller()`；

决定。

### 6.3 mailbox 的文件结构与并发安全

`teammateMailbox.ts` 的默认路径是：

```text
~/.claude/teams/<team_name>/inboxes/<agent_name>.json
```

一个收件箱是一个 JSON 数组：

```json
[
  {
    "from": "team-lead",
    "text": "请补充测试结论",
    "timestamp": "2026-08-04T08:00:00.000Z",
    "read": false,
    "color": "cyan",
    "summary": "补充测试结论"
  }
]
```

写入流程不是简单 `read → push → write`：

```text
确保 inbox 目录存在
  ↓
确保 inbox 文件存在
  ↓
获取 inbox lock
  ↓
重新读取最新内容
  ↓
追加消息
  ↓
压缩 mailbox
  ↓
临时文件写入 + rename 原子替换
  ↓
释放 lock
```

源码中的关键容量限制包括：

| 限制 | 值 | 作用 |
| --- | --- | --- |
| 单条文本 | `64 KB` | 防止单条消息过大 |
| mailbox 文件 | `4 MB` | 防止收件箱无限增长 |
| 保留消息总量 | `2 MB` | 压缩后控制长期占用 |
| 普通消息数量 | `1000` | 保留最近消息 |
| 已读消息数量 | `200` | 已读历史只保留有限数量 |

压缩时会优先保留未读的结构化协议消息，避免 shutdown、审批等控制消息被普通聊天挤掉。

### 6.4 为什么消息必须显式发送

源码明确不会把 teammate 的普通 assistant 输出自动复制到 leader。

因此以下写法是不可靠的：

```text
teammate 完成工作
  └─ 只在自己的终端输出“完成”
  └─ 期待 leader 自动看到
```

正确流程是：

```text
teammate 完成工作
  └─ 调用 SendMessage
       ├─ to: team-lead
       ├─ summary: 结论摘要
       └─ message: 结构化结果和风险
```

显式消息让“结果是否值得汇报”成为协作协议的一部分，而不是把所有输出都复制进 leader context。

## 七、useInboxPoller：process teammate 和 leader 如何消费消息

### 7.1 in-process teammate 不使用这个 hook

`useInboxPoller.ts` 的注释明确说明：

```text
in-process teammate
  └─ 不使用 useInboxPoller
  └─ 使用 waitForNextPromptOrShutdown()
```

原因是 in-process teammate 与 leader 共享 React context 和 AppState。如果再使用同一个 React hook 轮询 mailbox，可能出现：

- leader 和 teammate 重复消费同一条消息；
- 消息被错误注入 leader 的循环；
- 身份判断依赖当前渲染时的异步上下文，产生路由歧义。

因此，源码按运行模式分开消息消费机制。

### 7.2 process teammate 和 leader 的轮询

普通 process teammate 或 team-lead 通过 `useInboxPoller()` 每约 1 秒检查一次 unread 消息：

```text
每 1 秒
  ↓
确定当前 agent name
  ↓
readUnreadMessages()
  ↓
按消息类型分类
  ├─ permission request
  ├─ permission response
  ├─ sandbox permission
  ├─ shutdown
  ├─ plan approval
  ├─ mode set
  └─ regular message
  ↓
成功处理或可靠排队后标记已读
```

`onSubmitMessage()` 的行为取决于当前循环是否忙：

```text
Agent idle
  └─ 直接提交为新一轮 prompt

Agent busy
  └─ 先进入 AppState.inbox 队列
  └─ 当前回合结束后再投递
```

这里的关键不是“轮询频率”，而是“消息不会在 Agent 忙时强行打断当前工具调用”。

### 7.3 为什么要成功投递后才标记已读

源码把 `markMessagesAsRead()` 放在消息成功处理或可靠排队之后。

如果先标记已读，再因为 Agent 正在运行而提交失败，就可能造成消息丢失。

正确顺序是：

```text
读取 unread
  ↓
尝试直接提交或进入队列
  ↓
提交成功 / 已可靠排队
  ↓
标记已读
```

这是一种简单的 at-least-once（至少一次）投递倾向：同一条消息可能因异常被重复读取，但不应在尚未投递时被静默丢弃。

## 八、Plan 审批：Team 里的权限交接协议

Plan 模式的完整机制已在 [18 Plan 模式深度拆解](cc-18-plan-mode-deep-dive.md) 讲过。本文只补充 Agent Teams 中的跨成员边界。

### 8.1 teammate 如何请求 leader 审批

当 teammate 的 `planModeRequired` 为 `true`，它需要在计划完成后发送结构化请求：

```json
{
  "type": "plan_approval_request",
  "requestId": "plan-...",
  "from": "researcher",
  "summary": "等待 leader 审批计划"
}
```

请求通过 teammate mailbox 发送给 leader。

这不是普通文本消息，接收方可以通过 `isPlanApprovalRequest()` 识别。

### 8.2 leader 侧如何处理

`useInboxPoller()` 在 leader 侧会把 `plan_approval_request` 分类出来，并写回：

```json
{
  "type": "plan_approval_response",
  "requestId": "plan-...",
  "approved": true,
  "permissionMode": "default"
}
```

源码还会把当前 leader 的外部权限模式作为 teammate 后续模式的参考：

```ts
const leaderExternalMode = toExternalPermissionMode(
  currentAppState.toolPermissionContext.mode,
)

const modeToInherit =
  leaderExternalMode === 'plan'
    ? 'default'
    : leaderExternalMode
```

如果 leader 自己仍处在 `plan`，不会把 `plan` 再传给已经获得批准的 teammate，而是使用 `default` 作为后续模式。

### 8.3 为什么只接受 team-lead 的批准

teammate 侧处理审批响应时会检查：

```ts
if (approvalResponse && msg.from === 'team-lead') {
  // 只有 leader 的响应才能改变 plan 状态
}
```

来自其他 teammate 的同类型消息会被忽略。

这是一个身份授权边界：

```text
普通 teammate
  └─ 可以讨论计划
  └─ 不能伪造审批

team-lead
  └─ 可以批准或拒绝计划
  └─ 可以决定 teammate 进入的权限模式
```

计划被拒绝时，teammate 不会被销毁，也不会自动进入执行阶段。它会继续停留在 Plan 流程中，根据 feedback 修改计划。

## 九、Agent Teams 与共享任务系统的边界

### 9.1 Team 只提供协作命名空间

TeamCreate 会初始化 task list，但它不负责实现任务状态机。

可以把两者关系理解为：

```text
Agent Teams
  └─ 谁属于这个 Team
  └─ 如何发送消息
  └─ 如何启动和关闭成员
  └─ 使用哪个 task list 命名空间

Task Management
  └─ 如何创建任务
  └─ 如何维护 blocks / blockedBy
  └─ 如何加锁和认领
  └─ 如何处理 owner 和状态
  └─ 如何让 UI 观察任务变更
```

在 Team 场景中，`getTaskListId()` 会优先解析到 Team 名称，因此多个成员可以看到同一个任务目录。

### 9.2 teammate 启动时的工具接入

in-process runner 会把协作必需工具强制加入 teammate 的工具集合：

```ts
tools: agentDefinition?.tools
  ? [
      ...new Set([
        ...agentDefinition.tools,
        SEND_MESSAGE_TOOL_NAME,
        TEAM_CREATE_TOOL_NAME,
        TEAM_DELETE_TOOL_NAME,
        TASK_CREATE_TOOL_NAME,
        TASK_GET_TOOL_NAME,
        TASK_LIST_TOOL_NAME,
        TASK_UPDATE_TOOL_NAME,
      ]),
    ]
  : ['*'],
```

中文说明：

- 即使 Agent definition 的工具列表很窄，teammate 仍然需要能够发送消息；
- Team 生命周期工具必须可用；
- 任务协作四件套必须可用；
- 使用 `Set` 去重，避免原列表和强制注入列表重复。

任务工具的详细行为属于任务管理专题，本文不在 Agent Teams 篇重复展开。

### 9.3 Team 的四个状态投影

从源码看，一个 Team 至少有四个相互关联的状态投影：

```text
TeamFile
  └─ 成员身份、后端、状态、权限模式

AppState.teamContext
  └─ leader 当前 UI 和运行时上下文

Task list
  └─ 团队要做什么、谁拥有任务、任务是否完成

Mailbox
  └─ 成员之间传递什么控制消息和结果
```

它们不是同一份数据，也不会自动互相替代：

- TeamFile 不是任务列表；
- mailbox 不是任务状态；
- AppState 不是跨进程事实来源；
- task owner 也不等于成员当前是否在线。

## 十、idle、shutdown 与 TeamDelete

### 10.1 一轮工作完成后是 idle

teammate 完成当前 prompt 后：

```text
当前 prompt 完成
  ↓
清除 currentWorkAbortController
  ↓
设置 isIdle = true
  ↓
发送 idle notification
  ↓
继续等待新消息或新任务
```

不要把以下状态混在一起：

| 状态 | 含义 |
| --- | --- |
| `in_progress` | 当前任务正在执行 |
| `idle` | 当前没有工作，但成员仍存活 |
| `completed` | 某项任务已完成，或运行任务对象已终止 |
| `shutdown_approved` | 成员同意结束自己的生命周期 |
| Team deleted | Team 的持久化目录和运行时上下文被清理 |

### 10.2 shutdown 是 request/response 协议

leader 请求关闭 teammate 时，不是直接调用 `kill()`：

```text
leader
  └─ SendMessage({
       type: "shutdown_request",
       reason: "任务已完成"
     })

teammate
  ├─ approveShutdown
  │    └─ shutdown_approved
  └─ rejectShutdown
       └─ shutdown_rejected
```

in-process teammate 在 `waitForNextPromptOrShutdown()` 中优先读取 shutdown request，再把请求交给模型决定。

这样做允许 teammate 在关闭前：

- 完成正在进行的清理；
- 汇报未完成工作；
- 拒绝过早关闭；
- 让 leader 知道还有哪些任务没有处理。

### 10.3 in-process 和 pane backend 的关闭差异

对于 in-process teammate，批准关闭后会通过 `AbortController.abort()` 停止自己的执行循环。

对于 pane backend，leader 侧会根据成员记录中的：

- `tmuxPaneId`
- `backendType`

调用对应 backend 的 terminate 或 kill pane 逻辑。

因此，shutdown 消息是统一协议，但底层执行不同：

```text
统一层：shutdown request / response

in-process：
  └─ AbortController.abort()

tmux / iTerm2 / Windows Terminal：
  └─ backend.terminate()
  └─ backend.killPane()
```

### 10.4 TeamDelete 为什么会被 active 成员阻止

文件：

```text
D:\open_code\ai-native\claude-code\packages\builtin-tools\src\tools\TeamDeleteTool\TeamDeleteTool.ts
```

`TeamDeleteTool.call()` 首先读取 TeamFile，并排除 leader，只检查非 leader 成员：

```ts
// TeamDelete 只检查非 leader 成员；leader 本身由当前会话负责清理。
const nonLeadMembers = teamFile.members.filter(
  member => member.name !== TEAM_LEAD_NAME,
)

// 仍处于 active 的成员会阻止 Team 立即删除。
const activeMembers = nonLeadMembers.filter(
  member => member.isActive !== false,
)
```

如果存在 active 成员：

1. 尝试向成员发送 graceful shutdown（优雅关闭）；
2. 如果传入 `wait_ms`，等待成员变为 inactive；
3. 仍然 active 时阻止清理；
4. 只有所有成员退出或处于 idle 后才继续。

这说明 TeamDelete 不是“删除 JSON 文件”的快捷操作，而是生命周期的最后一个关卡。

### 10.5 TeamDelete 的清理范围

清理成功后，源码会处理：

```text
cleanupTeamDirectories(teamName)
  ├─ 删除 Team 目录
  ├─ 删除 task 目录
  └─ 清理相关 worktree

clearLeaderTeamName()
  └─ 让 getTaskListId() 回到 session ID fallback

clearTeammateColors()
  └─ 释放成员颜色分配

setAppState(...)
  ├─ teamContext = undefined
  └─ inbox.messages = []
```

因此 TeamDelete 的语义是：

```text
终止 Team 的运行时协作空间
+ 删除持久化投影
+ 解除 leader 与 Team task list 的绑定
+ 清理 UI 侧的成员和消息状态
```

## 十一、Agent Teams、regular、fork 和后台任务的选型

### 11.1 选型表

| 场景 | 推荐机制 | 关键特征 |
| --- | --- | --- |
| 需要一个 Agent 完成一次独立工作 | regular subagent | 调用结束后返回结果 |
| 需要从当前上下文分叉一个独立执行分支 | fork subagent | 继承特定上下文关系，但不是 Team 成员 |
| 需要多个可互相通信、可重复唤醒的成员 | Agent Teams | 持久身份、mailbox、idle、shutdown |
| 需要不阻塞当前主循环的长任务 | background task | 通过异步任务状态和完成通知回收 |
| 需要集中调度多个一次性 worker | coordinator | 关注任务分发，不等价于 Team roster |

### 11.2 Agent Teams 不是普通 subagent 的并发包装

普通 subagent 的核心返回值是：

```text
调用结果
```

teammate 的核心产物则是：

```text
成员身份
+ TeamFile 记录
+ inbox 地址
+ 可继续工作的 idle 状态
+ 可被 leader 关闭的生命周期
```

所以“并发执行”只是 Agent Teams 的一个表现，不是它的定义。

### 11.3 Agent Teams 与 coordinator 的边界

本文不展开 coordinator 的完整源码，因为它与 Team 的职责不同。

可以先用一句话区分：

```text
coordinator：
  主要负责“把工作分发给若干执行单元”

Agent Teams：
  负责“让若干有持久身份的成员形成协作组织”
```

如果只需要一次性并发，不需要成员之间对话和反复唤醒，普通 Agent 或后台任务更合适。

如果成员需要互相发送结果、等待 leader 审批、共享任务列表，并在当前工作完成后继续待命，才需要 Agent Teams。

## 十二、端到端示例：从创建 Team 到关闭 Team

### 12.1 创建 Team

leader 调用：

```json
{
  "team_name": "auth-refactor",
  "description": "并行完成认证模块重构",
  "agent_type": "team-lead"
}
```

系统创建：

```text
~/.claude/teams/auth-refactor/config.json
~/.claude/tasks/auth-refactor/
AppState.teamContext = {
  teamName: "auth-refactor",
  leadAgentId: "team-lead@auth-refactor"
}
```

### 12.2 创建两个 teammate

leader 通过 AgentTool 调用：

```json
{
  "name": "api-worker",
  "team_name": "auth-refactor",
  "subagent_type": "general-purpose",
  "prompt": "实现认证 API 重构",
  "mode": "plan"
}
```

另一个成员：

```json
{
  "name": "test-worker",
  "team_name": "auth-refactor",
  "subagent_type": "general-purpose",
  "prompt": "补充认证模块测试"
}
```

第一个成员因为 `mode: "plan"` 得到：

```ts
plan_mode_required: spawnMode === 'plan'
```

它必须先走 Plan 审批协议。

### 12.3 成员协作

`api-worker` 完成计划后向 leader 发送：

```json
{
  "type": "plan_approval_request",
  "requestId": "plan-api-001",
  "summary": "等待 API 重构计划审批"
}
```

leader 发送批准响应：

```json
{
  "type": "plan_approval_response",
  "requestId": "plan-api-001",
  "approved": true,
  "permissionMode": "default"
}
```

实现完成后，`api-worker` 必须显式发送结果：

```json
{
  "to": "team-lead",
  "summary": "API 重构完成",
  "message": "已完成认证入口、token 校验和错误处理，剩余风险是旧客户端兼容性。"
}
```

`test-worker` 可以通过 task list 看到任务，也可以通过 SendMessage 获取额外上下文。

### 12.4 idle 与新一轮工作

`api-worker` 当前 prompt 完成后：

```text
api-worker
  └─ isIdle = true
  └─ 等待 leader 新消息
  └─ 等待新的可认领任务
```

leader 之后可以发送：

```json
{
  "to": "api-worker",
  "summary": "处理兼容性问题",
  "message": "请根据旧客户端调用方式补充兼容层。"
}
```

teammate 收到消息后进入下一轮 query，而不是重新创建一个成员。

### 12.5 关闭 Team

所有工作结束后，leader 调用：

```json
{
  "wait_ms": 5000
}
```

TeamDelete 会：

```text
检查 active 成员
  ↓
发送 shutdown request
  ↓
等待成员确认或变为 inactive
  ↓
清理 Team 目录和 task 目录
  ↓
清除 teamContext 和 inbox
```

如果仍有 active 成员，TeamDelete 返回失败，不会强行删除整个 Team 的持久化状态。

## 十三、常见误区

### 误区一：TeamCreate 只创建一个 config.json

不完整。

它还会：

- 创建初始 leader 成员；
- 初始化 Team task list；
- 绑定 leader 的 task list 命名空间；
- 写入 `AppState.teamContext`；
- 注册 session cleanup。

### 误区二：in-process teammate 和 leader 共享完整上下文

不准确。

它们共享进程，但通过 `AsyncLocalStorage` 和独立的 teammate runner 隔离身份和循环。

### 误区三：teammate 完成一轮就销毁

不准确。

正常流程是：

```text
一轮工作完成
  └─ idle
       └─ 等待新消息、任务或 shutdown
```

### 误区四：teammate 的普通输出会自动回到 leader

不准确。

需要通过 `SendMessage` 显式发送。

### 误区五：所有消息都由 useInboxPoller 消费

不准确。

in-process teammate 使用 `waitForNextPromptOrShutdown()`，`useInboxPoller()` 主要服务于 process teammate 和 leader。

### 误区六：pane backend 失败一定回退到 in-process

不准确。

是否回退取决于 teammate mode snapshot 和 backend registry 的选择逻辑。

### 误区七：TeamDelete 就是删除目录

不准确。

TeamDelete 先处理 active 成员、shutdown 和等待，再清理 Team、task、worktree、颜色、inbox 和 AppState。

### 误区八：Agent Teams 负责完整实现任务系统

不准确。

Agent Teams 只建立共享任务列表的命名空间并接入任务工具。任务锁、依赖、认领、owner 和 UI store 属于任务管理专题；本篇只说明 Team 如何把这些能力接入成员生命周期。

## 十四、总结：Agent Teams 的设计本质

Agent Teams 的核心不是把多个 Agent 放在一起，而是把协作关系显式化：

```text
TeamCreate
  └─ 建立持久化协作边界

AgentTool + spawnTeammate
  └─ 把普通 Agent 调用分流为有身份的成员

TeamFile
  └─ 保存成员 roster 和运行时投影

mailbox
  └─ 提供显式、可寻址的消息通道

in-process runner / pane backend
  └─ 提供不同的执行承载方式

Plan approval
  └─ 把权限和计划批准限制在 leader

idle / shutdown / TeamDelete
  └─ 管理成员和 Team 的完整生命周期
```

最终可以用一句话概括：

> Agent Teams 是“持久身份 + Team 命名空间 + 显式消息协议 + 独立生命周期”的多 Agent 协作系统；它复用普通 Agent loop，但通过 TeamFile、mailbox、任务列表和 shutdown 协议，把一次性委派提升为可持续协作。
