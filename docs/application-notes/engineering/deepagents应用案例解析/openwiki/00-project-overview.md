---
title: 00：LLM Wiki 怎样生产并被 Agent 使用
description: 从运行上下文到概念页和语义链接，理解 OpenWiki 怎样组织知识、写入 Markdown，并供后续 Agent 按需读取。
sidebar_position: 1
---

# OpenWiki 00：LLM Wiki 怎样生产并被 Agent 使用

> 源码基线：OpenWiki `0.2.4`，commit `3076d557f8a14`；依赖锁定 `deepagents@1.11.1`。
>
> - 运行入口：`src/agent/index.ts` · `runOpenWikiAgent` / `runOpenWikiAgentCore`
> - 上下文：`src/agent/utils.ts` · `createRunContext`
> - 提示词：`src/agent/prompt.ts` · `createSystemPrompt` / `createUserPrompt` / `getOutputPromptConfig`
> - 外部 Agent 入口：`src/code-mode.ts` · `ensureCodeModeRepoSetup` / `createCodeModeAgentsSnippet`

OpenWiki 生成的 Wiki 是一组可以再次读取和更新的 Markdown 页面。一次文档任务会反复调用模型和工具：读取证据、选择页面、写入文件，再根据工具反馈修正。页面在运行过程中就会落盘，事件流结束后，应用再比较内容变化并保存运行记录。

以 repository 模式更新代码文档为例，源码和 Git 提供变化线索，已有 Wiki 提供页面结构，模型判断哪些解释需要修改。后续 coding agent 从 `quickstart.md` 和目录链接进入这些页面，按需补读源码。

## 命令决定任务，输出模式决定目录

`init`、`update`、`chat` 是三种命令；`repository` 和 `local-wiki` 是两种输出模式。它们分别回答“做什么”和“在哪棵文件树上做”。

| 输出模式 | 默认运行根 | 文件工具中的路径 | 主要证据 |
| --- | --- | --- | --- |
| `repository` | 目标代码仓库 | `/` 对应仓库，Wiki 在 `/openwiki/` | 源码、README、测试、Git，及可选运行记录 |
| `local-wiki` | `~/.openwiki/wiki/` | `/` 对应个人 Wiki，入口为 `/quickstart.md` | 来源采集结果、已有 Wiki、按来源要求读取的本地材料 |

这些路径是 Backend（文件后端）向工具暴露的虚拟路径。它把工具的读写请求转换成实际 I/O；虚拟根的存在本身不代表宿主机被隔离。

`src/agent/index.ts` · `runOpenWikiAgent`（第 131–132 行，节选）：

```ts
// 只有显式指定 outputMode，调用者传入的 cwd 才成为实际运行根。
const outputMode = options.outputMode ?? "local-wiki";
const runtimeCwd = options.outputMode ? cwd : openWikiLocalWikiDir;
```

调用者只传 `cwd`、没有显式传 `outputMode` 时，运行根仍然采用个人 Wiki 目录。CLI 的 code 模式会显式选择 repository，避免把个人知识页面和项目文档写到一起。

`init` 建立初始页面；`update` 维护已有页面；`chat` 处理交互消息。chat 不挂载文档翻译和索引中间件，也关闭 docs-only 写入检查，所以问答模式并不天然只读。

## 入口先判断是否需要启动模型

`runOpenWikiAgent` 加载运行环境、同步随包 Skills（可按需读取的操作说明），然后只在 repository 模式加载 `.openwikiignore`。该规则对象会继续传入 Git 摘要、提示词和 Backend。

无额外用户消息的 `update` 会调用 `getUpdateNoopStatus`，根据上次 Git HEAD、运行状态和当前变更判断是否可以跳过。返回 `skipped: true` 时不创建模型或执行图。这个入口实际没有额外检查 `outputMode === "repository"`；普通个人来源采集通过传入来源消息绕过这项 Git 判断，具体条件见 [03](./03-wiki-maintenance.md)。

需要继续运行时，外层完成模型服务商及认证准备，把 provider、modelId 和运行参数交给 `runOpenWikiAgentCore`。模型服务适配不是正文生产过程，主链只需知道它最终返回统一的聊天模型对象。

## RunContext 把本轮任务背景汇合起来

`RunContext` 是本轮运行上下文，存放目标语言、Wiki brief（用户维护的文档目标）、上次运行元数据和 Git 摘要。它不包含整个仓库，也不包含全部 Wiki 正文。

`src/agent/utils.ts` · `createRunContext`（第 57–67 行，节选）：

```ts
const lastUpdate = await readLastUpdate(cwd, outputMode);
// 优先采用经过校验的参数；否则继承 Wiki 已保存的语言，
// 避免未传 --language 的增量更新混用新旧语言。
const requestedLanguage = resolveLanguage(language).language;
// 默认英语明确保存为 en，让元数据及下一轮继承的语言都有具体值。
const effectiveLanguage = requestedLanguage ?? lastUpdate?.language ?? "en";
const languageContext = { language: effectiveLanguage };
const wikiGoal = await readRunWikiGoal(cwd, outputMode);
```

语言优先级是本轮合法参数、上次 metadata、默认 `en`。repository 的 brief 来自 `openwiki/INSTRUCTIONS.md`；个人模式通过 onboarding 配置读取 Wiki 目标。文件中的“重点解释数据流”会影响任务选择，但不会替工具添加写权限。

上下文按命令和输出模式分支：chat 的 Git 摘要是“不适用”；local-wiki 的摘要说明证据由 raw（原始材料）路径和连接器工具提供；repository 的 init/update 才调用 `createGitSummary` 获取变更线索。Git 与连接器的具体证据入口见 [01](./01-connectors-and-ingestion.md)。

`createUserPrompt` 把这些字段写入本轮消息：init 携带 brief 和 Git context；update 额外携带上次 metadata，要求只修改受影响页面。`src/agent/index.ts` 中的 `createRunUserMessage` 再补运行根和虚拟路径说明。后续对话若设置 `isFollowup` 且有非空消息，会直接采用该消息。

## 执行图通过工具逐页写入 Wiki

`runOpenWikiAgentCore` 在运行前记录 Wiki 内容快照，然后创建模型、状态保存器和 Backend。`createDeepAgent` 是 Deep Agents 的装配入口，将这些对象、连接器工具、提示词和 Middleware（生命周期中间件）组成可执行 graph。graph 在这里指模型调用、工具执行和生命周期 hook 连接成的运行结构，具体装配与文件边界见 [02](./02-agent-assembly.md)。

下面是一次成功文档运行的过程示意，模型选择的具体页面和工具次数并不固定：

```text
运行前：读取上下文，记录 Wiki 内容快照
  ↓
beforeAgent：update 按计划翻译旧页面，迁移缺失的页面元数据
  ↓
模型读取源码 / Wiki / 来源证据
  ↔ 工具返回文件内容、采集结果或错误
  ↓
按提示词要求写 _plan.md，再调用 write_file / edit_file 写概念页
  ↔ 写后结构校验把问题追加到工具结果，模型可继续修正
  ↓
afterAgent：检查 Mermaid，按文件树生成 index.md
  ↓
事件流结束：清理 _plan.md，比较快照，按条件保存运行元数据
```

`_plan.md` 记录本轮页面、证据和关系，属于提示词要求的临时工作文件；它不是代码预先计算的页面清单，也不是长期任务数据库。页面主题及跨页链接仍由模型选择，索引同步只保证目录清单与可见文件树对应。

写入是即时的。模型说“完成”之前，文件可能已经改变；后续调用失败也不会自动撤销这些变更。正常完成、部分完成和没有页面变化会在 [03](./03-wiki-maintenance.md) 对应不同的元数据处理。

## 页面正文、导航与运行记录各有用途

下面是 repository 产物目录的示意，业务页面名由模型根据项目决定：

```text
openwiki/
├─ INSTRUCTIONS.md       用户维护的 Wiki brief
├─ quickstart.md         模型维护的阅读入口
├─ index.md              代码根据当前目录重建
├─ architecture/
│  ├─ overview.md        模型维护的概念页
│  └─ index.md           代码根据子目录重建
└─ .last-update.json     应用保存的更新记录
```

普通概念页使用 OKF（Open Knowledge Format）front matter，即 Markdown 开头的 YAML 元数据块。OpenWiki 要求 `type` 是非空字符串；`title` 和 `description` 供目录生成器使用，`tags` 可以表达跨页分类。元数据可被程序检查，正文是否准确仍取决于证据与解释。

`index.md` 是派生导航，适合按目录重建；`quickstart.md` 则需要模型解释阅读顺序和项目重点。`INSTRUCTIONS.md` 属于用户输入，`.last-update.json` 属于更新协议，这两者都不能当作普通生成页面处理。

## 概念页和正文链接怎样组成知识结构

OpenWiki 要求每个概念有一个主要说明页面，其他页面引用它，而不是各自复制一段解释。一个概念可以是组件、工作流或领域对象，不必对应一个源码文件。例如，`src/ingestion.ts` 和 `src/agent/index.ts` 共同支撑“来源更新工作流”；单个入口文件里的模型适配、文件权限和运行收尾则可以属于不同主题。

`createSystemPrompt` 将这项组织要求写成概念节点与有向关系：

`src/agent/prompt.ts` · `createSystemPrompt`（第 156–160 行，提示词字符串节选）：

```text
OKF relationship modeling:
- Treat every non-reserved Markdown document as a concept node. Standard Markdown links between concept documents are directed relationship edges; tags, resource fields, directory placement, source-code references, and index.md links do not replace concept-to-concept links.
- Model meaningful runtime, dependency, ownership, data-flow, security, lifecycle, and user-flow relationships, not only navigation from ${output.quickstartPath}.
- Put a concept link in the sentence that explains the relationship. Use the surrounding prose to state its meaning, such as \`dispatches to\`, \`depends on\`, \`shares infrastructure with\`, \`is configured through\`, \`is surfaced by\`, or \`is secured by\`.
- Do not add links solely to increase graph density, and do not automatically add reciprocal links. Add an inverse link only when it helps explain the target concept and is supported by evidence.
```

这里有三种不同的信息，读者需要分别识别：

| 表达方式 | 回答的问题 | 例子 |
| --- | --- | --- |
| 概念页正文与 front matter | 这个对象是什么、怎样工作？ | Agent 工作流页解释采集后怎样启动 update |
| 正文中的跨页链接 | 两个概念之间是什么关系？ | 连接器“向 Agent 工作流提供证据” |
| quickstart、目录索引和标签 | 从哪里进入、哪些页面属于同类？ | integrations 目录列出连接器页，tags 标出 integration |

关系方向由链接所在页指向目标页，关系含义由附近的句子说明。下面是根据 `runSourceIngestion → runOpenWikiAgent` 调用关系编写的 Markdown 句子示意；页面路径采用本仓库 Wiki 已有位置：

```md
连接器把采集结果交给 [Agent 工作流](../agent/workflow.md)，由后者读取证据并更新知识页。
```

如果这句话位于 `openwiki/integrations/connectors.md`，它表达的是“连接器向工作流提供证据”。单独把两个页面放进同一个 index，或者给它们相同的 tag，并没有表达这一关系。反向链接也不自动成立，只有目标页需要解释来源时才补。

提示词还要求：证据支持时，一个实质概念应连接至少两个其他实质概念；孤立页面应补充关系、合并到较大主题，或者解释独立存在的原因。这个要求附带证据条件，不能为了数量创建空薄页面或无意义链接。初次生成倾向于少量完整页面，暂未覆盖的主题放入 quickstart 的 Backlog，并保留源码位置和暂缓原因。

这种知识关系图保存在 Markdown 链接及正文中；[02](./02-agent-assembly.md) 的 Agent graph 则是驱动模型与工具调用的执行图。当前文档维护代码会校验 front matter 并重建目录，但没有据此建立持久化的“源码文件 → 概念页”依赖图，也不会通过索引同步自动证明语义链接正确。概念划分、关系选择和关系完整性检查仍由模型按提示词完成。

这一取舍使 Wiki 保持普通文件，易于阅读和审阅；代价是跨页关系可能遗漏或过期。精确的变更影响计算若是产品要求，需要另行维护来源与页面的依赖信息，不能只依赖这些 Markdown 链接。

## 生成后的 Wiki 怎样进入下一次 Agent 上下文

OpenWiki 自己的提示词采用 Wiki-first：先读取 Wiki 能回答的部分，缺少细节、内容过期或用户要求原始证据时再回源。Wiki 保留在文件系统中，只有文件工具读回的页面片段才进入当前模型上下文；没有全库自动注入步骤。

外部 coding agent 通过仓库根的指令文件发现 Wiki。`ensureCodeModeRepoSetup` 在 `AGENTS.md` 和 `CLAUDE.md` 中维护 `OPENWIKI:START` 到 `OPENWIKI:END` 的片段，保留其他手写内容。`createCodeModeAgentsSnippet` 指向 `openwiki/quickstart.md`，并提示沿链接阅读架构、流程、领域概念和源码位置。

这条消费链是“加载仓库指令 → 找到 quickstart → 按链接读取主题 → 必要时核对源码”。它依赖外部 Agent 实际加载这些指令并调用文件工具。OpenWiki 不会为外部 Agent 注入永久记忆，也没有在这条路径中建立向量检索库。

这种文件式知识层适合能够访问同一工作区的 coding agent，页面可以随仓库一起审阅和维护。若消费端看不到文件树，需要另行提供文件服务或检索接口；若问题要求当前代码的精确行为，Wiki 提供定位方向，仍应回到所引用的实现。
