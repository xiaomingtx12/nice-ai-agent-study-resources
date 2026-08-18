---
sidebar_position: 10
sidebar_label: 08 FilesystemMiddleware 与权限
description: 从一次文件工具调用出发，理解 FilesystemMiddleware 的工具装配、权限判断、人工审批和 Backend 边界。
---

# Deep Agents 源码解析 08：FilesystemMiddleware：工具、权限与运行时边界

## 源码定位

> **版本基线**：Deep Agents 0.6.12（`libs/deepagents/`）。
>
> 主代理装配文件工具：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
>
> 文件中间件构造与工具注册：`libs/deepagents/deepagents/middleware/filesystem.py` → `FilesystemMiddleware.__init__()`、`_get_backend()`
>
> 文件工具实现：`libs/deepagents/deepagents/middleware/filesystem.py` → `_create_ls_tool()`、`_create_read_file_tool()`、`_create_write_file_tool()`、`_create_edit_file_tool()`、`_create_delete_tool()`、`_create_glob_tool()`、`_create_grep_tool()`、`_create_execute_tool()`
>
> 模型请求 Hook：`libs/deepagents/deepagents/middleware/filesystem.py` → `_filter_unsupported_tools_and_apply_prompt()`、`wrap_model_call()`、`awrap_model_call()`
>
> 工具结果 Hook：`libs/deepagents/deepagents/middleware/filesystem.py` → `_process_large_message()`、`_intercept_large_tool_result()`、`wrap_tool_call()`、`awrap_tool_call()`
>
> 路径校验：`libs/deepagents/deepagents/backends/utils.py` → `validate_path()`
>
> 权限匹配与结果过滤：`libs/deepagents/deepagents/middleware/filesystem.py` → `FilesystemPermission`、`_check_fs_permission()`、`_filter_paths_by_permission()`、`_filter_file_infos_by_permission()`、`_filter_grep_matches_by_permission()`
>
> 递归删除预检：`libs/deepagents/deepagents/middleware/filesystem.py` → `_find_delete_deny_patterns()`、`_wildcard_delete_overlap()`
>
> 权限到人工审批的转换：`libs/deepagents/deepagents/middleware/_fs_interrupt.py` → `_FS_TOOL_PATH_ARGS`、`_make_fs_when_predicate()`、`_build_interrupt_on_from_permissions()`
>
> 审批配置合并与挂载：`libs/deepagents/deepagents/graph.py` → `_merge_fs_interrupt_on()`、`create_deep_agent()`
>
> 本地文件 Backend：`libs/deepagents/deepagents/backends/filesystem.py` → `FilesystemBackend.read()`、`write()`、`edit()`、`delete()`、`glob()`、`grep()`

`FilesystemMiddleware` 负责把文件能力接到 `create_agent()` 的中间件链上。它做了三件相互配合的事：

- 创建内建文件工具，让模型可以读写、搜索和删除文件；
- 在工具函数内部执行路径校验和文件权限判断；
- 在模型请求和工具结果两端处理能力提示与上下文体积。

## 这篇要回答的设计问题

读这篇源码时，可以先抓住四个问题：

| 问题 | 负责回答的源码位置 |
| --- | --- |
| 模型本轮能看到哪些文件工具？ | `wrap_model_call()` 和 `_filter_unsupported_tools_and_apply_prompt()` |
| 当前调用能不能访问这个路径？ | 工具函数中的 `validate_path()` 和 `_check_fs_permission()` |
| 搜索结果为什么会少？ | `ls`、`glob`、`grep` 返回后的权限过滤 |
| 命令执行和文件权限是什么关系？ | `supports_execution()`、Backend 能力检查和沙箱实现 |

文件权限不能只靠“把工具从提示词里隐藏”来实现。模型请求阶段决定本轮能看到哪些工具，工具执行阶段再次校验路径和权限，Backend 与执行环境负责真正访问资源。三层重复检查看起来有些啰嗦，但它们面对的是不同的失败：模型可能误选工具，调用参数可能越界，底层环境也可能拥有更大的权限。

因此，`FilesystemMiddleware` 更接近策略编译器和运行时守门员，而不是安全边界本身。它把声明式权限转成工具过滤、路径判断和人工审批条件，真正的隔离仍然要由 Backend、沙箱和操作系统提供。

这篇只讲文件中间件和权限。Backend 具体如何存储文件、如何路由虚拟路径，放在 04 篇；沙箱和操作系统隔离，放在 05 篇。

## 一、它在主代理里的位置

`create_deep_agent()` 先创建一组核心中间件，再把它们交给 `create_agent()`。主代理的装配顺序中，FilesystemMiddleware 位于 SkillsMiddleware 之后、SubAgentMiddleware 之前：

```text
TodoListMiddleware
  -> SkillsMiddleware（配置 skills 时才加入）
  -> FilesystemMiddleware
  -> SubAgentMiddleware（配置子代理时才加入）
  -> SummarizationMiddleware
  -> PatchToolCallsMiddleware
  -> AsyncSubAgentMiddleware（配置异步子代理时才加入）
  -> Profile.extra_middleware
  -> Prompt Caching Middleware
  -> MemoryMiddleware（配置 memory 时才加入）
  -> HumanInTheLoopMiddleware（存在 interrupt_on 时才加入）
  -> _ToolExclusionMiddleware（存在 Profile.excluded_tools 时才加入）
  -> create_agent(...)
```

FilesystemMiddleware 和 SubAgentMiddleware 属于 Deep Agents 的核心脚手架。Profile 可以增加或替换可扩展的中间件，但不能把这两个核心能力当作普通扩展删掉。

权限规则在 FilesystemMiddleware 创建时传入：

```python
deepagent_middleware.append(
    FilesystemMiddleware(
        backend=backend,
        custom_tool_descriptions=_profile.tool_description_overrides,
        _permissions=permissions,
    )
)
```

这里还没有创建人工审批中间件。`mode="interrupt"` 的权限规则会先保存到 FilesystemMiddleware，稍后由 `create_deep_agent()` 编译成 `HumanInTheLoopMiddleware` 的 `interrupt_on` 配置。两者是同一个权限配置的两个阶段：

```text
FilesystemPermission
  -> 文件工具执行时处理 allow / deny
  -> 图装配时把 interrupt 编译为 HITL
```

## 二、构造阶段：工具、Backend 和权限

### 1. 工具先注册到中间件

`FilesystemMiddleware.__init__()` 创建这些工具：

| 工具 | 作用 | 权限操作 |
| --- | --- | --- |
| `ls` | 列出目录内容 | `read` |
| `read_file` | 分页读取文件 | `read` |
| `write_file` | 写入或覆盖文件 | `write` |
| `edit_file` | 替换文件中的字符串 | `write` |
| `delete` | 删除文件或目录 | `write` |
| `glob` | 按模式查找路径 | `read` |
| `grep` | 搜索文件内容 | `read` |
| `execute` | 执行命令 | 不属于 `FilesystemPermission` 的读写规则 |

`tools=` 是注册阶段的 allowlist。传入列表时，列表之外的工具不会进入 `self.tools`；如果列表中缺少 `read_file`，构造函数直接报错，因为多个文件操作依赖它提供恢复能力。

```python
tool_factories = (
    ("ls", self._create_ls_tool),
    ("read_file", self._create_read_file_tool),
    ("write_file", self._create_write_file_tool),
    ("edit_file", self._create_edit_file_tool),
    ("delete", self._create_delete_tool),
    ("glob", self._create_glob_tool),
    ("grep", self._create_grep_tool),
    ("execute", self._create_execute_tool),
)
self.tools = [
    factory()
    for name, factory in tool_factories
    if self._enabled_tools is None or name in self._enabled_tools
]
```

`execute` 的工具函数可以先被注册，但它能否出现在模型本轮请求中，还要看当前 Backend 是否实现 `SandboxBackendProtocol`。`delete` 也有自己的 Backend 能力检查。注册、模型可见和实际执行是三个不同时间点。

### 2. Backend 在工具调用时解析

Backend 可以直接传入实例，也可以传入 factory。0.6.12 中 factory 仍然兼容，但已经标记为弃用，计划在 0.7.0 移除。`_get_backend()` 会在工具调用时解析它：

下面只列出关键分支，完整的弃用提示文本已省略。

```python
def _get_backend(self, runtime):
    if callable(self.backend):
        warn_deprecated(
            since="0.5.0",
            removal="0.7.0",
            message="Passing a callable (factory) as `backend` is deprecated",
            package="deepagents",
        )
        return _resolve_backend(self.backend, runtime)
    return self.backend
```

关键点是，factory 接收当前 `ToolRuntime`，可以根据 state、context 或 store 返回本次调用使用的 Backend；直接传实例则不需要每次解析。新代码应优先传 `BackendProtocol` 实例，阅读旧代码时不要把 factory 当成已经失效的 API。

工具函数从 `ToolRuntime` 取得 State、Context、Store 和当前调用信息，再得到实际 Backend。这样，同一个 `read_file` 工具可以连接临时的 `StateBackend`、持久化的 `StoreBackend`，也可以连接负责路径路由的 `CompositeBackend`。

### 3. 权限规则先保存，不在构造阶段逐个文件判断

权限结构是：

```python
@dataclass
class FilesystemPermission:
    operations: list[FilesystemOperation]
    paths: list[str]
    mode: Literal["allow", "deny", "interrupt"] = "allow"
```

构造时只校验规则形状：

- 规则路径必须以 `/` 开头；
- 不能包含 `..`；
- 不能包含 `~`；
- `mode` 表示匹配后的处理方式。

它不会在构造阶段扫描文件系统，也不会为每个规则建立宿主机 ACL。真正的判断发生在工具函数拿到本轮参数之后。

如果 Backend 具备命令执行能力，FilesystemMiddleware 会在构造阶段检查权限配置是否适用。普通的可执行 Backend 不能直接与 `_permissions` 混用；只有 CompositeBackend 的权限路径全部落在已配置的 routes 下时，才允许通过这项检查：

下面只列出构造阶段的关键分支，异常文本已省略。

```python
if (
    _permissions
    and isinstance(self.backend, BackendProtocol)
    and supports_execution(self.backend)
    and not _all_paths_scoped_to_routes(_permissions, self.backend)
):
    raise NotImplementedError(...)
```

这个限制容易被误读。它不是把 `FilesystemPermission` 扩展成了 Shell 权限，而是避免开发者以为“文件工具受限，所以 `execute` 也受限”。`FilesystemPermission` 只覆盖内建文件工具的 `read`、`write` 和 `delete` 路径判断；`execute` 里的 shell、重定向、脚本和子进程仍由 Backend、沙箱和操作系统负责。

## 三、模型请求 Hook：决定模型本轮看到什么

模型调用前会进入 `wrap_model_call()`。它接收 `ModelRequest`，还没有执行任何文件操作；调用 `handler(request)` 后，返回的是下游模型产生的 `ModelResponse`。FilesystemMiddleware 在这条链上主要改写请求，不直接改写模型响应：

```text
wrap_model_call()
  -> _filter_unsupported_tools_and_apply_prompt()
  -> _move_media_results_after_tool_results()
  -> _evict_and_truncate_messages()
  -> handler(request)
```

`handler` 表示当前中间件之后的执行链，最终会走到模型。FilesystemMiddleware 修改的是传给下游的请求副本。

### 1. 按 Backend 能力过滤工具

`_unsupported_tools_and_execution_state()` 会检查本轮请求中是否有 `execute` 或 `delete`，然后解析 Backend：

- 不支持执行时，从请求工具列表中移除 `execute`；
- 不支持删除时，从请求工具列表中移除 `delete`；
- `execute` 保留时，才把执行说明加入系统提示词；
- `grep` 的工具描述也会根据 `execute` 是否可用切换版本。

```python
visible_tools = [
    tool
    for tool in request.tools
    if self._tool_name(tool) not in unsupported
]

if unsupported:
    request = request.override(tools=visible_tools)

described_tools = self._with_filtered_grep_description(
    visible_tools,
    include_execution=execution_active,
)
```

被过滤的是模型本轮可见的工具。`self.tools` 中已经创建的工具实例仍然存在，工具函数内部也保留运行时能力检查。这样做有两个作用：模型不会根据当前 Backend 不具备的能力生成调用；如果其他代码直接调用工具，运行时仍会返回明确错误。

`Profile.excluded_tools` 不是这段逻辑。它由更外层的 `_ToolExclusionMiddleware` 在中间件栈装配完成后处理，作用是从最终模型请求中排除指定工具。FilesystemMiddleware 的 Backend 能力过滤和 Profile 的工具排除各自解决不同问题。

### 2. 工具描述只改模型请求里的副本

当 `execute` 不可用时，`grep` 的说明不能继续告诉模型使用命令执行能力。`_with_filtered_grep_description()` 会复制 `BaseTool` 或字典形式的工具，只替换复制品里的 `description`，再放入 `ModelRequest.tools`：

```python
if isinstance(tool, BaseTool):
    if tool.description in default_descriptions:
        rewritten.append(
            tool.model_copy(update={"description": target_description})
        )
```

因此，工具注册表里的原始工具描述不被改写；变化只对本轮模型请求可见。下一次请求会根据当前 Backend 能力重新构造请求工具列表。

### 3. 追加与工具集合匹配的系统提示词

如果用户没有传 `system_prompt`，中间件会根据最终可见的文件工具生成 Filesystem system prompt。只有 `execute` 保留下来时，才追加命令执行说明和虚拟路径到宿主路径的映射提示。

这一步和过滤必须一起做。只把工具从列表中删除，却保留旧提示词，会让模型继续依据不存在的能力规划调用。

### 4. 同一个 Hook 还处理消息体积和媒体顺序

`wrap_model_call()` 在调用下游模型前还会做两类请求级处理：

- `_move_media_results_after_tool_results()` 把视频读取产生的媒体消息移动到同一批 `ToolMessage` 后面，避免部分模型提供方拒绝消息顺序；
- `_evict_and_truncate_messages()` 把过大的用户消息写入 Backend，当前请求使用预览和恢复路径，State 仍保留完整消息。

这些处理改变的是模型看到的请求，不改变文件权限结果。异步版本 `awrap_model_call()` 使用相同的顺序，只把 Backend 和 handler 调用换成异步形式。

这里要区分两种返回值。普通路径是 `handler(request) -> ModelResponse`；如果本轮需要把过大的用户消息写入 Backend，FilesystemMiddleware 还可能返回带状态更新的 `ExtendedModelResponse`。这不是模型输出被重写，而是中间件把“请求副本”和“状态更新”一起交还给 Agent runtime。

## 四、工具执行：路径校验和权限判断发生在这里

模型真正提交 tool call 后，LangChain 会校验 schema，并注入 `ToolRuntime`。接着进入对应的 `_create_*_tool()` 生成的函数：

```text
tool call
  -> schema 校验
  -> 注入 ToolRuntime
  -> _get_backend()
  -> validate_path()
  -> 权限判断
  -> Backend.read / write / edit / delete / glob / grep
  -> 格式化结果
  -> 返回 ToolMessage 或 Command
```

`FilesystemPermission` 的主要执行位置就是这些工具函数，而不是 `wrap_model_call()`。模型请求 Hook 只控制工具可见性和提示词；工具函数才拿到了具体路径，能够做一次调用级的权限判断。

### 1. 路径必须先经过 `validate_path()`

`validate_path()` 面向虚拟文件系统路径，负责把输入规范化为以 `/` 开头的逻辑路径：

- 拒绝路径组件 `..`；
- 拒绝以 `~` 开头的路径；
- 拒绝 `C:/...`、`D:/...` 等 Windows 绝对路径；
- 把反斜杠转换成正斜杠；
- 规范化 `.`、重复斜杠等写法；
- 如果配置了 `allowed_prefixes`，再检查路径是否处在允许前缀下。

权限匹配函数 `_check_fs_permission()` 不负责这一步。工具必须先拿到规范化路径，再把它交给权限匹配，否则同一条规则可能因为输入写法不同得到不同结果。

### 2. 精确路径工具直接检查目标

`read_file`、`write_file` 和 `edit_file` 都是精确路径工具。以 `read_file` 的同步函数为例，源码顺序是：

```python
resolved_backend = self._get_backend(runtime)
validated_path = validate_path(file_path)

if _check_fs_permission(
    self._permissions,
    "read",
    validated_path,
) == "deny":
    return ToolMessage(
        content=f"Error: permission denied for read on {validated_path}",
        name="read_file",
        tool_call_id=runtime.tool_call_id,
        status="error",
    )

read_result = resolved_backend.read(
    validated_path,
    offset=offset,
    limit=limit,
)
return _handle_read_result(
    read_result,
    validated_path,
    runtime.tool_call_id,
    offset,
    limit,
)
```

`write_file` 和 `edit_file` 把操作换成 `write`，但顺序相同。`deny` 在调用 Backend 前直接返回错误；`allow` 和 `interrupt` 都不会在这里暂停，审批暂停由外层 HITL 中间件完成。

`read_file` 还会根据 Backend 返回的数据处理文本、图片、音频、视频和 PDF。文本结果带行号并支持分页，二进制结果转成模型内容块，视频读取可能返回一个包含媒体消息的 `Command`。这些是结果格式问题，不会改变权限判断。

### 3. `execute` 的 timeout 只治理参数

`execute` 工具接受可选的 `timeout`。中间件会拒绝负数，也会拒绝超过 `max_execute_timeout` 的值；默认上限是 3600 秒。这个检查发生在调用 Backend 之前：

下面只列出参数判断分支，返回的 `ToolMessage` 字段已省略。

```python
if timeout is not None:
    if timeout < 0:
        return ToolMessage(content=f"Error: timeout must be non-negative, got {timeout}.")
    if timeout > self._max_execute_timeout:
        return ToolMessage(
            content=(
                f"Error: timeout {timeout}s exceeds maximum allowed "
                f"({self._max_execute_timeout}s)."
            )
        )
```

它治理的是调用参数，不是进程隔离。命令能否被终止、子进程是否一起回收、网络是否可用，仍取决于 `SandboxBackendProtocol` 的实现和底层运行环境。把 `max_execute_timeout` 调小，不能替代容器、沙箱或操作系统级限制。

### 4. 权限规则是首条命中

`_check_fs_permission()` 按列表顺序扫描，命中第一条同时满足操作和路径模式的规则就返回：

```python
def _check_fs_permission(rules, operation, path):
    for rule in rules:
        if operation not in rule.operations:
            continue
        if any(
            wcglob.globmatch(
                path,
                pattern,
                flags=_FS_WCMATCH_FLAGS,
            )
            for pattern in rule.paths
        ):
            return rule.mode
    return "allow"
```

它不是“拒绝优先”，也不是“扫描所有规则后取最严格结果”。例如：

```text
/:allow
/secrets/**:deny
```

访问 `/secrets/key` 会在第一条规则处停止，结果是 `allow`。想保护 `/secrets`，应把更具体的规则放前面：

```text
/secrets/**:deny
/:allow
```

没有规则命中时默认返回 `allow`。因此权限配置的重点不只是写出模式，还要按首条命中语义安排顺序。

## 五、范围工具要在调用前后各处理一次

`ls`、`glob` 和 `grep` 不只对应一个目标文件。它们先让 Backend 扫描一个范围，再把多个路径或匹配结果返回给模型。只检查搜索根不够，因为根路径可能允许访问，但返回结果中可能包含被保护的子路径。

```text
调用前
  -> 校验搜索根
  -> 判断搜索根是否被 deny
  -> 允许才调用 Backend

调用后
  -> 按每个结果的真实路径重新匹配权限
  -> 删除 denied 条目
  -> 保留允许和已审批的条目
  -> 格式化为 ToolMessage
```

源码分别通过以下函数过滤结果：

- `ls` 的 `FileInfo` 使用 `_filter_file_infos_by_permission()`；
- `glob` 的匹配路径使用 `_filter_file_infos_by_permission()`；
- `grep` 的匹配项使用 `_filter_grep_matches_by_permission()`；
- 更简单的路径列表使用 `_filter_paths_by_permission()`。

过滤条件只删除 `deny`。`interrupt` 规则已经在工具执行前由 HITL 处理，审批通过的结果不能在返回阶段又被静默删掉。

### `glob` 的 `pattern` 是独立的搜索入口

`glob` 同时有 `path` 和 `pattern`。`path` 是 Backend 的搜索根，`pattern` 决定匹配方式；绝对 `pattern` 还可能把搜索指向另一个逻辑根。HITL 的范围判断因此会同时检查这两个参数，不能只看 `path`：

```text
glob(
  pattern="/secrets/**",
  path="/workspace",
)
```

如果审批逻辑只检查 `/workspace`，这个调用就可能绕开针对 `/secrets` 的审批范围。最终结果仍会经过权限过滤，但审批判断不能漏掉 pattern 本身。

`glob` 还有 Backend 和 Middleware 两层超时控制。Backend 可能先返回 `truncated=True` 的部分结果，Middleware 还会用自己的等待时间限制整个工具调用。搜索结果不完整和工具调用超时是两种不同状态，不能混为权限问题。

## 六、递归删除不能只匹配目标路径

`delete` 删除目录时会影响完整子树：

```text
delete("/work")
  -> /work/app/config.yaml
  -> /work/secrets/key.txt
```

所以它没有直接调用 `_check_fs_permission()`，而是在 Backend 删除前调用 `_find_delete_deny_patterns()`，判断删除目标和所有后代是否可能与某条 `write + deny` 规则重叠。

典型结果如下：

| deny 规则 | 删除目标 | 结果 |
| --- | --- | --- |
| `/work` | `/work/sub` | 拒绝 |
| `/work/*` | `/work/app/child` | 拒绝，删除会影响被拒绝的目录 |
| `/work/*.log` | `/work/notes.txt` | 可以证明不相交，允许 |
| `/**/secrets` | 任意范围 | 无法稳定定位，保守拒绝 |

源码先提取规则的字面前缀，再通过 `_wildcard_delete_overlap()` 处理通配符。它不先枚举目录再决定是否删除，因为“检查目录”和“真正删除”之间可能发生变化。这个预检减少了漏删风险，但不能让底层删除操作变成原子操作；Backend 或操作系统错误仍可能导致部分删除。

## 七、`interrupt` 如何变成 HITL

`FilesystemMiddleware` 不负责暂停图执行。它只知道当前工具调用是否命中 `deny`，以及范围结果如何过滤。权限中的 `interrupt` 由 `_fs_interrupt.py` 翻译成 LangChain 的 `InterruptOnConfig`，再由 `graph.py` 挂载 `HumanInTheLoopMiddleware`。

### 1. 建立工具到路径参数的映射

`_FS_TOOL_PATH_ARGS` 把工具和权限操作对应起来：

```python
_FS_TOOL_PATH_ARGS = {
    "ls": ("read", "path", "bulk", None),
    "read_file": ("read", "file_path", "exact", None),
    "write_file": ("write", "file_path", "exact", None),
    "edit_file": ("write", "file_path", "exact", None),
    "delete": ("write", "file_path", "bulk", None),
    "glob": ("read", "path", "bulk", "pattern"),
    "grep": ("read", "path", "bulk", None),
}
```

`exact` 表示调用只针对一个明确路径；`bulk` 表示调用可能触碰搜索根下的多个后代。`execute` 不在映射中，因为 FilesystemPermission 没有命令执行操作。

### 2. 为每个工具生成 `when` 谓词

`_build_interrupt_on_from_permissions()` 只为存在 `interrupt` 规则的读写操作生成配置：

```python
result[tool_name] = InterruptOnConfig(
    allowed_decisions=[
        "approve",
        "edit",
        "reject",
        "respond",
    ],
    when=_make_fs_when_predicate(
        rules,
        operation,
        path_arg,
        scope,
        pattern_arg,
    ),
)
```

精确工具会规范化参数后调用 `_check_fs_permission()`。如果前面已经命中 `deny`，`when` 不会触发审批，工具随后直接返回拒绝错误。

范围工具按搜索子树和权限模式的前缀做重叠判断：

- `grep(path=None)` 无法确定搜索边界，只要存在对应的 `interrupt` 规则就可能触发审批；
- `glob` 会额外检查绝对 `pattern`；
- 以任意层级通配符开头的规则难以提取稳定前缀，判断会更保守，可能带来更多审批。

### 3. 装配阶段合并用户配置

`create_deep_agent()` 的顺序是：

```text
permissions
  -> _build_interrupt_on_from_permissions()
  -> _merge_fs_interrupt_on(..., interrupt_on)
  -> HumanInTheLoopMiddleware(interrupt_on=...)
```

`_merge_fs_interrupt_on()` 先放入权限生成的配置，再用用户传入的同名配置覆盖它。因此用户显式提供的 `interrupt_on` 优先。

审批通过后，工具调用仍会重新进入 `_create_*_tool()` 生成的函数。人工审批不是权限绕过点，`validate_path()`、`deny` 检查、删除范围预检和结果过滤仍然有效；人工选择 `edit` 后，修改后的参数也会重新检查。

## 八、工具结果 Hook 负责上下文体积

工具函数返回 `ToolMessage` 或 `Command` 后，才进入 `wrap_tool_call()`：

```python
tool_result = handler(request)

if (
    self._tool_token_limit_before_evict is None
    or request.tool_call["name"] in TOOLS_EXCLUDED_FROM_EVICTION
):
    return tool_result

return self._intercept_large_tool_result(
    tool_result,
    request.runtime,
)
```

这里的 `handler` 是后续工具执行链。FilesystemMiddleware 先让工具真正执行，再决定结果是否需要卸载到 Backend。它不替代工具函数里的权限判断。

### 哪些结果不走通用卸载

以下内建工具被 `TOOLS_EXCLUDED_FROM_EVICTION` 排除：

```text
ls / glob / grep / read_file / edit_file / write_file / delete
```

它们各自已经有更合适的结果控制：

- `ls`、`glob`、`grep` 会限制搜索结果；
- `read_file` 用 `offset`、`limit` 和分页元数据继续读取；
- 写入、编辑和删除只返回短确认。

普通自定义工具的巨大文本结果会由 `_process_large_message()` 写入 Backend，模型只看到预览和恢复路径。支持 `capture-at-source` 的沙箱还可以把命令输出直接写入文件，减少巨大 stdout 在进程内来回复制。

模型调用前，过大的 `HumanMessage` 也会被写入 `/conversation_history/` 一类路径。State 保留完整消息，当前 `ModelRequest` 使用带预览的副本。这和权限无关，但属于同一个中间件对上下文的文件化处理。

## 九、FilesystemPermission 不是系统级安全边界

这套权限控制的是“模型通过内建文件工具发起的读写调用”。责任边界可以这样看：

```text
工具 schema
  -> 限制参数形状

FilesystemPermission
  -> allow / deny / interrupt
  -> 范围结果过滤

Backend
  -> 虚拟路径、存储、路由、命令执行能力

沙箱与操作系统
  -> 文件、进程、网络的实际访问边界
```

`FilesystemPermission` 无法限制：

- `execute` 里的 shell、重定向、脚本和子进程；
- Python 代码或第三方工具直接访问文件；
- 网络出口；
- 其他代码绕过工具直接调用 Backend；
- Backend 进程自身已经拥有的宿主机权限。

源码还在构造阶段主动拒绝了一部分“权限 + 可执行 Backend”的组合。原因不只是权限实现暂时不完整，而是如果允许这两种能力无条件并存，配置表面上会给人一种错误暗示：开发者以为文件路径规则已经覆盖命令执行。CompositeBackend 的例外也有明确边界，只有规则路径全部位于 routes 下，才允许继续装配；默认 Backend 的执行能力仍不受这些规则约束。

结果过滤也不等于访问隔离。`grep` 从 `/` 扫描时，即使中间件最后把 `/secrets/key` 从结果中删掉，Backend 进程可能已经读过它。秘密文件不应依赖结果过滤来保护，必须在 Backend、容器、挂载权限或操作系统 ACL 层阻断。

`execute` 能否运行，取决于 Backend 是否支持 `SandboxBackendProtocol`。沙箱还要负责命令超时、工作目录、进程、网络和宿主机路径映射。虚拟路径模式只解决路径命名空间和一部分路径穿越问题，不等于进程隔离。

## 读完后的工程判断

FilesystemMiddleware 的关键设计是把文件能力拆成三层：

- 模型请求 Hook 处理“本轮能看到什么”；
- 文件工具函数处理“这次调用能不能做”；
- Backend 和沙箱处理“实际资源能不能被访问”。

权限规则本身采用首条命中语义，范围工具采用调用前检查和返回后过滤，递归删除则额外做子树重叠预检。`interrupt` 只是把同一套路径判断编译成 HITL 条件，审批通过后仍要回到工具权限检查。

排查问题时可以沿源码职责定位：

```text
工具不见了
  -> __init__() 的 tools allowlist
  -> _filter_unsupported_tools_and_apply_prompt()
  -> Profile.excluded_tools 对应的 _ToolExclusionMiddleware

路径被拒绝
  -> validate_path()
  -> _check_fs_permission()
  -> _find_delete_deny_patterns()

搜索结果少了
  -> _filter_file_infos_by_permission()
  -> _filter_grep_matches_by_permission()

为什么暂停审批
  -> _build_interrupt_on_from_permissions()
  -> _make_fs_when_predicate()

结果太大或模型报消息顺序错误
  -> _process_large_message()
  -> _move_media_results_after_tool_results()
```

真正需要安全保证的地方，仍然要回到 Backend、沙箱和操作系统，而不能只看 FilesystemMiddleware 返回给模型的结果。
