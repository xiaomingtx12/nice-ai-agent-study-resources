---
sidebar_position: 9
title: "prototype、research 与 to-questionnaire：把未知变成可用证据"
description: 从 mattpocock/skills 源码拆解一次性原型、主要来源研究和外部知识问卷如何分别处理体验、事实与他人决策，并把结果交回后续工作流。
---

# prototype、research 与 to-questionnaire：把未知变成可用证据

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先看三种证据入口

前面的 `/grilling` 会把模糊想法拆成尚未解决的决定。决定卡住时，缺口的来源不同，处理方式也不同：

```text
待体验的逻辑或界面问题
          │
          ├── /prototype
          │      ├── logic → 可点击状态模型
          │      └── UI    → 同一路由多种布局变体
          │
          ├── 需要查证的外部事实
          │      └── /research → primary sources → findings.md
          │
          └── 掌握在其他人手中的知识
                 └── /to-questionnaire → discovery questionnaire

证据返回
    │
    ▼
/grilling → /domain-modeling → /to-spec → /to-tickets → /implement
```

三个 Skill 处理的未知对象不同：

| Skill | 输入 | 要解决的缺口 | 主要产物 | 产物由谁继续消费 |
| --- | --- | --- | --- | --- |
| `/prototype` | 一个尚未确定的逻辑或界面问题 | 方案在真实操作中是否成立、哪种结构更合适 | throwaway 原型和明确 verdict | 当前会话、Issue、后续 spec |
| `/research` | 需要事实支持的问题 | 官方文档、源码或规格到底说明了什么 | 带来源的单个 Markdown findings 文件 | grilling、wayfinder、spec |
| `/to-questionnaire` | 用户无法独立回答、且答案属于一个特定的人 | 对方掌握哪些事实和决定依据 | 面向单个收件人的 discovery questionnaire | 对方、下一轮澄清和 spec |

`prototype` 产生运行证据，`research` 产生来源证据，`to-questionnaire` 产生知识收集入口。它们都可以帮助后续流程推进，但都不直接替代规格和实现。

## `prototype`：问题决定原型形状

### 原型的产物是答案，不是代码资产

`skills/engineering/prototype/SKILL.md` 的定义很短：

```markdown
A prototype is **throwaway code that answers a question**. The question decides the shape.
```

这里有两个约束。第一，原型必须先有一个可回答的问题；第二，代码的生命周期从一开始就被标为一次性。它适合验证状态模型、数据形状、API 使用方式或页面布局，不能把“先写一版以后再说”包装成正式实现。

入口首先判断问题属于哪一支：

```markdown
- **"Does this logic / state model feel right?"** → [LOGIC.md](LOGIC.md).
- **"What should this look like?"** → [UI.md](UI.md).
```

这是流程中的第一个分流点。逻辑问题需要通过操作状态发现边界，界面问题需要并排比较信息层级和主要交互。选错分支会让原型回答另一个问题，后面的运行证据就失去意义。问题确实含糊、用户又暂时不在线时，源码允许根据周围代码作默认判断：后端模块倾向 logic，页面或组件倾向 UI，并在原型开头写出假设。

### 共同规则限制原型的成本

`prototype/SKILL.md` 对两支原型都规定了相同的运行边界：

```markdown
1. **Throwaway from day one, and clearly marked as such.**
2. **Trivial to run.**
3. **No persistence by default.**
4. **Skip the polish.**
5. **Surface the state.**
6. **Capture it when done.**
```

源码事实和它们的工程作用可以分开看：

- 原型放在实际使用位置附近，但命名必须让读者看出它是 prototype；这样运行环境、页面上下文和领域资料不会被抽象掉。
- logic 原型应当双击打开；UI 原型应当从项目已有任务入口启动。启动成本越低，非开发者越容易提供反馈。
- 状态默认保存在内存中。持久化只有在它本身是待验证问题时才进入 scratch DB 或本地文件，并明确标注可清理。
- 原型跳过测试、完整错误处理和未来泛化。它的目标是快速暴露设计错误，正式代码的质量要求在方案确定后重新建立。
- 每次操作后呈现完整相关状态；UI 每次切换变体都应保持可见。原型的价值来自观察变化，不来自静态截图。
- 结论确认后，生产代码只吸收已经验证的决定；原型本身放在 throwaway branch，并作为 primary source 保留指针。

因此，原型同时有两个输出：被生产代码吸收的 verdict，以及留在临时分支上的可重运行证据。只保留前者会丢失当时比较过的边界；把完整原型留在主分支又会把实验约束误当成生产约束。

## logic prototype：把纸面模型变成可点击反馈

### 单文件让领域人员直接操作

`prototype/LOGIC.md` 把逻辑原型定义为一个自包含 HTML 文件：

```markdown
A single, self-contained HTML file — a **shareable demo** — that lets anyone drive a state model by clicking buttons.
```

它面向业务逻辑、状态转换和数据模型问题。这些问题在类型或流程图上可能看起来合理，只有推动真实案例才会暴露非法动作、状态遗漏和顺序错误。单文件、内联 HTML/CSS/JS、不依赖 framework、bundler 或 server，使设计师、产品人员和领域专家可以直接打开文件参与判断。

这套可运行性减少了一个常见误差：开发者把“代码结构看起来合理”当成“领域模型可用”。按钮的标签和状态说明使用领域语言，参与者可以直接描述“这个动作此时不应该出现”，而不必先理解 reducer 或 class。

### 逻辑模块与页面外壳必须分离

源码要求把回答问题的逻辑放在单个 `<script>` 中，写成未来可以提取的纯模块：

```markdown
- **A pure reducer** — `(state, action) => state`.
- **A state machine** — explicit states and transitions.
- **A small set of pure functions** over a plain data type.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.
```

选择依据是问题的形状：离散事件适合 reducer；合法动作本身是问题时适合显式状态机；没有隐含当前状态时使用纯函数集合；确实拥有持续内部状态时才使用 class 或 module。页面只是 thin shell：它调用模块、渲染结果，不让模块引用 DOM，也不让按钮处理器直接摸内部状态。

```text
button click
    │
    ▼
page dispatches action
    │
    ▼
portable logic module
    │
    ▼
new state
    │
    ▼
page renders complete state
```

这样设计有明确的回流边界。原型结束后，validated reducer、machine 或 function set 可以进入正式模块；HTML 页面只保留在 throwaway branch。若把 DOM 事件和业务判断混在一起，原型只能整体复制，运行证据无法转化为生产接口。

### free-play 与 guided walkthrough 覆盖两种反馈

逻辑原型必须同时提供两类操作入口：

- **free-play buttons**：每个动作都有按钮，参与者可以任意顺序试探模型；
- **guided walkthroughs**：每个场景用一个 tab 表示，按顺序点击真实按钮，且每次从已知初始状态开始。

场景至少覆盖 happy path、awkward edge case 和非法操作。free-play 适合发现参与者没有预先想到的组合；guided walkthrough 适合复现同一个判断，让不同的人在同一条路径上讨论结果。每次操作都重新渲染完整状态，并在必要时指出刚发生的变化。

源码还明确禁止三类扩张：不加测试、不连接真实数据库、不做未来泛化。原型要验证的是一个问题；一旦加入持久化、完整异常处理和未来扩展，实验会开始承担生产职责，却仍然缺少生产代码应有的质量边界。

## UI prototype：在真实页面语境中比较结构

### 优先嵌入现有页面

`prototype/UI.md` 默认要求在同一条已有路由上展示多个变体：

```markdown
The route already exists. Variants are rendered **on the same route**, gated by a `?variant=` URL search param.
```

已有页面的 header、sidebar、数据密度、鉴权、参数和数据获取继续生效，只有渲染子树切换。这样每个变体都处在真实应用语境中，空白 demo 页面带来的“每个方案都很好看”不会掩盖实际布局压力。

只有确实没有合理宿主页面时，才建立新的 throwaway route，并遵守项目已有路由约定。新路径必须明显标注 prototype，仍然使用 `?variant=`；源码要求在创建之前先确认它确实无法嵌入现有页面。

### 变体必须结构性不同

默认生成 3 个变体，最多 5 个。差异必须出现在布局、信息层级和主要操作上：

```markdown
Variants must be **structurally different** — different layout, different information hierarchy, different primary affordance, not just different colours.
```

几个只更换颜色、文案或卡片间距的版本不能提供方案比较。共享基础组件可以保留，但共享一个决定布局的 `<Layout>` 会限制实验空间。源码让每个变体拥有独立的组件名和结构，目的是让参与者明确表达“采用 B 的导航和 C 的主操作”，而不是在一张模糊稿上继续争论细节。

### switcher 同时是实验控制器和分享协议

所有变体通过一个共享 switcher 访问。它位于页面底部，包含前一项箭头、当前变体标签和后一项箭头；切换时更新 URL 参数，因此当前方案可以被复制、刷新和交给其他人复看。

键盘左右键也可以切换，但输入框、textarea 和 contenteditable 获得焦点时不能拦截按键。switcher 必须在视觉上明显区别于被评估的页面，避免参与者把实验控件误判成产品设计的一部分。

源码还要求生产构建隐藏 switcher：

```markdown
Hidden in production builds — gate on `process.env.NODE_ENV !== 'production'` or an equivalent check.
```

这条规则把“实验辅助控件”与“产品功能”分开。即使 prototype 代码暂时合并，也不应让变体切换栏进入用户界面。选定方案后，主分支只保留正式改写后的 winner；失败变体和 switcher 连同完整比较集保留在 throwaway branch，作为设计决定的 primary source。

## `research`：把事实查证交给可追溯产物

### 后台 agent 保持主会话可推进

`skills/engineering/research/SKILL.md` 的第一条指令是：

```markdown
Spin up a **background agent** to do the research, so you keep working while it reads.
```

研究通常涉及官方文档、源码、规格或一方 API，阅读时间和主任务节奏不同。后台 agent 负责资料搜集，当前会话可以继续整理决定、准备下一轮访谈或处理其他 frontier。这里的并行不是把结论交给一个不透明的外包过程；研究 agent 仍然受到来源和产物格式约束。

### primary source 是研究边界

源码把可接受来源限定为 high-trust primary sources：

```markdown
Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
```

来源选择和最终写作分成两步。先确认事实属于哪个文档、哪个源码版本或哪个规格，再把结论写进 findings。二手文章可以帮助定位材料，但不能独立支撑影响设计的结论。这样做尤其适用于第三方 API 和行为兼容性问题：资料作者的转述不能替代拥有该行为定义的一方来源。

### 单个 Markdown 文件是交接边界

研究 agent 必须把 findings 写入一个 Markdown 文件，并为每个结论标明来源。文件位置优先遵守仓库已有笔记约定；没有约定时选择合理位置，并向主会话说明。

```text
research question
      │
      ▼
background agent
      │  primary sources
      ▼
single Markdown findings + citations
      │
      ├── /grilling
      ├── /wayfinder decision
      └── /to-spec
```

单文件约束让研究结果成为一个容易交接的上下文单元。主会话不需要保留研究 agent 的全部浏览过程，只需要读取 findings 和引用回源。它也限制了副作用：研究任务通常不修改生产代码、不直接改变 Issue 状态，也不把多个零散链接散落到工作目录。

`research/agents/openai.yaml` 只声明显示名称和简介，没有禁止隐式调用的策略。结合 `SKILL.md` 的后台 agent 指令，`research` 更接近可被其他流程按需消费的能力。`wayfinder` 可以把事实问题标成 research ticket，完成 charting 后并行启动它；研究结束后，结果回到对应 decision ticket，而非直接变成实现 ticket。

## `to-questionnaire`：把他人的知识变成可回复文档

### 只访谈发送动作

`to-questionnaire` 位于 `skills/productivity/`，不是 engineering bucket。它的 frontmatter 规定：

```yaml
---
name: to-questionnaire
description: Turn a decision you can't fully answer into a questionnaire for someone else to fill in.
disable-model-invocation: true
---
```

`SKILL.md` 将目标描述为一个 Markdown questionnaire，由一个人异步填写，或在会议中共同完成。关键规则是：

```markdown
**Grill the send, not the subject.** Interview the user only about the _send_, which they can always answer: who it goes to, and what they need back.
```

用户无法回答主题，正是因为知识在对方手中。此时继续追问主题会把一个外部知识缺口误当成用户尚未想清楚。Skill 只问两轮：收件人的 role、expertise、relationship，以及用户需要收回的具体事实或决定。第二轮结果成为 finished document 的覆盖清单，用户点名的每一项都必须对应一道问题。

它没有 setup、workspace 或额外配置。文件写入当前目录的 `to-questionnaire-<slug>.md`，发送动作由用户决定：可以复制到 Issue、Slack、邮件，也可以在会议中打开。Skill 生成内容，但不替用户向外部服务发布。

### discovery questionnaire 让陌生收件人也能回答

文档被 framing 为 discovery questionnaire，因为用户缺少上下文、收件人拥有上下文。模板包含：

- `Purpose`：问卷存在的原因和它服务的决定；
- `From`、`To` 与答案用途；
- 简短 `Context`：只提供回答所需背景；
- `How to answer`：截止时间、预计耗时，以及允许部分回答和 `I don't know`；
- 按主题分组的问题；
- `Anything else?` 收尾问题。

问题按重要性从高到低排序。异步发送可能只有一次回复机会，排序决定了在对方时间不足时哪些信息能够先回来。每个问题只表达一个想法，答案 stub 紧随其后；只有可能被误解的问题才附加 `why this matters`。

源码和配套文档还明确两个边界：一次运行面向一个 recipient，问卷是平面分组列表，不根据前一题答案动态跳过后续问题。缺口属于三个人时，应分别生成三份问卷；把多个收件人的知识压进一份文档会让语气、上下文和责任归属变得模糊。

### `to-questionnaire` 与 `grill-me` 的分界

`docs/productivity/to-questionnaire.md` 把答案位置分成四类：

| 答案在哪里 | 对应入口 |
| --- | --- |
| 用户自己尚未整理的想法 | `/grill-me` |
| 代码库中的事实和术语 | `/grill-with-docs` |
| 某个特定人的知识 | `/to-questionnaire` |
| 尚未有答案、需要材料触发判断的问题 | `/prototype` |

`grill-me` 的 rounds 会把当前 frontier 一次交给用户，逐轮重算依赖；`to-questionnaire` 处理的是另一个人的知识所有权。问卷回收后，它仍然只是原始材料：答案可以进入下一轮 `/grilling`，写入项目上下文，或被 `/to-spec` 综合成规格。问卷本身不代替领域决策，也不自动给 Issue 加状态。

`to-questionnaire/agents/openai.yaml` 设置了：

```yaml
policy:
  allow_implicit_invocation: false
```

frontmatter 同样设置 `disable-model-invocation: true`。它会创建面向外部人员的文件，并可能影响产品、业务规则或授权边界，所以入口保持用户显式调用。`prototype` 与 `research` 的配置只声明显示名称和简介，允许它们作为其他流程中的能力被调用；这与问卷需要用户确定收件人和发送边界相互对应。

## 三者如何回流到主流程

### wayfinder 按决策类型选择证据方式

`wayfinder` 的 decision ticket 已经把 `research` 和 `prototype` 作为不同类型。它们共享“解除一个决定的阻塞”这一目标，证据形式不同：

```text
wayfinder child ticket
        │
        ├── research   → 官方事实 → findings → 关闭决定票据
        ├── prototype  → 运行体验 → verdict/asset → 关闭决定票据
        ├── grilling   → 用户选择 → CONTEXT/ADR → 关闭决定票据
        └── task       → 前置操作 → 环境事实 → 继续后续决定
```

charting 阶段只把能够清楚表达的问题创建成 ticket。research ticket 可以在建图后交给后台 agent 并行处理；prototype 需要用户参与点击和比较；如果缺口属于用户自己的决定，则回到 `/grilling` 和 `/domain-modeling`。这条分工避免所有未知都被粗暴地归类成“再问用户”。

`to-questionnaire` 没有被 wayfinder 列为四种 decision ticket type，它是一个 standalone 入口。当某张 grilling ticket 依赖外部专家的知识时，可以在当前会话生成问卷，等待答案回来后再恢复决策。问卷因此是跨人协作的交接材料，不是 tracker 上一张新的实现票据。

### 证据确认后才进入规格和实现

三种产物回到主流程时都要经过一次综合：

- prototype 的 verdict 说明哪种状态模型或页面结构被验证，失败变体和比较背景留在 throwaway branch；
- research findings 说明事实、版本、限制和来源，主会话需要检查引用是否真的回答当前问题；
- questionnaire answers 补充收件人拥有的业务规则、约束或外部事实，但仍需确认哪些内容是决定、哪些只是背景。

经过 `/grilling` 或 `/domain-modeling` 收紧术语和选择后，结果进入 `/to-spec`。规格只吸收已确认的行为、边界和决策，不把原型 HTML、研究 agent 的全部阅读过程或未确认问卷答案直接复制进去。规格再由 `/to-tickets` 拆成纵向可验证切片，最后交给 `/implement`。

```text
prototype / research / questionnaire
                │
                ▼
      evidence + unresolved questions
                │
                ▼
       grilling / domain-modeling
                │
                ▼
               spec
                │
                ▼
        vertical tickets / implement
```

这条回流路径保留了证据和决定的边界。证据回答“发生了什么”或“哪个方案可行”，用户和领域人员仍然决定“项目采用什么”。

### 三种 frontier 关注不同对象

前文的 frontier 在这里继续分化：

- `prototype` 的 frontier 是还没有被点击验证的状态、操作或布局差异；
- `research` 的 frontier 是尚未从 primary source 查清的事实主张；
- `to-questionnaire` 的 frontier 是用户已经知道需要什么，但答案在 recipient 手中的问题集合；
- `grilling` 的 frontier 是前置决定已经稳定、现在可以问用户的问题；
- `to-tickets` 的 frontier 是 blocker 已完成、现在可以实现的交付切片。

它们都把工作限制在当前可以推进的边界，但边界对象不能混写。把 research findings 当作产品决定，会跳过用户选择；把 prototype variant 当作生产实现，会把实验代码带入交付；把问卷问题直接当作 spec，会把未回答的外部知识伪装成确定要求。

## 运行边界与工程代价

| 阶段 | 状态归属 | 主要副作用 | 下游消费者 |
| --- | --- | --- | --- |
| prototype 分流 | 当前会话和代码库上下文 | 判断 logic/UI 问题，确定原型宿主位置 | 原型构建 |
| logic prototype | 单个 HTML 文件和内存状态 | 可点击 reducer、状态机或纯函数演示 | 领域人员、设计决定、throwaway branch |
| UI prototype | 现有路由或明确的 throwaway route | 多变体渲染、URL switcher 和临时组件 | 用户选择、正式页面改写 |
| research | 后台 agent、primary sources | 读取外部资料，写单个 Markdown 文件 | wayfinder ticket、grilling、spec |
| questionnaire | 当前目录和外部收件人 | 写 discovery questionnaire，等待人工传递和回复 | 下一轮澄清、领域建模、spec |
| 证据回流 | 当前会话、CONTEXT/ADR、spec | 复核 verdict、来源和答案，记录决定 | to-tickets、implement |

这种拆法减少了三类混乱：

- 让没有答案的问题先通过操作、资料或专家回复获得材料，而不是直接猜实现；
- 让一次性实验、来源笔记和对外问卷拥有各自的生命周期；
- 让证据、领域决定和可执行规格保持分层，后续 agent 可以知道哪些内容已经确认。

代价也清楚：

- logic prototype 需要设计一套领域人员能理解的状态展示，并维护 free-play 与 walkthrough 的初始状态；
- UI prototype 需要保持真实页面上下文、多个结构性变体和 URL 切换器，清理成本高于一张静态 mockup；
- research 依赖高信任来源、后台 agent 和引用整理，资料访问受网络、版本和权限影响；
- questionnaire 需要用户明确 recipient、答案用途并负责实际发送，不能自动解决外部协作等待；
- 三种证据最终都需要一次人工或领域判断，不能把“有材料”误认为“已作决定”。

`prototype` 的 primary source 是 throwaway branch 中可重新运行的实验和记录的 verdict；`research` 的 primary source 是它引用的一手资料；`to-questionnaire` 的 primary source 是收件人的回答。三者的“来源”含义不同，迁移时不能用同一种文档格式代替它们。

## 迁移边界

### 可以采用

- 先识别未知来自体验、外部事实还是他人知识，再选择不同的证据入口；
- 用一个明确问题限制 prototype 范围，并在 logic/UI 之间分流；
- 让 logic prototype 的业务逻辑脱离 DOM，页面只负责操作和展示；
- 用 free-play 与可重复的 guided walkthrough 同时覆盖探索和复现；
- 在真实页面上下文中用 URL 参数比较多个结构性 UI 变体；
- 将一次性原型、研究 findings 和问卷文件与生产代码、正式规格分开管理；
- 研究只依赖拥有事实的一手来源，并让每条结论可回溯；
- 把异步问卷设计为单收件人、单一知识缺口、重要问题优先；
- 让证据回到 grilling、domain-modeling 和 to-spec，再进入 tickets 与 implement。

### 需要改造

- logic prototype 的文件格式和运行方式要适配目标项目的语言、浏览器和权限；
- UI prototype 的路由、URL 参数、组件库和生产构建标志要映射到目标前端框架；
- 无法访问外部网络或一手资料时，需要提供本地源码、离线文档或明确的人工资料入口；
- 没有后台 agent 的 harness 可以顺序研究，但仍应保留单一 findings 文件和来源追踪；
- 没有共享目录的环境要重新定义问卷文件的交接位置和生命周期；
- 外部协作系统不支持附件或 Markdown 时，要替换发送方式，但不能让 Skill 自动代替用户发布未经确认的内容；
- 目标项目若没有 `CONTEXT.md`、ADR 或 `to-spec`，需要补充等价的术语、决策和规格承载位置。

### 不应照搬

- 不要把 prototype 的 HTML shell、无测试约束或最小错误处理直接合并到生产；
- 不要把 UI 变体限制成颜色和文案调整，也不要让共享布局提前锁死比较空间；
- 不要为了方便把 logic prototype 接入真实数据库或外部副作用；
- 不要用二手文章替代官方文档、源码、规格和一方 API；
- 不要把研究 agent 的推测写成已由 primary source 证明的事实；
- 不要把问卷写成用户自己已经知道答案的 grilling，也不要在一个问卷里混合多个收件人的知识；
- 不要让 `to-questionnaire` 自动发送邮件、修改 Issue 或替用户作业务决定；
- 不要把 findings、原型 verdict 或问卷草稿直接当作可实现 ticket，先经过澄清和规格综合；
- 不要把“有一份文档”当作证据闭环，必须说明来源、回答的问题和下游消费者。

## 编写证据型 Skill 的检查清单

- [ ] Skill 是否先说明要解决的具体未知，而不是直接开始产出代码或文档？
- [ ] prototype 是否区分 logic 与 UI 分支，并在问题含糊时记录假设？
- [ ] logic prototype 是否使用自包含文件、领域语言、可见完整状态和可重复场景？
- [ ] 逻辑模块是否与 DOM 外壳分离，后续能单独提取到正式代码？
- [ ] UI prototype 是否优先嵌入现有页面，并使用 URL 参数切换结构性不同的变体？
- [ ] switcher 是否支持分享、刷新、键盘切换和生产环境隐藏？
- [ ] prototype 是否明确记录 verdict，并把完整实验留在 throwaway branch？
- [ ] research 是否使用后台 agent、primary sources 和单个 Markdown findings 文件？
- [ ] 每条研究结论是否都能追溯到拥有该事实的一手来源？
- [ ] questionnaire 是否只询问 recipient 和用户需要收回的事实或决定？
- [ ] 问卷是否面向单个收件人、按重要性排序，并允许部分回答和 `I don't know`？
- [ ] 问卷文件是否只负责生成和交接，不自动发送或修改外部系统？
- [ ] 三类产物是否分别保留实验、来源和外部回答的生命周期？
- [ ] 证据回流前是否经过 grilling、domain-modeling 或其他明确的决定确认？
- [ ] to-spec 是否只吸收已确认结论，再交给 to-tickets 和 implement？
- [ ] 入口的写文件、等待外部人员和修改生产代码等副作用是否与隐式调用策略匹配？
