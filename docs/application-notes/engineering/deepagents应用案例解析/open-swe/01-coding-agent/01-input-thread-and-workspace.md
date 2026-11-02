---
sidebar_position: 2
title: 01：请求接入：身份、线程路由与运行派发
sidebar_label: 01：请求接入
description: 沿 GitHub Issue 评论的接入链，解释事件准入、请求者身份、稳定线程 ID、工作空间路由、凭据范围和运行输入怎样衔接。
slug: /application-notes/engineering/deepagents应用案例解析/open-swe/input-thread-and-workspace
---

# 01：请求接入：身份、线程路由与运行派发

> 编码主线的入口。说明外部请求怎样变成运行输入，到派发边界为止。

Open SWE 从 GitHub、Slack 等渠道接收代码任务。接入层需要把渠道事件转换成一次身份明确、线程可定位、凭据范围已记录的运行请求。本篇沿 GitHub Issue 评论这条路径读源码，到请求交给运行平台为止；图执行、检查点与异步续接见 [00：整体架构](../00-overview/00-project-and-frameworks.md)。

源码基线为 Open SWE `0942b41561df`；本篇核对的接入、线程 ID、工作空间路由与分发文件相对该提交未改，版本范围见[源码基线](../source-baseline.md)。

## 一、接入层交给运行层什么

假设一个 Issue 中有人提及 Open SWE，随后另一位成员补充要求。系统既要把两条请求定位到同一任务，也要重新检查本次请求者，不能把线程复用当成授权继承。主调用链是：

```text title="GitHub Issue 评论的接入调用链"
github/routes.py::github_webhook
  → FastAPI BackgroundTasks
  → github/webhook.py::process_github_issue
  → dispatch.py::dispatch_agent_run
  → dispatch.py::create_durable_run
  → LangGraph SDK runs.create
```

`BackgroundTasks` 是响应发出后在当前进程中执行处理函数的机制。它还不是平台运行队列；`200 accepted` 不代表 `runs.create()` 已成功。响应与派发之间的失败窗口已在概览说明，这里关注派发前准备的数据。

| 交接对象 | 内容 | 用途 |
| --- | --- | --- |
| `RunInput` | 本次送入图的结构化消息，包括正文、作者及事件信息 | 组成模型输入 |
| `SourceContext` | GitHub Issue、PR 或 Slack 线程等来源指针 | 保存任务来源，为回复和后续通知提供位置 |
| 线程元数据 | 工作空间、来源、参与者、可见性与凭据范围等 | 跨运行保存任务的配置与归属 |
| 运行配置 `configurable` | 本次 `github_login`、仓库、工作空间和渠道信息等 | 供 Agent 工厂与工具准备本轮执行条件 |

这几类数据不能混成一段提示词。模型需要看到请求内容，应用还需要在模型之外检查身份、保存权限范围并找到回复位置。

## 二、验证事件来源与请求资格

### 1、签名只解决事件来源问题

`github_webhook()` 读取原始请求体，校验签名后才进入事件解析与分流：

```python title="openswe/github/routes.py::github_webhook（验签节选）"
    body = await request.body()

    signature = request.headers.get("X-Hub-Signature-256", "")
    if not common.verify_github_signature(body, signature, secret=common.GITHUB_WEBHOOK_SECRET):
        common.logger.warning("Invalid GitHub webhook signature")
        raise common.HTTPException(status_code=401, detail="Invalid signature")
```

验签通过只说明请求满足 webhook 的来源校验，不等于评论作者有权启动任务。对本篇的普通 Issue 评论路径，路由还检查事件与动作是否受支持、仓库是否可路由及符合允许名单、发送者是否注册、评论是否提及 Open SWE，并执行公开仓库的组织成员门槛。未满足条件时返回 `ignored`，不进入这条编码任务处理链。

这些条件不能直接套到所有 GitHub 事件。Issue 创建或编辑、PR 审查回复和自动审查分别有自己的入口分支。例如 Issue 创建和编辑不经过评论分支的注册检查，但后续处理仍要求发送者能映射到应用用户。

### 2、无法判断与明确拒绝分开处理

仓库没有工作空间归属时，`repo_is_routable()` 按配置选择接收或忽略；如果读取归属本身失败，则抛出 `WorkspaceLookupError`，路由返回 503。这里区分了“这个仓库不应处理”与“现在无法判断”，没有把存储故障伪装成正常忽略。代码只能证明这个返回分支，不能据此保证 GitHub 会自动重投。

路由还把投递 ID 交给 `EventLog.record()`，但随后并未根据记录结果阻止重复执行。事件日志可以帮助回查来源，不能直接当成这条接入链的运行去重机制。通过准入后，普通 Issue 评论进入 `process_github_issue()`。

## 三、定位线程与工作空间

### 1、外部对象决定稳定线程 ID

GitHub Issue 使用事件中的 Issue ID 生成线程 ID，而不是为每条评论创建新线程：

```python title="openswe/thread_ids.py（两个函数节选）"
def _sha256_uuid(stable_key: str) -> str:
    digest = hashlib.sha256(stable_key.encode()).hexdigest()
    return f"{digest[:8]}-{digest[8:12]}-{digest[12:16]}-{digest[16:20]}-{digest[20:32]}"


def github_issue_thread_id(issue_id: str) -> str:
    return _sha256_uuid(f"github-issue:{issue_id}")
```

同一 Issue 的多次触发得到同一个 ID，接入端不必另外维护“评论到任务”的映射。这个公式属于持久化协议：若直接更换键前缀或计算方式，新的请求就无法按原公式找到已有线程。

稳定 ID 只解决定位。接回任务还依赖线程状态、工作空间、沙箱绑定和本次请求的身份检查；它也不对同一事件的重复投递去重。`thread_exists()` 只有明确读到“未找到”才返回假，其他读取错误按已存在处理并记日志。因此后文的首次与跟进分支，是按这次查询的判断选择，不是按评论序号选择。

### 2、正常续接优先沿用线程归属

工作空间决定运行采用哪组团队配置。GitHub Issue 路径先读取已有线程的工作空间，再回退到仓库路由：

```python title="openswe/github/webhook.py::process_github_issue（工作空间选择，注释译为中文）"
    # 即使仓库后来改由其他工作空间优先使用，跟进仍留在原线程的工作空间。
    workspace = (
        await common.get_thread_workspace(thread_id) if existing_thread else None
    ) or await common.workspace_for_repo_config(repo_config)
```

只要线程记录可读且有工作空间，仓库后来更改归属不会迁移这个任务。线程记录缺失或读取失败时，`get_thread_workspace()` 返回 `None`，才进入仓库查询；仓库无归属或该查询失败时最终使用 `default`。这是一条有降级分支的优先级规则，不是无条件保持原归属的保证。

这里与准入层的失败处理不同：准入层不知道是否应接收时返回 503；已经进入处理链、需要选择运行配置时则允许退到默认工作空间。代价是查询故障期间可能采用默认配置。

Slack 等调用通用 `resolve_workspace()` 的路径还会考虑开场消息指定、频道归属和用户默认值，但已有线程的工作空间仍优先。**工作空间路由只选择配置，不代表授予相应仓库权限。**

## 四、请求者身份、访问凭据与线程权限

### 1、请求者身份不等于 GitHub API 的执行身份

`process_github_issue()` 从事件的 `sender` 读取登录名，并通过应用用户记录查邮箱。没有映射就退出：

```python title="openswe/github/webhook.py::process_github_issue（身份检查节选）"
    email = await User.email_for_login(github_login) or ""
    if not email:
        common.logger.warning("No email mapping for GitHub user '%s', skipping", github_login)
        return
```

本次 `github_login` 和 `github_user_id` 随后写入运行配置，供下游识别触发者。即使线程已经存在，本轮输入和配置仍反映当前请求者；线程创建时记录的所有者与本轮请求者是不同字段。

但不能由“查到了邮箱”推导出“本轮使用该用户的 token”。处理器随后调用的 `get_or_resolve_thread_github_token(thread_id, email)` 在当前实现中直接丢弃 `email`，清理旧缓存并获取 App 安装 token：

```python title="openswe/webhooks/common.py::get_or_resolve_thread_github_token（函数体节选）"
    del email
    await invalidate_cached_github_token(thread_id)
    bot_token, expires_at = await get_github_app_installation_token_with_expiry()
    if bot_token:
        cache_github_token_for_thread(
            thread_id, bot_token, expires_at=expires_at, is_bot_token=True
        )
        return bot_token
```

这段证明的是 webhook 处理路径获取 GitHub 访问凭据的方式，不能外推成所有渠道和所有工具都使用同一种身份。接入层保留“谁提出请求”，访问 GitHub 时使用的凭据则按对应路径解析。

### 2、仓库范围在线程创建时记录

`event_token_repositories()` 决定事件发起的线程是否需要限制沙箱 token 的仓库范围：

```python title="openswe/github/token_scope.py::event_token_repositories（省略文档字符串）"
def event_token_repositories(owner: str, name: str, *, private: bool | None) -> list[str] | None:
    if private is True:
        return None
    return [f"{owner}/{name}"]
```

`None` 表示不额外按仓库收窄，保留 GitHub App 的安装范围；公开或可见性未知的仓库则限定到事件所属仓库。“没有额外收窄”不等于可以访问安装范围之外的仓库。

`upsert_agent_thread_metadata()` 保存来源与参与者，并在创建线程或补齐尚未初始化的空线程时写入所有者、可见性和 `github_token_repositories`。正常更新已有线程时，这些创建字段不因换一位发言者而重写；原有 `SourceContext` 也优先保留，避免后续请求改掉任务来源。

### 3、需要收窄时，保存失败就不派发

处理器先计算范围，再保存元数据。两步的结果直接决定能否继续：

```python title="openswe/github/webhook.py::process_github_issue（保存与拒绝分支，中间参数省略）"
    token_repositories = common.event_thread_token_repositories(repo_config, payload)
    persisted = await common.upsert_agent_thread_metadata(
        thread_id,
        ...
        workspace=workspace,
        token_repositories=token_repositories,
    )
    if not persisted and token_repositories is not None:
        common.logger.error(
            "Not starting a GitHub issue run whose token scope could not be recorded",
            extra={"agent_thread_id": thread_id},
        )
        return
```

需要限定仓库却没保存成功时，处理器不会继续派发，以免后续准备沙箱凭据时缺少范围记录。若 `token_repositories is None`，这个分支不因保存失败而退出，不能概括成“任何元数据保存失败都禁止启动”。

这也说明工作空间和凭据范围需要分别处理：前者查询失败可以退到默认配置，后者需要收窄却无法记录时必须中止这次派发。它们影响的边界不同。

## 五、构造输入并派发运行

### 1、首次加载上下文，跟进只补本次输入

“首次”指线程查询判定不存在的分支。处理器读取 Issue 描述和评论列表；若列表里缺少当前触发评论，就补入并按时间排序，然后交给 `_github_issue_run_input()`。已有线程则通过 `_github_human_run_input()` 只构造本次评论或 Issue 更新，不重复注入整段历史。

| 处理对象 | 首次分支 | 跟进分支 |
| --- | --- | --- |
| 输入内容 | Issue 信息、描述与已取得的评论 | 当前评论或 Issue 更新 |
| 工作空间 | 仓库路由，必要时退到默认值 | 优先读取原线程记录 |
| 创建字段 | 保存所有者、可见性与需要收窄的仓库范围 | 正常情况下保留原值 |
| 本次身份 | 当前事件触发者 | 当前事件触发者，不自动沿用首位发言者 |

首次输入把 webhook 系统身份与评论作者分开表示。`_github_issue_run_input()` 维护 `introduced` 集合，只为集合中尚未出现的作者添加人物介绍；触发者预先记入集合，不在这段循环里重复介绍。每条正文仍保留作者与事件信息，并按可信作者信息进行包装。消息信封与上下文可见性的细节见 [04：上下文管理](./04-context-skills-and-offloading.md)。

这里的内容包装不代替准入与凭据限制。某位作者的正文被作为历史上下文读入，也不等于系统授权该作者启动运行。

### 2、统一派发入口接收整理好的输入

GitHub Issue 处理器把已构造的 `run_input` 与本次 `configurable` 分开交给统一入口：

```python title="openswe/github/webhook.py::process_github_issue（派发节选）"
    await common.dispatch_agent_run(
        thread_id,
        None,
        configurable,
        source="github_issue",
        thread_title=None,
        input=run_input,
        metadata=common.AGENT_VERSION_METADATA,
        client=langgraph_client,
    )
```

这里没有再传一份正文，避免在完整 `RunInput` 外重复包装消息。`thread_title=None` 表示线程标题已交给前面的元数据保存流程处理；`source="github_issue"` 标识这次派发的来源，默认目标仍是 `agent` 图。

`dispatch_agent_run()` 规范输入与身份信息后调用 `create_durable_run()`。平台运行创建成功后，请求才越过接入层的派发边界；这仍不等于编码完成。运行冲突、检查点和事件流参数沿用 [00 的运行契约](../00-overview/00-project-and-frameworks.md)，本篇不重复展开。

## 六、其他渠道怎样复用接入契约

渠道入口负责各自的认证、准入和任务定位，再组织运行输入与配置。可以复用统一派发，不必把每个渠道都改造成 GitHub Issue 的消息格式。

| 入口 | 身份与任务定位的差别 |
| --- | --- |
| Slack | 从 Slack 身份及账号关联进入用户体系；按频道和消息线程解析任务，工作空间还受频道绑定影响 |
| Linear | 由 Linear 入口完成准入与身份解析，使用 `linear_issue_thread_id()` 按 Issue 定位线程 |
| PR 审查 | 按仓库、PR 编号与审查用途定位独立线程，派发目标为 `reviewer`，实现见 [11](../03-review-and-merge/11-reviewer.md) |
| 网页 | 根据已验证会话与线程权限处理新建、跟进和运行中输入，不依靠 webhook 签名 |

新增入口时需要明确的是外部对象怎样映射到线程、本次请求者怎样验证、哪些配置应跨运行保留，以及凭据范围保存失败时是否还能派发。到这里，请求内容、配置归属和访问边界已经分开，后面的 Agent 装配才有可靠的输入。

---

上一篇：[00：整体架构](../00-overview/00-project-and-frameworks.md)。下一篇：[02：Agent 装配](./02-deep-agent-assembly.md)。返回[系列导读](../index.md)。
