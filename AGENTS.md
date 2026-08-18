# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## 站点结构

这是一个中文 Docusaurus 文档站点，内容分为资源导航、应用拆解、方法与复盘三栏。

### 资源导航：`docs/resources/`

按资源用途分组：

- `tutorials/`：通用 Agent 系统教程
- `references/`：模式与生产参考
- `coding/`：AI 编程上手
- `mechanism/`：Coding Agent 机制拆解
- `systems/`：真实系统源码
- `harness-agent/`：Harness Agent 框架

资源页面按实际内容组织，不强制统一模板。一个资源可以只有介绍页，也可以包含评析、阅读笔记或中文走读。新增资源时先参考同组现有目录和页面结构。

### 应用拆解：`docs/application-notes/`

按方向分组：

- `engineering/`：Dify、Claude Code CLI、LangChain 系列、Deep Agents、Skill 编写案例等工程实现拆解
- `product/`：产品业务方向，目前是占位区

应用拆解按项目和具体价值点展开，不使用所有项目通用的固定文章模板。正文应落到真实问题、源码位置、上下游约束、实现代价和适用边界。

### 方法与复盘：`docs/notes/`

按主题分组：

- `evolution-trends/`：演变趋势观察
- `agent-product-method/`：Agent 产品思维
- `agent-system-design/`：Agent 工程技巧和系统设计
- `tool-mastery/`：工具应用与驾驭
- `market-observation/`：市场观察

这里存放跨资源、跨项目可复用的判断、模式和技巧，不放单条资源介绍或日常流水账。skill/workflow 回灌闭环仍在建设中。

`docs/index.md` 是首页；`docs/about/` 和 `docs/ai-relay/` 是不挂侧栏的独立页面。



## 主题代码

`src/` 是 Docusaurus 主题扩展层：

- `src/css/custom.css`：全站样式和主题变量
- `src/components/`：主题切换、路由进度、媒体灯箱等自定义组件
- `src/theme/`：搜索、Mermaid、代码块等 Docusaurus 主题扩展
- `src/lib/`：主题状态、搜索适配和构建期 stub
- `src/theme/Root.tsx`：全站 Provider 和媒体灯箱的挂载入口

修改主题时先阅读相邻实现，优先复用现有组件和样式，不要无关地引入依赖或进行大范围重构。

## 文章编写规范

- 内容务实、准确、简洁；删掉重复判断、空泛铺垫和不产生判断的内容。
- 先结论后依据，用清晰的小标题和短段落组织；段落、列表和代码块之间留出空间，避免排版过密。
- 解释机制时展示真实源码中的核心片段，不使用自行编造的简化伪代码。代码须对应实际文件、函数和版本；省略内容时明确标注。
- 核心代码配必要的中文注释，说明关键分支、数据流、约束和副作用。不要贴完整文件，也不要只贴代码而不解释其作用。
- 不常见的英文技术名词首次出现时补充中文解释；`token`、`agent`、`worker`、`hook` 等稳定术语可以保留，但不要只堆单一英文名词。
- 库或框架专属的类名、函数名、概念（如 `DynamicStructuredTool`、`BaseCallbackHandler`、`RunnableLambda` 等）首次出现时，必须用一句话说清楚它是什么、用来解决什么问题，不能默认读者认识。
- 应用拆解要指出 README 看不到的实现细节，并给出照搬、改造、避免使用和适用边界等工程判断。
- 避免使用"首先、其次、最后、值得注意的是、需要指出的是、这意味着"等模板化衔接语和空泛总结；直接陈述结论、依据、代码行为与工程影响，让内容由事实和判断自然推进。
- 不做抽象宣言。类似"X 是通用操作面，Y 是具体实现，两者解耦"这种总结句，必须紧跟一个带着具体名字的例子（如"`openwiki_ingest_connector` 一个工具通过 `connectorId` 操作全部八个来源"），不能让它裸挂在段落末尾。
- 给文章中放关键代码时，如果原代码有对应英文注释，将其翻译成中文放在文档中。

注意：不要主动去做构建执行。