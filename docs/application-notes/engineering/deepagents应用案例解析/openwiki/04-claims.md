---
title: 04：证据层——Grounded Claims
description: 每条关键事实如何挂上版本化的源码证据；代码变化后预检如何把事实分成 stale 与 unresolved；worker 的确认、修订、撤回决策如何被强制；verified 标记从哪里来。
sidebar_position: 5
---

# 证据层：Grounded Claims

LLM Wiki 的卖点之一是"新资料进来时修正旧观点"。大部分实现停在口号，OpenWiki 把它做成了机制：wiki 里的每条关键事实都登记它依据的源码位置和当时的版本，代码变化后程序精确算出**哪句话的依据变了**，只把相关页面排回队列。这就是 Grounded Claims。

先看清它要回答的问题。wiki 写着"页面 worker 只能修改分配给自己的文件"，半年后仓库有了几百个提交——这句话还对吗？整仓库 diff 回答不了这个问题（变化太多，不知道哪些相关）；只看页面更新时间也回答不了（页面没动不等于依据没动）。Claims 的做法是把"结论 → 依据"这层关系本身存下来。

## 一条 Claim 长什么样

每页一个 sidecar 文件，路径与页面对应：`openwiki/.claims/<页面路径>.json`。Open SWE 仓库的真实样本（`.claims/testing/overview.json`）：

```json
{
  "schemaVersion": 1,
  "pageVersion": "sha256:75920d28bad5b192afd797dfb84208215370aa54fa04f783dbddc72b010939e9",
  "claims": [
    {
      "id": "claim_9a77e9c5301a46b8bbd02832b9de5a90",
      "statement": "The pytest unit suite runs in asyncio auto mode (asyncio_mode = \"auto\"), so async test functions and fixtures are awaited without any per-test asyncio marker.",
      "evidence": [
        {
          "resource": "repo://pyproject.toml",
          "version": "repo-file-v1:sha256:6a4ff3c5410f45c156688f8f18dee9c03925403a45b034352810673cc679ad98"
        }
      ]
    }
  ]
}
```

三个字段各司其职：`statement` 是一条可独立核对的事实陈述（不是"系统设计很先进"这类评价）；`evidence` 指向源码资源；`version` 是**程序**读取实际文件后算出的版本串——模型只交陈述和资源位置，哈希不能由模型编造。

提示词（`src/claims/guidance.ts`）给了"什么值得成为 Claim"的标准：关于行为、职责、数据流、不变量、失败语义、配置、安全边界的实质性命题；"原子"指一个完整可证伪的观点，而不是一行源码一个事实。材料性测试写在指引里：**如果这个命题是错的，读者的架构理解或实现决策会受影响吗？** 会，才值得登记。

## 证据引用与版本

资源用 `repo://` URI，两种粒度：

- `repo://src/server.ts`——整文件；
- `repo://src/server.ts#L40-L82`——行范围。

对应两种版本格式。整文件是 `repo-file-v1:sha256:<文件内容哈希>`。行范围是 `repo-lines-v1:sha256:<范围内容哈希>:<base64 载荷>`，OpenWiki 自建 wiki 里的真实样本：

```json
{
  "resource": "repo://src/claims/brains/code/preflight.ts#L110-L126",
  "version": "repo-lines-v1:sha256:8eef8ba4…876224:eyJzZWxlY3RlZExpbmVDb3VudCI6MTcs…"
}
```

base64 载荷解码后是 `{"selectedLineCount":17,…}`——记录了引用范围当时的行数等信息。它的用途是**重定位**：`RepositoryEvidenceResolver`（`src/claims/evidence/repository/resolver.ts`）重新解析时，如果文件开头插了几行、原片段整体下移，能靠锚点找回未改变的原片段，不误报过期；找不到安全定位时不盲用旧行号。解析器同时做边界检查：证据引用不能越出仓库范围、不能指向 `.openwikiignore` 排除的路径——不能借证据 URI 绕去读禁区。

## 预检：把"依据变了"变成具体问题

每次 update 在 begin 阶段就跑 `runClaimsPreflight`（`src/claims/brains/code/preflight.ts`）：读出每页的 Claims，逐条重新解析证据，和记录的版本比较。核心分类只有几行：

```ts
if (!current) {
  unresolvedResources.push(evidence.resource);   // 解析不出来
} else if (current.evidence.version !== evidence.version) {
  changedResources.push(evidence.resource);      // 能解析，但版本变了
}
```

两种问题要求不同的研究动作：

- **stale**——证据还在但内容变了。可能是行为真变了，也可能只是等价重构，要 agent 重读后判断；
- **unresolved**——证据没了（文件被删、范围定位不到、被安全边界拒绝）。旧依据已不存在，要找新依据或撤回结论。

一条 Claim 同时踩两者时只报 unresolved（`resources` 只列解析失败的那部分），因为 unresolved 更紧急。普通读文件的异常向上抛，不吞成"证据已删除"；只有安全范围的拒绝被专门转成待处理的 unresolved。

预检结果一路生效：它进规划器的提示词（"Claims requiring attention"清单）；规划器就算漏掉某页，`createRepositoryPlan` 也会强制把它补回队列（见 [02](./02-generation-lifecycle.md)）。没有 sidecar 的页面在预检里不产生任何强制工作——Claims 是覆盖增强，不是覆盖保证：没登记过的事实，程序无从知道它的依据。

## worker 必须表态，不许沉默

带着问题 Claim 的页面任务交给 worker 时，问题清单直接写进提示词。提交 `submit_page` 时的决策是稀疏的，三种：

| 决策 | 字段 | 什么时候用 |
| --- | --- | --- |
| 确认仍成立 | `confirmedClaimIds` | 依据变了但重读后行为没变（等价重构） |
| 修订或新增 | `claims` | 行为变了，陈述要改；或页面新增了关键事实 |
| 撤回 | `retractedClaimIds` | 功能已删，结论不再属于这个系统 |

第四种"不提交"只对**没问题**的旧 Claim 有效——省略即自动保留。有问题却想沉默过关，`reconcilePageClaims`（`src/generation/page-jobs.ts`）直接拒绝：

```ts
for (const current of existing) {
  if (targetedExistingIds.has(current.id)) continue;
  if (current.issue) {
    throw new RepositoryRunError(
      "invalid_input",
      `Claim ${current.id} is ${current.issue.kind} and requires an explicit confirm, update, or retract decision.`,
    );
  }
  operations.push({ op: "confirm", id: current.id });  // 没问题的自动保留
}
```

输入校验还处理各种边角：不属于本页的 Claim id、对同一条的重复决策、重复的新陈述（与已有完全一致的提案自动转成确认）。撤回是幂等的——目标已经不在了再撤一次也安全，这覆盖"证据删除已落盘、页面检查点却失败"的中间态。

## 存储内部：sidecar 怎么落盘

`ClaimsStore`（`src/claims/brains/code/store.ts`）独占 sidecar 的读写，几条规则值得知道：

**写入是原子的。** 先写同目录下的 `.<文件名>.<uuid>.tmp`，再 `rename` 替换正式文件——和 `.run.json` 同一套手法，崩溃不会留下半截 JSON。

**读取即校验。** 读回时用严格 Zod schema 验证：`schemaVersion` 必须精确等于当前版本、`pageVersion` 必须匹配 `sha256:` + 64 位十六进制、每条 Claim 的 `evidence` 至少一项且字段封闭（不允许未知字段）。损坏的 sidecar 不会被静默容忍。

**id 由程序铸造。** 模型提交新事实时不带 id（`ClaimSchema` 里 `id` 是可选的），落盘时程序生成形如 `claim_9a77e9c5301a46b8bbd02832b9de5a90` 的标识（UUID 去连字符）。模型不能伪造别人的 id，修订也只能引用已存在的。

**完成页面至少留一条事实。** 提交检查包含一条硬规则，报错原文很清楚：`Completed factual page <page> must retain or establish at least one material Claim.`。一页把所有事实都撤光是不允许的——那说明这页已经不该存在，应该走删除流程。

**`inspect_claims` 不回传证据版本串。** 工具描述写明它返回"不带不透明证据版本"的完整 Claim 集合：模型需要的是陈述和 id，`repo-lines-v1:sha256:…:eyJ…` 这种版本串对它只有噪音，还会挤占上下文。

顺带一个设计复用：`ClaimsStore.discoverPages()` 是"哪些是生成的事实页"的权威判断，[05](./05-retrieval-and-workspaces.md) 的搜索直接用它来枚举可检索页面——页面发现逻辑只有一份，两条路径不会对"什么算 wiki 页面"产生分歧。

## verified：程序导出的信任标记

页面提交成功后，Claims 先持久化，然后 `finalizeVerificationProjection`（`src/claims/brains/code/runtime.ts`）把核验状态**投影**到页面 front matter 的 `verified` 字段。触发条件是完整的：本次提交成功、reconcile 出非空的完整 Claim 集、通过最终证据复查、sidecar 落盘。"投影"指把控制记录里的结果反映成页面元数据，不是再调一次模型做审稿。

方向性很重要：**干净的预检永远不会产生或推进 verified**，只有真正跑过页面提交与证据复查才会。这个标记最终进入 OKF front matter（见 [06](./06-finalize-and-okf.md)），外部工具可以看到这页的事实被哪个版本的生产者在何时核验过。

## 边界：版本一致不等于内容正确

Claims 机制证明的是一组**可检查的条件**：引用能解析、版本记录在案、比较结果可靠、问题处理协议被执行。

它证明不了"引用的内容逻辑上支撑陈述"。Agent 可能引错函数、漏掉配置条件、把单入口的行为概括成整个系统的行为——这些错误不产生版本不匹配。所以证据新鲜度（这页的依据还是当时的源码吗）和语义正确性（陈述真的对吗）是两个独立的问题，前者程序保证，后者靠模型研究、人工评审或评测。

回到篇首的问题——"这句话还对吗"，Claims 的完整回答是：程序保证**该重读的人一定会重读**（stale/unresolved 强制入队、提交强制表态），重读之后的判断质量仍取决于执行研究的模型。

下一篇：[05：检索与跨仓库工作区](./05-retrieval-and-workspaces.md)。
