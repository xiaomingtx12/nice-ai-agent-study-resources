---
sidebar_position: 11
title: "发布、安装与版本同步：Skill 怎样进入发布集合"
description: 沿发布清单、版本同步脚本和 Release workflow，区分项目约定与程序检查，并分析维护者链接脚本的覆盖行为和发布边界。
---

# 发布、安装与版本同步：Skill 怎样进入发布集合

:::info 源码基线与入口

项目为 `mattpocock/skills`，`package.json` 版本 `1.2.3`，源码快照为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。下表路径相对项目根目录。三个脚本都采用顶层顺序执行，没有具名函数入口；安装渠道及宿主限制按该快照的记录解释，不代表其他版本的行为。

| 相对路径 | 入口 | 负责内容 |
| --- | --- | --- |
| `CLAUDE.md` | promoted buckets 与文档同步规则 | 哪些 skill 应被发布、哪些文档需要更新 |
| `.agents/install-block.md` | `The canonical install block`、`The two routes are exclusive` | 统一安装说明及渠道选择 |
| `.claude-plugin/plugin.json` | `skills`、`version` 字段 | 插件实际包含的 skill 与版本标识 |
| `package.json` | `scripts.version`、`scripts.check-plugin-version` | 版本命令及只读检查入口 |
| `scripts/sync-plugin-version.mjs` | 顶层流程 | 读取、比较、替换和校验版本 |
| `.github/workflows/release.yml` | `jobs.release` | 调用版本命令，创建版本 PR 与标签 |
| `scripts/link-skills.sh`、`scripts/list-skills.sh` | 顶层流程 | 建立宿主目录链接、枚举源码文件 |
| `.agents/adr/0002-ship-as-a-claude-code-plugin.md` | `Decision`、`Update, 2026-08-05` | 发布结构的取舍及历史渠道约束 |

:::

一份 skill 写好后，仍有三个独立问题：它是否属于公开集合、安装时能否被发现、发布后用户能否收到更新。这个仓库用显式清单决定插件内容，用版本脚本同步两个版本字段，再由 Release workflow（发布自动化流程）调用版本命令、管理版本 PR（合并请求）。目录、版本和分发渠道各有自己的状态，修改 `SKILL.md` 并不会自动完成这些步骤。

## 一、从目录中的 skill 到插件发布清单

### 1、目录规则定义应该发布什么，清单决定实际发布什么

promoted 指被正式推广和分发的 skill 集合。根目录 `CLAUDE.md` 将其限定为 `skills/engineering/` 与 `skills/productivity/`，并要求每个成员出现在顶层 README 和插件清单中。`misc/`、`in-progress/`、`deprecated/` 不进入这套集合。

`.claude-plugin/plugin.json` 的 `skills` 字段开头如下，后续条目在此省略：

```json
"skills": [
  "./skills/engineering/ask-matt",
  "./skills/engineering/diagnosing-bugs",
  "./skills/engineering/grill-with-docs",
```

以上是字段片段，不是独立 JSON 文件。完整数组含 25 个目录：`engineering` 18 个，`productivity` 7 个。它直接指向每个 skill 的目录，不是扫描 `skills/` 的通配表达式。新增目录后若没有更新数组，插件清单就不会因此多出一个成员。

显式列出目录能让分发边界清楚，也带来同步成本。正式集合由仓库规则描述，实际集合由清单承载，两者仍可能漂移；这里没有“只要放进正式目录就自动纳入插件”的生成逻辑。

### 2、不同文件面向不同消费者

`SKILL.md` 面向执行任务的 agent；README 和 `docs/<bucket>/<skill-name>.md` 面向选择能力的人；`ask-matt` 面向需要推荐入口的会话；插件清单面向安装和发现机制。

因此 `CLAUDE.md` 要求：新增、改名或改变已发布 skill 的行为时，同步其文档页；改变它在工作流中的位置时，重读并更新 `ask-matt`。例如将某个入口从“直接实现”改为“只生成规格”，如果只更新 `SKILL.md`，路由器还会继续把需要实现的用户引到这里。

这些同步要求是维护指令。版本脚本只负责版本字段，既不检查 skill 是否缺项，也不检查 README 和路由是否准确。写类似 skill 集合时，可将高风险的不变量另做检查，例如“正式目录集合等于插件清单集合”；不能把自然语言规则视为已有的 CI（持续集成）校验。

## 二、安装渠道为何需要单独的说明来源

### 1、托管包与可编辑副本有不同维护方式

`.agents/install-block.md` 的文件开头规定统一安装措辞，下面是连续摘录：

```markdown
One install story, one wording. `README.md`, `.changeset/*`, and every page under `docs/` must say **this** and nothing else. Change it here first, then propagate.
```

它要求先修改这份文件，再传播到其他说明位置。这里没有执行模板渲染或自动替换的程序；一致性依靠维护流程。文件后面的补充还说明，`docs/` 页面正文不重复安装命令，因为发布站点已经在正文上方渲染安装组件。统一说法并不要求每一页复制命令。

该快照描述两种渠道：Claude Code 插件提供托管的整套发布集合；skills.sh 把所选 skill 复制成用户可编辑的文件，可用于其他宿主。harness 在这里指加载 skill 并运行 agent 的宿主环境。`The two routes are exclusive` 写道：

```markdown
The plugin is a managed, read-only bundle you subscribe to. skills.sh writes files you own and edit. Installing both leaves the user with every skill twice — always say "pick one".
```

选择渠道也在选择维护责任：托管包按渠道更新，可编辑副本需要维护自己的修改。这里的“二选一”是为了避免重复安装；它不意味着所有采用 skill 的项目都必须只有一个安装入口。

### 2、渠道约束会反过来限制目录结构

ADR 0002 记录，项目采用 Claude Code 插件，是因为当时的清单允许显式列出跨两个目录的 skill；原生 Codex 插件被推迟，原因是记录中的单路径选择方式无法直接表达这份子集。指向共同父目录会包含非正式能力，维护重复副本又会增加同步工作。

这是一项针对该快照目录和当时宿主能力的决策。复用时需要保留的判断是：目标渠道必须能表达准确的发布集合。不能将 ADR 中的历史限制写成宿主永久不支持某种结构。

ADR 的 `Update, 2026-08-05` 还区分了版本发布与渠道可见性：记录中的官方市场条目锁定 commit SHA，只有渠道所指提交变化，用户才会获得相应内容。仓库保留的 `.claude-plugin/marketplace.json` 则用于直接分发仓库或 fork 的退路。下面的版本脚本不会更新市场锁定值，也不会改变用户端缓存。

## 三、版本脚本怎样读取、检查和写入

### 1、以 package.json 为单向来源

`package.json` 的 `scripts` 字段给出实际调用链：

```json
"scripts": {
  "changeset": "changeset",
  "version": "changeset version && node scripts/sync-plugin-version.mjs",
  "check-plugin-version": "node scripts/sync-plugin-version.mjs --check"
}
```

changeset 是描述待发布变更及版本增量的记录，由 Changesets 工具消费。`npm run version` 先让它计算包版本并更新发布记录；只有前一条命令成功，`&&` 才会继续运行同步脚本。`check-plugin-version` 则直接进入只读检查模式。

`scripts/sync-plugin-version.mjs` 顶层先用脚本自身位置计算仓库根目录，再读取两份 JSON。以下为连续摘录：

```javascript
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = join(repo, ".claude-plugin", "plugin.json");

const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const source = readFileSync(pluginPath, "utf8");
const plugin = JSON.parse(source);
```

`version` 保存包版本，`source` 保留插件文件的原始文本，`plugin` 保存解析后的对象。保留后两种表示，是为了同时读取字段与尽量保留写回格式。路径依据 `import.meta.url`，不依赖调用命令时所在的目录。

### 2、相等就退出，检查模式不修改文件

同一脚本紧接着比较版本：

```javascript
if (plugin.version === version) {
  console.log(`plugin.json version is ${version} — already in sync`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  console.error(
    `plugin.json version is ${plugin.version}, package.json is ${version}. Run \`node scripts/sync-plugin-version.mjs\`.`,
  );
  process.exit(1);
}
```

| 输入状态 | 模式 | 结果 |
| --- | --- | --- |
| 两个版本相同 | 任意模式 | 退出码 0，不写文件 |
| 两个版本不同 | `--check` | 输出差异，退出码 1，不写文件 |
| 两个版本不同 | 默认模式 | 继续生成替换后的文本 |

这个顺序让重复同步成为无修改操作。`--check` 失败只能说明两个字段不同，不能证明发布遗漏了哪些步骤。文件不存在、读取失败或 JSON 不合法会直接抛出异常；脚本没有捕获后降级为某个默认版本。

### 3、替换后重新解析，校验通过才写盘

下面接续默认模式的连续源码，原英文注释译为中文：

```javascript
// 只重写版本字段所在的文本，保留键的顺序与原有格式。
const updated = source.replace(
  /("version"\s*:\s*")[^"]*(")/,
  `$1${version}$2`,
);

if (JSON.parse(updated).version !== version) {
  console.error(`Could not find a version field to replace in ${pluginPath}.`);
  process.exit(1);
}

writeFileSync(pluginPath, updated);
console.log(`plugin.json version ${plugin.version} -> ${version}`);
```

正则表达式匹配一个名为 `version` 的字符串字段，并保留字段前后的文本。随后脚本重新解析结果，确认顶层 `version` 等于目标版本，才调用 `writeFileSync` 写回。若没有找到可替换字段，或先匹配了其他层级的同名字段导致顶层仍不一致，校验会失败并停止。

这种做法适合结构稳定、版本是字符串的清单。它减少格式噪声，但不是通用 JSON 编辑器：不做语义化版本校验，也没有临时文件加重命名的原子写入和跨进程锁。包版本被误填时，两个文件仍可能同步到同一个错误值。

## 四、Release workflow 如何连接版本命令

`.github/workflows/release.yml` 在推送到 `main` 时运行。安装依赖后的关键步骤如下，其他 checkout、Node 设置等步骤省略：

```yaml
- name: Create Version Pull Request
  uses: changesets/action@v1
  with:
    version: npm run version
    publish: npx changeset tag
    commit: "chore: version skills"
    title: "chore: version skills"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

该配置把“版本更新”委托给 `npm run version`，因此插件字段同步处于版本 PR 的生成链路中。`publish` 使用 `changeset tag`，不是把包发布到 npm。`.changeset/config.json` 中的 `privatePackages.version` 和 `privatePackages.tag` 都为 `true`，允许这个 `private: true` 的包参与版本与标签处理。

`commit: false` 是 Changesets 配置中的选项，不应扩写成“整个流程必须手动提交”。这里的 Action 另有 `commit` 和 `title`，用于自动化版本 PR；它们处于不同层次。

该快照的 workflow 没有调用 `check-plugin-version`，也没有检查清单覆盖率、文档同步或市场提交锁定值。可以准确描述的链路是：待发布变更被版本流程消费，包版本更新后触发插件版本同步，Action 管理版本 PR 和标签步骤。至于渠道何时采用新提交，需要另外的分发流程。

## 五、维护者链接脚本与发布清单为何不同

### 1、扫描一次，再给多个宿主建立链接

`scripts/link-skills.sh` 的头部注释将它限定为维护者工具，不是受支持的用户安装器。它以符号链接把仓库中的 skill 目录暴露给宿主，修改目标文件后，链接读取的仍是同一份内容。

脚本顶层先创建名称与来源数组，以下连续源码省略了前面的变量初始化：

```bash
while IFS= read -r -d '' skill_md; do
  src="$(dirname "$skill_md")"
  names+=("$(basename "$src")")
  srcs+=("$src")
done < <(find "$REPO/skills" -name SKILL.md -not -path '*/node_modules/*' -not -path '*/deprecated/*' -print0)
```

`find -print0` 和 `read -d ''` 用空字符分隔路径，避免路径中的空格被拆成多个字段。数组收集一次，后续对每个目标目录重复链接。扫描排除了 `deprecated/`，却没有排除 `misc/` 和 `in-progress/`，因此它得到的集合比插件清单更大，不能拿它的结果替代正式发布集合。

`scripts/list-skills.sh` 只排除 `node_modules`，枚举结果保留其他目录中的 `SKILL.md` 并排序。三个集合分别服务“查看源码”“维护者试用”“正式分发”，源码没有把它们合并成同一份清单。

`done < <(find …)` 还使用了进程替换：`find` 在独立进程中产生路径，循环消费其输出。脚本没有收集该进程的退出状态，`set -euo pipefail` 也不能替这里补上扫描结果检查。如果 `find` 产生部分路径后失败，父流程仍可能拿着不完整的数组继续链接。成功退出不能单独证明扫描完整。

### 2、目录自引用会被阻止，同名内容却可能被覆盖

`link-skills.sh` 对每个目标目录 `DEST` 先检查它是否是指向当前仓库的符号链接。以下为外层循环内的连续摘录：

```bash
if [ -L "$DEST" ]; then
  resolved="$(readlink -f "$DEST")"
  case "$resolved" in
    "$REPO"|"$REPO"/*)
      echo "error: $DEST is a symlink into this repo ($resolved)." >&2
      echo "Remove it (rm \"$DEST\") and re-run; the script will recreate it as a real dir." >&2
      exit 1
      ;;
  esac
fi
```

此分支避免将每个 skill 的链接反写进仓库自己，发现后直接退出，不自动删除这个目录链接。对单个同名条目，行为却不同。下面是内层循环中 `target` 已计算后的连续源码：

```bash
if [ -e "$target" ] && [ ! -L "$target" ]; then
  rm -rf "$target"
fi

ln -sfn "$src" "$target"
echo "linked $name -> $src ($DEST)"
```

目标条目已存在且不是符号链接时，脚本先删除它，再建立链接，没有备份或确认步骤。不同 bucket 中若存在同名 skill，也会映射到同一个 `target`，后处理的条目可能覆盖先处理的链接；源码没有预先检测名称冲突。

新增 skill 后重跑脚本会建立新链接，但删除或改名后留下的旧链接不会被自动清理，因为循环只遍历当前扫描到的来源。`set -euo pipefail` 能让许多命令错误终止执行，却不能回滚已经处理过的条目。这些行为解释了它为何仅适合维护者控制的环境；若改成面向用户的安装器，需要另行设计备份、冲突处理和旧条目清理。

## 六、写新 skill 时怎样决定要不要引入这套发布机制

对单个 skill，先确定触发描述、正文执行步骤、依赖和输出位置，通常比建设发布系统更紧要。当一组 skill 需要被多人持续使用，再明确“哪些成员随版本一起发布”和“怎样发现缺项”。本项目的目录规则、插件清单和路由说明解决的是不同问题，合并成一个长 README 会让机器消费者和人类读者都难以定位自己的输入。

版本同步适合保留这种窄职责：读取一个权威版本，比较、校验，再写另一份清单；发布覆盖率和文档同步另行处理。维护者链接工具则应与正式安装方式分开，其扫描范围和覆盖行为不适合原样暴露给所有用户。

这套组织可以迁移的是发布边界与职责划分。实际采用哪种清单格式、哪个宿主、怎样更新渠道，都应以目标环境为依据；该快照中的 ADR 和脚本只证明项目当时选择了什么、实施到了哪一步。
