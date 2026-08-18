---
slug: /application-notes/engineering/claude-code-cli/cc-25-observability
sidebar_position: 25
title: "可观测性"
description: "Agent 是概率系统加长链路，传统日志失效；本篇拆 trace、指标、transcript 黑匣子与 Langfuse 追踪。"
---

> *Agent 是概率系统加长链路,传统日志失效* —— 六类观测数据各自入口独立、协同还原现场。
>
> **Harness 层定位**：**[02 §三 组件 11 可观测层](../01-architecture-lifecycle/cc-02-harness-design.md)** —— 让 Harness 内部行为可追踪、可排障。

# Claude Code 可观测性机制：日志、埋点、Telemetry、错误上报与 Debug 入口

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。以下路径均相对于源码仓库根目录；正文使用函数名和调用关系定位，不把容易漂移的行号作为唯一依据。
>
> **核心路径**：
>
> - **统一装配和退出**：`src/utils/sinks.ts` 的 `initSinks()`、`src/utils/gracefulShutdown.ts` 的 `gracefulShutdown()`、`gracefulShutdownSync()`——负责初始化 sink（数据出口）并在退出时尽量 flush（冲刷待发送数据）。
> - **Debug 日志**：`src/utils/debug.ts` 的 `isDebugMode()`、`logForDebugging()`、`BufferedWriter`，以及 `src/utils/debugFilter.ts`——负责本地调试日志、类别过滤和写入缓冲。
> - **错误记录与上报**：`src/utils/log.ts` 的 `logError()`、`attachErrorLogSink()`，`src/utils/errorLogSink.ts` 的错误 sink，以及 `src/utils/sentry.ts` 的 `captureException()`、`closeSentry()`——把“先记录”与“后上报”分开。
> - **Analytics 埋点**：`src/services/analytics/index.ts` 的 `logEvent()`、`logEventAsync()`，以及 `src/services/analytics/sink.ts`、`src/services/analytics/datadog.ts`、`src/services/analytics/firstPartyEventLogger.ts`——负责采样、allowlist（允许列表）和多出口路由。
> - **OTel**：`src/utils/telemetry/instrumentation.ts`、`src/utils/telemetry/events.ts` 的 `logOTelEvent()`、`src/utils/telemetry/sessionTracing.ts` 的 `startInteractionSpan()`、`startLLMRequestSpan()`——负责 OpenTelemetry 的 exporter（导出器）、事件和 span（链路片段）。
> - **Langfuse**：`src/services/langfuse/tracing.ts` 的 `createTrace()`、`recordLLMObservation()`、`recordToolObservation()`、`createToolBatchSpan()`、`endTrace()`，以及 `src/services/langfuse/sanitize.ts`——负责单次 Agent 调用树、LLM 成本信息和脱敏。
> - **Transcript 与 Hook**：`src/utils/sessionStorage.ts` 的 `recordTranscript()`、`loadTranscriptFile()`，`src/utils/hooks/hookEvents.ts` 的 `emitHookStarted()`、`emitHookProgress()`、`emitHookResponse()`、`setAllHookEventsEnabled()`——分别服务会话回放和外部事件订阅。
> - **诊断入口**：`src/utils/startupProfiler.ts`、`src/utils/diagLogs.ts`，以及 `src/commands/doctor/doctor.tsx`、`src/screens/Doctor.tsx`——提供启动性能、无 PII 诊断和环境检查。
>
> **一次 query 的观测调用关系**：
>
> ```text
> query / Agent loop
>   ├─ startInteractionSpan()
>   ├─ createTrace()
>   ├─ API request
>   │    ├─ recordLLMObservation()
>   │    └─ logOTelEvent() / OTel span
>   ├─ tool execution
>   │    ├─ recordToolObservation()
>   │    └─ logEvent()
>   ├─ recordTranscript()
>   └─ Hook event bus
>        ├─ emitHookStarted()
>        ├─ emitHookProgress()
>        └─ emitHookResponse()
>   ↓
> local files / in-memory queue / Datadog / 1P / OTel / Langfuse
>   ↓
> gracefulShutdown() → flush remaining events
> ```

> 本文只讨论 Claude Code 的运行时可观测性：本地日志、错误上报、分析埋点、OpenTelemetry、Langfuse，以及用于恢复和排错的 transcript。重点是每条数据从哪里产生、经过什么过滤、落到哪里，以及开发者如何打开对应的入口。
>
> 配套阅读：[Hook 拦截机制](../03-tools-extensions-governance/cc-15-hook-interception.md)、[JSONL Transcript 持久化](cc-24-persistence-and-cache.md) 和 [22 动态工作流](../05-async-orchestration/cc-22-dynamic-workflow.md)。
>
> **配套阅读**：Hook 是本篇 transcript 之外另一个供外部系统订阅 Agent 行为的观测面，其事件模型与执行链路见 [15-hook-interception](../03-tools-extensions-governance/cc-15-hook-interception.md)；transcript JSONL 的存储布局与会话恢复机制在 [24-persistence-and-cache](cc-24-persistence-and-cache.md) 有更完整的持久化视角。下游：workflow run 的 Panel 与 `state.json` 观测（见 [22-dynamic-workflow](../05-async-orchestration/cc-22-dynamic-workflow.md)）复用本篇的观测基础设施。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 先区分六类观测数据——Debug / 错误 / 埋点 / OTel / Langfuse / Transcript 各自的入口与出口 | 必读，全文地图 |
| 二 | Debug 日志——可过滤、可落盘、退出时尽量不丢 | **核心章节** |
| 三 | 错误上报——"记录错误"与"发送错误"解耦 | 必读 |
| 四 | Analytics 埋点——用类型和路由控制数据边界 | 按需，关注数据边界时读 |
| 五 | OpenTelemetry——客户 exporter 与内部事件两条路径 | 按需，配置 OTel 时读 |
| 六 | Langfuse——可选的 Agent/LLM/Tool 调用树 | 选读 |
| 七 | Transcript 与 Hook——用于回放和外部订阅的观测面 | 必读 |
| 八 | Debug 与诊断入口——按症状选择最短路径 | 速查，排障时按需查 |
| 九 | 边界、隐私与运维取舍 | 选读 |

## 一、先区分观测数据，而不是把它们都叫“日志”

> **本文的 Harness 落点是 [02-harness-design](../01-architecture-lifecycle/cc-02-harness-design.md) 组件 11 可观测层**——让 Harness 的内部行为可追踪、可排障、可改进。组件 11 的本质设计要求是：Agent 行为的**事后还原**必须独立于 Agent 本身——后者已经不能解释自己的异常行为。可观测层在 [02 §七.5 映射](../01-architecture-lifecycle/cc-02-harness-design.md#75-失败模式--稳定机制--组件-三层映射) 中是全部 8 失败模式的事后还原载体——`recordLLMObservation` / `recordToolObservation` / Hook trace points 把每一步兜底机制的实际触发情况暴露给 Datadog 与 Langfuse（对应 [02 §四 20 步路径](../01-architecture-lifecycle/cc-02-harness-design.md#四一次完整请求的-harness-路径) 步骤 19）。

### 为什么

一次 Agent 执行同时包含用户输入、LLM 请求、工具调用、网络错误和会话状态。不同问题需要不同粒度的数据：

- **本地即时排错**需要带时间戳和上下文的 debug 日志；
- **错误处理**需要在 sink 尚未初始化时也不丢事件，并能在退出前发送；
- **产品指标**只需要可聚合的事件，不应该把代码和文件内容发送到通用监控后端；
- **Telemetry**需要遵循 OpenTelemetry 的 exporter 配置，服务客户自己的 OTLP 后端；
- **Langfuse**需要 Agent、LLM、Tool 的层级调用树；
- **Transcript**需要可回放，而不只是“看过一眼”的文本。

因此，Claude Code 没有一个统一的 `logger` 解决所有问题，而是把观测拆成独立的 API 和 sink。把它们混用会产生两个直接后果：用高基数埋点代替日志会增加成本，用 transcript 或 Langfuse 代替错误上报又无法保证退出时送达。

### 怎么做

| 通道 | 主要入口 | 默认出口 | 解决的问题 |
|---|---|---|---|
| Debug 日志 | `logForDebugging()` | `~/.claude/debug/<sessionId>.txt` 或 stderr | 当前进程发生了什么 |
| 错误上报 | `logError()` | 内存 FIFO（先进先出队列）、错误 JSONL、Sentry（按条件） | 错误是否被记录和上报 |
| 分析埋点 | `logEvent()` / `logEventAsync()` | Datadog、1P event logging | 功能使用率、错误率、趋势 |
| 客户 Telemetry | `logOTelEvent()`、OTel spans/metrics | 客户配置的 OTLP（OpenTelemetry Protocol）、console、Prometheus；另有内部 BigQuery metrics reader | 客户侧或内部的指标与链路 |
| Langfuse | `createTrace()`、`recordLLMObservation()`、`recordToolObservation()` | Langfuse OTLP processor | 单次 Agent 链路和 LLM 成本/延迟 |
| Transcript | `recordTranscript()`、`loadTranscriptFile()` | `~/.claude/projects/<project-key>/*.jsonl` | resume、rewind、行为回放 |

公共 sink 的装配集中在 `src/utils/sinks.ts` 的 `initSinks()`：先调用 `initializeErrorLogSink()`，再调用 `initializeAnalyticsSink()`。默认命令在 `src/setup.ts` 装配；daemon（后台进程）和其他特殊入口也会在对应 CLI 入口显式装配。业务模块可以先写事件，sink 再通过队列补上。

一次 query 的关键调用关系是：`src/query.ts` 创建和结束 Langfuse trace；`src/services/api/claude.ts` 记录 LLM observation；`src/services/tools/toolExecution.ts` 和 `src/services/tools/toolOrchestration.ts` 记录工具执行结果；工具完成后还会调用 `logEvent('tengu_tool_use_success' | 'tengu_tool_use_error', ...)`。进程退出时，`src/utils/gracefulShutdown.ts` 尝试 flush 1P、Datadog 和 Sentry。

### 实例

排查一次“工具执行很慢且最终失败”的请求时，可以按数据用途分工：

```text
本地实时细节       -> claude --debug=tool
单次调用树/TTFT（首 token 延迟） -> Langfuse trace（若已配置）
聚合错误趋势       -> tengu_tool_use_error 埋点
会话恢复与重放     -> ~/.claude/projects/.../<sessionId>.jsonl
最终异常上报       -> Sentry（SENTRY_DSN 已配置时）
```

下面各章分别说明这些通道的实现，而不是重复描述同一条数据流。

### 6 类观测 × 12 组件映射矩阵

下表把 6 类观测通道交叉 12 个 Harness 组件——空白表示该组件不直接产生该类观测数据，`○` 表示产生本地数据，`●` 表示可被聚合层拉到。

| 组件 ↓ / 观测 → | Debug 日志 | Error sink | Analytics | OTel | Langfuse | Transcript |
|---------------|-----------|------------|-----------|------|----------|------------|
| 1 入口层 | ○（启动 trace） | ○ | ○（启动事件） | | | |
| 2 会话层 | ○ | ○ | ●（会话生命周期） | ● | ● | ○ |
| 3 状态层 | ○ | ○ | | | | |
| 4 循环层（[cc-04](../02-agent-runtime/cc-04-agent-loop.md)） | ●（每轮 trace） | ● | ●（tool_use 计数） | ● | ● | ● |
| 5 上下文层（[cc-06](../02-agent-runtime/cc-06-context-assembly.md)） | ○（cache 命中率） | ○ | | ○ | ○ | |
| 6 工具层（[cc-10](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)） | ●（工具调用全栈） | ● | ●（工具分类统计） | ● | ● | ● |
| 7 权限层（[cc-14](../03-tools-extensions-governance/cc-14-permission-security.md)） | ●（deny/ask 决策） | ○ | ●（deny 比率） | ○ | ○ | ● |
| 8 UI 层（[cc-05](../02-agent-runtime/cc-05-streaming-and-rendering.md)） | ○（render 节流） | | | | | |
| 9 Hook 层（[cc-15](../03-tools-extensions-governance/cc-15-hook-interception.md)） | ●（hook 输入输出） | ● | | | ○ | ● |
| 10 持久化层（[cc-24](cc-24-persistence-and-cache.md)） | ○（append-only 异常） | ○ | | | | ● |
| 11 可观测层（本篇） | — | — | — | — | — | — |
| 12 Provider 适配层（[cc-03](../01-architecture-lifecycle/cc-03-entry-and-lifecycle.md)） | ●（HTTP 重试） | ● | ○ | ● | ● | |

**为什么这张表重要**——当用户报"Agent 卡在某一步"时，先看**循环层**有没有日志（必有），再看**工具层**有没有错误（必有），最后看**权限层**有没有 deny（最常见根因）。三层无异常才需要回放 transcript；没有任何一层观测数据时，要么是组件本身未运行，要么是观测层本身漏数据——后者要先 §八 Debug 入口确认。

## 二、Debug 日志：可过滤、可落盘、退出时尽量不丢

### 为什么

Agent 的很多故障只能从过程细节判断，例如某个 hook 的 stderr、MCP 重连原因、当前 cwd 或 API 重试。普通用户不应该默认承担这些高频写入，但开发者打开 debug 后又希望最后一次失败前的日志一定可见。Claude Code 因此同时提供：

1. 多级过滤，控制信息量；
2. 文件、stderr 和自定义文件路径三种出口；
3. debug 模式下同步写入，避免 `process.exit()` 丢掉最后几行；
4. `/debug` 运行时开启，不必重启当前会话。

### 怎么做

**启用条件。** `src/utils/debug.ts` 的 `isDebugMode()` 用 `memoize` 缓存，以下七类条件任一成立即为 true：

1. `runtimeDebugEnabled`（由 `/debug` 调用 `enableDebugLogging()` 设置）；
2. `DEBUG` 为真值；
3. `DEBUG_SDK` 为真值；
4. 参数包含 `--debug` 或 `-d`；
5. 参数包含 `--debug-to-stderr`；
6. 参数以 `--debug=` 开头；
7. `getDebugFilePath()` 能从 `--debug-file=<path>` 或 `--debug-file <path>` 解析出路径。

CLI 选项定义在 `src/main.tsx`：

```text
-d, --debug [filter]       开启 debug，可带类别过滤
--debug-to-stderr          写 stderr（隐藏帮助项）
--debug-file <path>        写指定文件，并隐式开启 debug
```

`--debug=pattern` 的实际解析在 `src/utils/debug.ts`，再交给 `src/utils/debugFilter.ts`。例如 `api,hooks` 表示包含类别，`!1p,!file` 表示排除类别；混合包含和排除时解析器返回 `null`，等同于不启用过滤。旧的 `--mcp-debug` 仍在 `src/main.tsx`，但已经标记为 deprecated，应使用 `--debug`。

**级别与写入。** `src/utils/debug.ts` 定义 `verbose`、`debug`、`info`、`warn`、`error` 五级；最低级别由 `CLAUDE_CODE_DEBUG_LOG_LEVEL` 决定，默认是 `debug`。`logForDebugging()` 在 `src/utils/debug.ts` 先做级别和类别过滤，再输出：

```text
<ISO timestamp> [LEVEL] <message>
```

当 formatted output 开启且消息含换行时，`src/utils/debug.ts` 中的格式化逻辑会先整体执行 `jsonStringify`，避免破坏逐行格式。`shouldLogDebugMessage()` 还会在测试环境默认抑制日志；普通用户必须开启 debug，`USER_TYPE=ant` 则允许后台记录。

**出口与缓冲。** `src/utils/debug.ts` 的 `getDebugLogPath()` 按以下优先级选择路径（默认配置根是 `~/.claude`，但可由 `CLAUDE_CONFIG_DIR` 改写，见 `src/utils/envUtils.ts`）：

```text
--debug-file <path>
  > CLAUDE_CODE_DEBUG_LOGS_DIR
  > getClaudeConfigHomeDir()/debug/<sessionId>.txt
```

`BufferedWriter` 位于 `src/utils/debug.ts`，缓冲上限 100 条、flush 间隔 1000ms。debug 模式的写入分支使用同步目录创建和追加写入，因为异步写入可能在直接退出时丢失，也可能让 `beforeExit` 与 tracing 互相等待；非 debug 的 ant 路径使用串行 `pendingWrite` Promise 链。退出时由 `flushDebugLogs()` 清理缓冲，默认日志写入后由 `updateLatestDebugLogSymlink()` 更新同目录的 `latest` 符号链接。

**会话内入口。** `/debug` 的实现是 `src/skills/bundled/debug.ts`：

- `enableDebugLogging()` 立即打开当前会话的记录并清除 `isDebugMode` 缓存；
- 只读取日志末尾最多 64 KiB，再展示最后 20 行；
- 用户复现后，Skill 可以继续读取同一文件；
- 该 Skill `disableModelInvocation: true`，必须由用户显式输入，不会被模型自行触发。

### 实例

```bash
# 只看 API 和 hook 相关日志
claude --debug=api,hooks

# 以 verbose 级别捕获高频 shell/cwd/statusLine 信息
CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose claude --debug

# 直接写 stderr，适合容器或脚本
claude --debug-to-stderr

# 写到指定文件
claude --debug-file=/tmp/claude-debug.txt

# 已在会话中时输入 /debug；然后复现问题
# 默认位置：~/.claude/debug/<sessionId>.txt
# 追踪最新文件：tail -f ~/.claude/debug/latest
```

若使用自定义 `--debug-file` 或 `CLAUDE_CODE_DEBUG_LOGS_DIR`，`latest` 位于实际日志文件所在目录，不一定是默认的 `~/.claude/debug/`。

## 三、错误上报：把“记录错误”和“发送错误”解耦

### 为什么

错误可能在启动早期发生，此时重型 sink 尚未加载；也可能发生在进程即将退出时，此时异步网络请求随时会被截断。错误路径不能简单地 `await remoteLogger.send(error)`，否则会同时遇到“初始化时序丢失”和“退出时丢失”两个问题。另一方面，Bedrock、Vertex、Foundry 或用户明确关闭非必要流量时，Claude Code 不应重复上报。

### 怎么做

**入口和短路。** `src/utils/log.ts` 的 `logError(error)` 首先把输入归一化为 `Error`。若启用了 `feature('HARD_FAIL')` 且传入 `--hard-fail`，会在 `logError()` 的 hard-fail 分支直接打印并退出，后续 fanout（扇出到多个出口）不执行。正常路径在以下条件任一成立时返回：

- `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX` 或 `CLAUDE_CODE_USE_FOUNDRY`；
- `DISABLE_ERROR_REPORTING` 已设置；
- `isEssentialTrafficOnly()` 为 true。

**四个逻辑目的地。** 通过短路后，`logError()`（`src/utils/log.ts`）会：

1. 把简化 stack 和时间戳放入最近 100 条的 FIFO 内存日志；
2. sink 未附加时，把原始错误放入 `errorQueue`；
3. sink 已附加时交给 `ErrorLogSink.logError()`；
4. 由 sink 实现分别写 debug、错误文件，并调用 Sentry。

`attachErrorLogSink()`（`src/utils/log.ts`）是幂等的，首次 attach 时**同步** drain `errorQueue`。这保证业务模块无需知道 sink 的初始化时刻。

实际 sink 在 `src/utils/errorLogSink.ts` 初始化，核心实现是 `logErrorImpl()`：

- `logForDebugging(..., {level: 'error'})` 写本地 debug 日志；
- `appendToLog()` 写日期命名的 JSONL 错误文件，但只有 `USER_TYPE=ant` 时才启用这条错误文件路径；
- `captureException(error)` 调用 Sentry，未初始化时是 no-op（空操作）。

Sentry 的入口是 `src/utils/sentry.ts`。只有设置 `SENTRY_DSN` 才初始化；`beforeSend` 删除 `authorization`、`x-api-key`、`cookie`、`set-cookie`，网络连接错误和用户取消类错误由 `ignoreErrors` 过滤，性能 transaction（事务）当前全部丢弃。`captureException()` 和 `closeSentry()` 分别负责记录异常和关闭客户端。

**清理。** `src/utils/gracefulShutdown.ts` 的 `gracefulShutdown()` 先给 cleanup registry（清理任务注册表，包括 debug writer、Langfuse）最多 2000ms，再并行调用 `shutdown1PEventLogging()`、`shutdownDatadog()`、`closeSentry(2000)`，但第二组整体只等待最多 500ms；退出不应被遥远的 Telemetry endpoint 无限阻塞。

### 反向论证：为什么 errorQueue 必须先 in-memory 再 attach sink

如果把错误处理改成"直连 Sentry / Datadog，不做本地缓冲"，会出现两个看似无关但都很严重的 bug：(1) 启动早期 API 错误时 Sentry SDK 尚未初始化（`SENTRY_DSN` 配置或网络握手未完成），错误直接被丢，**用户拿到一个"看似干净的日志"但实际错已经被吞了**；(2) 高频错误洪峰（如 MCP 重连风暴）让 Sentry rate-limit 触发，错误信息半途丢失，**事后无法回放洪峰根因**。`errorQueue.push(error)` 的 in-memory FIFO + attach 时同步 drain，正是为了抗这两种失败——前者是 SDK 不可用窗口，后者是聚合层扛不住瞬间洪峰。

### 实例

```text
启动早期 API 错误
  -> logError(error)
  -> addToInMemoryErrorLog(error)       # 立即可查
  -> errorQueue.push(error)              # sink 尚未就绪
  -> initSinks() / initializeErrorLogSink()
  -> attachErrorLogSink() 同步 drain
  -> debug JSONL +（ant）errors/<date>.jsonl +（有 DSN）Sentry
```

如果问题需要保留错误上下文但不希望发送远程数据，可使用 `DISABLE_ERROR_REPORTING=1`，同时保留本地 debug 入口；注意该开关在 `logError()` 的短路位置，会连内存记录也一起跳过。

## 四、Analytics 埋点：用类型和路由控制数据边界

### 为什么

埋点回答的是“某功能发生了多少次、失败率如何、版本之间是否回归”，不需要也不应该携带完整 prompt、代码或文件内容。Claude Code 同时有通用访问的 Datadog 和受控的 first-party event logging，两者的访问边界不同；因此必须在发送前按字段分流，而不能把同一个 payload 原样复制到两个后端。

### 怎么做

**无重依赖的公共 API。** `src/services/analytics/index.ts` 把业务入口与具体 sink 分开：

- `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` 要求字符串值在调用点显式确认不含代码和路径；
- `AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED` 标记只允许进入受控 proto 列的值；
- `stripProtoFields()` 删除所有 `_PROTO_*` 键；
- `logEvent()` / `logEventAsync()` 接收仅含布尔值、数字和 `undefined` 的普通 metadata；
- sink 未 attach 时，事件进入 `eventQueue`，`attachAnalyticsSink()` 再用 `queueMicrotask`（微任务）异步 drain，避免阻塞启动。

**双 sink 路由。** `src/services/analytics/sink.ts` 的 `logEventImpl()` 顺序是：

```text
shouldSampleEvent(eventName)
  -> 0：丢弃
  -> 正数：附加 sample_rate
  -> null：不采样

shouldTrackDatadog()
  -> true：trackDatadogEvent(stripProtoFields(metadata))

logEventTo1P(eventName, metadata)
  -> 保留 _PROTO_*，由 1P exporter 再映射
```

Datadog gate（功能开关）名为 `tengu_log_datadog_events`；sink killswitch（总开关）在 `src/services/analytics/sinkKillswitch.ts`，GrowthBook 配置 `tengu_frond_boric` 可独立关闭 `datadog` 或 `firstParty`。采样配置 `tengu_event_sampling_config` 的实现位于 `src/services/analytics/firstPartyEventLogger.ts`：缺少配置或采样率为 1 时返回 `null`，0 时返回 `0`，中间值按随机数决定是否发送。

**Datadog 的额外限制。** `src/services/analytics/datadog.ts` 的 `initializeDatadog()`、`trackDatadogEvent()` 和 `flushLogs()` 共同决定：

- `DATADOG_LOGS_ENDPOINT` 和 `DATADOG_API_KEY` 缺一不可，否则完全不初始化；
- 只在 `NODE_ENV === 'production'` 且 `getAPIProvider() === 'firstParty'` 时发送；
- `DATADOG_ALLOWED_EVENTS` 是显式 allowlist（允许列表），不在列表中的事件直接丢弃；
- 默认每 15 秒或满 100 条 flush，网络 timeout（超时）为 5 秒；
- `mcp__...` 工具名规范化为 `mcp`，外部用户的模型名归一化，用户 ID 哈希到 30 个 bucket（分桶），减少高基数；
- `status` 被转换成 `http_status` / `http_status_range`，避开 Datadog 保留字段。

**1P event logging。** `is1PEventLoggingEnabled()`（`src/services/analytics/firstPartyEventLogger.ts`）遵循测试环境、三方 provider 和隐私级别的禁用设置；它本身不检查组织级 metrics opt-out。`initialize1PEventLogging()` 使用独立的 `LoggerProvider`，默认 export interval 10000ms、batch size 200、queue size 8192；动态配置 `tengu_1p_event_batch_config` 可以改 interval、batch、queue、endpoint、auth 和最大重试次数。默认 endpoint 在 `src/services/analytics/firstPartyEventLoggingExporter.ts` 计算为：

```text
Anthropic event logging endpoint（由运行时配置决定）
```

当 `ANTHROPIC_BASE_URL` 是 staging，或 GrowthBook 配置提供 `baseUrl/path` 时会改变。失败事件写入 `${getClaudeConfigHomeDir()}/telemetry/1p_failed_events.<sessionId>.<batchUUID>.json`，下一次进程启动由 `retryPreviousBatches()` 后台重试；重试采用二次退避，默认最多 8 次。认证失败 401 会先按无认证方式再试一次。

转换阶段会把已知 `_PROTO_skill_name`、`_PROTO_plugin_name`、`_PROTO_marketplace_name` 提升到受控 proto 字段，并再次剥离其余 `_PROTO_*`，防止未知未来字段落入普通 `additional_metadata`。

**全局禁用与 Gate。** `src/services/analytics/config.ts` 的 `isAnalyticsDisabled()` 在测试、Bedrock/Vertex/Foundry 或 `isTelemetryDisabled()` 时关闭 analytics。隐私级别由 `src/utils/privacyLevel.ts` 解析：`DISABLE_TELEMETRY` 对应 `no-telemetry`，`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 对应更严格的 `essential-traffic`。GrowthBook 的本地 gate 默认值和缓存读取逻辑位于对应的 GrowthBook 配置模块；读取优先级是 env override、config override、本地 gate、内存远程值、磁盘缓存、默认值。

### 实例

以工具成功事件为例，调用点只发送低基数字段；如果确实需要 PII，必须显式使用 `_PROTO_*`：

```text
业务代码：logEvent('tengu_tool_use_success', metadata)
  -> 普通字段（toolName、duration、error 分类）进入两个 sink
  -> _PROTO_plugin_name 只进入 1P 的受控字段
  -> Datadog 路径先 stripProtoFields，因此看不到该值
  -> 采样时 metadata 增加 sample_rate，便于估算真实事件量
```

这不是“自动发现所有 PII”：埋点类型只约束调用者，Datadog 也不会像 Langfuse 一样递归替换 home 路径。新增埋点时应先决定字段是否需要进入 1P 受控列，而不是事后依赖 sink 猜测。

## 五、OpenTelemetry Telemetry：客户 exporter 与内部事件是两条路径

### 为什么

“Telemetry”在 Claude Code 中至少包含三类数据：metrics（指标）、logs（日志）、traces（链路）。客户需要把它们导出到自己的 OTLP 后端，内部产品事件则需要送到 first-party event logging（第一方事件记录）；两者不能共享全局 logger，否则内部事件可能被发送到客户 endpoint，客户日志也可能被内部管道接收。代码因此为客户 OTel 和 1P analytics 建立了两个 `LoggerProvider`。

### 怎么做

**初始化开关。** `src/entrypoints/init.ts` 的 `doInitializeTelemetry()` 只在 `CLAUDE_CODE_ENABLE_TELEMETRY` 为真时初始化客户 OTel；instrumentation 通过动态 import 延迟加载。`src/utils/telemetry/instrumentation.ts` 的 `bootstrapTelemetry()` 在 `USER_TYPE=ant` 时把 `ANT_OTEL_*` 变量复制到标准 `OTEL_*` 变量。启用客户 OTel 后，`initializeTelemetry()` 还会创建全局 log provider；如果 `OTEL_LOGS_EXPORTER` 未配置，则不会创建该 provider。

可用 exporter（数据导出器）和环境变量由 `src/utils/telemetry/instrumentation.ts` 中的 `parseExporterTypes()`、`getOtlpReaders()`、`getOtlpLogExporters()`、`getOtlpTraceExporters()` 解析：

| 信号 | 选择变量 | 支持的 exporter | 默认周期 |
|---|---|---|---|
| Metrics | `OTEL_METRICS_EXPORTER` | `console`、`otlp`、`prometheus` | 60000ms |
| Logs | `OTEL_LOGS_EXPORTER` | `console`、`otlp` | 5000ms |
| Traces | `OTEL_TRACES_EXPORTER` | `console`、`otlp` | 5000ms（仅 enhanced/beta tracing 路径） |

OTLP 协议从 signal-specific（按信号区分）的 `OTEL_EXPORTER_OTLP_*_PROTOCOL` 或通用 `OTEL_EXPORTER_OTLP_PROTOCOL` 读取，可用 `grpc`、`http/json`、`http/protobuf`；endpoint 和 headers 使用标准 `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`。设置 `none` 表示该 signal 不自动配置 exporter。Trace exporter 还要满足 `src/utils/telemetry/sessionTracing.ts` 的 `isEnhancedTelemetryEnabled()`；仅设置 `OTEL_TRACES_EXPORTER` 并不足以产生这些 span。

符合条件的账号还会由 `getBigQueryExportingReader()` 单独加入内部 BigQuery metrics reader，所以“未打开客户 OTLP”不等于“所有内部指标都不存在”。

**事件和隐私。** `src/utils/telemetry/events.ts` 的 `logOTelEvent()` 没有全局 event logger 时只警告一次并丢弃；测试环境直接跳过。它附加 session/device 等 telemetry attributes，并把事件命名为 `claude_code.<eventName>`。`redactIfDisabled()` 在 `OTEL_LOG_USER_PROMPTS` 未开启时返回 `<REDACTED>`。交互 span 的 prompt 行为同样由 `src/utils/telemetry/sessionTracing.ts` 控制。

注意：`logOTelEvent()` 在 `src/utils/telemetry/events.ts` 还会读取 `CLAUDE_CODE_WORKSPACE_HOST_PATHS` 并写入 `workspace.host_paths`；这类路径应按敏感数据处理。工具详情默认关闭，`src/services/analytics/metadata.ts` 规定 `OTEL_LOG_TOOL_DETAILS=1` 才记录详细 MCP/tool 名称，并对自定义 MCP 保持更严格的 gate。

**Span 层级与 beta 入口。** `src/utils/telemetry/sessionTracing.ts` 定义 interaction、llm_request、tool、blocked-on-user、tool.execution、hook 等 span 类型。`startInteractionSpan()` 创建用户输入到响应的根 span，`startLLMRequestSpan()` 创建 LLM span，结束函数附加 token、status、TTFT 和 retry 数据。Enhanced telemetry 的开关优先看环境变量，再看 ant/GrowthBook gate；Perfetto 是独立路径，通过 `CLAUDE_CODE_PERFETTO_TRACE=1` 或文件路径启用。更详细的 beta trace 需要 `ENABLE_BETA_TRACING_DETAILED=1` 和 `BETA_TRACING_ENDPOINT`，并受 `src/utils/telemetry/betaSessionTracing.ts` 的 gate 约束。

### 实例

把客户 OTel trace 导到 OTLP HTTP endpoint，同时不记录 prompt 内容：

```bash
# 打开客户侧 Telemetry
CLAUDE_CODE_ENABLE_TELEMETRY=1 \
# 使用 OTLP exporter（导出器）
OTEL_TRACES_EXPORTER=otlp \
# 通过 HTTP Protobuf 传输 trace
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
# 使用实际配置的 OTLP 服务地址
OTEL_EXPORTER_OTLP_ENDPOINT=<configured-otlp-endpoint> \
# 未设置 OTEL_LOG_USER_PROMPTS，因此 prompt 默认不出站
claude
```

只有在确认合规、确实需要 prompt 内容时才加：

```bash
# 仅在受控环境中显式记录 prompt
OTEL_LOG_USER_PROMPTS=1
```

`OTEL_LOG_TOOL_DETAILS=1` 同样应视为调试开关，而不是生产默认值。

### 反向论证：为什么 OTel 默认不发送 prompt / 工具详情

如果 `OTEL_LOG_USER_PROMPTS` 与 `OTEL_LOG_TOOL_DETAILS` 默认开，三个后果会同时出现：(1) 用户问“我刚才是不是把 API key 写进 prompt 了”时，**OTel 后端日志里就有明文**——审计回看反而泄露；(2) 工具调用的 `input` 经常含凭证路径、token 字符串、用户私有文件路径，发送等同于把用户环境信息广播给聚合层；(3) OTel 后端的 retention policy（数据保留策略）由后端配置决定，prompt 一旦送出本机，后续保留和删除就不再完全由 CLI 控制。三类场景都对应“开会增加暴露面，关只是在需要时少一步调试开关”，所以默认关闭、`OTEL_LOG_*` 显式开启才是正确姿态。

## 六、Langfuse：可选的 Agent/LLM/Tool 调用树

### 为什么

普通日志可以告诉你“某个工具失败”，却不容易回答“它属于哪一轮 LLM 请求、首 token 等了多久、缓存 token 如何计费、并行工具是否属于同一批次”。Langfuse observation 为 Agent、Generation、Tool 提供层级语义，适合分析单次运行；但它是云端出口，不能把原始文件内容和密钥直接发送出去。

### 怎么做

**初始化与生命周期。** `src/services/langfuse/client.ts` 的 `isLangfuseEnabled()` 只有同时存在 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 才返回 true；否则 `initLangfuse()` no-op。配置在 `src/services/langfuse/client.ts`：

| 环境变量 | 默认值 |
|---|---|
| `LANGFUSE_BASE_URL` | `<configured-langfuse-endpoint>` |
| `LANGFUSE_FLUSH_AT` | `20` |
| `LANGFUSE_FLUSH_INTERVAL` | `10`（秒） |
| `LANGFUSE_TRACING_ENVIRONMENT` | `development` |
| `LANGFUSE_EXPORT_MODE` | `batched` |
| `LANGFUSE_TIMEOUT` | `5`（秒） |

`src/entrypoints/init.ts` 初始化 Sentry 和 Langfuse，并注册 `shutdownLangfuse()`；`src/query.ts` 在拥有该 trace 的 query turn 结束时先 `endTrace()` 再 `flushLangfuse()`，避免 SpanImpl 长时间持有完整输入。`src/services/langfuse/client.ts` 还提供显式 flush/shutdown。

**调用树。**

- `createTrace()`：`src/services/langfuse/tracing.ts`，根 `agent` observation，附 `sessionId` 和 user ID；
- `recordLLMObservation()`：由 `src/services/api/claude.ts` 调用，记录 provider、model、input/output、token、TTFT；
- `createToolBatchSpan()`：按一个工具轮次建立 `tools` 父 span，使该轮串行和并行工具都归到同一节点；普通执行路径的调用点见 `src/services/tools/toolOrchestration.ts`；
- `recordToolObservation()`：由 `src/services/tools/toolExecution.ts` 和工具编排路径调用；
- `createSubagentTrace()` / `createChildSpan()`：分别表示子 agent 和主 trace 下的侧查询；
- `endTrace()`：用 `interrupted` 或 `error` 设置 warning/error level。

`recordLLMObservation()` 有两个不能随意改动的细节。这里的 observation 可以理解为一次可关联的观测节点：

1. 必须使用全局 `startObservation()`，而不是 `rootSpan.startObservation()`；`src/services/langfuse/tracing.ts` 中的实现注释说明后者会丢 `startTime`，导致 TTFT 可能为负；
2. Langfuse 的 input token 要计算 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`，否则缓存命中部分会被漏算。

**脱敏。** `initLangfuse()` 把 `sanitizeGlobal` 挂到 SpanProcessor 的 `mask`（`src/services/langfuse/client.ts`），所有 span 出口都会经过它。`src/services/langfuse/sanitize.ts` 的策略是：

- `HOME_DIR_PATTERN` 把 `HOME`、`USERPROFILE`、`homedir()` 及 Windows/macOS 变体替换为 `~`；
- `SENSITIVE_KEY_PATTERN` 命中 `api_key`、`token`、`secret`、`password`、`credential`、`auth_header` 时把值替换为 `[REDACTED]`；
- `sanitizeToolInput()` 只处理顶层敏感键和 `file_path`、`path`、`directory`，不会自动解析任意 `command`/`url`/`query` 内的语义秘密；
- `sanitizeToolOutput()` 对 FileRead/Write/Edit 只保留长度，对 Bash/PowerShell 超过 500 字符截断，对 Config/MCP/Vault 工具全部隐藏。

### 实例

```bash
# Langfuse 公钥和私钥只从环境变量读取
LANGFUSE_PUBLIC_KEY=pk-xxx \
LANGFUSE_SECRET_KEY=sk-xxx \
# 使用实际配置的 Langfuse endpoint
LANGFUSE_BASE_URL=<configured-langfuse-endpoint> \
# 同时打开本地 debug，便于对照本地与远端链路
claude --debug
```

一次“读文件 + 执行 shell”的 trace 大致是：

```text
agent-run
├── ChatAnthropic (generation: token / TTFT / cache)
└── tools (本轮工具父 span)
    ├── FileReadTool (path -> ~/..., output -> file content redacted)
    └── BashTool (output <= 500 chars，超出截断)
```

Langfuse 未配置时，以上函数仍可安全调用，但都会快速返回；这也是它与必须遵守隐私级别的 analytics/OTel 管道不同的地方。

## 七、Transcript 与 Hook：用于回放和外部订阅的观测面

### 为什么

云端追踪可能关闭、被采样或被脱敏；调试时还需要知道 `--resume` 实际恢复了哪条消息链。Transcript 记录可恢复状态，Hook 事件则把执行生命周期暴露给 SDK 或用户自己的处理器。两者都不是普通 debug 文本：前者服务程序恢复，后者服务事件订阅。

### 怎么做

**Transcript。** `src/utils/sessionStorage.ts` 定义路径。默认配置根是 `~/.claude`，但 `CLAUDE_CONFIG_DIR` 可覆盖它（`src/utils/envUtils.ts`）：

```text
getClaudeConfigHomeDir()/projects/<project-key>/<sessionId>.jsonl
```

子 agent 位于 `src/utils/sessionStorage.ts` 的 `getAgentTranscriptPath()` 计算的 `<sessionId>/subagents/` 下。`insertMessageChain()` 为每个条目写入 `parentUuid`、`sessionId`、`cwd`、`timestamp`、`version`、`gitBranch` 等字段。`recordTranscript()` 先通过 `getSessionMessages()` 去重，再只追加新消息，并让新消息接到正确的 `parentUuid`。

加载由 `loadTranscriptFile()` 完成：解析 JSONL、重建 UUID map、应用 compact/snip/preserved segment 投影并计算有效 leaf。大文件会做增量或边界读取；直接读取原始 transcript 的调用方可用 `MAX_TRANSCRIPT_READ_BYTES = 50 MiB` 作为 OOM（内存溢出）防护。`isLoggableMessage()` 过滤 progress；非 ant 用户还会隐藏大多数 attachment，并由 `cleanMessagesForLogging()` 移除外部 transcript 中的 REPL 包装。

持久化可以被 `NODE_ENV=test`、`cleanupPeriodDays === 0`、`isSessionPersistenceDisabled()`、`CLAUDE_CODE_SKIP_PROMPT_HISTORY` 等条件关闭。这意味着“没有 transcript”不一定是写入失败，也可能是明确的隐私或测试设置。

CLI 恢复入口在 `src/main.tsx`：

- `-c/--continue`：当前目录最近会话；
- `-r/--resume [value]`：session ID、JSONL 路径、标题搜索词或交互 picker；
- `--fork-session`：恢复时生成新 session ID；
- `--no-session-persistence`：只适用于 `--print`，禁止保存和恢复。

执行分支在 `src/main.tsx`，实际恢复由 `src/utils/conversationRecovery.ts` 的 `loadConversationForResume()` 协调。

**Hook 事件。** `src/utils/hooks/hookEvents.ts` 定义 `started`、`progress`、`response` 三类 `HookExecutionEvent`。`SessionStart` 与 `Setup` 总是发出；其他事件必须先由 `setAllHookEventsEnabled(true)` 打开。没有 handler 时最多缓存 100 条，注册 handler 后 drain；progress 默认每 1000ms 轮询一次。即使某类事件未开启，`emitHookResponse()` 仍会把完整 stdout/stderr/output 写入 debug 日志。SDK `includeHookEvents` 或 `CLAUDE_CODE_REMOTE` 会打开全部事件；主进程的 `tengu_run_hook` 埋点则是另一条通道，不要与 SDK event bus（事件总线）混为一谈。

### 实例

```bash
# 继续最近会话
claude --continue

# 按 session ID 恢复
claude --resume <sessionId>

# 直接从 JSONL 文件恢复
claude --resume /abs/path/to/<sessionId>.jsonl

# 恢复但创建新的会话 ID
claude --resume <sessionId> --fork-session
```

如果 resume 行为异常，先在 `--debug` 日志中查找 session 文件扫描信息，再用 `loadTranscriptFile()` 对照 `parentUuid` 链；需要查看 Hook 输出时使用 `claude --debug=hook`，需要程序化订阅时使用 SDK 的 `includeHookEvents`，而不是只查 `tengu_run_hook`。

## 八、Debug 与诊断入口：按症状选择最短路径

### 为什么

可观测数据越多，盲目打开所有开关越容易引入噪音和隐私风险。排错入口应按问题距离排序：先看本地、低成本、与症状直接相关的数据；只有需要跨请求比较或远程协作时，才打开 OTel/Langfuse/远程上报。

### 怎么做

| 症状 | 第一入口 | 第二入口 | 相关源码 |
|---|---|---|---|
| 启动或 hook 失败 | `claude --debug=init,hook` / `--debug-to-stderr` | 错误 JSONL、Sentry | `src/utils/debug.ts` 的日志过滤、`src/utils/errorLogSink.ts` 的 `logErrorImpl()` |
| API 慢、重试多 | debug `api` 类别 | OTel `llm_request` / Langfuse generation | `src/utils/telemetry/sessionTracing.ts` 的 `startLLMRequestSpan()`、`src/services/langfuse/tracing.ts` 的 `recordLLMObservation()` |
| 工具失败 | transcript 的 tool result | debug + `recordToolObservation()` | `src/services/tools/toolExecution.ts`、`src/services/tools/toolOrchestration.ts` |
| resume/compact 异常 | `--resume` debug 日志 | JSONL `parentUuid`、`loadTranscriptFile()` | `src/utils/sessionStorage.ts`、`src/utils/conversationRecovery.ts` |
| 统计趋势异常 | `logEvent` 的 event 名/采样 | Datadog allowlist、GrowthBook config | `analytics/sink.ts` 的 `logEventImpl()` |
| 客户侧链路缺失 | `CLAUDE_CODE_ENABLE_TELEMETRY=1` | exporter/protocol/endpoint | `telemetry/instrumentation.ts` 的 exporter 初始化函数 |
| 安装、配置、环境问题 | `claude doctor` | `src/screens/Doctor.tsx` 详细检查 | `src/commands/doctor/doctor.tsx` |

**启动性能。** `src/utils/startupProfiler.ts` 在模块加载时决定采样：ant 用户 100%，外部用户代码为 0.5%（`STATSIG_SAMPLE_RATE = 0.005`）。`CLAUDE_CODE_PROFILE_STARTUP=1` 开启详细模式，`profileCheckpoint()` 记录 performance mark（性能标记）和 memory snapshot（内存快照），`profileReport()` 写报告并清理 marks；文件路径由 `getStartupPerfLogPath()` 定义在配置根的 `startup-perf/<sessionId>.txt`（默认 `~/.claude/startup-perf/<sessionId>.txt`）：

```text
getClaudeConfigHomeDir()/startup-perf/<sessionId>.txt
```

源码顶部注释和 `profileReport()` 中仍写着外部用户 0.1%，但实际常量是 0.005（0.5%）；以代码为准。

**无 PII 诊断文件。** `src/utils/diagLogs.ts` 的 `logForDiagnosticsNoPII()` 只有设置 `CLAUDE_CODE_DIAGNOSTICS_FILE` 才落盘，并明确禁止 file path、project name、repo name、prompt 等 PII。`withDiagnosticsTiming()` 可自动产生 started/completed/failed 和 `duration_ms`。这条通道适合容器/CCR 的连接和生命周期诊断，不应拿来记录用户内容。

**Doctor。** `src/commands/doctor/doctor.tsx` 只是命令薄壳，实际 UI 与诊断渲染在 `src/screens/Doctor.tsx`，其中使用 `getDoctorDiagnostic()`、`checkContextWarnings()` 等检查安装、配置、MCP、agent 和上下文风险。不要只读命令薄壳来判断 Doctor 的检查范围。

### 实例

一个从“启动失败”到“定位工具错误”的最小流程：

```bash
# 1. 从启动阶段开始捕获；容器中可直接看 stderr
claude --debug-to-stderr

# 或只收集相关类别
claude --debug=init,api,hook,tool

# 2. 交互会话中补开日志
/debug

# 3. 查看本地错误与 transcript
# ~/.claude/debug/latest
# ~/.claude/errors/<date>.jsonl（仅 ant sink 写入）
# ~/.claude/projects/<project-key>/<sessionId>.jsonl

# 4. 如果是启动耗时
CLAUDE_CODE_PROFILE_STARTUP=1 claude
cat ~/.claude/startup-perf/<sessionId>.txt

# 5. 如果是环境/安装问题
claude doctor
```

## 九、边界、隐私与运维取舍

### 为什么

可观测性不是“记录一切”。记录越完整，恢复和排错越容易，但代码、文件路径、prompt、token 和用户身份也越容易越过边界。正确使用这套系统的前提，是知道每个出口刻意不记录什么、什么时候会丢数据，以及哪些开关会改变隐私等级。

### 怎么做

- **Debug**：普通用户默认不写；打开后可能包含命令、cwd、hook 输出和错误 stack。`--debug-to-stderr` 适合临时观察，但不要把 stderr 当作无敏感数据。
- **Error sink**：`errorQueue` 在 attach 前能缓冲；如果进程在 attach 前硬崩，队列中的非持久数据仍可能丢失。内存 FIFO 上限是 100 条。
- **Analytics**：采样、allowlist 和 killswitch 都可能让事件不出现；先检查 `tengu_event_sampling_config`、`tengu_log_datadog_events` 和 `tengu_frond_boric`，不要直接把“未查到”解释成“代码没执行”。
- **Datadog**：只处理 production/first-party/allowlist 事件，且只剥离 `_PROTO_*`；它不是通用内容脱敏器。
- **Langfuse**：所有 span 经过 `sanitizeGlobal`，但工具输入只按有限 key 处理，不能识别任意自然语言中的秘密；脱敏后的 trace 不是原始 transcript。
- **OTel**：prompt 默认是 `<REDACTED>`；`OTEL_LOG_USER_PROMPTS=1`、`OTEL_LOG_TOOL_DETAILS=1` 会扩大内容暴露面，应只在受控环境启用。
- **Transcript**：可恢复消息链、metadata 和文件历史，但不恢复当前进程的 MCP 连接、Hook 注册、AbortController 或未完成的流式响应。非 ant transcript 还会过滤大多数 attachment，并移除 REPL 包装；不能把 JSONL 当作原始 API 请求审计副本。
- **退出 flush**：graceful shutdown 为避免卡死会限制 analytics flush 时间；网络不可用时，不能假设所有远程事件都已送达。

### 实例

选择开关时可以按以下原则：

```text
只想定位当前 CLI 问题       -> --debug=... 或 /debug
要复盘一轮会话              -> transcript + --resume
要比较多次请求的延迟        -> OTel llm_request 或 Langfuse
要看功能使用率              -> analytics event / Datadog / 1P
要把 prompt 内容送出本机    -> 明确评估 OTEL_LOG_USER_PROMPTS 和 Langfuse 脱敏风险
不希望保存会话              -> --no-session-persistence（仅 --print）或相应隐私设置
```

### 配置速查

| 目的 | 开关/变量 |
|---|---|
| Debug 开关 | `--debug`、`--debug=<filter>`、`DEBUG=1`、`DEBUG_SDK=1` |
| Debug 出口 | `--debug-to-stderr`、`--debug-file=<path>`、`CLAUDE_CODE_DEBUG_LOGS_DIR` |
| Debug 级别 | `CLAUDE_CODE_DEBUG_LOG_LEVEL=verbose|debug|info|warn|error` |
| Analytics/telemetry 关闭 | `DISABLE_TELEMETRY=1`（no-telemetry）、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（essential-traffic） |
| 仅关闭 `logError` 管道 | `DISABLE_ERROR_REPORTING=1`、三方 provider 环境变量、essential-traffic |
| Sentry | `SENTRY_DSN` |
| 客户 OTel | `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*_EXPORTER` |
| OTel prompt 内容 | `OTEL_LOG_USER_PROMPTS=1` |
| OTel tool 详情 | `OTEL_LOG_TOOL_DETAILS=1` |
| Langfuse | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` |
| 启动 profile | `CLAUDE_CODE_PROFILE_STARTUP=1` |
| 无 PII 诊断文件 | `CLAUDE_CODE_DIAGNOSTICS_FILE=<path>` |
| 会话持久化 | `--no-session-persistence`、`CLAUDE_CODE_SKIP_PROMPT_HISTORY`、`cleanupPeriodDays=0` |

核心原则可以压缩成一句话：**先用本地 debug 和 transcript 还原事实，再用错误 sink、analytics、OTel 或 Langfuse 做聚合与远程关联；每一步都在出口处检查隐私边界。**

**收束**

6 类观测 × 12 个组件，本质上是一张排障导航图：循环层应该有日志，工具层应该有错误记录，权限层则最容易出现 deny。只有这三层都没有异常时，才需要进一步回放 transcript。

整体取舍可以概括为：本地 debug 和 transcript 优先，远程聚合其次；每条出口都要检查 PII（个人可识别信息）边界。这样才能在事后还原 Agent 这类“概率系统加长链路”的现场，而不是只剩下“它没动”的口头复盘。
