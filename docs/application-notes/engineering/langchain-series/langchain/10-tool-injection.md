---
sidebar_position: 12
sidebar_label: 10 工具注入面：Todo、Shell 与文件搜索
description: 对照 Todo、Shell 和文件搜索中间件的源码，拆开工具声明、State 注入、运行时资源和执行约束。
---

# LangChain 源码 10：工具注入面——Todo、Shell 与文件搜索

## 源码定位

> **阅读基线**：`langchain` 1.3.7（`libs/langchain_v1/`）。
>
> **核心路径**：
>
> - Todo 工具、规划 State、系统提示和并行调用校验：`langchain/agents/middleware/todo.py`。
> - 持久 Shell 会话、工具运行时、生命周期和输出处理：`langchain/agents/middleware/shell_tool.py`。
> - Host、Docker、Codex Sandbox 三种执行策略：`langchain/agents/middleware/_execution.py`。
> - 虚拟路径、glob/grep 搜索和 ripgrep 回退：`langchain/agents/middleware/file_search.py`。
> - `AgentState`、`PrivateStateAttr` 和 `OmitFromInput`：`langchain/agents/middleware/types.py`。

## 先记住一条判断

“给 Agent 加一个工具”至少包含四个问题：

1. 模型能调用什么函数？
2. 工具执行时需要读取或更新哪些 State？
3. 工具依赖的进程、文件或连接由谁创建和销毁？
4. 工具输出是否需要超时、大小和隐私约束？

三个中间件的实现重量不同：

| 中间件 | 注入内容 | 是否扩展 State | 主要约束 |
| --- | --- | --- | --- |
| `TodoListMiddleware` | `write_todos` | `todos` | 一轮最多更新一次整张清单 |
| `ShellToolMiddleware` | `shell` | 私有会话资源 | 会话生命周期、超时、输出上限和执行隔离 |
| `FilesystemFileSearchMiddleware` | `glob_search`、`grep_search` | 否 | 根目录约束、文件大小和搜索后端回退 |

所以，工具注入不是把函数追加到 `tools` 数组就结束。工具还可能需要状态字段、生命周期 Hook、运行时上下文和执行策略。

## 一、Todo：工具、规划 State 和使用提示

`TodoListMiddleware` 是最容易看懂的一种工具注入：它添加一个 `write_todos` 工具，同时把 Todo 列表挂进 Agent State。

### 1. `todos` 是输出状态，不是模型输入

源码先定义 Todo 条目和规划 State：

源码：`todo.py:25-43`

```python
class Todo(TypedDict):
    """单条 Todo 项。"""

    content: str
    """Todo 项的内容或描述。"""

    status: Literal["pending", "in_progress", "completed"]
    """Todo 项的当前状态。"""


class PlanningState(AgentState[ResponseT]):
    """Todo 中间件使用的 State 扩展。"""

    todos: Annotated[NotRequired[list[Todo]], OmitFromInput]
    """用于跟踪任务进度的 Todo 列表。"""
```

`OmitFromInput` 的含义是：`todos` 可以出现在 Agent 的输出 State 中，但不会作为下一次 Agent 输入 State 的必需字段。它解决的是 State Schema（状态结构）和模型输入之间的边界，不是把 Todo 从系统中删除。

这一区分很重要：

- Todo 列表需要被检查点和调用方读取，因此要进入输出。
- 模型不需要每次都从输入 State 接收同一个字段，因此可以标记为不进入输入。
- 工具执行时仍然可以通过 `Command` 更新它。

### 2. 工具调用同时更新 State 和消息历史

动态工具的实际函数是 `_write_todos`：

源码：`todo.py:152-164`

```python
def _write_todos(
    runtime: ToolRuntime[ContextT, PlanningState[ResponseT]], todos: list[Todo]
) -> Command[Any]:
    """创建并管理当前工作会话的结构化任务列表。"""
    return Command(
        update={
            "todos": todos,
            "messages": [
                ToolMessage(
                    f"Updated todo list to {todos}",
                    tool_call_id=runtime.tool_call_id,
                )
            ],
        }
    )
```

这里有两个独立更新：

- `"todos": todos` 更新规划状态；
- `"messages": [...]` 写入对应的 `ToolMessage`，让消息协议知道这次工具调用已经有结果。

`runtime.tool_call_id` 来自 `ToolRuntime`（工具运行时），不是模型传入的普通业务参数。它用于把工具结果和 `AIMessage.tool_calls` 中的调用 ID 配对。

因此，`Command` 不是“工具返回一段文本”的另一种写法，而是工具节点向图运行时提交 State 更新的载体。

### 3. 工具描述本身参与模型决策

构造函数把自定义描述放进 `StructuredTool`：

源码：`todo.py:201-229`

```python
class TodoListMiddleware(AgentMiddleware[PlanningState[ResponseT], ContextT, ResponseT]):
    """为 Agent 提供 Todo 列表管理能力的中间件。"""

    state_schema = PlanningState

    def __init__(
        self,
        *,
        system_prompt: str = WRITE_TODOS_SYSTEM_PROMPT,
        tool_description: str = WRITE_TODOS_TOOL_DESCRIPTION,
    ) -> None:
        super().__init__()
        self.system_prompt = system_prompt
        self.tool_description = tool_description

        self.tools = [
            StructuredTool.from_function(
                name="write_todos",
                description=tool_description,
                func=_write_todos,
                coroutine=_awrite_todos,
                args_schema=WriteTodosInput,
                infer_schema=False,
            )
        ]
```

源码中的 `WRITE_TODOS_TOOL_DESCRIPTION` 不是一句短描述，而是完整的使用规则：什么时候使用、什么时候跳过、何时标记 `in_progress`、何时标记 `completed`。这说明工具描述是模型决策输入的一部分，不能只把它当成文档字段。

但只靠描述不能保证约束。模型仍可能在同一轮并行调用两次 `write_todos`。

### 4. `wrap_model_call` 注入额外提示，`after_model` 做硬校验

Todo 提示通过 `request.override()` 追加到系统消息：

源码：`todo.py:231-256`

```python
def wrap_model_call(
    self,
    request: ModelRequest[ContextT],
    handler: Callable[[ModelRequest[ContextT]], ModelResponse[ResponseT]],
) -> ModelResponse[ResponseT] | AIMessage:
    """把 Todo 使用提示追加到系统消息。"""
    if request.system_message is not None:
        new_system_content = [
            *request.system_message.content_blocks,
            {"type": "text", "text": f"\n\n{self.system_prompt}"},
        ]
    else:
        new_system_content = [{"type": "text", "text": self.system_prompt}]
    new_system_message = SystemMessage(
        content=cast("list[str | dict[str, str]]", new_system_content)
    )
    return handler(request.override(system_message=new_system_message))
```

这里没有直接修改 `request.system_message`，而是：

1. 展开原有 `content_blocks`；
2. 追加一个新的文本块；
3. 用 `request.override()` 创建带新系统消息的模型请求。

模型调用之后，源码检查最后一条 `AIMessage` 中的工具调用数量：

源码：`todo.py:305-333`

```python
messages = state["messages"]
if not messages:
    return None

last_ai_msg = next(
    (msg for msg in reversed(messages) if isinstance(msg, AIMessage)),
    None,
)
if not last_ai_msg or not last_ai_msg.tool_calls:
    return None

# 找出本轮对 Todo 工具的所有调用
write_todos_calls = [
    tc for tc in last_ai_msg.tool_calls if tc["name"] == "write_todos"
]

if len(write_todos_calls) > 1:
    # 为每个并行调用生成错误 ToolMessage
    error_messages = [
        ToolMessage(
            content=(
                "Error: The `write_todos` tool should never be called multiple times "
                "in parallel. Please call it only once per model invocation to update "
                "the todo list."
            ),
            tool_call_id=tc["id"],
            status="error",
        )
        for tc in write_todos_calls
    ]

    # 保留 AIMessage 中的工具调用，只追加错误结果
    return {"messages": error_messages}

return None
```

Todo 的整张清单是替换式更新。并行调用没有天然的合并顺序，因此源码不试图决定“哪次更新优先”，而是直接把本轮调用标记为错误。

**工程判断**：工具描述适合承载使用建议，Hook 适合追加运行时提示，真正影响一致性的规则仍应在执行后校验。

## 二、Shell：工具只是入口，会话资源才是主体

`ShellToolMiddleware` 的核心不是 `shell(command)` 这个函数，而是围绕它管理的一组资源：

- 持久 Shell 进程；
- 工作目录；
- 环境变量；
- 启动和关闭命令；
- 超时、输出上限和进程终止策略；
- 输出脱敏规则。

### 1. 会话资源是内部 State

源码把会话资源标记为 `UntrackedValue` 和 `PrivateStateAttr`：

源码：`shell_tool.py:81-109`

```python
@dataclass
class _SessionResources:
    """单次 Agent 运行的 Shell 资源容器。"""

    session: ShellSession
    tempdir: tempfile.TemporaryDirectory[str] | None
    policy: BaseExecutionPolicy
    finalizer: weakref.finalize = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.finalizer = weakref.finalize(
            self,
            _cleanup_resources,
            self.session,
            self.tempdir,
            self.policy.termination_timeout,
        )


class ShellToolState(AgentState[ResponseT]):
    """用于跟踪 Shell 会话资源的 Agent State 扩展。"""

    shell_session_resources: NotRequired[
        Annotated[_SessionResources | None, UntrackedValue, PrivateStateAttr]
    ]
```

`PrivateStateAttr` 表示该字段只服务于中间件内部，不应作为普通业务 State 暴露给模型或调用方。`UntrackedValue` 进一步说明这个资源对象不参与普通 State 追踪。

这不是“把进程对象序列化进检查点”。源码通过 State 在一次运行中复用资源，并用 `weakref.finalize`（弱引用终结器）兜底清理进程和临时目录。涉及跨进程恢复时，不能假设这个 Python 对象可以直接持久化。

### 2. 工具通过 `ToolRuntime` 取得 State 和调用 ID

Shell 工具在构造函数中注册为一个闭包：

源码：`shell_tool.py:506-591`

```python
class ShellToolMiddleware(AgentMiddleware[ShellToolState[ResponseT], ContextT, ResponseT]):
    """为 Agent 注册持久 Shell 工具。"""

    state_schema = ShellToolState

    def __init__(
        self,
        workspace_root: str | Path | None = None,
        *,
        startup_commands: tuple[str, ...] | list[str] | str | None = None,
        shutdown_commands: tuple[str, ...] | list[str] | str | None = None,
        execution_policy: BaseExecutionPolicy | None = None,
        redaction_rules: tuple[RedactionRule, ...] | list[RedactionRule] | None = None,
        tool_description: str | None = None,
        tool_name: str = SHELL_TOOL_NAME,
        shell_command: Sequence[str] | str | None = None,
        env: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self._workspace_root = Path(workspace_root) if workspace_root else None
        self._tool_name = tool_name
        self._shell_command = self._normalize_shell_command(shell_command)
        self._environment = self._normalize_env(env)
        if execution_policy is not None:
            self._execution_policy = execution_policy
        else:
            self._execution_policy = HostExecutionPolicy()
        rules = redaction_rules or ()
        self._redaction_rules: tuple[ResolvedRedactionRule, ...] = tuple(
            rule.resolve() for rule in rules
        )

        @tool(self._tool_name, args_schema=_ShellToolInput, description=tool_description)
        def shell_tool(
            *,
            runtime: ToolRuntime[None, ShellToolState],
            command: str | None = None,
            restart: bool = False,
        ) -> ToolMessage | str:
            resources = self._get_or_create_resources(runtime.state)
            return self._run_shell_tool(
                resources,
                {"command": command, "restart": restart},
                tool_call_id=runtime.tool_call_id,
            )

        self._shell_tool = shell_tool
        self.tools = [self._shell_tool]
```

这里的 `runtime` 参数不会暴露给模型的工具参数 Schema。它由框架注入，工具函数可以从中取得：

- `runtime.state`：当前 Agent State；
- `runtime.tool_call_id`：当前工具调用 ID；
- 其他运行时上下文。

这就是工具访问内部状态的正式入口，不需要把 `shell_session_resources` 做成模型可填写的参数。

### 3. 生命周期 Hook 管理资源创建和回收

Shell 会话在 Agent 开始时创建，在 Agent 结束时关闭：

源码：`shell_tool.py:627-694`

```python
@override
def before_agent(
    self, state: ShellToolState[ResponseT], runtime: Runtime[ContextT]
) -> dict[str, Any] | None:
    """启动 Shell 会话并执行启动命令。"""
    resources = self._get_or_create_resources(state)
    return {"shell_session_resources": resources}


@override
def after_agent(
    self, state: ShellToolState[ResponseT], runtime: Runtime[ContextT]
) -> None:
    """运行关闭命令，并在 Agent 完成后释放资源。"""
    resources = state.get("shell_session_resources")
    if not isinstance(resources, _SessionResources):
        # 资源从未创建时不需要清理
        return
    try:
        self._run_shutdown_commands(resources.session)
    finally:
        resources.finalizer()


def _get_or_create_resources(
    self, state: ShellToolState[ResponseT]
) -> _SessionResources:
    """从 State 取已有资源，不存在时创建新资源。"""
    resources = state.get("shell_session_resources")
    if isinstance(resources, _SessionResources):
        return resources

    new_resources = self._create_resources()
    # State 是类字典对象，这里把新资源写回当前 State
    cast("dict[str, Any]", state)["shell_session_resources"] = new_resources
    return new_resources
```

`_get_or_create_resources()` 还承担可恢复性：如果本轮 Agent 已经有会话资源，就继续复用；没有时才创建新会话。

创建过程会根据 `workspace_root` 选择工作目录。没有显式工作目录时，源码创建临时目录，并在资源终结时删除：

源码：`shell_tool.py:696-723`

```python
def _create_resources(self) -> _SessionResources:
    workspace = self._workspace_root
    tempdir: tempfile.TemporaryDirectory[str] | None = None
    if workspace is None:
        tempdir = tempfile.TemporaryDirectory(prefix=SHELL_TEMP_PREFIX)
        workspace_path = Path(tempdir.name)
    else:
        workspace_path = workspace
        workspace_path.mkdir(parents=True, exist_ok=True)

    session = ShellSession(
        workspace_path,
        self._execution_policy,
        self._shell_command,
        self._environment or {},
    )
    try:
        session.start()
        LOGGER.info("Started shell session in %s", workspace_path)
        self._run_startup_commands(session)
    except BaseException:
        LOGGER.exception("Starting shell session failed; cleaning up resources.")
        session.stop(self._execution_policy.termination_timeout)
        if tempdir is not None:
            tempdir.cleanup()
        raise

    return _SessionResources(
        session=session,
        tempdir=tempdir,
        policy=self._execution_policy,
    )
```

启动命令失败时，源码会停止会话、清理临时目录，再把异常抛出。资源初始化不能只写“启动进程”，还要定义初始化失败后的回滚。

### 4. 执行策略决定安全边界

`BaseExecutionPolicy` 只定义公共配置和 `spawn()` 接口：

源码：`_execution.py:56-88`

```python
@dataclass
class BaseExecutionPolicy(abc.ABC):
    """持久 Shell 会话的配置契约。"""

    command_timeout: float = 30.0
    startup_timeout: float = 30.0
    termination_timeout: float = 10.0
    max_output_lines: int = 100
    max_output_bytes: int | None = None

    def __post_init__(self) -> None:
        if self.max_output_lines <= 0:
            msg = "max_output_lines must be positive."
            raise ValueError(msg)

    @abc.abstractmethod
    def spawn(
        self,
        *,
        workspace: Path,
        env: Mapping[str, str],
        command: Sequence[str],
    ) -> subprocess.Popen[str]:
        """启动持久 Shell 进程。"""
```

具体策略只需要实现进程如何启动：

- `HostExecutionPolicy`：直接在宿主机执行，不提供文件系统或网络沙箱；
- `CodexSandboxExecutionPolicy`：通过 Codex CLI 沙箱启动；
- `DockerExecutionPolicy`：在独立 Docker 容器中启动。

源码默认使用 `HostExecutionPolicy`。因此，配置 `redaction_rules` 只能清理返回内容，不能阻止命令本身读取或外传敏感数据。源码文档也明确警告：脱敏发生在执行之后。

### 5. 输出处理同时覆盖超时、截断和脱敏

工具执行后，源码先处理超时，再处理 PII（Personally Identifiable Information，个人身份信息）规则，最后把截断信息和退出码写进结果：

源码：`shell_tool.py:787-850`

```python
LOGGER.info("Executing shell command: %s", command)
result = session.execute(command, timeout=self._execution_policy.command_timeout)

if result.timed_out:
    timeout_seconds = self._execution_policy.command_timeout
    message = f"Error: Command timed out after {timeout_seconds:.1f} seconds."
    return self._format_tool_message(
        message,
        tool_call_id,
        status="error",
        artifact={
            "timed_out": True,
            "exit_code": None,
        },
    )

try:
    sanitized_output, matches = self._apply_redactions(result.output)
except PIIDetectionError as error:
    LOGGER.warning("Blocking command output due to detected %s.", error.pii_type)
    message = f"Output blocked: detected {error.pii_type}."
    return self._format_tool_message(
        message,
        tool_call_id,
        status="error",
        artifact={
            "timed_out": False,
            "exit_code": result.exit_code,
            "matches": {error.pii_type: error.matches},
        },
    )

sanitized_output = sanitized_output or "<no output>"
if result.truncated_by_lines:
    sanitized_output = (
        f"{sanitized_output.rstrip()}\n\n"
        f"... Output truncated at {self._execution_policy.max_output_lines} lines "
        f"(observed {result.total_lines})."
    )

if result.exit_code not in {0, None}:
    sanitized_output = f"{sanitized_output.rstrip()}\n\nExit code: {result.exit_code}"
    final_status: Literal["success", "error"] = "error"
else:
    final_status = "success"

artifact = {
    "timed_out": False,
    "exit_code": result.exit_code,
    "total_lines": result.total_lines,
    "total_bytes": result.total_bytes,
    "redaction_matches": matches,
}

return self._format_tool_message(
    sanitized_output,
    tool_call_id,
    status=final_status,
    artifact=artifact,
)
```

这段代码体现了三个边界：

1. 超时返回错误结果，并把超时状态写入 `artifact`；
2. `block` 策略可以阻止敏感输出继续进入模型；
3. 输出截断和进程执行是两层限制，输出少不代表命令已经被安全隔离。

**工程判断**：Shell 工具的安全等级由 `execution_policy` 决定，`RedactionRule` 只负责结果清洗，不能替代沙箱、权限控制和网络策略。

## 三、文件搜索：工具自包含，但路径约束不能省

`FilesystemFileSearchMiddleware` 不扩展 State，也不创建持久进程。它在构造函数中用闭包捕获根目录，注入两个工具：

- `glob_search`：按文件名模式查找；
- `grep_search`：按正则表达式搜索内容。

### 1. 工具闭包固定搜索根目录

源码：`file_search.py:112-175`

```python
def __init__(
    self,
    *,
    root_path: str,
    use_ripgrep: bool = True,
    max_file_size_mb: int = 10,
) -> None:
    self.root_path = Path(root_path).resolve()
    self.use_ripgrep = use_ripgrep
    self.max_file_size_bytes = max_file_size_mb * 1024 * 1024

    @tool
    def glob_search(pattern: str, path: str = "/") -> str:
        """按文件名模式快速匹配文件。"""
        try:
            base_full = self._validate_and_resolve_path(path)
        except ValueError:
            return "No files found"

        if not base_full.exists() or not base_full.is_dir():
            return "No files found"

        matching: list[tuple[str, str]] = []
        for match in base_full.glob(pattern):
            if match.is_file():
                # 将真实路径转换成根目录下的虚拟路径
                virtual_path = "/" + str(match.relative_to(self.root_path))
                stat = match.stat()
                modified_at = datetime.fromtimestamp(
                    stat.st_mtime,
                    tz=timezone.utc,
                ).isoformat()
                matching.append((virtual_path, modified_at))

        if not matching:
            return "No files found"

        matching.sort(key=lambda item: item[1], reverse=True)
        file_paths = [path for path, _ in matching]
        return "\n".join(file_paths)
```

这里的 `path` 是虚拟路径，不是让模型直接提交任意本机绝对路径。工具返回的也是 `/src/app.py` 这类相对根目录的路径，降低了工具接口和宿主机目录结构的耦合。

### 2. 路径校验先于搜索

源码把路径校验集中在 `_validate_and_resolve_path()`：

源码：`file_search.py:236-258`

```python
def _validate_and_resolve_path(self, path: str) -> Path:
    """把虚拟路径校验并转换成真实文件系统路径。"""
    # 统一为以斜杠开头的虚拟路径
    if not path.startswith("/"):
        path = "/" + path

    # 拒绝目录穿越和用户目录缩写
    if ".." in path or "~" in path:
        msg = "Path traversal not allowed"
        raise ValueError(msg)

    # 将虚拟路径拼接到固定根目录
    relative = path.lstrip("/")
    full_path = (self.root_path / relative).resolve()

    # 再次确认解析后的路径仍在根目录内
    try:
        full_path.relative_to(self.root_path)
    except ValueError:
        msg = f"Path outside root directory: {path}"
        raise ValueError(msg) from None

    return full_path
```

只检查字符串中有没有 `..` 还不够，因为符号链接或路径解析也可能把结果带出根目录。源码先 `resolve()`，再用 `relative_to()` 检查最终路径，这个顺序才是实际安全边界。

### 3. ripgrep 只是加速后端，不是功能依赖

`grep_search` 先尝试 ripgrep，失败后回退到 Python 搜索：

源码：`file_search.py:203-230`

```python
# 先编译正则表达式，提前返回格式错误
try:
    re.compile(pattern)
except re.error as e:
    return f"Invalid regex pattern: {e}"

if include and not _is_valid_include_pattern(include):
    return "Invalid include pattern"

results = None
if self.use_ripgrep:
    with suppress(
        FileNotFoundError,
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
    ):
        results = self._ripgrep_search(pattern, path, include)

# ripgrep 不可用或被禁用时，使用 Python 实现
if results is None:
    results = self._python_search(pattern, path, include)

if not results:
    return "No matches found"

# 根据 output_mode 格式化结果
return self._format_grep_results(results, output_mode)
```

Python 回退实现还会跳过超过 `max_file_size_bytes` 的文件，并忽略无法按文本读取的文件。这个设计保证工具在没有 ripgrep 的环境中仍可运行，但不能假设两种后端的性能和边界完全相同。

## 四、三种注入重量如何选择

| 问题 | 适合的扩展点 |
| --- | --- |
| 模型需要调用一个新能力 | `tools` |
| 工具需要读写图内 State | `state_schema` + `ToolRuntime` |
| 工具需要在 Agent 开始和结束时创建资源 | `before_agent` / `after_agent` |
| 工具需要改变每次模型请求 | `wrap_model_call` |
| 工具需要独立的进程或容器安全策略 | `BaseExecutionPolicy` |
| 工具只需在固定目录内查询文件 | 闭包工具 + 根目录校验 |

可以用这条顺序设计新工具：

1. 先确定模型可见的参数和返回消息；
2. 再确定工具是否需要访问 State 或运行时上下文；
3. 如果有外部资源，定义创建、复用、失败回滚和销毁；
4. 最后补超时、输出上限、路径和隐私边界。

## 工程判断

### 值得照搬

- 用 `ToolRuntime` 注入 State 和工具调用 ID，不把内部字段暴露成模型参数。
- 用 `Command` 同时提交业务 State 和 `ToolMessage`。
- 用 `PrivateStateAttr` 隔离只供中间件使用的资源字段。
- 用抽象执行策略隔离 Shell 工具逻辑和宿主机、容器、沙箱实现。
- 用固定根目录和 `resolve()` 后的路径检查约束文件搜索范围。

### 需要补一层

- `TodoListMiddleware` 的工具描述很完整，但描述不能代替服务端校验；关键约束仍要在 Hook 或工具函数中执行。
- Shell 默认是 `HostExecutionPolicy`，不适合直接运行不可信命令；部署时必须显式选择隔离策略。
- Shell 输出脱敏发生在命令执行之后，不能防止命令读取或外传敏感数据。
- 会话资源标记为内部 State，并不等于它可以跨进程恢复；真正需要断点恢复时，要重新设计资源句柄和重建流程。
- ripgrep 和 Python 回退路径的性能、编码和结果格式可能不同，需要针对实际仓库补测试。

### 不要照搬

- 不要把所有工具都做成带 State 的中间件；自包含查询工具不需要额外状态。
- 不要把 Shell 的输出脱敏当成执行沙箱。
- 不要让模型直接传入宿主机绝对路径，再在工具内部“尽量限制”。
- 不要只依赖工具描述约束调用次数、参数范围或权限。

## 读完后应该能判断什么

- 一个工具为什么可能同时需要 `tools`、`state_schema`、运行时注入和生命周期 Hook。
- `Command` 如何把工具结果和业务 State 一起交回图运行时。
- `PrivateStateAttr`、`UntrackedValue` 和普通 State 字段的职责差异。
- Shell 的执行策略、会话管理、输出限制和脱敏分别解决什么问题。
- 文件搜索为什么必须先做虚拟路径校验，再选择 ripgrep 或 Python 后端。
