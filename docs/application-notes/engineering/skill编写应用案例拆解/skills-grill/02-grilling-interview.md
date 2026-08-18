---
sidebar_position: 3
title: "grilling：用 frontier 和 design tree 组织多轮需求访谈"
description: 从 mattpocock/skills 的 grilling 源码拆解 design tree、frontier 和 round 如何控制提问顺序，以及访谈原语与入口 Skill 的边界。
---

# grilling：用 frontier 和 design tree 组织多轮需求访谈

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## grilling 是什么

`grilling` 是一份访谈原语。它规定模型如何围绕一个计划、决策或想法持续提问，直到双方形成共同理解。

它不负责把结果写入 `CONTEXT.md`，也不负责生成规格、Issue 或代码。它只定义访谈过程中的三个核心状态：

- **design tree**：所有决策及其依赖关系；
- **frontier**：前置条件已经满足、当前可以提问的决策集合；
- **round**：一次完整的提问轮次，以及用户回答后的状态更新。

`grill-me` 和 `grill-with-docs` 是两个入口 Skill。它们调用同一个 `/grilling` 原语，但负责不同的状态边界：`grill-me` 无状态，`grill-with-docs` 负责把讨论结果沉淀到项目文档中。

## 三个概念如何连成一轮访谈

```text
design tree
  │ 找出前置条件已经满足的节点
  ▼
frontier
  │ 将当前可问问题组成一轮
  ▼
round
  │ 等待用户回答并更新决策状态
  ▼
重新计算 frontier
```

这套结构把“问什么”与“什么时候能问”分开。设计树保存全局依赖，frontier 只表示当前可推进的边界，round 则控制一次交互的范围。

## 源码分析

下面的代码块都是 `skills/productivity/grilling/SKILL.md` 的源码摘录。每段之后区分源码直接规定的行为和基于它的工程判断。

### 1. 先建立 design tree

源码首先要求把访谈建模为一棵设计树：

```markdown
Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.
```

设计树的节点是决策，不是问题清单。一个决策确定后，依赖它的后续决策才会获得提问条件。例如，先确认“功能服务谁”，才能继续确认“权限如何划分”；先确认“数据从哪里来”，才能讨论“缓存多久”。

**输入：**用户带来的计划、选择或模糊想法。

**当前处理：**把其中的决策和依赖关系展开成树，识别哪些问题会影响后续分支。

**输出：**一组有先后关系的待决策节点。

**为什么这样写：**直接列出十几个问题会隐藏依赖关系。模型可能先问一个依赖后续决策的问题，用户回答后仍然无法推进，或者前面的答案被后面的决定推翻。设计树把提问顺序绑定到决策依赖上。

### 2. 用 frontier 找当前能问的问题

源码对 frontier 的定义是：

```markdown
The **frontier** is every decision whose prerequisites are already settled — the questions you can ask **now** without guessing at answers you haven't heard yet.
```

frontier 不是“所有未回答问题”，而是当前所有前置条件已经解决的节点。它会随着用户的回答移动：一个节点确定后，它的下游节点可能进入 frontier；如果某个分支仍然依赖未决策的问题，就继续留在树中等待。

**输入：**设计树，以及已经确认的事实和决策。

**当前处理：**过滤出前置条件全部满足的节点。

**输出：**当前轮次可以安全提问的问题集合。

**为什么这样写：**“不用猜答案”是 frontier 的边界。它禁止模型为了提前推进而假设用户尚未确认的条件，也避免把后续问题伪装成当前问题。

这里还区分了事实和决策。环境中的文件、命令结果和已有资料属于事实，模型应当自行查找；产品取舍、优先级和不可逆选择属于决策，应当交给用户确认。只有事实和前置决策都足够明确，相关节点才会进入 frontier。

### 3. 用 round 控制一次交互

源码要求按轮次工作：

```markdown
Work the tree in **rounds**. ... Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.
```

一次 round 包含四个动作：

1. 根据当前 design tree 计算 frontier；
2. 把 frontier 中的问题全部列出并编号；
3. 为每个问题给出推荐答案；
4. 停下来等待用户回答，再进入下一轮。

**输入：**当前 frontier。

**当前处理：**一次性提出当前边界上的全部问题，而不是每问一个就重新打断用户；同时给出推荐答案，帮助用户处理真正需要判断的选项。

**输出：**用户的回答、接受或拒绝推荐的决策，以及下一轮 frontier 的变化。

**为什么这样写：**一次询问整个 frontier 能减少来回等待，也能让用户看到同一层级的决策全貌。等待回答是必要边界；如果模型在用户回答前继续推演下一层问题，后续问题就建立在假设上，design tree 的依赖约束也失效。

### 4. 事实由环境查找，决策由用户确认

源码明确要求：

```markdown
Finding _facts_ is your job, never the user's. The _decisions_ are the user's — put each to them and wait.
```

这句话划分了访谈中的两种工作：

| 类型 | 负责者 | 例子 | 处理方式 |
| --- | --- | --- | --- |
| 事实 | agent | 仓库已有接口、配置、测试结果、文件位置 | 读取、检索或运行命令确认 |
| 决策 | 用户 | 是否支持某场景、优先级、取舍、不可逆选择 | 提问、给推荐、等待确认 |

这条边界避免了两种错误：让用户重复提供模型可以从环境中查到的资料；模型把自己的推测当成产品决定。

它也解释了为什么 frontier 依赖“已解决的前置条件”。事实没有核实，相关决策就不能被认为已经具备上下文；用户没有确认，模型也不能把推荐答案当成已定方案。

## 为什么 grilling 要做成原语

把访谈过程单独抽成 `grilling`，有三个直接效果。

### 访谈逻辑可以被多个入口复用

`grill-me` 和 `grill-with-docs` 都需要持续提问、控制顺序和等待回答。如果两者各自复制一份提问规则，frontier 的定义和轮次行为会逐渐分叉。原语提供共同的过程约束，入口 Skill 只处理“有没有项目目录”和“结果写到哪里”。

### 状态保存和提问过程可以分开

`grilling` 关注当前对话的设计树；`grill-with-docs` 额外负责 `CONTEXT.md`、ADR 和项目术语沉淀；`grill-me` 则不留下项目文件。过程相同，状态副作用不同，因此不需要把文档写入规则塞进访谈原语。

### 提问顺序有可解释依据

frontier 让每一轮问题都能回到设计树上的前置条件。用户如果质疑某个问题为什么现在出现，可以追溯到前一个已确认决策，而不是依赖模型临时解释。

代价也很明确：模型需要维护一棵不断更新的决策树，必须区分事实和决策，还要在每轮结束时重新计算 frontier。任务很小、没有分支决策时，直接问答比启动完整访谈原语更省成本。

## 与两个入口 Skill 的边界

### `grill-me`

`skills/productivity/grill-me/SKILL.md` 只有入口声明：

```yaml
---
name: grill-me
description: A relentless interview to sharpen a plan or design.
disable-model-invocation: true
---
```

正文只要求运行 `/grilling`。它负责提供无状态的人工入口，不负责定义访谈算法，也不写入项目文件。

### `grill-with-docs`

`skills/engineering/grill-with-docs/SKILL.md` 同样很短：

```yaml
---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADR's and glossary) as we go.
disable-model-invocation: true
---

Run a `/grilling` session, using the `/domain-modeling` skill.
```

它把 `/grilling` 和 `/domain-modeling` 组合起来，并增加文档沉淀职责。`grilling` 仍然只负责访谈过程；文档、术语和 ADR 的副作用由入口层处理。

这里可以看出三层关系：

```text
入口 Skill：决定状态和产物
    │
    ├── grill-me          无状态入口
    └── grill-with-docs   项目文档入口
             │
             ▼
        /grilling         共享访谈原语
```

## 迁移边界

### 可以采用

- 用设计树表示决策之间的前置依赖；
- 用 frontier 表示当前安全可问的问题；
- 一轮询问完整 frontier，然后等待用户回答；
- 模型负责查事实，用户负责确认决策；
- 把访谈过程与文档写入、状态保存拆成不同职责。

### 需要改造

- 目标宿主需要提供稳定的用户多轮交互机制，否则 round 无法真正暂停并等待回答；
- 如果环境不能读取文件或执行命令，需要重新定义“事实由 agent 查找”的实现方式；
- 文档型入口要根据目标项目的目录、ADR 格式和术语文件调整持久化规则；
- 没有复杂决策依赖的小任务可以采用简化版提问，不必维护完整 design tree。

### 不应照搬

- 不要把“relentlessly”理解为无止境提问，结束条件仍应是双方形成共同理解；
- 不要把所有信息都变成向用户提问的决策，仓库中已有的事实应先自行核实；
- 不要在同一轮中提前询问依赖未解决的后续问题；
- 不要把 `grilling` 的访谈规则和 `grill-with-docs` 的文档副作用写进同一份通用原语。

## 编写访谈型 Skill 的检查清单

- [ ] 是否把决策依赖表示成 design tree 或等价结构？
- [ ] 是否能根据已确认事实和决策计算当前 frontier？
- [ ] 每轮是否只询问当前 frontier？
- [ ] 是否一次列出当前 frontier 的完整问题，并等待用户回答？
- [ ] 是否为问题提供推荐答案，同时保留用户的最终决定权？
- [ ] 是否把环境事实和产品决策分给不同的责任者？
- [ ] 用户回答后是否重新计算 frontier？
- [ ] 是否定义了“共同理解已经形成”的结束条件？
- [ ] 访谈过程和文档、ADR、`CONTEXT.md` 等副作用是否分层？
