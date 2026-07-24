---
description: 长会话不爆 context window，靠嵌入在每轮迭代里的 5 阶段压缩栈：前 4 阶段免费原地缩减，Stage 5 才付一次 LLM 调用生成 summary。本篇拆触发顺序、cache-aware 压缩、压缩后状态恢复与预估式加响应式兜底。
---

# Compaction Subsystem — 5 阶段压缩栈

> **本章目标**：深入理解 Claude Code 的会话压缩机制——从"为什么需要压缩"到"5 阶段如何协同工作"，最终掌握每个阶段的触发条件、数据变换、实现位置和工程权衡。
>
> **读完本章你应该能回答**：
> - 为什么单次 LLM 调用无法支撑长会话？压缩要解决哪些具体问题？
> - 5 阶段压缩栈（tool-result budget → snip → microcompact → API microcompact → autocompact）的顺序是如何确定的？每阶段的触发条件、数据变换、缓存策略是什么？
> - `compactConversation` 主流程的 8 个 Phase 各做了什么？为什么这个顺序？
> - 压缩后的状态恢复机制（7 类附件、preserved segment、DAG 重写）如何保证 resume 后不丢信息、不循环压缩？
> - Cache-aware 压缩（cache_edits、prompt cache sharing、pinned edits）如何保持缓存命中率？
> - 各种失败模式（PTL、连续失败、API fork 失败）如何熔断与重试？
> - 压缩成功了但 summary 丢信息时，如何从时机、指令、阈值三个层次调优？
>
> **配套阅读**：[03-agent-loop](cc-03-agent-loop.md) §五 阶段 1 调用压缩栈（5 阶段在 query loop 中的编排位置在 `src/query.ts:540-665`）；[07-context-assembly](cc-07-context-assembly.md) §四 CLAUDE.md/memory 重新注入由 `processSessionStartHooks` 触发。

**文章结构**：

| 层级 | 章节 | 内容 | 阅读建议 |
|------|------|------|---------|
| 第一层 | 解决什么问题 | 5 类 token 增长源 + 经济性分析 | 必读，建立问题意识 |
| 第二层 | 在整体架构中的位置 | Agent Loop 中的触发节点 + 透明性 | 必读，建立全局坐标 |
| 第三层 | 宏观看系统完整样貌 | 端到端全景图 + 核心抽象 + 版图分类 + 注册机制 + 对外接口 | 必读，建立心智模型 |
| 第四层 | 深入核心运行时细节 | 沿压缩生命周期：5 阶段决策链 → compact 主流程 → cache 协作 → 状态恢复 → 失败回退 → 压缩质量调优 | **核心**，先看全景再看细节 |
| 收束 | 设计权衡 / 边界局限 / 可复用模式 | 三段总结 | 必读 |

> **阅读标注**：本文按"问题 → 位置 → 全貌 → 细节 → 收束"五段递进。第三层是"地图"——先通读建立心智模型再进入第四层；第四层沿单一数据流（messages 进入压缩栈 → Stage 5 触发 compactConversation → 输出后状态恢复 → 全程失败兜底）的生命周期组织，每个机制遵循"**为什么需要 → 怎么做 → 具体实例**"三段式，可按需跳读。所有 `file:line` 均为源码引用，附录 B 给出关键文件清单。

---

## 第一层：解决什么问题

Claude Code 的会话可以是数百轮的 Agent loop。`getContextWindowForModel()` 给出模型上限（200K / 1M tokens），但单轮 prompt 由五部分组成，它们的增长曲线截然不同：

| 部分 | 来源 | 占用特点 | 典型量级 |
|------|------|---------|---------|
| System prompt + tools | 启动时组装 | 静态，整个会话不变 | ~12-18K |
| CLAUDE.md / memory | `getUserContext()` 注入 | 文件大小决定，会话内稳定 | ~5-10K |
| 已读取文件 | `readFileState` 累积 | **爆炸性增长**，一次 Read 可能 25MB | 数十 K 到 MB 级 |
| Tool results | 每轮 append | **爆炸性增长**，Bash/Read 输出常 5-20K | 线性累积 |
| 助手指令 + 思维链 | 每轮 append | 中速增长 | 线性累积 |

前两部分是"地基"——固定且必要；后三部分是"楼层"——随对话轮次线性甚至指数膨胀。问题不在某一条消息，而在于**累积**：第 100 轮的 prompt 里同时装着第 1 轮读过的 25K 源码、第 50 轮的 Bash 输出、第 80 轮的 Edit 结果。当 total usage ≥ `effectiveContextWindow - buffer`，下一次 LLM 调用直接报 `prompt_too_long`（PTL），会话被迫中断。

Compaction 是 **会话压缩 + 上下文回收** 的统称——它要解决的核心问题是：**在不丢关键信息的前提下，让长会话持续运行在有限窗口内**。这同时包含三个子目标：(1) 把爆炸性增长的旧 tool_result / 文件内容从 context 移走；(2) 把整段对话浓缩成结构化 summary，保留"做了什么、为什么、接下来做什么"的叙事；(3) 压缩后仍能恢复当前可用能力（已读文件、已用 skill、后台 agent），否则 LLM 会"失忆"——不是忘了对话，而是忘了自己还能用什么工具。

**经济性**：compression 不是免费的。autocompact 本身需调一次 LLM（p99.99 = 17,387 输出 tokens，`autoCompact.ts:30`），但每次成功 compress 平均节省 100K+ input tokens。按 cache hit ~10× 折算，单次 compress 净收益 ~500K cache_read 节省。这是一笔"花 17K output 换 500K cache_read"的划算交易——前提是压缩不能过于频繁（否则 LLM 调用成本反超），也不能过于迟钝（否则 PTL 中断会话）。这个张力贯穿整个子系统的设计。

理解了这五个增长源和压缩的必要性后，下一层来看压缩在 Agent Loop 架构中的位置——它在循环的哪个节点被触发，为什么这样安排。

---

## 第二层：在整体架构中的位置

第一层说明了"为什么需要压缩"，但压缩不是一个独立的后台进程，也不只是 PTL 报错时的应急动作——它**嵌入在 Agent Loop 的每次迭代中**，是一个常态化的、在 API 调用之前完成的预处理步骤。

在 `query.ts:540-665` 的"阶段 1：上下文准备"里，5 阶段按固定顺序依次执行：

```
Agent Loop while(true) 迭代
  │
  ├─► 阶段 1: 上下文准备
  │     │
  │     ├─► Stage 1: applyToolResultBudget()    ← 单条消息超预算 → 清除 content
  │     ├─► Stage 2: snipCompactIfNeeded()      ← snip_boundary 存在 → 删除消息
  │     ├─► Stage 3: microcompactMessages()     ← 工具数 > 10 或间隔 > 60min
  │     ├─► Stage 4: getAPIContextManagement()  ← 服务端透明，不阻塞
  │     └─► Stage 5: autoCompactIfNeeded()      ← token 超阈值 → 调 LLM 生成 summary
  │
  ├─► 阶段 2: API 调用（用压缩后的 messages）
  ├─► 阶段 3: 判断去向
  ├─► 阶段 4: 工具执行
  └─► 阶段 5: 下一轮准备
```

**关键洞察 1：透明性**。5 阶段全部在 API 调用**之前**执行。这意味着每次 LLM 看到的 messages 都是已经过压缩处理的——它永远不会看到超预算的 tool_result、已被 snip 的消息、或已过 autocompact 阈值的完整历史。压缩对 LLM 是**透明的**：模型感知不到"被压缩"，只感知到一个始终在窗口内的上下文。

**关键洞察 2：原地缩减 vs 生成新消息**。Stage 5（autocompact）是唯一会**产生新消息**（summary + boundary marker + 附件）的阶段，其他 4 个阶段只做**原地缩减**——要么清空 content、要么删除整条消息、要么告诉服务端跳过某些块。这也是为什么 Stage 5 排最后——只有当前 4 个阶段都不够省时，才值得付出一次 LLM 调用的代价。前 4 阶段是"免费的本地操作"，Stage 5 是"昂贵的智能操作"。

**关键洞察 3：预估式而非响应式**。这套 5 阶段是**预估式**的——根据 token 估算提前压缩，不等 PTL 真的发生。这样能避免用户感知到的中断。但 token 估算可能不准（base64 图片、非文本 content block 难以精确计数），所以系统还有一道响应式的 Reactive Compact 作为兜底（第四层 §4.5 详述）——预估式挡不住时，响应式补救。

理解了压缩在循环中的位置和三个关键特性后，下一层从宏观角度建立完整心智模型——一张全景图看清整个子系统的样貌、核心抽象、版图分类、注册机制与对外接口。

---

## 第三层：宏观看系统完整样貌

第二层给出了压缩在 Agent Loop 中的触发节点，但那只是一个"入口"。要理解整个子系统，需要一张全景图把"入口 → 内部生命周期 → 输出恢复 → 失败兜底 → 对外接口"全部串起来。本章先给端到端全景图建立心智模型，再从核心抽象、版图分类、注册机制、对外接口四个侧面展开。

### 3.1 端到端全景图

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        会话压缩子系统全景                                 │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─ 入口：Agent Loop 阶段 1 (query.ts:540-665) ────────────────────────┐ │
│  │   messages 进入 5 阶段决策链（代价递增 / 视野递减 / 缓存优先）       │ │
│  │   ┌─────────┐ ┌──────┐ ┌─────────┐ ┌──────────┐ ┌────────────────┐ │ │
│  │   │Stage 1  │→│Stage2│→│Stage 3  │→│Stage 4   │→│Stage 5         │ │ │
│  │   │Tool     │ │Snip  │ │Micro-   │ │API Micro │ │Auto Compact    │ │ │
│  │   │Budget   │ │      │ │compact  │ │compact   │ │(Session Mem→   │ │ │
│  │   │(本地O1) │ │(本地)│ │(本地)   │ │(服务端)  │ │ LLM Summary)   │ │ │
│  │   └─────────┘ └──────┘ └─────────┘ └──────────┘ └──────┬─────────┘ │ │
│  └────────────────────────────────────────────────────────┼───────────┘ │
│                              ↓ 压缩后 messages             │ 触发        │
│  ┌─ 阶段 2: API 调用 ◄────────────────────────────────────┘             │
│  │   (LLM 看到的始终是窗口内的上下文)                                    │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                          │
│  ┌─ Stage 5 内部生命周期：compactConversation 8 Phase (compact.ts:411-792)┐
│  │   P1 Pre-flight ─► P2 决策(fork/streaming) ─► P3 LLM 调用(+PTL重试)   │
│  │      ─► P4 校验 ─► P5 状态清理 ─► P6 构造 7 类附件 ─► P7 持久化 ─► P8 │
│  └────────────────────────────────────────────────────────────────────────┘
│                              ↓ CompactionResult                          │
│  ┌─ 压缩后状态恢复 ──────────────────────────────────────────────────────┐
│  │   [boundaryMarker][summary][7 类附件][hookMessages]                   │
│  │   + Preserved Segment DAG 重写 (sessionStorage.ts:1876-1993)          │
│  │   + JSONL 持久化 + reAppendSessionMetadata                            │
│  │   + CLAUDE.md/memory 重新注入 (processSessionStartHooks)              │
│  └────────────────────────────────────────────────────────────────────────┘
│                                                                          │
│  ┌─ 贯穿全程的可靠性保障 ────────────────────────────────────────────────┐
│  │   PTL 重试(3次) │ 连续失败熔断(3次) │ Fork fallback │ Streaming 重试 │
│  │   Reactive Compact（响应式兜底，5 阶段没拦住 PTL 时触发）              │
│  └────────────────────────────────────────────────────────────────────────┘
│                                                                          │
│  ┌─ 对外接口 ────────────────────────────────────────────────────────────┐
│  │   Hooks:  PreCompact / PostCompact / SessionStart('compact')          │
│  │   Commands: /compact, /force-snip                                     │
│  │   Events: tengu_compact / tengu_compact_failed / tengu_compact_*      │
│  └────────────────────────────────────────────────────────────────────────┘
└──────────────────────────────────────────────────────────────────────────┘
```

**如何读这张图**：从上到下是数据流方向。messages 先经入口的 5 阶段决策链逐级压缩；若 Stage 5 触发，进入 compactConversation 的 8 Phase 内部生命周期；产出 CompactionResult 后，进入状态恢复阶段重建可用上下文；可靠性保障与对外接口贯穿全程。图中每一块在第四层都有对应的细节展开。

下面从四个侧面展开这张全景图：先提炼贯穿全图的核心抽象，再对 5 阶段做版图分类，接着看这些机制如何被 feature gate 注册与接线，最后看子系统对外暴露的接口。

### 3.2 核心抽象

整个子系统围绕六个核心抽象构建。理解了它们，第四层的细节就只是这些抽象的具体编排。

**抽象 1：Boundary Marker（边界标记）**。压缩是 lossy 操作，resume 时必须能定位"压缩发生在哪"。系统在每次压缩边界插入一条 system message 作为 marker：`compact_boundary`（`messages.ts:4967-4992`）携带 `compactMetadata.{trigger, preTokens, preservedSegment}`；`snip_boundary` 携带 `snipMetadata.removedUuids`；`microcompact_boundary` 标记 cache_edits 删除量。marker 既是日志（压缩原因、前后 token 数），又是 DAG 锚点（`logicalParentUuid` 让物理断链的逻辑链可重建）。**具体场景**：`--resume` 一个压缩过的会话时，`findLastCompactBoundaryIndex` 找到最后一条 boundary，从那里切片加载，避免重复压缩历史。

**抽象 2：Cache Edits（缓存编辑）**。Anthropic API 的 prompt cache 依赖 content 稳定——改一个字符 cache prefix 就失配。但压缩又必须删内容。`cache_edits` API block 解决了这个矛盾：**本地 messages 数组不动**（cache key 不变），只通过 API 参数告诉服务端"这些 tool_use_id 的内容可以跳过"。服务端在 cache 命中后按 edits 跳过对应块。这让"删除"对 cache 透明。**具体场景**：Stage 3 的 Cached MC 路径用这个机制删除旧 tool_result 而不破坏热 cache。

**抽象 3：Preserved Segment（保留段）**。partial compact 不是"全压"，而是"压一半"——pivot 之前（或之后）的消息保留原样。`preservedSegment: { headUuid, anchorUuid, tailUuid }` 标记保留段的起止。resume 时 `applyPreservedSegmentRelinks`（`sessionStorage.ts:1876-1993`）按 4 步算法重写 DAG parent 指针，让保留段逻辑上接在 summary 之后。**具体场景**：用户最近 5 轮的精细操作（含未提交的代码改动）必须原样保留，不能被 summary 概括掉——preserved segment 保留这段"工作内存"。

**抽象 4：Persisted Output（持久化输出）**。Stage 1 不丢弃超大 tool_result，而是把完整内容写入 `.claude/tool_results/<id>.json`，原位置替换为前 2000 字节预览 + 文件路径。**具体场景**：一次 Bash 输出 50KB 日志，agent 当前只需要看尾部错误，但可能稍后需要全文——持久化让"移出 context"不等于"丢失"，agent 可随时 Read 回来。

**抽象 5：Attachment（附件）**。压缩后 LLM 失去了"当前环境状态"（读过哪些文件、用过哪些 skill、有哪些后台 agent）。7 类附件在 boundary 之后重新注入这些状态，让 LLM 知道"我还能用什么"。**具体场景**：压缩前 agent 刚读过 `src/auth/login.ts`，压缩后这条 tool_result 没了，但 `fileAttachments` 把文件内容重新注入，agent 不必重新 Read。

**抽象 6：Fork for Cache-sharing（fork 复用 cache）**。Stage 5 的 summary 调用需要完整 system+tools，若新开请求会全量 cache_creation。fork 进程继承主线程的 cache key params（system/tools/model/thinking config），prefix cache 命中后只传 1 条 summary 请求。**具体场景**：长会话第 100 轮触发 autocompact，fork 让 summary 调用几乎免费命中主线程已建的 100K cache。

### 3.3 版图分类

5 阶段不是 5 种可选策略，而是一条固定决策链。从三个维度分类，能看清它们的协同关系：

**按代价分类（递增）**：

| 阶段 | 时间复杂度 | 是否调 LLM | 是否动本地 messages |
|------|-----------|-----------|-------------------|
| Stage 1 Tool Budget | O(1) 文件写入 | 否 | 是（替换 content） |
| Stage 2 Snip | O(n) 遍历删除 | 否 | 是（删除消息） |
| Stage 3 Microcompact | O(n) 本地判断 | 否 | 视路径：Time-based 动 / Cached 不动 |
| Stage 4 API Microcompact | 0（客户端） | 否（服务端做） | 否（服务端透明） |
| Stage 5 Auto Compact | 一次 LLM 调用 | **是** | 是（整段替换为 summary） |

这个分类直接决定了顺序：**代价递增 → 后置**。能在本地 O(1) 解决的绝不上 API；能不调 LLM 的绝不调 LLM。

**按视野分类（递减）**：

| 阶段 | 处理粒度 | 视野范围 |
|------|---------|---------|
| Stage 1 | 单条消息内的 tool_result | 一轮 API 调用 |
| Stage 2 | 跨多条消息的死分支 | 语义连续的对话段 |
| Stage 3 | 跨多轮累积的 tool_result | 时间/工具数窗口 |
| Stage 4 | 服务端判定的旧 tool_use + thinking | 服务端策略 |
| Stage 5 | 整段对话历史 | 全部 pre-compact 消息 |

**视野递减 → 后置**：前面的阶段处理"局部"问题（单条消息太大），后面的阶段才处理"全局"问题（整段对话太长）。局部问题用便宜手段先扫一遍，扫不干净再动用全局手段。

**按触发方式分类**：

| 类型 | 阶段 | 触发主体 |
|------|------|---------|
| 自动（大小/时间/token 阈值） | Stage 1, 3, 4, 5 | 系统按规则 |
| 手动（语义判断） | Stage 2 Snip | 用户 `/force-snip` 或 LLM 调 snip tool |

**为什么 Snip 是手动**：自动压缩只按数值规则判断，不理解对话的**语义结构**。当 agent 尝试方案 A 失败后改用方案 B，方案 A 的消息对后续推理已无价值——这种"语义死亡"只有人或 LLM 能判断。Snip 把这个判断权交给语义主体，再由系统机械执行删除。

**Stage 5 的内部两段式**：Stage 5 自身还有"代价递增"的子链——先尝试 `trySessionMemoryCompaction()`（免 LLM，用后台提取的 session memory 当 summary），失败才降级到 `compactConversation()`（调 LLM）。这与 5 阶段的递增逻辑同构：能不调 LLM 就不调。

### 3.4 注册机制

子系统的各机制不是硬编码常开，而是通过 feature gate、阈值常量、固定接线点三套机制注册与控制。

**Feature gates（功能开关）**：

| Gate | 控制的机制 | 默认 | 意图 |
|------|-----------|------|------|
| `HISTORY_SNIP` | Stage 2 snipCompact | gated | snip 是较新特性，灰度放开 |
| `CACHED_MICROCOMPACT` | Stage 3 cache_edits 路径 + baseline 计算 | gated | cache_edits 依赖服务端支持 |
| `CONTEXT_COLLAPSE` | 禁用 proactive autocompact，由 Context Collapse 接管 | gated | 新架构逐步替代旧 autocompact |
| `REACTIVE_COMPACT` | 响应式兜底压缩 | gated | PTL 应急路径灰度 |
| `KAIROS` | 写 reduced transcript segment | gated | 子项目特性 |
| `PROMPT_CACHE_BREAK_DETECTION` | cache break 检测 + notifyCacheDeletion | gated | 防误报 |
| `tengu_compact_cache_prefix` | Stage 5 走 fork 复用 cache | true | 实验验证默认开 |
| `tengu_compact_streaming_retry` | streaming 路径重试 | false | 重试策略灰度 |
| `DISABLE_AUTO_COMPACT=1` / `autoCompactEnabled=false` | 全局禁用 autocompact | false | 用户/环境手动关 |

**设计意图**：这些 gate 大多是灰度发布用的——压缩是高风险操作（做错了丢信息），新机制先 gate 再默认开。`CONTEXT_COLLAPSE` 是例外：它启用时**禁用**旧 autocompact，因为新架构要完全接管，两者不能并存。但 Reactive Compact 在 `CONTEXT_COLLAPSE` 下仍存活——新架构也可能拦不住 PTL，响应式兜底是最后防线。

**阈值常量（及其背后的意图）**：

| 常量 | 值 | 位置 | 意图 |
|------|-----|------|------|
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200K 字符 | `toolLimits.ts:49` | 单条消息不该占满窗口；200K 字符 ≈ 50K tokens，留余地给 system/history/response |
| `PREVIEW_SIZE_BYTES` | 2000 字节 | `toolResultStorage.ts:109` | 够显示典型输出的头部/尾部（错误行、摘要行）让 agent 决定是否 Read 全文，又不会让多个预览自身膨胀 |
| Time-based MC gap | 60 分钟 | `microCompact.ts` | 对齐 Anthropic 1h prompt cache TTL——超 60min cache 已冷，mutate content 不再有 cache 代价 |
| Cached MC tool count | 10 | `microCompact.ts` | 低于 10 个活跃工具时 cache_edits 开销大于收益；高于 10 才值得跳过 |
| API microcompact threshold | 180K tokens | `apiMicrocompact.ts:64` | 在 200K 标准窗口下留 ~20K 给响应和服务端补充 |
| autocompact buffer | 13K / 30K / 50K | `autoCompact.ts` | 按窗口（&lt;400K / ≥400K / ≥800K）分级，留比例化余量给 summary 输出(~17K)+附件(至 50K)+下轮响应 |
| `SNIP_NUDGE_THRESHOLD` | 30 条消息 | `snipCompact.ts:163` | 低于 30 条时手动 snip 的决策成本大于收益；高于 30 死分支可能累积 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | `autoCompact.ts:99` | 够扛瞬时 API 抖动，又能在持久失败时及时止损（BQ 数据：1,279 会话失败 50+ 次） |
| `MAX_PTL_RETRIES` | 3 | `compact.ts` | compact 自身 PTL 时按 API-round 切头部重试，3 次后放弃 |
| `POST_COMPACT_MAX_TOKENS_PER_SKILL` | 5K | `compact.ts:129` | skill 文件常 18-20KB，截到 5K 保顶部关键指令；25K 总预算够 ~5 个 skill |

**接线点（5 阶段在主循环的注册位置）**：

```
query.ts:567  →  applyToolResultBudget()        Stage 1
query.ts:591  →  snipCompactIfNeeded()          Stage 2
query.ts:602  →  microcompactMessages()         Stage 3
query.ts      →  getAPIContextManagement()      Stage 4（注入 request 配置）
query.ts:652  →  autoCompactIfNeeded()          Stage 5
```

这 5 个调用点固定在阶段 1"上下文准备"中，顺序不可调换。`snipTokensFreed` 从 Stage 2 传到 Stage 5 的 threshold 计算（`autoCompact.ts:254`），是因为 snip 删除的消息不在 protected-tail assistant 的 usage 里——必须显式减去，否则 autocompact 基于 stale 数据误判。

### 3.5 对外接口

子系统通过三类接口与外部交互：hooks（让外部注入逻辑）、commands（让用户触发）、events（让分析系统观测）。

**Hooks（前后置扩展点）**：

| Hook | 时机 | 用途 |
|------|------|------|
| `executePreCompactHooks` | compact 开始前（Phase 1） | 注入 custom instructions（如 CI 环境"详细总结测试失败"） |
| `executePostCompactHooks` | compact 完成后（Phase 7） | 收到 summary 做后续动作（写外部 memory、通知 webhook） |
| `processSessionStartHooks('compact', ...)` | Phase 6 附件构造时 | 复用 session 启动 hook 重新注入 CLAUDE.md/memory |

**设计权衡**：PreCompact hook 比 PostCompact 更有价值——它在 summary 生成前介入，能改变 summary 内容本身；PostCompact 只能消费已生成的 summary。所以 `mergeHookInstructions`（`compact.ts:398-405`）把 user instructions 和 hook instructions 合并注入 prompt。

**Commands（用户触发点）**：

| 命令 | 入口 | 作用 |
|------|------|------|
| `/compact` | `src/commands/compact/compact.ts` | 手动触发全量 compact，捕获 PTL 错误并 yield 通知 |
| `/force-snip` | `src/commands/force-snip.ts` | 手动选择消息区间插入 snip_boundary |

`/compact` 与 autocompact 走同一个 `compactConversation` 函数，区别仅在 `trigger` 字段（manual vs auto）和错误处理（manual 通知用户，auto 静默 log）。

**Events（可观测性）**：

| Event | 记录内容 |
|-------|---------|
| `tengu_compact` | pre/post token 数、trigger、是否 recompaction |
| `tengu_compact_failed` | 失败原因 |
| `tengu_compact_cache_sharing_success` | fork 路径 cache 命中率 |
| `tengu_compact_cache_sharing_fallback` | fork 失败降级 streaming |
| `tengu_compact_streaming_retry` | streaming 重试 attempt |
| `tengu_relink_walk_broken` | preserved segment walk 失败 |

这些 event 不阻塞流程——cache miss 不 throw（streaming fallback 兜底），walk broken 不 panic（降级全量加载）。event 是观测用的，不是控制流。

建立了这四个侧面的心智模型后，第四层沿数据流生命周期深入每个机制的"为什么需要 → 怎么做 → 具体实例"。

## 第四层：深入核心运行时细节

第三层的全景图建立了心智模型，本层沿**单一数据流的生命周期**深入每个机制。这条数据流是：messages 进入压缩栈 → 5 阶段决策链逐级压缩 → Stage 5 触发 compactConversation 的 8 Phase 内部流水线 → 输出后状态恢复重建可用上下文 → 全程由失败回退机制兜底。每个机制遵循"**为什么需要 → 怎么做 → 具体实例**"三段式。

### 4.1 5 阶段决策链详解（入口：消息如何被逐级压缩）

这是数据流进入子系统的第一站。第三章的版图分类已说明 5 阶段是"代价递增、视野递减、缓存优先"的固定决策链——每一级都是"上一级不够省，才轮到我"。本节逐阶段回答三个问题：**什么情况触发？数据怎么变？为什么排在这个位置？**

```
消息进入压缩栈
  │
  ├─► Stage 1: 单条消息太大？→ 清除内容，保留占位符
  │     ↓ 仍然超预算
  ├─► Stage 2: 有 snip 标记？→ 删除死分支消息
  │     ↓ 仍然超预算
  ├─► Stage 3: 工具结果太多？→ 清除旧 tool_result（保 cache）
  │     ↓ 仍然超预算
  ├─► Stage 4: 服务端触发？→ 服务端透明清除
  │     ↓ 仍然超预算
  └─► Stage 5: 调 LLM 生成摘要 → 整段历史压缩为一段 summary
```

#### Stage 1: Tool-result Budget —— 持久化到文件，替换为预览

**为什么需要**：单条 user message（一轮 API 调用产生的）可能装多个 tool_result，若其中一个 Bash 输出 50KB、一个 Read 返回 25K 源码，单条消息就占满窗口大头。但直接丢弃太粗暴——agent 可能稍后需要全文。需要一种"移出 context 但不丢失"的手段。

**怎么做**：触发条件是单条 user message 中所有 tool_result 总大小超过 `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`（200K 字符，`toolLimits.ts:49`）。注意这是**按消息**而非按单个 tool_result 计算——一轮 API 调用的所有 tool_result 共享一个预算。超预算时，最大的几个 FRESH（本轮新增）tool_result 被选中，执行两步：(1) 完整内容持久化到 `.claude/tool_results/<tool_use_id>.json` 或 `.txt`；(2) 原 content 替换为预览：

```
<persisted-output>
Output too large (50.2 KB). Full output saved to: .claude/tool_results/abc123.json

Preview (first 2000 bytes):
[前 2000 字节的实际输出内容...]
...
</persisted-output>
```

Agent 看到的是真实输出的前 2000 字节（`PREVIEW_SIZE_BYTES = 2000`，`toolResultStorage.ts:109`）加文件路径——需要全文时可调 Read。**关键设计**：替换是"冻结"的——一旦某 `tool_use_id` 被决定"不替换"（内容已在某轮原样发给模型），它永远不再被替换。原因：同一 tool_use_id 上一轮完整、这一轮变预览，cache prefix 必然失配。这个"seen but unreplaced → frozen forever"规则保证 prompt cache 稳定性。

**具体实例**：agent 连续 Read 了 5 个大文件，单条 user message 含 5 个 tool_result 共 120K 字符——未超 200K，不动。若又 Read 一个 100K 字符的日志，总 220K 超阈值，最大的那个 100K 日志被持久化+预览化，context 立省 ~95K 字符，agent 仍能 Read 回全文。

```typescript
// query.ts:567 — 入口
messagesForQuery = await applyToolResultBudget(messagesForQuery, ...)
```

**为什么排第一**：O(1) 本地文件写入，不调 API，且"先持久化再替换"让信息没真正丢失——只是从 context 移到文件系统。最便宜的压缩手段优先做。

#### Stage 2: Snip —— 用户/LLM 手动标记死分支删除

**为什么需要**：自动压缩按数值规则判断，不理解对话的语义结构。当 agent 尝试方案 A 失败、回到分支点改用方案 B，方案 A 的所有消息对后续推理已无价值——这种"语义死亡"只有人或 LLM 能判断。Snip 把"判定哪些是死分支"交给语义主体，"执行删除"交给系统。

**怎么做**：触发方式有二——`/force-snip` 命令（用户手动选区间）或 snip tool（LLM 主动调，feature gated）。触发后在消息数组插入一条 `snip_boundary` system message，其 `snipMetadata.removedUuids` 列出待删 UUID。`snipCompactIfNeeded`（`snipCompact.ts:83`）在下一轮 query loop 入口扫描到 boundary，机械过滤掉列表中的 UUID。

```
Before snip:                       After snipCompactIfNeeded:
[user] 重构 auth                   [user] 重构 auth
[assistant] 方案 A: 用装饰器...     [assistant] 方案 B: 拆出 AuthService...
[user] tool_result (方案A失败)     [user] tool_result (测试通过)
[assistant] 方案 B: 拆出...     ←  [system] snip_boundary (removed: [...])
[user] tool_result (测试通过)      [user] 继续下一个任务...
[system] snip_boundary
  snipMetadata.removedUuids:
  [方案A的3条消息UUID]
[user] 继续下一个任务...
```

**具体实例**：agent 调试一个 bug，先试"加 try-catch"（3 轮对话含 Read/Edit/Bash），发现没用；改试"重构参数校验"（成功）。用户 `/force-snip` 选中前 3 轮，snip_boundary 标记 3 条 UUID，下一轮入口这 3 条被删，context 立刻清爽。

**为什么排第二**：O(n) 本地删除，不调 API。排在 Stage 1 后、Microcompact 前，因为被 snip 删的消息不必进入后续阶段处理——早删早省。

#### Stage 3: Microcompact —— 缓存感知的工具结果清理

**为什么需要**：Stage 1 处理"单条消息内"的超大结果并持久化（可 Read 回来）；但还有一类问题——**跨多轮累积**的大量工具结果。这些旧结果 agent 已不需要，但删它们可能破坏 cache。需要一个能感知 cache 冷热、权衡"删 vs 保 cache"的机制。

**怎么做**：两个**互斥**子路径，按当前 cache 状态选择：

- **路径 A — Time-based（缓存已冷）**：距上一条 assistant 消息超 60 分钟。此时 Anthropic 1h cache TTL 已过期，cache 是冷的，直接把 `message.content` 替换为 `"[Old tool result content cleared]"`。反正 cache 已没，无所谓破坏 prefix。这种"直接丢弃"可行，是因为 60 分钟不活动意味着上下文已切换——用户去开会、吃午饭，回来继续的是新话题，旧工具输出对当前推理无参考价值。

- **路径 B — Cached（缓存仍热）**：注册的活跃工具数超 10 个。此时 cache 可能还热（最近 1h 频繁交互），**不动本地 message**——改内容会破坏 cache prefix。而是通过 `cache_edits` API 块告诉服务端"这些 tool_use_id 的内容可跳过"，服务端读 cache 时自动跳过被标记块。

**具体实例**：长会话前 50 轮 agent 频繁用 Bash/Read，累积 60+ 个旧 tool_result。若距上次交互仅 5 分钟（cache 热），走路径 B：本地 messages 不变，cache_edits 标记 50 个旧 tool_use_id 跳过，cache 命中率不降，但服务端实际处理内容大减。若用户离开 2 小时回来（cache 冷），走路径 A：直接把旧 content 替换为占位符，cache 反正没了，白换不亏。

**为什么排第三**：已涉及"要不要牺牲 cache"的权衡（冷热分支），比 Stage 1/2 的纯机械操作复杂，但仍不需调 LLM。

#### Stage 4: API Microcompact —— 服务端透明压缩

**为什么需要**：前三阶段都是客户端本地操作，但服务端有更精确的 token 计数和原生清理能力（能直接操作 cache 内部结构）。需要一个服务端兜底，处理客户端估算漏掉的情况。

**怎么做**：触发条件是服务端判断 `input_tokens > 180K`（默认阈值）。服务端应用 `clear_tool_uses_20250919` 策略——自动清除旧 tool_result 和 thinking block。客户端只需在请求带 `context_management.edits` 配置，服务端自动处理。

**具体实例**：客户端 token 估算说 175K（未超 180K），但实际含 base64 图片，真实 185K。服务端检测到超阈值，自动清除最旧的 20 个 tool_use 的 content 和对应 thinking block，请求得以继续。

**为什么排第四**：Anthropic API 原生能力，对客户端完全透明，但它不可控——客户端不知服务端会删什么。排得越靠后，留给前面可控阶段的机会越多。

#### Stage 5: Auto Compact —— 两级优先级：Session Memory → LLM Summary

**为什么需要**：前 4 阶段都是"局部瘦身"，但当对话本身太长（几百轮叙事 + 中间推理），局部压缩不够，需要把整段历史浓缩成结构化 summary。这是代价最高的一级，所以最后才动用。

**怎么做**：触发条件 `tokenUsage ≥ effectiveContextWindow - buffer`。buffer 按窗口分三级：13K（&lt;400K 窗口）、30K（≥400K）、50K（≥800K）——分级是为留比例化余量给 summary 输出(~17K)+附件(至 50K)+下轮响应。

Stage 5 不是直接调 LLM，而是先尝试免 LLM 方案（`autoCompact.ts:317-339`）：

```
触发 autocompact
  │
  ├─► 优先级 1: trySessionMemoryCompaction()
  │     用后台已提取的 session memory 内容作为 summary
  │     成功 → 返回（省下一次 LLM 调用，~17K output tokens）
  │     失败 → 降级到优先级 2
  │
  └─► 优先级 2: compactConversation()
        调 LLM 生成 9 段结构 summary（§4.2 详述）
```

**Session Memory Compact 原理**（`sessionMemoryCompact.ts:516-632`）：后台 Session Memory 系统（类似 [07-context-assembly](cc-07-context-assembly.md) 的 auto memory，但针对会话内容）在对话过程中持续提取摘要。autocompact 触发时，`trySessionMemoryCompaction` 检查：(1) session memory 文件存在且非空；(2) 找到上次 summary 覆盖到的消息位置（`lastSummarizedMessageId`）；(3) 计算保留范围（至少 10K tokens、至少 5 条文本消息、最多 40K tokens）；(4) 用 session memory 内容构造 compact result（复用 `buildPostCompactMessages` 拼 boundary + 附件）；(5) 校验压缩后 token 数低于阈值——超过则放弃，降级到 LLM summary。

这是一个**性价比优化**：session memory 是后台持续提取的"免费"副产品，用它替代 LLM summary 把 Stage 5 代价从 17K output tokens 降到零。

**额外护栏**：连续失败 3 次熔断（不再尝试，让用户手动 `/compact`）；`DISABLE_AUTO_COMPACT=1` 或 `autoCompactEnabled=false` 跳过；`querySource === 'compact'` 跳过（防压缩本身触发压缩）；`CONTEXT_COLLAPSE` feature 启用跳过（由 Context Collapse 接管）。

**具体实例**：200 轮对话累积到 185K tokens，超 200K-13K=187K... 实际 buffer 13K 时阈值为 187K，185K 未触发；继续 2 轮到 188K 超阈值。先试 session memory：后台已提取的摘要覆盖到第 180 轮，保留第 181-200 轮原文（约 15K tokens，满足 ≥10K），构造 compact result，校验压缩后 28K &lt; 阈值，成功——省下一次 LLM 调用。若 session memory 为空或校验失败，降级调 LLM 生成 9 段 summary。

**为什么排最后**：即使有 session memory 优化，Stage 5 仍是代价最高的一级——session memory 不可用时仍需调 LLM。只有前 4 阶段都省不够时才值得。

5 阶段决策链详解完毕。当 Stage 5 降级到 LLM summary 时，进入 `compactConversation` 的 8 Phase 内部生命周期——下一节展开。

### 4.2 compactConversation 生命周期（Stage 5 触发后的 8 Phase 流水线）

上一节的 Stage 5 是决策链终点；当它降级到优先级 2 时，`compactConversation`（`compact.ts:411-792`）要做一件事：**把几百条消息变成一段 summary，同时保证压缩后 session 还能继续运行**。这不是简单的"调 LLM → 拿结果 → 替换"——压缩前 session 有已读文件缓存、已调用 skill、正在运行的后台 agent，这些状态压缩后必须恢复，否则 LLM 会"失忆"（忘了当前可用的工具和能力）。

8 个 Phase 按依赖关系排成一条流水线：

```
Phase 1: Pre-flight      Phase 2: 决策        Phase 3: LLM 调用      Phase 4: 校验
  校验 + hook 改写          fork vs streaming     + PTL 重试             结果合法性
       │                      │                     │                    │
       └──────────────────────┴─────────────────────┴────────────────────┘
                                │
                                ▼
Phase 5: 状态清理         Phase 6: 构造输出       Phase 7: 持久化       Phase 8: 返回
  清空缓存 + 快照附件       拼装 7 类附件 +         事件 + hook +          CompactionResult
                            boundary marker         reAppend
```

**具体实例：一次 compact 前后对比**

压缩前（~200 条 messages，~185K tokens）：

```
[system] You are Claude Code...
[user] <project-instructions>...CLAUDE.md...</project-instructions>
[user] 帮我重构 auth 模块
[assistant] 好的，我先看看代码结构
[assistant] Tool: Read src/auth/login.ts
[user] <tool_result>...25K 源码...</tool_result>
[assistant] 我发现登录逻辑耦合在 controller 里，建议拆出 AuthService
[user] 可以，但保留现有的错误处理
[assistant] Tool: Edit src/auth/login.ts ...（改代码）
[user] <tool_result>Edit applied successfully</tool_result>
...（重复 180+ 轮对话）...
[assistant] 重构完成，测试也通过了
```

压缩后（~25K tokens）：

```
[system] You are Claude Code...（不变）
[user] <project-instructions>...CLAUDE.md...</project-instructions>（重新注入）
[system] Conversation compacted  ← boundary marker
[user] Summary:                  ← summary 内容
  1. Primary Request: 重构 auth 模块，拆出 AuthService，保留现有错误处理
  2. Key Technical Concepts: ...
  ...
[user] <attached_files>          ← 最近读过的 5 个文件重新注入
  src/auth/login.ts (truncated to 5K)
  src/auth/middleware.ts
  ...
[user] <skill> auth-test-helper  ← 已用 skill 重新注入
[user] <agent_listing>           ← 可用 agent 列表
[user] <mcp_instructions>        ← MCP 工具说明
```

**关键变化**：200 条历史对话 → 一段 structured summary。对话的"叙事"被保留（Primary Request → Key Concepts → Files → Errors → Current Work），但具体代码片段、中间 tool_result 被丢弃。同时重新注入当前环境状态（文件、skill、agent），让 LLM 下一轮知道"我还能用什么"。

下面逐 Phase 展开。

#### Phase 1: Pre-flight 校验 —— 为什么先做 hook 而不是先调 LLM？

Pre-flight 的核心动作不是校验，而是**给 hooks 系统留改写窗口**。`executePreCompactHooks`（`compact.ts:444`）在 compact 真正开始前调用，hook 可注入额外 custom instructions——例如 CI 环境追加"summarize test failures in detail"。

```typescript
// compact.ts:421-453
const hookResult = await executePreCompactHooks(
  { trigger: isAutoCompact ? 'auto' : 'manual', customInstructions: customInstructions ?? null },
  context.abortController.signal,
)
customInstructions = mergeHookInstructions(customInstructions, hookResult.newCustomInstructions)
```

同时做基础校验：`messages.length === 0` 直接抛 `ERROR_MESSAGE_NOT_ENOUGH_MESSAGES`（"Not enough messages to summarize"），避免 LLM 收到空输入；`tokenCountWithEstimation` 记录压缩前 token 数，这个数字贯穿后续所有 event log。**为什么 hook 先于校验**：hook 改写的是 instructions，不是 messages；但放在最前是为了让 hook 有最大作用窗口——即使 messages 不足，hook 也能记录意图供下次使用。

#### Phase 2: 决策路径 —— fork 还是 streaming？

```typescript
// compact.ts:459-468
const promptCacheSharingEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
  'tengu_compact_cache_prefix',
  true,
)
const compactPrompt = getCompactPrompt(customInstructions)
const summaryRequest = createUserMessage({ content: compactPrompt })
```

核心决策只有一个：**走 fork 复用主线程 cache prefix，还是走 streaming 独立请求？** `tengu_compact_cache_prefix` 为 true（默认）时走 `runForkedAgent`——fork 进程继承主线程的 system prompt、tools、model、thinking config，prefix cache 命中后只需传 `summaryRequest` 这 1 条新消息。false 时走 streaming 独立请求，所有 system+tools 都要重新传。

3P 实验（Jan 2026）数据支持这个默认值：false path 的 cache miss 率 98%，浪费舰队约 0.76% 的 cache_creation 预算。

#### Phase 3: LLM Summary 调用 + PTL 重试 —— compact 自身也可能超窗口

这是整个流程核心：调 LLM 生成 summary。但有递归问题——**compact 自己的输入也可能超 context window**。典型场景：用户发 50 张截图，每张 5MB base64，messages 远超 200K 窗口。compact 把这些 messages 当输入 → API 直接返回 `prompt_too_long`。

```typescript
// compact.ts:474-515
for (;;) {
  summaryResponse = await streamCompactSummary({ messages: messagesToSummarize, ... })
  summary = getAssistantMessageText(summaryResponse)
  if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break  // 成功

  ptlAttempts++
  const truncated = ptlAttempts <= 3  // MAX_PTL_RETRIES
    ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
    : null
  if (!truncated) throw new Error('Conversation too long to summarize...')
  messagesToSummarize = truncated  // 切掉头部，重试
}
```

`truncateHeadForPTLRetry`（`compact.ts:247-297`）的截断策略：(1) 按 API-round 分组（`grouping.ts:22-63`），每组是 [user, assistant] 一对；(2) 计算 `tokenGap` = 当前 token 数 - 窗口上限，按 gap 切头部 N 组；(3) gap 计算失败（剩 20% 没解析出）时 fallback 丢弃前 20% 消息；(4) 最多重试 3 次，再失败抛 `ERROR_MESSAGE_PROMPT_TOO_LONG`。

**Prompt 设计在此 Phase 注入**：`getCompactPrompt(customInstructions)`（`prompt.ts:293-303`）由 `NO_TOOLS_PREAMBLE` + `BASE_COMPACT_PROMPT`（9 段强制结构）+ 可选 Additional Instructions + `NO_TOOLS_TRAILER` 拼成。`BASE_COMPACT_PROMPT`（`prompt.ts:61-143`）强制 LLM 输出 `<analysis>...</analysis><summary>...</summary>` 两个 XML 块，summary 含 9 个固定段落：Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work / Optional Next Step。

**四个 Prompt 工程关键决策**：

(1) **NO_TOOLS_PREAMBLE 放最前**（`prompt.ts:17-19`）："Putting this FIRST and making it explicit about rejection consequences prevents the wasted turn." cache-sharing fork 路径继承父线程完整 tools set（必须保持 cache-key match），在 Sonnet 4.6+ adaptive-thinking 上模型有时无视 trailer 弱指令去调工具。`maxTurns: 1` 时被 deny 的 tool call → 无 text 输出 → fallthrough 到 streaming fallback（4.6 上 2.79% vs 4.5 上 0.01%）。

(2) **`<analysis>` block 是 drafting scratchpad**：`formatCompactSummary`（`prompt.ts:311-335`）在 summary 进入 context 前**剥离 `<analysis>`**——它是 drafting scratchpad，让 LLM 写 summary 前先 brainstorm 提高质量，但本身无信息价值。最终留在 context 的只有 `<summary>` 内容。

(3) **"All user messages" 显式列出**：第 6 段强制"List ALL user messages that are not tool results"——避免 LLM 在 summary 中丢失 user 意图的细微变化。"user told you to do something differently" 这类反馈在 tool_result 噪音中容易遗忘。

(4) **Partial compact 的双 prompt**：`PARTIAL_COMPACT_PROMPT`（`prompt.ts:145-204`）和 `PARTIAL_COMPACT_UP_TO_PROMPT`（`prompt.ts:208-267`）方向相反——`from`：pivot 之后消息被 summarize，之前保留，Prompt 强调"RECENT portion"；`up_to`：pivot 之前消息被 summarize，之后保留，Prompt 强调"will be placed at the start of a continuing session"——summary 在前、新消息在后，cache 命中 prefix。

#### Phase 4: 校验 Summary —— LLM 返回的不一定是合法 summary

两类失败：**`no_summary`**（LLM 返回的 message 没有 text block，可能是 adaptive-thinking 下模型只输出 thinking 没输出 text，也可能是 tool_use 被 deny 后无 fallback 文本）；**`api_error`**（SDK 把 API 错误 5xx/rate limit yield 成 synthetic assistant message，text 以 "API Error:" 开头）。两种都直接抛错，由 Phase 7 的 `tengu_compact_failed` event 记录。

#### Phase 5: 状态清理 —— 为什么 sentSkillNames 不重置？

```typescript
// compact.ts:542-567
context.readFileState.clear()                // 清空已读文件缓存
context.loadedNestedMemoryPaths?.clear()     // 清空 memory 路径
// Intentionally NOT resetting sentSkillNames
```

`readFileState` 和 `loadedNestedMemoryPaths` 必须清空——压缩前的文件内容已过时（代码可能已改），下一轮应重新读取。但 `sentSkillNames` **不清空**。原因：`skill_listing` attachment 约 4K tokens，重新发送是纯 cache_creation 开销；`SkillTool` 仍在 tool schema 中，`invoked_skills` attachment（Phase 6 恢复）保留了已用 skill 的完整内容，重新发 skill_listing 边际收益为零。同时异步准备 `fileAttachments`（最近读过文件）和 `asyncAgentAttachments`（后台 agent 状态）。

#### Phase 6: 构造 Post-compact 输出 —— 7 类附件的拼装顺序

最长的 Phase，但逻辑清晰：**按优先级依次拼装 7 类附件 + boundary marker + summary**。

| 顺序 | 附件 | 触发条件 | token 预算 |
|------|------|---------|-----------|
| 1 | `fileAttachments` | readFileState 非空 | 5 文件，单文件 5K，总 50K |
| 2 | `asyncAgentAttachments` | 有未 retrieve 的后台 agent | 无明确上限 |
| 3 | `planAttachment` | plan 文件存在 | 完整 plan |
| 4 | `planModeAttachment` | 当前在 plan mode | 小（一条提醒） |
| 5 | `skillAttachment` | 有 invoked skills | 单 skill 5K，总 25K |
| 6 | `*DeltaAttachment` | 总是（tools/agents/MCP） | 取决于工具集大小 |
| 7 | `hookMessages` | SessionStart hooks 输出 | 取决于 CLAUDE.md 大小 |

最后创建 `boundaryMarker`——`createCompactBoundaryMessage`（`messages.ts:4967-4992`）生成 `SystemCompactBoundaryMessage`，含 `trigger`（auto/manual）、`preTokens`、`logicalParentUuid`。

#### Phase 7: 持久化 & 事件 —— compact 的副作用管理

```typescript
// compact.ts:656-746
logEvent('tengu_compact', { preCompactTokenCount, postCompactTokenCount, ... })
notifyCompaction(...)        // 重置 cache break baseline
markPostCompaction()         // 标记 REPL 需刷新
reAppendSessionMetadata()    // 保持 --resume 可见
```

四个关键副作用：**`notifyCompaction`** 告知 cache break detector"这次 cache read 下降是我们主动清除的，不是 break"，避免误报触发不必要的 cache 重建；**`markPostCompaction()`** 设模块级 flag，`bootstrap/state.ts` 在下次 REPL 渲染时检查触发 UI 刷新；**`reAppendSessionMetadata()`** 把自定义 session title/tag 重新 append 到 JSONL 末尾——压缩前 metadata 在 ~50K 位置，压缩后新消息可能把它推出 16KB tail window，`--resume` 的 `readLiteMetadata` 只读最后 16KB，不 reAppend 会显示自动生成标题而非用户设置的名字；**`executePostCompactHooks`** 让 hooks 系统收到 summary 做后续动作（写外部 memory、通知 webhook）。

#### Phase 8: 返回 CompactionResult

```typescript
// compact.ts:767-777
return {
  boundaryMarker, summaryMessages, attachments: postCompactFileAttachments,
  hookResults: hookMessages, preCompactTokenCount, postCompactTokenCount, ...
}
```

调用方（`autoCompact.ts:357`）用 `buildPostCompactMessages`（`compact.ts:336-343`）按固定顺序拼成新 messages 数组：

```
[boundaryMarker, summaryMessages, messagesToKeep(stripped), attachments, hookResults]
```

`messagesToKeep` 在 autocompact 时为空（全部压缩），在 partial compact 时为 pivot 之后的保留段。

compactConversation 的 8 Phase 生命周期结束，产出 CompactionResult。但这个 result 里的 cache 协作细节（fork 如何命中 cache、cache_edits 如何跨 turn 保持）分散在 Phase 2/3 中，值得单独梳理——下一节展开 Cache-aware 协作机制。

### 4.3 Cache-aware 协作机制（贯穿 Stage 2/3/5 的缓存保持策略）

上一节的 compactConversation 在 Phase 2/3 涉及多处 cache 协作（fork 命中、cache_edits 传出）。但 cache 逻辑不止于此——它贯穿 Stage 2（snip）、Stage 3（microcompact）、Stage 5（compact fork），是横切关注点。本节统一梳理这些机制：每个机制回答"为什么需要保 cache → 怎么保 → 具体实例"。

**为什么压缩要小心翼翼保 cache**：prompt cache 的命中能省 ~10× 的 input 成本。一次 compact 如果破坏 cache prefix，下一轮 API 调用就要全量 cache_creation——可能把 compact 省下的 token 又吐回去。所以压缩设计的第一准则：**能不动 cache prefix 就不动；必须动时，让动本身对 cache 友好**。

#### 机制 1：cache_edits 不动本地 message（Stage 3 路径 B）

**为什么需要**：Cached MC 要删旧 tool_result，但改 content 会破坏 cache prefix。需要一种"本地不动、服务端跳过"的手段。

**怎么做**：

```typescript
// microCompact.ts:389-399
return {
  messages,  // 原 messages 不变
  compactionInfo: {
    pendingCacheEdits: {
      trigger: 'auto',
      deletedToolIds: toolsToDelete,
      baselineCacheDeletedTokens: baseline,
    },
  },
}
```

Cached MC **不修改** `messages` 数组，把 cache_edits block 通过 `pendingCacheEdits` 传出，调用方（`query.ts:618-623`）交给 API 层注入 request。服务端在 cache 命中后按 edits 跳过对应块——本地 cache key 不变，但服务端实际处理内容减少。

**具体实例**：会话第 80 轮，前 60 轮的 40 个 tool_result 仍在 messages 里（占 80K tokens），但 cache 已命中这 80K。走 cache_edits：本地 messages 原封不动，告诉服务端"这 40 个 tool_use_id 跳过"。下一轮 cache 仍命中 80K prefix，服务端只处理新增内容。

#### 机制 2：baseline 计算（区分本次删除 vs 累计删除）

**为什么需要**：API 的 `cache_deleted_input_tokens` 是 cumulative/sticky 字段——它累计所有历史删除量。要算"本次请求删了多少"，必须减去上次 baseline。

**怎么做**：

```typescript
// query.ts:1128-1150
if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
  const lastAssistant = assistantMessages.at(-1)
  const usage = lastAssistant?.message.usage
  const cumulativeDeleted = usage
    ? ((usage as unknown as Record<string, number>).cache_deleted_input_tokens ?? 0)
    : 0
  const deletedTokens = Math.max(0, cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens)
  if (deletedTokens > 0) {
    yield createMicrocompactBoundaryMessage(
      pendingCacheEdits.trigger, 0, deletedTokens, pendingCacheEdits.deletedToolIds, [],
    )
  }
}
```

本次请求前 baseline + 本次请求后 cumulative = 本次删除 delta。这个 delta 用于生成 `microcompact_boundary`，让 UI 和 analytics 知道这次删了多少。

#### 机制 3：Pinned Cache Edits（跨 turn 保持 cache_edits）

**为什么需要**：cache_edits 不是一次性的——后续每次请求都要带上历史所有 cache_edits，否则旧 cache_edits 位置的 cache prefix 失配。

**怎么做**：

```typescript
// microCompact.ts:111-118
export function pinCacheEdits(userMessageIndex: number, block: CacheEditsBlock): void {
  if (cachedMCState) {
    cachedMCState.pinnedEdits.push({ userMessageIndex, block })
  }
}
```

`pinnedEdits` 缓存所有历史 cache_edits，**在后续每次请求中重新发送**——这是 cache stability 的关键：即使新 tool_result 被添加，旧的 cache_edits 仍需在原位置保持。

**具体实例**：第 80 轮 pin 了 40 个 tool_id 的 edits；第 85 轮又新增 5 个 tool_result 需删。第 85 轮请求带上 40+5=45 个 edits，前 40 个在原位置保持，新 5 个追加——cache prefix 不失配。

#### 机制 4：Time-based MC 反向 invalidate cache（Stage 3 路径 A）

**为什么需要**：Time-based MC 直接 mutate content → cache prefix 必失效。需要主动通知 break detector"这次是我主动改的，不是 cache break"，避免误报。

**怎么做**：

```typescript
// microCompact.ts:521-523
resetMicrocompactState()
// We just changed the prompt content — the next response's cache read
// will be low, but that's us, not a break.
if (feature('PROMPT_CACHE_BREAK_DETECTION') && querySource) {
  notifyCacheDeletion(querySource)
}
```

`resetMicrocompactState` 清掉 cachedMCState，避免下一轮 cachedMC 用 stale tool IDs；`notifyCacheDeletion` 通知 break detector 不要把这次 drop 误报为 break。**为什么这里允许破坏 cache**：60min 不活动意味着 cache TTL 已过、cache 本来就冷，mutate content 是"白换不亏"。

#### 机制 5：Prompt-cache sharing（fork 路径，Stage 5）

**为什么需要**：Stage 5 的 summary 调用需要完整 system+tools，新开 streaming 请求会全量 cache_creation。fork 进程复用主线程 cache prefix，但 fork 的 cache key params 必须与主线程完全 match，否则 miss。

**怎么做**：

```typescript
// compact.ts:1212-1234
if (promptCacheSharingEnabled) {
  try {
    // DO NOT set maxOutputTokens here. The fork piggybacks on the main thread's
    // prompt cache by sending identical cache-key params (system, tools, model,
    // messages prefix, thinking config). Setting maxOutputTokens would clamp
    // budget_tokens via Math.min(budget, maxOutputTokens-1) in claude.ts,
    // creating a thinking config mismatch that invalidates the cache.
    const result = await runForkedAgent({
      promptMessages: [summaryRequest],
      cacheSafeParams,
      canUseTool: createCompactCanUseTool(),
      querySource: 'compact',
      forkLabel: 'compact',
      maxTurns: 1,
      skipCacheWrite: true,
      overrides: { abortController: context.abortController },
    })
    ...
  }
}
```

**三个让 cache 命中的关键约束**：(1) **不设 maxOutputTokens**——否则 claude.ts:1185 用 `Math.min(budget, maxOutputTokens-1)` clamp budget_tokens → thinking_config 不匹配 → cache miss；(2) **`canUseTool` deny all tools**——`createCompactCanUseTool`（`compact.ts:1159-1168`）返回 deny，summary fork 不会发 tool_use → cache key 不变；(3) **`maxTurns: 1` + `skipCacheWrite: true`**——只调一次 LLM 不写 cache（避免 compact 自身 summary 进主线程 cache 污染）。

**具体实例**：长会话第 100 轮 autocompact 触发，主线程已建 150K cache。fork 继承这 150K cache，只传 1 条 summary 请求（~2K tokens），cache 命中 150K，只新建 2K。若走 streaming 独立请求，150K 全量 cache_creation，成本高 75×。

#### 机制 6：验证 cache 命中

```typescript
// compact.ts:1248-1262
if (!assistantText.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) {
  logEvent('tengu_compact_cache_sharing_success', {
    preCompactTokenCount,
    outputTokens: result.totalUsage.output_tokens,
    cacheReadInputTokens: result.totalUsage.cache_read_input_tokens,
    cacheCreationInputTokens: result.totalUsage.cache_creation_input_tokens,
    cacheHitRate: result.totalUsage.cache_read_input_tokens > 0
      ? result.totalUsage.cache_read_input_tokens /
        (result.totalUsage.cache_read_input_tokens +
         result.totalUsage.cache_creation_input_tokens +
         result.totalUsage.input_tokens)
      : 0,
  })
}
```

cacheHitRate 仅记录不 throw——cache miss 时 streaming fallback 兜底。

#### 机制 7：Snip 算法细节（Stage 2 的 cache 互补）

Snip 是 Stage 2 的手动删除机制，与 cache-aware 互补——cache-aware 保 cache，snip 删死分支。§4.1 已介绍概念和触发，这里补算法细节。

**数据结构**：Snip 用一对消息协同——`snip_boundary`（system message，subtype='snip_boundary'，metadata.removedUuids = 待删 UUID 列表）和 `snip_marker`（system message，subtype='snip_marker'，标记已"snip 标记"但尚未移除）。

`snipCompactIfNeeded`（`snipCompact.ts:83-147`）从后往前找 `snip_boundary`，取其 `removedUuids`，机械过滤：

```typescript
const removedSet = new Set(removedUuids)
const kept: Message[] = []
let tokensFreed = 0
for (const msg of messages) {
  if (removedSet.has(msg.uuid)) {
    tokensFreed += estimateMessageTokens(msg)
    continue
  }
  kept.push(msg)
}
return { messages: kept, executed: true, tokensFreed, boundaryMessage }
```

**谁决定哪些 UUID 该 snip**？`snipCompactIfNeeded` 不是 LLM 决策——它只机械按列表删。`/force-snip` 命令（`src/commands/force-snip.ts`）让用户显式选区间；LLM 主动调 snip tool（feature gated）则 LLM 自己选。`shouldNudgeForSnips`（`snipCompact.ts:163-165`）在消息数 ≥ `SNIP_NUDGE_THRESHOLD`（30）时提示用户/LLM 考虑 snip。但这是 user-facing nudge，模型用 snip tool 的判定完全由 LLM 自己做。

**projection 的 view 语义**：`projectSnippedView`（`snipProjection.ts:35-60`）与 `snipCompactIfNeeded` 不同——前者保留 boundary、仅过滤 removedUuids（边界消息是 metadata，模型需看到才能理解）；后者从数组删除 boundary + removedUuids。调用场景不同：`getMessagesAfterCompactBoundary`（`messages.ts:5075+`）调 `projectSnippedView`（在 compact slice 上过滤 snip）；`query.ts:591` 调 `snipCompactIfNeeded`（query loop 只关心 model-facing 数组）。

**`tokensFreed` 与 autocompact 协同**：

```typescript
// query.ts:588-593
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  ...
}
```

```typescript
// autoCompact.ts:254
const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
```

`tokenCountWithEstimation` 从 **protected-tail assistant 的 usage.input_tokens** 读数字，这条 assistant 跨 snip 不变（snip 只删旧的）。所以减去 `snipTokensFreed` 是必要的，否则 autocompact 基于 stale 数据做 threshold 判断（`autoCompact.ts:192-197` 注释）。

Cache-aware 协作机制贯穿了 Stage 2/3/5，保证压缩不破坏 cache。但 compact 产出 CompactionResult 后，还有一道关键工序：状态恢复——下一节展开。

### 4.4 压缩后状态恢复（compact 输出之后如何重建可用上下文）

上一节的 compactConversation 在 Phase 6 拼装了 7 类附件、Phase 7 持久化了 boundary marker。但状态恢复不止于此——它还包含 boundary 的 DAG 语义、preserved segment 的链重写、CLAUDE.md 重新注入、QueryEngine 的 GC、JSONL 持久化与 reAppend。这些机制共同保证：**resume 一个压缩过的 session 时，不丢信息、不循环压缩、不留下 orphan**。

#### 7 类附件恢复

`compact.ts:568-612` 列出附件。每类的恢复策略：

| 附件 | 触发条件 | 内容 | 预算 |
|------|---------|------|------|
| `fileAttachments` | readFileState 非空 | 最近读过文件 re-read | 5 文件，每 5K，总 50K |
| `asyncAgentAttachments` | background agents 未 retrieve | task status 摘要 | 无明确上限 |
| `planAttachment` | plan 文件存在 | 完整 plan | 无明确上限 |
| `planModeAttachment` | toolPermissionContext.mode==='plan' | plan mode reminder | 小 |
| `skillAttachment` | invokedSkills 非空 | per-skill truncated text | 5K/skill, 25K 总 |
| `*DeltaAttachment` | 总是 | tools/agents/MCP delta | 取决于工具集大小 |

`POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000` 注释（`compact.ts:129-133`）解释 trade-off："Skills can be large (verify=18.7KB, claude-api=20.1KB). Previously re-injected unbounded on every compact → 5-10K tok/compact. Per-skill truncation beats dropping — instructions at the top of a skill file are usually the critical part. Budget sized to hold ~5 skills at the per-skill cap." `truncateToTokens`（`compact.ts:1712-1718`）保留 head，附 marker 告诉模型"use Read on the skill path if you need the full text"。

**为什么是这 7 类**：它们代表了"压缩前 LLM 拥有、压缩后丢失、但下一轮仍需要"的环境状态。文件/skill/agent 是"能力"（我还能用什么），plan/planMode 是"约束"（当前在什么模式下），delta 是"增量"（工具集相对默认有什么变化）。缺任何一类，LLM 都会"失忆"——不是忘对话，而是忘环境。

#### `compact_boundary` 消息结构

```typescript
// messages.ts:4967-4992
export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  lastPreCompactMessageUuid?: UUID,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: { trigger, preTokens, userContext, messagesSummarized },
    ...(lastPreCompactMessageUuid && { logicalParentUuid: lastPreCompactMessageUuid }),
  }
}
```

**三个字段语义**：`trigger: 'auto' | 'manual'`（autocompact vs `/compact`）；`preTokens`（压缩前 token 计数，等于 preCompactTokenCount）；`lastPreCompactMessageUuid` → `logicalParentUuid`（JSONL 物理边界前最后一条）。`logicalParentUuid` 是 DAG 锚点——让物理上断开的逻辑链可重建。

#### Preserved Segment 链重写

**为什么需要**：partial compact 保留 pivot 一侧的原文消息（preserved segment）。这些消息物理上 parentUuid 指向压缩前的旧链，但逻辑上应接在 summary 之后。resume 时必须重写 DAG parent 指针，否则逻辑链断裂。

**怎么做**：`partialCompactConversation` 在 `messagesToKeep` 非空时调 `annotateBoundaryWithPreservedSegment`（`compact.ts:373-391`），在 boundary 附加 `preservedSegment: { headUuid, anchorUuid, tailUuid }`——标记保留段起点、锚点、终点。`applyPreservedSegmentRelinks`（`sessionStorage.ts:1876-1993`）在 resume 加载 transcript 时执行，按 4 步算法重写 DAG parent 指针：

- **Step 1：找边界并校验 segIsLive**（line 1883-1907）。遍历 messages.map，记录 `absoluteLastBoundaryIdx`（最后一条 `isCompactBoundaryMessage`）和 `lastSegBoundaryIdx`（最后一条带 `preservedSegment` 的 boundary）。`segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx`——防止 manual `/compact` 在 reactive compact 之后把 seg 弄成"幽灵"。
- **Step 2：tail → head walk 完整性**（line 1909-1940）。从 `tailUuid` 沿 `parentUuid` 反向遍历收集 `preservedUuids`，到 `headUuid` 则 `reachedHead = true`。否则 log `tengu_relink_walk_broken` 并 **return**——整个函数 no-op，不修改不 prune，resume 回退到加载全量历史。Known root cause：mid-turn-yielded attachment pushed 到 `mutableMessages` 但未 `recordTranscript`（SDK subprocess 在下一轮 flush 前被 kill）。
- **Step 3：head.parentUuid ← anchor + 兄弟节点 → tail**（line 1942-1956）。两处 patch：(a) `messages.set(headUuid, { ...head, parentUuid: anchorUuid })`——让 preserved[0] 跳过 boundary 接 summary；(b) 遍历所有 `parentUuid === anchorUuid` 且不是 `headUuid` 的兄弟节点，改 `parentUuid ← tailUuid`（tail-splice），避免成为 orphan。
- **Step 4：stale usage 清零**（line 1957-1976）。对 `preservedUuids` 中所有 `type==='assistant'` 的消息，把 `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` 全部置 0。原因：`stripStaleUsage` 只打过内存里的副本，磁盘 JSONL 因 `recordTranscript` dedup-skip 而保留压缩前 token 数（~190K），不归零 resume 会立即触发 autocompact 形成死循环。

**DAG 重写前后对比**：

```
BEFORE (物理链, JSONL append-only, parentUuid 不变):             AFTER (内存中 Map, 已被 patch):

[...preCompact user/asst...]                                     [boundary]
[anchor = summary_user  or  boundary (suffix-keep)]                ↓
  ├─ child_a (other branch, untouched)                            ↓ parentUuid ← anchor (PATCH 1)
  └─ child_b                                                       ↓
      ├─ preserved[0] (head)                                     [preserved[0]] ← parentUuid = anchor
      │  parentUuid → ...preCompact user/asst... ← stale!           ↓
      ├─ preserved[1..n]                                          [preserved[1..n]] ← parentUuid 链完整
      └─ preserved[N] (tail)  parentUuid → preserved[N-1]           ↓
[boundary] compactMetadata.preservedSegment =                    [... → preserved[N] (tail)]
   {headUuid=preserved[0].uuid,                                   ↓
    anchorUuid,                                                  [child_a] ← parentUuid = tail (PATCH 2)
    tailUuid=preserved[N].uuid}                                    (其他 child_b 已删/已合并)
```

#### CLAUDE.md / memory 重新注入

通过 `processSessionStartHooks('compact', { model })`（`compact.ts:619-621`）触发 SessionStart hook 链——`hooks.ts` 调 `getUserContext()` 重新读 CLAUDE.md/memory，与冷启动 session 行为一致。**为什么必须重新注入**：CLAUDE.md 内容在压缩中可能被概括进 summary，但下一轮 LLM 需要原始的、完整的 project instructions 作为地基——summary 是对话叙事，不能替代项目指令。

#### `readFileState.clear()` 后的附件注入

```typescript
// compact.ts:1461-1510
export async function createPostCompactFileAttachments(
  readFileState: Record<string, { content: string; timestamp: number }>,
  toolUseContext: ToolUseContext,
  maxFiles: number,
  preservedMessages: Message[] = [],
): Promise<AttachmentMessage[]> {
  const preservedReadPaths = collectReadToolFilePaths(preservedMessages)
  const recentFiles = Object.entries(readFileState)
    .map(([filename, state]) => ({ filename, ...state }))
    .filter(file =>
      !shouldExcludeFromPostCompactRestore(file.filename, toolUseContext.agentId)
      && !preservedReadPaths.has(expandPath(file.filename))
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxFiles)
  ...
}
```

**双层 dedup**：`preservedReadPaths`（保留段中已 Read 的文件路径，避免重复注入内容相同的 Read）；`shouldExcludeFromPostCompactRestore`（plan 文件 / CLAUDE.md / memory 文件，这些已有专用 attachment）。

#### QueryEngine 消费 compact_boundary

```typescript
// QueryEngine.ts:958-982
if (msg.type === 'compact_boundary') {
  const mutableBoundaryIdx = this.mutableMessages.findIndex(...)
  if (mutableBoundaryIdx !== -1) {
    this.mutableMessages.splice(0, mutableBoundaryIdx)
  }
  const localIdx = messages.findIndex(...)
  if (localIdx !== -1) messages.splice(0, localIdx)
  yield SDKCompactBoundaryMessage with toSDKCompactMetadata(...)
}
```

**GC 关键点**：REPL 全量历史在 `mutableMessages`，UI 滚动回溯依赖它。但 compact 之后的旧消息对当前 query 已无用——`splice(0, idx)` 释放它们，避免长会话内存增长失控。`preservedSegment.tailUuid` walk（line 714-730）确保 `recordTranscript` 写入不留 orphan。

#### 持久化：JSONL boundary marker + reAppend

**JSONL `compact_boundary` marker**：写入位置是 `recordTranscript`（通过 normal message yield 路径，自动持久化）。JSONL 物理结构：

```
[user][asst][user][asst][COMPACT_BOUNDARY][summary_user][user][asst]
                              ↑
                          parentUuid = last-pre-compact-uuid
                          logicalParentUuid = first-post-compact-uuid
```

**Resume 时 `loadTranscriptFile`**（`sessionStorage.ts`）顺序：(1) parse JSONL → `Map<UUID, TranscriptMessage>`；(2) `applyPreservedSegmentRelinks` 处理 preserved chain 重写（[§4.4](#preserved-segment-链重写)）；(3) `applySnipRemovals` 处理 snip 删除（参见 [17-persistence-and-cache](cc-17-persistence-and-cache.md)）；(4) `findLastCompactBoundaryIndex` 找最后一条 boundary；(5) `getMessagesAfterCompactBoundary` 从 boundary 开始切片（默认不含 boundary 之前的消息）。

**`reAppendSessionMetadata`**（`compact.ts:740, 1091`）注释："Re-append session metadata (custom title, tag) so it stays within the 16KB tail window that readLiteMetadata reads for --resume display. Without this, enough post-compaction messages push the metadata entry out of the window, causing --resume to show the auto-generated title instead of the user-set session name." compact 后会有新 messages 写入（summary + attachments），若 metadata 在压缩前 ~50K 位置，16KB tail window 已看不见。reAppend 把它移到 EOF 让 `--resume` 找得到。

**KAIROS transcript segment**：

```typescript
// compact.ts:744-746
if (feature('KAIROS') {
  void sessionTranscriptModule?.writeSessionTranscriptSegment(messages)
}
```

Fire-and-forget 写入 reduced transcript segment（KAIROS 启用的子项目），error 在 module 内部 log。详见 `src/services/sessionTranscript/`。

**Resume 后的二次压缩风险**：resume 一个已 compact 过的 session 时，`getMessagesAfterCompactBoundary` 已把 pre-compact 段切掉，理论上不重复 compact。但若 preserved segment 中 token 累计超阈值，autocompact 会再次触发（`compact.ts:691-693` 记录的 `isRecompactionInChain` 字段用于 analytics 区分）。

状态恢复机制保证 resume 不丢信息、不循环压缩。但整个生命周期中任一环节都可能失败——下一节看失败回退如何兜底。

### 4.5 失败回退与安全网（贯穿生命周期的可靠性保障）

前面四节描述了"正常路径"——5 阶段决策链、compactConversation、cache 协作、状态恢复。但长会话可靠性要求每个失败点都有兜底。本节沿生命周期梳理六类失败回退，每类回答"什么会失败 → 怎么回退 → 具体场景"。

#### 失败 1：compact API 调用本身 PTL（CC-1180）

**什么会失败**：compact 自己的 LLM 调用 PTL——典型场景用户发 50 张截图，messages 已超窗口。`truncateHeadForPTLRetry`（`compact.ts:247-297`）按 API-round 分组，按 `tokenGap` 切头部。

```typescript
// compact.ts:282-296
dropCount = Math.min(dropCount, groups.length - 1)
if (dropCount < 1) return null
const sliced = groups.slice(dropCount).flat()
if (sliced[0]?.type === 'assistant') {
  return [
    createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
    ...sliced,
  ]
}
return sliced
```

`PTL_RETRY_MARKER = '[earlier conversation truncated for compaction retry]'`——下次重试时会被 strip，避免 marker 自己变成 group 0 让 20% fallback 死循环（`compact.ts:251-260`）。

**怎么回退**：重试 3 次仍失败 → 抛 `ERROR_MESSAGE_PROMPT_TOO_LONG`（`compact.ts:299-300`）："Conversation too long to summarize. Try /compact to manually clear conversation history, or start a new session with /clear." `/compact` 命令捕获这个错误并 yield error notification；autocompact 路径不通知（避免 retry 中途的 UI 噪声），只 log `tengu_compact_failed` event。

**具体场景**：50 张截图会话，compact 第 1 次输入 250K tokens PTL；切头部 30% 后 175K，第 2 次成功。若截图太多切 3 次仍超，抛错让用户 `/clear`。

#### 失败 2：连续失败熔断

**什么会失败**：autocompact 持续失败（如服务端持续 5xx、session memory 反复校验不过）。不熔断会无限重试浪费 API。

**怎么回退**：

```typescript
// autoCompact.ts:99
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

注释（`autoCompact.ts:97-99`）："BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272) in a single session, wasting ~250K API calls/day globally." `tracking.consecutiveFailures` 跨 turn 持久（`state.autoCompactTracking`），连续 3 次失败 → 后续 turn 直接跳过 autocompact，让用户自己 `/compact` 或 `/clear`。

**具体场景**：服务端某时段持续 rate limit，autocompact 失败 3 次；第 4 轮起不再尝试，避免浪费——用户感知到 context 没自动压缩，可手动 `/compact`。

#### 失败 3：API fork 失败 fallback

**什么会失败**：`runForkedAgent` 失败（cache miss、网络、fork 进程死）。

**怎么回退**：

```typescript
// compact.ts:1274-1281
} catch (error) {
  logError(error)
  logEvent('tengu_compact_cache_sharing_fallback', {
    reason: 'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    preCompactTokenCount,
  })
}
```

自动 fallback 到 streaming 路径。`promptCacheSharingEnabled` 仍 true 但 fork 不可用时退化——cache 失去但 compact 仍能完成。

#### 失败 4：Streaming 失败重试

**什么会失败**：streaming 路径自身失败（DNS/TLS/5xx 或 partial response）。

**怎么回退**：

```typescript
// compact.ts:1284-1434
const retryEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_compact_streaming_retry', false)
const maxAttempts = retryEnabled ? MAX_COMPACT_STREAMING_RETRIES : 1

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  ...
  logEvent('tengu_compact_streaming_retry', { attempt, preCompactTokenCount, hasStartedStreaming })
  await sleep(getRetryDelay(attempt), context.abortController.signal, {
    abortError: () => new APIUserAbortError(),
  })
}
```

**`hasStartedStreaming`** 区分两类失败：`false`（连接都没建立就失败，DNS/TLS/5xx）→ 重试；`true`（流已开始消费 token，partial response）→ 重试风险高（重发产生重复内容），但 compact prompt 通常能去重。

#### 失败 5：Partial compact 失败语义

**什么会失败**：`partialCompactConversation`（`compact.ts:801-1140`）逻辑与全量几乎相同，但 pivot 切分可能产生空段。

**怎么回退**：差异在——`messagesToKeep` 单独算（pivot 前后切分）；`direction: 'from' | 'up_to'` 决定 summary 注入位置；`messagesToSummarize` 长度 0 → 抛 'Nothing to summarize ...'。

#### 失败 6：Reactive Compact —— 5 阶段没拦住的兜底安全网

**什么会失败**：前 5 阶段是**预估式**的——在 API 调用前根据 token 估算判断要不要压缩。但 token 估算可能不准（base64 图片、非文本 content block），导致 API 仍返回 `prompt_too_long`。

**怎么回退**：Reactive Compact（`reactiveCompact.ts`）是**响应式**的——在 API 明确返回错误**之后**才触发：

```
5 阶段压缩 → API 调用 → 返回 prompt_too_long
                              │
                              ├─► reactiveCompact.tryReactiveCompact()
                              │     紧急运行 compactConversation
                              │
                              ├─► 成功 → 用压缩后的 messages 重试 API
                              └─► 失败 → 放弃，返回错误给用户
```

**与 5 阶段的区别**：

| | 5 阶段（预估式） | Reactive Compact（响应式） |
|------|---------|------|
| 触发时机 | API 调用**前** | API 返回 PTL **后** |
| 判断依据 | token 估算 | API 明确报错 |
| 确定性 | 可能误判 | 确定需要压缩 |
| 重试 | 不涉及 | 压缩后重试 API |
| feature gate | 始终启用 | `REACTIVE_COMPACT` feature |

**实现**（`reactiveCompact.ts:60-97`）：`tryReactiveCompact` 直接调 `compactConversation`——和 Stage 5 优先级 2 走同一函数。区别在于它跳过 session memory 优化（紧急情况直接上 LLM），且 `hasAttempted` 保证只尝试一次（防无限循环）。

**两个触发条件**（`query.ts:1064-1071`）：`isWithheldPromptTooLong`（API 返回 `prompt_too_long`）；`isWithheldMediaSizeError`（API 返回 media 尺寸超限错误）。

**与 Context Collapse 的互斥**（`autoCompact.ts:224-252`）：当 `CONTEXT_COLLAPSE` feature 启用时，proactive autocompact 被禁用，但 reactiveCompact 仍存活——因为 Context Collapse 也可能拦不住 PTL，reactiveCompact 作为最后防线。

**具体场景**：用户粘贴 10 张高清截图，5 阶段预估式未触发（每张图 token 估算偏低），API 调用返回 PTL。reactiveCompact 紧急运行 compactConversation 把图片描述进 summary，重试 API 成功——用户无感知。

至此，第四层沿生命周期走完了从"消息进入压缩栈"到"失败兜底"的完整数据流。但还有一类**质量问题**不被 failure 回退捕获——压缩成功了（无 PTL、无报错、无熔断），summary 却丢了关键信息，导致后续推理效果下降。这类问题无法靠 §4.5 的回退机制发现（系统认为压缩成功了），需要用户主动调优，下一节展开。

### 4.6 压缩质量调优：压缩过度时怎么办

本节从根因出发，给出"即时手段 → 阈值调整 → 时机心智"三个层次的应对。

#### 4.6.1 先定位根因：压缩为什么会"过度"

压缩过度通常源于三个张力，每个对应不同症状与手段：

| 根因 | 典型症状 | 对应手段 |
|------|---------|---------|
| **触发太晚** | 默认 93.5% 窗口才触发，待总结历史极长，summary 粗糙、丢细节 | §4.6.3 提前阈值 / §4.6.4 主动 compact |
| **指令太泛** | 默认 9 段 prompt 让模型自由总结，未聚焦当前任务核心 | §4.6.2 带聚焦指令的 `/compact` |
| **不可逆** | summary 一旦生成，细节永久丢失（见收束 §边界局限 局限 1） | §4.6.2 `/force-snip` 或 PreCompact hook 提前干预 |

**关键洞察：压缩质量下降的主因是触发时机太晚，不是 prompt 设计差。** 默认阈值 `effectiveContextWindow - 13K`（200K 窗口 ≈ 187K，即 93.5% 使用率，`autoCompact.ts:101-120`）意味着模型要在接近满载的压力下总结超长历史——这与 §4.2 Phase 3 的 PTL 重试同理：历史越长，summary 越易失真。所以"提前压"是性价比最高的改善方向。

#### 4.6.2 即时手段：命令与 hook

**手段 1：`/compact <聚焦指令>` —— 最直接控制保留什么**

`/compact` 命令接受自定义指令参数（`compact.ts:53` `const customInstructions = args.trim()`），指令经 `mergeHookInstructions` 合并后注入 compact prompt 的 "additional summarization instructions" 槽位（`prompt.ts:133-142`）。模型生成 9 段 summary 时会优先遵循这段指令。

```
/compact 聚焦在 auth 模块重构，保留 login.ts 与 middleware.ts 的完整改动、所有报错堆栈、以及用户关于"保留错误处理"的反馈
```

**一个反直觉细节**：带指令的 `/compact` 会**跳过 session memory 优化**（`compact.ts:58` 的 `if (!customInstructions)` 守卫），直接走 LLM summary。因为 session memory 是后台预提取的通用摘要，无法响应自定义聚焦——当你需要精确控制保留内容时，这个跳过是必要的代价（一次 ~17K output tokens 的 LLM 调用，见 `autoCompact.ts:30`）。

**手段 2：`/force-snip` —— 不要摘要，直接丢死分支**

当某段历史已无价值（试错失败、跑题探索），用 `/force-snip`（`src/commands/force-snip.ts`）插入 snip 边界，下一轮入口机械删除（§4.1 Stage 2）。与 `/compact` 的关键区别：snip **不调 LLM、不生成 summary、信息直接丢弃**。适合"我知道这段没用了，别花 token 去总结它"——把 LLM 调用预算留给真正需要概括的内容。

**手段 3：PreCompact Hook —— 自动化注入聚焦指令**

若每次手动带指令太繁琐，PreCompact hook 可在每次压缩前自动注入 `customInstructions`（§3.5、§4.2 Phase 1 的 `executePreCompactHooks`，`compact.ts:444`）。例如 CI 环境配置 hook 注入"详细总结测试失败与覆盖率变化"，则所有自动/手动压缩都带上这条指令。它比 PostCompact hook 更有价值——在 summary 生成**前**介入，能改变 summary 本身；PostCompact 只能消费已生成的 summary。

#### 4.6.3 调阈值：环境变量与大窗口

当默认触发时机不符合需求，用环境变量调整。所有 override 在 `autoCompact.ts` / `context.ts` 有读取逻辑：

| 环境变量 | 作用 | 位置 | 适用场景 |
|---------|------|------|---------|
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 用百分比覆盖触发阈值（如 `50` = 用到 50% 窗口就压） | `autoCompact.ts:108-117` | **最实用**：提前压缩，趁历史短、摘要质量高 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 覆盖上下文窗口大小（取 `Math.min`） | `autoCompact.ts:40-46` | 模拟小窗口提前触发，或限制可用窗口 |
| `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE` | 覆盖硬阻塞限制（超此值拒绝 API 调用） | `autoCompact.ts:156-163` | 调整"强制 /compact"的红线 |
| `DISABLE_AUTO_COMPACT=1` | 关掉自动压缩，只留手动 `/compact` | `autoCompact.ts:181` | 完全掌控压缩时机 |
| `DISABLE_COMPACT=1` | 彻底关掉所有压缩 | `autoCompact.ts:177` | 调试或确信不需要压缩 |
| `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` | 反向关闭 1M 窗口 | `context.ts:33` | 强制走 200K 窗口 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | （仅 ant 用户）直接覆盖窗口大小 | `context.ts:66` | 精确设定窗口 |

**`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 是质量调优最实用的一个旋钮**：设为 `50` 或 `60`，让自动压缩在窗口半满时就触发——此时待总结的历史短、模型压力小，summary 质量显著高于 93% 时的"满载强压"。代价是压缩更频繁（更多 ~17K output 的 LLM 调用），但在质量敏感场景（长重构、复杂调试）值得。

**配合大窗口**：若模型支持，开启 1M context 后 buffer 自动从 13K 升到 50K（`autoCompact.ts:79`，窗口 ≥800K 分级），压缩频率大幅下降。但大窗口是"用空间换压缩次数"——延迟压缩而不消除压缩，历史足够长后仍会触发，且 1M 下的 summary 要总结的历史更长，质量未必优于"小窗口 + 提前 compact"。因此大窗口应配合 §4.6.4 的主动压缩，而非单纯依赖自动触发。

#### 4.6.4 根本性建议：主动压缩优于被动等待

综合前三节，处理"压缩过度"最有效的不是某个开关，而是**改变压缩时机的心智模型**：

| 模式 | 触发时机 | 历史长度 | summary 质量 |
|------|---------|---------|-------------|
| 被动等自动压缩（默认） | 93.5% 窗口 | 极长 | 最低，满载压力下失真最严重 |
| 主动提前 `/compact` | 50-60% 窗口 | 中等 | 高，历史尚短 |
| 带聚焦指令的 `/compact` | 任意时机 | 任意 | 最高，精确控制保留内容 |

**实操节奏**：长会话中，每当完成一个阶段性任务（一个 bug 修完、一个模块重构完），主动 `/compact <下一阶段的聚焦点>`。这相当于"阶段性存档"——把已完成工作浓缩成高质量 summary，为下一阶段腾出干净窗口。比等到 93% 自动触发再补救，质量高一个量级。

**与 §4.5 失败回退的边界**：本节处理"压缩成功但质量差"，§4.5 处理"压缩本身失败（PTL / 熔断 / fork 死）"。两者不重叠——质量问题是 LLM-driven compression 的根本限制（收束 §边界局限 局限 2 的 Summary 失真），只能靠调优时机与指令缓解，无法靠 failure 回退捕获。极端情况下若 summary 已严重失真且影响后续推理，最后手段是 `/clear` 重开会话，或 `--resume` 回到 `compact_boundary` 之前的 checkpoint——但 boundary 之后的细节已不可逆（收束 §边界局限 局限 1）。

下一节进入收束——从设计权衡、边界局限、可复用模式三个角度提炼全文。

## 收束

第四层走完了压缩生命周期的细节。本节从三个角度提炼全文：**设计权衡**（为什么这样取舍）、**边界局限**（当前实现的不足）、**可复用模式**（可迁移到其他系统的通用设计）。

### 设计权衡

整个子系统贯穿一组核心张力，每个机制都是对某个张力的权衡回应：

**权衡 1：压缩率 vs cache 命中率**。压缩越激进省 token 越多，但破坏 cache prefix 的代价是下一轮全量 cache_creation。系统的回应是**分层差异化处理**：Stage 1 用 frozen-forever 规则保 cache；Stage 3 分冷热两路（热走 cache_edits 不动本地、冷才 mutate）；Stage 5 fork 复用主线程 cache。能不动 cache 就不动，必须动时让动本身对 cache 友好。

**权衡 2：代价 vs 智能**。便宜的本地操作视野窄（只看单条消息），昂贵的 LLM 调用视野宽（看整段对话）。系统的回应是**代价递增决策链**——5 阶段从 O(1) 本地到 LLM 调用，先用便宜手段扫局部，扫不干净再动用全局智能。Stage 5 内部还有同构的子链（session memory 免 LLM → LLM summary）。

**权衡 3：信息保留 vs 窗口约束**。长会话信息量大，窗口有限，必须丢。系统的回应是**分层丢失**：Stage 1 持久化到文件（不真丢，可 Read 回来）；Stage 3 占位符化（丢了但 context 已切换无价值）；Stage 5 结构化 summary（叙事保留、细节丢失）+ 7 类附件恢复（环境状态不丢）。不同重要级的信息用不同丢失策略。

**权衡 4：自动 vs 手动**。自动压缩高效但不理解语义，手动 snip 理解语义但需人介入。系统的回应是**分工**——按数值规则的压缩全自动（Stage 1/3/4/5），按语义判断的死分支删除交手动（Stage 2 snip），并配 `shouldNudgeForSnips` 在合适时机提示。

**权衡 5：预估式 vs 响应式**。预估式压缩体验好（不中断），但 token 估算可能不准；响应式压缩确定准，但用户感知到中断。系统的回应是**双保险**——预估式 5 阶段为主，响应式 Reactive Compact 兜底。两者用同一 `compactConversation` 函数，仅触发时机不同。

**权衡 6：fork 复用 vs 独立 streaming**。fork 省 cache 但约束多（cache key params 必须 match），streaming 灵活但 cache miss。系统的回应是**默认 fork + 失败 fallback**——`tengu_compact_cache_prefix` 默认 true 走 fork，fork 失败自动降级 streaming。三个 cache 命中约束（不设 maxOutputTokens、deny all tools、skipCacheWrite）是 fork 路径的代价。

### 可复用模式

**模式 1：Layered compression（分层压缩）**。把"减少 token"目标拆成 N 个阶段，每阶段独立触发条件、独立数据变换、按顺序执行。早期阶段 O(1) 时间、不调 LLM；晚期阶段视野小、可能调 LLM。**应用**：本系统的 5 阶段栈。任何系统需要"长上下文管理"时可借鉴——text replacement → node elimination → cache-aware → server-side → LLM-driven summary，每层独立可测。

**模式 2：Cache-aware ops（缓存感知操作）**。cache key 依赖 content，稳定 cache prefix 的关键是让被替换的 content 仍然"对 cache 友好"（相同 id 同 replacement，或不动 message 仅 API 层 edit）。**应用**：`applyToolResultBudget` 用 `state.replacements` 保证同 tool_use_id 同 replacement；Cached MC 不动 messages，通过 `cache_edits` API 让服务端处理；重新注入的 skill 用 truncated 但 stable 的字符串。

**模式 3：Boundary markers for resume（边界 marker 支持恢复）**。在 lossy 操作（compact / snip / commit）边界插入 system message marker，标记**操作类型 + 触发原因 + 可选 preserved segment**，让 resume 时能 replay 操作或跳过压缩区。**应用**：`compact_boundary` 的 `compactMetadata.{trigger, preTokens, preservedSegment}` 让 resume 既能定位又能重建；`snip_boundary` 的 `snipMetadata.removedUuids` 让重复加载时仍能正确删除；`applyPreservedSegmentRelinks` 在 resume 时检测 walk broken → 降级到全量加载，避免 phantom 链。

**模式 4：Fork for cache-sharing（fork 路径复用 cache）**。当一个 LLM 调用需要与主线程共享 prefix cache，让它跑在 fork 进程而不是新开 streaming 上下文，前提是 cache key params 完全 match（system/tools/model/thinking）。**应用**：`runForkedAgent({ forkLabel: 'compact', maxTurns: 1, skipCacheWrite: true })`。关键约束：不设 `maxOutputTokens`（避免 thinking_config 不匹配）；`canUseTool` 全 deny（避免 tool_use 进 cache key）；`skipCacheWrite`（避免 compact 自身 summary 污染主线程 cache）。

**模式 5：Circuit breaker on consecutive failures（连续失败熔断）**。跨 turn 持久 `consecutiveFailures` counter，连续 N 次失败后熔断（停止 retry），避免不可恢复的错误浪费 API。**应用**：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` + `state.autoCompactTracking.consecutiveFailures`。BQ 数据支持：1,279 sessions 失败 50+ 次，浪费 250K API/天——熔断是必要的成本控制。

**模式 6：PTL retry with truncation（PTL 重试时主动截断）**。当自身 API 调用 PTL，不要直接放弃——按 API-round 分组、按 token gap 切头部、重新调。最多 N 次重试。**应用**：`truncateHeadForPTLRetry`（compact.ts:247）+ `MAX_PTL_RETRIES = 3`。关键 trick：用 `PTL_RETRY_MARKER` 占位避免重试时 marker 自己成 group 0 让 fallback 死循环。

**模式 7：Pre/post hooks（前后 hook 让外部注入逻辑）**。在 compaction 前后各暴露 hook 时机，让 hooks 系统可以注入 custom instructions、修改 summary 内容、通知外部系统。**应用**：`executePreCompactHooks`（让 hook 改写 `customInstructions`，compact 前的 hook 比 compact 后 hook 更有价值）；`executePostCompactHooks`（让 hook 收到 summary 做后续动作，写入 memory、通知 webhook）；`processSessionStartHooks('compact', ...)`（复用 session 启动 hook 重新注入 CLAUDE.md）。

**模式 8：Proactive + Reactive 双保险（预估式 + 响应式）**。对于"估算可能不准"的关键操作，同时提供预估式主路径和响应式兜底，两者复用同一核心函数。**应用**：5 阶段预估式 + Reactive Compact 响应式，都用 `compactConversation`。预估式挡不住时响应式补救，用户体验无中断。

---

## 附录 A：与其他文档的交叉引用

- **05-agent-loop**：[第 616 行](cc-03-agent-loop.md) 提到的 5 层压缩顺序在本篇 [第二层](#第二层在整体架构中的位置) 完整展开。
- **17-persistence-and-cache**：[compact_boundary 持久化](cc-17-persistence-and-cache.md) 在本篇 [§4.4](#44-压缩后状态恢复compact-输出之后如何重建可用上下文) 详述。
- **02-entry-and-lifecycle**：`/compact` 命令入口在 `src/commands/compact/compact.ts`，被 REPL 的 slash command 调度。
- **07-context-assembly**：CLAUDE.md / memory 注入由 `processSessionStartHooks` 触发，本篇 [§4.4 CLAUDE.md / memory 重新注入](#claudemd--memory-重新注入) 描述。
- **04-streaming-and-rendering**：streaming 路径在 compact 时的退化在 [§4.3 机制 5](#机制-5prompt-cache-sharingfork-路径stage-5) 详述。
- **12-hook-interception**：PreCompact / PostCompact / SessionStart hook 在 [§3.5 对外接口](#35-对外接口) 与 [收束 模式 7](#模式-7prepost-hooks前后-hook-让外部注入逻辑) 简述。

---

## 附录 B：关键文件清单

| 文件 | LOC | 职责 |
|------|-----|------|
| `src/services/compact/compact.ts` | 1751 | 主流程（autoCompact / partialCompact / summary 调用 / 附件恢复） |
| `src/services/compact/autoCompact.ts` | 380 | threshold 判断 + 失败熔断 + session memory 优先 |
| `src/services/compact/microCompact.ts` | 536 | time-based + cached MC 双路径 |
| `src/services/compact/cachedMicrocompact.ts` | 112 | cache_edits 状态机 |
| `src/services/compact/snipCompact.ts` | 165 | snip 算法 |
| `src/services/compact/snipProjection.ts` | 60 | snip 视图投影 |
| `src/services/compact/reactiveCompact.ts` | 97 | PTL 应急路径 |
| `src/services/compact/sessionMemoryCompact.ts` | 632 | session memory 替代 LLM summary |
| `src/services/compact/timeBasedMCConfig.ts` | 43 | GB 拉取时间阈值 |
| `src/services/compact/grouping.ts` | 63 | API-round 分组 |
| `src/services/compact/prompt.ts` | 374 | NO_TOOLS_PREAMBLE + 9 段 prompt + formatCompactSummary |
| `src/services/compact/postCompactCleanup.ts` | 109 | 主线程 / subagent 区分的状态清理 |
| `src/services/compact/compactWarningHook.ts` | 16 | React hook 订阅 suppress state |
| `src/services/compact/compactWarningState.ts` | 18 | suppress store |
| `src/services/compact/apiMicrocompact.ts` | 150 | 服务端 context_management.edits 配置 |
| `src/utils/messages.ts` | 5079 | `createCompactBoundaryMessage` / `getMessagesAfterCompactBoundary` |
| `src/utils/sessionStorage.ts` | 2130 | `applyPreservedSegmentRelinks` / `applySnipRemovals` |
| `src/utils/toolResultStorage.ts` | 1000+ | `applyToolResultBudget` 实现细节 |
| `src/commands/compact/compact.ts` | 156 | `/compact` 命令入口 |
| `src/commands/force-snip.ts` | 50+ | `/force-snip` 命令 |
| `src/query.ts:540-665` | 125 | 5 阶段压缩在主循环的编排 |

