---
sidebar_position: 0
title: Deep Agents 应用案例解析
description: 从知识 Wiki 与编程交付两种真实应用，研究 Deep Agents 的装配、上下文、执行环境和业务收尾。
---

# Deep Agents 应用案例解析

本栏沿真实应用的调用链，研究 Deep Agents 的通用能力怎样接到具体任务。框架提供模型与工具循环、文件后端和任务委派，应用还要决定证据从哪里来、谁能执行哪些操作、结果怎样保存与交付。

## 一、按应用问题选择系列

| 应用 | 面向谁、完成什么任务 | 主要工程问题 |
| --- | --- | --- |
| [OpenWiki](./openwiki/index.md) | 把代码仓库与个人知识源编译成可增量维护、可检索的 LLM Wiki | 页面规划、受限 worker、逐页恢复、Claims 证据与跨仓库检索 |
| [Open SWE](./open-swe/index.md) | 帮助工程团队实施代码任务、交付 PR 并持续审查 | 请求线程、Agent 装配、沙箱恢复、上下文、异步续接、审批与验收 |

每个系列都固定自己的源码提交与依赖。OpenWiki 使用 TypeScript/JavaScript Deep Agents，Open SWE 使用 Python Deep Agents；同名能力需要回到各自版本核对，不能直接互换内部实现结论。

## 二、应用文章与框架文章怎样衔接

想理解通用 API 与框架机制，可以先阅读 [LangChain 系列](../langchain-series/index.md)。应用案例重点回答这些接口进入真实项目后，还需要补充哪些状态、权限、失败处理和交付规则。

例如，OpenWiki 需要让页面正文、事实证据和完成进度一致落盘；Open SWE 需要把沙箱中的改动关联到真实 PR。两者的完成条件由各自业务决定，不能只以模型停止调用工具作为成功依据。
