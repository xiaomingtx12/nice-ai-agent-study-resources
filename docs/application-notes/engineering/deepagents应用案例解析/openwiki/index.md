---
title: OpenWiki × Deep Agents 源码解析
description: 从源码理解 LLM Wiki 的生产机制、Agent 消费方式，以及 Deep Agents 如何提供文件工作台和生命周期扩展。
sidebar_position: 0
---

# OpenWiki × Deep Agents 源码解析

> 源码版本：OpenWiki `0.2.4`，Deep Agents `1.11.1`。

这组文章只抓两条主线：

1. OpenWiki 怎样把代码和外部材料整理成一份可以持续更新的 LLM Wiki，以及生成后的 Wiki 怎样被 Agent 按需读取；
2. OpenWiki 怎样使用 Deep Agents，而不是重新实现一套 Agent 框架。

CLI、凭据、provider 分支和遥测属于运行外围。它们只在能解释主链时出现，不单独展开。

## 先记住一条主链

```text
代码 / Git / Connector
→ 受限证据
→ RunContext + Prompt
→ createDeepAgent
→ 模型与工具循环
→ Backend 写入 Wiki
→ Middleware 做结构收尾
→ 快照 / metadata 支持下一次 update
```

这条链里，模型负责理解和写作；程序负责证据入口、文件边界、结构校验和运行状态。两者混在一起，就很难判断哪些行为可靠，哪些只是模型当前愿意遵守的指令。

## 文章导航

| 文章 | 主要问题 | 核心源码 |
| --- | --- | --- |
| [00：LLM Wiki 怎样生产并被 Agent 使用](./00-project-overview.md) | Wiki 怎样生成、落盘，并通过 Wiki-first 和文件工具给 Agent 使用？ | `src/agent/index.ts`、`src/agent/prompt.ts`、`src/code-mode.ts` |
| [01：证据如何进入 Wiki](./01-connectors-and-ingestion.md) | Git、Connector、MCP 和 raw 文件怎样进入 Agent？ | `src/connectors/`、`src/ingestion.ts` |
| [02：Deep Agents 的装配与能力边界](./02-agent-assembly.md) | 规则与配置怎样进入 Prompt、Backend、Middleware，`createDeepAgent` 和 OpenWiki 扩展能力怎样协作？ | `src/agent/index.ts`、`src/agent/prompt.ts`、`src/agent/docs-only-backend.ts` |
| [03：Wiki 怎样持续维护](./03-wiki-maintenance.md) | Middleware、状态、失败恢复和验证怎样组成闭环？ | `src/agent/*middleware.ts`、`src/agent/utils.ts` |

## 推荐阅读

- 想理解 LLM Wiki：`00 → 01 → 03`
- 想理解 Deep Agents 的用法：`02 → 03`
- 想看完整源码链：`00 → 01 → 02 → 03`

## 分析边界

本文只把结论分成三类：

- **源码事实**：当前 OpenWiki 或 `deepagents@1.11.1` 代码直接表现出的行为；
- **测试预期**：测试和评测代码明确要锁定的条件。本组文章不把未运行的测试写成“已通过”；
- **工程推导**：由调用链、状态和边界推导出的适用范围，会明确标注为判断。

Python Deep Agents 和 OpenWiki 使用的 TypeScript/JavaScript Deep Agents 可以做概念对照，但不能直接互换文件名、默认值或执行顺序。
