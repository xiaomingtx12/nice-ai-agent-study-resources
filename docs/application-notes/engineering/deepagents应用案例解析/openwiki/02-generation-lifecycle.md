---
title: 02：编译——一次生成的完整生命周期
description: begin 的恢复与 no-op、规划与计划规范化、逐页提交的落盘顺序、finish 的基线推进，以及三个持久化状态文件如何支撑失败恢复。
sidebar_position: 3
---

# 编译：一次生成的完整生命周期

Ingest 是三种操作里最重的一个。这一篇沿时间顺序走完一次仓库生成的全程，重点看两个问题：**进度怎么记**（三个持久化文件），以及**中途失败了怎么办**（每一步的落盘顺序与恢复路径）。代码集中在 `src/generation/repository-run.ts`。

## 先认识三个状态文件

OpenWiki 不把进度放在模型对话里，而是放在仓库里三个 JSON 文件中。它们回答三个不同的问题。

**`.run.json`——本轮还有哪些页面没做完？** 只在运行期间存在。两个关键字段：`phase` 是顶层阶段（`planning` / `generating`），`plan.pages[]` 是页面队列，每个任务带 `status`（`pending` / `skipped` / `complete`）。运行成功结束时整个文件删除；写入原子（临时文件 + `rename`），损坏时读取直接抛 `invalid_state`，宁可失败也不丢掉可恢复的工作。

队列之外还有一圈支撑字段。按 `RepositoryRunStateSchema`（`src/generation/run-state.ts`）构造一份完整样例（运行结束即删，无真实样本，尖括号是占位）：

```json
{
  "schemaVersion": 1,
  "runId": "<uuid>",
  "mode": "update",
  "phase": "generating",
  "language": "en",
  "languageChanged": false,
  "requiredRewritePages": [],
  "sourceFingerprint": "sha256:<…>",
  "targetGitHead": "<commit>",
  "actor": { "producerActor": "openwiki/<版本>", "metadataModel": "<模型>" },
  "beforeContentSnapshot": "<运行前内容快照>",
  "plan": {
    "pages": [
      {
        "id": "<uuid>",
        "path": "/openwiki/workflows/….md",
        "title": "…",
        "purpose": "…",
        "seedPaths": ["src/…"],
        "relatedPages": [],
        "instructions": [],
        "status": "pending"
      }
    ],
    "deletePages": []
  }
}
```

几个字段的用途：`language` / `languageChanged` 记录文档语言及本轮是否切换了语言；`requiredRewritePages` 是被强制重写的页面（语言切换就会把全部页面列进来，见 [06](./06-finalize-and-okf.md)）；`sourceFingerprint` 与 `targetGitHead` 是本轮要覆盖到的源码检查点；`actor` 记录生产者身份（原生是 `openwiki/<版本>`，宿主路径是宿主 id）；`beforeContentSnapshot` 供替换保护与崩溃善后使用。`PageJob.id` 是 `submit_page` 用的任务标识，与页面路径一一对应。

**`.page-manifest.json`——每页完成时依据的是哪份源码？** 长期保留。每页一条记录，来自 OpenWiki 给自己生成的 wiki 的真实样本（哈希截短）：

```json
"/openwiki/architecture/agent-runtime.md": {
  "gitHead": "9d517675e2132a19189e5777fcbda19726f48d06",
  "sourceFingerprint": "sha256:bd10ad45…3899e2",
  "pageVersion": "sha256:25e45bcb…57b7e4",
  "completedBy": "openwiki/0.7.1",
  "completedRunId": "482630ac-1f42-4071-b382-c61c8900fc34"
}
```

`gitHead` 和 `sourceFingerprint` 是这页覆盖的源码检查点；`pageVersion` 是已验收 Markdown 字节的哈希。一个页面算"完成且仍有效"，需要清单条目的指纹、git head、Claims 的 verification 标记、当前 Markdown 哈希四者同时对上——任何一项不符，这页就要排回队列。

**`.last-update.json`——整轮更新进行到什么程度？** Open SWE 仓库里的真实内容：

```json
{
  "updatedAt": "2026-09-08T08:54:29.420Z",
  "command": "update",
  "gitHead": "342559af5d7c56364601212f7632482892ce8583",
  "model": "gpt-5.6-terra",
  "status": "complete",
  "language": "en"
}
```

它不能取代逐页清单：一轮 update 可能只有部分页面重写，甚至有的页面停在很老的基线上，一个全局 gitHead 代表不了所有页面。

## begin：先搞清楚现在是什么状态

`beginRepositoryRun` 是所有路径（原生 CLI 和宿主 MCP 的 `openwiki_begin`）的公共入口。它做三件事：准备 wiki 目录、加载 Claims、计算当前源码快照（指纹 + git HEAD）。然后按情况分流。

### 指纹算的是什么

"源码指纹"值得单独拆开看，因为 no-op、恢复、漂移检测全部建立在它上面。`createRepositorySourceSnapshot`（`src/agent/utils.ts`）并行跑四条 git 命令：

- `git rev-parse HEAD`——当前提交；
- `git ls-files --cached`——所有已跟踪文件；
- `git ls-files --others --exclude-standard`——未跟踪但没被 `.gitignore` 排除的文件；
- `git status --porcelain --untracked-files=all`——工作区状态条目。

候选文件 = 已跟踪 + 未跟踪未忽略（`.openwikiignore` 文件本身若存在也计入），再过滤掉 `.openwikiignore` 命中的路径和 OpenWiki 自己生成的状态。最后把**每个文件的内容哈希**、HEAD、以及 status 的改动码和路径，按稳定顺序喂进一个总 SHA-256。

两个推论：

- 指纹锚定的是**工作区内容**，不是提交历史。改了一行没提交，指纹就变——no-op 不会因为"git 干净"就放行脏工作区；
- git 调用、读文件任何一步失败都会让整个快照失败。源码注释明说这是 correctness gate（正确性门槛）：宁可报错也不能拿一个不完整的指纹去判定"没变化"。

begin 在关键位置还会**重算一次**快照核对稳定性（先算一次、处理完再看一次），避免"检查期间源码恰好变了"被误判成干净。

**有未结束的 `.run.json` → 恢复，而不是重建。** `resumeRepositoryRun` 先检查运行模式和语言是否兼容，再重新计算源码快照，分两条路（`repository-run.ts`）：

```ts
if (sourceChanged) {
  nextState.phase = "planning";
  nextState.sourceFingerprint = currentSource.fingerprint;
  // …
  delete nextState.plan;   // 旧计划基于旧源码，作废，重新规划
} else {
  nextState = await reconcileManifestPageJobs(  // 源码没变：
    input.root, nextState, state.actor.producerActor,  // 按清单核对，
  );                                                // 恢复已完成的页
}
```

注意 `delete nextState.plan` 删的是**计划**，不是 wiki 页面。中断时已经提交完成的页面依然有效，重新规划会以现有文档为基础决定还要做什么。

**没有任何运行记录的 update → 判断能不能 no-op。** 这个判断比"git 有没有新提交"严格得多：程序先跑一遍 Claims 证据预检（每条事实的源码依据是否还匹配，见 [04](./04-claims.md)），再检查每页基线覆盖。证据过期、基线缺失、用户强制，任何一条命中都会让运行继续进入模型阶段。反过来，真正的 no-op 也不是什么都不做——它刷新 `.last-update.json` 记录"检查过了"，但不动任何页面内容。

**重新 init → 替换生成内容，保留人的部分。** 再跑一次 `--init` 不是"在旧文档上续写"，而是一次带备份的替换，由 `beginRepositoryWikiReplacement`（`src/agent/wiki-replacement.ts`）实现成一个事务：

1. 把整个 `openwiki/` 备份到系统临时目录（保留时间戳、原样复制符号链接；如果 `openwiki` 本身是个符号链接或不是真目录，直接拒绝替换）；
2. 清空重建空的 `openwiki/`，只从备份里拷回一个文件——`INSTRUCTIONS.md`，它是用户写的控制文件，不属于生成状态；
3. 返回 `{ commit, rollback }` 两 个方法：init 成功走到新运行状态落盘后 `commit`（删除备份），准备阶段任何失败 `rollback`（整目录恢复原样）。

在替换进行期间收到 SIGINT / SIGTERM（Ctrl-C 或停容器），信号处理器会先回滚备份再退出——操作员取消不会留下半替换的 wiki。回滚本身失败时备份目录保留在原地，错误信息里给出路径，人工还能捞回来。首次 init（本来就没有 `openwiki/`）返回空事务，走普通的部分运行恢复逻辑。

另外，update 命令行里带一句消息（`openwiki --update "重点更新检索部分"`）有双重语义（`src/agent/index.ts`）：这句话作为规划上下文传给规划器（限定范围），同时 `force` 置真——**附带用户消息的 update 一律绕过 no-op**。用户明说"更新一下"，程序就不该回答"没什么可做的"。

## 规划：决定写哪些页面

规划是一个独立的模型任务：研究仓库，然后通过 `submit_plan` 工具提交页面清单。提示词（`createRepositoryPlannerPrompt`，`src/agent/repository-prompts.ts`）给研究划了明确路线：

> 先看清单文件、目录布局、入口和对外接口；再追踪端到端的控制和数据流（调用方、状态、失败处理、配置、集成）；最后看针对性测试验证边界。不要止步于目录名，也不要做逐文件盘点。

组织原则是"按系统职责分页，不要镜像源码目录树"。规划器交出的每页是一个结构化对象，Zod schema 严格校验：

```ts
const PlanPageSchema = z.object({
  path: z.string().trim().min(1),       // 页面路径，提交后不可改
  title: z.string().trim().min(1),
  purpose: z.string().trim().min(1),    // 这页负责解释什么知识问题
  seedPaths: z.array(z.string()).optional(),     // 研究起点，不是边界
  relatedPages: z.array(z.string()).optional(),  // 需要衔接的页面
  instructions: z.array(z.string()).optional(),  // 只与这页相关的用户要求
}).strict();
```

`purpose` 是最有分量的字段：它逼规划阶段回答"读完这页能解释什么"，而不是"这页对应哪个文件"。

模型提交的计划随后被 `createRepositoryPlan`（`src/generation/page-jobs.ts`）**规范化**——这一步是程序对模型的兜底：

- 规范路径，拒绝重复页面、拒绝同一页既生成又删除；
- 首次生成必须包含 `quickstart.md`，且 quickstart 被排到队列最后（它要等所有领域页稳定后写导航）；
- update 模式下，Claims 预检发现问题的页面**强制补入**计划——规划器就算漏了，已知的事实问题也跑不掉：

```ts
if (mode === "update") {
  const deleted = new Set(deletePages);
  addRequiredClaimIssueJobs(pages, pagePaths, deleted, claimIssues);
  addRequiredRewriteJobs(pages, pagePaths, deleted, requiredRewritePages);
}
```

用户在对话里点名"只更新 X"时，提示词把这种请求当作硬性范围约束：只安排被点名的页面和真正受影响的交叉引用，不趁机刷新整个 wiki。

## 逐页执行与提交：落盘顺序就是承诺

规划完成后，队列持久化在 `.run.json` 里。执行侧（原生 worker 池或宿主 Agent）反复"领一页 → 研究 → 写作 → 提交"，直到队列清空。

关键在于：**写文件不等于完成页面**。worker 用文件工具把 Markdown 写进 `openwiki/` 只是中间动作；真正推进状态的是 `submit_page`（原生路径的 `submitRepositoryPage`）。提交时程序依次：

1. 读回实际落盘的 Markdown，修复并校验 front matter（修不了作为输入错误退回模型）；
2. 应用本页的 Claims 决策，把证据持久化；
3. 写入 `.page-manifest.json` 的完成记录与源码检查点；
4. 把队列里这页标为 complete，保存 `.run.json`。

顺序有意为之：**先把证据和完成依据落盘，再推进队列**。反过来若先标 complete 再存证据，中途崩溃就会留下"队列说完成了、证据却不存在"的烂账。正向顺序下，即使第 4 步失败，下一次恢复也能靠清单核对把持久事实重新映射回任务状态。重复提交同一页按幂等处理，直接返回成功，不会重做。

没有跨文件的事务。可靠性来自这套落盘顺序加上恢复时的核对，而不是数据库。

并发提交还有一条保护：提交 A 页时，程序会算出其他仍处于 pending 的页面集合，让 Claims 收尾逻辑**排除**它们——并发 worker 可能正把那些页写到一半，此时给它们盖核验标记会把半成品字节误当验收结果。

## finish：结束一轮，但只承诺做过的事

`finishRepositoryRun` 首先拒绝仍有 pending 页的运行。然后处理计划内的删除页、同步 wiki 产物（index、front matter，见 [06](./06-finalize-and-okf.md)）、恢复被跳过页的旧内容。

基线推进有一条精确的规则：**只给本轮真正重新生成过的页面盖新的源码检查点**。跳过的页、没进计划的页、上一轮留下的完成页，都保持旧基线。收尾时程序可能修整了页面格式（字节变了，`pageVersion` 可以刷新），但"格式被修整"不等于"模型重新读过新源码"，源码基线不动。

最后是状态写入。两种情况会把全局状态记为 `interrupted` 而不是 `complete`：有页面被跳过，或者生成期间源码又变了（漂移）。也就是说 finish 返回成功只表示"本轮程序收尾完成"，不表示"所有页面已覆盖最新代码"——后者的证据在 `.last-update.json` 的 status 字段里。

一切落定后才删除运行记录，源码注释把意图写得很直白：

```ts
// 最后才删除。此前任何一步失败，begin() 都还能重建并重试。
await removeRepositoryRunState(run.root);
```

## 失败与恢复：每层有自己的答案

生成可能挂在很多环节，每层的处理不同。

**worker 写作失败（原生路径）。** 每页开写前先保存该页快照，最多尝试两次（`PAGE_WORKER_ATTEMPT_LIMIT = 2`），每次全新 Agent。第一次没提交成功，先把页面和 Claims 恢复到快照再重试——两次从同一状态开始：

```ts
for (let attempt = 1; attempt <= PAGE_WORKER_ATTEMPT_LIMIT; attempt += 1) {
  const outcome = await runPageWorkerAttempt(run, job, snapshot, model, onEvent);
  if (outcome.status === "submitted") return outcome;
  skipped = outcome;

  // 限流表示供应商要求降流量，交给 worker 池处理，不马上重试。
  if (attempt >= PAGE_WORKER_ATTEMPT_LIMIT || isRateLimitError(outcome.error)) {
    break;
  }
  // 重试前恢复快照，两次尝试从同一状态开始。
  await restoreRepositoryPage(run, snapshot);
}
await skipRepositoryPage(run, snapshot);
```

供应商限流不走重试，直接跳过这页并让并发池降一档（见 [03](./03-agents-and-tools.md)）。两次都失败才标 skipped——skipped 不是失败终止，其他页面继续，这页留待下一轮。

**提交成功后流断了。** 已持久化的完成记录不会被撤销；恢复逻辑以落盘事实为准，不会因为这页重写一遍。

**整个过程崩溃。** 下次运行从 `.run.json` 恢复：源码没变就对账续跑，源码变了重新规划（前面的 `sourceChanged` 分支）。

还有最后一层兜底：连 `.run.json` 都来不及写的进程级崩溃。CLI 启动时 `installCrashGuard`（`src/agent/crash-guard.ts`）挂上 `unhandledRejection` / `uncaughtException` 处理器。真正崩掉时它先**同步认领**当前运行再清空（源码注释特意说明这一对操作之间不能有 `await`，否则一连串异常会重复记账），然后做两件尽力而为的事：记一条失败遥测；把 `.last-update.json` 盖成 `interrupted`——但仅当内容相对运行前快照确实变了。这个标记的实际作用写在注释里：下一次**定时** update 看到 interrupted 就不会 no-op，而是重试，避免对着写了一半的 wiki 宣布"一切干净"。

一条隐含的部署条件：恢复依赖这些状态文件跟着工作区存活。CI 里用即抛型 runner，失败后工作区销毁，恢复能力也就不存在——要么保留工作区，要么接受失败后从头再来。

下一篇看这套生命周期的执行侧：[03：规划器与页面 worker 的装配](./03-agents-and-tools.md)。
