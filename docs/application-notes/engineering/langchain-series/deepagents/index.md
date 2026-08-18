---
sidebar_position: 1
sidebar_label: Deep Agents 源码解析导读
description: Deep Agents 0.6.12 源码阅读路线：先看仓库概览与总装配，再进入状态、Backend、文件、上下文、子代理、真实业务案例和评测。
---

# Deep Agents 核心源码解析

> **适用版本**：Deep Agents 0.6.12（本地源码快照；正文按文件、类名和方法名定位）

> - 总装配入口：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
> - 模型与 Profile：`libs/deepagents/deepagents/_models.py` → `resolve_model()`；`libs/deepagents/deepagents/profiles/provider/provider_profiles.py` → `get_provider_profile()`；`libs/deepagents/deepagents/profiles/harness/harness_profiles.py` → `_harness_profile_for_model()`
> - 状态与恢复：`libs/deepagents/deepagents/graph.py` → `DeepAgentState`；`libs/deepagents/deepagents/_messages_reducer.py` → `_messages_delta_reducer()`
> - 中间件专题：`libs/deepagents/deepagents/middleware/` → `FilesystemMiddleware`、`SkillsMiddleware`、`MemoryMiddleware`、`SubAgentMiddleware`、`RubricMiddleware`

Deep Agents 没有重写 Agent 的模型—工具循环。它在 LangChain 和 LangGraph 之上，统一装配提示词、工具、中间件、文件后端、技能、记忆、子代理和权限，再把结果交给 LangChain 编译。

:::tip 先抓住一句话
LangGraph 负责图怎样执行；LangChain 提供标准 Agent 循环与可组合 Middleware；Deep Agents 在其上预装面向长任务的规则和能力。后文把模型循环周围的装配责任称为 **Harness**。
:::

## 先看设计主线

这组源码最容易读成一张功能清单：模型有 Profile，文件有 Backend，任务有 SubAgent，上下文有 Summarization。把这些模块并排看，容易漏掉 Deep Agents 反复使用的一种设计方法：

> 长任务里出现的每一种失败，都被放到一个明确的边界上处理；模型—工具循环本身尽量保持不动。

| 长任务里的问题 | 设计落点 | 解决方式 | 付出的代价 |
| --- | --- | --- | --- |
| 不同模型的客户端参数和 Agent 行为混在一起 | Provider Profile / Harness Profile | 把模型构造适配与 Agent 运行策略分开 | Profile 合并、注册和覆盖规则变复杂 |
| 消息会增长、改写，还要支持中断恢复 | State / Reducer / Checkpoint | 用稳定 ID 和可重放的增量写入保存历史 | 每次历史改写都必须遵守消息协议 |
| 文件工具不应该绑定一种存储或执行环境 | Backend / Sandbox | 用能力接口隔离工具接口、存储位置和命令执行环境 | “能调用”不等于“有安全隔离”，选型责任留给部署者 |
| 所有知识都塞进提示词会变贵、变旧 | Skills / Memory / Summarization | 通过索引、按需读取和可恢复压缩控制上下文 | 模型看到的内容不再等于完整 State |
| 一个 Agent 同时承担所有子任务会阻塞或失控 | Sync / Async SubAgent | 用独立 State 或远程任务索引划分执行单元 | 父子边界、状态同步和失败处理需要显式设计 |
| Agent 说“完成”不代表结果真的达标 | Rubric / Evals | 把生成、验收、效率和环境失败拆开 | 多一次调用和一套更严格的观测体系 |

因此，读每个模块时不要只问“它有哪些类和方法”，还要追四个问题：**它在防哪种失败，修改的是哪份数据，为什么放在这个边界，系统因此牺牲了什么。** 这四个问题比记住某个 Middleware 的参数更能迁移到自己的 Agent。

:::tip 设计阅读法
每篇文章中的“源码行为”只描述当前实现；“工程判断”解释这种实现适合什么场景、哪里会失效。把两者分开，才能避免把源码现状误读成框架必须如此的设计原则。
:::

## 第一次阅读，只需认识这些词

源码中的类名和参数名保留英文，正文尽量用右侧的中文含义。遇到术语时先按这一列理解，不必先背框架定义。

| 源码中的词 | 在本系列中先理解成 |
| --- | --- |
| Runtime | LangGraph 注入的运行期上下文；图调度由 LangGraph 执行 |
| Harness | 模型循环周围的装配责任；LangChain 提供最小组合，Deep Agents 预装长任务策略 |
| Middleware | 中间件：在模型或工具调用前后插入处理逻辑 |
| Backend | 文件与命令操作的统一后端；不天然等于沙箱 |
| State | 当前运行保存的数据 |
| Reducer | 多次状态更新发生时的合并规则 |
| Checkpointer | 保存图状态、支持恢复的组件 |
| Profile | 针对模型或服务商套用的一组适配配置 |
| SubAgent | 承接子任务的另一套 Agent |
| HITL | Human in the loop，本系列主要指工具执行前的人工审批 |
| Rubric | 判断任务是否达标的文字标准 |

`Memory`、`Skills`、`Summarization` 等名称会在对应文章中就地解释，不需要在导读里一次记完。

## 沿一条调用链读源码

```text
调用 create_deep_agent(...)
  → 解析模型及其适配配置
  → 组装系统提示词和中间件
  → 接入文件后端、技能、记忆、权限和子代理
  → 调用 LangChain create_agent(...)
  → LangGraph 运行模型—工具循环并保存状态
```

这条链也是本系列的主线。源码里出现一个新抽象时，先问它插在链路哪一段、改变了什么，再看类型和参数。

## 提示词与上下文怎么分散阅读

本系列不把“提示词”和“上下文装配”集中成一篇重复讲。每篇只负责一个边界：

| 内容 | 主要文章 | 进入模型前发生了什么 |
| --- | --- | --- |
| 静态系统提示词 | 01、03 | `prefix → base → suffix → profile suffix`，Profile 可覆盖模型适配提示 |
| Provider Prompt Caching | 01、06、13 | Provider Middleware 标记稳定 Prompt 前缀，Memory 放在动态断点之后 |
| 状态与消息历史 | 03 | State 保存消息和工具结果，Reducer 负责合并，Checkpoint 负责恢复 |
| 中间件动态改写 | 06 | `wrap_model_call` 可以通过 `request.override(...)` 改写消息、工具或系统提示 |
| Skill | 07 | Skill 常驻元数据和按需读取入口 |
| 文件和工具结果 | 08 | 大结果写入 Backend，模型请求只保留预览、路径或可用工具 |
| 同步子代理上下文 | 09 | 子代理使用自己的 system prompt，只接收任务描述和允许传递的状态 |
| 历史压缩 | 10 | 只改变本轮模型请求视图，不直接删除图状态中的原始消息 |
| 工具调用修补 | 11 | 修复没有对应 ToolMessage 的悬空工具调用 |
| 异步子代理任务 | 12 | 通过远程 Thread / Run 管理长任务 |
| Memory | 13 | 在主代理尾部注入指定文件全文，并在 Anthropic 下标记动态缓存断点 |

统一的阅读坐标是：

```text
State / Backend / Profile / Middleware
  → system prompt + messages + tools + runtime context
  → 本轮模型请求
  → AIMessage / ToolMessage
  → State 更新与 Checkpoint
```

读任何一篇时只追问四件事：**信息从哪里来、在哪个边界进入、是否写回 State、下一轮还能否恢复。**

## 文章地图

### 先建立全貌

- [00：项目概览与仓库结构](00-project-overview-and-repository-structure.md)：monorepo 包边界、核心目录地图与责任边界。
- [01：`create_deep_agent()` 总装配](01-create-deep-agent-assembly.md)：从主工厂入口看整套组件如何接在一起。

### 再看状态与模型的两条源码链

- [02：模型解析与 Profile](02-model-resolution-and-profiles.md)：沿配置流追踪模型 spec 从解析到 Provider Profile、Harness Profile，解释模型差异为什么不应散落在 Agent 主流程里。
- [03：状态、Reducer 与恢复](03-state-reducers-and-recovery.md)：沿运行期数据流追踪 `messages` 从写入、合并到 Checkpoint 重放，解释长任务为什么能继续执行。
- [04：Backend 接口与实现](04-backend-protocol-and-implementations.md)：同一套文件工具如何接入状态、存储、本地文件系统、远端环境、Context Hub 与 LangSmith。
- [05：Backend 沙箱与隔离](05-backend-sandbox-and-isolation.md)：`BaseSandbox` 如何用 `execute()` 派生全部文件操作，隔离强度按哪一层判断。

### 然后看核心中间件

- [06：中间件增量总览](06-middleware-increments.md)：对照 LangChain 内置中间件，先建立 Deep Agents 中间件栈的复用与增量地图，含 PatchToolCalls、工具排除与 HITL 封装。
- [07：Skills](07-skills-middleware.md)：技能元数据如何被发现，模型如何按需读取 `SKILL.md`。
- [08：Filesystem 与权限](08-filesystem-middleware-and-permissions.md)：一次文件工具调用如何经过校验、权限判断、执行和结果卸载。
- [09：同步 SubAgent](09-subagent-sync.md)：本地委派如何隔离 State、运行子 Agent 并回写结果。
- [10：Summarization 与上下文卸载](10-summarization-and-context-offloading.md)：如何压缩模型看到的历史，同时保留可恢复的原始记录。
- [11：PatchToolCalls](11-patch-tool-calls.md)：如何修复恢复后没有结果的工具调用。
- [12：异步 SubAgent](12-async-subagent.md)：如何创建、查询、更新和取消远程任务。
- [13：Memory](13-memory-middleware.md)：如何在主代理尾部加载和注入常驻文件。
- [14：Rubric 自评循环](14-rubric-self-evaluation-loop.md)：Agent 准备结束时，如何按标准决定结束还是再修订一轮。

### 最后看案例与评测

- [15：Examples——better-harness 优化闭环](15-examples-better-harness.md)：`examples/better-harness` 如何让外层 Agent 修改可编辑 Surface，用 train + holdout 评测接受或拒绝候选。
- [16：Evals 评测体系](16-deepagents-evals.md)：`libs/evals` 如何定义正确与高效、怎么跑、怎么把结果量化成雷达图和评分卡。

## 三条阅读路线

| 目的 | 顺序 | 可以先跳过 |
| --- | --- | --- |
| 看懂 Deep Agents 如何运行 | `00 → 01 → 02 → 03 → 05 → 07 → 08 → 09 → 10 → 12` | Rubric、15、16 |
| 看懂模型适配如何进入 Agent | `00 → 01 → 02 → 06` | 03、04、05、09、12、13 |
| 用 Deep Agents 搭自己的 Agent | `01 → 02 → 04 → 05 → 06 → 07 → 08 → 09 → 12 → 13` | 03、14、15、16 |
| 专看上下文工程 | `01 → 03 → 06 → 07 → 08 → 09 → 10 → 13 → 案例 01` | Backend 的各个具体实现 |
| 想了解 Harness 优化与评测 | 读 14 后按需深挖 15、16 | — |
| 对照 LangChain 中间件系列 | 读完 06 后按需深挖 07–14 | — |

不建议从 04 开始逐个背 Backend。先读 01 和 05，知道上层为什么需要这套接口，再回来看具体实现，负担会小很多。

## 按设计问题阅读

如果目标是理解设计思想，可以按问题而不是按文件顺序阅读：

| 想理解的问题 | 推荐文章 | 读完应形成的判断 |
| --- | --- | --- |
| 一个长任务 Agent 是怎样被装配出来的 | 00、01、06 | 哪些能力属于工厂装配，哪些能力属于运行期 Hook |
| 状态为什么能改写、恢复和继续运行 | 03、10、11 | State 中的完整记录与模型本轮看到的视图为什么要分开 |
| 文件能力怎样跨存储和执行环境复用 | 04、05、08 | Backend、权限和 OS 隔离分别负责什么 |
| 上下文怎样保持够用而不无限膨胀 | 06、07、10、13 | 哪些内容常驻、哪些内容按需加载、哪些内容只保留恢复路径，哪些稳定前缀可以交给 Provider 缓存 |
| 多 Agent 为什么要区分同步和异步 | 09、12 | 子任务边界是 State 隔离，还是远程生命周期管理 |
| 真实业务怎样承接完整 Harness | [应用案例 01](../../deepagents应用案例解析/openwiki/index.md) | 业务对象、运行状态、工具规则和框架装配分别由谁负责 |
| Agent 怎样从“能做”变成“可验收、可优化” | 14、15、16 | 生成、验收、评测和候选接受为什么要分层 |

这张表也解释了文章之间的重复：同一个能力可能在装配、请求、State 和 Backend 四个时刻出现。重复部分不是同一段源码的改写，而是在追踪同一个设计决策跨过了哪些边界。

## 结论如何标注

本系列把证据强度分成三档：

- **源码行为**：当前实现直接表现出的行为；
- **测试锁定**：有单元测试或回归测试约束；
- **工程判断**：根据调用顺序、边界和代价得出的判断，不冒充维护者承诺。

安全相关结论也会明确落在哪一层。工具权限、Backend 能力和操作系统隔离是三件事；类名中出现 `Sandbox`，不代表具体实现自动具备 OS 级隔离。

## “Memory”在源码里不是一件事

| 具体对象 | 保存什么 | 由谁负责 |
| --- | --- | --- |
| 当前线程的执行状态 | 消息、工具结果、中间件状态 | LangGraph Checkpointer |
| 跨线程数据 | Store 命名空间里的数据 | LangGraph `BaseStore` / `StoreBackend` |
| 每轮注入模型的长期说明 | 配置的 `AGENTS.md` 等文件 | `MemoryMiddleware` |

因此，`AGENTS.md` 更准确的说法是"持久化的指令和参考上下文"。它是否跨线程，取决于背后的 Backend 和存储位置。
