---
sidebar_position: 1
sidebar_label: 01：迭代总览
description: 平台功能与依赖版本总览、同类平台对比总览（慕课 LLMOps 原型、Dify、openagent、Yuxi、Octop）、Agent 开发平台的共同模块与工程难题，以及从 LangGraph 0.2 原型到 DeepAgents 运行时的迭代主线。
---
# 迭代总览：平台功能、同类对比与迭代主线

这个平台是一个 Agent 应用开发平台，在慕课 LLMOps 课程原型的基础上自行迭代开发，仓库独立维护。本篇先给平台的功能与依赖版本总览，再把几个 LangChain 系同类平台放进同一张表对比，从对比里提炼这类平台共同的功能模块与工程难题，最后按迭代顺序交代运行时从 LangGraph 0.2 原型到 DeepAgents 的换轨主线。

## 一、平台功能总览

平台当前的功能面，按 README 与源码核对：

| 能力域                | 内容                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| 应用管理              | 创建、编辑、发布、复制、回退应用配置，草稿与发布配置隔离                                      |
| 对话能力              | 工作台调试对话、Web App 对话、开放 API 对话                                                   |
| 工作流编排            | 工作流草稿、调试、发布与模板创建，发布后的工作流可工具化复用                                  |
| 知识库                | 数据集、文档、分段管理与检索，语义、全文与混合检索                                            |
| 工具扩展              | 内置工具、自定义 API 工具、MCP Server 工具                                                    |
| 模型接入              | 多供应商语言模型配置，填写 API Key 时显式发现并激活第三方模型                                 |
| 辅助能力              | 提示词优化、推荐问题、语音转文字、文字转语音                                                  |
| 账号与鉴权            | 登录/登出、OAuth 授权、API Key 管理                                                           |
| 文件能力              | 文件/图片上传、文档解析与分段                                                                 |
| 可观测性              | 会话、消息、推理轨迹与应用分析，主/子 Agent 的模型与工具调用数及 Token 用量                   |
| DeepAgents 任务工作台 | 任务规划、同步/异步子 Agent、Skills、按需长期记忆、沙箱执行、文件产物交付、独立测评与中断恢复 |

运行时与模型链路的依赖版本（`requirements.txt` 现状）：

```text
deepagents==0.6.12
langchain==1.3.14
langchain_core==1.5.1
langgraph==1.2.9
langgraph-checkpoint-postgres==3.0.5
langchain-mcp-adapters==0.3.2
mcp==1.26.0
```

平台壳沿用原型选型：Flask（`Flask==3.1.2`）+ SQLAlchemy + PostgreSQL + Redis + Celery（`celery==5.6.2`）+ Weaviate（`weaviate_client==4.19.2`）。沙箱执行支持 Bubblewrap、LangSmith Sandbox 与 Daytona 三种 Provider（`langchain-daytona==0.0.7`）。

## 二、同类平台对比总览

把平台放回外部坐标系：原型、三个 LangChain 系同类平台，再加上 Dify——原型的对照原点。表中版本取自各仓库的依赖清单或 README 声明；Dify 一行按 main 分支（1.16.1）的 `api/pyproject.toml` 与目录结构逐项核对过。

| 平台                                                  | 定位                          | 运行时与关键版本                                                                                                                                  | 平台壳                                                                             | 差异点                                                                                |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 慕课 LLMOps（原型）                                   | 课程级 AI 应用平台            | `langgraph==0.2.67`、`langchain==0.2.17`                                                                                                      | Flask + Celery + Weaviate + PostgreSQL，api / ui 前后端分离                        | App、Dataset、Workflow、函数调用 Agent 的骨架原型                                     |
| [Dify](https://github.com/langgenius/dify)(LLMOPS的原型) | 开源 LLM 应用开发平台         | 自研 graph 应用框架：自研工作流引擎（`api/core/workflow/`）管编排、Model Runtime 管模型接入（插件化），依赖清单（1.16.1）无 LangChain/LangGraph | Flask + Celery + PostgreSQL + Redis；向量库插件化（30+ 可选向量库包，含 Weaviate） | 原型的对照原点：对象模型与平台壳同构，运行时全部自研                                  |
| [openagent](https://github.com/Haohao-end/openagent)     | AI Agent 开发平台             | `langgraph==1.1.10`、`langchain==1.2.18`、`deepagents==0.5.9`                                                                               | 与原型同构：Flask + Celery + Weaviate + PostgreSQL                                 | 与本平台同源 LLMOps；保留课程骨架升级到 1.x，扩展 A2A 委派、Skills、MCP、深度思考模式 |
| [Yuxi](https://github.com/xerrors/Yuxi)                  | 多租户知识智能体平台          | LangGraph 编排 + 直接引入 DeepAgents                                                                                                              | FastAPI + PostgreSQL / Redis / MinIO / Milvus / Neo4j                              | 统一 RAG、知识图谱、多 Agent、MCP/Skills、沙箱与权限管理；沙箱思路参考 DeerFlow       |
| [Octop](https://github.com/TencentCloud/Octop)           | 自托管多用户多 Agent 助手平台 | octop-harness（LangGraph）与 octop-gateway 为独立发布包（`octop-harness>=1.0.4`、`octop-gateway>=1.0.3`）                                     | FastAPI + SQLite/PostgreSQL + React 前端                                           | 核心运行时与 IM 网关拆成独立包，平台仓库只做平台层                                    |
| 本平台                                                | Agent 应用开发平台            | `deepagents==0.6.12`、`langgraph==1.2.9`、`langchain==1.3.14`                                                                               | Flask + Celery + Weaviate + PostgreSQL                                             | DeepAgents 作为统一运行时（所有应用经 `create_deep_agent` 装配），业务面自持        |

对比下来有四个判断：

- **血统判断**。按 Dify main 分支（1.16.1）核对仓库，LLMOps 原型几乎就是 Dify 的 LangChain/LangGraph 版——对象模型和平台壳照着 Dify 建，运行时换成 LangChain 生态。证据有三组：

  - 依赖清单：`api/pyproject.toml` 里没有 langchain、langgraph、deepagents，平台壳是 Flask（3.1.x）+ Celery + Redis + PostgreSQL。
  - 对象模型：Dify `api/models/` 下的 account、dataset、provider、workflow 与原型的 account、dataset、platform（供应商配置）、workflow 同名对应；app 与 conversation 收在同一目录的对象大表 `model.py` 里；原型的 api_tool 对应 Dify 的 `tools.py`。
  - 目录结构：Dify `api/core/` 下的 workflow、rag、tools、agent，对得上原型 `internal/core/` 的 workflow、retrievers、tools、agent。

  不同的是 Dify 自研了一套 graph AI 应用框架：编排由 `api/core/workflow/` 的自研节点运行时（`node_factory.py` + `nodes/`）承担，模型接入从 v0.4.1 起换成自研 Model Runtime（[官方博客](https://dify.ai/blog/the-model-runtime-restructure)），这一层如今已随插件体系移出 core 目录。
- **同源殊途**。openagent 与本平台都从 LLMOps 原型出发，都收敛到 LangChain 1.x + DeepAgents；差别在集成深度——本平台把 DeepAgents 作为统一运行时，openagent 保留课程平台骨架，deepagents 版本也低一条线（0.5.9 对 0.6.12）。
- **独立同构**。Yuxi 与本平台没有血缘，却在运行时上得出同一结论——LangGraph 编排 + 直接引入 DeepAgents，沙箱类似 DeerFlow。
- **拆包路线**。Octop 把 LangGraph 运行时（harness）和 IM 网关（gateway）做成自家独立包；本平台把运行时交给外部框架（DeepAgents）、业务留在仓库里——运行时"自研成包"与"外借框架"的两种相反取向。

## 三、共同模块与共同难题

第二节的对比如果只停在「像不像」，收获有限。把五个平台的功能面拆开对照，能提炼出这类平台共同的功能域与共同的工程难题——前者解释了平台之间为什么可以互相参照（初识 LLMOps、读 Dify、看 openagent 与 Octop 都有直接收获），后者划出了后续模块文章的题目范围。

### 1、共同的功能模块

| 功能域       | 内容                                       | 各平台落点                                                                                                   |
| ------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 应用模型     | App 配置、草稿与发布隔离、配置版本         | LLMOps、Dify、本平台的 App 模型；Octop 的 agents                                                             |
| 模型接入     | 供应商凭据、模型目录、调用适配             | Dify 的 Model Runtime（现为插件）；本平台的 Provider Connection；LLMOps 的 language_model                    |
| Agent 运行时 | 执行循环、函数调用、子代理                 | 每家都有，差别只在自研（Dify）还是借框架（其余）                                                             |
| 会话与消息   | Conversation、Message、Turn 与终端用户身份 | LLMOps、Dify、本平台的同名对象；Octop 的 threads                                                             |
| 知识库/RAG   | 数据集、文档解析、切片、Embedding、检索    | LLMOps、Dify、本平台的 Dataset；Yuxi 的 RAG 与知识图谱；Octop 的 knowledge_bases                             |
| 工具体系     | 内置工具、API 工具、MCP、工作流工具化      | MCP 是新的收敛点：Dify、Octop connectors、本平台、Yuxi、openagent 都接了                                     |
| 工作流编排   | 可视化 DSL 到图执行、节点类型              | Dify、LLMOps 系、本平台共有；Octop 以对话为中心，没有把画布做成一等公民，用 cron、skills、teams 承担类似职责 |
| 发布与多入口 | 调试页、WebApp、开放 API                   | LLMOps、Dify、本平台同构；Octop 换成 IM 渠道（gateway），入口形态不同、问题同构                              |

### 2、共同的工程难题

难题比模块更能说明「Agent 平台」是一类独立的工程物，而且与运行时选型正交——自研引擎、LangGraph 还是 DeepAgents，题目不变，解法换层。按执行生命周期分四组：

- **执行可靠性**。
  - 流式输出与断线恢复：实时发布早于持久化，断线后要靠快照与水位续接——本平台的有界队列加批量落库、Dify 1.9 把图引擎换成队列式执行、Octop 修复团队子 Agent 流在页面刷新后的存活，做的是同一道题。
  - 幂等与重复执行：会话锁、消息幂等键、任务认领的条件更新，防止重复点击与重试造成双跑。
  - 长任务的暂停与恢复：checkpoint、interrupt/resume、取消与超时状态翻转。
- **上下文管理**。
  - 窗口预算要同时算模型窗口、输出预留与安全余量。
  - 提示词与工具定义前缀保持稳定，为的是命中供应商的提示缓存。
  - 上下文超限时自动摘要或主动压缩，摘要本身也要计入预算。
- **接口兼容与安全**。
  - 多模型兼容：各供应商的工具调用格式与流式协议差异，要一层 middleware 或 Model Runtime 抹平。
  - 工具调用安全：参数校验、能力授权、只读工具才自动重试，避免重复写。
  - 代码执行隔离：沙箱生命周期、租约与容量淘汰、与平台进程隔离——本平台的代码节点交给腾讯云 SCF，沙箱接过 Bubblewrap、LangSmith Sandbox、Daytona 三种，Yuxi 参考 DeerFlow，Dify 用独立 sandbox 服务，选项不同、题目相同。
- **数据与交付**。
  - RAG 链路工程化：解析、切片、Embedding、索引的失败记录与增量更新，混合检索质量，Embedding 指纹防止跨向量空间混检。
  - 并发一致性：revision 乐观锁、事务锁、覆盖冲突的补偿。
  - 版本隔离：草稿与发布的隔离、工作流发布后的工具化复用、运行时迁移期的协议兼容。

「共同模块 × 共同难题」这套矩阵是后续模块文章的索引框架：02 起每篇模块纵线对准矩阵里的一行功能域，文中出现的取舍与去留，都能回指到这里的一道难题。

## 四、迭代：从 LangGraph 0.2 原型到 DeepAgents

迭代的主语是本平台。原型只提供起点素材：平台的对象模型照着它建，运行时从它的 LangGraph 0.2 图开始，一路换到 DeepAgents 装配。

### 1、初识：LangGraph 0.2 上的 Agent + Workflow 原型

和这个平台的缘分从慕课网的 LLMOps 课程项目开始——一个自述为"原生 AI 应用开发平台"的课程级实现，api / ui 前后端分离，后端以 LangGraph 0.2 为核心（`langgraph==0.2.67`、`langchain==0.2.17`）。它的对象模型是一套"课程级 Dify"——App 应用配置（草稿与发布）、Dataset 知识库（文档、分段、向量检索）、Workflow 可视化画布（LLM、检索、工具一类节点），再加一个函数调用 Agent。

LangGraph 0.2 在原型里承担两件事。Agent 侧用 StateGraph 显式建图，StateGraph 是 LangGraph 的核心构造：把节点函数和边声明成一张状态机图，按图流转；也可以直接用 `langgraph.prebuilt` 的 `create_react_agent`（预置的反应式 Agent 图：模型节点与工具节点循环），配 Checkpointer（检查点存储）持久化每步状态。Workflow 侧把前端画布的 DSL 编译成图执行，节点类型与平台配置一一对应。

跑通原型后拿到两个判断：

- 原型最初的几大功能面已经比较完整。应用、知识库、工作流、工具、模型配置这套骨架齐整，经过 Dify 一类产品验证，值得照着建。
- 运行时是原型级的。0.2 的 API 面与 1.0 生态断裂，把业务继续钉在这套 API 上不划算。

### 2、以 LangGraph 1.0 为基线重建

LangChain 与 LangGraph 1.0 发布后，新栈把 Agent 构造入口统一到 `create_agent`，用 middleware（中间件）模型组织工具审批、上下文压缩这类横切能力，旧接口归入 `langchain_classic` 兼容包。0.2 原型与这条新主线之间是成体系的 API 更替，不是补丁级升级。

决策是把运行时基线换到 1.0，这一步最终落成一次重建而不是原地改造：重建从新仓库初始化开始，第一批 Agent 代码落地时，`requirements.txt` 直接钉在 1.0 一线：

```text
langchain==1.2.6
langchain_core==1.2.7
langgraph==1.0.6
```

重建顺序跟着原型的骨架走：目录结构与异常体系、自定义 API 工具、知识库（文档处理、向量检索、对象存储）、函数调用 Agent 与队列管理、应用配置版本与调试会话、工作流节点与内置模板。平台壳沿用原型的技术选型：Flask、SQLAlchemy、PostgreSQL、Redis、Celery、Weaviate。

直接站在 1.x 栈上有一个当时看不见的收益：后来接入 DeepAgents 时，它要求的正是 langchain 1.x 的 `create_agent` 与 middleware 底座，平台没有再付一次迁移成本。

### 3、DeerFlow 参照：看的是协作图，不是运行时

重建之后是自建阶段：基于 LangGraph 的图执行和 Checkpoint 完善状态管理、历史消息、流式输出与工作流恢复，并验证了一批多 Agent 组织模式——AgentTool（把子 Agent 包装成工具）、事件冒泡、Supervisor（主管调度）、Team、Plan/Execute/Replan（规划-执行-重规划）、Pipeline。多入口（调试页、WebApp、开放 API、内部任务）也在这一阶段统一到同一套 Agent 服务。

期间读过 [DeerFlow](https://github.com/bytedance/deerflow)：字节跳动开源的深度研究框架，LangGraph 上的一条完整协作链——coordinator（协调者）→ planner（规划者）→ research team（researcher 负责检索、coder 负责计算）→ reporter（成稿），中间留出人工反馈环节。

从 DeerFlow 带走的是参照而不是代码。它的图是为"深度研究"这一条任务流特化的：节点职责、反馈回路、产出格式都围绕研究报告组织；而平台要的是给任意应用装配能力的通用运行时，把这条图照搬进通用位置只会得到一个写死任务形态的特例。真正被 DeerFlow 校准的是问题本身：平台缺的不是"怎么把多 Agent 连成图"（自建阶段已验证过多种连法），而是 planning（任务规划）、文件系统、子代理隔离这些支撑长任务执行的基础设施——它们与多 Agent 编排是两件事。

### 4、转向 DeepAgents：借运行时，业务自持

[DeepAgents](https://github.com/langchain-ai/deepagents) 是 LangChain 团队对"深度 Agent"模式的参考实现：在 langchain 1.x 的 `create_agent` 和 middleware 之上，把 planning todos（任务规划清单）、虚拟文件系统（read/write/ls/glob/edit 一组文件工具）、SubAgent（子代理委派与隔离）、上下文压缩、Checkpointer/Store 持久化装配成一个 Agent 构造函数 `create_deep_agent`。

决策因此变得直接：规划、文件、子代理这三件基础设施自研代价高、且与平台业务无关，交给 DeepAgents；App 配置、Dataset/RAG、Workflow 工具化、MCP 工具、模型目录、事件流与恢复这些业务面继续自持。集成落地时 `requirements.txt` 完成换轨：

```text
deepagents==0.6.12
langchain_core==1.4.9
langgraph==1.2.9
```

迁移不是换一个调用。`AgentConfig.subagents` 配置要转换成 DeepAgents 原生的 SubAgent 规格；异步子 Agent 不能交给 `create_deep_agent` 注册（会与平台扩展重复注册同名工具），改走平台自己的 NamedAsyncSubAgentMiddleware；框架默认的通用子 Agent 不继承主 Agent 中间件、却会继承父级工具，需要在装配入口显式声明执行策略。现在装配入口的样子（`internal/core/agent_v2/assembly/graph/deep_agent_factory.py`，deepagents 0.6.12，节选）：

```python
def build_deep_agent(
    *,
    definition: AgentConfig,
    runtime: AgentRuntimeResources,
) -> CompiledStateGraph:
    """把已校验的应用配置和已解析依赖编译成 Deep Agents 图。"""
    # ……工具校验、上下文预算、平台 middleware、同步/异步子代理规格装配，节选
    return create_deep_agent(
        model=model,
        tools=agent_tools,
        system_prompt=system_prompt,
        middleware=middleware,
        subagents=sync_specs,
        skills=list(runtime.skill_projection.sources) or None,
        # 长期记忆通过 Store 文件工具按需读取，不启用自动文件注入。
        memory=None,
        permissions=list(runtime.permissions),
        backend=runtime.backend,
        checkpointer=runtime.checkpointer,
        store=runtime.store,
        context_schema=AgentRunContext,
    )
```

平台的资产以 middleware、backend、checkpointer、store 的形式注入，`create_deep_agent` 只负责图本身——"借运行时、业务自持"最终落成一张参数表。这之后运行时拆出 V2 边界（配置解析、资源装配、执行器、事件规范化、状态投影、持久化），沙箱扩展到 Bubblewrap、LangSmith、Daytona 三种 Provider，恢复走 Checkpointer 与 interrupt/Command(resume) 机制。这些改造的展开留给后续篇目。

### 5、回看 Dify：确认原型的血统

迭代后期粗读了 Dify 的实现，读到 1.16 这一代，确认了第二节给出的血统判断：LLMOps 原型就是 Dify 的 LangChain/LangGraph 版复刻，而 Dify 自己用自研的 graph AI 应用框架走出了另一条路线。两条路线的取舍——Dify 自研去框架化换取控制力，本平台拥抱 LangChain 1.x + DeepAgents 换取生态能力——留在对照篇展开。

后续篇目按模块纵线与跨模块决策展开，目录与状态见[专栏入口](./index.md)。
