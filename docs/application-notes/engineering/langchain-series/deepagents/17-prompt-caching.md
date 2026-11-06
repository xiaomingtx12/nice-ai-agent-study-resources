---
sidebar_position: 19
sidebar_label: 17 Prompt Caching 中间件与供应商缓存断点
description: 从 Deep Agents 0.6.12 源码拆解缓存断点的语义与命中条件、供应商中间件的装配与门控，以及 Anthropic 与 Bedrock 两侧把断点落到线上请求的位置。
---

# Deep Agents 源码解析 17：Prompt Caching 中间件与供应商缓存断点

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/deepagents/`）；供应商中间件取 PyPI 分发包：`langchain-anthropic` 1.5.2、`langchain-aws` 1.7.6（wheel 解包）；中间件组合逻辑对照 LangChain 1.3.14。源码版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 装配入口：`libs/deepagents/deepagents/graph.py` → `_create_bedrock_prompt_caching_middleware()`、`_create_fireworks_prompt_caching_middleware()`、`_append_prompt_caching_middleware()`、`create_deep_agent()`
> - 装配测试：`libs/deepagents/tests/unit_tests/test_graph.py` → `TestPromptCachingWiring`
> - Memory 断点：`libs/deepagents/deepagents/middleware/memory.py` → `wrap_model_call()`、`modify_request()`
> - Anthropic 中间件：`langchain_anthropic/middleware/prompt_caching.py` → `AnthropicPromptCachingMiddleware`；尾部断点翻译：`langchain_anthropic/chat_models.py` → `ChatAnthropic._get_request_payload()`
> - Bedrock 中间件：`langchain_aws/middleware/prompt_caching.py` → `BedrockPromptCachingMiddleware`；`langchain_aws/chat_models/bedrock_converse.py` → `ChatBedrockConverse._apply_cache_points()`
> - 组合顺序：`langchain/agents/factory.py` → `_chain_model_call_handlers()`

## 二、断点标记的是"缓存到哪里"，不是"缓存什么"

模型每轮请求都要重新处理全部输入 token。供应商发现两次请求的开头逐字节相同，就能复用上一次已经算过的部分，只对新增内容全价收费：写入缓存通常按略高于基础单价的费率计费（Anthropic 直连为 1.25 倍），命中读取按大幅折扣计费（Anthropic 直连约一折）。复用的单位是**前缀**——从请求第一个字节起，到某个位置为止的全部内容。

怎么告诉供应商"缓存到哪"？靠断点标记。Anthropic 在内容块上挂一个 `cache_control` 字段，Bedrock Converse 在消息数组里插一个 `cachePoint` 块，写法不同、语义相同：**从请求开头到这个块（含）为止的前缀值得保留**。断点是累计前缀的终点，不是文本的边界；同一请求里有两个断点，第二段前缀包含第一段，不是两份独立缓存。

断点按 `tools → system → messages` 的顺序链式累计：Bedrock 文档明确写出这个处理顺序，最小可缓存长度按断点前的累计 token 计算（按模型从 512 到 4096 不等），且前面一段变化会使后面全部失效。因此断点要放在稳定内容之后、变化内容之前——打早了，前缀里混进变化内容，每轮都失效；打晚了，稳定内容进不了缓存。每请求最多 4 个显式断点，两家相同。

命中还要满足三个条件：前缀逐字节一致（工具定义、系统提示词、消息内容都在比较范围内）、断点前累计长度达到最小值、在 TTL 内（`"5m"` 或 `"1h"`，命中会刷新计时）。Bedrock 上 Anthropic 与 Nova 另有隐式缓存，不写标记也能 best-effort 复用前缀；本文分析的中间件实现的是显式缓存。

由此可以划清一条界线：**标记存在 ≠ 缓存已写入 ≠ 已命中 ≠ 已省钱**。是否命中只能看响应的用量字段（Anthropic 直连 `usage` 里的 `cache_read_input_tokens` / `cache_creation_input_tokens`，Bedrock 的 `cacheReadInputTokens` / `cacheWriteInputTokens`）。

一个 deep agent 跑起来，每轮发给模型的内容是三块：

```text
system prompt（基础提示词 + 自定义段 + 注入内容）        内容与注入状态稳定时相同
工具定义（write_todos、文件工具、task 等）              配置与可见性不变时相同
消息历史（用户消息、模型回复、工具调用与结果）           每轮变长
```

前两块跨轮稳定，第三块只增不减——正好是断点想要的形状。整条链路要做的唯一一件事，就是把断点放到稳定与变化的边界上。

提示词缓存复用的是供应商处理前缀的计算，不保存 Agent 的业务状态。Checkpointer 保存图状态与恢复位置，节点缓存复用节点结果，三者命中条件和生命周期互不相同；提示词缓存失效后，Agent 仍能用完整请求继续执行，只是慢一点、贵一点。

## 三、四层分工：装配、打标、序列化、判定

提示词缓存在框架里被切成四层，每层只做自己有信息做的那件事：

```text
deepagents 装配     把供应商集成提供的缓存中间件装到栈上（graph.py）
供应商中间件打标    每轮模型调用前，给请求加标记或参数
聊天模型序列化      把标记展开成线上格式（cache_control 块 / cachePoint 块）
供应商判定          决定写入还是命中，结果反映在响应用量里
```

deepagents 不写任何缓存逻辑，只做第一层。装配有三个要点：

- Anthropic 的中间件直接导入：`langchain-anthropic` 是 `pyproject.toml` 里的硬依赖，装 deepagents 必有它（`graph.py:24`）。
- Bedrock 与 Fireworks 的中间件运行时探测：两者都在可选 extra 里，装了才追加（`graph.py:251`、`graph.py:265`）。
- 全部以 `unsupported_model_behavior="ignore"` 装配：模型不匹配时静默直通，取舍见第四节。

```text
create_deep_agent(...)
  -> 主代理 / GP 子代理 / 声明式子代理三个栈各追加一份缓存中间件
  -> 每轮模型调用前，中间件给请求打缓存标记
  -> ChatAnthropic / ChatBedrock / ChatBedrockConverse 在发请求时把标记展开
  -> Anthropic 的 cache_control 断点 / Bedrock Converse 的 cachePoint 块
```

## 四、deepagents 侧：探测、装配、静音

### 1、为什么运行时探测

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

`except` 里的白名单值得先看。`ImportError.name` 记录"哪个模块导入失败"。没装 `langchain-aws` 时，失败的就是 `langchain_aws` 这三个名字之一，静默返回 `None` 没问题。但如果 `langchain_aws` 装了、它的依赖 `boto3` 坏了，失败的模块名就是 `"boto3"`，这种情况必须让异常往外抛——否则用户拿到一个静默降级、实际配置错误的 agent，等运行到 Bedrock 才发现少了能力，排查反而绕远。

返回 `None` 而不是抛异常，是另一处分寸。"没装可选包"不是错误，是"功能未启用"，装配方会检查返回值再决定追加与否。

`unsupported_model_behavior="ignore"` 的取舍最隐蔽。deepagents 编译期不知道调用方会传什么模型，这个中间件又会被装进每个栈：用户传 `openai:gpt-5.5` 时，Bedrock 中间件的模型检查会拒绝这个请求，而拒绝时的默认行为是 `"warn"`，每轮模型调用弹一条 `UserWarning`，长对话里就是刷屏。`"ignore"` 让不匹配的请求静默直通。三个取值的差别：

| 取值 | 遇到不支持的模型 |
| --- | --- |
| `"ignore"` | 静默跳过，不打标 |
| `"warn"` | 每次请求弹 `UserWarning`，仍跳过 |
| `"raise"` | 抛 `ValueError`，中断 Agent |

（测试锁定：`test_graph.py:411` 锁"未安装时返回 `None`，且 `None` 不得混进 middleware 列表"；`test_graph.py:434` 用 `ImportError(name="missing_transitive")` 锁"白名单外的异常向外抛"。）

### 2、装到哪三个栈

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

三个中间件按 Anthropic → Bedrock → Fireworks 的顺序追加，各自检查模型类型及支持条件。常规供应商客户端只命中对应的一项，列表里有多个缓存中间件不代表同一个请求会启用三套缓存。自定义包装模型还需检查其类型是否被识别。

调用点有三处：主代理栈（`graph.py:960`）、自动生成的 general-purpose 子代理栈（`graph.py:865`）、声明式 `SubAgent` 栈（`graph.py:781`）。为什么每个栈单独装一份？声明式子代理可以带自己的 `model` 字段（`graph.py:753` 的 `spec.get("model", model)`），主代理跑 Anthropic、子代理跑 Bedrock 是合法配置，缓存中间件必须跟着各自的模型走。

（测试锁定：`test_graph.py:362` 验证主代理与 GP 栈各拿到一份；`test_graph.py:382` 验证声明式子代理栈也拿到。）

## 五、标记打在哪：钩子顺序与双断点的形成

### 1、组合规则：列表前面的中间件先改请求

LangChain 在每次模型调用前，把中间件栈上所有 `wrap_model_call` 钩子串成一条链，每个中间件可以改写请求再放行（机制详见 [06：Middleware 增量总览](./06-middleware-increments.md)）。组合规则写在 `factory.py` 的 `_chain_model_call_handlers()` docstring 里："Composes handlers so first in list becomes outermost layer"——列表排前面的中间件包在外层，先拿到请求；它放行之后，后面的中间件才见到（可能已被改写的）请求。

### 2、Memory 的注入与打标，也发生在 wrap_model_call 里

这是容易追断的一环，先把它接上。本文引用的 `MemoryMiddleware.modify_request()` **不是框架钩子**——LangChain 1.3.14 里没有这个名字的钩子，它是 deepagents 自己的私有方法，由 `MemoryMiddleware` 自己的 `wrap_model_call` 调用（`memory.py:409`）：

```python
# libs/deepagents/deepagents/middleware/memory.py:409（节选，省略类型与 docstring）
def wrap_model_call(self, request, handler):
    modified_request = self.modify_request(request)  # 注入 Memory、打标，都在这里
    return handler(modified_request)
```

`SkillsMiddleware` 同款（`skills.py:930` 的 `modify_request()`，同样由自己的 `wrap_model_call` 调用）。所以 Memory 相对缓存中间件的先后，完全由它在中间件列表里的位置决定，链式规则对它同样生效。

### 3、双断点：先说前提，再看结构

下面的双断点描述基于最常见的配置：`final_system_prompt` 以纯字符串装配，由 Anthropic 中间件转成单块列表再打标。调用方直接传 `SystemMessage` 段时，`_assemble_prompt_parts()` 会保留段内自带的 `cache_control`（见 [01：总装配](./01-create-deep-agent-assembly.md) 中"组装静态 system prompt"一节），断点数量由调用方的标记决定。

主代理栈的尾部顺序是：

```text
Profile.extra_middleware -> Prompt Caching -> MemoryMiddleware -> HumanInTheLoopMiddleware
```

按第一小节的组合规则，每轮请求的改写顺序是：缓存中间件先拿到请求，给 system prompt 的最后一个内容块挂 `cache_control`——此刻 Memory 还没注入，这个块就是静态前缀的终点；Memory 后拿到请求，把记忆块追加在已打标的块之后，再给新的最后一块补上自己的标记。system prompt 最终长这样：

```text
system message 内容块：
  [ 静态前缀（prefix -> base -> suffix -> profile suffix）+ cache_control ]   <- 缓存中间件打标
  [ Memory 模板与文件内容块... ]
  [ Memory 最后块 + cache_control ]                                          <- MemoryMiddleware 打标
```

对照第二节的语义：两个断点是两段嵌套的累计前缀。第一次请求为"固定说明 + Memory v1 + 历史"，下一次为"同一固定说明 + Memory v2 + 新历史"——到 Memory 末尾的前缀已经不同，第二个断点失效；但 Memory 之前未变的部分仍受第一个断点保护。`graph.py:956` 的装配注释写明的正是这一意图：profile 中间件夹在核心中间件与 Memory 之间，"memory updates (which change the system prompt) don't invalidate the Anthropic prompt cache prefix"（记忆更新不使前面的 Anthropic 缓存前缀失效）。

Memory 侧打标的代码在 `modify_request()` 里，只在请求的模型是 `ChatAnthropic` 时生效，所以对 Bedrock 等其他模型开着也无妨（`graph.py:962` 的装配注释同样写明）：

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

两个边界要交代。其一，"Memory 变化"指实际注入的快照：仅编辑 Memory 文件，State 中的旧快照可能还没刷新，详见 [13](13-memory-middleware.md)。其二，Skills 等更早的注入内容位于第一个断点之内，这些内容变化时，第一个断点保护的前缀同样失效。

## 六、Anthropic 直连：中间件改 system 和 tools，模型类翻译尾部断点

### 1、中间件每轮做的事

`AnthropicPromptCachingMiddleware` 的核心是 `_apply_caching()`（`prompt_caching.py:122`），每轮做三件事：给 system prompt 的最后内容块打标、给最后一个工具打标、在 `model_settings` 顶层放一个 `cache_control` 键：

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

入口 `wrap_model_call()` 先过门控 `_should_apply_caching()`（`prompt_caching.py:92`）：模型不是 `ChatAnthropic` 就按 `unsupported_model_behavior` 处理；是则再看消息数是否达到 `min_messages_to_cache`（默认 0，即总是打标）。`_tag_system_message()` 把字符串 system prompt 转成单块列表再给最后一块打标——第五节"纯字符串前提"说的转换就发生在这里。

### 2、工具只标最后一个

`_tag_tools()` 只给最后一个工具打标。它的 docstring 解释了原因：工具定义在请求里是连续的一整块，最后一个工具上的断点把整组工具定义都收进缓存前缀；Anthropic 又限制每请求最多 4 个显式断点，没有理由在每个工具上各放一个。

### 3、消息尾部断点：同一个参数，两种展开

`model_settings` 里那个 `cache_control` 键怎么变成消息历史的尾部断点，由 `ChatAnthropic._get_request_payload()`（`chat_models.py:1338`）决定，按传输分两支：

```python
# langchain_anthropic/chat_models.py:1376（节选，注释译自原文，省略告警细节）
# 只有直连 Anthropic API 接受顶层 cache_control 参数。经其他传输
# （如 Bedrock）的子类要把 cache_control 参数展开成块级断点——
# 那些传输只接受这种形式。
if not _is_direct_anthropic_llm_type(getattr(self, "_llm_type", None)):
    cache_control = kwargs.pop("cache_control", None)
    if cache_control and formatted_messages:
        applied = _apply_cache_control_to_last_eligible_block(
            formatted_messages, cache_control, code_execution_tool_ids
        )
```

- **直连**（`_llm_type == "anthropic-chat"`）：`cache_control` 原样留在请求参数里发给 Anthropic API。顶层 `cache_control` 是直连 API 特有的参数，服务端把它解释为消息历史末尾的断点。
- **非直连子类**（经 Bedrock 等传输）：顶层参数不被接受，客户端自己展开。`_apply_cache_control_to_last_eligible_block()`（`chat_models.py:839`）从最新消息往回找第一个能挂断点的块挂上去，跳过 code_execution 相关块（Anthropic 拒绝在那上面挂断点）；一个可挂的块都找不到时告警并丢弃该参数。

### 4、副本语义：标记不跨轮累积

`_tag_system_message()` 和 `_tag_tools()` 都构造带标记的新值（后者用 `model_copy` 复制最后一个工具，不改共享的工具对象），再由 `request.override()` 替换本轮字段。system 和 tools 不作为消息历史保存，标记每轮重打一次，不会在请求之间或检查点里累积。

### 5、数一数：一轮请求正好用满四个断点

把三条打标路径合起来，一个开着 Memory 的 ChatAnthropic 请求携带：工具末尾 1 个（第 1 小节）、system 静态前缀末尾 1 个（第 1 小节）、system+Memory 末尾 1 个（第五节）、消息历史末尾 1 个（第 3 小节）——正好 4 个，即两家共同的每请求上限。这也是工具只标最后一个、Memory 只标最后一块的原因：断点预算本来就紧。

## 七、Bedrock：中间件只传一个键，插桩推迟到模型类

### 1、为什么推迟到模型类

Bedrock 的中间件不改 system、不改 tools、不改消息，只往 `model_settings` 里放一个键。推迟的理由有主次两条：

- **插桩需要的信息只在模型类里**（主因）。Converse 的 `cachePoint` 要插进供应商格式的 system、messages、tools 数组；插之前要数清请求里已有的手动 cachePoint、执行"每请求最多 4 个"的预算、按模型族跳过不支持的位置。这些判断都发生在序列化时刻——中间件层拿到的还是 LangChain 消息，没有这些信息。
- **附带的好处：标记从不进入消息历史**。`cache_control` 只是每轮重新计算的一个请求参数，不会随检查点留存。langchain-aws 源码注释写的正是这条："Pass cache_control through model_settings instead of modifying messages. This prevents cache_control from accumulating in checkpoints across turns."

复制消息后只改本轮视图是另一条可行路线（Anthropic 侧的 `_tag_*` 就是这么做的），同样不会写入检查点。所以"避免检查点累积"是这条实现的附带收益，不是它区别于替代方案的本质理由；本质理由是插桩信息在模型类。

### 2、中间件与门控

中间件只替换本轮请求的 `model_settings`（`langchain_aws/middleware/prompt_caching.py:134`）：

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

门控 `_should_apply_caching()`（`prompt_caching.py:98`）有两层。第一层 `isinstance(request.model, (ChatBedrock, ChatBedrockConverse))` 把非 Bedrock 模型挡掉；第二层查模型 ID：

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

### 3、Converse 怎么插桩

`ChatBedrockConverse._apply_cache_points()`（`bedrock_converse.py:747`）在序列化请求时把设置展开成 Converse 的 `{"cachePoint": {"type": "default"}}` 块。`type` 固定为 `"default"`，上一节传的 `"ephemeral"` 在这里被忽略；`ttl` 只在非 `"5m"` 且非 Nova 时写入（Nova 一律不写，且 AWS 模型表里 Nova 的断点只支持 system 与 messages 两个字段）。预算 `_MAX_CACHE_POINTS = 4`（`bedrock_converse.py:123`），请求里已有的手动 cachePoint 先扣预算：

```python
# langchain_aws/chat_models/bedrock_converse.py:769（节选，注释译自原文，省略日志与类型细节）
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

if budget and bedrock_messages:       # 2. 最后一条消息 content 末尾；
    ...                               #    Nova 且该消息含 toolUse/toolResult 块时跳过

if budget and tools and not is_nova and not any(_is_cache_point(t) for t in tools):
    tools.append(cache_block)         # 3. tools 数组末尾；Nova 跳过

if (budget and is_anthropic and not is_nova
        and manual_count == 0 and len(bedrock_messages) >= 2):
    ...                               # 4. 倒数第二条消息 content 末尾
```

四个位置的价值排序可以用第二节的链式顺序（`tools → system → messages`）解释：

- **system 末尾**：覆盖 tools+system 段。agent 每轮增长的只有消息，这段几乎每轮都命中，是收益最长的前缀。
- **最后一条消息末尾**：把截至本轮的全部内容变成断点。下一轮请求恰好在它后面追加新消息，整段前缀可复用——agent 循环里收益最直接的位置。
- **tools 末尾**：单独保护工具段。即使 system 变化（如 Memory 更新），工具段仍可命中。
- **倒数第二条消息**（仅 Anthropic 系、请求无任何手动标记、消息数 ≥ 2 时）：对应 AWS 文档的 Claude 简化缓存管理——最后一条消息是本轮新增的动态内容，断点放在它之前才是稳定边界；简化模式下服务端还会从断点往回约 20 个内容块自动找最长匹配前缀。

### 4、InvokeModel 的 ChatBedrock 是另一套

走 InvokeModel 而不是 Converse 的 `ChatBedrock` 用 Anthropic 原生格式：序列化时把内容块上的 `cache_control` 规范成 `{"type": "ephemeral"}`（`bedrock.py:521`、`bedrock.py:664`），`_apply_cache_control_to_messages()`（`bedrock.py:849`）把断点落到最新一条消息的最后内容块，工具作为内容块前置以保留标记（`bedrock.py:1044`）。

## 八、两版对照

| | `AnthropicPromptCachingMiddleware` | `BedrockPromptCachingMiddleware` |
| --- | --- | --- |
| 改 system / tools | 是：最后块打标 | 否 |
| 消息尾部断点 | 经 `model_settings` 由 ChatAnthropic 展开 | 经 `model_settings` 由 Bedrock 模型类展开 |
| 门控 | `isinstance(request.model, ChatAnthropic)` | 两个 Bedrock 模型类 + 模型 ID 含 anthropic / amazon.nova |
| 供应商格式 | `cache_control` 断点 | Converse `cachePoint` / Invoke 的块级 `cache_control` |
| 断点数量 | 工具、system 静态段、system+Memory、消息尾各 1 个 | 模型类按预算自动插，最多 4 处 |
| Memory 配合 | MemoryMiddleware 追加第二个 system 断点 | 不打标，靠模型层自动插桩 |

两种实现都把缓存标记控制在请求生成过程：Anthropic 中间件构造字段副本，Bedrock 中间件让模型类在序列化时插入标记。检查点仍负责图状态；供应商缓存不会成为恢复状态的来源。

## 九、工程判断

排查缓存时需要保留四层证据，避免从"已安装包"直接跳到"已经省钱"：

| 层次 | 要观察的对象 | 能说明什么 |
| --- | --- | --- |
| 装配 | Agent 栈中的缓存中间件 | 集成是否被加载 |
| 条件判断 | 请求模型类型、模型 ID、适配器条件 | 当前请求是否进入打标分支 |
| 序列化 | API 请求中的 cache_control 或 cachePoint | 标记是否位于预期前缀、是否受已有标记预算影响 |
| 响应 | 供应商返回的缓存读取与写入用量 | 此次服务实际如何处理缓存 |

同一任务中工具集合、Skills 索引、Memory 快照或系统提示词变化，都会改变前缀。先比较序列化后实际稳定的内容，再判断缓存有效期等供应商条件；不能只比较一段提示词字符串就断定整个缓存前缀未变。

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
