# 定时任务与自动化调度

> **本章目标**：理解 Claude Code 的定时任务系统——Agent 如何从"被动响应"升级为"时间驱动"，调度器如何把 cron 触发注入到 Agent 循环的空闲时刻，以及它如何解决惊群效应、跨会话去重、任务防失控等工程难题。
>
> **读完本章你应该能回答**：
> - 定时任务的本质是什么？它如何与 Agent Loop 协同？
> - Cron 表达式如何解析？5-field cron 与 vixie-cron 有何差异？
> - Recurring 任务和 one-shot 任务的抖动算法为何方向相反？
> - 调度器如何在多进程会话间避免重复触发？跨进程锁如何实现？
> - 任务为什么只在 Agent 空闲时触发？这与 token 经济性有什么关系？
> - 7 天 TTL 如何防止被遗忘的任务无限烧 token？
> - `/loop` 命令与 CronCreate 是什么关系？动态间隔模式如何工作？

**配套阅读标注**：

- 文章按"问题 → 位置 → 宏观样貌 → 运行时细节"四级展开。前两级短小，建立坐标；第三级给端到端全景图再逐侧面展开，适合建立心智模型；第四级沿"一次任务从创建到销毁"的生命周期深入，每个机制遵循"为什么需要 → 怎么做 → 具体实例"。
- 标注 **核心章节** 的部分是理解设计哲学的关键；标注 **选读** 的可跳过。
- 所有 `file:line` 均为源码引用，可点击定位。

**文章结构**：

| 章节 | 层级 | 内容 | 阅读建议 |
|------|------|------|---------|
| 一 | 解决什么问题 | 定时任务要解决的核心工程问题 | 必读，建立问题意识 |
| 二 | 架构位置 | 调度器在整体架构中的位置、调用栈全貌 | 必读，建立全局坐标 |
| 三 | 宏观样貌 | 端到端全景图 + 核心抽象 + 版图分类 + 注册机制 + 对外接口 | 必读，建立心智模型 |
| 四 | 运行时细节 | 沿任务生命周期深入：创建→调度→时间→抖动→触发→过期→退出 | **核心章节**，理解为何这样设计 |
| 五 | 设计权衡 | 关键设计决策与取舍原因 | 理解为什么这样设计 |
| 六 | 边界局限 | 当前实现的不足 | 了解限制 |
| 七 | 可复用模式 | 可迁移的设计模式 | 提炼沉淀 |
| 附录 | 速查 | 关键路径速查表 | 按需查阅 |

---

## 一、解决什么问题

Agent 不只是"一次性问答"——用户需要定时检查 CI 状态、周期性审查 PR、到点提醒。定时任务把 Agent 从"被动响应"变成"主动触发"。但"到时间触发一下"看似简单，一旦放到多用户、多会话、长周期运行的工程语境里，立刻暴露出五个必须解决的问题。本章先把这些问题摊开，后续所有设计都是对它们的回应。

定时任务的本质是：**把 Agent Loop 从"事件驱动"扩展为"时间驱动"**——通过调度器在特定时刻把 prompt 注入 Agent 的输入队列。Agent Loop 本身不感知时间，它只感知"用户又发了一条消息"；调度器负责制造这条"伪用户消息"。

1. **资源公平——避免惊群效应。** 如果所有用户都写 `0 * * * *`（每小时），每个 :00 整点全舰队所有 cron 任务同时触发——API 服务器瞬间被请求淹没。这里有两层难点：一是不能简单随机抖动（同一任务每次偏移不同会破坏可调试性），二是必须能远程调参（故障期间运维要在不发版的情况下扩大抖动窗口）。确定性抖动 + GrowthBook 远程配置是回答。

2. **任务存活——防止被遗忘。** 用户设了"每天检查 CI"，两个月后任务还在跑、还在烧 token。开发者心智里"定时任务"往往是临时的（"这周每小时看一眼 PR"），但 cron 一旦注册就不会自停。需要 7 天 TTL 兜底——超过期限的任务触发最后一次后自动失效，强制用户重新审视是否还需要。这个 7 天不是拍脑袋：它覆盖一个开发周期（一周迭代），同时把最坏情况下的 session 生命期钉死在一个可控上限。

3. **会话边界——持久化与恢复。** 非 durable 任务在会话关闭时丢失，durable 任务持久化到磁盘并跨会话恢复。但持久化带来新问题：用户在 IDE 里开一个 Claude、终端又开一个 Claude，两个会话指向同一项目目录——同一份 `scheduled_tasks.json` 被两个进程读到，若不互斥，"每分钟检查 CI"会被各触发一次，token 翻倍。跨进程锁是回答。

4. **状态识别——Agent 何时空闲。** 定时任务不能抢占正在进行的 Agent 推理（浪费已生成的 token），但调度器怎么知道 Agent 此刻"闲着"？需要一个统一的 idle 定义和检测机制，而且要解耦——调度器不能反向耦合到 React 的渲染周期。

5. **任务分类——recurring vs one-shot。** 重复任务有 TTL 兜底防止失控；一次性任务启动时 surface 给用户决定是否补救（missed task）。一个反直觉的设计是：两种任务的抖动方向相反——recurring 向后延迟（宁可晚一点，不影响正确性），one-shot 向前提前（用户约的是"3 点提醒"，晚于 3 点是违约，早一点用户感知不到）。这个差异源于两类任务对"准时"的契约不同。

这五个问题贯穿全章。下一章先看调度器在整个 Claude Code 架构里挂在何处，再逐层展开。

---

## 二、在整体架构中的位置

调度器独立于 Agent Loop，是 Agent 循环之外的"时间侧边车"：它不执行任何 Agent 逻辑，只在特定时刻把 prompt 注入 Agent 的输入队列。Agent Loop 与调度器的关系是**执行者与触发者**——Agent Loop 不感知时间，它只感知"又来了一条用户消息"。

定时任务通过 `CronCreateTool` / `CronDeleteTool` / `CronListTool` 三个工具管理（对外接口），运行时通过 `cronScheduler` 调度（核心引擎），在 REPL 中由 `useScheduledTasks` hook 挂载（集成点）。三者分层清晰：工具层只负责校验和落盘，调度层只负责计时和触发，hook 层只负责把触发接到 React 消息队列。

完整的定时任务调用栈：

```
用户输入 / 定时触发
  │
  ▼
CronCreateTool (packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts)
  │
  ├─► validateInput() — 验证 cron 表达式 + 检查 maxJobs + 检查 teammate durable 限制
  ├─► parseCronExpression() (src/utils/cron.ts) — 解析 5-field cron
  ├─► addCronTask() (src/utils/cronTasks.ts)
  │     │
  │     ├─► durable=true → 写入 .claude/scheduled_tasks.json
  │     └─► durable=false → 写入 bootstrap state（内存）
  │
  └─► setScheduledTasksEnabled(true) — 通知调度器启用

调度循环 (src/utils/cronScheduler.ts):
  createCronScheduler({ onFire, isLoading, ... })
    │
    ├─► 启动 enable() 流程
    │     ├─► tryAcquireSchedulerLock() — 跨进程互斥锁
    │     ├─► chokidar.watch(scheduled_tasks.json) — 文件监听
    │     └─► setInterval(check, 1000) — 1 秒 tick
    │
    └─► check() 循环:
          ├─► isLoading() — 等待 Agent 空闲
          ├─► 遍历任务列表
          │     ├─► 计算 nextFireAt (jitteredNextCronRunMs / oneShotJitteredNextCronRunMs)
          │     ├─► now >= nextFireAt → 触发
          │     │     ├─► onFire(prompt) → push 到 Agent 队列
          │     │     ├─► one-shot → removeCronTasks()
          │     │     ├─► recurring + 未过期 → 重计算 nextFireAt + markCronTasksFired()
          │     │     └─► recurring + 已过期 → 触发最后一次后删除
          │     └─► now < nextFireAt → 等待
          │
          └─► check timer unref() — 不阻止进程退出

挂载点:
  - REPL: useScheduledTasks (src/hooks/useScheduledTasks.ts) → useEffect 挂载
  - SDK/-p mode: print.ts:2831-2928 — 直接调用 createCronScheduler
  - Daemon: 独立 worker，用 dir 参数隔离

依赖的底层机制:
  - Cron 表达式解析: src/utils/cron.ts
  - 任务持久化: src/utils/cronTasks.ts
  - 跨进程锁: src/utils/cronTasksLock.ts
  - Jitter 配置: src/utils/cronJitterConfig.ts
  - Bootstrap state: src/bootstrap/state.ts (getSessionCronTasks, setScheduledTasksEnabled)
```

从这个调用栈能看出一个关键设计：调度器是**非 React 类**（`createCronScheduler` 返回纯对象），REPL 和 SDK/`-p` 模式共享同一份核心逻辑，只是挂载点和 `isLoading` 来源不同。这让定时任务的能力不绑定交互式 REPL——headless 的 `-p` 单轮命令和 daemon worker 都能用。

调用栈里的每个模块后面会逐一展开。但在此之前，先退后一步，用一张全景图把整个系统的样貌连起来——这就是下一章的任务。

---

## 三、宏观看系统完整样貌

前两章分别讲了"解决什么问题"和"挂在架构哪里"，但都是局部视角。本章先给一张端到端全景图建立心智模型，再从五个侧面（全景链路、核心抽象、版图分类、注册机制、对外接口）逐个展开，把零散的模块拼成一张完整版图。读完本章你应该能在脑里画出"一个任务从用户口令到 Agent 执行"的完整路径，后续第四章的运行时细节就是这条路径上每个关节的放大图。

### 3.1 全景链路：一个任务的端到端一生

```
┌─────────────────────────────────────────────────────────────────────────┐
│  用户/Agent 发起                                                          │
│    /loop 5m "检查 CI"   或   CronCreate({cron:"*/5 * * * *", prompt:...})  │
└──────────────────────────────┬──────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  工具层（对外接口）                                                       │
│    CronCreateTool.validateInput()                                        │
│      ├─ parseCronExpression() — 语法校验                                  │
│      ├─ nextCronRunMs() — 一年内是否有匹配（防"永不触发"）                 │
│      ├─ MAX_JOBS=50 上限检查                                              │
│      └─ teammate durable 限制                                             │
│    CronCreateTool.call()                                                 │
│      ├─ effectiveDurable = durable && isDurableCronEnabled()              │
│      ├─ addCronTask() → 写内存 or 写 .claude/scheduled_tasks.json         │
│      └─ setScheduledTasksEnabled(true) — 翻转 flag                       │
└──────────────────────────────┬──────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  调度层（核心引擎 cronScheduler）                                         │
│    start() → flag poll → enable()                                        │
│      ├─ tryAcquireSchedulerLock() — 跨进程互斥（only owning session 跑）   │
│      ├─ chokidar.watch(scheduled_tasks.json) — 文件变更触发 reload        │
│      └─ setInterval(check, 1000ms) — 1 秒 tick                            │
│                                                                           │
│    check() 每个 tick:                                                     │
│      ├─ isKilled? → killswitch 熔断                                       │
│      ├─ isLoading() && !assistantMode → Agent 忙，跳过本 tick              │
│      ├─ 遍历 file tasks（仅 isOwner）+ session tasks                       │
│      │   ├─ 首见 → nextFireAt = jitter(cron, lastFiredAt ?? createdAt)     │
│      │   ├─ now < nextFireAt → 跳过                                       │
│      │   └─ now >= nextFireAt → onFire(prompt) 注入队列                    │
│      │         ├─ recurring & 未过期 → reschedule + markCronTasksFired     │
│      │         ├─ recurring & 过期(>7天) → 最后一次 fire 后删除            │
│      │         └─ one-shot → 删除                                         │
│      └─ 清理 nextFireAt 中已不存在的任务                                   │
└──────────────────────────────┬──────────────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Agent Loop（执行者）                                                     │
│    onFire(prompt) → createAutonomyQueuedPrompt → enqueuePendingNotification│
│    → REPL 在当前轮结束后 drain 队列 → 新一轮 Agent 循环执行 prompt          │
└─────────────────────────────────────────────────────────────────────────┘
```

这张图是后续所有讨论的"地图"。三个关键边界值得记住：**工具层只校验和落盘，不含任何计时逻辑；调度层只计时和触发，不执行 Agent 逻辑；Agent Loop 只消费消息，不知道消息来自人还是 cron**。这种严格分层让每一层都能独立测试和复用。

### 3.2 核心抽象

整个系统建立在三个核心抽象上，理解了它们就理解了系统的词汇表。

**抽象一：`CronTask`——任务的统一模型。** 无论 recurring 还是 one-shot、durable 还是 session、人创建还是 assistant 内置，所有任务共享同一个数据结构。关键字段及其设计意图：

```typescript
// src/utils/cronTasks.ts:30-70
export type CronTask = {
  id: string                              // 8-hex-char UUID slice
  cron: string                            // 5-field cron (本地时区)
  prompt: string                          // 触发时注入的 prompt
  createdAt: number                       // 创建时间，missed-task 检测的锚点
  lastFiredAt?: number                    // 最近一次 fire 时间，跨进程恢复用
  recurring?: boolean                     // true=重复，false/undef=一次性
  permanent?: boolean                     // system escape hatch，跳过 TTL
  durable?: boolean                       // runtime-only，false=会话级不落盘
  agentId?: string                        // runtime-only，teammate 创建标记
}
```

几个字段的设计意图需要点出：`id` 用 8 位 hex 而非完整 UUID——`MAX_JOBS=50` 的规模下 8 位 hex（约 40 亿空间）绰绰有余，且工具层展示和磁盘存储用同一个短 ID，避免 slice/prefix 来回倒；`lastFiredAt` 是跨进程恢复的关键——进程崩溃后重启，调度器从 `lastFiredAt ?? createdAt` 重新计算 `nextFireAt`，保证恢复出的下次触发时间和崩溃前内存里的一致；`permanent` 是 assistant mode 内置任务（catch-up/morning-checkin/dream）的逃生通道，只有 `src/assistant/install.ts` 直接写文件能设置它，绕过 7 天 TTL。

**抽象二：`CronScheduler`——调度引擎接口。** 它是一个工厂函数返回的纯对象，刻意非 React：

```typescript
// src/utils/cronScheduler.ts:130-140
export type CronScheduler = {
  start: () => void
  stop: () => void
  getNextFireTime: () => number | null  // daemon 用来决定是否保活 agent 子进程
}
```

`getNextFireTime` 看似边缘，实则是 daemon 模式的关键——daemon worker 用它判断"最近有没有任务要触发"，决定是拆掉空闲的 agent 子进程还是保活等下一发。

**抽象三：`CronJitterConfig`——可远程调参的抖动配置。** 这不是普通常量，而是 ops 的应急杠杆：

```typescript
// src/utils/cronTasks.ts:309-355
export type CronJitterConfig = {
  recurringFrac: number       // 默认 0.1（周期 10%）
  recurringCapMs: number      // 默认 15 分钟
  oneShotMaxMs: number        // 默认 90 秒
  oneShotFloorMs: number      // 默认 0
  oneShotMinuteMod: number    // 默认 30（:00/:30）
  recurringMaxAgeMs: number   // 默认 7 天
}
```

这些参数通过 GrowthBook 远程配置（`tengu_kairos_cron_config`），ops 可以在 fleet-wide 调整而不发版。例如 API 故障期间把 `oneShotMinuteMod` 从 30 改到 15、`oneShotFloorMs` 改到 30000，所有用户的 :00 任务就至少提前 30 秒触发，错峰缓解。把"可调"做成一等公民，是这套系统应对线上突发流量的核心手段。

### 3.3 版图分类：四张分类图

定时任务不是一个同质集合，按不同维度切分能看到不同的设计考量。

**分类一：按生命周期——recurring vs one-shot。**

| 属性 | recurring（重复） | one-shot（一次性） | 证据 |
|------|------------------|-------------------|------|
| 触发方式 | cron 表达式 | fireAt（用 cron 锚定） | `CronCreateTool.ts:27-42` |
| TTL | 7 天（最后 fire 一次后自毁） | 单次后自毁 | `cronTasks.ts:344-355` |
| 抖动方向 | 向后延迟（最多 10% 周期，上限 15 分钟） | 向前提前（:00/:30 最多 90 秒） | `cronTasks.ts:381-445` |
| Missed 处理 | check() 自动 fire | start() 时 surface 给用户 | `cronScheduler.ts:194-227` |

两类任务对"准时"的契约不同：recurring 是"大约这个频率"（每小时检查一次，晚 3 分钟无所谓），所以向后抖动安全；one-shot 是"约在这个时刻"（3 点提醒我开会），晚于约定是违约，所以只能向前提前。这个契约差异直接决定了抖动方向相反——这不是实现巧合，而是需求驱动的。

**分类二：按持久化——durable vs session。**

| 属性 | durable=true | durable=false（默认） |
|------|-------------|---------------------|
| 存储 | `.claude/scheduled_tasks.json` | bootstrap state（内存） |
| 跨会话 | 存活 | 进程退出即丢失 |
| 跨进程锁 | 受锁保护 | 不受锁（session 私有） |
| chokidar 监听 | 是 | 否（check() 每秒直接读） |

默认 session 级是刻意的——大多数定时任务是临时的（"这周每小时看 PR"），不需要跨会话存活。durable 是显式 opt-in，且受 GrowthBook 开关 `tengu_kairos_cron_durable` 控制（`isDurableCronEnabled()`），fleet-wide 可关。

**分类三：按执行环境——REPL vs SDK/-p vs Daemon。**

| 环境 | 挂载点 | isLoading 来源 | 特点 |
|------|--------|--------------|------|
| REPL | `useScheduledTasks` hook | React state | 交互式，flag poll 启用 |
| SDK/-p | `print.ts:2831-2928` | 进程 state | 单轮命令，unref 保证退出 |
| Daemon | 独立 worker | `dir` 参数隔离 | `filter: t => t.permanent`，只处理内置任务 |

Daemon 模式有个细节：它用 `filter` 选项只处理 `permanent: true` 任务，不碰用户创建的普通任务。这是因为 daemon 是 assistant mode 的后台 worker，只负责 assistant 内置任务（catch-up/checkin/dream），用户任务仍由 REPL session 处理。

**分类四：按创建者——人 vs Agent vs assistant 内置 vs teammate。**

人和 Agent 都走 `CronCreateTool`，无区别；assistant 内置任务由 `src/assistant/install.ts` 直接写文件，带 `permanent: true`；teammate 创建的任务带 `agentId`，且强制 session 级（teammate 不跨会话存活，durable teammate cron 会变成孤儿）。

### 3.4 注册机制：任务如何进入调度器

注册机制回答一个问题：**用户调用 CronCreate 后，调度器是怎么"知道"有新任务的？** 这里有两条不同的路径，对应 durable 和 session 两种任务。

**durable 任务的注册：文件 + chokidar。** `addCronTask(durable=true)` 把任务写入 `.claude/scheduled_tasks.json`，调度器的 chokidar watcher 监听到文件变更，触发 `load(false)` 重新读取任务列表，新任务进入 `tasks` 数组，下个 `check()` tick 计算它的 `nextFireAt`。这是一条**事件驱动**的路径——文件变更主动通知调度器。

**session 任务的注册：每秒轮询。** `addCronTask(durable=false)` 把任务写入 bootstrap state（内存），**不触发任何文件事件**。调度器的 `check()` 每个 tick 都重新调用 `getSessionCronTasks()` 读最新列表。这是一条**轮询驱动**的路径——调度器主动来问，而非被动收通知。

为什么 session 任务不用事件？因为 session 任务存在内存里，没有"文件变更"可监听；而给内存 store 加事件订阅会让 bootstrap state 反向耦合到调度器。轮询的代价是 1 秒延迟——对定时任务完全可以接受。这是"解耦优先于性能"的典型取舍。

**启用时机的 flag poll。** 还有一层更上层的注册问题：调度器进程在 REPL 挂载 `useScheduledTasks` 时就创建了，但那时还没有任何任务。如果调度器立刻启动 check timer，会空跑。解法是 `getScheduledTasksEnabled()` flag——调度器 `start()` 后先轮询这个 flag，`CronCreateTool.call()` 创建任务后翻转 flag 为 true，调度器检测到才真正 `enable()`。

```typescript
// src/utils/cronScheduler.ts:1-8 — 顶层注释
// Lifecycle: poll getScheduledTasksEnabled() until true (flag flips when
// CronCreate runs or a skill on: trigger fires) → load tasks + watch the
// file + start a 1s check timer → on fire, call onFire(prompt). stop()
// tears everything down.
```

为什么不直接 start？因为调度器的创建时机早于任务创建时机。flag poll 让调度器"懒启动"——没有任务时几乎零开销（只是一个 unref 的 1 秒 interval），有任务时才真正加载文件、抢锁、起 watcher。这避开了"REPL 一启动就开 chokidar 监听一个不存在的文件"的浪费。

### 3.5 对外接口：用户和 Agent 如何操作任务

定时任务对外暴露三层接口，对应不同使用者和不同抽象层级。

**接口层一：三个 Tool（面向 Agent）。** `CronCreate` / `CronDelete` / `CronList`，Agent 通过工具调用管理任务。这是最底层的接口，所有参数（cron 表达式、prompt、recurring、durable）都暴露给 Agent。`CronCreateTool` 的 schema 里直接嵌入了使用建议（如 `recurring=false` 用于"提醒我 at X"），引导 Agent 正确选择参数。

**接口层二：`/loop` 命令（面向用户）。** 用户输入 `/loop 5m 检查 CI`，LoopManager 把 `5m` 翻译成 `*/5 * * * *`，再调用 `CronCreateTool`。`/loop` 不重新实现调度，只是 cron 的"语法糖"——把人类友好的间隔表达翻译成 cron 表达式。

**接口层三：`ScheduleWakeup`（面向 Agent 的动态自调度）。** 这是 `/loop` 不带 interval 时的路径：Agent 每轮结束后自己调用 `ScheduleWakeup(delaySeconds, prompt)` 决定下次延迟。这不是 cron 调度，而是 Agent 自驱的"睡一会儿再醒来"。`/loop` 的灵活性在于：有 interval 时用精确 cron，没 interval 时让 Agent 自己决定节奏。

这三层接口共用同一套底层调度——无论从哪层进来，最终都变成 `CronTask` 进入 `cronScheduler`。接口的差异只在"如何生成 cron 表达式"和"谁来决定触发时刻"。

| 维度 | 底层 Cron 调度 | Loop 范式 | ScheduleWakeup |
|------|--------------|----------|----------------|
| 触发方式 | CronCreate 工具 | `/loop <interval> <prompt>` | Agent 每轮自调 |
| 时间控制 | cron 表达式 | 自然语言（5m/1h） | 动态 delaySeconds |
| 适用 | 精确周期 | 用户级周期 | 自适应节奏 |
| 生命周期 | 取决于 durable | 默认会话级 | 会话级 |

至此，系统的全貌已经拼完。但"是什么"和"怎么运行"还差一步——下一章沿着一次任务的完整生命周期，把每个机制拆开看：为什么需要、怎么做、具体实例。

---

## 四、深入核心运行时细节

本章是全章的"放大镜"。第三章给出了端到端全景图，但每个关节只点到为止；本章沿**一次任务从创建到销毁的完整生命周期**组织，把全景图上每个节点放大成"为什么需要 → 怎么做 → 具体实例"三段式。生命周期共七个阶段：创建落盘 → 调度器启用 → 时间计算 → 抖动防惊群 → 空闲触发 → 过期删除 → 进程退出。每个阶段对应一节，节与节之间是数据流的自然流向——前一节的输出是后一节的输入。

### 4.1 任务创建与持久化

**为什么需要。** 创建阶段是整个生命周期的入口，要同时解决三个问题：校验用户输入合法性（防止"永不触发"的 cron 进系统）、控制任务总量（防止无限堆积）、决定存储介质（内存还是文件）。这三个问题若不在入口拦住，后续调度层就要反复处理脏数据。

**怎么做。** `CronCreateTool` 分两步：`validateInput()` 做校验，`call()` 落盘并启用调度器。校验有四道关，每道关对应一个 errorCode：

```typescript
// packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts:82-129
async validateInput(input): Promise<ValidationResult> {
  if (typeof input.cron !== 'string' || input.cron.length === 0) {
    return { result: false, message: "Missing required parameter 'cron' ...", errorCode: 1 }
  }
  if (!parseCronExpression(input.cron)) {
    return { result: false, message: `Invalid cron expression '${input.cron}'. ...`, errorCode: 1 }
  }
  if (nextCronRunMs(input.cron, Date.now()) === null) {
    return { result: false, message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`, errorCode: 2 }
  }
  const tasks = await listAllCronTasks()
  if (tasks.length >= MAX_JOBS) {
    return { result: false, message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`, errorCode: 3 }
  }
  if (input.durable && getTeammateContext()) {
    return { result: false, message: 'durable crons are not supported for teammates ...', errorCode: 4 }
  }
  return { result: true }
}
```

四道关的设计意图：第一关防 `ExecuteExtraTool` 传错字段名（`cron` 变成 `schedule`）导致 `undefined` 进下游；第二关防语法错误；第三关防"合法但永不触发"（如 `30 2 * * *` 在某些时区被 DST 吞掉，或 `0 0 31 2 *` 这种 2 月没有 31 号的表达式）——`nextCronRunMs` 用 366 天上限检测；第四关防 teammate durable 孤儿（teammate 不跨会话，durable teammate cron 重启后 `agentId` 指向不存在的 teammate）。

`call()` 里的关键一行是 `effectiveDurable = durable && isDurableCronEnabled()`——`isDurableCronEnabled()` 是 GrowthBook 开关 `tengu_kairos_cron_durable`，默认 true（向后兼容），但 fleet-wide 可关闭。这是"killswitch 强制 session-only"——schema 不变（Agent 看不到验证错误），但落盘行为被运维远程接管。

**具体实例。** Agent 调用 `CronCreate({cron: "*/5 * * * *", prompt: "检查 CI", recurring: true, durable: false})`：
1. `validateInput`：`parseCronExpression("*/5 * * * *")` 成功；`nextCronRunMs` 返回 5 分钟后；任务数 &lt; 50；无 teammate context → 校验通过。
2. `call`：`effectiveDurable = false && true = false`；`addCronTask` 把任务写入 bootstrap state（内存），返回 8 位 hex id；`setScheduledTasksEnabled(true)` 翻转 flag。
3. 调度器下个 tick 检测到 flag 变 true，`enable()` 启动——但 session 任务不需要 chokidar，`check()` 每秒直接从 `getSessionCronTasks()` 读到它。

### 4.2 调度器生命周期与跨进程互斥

**为什么需要。** 调度器要解决两个时间维度的协调问题：纵向是"何时启动"（创建早于任务，不能空跑），横向是"多进程谁来跑"（同一项目多个 session 不能重复触发）。前者靠 flag poll 懒启动，后者靠跨进程文件锁。这两个机制合起来构成调度器的生命周期骨架。

**怎么做。** 生命周期分四阶段，每阶段对应一个明确职责：

```typescript
// src/utils/cronScheduler.ts:1-8 — 顶层注释
// Lifecycle: poll getScheduledTasksEnabled() until true (flag flips when
// CronCreate runs or a skill on: trigger fires) → load tasks + watch the
// file + start a 1s check timer → on fire, call onFire(prompt). stop()
// tears everything down.
```

1. **start()** — daemon 模式（`dir !== undefined`）直接 enable；否则检查 flag，flag false 启动 enablePoll（每秒查），flag true 启动 enable()。
2. **enable()** — 抢跨进程锁；首次 load + 检测 missed tasks；起 chokidar 监听；起 1 秒 check timer。
3. **check()** — 每秒执行：killswitch 熔断 → isLoading 跳过 → 遍历触发 → 处理删除路径。
4. **stop()** — 清 timer/watcher，释放锁。

跨进程互斥由 `tryAcquireSchedulerLock()`（`src/utils/cronTasksLock.ts`）实现——同一项目目录下只能有一个 session 作为 owning session 处理文件任务：

```typescript
// src/utils/cronScheduler.ts:347-369 — 文件任务只在 owning session 处理
if (isOwner) {
  for (const t of tasks) process(t, false)
  // ...
}
```

非 owning session 启动 `lockProbeTimer`（`LOCK_PROBE_INTERVAL_MS = 5000`），每 5 秒重新尝试获取锁，owning session 崩溃时接管。为什么 5 秒而非更短？因为接管只在 owner 崩溃时才有意义——崩溃是低频事件，5 秒的接管延迟换 5 倍的探针频率下降，CPU 划算。

**为什么用文件锁而非单进程服务？** 用户可能在 IDE 里开一个 Claude、终端又开一个 Claude，两个 session 指向同一项目。如果不互斥，同一 cron 会被各触发一次，token 翻倍。文件锁足够轻量——不需要额外部署 daemon 或 IPC 服务，靠一个 lockfile + PID liveness probe 就够。这是"用最小机制解决问题"的体现。

**具体实例。** 用户在 IDE 开 Claude A（session A），终端开 Claude B（session B），都指向 `~/project`：
1. A 先 `start()`，`tryAcquireSchedulerLock` 成功，`isOwner=true`，起 check timer 处理文件任务。
2. B 后 `start()`，抢锁失败，`isOwner=false`，起 `lockProbeTimer` 每 5 秒重试，**不处理文件任务**（只处理自己的 session 任务）。
3. A 崩溃 → 释放锁（或 lockfile 的 PID 探针发现 A 进程没了）→ B 下次 probe 成功，`isOwner=true`，接管文件任务。

### 4.3 时间计算：cron 解析与 next-run

**为什么需要。** 调度器每个 tick 都要算"每个任务下次何时触发"——这个计算必须既正确（符合 cron 语义）又高效（每秒跑一次）。同时 cron 有几个历史包袱（DST、dayOfMonth/dayOfWeek 的 OR 语义、7=Sunday 别名）必须处理对，否则触发时刻会错。

**怎么做。** 解析在 `src/utils/cron.ts`，支持标准 5-field cron 子集：

```
┌─────────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌─────────── day of month (1-31)
│ │ │ ┌───────── month (1-12)
│ │ │ │ ┌─────── day of week (0-6, 0=Sun, 7=Sun alias)
│ │ │ │ │
* * * * *
```

字段语法（`src/utils/cron.ts:31-77`）：通配符 `*`、单值 `N`、step `*/N`、范围 `N-M`、范围+step `N-M/S`、列表 `N,M,K`。不支持 `L`/`W`/`?`/名字别名。为什么不支持完整 cron？大多数需求在标准子集内，`L`/`W` 在不同 cron 实现中语义不一致，完整实现复杂且易错——"够用就好"的工程取舍。

dayOfWeek 的 7 兼容（`src/utils/cron.ts:51-58`）：`5-7` 被解释为 `5,6,0`（Fri,Sat,Sun），比 vixie-cron 更宽容。vixie-cron 的 dayOfWeek 是 0-6，写 `7` 报错；这里允许 `7` 作为 `0` 的别名，减少用户踩坑。

```typescript
// src/utils/cron.ts:83-107 — parseCronExpression
export function parseCronExpression(expr: string): CronFields | null {
  if (typeof expr !== 'string') return null  // 防御 undefined
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  // ... 每个字段 expandField
}
```

`computeNextCronRun`（`src/utils/cron.ts:125-187`）从 `from` 严格之后的下一分钟开始，逐分钟前进，最多迭代 366 天。三个关键设计：

- **OR 语义**：当 dayOfMonth 和 dayOfWeek 都受约束时，**任一**匹配即可。例如 `0 9 1 * 1` = "每月 1 号或周一 9 点"，而非"1 号且是周一"。这是 vixie-cron 标准。
- **DST 处理**：固定小时的 cron 在 spring-forward 日跳过（`30 2 * * *` 在美东 3 月跳过，因为 2:30 那一刻不存在）；fall-back 时第一次匹配触发，第二次跳过。
- **366 天上限**：防无限循环（虽然合法 cron 必有匹配）。这个上限同时是"cron 是否有解"的检测——超过一年找不到匹配说明表达式有问题（如 `0 0 31 2 *`），`validateInput` 第三关就用它拒绝。

**时区**：所有 cron 用进程本地时区（`src/utils/cron.ts:6-8`）。`0 9 * * *` 在用户本地 9 点触发，不需要用户理解 UTC。代价是同一 cron 在不同时区执行时间不同——但这是符合用户预期的（"9 点提醒我"指的就是本地 9 点）。

**具体实例。** `0 9 1 * 1`（每月 1 号或周一 9 点）从 7 月 6 日计算 next-run：
- 7 月 6 日是周日，dayMatches 检查：dom=6 不在 `{1}`，dow=0 不在 `{1}`，都不匹配 → 跳到 7 月 7 日。
- 7 月 7 日是周一，dow=1 匹配 → dayMatches true → 检查 hour=0 不在 `{9}` → 跳到 9 点 → 检查 minute=0 在 `{0}` → 返回 7 月 7 日 9:00。

### 4.4 抖动算法：防惊群的两种方向

**为什么需要。** 惊群效应（thundering herd）：所有用户都写 `0 * * * *`（每小时），每个 :00 整点全舰队所有 cron 同时触发，API 瞬间被淹。抖动要让触发时间分散，但有两个约束：同一任务的偏移必须可预测（便于调试、跨进程一致）、偏移幅度必须可远程调（故障期间扩大窗口）。确定性哈希偏移 + GrowthBook 配置是回答。

**怎么做。** 两类任务抖动方向相反——这是全章最反直觉但最关键的设计。

**Recurring 抖动：向后延迟。** `jitteredNextCronRunMs`（`src/utils/cronTasks.ts:381-398`）：

```typescript
export function jitteredNextCronRunMs(cron, fromMs, taskId, cfg): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  const t2 = nextCronRunMs(cron, t1)
  if (t2 === null) return t1  // 没有下一次匹配 → 立即触发
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  )
  return t1 + jitter
}
```

偏移量 = `jitterFrac(taskId) * 0.1 * 周期`，上限 15 分钟。`jitterFrac(taskId)` 把 id 前 8 位 hex 解析为 u32 再除以 2^32，得到 [0,1) 的稳定值。同一任务每次偏移一致（确定性），不同任务偏移均匀分布（打散）。偏移与周期成比例——每小时任务偏移 [:00, :06)（6 分钟），每分钟任务只偏移几秒。为什么基于 taskId 哈希而非随机？确定性意味着跨进程一致：两个 session 看到同一文件的 durable 任务，算出的 `nextFireAt` 完全相同，配合跨进程锁就不会双触发；随机偏移会让两个 session 算出不同时间，锁的互斥意义被削弱。

**One-shot 抖动：向前提前。** `oneShotJitteredNextCronRunMs`（`src/utils/cronTasks.ts:421-445`）：

```typescript
export function oneShotJitteredNextCronRunMs(cron, fromMs, taskId, cfg): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  // 只对分钟为 0 或 30 的触发时间抖动（人类 rounding hotspots）
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1
  const lead = cfg.oneShotFloorMs + jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  return Math.max(t1 - lead, fromMs)
}
```

为什么 one-shot 反向？因为契约不同：one-shot 是"约在 3 点"（用户约的是提醒时刻），晚于 3 点是违约，早一点用户感知不到（不会有人盯着屏幕等 :00 触发）。所以提前触发对用户不可见，但能分散 API 请求。

为什么只对 :00/:30 抖动？用户通常用 round time 作为提醒时间（"9 点提醒我"→`0 9`）。其他时间（如 9:23）本身就不在热点，不需要抖动。`oneShotMinuteMod=30` 意味着只有 `minute % 30 === 0`（即 :00 和 :30）才抖动。

为什么用 `getMinutes()`（本地）而非 `getUTCMinutes()`？半小随时区（如印度 UTC+5:30）local :00 是 UTC :30，UTC 检查会抖动错的 marks。cron 在本地时区解释，热点也得在本地时区识别。

**远程调参。** 故障期间 ops 推送 `{oneShotMinuteMod: 15, oneShotMaxMs: 300000, oneShotFloorMs: 30000}`——所有 :00/:15/:30/:45 任务提前 [30s, 5min] 触发，每个任务至少 30 秒 lead，没人落在整点。`oneShotFloorMs` 的存在让即使 taskId 哈希到 0 的任务也有 floor 的 lead，保证"没人落在边界"。

**提示用户避开 :00/:30。** 算法抖动之外，cron 的 system prompt 直接告诉 Agent 建议：

```
## Avoid the :00 and :30 minute marks when the task allows it
"every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
```

LLM 看到后自动用非整点时间——这是从用户入口解决惊群，比纯算法抖动更有效（直接让请求不集中在 :00）。算法抖动是兜底，prompt 引导是第一道防线。

**具体实例。** 两个用户都设"每小时检查 CI"：
- 用户 A 的 taskId 哈希 = 0.3 → 偏移 0.3 × 0.1 × 60min = 1.8min → 每小时 :01:48 触发。
- 用户 B 的 taskId 哈希 = 0.7 → 偏移 0.7 × 0.1 × 60min = 4.2min → 每小时 :04:12 触发。
- 全舰队上千用户的 :00 请求被分散到 [:00, :06) 的 6 分钟窗口，API 压力摊平。

### 4.5 空闲检测与触发执行

**为什么需要。** 调度器算出"该触发了"，但此刻 Agent 可能正在推理（烧了 80% token 即将完成）。若抢占触发，已生成的 token 全废。需要一个 idle 检测机制：只在 Agent 空闲时触发，且要解耦——调度器不能反向耦合 React 渲染周期。

**怎么做。** 空闲检测的入口是 `check()` 的第一道闸：

```typescript
// src/utils/cronScheduler.ts:230-232
function check() {
  if (isKilled?.()) return
  if (isLoading() && !assistantMode) return
  // ...
}
```

`isLoading()` 由调用方注入，是一个函数而非订阅——这是解耦的关键：
- **REPL**：`useScheduledTasks` 传入 `() => isLoadingRef.current`（React state 的 ref 镜像）。
- **SDK/-p**：传入相同的进程 state。
- **assistant mode**：`assistantMode=true` 绕过 isLoading 检查。

```typescript
// src/hooks/useScheduledTasks.ts:71-110 — useScheduledTasks hook
export function useScheduledTasks({ isLoading, assistantMode, setMessages }): void {
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading  // ref 镜像，避免闭包捕获过期值
  useEffect(() => {
    if (scheduler.current) return
    scheduler.current = createCronScheduler({
      onFire: (prompt) => { /* 注入消息队列 */ },
      isLoading: () => isLoadingRef.current,  // ← 关键：把 React state 传给 scheduler
      assistantMode,
      // ...
    })
    scheduler.current.start()
    return () => scheduler.current?.stop()
  }, [...])
}
```

**为什么用 ref 镜像而非直接传 `isLoading`？** `useEffect` 只在 `assistantMode` 变时重跑（ deps 故意只放 `assistantMode`），如果闭包直接捕获 `isLoading`，scheduler 拿到的永远是首次渲染的值。ref 镜像让 effect 只挂载一次，但 `isLoading()` 每次调用读最新值。

**为什么轮询而非事件订阅？** 事件订阅需要 React → Scheduler 的同步通信（callback），耦合度高；轮询只需 scheduler 每秒问一次"现在忙吗"，解耦清晰。代价是 1 秒检测延迟——对定时任务完全可以接受（定时任务本身精度就是分钟级）。

触发时调度器调用 `onFire(prompt)`，REPL 里走 `createAutonomyQueuedPrompt` → `enqueuePendingNotification`，prompt 进命令队列以 'later' 优先级，REPL 在当前轮结束后 drain 队列启动新轮。**任务不抢占，而是排队等当前轮结束**——这保证了已生成的 token 不浪费。

**assistant mode 例外。** `assistantMode: true` 绕过 isLoading，因为 assistant mode 设计为后台长跑，几乎从不空闲。这从另一个角度定义了"空闲"：**空闲 = 不是交互式 Agent 正在处理的时刻**。assistant mode 不是交互式，不需要等待空闲。注释指出 post-#20425 后 assistant mode 也会在轮间 idle，这个 bypass 现在只是 latency 优化而非防饿死。

**任务失败语义。** 如果 Agent 持续忙碌（长对话），定时任务被跳过而非排队。错过 `0 9 * * *`（9:00）的任务，下一次触发是次日 9:00。这对"提醒类"任务是个边界——用户可能要等 24 小时。这是"宁可跳过不堆积"的取舍：排队会无限堆积（任务数上限也解决不了），跳过语义更清晰。

**具体实例。** 9:00 的 cron 任务，Agent 从 8:59:50 推理到 9:00:30：
- 9:00:00 tick：`isLoading()=true` → 跳过本 tick。
- 9:00:01~9:00:29 tick：`isLoading()=true` → 跳过。
- 9:00:30 tick：Agent 推理结束 `isLoading()=false` → 触发，prompt 进队列。
- 9:00:31：REPL drain 队列，新轮启动。
- 任务本该 9:00 触发，实际 9:00:30 触发——晚了 30 秒，但没浪费 Agent 刚才的推理 token。

### 4.6 过期、删除与 missed task

**为什么需要。** 任务有生就有死。三类死亡路径：one-shot 触发后自毁、recurring 7 天 TTL 到期最后 fire 一次后删除、会话关闭时 session 任务丢失。还有一类"该触发但没触发"——进程关闭期间错过的 one-shot 任务，启动时要 surface 给用户决定补救。每个路径都有不同的存储一致性策略。

**怎么做。**

**7 天 TTL。** `isRecurringTaskAged`（`src/utils/cronScheduler.ts:53-60`）判定过期：

```typescript
export function isRecurringTaskAged(t, nowMs, maxAgeMs): boolean {
  if (maxAgeMs === 0) return false  // 0 = 无限
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}
```

aged 任务触发最后一次 fire，然后走 one-shot 删除路径（`src/utils/cronScheduler.ts:299-344`）：

```typescript
const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
if (aged) {
  logEvent('tengu_scheduled_task_expired', { taskId: t.id, ageHours })
}
if (t.recurring && !aged) {
  // 正常 recurring → reschedule
} else if (isSession) {
  removeSessionCronTasks([t.id])  // session 任务同步删内存
} else {
  inFlight.add(t.id)
  void removeCronTasks([t.id], dir)  // file 任务异步删盘
}
```

为什么 7 天？注释直说：cron 是多日 session 的主要驱动（p99 uptime 61min → 53h post-#19931），无界 recurrence 会让 Tier-1 堆泄漏无限累积。7 天覆盖"这周每小时看 PR"的工作流，同时钉死最坏 session 生命期。`permanent: true` 跳过 aged 检查——assistant mode 内置任务（catch-up/checkin/dream）需要永久存活，且删了无法重建（`install.ts` 的 `writeIfMissing` 跳过已存在文件）。

**两层删除路径。** session 任务同步从内存删除（`removeSessionCronTasks`，无 IO），file 任务异步从文件删除（`removeCronTasks` + chokidar reload）。为什么不同？session 任务在内存，删了立即可见；file 任务删盘后要等 chokidar reload 才更新 `tasks` 数组，期间 `inFlight` set 防止双触发。不同存储介质用不同一致性策略。

**Missed task 检测。** `findMissedTasks`（`src/utils/cronTasks.ts:453-458`）找出"next-run（从 createdAt 算）已过去"的任务。只在 `load(true)`（首次加载）时 surface，且只对 one-shot：

```typescript
// src/utils/cronScheduler.ts:194-227
const missed = findMissedTasks(next, now).filter(
  t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t))
)
if (missed.length > 0) {
  for (const t of missed) {
    missedAsked.add(t.id)
    nextFireAt.set(t.id, Infinity)  // 防 check() 重复 fire 原始 prompt
  }
  if (onMissed) onMissed(missed)
  else onFire(buildMissedTaskNotification(missed))
  void removeCronTasks(missed.map(t => t.id), dir)  // 删盘，防再问
}
```

为什么只 surface one-shot？recurring 任务错过窗口，`check()` 会从 createdAt 自动 fire 并 reschedule，不需要用户确认；one-shot 任务"该做但没做"，应让用户决定补救——自动 fire 风险大（可能已经没意义了，如"会议开始前提醒"）。`missedAsked` set 防止 chokidar reload 反复问。任务在 surface 前就删盘，避免用户还没回答又被 `check()` fire。

**具体实例。** 用户 8:00 设了 `0 9 * * *` 的 one-shot（9 点提醒），8:30 关掉 Claude，9:30 重新打开：
1. `load(true)`：`findMissedTasks` 发现该任务 next-run=9:00 &lt; now=9:30 → missed。
2. `missedAsked.add(id)`，`nextFireAt.set(id, Infinity)` 防 check() fire。
3. `onFire(buildMissedTaskNotification(...))` 注入通知："以下 one-shot 任务在 Claude 未运行期间错过，已从文件删除。请用 AskUserQuestion 询问是否现在执行。"
4. `removeCronTasks` 删盘。
5. Agent 看到通知，用 AskUserQuestion 问用户"9 点的提醒现在要执行吗"，用户决定。

### 4.7 进程退出与 unref

**为什么需要。** 调度器的 1 秒 check timer 是一个活跃的 event loop 句柄，会阻止 Node/Bun 进程退出。在 `-p` 模式（单轮命令）下，即使创建了 cron 任务，单轮对话完成后进程也应正常退出——否则 `claude -p "设个提醒"` 会永远挂住。但简单 `unref` 又会让进程在 timer 还活着时就退出，带来锁接管的复杂度。

**怎么做。**

```typescript
// src/utils/cronScheduler.ts:456-459
checkTimer = setInterval(check, CHECK_INTERVAL_MS)
// Don't keep the process alive for the scheduler alone — in -p text mode
// the process should exit after the single turn even if a cron was created.
checkTimer.unref?.()
```

`checkTimer.unref?.()` 让 check timer 不被计入"阻止进程退出"的句柄。`enablePoll` 和 `lockProbeTimer` 同样 `unref`。这是 `-p` 模式能正常退出的关键。

**设计权衡。** 不调 `unref()`，scheduler 会让进程永远活着，`-p` 模式无法退出；调了 `unref()`，scheduler 不能依赖 timer 活跃度来检测进程存活——owner 崩溃后，非 owner 的 `lockProbeTimer` 也是 unref 的，但只要进程还活着就会 probe。锁的 liveness 探针基于 lockfile 里的 PID，不依赖 timer 活跃度，所以 `unref` 不影响接管逻辑。两者解耦得干净。

`CHECK_INTERVAL_MS = 1000`（1 秒）是精度与 CPU 的平衡——1 秒延迟对分钟级定时任务无感，每秒一次 check 的 CPU 开销可忽略。`FILE_STABILITY_MS = 300`（chokidar `awaitWriteFinish.stabilityThreshold`）等文件写完 300ms 才触发 reload，避免半写入的 JSON 被读到。这些常量背后都是"对定时任务而言，秒级抖动无感"这一前提。

**具体实例。** `claude -p "每天 9 点提醒我站会"`：
1. Agent 调 `CronCreate`，durable=false（`-p` 默认 session 级），任务进内存。
2. `setScheduledTasksEnabled(true)`，scheduler `enable()`，起 check timer（unref）。
3. 单轮对话完成，REPL 准备退出。
4. check timer 因 unref 不阻止退出，进程正常结束，session 任务随进程消失。
5. 若用户写 `durable=true`，任务落盘到 `.claude/scheduled_tasks.json`，进程退出后文件留存，下次启动 `load(true)` 恢复。

### 4.8 运行时约束速查

本章末尾把散落各节的常量与约束集中成一张速查表，便于回查。每个常量背后的意图见对应小节。

| 约束 | 值 | 设计意图 | 代码位置 | 详见 |
|------|-----|---------|---------|------|
| 最大任务数 | 50 (MAX_JOBS) | 防止任务无限堆积 | `CronCreateTool.ts:25` | 4.1 |
| CronCreate 完整实现 | `buildTool({...})` | 工具入口（校验+落盘+启用） | `CronCreateTool.ts:56-170` | 4.1 |
| 触发时机 | 仅 Agent 空闲时 | 避免打断正在进行的推理 | `cronScheduler.ts:230-232` | 4.5 |
| 持久化位置 | `.claude/scheduled_tasks.json` | 每个项目独立目录 | `cronTasks.ts:74-83` | 4.1 |
| 任务文件格式 | JSON `{tasks: CronTask[]}` | 标准化，可手动编辑；写回时剥离 runtime-only 字段 | `cronTasks.ts:72-181` | 4.1 |
| Recurring TTL | 7 天（最后 fire 一次后自毁） | 防被遗忘任务无限烧 token；钉死最坏 session 生命期 | `cronTasks.ts:344-355` | 4.6 |
| Check 间隔 | 1 秒 (CHECK_INTERVAL_MS) | 平衡精度与 CPU | `cronScheduler.ts:40` | 4.7 |
| File watcher | chokidar，FILE_STABILITY_MS=300ms | 等文件写完再 reload，避免半写入事件 | `cronScheduler.ts:41-44` | 4.7 |
| Lock probe | 5 秒 (LOCK_PROBE_INTERVAL_MS，非 owning session) | 接管崩溃的 owner，低频探针换 CPU | `cronScheduler.ts:43-44` | 4.2 |
| Missed task 检测 | next-run（从 createdAt 算）已过 | 给用户 catch-up 机会，仅 one-shot | `cronTasks.ts:453-458` | 4.6 |
| Jitter 上限（recurring） | 10% 周期，最大 15 分钟 | 防惊群，向后延迟 | `cronTasks.ts:348-355` | 4.4 |
| Jitter 上限（one-shot） | :00/:30 最多提前 90 秒 | 用户感知小，防 API 风暴，向前提前 | `cronTasks.ts:421-445` | 4.4 |
| Cron → 人类可读 | `cronToHuman` 翻译 | 用户友好展示，复杂表达式 fallback 原 cron | `cron.ts:224-314` | 4.3 |

至此，一次任务从创建到销毁的完整生命周期走完。回看全章：第一章的五个工程问题，在第四章里分别由不同机制回应——惊群由抖动（4.4）、被遗忘由 TTL（4.6）、跨会话由文件锁（4.2）、空闲由轮询检测（4.5）、分类由 recurring/one-shot 双路径（4.1+4.6）。下一章把这些机制背后的设计决策集中收束。

---

## 五、设计决策与权衡

本章把前四章散落的设计决策集中对比，每行回答"选了什么、放弃了什么、为什么"。理解这些取舍比记住实现细节更重要——它们是可迁移的判断。

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 调度方式 | cron 表达式（5-field） | 固定间隔（如"每 5 分钟"） | cron 提供精确的时间控制（特定日期/星期/时间）；固定间隔更简单但不够灵活，无法表达"每月 1 号" |
| TTL 策略 | 7 天强制过期 | 无限期 | 防止被遗忘的周期性任务无限烧 token；7 天覆盖大多数开发周期，同时钉死最坏 session 生命期，限制 Tier-1 堆泄漏累积 |
| 持久化策略 | 可选 durable（默认会话级） | 全部 durable | 大多数定时任务是临时的（"这周看 PR"），不需要跨会话；显式 opt-in 减少误持久化 |
| 空闲触发 | 仅空闲时触发 | 抢占式触发 | 打断正在进行的推理会浪费已生成的 token；等 Agent 空闲再触发更经济，且排队优先级保证不丢 |
| 抖动算法 | 确定性哈希偏移 | 随机偏移 | 确定性偏移确保同一任务触发时间可预测、跨进程一致（配合文件锁防双触发）；随机偏移不利于调试且削弱锁意义 |
| 抖动方向（one-shot） | 提前触发 | 延后触发 | one-shot 是"约在 X 时刻"，晚于约定是违约，早一点用户感知不到；recurring 是"大约这个频率"，向后延迟安全 |
| 任务跳过策略 | 跳过不排队 | 排队等待空闲 | 排队会无限堆积（任务数上限也解决不了）；跳过语义更清晰，代价是可能等下个周期 |
| 跨进程锁 | 文件锁（cronTasksLock） | 单进程服务 | 跨会话互斥不引入额外进程；文件锁 + PID 探针足够轻量，无需部署 daemon 或 IPC |
| Missed task 策略 | 启动时 surface 给用户 | 自动 fire | "该做但没做"的任务应让用户决定是否补救；自动 fire 风险大（可能已无意义，如"会议开始前提醒"） |
| Cron 解析复杂度 | 标准 5-field 子集 | 完整 cron（含 L/W/?） | 大多数需求在标准子集内；L/W 在不同实现中语义不一致，完整实现复杂易错 |
| 时区策略 | 进程本地时区 | 用户显式指定 | "9 点提醒我"应在本地时区解释；显式时区增加配置负担，违背用户直觉 |
| 提示避开 :00/:30 | prompt 提示 Agent | 强制禁止 | Agent 看到提示后自动避开更灵活；强制禁止破坏"用户明确要 9:00"的场景 |
| 启用时机 | flag poll 懒启动 | 立即启动 | 调度器创建早于任务，立即启动会空跑 timer；flag poll 让无任务时几乎零开销 |
| idle 检测 | 轮询（每秒） | 事件订阅 | 轮询解耦清晰（不反向耦合 React）；事件订阅需同步通信，耦合度高；1 秒延迟对定时任务无感 |

---

## 六、可复用的模式

本章把前文的机制提炼成可迁移到其他系统的设计模式。每个模式都是"问题 + 解法 + 适用条件"的封装，不绑定 Claude Code。

- **空闲触发模式**：后台任务只在主循环不忙时触发，避免打断正在进行的工作。适用于"后台调度 + 前台交互"共存的系统，关键是定义清晰的 idle 判定（轮询而非订阅，解耦优先）。
- **确定性抖动模式**：基于实体 ID 的哈希偏移避免惊群效应，同时保持可预测性和跨进程一致性。适用于多实例分布式调度，关键是偏移可远程调参（应对突发流量）。
- **TTL 兜底模式**：所有自动任务都有强制过期时间，防止被遗忘的任务无限消耗资源。适用于用户创建的长生命周期资源，关键是 TTL 长度覆盖主要使用周期又钉死最坏情况。
- **可选持久化模式**：区分会话级和持久化任务——默认轻量（会话级），需要时显式声明 durable。适用于"大多数临时、少数需持久"的场景，关键是默认值选轻量那端。
- **跨进程互斥模式**：用文件锁 + PID liveness probe 防止多进程重复执行，无需额外部署服务。适用于同主机多进程共享资源的场景，关键是探针频率与接管延迟的权衡。
- **直方图热点规避模式**：在 prompt/文档层引导用户避开整点/半点，从源头分散请求。比纯算法抖动更有效，适用于"用户倾向选择 round number"的场景。
- **Missed task 通知模式**：启动时 surface 已过期的 one-shot 任务让用户决定，而非自动执行。适用于"错过即可能无意义"的任务，关键是不自动补救。
- **两层删除路径模式**：内存任务同步删、文件任务异步删 + 监听 reload，不同存储介质用不同一致性策略。适用于混合存储系统，关键是 `inFlight` set 防中间态双触发。
- **flag poll 懒启动模式**：调度器创建后不立即运行，而是轮询 flag 直到有任务才真正启用。适用于"组件挂载早于实际使用"的场景，关键是 unref 让空跑零成本。
- **远程调参的常量模式**：把抖动幅度、TTL 等关键常量做成可远程配置的一等公民，而非硬编码。适用于线上需要应对突发流量的系统，关键是默认值保持向后兼容。


---

## 附录：定时任务生态关键路径速查

| 路径 | 角色 |
|------|------|
| `src/utils/cron.ts` | Cron 表达式解析、next-run 计算、cronToHuman |
| `src/utils/cronTasks.ts` | 任务持久化、抖动算法、missed task 检测 |
| `src/utils/cronScheduler.ts` | 调度循环、跨进程锁、文件监听 |
| `src/utils/cronTasksLock.ts` | 跨进程互斥锁 |
| `src/utils/cronJitterConfig.ts` | GrowthBook 远程配置 |
| `packages/builtin-tools/src/tools/ScheduleCronTool/CronCreateTool.ts` | CronCreate 工具实现 |
| `packages/builtin-tools/src/tools/ScheduleCronTool/CronDeleteTool.ts` | CronDelete 工具实现 |
| `packages/builtin-tools/src/tools/ScheduleCronTool/CronListTool.ts` | CronList 工具实现 |
| `packages/builtin-tools/src/tools/ScheduleCronTool/UI.tsx` | 结果渲染 |
| `src/hooks/useScheduledTasks.ts` | REPL 挂载 hook |
| `src/cli/print.ts:2831-2928` | SDK/-p mode 挂载点 |
| `src/bootstrap/state.ts` | Session 任务存储、`setScheduledTasksEnabled` flag |
| `src/assistant/install.ts` | Assistant mode 内置任务（permanent: true） |