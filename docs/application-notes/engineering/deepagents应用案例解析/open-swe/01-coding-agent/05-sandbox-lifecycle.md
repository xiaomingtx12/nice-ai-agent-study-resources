---
sidebar_position: 6
title: 05：沙箱生命周期：工作目录怎样准备、绑定与恢复
sidebar_label: 05：沙箱生命周期
description: 按线程的时间线解释沙箱怎样创建、绑定、重连和启动，连不上与已删除时的不同处理，以及审查、子任务、桌面交接和快照过期的例外。
slug: /application-notes/engineering/deepagents应用案例解析/open-swe/sandbox-lifecycle
---

# 05：沙箱生命周期：工作目录怎样准备、绑定与恢复

> 编码主线中的执行环境专题。说明工具动作落在哪里，以及后续运行怎样接回同一个工作环境。

[01](./01-input-thread-and-workspace.md) 讲运行被创建，[02](./02-deep-agent-assembly.md) 讲工厂装配能力。装配期间还有一件事在后台进行：给这次运行找到一个可用的沙箱。本篇讲这件事。

先看一个场景。周二下午，工程师在 GitHub Issue 里请 Open SWE 修一个缺陷。Agent 改了三个文件、跑过测试、没有提交，运行结束。周四，工程师在同一个 Issue 下评论："再补一个用例。"

这次运行能从检查点恢复对话历史，但**三个未提交的文件只在周二那个沙箱的磁盘上**。周四的运行必须找到那个沙箱；找不到时要判断是暂时连不上还是已被删除——两种情况的处理相反。

三处状态需要对应：线程元数据里的 `sandbox_id` 记录"这个任务属于哪个沙箱"，服务进程里的两张缓存记录"本进程连上了哪些沙箱"，沙箱提供方保存实际的磁盘。源码基线见[源码基线](../source-baseline.md)。

## 一、名词表

| 名词 | 含义 |
| --- | --- |
| 沙箱 | 提供方托管的隔离环境，Agent 在其中读写文件、执行命令 |
| 绑定 | 线程元数据里的 `sandbox_id`，一个线程只记录一个沙箱 |
| 快照 | 新沙箱启动用的基础镜像，不备份线程的修改 |
| 后端 | 实现 `SandboxBackendProtocol` 的对象，提供文件读写和命令执行 |
| 后端句柄 | `SandboxBackendProxy`：工具和中间件持有的稳定对象，内部后端可替换 |
| 凭据代理 | LangSmith 沙箱的出站代理，沙箱访问 GitHub 时代理注入令牌，沙箱内只有占位值 |
| 已删除 / 连不上 | 分别对应 `SandboxGoneError` 与 `SandboxUnreachableError` |
| 交接 | 把线程的检出从旧沙箱搬到新沙箱 |
| 桌面桥 | 用户自己的电脑充当沙箱，绑定值带 `bridge:` 前缀 |

## 二、时间线

| 时刻 | 状态变化 | 代码入口 |
| --- | --- | --- |
| 周二，第一次运行 | 线程没有绑定。创建沙箱、配置凭据代理和 Git 身份、写绑定、发布后端 | `ensure_sandbox_for_thread()` 创建分支 |
| 周二，运行中 | 三个文件写入沙箱磁盘，没有提交 | — |
| 周二晚，闲置 | 闲置 2 小时后沙箱被平台停止，磁盘保留 | `DEFAULT_SANDBOX_IDLE_TTL_SECONDS` |
| 周四，第二次运行 | 读元数据得 `sandbox_id`，连接沙箱，刷新凭据代理，必要时启动沙箱 | `_connect_existing_sandbox()` |
| 沙箱已被删除 | 替换为新沙箱并改绑，工作目录从快照重新开始 | 第六节 |
| 沙箱连不上 | 抛 `SandboxUnreachableError`，保留绑定、通知请求者、运行结束 | 第六节 |

创建时传给 LangSmith 的默认时限：闲置 2 小时（`idle_ttl_seconds`）、停止后 30 天删除（`delete_after_stop_seconds`），都可用环境变量覆盖。`_start_sandbox_best_effort()` 的文档字符串写明：闲置沙箱被**停止而不是删除**，重新启动后磁盘内容和未提交工作随之恢复。

## 三、一次运行怎样等到沙箱

### 1、工厂里启动，运行准备里等待

02 见过这段：工厂创建后端句柄并立即启动连接——

```python title="server.py::build_agent（沙箱启动）"
    backend = get_cached_sandbox_backend(thread_id, reconnect=reconnect_backend)
    if tool_surface is None:
        backend.start()
```

`start()` 用 `asyncio.ensure_future()` 把回调交给事件循环后立即返回，沙箱连接与 MCP 加载、设置读取、中间件组装并行进行。真正等待发生在运行准备里：

```python title="server.py::PrepareAgentRunMiddleware._prepare（节选）"
        sandbox_proxy = get_or_create_sandbox_backend_proxy(self._thread_id)
        sandbox_task = asyncio.create_task(
            retry_transient_sandbox_errors(
                sandbox_proxy.ready,
                description="Sandbox attach",
                max_elapsed=SANDBOX_ATTACH_MAX_ELAPSED,     # 10 分钟
            )
        )
        try:
            async with aphase(self._thread_id, "prepare.await_sandbox"):
                triggering_user_identity, sandbox_backend = await asyncio.gather(
                    triggering_user_identity_task,
                    sandbox_task,
                )
        except (SandboxUnreachableError, SandboxRetryableConnectionError) as exc:
            await post_sandbox_unreachable_notification(
                self._config or {},
                sandbox_id=exc.sandbox_id if isinstance(exc, SandboxUnreachableError) else None,
            )
            raise
```

等沙箱与解析触发者身份并行。连不上时先通知请求者再抛出，运行以失败结束。

### 2、后端句柄：多个调用方共享一次启动

`ready()` 内部：已有后端且没有启动任务时直接返回；否则在锁内确认存在一个启动任务——有重连回调就调用它，没有回调的句柄（工具或后台代码取得的）读元数据里的 `sandbox_id` 用 `connect_sandbox()` 连接。等待用 `shield`：

```python title="sandboxes/state.py（等待启动任务）"
        try:
            sandbox_backend = await asyncio.shield(startup_task)
        except BaseException:
            if startup_task.done():
                async with self._get_lock():
                    if self._startup_task is startup_task:
                        self._startup_task = None
            raise
```

**`shield` 保证等待者被取消时不取消启动任务。** 用户停止运行时等待者被取消，启动继续，下一个等待者接着用同一个结果。任务失败后 `done()` 为真，句柄清空 `_startup_task`，下次 `ready()` 重新启动。三条对应的行为规格（测试断言）：五个并发命令只连接一次；等待者取消后启动任务仍完成；首次启动失败后第二次 `ready()` 重试成功。

## 四、第一次运行：创建沙箱

### 1、用什么启动

新沙箱从哪里启动，由一个数据类的 `resolve()` 决定：

```python title="sandboxes/lifecycle.py::SandboxCreateConfig.resolve"
    @classmethod
    async def resolve(
        cls,
        workspace_slug: str | None = None,
        *,
        source: SandboxSource = "workspace",
    ) -> SandboxCreateConfig:
        workspace = None if source == "base" else await load_workspace(workspace_slug)
        if workspace is not None and workspace.inherit_default_sandbox:
            workspace = await load_workspace(None)
        create_params = workspace.sandbox_create_params() if workspace is not None else {}
        create_params = {**create_params, "preserve_memory_on_stop": True}
        if workspace is None:
            return cls(snapshot_id=None, create_params=create_params)
        return cls(
            snapshot_id=workspace.ready_snapshot_id,
            resources=workspace.sandbox_resources(),
            create_params=create_params,
            workspace=workspace,
        )
```

三条规则：

- **默认读线程所属工作空间**：用它的快照、资源配置和创建参数。
- **`inherit_default_sandbox`**：改用默认工作空间的快照和资源，工作空间自己的提示词不变。
- **`source="base"` 完全跳过工作空间读取**，快照为空。工作空间名缺省时也会解析到 `default` 工作空间，所以"基础"不能靠省略名称表达。

注意 `preserve_memory_on_stop: True` 总会被加入——工作空间里把它设为 `False` 不生效。

`create_sandbox()` 按 `SANDBOX_TYPE` 选提供方。只有 LangSmith 分支接收快照、资源和创建参数，其他提供方只收到沙箱 ID；协程工厂直接等待，同步工厂放进线程执行。它与单事件循环的关系见 [00 的第四节：异步执行与任务续接](../00-overview/00-project-and-frameworks.md#四异步执行与任务续接)。这里看提供方的调用分支：

```python title="sandboxes/providers/registry.py（同步工厂的桥接）"
    if sandbox_type == "langsmith":
        # ……省略 options：只收集非 None 的 snapshot_id、mem_bytes、vcpus 等。
        return await factory(sandbox_id, prepare_work_dir=prepare_work_dir, **options)
    if inspect.iscoroutinefunction(factory):
        return await factory(sandbox_id)
    return await asyncio.to_thread(factory, sandbox_id)
```

### 2、启动、凭据与 Git 身份并行

创建的并行安排：

```python title="sandboxes/lifecycle.py::_create_sandbox_with_proxy（节选）"
    token = (
        asyncio.ensure_future(_proxy_token(thread_id, workspace_slug, github_proxy_repositories))
        if ENV.SANDBOX_TYPE.get() == "langsmith"
        else None
    )
    if token is not None:
        token.add_done_callback(lambda minted: minted.cancelled() or minted.exception())
    try:
        async with aphase(thread_id, "sandbox.boot", snapshot_id=config.snapshot_id):
            sandbox_backend = await config.boot()
    except BaseException:
        if token is not None:
            token.cancel()
        raise

    async with git_identity(thread_id, sandbox_backend):
        if token is not None:
            access = await token
            # ……配置凭据代理、记录令牌到期时间。
```

**令牌不依赖沙箱，所以与启动并行铸造**；沙箱启动失败则取消令牌任务。沙箱起来后，Git 身份写入与"等令牌、配代理"并行。`git_identity()` 是异步上下文管理器：进入时创建写身份的任务，正常退出等待它，异常则取消——身份写入需要沙箱但不需要代理，成本是一次网络往返，冷启动沙箱上这一往返超过一秒，值得藏进并行。这条命令还顺带 `mkdir -p` 并 `test -w` 创建工作目录，成功后缓存结果，后续探测可以省掉。

### 3、先绑定线程，最后发布后端

创建成功的收尾顺序是本篇最重要的一段：

```python title="sandboxes/lifecycle.py::ensure_sandbox_for_thread（节选）"
    if created:
        bind_metadata: dict[str, Any] = {"sandbox_id": sandbox_backend.id}
        if created_proxy_config is not None:
            bind_metadata[SANDBOX_PROXY_CONFIG_METADATA_KEY] = created_proxy_config
        async with aphase(thread_id, "sandbox.bind_thread"):
            await client.threads.update(thread_id=thread_id, metadata=bind_metadata)

    async with aphase(thread_id, "sandbox.handoff"):
        await complete_handoff(thread_id, sandbox_metadata, sandbox_backend)
    await provision_tool_url(thread_id, sandbox_backend)
    published = set_sandbox_backend(thread_id, sandbox_backend)
```

两个顺序各有理由：

- **绑定写在创建并初始化之后**：更早失败的运行不留下 ID，下次运行重新创建，不会接管半成品。
- **发布放在最后**：调用方读句柄缓存时不等待启动任务，提前发布的后端会被运行的其他部分使用，而初始化失败只出现在任务完成回调的日志里。行为规格：创建或绑定失败时断言句柄没有后端，下次 `ready()` 能看到失败。

云服务、线程存储和进程缓存是三个系统，没有事务连接。按代码顺序，各步失败后的状态：

| 失败位置 | 线程与进程已知 | 下一次运行 |
| --- | --- | --- |
| 启动、凭据、Git 身份 | 未写 `sandbox_id`，后端未发布 | 线程无绑定，创建新沙箱；这次的沙箱留给平台时限回收 |
| 写绑定 | 沙箱存在，绑定写入状态未知 | 读元数据再决定 |
| 交接 | 绑定已写，交接标记仍在 | 重连后再次尝试交接 |
| 发布之后 | 工具已在用该沙箱 | 命令失败按任务失败处理 |

## 五、第二次运行：重连

### 1、两张缓存，一份权威记录

`ensure_sandbox_for_thread()` 总是先读线程实时元数据，不用运行配置携带的值——原因在 08 的状态专题展开：排队 run 带的可能是线程已经离开的沙箱。进程里两张缓存：

```python title="sandboxes/state.py（两张缓存）"
# Thread ID -> stable SandboxBackendProxy, shared between server.py and middleware.
SANDBOX_BACKENDS: dict[str, SandboxBackendProxy] = {}

# Sandbox ID -> live connection to it. Keyed by sandbox rather than thread so a
# thread rebound on another worker can never be handed the box it left.
SANDBOX_CONNECTIONS: dict[str, SandboxBackendProtocol] = {}
```

**连接缓存以沙箱 ID 为键，这个选择防住一个具体事故**：线程在另一个工作进程被改绑后，本进程仍持旧沙箱的连接；按线程缓存会把旧沙箱交给它，按沙箱 ID 缓存时元数据里的新 ID 查不到旧连接。

### 2、重连时做什么

`_connect_existing_sandbox()` 优先用连接缓存，没有就 `create_sandbox(sandbox_id)`；`SandboxGoneError` 原样上抛，其他异常包装成 `SandboxUnreachableError`。随后 Git 身份写入与凭据代理刷新并行。函数不先探测沙箱是否存活——文档字符串说明：刷新凭据必须访问沙箱，访问不到会抛同样的错误，探测是多余的。刷新失败同样变成不可达：

```python title="sandboxes/lifecycle.py（代理刷新失败）"
    except Exception as exc:
        logger.warning(
            "Failed to refresh GitHub proxy for sandbox %s on thread %s",
            sandbox_backend.id, thread_id, exc_info=True,
        )
        raise SandboxUnreachableError(thread_id, sandbox_backend.id, str(exc)) from exc
```

凭据代理的仓库范围先与线程记录的令牌范围取交集（`narrowed_repositories()`），不会宽于创建线程时写入的范围（来源见 [01](./01-input-thread-and-workspace.md)）；读取范围失败直接抛出，把失败读成"无限制"会放宽访问。非 LangSmith 提供方没有凭据刷新这一步。

### 3、已停止的沙箱怎样启动

LangSmith 拒绝更新未就绪沙箱的代理配置（返回 400），已停止的沙箱因此在这里被启动：

```python title="sandboxes/providers/langsmith.py::configure_sandbox_proxy（节选）"
        try:
            await _patch_proxy_config(client, url, payload, api_key, sandbox_name)
        except httpx2.HTTPStatusError as exc:
            if exc.response.status_code != PROXY_CONFIG_NOT_READY_STATUS:
                raise
            await _start_sandbox_best_effort(sandbox_name)
            await _patch_proxy_config(client, url, payload, api_key, sandbox_name)
```

启动时限 120 秒，best-effort 失败只记日志，由重试的更新报告真实状态。**周四的运行按这条路径唤醒周二的沙箱，三个未提交文件随磁盘一起回来。**

## 六、连不上与已删除，处理相反

### 1、两类错误从哪里来

`SandboxGoneError` 在整个 `openswe/` 里只有一处抛出——LangSmith 提供方把"资源不存在"转成它：

```python title="sandboxes/providers/langsmith.py（连接失败分类）"
    try:
        return await client.get_sandbox(name=sandbox_id)
    except ResourceNotFoundError as e:
        msg = f"Failed to connect to existing sandbox '{sandbox_id}': {e}"
        raise SandboxGoneError(msg) from e
    except Exception as e:
        msg = f"Failed to connect to existing sandbox '{sandbox_id}': {e}"
        raise RuntimeError(msg) from e
```

其他连接错误一律是 `RuntimeError`，再被包装成 `SandboxUnreachableError`。**其他提供方没有抛 `SandboxGoneError` 的代码**——在 Daytona、Modal 等提供方上，被删除的沙箱表现为"连不上"，线程会一直失败，直到用户新开线程或模型调用 `recreate_sandbox`。

### 2、默认处理

`ensure_sandbox_for_thread()` 的异常分支：

```python title="sandboxes/lifecycle.py::ensure_sandbox_for_thread（异常分支）"
        except (SandboxGoneError, SandboxUnreachableError) as exc:
            if require_existing:
                raise SandboxUnreachableError(...) from exc
            gone = isinstance(exc, SandboxGoneError)
            if not (gone or allow_replacement):
                raise
```

两条理由都写在文档字符串里：

- **连不上默认不替换**：沙箱可能仍在，替换出来的沙箱是空的，悄悄换上等于丢掉未提交的改动，而 Agent 还以为文件在。
- **已删除总是替换**：沙箱不含任何东西了，不替换的话元数据里的失效 ID 会让之后每次运行都去连它，线程永久卡死。

| 观察到的状态 | 默认动作 | 对工作文件的含义 |
| --- | --- | --- |
| 线程没有 `sandbox_id` | 新建并绑定 | 无需接回 |
| 已绑定，连接成功（含启动已停止的沙箱） | 重用 | 保留原目录 |
| 已绑定，提供方报告资源不存在 | 替换并改绑，只写 warning | 原目录已不存在，从快照重新开始 |
| 已绑定，其他连接错误或代理刷新失败 | 抛不可达，保留绑定，通知请求者 | 目录可能仍在 |
| 同上，调用方传 `allow_replacement=True` | 尝试新建；失败仍抛不可达 | 调用方承担重建前提 |
| 任务子线程 | 不创建也不替换 | 见第八节 |

替换时失败的新建被包装回 `SandboxUnreachableError`——调用方靠这个类型识别"这次运行没有沙箱"并通知用户。

### 3、通知请求者

沙箱连不上时，`post_sandbox_unreachable_notification()` 按渠道选投递位置：当前有效的 Slack 线程 → Linear 任务 → GitHub 议题或 PR 评论，都没有时只写日志。默认文案说清三件事：只观察到沙箱不再响应，无法判断它是否恢复；Open SWE 不会自行换新（新沙箱是空的，换上去会丢未提交内容）；用户可以再触发一次让同一沙箱重试，或开新线程。

已删除的沙箱被替换时只写一条 warning 日志——读过的代码里没有向请求者或模型说明"工作目录已经换新"的提示。

## 七、重试与时限

沙箱相关的重试分五层，各针对不同失败：

| 层 | 触发 | 次数与间隔 |
| --- | --- | --- |
| 创建沙箱 | 408/409/425/429/500/502/503/504/529，或四个异常类名 | 3 次，1 秒、3 秒 |
| 更新凭据代理 | 同一组状态码与传输错误 | 3 次，0.5 秒、1 秒或服务端 `Retry-After`；400 时先启动沙箱再试 |
| 单条命令 | 仅 `SandboxRetryableConnectionError`（WebSocket 升级被 5xx 拒绝，命令尚未发出） | 最多 4 次，0.5 秒起翻倍至上限 8 秒，±20% 抖动 |
| 附加沙箱 | 同上 | 不限次数，总时长上限 10 分钟 |
| 命令时限 | 命令超过自身时限再加 30 秒宽限 | 终止命令，返回退出码 124 |

**单条命令只重试"确定尚未开始"的失败**——`is_transient_sandbox_error()` 的文档字符串说明：这类失败发生在执行帧发出之前，重发不会让命令执行两次。

命令时限值得多说一句。LangSmith SDK 的 WebSocket 执行路径没有客户端读取时限，服务端一直不发退出帧时调用会永远阻塞，把整个运行卡住。`TimeoutLangSmithSandbox` 因此用 `run(wait=False)` 取得句柄，在 `asyncio.wait()` 里等结果，超时就终止命令（等待终止最多 5 秒）并返回超时结果；运行被取消时先终止命令再抛取消——已停止的运行不会在沙箱上留下还在跑的命令。WebSocket 连接失败、服务端重载等错误回退到基类的 HTTP 路径。

## 八、不走普通路径的线程

### 1、审查与侦察：允许替换

Reviewer 和 Review Scout 创建沙箱时都显式传 `allow_replacement=True`：

```python title="reviewer.py（审查沙箱，节选）"
        await ensure_sandbox_for_thread(
            thread_id,
            workspace_slug=cfg.workspace_slug,
            github_proxy_repositories=[cfg.repo.full_name] if cfg.repo else [],
            # 审查沙箱只保存每轮都能重新生成的检出目录。
            allow_replacement=True,
        ),
```

理由：审查沙箱只保存 `prepare_review_repo` 每轮都能重新生成的检出目录；审查线程一个 PR 一个，每次推送都再触发，拒绝替换连不上的沙箱会让该 PR 的审查永久卡住。**判断标准是"工作成果能否重建"**——普通沙箱里可能有未提交改动，审查沙箱里没有。

### 2、任务子线程：只接入协调线程的沙箱

带 `task_id` 的线程不走创建与替换，转入 `_attach_task_worker_sandbox()`。权限核对是三段连续的检查，任一不符抛 `PermissionError`：

```python title="sandboxes/lifecycle.py::_attach_task_worker_sandbox（权限核对，节选）"
    # ① 成员关系：本线程是 worker，宿主是同任务的 coordinator
    if (
        context is None
        or not host_id
        or context.membership.role != "worker"
        or context.task.id != worker.task_id
        or host_id != context.task.coordinator_thread_id
        or host_id == thread_id
    ):
        raise PermissionError("The shared sandbox host does not match this worker's task")
    ...
    # ② 宿主与子线程：同一用户、同一工作空间、同样的可见性与管理标记
    if (
        host.sandbox_host_thread_id
        or host.task_id
        or owner.id != host_owner.id
        or worker.workspace != context.task.workspace.slug
        ...
        or worker.admin_thread != host.admin_thread
        or worker.visibility != host.visibility
    ):
        raise PermissionError("The shared sandbox host has different ownership or permissions")
    # ③ 仓库范围：宿主的令牌范围必须是子线程范围的子集
    if worker_repositories is not None and (
        host_repositories is None
        or not {repo.lower() for repo in host_repositories}.issubset(
            repo.lower() for repo in worker_repositories
        )
    ):
        raise PermissionError("The shared sandbox grants repositories outside this worker's scope")
```

通过后用 `require_existing=True` 让协调线程先确保沙箱，再核对协调线程的 `sandbox_id` 没有在此期间变化，把同一个 ID 写进子线程元数据并发布。**协调线程的沙箱连不上或已删除时，子线程抛不可达（提示协调线程必须先恢复），即使传了 `allow_replacement=True`**；`recreate_sandbox` 对子线程直接拒绝。

子线程记录了运行中的后台命令时，接入后触发一次对账，拾取重新接入期间漏掉的完成通知——这依赖原沙箱仍保留任务状态文件，不能推广成"换新沙箱后也能恢复旧结果"。对账细节见 [06](./06-delegation-and-continuation.md)。

### 3、桌面桥与交接

绑定值带 `bridge:` 前缀时，沙箱是用户的电脑：`ensure_sandbox_for_thread()` 读元数据后立刻分流，用 `BridgeSandboxBackend.connect()` 连接，不启动云沙箱、不配凭据代理、不写 Git 身份。这个后端的实现方式值得看，它的文件系统就是跑 CLI 的那台机器：

```python title="bridge/backend.py（模块说明）"
"""A sandbox backend whose filesystem is the machine running the CLI.

``BaseSandbox`` derives ls/read/write/edit/grep/glob/delete from execute plus
the two file transfers, so only those three round trips are implemented here.
Each one queues a request, waits for the CLI to answer it, and turns the answer
back into the deepagents dataclass the agent expects.

A waiter subscribes before it enqueues, so the wake-up it is waiting for cannot
land in the gap between the two, and it re-reads the row on every liveness tick
anyway — a notification that never arrives costs latency only. The liveness tick
is also what keeps a run from waiting out a five-minute command timeout on a
machine that went away.
"""
```

设计要点拆开看：

- **只实现三个往返**（execute、上传、下载），`BaseSandbox` 从这三个推导出其余文件操作——桥上每一次交互都有网络成本，能省的操作都省了。同步方法同样一律拒绝（`_SYNC_UNSUPPORTED`），遵守 00 讲的异步约定。
- **每个操作是一次请求-应答**：先把请求写进 `BridgeStore`（PostgreSQL），CLI 的长轮询取走执行、写回结果，服务端等结果。**先订阅再入队**——防止唤醒落在订阅和入队之间的缝隙里；且每个存活周期（15 秒）重读一次请求行，通知丢了只多花延迟，不丢结果。
- **`connect()` 拒绝代替**：桥不在线直接抛不可达，"Bind to a live bridge, or refuse the run — never replace it"——与第六节"连不上默认保留"的原则一致，桌面上的未提交文件比云沙箱更不能丢。
- **每类操作有自己的等待上限**：命令默认 300 秒加宽限、文件传输 120 秒、worktree 交接 360 秒（桌面端 `git fetch` 60 秒、`git worktree add` 300 秒）。超时或桥失联时把请求标成失败并抛错，不会让运行干等到天荒地老。

线程在云沙箱与桌面之间迁移时，迁移入口在元数据里记下来源沙箱（`sandbox_handoff_from`）。只有所有者的私有线程可以迁到他的电脑，线程正在运行时拒绝迁移。检出本身在下一次运行开始时搬运，三个分支（新建、重连、桥）都会调用：

```python title="sandboxes/handoff.py::complete_handoff"
async def complete_handoff(
    thread_id: str, metadata: Mapping[str, object], target: SandboxBackendProtocol
) -> None:
    """Move the checkout of the sandbox the thread left into ``target``, once."""
    source_id = metadata.get(HANDOFF_FROM_KEY)
    if not isinstance(source_id, str) or source_id == target.id:
        return
    repo = _repo(metadata)
    if repo is not None:
        bundle = f"/tmp/open-swe-handoff-{thread_id}.bundle"
        source = await connect_sandbox(source_id, thread_id=thread_id)
        packed = await _pack(source, repo[1], bundle)
        if packed is not None:
            await _unpack(target, repo, bundle, *packed)
    await get_client().threads.update(thread_id=thread_id, metadata={HANDOFF_FROM_KEY: None})
```

三步对应 `_pack` 和 `_unpack`：

1. **来源沙箱打包**：对临时索引 `git add -A`，取出树，以 HEAD 为父提交生成一个"Open SWE handoff"提交放在 `refs/open-swe/handoff`，用 `git bundle` 打包 origin 上没有的提交。真实的索引和工作区不被改动。
2. **取回并上传** bundle 到目标沙箱。
3. **目标还原**：没有检出就 `gh repo clone`；`git fetch` origin 与 bundle；分支不存在时在交接提交的父提交上新建，存在且落后时移过去，其他情况硬重置；再 `git read-tree -u --reset` 铺上交接提交的树，最后 `git reset` 让改动回到**未提交状态**。

成功后清除标记；来源与目标相同时不动标记；失败抛 `RuntimeError`、标记保留，下一次运行再试。

### 4、显式重建

`recreate_sandbox` 是模型可调用的工具（`Policy(trusted="anywhere")`，跨工作空间要求管理员）。它调用的 `recreate_sandbox_for_thread()` 顺序：拒绝任务子线程、无沙箱线程和桌面桥线程 → 停旧沙箱（限时 10 秒，只有 LangSmith 支持停止，失败不终止流程）→ 创建新沙箱 → 再写 Git 身份 → 写绑定 → 发布后端 → 配置工具地址。旧沙箱没停成功时最后抛 `SandboxRecreationStopError`，工具把它转成 `success: True` 与 `old_sandbox_stopped: False`。

两个顺序细节：写绑定失败时旧绑定和句柄保持不变（行为规格：更新回调里句柄仍指向旧沙箱）；**旧沙箱先于新沙箱被停止**——新建失败时线程仍绑定旧沙箱，下次运行的重连路径还能把它启动回来。

## 九、快照过期：照常启动，不等更新

工作空间可配 `update_script`（如 `git pull`、依赖同步）。两个判定函数的文档字符串把设计说得很清楚：

```python title="workspaces/refresh.py::is_snapshot_stale / is_update_due"
def is_snapshot_stale(record, *, interval_seconds=UPDATE_INTERVAL_SECONDS) -> bool:
    """Whether the image a new sandbox boots from has aged past the interval.

    This gates the update that runs *in the run's own sandbox*, so it keys on
    when the snapshot was captured — not on when a refresh was last attempted.
    Every sandbox gets its own copy of the snapshot, so while the image is stale
    each one needs the script; once a capture lands, they all boot fresh.
    """
    ...

def is_update_due(record) -> bool:
    """Whether a new sandbox should also kick off a background snapshot update.

    Same staleness test, plus: no refresh already running, and the last attempt
    — success *or* failure — is older than the interval. Counting failures keeps
    a broken script or network from enqueueing a builder on every creation.
    """
```

间隔是 1 小时（`UPDATE_INTERVAL_SECONDS`）。新建沙箱后做两件事：把过期的工作空间记入进程内字典 `_STALE_BOOTS`，并用 `_fire_and_forget()` 在 `scheduler` 图上启动一次后台快照更新。**这次运行的沙箱不等更新，照常从旧快照启动。**

构建者是一次性沙箱：从当前快照启动，执行更新脚本，所有脚本退出码为 0 才捕获新快照；任何一步失败旧快照留着。构建者结束后只停止不删除——按 ID 删除是毁掉一个带未提交改动沙箱的办法，回收交给平台时限。每个工作空间每天一次完整重建，按名称哈希把时间错开在 UTC 03:00–05:59。

请求者提醒走另一条路：运行准备在沙箱就绪后查 `_STALE_BOOTS`，有记录且过期超过 **2 小时**（比登记阈值更宽）才提醒——写仪表盘通知，来源是 Slack 时再在线程回复一条。GitHub 和 Linear 渠道没有这条提醒。

---

---

上一篇：[04：上下文管理](./04-context-skills-and-offloading.md)。下一篇：[06：执行协调](./06-delegation-and-continuation.md)。返回[系列导读](../index.md)。
