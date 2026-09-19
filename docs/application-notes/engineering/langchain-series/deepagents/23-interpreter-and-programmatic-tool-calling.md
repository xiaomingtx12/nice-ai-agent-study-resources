---
sidebar_position: 25
sidebar_label: 23 Interpreter 与 PTC 工具编排
description: 从模型往返与中间数据出发，解析 QuickJS 解释器、PTC 工具桥接、原生值转换、会话状态和增量快照的实现。
---

# Deep Agents 源码解析 23：Interpreter 与 PTC 工具编排

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12 源码快照；`langchain-quickjs` 0.3.3。版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 解释器工具与生命周期：`libs/partners/quickjs/langchain_quickjs/middleware.py` → `CodeInterpreterMiddleware`
> - 会话实例与代码执行：`libs/partners/quickjs/langchain_quickjs/_repl.py` → `_Registry`、`_ThreadREPL`
> - PTC 工具白名单：`libs/partners/quickjs/langchain_quickjs/_ptc.py` → `filter_tools_for_ptc()`
> - 工具签名与使用说明：`libs/partners/quickjs/langchain_quickjs/_prompt.py` → `render_ptc_prompt()`
> - 返回值转换与格式化：`libs/partners/quickjs/langchain_quickjs/_format.py` → `coerce_tool_output_for_ptc()`、`format_outcome()`
> - 快照差分与重放：`libs/partners/quickjs/langchain_quickjs/_snapshot.py` → `encode_snapshot()`、`replay_snapshot_chain()`
> - 工具筛选、调用预算与返回值测试：`libs/partners/quickjs/tests/unit_tests/test_ptc.py`

以上路径均相对于 Deep Agents 仓库根目录。本文解释运行时与普通工具编排；多个子代理如何在同一解释器中协作，见 [22：动态子代理与 QuickJS 代码工作流](22-dynamic-subagents-and-quickjs-workflows.md)。建议先读本文，再进入第 22 篇。

Interpreter 在这里指运行模型生成代码的解释器。QuickJS 是嵌入式 JavaScript 引擎，`quickjs-rs` 提供 Python 与引擎之间的绑定。REPL 是可以反复执行代码、按配置保留变量的交互式环境。PTC（Programmatic Tool Calling，程序化工具调用）则把 Python 工具接进这个环境，让代码可以调用工具。

## 二、为什么普通工具调用之外还需要解释器

**解释器把循环、条件分支和数据整理交给程序执行，让主模型围绕任务判断工作，而不必逐轮搬运所有中间数据。** 它的收益主要来自减少模型往返、限制返回上下文的数据量，以及用代码明确覆盖范围。

假设要读取 80 个订单，筛出高金额或多次退款的记录，并按风险分组。主模型可以一次发出多个普通工具调用，不必串行查询 80 次；但这一批调用生成时，尚未拿到查询结果。收到结果后再按内容筛选、发起第二批调用，通常还要进入下一轮模型推理。

有了 Interpreter，模型可以生成一段程序：读取订单、记录缺失项、筛选风险订单，再只对风险项查询详情。第二批调用由第一批的实际结果决定，这个依赖关系可以在同一次 `eval` 中完成。数据库查询次数没有凭空减少，减少的是每个编排阶段重新经过主模型的次数。

| 工作 | 适合留给谁 | 原因 |
| --- | --- | --- |
| 决定风险判断需要哪些信息 | 模型或明确的业务规则 | 涉及任务理解和判断依据 |
| 遍历完整的订单列表 | JavaScript | 循环直接表达输入覆盖范围 |
| 查询某个订单 | Python 工具 | 复用业务连接、鉴权和输入校验 |
| 去重、分组、计数、排序 | JavaScript | 对给定数据执行可检查的确定性操作 |
| 解读筛选后的发现并回答用户 | 模型 | 组织结论、说明证据与缺口 |

这要求生成的代码本身正确。错误的筛选条件会稳定地筛错，遗漏的输入不会由运行时自动补齐。若工具本来支持一次批量查询 80 个订单，应优先使用它，避免为了采用 PTC 而拆成 80 次远端请求。

### 1. 解释器处理数据，Sandbox 提供系统执行环境

QuickJS 不等于 Node.js，也没有自动获得宿主机的文件、网络、Shell 或包管理器能力。它适合内存中的数据处理，以及通过显式接入的工具访问外部资源。需要安装依赖、运行测试或启动进程时，仍要使用对应的执行后端，见 [05：Backend 沙箱与隔离](05-backend-sandbox-and-isolation.md)。

`_Registry._build_slot_locked()` 为每个会话构造 `ThreadWorker`、QuickJS `Runtime` 和 `_ThreadREPL`。`ThreadWorker` 是承载引擎操作的专属线程；`Runtime` 在这里是 QuickJS 的运行时对象，管理内存和代码转换选项。它们不构成独立容器或虚拟机。`mode="call"` 重建的是解释器上下文，也不等于每次建立一个新的操作系统隔离环境。

### 2. 主模型仍通过工具调用进入解释器

模型不会直接调用 Python 的 QuickJS API。它看到的是一个默认名为 `eval` 的工具，输入是一段 `code` 字符串。整体路径如下：

```text
模型请求：解释器说明 + 可用工具的输入与返回契约
  → 模型生成 eval(code) 调用
  → QuickJS 执行 code
    → 普通 JS 运算：循环、过滤、分组、排序
    → 可选的 tools.*：进入 Python 工具，再把值送回 JS
  → 等待最后一个表达式的异步结果
  → 将结果和控制台输出格式化、截断
  → 一条 eval 工具消息回到主模型
```

没有返回或打印的中间工具结果，不会由这条桥接自动逐项追加成主模型的工具消息；它们仍可能被工具自身日志和追踪系统记录。模型若把所有原始数据都放到最终结果中，解释器也不会自动替它做摘要。

## 三、CodeInterpreterMiddleware 如何装配 eval

### 1. 工具执行与提示词注入分别发生

`CodeInterpreterMiddleware` 是在 Agent 调用前后介入处理的中间件。构造时，它把 `_build_tool()` 的返回值放入 `self.tools`；LangChain 创建 Agent 时收集这些工具。`_build_tool()` 末尾的实际包装代码如下：

```python
return StructuredTool.from_function(
    name=tool_name,
    description=tool_description,
    func=sync_eval,
    coroutine=async_eval,
    infer_schema=False,
    args_schema=EvalSchema,
    metadata={"ls_code_input_language": "javascript"},
)
```

`StructuredTool` 是带明确参数结构的 LangChain 工具；`EvalSchema` 用来约束输入，只有一个 `code: str` 字段。上面同时登记同步与异步入口，实际执行时才把代码交给解释器。

模型请求前，`wrap_model_call()` 调用 `_prepare_for_call()`，再通过 `request.override(system_message=...)` 补充本轮系统消息。说明包括解释器的状态模式、资源参数，以及启用 PTC 后可调用的工具签名。这里的 `ModelRequest` 是当前模型调用的输入对象，`override()` 用于创建修改后的请求。

因此，“模型知道有什么工具”和“工具真正执行”是两个时点。只在提示词里写一个 Python 函数名，不会把该函数装进 QuickJS；工具说明、宿主函数注册和后端执行都要接通。

### 2. 安装工具和执行代码必须命中同一实例

中间件用 `_resolve_thread_id()` 从运行配置取得会话 ID；没有显式 ID 时，使用中间件实例创建时保存的 `_fallback_thread_id`。随后 `_Registry.get()` 取得对应的解释器。

这个回退 ID 必须稳定。如果模型请求前把工具安装到实例 A，执行 `eval` 时却查到实例 B，就会出现 `tools is not defined`。`test_ptc_install_and_eval_resolve_to_same_repl()` 专门覆盖这一回归路径。实例级回退 ID 也不能替代业务会话身份：多个用户共享中间件时，应提供正确、互不混淆的 `thread_id`。

## 四、PTC 怎样把 Python 工具暴露给 JavaScript

### 1. 名称白名单与直接传入工具对象

`BaseTool` 是 LangChain 工具的基础接口。`ptc` 接受名称与 `BaseTool` 对象组成的列表，两种形式的来源不同：

| 配置形式 | 工具从哪里取得 | 对模型普通工具列表的影响 |
| --- | --- | --- |
| `ptc=["lookup_order"]` | 按名称匹配本轮 `ModelRequest.tools` | 不会凭空创建该工具，需要先由 Agent 或其他中间件提供 |
| `ptc=[lookup_order]` | 直接使用传入的工具对象 | 单凭这个配置，不会把它加入模型的普通工具列表 |
| `ptc=None` | 不安装普通工具的 PTC 入口 | 解释器仍可做计算；JS 子代理能力由另一个开关控制 |

`_ptc.py` 的 `filter_tools_for_ptc()` 在验证列表项后，按下列代码合并来源。省略前面的类型检查，以及后面的去重和合法名称校验：

```python
selected = [
    *explicit_tools,
    *[t for t in tools if t.name != self_tool_name and t.name in allow_names],
]
```

显式对象排在前面，同名工具去重时也优先保留它。名称形式会跟随本轮工具列表，直接传入对象则不依赖该工具仍在本轮列表里。若上游中间件通过筛选请求工具来做动态授权，不能假定它同时撤掉了显式对象路径。

解释器自己的工具会被排除，防止通过 `tools.eval` 套娃调用。`task` 也被保留给独立的子代理入口，放入 `ptc` 会报错。只想开放纯计算时，还要检查 `subagents`：它默认是 `True`，存在 Deep Agents 委派工具时可使用 JS `task()`，不能把 `ptc=None` 直接等同于解释器没有任何外部能力。

### 2. 只转换函数名，不转换参数名

Python 工具名 `lookup_order` 会映射为 `tools.lookupOrder`，输入字段仍遵循原工具的 Schema（参数结构），例如 `order_id`。`_prompt.py` 从工具 Schema 生成签名，模型应依据签名传参。

`_repl.py` 的 `_ainstall_tools()` 将转换后的名称放入 `name_to_tool`，然后为新名称注册异步宿主函数，并重建 `globalThis.tools`。宿主函数是解释器调用 Python 的桥梁，JS 发起调用后得到一个 `Promise`，即异步结果对象。

这里有一个命名边界：`lookup_order` 和 `lookup-order` 都会变成 `lookupOrder`。筛选器按原工具名去重，安装阶段却用转换后的名称作字典键；按这段实现推导，两者并存时后写入的工具会覆盖前者。应用应保证转换后的名称唯一，不能只检查 Python 工具名不同。

### 3. 一段真实示例里的三个工具调用

下面摘自 `libs/partners/quickjs/README.md` 的 PTC 示例，前提是已经提供 `search_web` 和 `summarize` 两个工具：

```javascript
const results = await Promise.all([
  tools.searchWeb({ query: "deepagents" }),
  tools.searchWeb({ query: "quickjs" }),
]);

await tools.summarize({ text: results.join("\n\n") })
```

`Promise.all` 等待两次搜索，之后把结果拼成第三次工具的输入。整个过程可以在一次 `eval` 中完成；主模型不需要在两次搜索和摘要之间重新生成工具调用。若 `summarize` 工具内部也调用模型，其成本仍然存在，只是没有经过主 Agent 的下一轮编排。

这里的并发来自异步函数调用，普通 PTC 路径没有第 22 篇子代理桥接中的 32 路信号量。`max_ptc_calls` 限制累计调用数，不是并发数；需要控制下游服务同时接收多少请求时，应在代码中分批，或在工具、服务端增加并发控制。

## 五、一次 tools 调用如何穿过桥接层

### 1. 先扣预算，再补参数和调用上下文

`_register_tool_bridge()` 创建的 `_bridge` 在运行时读取当前工具对象。以下摘录它的核心主体，省略入口检查；原英文注释译为中文并压缩了措辞：

```python
state = self._ptc_state.consume_call_budget(
    function_name=f"tools.{camel}",
    max_ptc_calls=self._max_ptc_calls,
)
self._ptc_state = state
payload = _normalize_tool_input(raw_input)
call_id = _synth_tool_call_id(tool.name)
# 桥接层自行注入 runtime、state 和 store；调用 ID 在下游按需要传入。
# 避免统一走工具消息封装，否则列表、字典和数字可能被转成文本。
args = _inject_tool_args_for_ptc(
    tool, payload, state.outer_runtime, call_id
)
result = await self._ainvoke_tool_on_outer_loop(
    tool,
    {"name": tool.name, "args": args, "id": call_id, "type": "tool_call"},
    outer_loop=state.outer_loop,
)
return coerce_tool_output_for_ptc(result)
```

`_PTCState` 保存当前这次 `eval` 的剩余预算、外层工具上下文和事件循环。预算在参数校验及实际执行之前扣减，所以失败的尝试也会消耗次数；超限的下一次调用会在进入工具之前被拒绝。每次新的 `eval` 都重新建立这份计数，不能用它限制整个 Agent 多轮运行的总调用量。

`_normalize_tool_input()` 将 JS 输入整理成 Python 参数字典。对象中值为 `undefined` 的字段会被删除，让工具参数的默认值生效；数组里的 `undefined` 则转成 `None`，避免删除元素后改变索引。把函数名转成驼峰命名，并不意味着参数字段也会被转换。

### 2. runtime 注入补上了工具节点原本承担的工作

`ToolRuntime` 是本次工具执行的上下文，包含图状态、配置、业务上下文、存储和事件写入器。普通工具由 `ToolNode` 注入这些依赖；`ToolNode` 是 LangGraph 执行工具并处理结果的节点。PTC 绕过这条节点路径，需要 `_inject_tool_args_for_ptc()` 自行识别工具声明的注入参数。

源码借助 LangGraph 的 `_get_all_injected_args()` 获取注入信息，再构造带新调用 ID 的 runtime。它复用外层的状态与依赖，不是对整个运行环境做深拷贝。每次调用有独立 ID，也不意味着各工具互相隔离了文件或业务存储。

实际执行被安排到外层 Python 事件循环，异步客户端因此仍在其适用的循环上使用。父图逐次工具包装和审批不会因这些参数被补齐而自动恢复；需要逐次强制执行的治理逻辑，应保留普通工具路径，或放进工具自身可验证的执行入口。

### 3. 原生结果不必先变成字符串

`_ainvoke_tool_on_outer_loop()` 调用 `tool.arun()`。这个接口异步运行 LangChain 工具；桥接层只在工具声明了 `InjectedToolCallId` 时，把调用 ID 作为该接口的参数传入。`InjectedToolCallId` 是让工具函数直接接收调用身份的注解。

这样做是为了避免所有结果都被工具消息封装并转成文本。`_format.py` 的 `_coerce_for_marshal()` 保留基础类型，并递归转换容器。下面是完整函数，文档字符串及原注释已译为中文：

```python
def _coerce_for_marshal(value: Any) -> Any:
    """把返回值转换成桥接层可传递的形态。"""
    if isinstance(value, _NATIVE_JS_SCALARS):
        return value
    if isinstance(value, dict):
        return {str(k): _coerce_for_marshal(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_coerce_for_marshal(v) for v in value]
    # 将 Pydantic 模型展开为字典，保留字段结构；嵌套值继续递归转换。
    if isinstance(value, BaseModel):
        return _coerce_for_marshal(value.model_dump())
    return str(value)
```

`BaseModel` 是 Pydantic 的数据模型基类，`model_dump()` 将模型字段导出为字典。普通 Python 数字对应 JS 数字，字典对应对象，列表对应数组，`None` 对应 `null`；日期等未直接支持的类型在此回退为字符串。

包的 README 有“工具结果都会转成字符串”的旧说明，当前函数和测试已经证明这个概括不成立。不过，若工具主动返回字符串或 `ToolMessage` 的内容本来就是文本，桥接也不会自动解析成对象。应按具体返回契约消费，不能统一加或统一删 `JSON.parse()`。

`Command` 是 LangGraph 的状态更新指令。它在这条路径中会被提取消息内容，不会作为完整状态指令交给父图应用；因此 PTC 适配一个已有工具时，要检查该工具是否依赖状态回写。详细区别见 [22：结果回到哪里](22-dynamic-subagents-and-quickjs-workflows.md#六结果回到哪里哪些状态不会自动带回来)。

### 4. 同步入口也会转入异步驱动

本地 README 建议只用 `ainvoke()`，但 `_ThreadREPL.eval_sync()` 已经把同步调用转交到 worker 的异步执行路径。以下是它的主体，省略函数签名；注释译自原文：

```python
# 同步和异步入口都进入 worker 上的异步执行路径。
# 同步 ctx.eval 无法调度异步宿主函数，因而需要这层转交。
return self._worker.run_sync(
    self._aeval_async(
        code,
        outer_runtime=outer_runtime,
    )
)
```

`test_end_to_end.py` 的 `test_deepagent_with_quickjs_mixed_foreign_function_sync()` 使用 Agent 的同步 `invoke()`，断言同一脚本调用同步和异步工具得到预期结果。异步服务仍宜使用 `ainvoke()` 并复用外层事件循环，但不能把 README 的旧限制写成本基线的运行事实。

## 六、eval 怎样把结果交回模型

### 1. 最后一个表达式可以是 Promise

`_aeval_async()` 通过 `ctx.eval_handle_async()` 执行代码，取得表示 JS 返回值的 handle，即引擎对象的引用。如果返回的是 Promise，会继续调用 `await_promise()` 等待，再尝试转换成 Python 值。解释器不是通过重新执行代码来取得异步结果；`test_unwrapping_does_not_double_user_side_effects()` 断言解包过程不会把用户代码中的日志再执行一次。

结果无法跨语言转换时，例如直接返回一个函数，会记录 `result_kind="handle"`，再用 `format_handle()` 给出描述。这种描述只能告诉模型返回了什么类型，不是可以在 Python 中继续调用的函数。代码内部能保留什么、快照能恢复什么、最终工具消息能携带什么，是三个不同问题。

### 2. 结果、日志与错误分别格式化

`EvalOutcome` 是解释器执行结果的内部记录，包含结果文本、控制台文本、错误类型和错误信息。`format_outcome()` 将它们分别包装为 `<result>`、`<stdout>` 和 `<error>`，然后中间件返回一条 `ToolMessage`。`ToolMessage` 是与外层 eval 调用 ID 关联的工具结果消息。

`console.log`、`console.warn`、`console.error` 共用 `_ConsoleBuffer`。本实现把日志级别合并，只保留输出文本；缓冲区在追加时就限制长度，避免无限日志一直占用 Python 内存。每次 eval 结束会取走并清空这份缓冲。

最终结果也会截断。`format_outcome()` 的结果分支先取 `outcome.result`，再执行下面的真实语句：

```python
body_xml = _xml_escape(_truncate(body, max_result_chars))
```

因此 `max_result_chars` 不是整个工具消息的总长度预算，结果或错误、控制台是分开处理的；也不能把返回表达式当成不受限制的数据通道。被截断的对象表示可能已不完整，模型不能据此推断被省略记录的内容。大集合宜保留在解释器里，返回计数、少量记录和失败清单。

### 3. 错误可反馈给模型，但不会撤销已完成的工作

`_aeval_async()` 会把多种异常记录成模型可见的错误，让模型有机会缩小批次或修改代码：

| 错误类型 | 源码中的触发条件 | 应检查的位置 |
| --- | --- | --- |
| `SyntaxError`、`ReferenceError` 等 | JS 引擎报告语法或执行错误 | 模型生成的代码、变量与函数名 |
| `PTCCallBudgetExceeded` | 本次 eval 的工具调用预算耗尽 | 输入规模、循环与重试次数 |
| `Timeout` | 引擎执行或等待触发超时异常 | 工作量、异步调用延迟和超时设置 |
| `Deadlock` | Promise 未解决，且没有可推动它完成的异步宿主工作 | 脚本中的 Promise 是否会完成 |
| `ConcurrentEval` | 同一个上下文发生重叠的 eval | 是否把多个 eval 本身并行发出 |
| `OutOfMemory` | QuickJS 运行时达到内存限制 | JS 中保留的数据与计算方式 |

一个 eval 内并行调用多个 `tools.*`，与对同一个上下文同时运行多个 eval 不同。后者不会由本层自动排队，而是暴露并发执行错误，避免多个脚本同时改同一份变量。

工具抛异常、工具返回错误文本，也不是同一种失败。前者可能让 Promise 拒绝，后者仍是一次成功返回，需要按业务字段识别。失败前已经完成的数据库写入和远端请求不会被解释器自动回滚；重新生成或重跑脚本前，应保留能够识别已处理项的信息。

## 七、变量保留与快照恢复是怎样实现的

### 1. 三种模式分别在哪个时点清理

这里的一轮指一次 Agent 调用过程，其中可以包含多次模型请求和多次 `eval`。会话则通过 `thread_id` 关联多轮调用。`mode` 决定解释器状态的保留范围，清理动作分布在工具入口和 Agent 的前后置 hook：

| 模式 | 正常执行时的处理 | 后续能读到什么 |
| --- | --- | --- |
| `call` | 每次 eval 的 `finally` 调用 `reset_repl()` | 下一次 eval 从新上下文开始 |
| `turn` | 一轮内复用实例，`after_agent` 驱逐实例 | 同轮变量可复用，下一轮不保留 |
| `thread` | 结束 hook 保存快照并驱逐实例，下轮入口恢复 | 图状态中成功保存并重新载入的解释器数据 |

`reset_repl()` 保留 worker 和 Runtime，只替换 REPL 上下文；`evict()` 则关闭并移除整个会话运行槽。因此，`call` 与 `turn` 的区别不只是变量何时清空，也包括清理的对象范围。

`call` 模式下一次 eval 仍应能访问允许使用的工具。中间件在 `_repl_for_eval()` 中使用本轮保存的工具对象重新安装 PTC；`test_mode_call_reinstalls_ptc_tools_for_each_eval_call()` 验证两个连续 eval 都能调用同一个工具。重建上下文不应把合法的工具配置一并遗忘。

### 2. thread 模式保存的是引擎快照字节

`_ThreadREPL._acreate_snapshot()` 的实际主体很短，下面省略函数签名：

```python
ctx = self._require_ctx()
snapshot = ctx.create_snapshot()
return snapshot.to_bytes()
```

恢复路径通过 `Snapshot.from_bytes()` 读取字节，再调用 QuickJS Runtime 的恢复接口，`inject_globals=True` 用于恢复全局绑定。`Snapshot` 是绑定层表示引擎快照的对象，这里没有把变量逐个转换成应用层 JSON 再保存。

运行时创建时还开启了 `SourceTransform.TOP_LEVEL_CONST_TO_VAR`，即绑定层提供的顶层声明转换选项。它与跨 eval 使用顶层变量有关，不能把解释器的顶层作用域行为直接等同于普通 JavaScript 模块。

对恢复范围，应按已有证据描述：

- `test_repl_snapshot_persists_state_between_turns()` 使用检查点存储和相同会话 ID，验证上一轮定义的计数器下一轮仍可读取。
- `test_repl_snapshot_persists_top_level_await_binding_between_turns()` 验证顶层等待得到的字符串绑定跨轮可读。
- `test_repl_top_level_const_let_persist_across_evals_same_turn()` 只验证同一上下文内的连续 eval，不能拿来证明所有声明都能跨快照恢复。

这些测试没有覆盖任意函数、闭包、类实例或 Python 宿主对象的恢复。函数作为最终结果无法转换成 Python 值，也不能据此推断它在引擎快照中一定无法保存。序列化范围应按 `quickjs-rs` 的对应版本单独验证；可跨版本迁移的业务结果宜使用明确的数据结构。

### 3. 增量快照节省的是图检查点存储

`REPLState` 是该中间件扩展的图状态结构，其中 `_quickjs_snapshot_payload` 声明为字节字段，并配置 `DeltaChannel(replay_snapshot_chain)`。`DeltaChannel` 是保存增量写入、按 reducer 重建值的 LangGraph 通道；reducer 指把已有值和新写入合并起来的函数。这里重建后的值仍是一份完整快照字节。

每轮结束时先生成完整快照，再由 `_snapshot.py` 的 `encode_snapshot()` 与上一份字节比较。下列片段省略 diff 失败时记录日志并返回完整快照的异常分支：

```python
if not prior:
    return (SNAP, payload)
try:
    patch = bsdiff4.diff(prior, payload)
# ……异常时记录日志，并返回 (SNAP, payload)……

# 差分不比完整快照小时，直接保存完整快照。
if len(patch) >= len(payload):
    return (SNAP, payload)
return (PATCH, patch)
```

`bsdiff4` 是这里使用的二进制差分库。通道收到三类记录：

| 记录 | 重放行为 | 使用时机 |
| --- | --- | --- |
| `("snap", bytes)` | 用完整字节替换当前基础值 | 首次保存，或差分失败、不够小 |
| `("patch", bytes)` | 把差分应用到已有基础值 | 两份快照之间的变化较小 |
| `("clear", b"")` | 清空基础值 | 清除无效或不再保留的快照；写入 `None` 也会转换成此记录 |

`replay_snapshot_chain()` 按顺序重放这些记录，下一轮 hook 拿到的是还原后的完整快照。这个优化没有省去每轮生成完整堆快照的开销，也不保证整个会话历史占用恒定空间。`test_delta_channel_bounds_checkpoint_blob_growth()` 的断言只覆盖特定几轮、小幅堆变化的场景，不能据此承诺固定压缩比。

`max_snapshot_bytes` 检查的是差分之前的 `len(payload)`。即使一份很大的完整快照只产生几百字节差分，只要原始快照超限，`_snapshot_update()` 仍会清空状态字段；这个参数不限制整条差分链累计占用，也不避免生成完整快照时的临时开销。

### 4. 相同 thread_id 不等于已有持久化

`thread` 模式在正常结束 hook 中生成状态更新，随后驱逐活跃解释器。后续新调用需要通过 Checkpointer 重新载入图状态，或由其他明确的状态恢复机制提供快照。Checkpointer 是保存并载入图检查点的组件；只传同一个 `thread_id`，不会自动把之前已经清理的 JS 上下文找回来。

恢复新实例时，也不是从字节中恢复任意 Python 连接。创建上下文时会按配置注册 console 和 task；`before_agent` 恢复快照；到模型请求包装阶段，`_prepare_for_call()` 再安装当前允许的 `tools.*`。不能假设快照里保存过的旧工具函数引用已经自动绑定到新的 Python 对象。

快照保存发生在结束 hook，不能保证进程崩溃、中断或取消时也能进入该位置。`_aeval_async()` 自身的 `finally` 只恢复调用上下文、收集日志，不在每次 eval 后创建堆快照。它也没有记录一段脚本执行到了哪次 await；恢复变量与恢复未完成程序的执行位置，需要分别讨论。

## 八、资源和权限边界怎样落实

### 1. 预算分别约束不同对象

| 配置或约束 | 本文基线 | 实际范围 |
| --- | --- | --- |
| `memory_limit` | 默认 64 MiB | QuickJS Runtime 的堆，不包含全部 Python 工具内存和外部服务成本 |
| `timeout` | 默认 5 秒 | 代码执行与 Promise 等待使用的参数；本层没有共享截止时间扣减两阶段预算 |
| `max_ptc_calls` | 默认 256 | 单次 eval 的 tools 调用尝试数；下一次 eval 重新计数 |
| `max_result_chars` | 默认 4000 | 模型收到的结果、错误及控制台文本限制 |
| `max_snapshot_bytes` | 默认跟随内存上限 | 差分前的完整快照大小 |
| 普通 PTC 并发 | 此桥接没有专门信号量 | 由脚本、工具实现与下游服务共同约束 |

一次 eval 的调用次数受控，不代表任务总成本受控。模型可以连续调用多次 eval，某个工具内部也可能再发起多次远端请求。需要总额上限时，应在应用层按会话或业务任务累计，不能把解释器局部参数当作总预算。

### 2. 可见工具列表不是完整授权机制

PTC 工具不逐次经过父 Agent 的普通工具节点。对每次写操作都必须审批的业务，应保留普通调用路径；批准整个 eval 只能批准这一段代码，不能自动提供细粒度的业务校验。工具内部的身份、租户范围、输入约束和副作用控制仍要执行。

工具动态隐藏也有边界。`install_tools()` 会重写当前 `globalThis.tools`，但注册过的宿主函数不能在这里注销，内部映射也保留旧入口。**按源码推导**，脚本此前保存的函数引用不一定随命名空间缩减而失效。因此，移除模型能看见的名字不能代替工具执行时的权限检查。

### 3. 哪些场景值得采用

订单列表的筛选、计数和多阶段查询适合交给 Interpreter；要用到服务端批量查询时，仍应把批量能力封装在工具中，减少网络往返。业务流程已经固定、每一步都必须审计和补偿时，开发者维护的程序或显式图通常更容易核验。

模型生成的代码适合组织当次任务，但重要规则不能只存在于这段代码。订单是否属于当前租户应由查询工具检查，退款是否允许应由业务接口检查；即使脚本漏写条件，这些入口也应按业务规则拒绝操作。

## 九、验证入口与延伸阅读

以下为本地已有测试的证据入口，**本文未运行这些测试或调用真实模型**。不少测试用固定模型消息或模拟工具验证桥接行为，不能据此推导模型一定会为真实任务生成正确程序。路径均相对于 `libs/partners/quickjs/tests/unit_tests/`。

| 问题 | 测试入口 |
| --- | --- |
| 工具对象不在普通列表时能否接入 PTC | `test_ptc.py` → `test_middleware_ptc_list_of_tools_exposes_without_agent_tools()` |
| 安装与执行是否共用一个解释器 | `test_ptc.py` → `test_ptc_install_and_eval_resolve_to_same_repl()` |
| call 模式是否重新安装工具 | `test_ptc.py` → `test_mode_call_reinstalls_ptc_tools_for_each_eval_call()` |
| undefined 字段是否保留参数默认值 | `test_ptc.py` → `test_undefined_object_property_uses_schema_default()` |
| 返回数字、对象和空值是否保留类型 | `test_end_to_end.py` → `test_ptc_int_return_is_native_js_number()`、`test_ptc_dict_return_is_native_js_object()`、`test_ptc_none_return_is_js_null()` |
| 同步入口能否调用异步工具 | `test_end_to_end.py` → `test_deepagent_with_quickjs_mixed_foreign_function_sync()` |
| 预算是否随新 eval 重置 | `test_ptc.py` → `test_ptc_host_call_budget_resets_each_eval()` |
| 等待最终 Promise 是否重复执行用户代码 | `test_repl_middleware.py` → `test_unwrapping_does_not_double_user_side_effects()` |
| 图状态能否恢复跨轮顶层绑定 | `test_snapshot_persistence.py` → `test_repl_snapshot_persists_state_between_turns()` |
| 差分通道是否减少特定场景的存储量 | `test_snapshot.py` → `test_delta_channel_bounds_checkpoint_blob_growth()` |

本系列相关章节：

- [22：动态子代理与 QuickJS 代码工作流](22-dynamic-subagents-and-quickjs-workflows.md)：在同一个解释器中编排完整的 Agent 循环。
- [03：状态、Reducer 与恢复](03-state-reducers-and-recovery.md)：图通道如何保存和重建状态。
- [05：Backend 沙箱与隔离](05-backend-sandbox-and-isolation.md)：命令执行环境与资源边界。
- [06：中间件增量与执行顺序](06-middleware-increments.md)：工具注册、模型请求包装与执行 hook 的区别。
- [19：循环预算与终止控制](19-loop-budget-and-termination.md)：从单次调用限制扩展到任务预算。

订单场景的使用讲解可参看 [Datawhale《Interpreters：让 Agent 用代码编排工具与数据》](https://datawhalechina.github.io/deepagents-in-action/chapters/ch15-interpreters/)。该课程标注的核对版本为 Deep Agents 0.7.8、langchain-quickjs 0.3.5；本文涉及的原生值转换、同步入口和快照机制均以开头列出的源码快照为准。
