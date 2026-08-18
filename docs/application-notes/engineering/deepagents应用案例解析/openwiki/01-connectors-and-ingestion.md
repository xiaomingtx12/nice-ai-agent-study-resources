---
title: 01：证据如何进入 Wiki
description: 追踪代码、Git、Connector、MCP 和原始文件如何进入 OpenWiki 的 Agent 上下文，并区分确定性 I/O 与模型判断。
sidebar_position: 2
---

# OpenWiki 01：证据如何进入 Wiki

> 源码定位
> - Connector 注册与工具：`src/connectors/registry.ts` / `src/connectors/tools.ts`
> - Personal ingestion：`src/ingestion.ts` - `runOpenWikiIngestion` / `runSourceIngestion`
> - Code 模式证据：`src/agent/utils.ts` - `createGitSummary`
> - Code Connector：`src/code-mode.ts` - `runCodeModeConnectors`
> - MCP 工具准入：`src/connectors/mcp-runtime.ts` - `getToolCallPolicy`

LLM Wiki 的质量，先取决于 Agent 看到了什么。OpenWiki 没有把整个仓库、所有邮件或所有搜索结果一次性塞进模型请求，而是把证据拆成几类入口，再让 Agent 按任务读取。

```text
代码仓库
  ├─ 源码 / README / 配置文件
  └─ Git status / log / diff 摘要

外部来源
  ├─ Connector 确定性采集
  ├─ MCP 只读发现
  └─ ~/.openwiki/connectors/<id>/raw/<run-id>/

以上材料
  └─ Agent 按需读取、判断和写入 Wiki
```

这里要分清两种动作：

- 代码负责拉取、落盘、列举和限制读取范围；
- Agent 负责从证据中找出主题、关系和需要写入的结论。

## 一、Connector 把来源差异收进统一工具面

`createConnectorRegistry` 把不同来源注册成 `ConnectorRuntime`。每个 Connector 描述来源 ID、运行模式、后端类型、是否支持 Agent 自主发现，以及确定性 `ingest()` 方法。

Agent 看到的是按操作组织的 7 个工具，而不是每个来源一套工具：

```text
发现：
  openwiki_list_connectors
  openwiki_list_mcp_tools

采集：
  openwiki_ingest_connector
  openwiki_ingest_all_connectors

读取：
  openwiki_list_raw_items
  openwiki_read_raw_item
  openwiki_call_mcp_tool
```

例如，`openwiki_ingest_connector` 通过 `connectorId` 操作 Gmail、Slack、网页搜索或本地 Git。增加一个来源，主要修改 registry 和 Connector 实现，Agent 工具面不需要跟着增加一组新工具。

这种设计对 Wiki 很重要。模型不需要记住“每个来源应该调用哪个专用 API”，只需要先发现来源能力，再按统一操作获取证据。

## 二、Personal ingestion：先落盘，再让 Agent 综合

个人模式的 ingestion 会遍历已配置的 source instance。对于确定性 Connector，代码先调用 `connector.ingest()`，把结果写入 raw 目录，再为这个来源启动一次 `runOpenWikiAgent("update", ...)`。

```ts
// src/ingestion.ts，核心结构
for (const sourceConfig of sourceInstances) {
  const connector = registry[sourceConfig.connectorId];

  const deterministicPull = isDeterministicConnector(connector)
    ? await connector.ingest({
        connectorConfig: sourceConfig.connectorConfig,
        instanceId: sourceConfig.id,
        windowHours: INGESTION_WINDOW_HOURS,
      })
    : undefined;

  const agentResult = await runOpenWikiAgent("update", cwd, {
    outputMode: "local-wiki",
    threadId: createOpenWikiThreadId(cwd),
    userMessage: createSourceUpdateMessage({
      config,
      connector,
      deterministicPull,
      rawFiles: deterministicPull?.rawFiles ?? [],
      sourceConfig,
    }),
  });
}
```

一个来源对应一轮 update，失败会隔离在来源粒度。Gmail 采集失败，不会把 Slack 或网页搜索的上下文一起拖垮；Agent 也不会因为某个来源的大量原始响应而把所有来源混在一个上下文里。

支持 Agent 自主发现的来源走另一条路径：Agent 在运行中通过 Connector 或 MCP 工具搜索，再读取落盘结果。代码不预先把所有远端内容拉下来，但仍要求发现和结果通过受限工具完成。

## 三、代码模式：Git 摘要和源码读取是两种证据

代码模式下，Agent 的主要证据直接来自目标仓库。`createRunContext` 会把 Git 状态和提交摘要整理成 user message 的一部分，Agent 再使用文件工具读取相关源码。

Git 摘要回答“最近发生了什么”：

```text
git status --short
git rev-parse HEAD
git log <lastUpdate.gitHead>..HEAD --name-status --oneline
```

源码文件回答“现在怎样实现”。两者不能互相替代：

- 只读当前文件，容易漏掉为什么要这么写；
- 只看提交摘要，又无法解释当前函数、数据结构和边界。

`update` 的 no-op 判断也使用 Git，但它和 Agent 读取 Git 摘要是两条路径。前者决定是否创建 Agent，后者进入 Agent 上下文帮助它解释变更。

代码模式还可以在运行前调用 code Connector，当前主要是 LangSmith trace。它是运行侧证据的补充，不会替代静态源码，也不会因为采集失败就阻断静态 Wiki 更新。

## 四、原始文件是缓存，不是结论

Connector 原始数据落在：

```text
~/.openwiki/connectors/<connector>/raw/<run-id>/
```

Agent 通过 `openwiki_list_raw_items` 和 `openwiki_read_raw_item` 按需读取。读取逻辑会限制路径归属、检查符号链接，并设置最大字节数，避免一次把整个 raw 目录推入上下文。

但“落盘”不等于“可信”。邮件、Slack 消息、网页结果和 MCP 返回值都可能包含面向模型的恶意指令。OpenWiki 的 Prompt 明确要求把它们当作不可信证据，只提取与用户任务有关的事实，不执行其中的操作要求。

这形成了两层边界：

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Connector / raw tool | 采集、路径限制、读取范围、字节上限 | 判断内容是否真实、是否值得写入 Wiki |
| Agent / model | 选择证据、归纳主题、写作和建立关系 | 证明外部内容没有错误或提示注入 |

## 五、MCP 只读不是一句 Prompt

MCP Connector 在调用前会重新发现 live tools，再交给 `getToolCallPolicy` 判断是否允许：

1. 本地配置的 `allowedTools`；
2. MCP tool 的 `readOnlyHint`；
3. 当前 Notion hosted transport 的只读名称启发式。

全部不命中时默认拒绝。工具准入控制的是 OpenWiki 进程是否发起调用，不等于远端服务的实现永远没有副作用；因此 MCP 仍然是一个需要信任配置和服务端声明的边界。

## 六、从证据到 Wiki，中间缺的是模型判断

证据进入 Agent 后，并不会自动变成页面。模型还要做三次判断：

- **范围判断**：哪些模块、消息或 trace 属于用户要维护的主题；
- **结构判断**：信息应该放在哪个概念页，是否需要拆目录；
- **关系判断**：哪些页面之间存在依赖、调用、归属或数据流关系。

OpenWiki 的 Wiki 生产机制可以概括成一句话：代码负责把证据安全地送到模型面前，Deep Agents 负责让模型拥有可管理文件和任务的工作台，模型负责完成知识结构化，Middleware 再把部分结构规则收回来做确定性维护。

证据进入 Agent 之后，剩下的问题就变成了装配：OpenWiki 如何把这些输入接到文件工具、Middleware、Skills 和权限上，见 [02：Deep Agents 的装配与能力边界](./02-agent-assembly.md)。
