---
sidebar_position: 11
title: 10：测试与评测，怎样验收行为和审查质量
sidebar_label: 10：测试与评测
description: 沿当前测试断言、PostgreSQL 集成、Playwright 流程和 Reviewer 评测入口，解释样本来源、发布快照、评分算法与结论边界。
slug: /application-notes/engineering/deepagents应用案例解析/open-swe/testing-and-evaluation
---

# 10：测试与评测，怎样验收行为和审查质量

> 支撑机制。先看行为回归与部件交接；Reviewer 质量评测可在读完机器审查专题后回看。

验收 Open SWE 要分别回答三个问题：**程序是否遵守确定的业务规则，多个部件是否完成交接，模型发现的问题是否有用**。一个测试层通过，不能替代另外两层的证据。源码基线见[源码基线](../source-baseline.md)。

## 一、测试分层要看真实依赖，不能只看目录名

pytest 范围是 `tests/`、异步模式 `auto`。几个名字陷阱：

- **`integration_tests` 目标名存实亡**：Makefile 目标指向 `tests/integration_tests/`，但目录不存在，缺失分支只输出跳过消息——它不能当"集成测试已执行"的依据。
- **真正的数据库集成测试在普通测试树里**：`registry_db` fixture 依赖 `TEST_ANALYTICS_POSTGRES_URI`，缺变量就 skip；有变量时先创建并迁移**模板数据库，再为每条测试克隆**，覆盖 SQL、事务和迁移后的表结构。CI 的 `unit-tests` 作业提供 PostgreSQL 16——作业名叫 unit tests，不代表里面全是纯单元测试。
- **`test_daytona_integration.py` 不调 Daytona**：它向模块表注入伪造 SDK，检查适配器装配参数；`test_local_integration.py` 同样用桩检查构造参数。云服务可用性不能从文件名推得。
- **默认测试环境把自动审查开关替换成始终开启**：普通 webhook 测试走到 Reviewer 分派，不证明部署默认启用了审查。

替身的边界也写在 fixture 里：自动 fixture 拦截 `httpx`/`httpx2` 的真实 HTTP transport，拒绝外部主机和本机开发服务，保留 MockTransport 和 ASGITransport——**这是特定客户端边界上的防误连，不是进程级网络隔离**。`FakeStore` 保留 Store 的读写形状，不提供生产数据库的持久化保证。

## 二、关键回归把业务约束写成可观察的断言

沙箱初始化失败不能留下可用缓存（05 的发布顺序），断言直接看共享代理：

```python title="tests/sandbox/test_sandbox_publish_ordering.py（节选）"
assert not proxy.has_backend
assert not SANDBOX_BACKENDS[thread_id].has_backend
```

审批后必须推固定的提交（07 的指纹审批），断言比较最终命令字符串：

```python title="tests/agent/test_workflow_push_guard.py（节选）"
assert (
    pushed_command
    == "git -C /repo push origin aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/feature"
)
```

同类的还有：模型选型两次钩子只分类一次、分类器收到用户请求而非注入的人物信息、超时和低置信度回退（AsyncMock + MockTransport）；transcript 重放同一命令返回同一版本、同批重复 ID 只追加一次（真实数据库）；Reviewer 并发追加不同发现都保留、相同发现只建一次、旧快照抹不掉新增记录；发布后注册表写入失败不推进 `last_reviewed_sha`、不结算检查、重试不重复发空审查。

这一层的共同点：**断言的是副作用（缓存、命令、数据库行），不是"函数被调用过"**。

## 三、端到端检查交接，脚本化模型不承担能力评测

Playwright 套件用专用 LangGraph 配置启动真实入口：装载边界替身后导出**真实的** `openswe.server.traced_agent`，挂载真实的 `openswe.api.app`，初始化假 GitHub 的本地仓库。文件和 Git 操作有实际载体：沙箱指向临时目录的 local provider、`seed_bare_remotes()` 创建真实初始提交和裸仓库、读取推送分支的真实 Git diff 作为假 PR 的文件列表。

模型是 `FakeScriptedChatModel`——发出固定的工具序列；GitHub App 令牌和外部 HTTP 地址也被替换（`E2E_REAL_LLM` 可取消模型替换，但外部服务仍在边界外）。主场景从模拟 Slack 页面发任务，等同线程出现 PR 链接，再断言 PR 标题、分支和 `greet.py` 文件——它验证**请求接入、工具执行、本地交付、渠道回复之间的交接**。模型脚本已经知道要调哪些工具，所以它不能证明 Agent 理解未知需求。

一个明确的覆盖边界：浏览器套件的 LangGraph 配置注册了 `agent`、`chat`、`review-scout`、`scheduler`，**没有 `reviewer`**——PR 页面和人工审查场景不能当 Reviewer 完整图的端到端验收。

## 四、评测入口：CLI 与控制台共用一个 harness

命令行入口 `evals.reviewer.run_eval`：配置按"内置默认值 → `config.toml` → 环境变量 → 命令行"依次覆盖，从 LangSmith 数据集取样（`--limit` 取前 N 个，无分层抽样），然后：

```python title="evals/reviewer/run_eval.py（评测调用）"
results = await aevaluate(
    review_pr,
    data=data,
    evaluators=[judge_match],
    summary_evaluators=[aggregate_pr],
    experiment_prefix=experiment_prefix,
    max_concurrency=max_concurrency,
    num_repetitions=1,
)
```

每个样本只跑一遍（`num_repetitions=1`），没有重复实验估计波动。这条链会访问数据集、运行 Reviewer、调用评判模型并写回实验。

控制台入口 `/admin/evals/reviewer`（要求管理员）最终启动同一个 harness——在独立 LangSmith 沙箱里**按部署 commit 拉取源码**、安装锁定依赖、执行 `evals.reviewer.run_eval`，经配置的 LangGraph URL 调服务端 Reviewer；网络代理注入凭据，harness 不持真实密钥。按 commit 取 harness 意味着本地未提交修改不会进评测。过期判定：启动阶段容许 15 分钟，运行阶段心跳阈值 60 秒。

## 五、评分对象是发布快照，不是所有提出过的问题

golden 来源是 `withmartian/code-review-benchmark` 的 `e616e84` 标注刷新，仓库内副本为 50 个 PR、173 条参考评论。`build_dataset.py` 按每条 URL 用 `gh_pr_view()` 取当时的 base/head SHA 和标题，把参考评论放进 `outputs.golden_comments`；单条失败继续，所以本地 50 个不保证上传也是 50 个。

**SHA 保存了版本字段，但没冻结全部输入**：评测把样本 SHA 传给 Reviewer，可首次审查仍按 PR 编号读实时 GitHub diff 和实时标题正文；传入的 diff 会被直接写进沙箱，只有没传时才按 SHA 计算。所以不能沿用"上游 PR 漂移不影响评测"的绝对表述。

评分读的是发布快照而不是全部候选。评测试运行分支不碰 GitHub，把筛选结果写进线程元数据：

```python title="tools/publish_review.py（评测试运行发布，节选）"
publication = {
    "finding_ids": finding_ids,
    "findings": [finding for finding, _payload in eligible_with_payload],
    "severity_threshold": severity_threshold,
}

await set_reviewer_thread_metadata(
    thread_id,
    last_reviewed_sha=head_sha,
    extra={REVIEWER_EVAL_PUBLICATION_KEY: publication},
)
```

默认模式 `surfaced_findings` 从快照取文件、末行、描述、严重度——**评分没接收标题、建议代码、评论排版或总体 assessment**。快照缺失时目标函数返回空评论和 `publish_completed=False`，评分器不消费这个标志：有参考问题的样本会表现成全量漏报——**看分数必须同时看发布完成率，不能把基础设施未完成和模型没发现问题混为一谈**。诊断模式 `all_findings` 扫最终消息里的 `add_finding` 调用参数并去重，不检查工具返回是否成功——可能把被拒的候选也交给评判器。

## 六、评分算法：语义匹配 + 最优一对一配对

评判模型固定为 `anthropic:claude-opus-4-5`（经 LangSmith Gateway，与被评测的 Reviewer 模型无关）。`_judge_pair()` 只把候选与参考格式化后问"是否同一个问题"，不带源码和测试结果。候选先按文件、行号、规范化正文去重，然后评判全部"候选 × 参考"组合，最后求**一对一匹配**：

```python title="evals/reviewer/judge.py::_select_pairs"
def _select_pairs(matrix: list[list[PairResult]]) -> tuple[tuple[int, int], ...]:
    golden_count = len(matrix[0]) if matrix else 0

    @cache
    def _solve(
        candidate_index: int, matched_mask: int
    ) -> tuple[int, float, tuple[tuple[int, int], ...]]:
        if candidate_index >= len(matrix):
            return 0, 0.0, ()
        best = _solve(candidate_index + 1, matched_mask)
        for golden_index in range(golden_count):
            if matched_mask & (1 << golden_index):
                continue
            cell = matrix[candidate_index][golden_index]
            if not cell["match"]:
                continue
            count, confidence, pairs = _solve(
                candidate_index + 1, matched_mask | (1 << golden_index)
            )
            candidate = (
                count + 1,
                confidence + cell["confidence"],
                ((candidate_index, golden_index), *pairs),
            )
            if candidate[:2] > best[:2]:
                best = candidate
        return best

    return _solve(0, 0)[2]
```

这是一个位掩码动态规划：`matched_mask` 的每一位表示一条参考是否已被占用，**先最大化匹配数量，再最大化置信度之和**（元组比较先比数量）。所以同一个参考不会被多条同义候选重复计分。

匹配数为 TP、未匹配候选为 FP、未匹配参考为 FN，据此算 precision/recall/F1；汇总同时给 micro（累加 TP/FP/FN）和 macro（按 PR 平均）；F2 用 beta=2 计算，更偏重召回——上游排行榜主指标是 `core_micro_f2`。类别口径（本地 JSON 可核对分母）：`strict` 五类共 139 条参考，`core` 再加三类共 158 条，全量 173 条。类别指标用全量匹配的结果再按范围统计，不重新请求模型；`medium_plus_*` 在两侧筛严重度后对已有矩阵的子矩阵重新匹配。

两个解析边界：judge 返回无法解析的 JSON 时按 `match=False` 处理——评判故障会变成未匹配，不单独标"无法判定"；置信度只在匹配数量相同时参与选择，**没有"达到某置信度才计 TP"的规则**。语义匹配不等于缺陷被复现，未匹配候选也不自动是误报。

## 七、配置与费用限定结论

`config.toml`：数据集 `openswe-reviewer-v2`、并发 10、Reviewer 模型 `anthropic:claude-opus-5-5` 档位 `high`、输出模式 `surfaced_findings`、严重度阈值 `low`（控制台默认并发 5）。**阈值 `low` 覆盖线上 `publish_review` 的默认 `medium`**——同一 Reviewer 在评测和线上可能发布不同数量的问题，不记录阈值的话，指标比较会混入发布策略差异。

评测输入也不是线上配置的完整副本：跳过历史讨论、变更导读、组织指南、仓库风格和审批策略，仍从 `base_sha` 读根规则；评测提示要求不查询历史评论。这是提示层约束——"离线评测"指对固定样本独立评价，不断网。

费用按目标输出的线程 ID 到 Reviewer 的 LangSmith project 查询；只接受大于零的费用，等待后仍无值归 unpriced（**"未定价"可能含零值，不能当免费**）。这条链只统计 Reviewer 线程的 LLM 费用，不含沙箱、不含成对 judge 调用、不含失败重试——比较完整验收成本要另算总账。

---

上一篇：[09：运行记录与结算](./09-observability-and-validation.md)。下一篇：[11：机器审查](../03-review-and-merge/11-reviewer.md)。返回[系列导读](../index.md)。
