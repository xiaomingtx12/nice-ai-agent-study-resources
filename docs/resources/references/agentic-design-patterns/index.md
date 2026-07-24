---
sidebar_position: 1
description: Agentic Design Patterns 是同名书《Agentic Design Patterns》的中文翻译项目，把 Agent 系统里反复出现的设计模式系统整理成一册，追问组合方式、边界与成本。适合做过原型后用来把零散经验对到一套现成的模式语言上。
---

# Agentic Design Patterns（中文翻译）

- 官网：[https://adp.xindoo.xyz/](https://adp.xindoo.xyz/)
- 项目仓库：[https://github.com/xindoo/agentic-design-patterns](https://github.com/xindoo/agentic-design-patterns)

## 这条资源主要在讲什么

它是同名书《Agentic Design Patterns》的**中文翻译项目**，把原书对 Agent 设计模式的系统梳理搬到中文语境。内容不从零教你调通一个 demo，而是把 Agent 系统里反复出现的设计模式拎出来讲清楚。

更像一份模式手册：当你已经知道工具调用、工作流、规划、多 Agent、记忆这些词之后，继续追问它们在系统里该怎么组合、边界在哪里、什么时候值得用、什么时候只是把简单问题复杂化。所以它不是第一本入门教程，而是做过几个原型之后，用来把零散经验对到一套现成"模式语言"上的参考。

```mermaid
flowchart LR
  N["已知的能力名词<br/>工具调用 / 规划 / 反思 / 多 Agent / 记忆"]
  N --> QQ{"对每个模式追问"}
  QQ --> C["怎么组合"]
  QQ --> B["边界在哪"]
  QQ --> W["何时值得用 / 何时是过度复杂化"]
  C --> L["可复用的模式语言"]
  B --> L
  W --> L
```
