---
slug: /application-notes/engineering/octop/agent-turn-execution
sidebar_position: 3
title: 02：一轮任务如何执行：请求、模型、工具与状态流转
sidebar_label: 02：单轮任务执行
description: 沿 Octop 平台请求进入 harness 的路径，串起线程状态、上下文准备、模型与工具循环、流式输出、取消和收尾，并区分主仓实装与独立组件快照。
---

Octop 是供用户配置和使用多个 Agent 的自托管助手平台。[01：Agent 生命周期](./01-agent-lifecycle-and-providers.md) 已说明配置怎样装成运行实例。本篇从实例已经可调用的位置继续：用户发送一条消息后，谁准备请求，谁恢复状态，模型怎样使用工具，结果又怎样回到界面。

这里把一次普通请求触发的 harness 调用称为“一轮”。它可能包含多次模型调用，也可能暂停等待人工审批。平台的逻辑轮次还可能接纳追加指令，跨越多个 harness 调用；不能把一次 WebSocket 连接、一个线程和一次模型调用都算作同一个“一轮”。

本篇只画运行地图。实例装配不再展开，权限、记忆检索、历史版本和消息渲染也只讲它们在主线上的位置。读完应能从一个异常现象找到应检查的层，而不必先读完框架全部实现。

## 一、先认清版本和运行中的对象

### 1、本篇用到三类本地证据

| 证据范围 | 已核验版本 | 本篇用途 |
| --- | --- | --- |
| Octop 主仓 | `v1.0.2`，HEAD `dd9dce470844c25d59effb50615bb3c667ea25cd` | 请求入口、线程串行化、历史记录和平台输出 |
| octop-harness 独立仓 | `v1.0.5`，HEAD `76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac` | 请求规范化、执行协议、取消和实例调用计数 |
| harness 独立仓的本地依赖 | Deep Agents `0.7.21`、LangChain `1.4.3`、LangGraph `1.2.11` | 补证建图、模型与工具之间的路由、checkpoint 读取 |

**独立仓 `v1.0.5` 不等于主仓实装版本。** Octop 的 [uv.lock:2722–2723](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/uv.lock#L2722-L2723) 锁定 `octop-harness 1.0.4`，主仓本地安装包的元数据也为 `1.0.4`。下文平台行为按主仓说明，组件内部按独立仓 `v1.0.5` 说明；审批恢复处另列已实读的实装差异。

本地依赖版本来自各包的 `METADATA:1–3`，不由 harness 的 tag 推断。为便于复查，依赖源码的路径基准如下；这些路径是分析环境，不是平台目录设计。

```text
主仓实装基准：D:/open_code/Octop/.venv/Lib/site-packages/
  octop_harness-1.0.4.dist-info/METADATA
  octop_harness/agent.py
独立仓依赖基准：D:/open_code/octop-harness/.venv/Lib/site-packages/
  deepagents-0.7.21.dist-info/METADATA
  langchain-1.4.3.dist-info/METADATA
  langgraph-1.2.11.dist-info/METADATA
  deepagents/graph.py
  langchain/agents/factory.py
  langgraph/pregel/_loop.py
```

### 2、同一条消息会经过哪些对象

| 对象或标识 | 它解决的问题 | 本轮中的位置 |
| --- | --- | --- |
| `agent_id` | 选择已装配的 Agent 实例 | 管理器查注册表、平台检查访问范围 |
| `thread_id` | 标识会话线程，关联图状态和历史 | 请求、执行配置、输出路由共同携带 |
| `GlobalProcessor` | 把平台消息变成执行请求，并记录输出 | Dashboard、CLI 等入口与管理器之间 |
| `AgentManager` | 平台侧管理入口，协调线程执行与运行配置 | 调用 harness 前后 |
| `HarnessAgentManager` | harness 的实例注册表与请求入口 | 按 `agent_id` 取得 `HarnessAgent` |
| `ChatRequest` | 一次调用的规范参数对象 | 分离新消息与运行配置 |
| `LangGraphProtocol` | 图执行与对外事件之间的适配器 | 启动图并把原始流转换成 chunk |

chunk 是一小段结构化输出，可以是文本、工具结果或状态更新，不一定是一个 token。checkpoint 是图执行状态快照；历史记录则服务于查看、审计和回放展示，两者不要混为一份消息列表。

## 二、平台把消息变成一次可执行请求

### 1、以 Dashboard 普通消息为入口

主仓 WebSocket 通道的 [ws_channel.py:159–184](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/ws/ws_channel.py#L159-L184) 建立逻辑轮次、标记线程活跃，并调用 `processor.iter_turn_chunks(current)`。后者是 `GlobalProcessor` 提供的轮次事件迭代入口。

普通对话在进入模型前还会经过平台分流。斜杠命令可能直接处理并返回；待回答的人工提问可能走审批恢复。下面只追踪这些分支均未接管的普通消息，分支细节见 [13：会话控制](./13-session-control-slash-hitl-steer.md)。

[processor.py:1131–1152](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/process/processor.py#L1131-L1152) 取得或创建 `thread_id`，再调用 `_build_dashboard_request`。这个方法把文本和媒体整理为消息内容，解析本轮模型、推理参数、MCP 工具选择、技能及知识库设置。

真正交给组件的字典由 [build_harness_request:293–365](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/process/harness_request.py#L293-L365) 构造。普通文本通常是本次新输入的用户消息，附带 `thread_id`、`user`、`source`；模型引用与额外运行参数另放，不会在这里重新拼接全部聊天历史。

### 2、进入 harness 前有一层平台协调

`AgentManager.stream` 使用 `(agent_id, thread_id)` 对应的执行锁，避免同一实例的同一线程并发推进。它还登记活跃调用；历史回填或资源回收持有保留标记时，新调用会等待。这个约束来自 [manager.py:1804–1872](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/manager.py#L1804-L1872)，不能推广成所有 Agent、所有线程共用一个全局锁。

`_prepare_stream_request` 复制请求、补齐 `agent_id`，注入插件工具配置并应用运行设置。随后进入人工审批线程作用域和模型标记作用域，向 harness 逐个转发 chunk。

以下截自主仓 [manager.py:1865–1871](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/manager.py#L1865-L1871)，省略外层执行锁和前后图刷新调用：

```python
# 补齐平台运行配置，保留本轮线程、身份和工具选择。
req = self._prepare_stream_request(agent_id, request)
with (
    hitl_thread_scope(thread_id_from_request(req)),
    turn_model_scope(self._stream_model_label(agent_id, req, thread_id)),
):
    async for chunk in self._harness_manager.stream(agent_id, cast(Any, req)):
        yield chunk  # 转发结构化事件，由外层记录和呈现。
```

这里输出的是组件事件，不是最终回答字符串。平台外围仍要消费它们，写历史、累计用量和补充界面所需信息。

组件 `v1.0.5` 的 [HarnessAgentManager.stream:388–398](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/manager.py#L388-L398) 按 `agent_id` 查注册表，规范化请求，再调用实例的 `stream`。它不在此处为每轮重新创建 Agent。

## 三、新输入怎样与已有状态接上

### 1、消息和执行配置分开传入

`HarnessAgent.stream` 先用 `ChatRequest.coerce` 接受字符串、字典或已有请求对象，再经过运行时斜杠处理。普通请求进入 `_prepare_call`，得到三项结果：标准消息列表、运行配置、协议对象。组件依据是 [stream:482–543](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L482-L543) 与 [_prepare_call:1948–1967](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L1948-L1967)。

[ChatRequest.to_runnable_config:110–147](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/request.py#L110-L147) 把 `thread_id`、用户、来源、模型和工具选择放入 `configurable`。这个字段承载执行参数，不是要逐字发送给模型的提示词。`normalize_messages` 则将角色字典转换成框架消息对象，例如用户消息成为 `HumanMessage`。

模型最终看到的上下文还要经过建图时装入的中间件。请求字典中的字段存在，不代表它已经变成模型输入。

### 2、恢复的是图状态，不是旧协程

harness 在建图时选择 checkpointer，即图状态的保存与读取组件。[agent.py:1867–1921](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L1867-L1921) 的实现依次处理显式关闭、外部实例、记忆运行时提供的实例，以及本地 SQLite 后备。因而恢复能力也受配置和存储可用性约束。

当 `LangGraphProtocol.stream` 把新消息与包含 `thread_id` 的配置交给图，状态恢复发生在 LangGraph 内部。独立仓本地 LangGraph `1.2.11` 的异步循环入口可直接核对：

```text
langgraph/pregel/_loop.py:1887–1968
  __aenter__ → checkpointer.aget_tuple(checkpoint_config)
             → 载入 checkpoint 与 pending_writes
             → achannels_from_checkpoint → _first
```

上面的文字是调用索引，不是可执行伪代码。普通分支读取当前图/线程的最近 checkpoint；指定 `checkpoint_id` 时另有读取指定快照的分支。没有快照则建立空状态，再处理本次输入。

这里恢复的是消息、状态通道和已保存的执行信息。它不会把崩溃前的 Python 协程、正在等待的网络请求或外部进程重新变成原来的运行对象。重新提交输入、从图中断点继续、前端恢复历史显示，是三种不同操作。

### 3、显示历史与模型上下文各走自己的路径

平台 `_begin_history` 会为当前轮建立记录器。旧线程没有可用投影时，它可能读取图状态以固定旧历史边界，但源码明确不在此处重写旧消息正文。依据见主仓 [processor.py:198–242](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/process/processor.py#L198-L242)。

另一方面，harness 的 `MemoryMiddleware` 是把记忆接入模型调用的中间件。`v1.0.5` 的 [memory.py:303–316](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/middleware/memory.py#L303-L316) 在 API 消息副本上重放已保存的召回内容，调用 `request.override(messages=...)` 后才把请求交给内层。

因此，“历史页面能显示旧消息”不能单独证明模型拿到了同样的上下文；“图恢复了 checkpoint”也不表示所有历史正文都会原样送入模型。压缩、记忆召回和消息修补仍可能影响实际输入，分别见 [07：中间件与上下文](./07-middleware-and-context-engineering.md)、[08：版本化历史](./08-versioned-history-and-trajectory.md)、[09：记忆系统](./09-memory-system.md)。

## 四、模型与工具为什么会反复交替

### 1、harness 把循环交给已编译的图

`HarnessAgent._build_graph` 将模型、工具、中间件、工作区后端和 checkpointer 传给 `deepagents.create_deep_agent`。这个函数是 Deep Agents 的建图入口，并不等于立即请求模型。组件调用位置见 [agent.py:1732–1846](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L1732-L1846)。

向下实读独立仓本地依赖，Deep Agents 的工厂最终调用 LangChain `create_agent`，后者构建带模型节点、工具节点和中间件节点的执行图。这里只需要认清以下几个位置：

```text
Deep Agents 0.7.21：deepagents/graph.py:961–983
  create_agent(...).with_config(...)
LangChain 1.4.3：langchain/agents/factory.py:1551–1615
  _execute_model_async、amodel_node，以及 model/tools 节点注册
LangChain 1.4.3：langchain/agents/factory.py:1991–2109
  _make_model_to_tools_edge、_make_tools_to_model_edge
```

`amodel_node` 从当前状态构造 `ModelRequest`，即这一次模型调用的输入对象。harness 的 `ModelRouterMiddleware` 会在每次调用包装层中选择实际模型并替换 `request.model`；这与实例建图时选用的初始模型分属两个阶段，见 [model_router.py:59–92](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/middleware/model_router.py#L59-L92)。

### 2、一次工具结果通常还要再交给模型

| 当前进展 | 接下来发生什么 | 阅读时要区分的对象 |
| --- | --- | --- |
| 模型收到上下文 | 包装层可调整模型、消息与可用工具，内层请求模型 | 本轮请求与本次 `ModelRequest` |
| 模型返回工具调用 | 路由找出尚无结果的调用，派往 `tools` 节点 | 调用名称、参数、调用 ID |
| 工具返回 | 工具结果进入图状态，再路由回模型 | `ToolMessage.tool_call_id` 与原调用 ID |
| 模型给出普通回答 | 常规路径下，无工具调用则走结束分支 | 模型节点结束与整轮流结束 |

下面只摘取 LangChain `1.4.3` 本地 `factory.py:2016–2019` 的连续代码，原英文注释翻译为中文；其他分支省略：

```python
# 3. 如果模型没有调用任何工具，就退出循环。
# 这是 agent 循环的常规退出条件。
if len(last_ai_message.tool_calls) == 0:
    return end_destination
```

这个判断的输入是最后一条模型消息，输出是后续路由目标。工具调用尚未完成时，不能只看到一段文本就认为任务已完成；模型可能一边解释，一边继续请求工具。

无工具调用也不是全部退出规则。该版本还处理中间件显式跳转、结构化输出和工具 `return_direct` 等路径。本篇不展开它们的框架实现，只保留主线：新状态进入模型，工具结果回到状态，图再决定下一步。

## 五、图内进展怎样变成用户看到的输出

### 1、协议层订阅四种图流

组件 `v1.0.5` 的 [LangGraphProtocol.stream:163–175](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/protocols/langgraph.py#L163-L175) 同时订阅状态值、节点更新、消息增量和自定义事件。以下保留核心连续片段，省略前面的文本拆分器初始化及后面的尾部缓冲排出：

```python
# 离开作用域时关闭图的异步迭代器。
async with aclosing(
    self._graph.astream(
        {"messages": messages},
        config=config,
        stream_mode=["values", "updates", "messages", "custom"],
        version="v2",
        **kwargs,
    )
) as graph_chunks:
    async for chunk in graph_chunks:
        for event in self._project_chunk(chunk, splitter):
            yield event  # 把图内事件转换为 harness 的对外 chunk。
```

`astream` 接收本次新消息与执行配置；`_project_chunk` 把图事件转成对外字典。因此流式输出不只来自模型的文字流，工具和状态节点也会产生可消费事件。

| 图内来源 | 对外 chunk | 平台可以做什么 |
| --- | --- | --- |
| `messages` | `token`、`reasoning`、`tool_call_chunk`、`usage` | 显示增量文本、组装调用信息、统计用量 |
| `updates` | `tool_result` 或 `state_update` | 收集工具结果、跟踪节点变化 |
| 中断更新 | `hitl_required` | 登记人工审批或提问 |
| `values` / `custom` | `state_snapshot` / `custom` | 消费状态快照或扩展事件 |

映射见组件 [langgraph.py:217–303](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/protocols/langgraph.py#L217-L303)。其中内部摘要模型流会被过滤，不能把图内所有模型 token 都当成面向用户的回答。

### 2、平台消费事件，同时记录这一轮

主仓 [processor.py:1187–1206](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/process/processor.py#L1187-L1206) 对每个 chunk 累计用量、更新历史记录器并刷新记录，再记录轨迹。随后按事件类型补充审批编号、工具附件等平台信息，才交给外层通道。

WebSocket 通道把这些结果推给线程订阅者。普通流结束后，处理器还有历史和用量收尾，最后生成平台 `done`。组件的事件枚举不包含这个平台完成帧；组件迭代结束与平台发送完成通知是两个位置。

不要把 `done` 单独当作成功判据。同一平台路径也可先发 `error`，再走到完成通知；人工审批暂停也不等于任务已经给出最终回答。渲染、去重和附件细节见 [12：流式投影与渲染](./12-stream-projection-and-rendering.md)。

## 六、异常、取消和收尾分别停在哪里

### 1、错误与取消沿不同路径退出

普通异常由主仓 [processor.py:1268–1297](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/process/processor.py#L1268-L1297) 记录并转为 `error` chunk，同时保存已获得的部分内容。`finally` 还会结束轨迹并处理未完成历史；不能只在模型正常返回时做收尾。

显式取消则沿 `AgentManager.cancel_stream` → `HarnessAgentManager.cancel` → `HarnessAgent.cancel` 传递，最终设置该线程的取消事件。组件 `v1.0.5` 的 [_iter_until_cancelled:403–457](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L403-L457) 同时等待下一段输出与取消事件；取消先到时，会取消阻塞中的 `__anext__` 等待并尝试关闭迭代器，不必等下一个 token 才检查标记。

这是取消当前异步执行的机制，不能据此承诺撤销已写文件、回滚外部 API 或终止所有远端副作用。具体工具能否停止，还取决于它怎样响应取消。

浏览器断线也不等于显式取消。主仓 [ws_channel.py:211–220](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/ws/ws_channel.py#L211-L220) 捕获推送失败，允许当前执行继续；进程重启后的恢复边界见 [16：断线、重连与恢复](./16-disconnect-reconnect-and-recovery.md)。

### 2、审批恢复存在实装版本差异

人工介入（HITL）让执行图暂停，协议层输出 `hitl_required`。恢复时，`LangGraphProtocol.resume_stream` 使用 `Command(resume={"decisions": decisions})` 向已有线程提交决定，不把批准文字当作一条新的普通用户问题，见组件 [langgraph.py:179–205](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/protocols/langgraph.py#L179-L205)。

| 核验对象 | 已实读行为 | 不应混写的结论 |
| --- | --- | --- |
| 主仓实装 harness `1.0.4`，本地 `agent.py:532–549` | `resume_hitl` 构造仅含 `thread_id` 的配置，再调用恢复流 | 不能套用新版保留完整请求作用域的说明 |
| 独立仓 harness `1.0.5`，[agent.py:501–574](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L501-L574) | 遇到暂停时保存该线程的请求配置；恢复时复制配置，结束后按是否再次暂停清理 | 这个缓存位于进程内，不能据此承诺重启后保留全部请求作用域 |

这里的差异会影响用户身份、模型或工具选择等请求配置的延续。它不改变一个基本边界：宿主仍须检查恢复者权限，组件能找到线程并不等于调用者有权批准。

### 3、退出当前调用后，实例通常仍然存在

组件 [agent.py:968–1004](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L968-L1004) 用 `_invocation` 增减运行中的调用数。只有实例已经收到待关闭请求，且最后一个调用退出，才触发延迟的 `aclose()`。正常一轮退出仅释放本轮作用域，不会自动关闭模型工厂、后端或整个 Agent。

平台历史也有自己的收尾状态。[RecordingTracker.finish:433–480](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/history/recorder.py#L433-L480) 根据写入失败、暂停、运行错误和完成标记选择状态；v2 记录还检查最终回答、工具调用结果配对等完整性，必要时降为 `partial`。因此“流迭代完了”“历史完整了”“任务业务目标达成了”是不同判断。

从运行地图看，排查应落到具体交接处：请求参数看平台处理器，续聊上下文看执行配置和 checkpoint，工具后卡住看图路由及调用结果，显示缺失看协议事件与平台投影，取消后仍有动作则检查工具自身的退出能力。

本篇依据静态源码阅读，未运行服务、模型、工具或端到端测试。平台与独立 harness 快照分别核验；不能据这条调用地图推断两个版本已经组合运行通过。

上一：[01：Agent 装配与生命周期](./01-agent-lifecycle-and-providers.md) · [系列导读](./index.md) · 下一：[03：工作区与后端](./03-workspace-and-backend-abstraction.md)
