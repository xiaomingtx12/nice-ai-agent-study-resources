---
title: 01：证据如何进入 Wiki
description: 追踪 Git、来源采集、raw 和 MCP 证据入口，解释提示词怎样指导模型筛选事实、跨来源去重、处理冲突并组织 Wiki。
sidebar_position: 2
---

# OpenWiki 01：证据如何进入 Wiki

> 源码基线：OpenWiki `0.2.4`，commit `3076d557f8a14`；依赖锁定 `deepagents@1.11.1`。
>
> - Git 证据：`src/agent/utils.ts` · `createRunContext` / `createGitSummary`
> - 来源契约与工具：`src/connectors/types.ts` · `ConnectorRuntime`；`src/connectors/tools.ts` · `createOpenWikiConnectorTools`
> - 知识综合规则：`src/ingestion.ts` · `createSourceUpdateMessage` / `createSourceSynthesisPolicy` / `createConnectorSynthesisGuidance`
> - 来源编排：`src/ingestion.ts` · `runOpenWikiIngestion` / `runSourceIngestion`
> - 原始文件：`src/connectors/tools.ts` · `readRawItem`；`src/connectors/io.ts` · `writeRawJson`
> - MCP：`src/connectors/mcp-runtime.ts` · `callMcpConnectorTool` / `getToolCallPolicy`
> - 代码运行证据：`src/code-mode.ts` · `runCodeModeConnectors`

OpenWiki 的证据有两条主要入口。repository 模式把 Git 摘要放进初始消息，源码由 Agent 再用文件工具读取；个人模式通常先由连接器采集一个来源实例，把原始文件位置交给一轮 update。连接器负责获取和保存材料，模型负责从中选择事实、合并主题并修改 Wiki。

这里的 raw data 指采集后的原始证据，可能是邮件、消息、搜索结果或运行记录。保存了 raw 文件，只说明有可再读的材料，不代表相应知识已经写入 Wiki。

## Git 摘要告诉模型从哪里查，文件工具提供实现细节

repository 的 `createRunContext` 调用 `createGitSummary`，把执行结果组合成字符串。该函数始终加入 `git status --short`、当前 HEAD 和 `git diff --name-status HEAD`；历史范围按已有状态选择：

| 条件 | 历史命令 | 模型得到的信息 |
| --- | --- | --- |
| update 且有上次 `gitHead` | `git log <gitHead>..HEAD --name-status --oneline` | 从上次记录提交到当前 HEAD 的提交摘要和路径 |
| update 只有 `updatedAt` | `git log --since <updatedAt> --name-status --oneline` | 按时间回退查询的历史 |
| init 或没有可用更新依据 | `git log --max-count=20 --name-status --oneline` | 最近 20 条提交及涉及文件 |

`--name-status` 给出文件级线索，不包含逐行补丁。模型要解释“新分支怎样执行”，仍须读到对应函数；它也不能仅凭提交标题断言当前行为。

各段输出经 `filterGitOutputForIgnore` 过滤，涉及 `.openwikiignore` 排除路径的行不会原样进入摘要。`runGit` 对普通命令失败会返回捕获到的 stdout/stderr 文本，因而 Git 不可用时可能传给模型一段错误信息，而不是完整历史。应用并不凭这份摘要保证仓库证据齐全。

## Connector 契约统一采集结果，工具再限定可选来源

`ConnectorRuntime` 是“来源描述 + 异步 ingest 方法”的契约；`ingest` 返回采集状态、raw 文件清单、运行 ID 和警告。模型拿到文件位置后才能继续读取材料。

`src/connectors/types.ts` · `ConnectorIngestResult / ConnectorRuntime`（第 33–45 行，节选）：

```ts
// 采集返回位置和状态；正文综合由后续 Agent 完成。
export type ConnectorIngestResult = {
  connectorId: ConnectorId;
  message: string;
  rawFiles: string[];
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

export type ConnectorRuntime = ConnectorDefinition & {
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;
};
```

`createConnectorRegistry` 注册八类 Connector，其中 Gmail 的 ID 是 `google`，LangSmith 属于 `code` 模式，其余来源面向个人知识采集。LangSmith 是记录模型和工具执行过程的观测服务，为代码文档提供运行侧证据。同一 Connector 可以有多个来源实例；实例保存自己的 ID、配置和采集目标，例如同一类来源的两个不同配置。

`createOpenWikiConnectorTools` 用 `DynamicStructuredTool` 包装操作。这个 LangChain 工具类把名称、输入 schema（参数结构约束）和执行函数绑定起来，使模型按结构化参数发起调用。七个工具按操作组织，但其 schema 并不都开放八类来源：

| 工具 | 输入与输出 | 当前边界 |
| --- | --- | --- |
| `openwiki_list_connectors` | 返回来源、配置和认证是否就绪 | 返回环境变量名称及是否设置，不返回密钥值 |
| `openwiki_ingest_connector` | `connectorId` 与采集选项 → `ConnectorIngestResult` | schema 列出七类，未开放 LangSmith |
| `openwiki_ingest_all_connectors` | 顺序调用 registry 内各来源的 `ingest` | 是否跳过由各 Connector 实现决定 |
| `openwiki_list_raw_items` | `connectorId` → 文件、最新 run 和最新文件列表 | 支持八类来源，包括 LangSmith |
| `openwiki_read_raw_item` | 来源 ID、相对路径、读取上限 → 内容与截断标志 | 限定来源 raw 目录 |
| `openwiki_list_mcp_tools` | 发现 live tools，并落盘发现结果 | 当前 schema 只开放 Notion |
| `openwiki_call_mcp_tool` | 工具准确名称和参数 → 远端结果与 raw 路径 | 当前只开放 Notion，调用前再次准入检查 |

因此，新增来源除了实现 registry 契约，还要同步相关工具的枚举 schema。单来源、批量采集和 code 模式预采集是不同入口，不能只看工具名称就推断它们具有相同的失败隔离。

## 个人采集按来源实例顺序启动 Agent

`runOpenWikiIngestion` 读取配置并解析目标实例，对每个实例 `await runSourceIngestion`，把结果放进数组。这个循环是顺序执行的：前一个来源写入的 Wiki 会被后一个来源读到，避免这些运行同时编辑同一知识页面，但总耗时会逐项累加。

`runSourceIngestion` 用 `supportsAgenticDiscovery` 决定是否预采集。值为 false 时执行确定性 `ingest`；否则留给 Agent 在运行中发现和查询。

`src/ingestion.ts` · `runSourceIngestion`（第 139–146 行，节选）：

```ts
// 该片段位于来源级 try 中，后续错误会转成该实例的结果。
const deterministicPull = isDeterministicConnector(connector)
  ? await connector.ingest({
      connectorConfig: sourceConfig.connectorConfig,
      instanceId: sourceConfig.id,
      windowHours: INGESTION_WINDOW_HOURS,
    })
  : undefined;
const rawFiles = deterministicPull?.rawFiles ?? [];
```

“确定性”指采集动作由代码和配置决定，并不代表远端数据不变。预采集传入来源实例配置、实例 ID 和 24 小时窗口；具体 API 请求和结果由各 Connector 实现。

采集返回 `error` 且没有 raw 文件时，函数直接返回来源错误，不启动 Agent。有部分 raw 文件时即使采集状态为 error，也会继续尝试综合；返回 `skipped` 同样没有被这一条件提前拦截。进入 Agent 的真实调用如下：

`src/ingestion.ts` · `runSourceIngestion`（第 169–182 行，节选）：

```ts
// 一份来源消息启动一轮 update，其他来源由外层循环继续处理。
const agentResult = await runOpenWikiAgent("update", cwd, {
  isFollowup: false,
  modelId,
  onEvent: emit,
  outputMode: "local-wiki",
  threadId: createOpenWikiThreadId(cwd),
  userMessage: createSourceUpdateMessage({
    config,
    connector,
    deterministicPull,
    rawFiles,
    sourceConfig,
  }),
});
```

`createSourceUpdateMessage` 注入来源身份、Wiki 目标、来源专属目标、采集结果和 raw 路径；发现型来源则收到自行搜索和查询的要求。非空 `userMessage` 也让这次 update 绕过入口处的 Git no-op 判断。

每个实例得到新的 thread ID（执行会话标识），但写入同一份个人 Wiki。`runSourceIngestion` 捕获采集或 Agent 异常后返回 `status: "error"`，外层循环才得以处理下一个实例；正常返回的 `agent-updated` 表示 Agent 调用结束，不保证一定改了页面，也不证明原始材料已经被完整收录。

`openwiki_ingest_all_connectors` 内部则直接逐项 await，没有这层来源级 catch。需要“某个来源抛错后其他来源继续”的编排时，应复用来源实例循环的边界，不能把批量工具当作等价替代。

## raw 文件怎样进入模型上下文

`writeRawJson` 把原始材料保存到 `~/.openwiki/connectors/<id>/raw/<run-id>/`。`writeConnectorState` 另存来源状态，`updateStateWithRun` 更新 `lastRunAt` 并保留最近 20 次采集记录。这份状态与 Wiki 的 `.last-update.json` 独立：来源采集成功后，Wiki 综合仍可能失败。

raw 工具的典型读取顺序是列目录、选择 `latestFiles`、按相对路径读取目标文件。`readRawItem` 通过来源 ID 解析目录，检查路径归属、raw 根及路径中各级符号链接，打开后再次确认是普通文件。

`src/connectors/tools.ts` · `readRawItem`（第 310–333 行，节选）：

```ts
// 路径校验之后才打开文件；返回截断发生在全文读取之后。
const rawDir = getConnectorRawDir(connectorId);
const filePath = resolveConnectorRawPath(connectorId, relativePath);
await assertRawItemPathHasNoSymlinks(rawDir, filePath);
const fileHandle = await open(filePath, getRawItemOpenFlags());

try {
  const fileStat = await fileHandle.stat();

  if (!fileStat.isFile()) {
    throw new Error("Raw item path must point to a file.");
  }

  const content = await fileHandle.readFile("utf8");
  const limit = Math.max(1, Math.min(maxBytes, 500_000));

  return {
    connectorId,
    content: content.slice(0, limit),
    filePath,
    truncated: content.length > limit,
  };
} finally {
  await fileHandle.close();
}
```

参数虽然叫 `maxBytes`，实现却先 `readFile("utf8")` 读取整个文件，再按 JavaScript 字符串长度截断：默认 100,000，最大 500,000 个 UTF-16 码元。它限制的是返回上下文的字符串长度，不能据此推断底层 I/O 或内存分配也按字节有界；截断后还可能只剩 JSON 的前半段。需要读取大型原始文件时，应改为分块、分页或字段提取，而不是只调小这个参数。

这里也存在另一条读取路径。确定性来源的 `createSourceUpdateMessage` 明确说明 raw 路径是宿主机路径，并允许 Agent 用 shell 的 cat、jq 或 node 检查。个人模式没有加载仓库 ignore 规则，因此不能宣称所有原始内容都必经 `readRawItem` 的路径检查和截断。

## MCP 每次调用都重新确认工具和准入

MCP（模型上下文协议）用于发现和调用远端工具。`openwiki_list_mcp_tools` 帮助模型拿到准确名称；`callMcpConnectorTool` 在真正调用前仍会重新请求工具列表，以当次返回结果为准。

`src/connectors/mcp-runtime.ts` · `callMcpConnectorTool`（第 85–99 行，节选）：

```ts
// 准确名称来自本次 tools/list；准入通过后才发起远端调用。
const discovery = await listMcpTools(config);
const tool = discovery.tools.find((candidate) => candidate.name === toolName);

if (!tool) {
  throw new Error(
    `MCP tool ${toolName} was not returned by tools/list for ${connectorId}. Run openwiki_list_mcp_tools first and use an exact discovered name.`,
  );
}

const policy = getToolCallPolicy(connectorId, config, tool);
if (!policy.allowed) {
  throw new Error(policy.reason);
}

const result = await executeMcpTool(config, tool.name, args);
```

`getToolCallPolicy` 依次检查本地 `allowedTools`、工具的 `readOnlyHint`，以及 Notion 官方 hosted transport 的工具名称与描述启发式。任一命中即可放行，全部不命中才拒绝。

这里的 `allowedTools` 是优先放行列表，并非“配置后只允许列表内工具”：列表外的工具仍可通过后面的只读判断。本地显式列入的工具也不会再被后续名称检查否决。工程上应把它理解为准入策略和信任配置，不能当成对远端副作用的证明。

远端调用完成后，代码将 result 写入 `mcp-tool-result.json`，记录来源状态，再返回 `rawFile`、`allowedBy` 和 `result`。返回对象包含完整远端结果，所以 MCP 这条路径同时支持直接工具返回和后续 raw 读取，并非所有大响应都会自动留在文件外而不进入模型上下文。

## 代码模式怎样补充运行侧证据

CLI 的 `runCodeModeConnectors` 在主 Agent 前遍历 `mode === "code"` 的 Connector，当前对应 LangSmith。它根据上次更新时间计算采集窗口，把仓库路径传入 Connector，使其读取项目配置并拉取运行记录。

抛异常、非 success 或没有 raw 文件时，不追加综合指导，静态源码文档仍可继续。成功且有 raw 文件时，`createConnectorSynthesisGuidance` 追加到本轮用户消息，要求用 raw 工具读取运行证据；因此即使 Git 没有新提交，新增的消息也能让主 Agent 运行。

运行记录用于支持“哪些路径被执行、哪里出错、哪些调用成本高”等观察。只有读到相关源码后，才有依据把观察关联到某个实现原因；仅凭 trace 的重复调用不能断言是某段代码的缺陷。

## 从证据到页面，提示词怎样指导综合

采集结束只提供材料和位置。`createSourceUpdateMessage` 还把 Wiki 总目标、来源实例的 `ingestionGoal` 和 `createSourceSynthesisPolicy` 生成的规则写进同一条用户消息；后者再调用 `createConnectorSynthesisGuidance`，追加 Gmail、Slack、Notion 等来源的专属要求。

因此，模型读到的任务包含“原始证据是什么”和“哪些事实值得保留、放到哪里”。这些字符串影响模型的选择，不会在代码中直接生成页面对象、执行去重算法或更新任务状态。

### 先判断信息价值，再确定页面归属

Gmail 的指导要求模型给候选内容分类，例如直接请求、决策审批、工作跟进、个人事务或噪音，再判断优先级和持续性。持续性包括 `ephemeral`（短期）、`durable`（长期）和 `recurring`（反复出现）；普通促销、收据和例行通知通常不进入 Wiki，除非具有行动价值、反复出现或用户明确要求保留。

个人模式的主要页面按用途划分，不按来源各写一份完整摘要：

| 页面 | 主要保存什么 | 避免放入什么 |
| --- | --- | --- |
| `/commitments.md` | 工作任务、承诺、审批、截止时间，尽量标明 Owner（责任归属） | 普通聊天和仅被收藏的资料 |
| `/personal-logistics.md` | 出行、预约、家庭事务等个人安排 | 没有个人事务含义的工作主题 |
| `/themes.md` | 反复出现的主题与趋势，使用稳定主题键和紧凑条目 | 长篇来源摘抄 |
| `/open-questions.md` | 影响后续理解用户的知识缺口，分 Active（待解答）、Answered（已解答）、Stale（失效） | 来源文档里所有尚未完成的 TODO |
| `/sources/<connector>.md` | 来源证据和采集覆盖范围 | 跨来源知识的重复全文 |
| `/quickstart.md` | 导航与当前重要状态 | 大量弱证据、观察项及详细原文 |

例如，假设邮件提出一项工作请求，随后 Slack 确认同一请求的负责人：按这套策略，模型应更新同一条 commitment，并在来源页保留紧凑证据，而不是在邮件页和 Slack 页各维护一份完整任务。这是策略应用示例；识别“同一请求”和负责人仍依赖模型判断。

### 用主题键去重，保留冲突证据

综合策略中的三个相邻要求直接约束事实如何合并：

`src/ingestion.ts` · `createSourceSynthesisPolicy`（第 336–338 行，提示词字符串节选）：

```text
- Apply confidence labels: confirmed, source-backed, contested, watchlist, or saved-context. Keep weak/watchlist items out of /quickstart.md unless they materially affect current status.
- When credible sources disagree and no ground truth settles it, label the fact contested and preserve both claims with source and date in a ## Contested section on the canonical page instead of overwriting one side. Never resolve a contested fact by recency alone.
- Deduplicate with stable topic keys. Update existing themes, open questions, and commitments instead of repeating the same fact in several source pages.
```

`confirmed` 表示已确认，`source-backed` 表示有来源支持，`contested` 表示存在争议，`watchlist` 表示暂待观察，`saved-context` 表示保存的背景材料。它们是给模型使用的写作标签，代码没有通过一个确定性评分函数算出这些类别。

稳定主题键用于让后续采集继续更新已有条目。例如，上述邮件与 Slack 应围绕同一个任务身份合并；键由模型在正文中维护，不是数据库唯一约束。顺序处理来源能让后续模型读到前一轮结果，却不能消除误合并和重复建条目。

如果两份可信材料给出互相冲突的截止日期，且没有证据确认哪一份有效，提示词要求在主要页面的 Contested 部分同时保留两种说法、来源和日期，不能单凭“消息更晚”覆盖旧说法。新证据真正解决问题后，模型再更新相关事实及问题状态；中间件不会替它裁决冲突。

### 代码 Wiki 按概念维护，个人 Wiki 按长期知识综合

上述固定主题页属于个人来源综合规则。repository 模式更关注架构、领域、工作流和修改指引：以当前源码核对旧文档，给一个概念保留一个主要说明位置，只在变化影响原解释时修改它。

两种模式都需要“读已有知识 → 找到同一主题 → 合并新证据 → 修正引用关系”，但不能把个人任务页模板套到所有代码仓库。code 模式的 LangSmith 指导又增加运行观测、源码关联和待验证假设的区分，不允许把一次样本观察直接写成系统普遍行为。

结构校验只能发现部分格式错误；主题是否重复、置信标签是否合理、冲突是否被错误消解，都不在 OKF 校验器的证明范围内。复用时可以沿用这些提示词规则；对有强审计要求的知识库，还应为事实保存稳定 ID、来源版本和独立的验证结果。

## 采集成功与知识更新之间没有事务

整个证据入口可以留下“raw 已写、来源状态已更新、Wiki 尚未改完”的中间状态。下一次综合需要重新读取这些材料，而不是把来源的 success 状态当作页面完成信号。

同样，来源限制、去重和“不执行材料中的指令”主要通过提示词约束模型；工具的路径和 MCP 准入检查只覆盖各自入口。复用到严格隔离的知识系统时，需要把 shell、来源访问和工具返回大小纳入同一权限策略。文件工作台的具体装配与现有限制见 [02](./02-agent-assembly.md)。
