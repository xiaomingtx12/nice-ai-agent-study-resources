---
sidebar_position: 2
---

# 一站式 AI Agent 开发平台项目总览

这是一个手搓 Agent 平台的项目总览页。

这个项目不是单纯做一个聊天壳子，而是要做成一站式 AI Agent 开发平台，覆盖多模型接入、Agent 对话、RAG 检索、可视化工作流、MCP 工具、语音交互、多端发布，以及预设工作流模板。

它的目标也很明确：让用户能快速构建智能客服、周报生成、小红书文案改写助手等智能应用，同时平台本身要具备可扩展、可治理、可发布的工程基础。

## 这个项目要解决什么

- 帮用户快速从“想法”变成“可运行的智能应用”
- 帮开发者把 Agent、RAG、工具、工作流、模型路由统一到一套平台里
- 帮团队把多模型、多租户、多端发布和统一运维收拢到可管理的工程体系中

## 核心能力范围

### 1. 多模型接入

通过 Provider-Model 两级抽象统一管理模型接入、能力标记和参数注入，支持按业务灵活切换模型。

### 2. Agent 对话

基于 LangGraph 设计 Function Calling / ReAct 双模式 Agent 执行链路，按模型能力自动切换，并统一输出推理、工具调用、检索、错误、停止等事件流。

### 3. RAG 检索

支持文档上传、解析、切分、关键词抽取、向量化、召回与融合，支持 Weaviate 语义检索、关键词倒排检索与混合检索，并把检索能力 Tool 化复用于 Agent 与 Workflow。

### 4. 可视化工作流

基于 StateGraph 实现可视化工作流，支持条件分支、并行汇聚，以及 LLM、检索、工具、HTTP、代码、意图分类、模板转换等多类型节点。

### 5. 插件工具集成

统一 Builtin Tool、API Tool、MCP Tool 三类工具体系，支持 OpenAPI Schema 导入、MCP Server 配置与工具发现、参数校验、调试运行，并通过 LangChain BaseTool 抽象实现 App / Workflow 统一注入。

### 6. 记忆与会话

短期通过 token 限额裁剪历史上下文，长期通过会话摘要增量更新并在推理前注入系统上下文；摘要生成放到后台异步执行，避免阻塞主对话链路。

### 7. 语音交互与多端发布

集成 STT / TTS，实现语音识别与语音合成，支持 WebApp / OpenAPI 接入，并通过统一发布能力覆盖不同端的交互入口。

## 技术栈

- 后端：Python、Flask
- Agent / 编排：LangChain、LangGraph、LangSmith
- 存储与任务：Redis、PostgreSQL、Celery
- 向量与检索：Weaviate、Faiss、RAG
- 鉴权与集成：OAuth、MCP、COS、腾讯云云函数
- 前端：Vue
- 语音：Edge-TTS

## 系统设计重点

### Agent 执行层

执行层需要能统一表达推理、工具调用、检索、错误、停止等事件流，并支持会话级中断与前端推理过程可视化。

### 会话记忆机制

短期上下文裁剪和长期摘要更新分离，异步摘要生成避免阻塞主链路，确保对话体验稳定。

### 工作流发布门禁

通过 draft_graph / graph 双态隔离与调试发布门禁保障运行稳定性，避免编辑态直接影响线上执行。

### 多模型治理与租户隔离

通过 Provider-Model 抽象、YAML 动态配置和用户级 API Key 隔离，支持多厂商模型灵活切换并保证隔离性。

### 部署与发布

通过 Docker Compose 编排 API、Celery、Nginx、前端服务，Nginx 负责 HTTPS 反向代理，实现前后端分离部署。

## 一段最能说明它不是 demo 的真实代码

如果只看功能描述，这一页还是容易显得“平台感很强，但证据不够”。  
真正最能说明问题的，是一次调试对话在后端到底怎么被装起来：

```python
llm = self.language_model_service.load_language_model(
    draft_app_config.get("model_config", {}), account_id=account.id
)

token_buffer_memory = TokenBufferMemory(
    db=self.db,
    conversation=debug_conversation,
    model_instance=llm,
)
history = token_buffer_memory.get_history_prompt_messages(
    message_limit=draft_app_config["dialog_round"],
)

tools = self.app_config_service.get_langchain_tools_by_tools_config(
    draft_app_config["tools"]
)

if draft_app_config["datasets"]:
    dataset_retrieval = (
        self.retrieval_service.create_langchain_tool_from_search(
            flask_app=current_app._get_current_object(),
            dataset_ids=[
                dataset["id"] for dataset in draft_app_config["datasets"]
            ],
            account_id=account.id,
            retrival_source=RetrievalSource.APP,
            source_app_id=app.id,
            **draft_app_config["retrieval_config"],
        )
    )
    tools.append(dataset_retrieval)

if draft_app_config["workflows"]:
    workflow_tools = (
        self.app_config_service.get_langchain_tools_by_workflow_ids(
            [workflow["id"] for workflow in draft_app_config["workflows"]]
        )
    )
    tools.extend(workflow_tools)

agent_class = (
    FunctionCallAgent if ModelFeature.TOOL_CALL in llm.features else ReACTAgent
)
```

这段代码基本把这个项目为什么是“一站式平台”说透了：

- 模型不是写死的，是运行时装配的
- 知识库不是外挂，是统一工具的一部分
- 工作流不是单独页面产物，而是还能再回流成工具
- 记忆、工具、检索、模型最后在 Agent 入口层汇合

## 它为什么不是“三个入口各写一套”

一站式平台最容易做坏的地方，就是调试页、WebApp、OpenAPI 后面各藏一套对话逻辑。

这个项目从当前实现看，不是这么做的。三种入口虽然有不同的鉴权和归属规则，但进入运行时之前都复用了同一套装配动作。

WebApp 入口先做的是 token 和发布态校验：

```python
app = (
    self.db.session.query(App)
    .filter(
        App.token == token,
    )
    .one_or_none()
)
if not app or app.status != AppStatus.PUBLISHED:
    raise NotFoundException("该WebApp不存在或者未发布，请核实后重试")
```

OpenAPI 入口先做的是应用发布态和终端用户归属校验：

```python
if app.status != AppStatus.PUBLISHED:
    raise NotFoundException("该应用不存在或未发布，请核实后重试")

if req.end_user_id.data:
    end_user = self.get(EndUser, req.end_user_id.data)
    if not end_user or end_user.app_id != app.id:
        raise ForbiddenException("当前账号不存在或不属于该应用，请核实后重试")
else:
    end_user = self.create(
        EndUser,
        **{"tenant_id": account.id, "app_id": app.id},
    )
```

但校验完之后，三条链路又会重新汇合到同一种运行时：

- 加载应用运行时配置
- 提取短期记忆和长期记忆
- 装配工具、知识库工具、工作流工具
- 根据模型能力选择 `FunctionCallAgent / ReACTAgent`

这类设计对后续复用很关键，因为它把“入口差异”压在最外层，把真正复杂的 Agent 运行时留在同一处维护。

## 预设工作流模板

平台预设工作流模板，支持快速构建：

- 智能客服
- 周报生成
- 小红书文案改写助手

这些模板的目标不是“展示功能”，而是让平台具备可以直接复用的落地形态。

## 这篇总览页的作用

这不是某一个细节模块的说明，而是整个项目的入口。

后面每一篇都可以从这里向下拆：

- Agent 层怎么跑
- RAG 怎么做
- 工作流怎么编
- 工具怎么接
- 模型怎么管
- 架构怎么搭

如果把这个项目理解成一个可持续扩展的工程平台，而不是一次性的 demo，那么这页就是它的总地图。
