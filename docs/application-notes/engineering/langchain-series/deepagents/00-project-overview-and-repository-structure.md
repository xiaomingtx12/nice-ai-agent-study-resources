---
sidebar_position: 2
sidebar_label: 00 项目概览与仓库结构
description: 从 deepagents monorepo 的包边界出发，分清 deepagents、evals 等子包，建立 00-16 的源码阅读坐标。
---

# Deep Agents 源码解析 00：项目概览与仓库结构

## 源码定位

> **阅读基线**：Deep Agents 0.6.12；
>
> - 仓库发布包：`libs/` → `deepagents/`、`evals/`、`acp/`、`cli/`、`code/`、`talon/`
> - 主库导出面：`libs/deepagents/deepagents/__init__.py` → `create_deep_agent()`、`DeepAgentState`
> - 主装配入口：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
> - 核心目录职责：`libs/deepagents/deepagents/middleware/` → `FilesystemMiddleware`、`SubAgentMiddleware`、`SummarizationMiddleware`
> - 后端目录职责：`libs/deepagents/deepagents/backends/` → `BackendProtocol`、`StateBackend`、`StoreBackend`
> - 模型适配目录：`libs/deepagents/deepagents/profiles/` → `ProviderProfile`、`HarnessProfile`

## 前言

Deep Agents 不重写模型—工具循环，而是在 LangChain `create_agent()` 之上预装长任务 Harness 策略。从源码上理解"它到底多装了什么"，先得知道仓库怎么拆、能力放在哪些包里。本篇建立包边界与目录地图，后续 01–16 每篇只深入一个主题。

## 这篇要回答的设计问题

Deep Agents 选择 monorepo，不是把所有能力都堆进主包。主库负责 Agent Harness，`evals` 负责验证与优化，`cli`、`acp`、`code` 等包分别承载外围入口或集成。

读目录时重点看能力的所有权：`graph.py` 负责装配，`middleware/` 负责介入运行链，`backends/` 负责资源访问，`profiles/` 负责适配差异。目录边界本身就是设计文档。

## 一、monorepo 包边界

```text
libs/
├── deepagents/     # 主库：Agent Harness 本体
├── evals/          # 评测与优化循环
├── acp/            # Agent Client Protocol 支持
├── cli/            # 命令行入口
├── code/           # 代码执行相关
└── talon/          # 工具与集成
```

阅读主链只看 `deepagents/` 与 `evals/`，`acp` / `cli` / `code` / `talon` 处理远端协议与部署。

## 二、`libs/deepagents/` 包内目录

```text
libs/deepagents/deepagents/
├── graph.py            # create_deep_agent() 主装配
├── middleware/         # 核心中间件：Filesystem、SubAgent、Summarization、Rubric 等
├── backends/           # Backend 接口与实现：state/store/composite/sandbox/context_hub 等
├── profiles/           # Provider / Harness 两套模型适配配置
├── _api/               # 弃用与兼容路径
└── __init__.py         # 公共导出面
```

四个核心目录对应四类阅读目标：

| 目录 | 回答什么 | 对应文章 |
| --- | --- | --- |
| `graph.py` | 一次 `create_deep_agent()` 装配出什么图 | 01 |
| `middleware/` | 核心能力怎样作为中间件进入 Agent | 06–11 |
| `backends/` | 文件与命令操作怎样接入不同存储/环境 | 04、05 |
| `profiles/` | 模型差异怎样在装配期被吸收 | 02 |

## 三、责任边界：Deep Agents 装了什么

沿用 LangChain 系列的坐标：LangGraph 是 Runtime，LangChain `create_agent()` 是最小 Harness，Deep Agents 是预装长任务策略的 Harness。三者的边界不变，Deep Agents 的增量集中在：

| 能力 | Deep Agents 落点 | 对应文章 |
| --- | --- | --- |
| 文件与命令操作 | `FilesystemMiddleware` + `backends/` | 04、05、06、08 |
| 按需知识与常驻指令 | `SkillsMiddleware` / `MemoryMiddleware` | 07、13 |
| 子任务委派 | `SubAgentMiddleware` / `AsyncSubAgentMiddleware` | 09、12 |
| 上下文压缩与卸载 | `SummarizationMiddleware` | 10 |
| 完成标准自评 | `RubricMiddleware` | 14 |
| 工具排除与修补 | `_ToolExclusionMiddleware` / `PatchToolCallsMiddleware` | 06、11 |

## 四、阅读路线

```text
00 仓库与包边界
  → 01 create_deep_agent() 总装配
  → 02 模型解析与 Profile：沿配置流看模型差异如何进入 Agent
  → 03 状态、Reducer 与恢复：沿运行期数据流看消息如何保存和重放
  → 04 Backend 接口与实现 → 05 沙箱与隔离
  → 06 中间件增量总览 → 07 Skills → 08 Filesystem
  → 09 同步 SubAgent → 10 Summarization → 11 PatchToolCalls
  → 12 异步 SubAgent → 13 Memory → 14 Rubric
  → 15 better-harness → 16 Evals
```

先读 00 和 01 建立全貌，再按兴趣进入 Backend 或中间件专题。06 先给出 Deep Agents 相对 LangChain 的中间件增量，后面的 07–14 再按主代理装配顺序展开具体机制。

## 读完后应该能判断什么

- 一个类或函数属于 `graph.py`、`middleware/`、`backends/` 还是 `profiles/`，在正确的目录里追根因；
- `deepagents` 主库与 `evals` 等其他子包的边界；
- 哪些能力由 Deep Agents 提供、哪些来自 LangChain / LangGraph；
- 读 01 篇前，应能说出 `create_deep_agent()` 的四大装配输入（模型、工具、中间件、Backend）。
