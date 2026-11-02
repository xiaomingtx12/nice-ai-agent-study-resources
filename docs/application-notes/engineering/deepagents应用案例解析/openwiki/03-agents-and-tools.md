---
title: 03：编译——规划器与页面 worker 的装配
description: createDeepAgent 的真实参数、只读规划器与单页 worker 的工具面和写权限、并发 worker 池与限流降档，以及为什么不用 checkpointer。
sidebar_position: 4
---

# 编译：规划器与页面 worker 的装配

上一篇讲了生命周期"账本"，这一篇讲"干活的人"。OpenWiki 的原生路径用 Deep Agents 执行研究：一个规划器 Agent 决定写哪些页，每页一个全新 worker Agent 负责写。它们都被刻意装配得很窄——工具少、权限小、没有委派。装配代码在 `src/agent/repository-runner.ts`。

## 分工：模型做语义，程序做记账

先看 `runOpenWikiAgent`（`src/agent/index.ts`）怎么分流。命令是仓库 init/update 时进入 `runNativeRepositoryGeneration`：先调共享核心的 begin——如果返回 no-op，直接结束，**规划器和 worker 一个都不会创建**。需要工作时，根据持久状态决定先规划还是继续未完成的页面。

`createDeepAgent` 是 Deep Agents 的工厂函数：把模型、工具、提示词、文件后端和中间件装配成一个可执行的 Agent 循环。OpenWiki 对它的用法可以概括为一句话：工厂负责"一次 Agent 怎么跑工具循环"，页面队列和验收全部留在 OpenWiki 自己手里。

## 规划器：只许研究，不许动笔

规划器的真实装配：

```ts
const agent = createDeepAgent({
  name: PLANNER_AGENT_NAME,
  model,
  tools: [submitPlanTool],
  backend,
  middleware: [
    createFilesystemMiddleware({
      backend,
      permissions: AGENT_FILESYSTEM_PERMISSIONS,
      tools: PLANNER_FILESYSTEM_TOOLS,   // read_file / ls / glob / grep
    }),
    NO_DELEGATION_MIDDLEWARE,
  ],
  skills: ["/skills/"],
  subagents: [],
  permissions: AGENT_FILESYSTEM_PERMISSIONS,
  systemPrompt: createRepositoryPlannerPrompt(view, planningContext),
});
```

文件工具只有四个读操作：`read_file`、`ls`、`glob`、`grep`。规划器可以任意浏览和搜索仓库，唯一的输出动作是调用 `submit_plan`——一个 `DynamicStructuredTool`，参数就是上一篇的 `PlanPageSchema`。它交不出有效计划，运行器不会把一段自然语言总结当计划用。

提示词之外还有硬约束：规划器和页面 worker 用同一个后端类，区别只在 `writableWikiPages` 参数——规划器传入空数组：

```ts
const wikiBackend = new OpenWikiLocalShellBackend({
  docsOnly: true,
  writableWikiPages: [],        // 规划器：什么都写不了
  // …
});
```

写入拒绝由后端的 `getDocsOnlyWriteError` 执行，不靠提示词里一句"请不要改文件"。

## 页面 worker：读得广，写得窄

`runPageAgent` 为每一页创建全新的 Agent。后端只多了一个参数：

```ts
const snapshot = await captureRepositoryPageSnapshot(run, job.id);
const wikiBackend = new OpenWikiLocalShellBackend({
  docsOnly: true,
  writableWikiPages: [job.path],   // 只能写分给自己的这一页
  // …
});
```

`getDocsOnlyWriteError` 的检查分两步：写入路径必须落在 wiki 树内，且必须命中本页白名单。worker 可以读整个仓库的源码和别的页面，但不能改别人的一页——"读得广"服务跨文件理解，"写得窄"让并发写作互不覆盖。路径在进白名单比较前会先做规范化（canonicalize），防拼写变体绕过。

两个容易误会的类名行为：`OpenWikiLocalShellBackend` 虽然叫 Shell，这条路径暴露的页面文件工具里**没有 shell 执行**；`virtualMode: true` 只是把工具看到的路径映射到仓库根（worker 写 `/openwiki/...`、读 `/src/...`），不是操作系统级沙箱。

worker 的工具面是四个文件操作加两个提交工具：

- `inspect_claims`——按需查看本页完整的 Claim 集合。领任务时已附带需要处理的问题 Claim，所以只有打算主动改写原本没问题的内容时才需要调它；
- `submit_page`——提交页面与**稀疏**的 Claim 决策：确认（`confirmedClaimIds`）、修订或新增（`claims`）、撤回（`retractedClaimIds`）。没问题且不涉及本次修改的旧 Claim 不用重交，程序自动保留。参数错误会以 `invalid_input` 反馈给模型，读完错误修正后可以再交。

提示词（`createRepositoryPagePrompt`）里几个值得注意的硬要求：页面必须以合法 OKF front matter 开头（`type` / `title` / `description` / `tags`），但**不许**自己编 `generated` / `verified` / `sources` 这些控制字段——那是程序的地盘；站内链接必须用相对路径（`../concepts/model-providers.md`），虚拟工具路径 `/openwiki/...` 不是发布后的链接地址；证据必须是 `repo://` 开头的规范 URI。

## Skills：随包分发的操作手册

装配代码里的 `skills: ["/skills/"]` 不是装饰。Deep Agents 把它挂成虚拟路径 `/skills/`，Agent 按需读取里面的 `SKILL.md`；这个虚拟路径在 `createAgentBackend`（`src/agent/agent-backend.ts`）里映射到 `~/.openwiki/skills`。

包里带两个技能（仓库根的 `skills/` 目录）：

- **`mermaid-diagrams`**——什么时候该嵌图（运行流程用 `sequenceDiagram`、生命周期用 `stateDiagram-v2`、数据模型用 ER 图），以及"更新一页时如果它已有 mermaid 块或上一轮被降级的 text 块，要维护图"——这正是 [06](./06-finalize-and-okf.md) 里"坏图自愈"的提示词侧配合；
- **`write-connector`**——面向改 OpenWiki 本身的开发者：如何新增一个内置连接器，以及"来源已经有只读 MCP 服务器时优先用 `custom-mcp` 连接器而不是加新 ConnectorId"。

同步机制在 `src/agent/skills.ts`：每次运行前把包内技能复制进 `~/.openwiki/skills`，用"临时目录暂存 + 原子 `rename` 换入"的方式替换，源码注释里记了两个真实翻车教训——直接覆盖不是幂等的（两个 `--init` 并发时 `cp` 内部的 mkdir 会撞 EEXIST，#499）；Nix 这类只读安装源复制出来的目录没有写位，后续原子换入和清理都会失败，所以先递归补上 owner-write（#633）。不相关的第三方技能放在同一目录里不受影响。

## 把框架默认能力关掉：无委派中间件

Deep Agents 框架支持子 Agent 委派（`task` 工具）。源码注释指出，即使传入空 `subagents`，DeepAgents 1.12 仍会加一个通用 `task` 工具。OpenWiki 明确不要这个能力：

```ts
// DeepAgents 1.12 即使收到空 subagents，也会添加通用 task 工具。
// 仓库 worker 不允许委派，因此在各中间件贡献工具后，再移除它。
const NO_DELEGATION_MIDDLEWARE = createMiddleware({
  name: "OpenWikiRepositoryWorkerNoDelegation",
  wrapModelCall: async (request, handler) => {
    const response = await handler({
      ...request,
      tools: request.tools?.filter(({ name }) => name !== "task"),
    });
    return coerceRepositoryWorkerModelResponse(response);
  },
});
```

在每次模型请求前把 `task` 从工具列表里过滤掉。理由是结构性的：OpenWiki 已经有自己的任务单位（页面）和完成记录（队列），模型再自主委派一层 Agent，会产生一套和页面队列对不上的任务状态。这个前提来自源码注释针对的 1.12；本系列锁定的 1.13.2 里该中间件仍在使用并有测试覆盖。

## 并发：应用层的 worker 池

原生运行器用 `runWorkerLoops` 启动若干循环，每个循环"领一页 → 建 Agent → 跑完 → 领下一页"。并发度由 `OPENWIKI_PAGE_CONCURRENCY` 控制，默认 1，范围 1–8。领取有串行化保护，同一进程内不会两个 worker 抢同一页。

三个细节让并发安全：

**quickstart 永远最后、单独写。** 它是导航页，要链接所有领域页，所以等其他 worker 全部结束后再以单 worker 执行。只在数组末尾排序还不够（前面的任务可能还没跑完），运行器显式保留这个等待条件。

**限流降档。** 某个 worker 撞上供应商限流（`isRateLimitError`，0.7.2 起也认 Bedrock 的 `ThrottlingException`），它负责的页面跳过，整轮并发数降一，最低保一。

**同页文件操作排队。** LangChain 会并发执行同一轮的多个工具调用，而底层文件的 `write` 是先截断再写、`edit` 是读改写——重叠执行会丢数据。`withPathOperation`（`src/agent/docs-only-backend.ts`）按宿主路径把同一页的操作排成队列，页面 worker和代码拥有的生命周期各自创建的后端共用它。

并发提交的共享状态协调在上一篇讲过：提交时重读最新计划，Claims 收尾排除其他 pending 页。

可观测性也按 worker 切分：开 LangSmith 追踪时，规划器和每个页面 worker 是独立 trace，按运行归进同一个 thread；线程 id 就是运行 id，恢复的运行沿用原 id。CI 里可以用 `OPENWIKI_TRACE_THREAD_ID` 自己指定，让一次运行能从触发的 commit 反查回来。

## 没有 checkpointer，恢复靠任务状态——但要分路径说

原生仓库 worker 没有配置 graph checkpointer（LangGraph 的对话状态保存器）。也就是说，同一轮的 worker 之间、一次运行与下一次运行之间，**不共享模型对话历史**。恢复的依据是应用层的页面任务和落盘文档，不是消息重放。

这是取舍而非疏漏：文档生成的可恢复单位是"页"，一页重跑的成本远低于维护跨进程对话状态。worker 之间真正共享的上下文是规划器写进每个任务里的 `purpose` / `seedPaths` / `relatedPages` / `instructions`，以及已写好的页面本身——它们比对话历史更稳定，也是新 worker 能接手一页的全部所需。

对照另一条路径能让这个取舍更清楚：**通用 Agent（仓库 chat 和 personal 模式）是有 checkpointer 的**（`createOpenWikiAgent`，`src/agent/index.ts`）。chat 会话持久化到配置目录下的 SQLite（`openwiki.sqlite`），线程 id 是 `openwiki-<仓库路径哈希>-<运行 id>`；一次性运行（ingest 等）用内存 `:memory:` 保存器，跑完即弃。SQLite 保存器只增不删，OpenWiki 在每轮结束后主动修剪——每个命名空间只留最新一个 checkpoint，源码注释算过这笔账：chat 会话永远只从最新检查点续跑，更早的历史"纯属浪费，可以安全丢弃"。

下一篇进入这个项目最有特色的部分：[04：Grounded Claims](./04-claims.md)。
