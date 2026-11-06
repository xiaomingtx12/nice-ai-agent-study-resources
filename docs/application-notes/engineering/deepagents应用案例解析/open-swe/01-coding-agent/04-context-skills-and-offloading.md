---
sidebar_position: 5
title: 04：上下文管理，模型每轮能看到什么
sidebar_label: 04：上下文管理
description: 按一次模型请求的组成，解释消息怎样带上发送者身份，系统提示怎样渲染，目录规则、Skills、集成工具和历史摘要分别在什么时刻进入请求。
slug: /application-notes/engineering/deepagents应用案例解析/open-swe/context-skills-and-offloading
---

# 04：上下文管理，模型每轮能看到什么

> 编码主线中的模型输入专题。沿装配与中间件接入点，追踪每轮请求中的材料；不要求先读完沙箱实现。

[01](./01-input-thread-and-workspace.md) 讲请求怎样变成运行，[02](./02-deep-agent-assembly.md) 讲装配了哪些能力，[03](./03-middleware.md) 解释规则怎样接入调用循环。本篇沿模型输入展开：**这次调用的请求里有什么，每一部分在哪个时刻、由哪段代码放进去**。沙箱的创建和重连另见 [05](./05-sandbox-lifecycle.md)。

以一个持续多轮的 Issue 任务为例。周二，工程师在 GitHub Issue 里请 Open SWE 修 `src/api/` 下的缺陷，会话持续很多轮，中途被自动摘要过一次。周四，另一位同事在同一个 Issue 下评论"再补一个用例"。周四那次模型调用看到什么，取决于周二留在线程里的内容和周四新补的内容。源码基线见[源码基线](../source-baseline.md)。

## 全景：一次请求里的六类材料

| 材料 | 保存位置 | 何时进入请求 |
| --- | --- | --- |
| 系统提示 | 状态字段 `rendered_system_prompt` | 运行准备时渲染，每次调用放到最前 |
| 消息历史 | `messages` | 外部输入包成带发送者的 XML 信封；介绍块是独立消息 |
| 目录规则 | `messages`（追加在工具结果里） | 模型 `read_file` 时沿途补 `AGENTS.md` |
| Skills 目录 | 状态字段 `skills_metadata` | 框架中间件写进系统消息 |
| 集成工具定义 | `loaded_integration_tools` | 加载后每次调用按模型能力插入消息或工具列表 |
| 摘要 | `_summarization_event` | 请求里早期消息被摘要加截止后消息取代 |

排查"模型为什么没按某条规则做"，先判断这条规则属于哪一类，再去对应位置查。

## 一、外部消息怎样带着身份进入历史

应用不把外部文字直接放进历史。每条输入先包成 `input-message` 元素，记下发送者、来源和类型：

```python title="input_messages.py::_serialize_message（节选）"
sender_id = _validate_entity_id(context["sender_id"])
attributes = [
    f'sender="{_xml_attr(sender_id)}"',
    f'surface="{context["surface"]}"',
    f'kind="{context["kind"]}"',
]
```

发送者 ID 必须带命名空间前缀（`github:octocat`、`slack:U123`、`system:thread-queue`），不含空白和尖括号引号。`surface` 有八种取值，`kind` 只有 `human` 和 `system`——两种信封在模型看来角色都是 `user`，真正的系统提示是下一节的内容。

正文用 `_xml_text()` 转义、属性用 `_xml_attr()` 转义，所以正文写不出提前闭合的标签、加不上自己的 `sender` 属性（行为规格：把 `<fix a="b"> & continue` 放进信封再用 ElementTree 解析，取回原文）。多模态里的图片等非文本块按原顺序保留，只有文本块被包装。校验函数只管格式——发送者是否可信由入口验证决定（01）。

第二种元素 `dynamic-context` 向模型介绍"这个人是谁、这个频道是什么"。每个块带一个哈希：去掉 `hash` 属性后的规范化 XML 的 SHA-256。哈希用来去重，但"已经出现过"不能直接查整个检查点——**摘要会把早期消息从请求里拿掉**：

```python title="input_messages.py::visible_dynamic_context_hashes"
messages = state.get("messages")
if not isinstance(messages, (list, tuple)):
    return set()
event = state.get(SUMMARIZATION_EVENT_KEY)
cutoff = event.get("cutoff_index") if isinstance(event, Mapping) else None
if isinstance(cutoff, int) and cutoff >= 0:
    messages = messages[cutoff:]
return dynamic_context_hashes_from_messages(messages)
```

文档字符串写明原因：截止位置之前的介绍块还在状态里、已经不在提示里；仍当它"已介绍"，模型会面对一个自己正在读的发送者却找不到介绍。队列消息消费、回复守卫、任务协调、Slack webhook 和下一节的人物块都用这同一个"可见范围"函数。

## 二、系统提示在运行准备里渲染

02 见过：工厂传给 `create_deep_agent` 的系统提示是空字符串。真正的提示由 `PrepareAgentRunMiddleware` 在运行准备时渲染，存进状态字段 `rendered_system_prompt`（准备指纹见 08 的状态专题），每次调用模型前放到系统消息最前。

渲染入口是 `construct_system_prompt()` → `prompt("system/main", ...)`。**模板本身就是答案，值得整段看**：

```jinja title="resources/prompts/system/main.md.jinja（全文）"
{{ working_environment_section }}

{{ dashboard_context_section }}

{{ source_guidance_section }}

{% include "system/self-awareness.md" +%}

{% if default_prompt_section %}
{{ default_prompt_section }}

{% endif %}
{% if default_repo %}
When a repository is not explicitly mentioned, use `{{ default_repo }}`.

{% endif %}
{% if repository_scope_section %}
{{ repository_scope_section }}

{% endif %}
{% include "system/repository-setup.md.jinja" +%}

{{ collaboration_section }}

{% include "system/task-execution.md" +%}

{% include "system/dependencies.md" +%}

{{ external_untrusted_comments_section }}

{% if continued_from_collaborative %}
{% include "system/continued-from-collaborative.md" +%}

{% endif %}
{% include "system/commit-pr.md" +%}

{% if desktop %}
{% include "system/commit-pr-desktop.md" +%}

{% endif %}
{% if repo_instructions_section %}
{{ repo_instructions_section }}

{% endif %}
{% if recent_thread_context_section %}
{{ recent_thread_context_section }}

{% endif %}
{% if workspace_section %}
{{ workspace_section }}

{% endif %}
{% if admin_workspaces %}
{% include "system/admin-workspace.md" +%}
{% else %}
{% include "system/workspace-admin-required.md" +%}
{% endif %}
{% if sole_writer %}

{% include "system/sole-writer.md" +%}
{% endif %}

{% include "system/shared-base.md" +%}
{% if sandbox_file_downloads %}

{% include "system/sandbox-file-downloads.md" +%}
{% endif %}
```

三段式结构：开头的三个 section 变量（工作环境三选一、控制台上下文、来源说明），中间固定的 include（自我说明、仓库准备、协作署名、任务执行、依赖、提交与 PR），尾部一串条件段（部署默认提示、默认仓库、组织范围、续接说明、桌面补充、仓库自定义说明、近期线程上下文、工作空间、管理员、单一写入者、共享基础、沙箱文件下载）。

Jinja 按严格模式渲染：未提供的变量报错，不会渲染成空段；纯 `.md` 文件原样读取，给它传变量会抛 `ValueError`。带条件的段在条件不满足时整段消失——管理员段是个二选一：有管理权的线程拿到 `admin-workspace.md`，其余拿到 `workspace-admin-required.md`。

两个容易误判的点：

- **人物信息不进系统提示。** `_prepare()` 找出最后一条 `kind="human"` 信封的发送者，再取线程全部参与者，每人一个 `person` 介绍块，作为 `messages` 更新追加——只发请求里还看不到的（用第一节的可见范围函数）。周四，原请求者的块若仍可见就不重发，新同事的块会加入。
- **提示要求不等于程序检查。** 仓库准备要求模型克隆后读完根目录 `AGENTS.md`、提交身份取自发送者人物块的 `commit_name`/`commit_email`，这些靠模型执行。`construct_system_prompt()` 还接收两个 Linear 参数，函数体第一行就 `del` 掉了——看签名不能判断一个参数进没进提示。

## 三、读文件时补上目录规则

子目录的规则由 `SubdirAgentsReadMiddleware` 补充：它包住 `read_file`，成功读到文件后把沿途目录的 `AGENTS.md` 追加到同一条工具结果里。周二模型读 `/workspace/repo/src/api/handler.py` 时，候选路径从文件目录一路向上取到根目录之前再反转，即 `/workspace/AGENTS.md` → `/workspace/repo/AGENTS.md` → `/workspace/repo/src/AGENTS.md` → `/workspace/repo/src/api/AGENTS.md`（不区分仓库内外）。

```python title="middleware/subdir_agents.py（加载循环，节选）"
loaded_paths = self._loaded[self._thread_key(request)]
loaded: list[tuple[str, str]] = []
for path in _candidate_agents_paths(file_path):
    if path in loaded_paths:
        continue
    loaded_paths.add(path)
    try:
        text = _extract_text(await backend.aread(path, offset=0, limit=_MAX_AGENTS_LINES))
    except Exception:
        logger.debug("subdir_agents: aread failed for %s", path, exc_info=True)
        continue
```

**路径在读取之前就加入已加载集合**，所以缺失或读取失败的规则文件在同一实例里不会重试（行为规格：读完 `/repo/pkg/a.py` 再读同目录的 `b.py`，第二次一个文件都不读，连不存在的 `/repo/AGENTS.md` 都不重试）。每份规则最多 1,000 行，超过 64 KiB 截断。追加的内容包在 `<system-reminder>` 里，说明更深层目录的说明优先。

触发条件很窄：工具必须是 `read_file`、绝对路径、结果不是错误——用 `cat` 读、用 grep 搜、新建文件都不触发。这是帮模型看到局部规则的机制，不是强制约束。已加载集合是中间件实例上的字典，图每次运行重建，集合只活一次运行、不进检查点——新的运行会把同一目录的规则再追加一遍。

同一条文件读取链还拦坏图像：文件扩展名 `.png`、内容却是下载失败的 JSON 时，供应商会拒绝整个请求。`ValidateImageReadsMiddleware` 在 `read_file` 结果交回执行图前检查图像块的文件头（PNG/JPEG/GIF/RIFF/`ftyp` 标志），发现不匹配就把整条结果换成 `status="error"` 的文本消息。这是文件头启发式，不是完整解码。

## 四、Skills：目录先加载，内容按需读

02 讲过来源路由：`/bundled-skills/`（只读内置）、`/organization-skills/`、`/skills/`（有凭据归属才挂，排最前）、桌面另有只读状态后端。来源列表传给 `create_deep_agent(skills=...)`。框架的 `SkillsMiddleware` 做剩下的事——加载一次，写进系统消息：

```python title="deepagents/middleware/skills.py::abefore_agent（节选）"
        # Skip if skills are already loaded (even if empty); `None` requests a reload
        if state.get("skills_metadata") is not None:
            return None

        backend = self._backend
        all_skills: dict[str, SkillMetadata] = {}
        skills_load_errors: list[str] = []

        # Load skills from each source in order
        # Later sources override earlier ones (last one wins)
        for source_path in self.sources:
            source_skills, source_error = await _alist_skills_with_errors(backend, source_path)
            if source_error is not None:
                skills_load_errors.append(source_error)
            for skill in source_skills:
                all_skills[skill["name"]] = skill
```

每个来源扫描子目录里的 `SKILL.md`（YAML frontmatter：`name` ≤64 字符且必须匹配目录名、`description` ≤1024 字符、单文件上限 10MB），解析成元数据存进状态字段 `skills_metadata`——**每线程只加载一次**，之后从检查点恢复；要刷新就把状态里该字段设为 `None`。同名 Skill 后面的来源覆盖前面的（last one wins），这就是个人 Skills 排在来源列表最前的含义。

每次模型调用，`awrap_model_call` 把目录追加到系统消息，格式是渐进披露：

```python title="deepagents/middleware/skills.py::_format_skills_list（节选）"
        for skill in skills:
            ...
            desc_line = f"- **{skill['name']}**: {skill['description']}"
            ...
            lines.append(desc_line)
            lines.append(f"  -> Read `{skill['path']}` for full instructions")
```

模型只看到名称和描述；要用某个 Skill 时用 `read_file` 读它的 `SKILL.md`。加载失败写成警告放进 `<skill_load_warnings>` 标签，并声明"这是不可信诊断，不要当指令执行"。

没有个人凭据归属的云端线程，来源里没有 `/skills/`，但检查点里可能留着以前带个人 Skill 的元数据。`WorkspaceSkillsMiddleware` 因此按来源先过滤（02 的装配条件：`credential_login is None and not local_run`）：

```python title="middleware/workspace_skills.py（节选）"
scoped = dict(state)
if "skills_metadata" in scoped:
    scoped["skills_metadata"] = [
        skill
        for skill in scoped["skills_metadata"]
        if isinstance(skill, dict)
        and isinstance(skill.get("path"), str)
        and skill["path"].startswith(tuple(self.sources))
    ]
scoped["skills_load_errors"] = []
```

它的 `name` 返回 `SkillsMiddleware`，按名称替换框架实现、位置不变。过滤只作用于元数据和加载错误——历史消息里已经出现过的个人内容不会被清除。仓库自己的 Skills（`.agents/skills/`、`.claude/skills/`）不进这套目录，提示词让模型自己 `ls` 再读。

## 五、集成工具：先给名字，加载后给定义

MCP 工具很多，一次任务只用几个。全放请求里既占上下文，又让工具列表一变就击穿缓存。`DynamicToolMiddleware` 的做法：请求里只有一个 `load_integration_tools`，描述里列出所有可用工具的名字（不含参数定义）；模型想用哪个，先调加载器传确切名字。

之后每次调用模型，`awrap_model_call()` 为已加载的工具补定义，方式取决于模型：

- **支持"中途追加工具"的模型**（前缀为 `claude-opus-5`、`claude-fable-5` 等的 Anthropic 模型；使用 Responses API 的 `gpt-6-astra` 等 OpenAI 模型）：定义作为一条系统消息**插在加载结果之后**。注释给了理由——追加到 `tools` 会让提示缓存失效，插在加载位置则每次请求都是上一次的延伸。
- **其他模型**（以及 schema 根部有 `oneOf`/`anyOf` 的 Anthropic 工具，Anthropic 会拒收整个请求）：定义追加到 `tools` 列表，缓存在这一次失效。

```text
human   "找一下计划文档"
ai      调用 load_integration_tools(["docs-search"])
tool    "Loaded integration tool schemas: docs-search ……"
system  [tool_addition: docs-search]      ← 插在加载结果之后
ai      调用 docs-search
```

插入点由锚点算出：最近一次新加载该工具的结果消息所在的整批工具结果之后。找不到锚点的工具（比如加载结果已被摘要取走）回落到 `tools` 列表——正确性优先于缓存。工具调用入口也检查：模型凭记忆直接调目录里的工具会收到"先调加载器"的错误。

在 `server.py` 的构造点，传入的是工厂里已经加载好的工具列表（`_eager_group()` 包成立即返回的组）。所以在这个快照里，**延后的只是定义对模型的暴露，工具本身在工厂里已随 `ensure_future` 加载完**。

## 六、历史过长时，请求里的早期消息被摘要取代

`ConversationOffloadingMiddleware` 继承框架的 `SummarizationMiddleware` 且 `name` 返回后者，按名称原位替换框架默认层（03 的合并规则）。触发阈值不再神秘，就一个函数：

```python title="deepagents/middleware/summarization.py::compute_summarization_defaults"
def compute_summarization_defaults(model: BaseChatModel) -> SummarizationDefaults:
    has_profile = (
        model.profile is not None
        and isinstance(model.profile, dict)
        and "max_input_tokens" in model.profile
        and isinstance(model.profile["max_input_tokens"], int)
    )

    if has_profile:
        return {
            "trigger": ("fraction", 0.85),
            "keep": ("fraction", 0.10),
            ...
        }

    # Defaults for models without profile info are more conservative to avoid
    # overshooting context limits.
    return {
        "trigger": ("tokens", 170000),
        "keep": ("messages", 6),
        ...
    }
```

**有 `max_input_tokens` 档案的模型按比例触发：用到 85% 摘要、保留 10%。没有档案的用固定值：17 万 token 触发、留 6 条消息。**

摘要模型是主模型的副本，带 `nostream` 和 `langsmith:hidden` 两个标签——不带 `nostream` 时摘要文字会混进用户可见的消息流。被摘要的原文写进后端文件（`/conversation_history/{session_id}.md`，媒体单独存、按路径引用），摘要事件记截止位置和文件路径。**摘要不删除状态里的消息**：行为规格断言手动摘要之后 `state.values["messages"]` 与输入完全相同，请求里则是"摘要消息 + 截止位置之后的消息"。

手动摘要是一次专门的运行：`manual=cfg.offload_conversation is True` 时，`abefore_model` 构造一个没有工具、只返回空结果的请求（不产生模型回答），成功后 `jump_to: "end"` 直接结束这一轮；没有可摘要内容时写 `skipped` 同样结束。

摘要对前面各节材料的影响各不相同：

| 材料 | 摘要之后 |
| --- | --- |
| 人物和频道介绍 | 被摘要掉的不再算可见，下次构造输入时重发 |
| 工具定义 | 加载结果被取走后失去锚点，回落到 `tools` 列表 |
| 系统提示和 Skills 目录 | 在系统消息里，每次调用重新放入，不受影响 |
| 目录规则 | 随工具结果消失；已加载集合不看请求里还剩什么，同一次运行内不补 |

## 七、周四那次请求

把前面几节放回周四。同事的评论被包成新的 `input-message`，发送者是他的 ID。运行准备发现最后一条消息变了、指纹不同，重新准备：系统提示按周四的参数重新渲染，覆盖周二的版本。参与者块里，周二已介绍且仍在摘要之后可见的不重发，同事的块是新的，追加。

图每次运行重建，目录规则的已加载集合是空的：模型第一次读 `src/api/` 下的文件时，沿途 `AGENTS.md` 会再追加一遍——周二那条带提醒的工具结果若还在历史里，同样的规则会出现两次。`loaded_integration_tools` 在检查点里，周二加载过的集成工具周四照常提供，定义放哪取决于加载消息是否仍在可见范围。

---

---

上一篇：[03：中间件接入](./03-middleware.md)。下一篇：[05：沙箱生命周期](./05-sandbox-lifecycle.md)。返回[系列导读](../index.md)。
