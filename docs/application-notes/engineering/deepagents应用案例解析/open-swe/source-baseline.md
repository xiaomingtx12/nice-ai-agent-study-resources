---
sidebar_position: 5
title: Open SWE 源码基线与证据范围
description: 记录 Open SWE 的上游提交、本地工作区差异和依赖版本，区分提交证据与工作树证据。
---

# Open SWE 源码基线与证据范围

## 一、研究对象与工作区差异

项目为 [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe)。本轮核验于 2026-10-13，上游 HEAD 为 [`0942b41561df7db968f3be7f1c5150819bdec6b8`](https://github.com/langchain-ai/open-swe/tree/0942b41561df7db968f3be7f1c5150819bdec6b8)，提交说明为 `fix(ui): stop animating streamed chat text (#4006)`。Python 包名 `open-swe-agent`，包版本 `0.1.0`。

分析环境是本地 `D:\open_code\open-swe`，Python 包目录为 `openswe/`。**本地工作区有未提交改动，系列的核验对象是 HEAD 加当前工作树。** GitHub 的固定提交链接只能证明已提交内容；引用工作树行为时不能把行号直接套到固定提交链接上。

已知与文章有关的差异：

- `openswe/server.py`、`openswe/reviewer.py`、`openswe/chat.py` 把 `create_deep_agent` 及相关同步构造放进 `asyncio.to_thread`。因此"建图在线程执行"属于工作区行为，"使用同一框架、不同装配"不依赖这次改动。
- `openswe/review/eval_jobs.py` 和 `openswe/analytics/queries.py` 的部分调用改为等待异步 `backend_build_info()`（对应 `openswe/utils/build_info.py` 的本地修改）。
- `openswe/api/app.py` 等文件另有改动；引用时逐文件检查 diff。

### 1、2026 年 11 月 1 日架构重组复核

本次把整体架构与异步模型前置到 00，消息交付细节归入执行协调专题，事件流与结算边界归入运行记录专题；不再保留独立的架构总装篇。复核时本地 HEAD 仍为 `0942b41561df7db968f3be7f1c5150819bdec6b8`，不代表上游最新版本。

- 重新读取图注册、自定义应用、单事件循环约束、运行分发、GitHub 接入、完成回调和平台流代理。上述核心文件中，`openswe/api/app.py` 有本地修改；`langgraph.json`、`openswe/webapp.py`、`openswe/utils/event_loop.py`、`openswe/dispatch.py`、`openswe/github/routes.py`、`openswe/completion.py`、`openswe/threads/proxy.py` 相对 HEAD 未改。
- 用本机 `langgraph_sdk/_async/runs.py` 核对 `if_not_exists`：它处理目标线程缺失时的 create/reject，不提供运行幂等。用本机 `langgraph/pregel/main.py` 核对 `durability="sync"` 的图步检查点等待，不外推为外部副作用恰好一次。
- 对照 `openswe/transcript/routes.py` 区分应用会话日志回放与平台流代理；对照消息表、完成处理与调度入口，限定交付、拾取和清扫范围。代码注释与当前调用不一致时，以实际分支为准。

本轮只做静态核对和文档整理，没有启动 Open SWE 服务、运行测试、模型评测或站点构建。

## 二、声明依赖与锁定结果

以下依赖记录来自对 [pyproject.toml](https://github.com/langchain-ai/open-swe/blob/0942b41561df7db968f3be7f1c5150819bdec6b8/pyproject.toml)、[uv.lock](https://github.com/langchain-ai/open-swe/blob/0942b41561df7db968f3be7f1c5150819bdec6b8/uv.lock) 与 [langgraph.json](https://github.com/langchain-ai/open-swe/blob/0942b41561df7db968f3be7f1c5150819bdec6b8/langgraph.json) 的核验。中间件与上下文专题还读取了本机 `.venv/Lib/site-packages` 的框架源码，用于核对中间件合并、hook 顺序、Skills 加载、摘要阈值与 fork 返回协议。本机安装文件行号不属于 Open SWE 提交。

| 组件 | 声明或锁定版本 | 作用 |
| --- | --- | --- |
| Python | `>=3.14`；图部署配置 `3.14` | 应用语言与部署约束 |
| Deep Agents | 声明并锁定 `0.7.21` | Agent 工厂、文件后端、Skills、子 Agent、摘要 |
| LangChain | 声明 `langchain[mcp]>=1.4.4`，锁定 `1.4.4` | 模型、工具和中间件接口 |
| LangChain Core | 锁定 `1.6.9` | 消息、模型和工具基础类型 |
| LangGraph | 声明 `>=1.2.12`，锁定 `1.2.12` | 有状态执行图与运行协议 |
| LangGraph API | 锁定 `0.15.0rc5`，约束 `>=0.15.0rc1,<0.16` | 线程、运行、事件流和回调服务 |
| LangGraph SDK | 声明 `>=0.4.5`，锁定 `0.4.5` | 应用侧创建和观察运行 |
| langchain-typesafe | 固定 `0.0.1a3` | Jev 分类接口 |
| FastAPI、SQLAlchemy asyncio、asyncpg、alembic | 仅查看声明 | HTTP 应用、PostgreSQL 访问与迁移 |

沙箱提供方注册表按 `SANDBOX_TYPE` 懒加载；本系列不证明各可选提供方具有相同的恢复、停止或快照能力。

## 三、证据使用约定

- **README 与项目文档**说明维护者的产品声明；**应用源码**证明调用关系、状态变化、条件分支和外部副作用。
- **提示词**规定模型应当怎样行动，不等于代码强制执行。
- **测试源码**作为行为规格引用，均未执行。
- **框架内部行为**（deepagents、langchain）按锁定版本的本机安装核验；版本相同不能证明远程部署文件逐字一致。
- 故障时序与恢复窗口的推导在正文里以"推导"标明，不写成线上观测结果。

后续更新先记录 HEAD 和 dirty 文件，再比较依赖、图清单、工厂接线和专题调用链；引用有本地差异的文件时，分别记录提交内容与工作树内容。

返回[系列导读](./index.md)。
