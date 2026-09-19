---
sidebar_position: 8
sidebar_label: 06 内置中间件总览
description: 按 create_agent 的装配阶段梳理 LangChain 预构建中间件，说明每个中间件如何进入工具节点、Hook、状态 Schema 和编译后的事件流。
---

# LangChain 源码解析 06：内置中间件总览

## 一、源码定位

> **阅读基线**：`langchain` 1.3.7、`langchain-core` 1.4.6（仓库快照 `langchain-core==1.4.6-2-g76c32db9b3`）。
> 路径相对 LangChain 仓库根目录；版本说明见 [系列导读](index.md)。
>
> - 工厂装配：`libs/langchain_v1/langchain/agents/factory.py` → create_agent()、_chain_model_call_handlers()。
> - 公开导出：`libs/langchain_v1/langchain/agents/middleware/__init__.py` → 内置中间件导入清单。
> - 扩展协议：`libs/langchain_v1/langchain/agents/middleware/types.py` → AgentMiddleware、ModelRequest。
> - 图节点限额：`libs/langchain_v1/langchain/agents/middleware/model_call_limit.py` → ModelCallLimitMiddleware.before_model()、after_model()。
> - 工具请求分流：`libs/langchain_v1/langchain/agents/middleware/tool_call_limit.py` → ToolCallLimitMiddleware.after_model()。
> - 模型重试：`libs/langchain_v1/langchain/agents/middleware/model_retry.py` → ModelRetryMiddleware.wrap_model_call()。
> - 模型回退：`libs/langchain_v1/langchain/agents/middleware/model_fallback.py` → ModelFallbackMiddleware.wrap_model_call()。
> - Todo 的多入口：`libs/langchain_v1/langchain/agents/middleware/todo.py` → TodoListMiddleware、_write_todos()。
> - 会话生命周期：`libs/langchain_v1/langchain/agents/middleware/shell_tool.py` → ShellToolMiddleware.before_agent()、after_agent()。
> - 状态与事件处理：`libs/langchain_v1/langchain/agents/middleware/pii.py` → PIIMiddleware、_PIIStreamTransformer。

本篇解决一个组合问题：同一份 middleware 列表，为什么既改变模型请求，又增加图节点、工具和状态字段？以限额、重试和审批为例，它们虽然都叫中间件，实际执行位置不同，不能靠列表从上到下推断一轮运行。

## 二、内置能力按需加入

create_agent 的 middleware 默认是空元组。不传实例时，工厂仍提供模型节点、按需要创建的工具节点和标准循环，但不会自动加入重试、摘要、审批或 Todo。

工厂直接注册的 ToolCallTransformer 和 SubagentTransformer 属于流事件整理：前者关联工具过程，后者识别命名子 Agent 的嵌套运行。它们不启动工具或子代理，也不能作为已经启用某个 Middleware 的证据。

下面按一个实例能提供的能力定位装配入口，而不是再次逐行复述整个工厂。

## 三、一个实例怎样进入多条执行路径

工厂在 `libs/langchain_v1/langchain/agents/factory.py` 中收集工具。下面是实际列表推导：

```python
middleware_tools = [
    tool
    for middleware_item in middleware
    for tool in getattr(middleware_item, "tools", [])
]
```

middleware_tools 与用户的普通工具合并，交给 ToolNode。模型调用包装器、工具包装器、节点 hook、state_schema 和 transformers 则分别收集。同一个 TodoListMiddleware 因而可以同时贡献 write_todos 工具、todos 状态、模型提示词和多调用检查。

工厂只为覆盖了相应方法的实例增加 hook 节点。before_model 的收集条件如下：

```python
middleware_w_before_model = [
    m
    for m in middleware
    if m.__class__.before_model is not AgentMiddleware.before_model
    or m.__class__.abefore_model is not AgentMiddleware.abefore_model
]
```

这个判断看的是方法实现，不是类名白名单。自定义中间件也按同样规则加入；只有模型包装器的实例不会因为存在于列表中就多出一个图节点。同步、异步节点与包装器的回退差异见 [04](04-middleware-control-plane.md)。

## 四、按执行位置理解内置实现

### 1. 模型与工具的调用治理

| 实现 | 入口 | 保存或改变什么 | 关键边界 |
| --- | --- | --- | --- |
| ModelCallLimitMiddleware | before_model、after_model | thread/run 模型轮次计数 | 包装器内部重试不会逐次经过计数节点 |
| ToolCallLimitMiddleware | after_model | 工具请求计数，为阻止的调用补错误消息 | 统计请求分流，不是外部执行成功数 |
| ModelRetryMiddleware | wrap_model_call | 捕获异常后重新调用内层 handler | 失败若转成普通结果，外层回退看不到异常 |
| ModelFallbackMiddleware | wrap_model_call | 失败后替换 request.model | 保留工具与参数，备用模型仍须兼容它们 |
| ToolRetryMiddleware | wrap_tool_call | 对单个工具调用重试 | 已提交的外部写入可能再次发生 |
| HumanInTheLoopMiddleware | after_model | 中断并按审批决定改写工具调用或补消息 | 工具动作尚未派发；审批身份由应用确认 |

限额节点负责图内计数，重试包装器负责一次节点执行里的再次尝试。需要限制总费用时，还要覆盖摘要模型、选择模型、备用模型和工具内请求，不能把一项 run_limit 当成整条调用树的金额预算。机制详见 [07](07-call-governance.md)、[08](08-human-in-the-loop.md)。

### 2. 上下文与隐私

| 实现 | 入口 | 数据变化 | 对后续运行的影响 |
| --- | --- | --- | --- |
| SummarizationMiddleware | before_model | 用摘要和保留历史替换 messages 状态 | 后续节点读取的是压缩后的历史 |
| ContextEditingMiddleware | wrap_model_call | 构造本轮消息副本，清理旧工具内容 | 原 State 历史仍可保留 |
| PIIMiddleware | before_model、after_model、可选 Transformer | 按配置处理用户输入、AI 输出、工具结果及事件 | State 处理和事件处理需分别核对 |

同样是减少模型看到的内容，摘要与请求编辑的恢复结果不同。一个清除了 State 中旧消息，另一个只改变本次请求。PII（个人身份信息）处理还涉及输出时机：after_model 发生时，模型流可能已经发出，不能靠最终消息替换追回那些增量。实际覆盖哪些角色、字段和流接口，见 [09](09-context-and-privacy.md)。

### 3. 工具注入与动态化

| 实现 | 贡献的能力 | 实现侧重点 |
| --- | --- | --- |
| TodoListMiddleware | write_todos、todos、wrap_model_call、after_model | 保存任务清单，注入使用说明，处理同轮多次更新 |
| ShellToolMiddleware | shell、会话状态、before_agent、after_agent | 创建或取得会话并在结束阶段尝试清理 |
| FilesystemFileSearchMiddleware | glob_search、grep_search | 工具闭包保存搜索根目录，校验路径后搜索 |
| LLMToolSelectorMiddleware | wrap_model_call | 额外模型调用选出本轮主模型可见的工具 |
| LLMToolEmulator | wrap_tool_call | 用模拟模型结果替代选中工具的真实执行 |
| ProviderToolSearchMiddleware | wrap_model_call | 按供应商能力绑定工具延迟加载与搜索声明 |

工具描述、可见工具集合与执行能力是三件事。选择器减少本轮主模型看到的 schema；模拟器改变执行结果来源；搜索声明依赖供应商集成支持。它们都不能代替工具执行端的权限检查。源码细节见 [10](10-tool-injection.md)、[11](11-tool-dynamics.md)。

## 五、将一份列表拆成真实执行顺序

考虑应用按这个顺序登记的五个实例：

```text
ModelCallLimit → HumanInTheLoop → ToolCallLimit → ModelFallback → ModelRetry
```

假设只看常规工具循环，它们分别形成：

| 执行面 | 实际顺序 | 为什么 |
| --- | --- | --- |
| before_model | ModelCallLimit | 其他四项没有该节点 hook |
| 模型包装器 | ModelFallback(ModelRetry(模型)) | 前面的包装器在外层 |
| after_model | ToolCallLimit → HumanInTheLoop → ModelCallLimit | 节点 after hook 按注册反序连接 |

模型轮次先检查额度，再进入回退与重试栈。模型结果回到图后，工具限额先对调用分流，审批再处理需要人工决定的调用，模型计数最后递增。这也表示审批中断时，后面的计数节点可能还没执行。

如果希望“主模型重试耗尽后才回退”，ModelRetry 需要配置 on_failure="error"。其默认 continue 会返回错误消息，外层 ModelFallback 无异常可捕获，单纯调整列表顺序无法得到预期行为。

加入 PII 时还要检查审批界面的数据来源。注册靠前使 before_model 更早执行，却使 after_model 更晚执行；它可能在审批之后才处理模型输出。模型最终输出脱敏，不等于审批请求、工具参数或业务日志也已经脱敏。

## 六、状态与资源各自保留在哪里

中间件的 state_schema 会与应用状态一起生成内部、输入和输出 Schema。私有计数可留在图内，但可见性标记不等于从检查点或调试事件中删除数据，同名字段的合并细节见 [05](05-state-graph-runtime.md)。

ShellToolMiddleware 保存的是运行中的会话资源。after_agent 在自然结束阶段关闭会话，但这不是对所有异常、取消和中断都生效的 finally。使用 Shell 时，还应核对执行策略、资源对象的终结机制及宿主生命周期。

一个实例也可能持有共享客户端、模型或配置。复用已编译 Agent 时，不要把某次请求的可变业务数据直接写入中间件实例属性，再假设它只属于该次调用；跨轮数据应放 State，单次临时数据放请求或局部变量。

## 七、编译时注册事件处理，运行时处理事件

工厂收集 Transformer 工厂的真实代码如下：

```python
middleware_transformers = [
    transformer
    for middleware_item in middleware
    for transformer in getattr(middleware_item, "transformers", ())
]
```

它们被追加到编译参数中的 ToolCallTransformer、SubagentTransformer 之后，再追加调用方显式传入的 transformers。注册发生在编译期，事件处理发生在运行期，不应称为“编译时脱敏”。

支持这套 Transformer 的事件入口会创建并使用相应实例。经典流与 Event Streaming 的契约不同，不能仅检查 Agent 上存在 transformers 就断言所有流出口都已处理；接入时要验证实际使用的方法、版本和通道。

## 八、按问题选择组合

从一个真实失败出发添加能力，比一次加入完整清单更容易验证。模型偶发限流时，检查重试异常和退避；需要审批时，检查暂停、恢复与拒绝的消息配对；历史过长时，比较请求编辑与 State 摘要对恢复的影响。

组合后至少确认三种结果：正常成功、可恢复失败、应停止的失败。重点观察真实模型尝试、工具执行、状态更新和外部副作用各发生了几次。LLMToolEmulator 适合验证编排如何消费模拟结果，不能证明真实工具、权限和产物正确。

阅读具体实现时，头部路径帮助定位代码，正文中的数据位置和调用顺序才是选择依据。接口机制见 [04](04-middleware-control-plane.md)，状态与恢复边界见 [05](05-state-graph-runtime.md)。
