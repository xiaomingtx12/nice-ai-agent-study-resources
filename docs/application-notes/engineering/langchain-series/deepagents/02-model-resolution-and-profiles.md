---
sidebar_position: 4
sidebar_label: 02 模型解析与 Profile
description: 沿真实源码追踪模型 spec、Provider Profile 和 Harness Profile，说明它们分别在哪里生效、如何合并以及最终如何进入 Agent 装配。
---

# Deep Agents 源码解析 02：模型解析与 Profile

## 源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/deepagents/`）。
>
> - 模型解析：`libs/deepagents/deepagents/_models.py` → `resolve_model()`、`get_model_identifier()`、`get_model_provider()`
> - Provider Profile：`libs/deepagents/deepagents/profiles/provider/provider_profiles.py` → `ProviderProfile`、`register_provider_profile()`、`get_provider_profile()`、`apply_provider_profile()`、`_merge_provider_profiles()`
> - Harness Profile：`libs/deepagents/deepagents/profiles/harness/harness_profiles.py` → `HarnessProfile`、`HarnessProfileConfig`、`register_harness_profile()`、`_get_harness_profile()`、`_harness_profile_for_model()`、`_merge_profiles()`
> - Harness Profile 提示词与 Middleware：`libs/deepagents/deepagents/profiles/harness/harness_profiles.py` → `_apply_profile_prompt()`、`materialize_extra_middleware()`
> - Profile 惰性加载：`libs/deepagents/deepagents/profiles/_builtin_profiles.py` → `_ensure_builtin_profiles_loaded()`、`_invoke_profile_plugins()`
> - Agent 消费 Harness Profile：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`、`_normalize_system_prompt()`、`_assemble_prompt_parts()`
> - Middleware 过滤：`libs/deepagents/deepagents/_excluded_middleware.py` → `_validate_excluded_middleware_config()`、`_apply_excluded_middleware()`、`_verify_excluded_middleware_coverage()`

## 先看完整链路

Deep Agents 里有两套同名概念容易混淆：

1. `ProviderProfile` 和 `HarnessProfile`，是 Deep Agents 自己的配置注册表；
2. LangChain Chat Model 的 `model.profile`，是模型能力元数据，例如上下文窗口、工具调用和多模态能力。

本文讲的是前者。它们解决的是“模型如何被创建”和“模型进入 Deep Agents 后如何运行”，不是模型能力元数据本身。

完整链路可以压缩成：

```text
model spec 或 BaseChatModel
  -> create_deep_agent()
      -> resolve_model()
          ├── 字符串 spec
          │   -> apply_provider_profile()
          │   -> init_chat_model()
          │   -> BaseChatModel
          └── 已构造 BaseChatModel
              -> 原样复用
      -> _harness_profile_for_model()
          -> HarnessProfile
      -> 消费 Profile 字段
          -> system prompt / tools / middleware / subagent
```

两套 Profile 的边界很清楚：

| 配置 | 解决什么问题 | 什么时候生效 |
| --- | --- | --- |
| `ProviderProfile` | 模型客户端如何初始化 | 字符串模型进入 `init_chat_model()` 之前 |
| `HarnessProfile` | Agent 如何组织提示词、工具和 Middleware | 模型对象构造完成后，`create_deep_agent()` 装配期间 |

换句话说，Provider Profile 改的是“模型是什么”；Harness Profile 改的是“这个模型在 Agent 里怎么工作”。

## 一、模型输入有两条路径

### 字符串模型：先应用 Provider Profile

`resolve_model()` 的分支很短：

```python
def resolve_model(model: str | BaseChatModel) -> BaseChatModel:
    if isinstance(model, BaseChatModel):
        # 调用方已经构造好模型，直接复用
        return model

    # 字符串模型先应用 Provider Profile，再创建 Chat Model
    return init_chat_model(model, **apply_provider_profile(model))
```

传入 `"openai:gpt-5.5"` 时，Deep Agents 会：

1. 从 Provider Profile 注册表读取模型构造配置；
2. 执行必要的 `pre_init` 检查；
3. 生成传给 `init_chat_model()` 的 kwargs；
4. 创建 `BaseChatModel`。

Provider Profile 只在这条字符串路径生效。它不会重新改写已经构造好的 Chat Model。

### 预构造模型：跳过 Provider Profile

如果调用方传入：

```python
model = ChatAnthropic(model="claude-sonnet-4-6")
agent = create_deep_agent(model=model)
```

`resolve_model()` 直接返回这个实例。`ProviderProfile.init_kwargs`、`pre_init` 和 `init_kwargs_factory` 都不会再次执行。

这条路径不是完全跳过 Profile 系统。模型对象后面仍然会参与 Harness Profile 反查，Deep Agents 会尝试从模型实例中读取模型标识和 Provider。

`create_deep_agent()` 会保留调用方传入的原始字符串：

```python
_model_spec = model if isinstance(model, str) else None

if model is None:
    model = _build_default_model()
else:
    model = resolve_model(model)

_profile = _harness_profile_for_model(model, _model_spec)
```

`_model_spec` 的作用是保留字符串模型的精确查找键。它为 `None` 时，说明当前模型是预构造实例，Harness Profile 必须走反查路径。

当前 0.6.12 仍支持 `model=None`，内部会构造 `ChatAnthropic(model_name="claude-sonnet-4-6")`，但这条默认模型路径已经标记为废弃。应用代码应显式选择模型，避免默认值变化影响 Agent 行为。

## 二、Provider Profile：只处理模型构造

`ProviderProfile` 是一个冻结的数据类，字段只有三个：

```python
@dataclass(frozen=True)
class ProviderProfile:
    init_kwargs: Mapping[str, Any] = field(default_factory=dict)
    pre_init: Callable[[str], None] | None = None
    init_kwargs_factory: Callable[[], dict[str, Any]] | None = None
```

三个字段分别进入不同阶段：

| 字段 | 执行时机 | 适合放什么 |
| --- | --- | --- |
| `init_kwargs` | 组合初始化参数时 | 固定的 `temperature`、`base_url`、`use_responses_api` |
| `pre_init` | `init_chat_model()` 之前 | 版本检查、凭证检查和其他前置校验 |
| `init_kwargs_factory` | 每次解析模型时 | 环境变量、租户配置和动态请求头 |

### 参数优先级

真正负责组合参数的是 `apply_provider_profile()`：

```python
def apply_provider_profile(
    spec: str,
    kwargs: Mapping[str, Any] | None = None,
    *,
    run_pre_init: bool = True,
) -> dict[str, Any]:
    base = dict(kwargs) if kwargs else {}
    profile = get_provider_profile(spec)
    if profile is None:
        return base

    if run_pre_init and profile.pre_init is not None:
        profile.pre_init(spec)

    merged = dict(profile.init_kwargs)
    if profile.init_kwargs_factory is not None:
        merged.update(profile.init_kwargs_factory())
    merged.update(base)
    return merged
```

参数优先级从低到高是：

```text
ProviderProfile.init_kwargs
  -> init_kwargs_factory()
  -> apply_provider_profile(..., kwargs=...)
```

`pre_init` 不参与字典合并，它在参数组合前执行。它抛出异常时，动态工厂不会执行，`init_chat_model()` 也不会被调用。

因此，调用方显式传入的 kwargs 可以覆盖 Profile 默认值：

```python
register_provider_profile(
    "openai",
    ProviderProfile(
        init_kwargs={"temperature": 0.2},
        init_kwargs_factory=lambda: {"base_url": os.environ["OPENAI_BASE_URL"]},
    ),
)

kwargs = apply_provider_profile(
    "openai:gpt-5.5",
    {"temperature": 0.7},
)
```

此时 `temperature` 使用调用方传入的 `0.7`，`base_url` 来自工厂。

### 为什么 `ProviderProfile` 要冻结参数

`@dataclass(frozen=True)` 只能阻止重新绑定属性，不能阻止内部字典被修改。源码在 `__post_init__()` 中做了两层保护：

```python
def __post_init__(self) -> None:
    if not isinstance(self.init_kwargs, MappingProxyType):
        object.__setattr__(
            self,
            "init_kwargs",
            MappingProxyType(dict(self.init_kwargs)),
        )
```

`dict(self.init_kwargs)` 切断调用方原始字典的引用，`MappingProxyType` 则让注册后的映射只读。

这不是形式上的不可变。Provider Profile 通常保存在进程级注册表中，多个 Agent 都可能读取它。如果外部字典仍能修改注册结果，同一个模型 spec 在不同时间解析出来的客户端参数就会发生漂移，而且没有注册动作可追踪。

## 三、Provider Profile 的注册与合并

### 两种注册键

Provider Profile 支持两种键：

```text
openai
openai:gpt-5.5
```

前者是 Provider 级默认，后者只针对一个具体模型。

查询 `openai:gpt-5.5` 时，`get_provider_profile()` 先看完整 spec，再看 Provider 前缀：

```python
exact = _PROVIDER_PROFILES.get(spec)
base = _PROVIDER_PROFILES.get(provider) if sep else None

if exact is not None and base is not None:
    return _merge_provider_profiles(base, exact)
if exact is not None:
    return exact
if base is not None:
    return base
return None
```

结果可以这样理解：

| 注册情况 | 结果 |
| --- | --- |
| 只有 `openai:gpt-5.5` | 使用模型级 Profile |
| 只有 `openai` | 使用 Provider 级 Profile |
| 两者都有 | Provider 级作为基础，模型级覆盖它 |
| `openai:` 或包含多个冒号 | 视为非法 spec，不查注册表 |

### 同一个键重复注册是叠加

`register_provider_profile()` 不是简单覆盖：

```python
existing = _PROVIDER_PROFILES.get(key)
if existing is not None:
    profile = _merge_provider_profiles(existing, profile)
_PROVIDER_PROFILES[key] = profile
```

例如内置 Profile 已经注册：

```python
ProviderProfile(
    init_kwargs={"use_responses_api": True},
)
```

用户再注册：

```python
register_provider_profile(
    "openai",
    ProviderProfile(init_kwargs={"temperature": 0}),
)
```

结果会同时保留两个字段：

```python
{
    "use_responses_api": True,
    "temperature": 0,
}
```

如果要覆盖已有值，必须显式提供同名键：

```python
register_provider_profile(
    "openai",
    ProviderProfile(init_kwargs={"use_responses_api": False}),
)
```

### 字段级合并规则

`_merge_provider_profiles()` 对三个字段分别处理：

| 字段 | 合并方式 |
| --- | --- |
| `init_kwargs` | 字典合并，后者覆盖同名键 |
| `pre_init` | 基础 Profile 先执行，模型级 Profile 后执行 |
| `init_kwargs_factory` | 两个工厂每次都执行，基础工厂先执行，后者覆盖同名结果 |

这意味着模型级 Profile 是“在 Provider 默认上加一层”，不是把 Provider Profile 整个替换掉。

例如：

```text
ProviderProfile("openai")
  init_kwargs = {"temperature": 0}
  pre_init = check_openai_version

ProviderProfile("openai:gpt-5.5")
  init_kwargs = {"reasoning_effort": "medium"}
  pre_init = check_gpt55_support
```

解析 `openai:gpt-5.5` 时：

```text
init_kwargs:
  temperature = 0
  reasoning_effort = "medium"

pre_init:
  check_openai_version(...)
  -> check_gpt55_support(...)
```

任一 `pre_init` 或工厂抛出异常，后续步骤都会停止。

## 四、Harness Profile：模型构造完成后再调整 Agent

`HarnessProfile` 描述的是 Deep Agents 如何使用已经构造好的模型：

```python
@dataclass(frozen=True)
class HarnessProfile:
    base_system_prompt: str | None = None
    system_prompt_suffix: str | None = None
    tool_description_overrides: Mapping[str, str] = field(default_factory=dict)
    excluded_tools: frozenset[str] = frozenset()
    excluded_middleware: frozenset[type[AgentMiddleware] | str] = frozenset()
    extra_middleware: Sequence[AgentMiddleware] | Callable[[], Sequence[AgentMiddleware]] = ()
    general_purpose_subagent: GeneralPurposeSubagentProfile | None = None
```

这些字段最终进入 `create_deep_agent()` 的不同装配位置：

| 字段 | 改变什么 |
| --- | --- |
| `base_system_prompt` | 替换 Deep Agents 的基础 system prompt |
| `system_prompt_suffix` | 在调用方 suffix 之后追加模型指引 |
| `tool_description_overrides` | 改写模型看到的工具描述 |
| `excluded_tools` | 过滤最终可见的工具 |
| `excluded_middleware` | 从已装配栈中过滤可排除的 Middleware |
| `extra_middleware` | 增加模型特定的 Middleware |
| `general_purpose_subagent` | 调整自动 `general-purpose` 子代理 |

这些字段不会传给 `init_chat_model()`。它们只有在模型对象已经准备好以后，才由 `create_deep_agent()` 消费。

### 提示词覆盖不是简单拼接

对于声明式子代理和默认 `general-purpose` 子代理，Profile 提示词由 `_apply_profile_prompt()` 处理：

```python
def _apply_profile_prompt(
    profile: HarnessProfile,
    base_prompt: str,
) -> str:
    prompt = (
        profile.base_system_prompt
        if profile.base_system_prompt is not None
        else base_prompt
    )
    if profile.system_prompt_suffix is not None:
        prompt = prompt + "\n\n" + profile.system_prompt_suffix
    return prompt
```

语义只有两层：

```text
base_system_prompt
  -> 替换当前 stack 的基础提示词

system_prompt_suffix
  -> 追加到结果末尾
```

主代理的 `system_prompt` 还支持 `prefix`、`base`、`suffix` 三段结构，因此由 `graph.py` 的 `_normalize_system_prompt()` 和 `_assemble_prompt_parts()` 负责更细的拼接。两者的覆盖原则相同，但实现入口不同：

- 主代理：调用方的 `system_prompt` 先被拆成结构化配置，再叠加 Harness Profile；
- 声明式子代理：Profile 直接覆盖或追加其 `system_prompt`；
- 默认 `general-purpose` 子代理：Profile 可以单独设置自己的 system prompt，且 GP 专属设置优先于主 Profile 的 `base_system_prompt`。

完整提示词装配见 [01：create_deep_agent() 总装配](./01-create-deep-agent-assembly.md)。

### 工具描述、工具排除和 Middleware 排除不是一回事

这三个配置的作用层次不同：

| 配置 | 改变什么 | 不改变什么 |
| --- | --- | --- |
| `tool_description_overrides` | 模型看到的工具说明 | 工具实现、参数校验和执行逻辑 |
| `excluded_tools` | 模型最终可见的工具集合 | Middleware 实例和底层工具实现 |
| `excluded_middleware` | 已装配的可选 Middleware | 受保护的脚手架 Middleware |

工具描述在装配早期改写：

```python
_tools = _apply_tool_description_overrides(
    tools,
    _profile.tool_description_overrides,
)
```

工具排除放到所有工具注入之后，由 `_ToolExclusionMiddleware` 统一处理：

```python
if _profile.excluded_tools:
    deepagent_middleware.append(
        _ToolExclusionMiddleware(
            excluded=_profile.excluded_tools,
        )
    )
```

所以 `excluded_tools={"execute"}` 可以同时过滤用户传入的 `execute` 和 Middleware 后续注入的同名工具。

`excluded_middleware` 按具体类或 Middleware 的 `.name` 匹配。它不能移除 `FilesystemMiddleware` 和 `SubAgentMiddleware`，因为这两个组件是 Deep Agents 的必需脚手架。想隐藏文件工具或 `task`，应分别使用 `excluded_tools`，或者关闭默认 `general-purpose` 子代理。

## 五、Harness Profile 的 `extra_middleware` 到底插在哪里

`extra_middleware` 是模型级扩展，适合放“只对某个模型或 Provider 有意义”的请求修补。例如工具调用格式兼容、推理标签清理或特定模型的重试策略。

它与调用方传入的 `middleware=` 不是同一个扩展点：

| 扩展方式 | 绑定对象 | 典型用途 |
| --- | --- | --- |
| `create_deep_agent(middleware=...)` | 当前这一个 Agent | 业务侧的日志、审批、限流或领域规则 |
| `HarnessProfile.extra_middleware` | 命中的模型 Profile | 随模型切换的兼容性修补 |

在主 Agent 中，`create_deep_agent()` 会先记录核心 Middleware 名称，再把 Profile 扩展加入栈：

```python
_main_core_names = {m.name for m in deepagent_middleware}
deepagent_middleware.extend(
    _profile.materialize_extra_middleware()
)
```

随后调用 `_apply_custom_middleware()` 合并用户 Middleware。新名称的用户 Middleware 会插入核心栈之后，因此最终关系是：

```text
核心 Middleware
  -> 用户新增 Middleware
  -> HarnessProfile.extra_middleware
  -> Prompt Caching / Memory / HITL
```

如果用户 Middleware 与已有 Middleware 同名，则原位替换。它不是简单地排在 Profile 扩展之后。

`materialize_extra_middleware()` 每次返回新列表；如果 `extra_middleware` 是工厂，工厂会在每次构造主 Agent、默认子代理或声明式同步子代理时重新生成实例，避免不同 Agent 栈共享可变 Middleware。

Profile 扩展只作用于 Deep Agents 自己会组装的运行栈：

- 主 Agent；
- 自动 `general-purpose` 子代理；
- 声明式同步子代理。

它不会注入 `CompiledSubAgent` 的已有 Runnable，也不会影响 `AsyncSubAgent` 连接的远程图。前者已经完成编译，后者的 Middleware 应在远程部署侧配置。

## 六、Harness Profile 如何匹配模型

### 字符串模型：原始 spec 直接查找

当调用方传入 `"openai:gpt-5.5"` 时，`create_deep_agent()` 把原始字符串保存在 `_model_spec`，随后调用：

```python
_profile = _harness_profile_for_model(model, _model_spec)
```

因为 `spec` 不为空，源码直接走：

```python
if spec is not None:
    return _get_harness_profile(spec) or HarnessProfile()
```

`_get_harness_profile()` 的顺序是：

```text
完整键：openai:gpt-5.5
  -> Provider 键：openai
  -> 空 HarnessProfile()
```

如果完整模型 Profile 和 Provider Profile 都存在，二者按字段合并，模型级值的优先级更高。

### 预构造模型：从实例反查 Provider 和标识

预构造模型没有原始 spec，源码需要从对象中提取两部分信息：

```python
identifier = get_model_identifier(model)
provider = get_model_provider(model)
```

模型标识兼容两个常见字段：

```python
def get_model_identifier(model: BaseChatModel) -> str | None:
    return _string_attr(model, "model_name") or _string_attr(model, "model")
```

Provider 则来自 LangChain 的追踪参数：

```python
def get_model_provider(model: BaseChatModel) -> str | None:
    try:
        ls_params = model._get_ls_params()
    except (AttributeError, TypeError, NotImplementedError):
        return None

    if not isinstance(ls_params, Mapping):
        return None

    provider = ls_params.get("ls_provider")
    return provider if isinstance(provider, str) and provider else None
```

拿到这两部分后，Harness Profile 按下面顺序查找：

```text
provider:identifier
  -> identifier（仅当 identifier 自己包含冒号）
  -> provider
  -> 空 HarnessProfile()
```

这里故意不把裸模型标识当作 Provider 键查找。假设某个内部代理的 `model_name` 恰好是 `"openai"`，它不应该因为这个名字碰巧和 Provider 键相同，就自动继承 OpenAI 的 Harness Profile。

这条反查路径对自定义模型有一个实际要求：模型最好能提供稳定的模型标识，并实现可用的 `_get_ls_params()`。否则模型本身可以正常调用，但 Harness Profile 可能匹配不到，源码会回退到空 Profile。

## 七、两套 Profile 的字段级合并

### Provider Profile：模型级覆盖 Provider 级

Provider Profile 的合并语义可以概括成：

```text
Provider Profile
  -> init_kwargs 合并
  -> pre_init 依次执行
  -> init_kwargs_factory 依次执行
Model Profile
  -> 同名字段覆盖
  -> 新字段追加
```

它的目标是让 Provider 提供安全默认值，具体模型只补充差异。例如所有 OpenAI 模型默认启用某项 API，只有某个模型需要额外的 `reasoning_effort`，就注册一个模型级 Profile。

### Harness Profile：不同字段采用不同合并规则

`_merge_profiles()` 不是统一的“后者覆盖前者”，而是按字段类型处理：

| 字段 | 合并规则 |
| --- | --- |
| `base_system_prompt` | 模型级非 `None` 值覆盖 Provider 级 |
| `system_prompt_suffix` | 模型级非 `None` 值覆盖 Provider 级 |
| `tool_description_overrides` | 字典合并，模型级同名键覆盖 |
| `excluded_tools` | 集合并集 |
| `excluded_middleware` | 集合并集 |
| `extra_middleware` | 按具体类型合并，同类型原位替换，新类型追加 |
| `general_purpose_subagent` | `enabled`、`description`、`system_prompt` 逐字段合并 |

其中集合使用并集非常重要。Provider Profile 排除了 `execute`，模型级 Profile 排除了 `grep`，最终两个工具都会被排除。模型级 Profile 不能通过传一个空集合“取消” Provider 级排除。

`general_purpose_subagent` 则允许模型级配置只修改一个字段。例如 Provider 级 Profile 关闭默认子代理，某个具体模型可以单独设置 `enabled=True` 重新打开它；未设置的 `description` 和 `system_prompt` 继续继承 Provider 级配置。

Middleware 合并按具体类型识别，不是按实例相等性识别：

```text
base:     [A, B]
override: [A_new, C]

结果:     [A_new, B, C]
```

这里 `A_new` 替换 `A` 的位置，`C` 追加到末尾。Profile 注册表因此可以安全地先提供一套通用 Middleware，再由模型级 Profile 替换其中一个实例的参数。

## 八、Profile 注册表的惰性加载

Provider Profile 和 Harness Profile 都通过注册表保存，但内置 Profile 不是在模块导入时一次性全部注册。第一次查询或注册时，入口会触发：

```text
_ensure_builtin_profiles_loaded()
  -> 内置 Provider Profile
  -> 内置 Harness Profile
  -> Provider Profile 插件
  -> Harness Profile 插件
```

惰性加载有两个工程作用：

- 普通导入不必立即初始化全部 Provider 集成；
- Profile 插件可以通过入口点被发现，而不需要调用方手动导入每个模块。

注册过程具备并发保护。一个线程负责引导加载，其他线程等待；初始化完成后，后续查询直接使用注册表。

注册失败的处理需要区分来源：

- Deep Agents 自己的内置 Profile 注册失败，应直接暴露；
- 第三方插件的加载或注册失败，源码记录日志并跳过，避免一个插件阻塞整个 Profile 系统。

调用方重复注册同一个键时，结果不是清空旧配置，而是进入前面介绍的字段级合并流程。

## 九、`HarnessProfileConfig` 与运行时 Profile

`HarnessProfileConfig` 是给 YAML/JSON 工作流准备的声明式子集：

```yaml
base_system_prompt: You are helpful.
system_prompt_suffix: Respond briefly.
excluded_tools:
  - execute
excluded_middleware:
  - SummarizationMiddleware
general_purpose_subagent:
  enabled: false
```

它可以直接传给 `register_harness_profile()`，注册时转换为运行时 `HarnessProfile`。

两者不能完全互换：

| 能力 | `HarnessProfileConfig` | `HarnessProfile` |
| --- | --- | --- |
| 提示词字符串 | 支持 | 支持 |
| 工具描述覆盖 | 支持 | 支持 |
| 工具和 Middleware 名称排除 | 支持字符串形式 | 支持字符串或类形式 |
| `general_purpose_subagent` | 支持 | 支持 |
| Middleware 实例 | 不支持 | 支持 |
| Middleware 工厂 | 不支持 | 支持 |
| 运行时类对象 | 不支持 | 支持 |

当前源码基线下，配置文件中的 `excluded_middleware` 只接受普通 Middleware 名称字符串，不接受 `module:Class` 类路径；类形式应直接使用运行时 `HarnessProfile`。这是一处容易被文档版本差异误导的地方，本文以 0.6.12 源码为准。

因此：

- 配置文件适合保存提示词、工具描述、排除项和默认子代理设置；
- 需要注入 Middleware 实例、工厂或精确类匹配时，应使用 Python 代码构造 `HarnessProfile`。

## 十、如何选择配置位置

可以按“配置影响的对象”判断：

| 需求 | 放在哪里 | 原因 |
| --- | --- | --- |
| 设置 `temperature`、`base_url`、`use_responses_api` | `ProviderProfile.init_kwargs` | 影响模型客户端构造 |
| 检查 Provider 版本或凭证 | `ProviderProfile.pre_init` | 必须在模型创建前失败 |
| 注入环境变量或租户参数 | `ProviderProfile.init_kwargs_factory` | 每次解析模型时读取 |
| 给某类模型追加工具使用规则 | `HarnessProfile.system_prompt_suffix` | 影响 Agent 提示词 |
| 改写 `task` 或 `ls` 的工具描述 | `HarnessProfile.tool_description_overrides` | 只改变模型看到的说明 |
| 隐藏 `execute` 或文件工具 | `HarnessProfile.excluded_tools` | 改变模型可见工具，不拆掉脚手架 |
| 关闭 `task` | `general_purpose_subagent.enabled=False`，且不传同步子代理 | 正确移除默认委派入口 |
| 替换模型兼容 Middleware | `HarnessProfile.extra_middleware` | 让适配逻辑跟着模型走 |
| 业务侧日志、审批或状态逻辑 | `create_deep_agent(middleware=...)` | 这是当前 Agent 的局部扩展 |
| 业务任务的动态上下文 | `system_prompt`、State 或 Backend | 不属于模型 Profile |

## 工程判断

两套 Profile 的价值不在于增加一层配置对象，而在于把两个变化频率不同的问题拆开：

- Provider 变化时，模型客户端的初始化参数跟着变化；
- Harness 变化时，提示词、工具和 Middleware 跟着模型变化。

例如 OpenAI 的模型级 Profile 可以为一个具体模型追加 `reasoning_effort`，而同一个模型的 Harness Profile 可以改写 `task` 描述或追加兼容 Middleware。前者只影响 `init_chat_model()`，后者只影响 Agent 装配。

读这部分源码时，最容易出现三个误判：

1. **把 Provider Profile 当成 Agent 行为配置。** 它只在字符串模型创建阶段生效。
2. **把 `model.profile` 当成 Deep Agents 的 Harness Profile。** 前者描述能力元数据，后者控制装配行为。
3. **把 Profile 注册理解成覆盖。** 同键注册和 Provider/模型双层匹配都采用字段级合并，集合还会取并集。

把这三条边界守住，后面阅读 `create_deep_agent()` 就不会把模型创建、模型识别和 Agent 运行配置混在一起。`create_deep_agent()` 先把模型变成可调用对象，再根据模型选择 Harness Profile，最后才把这些配置交给 Middleware 和 `create_agent()`。

**相关测试**：`tests/unit_tests/test_models.py` · `tests/unit_tests/test_harness_profiles.py` · `tests/unit_tests/test_nemotron_ultra_profile.py`
