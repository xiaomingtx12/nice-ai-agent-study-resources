---
description: "Plan 模式不是单一功能，而是同时改写 System Prompt、锁定写工具、插入审批关卡的跨层约束组合——三者缺一都会留下被 LLM 绕过的口子。本章拆它在 4 种协作范式中的定位，以及 prepareContextForPlanMode 与 ExitPlanModeV2 的状态机设计。"
---

# Plan 模式：跨层约束组合

> **本章目标**：理解 Plan 模式（计划模式）的完整设计——它如何在"理解需求"和"写代码"之间插入审批关卡，如何通过对多个架构层（上下文、循环、工具）的同时约束来实现"先方案后执行"的行为模式，以及它在 4 种协作范式（Plan / Goal / Spec / Loop）中的位置。
>
> **读完本章你应该能回答**：
> - Plan 模式在 4 种协作范式（Plan / Goal / Spec / Loop）中如何定位？人介入点、退出机制和其他 3 种范式有何不同？
> - 为什么 Plan 模式不是单一功能，而是跨层约束组合？
> - `prepareContextForPlanMode` 的三个状态机分支分别处理什么场景？
> - `prePlanMode` 字段承担哪三个职责？
> - Plan Mode SOP 注入给 LLM 的指令是什么？
> - `ExitPlanModeV2Tool` 退出时如何协调磁盘一致性、断路器、dangerous permissions、mailbox 协议？
> - 为什么用 deny 规则而非工具移除来锁定写权限？
> - Plan 模式与 Plan 子 Agent 的区别是什么？

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 · 解决什么问题 | 4 种协作范式总览 + Plan 范式的定位与必要性 | 必读，建立问题意识 |
| 二 · 在整体架构中的位置 | Plan 作为跨层约束组合的坐标定位 | 必读，建立全局坐标 |
| 三 · 宏观看系统完整样貌 | 端到端全景图 + 核心抽象 + 跨层版图 + 注册机制 + 对外接口 + 状态归属 + 概念辨析 | 必读，建立心智模型 |
| 四 · 深入核心运行时细节 | 沿"进入 → 调研 → 退出 → 恢复"生命周期展开，每机制三段式 | 必读，理解机制实现 |
| 五 · 设计决策与权衡 | 关键设计点的取舍原因 | 理解为什么这样设计 |
| 六 · 边界与局限 | 当前实现的不足 | 了解适用边界 |
| 七 · 可复用的模式 | 提炼可迁移的设计模式 | 横向迁移时参考 |


---

## 一、解决什么问题

### 1.1 协作范式：4 种不同的"人 + Claude"分工方式

Agent 的能力和人的判断力需要配合。不同任务需要不同程度的"人介入"和不同的"自动化方式"——改一行代码不需要审批，重构整个模块需要先看方案；CI 失败需要自动修复，但自动修复前应该先分析原因。

**Claude Code 提供了 4 种协作范式**——它们不是 4 个独立功能模块，而是对 Agent 自治性的 4 种"调节档位"，每种范式通过参数化组合下层机制（上下文、循环、工具、Hook、Cron、Skill）实现：

| 范式 | 核心问题 | 人的介入点 | 退出机制 | 依赖的底层机制 |
|------|----------|-----------|----------|--------------|
| **Plan** | 怎么做？ | 方案出来**approve / 拒绝** | approve 后执行 | 上下文 SOP + 工具锁定 + 审批关卡 |
| **Goal** | 达成什么？ | 设定**完成条件**，Claude 持续推进 | 条件满足自动停止 | Stop hook + Haiku 条件评估 |
| **Spec** | 做什么/不做什么？ | 写**规范文档**，Claude 严格遵守 | 规范完成 | Skill + Rules + CLAUDE.md 分层 |
| **Loop** | 多长时间做一次？ | 设**间隔**和**提示词** | 手动停止 / 7 天过期 | Cron 调度 + 空闲触发 |

**范式本质**："对 Agent 自治性的调节旋钮"。**完全不调节**意味着 LLM 自己判断一切（最灵活也最不可控），**完全调节**意味着每步需用户介入（最可控但最低效）。4 种范式提供 4 个预设的语义清晰的中间档位，让用户按任务风险选择合适的"自动化层级"。

**横向对比见 `27-collaboration-paradigms`（源系列第 27 篇，本站未收录）**——本文聚焦 4 种范式中的 **Plan**。

### 1.2 为什么需要 Plan 范式

直接让 Agent 改代码风险太大——它可能理解错需求、选错方案、改错文件。Plan 范式在"理解需求"和"写代码"之间插入一个"方案审批"关卡：Agent 先调研、出方案、等人批准，再执行。

Plan 范式要解决的根本矛盾是：**Agent 的自主性与人类对关键决策的控制权之间的冲突**。在没有 Plan 范式时，Agent 可以自由地读取代码、修改文件、运行命令，整个过程对用户是"黑盒"的。用户只能看到最终结果，如果 Agent 的方案错了，损失已经造成。Plan 范式通过"先让 Agent 把方案写出来，人审批后再执行"的流程，把"方向决策权"交还给人类，同时保留"方案执行权"给 Agent。

这里的权衡是**延迟与安全的交换**：Plan 模式用一次"调研 + 等待审批"的延迟，换来对错误方案的事前拦截。对于不可逆操作（删文件、改公共配置、重构核心模块），这种延迟是值得的；对于可逆的小改动，延迟反而是负担——这也解释了为什么 Plan 是"按需启用"而非"默认开启"。

### 1.3 Plan 范式与其他 3 种范式的关键区别

**Plan vs Goal**：Plan 的退出依赖**离散事件**（用户 approve / reject），Goal 的退出依赖**条件评估**（"X 任务完成了吗？"）。

**Plan vs Spec**：Plan 关注"**当前任务怎么做**"（运行时决策），Spec 关注"**所有任务遵守什么规则**"（持久约束）。Spec 通过 CLAUDE.md / SKILL.md 文件静态加载，Plan 通过 `/plan` slash command 动态启用。

**Plan vs Loop**：Plan 是**单次任务**的工作模式（"这次重构先 plan 一下"），Loop 是**周期性触发**（"每 30 分钟跑一次测试"）。两者可以组合：Loop 触发后用 Plan 模式执行每个周期的任务。

**它不是一个独立功能，而是对上下文组装层、Agent 循环层、工具管线层的跨层约束组合**。这种"组合拳"的设计是 Plan 范式区别于普通 Skill/工具的关键：单一层无法独立实现"先 plan 后执行"——只改 System Prompt，LLM 仍可调用写工具"绕过"口头约束；只锁工具，LLM 不知道该先调研还是直接动手；只插审批关卡，没有只读调研阶段就无法产出可审批的方案。必须同时改变 Agent **看到什么**（System Prompt）、**能用什么**（权限/工具）、**何以为终点**（ExitPlanMode 审批关卡），三者缺一都会留下"绕过"的口子。

明确了 Plan 要解决"自主性与控制权"的矛盾之后，下一个问题是：这个矛盾在架构里究竟靠什么机制化解？这正是第二章要回答的。

## 二、在整体架构中的位置

Plan 不是单一功能，是对**上下文组装层、Agent 循环层、工具管线层**的跨层约束组合。它通过改变 System Prompt（上下文层）、锁定写工具（工具层）、插入审批关卡（循环层）来实现"先方案后执行"的行为模式。

架构上分两步：

1. **进入**：主 Agent 通过 `EnterPlanModeTool` 触发，将 `ToolPermissionContext.mode` 改为 `'plan'`，由 `prepareContextForPlanMode()` 改写上下文保存 prePlanMode（写工具的实际锁定由 Plan Mode 工具集与 EnterPlanMode 阶段的 CLI permission 检查协作完成）。
2. **退出**：主 Agent 通过 `ExitPlanModeV2Tool` 触发，将模式恢复为 `prePlanMode ?? 'default'`，移除 deny 规则。

下面这张表完整展示了 Plan 模式对各个架构层的影响：

| 被改变的层 | 正常模式 | Plan 模式 | 实现方式 | 证据 |
|-----------|---------|----------|---------|------|
| 上下文组装 | 标准 System Prompt | 注入 Plan Mode SOP + PLAN.md/TODO.md 路径指示 | System Prompt 片段追加 | `src/constants/prompts.js` |
| Agent 循环 | 自由决策 | Reason 强制"先调研"，Act 锁定写工具 | Plan Mode 工具集 + 权限上下文 | `src/utils/permissions/permissionSetup.ts:1451` |
| 工具管线 | 全工具可用 | Edit/Write/Bash(危险) 被阻止 | 权限上下文 deny 规则 | `src/utils/permissions/permissionSetup.ts:1451-1482` |
| 退出条件 | LLM 判断 | 用户 approve 为新增关卡 | `ExitPlanModeV2Tool` | `packages/builtin-tools/src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` |
| 状态管理 | 上下文内 | 外部化：PLAN.md + TODO.md 文件 | Plan 模式 SOP 指示 | `src/constants/prompts.js` + `src/utils/plans.ts` |
| 模式标识 | `toolPermissionContext.mode` | `mode === 'plan'` + `prePlanMode = X` | Mode 字段 | `permissionSetup.ts` |

读完这张表，你应该意识到 Plan 模式的"跨层"特性：它不是改一个文件就能实现的，需要 System Prompt、工具集、权限规则、退出条件同时协调。这种多管齐下的设计是 Plan 模式区别于其他 Agent 机制的关键。表中的"实现方式"列尤其值得注意——它揭示了一个反直觉的事实：Plan 模式的写权限锁定并不靠"从工具列表里删掉写工具"，而是靠权限上下文的 deny 规则 + prePlanMode 状态切换。**为什么选 deny 而非删除**，是贯穿后续两章的核心设计决策，第四章 4.3 节会专门拆解。

知道了 Plan 改了哪几层之后，需要把这些层拼成一张完整的系统样貌——这就是第三章的任务。

## 三、宏观看系统完整样貌

在深入任何一行代码之前，先用一张端到端全景图建立心智模型。下图把 Plan 模式抽象为"正常 Agent Loop 中插入的一段只读 + 审批窗口"，窗口内四个阶段依次走过，三层架构在各阶段被不同方式约束，两份持久状态跨整个窗口维系一致性。

```
                      Plan 模式 = 正常 Agent Loop 中插入的"只读 + 审批"窗口

  ┌─────────┐   ┌───────────┐   ┌───────────────┐   ┌───────────┐   ┌───────────┐
  │ 用户意图 │──►│ ① 进入    │──►│ ② 调研        │──►│ ③ 退出    │──►│ ④ 执行    │
  │ /plan   │   │ EnterPlan │   │ 只读工具 + SOP│   │ 审批关卡  │   │ 写工具    │
  │         │   │ ModeTool  │   │ PLAN.md 落盘  │   │ ExitPlan  │   │ 按 plan   │
  └─────────┘   └───────────┘   └───────────────┘   └───────────┘   └───────────┘
                     │                 │                  │               │
   ── 上下文层 ──  注入 SOP         SOP 引导调研        附件回写         标准 Prompt
   ── 循环层  ──  mode='plan'      Reason 强制先调研    approve 关卡    正常 Loop
   ── 工具层  ──  锁写工具         只读集可用           写盘 plan       写工具解锁
   ── 状态层  ──  存 prePlanMode   写 PLAN.md          恢复 mode       建 TODO.md

                     └◄── prePlanMode：跨整个窗口保存"恢复目标" ──►┘
                          └◄── PLAN.md：人/Agent/验证工具的共同事实 ──►┘
```

这张图是后续所有讨论的锚点：①④ 是窗口的边界（进入与恢复），② 是窗口内的主体（只读调研），③ 是窗口的闸门（审批关卡）。`prePlanMode` 和 `PLAN.md` 两条横贯线，分别是"恢复目标"和"共同事实"——前者保证退出后回到原工作模式，后者保证人、Agent、验证工具看到同一份方案。下面逐个侧面展开。

### 3.1 全景链路：从用户输入到方案执行

把上图展开成实际的调用链路，可以看到每个阶段背后真实的函数调用与状态流转：

```
用户: "plan how to refactor the auth module"
  │
  ├─► 用户输入 → 主 Agent 决定调 EnterPlanModeTool
  │
  ├─► EnterPlanModeTool.call(_input, context) (EnterPlanModeTool.ts:77)
  │     ├─► handlePlanModeTransition(currentMode, 'plan')   // bootstrap/state
  │     ├─► applyPermissionUpdate(
  │     │      prepareContextForPlanMode(prev.toolPermissionContext),
  │     │      { type: 'setMode', mode: 'plan', destination: 'session' }
  │     │   )
  │     │     ├─► prePlanMode = 当前 mode (permissionSetup.ts:1481)
  │     │     └─► toolPermissionContext.mode = 'plan'
  │     └─► 返回: "Entered plan mode. ... DO NOT write or edit any files"
  │
  ├─► Plan 调研阶段 (主 Agent loop, 只读工具)
  │     ├─► GlobTool / GrepTool / FileReadTool (允许)
  │     ├─► 主 Agent 也可调 AgentTool spawn Explore 子 Agent
  │     │     └─► 子 Agent 用更严格的只读集探索 → 返回摘要
  │     └─► 主 Agent 整理方案 → 写入 PLAN.md（FileWrite 通常被 lock 时仍可用：
  │           EnterPlanMode 工具本身返回的 SOP 告诉 LLM 写到固定路径，
  │           权限层未必 deny；规则一致性取决于版本）
  │
  ├─► 用户审查 PLAN.md（CLI / 文件查看 / AskUserQuestion 反问）
  │
  ├─► ExitPlanModeV2Tool.call(input, context) (ExitPlanModeV2Tool.ts:243)
  │     ├─► input.plan ?? getPlan(agentId) 读出最终方案内容
  │     ├─► 写盘: writeFile(filePath, plan, 'utf-8') (.ts:258-261)
  │     │     └─► 用于 CCR/VerifyPlanExecution/Read 后续读取
  │     ├─► 若是 plan_mode_required teammate：
  │     │     ├─► 生成 requestId (plan_approval)
  │     │     └─► writeToMailbox('team-lead', {...}) 走 mailbox 异步审批
  │     │     └─► setAwaitingPlanApproval(taskId, true)
  │     └─► 否则（普通用户）：
  │           ├─► checkPermissions 返回 'ask'，等用户授权
  │           ├─► 用户 approve → 走到 context.setAppState()
  │           │     ├─► setHasExitedPlanMode(true)
  │           │     ├─► setNeedsPlanModeExitAttachment(true)
  │           │     ├─► restoreMode = prePlanMode ?? 'default'
  │           │     │     └─► gate off 时 fallback 到 'default'（断路器）
  │           │     ├─► 自动管理 autoModeStateModule.setAutoModeActive
  │           │     └─► 视情况 restoreDangerousPermissions 或保持剥离
  │           └─► toolPermissionContext.mode = restoreMode, prePlanMode = undefined
  │
  └─► 执行阶段 (正常 Agent Loop + 写工具可用)
        └─► Agent 按 PLAN.md 顺序实现，期间若发现新信息可再次 EnterPlanMode
```

这条链路与开篇全景图的四个阶段一一对应：`EnterPlanModeTool` 是 ①，调研循环是 ②，`ExitPlanModeV2Tool` 是 ③，恢复后的正常 Loop 是 ④。链路中最复杂的部分集中在 ③——退出时要同时摆平磁盘、权限、auto 状态机、mailbox 四件事，第四章 4.4 节会逐件拆解。

### 3.2 核心抽象

全景链路背后有五个反复出现的关键抽象，理解了它们就掌握了 Plan 模式的词汇表：

| 抽象 | 定义 | 承担的职责 |
|------|------|-----------|
| `toolPermissionContext.mode` | 全局权限模式枚举（`default` / `plan` / `auto` / `acceptEdits` / `bypassPermissions`） | Plan 模式的"总开关"——值为 `'plan'` 即整个会话处于只读调研窗口 |
| `prePlanMode` | 进入 Plan 前的 mode 快照 | 跨窗口携带"恢复目标"，让退出回到原工作模式而非强制 `default` |
| `prepareContextForPlanMode()` | Plan 入口的上下文改写函数 | 切 mode、stash prePlanMode、与 auto mode 状态机协调 |
| `ExitPlanModeV2Tool` | Plan 退出工具 | 协调磁盘写盘、断路器、dangerous permissions、mailbox 四状态 |
| `PLAN.md` | 固定路径的方案文件 | 人/Agent/验证工具的共同事实源，外部化状态归属 |

注意这些抽象的分工边界：`mode` 是"当前在哪"，`prePlanMode` 是"从哪来/回哪去"，`prepareContextForPlanMode` 管"进入时怎么改"，`ExitPlanModeV2Tool` 管"退出时怎么还原"，`PLAN.md` 是"窗口内产出的共同事实"。五个抽象两两正交，各管一段——这种正交性是 Plan 模式能在多层同时协调而不混乱的基础。

### 3.3 跨层版图分类

把第二章的跨层影响表换个视角，按"约束类型"重新分类，可以更清楚地看到 Plan 模式对每一层施加的是哪种性质的约束：

| 约束类型 | 作用层 | 性质 | 典型体现 |
|---------|--------|------|---------|
| **认知约束** | 上下文层 | 软约束（prompt 引导） | SOP 告诉 LLM"先调研、别改文件" |
| **能力约束** | 工具层 | 硬约束（deny 规则） | Edit/Write/Bash 被 deny，调用即报错 |
| **流程约束** | 循环层 | 关卡约束（审批门） | 必须经 `ExitPlanModeV2Tool` 才能进入执行 |
| **状态约束** | 状态层 | 归属约束（外部化） | 方案写 PLAN.md，不在上下文里堆积 |

这个分类揭示了一个设计原则：**软约束负责引导意图，硬约束负责兜底安全**。光有 SOP（认知约束）LLM 可能"忘记"；光有 deny（能力约束）LLM 会困惑"工具怎么不能用了"。两者配合——SOP 让 LLM 知道"应该只读"，deny 让 LLM 即便想写也写不了——才构成完整的约束闭环。流程约束（审批关卡）则把"何时从只读切换到可写"的决定权交给人。这种"软引导 + 硬兜底 + 人关卡"的三重约束结构，是 Plan 模式可信任的根源。

### 3.4 注册与装配机制

Plan 模式不是"运行时现搭"的，它的关键组件在启动期就已注册到各自的位置，运行时只是激活：

- **工具注册**：`EnterPlanModeTool` 与 `ExitPlanModeV2Tool` 作为内置工具在 `packages/builtin-tools` 下注册（`EnterPlanModeTool.ts`、`ExitPlanModeTool/ExitPlanModeV2Tool.ts`），主 Agent 的工具池常驻这两个工具，是否调用由 LLM 决定。
- **SOP 装配**：Plan 模式的标准操作流程并不写死在 System Prompt 里，而是通过 `EnterPlanModeTool.mapToolResultToToolResultBlockParam`（`EnterPlanModeTool.ts:103-125`）在工具返回结果时动态拼装——这样 SOP 只在真正进入 Plan 模式后才注入，不污染正常会话的上下文。
- **权限规则装配**：deny 规则与 `prePlanMode` 由 `prepareContextForPlanMode`（`permissionSetup.ts:1451-1482`）在进入时写入 `toolPermissionContext`，退出时由 `ExitPlanModeV2Tool` 清理。
- **Feature flag 分支**：`TRANSCRIPT_CLASSIFIER` feature 控制是否启用 auto mode 协同分支——这是默认开启的实验性路径，决定了进入逻辑走"复杂三分支"还是"简单直进"。

这种"启动期注册、运行时激活"的装配方式有一个好处：Plan 模式的所有组件都是"常驻但休眠"的，进入 Plan 只是点亮它们，退出则让它们重新休眠。不需要动态加载/卸载工具，也就不会破坏 prompt cache（这一点 4.3 节会展开）。

### 3.5 对外接口

Plan 模式对外暴露的接口分三层，分别面向用户、Agent、外部工具：

| 接口层 | 接口 | 服务对象 | 语义 |
|--------|------|---------|------|
| 用户接口 | `/plan` slash command | 人类用户 | 显式声明"接下来这段任务要先 plan" |
| Agent 接口 | `EnterPlanModeTool` / `ExitPlanModeV2Tool` | LLM | 进入/退出只读调研窗口的工具调用 |
| 文件接口 | `PLAN.md`（`getPlanFilePath()`） | 人 / Agent / 验证工具 | 共同事实源，可读可编辑 |
| 进程间接口 | mailbox `'team-lead'` | teammate → leader | 异步审批请求通道 |

几个接口设计值得点出其意图：`/plan` 用 slash command 而非自动检测，是为了**显式确认用户意图**——避免 Agent 误判"这个任务需要 plan"而频繁打断；`ExitPlanModeV2Tool` 既接受 `input.plan`（CCR Web UI 回传编辑后的方案）又回退 `getPlan(agentId)`（CLI 读盘），是为了**统一 CLI 与 Web 两条入口**；`PLAN.md` 用固定路径而非用户指定，是为了让人、Agent、`VerifyPlanExecutionTool` 引用同一份事实——路径可编辑但不可换地方。这些接口选择都指向同一个目标：让"先方案后执行"的契约在多个参与者之间无歧义地传递。

### 3.6 外部化状态归属

Plan 模式把中间产物写到 **文件**而非上下文，是延续 Agent 系统"位置透明"原则的具体实例——同一份事实既可以被 LLM 用 Read 读到、也可以被人类用编辑器查看、也可以被 VerifyPlanExecution 工具独立验证。

- **PLAN.md**：Plan Mode 期间，Agent 将调研发现和方案写到 `getPlanFilePath()` 返回的固定路径（`src/utils/plans.ts`）。用户可直接编辑或评论（CCR Web UI 提供 Ctrl+G 触发编辑）。Plan Mode 结束后保留为项目文档。

- **TODO.md**：原文档提到的 TODO 任务清单在当前实现中由主 Agent 在执行阶段自行用 `TaskCreateTool` / `TodoWrite` 类工具建立（这不是 plan 模式的强制产物，而是惯例）；ExitPlanModeV2Tool 工具结果中 `hasTaskTool` 字段会建议 "consider using the TeamCreate tool" 提示并行化。

- **状态同步**：Plan Mode 的 System Prompt + EnterPlanMode 的 SOP 指示 Agent 定期读取和更新这两个文件。文件内容不进上下文（Agent 通过 Read 工具获取），避免上下文膨胀。

- **持久化快照**：退出时 `persistFileSnapshotIfRemote()` 把 PLAN.md 同步到 CCR 远端（如果是托管会话），确保 VerifyPlanExecution 看到的不是 stale 版本。

"位置透明"原则是分布式系统中的经典设计：在多个参与者（LLM、人类用户、验证工具）之间共享状态时，把状态放在一个所有参与者都能访问的地方（这里是文件系统），而不是放在某个参与者的私有内存里。这样每个参与者都可以独立地读取和验证状态，不需要通过中心化协议通信。具体到 Plan 场景：如果方案只存在上下文里，用户想看就得"问 Agent"，验证工具想校验就得"请求 Agent 回放"——耦合死在 Agent 上；写成 PLAN.md 后，用户用编辑器看、Agent 用 Read 读、`VerifyPlanExecutionTool` 用文件校验，三者解耦。

### 3.7 概念辨析：Plan 模式 vs Plan 子 Agent

Plan 模式经常和另一个概念——Plan 子 Agent——混淆。它们名字相似但本质不同：Plan 模式是"主 Agent 的行为框架"，Plan 子 Agent 是"只读工具的 Explore 子 Agent"。

| 维度 | Plan 模式（模式） | Plan 子 Agent（子 Agent） |
|------|-----------------|------------------------|
| 是什么 | 主 Agent 的行为框架 | 只读工具的 Explore 子 Agent |
| 谁控制 | 改变主 Agent 的 System Prompt + 工具集 | 被主 Agent 派去探索代码 |
| 关系 | 框架 | 框架下的执行者 |
| 工具集 | 只读集（具体内容依版本而定） | 只读（更严格的子集） |
| 上下文 | 主 Agent 上下文 | 独立上下文（结果摘要回传） |
| Plan 出口 | ExitPlanModeV2Tool | AgentTool 的 tool_result 回给主 Agent |
| Plan 写产物 | PLAN.md | 自然语言摘要进父上下文 |

理解这个区分的关键是：**Plan 模式可以包含 Plan 子 Agent**。主 Agent 进入 Plan 模式后，可能会调用 AgentTool fork 出多个 Explore 子 Agent 并行调研不同模块，这些子 Agent 受 Plan 模式约束（只读），它们是 Plan 模式的"执行者"，不是平级的概念。换句话说：Plan 模式是"舞台"，Plan 子 Agent 是"舞台上的演员"——演员受舞台规则约束，但舞台不依赖某个特定演员。

宏观地图建立后，本章深入运行时，沿一次完整 Plan 调用的生命周期拆解每个机制——这正是第四章的内容。

## 四、深入核心运行时细节

本章沿 Plan 模式一次完整调用的生命周期展开，按 **进入 → 调研 → 退出 → 恢复** 四个阶段组织。每个机制遵循"为什么需要 → 怎么做 → 具体实例"三段式：先讲清这个机制要解决的痛点，再讲实现如何化解，最后用具体代码与场景落地。四个阶段对应第三章全景图的 ①②③④，是那张图的"实现展开"。

### 4.1 进入关卡：`prepareContextForPlanMode` 的三状态分支

**为什么需要**。Plan 模式的入口看似简单——"把 mode 切成 plan"——但真实环境里它要同时满足三个相互冲突的需求：① 幂等性（LLM 可能在 Plan 模式下重复调用 EnterPlanMode，不能把已保存的 `prePlanMode` 覆盖掉）；② auto mode 协同（用户偏好"在 plan 时仍用 auto 分类"是个有效诉求，进入 plan 不一定要完全关闭 auto 语义）；③ 危险权限的正确剥离/恢复（从 auto 进 plan 和从 default 进 plan，退出时的恢复动作不同，进入时必须埋好标记）。一个简单的"切 mode"函数处理不了这三个需求，才有了 `prepareContextForPlanMode` 的三分支结构。

**怎么做**。函数（`src/utils/permissions/permissionSetup.ts:1451-1482`）按"当前 mode + feature flag"分三条路径：

```typescript
// src/utils/permissions/permissionSetup.ts:1451-1482
export function prepareContextForPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  const currentMode = context.mode
  if (currentMode === 'plan') return context   // 幂等：已在 plan 模式直接返回

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const planAutoMode = shouldPlanUseAutoMode()
    // 当前是 auto 模式时，根据用户偏好决定是否在 plan 内保留 auto 语义
    if (currentMode === 'auto') {
      if (planAutoMode) {
        return { ...context, prePlanMode: 'auto' }
      }
      autoModeStateModule?.setAutoModeActive(false)
      setNeedsAutoModeExitAttachment(true)
      return {
        ...restoreDangerousPermissions(context),
        prePlanMode: 'auto',
      }
    }
    // 从非 auto 模式进入时，按是否启用 auto-during-plan 决定是否剥离危险权限
    if (planAutoMode && currentMode !== 'bypassPermissions') {
      autoModeStateModule?.setAutoModeActive(true)
      return {
        ...stripDangerousPermissionsForAutoMode(context),
        prePlanMode: currentMode,
      }
    }
  }
  logForDebugging(
    `[prepareContextForPlanMode] plain plan entry, prePlanMode=${currentMode}`,
    { level: 'info' },
  )
  return { ...context, prePlanMode: currentMode }
}
```

三个分支各自的意图：

- **幂等分支**（第 1455 行 `if (currentMode === 'plan') return context`）：防御性编程。如果不幂等，第二次进入会把第一次保存的 `prePlanMode` 覆盖成 `'plan'`，退出时就永远卡在 plan——恢复目标丢了。
- **auto 协同分支**（`TRANSCRIPT_CLASSIFIER` 启用时）：处理与 auto mode 状态机的交互。当 `planAutoMode === true`（用户偏好"plan 时仍用 auto 分类"），从 auto 进入 plan 保留 auto 语义（`prePlanMode: 'auto'`，不关 auto）；从 default 进入 plan 反而要**开启** auto（`setAutoModeActive(true)` + 剥离危险权限）。当 `planAutoMode === false`，从 auto 进入 plan 要**关闭** auto 并恢复危险权限（因为接下来不再有 auto 剥离逻辑兜底）。这些是 feature flag 控制的实验性行为。
- **直进分支**（末尾 `return { ...context, prePlanMode: currentMode }`）：最简单的路径，feature 关闭或非 auto 场景，只 stash prePlanMode 不动其他状态。

**具体实例**。设想用户正在 `acceptEdits` 模式调试代码，突然想 plan 一个重构方案。调用链是：`EnterPlanModeTool.call`（`EnterPlanModeTool.ts:77`）→ `prepareContextForPlanMode(prev.toolPermissionContext)` → `applyPermissionUpdate(..., { type: 'setMode', mode: 'plan', destination: 'session' })`。因为 `currentMode === 'acceptEdits'`（非 auto），走直进分支，`prePlanMode = 'acceptEdits'`，`mode = 'plan'`。此后 LLM 收到 `mapToolResultToToolResultBlockParam` 返回的 SOP 指令（`EnterPlanModeTool.ts:103-125`），开始只读调研。退出时 `ExitPlanModeV2Tool` 读 `prePlanMode ?? 'default'` 得到 `'acceptEdits'`，把 mode 恢复回去——用户无缝回到调试现场，工作流不断裂。

**一个勘误**：原文档曾暗示 `prepareContextForPlanMode` 直接展开 `alwaysDenyRules` 数组来锁写工具。当前实际实现 **并未** 这么做——它只保存 `prePlanMode`，写工具的锁定由 **Plan Mode 工具集**（tool pool 替换）与 **EnterPlanMode 阶段的 CLI permission 检查**协作完成。这是对原文第二章表"实现方式 / 证据"列的勘误，但**设计意图不变**：锁定靠 deny 规则与状态切换，而非工具注册时移除（4.3 节详解）。

### 4.2 调研引导：SOP 注入与只读工具集

**为什么需要**。光把 mode 切成 plan、锁住写工具还不够——LLM 还需要知道"接下来该干嘛"。如果不告诉它"先调研、写方案、再 ExitPlanMode"，它可能直接调 `ExitPlanMode` 提交一个空方案，或者在只读工具里漫无目的地翻代码。需要一个"操作流程"引导 LLM 把调研阶段的精力花在刀刃上，并把产出落到 `PLAN.md` 这个约定位置。

**怎么做**。SOP（Standard Operating Procedure，标准操作流程）是一段注入到工具结果中的自然语言指令，由 `EnterPlanModeTool.mapToolResultToToolResultBlockParam`（`EnterPlanModeTool.ts:103-125`）拼装。它有两个分支：

- `isPlanModeInterviewPhaseEnabled()` 启用时：返回简化版 `"DO NOT write or edit any files except the plan file. Detailed workflow instructions will follow."`——先给最关键的"别改文件"禁令，详细工作流延迟注入（分阶段引导，避免一次性塞太多）。
- 否则：返回完整 6 步 SOP（探索 → 识别相似模式 → 权衡多种方案 → AskUserQuestion 澄清 → 设计实现策略 → 调 ExitPlanMode 提交）。

SOP 告诉 LLM 四件事：**只能**用 GlobTool、GrepTool、FileReadTool 等只读工具调研；如对方案有疑问用 `AskUserQuestion` 澄清；把方案写到 **plan 文件**（`getPlanFilePath()` 返回的固定路径，`src/utils/plans.ts`）；写完后调 `ExitPlanModeV2Tool` 请求批准。`plan_mode_v2` 还会启动多个 explore agent 并行调研（`getPlanModeV2AgentCount()`），属于功能进一步增强。

这里的设计要点是：**SOP 是软约束，不通过代码强制**。LLM 理论上可以忽略它——所以才需要 4.3 节的 deny 规则作为硬兜底。用 prompt 而非代码控制 LLM 行为，是因为 LLM 对自然语言指令的遵循比对硬编码规则更灵活：SOP 让 LLM "理解为什么只读"，deny 让 LLM "即便不理解也写不了"。前者引导意图，后者兜底安全。

**具体实例**。用户说"plan how to refactor the auth module"。进入 plan 后 LLM 收到 6 步 SOP，于是它的调用序列大致是：`GrepTool("auth")` 找到相关文件 → `FileReadTool` 读几个关键文件 → 发现两种重构路径，调 `AskUserQuestion` 问用户偏好 → 据用户回答把方案写到 `PLAN.md` → 调 `ExitPlanModeV2Tool`。如果没有 SOP 引导，LLM 可能跳过 AskUserQuestion 直接拍板一个方案，用户的偏好在方案里就丢失了。SOP 的第 4 步"Use AskUserQuestion if you need to clarify the approach"正是为了避免这种"Agent 替用户做决定"的情况。

### 4.3 写权限锁定：deny 规则而非工具移除

**为什么需要**。调研阶段必须保证 LLM 改不了代码——否则"先方案后执行"的契约就是空话。锁写权限有两种实现：A) 从工具列表里移除 Edit/Write/Bash；B) 保留工具但用权限上下文的 deny 规则拦截调用。Plan 模式选了 B。这个选择不是随意的，它直接决定了退出恢复的复杂度、错误恢复的能力、以及调试可见性。理解这个选择，是理解整个 Plan 模式设计哲学的钥匙。

**怎么做**。文档曾示意 `prepareContextForPlanMode` 直接给 `alwaysDenyRules` 加 4 条 deny；但实际实现更轻量——它只保存 `prePlanMode`，deny 锁在 `toolPermissionContext` 的 `rules` 部分，或由 EnterPlanMode 同阶段处理。无论实现细节如何，**设计意图是明确的：deny 规则而非工具移除**。三条理由：

| 维度 | deny 规则 | 工具移除 |
|------|-----------|---------|
| 退出时 | `prePlanMode` 切回，deny 自动失效 | 必须重新注册工具集（要保留/恢复系统 prompt 中的工具描述） |
| 上下文缓存 | 工具定义 cache key 不变（prefix 命中） | 工具列表变化破坏 prefix |
| 子 Agent 继承 | 继承的是同一个 ToolPool | 需要重新装配 |
| Plan 后立即可用 | yes | 需要 reload 工具清单 |

更准确地说，**工具集本身的替换会改变 API request 的 tools 字段**——这会直接导致 Anthropic 的 prompt cache 失效。Claude Code 在 `--version` RSS 优化时已经花过大力气保 cache 命中（见 CLAUDE.md"为什么 Vite 必须代码分割"），同理，Plan 模式不能在退出时让 tool definitions 整体变了。

**具体实例**。LLM 在 plan 调研阶段有时会"忘记"自己不能改文件，试图调 Bash 跑个测试脚本。deny 规则模式下，LLM 收到 `tool_result: { is_error: true, reason: "Bash denied in plan mode" }`——明确的错误信号，LLM **可在下轮推理中调整策略**（"哦我在 plan 模式，先不跑脚本"）。如果是工具移除，LLM 看到的是工具列表里根本没有 Bash，它可能直接放弃或误解（"工具突然消失了？是我记错了还是环境变了？"），产生混乱。这种差异也延伸到调试：deny 模式下，权限系统、telemetry、debug log 都能精准定位"这次工具调用为什么没执行"，事后分析有据可查；工具移除则连"调用发生过"都看不到。

这三条理由本质上都指向同一个核心设计哲学：**对 LLM 的约束应该是"可观察的"而非"隐形的"**。deny 规则给 LLM 一个明确的错误信号（"你想做的事被拒绝了，原因是什么"），工具移除给 LLM 一个模糊的信号（"你想用的工具不见了，可能是我记错了"）。前者让 LLM 能自我修正，后者让 LLM 产生混乱。这个哲学也解释了为什么 Plan 模式宁可维护 `prePlanMode` + deny 规则的状态协调复杂度，也不愿走"工具列表增删"这条看似更简单的路。

### 4.4 退出关卡：`ExitPlanModeV2Tool` 的四状态协调

**为什么需要**。退出 Plan 模式不是"把 mode 切回 default"一句话的事。Plan 模式跨越了太多层：文件持久化（磁盘）、权限状态（上下文）、auto mode 状态机（独立模块）、teammate 通信（mailbox）。每一层都有自己的状态机和一致性要求，退出时必须全部协调对。如果只关注其中一层（比如只看权限状态变化），就会忽略其他层的一致性问题——结果是 mode 切回了，但 PLAN.md 没写盘（验证工具看到旧方案）、或 auto 状态没同步（下次进 auto 行为错乱）、或 teammate 的审批请求丢了。`ExitPlanModeV2Tool.call()`（`ExitPlanModeV2Tool.ts:243`）要同时摆平这四件事。

**怎么做**。函数内部协调四个相互依赖的状态：

1. **磁盘一致性**：CCR Web UI 可能修改 PLAN.md 并通过 `permissionResult.updatedInput` 回传，必须先 `writeFile` 写盘再 `persistFileSnapshotIfRemote()`（因为 `normalizeToolInput` 阶段已经做了一次快照，这是 redo）。代码在 `.ts:258-261`：`inputPlan !== undefined` 时写盘并重快照，确保 VerifyPlanExecution / Read 看到的是编辑后版本。

2. **断路器（circuit breaker）**：`auto` mode 不总是可用，如果 `prePlanMode === 'auto'` 但 `isAutoModeGateEnabled()` 已关闭，要强制 fallback 到 `default` 并通过 `addNotification` 通知用户。这是 SPEC 提到的"Gate-off fallback"——逻辑在 `.ts:322-355`。**断路器**是常见的可靠性设计模式：当一个外部依赖（这里是 auto mode 的 gate）不可用时，与其让整个流程失败，不如降级到一个安全的默认行为。这里"安全默认"是 fallback 到 `default` mode 并通知用户——而不是静默失败或崩溃。如果不做这层防护，`ExitPlanMode` 会直接 `setAutoModeActive(true)` 绕过断路器，把已经"跳闸"的 auto mode 强行重启。

3. **dangerous permissions 同步**：`strippedDangerousRules` 标记决定是否需要 `restoreDangerousPermissions`——从 auto 进入 plan 又退出要恢复；从 default 进入 plan 退出不需要。逻辑在 `.ts:383-394`：`restoringToAuto` 时保持剥离（再 strip 一次），否则按 `strippedDangerousRules` 标记恢复。这里的难点是**标记可能 stale**——`transitionPlanAutoMode` 可能在 plan 中途就改过 auto 状态，所以注释（`.ts:370-374`）特别说明：`autoModeStateModule.isAutoModeActive()` 是"权威信号"，`prePlanMode`/`strippedDangerousRules` 只作参考。

4. **mailbox 协议**：teammate 在 `plan_mode_required` 模式下不能本地弹窗审批，要把审批请求写到 `'team-lead'` mailbox，等 leader 回信（不是本进程同步审批）。逻辑在 `.ts:264-313`：生成 `requestId`、`writeToMailbox('team-lead', ...)`、`setAwaitingPlanApproval(taskId, true)`。

**具体实例**。考虑一个 teammate 场景：team-lead 派一个 worker 去重构模块，该 worker 配置为 `plan_mode_required`（必须先 plan）。worker 调研完调 `ExitPlanModeV2Tool`，因为 `isTeammate() && isPlanModeRequired()` 为真，走 mailbox 分支：把方案内容、`requestId`、`planFilePath` 打包成 `plan_approval_request` 写到 team-lead 的 mailbox，然后 `setAwaitingPlanApproval(true)` 把自己挂起。team-lead 读到 mailbox 消息后审批，worker 收到回信才恢复执行。整个过程没有本地弹窗——因为 teammate 进程没有终端 UI 可弹。对比普通用户场景：同一函数走到 `checkPermissions` 返回 `'ask'`，CLI 弹出审批提示，用户 approve 后 `setAppState` 把 mode 恢复到 `prePlanMode ?? 'default'`。**同一个退出函数，用 `isTeammate()` 分支统一了"本地同步审批"与"远程异步审批"两条路径**，避免双实现。

### 4.5 恢复衔接：`prePlanMode` 的恢复语义

**为什么需要**。用户的工作流不是线性的——他可能正在用 `acceptEdits` 模式调试一段代码，突然想 plan 一下重构方案，plan 完成后希望回到 `acceptEdits` 继续调试。如果 Plan 退出后强制回到 `default`，用户必须手动重新设置 mode，工作流就断裂了。需要一个字段跨整个 Plan 窗口携带"恢复目标"，让退出无缝回到进入前的工作模式。这个字段就是 `prePlanMode`。

**怎么做**。`prePlanMode` 字段承担三个职责：

1. **退出恢复**：`ExitPlanModeV2Tool` 读 `prePlanMode ?? 'default'` 作为新的 `mode`（`.ts:361`），让用户回到进入 Plan 之前的权限模式。`?? 'default'` 用 nullish 合并而非 `|| 'default'`，是为了允许 `prePlanMode` 为空字符串时也能正确 fallback——虽然 mode 枚举里没有空串，但这是防御性的类型安全写法。

2. **同会话再次进入**：`prepareContextForPlanMode` 第 1455 行 `if (currentMode === 'plan') return context` 利用幂等性保留 `prePlanMode` 链——再次进入不会覆盖原值。

3. **auto mode 状态机协调**：与 `autoModeStateModule.isAutoModeActive()` 互为冗余信号，防止 cache-stale 导致一致性问题（注释见 `ExitPlanModeV2Tool.call()` `.ts:370-374`）。这个冗余看起来多余，但实际上是为了应对一种边界情况：当上下文缓存（prompt cache）命中旧版本时，`prePlanMode` 字段可能是 stale 的（指向已经被覆盖的 mode 值）。这时 `autoModeStateModule.isAutoModeActive()` 作为"实时真相源"提供校验。两个信号都指向同一个状态时才认为可信——这是分布式系统里"双轨校验"的经典手法。

**具体实例**。延续 4.1 的场景：用户从 `acceptEdits` 进入 plan，`prePlanMode = 'acceptEdits'`。调研、审批通过后，`ExitPlanModeV2Tool` 在 `setAppState` 里算出 `restoreMode = prePlanMode ?? 'default' = 'acceptEdits'`，再把 `toolPermissionContext.mode` 设为 `'acceptEdits'`、`prePlanMode` 清空为 `undefined`。用户回到 `acceptEdits` 继续 debug，仿佛 plan 这段插曲没发生过。如果中途 auto gate 被关了（断路器跳闸），且 `prePlanMode` 恰好是 `'auto'`，`restoreMode` 会被强制改回 `'default'` 并弹通知——这就是 4.4 断路器与这里恢复语义的衔接点：恢复目标不是无脑还原，而是"在安全前提下还原"。

至此，Plan 模式从进入到恢复的完整生命周期已经走通。第五章回到设计层面，看这些机制背后的取舍。

## 五、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 调研 Agent | 主 Agent 直接调研（Plan Mode） | 全部委托子 Agent | Plan Mode 下主 Agent 有全部只读工具，能更全面地理解项目；子 Agent 用于辅助探索。v2 模式（`planModeV2.ts`）已支持多 Explore agent 并行 |
| 审批关卡 | 一次性审批（方案完成后） | 逐步骤审批 | 一次性审批减少交互频率，适合有经验的用户；逐步骤审批适合高度敏感的操作 |
| 外部化状态 | PLAN.md + TODO.md 文件 | 内存状态 | 文件持久化可跨会话、可人工审查、不占用上下文 |
| 工具锁定方式 | 权限上下文 deny 规则 / prePlanMode 状态切换 | 工具注册时移除 | deny 规则更灵活——可在退出 Plan 时一键恢复，避免破坏 prompt cache |
| Plan Mode 入口 | `/plan` 命令 + 权限模式切换 | 自动检测 | 显式进入确保用户意图明确，避免 Agent 误判"需要 plan" |
| 退出恢复目标 | `prePlanMode ?? 'default'` | 保留 plan 不退出 | 用户大概率想回到原工作模式（acceptEdits/auto/default）；特殊场景用 `--permission-mode` 显式进入 |
| teammate 审批模式 | mailbox 异步（team lead） | 本地 prompt | teammate 不能本地弹窗；统一走 mailbox 让 lead 单点决策 |
| Plan 文件路径 | `getPlanFilePath()` 固定 | 用户可指定 | 固定路径让 Agent / 工具 / 用户引用同一份事实；用户可编辑但不能换地方 |
| auto mode 兼容性 | 进入 plan 时按 `planAutoMode` 决定是否保留 auto 分类器 | 进入 plan 强制关 auto | 用户偏好"在 plan 时仍用 auto 分类"是个有效诉求（plan_mode_v2 已探索） |

这张表里有几个权衡值得展开。"审批关卡"选一次性而非逐步骤，是**交互频率与精细度的交换**——一次性审批快但粒度粗，逐步骤审批细但打断多；Plan 模式面向"有经验的用户 + 中等风险任务"，所以选前者，把逐步骤留给更敏感的场景。"Plan 文件路径"选固定而非可指定，是**灵活性与一致性的交换**——固定路径牺牲了"按项目放不同位置"的灵活，换来人/Agent/验证工具总能找到同一份事实的一致性，后者对 Plan 模式的"共同事实源"设计更关键。"teammate 审批"选 mailbox 异步而非本地 prompt，是被环境约束的——teammate 进程没有终端 UI，本地 prompt 根本无法弹，mailbox 是唯一可行路径，顺带也统一了同步/异步两条审批路径的实现。

## 六、可复用的模式

- **跨层约束组合模式**：通过同时改变多个层的配置（System Prompt + 工具集 + 权限规则 + 循环关卡）来切换 Agent 行为模式，而非在单一层面打补丁。第三章的跨层版图分类（3.3）是这一模式的具象——单一层约束总留有绕过口子，多层正交约束才构成闭环。

- **软引导 + 硬兜底 + 人关卡的三重约束模式**：SOP（软引导意图）+ deny 规则（硬兜底安全）+ ExitPlanMode 审批（人关卡决策）三层叠加，每层性质不同但互补。这是 Plan 模式可信任的根源，可迁移到任何"需要约束 LLM 行为"的场景。

- **审批关卡模式**：在关键决策点（方案完成 → 开始执行）插入人的判断。一次性审批 + 外部化方案文档；teammate 走 mailbox 异步审批。同一退出函数用 `isTeammate()` 分支统一同步/异步两条路径。

- **外部化状态模式**：把中间产物（PLAN.md 等）写到文件，Agent 通过工具读写，不在上下文中堆积。核心是"位置透明"——人/Agent/验证工具三方解耦，各自独立访问同一份事实。

- **状态机分层模式**：`prePlanMode` 字段记录进入前的模式，让 `ExitPlanModeV2Tool` 决定恢复目标；与 `autoModeStateModule` 双轨并行，互相校验防 stale。这是分布式系统"双轨校验"手法在单进程内的应用。

- **断路器降级模式**：外部依赖（auto mode gate）不可用时，降级到安全默认（`default` mode）并通知用户，而非静默失败或崩溃。可迁移到任何"依赖可能失效"的恢复路径。

- **可观察约束模式**：对 LLM 的约束用 deny 规则（产生明确错误信号）而非工具移除（产生模糊的"工具消失"），让 LLM 能自我修正、让调试有据可查。核心哲学：约束应当可观察，不应隐形。

