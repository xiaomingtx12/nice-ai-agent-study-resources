# 可观测性

> **本章目标**：理解 Claude Code 的可观测性体系——它如何让"黑盒"的 Agent 变成"玻璃盒"，如何在透明度与隐私之间做精细平衡，以及日志、指标、追踪、黑匣子四大支柱如何协同工作。
>
> **读完本章你应该能回答**：
> - 为什么 Agent 系统需要独立设计的可观测性，而不能直接套用传统日志？
> - 四类可观测性数据（日志 / 指标 / 追踪 / 黑匣子）各自解决什么问题、如何分工？
> - Transcript 为何被称为 Agent 的"黑匣子"，它的 JSONL 格式如何兼顾可读性与可恢复性？
> - Langfuse 追踪如何组织 Agent / Tool / Generation 的层级关系，数据脱敏（sanitize）如何防止 PII 泄露？
> - 分析埋点（Analytics）如何用类型系统强制 PII 保护？`_PROTO_*` 字段的双 sink 路由机制是什么？
> - 当 Agent 行为异常时，应该按什么顺序查看哪些数据源？

**配套阅读标注**：本章采用"问题 → 位置 → 宏观全貌 → 核心细节 → 收束"五段式结构。前两部分建立问题意识与全局坐标；第三部分用一张端到端全景图建立心智模型，再从核心抽象、版图分类、注册机制、对外接口四个侧面展开；第四部分沿"一次 Agent 执行"中各类可观测性数据的生命周期逐条深入，每个机制遵循"为什么需要 → 怎么做 → 具体实例"三段式；最后三节收束于设计权衡、边界局限与可复用模式。若只读一节，读第三章的全景链路；若要排错，直接跳到第四章末的故障排查路径。

**文章结构**：

| 部分 | 章节 | 内容 | 阅读建议 |
|------|------|------|---------|
| 问题 | 一、解决什么问题 | 不确定性 + 长链路 + 隐私三重挑战 | 必读，建立问题意识 |
| 位置 | 二、在整体架构中的位置 | 横切关注点、被动接收者、单向依赖 | 必读，建立全局坐标 |
| 宏观 | 三、系统完整样貌 | 全景链路 → 核心抽象 → 版图分类 → 注册机制 → 对外接口 | 必读，建立心智模型 |
| 细节 | 四、核心运行时细节 | 日志流 → Transcript 流 → Langfuse 流 → 埋点流 → 故障排查 | 必读，理解实现机制 |
| 收束 | 五、设计决策与权衡 | 关键取舍及其原因 | 选读，理解设计意图 |
| 收束 | 六、边界与局限 | 当前实现的不足 | 选读，了解能力边界 |
| 收束 | 七、可复用的模式 | 可迁移的设计模式 | 选读，提炼通用模式 |

---

## 一、解决什么问题

Agent 是概率性系统——同样的输入可能产生不同的输出，同样的操作可能成功也可能失败。当 Agent 删错了文件、陷入了死循环、或者给出了荒谬的答案，你需要知道它当时在想什么、看到了什么上下文、调用了什么工具。没有可观测性，你只能猜测。可观测性把 Agent 从"黑盒"变成"玻璃盒"。

更深层的挑战在于 Agent 系统的 **不确定性 + 长链路** 双重特性，这两点让传统运维监控的经验几乎全部失效：

- **不确定性**：LLM 输出不可预测，传统日志的"expect X, got Y"模式难以适用——你事先不知道 X 应该是什么，也就无法断言"得到了非预期结果"。可观测性必须记录"Agent 实际看到了什么、决定了什么"，而非"期望与实际是否一致"。
- **长链路**：单次任务可能跨越数百轮 tool call，一条请求在 Agent Loop 里被拆成几十次 LLM 调用和上百次工具执行。传统日志是线性的事件流，在这种深度嵌套的调用链里会丢失"哪一步属于哪一轮"的归属关系，因此需要 trace（追踪）而非 log（日志）才能看到全貌。
- **高敏感度**：Agent 操作真实文件系统，PII（代码、文件路径、API key）泄露后果严重。不同于服务端日志（运维人员内部可见），Agent 的可观测性数据可能流向云端追踪平台，隐私边界必须从设计之初就嵌入每一条数据通路。

因此可观测性系统必须在 **透明度** 与 **隐私** 之间做精细平衡——记录足够帮助 debug，但不能泄露用户的工作内容。这一约束贯穿整个可观测性体系的设计，影响每一个组件的实现细节：日志要分级控制详细程度，transcript 要选择性捕获可恢复状态，追踪数据要在出口脱敏，埋点要用类型系统强制 PII 声明。

明确了"要解决什么问题"之后，下一个问题是：这套体系在 Claude Code 的整体架构中占据什么位置、与业务模块是什么关系。这正是下一章的内容。

---

## 二、在整体架构中的位置

可观测性贯穿所有层——Agent Loop 产生 transcript（完整对话记录），工具管线产生执行日志，Hook 系统本身就是 trace point。Langfuse 追踪覆盖从 API 调用到工具执行的完整链路。它是最底层的横切关注点，所有层都会写入可观测性数据，但不依赖任何上层模块。

```
┌─────────────────────────────────────────┐
│ Agent Loop / Query Engine               │
│   └─ recordTranscript (transcript)     │
├─────────────────────────────────────────┤
│ Tool System                             │
│   └─ logForDebugging (debug log)        │
├─────────────────────────────────────────┤
│ Langfuse Tracing                        │
│   └─ createTrace / recordLLMObservation│
├─────────────────────────────────────────┤
│ Analytics Sink                          │
│   └─ logEvent → Datadog + 1P BQ        │
└─────────────────────────────────────────┘
```

**设计原则**：可观测性是被动接收者，业务代码主动调用 `logEvent()` / `logForDebugging()`。可观测性模块不反向依赖业务模块，避免循环引用。这种"单向依赖"关系确保可观测性代码可以独立演进，也不会因为业务模块的变更而引入追踪逻辑的故障。

这条单向依赖原则不只是架构洁癖，它有具体的工程后果：可观测性模块的 `index.ts`（如 `src/services/analytics/index.ts`）甚至不能 import `sink.ts` 里的具体后端实现，否则会通过依赖图把 Datadog SDK 等重依赖拖进启动路径。因此 Claude Code 普遍采用"index.ts 定义无依赖 API + sink.ts 定义有依赖实现 + 启动时 attach"的分层模式，后文会反复看到这一模式。

架构位置已明，但"横切"到底切在哪里、四类数据各自走什么通路，仍是一张模糊的地图。下一章用一张端到端全景图把整张图描清楚，再从核心抽象、版图分类、注册机制、对外接口四个侧面展开。

---

## 三、宏观看系统完整样貌

本章先把可观测性体系的"地图"画出来，再逐个侧面拆解。地图建立心智模型，侧面拆解建立精确认知。第四章会沿着这张地图上同样的数据流深入到每个节点的运行时细节。

### 3.1 全景链路：一次 Agent 执行的可观测性数据流

要理解可观测性体系，最好的切入点是跟踪"一次 Agent 执行"——从用户输入一句话，到 Agent 完成一轮工具调用并回复。在这个过程中，四类可观测性数据几乎同时产生，却流向不同的存储与后端。下图把这条端到端链路完整画出来：

```
用户输入一句话
      │
      ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Agent Loop 一次循环                                                   │
│                                                                       │
│  ① recordTranscript(user message)   ─────────► Transcript JSONL 文件  │
│  ② createTrace(sessionId, model)    ─────────► Langfuse root span     │
│  ③ logForDebugging('turn start')    ─────────► Debug 日志文件/stderr   │
│                                                                       │
│  ┌─ LLM 调用 ───────────────────────────────────────────────────┐    │
│  │  recordLLMObservation(usage, TTFT)  ─► Langfuse generation    │    │
│  │  logForDebugging('llm request')     ─► Debug 日志              │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ Tool 批次（并行 tool call）──────────────────────────────────┐    │
│  │  createToolBatchSpan                ─► Langfuse batch span     │    │
│  │   ├ Tool A: recordToolObservation   ─► Langfuse tool obs       │    │
│  │   └ Tool B: recordToolObservation   ─► Langfuse tool obs       │    │
│  │  recordTranscript(tool_use / tool_result) ─► Transcript        │    │
│  │  logForDebugging('tool exec')       ─► Debug 日志              │    │
│  │  Hook: PreToolUse / PostToolUse     ─► 用户自定义后端（可选）   │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ④ logEvent('tool_used', metadata)  ─────────► Analytics 双 sink     │
│       ├─ stripProtoFields ─► Datadog（剥离 _PROTO_*，无 PII）         │
│       └─ 保留 _PROTO_*    ─► 1P BigQuery（有访问控制，保留 PII）      │
│                                                                       │
│  ⑤ 出错时 logError(err)              ─────────► Error sink 队列 → 上报 │
└─────────────────────────────────────────────────────────────────────┘
      │
      ▼
循环结束 / 会话结束：registerCleanup 触发，flush 所有缓冲，end 所有 span
```

这张图揭示了几个关键事实：第一，四类数据**并行产生**而非串行——同一次工具调用会同时写入 transcript、debug 日志、Langfuse trace 和 analytics 事件，各自服务于不同目的。第二，它们的**出口不同**：transcript 落本地文件供 `--resume`，debug 日志落本地文件供开发者，Langfuse 上云供可视化追踪，analytics 上云供运营统计。第三，**隐私防线设在出口**——Langfuse 在 SpanProcessor 的 `mask` 回调脱敏，analytics 在 `stripProtoFields` 分流 PII，debug 日志靠级别与 filter 控制。理解了这条全景链路，下面四个侧面就是在给图上的每个节点命名、归类、接线。

### 3.2 核心抽象

把上图的节点归纳一下，可观测性体系建立在六个核心抽象之上。每个抽象都是"把变化封装在一处"的产物：

| 抽象 | 定义 | 封装的变化点 | 证据 |
|------|------|-------------|------|
| **Sink（数据接收者）** | 错误日志 / 埋点的目标后端接口 | "数据要去哪里"——业务代码只调 `logError()` / `logEvent()`，不关心后端是 Datadog 还是 BQ | `ErrorLogSink` / `AnalyticsSink`（`src/utils/log.ts` / `src/services/analytics/index.ts`） |
| **BufferedWriter（缓冲写入器）** | 支持 immediate / buffered 双模式的写入器 | "何时落盘"——debug 模式同步写、非 debug 模式批量写 | `src/utils/debug.ts:138-194` |
| **Transcript（会话黑匣子）** | 以 `parentUuid` 串成的 JSONL 消息链 | "哪些状态可恢复"——只持久化可重放状态，丢弃运行时状态 | `src/utils/sessionStorage.ts` |
| **Observation / Trace（追踪观察）** | Langfuse 的层级 span，`asType` 区分 agent/generation/tool/span | "调用的语义层级"——让追踪后端按 Agent 语义而非通用 span 渲染 | `src/services/langfuse/tracing.ts` |
| **Analytics Event（埋点事件）** | `LogEventMetadata` + `_PROTO_*` 键 + 类型标记 | "字段是否含 PII"——用类型系统在编译期编码 PII 属性 | `src/services/analytics/index.ts:19-33` |
| **Hook（用户可配置 trace point）** | SessionStart/PreToolUse/PostToolUse/Stop 事件 | "扩展点"——把内置执行事件暴露给用户自定义后端 | `src/utils/hooks.ts` |

这六个抽象的共同设计哲学是：**让业务代码只面对稳定的接口，把后端实现、写入策略、隐私处理等变化点藏在抽象背后**。例如业务代码写 `logEvent('tool_used', m)`，它不知道也不需要知道这个事件会被采样、会被分流、会被 killswitch 关闭——这些都是 sink 层的职责。第四章的每条数据流，本质上都是在讲这些抽象如何协作。

### 3.3 版图分类：四大支柱 + 诊断工具

核心抽象落地的产物是四类可观测性数据——即"四大支柱"。每类解决不同的问题，使用不同的存储和查询方式：

| 支柱 | 实现方式 | 存储 | 查询方式 | 证据 |
|------|---------|------|---------|------|
| 日志 (Logs) | debug.ts + log.ts 多级日志系统 | 文件 (`~/.claude/debug/`) + stderr | `--debug` 参数 / `DEBUG=1` 环境变量 | `src/utils/debug.ts:44-57` |
| 指标 (Metrics) | analytics/index.ts → Datadog + 1P Event Logger | Datadog + First-party BQ | Datadog Dashboard / BQ 查询 | `src/services/analytics/sink.ts:48-72` |
| 追踪 (Traces) | Langfuse OpenTelemetry spans (Agent/Tool/LLM) | Langfuse (自建或云) | Langfuse UI | `src/services/langfuse/tracing.ts:27-73` |
| 黑匣子 (Transcript) | JSONL 持久化 | `~/.claude/projects/<hash>/<sessionId>.jsonl` | `--resume` / `loadTranscriptFile` | `src/utils/sessionStorage.ts` |

四类数据的分工可以这样记：**日志用于本地开发调试、指标用于远程监控和趋势分析、追踪用于分布式链路可视化、transcript 用于会话恢复和行为回放**。前三者是"观察 Agent 在做什么"，transcript 是"让 Agent 自己能重来"——它不只是给人看的，也是给 `--resume` 程序读的，这是它独立成一支柱的根本原因。

四大支柱之外，还有一类**诊断工具**（而非数据）需要纳入版图。它们不是被动收集的数据，而是主动探测的手段：

| 诊断项 | 类别 | 检查内容 | 证据 |
|--------|------|---------|------|
| Doctor 命令 | 主动检查 | 环境完整性（Node/Bun 版本、网络、配置） | `src/commands/doctor/doctor.tsx` |
| Health Check | 主动检查 | `bun run health` 检查项目健康状态 | `package.json` scripts |
| Startup Profiler | 性能分析 | 启动阶段耗时（profileCheckpoint） | `src/utils/startupProfiler.js` |
| Ablation Baseline | 问题隔离 | L0 基线（禁用所有高级功能，对比行为差异） | `src/entrypoints/cli.tsx:56-69` |
| Diagnostic Tracking | 上下文采集 | IDE LSP 诊断信息（Error/Warning/Info/Hint） | `src/services/diagnosticTracking.ts:14-23` |
| In-Memory Error Log | 被动收集 | 最近 100 条错误（FIFO） | `src/utils/log.ts:66-77` |

诊断工具与四大支柱的关系是"主动 vs 被动"：支柱是 Agent 运行时持续产生的数据流，诊断工具是出问题时才主动调用的探测手段。两者互补——支柱告诉你"发生了什么"，诊断工具告诉你"环境是否正常、瓶颈在哪里"。本章只把诊断工具归入版图，其使用方式见第四章末的故障排查路径。

### 3.4 注册机制

可观测性体系的几个关键组件都遵循同一种注册模式：**业务代码随时调用，但后端 sink 不一定已就绪，因此用"队列缓冲 + attach 时 drain"化解时序问题**。这一模式在错误日志和分析埋点上各出现一次，是本体系最重要的运行时机制之一。

| 注册对象 | 注册函数 | 时序保障 | 证据 |
|---------|---------|---------|------|
| ErrorLogSink | `attachErrorLogSink` | sink 未附加时错误入队，附加时同步 drain | `src/utils/log.ts:109-134` |
| AnalyticsSink | `attachAnalyticsSink` | sink 未附加时事件入队，附加时 `queueMicrotask` 异步 drain | `src/services/analytics/index.ts:95-123` |
| Langfuse tracer | `initLangfuse` | 未配置 key 时整体 no-op，零开销 | `src/services/langfuse/client.ts:21-62` |
| 清理回调 | `registerCleanup` | 进程退出时 flush 缓冲、dispose 写入器 | `src/utils/debug.ts:182-185` |
| Hook 事件 | 用户配置 | 用户在 settings 中注册命令，事件触发时执行 | `src/utils/hooks.ts` |

这里有一个值得注意的不对称：错误日志的 drain 是**同步**的（错误必须尽快可见），分析埋点的 drain 是**异步**的（`queueMicrotask`，埋点不阻塞启动）。这种差异背后的意图是：错误的实时性直接影响 debug 体验，而埋点是统计性数据，延迟几毫秒无伤大雅。具体实现见第四章对应数据流。

### 3.5 对外接口

最后一张图把可观测性体系暴露给业务代码的接口收拢在一起。业务开发者只需认识这几个函数，就足以接入全部四类可观测性数据——这是"单向依赖"原则在 API 层的体现：

| 接口 | 作用 | 归属支柱 | 证据 |
|------|------|---------|------|
| `logForDebugging(message, {level})` | 写多级 debug 日志 | 日志 | `src/utils/debug.ts:201-226` |
| `logError(error)` | 上报错误（含队列缓冲） | 日志 | `src/utils/log.ts:158-198` |
| `recordTranscript(messages, ...)` | 写会话黑匣子 | 黑匣子 | `src/utils/sessionStorage.ts:1445-1486` |
| `createTrace(params)` | 创建 Langfuse 根 trace | 追踪 | `src/services/langfuse/tracing.ts:27-73` |
| `recordLLMObservation(rootSpan, params)` | 记录 LLM 调用 observation | 追踪 | `src/services/langfuse/tracing.ts:85-182` |
| `recordToolObservation(rootSpan, params)` | 记录工具执行 observation | 追踪 | `src/services/langfuse/tracing.ts:184-248` |
| `logEvent(eventName, metadata)` | 发送分析埋点 | 指标 | `src/services/analytics/index.ts:133-144` |
| `attachErrorLogSink` / `attachAnalyticsSink` | 注册后端 sink | 注册机制 | `src/utils/log.ts:109-134` / `src/services/analytics/index.ts:95-123` |
| Hook 事件（SessionStart 等） | 用户可配置 trace point | 扩展 | `src/utils/hooks.ts` |

注意 Hook 的特殊地位：其余接口都是**内置 trace**（开发者写死在代码里），Hook 是**用户可配置 trace point**（用户在 settings 里注册命令，把执行事件转发到 Slack、企业内部监控等自定义后端）。Hook 事件天然构成 Agent 执行链路的 trace points，每个事件携带不同上下文：

| Hook 事件 | Trace 语义 | 携带的上下文 | 证据 |
|-----------|-----------|-------------|------|
| SessionStart | trace.start | session_id, cwd, git_branch | `src/utils/hooks.ts` |
| PreToolUse | span.event (before) | tool_name, tool_input, tool_use_id | `src/utils/hooks.ts:3538` |
| PostToolUse | span.event (after) | tool_name, duration, result, is_error | `src/utils/hooks.ts:3594` |
| Stop | trace.end | turns, tokens_used, stop_reason | `src/utils/hooks.ts` |
| SubagentStop | sub-trace.end | agent_type, turns, tokens_used | `src/utils/hooks.ts` |

两者定位互补——Langfuse 提供开箱即用的可视化（开发者用），Hook 提供灵活的自定义集成（企业用户用），Hook 的详细机制见 [12-hook-interception](cc-12-hook-interception.md)。

地图已画完、节点已命名、接口已收拢。但每个节点内部如何运转、为什么这样设计，仍需深入。下一章沿着同样的数据流，把每个节点的运行时细节逐一拆开。

---

## 四、深入核心必要的运行时细节

本章沿着第三章全景链路中"一次 Agent 执行"的生命周期，跟踪每一类可观测性数据从产生到落盘的全过程。每条数据流都遵循"**为什么需要 → 怎么做 → 具体实例**"三段式：先讲机制要解决的痛点，再讲实现如何化解痛点，最后用一个具体场景串起全过程。四条数据流（日志、Transcript、Langfuse、埋点）在运行时几乎并行触发，但为清晰起见分开讲述；第四章末的故障排查路径再把它们合成为实战排错手册。

### 4.1 日志流：从 logForDebugging / logError 到文件与上报

#### 为什么需要

日志是开发者最常用的调试工具，但 Agent 场景对日志提出了两个特殊要求。第一，**同一份代码要在不同场景下输出不同详细程度**：开发时需要看到每一行 shell 命令和 cwd 切换，生产环境只关心 warn/error。如果用 `console.log` 硬编码，改详细程度就要改代码、重新发布。第二，**错误上报必须不依赖后端初始化时序**：业务代码可能在 sink 还没 attach 时就抛错，如果直接调用 sink 方法会丢失这条错误。这两个要求分别由"多级日志"和"error sink 队列"两个机制解决。

#### 怎么做

**多级日志与路由**。日志级别由 `CLAUDE_CODE_DEBUG_LOG_LEVEL` 环境变量控制最低级别，从 verbose(0) 到 error(4) 共五级。`logForDebugging` 在写入前先做级别过滤，再经过 filter、格式化，最后路由到 stderr 或 BufferedWriter：

```
CLAUDE_CODE_DEBUG_LOG_LEVEL 环境变量控制最低级别:
  verbose (0) → 高频诊断（statusLine, shell 命令, cwd, stdout/stderr）
  debug   (1) → 常规调试信息（默认）
  info    (2) → 关键操作
  warn    (3) → 警告
  error   (4) → 错误

日志路由（src/utils/debug.ts:201-226）:
  logForDebugging(level, message)
    ├─► 级别过滤：LEVEL_ORDER[level] < getMinDebugLogLevel() → return
    ├─► shouldLogDebugMessage() → userType + debugMode + filter
    ├─► 多行消息处理：hasFormattedOutput && 含 \n → jsonStringify
    ├─► --debug-to-stderr → writeToStderr() 直接写入 stderr
    └─► 默认 → getDebugWriter().write() → BufferedWriter → 文件
```

debug 模式本身由 7 个条件之一触发（`src/utils/debug.ts:44-57`），包括 `/debug` 命令、`DEBUG` 环境变量、`--debug`/`-d` 参数、`--debug-to-stderr`、`--debug=` 带值参数、以及设置了 debug 文件路径。`isDebugMode` 用 `memoize` 缓存结果，避免每次日志写入都重新评估这 7 个条件——在高频日志场景下，这种缓存能避免显著的性能开销：

```typescript
export const isDebugMode = memoize((): boolean => {
  return (
    runtimeDebugEnabled ||                                    // /debug 命令启用
    isEnvTruthy(process.env.DEBUG) ||
    isEnvTruthy(process.env.DEBUG_SDK) ||
    process.argv.includes('--debug') ||
    process.argv.includes('-d') ||
    isDebugToStdErr() ||
    process.argv.some(arg => arg.startsWith('--debug=')) ||
    getDebugFilePath() !== null
  )
})
```

`--debug=pattern` 还支持消息过滤（`src/utils/debug.ts:73-83`），只输出匹配特定 pattern 的消息，在排查某一类问题（如 compact、tool）时大幅减少噪音：

```typescript
// src/utils/debug.ts:73-83
export const getDebugFilter = memoize((): DebugFilter | null => {
  const debugArg = process.argv.find(arg => arg.startsWith('--debug='))
  if (!debugArg) return null
  const filterPattern = debugArg.substring('--debug='.length)
  return parseDebugFilter(filterPattern)
})
```

**BufferedWriter 的双模式写入**。debug 日志不直接 `appendFile`，而是走 `BufferedWriter`（`src/utils/debug.ts:138-194`），它有一个关键设计：`immediateMode` 标志按 `isDebugMode()` 切换两种写入策略：

```typescript
async function appendAsync(needMkdir, dir, path, content): Promise<void> {
  if (needMkdir) await mkdir(dir, { recursive: true }).catch(() => {})
  await appendFile(path, content)
  void updateLatestDebugLogSymlink()
}

function getDebugWriter(): BufferedWriter {
  if (!debugWriter) {
    let ensuredDir: string | null = null
    debugWriter = createBufferedWriter({
      writeFn: content => {
        const path = getDebugLogPath()
        const dir = dirname(path)
        const needMkdir = ensuredDir !== dir
        ensuredDir = dir
        if (isDebugMode()) {
          // immediateMode：必须保持 sync（async 在 process.exit() 中丢失）
          if (needMkdir) {
            try { getFsImplementation().mkdirSync(dir) } catch {}
          }
          getFsImplementation().appendFileSync(path, content)
          void updateLatestDebugLogSymlink()
          return
        }
        // Buffered path（ants without --debug）：~1/sec flush
        pendingWrite = pendingWrite
          .then(appendAsync.bind(null, needMkdir, dir, path, content))
          .catch(noop)
      },
      flushIntervalMs: 1000,
      maxBufferSize: 100,
      immediateMode: isDebugMode(),
    })
    registerCleanup(async () => {
      debugWriter?.dispose()
      await pendingWrite
    })
  }
  return debugWriter
}
```

这里有两个常量背后的意图需要点出：

- **`immediateMode` 为什么必须 sync**：注释写明"async 在 `process.exit()` 中丢失"。开发者用 `--debug` 排查问题时，常常会让进程很快退出（如复现一个 bug 后 Ctrl+C）。如果用 async `appendFile`，退出时未完成的写入会被丢弃，日志就缺了最关键的"最后几行崩溃现场"。sync 写入虽然慢，但保证可见。非 debug 模式（后台运行）则用 buffered 路径，1 秒 flush 一次，减少磁盘 I/O——这种按需切换避免了不必要的磁盘开销。
- **`maxBufferSize: 100` 与 `flushIntervalMs: 1000`**：这两个常量是"内存占用 vs flush 频率"的权衡。100 条是缓冲上限，达到就立即 flush；1000ms 是时间上限，到点就 flush。两者取先到者。100 条这个数字不大，意味着即使日志爆发，最多积压 100 条就会落盘，内存压力可控；1000ms 则保证非爆发场景下日志延迟不超过 1 秒。

此外每次写入都更新 `~/.claude/debug/latest` 软链指向当前 session 日志，让开发者 `tail -f ~/.claude/debug/latest` 不必先查 sessionId；`registerCleanup` 则保证进程退出时 `dispose` 写入器并 `await pendingWrite`，把缓冲里的数据冲掉。

`logForDebugging` 的格式化逻辑（`src/utils/debug.ts:201-226`）输出 `[ISO timestamp] [LEVEL] message\n`，并对多行消息做 JSON 序列化以保持 jsonl 格式（每行一个完整记录）：

```typescript
// src/utils/debug.ts:201-226
export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = { level: 'debug' },
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinDebugLogLevel()]) return
  if (!shouldLogDebugMessage(message)) return
  
  // 多行消息 JSON 序列化（保持 jsonl 格式）
  if (hasFormattedOutput && message.includes('\n')) {
    message = jsonStringify(message)
  }
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  
  if (isDebugToStdErr()) {
    writeToStderr(output)
    return
  }
  getDebugWriter().write(output)
}
```

**Error 日志与 sink 队列**。`logError`（`src/utils/log.ts:158-198`）处理错误上报，有三层逻辑值得注意：第一，Cloud providers（Bedrock/Vertex/Foundry）禁用 error reporting——云厂商自己处理错误，CLI 不重复上报；第二，错误始终先入内存日志（上限 100 条 FIFO，供 bug report 用）；第三，sink 未附加时入队，附加时 drain：

```typescript
// src/utils/log.ts:158-198
export function logError(error: unknown): void {
  const err = toError(error)
  if (feature('HARD_FAIL') && isHardFailMode()) {
    console.error('[HARD FAIL] logError called with:', err.stack || err.message)
    process.exit(1)
  }
  try {
    // Cloud providers（Bedrock/Vertex/Foundry）禁用 error reporting
    if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
        isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
        isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
        process.env.DISABLE_ERROR_REPORTING ||
        isEssentialTrafficOnly()) {
      return
    }
    
    const errorStr = shortErrorStack(err)
    const errorInfo = { error: errorStr, timestamp: new Date().toISOString() }
    
    // 1. 始终加入内存日志（无依赖）
    addToInMemoryErrorLog(errorInfo)
    
    // 2. Sink 未附加则入队（attaching 时 drain）
    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }
    
    errorLogSink.logError(err)
  } catch {}
}
```

sink 队列的 drain 逻辑在 `attachErrorLogSink`（`src/utils/log.ts:109-134`）中，attach 时同步把队列里所有积压事件重放给新 sink：

```typescript
// src/utils/log.ts:109-134
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) return  // Idempotent
  errorLogSink = newSink
  
  // Drain queue immediately
  if (errorQueue.length > 0) {
    const queuedEvents = [...errorQueue]
    errorQueue.length = 0
    for (const event of queuedEvents) {
      switch (event.type) {
        case 'error': errorLogSink.logError(event.error); break
        case 'mcpError': errorLogSink.logMCPError(event.serverName, event.error); break
        case 'mcpDebug': errorLogSink.logMCPDebug(event.serverName, event.message); break
      }
    }
  }
}
```

这一队列机制解决了"业务代码早于 sink 初始化"的时序问题——如果直接调用 `errorLogSink.logError()`，业务代码必须在 sink 初始化之后才能执行；队列机制把"记录错误"和"发送错误"解耦，允许任何时序调用。`Idempotent`（先到先得）则允许从 preAction hook 和 setup() 多次调用而不冲突。内存日志上限 100 条 FIFO 是"够用且不爆内存"的折中——bug report 通常只关心最近的错误，100 条足以覆盖一次典型会话的错误上下文。

#### 具体实例

假设开发者怀疑上下文压缩（compact）有问题，可以这样排查：

```
1. 启用过滤调试：claude --debug=compact
   → isDebugMode() 返回 true（memoize 缓存）
   → getDebugFilter() 解析出 'compact' pattern
   → 只有消息匹配 'compact' 的 logForDebugging 才输出

2. 实时跟踪：tail -f ~/.claude/debug/latest
   → 软链指向当前 session 日志，immediateMode sync 写入立即可见

3. 若进程崩溃：最后几行 sync 写入不会因 process.exit() 丢失
   → registerCleanup 也会 await pendingWrite

4. 若启动早期就出错（sink 未 attach）：
   → logError 入 errorQueue，attachErrorLogSink 时同步 drain，错误不丢
   → 同时 addToInMemoryErrorLog 保留最近 100 条供 bug report
```

这条流跑通后，日志既能在开发时即时可见，又能在生产时不丢错误。下一节的 Transcript 流解决的是另一类问题——不是给人即时看，而是给程序日后重放。

### 4.2 Transcript 流：从 recordTranscript 到 JSONL 黑匣子

#### 为什么需要

debug 日志是"开发期调试"的工具，transcript 是"生产期恢复"的关键——Agent 的黑匣子。如果说 debug 日志是飞机的"飞行数据记录器"（用于事后分析），那么 transcript 就是 Agent 的"黑匣子"，记录了从用户输入到 Agent 输出的完整对话。它要解决两个特殊问题：第一，**格式必须同时满足人可读和机器可恢复**——开发者要能 grep/jq，`--resume` 程序要能逐行流式读入重建状态；第二，**不能无脑追加**——同一批消息可能被 record 多次（重试、重放），必须去重并维护 `parentUuid` 链，否则恢复时消息链断裂。

#### 怎么做

**JSONL 格式选择**。Transcript 采用 JSONL（JSON Lines）格式，每行一个独立 JSON 对象，核心字段如下（`src/utils/sessionStorage.ts`）：

```
{
  "type": "user" | "assistant" | "system" | "attachment" | "summary" | ...,
  "subtype": "compact_boundary" | "attachment" | "turn_duration" | ...,
  "message": { "role": "...", "content": [...] },
  "uuid": "a1b2c3d4-...",
  "parentUuid": "parent-uuid",
  "sessionId": "session-id",
  "timestamp": "2026-07-04T12:34:56.789Z",
  "version": "2.2.1",
  "cwd": "/path/to/project",
  "gitBranch": "main",
  "isSidechain": false,
  "agentId": "...",           // sub-agent 标识
  "agentName": "Explore"      // sub-agent 类型名
}
```

JSONL 是经过权衡的选择：每行一个独立 JSON 对象，让人可以直接 grep/jq 分析（人可读），同时支持逐行流式读取恢复（机器可恢复）。相比之下，SQLite/结构化 DB 查询更快但不可读、需额外依赖；纯文本可读但无法结构化恢复。JSONL 在两者间取了平衡。`parentUuid` 字段是消息链的骨干——它把每条消息指向其前驱，形成一棵树（含 sidechain 分支），恢复时沿 `parentUuid` 重建对话走向。

**捕获范围的设计逻辑**。Transcript 不是什么都记，而是有选择地捕获"可恢复的、跨时间有用的"状态：

| 数据类别 | 是否记录 | 用途 |
|----------|---------|------|
| 用户输入（消息内容） | ✓ | 完整记录 |
| Agent 响应（消息内容） | ✓ | 完整记录 |
| 工具调用（tool_use） | ✓ | 完整记录（含 input） |
| 工具结果（tool_result） | ✓ | 完整记录（含 output） |
| Token 用量 | ✓ | 用于 budget 控制和统计 |
| File history snapshots | ✓ | 用于 /rewind 恢复 |
| Attribution snapshots | ✓ | 用于归因分析 |
| Content replacements | ✓ | 用于 /resume 恢复替换 |
| Compact boundaries | ✓ | 标记压缩点 |
| Goals / worktrees / PR links | ✓ | session-scoped 状态 |
| AbortController 状态 | ✗ | 运行时状态 |
| MCP 连接 | ✗ | 运行时状态 |
| Hook 注册 | ✗ | 运行时状态 |

记录的是"可恢复的、跨时间有用的"状态（消息、快照、压缩点），不记录"临时的、运行时独有"的状态（abort signal、MCP 连接、Hook 注册）。前者用于 `--resume` 重放和 `--rewind` 回滚，后者只对当前进程有意义，持久化只会浪费空间——abort signal 重放时早已失效，MCP 连接必须重新握手。

**去重与 parent chain 维护**。`recordTranscript`（`src/utils/sessionStorage.ts:1445-1486`）不是无脑追加，而是先查询已记录的 messageSet，区分 new / already-recorded 前缀，只写入新消息：

```typescript
// src/utils/sessionStorage.ts:1445-1486
export async function recordTranscript(messages, teamInfo?, startingParentUuidHint?, allMessages?) {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  
  // 区分 new / already-recorded 前缀
  const newMessages = []
  let startingParentUuid = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid)) {
      // 已记录消息仅当其为前缀时追踪 parentUuid
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages, false, undefined, startingParentUuid, teamInfo,
    )
  }
  
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}
```

这段去重逻辑的意图：同一批 messages 可能被 record 多次（例如一轮结束后整体 record、重试时再 record），如果无脑追加会产生重复行且 `parentUuid` 链断裂。`messageSet` 记录已落盘的 uuid，遇到已记录的就跳过写入，但若它在"前缀"位置（还没遇到新消息），就更新 `startingParentUuid` 指向它——这样新消息的 `parentUuid` 能正确接到已记录链的末尾，恢复时链不会断。详见 [17-persistence-and-cache.md](cc-17-persistence-and-cache.md)。

#### 具体实例

一次典型的会话恢复场景：

```
1. 原会话：用户问 "重构 foo.ts" → Agent 读文件 → 编辑 → 回复
   → recordTranscript 写入 4 条消息，parentUuid 链：
     user(uuid=A, parent=null) → assistant(uuid=B, parent=A)
       → tool_use(uuid=C, parent=B) → tool_result(uuid=D, parent=C)

2. 用户 Ctrl+C 退出，重新 claude --resume <sessionId>
   → loadTranscriptFile 逐行读 JSONL，沿 parentUuid 重建 4 条消息的链
   → 运行时状态（MCP 连接、abort signal）不恢复，需重建

3. 若中途发生 compact：
   → transcript 写入 subtype=compact_boundary 的标记行
   → 恢复时跳过 pre-compact 内容，只从 boundary 后重放，节省 token

4. 若 recordTranscript 被重复调用（重试场景）：
   → messageSet 命中已记录 uuid，跳过写入，无重复行
   → startingParentUuid 正确接续，链不断裂
```

Transcript 保证了会话可恢复，但它只能事后回放，无法在线观察执行链路。下一节的 Langfuse 追踪流补上"在线可视化"这一环。

---

### 4.3 Langfuse 追踪流：从 createTrace 到层级 observation

#### 为什么需要

Transcript 解决了"事后回放"，但开发者经常需要"在线观察" Agent 的执行链路——一次请求里 LLM 调用花了多久、TTFT（Time To First Token）是多少、哪个工具最慢、token 用在哪儿了。这些是分布式的、有层级的耗时与用量信息，线性日志无法表达。Langfuse 是一个 LLM 专用的可观测性平台，原生支持 Agent / Tool / Generation 的层级语义，比通用的 OpenTelemetry 后端更适合 Agent 场景——它知道"一次 LLM 调用"和"一次工具执行"是不同类型的 span，能按 LLM 语义渲染调用树、统计 token、展示 TTFT。此外，由于 Langfuse 是云端服务，用户工作内容（代码、路径、API key）可能在 span data 中暴露，因此这条流还必须内建数据脱敏。

#### 怎么做

**初始化（可选依赖）**。`initLangfuse`（`src/services/langfuse/client.ts:21-62`）在配置了 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 时才真正创建 SpanProcessor，否则整个追踪系统静默跳过：

```typescript
// src/services/langfuse/client.ts:21-62
export function initLangfuse(): boolean {
  if (processor !== null) return true
  if (!isLangfuseEnabled()) {
    logForDebugging('[langfuse] No keys configured, running in no-op mode')
    return false
  }
  
  try {
    const maskFn: MaskFunction = ({ data }) => sanitizeGlobal(data)
    
    processor = new LangfuseSpanProcessor({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
      flushAt: parseInt(process.env.LANGFUSE_FLUSH_AT ?? '20', 10),
      flushInterval: parseInt(process.env.LANGFUSE_FLUSH_INTERVAL ?? '10', 10),
      mask: maskFn,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? 'development',
      release: MACRO.VERSION,
      exportMode: (process.env.LANGFUSE_EXPORT_MODE as 'batched' | 'immediate' | undefined) ?? 'batched',
      timeout: parseInt(process.env.LANGFUSE_TIMEOUT ?? '5', 10),
    })
    
    provider = new BasicTracerProvider({ spanProcessors: [processor] })
    setLangfuseTracerProvider(provider)
    return true
  } catch (e) {
    logForDebugging(`[langfuse] Init failed: ${e}`, { level: 'error' })
    return false
  }
}

export function isLangfuseEnabled(): boolean {
  return !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY)
}
```

几个常量背后的意图：`flushAt: 20` 与 `flushInterval: 10` 是"批量大小 vs 延迟"的权衡——攒满 20 个 span 或过 10 秒就 flush 一次，既减少网络请求数，又保证 span 不会积压太久才在 UI 可见。`exportMode` 默认 `batched`（攒批上传），可切 `immediate`（实时上传，调试追踪时有用但开销大）。`mask: maskFn` 是关键——它把 `sanitizeGlobal` 挂在 SpanProcessor 层，**所有 span data 在离开本地前都强制过一遍脱敏**，业务代码无需逐处手动脱敏。这种"可选依赖 + 零开销跳过"的设计让追踪成为增量能力，不配置 key 时不会成为性能负担。

**追踪模型与 createTrace**。每个 Agent 会话对应一个 Langfuse Trace（agent observation），其下嵌套 LLM 调用（generation）、工具执行（tool observation）、sub-agent trace。这个层级反映 Agent 的执行结构：

```
每个 Agent 会话 = 一个 Langfuse Trace (agent observation)
  ├─► LLM 调用 (generation observation)
  │     ├─► input: messages + system prompt (+ tools)
  │     ├─► output: assistant message
  │     ├─► metadata: model, provider, thinking config
  │     ├─► usageDetails: input, output, cache_read, cache_creation
  │     └─► startTime / endTime / completionStartTime（TTFT 精度）
  │
  ├─► Tool batch span（并行 tool call 的包装）
  │     └─► Tool execution spans
  │           ├─► input: tool_name + sanitizeToolInput(input)
  │           ├─► output: sanitizeToolOutput(output)
  │           └─► metadata: toolUseId, isError, duration
  │
  └─► Sub-agent trace (agent observation)
        └─► 嵌套的 LLM 调用 + 工具执行
```

`asType` 字段（`agent` / `generation` / `tool` / `span`）是 Langfuse 的语义层级标记：`agent` 是一次 Agent 运行（根或 sub-agent），`generation` 是一次 LLM 调用（带 token 用量和 TTFT），`tool` 是一次工具执行，`span` 是通用包装（如 batch span）。后端 UI 据 `asType` 决定如何渲染——generation 显示模型和 token，tool 显示输入输出，这是"LLM 专用追踪"区别于通用 OTel 的关键。`createTrace`（`src/services/langfuse/tracing.ts:27-73`）创建根 agent observation：

```typescript
// src/services/langfuse/tracing.ts:27-73
export function createTrace(params: {
  sessionId: string
  model: string
  provider: string
  input?: unknown
  name?: string
  querySource?: string
  username?: string
}): LangfuseSpan | null {
  if (!isLangfuseEnabled()) return null
  try {
    const traceName = params.name ??
      (params.querySource ? `agent-run:${params.querySource}` : 'agent-run')
    
    const rootSpan = startObservation(
      traceName,
      {
        input: params.input,
        metadata: {
          provider: params.provider,
          model: params.model,
          agentType: 'main',
          ...(params.querySource && { querySource: params.querySource }),
        },
      },
      { asType: 'agent' },
    ) as RootTrace
    
    rootSpan.otelSpan.setAttribute(
      LangfuseOtelSpanAttributes.TRACE_SESSION_ID, params.sessionId,
    )
    rootSpan._sessionId = params.sessionId
    
    const userId = resolveLangfuseUserId(params.username)
    if (userId) {
      rootSpan.otelSpan.setAttribute(
        LangfuseOtelSpanAttributes.TRACE_USER_ID, userId,
      )
      rootSpan._userId = userId
    }
    return rootSpan as unknown as LangfuseSpan
  } catch (e) {
    logForDebugging(`[langfuse] createTrace failed: ${e}`, { level: 'error' })
    return null
  }
}
```

**用户 ID 解析优先级**：显式参数 > `LANGFUSE_USER_ID` env > `getCoreUserData().email` > `getCoreUserData().deviceId`。这一优先级让 `userId` 既能跨会话关联同一用户（email 最稳定），又能在 email 缺失时回退到 deviceId（至少机器可识别）。

**recordLLMObservation 与 TTFT 陷阱**。`recordLLMObservation`（`src/services/langfuse/tracing.ts:85-182`）记录一次 LLM 调用，含 token 用量和 TTFT。这里有两个细节值得展开：

```typescript
// src/services/langfuse/tracing.ts:85-182
export function recordLLMObservation(rootSpan, params) {
  if (!rootSpan || !isLangfuseEnabled()) return
  try {
    const genName = PROVIDER_GENERATION_NAMES[params.provider] ?? `Chat${params.provider}`
    
    // 使用全局 startObservation 而非 rootSpan.startObservation()
    // 实例方法只转发 asType，丢失 startTime，导致负 TTFT
    const gen: LangfuseGeneration = startObservation(
      genName,
      {
        model: params.model,
        input: params.tools 
          ? { messages: params.input, tools: params.tools }
          : params.input,
        metadata: {
          provider: params.provider,
          model: params.model,
          ...(params.thinking && { thinking: params.thinking }),
        },
        ...(params.completionStartTime && { completionStartTime: params.completionStartTime }),
      },
      {
        asType: 'generation',
        ...(params.startTime && { startTime: params.startTime }),
        parentSpanContext: rootSpan.otelSpan.spanContext(),
      },
    )
    
    // 关键：input_tokens 应为总 prompt tokens（uncached + cache_read + cache_creation）
    const cacheRead = params.usage.cache_read_input_tokens ?? 0
    const cacheCreation = params.usage.cache_creation_input_tokens ?? 0
    gen.update({
      output: params.output,
      usageDetails: {
        input: params.usage.input_tokens + cacheCreation + cacheRead,
        output: params.usage.output_tokens,
        ...(cacheRead > 0 && { cache_read: cacheRead }),
        ...(cacheCreation > 0 && { cache_creation: cacheCreation }),
      },
    })
    
    gen.end(params.endTime)
  } catch (e) {
    logForDebugging(`[langfuse] recordLLMObservation failed: ${e}`, { level: 'error' })
  }
}
```

第一个细节是注释点明的 **TTFT 陷阱**：必须用全局 `startObservation` 而非 `rootSpan.startObservation()`，因为实例方法只转发 `asType`、丢失 `startTime`，导致负 TTFT。TTFT = `completionStartTime - startTime`，是衡量 LLM 响应延迟的关键指标（用户等待首字的时间）。如果 `startTime` 丢失被默认成当前时间，而 `completionStartTime` 是更早的真实值，相减就出现负值，统计完全错误。这是一个典型的"库 API 不对称"问题——同名方法在全局调用和实例调用下行为不一致，必须从全局入口调用才能传递完整参数。

第二个细节是 **input_tokens 的合并**：注释明确"input_tokens 应为总 prompt tokens（uncached + cache_read + cache_creation）"。Anthropic API 把 prompt token 拆成三部分返回（未缓存、缓存命中、缓存写入），但 Langfuse 的 `input` 字段期望是总 prompt token。如果不合并只填 `input_tokens`，缓存命中的 token 会被漏算，token 统计偏低。因此这里显式三者相加填入 `input`，再把 cache 部分作为独立字段附加，既保证总量正确又保留缓存细节。

**Provider 名称映射**。`PROVIDER_GENERATION_NAMES` 让 Langfuse UI 通过 generation name 区分不同 provider 的调用：

```typescript
const PROVIDER_GENERATION_NAMES: Record<string, string> = {
  firstParty: 'ChatAnthropic',
  bedrock: 'ChatBedrockAnthropic',
  vertex: 'ChatVertexAnthropic',
  foundry: 'ChatFoundry',
  openai: 'ChatOpenAI',
  gemini: 'ChatGoogleGenerativeAI',
  grok: 'ChatXAI',
}
```

**Tool observation 与 batch span**。`recordToolObservation`（`src/services/langfuse/tracing.ts:184-248`）记录一次工具执行，输入输出都经过 `sanitizeToolInput` / `sanitizeToolOutput`（详见下文脱敏）：

```typescript
// src/services/langfuse/tracing.ts:184-248
export function recordToolObservation(rootSpan, params) {
  if (!rootSpan || !isLangfuseEnabled()) return
  try {
    const parentSpan = params.parentBatchSpan ?? rootSpan
    const toolObs = startObservation(
      params.toolName,
      {
        input: sanitizeToolInput(params.toolName, params.input),
        metadata: {
          toolUseId: params.toolUseId,
          isError: String(params.isError ?? false),
        },
      },
      {
        asType: 'tool',
        ...(params.startTime && { startTime: params.startTime }),
        parentSpanContext: parentSpan.otelSpan.spanContext(),
      },
    )
    
    toolObs.update({
      output: sanitizeToolOutput(params.toolName, params.output),
      ...(params.isError && { level: 'ERROR' as const }),
    })
    
    toolObs.end()
  } catch (e) {
    logForDebugging(`[langfuse] recordToolObservation failed: ${e}`, { level: 'error' })
  }
}
```

并行工具调用时，先创建一个 batch span 包装（`src/services/langfuse/tracing.ts:255-301`），后续 tool observation 的 `parentBatchSpan` 指向此 span。这样 UI 里并行工具会聚在一个 batch 下，而不是散落在 generation 同级，调用树结构更清晰：

```typescript
// src/services/langfuse/tracing.ts:255-301
export function createToolBatchSpan(rootSpan, params: { toolNames: string[]; batchIndex: number }) {
  if (!rootSpan || !isLangfuseEnabled()) return null
  try {
    const batchSpan = startObservation(
      `tools`,
      {
        metadata: {
          toolNames: params.toolNames.join(', '),
          toolCount: String(params.toolNames.length),
          batchIndex: String(params.batchIndex),
        },
      },
      { asType: 'span', parentSpanContext: rootSpan.otelSpan.spanContext() },
    ) as LangfuseSpan
    return batchSpan
  } catch (e) {
    return null
  }
}
```

**Sub-agent 与 child span**。Sub-agent 创建独立的 root span（`src/services/langfuse/tracing.ts:315-362`），嵌套在主 agent trace 下；侧查询（如 title/summary 生成）通过 `createChildSpan`（`src/services/langfuse/tracing.ts:368-426`）挂在 parentSpan 下。两者都复用 `startObservation` + `asType: 'agent'` 的模式：

```typescript
// src/services/langfuse/tracing.ts:315-362
export function createSubagentTrace(params: {
  sessionId: string
  agentType: string
  agentId: string
  model: string
  provider: string
  input?: unknown
  username?: string
}): LangfuseSpan | null {
  if (!isLangfuseEnabled()) return null
  try {
    const rootSpan = startObservation(
      `agent:${params.agentType}`,
      {
        input: params.input,
        metadata: {
          provider: params.provider,
          model: params.model,
          agentType: params.agentType,
          agentId: params.agentId,
        },
      },
      { asType: 'agent' },
    ) as RootTrace
    // ...
    return rootSpan as unknown as LangfuseSpan
  } catch (e) {
    return null
  }
}
```

```typescript
// src/services/langfuse/tracing.ts:368-426
export function createChildSpan(parentSpan, params: {
  name: string
  sessionId: string
  model: string
  provider: string
  input?: unknown
  querySource?: string
  username?: string
}): LangfuseSpan | null {
  if (!parentSpan || !isLangfuseEnabled()) return null
  // ... 在 parentSpan 下创建 child span
}
```

**数据脱敏（sanitize）——可观测性的最后一道防线**。Langfuse 是云端追踪服务，span data 离开本地前必须脱敏。脱敏分两层：全局脱敏挂在 SpanProcessor 的 `mask` 回调（所有 span 都过），工具脱敏在 `recordToolObservation` 调用时按工具类型差异化处理。

全局脱敏 `sanitizeGlobal`（`src/services/langfuse/sanitize.ts:46-54`）处理所有 span 的 input/output/metadata，分两种模式：string 直接正则替换 home 目录，object 递归处理：

```typescript
// src/services/langfuse/sanitize.ts:46-54
export function sanitizeGlobal(data: unknown): unknown {
  if (typeof data === 'string') {
    return data.replace(HOME_DIR_PATTERN, '~')
  }
  if (typeof data === 'object' && data !== null) {
    return sanitizeObject(data as Record<string, unknown>)
  }
  return data
}
```

`HOME_DIR_PATTERN`（`src/services/langfuse/sanitize.ts:25-41`）把所有 home 目录路径替换为 `~`，覆盖多种来源和平台变体：

```typescript
// src/services/langfuse/sanitize.ts:25-41
function homePathPatterns(): string[] {
  const homes = new Set<string>()
  for (const value of [process.env.HOME, process.env.USERPROFILE, homedir()]) {
    if (value) {
      homes.add(value)
      homes.add(value.replace(/\\/g, '/'))  // Windows path
    }
  }
  return [
    ...Array.from(homes, escapeRegExp),
    '/Users/[^/\\\\]+',                          // macOS
    '[A-Za-z]:[/\\\\]Users[/\\\\][^/\\\\]+',     // Windows
  ]
}
const HOME_DIR_PATTERN = new RegExp(`(?:${homePathPatterns().join('|')})`, 'g')
```

之所以要同时收集 `HOME`、`USERPROFILE`、`homedir()` 三个来源并加正斜杠变体，是因为同一台机器上不同进程可能解析出不同形式的 home 路径（环境变量 vs Node API、正斜杠 vs 反斜杠），脱敏必须覆盖所有变体才能保证不漏。额外的 `/Users/<name>`（macOS 通用）和 `[A-Za-z]:[/\\]Users[/\\]<name>`（Windows 通用）模式则是兜底——即使环境变量缺失，也能按平台惯例匹配。

`SENSITIVE_KEY_PATTERN`（`src/services/langfuse/sanitize.ts:43-44`）匹配**键名**（非值），命中后整个字段值置为 `'[REDACTED]'`：

```typescript
// src/services/langfuse/sanitize.ts:43-44
const SENSITIVE_KEY_PATTERN = /(?:api_?key|token|secret|password|credential|auth_header)/i
```

匹配：`api_key`、`apiKey`、`token`、`secret`、`password`、`credential`、`auth_header`。

`sanitizeObject` 递归逻辑（`src/services/langfuse/sanitize.ts:56-70`）优先顺序：①键名匹配 → `'[REDACTED]'`；②值是 string → 替换 home；③值是 object → 递归；④其他 → 原样。

**工具类别差异化脱敏**是这条流最值得品味的部分。`sanitizeToolInput`（`src/services/langfuse/sanitize.ts:72-88`）只扫顶层 key：敏感键置 `[REDACTED]`，对 `file_path`/`path`/`directory` 三个固定 key 做 HOME_DIR_PATTERN 替换（不递归，避免污染深层数据）：

```typescript
// src/services/langfuse/sanitize.ts:72-88
export function sanitizeToolInput(_toolName: string, input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input
  const obj = { ...(input as Record<string, unknown>) }
  
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      obj[key] = '[REDACTED]'
    }
  }
  
  for (const key of ['file_path', 'path', 'directory'] as const) {
    if (key in obj && typeof obj[key] === 'string') {
      obj[key] = (obj[key] as string).replace(HOME_DIR_PATTERN, '~')
    }
  }
  return obj
}
```

`sanitizeToolOutput`（`src/services/langfuse/sanitize.ts:90-103`）按工具类型分类处理：

```typescript
// src/services/langfuse/sanitize.ts:90-103
const REDACTED_FILE_TOOLS = new Set(['FileReadTool', 'FileWriteTool', 'FileEditTool'])
const REDACTED_SHELL_TOOLS = new Set(['BashTool', 'PowerShellTool'])
const SENSITIVE_OUTPUT_TOOLS = new Set(['ConfigTool', 'MCPTool', 'VaultHttpFetch', 'LocalVaultFetch'])
const MAX_OUTPUT_LENGTH = 500

export function sanitizeToolOutput(toolName: string, output: string): string {
  if (REDACTED_FILE_TOOLS.has(toolName)) {
    return `[file content redacted, ${output.length} chars]`
  }
  if (REDACTED_SHELL_TOOLS.has(toolName)) {
    if (output.length > MAX_OUTPUT_LENGTH) {
      return output.slice(0, MAX_OUTPUT_LENGTH) + '\n[truncated]'
    }
  }
  if (SENSITIVE_OUTPUT_TOOLS.has(toolName)) {
    return `[${toolName} output redacted, ${output.length} chars]`
  }
  return output
}
```

为什么需要差异化策略，而不是全部替换为 `[REDACTED]`？因为通用脱敏会让 trace 完全无法用于调试——开发者看不到工具做了什么，trace 就失去意义。差异化策略在"保护隐私"和"保留调试价值"之间按工具敏感度分级：File 工具输出是代码内容（高敏感，且 trace 里不需要看代码全文），完全 redacted 只留长度；Bash 输出可能很长但通常不含代码（中等敏感），截断到 500 字符——这个数字够看到命令执行的结果摘要（错误信息、状态码），又不会把整个日志刷屏；ConfigTool/MCPTool/Vault 涉及配置和密钥（高敏感），完全 redacted；普通工具输出假设安全，原样保留。`MAX_OUTPUT_LENGTH = 500` 就是"够诊断又不泄密"的经验值。

脱敏的完整效果示例：

| 输入 | 输出 |
|------|------|
| `"/home/alice/projects/secret.env"` | `"~/projects/secret.env"` |
| `{ api_key: "sk-ant-xxx", cwd: "/home/alice/x" }` | `{ api_key: "[REDACTED]", cwd: "~/x" }` |
| `{ token: 12345, message: "hello" }` | `{ token: "[REDACTED]", message: "hello" }` |
| `"/Users/bob/Library/secrets.txt"` | `"~/Library/secrets.txt"` |

#### 具体实例

追踪一次"读文件 + 跑 shell"的并行工具调用：

```
1. 会话开始：createTrace({sessionId, model:'claude-...', provider:'firstParty'})
   → Langfuse UI 出现一个 agent-run trace

2. LLM 决定并行调用 FileReadTool + BashTool：
   → recordLLMObservation: generation span，含 TTFT、token（input 合并 cache）
   → createToolBatchSpan({toolNames:['FileReadTool','BashTool'], batchIndex:0})
   → recordToolObservation(FileReadTool, {input:{file_path:'/home/alice/x.ts'}})
       sanitizeToolInput: file_path → '~/x.ts'
       sanitizeToolOutput: '[file content redacted, 1234 chars]'  // 代码不外泄
   → recordToolObservation(BashTool, {input:{command:'ls'}})
       sanitizeToolOutput: 输出 <500 字符原样，>500 截断 + '[truncated]'

3. SpanProcessor flush 时，mask 回调对所有 span 跑 sanitizeGlobal：
   → home 路径全替换为 ~，api_key/token 等键名置 [REDACTED]
   → 数据安全离开本地，到达 Langfuse 云端

4. UI 上看到的调用树：
   agent-run
   ├─ ChatAnthropic (generation, TTFT=320ms, input=1500, output=200)
   └─ tools (batch span)
       ├─ FileReadTool (input: {file_path:'~/x.ts'}, output: redacted)
       └─ BashTool (input: {command:'ls'}, output: 'file1\nfile2...')
```

Langfuse 补上了"在线可视化执行链路"，但它服务的是开发调试。下一节的分析埋点流面向产品运营，解决的是"功能使用率与性能趋势"的统计问题，并带来一套更严格的类型驱动 PII 保护。

---

### 4.4 分析埋点流：从 logEvent 到双 sink fanout

#### 为什么需要

Langfuse 追踪是"详细链路"（一个 trace 包含完整执行过程），分析埋点是"汇总统计"（一个事件代表一次使用）。后者把使用情况发送到 Datadog 和 First-party BigQuery，用于监控功能使用率、性能趋势、用户行为分析。它有两个特殊挑战：第一，**两个后端访问控制不同**——Datadog 是通用监控平台（广访问），1P BQ 是有访问控制的列存储（窄访问），同样的 PII 数据只能进 BQ 不能进 Datadog；第二，**PII 检测不能靠自动扫描**——自然语言中"敏感信息"边界模糊，自动检测既漏报又误报，必须在编译期由开发者显式声明。这两个挑战分别由"双 sink 路由 + stripProtoFields"和"类型驱动 PII 标记"解决。

#### 怎么做

**事件流与队列**。业务代码调用 `logEvent(eventName, metadata)`（`src/services/analytics/index.ts:133-144`），事件先入队，sink 附加后由 `logEventImpl`（`src/services/analytics/sink.ts:48-72`）处理：

```
业务代码
  → logEvent(eventName, metadata)  (src/services/analytics/index.ts:133-144)
    → 事件入队（sink 未附加时）
    → sink 附加后 → logEventImpl()  (src/services/analytics/sink.ts:48-72)
      ├─► shouldSampleEvent(eventName) → 采样判断
      ├─► stripProtoFields(metadata) → 移除 _PROTO_* 键
      ├─► trackDatadogEvent() → Datadog RUM
      └─► logEventTo1P() → First-party BQ（含 _PROTO_* 字段）
```

事件流的关键点是 **`_PROTO_*` 字段只在 1P BQ 保留，在 Datadog 被剥离**。这是双 sink 路由的核心——敏感 PII 数据只发送到有访问控制的 BQ 列，不发送到 Datadog 这种通用监控平台。

`logEventImpl` 的双 sink fanout 实现：

```typescript
// src/services/analytics/sink.ts:48-72
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  const sampleResult = shouldSampleEvent(eventName)
  if (sampleResult === 0) return  // 未选中
  
  const metadataWithSampleRate = sampleResult !== null
    ? { ...metadata, sample_rate: sampleResult }
    : metadata
  
  if (shouldTrackDatadog()) {
    // Datadog 是 general-access backend — strip _PROTO_*
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }
  
  // 1P 接收完整 payload（含 _PROTO_*）
  logEventTo1P(eventName, metadataWithSampleRate)
}
```

注意 Datadog 路径用 `stripProtoFields` 剥离 `_PROTO_*`，1P 路径保留完整 payload。同一个事件被 fanout 到两个后端，但 PII 字段只在有访问控制的那一端可见。

**类型驱动的 PII 保护**。这是本流最精巧的设计。`src/services/analytics/index.ts:19-33` 定义了两个 `never` 类型的标记类型和 `stripProtoFields`：

```typescript
// src/services/analytics/index.ts:19-33
/**
 * Marker type for verifying analytics metadata doesn't contain sensitive data
 * 强制开发者显式确认 string 值不含代码片段、文件路径等敏感信息
 * Usage: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * Marker type for values routed to PII-tagged proto columns via `_PROTO_*`
 * payload keys. The destination BQ column has privileged access controls,
 * so unredacted values are acceptable — unlike general-access backends.
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * Strip `_PROTO_*` keys from a payload destined for general-access storage.
 * sink.ts 在 Datadog fanout 前调用；1P exporter 保留
 */
export function stripProtoFields<V>(metadata: Record<string, V>): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) result = { ...metadata }
      delete result[key]
    }
  }
  return result ?? metadata
}
```

两层类型标记各有用途：

1. `I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` — 普通 metadata，强制开发者用 `as` 断言确认该 string 不含代码/路径。类型是 `never`，所以必须显式 `as` 才能赋值，编译器逼着开发者停下来想一秒"这个值真的不敏感吗"。
2. `I_VERIFIED_THIS_IS_PII_TAGGED` — `_PROTO_*` 字段，声明这个值是 PII-tagged、只能进有访问控制的 BQ 列。

**类型标记的设计意图**：自动检测无法保证 100% 准确（自然语言中的"敏感信息"边界模糊——一个文件路径算不算敏感？一段含变量的代码片段呢？），而类型系统可以在编译期强制开发者手动声明"这个值不含敏感信息"或"这个值是 PII-tagged"。这种"人类判断 + 编译器约束"的组合比纯自动检测更可靠——它不试图解决"什么是敏感的"这个无解问题，而是把判断责任明确压到开发者身上，并用类型系统阻止遗漏。

**`_PROTO_*` 字段的完整流转**：
- 业务代码 → metadata 中以 `_PROTO_xxx` 为键
- sink.ts → `stripProtoFields()` 移除 → Datadog 看不到
- 1P exporter → 保留并 hoist 到顶层 proto field（BQ 的 PII-tagged 列）

**Sink 附加与队列**。`attachAnalyticsSink`（`src/services/analytics/index.ts:95-123`）与错误日志的 sink 队列同构，但 drain 用 `queueMicrotask` 而非同步：

```typescript
// src/services/analytics/index.ts:95-123
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) return  // Idempotent
  sink = newSink
  
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0
    
    if (process.env.USER_TYPE === 'ant') {
      sink.logEvent('analytics_sink_attached', { queued_event_count: queuedEvents.length })
    }
    
    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}
```

**为什么用 `queueMicrotask` 而不是同步 drain**（与错误日志的同步 drain 形成对比）？同步 drain 会在 `attachAnalyticsSink` 的调用栈中执行所有队列事件，可能阻塞启动流程数十毫秒。错误日志可以容忍同步阻塞（错误必须立即可见），但埋点是统计性数据，延迟几毫秒无伤大雅，不应拖慢启动。`queueMicrotask` 把 drain 推迟到当前同步代码执行完后，保证 sink 附加是非阻塞的。`USER_TYPE === 'ant'` 时多发一条 `analytics_sink_attached` 事件，方便内部观测队列积压情况。`Idempotent`（先到先得）和"index.ts 不导入 sink/datadog"避免循环依赖，与第二章的单向依赖原则一脉相承。

**采样、killswitch、GrowthBook gate**。这三层控制让埋点可运营：采样控制量、killswitch 应急关、gate 灰度。

`shouldSampleEvent`（`src/services/analytics/firstPartyEventLogger.ts`）返回 0（不发送）、正数（发送并附 `sample_rate`）、null（无采样配置）。返回的 `sample_rate` 会写入 metadata，让后端能反推真实事件量（`真实量 = 收到量 / sample_rate`）。

`isSinkKilled`（`src/services/analytics/sinkKillswitch.ts`）允许运营 kill switch 关闭某个 sink（如 datadog）的所有事件发送——出问题时无需重新发布即可止损。

`shouldTrackDatadog`（`src/services/analytics/sink.ts:29-43`）通过 GrowthBook 远程配置 Datadog gate，可灰度开启/关闭，并缓存上一会话的值作为 fallback：

```typescript
// src/services/analytics/sink.ts:29-43
function shouldTrackDatadog(): boolean {
  if (isSinkKilled('datadog')) return false
  if (isDatadogGateEnabled !== undefined) return isDatadogGateEnabled
  // Fallback to cached value from previous session
  try {
    return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
  } catch {
    return false
  }
}
```

fallback 到缓存值的设计意图：网络故障时 GrowthBook 配置拉不到，与其让埋点全丢，不如沿用上次的配置——埋点不是关键路径，可用性优于精确性。

#### 具体实例

一个含 PII 的工具使用埋点：

```
1. 业务代码（某工具执行后）：
   logEvent('tool_used', {
     tool_name: 'FileReadTool',           // 普通 metadata，已确认非敏感
     duration_ms: 42 as I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
     _PROTO_file_path: '/home/alice/x.ts' // PII-tagged，走 _PROTO_ 前缀
       as I_VERIFIED_THIS_IS_PII_TAGGED,
   })

2. logEventImpl 处理：
   → shouldSampleEvent('tool_used') 假设返回 10（采样 1/10）
   → metadata.sample_rate = 10
   → shouldTrackDatadog()=true：
       trackDatadogEvent('tool_used', stripProtoFields(metadata))
         → Datadog 收到 {tool_name, duration_ms, sample_rate:10}  // 无 file_path
   → logEventTo1P('tool_used', metadata)  // 完整 payload
         → BQ 收到 {tool_name, duration_ms, sample_rate:10, _PROTO_file_path}
         → _PROTO_file_path hoist 到 BQ 的 PII-tagged 列（有访问控制）

3. 运营反推真实量：收到 100 条 / sample_rate 10 = 真实 1000 次 tool_used
4. 若 datadog 出问题：运营 killswitch 关闭 datadog sink，1P BQ 不受影响
```

这条流跑通后，埋点既能统计产品指标，又能把 PII 严格限定在受控后端。至此四条数据流——日志、Transcript、Langfuse、埋点——已逐一拆解。但当 Agent 真的出问题时，开发者面对的是"先看哪个"的实际抉择，下一节把四条流合成为一份排错手册。

### 4.5 综合应用：故障排查路径

前四节分别讲了四条数据流的内部机制，本节把它们合成为实战排错手册。当 Agent 出现问题时，核心策略是"**从距离问题最近的数据开始，逐步扩展到距离更远但信息更丰富的数据**"——例如 Agent 行为异常时，transcript JSONL 直接记录了 Agent 当时的输入输出（最近），debug 日志记录了底层执行细节（更远），Langfuse trace 提供了可视化的完整链路（最远但最直观）。

| 症状 | 先看什么 | 再看什么 | 最后看什么 |
|------|---------|---------|-----------|
| Agent 行为异常 | transcript JSONL | debug 日志 (`--debug`) | Langfuse trace |
| 权限弹窗过多 | `settings.json` permissions | Hook 配置 | deny rules |
| 性能问题/慢 | startup profiler | token 用量统计 | LLM API 延迟 |
| 工具执行失败 | transcript tool_result | debug 日志 (stderr) | MCP server 日志 |
| 上下文压缩异常 | compact 日志 | transcript compact_boundary | token 计数 |
| 启动失败 | `--debug` stderr | config 文件完整性 | 环境变量冲突 |
| PII 泄露担忧 | Langfuse sanitize 配置 | Datadog gate 状态 | `_PROTO_*` 字段使用 |
| 错误反复出现 | `getInMemoryErrors()` | error log sink | logEvent 采样配置 |
| Resume 后行为不同 | transcript 一致性（`checkResumeConsistency`） | compact preserved segment | snip removed range |

这张表的每一行都是"先近后远"原则的具体化。以"Agent 行为异常"为例：transcript 是 Agent 当时真实看到的输入输出（最近、最权威），先看它能快速判断是"输入有问题"还是"Agent 决策有问题"；若 transcript 看不出端倪，再看 debug 日志的底层执行细节（shell 命令、cwd、stderr）；若仍不够，Langfuse trace 提供 TTFT、token、调用树的完整可视化。

**详细的 Debug 工作流**：

```
1. 启用 debug 日志
   claude --debug
   或
   DEBUG=1 claude

2. 实时跟踪日志
   tail -f ~/.claude/debug/latest

3. 过滤特定 pattern
   claude --debug=compact  # 只显示 compact 相关日志

4. 查看错误
   bun run health
   或通过 getInMemoryErrors()（程序化）

5. 查看 transcript
   ls ~/.claude/projects/
   # 选择 sessionId 后 cat 或 jq 分析

6. Langfuse UI
   # 如果配置了 LANGFUSE_*，查看 cloud.langfuse.com

7. 重放问题
   claude --resume <sessionId>
```

这套工作流把本章四条数据流的出口串了起来：`--debug` 开日志流、`~/.claude/debug/latest` 是日志出口、`~/.claude/projects/` 是 transcript 出口、Langfuse UI 是追踪出口、`--resume` 用 transcript 重放。掌握了这张表和这套流程，就掌握了在四类可观测性数据间快速跳转的能力。

---

## 五、设计决策与权衡

第四章走完了四条数据流的实现细节，本节把这些细节背后的关键决策梳理出来。每个决策都反映了"透明度 vs 隐私"、"灵活性 vs 复杂度"、"实时性 vs 性能"的权衡——理解这些权衡，才能判断何时沿用、何时偏离。

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| Transcript 格式 | JSONL（每行独立 JSON） | SQLite/结构化 DB | JSONL 人可读、可 grep/jq、跨平台；无需额外依赖；可逐行流式恢复。代价是比 DB 查询慢、文件偏大，但会话恢复场景读取量有限，可接受 |
| 日志级别 | 多级（verbose→error）+ 环境变量控制 | 硬编码级别 | 不同场景需要不同详细程度——开发需要 verbose，生产只需要 error。环境变量让切换不改代码 |
| Debug 写入模式 | BufferedWriter（1s flush） | 实时写入 | 减少 I/O 频率；cleanup handler 保证退出时 flush。非 debug 场景日志只是后台记录，没必要每条都落盘 |
| Debug immediateMode | sync 写入（debug 模式） | 统一 buffered | `process.exit()` 时 async 写入会丢失；sync 写入保证崩溃现场可见。代价是 debug 模式下 I/O 较慢，但 debug 场景可接受 |
| 分析埋点 | 事件队列 + 异步 sink | 同步直接发送 | 不阻塞业务逻辑；sink 可插拔（killswitch 关闭）。统计性数据容忍延迟 |
| 错误日志 drain | 同步 drain | 异步 drain（如埋点） | 错误的实时性直接影响 debug 体验，必须立即可见；埋点则可异步 |
| 追踪后端 | Langfuse (OpenTelemetry) | 自建追踪系统 | Langfuse 是 LLM 专用追踪平台，原生支持 Agent/Tool/Generation 语义，避免重复造轮子 |
| Langfuse 可选依赖 | 未配置 key 时整体 no-op | 始终初始化 | 追踪是增量能力，不应成为性能负担；零开销跳过让未配置用户无感 |
| PII 保护 | 类型标记 + strip 机制 | 自动检测脱敏 | 类型系统强制开发者手动确认数据不含敏感信息；strip 在路由层处理。自动检测边界模糊不可靠 |
| 双 sink 路由 | Datadog + 1P BQ，stripProtoFields 区分 | 单一后端 | 两个后端访问控制不同：PII 只进有访问控制的 BQ，不进通用 Datadog。一个后端无法同时满足"广访问统计"和"窄访问存 PII" |
| 调试模式 | `--debug` flag + 环境变量 | 配置文件 | CLI 工具的调试开关应该在命令行直接控制，不需要改配置文件；一次调试用一次参数 |
| 错误日志 | 内存 FIFO + Sink 队列 | 实时输出 | 业务代码可能早于 sink 初始化；队列保证不丢失。内存 FIFO 供 bug report，sink 队列供上报 |
| LogError 黑名单 | Bedrock/Vertex/Foundry 禁用 | 统一行为 | 云厂商自己处理错误，CLI 不重复上报，避免双重计费/噪音 |
| 脱敏策略 | 工具类型分类（file/shell/sensitive） | 全部脱敏 | 平衡可观测性与隐私：非敏感工具保留完整输出，否则 trace 失去调试价值 |
| Shell 输出截断 | 500 字符 | 全留或全删 | 500 字符够看到命令结果摘要（错误、状态码），又不会刷屏或泄密 |

---

## 六、可复用的模式

本章最后提炼可迁移到其他 Agent / 复杂系统的设计模式。这些模式不依赖 Claude Code 的具体实现，是可观测性体系的通用解法。

- **Transcript 模式**：完整记录 Agent 的每一轮推理和行动，JSONL 格式兼顾人可读和机器可恢复，用 `parentUuid` 串成可重放的链。是 Agent 系统的"黑匣子"——任何需要"会话恢复"或"行为回放"的系统都应有一份等价物。

- **Hook-as-Trace-Point 模式**：复用 Hook 系统（SessionStart/PreToolUse/PostToolUse/Stop）作为分布式追踪的埋点，无需额外侵入业务代码。把内置执行事件同时暴露给用户自定义后端，兼顾开箱即用与可扩展。

- **多级日志路由模式**：通过环境变量控制日志级别和输出目标（文件/stderr/null），开发调试和生产环境使用不同配置。`memoize` 缓存判定结果避免高频开销。

- **类型驱动的 PII 保护模式**：用 TypeScript `never` 标记类型（`I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` / `I_VERIFIED_THIS_IS_PII_TAGGED`）强制开发者手动确认数据不含敏感信息，编译期检查。把"什么是敏感的"这个无解问题转化为"开发者显式声明"的可操作流程。

- **事件队列 + 异步 sink 模式**：分析埋点通过事件队列解耦业务逻辑和发送逻辑，sink 可插拔、可 killswitch。业务代码随时调用，不依赖 sink 就绪时序。

- **Sink Attachment 模式**：模块在 `index.ts` 中定义无依赖的 API，业务代码直接调用；在 `sink.ts` 中定义有依赖的具体实现，启动时 `attachSink()`。允许循环依赖场景下的解耦，把重依赖挡在启动路径之外。

- **Idempotent Attach**：`attachErrorLogSink` 和 `attachAnalyticsSink` 多次调用安全（先返回先得），允许从 preAction hook 和 setup() 多次调用而不冲突。

- **同步 vs 异步 drain 的差异化**：错误日志同步 drain（实时性优先），分析埋点 `queueMicrotask` 异步 drain（不阻塞启动）。同一套队列模式按数据实时性需求分化。

- **Global mask 回调**：Langfuse SpanProcessor 通过 `mask` 函数在 SDK 层面脱敏所有 span data，业务代码无需关心。把脱敏收敛在出口一处，比散落各处手动脱敏更不易漏。

- **Multi-sink Fanout + 字段级路由**：Datadog + 1P BQ 双 sink，相同事件分别发送；通过 `stripProtoFields` 在 fanout 前按字段敏感度分流。一个事件、两个后端、不同访问控制，用字段前缀（`_PROTO_*`）编码去向。

- **immediateMode 按需切换**：BufferedWriter 按 `isDebugMode()` 在 sync 立即写和 buffered 批量写间切换，同一套写入器适配"开发要即时可见"和"生产要低开销"两种场景。

- **可选依赖零开销跳过**：`isLangfuseEnabled()` 检查让追踪成为增量能力，未配置 key 时整体 no-op。增量能力不应成为基础路径的性能负担。

