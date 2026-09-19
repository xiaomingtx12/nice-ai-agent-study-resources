---
title: 03：Wiki 怎样持续维护
description: 沿 update 的跳过判断、翻译、结构校验、索引同步和元数据收尾，解释页面状态如何变化，以及中断后能恢复到什么程度。
sidebar_position: 4
---

# OpenWiki 03：Wiki 怎样持续维护

> 源码基线：OpenWiki `0.2.4`，commit `3076d557f8a14`；依赖锁定 `deepagents@1.11.1`。
>
> - 入口与收尾：`src/agent/index.ts` · `runOpenWikiAgent` / `runOpenWikiAgentCore`
> - 跳过与元数据：`src/agent/utils.ts` · `getUpdateNoopStatus` / `persistRunMetadataIfChanged`
> - 翻译：`src/agent/translation-middleware.ts` · `resolveTranslationPlan` / `translateWiki`
> - 写后反馈：`src/agent/okf-middleware.ts` · `createOpenWikiIndexMiddleware` / `addFrontmatterWarning`
> - 规范化与索引：`src/okf/frontmatter.ts` · `normalizeConceptContent`；`src/okf/index-sync.ts` · `synchronizeWikiIndexes`
> - 图表降级：`src/mermaid/validate.ts` · `degradeInvalidMermaidFences`

OpenWiki 的更新依靠文件和运行元数据延续。模型边运行边写页面，中间件在固定生命周期位置翻译、校验和重建导航；事件流结束后，应用根据内容快照决定是否记录成功或中断。页面写入没有全局事务，因此恢复的重点是重新检查已经留下的内容。

这条链要从 Agent 启动前的 no-op（无需更新时跳过）判断读起。语言重试、结构修复和正文维护都在它后面；如果入口跳过，后续中间件不会执行。

## no-op 判断区分工作区改动和已提交改动

`runOpenWikiAgent` 仅在 command 为 update 且 `shouldCheckUpdateNoop` 返回 true 时尝试跳过。后者只判断用户消息是否为空，不检查语言参数或待翻译页面。

`getUpdateNoopStatus` 固定读取 repository 位置的 `openwiki/.last-update.json`。缺少上次 Git HEAD、上次状态为 `interrupted`，或者拿不到当前 HEAD，都会继续运行。随后检查工作区：

`src/agent/utils.ts` · `getUpdateNoopStatus`（第 139–153 行，节选）：

```ts
// 工作区过滤只专门排除更新记录，普通 Wiki 页面改动仍保留。
const status = await runGit(cwd, [
  "status",
  "--short",
  "--untracked-files=all",
]);
const meaningfulStatus = status
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean)
  .filter((line) => !isUpdateMetadataStatusLine(line))
  .filter((line) => !lineReferencesIgnoredPath(line, openWikiIgnore));

if (meaningfulStatus.length > 0) {
  return { shouldSkip: false, reason: "worktree has changes" };
}
```

`isUpdateMetadataStatusLine` 只排除运行记录 `openwiki/.last-update.json`，不排除整个 Wiki。因此未提交的 `openwiki/quickstart.md` 修改会触发 update，除非该路径被 ignore 排除。

工作区没有有效变化后，如果 HEAD 已改变，代码才比较提交之间的路径：

`src/agent/utils.ts` · `getUpdateNoopStatus`（第 155–170 行，节选）：

```ts
// 已提交变更的过滤才排除整个 openwiki 目录；空列表保守地继续运行。
if (head !== lastUpdate.gitHead) {
  const committedPaths = await getChangedPathsSinceLastUpdate(
    cwd,
    lastUpdate.gitHead,
  );

  if (
    committedPaths.length === 0 ||
    committedPaths.some(
      (changedPath) =>
        !isOpenWikiPath(changedPath) && !openWikiIgnore.ignores(changedPath),
    )
  ) {
    return { shouldSkip: false, reason: "git head changed" };
  }
}
```

这里排除的是整个 `openwiki/` 目录以及 ignore 路径。也就是：**Wiki 页面未提交时通常要运行；提交后若新提交只改变 Wiki，则可以跳过。** 当 HEAD 变化却没有得到路径列表时，代码也继续运行，不将空列表直接认定为无变化。

这项优化还有明确边界：入口没有单独限制输出模式；个人来源采集依靠非空来源消息避开它。仅更改 `language` 参数也不会自动绕过 no-op。若要单独切换语言或重试 pending 页面，需要确保 update 确实进入 Agent，例如附带明确用户消息。源码没有在 no-op 阶段扫描翻译标记。

## 运行前快照记录内容，不记录对话位置

进入 `runOpenWikiAgentCore` 后，非 chat 运行调用 `createOpenWikiContentSnapshot`。它递归排序目录项，把相对路径、目录标记和普通文件字节加入 SHA-256 哈希；Wiki 根的 `_plan.md` 和 `.last-update.json` 被排除，其他文件并不只限于 Markdown。

这个快照回答“文档树是否发生变化”。它没有保存文件旧内容，无法拿来回滚，也没有记录 Agent 的下一条工具调用。

| 状态 | 位置 | 下一轮能利用什么 |
| --- | --- | --- |
| `RunContext` | 本轮内存 | 语言、目标、Git 摘要和读取到的上次元数据 |
| graph checkpoint（执行图检查点） | chat 的 SQLite；init/update 的内存数据库 | 同一 thread 的执行图状态；内存数据库随进程结束消失 |
| Wiki 文件与 pending（待重试）标记 | Wiki 目录 | 已写页面及需要再次处理的页面 |
| `.last-update.json` | Wiki 根目录 | 更新时间、命令、模型、语言、状态，以及 repository 的 Git HEAD |

checkpointer 是执行图的状态保存器，thread ID 标识一组连续运行共享的状态。chat 用 `~/.openwiki/openwiki.sqlite` 持久化，但还会裁剪历史，按 namespace（检查点命名空间）保留最新 checkpoint，并保留相关写入记录；它不是无限历史档案。init/update 的跨进程恢复依赖现有页面和元数据重新运行，不是从上一次节点续跑。

## 翻译在主 Agent 前完成，失败以页面为单位记录

`resolveTranslationPlan` 为 update 返回翻译计划，init/chat 返回 undefined。它比较 BCP-47 语言标签的主语言部分：例如 `en → zh-CN` 触发全量翻译，`en → en-GB` 不触发全量翻译。

`src/agent/translation-middleware.ts` · `resolveTranslationPlan`（第 90–107 行，节选）：

```ts
// 只有 update 有计划；primarySubtag 取语言主标签，缺失时按 en 处理。
export function resolveTranslationPlan(
  command: OpenWikiCommand,
  requestedLanguage: string | undefined,
  currentWikiLanguage: string | undefined,
): TranslationPlan | undefined {
  if (command !== "update") {
    return undefined;
  }

  const source = currentWikiLanguage ?? "en";
  return {
    target: requestedLanguage ?? source,
    source,
    translateAll:
      requestedLanguage !== undefined &&
      primarySubtag(requestedLanguage) !== primarySubtag(currentWikiLanguage),
  };
}
```

`createWikiTranslationMiddleware` 是翻译中间件工厂，它的 `beforeAgent` 调用 `translateWiki`。目录枚举跳过隐藏项、`index.md`、`log.md`、`_plan.md` 和 `INSTRUCTIONS.md`。普通 update 只选择带字符串型 `openwiki_translation_pending` 字段的页面，全量计划则处理所有入选页面。

每页的处理链是“读文件 → 判断是否待翻译 → 单独调用模型 → 清除 pending 字段 → 内容不同才写回”。翻译使用 `model.invoke`，输入是一份文档和独立翻译提示词；`langsmith:nostream` 标签抑制这次调用的 token 展示，译文通过 Backend（文件后端）落盘，不由主 Agent 再复制一遍。

`src/agent/translation-middleware.ts` · `translateWiki`（第 225–239 行，节选）：

```ts
// 一页失败后尝试标记；标记返回错误时也保留在汇总诊断中。
try {
  await translatePage(backend, model, filePath, content, plan);
} catch (error) {
  const reasons = [getErrorMessage(error)];
  const stampError = await markPending(
    backend,
    filePath,
    content,
    plan.target,
  );
  if (stampError) {
    reasons.push(`could not mark it for retry: ${stampError}`);
  }
  failures.push(`- ${filePath}: ${reasons.join("; ")}`);
}
```

模型返回空内容、模型调用失败或 Backend 返回写入错误时，这个 catch 尝试给原页面标记目标语言，汇总失败原因，然后处理后续页面。成功翻译则由代码删除 pending 字段，即使模型仍返回该字段，也不会让页面一直留在重试集合里。

“失败会重试”有三个前提：页面能读到，pending 标记能写入，下一轮 update 没被 no-op 跳过。读文件失败只会收集错误并继续；标记写入返回错误时会追加诊断，无法保证后续靠标记找到该页。若 Backend 直接抛出未被局部捕获的异常，仍可能中断整个中间件。

因而全局记录的目标语言可能已经是中文，而某些页面仍为英文并带 pending。语言字段表示运行目标，不能用来证明每页翻译都已完成。

## OKF 迁移、写后校验和目录生成使用不同规则

OKF 是页面 front matter（Markdown 开头的 YAML 元数据）约定。`createOpenWikiIndexMiddleware` 用 LangChain 的 `createMiddleware` 把三类动作接到 Agent 生命周期上：

`src/agent/okf-middleware.ts` · `createOpenWikiIndexMiddleware`（第 33–49 行，节选）：

```ts
// 工具先执行，再校验实际落盘内容；图结束时同步结构。
return createMiddleware({
  name: "OpenWikiIndexMiddleware",
  beforeAgent: async () => {
    await migrateWikiToOkf(backend, outputMode, conceptType);
  },
  wrapToolCall: async (request, handler) =>
    addFrontmatterWarning(
      await handler(request),
      backend,
      outputMode,
      request.toolCall.name,
    ),
  afterAgent: async () => {
    await validateWikiMermaid(backend, outputMode);
    await synchronizeWikiIndexes(backend, outputMode, labels, conceptType);
  },
});
```

### 运行前：保留可用的类型，修复缺失的最小元数据

`migrateWikiToOkf` 遍历可见概念页并调用 `normalizeConceptContent`。只要 YAML 可解析且 `type` 是非空字符串，就原样保留页面；否则从正文一级标题或文件名推导 title，加上默认类型及 `openwiki_generated: true`，供模型进一步整理。

这项修复只生成最小字段，不猜 description。它会保留可解析的翻译 pending 扩展字段，但不承诺在重建坏 front matter 时保留所有自定义字段。

迁移条件比严格校验宽松。已有有效 `type`，但 `title` 是错误类型的页面，不会被迁移器强制重写；索引生成时会忽略无效 title 并回退到文件名。这样减少了覆盖作者元数据的风险，也表示“迁移完成”不等同于“所有可选字段通过严格校验”。

### 工具返回前：把落盘错误变成模型可见的反馈

`write_file` 和 `edit_file` 通过 Backend 写入成功后，结果 metadata 带有 `openwikiMutationPath`。`addFrontmatterWarning` 从 `ToolMessage` 取路径；ToolMessage 是工具返回给模型的消息对象，也可能包装在一个带 `update.messages` 的结果里。

`src/agent/okf-middleware.ts` · `addFrontmatterWarning`（第 61–83 行，节选）：

```ts
// 只向符合条件的变更消息追加 warning，不撤销文件写入。
if (!WRITE_TOOLS.has(toolName)) return result;

const mutation = getToolMessages(result)
  .map((message) => ({
    message,
    path: message.metadata?.[MUTATION_PATH_METADATA_KEY],
  }))
  .find(
    (item): item is { message: ToolMessage; path: string } =>
      typeof item.path === "string" &&
      isWikiMarkdownPath(item.path, outputMode),
  );
if (!mutation) return result;

const validation = await validatePersistedFile(backend, mutation.path);
if (validation.valid) return result;

const warning = formatWarning(mutation.path, validation.issues);
mutation.message.content =
  typeof mutation.message.content === "string"
    ? `${mutation.message.content}\n\n${warning}`
    : [...mutation.message.content, { text: warning, type: "text" }];
return result;
```

函数只处理指定写工具、带变更路径且属于 Wiki Markdown 的结果，排除 `index.md` 和 `log.md`。它读取已经落盘的文件，而不只校验工具输入，所以看到的是实际文件内容。

`validateOkfFrontmatter` 要求 YAML 是映射、键不重复、`type` 存在，已提供的字符串字段和 tags 符合类型要求。发现问题后，在原工具消息中追加文件路径、错误码和可用行号，模型下一轮可据此修改。

warning 不会撤销写入，也没有强制重试计数器；Prompt 要求修正不等于代码保证模型一定修好。中间件内部直接调用 Backend 的翻译和索引操作也不经过这条 Agent 工具包裹层。

### 运行结束：图表降级和目录同步

`validateWikiMermaid` 读取页面中的 Mermaid 图表代码块。有可用的 Mermaid 解析器时执行解析；可选依赖未安装或加载失败时使用有限启发式检查。无效图块会保留原内容，改成 `text` 代码块并附加错误注释，等待后续修复。

图表语法不合法通常导致降级，不会直接令整次运行失败。读取页面或写回降级结果失败则可能抛错。启发式未发现问题，也不能证明完整解析器一定接受该图。

随后 `synchronizeWikiIndexes` 递归收集可见目录，先处理子目录，再处理父目录。每个目录重新读取概念页元数据，必要时再做最小规范化，按路径排序文件和子目录链接。文件标题取可用 title，否则取文件名；description 有效时追加到链接后。

`src/okf/index-sync.ts` · `synchronizeDirectory`（第 206–218 行，节选）：

```ts
// 已有索引与生成内容相同则退出，否则通过 Backend 写回。
const existing = directory.entries.some(
  (entry) => !entry.is_dir && entryName(entry) === INDEX_FILE,
)
  ? await readText(backend, indexPath)
  : null;
if (existing === content) return;

const result = existing
  ? await backend.edit(indexPath, existing, content)
  : await backend.write(indexPath, content);
if (result.error) {
  throw new Error(`Unable to write ${indexPath}: ${result.error}`);
}
```

新旧内容一致时不写。根索引带 `okf_version: "0.1"`，目录导航由文件树推导，所以手工编辑 `index.md` 不适合保存独有知识，下次同步可能覆盖它。复杂的阅读说明应放在模型维护的 quickstart 或概念页中。

## 事件流结束后，快照决定是否保存元数据

正常事件流结束后，应用处理持久化 checkpoint 文件权限、清理临时计划，再调用 `persistRunMetadataIfChanged(..., "complete", ...)`。关键规则是：

`src/agent/utils.ts` · `persistRunMetadataIfChanged`（第 228–241 行，节选）：

```ts
if (command === "chat" || snapshotBefore === null) {
  return false;
}

if (
  snapshotBefore === (await createOpenWikiContentSnapshot(cwd, outputMode))
) {
  // 成功运行即使没有改内容，也要清除上次的 interrupted 状态，
  // 使之后的 update 可以再次命中 no-op。
  const lastUpdate = await readLastUpdate(cwd, outputMode);
  if (status !== "complete" || lastUpdate?.status !== "interrupted") {
    return false;
  }
}
```

页面没有变化时通常不写 metadata，避免只刷新时间戳产生无意义差异。但有一个恢复特例：上次是 interrupted、本轮成功，即使内容完全没变，也写 complete 清除中断标记。

| 本轮结果 | 内容快照变化 | 上次状态 | 是否写入元数据 |
| --- | --- | --- | --- |
| complete | 有 | 任意 | 写 complete |
| complete | 无 | interrupted | 写 complete，清除中断 |
| complete | 无 | complete 或无记录 | 不写 |
| interrupted | 有 | 任意 | 尝试写 interrupted |
| interrupted | 无 | 任意 | 不写新记录；原有记录保留 |
| chat | 不比较 | 任意 | 不写更新记录 |

不写 metadata 也就不推进 Git 基线。因此源码已变化但模型判断无需改文档时，下一次 update 可能再次处理相同提交。它以“Wiki 内容变化”作为持久化门槛，节省了记录噪音，但没有单独保存“源码已检查、无需改页”的进度。

`writeLastUpdateMetadata` 实际写入更新时间、command、model、status 和 language；repository 的 Git HEAD 在写入时重新获取。该文件记录更新依据，不保存页面旧版本、模型消息或完整异常信息。

## 哪些失败会进入 interrupted 收尾

`runOpenWikiAgentCore` 的恢复 catch 包围事件流迭代。迭代抛错时，代码尽力删除 `_plan.md`，调用同一个快照比较函数尝试写 interrupted，并吞掉这两项收尾错误以继续抛出原始运行异常。

已落盘页面不会回滚；若其内容确实变了且 interrupted 记录成功，下一轮 no-op 会拒绝跳过，模型重新读取现有 Wiki 后继续修正。

这个 catch 没有包住整次函数：`agent.streamEvents(...)` 的打开位于 try 之前；正常流结束后的计划清理和 metadata 写入位于 try 之后。模型创建、流打开或正常收尾阶段失败，并不保证经过同一 interrupted 写入路径。外层会记录运行失败并抛错，但不能替代 Wiki 目录内的恢复标记。

翻译单页失败又是另一种状态：局部错误被中间件吸收后，整轮仍可能以 complete 结束，待重试信息保存在页面字段中。运维端判断完成度时需要区分“执行图正常结束”和“所有页面均达到目标”，不能只读一个全局 status。

## 案例续：页面写入之后，下一次 update 会怎样

延续 [02 的 raw 读取规则案例](./02-agent-assembly.md)：本轮源码提交为 H1，旧更新记录指向 H0；模型已补充 `openwiki/integrations/connectors.md`，页面 front matter 有效。下表按“正文改动、标题与描述不变”的成功分支推演，并假定运行期间没有其他写入。

| 时点 | 页面与运行状态 | 当前代码的动作 |
| --- | --- | --- |
| Agent 启动前 | Wiki 内容快照记为 S0，metadata 仍指向 H0 | 快照只留哈希，不复制旧页面 |
| edit_file 成功后 | 连接器页正文已改变，metadata 仍指向 H0 | 写后中间件检查落盘 YAML；有效则返回原工具结果 |
| afterAgent | 连接器页保留新正文 | 检查 Mermaid，重新生成可见目录的索引内容 |
| 正常流结束后 | 清理 `_plan.md`，新内容快照为 S1 | S1 与 S0 不同，进入元数据写入 |
| 元数据写入成功 | 记录 `status: "complete"`、当前 Git HEAD H1 等字段 | 本轮返回成功，供后续 update 使用 |

索引内容取决于文件列表、标题和描述，不会因为正文多了一段就必然变化。本例没有改这些索引输入，且原索引已同步时，生成结果相同，`synchronizeDirectory` 直接返回；内容快照仍因正文变化而不同。删除临时计划则不会制造额外的业务变化，因为快照本来就排除根目录的 `_plan.md`。

### 成功后立即再运行，未必命中 no-op

本轮没有自动提交 Wiki。刚写出的连接器页还在工作区中，下一次无消息 update 会把它当作有效未提交改动，即使 HEAD 仍是 H1，也可能继续启动 Agent。

如果随后把生成页面提交为 H2，并且 H1 到 H2 只改了 Wiki、工作区没有其他有效变化，那么下次 no-op 才可以跳过：记录的基线仍是 H1，但提交差异只包含 `openwiki/`。跳过路径不会再写一份 metadata 来把基线推进到 H2。

### 写完页面后中断，恢复的是检查机会

假设 edit_file 已成功，但后续事件流迭代抛错，索引同步尚未完成。catch 会尝试清理计划文件；只要页面改动仍使快照不同，就尝试保存 `status: "interrupted"`。文件保留已经写入的内容，下一轮因中断标记而不能被 no-op 跳过。

重新运行后，模型可以确认正文无需再改，由中间件补齐结构收尾。即使本轮最终快照完全没变，成功收尾仍会把上次的 interrupted 清为 complete。这个恢复过程重新检查现有文件，没有重放上次失败的模型请求，也不恢复旧文件版本。

若失败发生在正常流结束后的 metadata 写入阶段，则不经过上述 catch。此时页面可能已经完整、更新记录却仍是旧值；不能仅凭运行报错就推断 Wiki 一定带有 interrupted。恢复保证始终取决于错误发生的位置及元数据是否写成功。

这套机制适合允许逐步修订的文档库。如果产品要求整库原子发布，应让 Agent 写入独立暂存目录，校验后再统一替换发布版本，并单独保存待重试任务。仅依赖 checkpoint 和 interrupted 标记，无法获得文件事务或自动回滚。
