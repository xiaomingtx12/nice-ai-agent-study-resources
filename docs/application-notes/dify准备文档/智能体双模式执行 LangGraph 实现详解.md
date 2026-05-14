#  my-dify 智能体双模式执行 LangGraph 实现详解
## 1. 先说结论：这个项目里的“双模式 Agent”不是两套完全独立系统，而是“同一条执行骨架 + 两种 LLM 驱动方式”
这条能力在 `my-dify` 里不是简单地写了一个 `FunctionCallAgent` 和一个 `ReACTAgent` 就结束了，而是形成了一条完整链路：

1. 前端发起聊天请求，后端先创建 `Message`、提取短期记忆、读取长期记忆。
2. 服务层根据模型能力 `llm.features` 判断当前模型是否支持 `ModelFeature.TOOL_CALL`。
3. 支持原生工具调用时，选 `FunctionCallAgent`；不支持时，选 `ReACTAgent`。
4. 两个 Agent 最终都编译成 LangGraph 的 `StateGraph`，而且图骨架几乎完全一致，都是 `preset_operation -> long_term_memory_recall -> llm -> tools -> llm ...`。 
5. 两种模式的差异不在“图结构”，而在 `llm` 节点如何理解和产出“工具调用意图”。
6. 无论走哪种模式，最终都统一落到 `QueueEvent + AgentThought` 事件协议，前端据此实时显示推理过程，后端据此落库回放。
7. 停止执行也不是前端直接杀线程，而是基于 `task_id + Redis stop flag + 队列监听器` 做会话级中断控制。

所以这套实现真正有价值的点不是“支持两种 Agent”，而是：

+ 用同一张 LangGraph 图承接两种执行模式
+ 用统一事件流屏蔽模式差异
+ 用统一的可视化与持久化协议承接调试、WebApp、OpenAPI、微信等多入口

---

## 2. 代码落点先记住，面试时一定要说具体
### Agent 核心
+ `internal/core/agent/agents/base_agent.py`
+ `internal/core/agent/agents/function_call_agent.py`
+ `internal/core/agent/agents/react_agent.py`
+ `internal/core/agent/agents/agent_queue_manager.py`
+ `internal/core/agent/entities/agent_entity.py`
+ `internal/core/agent/entities/queue_entity.py`

### 服务入口
+ `internal/service/app_service.py`  
调试态 App 对话，使用草稿配置，自动切换双模式。
+ `internal/service/web_app_service.py`  
已发布 WebApp 对话，自动切换双模式。
+ `internal/service/openapi_service.py`  
OpenAPI 对话，自动切换双模式，兼容流式和非流式。
+ `internal/service/wechat_service.py`  
微信渠道对话，自动切换双模式。
+ `internal/service/assistant_agent_service.py`  
辅助 Agent 对话，目前固定走 `FunctionCallAgent`。

### 会话、记忆、可视化与路由
+ `internal/core/memory/token_buffer_memory.py`
+ `internal/service/conversation_service.py`
+ `internal/model/conversation.py`
+ `internal/schema/conversation_schema.py`
+ `internal/schema/assistant_agent_schema.py`
+ `internal/router/router.py`

### 前端可视化
+ `my-dify-ui/src/components/AgentThought.vue`
+ `my-dify-ui/src/views/space/apps/components/PreviewDebugChat.vue`
+ `my-dify-ui/src/views/web-apps/IndexView.vue`
+ `my-dify-ui/src/views/pages/HomeView.vue`
+ `my-dify-ui/src/config/index.ts`

### 版本信息
+ `requirements.txt`  
当前项目明确依赖 `langgraph==1.0.6`、`langchain_core==1.2.7`

---

## 3. 整体执行链路：从请求进入，到 LangGraph 运行，到 SSE 输出，再到推理落库
先把主链路记住，后面所有细节都挂在这条链上。

<!-- 这是一个文本绘图，源码为：flowchart LR
    A["前端 chat 请求"] --> B["Handler"]
    B --> C["Service: 创建 Message / Conversation"]
    C --> D["加载 LLM"]
    D --> E["TokenBufferMemory 提取短期记忆"]
    E --> F["装配 tools / dataset / workflow tools"]
    F --> G{"llm.features 包含 TOOL_CALL?"}
    G -- Yes --> H["FunctionCallAgent"]
    G -- No --> I["ReACTAgent"]
    H --> J["BaseAgent.stream()"]
    I --> J
    J --> K["CompiledStateGraph in worker thread"]
    K --> L["AgentQueueManager.publish()"]
    L --> M["Service 组装 SSE 事件"]
    M --> N["前端实时显示运行流程"]
    L --> O["ConversationService.save_agent_thoughts()"]
    O --> P["消息回放 / 推理过程持久化"] -->
![](https://cdn.nlark.com/yuque/__mermaid_v3/35636bc8ca0fa03383735f34f4978062.svg)

### 3.1 服务层真正做了什么
以 `AppService.debug_chat()` 为例，这个函数把整条执行链拼了起来：

1. 根据 `app_id` 找应用。
2. 读取最新草稿配置 `draft_app_config`。
3. 取调试会话 `debug_conversation`。
4. 新建 `Message`，把用户本轮输入先入库。
5. 通过 `LanguageModelService.load_language_model()` 加载 LLM。
6. 用 `TokenBufferMemory` 从历史消息中提取短期记忆。
7. 把普通工具、知识库检索工具、工作流工具都转成 LangChain `BaseTool`。
8. 根据 `ModelFeature.TOOL_CALL` 决定选 `FunctionCallAgent` 还是 `ReACTAgent`。
9. 调 `agent.stream()` 迭代接收事件，转成 SSE 推给前端。
10. 结束后把 `agent_thoughts` 统一落库。

`WebAppService`、`OpenAPIService`、`WechatService` 做的事情本质一样，只是：

+ 调试态读的是草稿配置
+ 发布态读的是已发布配置
+ OpenAPI 额外支持 `stream=true/false`
+ 不同入口的 `invoke_from` 不同，停止权限校验也会跟着变

### 3.2 辅助 Agent 是个特例
`AssistantAgentService.chat()` 里没有自动切到 `ReACTAgent`，而是直接固定：

+ 模型写死成 `qwen-max`
+ 特性写死为 `TOOL_CALL + AGENT_THOUGHT`
+ Agent 固定实例化为 `FunctionCallAgent`

所以面试时不能把“辅助 Agent 当前实现”说成“双模式自动切换”。更准确的说法是：

+ 平台级 Agent 执行链支持双模式自动切换
+ 辅助 Agent 当前因为模型是强约束配置，所以固定走 FunctionCall 模式

这类表述是严谨的。

---

## 4. 为什么说它是“同一张图，两种执行模式”
很多人会误以为这里是两张完全不同的 LangGraph 图，其实不是。

`FunctionCallAgent._build_agent()` 里直接把图编译出来：

```python
graph = StateGraph(AgentState)
graph.add_node("preset_operation", self._preset_operation_node)
graph.add_node("long_term_memory_recall", self._long_term_memory_recall_node)
graph.add_node("llm", self._llm_node)
graph.add_node("tools", self._tools_node)

graph.set_entry_point("preset_operation")
graph.add_conditional_edges("preset_operation", self._preset_operation_condition)
graph.add_edge("long_term_memory_recall", "llm")
graph.add_conditional_edges("llm", self._tools_condition)
graph.add_edge("tools", "llm")
```

它对应的图非常清晰：

<!-- 这是一个文本绘图，源码为：flowchart TD
    A["preset_operation"] -->|未触发预设拦截| B["long_term_memory_recall"]
    A -->|命中输入审核预设| Z["END"]
    B --> C["llm"]
    C -->|有 tool_calls| D["tools"]
    C -->|无 tool_calls| Z
    D --> C -->
![](https://cdn.nlark.com/yuque/__mermaid_v3/7f463b2987d02062543a83b948b3ae04.svg)

`ReACTAgent` 并没有重写 `_build_agent()`，它是直接继承 `FunctionCallAgent` 的图骨架，只重写：

+ `_long_term_memory_recall_node()`
+ `_llm_node()`

这就是这个项目最关键的工程点：

+ 图骨架不变
+ 差异集中在“提示词构建”和“LLM 输出解析”
+ 工具执行节点 `tools` 完全复用
+ 事件协议完全复用

换句话说，这里不是“两个 Agent 各写一套流程”，而是“一个 LangGraph 状态机，兼容两种思考方式”。

---

## 5. Agent 的核心抽象：为什么不是直接到处写函数
### 5.1 `BaseAgent` 统一的是“执行协议”
`BaseAgent` 同时继承了：

+ `Serializable`
+ `Runnable`

然后统一持有三类核心对象：

+ `llm`
+ `agent_config`
+ `_agent: CompiledStateGraph`
+ `_agent_queue_manager`

它做了三件很关键的事：

1. 在初始化时先把 LangGraph 图编译好。
2. `stream()` 负责启动执行线程并监听事件队列。
3. `invoke()` 负责把流式事件重新聚合成最终 `AgentResult`。

所以 `BaseAgent` 的价值不在“LangGraph 强制要求这么做”，而在项目工程层面统一了：

+ 图编译
+ 流式输出
+ 块式输出
+ 事件聚合
+ 队列管理

### 5.2 `AgentConfig` 是运行期配置容器
`AgentConfig` 里不是只放 prompt，它把一轮 Agent 执行真正需要的运行期信息全部收进来了：

+ `user_id`
+ `invoke_from`
+ `system_prompt`
+ `preset_prompt`
+ `enable_long_term_memory`
+ `tools`
+ `review_config`
+ `max_iteration_count`

这样做的好处是：

+ 服务层只要把配置装配好再交给 Agent
+ Agent 内部所有节点都能直接读统一配置
+ 新增能力只需要扩充 `AgentConfig`

### 5.3 `AgentState` 不是随便的 dict，而是基于 `MessagesState`
这点非常重要。

`AgentState` 定义是：

+ 继承 `langgraph.graph.MessagesState`
+ 额外补充 `task_id`
+ `iteration_count`
+ `history`
+ `long_term_memory`

这意味着当前 Agent 图不是自己手写“消息拼接器”，而是利用了 LangGraph 的消息状态归并能力。

这带来几个直接好处：

1. 节点只需要返回增量 patch，比如 `{"messages": [AIMessage(...)]}`。
2. LangGraph 会把这些消息自动并入状态，而不是每个节点自己手动拷贝整个 state。
3. `tools` 节点只要返回 `ToolMessage` 列表，就能自然进入下一轮 `llm`。
4. `llm` 节点只要返回带 `tool_calls` 的 `AIMessage`，条件边就能决定是否进 `tools`。

这就是 LangGraph 在这里最实用的价值，不是“为了好看”，而是让 Agent 节点只返回状态增量。

### 5.4 `QueueEvent + AgentThought` 是统一事件协议
这个项目把所有推理过程抽象成统一事件模型：

+ `LONG_TERM_MEMORY_RECALL`
+ `AGENT_THOUGHT`
+ `AGENT_MESSAGE`
+ `AGENT_ACTION`
+ `DATASET_RETRIEVAL`
+ `AGENT_END`
+ `TIMEOUT`
+ `PING`
+ `STOP`
+ `ERROR`

对应的数据载体是 `AgentThought`，里面统一承载：

+ 事件类型
+ `thought`
+ `observation`
+ `tool`
+ `tool_input`
+ `answer`
+ token / price / latency
+ `task_id`

这使得：

+ FunctionCall 和 ReACT 两种模式都能输出同一批事件
+ 前端不需要关心底层到底是不是原生 tool call
+ 数据库存储也不需要为两种模式建两张表

---

## 6. LangGraph 的状态归并能力，在这个 Agent 里具体承接了什么
这是面试很容易被追问的一点，必须讲细。

### 6.1 不是每个节点都返回完整状态，只返回“改动”
例如 `FunctionCallAgent._llm_node()` 末尾返回：

```python
return {"messages": [gathered], "iteration_count": state["iteration_count"] + 1}
```

这表示：

+ `messages` 增量追加一条新的 AIMessage
+ `iteration_count` 更新为下一轮

节点自己并没有重新构建完整 `AgentState`。

### 6.2 `tools` 节点复用 LangGraph 的消息归并
`_tools_node()` 返回的是：

```python
return {"messages": messages}
```

其中 `messages` 是一组 `ToolMessage`。

LangGraph 会把这些 `ToolMessage` 合并回原状态中的 `messages`，于是下一轮 `llm` 自然能拿到：

+ 之前的人类问题
+ 系统消息
+ 上一轮 AI 的 tool_calls
+ 本轮工具观察结果

这就是 Agent 循环能成立的原因。

### 6.3 `RemoveMessage` 被用来重写原始输入消息
在 `long_term_memory_recall` 节点里，项目不是简单地 `messages = [system] + history + human` 然后整包覆盖，而是返回：

```python
{
    "messages": [RemoveMessage(id=human_message.id), *preset_messages],
}
```

这里利用了 LangGraph 对消息操作的支持，做了两件事：

1. 先移除原始的最后一条人类消息。
2. 再插入系统消息、历史消息、重建后的当前人类消息。

这样做的结果是：

+ 不需要手工重建整个 state
+ 当前 Agent 图内部的消息历史保持一致
+ 工具循环时消息栈格式稳定

### 6.4 为什么这点很重要
如果不用 `MessagesState` 这种归并能力，项目就得自己管理：

+ 消息 append
+ 消息 replace
+ 工具消息插入
+ 条件循环后的历史延续

代码会更脆，而且很容易在 ReACT 和 FunctionCall 两套路径里写出两份不同逻辑。

这个项目的做法是：

+ 让 LangGraph 处理消息状态归并
+ 自己只处理“当前节点新增了什么”

这就是“LangGraph 在这个项目里真正做了什么”。

---

## 7. FunctionCall 模式是怎么跑起来的
## 7.1 `preset_operation`：先做预设拦截
这个节点先读 `review_config` 和用户 query。

如果开启了输入审核，且 query 命中敏感关键词：

1. 直接发布一个 `AGENT_MESSAGE` 事件，内容是预设回复。
2. 再发布一个 `AGENT_END`。
3. 返回 `AIMessage(preset_response)`。

随后 `_preset_operation_condition()` 会发现最后一条消息已经是 AIMessage，于是直接 `END`。

这相当于在 LangGraph 图的最前面加了一层“熔断器”。

## 7.2 `long_term_memory_recall`：把系统提示、长期记忆、短期记忆统一塞进消息栈
这个节点做了四件事：

1. 如果开启长期记忆，读取 `state["long_term_memory"]`。
2. 如果确实有摘要内容，先发一个 `LONG_TERM_MEMORY_RECALL` 事件给前端。
3. 用 `AGENT_SYSTEM_PROMPT_TEMPLATE.format(...)` 把 `preset_prompt` 和 `long_term_memory` 填到系统提示词里。
4. 把历史消息 `history` 和当前用户问题拼到系统消息后面，再通过 `RemoveMessage` 重写消息状态。

另外这里还有一个很实用的校验：

+ `history` 长度必须是偶数
+ 也就是必须符合 `[Human, AI, Human, AI, ...]`

如果不是偶数：

+ 直接 `publish_error`
+ 记录日志
+ 抛 `FailException`

这说明项目不是把记忆塞进去就完了，而是对提示消息结构做了强约束。

## 7.3 `llm`：区分“模型是在回答”还是“模型在发起工具调用”
`FunctionCallAgent._llm_node()` 是整个 FunctionCall 模式的核心。

### 第一步：先守住最大迭代次数
如果 `iteration_count > max_iteration_count`：

+ 发布一条“超过最大迭代次数”的 `AGENT_MESSAGE`
+ 再发 `AGENT_END`
+ 返回 AIMessage

这相当于给 Agent 循环加了硬闸门。

### 第二步：尽量原生绑定工具
在这几个条件都成立时才绑定：

+ `ModelFeature.TOOL_CALL in llm.features`
+ `llm` 有 `bind_tools`
+ `bind_tools` 可调用
+ `tools` 非空

然后执行：

```python
llm = llm.bind_tools(self.agent_config.tools)
```

如果底层模型宣称支持工具，但实际 `bind_tools` 没实现，会捕获 `NotImplementedError`，退回不绑定工具的方式运行。

这一步体现出项目对“模型元数据”和“真实 SDK 能力”是分开防守的。

### 第三步：边流式接收，边判定生成类型
代码会在流式迭代中区分两种输出：

+ `chunk.tool_calls` 存在，说明这是“思考/工具调用意图”
+ `chunk.content` 存在，说明这是“最终回答文本”

一旦判定为消息型输出，就会不断发布 `AGENT_MESSAGE`：

+ `thought = 当前 chunk 内容`
+ `answer = 当前 chunk 内容`
+ `message = 当前上下文消息列表`
+ `latency = 当前累计耗时`

这就是前端能一个 token 一个 token 地看到回答长出来的原因。

### 第四步：收尾时补齐 token 和价格信息
流式结束后，项目不会只返回文本，还会补算：

+ `input_token_count`
+ `output_token_count`
+ `total_token_count`
+ `total_price`

这里 FunctionCall 模式用的是 `TokenCounter` 做较精确的消息 token 计数。

### 第五步：如果是工具调用，则发 `AGENT_THOUGHT`
如果生成类型是 `thought`，会发布：

+ `event = AGENT_THOUGHT`
+ `thought = json.dumps(gathered.tool_calls)`

注意这里并不直接执行工具，而是把“工具调用计划”先作为一个推理事件暴露出来，这就是“推理过程可视化”的基础。

### 第六步：如果是最终回答，则发统计消息并 `AGENT_END`
如果生成类型是 `message`：

1. 发送一条空内容的 `AGENT_MESSAGE`，主要补齐 token / price / latency 统计。
2. 发送 `AGENT_END`。

这样做能保证前端既拿到了逐 chunk 文本，也拿到了最终统计信息。

## 7.4 `tools`：把工具调用计划变成观察结果
`_tools_node()` 的逻辑很直接：

1. 先把工具列表转成 `tools_by_name`。
2. 从最后一条 AIMessage 里拿 `tool_calls`。
3. 按工具名找到实际 `BaseTool`。
4. `tool.invoke(tool_call["args"])` 执行工具。
5. 把结果封装成 `ToolMessage` 返回给消息状态。
6. 同时发一条可视化事件：
    - 普通工具：`AGENT_ACTION`
    - 知识库检索工具：`DATASET_RETRIEVAL`

这里一个非常关键的设计点是：

+ LangGraph 看的是 `ToolMessage`
+ 前端看的是 `AgentThought`

前者负责让图继续跑，后者负责让用户看得见。

## 7.5 条件边如何闭环
`_tools_condition()` 只做一件事：

+ 如果最后一条 AIMessage 里有 `tool_calls`，走 `tools`
+ 否则直接 `END`

所以 FunctionCall 模式的循环条件非常纯粹：

+ 有工具调用就继续
+ 没有工具调用就结束

---

## 8. ReACT 模式不是另起炉灶，而是把“文本里的工具调用意图”重新归一化成 `tool_calls`
这是这个项目最值得讲的面试亮点。

## 8.1 为什么 `ReACTAgent` 继承的是 `FunctionCallAgent`
很多人第一次看会以为 ReACT 要完全重写图。

但这里作者的选择是：

+ `ReACTAgent(FunctionCallAgent)`

原因非常务实：

1. 图骨架相同，不需要重复编译四个节点的图。
2. `tools` 节点完全可以复用。
3. 条件边 `_tools_condition()` 也可以复用。
4. 只要把 ReACT 文本输出重新标准化成 `AIMessage.tool_calls`，后面整条工具链都不用改。

这就是典型的平台化思路。

## 8.2 `long_term_memory_recall` 在 ReACT 模式下做了什么
### 第一层分流：如果模型支持原生 tool call，直接退回父类
代码一进来先判断：

```python
if ModelFeature.TOOL_CALL in self.llm.features:
    return super()._long_term_memory_recall_node(state)
```

这很重要，说明即便错误地实例化成 `ReACTAgent`，只要模型真的支持原生工具调用，也会自动退回 FunctionCall 路径。

所以实际上这里有两层保险：

1. 服务层选型时已经做过一次 `FunctionCallAgent / ReACTAgent` 分流。
2. ReACT 节点内部又做了一次运行时兜底。

### 第二层分流：模型是否支持 `AGENT_THOUGHT`
如果模型不支持 `TOOL_CALL`，ReACT 模式继续看：

+ 支持 `AGENT_THOUGHT`：使用 `REACT_AGENT_SYSTEM_PROMPT_TEMPLATE`
+ 不支持 `AGENT_THOUGHT`：退回普通 `AGENT_SYSTEM_PROMPT_TEMPLATE`

这意味着：

+ “ReACTAgent” 这个类不等于“一定能清楚展示推理链”
+ 真正能不能展示出显式推理，还取决于模型是否支持 `AGENT_THOUGHT`

如果不支持，就只能让模型尽量直接回答，而不是强迫它生成 JSON 工具计划。

### 第三步：把工具描述直接灌进系统提示词
如果支持 `AGENT_THOUGHT`，会调用：

```python
render_text_description_and_args(self.agent_config.tools)
```

把所有工具整理成文本描述，注入到 `REACT_AGENT_SYSTEM_PROMPT_TEMPLATE` 里。

模板明确要求模型：

+ 如果要调用工具，必须输出 fenced JSON
+ 只允许两个字段：`name`、`args`
+ 必须以 ````json` 开头，以 ``` 结尾

所以 ReACT 模式本质上是在做“prompt 约束下的伪工具调用协议”。

## 8.3 `llm` 节点如何把文本协议变回统一工具调用
这部分最能体现项目功力。

### 第一步：如果模型支持 TOOL_CALL，直接走父类
同样先看：

```python
if ModelFeature.TOOL_CALL in self.llm.features:
    return super()._llm_node(state)
```

也就是说，ReACT 模式其实只负责“不支持原生 tool call 的模型”。

### 第二步：流式输出时判断这是“普通文本”还是“伪工具调用”
ReACT 模式没有 `chunk.tool_calls` 可看，所以换了规则：

+ 如果累计内容以 ````json` 开头，则判定为 `thought`
+ 否则判定为 `message`

一旦判定为 `message`，就和 FunctionCall 模式一样持续发布 `AGENT_MESSAGE`，前端照样可以实时看到文本生成。

### 第三步：如果判定为 `thought`，就去解析 fenced JSON
流式结束后，ReACTAgent 会执行：

1. 用正则把 fenced JSON 内容提出来。
2. `json.loads(...)` 解析成对象。
3. 构造一个统一格式的 `tool_calls`：

```python
[
    {
        "id": str(uuid.uuid4()),
        "type": "tool_call",
        "name": match_json.get("name", ""),
        "args": match_json.get("args", {}),
    }
]
```

4. 发布一条 `AGENT_THOUGHT` 事件，把这次“推理/工具计划”可视化出来。
5. 最关键的一步：返回

```python
{"messages": [AIMessage(content="", tool_calls=tool_calls)]}
```

这一步就是整个双模式统一的关键。

它相当于把：

+ ReACT 文本协议

重新归一化成：

+ LangGraph 能理解的标准 `AIMessage.tool_calls`

于是后续的：

+ `_tools_condition()`
+ `_tools_node()`
+ 工具执行
+ 事件输出

全部都能继续复用 FunctionCall 模式。

### 第四步：如果 JSON 解析失败，就降级成普通回答
如果模型没严格按照约定输出 fenced JSON：

+ 不抛异常中断整条图
+ 直接把 `gathered.content` 当成最终消息
+ 发布 `AGENT_MESSAGE`

这说明 ReACT 模式做的是“尽量利用工具”，而不是“格式错一点就整轮失败”。

## 8.4 这套设计为什么好
一句话总结：

+ ReACTAgent 并不是自己执行工具
+ 它做的是“把文本形式的工具意图，翻译回统一的 tool_calls 结构”

这让两种模式真正共享了：

+ 同一张 LangGraph 图
+ 同一个 tools 节点
+ 同一套前端事件协议
+ 同一套数据库落库模型

这就是最值得在面试里展开的实现细节。

---

## 9. 自动切换到底发生在哪一层
这个问题面试一定会问。

## 9.1 主要切换点在服务层
在这几处服务里都能看到同样的判断：

+ `internal/service/app_service.py`
+ `internal/service/web_app_service.py`
+ `internal/service/openapi_service.py`
+ `internal/service/wechat_service.py`

核心代码模式都是：

```python
agent_class = (
    FunctionCallAgent if ModelFeature.TOOL_CALL in llm.features else ReACTAgent
)
agent = agent_class(...)
```

所以第一层切换是：

+ **服务层根据模型能力选 Agent 类**

## 9.2 第二层兜底在 ReACTAgent 内部
`ReACTAgent._long_term_memory_recall_node()` 和 `_llm_node()` 都有：

```python
if ModelFeature.TOOL_CALL in self.llm.features:
    return super()....
```

所以第二层切换是：

+ **节点内部根据模型能力再做一次兜底**

面试时推荐直接说：

> 这个项目的自动切换不是只在入口 if/else 一次，而是“服务层选型 + ReACT 节点内部兜底”双保险，避免模型能力和实例化类型不一致时跑偏。
>

## 9.3 模型能力来自哪里
模型能力来自 `llm.features`，它的定义在：

+ `internal/core/language_model/entities/model_entity.py`

当前项目显式定义了：

+ `TOOL_CALL`
+ `AGENT_THOUGHT`
+ `IMAGE_INPUT`
+ `VIDEO_INPUT`

这里真正参与双模式编排的是前两个：

+ `TOOL_CALL` 决定能否原生函数调用
+ `AGENT_THOUGHT` 决定是否值得启用 ReACT 风格显式推理

---

## 10. 统一事件流输出是怎么做出来的
## 10.1 `BaseAgent.stream()` 把图执行和事件消费拆成了两条线
`BaseAgent.stream()` 干的事情很少，但非常关键：

1. 先给 `input` 填 `task_id`、`iteration_count`、`long_term_memory` 默认值。
2. 启一个守护线程去执行 `self._agent.invoke(input)`。
3. 主线程直接 `yield from self._agent_queue_manager.listen(task_id)`。

这个设计意味着：

+ LangGraph 图在后台跑
+ 前台只负责从事件队列拉事件

所以对外暴露的不是 LangGraph 原始流，而是项目自定义过的事件流。

### 10.1.1 `AgentQueueManager` 不是普通工具类，而是整条流式执行链的事件中枢
`AgentQueueManager` 的职责不是“帮忙封装一下 Queue”，而是把下面几件事收敛到一个地方：

1. 为每个 `task_id` 管理独立的内存队列。
2. 把 LangGraph 节点发布出来的 `AgentThought` 事件缓存起来。
3. 给流式响应提供统一监听出口 `listen()`。
4. 用 Redis 记录任务归属和停止标记。
5. 把 `STOP / ERROR / TIMEOUT / AGENT_END` 这些终态事件和监听终止行为绑定起来。

如果没有这个类，代码就得在：

+ `BaseAgent`
+ 各个节点
+ 各个 Service
+ 各个 stop 接口

之间分散处理队列、归属校验、超时、心跳和停止逻辑，工程上会很散。

### 10.1.2 这个类内部到底持有什么
`AgentQueueManager` 内部核心字段很少，但都很关键：

+ `user_id`
+ `invoke_from`
+ `redis_client`
+ `_queues: dict[str, Queue]`

这几个字段分别解决不同问题：

+ `user_id + invoke_from`  
用来标记这次任务归属给谁，后面 stop 时要做权限校验。
+ `redis_client`  
用来做跨请求的任务归属与停止标记存储。
+ `_queues`  
是进程内的真实事件缓冲区，key 是 `task_id`，value 是 Python `Queue`。

这里要注意一个实现事实：

+ 事件队列本身是**进程内内存对象**
+ 归属和停止标记是**Redis 键**

也就是说，这个实现是“内存队列 + Redis 协议”的混合设计，不是纯 Redis Stream，也不是纯内存。

### 10.1.3 `queue(task_id)` 做了什么
`queue(task_id)` 是懒创建的。

第一次访问某个 `task_id` 时，它会：

1. 根据 `invoke_from` 计算用户前缀：
    - `WEB_APP / DEBUGGER` -> `account`
    - 其他入口 -> `end-user`
2. 往 Redis 写入任务归属键：
    - key: `generate_task_belong:{task_id}`
    - value: `account-{user_id}` 或 `end-user-{user_id}`
    - TTL: `1800` 秒
3. 创建一个新的 Python `Queue`
4. 放进 `_queues[str(task_id)]`

这一步非常重要，因为 stop 接口后续不是凭空判断权限，而是依赖这个归属键。

换句话说，`queue(task_id)` 不只是“拿队列”，它顺手还把“这次任务属于谁”注册了。

### 10.1.4 `publish()`、`publish_error()`、`stop_listen()` 是怎么配合的
`publish(task_id, agent_thought)` 的行为很直接：

1. 先把 `AgentThought` 放进对应队列。
2. 如果事件类型属于终态：
    - `STOP`
    - `ERROR`
    - `TIMEOUT`
    - `AGENT_END`
3. 立即调用 `stop_listen(task_id)`。

`stop_listen(task_id)` 的实现也很简单：

+ 往队列里塞一个 `None`

这个 `None` 就是监听器退出的哨兵值。

`publish_error()` 本质上只是一个便捷方法：

+ 自动构造 `QueueEvent.ERROR`
+ 把异常文本填进 `observation`
+ 再转调 `publish()`

所以这三者的关系可以理解成：

+ `publish()` 负责发正常/终态事件
+ `publish_error()` 负责把异常转成标准错误事件
+ `stop_listen()` 负责真正结束监听循环

### 10.1.5 `listen(task_id)` 的运行机制要讲清楚
`listen()` 是整个流式事件消费的核心。

它不是简单地 `while True: q.get()`，而是同时做了四件事：

1. 从对应队列里 `get(timeout=1)` 拉事件。
2. 拿到 `None` 时退出监听。
3. 每 10 秒主动发一个 `PING` 事件。
4. 每轮检查是否超时、是否被 stop。

代码级逻辑可以概括成：

```python
while True:
    try:
        item = self.queue(task_id).get(timeout=1)
        if item is None:
            break
        yield item
    except queue.Empty:
        continue
    finally:
        # ping / timeout / stop check
```

有两个非常值得面试时说的点：

1. 它把 `ping / timeout / stop check` 放在 `finally` 里。  
这意味着无论当前轮是成功取到事件，还是 `queue.Empty`，这些治理逻辑都会执行，不会因为队列暂时没数据就漏掉心跳或 stop 检测。
2. 它的监听超时是管理“响应流生命周期”，不是直接取消 LangGraph 执行线程。  
超时后发的是 `TIMEOUT` 事件，然后由 `publish()` 带着监听器退出。

### 10.1.6 Redis 里到底有哪两个键
当前 `AgentQueueManager` 明确维护两类 Redis key：

1. `generate_task_belong:{task_id}`
    - 记录这次任务属于谁
    - TTL 1800 秒
2. `generate_task_stopped:{task_id}`
    - 记录这次任务是否被请求停止
    - TTL 600 秒

这两个键的职责分工是：

+ `belong` 解决权限校验
+ `stopped` 解决运行中断信号传递

它们是分开的，说明作者没有把“任务归属”和“停止状态”混在一个值里。

### 10.1.7 `set_stop_flag()` 为什么必须是类方法
`set_stop_flag()` 被设计成类方法，不依赖某个现成的 `AgentQueueManager` 实例。

这是必要的，因为 stop 请求往往发生在另一个 HTTP 请求上下文里：

+ 开始聊天时创建了一个 Agent 实例
+ 用户点击停止时，进入的是另一个 handler/service 调用栈

这个新的请求上下文里并不持有原先那个 Agent 实例，但只要知道：

+ `task_id`
+ `invoke_from`
+ `user_id`

就可以通过 Redis 找到归属并写停止标记。

这就是为什么 stop 能跨请求生效。

### 10.1.8 `set_stop_flag()` 具体做了哪几步
它的流程很明确：

1. 重新从 injector 里拿 Redis 客户端。
2. 读取 `generate_task_belong:{task_id}`。
3. 如果归属键不存在，直接返回。
4. 根据当前请求来源计算用户前缀：
    - `account` 或 `end-user`
5. 校验 Redis 中记录的归属值是否等于 `"{prefix}-{user_id}"`。
6. 只有校验通过，才写入：
    - `generate_task_stopped:{task_id}` = `1`
    - TTL `600` 秒

所以 stop 请求不是“通知一下就停”，而是：

+ 先确认任务存在
+ 再确认操作者就是任务拥有者
+ 最后才写停止标记

### 10.1.9 为什么说它是“协作式中断”
从 `AgentQueueManager` 的实现就能看出来，当前停止机制的本质是：

1. stop 请求写 Redis 停止标记。
2. `listen()` 在轮询里发现这个标记。
3. 发布 `STOP` 事件。
4. 结束事件监听。

它没有做这些事：

+ 杀掉执行 LangGraph 的后台线程
+ 主动 cancel 底层模型 SDK 请求
+ 主动打断正在运行的外部工具

所以更准确的说法是：

+ 它停掉的是“事件输出与响应流”
+ 后台执行本身是协作式收尾，不是强制中断

### 10.1.10 这套 `AgentQueueManager` 设计的价值和边界
它的优点很明显：

1. 统一了事件发布协议。
2. 统一了 stop、timeout、ping 机制。
3. stop 可以跨请求生效。
4. 前端和 Service 层都不需要知道 LangGraph 内部细节。

但边界也很清楚：

1. `_queues` 是进程内内存结构，不是跨进程共享队列。
2. stop 依赖监听器轮询，不是底层执行引擎的强取消。
3. 如果未来要做多 worker 更强的一致性控制，可能需要把事件总线升级成更强的跨进程方案。

这类“既讲优点，也讲边界”的回答，面试里会更像真正做过实现的人。

## 10.2 为什么前端看到的是统一事件，而不是不同模式不同格式
因为两种模式最终都在节点里调用：

+ `self.agent_queue_manager.publish(...)`

发布的都是 `AgentThought`。

于是前端拿到的始终是统一 SSE 格式：

```latex
event: agent_message
data: {...}
```

或者：

```latex
event: agent_thought
data: {...}
```

服务层做的事情只是把 `AgentThought` 转成 SSE 文本：

```python
yield f"event: {agent_thought.event.value}\ndata:{json.dumps(data)}\n\n"
```

这就是“统一事件流输出”的真正实现，不是 LangGraph 自带的，而是项目在 LangGraph 之上再包了一层事件协议。

## 10.3 为什么 `AGENT_MESSAGE` 要按同一个 `id` 叠加
`AGENT_MESSAGE` 是流式 token/chunk 逐步产生的。

所以这个项目在：

+ `BaseAgent.invoke()`
+ `AppService.debug_chat()`
+ `WebAppService.web_app_chat()`
+ `AssistantAgentService.chat()`
+ `OpenAPIService.chat()`

都做了同样一件事：

+ 如果同一个 `event_id` 再次出现，说明这是同一条消息的后续 chunk
+ 就把 `thought` / `answer` 继续追加，而不是新增一个步骤

这就是为什么前端会看到：

+ 一条“智能体消息”步骤不断变长
+ 而不是每个 token 都变成一条独立步骤

## 10.4 `PING`、`TIMEOUT`、`AGENT_END` 的作用
`AgentQueueManager.listen()` 做了三个额外保障：

1. 每 10 秒自动发一次 `PING`
    - 防止长连接空闲被中间层断开
2. 超过 600 秒发 `TIMEOUT`
    - 给会话一个统一超时出口
3. 收到 `STOP / ERROR / TIMEOUT / AGENT_END` 后自动 `stop_listen()`
    - 用 `None` 哨兵把监听器停掉

所以这个项目的流式会话不是“靠前端猜什么时候结束”，而是服务端明确发终态事件。

---

## 11. 推理过程可视化，后端到底做了哪些事
## 11.1 实时可视化：前端按事件流增量构建 `agent_thoughts`
在前端的：

+ `PreviewDebugChat.vue`
+ `IndexView.vue`
+ `HomeView.vue`

都能看到同样的事件处理逻辑：

1. 收到 SSE 事件，先取 `event`、`data`、`event_id`。
2. 如果是 `ping`，直接忽略。
3. 如果是 `agent_message`：
    - 同 id 则叠加 `thought`
    - 没见过则新建一个步骤
    - 同时把 `messages[0].answer += data.thought`
4. 如果是 `error`、`timeout`，直接改答案展示。
5. 其他事件直接 push 到 `agent_thoughts`。

也就是说，前端不是等后端返回完整结构，而是自己一边收事件一边构造“运行流程”。

## 11.2 UI 组件如何展示步骤
`my-dify-ui/src/components/AgentThought.vue` 会把下面这些事件映射成不同标题和图标：

+ `long_term_memory_recall` -> 长期记忆召回
+ `agent_thought` -> 智能体推理
+ `dataset_retrieval` -> 搜索知识库
+ `agent_action` -> 调用工具
+ `agent_message` -> 智能体消息

所以前端可视化不是对整个 Agent 图做节点级渲染，而是对后端吐出来的步骤流做折叠面板展示。

这也是一个非常现实的工程选择：

+ 实现成本低
+ 不依赖前端知道 LangGraph 内部状态
+ 但用户仍然能看到“记忆 -> 推理 -> 调工具 -> 最终回答”完整链路

## 11.3 持久化回放：`MessageAgentThought` 表负责存步骤
实时可视化只能看本次执行，历史回放要靠数据库。

`ConversationService.save_agent_thoughts()` 会把这些事件持久化到 `message_agent_thought` 表：

+ `position`
+ `event`
+ `thought`
+ `observation`
+ `tool`
+ `tool_input`
+ `message`
+ `answer`
+ `latency`
+ `token` / `price`

其中会真正落成步骤的事件包括：

+ `LONG_TERM_MEMORY_RECALL`
+ `AGENT_THOUGHT`
+ `AGENT_MESSAGE`
+ `AGENT_ACTION`
+ `DATASET_RETRIEVAL`

而：

+ `STOP`
+ `TIMEOUT`
+ `ERROR`

更多是拿来更新 `Message.status` 和 `Message.error`。

## 11.4 为什么消息表和推理表要分开
`Message` 负责存：

+ 用户 query
+ 最终 answer
+ 消息总 token / 总耗时 / 总价格

`MessageAgentThought` 负责存：

+ 生成 answer 的中间推理步骤

这样做的好处是：

1. 聊天列表查询时可以只看最终答案。
2. 需要追查过程时再展开 `agent_thoughts`。
3. 推理过程结构足够细，可以支持调试和回放。

这就是“推理过程可视化”和“最终消息存储”为什么要分成两层数据模型。

---

## 12. 会话级中断控制到底是怎么实现的
这块是最容易被面试官追问“你们到底是怎么停掉的”的地方。

## 12.1 停止接口不是传 conversation_id，而是传 `task_id`
路由层暴露了这些停止接口：

+ `/assistant-agent/chat/<uuid:task_id>/stop`
+ `/web-apps/<string:token>/chat/<uuid:task_id>/stop`
+ `/apps/<uuid:app_id>/conversations/tasks/<uuid:task_id>/stop`

这说明当前项目停的不是“整个会话”，而是**当前这一次生成任务**。

所以更精确的说法应该是：

+ 它是“会话轮次级任务中断”
+ 前端 UI 上看起来像“停止本轮会话生成”

## 12.2 服务层只做一件事：设置 stop flag
无论是：

+ `AssistantAgentService.stop_chat()`
+ `AppService.stop_debug_chat()`
+ `WebAppService.stop_web_app_chat()`

最终都会调用：

```python
AgentQueueManager.set_stop_flag(task_id, invoke_from, user_id)
```

## 12.3 为什么要带 `invoke_from + user_id`
`AgentQueueManager.queue(task_id)` 在第一次创建队列时，会往 Redis 里写：

+ `generate_task_belong:{task_id}` -> `account-xxx` 或 `end-user-xxx`

`set_stop_flag()` 会先读这个归属键，再校验：

+ 当前发起停止请求的人，是不是这个任务真正归属的人

只有归属匹配才会写：

+ `generate_task_stopped:{task_id}` = 1

这一步非常重要，因为它避免了：

+ A 用户停掉 B 用户的任务
+ WebApp 终端用户停掉后台调试任务
+ 调试端误停 OpenAPI 任务

所以这不是简单的“写个 Redis 键”，而是一个带归属校验的停止协议。

## 12.4 真正感知停止的是 `listen()` 循环
`AgentQueueManager.listen()` 每轮循环都会检查：

```python
if self._is_stopped(task_id):
    self.publish(task_id, AgentThought(... event=QueueEvent.STOP))
```

一旦发现 stop flag：

1. 发布 `STOP` 事件。
2. `publish()` 发现这是终态事件。
3. 自动调用 `stop_listen(task_id)`。
4. 往队列塞一个 `None` 哨兵，监听器退出。

于是前端就能立刻停止继续接收内容。

## 12.5 这是不是“真正杀掉”了后台线程
严格说，不是。

从当前代码看，`BaseAgent.stream()` 里只是：

+ 开了一个守护线程执行 `self._agent.invoke(input)`
+ 监听线程收到 `STOP` 后停止对外输出

代码里并没有：

+ 显式取消 LangGraph 图执行
+ 主动中断底层 LLM HTTP 请求
+ 主动终止正在运行的工具线程

所以更准确的表述是：

> 当前实现的“停止”是队列监听层和响应流层的协作式中断，不是操作系统级别的强杀线程。
>

这是一个非常重要的面试加分点，因为它表明你真的读过代码，而不是只看接口名猜功能。

---

## 13. 调试时和正式运行时做了哪些校验与保护
这部分一定不要只说“有异常处理”，要说清楚代码里真的做了什么。

## 13.1 请求层校验
例如：

+ `AssistantAgentChat` 校验 query 非空
+ `image_urls` 必须是列表
+ 图片数量不能超过 5
+ 每个 URL 必须是合法 URL

其他聊天入口也有各自请求校验 schema。

## 13.2 模型能力校验
运行前显式检查：

+ 是否支持 `TOOL_CALL`
+ 是否支持 `AGENT_THOUGHT`

这决定：

+ 选哪个 Agent 类
+ 用哪套 prompt
+ 能否绑定原生工具

## 13.3 历史消息结构校验
在 `long_term_memory_recall` 节点里：

+ `history` 必须成对出现
+ 长度必须是偶数

否则直接报错终止。

## 13.4 最大迭代次数保护
`iteration_count > max_iteration_count` 时：

+ 不再继续工具循环
+ 直接返回预设提示并结束

避免工具死循环。

## 13.5 工具绑定能力保护
即便模型 `features` 声称支持 `TOOL_CALL`，也还会校验：

+ 有没有 `bind_tools`
+ `bind_tools` 能不能调用
+ 绑定时会不会抛 `NotImplementedError`

这是在防供应商 SDK 和元数据不一致。

## 13.6 ReACT JSON 解析保护
ReACT 模式不会假设模型一定输出正确 JSON：

+ 先正则抽取 fenced JSON
+ 再 `json.loads`
+ 失败则降级为普通消息

避免把格式问题直接升级成整轮失败。

## 13.7 输出审核保护
如果开启输出审核：

+ 流式文本 chunk 会按关键词做脱敏替换

这是直接做在 `_llm_node()` 的 chunk 发布阶段，不是最终一次性处理。

## 13.8 停止权限校验
停止请求不是只看 `task_id`，还要看：

+ `invoke_from`
+ `user_id`
+ Redis 记录的任务归属

防止误停和越权停止。

---

## 14. 这个项目里最值得讲的 8 个面试亮点
### 14.1 不是两张图，而是一张图两种驱动方式
这说明你不是简单做功能堆砌，而是在做平台抽象。

### 14.2 ReACT 的核心不是 prompt，而是“文本工具意图 -> 标准 tool_calls”的归一化
这是整个双模式统一的关键设计。

### 14.3 `MessagesState` 真正承接了工具循环中的消息归并
不是自己手工维护 message list。

### 14.4 `RemoveMessage` 被拿来做系统提示和记忆注入
这说明你会用 LangGraph 的状态操作能力，而不是把它当成普通函数编排器。

### 14.5 统一事件协议屏蔽了模式差异
前端、SSE、落库全都围绕 `QueueEvent + AgentThought`。

### 14.6 推理过程既能实时显示，也能事后回放
因为事件协议和存储模型是统一的。

### 14.7 停止控制带有任务归属校验
不是随便一个 `task_id` 就能停。

### 14.8 停止是协作式中断，不是强杀线程
这是理解深度的体现。

---

## 15. 面试时可以直接这么回答
### 15.1 你们的双模式 Agent 是怎么实现的
可以直接回答：

> 我们不是为 FunctionCall 和 ReACT 各写一套完全独立的执行框架，而是统一用 LangGraph 的 `StateGraph` 搭了一张四节点图：`preset_operation -> long_term_memory_recall -> llm -> tools`。  
服务层先根据 `llm.features` 判断模型是否支持 `TOOL_CALL`，支持就实例化 `FunctionCallAgent`，不支持就实例化 `ReACTAgent`。  
`ReACTAgent` 只重写 prompt 构建和 llm 节点，把模型生成的 fenced JSON 工具计划重新转成标准 `AIMessage.tool_calls`，这样后面的 `tools` 节点和条件边还能复用。  
所以双模式的关键不是两套图，而是统一状态机上的两种工具意图生成方式。
>

### 15.2 为什么 ReACTAgent 要继承 FunctionCallAgent
> 因为图骨架、工具执行节点、条件边、事件协议都一样，真正不同的是 llm 节点怎么产出工具调用意图。继承以后只需要改最小差异面，不需要维护两份几乎一样的编排逻辑。
>

### 15.3 统一事件流是怎么做的
> 每个节点不直接把数据返回给前端，而是统一通过 `AgentQueueManager.publish()` 发布 `AgentThought` 事件，事件类型包括 `agent_thought`、`agent_action`、`dataset_retrieval`、`agent_message` 等。  
`BaseAgent.stream()` 在后台线程跑 LangGraph 图，主线程只监听队列并把事件转成 SSE。  
所以前端永远看到统一事件协议，不关心底层到底是原生 function call 还是 ReACT JSON 解析。
>

### 15.4 推理过程可视化是怎么落地的
> 实时阶段，前端按 SSE 事件增量更新 `agent_thoughts`；`agent_message` 同 id 叠加，其他事件直接新增。  
持久化阶段，后端把这些步骤落到 `message_agent_thought` 表，历史查询时再通过 `agent_thoughts` 字段回放。  
所以我们既支持运行时展示，也支持事后追踪。
>

### 15.5 会话级停止怎么做
> 前端拿到当前任务的 `task_id` 后调用 stop 接口；服务层只负责调用 `AgentQueueManager.set_stop_flag(task_id, invoke_from, user_id)`。  
队列管理器先校验任务归属，再在 Redis 里写停止标记。  
`listen()` 循环每秒检查 stop flag，一旦发现就发 `STOP` 事件并停止监听。  
它本质上是协作式中断，能快速停掉响应流，但不是强杀后台线程。
>

---

## 16. 项目里当前能看出的几个实现细节与注意点
### 16.1 双模式自动切换主要体现在通用 App 执行链
自动切换明确出现在：

+ `app_service`
+ `web_app_service`
+ `openapi_service`
+ `wechat_service`

辅助 Agent 当前仍然固定走 FunctionCall。

### 16.2 `TOOL_CALL` 和 `AGENT_THOUGHT` 是两种不同能力
很多人会混在一起说，其实不一样：

+ `TOOL_CALL` 是模型能否原生输出工具调用结构
+ `AGENT_THOUGHT` 是模型是否适合显式推理/规划

所以：

+ 模型可能支持 `AGENT_THOUGHT` 但不支持 `TOOL_CALL`
+ 这时就应该走 ReACT 模式

### 16.3 当前仓库里能看到一处状态迁移痕迹
`AgentState` 仍然定义了 `history` 字段，`FunctionCallAgent` / `ReACTAgent` 的 `long_term_memory_recall` 节点也直接读取 `state["history"]`。  
但 `web_app_service`、`openapi_service`、`wechat_service` 里有注释写着“AgentState 已移除 history 字段”，并把历史直接合并进了 `messages`。

这说明当前仓库里能看到一处尚未完全收口的迁移痕迹。

面试时如果被追问，可以这样说：

> 我们的核心思路是短期记忆要么通过独立 `history` 字段注入，要么直接合并进 `messages`，仓库里当前能看到从前者往后者收敛的过程。真正关键点不是字段名，而是最终进入 `llm` 节点前，系统消息、历史消息、当前问题要被组织成一条稳定的消息栈。
>

这种回答既指出了代码现状，也不失真。

### 16.4 ReACT 模式的脆弱点在于 JSON 输出规范
当前 ReACT 依赖模型严格输出 fenced JSON。

好处是：

+ 不依赖模型原生 tool calling

代价是：

+ prompt 约束不稳时，容易退化成普通回答

所以代码里专门做了“解析失败降级”。

---

## 17. 最后一段总结，面试时拿来收尾
这个项目里的“智能体双模式执行”不是简单地把 LangChain 的 Agent 名字换了一下，而是基于 LangGraph 做了一层真正的执行平台：

1. 服务层按模型能力自动切换 `FunctionCallAgent` 和 `ReACTAgent`。
2. 两种模式共享同一张四节点 `StateGraph`，只在 `prompt + llm 输出解析` 处做差异化。
3. ReACT 模式把文本化工具计划重新归一化成 `AIMessage.tool_calls`，从而复用同一个 `tools` 节点。
4. 所有节点统一输出 `QueueEvent + AgentThought`，实现流式推理可视化、历史回放和多入口复用。
5. 停止控制基于 `task_id + Redis + 归属校验 + 队列监听器`，实现了会话轮次级协作式中断。

如果要把这条能力讲成一句最有分量的话，就是：

> 我们不是分别实现了 Function Calling Agent 和 ReACT Agent，而是用 LangGraph 搭了一套统一状态机，让不同模型都能在同一执行框架里跑起来，并且对前端暴露一致的推理事件流和中断控制语义。
>

