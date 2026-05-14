---
sidebar_position: 3
---

# 平台的核心 Agent 层

这一篇不再只讲“Agent 层很重要”这种抽象结论，而是只看这个项目里真正落地的执行设计。

项目里的核心 Agent 层，本质上是一套基于 LangGraph 的双模式执行系统：按模型能力自动切换 Function Calling 和 ReAct，两种模式共用同一条执行骨架、同一套工具链、同一套事件流和同一套可视化回放协议。

## 先说最关键的判断

这个项目里的“双模式 Agent”不是两套独立系统。

它更接近下面这个设计：

- 同一张 LangGraph 执行图
- 两种不同的 LLM 驱动方式
- 一套统一的工具执行节点
- 一套统一的事件流和持久化协议

真正的工程价值，不是“支持两种模式”，而是把模式差异压缩在少数节点里，让平台其他层尽量不感知底层差别。

## 为什么核心 Agent 层值得单独拆

这里的 Agent 层，不是简单接一个模型接口然后把回答往前端一吐。

它至少还要同时解决：

- 这轮请求该走哪种 Agent 模式
- 系统提示、短期记忆、长期记忆怎么注入
- 工具什么时候调用、调用完怎么回到下一轮推理
- 推理过程怎么实时展示
- 任务怎么停止
- 运行过程怎么持久化回放

如果这些能力散在 service、router、前端和模型封装里，平台后面会非常难维护。

## 我会把它拆成七个部分

### 1. 入口层先做模式分流

平台接到一次对话请求后，并不是马上把输入丢给模型。

服务层通常会先完成这几步：

- 创建消息和会话上下文
- 提取短期记忆
- 读取长期记忆摘要
- 装配普通工具、知识库工具和工作流工具
- 根据 `llm.features` 判断模型是否支持 `TOOL_CALL`

然后再做第一层分流：

- 支持原生工具调用，走 `FunctionCallAgent`
- 不支持原生工具调用，走 `ReACTAgent`

所以双模式切换首先发生在服务层，而不是发生在某个 prompt 模板里。

### 2. Agent 上游先经过 App 应用与配置系统

这一层如果不补进来，Agent 文档其实是不完整的。

因为这个项目里的 Agent，从来不是“前端传一堆参数，后端现场拼一个智能体”。

它前面先有一套独立的 App 应用资产系统，至少包含四样东西：

- 应用本体 `App`
- 草稿配置 `AppConfigVersion(DRAFT)`
- 发布配置 `AppConfig`
- 调试会话 `debug_conversation`

先看 `App` 这个模型本身，里面就已经把运行时边界写得很清楚了：

```python
class App(db.Model):
    account_id = Column(UUID, nullable=False)
    app_config_id = Column(UUID, nullable=True)
    draft_app_config_id = Column(UUID, nullable=True)
    debug_conversation_id = Column(UUID, nullable=True)
    token = Column(String(255), nullable=True)
    status = Column(String(255), default="", nullable=False)

    @property
    def app_config(self) -> "AppConfig":
        if not self.app_config_id:
            return None
        return db.session.query(AppConfig).get(self.app_config_id)

    @property
    def draft_app_config(self) -> "AppConfigVersion":
        app_config_version = (
            db.session.query(AppConfigVersion)
            .filter(
                AppConfigVersion.app_id == self.id,
                AppConfigVersion.config_type == AppConfigType.DRAFT,
            )
            .one_or_none()
        )

        if not app_config_version:
            app_config_version = AppConfigVersion(
                app_id=self.id,
                version=0,
                config_type=AppConfigType.DRAFT,
                **DEFAULT_APP_CONFIG
            )
            db.session.add(app_config_version)
            db.session.commit()

        return app_config_version
```

这段代码有两个很重要的判断：

- Agent 不直接挂在 `App` 表上跑，它前面隔着草稿配置和发布配置两层
- 就算数据库里还没有草稿配置，`draft_app_config` 这个属性也会懒创建一份默认配置，避免运行时无配置可读

调试会话也是 `App` 自己托管的，而不是调试接口临时 new 一个上下文：

```python
@property
def debug_conversation(self) -> "Conversation":
    debug_conversation = None
    if self.debug_conversation_id is not None:
        debug_conversation = (
            db.session.query(Conversation)
            .filter(
                Conversation.id == self.debug_conversation_id,
                Conversation.invoke_from == InvokeFrom.DEBUGGER,
            )
            .one_or_none()
        )

    if not self.debug_conversation_id or not debug_conversation:
        with db.auto_commit():
            debug_conversation = Conversation(
                app_id=self.id,
                name="New Conversation",
                invoke_from=InvokeFrom.DEBUGGER,
                created_by=self.account_id,
            )
            db.session.add(debug_conversation)
            db.session.flush()
            self.debug_conversation_id = debug_conversation.id

    return debug_conversation
```

这意味着调试态不是“无状态试玩”，而是 App 级别的一条长期调试会话资产。前面文档里讲的短期记忆和长期记忆，在调试场景里都是挂在这条 `debug_conversation` 上跑的。

默认配置本身也不是空壳。这个项目直接把一套可运行的最小 Agent 配置写在了 `DEFAULT_APP_CONFIG` 里：

```python
DEFAULT_APP_CONFIG = {
    "model_config": {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "parameters": {
            "temperature": 0.5,
            "top_p": 0.85,
            "frequency_penalty": 0.2,
            "presence_penalty": 0.2,
            "max_tokens": 8192,
        },
    },
    "dialog_round": 3,
    "preset_prompt": "",
    "tools": [],
    "workflows": [],
    "datasets": [],
    "retrieval_config": {"retrieval_strategy": "semantic", "k": 10, "score": 0.5},
    "long_term_memory": {"enable": False},
    "speech_to_text": {"enable": False},
    "text_to_speech": {"enable": False, "voice": "xiaoxiao", "auto_play": False},
    "review_config": {"enable": False, "keywords": []},
}
```

这套默认值很有实践意义，因为它定义了“一个最小可运行 App”的事实边界：

- 默认有模型
- 默认有上下文轮数
- 默认不绑工具、工作流、知识库
- 默认不开长期记忆、语音、审核

所以应用配置不是一个补充信息表，它本身就是 Agent 运行时的上游事实来源。

### 3. App 配置不是原样下发，而是先经过一次清洗和转换

这个项目真正值钱的地方，是它没有把数据库里的配置 JSON 原样塞进 Agent。

无论是草稿配置还是发布配置，都会先经过 `AppConfigService` 做一轮“校验 + 修正 + 展开”：

```python
def get_draft_app_config(self, app: App) -> dict[str, Any]:
    draft_app_config = app.draft_app_config

    validate_model_config = self._process_and_validate_model_config(
        draft_app_config.model_config
    )
    if draft_app_config.model_config != validate_model_config:
        self.update(draft_app_config, model_config=validate_model_config)

    tools, validate_tools = self._process_and_validate_tools(draft_app_config.tools)
    datasets, validate_datasets = self._process_and_validate_datasets(
        draft_app_config.datasets
    )
    workflows, validate_workflows = self._process_and_validate_workflows(
        draft_app_config.workflows
    )

    return self._process_and_transformer_app_config(
        validate_model_config,
        tools,
        workflows,
        datasets,
        draft_app_config,
    )
```

这里其实做了三种完全不同的事情：

- 宽松校验：模型、工具、知识库、工作流引用失效时自动修正或剔除
- 数据修复：修正后的结果会回写数据库，不把脏配置拖到运行时
- 结构展开：把原来偏存储态的 id / params 结构，展开成更适合前端和运行时消费的字典

模型配置的处理尤其关键，因为它不是只校验 provider/model 存不存在，还会补齐参数默认值，并把模型能力写回配置：

```python
if not isinstance(origin_model_config, dict):
    return DEFAULT_APP_CONFIG["model_config"]

provider = self.language_model_manager.get_provider(model_config["provider"])
model_entity = provider.get_model_entity(model_config["model"])

parameters = {}
for parameter in model_entity.parameters:
    parameter_value = model_config["parameters"].get(
        parameter.name, parameter.default
    )
    ...
    parameters[parameter.name] = parameter_value

model_config["parameters"] = parameters
model_config["features"] = [f.value for f in model_entity.features]
```

这里加 `features` 很重要，因为它说明 App 配置在这个项目里不只是“存用户选择”，还会提前带上模型能力，后面无论前端功能开关还是 Agent 模式选择都能直接用。

最后，真正交给上层的不是数据库原始结构，而是一份已经转成运行时友好形态的配置字典：

```python
return {
    "id": str(app_config.id),
    "model_config": model_config,
    "dialog_round": app_config.dialog_round,
    "preset_prompt": app_config.preset_prompt,
    "tools": tools,
    "workflows": workflows,
    "datasets": datasets,
    "retrieval_config": app_config.retrieval_config,
    "long_term_memory": app_config.long_term_memory,
    "opening_statement": app_config.opening_statement,
    "opening_questions": app_config.opening_questions,
    "speech_to_text": app_config.speech_to_text,
    "text_to_speech": app_config.text_to_speech,
    "suggested_after_answer": app_config.suggested_after_answer,
    "review_config": app_config.review_config,
}
```

这件事看起来普通，但其实非常关键。因为从这一步开始，Agent 层消费的已经不是数据库表，而是一份清洗过、补齐过、展开过的应用运行时配置。

### 4. 调试态跑草稿，线上入口跑发布配置

这也是 App 主线里很值得写清楚的一点。

调试接口并不是拿发布配置来跑，而是显式读取最新草稿配置：

```python
app = self.get_app(app_id, account)
draft_app_config = self.get_draft_app_config(app_id, account)
debug_conversation = app.debug_conversation
```

然后再把这份草稿配置一路装进 Agent：

```python
llm = self.language_model_service.load_language_model(
    draft_app_config.get("model_config", {}), account_id=account.id
)

tools = self.app_config_service.get_langchain_tools_by_tools_config(
    draft_app_config["tools"]
)

agent = agent_class(
    llm=llm,
    agent_config=AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.DEBUGGER,
        preset_prompt=draft_app_config["preset_prompt"],
        enable_long_term_memory=draft_app_config["long_term_memory"]["enable"],
        tools=tools,
        review_config=draft_app_config["review_config"],
    ),
)
```

而 WebApp / OpenAPI 那边前面已经看到，走的是 `get_app_config(app)`，也就是发布态配置。

这个分层很重要，因为它解释了为什么这个平台可以同时满足两种诉求：

- 编辑台上边改边试，不影响线上
- 发布出去的入口始终只读稳定运行配置

### 5. 发布不是切状态，而是把草稿复制成新的 Agent 运行快照

这部分在整体架构里也提过，但放到 Agent 文档里一样有必要，因为它直接决定了“线上 Agent 到底吃哪份配置”。

真实代码里，发布动作不是把草稿标记一下完事，而是新建一份 `AppConfig`：

```python
app_config = self.create(
    AppConfig,
    app_id=app_id,
    model_config=draft_app_config["model_config"],
    dialog_round=draft_app_config["dialog_round"],
    preset_prompt=draft_app_config["preset_prompt"],
    tools=[
        {
            "type": tool["type"],
            "provider_id": tool["provider"]["id"],
            "tool_id": tool["tool"]["name"],
            "params": tool["tool"]["params"],
        }
        for tool in draft_app_config["tools"]
    ],
    workflows=[workflow["id"] for workflow in draft_app_config["workflows"]],
    retrieval_config=draft_app_config["retrieval_config"],
    long_term_memory=draft_app_config["long_term_memory"],
    review_config=draft_app_config["review_config"],
)

self.update(app, app_config_id=app_config.id, status=AppStatus.PUBLISHED)
```

所以从 Agent 的角度看，发布态并不是“去读同一份草稿，只是多了个 published 标记”，而是切换到另一份独立的运行快照。

这点非常重要，因为它意味着：

- 调试中的脏改动不会立刻污染线上 Agent
- 线上 Agent 每次消费的都是一份明确可追溯的配置快照
- App 配置系统真正承担了 Agent 运行边界隔离的职责

### 6. 两种模式共用同一条 LangGraph 骨架

这个项目最值得沉淀的地方，是两种模式没有各写一套图。

它们共享的执行骨架可以概括成：

- `preset_operation`
- `long_term_memory_recall`
- `llm`
- `tools`
- 再根据是否存在 `tool_calls` 决定继续循环还是结束

也就是说，图结构本身并不区分 Function Calling 和 ReAct。

真正的差异只集中在两个地方：

- `long_term_memory_recall` 怎么构造系统提示和上下文
- `llm` 节点怎么理解并产出“工具调用意图”

这让平台可以稳定复用：

- 条件边
- 工具节点
- 事件协议
- 可视化和持久化逻辑

这一点在真实代码里非常直观，`FunctionCallAgent` 的骨架就是一张固定图：

```python
def _build_agent(self) -> CompiledStateGraph:
    """构建LangGraph图结构编译程序"""
    graph = StateGraph(AgentState)  # type: ignore

    graph.add_node("preset_operation", self._preset_operation_node)
    graph.add_node("long_term_memory_recall", self._long_term_memory_recall_node)
    graph.add_node("llm", self._llm_node)
    graph.add_node("tools", self._tools_node)

    graph.set_entry_point("preset_operation")
    graph.add_conditional_edges(
        "preset_operation", self._preset_operation_condition
    )
    graph.add_edge("long_term_memory_recall", "llm")
    graph.add_conditional_edges("llm", self._tools_condition)
    graph.add_edge("tools", "llm")

    return graph.compile()
```

这段代码很重要，因为它说明“双模式”不是两套状态机，而是共享同一个 `preset -> memory -> llm -> tools` 循环骨架。

### 7. ReAct 不是另一套工具系统，而是把文本意图归一化

很多人会把 ReAct 理解成“重新做一遍工具调用”。

这个项目不是这么做的。

它的关键设计是：

- Function Calling 模式下，模型原生返回 `tool_calls`
- ReAct 模式下，模型先按文本协议输出工具意图
- 后端再把这份文本意图重新解析成标准 `tool_calls`

一旦归一化完成，后续链路就完全复用 Function Calling 模式：

- 仍然走同一个 `tools` 节点
- 仍然用同一个条件边判断是否继续
- 仍然发同一种事件给前端

所以 ReActAgent 真正承担的职责，不是“自己执行工具”，而是“把文本协议翻译回统一工具调用结构”。

这是一种很典型的平台化设计：把差异控制在入口转换层，而不是让整个执行链路分叉。

### 8. 状态、记忆和消息归并由 LangGraph 承接

Agent 图里最重要的共享状态，不是普通字典，而是消息状态。

这个项目里 `AgentState` 是建立在 `MessagesState` 之上的，并额外补了：

- `task_id`
- `iteration_count`
- `history`
- `long_term_memory`

这样设计之后，节点就不用反复重建整份状态，而只需要返回局部增量。

例如：

- `llm` 节点只需要返回新的 `AIMessage`
- `tools` 节点只需要返回新的 `ToolMessage`
- 记忆注入节点只需要用 `RemoveMessage` 加新的系统消息和重建后的用户消息

LangGraph 在这里真正解决的是：

- 消息如何稳定追加
- 原始用户消息如何被替换
- 工具观察结果如何并回下一轮推理上下文
- 多轮循环时消息栈如何保持一致

这也是为什么双模式能共享一张图。因为它们共享的是同一种消息状态模型。

### 9. 对外暴露的是统一事件流，不是 LangGraph 原生输出

平台前端真正消费的，不是 LangGraph 原生 chunk，而是统一事件协议。

这个项目把推理过程收敛成一组标准事件，例如：

- 记忆召回
- 推理步骤
- 文本消息
- 工具动作
- 检索动作
- 错误
- 停止
- 结束
 
这层统一事件流不是自然出现的，而是依赖一个项目自己补出来的运行时外壳：`AgentQueueManager`。

而且它并不是只约定“事件名字”，连事件载荷结构也统一了。真实代码里的核心定义就是：

```python
class QueueEvent(str, Enum):
    LONG_TERM_MEMORY_RECALL = "long_term_memory_recall"
    AGENT_THOUGHT = "agent_thought"
    AGENT_MESSAGE = "agent_message"
    AGENT_ACTION = "agent_action"
    DATASET_RETRIEVAL = "dataset_retrieval"
    AGENT_END = "agent_end"
    TIMEOUT = "timeout"
    PING = "ping"
    STOP = "stop"
    ERROR = "error"

class AgentThought(BaseModel):
    id: UUID
    task_id: UUID
    event: QueueEvent
    thought: str = ""
    observation: str = ""
    tool: str = ""
    tool_input: dict = Field(default_factory=dict)
    message: list[dict] = Field(default_factory=dict)
    answer: str = ""
    total_token_count: int = 0
    total_price: float = 0
    latency: float = 0
```

这意味着前端、Service 层、持久化层消费的不是一堆各写各的临时结构，而是同一个 `AgentThought` 信封。

它在这里承担的不是“小工具类”角色，而是整条 Agent 流式执行链的事件中枢：

- 为每个 `task_id` 管理独立的内存队列
- 负责 `publish()` / `listen()` 这组发布与消费协议
- 把 LangGraph 节点里的推理、工具、检索、结束、错误统一转换成平台事件
- 用 Redis 记录任务归属和停止标记
- 在监听循环里承担心跳、超时和停止检测

也就是说，LangGraph 负责编排图内状态机，`AgentQueueManager` 负责把这张图安全地接到 SSE / 流式响应 / 前端可视化这一层。

这层统一事件流很关键，因为它屏蔽了底层模式差异：

- Function Calling 和 ReAct 都能输出同一种 `AgentThought`
- 前端不需要区分底层到底是不是原生 tool call
- 数据库存储也不需要按模式拆两套结构

于是平台才能同时做到两件事：

- 实时把推理过程展示给用户
- 结束后把整轮思考过程完整落库回放

如果没有这层统一协议，双模式只会让前端和持久化层变得更复杂。

还有一个很容易被忽略，但其实非常关键的点：`BaseAgent` 对外暴露的 `stream()` 根本不是直接转发 LangGraph 的 `stream()`。

真实实现里，它做的是“后台线程执行图，前台生成器监听队列”：

```python
def stream(
    self,
    input: AgentState,
    config: Optional[RunnableConfig] = None,
    **kwargs: Optional[Any],
) -> Iterator[AgentThought]:
    if not self._agent:
        raise FailException("智能体未成功构建，请核实后尝试")

    input["task_id"] = input.get("task_id", uuid.uuid4())
    input["iteration_count"] = input.get("iteration_count", 0)
    input["long_term_memory"] = input.get("long_term_memory", "")

    thread = Thread(target=self._agent.invoke, args=(input,))
    thread.daemon = True
    thread.start()

    yield from self._agent_queue_manager.listen(input["task_id"])
```

这段代码基本把运行时分工说透了：

- LangGraph 图本身只管执行，不直接对 SSE 或 Web 流负责
- Agent 层自己开后台线程，让图异步跑起来
- 前台响应层只需要消费 `listen(task_id)` 这个生成器

所以这个项目的流式 Agent，本质上不是“框架自带流式输出”，而是“图执行线程 + 自定义事件队列 + 前台监听器”三件事拼起来的。

块调用其实也不是另一套逻辑，它只是把同一条事件流重新归并成 `AgentResult`：

```python
agent_result = AgentResult(query=query, image_urls=image_urls)
agent_thoughts = {}
for agent_thought in self.stream(input, config):
    event_id = str(agent_thought.id)

    if agent_thought.event != QueueEvent.PING:
        if agent_thought.event == QueueEvent.AGENT_MESSAGE:
            if event_id not in agent_thoughts:
                agent_thoughts[event_id] = agent_thought
            else:
                agent_thoughts[event_id] = agent_thoughts[event_id].model_copy(
                    update={
                        "thought": agent_thoughts[event_id].thought
                        + agent_thought.thought,
                        "answer": agent_thoughts[event_id].answer
                        + agent_thought.answer,
                        "latency": agent_thought.latency,
                    }
                )
            agent_result.answer += agent_thought.answer
        else:
            agent_thoughts[event_id] = agent_thought
```

这段也很值钱，因为它解释了一个平时不容易看出来的设计决定：

- 流式文本输出阶段，同一条回答会复用同一个 `id`
- `invoke()` 再按 `id` 把多个 `AGENT_MESSAGE` 片段折叠成一条完整消息
- `PING` 不落结果，`STOP / TIMEOUT / ERROR` 会写回最终状态

也就是说，`invoke()` 不是另一套 Agent 执行器，它只是同一套事件协议的“结果归并器”。

### 10. 停止控制和队列协议是 Agent 层的一部分

这个项目里的停止执行，并不是前端直接杀掉后台线程。

它更像是一套会话级的协作式中断：

- 每次执行都有自己的 `task_id`
- 运行时会记录任务归属
- 停止接口不是粗暴停线程，而是设置 stop flag
- 事件监听循环持续检查 stop 状态，再决定何时退出

这种做法的价值在于，停止控制已经被做成了运行时协议的一部分。

这里真正值钱的，不只是“有个队列管理器”，而是这个管理器自己定义了一套完整协议：

- 队列按 `task_id` 惰性创建，不提前分配
- 创建队列时同步把任务归属写进 Redis
- 发布终态事件时自动塞一个 `None` 哨兵，让监听器自然退出
- 监听循环自己补 `PING / TIMEOUT / STOP`
- 外部停止请求必须先通过任务归属校验

这意味着平台对外暴露的“流式执行”并不是直接透传 LangGraph `stream()`，而是一套“后台执行图 + 前台消费事件 + Redis 协作式控制”的混合运行时。

先看它怎么创建任务队列和发布终态事件：

```python
def queue(self, task_id: UUID) -> Queue:
    q = self._queues.get(str(task_id))

    if not q:
        user_prefix = (
            "account"
            if self.invoke_from in [InvokeFrom.WEB_APP, InvokeFrom.DEBUGGER]
            else "end-user"
        )

        self.redis_client.setex(
            self.generate_task_belong_cache_key(task_id),
            1800,
            f"{user_prefix}-{str(self.user_id)}",
        )

        q = Queue()
        self._queues[str(task_id)] = q

    return q

def publish(self, task_id: UUID, agent_thought: AgentThought) -> None:
    self.queue(task_id).put(agent_thought)

    if agent_thought.event in [
        QueueEvent.STOP,
        QueueEvent.ERROR,
        QueueEvent.TIMEOUT,
        QueueEvent.AGENT_END,
    ]:
        self.stop_listen(task_id)
```

这里其实有两个工程判断：

- 队列是进程内 `Queue`，说明它解决的是“同一请求生命周期里的事件搬运”，不是分布式任务编排
- 任务归属放 Redis，不是为了传消息，而是为了让“谁有权停止这次任务”变成跨请求可校验的状态

再看监听循环本身：

```python
def listen(self, task_id: UUID) -> Generator:
    listen_timeout = 600
    start_time = time.time()
    last_ping_time = 0

    while True:
        try:
            item = self.queue(task_id).get(timeout=1)
            if item is None:
                break
            yield item
        except queue.Empty:
            continue
        finally:
            elapsed_time = time.time() - start_time

            if elapsed_time // 10 > last_ping_time:
                self.publish(
                    task_id,
                    AgentThought(
                        id=uuid.uuid4(),
                        task_id=task_id,
                        event=QueueEvent.PING,
                    ),
                )
                last_ping_time = elapsed_time // 10

            if elapsed_time >= listen_timeout:
                self.publish(
                    task_id,
                    AgentThought(
                        id=uuid.uuid4(),
                        task_id=task_id,
                        event=QueueEvent.TIMEOUT,
                    ),
                )

            if self._is_stopped(task_id):
                self.publish(
                    task_id,
                    AgentThought(
                        id=uuid.uuid4(),
                        task_id=task_id,
                        event=QueueEvent.STOP,
                    ),
                )
```

这说明监听器不只是一个 `yield queue.get()` 的薄包装，它还承担了三层运行时职责：

- 给长连接定时发心跳，防止前端或网关误判断流
- 把超时变成显式 `TIMEOUT` 事件，而不是沉默失败
- 把外部停止标记转换成统一的 `STOP` 事件

外部停止也不是谁都能调，它会先校验任务归属：

```python
@classmethod
def set_stop_flag(
    cls, task_id: UUID, invoke_from: InvokeFrom, user_id: UUID
) -> None:
    from app.http.module import injector

    redis_client = injector.get(Redis)
    result = redis_client.get(cls.generate_task_belong_cache_key(task_id))
    if not result:
        return

    user_prefix = (
        "account"
        if invoke_from in [InvokeFrom.WEB_APP, InvokeFrom.DEBUGGER]
        else "end-user"
    )
    if result.decode("utf-8") != f"{user_prefix}-{str(user_id)}":
        return

    stopped_cache_key = cls.generate_task_stopped_cache_key(task_id)
    redis_client.setex(stopped_cache_key, 600, 1)
```

所以这里的停止控制，本质上不是“杀线程”，而是：

- 先校验是不是这次任务的真正归属方
- 再写 Redis 停止标记
- 由监听循环把它翻译成 `STOP` 事件并结束消费

这比直接中断线程稳得多，也更适合 WebApp、调试台、OpenAPI 这种多入口共享运行时。

## 真实代码里，Agent 节点就是通过队列管理器向外发事件

如果说 `BaseAgent.stream()` 解决的是“怎么跑”和“谁来监听”，那节点代码解决的就是“运行过程里的什么信息要被抛出去”。

这个项目里，节点不是返回一堆前端协议对象，而是在执行过程中主动调用 `agent_queue_manager.publish()`。

长期记忆节点会在真正拼接系统提示前先发一条记忆召回事件：

```python
if self.agent_config.enable_long_term_memory:
    long_term_memory = state.get("long_term_memory", "")
    if long_term_memory:
        self.agent_queue_manager.publish(
            state["task_id"],
            AgentThought(
                id=uuid.uuid4(),
                task_id=state["task_id"],
                event=QueueEvent.LONG_TERM_MEMORY_RECALL,
                observation=long_term_memory,
            ),
        )
```

LLM 节点在流式生成文本时，会持续发 `AGENT_MESSAGE`；如果最终生成的是工具调用，则改发 `AGENT_THOUGHT`：

```python
self.agent_queue_manager.publish(
    state["task_id"],
    AgentThought(
        id=id,
        task_id=state["task_id"],
        event=QueueEvent.AGENT_MESSAGE,
        thought=content,
        message=messages_to_dict(state["messages"]),
        answer=content,
        latency=(time.perf_counter() - start_at),
    ),
)

self.agent_queue_manager.publish(
    state["task_id"],
    AgentThought(
        id=id,
        task_id=state["task_id"],
        event=QueueEvent.AGENT_THOUGHT,
        thought=json.dumps(gathered.tool_calls, ensure_ascii=False),
        message=messages_to_dict(state["messages"]),
        answer="",
        total_token_count=total_token_count,
        total_price=total_price,
        latency=(time.perf_counter() - start_at),
    ),
)
```

工具节点再把工具观察结果翻译成 `AGENT_ACTION` 或 `DATASET_RETRIEVAL`：

```python
event = (
    QueueEvent.AGENT_ACTION
    if tool_call["name"] != DATASET_RETRIEVAL_TOOL_NAME
    else QueueEvent.DATASET_RETRIEVAL
)
self.agent_queue_manager.publish(
    state["task_id"],
    AgentThought(
        id=id,
        task_id=state["task_id"],
        event=event,
        observation=json.dumps(tool_result, ensure_ascii=False),
        tool=tool_call["name"],
        tool_input=tool_call["args"],
        latency=(time.perf_counter() - start_at),
    ),
)
```

这就把 Agent 和队列管理器的联动关系讲清楚了：

- 图节点负责“产生事件语义”
- 队列管理器负责“搬运事件、补心跳、处理终态、协调停止”
- 服务层和前端只负责消费统一的 `AgentThought`

所以平台真正暴露出去的不是 LangGraph 节点返回值，而是一套项目自己定义的 Agent 事件协议。

同时，这条链路上还有一组很实际的保护：

- 最大迭代次数保护
- 工具绑定能力保护
- 历史消息结构校验
- ReAct 文本解析失败降级
- 输出审核预设拦截

Agent 层真正难的地方，往往就在这些保护和治理能力，而不只是“让模型多想一步”。

## 真实代码里，会话记忆就是 Agent 运行时的一部分

你前面提的“把会话记忆并回 Agent 文档”是对的，因为这个项目里的记忆从来不是一个独立 RAG 模块，而是 Agent 运行时装配的一部分。

先看调试对话真正怎么把短期记忆、长期记忆和工具装起来：

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

agent_class = (
    FunctionCallAgent if ModelFeature.TOOL_CALL in llm.features else ReACTAgent
)
```

这段代码说明了三件事：

- 短期记忆不是“把数据库消息原样塞回去”，而是先经过 `TokenBufferMemory`
- 长期记忆不是外挂配置，而是和 Agent 选择、工具装配同时发生
- 记忆和知识库都进入 Agent 的同一轮运行时装配

短期记忆和长期记忆真正进入提示词的地方，在 `long_term_memory_recall` 节点里：

```python
preset_messages = [
    SystemMessage(
        AGENT_SYSTEM_PROMPT_TEMPLATE.format(
            preset_prompt=self.agent_config.preset_prompt,
            long_term_memory=long_term_memory,
        )
    )
]

history = state["history"]
if isinstance(history, list) and len(history) > 0:
    if len(history) % 2 != 0:
        self.agent_queue_manager.publish_error(
            state["task_id"], "智能体历史消息列表格式错误"
        )
        raise FailException("智能体历史消息列表格式错误")
    preset_messages.extend(history)

human_message = state["messages"][-1]
preset_messages.append(HumanMessage(human_message.content))

return {
    "messages": [RemoveMessage(id=human_message.id), *preset_messages],
}
```

这就把记忆的边界讲清楚了：

- `Conversation.summary` 是长期记忆，进系统提示
- `TokenBufferMemory` 取出来的是短期历史，进消息栈
- 当前问题会被重组到新的消息列表里，而不是简单拼接字符串

长期记忆的生成也不是同步阻塞主链路，而是在消息落库后异步更新：

```python
if app_config["long_term_memory"]["enable"]:
    Thread(
        target=self._generate_summary_and_update,
        kwargs={
            "flask_app": current_app._get_current_object(),
            "conversation_id": conversation.id,
            "query": message.query,
            "answer": agent_thought.answer,
            "account_id": account_id,
            "model_config": app_config.get("model_config"),
        },
    ).start()
```

```python
new_summary = self.summary(
    query,
    answer,
    conversation.summary,
    account_id,
    model_config,
)

self.update(
    conversation,
    summary=new_summary,
)
```

所以这个项目里的“会话记忆”其实包含三层：

- 对话前：`TokenBufferMemory` 裁剪短期历史
- 推理时：`long_term_memory_recall` 把长期摘要并入系统提示
- 对话后：后台线程增量更新 `Conversation.summary`

它天然就属于 Agent 运行时，而不是知识库文档的附属段落。

## 真实代码里，debugger / WebApp / OpenAPI 复用的是同一套 Agent 运行时

这个点很适合沉淀，因为很多项目一旦做多入口，最后会演化成三套聊天逻辑。

但这个项目从当前实现看，不是这么做的。三种入口虽然有各自的会话归属校验和发布校验，但进入运行时之前做的事情基本一致：

- 校验应用和会话归属
- 创建消息
- 装配模型、短期记忆、长期记忆、工具、知识库工具、工作流工具
- 根据模型能力在 `FunctionCallAgent / ReACTAgent` 之间分流

WebApp 入口的代码就是一个很直接的例子：

```python
if (
    not conversation
    or conversation.app_id != app.id
    or conversation.invoke_from != InvokeFrom.WEB_APP
    or conversation.created_by != account.id
    or conversation.is_deleted is True
):
    raise ForbiddenException(
        "该会话不存在，或者不属于当前应用/用户/调用方式"
    )

agent_class = (
    FunctionCallAgent if ModelFeature.TOOL_CALL in llm.features else ReACTAgent
)
agent = agent_class(
    llm=llm,
    agent_config=AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.WEB_APP,
        preset_prompt=app_config["preset_prompt"],
        enable_long_term_memory=app_config["long_term_memory"]["enable"],
        tools=tools,
        review_config=app_config["review_config"],
    ),
)
```

OpenAPI 入口也一样，只是归属主体从登录账号切到了终端用户，并且要求调用方式必须是 `SERVICE_API`：

```python
if app.status != AppStatus.PUBLISHED:
    raise NotFoundException("该应用不存在或未发布，请核实后重试")

if (
    not conversation
    or conversation.app_id != app.id
    or conversation.invoke_from != InvokeFrom.SERVICE_API
    or conversation.created_by != end_user.id
):
    raise ForbiddenException(
        "该会话不存在，或者不属于该应用/终端用户/调用方式"
    )

agent = agent_class(
    llm=llm,
    agent_config=AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.DEBUGGER,
        preset_prompt=app_config["preset_prompt"],
        enable_long_term_memory=app_config["long_term_memory"]["enable"],
        tools=tools,
        review_config=app_config["review_config"],
    ),
)
```

这说明平台真正复用的，不只是某个 `agent.invoke()`，而是一整套运行时装配方式。

顺着这段代码再多看一眼，还能发现一个很真实的工程信号：OpenAPI 入口这里当前传入的 `invoke_from` 仍然是 `DEBUGGER`。这不妨碍主链路复用，但它说明入口层的收口还没有完全做干净，后面如果继续增强任务归属、审计或停止控制，这种局部不一致就值得优先清理。

但从当前实现还能看到一个对后续演进很有价值的细节：多入口主链路虽然已经收敛，输入装配还没有完全收紧成一份契约。

- 调试态和 OpenAPI 入口仍然显式传 `history`
- WebApp 入口则直接把 `history + 当前消息` 合并到 `messages`

这不一定马上出问题，但它是一个值得记在实践文档里的信号：如果后面要继续做入口扩展，`AgentState` 的输入约束最好再统一一次，不然后续排查“同一个 Agent 为什么在不同入口表现不完全一样”会比较痛苦。

## 这套 Agent 设计最值得学的地方

### 1. 模式切换先发生在服务层

平台先根据模型能力选 Agent 类，而不是把所有判断都塞进提示词里。

### 2. 图骨架尽量复用

双模式没有各自维护一套独立状态机，后面维护成本会低很多。

### 3. 工具调用统一收敛到标准 `tool_calls`

无论是原生函数调用还是文本协议，都尽量归一到同一种内部表示。

### 4. LangGraph 负责状态机，平台自己负责运行时外壳

图编排交给 LangGraph，事件流、回放、停止和权限校验则由自定义 `AgentQueueManager` 这类运行时外壳补齐。

### 5. 前端看到的是平台语义，不是框架语义

前端关心的是“思考了什么、调了什么工具、为什么停下”，而不是某个框架底层返回了什么对象。

## 这一层最容易被讲浅的地方

很多人提 Agent 双模式时，只会说：

- 有的模型支持 Function Calling
- 有的模型不支持，所以退回 ReAct

这只说到了入口。

真正更值钱的，是下面这些平台级问题有没有一起解决：

- 两种模式是否共用同一条执行骨架
- 工具调用是否复用同一个运行节点
- 前端事件流是否统一
- 推理过程是否既能实时展示又能事后回放
- 停止控制是否具备任务归属和中断治理

如果这些问题没一起解决，那通常还只能算“支持两种调用方式”，不算“沉淀出平台的核心 Agent 层”。

## 我现在的判断

这个项目里的核心 Agent 层，最重要的不是“双模式”这三个字本身，而是它围绕双模式做出的结构选择：

1. 用同一张 LangGraph 图承接两种执行模式
2. 用统一 `tool_calls` 抹平原生函数调用和文本工具意图的差异
3. 用统一事件协议承接可视化、持久化和多入口输出
4. 用任务级停止和保护逻辑把执行层变成可治理的运行时

做到这一步，平台里的 Agent 才不只是一个聊天包装器，而是真正可复用、可扩展、可观测的执行内核。
