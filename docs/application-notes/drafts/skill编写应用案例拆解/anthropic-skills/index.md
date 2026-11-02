---
sidebar_position: 1
title: "Anthropic Skills：两个案例的源码入口"
description: 以 anthropics/skills 快照中的 skill-creator 和 mcp-builder 为对象，沿源码入口、调用链和输出证据拆解 Skill 实现。
---

# Anthropic Skills：两个案例的源码入口

## 选哪两个案例

这份仓库中的 Skill 分别处理文件产物、协议接入、浏览器测试、视觉设计和通信内容。它们都从 `SKILL.md` 进入，但实现约束不同。本组先拆两个职责相反的案例：

- [`skill-creator`](./skill-creator)：输出另一份 Skill，以及这份 Skill 的评测和迭代记录；
- [`mcp-builder`](./mcp-builder)：把外部服务组织成 MCP 工具，并用真实任务检查工具表面是否可用。

前者回答“能力模块怎样被生产”，后者回答“外部能力怎样被模型调用”。选这两个案例，是为了沿实现链观察 Skill 的编排层、资源层和评测层，而不是为了覆盖清单中的所有目录。

## 阅读方式

两篇正文都遵循同一阅读顺序：

```text
入口文件
  → 中间状态与调用者
  → 下游消费的字段或协议
  → 失败路径与宿主边界
  → 工程代价
```

正文会把以下三类内容分开：

- **源码事实**：函数、字段、控制流和脚本输出可以直接在快照中找到；
- **Skill 文档建议**：`SKILL.md` 或 `reference/` 要求模型采用的工作方式；
- **工程判断**：根据前两者推导出的适用范围和代价。

`anthropic-skills/writing-rules.md` 负责总结这种分析方法；案例文章负责给证据。总览不重复解释合同、渐进披露和评测细节。

## 当前正文

- [skill-creator：把 Skill 生产组织成评测闭环](./skill-creator)
- [mcp-builder：把外部服务组织成模型可调用的工具表面](./mcp-builder)

`.skill` 文件、Claude Code 的临时 command 文件和各宿主的执行能力不在同一层。案例文章会分别说明它们出现在哪里，不把测试辅助路径写成 portable package 规范。
