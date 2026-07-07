# 权限与安全模型

> **本章目标**：理解 Claude Code 权限系统的完整设计——它如何通过多层防御机制保护用户系统，如何在"完全信任"和"零信任"之间提供细粒度控制，以及规则引擎、模式切换、自动分类器、沙箱这些核心组件如何协同工作。
>
> **读完本章你应该能回答**：
> - 权限检查为什么必须放在工具执行前最后一道关卡？
> - deny / ask / allow 规则为什么按这个特定顺序评估？
> - bypassPermissions 模式真的"完全跳过"权限检查吗？什么情况下它仍会被拦截？
> - auto mode 的 LLM 分类器是什么？什么场景触发它？失败时如何降级？
> - 复合命令（如 `git status && rm -rf /`）为什么需要逐子命令检查？
> - `Bash(*)` 与 `Bash(git commit:*)` 在语义和安全性上有什么本质区别？
>
> **配套阅读**：[05-tool-execution-pipeline](cc-05-tool-execution-pipeline.md) §4.3 调用本章的 `hasPermissionsToUseTool`；[12-hook-interception](cc-12-hook-interception.md) 详解 PreToolUse Hook（权限检查的上游）；[13-human-in-the-loop](cc-13-human-in-the-loop.md) 详解 HITL 审批 UI 与 headless 降级。

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 权限系统要解决的核心问题 | 必读，建立问题意识 |
| 二 | 权限检查在架构中的位置与上下游 | 必读，建立全局坐标 |
| 三 | 权限系统的完整样貌：6 层防御全景 + 规则来源 + 模式光谱 + 规则语法 | 必读，建立完整心智模型 |
| 四 | 核心运行机制：两层评估流程 + 复合命令检查 + Auto 分类器 + 危险模式 strip + 沙箱 | **核心章节**，深入运行时细节 |
| 五 | 设计决策与权衡 | 理解为什么这样设计 |
| 六 | 边界与局限 | 了解当前实现的不足 |
| 七 | 可复用的模式 | 提炼可迁移的设计模式 |

---

## 一、它在解决什么问题

Agent 有了工具就有了破坏力——它可以删文件、发网络请求、执行任意命令。LLM 的不可预测性意味着即使是一个"想帮忙"的 Agent，也可能因为理解偏差、prompt 注入、或模型幻觉执行危险操作。在工具执行管线中（详见 [05-tool-execution-pipeline](cc-05-tool-execution-pipeline.md)），权限检查位于 PreToolUse Hook 之后、`tool.call()` 之前，是 Act 阶段的最后一道防线。

权限系统要回答四个核心问题：

1. **Agent 能做什么？** 通过 `allow` 规则白名单显式授权某些操作（如 `Bash(npm test:*)`）。
2. **Agent 不能做什么？** 通过 `deny` 规则黑名单明确禁止某些操作（如 `Bash(rm -rf:*)`）。
3. **边界画在哪？** 通过模式（`bypassPermissions` / `default` / `plan` 等）控制整体严格程度，通过细粒度规则控制具体操作。
4. **谁来画？** 通过规则源的优先级（policySettings > flagSettings > userSettings > projectSettings > localSettings）决定配置的权威性。

这四个问题对应权限系统的四个侧面——**规则语义（allow/ask/deny 怎么写）、规则来源（谁的规则算数）、模式切换（整体严格度怎么调）、评估流程（一次 tool_use 如何被判定）**。本章后续正是沿这条主线展开：第二章定位它在架构中的位置，第三章从宏观看清这四个侧面组成的完整样貌，第四章深入评估流程的运行时细节。

---

## 二、它放在架构的哪个位置

权限检查是工具管线的核心环节。决策函数 `hasPermissionsToUseTool` 在 `src/utils/permissions/permissions.ts:473`，但实际逻辑分为两层：内层 `hasPermissionsToUseToolInner`（`:1179`）处理 deny/ask/allow 规则与 mode 分支，外层包装处理 auto mode 分类器与 dontAsk 模式。其上游是 Hook 系统（PreToolUse → 权限），下游是工具的 `tool.call()`。

理解这两层的拆分很关键：内层是"纯规则引擎"，负责确定性判断（规则匹配、模式分支）；外层是"智能增强层"，负责 LLM 分类器和环境适配（headless agent 降级、auto mode 切换）。这种拆分让规则评估的核心逻辑保持纯净，所有"非确定性决策"都集中在外层——这是全文最重要的一个设计骨架，第四章会沿这条内外层分界展开。

定位清楚后，下一章从宏观看清权限系统的完整样貌。

---

## 三、权限系统的完整样貌

前两章回答了"为什么需要权限系统"和"它在架构中的位置"。但要建立完整的心智模型，还需从宏观看清这个系统由哪些部分组成、各部分如何衔接。

权限系统本质上是一条流水线：**规则先要被配置（规则源）→ 决定整体严格度（权限模式）→ 表达成可匹配的语法（allow/ask/deny）→ 在 tool_use 到达时逐层评估（6 层防御）**。本章先给一张端到端全景图，再依次展开静态结构的三个侧面——规则来源回答"谁的规则算数"、权限模式回答"整体多严格"、规则语法回答"规则怎么写"。运行时的逐层评估细节留到第四章。

### 3.1 端到端全景：6 层防御 + 配置链路

```
┌─────────────────────────────────────────────────────────────────────┐
│                        静态层（系统配置时）                          │
│                                                                     │
│  规则源 (8 个，反向优先级)                                           │
│    policySettings > flagSettings > command > userSettings            │
│    > projectSettings > localSettings > cliArg > session              │
│         │  合并为 toolPermissionContext                              │
│         ▼                                                           │
│  权限模式 (7 种，控制整体严格度)                                     │
│    default / acceptEdits / plan / bypassPermissions                 │
│    / dontAsk / auto / bubble                                        │
│         │  规则语法 allow / ask / deny                               │
│         ▼                                                           │
│  settings.json 规则集 → 注入 toolPermissionContext                   │
└─────────────────────────────────────────────────────────────────────┘
                              │  LLM 输出 tool_use
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    运行时层（每次 tool_use）                         │
│                                                                     │
│  hasPermissionsToUseTool (外层 :473) ── 智能增强层                   │
│         │                                                           │
│         ▼                                                           │
│  hasPermissionsToUseToolInner (内层 :1179) ── 纯规则引擎             │
│    Layer 0: Managed Policy (托管策略，不可覆盖)                      │
│    Layer 1: deny > ask > allow 规则引擎                              │
│    Layer 2: tool.checkPermissions (含 subcommand 安全检查)           │
│    Layer 3: Mode 分支 (bypass / allow / 退化到 ask)                  │
│         │  ask 命中时外层接管增强                                    │
│         ▼                                                           │
│  Layer 4: Auto Mode Classifier (LLM 语义判断)                       │
│    ├─ acceptEdits fast-path（连宽松模式都不许 → 必危险）             │
│    ├─ safe-tool allowlist（只读工具硬编码放行）                      │
│    └─ classifyYoloAction（Haiku 小模型判定）                         │
│         │                                                           │
│         ▼                                                           │
│  Layer 5: HITL 审批 (UI 弹窗 / headless 降级 deny)                  │
│         │                                                           │
│         ▼                                                           │
│  behavior: allow / deny / ask → tool.call() 或拒绝                  │
└─────────────────────────────────────────────────────────────────────┘
```

这张图把全文脉络一次画清：上半部是**静态层**（配置时把规则源、模式、语法合并成 `toolPermissionContext`），下半部是**运行时层**（每次 tool_use 走 6 层防御再产出 allow/deny/ask）。本章 §3.2–§3.4 展开静态层的三个侧面，第四章展开运行时层的逐层评估。

#### 为什么是 6 层而不是 1 层

这张图最显眼的结构是 6 层防御（Layer 0–5）。**关键设计原则是 deny 优先于一切**——即使 bypassPermissions 模式，deny 规则、ask 规则、safety check 仍会强制执行。这种设计的本质是把"安全例外"写在最严格的层：用户可以放宽权限（bypass），但不能通过白名单绕过黑名单。

为什么是 6 层而不是 1 层？因为没有任何单一机制能解决所有安全问题：

- **纯规则引擎**（Layer 1）无法理解语义——"这个 curl 命令是访问内部 API 还是外网？"规则只能匹配字符串，判断不了意图。
- **纯 LLM 分类器**（Layer 4）不可靠——LLM 可能漏报，被 prompt 注入欺骗。
- **纯人工审批**（Layer 5）体验差——每次操作都要点确认，Agent 的自主性归零。
- **多层叠加** = 每层独立、层层兜底，单层被绕过不影响其他层。规则引擎兜住确定的危险，分类器兜住语义模糊的灰色地带，人工兜住分类器的不确定性。

### 3.2 规则来源与优先级：8 个源的反向优先级

权限系统需要回答"规则从哪里来、谁的规则优先级更高"。

`SETTING_SOURCES`（`src/utils/settings/constants.ts:7-22`）定义 5 个规则源，加上 3 个非持久化源：

```typescript
// src/utils/settings/constants.ts:7-22
export const SETTING_SOURCES = [
  'userSettings',      // ~/.claude/settings.json — 用户全局
  'projectSettings',   // .claude/settings.json — 项目共享（committed）
  'localSettings',     // .claude/settings.local.json — 项目本地（gitignored）
  'flagSettings',      // --settings <file>
  'policySettings',    // /etc/claude-code/managed-settings.json — 企业托管
] as const

// src/utils/permissions/permissions.ts:109-114 — 完整规则源
const PERMISSION_RULE_SOURCES = [
  ...SETTING_SOURCES,
  'cliArg',            // --allowed-tools / --disallowed-tools
  'command',           // 命令注入（slash command）
  'session',           // /add-dir、shift-tab 等会话内行为
]
```

这 8 个源的优先级是**反向的——从上到下优先级递减**。policySettings 最高（企业管理员锁定），session 最低（仅当前会话有效）。当多个源定义了冲突的规则时，更高优先级的源胜出。

#### 优先级与可编辑性

| 源 | 持久化 | 用户可编辑 | 用途 |
|----|--------|-----------|------|
| `policySettings` | 系统 | 否（只读） | 企业托管策略，最高优先级 |
| `flagSettings` | CLI flag | 否（只读） | CI/CD 临时覆盖 |
| `command` | 命令注入 | 否（只读） | slash command 临时规则 |
| `userSettings` | `~/.claude/settings.json` | 是 | 用户全局偏好 |
| `projectSettings` | `<project>/.claude/settings.json` | 是 | 项目共享规则（committed） |
| `localSettings` | `<project>/.claude/settings.local.json` | 是 | 项目本地规则（gitignored） |
| `cliArg` | 否 | n/a | 进程级临时规则 |
| `session` | 否 | n/a | 当前 session 临时规则 |

注意"用户可编辑"列——policySettings、flagSettings、command 都是只读的。这意味着即使你有 sudo 权限运行时，也修改不了 policySettings（它在 `/etc/claude-code/` 下，企业管理员可以物理锁定）。这种设计让企业可以在员工机器上部署"无论用户怎么配置都无法绕过"的强制策略。

#### Managed Policy：管理员的"核弹级"开关

`policySettings` 中的四个字段可全局锁定：

```typescript
// src/utils/permissions/permissionsLoader.ts:31-36
export function shouldAllowManagedPermissionRulesOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.allowManagedPermissionRulesOnly === true
  )
}
```

- `allowManagedPermissionRulesOnly: true`：只尊重 managed rules，忽略所有 user/project/local
- `disableAllHooks: true`：禁用所有 hook（包括 PreToolUse）
- `disableBypassPermissionsMode: 'disable'`：禁用 bypass 模式
- `disableAutoMode: 'disable'`：禁用 auto 模式

这四个开关是"核弹级"配置——一旦启用，用户侧的配置完全失效。这是企业场景下管理员的"最终武器"：当合规要求"不允许任何 AI 绕过审计"时，禁用 bypass + 禁用 auto + 只允许 managed rules 三连，所有操作都进入 HITL 审批。

规则来源回答了"谁的规则算数"。但同一批规则，在不同模式下严格度不同——下一节看权限模式如何控制整体行为。

### 3.3 权限模式光谱：7 种模式的严格度梯度

权限模式（PermissionMode）控制权限系统的整体严格程度，是从"完全信任"到"完全隔离"的连续光谱。

```typescript
// src/types/permissions.ts — 通过 src/utils/permissions/PermissionMode.ts 导出
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto', 'bubble']
```

| 模式 | 行为 | 适用场景 | 风险等级 |
|------|------|---------|---------|
| `default` | deny 优先，无匹配则 ASK | 日常开发 | 低 |
| `acceptEdits` | 自动接受文件编辑（FileEdit/Write 等） | 信任 Agent 做小改动 | 中 |
| `plan` | 锁定写工具（只读 + Plan 工具） | 方案设计阶段 | 低 |
| `bypassPermissions` | 跳过除 deny/ask/safetyCheck 外的所有检查 | 完全信任 / 自动化 | 极高 |
| `dontAsk` | 无匹配规则时自动 DENY | CI/CD / 非交互模式 | 低 |
| `auto` | 分类器自动判断（auto mode 专用） | 半自动化 | 中 |
| `bubble` | 沙箱内执行（受限 bypass） | 隔离测试 | 中 |

这 7 种模式覆盖了完整光谱。`bypassPermissions` 是最危险的（跳过所有规则），`dontAsk` 是最安全的（无规则就 deny）——注意"最安全"的反而是"无规则即拒绝"，因为它的默认动作是保守的。

#### 模式切换优先级（CLI）

```typescript
// src/utils/permissions/permissionSetup.ts:689-811 — initialPermissionModeFromCLI
const orderedModes = []
if (dangerouslySkipPermissions) orderedModes.push('bypassPermissions')
if (permissionModeCli) orderedModes.push(parsedMode)
if (settings.permissions?.defaultMode) orderedModes.push(settingsMode)

for (const mode of orderedModes) {
  if (mode === 'bypassPermissions' && disableBypassPermissionsMode) {
    notification = 'Bypass permissions mode was disabled'
    continue
  }
  result = { mode, notification }
  break
}
```

优先级：`--dangerously-skip-permissions` > `--permission-mode` > `settings.permissions.defaultMode` > 'default'。

这个顺序遵循"最显式的覆盖最不显式的"：CLI flag > 配置文件 > 代码默认值。`--dangerously-skip-permissions` 的名字也暗示了它的风险——"dangerously" 是有意为之，提醒用户这是一个有危险的操作。注意 `disableBypassPermissionsMode` 能在企业策略层否决 bypass——即使 CLI 显式传入，managed policy 仍可拦截。

模式切换不只是"换 mode 字段"，还会触发副作用：进 plan 时保存 `prePlanMode` 并 strip dangerous permissions（防止 plan 模式下 Agent 偷偷执行危险操作），出 plan 时恢复；进 auto 时 `setAutoModeActive(true)` + strip，出 auto 时恢复。这保证 mode 转换是有状态的、可逆的（详见 `transitionPermissionMode`，`permissionSetup.ts:597-646`）。

模式控制整体严格度，但具体到"某条规则怎么匹配一个命令"，需要规则语法——下一节展开。

### 3.4 规则语法：allow / ask / deny 的匹配语义

规则语法回答"规则怎么写"。本节偏参考性质，查语法时回来翻。

#### 通配符语义

| 语法 | 匹配 | 不匹配 | 例 |
|------|------|--------|-----|
| `Bash` | 任何 Bash 调用 | — | 工具级 allow |
| `Bash(*)` | 同上（解析为 toolName only） | — | — |
| `Bash(command: *)` | 任何 Bash 命令 | — | 工具级 allow 显式 |
| `Bash(npm test)` | 仅 `npm test` 完全匹配 | `npm test --watch` | 字面精确 |
| `Bash(npm:*)` | 以 `npm` 开头的命令 | — | prefix match |
| `Bash(git commit:*)` | `git commit ...` 系列 | `git push`, `git status` | prefix match |
| `Bash(python *)` | `python script.py` 等 | `python3` 不匹配（字面） | 字符串 wildcard |
| `Read(file_path: "src/**")` | src/ 下任何文件 | — | glob |
| `Write(file_path: "*.md")` | 当前目录 .md | `docs/*.md`（需要完整 glob） | glob |
| `Agent(subagent_type: "Explore")` | 仅 Explore agent | Plan agent | 精确 |
| `mcp__github__*` | github server 所有工具 | 其他 server | MCP server 通配 |

#### prefix vs wildcard：`:*` 和 ` *` 的微妙区别

这是 BashTool 规则里最容易踩坑的地方——`:*` 和 ` *` 语义不同：

```typescript
// packages/builtin-tools/src/tools/BashTool/bashPermissions.ts
export function matchWildcardPattern(pattern: string, command: string): boolean {
  // * 匹配任意字符（含空格）；前缀后跟 * 等价于 startsWith
}
export function permissionRuleExtractPrefix(pattern: string): string | null {
  // 提取 "git commit:*" 中的 "git commit"
}
```

- `Bash(npm:*)` → **prefix match**：以 `npm` 开头的命令（`npm test`、`npm install`、`npm run build` 都匹配）
- `Bash(npm *)` → **wildcard match**：`npm test`（含空格的字面通配，`npm` 后必须有空格）
- `Bash(*)` → 匹配所有命令（包括危险解释器）

`:*` 明确表示"前缀匹配"，` *` 是通配符匹配。在 BashTool 中 `:*` 更常用——大多数用户写 `git commit:*` 而不是 `git commit *`。规则语法对空格敏感，写错会导致规则意外失效或意外匹配。

#### `Bash(*)` 与 `Bash(git commit:*)` 的安全边界

| 规则 | 风险 | 典型场景 |
|------|------|---------|
| `Bash(*)` | 任意代码执行，包括 `rm -rf /` | 不推荐，auto mode 强制 strip |
| `Bash(git commit:*)` | 仅 git commit，可控 | CI/CD 安全 |
| `Bash(python:*)` | 任意 Python 代码——可执行系统调用 | 危险，auto mode 标记 |
| `Bash(curl *)` | 绕过 WebFetch 域名白名单 | 危险 |
| `Bash(npm test:*)` | 仅 npm test | 安全 |
| `Bash(rm -rf:*)` | 删除文件 | 显式危险 |
| `Bash(sudo *)` | 提权 | 危险 |

`Bash(*)` 是"核弹级" allow 规则——它允许任意 Bash 命令。auto mode 会强制 strip 它（防止绕过 LLM 分类器，详见 §4.4）。`Bash(git commit:*)` 是"精确制导"——只允许 git commit 系列命令，足够 CI/CD 使用，但不会让 Agent 执行任意代码。这两者的区别是"能力边界"的核心：好的 allow 规则应该收敛到最小必要能力。

#### settings.json 格式

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(git status:*)",
      "Read(file_path: \"src/**\")",
      "Edit(file_path: \"**/*.ts\")"
    ],
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(curl:*)",
      "Write(file_path: \"~/.ssh/**\")",
      "Edit(file_path: \".git/**\")"
    ],
    "ask": [
      "Bash(npm publish:*)"
    ],
    "defaultMode": "default",
    "additionalDirectories": ["/path/to/extra"],
    "disableBypassPermissionsMode": "disable"
  }
}
```

格式定义见 `src/utils/settings/types.ts` 中的 `PermissionsSchema`。

至此，静态层走完：规则源 → 模式 → 语法 → `toolPermissionContext`，构成了权限系统的配置全景。下一章进入运行时层——当 LLM 真的输出一个 `tool_use` 时，这 6 层防御如何逐层评估。

---

## 四、核心运行机制

第三章给出了权限系统的静态全景——规则如何配置、模式如何切换、语法如何匹配。但权限系统的真正复杂度在运行时：当 LLM 输出一个 `tool_use` 时，系统要在 `tool.call()` 之前的一瞬间完成"6 层防御逐层评估"，而且要区分"确定性规则匹配"和"智能语义判断"，还要处理 bypass/dontAsk/auto 等模式的分支转换。

本章沿一次 `tool_use` 的评估路径展开，逐层剖析运行时机制。每节遵循"为什么需要 → 怎么做 → 实例"的三段式。全文最重要的设计骨架是第二章提到的**内外层拆分**——本章 §4.1 先讲清这条骨架，后续各节都在它之上展开。

### 4.1 两层评估流程：内层规则引擎 + 外层智能增强

权限评估被拆成两层——内层 `hasPermissionsToUseToolInner` 做确定性规则匹配，外层 `hasPermissionsToUseTool` 做智能增强和模式转换。这个拆分不是代码组织上的偶然，而是有明确的设计意图：**把"确定性判断"和"非确定性决策"隔离**。规则匹配是确定性的（同样的规则 + 输入永远产出同样的 allow/deny），LLM 分类器是非确定性的（同样的输入可能产出不同判断）。把它们分到两层，让规则引擎的核心逻辑保持纯净、可单测、可审计，所有"可能出错的智能判断"集中在外层兜底。

#### 内层：纯规则引擎（`hasPermissionsToUseToolInner`）

内层函数（`src/utils/permissions/permissions.ts:1179-1340`）按以下顺序检查：

```typescript
// src/utils/permissions/permissions.ts:1179-1340 — hasPermissionsToUseToolInner（注释版）
async function hasPermissionsToUseToolInner(tool, input, context) {
  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  let appState = context.getAppState()

  // 1a. 整个工具被 deny — 最高优先级
  const denyRule = getDenyRuleForTool(appState.toolPermissionContext, tool)
  if (denyRule) {
    return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule }, ... }
  }

  // 1b. 整个工具被 ask（白名单 ask 规则）
  const askRule = getAskRuleForTool(appState.toolPermissionContext, tool)
  if (askRule) {
    const canSandboxAutoAllow = /* Bash 沙箱自动允许例外 */
    if (!canSandboxAutoAllow) {
      return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule }, ... }
    }
  }

  // 1c. 工具自身的 checkPermissions（含 subcommand 安全检查）
  let toolPermissionResult: PermissionResult = { behavior: 'passthrough', ... }
  try {
    const parsedInput = tool.inputSchema.parse(input)
    toolPermissionResult = await tool.checkPermissions(parsedInput, context)
  } catch (e) { logError(e) }

  // 1d. 工具返回 deny
  if (toolPermissionResult?.behavior === 'deny') return toolPermissionResult

  // 1e. requiresUserInteraction 即使 bypass 也要 ask
  if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask') {
    return toolPermissionResult
  }

  // 1f. 内容级 ask 规则（来自 checkPermissions）—— 即使 bypass 也遵守
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'rule'
      && toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask') {
    return toolPermissionResult
  }

  // 1g. safetyCheck（敏感路径 .git/, .claude/, .vscode/）—— 即使 bypass 也遵守
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'safetyCheck') {
    return toolPermissionResult
  }

  // 2a. Bypass 模式 — 跳过剩余检查
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan'
      && appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  if (shouldBypassPermissions) {
    return { behavior: 'allow', ... }
  }

  // 2b. 整个工具被 allow（白名单）
  const alwaysAllowedRule = toolAlwaysAllowedRule(appState.toolPermissionContext, tool)
  if (alwaysAllowedRule) {
    return { behavior: 'allow', ... }
  }

  // 3. passthrough → ask
  return toolPermissionResult.behavior === 'passthrough'
    ? { ...toolPermissionResult, behavior: 'ask' as const, ... }
    : toolPermissionResult
}
```

这段代码的检查顺序不是随机排列，而是遵循"**越危险的检查越靠前**"的原则。逐步解读为什么是这个顺序：

1. **deny 规则最先查**（1a）。deny 是"绝对禁止"，优先级必须最高。即使后续有 allow 规则匹配，也应该被 deny 覆盖——否则用户可以用 `Bash(git status:*)` 的 allow 来"掩护" `Bash(rm -rf:*)` 的 deny，安全策略就被白名单绕过了。

2. **ask 规则次先查**（1b）。ask 是"必须人工确认"，即使后续有 allow 规则，也应该让用户审核——因为用户显式标记 ask 是有意为之（"这个操作我想亲自看一眼"）。

3. **checkPermissions 在 ask 之后**（1c-1g）。工具自身的检查（如 BashTool 的命令拆分、敏感路径检测）会触发 ask，但 ask 的优先级仍高于 bypass——这就是为什么 1f 和 1g 即使在 bypass 模式也要强制 ask。

4. **bypass 模式在所有 ask 检查之后**（2a）。bypass 只能跳过那些"没有显式标记为 ask/deny"的检查。如果一个操作被显式 ask，bypass 也无法跳过——这是安全保守原则的体现，也是"bypass 并非完全跳过"的关键所在。

5. **allow 最后查**（2b）。allow 是"白名单"，放在最后是因为它只能匹配"没有 deny/ask 拦截的剩余情况"。

这个顺序回答了本章开头的第二个问题：**deny > ask > allow 不是特异性优先，而是危险度优先**。特异性优先（更具体的规则优先）会让 `Bash(git status:*)` 这种具体 allow 压过 `Bash(rm:*)` 这种通用 deny——但万一某条具体规则写错了，危险操作就溜过去了。危险度优先则保证：不管规则多具体，deny 永远压过 allow。

#### 外层：智能增强（`hasPermissionsToUseTool`）

内层决定了 allow/deny/ask 后，外层函数（`:473-977`）对 `ask` 结果做"增强"——根据当前模式和环境决定 ask 的最终命运：

```typescript
// src/utils/permissions/permissions.ts:473-500 — 外层核心
export const hasPermissionsToUseTool = async (tool, input, context, ...) => {
  const result = await hasPermissionsToUseToolInner(tool, input, context)

  // allow 命中时：重置连续拒绝计数
  if (result.behavior === 'allow') {
    // auto mode 下连续成功后重置拒绝计数
    return result
  }

  // ask 命中时：模式转换
  if (result.behavior === 'ask') {
    const appState = context.getAppState()

    // dontAsk 模式：ask → deny
    if (appState.toolPermissionContext.mode === 'dontAsk') {
      return { behavior: 'deny', message: DONT_ASK_REJECT_MESSAGE(tool.name), ... }
    }

    // auto 模式：ask → classifier（详见 §4.3）
    if (feature('TRANSCRIPT_CLASSIFIER') && (
      appState.toolPermissionContext.mode === 'auto' ||
      (appState.toolPermissionContext.mode === 'plan' && isAutoModeActive())
    )) {
      // 安全检查不可绕过 classifier（除非 classifierApprovable）
      // 1. acceptEdits fast-path → skip classifier
      // 2. safe-tool allowlist → skip classifier
      // 3. classifyYoloAction() → allow/deny
      // 4. classifier 不可用 → gate 决定 fail-open/fail-closed
      // 5. transcript 太长 → 回退到 ask
    }

    // Headless agent: 没 UI → runPermissionRequestHooks → fail to deny
    if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
      const hookDecision = await runPermissionRequestHooksForHeadlessAgent(...)
      if (hookDecision) return hookDecision
      return { behavior: 'deny', message: AUTO_REJECT_MESSAGE(tool.name), ... }
    }
  }

  return result
}
```

外层对 `ask` 的三种转换，每种都对应一个真实场景：

- **allow 直接返回**：内层已经决定了 allow，外层只是"重置计数器"（auto mode 下连续成功多少次后降低警惕）。
- **ask 在 dontAsk 模式下变 deny**：这是 CI/CD 场景的设计——没有 UI 让用户审批，所以 ask 必须自动转为 deny。宁可拒绝太多，也不能在无人环境下弹一个永远没人点的弹窗。
- **ask 在 auto 模式下走 classifier**：auto mode 下，ask 不是让人审批，而是让 LLM 分类器自动判断（§4.3 详述）。
- **ask 在 headless agent 下 fallback 到 deny**：没有 UI、classifier 失败、hook 没返回决策——三重兜底全部降级到 deny。

注意一个反直觉的点：**外层只对 `ask` 做转换，不对 `allow`/`deny` 做**。allow 和 deny 是"确定的终态"——内层说 allow 就 allow，说 deny 就 deny，外层不改判。只有 ask 是"待决策态"，外层才根据环境决定它的命运。这保证了确定性判断（内层）不被非确定性逻辑（外层）反向污染。

### 4.2 BashTool 复合命令检查：逐子命令拆分

BashTool 是 `checkPermissions` 最复杂的实现——它不能像其他工具那样整体匹配，必须拆分复合命令、检查每个子命令。

```typescript
// packages/builtin-tools/src/tools/BashTool/BashTool.tsx:666-668
async checkPermissions(input, context): Promise<PermissionResult> {
  return bashToolHasPermission(input, context)
}
```

`bashToolHasPermission`（`bashPermissions.ts`）做五件事：

1. 解析命令（`splitCommandWithOperators`、`parseForSecurity`）——把 `git status && rm -rf /` 拆成 `["git status", "rm -rf /"]`。
2. 对每个子命令查 allow/ask/deny 规则（prefix match、wildcard match）。
3. 复合命令中**任一**子命令被 deny → 整体 deny。
4. **任一**子命令需要 ask → 整体 ask（附 `subcommandResults` decisionReason）。
5. 全部 allow → 整体 allow。

#### 为什么必须逐子命令检查

因为 `&&` / `||` / `;` 等操作符可以把危险命令"隐藏"在无害前缀后面。例如 `git status && rm -rf /` 如果整体检查，"git status" 看起来无害；但逐子命令检查时，`rm -rf /` 会立刻被 deny 规则拦截。这是处理"看似无害 + 实际危险"组合的关键防御。

这也是为什么 `Bash(git commit:*)` 能精确匹配 `git commit -m "x"`——`permissionRuleExtractPrefix` 提取 `git commit`，子命令匹配 prefix。整体匹配做不到这种粒度：`Bash(git commit:*)` 如果按整体字符串匹配，`git commit -m "x" && curl evil.com` 也会被误判为"以 git commit 开头"而放行。逐子命令拆分后，`curl evil.com` 会单独接受规则评估，被 deny 规则拦下。

### 4.3 Auto Mode Classifier：LLM 分类器的三层快速路径与失败模式

理解了内层规则评估后，本节专门展开 auto mode 下的 LLM 分类器——这是权限系统最"智能"也最容易出问题的部分，也是 §3.1 全景图中 Layer 4 的具体实现。

#### 何时运行

仅当 `mode === 'auto'` 或 `mode === 'plan'` 且 `isAutoModeActive()` 时触发。普通 default/acceptEdits/plan 模式不调用分类器。

为什么只在 auto mode 触发？因为 default/plan 模式下，系统对"未匹配规则的操作"直接让人审批（ask），不需要 LLM 判断。auto mode 的设计目标是"尽量减少人工介入"，所以才引入 LLM 分类器。但 LLM 调用有延迟和成本，不能滥用——所以只在 auto mode 这一个"明确想自动化"的场景启用。

#### 三层快速路径：能快速判断的不要走 LLM

```typescript
// src/utils/permissions/permissions.ts:598-686 — auto mode 快速路径

// 1. acceptEdits fast-path
if (tool.name !== AGENT_TOOL_NAME && tool.name !== REPL_TOOL_NAME) {
  // 临时切到 acceptEdits 模式看工具是否自动允许
  const acceptEditsResult = await tool.checkPermissions(parsedInput, {
    ...context,
    getAppState: () => ({ ..., toolPermissionContext: { ..., mode: 'acceptEdits' } })
  })
  if (acceptEditsResult.behavior === 'allow') {
    return { behavior: 'allow', decisionReason: { type: 'mode', mode: 'auto' } }
  }
}

// 2. safe-tool allowlist
if (classifierDecisionModule!.isAutoModeAllowlistedTool(tool.name)) {
  return { behavior: 'allow', decisionReason: { type: 'mode', mode: 'auto' } }
}

// 3. 真正调用 classifier
const action = formatActionForClassifier(tool.name, input)
classifierResult = await classifyYoloAction(
  context.messages, action, context.options.tools,
  appState.toolPermissionContext, context.abortController.signal, ...
)
```

这三层快速路径的设计哲学是"**能快速判断的不要走 LLM**"：

- **第一层（acceptEdits fast-path）**：临时把 mode 切到 `acceptEdits`，看工具在那个模式下是否自动允许。acceptEdits 比 default 更宽松（自动接受文件编辑），所以如果连 acceptEdits 都不允许的操作，肯定不安全——反过来，连宽松模式都允许的操作，auto mode 没理由再拦。
- **第二层（safe-tool allowlist）**：只读工具（FileRead、Grep、Glob）有硬编码的安全列表，匹配就直接 allow。这些工具的副作用极小（只读），不需要 LLM 判断。
- **第三层（真正调用 classifier）**：只有前两层都不匹配时，才调用 LLM 分类器。这一层成本最高（LLM 调用延迟 + token 消耗），所以是最后手段。

#### 分类器模型与决策

```typescript
// src/utils/permissions/yoloClassifier.ts — classifyYoloAction
// 调用独立 LLM（通常是 Haiku 级别），输入:
//   - system prompt: 安全规则 + 危险模式清单
//   - 历史 messages: 让分类器理解上下文
//   - 当前 action: 如 "Bash(rm -rf /tmp/foo:*)"
// 输出: { shouldBlock: boolean, reason: string, model, usage, ... }
```

分类器使用独立的小模型（Haiku 级别）而不是主对话模型。三个原因：(1) 成本低（Haiku 比 Sonnet/Opus 便宜）；(2) 速度快（小模型响应快，不拖慢工具执行）；(3) 隔离（分类器被 prompt 注入攻击时，主对话不受影响——攻击者即使骗过了分类器，也只能影响这一个工具调用的审批，不能劫持整个对话）。

#### 失败模式：fail-closed 与拒绝计数

| 情况 | 行为 |
|------|------|
| `shouldBlock = true` | DENY + reason；记录连续拒绝次数 |
| `classifierResult.unavailable` | 看 `tengu_iron_gate_closed` gate：fail-closed → DENY；fail-open → 回退到 ask |
| `transcriptTooLong` | 回退到 ask（永久条件不重试） |
| 连续拒绝达上限 | 触发 `handleDenialLimitExceeded` → 回退到 ask 让用户审核 |

注意 **fail-closed vs fail-open** 的区别：默认是 fail-closed（分类器不可用 → DENY），这是安全保守的——宁可拒绝太多让用户烦，也不能放过危险操作。fail-open 是可配置的安全逃生门（`tengu_iron_gate_closed` gate 控制），但默认不开启。

为什么需要"连续拒绝计数"（`denialTracking.ts` 的 `DenialTrackingState`）？因为 LLM 分类器有误报率——连续拒绝可能是误报累积，也可能是 Agent 真的在做危险操作。系统无法区分这两种情况，所以用"达到上限就让人审批"的兜底策略：给分类器一定的容错空间（避免一次误报就打断），但不允许它无限拒绝（防 Agent 跑偏）。这是"信任但有核实"的工程化体现。

### 4.4 危险模式清单与 auto mode 强制 strip

auto mode 引入 LLM 分类器是为了智能判断，但有些规则"危险到不该让分类器有机会放行"——比如 `Bash(*)` 这种任意代码执行规则。本节讲系统如何识别并强制剥离这些规则。

#### 危险 Bash 模式

```typescript
// permissionSetup.ts:94-147 — isDangerousBashPermission
// 匹配以下模式即为 dangerous（auto mode 中会被强制 strip）：
// - toolName only (Bash, Bash(*)) → 任意代码执行
// - (*) → 通配
// - pattern == 'python' / 'python:*' / 'python*' / 'python *' / 'python -*' → Python 解释器
// - 同样适用于 node, ruby, perl, php, bash, sh, zsh
```

`DANGEROUS_BASH_PATTERNS`（`dangerousPatterns.ts`）定义完整清单，覆盖跨平台代码执行解释器：python/python3、node、ruby、perl、php、bash、sh、zsh、fish，以及 Windows 的 powershell/pwsh/cmd。

为什么 Python/Node/Ruby 等解释器是 dangerous？因为它们可以执行任意代码——`python -c "import os; os.system('rm -rf /')"` 看起来是"调用 Python"，实际上是"任意代码执行"。auto mode 必须禁止这种规则，因为一旦放行就等于打开了后门——分类器再聪明，也挡不住用户自己写的 allow 规则直接放行解释器。

#### 危险 PowerShell 模式

```typescript
// permissionSetup.ts:157-233 — isDangerousPowerShellPermission
// - toolName only → 任意 PowerShell
// - iex, invoke-expression → 字符串求值
// - icm, invoke-command → 远程命令
// - start-process, saps, start → 进程启动
// - new-pssession, enter-pssession → 远程 session
// - add-type → .NET 类型（可 P/Invoke）
// - new-object → COM 对象（可执行）
```

PowerShell 的危险模式更复杂——除了解释器本身，还有 `Invoke-Expression`（字符串求值）、`Invoke-Command`（远程命令执行）、`Add-Type`（.NET P/Invoke 可以调用原生 API）等。这些都是攻击者常用的横向移动工具。

#### 危险 Agent 模式

```typescript
// permissionSetup.ts:240-245 — isDangerousTaskPermission
export function isDangerousTaskPermission(toolName, _ruleContent) {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}
// 任何 Agent allow 规则都是 dangerous——会绕过子 agent 的 prompt 审查
```

为什么 Agent 规则都是 dangerous？因为子 Agent 会 fork 出独立上下文，绕过父 Agent 的 prompt 审查。如果允许 `Agent(*)`，攻击者可以让 Agent 调起"行为不检"的子 Agent——分类器只看到"派生一个子 agent"这个无害动作，看不到子 agent 内部会做什么。

#### auto mode 的强制清理：strip + restore

```typescript
// permissionSetup.ts:510-553 — stripDangerousPermissionsForAutoMode
export function stripDangerousPermissionsForAutoMode(context) {
  const rules = /* 从 alwaysAllowRules 解析所有 rule */
  const dangerousPermissions = findDangerousClassifierPermissions(rules, [])
  if (dangerousPermissions.length === 0) return context
  return {
    ...removeDangerousPermissions(context, dangerousPermissions),
    strippedDangerousRules: stripped,   // 记录到 stash
  }
}
```

进入 auto mode 时自动 strip 这些规则，退出时 `restoreDangerousPermissions` 恢复。这种"strip + restore"模式保证 auto mode 是一个"受限 sandbox"——危险规则临时失效，但用户原有配置不被永久修改。如果直接删除而不是 stash，用户退出 auto mode 后会发现自己的 allow 规则丢了，这是不可接受的。

#### 危险命令参考清单

下表汇总常见危险规则及其风险，查阅时参考：

| 模式 | 风险 | 为什么危险 |
|------|------|-----------|
| `Bash(command: *)` | 任意代码执行 | 可执行任何命令 |
| `Bash(command: "python *")` | 任意 Python 代码 | 解释器可执行任意代码 |
| `Bash(command: "curl *")` | 绕过网络控制 | 直接网络访问，绕过 WebFetch 域名白名单 |
| `Bash(command: "sudo *")` | 提权 | 绕过操作系统权限 |
| `Bash(command: "chmod *")` | 修改文件权限 | 可能使敏感文件可读 |
| `Write(file_path: "~/.ssh/**")` | SSH key 覆盖 | 可能破坏 SSH 认证 |
| `Edit(file_path: ".git/**")` | Git 仓库破坏 | 可能损坏版本历史 |
| `Edit(file_path: ".claude/**")` | 配置覆盖 | 可能改写权限规则 |
| `Edit(file_path: ".vscode/**")` | 编辑器配置 | 可能影响工作流 |
| `Bash(command: "npm publish:*")` | 误发布 | 不可逆外部副作用 |

后三条（`.git/`、`.claude/`、`.vscode/`）由 `checkPathSafetyForAutoEdit` 标记为 `safetyCheck`，即使在 bypass 模式也强制 ask。这三个目录的修改太危险——`.git/` 损坏版本历史、`.claude/` 改写权限规则（攻击者可借此打开后门）、`.vscode/` 影响编辑器行为。这是 §4.1 内层 1g 步"safetyCheck 即使 bypass 也遵守"的具体来源。

### 4.5 沙箱机制：文件系统 / 网络 / 凭证三重边界

权限系统主要靠"规则匹配"做软隔离，沙箱机制则靠"系统级隔离"提供硬保护。规则可以被绕过（写错规则、规则冲突），沙箱不能——它是操作系统层面的强制隔离。

#### 文件系统边界

```typescript
// src/utils/permissions/permissions.ts:129 — ToolPermissionContext
export type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  // ...
}
```

- `additionalWorkingDirectories` 存储通过 `--add-dir` 添加的额外允许目录
- `validateDirectoryForWorkspace`（`commands/add-dir/validation.ts`）在初始化时校验每个目录
- `--no-sandbox` 移除所有目录限制（CLI flag）

#### 沙箱执行（Bash）

```typescript
// packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts
export function shouldUseSandbox(input: BashToolInput): boolean {
  // 检查命令是否在 sandbox 黑名单（如某些网络命令）
  // 检查 dangerouslyDisableSandbox 选项
  // 检查 autoAllowBashIfSandboxed 设置
}
```

启用后，Bash 命令在 macOS seatbelt 或 Linux bubblewrap 中执行，提供文件系统隔离——即使命令想越界写工作目录之外的文件，也会被操作系统拒绝。

#### 网络边界

- `WebFetch` / `WebSearch` 通过 permission 规则控制域名白名单
- `Bash(curl:*)` 绕过——所以是 dangerous
- 没有 socket 层隔离

注意：网络边界目前**只通过规则控制，没有 socket 层隔离**。这意味着如果用户写了 `Bash(curl:*)` 的 allow 规则，Agent 可以直接发起任意网络请求——绕过 WebFetch 的域名白名单。这是当前实现的局限（§六 详述），也是 `Bash(curl:*)` 被标记为 dangerous 的原因之一。

#### 凭证保护

环境变量中的敏感值（`API_KEY`、`TOKEN`、`SECRET` 等）在 Bash 工具执行前被过滤（BashTool 内部逻辑），避免 LLM 直接 echo 泄露。

为什么需要在 BashTool 层做凭证过滤？因为 LLM 可能生成 `echo $API_KEY` 或 `env | grep TOKEN` 这类命令直接读取敏感环境变量。如果不过滤，命令的 stdout 会被 `tool_result` 注入回 LLM 上下文——凭证就进了对话历史，可能被 prompt 注入攻击者读取。BashTool 在执行前过滤敏感值，从源头堵住这条泄漏路径。

至此，运行时层的五个机制讲完：两层评估流程（§4.1）→ 复合命令检查（§4.2）→ Auto 分类器（§4.3）→ 危险模式 strip（§4.4）→ 沙箱隔离（§4.5）。它们共同把一次 `tool_use` 转化为一个安全的 allow/deny/ask 决策。最后三章退一步，看设计权衡、边界局限和可复用模式。

---

## 五、设计决策与权衡

回顾前四章，权限系统在每个分叉点都做了明确选择。下表汇总这些决策点——选择了什么、放弃了什么、为什么。

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 规则评估顺序 | deny > ask > allow | 特异性优先（更具体的规则优先） | deny 优先更安全——即使有 allow 规则，deny 也能覆盖。安全策略应保守 |
| 内外层拆分 | 内层确定性规则 + 外层智能增强 | 单一评估函数 | 把确定性判断和不确定性决策隔离，规则引擎保持纯净可审计 |
| 权限模式粒度 | 全局模式 + 工具级规则 | 仅全局模式 | 工具级规则提供细粒度控制；全局模式提供快速切换（bypass/dontAsk） |
| 沙箱位置 | 进程级（工作目录限制） | 容器级（Docker/VM） | 进程级足够大多数开发场景；容器级太重，启动延迟高 |
| 自动分类器 | LLM 分类器（auto mode） | 规则引擎 | LLM 分类器能理解语义（如"这个 curl 命令是访问内部 API 还是外网"） |
| 权限规则存储 | settings.json（JSON） | 独立权限文件 | 集中配置，减少文件散落 |
| 复合命令安全 | 子命令级别逐一检查 | 整体命令检查 | `git status && rm -rf /` 应该被 deny（后者），整体 allow 会漏掉 |
| ask 规则优先级 | ask > allow（不允许 allow 覆盖 ask） | ask ≤ allow | 用户显式 ask 是有意为之 |
| safetyCheck | 即使 bypass 也强制 ask | bypass 下忽略 | 敏感路径（.git, .claude, .vscode）的修改太危险 |
| dangerous permission strip | auto mode 强制剥离 | 尊重用户 allow | 防止 `Bash(*)` 绕过分类器 |
| 分类器不可用 | fail-closed（默认） | fail-open | 安全保守——不可用时回退到 ask/deny |
| 危险规则处理 | strip + restore（stash） | 直接删除 | 用户原有配置不被永久修改，退出 auto mode 后恢复 |

这些决策有一条共同主线：**安全策略保守优先**。deny 压过 allow、ask 压过 allow、safetyCheck 压过 bypass、分类器 fail-closed、危险规则强制 strip——每一个"冲突点"都倒向更保守的那一侧。代价是偶尔拒绝太多（用户体验略差），收益是绝不放过危险操作。这对一个能执行任意命令的 Agent 系统是正确的权衡：慢一点总比错好。

---
---

## 六、可复用的模式

本章提炼权限系统可迁移到其他 Agent 系统的设计模式。每条按"问题 → 方案 → 反模式"三段组织。

### 6.1 多层防御模式

**问题**：没有任何单一安全机制能覆盖所有威胁——规则引擎不懂语义、LLM 分类器会漏报、人工审批体验差。

**方案**：Managed Policy → 规则引擎 → checkPermissions → Mode 分支 → 分类器 → HITL，6 层独立叠加。每层兜底的威胁类型不同，单层被绕过不影响其他层。规则引擎兜住确定的危险，分类器兜住语义模糊的灰色地带，人工兜住分类器的不确定性。

**反模式**：把所有安全检查塞进一个"超级函数"——一处逻辑出错就全线崩溃，且无法独立审计每一层。

### 6.2 deny 优先模式

**问题**：allow 规则（白名单）可能写得太宽，意外放行危险操作。

**方案**：黑名单优先于白名单。评估顺序 deny > ask > allow——即使有匹配的 allow 规则，deny 规则仍能覆盖。用户可以放宽权限（bypass），但不能通过白名单绕过黑名单。

**反模式**：特异性优先（更具体的规则优先）——会让具体 allow 压过通用 deny，一旦具体规则写错，危险操作就溜过去。

### 6.3 确定性 / 非确定性分离模式

**问题**：规则匹配是确定性的（可单测、可审计），LLM 判断是非确定性的（可能出错）。混在一起会让规则引擎的纯度被污染。

**方案**：拆成内外两层。内层是纯规则引擎，只做确定性判断；外层是智能增强层，处理 LLM 分类器、模式转换、环境降级。外层只对内层的 `ask`（待决策态）做转换，不反向修改 allow/deny（确定态）。

**反模式**：让 LLM 分类器直接修改规则匹配结果——非确定性逻辑污染确定性判断，规则引擎失去可审计性。

### 6.4 危险模式清单 + 强制 strip 模式

**问题**：有些操作危险到不该让任何智能判断有机会放行（如任意代码执行规则 `Bash(*)`）。

**方案**：明确列出不可自动允许的操作（`Bash(*)`、`Bash(curl *)`、`Write(~/.ssh/**)`、`Agent(*)`、解释器类规则等），在 auto mode 中强制 strip。strip 时记到 stash，退出时 restore——临时失效而非永久删除。

**反模式**：尊重用户 allow 规则不做 strip——用户一条 `Bash(*)` allow 就能绕过整个分类器，auto mode 的安全保证形同虚设。

### 6.5 全局模式 + 细粒度规则模式

**问题**：用户既需要"一键切换严格度"（日常 vs CI/CD vs 完全信任），又需要"精确控制某个工具"。

**方案**：两层互补。全局模式（default/plan/bypass/dontAsk/auto）控制整体行为，工具级规则（allow/deny per tool）控制具体操作。模式是粗调旋钮，规则是精调旋钮。

**反模式**：只有全局模式——用户要么全放行要么全审批，无法表达"大多数操作自动但 npm publish 必须审批"这种常见需求。

### 6.6 复合命令拆分检查模式

**问题**：`&&` / `||` / `;` 等操作符可以把危险命令"隐藏"在无害前缀后面（`git status && rm -rf /`）。

**方案**：对 Bash 等可组合命令，按子命令逐一检查，任一 deny 整体 deny。这是处理"看似无害 + 实际危险"组合的关键。

**反模式**：整体命令字符串匹配——`Bash(git commit:*)` 会误放行 `git commit -m "x" && curl evil.com`。

### 6.7 fail-closed 默认模式

**问题**：分类器不可用时该怎么办？放行（fail-open）可能放过危险操作，拒绝（fail-closed）会打扰用户。

**方案**：默认 fail-closed——分类器不可用时回退到 deny/ask，宁可拒绝太多让用户烦，也不能放过危险操作。fail-open 作为可配置的安全逃生门，但默认不开启。

**反模式**：默认 fail-open——分类器一旦抽风（限流、网络问题），所有操作自动放行，安全防线瞬间失效。

### 6.8 strip + restore 模式

**问题**：进入受限模式（auto mode）时需要临时屏蔽某些危险规则，但不能永久修改用户配置。

**方案**：进入时 strip 危险规则到 stash，退出时 restore。会话级隔离，用户原有配置完整保留。

**反模式**：直接删除危险规则——用户退出受限模式后发现自己配置丢了，这是数据丢失。

### 6.9 denial tracking 模式

**问题**：LLM 分类器有误报率，连续拒绝可能是误报累积，也可能是 Agent 真的在跑偏。系统无法区分。

**方案**：连续拒绝计数，超阈值回退到人工审批。给分类器一定容错空间（避免一次误报就打断），但不允许无限拒绝（防 Agent 跑偏）。这是"信任但有核实"的工程化。

**反模式**：无限制信任分类器——一次漏报就是一次事故；或一次拒绝就永久回退——误报会让 auto mode 频繁失效。

理解了这 9 种模式后，读者可以把它们迁移到任何"安全敏感 + 多源配置 + 需要人工兜底"的系统——不限于 Agent 权限。

