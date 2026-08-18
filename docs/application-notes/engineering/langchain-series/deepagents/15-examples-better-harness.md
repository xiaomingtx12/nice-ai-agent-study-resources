---
sidebar_position: 17
sidebar_label: 15 Examples：better-harness 优化闭环
description: 拆解 examples/better-harness 如何限制可编辑 Harness 表面、生成候选版本、注入评测进程，并按 train 与 holdout 结果决定接受或丢弃。
---

# Deep Agents 源码解析 15：Examples 实战——better-harness 优化闭环

## 源码定位

> **阅读基线**：Deep Agents 0.6.12（`examples/better-harness/`）。
>
> - 实验模型与主循环：`examples/better-harness/better_harness/core.py` → `Surface`、`EvalCase`、`Variant`、`run_experiment()`
> - 候选注入与恢复：`examples/better-harness/better_harness/patching.py` → `build_baseline_variant()`、`build_variant()`、`patch_module_attrs()`、`workspace_override_context()`
> - 外层提案 Agent：`examples/better-harness/better_harness/agent.py` → `ProposerWorkspace`、`build_proposer_workspace()`、`load_candidate_values()`、`propose_variant()`
> - 评测进程：`examples/better-harness/better_harness/runners.py` → `PytestRunner.run_split()`、`HarborRunner.run_split()`、`build_runner()`

## 先给结论

`better-harness` 是一个“优化 Agent 的 Agent”：

- **外层 Agent** 读取允许公开的失败证据，修改声明过的 Harness Surface（可编辑表面）；
- **内层 Agent** 使用候选配置执行真实评测；
- **优化器** 比较当前版本和候选版本的 `train + holdout` 通过数，只在严格变好时接受。

```text
当前 Variant（变体）
  → 外层 Agent 在临时 proposer workspace 中修改 Surface
  → 读回候选值，生成候选 Variant
  → Runner 把候选注入评测进程
  → 分别运行 train / holdout
  → 候选综合通过数更高？──是──> 成为下一轮当前版本
                       └──否──> 丢弃，继续使用旧版本
```

它优化的是 Harness 配置和实现，不是某一次 Agent 输出。前文的 [14：Rubric 自评循环](14-rubric-self-evaluation-loop.md)处理“本次任务是否完成”；本篇处理“下一版 Agent 是否比上一版更好”。

## 这篇要回答的设计问题

Harness 优化最危险的地方是搜索空间太大、接受标准太松。`Surface` 只公开允许修改的配置和文件，`Variant` 记录一轮完整取值，Runner 负责把候选真实注入评测进程，接受规则则只认可重复的 train/holdout 结果。外层 Agent 可以提出改动，但不能绕过候选边界和评测门槛直接改写当前版本。

这套设计把“生成候选”和“接受候选”分开，也保留回滚依据。它仍然不是自动证明：评测集、注入过程和环境权限如果不可靠，优化器只会更快地放大错误标准。

## 源码地图

| 文件 | 负责什么 |
| --- | --- |
| `better_harness/core.py` | 实验配置、Surface、Variant、结果模型和主循环 |
| `better_harness/patching.py` | baseline 构造、模块属性替换、文件临时覆盖 |
| `better_harness/agent.py` | 外层 Agent、proposer workspace 和候选生成 |
| `better_harness/runners.py` | Pytest / Harbor 评测进程和结果工件 |
| `examples/deepagents_example.toml` | 一份可运行的实验配置样例 |

## 怎么跑

```bash
# 在 examples/better-harness 目录安装依赖
uv sync --extra dev

# 复制样例配置并修改为自己的 workspace、Surface 和 cases
cp examples/deepagents_example.toml my_experiment.toml

# 先验证配置，再启动优化
uv run better-harness validate my_experiment.toml
uv run better-harness run my_experiment.toml \
  --output-dir runs/my-harness \
  --max-iterations 3
```

一次实验至少需要：

1. `workspace_root`：内层 Agent 所在的目标工作区；
2. 至少一个 Surface：声明允许修改的目标和初始值；
3. `train` 与 `holdout` 用例：分别作为修改依据和泛化检查。

`scorecard` 是可选的独立评测集，只在 baseline 和最终 Variant 上运行，不参与中间轮次的接受判断。

## 一、把 Harness 建模成可搜索对象

### 1. Surface：限制外层 Agent 的搜索空间

`Surface` 不是抽象标签，而是一条可被候选值替换的真实配置边界：

```python
# `Surface`：一个可搜索 Surface 的完整字段
@dataclass(frozen=True)
class Surface:
    name: str
    kind: str
    target: str
    base_value: str
    filename: str
```

字段含义：

| 字段 | 作用 |
| --- | --- |
| `name` | 配置中的表面名称，如 `prompt`、`tools` |
| `kind` | `module_attr` 或 `workspace_file` |
| `target` | 真实注入目标，可能是 `module:attribute` 或相对文件路径 |
| `base_value` | 当前基线内容 |
| `filename` | proposer workspace 中供外层 Agent 编辑的文件名 |

示例配置暴露的 Surface 通常包括：

```text
prompt                     # 默认提示词
tools                      # 工具实现文件
skills                     # Skill 文件
middleware implementation  # 中间件实现
middleware registration    # 中间件接线位置
```

这组边界很关键：外层 Agent 只能搜索声明过的几个旋钮，不能直接修改整个目标仓库。Surface 越宽，搜索空间越大，候选的可解释性和回滚成本越差。

### 2. EvalCase：把评测任务变成可渲染的 ID

```python
# `EvalCase.render()`：用例按模型名渲染 pytest 或 Harbor 的具体任务 ID
@dataclass(frozen=True)
class EvalCase:
    case_id: str
    split: str
    stratum: str

    def render(self, *, model: str) -> str:
        return self.case_id.format(model=model)
```

`case_id` 可以包含 `{model}` 占位符。同一份测试定义可以按实验配置渲染成不同模型的节点 ID；`split` 决定用途，`stratum` 决定类别覆盖。

### 3. Variant：一轮完整的 Surface 取值

```python
# `Variant.attr_overrides()`、`Variant.file_overrides()`：Variant 将 Surface 转成两类注入字典
@dataclass(frozen=True)
class Variant:
    label: str
    model: str
    changed_surfaces: tuple[str, ...]
    surfaces: dict[str, Surface]
    values: dict[str, str]

    def attr_overrides(self) -> dict[str, str]:
        return {
            surface.target: self.values[name]
            for name, surface in self.surfaces.items()
            if surface.kind == "module_attr"
        }

    def file_overrides(self) -> dict[str, str]:
        return {
            surface.target: self.values[name]
            for name, surface in self.surfaces.items()
            if surface.kind == "workspace_file"
        }
```

`Variant` 是评测真正要运行的配置快照。外层 Agent 修改的是 workspace 文件，Runner 使用的是 Variant 的 `attr_overrides()` 和 `file_overrides()`。

## 二、baseline、候选和起点值

优化不能从“空配置”开始。`build_baseline_variant()` 直接用每个 Surface 的 `base_value` 构造 baseline：

```python
# `build_baseline_variant()`：baseline 的每个值都来自 Surface 的起点
def build_baseline_variant(experiment: Experiment) -> Variant:
    values = {
        name: surface.base_value
        for name, surface in experiment.surfaces.items()
    }
    return Variant(
        label="baseline",
        model=experiment.model,
        changed_surfaces=(),
        surfaces=experiment.surfaces,
        values=values,
    )
```

配置中的起点可以来自：

- `base_value`：把内容直接写进 TOML，适合短提示词或小段工具实现；
- `base_file`：从现有文件读取，适合较长的实现文件。

候选是否真的改过 Surface，由值和基线比较决定：

```python
# `build_variant()`：只有值不同的 Surface 才进入 changed_surfaces
def build_variant(
    *,
    experiment: Experiment,
    label: str,
    values: dict[str, str],
) -> Variant:
    changed_surfaces = tuple(
        sorted(
            name
            for name, surface in experiment.surfaces.items()
            if values[name] != surface.base_value
        )
    )
    return Variant(
        label=label,
        model=experiment.model,
        changed_surfaces=changed_surfaces,
        surfaces=experiment.surfaces,
        values=values,
    )
```

因此，外层 Agent 没有真正改动时，`proposal.changed_surfaces` 为空，主循环会停止，不会为“没有变化”的候选浪费评测成本。

## 三、外层 Agent 如何提出候选

### 1. 每轮先建立 proposer workspace

`build_proposer_workspace()` 会创建一个按迭代编号隔离的临时目录，写入：

- 当前 Variant 的每个 Surface 文件；
- `surface_manifest.json`，记录 `kind`、真实 `target` 和文件位置；
- 当前可见的 train 结果、失败工件和历史产物；
- `task.md` 与 `proposal.md`。

源码中，Surface 文件和 manifest 的写入位于 `build_proposer_workspace()`：

```python
# `build_proposer_workspace()`：将当前值写成外层 Agent 可编辑的文件
surface_files: dict[str, Path] = {}
manifest: dict[str, dict[str, str]] = {}
for name, surface in experiment.surfaces.items():
    path = current_dir / surface.filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(current.values[name])
    surface_files[name] = path
    manifest[name] = {
        "kind": surface.kind,
        "target": surface.target,
        "file": str(path.relative_to(root)),
    }

(root / "surface_manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n"
)
_write_train_artifacts(
    experiment=experiment,
    train_result=train_result,
    root=root,
)
_write_visible_history(layout=layout, root=root)
_copy_prior_visible_artifacts(layout=layout, root=root, iteration=iteration)
_write_task_file(
    experiment=experiment,
    current=current,
    train_result=train_result,
    root=root,
)
```

外层 Agent 编辑的是这个临时工作区，不是目标仓库。可见信息主要是当前 Surface 和 train 失败证据；holdout 的失败细节不会写入 proposer workspace。

### 2. 读回文件，构造 Candidate Variant

```python
# `load_candidate_values()`：外层 Agent 编辑结束后，从 workspace 读回候选值
def load_candidate_values(
    *,
    current: Variant,
    workspace: ProposerWorkspace,
) -> dict[str, str]:
    values = dict(current.values)
    for name, path in workspace.surface_files.items():
        values[name] = path.read_text().strip()
    return values
```

`propose_variant()` 随后比较新旧值，创建 `Proposal` 和候选 `Variant`，并把 `result.json` 写回 workspace。这个文件保存候选值、变更 Surface、提案摘要和外层 Agent 的最终消息，是一轮优化的可重放证据。

外层 Agent 本身由 `create_deep_agent()` 构造，文件 Backend（后端）指向 proposer workspace。这样它可以用文件工具读取失败案例和编辑 Surface，但修改范围由 workspace 中暴露的文件决定。

## 四、候选如何进入评测进程

`kind` 决定候选值的落地方式。

### `module_attr`：进程内替换模块属性

```python
# `patch_from_env()`、`patch_module_attrs()`：从 Variant 文件加载并替换 module:attribute
def patch_from_env() -> None:
    raw_path = os.environ.get(VARIANT_ENV)
    if not raw_path:
        return
    variant = Variant.load(Path(raw_path))
    patch_module_attrs(variant.attr_overrides())

def patch_module_attrs(overrides: dict[str, str]) -> None:
    for target, value in overrides.items():
        module_name, separator, attribute = target.partition(":")
        if not separator:
            msg = f"invalid module_attr target {target!r}; expected module:attribute"
            raise ValueError(msg)
        module = importlib.import_module(module_name)
        setattr(module, attribute, value)
```

Runner 把 Variant 文件路径放进环境变量，并通过 `sitecustomize.py`（Python 启动时自动加载的脚本）触发 `patch_from_env()`。

它适合替换默认提示词或其他模块级配置，但有一个重要限制：如果目标代码已经把原属性复制到另一个变量，后续 `setattr()` 不会追溯修改那个副本。

### `workspace_file`：临时覆盖文件并恢复

```python
# `workspace_override_context()`：评测期间覆盖文件，退出后恢复原内容
@contextlib.contextmanager
def workspace_override_context(
    workspace_root: Path,
    overrides: dict[str, str],
) -> Iterator[None]:
    backups: dict[Path, str | None] = {}
    try:
        for relative_path, value in overrides.items():
            target = workspace_root / relative_path
            backups[target] = target.read_text() if target.exists() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
        yield
    finally:
        for target, original in backups.items():
            if original is None:
                if target.exists():
                    target.unlink()
            else:
                target.write_text(original)
```

这种方式适合工具、Skill、中间件实现和 Agent 注册代码。它提供的是可恢复的临时覆盖，不是安全沙箱；候选代码仍会在评测进程中执行。

“中间件实现”和“中间件注册”通常要拆成两个 Surface：只改实现文件但不改注册位置，候选代码可能根本没有进入 `create_agent()` 的中间件列表。

## 五、Runner 如何运行一组 split

以 `PytestRunner.run_split()` 为例，一次 split 执行包含这些边界：

1. 将 Variant 保存到当前运行目录；
2. 准备 `sitecustomize.py`、`PYTHONPATH` 和 Variant 环境变量；
3. 在 `workspace_override_context()` 中应用文件覆盖；
4. 为该 split 的每个 `EvalCase` 渲染真实 case ID；
5. 启动独立 pytest 子进程；
6. 保存 stdout、stderr、JUnit、summary 和 trace 引用；
7. 退出覆盖上下文，恢复目标工作区。

核心调用位于 `PytestRunner.run_split()` 和 `HarborRunner.run_split()`。这说明 better-harness 不是对候选文本做静态打分，而是让候选配置真实加载后再运行内层 Agent。

`PytestRunner` 通过配置中的 `project_root`、`model_flag` 和 `summary_flag` 调用 [16：Evals 评测体系](16-deepagents-evals.md)。因此两篇文章的分工是：

- 13 篇定义“如何判断一次 Agent 运行是否通过”；
- 12 篇负责“如何反复替换 Harness，再用这把尺子选择更好的版本”。

## 六、train、holdout 和 scorecard 的边界

| split | 外层 Agent 能看到失败细节 | 是否参与每轮接受 | 用途 |
| --- | --- | --- | --- |
| `train` | 是 | 是 | 提供修改依据 |
| `holdout` | 否 | 是 | 检查未见用例，防止只针对 train 修补 |
| `scorecard` | 否 | 否，只测 baseline 和 final | 读取最终泛化表现 |

这里有两个容易误读的地方：

- `holdout` 不可见，不代表不参与选择。它的通过数仍被纳入每轮接受判断；
- `scorecard` 不参与迭代，才更接近真正独立的最终读数。

`validate_experiment()` 还会强制：

- `train` 和 `holdout` 都至少有一个用例；
- 两者覆盖相同的 `stratum`（分层类别）；
- 渲染后的 case ID 全局唯一。

如果 train 测工具调用、holdout 测记忆能力，两者即使数量相同也不具备可比性；相同 stratum 约束就是为了避免这种配置错误。

## 七、主循环和接受规则

`run_experiment()` 的顺序是：

```text
构造 baseline
  → 跑 baseline train / holdout
  → 当前版本未全通过时，调用外层 Agent 提案
  → 没有 changed_surfaces：停止
  → 跑候选 train / holdout
  → 比较当前与候选的综合通过数
  → 接受或丢弃
  → 接受则候选成为下一轮 current，否则保留旧版本
  → 结束后可选运行 baseline / final scorecard
```

核心接受判断位于 `run_experiment()`：

```python
# `run_experiment()`：只有综合通过数严格提高才接受候选
current_combined = current_train.passed + current_holdout.passed
candidate_combined = train.passed + holdout.passed
accepted = candidate_combined > current_combined
reason = (
    "improved combined train + holdout pass count"
    if accepted
    else "did not improve combined train + holdout pass count"
)
candidate = CandidateEvaluation(
    variant=candidate_variant.key,
    proposal=proposal,
    train=train,
    holdout=holdout,
    accepted=accepted,
    reason=reason,
)
```

规则很简单，但含义不能省略：

- 候选和当前通过数相等，也会被拒绝；
- `train` 提升、`holdout` 下降时允许互相抵消；
- 所有用例默认一票一分，没有表达业务严重性、时延或成本；
- 多轮反复使用 holdout，会让 holdout 承受选择压力。

因此，生产实验不应只看综合通过数。可按业务需要增加 holdout 不得回退、分层加权、成本门槛、重复运行和真正不参与选择的 test split。

## 八、运行工件和可观测性

一次运行目录会保存：

- 实验 manifest 和 split manifest；
- 每一轮 proposer workspace；
- baseline、候选和最终 Variant；
- 每个 split 的 `result.json`；
- 每个 case 的 stdout、stderr、JUnit 和 summary；
- proposal、接受/拒绝原因和可用的 trace 引用。

这些本地工件才是实验的主要证据。LangSmith 链接只是附加观测，不应替代本地的 Variant、命令、环境和测试结果记录。

`reuse_existing=True` 可以复用已有 split 结果，但前提是运行目录、Variant key 和配置仍然对应。跨配置复用结果会把旧实验的证据混入新实验，导致接受判断失真。

## 九、工程判断

### 适合使用

- Prompt、工具、Skill 或 Middleware 有明确可编辑边界；
- 能把改动结果转成真实评测；
- 需要保留每轮候选、证据和回滚信息；
- 接受“外层 Agent 负责提出候选，人或规则负责最终筛选”。

### 不适合直接使用

- 没有稳定评测集，只能凭主观感觉接受修改；
- Surface 直接覆盖整个仓库，候选范围失去约束；
- 把 `holdout` 当作完全独立的最终测试集；
- 把临时文件恢复误当成恶意代码隔离；
- 候选 Middleware 或 Tool 代码会接触生产凭证、网络和真实数据。

### 这套设计真正提供的能力

`better-harness` 提供的是一个**可回滚的候选搜索框架**，不是自动证明 Agent 变正确了。它把“改 Harness”拆成四个可检查的环节：

```text
允许改什么
  → 候选如何提出
  → 候选如何真实加载
  → 什么标准下接受
```

这四个边界有一个不清楚，优化结果就只能当作一次不可复现的 prompt 尝试。

**相关配置**：`examples/deepagents_example.toml`
