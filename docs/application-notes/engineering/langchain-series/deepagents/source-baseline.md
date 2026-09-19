---
sidebar_position: 26
sidebar_label: 源码版本与路径约定
description: 说明 Deep Agents 系列的源码版本、依赖差异与相对路径含义。
---

# 源码版本与路径约定

本系列以声明版本为 **0.6.12** 的 Deep Agents 源码快照为主。源码快照与同版本分发包存在差异，且未锁定可核验的 commit，因此不能仅凭 `deepagents==0.6.12` 推定所有片段和行为一致。阅读时应同时核对文件、类、函数和依赖版本。

## 一、路径以所属项目或包为起点

| 路径写法 | 相对位置 | 示例 |
| --- | --- | --- |
| `libs/deepagents/…`、`libs/evals/…` | Deep Agents 仓库根目录 | `libs/deepagents/deepagents/graph.py` |
| `libs/partners/quickjs/…` | Deep Agents 仓库根目录 | `libs/partners/quickjs/langchain_quickjs/_repl.py` |
| `libs/langchain_v1/…`、LangChain 的 `libs/partners/…` | LangChain 仓库根目录 | `libs/langchain_v1/langchain/agents/factory.py` |
| `libs/langgraph/…` | LangGraph 仓库根目录 | `libs/langgraph/langgraph/channels/delta.py` |
| `deepagents/…` | Deep Agents SDK 包所在目录 | `deepagents/middleware/memory.py` |
| `langchain/…`、`langgraph/…`、`langchain_core/…`、`langchain_aws/…` | 对应 Python 包所在目录 | `langgraph/pregel/main.py` |
| `scripts/deepagents/…` | 文档仓库根目录 | `scripts/deepagents/reproduce-boundaries.py` |

个别篇章使用 `langchain/libs/…` 标明 LangChain 仓库，或在已经确定模块后简写 `middleware/memory.py`。这些写法都用于定位源码，不依赖特定安装目录。行号只适用于对应源码版本，函数名和类名是更稳定的检索入口。

文件工具示例中的 `/memories/`、`/skills/` 等以 Backend 根目录为起点，属于工具协议中的路径，与源码引用的相对路径不同。它们映射到哪种存储，由 Backend 配置决定。

## 二、源码阅读与运行依赖分别标注

| 对象 | 版本 | 使用位置 |
| --- | --- | --- |
| Deep Agents SDK 源码 | 0.6.12 | 系列主要分析对象 |
| Deep Agents Evals | 0.0.1 | 第 16、21 篇的评测实现 |
| QuickJS 解释器源码 | langchain-quickjs 0.3.3 | 第 22、23 篇动态子代理、解释器与 PTC |
| LangChain 仓库源码 | LangChain 1.3.7、Core 1.4.6 | 部分篇章对照 Agent 装配和中间件机制 |
| LangGraph 仓库源码 | 1.2.10 | 第 03 篇的增量通道与恢复机制 |
| 流式接口依赖 | LangChain 1.3.14、Core 1.5.1、LangGraph 1.2.9 | 第 18 篇的接口签名与返回契约 |
| 供应商适配 | LangChain Anthropic 1.5.2、LangChain AWS 1.7.6 | 第 17 篇的缓存中间件 |

这些版本对应不同的分析对象，不能拼成一套统一的安装组合。涉及下层框架或供应商接口时，以对应篇章标出的版本为准。

第 22、23 篇使用 Deep Agents 仓库中的 `libs/partners/quickjs/` 源码。该包的 `pyproject.toml` 要求 Python 3.11+、LangChain 1.3.14+ 和 `quickjs-rs>=0.2.4,<0.3.0` 等依赖，不能直接沿用表中的 LangChain 1.3.7 源码阅读版本作为运行依赖。这两篇核对源码与已有测试断言，阅读基线不代表一套已经通过端到端运行的安装组合。

## 三、故障注入脚本

`scripts/deepagents/reproduce-boundaries.py` 包含 Memory 快照、远端启动响应丢失、评分与产物检查三个场景。参考依赖为 Python 3.13.5、LangChain 1.3.14、Core 1.5.1、LangGraph 1.2.9、LangGraph SDK 0.4.2、LangChain Anthropic 1.5.2 和 Pydantic 2.13.4；Deep Agents 从 `--source-root` 指定的源码仓库导入。

以下命令假设 Deep Agents 仓库与文档仓库同级，目录名为 `deepagents`。在文档仓库根目录执行：

```powershell
python scripts/deepagents/reproduce-boundaries.py --source-root "../deepagents" --output "scripts/deepagents/results/boundaries.json"
```

脚本用模拟客户端和固定评分结果控制故障条件，不连接真实模型或远端服务。输出中的 `all_boundaries_reproduced` 表示这些条件下的行为符合预期，不代表业务系统已经通过交付验收。故障条件与源码行为见 [21：故障路径与边界验证](21-production-failure-validation.md)。
