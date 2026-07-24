---
description: "Agent transcript 用 append-only JSONL 而非数据库，因为 parentUuid DAG 要保住推理链的可审计性。本章拆 fork 分支与死分支在 DAG 上如何表达、100ms 写缓冲为何够用、--resume 恢复时死分支剪枝如何砍掉 80-93% 加载时间，以及 Prompt Cache 与多层 memoize 如何协同省 token。"
---

# 持久化与会话管理

> **本章目标**：理解 Claude Code 如何把 Agent 的对话"记住"——transcript 怎么落盘、消息之间如何组织、恢复时如何重建状态、写缓冲如何平衡 I/O 与延迟、Prompt Cache 如何省 token。
>
> **读完本章你应该能回答**：
> - transcript 为什么用 JSONL 而不是数据库？append-only 的代价是什么？
> - 消息之间如何用 `parentUuid` 形成 DAG？fork 分支、死分支、compact 边界在 DAG 上如何表达？
> - 100ms 写缓冲为什么够用？CCR 模式为什么要缩到 10ms？队列溢出会发生什么？
> - `--continue` / `--resume` / `--fork-session` 恢复时做了什么？死分支剪枝如何把加载时间砍掉 80-93%？
> - Prompt Cache、CLAUDE.md memoize、Skill TF-IDF 这些缓存层如何协同省 token？

## 阅读指南与结构表

本文按"问题 → 定位 → 宏观样貌 → 运行时细节"四级递进组织。前两级建立问题意识与全局坐标；第三级拉远视角，用一张端到端全景图建立心智模型后逐个侧面展开；第四级拉近视角，沿"写入 → 恢复 → 缓存 → 远端"这条数据流的生命周期深入。每个核心机制遵循"为什么需要 → 怎么做 → 具体实例"三段式。文末以设计权衡、边界局限、可复用模式三段收束。

| 章节 | 内容 | 原文对应 | 阅读建议 |
|------|------|---------|---------|
| 一、解决什么问题 | append-only、DAG 拓扑、恢复成本三大约束 | 原一 | 必读，建立问题意识 |
| 二、在整体架构中的位置 | 被动层定位 + 数据存储地图 | 原二 | 必读，建立全局坐标 |
| 三、宏观全景：系统完整样貌 | 端到端全景图 + 五个侧面 | 原三/四/八/九/十/十一 | 必读，建立心智模型 |
| 　3.1 端到端全景链路 | transcript 从产生到恢复的全景图 | 新增 | 必读，先看这张图 |
| 　3.2 核心抽象 | JSONL 格式、Entry 类型、parentUuid DAG | 原三/四 | 必读，后续都依赖 |
| 　3.3 版图分类 | 数据存储地图 + 缓存体系 + 生命周期 | 原九/十 | 必读，看全貌 |
| 　3.4 注册机制 | 写缓冲管线 + 去重 + 溢出契约 | 原五(部分) | 必读，理解数据如何入库 |
| 　3.5 对外接口 | resume/continue/fork + CCR 远端 | 原七(部分)/十一 | 必读，理解对外能力 |
| 四、深入核心运行时细节 | 沿数据流生命周期展开 | 原五/六/七/八 | **核心章节** |
| 　4.1 写入生命周期 | recordTranscript → insertMessageChain → enqueueWrite | 原五/六 | 核心，三段式 |
| 　4.2 恢复生命周期 | loadTranscriptFile → DAG 修复 → leaf 计算 | 原七 | 核心，三段式 |
| 　4.3 缓存协同生命周期 | Prompt Cache + 各层 memoize 协同 | 原八 | 核心，三段式 |
| 　4.4 远端协同生命周期 | CCR v1/v2 hydrate | 原十一 | 选读 |
| 五、设计权衡 | 关键决策的取舍 | 原十二 | 选读 |
| 六、边界与局限 | 当前实现的不足 | 原十三 | 选读 |
| 七、可复用的模式 | 可迁移的设计模式 | 原十四 | 选读 |

**配套阅读标注**：第一次阅读建议按 1→2→3.1→3.2→4.1→4.2 的顺序走完主干（写入与恢复两条生命周期），再回看 3.3-3.5 与 4.3-4.4 补全缓存与远端。仅关心性能优化可直奔 4.3；仅关心 Remote Control 可直奔 3.5 与 4.4。

---

## 一、解决什么问题

Agent 的对话不是一次性的——用户需要恢复会话、跨会话记忆、审计追踪。持久化层决定了：什么被记住、记住多久、以什么代价记住。如果只依赖内存，进程退出意味着所有上下文丢失；如果什么都存，存储成本和隐私风险会失控。

但 Agent 系统的持久化比传统聊天软件更复杂，有三个独特的约束。这三个约束不是凭空设定的，而是由 Agent 的工作方式倒推出来的：

**第一，append-only 而不是可修改。** 数据库里的聊天记录可以 UPDATE，但 Agent transcript 一旦写入就永不修改——只能通过 tombstone 标记删除。原因在于 Agent 的消息链通过 `parentUuid` 串联成一条语义完整的推理链：每条 assistant 消息的"正确性"依赖于它父消息的精确内容。如果允许原地修改某条 user 消息，其后所有 assistant 响应就失去了"基于什么回答"的根基，整条链的可审计性被破坏。所以持久化层必须围绕"追加 + 标记删除"来设计——宁可多写一条修正，也不改一个字节。

**第二，树形拓扑而不是线性链表。** 传统聊天是 A→B→C→D 线性追加，因为每轮对话只有一个上下文。Agent 不一样：fork 会话产生分支、平行工具调用产生兄弟节点、rewind/regenerate 产生死分支——同一时刻可能有多条"平行宇宙"的推理路径并存。线性存储无法表达"这四条 assistant 消息都是对同一个 user 消息的响应"，必须用 `parentUuid` 字段在每条消息上记录父节点，让文件本身成为一个可回溯的有向无环图。

**第三，恢复时的重建成本极高。** 一个跑了一周的 Agent 会话，transcript 可能达到几十 MB 甚至 GB。恢复时需要：解析 JSONL、剪枝死分支、修复 DAG（compact 边界、snip 移除）、重新计算 leaf UUIDs。任何一步的低效都会让用户感觉"恢复太慢"——而恢复发生在用户刚启动、最没耐心的时刻。所以持久化层不能只考虑"写得对"，还要考虑"读得快"。

这三个约束共同决定了：持久化层必须同时处理"高吞吐追加"、"死分支剪枝"、"压缩边界恢复"和"并发写隔离"四类问题。理解了这三个约束，就能理解后续所有设计——为什么用 JSONL、为什么有写缓冲、为什么要字节级剪枝——它们都是对这三个约束的回应。

下一章先看这层在整体架构里的位置，以及它到底管辖哪些数据。

---

## 二、在整体架构中的位置

持久化层位于所有层的下方——Agent Loop 产生数据，持久化层负责保存和恢复。它是纯被动的（被调用），不主动参与 Agent 决策。这个"被动"定位很关键：持久化层不知道也不关心 Agent 正在做什么，它只提供一个 append-only 的事实记录服务。这样 Agent Loop 的逻辑不会被 I/O 细节污染，I/O 逻辑也不必理解 Agent 状态机。

```
┌─────────────────────────────────────────┐
│ Agent Loop / Query Engine               │
├─────────────────────────────────────────┤
│ Tool System / Hook System               │
├─────────────────────────────────────────┤
│ Session Storage (Project singleton)     │ ← 本层
├─────────────────────────────────────────┤
│ Filesystem (JSONL append-only)          │
└─────────────────────────────────────────┘
```

唯一的"主动"职责是 `cleanupRegistry` 中注册的 flush handler——在进程退出时强制刷盘，确保最后 100ms 的缓冲数据不丢失（`src/utils/sessionStorage.ts:448-465`）。之所以需要这个 handler，正是因为持久化层用了异步写缓冲（见 4.1）：如果没有退出时的强制 flush，缓冲区里未落盘的消息会随进程消失。

理解了持久化层的被动定位后，下一步是看它到底管辖哪些数据。下面这张"数据存储地图"把项目里所有持久化和缓存的数据列出来，它既是本章的全局索引，也是后续章节对照查阅的参照表。

### 数据存储地图

| 数据类型 | 存储位置 | 格式 | 生命周期 | 清理策略 | 证据 |
|----------|---------|------|---------|---------|------|
| 会话 transcript | `~/.claude/projects/<hash>/<sessionId>.jsonl` | JSONL | 永久（除非手动删除） | 无自动清理 | `src/utils/sessionStorage.ts:203-206` |
| 子 Agent transcript | `<sessionDir>/subagents/agent-<agentId>.jsonl` | JSONL | 与父会话相同 | 与父会话一起 | `src/utils/sessionStorage.ts:248-259` |
| Agent metadata (sidecar) | `<sessionDir>/subagents/agent-<agentId>.meta.json` | JSON | 与 agent transcript 相同 | 与 agent transcript 一起 | `src/utils/sessionStorage.ts:261-263` |
| Remote agent metadata | `<sessionDir>/remote-agents/remote-agent-<taskId>.meta.json` | JSON | 与 CCR 会话相同 | 手动删除 | `src/utils/sessionStorage.ts:321-330` |
| Session metadata | JSONL 文件末尾 | JSON entry | 随 transcript | 重新追加 | `src/utils/sessionStorage.ts:735-861` |
| Attribution snapshot | JSONL 文件末尾 | JSON entry | 随 transcript | — | `src/utils/sessionStorage.ts:1130-1134` |
| Content replacement | JSONL 文件末尾 | JSON entry | 随 transcript | — | `src/utils/sessionStorage.ts:1136-1149` |
| Marble-origami commit | JSONL 文件末尾 | JSON entry | 随 transcript | 顺序敏感 | `src/utils/sessionStorage.ts:1578-1593` |
| CLAUDE.md cache | 内存（memoize） | — | 会话级 | 进程退出清理 | `src/utils/claudemd.ts` |
| Skill index | 内存（TF-IDF cache） | — | 会话级 | `clearSkillIndexCache()` | `src/services/skillSearch/localSearch.ts:291` |
| MCP tools cache | 内存（memoize + LRU） | — | 会话级 | reconnect 时刷新 | `src/services/mcp/client.ts:1755` |
| Session messages (UUID set) | 内存（bounded Map） | `Set<UUID>` | 进程级（bounded 200） | FIFO eviction | `src/utils/sessionStorage.ts:3951-3980` |

这张地图透露出一个重要事实：持久化层管辖的不只是 transcript 文件，还包括散落在内存各处的缓存。它们共同构成一个"分层记忆系统"——磁盘上的 JSONL 是唯一可信来源，内存缓存是为了避免反复读盘。下一章拉远视角，用一张全景图把这个分层记忆系统的完整样貌画出来。

---

## 三、宏观全景：系统完整样貌

前两章解决了"是什么"和"放哪里"。本章拉远视角，回答"整体长什么样"。我们先给一张端到端全景图建立心智模型，再从核心抽象、版图分类、注册机制、对外接口四个侧面展开。每个侧面只讲宏观结构与设计意图，运行时细节留到第四章沿数据流深入。

### 3.1 端到端全景链路

理解一个持久化系统，最有效的方式是先在脑子里建立"数据从哪里来、经过哪些处理、最终到哪里去"的完整画面。下图把写入路径（下行）、恢复路径（上行）和环绕其外的缓存层一次性画出：

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Agent Loop / Query Engine                       │
│        (产生：user input / assistant response / tool_use / result)    │
└───────────┬───────────────────────────────────────────┬──────────────┘
            │ 写入方向                                    │ 读取方向
            ▼                                            │
   ┌────────────────────────┐         ┌──────────────────▼──────────────┐
   │ recordTranscript()     │         │ --continue / --resume / --fork   │
   │ 去重 + 分区新消息       │         │      loadTranscriptFile()        │
   │ (sessionStorage.ts:1445)│        │ (sessionStorage.ts:3566)         │
   └──────────┬─────────────┘         └──────────────────┬──────────────┘
              ▼                                          │
   ┌────────────────────────┐         ┌──────────────────▼──────────────┐
   │ insertMessageChain()   │         │ Phase1: pre-compact skip         │
   │ 分配 parentUuid/时间戳  │         │ Phase2: walkChainBeforeParse 剪枝│
   │ (sessionStorage.ts:1015)│        │ Phase3-4: parseJSONL              │
   └──────────┬─────────────┘         │ Phase5: DAG 修复(relink/snip)     │
              ▼                       │ Phase6: 计算 leafUuids            │
   ┌────────────────────────┐         └──────────────────┬──────────────┘
   │ enqueueWrite()         │                            │
   │ 上限 1000 + 100ms drain│         ┌──────────────────▼──────────────┐
   │ (sessionStorage.ts:613)│         │ buildConversationChain()         │
   └──────────┬─────────────┘         │ recoverOrphanedParallelToolResults│
              │ drain                  │ checkResumeConsistency()         │
              ▼                        │ adoptResumedSessionFile()        │
   ┌────────────────────────┐◄────────┤                                  │
   │ ~/.claude/projects/    │         └──────────────────────────────────┘
   │ <hash>/<sessionId>.jsonl│
   │ (append-only, 0o600)   │
   └──────────┬─────────────┘
              │ persistToRemote (CCR)
              ▼
   ┌────────────────────────┐
   │ CCR v1: HTTP ingress   │
   │ CCR v2: internal events│
   │ hydrateRemoteSession() │
   └────────────────────────┘

   ┌──────── 缓存层（环绕写入与恢复全过程）────────────────────────┐
   │ API Prompt Cache (5min TTL)    CLAUDE.md memoize              │
   │ Git status memoize             Skill TF-IDF index             │
   │ MCP tools list (LRU)           Microcompact cache             │
   │ sessionMessagesCache (bounded 200, 去重用)                     │
   └────────────────────────────────────────────────────────────────┘
```

读这张图有三个要点：**写入是异步分层的**——消息要穿过 `recordTranscript` → `insertMessageChain` → `enqueueWrite` → 100ms 后才真正落盘，中间任何一层都在为下一层减负；**恢复是分阶段流水线**——六个 Phase 顺序执行，前两个 Phase（pre-compact skip、字节级剪枝）在 `JSON.parse` 之前就把大部分无用字节剔除，这是大文件恢复快的根本原因；**缓存环绕全程**——写入时去重靠 `sessionMessagesCache`，恢复时省 token 靠 API Prompt Cache，二者处于不同层级但目标一致：避免重复工作。

带着这张全景图，下面逐个侧面展开。

### 3.2 核心抽象

全景图里有三个反复出现的概念：JSONL 文件、Entry、parentUuid。它们是持久化层的核心抽象，后续所有机制都建立在其上。

#### 3.2.1 JSONL：为什么不是数据库

JSONL（JSON Lines）是本项目持久化的基石——每一行是一个独立 JSON 对象，文件整体是 append-only 的。这个选择不是偶然的，而是在"可读性 / 流式处理 / 零依赖 / 调试友好"四者间权衡的结果。SQLite 之类结构化 DB 能提供索引和事务，但 Agent transcript 的访问模式很特殊：几乎全是顺序追加、偶尔顺序读取、极少随机查询——这种模式用 DB 的索引能力是浪费，反而背上了依赖管理和版本兼容的包袱。JSONL 则天然匹配：`grep` 能直接搜、`head`/`tail` 能直接看、跨平台无依赖、崩溃后损坏的最多是最后一行（而非整个 DB）。

但 JSONL 只规定了"每行一个 JSON"，具体到 Agent transcript，每行 JSON 的 schema 是怎样的、哪些字段必填、序列化有什么不变式——这些都需要在代码里定义。下面先列出所有 entry 类型，再详解核心消息字段，最后说明序列化保证。

**Entry 类型全表**（按写入频率排序）：

| `type` 字段 | 用途 | 必填字段 | 可选字段 | 写入位置 |
|------------|------|---------|---------|---------|
| `user` | 用户消息 | `message.content`, `uuid` | `isMeta`, `sourceToolAssistantUUID`, `isCompactSummary` | 每次用户输入 |
| `assistant` | Agent 响应 | `message.content`, `message.id`, `uuid` | `message.usage` | 每次 LLM 响应 |
| `system` | 系统消息 | `subtype`, `uuid` | `compactMetadata.preservedSegment`, `snipMetadata.removedUuids` | compact / snip / turn_duration |
| `attachment` | IDE 附件 | `uuid`, `attachment` | — | IDE 上下文注入 |
| `progress` | 工具进度（已废弃，新版不写） | `uuid`, `data.type` | — | 旧版本遗留 |
| `summary` | compact 摘要 | `leafUuid`, `summary` | — | compact 完成时 |
| `custom-title` | 用户重命名 | `customTitle`, `sessionId` | — | `/rename` 命令 |
| `ai-title` | AI 生成标题 | `aiTitle`, `sessionId` | — | 后台自动命名 |
| `tag` | 用户标签 | `tag`, `sessionId` | — | `/tag` 命令 |
| `agent-name` | Agent 显示名 | `agentName`, `sessionId` | — | sub-agent 启动 |
| `agent-color` | Agent 颜色 | `agentColor`, `sessionId` | — | sub-agent 启动 |
| `agent-setting` | Agent 配置 | `agentSetting`, `sessionId` | — | 启动时 |
| `mode` | 协作模式 | `mode`, `sessionId` | — | 切换模式 |
| `worktree-state` | Worktree 状态 | `worktreeSession`, `sessionId` | — | enter/exit worktree |
| `goal` | 目标状态 | `state`, `sessionId`, `timestamp` | — | goal 变更 |
| `goal-cleared` | 目标清除标记 | `sessionId`, `timestamp` | — | `/clear-goal` |
| `pr-link` | PR 关联 | `prNumber`, `prUrl`, `prRepository`, `sessionId` | — | `gh pr create` |
| `last-prompt` | 最近用户输入 | `lastPrompt`, `sessionId` | — | 每轮结束 |
| `task-summary` | Task 摘要 | `summary`, `sessionId`, `timestamp` | — | 后台更新 |
| `file-history-snapshot` | 文件历史 | `messageId`, `snapshot`, `isSnapshotUpdate` | — | 文件编辑后 |
| `attribution-snapshot` | 归因快照 | `messageId`, `snapshot` | — | 归因计算时 |
| `content-replacement` | 内容替换 | `sessionId` 或 `agentId`, `replacements` | — | token 预算替换 |
| `marble-origami-commit` | 上下文折叠 commit | `collapseId`, `summaryUuid`, `firstArchivedUuid`, `lastArchivedUuid` | — | ctx-collapse |
| `marble-origami-snapshot` | 折叠快照 | `staged`, `armed`, `lastSpawnTokens` | — | ctx-agent spawn |
| `queue-operation` | 队列操作 | `sessionId`, `operation` | — | queue 模式 |
| `speculation-accept` | 投机接受 | `sessionId`, `toolUseId` | — | speculation mode |

这张表透露了一个设计取舍：transcript 文件不只存对话消息，还存了大量"会话级元数据"（title、tag、mode、goal、pr-link……）。把它们和消息混在同一个 append-only 文件里，而非另立元数据 DB，是因为这些元数据天然随会话生灭、且需要和消息一起恢复。代价是同一类元数据在文件中可能有多条（每次更新都追加一条新的），恢复时取最后一条——这是 append-only 模型的典型代价，3.4 节会看到 `reAppendSessionMetadata` 如何把元数据始终保持在文件尾部的 64KB 窗口内来缓解。

**核心消息字段详解**：

User 消息（`type: 'user'`）：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Hello"  // 字符串或 content block 数组
  },
  "uuid": "a1b2c3d4-1234-5678-9abc-def012345678",
  "parentUuid": "parent-uuid-or-null",
  "sessionId": "session-id",
  "timestamp": "2026-07-04T12:34:56.789Z",
  "version": "2.2.1",
  "cwd": "/path/to/project",
  "gitBranch": "main",
  "isMeta": false,                    // 系统注入的隐式消息
  "sourceToolAssistantUUID": "...",   // tool_result 关联的 assistant UUID
  "isCompactSummary": false           // compact 注入的摘要
}
```

Assistant 消息（`type: 'assistant'`）：

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "id": "msg_01ABC...",           // API 消息 ID
    "content": [
      {"type": "text", "text": "I'll help"},
      {"type": "tool_use", "id": "toolu_...", "name": "Read", "input": {...}}
    ],
    "model": "claude-sonnet-4-20250514",
    "usage": {
      "input_tokens": 1234,
      "output_tokens": 56,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 100
    },
    "stop_reason": "end_turn"
  },
  "uuid": "...",
  "parentUuid": "...",
  "isSidechain": false,
  "agentId": "...",                 // sub-agent 标识
  "agentName": "Explore"            // sub-agent 类型名
}
```

System 消息（`type: 'system'`）：

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "uuid": "...",
  "parentUuid": "last-pre-compact-uuid",  // 边界前的最后一条
  "logicalParentUuid": "first-post-compact-uuid",  // 边界后的第一条
  "compactMetadata": {
    "trigger": "auto",              // auto / manual
    "preCompactTokenCount": 180000,
    "preservedSegment": {           // 可选：保留的段落
      "anchorUuid": "...",
      "headUuid": "...",
      "tailUuid": "...",
      "tokenCount": 4500
    }
  }
}
```

**序列化保证**。理解了 entry schema 后，还必须理解"如何保证写入的文件能被正确解析"——下面是几条关键的序列化不变式，它们不是风格约定，而是被恢复路径的优化算法直接依赖的硬契约：

1. **键顺序**：所有 transcript message 在 `recordTranscript` 中通过对象字面量创建，保证 `parentUuid` 是第一个键。这一不变式被 `walkChainBeforeParse` 利用——通过字节级前缀匹配 `{"parentUuid":` 来识别消息行（`src/utils/sessionStorage.ts:3404`）。如果键顺序被打乱，字节级剪枝算法会直接失效，大文件恢复回到全量解析。
2. **UTF-8 边界安全**：单条 JSONL 行最长可达数 MB（tool output），但 `\n`（`0x0a`）不会出现在 UTF-8 多字节序列中，因此按字节扫描换行符是安全的。这条性质让"按行切分"可以在字节层完成，无需先解码 UTF-8。
3. **UUID 格式**：纯 ASCII（36 字符），允许字节级 `latin1` 解码而无需 UTF-8 处理。剪枝算法在比对 UUID 时走的是 `latin1` 快路径。
4. **时间戳格式**：ISO 8601（`new Date().toISOString()`），按字典序排序等价于按时间排序。这让"按 timestamp 排序兄弟节点"无需 Date 解析，字符串比较即可。

#### 3.2.2 parentUuid：为什么是 DAG 而不是链表

知道了 JSONL 文件的格式后，下一个关键问题是：消息之间怎么组织？答案是用 `parentUuid` 字段构成有向无环图（DAG）。每条 transcript 消息通过 `parentUuid` 指向其父节点，根消息 `parentUuid: null`。这构成了 DAG 而非线性链表：

```
root(user) ──► asst ──► user ──► asst ──► user (leaf)
                            │
                            └──► asst (fork branch, 死分支)
```

为什么必须用 DAG？因为 Agent 会产生三种线性链表无法表达的结构：

1. **平行工具调用**：流式响应中，`content_block_stop` 事件为每个 content block 发射一个独立 `AssistantMessage`，它们共享 `message.id` 但 `uuid` 不同。一次 assistant 响应可能含多个 tool_use，每个 tool_use 对应一个 tool_result，这些 tool_result 都是"同一个 assistant 的子节点"——线性链表把它们拍平成一串，就丢了"这些结果是对同一次响应的回复"这层关系。`insertMessageChain` 通过 `sourceToolAssistantUUID` 字段将 `tool_result` 的 `parentUuid` 指向具体的 assistant UUID（`src/utils/sessionStorage.ts:1052-1059`），从而保留这层关系。
2. **显式 fork**：`--fork-session` 创建新会话但复制源会话的 chain，导致同 UUID 在两个文件中存在。这是用户主动从某分叉点开辟新对话。
3. **隐式 fork**：rewind（Ctrl+Z）/regenerate 后旧消息成为死分支。用户撤回一次回答重新生成，旧回答留在文件里但不再属于当前链。

由于 JSONL 是 append-only 的，dead fork 永远留在文件中——不能删，因为删了就破坏了"append-only"这一章开头强调的语义完整性约束。那么死分支怎么处理？答案是加载时剪枝，这部分细节留到 4.2 节，这里只指出剪枝发生在两个点：预解析字节级扫描（`walkChainBeforeParse`, `src/utils/sessionStorage.ts:3400-3560`）和解析后 DAG 恢复（`recoverOrphanedParallelToolResults`, `src/utils/sessionStorage.ts:2155-2245`）。

#### 3.2.3 compact 边界与 snip：DAG 上的特殊节点

除了普通 user/assistant 消息，DAG 上还有两类特殊节点用于上下文压缩：

**Compact 边界**。当对话过长触发 compact（上下文压缩），系统会在 DAG 上插入一条 `compact_boundary` 系统消息，标记"此前的内容已被摘要替代"：

```
JSONL 物理顺序:
[user][asst][user][asst][COMPACT_BOUNDARY][summary][user][asst]

parentUuid 链:
COMPACT_BOUNDARY.parentUuid = last-pre-compact-uuid
COMPACT_BOUNDARY.logicalParentUuid = first-post-compact-uuid
summary.parentUuid = COMPACT_BOUNDARY.uuid (or null, if 第一条)
```

注意它有两条 parent 链：`parentUuid` 指向压缩前的最后一条（物理连续），`logicalParentUuid` 指向压缩后的第一条（逻辑跳跃）。这种"双指针"设计让恢复时既能按物理顺序跳过已压缩内容，又能按逻辑顺序重建有效对话链。加载时 `applyPreservedSegmentRelinks`（`src/utils/sessionStorage.ts:1876-1993`）处理 preserved segment 的重链接，细节见 4.2。

**Snip**。Snip（feature flag `HISTORY_SNIP`）从对话中间移除一段。不同于 compact 的"前缀截断"，snip 移除的是中段——比如一段失败的工具调用链。`applySnipRemovals`（`src/utils/sessionStorage.ts:2019-2076`）负责把幸存节点的 `parentUuid` 重新指向删除区外的祖先，细节同样见 4.2。

这两个机制都建立在 DAG 模型之上：正因为消息靠 `parentUuid` 串联，才能通过"改写指针"而非"移动数据"来完成压缩和裁剪。下一节看看这些数据在版图上如何分类。

### 3.3 版图分类

前一节讲了核心抽象，本节换个角度——按"存多久、谁来清"给持久化和缓存数据分类。理解版图分类有两个用途：一是知道哪些数据会随进程消失（恢复时需重建），二是知道哪些缓存失效会触发连锁反应。下面把数据存储地图（已在二章给出）与缓存体系、生命周期合并成一张完整版图。

**缓存体系汇总**。项目里所有缓存层如下表，按 TTL 从短到长排列：

| 缓存层 | 缓存什么 | TTL | 失效策略 | 证据 |
|--------|---------|-----|---------|------|
| Transcript write queue | 待写入消息 | 100ms batch | drain 后清空 | `src/utils/sessionStorage.ts:613` |
| Prompt Cache (API) | System Prompt 前缀 | 5 分钟 | 内容变更自动失效 | `src/services/api/claude.ts:328` |
| Git status (memoize) | git 状态字符串 | 会话级 | `getUserContext.cache.clear()` | `src/context.ts:36` |
| CLAUDE.md (memoize) | 文件内容 | 会话级 | `resetGetMemoryFilesCache()` | `src/utils/claudemd.ts` |
| Skill TF-IDF index | 索引向量 | 会话级 | `clearSkillIndexCache()` | `src/services/skillSearch/localSearch.ts:291` |
| MCP tools list | tools/list 结果 | 会话级 + LRU | reconnect / tools/list_changed | `src/services/mcp/client.ts:1755` |
| Microcompact cache | 压缩结果 | 会话级 | 对话内容变更 | `src/services/compact/cachedMicrocompact.ts` |
| Session messages UUID set | 已记录 UUIDs | 进程级（bounded 200） | FIFO eviction + `clearSessionMessagesCache()` | `src/utils/sessionStorage.ts:3951` |
| getProjectDir (memoize) | project dir 路径 | 永久 | 无（homedir/env 不变） | `src/utils/sessionStorage.ts:437-439` |
| isDebugMode (memoize) | debug 模式标志 | 进程级 | `isDebugMode.cache.clear()` | `src/utils/debug.ts:44-57` |

读这张表的关键是区分三层 TTL 的含义：**100ms 级**的 write queue 是 I/O 合并用的，失效即落盘；**5 分钟级**的 API Prompt Cache 是省 token 用的，超时或前缀变更即失效；**会话/进程级**的 memoize 是省重复计算的，进程退出即失效。其中 `sessionMessagesCache` 比较特殊——它是进程级缓存，目的是让"这条消息是否已记录"的去重判断不必每次读盘，但 compact 后旧 UUID 失效，必须手动 `clearSessionMessagesCache()`（`src/utils/sessionStorage.ts:3991-3993`），否则去重会错判。这条手动清理链是缓存与持久化耦合最紧的地方，4.1 节会展开。

**数据生命周期**。换个纵切面——一条 transcript 从创建到销毁经历哪些阶段：

```
CREATE
  │  首次 user/assistant 消息 → materializeSessionFile()
  │  ├─ ensureCurrentSessionFile() → getTranscriptPath()
  │  ├─ reAppendSessionMetadata() → 写入 mode/agent-setting
  │  └─ flush pendingEntries → 全部持久化
  ▼
ACTIVE
  │  recordTranscript() 每轮追加消息
  │  ├─ 去重（messageSet 检查）
  │  ├─ insertMessageChain → 分配 parentUuid, timestamp, sessionId
  │  └─ enqueueWrite → 100ms batch flush
  │
  │  reAppendSessionMetadata() 定期刷新元数据到 EOF
  │  ├─ customTitle, tag, agentName, ...
  │  └─ 目的：保持元数据在 64KB tail window 内
  ▼
IDLE
  │  会话暂停（用户离开或切换到其他会话）
  │  文件保持打开状态（但 OS 层 fd 可能被回收）
  ▼
RESUME / CONTINUE
  │  switchSession() → 切换 sessionId
  │  loadTranscriptFile() → 重建消息链
  │  ├─ 大文件 pre-compact skip
  │  ├─ walkChainBeforeParse → 死分支剪枝
  │  ├─ parseJSONL → Entry[]
  │  ├─ applyPreservedSegmentRelinks → DAG 修复
  │  ├─ applySnipRemovals → snip 修复
  │  └─ 计算 leafUuids → resume anchor
  │
  │  restoreSessionMetadata() → 从 maps 填充 in-memory cache
  │  adoptResumedSessionFile() → 设置 sessionFile + reAppend
  │  reAppendSessionMetadata(true) → skipTitleRefresh（避免覆盖 --name）
  ▼
ARCHIVE
  │  手动或自动归档（目前无自动归档机制）
  │  文件保留在 projects 目录
  ▼
EXPIRE
  └─ 无自动过期——文件永久保留（除非 `cleanupPeriodDays=0`）
```

| 阶段 | 触发条件 | 数据操作 | 可逆性 |
|------|---------|---------|--------|
| CREATE | 首次用户消息 | 创建 JSONL 文件 + 元数据 | 可逆（删除文件） |
| ACTIVE | 每轮 recordTranscript | 追加 JSONL 行 | 可逆（removeMessageByUuid tombstone） |
| IDLE | 用户暂停 | 无操作 | — |
| RESUME | --continue / --resume | loadTranscriptFile + adopt | 部分可逆 |
| ARCHIVE | 手动操作 | 无（文件原地保留） | 可逆（重新加载） |
| EXPIRE | 无自动机制（`cleanupPeriodDays=0` 可禁用） | — | — |

这里有一个值得注意的设计取舍：**为什么没有自动过期？** 因为会话文件是用户的"工作记录"——一次调试可能跨好几天，自动删除会丢失重要上下文。代价是磁盘占用持续增长，长期使用需要用户手动清理。`cleanupPeriodDays=0` 提供了关闭清理的开关，但默认仍保留。

### 3.4 注册机制

前两节讲了"存什么"和"存哪类"，本节讲"数据如何被登记入库"——也就是写入管线的宏观结构。运行时细节留到 4.1，这里只看三层缓冲的分工和去重、溢出两条契约。

**三层缓冲架构**。从消息产生到落盘，要穿过三个阶段，每层职责不同：

```
recordTranscript(messages)
       │
       ▼
Project.insertMessageChain()
       │
       ▼
Project.appendEntry(entry)  ─── 清理 + 去重（messageSet）
       │
       ▼
Project.enqueueWrite(filePath, entry)  ─── 内存队列
       │
       ▼
scheduleDrain()  ─── setTimeout 100ms
       │
       ▼
drainWriteQueue()  ─── 批量 appendFile
       │
       ▼
appendToFile(filePath, content)  ─── 实际 I/O
```

这三层各有存在的理由：`recordTranscript` 负责去重与分区（哪些是新消息、哪些是已记录前缀），避免重复写入；`insertMessageChain` 负责给每条消息盖上会话级 stamp（parentUuid、timestamp、sessionId 等），把内存消息变成可持久化的 transcript message；`enqueueWrite` + 100ms drain 负责合并 I/O，把几十次小写合并成一次大写。三层缺一不可——去掉第一层会重复写，去掉第二层会丢 stamp，去掉第三层会让磁盘被几十次小写阻塞。

**关键设计选择**：

| 设计 | 数值/策略 | 原因 |
|------|----------|------|
| Flush 间隔 | 100ms（CCR 模式 10ms） | 平衡 I/O 频率与延迟 |
| 队列上限 | 1000 条/filePath | 防止内存无限增长 |
| 超限策略 | FIFO drop oldest | 保护最新数据，牺牲最旧 |
| 批量大小 | `MAX_CHUNK_BYTES = 100 MB` | 避免单次 syscall 过大 |
| 文件模式 | `0o600`（owner-only） | 安全：transcript 可能含敏感信息 |
| 目录模式 | `0o700` | 防止其他用户读取 project dir |

这里的常量都有明确意图：**100ms** 是"用户感知不到延迟"与"I/O 不过频"的折中点——人眼对 100ms 以下的延迟基本无感，而 100ms 内的多次写入合并能让磁盘 I/O 次数降一个数量级；**1000 条上限**是防内存爆炸的兜底——daemon/swarm 模式下高频写入若不限流会吃光内存；**`0o600`/`0o700`** 是隐私底线——transcript 含用户对话和可能的代码内容，必须阻止其他用户读取。

**去重机制**。去重靠 `sessionMessagesCache`——一个进程级 bounded Map（上限 200，FIFO eviction），缓存每个 sessionId 已记录的 UUID 集合。`recordTranscript` 写入前先查这个集合，已记录的消息不重复写。这个缓存的存在是为了避免每次 `recordTranscript` 都读盘——一次工具调用可能触发多次 `recordTranscript`，每次都读 JSONL 文件会非常慢。代价是 compact 后必须手动 `clearSessionMessagesCache()`，否则旧 UUID 还在缓存里，去重会错判（详见 4.1）。

**写队列溢出的数据丢失契约**。这是注册机制里最需要警惕的部分：`enqueueWrite`（`sessionStorage.ts:613-630`）在队列 length ≥ 1000 时**立即**调用 `d.resolve()` 让被丢弃条目的调用方 Promise 误以为写入已成功：

```typescript
// src/utils/sessionStorage.ts:613-630
private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise<void>(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) { queue = []; this.writeQueues.set(filePath, queue) }
    if (queue.length >= 1000) {
      const dropped = queue.splice(0, queue.length - 999)
      for (const d of dropped) { d.resolve() }   // ← silently resolve，不写不报错
    }
    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}
```

这个"静默 resolve"是一个有意的 fail-open 设计，背后的契约是：

1. **静默丢弃**——被丢弃 entry 的调用方 Promise resolve 而非 reject，无 log/error/telemetry。`recordTranscript`（`sessionStorage.ts:1445`）调用者不会察觉丢失；该调用是 fire-and-forget 模式。
2. **不通知用户**——无 warning，无 `logForDebugging`，无 `logEvent`。Drop 是 fail-open 默认。为什么 fail-open 而非报错？因为 transcript 写入不是 Agent 决策的阻塞路径——报错只会打断用户当前操作，而丢一条消息往往能从后续上下文恢复。
3. **谁会溢出**——单轮多 tool_use 平行 + 后台 agent（`ASYNC_AGENT_ALLOWED_TOOLS`）并行时高频调用 `recordTranscript` → `insertMessageChain` → `enqueueWrite`。CCR v2 模式下 flush interval 缩到 10ms（`sessionStorage.ts:1397`）缓解，但 daemon + swarm 场景仍有风险。
4. **持久化而非丢盘**——条目一旦入队成功（未被 drop）保证落盘：`flush()`（`sessionStorage.ts:863-883`）会先 cancel pending timer、await in-flight drain、再强制 drain 剩余队列，是 `process.exit` 的清理路径。
5. **`flushSessionStorage()`** 导出函数（`sessionStorage.ts:1620-1622`）提供给外部调用方（如 `gracefulShutdownSync` 与 CCR v2），等价于 `project.flush()`。

最坏情况：1000 条单 filePath 中最旧的 1 条会被静默丢弃，**通常意味着 1 条 transcript JSONL 行不会写入磁盘**——transcript 加载时不会找到该 UUID，`recordTranscript` 后续调用会因 `messageSet.has(uuid)` 视为已记录而不再尝试重写，造成永久丢失。这是当前实现一个已知的边界，6 节会再提。

**Crash 行为**：

- **100ms 内 crash**：最多丢失 100ms 的缓冲数据（在 `FLUSH_INTERVAL_MS` 到期前）
- **`process.exit()`**：cleanup handler 触发 `flush()`，先 cancel pending timer 再 drain
- **`gracefulShutdownSync(1, ...)`**：当远端 ingest 失败时调用，确保本地也先 flush

### 3.5 对外接口

前三节讲了内部结构，本节看持久化层对外暴露的能力。对外接口分两类：本地恢复（resume/continue/fork）和远端协同（CCR）。运行时细节留到 4.2 与 4.4，这里只看能力边界与触发条件。

**Resume 三种模式**：

| 模式 | 行为 | 入口 |
|------|------|------|
| `--continue` (-c) | 恢复最近会话（同 cwd） | `main.tsx` 解析 |
| `--resume <id>` (-r) | 恢复指定 sessionId | `main.tsx` 解析 |
| `--fork-session` | 复制链到新 sessionId（保留历史） | `main.tsx` 解析 |

这三种模式共享同一套恢复管线（`loadTranscriptFile`），区别只在恢复前的"选哪个文件"和恢复后的"是否换 sessionId"。`--continue` 是最常用的——用户重新打开同目录，自动接上次；`--resume` 用于在多个会话间切换；`--fork-session` 用于"从某个历史分叉点重新开始，但保留原会话"——典型场景是"上次走偏了，回到那个点重试，但不破坏原记录"。

**Fork 行为**：

```
源 session: <sourceId>.jsonl
fork: 复制 chain[0..N] 到 <newId>.jsonl
       - parentUuid 保留（指向原 chain）
       - sessionId 重写为 newId
       - 移除 isSidechain / sourceToolAssistantUUID
       - 写入 content-replacement entries（key by newId）
```

**CCR 远端持久化**。本地持久化适合单设备使用，但 Remote Control 模式下用户的 Claude Code 可能运行在一台机器上，需要把 transcript 同步到云端，方便另一台设备继续。CCR（Claude Code Remote）有两代协议：

- **v1 Session Ingress**：通过 HTTP 把每条 entry POST 到远端 ingress（`persistToRemote`, `src/utils/sessionStorage.ts:1339-1380`）。关键设计是"远端失败触发进程退出"——宁可让会话挂掉，也不容忍本地与远端数据不一致。
- **v2 Internal Events**：用 internal event writer/reader 替代 HTTP ingress（`src/utils/sessionStorage.ts:502-521`），通过 `hydrateFromCCRv2InternalEvents` 从 CCR 重建本地 JSONL。v2 的改进是支持子 Agent 事件的独立读写。

两代协议都依赖 `hydrateRemoteSession`（`src/utils/sessionStorage.ts:1624-1659`）把远端日志重放成本地 JSONL 文件，之后走标准恢复管线。这部分细节见 4.4。

至此宏观样貌已经完整：核心抽象（JSONL + DAG）、版图分类（缓存体系 + 生命周期）、注册机制（三层缓冲 + 去重 + 溢出）、对外接口（resume + CCR）。下一章拉近视角，沿写入与恢复两条数据流深入运行时细节。

## 四、深入核心运行时细节

第三章建立了宏观心智模型，本章拉近视角，沿"写入 → 恢复 → 缓存 → 远端"这条数据流的生命周期深入。每个机制遵循"为什么需要 → 怎么做 → 具体实例"三段式：先讲这个机制要解决什么问题，再讲代码层面如何实现，最后用一个具体场景串起来。四节按数据流顺序排列，前一节的输出是后一节的输入。

### 4.1 写入生命周期

写入生命周期回答"一条消息从产生到落盘经历了什么"。它由三个机制串联：`recordTranscript`（去重与分区）、`insertMessageChain`（盖 stamp）、`enqueueWrite` + drain（合并 I/O）。下面逐个讲。

#### 4.1.1 recordTranscript：去重与分区

**为什么需要**。Agent Loop 每轮可能调用多次 `recordTranscript`（一次工具调用链就有多次），而传入的 `messages` 数组往往包含"已经记录过的前缀 + 本轮新消息"。如果不去重直接写，会重复落盘大量已存在消息——既浪费 I/O，又破坏 `parentUuid` 链的单一性（同一 UUID 出现两次让恢复时的 DAG 重建混乱）。所以需要一个入口函数先做去重与分区：把已记录消息识别为前缀、只把新消息往下传。

**怎么做**。`recordTranscript`（`src/utils/sessionStorage.ts:1445-1486`）分五步：清理非 transcript 消息 → 取已记录 UUID 集合 → 分区新/旧消息 → 写入新消息链 → 返回最后记录的 chain participant UUID。

```typescript
// src/utils/sessionStorage.ts:1445-1486
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  // 1. 清理消息（去除 progress 等非 transcript 消息）
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const sessionId = getSessionId() as UUID

  // 2. 获取已记录消息 UUID 集合（用于去重）
  const messageSet = await getSessionMessages(sessionId)

  // 3. 分区：哪些是新的，哪些是已记录的前缀
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      // 已记录的消息：仅当其为前缀时才更新 startingParentUuid
      // （compaction 时 messagesToKeep 出现在新 CB 之后 → 不视为前缀）
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }

  // 4. 写入新消息链
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages, false, undefined, startingParentUuid, teamInfo,
    )
  }

  // 5. 返回最后一个被实际记录的 chain participant UUID
  //    （若全是已记录的，返回前缀追踪的 UUID，保持 chain 正确性）
  const lastRecorded = newMessages.findLast(isChainParticipant)
  return (lastRecorded?.uuid as UUID | undefined) ?? startingParentUuid ?? null
}
```

分区逻辑里有个易错的点：`startingParentUuid` 只在"还未遇到新消息时"被已记录消息推进。这是因为 compact 后 `messagesToKeep` 会出现在新 compact_boundary 之后——它们虽已记录，但不是当前链的前缀，不能当作 `startingParentUuid`。`seenNewMessage` 标志位就是用来区分这两种情况的。

**具体实例**。假设用户第二轮对话，`messages` 数组含 `[user₁, asst₁, user₂, asst₂]`，其中 `user₁, asst₁` 上一轮已记录。`getSessionMessages` 返回 `{user₁, asst₁}`。分区后 `newMessages = [user₂, asst₂]`，`startingParentUuid = asst₁`（前缀最后一条）。`insertMessageChain` 拿到 `newMessages` 后从 `asst₁` 开始串接，保证 `user₂.parentUuid = asst₁`，链不断裂。返回 `asst₂.uuid` 给调用方作为下次写入的 hint。

#### 4.1.2 insertMessageChain：盖会话级 stamp

**为什么需要**。`recordTranscript` 把新消息分区出来后，这些消息还只是"内存里的 Message 对象"，缺少持久化所需的会话级上下文（parentUuid、timestamp、sessionId、cwd、gitBranch、version 等）。`insertMessageChain` 的职责就是给每条消息盖上这些 stamp，把它从内存对象变成 transcript message，并维护 `parentUuid` 链的推进。同时它还负责首次写入时"物化"会话文件——会话文件不是启动时就创建的，而是第一条 user/assistant 消息到来时才落盘，避免空会话文件污染目录。

**怎么做**。`insertMessageChain`（`src/utils/sessionStorage.ts:1015-1106`）在 `trackWrite` 保护下逐条处理消息：

```typescript
// src/utils/sessionStorage.ts:1015-1106
async insertMessageChain(messages, isSidechain, agentId, startingParentUuid, teamInfo) {
  return this.trackWrite(async () => {
    let parentUuid = startingParentUuid ?? null

    // 首次 user/assistant 消息 → materialize session file
    if (this.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')) {
      await this.materializeSessionFile()
    }

    let gitBranch: string | undefined
    try { gitBranch = await getBranch() } catch {}
    const sessionId = getSessionId()
    const slug = getPlanSlugCache().get(sessionId)

    for (const message of messages) {
      const isCompactBoundary = isCompactBoundaryMessage(message)

      // tool_result 关联到具体的 assistant（而非链尾）
      let effectiveParentUuid = parentUuid
      if (message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID) {
        effectiveParentUuid = message.sourceToolAssistantUUID as UUID
      }

      const transcriptMessage = {
        parentUuid: isCompactBoundary ? null : effectiveParentUuid,
        logicalParentUuid: isCompactBoundary ? parentUuid : undefined,
        isSidechain,
        teamName: teamInfo?.teamName,
        agentName: teamInfo?.agentName,
        promptId: message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
        agentId,
        ...message,  // 展开原始 message 字段
        // 会话级 stamp 必须放在 spread 之后（防止 --fork-session 时被源 sessionId 覆盖）
        userType: getUserType(),
        entrypoint: getEntrypoint(),
        cwd: getCwd(),
        sessionId,
        timestamp: new Date().toISOString(),
        version: VERSION,
        gitBranch,
        slug,
      }

      await this.appendEntry(transcriptMessage)
      if (isChainParticipant(message)) {
        parentUuid = message.uuid  // 推进 parent 指针
      }
    }

    // 缓存 lastPrompt 用于 --resume picker 显示
    if (!isSidechain) {
      const text = getFirstMeaningfulUserMessageTextContent(messages)
      if (text) {
        const flat = text.replace(/\n/g, ' ').trim()
        this.currentSessionLastPrompt =
          flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
      }
    }
  })
}
```

代码里有几个关键设计：**`parentUuid` 必须放在对象字面量第一个键**——这是 3.2.1 讲的序列化不变式，被字节级剪枝算法依赖；**会话级 stamp 放在 `...message` 展开之后**——这样能覆盖 message 自带的可能过期的 sessionId（`--fork-session` 时源消息带旧 sessionId，必须被新 sessionId 覆盖）；**`isChainParticipant` 才推进 `parentUuid`**——compact_boundary、summary 等非链参与者不推进，避免链被它们污染；**`effectiveParentUuid` 处理平行 tool_result**——tool_result 的 parent 不是链尾，而是产生它的具体 assistant（3.2.2 讲的 `sourceToolAssistantUUID`）。

**具体实例**。接上例，`insertMessageChain` 收到 `[user₂, asst₂]`、`startingParentUuid = asst₁`。处理 `user₂`：`parentUuid = asst₁`，盖 stamp 后 `appendEntry`，推进 `parentUuid = user₂`。处理 `asst₂`：`parentUuid = user₂`，盖 stamp 后 `appendEntry`，推进 `parentUuid = asst₂`。最终文件追加两行，`user₂.parentUuid = asst₁`、`asst₂.parentUuid = user₂`，链完整。

#### 4.1.3 enqueueWrite 与 drain：合并 I/O

**为什么需要**。`appendEntry` 调用 `enqueueWrite` 把 entry 入队，而非直接写盘。如果每条消息都同步 `appendFile`，一次工具调用链（可能几十条消息）会产生几十次小 I/O，磁盘 syscall 开销会让 Agent 循环停顿几十毫秒。引入写缓冲后，100ms 内的多次入队被合并成一次批量 `appendFile`，I/O 次数降一个数量级，且写入对 Agent 循环是非阻塞的。

**怎么做**。核心是 `enqueueWrite` + `scheduleDrain`（`src/utils/sessionStorage.ts:613-700`）：

```typescript
private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
  return new Promise<void>(resolve => {
    let queue = this.writeQueues.get(filePath)
    if (!queue) {
      queue = []
      this.writeQueues.set(filePath, queue)
    }
    // 1000 条上限：超出时 drop oldest（FIFO eviction）
    if (queue.length >= 1000) {
      const dropped = queue.splice(0, queue.length - 999)
      for (const d of dropped) {
        d.resolve()  // 通知调用方（不等待实际写入）
      }
    }
    queue.push({ entry, resolve })
    this.scheduleDrain()
  })
}

private scheduleDrain(): void {
  if (this.flushTimer) return  // 已有 pending timer
  this.flushTimer = setTimeout(async () => {
    this.flushTimer = null
    this.activeDrain = this.drainWriteQueue()
    await this.activeDrain
    this.activeDrain = null
    // drain 期间又有新条目 → 再次调度
    if (this.writeQueues.size > 0) {
      this.scheduleDrain()
    }
  }, this.FLUSH_INTERVAL_MS)  // 100ms
}
```

`scheduleDrain` 用"已有 pending timer 就跳过"的守卫保证 100ms 窗口内只调度一次 drain。drain 完成后若队列又有新条目（drain 期间到达的），再次调度——这保证了不会因为 drain 与入队的竞态而漏写。

**CCR 模式快速 Flush**。当启用 Remote Control（`setRemoteIngressUrl` 或 `setInternalEventWriter` 被调用）时，`FLUSH_INTERVAL_MS` 改为 10ms（`src/utils/sessionStorage.ts:531, 1387-1389, 1397`）。原因：CCR 模式下远端 ingress 是数据的主要持久化点，本地写入可以容忍更高频率——因为远端已经有一份了，本地慢一点写也无所谓；反而 10ms 能让本地尽快与远端对齐，减少"远端已有但本地未写"的窗口。

**具体实例**。一轮工具调用在 50ms 内产生 12 条消息，全部 `enqueueWrite` 入队。第一条入队触发 `scheduleDrain` 设 100ms 定时器，后续 11 条因 `flushTimer` 已存在而跳过调度。100ms 后定时器触发，`drainWriteQueue` 把 12 条合并成一次 `appendFile`（约几十 KB），一次 syscall 完成。期间 Agent 循环未被阻塞。若这 100ms 内进程崩溃，12 条全丢——这是 100ms 缓冲的代价，由 `process.exit` 的 flush handler 兜底（二章提过）。

#### 4.1.4 去重缓存：sessionMessagesCache

**为什么需要**。4.1.1 里 `recordTranscript` 每次都要调 `getSessionMessages(sessionId)` 拿已记录 UUID 集合做去重。如果每次都读 JSONL 文件解析，一次工具调用链有多次 `recordTranscript`，每次都读盘解析几十 MB 文件——去重本身比写入还慢。需要一个进程级缓存，把"已记录 UUID 集合"留在内存里，避免重复读盘。

**怎么做**。`sessionMessagesCache`（`src/utils/sessionStorage.ts:3951-3980`）是一个 bounded Map，上限 200 个 session，FIFO eviction：

```typescript
// src/utils/sessionStorage.ts:3951-3980
const sessionMessagesCache = new Map<UUID, Promise<Set<UUID>>>()
// 上限 200 条，FIFO eviction

export async function getSessionMessages(sessionId: UUID): Promise<Set<UUID>> {
  const existing = sessionMessagesCache.get(sessionId)
  if (existing !== undefined) return existing

  if (sessionMessagesCache.size >= MAX_CACHED_SESSION_FILES) {
    const oldestKey = sessionMessagesCache.keys().next().value
    if (oldestKey !== undefined) sessionMessagesCache.delete(oldestKey)
  }

  const promise = (async () => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  })()
  sessionMessagesCache.set(sessionId, promise)
  return promise
}
```

**关键耦合**：compact 后必须 `clearSessionMessagesCache()`（`src/utils/sessionStorage.ts:3991-3993`）。原因：compact 会用摘要替代前缀，旧前缀的 UUID 不再在链上（被 compact_boundary 取代），但 `sessionMessagesCache` 还缓存着这些旧 UUID。如果不清缓存，`recordTranscript` 去重时会把"已被 compact 移除的旧消息"误判为已记录，导致后续基于这些旧 UUID 的链重建出错。这条手动清理链是缓存与持久化耦合最紧的地方——缓存帮我们省了读盘，但代价是必须在数据失效时手动通知它。

**具体实例**。会话进行到第 5 轮，`sessionMessagesCache` 已缓存该 session 的 UUID 集合（约 20 条）。第 6 轮 `recordTranscript` 调 `getSessionMessages`，直接命中缓存返回 Set，无需读盘。去重后写入新消息。若第 6 轮触发 compact，compact 完成后必须 `clearSessionMessagesCache()`——否则第 7 轮去重时缓存里的旧 UUID（已被 compact 移除的）会让 `recordTranscript` 误判。

写入生命周期到此完整：`recordTranscript` 去重分区 → `insertMessageChain` 盖 stamp → `enqueueWrite` 入队 → 100ms 后 `drainWriteQueue` 批量落盘。下一节看反向的恢复生命周期——这些落盘的消息如何被读回来重建对话状态。

### 4.2 恢复生命周期

恢复生命周期回答"用户执行 `--resume` 时，磁盘上的 JSONL 如何变回内存里的对话状态"。它由 `loadTranscriptFile` 的六个 Phase 串联，外加 DAG 修复和 leaf 计算两个后处理。每个机制同样按三段式讲。

#### 4.2.1 loadTranscriptFile 六阶段流水线

**为什么需要**。直接 `readFile` + `JSON.parse` 整个 JSONL 文件能工作，但对几十 MB 的大文件会很慢——既因为全量解析耗时，也因为大量死分支和已压缩内容被无谓解析。恢复发生在用户刚启动、最没耐心的时刻，必须快。所以恢复被设计成六阶段流水线，前两阶段在解析前就剔除大部分无用字节。

**怎么做**。`loadTranscriptFile`（`src/utils/sessionStorage.ts:3566-3918`）：

```typescript
// src/utils/sessionStorage.ts:3566-3918
export async function loadTranscriptFile(filePath, opts?) {
  const messages = new Map<UUID, TranscriptMessage>()
  // ... 各种 session-scoped maps（summaries, customTitles, tags, ...）

  let buf: Buffer | null = null
  let metadataLines: string[] | null = null
  let hasPreservedSegment = false

  // Phase 1: 大文件 pre-compact skip
  if (!CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP) {
    const { size } = await stat(filePath)
    if (size > SKIP_PRECOMPACT_THRESHOLD) {
      // 通过 readTranscriptForLoad (portable) 找到 boundary，截断 pre-boundary
      const scan = await readTranscriptForLoad(filePath, size)
      buf = scan.postBoundaryBuf
      hasPreservedSegment = scan.hasPreservedSegment
      // 扫描 pre-boundary 字节恢复 session-scoped metadata
      if (scan.boundaryStartOffset > 0) {
        metadataLines = await scanPreBoundaryMetadata(filePath, scan.boundaryStartOffset)
      }
    }
  }
  buf ??= await readFile(filePath)

  // Phase 2: 死分支剪枝（除非有 preservedSegment 或 keepAllLeaves）
  if (!opts?.keepAllLeaves && !hasPreservedSegment &&
      !CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP &&
      buf.length > SKIP_PRECOMPACT_THRESHOLD) {
    buf = walkChainBeforeParse(buf)
  }

  // Phase 3: 处理 pre-boundary metadata
  if (metadataLines?.length > 0) {
    const metaEntries = parseJSONL<Entry>(Buffer.from(metadataLines.join('\n')))
    // 填充 summaries, customTitles, tags, etc.
  }

  // Phase 4: 解析主 buffer
  const entries = parseJSONL<Entry>(buf)

  // Legacy progress bridge（处理 PR #24099 之前的旧格式）
  const progressBridge = new Map<UUID, UUID | null>()

  for (const entry of entries) {
    if (isLegacyProgressEntry(entry)) {
      // 链式解析：连续 progress 条目解析到非 progress 祖先
      const parent = entry.parentUuid
      progressBridge.set(entry.uuid,
        parent && progressBridge.has(parent)
          ? (progressBridge.get(parent) ?? null)
          : parent,
      )
      continue
    }
    if (isTranscriptMessage(entry)) {
      // 修复旧 transcript 中指向 progress 的 parentUuid
      if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
        entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
      }
      messages.set(entry.uuid, entry)
      // Compact boundary：清除 stale ctx-collapse commits
      if (isCompactBoundaryMessage(entry)) {
        contextCollapseCommits.length = 0
        contextCollapseSnapshot = undefined
      }
    } else if (entry.type === 'summary') { /* ... */ }
    else if (entry.type === 'custom-title') { /* ... */ }
    // ... 其他 entry types
  }

  // Phase 5: DAG 修复
  applyPreservedSegmentRelinks(messages)   // compact preserved segment
  applySnipRemovals(messages)               // snip removed range

  // Phase 6: 计算 leaf UUIDs（用于 resume anchor）
  const allMessages = [...messages.values()]
  const parentUuids = new Set(
    allMessages.map(m => m.parentUuid).filter((u): u is UUID => u !== null)
  )
  const terminalMessages = allMessages.filter(m => !parentUuids.has(m.uuid))

  const leafUuids = new Set<UUID>()
  for (const terminal of terminalMessages) {
    // 从 terminal 向后走，找到最近的 user/assistant
    const seen = new Set<UUID>()
    let current: TranscriptMessage | undefined = terminal
    while (current) {
      if (seen.has(current.uuid)) break  // 循环检测
      seen.add(current.uuid)
      if (current.type === 'user' || current.type === 'assistant') {
        leafUuids.add(current.uuid)
        break
      }
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined
    }
  }

  return { messages, summaries, customTitles, /* ... */ leafUuids }
}
```

六个 Phase 的分工：**Phase 1** 大文件跳过 pre-compact 内容（已压缩的旧内容对恢复无意义）；**Phase 2** 字节级剪枝死分支（4.2.2 详述）；**Phase 3** 从被跳过的 pre-boundary 区单独恢复会话级元数据（title/tag 等，它们不能丢）；**Phase 4** 解析主 buffer 并处理 legacy progress 格式；**Phase 5** DAG 修复（4.2.3 详述）；**Phase 6** 计算 leaf UUIDs 作为 resume 锚点。Phase 1 和 2 是性能关键——它们在 `JSON.parse` 之前就把大部分字节剔除了。

**具体实例**。一个 41 MB 的 JSONL，含一次 compact 和大量死分支。Phase 1 检测到 size > `SKIP_PRECOMPACT_THRESHOLD`，`readTranscriptForLoad` 找到 compact_boundary，截断 pre-boundary 字节（约 30 MB），保留 post-boundary 的 11 MB；同时扫描 pre-boundary 恢复 title/tag 元数据。Phase 2 对 11 MB 做 `walkChainBeforeParse`，剪掉死分支后剩约 1 MB。Phase 4 只解析 1 MB，而非原始 41 MB——这是恢复快的根本原因。

#### 4.2.2 walkChainBeforeParse：字节级死分支剪枝

**为什么需要**。Phase 1 跳过的是"已压缩内容"，Phase 2 跳过的是"死分支"——rewind/regenerate 留下的旧推理路径。死分支可能占文件 90%+（用户反复 regenerate 的场景），如果先 `JSON.parse` 再过滤，解析本身就耗时几十 ms。利用 3.2.1 讲的"`parentUuid` 是第一个键"这一不变式，可以在字节层直接识别消息行并沿 parent 链回溯，跳过死分支，把解析量降到原来的 7-20%。

**怎么做**。`walkChainBeforeParse`（`src/utils/sessionStorage.ts:3400-3560`）的算法核心：

- 构建 stride-3 扁平索引：`[lineStart, lineEnd, parentStart]`——每行记录起始字节、结束字节、parentUuid 在行内的偏移，纯字节操作，不 `JSON.parse`。
- 找到最后一个 `isSidechain:false` 的条目作为 leaf。
- 沿 `parentUuid` 向上回溯到 root，标记保留条目。
- 仅当死分支字节数 > 50% 时才执行拼接（避免 break-even 开销——若死分支占比小，拼接的内存拷贝开销可能超过解析节省）。

**具体实例**。来自实际 benchmark：

```
输入: 41 MB JSONL，99% 为死分支
walkChainBeforeParse 后: parseJSONL 56.0 ms → 3.9 ms (-93%)

输入: 151 MB JSONL，92% 为死分支
walkChainBeforeParse 后: 47.3 ms → 9.4 ms (-80%)
```

41 MB 文件 99% 是死分支（用户反复 regenerate 同一轮），字节级剪枝后只需解析 1% 的活链路，`parseJSONL` 从 56ms 降到 3.9ms。这就是 3.2.1 强调"键顺序不变式"的价值——它让这个优化成为可能。

#### 4.2.3 DAG 修复：preserved segment 与 snip

**为什么需要**。Phase 4 解析后得到的 `messages` Map 还不能直接用——compact 的 preserved segment 和 snip 的 removed range 都改写了 `parentUuid` 指针，但 JSONL 里存的是改写前的原始指针（append-only，不能原地改）。必须在内存里重建这些指针，否则 walk 链会断。

**怎么做**。两个修复函数：

`applyPreservedSegmentRelinks`（`src/utils/sessionStorage.ts:1876-1993`）处理 compact preserved segment：

- tail→head 链必须完整（否则 walk broken，log `tengu_relink_walk_broken`）。
- head 的 parentUuid 改写为 anchor。
- anchor 的其他子节点 parentUuid 改写为 tail。
- 保留段中 assistant 的 usage 字段清零（避免 stale pre-compact token 计数污染恢复后的 token 统计）。

`applySnipRemovals`（`src/utils/sessionStorage.ts:2019-2076`）处理 snip：

- 从 `snipMetadata.removedUuids` 收集删除列表。
- 删除前记录每个被删节点的 `parentUuid`，用于后续 relink。
- 幸存节点的 `parentUuid` 若落在删除区，沿删除区的 parent 链回溯到第一个未删除祖先。
- path compression：解决后写入 `deletedParent` map，避免后续重复 walk。

**具体实例**。compact 保留了一段 `[head...tail]`，它原本挂在 `anchor` 下，但 compact 后这段要被"摘出来"作为有效上下文。`applyPreservedSegmentRelinks` 把 `head.parentUuid` 改写为 `anchor`（让保留段接回主链），把 `anchor` 原本的其他子节点 `parentUuid` 改写为 `tail`（让主链从保留段尾部继续）。这样恢复后的对话链是 `...→anchor→head→...→tail→后续`，保留段被正确嵌入。

#### 4.2.4 平行 tool_result 恢复

**为什么需要**。3.2.2 讲过平行工具调用会产生共享 `message.id` 的兄弟 assistant。加载时 `walk()` 只沿一条链走，会跳过其他兄弟 assistant 及其 tool_result——这些 tool_result 成了"孤儿"。不恢复它们，用户看到的对话就缺了部分工具结果。

**怎么做**。`recoverOrphanedParallelToolResults`（`src/utils/sessionStorage.ts:2155-2245`）按 `message.id` 分组恢复：

```
问题: 同一 message.id 的多个 assistant 中只有一个在 chain 上
      walk() 跳过其余；它们的 tool_result 同样被跳过

解决: 按 message.id 分组，找到所有兄弟；按 timestamp 排序；
      splice 到 anchor 之后
```

**具体实例**。一次 assistant 响应含 3 个 tool_use（Read、Grep、Bash），产生 3 个共享 `message.id` 的 assistant 条目和 3 个 tool_result。walk 沿第一个 assistant 走，后两个 assistant 和它们的 tool_result 被跳过。`recoverOrphanedParallelToolResults` 按 `message.id` 找到这 3 个兄弟，按 timestamp 排序后 splice 回 anchor 之后，让 3 个 tool_result 都重新可见。

#### 4.2.5 leaf UUIDs 计算

**为什么需要**。恢复后需要知道"从哪里继续"——也就是当前对话的叶子节点。但叶子不一定是文件最后一条（可能是死分支的末端），需要从 DAG 拓扑上找"没有被任何消息指向的终端节点"，再回溯到最近的 user/assistant 作为 resume 锚点。

**怎么做**。Phase 6 的算法（见 4.2.1 代码）：收集所有被指向的 `parentUuids`，终端消息 = 不在 `parentUuids` 中的消息；从每个终端向后走，找到最近的 user/assistant，加入 `leafUuids`。带循环检测（`seen` Set）防止 DAG 环路死循环。

**具体实例**。文件末尾是一段死分支（regenerate 留下的），死分支末端是个 assistant，但它被最新链上的某条消息"绕过"了（不在 `parentUuids` 中是错的——它其实被旧的 user 指向）。算法找到真正的终端（最新链的 user），向后走到 user/assistant，作为 `leafUuids`。`--resume` 后 Agent Loop 从这个 leaf 继续。

#### 4.2.6 一致性检查与 adopt

**为什么需要**。恢复后要验证"写进去多少、读回来多少"是否一致——write→load round-trip 可能因为 snip/compact 的 parentUuid walk bug 而漂移。同时恢复出的会话文件指针要"过户"给当前 Project 实例，否则后续写入会写到错误的地方。

**怎么做**。`checkResumeConsistency`（`src/utils/sessionStorage.ts:2263-2282`）找到最近的 `turn_duration` checkpoint，对比预期 messageCount 与实际位置：

```typescript
// src/utils/sessionStorage.ts:2263-2282
export function checkResumeConsistency(chain: Message[]): void {
  // 找到最近的 turn_duration checkpoint
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i]!
    if (m.type !== 'system' || m.subtype !== 'turn_duration') continue
    const expected = m.messageCount as number | undefined
    if (expected === undefined) return
    // checkpoint 的位置应该 == messageCount
    const actual = i
    logEvent('tengu_resume_consistency_delta', {
      expected, actual, delta: actual - expected,
      chain_length: chain.length,
    })
    return
  }
}
```

若 delta > 0 表示 resume 加载了比会话中更多的消息（典型 bug：snip/compact 操作未正确应用 parentUuid walk）。这只记 telemetry 不阻断恢复，用于监控漂移。

`adoptResumedSessionFile`（`src/utils/sessionStorage.ts:1567-1571`）把恢复的文件过户给 Project：

```typescript
// src/utils/sessionStorage.ts:1567-1571
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)  // skipTitleRefresh=true
}
```

必须在 `switchSession` + `resetSessionFilePointer` + `restoreSessionMetadata` 之后调用。否则 `-c -n foo` + quit-before-message 会丢失用户指定的 title——in-memory cache 是正确的但从未写入文件。

**完整调用链**：

```
loadConversationForResume(sessionId)
  │
  ├─► getLastSessionLog(sessionId)
  │     │
  │     └─► loadSessionFile(sessionId)
  │           │
  │           └─► loadTranscriptFile(filePath) ← 同上完整流程
  │
  ├─► buildConversationChain(messages, leafMessage)
  │     │
  │     └─► recoverOrphanedParallelToolResults(...) ← DAG 恢复
  │
  ├─► checkResumeConsistency(chain) ← 一致性检查
  │
  └─► 恢复各种 side state（permission mode、model override 等）
```

#### 4.2.7 Tombstone：removeMessageByUuid

**为什么需要**。append-only 模型下"删除"一条消息不能真删（会破坏文件结构），但有些场景需要移除特定消息（如撤销最近一条）。tombstone 机制用"字节级 truncate + rewrite"实现物理移除——大部分 tombstone 目标是文件末尾的最后一条，O(1) truncate 比软删除标记更高效，且不污染恢复路径。

**怎么做**。`removeMessageByUuid`（`src/utils/sessionStorage.ts:893-973`）有快慢两条路径：

```typescript
// src/utils/sessionStorage.ts:893-973
async removeMessageByUuid(targetUuid: UUID): Promise<void> {
  return this.trackWrite(async () => {
    if (this.sessionFile === null) return
    try {
      let fileSize = 0
      const fh = await fsOpen(this.sessionFile, 'r+')
      try {
        const { size } = await fh.stat()
        fileSize = size
        if (size === 0) return

        // 快路径：扫描最后 64KB（LITE_READ_BUF_SIZE）
        const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
        const tailStart = size - chunkLen
        const buf = Buffer.allocUnsafe(chunkLen)
        const { bytesRead } = await fh.read(buf, 0, chunkLen, tailStart)
        const tail = buf.subarray(0, bytesRead)

        // 字节级匹配 `"uuid":"<target>"`（避免误匹配 parentUuid）
        const needle = `"uuid":"${targetUuid}"`
        const matchIdx = tail.lastIndexOf(needle)

        if (matchIdx >= 0) {
          // 找到行边界
          const prevNl = tail.lastIndexOf(0x0a, matchIdx)
          if (prevNl >= 0 || tailStart === 0) {
            const lineStart = prevNl + 1
            const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
            const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

            const absLineStart = tailStart + lineStart
            const afterLen = bytesRead - lineEnd

            // truncate + 写回尾部（O(1) 通常情况）
            await fh.truncate(absLineStart)
            if (afterLen > 0) {
              await fh.write(tail, lineEnd, afterLen, absLineStart)
            }
            return
          }
        }
      } finally {
        await fh.close()
      }

      // 慢路径：目标不在 64KB tail 内，rewrite 整个文件
      if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {  // 50 MB 上限
        logForDebugging(`Skipping tombstone removal: session file too large`)
        return
      }
      const content = await readFile(this.sessionFile, 'utf-8')
      const lines = content.split('\n').filter(line => {
        if (!line.trim()) return true
        try {
          const entry = jsonParse(line)
          return entry.uuid !== targetUuid
        } catch { return true }
      })
      await writeFile(this.sessionFile, lines.join('\n'), { encoding: 'utf8' })
    } catch { /* file may not exist */ }
  })
}
```

快路径只读最后 64KB（`LITE_READ_BUF_SIZE`），字节级匹配 `"uuid":"<target>"`（注意不是 `parentUuid`，避免误匹配），找到行边界后 truncate + 写回尾部，O(1) 完成。慢路径在目标不在 64KB 尾部时触发，rewrite 整个文件——但有 50MB 上限（`MAX_TOMBSTONE_REWRITE_BYTES`），超大文件直接跳过避免卡死。

**具体实例**。用户撤销最近一条 assistant 消息（rewind）。`removeMessageByUuid(asst_last_uuid)` 走快路径：读最后 64KB，字节匹配到 `"uuid":"<asst_last_uuid>"`，truncate 到该行起始，写回该行之后的内容。文件少了最后一行，O(1) 完成。若撤销的是 100MB 文件中间的某条消息，慢路径触发，但因 `fileSize > 50MB` 直接跳过——这是性能保护，宁可保留也不卡死。

恢复生命周期到此完整：六阶段流水线加载 → 字节级剪枝 → DAG 修复 → 平行 tool_result 恢复 → leaf 计算 → 一致性检查 → adopt 文件。下一节看环绕其外的缓存层如何协同工作。

### 4.3 缓存协同生命周期

前两节沿写入与恢复两条流走完了 transcript 本身。但持久化层还有另一半职责——**缓存**：减少重复计算、降低 token 消耗。本节看缓存层如何与写入/恢复协同。需要先纠正一个直觉：缓存不是独立于持久化的"附加优化"，而是渗透在写入（去重缓存）、恢复（memoize）、API 调用（Prompt Cache）全过程的协同机制。3.3 节已列出全部缓存层，本节聚焦最核心的 Prompt Cache 与各层如何协同。

#### 4.3.1 Prompt Cache：stable vs dynamic

**为什么需要**。Anthropic API 的 Prompt Cache 功能：5 分钟内若 system prompt 的前缀不变，API 复用之前的 token 计算结果，省掉重新编码的成本。一次 Agent 调用的 system prompt 可达数万 token（CLAUDE.md、tools schema、skill 定义），若每轮都重新编码，token 成本和延迟都不可接受。把 system prompt 拆成"稳定前缀 + 动态后缀"，让稳定部分命中缓存，是省 token 的关键。

**怎么做**。Claude Code 的 system prompt 由 stable 部分（CLAUDE.md、tools schema、skill 定义）和 dynamic 部分（git status、当前时间）组成，边界就是 `cache_control` 标记：

```
[
  { type: 'text', text: '<stable prefix>', cache_control: { type: 'ephemeral' } },
  // ... 完整 system prompt
  { type: 'text', text: '<dynamic context>', cache_control: { type: 'ephemeral' } }
]
```

- **stable block**：CLAUDE.md 内容、skill 定义、tools schema——这些在整个会话中不变。
- **dynamic block**：git status、当前时间、env 变量——每轮更新。

通过 `cache_control: { type: 'ephemeral' }` 标记，Anthropic API 在 5 分钟内复用 stable block 的 token 计算结果（`src/services/api/claude.ts:328`）。

**缓存层级汇总**（与 3.3 节呼应）：

| 层 | 缓存什么 | 命中率影响 | 证据 |
|----|---------|-----------|------|
| API Prompt Cache | System prompt 前缀（5min TTL） | 高，省 token | `src/services/api/claude.ts:328` |
| Microcompact cache | 压缩结果 | 中 | `src/services/compact/cachedMicrocompact.ts` |
| CLAUDE.md memoize | 文件内容 | 高（启动后不变） | `src/utils/claudemd.ts` |
| Git status memoize | git 状态字符串 | 高（快照不更新） | `src/context.ts:36` |
| Skill TF-IDF | 索引向量 | 高 | `src/services/skillSearch/localSearch.ts:291` |
| MCP tools list | tools/list 结果 | 高 | `src/services/mcp/client.ts:1755` |
| Transcript write queue | 待写入消息 | — | `src/utils/sessionStorage.ts:613` |

#### 4.3.2 缓存命中率优化

**为什么需要**。Prompt Cache 只在前缀完全一致时命中——任何字节变化都会让整段缓存失效。所以"哪些操作会扰动前缀"必须严格管控，否则缓存形同虚设。

**怎么做 + 具体实例**。三条优化：

1. **CLAUDE.md 顺序稳定**：先读仓库根 CLAUDE.md，再读子目录——保持 token 序列前缀一致。若顺序随机，每次拼出的 system prompt 不同，缓存永远 miss。
2. **Tools schema 不变**：tool list 变更会失效 cache。所以工具注册在会话开始时一次性完成，会话中不动态增删（MCP 工具 reconnect 时才刷新，会接受缓存失效的代价）。
3. **Git status 节流**：只在 cwd 或 branch 变化时重新获取。git status 字符串若每轮都变（比如包含时间戳），dynamic block 每轮都变尚可接受（它本就是 dynamic），但若 stable block 里混入了易变内容就会击穿缓存。

**协同关系**。各层缓存与持久化的协同：`sessionMessagesCache` 服务于写入去重（4.1.4）；CLAUDE.md/Git status memoize 服务于 system prompt 构建（避免每轮重读文件）；Prompt Cache 服务于 API 调用（避免重新编码）。三者处于不同层级但目标一致——避免重复工作。失效链上，compact 触发 `clearSessionMessagesCache()`（4.1.4），MCP reconnect 触发 tools cache 刷新，CLAUDE.md 文件变更触发 `resetGetMemoryFilesCache()`——每条失效链都对应一个"数据变了缓存必须跟着废"的场景。

### 4.4 远端协同生命周期

前面三节都在讲本地。本节看 Remote Control（CCR）模式下，transcript 如何在本地与远端间同步。这是选读内容，不关心 Remote Control 可跳过。

#### 4.4.1 v1 Session Ingress

**为什么需要**。CCR v1 模式下，远端 ingress 是数据的主持久化点——用户可能从不同设备连接同一个远端会话。本地写入是次要的。这带来一个严格要求：每条 entry 必须同步到远端，否则跨设备会丢数据。

**怎么做**。`persistToRemote`（`src/utils/sessionStorage.ts:1339-1380`）在每次写入后把 entry POST 到远端 ingress：

```typescript
// src/utils/sessionStorage.ts:1339-1380
private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
  if (isShuttingDown()) return

  // 失败处理
  if (!ENABLE_SESSION_PERSISTENCE || !this.remoteIngressUrl) return

  const success = await sessionIngress.appendSessionLog(
    sessionId, entry, this.remoteIngressUrl
  )

  if (!success) {
    logEvent('tengu_session_persistence_failed', {})
    gracefulShutdownSync(1, 'other')  // 远端失败 → 进程退出
  }
}
```

**关键设计**：远端持久化失败触发进程退出（`gracefulShutdownSync`），而非静默继续。这是与本地写入（4.1.3 的 fail-open drop）截然相反的策略——本地丢一条尚能从上下文恢复，远端丢一条会导致跨设备数据分叉，分叉后无法收敛。所以 v1 选择"宁可挂掉也不分叉"。代价是远端抖动会直接打断会话。

#### 4.4.2 v2 Internal Events

**为什么需要**。v1 的 HTTP ingress 每条 entry 一次请求，高频写入时网络开销大，且不支持子 Agent 事件的独立读写。v2 改用 internal event writer/reader 抽象，支持流式与子 Agent 分离。

**怎么做**。通过 `setInternalEventWriter` / `setInternalEventReader`（`src/utils/sessionStorage.ts:502-521`）注入读写器：

```typescript
// src/utils/sessionStorage.ts:502-521
export function setInternalEventWriter(writer: InternalEventWriter) { ... }
export function setInternalEventReader(reader, subagentReader) { ... }
```

通过 `hydrateFromCCRv2InternalEvents` 从 CCR 重建本地 JSONL：

```
sessionId → switchSession()
         → reader() → foreground events
         → subagentReader() → per-agent events
         → 写入 <sessionDir>/<sessionId>.jsonl
         → 写入 <sessionDir>/subagents/agent-<id>.jsonl (per agent)
```

v2 的改进是 `subagentReader` 让子 Agent 事件独立读取——子 Agent transcript 单独 hydrate 到独立文件，与 3.3 数据地图里的子 Agent transcript 存储结构对齐。

#### 4.4.3 hydrateRemoteSession

**为什么需要**。从远端拉取历史日志后，需要重放成本地 JSONL 文件，之后才能走标准恢复管线（4.2）。`hydrateRemoteSession` 就是这个"远端 → 本地文件"的桥。

**怎么做**。`hydrateRemoteSession`（`src/utils/sessionStorage.ts:1624-1659`）：

```typescript
// src/utils/sessionStorage.ts:1624-1659
export async function hydrateRemoteSession(sessionId, ingressUrl): Promise<boolean> {
  switchSession(asSessionId(sessionId))
  const project = getProject()
  try {
    const remoteLogs = (await sessionIngress.getSessionLogs(sessionId, ingressUrl)) || []
    const projectDir = getProjectDir(getOriginalCwd())
    await mkdir(projectDir, { recursive: true, mode: 0o700 })
    const sessionFile = getTranscriptPathForSession(sessionId)
    // writeFile truncate：不需要 unlink
    const content = remoteLogs.map(e => jsonStringify(e) + '\n').join('')
    await writeFile(sessionFile, content, { encoding: 'utf8', mode: 0o600 })
    return remoteLogs.length > 0
  } catch (error) {
    logForDiagnosticsNoPII('error', 'hydrate_remote_session_fail')
    return false
  } finally {
    project.setRemoteIngressUrl(ingressUrl)
  }
}
```

`writeFile` 是 truncate 写——直接覆盖，不需要先 unlink。写完后本地有了完整 JSONL，后续 `loadTranscriptFile` 走标准六阶段恢复。`finally` 里 `setRemoteIngressUrl` 保证 hydrate 后新写入仍会同步到同一个远端。

**具体实例**。用户在设备 A 跑了会话，切到设备 B 继续。设备 B 启动 CCR，`hydrateRemoteSession` 从远端拉取所有历史 entry，重放成本地 `<sessionId>.jsonl`。之后 `loadTranscriptFile` 走六阶段恢复，与本地会话恢复体验一致。新写入通过 `persistToRemote`（v1）或 internal event writer（v2）同步回远端，设备 A 若再连也能看到。

至此四条生命周期——写入、恢复、缓存、远端——全部走完。下一章用设计权衡收束，看这些机制背后哪些是刻意选择、放弃了什么。

---

## 五、设计权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 存储格式 | JSONL（每行一个 JSON） | 结构化 DB（SQLite） | JSONL 人可读、支持 grep/流式处理、跨平台；DB 需要额外依赖和管理。Agent transcript 访问模式是顺序追加+顺序读取，DB 索引能力是浪费 |
| 写入策略 | 缓冲写入（100ms batch） | 实时写入 | 减少磁盘 I/O 频率；100ms 延迟对 Agent 循环无感知影响。100ms 是"人无感"与"I/O 合并"的折中点 |
| 消息链模型 | parentUuid DAG | 线性数组 | 树结构支持 fork 分支（子 Agent、plan 分支）、平行工具调用、rewind 死分支；线性数组无法表达这些拓扑 |
| 死分支处理 | 预解析字节级剪枝 | 解析后丢弃 | 解析前剪枝节省 80-93% parseJSONL 时间。依赖"`parentUuid` 是第一个键"的不变式 |
| Compact 策略 | 大文件 pre-compact skip | 全量加载 | 压缩边界前的旧内容对恢复无意义（已被摘要替代），跳过可大幅减少加载时间 |
| 过期策略 | 无自动过期 | TTL 自动清理 | 会话文件是用户的"工作记录"，自动删除可能丢失重要上下文。代价是磁盘持续增长 |
| Flush 间隔 | 100ms（CCR 10ms） | 立即 flush | 平衡 I/O 频率与延迟；CCR 模式优先保证远端一致性，本地可容忍更高频率 |
| 队列上限 | 1000 条/filePath | 无限制 | 防止内存无限增长；超出时 drop oldest 保护最新数据。fail-open 而非报错，避免阻塞 Agent |
| 远端失败策略 | 进程退出（v1） | 静默继续 | 远端丢条会导致跨设备数据分叉且无法收敛；本地丢条尚能从上下文恢复。所以远端严格、本地宽松 |
| Tombstone 策略 | 字节级 truncate + rewrite | 软删除标记 | 大部分 tombstone 目标是最后一条消息，O(1) truncate 比标记 + 跳过更快；软删除会污染恢复路径 |
| Session messages 缓存 | 进程级 bounded Map | 每次重读文件 | 避免重复 IO；200 条上限防止 swarm/daemon 模式内存爆炸。代价是 compact 后需手动 clear |
| Sub-agent transcript | 独立 JSONL 文件 | 共享父 transcript | 子 Agent 通常独立加载，独立文件避免每次读全量；与 CCR v2 子 Agent 事件独立读写对齐 |

这张表的核心张力是"严格 vs 宽松"：本地写入宽松（fail-open drop）、远端写入严格（失败即退出）；本地删除严格（物理 truncate）、远端同步宽松（hydrate 重放）。每个选择背后都有明确的失败语义——本地错了能从上下文恢复，远端错了无法收敛。

---

## 六、可复用的模式

- **分层缓存模式**：Prompt Cache（API 层）→ 内存 memoize（应用层）→ JSONL 磁盘（持久化层）。越上层越快但越贵，越下层越慢但越便宜。每层失效策略不同但目标一致：避免重复工作。

- **增量持久化模式**：每轮写入（而非全部完成后写入），确保进程崩溃时只丢失最后一轮数据（最多 100ms 的缓冲）。配合 `process.exit` 的 flush handler 兜底。

- **写缓冲 + 批量刷盘模式**：100ms 的写缓冲窗口合并多次小写入为一次大写入，减少 I/O 次数。CCR 模式缩短到 10ms 以优先保证远端一致性。窗口大小是"延迟感知"与"I/O 合并收益"的折中。

- **消息树模型**：用 `parentUuid` 构建消息 DAG 而非线性数组，天然支持分支、子 Agent、Plan 模式的上下文分叉、平行工具调用、rewind 死分支。

- **预解析字节级剪枝**：利用 `{"parentUuid":` 是消息行第一个键的不变式，纯字节操作剪枝死分支，避免 `JSON.parse` 开销。把"不变式"变成"优化契约"是可迁移的思路——任何有结构保证的格式都能用类似手法。

- **bounded Map 缓存**：daemon/swarm 模式下需要限制缓存大小，FIFO eviction 而非 LRU（实现简单且对"近期不再访问"的会话足够）。

- **session-scoped vs process-scoped 缓存**：CLAUDE.md 是会话级（重启后必须重读），sessionMessagesCache 是进程级（持久化由 transcript 保证）。区分 scope 决定失效时机。

- **External-writer safety**：`reAppendSessionMetadata` 在写入前先从 tail 读取刷新 cache，避免 SDK 在我们打开会话期间修改文件导致数据丢失。这是"读写同文件"场景下的通用防护。

- **失败语义分级**：本地写入 fail-open（drop + 静默 resolve），远端写入 fail-fast（失败即退出）。按"错误能否事后收敛"分级处理失败，而非一刀切。


