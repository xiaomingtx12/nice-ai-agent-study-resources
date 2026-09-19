---
title: OpenWiki × Deep Agents 源码解析
description: 沿证据准备、Agent 装配、页面写入和更新状态四条相接的调用链，理解 OpenWiki 的核心实现与适用边界。
sidebar_position: 0
---

# OpenWiki × Deep Agents 源码解析

> 源码基线：OpenWiki `0.2.4`，commit `3076d557f8a146e54cf0c6f3238f31a8d99a0537`；`pnpm-lock.yaml` 锁定 TypeScript/JavaScript 包 `deepagents@1.11.1`。下文路径均相对于 OpenWiki 仓库，不套用 Python Deep Agents 的实现。
>
> 主入口：`src/agent/index.ts` · `runOpenWikiAgent` → `runOpenWikiAgentCore`。

OpenWiki 把源码和外部材料整理成可继续更新的 Markdown Wiki。模型通过工具逐页读取、写入和修正；应用代码负责选择运行目录、提供证据、限制部分文件操作、同步索引和保存更新状态。

这组文章同时解释知识怎样组织、一次运行怎样执行：证据如何汇入概念页、正文链接如何表达关系、模型怎样选择受影响页面，以及文件写入后靠什么持续维护。

## 一次运行的主线

下图表示应用层调用顺序；写后校验发生在工具循环内部，页面收尾发生在事件流结束之前。

```text
CLI / 来源采集入口
  → runOpenWikiAgent
      加载环境和 Skills、忽略规则、update 跳过判断、模型配置
  → runOpenWikiAgentCore
      构造 RunContext、内容快照、模型、状态保存器和 Backend
  → createDeepAgent → streamEvents
      beforeAgent：翻译和旧页面迁移
      模型 ↔ 工具：读取证据、写入页面、返回结构错误
      afterAgent：Mermaid 降级、目录索引同步
  → 应用层收尾
      清理 _plan.md、比较内容快照、按条件写运行元数据
```

## 文章导航

| 文章 | 核心问题 | 主要入口 |
| --- | --- | --- |
| [00：LLM Wiki 怎样生产并被 Agent 使用](./00-project-overview.md) | 两种输出模式、概念页、语义关系和后续读取如何连接？ | `runOpenWikiAgent`、`createRunContext`、`createCodeModeAgentsSnippet` |
| [01：证据如何进入 Wiki](./01-connectors-and-ingestion.md) | Git 与来源证据怎样进入模型，再经过筛选、去重和冲突处理形成知识？ | `runSourceIngestion`、`readRawItem`、`callMcpConnectorTool` |
| [02：Deep Agents 的装配与能力边界](./02-agent-assembly.md) | 运行时怎样装配，模型又如何从源码变化选择页面并完成写入？ | `runOpenWikiAgentCore`、`OpenWikiLocalShellBackend` |
| [03：Wiki 怎样持续维护](./03-wiki-maintenance.md) | 页面改完后，翻译、校验、索引、no-op 与异常恢复怎样改变运行状态？ | `createOpenWikiIndexMiddleware`、`persistRunMetadataIfChanged` |

从 `00 → 01 → 02 → 03` 阅读可以跟完完整链路。关注文件权限时直接读 02；关注增量更新和失败恢复时直接读 03，每篇都在首次使用时解释必要概念。

02–03 使用同一个 raw 文件读取规则更新案例，串起“Git 变化 → 模型判断文档影响 → 工具编辑 → 结构校验 → 快照与更新记录 → 下一次 update”。案例基于当前真实函数和路径推演；模型工具顺序和页面选择属于说明性假设，与代码固定执行的分支分别说明。

## 阅读代码片段的约定

片段来自上述固定快照，只保留支撑当前解释的语句；不连续的节选会明确标出省略位置。中文注释用于说明关键条件，保留的原英文注释译成中文。示意调用链和产物目录使用文本块，与真实 TypeScript 源码分开。

正文中的“允许”“跳过”“恢复”都限定到具体入口。例如，文件工具的 docs-only 检查不能等同于宿主机 shell 隔离；`interrupted` 也不等同于文件回滚或从失败节点续跑。
