---
sidebar_position: 99
description: "MCP（Model Context Protocol）暂缓页 —— 按当前判断不建独立工程技巧篇（不主流、样本偏协议层）。本页保留作为旧链接的兼容入口，并归档原 MCP 相关判断与样本。"
---

# MCP

按当前判断**暂缓不建独立工程技巧篇**。原因：
- MCP 不算主流，样本（cc-15、dify-12）偏协议层介绍与框架特性罗列，写出来容易变成协议说明而非工程技巧
- 等真正工程需求出现或主流样本到位再补

## 与 Skill 篇的关系

原 MCP 与 Skill 设计篇已拆分为两篇：

- **Skill →** [agent-skill-design.md](./agent-skill-design.md)，聚焦领域 Prompt 经验封装的工程技巧（触发机制、上下文生命周期、when_to_use 字段权重、路径感知激活、与 CLAUDE.md 边界）
- **MCP →** 即本页，暂缓

两者核心张力不同：
- Skill：经验复用 ↔ 激活时机
- MCP：工具跨进程复用 ↔ 认证/版本/可发现性代价

混在一起会丢失张力，拆开后两篇各自的判断、检查点、反模式都更聚焦。

---

## 暂缓页保留的判断（待 MCP 真有工程需求时再启用）

工具膨胀到 30+ 时 schema 全量注入必须切到"分层 + 截断" —— `MAX_MCP_DESCRIPTION_LENGTH = 2048` 截断 + `SKILL_BUDGET_CONTEXT_PERCENT = 0.01` 整体预算。

MCP 的"USB 即插即用"是有代价的 —— 认证、断连、版本管理。`protocolVersion` 字段做 schema 版本协商。

MCP 工具的语义元数据（annotations）必须强制设置，不能信任 server 自报 —— `readOnlyHint` / `destructiveHint` / `openWorldHint` 作为 hint 不作为安全决策依据。

---

## 暂缓页保留的样本索引（待 MCP 真有工程需求时再启用）

- [cc-15 §一 解决什么问题](../../application-notes/engineering/claude-code-cli/cc-15-mcp-integration.md)
- [cc-15 §三 3 transport 与配置作用域](../../application-notes/engineering/claude-code-cli/cc-15-mcp-integration.md)
- [cc-15 §三 4 注册机制](../../application-notes/engineering/claude-code-cli/cc-15-mcp-integration.md)
- [cc-15 §四 5 工具调用执行](../../application-notes/engineering/claude-code-cli/cc-15-mcp-integration.md)
- [cc-15 §四 6 断连与重连](../../application-notes/engineering/claude-code-cli/cc-15-mcp-integration.md)
- [dify-12 §一 Server 暴露](../../application-notes/engineering/dify/dify-12-mcp-protocol.md)
- [dify-12 §二 Streamable HTTP vs SSE](../../application-notes/engineering/dify/dify-12-mcp-protocol.md)
- [dify-12 §四 Session 生命周期](../../application-notes/engineering/dify/dify-12-mcp-protocol.md)

---

## 何时补独立篇

满足以下任一条件时，把本页改造成正式工程技巧篇：

- 真实项目里 MCP 跨进程调用成为瓶颈（如认证、断连、版本管理频繁出问题）
- MCP 成为主流协议，涌现大量工程技巧样本（不只是协议说明）
- 简历项目里 MCP 集成是核心工程亮点，需要沉淀判断

补篇时按 [index.md 写作方法](./index.md) 的章节结构写：动机 / 关键判断速览 / 工程化要点 / 反模式 / 何时不该用 / 样本索引。