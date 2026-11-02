---
slug: /application-notes/product/blog-cases/langchain-paid-media-metric-to-write
sidebar_position: 3
sidebar_label: 广告投放运营 Agent
description: 从小团队跨渠道投放的挑战讲起，图解 LangChain 如何用 Agent 取数、分析、交付周报和审批变更，再结合公开源码总结架构与工程落地。
---

# 广告投放运营 Agent：从跨渠道分析到提案审批与执行

Paid Media Agent 是服务 LangChain 营销团队的**广告投放运营 Agent**：它跨平台分析投放表现、生成周报、回答追问，并把调整建议整理成由负责人审核的变更提案。

它要解决的起点很具体：一个小团队要在半年内扩展到五个付费渠道，却越来越难人工追踪“哪些广告在跑、哪些带来了客户线索、接下来该改什么”。下面先讲清原文的问题、做法与结果，再用公开源码解释实现，最后归纳搭建同类系统的架构和实施顺序。

> 来源：LangChain 博客 [How We Built LangChain’s Paid Media Agent](https://www.langchain.com/blog/paid-media-agent)，发布于 2026 年 9 月 13 日。源码以[公开示例的提交 `0cc8109a`](https://github.com/langchain-ai/paid-media-agent/tree/0cc8109a1984377a573ed8d202b3b054db4d7b90)为准。原文中的内部部署与公开示例分别说明；中文图解均由本文根据所标资料整理。

## 一、业务挑战：渠道扩张后，团队难以看清投放与获客的关系

**本节说明为什么需要这个 Agent：跨平台数据、业务结果和调整决策之间，存在大量人工衔接工作。**

LangChain 过去主要依靠开源、内容、YouTube、社区和活动获得销售线索。2026 年 1 月，团队希望通过付费广告触达新地区和企业决策者，在六个月内扩展到五个渠道。

随着产品发布加快，新活动、广告创意和定向实验不断增加，小团队遇到三类相互关联的困难：

| 遇到的困难 | 工作中具体卡在哪里 | 希望 Agent 承担的任务 |
| --- | --- | --- |
| 信息分散 | 每个平台的数据结构和活动层级不同，难以一起回看 | 跨平台取数，按一致的日期窗口交付周报 |
| 点击不等于业务结果 | 平台转化不能直接对应销售咨询、注册、线索和商机 | 结合数仓，解释投放与后续获客表现的关系 |
| 分析之后仍需大量操作 | 团队要继续调查原因、准备关键词和文案、讨论调整 | 回答追问，准备可审核的具体变更 |

这里的“销售管道”指正在跟进的潜在销售机会及其金额。团队关心的并不止广告点击率，还包括花费最终带来了什么业务意向。广告平台记录媒体活动，数仓连接线索、商机和后续销售结果，两边需要一起看。

原文希望形成“分析表现、提出变更、观察结果、记录经验”的持续学习过程；文章披露的日常使用，则主要是定时周报和团队问答，进一步的行动需要人工批准。

## 二、工作过程：从周一报告走到追问、提案和获批调整

**本节把 Agent 放回一次完整的运营过程，说明每一步交付什么，以及人在哪一步决定是否行动。**

每周一，Agent 结合广告平台和数仓数据，在 Slack 发布综合摘要及各平台的 PDF 报告，解释哪些指标变化了、可能为什么变化、团队可以采取什么行动。成员可以在同一线程继续追问某个活动、成本或销售管道数据。

~~~mermaid
flowchart TD
    A["⏱ 每周定时触发"] --> B["读取广告平台与数仓数据"]
    B --> C["代码计算指标<br/>Agent 解释变化"]
    C --> D["Slack 摘要与各平台 PDF"]
    D --> E["👤 团队在同一线程追问"]
    E --> F["Agent 继续调查<br/>提出具体调整"]
    F --> G{"批准本版提案？"}
    G -->|批准| H["代码提交变更并回读结果"]
    G -->|修改或暂不执行| I["修订提案或保留分析结论"]
    I -->|修订后重新审核| G
    classDef work fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef human fill:#fff3d6,stroke:#946b17,color:#513a0c
    class A,B,C,D,F,H work
    class E,G,I human
~~~

*图 1：根据原文整理的业务过程。周报可以停在分析与讨论阶段；图中的审批分支只在团队决定推进变更时发生。*

Agent 提出的行动包括新增关键词、修改地域定向、调整广告文案或创建搜索活动。它把建议转成可检查的计划，负责人可以编辑或批准，执行代码再提交并验证。团队由此能在一条讨论中完成“看数字、追原因、审方案”，同时保留对真实投放的决定权。

## 三、工作环境：给 Agent 配齐软件、知识和实时数据

**本节解释 Agent 为什么能调查未预设的问题：它有可工作的文件环境，也知道到哪里查方法、业务背景和当前数据。**

### 1、执行环境：像给新分析师配置一台电脑

团队使用 Deep Agents 作为 Agent 的运行框架，借用它的文件访问、代码执行、工作记忆、任务规划和子 Agent 委派能力，再装入广告业务工具与资料。

原文称，每次运行默认可使用 LangSmith Sandbox，即带 32 GB 磁盘和 Shell 的隔离微型虚拟机。里面预装 `pandas`、DuckDB 和 `openpyxl` 处理数据与表格，使用 Jinja2 和 WeasyPrint 生成报告；业务资料包括六组 Skill 和十九页 Wiki。

团队把软件与 Wiki 预置到 Sandbox 启动镜像中，称平均启动时间缩短约 10 秒。环境按任务配置：同篇文章提到，内容生成 Agent 可能需要浏览器和 `ffmpeg`，而广告分析更依赖数据处理与报告软件。

### 2、上下文组织：提示词指路，方法、业务知识和事实分别维护

原文把 Agent 所需信息分成五类。系统提示词保留角色、操作方式、数字来源和结果格式，其他内容放在可查找的位置，按需读取。

| 放在哪里 | 解决什么问题 | 广告案例中的内容 |
| --- | --- | --- |
| 系统提示词 | 知道职责和去哪里找资料 | 先读索引，按规定来源取数和呈现结果 |
| Skills | 知道怎样完成工作 | 读数据、计算、写报告、准备变更的步骤 |
| Wiki | 理解公司的业务背景 | 活动目标、漏斗定义、历史决定及原因 |
| 实时工具 | 获取当前事实 | 本周花费、活动设置、销售管道 |
| 确定性代码 | 保持计算和硬规则一致 | 日期窗口、账户匹配、汇总、投放保护规则 |

![原文的五层上下文图：从模型向外依次为系统提示词、Skills、Wiki、实时工具和确定性代码](/img/blog-cases/paid-media-context-layers.png)

*图 2：原文的上下文分层图。各层表示职责，不表示每次请求都要依次加载全部内容。来源：[LangChain 原文](https://www.langchain.com/blog/paid-media-agent)。*

写周报的方法可以跨公司复用，因此属于 Skill；某项 LangChain 活动究竟追求品牌认知还是销售咨询，属于 Wiki；这周花了多少钱，则要查实时工具。把它们分开后，业务变化不必不断膨胀系统提示词。

原文还给出一个硬规则例子：不能因为一周表现不好，就直接砍掉重要的销售管道来源。这类保护由代码执行。模型负责结合活动目标判断，不能任意推翻规则。

## 四、架构调整：共享一套 Agent，按入口配置能力并隔离状态

**本节解释两次结构选择：周报与聊天为什么合并，跨平台分析又为什么拆给子 Agent。**

### 1、合并入口：解决周报和聊天重复维护、无法接续的问题

团队起初做了两套执行图：周报使用大模型、Sandbox 和 PDF 生成；Slack 使用便宜模型与轻量只读循环，追求数秒内回复，没有 Sandbox。

五周后，问题显现了：新增能力要实现两遍，Slack 无法处理附件，也不能接着回答周一报告的问题，因为 PDF 来自另一套图。

![原文架构调整：两套执行图各自维护 Wiki、Skills、工具和来源规则，改为共享一套定义，并按 Slack 与定时入口配置能力](/img/blog-cases/paid-media-unified-graph.png)

*图 3：原文的合并前后对照。左侧重复维护四类能力，右侧共享定义，但保留不同入口的工具范围。来源：[LangChain 原文](https://www.langchain.com/blog/paid-media-agent)。*

改造后，每个请求从同一套定义创建运行实例，每条线程保留自己的 Sandbox 和 checkpoint（用于恢复执行的状态检查点）。定时运行只拿到 `task()` 委派工具，由它调度平台子 Agent；Slack 运行获得更广的读取、数仓和活动操作能力，也能打开报告 PDF 回答后续问题。

共享的是分析能力与业务知识；线程状态和每次运行的权限仍分别控制。

### 2、拆分分析：父 Agent 汇总，各平台子 Agent 处理自己的数据

原文比较了三种方案：

| 方案 | 实际使用中暴露的问题或收益 |
| --- | --- |
| 每个平台独立运行 | 产生多条 Slack 消息，缺少跨渠道综合判断 |
| 一个 Agent 分析全部平台 | 能统一输出，但大量平台数据挤占同一上下文 |
| 父 Agent 委派平台子 Agent | 平台数据分别处理，父 Agent 保留较小上下文并统一汇总 |

团队选择第三种方案，但隔离不能止于上下文窗口。两个子 Agent 曾共用报告路径和“完成”标记，一个平台结束后，另一个误以为自己也已完成。另一次，子 Agent 无法确认 PDF 渲染结果，反复查文件，甚至尝试重写生成流程。

修复方式是给各平台独立的报告位置和完成状态，将子 Agent 工具收窄为**读取上下文、计算、渲染**三个入口，渲染成功即结束。工具、文件、完成条件和失败处理都要与平台任务对应。[原文整体运行图](/img/blog-cases/paid-media-workflow.png)展示了父 Agent、五个平台子 Agent、Host 和 Sandbox 的关系。

## 五、工程难点：让数字可信、工具够用、行动可审核

**本节说明原文中的具体修复措施：计算与指标来源决定分析是否可靠，工具发现和审批决定 Agent 能否完成整项工作。**

### 1、计算分工：代码算数字，模型解释数字

早期周报把活动、关键词、销售管道记录和落地页检查结果全部交给模型，让它计算花费、周环比、活动分类，再生成报告。在冻结测试集上，单份报告累计处理约 390 万输入 token，耗时 1,112 秒，费用略高于 3 美元；每次运行还要重新推算底层数字。

改造后，Python 抓取数据、对齐日期、计算总量和比较值、执行固定规则，再将紧凑结果写入 Sandbox。模型据此解释可能原因、结合活动目标评价表现，并建议下一步。

原文报告，早期报表流程降至约 85 秒，成本约为原来的四十分之一，速度约提高 13 倍。这是特定测试集上的比较，不能推广为所有任务的收益。

### 2、指标口径：广告平台看媒体活动，数仓看后续业务结果

原文提到，分析涉及六个平台，各自有不同的 ID、转化定义、归因窗口和活动层级。这里的六个平台是分析范围，与开头的五渠道扩展目标不是同一个口径。团队没有先做覆盖一切的统一数据模型，而是明确每类指标应当相信哪个来源。

~~~mermaid
flowchart LR
    A["广告平台"] --> B["花费、曝光、点击<br/>媒体活动的权威来源"]
    C["业务数仓"] --> D["线索、商机、销售管道<br/>业务结果的权威来源"]
    B --> E["结合活动目标解释表现"]
    D --> E
    E --> F["注明来源、日期与归因口径<br/>无法关联则保留缺口"]
    classDef source fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef rule fill:#fff3d6,stroke:#946b17,color:#513a0c
    class A,B,C,D source
    class E,F rule
~~~

*图 4：根据原文整理的指标来源分工。把两类证据用于同一项分析，不等于它们已经能逐行可靠关联。*

Google 视频活动暴露了这项分工的必要性：数仓通过关键词关联活动，但部分视频活动没有关键词，约 10% 的 Google 花费因此未出现在数仓关联结果里；Google 平台本身仍记录了正确花费。

Meta 的限制则在另一端：平台能说发生了转化，数仓更适合判断那次转化是“联系销售”还是“注册”。团队把来源规则写进 Wiki，并移除可能从错误系统查询指标的工具。关联不可靠时保留缺口，不要求模型补齐数字。

### 3、工具发现：先找能力，再加载参数和执行

广告接口由 Pipeboard 的 MCP（模型上下文协议）服务接入。原文称，较早的只读目录仅加载工具名称、说明和参数，就需约 38,000 token。随着工具增长到 218 个，把全部定义放进每次对话的代价越来越高。

~~~mermaid
flowchart LR
    A["当前业务问题"] --> B["搜索目录<br/>最多返回 8 个候选"]
    B --> C["选择工具<br/>读取其完整参数结构"]
    C --> D["Host 校验并执行<br/>宿主服务持有凭证"]
    D --> E["返回当前问题所需结果"]
    classDef work fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    class A,B,C,D,E work
~~~

*图 5：根据原文整理的广告工具发现过程。目录保留在服务端，写操作另走审批路径。*

原文称，这种方式把首轮上下文降到约 12,000 token，在其比较中成本约为一次加载全部参数结构的四分之一，评审质量相同。目录后来接近扩展到三倍，上下文成本仍大致稳定。

数仓使用类似思路：常见问题保留固定查询，另提供“查看表与字段”和“执行分析查询”两个入口，让 Agent 能按单个销售机会等未预设维度调查。团队在 60 次线上运行中比较后保留了两条路径：固定工具快速回答常见问题，灵活查询补足深入分析。

### 4、行动审批：审核明确的变更内容，再验证平台状态

分析结果可以供多个团队讨论，广告修改则只允许指定成员编辑或批准。原文称，服务端在接受这两种操作前检查 Slack 用户 ID；无权操作被阻止，提案保留待处理状态。

Slack Block Kit 是组织消息卡片和交互按钮的组件体系，团队用它展示当前值、拟修改值与批准范围。负责人可以编辑计划，批准后由代码写入平台并回读。

![原文的 Google 搜索活动审批卡，包含每日预算、投放地域、落地页、关键词、文案，以及只创建暂停活动的审批范围](/img/blog-cases/paid-media-approval-card.png)

*图 6：原文审批卡使用虚构公司与演示预算。底部明确写出：本次批准只创建暂停状态的活动，真正启用需要另行审核。来源：[LangChain 原文](https://www.langchain.com/blog/paid-media-agent)。*

卡片中的 Daily budget、Locations、Landing page 分别是每日预算、投放地域和落地页；Approval boundary 说明此次批准究竟允许执行什么。审核人需要判断的是这份具体计划，而非一句笼统的“优化广告”。

### 5、交互界面：轻量讨论留在 Slack，复杂编辑进入专用工作区

Slack 能把分析、讨论和审批放在同一线程。包含大量广告组和创意、需要批量编辑或多轮修订的计划，则很难在消息卡片中处理。原文称，团队正在把复杂流程迁到专用界面，同时保留 Slack 的提问、浏览建议和轻量审批。

加上上一节的子 Agent 隔离，以上对应原文提出的六个工程问题：计算、指标来源、工具发现、隔离、审批和界面适配。

## 六、原文结果：改善投放与报告效率，主动优化仍是后续方向

**本节集中交代作者报告的效果和能力范围，让业务结果与未来计划分别成立。**

| 观察项 | 原文报告的结果 | 比较范围 |
| --- | --- | --- |
| 获客贡献 | 付费媒体从贡献 0% 增长到营销管道的 20% | 六个月 |
| 合格线索成本（CPL） | 月度花费约增加 60%，CPL 下降 30% | 6 月至 8 月 |
| LinkedIn 效率 | CPL 比 1 月低 40% | 单个平台 |
| 分析与报告支出 | 收回内部后每月节省约 5,000 美元 | 与原外部代理商支出比较 |
| 早期报表运行 | 约 18 分钟降至 85 秒，成本约降至四十分之一 | 团队的冻结测试集 |

文章发表时，Agent 主要响应定时任务和成员请求。持续监控表现、主动发现异常并提出实验，是接下来的目标。更远的计划是让获客到成交相关的 GTM Agent 共享经验，把广告互动、销售跟进、销售对话和成交结果用于改进后续投放。

作者的复盘也不只看 token 和延迟：任务完成率与答案质量需要一起评估；那些反复回答不好的真实问题，会暴露数据关联、指标定义和工具接口的缺陷。

以上为原文的完整实践主线。下面转向公开示例代码，说明其中哪些机制可以复查，以及怎样落实到工程组件。

## 七、运行装配：框架承载 Agent，项目代码提供广告业务能力

**本节解释公开仓库如何启动同一套广告 Agent，并划清框架、托管环境和业务代码各自负责什么。**

### 1、组件分工：运行环境与广告能力分别装配

Deep Agents 提供模型与工具协作的运行能力。Managed Deep Agents 是推荐的托管方式，承接部署、线程 Sandbox、检查点、定时任务和 Slack 接入。广告账户连接、指标计算、报告、提案和审批策略由项目实现。

~~~mermaid
flowchart TD
    A["定时报告请求"] --> C["同一套广告 Agent 组件"]
    B["Slack 用户消息"] --> C
    R["运行环境<br/>Managed Deep Agents 或自托管"] -.->|承载运行与状态| C
    C --> D["只读能力<br/>平台取数、计算与报告"]
    C --> E["变更能力<br/>准备提案、请求审核执行"]
    F["项目配置与业务资料<br/>账户、目录、存储与 Skills"] --> C
    classDef runtime fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef business fill:#eaf5ec,stroke:#477655,color:#193e25
    class A,B,C,R runtime
    class D,E,F business
~~~

*图 7：根据公开示例整理的职责图。托管与自托管复用业务装配；图中不包含原文内部的平台子 Agent 委派。*

项目的 `configured_profile()` 选择运行依赖，`RuntimeProfile` 则保存账户映射、目录、读写提供者、数据与提案存储、签名器和写策略。样例模式用固定数据；接入实时目录后才切换真实读取，真实写入仍受独立门禁控制。见[运行配置](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/runtime/mda.py#L47-L82)与[配置字段](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/runtime/profiles.py#L35-L69)。

### 2、启动入口：把模型、工具、调用规则和审批点交给运行时

`build_mda_components()` 是项目自己的组装函数；`define_deep_agent()` 是 Managed Deep Agents 用于声明 Agent 的函数。[入口代码](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/agent.py#L7-L21)节选如下，省略导入与配置创建，中文注释为本文补充：

~~~python
# 按运行配置准备广告业务组件
_components = build_mda_components(_settings, project_root=Path(__file__).parent)

agent = define_deep_agent(
    name="paid-media-agent",
    model=_components.model,
    tools=list(_components.tools),
    # 在模型和工具调用周围控制可见性、权限等行为
    middleware=list(_components.middleware),
    # 指定需要暂停等待人工审核的工具调用
    interrupt_on=dict(_components.interrupt_on) or None,
)
~~~

工具中既有平台读取，也有 `compare_periods`、`summarize_window`、`render_report` 等固定业务动作，分别负责两期比较、单窗口汇总和报告生成；写工具提供发现、查看、提案与请求执行。具体见[工具装配](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/assembly.py#L200-L209)。

托管入口还用 `define_schedule()` 声明定时请求，以 `channels.slack()` 注册消息通道。公开示例的[周报提示词](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/schedules/weekly_report.py#L1-L14)要求读取最近 14 个完整日、比较相邻两周、说明不可用平台；调度触发后，模型组织这些动作。自托管路径则用 `create_deep_agent()` 编译同一组业务组件，并自行提供 API、存储与检查点，见[本地装配](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/runtime/local.py#L63-L82)。

### 3、证据范围：公开示例不能等同于内部生产部署

核对提交 `0cc8109a` 时，有三处差异直接影响复用预期：

| 原文内部系统的描述 | 公开示例在该提交中的范围 |
| --- | --- |
| 父 Agent 委派平台子 Agent | [授权中间件](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/middleware/authorization.py#L21-L22)明确隐藏内置 `task`、`execute`、`delete` 工具 |
| Slack 周报附各平台 PDF | [README](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/README.md#L154-L156)说明没有自动附加 PDF；报告可在本地或自托管 API 获取 |
| 内部 BigQuery、真实业务 Wiki 与投放效果 | [README](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/README.md)把数仓列为可选扩展，真实账户写入默认关闭；示例无法独立证明业务效果 |

原文也没有提供可独立复算的业务对照实验。花费、CPL 和管道贡献的改善属于团队自述，不能全部归因于 Agent。各渠道预算、合格线索标准及完整成交归因，仍需复用方按自己的业务确定。

## 八、数据实现：原始数据落文件，计算结果再进入模型和报告

**本节沿一条读数链解释三个约束：只能读授权账户、缺失数据不能当作零、报告数字必须有分析产物支撑。**

### 1、工具准入：发现能力之后，调用仍要重新校验

项目先建立广告工具目录，再把工具分为可读、允许提案的变更和拒绝三类。`classify()` 是负责分类的项目函数，会检查平台、参数结构、账户范围、工具名称和 MCP 元数据。缺少读写属性或账户范围的工具会被拒绝；写操作还要满足非破坏性和本地准入名单条件。见[工具分类代码](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/catalog.py#L130-L217)。

模型看到哪些参数结构，由工具选择中间件控制。中间件是在模型或工具调用前后执行的拦截逻辑；本项目的[工具选择实现](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/middleware/tool_selection.py#L149-L289)按模型能力选择原生工具搜索或额外的模型筛选，未知名称不会扩大可用工具范围。

这与原文“三个入口”的表现形式不同：公开示例没有单独读取 Schema（参数结构）的模型工具，而是通过目录搜索与中间件控制可见定义。

`ReadDispatcher` 是宿主侧的平台读取分发器。模型传入账户别名 `account_alias`，宿主将其换成真实账户 ID；执行前重新检查工具仍属可读类别，并核对 `schema_hash`，即参数结构的哈希值，防止目录已变化却沿用旧定义。见[读取分发器](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/reads.py#L143-L211)。

### 2、数据流转：模型传递文件 ID，计算工具处理原始行

读取返回后，原始行写成 Artifact，即带 ID、来源与质量信息的数据文件。模型只收到文件 ID、行数、时间覆盖和缺失字段等摘要，再把 ID 交给计算工具。

~~~mermaid
flowchart TD
    A["Agent 选择读取工具<br/>指定账户别名"] --> B["ReadDispatcher<br/>核对工具定义与账户绑定"]
    B --> C["广告平台返回原始数据"]
    C --> D["Artifact 数据文件<br/>保存原始行与来源信息"]
    D --> E["确定性工具<br/>比较两期或汇总单窗口"]
    E --> F["analysis 分析文件<br/>保存指标与数据缺口"]
    F --> G["Agent 撰写解释和建议"]
    F --> H["报告工具核对数值<br/>生成 HTML 或 PDF"]
    G --> H
    classDef data fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef compute fill:#eaf5ec,stroke:#477655,color:#193e25
    class A,B,C,D,F data
    class E,G,H compute
~~~

*图 8：根据读取、比较和报告工具整理的预期数据路径，不是一次生产运行记录。模型的解释与报告数字共同依赖分析产物。*

数据无法归一化为支持的指标行时，保留为 `provider_result` 原始结果，不强行进入 `performance_rows` 比较。比较工具还会检查日期顺序、窗口长度、文件类型与数据可用性。

下面是 [`run_compare_periods()`](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/compare_periods.py#L66-L79) 的真实节选，省略前面的窗口创建与长度检查，原有英文注释译为中文：

~~~python
        for label, window in (("current", current), ("previous", previous)):
            if window.start < first:
                # 读取未覆盖窗口起点，部分汇总会看起来像指标下滑
                raise ComputeError(
                    f"{artifact_id}: the {label} window starts {window.start.isoformat()} but the "
                    f"read begins {first.isoformat()}; re-read the union of both windows"
                )
            if not any(window.start <= r.window.start <= window.end for r in rows):
                # 空窗口表示数据不可用，绝不能当作零花费
                raise ComputeError(
                    f"{artifact_id}: no rows in the {label} window "
                    f"{window.start.isoformat()}..{window.end.isoformat()}; "
                    f"the source has data through {latest.isoformat()}"
                )
~~~

这个分支能挡住窗口起点未覆盖和整窗无数据；它本身不证明区间内每天都完整，数据质量还需结合读取结果判断。否则，“没读到上周的数据”就可能被解释成“上周花费为零”，让环比失去意义。

`render_report` 接收模型撰写的标题、摘要和建议，数值则来自分析文件。`reconcile_report()` 是核对报告指标与分析产物的函数，之后才渲染 HTML，并在环境具备条件时生成 PDF。见[报告工具](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/reports.py#L34-L79)。

## 九、行动实现：提案绑定版本，批准之后仍要校验并回读

**本节说明建议怎样成为真实变更：审批针对固定内容，执行器核查授权和当前策略，成功与否以平台回读为准。**

### 1、提案准备：当前值由工具读取，修改后重新审核

`ProposalService` 是创建和管理变更提案的业务服务。`propose_change` 工具向它提交账户、目标、修改字段、理由、效果测量和回退计划；服务校验准入操作后读取真实当前状态，形成 `ChangeSet`，即记录修改对象、前后值和版本的结构化变更单。

[`ProposalService.propose()`](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/writes.py#L389-L448) 的核心节选如下，省略字段组装与状态迁移，中文注释为本文补充：

~~~python
        entry, operation, catalog_revision = self._resolve_mutation(tool_name)
        args = self._scoped_args(entry, account_alias, target_ref, operation, changes)
        # 修改前的值由授权读取工具取得，不由模型自行填写
        state = await self._current_state(entry, operation, args)
        before_values = {f: _json_ready(state.get(operation.readback_fields[f])) for f in changes}
~~~

提案还记录目录版本、参数结构哈希、写策略摘要、请求人、线程与风险。编辑提案时，`revise()` 增加修订号并重新计算内容摘要。执行请求携带旧修订号时返回 `proposal_revised`，避免批准旧卡片却执行新内容。见[修订逻辑](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/writes.py#L457-L496)与[写工具](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/write_tools.py#L117-L185)。

### 2、授权执行：暂停等人只是入口，凭证与门禁决定能否写入

项目只在 `execute_change` 处设置人工中断。自托管路径在审批时校验审批人、是否允许自审和提案摘要，然后生成 `ApprovalClaim`，即带签名和到期时间的审批凭证，再恢复运行。托管路径在恢复后使用宿主传入的身份创建相同类型的凭证。见[审批入口](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/surfaces/runner.py#L242-L255)与[人工中断配置](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/write_tools.py#L82-L114)。

~~~mermaid
flowchart TD
    A["Agent 准备提案<br/>目标、前后值、修订号"] --> B["👤 授权负责人审核"]
    B -->|编辑| C["增加修订号<br/>重新计算内容摘要"]
    C --> B
    B -->|批准| D["宿主签发审批凭证<br/>绑定本版提案"]
    D --> E{"凭证、目录、门禁<br/>是否通过核查？"}
    E -->|不通过| F["拒绝执行并记录原因"]
    E -->|通过| G["消费单次凭证<br/>必要时执行参数预校验<br/>真实写入只尝试一次"]
    G -->|已返回或提交超时| H["只读工具有限次回读"]
    H --> I["收据<br/>已验证、失败或无法确认"]
    classDef action fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef guard fill:#fff3d6,stroke:#946b17,color:#513a0c
    class A,C,G,H,I action
    class B,D,E,F guard
~~~

*图 9：根据公开源码整理的主要审批执行路径。图中省略取消、平台显式报错等分支；批准凭证绑定具体提案，编辑后需重新审核。*

`WriteExecutor` 是控制写入与验证的执行器。它检查提案状态、当前修订号的未使用凭证、签名、范围和有效期，并重新核对目录、参数结构、写策略和账户绑定。`WriteGate` 则是发布门禁：真实写入必须启用开关、固定已审核的目录版本，并限制在小范围试运行的准入工具集合内；紧急停写文件可阻止执行。见[执行器](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/writes.py#L775-L918)与[门禁](https://github.com/langchain-ai/paid-media-agent/blob/0cc8109a1984377a573ed8d202b3b054db4d7b90/src/paid_media_agent/tools/writes.py#L170-L227)。

### 3、结果确认：提交超时不盲目重试，回读无法证明就保留未知

门禁通过后，执行器用带预期旧记录的保存操作推进状态，并消费单次凭证。如果平台支持只校验参数的 `validate_only` 模式，会先验证；真实写调用只尝试一次。策略支持幂等参数时，还会用提案 ID 与修订号构造幂等标识。

请求超时可能发生在平台已经接受变更之后，所以代码不自动重发，而是进入有限次数的只读回查：

| 回读观察 | 收据状态 | 向使用者表达什么 |
| --- | --- | --- |
| 匹配拟修改值 | `verified` | 已读到目标状态 |
| 仍匹配修改前值 | `failed` | 回查时仍未应用变更 |
| 在回查预算内无法证明 | `unknown` | 不能确认最终状态，需继续调查 |

`provider_acknowledged` 单独记录平台是否答复。收到接口答复与回读到目标状态是两条证据，执行收据保留两者，避免把“请求发出去了”写成“变更已生效”。

## 十、整篇总结：从可解释的分析链，逐步建成可审核的行动链

**本节归纳搭建同类系统的方法：架构上共享业务能力、隔离运行状态；工程上依次做实数据、计算、交付、审批和执行验证。以下是结合原文与源码的本站实施建议。**

### 1、架构总图：Agent 组织调查，业务服务保证数字和行动有据可查

这个案例适合采用 **Agent 主导分析、确定性代码处理指标、业务状态机控制变更** 的混合架构。模型决定查什么、怎样解释和是否建议调整；平台读数、报告数字、审批版本与写后结果由具体服务控制。

~~~mermaid
flowchart TD
    A["使用入口<br/>定时任务、Slack<br/>复杂计划专用界面"] --> B["共享 Agent<br/>组织调查、解释证据<br/>准备调整建议"]
    K["工作资料<br/>Skills：工作方法<br/>Wiki：业务知识"] --> B
    R["运行承载<br/>线程状态、检查点、Sandbox"] -.-> B
    B --> C["授权读取服务<br/>工具目录与账户绑定<br/>按指标来源取数"]
    C --> D["数据来源<br/>广告平台、可选业务数仓"]
    D --> E["数据产物与确定性计算<br/>原始数据与质量标记<br/>可复算的指标结果"]
    E --> B
    E --> F["报告服务<br/>核对指标、保存文件<br/>向团队交付结果"]
    B -->|解释与建议| F
    B --> G["提案服务<br/>目标、前后值<br/>修订号与风险"]
    G --> H["👤 人工审核<br/>身份、版本与批准范围"]
    H --> I["执行服务<br/>审批凭证与发布门禁<br/>真实写入只尝试一次"]
    I --> J["回读与收据<br/>已验证、失败、无法确认"]
    J -.-> L["运营复盘<br/>更新 Wiki 供后续参考"]
    classDef agent fill:#e8f2ff,stroke:#426a9b,color:#172b4d
    classDef data fill:#eaf5ec,stroke:#477655,color:#193e25
    classDef action fill:#fff3d6,stroke:#946b17,color:#513a0c
    class A,B,K,R,L agent
    class C,D,E,F data
    class G,H,I,J action
~~~

*图 10：同类系统的建议架构，综合原文与公开示例；不是内部部署的逐项复刻。虚线“运营复盘”表示建议建立的经验回流，不表示公开示例已有自动学习能力。*

落到本例，`ReadDispatcher` 负责取数约束，`compare_periods` 等工具负责计算，`render_report` 负责报告，`ProposalService` 和 `WriteExecutor` 控制提案与执行。这样的接口划分使 Slack 与定时报告能复用业务能力，也能让每一次修改追溯到获批版本。

是否使用平台子 Agent，要看数据量是否真的挤占上下文、是否需要并行处理。只有启用委派时，才需要同时落实独立文件路径、完成状态、工具范围和返回约定。原文的内部系统验证了这项设计需求，公开示例的该提交并未启用同样的委派路径。

### 2、实施顺序：每接通一段，就明确产物和验收方法

建议从一个渠道的只读报告起步，按下表逐段扩展。每一步都先能查明结果，再增加下一类能力。

| 实施阶段 | 需要做的工程工作 | 应当留下的产物与验收依据 |
| --- | --- | --- |
| 1. 定义业务与数据口径 | 明确活动目标、指标权威来源、账户映射、时区和归因窗口 | 一份来源规则表；人工核对花费与业务结果，关联失败有记录 |
| 2. 跑通读取和确定性计算 | 建立授权工具目录，原始数据落文件，固定汇总与比较算法 | 可复算的指标文件；空窗口和缺失值不会变成零，来源可追溯 |
| 3. 接入 Agent 与报告 | 用提示词导航，拆分 Skill/Wiki，按需展示工具，校验报告数字 | 一份报告及其数据依据；解释可追问，数字与分析文件一致 |
| 4. 共享入口和运行能力 | 定时与问答复用组件，隔离线程状态，按任务配置工具与 Sandbox | 能接续报告的问答；并发运行不覆盖别人的文件和完成状态 |
| 5. 上线提案与审核 | 展示真实前后值，绑定修订号、审批人和范围，修改后重审 | 一份可查看、可修订、可拒绝的提案；旧批准不能授权新内容 |
| 6. 小范围开放真实写入 | 设置发布门禁、凭证消费、超时处理、回读和停写机制 | 执行收据能区分已验证、失败和未知；重复恢复不会重复提交 |

验证时应覆盖这里已经暴露的失败场景：数仓漏关联视频广告、比较窗口缺数据、工具目录变更、两个平台写同一报告路径、审批中途修订提案、写入超时但平台可能已经接受。它们分别决定报表是否失真、任务是否漏做、执行是否越过批准内容。

### 3、适用边界：复用工程分工，按自己的业务补齐规则和代价

可直接借鉴的是指标来源分工、原始数据与模型上下文分离、确定性计算，以及“提案、审核、单次写入、回读收据”的行动链。迁移时必须重做活动目标、漏斗定义、数仓关联、账户权限与审批范围；这些决定 Agent 的建议是否适用于自己的业务。

如果只需要固定口径的周报，先用确定性报表流程就能完成交付。跨系统追问、临时调查和准备调整计划，才是本例引入 Agent 后承担的额外工作。数据关联尚不可靠时，应先把缺口显示清楚；审批尚未绑定具体内容时，应停在提案阶段。

上线后的维护也有明确成本：平台工具与参数变化要重新检查目录，Wiki 和指标定义需要业务负责人更新，Sandbox 镜像和报告依赖需要维护，真实写入需要有人处理未知结果。验收应同时观察数字正确率、任务完成率、答案质量、成本与延迟，不能只用 token 下降证明系统更好。

从开头的小团队困境回看，完整交付应当让团队沿同一项任务查到**指标依据、分析解释、获批内容和执行结果**。这些记录连起来，团队才能减少重复取数与准备工作，同时保留对投放决策的检查能力。

资料：[LangChain 原文](https://www.langchain.com/blog/paid-media-agent)；[源码固定提交 `0cc8109a`](https://github.com/langchain-ai/paid-media-agent/tree/0cc8109a1984377a573ed8d202b3b054db4d7b90)。原文与配图复核于 2026 年 10 月 7 日；本次重新核对入口、比较工具、执行器、授权中间件与 README，其余源码定位沿用原文档的 2026 年 9 月 24 日核验记录。
