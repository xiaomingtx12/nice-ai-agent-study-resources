---
slug: /application-notes/engineering/claude-code-cli/cc-02-harness-design
sidebar_position: 2
title: "Harness 设计"
description: "包裹 LLM 的整套外壳系统。本篇把它拆成十二个组件、点对源码映射、还原一次请求穿过 Harness 的完整路径。"
---

# Harness 设计：如何包裹 LLM 来构造可靠的 Agent

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2（逆向工程复刻仓库 `claude-code-best/claude-code`，V5 主线，HEAD `d0713bdd`）。该仓库是对 Anthropic Claude Code CLI 的反编译还原，行为层一致、源码层有差异——正文 `src/...` 指向还原仓库内部模块，不能直接对官方 CLI 验证；行号以该 HEAD 为准，可能漂移，以函数名定位。
>
> **核心路径**：
>
> - **组件清单主轴**：`src/query.ts`（2057 行）+ `src/QueryEngine.ts`（1365 行）的循环层——本文主线，正文三节按"职责 + 关键文件 + 典型证据"逐个点亮 12 组件，循环层是其中唯一中枢。
> - **进程级状态单例**：`src/bootstrap/state.ts`（1737 行，`:326` 生成 sessionId、`:462-473` `switchSession()` 原子切换、`:31` 禁止继续扩张的注释）——会话层与状态层共用同一份 module-level 单例，正文三节组件 2、3 对应。
> - **上下文装配入口**：`src/context.ts:116` 的 `getSystemContext()`、`:155` 的 `getUserContext()`——两个 memoized 函数决定模型每轮看到什么，会话内只算一次是 Prompt Cache 省钱的前提，正文三节组件 5 对应。
> - **能力与准入边界**：`src/Tool.ts`（802 行）、`src/tools.ts`（422 行）、`src/utils/permissions/permissions.ts`（1507 行）——工具注册表定义"能做什么"，`canUseTool` 5 层链定义"被允许做什么"，正文三节组件 6、7 与四节步骤 7/13/15 对应。
> - **稳定机制代码锚点**：`src/services/api/claude.ts:847` 的 `retryOptions` 与 `:819` 的 `fallbackModel`、`src/utils/messages.ts:5591` 的 `ensureToolResultPairing()`——重试降级与消息修复两条链，正文七节 6 大稳定机制与三层映射表的主要落点。
> - **持久化与可观测**：`src/utils/sessionStorage.ts`（5247 行 JSONL 读写 + 消息树）、`src/utils/telemetry/`（OTel span 与埋点）——决定崩溃后能否恢复、事后能否还原现场，正文三节组件 10、11 与四节步骤 18/19 对应。

**读完本篇你能回答**：Harness 在本项目里到底指什么？12 个组件各自承担什么、彼此怎么串联？为什么多包一层比裸调 SDK 更可靠？哪些问题是 Harness 故意不解决的？

**配套阅读**：读完 [04-agent-loop](../02-agent-runtime/cc-04-agent-loop.md) 会知道 §三 的"组件 4 循环层"如何作为中枢运转；读完 [06-context-assembly](../02-agent-runtime/cc-06-context-assembly.md) 会知道 §三 的"组件 5 上下文层"如何装配 system prompt。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | Harness 这个词在本项目里指什么 | 必读，建立概念边界 |
| 二 | 一句话架构定位 + 心智模型 | 必读，全文坐标 |
| 三 | Harness 十二大组件清单与代码映射 | 核心章节，可当参考手册 |
| 四 | 一次完整请求的 Harness 路径 | 核心章节，看数据怎么穿组件 |
| 五 | Harness 与传统 LLM SDK 的关键差异 | 必读，理解"多包了一层"的具体内容 |
| 六 | 关键设计决策 | 理解为什么这套包裹是必要的 |
| 七 | Harness 如何让模型稳定：失败模式与稳定机制 | **核心章节**，LLM 不可靠 → Harness 怎么兜底 |
| 八 | 边界与局限 | 知道它不解决什么 |

---

## 一、Harness 指什么

在 Claude Code / Claude Agent SDK 的语境里，**Harness 是一个比"Agent 循环"更大的概念**。Agent 循环是 Reason → Act → Observe 的 while-true；Harness 是包裹 LLM 的**整套运行时基础设施**——它让 LLM 能在一个有状态、有边界、有工具、有审批、有持久化、有可观测性的环境里反复推理，而不是裸调 `client.messages.create()`。

本项目的 Harness 由**入口、会话、状态、循环、上下文、工具、权限、UI、Hook、持久化、可观测性、Provider 适配**十二大组件构成。它们不是平铺的功能清单，而是有清晰依赖关系的分层架构：

```
┌──────────────────────────────────────────────────────────────┐
│  1. 入口层    cli.tsx 快速路径 + Commander                  │ ← 决定一次启动走哪条路
├──────────────────────────────────────────────────────────────┤
│  2. 会话层    sessionId + projectRoot + parentSessionId     │ ← 标识"现在这轮对话是谁"
├──────────────────────────────────────────────────────────────┤
│  3. 状态层    bootstrap/state.ts 模块级单例                 │ ← 进程级共享状态（120+ 字段）
├──────────────────────────────────────────────────────────────┤
│  4. 循环层    query.ts + QueryEngine.ts                     │ ← ReAct + 上下文装配
├──────────────────────────────────────────────────────────────┤
│  5. 上下文层  context.ts + claudemd + systemPrompt          │ ← 决定模型"看到什么"
├──────────────────────────────────────────────────────────────┤
│  6. 工具层    Tool.ts 接口 + tools.ts 注册表                │ ← 决定模型"能做什么"
├──────────────────────────────────────────────────────────────┤
│  7. 权限层    permissions.ts 5 层检查 + classifier          │ ← 决定模型"被允许做什么"
├──────────────────────────────────────────────────────────────┤
│  8. UI 层     Ink/React 组件 + REPL.tsx                     │ ← 决定用户"看到什么、能输入什么"
├──────────────────────────────────────────────────────────────┤
│  9. Hook 层   utils/hooks.ts + AsyncHookRegistry            │ ← 注入确定性约束
├──────────────────────────────────────────────────────────────┤
│  10. 持久化层 sessionStorage.ts JSONL + MessageTree         │ ← 决定会话"怎么存、怎么恢复"
├──────────────────────────────────────────────────────────────┤
│  11. 可观测层 OTel + analytics + langfuse + transcript      │ ← 决定运维"能不能排障"
├──────────────────────────────────────────────────────────────┤
│  12. Provider  services/api/{claude,openai,gemini,grok,...} │ ← 决定"对接哪家 LLM"
└──────────────────────────────────────────────────────────────┘
```

这十二层不是凭空切出来的。每层都对应一个具体的工程问题，而项目的代码组织恰好按这套问题边界切分。下面用一次请求的完整路径（第四节）来验证这十二层确实是必要的——任何一层缺失，整个 Agent 都会从"可靠"退化成"玩具"。

---

## 二、一句话架构定位

**Claude Code 是一个为 LLM 设计的、带五层权限防御的、支持 7 个 LLM Provider 的、可用 Hook 注入确定性约束的、有完整会话恢复与可观测性的 Harness。** 它把 Anthropic SDK 的 `client.messages.stream()` 包裹成可以从命令行启动、可以中断、可以恢复、可以远程控制、可以多端协议桥接的工业级 Agent 运行时。

**心智模型**：把 Harness 想成"LLM 的操作系统"。LLM 是 CPU，Harness 是内核 + 系统调用 + 文件系统 + 进程调度 + 权限管理。`query()` 是系统调用入口，`tool` 是 syscall，`sessionStorage` 是文件系统，`Hook` 是中断向量表，`permission` 是 capability，`sessionId` 是 PID。开发者写的代码是用户态程序，CLI 参数是启动参数，CLAUDE.md 是 initrd。

---

## 三、Harness 十二大组件清单与代码映射

下表是本文最核心的一节。每个组件给出**一句话职责 + 关键文件 + 行数 + 在哪篇文档里有完整展开**。读完全表就能在脑中重建 Harness 的完整骨架。

### 组件 1：入口层（Entry Layer）

**职责**：解析 CLI 参数、决定走哪条快速路径、最小化冷启动开销。

**关键文件**：
- [src/entrypoints/cli.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/entrypoints/cli.tsx) — 363 行，`main()` 函数按优先级处理 16+ 快速路径
- [src/main.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/main.tsx) — 5640 行，Commander.js CLI definition，全功能主路径
- [src/entrypoints/init.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/entrypoints/init.ts) — 一次性初始化（telemetry、config、trust dialog）

**在 Harness 中的位置**：Harness 的"启动器"。和传统 LLM SDK 最大的差异之一——SDK 是库，没有入口；CLI Harness 必须把 50+ 子命令路由到不同的代码路径，且不能让 `--version` 加载 17MB 模块。

**典型证据**：`cli.tsx:80` 的 `--version` 快速路径**零模块加载**——args 长度=1 且匹配标志就直接 console.log 后 return，连 `import` 都跳过。这条优化让 `claude --version` 启动时间从 ~2s（默认路径）降到 50ms。

**展开阅读**：[03-entry-and-lifecycle](cc-03-entry-and-lifecycle.md)（注意：本文作为新插入的 02，原 02 已后移为 03）。

---

### 组件 2：会话层（Session Layer）

**职责**：标识一次对话的身份、生命周期、父子关系；让 Harness 能区分"这是哪个项目的哪一轮对话"。

**关键文件**：
- [src/bootstrap/state.ts:326](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) — `STATE.sessionId = randomUUID() as SessionId`，启动时生成 UUID
- [src/bootstrap/state.ts:429-444](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) — `regenerateSessionId()` / `getSessionId()` / `getParentSessionId()`
- [src/bootstrap/state.ts:462-473](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) — `switchSession()` 原子切换 + `onSessionSwitch` 信号
- [src/types/ids.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/ids.ts) — `SessionId`、`AgentId` 的 branded type 定义

**在 Harness 中的位置**：会话是 Harness 的"进程 ID"。和 SDK 的差异：SDK 调用是 stateless 的，每次 `messages.create()` 都从零开始；Harness 必须给每次启动一个稳定身份，让 JSONL 文件、Hook 配置、Plan slug、Cron 任务都能锚定到正确的会话。

**典型证据**：`STATE.sessionProjectDir` 与 `STATE.sessionId` 必须**一起切换**（见 `switchSession()` 注释），这是 CC-34 bugfix 留下的不变量——之前分别 setter 导致跨项目 resume 时 transcript 路径错位。

**展开阅读**：[04-agent-loop](../02-agent-runtime/cc-04-agent-loop.md)（原 02，后移）、[24-persistence-and-cache](../06-runtime-infrastructure/cc-24-persistence-and-cache.md)（sessionStorage 怎么用 sessionId）。

---

### 组件 3：状态层（State Layer）

**职责**：进程级共享状态——单一可信源（single source of truth），所有跨模块的数据都从这里走。

**关键文件**：
- [src/bootstrap/state.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) — 1737 行，120+ 字段的 module-level singleton
- [src/state/AppState.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/state/AppState.tsx) — React/Ink 用的 AppState（与 bootstrap/state 互补，UI 状态 vs 业务状态）
- [src/state/store.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/state/store.ts) — Zustand store for AppState
- [src/state/AppStateStore.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/state/AppStateStore.ts) — 默认 AppState

**在 Harness 中的位置**：Harness 的"内核数据结构"。State 层和 Session 层耦合但不重叠——Session 标识身份，State 存储身份对应的运行时数据（成本、token、模型、权限模式、Hook 注册表、Cron 任务、Skill 调用记录等）。

**典型证据**：`bootstrap/state.ts:31` 有一条注释 `DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE`——这条注释本身就是一个设计决策：**所有跨模块共享的运行时数据都集中在这里**，新增前必须想清楚"这个值为什么不能放在 React 状态、为什么不能放在参数传递"。

**为什么是 module-level 单例**：Bun/Node 是单进程单事件循环，module evaluation 一次。Module-level singleton 比 React Context 在 hook 树外的可访问性好，比函数参数在深层调用链上不会传丢。代价是测试需要 `resetStateForTests()`（`bootstrap/state.ts:901`）。

**展开阅读**：[01-layer-overview](https://github.com/claude-code-best/claude-code/tree/d0713bdd/docs/analysis/claude-code-cli%E6%BA%90%E7%A0%81%E8%A7%A3%E6%9E%90/01-layer-overview.md)（bootstrap 作为 DAG leaf 的设计）。

---

### 组件 4：循环层（Loop Layer）

**职责**：Reason → Act → Observe 的 while-true；管理每轮状态、compaction、file history、attribution。

**关键文件**：
- [src/query.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/query.ts) — 2057 行，**Harness 的核心**——`query()` 函数发送消息、处理流式响应、处理 tool calls、管理 turn loop
- [src/QueryEngine.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/QueryEngine.ts) — 1365 行，`QueryEngine` 类，高阶 orchestrator，wrap `query()` 用于 REPL

**在 Harness 中的位置**：Harness 的"调度器"。循环层是**唯一的中枢**——它向上消费 UI 层的用户输入，向下协调上下文/API/工具/权限/Hook 五个执行支点。

**典型证据**：`query.ts` 的 `while(true)` 循环里嵌入了**十二个交叉切面**——compaction、file history、prompt cache、permission check、tool execution、hook fire、message storage、telemetry、classifier、token budget、rate limit、stream parser。每个切面都是 if/else 的嵌入点，不是中间件链——这种"大循环 + 内嵌切面"的结构是 Anthropic 选择的路子。

**展开阅读**：[04-agent-loop](../02-agent-runtime/cc-04-agent-loop.md)（核心循环状态机）、[05-streaming-and-rendering](../02-agent-runtime/cc-05-streaming-and-rendering.md)（5 层 AsyncGenerator 链路）。

---

### 组件 5：上下文层（Context Layer）

**职责**：决定 LLM 每一轮看到什么——system prompt、CLAUDE.md、Memory、Skill 索引、git status、tool schema。

**关键文件**：
- [src/context.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/context.ts) — 189 行，`getSystemContext()` + `getUserContext()` 两个 memoized 函数
- [src/utils/claudemd.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/claudemd.ts) — 沿项目层级发现并加载 CLAUDE.md
- [src/constants/prompts.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/constants/prompts.ts) — system prompt 模板
- [src/bootstrap/state.ts:121-123](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) — `cachedClaudeMdContent` 打破 `yoloClassifier → claudemd → filesystem → permissions` 循环

**在 Harness 中的位置**：Harness 的"输入装配车间"。每轮 API 调用前，循环层调用 `getSystemContext()` + `getUserContext()` 拿到 prompt payload。这两个函数被 `memoize` 包裹，会话生命周期内只算一次——这正是 Anthropic 在 Prompt Cache 上省钱的核心机制。

**典型证据**：`context.ts:116` 的 `getSystemContext` 是 memoize 的，整个 session 只读一次 git status；`context.ts:155` 的 `getUserContext` 也 memoize 一次 CLAUDE.md。如果用户切换分支想看到新 CLAUDE.md，必须 `/clear` 重置 memoize cache——这条约束让"什么时候读什么"变得可预测。

**展开阅读**：[06-context-assembly](../02-agent-runtime/cc-06-context-assembly.md)、[08-compaction-subsystem](../02-agent-runtime/cc-08-compaction-subsystem.md)。

---

### 组件 6：工具层（Tool Layer）

**职责**：定义 LLM 能调用的所有动作——文件、Shell、Agent、Plan、Skill、MCP。

**关键文件**：
- [src/Tool.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/Tool.ts) — 802 行，`Tool` interface 定义
- [src/tools.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/tools.ts) — 422 行，工具注册表，组装工具列表
- [src/constants/tools.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/constants/tools.ts) — `CORE_TOOLS` 白名单（38 个核心工具）
- [packages/builtin-tools/src/tools/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/packages/builtin-tools/src/tools/) — 60 个工具实现

**在 Harness 中的位置**：Harness 的"系统调用表"。Tool 接口定义了 5 个生命周期方法（`validateInput`、`call`、`mapToolResultToToolResultBlockParam`、`description`、`prompt`），60 个内置工具 + MCP 工具共同构成 LLM 的能力空间。

**典型证据**：`Tool.ts` 的 `Tool` type 是一个 discriminated union——每个工具必须实现 5 个 method 才能注册。`tools.ts` 用 `feature()` 控制部分工具的注册（feature flag 关闭 = 工具从注册表消失 = LLM 看不见）。`CORE_TOOLS` 白名单保证延迟加载的 `searchExtraTools` 不会引入循环依赖。

**展开阅读**：[10-tool-execution-pipeline](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)、[11-skill-system](../03-tools-extensions-governance/cc-11-skill-system.md)、[13-mcp-integration](../03-tools-extensions-governance/cc-13-mcp-integration.md)。

---

### 组件 7：权限层（Permission Layer）

**职责**：决定 LLM 想做的事**是否被允许**——5 层检查链 + YOLO classifier。

**关键文件**：
- [src/utils/permissions/permissions.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/permissions.ts) — 1507 行，`canUseTool` 主入口
- [src/utils/permissions/permissionsLoader.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/permissionsLoader.ts) — 规则加载
- [src/utils/permissions/PermissionRule.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/PermissionRule.ts) — 规则 schema
- [src/utils/permissions/yoloClassifier.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/yoloClassifier.ts) — transcript classifier（feature-gated by `TRANSCRIPT_CLASSIFIER`）
- [src/utils/sandbox/sandbox-adapter.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sandbox/sandbox-adapter.ts) — OS-level sandbox

**在 Harness 中的位置**：Harness 的"capability 系统"。权限层是项目里**代码量最大、最复杂**的子系统——5 层检查链（deny → allow → bypass → classifier → HITL）每层都是独立代码路径，每层都有 fast/slow path。

**典型证据**：`permissions.ts:59-64` 用 `require()` 而不是 `import()` 加载 classifier 模块（feature flag 关闭时整段代码从 bundle 中消失）；`permissions.ts:11` 引入 `SandboxManager`——决定 Bash 是普通执行还是 OS sandbox 隔离。permission 决策会通过 `PermissionUpdate` 协议动态更新 settings（`applyPermissionUpdates`），让用户在 REPL 中按 y 后的"deny this for the rest of the session"立即生效。

**展开阅读**：[14-permission-security](../03-tools-extensions-governance/cc-14-permission-security.md)（5 层权限防御详述）。

---

### 组件 8：UI 层（UI Layer）

**职责**：用户在终端看到什么、能输入什么——Ink 组件、REPL、permission 弹窗、计划视图、todo 列表。

**关键文件**：
- [src/screens/REPL.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/screens/REPL.tsx) — 主交互屏
- [src/components/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/) — 149 个组件目录/文件
- [src/components/App.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/App.tsx) — 根 Provider（AppState + Stats + FpsMetrics）
- [src/components/Messages.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/Messages.tsx) + [MessageRow.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/MessageRow.tsx) — 消息渲染
- [src/components/PromptInput/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/PromptInput/) — 用户输入处理
- [src/components/permissions/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/permissions/) — 权限审批 UI
- [packages/@ant/ink/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/packages/@ant/ink/) — 自定义 Ink 框架（forked）

**在 Harness 中的位置**：Harness 的"终端"。和 SDK 的根本差异——SDK 没有 UI，输出靠开发者自己 `console.log`；Harness 必须解决 60fps 渲染、虚拟滚动、按键路由、permission 弹窗阻塞等一长串 UI 问题。

**典型证据**：`src/hooks/` 下 110+ 个 `useXxx` React hooks 是 UI 层的关键基础设施——`useAssistantHistory`、`useVirtualScroll`、`useMergedTools`、`useCanUseTool` 等。每个 hook 都是 Ink 渲染循环和业务逻辑的桥。React Compiler 输出的 `_c(N)` memoization 模板说明这是 React Compiler runtime——decompiled 出来的产物。

**展开阅读**：[05-streaming-and-rendering](../02-agent-runtime/cc-05-streaming-and-rendering.md)。

---

### 组件 9：Hook 层（Hook Layer）

**职责**：让用户在 Harness 关键节点注入确定性约束——PreToolUse 拦截、PostToolUse 修改、SessionStart 注入上下文、Stop 阻止退出。

**关键文件**：
- [src/types/hooks.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/hooks.ts) — 283 行，Hook event schema、Sync/Async output schema
- [src/utils/hooks.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks.ts) — Hook 执行器（shell + SDK callback 两类）
- [src/utils/hooks/AsyncHookRegistry.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/AsyncHookRegistry.ts) — Async hook 注册表
- [src/utils/hooks/execAgentHook.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/execAgentHook.ts) — agent hook
- [src/utils/hooks/execPromptHook.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/execPromptHook.ts) — prompt hook（UserPromptSubmit）
- [src/utils/hooks/execHttpHook.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/execHttpHook.ts) — HTTP hook
- [src/utils/hooks/hookEvents.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/hookEvents.ts) — 事件枚举
- [src/entrypoints/agentSdkTypes.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/entrypoints/agentSdkTypes.ts) — HookEvent 联合类型 + HOOK_EVENTS 数组

**在 Harness 中的位置**：Harness 的"中断向量表"。Hook 让用户**在 LLM 不参与决策的关键路径上强制干预**——比如某个危险命令必须 deny、每个 Bash 调用后自动 lint、每次 Stop 前归档日志。这些是"确定性"的，绕过 LLM 不可靠性。

**典型证据**：`types/hooks.ts:50-100` 定义了 syncHookResponseSchema——`continue` / `decision: approve|block` / `hookSpecificOutput.permissionDecision` / `additionalContext` 等字段。Hook 输出可以**修改 input**（`updatedInput`），甚至**阻止模型继续**（`continue: false`）。这相当于给 LLM 套了一个可编程的"安全壳"。

**展开阅读**：[15-hook-interception](../03-tools-extensions-governance/cc-15-hook-interception.md)。

---

### 组件 10：持久化层（Persistence Layer）

**职责**：会话怎么存、怎么恢复、怎么 resume——JSONL 文件 + 消息树 + Prompt Cache 优化。

**关键文件**：
- [src/utils/sessionStorage.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sessionStorage.ts) — 5247 行，transcript 读写、append、message tree
- [src/utils/sessionStoragePortable.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sessionStoragePortable.ts) — 跨平台读盘原语（head/tail read）
- [src/utils/sessionRestore.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sessionRestore.ts) — `/resume` 命令的恢复逻辑
- [src/utils/conversationRecovery.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/conversationRecovery.ts) — 中断后恢复
- [src/utils/fileHistory.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/fileHistory.ts) — 文件变更快照（用于 `/diff`）
- [src/utils/toolResultStorage.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/toolResultStorage.ts) — 大体积 tool result 外置存储

**在 Harness 中的位置**：Harness 的"文件系统"。每次 turn 结束，循环层把 user/assistant/tool_result messages 写入 `<sessionId>.jsonl`。Resume 时按消息树重建内存状态，prompt cache 让重连的会话能复用 90% 的 prefix。

**典型证据**：`sessionStorage.ts` 5247 行——是项目里最长的单文件之一，包含 portable file ops、message tree 重建、recovery、prompt cache hint 等子模块。文件读用 `readSync` 而不是 `readFileSync` 是性能优化——readFileSync 走 JS 层包装，readSync 是 Node 原生 binding。

**展开阅读**：[24-persistence-and-cache](../06-runtime-infrastructure/cc-24-persistence-and-cache.md)。

---

### 组件 11：可观测层（Observability Layer）

**职责**：让 Harness 的内部行为可被追踪、可被排障——OpenTelemetry、analytics、Langfuse、transcript、metrics。

**关键文件**：
- [src/utils/telemetry/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/telemetry/) — OTel tracer/meter/logger provider
- [src/utils/telemetry/sessionTracing.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/telemetry/sessionTracing.ts) — session span
- [src/utils/telemetry/events.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/telemetry/events.ts) — event 埋点
- [src/services/analytics/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/analytics/) — 1P analytics（firstPartyEventLogger + growthbook + datadog）
- [src/services/langfuse/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/langfuse/) — Langfuse tracing 集成
- [src/utils/log.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/log.ts) — 日志门面
- [src/utils/diagLogs.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/diagLogs.ts) — 诊断日志

**在 Harness 中的位置**：Harness 的"调试器"。Agent 系统不可靠——LLM 可能做出奇怪决定、tool 可能超时、permission 可能错判、compaction 可能丢上下文。可观测层负责在每次 turn、每次 tool call、每次 permission 决策上打点，让事后能"还原现场"。

**典型证据**：`bootstrap/state.ts:89-99` 列出了 8 个 OTel counters（session、loc、pr、commit、cost、token、codeEditToolDecision、activeTime），每个用 feature flag 控制开关。`telemetry/sessionTracing.ts` 在每个 tool/hook/classifier 边界开/关 span，把延迟数据暴露给 Datadog。

**展开阅读**：[25-observability](../06-runtime-infrastructure/cc-25-observability.md)。

---

### 组件 12：Provider 适配层（Provider Adapter Layer）

**职责**：让 Harness 对接多家 LLM——Anthropic、Bedrock、Vertex、Foundry、OpenAI、Gemini、Grok。

**关键文件**：
- [src/services/api/claude.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) — 3580 行，Anthropic SDK streaming
- [src/services/api/openai/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/openai/) — OpenAI 兼容层（Ollama/DeepSeek/vLLM）
- [src/services/api/gemini/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/gemini/) — Gemini 兼容层
- [src/services/api/grok/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/grok/) — Grok 兼容层
- [src/utils/model/providers.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/model/providers.ts) — 7 个 provider 注册
- [src/services/providerRegistry/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/providerRegistry/) — provider 能力矩阵
- [packages/@ant/model-provider/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/packages/@ant/model-provider/) — model provider 抽象层

**在 Harness 中的位置**：Harness 的"驱动层"。所有上层组件都不知道自己跑在哪个 LLM 上——它们只调 `query()`，query 内部通过 stream adapter 把"Anthropic 格式"转成目标格式，再转回"Anthropic 内部格式"。这条归一化的好处是**循环层、上下文层、权限层、Hook 层完全无感**。

**典型证据**：`src/services/api/openai/responsesAdapter.ts` 是 OpenAI → Anthropic 的 stream adapter——把 OpenAI Chat Completions 的 chunk 流重组成 Anthropic `BetaRawMessageStreamEvent`。下游的 `query.ts`、`permissions.ts`、`hooks.ts` 不用改一个字符。

**展开阅读**：[28-multi-provider-stream-adapters](https://github.com/claude-code-best/claude-code/tree/d0713bdd/docs/analysis/claude-code-cli%E6%BA%90%E7%A0%81%E8%A7%A3%E6%9E%90/28-multi-provider-stream-adapters.md)。

---

## 四、一次完整请求的 Harness 路径

下表用一次具体的工具调用（用户说"修一下 src/foo.ts 第 42 行的 bug"）追踪请求穿越十二层的全过程。每行是该层**具体做了什么**，不是模糊描述。

| 步骤 | Harness 组件 | 关键调用 | 关键文件:行 |
|------|-------------|---------|------------|
| 1 | 入口层 | `bun src/entrypoints/cli.tsx` → `main()` 解析 args → 默认路径 → `await import('../main.jsx')` | [cli.tsx:352](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/entrypoints/cli.tsx) |
| 2 | 会话层 | 启动时 `getInitialState()` 生成 `STATE.sessionId = randomUUID()` | [state.ts:326](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) |
| 3 | 状态层 | 加载 settings、初始化 OTel provider、加载 CLAUDE.md cache | [state.ts:255](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts) |
| 4 | UI 层 | Ink 启动 `REPL.tsx`，render 出 prompt input，等待用户输入 | [REPL.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/screens/REPL.tsx) |
| 5 | 循环层 | 用户按 Enter → `processUserInput()` → `query()` 调用 | [query.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/query.ts) |
| 6 | 上下文层 | `getSystemContext()` (memoized) + `getUserContext()` (memoized) 组装 system prompt payload | [context.ts:116](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/context.ts) |
| 7 | 工具层 | `tools.ts` 按当前权限模式返回工具列表（`searchExtraTools` 可能 lazy load） | [tools.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/tools.ts) |
| 8 | Provider 层 | `claude.ts` 调 Anthropic streaming API，吐出 `BetaRawMessageStreamEvent` | [claude.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) |
| 9 | 循环层 | streaming parser 把事件还原成 `AssistantMessage`，可能内嵌 `tool_use` block | [query.ts:循环体](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/query.ts) |
| 10 | UI 层 | Ink 渲染流式文字，按 token 逐字输出（5 层 AsyncGenerator 链路） | [05-streaming-and-rendering](../02-agent-runtime/cc-05-streaming-and-rendering.md) |
| 11 | 循环层 | 检测到 `tool_use`，进入 tool execution phase | [toolExecution.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/tools/toolExecution.ts) |
| 12 | Hook 层 | `PreToolUse` hook 触发——shell hook 跑用户配置的命令，SDK callback hook 跑 SDK 注册的回调 | [hooks.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks.ts) |
| 13 | 权限层 | `canUseTool()` 五层检查链：deny → allow → bypass → classifier → HITL | [permissions.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/permissions.ts) |
| 14 | UI 层 | 如果进入 HITL，渲染 `BashPermissionRequest` 等组件，等待用户 y/n | [components/permissions/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/components/permissions/) |
| 15 | 工具层 | 工具实际执行（Edit 工具调 `FileEditTool.call()`） | [packages/builtin-tools/src/tools/FileEditTool/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/packages/builtin-tools/src/tools/FileEditTool/) |
| 16 | Hook 层 | `PostToolUse` hook 触发（linter、formatter、test runner） | [hooks.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks.ts) |
| 17 | 循环层 | tool result 包装成 `tool_result` block 注入 conversation，递归调用 API | [query.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/query.ts) |
| 18 | 持久化层 | turn 结束 → `appendMessageToTranscript()` 写 JSONL | [sessionStorage.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sessionStorage.ts) |
| 19 | 可观测层 | `logAPISuccess()` / `logAPIToolResult()` / OTel span end / `recordCostUsage()` | [utils/telemetry/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/telemetry/) |
| 20 | UI 层 | 最终 assistant 消息渲染完，状态切回 idle，等待下一个输入 | [REPL.tsx](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/screens/REPL.tsx) |

整个 20 步**没有一个步骤是"可选的"**——任何一步缺失，下游就会断。Hook 可以没有用户配置（no-op），permission HITL 可以用户预设了 allow（直接通过），但**代码路径必须存在**。这就是 Harness 的核心特性：**把"可能需要的能力"全部接好，由运行时/配置决定激活哪些**。

### 路径的脆弱点与兜底链

20 步中关键步骤都有具体的兜底机制，与 [第 7.5 节三层映射](#75-失败模式--稳定机制--组件-三层映射) 对应：

- **步骤 8（Provider 层 API 调用）**：API 失败 → [`claude.ts:847`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) `retryOptions` 重试；重试仍失败 → [`claude.ts:819`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) `fallbackModel` 降级。
- **步骤 13（权限层 `canUseTool`）**：5 层检查链中任一层 deny 都阻断执行；最坏情况 classifier 调用 + HITL UI 阻塞。详见 [14-permission-security](../03-tools-extensions-governance/cc-14-permission-security.md)。
- **步骤 17（循环层 tool_result 注入）**：注入失败 → [`utils/conversationRecovery.ts`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/conversationRecovery.ts) 重建 messages；最坏情况 [`messages.ts:5591`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/messages.ts) `ensureToolResultPairing` 补合成 `synthetic_tool_result`。
- **步骤 18（持久化层 JSONL 写入）**：写入失败 → [`sessionStorage.ts`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/sessionStorage.ts) 内部 write queue 重试 + 内存 buffer；JSONL append-only 设计让损坏窗口只有一个 turn。
- **步骤 11（循环层 tool_use 检测）**：检测失败 → 视为 final answer，模型自治结束 turn；不会无限等待。
- **步骤 12/16（Hook 层 Pre/Post）**：Hook 执行失败 → schema 默认 allow/deny（[`types/hooks.ts:50-100`](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/hooks.ts) `syncHookResponseSchema`）；不影响主路径，PostToolUse 完全装饰性。
- **步骤 4/10/14/20（UI 层 render / HITL / idle）**：render 失败 → catch + log + 退出；HITL 用户中断 → 自动 deny；idle reset 失败 → 状态保留，下次输入仍可工作。

完整 8 失败模式 × 6 稳定机制 × 12 组件的三层映射见 **§七.5**。

---

## 五、Harness 与传统 LLM SDK 的关键差异

把 Claude Code 的 Harness 和 Anthropic SDK 直接对比，能看出 Harness 多包了哪些东西：

| 能力 | Anthropic SDK | Claude Code Harness | 体现层 |
|------|---------------|---------------------|--------|
| 调一次 API | `client.messages.create()` | `query()` 2057 行 | 循环层 |
| 流式响应 | `client.messages.stream()` | 5 层 AsyncGenerator 链路 + Idle Stall Watchdog | 循环层 + UI 层 |
| 工具调用 | `tools` 参数 + 客户端解析 | 60 工具注册 + `Tool` interface + 校验 + 权限 + 执行 + 格式化 | 工具层 |
| 多轮对话 | 客户端维护 messages 数组 | JSONL transcript + MessageTree + Resume | 持久化层 |
| 上下文管理 | 客户端手工 | memoized system context + compaction 5 阶段栈 + prompt cache | 上下文层 |
| 权限控制 | 无 | 5 层检查链 + YOLO classifier + OS sandbox | 权限层 |
| Hook 注入 | 无 | PreToolUse / PostToolUse / SessionStart / Stop 等 14+ 事件 | Hook 层 |
| 错误恢复 | 客户端 catch | `gracefulShutdownSync` + conversationRecovery + transcript 重建 | 持久化层 |
| UI | 无 | Ink + React + 110+ hooks + 149 components | UI 层 |
| 可观测 | SDK 自带 log | OTel + Langfuse + 1P analytics + transcript 导出 | 可观测层 |
| 多 Provider | 无 | 7 provider + stream adapter | Provider 层 |
| 远程控制 | 无 | Bridge + ACP + Daemon + Cloud Artifacts | 入口层 |

关键洞察：**Anthropic SDK 把 LLM 当成远程函数调用，Harness 把 LLM 当成操作系统进程**。前者给开发者控制权，代价是每个应用都要重写一遍"消息恢复、权限、UI、可观测"；后者把这套基础设施预制好，代价是 Harness 本身复杂到 50K+ 行代码。

---

## 六、关键设计决策

把"为什么这样设计"汇总成六条决策，每条都给出**备选方案 + 为什么放弃**。

### 决策 1：Module-level singleton 而不是 Context API

**选择**：`bootstrap/state.ts` 用 module-level `STATE` 单例 + getter/setter 函数。

**备选方案**：React Context for everything。

**放弃原因**：UI 状态（消息、权限弹窗）和业务状态（sessionId、token 计数、Hook 注册表）的生命周期不同。Context 在 hook 树外的代码（异步回调、子进程 IPC、JSONL 读写）拿不到。Bootstrap 是 DAG leaf，所有上层模块依赖它但它不依赖任何上层——这种"低层 stable singleton"模式比 Context 灵活。

**代价**：测试需要 `resetStateForTests()`；并发场景需要 `concurrentSessions.ts` 用 PID 文件解决（不是进程内注册表）。

### 决策 2：Feature flag 用 `bun:bundle` 而不是 env var

**选择**：`feature('FLAG')` 在 build 时被替换成字面量 `true/false`，未启用的代码物理删除。

**备选方案**：`if (process.env.FEATURE_X) { ... }` 运行时判断。

**放弃原因**：env var 让未启用代码留在 bundle 里——死代码占体积、TypeScript 类型分析跑整份代码、bundle 中残留字符串泄露 feature 存在的事实。`bun:bundle` 在 AST 阶段就把 `feature('FLAG')` 替换成字面量 `false`，整个 if 分支被 DCE 掉。

**代价**：Bun 编译器限制——`feature()` 只能在 `if` 条件位置或三元表达式里，不能赋值给变量、不能放进箭头函数体、不能作为 `&&` 链的一部分。

### 决策 3：JSONL transcript 而不是 SQLite

**选择**：每条消息一行 JSON 写入 `<sessionId>.jsonl`。

**备选方案**：SQLite 单文件。

**放弃原因**：JSONL 天然 append-only，写入极简（一条 fsync 一次），崩溃恢复只需 tail-truncate 即可——损坏窗口只有一个 turn。SQLite 的 WAL 模式虽然也好，但需要引入 native binding（Bun 的 SQLite 实现还在演进），跨平台构建复杂。

**代价**：读取需要 head/tail walk（`sessionStoragePortable.ts` 的 `readHeadAndTail`），不能任意 SQL 查询。Claude Code 的查询模式是"从 tail 往前 N 条"和"从 head 读 N 条"两种局部访问，JSONL 已经够用。

### 决策 4：Hook 输出 schema 严格化

**选择**：`SyncHookResponse` / `AsyncHookJSONOutput` 用 Zod schema 强校验，所有字段都有 type。

**备选方案**：JSON Schema 弱校验或纯 TS interface。

**放弃原因**：Hook 输出是 LLM 行为的关键调控点——`permissionDecision: 'allow' | 'deny' | 'ask'` 一字之差就是安全漏洞。Zod schema 强制 SDK 使用方在编译期就处理所有分支，运行时还有一层校验兜底。Zod v4 + `lazySchema()` 让大 schema 不阻塞模块加载。

**代价**：新增 Hook event 要更新 `HOOK_EVENTS` 数组 + 14+ 处 switch，扩展成本高于 TS interface。

### 决策 5：5 层权限防御而不是 1 层

**选择**：deny → allow → bypass → classifier → HITL 五层串联。

**备选方案**：单层 `if (allowed) execute()`。

**放弃原因**：LLM 不可靠——它会"忘记"已配置的规则、会在长 context 里忽略 80 行的 deny list、会被 prompt injection 欺骗。**多层冗余**是唯一靠谱的工程方案：deny 是宪法（不可破）、allow 是政策（可破）、bypass 是逃生口（开发用）、classifier 是兜底（HITL 太烦时降噪）、HITL 是终审（人来判断）。

**代价**：性能——5 层检查每次 tool call 都要跑，最坏情况 5 次 RPC（classifier 调用）。生产环境用 `TRANSCRIPT_CLASSIFIER` feature flag 让用户能关掉 classifier。

### 决策 6：Provider 适配做"流转换"而不是"通用抽象"

**选择**：每个第三方 provider 写一个 stream adapter，把第三方格式转成 Anthropic 内部格式。下游代码完全不改。

**备选方案**：定义"通用 LLM interface"，让所有 provider 实现。

**放弃原因**：通用接口会强制所有 provider 实现"工具调用 + 流式 + system prompt + image"等所有能力——而 OpenAI/Gemini 的 tool schema、role 命名、流事件结构都和 Anthropic 不同，强行抽象会让 adapter 越来越像"最坏情况的并集"，所有 provider 都跑得别扭。流转换是"专项适配"——Anthropic 是 first-class，其他 provider 是近似。

**代价**：每个新 provider 要重写 adapter（OpenAI adapter ~600 行，Gemini adapter 类似），但下游**零修改**——加 provider 是单点变更。

---

## 七、Harness 如何让模型稳定：失败模式与稳定机制

前六节回答"Harness 由什么组成"。本节回答"Harness 怎么让不稳定的 LLM 变得可控"——把组件清单转换成因果链：**LLM 在 8 个维度上不可靠 → Harness 在 6 个机制上施加工程结构 → 多机制叠加让最终到达用户面前的输出"看起来像"稳定系统**。这两组列表不是 1:1 映射——一个机制可以防御多个失败模式，一个失败模式也可能需要多个机制叠加才能兜住。

### 7.1 LLM 八类不稳定表现

把"模型哪里会出错"摊开——每一类都有真实代码修复记录，不是空想。

**表现 1：工具调用配对错误（tool_use / tool_result mismatch）** —— 模型输出 `tool_use` 后，循环/网络中断、Hook 拒绝、用户取消——这条 `tool_use` 没有对应的 `tool_result`。下次 API 调用时 Anthropic 服务端会因为"未配对 tool_use"拒绝请求或返回 400。`src/utils/messages.ts:5591` 的 `ensureToolResultPairing` 函数就是为这个症状存在的——它专门扫描所有 message、找到悬空的 tool_use block、补一个合成的 tool_result。注释 [src/utils/messages.ts:243-244](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/messages.ts) 解释：合成的 tool_result 内容是 `synthetic_tool_result`，**专供 LLM 看到**——HFI 评测脚本会剔除这些合成产物，避免污染训练数据。更激进的版本：`strictToolResultPairing` 模式（[src/bootstrap/state.ts:73-77](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/bootstrap/state.ts)）开启后，配对失败时直接 throw，不再默默修复——HFI 评测需要"快速失败"，不能让模型被合成的 fake tool_result 误导。

**表现 2：流式响应中途卡死** —— 模型开始输出 → 一段时间无新 token → 既不完成也不报错。可能是后端慢、网络丢包、或 prompt cache 击穿。用户看到的是"光标一直转"。[05-streaming-and-rendering](../02-agent-runtime/cc-05-streaming-and-rendering.md) 里的 Idle Stall Watchdog 就是为此存在——它设一个超时（默认几十秒），到达后主动 cancel 这次 stream、丢弃部分输出、触发 fallback 重试。如果重试还失败，再降级到非流式 fallback（见 `claude.ts:819 fallbackModel`）。

**表现 3：上下文撑爆** —— 长对话把 token 推到上限，API 拒绝请求（400 invalid_request_error: prompt is too long）。即使没撑爆，模型在长 context 上准确率会下降（"lost in the middle" 现象）。[08-compaction-subsystem](../02-agent-runtime/cc-08-compaction-subsystem.md) 详述的 5 阶段压缩栈——microCompact、grouping、cachedMicrocompact、sessionMemoryCompact、autoCompact——就是为了对抗这个。`HISTORY_SNIP` feature（[src/commands.ts:93](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/commands.ts)）是**最极端的紧急 token 削减**，只在 token budget 即将爆掉时手动触发。

**表现 4：模型自主越权** —— 模型输出 `Bash("rm -rf /")`、`Write(/etc/passwd)`、`Read(.ssh/id_rsa)`——即使 system prompt 里写了"不要这么做"，长 context 下模型会"忘记"这条规则，或被 prompt injection 诱导越界。见 [14-permission-security](../03-tools-extensions-governance/cc-14-permission-security.md) 的 5 层权限防御链——deny > allow > bypass > classifier > HITL。**多层冗余是工程唯一靠谱的方案**：deny 是宪法（不可破）、allow 是政策（可破）、bypass 是逃生口（开发用）、classifier 是兜底（HITL 太烦时降噪）、HITL 是终审（人来判断）。

**表现 5：重复循环** —— 模型在某个 tool call 上反复重试（比如 network timeout 后重试 5 次还是 timeout），或同一个 prompt 复读多遍。token 浪费、时间浪费、用户看到的是"模型在瞎忙"。`circuit breaker`（[src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts:289](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts)）记录连续失败次数，到阈值后**强制中断这轮**，不再重试。query.ts:735 的 `autocompact failed` 也走 circuit breaker 计数。

**表现 6：输出被截断（max_tokens）** —— 模型写到一半到达 max_tokens 上限，输出被切。可能切在 tool_use 中间（JSON 不完整）、切在 fenced code block 中间（缺结尾 ```）。`claude.ts:847` 的 `retryOptions` 检测到输出被截断时**重试**，且把 max_tokens 翻倍给后续尝试。**只有重试仍失败才降级到非流式 fallback**（`fallbackModel`）——比原模型更小、更可能"装得下"完整输出。

**表现 7：Prompt injection** —— 外部数据（CLAUDE.md、Skill 文件、tool result、Web 抓取内容、MCP 返回值）被恶意构造，诱导模型执行危险操作或泄露 system prompt。这是**外部威胁**而非 LLM 自身缺陷，但 LLM 不可靠使得这条威胁更危险。Hook 输出 schema 严格化（[src/types/hooks.ts:50-100](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/hooks.ts)）—— `permissionDecision: 'allow' | 'deny' | 'ask'` 的 union type 编译期就拒绝非法值。`ssrfGuard`（[src/utils/hooks/ssrfGuard.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/ssrfGuard.ts)）拦截 Hook 发起的 SSRF 请求。**但完全消除不可能**——表现 7 是 Harness 的已知边界（见第八节）。

**表现 8：上下文遗忘与"假装没看见"** —— 模型在长 context 里"忘记"了 system prompt 早期给出的 deny 规则、Skill 说明、或权限模式。`/clear` 一下恢复——但工作流被打断。决策 5 的 5 层权限防御正是为了对抗这种遗忘——**单层会被遗忘，多层串联让单层失效不致命**。但**完全消除不可能**——表现 8 是 Harness 的已知边界。

### 7.2 Harness 六大稳定机制

把上文的失败模式反向归类，得到 6 个稳定机制。每个机制都给出**代码定位 + 防御哪些失败模式**。

**机制 1：重试与降级（Retry & Fallback）** —— 检测到单次请求失败时按策略重试；重试仍失败时切换到备用模型。
- 代码定位：`claude.ts:847`（`retryOptions`，流式 + 非流式 fallback 双路径）、`claude.ts:819`（`fallbackModel` 降级目标）、`claude.ts:874-892`（重试回调实现，每次 attempt 重新组装 params）。
- 防御的失败模式：表现 2（流式卡死）、表现 6（输出截断）、表现 5（重复循环）。
- 关键设计：**重试不是简单的"再发一次"**——每次 attempt 会重新算 `max_tokens`（避免再次被截断）、可能切换 stream/non-stream 路径、可能切到 fallbackModel。三层嵌套的 fallback 链让单点失败不会传染整个调用。

**机制 2：消息修复（Message Repair）** —— 在 API 调用前对 messages 数组做规范化、补全缺失块、剔除非法结构。
- 代码定位：`messages.ts:5591`（`ensureToolResultPairing`，配对 tool_use/tool_result）、`messages.ts:243-244`（合成 tool_result 的占位符定义）、`claude.ts:1325`（`messagesForAPI = ensureToolResultPairing(messagesForAPI)`，API 调用前必经）、`bootstrap/state.ts:73-77`（`strictToolResultPairing` flag，让 HFI 严格模式不修复而是 throw）。
- 防御的失败模式：表现 1（工具调用配对错误）。
- 关键设计：**修复是单向的——只补全，不删除**。`messages.ts:2570` 的注释明确说 CC-1212 bug：之前会删除重复 tool_use ID，导致 orphan tool_results 反向增多。新逻辑只补不删，方向单调。

**机制 3：权限层防御（Permission Defense-in-Depth）** —— 5 层检查链，任何一层 deny 都阻止执行。
- 代码定位：`utils/permissions/permissions.ts`（`canUseTool` 主入口）、`utils/permissions/PermissionRule.ts`（规则 schema）、`utils/permissions/yoloClassifier.ts`（transcript classifier，`TRANSCRIPT_CLASSIFIER` feature-gated）、`utils/sandbox/sandbox-adapter.ts`（OS sandbox）。
- 防御的失败模式：表现 4（模型自主越权）、表现 7（prompt injection 部分）。
- 关键设计：**5 层串联不是冗余设计，是不可靠性设计**。任何单层都可能因模型遗忘、prompt 注入、bug 而失效。**多层串联让单层失效不致命**——表现 8 证明了为什么单层不够。

**机制 4：流式看门狗（Stream Watchdog）** —— 监控流式响应，超时主动 cancel + 触发 fallback。
- 代码定位：见 [05-streaming-and-rendering](../02-agent-runtime/cc-05-streaming-and-rendering.md) 详述。代码层面：`src/cli/print.ts:1779` 的 `createIdleTimeoutManager`、`src/utils/idleTimeout.ts`。
- 防御的失败模式：表现 2（流式卡死）。
- 关键设计：**看门狗不是清退——是触发降级**。Idle stall 触发后 cancel 这次 stream，但立即把任务交给 fallback 链路继续。用户感知是"慢了一点"而不是"完全卡死"。

**机制 5：上下文瘦身（Context Trimming）** —— 长对话累积到 token 临界时主动压缩，按严重程度选不同强度的压缩策略。
- 代码定位：`services/compact/compact.ts`（auto compact 入口）、`services/compact/microCompact.ts`（microCompact，轻量）、`services/compact/grouping.ts`（消息分组后压缩）、`services/compact/cachedMicrocompact.ts`（cache-aware 压缩）、`services/compact/sessionMemoryCompact.ts`（session 级压缩）、`commands.ts:93`（`HISTORY_SNIP` feature，极端紧急削减）。
- 防御的失败模式：表现 3（上下文撑爆）、表现 8（遗忘）。
- 关键设计：**多阶段不是为了省 token，是为了给不同失败程度留梯度**。token 还剩 50% 时只 microCompact；剩 20% 时 grouping + sessionMemory；剩 5% 时 HISTORY_SNIP 暴力削减。**永远不要让用户主动 /clear**——自动恢复是稳定性的一部分。

**机制 6：熔断器（Circuit Breaker）** —— 连续失败计数，到阈值后强制中断，避免在错误状态下反复浪费。
- 代码定位：`src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts:289`（H7 circuit breaker）、`src/query.ts:735`（autocompact 失败计数）、`src/main.tsx:5101`（`tengu_auto_mode_config.enabled === 'disabled'` circuit breaker）、`src/services/analytics/growthbook.ts`（feature flag 触发的熔断）。
- 防御的失败模式：表现 5（重复循环）。
- 关键设计：**熔断不是惩罚——是保护**。熔断后给用户明确反馈"系统状态异常，请人工介入"，而不是默默重试 100 次浪费 token + 时间。

### 7.3 一次真实的稳定性事件：流式卡死 + 权限 deny

把六大机制叠加到一次具体的失败场景，看它们如何**协作**而非**独立工作**。

**场景**：用户在 80 轮长对话后，让模型调 Bash 执行 `find / -name "*.log"`。对话已经接近 token 上限（autoCompact 刚跑过一次）。模型开始 stream 输出。

| 阶段 | 现象 | 触发的机制 |
|------|------|-----------|
| t=0 | 用户输入发出，BashTool 注册到 tools 列表 | 机制 3（permission 预检通过） |
| t=2s | stream 开始，模型输出 Bash 命令文本 | 无 |
| t=5s | stream 卡住，光标停 30 秒 | **机制 4（看门狗触发）** — cancel stream |
| t=5.1s | Idle stall 触发 retryOptions 重试 | **机制 1（重试）** — 重试 attempt=2 |
| t=8s | attempt=2 也卡住，可能后端 hang | **机制 1（重试）** — 切换到 non-streaming |
| t=15s | non-streaming 返回，但 max_tokens 截断 | **机制 1（降级）** — fallbackModel |
| t=20s | fallbackModel 输出完整，但 token 已用 95% | **机制 5（瘦身）** — 下次 turn 强制 microCompact |
| t=22s | 模型返回 tool_use `Bash(find...)` | **机制 2（配对）** — messages.ts 准备 tool_result slot |
| t=22.5s | tool_use 触发 canUseTool | **机制 3（权限）** — 5 层检查链 |
| t=23s | check 链 deny（`find /` 路径不被允许） | **机制 3（权限）** — 不执行 |
| t=23.1s | 返回合成 tool_result 表示拒绝 | **机制 2（配对）** — 修复 messages 数组 |
| t=24s | 模型收到拒绝反馈，重写为 `find . -name "*.log"` | 无（模型自治行为） |
| t=30s | 重试成功，输出结果 | — |

**叠加效果**：单个机制都可能失败（看门狗可能漏判、permission 可能漏 deny、重试可能耗尽）——**但 6 个机制叠加后，任意单点失败被其他层兜住**。这就是 defense-in-depth 的实际含义。

### 7.4 稳定性 vs 灵活性的权衡

Harness 做得更严能让模型更稳定，但**会牺牲灵活性**。看 4 个真实权衡：

**权衡 1：strictToolResultPairing 严格模式** —— 更严：配对失败 throw，trajectory 失败（不能再被合成 tool_result 误导）；代价：HFI 评测失败率上升（真实场景里配对错误不少）。设计选择：**默认宽松（默默修复），HFI 主动 opt-in**。

**权衡 2：5 层权限 vs 单层权限** —— 更严：多层 deny 让误操作拦截率上升；代价：每次 tool call 都跑 5 层，最坏情况 5 次 RPC（classifier 调用）。设计选择：`TRANSCRIPT_CLASSIFIER` feature flag 让用户能关掉 classifier（牺牲安全性换性能）。

**权衡 3：HISTORY_SNIP 紧急削减** —— 更严：上下文再撑不爆；代价：snip 后模型可能"忘记"近期 turn 的对话内容。设计选择：**默认不开启**，需要用户主动 `/compact` 或 token 临界才触发。

**权衡 4：fallbackModel 降级** —— 更严：原模型 hang 时仍能继续；代价：降级模型能力可能更弱（比如从 Opus 降到 Sonnet），用户感知"模型变笨了"。设计选择：**默认 fallback 开启，但只在 retry 仍失败时触发**——只在系统异常时退化，正常时不退化。

**一般原则**：**默认宽松（默默修复、自动重试、自动降级）+ 主动 opt-in 严格模式**。这条原则贯穿整个 Harness——用户拿到的是"工业级稳定"的 Agent，但需要严格评测时可以一行配置切到"快速失败"模式。

### 7.5 失败模式 → 稳定机制 → 组件 三层映射

把 8 类失败模式 × 6 个稳定机制 × 12 大组件画成一张表：

| 失败模式 | 主防御机制 | 协同机制 | 主要承载组件 | 主防御代码定位 |
|----------|-----------|---------|-------------|---------------|
| 1 配对错误 | 2 消息修复 | — | 循环层 + 持久化层 | [messages.ts:5591](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/messages.ts) `ensureToolResultPairing` · [claude.ts:1325](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) `messagesForAPI` 包装 |
| 2 流式卡死 | 4 流式看门狗 | 1 重试降级 | UI 层 + 循环层 + Provider 层 | [cli/print.ts:1779](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/cli/print.ts) `createIdleTimeoutManager` · [utils/idleTimeout.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/idleTimeout.ts) |
| 3 上下文撑爆 | 5 上下文瘦身 | — | 上下文层 + 循环层 | [services/compact/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/compact/) 5 阶段栈 · [commands.ts:93](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/commands.ts) `HISTORY_SNIP` |
| 4 自主越权 | 3 权限层防御 | 9 Hook 拦截 | 权限层 + Hook 层 | [permissions.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/permissions.ts) `canUseTool` 5 层链 · [PermissionRule.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/PermissionRule.ts) |
| 5 重复循环 | 6 熔断器 | 1 重试降级 | 循环层 + 状态层 | [query.ts:735](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/query.ts) autocompact 失败计数 · [main.tsx:5101](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/main.tsx) `tengu_auto_mode_config` |
| 6 输出截断 | 1 重试降级 | — | Provider 层 + 循环层 | [claude.ts:847](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) `retryOptions` · [claude.ts:819](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/api/claude.ts) `fallbackModel` |
| 7 Prompt injection | 9 Hook 拦截（间接） | 3 权限层 | Hook 层 + 权限层 | [types/hooks.ts:50-100](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/hooks.ts) Hook schema 严格化 · [ssrfGuard.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/hooks/ssrfGuard.ts) |
| 8 上下文遗忘 | 3 权限层（冗余） | 5 上下文瘦身 | 权限层 + 上下文层 | [permissions.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/permissions.ts) 5 层冗余 · [services/compact/](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/services/compact/) |

**关键洞察**：**没有组件做"稳定"这件事本身**——稳定是所有组件协作涌现的属性。这就是 Harness 设计最难也最微妙的地方：**组件不是清单、是稳定机制的载体**。入口层承载"快速失败"机制，会话层承载"配对修复"机制，循环层承载"重试 + 熔断"机制，上下文层承载"瘦身 + memoize"机制，工具层承载"权限预检"机制，权限层承载"5 层防御"机制，UI 层承载"看门狗 + 紧急输入"机制，Hook 层承载"确定性约束"机制，持久化层承载"conversationRecovery"机制，可观测层承载"事后还原"机制，Provider 层承载"fallback 路径"机制。

---

## 八、边界与局限

Harness 不是万能的。它**故意不解决**以下问题：

1. **不解决 LLM 本身的可靠性**：Harness 可以让"模型做出的事"更可控，但不能让"模型的判断"更准。如果 LLM 把 `rm -rf /` 当成正常命令输出，5 层权限防御可能仍然放行（除非 classifier 识别出来）。真正的鲁棒性需要 LLM 本身进步。
2. **不解决 prompt injection**：Harness 内的 Hook、Permission 都依赖 LLM 输入，但 LLM 输入可以被外部数据（tool result、CLAUDE.md、Skill 文件）注入恶意指令。Hook 输出 schema 严格化只能降低风险，不能消除。
3. **不解决长任务的 token 成本**：compaction 把上下文压短，但每次 turn 还是要重发前 N 轮——100 轮对话的单次 API 调用可能消耗 80K+ input tokens，Harness 不能消除 Anthropic 账单。
4. **不解决多会话状态共享**：进程级 singleton 让 session 间隔离清晰，但跨进程的协作（Bridge、Daemon、ACP）需要 IPC 加额外的并发原语——复杂度没有消失，只是搬到了 Bridge 层。
5. **不解决跨 Harness 互操作**：本 Harness 的 Hook schema、Permission 模型、Tool interface 都是项目内自创的——见 [src/types/hooks.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/types/hooks.ts)（Hook 事件 schema）、[src/utils/permissions/PermissionRule.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/utils/permissions/PermissionRule.ts)（规则 schema）、[src/Tool.ts](https://github.com/claude-code-best/claude-code/blob/d0713bdd/src/Tool.ts)（Tool 接口定义）。这些 schema 没有外部标准参照，因此要与其他 Agent 系统对接需要适配层：项目自身提供了 [27-bridge-and-remote-control](https://github.com/claude-code-best/claude-code/tree/d0713bdd/docs/analysis/claude-code-cli%E6%BA%90%E7%A0%81%E8%A7%A3%E6%9E%90/29-bridge-and-remote-control.md) 的 Bridge 协议和 [28-acp-protocol](https://github.com/claude-code-best/claude-code/tree/d0713bdd/docs/analysis/claude-code-cli%E6%BA%90%E7%A0%81%E8%A7%A3%E6%9E%90/27-acp-protocol.md) 的 ACP 标准作为对外接口，但任何**未走这两个标准**的外部系统都需要写新的适配代码。

---

## 九、总结：Harness 是什么，一句话

**Harness 是把 LLM 当成"远程函数调用"的 SDK，包装成"有状态、可恢复、可控制、可观测、可远程协作的工业级 Agent 运行时"所必需的 12 层基础设施。** 任何一层缺失，Agent 都会从"工业级"退化成"玩具级"——少了入口层就启动慢，少了会话层就不能 resume，少了权限层就裸跑 shell，少了 Hook 层就没有用户控制点，少了持久化层就崩溃即失忆，少了可观测层就不能排障，少了 Provider 层就锁死单一 vendor。

本项目的所有具体设计决策（feature flag、JSONL、5 层权限、stream adapter、bootstrap singleton）都是为了让这十二层**既能完整实现、又能最小化代价**的具体答案。