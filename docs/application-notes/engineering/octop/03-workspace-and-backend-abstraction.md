---
title: Octop：工作区与后端抽象
sidebar_label: 工作区与后端抽象
---

# Octop：工作区与后端抽象

> 源码基线：Octop `v1.0.2`，commit `dd9dce470844c25d59effb50615bb3c667ea25cd`；octop-harness `v1.0.5`，commit `76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac`。两个项目按各自版本快照独立阅读，本文没有将它们拼成一次运行时测试。

Octop 是面向个人和团队的 Agent 平台，支持在网页或消息渠道中接收任务、处理文件并调用工具。它的 Agent 工作区可以使用本地文件系统、容器沙箱和对象存储等不同后端。调用者传入 `SOUL.md` 这样的工作区相对路径后，平台需要将它转换成后端可以读写的位置。同一个路径还要供 Dashboard、技能加载和附件处理使用。

本文沿着后端配置、工作区建立、路径映射、文件读写和命令执行展开。octop-harness 是 Octop 使用的 Agent 运行库；其中的 `BackendWorkspace` 是工作区文件操作门面，负责许多平台侧操作的路径转换和读写封装。部分 Agent 中间件直接访问后端，排查时也需要跟踪这些调用。文中源码链接指向对应仓库的固定 commit。

## 一、Agent 配置怎样变成工作区

### 1、Octop 先解析后端配置

Agent 配置中的 `backend` 可以直接写后端 spec（描述后端类型与参数的配置），也可以引用已保存的存储配置。`named` 按名称引用存储记录；`composite` 组合一个默认后端和若干按路径前缀分流的子后端。它们都属于配置层，尚未创建连接。

Octop 的 `_backend_spec_for_row` 为单个 Agent 整理 spec，包括补默认值、展开引用和调整平台参数。它调用 resolver 递归展开 `named` 与 `composite`，再由 `row_to_backend_spec` 把存储记录的通用字段转换为 harness 所需字段。例如 `shell` 映射为 `local_shell`，COS 的 `access_key` 映射为 `secret_id`。默认后端在 POSIX 上沿用 `local_shell`、`root_dir="/"` 和虚拟路径模式；Windows 使用 Agent 工作区作为本地根。默认值见 [resolver.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/backend/resolver.py#L16-L31)，平台装配见 [manager.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/manager.py#L3351-L3403)。

`named` 引用由 [resolver.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/backend/resolver.py#L79-L126) 展开；行字段转换由 [adapter.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/backend/adapter.py#L44-L155) 完成。常见类型映射如下：

| Octop 存储类型 | Harness spec | 文件位置特征 |
| --- | --- | --- |
| `filesystem` | `filesystem` | 宿主根目录上的文件系统操作 |
| `shell` | `local_shell` | 本地文件操作，并提供命令执行协议 |
| `docker` | `docker` | 容器中的工作区文件与命令 |
| `opensandbox` | `opensandbox` | 远端沙箱文件与命令 |
| `cos`、`s3`、`oss`、`obs`、`custom` | 对象存储 spec | 对象键，不是宿主文件路径 |
| `postgres` | `postgres` | 后端定义的数据库存储位置 |

表格概括主仓 adapter 处理的映射，不代表这些类型具有完全相同的文件语义或执行能力。对象存储 spec 也不提供 shell 执行协议。

### 2、Harness 构造后端，再绑定工作区

Octop 把解析后的 spec 或需要复用的后端实例交给 harness。`resolve_backend` 是 harness 的后端工厂：它按 spec 的 `type` 构造实例，也接受预先构造的后端。`HarnessAgent` 是 harness 的 Agent 运行对象，它取得后端后再映射工作区路径，并创建 `BackendWorkspace`。关键调用顺序见 [agent.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L169-L177)：

```python
self._backend = self._build_backend()
# 后端实例可用后，再按实际挂载关系映射工作区路径。
self._workspace_path = self._host_workspace_path()
self._workspace = BackendWorkspace(
    self._backend,
    self._workspace_path,
    system_files_path=self._config.system_files_path,
)
self._wire_workspace_dotenv_for_execute()
```

后端先创建，因为 Docker 或远端沙箱的挂载和工作区视图会影响 workspace 路径如何解释。`BackendWorkspace` 保存后端实例、工作区位置和系统文件前缀，为 harness 工具与 Octop 的文件操作提供统一入口。工厂对本地、沙箱和远端存储分别构造不同实现，见 [backends/__init__.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/__init__.py#L91-L120)。

### 3、工作区路径和后端根目录是两种配置

`workspace_dir` 表示 Agent 工作区；`root_dir` 表示本地类后端的文件系统根。启用 `virtual_mode`（虚拟路径模式）后，后端可见的 `/` 映射到这个根。Octop 为限定范围的 `root_dir` 创建默认工作区时，宿主目录采用 `{root_dir}/.octop/workspaces/<id>/`，持久化给 Agent 的路径采用 `/.octop/workspaces/<id>`。用户明确指定的工作区路径优先。宿主目录、Agent 工作区和后端虚拟根由此分别表示，避免重复拼接根目录。该映射规则见 [workspace/dir.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/workspace/dir.py#L1-L23)。

在 Windows 上，Octop 还会把本地后端显式配置的 `/`、空根或 `\` 改为 Agent 工作区，以免 `/` 被解析到不相关的当前盘根目录；composite 中明确配置的路由子后端则不改。具体见 [resolver.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/backend/resolver.py#L34-L65)。这是平台的路径适配，不改变后端类型或其执行权限。

## 二、一个路径怎样映射到不同后端

### 1、调用者、工作区和后端各有路径坐标

平台接口与工具通常传工作区相对路径，如 `SOUL.md`、`inbound/report.pdf`。主机文件操作可能使用 `D:\...\SOUL.md` 这样的绝对路径；虚拟后端接收 `/SOUL.md` 一类协议路径；对象存储则接收对象键。`BackendWorkspace.resolve_path` 主要负责解析为本机路径或虚拟路径，`_backend_storage_key` 负责生成可交给后端协议的键，两者用途不同。

对于普通本地后端的相对路径，`resolve_path` 以 `workspace_dir` 为基准，并在解析后检查结果仍位于工作区内；逃逸工作区会抛出 `PermissionError`。沙箱文件系统的分支则返回虚拟路径，由后端继续处理。以 `/` 开头的绝对路径，在 `virtual_mode` 下可能经后端 `_resolve_path` 映射到宿主路径；`~` 路径则按主机规则展开。代码见 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L455-L503)。

这项路径包含性检查约束文件寻址；shell 命令还需要独立的进程隔离。它也不表示任意以 `/` 开头的路径都等同工作区相对路径。Dashboard 会根据 `from_workspace` 区分工作区 UI 中的 `/logo.png` 与主机绝对路径；路径会先规范化，再交给 workspace，见 [workspace.py API 路由](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/api/routers/workspace.py#L87-L109)。

### 2、后端类型决定存储键布局

同一个 `SOUL.md`，经 `_backend_storage_key` 会映射成不同形式：

- Docker 和 OpenSandbox 没有宿主挂载的工作区文件系统，路径通常摊平为沙箱内的 `/SOUL.md`。
- COS、S3、OSS、OBS 和 PostgreSQL 使用远端工作区虚拟根，例如 `/.octop/workspaces/<id>/SOUL.md`，避免将宿主 home 目录写入对象键。
- 有宿主挂载的后端根据 mount、`root_dir` 或 `cwd` 将工作区位置映射到虚拟键。

远端工作区根由 `remote_workspace_virtual_root` 根据工作区路径确定；若已是 `/.octop/...` 形式则沿用，否则使用工作区目录名作为标识。下面是 `_backend_storage_key` 的无宿主挂载分支，此前已将输入规范化为工作区相对片段 `rel_posix`。云存储加上工作区虚拟根，其他无挂载后端使用 `/` 开头的虚拟路径：

```python
# 节选：无宿主挂载时，按后端类型生成协议路径。
if not _has_backend_mount(self._backend):
    if is_cloud_storage_backend(self._backend):
        root = remote_workspace_virtual_root(workspace)
        return root if not rel_posix else f"{root}/{rel_posix}"
    return "/" if not rel_posix else f"/{rel_posix}"
```

存储键构造见 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L335-L347) 和 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L505-L556)。

读取远端对象时，harness 先尝试带工作区根的新键，再兼容旧版扁平键；写入则使用规范的新键。兼容候选由 [_candidate_storage_keys](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L573-L599) 生成。后端迁移或升级时，这种读旧写新的做法能逐步接管历史文件，但不能据此假定旧对象会自动搬迁或删除。

### 3、系统文件前缀是逻辑路径的另一层映射

Octop 创建 Agent 时固定 `system_files_path` 为 `.octop`，不允许用户把它当普通后端配置覆盖，见 [manager.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/manager.py#L781-L787)。Harness 只为约定的系统目录和文件加此前缀，例子包括 `skills`、`agents`、`sessions`、`.env` 和 `memory.sqlite*`。因此逻辑路径 `skills/report/SKILL.md` 可落在 `.octop/skills/report/SKILL.md`，而 Agent 的 `SOUL.md`、`AGENTS.md` 等工作区内容仍在根目录。

`apply_system_files_prefix` 负责识别系统条目，`system_read_roots` 和 `_read_fragments` 还为部分旧版 `skills/`、`agents/` 根目录保留读取回退；写入走规范前缀。详见 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L108-L157) 和 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L396-L435)。这层系统目录映射发生在后端类型对应的存储键转换之前，二者不能混为一条规则。

## 三、平台怎样读写工作区文件

### 1、HTTP 路由复用同一个文件操作门面

Dashboard 的文本读取、目录列表和二进制上传等接口会经过属主校验并取得 Agent 的 `BackendWorkspace`，再调用 `aread_text`、`als` 或 `aupload_bytes`。运行中的工作区由 Agent 实例提供；特定展示文件可以通过 registry 取得停止状态 Agent 的工作区。`require_running_workspace` 在 Agent 重建窗口里也会短暂回退到 registry，但不会把已停止 Agent 的编辑权限伪装成运行态。入口逻辑见 [api/common/workspace.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/api/common/workspace.py#L37-L91)。

### 2、文本与字节操作落到后端协议

`BackendWorkspace.read_text` 先检查可用的本地物化路径，再按后端存储键调用后端读取，并尝试候选旧键。不存在或可恢复的后端读取错误可能最终得到 `None`，而不是内容字符串。`write_text` 默认不覆盖已有内容；需要覆盖的调用可指定 `force`。异步上传则在后端支持 `aupload_files` 时直接调用，否则回退到同步上传封装。相关实现见 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L718-L797) 和 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L861-L897)。

`AgentBackedMediaBackend` 是消息渠道媒体存储接口到 Agent 工作区的适配器。它的 `save` 接收文件字节和入站文件键，检查大小后，把键转换为 `inbound/` 下的相对路径并上传。后端差异由 workspace 内部处理，媒体入口不需要判断容器或对象存储：

```python
# 节选自 AgentBackedMediaBackend：验证入站大小，再通过工作区上传。
async def save(self, data: bytes, key: str) -> None:
    validate_inbound_size(data, max_bytes=self._max_bytes)
    await self._workspace.aupload_bytes(inbound_rel_path(key), data)
```

`read` 通过同一个工作区下载；Dashboard 上传也调用 `aupload_bytes`。这让附件与 Agent 文件落在同一后端工作区，见 [ingress.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/gateway/media/ingress.py#L14-L37) 和 [workspace.py 路由](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/api/routers/workspace.py#L395-L424)。

对无宿主挂载的后端，`materialize_local` 可把远端文件下载到 `.harness-materialize/` 供本地适配器投递。这个本地目录用来交付文件，远端工作区仍保存权威副本，见 [workspace.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/workspace.py#L1111-L1157)。

### 3、门面并未覆盖所有框架调用

harness 会把 `BackendWorkspace` 提供给自己的文件工具和路径辅助函数，但 Deep Agents 的部分中间件仍直接持有 backend。例如记忆中间件从 `self._backend` 接收 backend；创建 Deep Agent 时 `backend` 参数同样传入 `self._backend`，见 [agent.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L1279-L1286) 与 [agent.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/agent.py#L1744-L1750)。Octop 装配 Agent 时也可能根据远端后端或协议适配情况将 workspace 中的 backend 传给 harness，见 [manager.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/agents/manager.py#L3995-L4034)。

因此，排查某项文件行为时要沿实际消费者追调用：如果它使用 `BackendWorkspace`，检查路径转换、物化和回退；如果它直接调用 backend，则继续核对 Deep Agents 协议及具体 backend 的路径语义。不能只因 Agent 上存在 workspace 门面，就推断所有上层文件 I/O 都会经过它。

## 四、文件后端怎样衔接命令执行

### 1、文件协议和执行协议分别声明能力

文件后端协议 `BackendProtocol` 提供文件操作；`SandboxBackendProtocol` 在此基础上提供 `execute`。Harness 的 spec 能否执行命令取决于最终后端实例，不是路径是否经过 `BackendWorkspace`。`filesystem` 和对象存储不因此获得 shell 能力；`local_shell`、Docker 和 OpenSandbox 才是本文范围内的执行后端。

### 2、本地后端是否隔离，要看工厂分支

bubblewrap 是 Linux 上用于建立进程与文件系统隔离的工具，命令名为 `bwrap`。Harness 的 `local_shell` 工厂只在 Linux、启用 `virtual_mode`、根目录范围小于宿主根且可找到 `bwrap` 时选择 `BubbledLocalShellBackend`，即使用 bubblewrap 的本地执行实现。其他情况下选择 `HarnessLocalShellBackend`，它负责虚拟路径翻译，并通过宿主 shell 在工作区目录执行命令。

选择条件见 [bwrap_shell.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/bwrap_shell.py#L47-L65)，工厂分支见 [backends/__init__.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/__init__.py#L325-L355)，宿主执行见 [local_shell.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/local_shell.py#L326-L335)。将 `root_dir` 收窄会影响文件映射；宿主 fallback（未启用沙箱时的回退实现）仍以宿主用户权限运行命令。部署时必须确认实际选择的执行实现。

### 3、环境变量按执行入口合并

Octop 的全局环境文件 `~/.octop/env` 与 Agent 工作区的 `.env` 服务不同范围。主仓将全局文件合入平台进程环境；本地命令再通过工作区读取器取得 Agent 的 `.env`。Docker、MCP 和 ACP 子进程各有自己的合并入口，不能用一条优先级规则概括。主仓全局文件装载见 [env_file.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/utils/env_file.py#L117-L133)。

下表中的箭头表示后项覆盖前项同名键，但覆盖还受各入口的保护规则约束：

| 执行入口 | 合并顺序 | 保护与刷新规则 |
| --- | --- | --- |
| 宿主 shell | 进程环境 → 显式 `extra` → 工作区 `.env` | 默认继承进程环境；每次执行刷新。仅工作区文件这一层跳过保护键，显式 `extra` 可覆盖 |
| Docker | 最小环境 → 全局配置 → 工作区 `.env` | 不复制全量宿主环境；全局层不能覆盖 `PATH` 和保护键，工作区层可设置 `PATH`，但仍跳过保护键 |
| MCP stdio（通过标准输入输出通信的工具服务） | SDK 默认环境子集 → `spec.env` | Octop 构造配置时先过滤全局配置中的保护键，再合入显式 `spec.env`；显式值优先 |
| ACP（Agent Client Protocol）子进程 | 进程环境 → 宿主工作目录的 `.env` → `runner_config.env` | 新建会话、启动子进程时合并；工作目录文件跳过保护键，显式 runner 配置可覆盖 |

前三类规则见 [runtime_env.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/runtime_env.py#L159-L211)，主仓 MCP 配置叠加见 [env_file.py](https://github.com/TencentCloud/Octop/blob/dd9dce470844c25d59effb50615bb3c667ea25cd/src/octop/infra/utils/env_file.py#L140-L154)，ACP 启动见 [acp/service.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/acp/service.py#L211-L235)。ACP 直接读取宿主工作目录文件，不经过 `BackendWorkspace`。

这里的保护键也分两套：harness 包括 `HOME`、用户身份、当前目录、临时目录、Windows 系统目录及 `OCTOP_` 前缀；主仓 MCP 全局配置过滤的集合更小。它们约束特定来源的覆盖行为，不能据此推断所有环境入口都会拒绝这些键。

Docker 工作区 `.env` 有 2 秒缓存。经后端 `write/edit` 修改 `.env` 会主动使缓存失效；其他路径修改容器可见文件后，缓存过期后的下一次执行才会重新读取。没有后台定时刷新，任意宿主文件改动也不会自动进入容器。见 [docker_sandbox.py](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/docker_sandbox.py#L920-L958) 与 [写入失效分支](https://github.com/TencentCloud/octop-harness/blob/76cd38d7b8ffc66c28ba24ad60bbab206a95d3ac/src/octop_harness/backends/docker_sandbox.py#L752-L770)。因此，修改工作区 `.env` 后，应按具体执行入口判断何时生效。

## 五、工程收益与使用边界

### 1、抽象收敛文件 API，不抹平后端差异

`BackendWorkspace` 让模板、技能、媒体、Dashboard 文件接口等调用者使用相同的相对路径和文本/字节操作入口。调用者不必分别编写 S3 对象键、容器路径和宿主路径逻辑。但它不会让所有后端支持相同操作：某些目录操作、glob 或执行能力可能不存在，远端无挂载文件的本地路径也可能只是临时下载结果。应用需要检查返回值与 `BackendOperationNotSupportedError` 等错误。

Octop 与 harness 还保留少量边界适配：主仓将存储行转成 harness spec；兼容层为旧读/列目录协议调整返回值；Admin 后端探测用临时数据做读写验证；管理端目录浏览器另有自己的实例缓存和操作锁。这些机制分别服务配置兼容、连接检查和管理界面，不构成 Agent 工作区读写正确性的替代证明。Admin 缓存按后端标识在后续获取时惰性检查空闲状态，不是独立定时器保证的固定回收时刻。

### 2、照搬时先明确路径与信任边界

可以沿用的设计是：把调用者路径定义成工作区相对片段，在一个明确的门面中做路径解析与协议转换，并让后端能力由协议显式表达。系统目录前缀、用户文件路径、宿主绝对路径和远端对象键也应分别建模，避免拿字符串拼接掩盖坐标转换。

需要按部署条件改造的是默认本地执行后端。宿主 shell 即使限制了 `root_dir`，也不能据此断言进程已被隔离；要核对是否真正启动了容器或系统级沙箱，并为无沙箱的环境设定合适的权限策略。也要为远端存储的旧键读取、物化缓存和 `.env` 更新约定生命周期，避免把兼容回退或投递副本误认为一致性保证。

本文依据上述固定源码快照梳理调用与路径规则，没有运行构建或集成测试。有关后端可用性、操作系统隔离和实际云端权限的结论，仍需在目标部署配置中验证。

---

**相关阅读**

- [02、Agent Turn 执行链路](./02-agent-turn-execution.md)
- [Octop 工程拆解索引](./index.md)
- [04、Skill、Expert 与 Plugin](./04-skills-experts-plugins.md)
