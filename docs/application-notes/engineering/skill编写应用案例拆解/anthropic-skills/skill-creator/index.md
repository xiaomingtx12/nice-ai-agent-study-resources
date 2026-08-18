---
sidebar_position: 1
title: "skill-creator：把 Skill 生产组织成评测闭环"
description: 从 Anthropic skill-creator 源码拆解 Skill 的入口分流、评测数据流、触发优化、打包边界和实现代价。
---

# skill-creator：把 Skill 生产组织成评测闭环

## 先看入口：主文件按当前状态分流

`skill-creator` 的产物不是业务文件，而是另一份 Skill 及其评测证据。`SKILL.md:9-27` 先给出创建、测试、反馈和迭代的循环；`SKILL.md:44-69` 再要求根据用户当前状态决定从意图采集、已有草稿评测还是快速讨论开始。

```text
从零创建
  → capture intent → research → 写 SKILL.md

已有草稿
  → 直接进入 eval / iterate

Skill 已完成
  → 单独优化 description 的触发率
```

这里的状态机不是程序状态机。它由模型读取 `SKILL.md` 后按对话上下文选择分支；真正执行评测、统计和打包的动作由 `scripts/` 完成。

## 一、任务质量评测的数据流

### 1. eval prompt 先于 assertion

`SKILL.md:140-160` 要求先把 2—3 个真实任务写进 `evals/evals.json`，运行开始后再补 assertions。eval 数据提供 prompt、预期结果和输入文件，assertion 负责定义可检查的结果。

这两个字段承担不同职责：prompt 保持任务真实，assertion 提供可验证性。把它们一起设计成“为了方便测试的例题”，会让评测结果只反映作者如何迎合断言。

### 2. with-skill 和 baseline

`SKILL.md:162-197` 要求同一轮启动带 Skill 的运行和 baseline。新建 Skill 使用 `without_skill`；修改已有 Skill 时，baseline 指向编辑前的快照。

这是流程约束，不是独立调度器已经提供的隔离保证。主文件要求宿主同时派发两类运行，后续脚本和 viewer 才能把它们按配置比较。

### 3. Grader 输出是下游接口

`agents/grader.md` 要求评分器读取 transcript 和实际输出文件，再为每条 expectation 写出证据。`SKILL.md:220-230` 固定 viewer 消费的字段：

```json
{
  "text": "输出包含可验证的标题",
  "passed": true,
  "evidence": "输出文件中的标题为……"
}
```

Grader 还会反查 assertion 是否弱到“文件存在”即可通过。它输出的不只是分数，还包括让分数可审查的证据。

### 4. Analyzer、Comparator 和 Viewer

- `agents/analyzer.md` 解释 benchmark 中恒通过、恒失败、高方差和成本变化；
- `agents/comparator.md` 对两版结果做盲比较，不让评分器知道版本身份；
- `eval-viewer/generate_review.py` 将输出、grading、benchmark 和人工反馈组织成可查看页面。

三个组件都消费运行结果，但它们分别承担单次验收、统计解释和版本判断。

## 二、触发优化：脚本实现的另一条链

任务质量评测结束后，description 进入独立的触发优化流程。

### 1. `run_eval.py` 测的是模型行为

`scripts/run_eval.py:44-67` 为 query 创建带 description 的临时 `.claude/commands/<name>-skill-<uuid>.md`；`:69-88` 启动 `claude -p`；`:127-167` 从 partial stream 或 assistant tool event 中判断是否调用目标 Skill 或读取它。

```python
if tool_name in ("Skill", "Read"):
    pending_tool_name = tool_name
...
if clean_name in accumulated_json:
    return True
```

临时 command 在 `:171-180` 清理。输入是 query 和 description，输出是单次触发布尔值；它不评价最终答案内容。

### 2. `run_loop.py` 的实际回分方式

`run_loop.py:23-43` 按 `should_trigger` 分层切分 train/test。`:85-99` 将两组 query 合并后调用 `run_eval()`，`:101-105` 再用 query 字符串集合把结果回分到 train/test。

这段实现有一个非显然边界：query 字符串是结果索引，不是稳定的 eval id。如果 eval 集中有重复 query，`query_items` 和 `train_queries_set` 会覆盖或误归类，尤其当相同文字分别出现在 train 与 test 时，测试结果可能被分到 train。当前代码没有为此建立独立 ID。

因此，源码能证明的是“它提供了分层切分和 held-out 选择”，不能进一步写成严格隔离的实验框架。

### 3. held-out 只参与选优，不参与改写

`:188-207` 将去掉 `test_` 字段的历史传给 `improve_description()`；`:215-240` 按 test score 选择 `best_description`。命令行默认 `runs_per_query=3`、`holdout=0.4`、`max_iterations=5`。

这里的设计价值在于改写模型看不到测试分数；但 query-key 回分边界意味着 held-out 的统计可靠性仍依赖 eval 集没有重复文字。

## 三、确定性脚本与交付边界

### frontmatter 校验

`quick_validate.py:11-93` 先读取 `SKILL.md`，再解析 YAML。当前允许的顶层字段为 `name`、`description`、`license`、`allowed-tools`、`metadata`、`compatibility`；name 检查 kebab-case 和 64 字符上限，description 检查尖括号和 1024 字符上限。

这是当前仓库脚本的校验集合，不应扩写成所有宿主的完整 Skill 规范。

### benchmark 聚合

`aggregate_benchmark.py:44-63` 计算 mean、stddev、min、max，再按配置汇总 pass rate、时间、tokens 和 tool calls。配置顺序参与 delta 计算；当前生成结果中的 `executor_model`、`analyzer_model` 可能仍是 `<model-name>` 占位值，不能写成真实模型版本已经自动记录。

### package_skill.py 只生成 ZIP

`package_skill.py:41-103` 先调用 `validate_skill()`，再写 `<skill-name>.skill`。`should_exclude()` 排除根级 `evals`、`__pycache__`、`node_modules`、`*.pyc` 和 `.DS_Store`。

```python
valid, message = validate_skill(skill_path)
if not valid:
    return None

with zipfile.ZipFile(skill_filename, "w", zipfile.ZIP_DEFLATED) as zipf:
    ...
```

它不安装、不注册，也不运行 Skill。`.skill` 是压缩交付物；临时 `.claude/commands` 是触发评测辅助路径，两者不属于同一层。

## 四、宿主能力改变的是流程，不是包格式

`SKILL.md:419-455` 分别说明 Claude.ai、Cowork 和 Claude Code 的退化路径：无 subagent 时串行，无浏览器时直接展示或生成静态 HTML，无 `claude -p` 时跳过 description 优化，无 `present_files` 时跳过呈现。

这些是宿主能力分支。它们解释为什么完整闭环不总能执行，但不能反过来证明 `.skill` 包包含某种注册机制。

## 五、代价与实现边界

这套实现把 Skill 质量拆成 prompt、运行、评分、统计和反馈，代价是每个 eval 要维护多个运行目录和结果文件，description 优化要重复调用模型，viewer 和 subagent 又引入额外环境依赖。

更重要的边界有三个：

1. 任务质量和触发质量是两条链，不能用一次最终回答替代；
2. held-out 选择存在 query 字符串索引缺陷，重复 query 会影响分组；
3. 没有稳定输出的主观任务可以保留人工反馈，不应强行制造定量 assertions。

`skill-creator` 的实现价值不在于把 `SKILL.md` 写长，而在于把 Skill 生产拆成多个可观察节点，再让每个节点留下下游可以消费的证据。
