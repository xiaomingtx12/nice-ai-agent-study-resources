---
sidebar_position: 3
---

# 怎么把它和别的 Agent 资源搭配着学

- 来源：[https://learn.shareai.run/zh/s01/](https://learn.shareai.run/zh/s01/)
- 参考仓库：[https://github.com/shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)

## 我不会单独只学这一条

这条资源很强，但我不会把它当唯一主线。

原因很简单：它的焦点很尖，尖到它更适合解决“Claude Code 类 harness 是怎么搭起来的”这个问题，而不是负责整个 Agent 学习地图。

所以我更愿意把它和站里另外两条资源搭配着看。

## 我会怎么配

### 和 HelloAgents 搭

`HelloAgents` 更像地图，负责把 Agent 这件事的主线拉开。

`Learn Claude Code` 更像局部放大镜，负责把一个具体产品方向拆透。

如果我先用 `HelloAgents` 建立了“工具、记忆、上下文、评估、协作”这些模块感，再来看这条资源，就更容易看出 Claude Code 类产品到底把哪些模块做得更工程化了。

### 和 AI Agent Book 搭

`AI Agent Book` 更偏架构模式和生产治理。

`Learn Claude Code` 更偏产品机制和运行时组织。

这两个放在一起很有意思：一本告诉你系统复杂度会在哪里长出来，另一条告诉你一个具体 agent harness 是怎么把复杂度装进机制里的。

如果只看其中一个，很容易要么太抽象，要么太具体。

## 我会优先看哪一段

如果我当前最关心的是 coding agent 的基本手感从哪来，我会先看：

- `s01` Agent 循环
- `s02` 工具使用
- `s03` 待办写入
- `s04` 子代理
- `s05` 技能系统
- `s06` 上下文压缩

这几节已经足够把“为什么它不像一个裸模型”讲清楚。

如果我再往后关心更完整的系统能力，才会继续看权限、任务系统、后台任务、Agent 团队和隔离执行。

## 一个实际判断

这条资源最适合在你已经开始把 Agent 当“产品机制”来看的时候进入。

如果你现在还在问“Agent 和 workflow 到底差在哪”“tool_result 为什么要回写消息历史”，那它当然也能帮你，但最好搭着更地图型的资源一起学，不然容易只记住 Claude Code 的形状，而没建立更广的框架。
