---
sidebar_position: 15
sidebar_label: 13 MemoryMiddleware 与长期上下文装配
description: 沿文件加载、State 快照和请求注入拆解 MemoryMiddleware，解释文件写入与请求刷新之间的边界。
---

# Deep Agents 源码解析 13：MemoryMiddleware 与长期上下文装配

## 一、源码定位

> **阅读基线**：Deep Agents 0.6.12 源码快照，版本与路径约定见 [源码版本与路径约定](source-baseline.md)。
>
> - 装配入口：`libs/deepagents/deepagents/graph.py` → `create_deep_agent()`
> - 本篇主线：`libs/deepagents/deepagents/middleware/memory.py` → `MemoryState`、`before_agent()`、`modify_request()`、`_format_agent_memory()`
> - 请求内容块：`libs/deepagents/deepagents/middleware/_utils.py` → `append_to_system_message()`
> - 写入路径：`libs/deepagents/deepagents/middleware/filesystem.py` → `_create_write_file_tool()`、`_create_edit_file_tool()`；`libs/deepagents/deepagents/backends/protocol.py` → `BackendProtocol.write()`、`edit()`

`MemoryMiddleware` 是把指定文件加载到 Agent 状态、再注入模型请求的中间件。它保存的是文件快照。文件工具更新 Backend 后，只要 State 仍含有 `memory_contents`，后续请求就会继续注入旧快照。

这决定了它适合项目约定、稳定偏好等常驻上下文。需要立即生效的政策和配置，应由应用显式刷新，并在执行动作时查询可信来源。仅把文件写成功，不足以保证下一次模型调用已经使用新值。

本文沿着“加载一次、反复注入、写入后怎样刷新”展开。完整中间件顺序见 [06](06-middleware-increments.md)，Backend 选型见 [04](04-backend-protocol-and-implementations.md)，供应商缓存见 [17](17-prompt-caching.md)。

## 二、一次写入之后，三份内容会暂时不同

假设 `/AGENTS.md` 最初包含 `preference: concise-v1`。入口加载后，文件工具把它改成 `preference: detailed-v2`：

| 时刻 | Backend 文件 | State 的 `memory_contents` | 本次请求注入的 Memory |
| --- | --- | --- | --- |
| 第一次进入加载入口 | v1 | 加载为 v1 | v1 |
| 文件编辑成功后 | v2 | 仍为 v1 | 下一次调用仍是 v1 |
| 携带原 State 再进加载入口 | v2 | 保留 v1，跳过读取 | v1 |
| 不含该字段的新 State 进入入口，仍访问同一文件 | v2 | 加载为 v2 | v2 |

这里的“注入内容”只指 Memory 片段。模型也可能从文件工具的返回消息中看到新值；那不能证明 `memory_contents` 已更新，反而可能让同一请求同时包含新旧两份说明。

这张表跨越了两个 hook：`before_agent` 是图入口的回调，返回的字典由执行器合并进 State；`wrap_model_call` 是包住每次模型调用的回调，读取快照并构造请求副本。前者决定“保存哪份文件内容”，后者决定“这一轮送给模型什么”。

因此，即使同一个线程再次进入加载入口，也不代表重新读文件：Checkpointer 恢复的 State 若仍含 `memory_contents`，字段存在性判断会继续跳过加载。持久化保住了快照，也同时保住了这条跳过条件。

![写入后三份内容暂时不同](./img/13-01-three-copies-temporarily-differ.png)

*图：写入之后三份内容暂时不同——文件已经是 v2，快照和本轮注入还是 v1。*

## 三、装配时，调用方决定读哪些文件

`create_deep_agent()` 中与 Memory 有关的片段如下，其间无关装配代码已省略：

```python
backend = backend if backend is not None else StateBackend()

# ……省略其他中间件的装配……
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

`sources` 是调用方给定的文件路径列表。Memory 不扫描目录，也不会自动发现所有 `AGENTS.md`。路径按 Backend 的规则解析，未必对应宿主机路径。

| 配置 | 装配和运行行为 |
| --- | --- |
| `memory=None` | 不创建这个中间件 |
| `memory=[]` | 创建中间件；入口生成空快照，默认模板仍显示 `(No memory loaded)` |
| `memory=["/AGENTS.md"]` | 从 Backend 读取指定文件 |
| 直接配置 `MemoryMiddleware(system_prompt=None, ...)` | 仍加载文件，但不追加 Memory 文本 |

最后一项中的 `system_prompt` 是 MemoryMiddleware 自己的模板参数，不是工厂的全局系统提示词。它若是字符串，必须包含 `{agent_memory}` 插槽；类型错误或缺少插槽都会在构造时失败。

Memory 不新增写入工具。是否提供 `edit_file`、`write_file`，以及这些工具能访问哪些路径，仍由 FilesystemMiddleware 和 Backend 的配置决定。

## 四、加载入口只检查字段是否存在

`MemoryState` 为中间件增加一个“文件路径 → 原始正文”的状态字段。以下是 `memory.py` 中的字段与更新类型声明，省略了类的文档字符串：

```python
class MemoryState(AgentState):
    memory_contents: NotRequired[Annotated[dict[str, str], PrivateStateAttr]]


class MemoryStateUpdate(TypedDict):
    memory_contents: dict[str, str]
```

`PrivateStateAttr` 是 LangChain 提供的状态标记，用于把字段排除在普通输入输出 schema 之外。它不会禁止检查点保存该字段。普通调用方未在返回值中看到 `memory_contents`，也不能据此认定内部状态已经清空。

`before_agent()` 在图的入口阶段加载文件；它返回状态更新，由图执行器写回 State。下面保留了方法的核心分支，省略签名、文档字符串和读取成功后的日志：

```python
# 已加载过就跳过；检查键是否存在，不检查内容是否为空。
if "memory_contents" in state:
    return None

backend = self._get_backend(state, runtime, config)
contents: dict[str, str] = {}

results = backend.download_files(list(self.sources))
for path, response in zip(self.sources, results, strict=True):
    if response.error is not None:
        if response.error == "file_not_found":
            continue
        msg = f"Failed to download {path}: {response.error}"
        raise ValueError(msg)
    if response.content is not None:
        contents[path] = response.content.decode("utf-8")
        # ……省略 debug 日志……

return MemoryStateUpdate(memory_contents=contents)
```

加载失败还会影响重试行为：只有方法正常返回更新，空字典或已读内容才进入 State；如果下载、配对或解码抛错，不能把此次操作当成已生成新快照。下一次是否重走入口，由图的恢复位置决定。

下面两种正常返回路径尤其容易混淆。

**空快照也算已加载。** 第一次运行时文件不存在，返回的 `memory_contents` 可能是 `{}`。之后即使文件出现，携带该字段的 State 仍会跳过扫描。把字段值改成空字典不能触发重读。

**缺失和读取失败不同。** `file_not_found` 会被跳过；其他 Backend 错误会抛出 `ValueError`。响应数量不匹配会触发 `zip(..., strict=True)` 的校验，非法 UTF-8 内容会在解码时失败。应用不能把这些错误统一解释为“用户没有配置记忆”。

![字段存在就跳过加载](./img/13-02-skip-if-field-exists.png)

*图：加载入口只检查字段在不在，空抽屉也算已读，门后的文件更新再也进不来。*

异步入口 `abefore_agent()` 使用相同的哨兵和配对规则，只把下载换成 `await backend.adownload_files(...)`。Backend 若以工厂形式传入，`_get_backend()` 会构造 `ToolRuntime`，把 State、context、Store 和 config 交给工厂；传入实例时直接复用实例。

## 五、每次模型调用只读取快照

`ModelRequest` 是 LangChain 对单次模型调用输入的封装。Memory 修改其中的 `system_message`，保留对话历史 `messages`。

`modify_request()` 的相关分支如下，中间的供应商缓存标记逻辑省略：

```python
if self.system_prompt is None:
    new_system_message = request.system_message
else:
    contents = request.state.get("memory_contents", {})
    agent_memory = self._format_agent_memory(contents, self.system_prompt)
    new_system_message = append_to_system_message(request.system_message, agent_memory)

# ……省略缓存标记分支，下节说明其职责……

if new_system_message is request.system_message:
    return request
return request.override(system_message=new_system_message)
```

这里没有 Backend 调用。`request.override()` 返回新请求；`append_to_system_message()` 也会创建新的内容块列表和 `SystemMessage`。因此，Memory 注入不会向对话历史追加一条伪造的用户消息，也不会把每轮重复的正文累积进 `messages`。

文件正文的排列由 `_format_agent_memory()` 决定。以下片段省略了日志及函数前后的空值处理：

```python
sections = []
for path in self.sources:
    raw = contents.get(path)
    if not raw:
        continue
    stripped = _strip_html_comments(raw).rstrip()
    if not stripped:
        # ……省略 debug 日志……
        continue
    sections.append(f"{path}\n\n{stripped}")

memory_body = "\n\n".join(sections)
return template.format(agent_memory=memory_body)
```

`sources` 同时决定下载配对顺序和注入顺序。它没有实现“用户文件覆盖项目文件”之类的冲突合并规则；两份相互矛盾的正文会一起进入提示词，除非应用先处理冲突。

这里按 sources 顺序拼接有效正文，没有检索排序、按问题筛选或 token 配额分配。文件越大，每轮系统消息就越大；供应商缓存可以影响重复前缀的处理成本，但不会让这些内容从输入窗口中消失。

历史摘要切分的是 messages，Memory 注入的是 system_message。因此，将大量资料放进 Memory 后再调低历史摘要阈值，不能直接压缩这部分常驻正文。稳定短约定适合 Memory，较大的流程或参考材料可以拆成 Skill 和按需读取的文件。

HTML 注释在格式化时被删除。原文件和 State 快照仍保留原文，直接使用文件工具读取时也可能读到注释，因此注释不能作为隐藏凭据的手段。没有有效正文时，默认模板仍会注入 `(No memory loaded)`。

### 1. 缓存断点不会刷新文件

工厂传入的 `add_cache_control=True`，让 MemoryMiddleware 在模型是 `ChatAnthropic`、系统消息存在且非空时，为最后一个内容块追加 `cache_control`。这个标记供供应商处理提示词缓存，不会查询文件版本或刷新 `memory_contents`。

因此，“模型收到旧记忆”应先检查 State 快照，再检查最终请求内容。直接清理供应商缓存不会改变旧快照生成的请求。缓存顺序和各模型适配器的差异见 [17：Prompt Caching](17-prompt-caching.md)。

## 六、写入和刷新需要分开设计

文件写入由 FilesystemMiddleware 调用 `Backend.edit()` 或 `Backend.write()` 完成。MemoryMiddleware 没有监听文件变化的 hook，也没有自动保存用户反馈的回调；默认模板只是指导模型在需要时使用文件工具。

刷新方案应按业务对时效的要求选择：

| 要求 | 接入方式 | 约束与代价 |
| --- | --- | --- |
| 当前任务期间使用固定约定 | 保留入口快照 | 更新后，当前任务仍可能使用旧版本；应记录所用版本 |
| 新任务读取已更新的偏好 | 新 State 从共享 Store 或同一文件 Backend 加载 | 换线程不会把 StateBackend 的旧线程文件自动搬过去 |
| 同一任务下一次模型调用必须看到新值 | 由应用或自定义中间件在成功写入后显式更新内部 `memory_contents` | 两次写入可能失败在不同位置，需要版本检查或失败恢复策略 |
| 每次敏感动作都必须执行最新政策 | 工具执行时查询可信策略源 | Memory 可以辅助模型理解，但不能替代执行时的校验 |

最后两行是扩展建议，不是内置刷新 API。由于该字段带 `PrivateStateAttr`，不能假设把它塞进普通 `invoke()` 输入就会更新内部状态。扩展应走经过验证的状态更新路径。

同一个 `thread_id` 配合 Checkpointer 可能恢复旧快照。仅仅“又发了一条消息”或“又调用了一次 Agent”，不构成刷新条件。若选择重新执行加载入口，也必须处理字段已经存在时的跳过逻辑。

Runtime context 则是另一类数据：`invoke(context=...)` 提供用户身份、连接等运行依赖，不会自动变成提示词。可以用可信身份选择记忆的命名空间，不能为了方便把整份 context，包括凭据，拼进 Memory。

## 七、文件的生命周期由 Backend 决定

| Backend | 保存范围 | 在 Memory 中的使用边界 |
| --- | --- | --- |
| `StateBackend` | 当前线程的 State；配合 Checkpointer 可在后续同线程调用恢复 | 适合线程内资料；不承诺任务结束自动清理，也不自动跨线程共享 |
| `StoreBackend` | LangGraph Store 的 namespace（命名空间） | 可跨线程读取；跨进程是否保留取决于 Store 实现 |
| `FilesystemBackend` | 指定文件系统 | 多次运行可访问同一文件，但要由部署方管理目录和访问权限 |
| `CompositeBackend` | 按路径前缀路由到不同 Backend | 适合把任务草稿与长期记忆分开保留 |

`StoreBackend` 通过命名空间定位文件。选择 `(tenant_id, user_id)` 这类组合时，标识应来自已校验的运行时身份；命名空间本身不替代身份认证。进程内的 `InMemoryStore` 适合测试，进程重启后不会保留数据。

如果将 `/memories/` 路由到 Store、其余路径交给 StateBackend，草稿可以留在线程内，用户偏好可以跨线程读取。该方案只划分存储位置，长期文件的过期、删除、配额和共享规则仍需应用定义。具体路由与接口实现见 [04](04-backend-protocol-and-implementations.md)。

多个线程修改同一文件时，MemoryMiddleware 不会加锁或合并冲突。按主题拆分文件、使用条件更新，或集中串行整理记忆，都是业务侧的选择；后台整理还能降低请求中的写入成本，但要接受新偏好延后生效。

## 八、把可写记忆与可信规则分开

默认模板提示模型，记忆可能过时、错误或来自他人，并要求避免保存凭据。这些文本约束无法阻止跨用户读取，也不能保证模型拒绝文件中的恶意指令。

一个直接的失败路径是：用户 A 修改共享文件，用户 B 的新任务把同一文件作为 Memory 全文加载。源文件可写范围决定了谁能影响 B 的提示词。对组织政策文件，应用应限制写入来源；对用户偏好，应隔离命名空间；对共享经验，应在写入前校验并保留审计记录。

Filesystem 权限只约束相应文件工具路径。Memory 的入口通过 Backend 直接下载文件，不能默认认为文件工具的读取规则也已经检查了这次下载。Backend、命名空间和加载来源本身需要配置正确，具体权限分工见 [08](08-filesystem-middleware-and-permissions.md)。

## 九、排查记忆未生效时，分别检查三份内容

文件正文、State 快照和模型请求可能处于不同版本。排查时分别检查 Backend 中的正文、`memory_contents` 的值，以及 `modify_request()` 返回的 system message。文件已经更新而快照未变，应检查刷新策略；快照已更新而请求仍缺少内容，应检查来源列表、模板和注入分支。

`libs/deepagents/tests/unit_tests/middleware/test_memory_middleware.py` 与同目录的 `test_memory_middleware_async.py` 包含来源排序、缺失文件、模板校验、注释清理和缓存标记等测试，可以作为改造中间件时的回归入口。

三份内容一致之后，才进入模型行为与提示词质量的排查。请求中包含了正确内容，也不保证模型一定遵守；需要强制执行的规则仍应由工具或业务代码校验。

## 十、延伸阅读

- [07：SkillsMiddleware](07-skills-middleware.md)：专业流程按需读取，与 Memory 全文注入的差异。
- [10：Summarization 与上下文卸载](10-summarization-and-context-offloading.md)：历史消息压缩的触发点和保存范围。
- [17：Prompt Caching](17-prompt-caching.md)：请求前缀与动态 Memory 的缓存标记。
- [21：故障路径与边界验证](21-production-failure-validation.md)：运行状态、模型评分与业务验收如何分开。
- [Agent 系统设计：记忆设计](../../../../notes/agent-system-design/03-view/agent-memory-design.md)：长期上下文的存放、注入与失效。
