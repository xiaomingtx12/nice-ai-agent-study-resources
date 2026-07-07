# 子 Agent 上下文隔离

> **本章目标**：理解子 Agent 如何通过独立上下文隔离"过程"与"结论"——为什么需要 fork-join 模式、三种 subagent 机制有何区别、Fork path 如何利用 prompt cache 优化、上下文继承如何在不同 Agent 类型间分配，以及结果回收与并发控制的工程实现。
>
> **读完本章你应该能回答**：
> - 为什么主 Agent 需要把子任务"外包"给子 Agent 而不是自己在上下文里完成？
> - Regular subagent、Fork subagent、Teammate 三种机制在工具集、上下文、持久化上有何不同？
> - Fork path 为何要求父子 prompt cache byte-identical？这是如何实现的？
> - Explore/Plan/General/Fork Worker 在 system prompt、CLAUDE.md、工具集、权限上各自的继承策略是什么？
> - 子 Agent 的结果如何收敛成 tool_result 回传父 Agent？sidechain transcript 怎么写？
> - 并发控制（worktree 隔离、超时、fork 防递归）是如何保证正确性的？

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 子 Agent 解决的核心问题：过程隔离 + Fork-Join 并发 | 必读，建立问题意识 |
| 二 | 三种 subagent 机制全景：Regular / Fork / Teammate 对照表与流程图 | **核心章节**，先看全貌再看细节 |
| 三 | 子 Agent 在架构中的位置：协议层、声明式定义层、循环层、上下文层、持久化层 | 必读，建立全局坐标 |
| 四 | 关键概念速览：权限规则语法、Transcript 机制、`<task-notification>` | 先扫一遍，后面遇到不迷路 |
| 五 | **子 Agent 执行机制**：四阶段流程 + 上下文继承策略 + 结果回收 + 并发控制 | **核心章节**，骨架 + 深度展开 |
| 六 | **AgentTool 核心代码与生命周期**：call() 关键路径 + SendMessage + sync/async | 选读，需要深入实现时看 |
| 七 | 内置子 Agent 类型体系：6 种内置 Agent + 完整 prompt + 共同设计模式 | 参考表，按需查阅 |
| 八 | 声明式 Agent 定义系统（frontmatter + markdown body）：文件格式、发现/解析/注入全流程、字段副作用、设计决策与局限 | 参考，需要自定义 agent 时精读 |
| 九 | 设计决策与权衡 | 理解为什么这样设计 |
| 十 | 边界与局限 | 了解当前实现的不足 |
| 十一 | 可复用的模式 | 提炼可迁移的设计模式 |

---

## 一、它在解决什么问题

主 Agent 在执行复杂任务时会产生大量中间过程——搜索代码库、阅读数十个文件、对比多个实现方案。这些中间结果有两个问题：

**1. 挤占推理空间。** 主 Agent 的上下文窗口有限，每轮推理都在消耗 token。如果中间过程堆在主上下文里，token 会快速耗尽，触发昂贵的压缩操作。更糟的是，中间过程会分散 LLM 的注意力——它需要从大量搜索记录中提取"刚才探索到了什么"才能继续推理。

**2. 增加 API 成本。** 每轮发 API 都会把整个对话历史作为前缀带上。中间过程越长，每轮请求的 input token 越多，成本越高。

子 Agent 把"过程"隔离在独立上下文中执行，只把"结论"回传给主 Agent。这样主 Agent 的上下文保持"干净"，只看到子任务的最终摘要，而不是几十个工具调用的详细记录。

更广义地讲，子 Agent 也是 Agent Fork-Join 并发的执行器。主 Agent 在一轮中可以发出多个 `tool_use`（包括多个 AgentTool 调用），下游对应多个独立 `query()` 调用——同轮自然并行，跨轮自然串行，无需额外的调度器。这种并发模式让多 token query() 同时跑，节约 wall clock。

---

## 二、三种 subagent 机制全景

文档下文展开的 `AgentTool` 实际上对应**三种不同的 subagent 机制**——它们的入口形态、工具集裁剪策略、上下文继承、持久化路径各不相同。下文在讲"Fork subagent"、"subagent"、"teammate"时会混用这三个名字，这里先一次性把全貌摊开。

### 2.1 对照表

| 类型 | 入口 | 工具集 | 上下文继承 | 持久化路径 | 典型用途 |
|------|------|--------|-----------|-----------|---------|
| **Regular subagent** | `AgentTool({subagent_type})` 显式指定 `Explore` / `Plan` / `general-purpose` 等 | 受限（按 `agentDef.tools` 白名单） | 不继承父对话历史；只看到自己 prompt | `subagents/agent-<id>.jsonl` (`isSidechain: true`) | 探索代码、单一目标查询、独立任务 |
| **Fork subagent** | `AgentTool({})` **省略 `subagent_type`**，且 `isForkSubagentEnabled()` 返回 true | 父完全相同（`['*']` + `useExactTools`） | **全部继承**父上下文（含 `renderedSystemPrompt` bytes） | `subagents/agent-<id>.jsonl` (`isSidechain: true`) | 后台并行处理 directive；依赖父推理上下文 |
| **Teammate** | `AgentTool({name, team_name})` 走 `spawnTeammate` 独立协议（**非 tool_use 路径**) | 由 agentDef 决定（可与父不同） | 不继承父对话历史 | 同上 | Agent Teams 多 agent 协作（订阅/plan 模式） |

### 2.2 分支流程图

```
AgentTool.call({...})
  │
  ├─► teamName && name？
  │     ├─ YES → spawnTeammate() → Teammate path            ← AgentTool.tsx:375-407
  │     └─ NO  ↓
  │
  ├─► subagent_type 显式指定？
  │     ├─ 'Explore' / 'Plan' / 'general-purpose' / 自定义 → Regular subagent path
  │     │                                                    ← AgentTool.tsx:432-457
  │     ├─ 省略 + isForkSubagentEnabled() → Fork path
  │     │                       (effectiveType === undefined) ← AgentTool.tsx:414-431
  │     └─ 都不是 → general-purpose 默认 fallback
  │                                                          ← AgentTool.tsx:414
  └─► 走 runAgent() → 独立 query() 协程 → finalizeAgentTool → tool_result 回传父
```

### 2.3 代码入口索引

| 类型 | 文件 | 行号 | 关键逻辑 |
|------|------|-----|---------|
| Regular subagent | `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | 322-458 | `call()` 主体：权限校验 → 解析 agentDef → 隔离/worktree → `runAgent()` |
| Regular（类型筛选）| `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | 432-457 | `filterDeniedAgents` + `agents.find(a => a.agentType === effectiveType)` |
| Fork subagent | `packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts` | 107-203 | `buildForkedMessages()` 构造继承上下文 + `buildChildMessage()` 注入 SOP |
| Fork 分支判定 | `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | 410-431 | `effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType)` |
| Teammate | `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` | 351-407 | `isAgentSwarmsEnabled` 校验 + `spawnTeammate({ name, prompt, description, team_name, ... })` |

### 2.4 为什么需要 3 种类型

**Regular subagent** 是最常见的形态——主 Agent 派发独立子任务（"探索 X 模块的实现"、"对比 A vs B 方案"），子 Agent 拿到 prompt 后跑自己的完整循环，摘要回传。这种场景下父对话历史是噪声（"我要搜索 X"这件事的来龙去脉），主动剥离反而省 token。

**Fork subagent** 极少触发，仅当主 Agent 已经在某些 `tool_use` 上做出了决策、需要把这些决策的上下文**完整**传递给后台 worker 才能继续工作时使用。典型场景是 Agent 决策树触发了一批后台任务，每个 fork 拿到的都是同一份父推理结果 + 独有的 directive，核心约束是 prompt cache byte-identical（详见 §五.5.5）。

**Teammate** 是另一类生命周期完全不同的机制：它走 mailbox + tmux 终端（或 in-process 进程），不是单纯的工具调用；订阅/plan/coordinator_mode 等限制是 Agent Teams 才有的概念。teammate 之间有持久身份、可互相发消息、可共享任务列表，这与一次性 fork worker 有本质差异。

---

## 三、它放在架构的哪个位置

子 Agent 是 Agent Loop 的"外包机制"——主 Agent 在 Act 阶段通过 `AgentTool` spawn 子 Agent，子 Agent 跑自己的完整循环（Reason→Act→Observe），完成后结果回传。主 Agent 的下轮推理会看到子 Agent 的结果。架构上涉及：

- **协议层**：`packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx` 定义 AgentTool 入口
- **声明式定义层**：扫描用户/项目 `.claude/agents/*.md` + 解析 YAML frontmatter + 与内置 agent 合并成统一的 AgentDefinition 列表（详见 §八）
- **循环层**：`runAgent()`(`runAgent.ts`) 在 `src/query.ts` 上独立调用一个 `query()` 协程，传入子 Agent 的 cache-safe 参数
- **上下文层**：`createSubagentContext()`(`forkedAgent.ts`) 决定哪些消息 / systemPrompt / 工具集 / 权限规则传下去
- **持久化层**：`recordSidechainTranscript()`(`sessionStorage.ts`) 把子 Agent 的对话写入 `subagents/agent-<id>.jsonl`，独立于主会话

---

## 四、关键概念速览

在深入 Fork-Join 流程之前，先集中解释几个贯穿始终的概念，避免读者看到 `deny agent(AgentName)`、`sidechain transcript`、`<task-notification>` 这些表达式时一头雾水。

### 4.1 权限规则语法：`Agent(agentType)`

Claude Code 的权限系统用统一的字符串规则来描述工具的访问控制——所有工具（包括 AgentTool、BashTool、FileEditTool 等）都用 `ToolName(pattern)` 这种括号语法。例如：

```
Bash(npm install)         ← 允许 Bash 跑 npm install
Bash(git commit:*)        ← 允许 Bash 跑 git commit 后面跟任意参数
Edit(/src/config.*)       ← 允许 Edit 编辑 /src/config.* 路径的文件
Agent(Explore)            ← 允许 AgentTool 启动 Explore 类型 agent
Agent(general-purpose)    ← 允许 AgentTool 启动 general-purpose agent
```

**规则分三种行为**：

- **allow**：用户已授权，工具直接执行（不再弹窗）。
- **deny**：用户禁止，工具直接报错（即便 LLM 想用也用不了）。
- **ask**：用户必须每次手动确认（弹窗或交互式提示）。

**针对 AgentTool 的 deny 规则**就是 `deny agent(<agentType>)` —— 它阻止 AgentTool 启动指定类型的子 agent。**为什么要单独 deny？**

考虑这个场景：用户在 settings.json 里加了 deny：

```
{
  "permissions": {
    "deny": ["Agent(general-purpose)", "Agent(code-reviewer)"]
  }
}
```

效果是：
- AgentTool 收到 `subagent_type: 'general-purpose'` → 查找 activeAgents 时**直接跳过**（`filterDeniedAgents` 在 lookup 阶段就过滤掉，见 §六.6.2）。
- AgentTool 收到 `subagent_type: 'code-reviewer'` → 找到但抛错 "Agent type 'code-reviewer' has been denied by permission rule"。
- LLM 即便尝试 spawn 这些 agent 也会失败——这是**用户层级的硬约束**，覆盖 LLM 的"我想用这个 agent"判断。

**历史命名**：`Agent(x)` 的 tool name 在源码里早期叫 `Task`，旧 settings 兼容映射到 `Agent`（见 `permissionRuleParser.test.ts:92-95`）。用户写 `Task(x)` 和 `Agent(x)` 效果相同。

**这与"LLM 自我约束"的区别**：LLM 自己在 prompt 里写"不要用 general-purpose agent"是**软约束**——LLM 可能忽略、可能在新会话里忘掉。`deny agent(...)` 是**硬约束**——写在配置文件里，每次调用都会被强制检查，绕不过去。

### 4.2 Transcript：会话的持久化存档

**Transcript = 整个会话的完整消息流，按时间顺序追加在磁盘上的 JSONL 文件**。每个 Claude Code 会话对应一个 transcript：

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

文件里每行是一个 `TranscriptMessage` 对象（见 `sessionStorage.ts:1061-1088`），包含：

- `uuid`：消息唯一 ID
- `parentUuid`：上一条消息的 UUID（构成 parent chain——一条消息的"父"是谁）
- `type`：`user` / `assistant` / `attachment` / `system` 等
- `message`：消息内容（与 LLM API 看到的相同）
- `isSidechain`：**关键标记**——这条消息是不是"侧链"（子 agent 用的）

**transcript 的作用**：

- **`/resume` 恢复会话**：读取 JSONL → 解析 parent chain → 重建消息树 → 让用户从断点继续。
- **审计/调试**：开发者可以 grep transcript 看 LLM 在哪一步犯了错。
- **流式 fallback**：API streaming 中断时，从 transcript 恢复进度。

**Sidechain（侧链 transcript）**——为什么需要：

如果子 Agent 的所有消息都直接写进主 transcript，会污染父的 parent chain——子 Agent 跑了几十步，父的 transcript 里就多了几十条和父推理无关的消息，`/resume` 时会被加载进来，浪费 token + 干扰上下文。

**sidechain 机制**：`recordSidechainTranscript()`（`sessionStorage.ts:1488-1499`）把子 Agent 的消息路由到**独立文件**：

```
主 session:   ~/.claude/projects/<hash>/<session-id>.jsonl
子 agent:     ~/.claude/projects/<hash>/<session-id>/subagents/agent-<agentId>.jsonl
```

每条子 agent 消息带 `isSidechain: true` 标记（`sessionStorage.ts:1062-1070`），`appendEntry` 据此路由（`sessionStorage.ts:1227-1230`）。**主 transcript 只看摘要**（即 §五.5.8 的 `finalizeAgentTool` 提取的最后一条 assistant 文本），**完整子 agent 消息在独立文件**。

**子 agent 文件命名规则**：

- 默认：`subagents/agent-<agentId>.jsonl`
- 有 subdir（workflows 用）：`subagents/<subdir>/agent-<agentId>.jsonl`（`sessionStorage.ts:255-258`）

**Sidechain dedup bypass**：fork worker 继承父的 UUID 写入自己的 sidechain，`appendEntry` 对 sidechain 写入故意跳过 `messageSet.has(uuid)` 去重，否则 fork 继承的父消息会被误判为重复而丢弃。详见 §五.5.8。

### 4.3 `<task-notification>`：异步 agent 完成通知

**`<task-notification>` 是什么**：当 async agent 完成后，系统向**主 Agent**的下一轮 user message 注入一段特殊的 `<task-notification>` 文本块。形如：

```xml
<task-notification>
  Task completed. The task ID was "abc-123", status: completed, output file: /tmp/agent-abc-123.jsonl
  You can use SendMessage to continue this agent.
</task-notification>
```

主 Agent 的下一轮推理看到这段文本，就知道"那个后台跑的 agent 完成了"。LLM 据此决定是否调用 `SendMessage({to: '<agentId>'})` 追问，或者忽略继续做别的事。

**为什么需要这种机制**：主 Agent 调完 `async_launched` 后不再阻塞——它**没办法主动 poll 后台 agent 状态**。`<task-notification>` 是**反向 push**——后台 agent 完成后主动通知主 Agent，让主 Agent 知道。

**与并发控制的关系**：

跨轮并发（async + async）依赖 `<task-notification>` 串联——主 Agent 启动多个 async agent，每个完成后都会 inject notification，主 Agent 在后续轮次看到通知做对应处理。并发控制的详细讨论见 §五.5.9。

---

## 五、子 Agent 执行机制

### 5.1 阶段 1：解析与上下文构造（call 入口 → runAgent）

主 Agent 把 `AgentTool({description, prompt, subagent_type, isolation, ...})` 作为 tool_use 块调用。AgentTool 在 `call()` 入口需要做三件事：

1. **选 AgentDefinition**：根据 `subagent_type` 在 activeAgents 数组里查——内置（Explore/Plan/...）、自定义（`.claude/agents/*.md`）、plugin、teammate 各走不同路径。
2. **决定隔离等级**：默认继承主 Agent 的 cwd；用户显式传 `isolation: 'worktree'` 时创建一个 git worktree；ant 用户还可传 `remote`（走 CCR 远程执行）。
3. **裁剪工具集与权限**：主 Agent 的可用工具集是全集（如 60+ 个），子 Agent 通常只需要子集（Explore 只要 Read/Grep/Glob）；同时通过 `allowedTools` 注入 session 级别的 allow rules，并用 `deny agent(AgentName)` 防止子 Agent 内部再次 spawn 自身。

具体到源码调用链，`call()` 内部的执行顺序如下：

```
AgentTool.call({description, prompt, subagent_type, isolation, ...}, context)
  │
  ├─► 解析 Agent 上下文
  │     ├─► resolveAgentDefinition(subagent_type) → AgentDefinition
  │     ├─► 隔离等级: 默认 (继承 cwd) | worktree | remote
  │     ├─► 模型: getAgentModel(agentDef.model, mainLoopModel, model)
  │     ├─► 裁剪工具集: availableTools (main 子集) | useExactTools
  │     ├─► 权限: allowedTools 作为 session allow rules; deny agent(AgentName)
  │     └─► fork vs 全量: isForkSubagentEnabled() → buildForkedMessages
  │
  ├─► 写 transcript 路径: setAgentTranscriptSubdir(agentId, subdir)
  │
  ├─► 创建 subagent context:
  │     createSubagentContext(parent, { availableTools, allowedTools, ... })
  │       ├─► messages: 仅 fork 路径继承父消息
  │       │     否则 [createUserMessage(prompt)]
  │       ├─► systemPrompt: buildEffectiveSystemPrompt(agentDef)
  │       ├─► toolPermissionContext: 裁剪; 隔离/剥离/override 按需
  │       ├─► readFileState: if forkContextMessages → cloneFileStateCache
  │       │     else → createFileStateCacheWithSizeLimit
  │       └─► agentId: createAgentId() 唯一
  │
  ├─► Worktree 隔离（如果 isolation==='worktree'）
  │     ├─► createAgentWorktree(slug) → /tmp/<slug>-<hash>/
  │     ├─► gitRoot / headCommit / hookBased 记录到 metadata
  │     └─► cwd 覆盖: cwdOverridePath = cwd ?? worktreeInfo.worktreePath
  │
  ├─► SubagentStart hook: executeSubagentStartHooks({...})
```

**关键变量速览**：

- **`availableTools`**：子 Agent 真正可用的工具集合。`main 子集` 表示从主 Agent 工具集裁剪；`useExactTools`（fork 路径用）表示**完全相同的工具集**——为 prompt cache byte-identical 服务。
- **`buildForkedMessages`**：fork 路径专属，把父 assistant message（含 thinking/text/tool_use）+ 占位 tool_result + `<FORK_BOILERPLATE_TAG>` 指令拼成子 Agent 的输入 messages。
- **`cloneFileStateCache`**：fork 路径专属，clone 父的"已读文件" cache——子 Agent 看到父读过的文件不会重复 IO；普通路径走 `createFileStateCacheWithSizeLimit` 新建一个。
- **`setAgentTranscriptSubdir`**：把子 Agent 的 transcript 写入独立的子目录（如 `subagents/agent-<id>/`），避免污染父 session。

### 5.2 阶段 2：子 Agent 独立 query() 协程

子 Agent 跑自己的完整 query 循环——Reason → Act → Observe → Loop。每个子 Agent 是独立的 `query()` 协程，主 Agent 的 query() 等待所有并发 tool_use 返回后再继续。

```
├─► 子 Agent 独立 query() 协程
│     ├─► runAgent({ agentDefinition, promptMessages, availableTools, ... })
│     │     └─► query() = src/query.ts 完整循环
│     │           ├─► Reason: LLM 决策下一步 tool_use
│     │           ├─► Act: 受限工具集 + 权限上下文
│     │           ├─► Observe: tool_result 回流
│     │           └─► Loop until stop_reason (end_turn / maxTurns / abort)
│     └─► 退出条件:
│           ├─► 自然结束 (end_turn)
│           ├─► maxTurns 到达 (agentDef.maxTurns, 默认一般较高)
│           ├─► agent 抛 abort/error → tool_result is_error: true
│           └─► 后台模式超时 → 自动转 async（详见 §六.6.7）
```

**4 种退出条件的语义差异**：

- **`end_turn`**：LLM 自己判断"任务完成"，输出 stop_reason=end_turn——最常见的正常退出。
- **`maxTurns`**：用户在 frontmatter 里设了上限（如 `maxTurns: 20`），到点强制终止——防止 agent 死循环。
- **`abort/error`**：用户主动 Ctrl+C 或 LLM 调用 API 抛错——主 Agent 看到 `is_error: true`。
- **后台模式超时**：agent 超过 2 分钟无进展，自动转后台任务让主 Agent 继续（详见 §六.6.7）。

### 5.3 阶段 3：结果回收与 worktree 清理

子 Agent 退出后，需要做三件事：提取摘要、写完整 transcript（sidechain 独立文件）、清理 worktree（如有）。

```
├─► SubagentStop hook: executeStopHooks(..., subagentId)
│
└─► 结果回收 (finalizeAgentTool)
      ├─► 提取最后一条 assistant message 作为 summary
      ├─► 写 subagents/agent-<id>.jsonl (recordSidechainTranscript)
      └─► 如 worktree 隔离 → cleanupWorktreeIfNeeded()
            ├─► 检测 hasWorktreeChanges(...)
            ├─► 无变更 → removeAgentWorktree(...)
            └─► 有变更 → 保留 + 通过 notification 告诉用户保留位置
```

**worktree 清理策略**不是简单的"用完就删"：

- **无变更**：`removeAgentWorktree` 直接清理——子 Agent 只读了文件，worktree 没意义。
- **有变更**：保留 + 通知用户——子 Agent 可能在 worktree 里改了文件，需要用户主动 merge 或 review。这是个"安全 vs 便利"的取舍：宁可多留一份 worktree 也不能误删用户的修改。

### 5.4 阶段 4：tool_result 回传主 Agent

阶段 3 产出的 summary 文本在这一步被包装成 Anthropic API 期望的 `tool_result` content block，注入主 Agent 的对话：

```
finalizeAgentTool 产出 summary
  │
  └─► mapToolResultToToolResultBlockParam()
        ├─► tool_use_id: toolUseContext.toolUseId   ← 关联回父 assistant 的 tool_use 块
        ├─► type: 'tool_result'
        └─► content: [summary 文本, agentId trailer, usage 信息]
              │
              └─► 注入主 Agent 下一轮 user message
                    └─► 主 Agent LLM 通过 tool_use_id 配对，看到子 Agent 输出
```

`tool_use_id` 是关键——它在 `AgentTool.tsx` 中一路透传（840→974→1164→1189→1204→1365），最终嵌入 `tool_result` block。父 Agent 的 LLM 在下一轮推理时，通过这个 id 把回传文本与之前 assistant message 里的 `tool_use` 块配对，知道"这是刚才那个子任务的输出"。

wire-format 的完整转换细节（含 content block 结构、sidechain 落盘、dedup bypass）见下文 §5.8。

---

### 5.5 上下文继承：两种 spawn 路径

以上四阶段中，阶段 1 最关键的决策是选 Regular 还是 Fork 路径——两者在上下文继承策略上截然相反。下面展开对比。

`AgentTool` 支持两种 spawn 路径：**普通 subagent**（默认 general-purpose）和 **fork path**（FORK_SUBAGENT feature 启用时）。两者最核心的差异是"是否继承父对话历史"——继承与否决定了 cache 策略、行为契约、SOP 约束。

#### 普通 subagent（默认 general-purpose）

```
主 Agent tool_use: AgentTool({ subagent_type: 'Explore', prompt: '...' })
  └─► 子 Agent:
        messages: [user('...')]   ← 不继承历史
        systemPrompt: 系统默认
        tools: agentDef.tools 白名单
        model: agentDef.model ?? inherit ?? mainLoopModel
        permissionContext: 独立 (来源 allowedTools override)
```

适合：探索代码、单一目标查询。

**为什么不继承父历史**：普通 subagent 任务是**独立的**——"探索 X 模块的实现"、"对比 A vs B 方案"。父对话里的"用户说想重构 X，所以我决定探索 X"对子 Agent 没意义，反而会浪费 token。**主动剥离是优化**——子 Agent 看到一个干净的 prompt "去探索 X"，专心做这一件事。

#### Fork path（FORK_SUBAGENT feature 启用时）

```
主 Agent tool_use: AgentTool({ prompt: '...' })  ← 省略 subagent_type
  └─► Fork worker:
        messages: buildForkedMessages(directive, parentAssistant) (forkSubagent.ts:107)
          ├─► 完整 parent assistant message (含所有 thinking/text/tool_use)
          └─► user message: 每条 tool_use → tool_result (占位符 'Fork started — processing in background')
                + `<${FORK_BOILERPLATE_TAG}>...` 指令 + directive 原文
        systemPrompt: 父的 renderedSystemPrompt bytes (cache 命中关键, 不是重新 getSystemPrompt)
        tools: ['*'] + useExactTools (与父完全相同, cache byte-identical)
        permissionMode: 'bubble' (允许弹窗给父终端)
        model: 'inherit' (与父一致)
```

**关键不变量**：`buildForkedMessages` 注释明示 "for prompt cache sharing, all fork children must produce byte-identical API request prefixes"——只有 `<directive>` per-child 不同，从 prompt cache 机制拿到巨大成本优势。

**Fork Worker 行为契约**（`<${FORK_BOILERPLATE_TAG}>` 内嵌）：
1. 不要 spawn 子 Agent（自指避免爆炸）
2. 不要问问题、不要寒暄
3. 直接用工具（具体：bash/read/write/etc.）
4. 改了文件要 commit 并回报 hash
5. 报告必须以 `Scope:` 开头，500 字内
6. 严格在 directive 范围内，范围外 1 句话即可
7. 输出固定 5 段：`Scope` / `Result` / `Key files` / `Files changed` / `Issues`

这相当于给 fork child 一个强约束的 mini-SOP。

**为什么 fork 必须继承父历史**：fork 路径用于"主 Agent 决策树触发了一批后台任务"——比如"我（主 Agent）决定并行做 A/B/C 三件事，每件事 spawn 一个 fork worker"。每个 fork 拿到的都是**同一份父推理结果** + 自己独有的 directive。如果 A worker 不知道"主 Agent 刚决定优先做 X 因为 Y"，A 就会做错。**继承历史不是冗余，是 fork worker 做出正确决策的前提**。

**为什么必须 byte-identical**：fork 的成本优势来自 prompt cache——父子前缀完全一致时，所有 fork worker 共享同一段 prefix 的 cache 命中（~90% 折扣）。如果每个 fork 的 prompt 略有不同（比如工具集差一项），cache 全部 miss，成本翻 10 倍。`useExactTools` + `renderedSystemPrompt` 透传 + 占位 tool_result 三件套保证 byte-identical。

### 5.6 上下文继承矩阵

下面这张矩阵覆盖 14 个上下文项在 5 种 Agent 类型中的处理策略，是阶段 1 中 `createSubagentContext` 决策的参考总表。**怎么读**：横轴是 5 种 Agent（4 种内置 + 1 种自定义），纵轴是 14 个上下文维度（如 system prompt、工具集、Skill 系统）。每格是"该 Agent 对该维度的处理方式"。整张表能回答"为什么 fork worker 看到的是完整父上下文，但 Explore 看到的是精简版"。

| 上下文项 | Explore Agent | Plan Agent | General Agent | 自定义 Agent | Fork Worker | 证据 |
|----------|:---:|:---:|:---:|:---:|:---:|------|
| System Prompt | 裁剪版 (omitClaudeMd) | Plan 版 | 标准版 | **完全替换**（body 原文，详见 §八） | 父的 rendered bytes | `runAgent.ts:407` |
| CLAUDE.md | omit (slim) | omit (slim) | 继承 | 继承 | 父已有 | `tengu_slim_subagent_claudemd` |
| gitStatus | omit | omit | 继承 | 继承 | 父已有 | `runAgent.ts:413-419` |
| 对话历史 messages | 不继承 | 不继承 | 不继承 | 不继承 | **全部继承** | `runAgent.ts:379-382` |
| 工具集 | 只读 (agentDef.tools) | 只读+ExitPlan | 受限全集 | `tools` 白名单 / `*` / 自动注入（memory 时） | 父完全相同 (`['*']`) | `AgentTool.tsx:316` |
| 模型 | 独立 | 独立 | inherit | `model` 字段（`inherit` 或具体名） | `'inherit'` | `runAgent.ts:349-354` |
| 隔离 (cwd) | 继承/可选 worktree | 继承 | 继承 | 继承/可选 `isolation: worktree/remote` | 继承/可选 worktree | `worktree.ts` |
| 权限上下文 mode | 独立 (`agentDef.permissionMode`) | 独立 | 独立 | 独立 | `'bubble'` | `runAgent.ts:424-444` |
| allowedTools session rules | 替换 | 替换 | 替换 | 替换 | 不替换 | `runAgent.ts:478-488` |
| MCP 工具 (root) | 不主动继承 | 不主动继承 | 不主动继承 | 不主动继承 | 父全相同 | 除非 agentDef.mcpServers |
| MCP 工具 (agent-specific) | agentDef.mcpServers | agentDef.mcpServers | agentDef.mcpServers | agentDef.mcpServers | agentDef.mcpServers | `initializeAgentMcpServers` |
| Skill 系统 | 不继承 | 不继承 | 不继承 | 不继承 | 父全相同 | `clearInvokedSkillsForAgent` |
| readFileState cache | 新建 | 新建 | 新建 | 新建 | fork 走 clone | `runAgent.ts:384-387` |
| Session 持久 (sidechain transcript) | `subagents/<id>.jsonl` | 同 | 同 | 同 | 同 | `recordSidechainTranscript` |

**几个反直觉行的解读**：

- **"Skill 系统不继承"**：子 Agent 不能调用主 Agent 的 Skill（Skill 是按 session 注册的，子 agent 有独立 session）。**例外**：fork worker 走 `clearInvokedSkillsForAgent` 但**保留父的 skills 列表**——因为 fork worker 的 systemPrompt 和父完全一致，必须保留父 skill 列表才能让 tool_use cache 命中。
- **"MCP 工具 (root) 不主动继承"**：除非 agentDef 显式声明 `mcpServers`，否则子 Agent 看不到主 Agent 连接的 MCP 服务器。这是**显式优于隐式**——避免子 Agent 误用父的 MCP 工具。
- **"allowedTools 替换 (fork 不替换)"**：普通 subagent 用 agentDef.allowedTools 替换父的 session allow rules（最小权限）；fork worker 保留父的 session rules（保持 byte-identical + 同样的权限）。
- **"readFileState: fork 走 clone"**：fork worker 必须知道父读过哪些文件（不重复 IO，且 prompt cache 命中需要同样的 read history）；普通 subagent 新建空 cache。

### 5.7 上下文压缩：Explore/Plan 为何"瘦下来"

上节矩阵中，Explore/Plan 在 CLAUDE.md 和 gitStatus 两行都是 omit——这不是偶然，而是 Anthropic 基于 fleet 数据做的专项 token 优化。主 Agent 上下文里堆的很多东西子 Agent 不需要——`runAgent.ts:394-419` 显式做这一步：

| 字段 | Explore/Plan | 其他子 Agent | 主 Agent | 节省原因 |
|------|-------------|-------------|---------|---------|
| `claudeMd` (CLAUDE.md 内容) | 剥离 | 保留 | 保留 | 子 Agent 只读；主 Agent 已经看过；fleet-wide 省 ~5-15 Gtok/week over 34M+ spawns |
| `gitStatus` | 剥离 | 保留 | 保留 | session-start 是 stale（注释 "explicitly labeled stale"）；Explore 自己跑 `git status` 拿新鲜数据；省 ~1-3 Gtok/week |

Gate `tengu_slim_subagent_claudemd` 默认 true，需要 revert 时 `tengu_slim_subagent_claudemd=false`。这是 Anthropic 拿全 fleet 数据后做的 token optimization——证明"上下文继承策略"不只是设计选择，也是运营成本的开关。

**为什么 Explore/Plan 剥离 CLAUDE.md 是安全的**：

- Explore 的 prompt 第一段写 `=== CRITICAL: READ-ONLY MODE ===`，明确告诉 LLM "不要修改文件"——CLAUDE.md 里的 lint/format/commit 规范对只读 agent 完全无用。
- Plan agent 调研完输出 PLAN.md，最终修改由主 Agent 执行——Plan 不需要 commit 规范。
- 主 Agent 自己执行 Edit/Write 时，会注入完整 CLAUDE.md——不会因为 Explore 没看而丢规则。

**fleet 数据解读**：

- **5-15 Gtok/week over 34M+ spawns**：平均每个 Explore spawn 节省 ~150-450 tokens 的 CLAUDE.md 内容。考虑到 Explore 是 Claude Code 最高频的子 agent（"探索 X 模块"几乎是任何中等任务的前置步骤），这个优化在 Anthropic 整体 API 成本中占比显著。
- **1-3 Gtok/week gitStatus**：session-start 时的 gitStatus 几小时后就过期（用户可能 commit、stash、checkout），Explore 自己跑 `git status` 拿到的永远是当前时刻的真实状态——比依赖 stale 数据更准确，又省 token。

**为什么不自动应用到所有子 Agent**：

- general-purpose / 自定义 agent 可能要做 Edit/Write——CLAUDE.md 是它们的执行规范。
- test-runner 类 agent 需要根据项目 lint 配置跑测试——CLAUDE.md 是输入而非冗余。

只有确定"agent 不会修改文件、不需要项目规范"时才能剥离——目前只有 Explore/Plan 满足。

### 5.8 结果回收策略

阶段 3 和阶段 4 的核心是结果回收——如何从子 Agent 的完整对话中提取摘要、如何持久化、如何包装成 API 格式回传。下面展开 `finalizeAgentTool` 的完整机制。

| Agent 类型 | 回传格式 | 截断策略 | 证据 |
|------------|---------|---------|------|
| Explore | 摘要 + 关键发现 | 长度限制 | `buildEffectiveSystemPrompt` + 结果 schema |
| General | 完整输出（截断） | `maxResultSizeChars` | `AgentTool.maxResultSizeChars: 100_000` |
| Plan | 摘要 + PLAN.md 路径 | 摘要截断 | Plan Agent 定义 |
| Fork | `Scope/Result/...` 5段 | 500 字 directive 默认 | `forkSubagent.ts:177-203` |
| Forked Skill | 结果文本 | 长度限制 | `SkillTool.ts` |

`finalizeAgentTool()` 提取最后一条 assistant message 文本作为 summary；如 summary > `maxResultSizeChars` 则截断。"子 Agent 的完整 transcript 写入 `subagents/agent-<id>.jsonl`"——这条由 `recordSidechainTranscript(agentId)` 在 runAgent 内部调用持久化，**不污染父 transcript**。

#### 子 Agent 结果如何合并回父 Agent

Fork-Join 的 "Join" 一侧需要把子 Agent 的内部消息收敛为一个 `tool_result` content block，再塞回父 Agent 的下一轮 `user` 消息。这是个看似平凡但容易出错的环节：

**(1) 结果封包：`finalizeAgentTool`**

子 Agent 一轮 `query()` 跑完后，调 `finalizeAgentTool(agentMessages, agentId, metadata)`（`packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts:277-364`）构造结果信封。返回结构包含 `agentId`、`agentType`、`content: Array<{type:'text', text:string}>`、`totalDurationMs`、`totalTokens`、`totalToolUseCount`、`usage`。

**(2) 转 wire-format：`mapToolResultToToolResultBlockParam`**

`AgentTool.tsx:1490-1592` 把上述 envelope 转成 Anthropic API 期望的 `tool_result` block（**单个 user message 携带 N 个 content block**），关键字段是 `tool_use_id`：

```typescript
// AgentTool.tsx:1545-1589
return {
  tool_use_id: toolUseID,              // 父 ↔ 子关联（来自 toolUseContext.toolUseId）
  type: 'tool_result',
  content: [
    ...contentOrMarker,                // 子 Agent 的文本片段
    { type: 'text', text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)\n<usage>...</usage>` },
  ],
}
```

**`tool_use_id` 关联链路**：`toolUseContext.toolUseId` 在 `AgentTool.tsx:840/974/1164/1189/1204/1365` 一路透传到 `enqueueAgentNotification` / `enqueueSdkEvent`，最终嵌入返回的 `tool_result` block。父 Agent 的 LLM 在下一轮推理时，通过这个 id 把回传的文本与之前 assistant message 里的 `tool_use` 块配对。

**(3) 完整 transcript 落 sidechain：`recordSidechainTranscript`**

子 Agent 的全量消息不写父 JSONL，调 `recordSidechainTranscript(messages, agentId)`（`sessionStorage.ts:1488-1499`），内部走 `insertMessageChain(..., true /* isSidechain */, agentId, ...)`。`isSidechain: true` 在 `sessionStorage.ts:1062-1070` 写入每个 transcript entry，`appendEntry` (`sessionStorage.ts:1251-1255`) 据此路由到 `subagents/agent-<agentId>.jsonl` 而非主 `session.jsonl`。

**(4) 侧链写入的 dedup bypass**

sidechain 写入故意跳过 `messageSet.has(uuid)` 去重检查（`sessionStorage.ts:1257-1283`），因为 fork worker 会继承父线程的 UUID——同一 UUID 在父和子中含义不同。本地文件是双写分离，远程 CCR 仅保留单链（inc-4718 设计取舍）。

**Wire-trace 视角**（fork worker 收敛后）：

```
父 transcript (session.jsonl)                子 transcript (subagents/agent-XYZ.jsonl, isSidechain:true)
─────────────────────────────                 ──────────────────────────────────────────────────
[user: prompt]
[asst: tool_use(id=toolu_ABC)]
                                ─fork─►      [user: <fork_boilerplate>...]
[tool_result(id=toolu_ABC,                  [asst: tool_use(id=toolu_DEF)]
  content=[{type:text, text:"Scope:..."}     [tool_result(id=toolu_DEF, ...)]
   +usage trailer])                          [asst: <text>"Scope:..."]   ← finalizeAgentTool 提取的来源
[asst: <继续推理>]
```

**关键 takeaway**：父 Agent 在 wire 层看到的只是一个普通的 `tool_result` block（含 agent 元信息 trailer），sidechain 仅是离线持久化的产物，不影响 API 请求体。

### 5.9 并发控制

以上讨论的是单个子 Agent 的执行流程。当主 Agent 同时 spawn 多个子 Agent 时，并发控制机制介入：

| 约束 | 值 | 设计意图 | 证据 |
|------|-----|---------|------|
| 最大并发子 Agent | 取决于 LLM 同轮 tool_use 数量 | 子 Agent 作为 tool_use 执行，与同轮其他工具并行 | `src/query.ts:1650` （comment）；实际由 LLM 决定轮内 tool_use 数 |
| 排队策略 | 无（同轮并行，跨轮串行） | 子 Agent 之间通常独立；同轮并行让多 token query() 同时跑，节约 wall clock | 行为推断 |
| 资源隔离 | 可选 Worktree (`isolation: 'worktree'`) | 并行文件操作不冲突；worktree 自动清理，无变更则 remove | `src/utils/worktree.ts` + `cleanupWorktreeIfNeeded()` |
| 同步 vs 异步 mode | sync：阻塞到 tool_result；async：注册后台任务立即返回 `async_launched` | 5 个触发条件：`run_in_background` / `agentDef.background` / coordinator / forceAsync / proactive + KAIROS（详见 §六.6.7） | `AgentTool.tsx:709-716` |
| Auto-background 兜底 | sync agent 跑超 120s 无进展自动转 async | 防止主 Agent 卡在慢 agent；可通过 `CLAUDE_AUTO_BACKGROUND_TASKS` 关闭 | `AgentTool.tsx:124-132` |
| 子 Agent 超时 | 取决于 AgentDefinition.maxTurns；后台模式 `getAutoBackgroundMs() = 120_000ms` | 防止子 Agent 无限运行；后台 agent 2 分钟无进展则自动 background | `AgentTool.tsx:124-132` |
| Fork 嵌套 | 禁止 (`isInForkChild` 检测 `<FORK_BOILERPLATE_TAG>`) | 防止 fork 爆炸；fork child 工具定义里仍有 AgentTool 仅供 cache-identical 定义 | `AgentTool.tsx:425-430` + `forkSubagent.ts:78-89` |
| Teammate spawn | 走 `spawnTeammate` 单独协议；受订阅/plan 限制；不能嵌套 spawn | Agent Teams 是另一类机制；与 subagent 工具不同生命周期 | `AgentTool.tsx:351-407` |

---

## 六、AgentTool 核心代码与生命周期

下面节选自 `packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx:322-458` 和 `runAgent.ts:257-499`，覆盖"声明/校验/调度"和"上下文构造/权限 override"两个阶段。每个代码段先讲意图再看源码——光看代码很难看出"为什么"。

### 6.1 入口与多 Agent（teammate）分流

AgentTool `call()` 入口需要做三件事：解析用户传入的 `subagent_type`/`team_name`/`name` 等参数、检查 Agent Teams 的前置条件、按优先级决定走哪条分支（teammate / fork / 普通 subagent）。

**关键参数语义**：

- `team_name + name` 同时存在 → 走 teammate 协议（Agent Teams 的成员）
- 只设 `subagent_type` → 走普通 subagent
- 都不设 → 看 `isForkSubagentEnabled()` 决定 fork 或 general-purpose 默认

```typescript
// AgentTool.tsx:322-407
async call(
  { prompt, subagent_type, description, model: modelParam,
    run_in_background, name, team_name, mode: spawnMode, isolation, cwd }: AgentToolInput,
  toolUseContext, canUseTool, assistantMessage, onProgress?,
) {
  const appState = toolUseContext.getAppState();
  const permissionMode = appState.toolPermissionContext.mode;
  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;

  // 校验: Agent Teams 订阅、teammate 嵌套限制...
  if (team_name && !isAgentSwarmsEnabled()) throw ...;
  if (isTeammate() && teamName && name) throw ...;
  if (isInProcessTeammate() && teamName && run_in_background === true) throw ...;

  // 分支 1: 多 Agent teammate spawn
  if (teamName && name) {
    const result = await spawnTeammate({ name, prompt, description, team_name: teamName,
      use_splitpane: true, plan_mode_required: spawnMode === 'plan',
      model: model ?? agentDef?.model, agent_type: subagent_type,
      invokingRequestId: assistantMessage?.requestId });
    return { data: { status: 'teammate_spawned', prompt, ...result.data } };
  }
```

**校验三个 if 的语义差异**：

- `team_name` 存在但 Agent Teams 订阅未启用 → 抛错（防止用户在没有订阅时误用 teammate API）。
- 已经在 teammate 上下文里又传 `teamName + name` → 抛错（防 teammate 嵌套 spawn——不能 agent A 内部又 spawn agent B）。
- In-process teammate 后台模式 → 抛错（in-process 实现不支持后台运行，必须有持久进程）。

### 6.2 Fork Subagent 与子 Agent 类型选择

**`effectiveType` 三态推导**：根据参数组合推导出最终要 spawn 的 agent 类型——这是 fork vs 普通 subagent 的分叉点。

```typescript
  // 分支 2: Fork vs 普通 subagent
  // - subagent_type set: 显式优先
  // - omitted + fork gate on: 隐式 fork (FORK_SUBAGENT feature)
  // - omitted + fork gate off: 默认 general-purpose
  const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
  const isForkPath = effectiveType === undefined;

  let selectedAgent: AgentDefinition;
  if (isForkPath) {
    if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}`
        || isInForkChild(toolUseContext.messages)) {
      throw new Error('Fork is not available inside a forked worker. ...');
    }
    selectedAgent = FORK_AGENT;
  } else {
    const agents = filterDeniedAgents(... allowedAgentTypes过滤 ...);
    const found = agents.find(a => a.agentType === effectiveType);
    if (!found) {
      const denyRule = getDenyRuleForAgent(appState.toolPermissionContext,
                                           AGENT_TOOL_NAME, effectiveType);
      throw new Error(`Agent type '...' has been denied by permission rule '...'.`);
    }
    selectedAgent = found;
  }
```

Fork 防递归采用 `querySource` + `isInForkChild` 双重检测，详见 §五.5.9。

**`filterDeniedAgents`**：先过滤掉用户 deny 规则命中的 agent（基于 `permissionContext`）和 `allowedAgentTypes` 白名单外的——这是权限层的第一道关。

### 6.3 隔离模式与 Worktree

**隔离优先级**：用户显式 `isolation` 参数 > agentDef 自带的 `isolation` 字段。两者都不设时默认继承父 cwd（不创建 worktree）。

```typescript
  // AgentTool.tsx:562-825
  // 有效隔离: 显式 param > agentDef.isolation
  const effectiveIsolation = isolation ?? selectedAgent.isolation;
  let worktreeInfo: { worktreePath; worktreeBranch? } | null = null;
  if (effectiveIsolation === 'worktree') {
    worktreeInfo = await createAgentWorktree(slug);
  }
  // fork + worktree 路径需要提示 child 翻译相对路径
  if (isForkPath && worktreeInfo) {
    // 注入 fork boilerplate 提示
    enhancedSystemPrompt = enhanceSystemPromptWith... etc.
  }
```

**为什么 fork + worktree 组合要额外注入提示**：

fork worker 继承了父的 system prompt，但实际跑在 worktree 目录下——父 prompt 里的相对路径需要重新映射，`buildWorktreeNotice()` 注入的提示告诉 worker 翻译路径并"在改文件前 re-read"。这也是 §十 列出的已知边界条件之一。

### 6.4 runAgent() 内部构造

`runAgent()` 是子 Agent 实际启动的入口。它接收 call() 阶段构造的 AgentDefinition 和裁剪过的工具集，做最终的上下文准备后调用 `query()`。

```typescript
// runAgent.ts:257-499 (节选)
export async function* runAgent({
  agentDefinition, promptMessages, toolUseContext, canUseTool, isAsync,
  querySource, override, model, availableTools, allowedTools, ...
}) {
  const appState = toolUseContext.getAppState();
  const permissionMode = appState.toolPermissionContext.mode;
  // rootSetAppState 始终写到根 AppState store:
  //   - 嵌套 async→async 时, parent.setAppState 是 no-op, 用 setAppStateForTasks
  const rootSetAppState = toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState;
  const resolvedAgentModel = getAgentModel(agentDefinition.model,
                                           toolUseContext.options.mainLoopModel,
                                           model, permissionMode);
  const agentId = override?.agentId ?? createAgentId();

  // transcript 分目录 (workflows/<runId>/...) 用 setAgentTranscriptSubdir

  // fork 路径: 继承部分 parent 历史消息; 否则空
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)  // 避免 API errors
    : [];
  const initialMessages: Message[] = [...contextMessages, ...promptMessages];

  // 文件读取缓存 fork vs 新建
  const agentReadFileState = forkContextMessages !== undefined
    ? cloneFileStateCache(toolUseContext.readFileState)
    : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);

  // 上下文压缩: Explore/Plan 跳过 CLAUDE.md + gitStatus
  const baseUserContext = override?.userContext ?? await getUserContext();
  const shouldOmitClaudeMd = agentDefinition.omitClaudeMd
    && !override?.userContext
    && getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true);
  const resolvedUserContext = shouldOmitClaudeMd ? stripClaudeMd(baseUserContext) : baseUserContext;

  const baseSystemContext = override?.systemContext ?? await getSystemContext();
  const resolvedSystemContext = (agentDefinition.agentType === 'Explore'
                                  || agentDefinition.agentType === 'Plan')
    ? stripGitStatus(baseSystemContext) : baseSystemContext;
```

**关键决策点的意图**：

- **`rootSetAppState`**：用 `setAppStateForTasks ?? setAppState` 兜底。子 agent 更新 UI 状态时，要写到根 store 而不是父 store——否则嵌套 async → async 时状态更新丢失。fallback 模式保证向后兼容。
- **`filterIncompleteToolCalls(forkContextMessages)`**：fork 路径继承父消息时，必须过滤掉没有对应 `tool_result` 的 `tool_use`——否则 LLM API 会报"messages must alternate" 错。
- **`cloneFileStateCache` vs 新建**：fork 路径要共享父的"已读文件"缓存（不重复 IO）；普通路径不共享（避免子 agent 假设父已读过的文件自己也能直接用——可能父上下文已 GC）。
- **`shouldOmitClaudeMd` 三个条件**：`agentDef.omitClaudeMd`（agent 类型自带）+ `!override?.userContext`（没有 override 强制注入）+ `tengu_slim_subagent_claudemd=true`（运营开关）。三者都满足才剥离——保留 override 通道（用户调试时可以强制注入 CLAUDE.md）。
- **`stripGitStatus` for Explore/Plan**：session start 时拿的 gitStatus 已经被标注为"explicitly labeled stale"——Explore/Plan 会自己跑 `git status` 拿新鲜数据，避免误导。

### 6.5 permission context override

子 Agent 跑自己的 query 循环时，需要构造一个**裁剪后的 permission context**——既要尊重 agentDef 的 `permissionMode`（如 `'plan'`、`'acceptEdits'`），又要处理 fork 路径的 `'bubble'` mode 弹窗转发、async agent 的"不允许弹窗"等细节。

```typescript
  // runAgent.ts:422-488
  // Permission mode 覆写: 但 bypassPermissions/acceptEdits/auto 始终高于 agentDef
  const agentPermissionMode = agentDefinition.permissionMode;
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState();
    let toolPermissionContext = state.toolPermissionContext;
    if (agentPermissionMode
        && state.toolPermissionContext.mode !== 'bypassPermissions'
        && state.toolPermissionContext.mode !== 'acceptEdits'
        && !(feature('TRANSCRIPT_CLASSIFIER')
              && state.toolPermissionContext.mode === 'auto')) {
      toolPermissionContext = { ...toolPermissionContext, mode: agentPermissionMode };
    }
    // 不能弹窗的 async agent → 设置 shouldAvoidPermissionPrompts
    const shouldAvoidPrompts = canShowPermissionPrompts !== undefined
      ? !canShowPermissionPrompts
      : agentPermissionMode === 'bubble' ? false : isAsync;
    if (shouldAvoidPrompts) {
      toolPermissionContext = { ...toolPermissionContext, shouldAvoidPermissionPrompts: true };
    }
    // 后台 agent 能弹窗时, 先 await 自动化检查再弹窗
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = { ...toolPermissionContext, awaitAutomatedChecksBeforeDialog: true };
    }
    // allowedTools: 替换 session allow rules (但保留 cliArg from --allowedTools)
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,  // 保留 SDK
          session: [...allowedTools],
        },
      };
    }
    return { ...state, toolPermissionContext };
  };
```

**5 个权限决策的优先级**：

1. **`bypassPermissions` / `acceptEdits` / `auto` 始终高于 `agentPermissionMode`**——用户显式选的 mode 优先级最高，不能被 agent 自己的定义覆盖。
2. **`shouldAvoidPermissionPrompts`**：async agent 默认不允许弹窗（用户不在屏幕前）。但 fork 路径的 `'bubble'` mode 是个例外——bubble 模式意味着"把弹窗转发到父终端"，需要保持 `canShowPermissionPrompts`。
3. **`awaitAutomatedChecksBeforeDialog`**：async agent **能**弹窗时，先等自动化检查（hook / 安全扫描）跑完再弹，避免快速连续弹窗。
4. **`allowedTools` 替换 session 规则**：把 agent 自己的 allowedTools 作为新的 session rule，但**保留 cliArg**——这是 SDK 用户通过 `--allowedTools` 传的规则，不能被 agent 覆盖（否则 SDK 失去权限边界）。
5. **`isAsync` 默认关闭弹窗**：`agentPermissionMode === 'bubble'` 是特例（fork worker 主动转发弹窗到父），其他 async 模式都关闭弹窗。

这五层叠加实现了"主 Agent 的高级 mode 不被破坏"、"子 Agent 的 permissionMode 在安全条件下生效"、"SDK 用户的 cliArg 始终保留"。

### 6.6 SendMessage：续接已停止的子 Agent

AgentTool 启动子 Agent 后，主 Agent 可能需要后续通信——SendMessage 填补了"启动"和"运行中/已停止的 agent 通信"之间的空白。

**SendMessage 是什么**：一个**独立的工具**（`packages/builtin-tools/src/tools/SendMessageTool/SendMessageTool.ts`），用于**给已存在的 agent / teammate 发消息**——和 AgentTool 是平行关系，不是上下位。AgentTool 是"启动新子 agent"，SendMessage 是"和已启动的 agent 通信"。

**为什么需要 SendMessage**：考虑这个场景——主 Agent 调用 `AgentTool({ subagent_type: 'general-purpose', prompt: '探索 X', run_in_background: true })`，子 Agent 启动后**立刻后台运行**，主 Agent 继续做别的事。过了一会儿主 Agent 想"子 Agent 探索得怎么样了？追加一个搜索条件"，怎么办？

- **再 spawn 一个新的子 Agent**：浪费——之前的探索上下文丢了，重新做。
- **用 SendMessage 给已存在的子 Agent 发消息**：保留子 Agent 的历史（从 sidechain transcript 加载），追加新任务。

**SendMessage 的 4 类目标**（`SendMessageTool.ts:555-577`）：

```
SendMessage({to: '<agentName>', message: '...'})        ← team 内 teammate 通信
SendMessage({to: '@team', message: '...'})              ← 广播给全 team
SendMessage({to: '<remote-id>', message: '...'})         ← Remote Control session（跨机器）
SendMessage({to: '<host:port>', message: '...'})         ← LAN peer（局域网直连）
```

**续接机制**：`SendMessageTool.ts:931-980` 实现了**自动 resume**——如果目标 agent 已停止（status 是 `completed`/`failed`），SendMessage 不会报错，而是：

1. 读 `subagents/agent-<id>.jsonl` sidechain transcript
2. 把 `message` 作为新 prompt 注入
3. 后台启动子 Agent 继续跑
4. 主 Agent 收到"Message queued for delivery at its next tool round"（运行中）或 "resumed from transcript in the background"（已停止）的反馈

**对应 tool_result 中的 agentId 提示**：你可能注意到 §五.5.8 的 tool_result 返回内容里有这样一行（`AgentTool.tsx:1582`）：

```
agentId: <id> (use SendMessage with to: '<id>' to continue this agent)
```

这就是**续接入口**——子 Agent 跑完后，主 Agent 看到这个 agentId 就知道"如果想追问/续接，调用 `SendMessage({to: '<id>', ...})`"。

**与 AgentTool / Fork / Teammate 的对比**：

| 机制 | 用途 | 关系 |
|------|------|------|
| AgentTool | 启动新子 Agent | "创建" |
| Fork | 全部继承父上下文 | AgentTool 的特殊 spawn 路径 |
| Teammate | 团队成员（持久身份） | AgentTool 的特殊 spawn 路径 |
| **SendMessage** | 续接 / 通信已存在的 agent | "通信"，不是创建 |

SendMessage 不是"启动"工具，是"通信"工具——延续已有 agent 的生命周期，而不是新建。它也是 Agent Teams 的核心通信机制——teammate 之间不能直接 spawn，但能通过 SendMessage 互发消息、传 plan approval / shutdown request 等结构化消息。

### 6.7 同步 vs 异步：子 Agent 的两种生命周期

子 Agent 的 `call()` 入口决定后，调度器还要做一个关键决策：**这个 agent 应该同步阻塞等待（sync），还是启动后立刻返回让主 Agent 继续（async / background）**。这两种模式的 tool_result 形式、tool_use_id 关联、SendMessage 续接路径都不同。

**同步模式（sync）**——绝大多数情况：

```
AgentTool.call({run_in_background: false, subagent_type: 'Explore', ...})
  │
  ├─► shouldRunAsync = false
  ├─► 启动 query() 协程 → 主 Agent 阻塞等待
  ├─► 子 agent 跑完整循环 → 出 tool_result
  └─► 主 Agent 收到 tool_result → 下一轮推理
```

主 Agent 的 tool_use_id 在调用前生成，子 agent 完成后回传 `tool_result` 配对——**tool_use_id 就是这两端的"配对 key"**（见 §五.5.8）。

**异步模式（async / background）**——少数情况：

```
AgentTool.call({run_in_background: true, ...})
  │
  ├─► shouldRunAsync = true
  ├─► registerAsyncAgent(agentId, description, prompt, ...)  ← 注册为后台任务
  ├─► 立刻返回 status: 'async_launched' 给主 Agent  ←  不等子 agent 跑完！
  └─► 子 agent 在后台跑 → 完成后发 <task-notification>（系统级通知注入主 Agent 下一轮）
```

主 Agent 拿到 `async_launched` 后立刻继续做别的事；子 agent 跑完时系统发 `<task-notification>` 给主 Agent，主 Agent 在下一轮看到通知可以决定要不要 `SendMessage` 续接。

**5 个触发 async 的条件**（`AgentTool.tsx:709-716`）：

```typescript
const shouldRunAsync =
  (run_in_background === true ||          // ① 用户显式声明
   selectedAgent.background === true ||     // ② agent 定义里 background: true
   isCoordinator ||                         // ③ coordinator mode 自动后台
   forceAsync ||                            // ④ 内部强制（auto-background 触发）
   assistantForceAsync ||                   // ⑤ KAIROS assistant 自适应
   (proactiveModule?.isProactiveActive() ?? false)) && // ⑥ proactive mode
  !isBackgroundTasksDisabled;               // 全局开关可关闭所有 background
```

**4 种触发的具体场景**：

- **`run_in_background: true`（用户显式）**：用户/模型明确说"我先做别的，这个 agent 后台跑"。最常见——比如 "启动一个 general-purpose 探索 X 模块，我继续打字"。
- **`agentDef.background: true`（agent 定义）**：自定义 agent 在 frontmatter 声明 `background: true`，意味着"这个 agent 永远后台跑"（如长跑监控类 agent）。
- **coordinator mode 自动**：coordinator agent 派生 worker 时强制后台，避免阻塞 coordinator。
- **proactive / KAIROS 自适应**：系统判断"这个任务值得后台跑"时自动转（如长期定时任务）。

**Auto-background timer**（`AgentTool.tsx:124-132`）：

```typescript
function getAutoBackgroundMs(): number {
  if (env CLAUDE_AUTO_BACKGROUND_TASKS 或 feature('tengu_auto_background_agents')) {
    return 120_000;  // 2 分钟
  }
  return 0;  // 禁用
}
```

即便用户没显式 `run_in_background: true`，如果 sync agent 跑了 **2 分钟还没出 tool_result**，系统**自动**把它转后台。这是给"没想到会跑这么久的 agent"兜底——避免主 Agent 卡在一个慢 agent 上几十分钟。

**async 模式的 tool_result 形态**（`AgentTool.tsx:902-912`）：

```typescript
return {
  data: {
    isAsync: true,
    status: 'async_launched',         // ← 关键标识
    agentId: agentBackgroundTask.agentId,
    description, prompt,
    outputFile: getTaskOutputPath(agentId),
    canReadOutputFile,                // 父 agent 是否有 Read/Bash 工具能读 outputFile
  },
};
```

父 Agent 看到 `status: 'async_launched'` 就知道"它已经在跑了，我继续干别的"，等 `<task-notification>` 通知它回来。

**Sync 模式的最终态**（对比）：

```typescript
// sync agent 完成时
return {
  data: {
    isAsync: false,
    agentId, agentType,
    content: [{type:'text', text:'<final summary>'}],  // ← 真正的结果文本
    totalDurationMs, totalTokens, totalToolUseCount,
  },
};
```

**与 SendMessage 的关系**：

- **sync agent**：跑完就结束，不需要 SendMessage——结果已经在 tool_result 里。
- **async agent**：跑完后变成 background task；想追问时调 `SendMessage({to: agentId})`（详见 §六.6.6）。
- **auto-backgrounded agent**：原本 sync 但超时被转后台的 agent，**最终形态也是 async**——SendMessage 同样适用。

**与 §五.5.9 并发控制的关系**：

async 模式让"长跑任务"和"主 Agent 短任务"可以同时跑——主 Agent 不被慢 agent 阻塞。这是 §五.5.9 "并发模型：同轮并行 + 跨轮串行" 的延伸：**跨轮也允许并行**，只要新任务是 async。

---

## 七、内置子 Agent 类型体系

| Agent 类型 | 工具集 | 典型用途 | subagent_type 值 | 默认 sync/async | 证据 |
|-----------|--------|--------|-----------------|-----------------|------|
| Explore | Read, Grep, Glob (只读) | 代码库探索、搜索 | `"Explore"` | sync（可显式 async） | `packages/builtin-tools/src/tools/AgentTool/built-in/` |
| Plan | 只读 + ExitPlan | Plan 模式调研 | `"Plan"` | sync | built-in |
| general-purpose | 受限全集 (`['*']` 风格) | 通用子任务 | `"general-purpose"` | sync | `builtInAgents.ts` |
| statusline-setup | 读 + 修改 statusLine 配置 | statusLine 配置 | `builtInAgents` | sync | 特定场景 |
| Explore-Plan (v2 多 Agent) | 同 Explore | 多 Explore agent 并行 | 通过 `getPlanModeV2AgentCount` 启用 | sync | `planModeV2.ts` |
| Fork (隐式) | 父完全相同 | 后台并行处理 directive | 省略 subagent_type | **async**（fork worker 本来就是后台） | `forkSubagent.ts:FORK_AGENT` |
| Teammate (显式) | agentDef 决定 | Agent Teams 中的一员 | 显式 `name + team_name` | **always async**（teammate 本身就是后台进程） | `spawnTeammate` |
| 自定义 (`.claude/agents/`) | frontmatter `tools` 字段 | 用户/插件自定义 | 用户 frontmatter 文件名 | sync 或 async（看 `background` 字段） | `loadAgentsDir.ts` |

**sync/async 列的含义**：

- **默认 sync**：用户不传 `run_in_background: true` 时是 sync——主 Agent 阻塞等待结果。
- **默认 async**：fork 和 teammate 本身就是后台机制（详见 §六.6.7）。
- **可显式 async**：sync agent 通过 `run_in_background: true` 或 `background: true` frontmatter 字段可转 async。

`ONE_SHOT_BUILTIN_AGENT_TYPES`（一次性内置类型，如 Explore/Plan）有单独的结果展示（`AgentTool.tsx:1568`：无 worktree 信息时单独路径），与 teammate 不同。

### 7.1 Prompt 层面的隔离机制

子 Agent（AgentTool fork 出去的）**复用** 主 Agent 的 `queryLoop` 状态机和流式链路，但**替换** system prompt 和工具白名单。这是 prompt 层面的能力隔离——子 Agent 看到一个完全不同的"自己"。

**三种 agent 的 system prompt 来源**：

- **主 Agent**：走 `getSystemPrompt()`（`src/constants/prompts.ts:410`），接收完整 15+ 段 prompt（详见 [03-agent-loop](cc-03-agent-loop.md) §5.6-§5.7）。
- **内置子 Agent**：每个内置子 Agent 在 `packages/builtin-tools/src/tools/AgentTool/built-in/` 下有自己的 `getSystemPrompt()`。
- **自定义 Agent**：从 `src/main.tsx:2666` 可见，自定义 Agent 通过 `customAgent.getSystemPrompt()` 完全替换 prompt，**不再叠加主 Agent 的 system prompt**——这是默认假设"自定义 Agent 有自己的定位"。`getSystemPrompt` 方法的签名（`src/main.tsx:4620` 注释）表明：内置 Agent 的 getSystemPrompt 接收 `(tools, model)` 参数（依赖运行时工具列表），自定义 Agent 的 getSystemPrompt 不接收参数（完全静态）。

**为什么 prompt 隔离比上下文注入更彻底**：

如果用"上下文注入"实现子 Agent——主 Agent 在 prompt 里写一段"现在你是 Explore agent..."——子 Agent 仍然带着主 Agent 的全部指令（15+ 段 prompt、CLAUDE.md、gitStatus），浪费 token + 干扰决策。**直接替换 system prompt** 让子 Agent 看到的是 1-2 段的精简指令，配合 §五.5.7 的 `omitClaudeMd` 进一步瘦下来，fleet 节省显著。

**`getSystemPrompt` 签名差异的工程含义**：

- 内置 `getSystemPrompt(tools, model)`：**动态生成**——根据运行时工具列表动态拼 prompt 片段（如 Plan agent 会根据可用工具决定是否提示 ExitPlanMode）。
- 自定义 `getSystemPrompt()`：**完全静态**——直接返回 body 原文，没有任何运行时依赖。这降低了用户写自定义 agent 的心智负担（不需要懂运行时机制），代价是灵活性更低——用户不能在 body 里用 `tools` 变量。

### 7.2 Explore Agent 的完整 prompt（`exploreAgent.ts:13-57`）

定位：只读搜索专家。主 Agent 在需要"快速找到文件 / 搜索关键字 / 了解 codebase 结构"时调用它。

**完整 prompt**：

```
You are a file search specialist for Claude Code, Anthropic's official CLI for Claude.
You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have
access to file editing tools - attempting to edit files will fail.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching          ← (或 find via Bash, 如果 embedded tools)
- Use Grep for searching file contents with regex  ← (或 grep via Bash, 如果 embedded tools)
- Use Read when you know the specific file path you need to read
- Use Bash ONLY for read-only operations (ls, git status, git log, git diff,
  find, grep, cat, head, tail)
- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit,
  npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt
  to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible.
In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about
  how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for
  grepping and reading files

Complete the user's search request efficiently and report your findings clearly.
```

**配套元数据**（`EXPLORE_AGENT` 对象）：

| 字段 | 值 | 含义 |
|------|-----|------|
| `agentType` | `'Explore'` | Agent 标识符 |
| `model` | `'inherit'`（ant 内）或 `'haiku'`（外部用户） | Ant 用户继承主 Agent 的模型；外部用户走 haiku 节省成本 |
| `omitClaudeMd` | `true` | 跳过 CLAUDE.md 注入——主 Agent 已经读过，不需要重复 |
| `disallowedTools` | `[Agent, ExitPlanMode, Edit, Write, NotebookEdit]` | **物理移除**写工具——不只是 prompt 警告 |
| `whenToUse` | "Fast agent specialized for exploring codebases..." | 主 Agent 看到 `whenToUse` 决定何时调用 |

### 7.3 Plan Agent 的完整 prompt（`planAgent.ts:14-71`）

定位：软件架构师 / 计划设计专家。主 Agent 在需要"为任务设计实现方案"时调用它。

**完整 prompt**（节选关键段，省略重复的 READ-ONLY 警告）：

```
You are a software architect and planning specialist for Claude Code. Your role
is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
（与 Explore 相同的禁止清单，省略）

You will be provided with a set of requirements and optionally a perspective on
how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply
   your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using Glob, Grep, and Read
     （或 find, grep via Bash, 如果 embedded tools）
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use Bash ONLY for read-only operations (...)
   - NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, ...

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit,
or modify any files. You do NOT have access to file editing tools.
```

**配套元数据**（`PLAN_AGENT` 对象）：

| 字段 | 值 | 含义 |
|------|-----|------|
| `agentType` | `'Plan'` | Agent 标识符 |
| `model` | `'inherit'` | 继承主 Agent 的模型——架构设计需要推理能力，不用 haiku |
| `omitClaudeMd` | `true` | 跳过 CLAUDE.md——但如果需要约定 Plan 可以自己 Read |
| `disallowedTools` | 同 Explore | 物理移除写工具 |
| `tools` | 复用 `EXPLORE_AGENT.tools` | 工具白名单继承 Explore |

**为什么强制输出 `### Critical Files` 段？** 主 Agent 解析 Plan agent 的响应时，可以用正则提取这一段，把"关键文件路径"直接喂给后续的工具调用。这是一种**结构化输出的约定**——Plan agent 知道自己的输出会被解析，所以 prompt 强制要求。

### 7.4 general-purpose Agent 的完整 prompt（`generalPurposeAgent.ts:3-23`）

定位：通用 Agent，主 Agent 没有更专门的子 Agent 可用时兜底。`tools: ['*']` 意味着所有工具都可用——没有 READ-ONLY 限制。

**完整 prompt**（短）：

```
You are an agent for Claude Code, Anthropic's official CLI for Claude. Given
the user's message, you should use the available tools to complete the task.
Complete the task fully—don't gold-plate, but don't leave it half-done.

When you complete the task, respond with a concise report covering what was done
and any key findings — the caller will relay this to the user, so it only needs
the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives.
  Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if
  the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions,
  look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal.
  ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only
  create documentation files if explicitly requested.
```

**配套元数据**：

| 字段 | 值 | 含义 |
|------|-----|------|
| `agentType` | `'general-purpose'` | Agent 标识符 |
| `tools` | `['*']` | 所有工具可用——没限制 |
| `model` | 省略 | 用 `getDefaultSubagentModel()` 返回的默认值 |

**与 Explore / Plan 的对比**：

| 维度 | Explore | Plan | general-purpose |
|------|---------|------|-----------------|
| READ-ONLY | ✅ 强约束 | ✅ 强约束 | ❌ 可写 |
| 工具白名单 | 受限（无 Edit/Write） | 受限（无 Edit/Write） | 全开 |
| 强制输出格式 | ❌ | ✅ `### Critical Files` 段 | ❌ |
| 适用场景 | 搜索定位 | 设计方案 | 兜底多步任务 |

### 7.5 claude-code-guide Agent（`claudeCodeGuideAgent.ts:23+`）

定位：Claude Code / SDK / API 文档专家。当用户问"Claude Code 怎么用 / SDK 怎么搭 / API 怎么调"时调用。

**Prompt 开头段**（总长 ~180 行，下面是前 1/3）：

```
You are the Claude guide agent. Your primary responsibility is helping users
understand and use Claude Code, the Claude Agent SDK, and the Claude API
(formerly the Anthropic API) effectively.

**Your expertise spans three domains:**

1. **Claude Code** (the CLI tool): Installation, configuration, hooks, skills,
   MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Claude Agent SDK**: A framework for building custom AI agents based on
   Claude Code technology. Available for Node.js/TypeScript and Python.

3. **Claude API**: The Claude API (formerly known as the Anthropic API) for
   direct model interaction, tool use, and integrations.

**Documentation sources:**

- **Claude Code docs** (https://code.claude.com/docs/en/claude_code_docs_map.md):
  Fetch this for questions about the Claude Code CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **Claude Agent SDK docs** (https://platform.claude.com/llms.txt): Fetch this
  for questions about building agents with the SDK, including:
  - SDK overview and getting started (Python and TypeScript)
  - Agent configuration + custom tools
  - Session management and permissions
  - MCP integration in agents
  - Hosting and deployment
  - Cost tracking and context management

- **Claude API docs** (https://platform.claude.com/llms.txt): Fetch this for
  questions about the Claude API ...
```

后续段继续列举 API 各类细节（Messages API、streaming、tool use、prompt caching 等），最后以"回答时引用具体文档 URL、用 WebFetch 验证最新内容、不要凭记忆"等指引结束。

**配套元数据**（`CLAUDE_CODE_GUIDE_AGENT` 对象）：

| 字段 | 值 | 含义 |
|------|-----|------|
| `agentType` | `'claude-code-guide'` | Agent 标识符 |
| 工具白名单 | 受限（不能写代码——只是文档查询） | 物理隔离 |
| 角色 | "you are the Claude guide agent" | 限定只回答"使用 Claude 工具"的问题 |
| 文档源 | 3 个 URL（Claude Code / SDK / API docs map） | 所有回答必须基于 fetch 后的真实文档，不能凭记忆 |

### 7.6 子 Agent prompt 的共同模式

观察 4 个内置子 Agent 的 prompt，可以提炼出 4 个共同设计模式：

1. **角色重置**——每个子 Agent 的第一行都是 "You are [role] for Claude Code"，而不是继承主 Agent 的身份。`Explore` 是 search specialist，`Plan` 是 architect，`general-purpose` 是 agent，`claude-code-guide` 是 guide agent。

2. **能力边界明示**——Explore / Plan 都用 `=== CRITICAL: READ-ONLY MODE ===` 强约束开头，不依赖后续的 "guidelines" 段。这是 prompt 工程的常见技巧——把最重要的约束放在最显眼的位置。

3. **工具 = 物理隔离**——`disallowedTools` 字段从工具白名单里移除写工具。子 Agent 即使在 prompt 里忽略"不要 Write"的警告，工具调用也会失败（不存在 Write 工具的 schema）。**Prompt 警告 + 工具移除是双保险**。

4. **结构化输出约定**——Plan agent 强制以 `### Critical Files for Implementation` 段落结尾，方便主 Agent 用正则解析。general-purpose 提示 "respond with a concise report"——隐含期望调用方解析关键信息。

以上 4 个设计模式也是**用户写自定义 agent prompt 的参考模板**——下一章 §八 介绍如何在 `.claude/agents/*.md` 文件里实现。

---

## 八、声明式 Agent 定义系统（用户/项目自建子 Agent）

除了内置 6 个 agent（Explore / Plan / general-purpose / statusline-setup / claude-code-guide / verification），Claude Code 允许用户在文件系统中**声明式定义**自己的 subagent——一个 markdown 文件描述 agent 的角色、工具集、模型、权限、行为约束，运行时和内置 agent 一视同仁。

### 8.1 为什么需要声明式

内置 agent 覆盖常见场景，但用户/团队有自己的工作流：

- "**code-reviewer**"：每次 PR review 用，要求工具集只有 Read/Grep/Glob（不能写文件）。
- "**test-runner**"：CI 复盘时跑测试、读结果、写代码补丁，需要 Bash + Write。
- "**doc-writer**"：专门写文档，工具集裁剪到 Read/Write/Edit，model 用 haiku（够用且便宜）。

如果每次都要写 TS 代码注册 agent，门槛太高——团队成员要会编译、要会读 codebase、要会写 zod schema。**声明式让用户用熟悉的 markdown + YAML 即可定义 agent**，零代码成本。

### 8.2 文件格式

每个 agent 一个 `.md` 文件，YAML frontmatter 描述元数据，body 是 system prompt：

```markdown
---
name: code-reviewer
description: "Reviews code changes and flags issues"
tools: Read, Grep, Glob, Bash
model: inherit
permissionMode: acceptEdits
memory: project
---

You are a code reviewer for this project.

## What you do
- Review changed files for style, correctness, and security
- Output a list of issues with file:line references

## Constraints
- Never modify files
- Never push to remote
```

**frontmatter 字段总览**（必填 `name` + `description`，其他可选）：

| 字段 | 类型 | 作用 | 典型场景 |
|------|------|------|---------|
| `name` | string | **必填**。agent 类型标识，主 Agent 通过 `AgentTool({ subagent_type: 'code-reviewer' })` 调用 | `code-reviewer` |
| `description` | string | **必填**。传给 LLM 的"何时使用"说明，让主 Agent 知道这个 agent 擅长什么 | `"Reviews code changes and flags issues"` |
| `tools` | 逗号分隔 | 工具白名单。`*` 表示全工具；缺省时等同于 `*`（fail-open） | `Read, Grep, Glob, Bash` |
| `disallowedTools` | 逗号分隔 | 工具黑名单（在 `tools` 基础上再排除） | `Bash` 移除以阻止 shell |
| `model` | string | `inherit`（继承父）或具体模型名 | `inherit` / `haiku` |
| `effort` | string/int | 推理力度（low/medium/high 或数字） | `low` 用于轻量 review |
| `permissionMode` | enum | `default` / `acceptEdits` / `bubble` / `plan` 等 | `acceptEdits` 自动批准 edit |
| `mcpServers` | array | 该 agent 专属的 MCP 服务器（按名字引用或 inline 配置） | 接入项目专用 MCP |
| `hooks` | object | 该 agent 启动时注册的 PreToolUse / PostToolUse 等 hooks | 阻止某些 tool_use 模式 |
| `maxTurns` | number | 最大轮数限制（防止失控循环） | `20` 防止 agent 死循环 |
| `skills` | array | 启动时预加载的 skill 名称 | 自动注入团队规范 |
| `initialPrompt` | string | 在第一个 user turn 前面插入的内容 | 自动注入"先读 CLAUDE.md" |
| `memory` | `user` / `project` / `local` | 持久 memory scope | `project` 让 agent 跨会话记项目上下文 |
| `background` | bool | 总是作为后台任务 spawn（async 模式）—— 调用方不阻塞，结果通过 `<task-notification>` 或 `SendMessage` 续接（详见 §六.6.7） | `true` 用于长跑任务（监控/定时） |
| `isolation` | `worktree` / `remote`（ant only） | 默认 worktree 隔离 | `worktree` 让并行的 agent 不冲突 |
| `color` | string | UI 显示颜色 | 区分多个 agent 类型 |

### 8.3 文件发现与运行时注入全景图

agent 文件从磁盘到主 Agent 可调用，经历"扫描 → 解析 → 合并 → 注入"四步：

```
文件系统层（三层目录自动发现）
  ~/.claude/agents/*.md                       ← 用户全局（userSettings）
  ${MANAGED_FILE_PATH}/.claude/agents/*.md    ← 企业托管（policySettings）
  ${cwd}/.claude/agents/*.md                  ← 项目级（projectSettings，向上遍历到 home）
  ${main_repo}/.claude/agents/*.md            ← git worktree 回退（sparse-checkout 时）
            ↓
扫描层（markdownConfigLoader.ts:297-372）
  - 并发加载 managed + user + project 三个目录
  - worktree 不带 .claude/agents/ 时回退到 main repo
  - 用 inode 识别同一物理文件（处理 ~/.claude 是项目内符号链接的情况）
            ↓
解析层（loadAgentsDir.ts:542-756）
  每个 .md 文件 → parseAgentFromMarkdown()
    → 提取 YAML frontmatter（YAML 解析器复用）
    → 缺失 'name' 或 'description' → 静默跳过（允许非 agent 的 md 文档共置）
    → 字段类型/范围校验（不合法仅 logForDebugging，不阻断）
    → memory 副作用：自动注入 Write/Edit/Read
    → 构造 CustomAgentDefinition { getSystemPrompt: () => content.trim() }
            ↓
合并层（loadAgentsDir.ts:193-221, 296-393）
  allAgents = [...builtIn, ...plugin, ...custom]
       ↓
  getActiveAgentsFromList() → Map<agentType, AgentDefinition>
    按 builtIn < plugin < user < project < flag < managed 顺序写入
    后写入不覆盖前 → managed 优先级最高
       ↓
注入层（运行时）
  activeAgents 数组暴露给 AgentTool
    → 主 Agent 调用 AgentTool({ subagent_type: 'code-reviewer' })
    → 调度器在 activeAgents 中查找
    → 找不到 → 注入 is_error: true（"Unknown subagent type: code-reviewer"）
```

### 8.4 字段处理的副作用（隐藏在解析器里的"魔法"）

字段不是简单赋值就完事——解析器会做几件用户看不见的事，**理解这些副作用能解释为什么"明明没写 tools，agent 也能读写文件"**：

- **`tools: '*'` 或缺省 = 全工具**：`parseAgentToolsFromFrontmatter()` (`markdownConfigLoader.ts:118-123`) 把 `*` 翻译为 `undefined`，缺省等同 `undefined`，运行时视为无限制——fail-open，避免 typo 静默丢失能力。
- **`memory=user/project` 自动注入 Write/Edit/Read**：`loadAgentsDir.ts:663-675`，如果 `memory` 已声明且 `tools` 已声明（不等于全工具），自动把这三个工具加入白名单。否则 agent 记住了东西却写不进去——一个反直觉的坑。
- **`model: inherit` 归一化小写**：`loadAgentsDir.ts:569-574`，无论写 `Inherit`/`INHERIT` 都归一为 `'inherit'`，避免 prompt cache 因大小写失配。
- **`isolation: remote` 仅 ant 用户可用**：`loadAgentsDir.ts:610-611`，非 ant 用户的 `remote` 值被静默忽略（仅 debug log），避免外部构建报错。
- **frontmatter 字段拼写错误不阻断**：例如 `tools: FileRead,FileEdit` 写错工具名（实际不存在 `FileRead`）—— zod 解析为字符串数组，**不报错也不警告**；运行时主 Agent 看到 `is_error: true` 才知道。

### 8.5 与内置 agent 的运行时等价性

合并后，**自定义 agent 与内置 agent 完全等价**——`getActiveAgentsFromList`（`loadAgentsDir.ts:193-221`）按 agentType 写入 Map：内置 agent 在前，自定义 agent 在后；同 agentType 时**后写入的覆盖先写入的**（managed 优先级最高，因此可以覆盖内置 `general-purpose`）。

主 Agent 通过 `AgentTool({ subagent_type: 'code-reviewer' })` 调用时，调度器在 activeAgents 数组里查找——找不到时返回 `Unknown subagent type: code-reviewer` 错误，和内置 agent 的失败路径**完全相同**。

### 8.6 关键设计决策

**1. 完全替换 system prompt。** 与内置 agent 的 `getSystemPrompt: (params) => string` 不同，自定义 agent 的 `getSystemPrompt: () => string` 是无参函数——**body 原文即 system prompt**，不再叠加主 Agent 的 prompt 模板。设计意图：自定义 agent 是"有独立身份的新角色"，不是"主 Agent 的子集"。如果用户想保留主 Agent 上下文，可以手动在 body 里 `You are a specialized agent based on Claude Code.`。

**2. Zod schema 强校验，但宽容失败。** `AgentJsonSchema`（`loadAgentsDir.ts:73-99`）用 zod 校验所有字段，但解析失败只 `logForDebugging`（`loadAgentsDir.ts:329-330`），**不抛出、不阻断**其他 agent 加载。一个 agent 文件写坏了，其他 agent 照常工作。这是"局部失败不影响整体"的工程取舍。

**3. tools 缺省 = 全工具（fail-open）。** `tools: ['*']` 或省略 `tools` 都表示全工具可用。如果用户写错 tools 字段名（typo），agent 仍能用所有工具——**与 §五.5.6 中 `isConcurrencySafe` 的 fail-closed 策略形成对比**：安全字段默认关闭（`isConcurrencySafe=false`），能力字段默认开放（`tools=undefined`）。两种默认值方向相反，因为错把只读标成可写是数据竞争灾难（fail-closed 拒绝代价小），错把可写工具丢光是用户体验灾难（fail-open 保留能力代价小）。

**4. memory 字段自动注入 Write/Edit/Read。** 当 `memory=user/project/local` 时，如果 `tools` 已经声明，自动补这三个工具——否则 agent 记住了东西却写不进去。注释（`loadAgentsDir.ts:663`）明示："If memory is enabled, inject Write/Edit/Read tools for memory access"。这暗示 `tools: []`（空数组）是合法值，区别于缺省。

### 8.7 局限

- **无版本管理**：修改 agent 文件后立即生效，无版本号、无 git ref、无回滚。出问题时只能靠 git 找回旧版本。
- **无依赖声明**：agent A 内部想调用 agent B 时，B 必须先单独注册；无法在 frontmatter 里声明"B 必须存在"。
- **同 agentType 跨 source 冲突时静默覆盖**：用户定义 `general-purpose` 会覆盖内置同名 agent，**没有警告**——可能在用户不知情的情况下改变默认行为。
- **frontmatter 字段错写无诊断**：`tools: FileRead,FileEdit` 写错工具名（实际不存在）会被 zod 解析为字符串数组，**不报错也不警告**；只有运行时主 Agent 看到 `is_error: true` 才知道工具不存在。debug 体验差。

---

## 九、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 上下文继承策略 | 大多数不继承对话历史（fork 除外） | 全部继承 | 大多数 subagent 任务是独立的（"探索 X"）；fork 路径特例明示语义 |
| Fork 路径 | 全部继承 + 强 SOP | 折中 | Fork 是"继续上次对话做子任务"，不是新任务；必须继承；但 SOP 必须约束 child 行为防止爆炸 |
| Fork 输出格式 | `Scope/Result/...` 固定段落 | 自然语言 | 父亲可以 grep 字段、解析 status、估算 token——固定段落天然友好 |
| Result 回传方式 | 摘要（最后一条 assistant） | 完整 transcript | 完整 transcript 会撑爆父 context；摘要足够主 Agent 决策 |
| 并发模型 | 同轮并行 + 跨轮串行 | 全局并行池 | 利用 LLM 同轮 tool_use 的天然并行性，不需要额外调度器 |
| 工具集约束 | 按 Agent 类型白名单 (`agentDef.tools`) | 全给 | 最小权限——Explore 不需要写文件，给反而危险 |
| 子 Agent 类型 | 预定义 + 自定义 frontmatter | 纯动态定义 | 预定义覆盖常见场景（Explore/Plan/Review/General），custom 提供灵活 |
| Worktree 隔离 | 用户显式 `isolation: 'worktree'` | 默认 always | 默认继承 cwd 让大多数 case 自然；需要并行的用户显式声明 |
| Worktree 清理策略 | 无变更 → 移除，有变更 → 保留 + 通知 | always keep | 节省磁盘；变更则保留让用户合并/review |
| claudeMd 剥离 (Explore/Plan) | 默认剥离，`tengu_slim_subagent_claudemd=false` 可关 | always include | Anthropic fleet 数据显示 Explore spawns 是高频上下文浪费源 |
| Fork cache 优化 | byte-identical API prefix (`useExactTools`, renderedSystemPrompt 透传) | 各 child 不同 | Fork 路径大量并发时 prompt cache 命中直接砍成本 |
| Fork 防递归 | 检测 `<FORK_BOILERPLATE_TAG>` + `querySource` 双保险 | 时序检查 | `querySource` 在 spawn 时设、autocompact 改写后还在；tag fallback 安全网 |
| 自定义 agent 文件格式 | YAML frontmatter + markdown body | JSON / TOML / 纯 TS | 与现有 `CLAUDE.md` / slash command 复用同一套 frontmatter 解析器（`markdownConfigLoader.ts`），零新代码 |
| 自定义 agent tools 默认 | 缺省/`*` = 全工具（fail-open） | 缺省 = 无工具（fail-closed） | agent 工具集是能力字段，typo 时不该静默失去能力；安全字段（`isConcurrencySafe`）才该 fail-closed |
| 自定义 agent system prompt | 完全替换（body 原文） | 继承主 Agent + 增量 | 自定义 agent 是"有独立身份的新角色"，不是"主 Agent 的子集"——避免两套 prompt 互相干扰 |
| 自定义 agent 解析失败 | logForDebugging + 跳过该文件，不阻断其他 | 任一文件失败就回退到内置 | 一个文件写坏不该破坏整个 agent 加载；zod schema 已保证关键字段被校验 |
---

## 十、可复用的模式

- **Fork-Join 隔离模式**：独立上下文执行复杂子任务，摘要回传。主 Agent 只看到结论，不被中间过程淹没。
- **最小权限子 Agent 模式**：按子 Agent 的职责（探索/审查/调试）裁剪工具集，不是"全部给"。
- **Agent 类型注册模式**：预定义类型（Explore/Plan/General/Review 等），每种类型有固定的工具集、System Prompt 模板和行为约束。可扩展自定义 frontmatter 类型。
- **Transcript 独立记录模式**：每个子 Agent 的 transcript 写入独立文件（`subagents/agent-<id>.jsonl`），便于审计、调试、Resume。
- **Cache 共享 Fork 模式**：父子 byte-identical API prefix + 占位 tool_result + per-child directive，最大化 prompt cache 命中。
- **上下文压缩可开关模式**：`tengu_slim_subagent_claudemd` Gate 让"剥离 vs 继承"成为运营参数，不写死在代码里。
- **Worktree 自动回收**：根据文件变更检测决定是否清理 worktree——既给并发安全也不留磁盘孤儿。
- **声明式扩展点模式**：用文件 + frontmatter 让用户扩展系统行为（agent / slash command / skill / hook 都用 markdown + YAML），不要求写 TS 代码——降低贡献门槛、与 CLAUDE.md 复用同一解析器。

