---
title: 00：LLM Wiki 怎样生产并被 Agent 使用
description: 从 OpenWiki 的源码追踪代码和外部证据如何进入 Wiki，以及生成后的 Wiki 怎样作为 Agent 可以按需读取的项目知识层。
sidebar_position: 1
---

# OpenWiki 00：LLM Wiki 是怎样生产出来的

> 源码定位
> - Agent 运行入口：`src/agent/index.ts` - `runOpenWikiAgent` / `runOpenWikiAgentCore`
> - 运行上下文与更新判断：`src/agent/utils.ts` - `createRunContext` / `getUpdateNoopStatus`
> - 目录与文档收尾：`src/agent/okf-middleware.ts` / `src/okf/index-sync.ts`
> - 运行时装配：`src/agent/index.ts` - `createModel` / `createDeepAgent`
>
> 本组文章对应 OpenWiki `0.2.4` 和 `deepagents@1.11.1`。重点是理解实现机制，不展开 CLI、凭据和各个 provider 的产品细节。

OpenWiki 维护的不是一次性生成的 Markdown，而是一份可以继续被 Agent 使用、也能随着源码变化逐步更新的 Wiki。

它的分工很简单：代码准备证据、限制文件访问并完成结构化收尾；Deep Agents 提供文件工具、任务规划和 Agent 循环；模型负责理解源码、组织主题和写正文。换句话说，OpenWiki 的核心控制面主要在代码里，Agent 更像一个受约束的语义工作者。模型可以决定页面怎么写，但不能单独决定能读写哪些路径，也不能取代索引、状态和校验逻辑。

## 一、先把 LLM Wiki 想清楚

LLM Wiki 不是把整个代码仓库复制成 Markdown，也不是一次 Prompt 直接返回一篇长文。它更像一层“给人读、也给 Agent 继续检索”的知识整理结果。

以一个代码仓库为例，原始材料可能是：

```text
src/agent/index.ts
src/connectors/
README.md
Git 提交记录
已有 openwiki 页面
```

Agent 读完这些材料后，会把它们整理成主题页面，例如：

```text
openwiki/
├─ quickstart.md
├─ architecture/
│  ├─ overview.md
│  └─ agent-harness.md
└─ integrations/
   └─ connectors.md
```

这些页面不是源码文件的逐个翻译。`overview.md` 可能把多个源码文件中的入口、状态、工具调用和写入流程合并成一个主题；`connectors.md` 则可能只保留连接器的共同机制，把 Gmail、Slack 等来源差异压缩到合适的位置。

所以，LLM Wiki 的核心工作是“从源码组织知识”，而不是“把源码改写一遍”。页面之间的 Markdown 链接还会表达依赖、调用、归属和数据流，方便人和后续 Agent 顺着关系继续阅读。

## 二、OKF 到底是什么

OKF 可以先理解成 Wiki 页面顶部的一小段结构化元数据规范。它不是正文，也不是另一种数据库；它让程序知道一个 Markdown 页面是什么、叫什么、如何被索引。

一个概念页可能长这样：

```md
---
type: Architecture
title: Agent Runtime
description: 说明 Agent 如何创建、运行并把结果写入 Wiki。
tags: [agent, runtime, wiki]
---

# Agent Runtime

这里是模型根据源码写出的正文。
```

其中：

- `type` 是页面类型，OpenWiki 当前要求它存在且是非空字符串；
- `title` 和 `description` 供人阅读，也供目录索引展示；
- `tags` 是可选的分类标签；
- 下面的 Markdown 正文才是页面真正的知识内容。

OpenWiki 的 OKF 约束来自 `src/okf/frontmatter.ts`。运行前，如果旧页面缺少可用的 `type`，代码会根据一级标题或文件名补一个最小 front matter；模型再有机会把 `type`、`title` 和 `description` 补得更准确。运行中，模型写完概念页后，Middleware 会重新读取落盘文件检查 front matter。

因此，OKF 解决的是“页面怎样被机器识别和维护”，不负责判断正文是否正确。正文是否准确，仍然要靠源码证据、模型归纳和人工复核。

`index.md` 是特殊情况。它是目录索引，不是普通概念页，OpenWiki 会根据目录和 front matter 确定性重建它；`INSTRUCTIONS.md` 是用户维护的 Wiki brief；`.last-update.json` 是运行状态，也不属于知识正文。

## 三、一次 Wiki 文件是怎么生产出来的

以 repository `init` 为例，过程可以拆成几个动作：

1. **准备上下文**：代码读取 Wiki brief、Git 摘要、语言和既有 Wiki 状态，组成 `RunContext`。
2. **创建 Agent**：OpenWiki 把模型、Connector 工具、文件 Backend、Prompt、Skills 和 Middleware 交给 `createDeepAgent`。
3. **调查源码**：模型通过 `ls`、`glob`、`grep`、`read_file` 和 Git 工具寻找入口、模块边界和运行关系。必要时可以用 `task` 让子代理做窄范围研究。
4. **写临时计划**：模型把准备创建的页面、证据和页面关系写进 `_plan.md`。它只是本轮工作文件，不是最终 Wiki 页面。
5. **调用文件工具写 Wiki**：模型根据证据调用 `write_file` 或 `edit_file`，直接在虚拟路径下创建 `quickstart.md`、章节页和概念页。Backend 再把这些操作落到真实的 `openwiki/` 目录。
6. **代码做结构收尾**：Middleware 检查 front matter，修复无效 Mermaid，按目录重建 `index.md`；运行结束后删除 `_plan.md`。
7. **保存更新依据**：程序比较运行前后的 Wiki 快照，并写入 `.last-update.json`，让下一次 `update` 知道从哪个 Git 状态继续检查。

关键点是：模型不是先在内存里生成一篇完整 Wiki，再由程序保存；它是在 Agent 循环中边读证据、边调用文件工具，逐个创建和修改 Markdown 文件。程序负责提供文件工作台和边界，模型负责决定页面内容和组织方式。

## 四、Wiki 的生产链

一次代码 Wiki 更新可以压缩成下面这条链：

```text
代码 / Git / Connector
        ↓
受限的原始证据和运行上下文
        ↓
Deep Agents Agent 循环
        ↓
Backend 写入 Wiki
        ↓
Middleware 校验、翻译、降级和索引同步
        ↓
内容快照与 .last-update.json
        ↓
下一次 update 继续维护
```

这条边界是理解 OpenWiki 的入口：模型做开放式判断，代码做可验证的限制和收尾。后面的文章分别追踪证据入口、Agent 装配、Deep Agents 能力以及持续维护。

## 五、规则与配置怎样进入一次运行

OpenWiki 的规则不是集中放在一个配置文件里，而是分成几层。每层解决的问题不同：

| 来源 | 典型位置 | 主要作用 | 谁真正执行 |
| --- | --- | --- | --- |
| Wiki brief | repository 模式的 `openwiki/INSTRUCTIONS.md`；personal 模式的 `~/.openwiki/INSTRUCTIONS.md` | 说明文档范围、重点和用户目标 | 代码读取后放进 Prompt，Agent 根据它组织内容 |
| 忽略规则 | repository 根目录的 `.openwikiignore` | 排除不应被读取、搜索、写入或展示的路径 | `OpenWikiIgnore`、Backend 和 Git 摘要代码 |
| 运行参数 | `--init`、`--update`、`--mode`、`--language`、`--modelId` 和用户消息 | 决定本次运行模式、语言、模型和具体任务 | CLI 解析器、运行时和 Prompt |
| 本地运行配置 | `~/.openwiki/onboarding.json`、`~/.openwiki/.env` | 保存 personal 模式的来源、连接器配置、provider 和凭据引用 | onboarding、connector 和 provider 代码 |
| 外部 Agent 入口 | repository 根目录的 `AGENTS.md`、`CLAUDE.md` | 告诉其他 coding agent 先去哪里发现 Wiki | 外部 coding agent 自己加载 |
| 内置系统规则 | `src/agent/prompt.ts`、`docs-only-backend.ts`、各 Middleware | 定义 OpenWiki 的研究、写作、安全、结构和维护纪律 | OpenWiki 代码、Backend 和 Middleware |

其中，`openwiki/INSTRUCTIONS.md` 是最值得用户直接维护的文件。它相当于 Wiki brief，例如：

```md
# Wiki brief

- 重点解释运行时架构、数据流和扩展点。
- 优先覆盖 API、存储和部署流程。
- 暂不展开 CLI 参数和 provider 产品差异。
```

程序在 `createRunContext` 阶段读取它，把内容放入 `RunContext.wikiGoal`；`createUserPrompt` 再把它放进 `init/update` 的用户消息。它影响“写什么、重点写到哪里”，但不能授权 Agent 读取 secret，也不能允许它把文件写到 `/openwiki` 之外。

`.openwikiignore` 则是访问范围配置，语法接近 `.gitignore`：

```gitignore
.env
secrets/
dist/
!dist/public-api.json
```

它不是只给模型看的提示。运行开始时，`OpenWikiIgnore.load` 解析规则；之后同一个规则对象会同时传给 Git 摘要、`createSystemPrompt` 和 `OpenWikiLocalShellBackend`。因此，被排除的路径会从发现结果和 Git 证据中消失，直接读取或写入会被拒绝；规则生效时，任意 shell 搜索也会被收紧为少量维护命令。最后一条匹配规则生效，所以 `!dist/public-api.json` 可以重新包含一个之前被排除的路径。

### 配置是怎样汇合的

repository `update` 的简化加载顺序如下：

```text
CLI / 环境变量 / 用户消息
          ↓
解析 command、mode、language、model
          ↓
加载 .openwikiignore
          ↓
createRunContext
  ├─ 读取 openwiki/INSTRUCTIONS.md
  ├─ 读取 openwiki/.last-update.json
  └─ 生成过滤后的 Git 摘要
          ↓
createSystemPrompt
  ├─ 内置 OpenWiki 规则
  ├─ repository / personal 模式规则
  ├─ language 规则
  └─ .openwikiignore 规则
          ↓
createDeepAgent
  ├─ Backend 接收 docsOnly 和 ignore
  ├─ Middleware 按 command 挂载
  └─ Agent 收到本轮 user prompt
```

`AGENTS.md` 和 `CLAUDE.md` 不在这条 Wiki 生成配置链的中心位置。`openwiki code` 的 CLI setup 会在其中写入或刷新一段受管理的 OpenWiki 入口，让外部 coding agent 知道先读取 `openwiki/quickstart.md`；但 OpenWiki Agent 不把它们当成 Wiki brief，也不负责根据正文内容改写它们。它们负责“发现 Wiki”，`INSTRUCTIONS.md` 才负责“告诉 OpenWiki 要写什么”。

### 哪些规则是软约束，哪些是硬边界

理解配置时，不能把所有内容都叫作 Prompt：

| 规则 | 例子 | 性质 |
| --- | --- | --- |
| 内容目标 | “重点说明数据流，暂不展开 CLI” | 进入 Prompt 的软约束 |
| 研究纪律 | “先读 quickstart，重要结论必须有源码证据” | 主要由 Prompt 影响 Agent 选择 |
| 文件访问 | “不能读 secrets，repository 模式只能写 `/openwiki/`” | Backend 和 `.openwikiignore` 的代码边界 |
| 页面结构 | OKF front matter、Mermaid、目录索引 | Middleware 和确定性函数处理 |
| 更新判断 | Git 是否有变化、Wiki 是否真的变化 | `getUpdateNoopStatus` 和快照代码处理 |
| 运行状态 | interrupted、metadata、pending translation | 运行收尾和 Middleware 处理 |

因此，OpenWiki 的配置模型不是“把规则写进一个大 Prompt”。它更接近：

```text
用户配置决定目标和范围
代码配置决定系统能做什么
Agent 负责在边界内完成理解和写作
```

## 六、生成后的 Wiki 怎样给 Agent 使用

Wiki 生成完成后，不会被整体拼接进下一次 Prompt，也不会自动变成模型的永久记忆。它首先是一组落盘的 Markdown 文件，Agent 通过文件工具按需读取。

以 repository 模式为例，生成结果位于：

```text
<repository>/openwiki/
├─ quickstart.md
├─ index.md
├─ architecture/
└─ integrations/
```

OpenWiki 会在运行消息中告诉 Agent，文件工具使用的虚拟根目录是仓库根目录，Wiki 位于 `/openwiki`。因此 Agent 看到的路径是：

```text
/openwiki/quickstart.md
/openwiki/index.md
/openwiki/architecture/overview.md
```

Agent 的典型读取过程是：

```text
先读 /openwiki/quickstart.md
        ↓
顺着 quickstart/index 中的链接定位主题
        ↓
用 glob、grep、read_file 定向读取相关页面
        ↓
把页面内容作为当前任务的上下文
        ↓
Wiki 不足时，再回到源码或原始证据
```

这也是 `src/agent/prompt.ts` 中 “Wiki-first” 规则的实际含义：普通问题先查 Wiki，Wiki 能回答时不再为了“保险”把整个源码仓库重新读一遍；只有 Wiki 缺失、过期、含糊、相互矛盾，或者用户明确要求查看最新源码时，才继续查源代码或 Connector 原始数据。

### OpenWiki 自己怎样使用 Wiki

OpenWiki 的 `chat` Agent 和生成 Agent 使用同一套文件工作台。`createSystemPrompt` 负责规定“先查 Wiki”，`createRunUserMessage` 负责说明当前运行根目录和虚拟路径，Deep Agents 的文件工具负责真正读取文件。

所以，运行时的分工是：

| 部分 | 作用 |
| --- | --- |
| `systemPrompt` | 告诉 Agent Wiki 在哪里、应该先读哪些入口、什么时候允许回源 |
| `createRunUserMessage` | 告诉 Agent `/` 对应哪个虚拟根目录，以及 `/openwiki` 的实际位置 |
| `Backend` | 把虚拟路径映射到真实目录，并执行文件读写边界 |
| `ls`、`glob`、`grep`、`read_file` | 让 Agent 按需发现和读取 Wiki 页面 |
| Markdown 链接和 `index.md` | 让 Agent 从入口页继续定位相关主题 |

这里没有一个“把 Wiki 全量塞给模型”的隐藏步骤。模型需要先调用文件工具，再把工具返回的相关页面放进当前上下文。这种方式能控制上下文规模，也允许 Agent 根据问题只读取架构、数据模型或某个集成页面。

### 外部 coding agent 怎样使用 repository Wiki

如果 OpenWiki 运行在 repository code mode，它还会在仓库根目录维护 `AGENTS.md` 和 `CLAUDE.md` 中的 OpenWiki 片段。片段的核心内容是：

```md
## OpenWiki

This repository uses OpenWiki for recurring code documentation.
Start with `openwiki/quickstart.md`, then follow its links...
```

外部 coding agent 启动后，通常会自动读取根目录的 Agent 指令文件，于是得到下面这条入口：

```text
Agent 启动
  ↓
读取 AGENTS.md / CLAUDE.md
  ↓
发现 openwiki/quickstart.md
  ↓
用自己的文件工具读取 Wiki
  ↓
结合 Wiki 定位源码、理解模块并完成任务
```

这里的 `AGENTS.md` 只是发现机制，不是 Wiki 内容注入器。它告诉 coding agent “先去哪里看”，真正的项目知识仍然来自后续读取的 Markdown 页面。DeepSWE 评测也采用同样的方式：把 `AGENTS.md` 和 `openwiki/` 一起放进 `/app`，不额外修改任务 Prompt。

在部分评测环境中，还会注册 `openwiki-retrieval-mcp`，提供针对 `/app` 和 `/app/openwiki` 的只读 `search`、`change_surface` 等检索能力。这是对文件读取的可选增强，不是 OpenWiki 生成 Wiki 后的默认必经步骤。即使没有这个 MCP，Agent 仍然可以通过 `AGENTS.md` 和普通文件工具使用 Wiki。

### Wiki 和源码之间是什么关系

Wiki 是经过整理的项目知识层，不是源码的替代品。Agent 使用它时可以遵循一个简单原则：

```text
Wiki 负责快速建立整体认识和定位方向
源码负责核对实现细节和最新行为
```

例如，用户询问“连接器怎样接入 Agent”，Agent 可以先读 Wiki 中的连接器和 Agent 装配页面，快速找到 `src/connectors/`、`src/agent/index.ts` 等源码入口；如果用户继续追问某个参数的精确默认值，Agent 再回到源码确认。

因此，Wiki 的价值不是让 Agent 永远不读源码，而是把“每次从零探索仓库”变成“先读已有地图，再针对问题核实”。它是一层可查询、可更新的外部知识，不是向量数据库，也不是模型内部记忆。

## 七、Wiki 的产物和边界

Wiki 的长期价值来自页面之间的关系和运行状态。

代码模式下，生成内容位于仓库的 `openwiki/` 目录。`quickstart.md` 是入口，目录 `index.md` 提供导航，概念页通过标准 Markdown 链接表达依赖、调用、归属和运行关系。普通概念页带 OKF front matter，`index.md` 和 `log.md` 是保留文档。

一个简化的目录形态如下：

```text
repository/
├─ openwiki/
│  ├─ INSTRUCTIONS.md       # 用户维护的 Wiki brief
│  ├─ quickstart.md         # 入口页
│  ├─ index.md              # 由 Middleware 同步
│  ├─ architecture/
│  │  ├─ overview.md
│  │  └─ index.md
│  └─ .last-update.json     # 增量更新依据
└─ src/
```

`index.md` 不是模型写作的一部分。OpenWiki 在运行结束时根据当前目录和页面清单重建它，模型只负责组织概念和正文。

`INSTRUCTIONS.md` 也不是生成页面。它是用户维护的 Wiki brief，告诉 Agent 文档范围和重点；正常运行会读取它，但不会把它当成普通概念页改写。

## 八、一次运行的最小闭环

`runOpenWikiAgent` 先准备 `RunContext`、Git 摘要、模型、Backend 和 Prompt，再由 `createDeepAgent` 组装成可流式执行的 graph。Agent 通过文件工具和 Connector 读取证据，写入 Wiki；Middleware 和运行收尾逻辑再处理 front matter、Mermaid、索引、快照和 metadata。

```text
代码 / Git / Connector
        ↓
RunContext + createDeepAgent
        ↓
Agent 读取证据并写 Wiki
        ↓
Middleware + metadata 收尾
        ↓
下一次 update 根据 Wiki 和状态继续工作
```

这也是 OpenWiki 和普通“调用模型生成文档”脚本的区别：它把一次生成放进了一个可重复运行的维护闭环。

## 九、怎么读后面的文章

这组文章不再按源码目录平铺，而是沿着 Wiki 的生产过程组织：

| 文章 | 主要问题 |
| --- | --- |
| [01：证据如何进入 Wiki](./01-connectors-and-ingestion.md) | Git、Connector、MCP 和原始文件怎样变成 Agent 可用的证据？ |
| [02：Deep Agents 的装配与能力边界](./02-agent-assembly.md) | `createDeepAgent`、文件工具、Skills、规划、Sub-agent 和权限怎样协作？ |
| [03：Wiki 怎样持续维护](./03-wiki-maintenance.md) | Middleware、快照、checkpoint、失败状态和测试怎样组成维护闭环？ |

Provider 路由和 CLI 只是外围：前者把不同模型适配成统一 `ChatModel`，后者把请求送到 `runOpenWikiAgent`。理解主链时知道这层存在即可。
