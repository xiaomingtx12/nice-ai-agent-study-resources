---
title: 06：Lint 与收尾——OKF、front matter 与校验
description: 模型写正文、程序保证结构的三个执行时机；OKF v0.2 的字段归属；收尾五步（mermaid、index 同步、链接校验、证据投影、来源戳记）与 log.md 的真实现状。
sidebar_position: 7
---

# Lint 与收尾：OKF、front matter 与校验

wiki 是模型的自由写作，但一个能被程序维护、被外部工具消费的知识库必须有严格不变的结构：每页的元数据字段、目录与实际页面的对应、链接的有效性、图表的可渲染性。OpenWiki 把这些**全部从模型手里收走**，由确定性代码保证——在三个时机执行。这一篇讲这三个时机，顺便把 `index.md` 和 `log.md` 的真实地位讲透。

## OKF v0.2：格式契约

OpenWiki 的页面遵循 [Google Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)——一个开放的"知识包"格式，遵循它的 wiki 可以被任何 OKF 感知的工具读取。对每页 front matter（Markdown 开头的 YAML 元数据），字段所有权划得很清楚：

- **模型必须写**：`type`（非空的概念类型）、`title`、`description`（面向检索的一两句话）、`tags`。这是 worker 提示词里的硬要求；
- **模型禁止写**：`generated`（谁、何时生成）、`verified`（谁、何时核验）、`sources`（来源投影）——这些是程序根据运行事实盖的章，模型编造一个"已验证"标签没有任何途径落盘；
- **模型必须保留**：不认识的扩展字段（别的生产者写的，除非确实错了）。

根目录 `index.md` 声明 `okf_version: "0.2"`；`index.md` 和 `log.md` 是 OKF 的**保留文档**——它们不是概念页，不参与概念页的校验、翻译、链接检查和图谱可视化。

## 三个执行时机

结构保证分布在运行的前、中、后（`src/agent/okf-middleware.ts` 的 `createOpenWikiIndexMiddleware`）。

**跑之前：迁移。** `prepareWikiForAuthoring` 先跑 `migrateWikiToOkf`——把存量页面（旧版本生成的、或人手改过的）的 front matter 规范化成合法 OKF 块，代码推导出来的 `type` / `title` 打上 `openwiki_generated: true` 标记。这样 agent 一开工面对的就是格式一致的 wiki，它也能顺手把这些"代码推导"的页面充实成真正写过的内容。同时给所有页面拍一份正文快照（provenance snapshot），收尾时用来判断"谁真的变了"。

**写入时：修复。** 每次文件工具（`write_file` / `edit_file`）成功执行后，中间件立即对落盘文件跑 `repairPersistedFile` 修复 front matter。修复能落盘就静默通过；修不了（比如文件被并发改坏）就在工具结果后面追加一条 WARNING 告诉模型哪里不合法、要求重写——错误就地反馈给正在写的那轮对话，而不是收尾时才发现。

**跑之后：收尾五步。** `finalizeWikiArtifacts`（`src/agent/wiki-finalizer.ts`）按固定顺序执行五个确定性操作：

```text
mermaid → index_sync → link_validation → claims_sources → generated_provenance
```

## 收尾五步逐个看

**① mermaid 校验。** OpenWiki 的页面鼓励嵌 Mermaid 图（流程、状态、ER、时序）。收尾时校验每个 `mermaid` 代码块，渲染不了的**就地降级成 `text` 代码块**，并附一行注释说明原因——读者看到的是可读文本而不是渲染报错。下一次 update 会找到那段注释、尝试重新生成图，质量随运行轮次自愈。默认校验是零依赖的轻量检查；装上 `mermaid` + `jsdom` 包则用真渲染器做权威校验（CI 里值得装）。

**② index 同步。** `synchronizeWikiIndexes`（`src/okf/index-sync.ts`）为每个目录确定性生成 `index.md`：列出该目录的页面（用每页 front matter 的 `title` 和 `description` 渲染）和子目录，内容与现状相同就不重写。根目录的 `index.md` 额外带 `okf_version: "0.2"` front matter。模型从头到尾不碰这些文件——规划提示词明确"index 页由程序生成，不许列入计划"。

索引的标题是**按 wiki 语言本地化**的：`resolveIndexLabels` / `resolveConceptTypeLabel`（`src/okf/index-labels.ts`）为每种语言提供一组静态映射，没覆盖的语言回退英文。Open SWE 那份中文 wiki 的根 index 里写"# 文件""# 目录"，就是这套映射的输出；程序兜底修复 front matter 时补的 `type` 值也走同一份本地化。

**③ 链接校验。** `validateWikiInternalLinks` 检查页面之间的站内链接。`index.md`、`log.md`、`INSTRUCTIONS.md` 被排除（它们的内容由别的机制保证）。这与 worker 提示词里的相对链接规则（见 [03](./03-agents-and-tools.md)）配合：提示词教模型怎么写对，校验兜住没写对的。

**④ 证据投影。** `synchronizeClaimSources` 把 `.claims/` 里登记的证据资源投影到每页 front matter 的 `sources` 字段——页面自己声明"我的事实依据是这些 `repo://` 资源"。OpenWiki 只重写自己确定性识别的条目，独立作者手工写的 sources 原样保留。

**⑤ 来源戳记。** `finalizeGeneratedProvenance` 给本轮**新写或正文真的变了**的页面盖 `generated: {by: openwiki/<version>, at: <时间>}`。规则很精细：正文任何变化（包括空白）都推进戳记；正文没变就保留上一次的事件；只改了 front matter 不推进。时间戳是整轮共享的一个值，同轮写下的页面时间一致，保证可复现。

## 语言切换：wiki 的语言是持久状态

`.last-update.json` 里的 `language` 字段不只是记录。`resolveTranslationPlan`（`src/agent/translation-middleware.ts`）把它当作 wiki 的持久状态来处理：

- update 继承已有语言；`--language` 请求了**主要子标签不同**的语言（`en` → `zh-CN` 触发，`en` → `en-GB` 不触发，避免为地区差异全量重译）时，判定这是一次真正的语言切换；
- 切换发生时，翻译中间件在 `beforeAgent` 阶段做一轮全量翻译——不先翻译，增量更新就会在新旧两种语言上各写一半，留下混合语言的 wiki；
- 翻译不完的页面打上"待翻译"front matter 标记，任何一次后续 update 都会重扫这些挂起页，不管这次有没有切语言；
- `index.md`、`log.md`、`INSTRUCTIONS.md` 永不翻译（前两者确定性再生成，后者是用户手写的）。

两个工程细节见微知著：翻译用的模型调用被打了 `langsmith:nostream` 标签——否则逐 token 的整页译文会在终端 UI 里刷屏，替换成一行"Translating wiki docs..."；与运行状态联动的是，语言切换会把 `requiredRewritePages` 填满（见 [02](./02-generation-lifecycle.md) 的 `.run.json` 字段），让计划层也知道"这轮每页都要动"。

## log.md 的真实现状

概念篇说过 LLM Wiki 惯例里 `log.md` 承担审计日志。OpenWiki 对它的处理值得单独讲，因为**格式与实现在这里故意留了一道缝**：

- OKF 规范把 `log.md` 定为保留文档，OpenWiki 全链路尊重这个保留——它被排除在概念页校验、翻译、链接检查、mermaid 校验和图可视化之外（各文件里都有一个 `EXCLUDED_FILES` 集合）；
- 但当前版本**并不生成或写入** `log.md`。你在任何实际生成的 wiki 里都找不到它。

审计职责实际由这些承担：`.last-update.json`（整轮何时、何模型、何种状态）、`.page-manifest.json`（每页何时覆盖到哪个提交）、`.claims/`（每条事实的依据与核验历史）、git 历史（每次编译一个 diff）。效果上等价于一份结构化的 log，只是没落进 `log.md` 这个文件名。保留名不写内容，像是给未来的 OKF 工具互操作留的位置。

## 可视化：wiki 的另一张脸

`openwiki visualize` 把 wiki 渲染成交互式节点图加并排的 Markdown 阅读器，本地回环地址起服务，文件改动实时反映到图上。`--export` 可以导出纯静态目录（`index.html` + `graph.json` 等），直接扔给 GitHub Pages 托管——Credit Genie 团队的文档门户就是这种用法。

到这里，code 模式的三种操作全部走完。下一篇看另一条 Ingest 流水线：[07：个人 Wiki 与连接器](./07-personal-wiki-and-connectors.md)。
