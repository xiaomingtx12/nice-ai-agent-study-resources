---
sidebar_position: 19
sidebar_label: 17 Prompt Caching 中间件与供应商缓存断点
description: 从 Deep Agents 0.6.12 源码拆解 Provider Prompt Caching 中间件的装配与门控，以及 Anthropic 与 Bedrock 两侧的缓存断点落点。
---

# Deep Agents 源码解析 17：Prompt Caching 中间件与供应商缓存断点

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/deepagents/`）；供应商中间件源码：LangChain monorepo 源码快照（`langchain-anthropic` 1.5.2），`langchain-aws` 取 PyPI wheel 1.7.6 解包。
> 源码版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 装配入口：`libs/deepagents/deepagents/graph.py` → `_create_bedrock_prompt_caching_middleware()`、`_create_fireworks_prompt_caching_middleware()`、`_append_prompt_caching_middleware()`、`create_deep_agent()`
> - 装配测试：`libs/deepagents/tests/unit_tests/test_graph.py` → `TestPromptCachingWiring`
> - Memory 断点：`libs/deepagents/deepagents/middleware/memory.py` → `MemoryMiddleware.modify_request()`
> - Anthropic 中间件：`langchain/libs/partners/anthropic/langchain_anthropic/middleware/prompt_caching.py` → `AnthropicPromptCachingMiddleware`
> - Bedrock 中间件：`langchain_aws/middleware/prompt_caching.py` → `BedrockPromptCachingMiddleware`；`langchain_aws/chat_models/bedrock_converse.py` → `ChatBedrockConverse._apply_cache_points()`
> - 组合顺序：`langchain/libs/langchain_v1/langchain/agents/factory.py` → `_chain_model_call_handlers()`

## 二、缓存策略怎样进入供应商请求

Deep Agents 在装配期加入供应商集成提供的缓存中间件。中间件准备标记或模型参数，聊天模型适配器将它们序列化成 API 请求，供应商服务再决定是否写入或命中缓存。本文分析前三步的源码，命中结果要通过实际响应中的用量信息观察。

工厂中的接线分为三步：

1. 探测 `langchain-aws`、`langchain-fireworks` 这两个可选包是否安装，装了才把对应中间件追加进栈（`graph.py:251` 的 `_create_bedrock_prompt_caching_middleware()`）；
2. Anthropic 的中间件不探测，因为 `langchain-anthropic` 是硬依赖，直接装；
3. 所有缓存中间件都以 `unsupported_model_behavior="ignore"` 装配，模型不匹配就静音跳过。

```text
create_deep_agent(...)
  -> 主代理 / GP 子代理 / 声明式子代理三个栈各追加一份缓存中间件
  -> 每轮模型调用前，中间件给请求打缓存标记
  -> ChatAnthropic / ChatBedrock / ChatBedrockConverse 在发请求时把标记展开
  -> Anthropic 的 cache_control 断点 / Bedrock Converse 的 cachePoint 块
```

标记打在什么位置，由中间件在栈里的顺序决定。常见字符串提示词配置下，缓存中间件先标记 Memory 之前的前缀，MemoryMiddleware 再标记注入后的内容。记忆快照变化时，前面未变的前缀仍有复用机会；实际命中取决于供应商的缓存条件。

## 三、先看问题：一轮请求里，什么每次都一样

一个 deep agent 跑起来，每轮发给模型的内容大致是三块：

```text
system prompt（基础提示词 + 自定义段 + 注入内容）        内容与注入状态稳定时相同
工具定义（write_todos、文件工具、task 等）              配置与可见性不变时相同
消息历史（用户消息、模型回复、工具调用与结果）           每轮变长
```

配置和注入内容稳定时，前两块会在多轮请求中重复。提示词缓存通过请求标记告诉供应商哪些前缀值得复用；相同前缀还要满足最小长度、有效期及服务端可用性等条件，才可能命中。标记存在不等于缓存已写入，更不能单凭标记计算节省的费用，应读取返回的缓存用量。

标位置的方式是供应商专有的。Anthropic 在内容块上挂一个 `cache_control` 字段，含这个字段的块及其之前的所有内容构成一段缓存前缀；Bedrock 的 Converse API 则是在消息数组里插一个 `cachePoint` 块，意思相同。两家都限制每请求最多 4 个显式标记。

所以缓存中间件真正要干的活只有一件：每轮请求发出前，把标记放到正确的位置。deepagents 不插手这件事，它只负责把供应商写好的中间件装到栈上。理解了这个分工，`graph.py` 里那几个函数就没有神秘感了。

提示词缓存复用的是供应商处理请求前缀的计算，不保存 Agent 的业务状态。Checkpointer 保存图状态与恢复位置，节点缓存复用节点结果，三者命中条件和生命周期不同；提示词缓存失效后，Agent 仍应能用完整请求继续执行。

## 四、deepagents 侧：探测、装配、静音

### 1. 为什么要运行时探测

打开 `libs/deepagents/pyproject.toml` 能看到依赖声明的不对称：`langchain-anthropic` 在 `dependencies` 里（硬依赖），`langchain-aws` 在 `[project.optional-dependencies]` 的 `aws` extra 里。硬依赖可以在模块顶层直接导入，`graph.py:24` 就是这么导入 `AnthropicPromptCachingMiddleware` 的。可选包不行：没装 aws 的用户一执行 `import deepagents` 就会撞上 `ModuleNotFoundError`。

所以 Bedrock 和 Fireworks 的中间件只能在运行时探测。`graph.py:251`：

```python
def _create_bedrock_prompt_caching_middleware() -> AgentMiddleware[Any, Any, Any] | None:
    module_name = "langchain_aws.middleware.prompt_caching"
    try:
        module = import_module(module_name)  # 运行时探测，不在模块顶层导入
    except ImportError as exc:
        # 只有 langchain_aws 自身缺失才静默降级；其余 ImportError 向外抛
        if exc.name not in {"langchain_aws", "langchain_aws.middleware", module_name}:
            raise
        logger.debug("Bedrock prompt caching middleware is unavailable.", exc_info=exc)
        return None
    middleware_cls = module.BedrockPromptCachingMiddleware
    return cast("AgentMiddleware[Any, Any, Any]", middleware_cls(unsupported_model_behavior="ignore"))
```

（省略了 docstring。`_create_fireworks_prompt_caching_middleware()` 在 `graph.py:265` 与它逐行同构，只换了模块名和类名。）

先看 `except` 里的白名单。`ImportError.name` 记录"哪个模块导入失败"。没装 `langchain-aws` 时，失败的就是 `langchain_aws` 这三个名字之一，静默返回 `None` 没问题。但如果 `langchain_aws` 装了、它的依赖 `boto3` 坏了，失败的模块名就是 `"boto3"`，这种情况必须让异常往外抛。否则用户拿到一个静默降级、实际配置错误的 agent，等运行到 Bedrock 才发现少了能力，排查起来反而绕远。

返回 `None` 而不是抛异常，是另一处分寸。"没装可选包"不是错误，是"功能未启用"，装配方会检查返回值再决定追加与否。

`unsupported_model_behavior="ignore"` 的取舍最隐蔽。deepagents 编译期不知道调用方会传什么模型，这个中间件又会被装进每个栈：用户传 `openai:gpt-5.5` 时，Bedrock 中间件的模型检查会拒绝这个请求，而拒绝时的默认行为是 `"warn"`，每轮模型调用弹一条 `UserWarning`，长对话里就是刷屏。`"ignore"` 让不匹配的请求静默直通。三个取值的差别：

| 取值 | 遇到不支持的模型 |
| --- | --- |
| `"ignore"` | 静默跳过，不打标 |
| `"warn"` | 每次请求弹 `UserWarning`，仍跳过 |
| `"raise"` | 抛 `ValueError`，中断 Agent |

（测试锁定：`test_graph.py:411` 锁"未安装时返回 `None`，且 `None` 不得混进 middleware 列表"；`test_graph.py:434` 用 `ImportError(name="missing_transitive")` 锁"白名单外的异常向外抛"。）

### 2. 装到哪三个栈

装配函数本身很简单：

```python
# libs/deepagents/deepagents/graph.py:279
def _append_prompt_caching_middleware(middleware: list[AgentMiddleware[Any, Any, Any]]) -> None:
    """追加供应商专用的提示词缓存中间件。"""
    middleware.append(AnthropicPromptCachingMiddleware(unsupported_model_behavior="ignore"))
    bedrock_middleware = _create_bedrock_prompt_caching_middleware()
    if bedrock_middleware is not None:  # 未安装 langchain-aws 时为 None，不入栈
        middleware.append(bedrock_middleware)
    fireworks_middleware = _create_fireworks_prompt_caching_middleware()
    if fireworks_middleware is not None:
        middleware.append(fireworks_middleware)
```

三个中间件按 Anthropic → Bedrock → Fireworks 的顺序追加，各自检查模型类型及支持条件。常规供应商客户端通常只命中对应的一项，因此列表里有多个缓存中间件不代表同一个请求会启用三套缓存。自定义包装模型还需检查其类型是否被识别。

调用点有三处：主代理栈（`graph.py:960`）、自动生成的 general-purpose 子代理栈（`graph.py:865`）、声明式 `SubAgent` 栈（`graph.py:781`）。为什么每个栈单独装一份？声明式子代理可以带自己的 `model` 字段（`graph.py:753` 的 `spec.get("model", model)`），主代理跑 Anthropic、子代理跑 Bedrock 是合法配置，缓存中间件必须跟着各自的模型走。

（测试锁定：`test_graph.py:362` 验证主代理与 GP 栈各拿到一份；`test_graph.py:382` 验证声明式子代理栈也拿到。）

## 五、标记打在哪：中间件顺序决定断点结构

先补一句背景。LangChain 在每次调用模型前，会让中间件栈上的 `wrap_model_call` 依次过一遍请求，每个中间件可以改写请求再放行（机制详见 [06：Middleware 增量总览](./06-middleware-increments.md)）。组合规则是"列表里排在前面的先改请求"：`factory.py` 的 `_chain_model_call_handlers()` docstring 写着 "Composes handlers so first in list becomes outermost layer"。

主代理栈的尾部顺序是：

```text
Profile.extra_middleware -> Prompt Caching -> MemoryMiddleware -> HumanInTheLoopMiddleware
```

于是每一轮请求被改写的顺序是：缓存中间件先拿到请求，给 system prompt 的最后一个内容块打上标记；Memory 中间件后拿到，把记忆块追加在标记后面，再给新的最后一块补上自己的标记。system prompt 最终长这样：

```text
system message 内容块：
  [ 静态前缀（prefix -> base -> suffix -> profile suffix）+ cache_control ]   <- 缓存中间件打标
  [ Memory 模板与文件内容块... ]
  [ Memory 最后块 + cache_control ]                                          <- MemoryMiddleware 打标
```

Memory 侧打标的代码在 `MemoryMiddleware.modify_request()`，只在请求的模型是 `ChatAnthropic` 时生效，所以对 Bedrock 等其他模型开着也无妨：

```python
# libs/deepagents/deepagents/middleware/memory.py:391（节选，注释有删减，内联注释为译者所加）
if (
    self._add_cache_control
    and isinstance(request.model, ChatAnthropic)  # 运行时判断模型，Bedrock/Vertex 包装不命中
    and new_system_message is not None
    and new_system_message.content_blocks
):
    blocks: list[ContentBlock] = list(new_system_message.content_blocks)
    last = blocks[-1]
    base = last if isinstance(last, dict) else {}
    blocks[-1] = {**base, "cache_control": {"type": "ephemeral"}}
    new_system_message = SystemMessage(content_blocks=blocks)
```

两个标记表示两个累计前缀，第二个前缀包含第一个，不是两段独立存储的文本。例如第一次请求为“固定说明 + Memory v1 + 历史”，下一次为“同一固定说明 + Memory v2 + 新历史”：到 Memory 末尾的前缀已经不同，但 Memory 之前未变的部分仍可能复用。`graph.py` 的注释表达的正是“记忆更新不使前面的 Anthropic 缓存前缀失效”这一装配意图。

这里的变化指实际请求注入的快照。仅编辑 Memory 文件，State 中的旧快照可能还没刷新，详见 [13](13-memory-middleware.md)。Skills 等更早的注入内容也位于前一个断点之内；这些内容变化时，就不能再把该前缀视为固定。命中与否仍由供应商判断。

一个前提要交代：上面的双断点描述假设 `final_system_prompt` 以纯字符串装配，由 Anthropic 中间件转成单块列表再打标。调用方传入 `SystemMessage` 段时，`_assemble_prompt_parts()` 会保留段内自带的 `cache_control`（见 [01：总装配](./01-create-deep-agent-assembly.md) 中“组装静态 system prompt”一节），断点数量由调用方的标记决定。

## 六、Anthropic 直连：中间件直接改 system 和 tools

看 Anthropic 中间件每轮做的事（`prompt_caching.py:119`）：

```python
def _apply_caching(self, request: ModelRequest) -> ModelRequest:
    overrides: dict[str, Any] = {}
    cache_control = self._cache_control  # {"type": "ephemeral", "ttl": "5m"}

    # 始终在 model_settings 顶层设置 cache_control。Anthropic 模型类按传输层
    # 展开成线上格式：直连 API 原样透传，Bedrock 传输则由 _get_request_payload
    # 展开成块级断点。
    overrides["model_settings"] = {
        **request.model_settings,
        "cache_control": cache_control,
    }

    system_message = _tag_system_message(request.system_message, cache_control)
    if system_message is not request.system_message:
        overrides["system_message"] = system_message

    tools = _tag_tools(request.tools, cache_control)
    if tools is not request.tools:
        overrides["tools"] = tools

    return request.override(**overrides)
```

工具侧只标最后一个。`_tag_tools()` 的 docstring 解释了原因：工具定义在请求里是连续的一整块，最后一个工具上的标记覆盖整组定义；Anthropic 又限制每请求最多 4 个显式标记，没有理由在每个工具上各放一个。（`_tag_system_message()` 和 `_tag_tools()` 的实现此处省略，两者都返回副本、不改原对象。）

消息历史尾部的断点不靠改消息，靠 `model_settings` 里那个键：ChatAnthropic 在发请求时把它翻译成消息尾部的缓存标记，直连 API 原样透传，走 Bedrock 时展开成块级断点。

这里能保持请求之间相互独立，依赖的是副本语义：`_tag_system_message()` 和 `_tag_tools()` 构造带标记的新值，再由 `request.override()` 替换本轮字段。system 和 tools 不作为普通消息历史保存，也不代表可以安全地原地修改共享工具对象。

## 七、Bedrock：中间件只传一个键，改写推迟到模型类

### 1. 为什么不直接改

Bedrock 需要在供应商消息格式中选择缓存位置。如果把标记原地写进 State 所引用的消息，或者把带标记消息提交回 State，标记就可能随检查点保留。源码选择把设置交给模型层，避免这条持久化路径；复制消息后仅改本轮视图是另一种实现方式，不能把任何消息改写都等同于写入检查点。

Bedrock 中间件只替换本轮请求的 `model_settings`（langchain-aws 1.7.6，`langchain_aws/middleware/prompt_caching.py:134`）：

```python
def wrap_model_call(self, request, handler):
    if self._should_apply_caching(request):
        # 通过 model_settings 传 cache_control，而不是修改消息。
        # 这防止 cache_control 跨轮在 checkpoint 中累积。
        # 模型类在 API 调用时应用它。
        new_model_settings = {
            **request.model_settings,
            "cache_control": self._get_cache_control_settings(),  # {"type": "ephemeral", "ttl": "5m"}
        }
        return handler(request.override(model_settings=new_model_settings))
    return handler(request)
```

插桩被推迟到模型类序列化请求的那一刻。标记从头到尾没有进过消息历史，它只是每轮重新计算的一个请求参数。

### 2. 什么模型才会打标

门控有两层（`_should_apply_caching()`，`prompt_caching.py:98`）。第一层 `isinstance(request.model, (ChatBedrock, ChatBedrockConverse))`，把非 Bedrock 模型挡掉；第二层查模型 ID：

```python
# langchain_aws/middleware/prompt_caching.py:36
def _is_supported_model(model) -> bool:
    model_id = (
        getattr(model, "base_model_id", None)
        or getattr(model, "model_id", "")
        or getattr(model, "model", "")
        or ""
    )
    # 本版本按这两个模型族的名称判断是否支持自动缓存标记。
    return any(name in model_id.lower() for name in ("anthropic", "amazon.nova"))
```

在本文的 langchain-aws 1.7.6 实现中，Meta、Mistral 等未匹配这两类名称的模型不会被该中间件自动打标；这段版本化白名单不能代表服务商此后的全部缓存能力。

### 3. Converse API 怎么插桩

`ChatBedrockConverse._apply_cache_points()`（`bedrock_converse.py:747`）在序列化请求时把设置展开成 Converse API 的 `{"cachePoint": {"type": "default"}}` 块。Converse 的 `type` 固定为 `"default"`，上一节传的 `"ephemeral"` 在这里被忽略；`ttl` 只在非 `"5m"` 且非 Nova 时写入（源码行为：Nova 一律不写 `ttl` 字段）。

插桩位置按价值从高到低排，总预算 `_MAX_CACHE_POINTS = 4`，请求里已有的手动 cachePoint 先占预算：

```python
# langchain_aws/chat_models/bedrock_converse.py:769（节选，省略类型与日志细节）
if not cache_control:
    return

manual_count = _count_cache_points(system, bedrock_messages, tools)
budget = _MAX_CACHE_POINTS - manual_count
if budget <= 0:
    # 请求已含 4 个 cachePoint（Bedrock 上限），跳过自动插桩
    return

# 价值最高的位置优先，剩余预算给后面的位置
if budget and system and not any(_is_cache_point(b) for b in system):
    system.append(cache_block)        # 1. system 末尾
    budget -= 1

if budget and bedrock_messages:
    ...                               # 2. 最后一条消息 content 末尾；Nova 且含 tool 块时跳过

if budget and tools and not is_nova and not any(_is_cache_point(t) for t in tools):
    tools.append(cache_block)         # 3. tools 数组末尾；Nova 跳过

# 4. Anthropic 系且无手动 cachePoint、消息数 >= 2 时，
#    在倒数第二条消息上补一个历史末尾断点（对应 AWS 文档的 Claude 简化缓存管理）
```

（第 2、4 步的完整条件判断此处省略，原文见 `bedrock_converse.py:798-846`。）

第 4 步只对 Anthropic 系模型生效，源码注释直接引用了 AWS 文档的 prompt-caching-simplified 小节：把整个对话历史的尾部做成一个可复用前缀。

走 InvokeModel 而不是 Converse 的 `ChatBedrock` 是另一套：序列化时把内容块上的 `cache_control` 规范成 `{"type": "ephemeral"}`（`bedrock.py:521`、`bedrock.py:664`），`_apply_cache_control_to_messages()`（`bedrock.py:849`）把断点落到最新一条消息的最后内容块，工具作为内容块前置以保留标记（`bedrock.py:1044`）。

## 八、两版对照

| | `AnthropicPromptCachingMiddleware` | `BedrockPromptCachingMiddleware` |
| --- | --- | --- |
| 改 system / tools | 是：最后块打标 | 否 |
| 消息尾部断点 | 经 `model_settings` 由 ChatAnthropic 展开 | 经 `model_settings` 由 Bedrock 模型类展开 |
| 门控 | `isinstance(request.model, ChatAnthropic)` | 两个 Bedrock 模型类 + 模型 ID 含 anthropic / amazon.nova |
| 供应商格式 | `cache_control` 断点 | Converse `cachePoint` / Invoke 的块级 `cache_control` |
| Memory 配合 | MemoryMiddleware 追加第二个断点 | 不打标，靠模型层自动插桩 |

两种实现都把缓存标记控制在请求生成过程：Anthropic 中间件构造字段副本，Bedrock 中间件让模型类在序列化时插入标记。检查点仍负责图状态；供应商缓存不会成为恢复状态的来源。

## 九、工程判断

排查缓存时需要保留四层证据，避免从“已安装包”直接跳到“已经省钱”：

| 层次 | 要观察的对象 | 能说明什么 |
| --- | --- | --- |
| 装配 | Agent 栈中的缓存中间件 | 集成是否被加载 |
| 条件判断 | 请求模型类型、模型 ID、适配器条件 | 当前请求是否进入打标分支 |
| 序列化 | API 请求中的 cache_control 或 cachePoint | 标记是否位于预期前缀、是否受已有标记预算影响 |
| 响应 | 供应商返回的缓存读取与写入用量 | 此次服务实际如何处理缓存 |

同一任务中工具集合、Skills 索引、Memory 快照或系统提示词变化，都可能改变前缀。先比较序列化后实际稳定的内容，再判断缓存有效期等供应商条件。不能只比较一段提示词字符串就断定整个缓存前缀未变。

可选集成的导入异常也应保留原因：目标包缺失可以跳过，包内部依赖损坏应继续抛出。`unsupported_model_behavior="ignore"` 适合通用装配默认值；业务若期望指定集成必须生效，可以在初始化与观测层核对实际匹配情况。

## 十、延伸阅读

**下层：LangChain / LangGraph**

- [LangChain 04：中间件控制面](../langchain/04-middleware-control-plane.md)——改写请求字段的 Hook 边界
- [LangChain 07：调用治理](../langchain/07-call-governance.md)——缓存命中与调用观测的关系

**本系列**

- [13：MemoryMiddleware](./13-memory-middleware.md)——动态内容为什么要排在缓存断点之后
- [01：`create_deep_agent()` 总装配](./01-create-deep-agent-assembly.md)——缓存中间件在栈上的插入位置

**上层：方法论与案例**

- [Agent 系统设计 03：上下文管理](../../../../notes/agent-system-design/03-view/agent-context-management.md)——稳定前缀与动态注入的分层
