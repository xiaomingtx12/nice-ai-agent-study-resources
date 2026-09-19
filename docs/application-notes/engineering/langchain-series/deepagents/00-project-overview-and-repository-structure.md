---
sidebar_position: 2
sidebar_label: 00 项目概览与仓库结构
description: 从公开入口和一次文件读取追踪 Deep Agents、LangChain、LangGraph 的分工，解释核心包、外围应用与文件存储的边界。
---

# Deep Agents 源码解析 00：项目概览与仓库结构

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/`）。
> 源码版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 包与入口定义：`libs/deepagents/pyproject.toml`、`libs/evals/pyproject.toml`、`libs/code/pyproject.toml`、`libs/cli/pyproject.toml`、`libs/acp/pyproject.toml`、`libs/talon/pyproject.toml`
> - 维护者架构说明：`libs/ARCHITECTURE.md`
> - 主库导出面：`libs/deepagents/deepagents/__init__.py` → `create_deep_agent()`、`DeepAgentState`
> - 主装配入口：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
> - 核心目录职责：`libs/deepagents/deepagents/middleware/` → `FilesystemMiddleware`、`SubAgentMiddleware`、`SummarizationMiddleware`
> - 后端目录职责：`libs/deepagents/deepagents/backends/` → `BackendProtocol`、`StateBackend`、`StoreBackend`
> - 模型适配目录：`libs/deepagents/deepagents/profiles/` → `ProviderProfile`、`HarnessProfile`


## 二、Deep Agents 怎样进入一次 Agent 运行

Deep Agents 为 LangChain 的模型与工具循环预装文件访问、任务委派、记忆和上下文压缩等能力。本文将这些包围模型运行的工具、状态与控制策略称为 Harness。它仍由 LangGraph 执行：模型提出工具调用，工具返回结果，图保存状态并决定继续调用模型还是结束。

公开入口是 `create_deep_agent()`。`libs/deepagents/deepagents/__init__.py` 从 `graph.py` 导出它，下面是原文件中的导入片段：

```python
from deepagents.graph import (
    DeepAgentState,
    SystemPromptConfig,
    create_deep_agent,
)
```

`DeepAgentState` 定义图保存的数据，其中消息字段使用增量存储；`SystemPromptConfig` 描述系统提示词的前缀、主体和后缀。它们与工厂一起导出，是因为调用方既需要创建 Agent，也可能需要扩展状态或调整提示词。

工厂的下游在 `graph.py` 中有明确调用。下面保留最终交给 LangChain 的参数，省略返回值后附加的运行配置：

```python
return create_agent(
    model,
    system_prompt=final_system_prompt,
    tools=_tools,
    middleware=deepagent_middleware,
    response_format=response_format,
    context_schema=context_schema,
    checkpointer=checkpointer,
    store=store,
    debug=debug,
    name=name,
    cache=cache,
    state_schema=state_schema if state_schema is not None else DeepAgentState,
)
```

`create_agent()` 是 LangChain 的 Agent 图工厂，根据模型、工具和中间件构造循环。它拿到的 `_tools` 是用户工具；文件工具、计划工具和委派工具还会由 `deepagent_middleware` 中的中间件提供。因此，看到 `tools=None` 不能推断 Agent 没有工具。

三层的分工可以从这次调用确认：Deep Agents 整理策略与默认配置，LangChain 将它们编入 Agent 循环，LangGraph 调度图节点并传递状态。要改变文件存储，应查 Backend；要改变每轮模型请求，应查中间件；要理解检查点恢复位置，则需要继续追到 LangGraph。

## 三、沿一次文件读取理解运行过程

假设用户要求“读取报告并总结”，报告已经存在于配置的文件后端。`Backend` 是文件访问的实现对象，决定一个工具路径指向状态字典、持久存储还是实际文件系统。`Middleware` 是接入 Agent 的扩展对象，可以提供工具、状态字段和运行时 hook。

| 阶段 | 发生的处理 | 交给下一阶段的数据 |
| --- | --- | --- |
| 装配 | `FilesystemMiddleware` 保存 Backend，创建 `read_file` 等工具 | 模型可调用的工具定义和执行函数 |
| 接收任务 | 图把用户输入合并到 `messages` 状态字段 | 当前消息历史 |
| 模型决策 | 模型产生 `AIMessage`，其中 `tool_calls` 指定 `read_file` 和参数 | 带调用 ID 的工具请求 |
| 执行读取 | 工具校验路径和权限，再调用 Backend | 文件内容或错误说明 |
| 保存结果 | 工具结果成为 `ToolMessage`，用 `tool_call_id` 与请求配对 | 更新后的消息历史 |
| 再次推理 | 中间件准备本轮模型视图，必要时卸载大结果 | 模型生成总结所需的上下文 |

`AIMessage` 表示模型输出，既可以包含正文，也可以请求工具；`ToolMessage` 表示某次工具调用的结果。模型读到文件内容，靠的是工具结果进入下一轮上下文，并非直接访问 Backend 对象。

同一调用中还有三份容易混淆的数据：State 保存消息与中间件状态；Backend 保存文件；模型请求包含本轮实际发送的内容。默认 `StateBackend` 把文件也放进 State，但换成磁盘或 Store 后，文件就有独立的存储生命周期。历史摘要通常压缩模型请求视图，不等于磁盘文件或完整状态已经被删除。

## 四、仓库中的包怎样分工

仓库采用 monorepo，即在同一仓库维护多个发布包。下面列出与本系列主线相关的包，并非 `libs/` 的完整目录清单。各包有自己的 `pyproject.toml` 和版本，不能把 SDK 的版本号套到全部包上。

| 目录 | 本文源码快照中的职责 | 什么时候需要阅读 |
| --- | --- | --- |
| `libs/deepagents/` | SDK：Agent 装配、中间件、Backend、Profile | 理解 `create_deep_agent()` 及其运行机制 |
| `libs/evals/` | 评测执行、评分、报告与失败归因 | 核验任务结果或比较 Harness 改动 |
| `libs/code/` | 基于 SDK 的终端编程 Agent | 理解交互界面、会话与应用层装配 |
| `libs/cli/` | Agent 打包、运行和部署工具 | 追踪部署入口及服务配置 |
| `libs/acp/` | Agent Client Protocol 集成，用协议连接客户端与 Agent | 理解协议消息怎样接到 Agent |
| `libs/talon/` | 实验性的长期运行宿主，管理渠道适配器与定时调度 | 理解会话串行化、调度和宿主进程生命周期 |

正常调用 SDK 不需要先经过 Evals、终端界面或部署 CLI。它们是围绕 SDK 建立的使用入口或验证设施。例如文件工具的默认行为在 SDK 内定义，终端应用可以另选 Backend 和权限；遇到终端中的行为差异时，必须同时检查应用层传入的配置。

## 五、核心包内的四个追踪入口

`libs/deepagents/deepagents/` 中，下面四处决定大部分 SDK 行为：

| 入口 | 输入与处理 | 直接影响 |
| --- | --- | --- |
| `graph.py` | 接收工厂参数，解析模型，准备子代理、中间件和提示词 | 一张 Agent 图具备什么能力 |
| `middleware/` | 在入口、模型调用、工具执行和收尾阶段处理状态或请求 | 模型这一轮看见什么、工具前后做什么 |
| `backends/` | 将统一文件接口落实到具体存储与执行环境 | 文件存在哪里、命令在哪里执行 |
| `profiles/` | 按服务商或模型匹配构造参数和 Harness 配置 | 换模型时哪些默认值与策略跟着变化 |

这不是一条每轮都遍历的目录流水线。`graph.py` 和多数 Profile 匹配发生在创建期；`wrap_model_call` 等中间件 hook 发生在运行期；Backend 只有被文件或执行操作调用时才处理对应资源。检查“改了配置为什么没生效”时，应先确认已有 Agent 是否需要重新装配，还是运行中的状态快照仍在被复用。

## 六、从现象追到负责的实现

| 现象 | 要确认的数据与分支 | 对应专题 |
| --- | --- | --- |
| 模型看不到某个工具 | 是否注册、Backend 是否支持、最终请求是否过滤 | [06 中间件](06-middleware-increments.md)、[08 文件工具](08-filesystem-middleware-and-permissions.md) |
| 工具可见但路径被拒绝 | 工具参数、权限匹配与 Backend 路径解析 | [04 Backend](04-backend-protocol-and-implementations.md)、[08 权限](08-filesystem-middleware-and-permissions.md) |
| 文件更新后记忆仍旧 | Backend 文件与 `memory_contents` 是否一致 | [13 Memory](13-memory-middleware.md) |
| 长对话中看不到早期细节 | 摘要切点、当前请求视图与归档是否可读 | [10 上下文压缩](10-summarization-and-context-offloading.md) |
| 子任务结果与预期不同 | 子代理类型、独立配置、传入字段与结果回写 | [09 同步委派](09-subagent-sync.md)、[12 远端任务](12-async-subagent.md) |
| 恢复后调用状态不确定 | 消息配对、恢复位置及外部动作记录 | [03 状态恢复](03-state-reducers-and-recovery.md)、[11 消息修补](11-patch-tool-calls.md) |

创建期问题从 [01 总装配](01-create-deep-agent-assembly.md) 进入；运行期问题从 [06 中间件执行](06-middleware-increments.md) 进入。两条线会在“State 怎样变成下一次模型请求”处汇合。至于任务是否达标、预算是否超限、外部动作是否重复，需要继续查看评测、终止控制和业务验收，单凭工厂返回成功无法判断。

## 七、延伸阅读

**下层：LangChain / LangGraph**

- [LangGraph 00：项目概览与仓库结构](../langgraph/00-project-overview-and-repository-structure.md)——图运行时的包边界，与 Deep Agents 的 Harness 层如何分工
- [LangChain 00：项目概览与仓库结构](../langchain/00-project-overview-and-repository-structure.md)——`create_agent()` 所在位置，Deep Agents 装配的下游

**本系列**

- [01：`create_deep_agent()` 总装配](./01-create-deep-agent-assembly.md)——从目录地图进入主装配入口

**上层：方法论与案例**

- [应用案例 01：OpenWiki 总览](../../deepagents应用案例解析/openwiki/index.md)——同一套 Harness 落到真实业务时的目录与职责划分
