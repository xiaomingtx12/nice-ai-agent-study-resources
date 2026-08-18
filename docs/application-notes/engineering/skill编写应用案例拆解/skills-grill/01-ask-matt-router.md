---
sidebar_position: 2
title: "ask-matt：路由型 Skill 怎样组织一组工程工作流"
description: 从 mattpocock/skills 的 ask-matt 源码拆解入口、路由、上下文切换和发布合同，说明路由型 Skill 为什么这样组织。
---

# ask-matt：路由型 Skill 怎样组织一组工程工作流

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3``。

:::

## ask-matt 是什么

`ask-matt` 是一份用户显式调用的路由 Skill。它不修改业务代码，也不执行下游 Skill，只回答两个问题：

1. 当前任务应该从哪个入口开始？
2. 当前阶段结束后，哪些上下文需要保留、交接或清理？

```text
当前任务
   │
   ▼
/ask-matt  ──推荐下一入口──> 具体 Skill
                                  │
                                  ▼
                           产生下一阶段材料
```

它在这组 Skill 中承担的是工作流导航职责。访谈、原型、规格、票据、实现、测试和审查由其他 Skill 负责。

## 源码分析

下面按调用链阅读源码。代码块均为项目源码摘录；本文只解释这些结构解决了什么问题，以及编写类似 Skill 时应如何判断。

### 1. 入口为什么只允许用户触发

`skills/engineering/ask-matt/SKILL.md` 的 frontmatter：

```yaml
---
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---
```

对应的 `skills/engineering/ask-matt/agents/openai.yaml`：

```yaml
interface:
  display_name: "Ask Matt"
  short_description: "Find the right skill or workflow"
policy:
  allow_implicit_invocation: false
```

`disable-model-invocation: true` 关闭 Claude Code 的模型自动调用；`allow_implicit_invocation: false` 关闭 Codex 的隐式调用。两个配置共同把 `ask-matt` 定义为人工入口。

`.agents/invocation.md` 进一步规定：user-invoked Skill 不能隐式调用另一个 user-invoked Skill。

这样写有三个原因：

- 路由需要用户提供任务阶段、项目状态和优先级，模型不能只凭关键词替用户选入口；
- 路由器只负责导航，自动启动下游人工入口会把选择权隐藏在中间过程里；
- 禁止 user-invoked Skill 互相隐式调用，可以阻止路由链形成不可见递归。

因此，`ask-matt` 的输入是用户主动提出的工作流问题，输出是一个入口建议。代码、Issue、测试和审查结果都属于下游 Skill 的职责。

**可迁移判断：**需要用户在多个工作流之间做选择时，才设置人工入口。若一个 Skill 可以根据任务内容直接执行，才适合使用模型自动调用，并在 description 中写触发场景。

### 2. 路由为什么按阶段分组

`ask-matt/SKILL.md` 没有把所有 Skill 做成平铺清单，而是分成主流程、on-ramps（旁路入口）、standalone（独立工具）和 vocabulary underneath（底层共享词汇）。这些分组对应任务的不同状态。

#### 主流程

源码中的主流程是：

```text
/grill-with-docs
  → 需要运行验证：/handoff → /prototype → /handoff
  → 需要跨会话：/to-spec → /to-tickets
  → /implement
  → /tdd
  → /code-review
```

| 当前状态 | 入口 | 产物 | 下游消费者 |
| --- | --- | --- | --- |
| 想法仍然模糊 | `/grill-with-docs` | `CONTEXT.md`、ADR、已确认决策 | 原型或规格阶段 |
| 纸面无法回答设计问题 | `/prototype` | 可运行实验和结论 | 原始想法线程 |
| 方案需要跨会话保存 | `/to-spec` | 规格说明 | `/to-tickets` |
| 规格需要拆成执行单元 | `/to-tickets` | tracer-bullet tickets 和阻塞关系 | `/implement` |
| 已有可执行工作 | `/implement`、`/tdd` | 代码、测试和反馈 | `/code-review` |
| 实现需要验收 | `/code-review` | Standards 与 Spec 审查结果 | 修改或提交 |

这种分组解决了两个问题。第一，读者可以从任务状态找到入口，不需要记住所有 Skill 名称。第二，每个阶段都有明确产物，前一个阶段的结果能够成为后一个阶段的输入。

主流程中的分支也有具体条件：已经明确的方案不必重复访谈；必须运行代码或查看界面才能回答的问题才进入 `/prototype`；需要跨会话协作时才进入 `/to-spec` 和 `/to-tickets`。

#### 旁路、独立工具和词汇层

| 类型 | 入口 | 为什么单独处理 | 后续关系 |
| --- | --- | --- | --- |
| On-ramp | `/triage` | 接收外部原始 bug 或需求 | 整理后交给 `/implement` |
| On-ramp | `/diagnosing-bugs` | 先为难复现问题建立反馈环 | 修复并补回归测试 |
| On-ramp | `/wayfinder` | 处理规模大且路径不清晰的工作 | 地图清晰后回到 `/to-spec` |
| Standalone | `/grill-me`、`/research`、`/wizard` 等 | 可以脱离主流程独立产出结果 | 按产物接入其他阶段 |
| Vocabulary | `/domain-modeling`、`/codebase-design` | 提供术语和模块设计框架 | 被其他 Skill 引用 |

`/triage` 只处理外部进入、尚未整理的问题，不能再次处理 `/to-tickets` 已经生成的工作单元。`/wayfinder` 只负责建立决策地图，不能跳过规格阶段直接代替实现。

这样写的原因是：入口分类本身就是路由规则。主流程描述常规交付，on-ramp 描述异常或外部进入方式，standalone 标出无需前置条件的工具，词汇层则不制造新的交付阶段。

**可迁移判断：**路由表至少要说明进入条件、入口、产物和下游消费者。只有命令名的列表无法解释选择依据，也无法约束错误回流。

### 3. 上下文为什么在阶段边界切换

`PHASE-BOUNDARIES.md` 把会话管理放在阶段边界，并按顺序列出五个选项：

```text
1. Can you continue in this session? → Continue
2. Is the context irrelevant?        → /clear
3. Do you need to hand off?          → /handoff
4. Can the task be done AFK?         → Subagent
5. Otherwise                         → /compact
```

这不是每执行一个 Skill 就切换上下文。当前阶段仍是下一阶段的主要事实来源时，优先继续当前会话；当前信息完全无关时才清空；需要换 harness、目录或协作者时才写交接文件；固定范围的后台任务才交给 subagent；剩余情况使用 `/compact`。

把 `Continue` 放在第一位，是因为压缩和交接都会把完整讨论变成有损摘要。摘要减少上下文占用，但可能丢失决策原因和被否定的方案。这个顺序把信息损失当作阶段切换的成本来处理。

**可迁移判断：**上下文动作应绑定阶段边界，而不是绑定某个 Skill 名称。判断依据是下一阶段需要什么信息、任务是否需要人工决策，以及是否发生了 harness 或目录迁移。

### 4. Skill 为什么用名称组合

`.agents/invocation.md` 要求依赖使用 `/skill` 风格的文字调用，不使用 `../other-skill/FILE.md` 这样的内部路径引用：

```text
Dependencies are expressed as /skill-style prose invocation,
not deep ../other-skill/FILE.md cross-references.
```

`ask-matt` 因此使用 `/grill-with-docs`、`/to-spec`、`/implement` 等能力名称组织流程，而不读取这些目录里的文件。

这样写是为了隔离两个变化面：

- Skill 可以移动内部参考文件，调用方不需要跟着修改路径；
- 维护者可以直接从调用名称阅读依赖关系；
- 能力依赖和运行条件可以分开：前者写 `/to-tickets`，后者另写“调用前必须存在规格文件”。

调用名称解决“由谁处理”，输入契约解决“拿什么处理”。两者不能混成一个路径引用。

### 5. 发布为什么需要同步多份文件

`ask-matt` 的交付面包括：

| 合同 | 文件 | 负责内容 |
| --- | --- | --- |
| 行为合同 | `SKILL.md` | 名称、职责、路由和边界 |
| 调用合同 | frontmatter、`agents/openai.yaml` | Claude Code 和 Codex 的调用策略 |
| 分发合同 | 顶层 README、bucket README、`.claude-plugin/plugin.json`、安装脚本 | Skill 发现、插件发布和本地链接 |

项目根目录 `CLAUDE.md` 要求正式发布的 `engineering/`、`productivity/` Skill 同步顶层 README、对应 bucket README 和插件清单。`.claude-plugin/plugin.json` 的 `skills` 数组包含 `./skills/engineering/ask-matt`；`scripts/link-skills.sh` 把 Skill 链接到本地 harness 目录。

这套维护面解决的是发布一致性，不属于路由算法本身。新增、改名或改变调用方式时，如果只更新 `SKILL.md`，就可能出现 README 能看到但插件找不到，或 Claude Code 和 Codex 的触发策略不一致。

**可迁移判断：**项目有多个 Skill 发现和安装入口时，需要把这些文件当作发布合同一起检查。小型项目只有一个宿主时，可以减少适配文件，但仍应保留一个明确的行为入口。

## 为什么这套写法适合这个项目

把前面的源码放在一起，可以看出 `ask-matt` 的结构顺序并非随意排列：

1. **先限制触发者**：路由需要人工判断，先用两个 harness 的配置锁定入口；
2. **再排列任务阶段**：用主流程表达常规路径，用旁路承接外部问题、故障和大型未知工作；
3. **然后处理上下文**：在阶段结束时判断继续、清空、交接、委派还是压缩；
4. **最后维护组合和发布**：通过 Skill 名称隔离目录，通过清单保证多个宿主和安装面一致。

这也是路由型 Skill 应该具备的最小结构。它的价值不在于列出更多命令，而在于给每个入口补上选择条件、边界和产物去向。

## 迁移边界

### 可以采用

- 路由入口只负责选择，不代替下游执行；
- 按任务阶段组织主流程和旁路；
- 每条路径说明进入条件、输入、产物和下游消费者；
- 在阶段边界处理上下文切换；
- 通过 Skill 名称表达能力依赖；
- 明确禁止隐式递归和错误回流。

### 需要改造

- `CONTEXT.md`、ADR、Issue tracker 和 ticket 阻塞关系要替换成目标项目已有的状态存储；
- `/clear`、`/compact`、`/handoff` 和 subagent 属于特定 harness 的会话能力，其他宿主需要定义替代动作；
- Standards 与 Spec 双轴审查适合有编码规范和规格来源的项目，小型项目可以合并；
- 如果项目只有一个下游 Skill，就不需要额外设置路由器。

### 不应照搬

- 不要把所有 Skill 的长说明堆在路由文件中；
- 不要只抄命令名，不写进入条件和产物；
- 不要让所有请求无条件先经过路由器，已有明确入口的任务可以直接调用目标 Skill；
- 不要把本文的分析判断当成 `mattpocock/skills` 之外项目的运行事实。

## 编写检查清单

- [ ] 是否明确 Skill 由用户触发还是模型可自动触发？
- [ ] 是否先定义职责边界，再写路由规则？
- [ ] 每条路径是否包含进入条件、输入、产物和下游消费者？
- [ ] 是否说明阶段边界的上下文动作？
- [ ] 是否禁止隐式递归和错误回流？
- [ ] 依赖是否通过 Skill 名称表达？
- [ ] 宿主配置、README、插件清单和安装方式是否同步？
