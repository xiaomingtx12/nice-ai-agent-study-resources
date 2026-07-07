---
description: "MCP 把「接入外部工具」从 M×N 条集成线压成 M+N——任何实现协议的 server 都能被 Agent 即插即用。本章拆多种 transport 如何适配本地与远程、OAuth 与断连重连如何容错、server 返回的工具如何自动注册成 mcp__ 命名空间的 Agent 可调用工具。"
---

# MCP 外部工具集成

> **本章目标**：理解 MCP（Model Context Protocol）在 Claude Code 中的完整实现机制——它如何把外部工具接入标准化为协议层，多种 transport 如何适配本地与远程场景，OAuth 认证、重连容错、工具自动注册等子系统如何协作。
>
> **读完本章你应该能回答**：
> - 什么是 MCP？为什么 Agent 需要它而不是直接写集成？
> - Claude Code 支持哪些 transport？各自适用什么场景？
> - 一个 MCP 连接从配置到可用的完整生命周期是什么？
> - MCP server 返回的工具如何自动变成 Agent 可调用的工具？
> - 远程 MCP server 断开后如何自动恢复？OAuth 流程是如何设计的？
> - MCP 工具与内置工具在权限、命名、加载策略上有什么差异？

## 配套阅读标注

本文按"**解决什么问题 → 在整体架构中的位置 → 宏观看系统完整样貌 → 深入核心运行时细节**"四级结构组织，正文之后是三段收束（设计权衡、边界局限、可复用模式）与一份关键路径文件附录。

- **第一、二部分**是入口，分别建立"问题意识"与"全局坐标"，篇幅短，建议通读。
- **第三部分（宏观全景）**先用一张端到端全景图建立心智模型，再从协议抽象、版图分类、注册机制、对外接口四个侧面展开——回答"系统长什么样"。建议通读，它是后续细节的地图。
- **第四部分（核心运行时细节）**沿一次 MCP 连接的生命周期组织（配置 → 连接 → 认证 → 发现 → 调用 → 重连 → 动态更新），每个机制遵循"为什么需要 → 怎么做 → 具体实例"三段式——回答"系统怎么跑起来"。其中连接、发现、调用是核心必读；OAuth 与重连偏运维，标记为选读。
- **文末三段收束**从实现中提炼设计取舍、当前不足与可迁移模式。

**文章结构表**：

| 部分 | 章节 | 内容 | 阅读建议 |
|------|------|------|---------|
| 一 | 解决什么问题 | MCP 的动机：把 O(n) 集成成本降到 O(1) | 必读 |
| 二 | 在整体架构中的位置 | MCP 作为外部扩展层与工具管线的关系 | 必读 |
| 三 | 宏观看系统完整样貌 | 全景图 + 核心抽象 + 版图分类 + 注册机制 + 对外接口 | 必读 |
| 三.1 | 全景链路 | 端到端心智模型图 | 必读 |
| 三.2 | 核心抽象 | JSON-RPC、角色、能力、消息类型、核心方法 | 必读 |
| 三.3 | 版图分类 | transport 矩阵、配置作用域、连接状态 | 必读 |
| 三.4 | 注册机制 | 命名空间、Schema 注入、元数据、推送刷新 | 必读 |
| 三.5 | 对外接口 | tools / resources / prompts / skills / channels | 必读 |
| 四 | 深入核心运行时细节 | 沿生命周期展开 | 核心必读，OAuth/重连选读 |
| 四.1 | 配置加载与合并 | 多源配置、企业策略、环境变量 | 必读 |
| 四.2 | 连接建立 | transport 工厂、批处理、握手、信号升级 | 必读 |
| 四.3 | OAuth 认证 | PKCE、刷新、Step-up、XAA | 选读 |
| 四.4 | 工具发现与注册 | fetchToolsForClient 映射 | 必读 |
| 四.5 | 工具调用执行 | callMcpTool、session 过期 | 必读 |
| 四.6 | 断连与重连 | 触发条件、指数退避、失败降级 | 选读 |
| 四.7 | 动态更新与性能 | list_changed、缓存、连接共享 | 必读 |
| 收束一 | 设计决策与权衡 | 关键取舍及原因 | 必读 |
| 收束二 | 边界与局限 | 当前不足 | 选读 |
| 收束三 | 可复用的模式 | 可迁移的设计 | 必读 |
| 附录 | 关键路径文件 | 快速定位代码 | 参考 |

---

## 一、解决什么问题

Agent 的能力受限于内置工具。每接入一个新外部服务（GitHub、Slack、数据库），如果都要写专门的集成代码，扩展成本是 O(n)——N 个服务就需要 N 套适配逻辑。MCP（Model Context Protocol）把"接入外部工具"标准化为一个协议：任何实现了 MCP 的服务，Agent 都能即插即用，把成本从 O(n) 降到 O(1)（写一次 client，所有 MCP server 都能用）。

这个统一抽象的价值不仅是减少代码量，更重要的是**生态共享**：一个组织内部写好的 MCP server 可以被任何支持 MCP 的 AI 工具消费；外部社区贡献的 MCP server（如 `@modelcontextprotocol/server-github`）也不需要为每个 AI 工具单独适配。协议即生态。

换句话说，MCP 解决的是一个"连接数爆炸"问题：如果没有协议层，M 个 AI 工具 × N 个外部服务 = M×N 条集成线；有了协议层，变成 M+N 条线（每个工具写一个 client，每个服务写一个 server）。这正是 USB 之于硬件接口、JDBC 之于数据库连接要解决的问题——把"多对多"压成"多对一 + 一对多"。

> 下一章会把这个"协议层"放进 Claude Code 的整体架构，看它具体嵌在哪里、与内置工具是什么关系。

---

## 二、在整体架构中的位置

MCP 是工具系统的"外部扩展层"——MCP 工具与内置工具在 Agent 眼中地位平等，都在工具管线中执行。MCP 工具的命名规则是 `mcp__<server>__<tool>`，在权限系统中同样适用。

```
┌─────────────────────────────────────────────┐
│              Agent 主循环                    │
│   ④ 工具执行阶段（详见 03-agent-loop）        │
└────────────────┬────────────────────────────┘
                 │ 统一 tool.call()
                 ▼
┌─────────────────────────────────────────────┐
│           工具管线（注册 + 权限 + Hook）       │
└────┬─────────────────────┬──────────────────┘
     │                     │
     ▼                     ▼
┌──────────┐          ┌──────────┐
│ 内置工具  │          │ MCP 工具  │
│ Read/    │          │ mcp__    │
│ Write/   │          │ github__ │
│ Bash...  │          │ create_  │
│          │          │ issue... │
└──────────┘          └────┬─────┘
                           │ JSON-RPC 2.0
                           ▼
                  ┌────────────────┐
                  │  Transport 层   │
                  │ stdio/sse/http │
                  │ ws/sdk/...     │
                  └────────────────┘
```

MCP 是把"工具调用"从 Agent 视角统一后，通过协议层把实现下放到外部服务。Agent 不需要知道 GitHub API 怎么调用——它只需要知道"调用 `mcp__github__create_issue` 并按 schema 传参"。

把 MCP 工具在系统中的"地位"单独点出来，理解它与内置工具的几层关系，才能在权限、命名、加载策略上做正确配置：

- **与内置工具的平等地位**：MCP 工具在 Agent 眼中与 Read/Write/Bash 无异。Agent 通过 `tool_use` 调用，经过相同的权限管线。
- **权限命名规则**：`mcp__<server>__<tool>`（如 `mcp__github__create_issue`）。权限规则：`mcp__github__*(*)` 允许/拒绝所有 GitHub MCP 工具。
- **System Prompt 注入**：工具 Schema 作为 System Prompt 的一部分（与其他内置工具的 Schema 并列）。
- **`alwaysLoad` 元数据**：MCP server 可通过 `_meta.anthropic/alwaysLoad: true` 让该工具绕过延迟加载（始终在 system prompt 中），适合每次会话必用的高频工具。
- **`searchHint` 元数据**：供 `SearchExtraToolsTool` 的 TF-IDF 索引使用——让延迟 MCP 工具更容易被发现。

注意这张图里"工具管线"是统一的收口：无论工具来自内置还是 MCP，到了管线这一层就被一视同仁。MCP 的全部复杂性（协议、传输、认证、重连）都被封装在"Transport 层"之下，对 Agent 透明。这种"对外统一接口、对内隔离实现"正是分层架构的价值。

> 知道了 MCP"是什么"和"在哪"，接下来需要一张全景图把所有零件串起来——这就是第三章。

---

## 三、宏观看系统完整样貌

前两章分别回答了"解决什么问题"和"在架构中的位置"。但 MCP 涉及协议、传输、配置、认证、注册、对外接口等多个侧面，零散看容易迷失。本章先用一张端到端全景图建立心智模型，再逐个侧面展开：核心抽象（协议层长什么样）、版图分类（有哪些传输和配置来源）、注册机制（外部工具如何变成 Agent 工具）、对外接口（除了 tools 还暴露什么）。

### 三.1 全景链路：从配置到一次工具调用

下面这张图把 MCP 集成的一次完整链路画成 7 个阶段，它就是后续所有细节的"地图索引"——第四章会严格沿这条链路展开。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          MCP 集成端到端全景                                     │
│                                                                              │
│  ①配置层           ②连接层            ③认证层           ④发现层               │
│  ──────────        ──────────         ──────────        ──────────           │
│  .mcp.json   ─┐                                                              │
│  user cfg    ─┤    合并 &         并发批量          远程 transport          │
│  local cfg   ─┼──► 企业策略 ──►  connectTo ──►   OAuth/PKCE   ──►  tools/list     │
│  enterprise  ─┤    过滤             Server          XAA / step-up       resources/list │
│  plugin      ─┤                     (本地3 /                            prompts/list  │
│  claudeai    ─┘                      远程20)        (stdio 跳过认证)                    │
│                                                                              │
│  ⑤注册层                   ⑥调用层                       ⑦容错层              │
│  ──────────                ──────────                    ──────────           │
│  映射为 Agent 工具        Agent tool_use                断连 ──► 指数退避      │
│  mcp__github__        ──► callMcpTool ──► tools/call ──► MCP server   重连(5次) │
│  create_issue              ▲                  │                  │      │     │
│  注入 System Prompt        │                  ▼                  │      ▼     │
│                            └── session 过期自动重连 ◄────────────┘   重新发现  │
│                                                                              │
│  ⑧动态更新：notifications/tools/list_changed ──► 刷新工具列表（推送替代轮询）   │
└──────────────────────────────────────────────────────────────────────────────┘
```

用一句话串起这条链路：**配置告诉 Claude Code 要连谁，连接层把传输建起来，认证层在远程场景下完成身份，发现层拉取 server 暴露的能力，注册层把这些能力翻译成 Agent 工具，调用层在 Agent 发起 tool_use 时走 JSON-RPC，容错层在断连时自动重连，动态更新层在 server 主动通知时刷新列表。** 

这张图里每个阶段的机制都对应后文一节：①②在 §三.3 版图分类与 §四.1 配置加载，③在 §四.2 连接与 §四.3 OAuth，④在 §四.4 工具发现，⑤在 §三.4 注册机制，⑥在 §四.5 工具调用，⑦在 §四.6 重连，⑧在 §四.7 动态更新。先有这张图，后面的细节就不会迷路。

### 三.2 核心抽象

全景图里有几个反复出现的关键词——协议、角色、能力、消息。把它们抽出来单独看，就构成了 MCP 的核心抽象层。

#### 协议：为什么是 JSON-RPC 2.0

MCP 是一个 JSON-RPC 2.0 风格的协议（官方声明"标准输入输出 + HTTP"），定义在 [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) 中。Claude Code 同时充当 **MCP 客户端**（发起 requests） 和 **MCP 主机**（编排 server 连接、缓存工具列表）。

为什么选 JSON-RPC 而不是 REST？REST 没有"请求-响应配对"的内置机制——一个 HTTP 请求对应一个响应靠的是连接语义，但 MCP 需要在同一条连接上既能发请求，又能收服务端主动推送的通知，还要能把"哪个响应对应哪个请求"对上号。JSON-RPC 2.0 用 `id` 字段天然解决了配对问题：带 `id` 的是 request/response，不带 `id` 的是 notification。这套"带 id 的请求 → 带 id 的响应 + 无 id 的通知"的模型极其轻量，又足以表达 MCP 需要的全部交互。MCP 在这之上只是定义了**方法名和参数格式**，让不同实现之间能互相理解。

#### 消息类型

所有交互都是 JSON-RPC 2.0 帧：

| 方向 | 消息类型 | 用途 |
|------|---------|------|
| 客户端 → 服务端 | `request` | 请求，如 `tools/list`、`tools/call` |
| 服务端 → 客户端 | `response` | 携带 `result` 或 `error` |
| 双向 | `notification` | 无 `id`，无需回复，如 `notifications/tools/list_changed` |
| 服务端 → 客户端 | `elicitation/create` | 服务端在执行期间询问用户信息（如确认、凭证） |

注意第四行 `elicitation/create`——它打破了"只有客户端发起请求"的单向假设。在某些安全敏感操作前，server 需要反过来问用户"确定要执行吗 / 请提供凭证"，这是 JSON-RPC 双向能力的实际用例。

#### 核心方法

| 方法 | 方向 | 用途 |
|------|------|------|
| `initialize` | C→S | 双方交换协议版本、能力、客户端/服务端元数据 |
| `tools/list` | C→S | 发现可用工具列表，返回 `[{name, description, inputSchema, annotations}]` |
| `tools/call` | C→S | 执行工具，参数按 `inputSchema` 校验，返回 `{content, isError}` |
| `resources/list` | C→S | 发现可读取的资源列表 |
| `resources/read` | C→S | 读取资源内容（URI 寻址） |
| `prompts/list` | C→S | 发现 prompt 模板 |
| `prompts/get` | C→S | 取 prompt 内容（带参数） |
| `notifications/tools/list_changed` | S→C | 服务端工具列表变化时通知客户端刷新 |
| `notifications/resources/list_changed` | S→C | 资源列表变化通知 |
| `notifications/prompts/list_changed` | S→C | prompt 列表变化通知 |
| `roots/list` | S→C | 服务端请求客户端暴露根 URI（当前工作目录） |
| `elicitation/create` | S→C | 服务端请求用户输入（安全敏感操作前的确认） |
| `sampling/createMessage` | S→C | 服务端请求客户端调用 LLM（agent-of-agent 模式，CC 不主动用） |

#### 初始化握手与能力声明

连接建立后立即交换 `initialize` / `initialized` 通知——这告诉对端"我已准备好发送请求"。握手后客户端即可发起 `tools/list`、`resources/list`、`prompts/list`。

握手不是可选的——它是 MCP 协议规定的强制步骤。原因在于 MCP 是能力协商协议：服务端在 `initialize` 响应中声明自己的**能力**（capabilities），比如是否支持 tools、resources、prompts；客户端根据这些能力决定后续可以调用哪些方法。如果不握手就直接发 `tools/list`，对方可能根本没实现 tools 能力，请求会失败。握手把"双方到底支持什么"这件事在连接之初就谈妥。

服务端在 `initialize` 响应中声明 `capabilities`：

```json
{
  "capabilities": {
    "tools": { "listChanged": true },
    "resources": { "subscribe": true, "listChanged": true },
    "prompts": { "listChanged": true },
    "experimental": { "claude/channel": {}, "claude/channel/permission": {} }
  }
}
```

`listChanged: true` 告诉客户端要注册对应的 `list_changed` 通知处理器（详见 §四.7）。`experimental` 字段承载 vendor-specific 扩展——Claude Code 的 channel 推送和 channel 权限流都挂在这个字段下（`gateChannelServer` 控制启用）。把扩展挂在 `experimental` 下是 MCP 留的口子：标准能力走标准字段，厂商私有实验走 `experimental`，避免污染协议命名空间。

### 三.3 版图分类：transport 与配置作用域

同一套 JSON-RPC 协议跑在不同传输和不同配置来源上。把这两张"地图"画出来，MCP 的部署形态就清晰了。

#### Transport 矩阵

MCP 协议独立于传输层。Claude Code 支持 7 种 transport，每种匹配特定部署场景。所有 transport 都在 `src/services/mcp/client.ts:596-1653` 的 `connectToServer` 工厂中装配。

| Transport | 通信方式 | 部署场景 | 配置字段 | 客户端代码 |
|-----------|---------|---------|---------|----------|
| `stdio` | 子进程 stdin/stdout + 终止信号 | 本地 MCP server（npx、Python 包） | `command`, `args`, `env` | `client.ts:949-971` |
| `sse` | HTTP GET 收事件流 / POST 发请求 | 远程 HTTP server SSE 端点 | `url`, `headers`, `oauth` | `client.ts:620-677` |
| `http` | HTTP Streamable（GET+POST+DELETE） | 远程无状态 / 有状态 MCP server | `url`, `headers`, `oauth` | `client.ts:785-866` |
| `ws` / `ws-ide` | WebSocket 双向 | 双向实时、长连接 | `url`, `headers` | `client.ts:709-784` |
| `sdk` | 进程内内存 transport pair | 集成到 SDK 的 MCP server | `name` | `client.ts:867-868`（throw，需走 print.ts） |
| `claudeai-proxy` | 经过 Anthropic CCR 代理 | Claude.ai 网页配置的服务 | `url`, `id` | `client.ts:869-905` |
| `sse-ide` | SSE（IDE 用） | IDE 扩展专用 | `url`, `ideName` | `client.ts:679-708` |

这张矩阵可以从两个维度读：**通信方式**（子进程 / HTTP / WebSocket / 进程内内存 / 代理）和**部署场景**（本地 / 远程 / IDE / 托管）。7 种 transport 不是冗余设计，而是覆盖了"本地子进程、远程无状态、远程流式、双向实时、同进程嵌入、网页托管、IDE 持有"7 种真实部署形态——每一种都是其他 transport 无法干净替代的。比如 `claudeai-proxy` 看起来只是远程 HTTP，但它承载的是"用户在 claude.ai 网页配置、由 Anthropic CCR 代理转发"这条特殊链路，认证用的是 claude.ai 的 OAuth token 而非 server 自己的 OAuth，所以必须单独存在。

#### 配置作用域

MCP 配置从 6 个来源读取并合并，企业策略可禁止非托管 server。作用域优先级（`src/services/mcp/types.ts:11-21`）：

```
enterprise (managed) > project > local > user > plugin > claudeai
```

| Scope | 文件位置 | 写入方式 | 用户可控 |
|-------|---------|---------|---------|
| `enterprise` | `managed-mcp.json`（IT 部署） | 系统管理员 | 否 |
| `project` | `.mcp.json`（项目根，可多层向上） | 团队共享，git 提交 | 项目成员 |
| `local` | `.claude/settings.local.json` | gitignored，本地 | 项目成员 |
| `user` | `~/.claude/settings.json` | 个人全局 | 用户 |
| `plugin` | `${pluginDir}/.../mcp.json` | plugin 提供 | plugin 启用状态 |
| `claudeai` | 远程 fetched | Claude.ai 网页 UI | 用户 |

**优先级含义**：enterprise 配置优先级最高，用户的 personal 配置无法覆盖 IT 部署的托管策略。这种设计让企业可以在不解雇员工的情况下，强制禁用某些高风险 MCP server——这是企业部署的硬需求：IT 必须有能力锁定"不允许连外部某 MCP server"，而不管员工在自己 `~/.claude` 里写了什么。把 enterprise 放在最高优先级就是这个意图的直接体现。

#### 连接状态分类

除了 transport 和配置来源，每个 server 在运行时还处于 5 种状态之一（`src/services/mcp/types.ts`）：`connected` / `failed` / `needs-auth` / `pending` / `disabled`。这条分类决定了 `/mcp` 面板怎么显示、Agent 能不能调用、要不要触发重连——它是运行时观察 server 的统一视角。

### 三.4 注册机制：外部工具如何变成 Agent 工具

有了协议、传输、配置，最后一个宏观问题是——MCP server 暴露的工具，是怎么"变成"Agent 眼中和 Read/Write 一样的工具的？这就是注册机制。本节看它的设计骨架，具体执行流程在 §四.4 展开。

#### 命名空间：`mcp__<server>__<tool>`

标准模式：`buildMcpToolName(serverName, toolName) → "mcp__github__create_issue"`（在 `mcpStringUtils.ts`）。

为什么要命名空间？设想两个 MCP server 都叫自己 `search`——一个搜代码、一个搜文档。扁平命名会撞车，Agent 根本分不清该调谁。`mcp__<server>__<tool>` 把 server 名当命名空间，既消除冲突，又让权限规则可以按 server 粒度控制（`mcp__github__*` 一刀切允许/拒绝整个 GitHub server 的工具）。

SDK 前缀可关闭：环境变量 `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1` 让 MCP 工具用裸名（如 `create_issue`），允许覆盖内置工具名（`client.ts:1773-1786`）。这是给 SDK 嵌入场景的逃生口——当 Claude Code 作为 SDK 被嵌入到另一个宿主里，宿主可能希望 MCP 工具直接暴露裸名以保持调用方兼容。

#### Schema 注入到 System Prompt

MCP 工具 Schema 作为 System Prompt 的一部分注入，与其他内置工具的 Schema 并列。**Description 长度上限** `MAX_MCP_DESCRIPTION_LENGTH = 2048`（`packages/mcp-client/src/connection.ts:19`，经 `PKG_MAX_MCP_DESCRIPTION_LENGTH` 导出）。OpenAPI-生成的 MCP server 常见 15-60KB 描述，超过 2048 字符会被截断并加 `… [truncated]` 后缀（`client.ts:1796-1806`）。

为什么是 2048？system prompt 是上下文窗口的一部分，按 token 计费且影响注意力质量。如果 10 个 MCP tools 每个描述 50KB，光工具定义就占 500KB——上下文空间会被快速耗尽，用户真正的对话空间被挤压。2048 字符是一个经验阈值：足够描述一个工具"做什么、怎么传参"，又不会让单个工具淹没 system prompt。这个数字背后是"工具可发现性"与"上下文经济性"的权衡。

#### 元数据：`alwaysLoad` 与 `searchHint`

MCP server 不止返回 schema，还能在 `_meta` 和 `annotations` 里附带元数据影响 Claude Code 内部决策：

| Annotation | 对应 Tool interface 方法 | 决策 |
|-----------|----------------------|------|
| `readOnlyHint: true` | `isReadOnly()` | 跳过权限确认、自动安全 |
| `destructiveHint: true` | `isDestructive()` | 需要更严格的权限策略 |
| `openWorldHint: true` | `isOpenWorld()` | 影响上下文折叠和分类（classifyForCollapse） |
| `title: "My Tool"` | `userFacingName()` | UI 显示给用户 |

**为什么不信任服务端分类？** 服务端的 `readOnlyHint` 是 server 自报的——server 可能有 bug，也可能恶意把 `delete_file` 标成 readOnly。Agent 不能完全依赖这个 hint 做安全决策，但可以作为初始 hint 辅助。真正的安全兜底是用户配置的权限规则。这是一个"信任边界"问题：协议层默认不信任 server 的自我声明，把最终裁决权留给用户配置的权限规则。

除了 annotations，`_meta` 里两个 Anthropic 私有字段控制加载策略：
- **`_meta.anthropic/alwaysLoad: true`**：让该工具绕过延迟加载，始终出现在 system prompt 中。适用场景：每次会话必用的高频工具——比如某个团队内部的 `search-wiki` 工具，Agent 不该等用户触发语义搜索才"发现"它。
- **`_meta.anthropic/searchHint`**：供 `SearchExtraToolsTool` 的 TF-IDF 索引使用。延迟加载的 MCP 工具默认不在 system prompt 里，Agent 看不到；`searchHint` 让用户用自然语言搜索时更容易命中它们——相当于给工具加了一组"关键词"。

#### 推送式刷新

注册不是一次性的——server 工具列表可能变（server 重启、热更新）。MCP 用 `notifications/tools/list_changed` 让 server 主动推送变化，client 收到后刷新列表（实现细节见 §四.7）。这种"服务端推送"比客户端轮询高效得多：server 知道什么时候变了，主动通知而不是等 client 每隔 N 秒来问，既省请求又低延迟。

### 三.5 对外接口：tools / resources / prompts / skills / channels

注册机制解决了"工具"的接入。但 MCP 还暴露了其他几类能力，它们各自对应 Claude Code 的不同入口。本节把 5 类对外接口放在一起对比，看清 MCP server 到底能向 Claude Code 提供"什么"。

#### Tools（主路径）

最核心的能力。`tools/list` 发现工具，`tools/call` 执行工具。返回的工具经 §三.4 注册机制变成 Agent 工具，是 MCP 最常用的接口——绝大多数 MCP server 只实现 tools。

#### Resources（只读 URI 寻址内容）

- `resources/list` → 发现资源 URI + metadata
- `resources/read` → 读取 URI 内容（可能返回 text 或 blob）
- 提供给用户的工具：`ListMcpResourcesTool`、`ReadMcpResourceTool`（`client.ts:2197-2202`）—— 只在第一个有资源能力的 server 上添加，避免重复

Resources 和 Tools 的区别在于"谁主动"：Tool 是 Agent 主动调用的函数，Resource 是 Agent 按需读取的数据源。比如一个 MCP server 暴露 `file://project/README.md` 作为 resource，Agent 可以读它但不能"调用"它。适合"提供上下文"而非"执行动作"的场景。

#### Prompts（可复用 prompt 模板）

- `prompts/list` → 发现 prompt 列表
- `prompts/get` → 取渲染后的 prompt（带 arguments）
- 映射为 `Command` 类型，前缀 `mcp__<server>__<prompt_name>`（`client.ts:2066-2108`）
- 用户通过 `/<prompt-name>` 调用

Prompt 是 server 预设的"对话模板"。比如一个客服 MCP server 可以暴露 `triage-bug` prompt，用户输入 `/triage-bug` 就把模板注入对话。这让 server 不仅能提供工具和数据，还能提供"用法"——把领域最佳实践打包成可复用的起手式。

#### Skills

`MCP_SKILLS` feature flag 启用——从 `skill://` URI 的 resources 中提取 skill 描述（实现：`src/skills/mcpSkills.ts`）。允许 MCP server 暴露 Claude Code 的 Skill（可复用 prompt 模板）。Skills 本质上是 Resources 的特化：用 `skill://` 这个特殊 URI scheme 标记"这是一个 Skill 而非普通 resource"，Claude Code 据此走 skill 的加载路径。

#### Channels（实验性）

`KAIROS` feature 启用。Channel 允许 server **主动推送消息到当前会话**：

- 注册：`notifications/claude/channel` handler（`useManageMCPConnections.ts:506-531`）
- Server 通过 capability `experimental.claude/channel` 声明启用
- 推送的消息经 `wrapChannelMessage` 包装并 `enqueue` 到 prompt 队列（优先级 next，isMeta=true）
- 权限回复：另一个 capability `claude/channel/permission`，用作 server-to-CC 双向权限握手

`gateChannelServer`（`channelNotification.ts`）按能力+会话+策略决定是否注册 handler。

Channels 打破了 MCP 的"请求-响应"模型——它让 server 能在没人调用它的时候往会话里塞消息。这是为长任务监控等场景设计的实验性能力：比如一个 server 在后台跑构建，跑完主动推一条"构建完成"进会话。正因为它打破了基本模型，所以用 `KAIROS` feature flag 和 `experimental` capability 双重门控，谨慎启用。

> 宏观样貌到此完整——协议、传输、配置、注册、接口五个侧面拼出了 MCP 的全貌。但"知道长什么样"和"知道怎么跑起来"是两回事。第四章沿一次连接的生命周期，深入运行时细节。

---

## 四、深入核心运行时细节（沿生命周期）

第三章给出了 MCP 的静态全景。本章换一个视角——跟着一次 MCP 连接从配置到调用再到断连重连的完整生命周期，看每个机制在运行时具体怎么跑。每个机制按"**为什么需要 → 怎么做 → 具体实例**"三段式展开，与前一章的静态描述互补：第三章讲"设计成什么样"，本章讲"运行时怎么一步步发生"。

### 四.1 配置加载与合并

**为什么需要**：MCP server 的配置散落在 6 个来源（见 §三.3），不同环境（开发/生产/企业）需要不同 server，且企业 IT 必须能强制覆盖个人配置。启动时必须把这些来源按优先级合并、按策略过滤，得到最终要连接的 server 列表——这是整条链路的起点，没有它后面无从连起。

**怎么做**：`useManageMCPConnections.ts` 这个 React Hook 编排整个加载流程，调用链如下：

```
useManageMCPConnections.ts (React Hook)
  │
  ├─► 1. 加载配置源
  │     ├─► 项目级 .mcp.json（递归遍历到 git root）
  │     ├─► 用户级 ~/.claude/settings.json mcpServers
  │     ├─► 本地 .claude/settings.local.json mcpServers
  │     ├─► Enterprise 托管策略（若有则独占）
  │     ├─► Claude.ai 远程 connector（动态 fetched）
  │     └─► Plugin 提供（按 marketplace 加载）
  │
  ├─► 2. 应用企业策略过滤
  │     ├─► 允许名单 allowedMcpServers
  │     ├─► 拒绝名单 deniedMcpServers
  │     └─► 签名去重 plugin / claudeai vs manual
```

合并后按 `enterprise > project > local > user > plugin > claudeai` 优先级取舍。配置格式上，每个 server 声明自己的 transport 和参数：

```json
// .mcp.json
{
  "mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "postgres": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer ${API_KEY}" }
    },
    "remote-stateful": {
      "transport": "http",
      "url": "https://mcp.example.com/http",
      "headers": { "X-Tenant": "tenant-a" }
    },
    "oauth-server": {
      "transport": "sse",
      "url": "https://oauth.example.com/sse",
      "oauth": {
        "clientId": "...",
        "callbackPort": 8080,
        "authServerMetadataUrl": "https://auth.example.com/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

环境变量展开由 `envExpansion.ts` 在解析时完成，支持 `${VAR}` 和 `${VAR:-default}` 语法。一个反直觉的设计是：**未定义的变量不会让 server 启动失败**——它们被空字符串替换，并向用户报告警告：

```bash
# ~/.bashrc
export GITHUB_TOKEN="ghp_xxxxx"

# .mcp.json
{ "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" } }
# 启动 MCP server 时 GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxxx
```

为什么不直接报错？MCP server 配置可能在不同环境下使用：开发环境有 token，生产环境用 IAM 角色；CLI 启动时无法判断变量缺失是"配置错误"还是"正常情况"（比如生产用 IAM 角色注入而不是 env var）。展开为空 + 警告让 server 启动后自己报错，比 CLI 提前 fail 更准确——这是把"语义判断"推迟到真正知道上下文的层。

添加/删除 server 走 `addMcpConfig` / `removeMcpConfig`（`config.ts:625-834`）：通过 Zod `McpServerConfigSchema` 验证、拒绝非允许名单条目（除非 `allowManagedMcpServersOnly` 设置）、用 atomic write（temp file → fsync → rename，保留权限位）写入，持久化到 `saveCurrentProjectConfig`（user scope）或 `.mcp.json`（project scope）。`/login` 与 `/logout` 触发的 auth 状态变更则通过 `appState.authVersion` 推动 `useManageMCPConnections` 重新连接（`useManageMCPConnections.ts:1010-1018`），登录后缓存的 `needs-auth` server 会自动重新尝试 OAuth 流程。

> 配置就绪后，下一步是把声明的 server 真正连上——这是连接建立阶段。

### 四.2 连接建立

**为什么需要**：配置层只给出了"要连谁"，但连接本身是昂贵的（stdio 要 fork 子进程、HTTP 要握手、远程还要 OAuth）。N 个 server 必须在启动时一次性连上，又不能因为一个慢 server 拖垮全部——这就需要批处理、并发控制，以及针对不同 transport 的连接细节处理。

**怎么做**：`connectToServer`（`client.ts:596-1653`）是连接工厂，用 `memoize` 缓存（同 name + 同 config 复用同一 transport/client 实例）。核心逻辑分四步：

```typescript
// src/services/mcp/client.ts:596-1653 — connectToServer (简化)
export const connectToServer = memoize(async (
  name: string,
  serverRef: McpServerConfig,
  serverStats?,
) => {
  // 1. 根据 transport 类型创建传输层
  let transport;
  switch (serverRef.transport) {
    case 'stdio':
      transport = new StdioClientTransport({...});
      break;
    case 'sse':
      transport = new SSEClientTransport(new URL(serverRef.url), {...});
      break;
    case 'http':
      transport = new StreamableHTTPClientTransport(new URL(serverRef.url), {...});
      break;
    case 'ws':
      transport = new WebSocketTransport(wsClient);
      break;
    // ... 其他传输类型
  }

  // 2. 创建 MCP client 并连接
  const client = new Client({ name, version: MACRO.VERSION }, {...});
  await client.connect(transport);   // client.ts:1059

  // 3. 读取 server 信息
  const capabilities = client.getServerCapabilities();
  const serverVersion = client.getServerVersion();
  const instructions = client.getInstructions();

  // 4. 设置错误和断连处理
  transport.onerror = (error) => { /* 标记 failed */ };
  transport.onclose = () => { /* 触发重连 */ };

  return { client, transport, capabilities, serverVersion, instructions };
});
```

连接建立后立即交换 `initialize` / `initialized` 握手（§三.2 已述其必要性），拿到 capabilities 后客户端就知道后续可以调哪些方法。

批处理与并发由 `getMcpToolsCommandsAndResources`（`client.ts:2238+`）控制，它把 servers 拆成两类分别限流：

| 类别 | 何时更多并发 | 代码 |
|------|--------|------|
| 本地 (`stdio`/`sdk`) | 最多 3 个（`MCP_SERVER_CONNECTION_BATCH_SIZE`） | `client.ts:553-555` |
| 远程 (`sse`/`http`/`ws`/`claudeai-proxy`) | 最多 20 个（`MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE`） | `client.ts:557-562` |

为什么本地 3、远程 20？这两类连接的成本结构完全不同：stdio 启动子进程需要 fork/exec，是 CPU/IO 密集型操作，3 个并发已经能占满本地资源，再多反而互相争抢；HTTP 连接则是网络 IO，大部分时间在等远端响应，CPU 几乎空闲，20 个并发才能有效利用。分开限流避免一个慢 stdio 阻塞一堆 HTTP 重连。`pMap` 替代过去的固定批次实现（`client.ts:2230`），空闲 slot 立即接管下一个完成项——比"等整批完成再开下一批"省时。

**具体实例——各 transport 的连接细节**：

**stdio（本地子进程）** 是最常见的本地 transport，通过 `StdioClientTransport` 启动子进程（`client.ts:959-967`），stdin/stdout 通信。每个 MCP server 是独立进程——崩溃不影响其他 server。关键实现细节（`client.ts:977-994`）：
- **stderr 捕获**：stdio transport 把 child stderr 导入 `pipe` 而非继承父进程，避免污染 UI。stderr 输出有 64KB 上限防止内存膨胀——这个上限是防"恶意/buggy server 往 stderr 狂写日志撑爆内存"的兜底，正常 server 远用不到。
- **CLT/Shell 前缀**：`CLAUDE_CODE_SHELL_PREFIX` 环境变量可以在 child 命令前注入 shell（例如在容器里把 `npx` 重定向到特定二进制）。
- **环境变量合并**：child env = `subprocessEnv()` × `config.env`——后者覆盖前者。

清理 stdio 子进程时使用三段式信号升级（`client.ts:1447-1573`），避免强制 kill 阻塞 CLI：

```
   T=0ms  发送 SIGINT（Ctrl+C 风格，最优雅）
   │
   ├─ 100ms 后检查 process.kill(pid, 0) — 进程还在？
   │      └─ 是 → 发送 SIGTERM（标准终止，给清理代码时间）
   │             │
   │             ├─ 400ms 后检查 — 进程还在？
   │             │      └─ 是 → 发送 SIGKILL（无法拦截）
   │             │
   │             └─ 否 → 已退出
   │
   ├─ 50ms 轮询检查进程是否存在
   │
   └─ 600ms failsafe，无论如何 resolve
```

为什么要三段式而不是直接 SIGKILL？不同信号给进程的"清理窗口"不同：SIGINT 最礼貌，让进程自己收尾（flush 日志、关连接）；SIGTERM 是标准终止，给清理代码一点时间；SIGKILL 无法拦截，进程立刻消失，可能留下半写的文件或泄漏的连接。逐级升级既给优雅退出留了机会，又用 600ms failsafe 保证 CLI 绝不卡顿——总清理时间 ≤ 500ms 是"对用户响应时间负责"的硬约束。

**sse（HTTP Server-Sent Events）** 用 `SSEClientTransport` + Anthropic 自定义 `ClaudeAuthProvider`。这里有一个关键的"超时不对称"设计：`eventSourceInit.fetch` 必须不应用 60s 超时（`client.ts:644-672`）——SSE 长连接靠它保持活动，60s 超时会杀死它；POST 请求的 `fetch` 路径则使用 `wrapFetchWithTimeout` 设置独立每请求超时（`client.ts:633-635`、`wrapFetchWithTimeout` 在 `client.ts:493-551`），避免 `AbortSignal.timeout()` 过期后挂在 stale 信号上。一句话：GET 流不能超时（要一直活着收推送），POST 请求要超时（防单请求挂死）。把这两条规则搞反就会要么断流、要么卡死。

**http（Streamable HTTP）** 是 MCP 规范的正式 HTTP 传输。客户端发请求到 `POST <url>`，server 可以用 JSON 一次性响应或 SSE 流式响应（在同一连接上）。关键限制（`client.ts:469-470`、`MCP_STREAMABLE_HTTP_ACCEPT`）：客户端必须在每个 POST 请求上声明 `Accept: application/json, text/event-stream`，否则严格遵循规范的服务端会返回 406 Not Acceptable。`wrapFetchWithTimeout`（`client.ts:493-551`）兜底保证这个 header——SDK 内部 header 处理在某些运行时会丢失，需要在最后一层 `fetch` 包装中重新注入。HTTP transport 还支持 **session ID**——server 给出 `Mcp-Session-Id` header，客户端在后续请求中回传；当 server 返回 `404 + JSON-RPC code -32001`（"Session not found"）时触发 session 过期，客户端关闭 transport，下次 `callTool` 重新连接（`client.ts:1324-1340`、`isMcpSessionExpiredError` 检测逻辑）。

**claudeai-proxy（CCR 代理）** 承载的是"用户在 claude.ai 网页配置的 connector 经 Anthropic CCR 代理转发"这条特殊链路：

```
Claude Code CLI → claudeai-proxy transport → Anthropic CCR → 真实 MCP server
```

CLI 这侧拿到的是 proxy URL（标记了 server ID）+ claude.ai OAuth token。所有发往 connector 的请求都带 `X-Mcp-Client-Session-Id` 标识当前会话。`createClaudeAiProxyFetch`（`client.ts:373-423`）包装 fetch：自动附加 `Authorization: Bearer <oauth-token>`、401 时调 `handleOAuth401Error`（强制刷新 token）、且只有 token 实际变了才重试（避免对真正 401 的 connector 双倍往返）。

> 远程 transport 连上后，下一步往往是认证——这就是 OAuth 流程。

### 四.3 OAuth 认证（远程 transport）

**为什么需要**：仅 `sse` 和 `http` transport 支持 OAuth（`ws`、`stdio`、`claudeai-proxy` 各自带不同认证机制，不需要走这条路径）。远程 MCP server 保护的是用户在其他服务（GitHub、Slack、内部系统）的数据，必须确认调用者身份。Claude Code 作为 CLI 是公共 client（无法安全存储 client_secret），所以走 PKCE；企业 SSO 场景还需要 XAA 共享登录态。这一节是整条链路里最复杂的一段，偏运维场景，可按需选读。

**怎么做**：OAuth 由 `src/services/mcp/auth.ts` 实现，涉及四个角色——Resource Server 是 MCP server 本身、Authorization Server 是 IdP（Okta/Auth0/Slack 等）、Client 是 Claude Code（公共 client，无 client_secret）、Resource Owner 是终端用户。

流程从 Discovery 开始，经过客户端注册、Authorization Code + PKCE、Token 存储与刷新，再加上 Step-up 和 XAA 两个增强。

**具体实例**：

**Discovery（RFC 9728 → RFC 8414 链）**：`auth.ts:256-311` 先探测 `/.well-known/oauth-protected-resource`（PRM）找到 `authorization_servers[0]`，再对该 URL 执行 RFC 8414 discovery 得到 issuer、token_endpoint、authorization_endpoint 等。Fallback 是 path-aware retry（`auth.ts:304-310`）。用户也可通过 `oauth.authServerMetadataUrl` 直接指定 metadata URL（必须是 HTTPS，Zod 强制）——这是给"已知 IdP 配置"场景的捷径，跳过自动 discovery。

**客户端注册（CIMD 优先、DCR 兜底）**：两种模式：
1. **CIMD（Client ID Metadata Document, SEP-991）**：如果 AS 声明 `client_id_metadata_document_supported: true`，Claude Code 用 `MCP_CLIENT_METADATA_URL` 作为 `client_id`，无需注册。
2. **DCR（Dynamic Client Registration）**：否则走 RFC 7591 DCR——Claude Code 提供 metadata URL 描述自己的 client，AS 返回 client_id。

如果用户在 `.mcp.json` 中预设了 `oauth.clientId`，则直接使用预配置的 client（`ClaudeAuthProvider.clientInformation()`, `auth.ts:1482-1511`）。为什么 CIMD 优先？因为 DCR 要一次额外往返（注册请求 → 拿 client_id），CIMD 让 server 直接告诉你 client_id，省掉这次往返——只有 AS 不支持时才走标准 DCR。

**Authorization Code + PKCE**：

```
1. 启动本地 HTTP server (随机端口 via oauthPort.ts)
2. 生成 PKCE: code_verifier = random(64) 
             code_challenge = SHA256(code_verifier) base64url
3. 生成 state: random(32) base64url
4. 打开浏览器 → https://as/authorize?...
                 response_type=code
                 client_id=<cimd or dcr>
                 redirect_uri=http://127.0.0.1:<port>/callback
                 state=<state>
                 code_challenge=<challenge>
                 code_challenge_method=S256
5. 用户授权 → AS 重定向到 redirect_uri?code=<auth_code>&state=<state>
6. 本地 server 收到 → POST https://as/token
                          grant_type=authorization_code
                          code=<auth_code>
                          code_verifier=<original>
7. 拿到 access_token (+ refresh_token) → 存入 secureStorage
```

完整实现：`auth.ts:847-1342`，回调 server 在 `auth.ts:1099-1151`，浏览器打开通过 `openBrowser()`。PKCE 的意义在于"无 secret 也能防授权码拦截"：客户端先存 `code_verifier`、把它的哈希 `code_challenge` 发给 AS；换 token 时再出示原 `code_verifier`，AS 验证哈希匹配。即使攻击者拦截了授权码，没有 `code_verifier` 也换不到 token。这让 Claude Code 作为公共 client 无需储存 `client_secret`，安全边界最小。

**Token 存储与刷新**：通过 `ClaudeAuthProvider`（`auth.ts:1376-2360`）管理。
- **存**：macOS Keychain、Linux libsecret/encrypted JSON、Windows DPAPI。`serverKey = sha256(serverName|configJson).slice(0,16)` 作为 key（`auth.ts:325-341`）。
- **取**：`tokens()`（`auth.ts:1540-1702`）检查 XAA 静默刷新；如果 access_token 5 分钟内过期 + 有 refresh_token → 主动刷新；如果有 step-up pending → 不返回 refresh_token，强制走 PKCE。
- **存**：`saveTokens()` 写入 secureStorage。

为什么是"5 分钟内过期就主动刷新"而不是"过期了再刷新"？这是延迟与可靠性的权衡：等到真正过期再刷，请求会因 401 失败、触发刷新、再重试——多一次失败往返，用户感知到卡顿。提前 5 分钟刷，把刷新成本隐藏在正常请求之间，用户无感。5 分钟这个阈值留出了"刷新请求本身耗时 + 网络抖动"的余量。

**Token 刷新（OAuth Refresh）**：`refreshAuthorization`（`auth.ts:2090-2175`）：
1. 获取 file lock（`mcp-refresh-<sanitizedKey>.lock`，重试 5 次）—— 防止多 CC 实例同时刷新
2. 重新读 keychain（强制 `clearKeychainCache()`）—— 别人可能已经刷了
3. 如果 expiry > 5 分钟 → 用别人的 token（避免浪费请求）
4. 否则调 `_doRefresh(refreshToken)`（`auth.ts:2177-2359`）：最多 3 次重试，1s/2s/4s 退避；用 RFC 6749 `grant_type=refresh_token`；`InvalidGrantError` → 清掉 stored tokens，标记 needs-auth；`TimeoutError` / `ServerError` / `TemporarilyUnavailableError` / `TooManyRequestsError` → 重试；其他错误 → 不重试，直接返回 undefined。

file lock 这一步值得注意：用户可能同时开多个 Claude Code 实例，它们共享同一个 keychain。如果不加锁，多个实例会同时发现 token 快过期、同时发刷新请求——既浪费请求，又可能因 IdP 的 refresh token 轮换策略互相踩踏（一个刷成功让另一个的 refresh token 失效）。file lock + 拿锁后重读 keychain，让"后到的实例"直接复用"先到的实例"刷好的 token。

**Step-up Auth（403 insufficient_scope）**：当服务端发现 access_token scope 不够时返回 `403 + WWW-Authenticate: scope="..."`：

```
401/403 → 拦截器捕获 → 检查 WWW-Authenticate header
                     → 提取 scope → markStepUpPending(scope)
                     → tokens() 调用时发现 step-up pending
                     → 故意省略 refresh_token → SDK 跳过 refresh 路径
                     → 触发新的 PKCE 流程获取高 scope token
```

`wrapFetchWithStepUpDetection`（`auth.ts:1354-1374`）是拦截器，`markStepUpPending`（`auth.ts:1468-1471`）是 flag setter。为什么 step-up 必须走新的 PKCE 而不能用 refresh？因为 RFC 6749 §6 禁止 scope elevation via refresh——refresh 一律返回原 scope，这是 OAuth 的安全约束（防止 client 借 refresh 悄悄提权）。所以提权必须走新的 consent 流程，让用户重新授权。

**XAA（Cross-App Access, SEP-990）**：企业 SSO 场景。IdP 一次登录，所有 XAA-enabled MCP server 共享：

```
settings.xaaIdp 配置一次 IdP 连接 → 多次用于多个 MCP server
       ↓
每个 XAA server 只配置 oauth.xaa: true + 各自的 AS clientId/clientSecret
       ↓
首次访问某 XAA server:
  1. 弹浏览器 → IdP login → 拿到 id_token（cache）
  2. 无浏览器调用 RFC 8693 token-exchange (id_token → AS access_token)
  3. 存 token 到与 normal OAuth 同一 slot
       ↓
后续访问（同进程或跨进程，id_token 缓存有效期内）:
  → xaaRefresh() 静默刷新（无浏览器）
  → 4-request XAA chain 失败 → 清 id_token → 下次需要浏览器
```

实现：`xaaIdpLogin.ts`、`xaa.ts`、`auth.ts:1751-1850`。XAA 解决的是"企业里 N 个 MCP server 都要 SSO 登录，难道让用户登 N 次"的问题：一次 IdP 登录拿 id_token，之后每个 server 用 RFC 8693 token-exchange 把 id_token 换成自己的 access_token，全程无浏览器。这把"登录次数"从 O(N) 降到 O(1)。

**OAuth Token Revocation**：登出或清除授权时（`revokeServerTokens`，`auth.ts:467-618`）：查 metadata 拿 `revocation_endpoint`；先 revoke refresh_token（更重要，阻止产生新 access_token）；再 revoke access_token；按 RFC 7009 先用 `client_id` in body，无 Authorization header，401 时 fallback 为 Bearer auth；最后清 local storage。先 revoke refresh 再 revoke access 的顺序很关键——反过来会让"已 revoke 的 access 还能用 refresh 续命"。

**Dynamic Client 信息交换**：Server 401/403 → SDK 调 `auth()` → try refreshing token → 401 → unauthorized；`authInternal()` → clientInformation undefined → 注册新 client via DCR → 自动 retry with new client → `saveClientInformation(clientId, clientSecret)` → `saveTokens(access_token, refresh_token)`。完整状态机：`auth.ts` 整体 + `@modelcontextprotocol/sdk/client/auth.js`。

> 认证完成后，连接就绪——下一步是发现 server 暴露了哪些工具并注册到 Agent。

### 四.4 工具发现与注册

**为什么需要**：连接建立只意味着"能通信"，但 Agent 还不知道这个 server 提供哪些工具、每个工具怎么调。必须主动发 `tools/list` 拉取工具描述，再把它翻译成 Agent 内部的 Tool interface 实例。这是 MCP 实现中最关键的一步——它把"外部服务的能力"无缝接入了 Agent 的工具调用流程，也是 §三.4 注册机制的运行时落地。

**怎么做**：发现分三路并行——`fetchToolsForClient`（`client.ts:1755`）发 `tools/list`、`fetchResourcesForClient`（`client.ts:2012`）发 `resources/list`、`fetchCommandsForClient`（`client.ts:2045`）发 `prompts/list`。三者都套了 LRU 缓存（§四.7 详述），避免重复请求。

```
└─► 4. 获取工具/资源/prompts 列表
      ├─► fetchToolsForClient(client) — client.ts:1755
      │     └─► client.request({method: 'tools/list'})
      ├─► fetchResourcesForClient(client) — client.ts:2012
      └─► fetchCommandsForClient(client) — client.ts:2045 (prompts)

└─► 5. 注册 list_changed 通知处理器
      ├─► ToolListChangedNotification → 刷新工具列表
      ├─► PromptListChangedNotification → 刷新 prompt 列表
      └─► ResourceListChangedNotification → 刷新资源列表

└─► 6. 注入工具到全局工具池
      └─► 通过 onConnectionAttempt 回调批量更新 AppState
```

**具体实例——tools/list 到 Agent 工具的映射**：

```
MCP Server 返回:
{
  "name": "create_issue",
  "description": "Create a GitHub issue",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": { "type": "string" },
      "body": { "type": "string" },
      "labels": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["title"]
  },
  "annotations": {
    "title": "Create Issue",
    "readOnlyHint": false,
    "destructiveHint": false,
    "openWorldHint": true
  },
  "_meta": {
    "anthropic/searchHint": "create GitHub issue with labels",
    "anthropic/alwaysLoad": false
  }
}

  ↓ 自动映射（fetchToolsForClient, client.ts:1778-2002）

Agent 工具:
{
  name: "mcp__github__create_issue",
  description: ...,
  inputJSONSchema: {...},
  isMcp: true,
  mcpInfo: { serverName: "github", toolName: "create_issue" },
  isReadOnly: () => tool.annotations?.readOnlyHint ?? false,
  isDestructive: () => tool.annotations?.destructiveHint ?? false,
  isOpenWorld: () => tool.annotations?.openWorldHint ?? false,
  alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
  searchHint: ...,  // 用于延迟工具语义搜索
  // ... + 完整 call() 实现调用 callMcpTool
}
```

这个映射的本质是：MCP 协议的 `tools/list` 返回的是"协议层描述"（纯 JSON），而 Agent 需要的是"内部 Tool interface 实例"（带 `call()` 方法、能被权限系统检查、能注入 system prompt）。`fetchToolsForClient` 在两者之间做翻译——给纯 JSON 描述"装上"方法和元数据访问器，让它真正可调用。

关于白名单：`src/constants/tools.ts` 的 `CORE_TOOLS` 是延迟加载白名单（控制哪些工具可被 `SearchExtraToolsTool` 语义检索）。**MCP 工具不走这条白名单**——它们有自己的发现路径（`fetchMcpSkillsForClient`、`searchExtraTools` 中的 MCP 索引分支）。MCP 工具在 Agent 中即时可用（如果非白名单）或延迟加载（如果是白名单匹配的 MCP 工具名）。这是合理的分流：内置工具的白名单逻辑是为"控制上下文体积"设计的，MCP 工具有自己的 `alwaysLoad` / `searchHint` 元数据机制（§三.4），不需要再叠一层内置白名单。

Description 截断已在前文提到（`MAX_MCP_DESCRIPTION_LENGTH = 2048`，`client.ts:1796-1806`），其权衡见 §三.4。

> 工具注册完毕，Agent 就能看见并调用它们——下一步看一次 `tool_use` 实际怎么执行。

### 四.5 工具调用执行

**为什么需要**：注册只是让 Agent "看见"工具，真正执行还要把 Agent 发出的 `tool_use` 转成 JSON-RPC `tools/call`、送到 server、拿回结果、处理中途可能出现的 session 过期。这一步是 MCP 价值的最终兑现点——前面所有机制都是为了让这一步"像调用内置工具一样简单"。

**怎么做**：Agent 调用 MCP 工具时，Tool interface 的 `call()` 实现内部走 `callMcpTool`，后者向 server 发 `tools/call` 请求，参数按 `inputSchema` 校验，返回 `{content, isError}`。如果 server 返回 `isError: true`，Agent 能看到错误并据此调整后续行为。

远程 transport（尤其 http）在调用时还要处理 session 过期：当 server 返回 `404 + JSON-RPC code -32001`（"Session not found"），说明 server 端的 session 已失效（可能是 server 重启、负载均衡换节点、session 超时）。`isMcpSessionExpiredError`（`client.ts:1324-1340`）检测到这个错误后，关闭当前 transport，让下一次 `callTool` 触发重新连接拿新 session ID——对调用方完全透明。

**具体实例**：

```
Agent 决定调用 mcp__github__create_issue
  │
  ▼
Tool.call(input) → callMcpTool({serverName, toolName, input})
  │
  ▼
client.request({method: 'tools/call', params: {name: 'create_issue', arguments: input}})
  │
  ├─ 正常 → 返回 {content: [...], isError: false} → 注入 tool_result
  │
  └─ session 过期 (404 + -32001)
        → 关闭 transport
        → 下次 callTool 重新 connectToServer → 拿新 Mcp-Session-Id
        → 重试本次调用
```

注意 session 过期处理是"懒重连"——不是后台定时探测 session 是否活着，而是等真正调用失败时才重连。这避免了无谓的保活请求，代价是首次失败会有一点延迟。对低频调用的 MCP 工具这是合理取舍。

> 调用正常时一切顺畅，但远程连接总有断的时候——下一步看断连后如何自动恢复。

### 四.6 断连与重连

**为什么需要**：远程 MCP 连接可能因网络抖动、server 崩溃、proxy 重启等原因断开。如果不能自动恢复，用户就得手动重启 CLI——这对长会话是不可接受的。Claude Code 在所有远程 transport 上启用自动重连，stdio 不重连（进程死了靠子进程自然退出）。本节偏运维可靠性，可按需选读。

**怎么做**：`client.ts:1227-1413` 安装的 error/close 处理器在三类情况下触发重连：

1. **session 过期**（HTTP only）：`404 + JSON-RPC code -32001` → 关闭 transport，下次调用重新连接拿新 session ID
2. **SSE 重连耗尽**：`Maximum reconnection attempts` 错误 → 关闭 transport
3. **连续 3 次 terminal error**：连续三次 `ECONNRESET` / `ETIMEDOUT` / `EPIPE` / `EHOSTUNREACH` / `ECONNREFUSED` / `Body Timeout Error` / `SSE stream disconnected` / `Failed to reconnect SSE stream` → 关闭 transport

为什么是"连续 3 次"才触发重连？单次网络抖动很常见（丢包、瞬时 DNS 失败），SDK 内部通常已自动重试一次；如果连续 3 次都失败，基本可以判定连接确实断了（不是偶发），这时候才值得走更重的"关闭 transport + 指数退避重连"流程。阈值太小会把偶发抖动误判为断连、频繁重连；阈值太大又会让真断连的恢复变慢。3 次是工程经验值。

重连实现在 `useManageMCPConnections.ts:331-468`：

```
onclose 事件:
  │
  ├─► 清理 memoize cache（connectToServer + fetchTools/Resources/Commands）
  ├─► isMcpServerDisabled(name)? → 跳过重连
  ├─► config.type 是 stdio/sdk? → 标记 failed（不重连）
  └─► 远程 transport?
        └─► 指数退避重试（最多 5 次）：
              attempt 1 → wait 1s
              attempt 2 → wait 2s
              attempt 3 → wait 4s
              attempt 4 → wait 8s
              attempt 5 → wait 16s（最大 30s）
              │
              ├─► 重连成功 → 重新获取 tools/commands/resources
              └─► 重连失败 → 标记 server 为 'failed'
```

为什么是 5 次、指数退避、最大 30s？这套参数覆盖的是"临时性故障"——网络抖动几秒到几十秒、server 重启、proxy 短暂过载。指数退避（1→2→4→8→16s）既给故障恢复留出越来越长的窗口，又避免在故障持续期间穷举式重连压垮 server。5 次之后总等待约 31s，若仍失败基本可判定是"持久性故障"（server 下线、配置错误），此时应停止重连、标记 failed、把问题暴露给用户人工介入——而不是无限重连浪费资源。

**具体实例——失败降级**：超过最大重连次数后（默认 5 次），server 标记为 `Failed`。Agent 仍能在工具列表中看到它但无法调用——这种"可见但不可用"的设计是有意的：让 Agent 知道"这个工具存在但当前挂了"，可以在回答里告诉用户"GitHub MCP server 当前不可用"，而不是假装工具不存在。`/mcp` 命令面板显示该 server 的状态，用户可以手动重试或排查。

> 重连解决了"断开后恢复"，但运行中还有两类问题：工具列表会变、连接不能重复建——下一步看动态更新与性能优化。

### 四.7 动态更新与性能优化

**为什么需要**：连接建好后，运行时还有两个持续性问题。一是 server 的工具列表可能变化（server 重启后工具集变了、热加载新工具），Agent 必须跟上。二是 MCP 连接是昂贵的（子进程启动、HTTP 握手、OAuth 流程），不能每次调用都重建。前者靠 notification 推送刷新，后者靠缓存与连接共享——两者合在一起就是"动态更新与性能优化"。

**怎么做——动态更新**：server 通过 `notifications/tools/list_changed`（或 resources/prompts）通知 client 列表变化。Claude Code 在 `useManageMCPConnections.ts:611-744` 注册处理器：

```typescript
client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
  fetchToolsForClient.cache.delete(client.name)
  const newTools = await fetchToolsForClient(client)
  updateServer({ ...client, tools: newTools })
  logEvent('tengu_mcp_list_changed', { type: 'tools', newCount })
})
```

类似 handler 用于 prompts 和 resources 列表变化（`useManageMCPConnections.ts:661-744`）。处理器逻辑很直接：清缓存 → 重新 fetch → 更新状态。这种"服务端推送变化"的模式比客户端轮询高效得多——server 知道什么时候工具有变化（比如 server 重启后工具列表变了），主动通知而不是等 client 每隔 N 秒来问。

**怎么做——性能优化**：三套机制协同降本：

**Fetch 缓存（LRU bounded）**：`fetchToolsForClient`、`fetchResourcesForClient`、`fetchCommandsForClient` 都用 `memoizeWithLRU`，限制 `MCP_FETCH_CACHE_SIZE = 20`（`client.ts:1738`）。防止 `tools/list` 重复请求导致 server 过载。为什么是 20？典型用户的 MCP server 数量在个位数到十几，20 个缓存槽足以装下"所有 server 的工具列表"且不让过期项长期占位——LRU 会在超限时淘汰最久未用的。

**Stale Cache 清理**：`onclose` 触发时（`client.ts:1394-1408`）：
```typescript
connectToServer.cache.delete(key)
fetchToolsForClient.cache.delete(name)
fetchResourcesForClient.cache.delete(name)
fetchCommandsForClient.cache.delete(name)
```
关闭连接后清掉所有相关缓存，保证下次操作强制重新 fetch——避免"用着旧连接的工具列表却不知道连接已断"的脏读。

**连接共享**：`connectToServer` 使用 `memoize` 带 `getServerCacheKey(name, jsonStringify(serverRef))` 缓存键——同 name + 同 config 复用同一 transport/client 实例。N 个并发 `callTool` 不会触发 N 次 `tools/list`。缓存键里带上 config 的 JSON 是关键：如果用户改了 server 配置（比如换了 URL），缓存键变化会自动建新连接，不会复用旧的错误连接。

> 至此一次连接的生命周期走完——配置、连接、认证、发现、调用、重连、动态更新七个阶段串起了 MCP 运行时的全貌。最后从这套实现里提炼出设计权衡、边界与可复用模式。

---

## 设计决策与权衡

回顾整条链路，MCP 实现里有若干关键取舍。理解这些取舍比记住代码更重要——它们决定了"为什么是这样设计"。

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 通信协议 | JSON-RPC 2.0（stdio/sse/http/ws） | REST API | JSON-RPC 的 `id` 天然解决请求-响应配对，且支持双向通知；REST 没有内置配对机制，难以在同连接上承载 server 主动推送 |
| 工具命名 | `mcp__<server>__<tool>`（命名空间） | 扁平命名 | 命名空间避免不同 server 的工具名冲突；权限规则可按 server 级控制 |
| Schema 注入 | 自动注入 System Prompt | 按需查询 | Agent 需要知道所有可用工具才能做出正确选择；Schema 注入是必要的上下文成本 |
| Description 截断 | 2048 字符上限 | 完整保留 | 上下文经济性优先；OpenAPI 生成的 server 常有 15-60KB 描述，不截断会迅速耗尽上下文窗口 |
| 连接管理 | memoize + LRU cache | 每次重建连接 | MCP 连接是昂贵的（子进程启动/HTTP 握手/OAuth），缓存避免重复连接 |
| 连接批处理 | 本地 3 / 远程 20 分开限流 | 统一并发 | stdio 是 CPU/IO 密集型，HTTP 是网络 IO 密集型，成本结构不同，分开避免互相阻塞 |
| 重连策略 | 指数退避（最多 5 次） | 无限重试 | 5 次覆盖临时网络问题（约 31s 窗口）；超过则需人工介入，避免无限重连压垮 server |
| stdio 不重连 | 进程死了标记 failed | 自动重启子进程 | 子进程崩溃通常是配置/代码错误，盲目重启会进入死循环；让用户排查更准确 |
| EventSource 超时 | GET 流不超时，POST 设置 60s | 统一超时 | SSE 长连接不能被 60s timeout 杀死；只有 POST 单次请求需要超时防挂死 |
| stdio 信号升级 | SIGINT→SIGTERM→SIGKILL 三段式 | 直接 SIGKILL | 给进程优雅退出窗口（flush 日志/关连接），同时用 600ms failsafe 保证 CLI 不卡顿 |
| Token 刷新阈值 | 提前 5 分钟主动刷新 | 过期后刷新 | 把刷新成本隐藏在正常请求间，避免 401 失败+重试的用户可感知卡顿 |
| 多实例 token 刷新 | file lock + 拿锁后重读 keychain | 各自刷新 | 多 CC 实例共享 keychain，加锁避免重复刷新和 refresh token 轮换踩踏 |
| MCP_SKILLS 索引 | 通过 resources 发现 skill | 与 tools 一起 | skill 是可复用 prompt 模板，与 tools 语义不同，独立更清晰 |
| 安全 hint 取信 | 工具实际注解（readOnlyHint 等）作为 hint | 服务端强制分类 | 不能信服务端告知的 hint（server 可能 bug 或恶意）；要本地安全决策，用户权限规则兜底 |
| 错误响应规范化 | Slack 非标准 invalid_grant 码 | 仅 RFC 标准错误码 | 兼容常见 OAuth 实现，不让 invalid_grant 误判导致 token 卡死 |
| step-up 走新 PKCE | 提权必须重新 consent | refresh 提权 | RFC 6749 §6 禁止 refresh 提权，防止 client 借 refresh 悄悄提权 |
| XAA token-exchange | id_token → access_token (RFC 8693) | 每个 server 独立 OAuth | 企业 SSO 场景把登录次数从 O(N) 降到 O(1)，避免用户登 N 次 |
| session 过期懒重连 | 调用失败时才重连 | 后台保活探测 | 避免无谓保活请求；代价是首次失败有一点延迟，对低频工具合理 |

---

## 可复用的模式

从 MCP 实现中提炼出的可迁移设计模式，可借鉴到其他需要"协议化扩展"的系统：

- **协议化扩展模式**：用标准协议（MCP/JSON-RPC）代替定制集成。新外部服务只需实现 MCP server，无需修改 Agent 代码。把 M×N 集成压成 M+N。
- **工具 Schema 自动注册模式**：`tools/list` → 自动注入 System Prompt → Agent 可直接使用。零手动配置。
- **命名空间隔离模式**：`mcp__<server>__<tool>` 避免不同 server 的工具名冲突。权限规则可按命名空间控制。
- **多 Transport 适配模式**：stdio（本地）、http（远程无状态）、sse（远程流式）、ws（双向）、claudeai-proxy（托管）覆盖不同部署场景。统一的 JSON-RPC 协议层屏蔽 transport 差异。
- **成本分类限流模式**：把并发任务按成本结构分类（CPU 密集 vs 网络 IO 密集），分别设并发上限，避免一类阻塞另一类。`pMap` 让空闲 slot 立即接管。
- **指数退避重连模式**：远程连接都用指数退避（5 次远程重连 + 3 次 OAuth refresh）覆盖临时故障，超限后降级为"可见但不可用"而非无限重连。
- **逐级信号升级模式**：清理子进程时 SIGINT→SIGTERM→SIGKILL，给优雅退出留窗口，用 failsafe 超时保证不卡顿。
- **PKCE-only 公共 client 模式**：Claude Code 作为 OAuth 公共 client（无 secret）走 PKCE——无需在 IDE 端储存 client_secret，安全边界最小。
- **CIMD 优先、DCR 兜底**：客户端元数据文档（CIMD）让 server 直接告诉你 client_id，省去 DCR 往返。只有 AS 不支持时才走标准 DCR。
- **提前刷新 + 分布式锁模式**：token 提前 5 分钟刷新隐藏延迟；多实例共享 keychain 时用 file lock + 拿锁后重读，避免重复刷新和轮换踩踏。
- **Notification-driven 刷新**：通过 server-pushed `list_changed` 通知保持工具列表新鲜，避免客户端轮询浪费请求。
- **信任边界分层模式**：协议层不信任 server 自报的 hint（readOnlyHint 等），只作辅助；最终安全裁决权留给用户配置的权限规则。

---

## 关键路径文件

| 路径 | 角色 |
|------|------|
| `src/services/mcp/client.ts` | MCP 客户端主逻辑：transport、connectToServer、fetchTools/Resources/Commands |
| `src/services/mcp/auth.ts` | OAuth 流程（ClaudeAuthProvider、PKCE、refresh、step-up、XAA） |
| `src/services/mcp/config.ts` | 配置加载、合并、过滤、企业策略 |
| `src/services/mcp/useManageMCPConnections.ts` | React hook 编排批量连接、自动重连、notification 路由 |
| `src/services/mcp/types.ts` | Zod schema、连接状态类型（connected/failed/needs-auth/pending/disabled） |
| `src/services/mcp/normalization.ts` | serverName/toolName 规范化（处理特殊字符） |
| `src/services/mcp/envExpansion.ts` | 环境变量展开（`${VAR}`、`${VAR:-default}`） |
| `src/services/mcp/InProcessTransport.ts` | 同进程内 SDK MCP server 的内存 transport |
| `src/services/mcp/claudeai.ts` | Claude.ai connector 远程获取 + 去重 |
| `src/services/mcp/oauthPort.ts` | 选 OAuth callback 端口 + 构造 redirect URI |
| `src/services/mcp/headersHelper.ts` | 动态 header 注入（如 Bearer token） |
| `src/services/mcp/elicitationHandler.ts` | 处理 server 发起的 `elicitation/create` 请求 |
| `src/services/mcp/channelNotification.ts` | KAIROS channel 推送通知的启用门控 |
| `packages/mcp-client/src/` | 抽出的 MCP 客户端库（connection/discovery/execution/errors/sanitization） |
| `packages/mcp-client/src/transport/InProcessTransport.ts` | 同进程 transport pair 实现 |

