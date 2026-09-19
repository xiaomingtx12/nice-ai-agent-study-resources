---
sidebar_position: 1
sidebar_label: Deep Agents 源码解析导读
description: 按装配、状态、上下文、子代理和故障路径选择 Deep Agents 源码阅读路线，理解模块机制与工程边界。
---

# Deep Agents 核心源码解析

Deep Agents 在 LangChain 的 Agent 循环之上，装配文件工具、技能、记忆、子代理、上下文压缩和权限等能力。本系列沿调用链解释这些机制，并指出使用它们时需要补充的业务约束。各篇头部的“源码定位”列出相对路径与函数入口，便于核对真实实现；正文通过必要概念、核心代码和状态变化说明原理，可以先完整阅读，再按需追查源码细节。

> **阅读基线**：以声明版本为 0.6.12 的 Deep Agents 源码快照为主。源码快照与同版本分发包存在差异，各篇引用的 LangChain、LangGraph 版本也不完全相同，详见 [源码版本与路径约定](source-baseline.md)。

LangGraph 负责图执行与状态恢复；LangChain 提供 Agent 循环与中间件接口；Deep Agents 在其上组合长任务所需的能力。本文将模型循环周围的这些装配与运行策略称为 **Harness**。

## 一、按目标选择阅读路线

| 当前要解决的问题 | 建议起点 | 继续深入 |
| --- | --- | --- |
| 搞清一次 Agent 如何创建和运行 | [00 仓库概览](00-project-overview-and-repository-structure.md) → [01 装配入口](01-create-deep-agent-assembly.md) → [06 中间件执行](06-middleware-increments.md) | 模型配置看 02，状态恢复看 03 |
| 选择文件存储、执行环境与权限 | [04 Backend](04-backend-protocol-and-implementations.md) → [05 沙箱](05-backend-sandbox-and-isolation.md) → [08 文件权限](08-filesystem-middleware-and-permissions.md) | 按是否跨线程保存、是否执行命令决定接入方案 |
| Skill 或记忆没有按预期生效 | [07 Skills](07-skills-middleware.md)、[13 Memory](13-memory-middleware.md) | 历史过长看 10，缓存配置看 17 |
| 委派任务、接收结果或展示过程 | [09 同步子代理](09-subagent-sync.md) → [12 异步任务](12-async-subagent.md) | 流式消费看 18，终止控制看 19 |
| 用代码批量调用工具、组织多阶段任务 | [23 Interpreter 与 PTC](23-interpreter-and-programmatic-tool-calling.md) → [22 动态子代理与代码工作流](22-dynamic-subagents-and-quickjs-workflows.md) | 普通委派看 09，图状态恢复看 03 |
| 评估方案是否适合交付 | [20 Harness 架构与运行边界](20-harness-constitution-rereading.md) → [21 故障路径与边界验证](21-production-failure-validation.md) | 按风险回到 08、09、12、14、19 核验源码 |
| 改善 Agent 的任务表现 | [14 运行内评分](14-rubric-self-evaluation-loop.md) → [16 离线评测](16-deepagents-evals.md) → [15 候选优化](15-examples-better-harness.md) | 用固定任务集判断配置改动是否有效 |

首次阅读可以只走第一行。遇到文件持久化或执行环境的具体问题时，再进入第 04、05 篇；其中的协议方法、路径路由和能力探测，会说明切换 Backend 时哪些行为随之改变。

## 二、沿调用与数据流建立坐标

```text
create_deep_agent(...)
  → 解析模型与 Profile
  → 装配工具、Backend、子代理和中间件
  → create_agent(...) 构建 Agent 图
  → 入口 hook 加载 Skills / Memory 等状态
  → 模型请求包装器按当前 State 生成本轮视图
  → 模型与工具循环
  → 状态更新；配置 Checkpointer 时保存恢复信息
```

理解每段机制时确认三个对象：输入从哪里来，当前改动写到哪份数据，下一轮由谁消费。例如，Memory 把文件内容保存到 `memory_contents`，再据此改写 `ModelRequest.system_message`；后续更新 Backend 文件，不会自动刷新这个快照。

运行时 context 提供身份、连接等依赖，不会自动进入提示词。State 中的历史、Backend 中的文件、模型本轮看到的请求，生命周期也不同，不能统一叫作“上下文”后省略差别。

| 术语 | 本系列中的含义 |
| --- | --- |
| Middleware | 中间件，在模型或工具调用前后介入处理 |
| Backend | 文件和命令操作的后端接口，具体实现决定存储与执行位置 |
| State / Reducer | 图保存的数据，以及多次更新的合并规则 |
| Checkpointer | 保存图执行状态、支持后续恢复的组件 |
| Profile | 模型或服务商对应的构造参数与 Harness 适配配置 |
| HITL | 工具执行等位置的人工审批与恢复流程 |
| Rubric | 用于评分的任务标准，评分通过仍需与业务事实核对 |

## 三、文章地图与分工

### 1. 装配、状态与资源

- [00：项目概览与仓库结构](00-project-overview-and-repository-structure.md)：包边界和源码入口。
- [01：create_deep_agent 总装配](01-create-deep-agent-assembly.md)：创建期的配置流，哪些对象被交给 LangChain。
- [02：模型解析与 Profile](02-model-resolution-and-profiles.md)：客户端参数、Harness 配置与模型能力元数据的区别。
- [03：状态、Reducer 与恢复](03-state-reducers-and-recovery.md)：消息 ID、增量重放和外部副作用的恢复边界。
- [04：Backend 接口与实现](04-backend-protocol-and-implementations.md)：存储生命周期、路径路由、能力探测与实现选型。
- [05：Backend 沙箱与隔离](05-backend-sandbox-and-isolation.md)：命令执行、文件传输与环境隔离。
- [06：中间件增量与执行顺序](06-middleware-increments.md)：运行期的 hook 顺序、状态更新和请求改写。

### 2. 上下文与子代理

- [07：Skills](07-skills-middleware.md)：发现元数据、按需读取正文和资源访问条件。
- [08：Filesystem 与权限](08-filesystem-middleware-and-permissions.md)：文件工具执行时的路径规则、审批与结果处理。
- [09：同步 SubAgent](09-subagent-sync.md)：输入状态筛选、子代理运行与结果回写。
- [10：Summarization 与上下文卸载](10-summarization-and-context-offloading.md)：摘要、卸载与溢出回退的不同触发路径。
- [11：PatchToolCalls](11-patch-tool-calls.md)：补齐悬空工具消息，及其无法证明的外部动作状态。
- [12：异步 SubAgent](12-async-subagent.md)：远程 Thread / Run 的启动、查询、更新和取消。
- [13：MemoryMiddleware 与长期上下文装配](13-memory-middleware.md)：文件加载、状态快照与请求注入，附刷新边界验证。
- [17：Prompt Caching](17-prompt-caching.md)：缓存中间件、模型门控与供应商断点。
- [18：流式输出与子代理流](18-streaming-output.md)：从事件到消息、工具和子代理投影，理解多路消费与完成、中断、失败的判断。
- [22：动态子代理与 QuickJS 代码工作流](22-dynamic-subagents-and-quickjs-workflows.md)：模型生成 JavaScript，经 Python 桥接调用子代理，解析并发、动态输出格式和状态回传边界。
- [23：Interpreter 与 PTC 工具编排](23-interpreter-and-programmatic-tool-calling.md)：解释器为何有用、普通工具如何接入，以及原生结果、变量生命周期和增量快照的实现；建议先于第 22 篇阅读。

### 3. 终止、评测与交付

- [14：Rubric 自评循环](14-rubric-self-evaluation-loop.md)：自然结束后的评分和修订，不替代独立业务校验。
- [15：better-harness 优化闭环](15-examples-better-harness.md)：外层 Agent 提议配置改动，再通过评测筛选候选。
- [16：Evals 评测体系](16-deepagents-evals.md)：轨迹采集范围、正确性断言与效率指标。
- [19：循环预算与终止控制](19-loop-budget-and-termination.md)：图步数、消息计数与任务费用的区别。
- [20：Harness 架构与运行边界](20-harness-constitution-rereading.md)：沿报告生成任务串起各组件，区分图状态、模型请求和外部资源的职责。
- [21：故障路径与边界验证](21-production-failure-validation.md)：启动失败、评分误判与评测退出码等故障路径，以及对应的业务验收条件。

同一能力跨篇出现时，概览负责接线，专题负责机制，风险复查负责指出验证位置。判断一个功能是否可靠，应回到专题中的具体条件与实验范围，不能只采用文末的简写结论。

## 四、与下层机制和业务案例对照

- [LangChain 源码解析](../langchain/index.md)：Agent 装配、中间件接口与工具治理。
- [LangGraph 源码解析](../langgraph/index.md)：State、Channel、Checkpoint、Interrupt 与 Stream。
- [应用案例：OpenWiki](../../deepagents应用案例解析/openwiki/index.md)：同一套 Harness 在具体业务中怎样分配责任。
- [Agent 系统设计](../../../../notes/agent-system-design/index.md)：把案例中的机制与代价转成可迁移的设计判断。
