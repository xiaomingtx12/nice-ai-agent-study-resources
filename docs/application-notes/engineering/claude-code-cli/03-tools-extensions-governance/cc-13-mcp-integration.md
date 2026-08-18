---
slug: /application-notes/engineering/claude-code-cli/cc-13-mcp-integration
sidebar_position: 13
title: "MCP 集成：外部能力如何进入 Agent"
description: "沿配置、连接、发现、调用、认证和重连主线，拆解 Claude Code 如何把 MCP server 接入统一工具管线。"
---

> MCP 的价值不是“多了一种工具调用 API”，而是把外部服务接入统一成一套协议，让 Agent 不必为每个服务重复实现一套适配器。
>
> **Harness 层定位**：MCP 位于工具层的外部扩展边界。它负责把进程外或远程服务转换成 Claude Code 内部的 `Tool`，但工具最终仍然要经过统一的权限、Hook、调度和结果回灌链路。

# MCP 集成：外部能力如何进入 Agent

## 源码定位

> **阅读基线**：Claude Code Best v2.8.2，当前源码提交 `d0713bdd169eefffab4f3d6bc361cb93be66bf52`。源码是对 Claude Code CLI 的工程复刻，正文引用的是本地实现的文件和函数；行号可能随源码变化，阅读时以函数名和调用关系为准。
>
> **核心路径**：
>
> - **配置与作用域**：`src/services/mcp/types.ts` 的 `ConfigScopeSchema`、`TransportSchema` 和 `MCPServerConnection`；`src/services/mcp/config.ts` 的 `getClaudeCodeMcpConfigs()`、`getAllMcpConfigs()`、`filterMcpServersByPolicy()` —— 解释配置来源、合并顺序、策略过滤和连接状态。
> - **连接工厂**：`src/services/mcp/client.ts` 的 `connectToServer()` —— 根据 `serverRef.type` 创建 `stdio`、SSE、HTTP、WebSocket 等传输对象，并执行 MCP 初始化握手。
> - **批量装配**：`client.ts` 的 `getMcpToolsCommandsAndResources()`、`reconnectMcpServerImpl()` —— 按本地/远程类型控制并发，连接成功后并行发现工具、Prompt、资源和 MCP Skill。
> - **工具转换**：`client.ts` 的 `fetchToolsForClient()`、`src/services/mcp/mcpStringUtils.ts` 的 `buildMcpToolName()` —— 将 `tools/list` 返回的 JSON 描述转换成内部 `Tool`。
> - **连接生命周期**：`src/services/mcp/useManageMCPConnections.ts` 的 `useManageMCPConnections()` —— 处理两阶段配置加载、断连、自动重连和 `list_changed` 通知。
> - **认证**：`src/services/mcp/auth.ts` 的 `performMCPOAuthFlow()`、`ClaudeAuthProvider.tokens()` —— 实现 OAuth、PKCE、提前刷新、step-up 和 XAA。
> - **扩展能力**：`src/skills/mcpSkills.ts` 的 `fetchMcpSkillsForClient()`；`src/services/mcp/channelNotification.ts` 的 `gateChannelServer()` —— 说明资源如何变成 Skill，以及频道推送为什么还需要额外闸门。
> - **协议级限制**：`packages/mcp-client/src/connection.ts` 的 `DEFAULT_CONNECTION_TIMEOUT_MS`、`MAX_MCP_DESCRIPTION_LENGTH`、`MAX_ERRORS_BEFORE_RECONNECT` —— 说明连接超时、描述长度和终止错误阈值。

## 为什么读这一篇

把 MCP 理解成“给模型增加几个外部函数”是不够的。真正需要回答的是：

- 配置文件、插件、企业策略和 claude.ai 连接同时存在时，最终加载哪些 server？
- `stdio`、SSE、HTTP 和 WebSocket 只是不同连接方式，还是对应不同的运行时策略？
- server 返回的工具描述，怎样变成 Claude Code 能调度和授权的内部 `Tool`？
- 远程连接失效时，哪些错误会触发重连，哪些错误只会让本次调用失败？
- OAuth 认证、token 刷新和权限升级，怎样与连接生命周期结合？

整篇文章只围绕一条主线：

```text
配置来源
  → 合并与策略过滤
  → 创建传输对象
  → initialize 握手
  → tools/list、resources/list、prompts/list
  → 转换为 Tool / Command / Resource
  → Agent 调用 tools/call
  → 断连、刷新缓存、远程重连
  → list_changed 触发重新发现
```

---

## 一、先分清 MCP 的四个对象

MCP（Model Context Protocol，模型上下文协议）连接的是两端：

```text
Claude Code
  MCP client / host
  负责发现 server、缓存能力、挂入 Agent 工具管线

MCP server
  外部能力提供者
  负责实现工具、资源、Prompt 或通知
```

这里的 `host` 可以理解为“宿主编排层”。它不只是发送 JSON-RPC 请求，还要负责：

- 从多个来源收集配置；
- 根据配置创建不同传输方式；
- 把工具描述转换成内部对象；
- 处理权限、认证、失败和重新发现；
- 把外部结果交给 Agent Loop。

### 1.1 MCP 不等于普通函数调用

普通函数调用通常是：

```text
函数名 + 参数
  → 本地函数
  → 返回值
```

MCP 调用则多了一层外部协议：

```text
模型的 tool_use
  → Claude Code 内部 Tool.call()
  → MCP client
  → JSON-RPC request
  → transport
  → MCP server
  → JSON-RPC response
  → Tool result
  → 下一轮模型消息
```

因此 MCP 工具不仅有“函数能做什么”的问题，还涉及：

- server 是否已经连接；
- 当前连接是否需要认证；
- 远程 session 是否已经过期；
- 工具列表是否已经变化；
- 当前工具是否通过权限检查。

### 1.2 “存在、可见、可执行”不是一回事

一个 MCP 工具至少经历三个状态：

```text
工具存在
  已经从 server 发现，进入内部工具集合

工具可见
  当前请求把它的名称、描述和 input schema 发送给模型

工具可执行
  当前连接、权限、参数和 Hook 都允许这次调用继续
```

例如，server 已经返回了一个工具，但它可能因为 `alwaysLoad` 没有被放进首轮完整工具描述；即使模型看见了它，权限规则仍然可以拒绝执行；即使权限通过，连接断开也会让调用失败。

这也是为什么 MCP 文章不能只写 `tools/list` 和 `tools/call` 两个方法。协议消息只是其中一段，Harness 还要负责把它们放进运行时。

---

## 二、MCP 在整体架构中的位置

MCP 是外部工具来源，不是另一套独立的 Agent Loop。

```text
┌────────────────────────────────────────────────────┐
│ Agent Loop                                         │
│                                                    │
│ 模型请求 → 模型输出 tool_use → 工具结果回灌        │
└──────────────────────┬─────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────┐
│ 统一工具管线                                        │
│ 工具查找 → 参数校验 → Hook → 权限 → 调度 → call()    │
└───────────────┬──────────────────────┬─────────────┘
                │                      │
                ▼                      ▼
        内置 Tool                  MCP Tool
                                      │
                                      ▼
                         MCP client + JSON-RPC
                                      │
                                      ▼
                         stdio / SSE / HTTP / WS
```

MCP 工具进入内部管线后，至少共享以下能力：

- 统一的 `Tool` 接口；
- 统一的输入 Schema；
- 统一的权限检查入口；
- 统一的并发调度和结果回灌；
- 统一的工具名称匹配和日志记录。

下一篇 [14 权限与安全](cc-14-permission-security.md) 会继续展开权限规则。本文只需要记住一个边界：**MCP server 提供的安全提示是辅助信息，不等于最终授权结果。**

### 2.1 MCP 解决的是适配数量问题

如果每个模型客户端都为每个外部服务写专用适配器，集成数量大致是：

```text
M 个 Agent 客户端 × N 个外部服务 = M × N 条适配线
```

引入 MCP 后：

```text
M 个客户端分别实现 MCP client
N 个服务分别实现 MCP server
总适配关系接近 M + N
```

这不是说所有 MCP server 都能完全即插即用。真实接入仍然会受到认证、权限、传输方式、输入 Schema 和服务质量影响，但协议层至少把公共交互方式固定下来了。

---

## 三、配置从哪里来

### 3.1 配置字段是 `type`，不是 `transport`

当前源码中的 MCP 配置使用 `type` 表示传输类型：

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "postgres": {
      "type": "http",
      "url": "https://mcp.example.com/postgres",
      "oauth": {}
    }
  }
}
```

这里有两个容易写错的点：

1. 配置键是 `type`，不是旧版示例中可能出现的传输字段名。
2. `stdio` 的 `type` 在源码 Schema 中是可选的，用于兼容旧配置；没有 `type` 时，连接工厂会按 stdio 分支处理。

环境变量展开支持两种写法：

```text
${GITHUB_TOKEN}
${PORT:-8080}
```

如果变量不存在且没有默认值，源码不会直接替换成空字符串，而是：

```text
保留原始 ${VAR}
记录 missingVars
由调用方继续报告缺失变量
```

这样可以保留错误现场，避免把“配置没有填写”悄悄变成“传了一个空密码”。

对应实现是 `src/services/mcp/envExpansion.ts`：

```typescript
const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
  const [varName, defaultValue] = varContent.split(':-', 2)
  const envValue = process.env[varName]

  if (envValue !== undefined) {
    return envValue // 找到环境变量，使用真实值
  }
  if (defaultValue !== undefined) {
    return defaultValue // 没找到变量，但配置了默认值
  }

  missingVars.push(varName) // 记录缺失变量
  return match // 保留 ${VAR}，不要静默改成空字符串
})
```

### 3.2 配置作用域

源码用 `ConfigScopeSchema` 区分配置来源：

| scope | 常见来源 | 作用 |
| --- | --- | --- |
| `plugin` | 已启用插件提供的 MCP 配置 | 随插件启停 |
| `user` | 用户级设置 | 当前用户的默认配置 |
| `project` | 项目级 `.mcp.json` | 团队或项目共享配置 |
| `local` | 项目本地设置 | 当前机器或当前工作区的覆盖 |
| `dynamic` | 运行时传入的配置 | 当前进程临时使用 |
| `enterprise` / `managed` | 企业托管配置 | 管理员控制的策略来源 |
| `claudeai` | claude.ai 连接器配置 | 远程账户侧配置 |

这些 scope 不是简单的“数字优先级”。配置装配还要考虑：

- 企业配置是否存在；
- 项目配置是否通过批准；
- server 是否被用户禁用；
- 插件 server 是否与手动 server 内容重复；
- URL、命令和名称是否命中允许/拒绝策略。

### 3.3 实际合并规则

`getClaudeCodeMcpConfigs()` 的普通配置合并顺序是：

```text
plugin
  → user
  → project
  → local
```

后写入的同名键覆盖前面的同名键。因此可以把普通来源理解为：

```text
local > project > user > plugin
```

但这个结论只适用于普通来源。完整逻辑还包括三个例外。

#### 例外一：企业配置可以独占控制

如果 `managed-mcp.json` 存在，源码会直接返回经过策略过滤的 enterprise server，不再使用其他普通来源。这种模式适合企业不允许用户自行添加外部连接的场景。

```text
managed-mcp.json 存在
  → 只加载 enterprise MCP
  → 应用 allowedMcpServers / deniedMcpServers
  → 不再合并 user、project、local、plugin
```

#### 例外二：插件和手动配置做内容去重

插件 server 的名字通常会加上插件命名空间，因此不会直接和手动配置撞名。源码还会比较实际连接内容，避免同一个命令或 URL被启动两次。

这个去重的优先级是：

```text
已启用的手动配置优先
重复的 plugin server 被抑制
被禁用的配置不能抢占一个可用的重复项
```

#### 例外三：claude.ai 连接器单独获取，再以最低优先级合并

claude.ai 配置可能需要网络请求，所以加载过程分成两阶段：

```text
第一阶段：先加载本地、项目、插件和动态配置，尽快开始连接
第二阶段：等待 claude.ai 配置，做内容去重后再追加连接
```

`getAllMcpConfigs()` 最后执行：

```text
claude.ai servers
  → 内容去重
  → 作为最低优先级合并
  → Claude Code 本地配置覆盖同一连接
```

因此不应该把所有来源机械写成一条固定的：

```text
enterprise > project > local > user > plugin > claudeai
```

源码真实语义是“企业独占，否则按普通来源合并，再单独合并 claude.ai”。

---

## 四、传输方式与连接工厂

MCP 的消息协议和传输方式是两层概念。

```text
JSON-RPC 消息
  可以承载在不同传输方式上
      ├─ stdio
      ├─ SSE
      ├─ Streamable HTTP
      ├─ WebSocket
      └─ 进程内 transport pair
```

传输方式只决定“消息怎么到达 server”，不改变 `tools/list`、`tools/call` 这些 MCP 方法的语义。

### 4.1 Claude Code 支持的类型

| `type` | 通信方式 | 典型场景 | 关键实现 |
| --- | --- | --- | --- |
| `stdio` | 子进程 stdin/stdout | 本地 Node/Python MCP server | `StdioClientTransport` |
| `sse` | HTTP 事件流加请求端点 | 传统远程 SSE server | `SSEClientTransport` |
| `http` | Streamable HTTP | 现代远程 MCP server | `StreamableHTTPClientTransport` |
| `ws` | WebSocket 双向连接 | 需要双向实时通信 | `WebSocketTransport` |
| `sse-ide` | IDE 专用 SSE | 编辑器扩展内部连接 | `SSEClientTransport` |
| `ws-ide` | IDE 专用 WebSocket | 编辑器扩展内部连接 | `WebSocketTransport` |
| `sdk` | SDK 进程内连接 | SDK 集成场景 | 由调用方处理 |
| `claudeai-proxy` | claude.ai 代理后的 HTTP | 账户侧连接器 | Streamable HTTP |

`connectToServer()` 不把所有类型压成一个大参数对象，而是为每种部署形态保留独立分支：

```typescript
if (serverRef.type === 'sse') {
  // 远程 SSE：附加 OAuth provider 和请求头
  transport = new SSEClientTransport(new URL(serverRef.url), transportOptions)
} else if (serverRef.type === 'http') {
  // Streamable HTTP：支持 OAuth、代理和 session
  transport = new StreamableHTTPClientTransport(
    new URL(serverRef.url),
    transportOptions,
  )
} else if (serverRef.type === 'ws') {
  // WebSocket：创建双向长连接
  transport = new WebSocketTransport(wsClient)
} else {
  // 缺省类型按 stdio 处理，启动本地子进程
  transport = new StdioClientTransport({
    command: stdioRef.command,
    args: stdioRef.args,
    env: { ...subprocessEnv(), ...stdioRef.env },
    stderr: 'pipe', // 把 server 的 stderr 收集起来，不直接污染 UI
  })
}
```

### 4.2 连接建立不是“new 一个 transport”就结束

连接工厂还会做几件关键工作：

1. 创建 Claude Code 的 MCP client；
2. 声明 `roots` 和 `elicitation` 能力；
3. 为 server 注册 `roots/list` 处理器；
4. 通过 `client.connect(transport)` 执行初始化；
5. 设置连接超时和错误监控；
6. 保存 server capabilities，供后续发现阶段判断。

连接建立后的能力交换可以抽象成：

```text
client.connect(transport)
  → initialize
  → server 返回 protocolVersion / capabilities / serverInfo
  → initialized
  → MCPServerConnection(type: "connected")
```

`capabilities` 很重要。Claude Code 不是无条件请求所有列表，而是先看 server 是否声明：

```text
capabilities.tools
capabilities.resources
capabilities.prompts
capabilities.*.listChanged
```

没有对应能力时，发现函数直接返回空列表，避免对不支持的方法发请求。

### 4.3 并发不是统一一个数字

`getMcpToolsCommandsAndResources()` 会把 server 分成两类：

```text
本地 server
  stdio / sdk
  默认并发上限较低，避免同时启动过多进程

远程 server
  SSE / HTTP / WS / claudeai-proxy
  默认并发上限较高，主要受网络 I/O 影响
```

当前默认值是：

- 本地并发：3；
- 远程并发：20。

源码使用 `pMap` 让一个 server 完成后立即释放并发槽，而不是等固定批次全部结束。这样一个慢 server 不会阻塞同一批次中的其他连接。

---

## 五、从 `tools/list` 到内部 Tool

连接成功只代表“可以通信”，并不代表 Agent 已经知道 server 提供什么能力。

发现阶段主要有三条路径：

```text
tools/list
  → fetchToolsForClient()
  → Tool[]

resources/list
  → fetchResourcesForClient()
  → ServerResource[]

prompts/list
  → fetchCommandsForClient()
  → Command[]
```

### 5.1 工具名称使用命名空间

默认工具名称是：

```text
mcp__<server>__<tool>
```

例如：

```text
mcp__github__create_issue
```

命名空间解决两个问题：

1. 不同 server 都提供 `search` 时不会直接重名；
2. 权限规则可以按 server 或工具粒度匹配。

`mcpStringUtils.ts` 中的核心关系是：

```typescript
export function buildMcpToolName(
  serverName: string,
  toolName: string,
): string {
  // 规范化名称后拼成稳定的 MCP 命名空间
  return `mcp__${normalizeNameForMCP(serverName)}__${normalizeNameForMCP(toolName)}`
}
```

内部还保留 `mcpInfo`：

```typescript
{
  name: "mcp__github__create_issue",
  mcpInfo: {
    serverName: "github",
    toolName: "create_issue"
  }
}
```

这样即使模型调用名称因为 SDK 特殊环境变量而跳过前缀，权限检查仍可以通过 `mcpInfo` 还原完整 MCP 名称。

### 5.2 `fetchToolsForClient()` 做了什么

源码把 server 返回的工具描述映射成内部 `Tool`：

```typescript
const fullyQualifiedName = buildMcpToolName(client.name, tool.name)

return {
  ...MCPTool,
  name: fullyQualifiedName, // 模型默认看到的完整名称
  mcpInfo: {
    serverName: client.name,
    toolName: tool.name,
  },
  isMcp: true, // 标记来源，后续权限和展示可以识别
  inputJSONSchema: tool.inputSchema, // 直接使用 server 提供的参数结构
  isReadOnly() {
    return tool.annotations?.readOnlyHint ?? false
  },
  isDestructive() {
    return tool.annotations?.destructiveHint ?? false
  },
  isOpenWorld() {
    return tool.annotations?.openWorldHint ?? false
  },
  alwaysLoad: tool._meta?.['anthropic/alwaysLoad'] === true,
  searchHint: normalizeSearchHint(
    tool._meta?.['anthropic/searchHint'],
  ),
}
```

这里有四类信息：

| MCP 返回字段 | 内部用途 |
| --- | --- |
| `name` | 拼成命名空间工具名 |
| `description` | 生成工具说明 |
| `inputSchema` | 生成模型可用的参数结构 |
| `annotations` | 提供只读、破坏性和开放世界提示 |
| `_meta.anthropic/*` | 决定延迟加载和搜索提示 |

### 5.3 安全提示只是提示

`readOnlyHint`、`destructiveHint`、`openWorldHint` 来自 MCP server。它们有助于调度器判断工具特征，但不能被当成可信的安全证明。

例如，一个 server 可以错误地把会写数据库的工具标记为只读。Claude Code 可以据此做并发和展示决策，但最终是否允许执行仍要经过权限系统和工具自身检查。

这体现了一个重要边界：

```text
server annotation
  = 外部声明的行为提示

permission rule / tool check
  = Claude Code 的执行授权
```

### 5.4 描述长度和延迟加载

MCP server 返回的描述可能非常长，尤其是由 OpenAPI 自动生成的工具。`MAX_MCP_DESCRIPTION_LENGTH` 当前为 2048，超过后会截断并附加 `[truncated]`。

此外，MCP 工具可以通过元数据控制是否常驻：

```text
alwaysLoad = true
  → 始终放入首轮可见工具

searchHint
  → 供额外工具搜索索引使用

两者都没有
  → 可以延迟发现，减少初始上下文负担
```

这和 [10 工具注册、调度与执行管线](cc-10-tool-execution-pipeline.md) 中的工具池策略相连：MCP 负责提供工具，统一工具管线负责决定它何时可见、能否执行以及结果如何回灌。

---

## 六、其他三类 MCP 能力

MCP 不只有 Tools。Claude Code 还接入了 Resources、Prompts 和 MCP Skills。

### 6.1 Resources：可寻址的外部内容

`resources/list` 返回带 URI 的资源：

```text
resources/list
  → uri、name、description、mimeType
  → ServerResource { ...resource, server: client.name }
```

资源的核心特点是“先发现地址，后读取内容”。它更接近外部数据入口，而不是一个有副作用的操作工具。

当 server 支持 Resources 时，Claude Code 还可能挂载通用的资源列表和资源读取工具。这样模型可以通过统一工具读取某个 URI，而不必为每个资源类型写专用工具。

### 6.2 Prompts：远程 Prompt 模板

`prompts/list` 返回 Prompt 模板及参数。`fetchCommandsForClient()` 会把它们转换成内部 `Command`：

```typescript
return {
  type: 'prompt', // 映射为 Claude Code 内部的提示词命令
  name: `mcp__${normalizeNameForMCP(client.name)}__${prompt.name}`,
  description: prompt.description ?? '',
  isMcp: true,
  source: 'mcp',
  async getPromptForCommand(args: string) {
    const connectedClient = await ensureConnectedClient(client)

    // 参数转换后请求 prompts/get，拿到真正的消息内容
    const result = await connectedClient.client.getPrompt({
      name: prompt.name,
      arguments: zipObject(argNames, args.split(' ')),
    })

    return result.messages
  },
}
```

Prompt 和 Tool 的差别是：

```text
Tool
  通常代表一次外部动作，进入模型工具调用流程

Prompt
  通常代表一份可参数化的提示模板，映射成 Command
```

### 6.3 MCP Skills：通过资源发现技能

MCP Skill 不是另一个协议对象，而是 Claude Code 对 `skill://` 资源的一种约定。

发现过程是：

```text
resources/list
  → 过滤 uri.startsWith("skill://")
  → resources/read
  → 解析 Markdown frontmatter
  → createSkillCommand()
  → 进入本地 Skill 索引和执行路径
```

源码中的关键判断：

```typescript
const skillResources = result.resources.filter(resource =>
  resource.uri.startsWith('skill://'),
)
```

这让远程 Skill 可以复用本地 Skill 的 Command、搜索和执行机制。Skill 的完整边界见 [11 Skill 系统](cc-11-skill-system.md)，本文只需要记住：MCP 负责把远程资源转换成 Skill 来源，Skill 系统负责后续索引和注入。

### 6.4 Channels：服务器主动推送消息

Channel（频道推送）允许 MCP server 通过通知把外部消息送入对话，例如 Slack、Discord 或短信渠道。

它与普通 `tools/call` 的方向相反：

```text
普通工具：
  Agent → tool_use → MCP server

Channel：
  MCP server → notifications/claude/channel → Claude Code
```

Claude Code 不会因为 server 声明了 channel capability 就直接注册处理器。`gateChannelServer()` 还会检查：

1. server 是否声明 `experimental['claude/channel']`；
2. 当前会话是否显式开启 `--channels`；
3. 当前订阅和组织策略是否允许；
4. 插件来源是否和允许的 marketplace 一致；
5. 认证和 feature gate 是否通过。

因此“连接成功”和“允许主动推送”是两个不同判断。连接可以保持，但 channel handler 可能不注册。

---

## 七、一次 MCP 调用如何执行

### 7.1 调用链路

当模型请求：

```text
mcp__github__create_issue
```

内部过程是：

```text
Tool.call(args)
  → ensureConnectedClient()
  → callMCPToolWithUrlElicitationRetry()
  → client.request({ method: "tools/call" })
  → server 执行 create_issue
  → 返回 content / structuredContent / isError
  → 转成 tool_result
  → 下一轮 Agent Loop
```

工具适配器会把完整 MCP 工具名拆回：

```text
serverName = github
toolName = create_issue
arguments = { title: "...", body: "..." }
```

然后只把原始的 server 工具名放进 MCP 请求：

```json
{
  "method": "tools/call",
  "params": {
    "name": "create_issue",
    "arguments": {
      "title": "修复登录问题",
      "body": "..."
    }
  }
}
```

### 7.2 `isError` 和连接异常不是同一种失败

MCP 工具结果中的 `isError: true` 通常表示：

```text
请求已经到达 server
server 执行了工具
工具内部或外部业务 API 返回失败
```

例如 GitHub API 返回参数错误、权限不足或请求频率超限。此时 Agent 仍然可以读懂错误并调整参数。

连接异常则是另一类问题：

```text
无法建立请求
传输被关闭
JSON-RPC 响应解析失败
HTTP session 已失效
```

这类错误会进入连接监控、重连或认证处理，而不是简单地当作业务工具错误回灌。

### 7.3 session 过期时的懒重连

Streamable HTTP server 可能为连接分配 session。源码识别：

```text
HTTP 404
  + JSON-RPC code -32001
  → Session not found
```

处理方式是关闭当前 transport、清理缓存，后续调用重新连接并取得新的 session。

这是懒重连（lazy reconnect，真正需要时才重连）：

```text
平时不额外发送保活探测
第一次发现 session 失效时触发重连
```

优点是减少无意义的网络请求，代价是 session 失效后的第一次调用可能多一次延迟。

---

## 八、OAuth：远程连接怎样取得 token

OAuth（开放授权协议）只在需要远程认证的 transport 上出现，典型是 `sse` 和 `http`。本地 `stdio` 通常由子进程自己的环境变量或配置完成认证，不经过这条浏览器授权链路。

### 8.1 标准授权码 + PKCE

PKCE（Proof Key for Code Exchange，授权码交换防拦截机制）适合 CLI 这类公共客户端。客户端不把 `client_secret` 当作可靠秘密，而是为一次授权生成：

```text
code_verifier
  本地随机保存的原始校验值

code_challenge
  由 verifier 计算出的挑战值，发送给授权服务器
```

授权过程可以写成：

```text
Claude Code
  → 发现授权服务器元数据
  → 生成 state + code_verifier
  → 打开浏览器
  → 用户授权
  → 回调地址收到 authorization code
  → 使用 code + code_verifier 换 access_token
```

`state` 用来防止回调请求被串到另一次授权；`code_verifier` 用来证明换 token 的客户端确实发起了原始授权。

### 8.2 CIMD 和 DCR

认证服务需要知道 OAuth client 的元数据。这里有两个不常用术语：

- CIMD（Client ID Metadata Document，客户端元数据文档）：用一个元数据 URL 作为 `client_id` 的来源，减少动态注册往返。
- DCR（Dynamic Client Registration，动态客户端注册）：客户端向授权服务器注册，换取 `client_id`。

`ClaudeAuthProvider.clientMetadataUrl` 优先提供 CIMD URL；如果授权服务器不支持这种方式，再由 SDK 或配置走 DCR。

源码中的客户端元数据强调了公共客户端属性：

```typescript
get clientMetadata(): OAuthClientMetadata {
  return {
    client_name: `Claude Code (${this.serverName})`,
    redirect_uris: [this.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // CLI 不依赖可保密的 client_secret
  }
}
```

### 8.3 token 提前刷新

`ClaudeAuthProvider.tokens()` 不会等 access token 已经过期才刷新，而是提前 5 分钟判断：

```typescript
const expiresIn = (tokenData.expiresAt - Date.now()) / 1000

if (expiresIn <= 300 && tokenData.refreshToken && !needsStepUp) {
  // 共享同一个 refresh promise，避免并发请求重复刷新
  this._refreshInProgress ??= this.refreshAuthorization(
    tokenData.refreshToken,
  )
  return await this._refreshInProgress
}
```

这样可以把刷新延迟藏在正常请求前，避免模型已经决定调用工具后，第一次请求先得到 401，再进入刷新和重试。

### 8.4 step-up：权限升级认证

step-up（权限升级认证）是指当前 token 可以访问普通资源，但访问某个更高权限操作时，server 返回 `403 insufficient_scope`。

源码不会用 refresh token 强行提升 scope，因为 OAuth 规范不允许通过普通 refresh 取得更高权限。它会：

```text
收到 insufficient_scope
  → 记录需要的 scope
  → 让下一次认证跳过 refresh
  → 重新走 PKCE 授权
  → 用户明确同意更高权限
```

所以“token 能刷新”不等于“token 能升级权限”。

### 8.5 XAA：一次企业登录，多次换 token

XAA（Cross-App Access，跨应用访问）用于企业单点登录场景。它把“用户登录 IdP”和“每个 MCP server 取得自己的 access token”拆成两步：

```text
第一次：
  浏览器登录企业 IdP
  → 缓存 id_token

每个 MCP server：
  id_token
  → RFC 8693 token exchange（令牌交换）
  → 该 server 的 access_token
```

优点是多个 MCP server 可以共享一次企业登录。它不是普通 refresh token 流程，排查时要区分：

```text
普通 OAuth
  refresh_token → access_token

XAA
  IdP id_token → token exchange → access_token
```

---

## 九、断连、缓存和自动重连

### 9.1 连接状态

`MCPServerConnection` 有五种主要状态：

```text
pending
  正在连接或正在重连

connected
  已完成握手，拥有 client 和 capabilities

needs-auth
  远程 server 要求用户完成认证

failed
  连接或重连失败，需要人工处理

disabled
  被用户或策略显式禁用
```

状态变化不是装饰信息。它决定：

- 是否继续发现工具；
- `/mcp` 面板显示什么；
- 是否执行自动重连；
- 当前 Agent 是否还能看到外部能力。

### 9.2 哪些错误会触发底层关闭

`packages/mcp-client/src/connection.ts` 使用 `MAX_ERRORS_BEFORE_RECONNECT = 3` 作为连续终止错误阈值。典型错误包括：

```text
ECONNRESET
ETIMEDOUT
EPIPE
EHOSTUNREACH
ECONNREFUSED
Body Timeout Error
SSE stream disconnected
```

单次错误不一定立刻判定 server 已经不可用。连续错误达到阈值后，连接监控器才会关闭 transport，让上层 Hook 接管重连。

### 9.3 `onclose` 的重连边界

`useManageMCPConnections.ts` 的 `onclose` 处理逻辑可以概括为：

```typescript
client.client.onclose = () => {
  clearServerCache(client.name, client.config)

  if (isMcpServerDisabled(client.name)) {
    return // 已禁用，不再自动重连
  }

  const configType = client.config.type ?? 'stdio'

  if (configType !== 'stdio' && configType !== 'sdk') {
    // 只有远程 transport 进入指数退避重连
    void reconnectWithBackoff()
  } else {
    updateServer({ ...client, type: 'failed' })
  }
}
```

这里必须纠正一个常见误读：**当前 Hook 不会对 stdio 和 sdk 自动重启或重连。**

- `stdio` 是本地子进程，进程退出后标记失败；
- `sdk` 是进程内集成，生命周期由 SDK 调用方管理；
- SSE、HTTP、WebSocket 和 claude.ai proxy 才进入远程自动重连路径。

### 9.4 指数退避参数

当前重连参数是：

```text
MAX_RECONNECT_ATTEMPTS = 5
INITIAL_BACKOFF_MS = 1000
MAX_BACKOFF_MS = 30000
```

实际等待序列为：

```text
第 1 次失败 → 等 1 秒
第 2 次失败 → 等 2 秒
第 3 次失败 → 等 4 秒
第 4 次失败 → 等 8 秒
第 5 次失败 → 放弃并标记 failed
```

源码在每次重连成功后，会重新执行：

```text
connectToServer()
  → fetchToolsForClient()
  → fetchCommandsForClient()
  → fetchMcpSkillsForClient()
  → fetchResourcesForClient()
```

也就是说，重连不仅恢复网络连接，还会重新建立“连接能力视图”。

### 9.5 缓存为什么必须一起失效

MCP 使用两类缓存：

```text
连接缓存
  connectToServer.memoize

能力发现缓存
  fetchToolsForClient
  fetchCommandsForClient
  fetchResourcesForClient
  fetchMcpSkillsForClient 的 LRU 缓存
```

连接关闭时，源码会清理对应的连接和发现缓存：

```typescript
connectToServer.cache.delete(key)
fetchToolsForClient.cache.delete(name)
fetchResourcesForClient.cache.delete(name)
fetchCommandsForClient.cache.delete(name)
```

如果只重建 transport、不清理工具缓存，就会出现：

```text
新连接已经建立
但 Agent 仍使用旧连接发现的工具列表
```

这类“连接恢复了但能力视图过期”的问题比单纯连接失败更难排查，所以连接缓存和发现缓存必须一起处理。

---

## 十、`list_changed`：服务端主动要求重新发现

工具、Prompt 和资源列表并不是永远不变。server 可能在运行中加载插件、切换租户或热更新能力。

如果客户端定时轮询，会产生大量无效请求；如果完全不轮询，列表又会过期。MCP 提供 `list_changed` 通知，Claude Code 在 server 声明对应 capability 后注册处理器。

工具列表处理逻辑的核心是：

```typescript
client.client.setNotificationHandler(
  ToolListChangedNotificationSchema,
  async () => {
    // 先丢弃旧的发现结果
    fetchToolsForClient.cache.delete(client.name)

    // 再向 server 请求最新工具列表
    const newTools = await fetchToolsForClient(client)

    // 用新的工具集合替换当前状态
    updateServer({ ...client, tools: newTools })
  },
)
```

Prompt 和资源的处理方式类似，但有一个额外关系：

```text
resources/list_changed
  → 刷新 resources
  → 如果启用 MCP_SKILLS，同时刷新 skill:// 资源
  → 清理 Skill 搜索索引
```

这里不是增量补丁，而是“清缓存后重新拉完整列表”。优点是实现简单、状态一致；代价是列表很大时会产生一次完整刷新成本。

---

## 十一、一个完整生命周期示例

以项目中的 GitHub MCP server 为例：

### 1. 配置阶段

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

配置被读取后，经过 scope 合并、项目批准状态和策略过滤。

### 2. 连接阶段

```text
type = stdio
  → 启动 npx 子进程
  → 通过 stdin/stdout 交换 JSON-RPC
  → initialize / initialized
  → 状态变为 connected
```

### 3. 发现阶段

```text
tools/list
  → create_issue
  → buildMcpToolName()
  → mcp__github__create_issue
  → 进入内部 Tool 集合
```

### 4. 调用阶段

```text
模型输出 tool_use:
  name = mcp__github__create_issue

Claude Code:
  → 找到内部 MCP Tool
  → 通过权限和 Hook
  → tools/call(name = "create_issue")
  → 把 content 转成 tool_result
```

### 5. 失败阶段

```text
npx 子进程退出
  → stdio onclose
  → 清理连接和发现缓存
  → 标记 failed
  → 不进入远程自动重连
```

如果把 `type` 换成 `http`，连接失败后的后半段就不同：

```text
HTTP onclose
  → 清理缓存
  → pending
  → 1s / 2s / 4s / 8s 退避重连
  → 成功后重新发现工具
  → 5 次仍失败则 failed
```

同一个 MCP 协议，因为 transport 不同，生命周期策略也会不同。

---

## 十二、设计决策与权衡

| 决策 | 当前选择 | 解决的问题 | 代价 |
| --- | --- | --- | --- |
| 协议格式 | JSON-RPC | 同时支持请求、响应和通知 | 需要维护消息 ID 和错误映射 |
| 配置字段 | `type` 区分传输 | 连接工厂可明确分支 | 配置与 MCP 规范示例不一致时容易写错 |
| 工具命名 | `mcp__server__tool` | 防止多 server 同名冲突 | 工具名更长 |
| 配置合并 | 普通来源按优先级覆盖，企业可独占 | 支持用户、项目和企业共同管理 | 需要处理去重、禁用和批准状态 |
| 工具转换 | 外部 JSON 转内部 `Tool` | 复用统一调度、权限和 Hook | 必须维护两套对象字段映射 |
| 描述限制 | 2048 字符截断 | 控制上下文成本 | 过长描述可能丢失细节 |
| 连接缓存 | `memoize` 复用连接 | 避免重复启动和握手 | 配置变化必须保证缓存键变化 |
| 发现缓存 | LRU，当前上限 20 | 减少重复 `list` 请求 | 动态更新时必须主动清缓存 |
| 远程重连 | 最多 5 次指数退避 | 覆盖短时网络故障 | 持久故障仍需用户介入 |
| 本地失败 | stdio 标记 failed | 避免无限重启坏进程 | 用户需要手动修复或重试 |
| token 刷新 | 提前 5 分钟 | 降低首次调用遇到 401 的概率 | 可能多做一次刷新请求 |
| 权限升级 | step-up 重新走 PKCE | 不用 refresh token 越权提权 | 用户需要再次授权 |

---

## 十三、边界与常见误区

### 13.1 “MCP server 返回了工具”不等于“模型一定看见”

工具可能因为延迟加载、描述预算或当前连接状态没有出现在本轮完整 Schema 中。排查时要区分：

```text
tools/list 是否返回
  → 内部 Tool 是否创建
  → 是否被标记 alwaysLoad
  → 是否在当前模型请求中可见
```

### 13.2 `isError` 不代表连接断了

`isError: true` 更接近业务失败；连接断开、session 过期和 JSON-RPC 传输错误会进入另外的恢复路径。把两者混成一种错误，会导致错误提示和重试策略都不准确。

### 13.3 `stdio` 不会走远程自动重连

本地子进程的崩溃可能来自命令写错、依赖缺失或 server 自身异常。当前实现选择把它暴露为 `failed`，避免反复启动同一个坏进程。

### 13.4 配置字段必须使用 `type`

文章、示例和排障命令都应使用：

```json
{
  "type": "stdio"
}
```

旧文章或其他客户端示例中的字段名不能直接复制到当前实现；当前源码 Schema 和连接工厂都读取 `type`。

### 13.5 server 的安全注解不能替代权限系统

`readOnlyHint` 和 `destructiveHint` 是 server 提供的行为提示。server 可能错误配置，甚至可能不可信。真正的授权仍然要看 Claude Code 的权限规则、工具检查、Hook 和必要的人工审批。

### 13.6 MCP 不自动解决外部服务安全

MCP 统一了调用协议，但不能保证：

- server 没有恶意逻辑；
- `inputSchema` 与真实执行行为一致；
- URL 指向的是可信服务；
- OAuth scope 足够小；
- server 不会把敏感数据写入工具结果。

MCP 接入后的安全边界仍然需要沿着 server、连接凭证、工具参数、权限规则和结果内容分别审计。

---

## 十四、可复用的工程模式

### 1. 协议与传输分离

```text
协议层定义消息语义
传输层负责把消息送到对端
```

这样同一个能力可以在本地进程、HTTP 或 WebSocket 中复用，协议层不会被某一种部署方式绑死。

### 2. 外部描述转换为内部协议

不要让 Agent Loop 直接理解每个外部服务的返回格式。应在边界处完成：

```text
外部工具描述
  → 内部 Tool
  → 统一权限、调度和结果协议
```

这让内置工具和外部工具可以共享控制面。

### 3. 连接缓存和能力缓存分开管理

连接对象和工具列表不是同一种缓存：

```text
连接缓存：复用 transport/client
能力缓存：复用 tools/prompts/resources 结果
```

断连、配置变化和 `list_changed` 都要分别决定清理哪一种缓存。

### 4. 按成本类型设置并发

本地子进程和远程网络连接的成本结构不同。把它们放进同一个并发池，容易让启动进程拖慢远程连接，或者让大量网络连接挤占本地资源。

### 5. 失败状态要可见

连接失败后保留 `failed` 状态，而不是把 server 从工具列表中悄悄删除，有助于：

- 用户知道某个能力为什么不可用；
- UI 显示认证、连接或策略问题；
- 后续手动重试可以复用原始配置；
- Agent 能够向用户说明“能力存在，但当前不可用”。

### 6. 动态能力使用通知刷新

server 知道自己的工具什么时候变化，因此让 server 主动发送 `list_changed` 比客户端固定轮询更节省请求，也更及时。

---

## 读完后应该能判断什么

- `type` 决定连接工厂创建哪一种传输对象，MCP 协议本身不等于某一种 transport；
- 普通配置大致按 `plugin < user < project < local` 合并，但 enterprise 配置可以独占，claude.ai 连接器还会单独获取和去重；
- `tools/list` 返回的 JSON 会被转换成统一的 `Tool`，命名空间默认是 `mcp__server__tool`；
- Tools、Resources、Prompts、MCP Skills 和 Channels 是不同能力边界，不能统称为“工具”；
- OAuth 认证包含 PKCE、token 提前刷新、step-up 和可选的 XAA，远程连接生命周期不能只看 transport；
- 远程 transport 最多进行 5 次指数退避重连，`stdio` 和 `sdk` 当前不走自动重连；
- 断连时必须同时考虑连接缓存和能力发现缓存，否则可能恢复连接却继续使用过期工具列表；
- MCP 工具最终仍进入统一工具管线，权限和安全问题应继续阅读 [14 权限与安全](cc-14-permission-security.md)。
