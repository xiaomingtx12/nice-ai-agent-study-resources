---
sidebar_position: 0
title: Open SWE × Deep Agents 源码解析
sidebar_label: 系列导读
description: 按总体架构、编码主线、支撑机制和协作扩展四部分阅读 Open SWE，先读通请求到代码交付，再深入状态、观测、测试与审查。
---

# Open SWE × Deep Agents 源码解析

Open SWE 是面向工程团队的编程 Agent，接收代码任务，在沙箱里调查、修改和验证，通过 PR 交付。本系列沿这条工作路径解释它的工程实现，再分别展开贯穿运行的支撑机制和审查扩展。

**篇章编号表示阅读顺序，不表示程序按这些编号依次执行。** 中间件、状态保存和运行记录贯穿多处调用；机器审查与人工合并按条件接入，不是每次编码任务的必经阶段。

## 一、总体架构：先知道各部分在哪里

| 文章 | 本篇回答什么 |
| --- | --- |
| [00：整体架构](./00-overview/00-project-and-frameworks.md) | HTTP 应用、执行图、平台调度、沙箱和存储怎样连接？请求怎样变成异步运行？ |

这一部分提供理解后续源码所需的系统图、运行模型和状态边界，不逐项展开实现。

## 二、编码主线：从请求到代码交付

这部分沿一个编码任务阅读：**接收请求 → 装配 Agent → 理解规则怎样接入 → 准备模型上下文 → 操作工作环境 → 协调长任务 → 交付代码。**

| 文章 | 为什么在这里读 |
| --- | --- |
| [01：请求接入](./01-coding-agent/01-input-thread-and-workspace.md) | 确认请求者、定位线程、选择工作空间并记录凭据范围，为装配提供输入。 |
| [02：Agent 装配](./01-coding-agent/02-deep-agent-assembly.md) | 看运行配置怎样变成模型、工具、后端与中间件的组合；它是后面几个专题的入口。 |
| [03：中间件接入](./01-coding-agent/03-middleware.md) | 解释装配后的规则挂在哪里、按什么顺序执行。它是主线中的机制专题，不是独立执行阶段。 |
| [04：上下文管理](./01-coding-agent/04-context-skills-and-offloading.md) | 沿中间件接入点，看外部消息、系统提示、Skills 与历史压缩怎样组成模型输入。 |
| [05：沙箱生命周期](./01-coding-agent/05-sandbox-lifecycle.md) | 从模型输入转到工具动作：代码与命令落在哪里，环境怎样创建、共享与重连。 |
| [06：执行协调](./01-coding-agent/06-delegation-and-continuation.md) | 有了执行环境，再看 fork、worker、长命令、追加消息与定时触发怎样交接。 |
| [07：代码交付](./01-coding-agent/07-pull-request-and-approval.md) | 将工作树改动变成经过权限检查的远端分支与 PR，并记录任务关联。 |

主线读到代码交付即可形成完整认识。遇到检查点或日志时，只需先掌握概览中的职责；需要查看表结构、回放和失败窗口，再进入第三部分。

## 三、支撑机制：保存、观察与验证

这部分按工程问题展开。它们在运行期间就已工作，放在主线之后是阅读上的安排，不表示代码交付后才开始保存和记录。

| 文章 | 本篇回答什么 |
| --- | --- |
| [08：状态与持久化](./02-runtime-support/08-state-and-persistence.md) | thread、run、task、checkpoint、业务表与工作成果各由谁保存？恢复与清理边界在哪里？ |
| [09：运行记录与结算](./02-runtime-support/09-observability-and-validation.md) | 平台事件流与 transcript 怎样展示、回放和归因？费用与完成结果怎样结算？ |
| [10：测试与评测](./02-runtime-support/10-testing-and-evaluation.md) | 用哪些行为测试验证实现，用哪些评测检查 Agent 输出质量？ |

状态篇解释记录如何保存，观测篇解释记录怎样被采集、使用和结算。测试篇区分确定性行为回归与模型质量评测；其中 Reviewer 评测部分可以在读完机器审查后回看。

## 四、协作扩展：独立审查与合并

| 文章 | 本篇回答什么 |
| --- | --- |
| [11：机器审查](./03-review-and-merge/11-reviewer.md) | 独立 Reviewer 怎样选定审查版本、保存问题、发布意见并跨提交复查？ |
| [12：人工评审与合并](./03-review-and-merge/12-human-review-and-merge.md) | 人工审查请求怎样推进，批准与合并怎样绑定到具体提交并重新校验？ |

这两篇属于不同的协作机制，不是“机器审查通过后必然进入人工合并”的固定流水线。只研究编码 Agent 的读者，可以在需要接入审查与合并时再读。

## 五、怎样使用这份目录

首次阅读按 **00 → 01—07 → 08—10** 建立系统认识；11—12 作为扩展。若只想先追通一条调用链，可读 **00 → 01 → 02 → 05 → 06 → 07**，再回读中间件和上下文细节。

正文中的跨篇链接用于追查当前机制，不要求每次都跳转读完整篇。每篇开头标明所属部分和讲解边界，末尾按本目录连接前后篇。

框架内部的通用循环、文件工具、Skills 和摘要另见 [Deep Agents 系列](../../langchain-series/deepagents/index.md)。该系列与本案例可能使用不同版本，交叉链接只用于概念延伸，不替代当前依赖的实现证据。

## 六、源码与证据范围

研究对象是 [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe)，包版本 `open-swe-agent 0.1.0`，依赖 `deepagents==0.7.21`。分析基线为提交 [`0942b41561df`](https://github.com/langchain-ai/open-swe/tree/0942b41561df7db968f3be7f1c5150819bdec6b8) 及已记录的本地改动，详见[源码基线与证据范围](./source-baseline.md)。

本系列依据静态源码、配置和测试断言写作，没有运行 Open SWE 服务、测试或模型评测。系统提示是对模型行为的要求，不等于程序保证。桌面 UI 内部、每种沙箱供应商的完整实现和部署运维体系不在覆盖范围内。团队模型路由实验另见[模型路由博客解读](../../../product/blog-cases/development-operations/open-swe-model-routing.md)。
