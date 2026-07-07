# 入口与生命周期

> **配套阅读**：本文承接 [01-layer-overview](cc-01-layer-overview.md) 的"入口层"一节，把它展开为完整的启动与生命周期叙事。默认路径加载的 `main.tsx` 最终进入 [03-agent-loop](cc-03-agent-loop.md) 描述的循环层；进程模型中的 daemon 与 bridge 分别在 `21-daemon-mode` 和 `22-bridge-and-remote-control` 详述（源系列第 21/22 篇，本站未收录）。本文聚焦"从敲下命令到 Agent 开始工作"这一段。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 入口层要解决的三个问题 | 必读，建立问题意识 |
| 二 | 入口层在架构中的位置 | 必读，建立全局坐标 |
| 三 | 启动流程：快速路径 + 默认路径 | **核心章节**，理解启动路由与初始化 |
| 四 | 进程模型：为什么用子进程 | 必读，理解多进程角色分离 |
| 五 | 会话/请求生命周期状态机 | **核心章节**，看一个会话从启动到退出的 10 个状态 |
| 六 | 环境变量驱动模式 | 参考，查阅环境变量时使用 |
| 七 | 设计决策与权衡 | 理解为什么这样设计 |
| 八 | 边界与局限 | 理解当前实现的不足 |
| 九 | 可复用的模式 | 提炼可迁移的设计模式 |

---

## 一、它在解决什么问题

CLI 工具的启动性能是用户对它的第一印象。如果一个 `claude --version` 命令需要加载 React/Ink 渲染引擎、MCP 客户端、60 多个工具模块、权限系统、会话管理……那一个本应 50ms 完成的操作就会膨胀到 2 秒以上。用户会觉得"这个工具很重"——而这是不可接受的。

入口层同时面对三个独立的问题：

**问题一：启动延迟预算**

CLI 工具的"黄金窗口"是 100ms。超过这个阈值，用户会明显感知到等待。Anthropic 内部有明确指标：`claude --version` 必须 50ms 内返回。但默认的交互式 REPL 模式需要加载约 600 个 chunk 文件，包括完整的 Ink 渲染引擎、MCP 连接管理、60+ 工具注册表、权限审批 UI——这些模块在 `--version` 场景下全是浪费。

问题不在于"加载了太多模块"，而在于"加载的模块和实际需求不匹配"。`--version` 只需要知道构建时注入的版本号；`--daemon-worker` 只需要注册 worker 并开始接收任务；`--acp` 只需要 stdio 上的 ACP 协议通信。这些场景完全不需要 React 组件树。

**问题二：多模式启动**

同一个二进制文件要支持十几种完全不同的运行模式：
- 交互式 REPL（需要 Ink 渲染、权限审批 UI、MCP 连接）
- 管道模式 headless（`echo "say hello" | claude -p`，无 TTY，输出 JSON）
- ACP Agent 模式（stdio 上的 Agent Client Protocol，对端是另一个程序）
- Daemon worker（supervisor fork 的子进程，执行后台任务后退出）
- Bridge 服务（Remote Control 的 HTTP + WebSocket 服务器）
- Computer Use MCP server（截图和键鼠模拟的独立服务）
- 各种状态查询命令（`daemon status`、`autonomy` 等）

这些模式的模块需求差异巨大。如果把所有模式需要的模块都在入口处统一 import，那最轻量的 `--version` 也会被迫加载最重的 REPL 依赖。

**问题三：会话生命周期**

一个 Agent 会话从用户输入第一句话到进程退出，经历的不是简单的"开始→运行→结束"三步。中间有配置初始化、MCP 连接建立、权限策略加载、遥测启动、Hook 注册、上下文组装、工具执行、结果持久化、压缩触发——每个阶段有独立的初始化逻辑和清理逻辑。如果这些阶段之间没有清晰的状态机定义，就会出现"某个模块在另一个模块还没初始化完就开始使用它"的时序问题。

这三个问题——延迟预算、多模式、生命周期——共同决定了入口层必须"按需加载 + 显式状态机"。下一节先定位它在整体架构中的位置，再展开解决方案。

---

## 二、它放在架构的哪个位置

入口层是整个系统的"最外层壳"。它不实现任何 Agent 逻辑——不参与推理、不执行工具、不管理上下文。它的唯一职责是：**根据用户意图，选择性地加载下层模块，然后把控制权交给它们**。

这种"路由而不执行"的定位意味着入口层是唯一可以"看到所有下层"的层，但它通过动态 import 保持隔离——直到确定需要某个模块之前，不会加载它。

其他层（循环层、API 层、工具层等）通常不感知入口层的存在。它们不关心"我是怎么被启动的"——只关心"我的输入是什么、我的输出给谁"。这是一个单向依赖关系：入口层依赖所有下层，但没有下层反向依赖入口层。

定位清楚后，下一节进入本文核心——启动流程如何实现"按需加载"，以及它如何衔接到完整的会话生命周期。

---

## 三、启动流程：快速路径 + 默认路径

这是本文的第一个核心章节。它回答"敲下 `claude <args>` 之后发生了什么"——从环境准备、快速路径路由，到默认路径的全量加载与初始化。整段流程的设计围绕一个核心思路展开。

### 3.1 核心思路

整个启动流程的设计围绕一个核心思路：**先判断"用户要做什么"，再决定"加载什么模块"。** 而不是反过来——先加载所有模块，再判断用户要做什么。

实现方式是在 `main()` 函数中设置一系列条件分支（快速路径），从上到下依次匹配用户的命令行参数。第一个匹配的分支立即执行并 `return`，只有匹配不到任何快速路径时，才走最重的默认路径——加载完整 CLI。

```
用户输入 claude <args>
    │
    ▼
main() 函数 ──► 依次检查 args，匹配快速路径
    │
    ├── 命中 → 动态 import 少量模块 → 执行业务 → return
    │
    └── 全部未命中 → 默认路径：import('../main.jsx') → 全量 CLI
```

为什么这个设计有效？因为 CLI 工具的绝大多数调用都是**可预测的**：`--version`、`--help`、子命令（`daemon start`、`mcp add`、`job create`）。这些场景的模块需求是确定的，可以在编译期就知道。只有交互式 REPL 和全功能 CLI 才需要"一切就绪"。

### 3.2 关键代码结构

```typescript
// src/entrypoints/cli.tsx:76-360
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Fast-path: --version — 零模块加载
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 16+ 条快速路径依次排列...

  // 默认路径：加载全量 CLI
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  const { main: cliMain } = await import('../main.jsx');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// Line 363: 顶层 await
await main();
```

关键设计细节：
- `--version` 分支在 import startupProfiler **之前**，真正做到零模块加载。它直接使用构建时注入的 `MACRO.VERSION` 常量，不需要任何运行时计算。
- 所有其他快速路径共享 `startupProfiler` 的 import（在 `--version` 分支之后、第一个非 version 分支之前），用于性能采样。
- 默认路径在 import `main.jsx` 之前先调用 `startCapturingEarlyInput()`——在 CLI 加载期间用户可能已经开始打字，这个函数捕获这些早期输入以免丢失。
- `profileCheckpoint` 是启动性能采样的关键工具，在每个关键节点打时间戳，用于分析"从启动到 X 花了多少 ms"。

但这套快速路径能跑起来，依赖 `main()` 执行之前的一组环境准备——下一节先看这些"前置修复"，它们是快速路径能正常工作的前提。

### 3.3 环境准备（main() 运行之前）

在 `main()` 函数执行之前，cli.tsx 文件顶部有 7 段必须先执行的初始化代码。它们不是"可选的配置"——是"如果不执行，整个系统会在特定场景下崩溃"的硬修复：

| 行号 | 代码 | 作用 | 不执行的代价 |
|------|------|------|-------------|
| `cli.tsx:5` | `import '../utils/performanceShim.js'` | 替换 globalThis.performance 为 JS 实现 | JSC C++ Vector 无限增长，长会话 OOM |
| `cli.tsx:11-21` | `if (typeof globalThis.MACRO === 'undefined') ...` | 直接运行 cli.tsx 时注入默认 MACRO 值 | MACRO.VERSION 等常量 undefined |
| `cli.tsx:23-36` | `isEnvTruthy('CLAUDE_CODE_FORCE_INTERACTIVE')` | 强制 stdin/stdout/stderr 的 isTTY=true | Ink 拒绝渲染（"stdin is not a TTY"） |
| `cli.tsx:40` | `process.env.COREPACK_ENABLE_AUTO_PIN = '0'` | 禁用 Corepack 自动 pin yarn | 用户 package.json 被污染 |
| `cli.tsx:44-49` | `if (CLAUDE_CODE_REMOTE === 'true') NODE_OPTIONS += --max-old-space-size=8192` | CCR 容器环境堆大小调整 | 16GB 容器中默认 4GB 触发 OOM |
| `cli.tsx:56-69` | `if (feature('ABLATION_BASELINE') && CLAUDE_CODE_ABLATION_BASELINE) ...` | 实验基线 ablation 开关 | 无（feature gated） |

这些初始化代码是入口层独有的关切——其他模块不感知 Corepack、CCR 容器配置、JSC 引擎的 bug。它们的特点是：
- **没有 fallback**：如果 MACRO 未注入且没有 fallback，版本号就是 undefined，后续所有依赖版本号的逻辑全坏。
- **影响面广但感知不到**：JSC 的 `performance.now()` 内存泄漏不会报错，只会让内存在几小时后 OOM——用户看到的是"用着用着就崩了"。
- **平台特定**：Windows nested bun 场景下的 TTY 问题是 Windows 独有的，macOS/Linux 不受影响。

环境就绪后，进入 `main()` 的快速路径路由——下一节逐条列出所有快速路径。

### 3.4 快速路径详解

以下是 `main()` 中的全部快速路径，按代码中的出现顺序排列：

| 行号 | 快速路径 | 触发条件 | 加载模块数 | 是否需要配置 |
|------|---------|---------|-----------|-------------|
| `cli.tsx:80` | `--version` / `-v` / `-V` | args 长度=1 且匹配版本标志 | 0 | 否 |
| `cli.tsx:93` | `--dump-system-prompt` | feature flag `DUMP_SYSTEM_PROMPT` + 参数匹配 | 4 | 是 |
| `cli.tsx:106` | `--claude-in-chrome-mcp` | 参数匹配 | 2 | 否 |
| `cli.tsx:111` | `--chrome-native-host` | 参数匹配 | 2 | 否 |
| `cli.tsx:116` | `--computer-use-mcp` | feature flag `CHICAGO_MCP` + 参数匹配 | 2 | 否 |
| `cli.tsx:124` | `--acp` | feature flag `ACP` + 参数匹配 | 2 | 否 |
| `cli.tsx:131` | `weixin` | args[0] 是 "weixin" | 8 | 是 |
| `cli.tsx:164` | `--daemon-worker=<kind>` | args 匹配 + feature flag `DAEMON` | 1 | 否 |
| `cli.tsx:182` | `remote-control` / `rc` / `remote` / `sync` / `bridge` | feature flag `BRIDGE_MODE` + args 匹配 | 8 | 是 |
| `cli.tsx:231` | `daemon` | feature flag `DAEMON` 或 `BG_SESSIONS` + args[0] | 5 | 是 |
| `cli.tsx:249` | `autonomy` | args[0] 是 "autonomy" | 2 | 否 |
| `cli.tsx:266` | `--bg` / `--background` | feature flag `BG_SESSIONS` + args 包含 | 4 | 是 |
| `cli.tsx:278` | `ps` / `logs` / `attach` / `kill`（废弃） | feature flag `BG_SESSIONS` + args 匹配 | 5 | 是 |
| `cli.tsx:297` | `job <subcommand>` | feature flag `TEMPLATES` + args[0] | 2 | 否 |
| `cli.tsx:308` | `new` / `list` / `reply`（废弃） | feature flag `TEMPLATES` | 2 | 否 |
| `cli.tsx:318` | `--tmux` + `--worktree` | 组合标志 | 4 | 是 |
| `cli.tsx:352` | 默认路径 | 无快速路径匹配 | ~600 chunk | 是 |

**快速路径的代价：代码重复**

每条快速路径是自包含的——它不能依赖"默认路径已经初始化好的状态"（因为默认路径的 import 根本没执行）。这导致一些重复：

- 多条路径各自调用 `enableConfigs()`——因为配置系统需要显式初始化才能读取 `settings.json`。
- 多条路径各自导入 `startupProfiler` 并调用 `profileCheckpoint`——因为性能采样是每条路径独立需要的。
- 错误处理在各路径中独立实现——bridge 路径有 `BRIDGE_LOGIN_ERROR` 专属处理，而默认路径走通用 stderr 输出。

这种重复是有意为之的——它换来了启动速度。每条路径只为自己的场景付费，不为其他场景买单。

**快速路径的另一个设计约束：feature flag 必须在条件位置**

快速路径不仅依赖运行时参数判断，还依赖编译期 feature flag。如果 `DAEMON` 在构建时未启用，`--daemon-worker` 快速路径的整段代码（包括其中的 `await import(...)` 动态加载）会被 Bun 的 AST 分析器从产物中物理删除——不是被跳过，是字节码中不存在。

这要求 `feature()` 调用只能出现在 `if` 条件位置的最左边（Bun 编译器限制），不能赋值给变量、不能放在箭头函数体内、不能作为 `&&` 链的非首位元素。

快速路径覆盖了所有非交互场景。当它们都不匹配时，进入默认路径——下一节展开全量加载的完整链路。

### 3.5 默认路径：完整 CLI 加载

当所有快速路径都不匹配时，进入默认路径。这时的完整流程是：

```
main() 默认路径 (cli.tsx:352-359)
  │
  ├─► startCapturingEarlyInput()
  │     在 main.tsx 加载前开始捕获 stdin
  │     如果用户在加载期间输入了字符，不会丢失
  │
  ├─► import('../main.jsx') → cliMain()
  │     │
  │     ├─► init() (src/entrypoints/init.ts)
  │     │     ├─ initializeTelemetryAfterTrust() — 遥测启动
  │     │     ├─ enableConfigs() — 配置系统初始化
  │     │     ├─ loadPolicyLimits() — 加载托管策略
  │     │     ├─ loadRemoteManagedSettings() — 远程管理配置
  │     │     └─ initializeGrowthBook() — 特性开关平台
  │     │
  │     ├─► Commander.js 解析 subcommand
  │     │     mcp / server / ssh / open / auth / plugin / agents / ...
  │     │
  │     └─► 主 .action() handler
  │           ├─ checkHasTrustDialogAccepted() — 首次使用信任对话框
  │           ├─ 权限模式初始化 (default/acceptEdits/bypassPermissions/plan)
  │           ├─ MCP 连接建立 (useManageMCPConnections)
  │           │
  │           ├─► launchRepl() — REPL 模式（默认）
  │           │     渲染 Ink UI，等待用户输入
  │           │
  │           └─► headless query — 管道模式（-p）
  │                 processUserInput → query() → 输出 JSON → 退出
```

**init() 的设计考量**

`init()` 不是简单的"按顺序执行一组函数"。它需要处理几个微妙的问题：

1. **遥测必须在信任对话框之后启动**。如果用户在信任对话框中拒绝了遥测，就不应该发送任何遥测数据。所以 `initializeTelemetryAfterTrust()` 的名称暗示了这个时序约束。

2. **配置必须在一切之前加载**。`enableConfigs()` 读取 `settings.json`、`settings.local.json`、托管策略文件。后续所有模块（权限系统、MCP 管理、Hook 注册）都依赖配置值。如果配置加载失败，启动会阻塞——配置是硬依赖，没有合理的降级方案。

3. **GrowthBook 初始化需要认证上下文**。GrowthBook 是特性开关平台，用于远程控制功能的启用/禁用。它需要用户的认证信息来获取个性化的开关值。所以它必须在认证可用之后初始化，但又必须在"需要判断开关值"的逻辑之前完成。

默认路径走完后，主进程就进入了运行态。但启动只是生命周期的开端——下一节用一张初始化清单把所有零散步骤归拢，作为后续进程模型与状态机的衔接。

### 3.6 初始化步骤清单

下表把环境准备、快速路径、默认路径中的所有初始化动作归拢到一张表，方便对照"执行了什么 / 失败时怎么办"：

| 步骤 | 执行的操作 | 关键函数 | 失败时的行为 | 代码位置 |
|------|-----------|---------|-------------|---------|
| 1. 性能 Shim | 替换 globalThis.performance | `performanceShim.ts` | 静默失败（JSC 内存泄漏风险） | `cli.tsx:5` |
| 2. MACRO fallback | 未注入时设置默认值 | `globalThis.MACRO = {...}` | 无 | `cli.tsx:11-21` |
| 3. TTY 修复 | 强制 isTTY=true（Windows nested bun） | `Object.defineProperty` | 静默失败 | `cli.tsx:23-35` |
| 4. Corepack 禁用 | `COREPACK_ENABLE_AUTO_PIN=0` | process.env 赋值 | 无 | `cli.tsx:40` |
| 5. CCR 堆调整 | `NODE_OPTIONS += --max-old-space-size=8192` | process.env 赋值 | 无 | `cli.tsx:44-49` |
| 6. 快速路径路由 | 16+ 条件分支 | `main()` | 对应路径的 error 处理 | `cli.tsx:76-340` |
| 7. 早期输入捕获 | `startCapturingEarlyInput()` | `earlyInput.ts` | 静默失败（用户输入丢失） | `cli.tsx:353` |
| 8. CLI 加载 | `import('../main.jsx')` | 动态 import | 阻塞启动 | `cli.tsx:356` |
| 9. 遥测 | `initializeAnalyticsSink()` | `sink.ts` | 静默失败 | `init.ts` |
| 10. 策略 | `loadPolicyLimits()` | `policyLimits/` | 降级为空策略 | `main.tsx` |
| 11. MCP | `useManageMCPConnections()` | `useManageMCPConnections.ts` | 服务器标记为 Failed | `main.tsx` |
| 12. Trust dialog | `checkHasTrustDialogAccepted()` | trust 对话框 | 首次启动显示 | `main.tsx` |
| 13. REPL 启动 | `launchRepl()` | `replLauncher.js` | 进程退出 | `main.tsx:3710/3764` |

至此，单进程内的启动链路完整了。但 Claude Code 并不只是一个进程——daemon、bridge、MCP server 都以独立子进程存在。下一节解释为什么用子进程而非线程，以及各进程的角色分工。

---

## 四、进程模型

启动流程讲的是"一个进程怎么跑起来"。但完整理解生命周期，还要看"为什么会有多个进程"。这一节从机制到原因，再到各角色详解。

### 4.1 实际机制：`child_process.spawn()`，不是线程

先澄清一个容易混淆的点：这里说的"多进程"不是指 Node.js 的 `worker_threads`（共享内存的线程），也不是 `cluster` 模块（多进程 HTTP 服务）。它用的是操作系统级别的子进程——通过 Node.js 的 `child_process.spawn()` 创建，每个子进程有独立的内存空间、独立的 V8/JSC 堆、独立的 event loop。

核心代码在 `src/utils/cliLaunch.ts`：

```typescript
// src/utils/cliLaunch.ts:148-156
export function spawnCli(spec: CliLaunchSpec, spawnOpts: SpawnOptions): ChildProcess {
  return spawn(spec.execPath, spec.args, {
    ...spawnOpts,
    env: { ...spec.env, ...(spawnOpts.env) },
    windowsHide: spec.windowsHide,
  })
}
```

`buildCliLaunch()` 负责构建启动参数（运行时路径、bootstrap args、环境变量），`spawnCli()` 负责执行 `child_process.spawn()`。所有需要创建子 CLI 进程的地方——daemon supervisor 创建 worker、bg sessions、bridge sessions——都通过这个统一的入口，避免各调用方手动拼 `process.execArgv` 和 `process.argv[1]`。

机制清楚了，但"为什么不用线程"才是这个设计的关键——下一节给出四个理由。

### 4.2 为什么是进程而不是线程

四个原因，按重要性排列：

**1. 生命周期独立。** Daemon supervisor 是长驻进程，worker 是短命进程（执行完一个任务就退出）。如果用线程，worker 和 supervisor 共享进程——supervisor 退出时所有 worker 线程被强制终止，不管是否在执行任务。独立进程意味着 supervisor 可以优雅关闭：通知 worker 完成任务、等 worker 自然退出、再自己退出。

**2. 内存彻底回收。** Worker 执行后台 Agent 任务时需要加载完整的工具注册表、MCP 连接、上下文——内存占用可达 300MB。如果是线程，这些内存在任务完成后释放回堆，但 V8/JSC 不一定会把释放的内存归还给操作系统（内存碎片、allocator 缓存）。独立进程退出后，操作系统回收全部物理内存——这是唯一保证内存归还的方式。

**3. 崩溃不波及其他。** Agent 执行工具时可能触发任何代码路径——原生 NAPI 模块的 segfault、第三方 MCP server 的未捕获异常、`process.exit()` 调用。线程无法防御这些——一个 `SIGSEGV` 会带走整个进程（所有线程）。独立进程中，worker 崩溃后 supervisor 检测到 `exit` 事件、清理 `WorkerState`、可以选择重启——用户的 REPL 会话完全不受影响。

**4. 权限隔离。** Bridge 进程需要监听网络端口，主 REPL 进程不需要。独立进程可以用操作系统级别的权限控制（seccomp、AppArmor、Windows 防火墙规则）限制每个进程的能力范围。

在继续之前，先定义两个贯穿后续内容的概念：

- **Daemon supervisor（后台管家进程）**：一个长驻的后台进程，自己不执行任何 Agent 任务，只负责接收任务请求、创建 worker、监控 worker 状态、清理僵尸进程。类比操作系统的 init 进程或 Docker 的 dockerd。
- **Daemon worker（后台任务执行进程）**：由 supervisor 通过 `spawnCli()` 创建的子进程，执行单个后台任务（如定时检查 CI 状态），完成后立即退出。每个 worker 是独立的操作系统进程，有自己的内存空间。

两者的关系：supervisor 是"经理"，worker 是"临时工"。经理长驻，临时工干完活就走。

带着这两个概念，下一节看完整的进程架构图。

### 4.3 进程架构总览

```
┌────────────────────────────────────────────────────────────────┐
│  主进程 (CLI 入口 + REPL)                                        │
│  src/entrypoints/cli.tsx → src/main.tsx → launchRepl()         │
│  生命周期：用户启动到退出                                          │
│  资源占用：~500MB（含 Ink UI + 工具注册表 + MCP 连接）              │
└────────────────────────────────────────────────────────────────┘
        │
        │ child_process.spawn() 创建子进程
        │
        ├──► Daemon supervisor (src/daemon/main.js)
        │     长驻进程，管理所有后台会话
        │     通信：文件系统 + 进程信号 (SIGTERM/SIGINT)
        │     资源占用：~50MB（极轻量，不加载 UI 或工具）
        │
        ├──► Daemon worker (src/daemon/workerRegistry.js)
        │     执行单个后台任务，完成后退出
        │     由 supervisor 通过 spawnCli() 创建，单次任务生命周期
        │     资源占用：~300MB（按任务需求加载）
        │
        ├──► MCP server 子进程 (src/services/mcp/client.ts)
        │     外部工具提供者（如 PostgreSQL MCP server）
        │     随主进程启动，随主进程退出
        │     通信：stdio / SSE / WebSocket
        │
        ├──► Bridge 进程 (src/bridge/bridgeMain.ts)
        │     Remote Control 服务（HTTP + WebSocket）
        │     生命周期：用户启动到退出
        │     通信：HTTP REST + WebSocket
        │
        └──► Computer Use 进程 (src/utils/computerUse/mcpServer.js)
              截图 + 键鼠模拟
              独立 MCP server 模式
              通信：stdio
```

### 4.4 各进程详解

**主进程**是用户直接交互的进程。它加载了最重的依赖——Ink 渲染引擎、60+ 工具注册表、权限审批 UI、MCP 连接管理。资源占用约 500MB，其中大部分是 JSC 引擎的 bytecode 缓存和 React 组件树。用户退出 REPL 时，主进程负责优雅关闭所有子进程、flush 会话存储、发送最后的遥测数据。

**Daemon supervisor** 是后台任务的"管家"。它本身极轻量（~50MB），不加载 UI、不注册工具、不建立 MCP 连接。它的唯一职责是：接收任务请求（来自主进程或定时触发）、spawn worker 进程执行任务、监控 worker 状态、清理僵尸进程。supervisor 通过文件系统与外部通信——任务定义写在 `.claude/scheduled_tasks/` 目录下，supervisor 定期扫描并调度。

**Daemon worker** 是真正干活的后台进程。每个 worker 只执行一个任务，完成后立即退出。这种"短命"设计有几个好处：(1) 内存泄漏不累积——worker 退出后操作系统回收全部资源；(2) 崩溃影响面小——一个 worker 崩溃不影响其他任务；(3) 权限隔离——不同任务的 worker 可以用不同的环境变量启动。

**MCP server** 是外部工具的宿主。Claude Code 不直接实现数据库查询、API 调用等能力——这些由 MCP server 提供。MCP server 可以以两种方式运行：通过 `child_process.spawn()` 创建子进程（stdio 传输），或者通过 `InProcessTransport` 在主进程中直接调用（避免为轻量 server 额外开进程的开销，如 Chrome MCP server 注释中提到的"避免 spawn ~325MB 子进程"）。主进程中的 `MCPClient` 负责管理 server 的生命周期——启动、心跳检测、重启、关闭。

**Bridge 进程**提供 Remote Control 能力。它启动一个 HTTP 服务器，接收来自远程客户端的请求（如 Web 控制面板、移动端 App），将请求转发给本地 Agent 执行，再返回结果。Bridge 需要独立的网络权限——监听端口、处理 TLS、验证 JWT——这些能力不应暴露给主 REPL 进程。

**Computer Use 进程**提供截图和键鼠模拟能力。它作为独立 MCP server 运行，通过 stdio 接收指令（"截图"、"点击坐标 (100, 200)"、"输入文字"），调用操作系统 API 执行，返回结果。

进程模型回答了"系统由哪些进程组成"。最后一块拼图是"一个会话在主进程内部经历哪些状态"——下一节用状态机收束全文。

---

## 五、会话/请求生命周期

启动流程与进程模型都是"准备阶段"。真正回答"一个会话从开始到结束经历什么"的是这一节——它是本文的第二个核心章节，把前面所有零散的初始化动作编排进一个 10 状态的状态机。

### 5.1 完整状态机

一个 Agent 会话从进程启动到退出，经历 10 个状态：

```
                    ┌──────────────┐
                    │   CREATED    │
                    │  CLI 启动     │
                    └──────┬───────┘
                           │ main() 调用
                           ▼
                    ┌──────────────┐
                    │ INITIALIZING │
                    │  模块加载     │
                    │  配置初始化   │
                    └──────┬───────┘
                           │ 配置完成、MCP 连接就绪
                           ▼
              ┌──────────► ┌──────────────┐ ◄────────┐
              │            │    IDLE      │          │
              │            │  等待用户输入  │          │
              │            └──────┬───────┘          │
              │                   │ 用户输入          │
              │                   ▼                  │
              │            ┌──────────────┐          │
              │            │  PROCESSING  │          │
              │       ┌───►│  INPUT       │          │
              │       │    └──────┬───────┘          │
              │       │           │ UserMessage      │
              │       │           ▼                  │
              │       │    ┌──────────────┐          │
              │       │    │   THINKING   │◄─────────┤
              │       │    │  query() 启动 │          │
              │       │    └──────┬───────┘          │
              │       │           │ 发送请求         │
              │       │           ▼                  │
              │       │    ┌──────────────┐          │
              │       │    │  STREAMING   │          │
              │       │    │  接收响应     │          │
              │       │    └──────┬───────┘          │
              │       │           │ tool_use 块      │
              │       │           ▼                  │
              │       │    ┌──────────────┐          │
              │       │    │  EXECUTING   │          │
              │       │    │  权限→执行   │          │
              │       │    └──────┬───────┘          │
              │       │           │ tool result      │
              │       │           │ 注入上下文       │
              │       │           └──────────────────┘
              │       │
              │       │ stop_reason=end_turn
              │       │ 或 maxTurns 超限
              │       ▼
              │  ┌──────────────┐
              │  │  STOP_HOOKS  │ PostToolUse / Stop hooks
              │  └──────┬───────┘
              │         │
              │         ▼
              │  ┌──────────────┐
              └─►│  PERSISTING  │ JSONL 写入
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │  COMPLETING  │ title/summary 生成
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │  TERMINATED  │ flush + cleanup
                 └──────────────┘
```

状态机给出了骨架。下一节逐个状态展开，说明每个状态做什么、为什么需要它。

### 5.2 状态详解

**CREATED**：进程启动，但 `main()` 还没执行。这个阶段执行环境准备工作——性能 shim、MACRO fallback、TTY 修复、Corepack 禁用、CCR 堆调整。这些操作不依赖任何配置或用户输入，是纯粹的"运行环境修复"。

**INITIALIZING**：进入默认路径，开始加载模块。这个阶段的耗时主要由 `import('../main.jsx')` 决定——Bun 需要解析、编译、缓存约 600 个 chunk 文件。`startCapturingEarlyInput()` 在此阶段启动，确保用户在等待期间输入的内容不丢失。

**IDLE**：初始化完成，等待用户输入。这个状态不是被动的——后台持续运行多个维护任务：
- Hook 监听器：监听 `.claude/settings.json` 变更，实时更新 hook 配置
- MCP 心跳 timer：每 30 秒 ping MCP server，检测连接状态
- 文件监控 watcher：监听 git status 变化
- Scheduled tasks 检查：cron 表达式到期时触发后台任务
- Auto-compact 判断：接近上下文窗口限制时触发自动压缩

这些后台任务是 Agent "常驻"能力的基础——用户不需要手动触发它们。

**PROCESSING_INPUT**：用户输入到达，开始处理。这一步解析 slash command（如 `/help`、`/compact`）、处理 @mentions（如 `@file.ts` 注入文件内容）、生成 UserMessage。如果输入是 slash command，可能在此阶段直接返回结果，不进入 Agent 循环。

**循环体（THINKING → STREAMING → EXECUTING → STOP_HOOKS → PERSISTING）**：这五个状态构成单次 `query()` 调用内部的 Agent 循环——组装上下文、发请求、收流、执行工具、收尾。它们是循环层的核心，已在 [03-agent-loop](cc-03-agent-loop.md) §四/§五 详尽展开（State 对象 9 字段、7 种 continue reason、6 种 terminal reason、单轮 5 阶段），本文不重复。其中两个收尾状态各有专属文档：**STOP_HOOKS** 的 Stop / PreToolUse / PostToolUse 事件机制见 [12-hook-interception](cc-12-hook-interception.md) §3.1；**PERSISTING** 的 JSONL append-only 落盘与恢复见 [17-persistence-and-cache](cc-17-persistence-and-cache.md)。

**COMPLETING**：生成会话标题和摘要。标题用于会话列表展示，摘要是对话内容的简短描述。这些由 LLM 生成（如果功能启用），结果写入 transcript 元数据。

**TERMINATED**：进程即将退出。执行最后的清理工作——flush 所有缓冲的 transcript 数据、关闭 Langfuse trace、断开 MCP 连接、清理临时文件。

状态机里有回路（EXECUTING → THINKING）也有终点（TERMINATED）。回路的退出条件——LLM 自然结束、达到 `maxTurns`、用户中断——以及更细的 6 种 continue reason 与 6 种 terminal reason，详见 [03-agent-loop](cc-03-agent-loop.md) §4.4/4.5。无论哪种退出，最终都会经过 STOP_HOOKS → PERSISTING → IDLE（或 COMPLETING → TERMINATED）流程。

至此，从启动到退出的完整生命周期串通了：外壳状态由本文覆盖，循环内部由 03 覆盖。最后四节是收束：环境变量、设计权衡、边界局限、可复用模式。

---

## 六、环境变量驱动模式

Claude Code 的很多行为切换不是通过命令行参数，而是通过环境变量。这是因为环境变量可以跨进程继承（daemon worker 从 supervisor 继承环境变量）、可以在 `.bashrc`/`.zshrc` 中预设、可以被 CI/CD 系统注入。

| 环境变量 | 作用 | 读取位置 | 影响 |
|----------|------|---------|------|
| `CLAUDE_CODE_VERSION` | 未注入 MACRO 时的版本号 fallback | `cli.tsx:13` | MACRO.VERSION |
| `CLAUDE_CODE_FORCE_INTERACTIVE` | 强制 isTTY=true | `cli.tsx:23` | Windows nested bun |
| `COREPACK_ENABLE_AUTO_PIN` | Corepack 自动 pin | `cli.tsx:40` | 设为 '0' 禁用 |
| `CLAUDE_CODE_REMOTE` | CCR 容器环境标志 | `cli.tsx:44` | NODE_OPTIONS 调整 |
| `CLAUDE_CODE_ABLATION_BASELINE` | 实验基线开关 | `cli.tsx:56` | 批量禁用功能 |
| `FEATURE_<FLAG_NAME>` | feature flag 运行时覆盖 | bun:bundle | 构建时消除可被覆盖 |
| `USER_TYPE` | 用户类型（'ant' / 'external'） | `tools.ts:17` | 工具注册条件 |
| `CLAUDE_CODE_USE_OPENAI` | OpenAI 兼容模式 | `claude.ts` | Provider 路由 |
| `CLAUDE_CODE_USE_GEMINI` | Gemini 兼容模式 | `claude.ts` | Provider 路由 |
| `CLAUDE_CODE_USE_GROK` | Grok 兼容模式 | `claude.ts` | Provider 路由 |

---

## 七、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 进程模型 | `child_process.spawn()` 创建子进程 | 单进程或 worker_threads | 子进程有独立内存空间和 event loop，崩溃不波及其他进程；线程共享堆，一个 SIGSEGV 全挂 |
| 启动策略 | 快速路径优先 + 默认路径懒加载 | 统一入口 | 16+ 快速路径覆盖了大部分非交互场景（--version、daemon、mcp server 等），只有交互式 REPL 才需要全量加载 |
| 会话恢复 | 从 JSONL transcript 重建 | 内存快照 | transcript 格式天然支持审计和跨进程恢复 |
| Daemon 模式 | 独立 supervisor 进程管理 workers | 单进程内线程 | Daemon 需要跨 REPL 会话存活，必须独立进程 |
| 早期输入捕获 | `startCapturingEarlyInput()` | 等 main.tsx 加载完再读 stdin | 用户在 CLI 启动期间输入的命令不会丢失 |
| 性能采样 | 入口层 profileCheckpoint | 单独 APM 工具 | 启动延迟是核心 KPI，需要内建采样 |
| 顶层 await | `await main()` (cli.tsx:363) | IIFE 包裹 | ESM 模块顶层 await，避免多余的包装函数 |

---

## 八、可复用的模式

### 模式一：快速路径优先模式

**问题**：CLI 工具需要支持多种使用场景，但不同场景的模块需求差异巨大。`--version` 只需要输出版本号，REPL 需要完整的 UI 和工具系统。如果统一加载，轻量操作被重量依赖拖慢。

**解法**：在入口函数中按"从轻到重"的顺序排列条件分支。最轻的路径（`--version`）排在最前面，零模块加载即返回。较重的路径排在后面，按需动态 import。最后的默认路径加载全部模块。

**实现要点**：
- `await import(...)` 在快速路径内部，不在文件顶部统一 import。
- 每个快速路径必须自包含错误处理（不能依赖共享状态）。
- 用 `profileCheckpoint()` 标记关键时间点，便于性能分析。

**适用条件**：子命令众多（5+ 独立子系统）、部分子命令是高频查询、启动延迟对 UX 关键。

**不适用**：子命令之间共享大量状态（懒加载反而引入复杂度）、只有 1-2 个子命令（代码冗余不划算）。

### 模式二：早期输入捕获模式

**问题**：CLI 启动需要时间（加载模块、初始化配置），用户在启动期间可能已经开始输入。如果不捕获这些早期输入，用户按下回车后发现"刚才输入的字符没进去"，体验很差。

**解法**：在启动完整 CLI 之前，先启动一个轻量级的 stdin 监听器。它将所有输入缓冲起来，等 CLI 就绪后回放给 PromptInput 组件。

**实现**（参考 `src/utils/earlyInput.ts`）：
```typescript
function startCapturingEarlyInput() {
  // 1. 立即监听 stdin data 事件
  process.stdin.on('data', chunk => buffer.push(chunk));
  // 2. 主进程加载完成后，回放 buffer 中的输入
}
```

**适用条件**：CLI 启动延迟 > 100ms（用户可能在等待时输入）、输入缓冲可以延迟处理。

**不适用**：子命令不需要用户输入（如 batch 命令）、实时响应是关键（如交互式 prompt）。

### 模式三：生命周期钩子模式

**问题**：不同模块需要在 Agent 生命周期的不同节点执行逻辑（会话开始时加载配置、工具执行前后做审计、会话结束时清理资源），但这些模块不应相互耦合。

**解法**：在生命周期的关键节点（SessionStart、Stop、SessionEnd、PreToolUse、PostToolUse）设置 Hook 扩展点。Hook 接收标准化参数，可以修改、拒绝或记录，但不影响主流程。

**实现**（参考 `src/utils/hooks.ts`）：
- 定义 hook 时机（PreToolUse、PostToolUse、Stop、SessionStart、SessionEnd）。
- 每个 hook 接收标准化参数（tool name、input、result 等）。
- Hook 可以修改/拒绝/记录，不影响主流程。

**适用条件**：需要可观测性（埋点、日志）、需要审计（每次会话开始/结束执行特定操作）、需要工作流自动化（Stop 时触发 CI/CD）。

**不适用**：Hook 会显著增加延迟（每个工具调用 +10ms）、Hook 逻辑过于复杂（应直接在 Agent 循环中实现）。

### 模式四：懒加载 + memoize 模式

**问题**：重型计算（如 `getSystemContext`、`getGitStatus`）在每轮 Agent 循环中都被调用，但结果在会话期间通常不变。每次都重新计算浪费 I/O 和 CPU。

**解法**：用 `lodash.memoize` 包装这些函数。首次调用时执行计算并缓存结果，后续调用直接返回缓存。当底层数据变化时（如文件修改导致 git status 变化），手动调用 `cache.clear()` 使缓存失效。

**证据**：
- `src/context.ts:116` — `getSystemContext = memoize(...)`
- `src/context.ts:155` — `getUserContext = memoize(...)`
- `src/context.ts:32-33` — cache.clear() 在特定事件触发

**适用条件**：计算昂贵（文件系统 I/O、网络请求）、结果在会话期间不变或变化不频繁、多次调用。

**不适用**：结果需要实时性（每次调用都可能不同）、内存受限（memoize 缓存占用内存）、参数空间极大（缓存命中率低）。

### 模式五：进程角色分离模式

**问题**：不同职责的组件有不同的生命周期、崩溃影响面、资源需求和权限要求。把它们放在同一个进程内会相互干扰。

**解法**：将不同职责分配到不同进程（supervisor、worker、MCP server、bridge），通过 IPC 协调。每个进程只加载自己需要的模块，崩溃时不波及其他进程。

**适用条件**：职责生命周期差异大（supervisor 长驻 vs worker 短命）、崩溃隔离需求（MCP server 崩溃不能影响主进程）、资源控制（worker 完成单次任务后释放内存）。

**不适用**：进程间通信频繁（IPC 延迟成为瓶颈）、共享内存需求大（跨进程状态同步复杂）。

