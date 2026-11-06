---
sidebar_position: 3
sidebar_label: 03：工作流引擎
description: 工作流引擎模块纵线：原型里 Workflow 即 BaseTool 的 DSL 到 StateGraph 编译，重建阶段的校验、调试、发布与代码节点隔离，以及现状的条件分支、Agent 节点子图嵌入、延迟编译与流式调试发布门。
---
# 工作流引擎：从画布 DSL 到 StateGraph 编译

工作流编排对应总览「共同的功能模块」矩阵里的工作流一行。Dify、LLMOps 系和本平台共有这块，Octop 没有把它做成一等公民。本平台在这条线上的迭代有一个不变量和一个反转：不变量是「前端画布 DSL 经服务端校验后编译成 LangGraph 图执行」这条链路始终自持；反转是工作流与 Agent 的组合方向——原型里工作流是 Agent 的工具，现状里已发布的 Agent 也能作为工作流节点嵌入。

> **本篇弧线**
>
> - **初识**：`Workflow` 继承 BaseTool，八类节点的 DSL 到 StateGraph 编译，并行汇聚边
> - **重建**：校验、调试、发布的外壳补齐，代码节点外移云函数
> - **现状**：条件路由与汇聚语义分家，Agent 节点子图嵌入与延迟编译，流式调试与发布门

## 一、核心工程问题：确定性流程怎么与自主循环组合

工作流这条线要回答的工程问题：怎么把自由编辑的画布配置变成可信执行的图，并让这张图与 Agent 的自主循环安全地互相组合。三个子问题贯穿全文：

- **画布到图的可信编译**。前端 DSL 是自由配置，执行是严格调度——服务端结构校验、条件路由、条件汇聚与并行汇聚的语义分家，保证「画的就是执行的」（第四节）。
- **执行位置的隔离**。代码节点跑的是用户提交的代码，「使用 StateGraph」推导不出沙箱，隔离来自执行后端的选择（第三节，展开见第九篇）。
- **组合不失控**。工作流作为工具进 Agent、Agent 作为节点进工作流，双向组合靠调用上限、协作式超时与定义指纹约束在笼子里（第四节）。

暗线是自由度与约束的交替：原型只有并行汇聚、画不了路由；现状补上条件边与 Agent 节点，每一步自由度的扩张都跟着一道新约束——汇聚语义分家、预算上限、指纹重校验。读的时候留意：每一次「能画更多的图」，背后都多了一条新的「不许」。

## 二、初识：工作流即工具

### 1、Workflow 继承 BaseTool

原型的工作流类直接继承 LangChain 的 `BaseTool`（`api/internal/core/workflow/workflow.py`，langgraph 0.2.67）：构造时从配置里的开始节点提取输入参数，用 `create_model` 动态生成 pydantic 入参 schema，再把整张图画编译出来挂在实例上。「工作流工具化」不是后来的增强，而是第一天的设计——发布后的工作流对 Agent 来说就是一个可调用的工具。

### 2、DSL 到 StateGraph 的编译

节点类型共八种：start、end、llm、template_transform、dataset_retrieval、code、tool、http_request，由 `NodeClasses` 映射表分派到对应节点类。边编译时做了一个关键处理——把指向同一终点的多条边合并成并行汇聚边（节选）：

```python
for edge in edges:
    # 5.计算并获取并行边
    source_node = f"{edge.source_type.value}_{edge.source}"
    target_node = f"{edge.target_type.value}_{edge.target}"
    if target_node not in parallel_edges:
        parallel_edges[target_node] = [source_node]
    else:
        parallel_edges[target_node].append(source_node)

# 8.循环遍历合并边
for target_node, source_nodes in parallel_edges.items():
    graph.add_edge(source_nodes, target_node)
```

`add_edge` 接收起点列表就是 LangGraph 的 fan-in 语义：汇聚节点会等所有上游分支完成。原型的边模型没有条件分支——所有分叉都是并行，所有汇聚都等全量，这够画「检索后并行调两个工具再汇总」这类图，但画不了路由。

### 3、节点即函数

每个节点类持有自己的 entity 与执行逻辑，例如 LLM 节点管理模型配置与提示词模板，dataset_retrieval 节点在构造时注入 Flask 应用上下文与账号 ID 以便访问知识库。节点执行结果写回 `WorkflowState`，整条链的结果从 end 节点的 outputs 取出。

### 4、变量系统：引用、字面量与生成

原型的变量模型（`api/internal/core/workflow/entities/variable_entity.py`）给整条链定了型。类型四种——string、int、float、boolean，配一张类型到 Python 类型的映射表和一张默认值表；变量名必须匹配标识符正则，描述截断到 1024 字符。取值三种：

- **LITERAL**（字面量）：直接输入；
- **REF**（引用）：记录引用节点 ID 加变量名；
- **GENERATED**（生成值）：用在开始节点与输出。

节点执行时按声明从 `WorkflowState` 提取输入值，代码节点的输出同样按声明取值、缺失时回退到类型默认值——AST 校验里 `main(params)` 收到的参数就是这份提取结果。

## 三、重建：校验、发布与代码节点隔离

重建阶段工作流按原型骨架重写，补齐的是平台化外壳：前端 DSL 到 `WorkflowConfig` 的结构校验（节点类型、连线完整性、模型配置、引用资源归属）、调试通过后才允许发布、发布入口再次校验、内置模板创建——这套调试与发布状态门的完整机制见第四节。发布后的工作流注册为应用可绑定的工具，复用第五篇工具体系的统一适配。

代码节点是这一阶段风险最高的点：执行用户提交的代码等于在平台进程里跑任意程序。平台的处理是 AST 校验（静态检查代码结构）加执行外移——代码节点交给云函数执行，与平台服务进程隔离，平台只收回执。

> 「使用 StateGraph」本身推导不出沙箱，隔离来自执行后端的选择——这一点在现状一节同样成立。

## 四、现状：条件分支与 Agent 节点

### 1、编译层的扩展

现状的 `Workflow`（`internal/core/workflow/workflow.py`）仍是 BaseTool，编译入口仍是 `_build_workflow`，但节点表多了两类：intent_classifier（意图分类）与 agent。边模型升级出条件边——条件函数按 `intent_condition` 状态返回分支标识，`add_conditional_edges` 携带条件映射完成路由。条件边的出现带出一个必须区分的语义：

| 汇聚场景         | 语义               | 边形态    |
| ---------------- | ------------------ | --------- |
| 条件分支后的汇聚 | 任一分支完成即触发 | 独立边    |
| 真正的并行汇聚   | 等所有分支完成     | fan-in 边 |

这张表不是靠画布上人工标注，编译器自己判定：带条件的边按起点归组、目标收进条件目标集合；其余普通边按终点归组——多来源的终点只要有一个来源落在条件目标集合里，就按独立边逐条连接（任一分支到达即触发），全部来源都是普通边才合并成 fan-in 列表。条件函数读状态里的 `intent_condition` 返回分支标识，没有匹配时回落到第一个分支作默认路由（没有分支则直通结束）——条件路由永远有路可走，不会悬空。

变量系统沿用到现状：类型四选一、字面量与上游引用二分、节点结果经 node_results 供下游按引用取用，这三条都来自原型；Agent 节点在此基础上引入 Jinja 任务模板（最多 20000 字符，模板变量在调试与发布时校验，无效变量与不存在的引用都会被拒绝），条件路由读取的 `intent_condition` 也走同一套变量状态。

### 2、Agent 节点：子图嵌入与延迟编译

Agent 节点让工作流可以调用同账号已发布的 Agent 应用。绑定运行资源的图不能再构造时一次编译完，于是有了延迟编译（节选）：

```python
# 带 Agent 的图绑定本轮资源，推迟到实际执行时编译。
self._workflow = None if self._has_agent_nodes() else self._build_workflow()
```

执行时由 `AgentNode.build_graph()` 构建子图注册进父图（节选）：

```python
if node.node_type == NodeType.AGENT:
    call_path = extend_call_path(run.path, f"agent:{node.agent_app_id}")
    prepared = factory.prepare_for_workflow(
        account_id=self._workflow_config.account_id, app_id=node.agent_app_id,
        node_id=node.id, execution_id=run.id,
        definition=definitions[node.agent_app_id],
        max_model_calls=node.max_model_calls, max_tool_calls=node.max_tool_calls,
        call_path=call_path,
    )
    run.resources.callback(prepared.runtime.close)
    agent_node = AgentNode(node_data=node, run=run, fingerprint=prepared.fingerprint)
    run.resources.callback(agent_node.close)
    run.agent_nodes[node_flag] = agent_node
    graph.add_node(node_flag, agent_node.build_graph(
        definition=prepared.definition, runtime=prepared.runtime,
    ))
```

子图内部是「prepare_input → agent → collect_output」三步，agent 步骤闭包引用 `build_deep_agent()` 编译出的模型-工具循环图，作为 LangGraph 子图接受父图的回调、命名空间与调度控制——没有为节点另起一套独立执行链路。

防失控的预算都在节点配置上：

- 模型调用上限：默认 10，范围 1 到 100；
- 工具调用上限：默认 20，范围 1 到 200；
- 协作式超时：默认 120 秒，范围 10 到 900，达到上限节点失败、不伪造成功回答；
- 引用路径超过 8 层或成环直接拒绝；发布时记录定义指纹，执行前指纹变化则要求重新调试发布。

### 3、一次事件流与资源生命周期

父工作流只在 `stream_with_events` 里消费一次 v3 事件流：根命名空间的 updates 事件逐节点产出过程记录（Agent 节点的记录附带事件投影器整理的正文与工具调用元数据），values 更新只用来收拢最终输出；按 namespace 区分主图与子图，`WorkflowAgentEvents` 把 Agent 过程投影为节点内容；`GraphDrained` 被翻译成 Agent 节点的超时失败而不是笼统的执行中断；图被中断（interrupt）直接报错——自动工作流不等待人工输入。

每次执行经 `_execution_graph` 上下文创建独占资源：嵌套工作流复用父图的调度控制（RunControl），但运行身份与临时沙箱始终独立；调试入口没有父图上下文，自建一份调度控制，作为工具调用时则继承父运行的停止信号；`ExitStack` 保证构图失败、异常、生成器关闭各路径都会释放计时器、临时目录与后端资源。

### 4、流式调试与发布门

调试跑的是草稿图，不是已发布快照。入口先过一遍与发布相同的校验链——结构校验、显式模型参数、Agent 节点校验（调试时顺带把各 Agent 节点的定义指纹钉在本次结果上）——然后按草稿图建工具、创建一条运行记录（图快照随记录落库），开始消费事件流：

- 每个节点完成即以 SSE 事件推给画布，节点结果同时累积进运行记录；
- 节点执行失败：先推失败节点的结果，再推一条 error 事件，记录收敛为失败；客户端断开（生成器被关闭）同样收敛为失败——调试没有「后台跑完」的形态；
- 流正常结束：记录更新为成功并写入耗时，工作流标记「调试通过」，最后才发完成事件。

调试通过不是永久的：拖动节点位置不算变化（对比时剔除位置与指纹字段），其余任何改动都要重新调试；Agent 节点钉住的指纹在调试成功后回写草稿，供发布时再核对。

发布是带门的快照：再走一遍完整校验链、要求调试通过、WorkflowConfig 二次校验（失败连调试标记一起作废），通过后把草稿图复制进发布字段、状态置为已发布，并消费掉调试标记——下一次改动后的发布必须重新调试。取消发布清空发布快照、回到草稿态。

工具化读的始终是发布快照：应用配置绑定工作流时，只有已发布的工作流会实例化成工具（工具名加 `wf_` 前缀，配置取自发布字段而非草稿），实例化失败的绑定被跳过。草稿上的继续编辑不影响已发布的工具，直到下一次调试加发布。

### 5、去留

编译层（DSL 校验、节点图、条件边、汇聚语义）与发布流程自持；执行底座与 LangGraph 共用，Agent 节点直接复用 DeepAgents 装配产物。工作流与 Agent 的组合从单向变成双向：工作流作为工具进 Agent（初识一节的不变量），Agent 作为节点进工作流（现状的反转）。

平台因此同时有「循环驱动的自主任务」和「图驱动的确定性流程」两种执行形态，两者的取舍标准是任务是否需要模型自己决定步骤。

模块纵线的上一篇是[Agent 运行时](./02-agent-runtime.md)，下一篇见[知识库与文件处理](./04-knowledge-and-files.md)，目录与状态见[专栏入口](./index.md)。
