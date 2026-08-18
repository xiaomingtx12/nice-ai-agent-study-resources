---
slug: /application-notes/engineering/claude-code-cli/cc-16-human-in-the-loop
sidebar_position: 16
title: "人在环路：权限确认与用户交互"
description: "从 allow、deny、ask 的权限分流出发，拆解本地审批、远程转发、Hook、分类器和 AskUserQuestion 如何共同接入 Agent 循环。"
---

> 人在环路不是“弹出一个确认框”这么简单。它解决的是：当 Agent 想执行一个动作，或者需要补充用户意图时，系统怎样暂停当前执行、等待一个可靠决定，再把结果交回 Agent。
>
> **Harness 层定位**：人在环路位于工具执行前后的控制面。权限规则先判断是否允许，交互层再决定是否需要人、由谁回答，以及没有交互界面时怎样安全收敛。

# 人在环路：权限确认与用户交互

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。正文引用的是本地复刻仓库中的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **权限入口**：`src/hooks/useCanUseTool.tsx` 的 `useCanUseTool()` —— 创建 `PermissionContext`，调用权限判断，并用 Promise 挂起工具执行，直到得到 `allow`、`deny` 或 `ask` 的最终结果。
> - **权限计算**：`src/utils/permissions/permissions.ts` 的 `hasPermissionsToUseTool()` 与 `hasPermissionsToUseToolInner()` —— 负责规则、工具自检、安全检查、权限模式和外层降级。
> - **交互竞争**：`src/hooks/toolPermission/handlers/interactiveHandler.ts` 的 `handleInteractivePermission()` —— 同时接入本地 UI、pipe（管道中继）、bridge（远程桥接）、channel（消息通道）、`PermissionRequest` Hook 和 Bash 分类器。
> - **一次性完成**：`src/hooks/toolPermission/PermissionContext.ts` 的 `createResolveOnce()` —— 使用原子抢占语义，保证多个异步决策源只有一个能够完成外层 Promise。
> - **用户提问工具**：`packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` —— 定义问题 schema、强制用户交互、校验权限，并将答案映射为 `tool_result`。
> - **问题 UI**：`src/components/permissions/PermissionRequest.tsx` 的 `permissionComponentForTool()`，以及 `AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx` —— 按工具路由到不同交互组件，处理分页、单题自动提交和 Plan 访谈。
> - **权限更新**：`src/utils/permissions/PermissionUpdate.ts` 的 `applyPermissionUpdates()` 与 `persistPermissionUpdates()` —— 分别负责当前进程立即生效和可持久化设置落盘。
> - **无交互降级**：`src/utils/permissions/permissions.ts` 的 `runPermissionRequestHooksForHeadlessAgent()` —— 无 TUI（终端交互界面）时先尝试 `PermissionRequest` Hook，没有决定才自动拒绝。

## 先回答一个容易混淆的问题

“人在环路”至少包含两种不同的人机交互：

| 类型 | 典型场景 | 用户提供的内容 | 结果怎样回到 Agent |
|---|---|---|---|
| 工具权限确认 | 是否允许执行 `Bash`、修改文件或访问敏感路径 | 允许、拒绝、取消，或者选择保存授权规则 | 转换为权限结果，决定工具是否继续 |
| 用户意图澄清 | 选择认证方案、UI 风格或多个实现方向 | 题目对应的答案，可包含多选和自由输入 | 转换为 `tool_result`，成为下一轮模型上下文 |

两者都可能显示在终端里，但责任不同。

权限确认回答的是“这个工具调用能不能执行”；`AskUserQuestion` 回答的是“接下来应该按哪个方向继续”。后文会分别说明，不能把所有交互都称为“权限弹窗”。

---

## 一、人在环路位于 Agent 循环的哪里

一次工具调用大致经过下面的路径：

```text
模型返回 tool_use
  │
  ├─► 权限计算
  │     ├─ allow ─► 执行工具
  │     ├─ deny  ─► 生成拒绝结果
  │     └─ ask   ─► 等待一个决策源
  │
  ├─► 工具执行或拒绝结果
  │
  └─► 结果回灌到下一轮模型上下文
```

`useCanUseTool()` 并不是一个同步的布尔判断。源码通过 Promise 把工具执行暂时挂起：

```typescript
return new Promise(resolve => {
  // 为本次工具调用创建独立的权限上下文
  const ctx = createPermissionContext(
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
  )

  // 后续权限判断、UI、Hook 或远程回调都通过 resolve 结束等待
  resolvePermissionDecision(ctx, resolve)
})
```

这段设计解决了一个实际问题：调用方不需要知道最终答案来自本地按键、远程页面、消息通道还是自动 Hook。它只等待一个统一的 `PermissionDecision`。

### 1.1 权限入口先分成三类结果

权限计算的核心输出不是“弹窗或不弹窗”，而是三种行为：

```text
allow：工具可以继续执行
deny ：工具不能执行，调用方获得拒绝结果
ask  ：当前规则没有给出最终决定，需要进入交互或自动决策路径
```

`hasPermissionsToUseTool()` 负责复用权限计算逻辑，`useCanUseTool()` 负责把计算结果接入 React UI（React 的界面组件体系）和交互队列。

这样拆分有两个原因：

- coordinator worker（协调工作线程）、测试和自动分类器需要在没有终端 UI 的环境中复用权限判断；
- 终端中的问题组件必须由 React 渲染，并且要接入键盘、取消和队列状态。

纯函数负责“算出结果”，React Hook 负责“把 ask 变成可交互的等待”。

### 1.2 `ask` 不是一种固定处理方式

当权限结果为 `ask` 时，系统不会简单地执行“弹窗”这一个动作，而是根据运行环境和工具类型继续分流：

```text
ask
  ├─► coordinator / swarm worker 的自动检查
  ├─► auto mode 的 classifier（分类器）
  ├─► Bash 的短暂投机等待
  ├─► 本地 TUI 交互
  ├─► pipe / bridge / channel 远程或外部转发
  ├─► PermissionRequest Hook
  └─► headless 无交互界面降级
```

这些路径不是依次累加多个决定，而是在不同场景下争夺同一个最终完成机会。这个“多路竞争”是理解后文的关键。

---

## 二、`ask` 的多路决策竞争

### 2.1 `handleInteractivePermission()` 做了什么

`handleInteractivePermission()` 位于 `src/hooks/toolPermission/handlers/interactiveHandler.ts`。它的职责不是重新计算权限，而是把一个已经得到的 `ask` 结果交给多个可能的决策来源。

核心结构可以简化为：

```typescript
function handleInteractivePermission(params, resolve) {
  // 只允许一个来源最终完成外层 Promise
  const { resolve: resolveOnce, claim } = createResolveOnce(resolve)

  // 本地 UI、pipe、bridge、channel、Hook、classifier
  // 可以并行启动，但不能同时提交决定
  startLocalPermissionPrompt(params, resolveOnce, claim)
  startPipeRelay(params, resolveOnce, claim)
  startBridgeRelay(params, resolveOnce, claim)
  startChannelRelay(params, resolveOnce, claim)
  startPermissionRequestHook(params, resolveOnce, claim)
  startBashClassifier(params, resolveOnce, claim)
}
```

这里的 `resolveOnce` 是只允许一次完成的 Promise 回调，`claim` 可以理解为“先抢到决定权”。它不是把多个决定合并成一个平均值，也不是按照配置文件顺序依次等待。

### 2.2 `createResolveOnce()` 是竞速安全阀

`createResolveOnce()` 在 `PermissionContext.ts` 中维护已抢占和已交付状态。它至少解决两类竞态（多个异步事件同时到达）：

- 用户刚按下允许键，分类器随后也返回允许；
- bridge 远程端已经拒绝，本地用户又在终端按下允许；
- 用户按下取消时，Hook 回调同时返回了一个自动决定。

抽象后的代码如下：

```typescript
function createResolveOnce<T>(resolve: (value: T) => void) {
  let claimed = false
  let delivered = false

  return {
    claim() {
      // 第一个调用者获得决定权，后续调用者失败
      if (claimed) return false
      claimed = true
      return true
    },
    resolve(value: T) {
      // 已交付后不重复 resolve
      if (delivered) return
      delivered = true
      resolve(value)
    },
  }
}
```

实际源码还会处理取消和清理，但核心语义就是：多个异步来源可以同时工作，最终只有一个结果能够影响工具执行。

### 2.3 各决策来源分别适合什么场景

| 决策来源 | 作用 | 适用场景 |
|---|---|---|
| 本地 UI | 用户在终端中直接允许、拒绝或取消 | 默认交互模式 |
| pipe | 通过标准输入输出做权限中继 | 脚本、管道和外部进程 |
| bridge | 通过远程桥接把请求交给另一端 | 远程控制或网页端管理 |
| channel | 转发到消息通道，例如移动端消息界面 | 已接入消息通道的运行环境 |
| `PermissionRequest` Hook | 由用户配置的 Hook 自动返回权限建议 | 自动化、SDK 嵌入和企业策略 |
| Bash classifier | 用分类模型快速判断 Bash 命令 | `auto` 模式或 Bash 投机路径 |

这里有一个容易误读的地方：Hook、远程端和分类器不是“人工审批完成之后的补充步骤”。它们是和本地用户一起竞争一个决定。

如果 Hook 先返回，系统会取消或清理其他等待路径；如果用户先操作，分类器看到 `userInteracted` 后通常会放弃继续抢占。这样可以避免用户已经明确回答后，后台模型又覆盖用户选择。

### 2.4 取消、拒绝和超时不是同一回事

交互路径至少要区分：

- **拒绝**：用户或自动决策明确表示不允许；
- **取消 / 中止**：用户退出当前请求，或者 `AbortController` 被触发；
- **等待未完成**：某个远程或自动来源还没有返回；
- **headless 自动拒绝**：没有交互界面，且 Hook 没有给出决定。

源码没有把所有情况都抽象成“弹窗超时”。尤其是 `AskUserQuestion`，它不是等待超过某个固定秒数就自动选择一个答案。它要么得到用户回答，要么被取消或拒绝，要么在无交互环境下由外层安全策略终止。

---

## 三、`AskUserQuestion`：用户意图澄清工具

### 3.1 它与普通权限确认有什么不同

普通权限确认的结果是：

```text
允许工具继续
拒绝工具执行
取消当前等待
```

`AskUserQuestion` 的结果是：

```text
问题文本 → 用户答案
```

它并不代表用户允许某个 Bash 命令，也不负责把“永久允许”规则写入 settings 文件。它只是让 Agent 在不确定时向用户询问结构化信息。

工具的 `requiresUserInteraction()` 返回 `true`，表达的是一个硬约束：这个工具的价值就是获取用户输入，不能被 `bypassPermissions` 或自动分类器静默替代。

### 3.2 输入 schema 限制交互规模

工具定义位于 `packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx`。问题数量限制为 1 到 4，每道题有 2 到 4 个选项，题目文本和选项标签需要保持唯一：

```typescript
const inputSchema = lazySchema(() =>
  z.strictObject({
    // 一次最多展示四道题，避免终端交互过载
    questions: z.array(questionSchema()).min(1).max(4),
    ...commonFields(),
  }).refine(UNIQUENESS_REFINE.check, {
    // 防止重复题目或重复选项造成答案歧义
    message: UNIQUENESS_REFINE.message,
  }),
)
```

单选是默认行为，`multiSelect: true` 时才允许多选。`Other` 选项由 UI 自动提供，不要求模型在输入中手写。

一个典型输入如下：

```json
{
  "questions": [
    {
      "question": "认证模块应该采用哪种方案？",
      "header": "认证方式",
      "options": [
        {
          "label": "JWT",
          "description": "无状态令牌，便于水平扩展"
        },
        {
          "label": "Session",
          "description": "服务端保存状态，撤销更直接"
        }
      ],
      "multiSelect": false
    }
  ]
}
```

这里保留 `JWT`、`Session` 等技术名词，因为它们是具体协议或实现方式；中文解释负责说明它们的工程含义。

### 3.3 工具自检明确返回 `ask`

`AskUserQuestion` 的 `checkPermissions()` 不根据问题内容猜测是否安全，而是直接返回 `ask`：

```typescript
async checkPermissions(input) {
  return {
    // 必须等待用户回答，不能把问题当作普通工具静默执行
    behavior: 'ask' as const,
    message: 'Answer questions?',
    updatedInput: input,
  }
}
```

因此，它和 `Bash` 的行为不同：

- `Bash` 可能返回 `passthrough`，再由规则、模式、分类器或人工审批决定；
- `AskUserQuestion` 直接表达“需要用户参与”，后续进入交互路径；
- 即使运行在 bypass 或 auto 相关模式中，`requiresUserInteraction()` 仍然阻止它被静默放行。

### 3.4 组件路由与交互状态

权限 UI 的总入口是 `PermissionRequest.tsx`。`permissionComponentForTool()` 根据工具类型选择具体组件：

```text
PermissionRequest
  └─► permissionComponentForTool(tool)
        ├─► BashPermissionRequest
        ├─► FileEditPermissionRequest
        ├─► PlanPermissionRequest
        ├─► AskUserQuestionPermissionRequest
        └─► 其他工具专用组件
```

`AskUserQuestionPermissionRequest` 再把交互拆成题目视图、提交视图和预览视图。状态 Hook 负责记录当前题目、已选答案、文本输入和多选状态。

当前实现包含几个值得注意的细节：

1. **单题单选自动提交**：只有一题且不是多选时，用户选中答案后直接提交，不再额外显示 review（复核）页面。
2. **多题或多选进入提交页**：用户可以先完成所有题，再统一确认。
3. **支持 `Other` 自由输入**：结构化选项不能覆盖所有情况时，用户仍然可以输入自己的答案。
4. **支持图片粘贴和预览**：图片会被缓存，并作为内容块附加到答案中；带 `preview` 的选项可以展示更丰富的预览内容。
5. **Plan 访谈有独立收尾**：在 Plan Mode（方案规划模式）中，问题可能用于多轮澄清，完成访谈后再让 Agent 整理方案，而不是把每一次选择都当成权限授权。

### 3.5 答案如何回到模型

工具输出 schema 使用：

```text
answers: question text -> answer string
```

多选答案会拼接为逗号分隔的字符串。之后 `mapToolResultToToolResultBlockParam()` 将答案转换为 `tool_result`：

```typescript
const answersText = Object.entries(answers)
  .map(([questionText, answer]) => {
    // 保留题目原文，模型可以把答案对应回具体问题
    return `"${questionText}"="${answer}"`
  })
  .join(', ')

return {
  type: 'tool_result',
  tool_use_id: toolUseID,
  // 工具结果会进入下一轮模型上下文
  content: `User has answered your questions: ${answersText}.`,
}
```

所以回灌后的信息不是一个隐藏的 UI 状态，而是普通的工具结果。下一轮模型会看到“问题对应的答案”，然后据此继续规划或执行。

### 3.6 channel 模式下为什么会禁用

源码在存在可用 channel 时，会让 `AskUserQuestion.isEnabled()` 返回 `false`。原因不是这个工具不安全，而是交互形态不匹配：

- `AskUserQuestion` 依赖 TUI 中的多题分页、多选和自由输入；
- 用户可能不在终端前；
- channel 权限中继对 `requiresUserInteraction()` 工具会跳过；
- 如果仍然启用，工具可能把 Agent 永久挂在一个没人能操作的多选界面上。

这说明“远程转发权限请求”和“远程承载任意用户问答”不是一回事。权限确认可以设计成 yes/no 中继，但完整的多题交互需要另一套协议。

---

## 四、权限决定怎样改变运行时

### 4.1 用户选择“永久允许”时发生了什么

权限 UI 中的“永久允许”不是简单把一个布尔值改成 `true`。它通常会产生一个 `PermissionUpdate`：

```text
用户选择授权范围
  │
  ├─► 生成 PermissionUpdate
  ├─► applyPermissionUpdates()
  │     └─► 当前进程内存立即生效
  └─► persistPermissionUpdates()
        └─► 如果目标可持久化，则写入 settings 文件
```

`PermissionContext` 将这两个动作组合起来。这样当前工具调用的后续请求可以立即使用新规则，同时下次启动也可以加载该规则。

### 4.2 `destination` 同时描述范围和生命周期

`PermissionUpdateDestination` 定义在 `src/types/permissions.ts`，当前包含：

| `destination` | 作用范围 | 是否写入普通 settings 文件 |
|---|---|---|
| `userSettings` | 当前用户的所有项目 | 是 |
| `projectSettings` | 当前项目，通常可供团队共享 | 是 |
| `localSettings` | 当前项目的本机配置 | 是 |
| `session` | 当前会话内存 | 否 |
| `cliArg` | 命令行参数提供的当前进程配置 | 否 |

因此，“永久允许”还要继续问一个问题：永久到哪里？

- 写到 `userSettings`，本机其他项目也可能受影响；
- 写到 `projectSettings`，项目成员可能一起继承；
- 写到 `localSettings`，只影响当前机器；
- 写到 `session`，本次会话结束后消失。

`session` 和 `cliArg` 可以参与当前权限计算，但不应被文章写成“普通 settings 文件已经落盘”。

### 4.3 内存更新与文件持久化是两条轨道

源码中的两个函数职责不同：

```typescript
// 只更新当前 ToolPermissionContext
const nextContext = applyPermissionUpdates(
  currentContext,
  updates,
)

// 只处理能写入设置文件的更新
persistPermissionUpdates(updates)
```

实际调用还会通过 React 状态 setter 把 `nextContext` 放回运行时。这个双轨设计避免了一个常见问题：如果只写文件不更新内存，当前会话的下一次工具调用仍然会重复弹窗；如果只更新内存，重启后规则又会丢失。

### 4.4 用户答案不等于权限规则

`AskUserQuestion` 的答案会进入 `tool_result`，而“允许 Bash”或“总是允许某类工具”才可能生成 `PermissionUpdate`。两条链路不要混在一起：

```text
AskUserQuestion
  → answers
  → tool_result
  → 下一轮模型上下文

权限确认
  → allow / deny / cancel
  → 可选 PermissionUpdate
  → 当前内存 + settings 文件
```

这也是为什么一篇文章同时讲人在环路，却仍然需要把“用户问答”和“权限持久化”分开解释。

---

## 五、无交互环境：headless 不是一种权限模式

### 5.1 `dontAsk` 与 headless 的区别

`dontAsk` 是权限模式，含义是：当权限计算结果仍然是 `ask` 时，把它转换为 `deny`，不再显示交互界面。

headless（无交互界面）是运行环境条件，例如脚本、管道、后台任务或没有可用 TUI 的进程。它不等于 `dontAsk`，两者可以分别出现。

源码的 headless 处理大致是：

```text
ask
  │
  ├─► 先运行 PermissionRequest Hook
  │     ├─ allow → 工具继续
  │     └─ deny  → 工具拒绝
  │
  └─► Hook 没有决定
        └─► 自动 deny
```

这里不能写成“headless 等待超时后 deny”。源码语义是先给自动 Hook 一个决定机会，只有没有 Hook 决定时才安全拒绝。

### 5.2 为什么 headless 默认选择拒绝

无交互环境无法把请求交给人。如果系统在没有答案时默认允许，Agent 可能因为一个网络抖动、Hook 失效或远程控制端不可用而继续执行危险操作。

因此它采用 fail-safe（故障安全）策略：

- 错误方向是多拒绝一次，而不是静默放行；
- Agent 可以收到拒绝结果后修改方案；
- 不可逆副作用不会因为“没人按键”而自动发生。

这不代表 headless 完全不能自动运行。只要 `PermissionRequest` Hook 提供明确的 allow 或 deny，系统仍然可以在没有 TUI 的环境中工作。

### 5.3 `AskUserQuestion` 在 headless 下不能自动猜答案

`AskUserQuestion` 的目的就是收集用户信息。headless 没有用户可回答时，系统不能合理地替用户选择 JWT、Session 或其他方案。

因此需要把两种失败分开：

- 权限确认无交互：可以由 Hook 决定，未决定时 deny；
- 用户意图问答无交互：不能凭空生成答案，应该拒绝、取消或由上游改用预先提供的参数。

把“无人审批时自动拒绝”和“没人回答时自动选择一个选项”写成同一种机制，会误导读者以为 Agent 可以安全猜测用户意图。

---

## 六、自动分类器和 2 秒投机窗口

### 6.1 分类器只处理一部分 `ask`

auto mode（自动权限模式）会让部分权限请求进入 classifier（分类器）。分类器通常使用较小的模型，根据工具调用和上下文判断是否应该拦截。

它不是所有工具的通用替代品：

- `requiresUserInteraction()` 为真的工具不能被它代替用户回答；
- 安全检查和内容级风险可能仍然保留；
- 分类器不可用、上下文过长或结果不满足自动批准条件时，需要回到人工审批或安全拒绝；
- headless 下不能因为分类器没有返回就默认允许。

### 6.2 2 秒只属于 Bash 的投机等待

`useCanUseTool.tsx` 中存在一个短暂的 speculative grace period（投机等待窗口），主要用于 Bash：

```text
Bash 权限结果为 ask
  │
  ├─► 后台启动分类器
  ├─► 最多等待约 2 秒
  │     ├─ 高置信度允许 → 直接放行
  │     └─ 超时或结果不满足 → 展示普通权限交互
  └─► 用户确认或拒绝
```

它的目标是减少常见 Bash 命令带来的频繁弹窗，而不是给人工用户设置回答时限。

`AskUserQuestion` 不适合进入这个窗口，因为模型无法替用户决定问题答案。对用户意图进行“高置信度猜测”并不能替代真正的用户输入。

### 6.3 不要把 auto、bypass 和人工交互写成同一层

三者解决的问题不同：

| 机制 | 解决的问题 | 主要风险 |
|---|---|---|
| `bypassPermissions` | 已知运行环境下减少权限确认 | 可能放宽过多，需要保留硬安全检查 |
| `auto` classifier | 在部分灰区请求中降低人工审批频率 | 分类误判和模型不可用 |
| 人工交互 | 在规则和自动判断无法可靠决定时交给用户 | 需要可用的交互界面和等待处理 |

人在环路不是自动化失败后的一个固定“最后一步”。在 `ask` 阶段，人工、Hook、远程端和分类器可能并行竞争；但对必须获得用户答案的工具，自动化不能替代用户输入。

---

## 七、几个容易写错的结论

### 7.1 “人在环路就是一个权限弹窗”

不准确。

权限弹窗只是其中一种呈现方式。`AskUserQuestion` 是用户意图澄清工具，`PermissionRequest` Hook 是自动决策来源，bridge 和 channel 是远程转发路径，它们共享等待和回传机制，但业务语义不同。

### 7.2 “多个决策源会把答案合并起来”

不准确。

本地 UI、Hook、远程端和分类器竞争的是同一个 `resolve`。`createResolveOnce()` 保证先抢到决定权的一方生效，其他路径会被取消或忽略。

### 7.3 “2 秒是所有人工审批的超时”

不准确。

2 秒窗口是 Bash 分类器的投机等待，用于决定是否需要展示普通权限确认。它不是 `AskUserQuestion` 的回答时限，也不是所有权限请求的统一超时。

### 7.4 “bypassPermissions 会跳过所有用户交互”

不准确。

需要用户提供答案的工具通过 `requiresUserInteraction()` 保留交互边界，内容级安全检查也可能在 bypass 之前返回。bypass 的语义是减少一部分权限确认，不是取消所有人机交互。

### 7.5 “headless 等于 dontAsk”

不准确。

`dontAsk` 是权限模式；headless 是运行环境。headless 还会先尝试 `PermissionRequest` Hook，没有决定才自动拒绝。

### 7.6 “AskUserQuestion 的答案会写入权限设置”

不准确。

答案通过 `tool_result` 回灌给模型；只有权限确认产生的 `PermissionUpdate` 才可能更新当前权限上下文或写入 settings 文件。

---

## 总结

这篇文章可以用下面的主线收束：

```text
tool_use
  → 权限计算
  → allow / deny / ask
  → ask 的多路决策竞争
       ├─ 本地 UI
       ├─ pipe / bridge / channel
       ├─ PermissionRequest Hook
       └─ Bash classifier
  → createResolveOnce() 保证一次完成
  → 权限结果或 AskUserQuestion 的 tool_result
  → 下一轮 Agent 上下文
```

真正需要记住的边界有四个：

1. **权限确认和用户意图澄清不是一回事**。前者决定工具能否执行，后者提供下一轮模型需要的答案。
2. **`ask` 不是固定弹窗步骤**。它可能由本地用户、远程端、Hook 或分类器先完成。
3. **无交互环境优先安全收敛**。headless 先运行 `PermissionRequest` Hook，没有决定才 deny；`dontAsk` 则是显式权限模式。
4. **2 秒窗口只服务 Bash 分类器**。它不是人工回答超时，更不能替代 `AskUserQuestion` 的真实用户输入。

**相关源码**：`src/hooks/useCanUseTool.tsx` · `src/hooks/toolPermission/PermissionContext.ts` · `src/hooks/toolPermission/handlers/interactiveHandler.ts` · `src/utils/permissions/permissions.ts` · `src/utils/permissions/PermissionUpdate.ts` · `packages/builtin-tools/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` · `src/components/permissions/PermissionRequest.tsx`
