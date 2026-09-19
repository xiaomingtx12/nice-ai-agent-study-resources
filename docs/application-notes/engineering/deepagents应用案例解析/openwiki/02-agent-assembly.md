---
title: 02：Deep Agents 的装配与能力边界
description: 沿运行时装配和 raw 读取规则更新案例，追踪模型如何选择受影响页面，再通过文件工具和 Backend 写入 Wiki。
sidebar_position: 3
---

# OpenWiki 02：Deep Agents 的装配与能力边界

> 源码基线：OpenWiki `0.2.4`，commit `3076d557f8a14`；依赖锁定 `deepagents@1.11.1`。
>
> - 运行时装配：`src/agent/index.ts` · `runOpenWikiAgentCore`
> - 运行消息和事件：`src/agent/index.ts` · `createRunUserMessage` / `parseStreamEvent`
> - 文件与 shell 检查：`src/agent/docs-only-backend.ts` · `OpenWikiLocalShellBackend`
> - 提示词：`src/agent/prompt.ts` · `createSystemPrompt` / `createUserPrompt` / `createModeInstructions`
> - Skills 同步：`src/agent/skills.ts` · `syncBundledSkills`

OpenWiki 使用 `createDeepAgent` 创建可执行 Agent graph（执行图）。这个工厂接收模型、工具、文件后端、提示词和生命周期中间件，模型与工具的循环由框架驱动；OpenWiki 的业务行为取决于它传入的对象及图外的运行代码。

从 `runOpenWikiAgentCore` 往下读，可以跟完一条具体链路：运行参数决定文件根和模型，Backend 接受工具请求，工具结果进入消息状态，下一轮模型据此继续读取或写作。

## 装配前先确定模型、状态和文件根

外层 `runOpenWikiAgent` 已处理环境、忽略规则和模型认证。核心函数接到 command、cwd、options、provider、modelId 和 ignore 对象，按以下顺序准备资源：

1. `createRunContext` 返回语言、Wiki 目标、Git 摘要和上次元数据；非 chat 运行记录内容快照。
2. `createModel` 返回聊天模型，统一模型调用接口。
3. 选择 thread ID，并创建 checkpointer（执行图状态保存器）。这里使用 `SqliteSaver`，即 LangGraph 的 SQLite 状态保存器：chat 使用持久化文件，init/update 使用内存数据库。
4. 创建 Wiki Backend 和 Skills（可按需读取的操作说明）路由，再把工具、提示词和中间件一起交给工厂。

thread ID 标识 graph 的状态空间。只有状态保存器和同一个 ID 配合，后续消息才能继续使用已有状态；传入旧 ID 并不能让内存数据库在进程重启后恢复。Wiki 文件的生命周期独立于这份对话状态。

## 两个 Backend 组成统一的虚拟文件树

Backend 是框架文件工具调用的后端接口。`LocalShellBackend` 提供本地文件和 shell 能力，OpenWiki 继承它添加路径检查；`FilesystemBackend` 在这里提供 Skills 文件树；`CompositeBackend` 按虚拟路径前缀把请求分发到对应后端。

`src/agent/index.ts` · `runOpenWikiAgentCore`（第 295–309 行，节选）：

```ts
// 默认路径交给 Wiki Backend，/skills/ 前缀交给独立文件后端。
const wikiBackend = new OpenWikiLocalShellBackend({
  docsOnly: command !== "chat",
  openWikiIgnore,
  maxOutputBytes: 100_000,
  outputMode,
  rootDir: cwd,
  timeout: 120,
  virtualMode: true,
});
const backend = new CompositeBackend(wikiBackend, {
  "/skills/": new FilesystemBackend({
    rootDir: openWikiSkillsDir,
    virtualMode: true,
  }),
});
```

repository 模式的默认 Backend 根是仓库，`/src/...` 用于读源码，`/openwiki/...` 用于写文档。个人模式的根已经是 Wiki，页面直接写到 `/quickstart.md` 等位置。两种模式中，`/skills/` 都转到 `~/.openwiki/skills/`，不用把说明文件复制进生成的 Wiki。

这里的 `virtualMode: true` 解决路径映射。`execute` 仍然执行宿主机命令，不能从虚拟根推导出容器或操作系统级隔离。

## 工厂参数把 OpenWiki 规则接到通用工具循环

下面截取工厂调用的首尾；中间省略的是 Middleware 装配表达式，没有另造一份参数对象。

`src/agent/index.ts` · `runOpenWikiAgentCore`（第 325–329、370–380 行，节选）：

```ts
// 中间省略 middleware 字段，本文后续说明其按命令选择的规则。
const agent = createDeepAgent({
  model,
  tools: createOpenWikiConnectorTools(),
  checkpointer,
  backend,

// ……省略同一函数中与本节无关的语句。

  skills: ["/skills/"],
  permissions: [
    { operations: ["write"], paths: ["/skills/**"], mode: "deny" },
  ],
  systemPrompt: createSystemPrompt(
    command,
    outputMode,
    context.language,
    openWikiIgnore,
  ),
});
```

`createOpenWikiConnectorTools` 提供 [01](./01-connectors-and-ingestion.md) 的七个来源工具。文件操作、`write_todos`（维护任务清单）和 `task`（委派子代理）属于框架工作台，OpenWiki 在提示词中规定如何用这些能力研究并组织 Wiki。

被省略的 `middleware` 字段按 command 选择：chat 传空数组，init 挂 OKF/index 中间件，负责页面头部元数据约定和目录索引；update 在它前面加入翻译中间件。`createMiddleware` 是 LangChain 的生命周期扩展工厂，允许应用在运行前、工具调用周围和运行结束后执行确定性逻辑。这里传空数组仅表示不加入这两个 OpenWiki 自定义中间件，不表示框架完全没有中间件。

`permissions` 为 `/skills/**` 声明拒绝写操作，`skills` 声明发现目录。模型可以按需读取 Skills 的操作说明，文件工具层会限制对该路径的写入。这份规则不等于把对应宿主机目录挂成操作系统只读。

## 一次文件写入怎样通过检查

假设模型要创建 `/openwiki/architecture/runtime.md`。文件工具把路径和内容交给 Backend，`OpenWikiLocalShellBackend.write` 在父类写入前依次检查忽略规则和写入范围。

`src/agent/docs-only-backend.ts` · `OpenWikiLocalShellBackend.write`（第 146–159 行，节选）：

```ts
// 拒绝时不调用父类；成功结果携带后续页面校验需要的路径。
override async write(
  filePath: string,
  content: string,
): Promise<WriteResult> {
  const error =
    this.getIgnoredPathError(filePath) ??
    this.getDocsOnlyWriteError(filePath);

  if (error) {
    return { error };
  }

  return markMutation(await super.write(filePath, content), filePath);
}
```

`getIgnoredPathError` 拒绝 ignore 命中的路径；`getDocsOnlyWriteError` 仅在 `docsOnly` 开启且为 repository 模式时限制 Wiki 目录。chat 因 command 设置关闭 docs-only；local-wiki 即使传入 `docsOnly: true`，也会在该检查中直接放行，以便在虚拟根写页面。

允许的路径交给父类实际写入，失败返回错误。写入成功后，`markMutation` 把实际路径放入结果 metadata 的 `openwikiMutationPath` 字段，后续 OKF 中间件据此重新读取落盘文件并检查头部元数据。路径检查和内容检查通过这个字段衔接，详见 [03](./03-wiki-maintenance.md)。

### 路径先归一化，再判断目录

`isOpenWikiDocsPath` 处理斜杠及 `.`、`..`，再判断是否位于文档树。

`src/agent/docs-only-backend.ts` · `isOpenWikiDocsPath`（第 410–420 行，节选）：

```ts
export function isOpenWikiDocsPath(filePath: string): boolean {
  const slashed = filePath.trim().replace(/\\/gu, "/");
  // 在前缀检查前折叠 .. 和 .，避免 /openwiki/../AGENTS.md
  // 这类路径绕过 openwiki/ 的目录限制。
  const normalized = path.posix.normalize(`/${slashed.replace(/^\/+/u, "")}`);
  const virtualPath = normalized.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}
```

例如 `/openwiki/../AGENTS.md` 归一化后落到根目录的指令文件，会被 docs-only 拒绝。这里证明的是虚拟路径检查能处理这种字符串绕行，不宜扩大为对任意宿主机 I/O 的安全证明。

### 忽略规则覆盖多种文件入口

`read` 和 `readRaw` 直接拒绝被忽略路径；`ls`、`glob`、`grep` 过滤返回项；`write`、`edit` 执行忽略和写入范围检查；批量 `uploadFiles`、`downloadFiles` 按输入顺序返回逐项结果，允许项仍可成功。

这一区分影响异常处理：一次批量请求可能部分成功，并不具有整体回滚语义。`grep`、`glob` 也是在父类搜索结果上过滤，不能把“不向模型返回被排除结果”解释成“父类底层扫描绝不会触碰这些文件”。

## shell 的限制条件与 docs-only 不同

只有看过 `execute`，才能判断文件检查是否覆盖了其他执行入口：

`src/agent/docs-only-backend.ts` · `OpenWikiLocalShellBackend.execute`（第 326–339 行，节选）：

```ts
// 此入口检查活动 ignore 规则，不检查 docsOnly。
override async execute(command: string): Promise<ExecuteResponse> {
  if (
    this.openWikiIgnore.isActive &&
    !isAllowedShellCommandWithIgnore(command)
  ) {
    return {
      exitCode: 1,
      output: `Shell execute is restricted while ${OPENWIKI_IGNORE_FILE} is active. Use the file tools instead (read_file, ls, glob, grep) so ignored paths stay excluded.`,
      truncated: false,
    };
  }

  return super.execute(command);
}
```

这里没有检查 `this.docsOnly`。没有活动 ignore 规则时，命令直接交给父类；因此 repository 的 `write/edit` 被限制在 Wiki 下，并不足以保证 shell 也只能写 Wiki。个人来源提示词还允许用宿主机命令读取 raw 文件，这条能力是实际使用路径。

有活动规则时，源码中的命令白名单仅接受 `pwd`、可带 `--no-pager` 的 `git rev-parse HEAD`，以及固定形式的 `rm -f openwiki/_plan.md`。正则锚定整条命令，复合 shell 语句不会因为其中含有一个允许命令而放行。

这项实现换取了 ignore 规则启用时更窄的执行面，同时会拒绝许多普通 shell 查询。需要强制“Agent 只能改文档”的部署，应禁用或进一步限制 execute，或使用隔离环境及只读挂载；不能只设置 docs-only 后就作出这一保证。

## 提示词怎样影响模型，而不替代权限

`createSystemPrompt` 汇合输出目录、Wiki-first、证据引用、来源内容不可信、页面格式、子代理纪律和语言要求。`createUserPrompt` 提供本轮目标及证据摘要；`createRunUserMessage` 再说明运行根和工具路径，避免模型把宿主机绝对路径交给虚拟文件工具。

同一份 `.openwikiignore` 被送到三个位置：Git 摘要过滤、系统提示词说明、Backend 检查。这样模型既能看到范围约定，工具又能在特定入口拒绝越界请求。brief 和用户消息则主要改变内容重点，例如只补部署流程，不会修改 Backend 代码。

`syncBundledSkills` 在运行前更新内置 Skill 目录，保留其他自定义目录。graph 通过 `/skills/` 读取操作说明，模型按需加载具体内容。`_plan.md` 是提示词要求写入的页面规划，`write_todos` 管理执行中的任务清单；临时计划收尾会删除，两者不能替代长期 Wiki 页面。

子代理的约束也要落到配置看。系统提示词允许通过 `task` 做窄范围研究，要求子代理只检查和总结、由主 Agent 写入。当前工厂调用没有提供独立只读的 `subagents` 配置，因此这里只能确认协作纪律，不能宣称主、子代理已经实现独立写权限隔离。

## 消息和工具结果怎样进入下一轮

装配完成后，`streamEvents` 以本轮用户消息启动 graph，并用 `thread_id` 指定状态空间：

`src/agent/index.ts` · `runOpenWikiAgentCore`（第 383–390、393–398 行，节选）：

```ts
// 用户消息是 graph 的输入；thread_id 用于关联执行状态。
const input = {
  messages: [
    {
      role: "user",
      content: createRunUserMessage(command, cwd, context, options),
    },
  ],
};

// ……省略同一函数中与本节无关的语句。

const stream = await agent.streamEvents(input, {
  configurable: {
    thread_id: threadId,
  },
  version: "v3",
});
```

模型请求工具时，工具结果作为消息回到 graph，下一轮模型据此选择继续读取、修改文件或结束。本轮中间件追加的 YAML warning 也是通过工具结果被模型看到；应用无需把 warning 再单独拼一次用户消息。

应用外层逐个消费 chunk。`parseStreamEvent` 将 `messages` 事件提取成文本，将 `tools` 事件转换成工具事件，不认识或没有可展示文本的事件返回 null；子图消息还会标记 `source: "subgraph"`。这些是展示协议，不是 Wiki 的权威状态，页面是否变化仍由文件快照决定。

## 案例：raw 读取规则变化后怎样选择页面

假设 OpenWiki 正在维护自己的仓库 Wiki：本轮源码变更涉及 `src/connectors/tools.ts` 的 `readRawItem`，已有 `openwiki/integrations/connectors.md` 只介绍 raw 目录限制，尚未说明符号链接拒绝规则。函数和路径来自当前源码快照；这里推演一次可能的更新，不代表历史运行日志，页面选择也不是代码预先指定的结果。

设上次记录的提交为 H0，本次源码提交为 H1，工作区干净且该源码路径未被 ignore 排除。Wiki 语言保持不变、没有待翻译页、旧页面的 front matter 有效，本例因而可以集中观察正文更新。

### 从源码变更到本轮消息

`runOpenWikiAgent("update", ...)` 收到 repository 输出模式、仓库根和空用户消息后，会进入 Git no-op 判断。H0 到 H1 的差异包含 Wiki 之外的源码路径，所以本轮继续。

`createRunContext` 读取旧 metadata，`createGitSummary` 将变更路径及提交摘要放入 `gitSummary`；`createUserPrompt` 再把它与 Wiki brief 和旧 metadata 拼入用户消息。初始消息包含的是文件级线索，没有自动附上 `readRawItem` 的完整源码，也没有提供已计算好的“应修改页面数组”。

### 从变更线索到页面修改计划

update 的系统提示词要求模型建立影响计划：

`src/agent/prompt.ts` · `createModeInstructions`（第 311–314 行，提示词字符串节选）：

```text
- Before editing, build a docs impact plan from the changed source files: source change -> docs affected -> edit needed -> why. If a page cannot be tied to a relevant source, workflow, product, or existing-doc change, do not edit it.
- Update runs must be surgical. Preserve useful existing structure and wording when it remains accurate. Prefer replacing one stale sentence over adding new paragraphs.
- Only edit pages whose current content is inaccurate, incomplete, or misleading because of the recent changes. Do not refresh every page.
- Keep each concept in one canonical page. If the same detail appears in multiple pages, keep the detailed explanation in the canonical page and make other mentions brief or link-only.
```

中文含义是：为每项拟修改内容说明“源码变化 → 受影响文档 → 要改什么 → 为什么”，没有相关变化依据就不改；准确的结构和措辞继续保留。这条规则由 `createModeInstructions` 拼入系统提示词，当前代码没有实现沿源码依赖图传播变更、自动求出页面集合的算法。

在本例中，模型可能采取下面的工具序列。具体顺序和调用次数由模型选择，路径映射及写入检查则由代码执行。

| 动作 | 输入或读取位置 | 为下一步提供什么 |
| --- | --- | --- |
| 读取已有 Wiki 入口和主题 | `/openwiki/quickstart.md`、`/openwiki/integrations/connectors.md` | 连接器知识已有归属，以及旧页面缺少哪一段解释 |
| 定向搜索并读取源码 | 对 `/src/connectors/tools.ts` 使用 grep、read_file | 找到 `readRawItem` 及符号链接检查的实际调用 |
| 核对路径解析的上游约束 | 按需要读取 `/src/openwiki-home.ts` 的 `resolveConnectorRawPath` | 区分目录归属检查和符号链接检查，避免把两者混为一项 |
| 写临时计划 | `/openwiki/_plan.md` | 记录需要补充的证据和页面关系 |
| 修改主题页 | 对 `/openwiki/integrations/connectors.md` 调用 edit_file | 在原有 raw 读取说明处补充检查顺序和拒绝条件 |

这个选择依赖模型已经读到页面和源码。源码文件名变化并不自动要求新建一篇 Wiki；如果现有连接器页已经准确解释该规则，本例也可以不改正文。提示词里的少量页面预算属于软约束，Backend 不会据此计算允许改几页。

### 从编辑请求到下一轮反馈

修改目标通过 `CompositeBackend` 落到 Wiki Backend，`edit` 检查 ignore 和 docs-only 后调用父类替换文件内容。只有实际写入成功，`markMutation` 才附加 `openwikiMutationPath`；工具结果携带这个路径回到写后中间件。

若页面的 front matter 通过 OKF 校验，中间件原样返回工具结果；若模型意外破坏 YAML 或遗漏必需字段，就把 warning 加到工具消息，模型下一轮可以修正。这个回路中，“该补充哪条解释”属于模型判断，“刚写出的文件结构是否符合规则”属于代码检查。

正文改完仍未结束：本例的索引是否需要变化、何时写 H1、下一次是否能跳过，继续见 [03 的案例收尾](./03-wiki-maintenance.md)。
