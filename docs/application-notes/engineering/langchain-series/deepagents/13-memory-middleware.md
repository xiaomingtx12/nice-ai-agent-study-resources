---
sidebar_position: 15
sidebar_label: 13 MemoryMiddleware 与长期上下文装配
description: 从 Deep Agents 0.6.12 源码拆解记忆文件如何进入 Agent State、模型请求和长期存储。
---

# Deep Agents 源码解析 13：MemoryMiddleware 与长期上下文装配

## 源码定位

> **阅读基线**：Deep Agents 0.6.12（`libs/deepagents/`）。
>
> 本文以本地 0.6.12 源码为准，官方文档用于校准概念和工程边界。官方 API 会继续演进，复制代码前应重新核对对应版本。
>
> - 主代理装配：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`、`_append_prompt_caching_middleware()`
> - Memory 状态和请求改写：`libs/deepagents/deepagents/middleware/memory.py` → `MemoryState`、`MemoryMiddleware`、`before_agent()`、`abefore_agent()`、`modify_request()`、`_format_agent_memory()`
> - 文件工具：`libs/deepagents/deepagents/middleware/filesystem.py` → `read_file`、`edit_file`、`write_file`
> - Backend：`libs/deepagents/deepagents/backends/` → `state.py`、`store.py`、`composite.py`
> - Agent 请求协议：`libs/langchain_v1/langchain/agents/factory.py` → `model_node()`、`_chain_model_call_handlers()`
> - 请求类型：`libs/langchain_v1/langchain/agents/middleware/types.py` → `ModelRequest`、`ModelResponse`、`PrivateStateAttr`

## 先给结论

Deep Agents 的文件型记忆不是一个独立的“记忆数据库调用”，而是一条由三层组成的上下文管线：

```text
create_deep_agent(memory=[...])
  -> 装配 MemoryMiddleware
  -> before_agent() 通过 Backend 批量读取文件
  -> memory_contents 写入当前 Agent State
  -> modify_request() 将快照追加到 system message
  -> model_node() 把 system message 和 messages 交给模型
```

更新路径与加载路径分开：

```text
模型判断信息值得保存
  -> edit_file / write_file
  -> FilesystemMiddleware
  -> Backend.write() / Backend.edit()
  -> 文件被持久化
  -> 之后进入一个不含 memory_contents 的 Agent State 时重新加载
```

源码层最值得记住的是这些边界：

- `MemoryMiddleware` 负责加载、格式化和注入，不负责自动判断哪些信息值得保存；
- `memory_contents` 是当前 State 中的文件快照，不是 Backend 的实时查询；
- Memory 写入 `ModelRequest.system_message`，不会伪装成 `HumanMessage`、`AIMessage` 或 `ToolMessage`；
- `PrivateStateAttr` 控制 State 字段的输入输出 schema，不等于“永不进入 checkpoint”；
- `StateBackend` 的文件默认随图 State 存在，跨线程长期记忆需要 `StoreBackend`，多种生命周期通常用 `CompositeBackend` 路由；
- Prompt caching 只设置供应商缓存边界，不负责保存记忆，也不会触发记忆刷新。

官方文档将这套能力归为长期记忆：文件由 Agent 读写，Backend 决定存储位置和访问范围；对话历史和临时文件仍然属于短期 State。可对照 [Memory](https://docs.langchain.com/oss/python/deepagents/memory)、[Backends](https://docs.langchain.com/oss/python/deepagents/backends) 和 [Context engineering](https://docs.langchain.com/oss/python/deepagents/context-engineering)。

## 一、先区分四类上下文

### 1. 最终请求不是一段静态字符串

Deep Agents 的一次模型调用通常由多类信息共同组成：

| 来源 | 进入请求的方式 | 典型作用 |
| --- | --- | --- |
| 自定义和内置 system prompt | `create_deep_agent()` 装配后传给 `create_agent()` | 角色、规则、基础行为 |
| Memory | `MemoryMiddleware.modify_request()` 追加到 `system_message` | 项目约定、用户偏好、稳定事实 |
| Skills | `SkillsMiddleware` 先暴露索引，命中后按需读取 | 某类任务的流程和专业知识 |
| 工具提示 | Filesystem、SubAgent、权限等 Middleware 追加 | 工具使用规则和可用能力 |
| Runtime context | `invoke(context=...)` 进入 `ModelRequest.runtime` | 用户身份、权限、连接、请求级依赖 |
| 对话消息 | State 的 `messages` 进入 `ModelRequest.messages` | 当前会话和工具调用历史 |

这些来源的装配时机不同：

- system prompt 在创建图时组合基础文本；
- Memory 文件要等 Agent 入口 Hook 运行后才能读取；
- 工具结果要等工具执行后才进入消息 State；
- Runtime context 贯穿一次运行，但不会自动变成模型可见文本。

官方文档把 system prompt、memory、skills 和 tool prompts 归为 input context，把 `invoke()` 传入的配置归为 runtime context。这个分类有助于避免把“存储位置”“模型可见文本”和“运行时依赖”混成一件事。

### 2. `ModelRequest` 是请求视图，不是一条消息

`langchain` 的 `ModelRequest` 保存一次模型调用的完整输入：

```python
class ModelRequest(Generic[ContextT]):
    model: BaseChatModel
    messages: list[AnyMessage]  # 不包含 system message
    system_message: SystemMessage | None
    tool_choice: Any | None
    tools: list[BaseTool | dict[str, Any]]
    response_format: ResponseFormat[Any] | None
    state: AgentState[Any]
    runtime: Runtime[ContextT]
```

`model_node()` 先从当前 State 构造 `ModelRequest`：

```python
request = ModelRequest(
    model=model,
    tools=default_tools,
    system_message=system_message,
    response_format=initial_response_format,
    messages=state["messages"],
    tool_choice=None,
    state=state,
    runtime=runtime,
)
```

真正调用模型前，`_execute_model_sync()` 才把 system message 放到消息列表最前面：

```python
messages = request.messages
if request.system_message:
    messages = [request.system_message, *messages]

output = model_.invoke(messages)
```

所以 Memory 的准确落点是：

```text
State["memory_contents"]
  -> MemoryMiddleware.modify_request()
  -> ModelRequest.system_message
  -> _execute_model_sync()
  -> [system message, ...messages]
  -> model.invoke()
```

### 3. Runtime context 不会自动进入提示词

`invoke(context=...)` 传入的数据属于运行时依赖。它可以从 `ModelRequest.runtime.context` 读取，也可以从工具的 `ToolRuntime.context` 读取，但不会因为传入了 `context` 就自动出现在 system message：

```text
invoke(context=...)
  -> ModelRequest.runtime.context
  -> Middleware 或工具主动读取
  -> 必要时显式追加到 system message，或用于工具执行
```

例如，用户身份适合用于选择 Store namespace，API key 适合由连接对象或工具使用。二者都不应该因为进入 runtime context 就被拼进模型提示词。

## 二、`create_deep_agent()` 如何装配 MemoryMiddleware

### 1. `memory=None` 与 `memory=[]` 有不同语义

0.6.12 的核心分支是：

```python
backend = backend if backend is not None else StateBackend()

# 中间省略主 Agent 的其他 Middleware 装配
_append_prompt_caching_middleware(deepagent_middleware)

if memory is not None:
    deepagent_middleware.append(
        MemoryMiddleware(
            backend=backend,
            sources=memory,
            add_cache_control=True,
        )
    )
```

因此：

| 配置 | 结果 |
| --- | --- |
| `memory=None` | 不创建 `MemoryMiddleware` |
| `memory=[]` | 创建 `MemoryMiddleware`，入口写入空的 `memory_contents`，请求仍会追加 `(No memory loaded)` |
| `memory=["/user/AGENTS.md"]` | 按 `sources` 指定的顺序批量读取文件 |

`memory` 不是自动扫描开关。MemoryMiddleware 不会自己遍历所有目录，也不会自动寻找全部 `AGENTS.md`；调用方列出的路径才是读取范围。

### 2. 主 Agent 的 Middleware 尾部

主 Agent 的装配顺序可以概括为：

```text
TodoListMiddleware
SkillsMiddleware（配置 skills 时）
FilesystemMiddleware
SubAgentMiddleware（存在内联子代理时）
SummarizationMiddleware
PatchToolCallsMiddleware
AsyncSubAgentMiddleware（配置异步子代理时）
Profile 扩展 Middleware
Provider Prompt Caching Middleware
MemoryMiddleware（配置 memory 时）
HumanInTheLoopMiddleware（配置中断时）
ToolExclusionMiddleware（配置排除工具时）
```

这只是注册顺序，不代表所有 Hook 都在同一个节点执行。`create_agent()` 会分别收集：

- Middleware 提供的工具；
- Middleware 的 State schema；
- `before_agent()`、`before_model()` 等生命周期 Hook；
- `wrap_model_call()`、`wrap_tool_call()` 等包装 Hook。

Memory 对应的实现是：

| 组成部分 | Memory 的实现 |
| --- | --- |
| State schema | `MemoryState` |
| Agent 入口 Hook | `before_agent()` / `abefore_agent()` |
| 模型调用 Hook | `wrap_model_call()` / `awrap_model_call()` |
| 工具 | 不新增工具，复用 `FilesystemMiddleware` 的文件工具 |

### 3. 静态 system prompt 和动态 Memory 是两条路径

`create_deep_agent()` 先组合基础 prompt，再把它传给 `create_agent()`：

```python
cfg = _normalize_system_prompt(system_prompt)
prompt_parts = []

if cfg.get("prefix") is not None:
    prompt_parts.append(cfg["prefix"])
prompt_parts.append(
    _profile.base_system_prompt
    if _profile.base_system_prompt is not None
    else BASE_AGENT_PROMPT
)
if cfg.get("suffix") is not None:
    prompt_parts.append(cfg["suffix"])

final_system_prompt = _assemble_prompt_parts(prompt_parts)

return create_agent(
    model,
    system_prompt=final_system_prompt,
    tools=_tools,
    middleware=deepagent_middleware,
    checkpointer=checkpointer,
    store=store,
    cache=cache,
    state_schema=state_schema if state_schema is not None else DeepAgentState,
)
```

源码中的动态关系是：

```text
创建 Agent
  -> final_system_prompt、tools、middleware、state_schema

进入 Agent
  -> before_agent() 读取 memory 文件
  -> State 写入 memory_contents

每次模型调用
  -> model_node() 构造 ModelRequest
  -> Middleware 链依次修改 request
  -> 真实模型收到最终请求
```

因此，`final_system_prompt` 不能代表最终 system message。它只代表创建图时已知的静态部分；Memory 正文、工具提示和某些模型级改写要沿着 Middleware 请求链继续追踪。

## 三、`MemoryState`：先保存快照，再生成请求

### 1. `memory_contents` 保存什么

源码定义了一个只供 MemoryMiddleware 使用的 State 字段：

```python
class MemoryState(AgentState):
    memory_contents: NotRequired[
        Annotated[dict[str, str], PrivateStateAttr]
    ]


class MemoryStateUpdate(TypedDict):
    memory_contents: dict[str, str]
```

它保存“路径到原始正文”的映射：

```python
{
    "memory_contents": {
        "/user/AGENTS.md": "# User Preferences\n...",
        "/project/AGENTS.md": "# Project Rules\n...",
    }
}
```

Memory 不直接把正文追加到 `messages`，这样可以保留三个边界：

- 对话历史仍然只表示真实的用户、模型和工具消息；
- 文件正文与消息 State 分开管理；
- `modify_request()` 可以从同一份 State 快照重新生成当前模型请求；
- Middleware 的中间数据不需要暴露成 Agent 的普通输出。

### 2. `PrivateStateAttr` 不是持久化开关

`PrivateStateAttr` 来自 LangChain 的 State schema 工具，底层对应 `OmitFromSchema(input=True, output=True)`。它表达的是：

```text
这个字段属于 Middleware 内部实现
  -> 不作为普通 Agent 输入字段
  -> 不作为普通 Agent 输出字段
```

它不直接决定 checkpoint 是否保存该字段。State 是否能在后续调用中恢复，取决于图的 checkpoint、`thread_id` 和 State schema 的实际持久化路径；文件是否跨线程存在，则由 Backend 决定。

因此需要分开回答两个问题：

| 问题 | 负责组件 |
| --- | --- |
| 模型请求里是否能看到记忆 | `modify_request()` |
| 当前图状态里是否有快照 | `memory_contents` |
| 同一线程后续是否恢复快照 | Checkpointer + `thread_id` |
| 新线程是否能读取同一文件 | StoreBackend 的 Store + namespace |

## 四、`before_agent()`：从 Backend 批量加载记忆

### 1. `before_agent()` 是入口 Hook

`create_agent()` 会把实现了 `before_agent()` 的 Middleware 提取出来，生成入口节点，并按注册顺序连接：

```text
before_agent 节点
  -> before_model / model 节点
  -> 工具和模型循环
```

Memory 的文件读取发生在 Agent 入口，不会因为模型循环再次调用就自动重读。请求注入则发生在每次模型调用前：

```text
进入一个 State
  -> MemoryMiddleware.before_agent()
  -> State 写入 memory_contents
  -> model_node()
  -> MemoryMiddleware.wrap_model_call()
  -> 模型与工具循环
```

### 2. `memory_contents` 是加载哨兵

同步和异步入口的关键分支完全一致：

```python
if "memory_contents" in state:
    return None
```

判断的是“键是否存在”，不是字典是否为空：

```text
没有 memory_contents
  -> 访问 Backend
  -> 写入文件快照，哪怕结果是 {}

已有 memory_contents
  -> 返回 None
  -> 不重新读取 Backend
```

这带来一个重要后果：当前运行中如果 `edit_file` 更新了 Backend 文件，当前 State 的 `memory_contents` 仍可能是旧快照。下一轮模型调用会继续注入旧内容，直到进入一个不含这个字段的 State，或者业务代码显式更新它。

“重新开始一轮对话”不一定等于“重新加载”。如果继续使用同一个 `thread_id` 和 checkpointer，旧的 `memory_contents` 可能随 State 一起恢复；使用 StoreBackend 时，最稳定的跨线程刷新方式是让新线程从 Store 读取更新后的文件。

### 3. Backend 可以是实例，也可以是工厂

MemoryMiddleware 不直接调用 `open()`，而是通过 `_get_backend()` 解析 Backend：

```python
def _get_backend(
    self,
    state: MemoryState,
    runtime: Runtime,
    config: RunnableConfig,
) -> BackendProtocol:
    if callable(self._backend):
        tool_runtime = ToolRuntime(
            state=state,
            context=runtime.context,
            stream_writer=runtime.stream_writer,
            store=runtime.store,
            config=config,
            tool_call_id=None,
        )
        return _resolve_backend(self._backend, tool_runtime)
    return self._backend
```

工厂路径会被包装成 `ToolRuntime`，让 MemoryMiddleware 与文件工具共享 Backend 解析逻辑。传入的运行时依赖包括：

- 当前 State；
- `runtime.context`；
- `runtime.stream_writer`；
- `runtime.store`；
- 当前 Runnable config。

这样 Memory 的读取路径和 `read_file`、`edit_file` 的操作路径仍然处在同一个 Backend 视图中。

### 4. 多个来源一次读取

同步路径的核心代码：

```python
contents: dict[str, str] = {}
results = backend.download_files(list(self.sources))

for path, response in zip(self.sources, results, strict=True):
    if response.error is not None:
        if response.error == "file_not_found":
            continue
        raise ValueError(
            f"Failed to download {path}: {response.error}"
        )
    if response.content is not None:
        contents[path] = response.content.decode("utf-8")

return MemoryStateUpdate(memory_contents=contents)
```

这里有四个工程细节：

1. `download_files()` 一次接收所有来源，不是每个文件单独调用一次；
2. `zip(..., strict=True)` 要求响应数量和来源数量严格匹配；
3. 文件内容统一按 UTF-8 解码后进入 State；
4. 异步版本只把读取换成 `await backend.adownload_files(...)`，配对和错误处理保持一致。

### 5. 错误处理不是“全部忽略”

| Backend 返回 | 行为 |
| --- | --- |
| `file_not_found` | 跳过该来源 |
| 有正文 | UTF-8 解码并写入 `memory_contents` |
| 空字节串 | 写入空字符串，格式化阶段跳过该段 |
| 其他错误 | 抛出 `ValueError`，终止加载 |

因此，可选的 `AGENTS.md` 缺失不会阻止 Agent 启动；权限错误、Backend 故障和其他读取错误也不会被伪装成“没有记忆”。

## 五、`modify_request()`：把快照变成模型可见文本

### 1. `wrap_model_call()` 修改的是请求输入

MemoryMiddleware 的包装逻辑很小：

```python
def wrap_model_call(
    self,
    request: ModelRequest[ContextT],
    handler: Callable[
        [ModelRequest[ContextT]],
        ModelResponse[ResponseT],
    ],
) -> ModelResponse[ResponseT]:
    modified_request = self.modify_request(request)
    return handler(modified_request)
```

这里的 `ModelResponse` 是下游模型调用返回的响应封装。MemoryMiddleware 不改写响应，只改写传给 `handler` 的 `ModelRequest`。

```text
ModelRequest  -> Middleware 修改模型调用输入
ModelResponse -> Middleware 返回模型调用结果
```

### 2. `modify_request()` 只读 State，不读 Backend

核心数据流：

```text
request.state["memory_contents"]
  -> _format_agent_memory()
  -> agent_memory 文本
  -> append_to_system_message()
  -> request.override(system_message=...)
```

它不会：

- 再次读取 Backend；
- 向 `request.messages` 追加消息；
- 生成 `HumanMessage`、`AIMessage` 或 `ToolMessage`；
- 修改 `request.state["memory_contents"]`。

`request.override()` 返回新的请求对象，保留原请求不变。这是 Middleware 链中局部修改请求的标准方式。

### 3. `system_prompt=None` 只关闭注入，不关闭加载

MemoryMiddleware 支持：

```python
MemoryMiddleware(
    backend=backend,
    sources=["/user/AGENTS.md"],
    system_prompt=None,
)
```

此时：

- `before_agent()` 仍会读取文件；
- `state["memory_contents"]` 仍可能包含正文；
- `modify_request()` 不追加 Memory 模板；
- 如果启用了 `add_cache_control`，缓存断点逻辑仍可能执行。

自定义模板必须满足：

- 值是 `str` 或 `None`；
- 如果是字符串，包含 `{agent_memory}` 插槽。

缺少插槽会在构造阶段抛出 `ValueError`，让配置错误尽早暴露：

```python
MemoryMiddleware(
    backend=backend,
    sources=[],
    system_prompt="no slot here",
)
# ValueError: system_prompt must contain the `{agent_memory}` format slot
```

## 六、`_format_agent_memory()`：文件正文如何进入提示词

### 1. `sources` 同时决定读取顺序和注入顺序

源码重新遍历 `self.sources`，而不是依赖 `dict` 的插入顺序：

```python
sections = []
for path in self.sources:
    raw = contents.get(path)
    if not raw:
        continue

    stripped = _strip_html_comments(raw).rstrip()
    if not stripped:
        continue

    sections.append(f"{path}\n\n{stripped}")

memory_body = "\n\n".join(sections)
return template.format(agent_memory=memory_body)
```

因此，`sources` 决定：

- 批量读取时的路径顺序；
- 响应与路径的配对顺序；
- system message 中各记忆段落的出现顺序。

MemoryMiddleware 不会根据文件名自动计算“用户记忆优先于项目记忆”，也不提供冲突合并策略。多个文件的解释优先级只能由来源顺序、模板中的规则和模型对证据的判断共同形成。

### 2. HTML 注释只在注入前清理

源码使用：

```python
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _strip_html_comments(text: str) -> str:
    return _HTML_COMMENT_RE.sub("", text)
```

清理发生在模型请求生成阶段：

- `memory_contents` 保留 Backend 读取到的原始正文；
- HTML 注释不会被写回文件；
- 注释中的作者标记或机器标记不会暴露给模型。

如果文件只包含 HTML 注释，清理后没有有效正文，源码会跳过这个来源，不生成只有路径没有内容的空段落。

### 3. 空内容不是“不执行 Middleware”

没有可注入正文时，默认模板仍会收到：

```text
(No memory loaded)
```

可能触发这个结果的配置包括：

- `memory=[]`；
- 所有来源都不存在；
- 所有文件清理 HTML 注释后都为空。

这与 `system_prompt=None` 不同：

| 配置 | 是否加载 `memory_contents` | 是否追加模板 |
| --- | --- | --- |
| `memory=[]` | 是，结果为空字典 | 是 |
| 来源全部不存在 | 是，结果为空字典 | 是 |
| `system_prompt=None` | 是 | 否 |

## 七、Memory、Filesystem 和 Backend 的职责边界

### 1. 读取和写入不是同一个 Hook

MemoryMiddleware 没有 `edit_file`、`write_file` 工具，也没有自动保存用户反馈的回调。默认模板只是指导模型在确实需要持久化信息时调用文件工具。

写入链由 FilesystemMiddleware 驱动：

```text
模型判断信息值得保存
  -> edit_file / write_file
  -> FilesystemMiddleware 做工具参数和权限处理
  -> Backend.edit() / Backend.write()
  -> 文件被持久化
```

组件分工：

| 动作 | 组件 | 实现 |
| --- | --- | --- |
| 读取指定记忆文件 | MemoryMiddleware | `before_agent()` 调用 `download_files()` |
| 拼成模型可见文本 | MemoryMiddleware | `modify_request()` 追加 system message |
| 主动读取任意文件 | FilesystemMiddleware | `read_file` |
| 更新记忆文件 | FilesystemMiddleware | `edit_file`、`write_file` |
| 决定保存什么 | 模型、提示词和业务策略 | 不由 MemoryMiddleware 自动判断 |
| 允许或拒绝写入 | 权限、Backend、HITL | 由文件工具执行链决定 |

### 2. 当前轮写入不会自动刷新 Memory 快照

假设一轮运行开始时文件是旧版本：

```text
before_agent()
  -> memory_contents = 旧内容

模型调用 edit_file()
  -> Backend 中的文件变成新内容

下一次模型调用
  -> modify_request() 仍从 State 读取旧 memory_contents
```

这不是 Backend 没有写成功，而是两个数据通道没有自动同步：

```text
Backend 文件
  -> 负责持久化和后续读取

State["memory_contents"]
  -> 负责当前模型请求的注入快照
```

如果业务要求同一轮立即看到新记忆，需要显式更新 `memory_contents`，或设计一个重新进入加载入口的流程。单纯写入 Backend 不会触发 MemoryMiddleware 再次执行 `before_agent()`。

### 3. 三种记忆类型不要混为一谈

| 类型 | 保存内容 | 主要机制 | 是否自动被 MemoryMiddleware 加载 |
| --- | --- | --- | --- |
| 对话 / episodic memory | Human、AI、Tool 消息和线程过程 | `messages` + Checkpointer | 否 |
| 文件 / semantic memory | 用户偏好、稳定事实、项目约定 | Backend + `memory=[...]` | 是，配置后在入口加载 |
| 程序性 / procedural memory | 可复用的工作流和技能 | SkillsMiddleware | 否，按需加载 |

SummarizationMiddleware 处理消息历史和上下文压力，不会替 MemoryMiddleware 管理文件正文。Skills 也不是 Memory 的别名：Skill 的价值是延迟加载专业流程，Memory 的默认行为是把指定文件直接注入当前请求。

## 八、StateBackend、StoreBackend 与 CompositeBackend

### 1. Backend 决定“记忆存多久”

MemoryMiddleware 只依赖 Backend 协议，不关心底层是 State、Store、文件系统还是沙箱。文件是否跨线程、跨用户存在，由 Backend 和 namespace 决定。

| Backend | 可见范围 | 适用场景 |
| --- | --- | --- |
| `StateBackend` | 当前图 State；配合 checkpointer 可跨同一线程的多次调用 | 临时工作文件、短期上下文 |
| `StoreBackend` | LangGraph Store 的 namespace；跨线程 | 用户偏好、长期事实、共享知识 |
| `CompositeBackend` | 按路径前缀路由到不同 Backend | 临时工作区和长期记忆并存 |
| `FilesystemBackend` | 真实本地磁盘 | 受控本地开发，不适合作为 Web 服务的默认存储 |

### 2. `StateBackend` 的生命周期

`StateBackend` 把文件放进 LangGraph 图 State：

```text
thread-1 + checkpointer
  -> /draft.txt 可以在后续同线程调用中恢复

thread-2
  -> 看不到 thread-1 的 /draft.txt
```

要区分三个层次：

- 当前图执行内，Backend 可以读写 State；
- 跨多次调用，是否恢复这些文件依赖 checkpointer 和一致的 `thread_id`；
- 换线程后，StateBackend 文件不会自动成为共享长期记忆。

默认 Deep Agent 使用 `StateBackend()`。这适合临时草稿和中间产物，不适合直接承载跨用户的长期事实。

### 3. `StoreBackend` 的关键是 namespace

`StoreBackend` 适配 LangGraph Store，文件可以跨线程保存。真正决定隔离边界的不是“用了数据库”，而是 namespace：

```python
from deepagents import create_deep_agent
from deepagents.backends import StoreBackend
from langgraph.store.memory import InMemoryStore

agent = create_deep_agent(
    memory=["/memories/preferences.md"],
    backend=StoreBackend(
        namespace=lambda rt: (rt.server_info.user.identity,),
    ),
    store=InMemoryStore(),
)
```

这个例子使用部署运行时的用户身份做 namespace。独立脚本或本地测试没有 `rt.server_info.user` 时，应从经过校验的运行时 context 读取用户标识，并保持 namespace 工厂只返回安全的字符串元组。

几个范围的选择：

| namespace | 作用域 | 适用内容 |
| --- | --- | --- |
| `(assistant_id,)` | Agent 级共享 | Agent 的公共经验和角色设定 |
| `(user_id,)` | 用户级隔离 | 用户偏好、个人事实 |
| `(org_id,)` | 组织级共享 | 组织政策、合规要求 |
| `(assistant_id, user_id)` | Agent + 用户 | 同一部署中多个 Agent 的用户隔离 |

0.6.12 的 `StoreBackend` 仍兼容不显式传 `namespace` 的旧路径，但源码已经将这条路径标记为 deprecated。新代码应显式设置 namespace，避免依赖旧的 assistant metadata 推断。

`InMemoryStore` 适合测试和进程内运行。生产环境应替换成具备持久化能力的 Store，或使用部署平台提供的 Store；否则进程重启后内存中的数据不会保留。

### 4. `CompositeBackend` 是更实际的默认方案

临时文件和长期记忆通常不应该放在同一个存储范围里：

```python
from deepagents import create_deep_agent
from deepagents.backends import CompositeBackend, StateBackend, StoreBackend
from langgraph.store.memory import InMemoryStore

store = InMemoryStore()
backend = CompositeBackend(
    default=StateBackend(),
    routes={
        "/memories/": StoreBackend(
            namespace=lambda rt: (rt.server_info.user.identity,),
        ),
    },
)

agent = create_deep_agent(
    memory=["/memories/preferences.md"],
    backend=backend,
    store=store,
)
```

路径的存储范围由前缀决定：

```text
/draft.txt
  -> default StateBackend
  -> 当前线程范围

/memories/preferences.md
  -> /memories/ 路由
  -> StoreBackend
  -> 跨线程长期保存
```

`CompositeBackend` 会按最长路径前缀优先匹配路由。`/memories/team/` 和 `/memories/` 同时存在时，前者先匹配；匹配后，路由前缀会从传给子 Backend 的路径中剥离，返回结果时再补回虚拟路径前缀。

只配置 `StoreBackend` 也能工作，但会让临时文件、上下文卸载产物和长期记忆共享持久化边界。按路径隔离更容易控制成本、权限、清理和数据保留周期。

## 九、Prompt caching：只负责边界标记

### 1. Memory 的缓存标记

`create_deep_agent()` 创建 MemoryMiddleware 时传入 `add_cache_control=True`。MemoryMiddleware 只在以下条件同时满足时加标记：

- `request.model` 是 `ChatAnthropic`；
- `system_message` 存在；
- system message 至少有一个 content block。

它会给最终 system message 的最后一个 content block 添加：

```python
{"cache_control": {"type": "ephemeral"}}
```

这段逻辑的作用是设置 Anthropic 的缓存断点：

- 不压缩 Memory 正文；
- 不把正文复制进其他 State；
- 不保存一个独立的“记忆缓存”；
- 非 Anthropic 模型不会添加这个 Anthropic 专用字段；
- Bedrock 和 Vertex 包装模型不会因为“看起来像 Anthropic”而命中这个判断。

即使 `system_prompt=None`，只要请求仍有 system message 且满足模型条件，也可能添加缓存标记。因为“是否追加 Memory 模板”和“是否添加缓存断点”是两个判断。

### 2. Provider caching 与图缓存不是一回事

`create_deep_agent()` 还会装配 Provider-specific caching Middleware，例如 Anthropic、Bedrock 和 Fireworks 的实现。它们负责按供应商协议设置缓存字段，不负责保存 `MemoryState`。

`create_deep_agent(cache=cache)` 则是另一条路径，传给 `create_agent()` 的是图执行层缓存。可以这样区分：

| 机制 | 缓存对象 | 是否进入 State |
| --- | --- | --- |
| Provider Prompt Caching | 模型供应商侧的请求前缀或内容块 | 否 |
| Memory `cache_control` | Memory system message 的缓存边界 | `memory_contents` 仍然独立存在 |
| `cache=cache` | 图执行或节点结果 | 否 |
| Checkpointer | Agent State 和消息历史 | 是 |

文件更新后，Memory 快照和缓存前缀都可能变化。缓存标记不会让旧文件继续作为可信事实，也不会让当前 State 自动重新读取 Backend。

## 十、信任、权限与并发

### 1. 记忆文件是外部数据，不是隐藏指令

默认 `MEMORY_SYSTEM_PROMPT` 将正文包在：

```text
<agent_memory>
...
</agent_memory>
```

并明确提示模型：

- 文件内容可能过时、错误，或由其他人写入；
- 与用户请求、安全策略和工具验证结果冲突时，优先可信来源；
- 不要把 API key、access token、密码等凭据写入记忆；
- 需要持久化时通过文件工具更新，而不是把记忆当作不可见的系统指令执行。

这些是模型行为约束，不是权限隔离。真正的访问边界由 Backend、namespace、Filesystem permission 和运行环境决定。

### 2. 共享记忆需要默认按不可信输入处理

如果用户 A 能写入用户 B 也会读取的文件，A 可以把恶意指令写进共享记忆，下一次影响 B 的对话。

工程上可以这样处理：

- 用户偏好默认使用 `(user_id,)` namespace；
- 组织策略和合规文件默认只读；
- 对共享文件写入配置 Human-in-the-Loop 审批；
- 对共享文件做内容校验、审计和并发控制；
- 不把外部工具返回的未经验证文本直接写入共享 Memory；
- 禁止把凭据、token 和密码写入任何记忆文件。

0.6.12 已有权限和中断装配能力，可以按路径拒绝或暂停 `edit_file`、`write_file`。这比只在 prompt 里告诉模型“不要修改策略文件”可靠。

### 3. 并发写入是 Backend 层问题

多个线程可以同时写 StoreBackend 中的文件。同一个文件并发编辑时，可能出现后写覆盖先写的情况。MemoryMiddleware 不提供合并锁，也不会自动解决冲突。

可以按主题拆分文件，或把记忆更新放到独立的 consolidation agent 中串行处理。后台整合的代价是：更新完成前，新记忆不会出现在下一次入口加载中；优点是不会把整理成本放进用户请求的热路径。

## 十一、测试固定了哪些契约

对应测试文件：

```text
libs/deepagents/tests/unit_tests/middleware/test_memory_middleware.py
libs/deepagents/tests/unit_tests/middleware/test_memory_middleware_async.py
```

测试重点不是模型能不能“背下文件”，而是 Middleware 契约是否稳定：

| 契约 | 测试关注点 |
| --- | --- |
| 文件加载 | 单个来源、多个来源、同步和异步批量下载 |
| State 哨兵 | 已有 `memory_contents` 时跳过重新读取 |
| 缺失文件 | `file_not_found` 被跳过 |
| 其他错误 | 读取失败抛出 `ValueError` |
| 来源顺序 | system message 顺序与 `sources` 一致 |
| 格式化 | 路径和正文成对出现 |
| HTML 注释 | 单行、多行注释不会注入模型 |
| 空内容 | 输出 `(No memory loaded)` |
| 配置校验 | 非字符串模板和缺少 `{agent_memory}` 插槽时快速失败 |
| `system_prompt=None` | 跳过模板，但仍可加载 State |
| Anthropic 缓存 | 最后一个 content block 添加缓存标记 |
| 当前轮刷新边界 | Backend 写入不会自动更新 `memory_contents` |

这些测试把几个容易被错误重构破坏的行为固定下来：批量读取、顺序配对、加载哨兵、HTML 注释清理和“当前 State 不自动刷新”。

## 工程判断

MemoryMiddleware 适合承载“每次运行都应该参考”的文件型上下文：

- 项目约定；
- 用户偏好；
- 稳定的长期事实；
- 由应用程序维护的只读政策文件。

它不适合直接充当：

- 实时配置中心；
- 对话全文检索器；
- 权限系统；
- 高并发共享文档的冲突合并器；
- 未经筛选的外部资料仓库。

读源码时沿着这条链追踪：

```text
memory 参数
  -> MemoryMiddleware
  -> before_agent()
  -> Backend.download_files()
  -> State["memory_contents"]
  -> model_node()
  -> ModelRequest
  -> modify_request()
  -> system_message
  -> ModelResponse
```

写入则从另一条链追踪：

```text
edit_file / write_file
  -> FilesystemMiddleware
  -> Backend
  -> 持久化文件
  -> 后续不含 memory_contents 的 Agent State 才重新加载
```

这套拆分让四个问题分别落到正确的层：

| 问题 | 主要负责层 |
| --- | --- |
| 文件保存在哪里 | Backend |
| 模型什么时候看到 | MemoryMiddleware 的 `modify_request()` |
| 谁可以修改 | FilesystemMiddleware、权限和 HITL |
| 修改后何时刷新 | Agent State 生命周期与加载哨兵 |

### 相关测试

- `libs/deepagents/tests/unit_tests/middleware/test_memory_middleware.py`
- `libs/deepagents/tests/unit_tests/middleware/test_memory_middleware_async.py`

### 配套阅读

- [06：中间件增量与装配顺序](./06-middleware-increments.md)
- [07：SkillsMiddleware](./07-skills-middleware.md)
- [08：Filesystem 与权限](./08-filesystem-middleware-and-permissions.md)
- [10：Summarization 与上下文卸载](./10-summarization-and-context-offloading.md)
