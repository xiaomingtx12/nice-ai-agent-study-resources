---
sidebar_position: 4
description: "从手搓、脚手架、注释驱动到 AI IDE 再到 Agent Coding 工具的五阶段复盘。真正变的不是工具而是使用顺序，重心从代码怎么写前移到想让它做什么。"
---

# AI 工具使用方式的阶段复盘与经验沉淀

## 已经经历过的几个阶段回顾

### 1. 手搓阶段：先会做，再谈项目

最早做前端页面，思路很直白：先想页面怎么搭，再拆布局，然后补样式，最后对着效果反复微调。后端也差不多，Java 项目通常先把工程骨架搭起来，再拆业务、写接口、接数据层。

这一阶段典型的顺序是：

- 先理解 CSS 语法
- 先理解框架写法
- 先会搭后端分层
- 然后再去做项目

这种"先学再做"的方式对扎实度有帮助，但启动阻力很大。很多项目做不出来，不是因为不会做，而是在"我是不是还没学够"这里就先停住了。

### 2. 模板工具阶段：脚手架与生成器开始介入

前后端都开始用脚手架、代码生成器。后端可以先让生成器把基础代码搭出来，再按项目实际调整。

效率确实提升了，但本质上还是老思路：

- 先知道标准结构长什么样
- 借工具省掉重复劳动
- 再自己补业务逻辑

工具更多的像是加速器。

### 3. 注释驱动阶段：先描述，再让补全跟上

后面一个明显变化，是我开始先写注释、写意图、写步骤，再让补全工具往下接代码。

这一步看起来只是"补全更强了"，其实它改变了重心：从"代码怎么写"往前移到"我想让它做什么"。开发过程里出现了一个新的中间层——不是直接写代码，也不是只在脑子里想，而是先把意图表达出来。

这时候，卡住的往往不是语法，而是表达不清。

### 4. AI IDE 阶段：先把东西做出来

`Cursor`、`Kiro`、`Qoder` 这类 AI IDE 进来之后，搭页面的阻力又往下掉一层。以前要先回忆很多样式规则，或者找以前看过的项目案例，再慢慢拼出一个差不多的效果。现在可以先把理想效果描述出来，让 AI 先出一个版本。哪怕第一版不准，也比"从空白开始"更快进入能改的状态。

这一阶段重要的变化是：

- 你可以在干中学
- 你可以先把东西做出来
- 你可以边做边逼自己把需求讲清楚

### 5. 主流 Agent Coding 工具阶段：plan、goal、skill 等工作流机制开始内置

Cursor 这种最早出现的 AI IDE，主要走的是补全 + 对话生成代码的路径，更接近 Vibe Coding：用自然语言描述，让 AI 出活。这种方式对单点改动和快速原型很顺，但缺少 plan、goal、skill 这类显式的工作流机制。

后来的 Claude Code、Codex 等主流 Agent Coding 工具则不一样。它们一开始就把 plan、goal、skill 这套工作流机制作为工具本身的一部分带进来：

- `/goal` 用来定义"完成条件"，让 AI 在多回合中持续推进直到条件满足
- plan 模式用来在动手前先讨论清楚拆解和选型
- skill 用来把可复用的工作流结构沉淀下来

`Claude Code` 这一类工具能参与的环节因此覆盖到：

- 需求澄清
- 技术选型讨论
- 拆任务
- 落文档
- 复盘问题
- 持续推进直到目标达成

AI 在这些工具里不再只是一个"高级补全器"，而是一个能跑完整段工作流的协作对象。

## 真正变化的，不是工具，而是使用顺序

过去的使用顺序更像这样：

1. 先学会技术点
2. 再做项目
3. 在项目里慢慢积累经验
4. 最后做到熟能生巧

现在更像这样：

1. 先尽量把理想效果描述清楚
2. 先和 AI 一起把东西做出来
3. 再在做的过程中看懂、修正、补细节
4. 最后把过程沉淀成维护文档和自己的判断

技术细节仍然重要，但"先做再学"这条路的阻力被压低了很多。"做中学"成了可执行的路径。

更通俗的说，范式变化，以前是码农纯手搓亲力亲为，现在转变要学会使用AI这种机器

## 以 Claude Code 为例：三个维度的经验沉淀

下面把过去一段时间的体会收束到 `Claude Code` 上，按三个维度展开：

- **代理与并行工具**：子代理、代理团队、动态工作流、worktree
- **自动化与长程任务**：按计划运行提示词（plan模式）、`/goal`、`/loop`、hooks
- **代码库配置**：CLAUDE.md、skills、worktree、settings、agent SDK

每个维度都对应一类具体问题，不是单点的"补全更强了"。每个工具都分 **CLI 版** 和 **桌面版** 两种用法——CLI 版以命令、文件、标志为主，桌面版以原生面板、并行会话视图、拖拽式编辑为主。两边的配置文件（`~/.claude/settings.json`、`.claude/agents/`、`.claude/skills/` 等）共用。

### 维度一：代理与并行工具

我最早用 AI 工具时是一个会话里来回往返。后来发现很多事其实更适合"拆给多个 Claude 实例同时做"。`Claude Code` 在这一点上把机制拆得很细，下面四个工具各自解决一类问题：

#### 1. 子代理（subagents）：把"产生大量上下文"的任务隔离出去

子代理在主会话内启动，但跑在独立的上下文窗口里，最后只把摘要返回主对话。

具体的用法是：

- 跑测试套件、翻日志、抓全仓搜索结果这类"产出很多我不会再看的细节"的任务，交给子代理
- 把"我只关心结论"的步骤委派出去，让主上下文保持干净

`Claude Code` 已经内置了几个常用的子代理（Explore、Plan、general-purpose），也可以通过 `.claude/agents/` 或 `~/.claude/agents/` 声明式自定义。

具体怎么委派有三种粒度：

- 自然语言：直接说"用 code-reviewer 看下我刚才的改动"
- 会话范围：`claude --agent code-reviewer`，整场会话都用这个角色

#### 2. 代理团队（agent teams）：让多个 Claude 会话互相协作

子代理只能向主会话汇报。`Claude Code` 还提供"代理团队"——多个完整会话，共享一个任务列表，队友之间可以直接互相发消息，主会话充当 lead。

适合的场景：

- 并行审查：让一个队友看安全、一个看性能、一个看测试覆盖
- 并行调试：用竞争假设调查，让多个队友各自验证并互相反驳
- 跨层改动：前后端、测试各一个队友，每人负责自己的文件集

代价也很明显：每个队友都是独立的 Claude 实例，token 消耗是线性叠加的。队友数量控制在 3–5 个比较合理，每个队友 5–6 个任务比较高效。

#### 3. 动态工作流（workflows）：用脚本大规模编排子代理

子代理和代理团队都是"Claude 自己逐轮决定下一步"。当任务大到超出单次会话的协调能力（代码库范围审计、500 文件迁移、需要多角度交叉验证的研究），就需要把"计划"移出 Claude 的上下文。

动态工作流就是一个由 Claude 写出来的 JavaScript 脚本，运行时在后台执行，跑大量子代理并交叉检查结果。触发方式有几种：

- 在提示里写 `ultracode`，比如 `ultracode: audit every API endpoint under src/routes/ for missing auth checks`
- `/effort ultracode`，让 Claude 自己判断什么时候该上工作流
- 直接调内建工作流，比如 `/deep-research`

工作流运行中的限制：最多 16 个并发代理（CPU 少的机器更少），每次运行 1,000 个代理总数。这些限制防止失控循环烧 token。

把工作流保存成命令之后，下次用 `/triage-issues` 之类直接调，编排步骤就跟代码一样可复用。

#### 4. worktree 隔离：让并行会话不会改到同一份文件

代理视图、代理团队、`/batch` 这些并行工具，本质上都可能同时编辑文件。worktree 是解决"文件冲突"的那一层：

- `claude --worktree feature-auth` 在 `.claude/worktrees/feature-auth/` 下开一个新 worktree
- 子代理可以设 `isolation: worktree`，让每个子代理拿一份临时副本，结束没改动就自动清理
- `.worktreeinclude` 用 `.gitignore` 语法把 `.env` 这种 gitignore 文件同步到每个 worktree

代理团队本身不在 worktree 里隔离队友——队友们需要被**手动分配**到不同的文件集，否则两个队友编辑同一文件会互相覆盖。worktree 是给"自己启动的会话"或"自己生成的子代理"用的，团队场景下要靠任务拆分。

#### 这一维度的实际选择顺序

拿到一个并行任务，我会先问自己：

1. 这事是一个子代理就能搞定的吗？是 → 用子代理
2. 是不是需要多个 Claude 互相讨论、互相质疑？是 → 用代理团队
3. 是不是大到超出单次协调能力（500 文件、跨包审计）？是 → 用动态工作流
4. 团队模式下任务会不会撞文件？会 → 把任务拆开，每人负责自己的文件集；如果是我自己开的多个会话，用 `--worktree`

子代理和 worktree 不是互斥的——子代理可以跑在 worktree 里，代理团队的队友也可以通过任务拆分避免文件冲突。

#### CLI 版 vs 桌面版：四个具体场景

下面把上面四个工具拆到具体的 CLI / 桌面版场景里，给出能直接对照的命令和 UI 入口。

**场景一：日常开发，主会话里要隔离一段"细节多但只关心结论"的辅助任务。**

- CLI 版：直接跟 Claude 说 `Use the Explore subagent to find every call site of the deprecated auth API`，子代理在自己的 context 里跑，结果只回摘要。
  - 查看运行中的子代理：`/agents` 面板的 **Running** 选项卡
  - 编辑自定义子代理：`/agents` 面板的 **Library** 选项卡，或直接编辑 `.claude/agents/<name>.md`
  - `@-mention` 强制走特定子代理：`@"code-reviewer (agent)" look at the auth changes`
- 桌面版：等价做法是同一个 prompt。但子代理的实时进度在原生任务面板里能看到，不需要切回 `/agents` 视图。

**场景二：一次性提交多个独立任务，并行推进。**

- CLI 版：用 `claude agents` 命令打开**代理视图**，这是个 TUI 屏幕，列出会话状态、哪些需要你输入。分派出去的会话自动跑在各自的 worktree 里。
  ```bash
  # 在主目录里分派两个独立会话
  claude agents
  # 在 TUI 里点 "Dispatch session" 选仓库路径、给一段 prompt
  ```
- 桌面版：每个新会话自动开一个 worktree（CLI 默认不是）。多个 worktree 会话在桌面侧栏直接列出来，每个标签页对应一个会话，可以并行写不同分支。

**场景三：跨层改动或并行审查，让多个 Claude 会话互相协作。**

- CLI 版：先在 `~/.claude/settings.json` 里启用代理团队：
  ```json
  {
    "env": {
      "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
    }
  }
  ```
  然后用自然语言触发：
  ```text
  Spawn three teammates to review PR #142:
  - One focused on security implications
  - One checking performance impact
  - One validating test coverage
  ```
  lead 终端的 agent 面板里列出队友，按 `↑`/`↓` 选、`Enter` 直接给某个队友发消息。In-process 模式不用额外配置；想要分割窗格就装 tmux 并设置 `"teammateMode": "split-pane"`。
- 桌面版：等价体验在原生窗口里，队友面板直接显示在工作区侧边。

**场景四：大规模审计、迁移、跨包研究，单会话协调不过来了。**

- CLI 版：用工作流。三种触发方式：
  ```bash
  # 1. 提示里加关键字 ultracode
  ultracode: audit every API endpoint under src/routes/ for missing auth checks

  # 2. /effort ultracode 让 Claude 自决定
  /effort ultracode

  # 3. 直接跑内建工作流
  /deep-research "What changed in Node.js permission model between v20 and v22?"
  ```
  工作流后台运行时会话不阻塞。进度视图通过 `/workflows` 进入，能看到每个阶段、每个代理的 token 用量。运行完后按 `s` 保存为项目级 `.claude/workflows/<name>.js` 或用户级 `~/.claude/workflows/`，下次直接 `/<name>` 调。
- 桌面版：工作流运行时进度在"后台任务"侧窗格里看；批准卡用"一次 / 总是 / 拒绝"按钮，比 CLI 文本菜单少一次往返。

**worktree 隔离的 CLI / 桌面版差异**：

| 场景             | CLI 版                                              | 桌面版                                |
| :------------- | :------------------------------------------------- | :---------------------------------- |
| 开新会话          | `claude --worktree feature-auth`                   | 新开会话自动开 worktree                 |
| 子代理隔离         | subagent frontmatter 加 `isolation: worktree`        | 子代理自动继承                          |
| 多会话并行         | `claude agents` 视图 / 自己开多个 `claude --worktree` | 标签页，每个会话自动 worktree              |
| 复制 .env 等 gitignore 文件 | 仓库根 `.worktreeinclude`（`.gitignore` 语法）     | 同一份 `.worktreeinclude`             |
| 手动管理           | `git worktree add ../p-feature-a -b feature-a` 然后 `cd` 进去跑 `claude` | 在 worktree 选择器里手动切换                |

### 维度二：自动化与长程任务

AI 写代码的摩擦不只是"补一段代码"，更包括"等 CI"、"轮询构建"、"跑批量任务"、"盯着 PR 直到条件满足"。这一维度对应的是"让会话持续跑"和"让逻辑自动注入"的机制。

#### 1. 按计划运行提示词：`/loop` 和 CronCreate

`Claude Code` 提供 `/loop` 让你按时间间隔重跑一段提示：

```text
/loop 5m check if the deployment finished and tell me what happened
```

不带间隔也行，`/loop` 会让 Claude 自己根据当前状态动态选间隔（1 分钟到 1 小时），构建中或 PR 活跃时拉短一点，闲置时拉长一点。

可以传给 `/loop` 一个 skill，比如 `/loop 20m /review-pr 1234`，让每次迭代重新跑那个 skill。

底层是 `CronCreate` 工具，5 字段 cron 表达式，本地时区。所有时间都按你机器所在的时区解释，**不是 UTC**。

几个使用上的要点：

- 抖动：调度程序会加一个确定性偏移，避免所有会话在 `:00` 整点同时打 API
- 7 天过期：重复任务跑满 7 天自动结束；需要更长用 Routines 或 Desktop 计划任务
- 任务只能在 Claude 空闲时触发；正忙就等当前回合结束
- 任务上下文是会话范围的；`--resume` 会带回未过期的任务，但启动新对话就清空

如果想让"循环"持续更久，或想跨会话跑，用 Routines（云端）、Desktop 计划任务（本地）或 GitHub Actions（CI）。

#### 2. `/goal`：让 Claude 在多个回合里持续推进直到条件满足

`/goal` 是时间维度上不一样的东西——它不按间隔触发，而是上一个回合结束立刻判定要不要继续。

工作方式：

1. 你写一段完成条件，比如 `/goal all tests in test/auth pass and the lint step is clean`
2. Claude 开始干活，每回合结束都把"对话 + 条件"发给一个独立的小模型（默认 Haiku）评估
3. 评估器返回"是/否 + 理由"。"否"的话 Claude 自动开始下一个回合，理由作为下一回合的指令
4. 条件满足，goal 自动清除，状态里记一条"已实现"

条件写法有几个硬性约束：

- **可测量的最终状态**：测试通过、构建退出码 0、`git status` 干净、文件计数符合预期
- **陈述的检查方式**：让 Claude 知道它该如何证明自己，比如"`npm test` 退出 0"或"`src/auth/` 下所有调用站点都已迁移完成"
- **过程中不能动的东西**："不要修改其他测试文件"、"不要引入新的依赖"
- **必要时加一个回合或时间的兜底**：`or stop after 20 turns`
- 条件最多 4,000 字符

评估器有一个特性需要特别注意：**它不独立跑命令、不读文件**，只能根据 Claude 在对话里呈现的内容判定。所以条件必须写成 Claude 自己的输出能演示的事情。

落地写法上，我会把"沉淀"也写进条件：

- "测试通过，且 `docs/` 下新增了一篇复盘说明这次改动的设计取舍"
- "迁移完成，且 `CHANGELOG.md` 里有对应条目"
- "代码拆完，且每个模块都符合 size budget，且每个模块都有自己的 README"

`/goal` 和 `/loop` 是两件不同的事：

| 工具         | 下一个回合何时开始  | 停止条件                |
| :--------- | :--------- | :------------------ |
| `/goal`    | 前一回合完成时    | 模型确认条件已满足           |
| `/loop`    | 一个时间间隔过去后  | 你停止它，或 Claude 自己判断 |
| Stop hook  | 前一回合完成时    | 你自己的脚本或提示决定         |

我自己的用法是分场景的：

- `/goal` 跑"最终能验证"的工作，比如"迁移完成后所有调用站点都能编译并通过测试"
- `/loop` 跑"按节奏做"的工作，比如定时拉 CI、定时汇总日志
- Stop hook 跑"判定逻辑很自定义"的工作，比如"只有在特定日志模式出现时才停"

不要让 AI 一边干活一边决定自己该不该停。停下来这件事，应该由一个独立于执行的视角来判断。

#### 3. hooks：在 Claude 生命周期中确定性注入逻辑

LLM 默认是"非确定性的"——它可能运行某个命令，也可能不。`/goal` 用模型评估器做兜底，hooks 用 shell / prompt / agent / http 在 Claude 的生命周期里**强制**插入逻辑。

常用的事件：

| 事件                  | 触发时机                              | 典型用法                         |
| :------------------ | :-------------------------------- | :--------------------------- |
| `PreToolUse`        | 工具调用执行之前                          | 校验命令、阻止对 `.env` 的写入        |
| `PostToolUse`       | 工具调用成功之后                          | 自动跑 Prettier、跑 linter       |
| `Stop`              | Claude 完成响应时                       | 跑检查清单，决定要不要放行              |
| `SessionStart`      | 会话开始或恢复时                          | 注入上下文、加载 env                |
| `UserPromptSubmit`  | 用户提交 prompt 后、Claude 处理前          | 注入额外上下文                     |
| `ConfigChange`      | 配置文件被外部修改时                        | 审计日志                         |
| `TeammateIdle`      | agent team 队友即将空闲时                | 阻止空闲，强制继续                  |
| `TaskCreated`/`TaskCompleted` | 任务被创建/完成时               | 强制质量门                        |

hooks 有四种类型：

- `command`：跑 shell 命令，最常用，10 分钟超时
- `prompt`：单轮 LLM 评估（默认 Haiku），适合需要判断的"是否通过"
- `agent`：生成 subagent 跑多轮验证，可读文件、跑命令，60 秒超时 + 50 轮上限
- `http`：把事件 POST 到 HTTP 端点，由外部服务决定怎么响应

我自己的几个常驻 hook：

- `PostToolUse` matcher `Edit|Write`：自动 prettier
- `PreToolUse` matcher `Edit|Write`：阻止编辑 `.env`、`package-lock.json`、`.git/`
- `Stop` 用 prompt 类型：检查所有任务是否完成，未完成就拒绝 stop
- `SessionStart` matcher `compact`：压缩后重新注入项目约定和当前 sprint 信息

hooks 的输出可以"决定下一步"——退出码 0 表示没意见、退出码 2 表示阻止并把 stderr 当作反馈给 Claude、写 JSON 也能结构化控制（`permissionDecision: "deny"`、`decision: "block"` 等）。

#### 这一维度的协作模式

`/loop`、`/goal`、hooks 不是三类互斥的工具，是同一类问题（"让事情自动跑"）的三种解决方案：

- `/loop` 解决"按时间节奏重复"
- `/goal` 解决"按完成条件收敛"
- hooks 解决"按生命周期事件触发"

一个项目里我会同时用：hooks 监听 `Stop` + prompt 评估器保证不漏东西；`/goal` 跑那个"最终能验证"的主线；`/loop` 在主线旁边跑"每 30 分钟拉一下 CI"。

#### CLI 版 vs 桌面版：四个具体场景

**场景一：定时拉 CI、看部署状态。**

- CLI 版：
  ```bash
  # 固定间隔
  /loop 30m check CI on the open PR and report any new failures

  # 动态间隔（Claude 自己选 1 分钟到 1 小时）
  /loop check whether the integration tests passed and tell me
  ```
  想换默认行为，在 `.claude/loop.md`（项目级优先）或 `~/.claude/loop.md`（用户级）里写自定义 prompt。
- 桌面版：用桌面应用自带的"计划任务"功能，跨会话持久（CLI 版 `/loop` 会话退出就停，最多 7 天）。需要访问本地文件、跑 build、依赖本机环境时，桌面版比云端 Routines 更合适。

**场景二：长跑迁移类工作，"跑到条件满足"。**

- CLI 版：
  ```bash
  /goal all tests in test/auth pass and the lint step is clean
  ```
  设置后立即启动，条件本身就是指令。运行期间 `◎ /goal active` 指示器显示运行时长，回合数和 token 用量随时 `claude /goal` 查。中途想停：
  ```bash
  /goal clear
  ```
  非交互模式一次性跑完：
  ```bash
  claude -p "/goal CHANGELOG.md has an entry for every PR merged this week"
  ```
- 桌面版：同一套 `/goal` 命令，状态卡片直接挂在会话窗口上，不需要手动 `claude /goal` 查。

**场景三：把项目规则"钉死"，让 Claude 不能违反。**

- CLI 版：hooks 都写在 `~/.claude/settings.json` 或项目 `.claude/settings.json` 里。常用配置：
  ```json
  {
    "hooks": {
      "PostToolUse": [
        {
          "matcher": "Edit|Write",
          "hooks": [{ "type": "command", "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write" }]
        }
      ],
      "PreToolUse": [
        {
          "matcher": "Bash",
          "if": "Bash(git push *)",
          "hooks": [{ "type": "command", "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"禁止直接 push，先开 PR\"}}'" }]
        }
      ],
      "Stop": [
        {
          "hooks": [{ "type": "prompt", "prompt": "Check if all requested tasks are complete. If not, respond with {\"ok\": false, \"reason\": \"what remains\"}." }]
        }
      ]
    }
  }
  ```
  `/hooks` 命令打开浏览器菜单，按事件分组、显示每个 hook 的命中数和配置来源。
- 桌面版：同一份 `~/.claude/settings.json` 生效。桌面应用不需要自己配 `Notification` hook——通知是原生的。`PreToolUse` 阻止仍然走 hooks（hook 返回 `deny` 在任何权限模式下都生效，包括 `bypassPermissions`）。

**场景四：CI / 脚本里用 Claude。**

- CLI 版：`-p` 非交互模式是首选。
  ```bash
  # 最小启动，跳过 hooks/skills/plugins/MCP 自动发现
  claude --bare -p "Summarize the failing tests in this log" --allowedTools "Read"

  # 结构化输出 + JSON Schema 校验
  claude -p "Extract function names from src/auth.py" \
    --output-format json \
    --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}'

  # 流式 + 重试事件
  claude -p "explain this error" --output-format stream-json --verbose --include-partial-messages

  # 后续 --continue
  session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
  claude -p "Continue that review focusing on auth" --resume "$session_id"
  ```
  `--bare` 模式是脚本和 SDK 调用的推荐模式，未来会成为 `-p` 的默认。后台任务最多 10 分钟等待上限（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 可调）。
- 桌面版：通常不直接用桌面应用跑 CI，但桌面版可以通过 **远程控制** 接管运行中的会话。脚本侧仍然走 CLI / Agent SDK 的同一套。

### 维度三：代码库配置

把代码库"配置好"是 Claude Code 区别于早期 AI IDE 的关键。Cursor 那种工具对单仓库很顺，但代码库一大，默认配置会把上下文塞满。`Claude Code` 把这套配置拆成几个独立层，按需叠加。

#### 1. CLAUDE.md：分层放项目约定

根目录的单个 `CLAUDE.md` 一旦写大，要么覆盖过多不相关指令，要么太通用没用。常见做法是两层：

- 根 `CLAUDE.md`：仓库范围规则（编码标准、提交约定、目录结构）
- 子目录 `CLAUDE.md`：只跟自己区域的栈相关的约定

启动 `claude` 的位置决定了加载哪些 `CLAUDE.md`。从 `packages/api/` 启动，只加载 `packages/api/CLAUDE.md` + 根 + 每个父目录；不加载 `packages/web/CLAUDE.md`。

不相关的子目录 `CLAUDE.md` 可以用 `claudeMdExcludes` 显式排除（按 glob 模式），跳过一些团队、其他包、遗留代码。

`CLAUDE.md` 不会自动保鲜。可以加一个 `Stop` hook，让脚本在 Claude 完成响应时审查会话，提议 `CLAUDE.md` 更新。

#### 2. 减少 Claude 读取的内容

代码库一大，文件读取就是个大成本。常见配置：

- **`permissions.deny` 加 `Read` 规则**：阻止读 `dist/`、`build/`、`.generated.*`、`vendor/`，即使搜索列出来也不会打开
- **代码智能插件**：`/plugin install typescript-lsp@claude-plugins-official` 让 Claude 通过语言服务器找定义、查找引用，不用扫整个树
- **`claudeMdExcludes`**：跳过不相关包的 CLAUDE.md

#### 3. scope worktree 和文件访问

工作树（worktree）里可以控制"磁盘上有什么"和"Claude 能访问哪些目录"：

- **`worktree.sparsePaths`**：用 git sparse-checkout 只把列出的目录 + 根级文件写到磁盘。例如 `["packages/api", "packages/shared", ".claude"]`，worktree 启动更快、占空间更小
- **`worktree.symlinkDirectories`**：把 `node_modules` 这种大目录用符号链接指向主仓库副本，避免每个 worktree 都拷一份
- **`--add-dir` 或 `additionalDirectories`**：从子目录启动 Claude 时，授予对同级目录的访问权限，比如从 `packages/api/` 启动时给 `packages/shared/` 和 `packages/web/`

`sparsePaths` 里的路径相对于仓库根目录，不管从哪个子目录启动。`sparsePaths` + `symlinkDirectories` 配对使用是大型 monorepo 的标配。

#### 4. 按目录的 skills

任何子目录都可以放自己的 `.claude/skills/`，比如 `packages/api/.claude/skills/api-testing/SKILL.md`。skill 的 `paths` 字段支持 glob 模式，Claude 只在处理匹配文件时自动加载，所以前端工作时不会加载 API 专用 skill。

仓库范围的共享 skill 放根目录 `.claude/skills/`；跨仓库或需要版本化的 skill 用 plugin（带命名空间 `plugin-name:skill-name`）。

skill 多了会有"发现列表"膨胀的问题——Claude 通过读每个 skill 的 `name` 和 `description` 来选择，描述写太长会被截断。`OTEL_LOG_TOOL_DETAILS=1` 配合 OpenTelemetry 可以看到每个 skill 实际被调用的频率，借此判断哪些该合并或停用。

#### 5. 编程使用 / Agent SDK

在 CI、脚本、批处理里用 `Claude Code`，通常走 `-p` 非交互模式：

- `claude -p "..."`：非交互跑一段任务
- `--bare`：跳过 hooks、skills、plugins、MCP 自动发现、CLAUDE.md 自动加载，启动更快，CI 推荐
- `--output-format json` 或 `stream-json`：结构化输出，可配合 `--json-schema` 校验
- `--allowedTools`：预先批准一批工具，省掉权限提示
- `--permission-mode`：切换权限模式（`acceptEdits`、`dontAsk`、`auto`、`bypassPermissions`）
- `--continue` / `--resume`：继续最近的对话或恢复指定 session

Python / TypeScript 的 Agent SDK 提供完整的编程控制：结构化输出、工具批准回调、原生消息对象。`claude -p` 和 SDK 共用一套配置和权限模型。

#### 这一维度的"从哪启动"决策

代码库配置层的所有设置，最终都绕回"从哪里启动 `claude`"这个问题：

| 启动位置           | 文件访问       | 加载的 CLAUDE.md          | 适用场景                |
| :------------- | :--------- | :--------------------- | :------------------ |
| 仓库根            | 每个文件       | 仅根目录；子目录按需加载          | 任务跨多个包或子系统         |
| 子目录            | 仅该子树，直到额外授权 | 该目录 + 每个祖先             | 工作范围限于一个包或子系统      |

`.claude/settings.json` 里的项目设置不像 `CLAUDE.md` 那样按父目录继承——只从你的启动目录加载。worktree 内的工作目录是 worktree 根，所以 worktree 内的项目设置从根的 `.claude/settings.json`（在 worktree 里的副本）加载。

跨包改动时一种有效做法是"把整个改动交给一个会话"——共享编辑 + 调用站点一起交付，每个编辑背后的决策保持一致。改之前把计划写到仓库里的 markdown 文件，长会话中途压缩上下文时计划还能幸存。

#### CLI 版 vs 桌面版：四个具体场景

**场景一：monorepo，按区域隔离 CLAUDE.md 和 skills。**

文件结构：

```text
monorepo/
  CLAUDE.md                       # 仓库根：编码标准、提交约定
  .claude/settings.json           # 共享的 worktree/permissions 设置
  packages/
    api/
      CLAUDE.md                   # API 包约定
      .claude/settings.json       # sparsePaths、additionalDirectories、Read 拒绝
      .claude/skills/api-testing/SKILL.md
    web/
      CLAUDE.md
      .claude/skills/component-patterns/SKILL.md
```

CLAUDE.md / settings.json / skills 的加载规则（启动位置决定可见性）：

| 启动位置              | 加载 CLAUDE.md                  | 加载项目 settings.json | 加载 skills                      | 看到哪些目录的代码 |
| :---------------- | :---------------------------- | :------------------ | :----------------------------- | :--------- |
| `monorepo/`（仓库根）   | 仅根 CLAUDE.md；子目录 CLAUDE.md 在 Claude 读那里文件时按需加载 | 仅根 `.claude/settings.json` | 仓库根 + 任何 Claude 接触过的子目录里的 skills（列表可能膨胀） | 仓库全部文件     |
| `monorepo/packages/api/` | `packages/api/CLAUDE.md` + 根 + 每个祖先        | 仅 `packages/api/.claude/settings.json` | 根 + 该子目录 + 每个祖先                  | 仅 api 子树，直到额外授权 |
| `monorepo/packages/web/` | `packages/web/CLAUDE.md` + 根                  | 仅 `packages/web/.claude/settings.json` | 根 + web + 每个祖先                   | 仅 web 子树  |

要点：

- 根 `CLAUDE.md` 永远加载；子目录 `CLAUDE.md` 按启动位置决定是否在启动时加载，跨子目录工作时会按需懒加载
- 项目 `settings.json` **不按父目录继承**——只从启动目录加载一份
- 子目录里的 skills 会在 Claude 接触对应目录时按需加载；跨目录工作时容易"发现列表"膨胀
- `--add-dir` 加进来的目录默认不加载 CLAUDE.md / rules / skills；要加载设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`

- CLI 版：从 `packages/api/` 启动：
  ```bash
  cd packages/api
  claude
  # 加载根 CLAUDE.md + packages/api/CLAUDE.md
  # 不加载 packages/web/CLAUDE.md
  # 工作目录里只看到 api 目录的代码
  ```
  想跨包读 `packages/shared/`，CLI 加 `--add-dir`：
  ```bash
  claude --add-dir ../shared
  ```
  设置环境变量让 `--add-dir` 加载目标目录的 CLAUDE.md 和 rules：
  ```bash
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 claude --add-dir ../shared
  ```
  通过 `additionalDirectories` 设置加进来的目录只给文件访问权，不加载 CLAUDE.md 和 skills——这是 CLI 跟桌面版最容易踩坑的差异。
- 桌面版：会话 UI 里直接选工作目录，等价于 CLI 的 `cd`。同一个仓库开多个 worktree 会话，每个标签页绑一个目录；不需要手动 `--add-dir`，跨包读通过 UI 操作。

**场景二：让 Claude 不去碰构建产物和生成代码。**

- CLI 版：项目根 `.claude/settings.json`：
  ```json
  {
    "permissions": {
      "deny": [
        "Read(./**/dist/**)",
        "Read(./**/build/**)",
        "Read(./**/*.generated.*)",
        "Read(./vendor/**)"
      ]
    }
  }
  ```
  拒绝规则覆盖 Read / Edit / Write，也覆盖 Claude 识别的 Bash 文件命令（`cat`/`head`/`grep`/`find`），但不会过滤递归搜索的输出。要 gitignore 范围内的路径（`node_modules/`、`dist/`）默认就被搜索排除，不用再加 Read 规则。
- 桌面版：同一份 `~/.claude/settings.json` 生效。文件浏览 UI 会按 deny 规则隐藏这些路径。

**场景三：装代码智能插件替代"扫文件找定义"。**

- CLI 版：
  ```bash
  /plugin install typescript-lsp@claude-plugins-official
  ```
  想给整个仓库开启，写到项目 `.claude/settings.json`：
  ```json
  {
    "enabledPlugins": ["typescript-lsp@claude-plugins-official"]
  }
  ```
  代码智能插件需要每台机器装对应语言的 server（如 typescript-language-server、pyright、gopls）。受限网络下可以从内部 Git 主机加市场。
- 桌面版：插件从同一个市场安装。安装后桌面版的"跳转到定义"也走 LSP，比 CLI 体验更顺——CLI 里 Claude 调用 LSP 工具你看不到跳转，桌面版能直接在文件树里点跳转。

**场景四：CI / 批处理集成。**

- CLI 版：`claude -p` + `--bare` 模式是首选。
  ```bash
  # 拼写检查
  claude --bare -p "lint:claude" --allowedTools "Read"

  # 包到 build script 里（package.json）
  {
    "scripts": {
      "lint:claude": "git diff main | claude -p \"you are a typo linter...\""
    }
  }

  # GitHub Actions / GitLab CI / Agent SDK：同一套配置和权限模型
  ```
  `--bare` 跳过 hooks、skills、plugins、MCP 自动发现、CLAUDE.md 自动加载、OAuth 和钥匙链读取，CI 上跑出确定性的结果。
- 桌面版：通常不直接跑 CI，但桌面版可以**接管**运行在别处的会话（通过 `claude --remote-control` 或桌面应用自带的远程控制入口）。脚本侧的全部能力通过 CLI / Agent SDK 暴露，桌面应用是给"人在现场"用的。

**worktree 和文件访问的 CLI / 桌面版差异**：

| 场景             | CLI 版                                                         | 桌面版                                 |
| :------------- | :----------------------------------------------------------- | :----------------------------------- |
| 开 worktree 会话  | `claude --worktree feature-x` 或 `claude --worktree "#1234"`（开 PR worktree） | 新会话自动开 worktree                  |
| sparse checkout | `.claude/settings.json` 里 `worktree.sparsePaths`              | 同一份设置生效                           |
| 跨包访问          | `--add-dir ../shared` 或 `additionalDirectories` 设置         | UI 选目录                             |
| `--add-dir` 加载 CLAUDE.md | 设环境变量 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`  | UI 里直接选目录，CLAUDE.md 默认加载         |
| 调整 worktree 基分支 | `worktree.baseRef: "head"` 用本地未推送的提交                       | 同一份设置                              |
| 手动 git worktree | `git worktree add ../p-feature-a -b feature-a && cd ../p-feature-a && claude` | worktree 选择器里手动切换               |

#### 一个端到端示例：monorepo 里修一个跨包 bug

把三个维度的工具串起来用一次。场景：monorepo 里 `packages/shared/` 改了一个类型，`packages/api/` 和 `packages/web/` 各有调用站点需要跟着改，CI 在挂。

**步骤 1：写条件，用 `/goal` 启动主线（维度二）**

```bash
cd packages/api
claude
# 在会话里：
/goal all callsites of packages/shared/types.ts#User in packages/api and packages/web have been updated to the new shape, the test suite in both packages passes, and docs/notes/2026-07-shared-user-rename.md captures the design rationale. Do not modify any other shared type definitions.
```

条件里写清楚了：可测量的状态（测试通过）、陈述的检查（两个包的测试套件）、不能动的东西（其他共享类型）、沉淀要求（`docs/notes/` 加一篇复盘）。评估器每回合判定。

**步骤 2：让 Claude 派 Explore 子代理先调研（维度一）**

主会话里 Claude 看到条件后，先用 Explore 子代理把调用站点列全：

```text
Use the Explore subagent (very thorough) to list every call site of User
across packages/api and packages/web, grouped by file. Report back only
the file list with line numbers and the kind of usage.
```

子代理在自己 context 里翻完整个 monorepo，主会话只看到一份结构化清单，主对话不被刷屏。

**步骤 3：开 worktree 隔离并行修改（维度一）**

主会话做规划，子代理在隔离环境做改动：

```bash
# 主会话给子代理指派到 worktree
"Spawn a teammate using the api-migrator subagent in isolation: worktree
to update packages/api call sites. Require plan approval before edits."

# 或者自己开：
claude --worktree fix-shared-user-api
# 在另一个终端：
claude --worktree fix-shared-user-web
```

两份 worktree 互不干扰，CI 各自跑各自的。

**步骤 4：hooks 卡质量门（维度二）**

仓库根 `.claude/settings.json` 提前配好：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/protect-shared-types.sh" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "prompt",
          "prompt": "Verify the test suites in both packages pass and docs/notes/2026-07-shared-user-rename.md exists. If not, respond with {\"ok\": false, \"reason\": \"what remains\"}."
        }]
      }
    ]
  }
}
```

`protect-shared-types.sh` 检查 `file_path` 不能落在 `packages/shared/types.ts`（防止子代理顺手动到那个不允许改的文件）。`Stop` hook 用 prompt 类型跑一个独立小模型验证条件，把"沉淀文档"也变成 stop 放行的硬条件。

**步骤 5：让 `/goal` 收敛（维度二）**

回到主会话，等 `/goal` 评估器连续返回"是"。这时候：
- 两个包测试通过
- 复盘文档已写入
- 其他共享类型未被修改

条件全满足，`/goal` 自动清除。

**步骤 6：看 worktree 状态决定保留还是丢弃（维度一 + git 习惯）**

```bash
git worktree list
# 决定保留哪些、删哪些
git worktree remove ../fix-shared-user-api
```

`worktree.sparsePaths` 让 worktree 启动只 checkout `packages/api`、`packages/shared`、`.claude` 三个目录；`symlinkDirectories` 把 `node_modules` 链回主仓库副本，避免每个 worktree 拷一份。

整个流程串起来的工具调用顺序：

```text
/goal (维度二 · 条件驱动)
  ↓
Explore 子代理调研（维度一 · 上下文隔离）
  ↓
代理团队在 worktree 里改代码（维度一 · 文件隔离 + 隔离执行）
  ↓
PostToolUse hook 自动格式化、PreToolUse hook 卡住不允许改的共享类型（维度二 · 生命周期事件）
  ↓
/goal 评估器每回合检查（维度二 · 独立评估）
  ↓
Stop hook 强制验证测试 + 文档存在才放行（维度二 · 质量门）
  ↓
worktree 收尾 + git 留痕（维度一 · 物理隔离 + 逻辑留痕）
```

**桌面版等价流程**：开新 worktree 会话自动完成；worktree 选择器替代 `claude --worktree`；"后台任务"侧窗格替代 `/workflows` 进度视图；批准卡替代 CLI 文本菜单；远程控制可以在 CLI 跑脚本时把会话交给桌面版接管。

这个示例本身也回应了一个很现实的问题：很多人用 AI 写完代码，最后留下来的只是一段"能跑的代码"，而不是一段"能继续接手的过程"。三个维度在这里是同一件事的不同侧面——维度一把工作分到合适的执行者，维度二把节奏和质量门自动化，维度三把项目结构稳定下来。三层缺一不可。

## 代价和坑

这套方法更高效，不等于它没有代价。

### 1. token 是真成本

以前主要花的是时间。现在要开始在意：

- 哪些上下文值得给
- 哪些描述太散会浪费额度
- 哪些来回反复其实是在烧钱

`/goal` 这种多回合持续跑的工具尤其烧——每个回合评估器都要调用一次，加上主回合本身的消耗，一个看似简单的任务可能跑出十几轮。评估器跑在小型快速模型上，跟主回合比通常可以忽略，但回合一多主开销就上来了。**目标写得越清晰，回合数越少，长期成本越可控**。

代理团队和工作流的成本是线性叠加的——每个队友都是独立 Claude 实例，工作流一次能跑 1,000 个代理。提交大型任务前先在小范围试跑：单目录而不是整个仓库，单一问题而不是宽泛问题。

### 2. 选型没想清楚，返工也很快

AI 能帮你很快做出效果，但方向选错了，返工也一样快，只是返得更大。

我现在更看重前期判断：

- 这个项目适合什么栈
- 哪些地方可以先简单做
- 哪些地方一开始就得考虑维护性

先做出来，不等于乱做出来。

### 3. 切换工具时，git 习惯要更严格

在不同 AI 工具之间切来切去时，如果没有及时 commit、分支、留痕，很容易出现：

- 之前改过的代码没保存好
- 某一版思路回不去
- 你知道"好像做过"，但找不到那次改动到底在哪

`/goal` 这种自动跑多回合的工具尤其要配合严格的 git 习惯：每跑完一轮，先看一眼 diff，再决定保留还是回退，再决定要不要继续。多代理并行编辑的场景下，worktree 是物理隔离，git 是逻辑留痕，两层都不能少。

### 4. "做出来"不等于"真的掌握了"

`/goal` 让"做出来"这件事变得更轻松，但也更容易让人忽略"为什么这么做"。如果最后只拿到一个"条件满足"的结果，没有回头去看：

- 它为什么这样组织
- 哪些地方以后最难维护
- 这次选型为什么成立

那拿到的是一次顺利的代工，不一定是能力真的长了。

## 我现在实际在用的顺序

1. 描述清楚想要的理想效果
2. 和 AI 讨论技术选型和值得注意的边界
3. **把完成条件写成可验证的形式**——直接套 `/goal` 那种"可测量、可陈述、有边界"的写法
4. 让 AI 持续推进，把可运行的结果做出来
5. 回头看懂关键实现
6. 补维护文档、复盘和后续演进思路

`/goal` 这类命令的价值在于：**它把"和 AI 一起推进项目"这件事，强制变成"写好完成条件 → 验证 → 沉淀"的循环**。

## 一句话收尾

过去更像是先学会怎么做，再去做项目。

现在更像是先尽量把项目做出来，再在做的过程中学会它、看懂它、维护它。

AI 让"做中学"这件事，比以前少了很多阻力。