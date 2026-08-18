---
sidebar_position: 14
description: "可观测性工程化技巧 —— 四支柱、回调拦截、token 拆分、trace_id 五源解析、PII 脱敏、事件队列 drain。"
---

# 可观测性篇

可观测性让生产 Agent 从"黑盒"变成"玻璃盒"。读这篇之前你应该已经了解 Agent 大脑 / Tool / Context 等核心机制——本篇聚焦"观测什么比怎么观测更重要"。

工程化的核心拉扯：透明度 ↔ 隐私 / 灵活性 ↔ 复杂度 / 实时性 ↔ 性能 / 观测覆盖面 ↔ 成本。

---

## 一、动机

可观测性是被动接收者，单向依赖。业务模块主动调用 `logEvent()` / `logForDebugging()` 等接口，可观测性不反向依赖业务模块。

本篇聚焦：
- 观测什么（Agent 比传统 Web 多一支柱：会话级 Transcript）
- 怎么观测（业务层埋点是反模式，装饰器 / 回调拦截）
- Token 成本拆分（cache_read / output / input 不能混算）
- trace_id 跨服务串联
- PII 脱敏（类型系统强制，不用正则自动检测）
- 事件队列 + 异步 drain（业务代码早于 sink 初始化）

---

## 二、关键判断速览

- Agent 比传统 Web 多一支柱：会话级可重放 Transcript
- 业务层手写埋点是反模式，必须用装饰器或回调拦截
- Token 成本必须区分 input / output / cache_read，混算账单高估 10 倍
- trace_id 五源解析（X-Trace-Id / query / body / OTel 上下文 / W3C `traceparent`）才能覆盖所有客户端
- 业务代码早于 sink 初始化时，按延迟敏感度同步 vs 异步 drain
- PII 脱敏用类型系统强制（`as` 断言 + `stripProtoFields`），不用正则自动检测
- asyncio 场景禁用全局变量传 trace_id，必须 ContextVar
- 配额层（LLMQuotaLayer）独立于观测层，能中止工作流
- 采样策略分级：正常路径 10-20% 概率采样，错误路径 100% 采样

---

## 三、四支柱

### Agent 比传统 Web 多一支柱

传统 SRE 是"Metrics / Traces / Logs 三件套"。Agent 场景需要加一支柱——会话级可重放 Transcript：

| 支柱 | 数据 | 用途 |
|---|---|---|
| 日志 | debug 文件 + stderr | 本地调试 |
| 指标 | Datadog + BQ | 远程监控 |
| 追踪 | Langfuse OpenTelemetry | 在线可视化 |
| 黑匣子 | Transcript JSONL | 会话恢复 / 行为回放 |

cc-18 §3.3 把 Transcript 独立成柱的理由是"不只是给人看的，也是给 `--resume` 程序读的"。一次会话跑了几十轮 LLM，光看单次 span 找不到"Agent 在第几轮开始跑偏"，必须有一份能从头重放的 transcript。

这个 Agent 是否需要支持"中断后恢复"或"行为回放"？如果需要，先把 Transcript 流做出来再谈其他支柱。

---

## 四、回调拦截（业务层埋点是反模式）

10 个地方调用 LLM，是每处都加 `start=time.time()`，还是在底层统一拦截？

| 做法 | 后果 |
|---|---|
| 业务层每个调用点手动计时 + 算费 | 10 个漏埋点的潜在盲区 |
| 装饰器 / 回调在最底层拦截 | 一处拦截、全员生效 |

cc-18 §3.5 让所有 LLM / Tool / Chain 的执行触发回调，`UsageMetadataCallbackHandler` 从 `on_llm_end` 回调里提取 `usage_metadata`，按 `model_name` 分组累加。

项目用什么框架（LangChain / 原生 Python / 自建循环）？框架越轻，越要走装饰器模式；框架越重（如 LangChain），直接注册 callback handler。

---

## 五、Token 成本拆分

拿到 LLM 返回的 `total_tokens` 后直接按单价算成本是反模式。Anthropic cache_read 价格是标准输入的 1/10，输出是输入的 3-5 倍，混在一起算会高估成本 10 倍。

必须按字段拆分计算：

| 字段 | 计费 |
|---|---|
| `prompt_tokens` | 标准输入价 |
| `completion_tokens` | 输出价（3-5x 输入） |
| `cache_read_input_tokens` | 1/10 标准输入价 |
| reasoning tokens（o1 / Claude Extended Thinking） | 单独记录 |

dify-14 §4.3 在 `_calculate_workflow_token_split` 里特意遍历 `WorkflowNodeExecution` 记录，把 prompt_tokens 和 completion_tokens 拆开累加。当前用的是哪个 provider（Anthropic / OpenAI / 国产模型）？它的 UsageMetadata 字段名和缓存策略是什么？成本计算函数要按字段分别乘对应单价。

---

## 六、Trace ID 五源解析

跨服务调用链（Agent → LLM API → Tool → DB）如何串成一条 trace？

| 做法 | 后果 |
|---|---|
| 每个服务自己生成 trace_id，靠时间窗关联 | 关联不可靠 |
| W3C `traceparent` 头跨进程传递 + ContextVar 进程内传递 | 可靠串联 |

dify-14 §2.1 在 `get_external_trace_id` 里按优先级解析外部 trace_id：

1. X-Trace-Id 头
2. query 参数
3. JSON body
4. 当前 OTel 上下文
5. W3C `traceparent` 头

单一来源会让某一类客户端被排除在 trace 树之外。`context_api.attach` 比 `with span` 更适合异步场景，因为自动埋点发生在 yield 后的任意时刻。

Agent 是单体服务还是会调外部 HTTP / Webhook？后者必须把 `traceparent` 注入出站请求头。

---

## 七、事件队列 + Drain

业务代码在 `attachAnalyticsSink` 之前就调 `logEvent`，这条事件会丢吗？

| 做法 | 适用 |
|---|---|
| 直接调 sink 方法（sink 未就绪则丢） | 不可用 |
| 事件先入队，sink 附加时同步 drain | 错误日志（必须立即可见） |
| 事件先入队，sink 附加时 `queueMicrotask` 异步 drain | 埋点（不应阻塞启动） |

cc-18 §4.1 错误日志 sink 队列 `errorQueue.push(...)`，`attachErrorLogSink` 时同步 drain；§4.4 分析埋点 sink 队列用 `queueMicrotask` 异步 drain。注释解释：错误的实时性优先（必须立即可见），埋点延迟几毫秒无伤大雅（不应阻塞启动）。

同步 vs 异步 drain 的差异是按数据时效性需求分化。错误 / 告警选同步，统计 / 埋点选异步。

---

## 八、PII 脱敏

trace 数据要送到云端 Langfuse，怎么防止 API key、文件路径、用户代码外泄？

| 做法 | 可靠性 |
|---|---|
| AI / 正则自动扫描敏感字段 | 漏报 + 误报 |
| 类型系统强制（`as` 断言）+ 出口 mask | 可靠 |

cc-18 §4.3 的 `sanitizeGlobal` 挂在 SpanProcessor 的 `mask` 回调里，所有 span data 在离开本地前都强制过一遍。`_PROTO_*` 字段在 Datadog fanout 前被 `stripProtoFields` 剥离，1P BQ 保留。dify-14 §3.4 在企业版下通过 `ENTERPRISE_INCLUDE_CONTENT=False` 控制是否写入 prompt / completion。

自然语言里"什么是敏感"无标准答案，文件路径算不算敏感都看场景。把判断压到开发者身上（用 `as` 断言显式声明）+ 在出口处强制（mask 回调 / stripProtoFields），是比"正则扫"更可靠的方案。

trace 后端是自建还是云端？云端必须双层防御（出口 mask + 字段分流）；自建可以只做出口 mask。

---

## 九、采样与指标基数

### 采样策略分级

| 路径 | 采样率 |
|---|---|
| 正常路径 | 10-20% 概率采样 |
| 错误路径 | 100% 采样 |

观测过度的真实代价：成本翻倍 + 噪音淹没关键信号 + 隐私风险。

### 指标基数控制

用 `user_id` / `task_id` / `timestamp` 当 Prometheus 标签是反模式——组合数无穷大，Prometheus OOM。每个指标的 label 组合数 ≤ 1000。

---

## 十、配额层独立于观测层

LLM 配额层（如 `LLMQuotaLayer`）能中止工作流（替换 `_run` 发 AbortCommand，不抛异常中断图），必须独立于 Observability，不耦合。

| 层 | 职责 |
|---|---|
| Observability | 观测（被动接收数据） |
| LLMQuotaLayer | 配额控制（能中止工作流） |
| Hook | 拦截（Pre/PostToolUse 等生命周期点） |

三层职责清晰分离。

---

## 十一、反模式

- 业务层手写 `start=time.time()` 计时代码，10 个调用点意味着 10 处漏埋
- 用 `total_tokens × 单价` 一刀切算成本，忽略 cache_read / output 差异账单高估 10 倍
- 用 `Counter` 记录延迟分布，Counter 只反映增量算不出 P95 / P99，必须用 Histogram
- 用 `user_id` / `task_id` / `timestamp` 当 Prometheus 标签，组合数无穷大 OOM
- asyncio 场景用全局变量传 trace_id，多个并发请求串号
- 自定义 Callback Handler 只实现 `on_llm_end` 不实现 `on_llm_error`，错误路径完全失明
- Langfuse 等云端追踪未配置 key 时仍然初始化，不存在的用户也要付启动开销
- trace 数据写完整 prompt 到 OTel span，OTel span 有大小限制且非为此设计

---

## 十二、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>Claude Code 可观测性（cc-18-observability.md）</strong>（点击展开）</summary>

- §一 解决什么问题 —— Agent 三重挑战：不确定性 + 长链路 + 隐私敏感
- §二 在整体架构中的位置 —— 可观测性是被动接收者，单向依赖
- §3.1 全景链路 —— 四类数据并行产生、流向不同出口
- §3.3 版图分类 四大支柱 —— 日志 / 指标 / 追踪 / 黑匣子 + 6 类诊断工具
- §3.5 对外接口 —— 9 个对外 API
- §4.1 日志流 —— 5 级日志 + BufferedWriter 双模式 + sink 队列同步 drain
- §4.2 transcript 流 —— JSONL 格式兼顾人可读与机器可恢复
- §4.3 Langfuse 追踪流 —— `asType` 语义层级 + TTFT 陷阱 + 双层脱敏
- §4.4 分析埋点流 —— `_PROTO_*` 字段分流 + 类型标记编译期强制 + 异步 drain
- §4.5 综合应用 故障排查路径 —— 9 类症状对应的"先近后远"查询顺序

</details>

<details>
<summary><strong>Dify 可观测性（dify-14-observability.md）</strong>（点击展开）</summary>

- §本章要解决的问题 —— 双轨可观测：OTel span + TraceQueueManager 异步队列
- §一 OTel 基础设施初始化 —— 10% 采样率 + 5 类自动埋点 + `ExceptionLoggingHandler`
- §二 链路入口与 trace_id 注入 —— `get_external_trace_id` 五源解析 + `AppGenerateHandler`
- §三 span 采集 三级边界 —— 应用级 → 工作流级 → 节点级
- §四 指标汇聚 —— `_calculate_workflow_token_split` + `time_to_first_token` 流式指标
- §五 第三方追踪提供商集成 —— `OpsTraceProviderConfigMap` 覆盖 10 种 provider
- §六 LLM 配额计数与限流 —— `LLMQuotaLayer` 三计量单位 + AbortCommand
- §七 日志与持久化 —— JSON 结构化日志 + `trace_session_id` 跨多次请求关联

</details>

<details>
<summary><strong>待补样本</strong>（点击展开）</summary>

本文只引了 cc-18 与 dify-14 两个样本。其他主流 Agent 框架的可观测性样本（如 AutoGen、CrewAI、LangGraph 等）尚未补全，待后续按需引用。

</details>