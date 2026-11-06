---
title: 05：检索与跨仓库工作区
description: openwiki_search 的 FTS5 索引与排序规则、openwiki_read 的完整章节读取、工作区范围选择，以及 AGENTS.md 里的按需检索指引。
sidebar_position: 6
---

# 检索与跨仓库工作区

wiki 的价值在编译之后兑现：后续的代码任务能快速找到并读进相关知识。OpenWiki 的查询侧刻意做得极轻——**本地、只读、不调模型**。`openwiki_search` 找相关章节，`openwiki_read` 读完整内容，两个工具都不启动生成、不消耗 token。代码在 `src/retrieval/wiki.ts` 和 `src/integrations/core/retrieval-tools.ts`。

## 从具体疑问出发，而不是每次先扫 wiki

宿主 Agent 装好集成后，OpenWiki 会在仓库根的 `AGENTS.md` 里维护一段自己的指令块（`<!-- OPENWIKI:START -->…<!-- OPENWIKI:END -->` 之间，其余内容不动；已有 `CLAUDE.md` 时同步刷新其中一行 `@AGENTS.md` 导入）。指引是选择性的：

- 用户要求查 wiki、不熟悉的架构或依赖行为实质影响任务、或看过源码仍有重要疑问时，才检索；
- 找到就停，不要顺着链接无限展开；
- 工具不可用时，退回直接读 `openwiki/quickstart.md` 再顺链接走。

wiki 是按需上下文，不是每个任务的起手式。

## 两步走：先搜后读

`openwiki_search` 收一个具体问题（可选：源码路径提示、结果上限、工作区），返回紧凑的候选——页面标题、章节、描述、摘录和可继续读取的锚点引用。Agent 挑中几个后用 `openwiki_read` 拿到选中章节的**完整正文**。

分两步是刻意的：搜索控制候选数量（不一次返回整套文档），读取保留完整解释（Agent 不凭摘要做决定）。章节里那些条件、例外、失败分支往往正是改代码时需要的。

两步之间页面可能变了。`readWikiSections` 每次重新读实际 Markdown、校验锚点，锚点不存在就报错——不猜一个"最相近的章节"返回，调用方据此重新搜索。读取也没有模型摘要这一步，就是文件内容本身。

## 搜索怎么排序：内存里的 FTS5

`searchWiki` 的实现朴素得几乎让人意外：每次调用时遍历范围内的 wiki 页面，把 Markdown 按标题切成章节单元，建一个**内存 SQLite FTS5 索引**，查完即弃。真实初始化代码：

```ts
const { DatabaseSync } = await import("node:sqlite");
const database = new DatabaseSync(":memory:");
try {
  database.exec(
    "CREATE VIRTUAL TABLE units USING fts5(title, description, heading, prose, identifiers, tokenize='porter unicode61')",
  );
  // ……写入搜索单元、执行查询、生成结果。
} finally {
  database.close();
}
```

FTS5 是 SQLite 的全文检索扩展（Node 内置，零依赖），porter + unicode61 分词。五个索引列各司其职，BM25 相关性权重是 `8 / 4 / 6 / 1 / 3`——标题和章节标题比正文重得多，标识符单独一列让函数名、命令名可直接命中。没有 embedding、没有向量库、没有模型重排。

### 什么内容进索引，怎么切

语料枚举和切分都在 `searchWiki` 里完成，规则比看起来细：

- **哪些文件**：用 `ClaimsStore.discoverPages()` 枚举生成的事实页（[04](./04-claims.md) 的存储同时是页面发现的权威），再过滤掉路径里含隐藏段的页面；front matter 里 `status: deprecated` 的页面整体跳过。
- **怎么切**：按标题切单元，只有 `##` 二级标题成为独立章节单元，且"Related pages / See also / Navigation"这类导航性标题不建单元；第一个 `##` 之前、跟在页面 `#` 标题后的导语单独成一个"仅导语"单元；整页没有 `##` 时退化为一个大单元（锚点取 H1）。
- **锚点**：完全复刻 GitHub 的 slug 规则，包括重名标题加数字后缀（`#标题`、`#标题-1`），以及纯符号标题（slug 为空）别名成固定锚点——不然读取时按锚点查章节会静默错位。
- **identifiers 列的内容**：页面相对路径 + front matter `tags` + **`sources` 字段投影出的源码路径**。最后一条把检索和 Claims 串了起来：`sources` 是收尾时从证据投影来的（见 [06](./06-finalize-and-okf.md)），所以"路径提示"能命中，靠的正是证据链——一页引用了 `src/retrieval/wiki.ts`，搜这个路径才会把这页顶上来。
- **摘录**：结果里的 excerpt 不是章节开头，而是围绕查询词挑的相关片段；查询词先过停用词表，全被过滤掉就直接返回空结果。

入口参数本身有硬限制（`WIKI_RETRIEVAL_LIMITS`）：查询最长 2000 字符、路径提示最多 20 条、结果数有上限——超界直接报错而不是截断，让调用方自己收敛问题。

### 怎么排序

查询词归一化转义后以 OR 组合进 MATCH，部分词命中也能进候选。最后在应用层做总排序：

```ts
ranked.sort((left, right) => {
  const leftId = Number(left.rowid);
  const rightId = Number(right.rowid);
  return (
    pathScores[rightId - 1] - pathScores[leftId - 1] ||   // 源码路径提示命中数
    (coverage.get(rightId) ?? 0) - (coverage.get(leftId) ?? 0) ||  // 查询词覆盖
    left.score - right.score ||                            // BM25 分
    leftId - rightId                                       // 稳定行号
  );
});
```

四级依次比较：路径提示命中数 → 查询词覆盖数 → BM25 → 稳定序。注意路径提示是**加权不是过滤**——完全不匹配文本查询的单元进不了候选，但同样匹配时"我正在改 `src/retrieval/` 下的代码"这类提示会把相关章节顶到前面。

每次重建索引的取舍：好处是索引永远和当前 Markdown 一致（编辑后立刻可搜，没有异步刷新窗口），代价是建索引成本随文档规模线性增长。对单仓库规模的 wiki 这是笔划算的买卖；跨仓库大集合就要重新评估了。

## 工作区：跨仓库搜索的范围

一个服务常常拆在几个仓库里（控制面、数据面、基础设施）。`openwiki link` 把多个已有 wiki 注册进一个具名工作区（注册表存在 `~/.openwiki`，各仓库的 wiki 原地不动，一个仓库可以属于多个工作区）。

搜索时范围怎么定（`resolveWikiSearchScope`，`src/linking/wiki-workspaces.ts`）：

| 当前状态 | 搜索范围 |
| --- | --- |
| 不属于任何工作区 | 只搜本仓库自己的 wiki |
| 只属于一个工作区 | 自动用这个工作区 |
| 属于多个，已设活动工作区 | 用活动工作区 |
| 属于多个，没有选择 | 返回 `workspace_required` 和候选清单 |
| 显式指定了工作区 | 校验成员关系后使用 |

歧义时宁可反问也不默认扩大范围——跨仓库搜索搞错范围，返回的就是另一个系统的答案。宿主指引要求 Agent 把选项摆给用户选，带工作区 id 重试。

跨仓库结果都带 `wiki` 标识，后续 `openwiki_read` 要把它和页面、章节锚点一起传回——两个仓库都有 `architecture/runtime.md` 时靠它区分。配套的发现工具有 `openwiki_list_workspaces`（查成员关系）和 `openwiki_list_wikis`（查工作区内容）。

## 新鲜度：搜索不等于复核

检索读的是当前文件，所以 wiki 一更新，下一次搜索立刻反映新内容，没有索引滞后。但搜索路径**不重跑** Claims 预检——搜到一页不代表这页所有事实此刻仍被源码支撑，那要等下一次 update。

这解释了整个系统的分工：定时 update（或宿主里的"更新这个仓库的 OpenWiki"）缩短代码变化到知识修订的延迟，检索保证延迟窗口内也能定位到正确章节；真正改关键逻辑前，Agent 仍应回源码核对——wiki 给的是理解和线索，不是免检的真理。

最后一块拼图在下一篇：wiki 自身的健康由谁保证——[06：Lint 与收尾](./06-finalize-and-okf.md)。
