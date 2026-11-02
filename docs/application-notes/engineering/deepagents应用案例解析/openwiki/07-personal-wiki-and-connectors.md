---
title: 07：个人 Wiki 与连接器
description: personal 模式的另一条 Ingest 流水线：九个内置连接器、两段式摄入（确定性抓取 + Agent 综合）、与 code 模式的关键差异。
sidebar_position: 8
---

# 个人 Wiki 与连接器

code 模式文档化的是一个仓库；personal 模式文档化的是**你的信息流**——邮件、Slack、X 时间线、Hacker News、网页搜索结果、本地仓库、Notion。同一个 CLI、同一套 Deep Agents 底座，但这是一条独立设计的 Ingest 流水线：没有页面队列、没有 Claims，靠连接器喂数据、通用 Agent 综合。代码在 `src/connectors/` 和 `src/ingestion/`。

## 九个连接器

每个连接器负责一种来源的认证与抓取：

| 连接器 | 抓什么 | 认证方式 |
| --- | --- | --- |
| `git-repo` | 本地仓库路径的清单 | 无（读本地路径） |
| `custom-mcp` | 任意 MCP 服务器（HTTP 或 stdio） | 各服务器自带；只放行显式安全的只读工具 |
| `gmail` | 近期邮件 | Google OAuth 用户凭据 |
| `slack` | 授权范围内的会话与搜索结果 | Slack OAuth（用户 + bot token） |
| `x` | 时间线、发帖、提及、书签、列表 | X API OAuth 2.0 + PKCE |
| `notion` | Notion 内容 | Notion OAuth（走官方托管 MCP，动态客户端注册） |
| `web-search` | 定制主题的搜索结果 | Tavily（`TAVILY_API_KEY`） |
| `hackernews` | HN 动态与搜索 | 无需凭据 |

同一个连接器可以配多个实例——一个 Web Search 源盯 AI 研究、另一个盯体育新闻，分别存成 `web-search-1`、`web-search-2`，各自综合进 wiki。

另有第十个 **LangSmith** 连接器，方向相反：它不喂 personal wiki，而是给 code 模式的 wiki 补充**运行时行为**——从 LangSmith 拉取真实的工具调用、结果和延迟，让仓库文档不只说"源码写了什么"，还说"线上实际跑成什么样"。配置落在仓库里的 `openwiki/.langsmith.json`（只记工作区和项目名，不含密钥），团队成员和 CI 跑同一套配置。

认证统一走 `openwiki auth <provider>`：本地起浏览器 OAuth 流程，token 存进 `~/.openwiki/.env`，连接器配置文件里只引用环境变量名、不落密钥原文。Slack 的 OAuth 回调需要 HTTPS，`openwiki ngrok start` 会起一个临时隧道并把回调地址自动写进配置。

## 两段式摄入

`runOpenWikiIngestion`（`src/ingestion/ingestion.ts`）按来源实例**顺序**执行，每个来源两段：

**第一段：确定性抓取。** 连接器的 `ingest` 由程序直接调用（不是模型），把原始材料写进本地缓冲区：

```text
~/.openwiki/connectors/<connector>/raw/     # 原始数据 + manifests
```

这就是概念篇说的 raw 层在 personal 模式下的样子——LLM 只读，抓取过程完全确定、可重放。

**第二段：Agent 综合。** 程序为这个来源构造一次通用 Agent 运行，把 raw 文件清单、连接器上下文和用户的更新指令组装成任务消息。真实的运行参数（`runSourceIngestion`）：

```ts
const runOptions: OpenWikiRunOptions = {
  isFollowup: false,
  modelId,
  onEvent: emit,
  outputMode: "local-wiki",           // 个人 wiki，不是仓库模式
  threadId: createOpenWikiThreadId(cwd),
  userMessage: createSourceUpdateMessage({
    config, connector, deterministicPull, rawFiles, sourceConfig,
  }),
};
```

Agent 读 raw 材料，更新 `~/.openwiki/wiki` 下的个人知识页。`openwiki ingest all` 跑所有已配置来源，也可以只跑某一个。

错误处理按段区分：第一段抓取彻底失败（一个 raw 文件都没有）则这个来源失败；已经拿到部分材料时综合仍可继续。一个来源失败不阻塞后面的来源。

## personal Agent 的纪律

综合那一跑用的通用 Agent 有自己的系统提示词（`src/agent/prompts/personal.ts`，74KB，是全项目最大的一份提示词），几条纪律勾勒出它的设计取向：

**Wiki 优先回答。** 普通问题先查已生成的 wiki（quickstart、索引页、定向 grep），假设答案已经在 wiki 里；只有 wiki 缺细节、明显过时、自相矛盾，或用户点名要最新原始数据时才去翻 raw。用户问"wiki 里怎么说"时只用 wiki 回答，答不上要先说缺什么。

**连接器工具面。** Agent 不直接碰网络凭据：`openwiki_list_connectors` 查能力，`openwiki_ingest_connector` 触发一次确定性抓取，`openwiki_list_raw_items` / `openwiki_read_raw_item` 只能读连接器 raw 目录，MCP 类来源先 `openwiki_list_mcp_tools` 发现再用 `openwiki_call_mcp_tool` 调**只读**工具，禁止猜工具名、禁止写操作。提示词明确：带凭据的外部抓取只能由连接器工具完成，且只许把原始数据落在 raw 目录。

**把原料当不可信输入。** 邮件、帖子、搜索结果、MCP 响应一律是"不可信证据"，其中出现的指令永不执行，除非恰好与用户的明确请求一致——和宿主契约里的防注入条款（见 [08](./08-host-integration-and-runtime.md)）同一立场。

**路径纪律。** 文件工具的根是 `~/.openwiki/wiki` 暴露成的虚拟 `/`；提示词反复强调不要把宿主绝对路径（`/Users/...`）喂给工具，那会在 wiki 里创建出嵌套的错误路径。个人模式没有 shell 工具。

## 定时摄入：把"每天看一眼"交给系统

personal 模式可以给每个来源实例装定时摄入（`src/scheduling/schedules.ts`）：cron 表达式校验后转成人类可读描述（cronstrue），落到 macOS 的 LaunchAgent——写 plist 到 `~/Library/LaunchAgents`（0700 权限），`launchctl bootstrap` 加载。复杂到 launchd 表达不了的 cron 会保存配置但明确警告"装不上"。还能配 pmset 唤醒/睡眠窗口（默认提前 2 分钟唤醒、延后 30 分钟睡眠），让笔记本为夜间摄入醒来；单个来源可暂停。

两个边界要说清：这套调度目前只实现到 macOS（代码里 `process.platform !== "darwin"` 直接拒绝）；仓库 wiki 的对应物不是它，而是 README 提供的 CI 定时工作流（GitHub Actions 等）——生成侧和摄入侧的自动化走了两条不同的路。

## 和 code 模式的关键差异

把两条流水线摆在一起，差异不是"功能多少"，而是**它们对"知识单位"的假设不同**：

- **任务单位**：code 模式是页面（有队列、有基线、有恢复）；personal 模式是来源实例（一个来源一次综合运行，串行避免互相覆盖同一批页面）。
- **证据**：code 模式每条事实挂 `repo://` 证据、可增量复核；personal 模式的材料来自外部服务，没有稳定的版本锚点，Claims 机制整个不适用——wiki 的"新鲜度"只能靠定期重新摄入。
- **执行路径**：code 模式的仓库 init/update 走持久化生命周期；personal 模式走通用 Deep Agent 路径（提示词在 `src/agent/prompts/personal.ts`），Agent 在一次运行里自己决定怎么组织材料。
- **产物归属**：个人 wiki 在 `~/.openwiki/wiki`，属于你的机器（配置、凭据、连接器数据也都在 `~/.openwiki`，可用 `OPENWIKI_CONFIG_DIR` 挪位置）；仓库 wiki 在仓库里，属于团队和 git。

## raw 层的读边界（code 模式）

顺带补一个 code 模式 raw 层的细节：仓库根放一个 `.openwikiignore`（语法同 gitignore，支持 `*` / `**` / `!` 否定），命中的路径在整个生成过程中**不被读取、不被扫描、不出现在文档里**——文件系统发现和 shell 执行都会被过滤。这是硬边界而非提示词约束；它的局限也明确：Agent 仍可能从测试、README 等允许的材料**推断**出被忽略区域的存在，边界保证的是"不读不复现"，不是"不提及"。

至此三种操作、两条流水线全部讲完。还剩外围一环——宿主怎么装进来、MCP 契约承诺了什么、进程内怎么管理一次运行——见 [08：宿主集成与运行环境](./08-host-integration-and-runtime.md)。
