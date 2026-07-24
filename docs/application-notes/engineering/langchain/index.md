---
sidebar_position: 1
description: LangChain 1.3.7 `create_agent()` 源码拆解。从 factory.py 的五个构建阶段（归一化 → 中间件组合 → 状态解析 → 图拓扑组装 → 编译配置）切入，看 LangGraph 五种能力如何被压成一行声明式 API。
---

# LangChain 架构拆解

这一组聚焦 LangChain v1（langchain 1.3.7）的源码级拆解，从 `create_agent()` 这个最高层入口开始，沿真实执行顺序钻进 `factory.py` 的五个构建阶段，逐步展开归一化、中间件体系、状态解析、图拓扑组装、编译配置与流式转换。

## 关于版本与源码引用

LangChain v1 仓库下 `libs/langchain_v1/` 是拆分出来的 v1 代码树，`create_agent` 的全部实现集中在 [`libs/langchain_v1/langchain/agents/`](../../../../open_code/ai-native/langchain/libs/langchain_v1/langchain/agents/) 一棵子树里。所有正文里的源码行号以 1.3.7 版本为准，引用格式为 `factory.py:L942-L1056`，可直接在本地仓库打开对照。

## 这一组怎么读

`create_agent` 是一切的汇聚点：从用户视角看是一行声明式 API，从内部看是把 LangGraph 节点/边、`bind_tools`、`ToolNode`、`Checkpointer`、中间件钩子这五种已有原语按五步流水线拼装起来的胶水层。读懂这个胶水层之后，再去读 LangGraph 文档里那些看起来零散的特性，会发现它们就是这五步的拼装件。

[./lc-01-create-agent.md](./lc-01-create-agent.md) — 5 个构建阶段、6 个中间件钩子、3 套 schema 解析、5 种 transformer、6 个使用场景。

## 配套约定

- **行号引用**：正文用 `factory.py:L942-L1056`、`types.py:L85-L267` 这种格式指明位置，对照 `libs/langchain_v1/langchain/agents/` 直接打开即可。
- **代码块**：源码片段保持精简，能用一两行说清的不堆整段；上下文足够时直接给行号 + 一行说明，跳过源码本身。
- **判断与边界**：每篇结尾给出「与手写循环的对比」式工程判断，标清哪些设计值得照搬、哪些有隐性代价、什么时候不适用。