---
sidebar_position: 24
sidebar_label: 22 动态子代理与代码工作流
description: 沿 QuickJS 的 eval、JavaScript task 桥接和子代理调用链，解析动态工作流的生成、并发调度、结构化返回与状态边界。
---

# Deep Agents 源码解析 22：动态子代理与 QuickJS 代码工作流

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12 源码快照；`langchain-quickjs` 0.3.3。版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 解释器工具与生命周期：`libs/partners/quickjs/langchain_quickjs/middleware.py` → `CodeInterpreterMiddleware`
> - 工作流提示词与示例：`libs/partners/quickjs/langchain_quickjs/_prompt.py` → `_SUBAGENT_SYSTEM_PROMPT_TEMPLATE`
> - 会话解释器与异步调度：`libs/partners/quickjs/langchain_quickjs/_repl.py` → `_ThreadREPL`、`_register_task_bridge()`
> - 子代理桥接与进度事件：`libs/partners/quickjs/langchain_quickjs/_subagent.py` → `call_subagent_task_tool()`
> - 返回值提取与格式化：`libs/partners/quickjs/langchain_quickjs/_format.py` → `coerce_tool_output_for_ptc()`、`format_outcome()`
> - 子代理选择与执行：`libs/deepagents/deepagents/middleware/subagents.py` → `_select_subagent()`、`_validate_and_prepare_state()`、`atask()`
> - 参数、动态 Schema 与并发测试：`libs/partners/quickjs/tests/unit_tests/test_repl_middleware.py`

以上路径均相对于 Deep Agents 仓库根目录。解释器位于 `libs/partners/quickjs/`，只查看 `libs/deepagents/` 会漏掉 JavaScript 编排层。

QuickJS 是嵌入式 JavaScript 引擎；REPL 指可重复执行代码并保留变量的交互式解释器。Python 通过 `quickjs-rs` 绑定调用引擎，也可以把 Python 函数注册成 JavaScript 可调用的宿主函数。本文涉及的 `task()` 就通过这条桥接路径执行。

解释器的工具装配、普通 PTC、原生值转换和增量快照在 [23：Interpreter 与 PTC 工具编排](23-interpreter-and-programmatic-tool-calling.md) 中展开。对这些机制还不熟悉时，可以先读第 23 篇，再回到本文的子代理调度。

## 二、动态工作流由谁生成、由谁执行

**主模型按当前任务生成 JavaScript，QuickJS 执行其中的循环、分支和并发，Python 桥接层再调用已经配置的子代理。** 一次 `eval` 可以组织多次子代理运行，主模型在代码返回后继续处理汇总结果。

例如，用户要求审查一批路由文件，并复核高风险发现。模型可以生成这样的执行过程：逐个分发审查任务，等待结果，按问题 ID 去重，再把筛选出的候选交给复核角色。哪些文件需要第二次调用，由第一次返回的内容和 JavaScript 条件共同决定。

这条机制包含三种不同的调用：

| 调用形式 | 谁发起 | 调用之后发生什么 |
| --- | --- | --- |
| 模型直接调用普通 `task` 工具 | 主模型的工具调用消息 | 工具节点运行子代理，再把结果交还父图 |
| `eval` 内的 JS `task({...})` | 正在执行的 JavaScript | Python 桥接层直接运行原有子代理工具，结果回到 JS |
| `eval` 内的 JS `tools.*` | 正在执行的 JavaScript | 调用显式开放给解释器的普通工具，例如文件检索工具 |

第三种能力称为 PTC（Programmatic Tool Calling，程序化工具调用）。它与 JS `task()` 共用解释器，但使用不同的注册与计数路径。第 [09 篇](09-subagent-sync.md) 解释普通委派，第 [12 篇](12-async-subagent.md) 解释远程任务的启动和查询；本文讨论的多个 `task()` 仍在本次 `eval` 中等待结果，没有因此获得跨请求查询远程任务的生命周期。

```text
主模型生成 JavaScript，并调用 eval(code)
  → CodeInterpreterMiddleware 取得当前会话的解释器
  → QuickJS 执行循环、分支和 Promise
    → JS task({ description, subagentType, responseSchema })
    → Python _bridge → call_subagent_task_tool
    → 原有 task 工具 → 子代理 ainvoke
    ← 子代理返回 → 提取内容 → 转成 JS 值
  → JS 使用结果，决定下一批调用或生成汇总
  ← eval 的结果被格式化成 ToolMessage
主模型读取结果，继续调用工具或回答用户
```

`Promise` 是 JavaScript 表示异步结果的对象；`await` 等待它完成，`Promise.all` 汇总一批异步结果。`ToolMessage` 是 LangChain 保存工具返回内容的消息，用调用 ID 与发起它的请求关联。工作流运行期间，子代理仍各自执行完整的模型与工具循环，减少的是主模型在编排步骤之间的往返。

## 三、模型为什么知道要写 JavaScript

### 1. 中间件提供工具，并在模型请求前补充说明

`CodeInterpreterMiddleware.__init__()` 把 `_build_tool()` 创建的 `eval` 放入 `self.tools`。LangChain 装配 Agent 时读取这些工具，模型因此获得一个接受 `code` 参数的执行入口。`wrap_model_call()` 则在请求发出前调用 `_prepare_for_call()`，生成解释器的使用说明。

`_prepare_for_call()` 的相关源码如下，省略后面的普通工具绑定部分：

```python
request_tools: list[BaseTool] = list(getattr(request, "tools", []) or [])

subagent_section = ""
if self._subagents and find_subagent_task_tool(request_tools) is not None:
    subagent_section = render_subagent_system_prompt(tool_name=self._tool_name)

if self._ptc is None:
    return self._base_prompt(ptc_attached=False) + subagent_section
```

`BaseTool` 是 LangChain 工具的基础接口，用来统一输入契约和执行方法。`find_subagent_task_tool()` 不只检查名字是 `task`，还要求输入字段包含 `description` 和 `subagent_type`，以识别 Deep Agents 的委派工具。

即使没有启用普通工具的 `ptc`，仍可加入子代理使用说明。前提是 `subagents=True`，且请求中确实存在对应的 `task` 工具。`ptc=["task"]` 不是启用动态子代理的方法；普通工具过滤器会拒绝这项配置，相关测试在 `test_ptc.py` 的 `test_filter_rejects_task_by_name()`。

### 2. workflow 是提示词约定，代码来自模型

`_prompt.py` 的 `_SUBAGENT_SYSTEM_PROMPT_TEMPLATE` 明确要求：用户提到 workflow 时，先探索输入，再写 JavaScript 把工作分发给子代理，并在代码中汇总。这个英文词影响模型选择，Python 没有据此自动生成固定业务流程。

提示词中还包含真实的多阶段示例。下面完整摘录其中的分类与深入审查片段；`files` 是前文已经取得的文件列表，`reviewer` 需要是已配置的角色名。这是框架发给模型的示例代码，不是 SDK 内部固定执行的工作流：

示例中的 `responseSchema` 使用 JSON Schema 描述返回对象的字段与类型，供后面的 JavaScript 读取和筛选。

```javascript
const tagged = await Promise.all(files.map((file) =>
  task({
    description: "Read " + file + " and classify it as handler, util, " +
      "test, or config.",
    subagentType: "reviewer",
    responseSchema: {
      type: "object",
      properties: { kind: { type: "string" }, risky: { type: "boolean" } },
      required: ["kind", "risky"],
    },
  }).then((tag) => ({ file, ...tag }))
));

const riskyHandlers = tagged.filter((it) => it.kind === "handler" && it.risky);
const deepReviews = await Promise.all(riskyHandlers.map((it) =>
  task({
    description: "Deep security review of " + it.file + ". Cite line numbers.",
    subagentType: "reviewer",
  }).then((review) => ({ ...it, review }))
));
```

第一阶段要求子代理返回 `kind` 和 `risky`。JavaScript 按这两个字段筛选，第二阶段只处理被判为高风险的请求处理文件。两次 `Promise.all` 之间的 `await` 建立阶段依赖；每个结果保留 `file`，便于第二次委派和最终回查。

这里没有保证分类结论正确。如果某个危险文件被分类为低风险，第二阶段就不会看到它。要求“每个文件都经过深入审查”时，不能照搬这个筛选条件。多阶段编排使规则可见，也把第一阶段判断错误的影响传播到了后续步骤。

### 3. 动态的是任务与控制流，角色仍需事先配置

每次 JS `task()` 的输入由 `_validate_task_payload()` 校验：

| 字段 | 契约 | 消费位置 |
| --- | --- | --- |
| `description` | 必填、非空字符串 | 成为这次子代理运行的初始用户消息 |
| `subagentType` | 必填、非空字符串 | 映射为 Python 的 `subagent_type`，选择已登记角色 |
| `responseSchema` | 可选、对象 | 为本次子代理构造结构化输出配置 |
| `label` | 可选、字符串 | 显示在进度事件中，不进入子代理任务描述 |

这份快照还支持 `label`，不能把接口概括为“只有三个字段”。模型可以为每个文件生成不同的描述，也可以根据分类结果选择角色；任意编一个未注册的角色名，不会自动创建新专家。

## 四、从 eval 进入 Python 子代理调用

### 1. eval 传递执行上下文

`middleware.py` 的 `_build_tool()` 同时提供同步和异步执行函数。以下是异步函数的执行主体，省略函数签名和工具包装：

```python
thread_id = _resolve_thread_id(fallback_id)
repl = middleware._repl_for_eval(thread_id)
try:
    outcome = await repl.eval_async(
        code,
        outer_runtime=runtime,
        outer_loop=asyncio.get_running_loop(),
    )
finally:
    if middleware._mode == "call":
        middleware._registry.reset_repl(thread_id)
return _make_tool_message(outcome, runtime.tool_call_id)
```

`ToolRuntime` 是当前工具执行的上下文对象，包含图状态、配置、工具列表和事件写入器等。传入的 `outer_runtime` 让解释器能找到父 Agent 的真实工具和状态；`outer_loop` 保存父调用所在的 Python 异步事件循环，后面用于安排子代理执行。

`_Registry` 是管理各会话解释器实例的内部注册表，以 `thread_id` 查找对应实例。`mode="call"` 会在本次执行结束时重置实例，所以这一模式下不能指望下一次 `eval` 读取本次声明的数组。异步应用可使用 `agent.ainvoke()` 传递当前事件循环；同步入口在本快照中也会转交 worker 的异步执行路径，不能照搬 README 中“同步调用不能使用异步桥接”的旧说明。调用路径与测试证据见 [第 23 篇](23-interpreter-and-programmatic-tool-calling.md)。

### 2. task 被注册成异步宿主函数

`_ThreadREPL._ainit()` 创建 JavaScript 上下文，并准备子代理并发信号量。信号量用于限制同时进入某段代码的调用数量：

```python
async def _ainit(self) -> None:
    self._ctx = self._runtime.new_context(timeout=self._per_call_timeout)
    if self._capture_console:
        self._install_console()
    if self._subagents_enabled:
        self._task_calls = asyncio.Semaphore(_MAX_TASK_CALLS_PER_THREAD)
        self._register_task_bridge()
```

本文件定义 `_MAX_TASK_CALLS_PER_THREAD = 32`。`_register_task_bridge()` 内部的 `_bridge` 在 `async with task_calls` 内调度子代理，调用结束后释放名额。它再通过下面这行把 Python 函数注册成 JS 全局函数：

```python
ctx.register(_TASK_FUNCTION_NAME, _bridge, is_async=True)
```

`_TASK_FUNCTION_NAME` 的值是 `task`。注册后还会冻结该函数、将全局属性设为不可写和不可重新配置，避免脚本覆盖这个调度入口。

**32 是单个解释器的同时运行上限。** 提交 64 个任务时，后面的调用等待名额；只要没有其他失败，它们仍可全部执行。`test_repl_middleware.py` 的 `test_async_task_global_limits_concurrency_per_repl()` 用 64 次调用检查返回数量为 64、峰值并发不超过 32 且大于 1。不同会话各有自己的限制，不能据此推导整个服务只有 32 路并发。

### 3. 子代理切回父调用的事件循环

QuickJS 使用自己的 worker 执行代码；子代理往往持有绑定在父事件循环上的异步客户端。`_ainvoke_task_on_outer_loop()` 因此会把实际调用安排回父循环。下面省略前面的参数校验和 `_call()` 定义：

```python
outer_loop = state.outer_loop
if outer_loop is None:
    return await _call()
current_loop = asyncio.get_running_loop()
if current_loop is outer_loop:
    return await _call()
future = asyncio.run_coroutine_threadsafe(_call(), outer_loop)
try:
    return await asyncio.wrap_future(future)
except asyncio.CancelledError:
    future.cancel()
    raise
```

`_call()` 从 `runtime.tools` 中查找委派工具，再进入 `call_subagent_task_tool()`。这样，JavaScript 引擎与子代理可以使用不同的 worker，但子代理的异步执行仍落回正确的 Python 循环。取消等待时，代码也尝试取消转交过去的任务。

`test_thread_affinity.py` 的 `test_quickjs_async_task_global_subagent_loop_affinity_e2e()` 专门记录子代理的事件循环 ID，断言与外层相同。这是资源使用位置的验证，不能据此推导外部请求一定能被取消或回滚。

### 4. 复用已有 task 工具，运行完整子代理

`call_subagent_task_tool()` 为每次调度分配独立的调用 ID，并复制本次使用的 runtime。核心执行片段如下，省略事件发送和异常分支：

```python
result = await task_tool.arun(
    {
        "description": description,
        "subagent_type": subagent_type,
        "runtime": runtime,
    },
    config=getattr(runtime, "config", None),
    tool_call_id=subagent_id,
)
```

`arun()` 是 LangChain 工具的异步执行接口。这一步进入 `subagents.py` 中原有的 `atask()`：校验角色名，选择可运行子代理，筛选输入状态，再 `await subagent.ainvoke(...)`。`ainvoke()` 表示运行该 Agent 或图直到本次调用返回。

子代理的初始消息被设为 `HumanMessage(content=description)`。`HumanMessage` 表示用户输入消息；这里把这次委派描述当作子代理的新任务。它不会自动继承主模型的完整对话，也没有通过 JS `task()` 返回一个可继续聊天的会话句柄。描述应包含目标、范围、约束和输出要求；文件内容较大时，传路径和符号名，由有相应权限的子代理读取。

## 五、responseSchema 怎样进入子代理构造

### 1. Schema 写入本次调用的配置

`responseSchema` 是 JSON Schema，即描述对象字段与类型的结构约束。`call_subagent_task_tool()` 会校验它的大小和复杂度，补充缺失的顶层 `title`，再调用 `_runtime_with_response_format()`。该函数的关键片段是：

```python
# 把本次输出格式放进配置，不修改共享的角色定义。
updated_config["configurable"] = {
    **configurable,
    SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY: AutoStrategy(response_schema),
}
return replace(runtime, config=updated_config)
```

`AutoStrategy` 是 LangChain 的结构化输出配置对象，让 Agent 按模型能力选择输出策略。`SUBAGENT_RESPONSE_FORMAT_CONFIG_KEY` 的值为 `__deepagents_subagent_response_format`，用于把这个要求传入委派工具。`replace()` 返回 runtime 的新副本；并发任务可以各带自己的 Schema，不需要修改共享角色配置。

这份实现对 Schema 设置了 4096 的序列化长度阈值、5 的递归深度阈值和 32 的累计属性数阈值。检查递归主要沿 `properties` 和 `items` 展开，不宜把它描述成完整的 JSON Schema 安全验证器。接收对象不代表任意 Schema 特性都已被验证。

### 2. 有动态 Schema 时重新构造声明式子代理

`subagents.py` 的 `_select_subagent()` 直接消费该配置，下面省略函数签名和文档字符串：

```python
response_format = _get_subagent_response_format(runtime)
if response_format is not None:
    # 带动态格式时，从原始角色配置重新构造可运行对象。
    new_spec = _compile_spec(
        subagents_by_name[subagent_type],
        response_format=response_format,
    )
    return new_spec["runnable"]

return subagent_graphs[subagent_type]
```

没有动态格式时，使用创建工具时准备好的子图；带格式时，取回原始角色配置，经 `_compile_spec()` 和 `create_sub_agent()` 构造带本次 `response_format` 的可运行对象。`create_sub_agent()` 是把声明式子代理配置交给 LangChain 创建 Agent 的函数。

因此，几十次携带相同 Schema 的调用，也会反复进入这个构造分支；这条路径没有按 Schema 缓存 runnable。这里增加的是 Agent 图与相关对象的构造工作，不能直接等同于多调用一次模型。若需要缓存，应同时考虑角色配置、Schema、模型和中间件是否可安全复用。

`CompiledSubAgent` 表示由调用方直接提供可运行对象的子代理。它已经构造完成，`_compile_spec()` 遇到动态格式会抛 `ValueError`，不会临时改写其输出接口。需要固定子图和结构化结果时，应在那个子图自身定义稳定的返回契约。

### 3. 对象返回经过提取、JSON 解析和跨语言转换

子代理结果中的 `structured_response` 是结构化输出字段。原有委派工具会将它序列化进返回消息；桥接层随后调用 `_extract_task_tool_output()`。省略函数签名后，源码如下：

```python
output = coerce_tool_output_for_ptc(result)
if not parse_json_output or not isinstance(output, str):
    return output
try:
    return json.loads(output)
except json.JSONDecodeError:
    # 解析失败保留原值，下游仍可能拿到字符串。
    return output
```

`coerce_tool_output_for_ptc()` 拆开工具消息或状态指令的封装。设置了 Schema 时，桥接层尝试解析字符串；得到的 Python 字典和列表由绑定层转换成原生 JS 对象和数组，后续代码因而可以直接访问 `review.issues`。

这里仍有字符串兜底。角色不存在时，原有 `task` 工具也可能返回一段错误文本；它不能解析成 JSON，就会原样返回。工程上应区分“调度未抛异常”“返回结构符合预期”“业务判断正确”三个条件，不能只看 Promise 已完成就使用深层字段。

## 六、结果回到哪里，哪些状态不会自动带回来

### 1. JS 接收的是结果内容

普通子代理工具返回 `Command`。这是 LangGraph 用来提交状态更新、也可携带控制指令的对象；它可能同时包含消息和其他需要合并到父图的字段。

JS 桥接路径中，`coerce_tool_output_for_ptc()` 会识别 `Command`，调用 `_extract_command_content()` 提取消息内容。以下是该函数源码，文档字符串已译为中文：

```python
def _extract_command_content(command: Command) -> Any:
    """从 Command 更新中提取末尾的消息内容。"""
    update = command.update
    if isinstance(update, dict):
        messages = update.get("messages")
        if isinstance(messages, list):
            for entry in reversed(messages):
                content = getattr(entry, "content", None)
                if content is not None:
                    return content
    return str(update)
```

这一步没有把整个 `Command` 交还父图的工具节点。外层 `eval` 最终返回的也是格式化后的 `ToolMessage`。因此，不能照搬第 09 篇普通工具路径的结论，认为子代理返回的业务字段一定会自动合并到父 State。State 是图执行时维护的状态字典，后续节点从中读取消息与业务数据。

假设子代理返回消息“已找到三个问题”，同时在 `Command.update` 中设置 `findings`。这条桥接路径取出的会是消息内容，`findings` 不会因此作为父图字段更新。需要交给下一个 JS 阶段的内容，应放进明确的返回结构；需要更新父图状态，则要另行设计状态合并入口。

文件更新还要区分存储位置。`StateBackend` 是以图状态保存文件的后端；这份快照的 `backends/state.py` 通过 `_send_files_update()` 直接更新当前图的文件通道。**按调用链推导**，标准子图内部的文件更新可以进入子图状态，但其返回的 `files` 字段无法靠这条 JS 桥接自动合并到父图，不能笼统说所有写入都丢失。

`FilesystemBackend` 直接写磁盘，`StoreBackend` 写独立存储，已完成的外部副作用不会因 `Command` 被转成内容而撤销。父子是否能看到同一份文件，仍取决于后端实例、路径和命名空间。本文没有运行子图写文件后检查父图文件状态的实验，这一项是源码链路推导，验证时应单独覆盖。

### 2. JavaScript 汇总后，主模型拿到文本结果

解释器执行完成后，结果被转换为文本，再由 `format_outcome()` 包装成 `<result>`；错误进入 `<error>`，捕获的控制台输出进入 `<stdout>`。这几部分最终成为 `eval` 的工具消息。

`max_result_chars` 会截断结果和错误文本，控制台也有独立的缓存与长度限制。`_prompt.py` 的一段说明声称返回值不截断，但实际 `_format.py` 明确对结果正文调用 `_truncate()`。应以执行代码为准，不能据此认为返回整个审查数组一定完整到达主模型。

较大的中间集合可以留在 JS 变量中，下一次 `eval` 继续筛选；交给主模型的内容宜包含总数、失败或未处理数量、少量结论和可定位的产物信息。这依赖所选的解释器状态模式，见下一节。

### 3. 进度事件与任务结果各有用途

`call_subagent_task_tool()` 通过 runtime 的事件写入器发送 `type="subagent"` 的自定义流事件。每次调度有独立 `id`，并在可取得外层调用 ID 时附带 `eval_id`。开始事件含角色、短标签和截断后的描述；正常返回发送 `complete`，普通异常发送 `error`，并携带耗时。

事件写入失败被捕获，避免显示进度的故障中断任务。反过来，界面没收到完成事件也不足以证明任务没有执行。`complete` 表示该调用返回，不证明审查结论正确；同样不能把这些自定义事件直接当成第 [18 篇](18-streaming-output.md) 所有子图投影接口的等价替代。

## 七、解释器参数如何约束动态编排

### 1. 同一解释器，几种不同的预算

`CodeInterpreterMiddleware.__init__()` 将内存、超时、普通工具调用预算和子代理开关传入 `_Registry`；创建会话实例时再传给 `_ThreadREPL`。所有 JS 编排仍在这个解释器里运行，因此没有另起一套不受约束的工作流运行环境。

| 参数或限制 | 本文基线默认值 | 约束对象与边界 |
| --- | --- | --- |
| `memory_limit` | 64 MiB | QuickJS 运行时堆内存，不是 Python 子代理及远端模型的总内存 |
| `timeout` | 5 秒 | 解释器执行及等待异步结果使用的超时参数，不是业务事务回滚保证 |
| `max_result_chars` | 4000 | 返回主模型的结果、错误和控制台文本；大数组可能被截断 |
| `capture_console` | `True` | 是否注册控制台对象并捕获日志 |
| `ptc` | `None` | 是否、以及哪些普通工具可通过 `tools.*` 访问 |
| `max_ptc_calls` | 256 | 每次 eval 的 `tools.*` 调用预算，不扣减 JS `task()` |
| 子代理信号量 | 32 | 每个解释器同时运行的 task 数；不限制累计调用次数 |
| `subagents` | `True` | 是否注册 JS task 桥接；实际执行还需找到原有委派工具 |
| `mode` | `thread` | JS 状态保留到一次调用、一轮执行或同一会话后续轮次 |
| `max_snapshot_bytes` | 与 `memory_limit` 相同 | 允许写入图状态的解释器快照大小，超限丢弃快照 |

没有单独的公开 `max_task_calls` 参数。提示词建议分批约 10 个，源码信号量限制并发为 32，两者都没有限制一个循环累计发起多少次任务。业务若要求“最多审查 100 个文件、最多复核 20 条”，需要明确输入范围、循环上限，并在需要强制预算时增加程序校验。

超时也应看具体执行点。`_aeval_async()` 先执行代码，再在返回值为 Promise 时继续等待，下面省略嵌套的资源释放结构和普通值分支：

```python
handle = await ctx.eval_handle_async(code, timeout=self._per_call_timeout)
# ……进入 handle 的资源清理保护……
if handle.is_promise():
    resolved = await handle.await_promise(
        timeout=self._per_call_timeout
    )
```

两处分别传入完整的超时数值，本层没有用同一个截止时间扣减剩余预算。不能仅凭参数名承诺整个调用严格在 `timeout` 内结束，也不能据此推算精确的两倍上限。对任务树总时长和费用有硬要求时，需要在业务层另设总预算。

### 2. call、turn、thread 保留的是 JS 状态

三种模式在 `middleware.py` 的执行与前后置 hook 中落地：

| 模式 | 正常执行路径中的保留范围 | 对工作流的影响 |
| --- | --- | --- |
| `call` | 每次 eval 后重置 | 多阶段要放在同一次调用，或显式传递中间结果 |
| `turn` | 同一轮 Agent 执行中复用，结束 hook 清理 | 可以分多次 eval 做审查和复核 |
| `thread` | 结束 hook 生成快照，后续入口 hook 恢复 | 同一会话的后续轮次可以恢复已保存的 JS 数据 |

`thread` 模式会把快照写入 `_quickjs_snapshot_payload`，再清理活跃实例。快照失败或超出 `max_snapshot_bytes` 时，该字段被设为 `None`。跨进程恢复还依赖图状态被正确保存和重新载入，不能只配置一个同名 `thread_id` 就假定已有持久化。

这些快照用于恢复解释器数据，不能据此承诺从长脚本中间的某一次 `await task()` 精确续跑。这里也没有把每个 JS 循环迭代自动展开成一个独立的 LangGraph 检查点。需要逐项恢复进度的批处理，应额外保存稳定任务 ID、输入、完成状态和结果位置。

## 八、工程接入时需要保留的边界

### 1. 父级工具治理不会逐次覆盖 JS 调度

JS 桥接直接调用 `task_tool.arun()`，没有为每个内部调度重新经过父图的 `ToolNode`。`ToolNode` 是 LangGraph 执行模型工具调用并处理工具返回的节点。因此，父级针对普通 `task` 设置的逐次审批，不会自动变成每次 JS `task()` 的审批；父级工具包装器仍可处理外层 `eval`，子代理自身的工具审批也仍由其配置决定。

若要求先审查整段编排代码，可以在 `eval` 入口配置审批；若要求审批子代理内部的写入动作，应在子代理自身配置对应中间件；若业务必须在父级逐次批准委派，应使用普通 `task` 路径，或关闭 JS 子代理桥接。QuickJS 没有内置文件和网络 API，也不代表被它调用的子代理没有外部能力。

`GraphInterrupt` 是 LangGraph 暂停执行、等待外部输入时使用的中断信号。桥接层会继续抛出这个信号，已有测试也检查异常对象原样传播，但没有由此验证 JS 执行位置恢复。如果父图恢复时重新调用 `eval`，代码会重新提交给解释器；不能把“中断可传播”写成“从 await 原位置继续”。

### 2. 并发与重试需要考虑外部副作用

对不同文件做只读分析，通常适合并发分发。若几十个子代理同时修改同一个报告文件，则会产生共享写入问题；信号量只限制同时运行数量，不提供文件事务或结果合并规则。可改为各自返回结构化发现，再由一个明确的写入步骤生成报告。

生成代码的循环条件、输入覆盖和失败处理也需要核对。`Promise.all` 的某项失败会使组合 Promise 失败，但不能据此推导其他已经发出的子任务没有产生副作用。超时被转换为解释器错误，也不等于所有远端工作已终止。重跑整段代码之前，应确认任务是否幂等、哪些产物已经存在，避免把“重新获取结果”变成重复写入。

### 3. 选择编排位置

| 需求 | 更合适的接入方式 | 理由 |
| --- | --- | --- |
| 一次明确委派 | 普通 task 工具 | 调用路径短，便于父级逐次观察和审批 |
| 一批对象的分析、分类、筛选与复核 | QuickJS 动态工作流 | 循环与阶段依赖在代码中表达，中间集合留在解释器 |
| 硬性业务步骤、固定失败补偿、逐项持久恢复 | 显式图或业务调度代码 | 需要开发者定义可验证的执行与恢复约束 |
| 跨请求管理远端长任务 | 异步 SubAgent | 需要独立的任务身份、查询和取消接口 |

可以复用的机制是异步宿主函数桥接、按调用复制配置、结构化返回和有界并发。需要按业务补充的是累计预算、输出验收、结果持久化以及共享写入策略。对于“审查后必须复核才能发布”的流程，发布入口仍应验证复核记录，不能只依靠模型生成的代码遵守顺序。

## 九、验证入口与延伸阅读

下面列出的是仓库已有测试的证据位置，**本文未运行这些测试，也未调用真实模型**。测试使用模拟模型或可运行对象时，只能支持其断言覆盖的行为，不能证明业务任务准确率。

| 验证问题 | `libs/partners/quickjs/tests/unit_tests/` 下的入口 |
| --- | --- |
| 未启用普通 PTC 时，能否调用子代理 | `test_thread_affinity.py` → `test_quickjs_task_global_available_without_ptc_e2e()` |
| 子代理是否在父事件循环运行 | `test_thread_affinity.py` → `test_quickjs_async_task_global_subagent_loop_affinity_e2e()` |
| 动态格式是否产生可访问字段的对象 | `test_repl_middleware.py` → `test_async_task_global_returns_declarative_structured_response_object()` |
| 固定 runnable 是否拒绝动态格式 | `test_repl_middleware.py` → `test_async_task_global_rejects_compiled_response_schema()` |
| 超过 32 个任务能否排队执行 | `test_repl_middleware.py` → `test_async_task_global_limits_concurrency_per_repl()` |
| Command 内容与 eval 返回形状 | `test_ptc.py` → `test_command_tool_does_not_change_eval_outcome_shape()`、`test_middleware_eval_tool_returns_tool_message_only()` |
| turn 模式是否在后续轮次重置 | `test_snapshot_persistence.py` → `test_repl_mode_turn_resets_state_between_turns()` |
| 事件写入失败是否影响任务 | `test_subagent_events.py` → `test_writer_failure_does_not_break_dispatch()` |

本系列可继续对照：

- [23：Interpreter 与 PTC 工具编排](23-interpreter-and-programmatic-tool-calling.md)：解释器执行、普通工具桥接和快照机制。
- [09：同步子代理](09-subagent-sync.md)：原有 task 工具如何筛选输入、执行子图和返回状态。
- [12：异步子代理](12-async-subagent.md)：远程任务生命周期与本次 eval 内并发的区别。
- [18：流式输出与子代理流](18-streaming-output.md)：任务进度与最终结果如何分别消费。
- [19：循环预算与终止控制](19-loop-budget-and-termination.md)：单次调用、Agent 循环和任务树预算的区别。
- [03：状态、Reducer 与恢复](03-state-reducers-and-recovery.md)：图状态恢复与外部副作用的边界。

流程使用示例可参看 [Datawhale《Dynamic Subagents：用代码编排多个 Agent》](https://datawhalechina.github.io/deepagents-in-action/chapters/ch16-dynamic-subagents/)。该课程标注的核对版本为 Deep Agents 0.7.8、langchain-quickjs 0.3.5；本文代码和边界以开头列出的源码快照为准。
