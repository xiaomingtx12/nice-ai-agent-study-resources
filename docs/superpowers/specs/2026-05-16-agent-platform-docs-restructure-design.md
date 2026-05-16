# Agent 开发平台文档重组设计

**Date:** 2026-05-16

## Goal

把当前 `application-notes` 下围绕 “Dify 型平台” 的整组文档，重组为一套更通用的 “Agent 开发平台” 文档体系。

这次重组不是简单换名字，而是要把文档主线改成一条真正可用于手搓实现的平台搭建路径。读者看完之后，应该能够同时理解：

- 这个平台在业务上要解决什么问题
- 平台核心能力之间如何串成完整业务流程
- 每个核心能力在工程上应该怎么拆、怎么实现、怎么协作
- 如果要自己动手做一版类似平台，应该按什么顺序搭起来

## Background

当前这组文档已经有足够多的有效内容，但组织方式仍然带着两类问题：

1. **命名过度依赖 Dify**
   - 现有主分类是 “Dify 型应用 / 一站式 Agent 开发平台实践”。
   - 这会让内容看起来像某个具体产品的模仿或拆解，而不是一套可复用的平台工程方法。
2. **主线与附录混在一起**
   - 正式正文、历史备份、准备文档同时并列存在。
   - 读者容易分不清哪些是主阅读路径，哪些只是源码级补充材料。
3. **模块深度足够，但手搓路径不够明确**
   - 现有文档已经覆盖 Agent、RAG、工具、工作流、多模型等内容。
   - 但它们更接近模块专题集合，还不是一条“能照着做出来”的实现主线。

## Design Decisions

本次设计确认以下决策：

1. **不保留 “Dify 型平台” 作为主分类表达**
   - 整组内容统一上提为 “Agent 开发平台”。
   - 允许在正文里继续引用现有项目或类 Dify 实现作为证据，但不再把 Dify 作为目录级组织中心。
2. **主线按“能手搓出来”的实现顺序组织**
   - 不是按纯产品模块平铺，也不是按松散项目复盘顺序展开。
   - 目标是让读者沿着一条工程依赖关系清晰的路径推进。
3. **记忆系统并入 Agent 主线**
   - 短期上下文、长期摘要、记忆注入、异步更新都属于 Agent 运行时的一部分。
   - 不再把“记忆”与“知识库检索”放进同一篇里。
4. **Workflow 保持独立成篇**
   - 它不是附属画布功能，而是平台第二条正式执行内核。
   - 需要以完整执行链路的规格单独讲清楚。
5. **保留三层结构**
   - 主线文档：真正面向阅读与手搓实现的核心体系
   - 实现附录：更偏源码级、链路级的深挖材料
   - 历史归档：保留旧版本表达，不参与主线导航竞争

## Success Criteria

重组完成后，这一栏应该满足下面几个标准：

- 读者进入分类页后，能直接理解“先看什么，后看什么”
- 每篇主线文档都同时覆盖：
  - 这一层解决什么业务问题
  - 这一层在整个平台中的位置
  - 它依赖哪些前置能力
  - 它暴露哪些能力给后续模块
  - 它如何落成可实现的工程模块
- 主线读完后，读者可以得到一条可执行的手搓路径
- 准备文档和历史备份不再抢占主阅读路径，但仍然可作为证据链和扩展阅读保留

## Target Information Architecture

这一组文档将被重组为四层：

1. `application-notes/index`
   - 作为“应用沉淀”总入口，继续解释这一栏的定位
2. `Agent 开发平台`
   - 这是新的核心分类
   - 内含主线文档、支持性说明、实现附录、历史归档
3. `实现附录`
   - 放置偏源码链路和具体实现拆解的材料
4. `历史归档`
   - 保留旧版组织与表达

## Category Structure

`Agent 开发平台` 分类内的目标结构如下：

### 1. 分类首页

- 作用：
  - 解释这组文档不是产品说明书，而是平台工程拆解
  - 给出推荐阅读顺序
  - 明确主线、附录、归档三层关系

### 2. 主线文档

主线采用 8 篇核心文档：

1. **平台定义与总览**
2. **配置资产与平台底座**
3. **Agent 运行时与记忆机制**
4. **工具与外部能力平台**
5. **知识库与检索链路**
6. **Workflow 编排引擎**
7. **发布、治理与异步执行**
8. **场景模板与手搓路线**

### 3. 支持性说明

- 保留一篇写作标准/文档标准说明
- 这篇不参与主线逻辑，但继续作为该分类的写法约束存在

### 4. 实现附录

- 将当前 `dify准备文档` 这一类源码级材料重新组织为附录
- 它们为主线提供证据，但不再作为主导航并列主体

### 5. 历史归档

- 保留当前 `diyf-type-application-bac` 这组内容
- 明确其身份是历史版本，不承担新读者入门职责

## Mainline Document Definitions

### 01 平台定义与总览

**Purpose**

先把这套平台到底是什么讲清楚，而不是一上来就进入某个组件细节。

**Must Cover**

- 平台面向哪些场景和使用者
- 用户如何从“想法”走到“一个可运行应用”
- 平台里的核心资产是什么：
  - 应用
  - 模型
  - 工具
  - 知识库
  - 工作流
- 为什么这不是聊天壳子，而是一套可装配、可治理、可发布的平台

**Primary Business Flow**

用户创建应用 -> 选择或配置模型 -> 接入工具/知识库/工作流 -> 调试 -> 发布 -> WebApp / API / 其他入口消费

**Primary Source Material**

- `one-stop-agent-platform-overview`
- `overall-architecture` 中的全局叙事部分

### 02 配置资产与平台底座

**Purpose**

解释平台为什么不是一组散乱功能，而是一套“配置资产驱动 + 运行时装配”的系统。

**Must Cover**

- 应用配置如何定义
- 模型配置如何定义
- 工具配置如何定义
- 知识库配置如何定义
- 工作流配置如何定义
- 草稿态、发布态、版本化与装配入口之间的关系

**Primary Engineering Question**

这些能力为什么可以被统一放进一个平台里，而不是每条链路都自己管理一套私有配置。

**Primary Source Material**

- `multi-model-integration`
- `tool-calling`
- `visual-workflow`
- `overall-architecture`

### 03 Agent 运行时与记忆机制

**Purpose**

把一次真实对话请求是怎样在平台里跑起来的讲清楚。

**Must Cover**

- 入口请求如何进入统一运行时
- 如何加载应用配置、模型、工具、知识库工具、工作流工具
- Function Calling / ReAct 双模式如何选择
- 事件流如何统一表达
- 会话中断与恢复如何处理
- 短期记忆如何裁剪和注入
- 长期摘要如何生成、何时异步更新、何时回注到主链

**Primary Business Flow**

请求进入 -> 装配上下文 -> 装配工具 -> 选择执行模式 -> 输出事件流 -> 写会话结果 -> 异步更新长期摘要

**Boundary Rule**

记忆在这一篇里讲；知识库检索不在这里展开，只引用其作为外部能力的接入点。

**Primary Source Material**

- `core-agent-layer`
- `multi-model-integration`
- `online-knowledge-base` 中关于记忆的部分
- 准备文档中的双模式 Agent 和队列/记忆相关材料

### 04 工具与外部能力平台

**Purpose**

解释平台如何把多种外部能力收口成统一运行时接口。

**Must Cover**

- Builtin Tool / API Tool / MCP Tool 的来源差异
- 它们为何最终统一成同一种运行时抽象
- 工具参数、调试、鉴权、执行如何组织
- Agent 与 Workflow 如何复用同一批工具

**Primary Business Flow**

工具被注册/导入 -> 工具被校验和持久化 -> 工具被调试 -> 工具在运行时被装配 -> Agent / Workflow 消费工具

**Primary Source Material**

- `tool-calling`
- 准备文档中的插件工具平台实现详解

### 05 知识库与检索链路

**Purpose**

只讲“外部知识如何进入平台并被消费”，不再混入会话记忆问题。

**Must Cover**

- 文档上传、解析、切分、索引
- 检索方式、召回、融合与结果消费
- 检索能力如何 Tool 化
- 检索结果如何服务 Agent 和 Workflow
- 知识库与记忆的边界

**Primary Business Flow**

文档进入 -> 处理和建索引 -> 查询触发 -> 召回融合 -> 注入或工具化复用

**Boundary Rule**

这篇只负责外部知识生产链与消费链；会话状态与长期摘要不放在这里。

**Primary Source Material**

- `online-knowledge-base`
- 准备文档中的 RAG 实现详解

### 06 Workflow 编排引擎

**Purpose**

把 Workflow 当成平台第二条正式执行内核来讲，而不是画布附属功能。

**Must Cover**

- 前端如何维护图 DSL
- 草稿图和发布图如何分离
- 调试门禁和发布门禁如何设计
- LangGraph 编译链如何建立
- 条件分支、并行汇聚、节点协议如何组织
- 工作流如何重新变成工具并回流到平台

**Primary Business Flow**

前端编辑 -> `draft_graph` 保存 -> 调试运行 -> 严格校验 -> 发布 `graph` -> 作为工具复用

**Primary Source Material**

- `visual-workflow`
- `langgraph-orchestration-kernel`
- 准备文档中的工作流实现详解

### 07 发布、治理与异步执行

**Purpose**

把平台从 demo 走向可交付系统所需的约束层补齐。

**Must Cover**

- 多租户与账号隔离
- API Key 隔离
- 后台任务与异步执行
- 发布门禁与运行态隔离
- 预算、失败恢复、可观测性、审计或运维约束

**Primary Engineering Question**

为什么这些内容不能散落在各篇里，而需要被明确收束为一层治理能力。

**Primary Source Material**

- `overall-architecture`
- `multi-model-integration`
- 准备文档中的队列、后台任务、多模型与运行治理相关材料

### 08 场景模板与手搓路线

**Purpose**

把前面拆开的平台能力重新装回几个实际场景，并给出真正可执行的手搓路径。

**Must Cover**

- 典型场景最小可行组合：
  - 智能客服
  - 企业知识助手
  - 内容生产/改写
- 每个场景需要哪些底座
- 哪些能力必须先做，哪些可以延后
- 手搓实现顺序建议

**Primary Output Style**

这篇应该读起来最接近一份工程落地指南，而不是平台术语解释。

## Supporting Document

现有“怎么把一篇 Agent 平台文档写得真正有用”这一类内容应继续保留，但角色改成：

- 该分类的写作标准
- 主线文档的内部质量约束
- 不参与平台能力主线本身的组织

## Appendix Strategy

当前 `dify准备文档` 里的材料不应继续以“准备文档”这种状态性命名暴露给读者，而应该改造成“实现附录”。

附录的职责是：

- 为主线中的抽象结论补源码证据
- 提供更细的链路级拆解
- 在不打断主线叙事的前提下，容纳长篇实现详解

附录适合保留的内容类型包括：

- LangChain 实现详解
- LangGraph 实现详解
- 双模式 Agent 运行链
- 插件工具平台与多模型统一管理
- RAG 链路详解
- Workflow 引擎详解
- 队列与后台处理机制

## Archive Strategy

当前 `diyf-type-application-bac` 继续保留，但需要被明确标记为历史归档。

归档的价值是：

- 留存旧版本表达
- 保留内容演化路径
- 方便后续对比重写前后的结构

归档不应再：

- 与主线并列占据同等导航权重
- 作为新读者的默认阅读路径

## Existing-to-New Mapping

### Retain and Rewrite Into Mainline

- `one-stop-agent-platform-overview`
  - -> `平台定义与总览`
- `core-agent-layer`
  - -> `Agent 运行时与记忆机制`
- `tool-calling`
  - -> `工具与外部能力平台`
- `online-knowledge-base`
  - -> `知识库与检索链路`
- `visual-workflow`
  - -> `Workflow 编排引擎`
- `multi-model-integration`
  - -> 主要拆入 `配置资产与平台底座`、`Agent 运行时与记忆机制`、`发布、治理与异步执行`
- `overall-architecture`
  - -> 主要拆入 `平台定义与总览`、`配置资产与平台底座`、`发布、治理与异步执行`

### Merge Rather Than Keep as Standalone Mainline Docs

- `langchain-component-abstractions`
  - 不再作为主线独立篇目
  - 其有用内容拆入 02 / 03 / 04
- `langgraph-orchestration-kernel`
  - 不再作为主线独立篇目
  - 其有用内容拆入 03 / 06

### Keep Outside Mainline

- `how-to-write-useful-dify-app-note`
  - 改成更通用的 Agent 平台文档写作标准
- `dify准备文档/*`
  - 重组为实现附录
- `diyf-type-application-bac/*`
  - 保留为历史归档

## Naming and Framing Rules

重写时需要遵守以下约束：

- 分类命名不再使用 “Dify 型” 作为核心表达
- 正文允许引用现有实现作为证据，但应回到更一般化的平台工程语言
- 每篇正文都要避免只列功能，要强制补齐：
  - 业务流
  - 状态与数据流
  - 模块边界
  - 工程代价
  - 复用方式
- 任何篇章如果只剩“框架介绍”价值，而没有平台落地价值，应被合并而不是单独保留

## Navigation Implications

后续实施时，导航需要体现以下变化：

- `application-notes` 下的主分类从 “Dify 型应用” 迁移为 “Agent 开发平台”
- 主导航优先展示主线文档
- “实现附录” 单独成组并默认折叠
- “历史归档” 单独成组并默认折叠
- 写作标准页作为支持说明保留，但不插入主线编号序列

## Path Strategy

为避免“概念已经改了，但路径还是旧命名”的混乱，后续实施应采用显式路径重组，而不是只改页面标题。

推荐路径策略：

- 新建或迁移主线目录到语义清晰的路径，例如：
  - `docs/application-notes/agent-development-platform/`
- 在该目录下承载：
  - 分类首页
  - 8 篇主线文档
  - 1 篇写作标准支持文档
- 将当前源码级长文迁移到该分类下的附录分组，例如：
  - `docs/application-notes/agent-development-platform/implementation-appendix/`
- 将历史备份迁移到该分类下的归档分组，例如：
  - `docs/application-notes/agent-development-platform/archive/`

相应地：

- `sidebars.ts` 需要切换到新的 doc id
- 主线正文之间的互链需要更新
- 旧的 `dify-type-application` 命名不再作为默认对外入口保留

这次设计不把“兼容旧 doc id 或旧 URL”设为优先目标；如果实施中发现保留旧路径成本很低，可以作为次级优化，但不应反过来主导新结构设计。

## Non-Goals

这次设计不包含以下内容：

- 不要求一次性补完所有正文内容
- 不要求在设计阶段直接重写所有文档正文
- 不要求新增与当前材料完全无关的平台模块
- 不要求把所有准备文档都提升为主线正文
- 不要求保留旧路径兼容性作为首要目标

## Verification

设计落地完成后，应能验证以下结果：

- 读者从分类页能看出明确的推荐阅读顺序
- 主线文档数量控制在可读范围内，不再出现旧有主线、准备文档、备份文档并列竞争
- 记忆被明确并入 Agent 运行时主线
- Workflow 仍然是独立主线篇目
- 知识库篇不再承担记忆说明职责
- 原有正文被清晰分流为：主线重写、附录保留、归档保留
