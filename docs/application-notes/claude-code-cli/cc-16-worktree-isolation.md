# Worktree 文件隔离

> **本章目标**：理解 Claude Code 如何通过 Git Worktree 为每个并行任务提供独立的文件系统副本——为什么这种隔离方式比进程级文件锁更彻底，worktree 的完整生命周期包含哪些阶段，如何应对崩溃残留、磁盘占用、gitignored 文件同步等工程挑战。
>
> **读完本章你应该能回答**：
> - 为什么用 Git Worktree 而不是简单的进程级文件锁来解决 Agent 间的文件冲突？
> - Worktree 的创建 → 后置配置 → 切换 cwd → Agent 运行 → 退出清理，五个阶段分别做了什么？
> - 三种入口（CLI fast-path、EnterWorktreeTool、createAgentWorktree）分别服务于什么场景？
> - `.worktreeinclude` 如何让被 gitignore 的本地配置文件安全地同步到 worktree？
> - 崩溃/进程被杀后残留的 worktree 如何被识别和清理？为什么批量清理永远不会误删用户手动创建的 worktree？

**文章结构**：

| 章节 | 内容 | 阅读建议 |
|------|------|---------|
| 一 | 它在解决什么问题、与其他隔离机制的差异 | 必读，建立问题意识 |
| 二 | 它放在架构的哪个位置、与上下文隔离的关系 | 必读，建立全局坐标 |
| 三 | 问题场景：竞争条件的具体形态 | 必读，直观感受冲突 |
| 四 | Git Worktree 基础：文件系统机制、与文件锁的对比、磁盘开销 | 必读，理解底层原理 |
| 五 | Worktree 生命周期：三种入口、六阶段流程 | **核心章节**，看流程图建立骨架 |
| 六 | 核心实现代码：创建/后置配置/EnterWorktree/ExitWorktree/子 Agent | 在骨架基础上填细节 |
| 七 | 分支命名规范与 slug 验证规则 | 选读，做相关功能时查阅 |
| 八 | `.worktreeinclude` 机制：白名单同步 gitignored 文件 | 选读，理解边缘工程问题 |
| 九 | Cleanup 策略：safety 保证、periodic cleanup、crash 恢复 | 选读，理解长期运行可靠性 |
| 十 | Worktree 与 Claude Code 其他模块的集成 | 选读，按需查阅 |
| 十一 | 设计决策与权衡 | 理解为什么这样设计 |
| 十二 | 边界与局限 | 了解当前实现的不足 |
| 十三 | 可复用的模式 | 提炼可迁移的设计模式 |
| 十四 | 相关代码路径速查表 | 按需查阅 |

---

## 一、它在解决什么问题

当多个 Agent 并行修改文件时，如果它们共享同一个文件系统，就会出现竞争条件：Agent A 读文件 → Agent B 写文件 → Agent A 写文件（覆盖 B 的改动）。这种"读 → 写"之间的窗口期（TOCTOU，Time-of-Check-Time-of-Use）是文件系统并发操作中最常见的陷阱。

worktree 给每个 Agent 一个独立的 Git worktree 文件副本，让并行操作在物理上完全隔离——每个 Agent 拥有自己的文件副本，自己的分支，自己的 `.git/index` 引用，文件操作互不干扰。

这个问题的本质与子 Agent 上下文隔离（[10-subagent-isolation]）类似但**正交**：上下文隔离解决"token 爆炸"——让每个 Agent 拥有独立的 `messages` 数组，不被其他 Agent 的对话历史污染；worktree 解决"文件冲突"——让每个 Agent 拥有独立的工作树，不被其他 Agent 的文件操作覆盖。两者针对的资源维度完全不同，因此可以叠加使用。

---

## 二、它放在架构的哪个位置

worktree 位于 Agent 的 Act 阶段——在执行文件操作前，切换工作目录到独立副本。它不是一个独立的子系统，而是**文件操作的前置基础设施**：

```
Agent 循环（每次 while 迭代）
  │
  ├─► 阶段 1: 上下文准备
  ├─► 阶段 2: API 调用
  ├─► 阶段 3: 判断去向
  ├─► 阶段 4: 工具执行
  │     │
  │     ├─► findToolByName → 权限检查 → tool.call()
  │     │
  │     └─► 如果当前在 worktree session 内：
  │           所有文件操作（Read/Write/Edit/Bash）指向
  │           .claude/worktrees/<slug>/ 而非原始仓库
  │
  └─► 阶段 5: 下一轮准备
```

worktree 与上下文隔离的关系是**正交**而非嵌套：

- **上下文隔离**（子 Agent）——每个 Agent 有独立的 `messages` 数组和 `state` 对象
- **文件隔离**（worktree）——每个 Agent 有独立的文件工作树和分支
- **可叠加**——主 Agent 可以在 worktree A 内，子 Agent 可以在 worktree A 内（共享文件副本但独立上下文），也可以在 worktree B 内（完全独立）

工作目录的切换通过 `setCwd()` 和 `process.chdir()` 写入模块全局状态（`src/utils/bootstrap/state.ts`），所有后续的工具调用都会自动使用新的 cwd。

---

## 三、问题场景

先用一个具体的例子说明"为什么需要 worktree"。假设两个 Agent 同时工作，编辑同一个文件：

```
Agent A: 编辑 src/auth.ts  ──► 写入 auth.ts v2
Agent B: 编辑 src/auth.ts  ──► 写入 auth.ts v3  ← 覆盖了 v2！

使用 Worktree 后：
Agent A: 编辑 .claude/worktrees/agent-a1234abc/src/auth.ts  ──► 写入 auth.ts v2
Agent B: 编辑 .claude/worktrees/agent-b5678def/src/auth.ts  ──► 写入 auth.ts v3
                                                                   （互不干扰）
```

即使两个 Agent 都在编辑同一份逻辑代码（`auth.ts`），因为它们工作在不同的 worktree 目录（`.claude/worktrees/agent-a1234abc/` vs `.claude/worktrees/agent-b5678def/`），物理上不可能出现"覆盖"。最终的合并由用户决定（merge / cherry-pick / 选择保留哪一份）。

更糟糕的场景：Agent A 在"读 → 修改 → 写"的间隙，Agent B 完成整个"读 → 修改 → 写"流程。Agent A 写回时不仅覆盖 Agent B 的结果，还基于过时的文件内容（缺少 Agent B 的新增逻辑）写入——这种"读到的内容和写回的预期不符"是经典 TOCTOU 问题。

---

## 四、Git Worktree 基础

### 文件系统层面

`git worktree add` 在同一仓库下创建**共享 git objects**（位于 `.git/`）的多个独立工作树：

```
原始仓库：
  /repo/.git/                          ← 共享对象存储（commit/tree/blob）
  /repo/src/auth.ts                    ← 工作树（branch: main）

加 worktree 后：
  /repo/.git/                          ← 共享（仍只有一份）
  /repo/src/auth.ts                    ← 主工作树
  /repo/.claude/worktrees/feature-x/   ← 新工作树
    .git → /repo/.git                  ← 符号链接（指向共享对象存储）
    src/auth.ts                        ← 独立工作树文件（branch: worktree-feature-x）
```

**关键机制**：
- **git objects 共享**：所有 worktree 的 `.git/objects/` 是同一份——commit、tree、blob 不重复存储（Git 用 content-addressed 存储，对相同内容只存一份）
- **每个 worktree 独立 `.git/index`** 和独立 `HEAD` 引用（每个 worktree 跟踪自己的暂存区和当前 commit）
- **`git worktree add -b <branch> <path> <commit>`** 创建新 worktree + 新分支（`-B` 强制重置已存在的分支）
- **同分支不能在两个 worktree 中 checkout**：git 会拒绝（"already used by worktree at..."）——这是为什么每个 worktree 必须用独立的分支

### 为什么不是简单的进程级文件锁

锁的问题是：锁会阻塞操作。Agent 的工作流是「读 → 决定 → 写」，并发 Agent 都要"读"，但是 commit/checkout/build/test 阶段会冲突。

更严重的是，Agent 的某些操作（如 `npm install`、`npm run build`）会创建大量临时文件和目录，文件锁的开销会显著拖慢这些操作。用 worktree 给每个 Agent 一个独立工作树副本让它们**完全并发**——build 不会撞，commit 也不会撞，各自在自己的目录里完成所有操作。

锁方案与 worktree 方案的对比：

| 维度 | 进程级文件锁 | Git worktree |
|------|-------------|--------------|
| 并发能力 | 串行化（一个写其他都等） | 完全并行（各自独立副本） |
| 阻塞 | 是（读都要拿读锁） | 否（互不影响） |
| build/test 隔离 | 需要 lock 整个 build 目录 | 天然隔离 |
| git 操作 | commit 互相冲突 | 独立分支，互不冲突 |
| 实现复杂度 | 中等（死锁、优先级） | 中等（worktree 生命周期） |

worktree 不是"无成本"的——下一个章节会讲它的磁盘开销——但换来的是真正的不阻塞并发。

### 文件系统开销

每个 worktree 复制 **tracked** 文件到子目录。一个大 repo（210k 文件）的 worktree 在 Linux 上是 ~500MB-1GB（独立 inodes + 完整 .git 重定向）。Git 通过 hardlink 优化历史 blob（在 `local-filesystem` 配置下）但实际工作树文件是独立副本。

这个开销的工程含义：
- 同一时刻只能跑有限数量的并行 Agent（受限于磁盘空间）
- 30 天未活动的 worktree 会被 periodic cleanup 清理（[第九章](#九cleanup-策略)）
- 可以通过 `settings.worktree.sparsePaths` 只 checkout 部分目录（减少初始开销）
- 可以通过 `settings.worktree.symlinkDirectories` 软链大目录如 `node_modules`（节省 500MB+）

---

## 五、Worktree 生命周期

### 三种入口

Claude Code 提供 3 个 worktree 创建入口，覆盖不同使用场景：

| 入口 | 场景 | 代码位置 |
|------|------|---------|
| `claude --worktree [slug]` | 启动 CLI 进 worktree（fast-path） | `worktree.ts:1182-1518` `execIntoTmuxWorktree()` |
| `EnterWorktreeTool` | mid-session 进入 | `packages/builtin-tools/.../EnterWorktreeTool.ts` |
| `createAgentWorktree()` | 子 Agent 隔离 | `worktree.ts:902-952` |
| `WorktreeCreate` hook | 非 git VCS 自定义后端 | `hooks.ts` |

这三种入口覆盖了完整的生命周期：
- **CLI 启动时进入**：用户希望整个会话都在隔离环境中运行
- **mid-session 进入**：Agent 在执行过程中需要隔离（通常配合计划模式或复杂任务）
- **子 Agent 自动隔离**：每个子 Agent 自动获得独立 worktree，互不干扰
- **Hook 接管**：Mercurial、SVN、Pijul 等非 Git VCS 可通过 hook 注入自己的 worktree 实现

### 生命周期阶段

worktree 从创建到销毁的完整生命周期分为 6 个阶段：

```
  ┌─────────────────────┐
  │ 1. 路径解析          │
  │    - 当前 cwd 找 git root
  │    - 解析 .worktreeinclude
  │    - 解析 worktree config
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │ 2. worktree 创建     │
  │    - 读 .git pointer（快速 resume）
  │    - 否则 git fetch + git worktree add
  │    - PR 模式：git fetch origin pull/<n>/head
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │ 3. 后置配置          │
  │    - 复制 settings.local.json
  │    - 设置 git hooksPath
  │    - symlink 目录（node_modules）
  │    - 同步 .worktreeinclude 文件
  │    - 安装 attribution hook（COMMIT_ATTRIBUTION）
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │ 4. 切换 cwd          │
  │    - process.chdir()
  │    - setCwd()
  │    - saveWorktreeState() 持久化到项目配置
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │ 5. Agent 运行中       │
  │    - 文件操作在 .claude/worktrees/<slug> 内
  │    - 子 Agent 可在同一 worktree 内执行
  │    - 备份触发 SaveTrackedFilesToSnapshot
  └──────────┬──────────┘
             │
  ┌──────────▼──────────┐
  │ 6. 退出 / 清理       │
  │    - ExitWorktreeTool (keep|remove)
  │    - cleanupWorktree() 调用 git worktree remove
  │    - 删除临时分支 git branch -D
  │    - 触发 WorktreeRemove hook
  │    - 设置 cwd 回原始目录
  └─────────────────────┘
```

**为什么后置配置不能省**？worktree 创建后立刻面临几个问题：hooks 路径可能指向主 repo 的相对路径（worktree 里找不到）、本地配置文件（`.env`、`.claude/settings.local.json`）不在 git tracked 列表里但项目需要它们运行、attribution hook 需要写入 worktree 的 `.husky/`。这些"worktree 之外但 worktree 之内需要的资源"必须显式同步。

**为什么需要切换 cwd**？所有文件操作（Read/Write/Edit/Bash）的路径都基于进程的 cwd。如果不切换 cwd，工具调用会继续指向原始仓库，worktree 完全失效。`process.chdir()` 改变 OS 级 cwd，`setCwd()` 更新模块全局状态，两者必须同时调用。

**为什么需要持久化状态**？`--resume` 重连会话时，需要恢复"我之前在哪个 worktree 里"，否则工具调用会指向错误的目录。`saveWorktreeState()` 把 worktree 元数据写入项目 settings，下次启动时通过 `restoreWorktreeSession()` 读回。

---

## 六、核心实现代码

理解了生命周期骨架后，下面逐一展开每个阶段的实现细节。

### 创建 worktree

`src/utils/worktree.ts:702-778` — `createWorktreeForSession()`：

```typescript
export async function createWorktreeForSession(
  sessionId: string,
  slug: string,
  tmuxSessionName?: string,
  options?: { prNumber?: number },
): Promise<WorktreeSession> {
  // 1. 验证 slug 防止路径穿越
  validateWorktreeSlug(slug);

  const originalCwd = getCwd();

  // 2. 优先尝试 WorktreeCreate hook（支持非 git VCS）
  if (hasWorktreeCreateHook()) {
    const hookResult = await executeWorktreeCreateHook(slug);
    return {
      originalCwd,
      worktreePath: hookResult.worktreePath,
      worktreeName: slug,
      sessionId,
      tmuxSessionName,
      hookBased: true,
    };
  }

  // 3. 否则用 git worktree
  const gitRoot = findGitRoot(getCwd());
  if (!gitRoot) {
    throw new Error('Cannot create a worktree: not in a git repository...');
  }

  const originalBranch = await getBranch();

  const createStart = Date.now();
  const { worktreePath, worktreeBranch, headCommit, existed } =
    await getOrCreateWorktree(gitRoot, slug, options);

  if (!existed) {
    // 4. 首次创建：执行后置配置
    await performPostCreationSetup(gitRoot, worktreePath);
  }

  return {
    originalCwd,
    worktreePath,
    worktreeName: slug,
    worktreeBranch,
    originalBranch,
    originalHeadCommit: headCommit,
    sessionId,
    tmuxSessionName,
    creationDurationMs: existed ? undefined : Date.now() - createStart,
  };
}
```

代码展示了几个关键决策：

1. **slug 验证先于一切**——在 git 命令、hook 执行、chdir 之前确保 slug 安全（路径穿越 / shell 注入会被早期拒绝）
2. **Hook 优先于 git**——如果用户配置了 `WorktreeCreate` hook（可能用于非 git VCS），直接调用 hook 而不走 git worktree 路径
3. **Fast resume 优化**——`getOrCreateWorktree` 内部先检查 `.git` pointer 文件，已存在则跳过 fetch + add，省 ~15ms
4. **只首次创建时跑后置配置**——如果 worktree 已存在（resume），不重复执行 settings 复制、hooksPath 配置等

### 创建或恢复（`getOrCreateWorktree`）

`worktree.ts:235-375`：

```typescript
async function getOrCreateWorktree(repoRoot, slug, options?) {
  const worktreePath = worktreesDir + flattenSlug(slug);
  const worktreeBranch = `worktree-${flattenSlug(slug)}`;

  // Fast resume path — 读 .git pointer 文件，无需 subprocess
  const existingHead = await readWorktreeHeadSha(worktreePath);
  if (existingHead) {
    return { worktreePath, worktreeBranch, headCommit: existingHead, existed: true };
  }

  // 1. 创建 .claude/worktrees 目录
  await mkdir(worktreesDir(repoRoot), { recursive: true });

  // 2. 解析 base 分支
  // - 如果 options.prNumber: git fetch origin pull/<n>/head
  // - 否则: 用 origin/<defaultBranch>（如果本地已存在），否则 fetch
  const [defaultBranch, gitDir] = await Promise.all([
    getDefaultBranch(),
    resolveGitDir(repoRoot),
  ]);
  const originSha = gitDir
    ? await resolveRef(gitDir, `refs/remotes/origin/${defaultBranch}`)
    : null;

  let baseBranch = `origin/${defaultBranch}`;
  if (!originSha) {
    // origin ref 不在本地 — fetch 一次
    await execFileNoThrowWithCwd(gitExe, ['fetch', 'origin', defaultBranch], ...);
  }

  // 3. git worktree add -B <branch> <path> <base>
  // -B (不是 -b)：强制重置已存在的 orphan 分支（之前的 worktree 残留）
  await execFileNoThrowWithCwd(gitExe, [
    'worktree', 'add', '-B', worktreeBranch, worktreePath, baseBranch
  ], { cwd: repoRoot });

  // 4. 可选 sparse-checkout
  const sparsePaths = getInitialSettings().worktree?.sparsePaths;
  if (sparsePaths?.length) {
    // --no-checkout 创建 empty worktree
    await git.sparse-checkout set --cone -- <patterns>
    await git.checkout HEAD
  }

  return { worktreePath, worktreeBranch, headCommit, existed: false, baseBranch };
}
```

**Fast resume 优化**：`readWorktreeHeadSha` 直接读 `.git` pointer 文件，省去 `git rev-parse HEAD` 的 ~15ms subprocess 启动。在频繁 resume 同一 worktree 的场景下显著降低延迟。这是个细节优化——单次 resume 看不到区别，但如果一个会话被频繁暂停 / 恢复（如 IDE 集成场景），累积延迟显著。

**为什么用 `-B` 而非 `-b`**：`-b` 在分支已存在时报错，强制重置已存在的 orphan 分支。之前的 worktree 残留可能留下同名分支（cleanup 没跑完），用 `-B` 确保幂等——重复创建同名 worktree 不会失败。

### 后置配置（`performPostCreationSetup`，`worktree.ts:510-624`）

后置配置解决的是"worktree 创建后还需要什么才能正常工作"的问题：

```
1. 复制 settings.local.json 到 worktree
   ├─ 让每个 worktree 有独立的 local 配置
   ├─ 可能含 secrets，保留在 gitignored .claude/ 内

2. 配置 git hooksPath（指向主 repo 的 .husky/ 或 .git/hooks/）
   ├─ 让 worktree 共享主 repo 的 hooks
   ├─ 避免 husky 脚本因相对路径失效

3. symlink 大目录（settings.worktree.symlinkDirectories）
   ├─ 例如 ['node_modules'] — 节省磁盘（~500MB）
   ├─ ENOENT/EEXIST 错误静默跳过

4. 同步 .worktreeinclude 声明的 gitignored 文件

5. 安装 attribution hook（COMMIT_ATTRIBUTION feature）
   └─ 直接写入 worktree 的 .husky/（绕开 shared config 不稳定问题）
```

**为什么 settings.local.json 要复制而非共享**：worktree 之间需要独立的本地配置（如某个 worktree 启用了某个 beta feature，其他 worktree 不需要）。同时 settings.local.json 可能含 secrets，放在 gitignored 的 `.claude/` 下安全。

**为什么 hooksPath 要指向主 repo**：husky 等工具的脚本路径通常用相对路径解析（如 `husky.sh` 在 `.husky/` 内）。如果 worktree 内的 hooksPath 指向自己的 `.husky/`（空目录或不存在），hooks 不会触发。指向主 repo 的 `.husky/` 让所有 worktree 共享同一份 hooks。

### CLI 入口调用链路（`EnterWorktreeTool`）

`packages/builtin-tools/src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:77-119`：

```typescript
async call(input) {
  // 1. 验证：不能在嵌套 worktree 内（已经是 worktree session）
  if (getCurrentWorktreeSession()) {
    throw new Error('Already in a worktree session');
  }

  // 2. 解析到主 repo root — 处理嵌套 worktree
  const mainRepoRoot = findCanonicalGitRoot(getCwd());
  if (mainRepoRoot && mainRepoRoot !== getCwd()) {
    process.chdir(mainRepoRoot);
    setCwd(mainRepoRoot);
  }

  // 3. 默认 slug 用 plan slug 或随机
  const slug = input.name ?? getPlanSlug();

  // 4. 创建
  const worktreeSession = await createWorktreeForSession(getSessionId(), slug);

  // 5. 切换 cwd
  process.chdir(worktreeSession.worktreePath);
  setCwd(worktreeSession.worktreePath);
  setOriginalCwd(getCwd());

  // 6. 持久化状态 + 清理 cwd-依赖缓存
  saveWorktreeState(worktreeSession);
  clearSystemPromptSections();   // env_info 重算
  clearMemoryFileCaches();       // CLAUDE.md 重读
  getPlansDirectory.cache.clear?.();

  return { data: { worktreePath, worktreeBranch, message: ... } };
}
```

`findCanonicalGitRoot()` 关键：嵌套 worktree 内调用时返回**主 repo root**而非 worktree root，确保 `.claude/worktrees/<slug>/` 始终位于主 repo 下（不会被嵌套在另一 worktree 目录中导致后续 cleanup 找不到）。

**为什么需要清缓存**：切换 cwd 后，很多与路径相关的缓存都失效了：
- `systemPromptSections` 包含 `env_info`（cwd 是 env_info 的一部分），需要重算
- `memoryFileCaches` 缓存了 CLAUDE.md 的内容，路径变了需要重读
- `getPlansDirectory()` 返回当前 cwd 下的 `.claude/plans/`，切换后指向 worktree 的目录

### 退出 worktree（`ExitWorktreeTool`）

`packages/builtin-tools/src/tools/ExitWorktreeTool/ExitWorktreeTool.ts`：

**安全门控**（`validateInput`，`ExitWorktreeTool.ts:174-223`）：

```
action === 'remove' && !discard_changes:
  1. git status --porcelain                → changed files 数量
  2. git rev-list --count <head>..HEAD     → 提交数量
  3. 任意 > 0 → 拒绝，要求 discard_changes: true
  4. git 失败 → null → fail-closed（即使 status 干净也拒绝）
```

**fail-closed** 是关键设计：当 git 命令失败时（无法确定状态），宁可拒绝清理也不冒险删除。用户明确 `discard_changes: true` 才允许丢弃改动。

**两种 action**：

| `action` | 行为 | 调用 |
|---------|------|------|
| `keep` | 保留 worktree + 分支；cwd 回到原目录 | `keepWorktree()` |
| `remove` | git worktree remove --force + 删除 worktree-* 分支 + 删除目录；cwd 回到原目录 | `cleanupWorktree()` |

```
keepWorktree (worktree.ts:780-811):
  - process.chdir(originalCwd)
  - currentWorktreeSession = null
  - 清 activeWorktreeSession in project config
  - 保留 worktreePath 和 worktreeBranch 在磁盘

cleanupWorktree (worktree.ts:813-894):
  - process.chdir(originalCwd)
  - git worktree remove --force <worktreePath>
    - 若 hook-based: executeWorktreeRemoveHook(worktreePath)
  - sleep(100)             # 等 git 释放锁
  - git branch -D <branch> # 强制删除临时分支
  - currentWorktreeSession = null
  - 清 activeWorktreeSession
```

**为什么 cleanupWorktree 需要 `sleep(100)`**：git 在某些情况下会持有内部锁（写索引时）。`worktree remove` 后立刻 `branch -D` 可能因锁冲突失败，100ms 延迟确保锁释放。

### 子 Agent worktree（`createAgentWorktree`）

`worktree.ts:902-952`：

```
子 Agent 入口 createAgentWorktree(slug):
  - 不触碰 currentWorktreeSession（不污染主 session 状态）
  - 不 chdir（cwd 在主 session 里）
  - findCanonicalGitRoot（vs findGitRoot）确保 worktree 在主 repo 下
  - 返回 { worktreePath, worktreeBranch, headCommit, gitRoot }
  - 存在时调用 utimes() 刷新 mtime（防止 periodic cleanup 误判为 30-day stale）

清理 removeAgentWorktree:
  - 从 gitRoot 运行 git worktree remove --force <worktreePath>
  - 删除对应 worktree-<slug> 分支
  - hook-based 走 WorktreeRemove hook
```

子 Agent 的 worktree 隔离有几个关键差异：
- **不 chdir**——子 Agent 在主 session 的 cwd 中运行，worktree 路径只是作为子 Agent 的工具调用工作目录
- **不触碰 currentWorktreeSession**——避免子 Agent 创建的 worktree 被误认为是主 session 的
- **utimes() 刷新 mtime**——如果子 Agent 频繁创建/清理同名 worktree，mtime 会一直更新，periodic cleanup 不会误判为 stale

---

## 七、分支命名规范

所有 worktree 分支遵循统一前缀 `worktree-<flattened-slug>`：

```typescript
function flattenSlug(slug: string): string {
  return slug.replaceAll('/', '+');  // user/feature-foo → user+feature-foo
}

function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}
```

**为什么 `+` 替换 `/`**：
- git 把 `/` 当 ref path 分隔符：`refs/heads/worktree-user/feature` 变成 `worktree-user/feature`（独立目录）vs `worktree-user-feature`（一个 ref）—— D/F 冲突，git 拒绝
- `.claude/worktrees/user/feature/` 嵌套在 `.claude/worktrees/user/` 子 worktree 目录内—— `git worktree remove` 父 worktree 时会递归删子目录，丢失子 worktree 的工作

**slug 验证规则**（`worktree.ts:66-87` `validateWorktreeSlug`）：

```typescript
const VALID_WORKTREE_SLUG_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const MAX_WORKTREE_SLUG_LENGTH = 64;

// 拒绝 `.` / `..` 段（path.join 会规范化导致逃逸）
// 拒绝绝对路径前缀（path.join 丢弃前缀）
// 拒绝特殊字符（防止 shell injection 或路径问题）
// 接受 nested: `asm/feature-foo`（每个段独立验证）
```

不通过 slug 验证会**同步抛出错误**——在 git 命令、hook 执行、chdir 之前确保失败。

### 典型 slug 来源

| 入口 | slug 格式 | 代码位置 |
|------|---------|---------|
| `claude --worktree feature-x` | `feature-x`（literal） | `worktree.ts:1217` |
| `claude --worktree https://github.com/foo/bar/pull/123` | `pr-123`（auto-derived） | `worktree.ts:1226-1233` |
| `claude --worktree`（无参数） | `<adj>-<noun>-<random4>`（随机） | `worktree.ts:1235-1243` |
| `EnterWorktreeTool {name}` | user input（可选） | `EnterWorktreeTool.ts:90` |
| `EnterWorktreeTool`（无参数） | `getPlanSlug()` | `EnterWorktreeTool.ts:90` |
| `AgentTool` 隔离 | `agent-a<7hex>`（earlyAgentId） | `worktree.ts:1032-1034` |
| `workflowEngine` isolation: 'worktree' | `wf_<8hex>-<3hex>-<n>` | `worktree.ts:1034` |
| `bridgeMain` | `bridge-<safeFilenameId>` | `worktree.ts:1039` |
| `Template` job | `job-<templateName>-<8hex>` | `worktree.ts:1042` |

---

## 八、`.worktreeinclude` 机制

### 工作原理

`git worktree add` 默认只创建 **tracked** 文件。`.gitignore` 中的文件不会出现在新 worktree 里——但很多项目需要这些文件才能运行（`.env`、`config.local.json`、`*.lock` 中的覆盖等）。

`.worktreeinclude` 是反-`.gitignore`：声明哪些**应该被同步**到 worktree 的 gitignored 文件。

```bash
# 示例 .worktreeinclude
.env
!.env.example      # 只有部分 .env.* 需要
config/local.json
```

**为什么不直接全部同步**：`.env`、secrets 等 gitignored 文件通常包含敏感信息（API keys、database credentials），默认全部同步会泄露到 worktree 目录。`.worktreeinclude` 让用户显式声明"哪些 gitignored 文件是项目运行必需的"——opt-in 比 opt-out 安全。

### 实现（`worktree.ts:391-504` `copyWorktreeIncludeFiles`）

```
1. 读 .worktreeinclude（不存在 → skip）
2. 解析为 patterns 数组
3. git ls-files --others --ignored --exclude-standard --directory
   - 列出所有 gitignored 条目
   - --directory flag 把完全被忽略的目录折叠成单个 entry
     (例如 node_modules/ 不会列内部所有文件，只列 "node_modules/")
4. 用 `ignore` npm 包过滤 vs patterns
5. 必要时展开 collapsed 目录（如 pattern 指向 collapsed 目录内部的路径）
6. 复制每个匹配文件到 worktree
```

**性能优化**：用 `--directory` 折叠把 ~500k entries 减少到 ~几百个 entries（7s → 100ms）。

### Edge case 处理

如果 `.worktreeinclude` pattern 指向 collapsed 目录**内部的具体路径**（如 `config/secrets/api.key`），但整个 `config/secrets/` 被 gitignore（无 tracked sibling），需要二次 `ls-files` 调用显式展开这个目录。代码实现见 `worktree.ts:439-479`。

---

## 九、Cleanup 策略

Worktree 可能在三种情况下"漏清理"：
1. **Agent crash**：mid-session 异常退出，`ExitWorktreeTool` 没机会运行
2. **进程被杀**：用户 Ctrl+C、kill -9、OS reboot
3. **子 Agent 创建的 worktree**：任务结束后没人调用 `removeAgentWorktree`

### safety: 不会误删用户的 worktree

为防止误删用户主动管理的 `git worktree`，`cleanupStaleAgentWorktrees`（`worktree.ts:1060-1138`）只在 **matching ephemeral 模式** 时清理：

```typescript
const EPHEMERAL_WORKTREE_PATTERNS = [
  /^agent-a[0-9a-f]{7}$/,           // AgentTool 创建
  /^wf_[0-9a-f]{8}-[0-9a-f]{3}-\d+$/, // workflow engine 创建
  /^wf-\d+$/,                       // 旧格式兼容
  /^bridge-[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$/, // bridge mode
  /^job-[a-zA-Z0-9._-]{1,55}-[0-9a-f]{8}$/, // template job
];
```

任何用户命名 slug（如 `wf-myfeature`）都不会被批量清理。

### Periodic cleanup（30 天阈值）

```typescript
export async function cleanupStaleAgentWorktrees(cutoffDate: Date): Promise<number>
```

```
扫描 .claude/worktrees/ 下所有 entry
  匹配 ephemeral 模式?
    mtime < cutoffDate?
      git status --porcelain -uno（empty → ok；否则 skip）
      git rev-list HEAD --not --remotes（empty → ok；否则 skip — work 未推）
      都通过 → removeAgentWorktree(...)
```

**Fail-closed 设计**：
- 非 ephemeral slug：完全不动
- git status 非 0：跳过（不确定状态）
- git status 有输出：跳过（保留用户修改）
- git rev-list 有输出：跳过（保留未推送提交）

**为什么 30 天**：低于这个阈值频繁创建/清理的 agent worktree（如 bridge mode）会被误删；高于这个阈值长时间未用的 worktree 几乎肯定是残留。30 天是经验值，代码注释也提到可通过调整阈值定制。

### Hook-based worktree 的清理

非 git VCS 用 `WorktreeCreate`/`WorktreeRemove` hook 注入：

```
hook-based cleanup:
  if (hookRan) → log 成功
  else → warn "WorktreeRemove hook 未配置，hook-based worktree 保留在: <path>"
```

不主动删 hook-created 的 worktree（hook 可能管理自己的清理逻辑）。

### Crash 恢复

`--resume` + 项目配置中的 `activeWorktreeSession` 字段支持跨进程恢复：

```typescript
// restoreWorktreeSession(session)
currentWorktreeSession = session;
```

实现：`worktree.ts:167-169`。

---

## 十、Worktree 与 Claude Code 其他模块的集成

### state.ts 集成

`getCwd()` / `setCwd()` / `getOriginalCwd()` / `setOriginalCwd()` / `getProjectRoot()` / `setProjectRoot()`：

```
EnterWorktree 调用顺序:
  setCwd(worktreePath)
  setOriginalCwd(getCwd())   # 注意：originalCwd 设为 worktreePath
  (--worktree 启动时也调 setProjectRoot(getCwd()))

ExitWorktree 调用顺序:
  setCwd(originalCwd)
  setOriginalCwd(originalCwd)  # 还原
  setProjectRoot(originalCwd)  # 仅 --worktree 启动时
```

**originalCwd vs projectRoot**：
- `--worktree` 启动：originalCwd 和 projectRoot 都设为 worktreePath
- mid-session EnterWorktree：originalCwd 设为 worktreePath，projectRoot 不变

ExitWorktree 检测 `getProjectRoot() === getOriginalCwd()` 来判断是否需要恢复 projectRoot。

### sessionStorage

`saveWorktreeState(worktreeSession)` 把 worktree 元数据持久化到项目 settings，支持会话恢复。

### System Prompt 刷新

`clearSystemPromptSections()` 触发 env_info_simple 重算（cwd 是 env_info 的一部分）。

### Memory / CLAUDE.md

`clearMemoryFileCaches()` 清空 CLAUDE.md 缓存，触发重新读取新 worktree 路径下的 CLAUDE.md（如果存在）。

### Plan / settings.local

settings.local.json 复制到 worktree 的对应路径——每个 worktree 有独立的 local 配置。

### Tmux 集成

`--tmux + --worktree` 组合在 `worktree.ts:1182-1518` 实现：

```
1. 验证 tmux 可用（不支持 Windows）
2. 创建 worktree（同上）
3. 生成 tmux session name: <repo>_<branch> 替换 [/.] → _
4. 检测 tmux prefix 冲突（Claude 绑了 C-b/C-c/C-d 等）
5. spawn tmux new-session -A（在已存在的 attach，不存在则创建）
6. 设置 CLAUDE_CODE_TMUX_SESSION/CLAUDE_CODE_TMUX_PREFIX 环境变量
7. iTerm2 模式：检测 iTerm2 → -CC control mode（避免学 tmux 快捷键）
```

---

## 十一、设计决策与权衡

| 决策点 | 选择了 | 放弃了 | 原因推断 |
|--------|--------|--------|---------|
| 隔离粒度 | Git worktree（文件系统级） | 进程级文件锁 | Worktree 提供完整的文件系统副本，Agent 可以做任何操作（编译、测试、git commit）；进程级锁只能防止并发写 |
| 清理策略 | 无改动自动清理 + 有改动需确认 | 全部手动管理 | 自动清理减少磁盘浪费；有改动时需确认防止丢失工作成果 |
| 基础分支 | origin/HEAD（默认）或本地 HEAD | 固定 origin/HEAD | 灵活性——用户可以选择基于远程最新还是本地当前状态 |
| .worktreeinclude | 白名单机制（声明哪些 gitignored 文件要同步） | 全部同步 | 安全——默认不同步 gitignored 文件（如 .env），用户显式声明需要的 |
| 后置 symlink | opt-in（settings.worktree.symlinkDirectories） | 自动 symlink node_modules | 用户控制——symlink 可能让 build 误判文件路径（看到 symlink 路径而非真实路径） |
| Hook 优先于 git | WorktreeCreate hook 接管时跳过 git worktree | 只支持 git | 支持 Mercurial/SVN/Pijul 自定义 VCS |
| Fast resume | 读 .git pointer 文件（subprocess-free） | git rev-parse | 15ms × 多次启动的场景下显著 |
| ephemeral 模式清理 | 仅匹配正则的 slug | 全部清理 | 永远不能误删用户自己创建的 worktree |

---

## 十二、可复用的模式

- **副本隔离模式**：给每个并行任务独立的文件系统副本（Git worktree），操作互不干扰。合并由用户决定。
- **自动清理模式**：无改动自动清理 worktree，减少磁盘浪费和人工管理负担。
- **白名单同步模式**：`.worktreeinclude` 提供精细控制——声明哪些 gitignored 文件需要同步，而非全部或全不。
- **正交隔离模式**：上下文隔离（子 Agent）和文件隔离（worktree）是正交的——可以单独使用、也可以组合使用。各自解决不同的问题。
- **Ephemeral slug 模式**：生成包含时间戳/UUID 的确定性 slug，方便之后的批量清理识别哪些是系统创建的、哪些是用户创建的。
- **Hook 扩展模式**：通过 `WorktreeCreate` / `WorktreeRemove` hook 让用户用自己的 VCS 替代 git worktree，不修改 worktree.ts。
- **Fast resume 优化**：检查文件存在性比 subprocess `git rev-parse` 快 10x+，适合频繁复用的资源。

---

## 十三、相关代码路径

| 路径 | 角色 |
|------|------|
| `src/utils/worktree.ts` | worktree 核心实现：创建/清理/recovery/periodic cleanup |
| `src/utils/worktreeModeEnabled.ts` | worktree 模式 flag（用于 hook 路径） |
| `src/utils/hooks.ts` | `WorktreeCreate`/`WorktreeRemove` hook 触发 |
| `src/utils/git.ts` | git 相关工具（findGitRoot、findCanonicalGitRoot、gitExe、getBranch） |
| `src/utils/git/gitFilesystem.ts` | git ref/fs 底层操作（resolveRef、readWorktreeHeadSha） |
| `src/utils/sessionStorage.ts` | `saveWorktreeState`/`restoreWorktreeSession` 持久化 |
| `packages/builtin-tools/src/tools/EnterWorktreeTool/` | mid-session EnterWorktree 工具 |
| `packages/builtin-tools/src/tools/ExitWorktreeTool/` | mid-session ExitWorktree 工具 |
| `src/commands/setup.ts` | `--worktree` 启动初始化（origin/target worktree） |
| `src/entrypoints/cli.tsx` | `--tmux --worktree` 快速路径 |
| `src/utils/claudemd.ts` | `clearMemoryFileCaches`（切换 cwd 后重读） |

