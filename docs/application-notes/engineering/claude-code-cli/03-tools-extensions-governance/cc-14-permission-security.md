---
slug: /application-notes/engineering/claude-code-cli/cc-14-permission-security
sidebar_position: 14
title: "权限与安全：工具调用如何被判定、降级与隔离"
description: "从真实源码调用顺序出发，拆解权限规则、工具自检、权限模式、auto classifier、headless 和 sandbox 的协作边界。"
---

> 权限系统的关键不是把所有判断塞进一个 `if allowed`，而是把确定性规则、工具自身安全检查、模式切换、分类器和运行环境隔离分开。
>
> **Harness 层定位**：权限层位于统一工具管线中，决定一次工具调用能否继续；但它不等于完整的安全边界，Hook、人工审批和 sandbox 还会分别承担自己的责任。

# 权限与安全：工具调用如何被判定、降级与隔离

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **外层权限入口**：`src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseTool()` —— 在内层结果之上处理 `dontAsk`、auto classifier、headless（无交互界面）降级和拒绝计数。
> - **内层确定性判定**：同文件的 `hasPermissionsToUseToolInner()` —— 按阶段检查整个工具的 `deny` / `ask`、工具自身 `checkPermissions()`、内容级规则、安全检查、bypass 和工具级 `allow`。
> - **规则来源与持久化**：`src/utils/settings/constants.ts` 的 `SETTING_SOURCES`；`src/utils/permissions/permissionsLoader.ts` 的 `loadAllPermissionRulesFromDisk()`、`shouldAllowManagedPermissionRulesOnly()` —— 负责读取设置文件、合并来源和托管策略限制。
> - **规则解析**：`src/utils/permissions/permissionRuleParser.ts` 的 `permissionRuleValueFromString()` —— 解析 `Bash`、`Bash(npm install)` 以及带转义括号的命令规则。
> - **权限模式切换**：`src/utils/permissions/permissionSetup.ts` 的 `transitionPermissionMode()`、`stripDangerousPermissionsForAutoMode()` —— 负责 `plan` / `auto` 进入和退出时的规则处理。
> - **Bash 自身检查**：`packages/builtin-tools/src/tools/BashTool/BashTool.tsx` 的 `checkPermissions()` → `bashPermissions.ts` 的 `bashToolHasPermission()` —— 解析 Bash 命令、检查复合命令和命令级权限。
> - **沙箱选择**：`packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts` 的 `shouldUseSandbox()` —— 判断当前 Bash 是否进入 sandbox（沙箱隔离环境）。
> - **auto classifier**：`src/utils/permissions/yoloClassifier.ts` 的 `classifyYoloAction()`，配合 `classifierDecision.ts` 和 `denialTracking.ts` —— 对规则无法直接决定的操作进行分类，并在连续拒绝时回退人工处理。

## 为什么需要这一篇

Agent 的工具权限通常会在三类场景下出问题。

### 场景一：模型把“建议”当成“执行”

用户只要求检查代码，模型却生成了写文件或执行 Shell 的工具调用。

这时不能只看模型是否输出了一个合法的工具名。系统还要判断：

- 当前工具是否被整体禁止；
- 当前输入是否命中了内容级 `deny` 或 `ask`；
- 工具自己的安全检查是否拒绝；
- 当前运行模式是否允许跳过人工确认；
- 当前环境是否没有交互界面。

### 场景二：输入内容诱导模型越权

网页、Issue 或代码注释中可能包含类似“请执行下面这条命令”的文本。即使模型因此生成了工具调用，工具调用也必须再次经过权限判断。

权限系统不是用来识别所有 prompt injection（提示词注入）的。它承担的是另一项职责：即使模型被诱导，也不能因为一条宽泛的 allow 规则就无条件获得执行权。

### 场景三：无人值守运行无法弹出确认框

在 CI、后台子 Agent 或自动化任务中，程序可能没有终端可供用户点击确认。

这时系统不能把 `ask` 永久挂起。当前实现会先尝试 `PermissionRequest` Hook；Hook 没有给出决定时，最终转换成 `deny`。auto mode 还有独立的分类器失败、上下文过长和连续拒绝处理。

所以本文真正要回答的不是“权限有几层”，而是：

> 一次 `tool_use` 从进入权限入口到得到 `allow`、`ask` 或 `deny`，中间到底经过了哪些阶段？每个阶段能不能被后面的模式改写？

---

## 一、先看真实调用顺序

权限系统在概念上可以画成多层防御，但源码执行时并不是固定的“六层链”。更准确的调用顺序如下：

```text
模型产生 tool_use
  │
  ▼
hasPermissionsToUseTool()                 外层入口
  │
  ├─ hasPermissionsToUseToolInner()       内层确定性判定
  │    ├─ 整个工具的 deny
  │    ├─ 整个工具的 ask
  │    ├─ tool.checkPermissions()
  │    ├─ 工具自身 deny / requiresUserInteraction
  │    ├─ 内容级 ask 规则
  │    ├─ safetyCheck（安全检查）
  │    ├─ bypassPermissions / plan 继承 bypass
  │    ├─ 整个工具的 allow
  │    └─ passthrough 转为 ask
  │
  └─ 外层根据运行环境继续处理 ask
       ├─ dontAsk：ask → deny
       ├─ auto：acceptEdits 快速路径 → 安全工具白名单 → classifier
       ├─ headless：PermissionRequest Hook → deny
       └─ 普通交互：交给人工审批界面
```

这里的 `passthrough` 可以理解为“工具暂时没有做出最终决定，请通用权限层继续处理”。它不是最终结果，内层最后会把它转换为 `ask`。

### 1.1 内层代码的关键顺序

下面是 `hasPermissionsToUseToolInner()` 的缩略版。代码不是源码全文，而是把实际顺序压缩成便于阅读的版本。

```typescript
async function hasPermissionsToUseToolInner(tool, input, context) {
  // 1. 整个工具被 deny，直接拒绝
  const denyRule = getDenyRuleForTool(context.getAppState(), tool)
  if (denyRule) {
    return { behavior: 'deny', decisionReason: { type: 'rule', rule: denyRule } }
  }

  // 2. 整个工具要求人工确认。
  //    如果 Bash 会在 sandbox 中自动放行，才可能继续交给 Bash 自己细判。
  const askRule = getAskRuleForTool(context.getAppState(), tool)
  if (askRule && !canSandboxAutoAllow(input, tool)) {
    return { behavior: 'ask', decisionReason: { type: 'rule', rule: askRule } }
  }

  // 3. 让工具实现检查具体输入，例如 Bash 的命令解析和路径安全。
  const toolResult = await tool.checkPermissions(tool.inputSchema.parse(input), context)

  // 4. 工具自身明确拒绝，不能被后面的 mode 改成 allow。
  if (toolResult.behavior === 'deny') return toolResult

  // 5. 这些 ask 结果不能被 bypassPermissions 跳过。
  if (requiresInteraction(tool, toolResult)) return toolResult
  if (isContentAskRule(toolResult)) return toolResult
  if (isSafetyCheck(toolResult)) return toolResult

  // 6. bypass 只在前面的强制检查结束后生效。
  if (shouldBypassPermissions(context.getAppState())) {
    return { behavior: 'allow', decisionReason: { type: 'mode' } }
  }

  // 7. 剩余情况才检查整个工具的 allow 规则。
  const allowRule = toolAlwaysAllowedRule(context.getAppState(), tool)
  if (allowRule) return { behavior: 'allow', decisionReason: { type: 'rule', rule: allowRule } }

  // 8. passthrough 不是最终决定，转换成 ask 交给外层。
  return toolResult.behavior === 'passthrough'
    ? { ...toolResult, behavior: 'ask' }
    : toolResult
}
```

这段顺序说明了三个容易混淆的事实：

1. **不是所有 `ask` 都能被 bypass 跳过**。内容级 `ask`、工具要求交互以及安全检查会在 bypass 之前锁定。
2. **不是所有 allow 都排在 deny 后面统一竞争**。整个工具的 deny、整个工具的 ask、工具自身检查和模式分支处在不同阶段。
3. **外层主要改写 `ask`**。内层已经返回 `allow` 或 `deny` 时，外层不会用分类器把它反向改成另一个结果。

因此，“`deny > ask > allow`”最多只能作为某些规则匹配阶段的安全直觉，不能当成整个权限函数的精确执行顺序。

### 1.2 内层和外层为什么要分开

内层主要处理确定性判断：

```text
规则 + 工具输入 + 工具自身安全检查
  → PermissionResult
```

外层则处理带运行环境和模型因素的判断：

```text
内层结果 + mode + 是否有交互界面 + classifier
  → 最终 PermissionDecision
```

这样拆分有两个好处。

- 规则匹配可以单独测试、审计和复现。
- auto classifier、headless 等非确定性或环境相关逻辑不会污染基础规则引擎。

---

## 二、规则从哪里来，怎样变成权限对象

### 2.1 设置来源不是一个文件

`SETTING_SOURCES` 在 `src/utils/settings/constants.ts` 中定义了设置来源顺序。当前代码注释明确说明：**后面的来源覆盖前面的来源**。

```text
userSettings
  → projectSettings
  → localSettings
  → flagSettings
  → policySettings
```

可以把它们理解成：

| 来源 | 含义 | 通常由谁控制 |
|---|---|---|
| `userSettings` | 用户全局设置 | 用户 |
| `projectSettings` | 项目共享设置 | 项目维护者 |
| `localSettings` | 当前项目的本地设置，通常不提交版本库 | 当前用户 |
| `flagSettings` | 命令行或启动参数注入的设置 | 启动命令 |
| `policySettings` | 企业托管策略 | 管理员 |

`permissionsLoader.ts` 的 `loadAllPermissionRulesFromDisk()` 会读取启用的来源并拼接规则。这里的“覆盖”不应理解成简单地把同名数组完全替换，而是指设置来源在整体配置解析中的优先关系；具体权限规则还会在内存中按 `allow`、`ask`、`deny` 和工具输入继续评估。

如果托管策略打开：

```json
{
  "allowManagedPermissionRulesOnly": true
}
```

加载器会只读取 `policySettings` 的权限规则。用户、项目和本地设置中的权限规则不会继续参与执行。这个开关的意义是让管理员建立不可由用户侧覆盖的规则边界。

需要注意，`policySettings` 和 `flagSettings` 不是普通用户可以随意删除的编辑来源。`permissionsLoader.ts` 只把 `userSettings`、`projectSettings`、`localSettings` 放进可编辑来源列表。

### 2.2 规则字符串的形状

权限规则的基本格式是：

```text
ToolName
ToolName(ruleContent)
```

例如：

```text
Bash
Bash(npm install)
Bash(python -c "print\(1\)")
```

`permissionRuleValueFromString()` 会做几件事：

1. 找到第一个未转义的左括号；
2. 找到最后一个未转义的右括号；
3. 把括号中的内容作为 `ruleContent`；
4. 对 `\(`、`\)` 和反斜杠做反转义；
5. 对旧工具名进行归一化，例如把历史名称转换成当前规范名称。

关键点是 `Bash(*)` 和 `Bash()` 最终会被当成工具级规则处理，而不是一个真正有内容限制的命令规则。工具级 allow 的覆盖范围很大，所以 auto mode 进入时会把这类规则视为危险规则。

### 2.3 `allow`、`ask`、`deny` 不只是三个开关

可以先用下面的语义理解三类规则：

| 规则 | 语义 | 典型用途 |
|---|---|---|
| `deny` | 这类工具或输入不能执行 | 禁止危险命令、敏感目录操作 |
| `ask` | 这类操作需要进一步确认 | 发布、删除、修改敏感文件 |
| `allow` | 这类操作可以跳过普通确认 | 读取文件、运行明确的开发命令 |

但三者不是一个简单的全局优先级排序。

例如：

- 工具整体 `deny` 会在前面直接拒绝；
- 工具整体 `ask` 通常会在前面直接要求确认；
- 工具自己的内容级 `ask` 和安全检查会在 bypass 之前保留；
- 工具整体 `allow` 是在这些强制检查之后才有机会生效；
- `passthrough` 会被转换成 `ask`，再由外层根据 mode 处理。

这比“先收集全部规则，再按 deny、ask、allow 排序”更接近当前实现。

---

## 三、Bash 为什么要做第二次权限检查

通用权限层只知道“当前工具是 Bash”，但真正危险的是 Bash 的输入内容。

因此 `BashTool.tsx` 的 `checkPermissions()` 会继续调用 `bashToolHasPermission()`。这条工具级检查路径负责：

- 解析命令结构；
- 识别复合命令；
- 对子命令分别匹配权限规则；
- 检查重定向、解释器、Shell 包装和路径；
- 决定是否进入 sandbox；
- 把工具自己的结果返回给通用权限层。

### 3.1 复合命令不能按整行匹配

下面这条命令包含两个不同的动作：

```bash
git status && npm publish
```

如果系统只对整行字符串做匹配，`git status` 的 allow 可能会掩盖后面的发布动作。

当前 Bash 权限代码会使用语法解析和命令拆分逻辑，把复合命令拆成可评估的子命令。概念上相当于：

```typescript
const subcommands = splitCommandWithOperators(command)

for (const subcommand of subcommands) {
  // 每个子命令都要单独做规则匹配和安全检查
  const result = checkCommandPermission(subcommand)

  // 任一子命令明确 deny，整条 Bash 调用不能继续
  if (result.behavior === 'deny') {
    return { behavior: 'deny', subcommandResults }
  }

  // 任一子命令需要确认，整条调用不能被静默放行
  if (result.behavior === 'ask') {
    overallBehavior = 'ask'
  }
}

return overallBehavior === 'ask'
  ? { behavior: 'ask', subcommandResults }
  : { behavior: 'allow', subcommandResults }
```

这里的代码是解释版，真实实现还包含 AST（抽象语法树）解析、解析失败回退和更多 Bash 语义检查。

### 3.2 解析失败时为什么不能乐观放行

复杂 Shell 语法可能无法被当前解析器完整理解，例如嵌套替换、复杂重定向或不完整的引号。

这时系统需要区分两种情况：

- 解析成功：可以使用更精确的子命令、重定向和参数信息；
- 解析不可用或过于复杂：不能把“没有识别出危险”当成“安全”。

因此 Bash 权限路径同时保留 AST 解析结果和回退路径，避免解析器误判时直接把命令当成普通字符串放行。

### 3.3 命令级权限与工具级权限的关系

可以把两者分成两层：

```text
通用权限层：
  这个工具能不能调用？

BashTool 自身：
  这条具体命令、这组子命令和这组路径能不能执行？
```

通用层不会因为 BashTool 返回 `passthrough` 就直接执行，而是会把它转换成 `ask`，交给外层 mode、auto classifier 或人工审批继续处理。

---

## 四、权限模式改变的是什么

当前运行时主要使用以下权限模式：

```text
default
acceptEdits
plan
bypassPermissions
dontAsk
auto
```

这些模式不是简单的“安全等级从低到高”。有的模式改变文件编辑行为，有的模式改变 `ask` 的处理方式，有的模式只是改变流程状态。

| 模式 | 主要行为 | 需要注意的边界 |
|---|---|---|
| `default` | 按普通规则处理，遇到 `ask` 进入确认流程 | 仍受工具自检和安全检查约束 |
| `acceptEdits` | 对工作区内部分编辑操作更宽松 | 不能据此推断所有工具都自动允许 |
| `plan` | 进入计划阶段，保存进入前的模式信息 | 可能继承 bypass 可用性，也可能在计划中激活 auto |
| `bypassPermissions` | 跳过一部分通用权限检查 | 内容级 ask、安全检查和强制交互仍可能保留 |
| `dontAsk` | 把最终 `ask` 转成 `deny` | 这是“不要询问”的失败策略，不是自动允许 |
| `auto` | 用快速路径和分类器替代部分人工确认 | 分类器不可用、上下文过长和拒绝过多时会降级或终止 |

### 4.1 `bypassPermissions` 不是无条件放行

`hasPermissionsToUseToolInner()` 会在前面的强制检查完成后判断：

```typescript
const shouldBypassPermissions =
  context.mode === 'bypassPermissions' ||
  (context.mode === 'plan' && context.isBypassPermissionsModeAvailable)

if (shouldBypassPermissions) {
  // 只跳过剩余的通用 allow / ask 处理
  return { behavior: 'allow', updatedInput }
}
```

前面已经返回的结果不会被这里重新改写：

- 工具自身 `deny`；
- `requiresUserInteraction()` 要求交互；
- 内容级 `ask` 规则；
- `.git/`、`.claude/`、`.vscode/` 等路径安全检查。

此外，`permissionSetup.ts` 会读取 managed policy 中的 `disableBypassPermissionsMode`。企业策略可以让 bypass 模式不可用，即使启动参数试图打开它，最终也不会获得 bypass 能力。

### 4.2 `dontAsk` 是快速失败，不是“全自动”

外层入口在拿到内层结果后，最后处理 `dontAsk`：

```typescript
if (result.behavior === 'ask' && mode === 'dontAsk') {
  return {
    behavior: 'deny',
    decisionReason: { type: 'mode', mode: 'dontAsk' },
    message: DONT_ASK_REJECT_MESSAGE(tool.name),
  }
}
```

这项转换放在外层，并且放在处理逻辑的后段，目的是避免某个早期返回绕过 `dontAsk`。

因此：

```text
普通交互：ask → 用户决定
dontAsk： ask → deny
```

两者都不会把 `ask` 变成 `allow`。

### 4.3 `plan` 与 auto 的关系

`plan` 本身不等于 `auto`。源码会根据进入计划模式前的状态、配置和 `isAutoModeActive()` 决定是否在计划阶段使用 auto classifier。

进入或退出相关模式时，`transitionPermissionMode()` 还会保存 `prePlanMode`，并在需要时调用：

```text
进入 auto 或计划中的 auto
  → stripDangerousPermissionsForAutoMode()
  → 暂时移除会绕过分类器的危险 allow 规则

退出 auto
  → restoreDangerousPermissions()
  → 恢复之前被暂时移除的规则
```

因此不能只看当前字符串 `mode === 'plan'` 就推断所有权限行为。还要看是否由 bypass 进入、是否启用了计划中的 auto，以及是否保存了被剥离的规则。

---

## 五、auto mode 如何代替一部分人工确认

auto mode 不是“把所有工具都自动允许”。它只在内层结果为 `ask`，并且当前功能开关和运行模式满足条件时介入。

### 5.1 三条快速路径

外层 `hasPermissionsToUseTool()` 在真正调用 classifier（分类器，用来判断动作是否应该被阻止）前，会先走快速路径：

```text
ask
  │
  ├─ 1. acceptEdits 检查
  │     当前工具在 acceptEdits 下已经允许 → allow
  │
  ├─ 2. 安全工具白名单
  │     只读或低风险工具 → allow
  │
  └─ 3. classifyYoloAction()
        让独立分类模型判断当前动作
```

第一条路径的实现方式比较特别：它不会直接修改全局 mode，而是临时构造一个 `mode: 'acceptEdits'` 的上下文，再调用工具自己的 `checkPermissions()`。

这样做的意义是：

- 工作区内的普通文件编辑不必频繁调用分类模型；
- Agent、REPL 等可能包含二次执行能力的工具不会被这个快速路径误放行；
- 真正需要语义判断的操作才进入 classifier。

### 5.2 classifier 的结果如何处理

分类器结果大致分为三种：

| 结果 | 交互模式 | headless 模式 |
|---|---|---|
| 允许 | `allow` | `allow` |
| 阻止 | 通常返回 `deny` | `deny`，达到拒绝上限后终止 |
| 不可用 | 根据失败策略回退 `ask` | fail-closed 时 `deny` |

`fail-closed` 的中文含义是“失败时默认关闭”。在权限系统里，就是分类器不可用时宁可拒绝或要求人工确认，也不直接放行。

当前实现通过 `tengu_iron_gate_closed` 控制分类器不可用时的策略：

- 门控开启：交互模式回到人工 `ask`；headless 模式直接 `deny`；
- 门控关闭：fail-open（失败时保持开放）时回到普通权限处理。

这里要区分“交互模式下回退 `ask`”和“无人值守下直接 `deny`”。前者给用户一次人工复核机会，后者保证流程不会永远等待。

### 5.3 上下文窗口过长不是普通 API 错误

分类器需要读取一部分对话 transcript（对话记录）来判断当前动作。如果 transcript 超过分类模型的上下文窗口，源码把它标记成 `transcriptTooLong`。

这是一个会持续存在的条件，因为会话只会继续增长。因此当前实现不会反复重试同一分类调用：

- 有交互界面：回退到普通人工审批；
- headless：抛出 `AbortError`，直接终止 Agent；
- 不把它当成普通的“分类器暂时不可用”处理。

这说明“模型窗口检测”在权限系统中不仅影响 token 成本，也会改变最终控制流。

### 5.4 拒绝计数为什么要有两个维度

`denialTracking.ts` 同时记录：

```typescript
export const DENIAL_LIMITS = {
  maxConsecutive: 3, // 连续拒绝 3 次
  maxTotal: 20,      // 当前会话累计拒绝 20 次
}
```

一次 classifier 拒绝会让两个计数都增加。一次成功的工具调用会清零连续拒绝计数，但不会清零会话累计拒绝次数。

达到任一阈值后：

- 交互模式：回退人工审批，并提示用户检查 transcript；
- headless：抛出 `AbortError`，避免分类器持续拒绝导致 Agent 无限循环。

这是一种“让模型暂时停下来接受人类复核”的保护，而不是认为分类器已经永久正确。

---

## 六、为什么 auto mode 要剥离宽泛 allow 规则

如果用户配置了下面的规则：

```text
Bash
Bash(*)
Bash(python:*)
Bash(node:*)
```

通用规则引擎可能会在 classifier 之前直接返回 `allow`。这样 auto mode 的语义判断就失去了意义。

`permissionSetup.ts` 的 `isDangerousBashPermission()` 会把以下类型识别为危险权限：

- 工具级 Bash allow；
- 独立通配符；
- 脚本解释器前缀，例如 `python:*`、`node:*`；
- 其他会执行任意代码、启动子 Shell 或绕过分类器的危险模式。

进入 auto mode 时，`stripDangerousPermissionsForAutoMode()` 会暂时移除这类 allow 规则，并把它们保存到上下文中。退出 auto 后，`restoreDangerousPermissions()` 再恢复。

这不是删除用户配置文件，而是调整当前运行阶段的内存权限上下文。

### 6.1 为什么不能把所有危险模式写成固定清单

危险模式依赖构建目标和用户类型。当前代码中 Bash、PowerShell、Agent、Tmux 等检查并不完全相同，有些规则还受 `USER_TYPE` 或功能开关控制。

因此文章只能概括为：

> auto mode 会剥离能够在 classifier 之前自动放行任意代码的宽泛规则；具体模式由 `dangerousPatterns.ts`、PowerShell 检查和构建条件共同决定。

不能把某一份危险命令数组当成所有构建、所有平台都完全相同的安全标准。

---

## 七、headless、Hook 和人工审批的边界

`headless` 是“无交互界面运行”的模式，例如后台 Agent、CI 或自动化任务。它和 `dontAsk` 不是同一个概念：

| 概念 | 来源 | 解决的问题 |
|---|---|---|
| `dontAsk` | 权限模式 | 规则要求询问时，不询问而直接拒绝 |
| headless | 工具权限上下文 | 当前环境没有 UI，不能弹出人工确认 |

当普通权限结果仍然是 `ask`，且 `shouldAvoidPermissionPrompts` 为真时，外层会：

```text
PermissionRequest Hook
  ├─ Hook 返回 allow → allow
  ├─ Hook 返回 deny  → deny
  └─ Hook 没有决定   → deny
```

这里的 Hook 是补充决策渠道，不是绕过权限系统的万能后门。Hook 本身还会受到托管策略中 `disableAllHooks` 等设置影响。

在有 UI 的情况下，`ask` 会进入人在环路流程，由用户选择允许或拒绝。具体的提示界面、决策持久化和工具结果回灌见 [16 人在环路](cc-16-human-in-the-loop.md)。Hook 的生命周期和阻断点见 [15 Hook 拦截](cc-15-hook-interception.md)。

---

## 八、sandbox 负责“就算放行也跑不出去”

权限规则主要回答：

```text
这条工具调用应该不应该继续？
```

sandbox 则回答：

```text
即使进程已经启动，它还能访问哪些文件、目录和系统资源？
```

这两个问题不能互相替代。

### 8.1 `shouldUseSandbox()` 的判断

`packages/builtin-tools/src/tools/BashTool/shouldUseSandbox.ts` 当前会依次检查：

```typescript
export function shouldUseSandbox(input) {
  // 1. 全局没有启用 sandbox，直接不使用
  if (!SandboxManager.isSandboxingEnabled()) return false

  // 2. 只有策略允许时，才接受 dangerouslyDisableSandbox
  if (
    input.dangerouslyDisableSandbox &&
    SandboxManager.areUnsandboxedCommandsAllowed()
  ) {
    return false
  }

  // 3. 没有命令，不创建 sandbox 执行
  if (!input.command) return false

  // 4. 命中 excludedCommands 时不使用 sandbox
  //    但 excludedCommands 只是便利配置，不是安全边界
  if (containsExcludedCommand(input.command)) return false

  return true
}
```

这里最容易误读的是 `excludedCommands`。源码注释明确说明，它是用户侧便利配置，不是安全边界。真正的安全控制仍然来自 sandbox 权限系统和相关提示流程。

### 8.2 软判断和硬隔离的分工

可以把权限与 sandbox 的关系概括为：

```text
规则匹配 / classifier / 人工审批
  → 判断“应不应该执行”

OS 层 sandbox
  → 限制“执行后能访问什么”
```

前者可能受到规则配置、模型判断或用户操作影响；后者由进程隔离机制提供更硬的约束。sandbox 不是规则引擎的替代品，规则也不能替代 OS 层隔离。

---

## 九、几个容易写错的结论

### 9.1 “权限就是 deny > ask > allow”

不准确。

更准确的说法是：

> 权限判定先检查工具级规则和工具自身结果，再在强制 ask 之后处理 bypass 和工具级 allow；外层还会对 ask 进行 `dontAsk`、auto 和 headless 改写。

### 9.2 “bypassPermissions 会绕过所有安全检查”

不准确。

内容级 `ask`、安全检查和工具要求交互的结果可能在 bypass 之前直接返回。企业策略还可以关闭 bypass 模式。

### 9.3 “auto 就是不用用户确认”

不准确。

auto 只是把一部分 `ask` 交给快速路径和 classifier。分类器失败、上下文窗口超长、拒绝达到阈值或安全检查不允许自动批准时，仍然可能回退人工处理、拒绝或终止。

### 9.4 “headless 等于 dontAsk”

不准确。

`dontAsk` 是一个权限模式；headless 是当前上下文没有交互界面的运行条件。两者可能同时出现，也可以分别出现。

### 9.5 “sandbox excludedCommands 是安全白名单”

不准确。

源码明确把它定义成便利配置。真正的安全边界仍然要看 sandbox 是否启用、策略是否允许关闭，以及 OS 层隔离是否生效。

### 9.6 “检测到 shadowed rule 就不会执行”

也不准确。

`shadowed rule`（被其他规则遮蔽的规则）检测主要用于发现配置冲突并提示用户，不代表所有冲突规则都会被自动删除。最终是否执行，仍然取决于权限评估顺序和实际输入。

---

## 十、从权限系统提炼出的设计模式

### 10.1 确定性核心 + 非确定性外层

把规则匹配、工具输入校验和安全检查放在内层；把 classifier、headless 和用户交互放在外层。

这样可以让核心判断保持可复现，同时允许外层根据成本、模型可用性和运行环境做降级。

### 10.2 危险结果先锁定，宽松结果后处理

工具自身 deny、内容级 ask 和 safety check 先于 bypass 和工具级 allow。

这不是简单追求“规则越具体优先级越高”，而是优先保证错误方向是“多确认或拒绝”，而不是“危险操作被静默放行”。

### 10.3 快速路径承担成本控制，classifier 处理灰区

只读工具和明确的工作区编辑可以走快速路径；真正需要语义理解的动作才调用分类模型。

这同时降低了延迟和 token 成本，也避免把所有工具调用都交给一个模型判断。

### 10.4 软策略和硬隔离同时存在

权限规则负责决定要不要执行，sandbox 负责限制进程执行后的活动范围。

这类组合可以迁移到其他 Agent 系统：

```text
策略判断
  + 人工或模型复核
  + 进程 / 容器 / OS 隔离
```

单独依赖其中任意一项，都会把另一类故障暴露出来。

---

## 总结

这篇文章最需要记住的是一条真实调用主线：

```text
工具级规则
  → 工具自身 checkPermissions
  → 内容级 ask / safetyCheck
  → bypass 或工具级 allow
  → passthrough 转 ask
  → dontAsk / auto / headless / 人工审批
  → sandbox 限制执行边界
```

权限系统不是一条固定的“六层防御链”，也不是把所有规则按 `deny > ask > allow` 排序就结束。源码真正做的是：先让确定性、危险性更高的结果锁定，再把剩余的 `ask` 交给运行模式、分类器或人工处理，最后用 sandbox 限制进程能够触达的系统范围。

**相关源码**：`permissions.ts` · `permissionsLoader.ts` · `permissionRuleParser.ts` · `permissionSetup.ts` · `BashTool.tsx` · `bashPermissions.ts` · `shouldUseSandbox.ts` · `denialTracking.ts`
