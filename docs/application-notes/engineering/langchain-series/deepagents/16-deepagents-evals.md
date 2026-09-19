---
sidebar_position: 18
sidebar_label: 16 Evals 评测体系
description: 拆解 libs/evals 评测套件：轨迹记录、正确性与效率评分、CLI 运行、报告聚合、能力分类和 Harbor 失败归因。
---

# Deep Agents 源码解析 16：Evals 评测体系

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/evals/`）。评测包 `deepagents-evals` 自身版本为 0.0.1（`libs/evals/pyproject.toml:3`），与 SDK 0.6.12 不同。
> 源码版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 评测执行与轨迹：`libs/evals/tests/evals/utils.py` → `run_agent()`、`AgentTrajectory`、`TrajectoryScorer`
> - pytest 报告：`libs/evals/tests/evals/pytest_reporter.py` → `pytest_sessionfinish()`
> - CLI 子命令：`libs/evals/deepagents_evals/cli.py` → `_cmd_run()`、`_cmd_trials()`、`_cmd_aggregate()`、`_cmd_radar()`、`_cmd_catalog()`
> - 雷达图生成：`libs/evals/deepagents_evals/radar.py` → `generate_radar()`、`generate_individual_radars()`
> - Harbor 失败归因：`libs/evals/deepagents_harbor/failure.py` → `FailureCategory.is_infrastructure`

[15 篇](15-examples-better-harness.md) 讲如何用评测结果改进 Harness。本篇往前追一层，回答四个问题：

1. 一次 Agent 运行记录了什么？
2. 哪些条件会让测试失败？
3. 效率指标如何进入报告？
4. 多次试验、雷达图和 Harbor 失败分类分别解决什么问题？

核心链路是：

```text
评测用例
  -> run_agent()
  -> AgentTrajectory
  -> TrajectoryScorer
  -> pytest_reporter.py
  -> JSON / LangSmith / 雷达图
```

这里的评测（eval）不是只检查最终文本。它让真实模型在真实 Harness 配置下完成一个任务，同时保存工具调用、工具结果和文件状态，再分别衡量正确性与效率。

## 二、评分基于什么证据

`AgentTrajectory` 从最终返回的消息和文件状态提取动作、观察与答案。它比最终文本提供更多证据，但不会自动包含子代理内部过程、远程任务轨迹或外部系统副作用；需要这些信息时，应另存 trace 并查询业务系统。

正确性断言决定测试是否通过，效率断言只提供优化方向，两者不合并成一个总分。

Harbor 适配层提供失败分类，帮助报告区分运行故障与任务未完成。是否排除某类结果、如何确定统计分母，需要由具体报告与实验规则明确；分类标签本身不会自动改变所有评测的分数。

## 三、运行结果怎样成为评测依据

一条评测用例给出用户任务、初始文件和评分条件。`run_agent()` 执行 Agent，`_trajectory_from_result()` 再从返回状态整理出 `AgentTrajectory`（动作、观察和文件组成的运行记录）。`TrajectoryScorer` 是应用断言与记录效率期望的评分器；它不会替用例作者决定什么算正确。

这个顺序决定了证据范围。若文件存在于返回的 `files` 字段，评分器可以据此检查内容；若文件只存在于外部沙箱，或者关键动作发生在没有回传过程的子代理中，就需要额外查询。轨迹缺少某条记录，不能直接推断对应动作没有发生。

## 四、评测用例：把任务、分类和评分放在一起

`tests/evals/test_file_operations.py` 中的一个真实用例如下：

```python
@pytest.mark.eval_tier("baseline")
@pytest.mark.eval_category("file_operations")
@pytest.mark.langsmith
def test_read_file_seeded_state_backend_file(model: BaseChatModel) -> None:
    """读取预置文件并回答问题。"""
    agent = create_deep_agent(model=model)
    run_agent(
        agent,
        model=model,
        initial_files={"/foo.md": "alpha beta gamma\none two three four\n"},
        query="Read /foo.md and tell me the 3rd word on the 2nd line.",
        # 第 1 步读取文件，第 2 步回答问题；只允许 1 次工具调用请求。
        scorer=TrajectoryScorer()
        .expect(agent_steps=2, tool_call_requests=1)
        .success(final_text_contains("three", case_insensitive=True)),
    )
```

这个用例同时表达了三层信息：

- `eval_tier("baseline")`：属于回归闸门。它描述已有能力是否退化。
- `eval_category("file_operations")`：按能力域分组，后续用于过滤和统计。
- `langsmith`：要求这次运行被 LangSmith（追踪与实验平台）记录。

`model` 是 pytest 的 fixture（夹具），由 `conftest.py` 根据命令行的 `--model` 创建。测试没有把模型写死，因此同一个用例可以比较不同模型，但每次运行必须显式说明使用哪个模型。

以上例为准，正确性条件是最终文本包含 `three`，效率期望是两步、一次工具请求。若模型重复读了两次文件后答对，正确性仍可通过，效率指标会反映额外调用；若只用一步答成 `four`，即使过程更短，也会因正确性断言失败而失败。

这个例子还暴露了断言的覆盖范围：包含 `three` 不等于整段答案都正确，也不证明每次工具访问都符合权限。评测作者要根据任务增加文件内容、实体归属或其他断言，不能期待 `TrajectoryScorer` 自动推导业务标准。

## 五、`run_agent`：把一次运行变成轨迹

### 1. 轨迹的数据结构

`tests/evals/utils.py` 没有只保存最后答案，而是把 Agent 的消息流整理成两个层次：

```python
@dataclass(frozen=True)
class AgentStep:
    index: int
    action: AIMessage              # Agent 这一步的模型输出，可能包含工具调用
    observations: list[ToolMessage]  # 对应工具调用返回的结果


@dataclass(frozen=True)
class AgentTrajectory:
    steps: list[AgentStep]
    files: dict[str, str]           # 运行结束后的文件状态

    @property
    def answer(self) -> str:
        # 最后一步的文本才是最终答案
        return self.steps[-1].action.text
```

因此一条轨迹至少包含：

- 每一步 Agent 输出了什么；
- 每一步请求了哪些工具；
- 工具返回了什么观察结果；
- 运行结束后文件是什么状态；
- 最后一步文本是什么。

这让评测能够检查文件修改、工具选择和调用次数，而不是把所有问题都压缩成“最终答案是否包含某个词”。

### 2. `run_agent` 的执行顺序

`run_agent` 的关键路径只有几步，但每一步都对应评测契约：

```python
def run_agent(
    agent: CompiledStateGraph[Any, Any],
    *,
    query: str | list[AnyMessage],
    model: BaseChatModel,
    initial_files: dict[str, str] | None = None,
    scorer: TrajectoryScorer | None = None,
    thread_id: str | None = None,
    eval_metadata: dict[str, object] | None = None,
    extra_state: dict[str, Any] | None = None,
) -> AgentTrajectory:
    # 将问题、预置文件和额外状态组装成 invoke 输入
    invoke_inputs = _build_invoke_inputs(query, initial_files, extra_state)

    if thread_id is None:
        thread_id = str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    # 先记录模型和用例元数据，再调用 Agent
    logged_inputs = _build_logged_inputs(model, eval_metadata)
    _log_run_inputs(logged_inputs)
    result = agent.invoke(invoke_inputs, config)
    t.log_outputs(result)

    trajectory = _trajectory_from_result(result)
    if scorer is not None:
        _assert_expectations(trajectory, scorer)
    return trajectory
```

这里有三个值得保留的设计：

1. `initial_files` 通过输入状态注入，评测可以稳定复现文件场景。
2. 没有传入 `thread_id` 时自动生成 UUID，避免不同用例共享会话状态。
3. 先记录输入，再记录输出，最后评分，LangSmith 中能把一次评测和它的模型、元数据、轨迹对应起来。

## 六、`TrajectoryScorer`：正确性是门槛，效率是仪表

### 1. 两类断言不能混在一起

`TrajectoryScorer` 明确分成两组：

```python
@dataclass(frozen=True)
class TrajectoryScorer:
    _success: tuple[SuccessAssertion, ...] = ()
    _expectations: tuple[EfficiencyAssertion, ...] = ()

    def success(self, *assertions: SuccessAssertion) -> TrajectoryScorer:
        # 正确性断言：不满足时让测试失败
        return TrajectoryScorer(
            _success=(*self._success, *assertions),
            _expectations=self._expectations,
        )

    def expect(
        self,
        *,
        agent_steps: int | None = None,
        tool_call_requests: int | None = None,
        tool_calls: list[ToolCall] | None = None,
    ) -> TrajectoryScorer:
        # 效率断言：写入反馈，但不会让测试失败
        new: list[EfficiencyAssertion] = []
        if agent_steps is not None:
            new.append(AgentSteps(n=agent_steps))
        if tool_call_requests is not None:
            new.append(ToolCallRequests(n=tool_call_requests))
        if tool_calls is not None:
            new.extend(tool_calls)
        return TrajectoryScorer(
            _success=self._success,
            _expectations=(*self._expectations, *new),
        )
```

`success()` 里的 `final_text_contains`、`file_equals` 等属于正确性断言（success assertion，满足才算完成）。失败时会调用 `pytest.fail`，并把轨迹摘要附在错误信息后面。

`expect()` 里的步数、工具调用数属于效率断言（efficiency assertion，记录行为成本）。即使 Agent 多走了一步，测试仍然可以通过，但报告会记录实际值与期望值。这样做是有意的：

- 正确性用于阻断回归；
- 效率用于比较优化空间；
- 不把“做对但多走了一步”直接当成“功能错误”。

### 2. 评分时到底记录什么

评分器会把实际步数和工具调用次数写入 LangSmith 反馈，再执行硬性的正确性检查：

```python
def _assert_expectations(
    trajectory: AgentTrajectory,
    scorer: TrajectoryScorer,
) -> None:
    # 效率结果先记录，效率断言永远不会直接失败测试
    eff_result = _log_efficiency(trajectory, scorer)
    if eff_result is not None and _on_efficiency_result is not None:
        _on_efficiency_result(eff_result)

    # 正确性检查失败时才阻断测试
    success = True
    for assertion in scorer._success:
        if not assertion.check(trajectory):
            success = False
            t.log_feedback(key="correctness", value=0)
            pytest.fail(
                f"success check failed: {assertion.describe_failure(trajectory)}\n\n"
                f"trajectory:\n{trajectory.pretty()}",
                pytrace=False,
            )
    if success:
        t.log_feedback(key="correctness", value=1)
```

一次用例的 `correctness` 是二元结果：任一正确性断言失败就记录 0，全部通过记录 1。它不表示该用例的断言通过比例；会话报告再用通过用例数除以执行用例数，得到汇总正确率。没有配置 success 断言时也会走到 1，因此必须检查用例是否真的声明了任务条件。

## 七、运行前置：评测缺模型或缺追踪就不开始

`tests/evals/conftest.py` 在 pytest 的配置阶段做两道 fail-fast（快速失败）检查：

```python
tracing_enabled = any(
    os.environ.get(var, "").lower() == "true"
    for var in (
        "LANGSMITH_TRACING_V2",
        "LANGCHAIN_TRACING_V2",
        "LANGSMITH_TRACING",
        "LANGCHAIN_TRACING",
    )
)
if not tracing_enabled:
    pytest.exit(
        "Aborting: LangSmith tracing is not enabled. ...",
        returncode=1,
    )

if not config.getoption("--model"):
    pytest.exit(
        "Aborting: --model is required. Pass an explicit model identifier, ...",
        returncode=1,
    )
```

检查发生在测试收集（test collection，pytest 准备测试项）之前。缺少条件时整个评测套件立即退出，不会出现跑了一部分用例后才发现结果无法追踪的情况。

常用运行方式：

```bash
# 在 libs/evals 目录下执行
LANGSMITH_TRACING=true \
uv run deepagents-evals run \
  --model claude-sonnet-4-6 \
  --eval-category memory \
  --evals-report-file report.json
```

`--model` 不是可选的默认配置。评测比较的是“模型 + Harness + 工具和中间件配置”的组合，不写模型就无法解释分数属于谁。

## 八、报告与 CLI：从单次运行到多次聚合

### 1. 单次运行的报告内容

`pytest_reporter.py` 在会话结束时生成 JSON 报告，核心字段来自同一条轨迹和测试结果：

```python
correctness = round(
    (_RESULTS["passed"] / _RESULTS["total"]) if _RESULTS["total"] else 0.0,
    2,
)
step_ratio = _micro_step_ratio()
tool_call_ratio = _micro_tool_call_ratio()
solve_rate = _solve_rate()

category_scores: dict[str, float] = {}
for cat, counts in sorted(_CATEGORY_RESULTS.items()):
    if counts["total"] > 0:
        category_scores[cat] = round(
            counts["passed"] / counts["total"],
            2,
        )

payload: dict[str, object] = {
    "model": session.config.getoption("--model"),
    **_RESULTS,
    "correctness": correctness,
    "category_scores": category_scores,
    "step_ratio": step_ratio,
    "tool_call_ratio": tool_call_ratio,
    "solve_rate": solve_rate,
    "median_duration_s": median_duration_s,
    "failures": _FAILURES,
}
```

这些字段各自回答不同问题：

- `correctness`：全部评测的总体正确性；
- `category_scores`：某个能力分类是否退化；
- `step_ratio`、`tool_call_ratio`：相对期望行为的步骤和工具调用成本；
- `solve_rate`：在同时提供 `expected_steps` 与 `duration_s` 的用例中，通过者贡献 `expected_steps / duration_s`，失败者贡献 0，再取均值（`pytest_reporter.py:84-104 → _solve_rate()`）。它是按期望步数归一化的处理速度，不能解释为完成率；
- `median_duration_s`：运行耗时的中位数；
- `failures`：失败用例及失败信息。

注意 `pytest_sessionfinish` 会在“确实执行过测试但有用例失败”时把 pytest 的退出状态改为 0，让 CI（持续集成）继续执行报告和聚合步骤。没有测试被执行、配置错误或 pytest 内部错误不会被这样处理（`pytest_reporter.py:342-354`）。生产发布门禁必须解析报告中的失败项与关键分类，不能只检查评测命令的进程退出码。

`step_ratio` 使用“实际步数之和 / 期望步数之和”，不是每条用例比例的简单平均。例如两条用例的期望步数为 2、8，实际为 4、8，汇总比例为 12/10=1.2，而非 (2+1)/2=1.5。没有设置期望步数的用例不进入这项统计；没有有效分母时返回 None，不应当作 0。

这套口径给长任务更大的权重。比较两份报告时，应确保用例集合与期望值一致；否则比例下降也可能来自换了一批更宽松的基线。工具调用比例遵循同样的求和口径。

`_trajectory_from_result()`（`utils.py:1002-1037`）遍历最终返回的 `result['messages'][1:]`，把 `AIMessage` 组成步骤，把后续 `ToolMessage` 归入观察，文件来自 `result.get('files')`。这不是执行期间的完整事件录制。正常摘要主要改请求视图，State 中的历史可能仍在；如果其他机制已经改写或移除消息，轨迹无法还原被替换内容。同步子代理未回传的内部消息、远程任务过程以及外部文件系统，也不会自动出现在这份对象里。涉及安全顺序、外部副作用和长任务时，还要保存原始 trace 并查询实际业务状态。

固定模型响应可以复现编排故障，真实模型的重复试验可以观察质量波动，两者都需要最终产物断言。把越权动作、参数约束和必要前置条件放进硬正确性断言，不能只用 `expect(tool_calls=...)` 记录；同一个工具名可带不同订单、金额或租户，顺序对也不代表参数和最终账实正确。

### 2. CLI 子命令的边界

`deepagents_evals/cli.py` 把运行、聚合和展示拆成独立命令：

| 子命令 | 作用 |
| --- | --- |
| `run` | 执行一次 pytest 评测并写报告 |
| `trials` | 同一模型运行多次，统计均值、中位数和标准差 |
| `aggregate` | 合并已有试验报告，适合 CI 并行结果汇总 |
| `radar` | 根据分类正确率生成雷达图 |
| `catalog` | 从测试源码重新生成评测目录 |
| `model-groups` | 生成模型分组表 |
| `list` | 查询分类、tier（分层）、模型和评测用例 |

单次命令的参数最终会被拼成 pytest 参数：

```python
cmd: list[str] = [
    "uv",
    "run",
    "--group",
    "test",
    "pytest",
    "tests/evals",
    "-v",
    "--tb=short",
    "--model",
    args.model,
]
if args.report:
    cmd.extend(["--evals-report-file", str(args.report)])
for cat in args.eval_category or []:
    cmd.extend(["--eval-category", cat])
for tier in args.eval_tier or []:
    cmd.extend(["--eval-tier", tier])
```

CLI 本身不重新实现评测逻辑，只负责参数校验、过滤条件传递和报告编排。这使 pytest 仍是执行真相源，CLI 只承担操作入口。

### 3. 为什么要跑多次

LLM（大语言模型）输出具有随机性。一次通过只能说明这次运行完成了任务，不能说明行为稳定。

`trials` 对同一个模型和同一组筛选条件执行多次，再聚合正确率、归一化处理速度、步骤比例、工具调用比例和耗时等指标。工程上应把：

- 单次报告当作轨迹证据；
- 多次聚合当作稳定性信号；
- 基线与 hillclimb（爬坡评测）当作不同用途的样本。

[15：Examples——better-harness 优化闭环](./15-examples-better-harness.md)已经讨论 `train`、`holdout` 和 scorecard（评分卡）的 Harness 优化流程。本篇只关注这些运行结果如何被记录和聚合，不再重复那套划分。

## 九、分类和雷达图：只把模型能力放进能力图

`categories.json` 当前定义 8 个评测分类：

```text
file_operations, retrieval, tool_use, memory,
conversation, summarization, unit_test, langchain/middleware
```

其中 `radar_categories` 只保留 6 个能力分类：

```python
ALL_CATEGORIES: list[str] = _categories_raw["categories"]
EVAL_CATEGORIES: list[str] = _categories_raw.get(
    "radar_categories",
    _categories_raw["categories"],
)
```

`unit_test` 用于验证 SDK（软件开发工具包）管道，不代表模型能力，因此不应该成为雷达图的一根轴。`langchain/middleware` 也属于实现行为分类，是否放进能力比较要看报告用途，不能把所有测试标签都当成模型能力。

当前评测目录由 `scripts/generate_eval_catalog.py` 从 `tests/evals/` 自动发现和生成。目录的价值是查覆盖范围，不是新的评分层；新增用例后应重新生成目录，而不是手工维护一份平行列表。

## 十、Harbor：先排除环境失败，再解释模型失败

`deepagents_harbor/` 用于接入需要真实沙箱的基准，例如 Terminal Bench 2.0。它还提供 LangSmith 数据集、实验和反馈的桥接：

- `ensure_dataset` / `create_dataset`：准备评测数据集；
- `create_experiment`：执行一次实验并关联结果；
- `add_feedback`：把评分写回实验。

Harbor 中最容易误读的是失败归因。`deepagents_harbor/failure.py` 定义了：

```python
class FailureCategory(Enum):
    CAPABILITY = "capability"        # 模型答案或推理错误
    INFRA_OOM = "infra_oom"          # 内存不足，常见退出码 137
    INFRA_TIMEOUT = "infra_timeout"  # 超时，常见退出码 124
    INFRA_SANDBOX = "infra_sandbox"  # 沙箱、网络或环境错误
    UNKNOWN = "unknown"              # 无法确定原因

    @property
    def is_infrastructure(self) -> bool:
        return self in {
            FailureCategory.INFRA_OOM,
            FailureCategory.INFRA_TIMEOUT,
            FailureCategory.INFRA_SANDBOX,
        }
```

这个枚举表达分类结果，不单独证明根因。OOM 或超时可能由资源不足、异常输出或 Agent 无效循环引起，需要结合 trace 和执行日志判断。报告可以同时给出全流程完成率、排除已确认环境故障后的任务正确率，以及被排除的数量；否则仅删除失败样本可能掩盖部署问题。unknown 应保留为未归因结果。

## 十一、工程判断

一份可比较的报告需要绑定模型、Harness、任务输入、断言与统计口径。总体 correctness 相同的两个版本，可能在不同任务上失败；应保留逐用例结果，再看分类分布、额外调用和时延。

正确性断言应检查要求交付的事实。例如文件任务优先核对文件内容，结构化任务核对字段和实体，写入任务查询可信业务记录。只检查文本包含某个词，或只在 expect 中列出工具名，覆盖不了错误参数和错误实体。

效率指标适合判断优化方向，是否升级为硬预算由业务决定。发布门禁则应明确解析失败报告：本评测器可能为了继续汇总而将进程退出码改为 0，不能把命令正常退出作为所有用例通过的证明。

## 十二、延伸阅读

**下层：LangChain / LangGraph**

- [LangChain 07：调用治理](../langchain/07-call-governance.md)——轨迹与调用记录从哪里采集

**本系列**

- [15：Examples——better-harness 优化闭环](./15-examples-better-harness.md)——评测结果如何驱动 Harness 改动
- [14：Rubric 自评循环](./14-rubric-self-evaluation-loop.md)——离线评测与运行内自评的关系

**上层：方法论与案例**

- [Agent 系统设计 06：评测](../../../../notes/agent-system-design/06-observation/agent-evaluation.md)——正确性与效率分开度量的通用做法
