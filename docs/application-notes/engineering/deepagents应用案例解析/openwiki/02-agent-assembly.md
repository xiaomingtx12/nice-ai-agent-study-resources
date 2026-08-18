---
title: 02：Deep Agents 的装配与能力边界
description: 从 runOpenWikiAgentCore 和 prompt.ts 追踪 OpenWiki 如何编写提示词、装配 Deep Agents，并在框架之上扩展证据接入、文件边界、文档校验和持续维护能力。
sidebar_position: 3
---

# OpenWiki 02：Deep Agents 的装配与能力边界

> 源码定位
> - Agent 装配：`src/agent/index.ts` - `runOpenWikiAgentCore`
> - 模型路由：`src/agent/index.ts` - `createModel`
> - Backend 与 Skills 挂载：`src/agent/index.ts` - `CompositeBackend` / `FilesystemBackend`
> - Backend 约束：`src/agent/docs-only-backend.ts`
> - Prompt：`src/agent/prompt.ts` - `createSystemPrompt` / `createUserPrompt`
> - 框架接口：`deepagents@1.11.1` - `createDeepAgent` / `SystemPromptConfig`

OpenWiki 没有自己实现 Agent loop，而是把 Wiki 所需的对象交给 Deep Agents 的 `createDeepAgent`，得到一张可流式执行的 LangGraph graph。理解这篇文章时，重点不是记住所有参数，而是分清三层：

```text
Deep Agents 默认能力：文件工具、write_todos、task、上下文管理
OpenWiki 注入：ChatModel、Connector 工具、Backend、Skills、permissions
Prompt 约定：Wiki 写作纪律、证据使用方式、子代理协作方式
```

三层的约束强度不同。Backend 和 permissions 可以拒绝一部分操作，Prompt 只能影响模型选择。

## 一、`createDeepAgent` 的参数就是 OpenWiki 的扩展面

源码调用可以简化成下面这样，参数名和结构保持不变：

```ts
const agent = createDeepAgent({
  model,
  tools: createOpenWikiConnectorTools(),
  checkpointer,
  backend,
  middleware,
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

| 参数 | OpenWiki 注入的对象 | 解决的问题 |
| --- | --- | --- |
| `model` | `createModel(...)` 的结果 | 用哪个模型运行 |
| `tools` | 7 个 Connector 工具 | 怎样摄取和读取外部证据 |
| `backend` | Wiki Backend + `/skills/` 路由 | 文件工具实际读写哪棵虚拟文件树 |
| `middleware` | Translation + OKF | 运行前翻译、写后校验、运行后收尾 |
| `skills` | `["/skills/"]` | 从哪里发现可按需加载的 Skill |
| `permissions` | 拒绝写 `/skills/**` | 防止 Agent 修改随包 Skill |
| `systemPrompt` | 动态 OpenWiki Prompt | 告诉模型 Wiki 目标和工作纪律 |
| `checkpointer` | `SqliteSaver` | 保存 graph state |

这张表是理解 OpenWiki 和 Deep Agents 关系的核心：Deep Agents 提供通用工作台，OpenWiki 把 Wiki 的目标、证据入口和文件边界注入进去。

## 二、Backend 决定 Agent 看到哪棵文件树

OpenWiki 先创建自己的 `OpenWikiLocalShellBackend`，再使用 `CompositeBackend` 挂载 Skills：

```ts
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

`/skills/` 前缀会路由到独立的 `FilesystemBackend`，其它路径进入 Wiki Backend。`virtualMode` 只是给 Agent 一套稳定的虚拟路径，不是操作系统级 sandbox。

在 repository `init/update` 中，`docsOnly` 让写入只能落在 `/openwiki/`；`.openwikiignore` 还会过滤和拒绝被排除的路径；`permissions` 则补充文件工具级规则，例如拒绝写 `/skills/**`。

这三种机制不是一层防护：

| 机制 | 负责什么 | 典型行为 |
| --- | --- | --- |
| `docsOnly` | repository run 的写入根目录 | `/openwiki/../AGENTS.md` 规范化后拒绝 |
| `.openwikiignore` | 统一过滤和拒绝被排除路径 | `read/write/edit` 拒绝，`ls/glob/grep` 过滤 |
| `permissions` | Deep Agents 文件工具的操作规则 | 拒绝写 `/skills/**` |

`virtualMode` 只提供稳定的虚拟路径，不是操作系统级 sandbox；`LocalShellBackend` 仍然代表宿主机 I/O 能力。

### Backend 是怎样扩展出来的

OpenWiki 没有重新实现 Deep Agents 的文件系统，而是继承 `LocalShellBackend`，在原有文件操作前后增加自己的规则：

```ts
class OpenWikiLocalShellBackend extends LocalShellBackend {
  override async write(path, content) {
    const error = checkIgnored(path) ?? checkDocsOnly(path);
    if (error) return { error };

    return markMutation(await super.write(path, content), path);
  }
}
```

真实实现覆写了几类方法：

| 覆写的方法 | OpenWiki 增加的处理 | 放行后的行为 |
| --- | --- | --- |
| `read`、`readRaw` | 拒绝读取 `.openwikiignore` 排除的路径 | 调用 `super.read` / `super.readRaw` |
| `write`、`edit` | 检查忽略规则和 `/openwiki/` 写入边界 | 调用父类写入，成功后记录变更路径 |
| `ls`、`glob`、`grep` | 不让被忽略的文件出现在发现结果中 | 调用父类搜索，再过滤结果 |
| `uploadFiles`、`downloadFiles` | 对批量路径逐项返回拒绝或成功结果 | 对允许的路径调用父类实现 |
| `execute` | `.openwikiignore` 生效时只允许极少数固定命令 | 否则调用父类 shell 执行 |

这里有两个关键设计。

第一，路径检查在 Backend 中执行，而不是只写在 Prompt 里。`isOpenWikiDocsPath` 会先把反斜杠、前导斜杠以及 `.`、`..` 片段规范化，再判断路径是否位于 `openwiki/` 下。因此 `/openwiki/../AGENTS.md` 不会因为字符串以 `/openwiki` 开头就被误放行。

第二，写入成功后，Backend 会把实际变更路径放进结果 metadata，使用的键是 `openwikiMutationPath`。这个 metadata 会随文件工具结果返回给 Middleware，供后续的 front matter 校验使用。Backend 不只负责“能不能写”，还把“刚才写了什么”传给了生命周期钩子。

因此，Backend 的扩展不是简单地换一个文件根目录，而是对 Deep Agents 的 `BackendProtocolV2` 做了一层领域适配：

```text
DeepAgents 文件工具
        ↓
OpenWikiLocalShellBackend
  先做路径和忽略规则检查
  再调用 LocalShellBackend
  最后记录写入结果
        ↓
真实 repository / openwiki/ 目录
```

`CompositeBackend` 则解决了第二棵文件树的问题：`/skills/` 被路由到独立的 `FilesystemBackend`，其它路径交给 Wiki Backend。再加上 `permissions` 拒绝写 `/skills/**`，随包 Skill 可以被 Agent 读取，却不能被 Agent 改写。

### 三层边界要分开看

OpenWiki 同时使用 Prompt、Deep Agents permissions 和 Backend，但它们不是同一回事：

| 层次 | 主要作用 | 可靠性 |
| --- | --- | --- |
| Prompt | 告诉模型应该先查 Wiki、不要改源码、怎样组织页面 | 软约束，模型可能不遵守 |
| `permissions` | 在 Deep Agents 文件工具层声明哪些操作拒绝 | 工具层约束 |
| `OpenWikiLocalShellBackend` | 在实际文件和 shell 操作前执行路径、忽略规则检查 | 代码硬边界 |

因此，Prompt 可以影响 Agent 的选择，但不能代替 Backend。即使仓库内容通过 Prompt Injection 诱导模型写入 `/AGENTS.md`，repository `init/update` 中的 Backend 仍然会拒绝这个写操作。反过来，Backend 也不负责判断“这篇架构说明是否写得好”，内容理解仍然需要模型。

## 三、Middleware 把 Wiki 规则接到 Agent 生命周期

OpenWiki 的自定义 Middleware 按命令组合：

| 命令 | 自定义 Middleware |
| --- | --- |
| `chat` | `[]` |
| `init` | `OpenWikiIndexMiddleware` |
| `update` | `OpenWikiTranslationMiddleware`、`OpenWikiIndexMiddleware` |

这里的 `middleware: []` 只表示没有 OpenWiki 自定义中间件。Deep Agents 自己的文件工具、规划和 `task` 等默认能力仍然存在。

`OpenWikiIndexMiddleware` 负责把 OKF、front matter、Mermaid 和 `index.md` 的部分规则放回代码；翻译计划则处理语言切换和 pending 页面。具体 hook 时序和失败传播见 [03 Wiki 怎样持续维护](./03-wiki-maintenance.md)。

### Middleware 是怎样扩展出来的

Middleware 不是另一个 Agent，也不是一次性的后处理脚本。OpenWiki 调用 LangChain 的 `createMiddleware`，返回一个带生命周期钩子的对象，再把它传给 `createDeepAgent`：

```ts
return createMiddleware({
  name: "OpenWikiIndexMiddleware",
  beforeAgent: async () => {
    await migrateWikiToOkf(backend, outputMode, conceptType);
  },
  wrapToolCall: async (request, handler) => {
    const result = await handler(request);
    return addFrontmatterWarning(
      result,
      backend,
      outputMode,
      request.toolCall.name,
    );
  },
  afterAgent: async () => {
    await validateWikiMermaid(backend, outputMode);
    await synchronizeWikiIndexes(backend, outputMode, labels, conceptType);
  },
});
```

三个 hook 的职责不同：

| Hook | 介入时间 | OpenWiki 的实现 |
| --- | --- | --- |
| `beforeAgent` | Agent loop 开始前 | 扫描已有 Wiki，为缺少有效 `type` 的页面补最小 OKF front matter |
| `wrapToolCall` | 每次工具调用经过时 | 先交给 `handler` 执行工具，再检查刚写入的 Markdown；发现 front matter 错误就把可操作的 warning 追加到 `ToolMessage` |
| `afterAgent` | Agent loop 结束后 | 修复无效 Mermaid fence，并确定性重建各级 `index.md` |

这里的 `wrapToolCall` 很有代表性。Middleware 不需要复制 `write_file` 的实现，也不直接修改 Agent state；它包住 Deep Agents 原本的工具调用，先让调用正常完成，再利用 Backend 写入时附加的 `openwikiMutationPath` 找到实际文件，读取落盘内容并校验。校验失败时，Middleware 通常追加 warning，让主 Agent 在下一轮看到错误并修正。

所以，Middleware 扩展的是“什么时候执行领域逻辑”，Backend 扩展的是“文件操作本身允许怎样发生”。两者组合后，OpenWiki 可以把结构约束放在代码里，同时保留 Agent 对正文内容的开放式组织能力。

## 四、Deep Agents 的能力怎样落到 Wiki 任务

Deep Agents 默认提供文件工具、`write_todos` 和 `task`。OpenWiki 再通过 Skills 和 Prompt 把它们变成文档工作流：

| 能力 | 在 Wiki 中的用途 |
| --- | --- |
| 文件工具 | 读取源码、保存草稿、修改概念页 |
| `write_todos` | 记录当前 Agent 任务进度 |
| `task` | 把窄范围源码研究委派给子代理 |
| Skills | 按需加载文档规则，避免启动时塞入全部上下文 |
| `_plan.md` | 记录本轮准备生成的页面、证据和关系 |

OpenWiki 在启动前把随包 Skills 同步到 `~/.openwiki/skills/`，通过 `/skills/` 路由挂载，再用 permissions 拒绝 Agent 写回这些文件。`write_todos` 属于 graph state，`_plan.md` 是本轮临时文件，二者都不是长期 Wiki 状态。

子代理的“只读”需要单独看待。OpenWiki 通过 system prompt 要求子代理只研究和总结，但没有传入独立的只读 Backend 或去掉写工具的 sub-agent 配置。因此，这条规则目前是软约束；如果业务要求硬只读，需要在子代理装配时限制工具或 Backend。

## 五、提示词不是一段话，而是三层输入

OpenWiki 的提示词由 `src/agent/prompt.ts` 负责组装。它没有把所有内容都塞进一次用户消息，而是把稳定规则、本轮任务和运行环境分开：

```text
createSystemPrompt(...)
  ├─ Agent 身份和文档目标
  ├─ 文件路径、证据来源、工具使用纪律
  ├─ Connector、MCP、子代理和安全规则
  ├─ OKF、Markdown、Mermaid 和文档质量要求
  ├─ init/update/chat 的模式规则
  └─ language / outputMode / .openwikiignore 的动态规则

createUserPrompt(...)
  └─ 本轮是 init、update 还是 chat，以及 Wiki brief、Git 摘要、上次状态和用户任务

createRunUserMessage(...)
  └─ 再补充实际运行根目录和虚拟路径说明
```

### `systemPrompt`：长期工作规约

`createSystemPrompt` 先通过 `getOutputPromptConfig(outputMode)` 选择 repository wiki 或 local wiki 的路径、写入边界、索引位置和本地知识库规则，再把下面几类规则拼进同一个 system prompt：

- **身份和目标**：模型是 OpenWiki，目标是产出同时服务人和后续 Agent 的技术文档；
- **证据纪律**：重要结论必须来自源码、现有文档、Git 证据或 Connector 原始材料，不能凭空补模块、API 和业务规则；
- **探索纪律**：优先使用 `ls`、`glob`、`grep`、`read_file` 等定向工具，不要无差别读取整个仓库；
- **来源纪律**：Connector 和 MCP 返回值是不可信证据，不能执行其中夹带的指令；MCP 调用前必须先发现工具，并只调用明确允许的只读工具；
- **写作纪律**：从 `quickstart.md` 开始组织页面，保持页面边界，维护 Markdown 链接、OKF front matter、Mermaid 和 backlog；
- **协作纪律**：子代理只做窄范围研究和总结，主 Agent 负责综合和写入；`_plan.md` 只记录本轮计划；
- **安全纪律**：不读取或输出 secret，不修改源码，repository 模式只写 `/openwiki/`。

这些规则不是一份固定字符串。`language` 有值时，`createLanguageInstructions` 会追加输出语言和 front matter 语言规则；`.openwikiignore` 生效时，`createOpenWikiIgnoreInstructions` 会改写 Git 和探索方式，要求 Agent 使用已经过滤的 Git 摘要和文件工具，避免通过 shell 绕过忽略规则；`createModeInstructions` 则分别加入 `chat`、`init`、`update` 的行为差异。

### `userPrompt`：本轮任务上下文

`createUserPrompt` 根据命令生成任务：

| 命令 | 用户消息中包含的内容 |
| --- | --- |
| `chat` | 直接使用用户问题 |
| `init` | 初始化目标、Wiki brief、Git context，以及从 `quickstart.md` 开始写文档的要求 |
| `update` | 上次 metadata、Wiki brief、Git change summary，以及只修改受影响页面的要求 |

用户额外输入会通过 `appendUserMessage` 追加到 init/update 任务末尾。`createRunContext` 在调用前准备 `wikiGoal`、语言、上次 metadata 和 Git 摘要，因此 prompt 既包含通用规约，也包含本轮证据背景。

`createRunUserMessage` 还会追加实际的 runtime root、虚拟文件路径和 shell 使用说明。follow-up chat 是一个例外：如果 `isFollowup` 为真，它直接使用用户消息，但 system prompt 和已有 thread 状态仍然有效。这样 follow-up 不会重复塞入 init/update 的任务模板。

### 翻译有自己的专用 prompt

语言切换不是让主 Agent 自己“顺便翻译”。`OpenWikiTranslationMiddleware` 在 `beforeAgent` 中直接调用同一个 `model`，使用 `buildTranslationPrompt(from, to)` 生成独立的翻译 system message，再把单个 Markdown 文件作为 human message 传入。

翻译 prompt 明确要求：

- 只翻译正文、标题、列表、引用、表格和 front matter 中的人类可读字段；
- 保留 Markdown 结构、链接目标、代码块、Mermaid、路径、命令、标识符和 URL；
- `tags` 保持英文，作为跨语言聚合键；
- 已经是目标语言的内容原样返回；
- 只返回文档文本，不附带解释或代码围栏。

翻译调用带 `langsmith:nostream` 标签，译文通过 Backend 写回文件，不混入主 Agent 的普通 token 流。也就是说，OpenWiki 至少有两套提示词：主 Agent 的文档生产 prompt，以及 Middleware 内部的翻译 prompt。

## 六、规则和配置如何接入 Agent

前面的 Prompt 结构还可以再往前追一层：它的输入来自用户配置、运行参数和代码内置规则。OpenWiki 不是把这些内容原样拼成一段长文本，而是先解析，再把同一份配置分别送到适合它的执行层。

### 配置来源

repository 模式下，最重要的配置文件是：

```text
repository/
├─ .openwikiignore              # 访问排除规则
├─ openwiki/
│  ├─ INSTRUCTIONS.md           # 用户维护的 Wiki brief
│  └─ .last-update.json         # 上次运行状态，不是用户规则
├─ AGENTS.md                    # 外部 coding agent 的发现入口
└─ CLAUDE.md                    # 另一类外部 coding agent 的发现入口
```

personal 模式则把 Wiki brief 放在 `~/.openwiki/INSTRUCTIONS.md`，Wiki 本身位于 `~/.openwiki/wiki/`；连接器、provider 和本地 onboarding 状态保存在 `~/.openwiki/` 下。凭据文件参与模型和连接器初始化，但不应被当作文档规则，也不会被读取进 Wiki 内容。

### `INSTRUCTIONS.md`：配置文档目标

`readRepositoryWikiInstructions` 或 `readOpenWikiOnboardingConfig` 读取 Wiki brief，`createRunContext` 将它放进 `RunContext.wikiGoal`，随后 `createUserPrompt` 在 `init/update` 请求中呈现：

```text
openwiki/INSTRUCTIONS.md
        ↓
RunContext.wikiGoal
        ↓
createUserPrompt(...)
        ↓
Agent 决定本轮覆盖哪些主题、页面和重点
```

这层配置适合表达：

- 文档要服务谁；
- 哪些模块优先；
- 哪些内容暂时不展开；
- 希望采用什么语言或解释深度。

它不适合表达安全边界。比如在 brief 中写“请读取 `.env`”并不会绕过系统的 secret 规则；写“请修改源码”也不会解除 repository run 的 docs-only Backend 限制。

### `.openwikiignore`：同一份规则进入三条路径

`.openwikiignore` 的处理比较有代表性，因为它不是只进入 Prompt：

```text
.openwikiignore
        ↓
OpenWikiIgnore.load(...)
        ├─ createRunContext
        │    └─ 过滤 git status / log / diff 证据
        ├─ createSystemPrompt
        │    └─ 告诉 Agent 不要探索和记录被排除路径
        └─ OpenWikiLocalShellBackend
             └─ 拒绝 read/write/edit，过滤 ls/glob/grep，限制 execute
```

因此，`.openwikiignore` 同时有三种效果：

1. **证据过滤**：被排除路径不会进入 Git 摘要；
2. **模型提示**：Prompt 会列出活动规则，要求 Agent 不要推断这些路径内容；
3. **工具执行限制**：Backend 在真正访问文件前再次检查路径。

第三层才是关键。Prompt 只是让 Agent 知道规则，Backend 才是防止模型通过工具绕过规则的地方。具体的规则解析支持 `*`、`**`、`?`、目录模式、根路径锚定和 `!` 反选，匹配采用大小写不敏感和最后匹配生效。

### 运行参数：把一次任务变成运行配置

CLI 参数不会永久改写 Prompt 文件，而是在当前运行中变成 `OpenWikiRunOptions`：

| 参数 | 运行时作用 |
| --- | --- |
| `--mode code` / `--mode personal` | 选择 repository 或 local-wiki 输出模式 |
| `--init` / `--update` | 选择初始生成或增量维护规则 |
| `--language zh-CN` | 设置目标语言；update 时可能触发翻译 Middleware |
| `--modelId <id>` | 选择本次 `ChatModel` |
| 用户消息 | 追加本轮具体目标，改变泛化的任务焦点 |

`createSystemPrompt` 接收 `command`、`outputMode`、`language` 和 `openWikiIgnore`；`createUserPrompt` 接收 `command`、`RunContext` 和用户消息。这样，稳定规则放在 system prompt，本轮变化放在 user prompt，文件和 shell 边界则进入 Backend。

### `AGENTS.md` 和 `CLAUDE.md`：给外部 Agent 的入口配置

`ensureCodeModeRepoSetup` 会维护这两个文件中的 OpenWiki 管理片段：

```md
## OpenWiki

This repository uses OpenWiki for recurring code documentation.
Start with `openwiki/quickstart.md`, then follow its links...
```

这段内容的作用是让外部 coding agent 找到 Wiki，不是给 OpenWiki 主 Agent 配置文档范围。OpenWiki 使用标记区间替换自己管理的片段，保留文件中的其它手写内容；`openwiki code --init` 还会按需创建定时更新 workflow，后续 update 不会覆盖已有 workflow 的自定义内容。

### 配置与代码边界

最终一次运行中，同一条规则可能同时有“提示层”和“执行层”：

```text
用户 / 仓库配置
        ↓
解析与规范化
        ↓
Prompt：告诉 Agent 应该怎样做
Backend：限制文件和 shell 实际能怎样做
Middleware：在生命周期固定位置执行校验、翻译和索引
        ↓
Agent 在允许的工作区内完成语义任务
```

所以，OpenWiki 的规则系统更像“配置驱动的代码编排”，不是“配置驱动的自主 Agent”。用户可以配置文档目标、来源和排除范围；代码决定这些配置如何进入 Prompt、Backend 和 Middleware；Agent 只在这些边界内完成探索、归纳和写作。

### 配置冲突时谁优先

可以把一次运行的有效规则理解成下面这条优先级：

```text
代码硬边界
  > Deep Agents permissions
  > OpenWiki system prompt
  > 本轮 user prompt（包含 Wiki brief 和用户消息）
  > Agent 自己的判断
```

这里的“大于”不是简单的字符串覆盖，而是约束能力更强。比如：

- Wiki brief 要求“只写 API 文档”，它可以缩小本轮内容范围；
- 用户消息要求“这次优先补充部署流程”，它可以改变当前任务重点；
- system prompt 仍会要求使用源码证据、维护 OKF 和保持页面链接；
- `permissions` 仍会拒绝写 `/skills/**`；
- Backend 仍会拒绝写 `/openwiki/` 之外的路径；
- Middleware 仍会在运行前后迁移 front matter、校验 Markdown 并同步索引。

因此，用户配置可以改变 Agent 的工作目标，却不能把一个不允许的动作变成允许动作。把这条优先级讲清楚，才能理解 OpenWiki 为什么没有把安全和一致性寄托在 Prompt 的服从度上。

## 七、在 Deep Agents 之上扩展了什么

Deep Agents 负责提供通用 Agent 工作台，OpenWiki 增加的是面向 Wiki 维护的业务层：

| 扩展能力 | 实现位置 | 增加了什么 |
| --- | --- | --- |
| Wiki 任务规约 | `src/agent/prompt.ts` | 把 init/update/chat、证据、页面组织、OKF 和安全要求变成动态 Prompt |
| 证据接入 | `src/connectors/tools.ts`、`src/connectors/mcp-runtime.ts` | 统一 Connector 工具、raw 文件落盘、MCP 工具发现和只读准入 |
| Wiki 文件边界 | `src/agent/docs-only-backend.ts` | 在 `LocalShellBackend` 上增加 `/openwiki/` 写入限制、`.openwikiignore` 过滤、shell allowlist 和路径规范化 |
| Skill 运行时 | `src/agent/skills.ts`、`CompositeBackend` | 同步内置 `SKILL.md`，通过 `/skills/` 按需加载，并禁止 Agent 修改随包 Skills |
| 文档结构校验 | `src/agent/okf-middleware.ts` | 迁移 front matter、写后校验 OKF、修复 Mermaid、确定性同步 `index.md` |
| 多语言维护 | `src/agent/translation-middleware.ts` | 在 update 前按语言计划重译页面，失败页面写入 pending 标记并在后续重试 |
| 增量更新 | `src/agent/utils.ts` | 用 Git 摘要、Wiki 快照、`.last-update.json` 和 no-op 判断决定是否需要运行 Agent |
| 失败恢复 | `src/agent/index.ts`、`src/agent/utils.ts` | 中断时清理 `_plan.md`、保存 interrupted 状态，避免下一次 update 被错误跳过 |
| 应用层事件 | `src/agent/index.ts` | 把 Deep Agents 的 v3 stream events 转成 OpenWiki 的 `text`、`tool_start`、`tool_end` 事件 |

其中，文件工具、`write_todos`、`task`、Backend 接口、Middleware hook 和 checkpoint 属于 Deep Agents/LangGraph 提供的基础设施；OpenWiki 做的是把这些接口接到 Wiki 的证据、文件、结构和维护规则上。

这一层扩展的重点不是“再造一个 Agent loop”，而是把通用能力变成领域能力：文件工具变成 Wiki 工作区，Middleware 变成文档结构检查器，Connector 工具变成证据入口，Prompt 变成写作和研究规约。

## 八、OpenWiki 的核心到底由谁完成

如果只看 `createDeepAgent`，容易误以为 OpenWiki 把整个文档系统都交给了 Agent。实际情况更接近“代码编排，Agent 负责语义判断”：

| 工作 | 主要由谁完成 | 说明 |
| --- | --- | --- |
| 读取哪些源码和外部证据 | Agent + Prompt | Agent 根据任务探索，Prompt 规定证据纪律；Connector 工具由代码提供 |
| 页面主题和正文怎么组织 | Agent | 这是最需要模型理解和归纳的部分 |
| 文件能不能读写 | Backend + permissions | 由代码执行路径和操作边界，Prompt 只能提示 |
| OKF 是否合规 | Middleware + OKF 函数 | 代码解析 YAML、补最小字段并反馈问题 |
| `index.md` 怎样生成 | `synchronizeWikiIndexes` | 代码遍历目录、读取 metadata、排序并渲染，Agent 不负责最终目录一致性 |
| Mermaid 是否可接受 | `validateWikiMermaid` | 代码校验并在必要时降级，避免坏图直接留在 Wiki |
| 翻译哪些页面 | Translation Middleware | 代码枚举页面、判断 pending、处理失败和重试；模型只负责翻译文本 |
| 是否需要运行 update | `getUpdateNoopStatus` | 代码比较 Git、Wiki 快照和上次 metadata，满足条件时直接跳过模型 |
| 运行失败怎样留下状态 | `persistRunMetadataIfChanged` 等运行代码 | 代码清理 `_plan.md`、写入 `interrupted`，防止下一次错误跳过 |

可以把一次运行简化成：

```text
代码准备上下文和边界
        ↓
Deep Agents 提供循环和工具调用
        ↓
Agent 做源码理解、页面规划和正文写作
        ↓
代码拦截写入、校验结构、同步索引、保存状态
```

因此，OpenWiki 的 Agent 并不是“拥有整个系统控制权的自主程序”。它更像被放进一个代码定义好的工作台里，负责那些难以用固定规则完成的事情：理解源码、判断主题边界、选择证据、组织解释和修正正文。越接近文件安全、格式一致性、索引生成、增量判断和失败恢复，越应该由代码完成。

## 九、事件流如何接入应用

提示词负责规定模型怎样工作，事件流负责把 graph 的运行过程交给应用层。

装配完成后，OpenWiki 启动 v3 event stream：

```ts
const stream = await agent.streamEvents(input, {
  configurable: { thread_id: threadId },
  version: "v3",
});

for await (const chunk of stream) {
  const event = parseStreamEvent(chunk);
  if (event) {
    options.onEvent?.(event);
  }
}
```

`parseStreamEvent` 把 `messages` 和 `tools` 两类协议事件转换成 OpenWiki 的应用层事件，应用层不需要理解每种 LangGraph chunk。

所以，OpenWiki 使用 Deep Agents 的方式可以概括为：

```text
统一 ChatModel
+ 受限文件 Backend
+ Connector 工具
+ Wiki Middleware
+ Skills / permissions / Prompt
→ 一张可流式执行、可保存状态、能维护 Markdown Wiki 的 graph
```

## 十、照搬时值得学习的地方

如果把 Deep Agents 用到别的知识库项目，最值得复用的是它的装配边界：

1. 用统一 `ChatModel` 隔离模型供应商差异；
2. 用 Backend 把文件工具接到领域文件树；
3. 用 Middleware 把确定性结构规则接到 Agent 生命周期；
4. 用 Prompt 表达协作纪律，但不把 Prompt 当权限系统；
5. 用事件流把 graph 运行过程转换成应用层协议。

这几层可以用于代码文档、知识库维护和其它需要“模型研究 + 文件写作 + 长期更新”的 Agent。
