---
slug: /application-notes/engineering/claude-code-cli/cc-21-background-task-framework
sidebar_position: 21
title: "后台任务框架"
description: "从任务注册、输出落盘、增量读取到通知回注，拆解 Claude Code 如何管理持续运行的后台执行器。"
---

> 本篇只讨论后台执行器的运行时机制：任务如何注册、输出如何落盘、主循环如何读取增量、完成通知如何回到模型，以及不同执行器如何实现取消。

# 后台任务框架

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **任务模型**：`src/Task.ts`——定义 `TaskType`、`TaskStatus`、`TaskStateBase`、`Task` 和 `generateTaskId()`。
> - **任务注册表**：`src/tasks.ts`——通过 `getAllTasks()` 注册可被统一分发的执行器，并由 `getTaskByType()` 按类型查找。
> - **公共框架**：`src/utils/task/framework.ts`——提供 `registerTask()`、`updateTaskState()`、`generateTaskAttachments()`、`applyTaskOffsetsAndEvictions()` 和 `evictTerminalTask()`。
> - **输出落盘**：`src/utils/task/diskOutput.ts`——实现 `DiskTaskOutput`、追加写入、尾部读取、按 `outputOffset` 增量读取和输出文件清理。
> - **主循环接入**：`src/utils/attachments.ts` 的 `getUnifiedTaskAttachments()`——调用公共框架读取任务增量，并把结果转换为统一 attachment（回合附加信息）。
> - **消息队列**：`src/utils/messageQueueManager.ts`——实现 `now → next → later` 优先级和 `enqueuePendingNotification()`。
> - **Agent 分流**：`src/query.ts`——根据 `agentId` 和 `mode` 决定主线程、子 Agent 应该消费哪些命令。
> - **消息包装**：`src/utils/messages.ts`——由 `wrapCommandText()` 为 `task-notification` 加入可信来源前缀。
> - **统一取消**：`src/tasks/stopTask.ts`——检查任务状态后，按 `TaskType` 分发到具体执行器的 `kill()`。
> - **执行器实现**：`src/tasks/LocalShellTask/LocalShellTask.tsx`、`src/tasks/LocalAgentTask/LocalAgentTask.tsx`、`src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`、`src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx`。
>
> **调用关系**：
>
> ```text
> 具体执行器
>   ├─ registerTask / updateTaskState
>   ├─ appendTaskOutput
>   └─ enqueuePendingNotification
>          ↓
> src/utils/task/framework.ts
>   ├─ generateTaskAttachments
>   └─ applyTaskOffsetsAndEvictions
>          ↓
> src/utils/attachments.ts / src/query.ts
>   ├─ 运行中增量信息
>   └─ task-notification 消息回注
> ```

## 先给结论

普通 Agent loop（Agent 循环）通常按回合运行：

```text
模型请求
  ↓
工具调用
  ↓
工具结果进入上下文
  ↓
模型开始下一回合
```

如果工具必须等待十分钟才返回，当前回合就会一直被占用。

后台任务框架把“需要持续运行的执行器”从当前回合中拆出来：

```text
创建任务
  ↓
立即返回 taskId
  ↓
后台执行器继续运行
  ↓
输出写入磁盘
  ↓
主循环按 outputOffset 增量读取
  ↓
终态时投递 task-notification
  ↓
消息进入模型上下文
  ↓
状态和内存索引按条件回收
```

因此，后台任务框架并不只是“把命令放到后台执行”。它同时维护四种关系：

1. **运行时状态**：`AppState.tasks` 记录任务类型、状态、输出游标和通知标记。
2. **完整输出**：大块标准输出 stdout、标准错误 stderr 或 Agent transcript（会话记录）写入磁盘，不长期堆在状态对象里。
3. **异步通知**：完成、失败或被终止的结果进入 command queue（命令队列）。
4. **执行器差异**：`local_bash`（本地 shell）、`local_agent`（本地 Agent）、`remote_agent`（远程 Agent）和 `in_process_teammate`（进程内队友）的启动与取消动作仍由各自模块负责。

最重要的一句话是：

> `AppState.tasks` 是后台执行器的运行时索引，不是完整输出仓库；完整输出在磁盘，通知通过 command queue 进入 Agent loop。

## 一、先分清后台执行器和共享任务清单

源码中“任务”这个词有两个常见语境。

| 对比项 | 后台执行器 | 共享任务清单 |
| --- | --- | --- |
| 管理对象 | 正在运行的进程、Agent 或异步执行器 | 一条待办事项或工作计划 |
| 典型例子 | 后台执行 `npm test` | “实现登录接口” |
| 状态含义 | `pending → running → completed/failed/killed` | 待处理、执行中、完成、阻塞 |
| 主要存储 | `AppState.tasks` 加输出文件 | 任务清单文件或任务图 |
| 结束方式 | 调用执行器的 `kill()` 或自然结束 | 更新任务条目状态 |

可以把它们理解成两个不同的问题：

```text
后台任务框架：现在有没有一个执行器正在做这件事？
共享任务清单：这件事是否仍然存在于协作计划中？
```

一个后台 Agent 可以同时拥有两种身份：

1. 它是后台框架中的 `local_agent`，代表一个正在运行的执行器；
2. 它也可以通过任务工具更新共享任务清单中的工作项。

两者可能在同一条协作流程中相遇，但后台执行器的 `taskId` 和共享任务清单的任务 ID 不是同一套身份。

## 二、框架的三层数据结构

后台任务要稳定运行，至少需要三层数据。

```text
┌──────────────────────────────┐
│ AppState.tasks               │
│ 小型运行时状态和读取游标      │
└──────────────┬───────────────┘
               │
      ┌────────┴────────┐
      ▼                 ▼
┌───────────────┐  ┌────────────────┐
│ 输出文件        │  │ command queue  │
│ 完整日志        │  │ 一次性通知     │
│ 增量读取        │  │ 主线程/子 Agent │
└───────────────┘  └────────────────┘
```

### 2.1 `AppState.tasks`：小型运行时索引

所有任务状态都会共享一组基础字段：

```ts
// src/Task.ts
export type TaskStateBase = {
  id: string
  type: TaskType
  status: TaskStatus
  description: string
  toolUseId?: string
  startTime: number
  endTime?: number
  outputFile: string
  outputOffset: number
  notified: boolean
}
```

这些字段分别解决不同问题：

- `id` 和 `type` 说明任务是谁、属于哪类执行器；
- `status` 说明任务是否仍在运行；
- `description` 和 `toolUseId` 供 UI 与通知识别任务；
- `outputFile` 指向完整输出；
- `outputOffset` 记录已经读到文件的哪个位置；
- `notified` 防止同一个终态被重复通知。

这里的 `outputOffset` 是文件读取游标，不是输出正文。

任务输出越大，越应该只在状态对象里保存这个游标，而不是保存完整字符串。

### 2.2 输出文件：保存完整事实

后台输出通常写入 session 对应的任务目录：

```text
<project-temp>/<session-id>/tasks/<task-id>.output
```

实际路径由 `getTaskOutputDir()` 和 `getTaskOutputPath()` 计算。

输出目录第一次计算时会绑定当前 session 的任务目录。这样即使用户执行 `/clear` 创建了新的会话标识，旧后台任务仍然可以继续写入原来的文件。

如果后台任务跟随新 session 改写路径，就会出现：

```text
后台进程继续写旧文件
读取方改为查找新文件
  ↓
旧任务输出读取失败，甚至出现 ENOENT（文件不存在）
```

### 2.3 command queue：保存一次性事件

完成通知不适合直接写进 `AppState.tasks`。

状态表回答“现在是什么状态”，而 command queue 负责“下一次回合应该收到什么消息”。它还需要处理优先级和 Agent 隔离。

队列优先级从高到低是：

```text
now → next → later
```

`enqueuePendingNotification()` 默认使用 `later`。普通后台任务完成不会抢占用户刚刚输入的内容。

需要尽快处理的交互提醒，例如 shell 正在等待 `(y/n)`，才会使用更高优先级。

## 三、任务模型：类型、状态和最小接口

### 3.1 `TaskType` 是运行时分类

```ts
// src/Task.ts
export type TaskType =
  | 'local_bash'            // 本地 shell 进程
  | 'local_agent'           // 本地后台 Agent
  | 'remote_agent'          // 远程 Agent 的本地轮询器
  | 'in_process_teammate'   // 当前进程内的常驻队友
  | 'local_workflow'        // 本地工作流执行器
  | 'monitor_mcp'           // MCP 资源监控订阅
  | 'dream'                 // 后台记忆整理活动
```

这些类型主要用于：

- UI 分类；
- 任务 ID 前缀；
- 取消分发；
- SDK 事件上报；
- 读取具体执行器的扩展字段。

`generateTaskId()` 会给不同类型使用不同前缀，例如本地 shell 以 `b` 开头，本地 Agent 以 `a` 开头，远程 Agent 以 `r` 开头。

### 3.2 `TaskStatus` 只有三种终态

```ts
// src/Task.ts
export type TaskStatus =
  | 'pending'    // 已注册，执行器尚未真正开始
  | 'running'    // 正在运行
  | 'completed'  // 正常结束
  | 'failed'     // 异常结束
  | 'killed'     // 被主动终止

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}
```

`completed`、`failed`、`killed` 才是不再继续变化的终态。

`idle` 不属于这套通用状态。对 `in_process_teammate` 来说，`isIdle` 只表示“暂时等待下一条消息”，队友仍然可以恢复工作。

### 3.3 `Task` 接口为什么只保留 `kill()`

```ts
// src/Task.ts
export type Task = {
  name: string
  type: TaskType
  kill(taskId: string, setAppState: SetAppState): Promise<void>
}
```

不同执行器的创建参数没有办法自然统一：

- shell 需要命令、超时和进程句柄；
- local agent 需要 prompt、Agent 定义和父级 controller；
- remote agent 需要远程 session 元数据；
- teammate 需要团队身份、邮箱和 runner 状态。

真正需要“拿着 `taskId`，运行时再决定调用哪个实现”的公共场景主要是取消：

```text
stopTask(taskId)
  ↓
读取 AppState.tasks[taskId].type
  ↓
getTaskByType(type)
  ↓
调用具体执行器的 kill()
```

因此接口只抽象取消，不强行把所有执行器的启动过程包装成一个 `spawn(options: any)`。

### 3.4 注册表有明确边界

`src/tasks.ts` 中的 `getAllTasks()` 默认注册：

- `LocalShellTask`
- `LocalAgentTask`
- `RemoteAgentTask`
- `DreamTask`

`local_workflow` 和 `monitor_mcp` 根据 feature flag（功能开关）追加。

`in_process_teammate` 虽然存在于 `TaskType`，但不在普通 `getAllTasks()` 注册表中。

这意味着：

> “类型定义中存在”不等于“普通统一取消入口已经注册了对应实现”。

文章阅读源码时要同时看 `src/Task.ts` 和 `src/tasks.ts`，不能只根据联合类型推断运行时能力。

## 四、一个后台 shell 的完整生命周期

先用后台 shell 作为标准样本，再看 Agent 和 teammate 的差异。

```text
spawnShellTask()
  ↓
生成 taskId
  ↓
初始化输出文件
  ↓
registerTask(status = pending/running)
  ↓
启动 shellCommand.background(taskId)
  ↓
持续写入输出
  ↓
completed / failed / killed
  ↓
设置 notified 并投递通知
  ↓
等待 UI 保留期后回收状态
```

### 4.1 注册：先写入运行时索引

`registerTask()` 负责把任务放入 `AppState.tasks`。

```ts
// src/utils/task/framework.ts
export function registerTask(
  task: TaskState,
  setAppState: SetAppState,
): void {
  let isReplacement = false

  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined

    // 恢复任务时保留 UI 已经持有的消息、排序时间和面板状态。
    const merged =
      existing && 'retain' in existing
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages,
          }
        : task

    return {
      ...prev,
      tasks: { ...prev.tasks, [task.id]: merged },
    }
  })

  // 重新注册通常代表 resume，不应再次上报 task_started。
  if (isReplacement) return

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: task.id,
    description: task.description,
    task_type: task.type,
  })
}
```

这里有两个容易忽略的设计：

1. 同一个 ID 重新注册时，会保留 UI 正在使用的状态，避免恢复任务时面板突然清空。
2. 新注册才发送 `task_started`，恢复任务不重复发送“刚刚启动”事件。

### 4.2 运行：执行器自己推进状态

公共框架不替执行器完成具体业务，只提供状态更新函数：

```ts
// src/utils/task/framework.ts
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) {
      return prev
    }

    const updated = updater(task)
    if (updated === task) {
      // 没有变化就复用旧对象，避免无意义的 UI 重渲染。
      return prev
    }

    return {
      ...prev,
      tasks: { ...prev.tasks, [taskId]: updated },
    }
  })
}
```

具体执行器会在关键节点更新：

- `pending → running`；
- `running → completed/failed/killed`；
- `endTime`；
- `outputOffset`；
- `notified`；
- 某类执行器自己的进度字段。

### 4.3 完成：状态、通知和回收不是同一步

任务完成后仍然不能立刻从状态表删除。

```text
任务进入终态
  ↓
原子设置 notified = true
  ↓
只由一个执行路径入队通知
  ↓
UI 继续显示一小段时间
  ↓
回收 AppState.tasks 中的状态对象
```

`notified` 的检查和设置必须发生在同一个 state updater（状态更新函数）中：

```ts
// src/tasks/LocalShellTask/LocalShellTask.tsx
let shouldEnqueue = false

updateTaskState(taskId, setAppState, task => {
  if (task.notified) {
    // 另一个完成回调已经发送过通知，当前回调直接跳过。
    return task
  }

  shouldEnqueue = true
  return {
    ...task,
    // 把“已发送”标记和检查放在同一次状态更新中，避免竞态重复通知。
    notified: true,
  }
})

if (!shouldEnqueue) {
  return
}

enqueuePendingNotification({
  value: message,
  mode: 'task-notification',
  priority: 'later',
})
```

如果先在 updater 外部读取 `notified`，两个并发完成回调都可能看到 `false`，最终把同一结果投递两次。

### 4.4 回收：终态任务需要满足多个条件

`evictTerminalTask()` 和 `applyTaskOffsetsAndEvictions()` 都会检查：

1. 任务仍然存在；
2. 状态是 `completed`、`failed` 或 `killed`；
3. `notified === true`；
4. 没有被 UI 的 `retain` 标记保留；
5. 没有处于面板宽限期（grace period）。

当前源码中的时间常量包括：

```ts
// src/utils/task/framework.ts
export const POLL_INTERVAL_MS = 1000
export const STOPPED_DISPLAY_MS = 3_000
export const PANEL_GRACE_MS = 30_000
```

如果任务刚结束就立即删除，UI（用户界面）面板可能来不及显示结果；如果永远不删，长时间运行的 CLI 会积累大量终态对象。

需要特别区分：

```text
驱逐 AppState.tasks 中的索引
≠
立即删除磁盘上的输出文件
```

输出文件是否清理，由具体执行器和消费策略决定。

## 五、输出落盘：为什么不能把全部日志留在内存

### 5.1 `DiskTaskOutput` 的职责

后台输出可能来自：

- shell 的标准输出 stdout 和标准错误 stderr；
- local agent 的 transcript（会话记录）；
- remote agent 的事件；
- hook 或 monitor 流。

`src/utils/task/diskOutput.ts` 中的 `DiskTaskOutput` 负责把这些内容写入文件，并提供按范围读取和尾部读取。

它使用字符串队列加 drain loop（排空循环）：

```ts
// src/utils/task/diskOutput.ts
class DiskTaskOutput {
  #queue: string[] = []
  #flushPromise: Promise<void> | null = null

  append(content: string): void {
    this.#queue.push(content)

    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>(resolve => {
        this.#flushResolve = resolve
      })
      // 只启动一个排空循环，后续 chunk（数据块）继续进入同一个队列。
      void this.#drain()
    }
  }
}
```

这种结构主要为了控制内存生命周期。

如果每个输出块都通过长期持有 Buffer（缓冲区）的 Promise 链串起来，写入越多，已经完成的内容越可能继续被闭包引用。

源码还特别提醒，写入队列转换为 Buffer 后要尽快交给文件句柄，不要在关键写入函数中随意增加 `await`。

### 5.2 输出上限和尾部读取

任务输出的磁盘上限是 `5GB`：

```ts
// src/utils/task/diskOutput.ts
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'
```

这个上限主要保护磁盘，不代表模型会一次读取 5GB。

模型读取完整输出时，通常优先读取尾部：

```ts
// 只读取最后 maxBytes，避免把超大日志一次性加载进内存。
export async function getTaskOutput(
  taskId: string,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  const { content, bytesTotal, bytesRead } = await tailFile(
    getTaskOutputPath(taskId),
    maxBytes,
  )

  if (bytesTotal > bytesRead) {
    return `[earlier output omitted]\n${content}`
  }

  return content
}
```

这是一种指针式上下文策略：

```text
默认给模型：短摘要 + 输出文件路径 + 尾部日志
需要更多细节：模型再按路径或范围读取
```

### 5.3 `outputOffset`：只读取新增内容

运行中的任务通过 `getTaskOutputDelta()` 从上次游标之后继续读：

```ts
// src/utils/task/diskOutput.ts
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  const result = await readFileRange(
    getTaskOutputPath(taskId),
    fromOffset,
    maxBytes,
  )

  if (!result) {
    // 文件暂时不存在时保持旧游标，下一次继续尝试。
    return { content: '', newOffset: fromOffset }
  }

  return {
    content: result.content,
    // 新游标只向前移动本次实际读取的字节数。
    newOffset: fromOffset + result.bytesRead,
  }
}
```

读取过程可以表示为：

```text
第一次：offset = 0        → 读取新增内容 → offset = 8MB
第二次：offset = 8MB      → 读取后续内容 → offset = 新位置
第三次：offset = 新位置    → 只读取再次新增的内容
```

这样不会在每个回合都重复读取整份历史日志。

### 5.4 输出文件的安全边界

初始化输出文件时，源码使用：

- `O_EXCL`：目标已存在时创建失败，避免覆盖已有文件；
- Unix 下的 `O_NOFOLLOW`：打开文件时不跟随意外的符号链接。

这是为了防止输出路径被替换成指向任意文件的链接。

但 `initTaskOutputAsSymlink()` 是另一种情况：它是框架主动创建的受控符号链接，用于让任务输出指向已有 transcript。

所以不能简单写成“系统禁止所有符号链接”：

```text
O_NOFOLLOW：防止意外跟随外部链接
initTaskOutputAsSymlink：主动创建受控链接
```

## 六、从公共框架到主循环：attachment 和通知是两条路径

这里最容易产生误读。

后台任务有两种信息流：

1. **运行中增量**：通过输出文件和 `outputOffset` 读取；
2. **终态通知**：通过 command queue 投递 `task-notification`。

### 6.1 当前主循环的接入点

当前主循环不是直接调用一个独立的 `pollTasks()`，而是通过：

```text
src/utils/attachments.ts
  getUnifiedTaskAttachments()
    ↓
  generateTaskAttachments()
    ↓
  applyTaskOffsetsAndEvictions()
```

核心结构如下：

```ts
// src/utils/attachments.ts
async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()

  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  // 文件读取跨越 await，应用补丁时必须重新读取最新 AppState。
  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  return attachments.map(taskAttachment => ({
    type: 'task_status',
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}
```

`attachment` 可以理解为“当前回合附带给模型或 UI 的运行时信息”。它不是完整任务对象，也不是磁盘输出本身。

### 6.2 `generateTaskAttachments()` 的真实边界

`src/utils/task/framework.ts` 中还提供通用的 `pollTasks()`，但阅读当前源码时要注意两点：

1. `src/utils/attachments.ts` 的 `getUnifiedTaskAttachments()` 才是当前主循环接入公共任务框架的路径；
2. `generateTaskAttachments()` 返回的是最小补丁协议，包括 `updatedTaskOffsets` 和 `evictedTaskIds`，不能拿异步读取前的旧任务对象覆盖新状态。

当前版本中，公共函数主要产出输出游标补丁和回收列表；`TaskAttachment[]` 是统一协议保留的返回形态，并不意味着每次扫描都会生成一条完整任务消息。完成通知主要由各执行器自己调用 `enqueuePendingNotification()`。不要把“统一 attachment 入口”写成“它会替所有执行器生成完整完成消息”。

### 6.3 为什么只返回最小补丁

读取输出需要跨越异步边界：

```text
读取旧 AppState
  ↓
await getTaskOutputDelta()
  ↓
任务可能已经完成、失败、被取消或重新注册
  ↓
应用 offset 和回收结果
```

如果把旧任务对象整体写回，就可能覆盖并发期间产生的新状态：

```text
读取前：running, outputOffset = 100
await 期间：completed, notified = true
错误覆盖：running, outputOffset = 200
```

这属于 TOCTOU（Time Of Check To Time Of Use，检查与使用之间状态可能变化）问题。

因此 `applyTaskOffsetsAndEvictions()` 会基于最新的 `prev.tasks` 再次确认：

- 任务是否仍然存在；
- 任务是否仍是 `running`；
- 任务是否仍处于终态；
- `notified` 是否仍为 `true`；
- UI 的 `retain` 或宽限期是否仍然阻止回收。

### 6.4 终态通知为什么由执行器负责

不同执行器的完成正文不同：

| 执行器 | 通知通常需要的内容 |
| --- | --- |
| `local_bash` | 命令描述、退出码、输出文件 |
| `local_agent` | result、usage、工具活动或 worktree（独立工作树）信息 |
| `remote_agent` | 远程 session 状态、提取后的内容 |
| `in_process_teammate` | 队友状态和当前工作进度 |
| `dream` | 记忆整理状态 |

公共框架负责状态协议、输出游标、回收和通用队列能力；具体执行器负责决定完成时机和通知正文。

## 七、command queue 如何回到模型上下文

### 7.1 入队：用 `task-notification` 标记来源

完成通知通常包含：

```xml
<task-notification>
  <task-id>b12345678</task-id>
  <output-file>D:\...\tasks\b12345678.output</output-file>
  <status>completed</status>
  <summary>Background command "npm test" completed</summary>
</task-notification>
```

执行器随后入队：

```ts
// src/utils/messageQueueManager.ts
enqueuePendingNotification({
  value: message,
  mode: 'task-notification',
  // 普通完成通知放到 later，不抢占更高优先级的用户输入。
  priority: 'later',
})
```

### 7.2 消费：主线程和子 Agent 有不同过滤规则

`src/query.ts` 会按最大优先级读取命令，并根据 Agent 身份过滤：

```ts
// src/query.ts
const queuedCommandsSnapshot = getCommandsByMaxPriority(
  sleepRan ? 'later' : 'next',
).filter(cmd => {
  if (isSlashCommand(cmd)) {
    return false
  }

  if (isMainThread) {
    // 主线程只消费没有 agentId 的命令。
    return cmd.agentId === undefined
  }

  // 子 Agent 只消费发给自己的任务通知，不能消费主线程用户输入。
  return (
    cmd.mode === 'task-notification' &&
    cmd.agentId === currentAgentId
  )
})
```

这条规则防止两个问题：

- 子 Agent 把主线程用户 prompt 误当成自己的工作；
- 主线程把其他子 Agent 的内部通知误消费。

当前版本还存在回合内 attachment 消费路径，因此不能简单写成“任务通知只会在两个回合之间处理”。准确说法是：通知先进入统一队列，再根据当前循环阶段转换成 attachment 或下一回合消息。

### 7.3 包装：让模型知道这是后台通知

`wrapCommandText()` 会添加来源前缀：

```ts
// src/utils/messages.ts
case 'task-notification':
  return `A background agent completed a task:\n${raw}`
```

它最终可能以 user message（用户消息形态）进入模型上下文，但来源仍由 `mode`、`origin` 和前缀标记。

这里的 user message 只是消息结构形态，不代表这条内容真的来自用户手工输入。

## 八、后台 bash 的 stall watchdog

后台命令最棘手的情况不是运行时间长，而是停在等待输入：

```text
Overwrite? (y/n)
```

前台终端中用户能看到提示并输入答案；后台命令如果没有检测机制，就可能一直挂着。

### 8.1 时间证据和内容证据必须同时成立

`LocalShellTask` 使用 stall watchdog（卡住检测器）定期检查：

```ts
// src/tasks/LocalShellTask/LocalShellTask.tsx
const STALL_CHECK_INTERVAL_MS = 5_000
const STALL_THRESHOLD_MS = 45_000
const STALL_TAIL_BYTES = 1024
```

它只有同时满足以下条件才通知：

1. 输出超过 45 秒没有增长；
2. 输出末尾 1KB 看起来像交互式提示。

提示模式包括：

```text
(y/n)
[y/n]
(yes/no)
Do you ...?
Press Enter
Continue?
Overwrite?
```

只静默 45 秒并不能证明命令卡住。编译、测试和大型 `git` 操作都可能长时间没有输出。

### 8.2 stall 通知不能冒充终态

stall 通知表达的是：

```text
任务还没有结束，但可能正在等待输入。
```

因此它不应携带 `completed`、`failed` 或 `killed` 这样的终态。

如果把提醒错误标成完成，SDK 或 UI 可能提前关闭任务，模型也会误以为命令已经结束。

monitor 类型 shell 更像持续流，单纯没有日志不代表它在等用户输入，因此不应只按静默时间判断卡住。

## 九、取消：统一查找，具体执行器负责物理停止

统一入口在：

```text
src/tasks/stopTask.ts
```

调用关系是：

```text
stopTask(taskId)
  ↓
读取 AppState.tasks[taskId]
  ↓
检查任务存在
  ↓
检查 status === running
  ↓
getTaskByType(task.type)
  ↓
taskImpl.kill(taskId, setAppState)
```

失败会区分：

- `not_found`：任务不存在；
- `not_running`：任务已经不是运行中；
- `unsupported_type`：注册表没有对应的 kill 实现。

统一入口只统一查找和分发，不统一物理取消：

| 类型 | 取消动作 |
| --- | --- |
| `local_bash` | 终止 shell command，清理相关资源 |
| `local_agent` | abort Agent controller |
| `remote_agent` | 更新本地状态，并 archive 远程 session |
| `in_process_teammate` | 结束队友生命周期并清理团队状态 |
| `local_workflow` | abort workflow |
| `monitor_mcp` | abort subscription |
| `dream` | abort，并回滚整理锁 |

由于 `in_process_teammate` 当前不在普通 `getAllTasks()` 注册表中，不能把上表写成“七种类型都默认可以通过普通 `stopTask()` 直接取消”。文章必须把类型定义和注册表边界一起说明。

## 十、常驻 teammate 的双 AbortController

`in_process_teammate` 不是执行一次就结束的命令，而是：

```text
等待消息
  ↓
执行一轮工作
  ↓
进入 idle（空闲等待）
  ↓
等待下一条消息
```

因此它必须区分“停止当前工作”和“结束整个队友”：

```ts
// src/tasks/InProcessTeammateTask/types.ts
abortController?: AbortController
// AbortController（中止控制器）：结束整个 teammate 生命周期。

currentWorkAbortController?: AbortController
// AbortController（中止控制器）：只中断当前工作回合，队友仍可回到 idle 等待新消息。
```

| 用户意图 | 使用的 controller | 结果 |
| --- | --- | --- |
| 不再需要这个队友 | `abortController` | 结束整个队友生命周期 |
| 先停当前这一轮 | `currentWorkAbortController` | 中断本轮工作，保留队友 |

如果只使用一个 controller，Esc 停止当前工作时就会把整个队友一起杀掉，后续消息无法继续投递。

### 10.1 `idle` 不是终态

队友能否继续接收消息，应该看 `isTerminalTaskStatus()`，而不是只看 `isIdle`。

```ts
// 只有 completed、failed、killed 才拒绝新消息。
if (isTerminalTaskStatus(task.status)) {
  return task
}

return {
  ...task,
  pendingUserMessages: [
    ...task.pendingUserMessages,
    pendingMessage,
  ],
}
```

### 10.2 UI 消息和完整 transcript 分离

队友完整会话保存在 runner（持续运行器）和 transcript（会话记录）中，`task.messages` 只是 UI 展示镜像。

```ts
// src/tasks/InProcessTeammateTask/types.ts
export const TEAMMATE_MESSAGES_UI_CAP = 50
```

UI 只保留最近 50 条消息，避免长时间运行的 teammate 把整份会话复制到 `AppState`。

## 十一、其他执行器的差异

### 11.1 `local_agent`

源码路径：

```text
src/tasks/LocalAgentTask/LocalAgentTask.tsx
```

它与 shell 的差异主要在于：

- 输出通常关联 Agent transcript；
- 需要追踪工具活动和 token 使用；
- 完成通知要携带 result、usage 或 worktree（独立工作树）信息；
- 取消依赖 Agent controller，而不是简单终止 shell 进程。

进度统计中，`input_tokens`（输入 token 计数）通常是包含历史上下文的累计值，应取最新值；`output_tokens`（输出 token 计数）更接近每回合新增量，才适合累加。

### 11.2 `remote_agent`

源码路径：

```text
src/tasks/RemoteAgentTask/RemoteAgentTask.tsx
```

本地任务并不执行远程 Agent，而是作为本地轮询器：

```text
保存远程 session 元数据
  ↓
轮询远程事件
  ↓
写入本地任务输出
  ↓
判断远程任务是否真正完成
  ↓
通知本地 Agent
```

它支持：

- `registerCompletionChecker()`：注册完成判定器；
- `registerContentExtractor()`：提取远程结果中的有效内容；
- `registerCompletionHook()`：完成后执行额外动作；
- `--resume` sidecar（旁路元数据文件）：保存可恢复的远程 session 信息；
- `archiveRemoteSession()`：取消或结束后释放远程资源。

远程 session 的 `idle` 不能只看一次。源码会结合稳定的 idle 状态和日志不再增长，避免把临时空闲误判为完成。

### 11.3 `local_workflow`、`monitor_mcp` 和 `dream`

这几类执行器复用公共任务状态和面板能力，但业务语义不同：

- `local_workflow` 负责把 workflow engine（工作流引擎）的运行状态映射到任务面板；
- `monitor_mcp` 表示 MCP 资源监控订阅，不应把短时间无日志误判为卡住；
- `dream` 表示后台记忆整理，取消时还要处理整理锁。

下一篇会详细讲工作流的脚本执行、Journal 恢复和编排逻辑，本篇只说明它如何接入后台任务框架。

## 十二、端到端示例：后台执行 `npm test`

假设模型调用 Bash：

```text
npm test
run_in_background = true
```

### 第一步：创建并注册

```text
BashTool
  ↓
spawnShellTask
  ↓
生成 bxxxxxxxx
  ↓
initTaskOutput
  ↓
registerTask
  ↓
立即返回“任务已启动”
```

当前模型回合不会等待测试结束。

### 第二步：输出写入文件

```text
shellCommand.background(taskId)
  ↓
stdout/stderr
  ↓
appendTaskOutput(taskId, chunk)
  ↓
DiskTaskOutput 写入 .output 文件
```

`AppState.tasks[taskId]` 只保存输出路径和读取游标，不保存整份测试日志。

### 第三步：读取运行中增量

主循环构造下一次上下文时：

```text
getUnifiedTaskAttachments()
  ↓
generateTaskAttachments()
  ↓
getTaskOutputDelta(taskId, outputOffset)
  ↓
applyTaskOffsetsAndEvictions()
  ↓
产生运行时 attachment 或更新读取游标
```

模型通常先看到新增摘要或输出路径，需要详细日志时再主动读取文件。

### 第四步：完成并投递通知

```text
shellCommand.result
  ↓
status = completed
  ↓
原子设置 notified = true
  ↓
enqueuePendingNotification(mode = task-notification)
  ↓
src/query.ts 根据 Agent 身份消费
  ↓
wrapCommandText
  ↓
进入模型上下文
```

### 第五步：回收运行时状态

```text
终态 + 已通知
  ↓
等待 UI retain 或 grace period
  ↓
evictTerminalTask / applyTaskOffsetsAndEvictions
  ↓
删除 AppState.tasks 中的索引
```

这一步不等于立即删除 `.output` 文件。

## 十三、源码阅读时最容易写错的判断

### 13.1 不要把 `pollTasks()` 写成唯一真实入口

`src/utils/task/framework.ts` 提供了通用的 `pollTasks()`，但当前主循环实际从 `src/utils/attachments.ts` 的 `getUnifiedTaskAttachments()` 接入。

正确的描述应该是：

```text
src/utils/task/framework.ts：提供公共轮询和状态补丁能力
src/utils/attachments.ts：当前主循环的实际接入点
```

### 13.2 不要把 attachment 和完成通知混为一谈

attachment 关注运行中输出增量、状态展示和 offset 更新。

`task-notification` 关注一次性的终态结果，由具体执行器负责构造和入队。

### 13.3 不要说 `AppState.tasks` 保存完整 transcript

它保存的是：

```text
任务状态 + 输出路径 + outputOffset + 少量 UI 镜像
```

完整内容在输出文件、Agent transcript 或 runner 内存中。

### 13.4 不要把 `idle` 当成 `completed`

常驻 teammate 的 idle 是等待，不是生命周期结束。

### 13.5 不要把统一取消理解成统一实现

统一入口只完成：

```text
taskId → task.type → 对应 kill()
```

物理终止 shell、停止 Agent、归档远程 session、关闭 teammate，仍然是不同代码路径。

## 十四、可复用的设计模式

### 14.1 小状态 + 大输出外置

状态表保留索引，文件承载完整日志。这样 UI 查询、状态更新和模型上下文都不需要携带整份输出。

### 14.2 跨 `await` 只应用最小补丁

异步读取完成后，不要把旧快照整体写回；只应用 offset 等最小变化，并在写入时重新读取最新状态。

### 14.3 `notified` 使用 check-and-set

把“是否已经通知”和“标记为已通知”放在同一次状态更新中，避免并发完成回调重复投递。

### 14.4 展示数据和事实数据分离

UI 只保留最近消息，完整 transcript 留在 runner 或磁盘中。

### 14.5 时间证据和内容证据组合

stall watchdog 先用静默时间筛选，再用输出尾部的交互提示确认，减少长任务误报。

## 总结

后台任务框架可以压缩成四条数据流：

```text
运行时状态 → AppState.tasks
完整输出   → 磁盘文件
运行中增量 → outputOffset + attachment
终态通知   → command queue + task-notification
```

完整生命周期是：

```text
注册任务
  ↓
执行器运行并持续落盘
  ↓
主循环按游标读取新增内容
  ↓
执行器在终态时投递通知
  ↓
主线程或目标子 Agent 消费通知
  ↓
状态对象在 UI 保留期后回收
```

理解这条主线后，再看 `local_bash`、`local_agent`、`remote_agent`、`in_process_teammate` 和 `local_workflow`，就能分清：

- 哪些能力属于公共任务协议；
- 哪些行为是具体执行器的实现；
- 哪些数据应该留在内存；
- 哪些内容必须落盘；
- 哪些消息可以进入模型上下文；
- 哪些任务类型虽然在类型定义中存在，但还没有进入普通统一注册表。
