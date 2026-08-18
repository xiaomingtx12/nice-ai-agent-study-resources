---
slug: /application-notes/engineering/claude-code-cli/cc-03-entry-and-lifecycle
sidebar_position: 3
title: "入口与生命周期"
description: "CLI 启动不是先加载全部再判断，而是先用快速路径匹配轻命令、失败再走 REPL；本篇拆启动路由、会话状态机与多进程角色。"
---

# 入口与生命周期

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2（逆向工程复刻仓库 `claude-code-best/claude-code`，V5 主线，HEAD `d0713bdd`）。该仓库是对 Anthropic Claude Code CLI 的反编译还原，行为层一致、源码层有差异——正文 `src/...` 指向还原仓库内部模块，不能直接对官方 CLI 验证；行号以该 HEAD 为准，可能漂移，以函数名定位。
>
> **核心路径**：
>
> - **启动路由主干**：`src/entrypoints/cli.tsx`（363 行）的 `main()`（`:76`）——本文主线，`:1-69` 是求值期硬修复（`performanceShim` / MACRO 兜底 / FORCE_INTERACTIVE），`:80` 是零模块加载的 `--version`，`:352-359` 是落回默认路径的 8 行，正文一、三节对应。
> - **全量初始化时序**：`src/entrypoints/init.ts` 的 `init()`（`:66` 起，memoize 只跑一次，`:66-280` 是 12 步固定顺序）+ `:289` 的 `initializeTelemetryAfterTrust()`——遥测被刻意推迟到信任对话框之后，正文三节阶段 3 对应。
> - **默认路径主体**：`src/main.tsx`（5640 行，`:743` 的 `main()`、`:3710` 的 `launchRepl` 调用点）与 `src/replLauncher.tsx:14`——Commander 解析 300+ 子命令后交棒给 Ink 渲染树，正文三节阶段 3、4 对应。
> - **子进程 spawn 契约**：`src/utils/cliLaunch.ts:148-157` 的 `spawnCli()`、`src/daemon/main.ts:354-356`（supervisor 拉 worker）、`src/bridge/sessionRunner.ts:335`（每个 bridge session 一个完整 CLI 子进程）——三处共用同一套"进程隔离优于共享内存"的取舍，正文四节对应。
> - **MCP 传输两条路**：`src/services/mcp/client.ts:907-980`（stdio 子进程）、`:911` 注释说明的 Chrome in-process 例外与 `src/services/mcp/InProcessTransport.ts`、`:1280` 的 `transportType` 分流——正文四节 4.5 对应。

**读完本篇你能回答**：`claude` 命令敲下到 Agent 开始工作之间发生了哪些事？16 条快速路径怎么排优先级？为什么不能"先全部加载再判断"？一个 CLI 进程要走完哪些状态才算"一个会话"？

**配套阅读**：[02 §三 组件 1 入口层](cc-02-harness-design.md) 给本篇定位；[04-agent-loop](../02-agent-runtime/cc-04-agent-loop.md) 讲默认路径最终进入的循环层。Daemon / Bridge 等进程形态属于源仓库独有文档 31 / 29 篇,本地 25 篇不展开。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 入口层要解决的三个问题 | 必读，建立问题意识 |
| 二 | 入口层在架构中的位置 | 必读，建立全局坐标 |
| 三 | 启动流程全景：从环境准备到默认路径 | **核心章节**，理解启动路由与初始化时序 |
| 四 | 进程模型与生命周期状态机 | **核心章节**，理解多进程角色与一个会话的 10 个状态 |
| 五 | 核心机制深入：默认路径的 init()、spawn 契约、IDLE 后台任务 | **核心章节**，沿"启动 → spawn → 进入 IDLE"数据流展开 |
| 六 | 环境变量驱动模式 | 参考，查阅环境变量时使用 |
| 七 | 设计决策与权衡 | 理解为什么这样设计 |
| 八 | 边界与局限 | 理解当前实现的不足 |
| 九 | 可复用的模式 | 提炼可迁移的设计模式 |

---

## 一、入口层在 Harness 中要解决的三个问题

入口层是 [02-harness-design](cc-02-harness-design.md) **12 组件中的第 1 层**——它是 Harness 的"启动器"。

理解 Claude Code 代码,必须先理解这一层在 Harness 设计中的位置:**为什么 Harness 必须有入口层?** 不是为了"启动程序"——这是所有 CLI 都做的事。

**而是因为 Harness 是一个 12 层、有状态、有权限、有持久化的工业级 Agent 运行时**——它的入口层要承担三项传统 CLI 不需要承担的工程责任。

### 问题一：启动延迟预算 vs Harness 完整模块图——按需加载是 Harness 的硬约束

[02 §三 组件 1](cc-02-harness-design.md) 已经说过，Harness 由 12 大组件构成，涉及 600+ 个 chunk 文件（完整 Ink 渲染、MCP 连接管理、60+ 工具注册、权限审批 UI、JSONL 持久化、Langfuse tracing……）。如果"启动 = 加载 Harness 全量模块"，那 `claude --version` 也要 ~2s——这对工业级 CLI 是不可接受的。

这不是"模块太多"的性能问题，而是 **Harness 设计原则冲突**：Harness 需要完整模块支撑工业级特性，但作为 CLI 又必须在 50ms 内响应简单查询。**入口层用"按需加载"化解这个冲突**——16 条快速路径让 90% 的简单命令跳过完整模块图，只加载本次实际需要的 0-4 个模块。

`cli.tsx:80` 的 `--version` 路径**零模块加载**——args 长度=1 且匹配标志就直接 `console.log(MACRO.VERSION)` 后 `return`，连 `import` 都跳过。这条优化让 `claude --version` 启动时间从 ~2s（默认路径）降到 50ms。**这是 Harness 设计要求驱动的代码组织**——而不是"性能优化"。

### 问题二：多模式启动 vs Harness 的多形态集成——动态 import 是 Harness 的入口契约

Harness 不是单一形态的 Agent 运行时——它要支持 **交互式 REPL**（需要 Ink 渲染、权限审批 UI）、**管道模式 headless**（`-p`，无 TTY，输出 JSON）、**ACP Agent 模式**（stdio 上的 Agent Client Protocol）、**Daemon worker**、**Bridge 远程控制**、**Computer Use MCP server**、**各种状态查询命令**……

这些模式的 Harness 模块需求差异巨大。如果把所有模式需要的模块都在入口处统一 import，那最轻量的 `--version` 也会被迫加载最重的 REPL 依赖。

**入口层用"动态 import + feature flag DCE"承担 Harness 的多形态集成责任**：
- 动态 import 让每条快速路径只 import 它需要的模块
- Bun 的 `feature()` 编译期 DCE（dead code elimination）让未启用的功能从产物中**物理删除**（字节码中不存在，不是运行时跳过）——一旦 `feature()` 不在 `if (...)` 条件最左边，DCE 就失效
- 代码重复是有意为之：多条路径各自调用 `enableConfigs()`、`profileCheckpoint`、`setShellIfWindows()`，**因为默认路径的 import 没执行，各快速路径不能依赖"已经在全局作用域准备好了什么"**

### 问题三：会话生命周期 vs Harness 的 12 组件初始化时序——显式状态机是 Harness 的协同契约

一个 Harness 会话从用户输入第一句话到进程退出，经历的不是简单的"开始→运行→结束"三步——中间有配置初始化、MCP 连接建立、权限策略加载、遥测启动、Hook 注册、上下文组装、工具执行、结果持久化、压缩触发——**每一个 [02 §三](cc-02-harness-design.md) 列出的 Harness 12 组件，都有自己的初始化逻辑和清理逻辑**。

如果这些阶段之间没有清晰的状态机定义，就会出现"某个组件在另一个组件还没初始化完就开始使用它"的时序问题。**入口层用 `init()` + `setupGracefulShutdown()` + 12 步固定顺序**承担 Harness 12 组件的初始化协同责任——`init()` 是 `memoize(async () => ...)`，多次调用只跑一次；`setupGracefulShutdown()` 注册 SIGTERM/SIGINT handler，保证组件级清理在退出时被强制执行。

**这三个问题——按需加载、多形态集成、显式状态机——共同决定了入口层必须是"动态 import + feature flag DCE + init() 固定顺序"的设计。** 下一节先定位入口层在 Harness 12 组件中的具体位置，再展开这套设计在代码里的实现。

---

## 二、入口层在 Harness 12 层架构中的位置

入口层是 Harness 12 组件的**最外层壳**——[02 §三 组件 1](cc-02-harness-design.md) 给出的 12 层架构图里，它位于最顶端，下面依次是会话层、状态层、循环层……直到 Provider 层。它不实现任何 Harness 的 Agent 逻辑——不参与推理、不执行工具、不管理上下文。**它的唯一职责是：根据用户意图，选择性地加载下层模块，然后把控制权交给它们。**

这种"路由而不执行"的定位意味着入口层是 Harness 中**唯一可以"看到所有下层"的层**——它必须知道循环层怎么启动、UI 层怎么渲染、持久化层怎么初始化、Provider 层怎么选模型、Hook 层怎么注册、权限层怎么校验。但其他 11 层通常**不感知入口层的存在**——它们不关心"我是怎么被启动的"，只关心"我的输入是什么、我的输出给谁"。这是一个**单向依赖**：入口层依赖所有下层，但没有下层反向依赖入口层。

```
┌──────────────────────────────────────────────────────────────┐
│  入口层 (本文 — Harness 组件 1)                              │
│  cli.tsx (363 行) → main.tsx (5640 行) → launchRepl()       │
│  职责: 路由 CLI 参数、初始化 Harness 12 组件、加载下层         │
└──────────────────────────────────────────────────────────────┘
         │                  │                    │
         ▼                  ▼                    ▼
   [Harness 组件 3 状态层] [组件 10 持久化层] [组件 4 循环层 + 组件 8 UI 层]
   bootstrap/state.ts       sessionStorage.ts    query() + REPL.tsx
   (sessionId/模型/模式)    (JSONL transcript)   (Reason→Act→Observe)
```

**在 [02 §四 20 步路径](cc-02-harness-design.md#四一次完整请求的-harness-路径) 中，入口层负责步骤 1（CLI args 解析）→ 步骤 2（信任对话框）→ 步骤 3（一次性初始化）**——这三步完成后，控制权才交给循环层和 UI 层。**入口层的代码质量决定了 Harness 启动阶段的稳定性**——[02 §七.5](cc-02-harness-design.md#75-失败模式--稳定机制--组件-三层映射) 中失败模式 1（启动时配置错误）的协同防御者（`policySettings` 强制覆盖、`trust dialog` 强制确认、Idempotent `init()` 三重保护）全部落在这里。

定位清楚后，下一节进入本文核心——**入口层如何用"动态 import + feature flag DCE + init() 固定顺序"这套设计，实现 Harness 的按需加载、多形态集成、显式状态机三大目标**。

---

## 三、启动流程全景：从 `process.execve()` 到 Harness 第一次调用 query()

这一节把第一节讲的"Harness 入口层三大设计要求（按需加载、多形态集成、显式状态机）"落到代码上。**[02 §四 20 步路径](cc-02-harness-design.md#四一次完整请求的-harness-路径) 中入口层负责的步骤 1→2→3** 在代码里展开为 5 个阶段：阶段 0 是 cli.tsx 求值期硬修复（不能延后的副作用）、阶段 1 是 16 条快速路径按需 import、阶段 2 是默认路径的动态 import、阶段 3 是 `init()` 12 步固定顺序、阶段 4 是把控制权交给循环层和 UI 层。**每个阶段对应一个 Harness 设计要求的代码实现**——读懂这 5 个阶段，就能回答"为什么 Harness 入口层要这么写"。

### 3.1 启动过程核心文件树

按"启动先后顺序 + 调用关系"组织(下→上,上→下)。叶子节点是真实文件,内部节点是模块/功能分组。

```
[阶段 0: 进程启动前的硬修复，在 cli.tsx 求值期执行]
src/utils/performanceShim.ts        # cli.tsx 第一个 import：替换 globalThis.performance，修 JSC 内存泄漏
src/entrypoints/cli.tsx             # 真正入口，顶层 await main() (363 行)
  │
  ├── [阶段 1: 顶部模块级副作用]
  │   src/utils/envUtils.ts         # isEnvTruthy()，用于 FORCE_INTERACTIVE 判定
  │   bun:bundle                    # feature() 编译期 DCE 开关
  │
  ├── [阶段 2: main() 内的快速路径路由，按需 import]
  │   ├── --version 分支            # 0 模块加载，直接 console.log(MACRO.VERSION)
  │   │                             # 注：MACRO 由 build/dev 注入，顶部有 fallback 兜底
  │   │
  │   ├── --dump-system-prompt      # 4 模块：config + model + prompts
  │   │   ├── src/utils/config.ts           # enableConfigs()
  │   │   ├── src/utils/model/model.ts      # getMainLoopModel()
  │   │   └── src/constants/prompts.ts      # getSystemPrompt()
  │   │
  │   ├── --claude-in-chrome-mcp    # 2 模块：Chrome 扩展桥接
  │   │   └── src/utils/claudeInChrome/mcpServer.ts
  │   ├── --chrome-native-host
  │   │   └── src/utils/claudeInChrome/chromeNativeHost.ts
  │   ├── --computer-use-mcp        # 2 模块：截图+键鼠
  │   │   └── src/utils/computerUse/mcpServer.ts
  │   │
  │   ├── --acp                     # 2 模块：Agent Client Protocol stdio
  │   │   └── src/services/acp/entry.ts
  │   │
  │   ├── weixin 子命令              # 8 模块：微信集成（独立 runtime）
  │   │   └── packages/@claude-code-best/weixin
  │   │
  │   ├── --daemon-worker=<kind>    # 1 模块：supervisor spawn 的 worker
  │   │   └── src/daemon/workerRegistry.ts
  │   │
  │   ├── remote-control / rc / bridge / sync
  │   │   ├── src/utils/config.ts                # enableConfigs()
  │   │   ├── src/bridge/bridgeEnabled.ts        # getBridgeDisabledReason()
  │   │   ├── src/bridge/types.ts                # BRIDGE_LOGIN_ERROR
  │   │   ├── src/bridge/bridgeConfig.ts         # getBridgeAccessToken()
  │   │   ├── src/utils/auth.ts                  # getClaudeAIOAuthTokens()
  │   │   ├── src/services/policyLimits/index.ts # waitForPolicyLimitsToLoad()
  │   │   └── src/bridge/bridgeMain.ts           # 入口
  │   │
  │   ├── daemon 子命令              # 5 模块：supervisor 自身
  │   │   ├── src/utils/config.ts
  │   │   ├── src/utils/windowsPaths.ts          # setShellIfWindows()
  │   │   ├── src/utils/sinks.ts                 # initSinks()
  │   │   └── src/daemon/main.ts                 # daemonMain()
  │   │
  │   ├── autonomy 子命令            # 2 模块：状态查询
  │   │   └── src/cli/handlers/autonomy.ts
  │   │
  │   ├── --bg / --background       # 4 模块：启动后台会话
  │   │   └── src/cli/bg.ts
  │   │
  │   ├── job 子命令                 # 2 模块：template jobs
  │   │   └── src/cli/handlers/templateJobs.ts
  │   │
  │   ├── --tmux + --worktree 组合  # 4 模块：exec into tmux
  │   │   ├── src/utils/worktreeModeEnabled.ts
  │   │   └── src/utils/worktree.ts              # execIntoTmuxWorktree()
  │   │
  │   └── [阶段 3: 默认路径（无快速路径命中）]
  │       ├── src/utils/earlyInput.ts            # startCapturingEarlyInput()
  │       ├── src/main.tsx                       # cliMain() (5640 行，Commander.js)
  │       │   │
  │       │   ├── src/entrypoints/init.ts        # init() (392 行，默认路径唯一入口)
  │       │   │   ├── src/utils/config.ts               # enableConfigs() — 第 1 步
  │       │   │   ├── src/utils/env.ts                  # applySafeConfigEnvironmentVariables()
  │       │   │   ├── src/utils/tls.ts                  # applyExtraCACertsFromConfig() — TLS 之前
  │       │   │   ├── src/utils/shutdown.ts             # setupGracefulShutdown()
  │       │   │   ├── src/services/analytics/firstPartyEventLogger.ts  # 1P event logging（异步）
  │       │   │   ├── src/services/analytics/growthbook.ts              # GrowthBook（异步）
  │       │   │   ├── src/services/providerUsage/balance/poller.ts     # balance polling
  │       │   │   ├── src/utils/oauth.ts                # populateOAuthAccountInfoIfNeeded()
  │       │   │   ├── src/utils/ide/jetbrains.ts        # initJetBrainsDetection()
  │       │   │   ├── src/utils/gitRepo.ts              # detectCurrentRepository()
  │       │   │   ├── src/services/remoteManagedSettings.ts            # 预热 remote settings
  │       │   │   ├── src/services/policyLimits/index.ts               # 预热 policy limits
  │       │   │   ├── src/utils/mtls.ts                # configureGlobalMTLS()
  │       │   │   ├── src/utils/proxyAgents.ts         # configureGlobalAgents()
  │       │   │   ├── src/services/observability/sentry.ts             # initSentry()
  │       │   │   ├── src/services/langfuse/client.ts  # initLangfuse()
  │       │   │   ├── src/utils/auth.ts                # initUser()
  │       │   │   ├── src/services/api/claude.ts       # preconnectAnthropicApi() — TCP+TLS 预连
  │       │   │   └── src/utils/windowsPaths.ts        # setShellIfWindows()
  │       │   │
  │       │   ├── Commander.js 解析 subcommand       # 300+ 个子命令注册在 main.tsx 中
  │       │   ├── src/utils/dialogLaunchers.tsx      # checkHasTrustDialogAccepted()
  │       │   ├── src/entrypoints/init.ts            # initializeTelemetryAfterTrust()
  │       │   ├── src/utils/permissions/PermissionMode.ts  # 权限模式初始化
  │       │   ├── src/services/mcp/MCPConnectionManager.tsx # MCP 连接池 (useManageMCPConnections)
  │       │   │
  │       │   ├── [阶段 4: REPL 模式（默认）] ─→ 见下方"REPL 子树"
  │       │   │
  │       │   └── [阶段 5: Headless 模式 (-p)] ─→ processUserInput → query() → JSON 输出
  │       │       ├── src/utils/processUserInput/         # 解析 slash command / @mentions
  │       │       ├── src/query.ts                        # Agent 主循环 (2057 行)
  │       │       ├── src/QueryEngine.ts                  # 会话编排器 (1365 行)
  │       │       └── src/context.ts                      # getSystemContext()
  │       │
  │       └── src/utils/startupProfiler.ts        # 各路径打 profileCheckpoint

[REPL 子树（阶段 4：默认路径最终落点）]
src/replLauncher.tsx                # launchRepl() — 桥接 main.tsx 与 Ink
src/components/App.tsx             # Root provider (AppState / Stats / FpsMetrics)
src/components/SentryErrorBoundary.tsx
src/screens/REPL.tsx               # 交互式 REPL 屏幕
  ├── src/components/Messages.tsx          # 消息列表
  ├── src/components/MessageRow.tsx        # 单条消息
  ├── src/components/PromptInput/          # 输入区（21 个子文件）
  ├── src/components/permissions/          # 权限审批弹窗
  └── src/components/design-system/        # 复用 UI 组件
```

**关于这棵树的几条说明**：

- **行号锚定真实文件**：每个文件都在仓库中存在；代码块中标注的行号对应 `cli.tsx:1-363`、`init.ts:66-280`、`main.tsx:743`（`main()` 入口）、`main.tsx:3710`（`launchRepl` 调用点之一）、`query.ts:1-2057`、`QueryEngine.ts:1-1365`，改源码时行号会漂移，但相对位置稳定。
- **缩进表示 import 关系**：子节点被父节点 `import` 进来；同级节点之间没有 import，只是被同一段代码依次调用。
- **同一文件可能出现在多处**：`src/utils/config.ts` 在 7 条快速路径和 init() 中都被 import——因为它是配置硬依赖，每条路径都得先初始化。这是有意为之的代价，见 3.5 节。
- **省略了"运行态"深层文件**：REPL 子树下的组件只列了顶层分类，组件之间的具体依赖留给 [10-tool-execution-pipeline](../03-tools-extensions-governance/cc-10-tool-execution-pipeline.md)。

### 3.2 链路过程：从 `process.execve()` 到第一次 LLM 调用

把上面的代码树按时间顺序展开成五个阶段。每个阶段给"输入 → 输出 → 关键文件"的三元组。

**阶段 0：环境准备（`cli.tsx` 求值期，~5ms）**

进程被 `process.execve()` 拉起，Bun/JSC 开始执行 `cli.tsx`。**这一阶段没有任何函数调用，全是模块级副作用**——所以即便后续 `main()` 走快速路径 `return`，这些代码也已经执行过了：

1. `import '../utils/performanceShim.js'`（`cli.tsx:5`）——把 `globalThis.performance` 替换为 JS 实现。否则 React/OTel 在模块求值阶段就抓到原生引用，JSC 的 `performance.now()` 会让 C++ Vector 无限增长。
2. `if (typeof globalThis.MACRO === 'undefined') ...`（`cli.tsx:11-21`）——直接运行 `cli.tsx`（不走 `bun run dev` 或构建产物）时注入 MACRO 默认值，避免 `MACRO.VERSION` 是 `undefined`。
3. `if (isEnvTruthy(process.env.CLAUDE_CODE_FORCE_INTERACTIVE))`（`cli.tsx:23-36`）——Windows 下嵌套 bun 启动时，stdin/stdout 可能不是 TTY，Ink 会拒绝渲染。这里强行覆写 `isTTY=true`。
4. `process.env.COREPACK_ENABLE_AUTO_PIN = '0'`（`cli.tsx:40`）——禁掉 Corepack 自动 pin，避免污染用户的 `package.json`。
5. `if (CLAUDE_CODE_REMOTE === 'true') NODE_OPTIONS += --max-old-space-size=8192`（`cli.tsx:44-49`）——CCR 容器默认 4GB 堆，16GB 内存机器上 OOM。这里强行拉到 8GB。
6. `if (feature('ABLATION_BASELINE') && CLAUDE_CODE_ABLATION_BASELINE)`（`cli.tsx:56-69`）——实验基线 ablation 开关，批量禁用一系列功能（背景任务、自动压缩、auto memory 等）。**放在 cli.tsx 顶部而不是 init.ts，是因为 BashTool/AgentTool 等工具在模块求值时就把 `DISABLE_BACKGROUND_TASKS` 等常量捕获到模块级 const，init() 跑得太晚，改 env var 也不生效。**

这一阶段的设计哲学：**必须发生且不能延后的事，放在文件顶部**。后面四个阶段都在"可以延后到 `main()` 内部"的范畴。

**阶段 1：快速路径路由（`main()` 前 16 个分支，~50ms-2s 取决于命中）**

`main()`（`cli.tsx:76`）被调用后，顺序匹配以下快速路径（详细行号见上节的代码树）：

```
 1. --version/-v/-V                                    → console.log(MACRO.VERSION); return
 2. --dump-system-prompt  (feature: DUMP_SYSTEM_PROMPT) → 加载 4 模块，输出 system prompt
 3. --claude-in-chrome-mcp                              → runClaudeInChromeMcpServer()
 4. --chrome-native-host                                → runChromeNativeHost()
 5. --computer-use-mcp       (feature: CHICAGO_MCP)    → runComputerUseMcpServer()
 6. --acp                  (feature: ACP)             → runAcpAgent() over stdio
 7. weixin                                              → handleWeixinCli()（独立 runtime）
 8. --daemon-worker=<kind>  (feature: DAEMON)          → runDaemonWorker(kind)
 9. remote-control/rc/remote/sync/bridge (BRIDGE_MODE) → bridgeMain()（Remote Control）
10. daemon subcommand (DAEMON|BG_SESSIONS)             → daemonMain()
11. autonomy                                            → getAutonomyCommandText()（状态查询）
12. --bg/--background     (feature: BG_SESSIONS)       → handleBgStart()
13. ps/logs/attach/kill (deprecated)                    → 转发到 daemon <sub>
14. job <sub>             (feature: TEMPLATES)         → templatesMain()
15. new/list/reply         (deprecated)                 → 转发到 job <sub>
16. --tmux + --worktree                                  → execIntoTmuxWorktree()
17. （无命中）                                           → 默认路径
```

每个分支的代码骨架是统一的：

```typescript
profileCheckpoint('cli_<path>_path');
const { ... } = await import('../...');   // 按需 import
await someEntry(...);
return;
```

**两条贯穿所有路径的设计约束**：

- **feature flag 必须在 `if` 条件位置**（`cli.tsx:93, 116, 124, 165, 183, 231, 266, 279, 297, 308`）——`feature()` 是 Bun 编译期 DCE（dead code elimination）的钩子，只有当它直接出现在 `if (...)` 条件的最左边时，Bun 的 AST 分析器才能把整段代码从产物中物理删除（字节码中不存在，不是运行时跳过）。一旦赋值给变量、放进箭头函数体、放在 `&&` 链的非首位，DCE 就会失效，导致未启用的功能也出现在构建产物里。
- **代码重复是有意为之**——多条路径各自调用 `enableConfigs()`、`profileCheckpoint`、`setShellIfWindows()`。这是因为默认路径的 import 没执行，各快速路径不能依赖"已经在全局作用域准备好了什么"。代价是几行重复代码，收益是 `--version` 能稳定 50ms。

**阶段 2：默认路径入口（`cli.tsx:352-359`，~50-150ms）**

当所有快速路径都不命中，进入默认路径。这段代码只有 8 行（`cli.tsx:352-359`）：

```typescript
const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
startCapturingEarlyInput();
profileCheckpoint('cli_before_main_import');
const { main: cliMain } = await import('../main.jsx');
profileCheckpoint('cli_after_main_import');
await cliMain();
profileCheckpoint('cli_after_main_complete');
```

四步动作各有明确目的：

1. **`startCapturingEarlyInput()`**——`main.jsx` 的 import 耗时可达 100ms+，这段时间用户可能已经敲了几个字符。这函数把 stdin 切到行缓冲模式并暂存输入，等 REPL 渲染好之后再回放。`-p` 管道模式下 stdin 不是 TTY，内部 `process.stdin.isTTY` 检查会直接跳过，不会有副作用。
2. **`profileCheckpoint('cli_before_main_import')`**——在 import 之前打时间戳，标记"现在开始加载全量 CLI"。
3. **`import('../main.jsx')`**——动态 import 触发 Bun 解析所有 chunk 文件。这是整段启动中**最耗时**的一步，600+ 个 chunk 全部走完。
4. **`cliMain()`**——执行 `main.tsx:743` 的 `main()`（注意和 `cli.tsx` 的 `main()` 重名，后者被 alias 为 `cliMain`）。

**阶段 3：全量初始化（`init()` + Commander 解析，~100-300ms）**

`main.tsx` 的 `main()` 内部第一件事就是 `await init()`（从 `src/entrypoints/init.ts` import）。`init()` 是个 `memoize(async () => ...)`（`init.ts:66`），多次调用只跑一次。它的执行序列（`init.ts:66-280`）按"必须在 X 之前完成"的约束排序：

| # | 步骤 | 行号 | 必须在前的原因 | 失败后果 |
|---|------|------|---------------|---------|
| 1 | `enableConfigs()` | 74 | 所有模块读 `settings.json`，硬依赖 | 启动阻塞 |
| 2 | `applySafeConfigEnvironmentVariables()` | 88 | 信任对话框前只应用"安全" env vars | 不安全变量被应用 |
| 3 | `applyExtraCACertsFromConfig()` | 93 | Bun BoringSSL 启动时缓存 CA store，事后改无效 | TLS 用错证书 |
| 4 | `setupGracefulShutdown()` | 101 | SIGTERM/SIGINT handler 必须先装 | cleanup 注册丢失 |
| 5 | 1P event logging + GrowthBook | 108-119 | GrowthBook 需要 auth context，但不阻塞 | 后台异步跑 |
| 6 | balance polling | 123 | 异步启动，无依赖 | — |
| 7 | OAuth/IDE/git 探测 | 130-138 | 异步预热 cache | — |
| 8 | remote managed settings + policy limits 预热 | 143-148 | plugin hooks 需要 await | — |
| 9 | `configureGlobalMTLS()` + `configureGlobalAgents()` | 157, 166 | 网络层就绪 | 后续 HTTP 走错代理 |
| 10 | `initSentry()` + `initLangfuse()` + `initUser()` | 174-180 | tracing 上下文 | trace 缺 user id |
| 11 | `preconnectAnthropicApi()` | 188 | TCP+TLS 握手与后续 action handler 并行 | 首请求 TTFT+100ms |
| 12 | `setShellIfWindows()` | — | Windows git-bash 探测 | bash 工具失败 |

**关键的"信任对话框时序"：`init()` 故意不调用 `doInitializeTelemetry()`**。遥测（`initializeTelemetryAfterTrust()`，`init.ts:289`）延后到 `main.tsx:3144` 的 action handler 里，在 `checkHasTrustDialogAccepted()` 之后调用——用户在信任对话框拒绝遥测时，OpenTelemetry 模块根本不会被加载。

`init()` 跑完后，Commander.js 开始解析 argv，匹配 300+ 个 subcommand（`mcp / server / ssh / agents / plugin / config / ...`）。命中 subcommand 后，执行对应的 `.action()` handler；无 subcommand 时进入默认 `.action()`（`main.tsx:3140+`），即"进入 REPL 或 headless"。

**阶段 4：进入运行态**

`main.tsx:3710`（以及其他 5 个类似位置，如 3764/3842/3964/4135/4371/4449）调用 `launchRepl(root, appProps, replProps, renderAndRun)`（`src/replLauncher.tsx:14`）。这个 32 行的桥接函数只做一件事：

```typescript
const { App } = await import('./components/App.js');
const { SentryErrorBoundary } = await import('./components/SentryErrorBoundary.js');
const { REPL } = await import('./screens/REPL.js');
await renderAndRun(root, <SentryErrorBoundary>...<App><REPL ... /></App>);
```

到这里就进入了运行态——用户开始看到 REPL 屏幕。`REPL.tsx` 内部的工作流（用户输入 → `processUserInput()` → `query()` → 流式渲染）已经在 [04-agent-loop](../02-agent-runtime/cc-04-agent-loop.md) 详述，不在本文重复。

**Headless 模式（`-p`）** 不走 REPL 子树，而是直接调用 `processUserInput()` → `query()`（`src/query.ts:276`）→ 流式收集结果 → 输出 JSON → `process.exit()`。链路见 [01-layer-overview](https://github.com/claude-code-best/claude-code/tree/d0713bdd/docs/analysis/claude-code-cli%E6%BA%90%E7%A0%81%E8%A7%A3%E6%9E%90/01-layer-overview.md) §4.3 数据流 1。

---

## 四、进程模型：Harness 多形态协作的物理基础

[02 §三 组件 1](cc-02-harness-design.md) 在抽象层定义了入口层的职责，但 Harness 真正运行时是**多进程协作**——入口层不仅决定"自己这个进程怎么启动"，还决定"什么时候拉子进程、子进程怎么通信、子进程什么时候退出"。**Harness 设计上的多形态集成要求（问题二）必须落到 OS 进程层**——REPL、Daemon worker、Bridge session、MCP server、NAPI 原生线程是 5 类不同的物理实体，每一类对应一种 Harness 设计需求：长会话（主进程）、后台任务（Daemon worker）、远程控制（Bridge session）、外部工具（MCP server）、平台能力（NAPI）。

这一节回答"Harness 跑着哪些进程/线程、它们各自在什么场景下被拉起来、什么时候退出"。**Agent 系统天然存在"长会话 vs 短任务""主线程 vs 后台 worker""本地 vs 远端"的张力**——这套项目用一个清晰的进程模型把张力收敛到 4 类进程 + 1 类原生线程。

### 4.1 总览:项目里的 4 类进程 + 1 类原生线程

```
┌─────────────────────────────────────────────────────────────────────┐
│ 主进程 (Main Process)                                                │
│  CLI 入口 + REPL/headless,持有 Ink 渲染树、60+ 工具注册表、MCP 池     │
│  资源: ~500MB                                                        │
└─────────────────────────────────────────────────────────────────────┘
       │ spawn                       │ spawn
       ▼                             ▼
┌──────────────────┐         ┌─────────────────────┐
│ Daemon supervisor│         │ Bridge 进程         │
│ (src/daemon)     │ ─────►  │ (src/bridge)        │
│ 长驻, ~50MB      │ spawn   │ HTTP+WebSocket,     │
│ 不执行 Agent 任务│ worker  │ Remote Control      │
└──────────────────┘         └─────────────────────┘
       │ spawn
       ▼
┌──────────────────┐
│ Daemon worker    │  单次任务, ~300MB, 跑完即退出
│ (--daemon-worker)│
└──────────────────┘

┌────────────────────────┐    ┌──────────────────────────┐
│ MCP server 子进程      │    │ Bridge session 子 CLI 进程│
│ stdio/SSE/HTTP 传输    │    │ (被 bridgeMain 拉起)      │
│ 外部工具宿主           │    │                          │
└────────────────────────┘    └──────────────────────────┘

┌────────────────────────┐
│ NAPI 原生线程(5 个)    │  Rust/C++ 后端线程,由 Bun FFI 拉起
│ audio/image/color/      │  不在 JS 主 event loop 上
│ modifiers/url-handler   │
└────────────────────────┘
```

**关键的预设**:

- **几乎没有真线程**——5 个 NAPI 包是项目里**唯一**用到的原生线程,其他所有并发都是"多进程"+"JS 单线程 event loop"。这与"线程更轻量"的直觉相反,本文 4.6 节解释为什么。
- **每个 Bridge session 是独立 CLI 进程**——不是线程、不是 worker pool,是完整的 `claude` 子进程,带自己的 ~500MB 内存占用。Bridge 同时跑多个 session 时,内存叠加。
- **Daemon worker 是短命进程**——一次任务跑完即退出,操作系统回收全部物理内存。这是"防止内存累积"的关键设计。
- **MCP server 两种跑法**——stdio 子进程(默认,每 server ~325MB)或在主进程内跑(InProcessTransport,只给 Chrome MCP 等轻量 server 用)。

### 4.2 主进程:永远只有 1 个

**触发场景**:用户敲 `claude`(无任何参数),或者 `claude <args>` 没命中 16 条快速路径中的任何一条,进入默认路径。

**生命周期**:从 `process.execve()` 拉起(`cli.tsx:1-69` 顶部模块级副作用先跑)→ `main()` 快速路径检查 → 默认路径 `import('../main.jsx')` → `init()` → Commander 解析 → 进入 REPL 或 headless → 用户主动退出(`Ctrl+C` 或 `exit` 命令)。

**唯一性约束**:

- 主进程**没有自我复制机制**——任何需要并行处理的场景,都用 `child_process.spawn()`(经 `buildCliLaunch` / `spawnCli` 包装)拉起**子 CLI 进程**,而不是在主进程内 fork。`src/utils/cliLaunch.ts:148-157` 的 `spawnCli()` 是统一入口。
- 进程内**没有真线程**——React/Ink 用单线程 event loop 跑渲染,Node/Bun 默认也是单线程。多个异步操作靠 event loop 调度,不占用多核。
- **主进程退出 = 全局退出**——主进程退出前需要 flush transcript、关闭 Langfuse trace、断开 MCP 连接、清理临时文件(`init.ts:101` 的 `setupGracefulShutdown()` 注册 SIGTERM/SIGINT handler)。其他子进程不感知主进程的退出意图,需要主进程主动通知。

### 4.3 Daemon supervisor 与 Daemon worker:长驻管家 + 短命临时工

这两类进程**只在使用 daemon 功能时存在**(`FEATURE_DAEMON=1` 或 `FEATURE_BG_SESSIONS=1`)。

#### 4.3.1 Daemon supervisor(长驻管家,~50MB)

**触发场景**:用户执行 `claude daemon start`(对应 `cli.tsx:231-242` 快速路径)。supervisor 是用户**显式启动**的——它不随主 REPL 自动起,也不随主 REPL 自动停。

**核心职责**(不执行任何 Agent 任务):

1. 接收任务请求——来自主 REPL(`src/cli/bg/engines/detached.ts:25-34`)或定时触发(`src/utils/cron.ts` 解析 cron 表达式)。
2. 拉起 worker——通过 `spawnCli(buildCliLaunch([--daemon-worker=<kind>]))`(`src/daemon/main.ts:354-356`)创建 worker 子进程。
3. 监控 worker 状态——监听 child 的 `exit` 事件,清理 `WorkerState`,记录到调度日志。
4. 通信机制——supervisor 与外部(主 REPL、其他 CLI 实例)通过**文件系统 + 进程信号**通信,没有共享内存。任务定义写在 `.claude/scheduled_tasks/`,状态写在 `.claude/daemon_state/`。

**为什么单独拉一个 supervisor 而不是让主 REPL 兼任?**

- **生命周期独立**——supervisor 在用户关掉 REPL 后还能继续跑(后台任务如 "每 30 分钟检查 CI" 不能因为用户退出 REPL 就停)。
- **资源占用轻量**——supervisor 不加载 Ink 渲染引擎、60+ 工具、权限审批 UI,只跑一个 `daemonMain()`,~50MB 内存。如果让主 REPL 兼任,光是常驻就要 ~500MB。

**退出条件**:用户显式 `claude daemon stop`,或系统关机。

#### 4.3.2 Daemon worker(短命临时工,~300MB)

**触发场景**:

| 触发方 | 场景 | 代码位置 |
|--------|------|---------|
| supervisor 拉起 | 定时任务到期(cron 表达式) | `src/daemon/main.ts:354-356` |
| supervisor 拉起 | 用户在 REPL 里执行 `--bg`(后台任务) | `src/cli/bg/engines/detached.ts:25-34` |
| 主 REPL 拉起 | `assistant` 命令、`remoteControlServer` 命令需要 daemon 服务时 | `src/commands/assistant/assistant.tsx:68-70`、`src/commands/remoteControlServer/remoteControlServer.tsx:206-208` |

**生命周期**:worker 进程**只加载 1 个模块**(`src/daemon/workerRegistry.ts`,对应 `cli.tsx:164-176` 快速路径),不加载任何 UI、工具、MCP。任务跑完(或失败)即 `process.exit()`。

**关键约束**:

- **不调用 `enableConfigs()`**——配置在 supervisor 启动时已加载,worker 通过 env vars 接收必要参数(`src/daemon/main.ts:344-348` 的 `env` 注入)。
- **不加载 analytics sinks**——worker 是临时进程,不需要遥测上下文(`cli.tsx:159-163` 注释明确说明)。
- **内存彻底回收**——这是短命设计的核心收益:worker 退出后,操作系统回收全部 ~300MB 物理内存。如果是线程,这部分内存不会自动归还 OS(V8/JSC allocator 缓存)。

**为什么不用线程?**

| 维度 | 进程 | 线程 |
|------|------|------|
| 内存回收 | 退出后 OS 全收 | 释放后留在堆,allocator 不一定归还 |
| 崩溃隔离 | worker 崩了 supervisor 检测到 exit,可重启 | 一个段错误带走整个进程 |
| 生命周期 | supervisor 优雅关闭通知 worker 完成 | supervisor 退出会强杀 worker |
| 权限隔离 | 每个 worker 可独立 env | 共享进程 env |

这四点正是"Agent worker 内存占用大 + 任务隔离要求高 + 不能随 supervisor 一起死"的场景需要的。

### 4.4 Bridge 进程:Remote Control 的 HTTP/WebSocket 服务器

**触发场景**:用户执行 `claude remote-control`(`cli.tsx:182-226` 快速路径,`BRIDGE_MODE` feature flag 必须启用)。这是**独立 CLI 进程**,与 daemon supervisor 并列——但职责完全不同:supervisor 管"本地后台任务",bridge 管"远程会话接入"。

#### 4.4.1 进程拓扑:Bridge 是 I/O 路由器,不是 query 执行者

bridge 进程自身**不跑任何 query()**——它只做两件事:接收 WebSocket 消息 → 转发到对应 session 子进程的 stdin;读 session 子进程的 stdout → 转发回 WebSocket。"执行 Agent 推理"这件事由每个 session 子进程独立完成。

```
bridge 进程 (HTTP+WebSocket,~300MB)               ← 自己不跑 query
   │                                               ← 只做 stdin/stdout 转发
   │ child_process.spawn(deps.execPath, args, {   ← sessionRunner.ts:335
   │   cwd, stdio: ['pipe','pipe','pipe'], env })
   ▼
┌──────────────────────────────────────────────┐
│ session 1 (CLI 子进程)  ~500MB               │
│   └─ 走 cli.tsx 默认路径 → init() → query()  │
│ session 2 (CLI 子进程)  ~500MB               │
│   └─ 走 cli.tsx 默认路径 → init() → query()  │
│ session 3 (CLI 子进程)  ~500MB               │
│   └─ 走 cli.tsx 默认路径 → init() → query()  │
│ session N (CLI 子进程)  ≤ maxSessions 配置   │
└──────────────────────────────────────────────┘
```

**关键代码**(`src/bridge/sessionRunner.ts`):

```typescript
// 第 1 行:直接从 child_process 模块导入,不是 worker_threads
import { type ChildProcess, spawn } from 'child_process'

// 第 335 行:每次新增 session 都 spawn 一个全新的 CLI 子进程
const child: ChildProcess = spawn(deps.execPath, args, {
  cwd: dir,                                  // 每个 session 可在不同工作目录
  stdio: ['pipe', 'pipe', 'pipe'],           // 三通:stdin/stdout/stderr
  env,                                       // 注入 CLAUDE_CODE_USE_CCR_V2 等环境变量
  windowsHide: true,
})
```

`deps.execPath` 指向完整的 `claude` 二进制(或 `bun run cli.tsx` 的 node 运行时),`args` 包含 `--session=<id>`、`--sdk-url=<ws>`、`--access-token=<jwt>` 等。子进程启动后,自己走 `cli.tsx:352` 默认路径 → `init()` → `launchRepl()` → 进入 idle 等待 stdin 命令;bridge 进程在另一端写 stdin 控制请求(权限审批、子任务派发),读 stdout NDJSON 事件流(消息流、工具结果、错误)。

#### 4.4.2 为什么是子进程不是线程?

这套"Bridge 拉多个 session 同时跑不同任务"的实现,直觉上像是线程池/协程池,但代码里**完全不是**——是 N 个独立 OS 进程。四个原因:

1. **transcript 隔离** — 每个 session 需要独立的 JSONL transcript(写到 `~/.claude/sessions/<uuid>.jsonl`)。同进程内多 session 共享 `sessionStorage.ts` 会触发并发 append 冲突,必须文件锁,复杂度激增;独立进程天然各自写自己的文件。
2. **MCP 连接隔离** — MCP 连接池是 process-global 资源,两个 session 共享会争抢同一个数据库连接/同一个 WebSocket。子进程各自维护 MCP pool,完全无干扰。
3. **permission 上下文隔离** — HITL(人工审批)弹窗、权限规则缓存都是模块级单例(`bootstrap/state.ts`),两个 session 同时触发权限请求会互相覆盖 UI 状态。子进程让 permission 上下文天然按进程分片。
4. **崩溃隔离** — 一个 session 的工具执行可能触发任意代码路径(NAPI segfault、第三方 MCP server 异常、`process.exit()`),子进程崩了 bridge 检测到 `child.on('exit')` 清理即可,其他 session 不受影响。

#### 4.4.3 资源代价:N × 500MB

**每个 session = 完整 CLI 子进程 = ~500MB 内存**。bridge 同时跑 10 个 session = ~5GB 内存开销。这不是 bug,是设计取舍——`bridgeMain.ts` 里有 `maxSessions` 配置项作为上限(默认 4-8 个),防止用户无限制开 session 把机器内存吃光。

| session 数 | 内存预估 | 适用场景 |
|-----------|---------|---------|
| 1 | ~800MB(bridge + session) | 个人单设备 |
| 4(default) | ~2.3GB | 小团队协作 |
| 10(max) | ~5.3GB | 团队多 session 并发 |
| 100(理论) | ~50GB | ⚠️ 不可行 |

如果未来要支持"百级并发 session",唯一可行的优化路径是把"每个 session 完整 CLI 进程"换成"每个 session 共享基础模块、只独立自己的状态",但这要求重构 transcript/MCP/permission 三套系统,代价远大于收益。

#### 4.4.4 触发条件

- 远程客户端(Web 控制面板、移动 App)发来请求 → `bridgeMain.ts:910` 的 `spawnStartTime = Date.now()` 触发 `spawnSession()`(`src/bridge/sessionRunner.ts`)拉起 session。
- 用户在本地通过 `claude remote-control --spawn --capacity=<N>` 显式预热 session 池(`bridgeMain.ts:87` 注释说明)。
- `--create-session-in-dir=<dir>` 标志——在指定目录创建 session(`bridgeMain.ts:87`)。

#### 4.4.5 生命周期

- bridge 进程:长驻,直到用户 `Ctrl+C` 或显式停止。
- bridge session:按需 spawn,任务结束(用户关闭远程会话、session 超时、或达到 `maxSessions` 上限)即退出。

#### 4.4.6 通信协议

- 客户端 ↔ bridge:HTTP(认证、配置)+ WebSocket(消息流、JWT 鉴权,`src/bridge/jwtUtils.ts`)。
- bridge ↔ session:三通 stdio pipe — stdin 写入 JSON-RPC 控制请求(权限审批、子任务派发),stdout 读取 NDJSON 事件流(消息流、工具结果),stderr 收集错误日志。`sessionRunner.ts:335` 用 `stdio: ['pipe','pipe','pipe']` 全部接管。
- bridge ↔ 外部 webhook:`webhookSanitizer.ts` + `workSecret.ts` 处理鉴权与清理。

### 4.5 MCP server 子进程:外部工具的宿主

**触发场景**:用户在 `settings.json` 里配置了 MCP server(`mcpServers` 字段),或者 REPL 启动时通过 `useManageMCPConnections` 建立连接(`src/services/mcp/MCPConnectionManager.tsx`)。

**两种运行模式**:

#### 模式 A:stdio 子进程(默认,每个 server ~325MB)

通过 `StdioClientTransport`(`@modelcontextprotocol/sdk/client/stdio.js`)启动 server 子进程:

```
MCPConnectionManager → new StdioClientTransport(command, args, env)
                     → child_process.spawn(command, args, {stdio: ['pipe','pipe','pipe']})
                     → 子进程 stdio 透传 JSON-RPC 消息
```

代码位置:`src/services/mcp/client.ts:907-980` 的 stdio 传输路径。配置示例(`settings.json`):

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

每个 stdio MCP server 是独立 OS 进程,有自己的 stdio 三通(stdin 收请求/stdout 返响应/stderr 透传给主进程日志)。

#### 模式 B:InProcessTransport(主进程内跑,仅 Chrome MCP)

**触发场景**:`src/services/mcp/client.ts:911` 注释明确说明——"Run the Chrome MCP server in-process to avoid spawning a ~325 MB subprocess"。这是**为 Chrome MCP server 量身定制的优化**。

**原理**(`src/services/mcp/InProcessTransport.ts`):

```typescript
class InProcessTransport implements Transport {
  private peer: InProcessTransport | undefined
  // send() 通过 queueMicrotask 把消息投递到 peer.onmessage
  // close() 同步通知双方 onclose
}
```

两个 `InProcessTransport` 实例成对创建(`_setPeer`),消息通过 JS event loop + microtask 在两个实例间投递,**没有 stdio、没有 child_process**。等价于"在主进程里跑一个轻量 MCP server 库"。

**为什么不都用 InProcessTransport?** 因为 stdio 传输是 MCP 协议标准——大多数第三方 MCP server 都假设自己是独立进程,自己管理 stdio 生命周期。InProcessTransport 是"为了避免 325MB 子进程开销"做的协议层 hack,只对 Chrome MCP 这种"实现简单、资源占用低"的 server 有意义。

**生命周期**:

- stdio MCP server:主 REPL 启动时 spawn,主 REPL 退出时 SIGTERM。
- InProcessTransport:与主 REPL 同生命周期。

#### SSE/HTTP 传输的 MCP server

`src/services/mcp/client.ts:1280` 提到 `transportType = serverRef.type || 'stdio'`,除了 stdio 还有 `sse` 和 `http` 类型。这两类 MCP server 是**外部已运行的进程**——Claude Code 不 spawn 它们,只通过 HTTP/SSE 长连接消费它们的能力。这类 server **不算本项目的子进程**,只算"远程工具源"。

### 4.6 NAPI 原生线程:5 个包,5 个 FFI 后端

项目里有 5 个 `*-napi` workspace 包(`packages/audio-capture-napi`、`image-processor-napi`、`color-diff-napi`、`modifiers-napi`、`url-handler-napi`),它们走 Bun 的 `bun:ffi` 绑定到 Rust/C++ 后端。

**触发场景**:

| 包 | 触发方 | 用途 |
|----|--------|------|
| `audio-capture-napi` | 语音模式启用(`/voice` 命令) | 麦克风 PCM 流捕获 |
| `image-processor-napi` | Claude 处理图片附件 | sharp 包装,缩放/裁剪 |
| `color-diff-napi` | 终端颜色对比计算 | 11 个 test,小但独立 |
| `modifiers-napi` | macOS 按键修饰键检测 | macOS FFI,平台特定 |
| `url-handler-napi` | macOS URL scheme 唤起 | 处理 `claude://` 链接 |

**线程模型**:

- 每个 NAPI 包在加载时通过 `bun:ffi` 拉起**原生线程**(Rust tokio runtime 或 C++ worker thread)。
- JS 主线程通过 async 函数调用 FFI 入口,主线程不阻塞——Bun 把 FFI 调用投递到原生线程,完成后通过 `queueMicrotask` 回到 JS event loop。
- 原生线程**不直接与 JS 共享内存**——数据通过序列化 buffer 传递(image-processor 返回 PNG buffer、audio 返回 PCM bytes)。

**为什么用原生线程而不是纯 JS?**

- audio-capture 需要低延迟持续采样(~10ms 间隔),JS event loop 单线程不够。
- sharp(C++ 图像处理库)本身就是多线程实现,包一层 NAPI 是为了避免在 JS 侧重写。
- macOS FFI 只能调 C/Objective-C,JS 调不通。

**这些原生线程的生命周期**:

- **跟随 Bun 进程**——NAPI 包加载时启动原生线程,进程退出时强制终止,没有优雅关闭路径。
- **共享进程资源**——这是与"多进程"模型的最大区别:NAPI 线程崩了 = Bun 进程崩了。没有 worker supervisor 那种"崩了重启"的保护。
- **不是独立的 OS 进程**——它们是进程内的原生线程,`ps` 看不到,但 `Activity Monitor` / `top -H` 能看到。

### 4.7 进程/线程的"何时不用"——主动避免的反模式

理解了"什么时候用"之后,反过来看"什么时候不用"更能看出设计意图。

| 场景 | 不采用的做法 | 实际做法 | 为什么 |
|------|------------|---------|------|
| 多个并发 LLM 对话 | 同一进程内多协程/线程 | 每个对话一个 bridge session 子进程 | Agent 工作集太大(~500MB),同进程内多份会触发 OOM |
| 后台定时任务 | Node `setInterval` 长驻 | spawn 短命 daemon worker | 长会话内存泄漏会累积;短命进程 OS 全回收 |
| Bridge 多用户 | 进程内 connection pool | 每个 session 一个 CLI 子进程 | session 之间完全隔离,互不污染 transcript |
| 浏览器自动化 | 子进程 | `InProcessTransport` 内联 | 325MB 子进程开销太大,内联只占 ~50MB |
| 图像处理 | 纯 JS 实现 | NAPI 原生线程 | sharp 是 C++ 实现,JS 侧重写是负优化 |
| Audio capture | JS setInterval | NAPI 原生线程 | 10ms 采样间隔要求,JS event loop 抖动太大 |

**共同的设计原则**:**进程隔离 vs 共享内存,二选一时优先进程隔离**。代价是内存叠加(每个 worker 都要加载基础模块),收益是崩溃隔离、内存回收、权限边界。这套权衡在 4.3.2 "为什么不用线程"那张表里有详细对比。

#### 4.7.1 一个常被问到的反模式:"同进程内并发 query()"

这个问题很自然——既然协程/线程都不用,能不能在同一进程内**同时**跑两个 `query()`,各自处理不同任务?代码里**明确禁止**,而不是"没实现"。所有 query() 调用点都是串行的:

```typescript
// src/utils/forkedAgent.ts:573 — AgentTool fork 子代理
for await (const message of query({ messages, systemPrompt, ... })) { ... }

// src/screens/REPL.tsx:3510 — 主 REPL 当前对话
for await (const event of query({ ... })) { ... }

// src/QueryEngine.ts:688 — 会话级编排
for await (const message of query({ ... })) { ... }
```

`for await` 是串行的——一个 query 跑完才能跑下一个。即便 AgentTool 在主 REPL 对话里 fork 子代理,子代理的 query 也是**等主 query 进入工具执行阶段时同步驱动**(`AgentTool/runAgent.ts:776`),不是后台并行。

**三个具体的禁止原因**:

1. **模块级单例冲突** — `query.ts` 内部依赖 `bootstrap/state.ts` 的 session ID、cwd、token count、model override、client type 等模块级单例(`src/bootstrap/state.ts:1-50`)。两个 query 同时跑会互相覆盖这些状态,后启动的会"继承"先启动的 session 配置。
2. **transcript 并发写** — `src/utils/sessionStorage.ts` 的 JSONL append-only 落盘逻辑不是并发安全的。两个 query 同时写同一个 session 文件需要文件锁,而项目刻意避免了锁(append-only 的设计前提是单写者)。
3. **MCP 连接池争抢** — MCP 连接是 process-global 资源,两个 query 同时触发工具调用会争抢同一个 stdio pipe / 同一个 WebSocket。InProcessTransport 看似无冲突,但 microtask 队列里的消息会乱序。

**所以"调多个 query" 在这套项目里只有两种合法语义**:

| 场景 | 实现 | 代码位置 |
|------|------|---------|
| 同进程内串行 query | `for await` 一个接一个跑 | `REPL.tsx:3510`、`forkedAgent.ts:573` |
| 真正并发的多 query | 多个独立 CLI 子进程各自跑 | `sessionRunner.ts:335`(bridge)、`daemon/main.ts:354`(supervisor worker) |

**同进程并发 query 是被设计禁止的**——它不是"未来优化点",而是会破坏三个不变量的硬约束。如果新功能需要"在主 REPL 里后台跑另一个 query",标准做法是 `spawnCli(buildCliLaunch(['--bg', ...]))` 拉子进程,而不是想办法在同进程内并发。

### 4.8 进程间通信(IPC)方式汇总

| 通信方 | 方式 | 位置 |
|--------|------|------|
| 主 REPL ↔ daemon supervisor | 文件系统 + 进程信号 | `.claude/daemon_state/`、SIGTERM |
| daemon supervisor ↔ worker | 文件描述符(stdio/pipe) | `src/daemon/main.ts:354-356` |
| Bridge ↔ bridge session | stdio JSON-RPC | `src/bridge/replBridge.ts` |
| Bridge ↔ 远程客户端 | HTTP + WebSocket | `src/bridge/bridgeApi.ts`、`bridgeMessaging.ts` |
| 主 REPL ↔ MCP server(stdio) | 三通 stdio pipe | `StdioClientTransport` |
| 主 REPL ↔ MCP server(远程) | HTTP/SSE 长连接 | `src/services/mcp/client.ts:1280` |
| 主 REPL ↔ InProcessTransport | JS event loop + microtask | `InProcessTransport.ts` |
| JS ↔ NAPI 原生线程 | FFI + 序列化 buffer | `bun:ffi` 边界 |
| 主 REPL ↔ Computer Use(server) | stdio JSON-RPC | `@ant/computer-use-mcp` |

**每种通信方式都有明确的"协议契约"**——比如 bridge 的 JWT 鉴权、MCP 的 JSON-RPC、daemon 的文件系统锁。这些契约是"进程之间不需要共享内存就能协作"的基础。如果某个 worker 想读另一个 worker 的 transcript,**不能直接访问内存**,必须走文件系统(`~/.claude/sessions/<uuid>.jsonl`)。

至此,本节讲清了"哪些进程、什么场景触发、怎么通信"——下一节把这条线延展到 IDLE 状态下后台任务的设计动机。

