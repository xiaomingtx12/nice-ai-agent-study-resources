---
sidebar_position: 10
title: "handoff、teach、writing-for-agents 与 wait-what：上下文怎样移动、累积和纠偏"
description: 从 mattpocock/skills 源码拆解上下文交接、跨会话学习、agent 文档写作和会话纠偏如何分别管理状态与认知负载。
---

# handoff、teach、writing-for-agents 与 wait-what：上下文怎样移动、累积和纠偏

:::info 版本与源码入口

本文分析 [mattpocock/skills](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，基线 commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。路径相对项目根目录。以下文件是模型指令与格式参考，没有程序函数；无标题正文也按实际位置列出。

| 相对路径 | 入口 | 负责什么 |
| --- | --- | --- |
| `skills/productivity/handoff/SKILL.md` | frontmatter、无标题正文 | 按下一会话用途生成交接文档 |
| `skills/productivity/teach/SKILL.md` | `Teaching Workspace`、`The Mission`、`Lessons`、`Assets` | 教学状态与课程生成 |
| `skills/productivity/teach/MISSION-FORMAT.md`、`RESOURCES-FORMAT.md` | `Template / Rules`、`Structure / Rules` | 目标与来源约定 |
| `skills/productivity/teach/LEARNING-RECORD-FORMAT.md` | `When to write a learning record`、`Supersession` | 学习证据及修订 |
| `skills/productivity/writing-for-agents/SKILL.md` | `Context pointers`、`Information hierarchy`、`Steps and completion criteria` | 指令如何被读取和遵循 |
| `skills/productivity/writing-for-agents/SKILL-MECHANICS.md` | `Invocation`、`Router skills` | 模型调用与用户调用 |
| `skills/productivity/wait-what/SKILL.md` | frontmatter、无标题正文 | 重述没有被理解的内容 |

:::

## 一、四种输入，对应四种上下文处理

handoff 为下一会话准备便携文档；teach 把学习目标、课程和学习证据写进可持续使用的工作区；writing-for-agents 指导作者组织 agent 将要读取的文档；wait-what 根据用户的理解断点重新解释当前内容。它们没有组成一条依次调用的链。

| skill | 输入 | 输出或持久状态 | 主要消费者 |
| --- | --- | --- | --- |
| handoff | 当前对话，可选指定下一会话的重点 | 临时目录中的 Markdown 交接文件 | 接手工作的 agent 或同事 |
| teach | 学习目标、已有资料和学习记录 | 目标、资源、课程、参考资料和学习证据 | 当前学习者与后续教学会话 |
| writing-for-agents | 待写或待改的 agent 文档 | 按写作规则整理的指令 | 之后读取该文档的 agent |
| wait-what | 用户表示没有跟上当前解释 | 带必要背景的重述 | 当前对话中的用户 |

这些实现依赖模型遵循文字约定。handoff 没有自动迁移会话的函数，teach 没有独立运行的学习调度器，writing-for-agents 没有静态检查引擎，wait-what 也没有检测用户是否理解的程序。读源码时，应把“要求模型采取的行为”和“运行时已经保证的行为”分开。

## 二、handoff：按下一位消费者裁剪当前对话

### 1、可选参数改变摘要重点

源码：`skills/productivity/handoff/SKILL.md` → frontmatter，节选：

```yaml
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
```

argument-hint 是给用户的参数提示，说明可以告诉模型下一会话要做什么，不是参数解析函数或必填校验。对应正文把这个输入用于裁剪内容：

源码：同文件 → 无标题正文，节选参数处理指令：

```markdown
If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
```

若下一会话负责原型，应保留待回答的问题、已知限制和需要比较的方案；若下一会话接手实现，应保留已定行为、当前进展和未完成项。这是按指令作出的使用示意，源码没有给这两种情况分别定义模板。未传参数时仍可概括当前对话，正文也没有要求先追加一轮访谈。

### 2、只保存当前工作需要的交接信息

源码：`skills/productivity/handoff/SKILL.md` → 无标题正文，节选连续四段：

```markdown
Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.
```

输入是对话和下一阶段重点，输出是临时目录中的文档。已有规格、计划、ADR（架构决策记录）、工作项、提交和 diff 以路径或 URL 引用，避免复制后出现两个版本。当前讨论中尚未落进这些产物、但接手者需要的目标、理由、未决问题和下一步，则需要摘要承接。

suggested skills 是源码唯一明确要求的文档章节，用来推荐后续能力入口。它不是一段会自动执行的命令清单，handoff 也没有规定固定文件名、完整字段表或自动创建新会话。用户需要把文档交给下一位消费者，后者再按权限和调用约定开展工作。

脱敏发生在文档写出前。引用已有材料也不保证接手者能读到：目标环境可能没有相同权限，临时文件也可能已被清理。该版本没有附件打包、链接可达性检查或持久保留机制。因此跨边界交接时，需要确认正文和引用都能被接手者访问；这属于交接质量要求，不能从“文件已生成”直接推出。

### 3、与压缩会话的差别在于是否需要携带文件

`skills/engineering/ask-matt/PHASE-BOUNDARIES.md` 的 The tree 给出有顺序的选择：可以继续时先保留当前上下文；内容与下一步无关时清空；需要跨 agent 运行环境、目录、同事或分叉工作时才交接；能独立完成的工作可委派给子 agent；其余需要压缩上下文的情况才进入 compact。

handoff 因而不要求原会话结束。中途发现一个独立问题时，可以交出一份针对该问题的摘要，原会话继续工作。配套文档推荐原型探索或教学旁支这样往返，但它们都是用户可选择的组合方式，不是 handoff 自带的自动跳转。

摘要会损失细节。使用时把“已确认”和“目前推测”分开，尤其应保留影响下一步选择的理由，否则接手者容易把上次会话尚未验证的猜测当成事实。自编交接 skill 时，按下一位消费者定义内容，比简单要求“总结得更全面”更有约束力。

## 三、teach：通过文件恢复学习进度

### 1、先补目标与来源，再决定教什么

teach 的主文件按概念组织，不是一份按标题从上到下执行的脚本。真实先后关系来自各段的条件：目标不清时先问动机；资源不足时先找可信资料；确定本课主题后读取已有组件，生成课程和参考资料；获得学习证据后记录变化。

源码：`skills/productivity/teach/SKILL.md` → `The Mission`，节选：

```markdown
If the user is unclear about the mission, or the `MISSION.md` is not populated, your first job should be to question the user on why they want to learn this.
```

MISSION.md 保存 mission（学习目标及动机），格式包含 Why、Success looks like、Constraints、Out of scope。Why 要追到现实用途，成功标准写成可观察能力，约束覆盖时间和预算等条件，范围外事项限制相邻主题扩张。MISSION-FORMAT.md 规定每个工作区只承载一个目标；两个不相关主题分别使用工作区，目标过长则容易变成计划而失去指导作用。

源码：`skills/productivity/teach/SKILL.md` → `Philosophy`，节选：

```markdown
Before the `RESOURCES.md` is well-populated, your focus should be to find high-quality resources which will help the user acquire knowledge. Never trust your parametric knowledge.
```

parametric knowledge 指模型从训练中学到、保存在参数里的知识。这里要求用可信资料给教学提供依据，不能只凭模型记忆生成课程。RESOURCES.md 将知识来源与实践社区分组，每条链接附上内容和使用时机；RESOURCES-FORMAT.md 还要求缺少可靠资料时写 Gaps，剔除错误、浅薄或偏离目标的来源。

若用户指定本课内容，就围绕它安排；未指定时，Zone Of Proximal Development 要求结合 mission 和 learning-records 选择下一课。zone of proximal development（最近发展区）在这里表示对用户有挑战、又仍可学会的范围。源码没有计算分数的算法，也没有固定入门测评步骤。首次使用没有记录时，模型对用户基础的判断尤其依赖用户主动说明和后续纠正。

### 2、文件承担不同的记忆职责

Teaching Workspace 明确把当前工作目录作为教学工作区。每次会话从这些文件恢复状态，而非要求上一轮聊天始终保留。

| 位置 | 内容 | 下一轮怎样使用 |
| --- | --- | --- |
| MISSION.md | 动机、可观察目标、约束和范围 | 判断本课是否值得教 |
| RESOURCES.md | 知识来源、社区和缺口 | 给课程中的主张提供依据 |
| lessons/*.html | 编号课程，一课一个小主题 | 用户练习、反馈与复习 |
| reference/*.html | 课程的压缩知识，如语法表和流程 | 快速查阅、多课共用 |
| learning-records/*.md | 理解证据、已有知识和关键纠正 | 判断哪些可跳过、下一步教什么 |
| assets/* | 样式表、测验组件、模拟器等 | 生成下一课时复用 |
| NOTES.md | 用户教学偏好和工作笔记 | 延续表达与练习偏好 |

课程与学习记录各自使用递增编号。学习记录目录只在首次写入时创建，整个目录表不是一次性创建所有文件的脚手架指令。配套说明建议给教学使用独立仓库；这是一种使用建议，主入口本身仍以当前工作目录为写入根。

目标发生变化时，源码明确要求先与用户确认，更新 MISSION.md，再新增学习记录。不能仅因用户问了一个相邻主题，就悄悄把整个课程目标改掉。

### 3、资料模板路径和产物路径使用不同的根

主入口引用的 `./MISSION-FORMAT.md`、`./RESOURCES-FORMAT.md` 等模板相对 skill 目录；要求写入的 `./lessons/`、`./reference/`、`./assets/` 则相对教学工作区。两种路径在文本中都使用相同的相对写法，但消费者不同。

对模型而言，这不是由路径解析器强制区分的两个类型。如果把模板的目录基准沿用到课程输出，就会写错位置。自编有配套模板的 skill 时，应分别命名“参考文件所在目录”和“用户产物目录”，把读取与写入的根写清，比反复强调“使用相对路径”更有效。

## 四、teach：课程生成与学习证据是两次不同的状态更新

### 1、每课只教一个可练习的小能力

Lessons 要求课程短小、直接联系 mission，每课带来一个可观察的进步。Knowledge 段说明先教掌握当前技能所必需的知识，再用练习和反馈巩固；每课引用资料、推荐一项高质量一手来源、链接其他课程与参考文档，并提醒用户继续提问。

源码：`skills/productivity/teach/SKILL.md` → `Skills`，节选反馈约定：

```markdown
Each of these should be based on a **feedback loop**, where the user receives feedback on their performance. This feedback loop should be as tight as possible, giving feedback immediately - and ideally automatically.

For quizzes, each answer should be exactly the same number of words (and characters, if possible). Don't give the user any clues about the answer through formatting.
```

feedback loop（反馈循环）让练习结果尽快回到用户，用户据此修正操作。测验选项字数一致，是为了避免正确答案因解释更长而暴露；源码没有要求随机排序，也没有提供一个内置评分或打乱选项组件。

Fluency vs Storage Strength 区分当下想得起来和长期记得住，要求通过回忆练习、间隔练习及技能主题交错安排提升保持程度。这些是课程设计原则，文件没有接入定时复习、日历或停止教学的调度程序。写着 spacing 不能被解释成“会自动安排下周复习”。

### 2、先读 assets，生成的课程不保证单文件离线分发

源码：`skills/productivity/teach/SKILL.md` → `Assets`，节选：

```markdown
Reuse is the default, not the exception. Before authoring a lesson, read `./assets/` and build from the components already there. When a lesson needs something new and reusable, write it as a component in `./assets/` and link to it — never inline code a future lesson would duplicate.

A shared stylesheet is the first component every workspace earns: every lesson links it, so the lessons look like one consistent course rather than a pile of one-offs. As the workspace grows, so should the component library.
```

输入是本课目标和已有组件，输出是新的 HTML 课程，以及确实能供后续课程复用的新组件。共享样式表让外观统一，测验和模拟器也能复用；这避免每课都生成一套近似代码。

主文件同时把 lesson 称为 self-contained HTML，又要求链接 assets。结合后者，应该理解为一课有独立 HTML 入口、内容围绕一个完整小主题，不能保证所有依赖都内联在该文件中。分享时可能需要保留工作区的引用结构，这与 `skills/engineering/prototype/LOGIC.md` 逻辑分支的“所有内容内联、双击一个文件”要求不同；UI 分支仍依托宿主应用。

reference 保存稳定、压缩、方便回看的知识，lesson 保存用于学习和练习的过程。用户是否掌握这些知识则写入 learning record，不能仅因讲过一遍就在记录中标成学会。

### 3、学习记录只在证据改变教学判断时写入

源码：`skills/productivity/teach/LEARNING-RECORD-FORMAT.md` → `When to write a learning record`，节选：

```markdown
1. **The user demonstrated genuine understanding of something non-trivial** — not just exposure, but evidence they can use the concept correctly. This sets a new floor for what to teach next.
2. **The user disclosed prior knowledge** — "I already know X." Record it so future sessions don't re-teach it. Also record the _depth_ claimed.
3. **A misconception was corrected** — the user previously believed something wrong and now sees why. These are high-value: they predict future stumbling blocks for related topics.
4. **The mission shifted in response to learning** — the user discovered they cared about something different than they thought. Cross-link to [[MISSION.md]] and update it.
```

前三类分别是已展示的理解、用户自述的既有知识、被纠正的误解，证据强度并不相同。记录已有知识时要保存用户声称的深度，不能改写成已经通过测评。第四类将目标变化与记录关联，供下一次会话理解课程方向为何改变。

记录格式只有标题和一至三句“已学到或已确认什么、为什么影响后续教学”。Status、Evidence、Implications 都是有价值时才加入的可选内容。编号通过扫描现有最大编号后加一获得，没有并行写入锁。

源码：`skills/productivity/teach/LEARNING-RECORD-FORMAT.md` → `Supersession`：

```markdown
When a later record contradicts an earlier one (the user's understanding deepened or corrected), mark the old record `Status: superseded by LR-NNNN` rather than deleting it. The history of how understanding evolved is itself useful signal.
```

后来的理解推翻旧记录时，旧条目标记为被新记录取代，保留演变历史。下一会话因此既能看到当前理解，也能知道过去容易出错的位置。它不是按会话追加流水账，而是根据会影响教学的变化选择性写入。

### 4、词汇表文件存在，不等于主流程会读取它

Reference Documents 要求创建参考资料，提到词汇表很重要，建立后各课应遵守。仓库还有 `skills/productivity/teach/GLOSSARY-FORMAT.md`，规定何时把术语加入 GLOSSARY.md。

源码：该文件 → `Rules`，节选：

```markdown
- **Add a term only when the user understands it.** The glossary is a record of compressed knowledge, not a dictionary the user reads to learn. If the user has just been introduced to a concept, wait until they can use it correctly before promoting it here.
```

但 teach/SKILL.md 的工作区表与引用中没有直接指向这个格式文件；学习记录格式只提到不要重复 GLOSSARY.md 的定义。因此不能声称 teach 一定自动建立这个特定文件、按这份格式执行。HTML 参考词汇表与 GLOSSARY.md 的选择也没有在主入口统一。

这暴露了配套文件常见的维护问题：规则还在，但读取它的入口已经断开。需要固定词汇表格式时，应增加明确的条件引用并确定唯一载体，不能只把一个 FORMAT.md 放进目录就期待模型发现。

## 五、writing-for-agents：让指令在正确时刻被读到

### 1、它是一份参考，不是需要逐步照跑的流程

主入口称自己为供 agent 文档写作使用的 reference，涵盖 skill、AGENTS.md、CLAUDE.md 及被引用的资料。它没有规定一个统一产物路径，也不负责收集项目事实；当前写作任务决定改哪份文档，这份参考约束如何组织内容。

源码：`skills/productivity/writing-for-agents/SKILL.md` → 开头条件引用：

```markdown
When the document you're writing is a skill, read [`SKILL-MECHANICS.md`](SKILL-MECHANICS.md) for frontmatter, invocation choice, and router skills.
```

普通 agent 文档使用主文件的写作规则；只有编写 skill 时，才补读封装与调用机制。这个句子本身就在示范 context pointer（上下文指针）：说清材料是什么，并给出何时读取的条件。

Context pointers 进一步要求把 leading word（能唤起一组行为的紧凑概念词）放在指针前部，每个真实分支保留一个触发条件，合并仅换说法的同义触发。比如 prototype 的两条链接以待回答问题分流，比反复堆“探索、研究、试验设计”等近义词更能区分该读 LOGIC.md 还是 UI.md。

### 2、分层依据是当前是否需要，不是单纯减少字数

主文件区分两种负担。context load 是始终进入模型上下文的材料消耗的 token 和注意力；cognitive load 是用户记住入口及使用时机的成本。把资料放到条件引用后面，可以减少常驻正文，却仍需付出指针本身的成本；完全不设指针，则主要靠人记得它存在。

源码：`skills/productivity/writing-for-agents/SKILL.md` → `Information hierarchy`，节选层级定义：

```markdown
1. **In-file step** — the primary tier: what the agent does, in order.
2. **In-file reference** — consulted on demand. Often a legitimately flat peer-set (every rule of a review on one rung) — a fine arrangement, not a smell.
3. **Disclosed reference** — pushed out into a separate file, reached by a context pointer, loaded only when the pointer fires. Spans a sibling file in the same folder through fully external reference that lives anywhere and any document can point at.
```

顺序动作位于最高层，按需参考规则可以与动作同文件，也可以移到条件引用后。progressive disclosure（渐进披露）就是后移特定分支才需要的资料，让执行步骤保持可见。所有分支都需要的规则继续内联，只有部分分支需要的细节再拆开。

co-location（共置）处理另一个维度：同一概念的定义、规则和例外放在一起。比如 wayfinder 把认领和 blocker 的定义放在 Tickets 下，模型读取票据结构时也会接触它们的约束。把定义和例外散落数处，即使没有重复文字，也可能只读到一半规则。

### 3、完成条件同时规定可检查性与覆盖范围

源码：`skills/productivity/writing-for-agents/SKILL.md` → `Steps and completion criteria`，节选：

```markdown
The strongest criteria are both checkable and exhaustive.
```

checkable 指能区分完成和未完成；exhaustive 指覆盖必须处理的对象。主文件分别称为 clarity 和 demand。前者避免用“理解已达成”这种模糊边界，后者避免只要求“产出一个列表”却不要求覆盖全部输入。to-questionnaire 的“文件存在且用户点名的每项需求都有一道题”同时满足这两个方向。

模型有时会被后面看起来更容易完成的步骤吸引。源码建议先收紧当前步骤的完成条件；只有条件确实无法清晰化、并且观察到提前结束，才通过真实的上下文边界隐藏后续步骤，例如交接或子 agent 委派。同一上下文内再调用一个文件，不会清除已经看到的后续步骤。

因此，为解决“调查不充分”而不断拆文件不一定有效。若工作者仍能看到完整的后续输出目标，注意力问题可能保持原样；能判断每项问题是否被覆盖的完成条件更直接。

### 4、修剪针对行为冗余，不是追求短文

Leading words 用 lesson、fog of war 等紧凑概念组织行为。它们的价值来自读者模型已有的语义以及正文给出的边界，不是某个词天然有控制力。自造概念可以用，但需要付出定义成本；反复喊“认真”“全面”也不等于设定了可检查的标准。

源码：`skills/productivity/writing-for-agents/SKILL.md` → `Pruning`，节选单一事实来源规则：

```markdown
- Keep each meaning in a **single source of truth**: one authoritative place, so changing the behaviour is a one-place edit. **Duplication** — the same meaning in more than one place — costs maintenance and tokens, and inflates a meaning's prominence on the ladder past its real rank. (The accidental inverse of a leading word, which repeats a token on purpose, never the meaning.)
```

Pruning 还把 package.json、配置和 --help 输出视为可查询的事实来源，不鼓励在文档里复制容易过期的命令。文档更应保存环境查不出的约定、选择理由和隐含限制。no-op 指删去后不改变模型行为的句子；是否属于 no-op 取决于模型默认行为，需要实际使用来判断，不能只按篇幅判断。

这些规则适合压缩给模型执行的指令。面向人的源码解析还承担教学职责，需要解释读者未必认识的概念，不能因为某段对模型是常识，就从文章中删掉必要的机制说明。

## 六、调用方式决定谁负责发现入口

### 1、模型调用和用户调用各自承担成本

`skills/productivity/writing-for-agents/SKILL-MECHANICS.md` 的 Invocation 把选择分为 model-invoked（模型可自行选用）与 user-invoked（用户显式启动）。前者保留触发 description，省略 disable-model-invocation；后者设为 true，将 description 作为面向人的简介。

| 本篇入口 | SKILL.md 配置 | 配套 agents/openai.yaml |
| --- | --- | --- |
| handoff、teach、wait-what | disable-model-invocation: true | allow_implicit_invocation: false |
| writing-for-agents | 保留触发描述，未设置禁用项 | 显示信息，未设置禁止隐式调用项 |

这是仓库表达的调用约定。它不意味着任何读取 Markdown 的宿主都会同样处理这些字段，也不意味着某个 skill 写文件就必须设为用户调用；prototype 同样会生成代码，却保留模型可发现性。选择依据是工作是否需要模型自己发现入口，还是应由用户决定何时启动。

模型可调用的 skill 仍可由用户点名。共享参考如 writing-for-agents 需要被不同流程触达，适合保留模型入口；handoff、teach、wait-what 则让人决定是否交接、开启长期学习或纠正当前表达。

### 2、路由提示不等于替用户调用

源码：`skills/productivity/writing-for-agents/SKILL-MECHANICS.md` → `Router skills`，节选：

```markdown
When user-invoked skills multiply past what you can remember, that piled-up cognitive load is cured by a **router skill**: one user-invoked skill that names the others and when to reach for each, so the human has one skill to remember instead of many. It can only hint, never fire them: user-invoked skills have no description, so nothing but the human can reach them.
```

“没有 description”在此指模型发现入口不暴露该描述，不是说 SKILL.md 物理上删掉了字段。router skill（帮助用户选择入口的路由 skill）降低人记忆多个名称的成本，但不绕过显式调用约定。ask-matt 推荐 handoff 或 teach 时，仍需要用户选择下一步。

若两个用户入口都需要同一份参考，可以把它提取成普通文件并写清读取条件。不能仅在其中一个用户入口写“调用另一个”就假定它们能互相触发。按调用方式拆分的依据应是确实需要独立发现的意图或共享能力，而不是文件越多越模块化。

## 七、wait-what：恢复理解所缺的背景

### 1、一句话同时指定对象、表达方式和术语来源

源码：`skills/productivity/wait-what/SKILL.md` → 无标题正文：

```markdown
Wait — I don't understand where you've got to here. Re-pitch that: give me a little bit of context, talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md`.
```

输入是当前对话中的理解断点，输出是重述。Wait 表达“我没有跟上”，re-pitch that 要求重新组织刚才的内容，补一点背景；ASD-STE100 Simplified Technical English 是指令指定的简化技术英语表达要求，CONTEXT.md 则提供 ubiquitous language（项目共同使用的领域语言）。该文件没有内置英语合规检查器，也没有重新生成领域词汇表的步骤。

配套 `docs/productivity/wait-what.md` 的 The name is the mechanism 解释了 that 的范围：让模型根据断点决定需要回退多远，不必局限于上一句话。机械删短上一条消息可能反而丢掉用户缺少的前提，重述应优先把那个前提补回来。

### 2、没有状态迁移，也不承诺用户已理解

wait-what 没有定义新文件、学习记录、工作项状态或新的需求访谈。当前工作仍留在原处，模型重新解释；用户是否理解，需要从后续交流判断，不能把重述成功输出视为“理解完成”的程序状态。

如果没有 CONTEXT.md，配套说明明确表示仍可重述，只是失去项目词汇来源这一部分。它没有因此要求启动 /domain-modeling、创建术语文件或把问题改成 /teach。若用户其实缺少需要长期练习的新知识，后续可以另选 teach，但这属于新的意图选择。

这类极短 skill 的可复用之处，是把触发信号、处理对象和输出变化写在同一句指令中。它不需要借助持久文件；handoff 要交出文件、teach 要积累证据，分别因为下一位消费者和下一次会话需要这些状态。编写新 skill 时，应由这种实际需求决定状态存在哪里，而不是为每个对话动作都创建一套工作区。
