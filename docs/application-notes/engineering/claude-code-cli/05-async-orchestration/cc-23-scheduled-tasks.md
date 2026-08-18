---
slug: /application-notes/engineering/claude-code-cli/cc-23-scheduled-tasks
sidebar_position: 23
title: "定时任务"
description: "沿着 scheduled task 的完整生命周期，拆解 cron 解析、跨进程锁、调度 tick、抖动、恢复和通知回注。"
---

> 本篇只讨论“什么时候触发一轮 Agent loop”。Workflow 负责一次 run 的编排，后台任务负责持续执行器，定时任务负责时间触发。

# 定时任务：把 Agent loop 接到时间轴上

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；正文使用函数名和调用关系定位，不把容易漂移的行号作为唯一依据。
>
> **核心路径**：
>
> - **任务创建**：`packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts` 的 `validateInput()`、`call()`——校验 5-field cron、限制任务数量，并根据功能开关决定是否真正使用 `durable`。
> - **cron 计算**：`src/utils/cron.ts` 的 `parseCronExpression()`、`computeNextCronRun()`——解析五列表达式，并从本地时间计算下一次命中时间。
> - **任务存储与时间策略**：`src/utils/cronTasks.ts` 的 `CronTask`、`addCronTask()`、`removeCronTasks()`、`markCronTasksFired()`、`jitteredNextCronRunMs()`、`oneShotJitteredNextCronRunMs()`、`findMissedTasks()`——分别处理任务记录、内存/文件存储、抖动、`lastFiredAt` 和错过任务。
> - **调度器核心**：`src/utils/cronScheduler.ts` 的 `createCronScheduler()`、`start()`、`enable()`、`load()`、`check()`、`getNextFireTime()`、`buildMissedTaskNotification()`——负责懒启动、文件监听、每秒 tick、任务筛选和回调。
> - **跨进程锁**：`src/utils/cronTasksLock.ts` 的 `tryAcquireSchedulerLock()`、`releaseSchedulerLock()`——通过项目级 lockfile 选出 owner session（调度锁持有进程）。
> - **session 状态**：`src/bootstrap/state.ts` 的 `sessionCronTasks`、`getSessionCronTasks()`、`setScheduledTasksEnabled()`——保存当前进程内任务，并控制 scheduler 是否启用。
> - **REPL 回流**：`src/hooks/useScheduledTasks.ts` 的 `createScheduledTaskQueuedCommand()`、`createAutonomyQueuedPromptIfNoActiveSource()`、`onFireTask` 处理——把定时 prompt 放入统一 command queue（命令队列），并路由到主 Agent 或 teammate。
> - **SDK / `-p` 回流**：`src/cli/print.ts` 的 `createCronScheduler()` 挂载和 headless queue（无交互队列）——在没有 REPL UI 时排队并调用 `run()`。
> - **Proactive 对照**：`src/proactive/index.ts`、`src/proactive/useProactive.ts`——提供固定心跳，不参与 cron 文件调度。
>
> **一次任务的调用关系**：
>
> ```text
> CronCreateTool.validateInput()
>   ↓
> CronCreateTool.call()
>   ↓
> addCronTask()
>   ├─ sessionCronTasks（durable: false）
>   └─ .claude/scheduled_tasks.json（durable: true 且功能开关允许）
>   ↓
> setScheduledTasksEnabled(true)
>   ↓
> useScheduledTasks() / src/cli/print.ts
>   ↓
> createCronScheduler().start()
>   ↓
> enable() → lock + load(true) + watcher + 1 秒 check
>   ↓
> check()
>   ├─ onFireTask(task)：普通到期任务
>   └─ onMissed(tasks) 或 onFire(notification)：启动时错过的一次性任务
>   ↓
> createAutonomyQueuedPromptIfNoActiveSource()
>   ↓
> command queue
>   ↓
> Agent loop
> ```

## 先给结论

Claude Code 的 scheduled task（定时任务）不是一个独立的 Agent，也不是一个后台执行器。

它更像一个时间触发器：

```text
CronCreate
  ↓
保存 cron + prompt
  ↓
cronScheduler 每秒检查一次
  ↓
到达 nextFireAt
  ↓
把 prompt 放进 command queue（命令队列）
  ↓
Agent loop 在合适的回合间隙消费
```

因此，定时任务解决的是：

- 用户离开后，Agent 仍能在指定时间收到一条新的输入；
- recurring task（重复任务）能够按 cron 继续调度；
- one-shot task（一次性任务）执行后自动删除；
- 多个 Claude 进程共享同一项目目录时，不会重复触发同一份磁盘任务；
- 进程重启后，durable task（持久化任务）能够恢复；
- 错过一次性提醒时，模型先询问用户，而不是直接执行旧 prompt。

定时任务不负责：

- 运行 bash、Agent 或 Workflow；
- 直接修改 transcript；
- 判断模型窗口是否快满；
- 执行上下文压缩、`snip_boundary`（截断边界标记）或 memory compact；
- 抢占正在运行的 Agent loop。

这些动作由后续的 command queue、Agent loop 和 context assembly（上下文装配）负责。定时任务只负责把“下一条要处理的 prompt”交出去。

## 一、三种时间驱动方式

先把几个相似概念分开。

### 1.1 cron：外部时间表触发固定 prompt

cron 的任务内容在创建时写入 `prompt`：

```text
“每 30 分钟检查一次 CI”
  ↓
cron: */30 * * * *
prompt: 检查 CI 状态，如果失败就告诉我
```

到时间后，调度器把这段 prompt 重新送入 Agent loop。

cron 关心的是：

```text
时间到了吗？
```

### 1.2 `/loop`：Agent 自己安排下一次唤醒

`/loop` 更接近“本轮结束后，再等待一段时间继续同一类工作”。它的下一次延迟来自当前 Agent run，而不是一个长期保存在 `scheduled_tasks.json` 中的固定 cron 任务。

所以 `/loop` 的核心问题是“这一轮之后什么时候继续”，而 cron 的核心问题是“某个日历时间是否到了”。

### 1.3 Proactive：固定心跳，模型自己决定做什么

Proactive 模式在 `src/proactive/useProactive.ts` 中使用固定 30 秒 tick（心跳）保持模型处于自治状态。

```text
cron       → 外部时间表决定何时触发，prompt 预先固定
/loop      → Agent 为下一轮安排 delay
Proactive  → 系统提供 tick，模型用 Sleep 自己安排节奏
```

Proactive 发出的内容更像：

```xml
<tick>09:30:00</tick>
```

它不是“检查 CI”或“提醒开会”这样的具体任务。

本文主线是 cron。Proactive 只在最后一节做边界对照，避免把两套机制混成一个调度器。

## 二、任务创建：CronCreate 先做什么

任务创建入口是：

```text
packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts
```

它接收四个关键字段：

| 字段 | 含义 |
| --- | --- |
| `cron` | 5-field cron 表达式，使用进程本地时区 |
| `prompt` | 到时间后送入 Agent loop 的文本 |
| `recurring` | 是否重复执行，默认是 `true` |
| `durable` | 是否跨进程持久化，默认是 `false` |

`validateInput()` 不只是检查字符串格式，还会做几道运行时校验：

1. `cron` 必须存在；
2. 必须能被 `parseCronExpression()` 解析；
3. 未来 366 天内必须至少能计算出一次匹配时间；
4. 当前任务数量不能达到 50 个；
5. teammate（队友 Agent）不能创建 durable cron，因为队友不会跨 session 持久化；
6. feature gate（功能开关）关闭时，`durable` 会在真正写入前降级成 session-only。

创建成功后，`call()` 会调用 `addCronTask()`，再调用 `setScheduledTasksEnabled(true)`。

这里有一个容易忽略的点：

> `setScheduledTasksEnabled(true)` 只是启动调度器的 session flag，不等于任务已经持久化。

任务是否落盘，由 `durable` 决定。

`CronCreateTool.call()` 的关键逻辑可以压缩成下面这样：

```typescript
// packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts
async call({ cron, prompt, recurring = true, durable = false }) {
  // 功能开关关闭时，保持输入协议不变，但强制降级为当前 session 的任务。
  const effectiveDurable = durable && isDurableCronEnabled()

  const id = await addCronTask(
    cron,
    prompt,
    recurring,
    effectiveDurable,
    getTeammateContext()?.agentId,
  )

  // 这一步只打开当前进程的调度入口，不代表一定写入磁盘。
  setScheduledTasksEnabled(true)
  return { id, durable: effectiveDurable }
}
```

所以，`durable: true` 也不是无条件落盘。它必须同时满足两个条件：

```text
用户请求 durable
  +
durable cron 的功能开关当前允许
  ↓
写入 .claude/scheduled_tasks.json
```

如果功能开关在 session 中途关闭，已经存在的 scheduler 还会在下一次 tick 通过 `isKilled()` 停止触发；新创建的任务则被降级为 session-only。

### 2.1 两种存储边界

#### session-only task：只活在当前进程

当 `durable: false` 时，任务写入 `bootstrap/state.ts` 中的 `sessionCronTasks`：

```typescript
// src/utils/cronTasks.ts
export async function addCronTask(
  cron: string,
  prompt: string,
  recurring: boolean,
  durable: boolean,
  agentId?: string,
): Promise<string> {
  const id = randomUUID().slice(0, 8)
  const task = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
  }

  if (!durable) {
    // 只放进当前进程的 bootstrap state，不写磁盘。
    addSessionCronTask({ ...task, ...(agentId ? { agentId } : {}) })
    return id
  }

  // durable task 才会进入 .claude/scheduled_tasks.json。
  const tasks = await readCronTasks()
  tasks.push(task)
  await writeCronTasks(tasks)
  return id
}
```

session-only task 的特点：

- 当前 session 内可以正常触发；
- 不产生 `scheduled_tasks.json` 文件变更；
- scheduler 每个 tick 直接从内存读取；
- 进程退出后任务消失；
- teammate 的 cron 必须属于这一类。

#### durable task：写入项目目录

当 `durable: true` 且 feature gate 允许时，任务写入：

```text
<project-root>/.claude/scheduled_tasks.json
```

磁盘中的任务主要包含：

```json
{
  "tasks": [
    {
      "id": "a1b2c3d4",
      "cron": "*/30 * * * *",
      "prompt": "检查 CI 状态，如果失败就告诉我",
      "createdAt": 1785753000000,
      "recurring": true
    }
  ]
}
```

`durable` 本身不会写进文件。`writeCronTasks()` 会主动剔除运行时字段，因为“文件中的任务”天然就是 durable task。

除此之外，`CronTask` 还可能拥有：

- `lastFiredAt`：最近一次触发时间，用于重启后恢复调度锚点；
- `permanent`：系统内部任务可以绕过 recurring TTL；
- `agentId`：session-only teammate task 的归属，运行时字段，不写磁盘。

## 三、5-field cron 如何解析

源码路径：

```text
src/utils/cron.ts
```

支持的字段顺序是：

```text
minute hour day-of-month month day-of-week
分钟   小时  月内日期       月份  星期
```

支持：

- `*`：任意值；
- `N`：单个数值；
- `*/N`：按步长递增；
- `N-M`：范围；
- `N-M/S`：范围加步长；
- `N,M,...`：列表。

不支持：

- `L`：月末等扩展语义；
- `W`：工作日修正；
- `?`：Quartz 风格的“不指定”；
- 月份或星期名称别名。

例如：

```text
*/5 * * * *     每 5 分钟
30 9 * * 1-5    工作日 09:30
0 0 1 * *       每月 1 日 00:00
```

解析过程会把每一列展开成有序数组：

```typescript
// src/utils/cron.ts
export function parseCronExpression(expr: string): CronFields | null {
  if (typeof expr !== 'string') return null

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    // 每个字段按照自身的合法范围展开。
    // 例如 minute 是 0-59，hour 是 0-23。
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}
```

### 3.1 星期日的 `0` 和 `7`

星期字段内部范围是 `0-6`，其中 `0` 代表 Sunday。

为了兼容常见 cron 写法，输入中的 `7` 也会被转换成 `0`。范围表达式也支持这一别名，例如 `5-7` 会转换成 Friday、Saturday、Sunday。

### 3.2 月内日期与星期的 OR 语义

当 `day-of-month` 和 `day-of-week` 都是通配符时，日期条件直接通过。

当只有一列被限制时，使用被限制的那一列。

当两列都被限制时，当前实现使用 OR：

```text
dayOfMonth 命中
或者
dayOfWeek 命中
```

这与很多标准 cron 实现的行为一致，但容易和“两个条件都必须满足”的直觉混淆。

### 3.3 本地时区和 DST

`computeNextCronRun()` 使用 `Date` 的本地时间 API：

- `0 9 * * *` 表示进程本地时间的 09:00；
- 不同机器的时区不同，同一表达式的实际触发时间可能不同；
- 春季夏令时跳过的小时不会凭空产生；
- 秋季重复小时不会因为重复出现而触发两次。

计算从 `from` 之后的下一个整分钟开始，最多向前搜索 366 天。

```typescript
// src/utils/cron.ts
const t = new Date(from.getTime())

// cron 的精度是分钟，严格从下一分钟开始搜索。
t.setSeconds(0, 0)
t.setMinutes(t.getMinutes() + 1)

const maxIter = 366 * 24 * 60
for (let i = 0; i < maxIter; i++) {
  // 先判断月份、日期、小时，再判断分钟。
  // 命中后返回本地时间 Date。
}
```

因此，CronCreate 并不是“只要语法看起来像 cron 就接受”。它还要求未来一年内能找到实际匹配日期。

## 四、scheduler 如何启动

调度器核心在：

```text
src/utils/cronScheduler.ts
```

它是一个非 React 工厂函数：

```text
createCronScheduler(options)
  ├─ start()
  ├─ stop()
  └─ getNextFireTime()
```

REPL、SDK 和 `-p` 模式共用这套核心逻辑，只是挂载方式不同。

### 4.1 懒启动

REPL 启动时，`useScheduledTasks()` 可以先挂载 scheduler，但不一定立即开启文件监听和 check timer。

`start()` 会先检查：

- `getScheduledTasksEnabled()` 是否已经打开；
- `.claude/scheduled_tasks.json` 是否已经有任务；
- 是否是 assistant mode；
- 是否是带显式 `dir` 的 daemon 调用。

没有任务时，scheduler 只轮询启用 flag。

当 `CronCreateTool` 创建任务后，它会设置：

```typescript
setScheduledTasksEnabled(true)
```

随后 scheduler 才进入真正的 `enable()` 流程。

### 4.2 enable 阶段做三件事

`enable()` 主要完成：

1. 获取项目级 scheduler lock；
2. 加载 durable task；
3. 建立文件 watcher 和 1 秒 check timer。

文件 watcher 使用 `chokidar`，并设置 300ms 的稳定等待，避免一次 JSON 写入触发多次半成品读取。

```text
scheduled_tasks.json change
  ↓ 等待文件稳定 300ms
load(false)
  ↓
刷新磁盘任务列表
```

注意，session-only task 不依赖 watcher。因为它从未写入文件，scheduler 每个 tick 都会从 `getSessionCronTasks()` 重新读取。

### 4.3 timer 使用 `unref()`

check timer 每秒运行，但会调用 `unref()`：

```typescript
// src/utils/cronScheduler.ts
checkTimer = setInterval(check, CHECK_INTERVAL_MS)

// 定时任务不能单独把 -p 进程“吊住”。
checkTimer.unref?.()
```

这意味着：

> scheduled task 可以在进程已经有其他工作时继续调度，但不能仅凭自己阻止 Node.js 进程退出。

这是定时任务与 daemon 常驻进程的一个重要边界。需要长期驻留时，应由 daemon 或其他生命周期管理器负责保活。

## 五、跨进程锁：谁拥有调度权

持久化任务可能被同一项目目录下的多个 Claude session 同时看到：

```text
IDE 中的 Claude
终端中的 Claude
另一个 SDK daemon
        ↓
同一个 .claude/scheduled_tasks.json
```

如果每个进程都执行 `check()`，同一个任务可能被触发多次。

因此，调度器使用：

```text
<project-root>/.claude/scheduled_tasks.lock
```

锁文件记录：

```json
{
  "sessionId": "session-or-daemon-id",
  "pid": 12345,
  "acquiredAt": 1785753000000
}
```

### 5.1 原子创建

核心操作是 `writeFile(..., { flag: 'wx' })`：

```typescript
// src/utils/cronTasksLock.ts
await writeFile(path, body, { flag: 'wx' })
```

`wx` 表示“文件不存在时才创建”。多个进程同时抢锁时，操作系统保证只有一个创建成功。

### 5.2 owner 和 passive session

成功创建 lockfile 的进程成为 owner session：

```text
owner session
  → 负责 durable task 的 check 和 fire

其他 session
  → 不触发 durable task
  → 每 5 秒重新探测锁
```

锁中的 `pid` 用来判断 owner 是否还活着。

- 锁属于当前 session：可以幂等重获；
- 锁属于其他且 PID 存活：当前进程等待；
- PID 已退出或锁内容损坏：认为 stale lock（过期锁）；
- 删除 stale lock 后重新使用 `wx` 抢占；
- 多个进程同时恢复 stale lock 时，仍然只有一个能成功。

退出时，cleanup registry 会调用 `releaseSchedulerLock()` 删除自己持有的锁。

### 5.3 session-only task 为什么不需要这把锁

session-only task 只存在当前进程的内存中，其他进程看不到，因此不可能因为共享文件而重复执行。

调度器的边界是：

```text
durable task     → 必须经过 owner lock
session-only task → 当前进程直接处理
```

这也是为什么 `check()` 会分成两个循环，而不是把两类任务强行合并成同一种存储。

## 六、每秒 check：从任务到 nextFireAt

`check()` 是 scheduler 的核心。每次 tick 大致按以下顺序执行：

```text
检查 killswitch
  ↓
检查 isLoading
  ↓
读取本 tick 的 jitter 配置
  ↓
遍历 owner 的 durable task
  ↓
遍历当前进程的 session-only task
  ↓
计算或读取 nextFireAt
  ↓
到期则 onFireTask / onFire
  ↓
重排 recurring 或删除 one-shot
```

### 6.1 killswitch 先于一切副作用

REPL 传入：

```typescript
isKilled: () => !isKairosCronEnabled()
```

当 feature gate 在运行中关闭时，下一次 tick 直接返回：

```typescript
if (isKilled?.()) return
```

这不仅阻止新任务创建，也能让已经运行的 scheduler 停止触发。

### 6.2 loading 守卫

普通 REPL 会传入当前 Agent 是否正在执行 query 的函数：

```typescript
isLoading: () => isLoadingRef.current
```

`useScheduledTasks()` 特意使用 `useRef` 保存最新值：

```typescript
// src/hooks/useScheduledTasks.ts
const isLoadingRef = useRef(isLoading)
isLoadingRef.current = isLoading

// scheduler 创建时捕获的是 getter，而不是某一轮旧的 isLoading。
isLoading: () => isLoadingRef.current
```

调度器每个 tick 先判断：

```typescript
if (isLoading() && !assistantMode) return
```

含义是：

- Agent 正在流式生成或执行当前 query 时，普通 scheduled task 暂不触发；
- 当前 tick 不会排队积压；
- 下一次 tick 会重新判断；
- assistant mode 可以绕过这个守卫，但当前实现中它更多是降低延迟，而不是允许无限抢占。

这里不要把 `isLoading` 守卫误解成模型窗口检测。

它只回答：

```text
当前这一轮 Agent loop 是否正在运行？
```

它不回答：

```text
上下文还有多少 token？
是否需要 compact？
是否存在 snip_boundary？
模型窗口是否已经接近上限？
```

这些判断发生在 prompt 进入 Agent loop 后的上下文治理路径中。

### 6.3 普通触发为什么优先传完整 `CronTask`

`createCronScheduler()` 同时提供 `onFire` 和 `onFireTask` 两个回调。

- `onFireTask(task)`：普通到期任务的优先入口，回调拿到完整任务对象，可以读取 `id`、`agentId`、`recurring` 等字段；
- `onFire(prompt)`：兼容旧的“只传 prompt”入口，也用于没有单独 `onMissed` 回调时承接格式化后的 missed notification；
- `onMissed(tasks)`：可选的启动恢复入口，SDK 或 daemon 可以自己决定如何展示错过的一次性任务。

REPL 的挂载代码体现了这个分工：

```typescript
// src/hooks/useScheduledTasks.ts
const scheduler = createCronScheduler({
  // missed task 没有单独处理器时，scheduler 会走 onFire(prompt)。
  onFire: prompt => {
    void enqueueForLead(prompt)
  },

  // 普通触发使用完整 task，才能根据 agentId 路由给 teammate。
  onFireTask: task => {
    void (async () => {
      const command = await createScheduledTaskQueuedCommand(task, {
        shouldCreate: () => !disposed,
      })
      if (command && !disposed) {
        // 不直接打断当前 query，交给统一命令队列在合适的回合消费。
        enqueuePendingNotification(command)
      }
    })()
  },

  // getter 读取最新的 loading 状态，避免捕获旧闭包。
  isLoading: () => isLoadingRef.current,
})
```

`createScheduledTaskQueuedCommand()` 内部会调用
`createAutonomyQueuedPromptIfNoActiveSource()`，用 `task.id` 做来源去重；
然后由 `enqueuePendingNotification()` 放入命令队列。
调度器本身仍然不直接调用模型。

### 6.4 nextFireAt 是内存中的调度索引

调度器用 `Map<string, number>` 保存每个任务的下一次触发时间：

```text
task id → nextFireAt epoch ms
```

第一次看到任务时：

- recurring task 从 `lastFiredAt ?? createdAt` 开始计算；
- one-shot task 从 `createdAt` 开始计算；
- 计算结果写入 `nextFireAt`；
- 后续 tick 只做时间比较。

这个锚点很重要。

如果一个 recurring task 已经触发过，进程重启后应从 `lastFiredAt` 继续，而不是重新从很久以前的 `createdAt` 计算。否则固定日期类 cron 可能因为“从旧时间重新找下一次”而出现重复或错过。

## 七、抖动：为什么 recurring 向后，one-shot 向前

源码中的抖动配置来自：

```text
src/utils/cronJitterConfig.ts
```

调度器通过 `getCronJitterConfig()` 在每个 tick 读取配置，REPL 可以使用 GrowthBook（远程配置系统）动态调整，不需要重新发布客户端。

默认值在 `src/utils/cronTasks.ts` 中：

```text
recurringFrac     = 0.1
recurringCapMs   = 15 分钟
oneShotMaxMs     = 90 秒
oneShotFloorMs   = 0
oneShotMinuteMod = 30
recurringMaxAgeMs = 7 天
```

task id 前 8 位十六进制字符会被转换成稳定比例：

```typescript
// src/utils/cronTasks.ts
function jitterFrac(taskId: string): number {
  // 同一个任务跨重启保持相同的抖动比例。
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}
```

这不是每次都重新随机，而是“按 task id 稳定分配”。

### 7.1 recurring task：在 cron 时间之后延迟

重复任务更在乎“周期持续稳定”，而不是每次都卡在整点。

```typescript
// src/utils/cronTasks.ts
const t1 = nextCronRunMs(cron, fromMs)
const t2 = nextCronRunMs(cron, t1)

const jitter = Math.min(
  jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
  cfg.recurringCapMs,
)

// recurring 只向后延迟，不改变 cron 的下一次周期锚点。
return t1 + jitter
```

默认配置下：

- 每小时任务最多在下一个整点后延迟 15 分钟；
- 实际延迟约为间隔的 10% 以内；
- 每分钟任务的延迟会更短；
- 每个任务的偏移稳定，便于观察和复现。

触发后，recurring task 从当前 `now` 重新计算，而不是从旧的 `nextFireAt` 继续快速追赶：

```text
当前被阻塞了 20 分钟
  ↓
恢复后只安排下一次未来 cron
  ↓
不把过去错过的每一个周期全部补跑
```

### 7.2 one-shot task：热点分钟可以提前

一次性提醒的用户契约不同：

```text
“3 点提醒我”
```

3:01 再提醒通常已经晚了；3:00 前几十秒提醒，用户通常可以接受。

因此 one-shot 的抖动方向相反：

- 只对本地 `:00`、`:30` 等热点分钟启用；
- 默认最多提前 90 秒；
- 不向后延迟；
- 使用 `Math.max(..., fromMs)`，避免任务创建在自己的提前窗口内时立即触发。

```typescript
// src/utils/cronTasks.ts
if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) {
  // 非热点分钟不抖动。
  return t1
}

const lead =
  cfg.oneShotFloorMs +
  jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)

// one-shot 只提前；fromMs 是创建时间下限。
return Math.max(t1 - lead, fromMs)
```

这两种方向不是实现上的对称偏好，而是用户契约不同：

| 类型 | 调度策略 | 原因 |
| --- | --- | --- |
| recurring | 下一次 cron 之后向后延迟 | 稍晚不会破坏周期任务 |
| one-shot | 热点分钟之前向前提前 | 稍晚可能已经错过提醒时机 |

## 八、recurring TTL：为什么不是永久运行

默认 recurring task 的自动过期时间是 7 天。

调度器每次触发时会检查：

```text
recurring
且不是 permanent
且 now - createdAt >= recurringMaxAgeMs
```

如果已过期，任务仍然会完成当前这一次 fire，然后被删除。

```text
达到过期时间
  ↓
最后一次触发
  ↓
不再 reschedule
  ↓
从内存或 scheduled_tasks.json 删除
```

这样做是为了防止“临时任务”被用户遗忘后持续消耗 token：

```text
“这周每小时检查我的 PR”
```

如果没有 TTL，这类任务可能几个月都在运行，持续唤醒长上下文 session。

`permanent: true` 是系统内部任务的逃生通道，主要用于 assistant mode 的内置任务。它不是 CronCreateTool 暴露给普通用户的常规选项。

需要特别区分：

- `durable` 控制任务是否跨进程保存；
- `recurring` 控制是否重复执行；
- `permanent` 控制 recurring 是否绕过 TTL。

它们不是同一个维度。

## 九、触发：prompt 如何回到 Agent loop

调度器本身只负责回调：

```typescript
onFire(prompt)
// 或
onFireTask(task)
```

它不直接调用模型。

### 9.1 REPL 路径

REPL 的挂载文件是：

```text
src/hooks/useScheduledTasks.ts
```

正常触发时，它会：

1. 使用 `createScheduledTaskQueuedCommand()` 创建 autonomy command；
2. 标记 `trigger: 'scheduled-task'`；
3. 使用 `WORKLOAD_CRON`；
4. 通过 `enqueuePendingNotification()` 放入命令队列；
5. 由 REPL 在回合之间消费。

核心关系可以简化成：

```typescript
// src/hooks/useScheduledTasks.ts
const command = await createAutonomyQueuedPromptIfNoActiveSource({
  basePrompt: task.prompt,
  trigger: 'scheduled-task',
  sourceId: task.id,
  sourceLabel: task.prompt,
  workload: WORKLOAD_CRON,
})

if (command) {
  // 不是直接打断当前 query，而是进入统一队列。
  enqueuePendingNotification(command)
}
```

`createAutonomyQueuedPromptIfNoActiveSource()` 还会做去重：如果同一个来源的 run 已经排队或正在运行，就跳过本次创建。

因此，scheduler 的 `inFlight` 和 autonomy command 的去重是两层不同防线：

```text
inFlight
  防止同一个 task 在异步删除 / 写回期间被 scheduler 重复触发

active source 去重
  防止同一个 scheduled task 已经进入 Agent 队列后再次创建 run
```

### 9.2 普通任务与 teammate task

如果任务带有 `agentId`，REPL 会把它投递给对应 teammate：

```text
scheduled task
  ↓
根据 agentId 找 teammate
  ↓
注入 teammate mailbox
```

如果 teammate 已经退出：

- one-shot task 会在 fire 后删除；
- recurring task 会被删除，避免继续向不存在的队友发送消息。

这也是 teammate cron 必须 session-only 的原因之一：队友生命周期短，跨 session 保存只会产生孤儿任务。

### 9.3 SDK / `-p` 路径

`src/cli/print.ts` 也挂载同一个 `createCronScheduler()`。

headless 模式没有 REPL 的 React command queue，因此它会把命令加入自己的队列，再调用 `run()`。

但 scheduler 核心仍然只做：

```text
计算时间
  ↓
回调任务
```

执行环境负责：

```text
创建 autonomy command
  ↓
进入 headless queue
  ↓
run() 消费
```

## 十、missed task：错过一次性提醒时怎么办

任务可能在 Claude 未运行时到期。

例如：

```text
用户在 14:00 创建：
“15:00 提醒我检查构建”

Claude 在 14:50 退出
用户在 15:20 重新打开
```

启动时，scheduler 的 `load(true)` 会调用 `findMissedTasks()`，按照 `createdAt` 计算下一次 cron。如果下一次时间已经早于当前时间，任务就被视为 missed。

### 10.1 只在初始加载时呈现

missed task 只在 scheduler 初始加载时处理：

- 初次启动：允许生成 missed notification（错过任务通知）；
- 文件 watcher 后续 reload：不重复生成；
- session 内因为阻塞而变成 overdue：交给正常 `check()`，不包装成“Claude 关闭期间错过”。

当前 scheduler 只把 missed one-shot 交给用户确认。这里的“启动时”很重要：
它指 `load(true)` 的初始加载，而不是每次文件变化都重新判断。

recurring task 即使错过了前一个周期，也会由正常 `check()` 重新从当前时间向后安排，不会把每个历史周期全部补跑。

### 10.2 先询问，再执行

missed one-shot 会先从 `scheduled_tasks.json` 删除，再构造通知文本。

如果调用方传入了 `onMissed(tasks)`，scheduler 会把原始任务交给调用方；
如果没有传入，scheduler 才会调用 `buildMissedTaskNotification()` 生成通知，并通过 `onFire(prompt)` 回流。
这就是为什么源码定位中要把 `onMissed` 和普通的 `onFireTask` 分开写。

通知明确要求模型：

```text
不要直接执行 prompt。
先使用 AskUserQuestion 询问用户是否现在运行。
只有用户确认后才执行。
```

原始 prompt 会放进代码围栏，避免 prompt 中的反引号或多行指令破坏通知结构。

这条路径的语义是：

```text
missed task
  ≠ 自动补跑
  = 把“是否补救”交给用户
```

删除发生在通知之前，所以用户即使选择不执行，也不会在下一次 reload 时反复收到同一条提醒。

## 十一、删除、取消与重复触发防护

### 11.1 CronDelete

`packages/builtin-tools/src/tools/ScheduleCronTool/CronDeleteTool.ts` 会先验证任务存在，再调用 `removeCronTasks()`。

`removeCronTasks()` 同时兼容两种存储：

```text
先尝试删除 sessionCronTasks
  ↓
如果没有命中，再读取 scheduled_tasks.json
  ↓
过滤掉指定 id
  ↓
写回文件
```

删除最后一个 durable task 时，文件不会直接消失，而是写入空任务列表。这样 watcher 仍然能收到文件变更。

### 11.2 one-shot 触发后的删除

one-shot task fire 后：

- session-only：从内存同步删除；
- durable：异步删除磁盘记录；
- 异步删除完成前，`inFlight` 阻止下一秒重复 fire。

recurring task 则写回 `lastFiredAt`：

```text
本次 fire
  ↓
内存中计算新的 nextFireAt
  ↓
批量写回 lastFiredAt
  ↓
下次重启从相同锚点恢复
```

多个 recurring task 在同一个 tick 触发时，会批量执行一次 `markCronTasksFired()`，避免每个任务各自读写一次 JSON。

### 11.3 任务过滤

`createCronScheduler()` 支持 `filter`。

daemon 可以只处理满足条件的任务，例如只处理 `permanent` task，让普通 durable task 留给其他 session。

被过滤的任务对当前 scheduler 完全不可见：

- 不触发；
- 不删除；
- 不写 `lastFiredAt`；
- 不作为 missed task 呈现；
- 不出现在 `getNextFireTime()`。

## 十二、一条任务完整走一遍

以“每 30 分钟检查 CI”为例：

### 第一步：创建

模型调用：

```text
CronCreate(
  cron="*/30 * * * *",
  prompt="检查 CI 状态，如果失败就告诉我",
  recurring=true,
  durable=true
)
```

`CronCreateTool.validateInput()` 校验表达式、未来匹配时间、任务数量和 durable 限制。

### 第二步：落盘

`addCronTask()` 写入：

```text
.claude/scheduled_tasks.json
```

并通过 `setScheduledTasksEnabled(true)` 让当前 session 开启 scheduler。

### 第三步：获得 owner

scheduler 创建：

```text
.claude/scheduled_tasks.lock
```

当前进程成为 owner，其他进程只等待。

### 第四步：计算下一次时间

`check()` 第一次看到任务：

```text
nextCronRunMs("*/30 * * * *", createdAt)
  ↓
得到下一个 :00 或 :30
  ↓
jitteredNextCronRunMs()
  ↓
为这个 task 加一个稳定的向后偏移
```

### 第五步：等待并触发

每秒 tick 判断：

```text
now >= nextFireAt ?
```

如果 Agent 当前正在 query，普通 REPL 会跳过本 tick。

### 第六步：进入队列

到期后，scheduler 调用 `onFireTask(task)`。

`useScheduledTasks()` 创建 autonomy command，并把 prompt 放进 command queue。

### 第七步：重新安排

因为是 recurring task：

- 从当前 `now` 计算下一次 cron；
- 再加稳定 jitter；
- 写回 `lastFiredAt`；
- 继续等待下一次。

### 第八步：TTL 到期

创建时间超过 7 天后，下一次触发仍可执行一次；执行完成后不再 reschedule，任务被删除。

整个链路中，scheduler 没有直接参与模型窗口计算，也没有直接做 context compact。它只负责保证 prompt 在正确的生命周期节点进入 Agent loop。

## 十三、设计取舍与边界

### 13.1 为什么不是每个进程都调度

文件锁让 scheduled task 保持“项目目录级共享、单进程级执行”：

- 任务文件可以被多个 session 读取；
- 实际触发只有一个 owner；
- owner 崩溃后其他进程可以接管。

代价是 stale lock 接管不是瞬时完成，非 owner 默认每 5 秒探测一次。

### 13.2 为什么跳过，不把历史任务排队

如果 Agent 忙了几个小时，期间每分钟一个 cron，系统可以积累数百条待执行消息。

这会造成：

- 用户回来后突然执行大量旧 prompt；
- command queue 长时间排空；
- 上下文持续增长；
- token 成本快速上升。

当前 recurring 的策略是从 `now` 重新安排下一次，不补跑历史周期。one-shot 则通过 missed task 交给用户决定。

### 13.3 为什么 scheduler 不自己判断模型窗口

调度器与 Agent loop 是不同层：

```text
scheduler
  只知道 cron、任务状态、isLoading、owner lock

Agent loop / context assembly
  才知道消息历史、token 预算、模型窗口、compact 和 snip_boundary
```

如果 scheduler 直接依赖 token 计数、模型 provider 或 compact 状态，REPL、SDK、daemon 就会出现不同的调度逻辑。

当前实现选择：

```text
调度器只保证“何时把 prompt 放入队列”
上下文层决定“这条 prompt 何时能安全进入模型”
```

### 13.4 5-field 子集的限制

5-field cron 足够覆盖常见的分钟、小时、日期和星期调度，但它不表达：

- 月末；
- 工作日修正；
- 复杂时区；
- 秒级触发；
- Quartz 风格的特殊字段。

这些限制换来了更简单的解析、可测试的边界和更低的运行时复杂度。

## 十四、与 Proactive 的边界

Proactive 的源码在：

```text
src/proactive/index.ts
src/proactive/useProactive.ts
```

它的状态机是：

```text
inactive → active → paused → active → inactive
```

核心判断：

```typescript
// src/proactive/index.ts
export function shouldTick(): boolean {
  return active && !paused && !contextBlocked
}
```

Proactive 每 30 秒安排一个 tick，但实际 tick 还会检查：

- 当前是否正在加载；
- 是否处于 plan mode；
- 是否存在本地 JSX UI；
- 是否已有排队命令；
- 上一个 tick 是否仍在异步生成。

它生成后始终进入队列：

```typescript
// src/proactive/useProactive.ts
// prompt 是异步构造的，所以生成完成后必须排队，
// 避免与用户输入同时提交时丢失 autonomy turn。
optsRef.current.onQueueTick(command)
```

与 cron 对比：

| 维度 | cron | Proactive |
| --- | --- | --- |
| 触发来源 | 5-field cron 日历时间 | 固定 tick |
| 触发内容 | 创建时固定的任务 prompt | `<tick>时间</tick>` |
| 任务决定者 | 用户/模型创建任务时决定 | 模型根据提示词自己决定 |
| 失败保护 | killswitch、TTL、missed task | `contextBlocked` 熔断 |
| 存储 | session-only 或 durable JSON | 主要是 session 状态 |
| 适用场景 | 定时提醒、定时检查、固定动作 | 持续自治、主动观察环境 |

`contextBlocked` 也说明了一个边界：Proactive 需要防止“tick → API error → tick”的持续失败循环；cron 则更多依靠 `isLoading`、TTL、任务删除和 killswitch 控制成本。

## 总结

Claude Code 的 scheduled task 可以概括为八个动作：

```text
CronCreate
  → parseCronExpression
  → session / durable storage
  → scheduler lock
  → 1 秒 check
  → nextFireAt + jitter
  → command queue
  → reschedule / delete / expire
```

最重要的边界有四个：

1. `durable` 决定是否跨进程保存，`recurring` 决定是否重复，`permanent` 决定是否绕过 TTL；
2. durable task 由 owner session 调度，session-only task 只在当前进程处理；
3. recurring 不追赶历史周期，one-shot 错过后先询问用户；
4. scheduler 不执行上下文压缩，也不直接判断模型窗口；它只把 prompt 放入 Agent loop 的队列。

如果把 Agent loop 看成“按回合处理输入”，那么定时任务就是外部时钟提供的一种输入来源。它没有改变 Agent loop 的推理方式，只是让“下一条消息从哪里来”不再只依赖用户手动输入。
