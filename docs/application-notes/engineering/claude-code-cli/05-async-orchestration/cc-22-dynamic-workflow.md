---
slug: /application-notes/engineering/claude-code-cli/cc-22-dynamic-workflow
sidebar_position: 22
title: "动态工作流"
description: "从 Workflow Tool 入口、脚本执行、agent hook 到 Journal 恢复，拆解 Claude Code 的确定性编排路径。"
---

> 本篇讲 Workflow 引擎本身：如何把一段 JavaScript 工作流脚本变成可恢复、可限流、可观察的多 Agent run。

# 动态工作流

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **工具入口**：`src/workflow/wiring.ts` 的 `createWorkflowToolCore()`——把 workflow-engine 的 descriptor 适配为 Claude Code Tool，并通过 `getWorkflowService()` 延迟取得共享 ports。
> - **Tool 执行器**：`packages/workflow-engine/src/tool/WorkflowTool.ts` 的 `createWorkflowTool()`、`resolveScriptSource()`——解析 `script`、`name`、`scriptPath`，注册运行时任务并 detached（脱离当前回合）启动 `runWorkflow()`。
> - **服务入口**：`src/workflow/service.ts` 的 `getWorkflowService()`、`launch()`——供 Workflow 面板或命令侧启动，与 Tool 入口共享同一组 `WorkflowPorts`。
> - **脚本装配**：`packages/workflow-engine/src/engine/script.ts` 的 `extractMeta()`、`assertScriptBody()`、`parseScript()`——提取纯字面量 `meta`，拒绝不支持的模块语法，并把脚本包装为 `AsyncFunction`。
> - **Hook 编排**：`packages/workflow-engine/src/engine/hooks.ts` 的 `makeHooks()`——实现 `agent()`、`parallel()`、`pipeline()`、`phase()`、`log()` 和 `workflow()`。
> - **运行时上下文**：`packages/workflow-engine/src/engine/runWorkflow.ts`、`packages/workflow-engine/src/engine/context.ts`——创建 `EngineContext`，装配 `Semaphore`（信号量）、`Budget`（预算控制器）、Journal（调用结果日志）、`AbortSignal`（中止信号）和递归深度。
> - **恢复与资源控制**：`packages/workflow-engine/src/engine/journal.ts`、`packages/workflow-engine/src/engine/concurrency.ts`、`packages/workflow-engine/src/engine/budget.ts`——分别负责调用 key、并发许可和 token 预算。
> - **Agent 接缝**：`packages/workflow-engine/src/agentAdapter.ts`、`src/workflow/registry.ts`、`src/workflow/backends/claudeCodeBackend.ts`——把通用 `AgentAdapter` 接到 Claude Code 的 `runAgent`。
> - **任务与取消**：`src/workflow/ports.ts`、`src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts`——将 `runId` 注册为 `local_workflow` 后台任务，并把 Workflow 或单 Agent 的 abort 传回执行器。
> - **进度与回流**：`src/workflow/progress/bus.ts`、`src/workflow/progress/store.ts`、`src/workflow/persistence.ts`、`src/workflow/notifications.ts`——把 `ProgressEvent` 分发给面板、`state.json` 持久化和 `task-notification` 通知。
> - **工具注册边界**：`src/tools.ts`、`src/constants/tools.ts`、`src/skills/bundled/ultracode.ts`——决定 Workflow Tool 是否暴露，以及使用场景中的并发和安全约束。
>
> **一次 run 的调用关系**：
>
> ```text
> Workflow Tool / WorkflowService.launch()
>   ↓
> taskRegistrar.register()
>   ↓
> LocalWorkflowTask + runId + AbortSignal
>   ↓
> workflow-engine.runWorkflow()
>   ├─ parseScript()
>   ├─ createEngineContext()
>   ├─ makeHooks()
>   └─ ParsedScript.execute()
>          ↓
>   AgentAdapterRegistry → claudeCodeBackend → runAgent
>          ↓
>   ProgressBus → ProgressStore / state.json / notification bridge
> ```

## 先给结论

普通 Agent loop（Agent 循环）是概率性的：

```text
模型决定下一步
  ↓
调用工具
  ↓
读取结果
  ↓
模型再次决定下一步
```

它适合探索、改计划和临场判断。

Workflow 则把“步骤结构”提前写进脚本：

```text
脚本定义编排结构
  ↓
agent() 执行单个子任务
  ↓
parallel() 或 pipeline() 扩展多个子任务
  ↓
 Journal（调用结果日志）记录每次调用结果
  ↓
失败、恢复、限流和预算由引擎统一处理
```

因此 Workflow 不是“另一个更聪明的 Agent”，而是一层确定性编排器：

> 模型负责提出或生成工作流结构；Workflow engine（工作流引擎）负责按照这份结构执行、恢复和治理。

它适合：

- 多角度调研后统一汇总；
- 对一组文件执行相同的检查流程；
- 先发现，再验证，再生成报告；
- 需要跨较长时间运行并支持 resume（恢复运行）的批处理。

它不适合所有任务。

如果任务需要根据中间结果持续改写计划，普通 Agent loop 往往更自然。Workflow 越确定，恢复和批量执行越可靠；但临场调整空间也越小。

## 一、先分清 Workflow 与相邻系统

### 1.1 与普通 Agent loop 的区别

| 对比项 | 普通 Agent loop | Workflow |
| --- | --- | --- |
| 下一步由谁决定 | 模型在每回合重新决定 | 脚本结构预先决定 |
| 失败处理 | 通常回到模型重新判断 | 引擎提供 retry（重试）、dead（终止结果）、null 等协议 |
| 并发模型 | 由工具和 Agent 策略决定 | `parallel`/`pipeline` 加信号量 |
| 恢复方式 | 依赖会话历史和状态 | Journal 按调用 key 回放 |
| 适合场景 | 探索、改计划、临场决策 | 固定结构的批处理和编排 |

Workflow 中当然仍然会调用 Agent。

区别在于：

```text
普通 loop：Agent 决定“下一步做什么”
Workflow：脚本决定“哪些 Agent、以什么结构运行”
```

### 1.2 与 `cc-21` 后台任务框架的区别

`cc-21` 讲的是后台执行器的公共生命周期：

```text
注册任务 → running → 输出/进度 → 完成/失败 → 通知 → 回收
```

本篇的 Workflow engine 运行在这个生命周期之上：

```text
Workflow run
  ↓
LocalWorkflowTask 负责 UI 和取消
  ↓
workflow-engine 负责脚本、Agent 编排和 Journal
```

所以：

- `LocalWorkflowTask` 是后台任务框架中的一个执行器；
- `runWorkflow()` 是这个执行器内部真正推进工作流的引擎；
- `runId` 标识 Workflow run；
- `taskId` 标识任务面板中的运行时任务。

### 1.3 与共享任务清单的区别

Workflow 的 `agent()` 调用不是共享待办事项，也不依赖某一篇文章才能成立。

```text
Workflow：运行一次编排脚本
任务清单：记录一条待办及其 owner/status
```

Workflow 可以让多个 Agent 去更新共享任务清单，但两套系统的生命周期和存储仍然独立。

### 1.4 与 `cc-23` 定时任务的区别

本篇回答：

```text
一次 Workflow run 如何执行？
```

下一篇回答：

```text
什么时候触发一次新的 query 或 Workflow？
```

定时任务是时间驱动入口，Workflow 是被调用后的确定性执行器。

## 二、一次 Workflow run 的全景

先看主线程调用 Workflow Tool 的真实路径。

```text
用户明确要求使用 Workflow
  ↓
模型调用 Workflow tool
  ↓
src/workflow/wiring.ts
  └─ createWorkflowToolCore()
       └─ getWorkflowService().ports
            └─ createWorkflowTool(ports)
  ↓
packages/workflow-engine/src/tool/WorkflowTool.ts
  ├─ resolve script / named workflow / scriptPath
  ├─ parseScript 快速校验
  ├─ ports.taskRegistrar.register()
  ├─ void runWorkflow(...)
  └─ 立即返回 runId
```

这里有一个很容易写错的地方：

> 主线程的 Workflow Tool descriptor 会直接使用共享 `ports` 登记任务并启动 `runWorkflow()`，并不是所有入口都先调用 `WorkflowService.launch()`。

Tool 入口的关键代码可以压缩成下面几步：

```ts
// packages/workflow-engine/src/tool/WorkflowTool.ts
const { runId, signal } = ports.taskRegistrar.register(
  {
    workflowName,
    // resume 时复用原来的 runId，否则使用新生成的 runId。
    ...(input.resumeFromRunId ? { runId: input.resumeFromRunId } : {}),
  },
  host.handle,
)

// 后台执行，不阻塞当前 Tool 回合；结束后再回写任务状态。
void runWorkflow({
  script,
  args: input.args,
  runId,
  ports,
  host,
  signal,
  cwd: host.cwd,
  budgetTotal: host.budgetTotal,
  ...(input.resumeFromRunId ? { resume: true } : {}),
})
  .then(result => onFinish(ports, result, runId))
  .catch(error => ports.taskRegistrar.fail(runId, error.message))
```

所以 Tool 返回的 `runId` 是“后台运行句柄”，不是最终结果；最终结果通过进度状态和 `task-notification` 回流。

`WorkflowService.launch()` 是另一条入口，主要被 Workflow 面板和命令侧使用：

```text
/workflows 或其他 UI 入口
  ↓
src/workflow/service.ts
  ├─ resolveSource()
  ├─ parseScript()
  ├─ ports.taskRegistrar.register()
  ├─ void runWorkflow(...)
  └─ 立即返回 runId
```

两条入口共享同一组：

- `WorkflowPorts`
- `AgentAdapterRegistry`
- `ProgressBus`
- `ProgressStore`
- `JournalStore`
- `TaskRegistrar`

### 2.1 引擎内部的主链路

```text
runWorkflow()
  ↓
parseScript()
  ↓
createEngineContext()
  ├─ Semaphore
  ├─ Budget
  ├─ agentIdSeq
  ├─ Journal
  └─ AbortSignal
  ↓
makeHooks()
  ├─ agent()
  ├─ parallel()
  ├─ pipeline()
  ├─ phase()
  ├─ log()
  └─ workflow()
  ↓
ParsedScript.execute()
  ↓
ProgressEvent
  ├─ ProgressStore
  ├─ state.json
  ├─ Workflow Panel
  └─ task-notification
```

## 三、Workflow Tool 暴露了什么

`workflowInputSchema` 定义了外部输入。

```ts
// packages/workflow-engine/src/tool/schema.ts
export const workflowInputSchema = z.object({
  script: z.string().optional(),
  name: z.string().optional(),
  scriptPath: z.string().optional(),
  args: z.unknown().optional(),
  resumeFromRunId: z.string().optional(),
  description: z.string().optional(),
  title: z.string().optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
})
```

### 3.1 三种脚本来源

#### Inline script

直接把脚本放入 `script`：

```text
适合一次性编排
  ↓
WorkflowTool 读取内存字符串
  ↓
同时持久化为 .claude/workflow-runs/<runId>/script.js
```

持久化脚本后，用户可以查看文件、修改脚本，再通过 `scriptPath + resumeFromRunId` 继续迭代。

#### Named workflow

通过 `name` 查找：

```text
<project-root>/.claude/workflows/<name>.ts
<project-root>/.claude/workflows/<name>.js
<project-root>/.claude/workflows/<name>.mjs
```

解析优先级是：

```text
.ts → .js → .mjs
```

#### `scriptPath`

直接读取已有脚本文件。

这条路径适合已经沉淀为文件的工作流，也适合 resume 后反复调整。

### 3.2 `args` 是脚本参数，不是字符串协议

`args` 会原样注入脚本。

推荐：

```js
// Workflow tool input
args: {
  files: ['src/a.ts', 'src/b.ts'],
  mode: 'review',
}
```

脚本中直接使用：

```js
const files = args.files
const mode = args.mode
```

不要把对象主动序列化成 JSON 字符串。

当前 `WorkflowTool` 仍有 `normalizeArgs()` 兼容旧调用方：如果收到的字符串可以解析成对象或数组，会尝试还原；但这只是兼容逻辑，不应当成为脚本调用约定。

### 3.3 并发参数

默认每个 Workflow run 使用 3 个并发槽位：

```text
DEFAULT_MAX_CONCURRENCY = 3
MAX_CONCURRENCY_CAP = 16
```

`maxConcurrency` 只影响一个 run，不会改变全局所有 Workflow。

并发数越大，吞吐可能越高，但 API rate limit、连接数、token 消耗和本地资源压力也会同步上升。

## 四、脚本不是 ESM 模块

这是 Workflow 最容易导致脚本失败的地方。

### 4.1 引擎如何装配脚本

`parseScript()` 会把脚本体交给 `AsyncFunction`：

```ts
// packages/workflow-engine/src/engine/script.ts
fn = new AsyncFunction(
  'agent',
  'parallel',
  'pipeline',
  'phase',
  'log',
  'workflow',
  'args',
  'budget',
  'Date',
  'Math',
  body,
)
```

这意味着：

- 脚本体运行在一个异步函数中；
- 可以直接使用 `await`；
- `agent`、`parallel`、`pipeline` 等不是 import 进来的；
- `args` 和 `budget` 也是引擎注入的参数；
- TypeScript 不会经过编译。

下面的脚本是错误的：

```ts
import { something } from './helper'

const result: string = await agent('...')
```

下面才是正确形态：

```js
export const meta = {
  name: 'review-files',
  description: 'Review a group of source files',
}

const result = await agent('Review the target files and return findings')
return result
```

### 4.2 `meta` 必须是纯字面量

脚本可以包含一个：

```js
export const meta = {
  name: 'review-files',
  description: 'Review a group of source files',
  phases: [
    { title: 'Scan', detail: 'Find candidate files' },
    { title: 'Verify', detail: 'Check each finding' },
  ],
}
```

`extractMeta()` 会：

1. 找到 `export const meta =`；
2. 通过括号匹配提取对象；
3. 用无参数 `Function` 计算字面量；
4. 校验 `name` 和 `description`；
5. 从真正执行的脚本体中移除这段声明。

因此 `meta` 中不能引用变量、调用函数、展开对象或插入模板字符串。

### 4.3 语法检查与确定性检查

`assertScriptBody()` 会明确拒绝：

- 静态 `import`；
- 动态 `import(...)`；
- 额外的 `export`；
- `export default`。

错误会在任务进入后台前返回给模型，而不是启动一个必然失败的后台 run。

### 4.4 `Date` 和 `Math.random()` 为什么被替换

恢复要求同一份脚本在相同 Journal 前缀下能重新走到相同调用序列。

如果脚本使用：

```js
const now = Date.now()
const n = Math.random()
```

恢复时调用参数可能改变，Journal key 也会改变，前面已经完成的步骤无法稳定命中。

因此脚本中的运行时对象被替换：

```text
Date.now()              → 抛出 NonDeterministicError
new Date()              → 抛出 NonDeterministicError
Math.random()           → 抛出 NonDeterministicError
new Date(timestamp)     → 允许
Date.parse / Date.UTC   → 保留
```

需要时间戳或随机种子时，应通过 `args` 显式传入。

### 4.5 这不是安全沙箱

脚本检查的主要目标是：

```text
让 resume 可预测
让常见语法错误更容易定位
```

它不是隔离恶意代码的安全边界。

Workflow 脚本与当前运行进程处在同一个信任级别，不能把拦截 `import` 理解成完整沙箱。

## 五、Hook（脚本注入函数）：脚本如何表达编排

引擎通过 `makeHooks()` 注入六个行为入口：

| Hook（脚本注入函数） | 作用 |
| --- | --- |
| `agent()` | 执行一个子 Agent |
| `parallel()` | 并发执行一批 thunk，并等待整批结束 |
| `pipeline()` | 每个 item 独立经过多 stage |
| `phase()` | 开始一个展示阶段 |
| `log()` | 发出进度日志 |
| `workflow()` | 执行一层子工作流 |

### 5.1 `agent()`：最小执行单元

一个最简单的调用：

```js
const result = await agent(
  '检查 src/utils 中与缓存相关的实现，并返回三个风险点',
  {
    label: 'cache-review',
    phase: 'Review',
  },
)
```

返回值有三种引擎语义：

```text
kind = ok      → 返回 output
kind = skipped → 返回 null
kind = dead    → 返回 null
```

脚本通常需要过滤空结果：

```js
const results = await parallel([
  () => agent('Review module A'),
  () => agent('Review module B'),
  () => agent('Review module C'),
])

const validResults = results.filter(Boolean)
```

`null` 不代表整个 Workflow 失败，而是表示这一项没有可用结果。

### 5.2 `parallel()`：有 barrier 的并发

`parallel()` 接收一组 thunk（延迟执行函数）：

```js
const findings = await parallel([
  () => agent('从安全角度检查'),
  () => agent('从性能角度检查'),
  () => agent('从测试角度检查'),
])

// 这里一定等三项都完成后才继续
return await agent(`综合这些结果：${JSON.stringify(findings)}`)
```

它是 barrier（屏障）：

```text
启动 A、B、C
  ↓
等待 A、B、C 全部结束
  ↓
下一步
```

单个 thunk 抛错时，`parallel()` 会记录 warning 并把该项转成 `null`，不会因此拒绝整批结果。

适合：

- 后续步骤必须同时看到全部结果；
- 需要跨 item 去重、比较或汇总；
- 只有在完整结果集确定后才能决定是否继续。

### 5.3 `pipeline()`：每个 item 独立推进

```js
const reports = await pipeline(
  files,
  async (previous, file, index) => {
    return await agent(`分析文件 ${file}`, {
      label: `scan-${index}`,
      phase: 'Scan',
    })
  },
  async (previous, file, index) => {
    return await agent(`验证 ${file} 的分析结果：${JSON.stringify(previous)}`, {
      label: `verify-${index}`,
      phase: 'Verify',
    })
  },
)
```

它的调度形态是：

```text
item A: stage 1 → stage 2 → stage 3
item B: stage 1 → stage 2 → stage 3
item C: stage 1 → stage 2 → stage 3
```

A 不需要等待 B 的 stage 1 完成。

因此：

- `parallel()` 是“先收齐，再继续”；
- `pipeline()` 是“每个 item 独立走完整条链”。

工作流手册把 `pipeline()` 作为多阶段批处理的默认选择，只有确实需要跨 item 汇总时才使用 barrier。

### 5.4 `phase()` 和 `opts.phase`

显式调用：

```js
phase('Scan')
```

会发出：

```text
phase_done(上一个阶段)
phase_started(当前阶段)
```

但在 `parallel()` 或 `pipeline()` 中，多个 Agent 可能并发执行，频繁修改全局 `currentPhase` 会产生展示竞争。

这时更适合直接给 `agent()` 传：

```js
agent('...', { phase: 'Verify' })
```

`agent()` 的 `phase` 是进度归属字段，不会依赖全局阶段切换。

面板的 `mergePhases()` 会合并三类阶段：

1. `meta.phases` 声明的阶段；
2. `phase()` 实际发出的阶段；
3. 只出现在 Agent `opts.phase` 中的阶段。

因此脚本即使没有调用 `phase()`，面板仍然可以显示 Agent 归属的阶段。

### 5.5 `workflow()`：一层子工作流

```js
const child = await workflow('verify-all', {
  files: args.files,
})
```

也可以传脚本路径：

```js
const child = await workflow({
  scriptPath: args.childScript,
})
```

父子工作流共享：

- Semaphore；
- Budget；
- Agent 总数计数器；
- Agent ID 序列；
- AbortSignal。

但只允许一层嵌套：

```text
父 Workflow
  └─ 子 Workflow
       └─ 再次 workflow() → WorkflowError
```

这条限制防止一个脚本通过递归不断创建新的 Workflow。

## 六、`agent()` 的真实执行顺序

`packages/workflow-engine/src/engine/hooks.ts` 中的 `agent()` 是全篇最重要的函数。

可以把它拆成九步。

### 第一步：限制总 Agent 数

```ts
// packages/workflow-engine/src/engine/hooks.ts
if (r.agentCountBox.value >= MAX_TOTAL_AGENTS) {
  throw new WorkflowError(
    `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
  )
}
```

当前单次 Workflow 生命周期最多创建：

```text
MAX_TOTAL_AGENTS = 1000
```

它是 runaway loop backstop（失控循环兜底），不是推荐的正常规模。

### 第二步：分配 Agent 序号并计算 Journal key

```ts
const agentId = r.agentIdSeq.value++
const params: AgentRunParams = { prompt, ...opts }
const key = agentCallKey(prompt, params)
```

Journal key 由：

```text
prompt + canonicalParams(params)
```

经过 SHA-256 计算得到。

`canonicalParams()` 会：

- 排除 `label`；
- 排除 `phase`；
- 对剩余字段名排序；
- 再序列化。

这样只调整面板显示文案，不会让缓存失效：

```text
label/phase 改变 → key 不变
prompt/model/schema/agentType 改变 → key 改变
```

### 第三步：优先查 Journal

```ts
if (!ctx.journalInvalidated && ctx.journalIndex < ctx.journal.length) {
  const entry = ctx.journal[ctx.journalIndex]!

  if (entry.key === key) {
    ctx.journalIndex++
    emit({
      type: 'agent_done',
      agentId,
      label,
      phase,
      result: entry.result,
    })
    return resultToOutput(entry.result)
  }

  // 当前调用与历史不一致，从这里开始进入 live 执行
  ctx.journalInvalidated = true
  ctx.journal = ctx.journal.slice(0, ctx.journalIndex)
  await ctx.ports.journalStore.truncate(ctx.runId)
}
```

命中时：

```text
不占 Semaphore
不消耗 Budget
不调用 Agent backend
直接回放历史结果
```

这也是为什么 resume 不应该把所有已完成 Agent 再跑一遍。

### 第四步：等待并发槽位

```ts
const release = await ctx.resources.semaphore.acquire(ctx.signal)
```

默认 3 个槽位。

如果并发已满，后续 Agent 进入等待队列。

如果等待期间 Workflow 被取消，Semaphore 会移除等待者，不消耗一个并发许可，并转成 `WorkflowAbortedError`。

### 第五步：在临界区检查取消和预算

```ts
if (ctx.signal.aborted) {
  throw new WorkflowAbortedError()
}

// 必须在拿到 semaphore 后检查
r.budget.assertCanSpend()
```

预算检查放在 Semaphore 临界区内有一个实际原因：

```text
多个 waiter 同时排队
  ↓
前一个 Agent 消耗 token
  ↓
后一个 Agent 被唤醒
  ↓
必须看到最新 spentTokens
```

如果在排队前检查，多个等待者可能都基于旧余额通过检查，唤醒后一起超支。

### 第六步：检查人工动作

引擎支持读取：

```ts
const pending = ctx.ports.taskRegistrar.pendingAction(ctx.runId)
```

如果返回：

```ts
{ kind: 'skip' }
```

当前 Agent 会发出 `agent_done(kind: 'skipped')` 并返回 `null`。

但需要结合当前集成层理解：

```ts
// src/workflow/ports.ts
pendingAction() {
  return null // v1: skip/retry not wired
}
```

也就是说，engine 已经保留了 skip 协议，但当前 Claude Code wiring 尚未把 `LocalWorkflowTask.pendingAgentAction` 接到这个查询口。

不能把“任务状态里有 pending action 字段”直接写成“当前版本已经可用”。

### 第七步：解析 Agent adapter

生产端的 registry 当前只注册一个默认 adapter：

```ts
// src/workflow/registry.ts
export function buildRegistry(): AgentAdapterRegistry {
  const reg = new AgentAdapterRegistry()
  reg.register(claudeCodeBackend).default('claude-code')
  return reg
}
```

引擎只依赖 `AgentAdapter` 接口，不关心具体是：

- Claude Code 的 `runAgent`；
- 第三方模型 adapter；
- 本地模型；
- 测试 mock。

路由规则可以按：

- `agentType`；
- `model` 前缀；
- 自定义匹配函数。

当前版本实际默认落到 `claude-code`。

### 第八步：执行、进度和重试

引擎把 `runId`、数字型 `agentId`、进度回调和 Abort 注册函数传给 adapter：

```ts
const adapterCtx = {
  host: ctx.host,
  signal: ctx.signal,
  runId: ctx.runId,
  agentId,
  onProgress,
  registerAgentAbort,
  unregisterAgentAbort,
}

const result = await adapter.run(params, adapterCtx)
```

如果 adapter 返回 `dead`，或者 backend 抛出普通异常，engine 会自动再尝试一次。

但以下情况不应重试：

- `WorkflowAbortedError`：这是用户主动取消；
- adapter 配置错误，例如找不到 adapter：在执行重试块外直接抛出；
- 预算耗尽：应终止当前 run，而不是重复尝试。

重试仍然失败时：

```text
单个 Agent → kind: dead
hooks.agent() → null
Workflow 继续处理其他 item
```

### 第九步：记录结果并释放资源

```ts
if (result.kind === 'ok') {
  ctx.resources.budget.addOutputTokens(result.usage.outputTokens)
}

emit({ type: 'agent_done', agentId, label, phase, result })

const entry = {
  key,
  seq: agentId,
  result,
}

ctx.journal.push(entry)
ctx.journalIndex++
await ctx.ports.journalStore.append(ctx.runId, entry)

release()
```

Budget 只对最终成功结果增加 output token。

`dead` 不重复计费，重试成功也只在最终成功时计一次。

## 七、Journal：恢复不是重新运行

### 7.1 存储格式

默认 Journal 文件位于：

```text
<project-root>/.claude/workflow-runs/<runId>/journal.jsonl
```

每一行是一个 `JournalEntry`：

```ts
type JournalEntry = {
  key: string
  seq: number
  result: AgentRunResult
}
```

并发完成顺序不等于调用顺序。

例如：

```text
调用顺序：A(seq=0) → B(seq=1) → C(seq=2)
完成顺序：B → C → A
```

文件追加顺序可能是 B、C、A，但 `read()` 会按 `seq` 排序，恢复时仍按 A、B、C 比较 key。

### 7.2 三种 resume 情况

#### 相同脚本、相同参数

```text
当前 key = 历史 key
  ↓
Journal hit
  ↓
直接返回历史结果
```

#### 脚本内容改变

`WorkflowService` 或 Workflow Tool 传入 `scriptChanged` 的场景会先截断 Journal。

之后所有调用都重新执行。

#### 中途终止

```text
Journal 已保存 A、B
C 执行到一半被终止
  ↓
resume
  ↓
A、B 命中
C 重新执行
```

这不是对 Agent transcript 的盲目重放，而是对“每次 `agent()` 调用结果”的结构化重放。

### 7.3 divergence：从第一个不一致点截断

如果当前 key 与 Journal 当前项不一致：

```text
保留 divergence 之前的前缀
删除 divergence 之后的历史
从当前调用开始 live 执行
```

这样前面仍然有效的调用不会被白白重跑。

例如：

```text
历史：[k0, k1, k2, k3]
当前：[k0, k1, new-k2, ...]
结果：保留 k0、k1，从 new-k2 开始重跑
```

### 7.4 `dead` 也会进入 Journal

`dead` 结果同样会写入 Journal。

因此 resume 再次遇到相同 key 时，可能直接得到 `null`，不会自动重试。

如果确实要让失败步骤重新执行，需要改变调用语义，例如修改 prompt 或相关参数，使 key 发生变化并触发 divergence。

这是一个需要在文章中明确说明的反直觉行为：

> Journal 保存的是“这次调用已经得到过什么结果”，而不只保存成功结果。

## 八、并发控制：不是把所有 Agent 同时放出去

### 8.1 Semaphore 的行为

```ts
// packages/workflow-engine/src/engine/concurrency.ts
export class Semaphore {
  private available: number
  private readonly waiters: Array<{
    wake: () => void
    cleanup: () => void
  }> = []
}
```

调用方拿到一个 `release()`：

```text
acquire()
  ↓
拿到许可
  ↓
执行 Agent
  ↓
release()
  ↓
直接唤醒下一个 waiter
```

释放时如果有等待者，许可直接转交给它；只有没有等待者时，`available` 才增加。

这样许可总数不会因为排队转移而错误增加。

### 8.2 三个并发边界

| 边界 | 默认值 | 作用 |
| --- | ---: | --- |
| `DEFAULT_MAX_CONCURRENCY` | 3 | 一个 Workflow 的默认并发槽位 |
| `MAX_CONCURRENCY_CAP` | 16 | 用户输入的硬上限 |
| `MAX_ITEMS_PER_CALL` | 4096 | 单次 `parallel`/`pipeline` 的 item 数量上限 |

还有一个生命周期级别的：

```text
MAX_TOTAL_AGENTS = 1000
```

它限制整个 Workflow run，而不是单次 `parallel()`。

### 8.3 `parallel` 和 `pipeline` 仍受同一 Semaphore 限制

传入 100 个 item 不等于同时启动 100 个 backend。

```text
parallel/pipeline 的逻辑集合：最多 4096 个 item
实际同时执行的 Agent：默认最多 3 个
```

这两个上限分开存在：

- item cap 防止一次调用构造过大的 Promise 集合；
- semaphore 防止真实 backend 并发失控。

## 九、预算：控制 token 成本

### 9.1 Budget 的数据模型

```ts
// packages/workflow-engine/src/engine/budget.ts
export class Budget {
  private spentTokens = 0

  constructor(readonly total: number | null) {}

  spent(): number {
    return this.spentTokens
  }

  remaining(): number {
    return this.total == null
      ? Infinity
      : Math.max(0, this.total - this.spentTokens)
  }

  addOutputTokens(n: number): void {
    if (n > 0) this.spentTokens += n
  }

  assertCanSpend(): void {
    if (this.total != null && this.spentTokens >= this.total) {
      throw new BudgetExhaustedError()
    }
  }
}
```

### 9.2 当前集成中的预算状态

引擎接口已经支持预算：

```text
budget.total
budget.spent()
budget.remaining()
```

但当前 Claude Code 的 host wiring 中：

```ts
budgetTotal: null
```

表示默认不限额。

这不是引擎没有预算机制，而是当前集成尚未从 settings 或用户输入注入一个具体上限。

### 9.3 预算检查和预算扣除不是一回事

执行前：

```text
assertCanSpend()
```

只判断是否已经达到上限。

执行成功后：

```text
addOutputTokens(result.usage.outputTokens)
```

才把本次输出 token 加入累计值。

因此预算不是精确的“预估剩余 token”，而是一个执行前硬闸门加执行后累计器。

## 十、Claude Code backend：Workflow 如何真正调用 Agent

### 10.1 Adapter 是解耦点

Workflow engine 的 `AgentAdapter` 接口只要求：

```ts
interface AgentAdapter {
  readonly id: string
  readonly capabilities: AgentAdapterCapabilities
  run(
    params: AgentRunParams,
    ctx: AgentAdapterContext,
  ): Promise<AgentRunResult>
}
```

引擎不会直接 import Claude Code 的 `runAgent`。

这让 engine 可以被测试 mock 或其他 provider adapter 复用。

当前生产 registry 只有：

```text
claude-code
```

但扩展点已经存在。

### 10.2 Agent definition 解析

`claudeCodeBackend` 根据 `params.agentType` 从当前 session 的 active agent definitions 中查找。

```text
agentType 命中 Explore
  ↓
使用 Explore definition

agentType 未提供或未命中
  ↓
回退到 workflow-worker
```

回退定义是 `WORKFLOW_AGENT`，它使用 workflow 子 Agent 的系统提示和工具池。

### 10.3 Workflow Agent 与普通 Agent 的工具边界

Workflow backend 会：

1. 读取当前主会话的 `toolUseContext`；
2. 根据 Agent definition 选择权限模式；
3. 组装可用工具池；
4. 调用共享的 `runAgent`；
5. 把结果转换成 `AgentRunResult`。

Workflow 子 Agent 不能递归调用 Workflow Tool。

`ALL_AGENT_DISALLOWED_TOOLS` 在 feature 开启时把 Workflow Tool 加入禁用集合：

```ts
// src/constants/tools.ts
...(feature('WORKFLOW_SCRIPTS')
  ? [WORKFLOW_TOOL_NAME]
  : []),
```

这是工具层的第一道防线。

engine 的 `workflow()` 一层嵌套限制是第二道防线。

### 10.4 schema 输出的真实实现

当 `agent()` 传入 `schema` 时，当前 Claude Code backend 会把 JSON 输出要求追加到 Agent prompt：

```text
After completing the task, emit your final answer as a single JSON object
matching this JSON Schema.
```

随后从最终文本中提取一个 plain object（普通对象）：

1. 优先尝试 fenced code block；
2. 再扫描文本中的平衡 `{ ... }`；
3. JSON 解析失败则返回 `dead`；
4. 没找到对象则返回 `dead`，原因是 `no-structured-output`。

这里要注意当前实现的实际行为：

> 这条 backend 路径不是要求 Agent 调用一个 `StructuredOutput` 工具，而是要求最终文本包含 JSON 对象，再由 adapter 解析。

因此文章和示例不应把 Workflow schema 输出写成“必然调用 StructuredOutput 工具”。

### 10.5 worktree 隔离

如果 `agent()` 传入：

```js
{ isolation: 'worktree' }
```

backend 会：

```text
创建独立 git worktree
  ↓
通过 cwd override 让工具在 worktree 中运行
  ↓
Agent 完成
  ↓
检测是否有改动
  ├─ 没有改动 → 自动移除 worktree
  └─ 有改动或检测失败 → 保留并记录路径
```

创建 worktree 失败时是 fail-closed（失败即关闭）：

```text
不偷偷退回共享目录
直接返回 dead(worktree-failed)
```

这样可以避免多个并发 Agent 在同一工作目录中互相覆盖。

## 十一、取消：Workflow run 与单个 Agent 两个层级

### 11.1 取消整个 Workflow

调用链：

```text
Workflow Panel 按 x / 任务停止
  ↓
taskRegistrar.kill(runId)
  ↓
LocalWorkflowTask.killWorkflowTask()
  ↓
abortController.abort()
  ↓
ctx.signal.aborted
  ↓
WorkflowAbortedError
  ↓
run_done(status = killed)
```

`claudeCodeBackend` 还会把父级 `ctx.signal` 转接到 Agent 自己的 `AbortController`：

```ts
const agentAbort = new AbortController()

const onParentAbort = (): void => {
  agentAbort.abort()
}

ctx.signal.addEventListener('abort', onParentAbort, { once: true })
```

这样取消 Workflow 时，底层 `runAgent` 的 fetch 和工具循环也能真正停止。

如果只更新任务状态、不把 signal 传到底层，UI 会显示 killed，但 Agent 仍可能继续运行。

### 11.2 只取消某个 Agent

引擎为每次 `agent()` 调用传入数字型 `agentId`。

backend 启动 Agent 后，通过：

```text
registerAgentAbort(runId, agentId, agentAbort)
```

把 controller 放入 `agentAbortControllers`。

当 backend 已通过 `registerAgentAbort()` 注册当前 Agent 的 `AbortController` 后，面板才可以精确停止单个 Agent：

```text
service.killAgent(runId, agentId)
  ↓
ports.taskRegistrar.killAgent()
  ↓
只 abort 对应 Agent
  ↓
该 Agent 返回 dead/null
  ↓
Workflow 继续运行其他 item
```

这与终止整个 Workflow 是两个不同粒度的控制面。

当前 `createWorkflowPorts()` 的 fallback（兜底）`agentRunner` 会直接抛错，正常生产路径必须使用 `AgentAdapterRegistry`。因此，单 Agent 停止依赖“backend 已启动并注册 controller”这一前提；如果运行时没有对应绑定，`killAgent()` 会返回 `false`，不会凭空创建一个可取消对象。

### 11.3 Abort 不应该被当成普通失败

backend 捕获底层 `AbortError` 后，会重新抛出 `WorkflowAbortedError`。

如果不转换：

```text
AbortError
  ↓
hooks.agent() 认为是普通异常
  ↓
自动 retry
  ↓
用户明明点了停止，任务却又跑起来
```

所以 abort 必须保留为“用户意图”，不进入普通 retry 路径。

## 十二、进度回流：一个事件，多处消费

### 12.1 ProgressEvent

engine 只发事件，不直接依赖 React、磁盘或消息队列。

事件包括：

```text
run_started
phase_started
phase_done
agent_started
agent_progress
agent_done
log
run_done
```

每个事件都带 `runId`，使多个并发 Workflow 可以在同一个进程中路由到各自的运行记录。

### 12.2 ProgressBus

```ts
// src/workflow/progress/bus.ts
export function createProgressBus(): ProgressBus {
  const listeners = new Set<(event: ProgressEvent) => void>()

  return {
    emit(event) {
      for (const fn of listeners) {
        fn(event)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

它是进程内广播器。

当前订阅者至少包括：

```text
ProgressStore
Telemetry（遥测）
RunStatePersistence
Workflow notification bridge
```

### 12.3 ProgressStore

`ProgressStore` 把事件 reduce（归并）成 `RunProgress`：

```text
ProgressEvent
  ↓
RunProgress
  ├─ 当前阶段
  ├─ Agent 列表
  ├─ tokenCount
  ├─ toolCount
  ├─ returnValue
  └─ error/status
```

面板通过 `useSyncExternalStore` 订阅 store。

`log` 事件只写日志，不会导致面板快照重建，因为面板没有单独的 log 列表。

### 12.4 `state.json` 持久化

终态 run 会写入：

```text
<project-root>/.claude/workflow-runs/<runId>/state.json
```

写入采用：

```text
write state.json.tmp
  ↓
rename state.json.tmp → state.json
```

这样可以原子替换终态快照。

持久化是 best-effort（尽力而为）：

- 写失败只记录 warning；
- 不反向让已经完成的 Workflow 变成失败；
- 读取损坏的 `state.json` 时跳过该 run；
- 目录中最多保留 50 个 run；
- 面板启动时最多加载最近 20 个。

历史 run 仍可通过 `getRunAsync(runId)` 从磁盘查询。

### 12.5 完成通知

`src/workflow/notifications.ts` 订阅 service 状态：

```text
running → completed/failed/killed
  ↓
构造 <task-notification>
  ↓
enqueuePendingNotification()
  ↓
主 Agent loop 在回合间隙消费
```

通知示意：

```xml
<task-notification>
  <task-id>workflow-run-id</task-id>
  <task-type>local_workflow</task-type>
  <status>completed</status>
  <summary>Workflow "review-files" completed successfully</summary>
</task-notification>
```

这部分复用了 [21 后台任务框架](cc-21-background-task-framework.md) 的通知回注机制。

本篇只需要记住：

```text
Workflow engine 发 run_done
  ↓
ProgressStore 更新终态
  ↓
notification bridge 观察到状态变化
  ↓
command queue 通知主循环
```

核心判断是“状态发生变化，并且新状态已经进入终态”：

```ts
// src/workflow/notifications.ts
if (prev !== run.status && TERMINAL_STATUSES.has(run.status)) {
  // 只有 running → completed/failed/killed 才发送一次完成通知。
  notify(buildMessage(run))
}
```

因此，`ProgressStore` 负责保存当前状态，`src/workflow/notifications.ts` 负责把状态变化翻译成外部消息；两者不是同一个职责。

## 十三、完整示例：调研、验证、汇总

下面是一份符合当前脚本模型的 JavaScript：

```js
export const meta = {
  name: 'research-report',
  description: 'Parallel research and verification',
  phases: [
    { title: 'Research', detail: 'Collect independent views' },
    { title: 'Verify', detail: 'Check each claim' },
    { title: 'Synthesize', detail: 'Produce the final report' },
  ],
}

const topics = args.topics

// 只有需要把所有角度放在一起去重时，才使用 barrier。
const perspectives = await parallel(
  topics.map(topic => () =>
    agent(`从独立角度研究：${topic}`, {
      phase: 'Research',
      schema: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          evidence: { type: 'array' },
        },
        required: ['claim', 'evidence'],
      },
    }),
  ),
)

const validPerspectives = perspectives.filter(Boolean)

// 每条结果独立验证，不需要等待其他 item 的验证完成。
const verified = await pipeline(
  validPerspectives,
  (previous, item, index) =>
    agent(`验证第 ${index} 条研究结果：${JSON.stringify(item)}`, {
      phase: 'Verify',
      label: `verify-${index}`,
    }),
)

const final = await agent(
  `综合以下研究和验证结果，生成最终报告：${JSON.stringify(verified)}`,
  {
    phase: 'Synthesize',
  },
)

return final
```

端到端过程：

```text
Workflow Tool
  ↓
返回 runId
  ↓
parallel 启动多个研究 Agent
  ↓
Semaphore 限制同时运行数量
  ↓
每个 agent() 结果写入 Journal
  ↓
pipeline 对有效结果逐条验证
  ↓
最终 Agent 汇总
  ↓
run_done(completed, returnValue)
  ↓
面板、state.json、task-notification 同步更新
```

如果中途在第二个验证任务时停止：

```text
已完成的研究结果已经在 Journal
  ↓
resumeFromRunId
  ↓
研究阶段命中 Journal
  ↓
从未完成的验证调用继续
```

## 十四、Workflow 的边界

### 14.1 适合 Workflow 的任务

```text
输入集合已知
步骤结构稳定
每个 item 的处理方式相似
中间结果可以结构化传递
需要并发、恢复或统一汇总
```

例如：

- 多目录代码审计；
- 多文件格式迁移；
- 多个独立视角的研究；
- “发现 → 验证 → 汇总”的固定流程。

### 14.2 更适合普通 Agent 的任务

```text
下一步高度依赖模型临场判断
中间结果会改变任务目标
需要频繁询问用户
任务无法预先表达成稳定脚本
```

不要因为“可以并发”就自动使用 Workflow。

当前 `/ultracode` skill 明确要求用户主动选择多 Agent 编排，不能仅仅因为任务看起来适合并行就自行扩大规模。

### 14.3 三个关键局限

#### 结构确定性是有代价的

Journal 依赖 key 和调用顺序稳定。

如果脚本随意使用时间、随机数、动态 import 或不可控外部状态，resume 的可预测性会下降。

#### `dead` 不会在 resume 时自动重跑

因为 dead 也会写入 Journal。

这是“结果可回放”与“失败自动再试”之间的取舍。

#### 当前预算默认没有注入上限

引擎已经提供 Budget，但当前 Claude Code wiring 的 `budgetTotal` 是 `null`。

因此不能把源代码里的预算接口描述成当前用户一定能配置的硬上限。

#### 当前 skip/retry seam（预留接缝）尚未接通

引擎可以读取 `pendingAction`，任务状态也保存 `pendingAgentAction`，但当前 `createWorkflowPorts()` 返回的 `pendingAction()` 恒为 `null`。

源码中存在接口，不等于完整用户流程已经接通。

## 十五、几个容易写错的判断

### 15.1 不要把 Workflow 写成“后台 bash 的另一种形式”

Workflow 会使用 `LocalWorkflowTask` 进入后台任务框架，但真正的核心是：

```text
脚本执行 + Agent 编排 + Journal + 进度事件
```

### 15.2 不要把 `parallel()` 和 `pipeline()` 当成同义词

```text
parallel：整批 barrier
pipeline：每个 item 独立推进
```

这个差异直接影响等待时间和吞吐。

### 15.3 不要说所有失败都会让整个 Workflow 失败

单个 Agent backend 失败通常转为：

```text
dead → null → 其他 item 继续
```

但以下错误可能终止整个 run：

- 脚本语法错误；
- Journal/脚本结构发生不可恢复错误；
- 预算耗尽；
- Workflow 嵌套超过一层；
- item 数或 Agent 总数超过上限；
- adapter 配置错误；
- 脚本顶层没有捕获的异常。

### 15.4 不要把脚本检查说成安全沙箱

`assertScriptBody()` 主要维护确定性和错误提示，不提供完整的恶意代码隔离。

### 15.5 不要把 `runId`、engine `agentId` 和 core `AgentId` 混为一谈

源码中至少有三种身份：

| 身份 | 用途 |
| --- | --- |
| `runId` | 标识一次 Workflow run |
| engine `agentId: number` | 标识 `agent()` 调用，关联进度和单 Agent kill |
| core `AgentId: string` | `runAgent` 内部的 Agent 跟踪身份 |

backend 注释明确提醒：这三者不能混用。

## 十六、可复用的工程模式

### 16.1 端口隔离

engine 通过 `WorkflowPorts` 依赖外部能力：

```text
AgentRunner / AgentAdapterRegistry
ProgressEmitter
TaskRegistrar
JournalStore
PermissionGate
Logger
HostFactory
```

核心包不直接依赖 Claude Code 的 AppState、React 或具体模型。

### 16.2 Journal 前缀恢复

不要把整个历史当成一个不可分割的缓存。

按调用顺序记录 key，使得：

```text
前缀命中 → 继续复用
第一个不一致点 → 截断并重新执行后缀
```

这对长批处理特别有价值。

### 16.3 事件总线解耦多个观察者

engine 只发事件，面板、持久化、通知和 telemetry（遥测）各自订阅。

执行逻辑不需要知道 UI 如何渲染，也不需要知道通知如何回注。

### 16.4 失败降级为数据

`dead` 和 `skipped` 变成 `null`，让脚本作者可以用：

```js
results.filter(Boolean)
```

继续处理剩余结果。

这比“一项失败，整批 Promise reject”更适合大规模工作流。

## 总结

Claude Code 的动态 Workflow 可以压缩成四层：

```text
Tool 层
  接收 script/name/scriptPath/args/resume

Service / Task 层
  注册 LocalWorkflowTask，提供取消和 UI 生命周期

Workflow engine 层
  解析脚本，执行 hook，控制 Journal、并发、预算和重试

Backend / Progress 层
  调用真实 Agent，广播进度，持久化结果并通知主循环
```

一次 run 的核心路径是：

```text
脚本
  ↓
agent()/parallel()/pipeline()
  ↓
Journal hit 或 live backend
  ↓
Semaphore + Budget + AbortSignal
  ↓
AgentRunResult
  ↓
ProgressEvent
  ↓
Panel + state.json + task-notification
```

Workflow 的价值不是把模型换成脚本，而是把“可预先确定的编排结构”从模型回合中拿出来，交给一个可以恢复、限流、观察和取消的运行时。
