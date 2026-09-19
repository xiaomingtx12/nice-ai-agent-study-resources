---
sidebar_position: 6
title: "tdd、diagnosing-bugs 与 implement：测试反馈怎样组织实现和诊断"
description: 从 mattpocock/skills 源码拆解正常开发、困难调试和多步实现如何共享测试反馈，并由 implement 组织最终交付。
---

# tdd、diagnosing-bugs 与 implement：测试反馈怎样组织实现和诊断

:::info 版本与源码入口

本文分析 GitHub 项目 [`mattpocock/skills`](https://github.com/mattpocock/skills)，`package.json` 版本为 `1.2.3`，commit 为 `84fdeffd12f2ee307994d1eb6feb48173b6e0502`。路径均相对项目根目录；除 Bash 模板外，入口都是 Markdown 章节或正文指令。

| 文件 | 阅读入口 | 作用 |
| --- | --- | --- |
| `skills/engineering/implement/SKILL.md` | frontmatter 后的五条正文指令，无章节标题 | 实现、按需使用 TDD、检查、审查与提交 |
| `skills/engineering/tdd/SKILL.md` | `Seams — where tests go`、`Anti-patterns`、`Rules of the loop` | 规定测试接缝与 red → green 纪律 |
| `skills/engineering/tdd/tests.md`、`skills/engineering/tdd/mocking.md` | `Good Tests`、`Bad Tests`；`When to Mock`、`Designing for Mockability` | 测试示例与外部依赖替身 |
| `skills/engineering/diagnosing-bugs/SKILL.md` | `Redact`、`Phase 1` 至 `Phase 6` | 复现、最小化、假设、探针、修复与清理 |
| `skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh` | `step()`、`capture()`、末尾 `printf` | 人工步骤与观察结果采集 |
| `skills/engineering/code-review/SKILL.md` | `1. Pin the fixed point` | 理解交付末尾的审查范围 |

:::

## 一、implement 规定交付顺序，但没有包办所有交接

### 1、五条指令如何消费规格和票据

`implement` 消费已经决定的工作，`tdd` 提供测试先行的规则，`diagnosing-bugs` 处理尚未解释清楚的失败。三者主体都是让模型遵循的指令；它们没有共同的调度函数、运行状态对象或强制转换程序。测试结果、代码差异、复现材料和当前会话，才是执行中实际存在的状态。

来源：`skills/engineering/implement/SKILL.md` → frontmatter 后的正文，完整引用五条指令：

```markdown
Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
```

执行要求依次是：按照规格或票据修改代码；**在适用时**使用 `/tdd`，且测试接缝须事先约定；过程中经常运行类型检查和单个测试文件，末尾运行一次完整测试套件；完成后调用 `/code-review`；把工作提交到当前分支。`where possible` 保留了适用条件，不能改写成每项改动都必须走 TDD。

这层没有重复测试规则，也没有规定具体测试框架、命令、重试次数或“经常”的时间间隔。这些信息要从项目配置和任务上下文获得。它同样没有定义创建新分支、发布拉取请求、勾选验收项或关闭工作项的动作，提交成功并不等于工作项状态已经更新。

`implement` 的 frontmatter 设置 `disable-model-invocation: true`，对应 `agents/openai.yaml` 设置 `policy.allow_implicit_invocation: false`，按项目约定需要用户显式调用。`tdd`、`diagnosing-bugs`、`code-review` 没有这两个限制，可以在合适的上下文中由模型选用。调用分类决定入口可达性，不是“只读或会改代码”的权限分类：测试和诊断同样可能产生代码变更。

### 2、源码没有直接连接 implement 与 diagnosing-bugs

上面的五条正文只点名 `/tdd` 与 `/code-review`，没有 `/diagnosing-bugs`。诊断 skill 的 `description` 包含“diagnose / debug this”以及 broken、throwing、failing、slow 等触发语，模型可以因当前任务符合描述而选用它，但不能画成 `implement` 每次都会调用的固定分支。

同样，`implement` 不会替 `tdd` 确认接缝。接缝可能已写在规格中，也可能需要在使用 TDD 时确认。只有把这一输入带过来，“在预先约定的接缝上测试”才有具体对象。把完整测试方法放在被引用 skill 中减少了重复，也让编排层对这些前提的缺失更敏感。

## 二、tdd：每轮都适用的参考规则

### 1、先确定公共接缝，接口形状不清时再读设计词汇

TDD 是 Test-Driven Development（测试驱动开发）。这个版本把它限定为 red → green：先得到失败测试，再写最小实现使其通过。`skills/engineering/tdd/SKILL.md` 开篇要求每个循环都参考全部规则，而不是把正文当作只读一次的顺序教程。

来源：`skills/engineering/tdd/SKILL.md` → `Seams — where tests go`，摘录定义和确认要求：

```markdown
A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. You can't test everything — agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.
```

seam（测试接缝）指输入条件并观察结果的公共接口位置。它决定测试在什么层次证明行为，也决定哪些内部结构可以自由改动。探索代码库时还要读取已有 `CONTEXT.md`，让测试名称与领域词汇一致，并遵守相关 ADR（架构决策记录）。

确认的是测试投入范围，而不是要求测试每个边缘情况。假如规格已经明确测试入口，执行者应带上这项约定；新增或改变接缝则不能悄悄自行决定。若问题变成“模块应该暴露哪些能力、接缝应该放在哪一层”，同节才要求使用 `/codebase-design` 的共享设计词汇。这个条件引用把接口设计与测试纪律分开，避免每次写测试都重新设计模块。

### 2、输入走公共接口，预期结果来自独立依据

`What a good test is` 要求测试可观察行为；它把详细例子放入 `tests.md`，把替身策略放入 `mocking.md`。这两个配套文件补充判断依据，没有新的调度入口。

来源：`skills/engineering/tdd/tests.md` → `Bad Tests` 中的公共接口对照例，摘录其正例；英文注释译为中文，其余代码保持原文。这是源文件自带的教学示例，不是该仓库运行中的用户系统。

```typescript
// 好：通过接口验证
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

`createUser` 创建用户后，测试通过 `getUser` 查询结果。这样创建与读取能否配合工作也被验证。配套反例直接查询数据库行，只能证明某种存储副作用；内部存储改变时，它可能失败，即使调用者看到的行为完全没变。

`Anti-patterns` 还指出 tautological test（同义反复的测试）：断言以与实现相同的算法重算预期值，测试与实现可能共同犯错。来源：`skills/engineering/tdd/tests.md` → `Bad Tests` 的对应正例，英文注释译为中文：

```typescript
// 好：预期值是独立、已知的字面量
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

这里的 `15` 来自一个独立可核对的例子。这个测试能否提供价值，取决于预期值是否确实来自规格或独立计算；仅仅把实现算出的答案抄成字面量，并不会自动得到独立证据。

### 3、一次一个行为，重构不在本版本的循环内

来源：`skills/engineering/tdd/SKILL.md` → `Rules of the loop`，完整摘录：

```markdown
- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `code-review` skill), not the red → green implementation cycle.
```

本轮状态从“行为缺失，有一个失败测试”变成“最小实现满足这个测试”，下一轮再根据已获得的反馈选下一个行为。它反对先批量写所有测试、再批量实现，因为那会在理解实现之前锁定整套测试结构。

即使 description 和 UI 简介仍出现 “red-green-refactor”，正文明确把重构放到审查阶段。这里不能套用常见三段式，把第三段补回该版本流程。`code-review` 本身又只要求报告发现，并没有自动重构或“修复后持续重审”的指令；把重构安排到审查阶段，只是职责分配，不代表重构已被程序接管。

### 4、mock 放在系统边缘，内部协作者保留真实连接

来源：`skills/engineering/tdd/mocking.md` → `When to Mock`，完整引用该节规则：

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

mock（模拟替身）用来控制付款、邮件等外部调用，以及时间、随机性和部分存储行为。数据库优先使用测试数据库，文件系统也只是“有时”替换；不能把列表解释成所有存储一律模拟。内部协作者如果全换成替身，真实调用关系出错时测试可能仍然通过。

`Designing for Mockability` 因而建议依赖注入：把外部客户端作为参数传入，避免在函数内部临时创建。它还偏好按业务操作拆开的 SDK 式接口，例如 `getUser` 和 `createOrder`，让每个替身只有一种明确的结果形状；一个泛用 `fetch(endpoint, options)` 替身则要再写分支判断，测试准备本身也会变复杂。

这套规则适合存在独立输入、输出和业务约束的行为。纯配置、类型标注或简单转发若没有独立预期，强行补测试容易落入它自己反对的同义反复。`implement` 的条件式引用保留了这一判断空间，但 `tdd` 没有提供自动判定“该不该写测试”的算法。

## 三、diagnosing-bugs：先获得失败信号，再解释原因

### 1、第一阶段的出口是实际运行过的复现命令

诊断 skill 以用户的具体症状为输入。开篇要求仅在明确说明理由时跳过阶段，`Redact` 则要求展示命令、输出和捕获材料前先脱敏，凭据放在环境变量中，公开输出只保留与失败有关的信号。这是模型的操作约定，没有附带自动清洗日志的程序。

来源：`skills/engineering/diagnosing-bugs/SKILL.md` → `Phase 1 — Build a feedback loop` 下的 `Completion criterion — a tight loop that goes red`，摘录出口条件：

```markdown
Phase 1 is done when the loop is **tight** and **red-capable**: you can name **one command** — a script path, a test invocation, a curl — that you have **already run at least once** (show the invocation and its output, redacted), and that is:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to _catch this specific bug_.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.
```

tight 指反馈短、稳定且命中确切症状；red-capable 指命令有能力捕获这一个 bug。进程能启动、请求返回成功，都不够证明错误路径已被触发。第 1 阶段要求命令至少运行过一次，第 2 阶段进一步确认观察到的失败正是用户描述的失败，并多次复现。

同阶段按大致偏好给出十种构造方式：失败测试、HTTP 脚本、固定输入的 CLI 对比、无头浏览器、捕获数据回放、一次性运行支架、属性或模糊测试、二分定位、版本差分、人工参与脚本。模型应寻找适合症状的一种，再缩短初始化、固定时间和随机种子、收窄断言；不是把十种方式全部执行一遍。

对偶发问题，目标改为提高并固定可调试的复现率，可以重复触发、并行施压或缩小时序窗口。对始终无法构造有效反馈的情况，`When you genuinely cannot build a loop` 要求停止，列明尝试，并请求复现环境、脱敏捕获材料，或临时生产探针的授权。它不允许在没有信号时继续输出根因猜测。

### 2、最小化缩小嫌疑范围，多个假设避免过早认定原因

`Phase 2 — Reproduce + minimise` 先确认原始症状，再逐个删除输入、调用者、配置、数据或步骤，每删一项就重跑。出口是剩下每个元素都对失败不可缺少：删除其中任何一个，失败便不再出现。对于偶发失败，仍需依据复现率判断，不能把单次偶然通过当作已排除原因。

最小复现是下一阶段的输入，也可能成为最终回归测试的主体。原始场景仍须保留，因为修复后要重新验证完整路径，不能只验证被缩小过的案例。

来源：`skills/engineering/diagnosing-bugs/SKILL.md` → `Phase 3 — Hypothesise`，摘录开头与假设格式，省略后面的说明：

```markdown
Generate **3–5 ranked hypotheses** before testing any of them. Single-hypothesis generation anchors on the first plausible idea.

Each hypothesis must be **falsifiable**: state the prediction it makes.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."
```

模型先形成 3–5 个有排序、可证伪的假设，再测试其中任何一个。“如果是缓存失效问题，绕过缓存后症状应消失”具有可检验的预测；“可能是缓存有问题”只有猜测。这里的示例说明推理格式，不是在声称源码存在某个缓存 bug。

同节要求把排序展示给用户，便于用户用部署历史等领域知识纠正，但用户暂时不在时可按现有排序继续。这个反馈点不要求等待批准，也没有给修复前额外增加一个根因审批步骤。

### 3、每个探针对应一个预测，性能问题先测量

来源：`skills/engineering/diagnosing-bugs/SKILL.md` → `Phase 4 — Instrument`，摘录两处规则，中间省略工具偏好和日志标签说明：

```markdown
Each probe must map to a specific prediction from Phase 3. **Change one variable at a time.**

**Perf branch.** For performance regressions, logs are usually wrong. Instead: establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.
```

probe（探针）是用来区分假设的观测或干预。优先使用调试器或交互式检查，再在有区分力的位置添加日志；每次只改变一个变量，才能把反馈变化归因于该干预。临时日志要带唯一的 `[DEBUG-...]` 前缀，使后续可以完整检索并清除。

性能分支先记录计时、性能分析器或查询计划基线，再做二分定位。这里的输出是前后可比较的测量结果，不能以“日志看起来少了”替代。源码没有规定通用性能阈值，阈值仍需对应用户报告的回归和测量条件。

### 4、正确接缝决定能否留下可信回归测试

来源：`skills/engineering/diagnosing-bugs/SKILL.md` → `Phase 5 — Fix + regression test`，摘录缺失接缝分支与正常分支：

```markdown
**If no correct seam exists, that itself is the finding.** Note it. The codebase architecture is preventing the bug from being locked down. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimised repro into a failing test at that seam.
2. Watch it fail.
3. Apply the fix.
4. Watch it pass.
5. Re-run the Phase 1 feedback loop against the original (un-minimised) scenario.
```

“正确接缝”要能复现真实调用模式。一个需要多个调用者交错触发的 bug，不能靠只覆盖单个调用者的单元测试锁定；否则测试通过只是证明更浅的场景正常。

有正确接缝时，顺序清楚地连接了最小复现、失败测试、修复、通过结果与原始复现。没有正确接缝时，记录测试能力的缺口，不用无效测试制造覆盖假象。这也不等于免除验证：`Phase 6` 仍要求重跑原始反馈环，确认原始问题不再出现。

### 5、清理让诊断状态从临时证据变成交付证据

`Phase 6 — Cleanup + post-mortem` 的完成条件是：原始复现不再失败；回归测试通过，或接缝缺失已记录；带前缀的诊断日志全部移除；一次性原型删除或放入明确的调试位置；最终证实的假设写入提交或拉取请求说明。

这一步保留的是根因、验证依据和必要的测试，撤掉的是临时探针与实验代码。源码允许一次性原型迁入明确的调试位置，不能扩大成所有诊断材料必须删除。

同节在修复后才建议追问“什么能预防这个 bug”，必要时把具体架构问题交给 `/improve-codebase-architecture`。但该入口属于用户显式调用型，结合 `.agents/invocation.md`，这里应理解为带着证据推荐用户接续，不是诊断结束后自动启动架构扫描。缺失接缝、隐藏耦合等具体信息应进入交接，不能只留下“建议重构”。

## 四、HITL 模板到底执行了什么

### 1、两个函数把人工操作变成结构化输入

HITL 是 Human-in-the-loop（人工参与）。只有必须由人点击或观察的环节，诊断指令才把 `scripts/hitl-loop.template.sh` 作为最后的替代方式。与前面的 Markdown 不同，这个文件确实是 Bash 脚本。

来源：`skills/engineering/diagnosing-bugs/scripts/hitl-loop.template.sh` → `step()`、`capture()`。省略文件头和后续调用；以下两处中文注释为本文补充，函数代码保持原文。

```bash
set -euo pipefail

step() {
  # 显示一条操作说明，等待终端输入一行后继续。
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  # 采集单行回答，将其写入第一个参数指定的变量。
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}
```

`step` 的输入是一段操作说明，结果是等待用户按 Enter；它不会检查用户是否真的完成操作。`capture` 接收变量名和问题，读一行回答，再用 `printf -v` 赋给指定变量。变量名来自脚本写作者，因此配套调用可以用 `ERRORED`、`ERROR_MSG` 保存两次观察。

`set -euo pipefail` 约束的是命令失败、未定义变量和管道错误，不判断业务症状。模板中的直接 `read` 遇到输入结束可能让脚本退出，也没有保存进度再恢复的机制；它需要一个用户能够继续输入的终端。

### 2、输出是观察记录，没有自动判定器

来源：同文件 → 末尾输出语句，前面的人工操作与采集调用省略：

```bash
printf '\n--- Captured ---\n'
printf 'ERRORED=%s\n' "$ERRORED"
printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
```

脚本把变量打印成 `KEY=VALUE`，供 agent 读取。`ERRORED=y` 不会自动变成非零退出码，`ERROR_MSG` 也不经过错误分类或脱敏函数。所谓“反馈环变红”仍需模型依据用户回答和明确的症状条件判断，不能把脚本执行成功等同于 bug 已修复。

模板只采集单行文本；回答类型、必填性和有效值都未校验。输入和最终输出还会进入终端记录。文件头因此要求只采集观察结果，登录等敏感操作留给用户作为 `step` 完成。若自编诊断脚本需要稳定的机器判定，应另外定义输入校验、判定条件和退出码；这些能力并未随模板提供。

## 五、使用与编写时要补上的交付边界

### 1、先审查后提交，可能让审查漏掉刚写的代码

`implement` 要求“调用审查，再提交”，而审查读取的对象来自另一段指令。来源：`skills/engineering/code-review/SKILL.md` → `1. Pin the fixed point`，摘录：

```markdown
Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.
```

这个比较只到 `HEAD`，不包含暂存区和工作区里尚未提交的修改。如果实现阶段没有中间提交，刚写的实现不会出现在审查输入中；如果分支此前已有提交，审查甚至可能顺利完成，却只覆盖旧变更。这是两份指令组合后留下的范围缺口。

使用时需要明确让待审代码成为审查输入：可以先形成待审提交，再按确定基线审查；也可以在自编流程中显式扩展审查范围以包含未提交差异。两种做法都属于对现有协议的调整，不能说本版本已经自动处理。

### 2、测试通过、审查完成与票据关闭不能互相替代

`implement` 没有规定发现审查问题后如何修复、重试几次、何时重新运行完整测试，也没有定义检查失败后的统一处置。它要求调用审查，不代表审查结果已经被解决。自编交付 skill 时，应把“拿到报告”和“处理阻塞交付的问题”分开定义，并明确后续改动需要哪些验证。

当前分支上的提交也不会自动关闭票据。前置 `to-tickets` 用完成状态决定后继工作是否可开始，若实现 skill 不更新该状态，就需要由用户或外部流程完成交接。代码、测试结果、审查发现和工作项状态是不同证据，不能只用一个“done”概括。

### 3、把最严格的完成条件放在最容易跳过的地方

这些 skill 最值得借鉴的写法，是把容易被模型略过的工作写成可观察的出口：`tdd` 要有失败测试，诊断第一阶段要有实际运行过、能命中特定症状的命令，清理阶段要能检索出并清除全部临时日志。它们仍需要模型遵循，但比“认真调试”“充分测试”更容易被使用者核对。

适用范围也要靠入口与正文共同表达。`diagnosing-bugs` 的描述覆盖一般报错和变慢，正文却是一套较重的困难诊断过程；自编版本如果希望先做轻量排查，应把升级条件写清，而不是假定模型会自行选择恰当深度。对已经有正确复现和明确原因的简单修复，可以复用已有证据；若使用该诊断 skill 并跳过阶段，仍应说明理由。
