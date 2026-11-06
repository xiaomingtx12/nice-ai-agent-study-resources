---
sidebar_position: 2
sidebar_label: 02：Agent 运行时
description: Agent 运行时模块纵线：原型里手写 StateGraph 与线程队列的函数调用循环，LangGraph 1.0 基线上的重建与自建多 Agent，以及 DeepAgents 时代的装配入口、执行生命周期与 V2 边界。
---
# 02：Agent 运行时：从手写 StateGraph 到 DeepAgents 装配

运行时对应总览「共同的功能模块」矩阵里的 Agent 运行时一行，也是各平台差异最大的一块：Dify 自研执行循环，LangChain 系平台借框架。本平台在这一行上走了三步——原型里手写图，重建后自建多 Agent 组织模式，最后把执行循环交给 DeepAgents、自己保留装配与恢复。总览里「执行可靠性」那组难题（幂等、恢复、迟到写入）在这条线上从头贯穿到尾。

> **本篇弧线**
>
> - **初识**：手写 StateGraph 函数调用循环，线程加进程内队列的流式，ReACT 降级
> - **重建**：LangGraph 1.0 基线重写，自建六种多 Agent 组织模式
> - **现状**：`create_deep_agent` 装配、执行生命周期、能力授权与调用限制、V2 边界

## 一、核心工程问题：把长执行做成可信的业务事实

运行时这条线要回答的工程问题只有一个：怎么把一次由模型驱动、流式输出、会中断、会恢复的长执行，做成可信的业务事实。它拆成三个子问题，贯穿全文：

- **一次提问只启动一次执行**。Agent 循环一跑几十秒到几分钟，重复点击、网络重试、前端重连都可能造成双跑——第四节的 `start_run` 用会话锁、`input_message_id` 去重与「事务提交后才派发后台执行」回答它。
- **中断之后还是同一次执行**。`ask_user` 中断等待补充输入，恢复时最容易犯的错是当成新一轮重跑——Execution 身份与 executor_id 执行资格分离、Submission 去重回答它（第四节）。
- **迟到的线程不能改写结局**。中断、恢复、取消并存时，旧执行片段可能在结算之后才返回——`_finalize_run` 的执行资格核对拒绝迟到写入（第四节）。

与它伴生的是耦合方式问题：审核、计费、事件、授权这些平台业务挂在执行循环的什么位置。原型把它们写进节点函数体内，业务状态与图状态搅在一起，三个子问题因此全部缺位；换轨后执行循环交给框架，可靠性只能做在边界上，落点变成 middleware 栈、权限清单与装配参数。带着这个问题读下文会有两条线：明线是三个子问题从原型缺位到现状补齐，暗线是平台业务的落点从节点函数内迁到边界参数。

## 二、初识：原型里的三层运行时

### 1、Runnable 基类与线程队列

原型把 Agent 做成 LangChain 的 Runnable。`BaseAgent` 继承 `Serializable` 与 `Runnable`，内部持有编译好的 `CompiledStateGraph` 和一个 `AgentQueueManager`；`stream()` 起线程跑图，自己从队列监听事件（`api/internal/core/agent/agents/base_agent.py`，langgraph 0.2.67，节选）：

```python
# 3.创建子线程并执行
thread = Thread(
    target=self._agent.invoke,
    args=(input,)
)
thread.start()

# 4.调用队列管理器监听数据并返回迭代器
yield from self._agent_queue_manager.listen(input["task_id"])
```

流式通道是进程内的 `queue.Queue`；Redis 只承担两件事——停止标志（`generate_task_stopped:{task_id}` 键）和任务归属校验（区分 account 与 end-user 前缀，防止别的用户停掉你的任务）。`listen()` 每 10 秒补一个 PING 心跳，600 秒超时。

这套机制意味着流式只能在单进程内消费，页面刷新后没有任何恢复手段——它是后来事件持久化与快照恢复要对照的起点。

### 2、手写的函数调用循环

`FunctionCallAgent` 用 StateGraph 显式建图，四节点一循环（`api/internal/core/agent/agents/function_call_agent.py`，节选）：

```python
# 1.创建图
graph = StateGraph(AgentState)

# 2.添加节点
graph.add_node("preset_operation", self._preset_operation_node)
graph.add_node("long_term_memory_recall", self._long_term_memory_recall_node)
graph.add_node("llm", self._llm_node)
graph.add_node("tools", self._tools_node)

# 3.添加边，并设置起点和终点
graph.set_entry_point("preset_operation")
graph.add_conditional_edges("preset_operation", self._preset_operation_condition)
graph.add_edge("long_term_memory_recall", "llm")
graph.add_conditional_edges("llm", self._tools_condition)
graph.add_edge("tools", "llm")

# 4.编译应用并返回
agent = graph.compile()
```

四个节点各管一段平台业务：

| 节点                        | 承担                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `preset_operation`        | 输入审核与敏感词预设响应                                        |
| `long_term_memory_recall` | 长期记忆拼进系统提示词                                          |
| `llm`                     | 手写流式收集、按特性位条件绑定 `bind_tools`、token 与费用计算 |
| `tools`                   | 手写工具循环，结果包成 `ToolMessage` 回填                     |

审核、计费、事件发布全部写在节点函数体内——平台业务与图执行深度耦合。

### 3、ReACTAgent：最早的模型兼容层

原型同时给了 `ReACTAgent`，继承 `FunctionCallAgent` 并重写提示词与 LLM 两个节点：当模型不支持 `tool_call` 特性位时，用 `render_text_description_and_args` 把工具描述渲染进系统提示词，再从流式输出里识别 `` ```json `` 代码块、用正则解析出工具调用。这是平台「多模型兼容」的最早形态——兼容逻辑长在 Agent 循环内部，按供应商能力分叉。

跑通之后的判断：功能面完整，但三件事钉死了天花板：

- 流式与进程绑定，页面刷新即丢失；
- 平台业务与图执行写死在同一个节点函数里；
- 每接入一个有新特性的模型都要改节点代码。

## 三、重建：LangGraph 1.0 基线上的重写与自建

重建阶段运行时按新栈重写。LangChain 与 LangGraph 1.0 把 Agent 构造统一到 `create_agent`（langchain 1.x 的标准构造入口，模型与工具循环的预装配方），横切能力改由 middleware 组织。平台第一批 Agent 代码直接钉在 1.0 一线（`langgraph==1.0.6`），函数调用 Agent 与队列管理按原型骨架重写。

之后进入自建阶段：基于图执行和 Checkpoint 完善状态管理、历史消息、流式输出与工作流恢复，并验证了一批多 Agent 组织模式：

- **AgentTool**：把子 Agent 包装成工具；
- **事件冒泡**：子 Agent 的事件沿调用链冒进父级流；
- **Supervisor**：主管调度；
- **Team**：按角色协作；
- **Plan/Execute/Replan**：规划-执行-重规划；
- **Pipeline**：固定次序流水线。

调试页、WebApp、开放 API 和内部任务入口也在这一阶段统一到同一套 Agent 服务。

自建阶段验证的是「多 Agent 怎么连成图」。读完 DeerFlow 之后问题被校准：平台缺的不是连法，而是规划清单、文件系统、子代理隔离这些支撑长任务的基础设施（总览第四节有这段参照）。这为换轨埋下了伏笔。

## 四、现状：DeepAgents 装配与执行生命周期

### 1、装配入口

换轨后唯一的图构造入口是 `build_deep_agent`（`internal/core/agent_v2/assembly/graph/deep_agent_factory.py`，deepagents 0.6.12）。平台资产以参数注入，`create_deep_agent` 只负责图本身；其中两处适配记录了框架与平台的边界拉扯（节选）：

```python
# 异步规格交给平台扩展中间件，避免 create_deep_agent 再注册一套同名工具。
async_specs = [cast(AsyncSubAgent, spec) for spec in subagent_specs if "graph_id" in spec]
sync_specs = [cast(SubAgent, spec) for spec in subagent_specs if "graph_id" not in spec]
async_task_instructions = ""
if async_specs:
    async_middleware = NamedAsyncSubAgentMiddleware(async_subagents=async_specs)
    # 原生说明只生成一次，提前纳入 system 供压缩计数；不再由包装器重复追加。
    async_task_instructions = async_middleware.system_prompt or ""
    async_middleware.system_prompt = None
    middleware.insert(0, async_middleware)

# 框架默认通用子 Agent 不继承主 Agent 中间件，却会继承父工具（含 execute）；
# 这里统一显式声明，按平台策略在执行入口关闭子 Agent 的共享 Shell。
if not any(spec["name"] == GENERAL_PURPOSE_SUBAGENT["name"] for spec in sync_specs):
    sync_specs.insert(0, {
        **GENERAL_PURPOSE_SUBAGENT,
        "skills": list(runtime.skill_projection.sources),
        "middleware": [ShellExecutionMiddleware(), ContextWindowMiddleware()],
    })
```

异步子 Agent 不能交给 `create_deep_agent` 注册（会与平台扩展重复注册同名工具），改走自研的 `NamedAsyncSubAgentMiddleware`；框架默认的通用子代理不继承主 Agent 中间件、却会继承父级工具，需要在装配入口显式声明执行策略。

### 2、同步与异步子 Agent：委派、派发与观察

同步与异步的差别不在「能不能并行」，在父 Agent 要不要等这次工具返回。同步子代理走框架原生的子任务工具：`subagent_type` 选执行者、`description` 是完整任务输入，子任务结果作为工具回执进入父图。异步子代理的链路长得多（装配在 `internal/service/agent/agent_factory.py` 的 `_prepare_async_subagent`，协议在 `internal/service/internal_agent_protocol/`）：

1. 应用配置解析为 `AsyncSubAgentDefinition`，带执行者名称、任务说明、目标 graph ID、URL 与 Header；
2. 指向本平台应用的引用由服务端生成目标 ID 和内部签名凭证，客户端不能指定任意账号或伪造 Token Header；
3. `NamedAsyncSubAgentMiddleware` 在原生启动工具上增加可选 title，省略时从 description 首句提取有限长度标题，不额外调用模型；
4. 内部协议校验凭证、应用状态、父子范围与会话归属，为目标应用创建新的会话与 Run，进入有界线程池；
5. 父图记录 async_tasks 后继续其他工作，后续用任务工具查询真实状态；async_tasks 按任务 ID 合并更新，并行刷新不会互相覆盖名称与初始说明。

四个概念不能互换：`subagent_type` 选执行者，`description` 是完整任务输入，`title` 便于用户辨认，`task_id` 用于精确查询。异步的边界同样要记牢：派发接受、首段输出、任务完成是三个阶段，「已启动」不是交付证明；父图不会被完成事件自动唤醒，要汇总仍需任务工具调用或后续对话；内部 Token 有有效期，长任务之后的查询还要先确认凭证没有过期。

### 3、执行生命周期

运行时之外，平台把「一次执行」拆成四个对象：

| 对象             | 承担                                                       |
| ---------------- | ---------------------------------------------------------- |
| Conversation     | 持续会话与访问归属                                         |
| ConversationTurn | 一轮问答与累计用量                                         |
| AgentExecution   | 这轮任务的启动、等待、恢复、取消、结算                     |
| executor_id      | 当前执行片段的写入资格——恢复可换片段，Execution 身份不变 |

`start_run` 在授权范围内锁定会话，用 `input_message_id` 做业务去重（同 ID 同输入返回已有运行，同 ID 不同输入拒绝），事务提交后才派发后台执行，避免后台线程先跑起来而建记录的事务随后失败。

模型调用 `ask_user` 工具后框架产生中断，执行进入 `waiting_input`；`submit_answers` 校验批次、身份与定义指纹后保存 Submission 并恢复同一执行，重复提交相同已接受答案返回原回执。结算时 `_finalize_run` 核对 executor_id 与活动状态，迟到线程不能覆盖较新的结果。这套机制的入口在 `internal/service/agent/agent_execution_service.py`。

### 4、V2 边界

运行时代码拆出明确边界：

- **配置解析**：AgentFactory 与 AgentConfig；
- **资源装配**：AgentRuntimeAssembler，管理工作副本、只读 Skill、执行后端与持久化；
- **执行器**：AgentExecutor；
- **事件规范化、状态投影、持久化**：各自独立成层。

装配阶段分开计时（config、model、tools、subagents、skills、total），连接查询在请求内按「账号 + 供应商 + 连接标识」缓存复用，但不跨请求共享有状态的图——共享图会连带共享回调与中间件状态，是两种不同性质的缓存。

### 5、能力授权与调用限制

授权在装配阶段一次收口：应用配置服务校验资源归属与可用性，`AgentRuntimeResources` 汇集本轮的授权产物——工具清单、只读的 Skill 投影、文件系统权限列表；Agent Core 只接收已经授权和解析好的定义，不直接决定平台权限。第一篇出现过的 `permissions=` 参数在这里有了着落，它是 `build_filesystem_permissions`（`internal/core/agent_v2/assembly/context/sandbox_context.py`）按挂载点生成的 FilesystemPermission 列表（节选）：

```python
FilesystemPermission(operations=["write"],
    paths=["/conversation_history", "/conversation_history/**",
           "/large_tool_results", "/large_tool_results/**"], mode="deny"),
FilesystemPermission(operations=["read"],
    paths=["/conversation_history", "/conversation_history/**",
           "/large_tool_results", "/large_tool_results/**"], mode="allow"),
...
FilesystemPermission(
    operations=["read", "write"],
    paths=["/memories", "/memories/**"],
    mode="allow" if memory_enabled else "deny",
)
permissions.append(
    FilesystemPermission(
        operations=["read", "write"],
        paths=["/**"],
        mode="deny",
    )
)
```

规则逐条对应后续各篇的挂载设计：

| 挂载                                               | 规则                     |
| -------------------------------------------------- | ------------------------ |
| `/conversation_history`、`/large_tool_results` | 只读（可回看、不可篡改） |
| `/skills`、`/subagent_skills`                  | 禁写                     |
| `/workspace`                                     | 可读写                   |
| `/memories`                                      | 按记忆开关放行           |
| 其余路径                                           | 默认拒绝（兜底）         |

子代理的权限清单在规格适配层按同一原则另行生成。

调用限制与重试集中在平台 middleware 栈（`internal/core/agent_v2/assembly/graph/platform_middleware.py`），顺序固定（节选）：

```python
_RETRYABLE_READ_ONLY_TOOLS = ("ls", "read_file", "glob", "grep")
_MODEL_CALL_LIMIT = 50
_TOOL_CALL_LIMIT = 200

ModelCallLimitMiddleware(
    run_limit=runtime.runtime_context.max_model_calls or _MODEL_CALL_LIMIT,
    exit_behavior="error" if runtime.runtime_context.max_model_calls else "end",
),
ToolCallLimitMiddleware(
    run_limit=runtime.runtime_context.max_tool_calls or _TOOL_CALL_LIMIT,
    exit_behavior="error" if runtime.runtime_context.max_tool_calls else "continue",
),
```

语义分两档：

| 档位                                | 行为                                         |
| ----------------------------------- | -------------------------------------------- |
| 应用显式配置上限                    | 达到即按错误结束——宁可失败也不伪造完整回答 |
| 平台缺省（模型 50 次、工具 200 次） | 温和收尾                                     |

重试同样收敛：模型重试只认瞬时故障（超时、连接错误、408/409/429 与 5xx，最多两次）；工具自动重试只覆盖四个无副作用的内置读取工具——写入类与未知业务工具无法凭一次异常确认前一次调用是否已经生效，这是第五篇重试边界的实现落点。

同一个栈里还有 Skill 授权刷新、工具参数校验、记忆与用户输入中间件，启用条件都挂在运行上下文上。

### 6、去留

执行循环、规划清单、文件工具、子代理机制交给 DeepAgents；装配、授权、幂等、恢复、事件投影全部自持。原型时代写在节点里的审核、计费、事件，现在分别落在 middleware、结算层与投影层——业务与图的耦合方式从「写在节点函数里」变成「参数与边界」。同步与异步子 Agent 的派发、观察与汇总机制，以及工作流与 Agent 的组合关系，分别见后续篇目。

模块纵线的上一篇是[迭代总览](./01-iteration-overview.md)，下一篇见[工作流引擎](./03-workflow-engine.md)，目录与状态见[专栏入口](./index.md)。
