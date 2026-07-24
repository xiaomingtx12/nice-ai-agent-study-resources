---
sidebar_position: 5
description: "Context 是软件策略不是窗口机制。两轴展开：轴 1 上下文管理技巧（分层注入、压缩分层级、Prompt Cache、token 预算、提示词组装、会话隔离、错误自愈、行为干预）；轴 2 记忆系统（分层、检索、遗忘、状态外部化、多轮设计）。"
---

# Context 篇

Context 是软件策略不是窗口机制。读这篇之前你应该对 Agent 大脑的循环有基本认知——本篇聚焦"每轮上下文怎么装"和"跨 session 记忆怎么管"两条主线。

工程化的核心拉扯有两组：
- 信息充分 ↔ 成本 / 注意力稀释（token 预算、注意力随上下文增长而递减、KV Cache 膨胀）
- 持久 ↔ 检索 / 遗忘（存得多检索慢、存得少上下文不够；忘得太快用户觉得 AI 失忆，忘得太慢信息污染）

---

## 一、动机

Context 是大脑每轮 Reason 之前组装 prompt 那一刻的工程化设计。下游连着 CoT、Tool 调用、Cache 命中、压缩触发、记忆检索。

本篇分两轴：
- **轴 1 上下文管理技巧**：每轮 / 单 session 内的工程化（分层注入、压缩分层级、Prompt Cache、token 预算、提示词组装、会话隔离、错误自愈、行为干预）
- **轴 2 记忆系统**：跨 session 的工程化（分层、检索、遗忘、状态外部化、多轮设计）

与 Agent 大脑篇的边界：
- 大脑篇判断"压缩对思维链的破坏"是思考过程视角
- 本篇展开"压缩算法本身 / token 预算分配 / cache 命中 / 死循环防卡"等工程细节

---

## 二、关键判断速览

### 轴 1 · 管理技巧

- 提示词组装本身是动态加载架构：`内核 \<1K token` + `AGENTS.md`（项目规范）+ `Skills`（外挂），不是单一字符串拼接（10）
- System Prompt 按稳定性分层注入（`string[]` 数组 + `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`），不拼成单一字符串
- 工具定义全程稳定，动态增删让 cache key 失配
- Token 预算用动态残差（`rest_tokens = context_size - max_tokens - curr_message_tokens`），不用固定配额
- 超预算时按 User 边界整轮丢弃，不按条数丢（单条删会产生 orphan ToolResult）
- Session 物理隔离：`map[workDir]*Session` + `sync.RWMutex`，每 WorkDir 一份独立上下文内存（11）
- Working Memory 滑动窗口：截最近 N 条 + 预估 Token 量，超阈值即触发摘要（11）
- 压缩分层级（5 阶段：原地缩减 → snip → microcompact → server-side → LLM summary），不上来就调 LLM
- 双重降级压缩：物理防线先于业务逻辑，远期 Observation Masking 全量掩码 + 短期 Head-Tail Truncation（12）
- Prompt Cache 分层：static 段跨用户稳定 / dynamic 段按会话重算 / scratchpad 不进 cache
- 错误自愈：在 ToolResult 路径上劫持错误，分类器匹配后注入"系统救援指南"祈使句，迫 LLM 走标准排障 SOP（14）
- 行为干预 / 防死循环：Doom Loop 指纹检测 + 在 Main Loop 尾部以 `RoleUser` 注入强力修正指令（角色权重 = 最高近因效应）（15）

### 轴 2 · 记忆系统

- 长期记忆"索引常驻 + 全文按需"（MEMORY.md ≤200 行 / 25KB 注入 system，全文按 Prefetch 召回）
- 记忆分四层（session / user / domain / global），每层生命周期与注入策略不同
- 状态外部化：把宏观规划落 `PLAN.md`、粒度待办落 `TODO.md`，断点续传靠文件（13）
- PlanMode 架构开关：简单任务不开避免官僚化，复杂任务强制注入规范（13）
- Bootstrapping 分支：嗅 `PLAN.md`/`TODO.md` 是否存在 → A 新建 / B 断点续传不覆盖（13）
- 记忆检索默认向量召回，辅以关键词 / 图谱混合
- 遗忘策略三层兜底（容量上限 + 时间衰减 + 重要性淘汰 + 用户显式清除）
- 多轮对话的 Session 是物理隔离的上下文内存空间（11）

---

## 三、轴 1 · 上下文管理技巧

### 3.1 提示词组装的分层架构

提示词本身就是一个动态加载架构，不是一个字符串：

| 层 | 内容 | 体积 | 生命周期 |
|---|---|---|---|
| 内核 | 角色定义、行为约束、CoT 触发 | `\<1K` token | 几乎不变 |
| `AGENTS.md` | 项目规范、命名风格、协作约定 | KB 级 | 项目内稳定 |
| Skills | 可调用的 SOP / 工具簇 | 每条 KB 级 | 按场景启用 |

为什么不全塞进 system prompt？全塞进字符串会导致：(a) 体积爆炸挤占 KV Cache；(b) 项目规范变更要改代码；(c) 复用性差。`PromptComposer` 在每次 `Run()` 时按 `WorkDir` 重算 System Prompt；`SkillLoader` 扫描 `.skills/**/SKILL.md` + 手写 YAML Frontmatter 解析。

Eager vs Lazy 两阶段加载：
- **元数据（name / description）** 注入 system，让 LLM 知道有哪些 Skill 可用
- **正文（具体步骤）** 仅在 LLM 调用 `read_skill` 后注入 message

当前很多实现只做 Eager Loading，省了 `read_skill` 工具但每次都付 token 代价。

### 3.2 System Prompt 按稳定性分层

不同稳定性内容塞进 system prompt 时该分开：

| 内容类型 | 稳定性 | 进哪一段 |
|---|---|---|
| 组织策略、项目规范、跨用户稳定的工具描述 | 跨用户字节级稳定 | static 段（boundary 前） |
| 当前会话状态、用户当前输入、cwd 等 | 会话 / 用户特定 | dynamic 段（boundary 后） |

cc-07 用 `system: string[]` 数组，每个元素是独立的 cache entry，边界标记前是 6 个跨用户字节级稳定的静态段，边界后是会话 / 用户特定的动态段。

按稳定性切块是 Prompt Cache 命中率的基础。改 static 段会让所有用户的 cache 全部失效。

### 3.3 工具定义稳定常驻

工具集是跨会话 / 跨用户 / 跨 turn 都不变的，放进静态段。控制可用性用 logit masking / 权限层，不用动态增删 tool definitions。动态增删会让 cache key 失配，整段前缀作废。

### 3.4 Token 预算动态残差

`rest_tokens = context_size - max_tokens - curr_message_tokens`

scratchpad 每轮增长，历史预算每轮收缩。固定配额会被 scratchpad 增长吃掉，必须动态算。dify-05 §四 4.1 的 `_calculate_rest_token` 就是这套公式。

### 3.5 Session 物理隔离与 Working Memory

```go
// 极简骨架，11
type GlobalSessionMgr struct {
    mu       sync.RWMutex
    sessions map[string]*Session   // key = WorkDir
}

func (s *Session) GetWorkingMemory(limit int) []Message {
    // 滑动窗口：截最近 N 条 + 预估 Token 超阈值即触发摘要
}
```

要点：
- **Session = WorkDir 绑定的隔离上下文内存空间**。多 WorkDir 物理隔离（`sync.RWMutex` 保护 map）避免并发串扰。
- **Append-only + GetWorkingMemory**：全量历史保存在 Session 内存 / `xxx.jsonl`，每轮 API 调用时通过 `GetWorkingMemory` 截取。
- **引擎生命周期解耦**：`Run(session)` 接收外部 Session 实例，让上层决定会话隔离粒度（Claude Code 全局共享一个 WorkDir；本设计支持多目录独立会话）。
- **孤儿 ToolResult 防护**：截断后若首条是 `RoleUser + ToolCallID`，必须舍弃——否则 API 直接 400 报 `tool message must follow assistant with tool_calls`。

### 3.6 历史裁剪按 User 边界整轮丢弃

超 token 预算时丢哪些历史？按 User 边界整轮丢弃，保证 `(User, Assistant)` 配对完整。

CoT / FC 模式依赖完整的 `(Thought, Action, Observation)` 序列，单条删除会让 LLM 看到"上一步 Action 是 X，Observation 是 Y"但 Y 和 X 已经不在同一个 User 问题了，模型无法理解。dify-05 §四 4.2 的 `AgentHistoryPromptTransform.get_prompt` 逆序遍历触达 User 边界才评估一次 token。

按条数截断 history 不处理 orphan 是常见反模式。把 ToolCall 截掉但 ToolResult 还在，API 直接 400 报错 `messages with role 'tool' must be a response to a preceding message with 'tool_calls'`。

### 3.7 压缩分层级

5 阶段决策链按代价递增、视野递减排序：

| 阶段 | 操作 | 代价 |
|---|---|---|
| Stage 1 | O(1) 持久化超长 tool_result | 零 |
| Stage 2 | 删除语义死分支 | 零 |
| Stage 3 | cache-aware 旧 tool_result 清理 | 零 |
| Stage 4 | 服务端透明 | 零 |
| Stage 5 | 调 LLM 生成 summary | 高（~17K output tokens） |

能不调 LLM 就不调；能 cache-aware 就 cache-aware；只在前面四道防线都不够时才付出 Stage 5 的代价。

诊断关键：当前是单条消息太大（Stage 1）、语义死分支（Stage 2）、跨轮累积（Stage 3）、还是整段太长（Stage 5）？诊断对了才能用对的那一层。

### 3.8 双重降级压缩栈

另一种视角：仿操作系统 GC 的物理防线 > 业务逻辑：

```
阶梯 1（物理）：ToolResult 超长 → `…[已被系统清理。原始长度: X 字节]…` 全量掩码
阶梯 2（物理）：单条 >1000 字符 → Head-Tail Truncation，保头 500 + 尾 500
阶梯 3（语义）：远期 Assistant 推理废话折叠（>200 字符）
```

关键约束：
- **System Prompt 神圣不可压缩**——它是 cache 的根，改一字全盘失配。
- **ToolCall 意图不死**——保留 `msg.ToolCalls` 字段、只替 `Content`，否则 LLM 会困惑"我刚才调过这个工具吗？"陷入重复调用死循环。
- **字符估算公式**：`估算 Token = len(content) + len(tc.Name) + len(tc.Arguments)`，不用调 BPE 编码器实时算。
- **物理边界**：全量历史存 Session，仅本轮发 API 时压缩，不在内存里做"半压缩中间态"。

两层压缩栈视角互补：决策链（3.7）看"何时升级到 LLM summary"，降级栈（3.8）看"零代价的物理手段能压掉多少"。

### 3.9 错误自愈：上下文感知的 Recovery 注入

工具错误 → ToolResult 是一类特殊上下文，必须劫持、不能裸传。

```go
// 极简骨架，14
func (r *RecoveryManager) AnalyzeAndInject(toolName string, rawError string) string {
    switch toolName {
    case "edit_file":
        if strings.Contains(rawError, "not found") {
            return "请先使用 read_file 读取目标文件确认内容，再重试 edit_file。"
        }
    case "bash":
        if strings.Contains(rawError, "command not found") {
            return "请先 which <cmd> 确认可执行文件位置，或安装后重试。"
        }
    }
}
```

设计要点：
- **拦截点**：在 `registry.Execute` 返回后、`session.Append(observationMsgs...)` 前，是唯一能修改 outbound message 的窗口。
- **祈使句话术**：直接告诉 LLM "请先使用 XXX 工具"，不要描述"你刚才遇到了 XXX 错误"——LLM 在读 ToolResult 那一刻就是在执行排障 SOP。
- **分类器实现**：演示用 `strings.Contains` 正则，生产必须改领域错误码（`ERR_FILE_NOT_FOUND` / `DEADLINE_EXCEEDED` / `PERMISSION_DENIED`），字符串匹配脆且误命中。
- **3 类典型模式**：
    - `edit_file` 模式：未找到 `old_text` → "先 read_file 再重试"；命中多处 → "加上下文保唯一性"
    - `read_file/write_file` 模式：`no such file` → `ls -la` 自查；`permission denied` → `chmod` / 换文件
    - `bash` 模式：`command not found` / `DeadlineExceeded`（自写 `context.WithTimeout(30s)`） / `syntax error`
- **"未知错误用 AI 治愈 AI"**：分类器不命中的堆栈，后台再调一个轻量模型（如 GLM-4 Flash）把堆栈翻译成"操作建议"再注入。

Recovery 治"错"——它假设 LLM 想修但缺信息；与下面要讲的 Reminders 治"卡"——它假设 LLM 已经不会修了，必须强干预，是不同问题。

### 3.10 行为干预：防死循环的 System Reminders

LLM 进入 Doom Loop（同一工具同样参数连续失败 ≥3 次）或 Exploration Spiral（不停尝试不同变体但方向错了），普通 Error Recovery 已经救不了。必须主动注入强力修正指令。

```go
// 极简骨架，15
func (loop *MainLoop) observeFailure(toolName, args string) {
    fingerprint := md5(toolName + args)
    loop.failCount[fingerprint]++
    if loop.failCount[fingerprint] >= 3 {
        session.Append(Message{
            Role: RoleUser,  // 关键：必须是 RoleUser，不是 System
            Content: "你已 3 次尝试 edit_file 同一个文件均失败。请停下来，使用 read_file 重新读取，再用 plan 工具列出后续步骤。",
        })
    }
}
```

设计要点：
- **必须 `RoleUser` 注入**：实验证明（Lost in the Middle）模型对 Message 末尾的响应权重大于头部；伪装成 User 的最新消息权重 ≈ 最高近因效应。注入 System Prompt 反而被中间注意力稀释。
- **哈希指纹 + 滑动窗口**：`md5(toolName + args)` 是最低成本的"同失败"识别。成功即清空计数器，避免误判。
- **与 Error Recovery 分层**：Recovery 治"错"——丢救援指南；Reminders 治"卡"——强干预跳出错误循环。
- **阈值兜底物理强杀**：超阈值后不仅注入指令，还应强制 `break loop` / 转人工，否则 LLM 会无视建议继续打转。
- **上下文分布偏移警告**：相同结构的错误堆在 Message 末尾会"牵引"模型继续走老路——这也是为何要换一种话术（从"建议"升级到"强制"）。

### 3.11 Prompt Cache 分层

什么必须按字节稳定，什么可以每轮重算：

| 内容 | 稳定性级别 | 进 cache 吗 |
|---|---|---|
| 跨用户工具描述 / 编码规范 | 跨用户稳定 | 进 static cache |
| 当前会话状态 / 工具结果 | 跨 turn 重算 | 不进 cache |
| scratchpad / 历史对话 | 每轮变化 | 不进 cache |
| MEMORY.md 索引 | 跨会话稳定 | 进 static cache |
| 记忆全文 Prefetch 召回 | 按需注入 | 不进 cache（注入到 message 前缀之外） |

`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 不可移动，移动产生 `2^N` 变体命中率归零。永远不要在 system prompt 开头放秒级时间戳或动态 ID。

---

## 四、轴 2 · 记忆系统

### 4.1 索引常驻 + 全文按需

| 组件 | 注入位置 | 容量 |
|---|---|---|
| MEMORY.md 索引 | 注入 system（常驻） | ≤200 行 / 25KB |
| 具体记忆文件全文 | 按 Prefetch 召回注入 message | ≤5 个相关文件 |

这条记忆是"每次都可能用到"还是"偶尔才需要"？前者入索引常驻，后者按需 Prefetch 召回。

### 4.2 记忆四层分层

| 层级 | 存什么 | 生命周期 | 注入策略 |
|---|---|---|---|
| session | 单次会话上下文 | 循环结束销毁 | 不外部化 |
| user | 用户长期偏好（沟通风格、命名习惯） | 跨 session 持久，按 user 索引 | 按 Prefetch 召回 |
| domain | 领域知识（k8s debug 步骤、特定项目架构） | 按领域 ID 索引 | 按 Prefetch 召回 |
| global | 跨领域常识（编码规范、安全原则） | 所有用户共享 | 可考虑常驻 |

每层的存储后端选型：user / domain 用 Redis 或 DB，global 用只读文件。

### 4.3 状态外部化：PLAN.md + TODO.md

Agent 内部状态（"我现在做到哪了 / 下一步该做什么"）是个易失品，进程崩了或被压缩了就丢了。让 Agent 主动把状态落到文件：

| 文件 | 内容 | 更新粒度 |
|---|---|---|
| `PLAN.md` | 宏观导航：目标 + 阶段拆分 + 当前阶段 | 阶段切换时 |
| `TODO.md` | 颗粒度任务清单，Markdown Checkbox 格式 | 每完成一步即 `edit_file - [ ]` → `- [x]` |

设计要点：
- **不用内存结构体**：直接 `write_file` / `edit_file` 落磁盘，跨重启 / 跨上下文压缩都不丢。
- **强制单步打勾**：完成一项勾一项，禁止一口全勾——避免"LLM 一口气宣称 5 件事完成但实际只做了 2 件"的责任幻觉。
- **迷失自救 SOP**：报错或迷茫时主动 `read_file TODO.md` 确认当前位置 + 当前阶段；显式诱导而不是依赖 LLM "自己想起来"。
- **PlanMode 架构开关**：简单任务（"改个变量名"）不开 PlanMode 避免官僚化；复杂任务（"重构模块"）强制注入 PlanMode 规范（`先 read_file PLAN.md → 按 TODO.md 推进 → 每步完成打勾`）。
- **PlanMode ≠ Thinking Phase**：前者是宏观导航（"我要把这个文件拆 3 段"），后者是微观手术刀（"这一行怎么改"）。混淆会导致要么规划太粗、要么微观决策爆炸。
- **`./server &` 子进程陷阱**：PlanMode 阶段若让 LLM 启动本地服务，必须用同步阻塞（让 LLM 等它起来）而不是 `&` 后台——否则 LLM 在它起来前就开始下一步然后报错。
- **断点续传 / 多人协作**：因为状态在文件，可被 git 跟踪、被人类 review、被另一个 Agent 接力。

### 4.4 Bootstrapping 嗅探与断点续传

Agent 启动时嗅 `PLAN.md` / `TODO.md` 是否存在，两个分支：

| 嗅探结果 | 行为 |
|---|---|
| 都不存在 | **新建路径**：通过 PlanMode 生成 → 写盘 → 推进 |
| 存在 | **续传路径**：读取已有文件 → 找到第一个未完成的 `- [ ]` → 继续 |

**关键禁止**：续传路径下绝不可覆盖已有 PLAN.md——否则 LLM 会"自作主张重做一遍规划"丢失前序决策。

### 4.5 持久记忆 = Working + State + Episodic + Retrieval

```
Working Memory  → Session 内存（11）  →  滑动窗口截取
State           → PLAN.md / TODO.md   →  长期断点（13）
Episodic        → memory/YYYY-MM-DD.md → 当日事件流
Hybrid Retrieval → MEMORY.md 索引 + 向量召回（9） →  跨日复用
```

四层各有适用场景。崩溃恢复靠 State + Episodic；语义相似召回靠 Hybrid；当前 Session 走 Working。

### 4.6 记忆检索

默认向量召回（语义相似），辅以关键词 / 图谱（GraphRAG 时）混合。纯向量对精确关键词不敏感，纯关键词对语义相似不敏感，必须混合。

### 4.7 遗忘策略三层兜底

| 兜底层 | 触发 | 动作 |
|---|---|---|
| 容量上限 | MEMORY.md > 200 行 / 25KB | 触发压缩或淘汰 |
| 时间衰减 | 7-30 天没被召回 | 分数衰减（半衰期按记忆类型分级） |
| 重要性淘汰 | 与最近任务相关度低 | 优先淘汰 |
| 用户显式清除 | 用户说"忘掉这条" | 立即清除，避免"AI 记住了用户想忘的事" |

保留 `/memory forget <key>` 或 `/memory clear` 接口。遗忘是软删（标记过期但保留可恢复窗口期），不是硬删。

---

## 五、多轮对话设计

多轮对话本质上是一连串 Session 内的 Assistant turn，但有几个 Context 维度经常被忽视：

### 5.1 Topic Shift 检测与 Session 分裂

用户在对话中途切换主题（"顺便问下……""对了另外……"），继续套用同一个 Session 会让历史污染当前任务。两个做法：
- **轻量**：检测到主题切换关键词，注入 `RoleUser` 提醒 "我们换个话题，但前提是上一段对话你已经看到"
- **重量**：长程主题切换 → 落 `memory/YYYY-MM-DD.md` 关掉旧 Session，开新 Session

### 5.2 上下文连续性 vs 主题隔离的取舍

完全连续（全对话塞一起）vs 完全隔离（每主题新开 Session）是两端。中间方案：
- **近期 N 轮** 全保留（确保当前主题完整）
- **远期** 触发"摘要回灌"——压缩成本主题摘要注入 system
- **跨主题** 只在用户显式引用（"刚才那个 bug 怎么解"）时召回

### 5.3 显式的上下文边界标记

不能让 LLM 自己猜"现在该忘什么"。引入：
- `--- CONTEXT_BOUNDARY ---` 显式主题切换标记
- `--- SESSION_RESTART ---` 重启标记
- `--- FORGET ---` 用户显式遗忘指令

标记本身是 token 代价，但比让 LLM 自决"该忘什么"靠谱得多。

---

## 六、反模式

### 轴 1 · 管理技巧

- 把所有内容拼成一个 system prompt 字符串，静态段和动态段混在一起，任何修改都让整个前缀哈希失效，cache 命中率从 ~90% 暴跌到 0%
- 在 system prompt 开头放秒级时间戳或动态 ID，每次请求前缀都不同
- 按条数截断 history 不处理 orphan
- 压缩 ToolResult 时连带删 `tool_calls` 字段，模型困惑"我刚才调过这个工具吗？"陷入重复调用死循环
- 上来就调 LLM 做 summary，100K token 历史让 LLM 总结付出 ~17K output tokens
- 给 history 分配固定 token 配额，scratchpad 每轮增长，固定配额会被吃掉
- 动态增删 tool definitions 控制可用性，cache key 失配
- 把 prompt cache 当银弹不维护 cache key，账单没省还多了 `cache_write` 的 1.25x 开销
- 压缩后丢失环境状态（文件 / skill / agent），LLM 不是忘了对话，是忘了"我还能用什么工具"
- **裸 ToolResult 错误直传**：工具报错不加 Recovery 注入，LLM 看到的堆栈信息对他不可操作而反复重试同一条失败路径
- **错误恢复注入走 System Prompt**：错误恢复的话术必须靠 `RoleUser` 最新消息注入才被读进去——但工具错误和排障建议同字段语义不冲突，反而显得"我推荐你这样做"，弱干预
- **Recovery 注入用 `strings.Contains` 在生产**：演示可以，生产必须用领域错误码匹配，否则脆且误命中
- **死循环时只丢 Error Recovery**：Doom Loop / Exploration Spiral 阶段 LLM 已经"读不进"建议了，必须升级到 System Reminders 强干预
- **Reminders 注入走 System Prompt**：被中间注意力稀释，模型对 Message 末尾的响应权重大于头部；必须 `RoleUser`
- **PlanMode 套所有任务**：简单任务也强制先写 PLAN.md 再做 → 官僚化反而拖慢
- **续传路径覆盖 PLAN.md**：嗅到旧文件但 LLM "重新规划一遍"覆盖了历史决策，前序推理归零
- **TODO.md 一口气全勾**：LLM 自我感觉"5 件事都做了"的幻觉，实际只做了 2 件
- **`./server &` 后台启动依赖服务**：LLM 不等子进程就绪就开始下一步，必报连接拒绝
- **Skill 正文 Eager 全部注入**：每个 Skill 的步骤都进 system prompt，挤占 cache 而且多数 Skill 这一 Session 用不到
- **Session 全局共享一个 WorkDir**：多目录项目混会话、隔离缺失、并发串扰（Claude Code 的设计取舍）

### 轴 2 · 记忆系统

- 常驻全量长期记忆，100 个 user_role.md 全量塞进 system prompt 挤占 30K+ tokens
- 记忆无策略只增不减，1000 条记忆里 90% 永远没被召回，污染检索结果
- 没有用户显式清除接口，用户说"忘掉这条"AI 还在记
- 记忆按域硬切（user 记忆 = 全局共享），跨用户共享会导致隐私泄露
- 遗忘是硬删，用户误操作后没法恢复
- 记忆检索只用单一策略，纯向量召回对精确关键词不敏感
- **状态只放内存不落盘**：进程崩溃 / 上下文压缩即丢失 Agent 当前位置
- **TODO.md 沦为摆设不强制更新**：状态外部化但 Agent 不主动维护，等于没外部化
- **多轮对话不切 Session**：主题切换后旧历史污染新任务，检索精度崩盘

---

## 七、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>Claude Code 上下文装配（cc-07-context-assembly.md）</strong>（点击展开）</summary>

- §三 两条 memoize 链路 + Prompt 组装骨架 —— `getSystemContext` / `getUserContext` 用 `lodash memoize` 会话级缓存
- §四 阶段三 静态段 + 动态段 + 缓存边界 —— 6 个静态段跨用户稳定，`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 不可移动
- §四 4.3 自动记忆系统 —— MEMORY.md 索引常驻 + Prefetch 召回全文
- §四 4.6 主 Agent vs 子 Agent prompt 隔离 —— 子 Agent 复用主线程 queryLoop
- §六 6 个静态段完整文本 + 9 个 prompt 工程设计技巧 —— 含 negative constraint、behavioral triggers
- §七 ReAct + CoT 思维链 3 层机制 —— native thinking + 文字声明 + traces 累积

</details>

<details>
<summary><strong>Claude Code 压缩子系统（cc-08-compaction-subsystem.md）</strong>（点击展开）</summary>

- §二 5 阶段压缩栈在 Agent Loop 的位置 —— 透明性、原地缩减 vs 生成新消息
- §四 4.1 5 阶段决策链详解 —— Stage 1 持久化超长 tool_result / Stage 2 snip 死分支 / Stage 3 cache-aware microcompact / Stage 4 服务端透明 / Stage 5 autocompact
- §四 4.3 cache-aware 协作机制 —— cache_edits 不动本地 message、baseline 计算、pinned edits
- §四 4.4 压缩后状态恢复 —— 7 类附件 + boundary marker + preserved segment DAG 重写
- §四 4.5 失败回退 —— PTL 重试截断、连续失败熔断、Reactive Compact 响应式兜底

</details>

<details>
<summary><strong>Dify Agent 上下文（dify-05-agent-context.md）</strong>（点击展开）</summary>

- §一 历史读取 —— `organize_agent_history` 一次性从 DB 读到内存
- §二 三条历史通道 —— CoT 折叠为 scratchpad 文本、FC 保留结构化 tool_calls
- §三 Prompt 每轮重拼 —— 5 段式拼装，scratchpad 每轮增长
- §四 Token 预算动态残差 + User 边界整轮丢弃 —— `AgentHistoryPromptTransform.get_prompt` 逆序填充
- §五 MessageAgentThought 占位 → 增量回填
- §六 parent_message_id 多分支对话

</details>

<details>
<summary><strong>开放 Claw 提示词组装（10）</strong>（点击展开）</summary>

- §内核（\<1K token）+ AGENTS.md + Skills 三层架构 —— 业务规范交给人类维护、不进代码
- §SkillLoader 扫描 `.skills/**/SKILL.md` + 手写 YAML Frontmatter 解析
- §Composer.Build() 每次 Run() 按 WorkDir 重算
- §Eager Loading vs Lazy Loading 两阶段权衡（read_skill 工具）

</details>

<details>
<summary><strong>开放 Claw Session 管理（11）</strong>（点击展开）</summary>

- §Session = WorkDir 绑定的隔离上下文内存空间
- §GlobalSessionMgr 用 `map[string]*Session` + `sync.RWMutex` 并发安全
- §Session.GetWorkingMemory(limit) 滑动窗口 + Token-aware Truncation
- §孤儿 ToolResult 防护：截断后首条 `RoleUser + ToolCallID` 必须舍弃
- §持久化 JSONL：s.history 追加写到 `workDir/.claw/sessions/xxx.jsonl`
- §Claude Code vs 开放 Claw 工业真相：前者全局共享一个 WorkDir

</details>

<details>
<summary><strong>开放 Claw 阶梯降级压缩（12）</strong>（点击展开）</summary>

- §物理防线 > 业务逻辑（双重降级栈）
- §第一道 Observation Masking：ToolResult 过长 → `…[已被系统清理。原始长度: X 字节]…`
- §第二道 Head-Tail Truncation：>1000 字符保头 500 + 尾 500
- §保 ToolCall 意图：保留 `msg.ToolCalls`、只替 Content
- §字符估算公式：`len(content) + len(tc.Name) + len(tc.Arguments)`
- §远期 Assistant 推理废话折叠（>200 字符）

</details>

<details>
<summary><strong>开放 Claw 状态外部化 + 待办管理（13）</strong>（点击展开）</summary>

- §PLAN.md（宏观）+ TODO.md（Checkbox 颗粒度）
- §PlanMode 架构开关：简单不开 / 复杂强制
- §Bootstrapping 分支：嗅文件存在 → A 新建 / B 续传不覆盖
- §强制单步打勾：完成即 `edit_file - [ ]` → `- [x]`
- §迷失自救 SOP：报错 / 迷茫主动 read_file TODO.md
- §多层记忆架构：Working → State → Episodic → Hybrid Retrieval
- §`./server &` 子进程阻塞陷阱
- §Provider 1214 报错：assistant 带 tool_calls 须显式传 `""`

</details>

<details>
<summary><strong>开放 Claw 错误自愈（14）</strong>（点击展开）</summary>

- §拦截点：`registry.Execute` 返回后、`session.Append(observationMsgs...)` 前
- §三类工具模式：edit_file / read_file / bash 的典型错误祈使句
- §30s `context.WithTimeout` Deadline
- §演示用 `strings.Contains`、生产改领域错误码
- §"未知错误用 AI 治愈 AI"：GLM-4 Flash 翻译堆栈

</details>

<details>
<summary><strong>开放 Claw System Reminders（15）</strong>（点击展开）</summary>

- §Doom Loop Detection：md5(toolName + args) 指纹，连续失败 ≥3 次触发
- §滑动窗口失败计数器 + 成功清空
- §必须 `RoleUser` 注入：Lost in the Middle 近因效应权重
- §与 Error Recovery 分层：治"错" vs 治"卡"
- §阈值兜底物理强杀：超阈值 break loop / 转人工
- §上下文内容分布偏移：相同结构错误堆末尾会牵引模型

</details>

<details>
<summary><strong>上下文工程综合（上下文工程.md）</strong>（点击展开）</summary>

- §工程化通用模式：分层注入 / 滑动窗口 / 阶梯降级 / 显式边界
- §注意力预算分配：static 高、middle 低、tail 高
- §缓存命中率 vs 内容动态性的权衡曲线

</details>

<details>
<summary><strong>多轮对话设计（多轮对话设计.md）</strong>（点击展开）</summary>

- §Topic Shift 检测与 Session 分裂
- §上下文连续性 vs 主题隔离的中间方案
- §显式边界标记：CONTEXT_BOUNDARY / SESSION_RESTART / FORGET

</details>

<details>
<summary><strong>记忆架构（记忆架构.md）</strong>（点击展开）</summary>

- §Working / State / Episodic / Hybrid Retrieval 四层职责切分
- §MEMORY.md 索引大小上限与压缩策略
- §向量 + 关键词 + 图谱混合检索

</details>
