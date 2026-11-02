---
sidebar_position: 9
title: "prototype、research 与 to-questionnaire：把未知变成可用证据"
description: 从 mattpocock/skills 源码拆解一次性原型、主要来源研究和外部知识问卷如何分别处理体验、事实与他人决策，并把结果交回后续工作流。
---

# prototype、research 与 to-questionnaire：把未知变成可用证据

:::info 版本与源码入口

本文分析 [mattpocock/skills](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，基线 commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。路径相对项目根目录；以下入口均为真实章节或无标题正文，不存在同名执行函数。

| 相对路径 | 入口 | 负责什么 |
| --- | --- | --- |
| `skills/engineering/prototype/SKILL.md` | `Pick a branch`、`Rules that apply to both` | 原型分流、共同约束与收尾 |
| `skills/engineering/prototype/LOGIC.md` | `Process` | 状态模型的交互演示 |
| `skills/engineering/prototype/UI.md` | `Two sub-shapes — strongly prefer sub-shape A`、`Process` | 页面变体与切换 |
| `skills/engineering/research/SKILL.md` | 无标题正文：`Spin up a background agent`、`Its job` 列表 | 后台研究和文件输出 |
| `skills/productivity/to-questionnaire/SKILL.md` | 开头三步、`Document structure` | 访谈发送需求并生成问卷 |
| `docs/productivity/to-questionnaire.md` | `Common questions` | 同会话输入、单收件人和交付边界 |

:::

## 一、先判断缺少的是哪一种证据

设计讨论停住时，继续追问用户不一定有用。逻辑是否成立，需要操作状态模型；第三方 API 的行为，需要查资料；某项业务规则只有另一个人知道，需要把问题交给那个人。这三种缺口分别决定 prototype、research 和 to-questionnaire 的输入与输出。

| skill | 输入 | 产物 | 什么还没有完成 |
| --- | --- | --- | --- |
| prototype | 一个需要运行或比较才能回答的设计问题 | 可操作原型、对该问题的结论、实验保留位置 | 生产代码仍需按正式约束实现 |
| research | 一个可查证的问题 | 单份带来源的 Markdown 发现文件 | 项目仍需根据事实作决定 |
| to-questionnaire | 收件人背景、希望从对方获得的信息 | 面向一个人的静态问卷 | 发送、回复和答案综合仍待进行 |

**三者的实现都是交给模型遵循的指令。** prototype 描述应生成什么代码，research 要求模型委派阅读，to-questionnaire 规定如何访谈和写文件。正文中的步骤不会像程序函数那样自动运行；产物、调用工具和异常处理仍取决于执行它的 agent。

prototype 和 research 保留面向模型的触发描述，没有设置禁止模型调用的标志。to-questionnaire 设置 `disable-model-invocation: true`，对应 `agents/openai.yaml` 也设置 `allow_implicit_invocation: false`，属于用户显式选择的入口。可被模型选用只说明调用方式，不代表它们会相互串成自动流水线。

## 二、prototype：用问题选择分支，用共同规则控制成本

### 1、主文件承担分流，配套文件展开执行

源码：`skills/engineering/prototype/SKILL.md` → `Prototype`、`Pick a branch`，节选；两段间省略分流前的提示语：

```markdown
A prototype is **throwaway code that answers a question**. The question decides the shape.
```

```markdown
- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md). Build a single shareable HTML file — free-play buttons plus tabbed guided walkthroughs — that pushes the state machine through cases that are hard to reason about on paper, and that a non-developer can drive.
- **"What should this look like?"** → [UI.md](UI.md). Generate several radically different UI variations on a single route, switchable via a URL search param and a floating bottom bar.
```

这里的链接同时给出读取条件和预期产物：状态问题读取 LOGIC.md，界面问题读取 UI.md。主文件没有把两条完整流程堆在一起。后续编写分支型 skill 时，这比只列“更多资料见……”更可靠，模型知道当前为什么需要打开那个文件。

分流的依据可以来自用户提示、周围代码，或向在场用户提问。问题确实含糊且用户暂时无法回复时，指令允许按周围代码选择：后端模块偏向逻辑，页面或组件偏向 UI；假设必须写在原型顶部。它只为这个特定分支提供缺少输入时的处理方式，没有授权模型替用户确定最终设计。

### 2、原型暂时放宽质量要求，但仍有退出条件

共同规则要求原型靠近将来使用它的模块或页面，并明显命名为原型。逻辑演示双击 HTML 即可打开，UI 原型从项目已有任务入口启动。状态默认保存在内存；若待验证问题本身涉及持久化，才使用可清理的实验数据库或文件。

源码：`skills/engineering/prototype/SKILL.md` → `Rules that apply to both`，节选四至六条：

```markdown
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant state so the user can see what changed.
6. **Capture it when done.** Fold any validated decision into the real code, then capture the prototype itself as a **primary source**: commit it to a throwaway branch, out of main, and leave a context pointer to that branch on the implementation issue. Capture the answer too — the verdict and the question it settled — in the issue or a commit. The main branch keeps only the validated decision.
```

“没有测试、只保留能运行的错误处理”是这个实验阶段的成本选择。它不应变成生产实现的标准。完成条件也不只是文件能打开，而是原型已回答顶部写下的问题，并记录 verdict（结论）及其理由。

实验会留下两个不同生命周期的结果：已验证的决定进入正式代码，完整实验留在主分支之外，工作项用 context pointer（说明材料用途的引用）指向它。一次性并不等于删除全部证据；只保存结论会丢失比较背景，把所有实验代码合入主分支又会留下维护负担。

## 三、逻辑原型：让参与者通过动作发现模型问题

### 1、先写问题，再隔离逻辑

LOGIC.md 的 Process 有五步：写出问题、隔离逻辑、制作 HTML、交给用户操作、保存答案与原型。第一步要求在演示页面顶部用可见段落说明模型和待验证问题，不能只藏在代码注释里。这样用户稍后打开文件，也知道应该检查什么。

第二步把核心逻辑放进一个 script 块，页面只调用它和展示结果。源码给出四种可选形状：

源码：`skills/engineering/prototype/LOGIC.md` → `Process / 2. Isolate the logic in a portable module`，节选：

```markdown
- **A pure reducer** — `(state, action) => state`. Good when actions are discrete events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state — just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.
```

reducer 是输入旧状态和动作、返回新状态的函数，适合离散事件；状态机显式列出状态和合法迁移；纯函数集合适合没有隐含当前状态的数据变换；确有持续内部状态时，才使用类或模块的方法接口。这些是要求模型选择的设计形状，仓库没有交付一个现成 reducer 实现。

逻辑模块不能引用 DOM（页面文档对象模型）、document 或按钮处理器，按钮也不能直接改模块内部数据。操作从页面进入模块，结果回到页面显示，业务规则不反向依赖页面。以后吸收验证过的逻辑时，就能提取模块，而不必把整张演示页带入生产。

### 2、自由操作与场景演示共用真实动作

HTML 使用内联 HTML/CSS/JS，不依赖框架、构建工具或服务。页面按问题说明、完整状态面板、自由操作按钮、场景标签页排列；标签使用业务语言，状态用可读字段展示，不把原始 JSON 当作唯一说明。

源码：`skills/engineering/prototype/LOGIC.md` → `Process / 3. Build the shareable HTML file`，节选：

```markdown
3. **Free-play buttons** — one button per action, always available, so anyone can poke at the model in any order. Each click dispatches its action and re-renders the state.
4. **Guided walkthroughs** — a set of **scenarios**, one per tab. Each tab holds a short plain-language description of the scenario — the situation it sets up and what to watch for — and underneath it, the ordered **buttons to press** for that scenario. Each step is a real button: clicking it performs that action and moves to the next step. Starting a walkthrough resets to a known initial state so the scenario runs the same way every time.
```

自由操作让参与者尝试任意动作顺序；guided walkthrough（引导式演练）让不同人复现同一个场景。演练中的每一步都是调用真实动作的按钮，开始时重置到已知状态。因此两种入口观察同一套规则，不会出现说明文字演示一种行为、实际操作却走另一套逻辑的问题。

状态变化的链条是“点击动作 → 模块处理 → 返回或更新状态 → 页面重新渲染”。每次显示完整相关状态，必要时突出刚变化的字段。场景应包括正常路径、棘手边界和应该非法的尝试。非法动作是否被拒绝，正是需要让领域人员看见的行为；仅隐藏按钮可能掩盖模型根本没表达该约束的问题。

### 3、用户反馈决定是否已经回答问题

交付文件后，用户可能指出“这个动作不应该成功”，也可能要求新动作或新场景。Process / 4. Hand it over 允许继续调整原型。运行成功只能证明演示可用，不能证明模型适合业务。

一旦问题得到回答，经过验证的 reducer、状态机或函数集合可以被正式模块吸收，HTML 外壳随完整实验保存。若验证的是并发、网络故障或真实数据库行为，纯浏览器内存模型只能覆盖它实际模拟的部分，不能把交互演示的结论外推到未模拟的系统条件。

## 四、UI 原型：在真实页面中切换结构方案

### 1、先选宿主页面，再选变体数量

UI.md 强烈偏好在已有页面中挂载变体。新卡片、新区块或流程中的新步骤，只要能自然放进现有页面，都属于这个分支。只有确实找不到合适宿主时才新建明显标记为原型的临时路由，并遵守项目已有路由约定。

源码：`skills/engineering/prototype/UI.md` → `Two sub-shapes — strongly prefer sub-shape A / Sub-shape A — adjustment to an existing page (preferred)`，节选：

```markdown
The route already exists. Variants are rendered **on the same route**, gated by a `?variant=` URL search param. The existing data fetching, params, and auth all stay — only the rendering swaps. This is the default; pick it unless there's a specific reason not to.
```

保持数据读取、路由参数和鉴权，只更换渲染子树，变体就会面对真实导航、数据密度和页面空间约束。新建空白页面虽然更容易做出漂亮截图，却可能隐藏这些限制。

随后写一行实验计划，默认做三个变体，最多五个。变体必须在布局、信息层级或主要交互入口上不同，并沿用项目组件和样式体系。共享 Header 可以，强制共享决定整体结构的 Layout 会提前锁死比较空间。若两个草稿过于相似，源码要求重做其中一个，而不是仅换配色。

### 2、URL 保存当前变体，切换器负责操作

Process / 3. Wire them together 展示了一段明确标注为 pseudo-code 的框架示意，不是可定位的生产组件实现。它表达的约定是：从 variant 查询参数读取当前选择，缺省使用 A，按选择渲染对应子树，再挂一个共用切换器。这里不把该示意包装成真实源码函数。

切换器位于底部中央，显示当前变体名称，左右箭头循环切换；点击后经项目路由工具更新 URL。URL 因而成为可分享、刷新后可恢复的实验状态。

源码：`skills/engineering/prototype/UI.md` → `Process / 4. Build the floating switcher`，节选行为约束：

```markdown
- Clicking an arrow updates the URL search param (use the framework's router — `router.replace` on Next, `navigate` on React Router, etc) so the variant is shareable and reload-stable.
- Keyboard: `←` and `→` arrow keys also cycle. Don't intercept arrow keys when an `<input>`, `<textarea>`, or `[contenteditable]` is focused.
- Visually distinct from the page (e.g. high-contrast pill, subtle shadow) so it's obviously not part of the design being evaluated.
- Hidden in production builds — gate on `process.env.NODE_ENV !== 'production'` or an equivalent check, so a stray prototype merge can't ship the bar to users.
```

键盘焦点例外避免切换器抢走文本编辑的方向键；视觉区分避免用户把实验控件当作方案的一部分。生产环境隐藏只约束切换栏，不能据此推断全部原型代码都会自动从生产包排除。

同样，URL 能保存“正在看 B”，并不保证切到 B 之前输入的表单值自动保留。无效 variant 参数如何回退、切换时组件内部状态是否保留，文本没有给出完整规定；这些都需要生成原型时按实验问题决定。

### 3、真实读取可保留，真实写入要隔离

源码：`skills/engineering/prototype/UI.md` → `Anti-patterns`，节选：

```markdown
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub — the question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints (no tests, minimal error handling). Rewrite it properly when you fold it in.
```

现有页面的数据读取可以保留，但保存、删除等 mutation（修改数据的操作）应指向 stub（模拟实现）。选定方案后，记录采用哪个变体及原因，再按正式要求改写：已有页面吸收胜出结构，新页面将胜出方案变成正式路由；失败变体、临时路由和切换器移出主分支，完整比较集仍可回看。

## 五、research：委派阅读，返回可引用的文件

### 1、主会话与研究者通过问题和文件交接

research 的正文没有章节标题，核心就是一次委派和三条任务约束。

源码：`skills/engineering/research/SKILL.md` → 无标题正文，节选委派与任务列表：

```markdown
Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
```

background agent（后台执行的 agent）获得研究问题，追溯拥有事实定义的一手来源，写一份带引用的 Markdown，按项目已有笔记约定保存并报告位置。主会话得以继续处理独立工作；依赖研究结论的决定仍需等待发现文件。

文件是交接边界。后续会话读取结论与引用，无须承接研究者的全部阅读过程。source 的类型约束包括官方文档、源码、规格和第一方 API，但没有域名白名单或自动校验器；引用需要确实支撑紧邻的主张。来源冲突、资料不可访问或版本不匹配时，该短指令没有专门分支，不能假定它会自动解决。

### 2、短指令没有解决委派层级和停止条件

同一条“启动后台 agent”若原样进入子 agent 上下文，而它仍有委派工具，就可能再次启动研究者。该文件没有“已经是子 agent 就直接研究”的条件，没有限制深度、预算或重复任务识别。编写类似 skill 时，可以把调用者的委派动作与工作者的任务说明分开；需要严格限制时，应在宿主工具层限制继续委派。

研究深度也没有明确停止标准。“研究这个框架”会留下很大的解释空间；输入“核实某版本某 API 的重试行为，区分哪些错误可重试”更容易形成可判定的结果。每项待回答问题都写明已确认、未确认及原因，是可增加的输出约束，不是这份源码已经实现的字段。

单次 research 不要求创建分支、关闭工作项或自动加载旧研究文件。`skills/engineering/wayfinder/SKILL.md` 的 Chart the map 才额外要求：为研究型决策票据启动 subagent，把发现保存在 research 分支，并从票据链接过去。这是调用方加入的产物管理，不能反写成 research 自带的生命周期。

## 六、to-questionnaire：把对方的知识变成可回复问题

### 1、访谈发送需求，不让用户假装知道主题答案

源码：`skills/productivity/to-questionnaire/SKILL.md` → 开头指令，节选：

```markdown
**Grill the send, not the subject.** Interview the user only about the _send_, which they can always answer: who it goes to, and what they need back. The questions in the document then target the **gap** between what the recipient knows and what the user needs.
```

这个 skill 处理知识归属问题。用户不知道主题答案，正是需要问别人的原因。它用两次交流确定发送需求：第一次问收件人的角色、专长和与用户的关系，判断语气和背景量；第二次问希望获得哪些事实或决定，形成明确的信息缺口清单。

指令分别写了完成条件：知道对方是谁、知道哪些用户不知道的内容；知道用户收回答案后必须能做什么或决定什么。然后结束访谈，进入文件生成，没有安排一轮完整的主题 grilling。

源码：`skills/productivity/to-questionnaire/SKILL.md` → 开头第三步：

```markdown
3. **Write the questionnaire.** Draft questions aimed at the gap from steps 1–2, following the Document structure below. Write it to `to-questionnaire-<slug>.md` in the current directory (slug from the topic) and report the path. Done when the file exists and every item the user named in step 2 is covered by a question.
```

这里把“完成”拆成文件确实存在、每项信息需求都有对应问题。只生成一个排版完整但漏问关键业务规则的文档，仍不满足这条标准。这种覆盖条件适合自编文档生成 skill：检查输出是否覆盖输入，而不是仅判断是否产出了一份文件。

### 2、问卷要脱离当前对话也能填写

Document structure 要求用 discovery questionnaire（探索信息的问卷）组织内容。Purpose 写清问卷服务的决定；From、To 和答案用途说明关系；Context 用一段文字补齐收件人未参与的背景；How to answer 说明时间要求、预计投入，并允许部分回答和“不知道”。问题较多时按主题分组，最重要的排在前面，结尾用 Anything else? 接住遗漏。

源码：`skills/productivity/to-questionnaire/SKILL.md` → `Document structure`，节选模板规则：

```markdown
One `##` section per theme. Under each, its questions, most-important-first. Every question is one idea — never compound — with an answer stub directly beneath, and a one-line _why this matters_ only where the question could be misread or invite a throwaway answer.
```

每题只问一件事，下面留回答位置；只有可能误解或敷衍回答的问题才补一句理由。重要性排序考虑的是异步回复可能只有一次机会，并不依赖逐题交互。若截止时间尚未给出，模板需要填写它也不等于模型可以擅自替双方承诺日期。

### 3、同会话上下文可复用，但没有问答系统

配套说明 `docs/productivity/to-questionnaire.md` 的 Common questions 明确说没有独立 ingest（导入）阶段。接在 grilling 后使用之所以有效，是因为在同一会话中，模型已经看到那些未决问题；换新会话就要重新提供背景，skill 不会自动找到旧聊天。

输出是一份面向单个收件人的静态文档，不包含根据前题答案跳过后续题的分支树。三个不同的人各掌握一部分知识，就分别运行三次。对方回答“不知道”或仅回复一部分是允许的有效结果，不能被当作已经补齐知识缺口。

源码：`docs/productivity/to-questionnaire.md` → `Common questions`，节选发送边界：

```markdown
No. It writes a Markdown file in the current directory and tells you the path. Delivery is yours: paste it into a [ticket](https://www.aihero.dev/ai-coding-dictionary/ticket), drop it in a Slack thread, attach it to an email, or open it on a shared screen and work through it live. People have wired up all four by hand.
```

生成后报告路径即完成本次任务，没有发送接口、回复监听、提醒或答案导入。回收的答案是后续讨论的原始材料，是否进入规格、是否足以关闭决策票据，需要当前流程继续判断。

## 七、证据如何回到决定中

wayfinder 明确调用 research subagent，也允许原型类决策票据使用 prototype，并要求 HITL（人工参与）票据通过真实交流解决。生成发现文件或原型材料只是其中一步；票据的答案、关闭与地图更新由 wayfinder 的处理约定负责。to-questionnaire 没有被定义成第五种决策票据，也不会被 wayfinder 自动启动。

`skills/engineering/ask-matt/SKILL.md` 的 Standalone 推荐把研究结果带回 /grill-with-docs，把问卷答案带回 /grill-with-docs 或 /to-spec；prototype 的结论也可回到原来的设计讨论。它没有要求三种证据都必须走完同一条“grilling → domain-modeling → spec → 实现”链。已足够明确的小问题无需增加整套阶段。

自编这类 skill 时，需要写清“取得材料”和“决定已形成”之间的界线。prototype 通过用户操作暴露模型错误，research 通过来源回答事实，问卷通过收件人补齐知识；谁解释这些材料、谁有权作最终选择、如何引用结果，应由消费它们的流程说明。否则文件虽然生成了，下一次会话仍不知道哪些结论可以依赖。
