---
sidebar_position: 6
title: "tdd、diagnosing-bugs 与 implement：把实现变成可反馈的交付闭环"
description: 从 mattpocock/skills 源码拆解正常开发、困难调试和多步实现如何共享测试反馈，并由 implement 组织最终交付。
---

# tdd、diagnosing-bugs 与 implement：把实现变成可反馈的交付闭环

:::info 版本基线

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills) `v1.2.3`。

:::

## 先看这条交付数据流

前一篇的 `spec` 和 `tickets` 说明要交付什么、怎样拆分和何时可以开始。本篇的三个 Skill 处理进入实现之后的反馈链：

```text
spec / tickets
      │
      ▼
  /implement
      │  选择合适的反馈方式
      ├───────────────┐
      ▼               ▼
    /tdd       /diagnosing-bugs
      │               │
      │          先构造能变红的复现环
      │               │
      └───────┬───────┘
              ▼
       失败反馈 → 最小实现或修复
              │
              ▼
       类型检查 / 测试 / 全套验证
              │
              ▼
         /code-review
```

这三者的职责不同：

| Skill | 输入 | 主要动作 | 产物或状态 | 下游消费者 |
| --- | --- | --- | --- | --- |
| `/implement` | spec、tickets 和当前代码库 | 组织实现、调用测试能力、持续验证 | 代码变更和验证结果 | `/code-review`、当前分支 |
| `/tdd` | 已确认的行为和测试 seam | 一次写一个失败测试，再写最小代码使其通过 | 可保留的行为测试和实现 | 下一轮 TDD 或实现交付 |
| `/diagnosing-bugs` | 用户报告的 bug、回归或性能问题 | 建立针对确切症状的反馈环，复现、缩小、假设和验证 | 回归测试、修复、清理后的诊断证据 | 原始复现环、架构改进 |

`/implement` 是交付入口，`/tdd` 是正常实现的反馈原语，`/diagnosing-bugs` 是困难问题的诊断纪律。测试在三者之间提供共同的可观察信号，但每个 Skill 对信号的要求不同。

## `implement`：保持编排层足够薄

### 输入和输出由一行指令确定

`skills/engineering/implement/SKILL.md` 的正文只有几条交付约束：

```markdown
Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
```

它的输入是用户提供的 spec 或 tickets。处理过程包含四个动作：

1. 根据交付材料修改代码；
2. 在已经约定的 seam（测试接缝）上尽可能调用 `/tdd`；
3. 在实现过程中反复运行类型检查和单个测试文件，最后运行完整测试套件；
4. 完成后调用 `/code-review`，再把结果提交到当前分支。

输出不是一份新的规格或 ticket，而是当前分支上的代码、测试结果、审查结果和提交。实现 Skill 不重新定义需求，也不负责把工作重新拆票据。

### 为什么正文不复制 TDD 规则

`implement` 没有重复写 red-green-refactor、mock 边界或测试命名规则。它只规定何时使用 `/tdd` 和怎样安排验证。这是编排层与能力层的边界：

- `implement` 处理交付节奏和完成条件；
- `tdd` 处理单个行为切片怎样获得反馈；
- `diagnosing-bugs` 处理普通测试环无法解释的困难问题；
- `code-review` 处理实现后的代码和规格审查。

如果把这些规则全部复制进 `implement`，任何底层测试规则变化都需要同步修改实现入口。保留 Skill 名称作为组合接口，可以让实现流程消费能力，而不依赖其他 Skill 的内部文件路径。

### 为什么实现入口必须显式调用

`implement/SKILL.md` 的 frontmatter 包含：

```yaml
---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---
```

对应的 `skills/engineering/implement/agents/openai.yaml` 还写着：

```yaml
interface:
  display_name: "Implement"
  short_description: "Build work from a spec or tickets"
policy:
  allow_implicit_invocation: false
```

实现会修改代码、运行检查、调用审查并提交当前分支。两个配置同时把它标记为 user-invoked：模型可以在流程中参考 `/tdd` 的规则，但不能在用户没有明确选择实现入口时自行启动一轮代码交付。

`/tdd` 和 `/diagnosing-bugs` 的 frontmatter 没有 `disable-model-invocation: true`，它们对应的 `agents/openai.yaml` 也只声明显示名称和简介。这种差异与副作用有关：测试纪律和诊断规则可以作为实现过程中的参考能力，实际写代码、提交和改变项目状态的入口需要用户显式触发。

## `tdd`：把行为拆成连续的反馈轮

### 测试先从项目语言和 seam 开始

`tdd/SKILL.md` 要求探索代码库时先读取 `CONTEXT.md`（如果存在），并遵守相关 ADR：

```markdown
When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.
```

这条要求把测试名称、接口术语和长期架构决定放在测试代码之前。测试描述会进入长期代码库，因此不能使用与项目已有词汇冲突的临时名称，也不能绕过已经记录的架构约束。

随后 Skill 定义 seam：

```markdown
A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user.
```

**源码直接证明：**测试应从公共边界观察行为，并且只能使用事先确认的 seam。测试范围不是模型自行决定的实现细节，而是规格和用户共同确认的验收边界。

**工程推导：**先确认 seam 会增加实现前的沟通成本，却减少两类返工：测试写在错误的层级上，以及实现完成后才发现没有可靠的行为入口。前一篇 `to-spec` 要求在规格阶段先画测试 seam，正是为这里的 TDD 反馈做准备。

### 好测试描述能力，不描述内部形状

`What a good test is` 一节把测试目标限定为公共接口上的行为：

```markdown
Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.
```

一个可保留的测试应当回答调用者关心的能力，并且在内部代码重构后仍然成立。测试名称、输入和断言应该来自用户行为、规格或独立的已知结果。

这也解释了 `tdd/tests.md` 对示例的取舍。它推荐通过真实接口验证可观察行为，反对测试私有方法、内部调用次数和绕过接口查询内部存储。测试的稳定性来自观察边界正确，而不是来自把更多实现细节写进断言。

### 为什么拒绝三种测试写法

`tdd/SKILL.md` 直接列出三种反模式：

| 反模式 | 直接证据 | 造成的问题 |
| --- | --- | --- |
| Implementation-coupled | mock 内部协作者、测试私有方法、通过旁路验证 | 重构改变结构但没改变行为时，测试无意义地失败 |
| Tautological | 以与实现相同的算法重新计算 expected value | 测试和实现共同犯错时仍然通过 |
| Horizontal slicing | 先批量写完所有测试，再批量实现 | 测试锁定了尚未理解的形状，失去对实现反馈的作用 |

其中，tautological test 不是“断言太简单”，而是 expected value 没有独立来源。`tests.md` 用固定字面量与独立的工作示例作为对照，要求结果不能由被测代码采用同一条计算路径重新推导。

水平切片的问题也不只是提交顺序。批量测试会在实现之前假定完整行为，模型还没有从上一轮代码获得反馈，测试就已经被写成一组静态设计。TDD 选择纵向切片，每一轮让测试、最小代码和新反馈相互约束。

### red → green 不是口号，而是范围控制规则

`tdd` 的循环规则只有三条：

```markdown
- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `code-review` skill), not the red → green implementation cycle.
```

每一轮都先让当前行为失败，再写足够通过该行为的代码。禁止提前为未来测试加入功能，避免实现范围在没有反馈时扩张。

`one seam, one test, one minimal implementation` 把一张大 ticket 转成可观测的小步：测试失败说明当前缺口，最小实现说明本轮边界，下一轮测试再决定是否需要更多代码。重构被放到 review 阶段，则保持 red → green 循环只回答“行为是否满足”，不在同一轮混入结构整理。

## `tests.md` 与 `mocking.md`：把测试边界写成参考资料

### `tests.md` 负责判定测试是否有信息量

辅助文件 `tdd/tests.md` 沿用行为测试原则。它把好测试描述为：

- 测试调用者关心的行为；
- 只使用公开 API；
- 能承受内部重构；
- 测试名称描述做什么，不描述怎样做；
- 一个测试只表达一个逻辑断言。

它还用两个例子说明接口边界。直接检查数据库行，验证的是内部存储副作用；通过公开读取接口取回用户，验证的才是调用者能观察到的行为。这个差异会决定测试能否约束真实交付，而不是只约束当前实现形状。

### `mocking.md` 只允许在系统边界 mock

`tdd/mocking.md` 的规则是：

```markdown
Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control
```

mock（模拟）用于隔离外部系统、时间、随机性或某些文件系统边界。项目自己的模块和内部协作者应尽量通过真实接口组合起来。这样测试会覆盖模块之间的实际连接，内部重构也不会因为 mock 形状改变而产生大量假失败。

文件还要求外部依赖通过依赖注入传入，并偏好每个外部操作都有清晰的 SDK 式接口。这些建议没有改变 TDD 的循环；它们解决的是测试 seam 是否容易建立，以及边界替身是否能保持单一、明确的返回形状。

## `diagnosing-bugs`：先建立能针对症状变红的反馈环

### 第一阶段就是这个 Skill 的核心

`diagnosing-bugs/SKILL.md` 用很强的措辞定义第一阶段：

```markdown
**This is the skill.** Everything else is mechanical. If you have a **tight** pass/fail signal for the bug — one that goes red on _this_ bug — you will find the cause; bisection, hypothesis-testing, and instrumentation all just consume it. If you don't have one, no amount of staring at code will save you.
```

诊断从反馈环开始，不从猜原因开始。这个顺序针对困难 bug 的主要失败模式：代码阅读很快会产生一个看似合理的理论，但理论没有经过能复现用户症状的命令验证。

Skill 按优先顺序列出反馈环的形式：

1. 在能触达 bug 的 seam 上写失败测试；
2. 对运行中的开发服务器写 curl 或 HTTP 脚本；
3. 用 fixture 输入调用 CLI，并将 stdout 与已知快照比较；
4. 用无头浏览器检查 DOM、console 或 network；
5. 回放捕获的 trace、请求、payload 或事件日志；
6. 用最小服务或 mock 依赖建立一次性 harness；
7. 用属性测试或 fuzz loop 提高随机错误的发现率；
8. 对已知版本区间建立 bisection harness；
9. 对旧版本与新版本执行 differential loop；
10. 最后才使用人工参与的 HITL bash 脚本。

这份列表说明反馈环不等于单元测试。测试是首选，但只要某个更高层的 HTTP、CLI、浏览器或历史版本差异环能精确捕获症状，就应优先使用它。

### 完成第一阶段需要一个已运行的命令

源码规定，反馈环在进入下一阶段前必须同时满足：

- 能驱动真实 bug 路径，并断言用户的确切症状；
- 同样输入得到稳定结论，非确定性 bug 则要把复现率提高到可调试水平；
- 运行只需数秒，而不是几分钟；
- 可以无人值守执行，人只能通过明确的 HITL 模板参与。

完成标准还要求命令至少已经运行过一次，并展示脱敏后的调用和输出。`diagnosing-bugs` 特别要求在输出中先移除 secret，把凭据保留在环境变量中。诊断材料可能包含认证 header、日志或捕获请求，因此脱敏规则是状态安全约束，不是写作格式偏好。

如果始终无法建立反馈环，Skill 要求明确列出尝试过的方式，并向用户请求可复现环境、脱敏后的 HAR/日志/core dump/带时间戳的录屏，或临时生产 instrumentation 权限。没有 red-capable command 时，不应继续把假设当作诊断结论。

### 复现之后先最小化，再提出假设

第二阶段要求运行反馈环，确认它复现的正是用户描述的问题，并记录错误信息、错误输出或慢在哪里。随后逐个删减输入、调用者、配置、数据和步骤，每次删减后重新运行，直到剩下的每一项都是 load-bearing（对失败不可缺少）。

第三阶段要求先生成 3–5 个按优先级排列的可证伪假设，每条都要写出预测：如果某个原因成立，改变哪个变量会让问题消失或恶化。源码还要求把假设列表展示给用户，让领域知识可以重新排序，但用户暂时离线时不阻塞继续验证。

这条流程与 `tdd` 的差异在于：TDD 从一个已经理解的目标行为开始，诊断从一个尚未解释的失败症状开始。诊断不能用第一条合理猜测替代复现，也不能在没有最小案例时直接改代码。

### 探针必须对应假设，并且一次只改一个变量

第四阶段要求每个 probe（探针）都对应第三阶段的某个预测，并且一次只改变一个变量。工具顺序优先使用 debugger 或 REPL，再使用边界处的定向日志，明确反对“到处打印再 grep”。调试日志必须带唯一前缀，例如 `[DEBUG-a4f2]`，方便结束时一次搜索并确认清理完成。

性能回归单独走测量分支：先建立时间、profiler 或查询计划基线，再做二分。性能问题不能用大量日志代替测量，否则日志本身可能改变时序和开销。

### 修复前建立回归测试，修复后重跑原始环

第五阶段要求在修复之前写回归测试，但前提是存在能够重现真实 bug pattern 的正确 seam：

```markdown
1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.
```

如果当前只有一个过浅的 seam，例如单调用者测试无法重现需要多个调用者共同触发的问题，Skill 要把“没有正确测试 seam”记录为架构发现，而不是用一条看似通过的浅测试宣告回归已锁定。

完成诊断还要满足：原始复现环不再失败、回归测试通过或 seam 缺失已记录、所有带前缀的调试日志删除、一次性原型删除或移入明确的 debug 位置，并在提交或 PR 说明中写出最终证实的假设。若根因指向耦合、隐藏连接或测试边界不足，再把具体发现交给 `/improve-codebase-architecture`。

### HITL 模板保留了人工边界

`diagnosing-bugs/scripts/hitl-loop.template.sh` 不是一个通用自动化脚本，而是人工参与的最后降级路径。模板提供两个小函数：

- `step`：显示操作说明，等待用户按 Enter；
- `capture`：向用户提问，把观察结果保存为变量。

脚本最后以 `KEY=VALUE` 形式输出捕获值，供 agent 读取。模板注释还要求把观察结果交给 agent，把登录、签名等敏感动作留给用户完成。

这说明 Skill 没有假设所有 UI 或外部控制台问题都能自动化。它把人工步骤限制在清晰的提示和捕获边界中，仍然保留可解析的反馈输出；人工参与不应退化成一段无法复查的口头描述。

## 三者的分工边界

### 正常新功能：`implement` 编排，`tdd` 提供反馈

当输入是已确认的 spec 或一张可执行 ticket，`implement` 负责交付范围、运行检查和最终审查。能通过公共 seam 直接表达行为时，使用 `/tdd`：

```text
ticket / spec
    → 确认 seam
    → red：一个行为测试失败
    → green：最小实现通过
    → 下一条行为切片
    → 全套测试
    → code review
```

这里的测试反馈回答“当前交付行为是否满足”。它不负责重新调查需求，也不需要诊断阶段的 3–5 个根因假设。

### 已经可复现的 bug：可以在正确 seam 上使用 TDD

如果 bug 已经有紧凑、稳定的复现命令，而且正确 seam 能表达这个失败，回归测试可以直接进入 `red → green`。此时测试先把已知症状锁定，修复只需要让它通过，再重跑原始场景。

是否调用 `/diagnosing-bugs`，取决于反馈环是否已经存在以及问题是否需要诊断纪律。Skill 的重点不是给每个 bug 增加固定流程，而是防止困难问题在没有确切失败信号时被过早修复。

### 难复现 bug 或性能回归：先使用诊断纪律

如果问题偶发、涉及多个调用者、只在真实浏览器或特定版本出现，`diagnosing-bugs` 先构造更高层的反馈环，提高复现率并缩小案例。等原因和正确 seam 清楚后，再把最小复现转成回归测试，回到实现和审查流程。

```text
症状
  → red-capable loop
  → reproduce + minimise
  → ranked hypotheses
  → one-variable probes
  → regression test
  → fix
  → original loop + cleanup
```

它与普通 TDD 共享“修复前失败、修复后通过”的纪律，但前面多了针对不确定性的证据积累。

### 多 ticket 交付：`implement` 管理交付边界

`to-tickets` 已经把工作拆成可独立验证的纵向切片和 blocking edges。`implement` 消费这些工作单元，不需要把多张 ticket 合成一个大实现上下文。每张 ticket 的测试 seam 和验收行为由 spec/ticket 提供，TDD 逐步验证具体切片，诊断 Skill 只在某个切片出现无法解释的失败时介入。

因此，三个 Skill 形成的是嵌套关系：

- ticket 决定当前交付范围；
- TDD 决定当前行为切片的反馈方式；
- 诊断 Skill 决定异常反馈如何变成可验证的根因和回归；
- implement 决定何时完成这一张 ticket 或整份工作，并交给 review。

## 运行边界与工程代价

| 阶段 | 状态归属 | 主要副作用 | 下游消费 |
| --- | --- | --- | --- |
| 读取 spec/tickets | 当前会话、代码库和 Issue tracker | 确定交付范围 | `/implement` |
| 确认 seam | spec、用户确认和测试代码 | 固定可观察的验收入口 | `/tdd` 或回归测试 |
| red → green | 当前分支 | 添加测试和实现代码 | 下一轮切片、类型检查 |
| 建立诊断环 | 测试、脚本、捕获 artifact 和环境 | 可能新增临时 harness、日志或探针 | 假设验证和回归测试 |
| 交付收尾 | 当前分支和测试结果 | 全套测试、代码审查、提交 | 后续 ticket 或发布流程 |

这套结构减少了三种混乱：

- 需求边界、测试边界和实现边界互相替代；
- 看到失败就直接猜根因；
- 用大量实现细节测试或永久调试日志掩盖行为缺口。

代价也很明确：

- seam 需要在实现前达成共识；
- TDD 要求多轮运行测试，单轮产出速度低于一次性实现；
- 困难诊断要求维护最小复现、捕获材料和脱敏输出；
- `implement` 的完整收尾依赖类型检查、全套测试、`code-review` 和当前分支提交；
- 没有正确 seam 时，问题会暴露为架构缺陷，需要另行安排架构改进。

`implement` 还要求 commit 到当前分支。这一条不是测试规则，而是该 Skill 的交付协议。迁移到只允许生成补丁、由外部 CI 提交，或禁止 agent commit 的环境时，需要替换这一步，不能把它当作通用实现前提。

## 迁移边界

### 可以采用

- 让实现入口只负责消费 spec/tickets、调度反馈能力和声明完成条件；
- 在写测试前确认公共 seam，并使用项目已有的领域词汇；
- 以行为和独立结果作为测试断言来源；
- 用 red → green 的纵向切片限制单轮实现范围；
- 困难 bug 先建立能针对确切症状变红的自动反馈环；
- 修复前写回归测试，修复后重跑原始复现并清理临时诊断材料；
- 把最终验证、代码审查和提交定义为交付的一部分。

### 需要改造

- seam、测试框架、类型检查命令和完整测试命令必须映射到目标代码库；
- 外部数据库、消息系统、时间和随机性的隔离策略要结合目标项目决定，不能机械套用 mock；
- 没有用户可确认 seam 的团队，需要补规格或评审流程；
- 不能由 agent 提交代码的环境，需要替换 `implement` 的 commit 约束；
- 只允许 CI 运行测试的项目，需要把本地反馈环改成可调用的 CI 或预览环境；
- 不能保存日志和捕获文件的环境，需要提前规定脱敏和 artifact 生命周期。

### 不应照搬

- 不要把所有任务都强行套入同样的诊断阶段；已有稳定反馈环的简单修改不需要重复制造复杂 harness；
- 不要把所有依赖都 mock 掉，以换取表面上的单元测试速度；
- 不要在没有正确 seam 时写一条浅层回归测试，并把它当作问题已经锁定；
- 不要在修复前先写大批未来测试，也不要在 red → green 循环中加入未经反馈的预测功能；
- 不要把调试日志、一次性脚本和人工操作记录留在正式交付中；
- 不要把 `implement` 的提交动作、命令名称或 tracker 状态当成所有项目共有的协议。

## 编写实现型 Skill 的检查清单

- [ ] Skill 是否说明输入是 spec、ticket、用户报告还是捕获 artifact？
- [ ] 实现入口是否只编排交付，不重复下游测试和诊断规则？
- [ ] 写测试前是否确定了公共 seam，并使用项目的领域术语和 ADR？
- [ ] 测试是否通过公开接口验证行为，而不是验证内部调用和存储？
- [ ] expected value 是否来自独立的规格、字面量或已知示例？
- [ ] 是否按一个 seam、一个测试、一个最小实现推进？
- [ ] 困难 bug 是否先建立能针对用户确切症状变红的反馈环？
- [ ] 反馈环是否已经运行过，并且足够快、稳定、可由 agent 执行？
- [ ] 诊断假设是否有排序、可证伪预测和单变量探针？
- [ ] 回归测试是否在修复前失败，修复后是否同时通过回归测试和原始复现环？
- [ ] 调试日志、临时 harness 和人工捕获材料是否已脱敏并在结束时清理？
- [ ] 没有正确 seam 时，是否把它记录为架构发现而不是伪造测试覆盖？
- [ ] 完成前是否执行类型检查、单测、全套测试和代码审查？
- [ ] 写入代码、提交分支或修改 tracker 的入口是否需要用户显式调用？
