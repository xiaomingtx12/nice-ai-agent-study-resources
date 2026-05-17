---
sidebar_position: 2.1
---

# 平台的 LangChain 组件抽象

如果把 LangGraph 看成“流程骨架”，那 LangChain 在这个项目里更像“标准零件库”。

它不直接决定整个平台怎么编排，但模型接入、提示词模板、输出解析、工具协议、消息对象、RAG 文本链路，几乎都靠 LangChain 这一层收口。

> 这是一篇补充理解文档，不是主线入口。更适合在读完总览、运行时、工具层和知识库之后回看。

## 先建立阅读坐标

- 这篇在主线里的位置：补充篇，用来解释 LangChain 在平台里承担的“组件协议层”角色。
- 带着这两个问题读：
  1. 平台为什么大量复用 LangChain，但没有把整条执行控制完全交给它。
  2. LangChain 到底在哪些地方提供了可复用的标准零件。
- 先记住的对象：`BaseLanguageModel`、`ChatPromptTemplate`、`BaseTool`、`Retriever`、`Runnable`。

## LangChain 在这里不是一个大一统 Agent 框架

这类项目里最容易混淆的一点，是把 LangChain 和 LangGraph 当成一回事。

放回这个项目里看，更准确的分工是：

- LangChain 负责组件抽象和统一协议
- LangGraph 负责状态和控制流编排
- 平台自己的 service 和 runtime 再把两者包成真正可运行的产品能力

## 可以把它拆成六个部分

### 1. 模型接口

- 平台没有直接把各家模型 SDK 散着调用，而是基于 LangChain 的 `BaseLanguageModel` 统一模型协议
- Provider 差异先在适配层吸收，平台再往上补 `features`、`metadata`、价格、上下文等治理信息
- 这样上层拿到的始终是统一模型对象，而不是一堆厂商特例

### 2. Prompt 与输出链

- 很多 AI 小能力本质上都是 `Prompt | LLM | Parser`这样的LCEL链
- `ChatPromptTemplate` 负责把提示词从字符串拼接提升成标准消息模板
- `StrOutputParser` 负责落纯文本，`with_structured_output` 负责落结构化对象
- 这让摘要、命名、建议问题、配置生成这类能力能复用同一套装配方式

### 3. 工具协议

- 这个项目最重要的 LangChain 落点之一，是把外部能力统一收敛到 `BaseTool`
- Builtin Tool、API Tool、MCP Tool、Workflow Tool、Dataset Retrieval Tool 最终都变成同一种可调用对象
- 统一之后，Agent、App 和 Workflow 才能共享同一套工具注入方式

### 4. 消息协议

- Agent 不是普通字符串问答，而是 `SystemMessage`、`HumanMessage`、`AIMessage`、`ToolMessage` 共同参与的消息状态
- 多模态输入、工具结果回传、上下文重写都建立在这层协议之上
- 这也是平台后面能做事件流、会话记忆和调试回放的基础之一

### 5. RAG 文本链

- 文档进入平台后，不是直接丢给模型，而是沿着 `Document -> Loader -> Splitter -> Embeddings -> VectorStore -> Retriever` 这条标准链路往下走
- `langchain_community` 承担多格式加载，`langchain_text_splitters` 负责切分，`langchain_weaviate` 和 `FAISS` 承担索引，`EnsembleRetriever` 负责融合召回
- 这样知识库能力就不是一堆零散脚本，而是一套可替换、可组合的文本处理管道

### 6. 可组合运行单元

- `Runnable`、LCEL、`RunnableParallel` 让平台不只能写直线链，还能写并行链、可复用链和统一执行对象
- 这也是为什么 Agent、Workflow 节点、AI 小功能都能用比较一致的调用方式
- LangChain 在这里提供的不是“神奇能力”，而是低摩擦的组合能力

## 这个项目为什么没有直接用 LangChain 内置 Agent

因为平台真正难的，不是“能不能跑一次工具调用”，而是：

- 状态怎么保存
- 条件分支怎么控制
- 循环怎么退出
- 事件流怎么统一
- 调试、发布、中断和治理怎么补齐

这些更像 LangGraph 和平台 runtime 要解决的问题。

所以这个项目的路线不是“抛弃 LangChain”，而是：

- 继续大量复用 LangChain 组件层
- 不把执行控制权完全交给 LangChain 内置 Agent
- 用平台自己的编排层把这些零件重新装成更可控的系统

## 最值得学的工程判断

### 1. 以 `langchain_core` 为协议中心

不是绑定某一家模型 SDK，而是先拿统一协议做底座。

### 2. 把外部能力优先做成 `BaseTool`

一旦统一成工具，对 Agent、Workflow、App 的复用价值会立刻上来。

### 3. 把 RAG 当成组件链，而不是一段服务逻辑

这样替换向量库、切分规则、召回策略时，成本会低很多。

### 4. 不滥用黑盒能力

项目没有把所有问题都交给高级封装，而是只复用真正稳定的标准组件。

## 建议阅读路径

建议按这条线看：

- 先看 [平台定义与总览](./platform-definition-and-overview.md)，明确 LangChain 在整个平台里只是其中一层
- 再看 [工具与外部能力平台](./tools-and-external-capabilities.md) 和 [知识库与检索链路](./knowledge-base-and-retrieval-pipeline.md)，因为 `BaseTool` 和 RAG 组件链最能体现 LangChain 的价值
- 最后再接 [Agent 运行时与记忆机制](./agent-runtime-and-memory.md)，更容易理解为什么平台没有把执行层完全交给 LangChain

## 这一层的关键判断

这个项目里 LangChain 最重要的价值，不是“帮你快速搭一个 Agent demo”，而是提供了一整套稳定的组件协议。

模型、Prompt、Parser、Tool、Message、Retriever 这些零件一旦标准化，平台后面的编排、治理和复用才有可靠底座。

## 回到主线时先带走什么

1. LangChain 在这套平台里主要负责协议和可组合零件，不是整个系统的执行总控。
2. 统一的模型、消息、工具、检索协议，是平台后面做编排和治理的基础。
3. 真正理解这一篇之后，再回看 Agent、Tool、RAG 三篇，会更容易看清哪些部分是平台补的，哪些部分是框架给的。
