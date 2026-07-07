---
description: Claude Code 不是铁板一块，而是 UI、入口、上下文、循环、工具、API、基础设施七层切分，循环层是唯一中枢。本篇给全景图与层间通信模式，建立后续所有章节的坐标系。
---

# 分层架构总览

> **配套阅读**：本文是整个系列的"地图"，建立全局坐标后便于深入各层。[02-entry-and-lifecycle](cc-02-entry-and-lifecycle.md) 详述入口层的快速路径与会话生命周期；[03-agent-loop](cc-03-agent-loop.md) 展开循环层的状态机与 ReAct 闭环；[05-tool-execution-pipeline](cc-05-tool-execution-pipeline.md) 深入工具层的执行链；[06-permission-security](cc-06-permission-security.md) 解析跨层的 5 层权限防御；[07-context-assembly](cc-07-context-assembly.md) 讲解上下文层的 prompt 组装。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 分层要解决的工程问题 | 必读，建立问题意识 |
| 二 | 分层全景图 | 必读，建立全局坐标 |
| 三 | 各层职责与边界 | 必读，理解每层做什么、不做什么 |
| 四 | 层间数据流：一次完整的消息处理 | **核心章节**，看数据如何穿越七层 |
| 五 | 模块地图：每层有哪些文件 | 参考，定位代码时查阅 |
| 六 | 层间通信的四种模式 | 必读，理解层与层怎么对话 |
| 七 | 跨层依赖约束 | 必读，理解哪些依赖是合法的 |
| 八 | 关键数据流追溯 | 参考，三条典型路径的端到端追踪 |
| 九 | 设计决策与权衡 | 理解为什么这样切分 |
| 十 | 可复用的模式 | 提炼可迁移的分层原则 |

---

## 一、它在解决什么问题

Agent 系统的复杂度来自多个维度的交织：上下文管理、推理循环、工具执行、权限控制、持久化、可观测性。如果不分层，每个模块都直接依赖其他模块，修改一个工具的实现可能破坏整个推理循环。分层架构把"怎么想"（循环层）、"看到什么"（上下文层）、"能做什么"（工具层）、"怎么记"（基础设施层）解耦，每层只通过明确接口通信。

分层不是为分层而分层——它解决三个具体的工程问题：

1. **认知负荷**：单个开发者一次只能理解 ~7 层栈。清晰的层级让新人能定位"修改 X 影响哪些层"，而不必把整个仓库装进脑子。
2. **变更隔离**：替换 LLM provider（API 层变更）不应影响工具实现（工具层）。如果没有分层，OpenAI → Anthropic 切换会污染 50+ 文件——每个调用点都要改。
3. **测试边界**：每层可以独立 mock。测试循环层时 mock API 层（返回预设 stream events），不需要真实调用 LLM；测试工具层时 mock 权限层（直接放行），不触发 HITL 弹窗。

理解了"为什么分层"，下一步看"分成哪几层"——一张全景图先建立心智模型，再逐层展开。

---

## 二、分层全景图

整个系统从上到下切成七层。上面的层"更接近用户与变化"，下面的层"更接近机器与稳定"。数据从用户输入进入 UI 层，沿入口层路由后注入循环层，循环层在每轮中向上下文层要输入、向 API 层要推理、向工具层要执行，最后由基础设施层持久化与观测。

```
┌─────────────────────────────────────────────────────────┐
│ UI 层：Ink 终端渲染                                      │ ← 用户看到什么
│ React/Ink components, PromptInput, Messages, Permissions │
├─────────────────────────────────────────────────────────┤
│ 入口层：CLI 路由与生命周期                                │ ← 怎么启动
│ cli.tsx fast paths → main.tsx Commander → REPL/Headless │
├─────────────────────────────────────────────────────────┤
│ 上下文层：Agent 看到什么                                  │ ← 输入
│ context.ts → CLAUDE.md/Memory/Rules/Skill/MCP Schema     │
├─────────────────────────────────────────────────────────┤
│ 循环层：Agent 怎么想、怎么做                              │ ← 中枢
│ query.ts + QueryEngine.ts → Reason → Act → Observe       │
│ ├─ Plan Mode（跨层约束组合）                              │
│ ├─ Subagent（上下文隔离）                                 │
│ ├─ Hook（循环拦截）                                       │
│ ├─ Human-in-the-Loop（审批关卡）                          │
│ └─ Scheduled Tasks（定时触发）                            │
├─────────────────────────────────────────────────────────┤
│ 工具层：Agent 能做什么                                    │ ← 执行
│ Tool.ts + tools.ts → 注册 → 校验 → 权限 → 执行 → 格式化   │
│ ├─ Permission（安全边界）                                 │
│ ├─ MCP（外部工具协议）                                    │
│ └─ Worktree（文件隔离）                                   │
├─────────────────────────────────────────────────────────┤
│ API 层：与 LLM 的通信                                    │ ← 网络
│ claude.ts + openai/gemini/grok → stream events → parser  │
├─────────────────────────────────────────────────────────┤
│ 基础设施层：持久化与可观测性                               │ ← 底座
│ sessionStorage + compact + analytics + langfuse          │
└─────────────────────────────────────────────────────────┘
```

一个关键观察：**循环层是唯一的中枢**。它向上消费 UI 层的用户输入、向下协调上下文/API/工具三个执行支点，基础设施层则像"底座"被动承接所有层的持久化与埋点需求。这种"中间厚、两头薄"的形状决定了后续所有数据流都以循环层为枢纽。

全景图只给了静态形状。下面三节（职责、数据流、模块地图）从三个侧面把这张图填实：先看每层的"职责契约"，再看数据如何穿越七层，最后看每层由哪些具体文件构成。

---

## 三、各层职责与边界

每层的"职责"和"不负责"同等重要——后者是层隔离的硬边界。下表用"不负责"列显式标出每个层不应触碰的关切，违反即层违例（详见第七节）。

| 层 | 目录 | 职责 | 不负责 | 对上层接口 | 对下层依赖 |
|----|------|------|--------|-----------|-----------|
| UI 层 | `packages/@ant/ink/`, `src/components/` | 终端渲染、用户输入、权限提示 UI | 不决定渲染什么内容 | Ink render tree | AppState context |
| 入口层 | `src/entrypoints/`, `src/main.tsx` | CLI 参数解析、快速路径路由、生命周期管理 | 不执行 Agent 逻辑 | Commander commands | 所有下层模块（懒加载） |
| 上下文层 | `src/context.ts`, `src/utils/claudemd.ts` | System Prompt 组装、CLAUDE.md 加载、Git 状态注入 | 不管理对话历史 | `getSystemContext()` / `getUserContext()` | 文件系统 |
| 循环层 | `src/query.ts`, `src/QueryEngine.ts` | Agent 主循环、流式处理、工具调度、退出判断 | 不直接操作文件 | `query()` AsyncGenerator | API 层 + 工具层 + 上下文层 |
| 工具层 | `src/Tool.ts`, `src/tools.ts`, `packages/builtin-tools/` | 工具注册、参数校验、权限检查、执行、结果格式化 | 不决定何时调用哪个工具 | `Tool.execute()` | API 层（tool schema） |
| API 层 | `src/services/api/` | LLM 请求构建、流式解析、错误处理、多 Provider 适配 | 不管理对话上下文 | `queryModel()` AsyncGenerator | Anthropic SDK / HTTP |
| 基础设施层 | `src/utils/sessionStorage.ts`, `src/services/analytics/`, `src/services/langfuse/` | 会话持久化、分析埋点、追踪 | 不参与 Agent 决策 | `recordTranscript()` 等 | 文件系统 / 网络 |

读这张表的方法：横向看一层知道它的"合同"（接口与依赖），纵向对比"不负责"列能发现天然的安全边界——例如基础设施层"不参与 Agent 决策"，意味着 transcript 写入失败不应阻断循环；工具层"不决定何时调用哪个工具"，意味着工具注册表对调度策略无知。

静态的职责表回答了"每层管什么"。但系统是活的——下一节追踪一条消息从用户按键到屏幕首字的完整穿越路径，看这七层如何在运行时协作。

---

## 四、层间数据流：一次完整的消息处理

这是本文的核心章节。先给一张端到端调用图建立心智模型，再用状态机视角补充会话生命周期，最后拆解循环层的退出判断。整段数据流的枢纽是循环层的 `query()`——它既是上游（上下文/API）的消费者，也是下游（工具/基础设施）的驱动者。

### 4.1 完整消息处理流程

```
用户输入 (PromptInput)
  │  stdin / TTY 键盘事件
  ▼
入口层: processUserInput() (src/utils/processUserInput/)
  │  解析 slash command、处理 @mentions、生成 UserMessage
  │  例如: "/help" → 调用 help 命令；"@file.ts" → 注入文件内容
  │
  ▼
循环层: query() (src/query.ts:276)
  │  ──── 每一轮 Agent Loop 开始 ────
  │
  ├─► 上下文层: getSystemContext() + getUserContext() (src/context.ts:116,155)
  │     │  memoize 缓存避免重复计算
  │     │
  │     ├─► CLAUDE.md 加载 (src/utils/claudemd.ts:789)
  │     │     遍历 CWD → 根目录，按优先级合并
  │     │
  │     ├─► Git status (src/context.ts:36)
  │     │     git status --porcelain，注入分支 + 未提交文件
  │     │
  │     └─► Skill discovery (src/services/skillSearch/)
  │           TF-IDF 索引从 .claude/skills/*/SKILL.md 构建
  │
  ├─► API 层: queryModelWithoutStreaming() (src/services/api/claude.ts:732)
  │     │  构建 system prompt blocks + messages + tools schema
  │     │
  │     ├─► filter tools: isDeferredTool() (src/utils/searchExtraTools.ts:24)
  │     │     过滤非 CORE_TOOLS，减少 schema token
  │     │
  │     └─► anthropic.beta.messages.create({stream: true})
  │           │
  │           ▼ Stream events (BetaRawMessageStreamEvent)
  │           │
  │           ├─► content_block_start  → 初始化 text/tool_use 块
  │           ├─► content_block_delta  → 累积文本/JSON 片段
  │           ├─► content_block_stop   → 触发下游处理
  │           └─► message_delta        → stop_reason + usage
  │                 │
  │                 ├─► 文本 → yield StreamEvent → UI 层逐字渲染
  │                 └► tool_use → 累积 JSON → 完整后触发工具执行
  │
  ├─► 工具层: runTools() (src/services/tools/toolOrchestration.js, 由 query.ts:1671 调用)
  │     │  ──── 每个 tool_use 块依次处理 ────
  │     │
  │     ├─► findToolByName() (src/Tool.ts)
  │     │     在工具注册表中查找实现
  │     │
  │     ├─► PreToolUse hooks (src/utils/hooks.ts:3538)
  │     │     用户自定义拦截逻辑，可拒绝/修改 input
  │     │
  │     ├─► hasPermissionsToUseTool() (src/utils/permissions/permissions.ts:473)
  │     │     5 层权限检查：deny > ask > allow > classifier > HITL
  │     │
  │     ├─► tool.call() (各工具实现 in packages/builtin-tools/)
  │     │     如 BashTool.execute() → child_process.spawn
  │     │
  │     ├─► PostToolUse hooks (src/utils/hooks.ts:3594)
  │     │     执行后审计/修改 result
  │     │
  │     └─► mapToolResultToToolResultBlockParam()
  │           转换为 LLM 可消费的格式
  │
  ├─► 基础设施层: recordTranscript() (src/utils/sessionStorage.ts:1445)
  │     │  JSONL 追加写入 ~/.claude/sessions/<uuid>.jsonl
  │     │
  │     └─► 异步 flush（不阻塞主循环）
  │
  └─► 循环判断: while(true) — 继续或退出 (src/query.ts:460)
        │  退出条件：
        ├─ 有 tool_use → 继续（结果注入上下文，下一轮）
        ├─ stop_reason=end_turn → 检查 Stop hooks → 退出
        └─ 超过 maxTurns → 强制退出
```

这张图揭示了三个运行时特征：第一，**循环层是唯一的主动方**——上下文层、API 层、工具层都是被它调用的"服务"；第二，**流式贯穿 UI 与 API 两端**，`AsyncGenerator<StreamEvent>` 把网络层的 SSE 事件直接映射成屏幕上的逐字渲染，中间无缓冲；第三，**权限与 Hook 是"横切关注点"**，它们夹在工具调用的前后（PreToolUse → 权限 → 执行 → PostToolUse），名义上属于工具层，实则跨多层（详见第六、七节）。

### 4.2 状态机视角的会话生命周期

上面的调用图是"单轮"的视角。把镜头拉远到整个会话，能看到一个更紧凑的状态机——它跨越循环层与基础设施层，描述一条消息从到达到完成的状态流转：

```
                    ┌──────────────┐
        用户输入 ──►│  INITIALIZED │
                    └──────┬───────┘
                           │ query() 调用
                           ▼
                    ┌──────────────┐
         ┌─────────►│   THINKING   │◄────────┐
         │          └──────┬───────┘         │
         │                 │ stream 到达      │
         │                 ▼                  │
         │          ┌──────────────┐          │
         │     ┌───►│  STREAMING   │          │
         │     │    └──────┬───────┘          │
         │     │           │ tool_use 块     │
         │     │           ▼                  │
         │     │    ┌──────────────┐          │
         │     │    │ AWAITING_    │          │
         │     │    │ PERMISSION   │          │
         │     │    └──────┬───────┘          │
         │     │           │ user/auto decide │
         │     │           ▼                  │
         │     │    ┌──────────────┐          │
         │     └───│  EXECUTING   │──────────┘
         │          └──────┬───────┘  tool result
         │                 │ 注入上下文
         │                 ▼
         │          ┌──────────────┐
         │          │   THINKING   │ (下一轮)
         │          └──────────────┘
         │
         │ stop_reason=end_turn
         ▼
    ┌──────────────┐
    │  STOP_HOOKS  │ (PostToolUse / Stop hooks 评估)
    └──────┬───────┘
           │ persist transcript
           ▼
    ┌──────────────┐
    │  COMPLETED   │ → 进程退出 / 返回 REPL
    └──────────────┘
```

注意 `AWAITING_PERMISSION` 是唯一会"暂停"循环的状态——它是循环层与 UI 层的握手点：循环层挂起等待，UI 层渲染审批弹窗，用户决定后循环层恢复。这个状态的存在解释了为什么权限模块必须跨层（第七节会展开）。

数据流讲了运行时协作。但要在真实代码中定位某层，还需要一份"模块地图"——下一节把每层落实到具体文件。

---

## 五、模块地图：每层有哪些文件

这一节是查阅用的索引。当你在代码中看到某个文件，可以反向定位它属于哪层、影响范围多大。

### 入口层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `cli.tsx` | CLI 入口，快速路径路由，动态导入 | `src/entrypoints/cli.tsx` |
| `main.tsx` | Commander.js 全量 CLI 定义（~5640 行） | `src/main.tsx` |
| `init.ts` | 一次性初始化：遥测、配置、信任对话框 | `src/entrypoints/init.ts` |
| `earlyInput.ts` | 在 CLI 完全加载前捕获 stdin，避免早期输入丢失 | `src/utils/earlyInput.ts` |
| `startupProfiler.ts` | 启动性能采样，输出 checkpoint 时间戳 | `src/utils/startupProfiler.ts` |
| `performanceShim.ts` | 替换 globalThis.performance，修复 JSC 内存泄漏 | `src/utils/performanceShim.ts` |

### 上下文层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `context.ts` | System/User context 组装，memoize 缓存 | `src/context.ts` |
| `claudemd.ts` | CLAUDE.md/Memory/Rules 分层发现与加载 | `src/utils/claudemd.ts` |
| `attachments.ts` | @file 引用解析，文件内容注入 | `src/utils/attachments.ts` |
| `prompts.ts` | System prompt 字符串模板与组装 | `src/constants/prompts.ts` |
| `skillSearch/` | Skill TF-IDF 索引构建与查询 | `src/services/skillSearch/` |

### 循环层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `query.ts` | Agent 主循环（Reason→Act→Observe） | `src/query.ts` |
| `QueryEngine.ts` | 会话级查询编排器（压缩、归因、SDK 兼容） | `src/QueryEngine.ts` |
| `hooks.ts` | Hook 匹配、执行、决策合并 | `src/utils/hooks.ts` |
| `hooksConfigSnapshot.ts` | Hook 配置快照（签名校验后的只读视图） | `src/utils/hooks/hooksConfigSnapshot.ts` |
| `processUserInput/` | 用户输入处理（slash command、@mentions） | `src/utils/processUserInput/` |

### API 层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `claude.ts` | Anthropic API 流式调用 + Provider 路由 | `src/services/api/claude.ts` |
| `providers.ts` | Provider 选择逻辑（modelType > env > default） | `src/utils/model/providers.ts` |
| `openai/` | OpenAI 兼容适配（Ollama/DeepSeek/vLLM） | `src/services/api/openai/` |
| `gemini/` | Gemini API 适配 | `src/services/api/gemini/` |
| `grok/` | Grok API 适配 | `src/services/api/grok/` |

### 工具层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `Tool.ts` | Tool 类型定义、查找工具 | `src/Tool.ts` |
| `tools.ts` | 工具注册表（60+ 工具目录） | `src/tools.ts` |
| `permissions.ts` | 权限规则引擎（deny > ask > allow） | `src/utils/permissions/permissions.ts` |
| `builtin-tools/` | 60 个工具实现，通过 workspace 包导出 | `packages/builtin-tools/src/tools/` |
| `MCP` 连接管理 | MCP server 连接、tools/list、心跳 | `src/services/mcp/` |
| `searchExtraTools/` | TF-IDF 延迟工具发现索引 | `src/services/searchExtraTools/` |

### 基础设施层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `sessionStorage.ts` | 会话 JSONL 持久化（~5248 行） | `src/utils/sessionStorage.ts` |
| `compact/` | 上下文压缩（自动/手动/微压缩） | `src/services/compact/` |
| `analytics/` | 遥测埋点（事件 + 数据上报） | `src/services/analytics/` |
| `langfuse/` | Langfuse trace 集成（LLM 可观测性） | `src/services/langfuse/` |

### UI 层模块

| 关键模块 | 一句话职责 | 核心文件 |
|---------|-----------|---------|
| `REPL.tsx` | 交互式 REPL 屏幕 | `src/screens/REPL.tsx` |
| `Messages.tsx` | 消息列表渲染 | `src/components/Messages.tsx` |
| `PromptInput/` | 用户输入处理组件 | `src/components/PromptInput/` |
| `permissions/` | 工具权限审批 UI | `src/components/permissions/` |
| `design-system/` | 复用 UI 组件（Dialog, FuzzyPicker 等） | `src/components/design-system/` |

模块地图给出了"是什么在哪"。但层与层之间不是随便调用——下一节归纳出四种通信模式，揭示它们各自适合什么场景。

---

## 六、层间通信的四种模式

七层之间并非用同一种方式对话。根据数据是否流式、是否需要插件扩展、是否跨组件树共享，系统演化出四种通信模式。理解它们的取舍，才能判断"新功能该挂在哪条线上"。

### 模式 A：函数调用（同步）

**位置**：上下文层 → 循环层（每轮开始时调用 `getSystemContext()`）。

**优点**：类型安全、调用栈清晰、易于追踪。

**缺点**：耦合——循环层知道上下文层的函数签名。上下文层接口变更会直接编译期报错，但这正是"显式依赖"的代价。

### 模式 B：AsyncGenerator（流式）

**位置**：循环层 → UI 层（`query()` 返回 `AsyncGenerator<StreamEvent>`）。

**优点**：天然支持流式渲染、可取消、内存友好（不需要缓冲完整结果）。

**缺点**：状态机复杂——生成器内部维护指针，调试时难以断点。一个 yield 错位可能导致 UI 渲染顺序错乱，且不易从堆栈看出问题。

### 模式 C：事件回调（异步通知）

**位置**：Hook 系统（PreToolUse/PostToolUse）。

**优点**：插件友好——第三方 hook 通过回调注入逻辑，循环层不感知 hook 的存在。

**缺点**：执行顺序不直观——多个 hook 串联时，决策合并逻辑复杂（deny 优先？还是按顺序覆盖？详见 [12-hook-interception](cc-12-hook-interception.md)）。

### 模式 D：共享状态（Context）

**位置**：UI 层 ↔ 循环层（React Context 共享 `AppState`）。

**优点**：组件树自由访问状态，避免 prop drilling（把 prop 一层层往下传）。

**缺点**：性能——状态变更触发整个订阅树 re-render。需要 selector + memoization 缓解，否则一次消息更新会引发整屏组件重绘。

四种模式覆盖了系统里所有的层间对话方式。但"能怎么调"不等于"该调谁"——下一节用依赖约束划出合法与非法的边界。

---

## 七、跨层依赖约束

通信模式回答了"用什么方式调"，依赖约束回答了"能调谁、不能调谁"。这是分层架构的硬纪律：依赖方向只能从上往下，反向即层违例。

### 7.1 允许的依赖方向

```
UI 层 ──depends on──> 循环层 (consume query() AsyncGenerator)
入口层 ──depends on──> 所有下层 (懒加载)
上下文层 ──depends on──> 基础设施层 (filesystem, persistence)
循环层 ──depends on──> 上下文层, API 层, 工具层, 基础设施层
工具层 ──depends on──> API 层 (tool schema), 基础设施层 (logging)
API 层 ──depends on──> 基础设施层 (logging, metrics)
基础设施层 ──depends on──> 无 (纯叶子层)
```

注意一个反直觉点：**入口层依赖所有下层，但位置在 UI 层之下**。这是因为入口层是"路由器"——它要能加载任何子命令对应的模块，所以必须能看见所有层；但它通过动态 import 保持延迟绑定，不到需要时不加载。位置≠可见性。

### 7.2 禁止的依赖（层违例 anti-pattern）

| 违例 | 原因 | 反例 |
|------|------|------|
| 上下文层 → 循环层 | 循环层变化会污染上下文组装 | `getSystemContext()` 内调用 `query()` |
| API 层 → 工具层 | API 层应只关心请求/响应，不应知道工具实现 | `claude.ts` 内 `import { BashTool }` |
| 基础设施层 → 任何上层 | 基础设施是叶子，不应被上层反向影响 | `sessionStorage.ts` 内调用 `recordPermissionDecision()` |
| UI 层 → API 层 | UI 应通过循环层消费，不应直接调用 API | `REPL.tsx` 内 `import { queryModel }` |
| 入口层 → UI 层（具体组件） | 入口层只做路由，不做渲染 | `cli.tsx` 内 `import { REPL } from '../screens/REPL'` |

### 7.3 跨层依赖的典型场景（合法但需谨慎）

并非所有跨层都是违例。有三类"必要的跨层"被系统明确允许，因为它们对应的是不可妥协的横切关注点：

- **权限检查跨层**：权限模块 (`utils/permissions/`) 同时依赖 UI 层（HITL prompt 渲染）和工具层（tool schema 校验）。这是**必要的跨层**——安全边界需要触及所有相关层，否则就存在绕过路径。
- **Hook 系统跨层**：Hook 既拦截循环层（PreToolUse 在工具执行前），又消费工具层（tool metadata）。系统通过 `hooks.ts` 作为统一抽象层缓解，避免散落各处的直接依赖。
- **Analytics 跨层**：埋点需要在每一层调用，但基础设施层只提供 `recordEvent()` API，调用方决定何时记录——基础设施层依然是被动叶子，不反向驱动上层。

规律是：**跨层不是禁忌，但跨层必须走显式抽象层**（权限模块、hooks.ts、analytics API），不能是某层直接 import 另一层的内部实现。

约束讲了"怎么连才合法"。最后一节用三条端到端数据流把前面的知识串起来——它们是验证分层是否真在生效的试金石。

---

## 八、关键数据流追溯

前面几节分别从职责、调用图、通信模式、依赖约束看分层。这一节用三条真实业务路径把它们串起来，验证分层在端到端场景下确实成立。每条路径标注了穿越的层和关键函数。

### 8.1 数据流 1：用户输入 → 首轮响应

```
[用户键盘输入]
  → PromptInput.tsx (UI 层) 捕获按键
  → onSubmit callback 触发
  → 入口层 processUserInput() 解析为 UserMessage
  → 循环层 query() 启动
       ↓
       getSystemContext() (上下文层) → 读取 CLAUDE.md、git status
       getUserContext() (上下文层) → 解析 @file 引用
       ↓
       queryModel() (API 层) → 构造请求 → 发送 → stream events
       ↓
       for await (const event of stream) → yield to UI 层
       ↓
       REPL.tsx (UI 层) 接收 events → 渲染文本 / 检测 tool_use
  → 用户看到首字响应
```

这条路径验证了"UI → 入口 → 循环 → (上下文 + API) → UI"的单向流动，没有任何层反向调用上层（除 AsyncGenerator 的 yield 回流）。

### 8.2 数据流 2：工具调用 → 结果注入

```
[LLM 返回 tool_use 块]
  → 循环层 runTools() (调用 src/services/tools/toolOrchestration.js)
       ↓
       findToolByName() (工具层) → 查找 Tool 实例
       ↓
       executePreToolHooks() (循环层 + 工具层交互)
       ↓
       hasPermissionsToUseTool() (权限层，跨多层)
       ↓  允许
       tool.call(input) (工具层) → 执行（如 BashTool.spawn）
       ↓
       executePostToolHooks() (循环层)
       ↓
       mapToolResultToToolResultBlockParam() → ToolResultBlockParam
  → 注入下一轮 messages
  → 循环继续
```

这条路径展示了权限与 Hook 作为"横切关注点"如何夹在工具执行前后——它们名义上属于工具层，实际跨越循环层与 UI 层（HITL）。

### 8.3 数据流 3：会话恢复

```
[启动 `claude --resume <session-id>`]
  → 入口层 main.tsx 解析参数
  → 循环层 query() 检测到 resume 标志
       ↓
       sessionStorage.readTranscript(sessionId) (基础设施层)
       ↓
       解析 JSONL 为 Message[] 数组
       ↓
       作为初始 messages 传入 query()
  → 循环从历史状态继续
```

这条路径验证了基础设施层的"叶子"属性——它只被动提供 `readTranscript()`，不参与循环层的决策，符合第七节的约束。

三条数据流都验证了分层的有效性。最后两节是收束：第九节解释"为什么是这七层、为什么这样切"，第十节提炼可迁移到其他 Agent 系统的分层原则。

---

## 九、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 分几层 | 7 层（入口/UI/上下文/循环/工具/API/基础设施） | 3-4 层粗分 | CLI Agent 的复杂度需要细粒度解耦，尤其是上下文组装和循环控制需要独立管理；粗分会让单层承担过多职责，变更隔离失效 |
| 层间通信方式 | 函数调用 + AsyncGenerator | EventBus / 消息队列 | 同步调用链路更易追踪和调试；AsyncGenerator 天然适合流式场景；EventBus 的隐式订阅关系在几千行循环里反而增加心智负担 |
| API 层多 Provider | 统一为 Anthropic 内部格式 | 各 Provider 独立接口 | 下游代码（循环层、工具层）完全不感知 Provider 差异；新增 Provider 只改 API 层适配器，不动其他 50+ 文件 |
| 上下文层与循环层的关系 | 循环层主动拉取上下文 | 上下文层推送 | 循环每轮需要的上下文不同（压缩后、MCP 工具变更后），主动拉取更灵活；推送模型需要上下文层预知循环需求，耦合更紧 |
| 工具层的位置 | 在循环层之下、API 层之上 | 与 API 层平级 | 工具 Schema 需要注入 API 请求（告诉 LLM 有哪些工具），但工具执行在 LLM 响应之后——两层通过 Schema 类型耦合，但执行时机错开 |
| UI 层与循环层的耦合 | 直接消费 query() AsyncGenerator | 通过 QueryEngine 中间层 | 内部 REPL 直接耦合（性能优先，减少一层包装），外部 SDK 通过 QueryEngine 解耦（需要压缩、归因等会话级能力） |
| 基础设施层的位置 | 在最底部 | 与循环层平行 | 持久化和可观测性是被动依赖，不参与决策，放在最底层避免循环依赖；若与循环层平行，循环层引用基础设施、基础设施回调循环层即成环 |

---

## 十、可复用的模式

- **分层原则**：按"稳定性"从高到低排列——基础设施层最稳定（很少变），UI 层最易变。把易变的放在上层，稳定的放在下层。这样下层变更频率低，上层可以放心依赖。
- **AsyncGenerator 作为层间接口**：在 TypeScript Agent 系统中，`AsyncGenerator<Event>` 是连接循环层和 UI 层的天然接口——支持流式、可取消、类型安全。比 EventBus 更适合"一条主流式管道"的场景。
- **主动拉取 vs 被动推送**：循环层主动拉取上下文（而非上下文层推送），因为每轮需要的上下文可能不同。这个原则适用于任何"消费者需求动态变化"的层间关系。
- **Schema 注入 vs 内联定义**：工具 Schema 在 API 层注入 LLM 请求，但工具实现在工具层——两层通过 Schema 类型耦合，但实现完全解耦。这种"接口在上、实现在下"的模式让工具增删不影响 API 层。
- **层违例的合法场景**：权限模块跨层（必要的安全边界）、Hook 系统跨层（必要的扩展点）、Analytics 跨层（必要的可观测性）。跨层不是禁忌，但需要明确接口和单向数据流——必须走显式抽象层，不能是某层直接 import 另一层的内部实现。

