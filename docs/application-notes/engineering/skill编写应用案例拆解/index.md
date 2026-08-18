---
sidebar_position: 4
description: 以 Anthropic Skills 的两个源码案例为对象，拆解 Skill 如何组织指令、资源、工具协议和评测链路。正文只做实现分析，不写通用复刻教程。
---

# Skill 编写应用案例拆解

这里研究 Skill 的实现结构，不写“如何照着做一个 Skill”的教程。文章以源码中的入口、调用关系、数据契约和失败边界为主，源码摘录只保留支撑判断的最小片段。

## 当前案例

- [Anthropic Skills：两个经典案例的实现边界](./anthropic-skills)
- [Matt Pocock Skills：可组合工程 Skill 的编写与工作流](./skills-grill)

Anthropic Skills 这组文章固定分析本地 `D:\open_code\skills` 快照中的两个案例：

- `skill-creator`：一个负责生产、评测和优化其它 Skill 的元 Skill；
- `mcp-builder`：一个把外部服务组织成模型可调用 MCP 工具的协议 Skill。

前者分析“Skill 如何被生产和检验”，后者分析“模型如何通过工具表面完成外部任务”。两篇文章共同关注实现细节，不把其它尚未拆解的 Skill 写成已完成案例。
