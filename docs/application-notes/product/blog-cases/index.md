---
sidebar_position: 1
description: 按客户服务、销售营销、数据研究、知识协作、开发运维和文档处理六类任务查找 LangChain 博客案例，再对照服务对象与架构边界。
---

# LangChain 系列博客案例

这里收录来自 LangChain 博客与客户案例的产品业务拆解，也收录有具体任务和公开实现的工作流示例。本轮仅收录 2026 年发表的原文，以文章日期为准，不以页脚年份或旧案例被再次提及的日期代替。案例按 Agent 主要完成的业务任务分为六类，每篇正文只归入一个子目录；服务对象、行业和架构方式用于辅助对照。

每篇文章先讲清产品业务：谁在什么入口提出任务，需要哪些业务资料，Agent 怎样处理，交付什么，哪些环节由人继续完成。在这个基础上，再完整讲解原文的技术做法、例子、结果和限制。读者不打开英文原文，也能理解案例。

原文讲清之后，再单独呈现公开证据核验、源码对照和本站判断。排版按问题分节、按意思分段，段落与列表之间留白；比较内容用表格，确有先后的流程才用连续序号。

| 业务分类 | 主要任务 | 案例 |
| --- | --- | --- |
| 客户服务与服务导航 | 理解客户诉求，查询业务信息，办理或引导服务并接入人工 | [出行客服 Agent](./customer-service/lyft-support-agent-platform.md)、[就医导航 Agent](./customer-service/included-health-dot-care-navigation.md)、[客户体验 Agent 生产专题](./customer-service/latam-concierge-passenger-intent.md) |
| 销售与营销 | 寻找潜客、推进销售、经营客户和优化广告投放 | [销售拓客 Agent](./sales-marketing/apollo-assistant-skill-routing.md)、[销售跟进 Agent](./sales-marketing/langchain-gtm-approval-timeout.md)、[广告投放运营 Agent](./sales-marketing/langchain-paid-media-metric-to-write.md) |
| 数据分析与研究 | 查询可信数据，综合研究材料，提炼业务与用户需求洞察 | [创投研究 Agent](./analytics-research/harmonic-scout-investment-research.md)、[金融数据检索 Agent](./analytics-research/kensho-grounding-financial-research.md)、[企业数据分析 Agent](./analytics-research/langchain-agent-first-data-stack.md)、[用户会话分析 Agent](./analytics-research/credit-genie-conversation-feedback.md) |
| 知识工作与协作 | 结合组织知识和工作上下文，辅助员工处理资料与协作任务 | [企业知识工作 Agent](./knowledge-collaboration/stripe-kai-skills-and-tools.md)、[项目协作 Agent](./knowledge-collaboration/monday-sidekick-workspace-boundaries.md)、[制造业知识 Agent](./knowledge-collaboration/toyota-gearpal-repair-knowledge.md) |
| 软件开发与运维 | 调查与修改代码，巡检、诊断和维护运行中的系统 | [编程 Agent 的模型路由](./development-operations/open-swe-model-routing.md)、[集群运维 Agent](./development-operations/langchain-sre-agent-approval-boundary.md) |
| 文档审查与处理 | 判断文档性质，识别敏感信息，衔接脱敏与人工审核 | [文档审查 Agent（工作流示例）](./document-processing/jev-document-review-workflow.md) |

Credit Genie 按本文重点归入数据分析与研究：后台 Insights 分析前台理财助手的会话，再由产品团队推进功能改动。客户体验 Agent 生产专题覆盖 Lyft、Fastweb + Vodafone 和 LATAM，主归客户服务；其中 LATAM 的 Compass 可与 Credit Genie 对照阅读后台会话分析。Toyota 同时介绍设备维修知识、研发检索与企业问答，归入知识工作与协作。Jev 保留“工作流示例”标识，业务分类不改变其证据范围。

下文按服务对象和架构方式提供辅助索引，同一篇文章可以在不同索引中出现。

## 一、直接服务客户、会员和乘客的产品

这些案例的前台入口面向外部使用者。部分文章也介绍内部配置或分析系统，需要把两类使用者分清。

| 案例 | 谁从哪里发起任务 | 产品业务怎样完成 |
| --- | --- | --- |
| [Lyft 客服](./customer-service/lyft-support-agent-platform.md) | 乘客、司机发起客服请求 | 识别账户、车费、收入或理赔诉求，进入相应流程；内部专家维护常规服务配置 |
| [Credit Genie 理财与预支款服务](./analytics-research/credit-genie-conversation-feedback.md) | 用户在 App 的 AskGenie 中提问 | 查询个人预支款事实，接入修改日期、申请和支持请求；后台会话分析推动产品补能力 |
| [Included Health 医疗导航](./customer-service/included-health-dot-care-navigation.md) | 雇主及健康计划会员通过 Dot 求助 | 结合资格、保险与健康背景寻找合适服务，进入预约等流程，必要时交人工接续 |
| [客户体验 Agent 生产专题](./customer-service/latam-concierge-passenger-intent.md) | 出行与电信客户通过 App、语音等入口发起请求 | 对照 Lyft 客服、Vodafone 业务办理与 LATAM 旅行服务，并展开内部坐席辅助、质量评测与后台知识处理 |
| [Apollo 销售助手](./sales-marketing/apollo-assistant-skill-routing.md) | 销售平台客户提出获客目标 | 串起找潜客、补资料、账户研究、触达序列和效果分析，也可从 API 等入口调用 |
| [monday.com 工作空间助手](./knowledge-collaboration/monday-sidekick-workspace-boundaries.md) | 客户团队成员在看板或文档等工作位置提出任务 | 组合工作空间资料与文件，交付报告、图表和文档，或执行明确的记录操作 |
| [Harmonic 投资研究](./analytics-research/harmonic-scout-investment-research.md) | 投资团队在 Scout、公司档案或浏览器扩展中提出研究任务 | 结合公司与人物数据、CRM 和关系记录，交付候选公司、会面准备和可继续追问的研究产物 |
| [Kensho 金融研究数据](./analytics-research/kensho-grounding-financial-research.md) | 分析师或客户的金融 AI 应用提出跨领域研究问题 | 路由到财务、商品、评级和文本数据 Agent，汇总可追溯结果，并接入专业数据产品 |

Credit Genie 的 Insights Agent 面向产品团队，LATAM 的 Compass 面向内部知识分析；它们处理前台服务留下的材料，各自交付需求线索和结构化知识。

## 二、服务企业内部业务与运营的产品

这些案例主要描述企业如何把 Agent 放进自己的工作中。SRE 案例还提到向部分客户推出，但没有披露完整的对外产品方案。

| 案例 | 谁在什么情况下使用 | 产品业务怎样完成 |
| --- | --- | --- |
| [LangChain 销售跟进](./sales-marketing/langchain-gtm-approval-timeout.md) | 新线索出现或每周回看客户账户时，销售与部署团队使用 | 调查关系和使用情况，交付邮件草稿、扩展机会或服务风险报告，支持下一步联系与介入 |
| [LangChain 广告运营](./sales-marketing/langchain-paid-media-metric-to-write.md) | 营销团队定期回看投放，或临时追问活动表现 | 对齐广告与业务指标，交付周报、解释及调整提案；指定人员批准后执行并核对 |
| [Stripe Kai 知识工作](./knowledge-collaboration/stripe-kai-skills-and-tools.md) | 销售、财务、运营等员工打开内部会话 | 查公司资料、分析数据、生成报告与文档，并在后续对话中持续修订产物 |
| [Toyota 产线与研发支持](./knowledge-collaboration/toyota-gearpal-repair-knowledge.md) | 技术员排障、研究人员找专业资料、员工查询内部知识 | GearPal 交付诊断与维修指引，R&D GPT 支持跨库研究，ToyotaGPT 承接部门知识问答 |
| [LangChain 集群运维](./development-operations/langchain-sre-agent-approval-boundary.md) | 定时巡检和工程师按需调查 | 汇总集群健康、调查异常、准备修复提案；工程师决定是否执行集群变更 |
| [LangChain 数据问答](./analytics-research/langchain-agent-first-data-stack.md) | 业务人员从 Hex、Slack 等入口提出分析问题 | 根据共同指标与可信来源查数，交付分析；数据团队核验重要问题并维护数据上下文 |

## 三、原文能讲清什么，哪些业务环节仍需另查

上表按原文披露的服务对象和任务整理。各篇进一步讲清入口、业务资料、处理过程、交付物、人的职责以及后续反馈，再解释支撑这些工作的技术。

原文对业务流程的覆盖并不相同。销售与广告案例较详细地描述了从资料到草稿或提案的过程；医疗、旅行和维修案例，则主要披露服务导航、查询与支持，没有展开整个就医、交易或现场作业过程。未披露的环节放在各篇后面的核验与判断部分。

产品业务也不等于收费模式。内部使用、客户可用、独立售卖和已经带来收入，是不同事实；原文未说明套餐、价格或收入归因时，本文不据采用量补推。

新增的 Harmonic 原文发布于 2026 年 6 月 3 日，Kensho 原文发布于 2026 年 3 月 26 日。两篇分别补充官方的使用量计费说明与专业数据产品公告，说明 Agent 怎样进入商业服务；不把留存、客户接入或数据查询次数换算成收入。

案例方的效果数字按其自述处理；客户部署、产品功能和独立收费分别核对，不由其中一项推断另一项。

## 四、架构方式与执行控制

侧边栏中的“销售跟进 Agent”“设备故障诊断 Agent”等名称说明业务用途，不等于已经判定整套应用都由自主 Agent 驱动。架构要看：接到任务后，谁决定下一步调用什么、是否继续调查，以及何时进入业务动作。

### 1、按控制权区分工作流、Agent 与混合架构

- **Workflow（工作流）**：程序预设执行步骤、分支和衔接。模型可以在其中完成分类、提取或生成；有模型调用不代表执行路径也由模型决定。

- **Agent 主导**：模型依据目标和执行反馈，选择工具、组织子任务或决定是否继续。工具内部仍可以执行固定代码，运行环境也可以限制权限和调用次数。

- **混合架构**：业务流程控制触发、等待或动作执行，其中一段交给 Agent 动态处理。例如 SRE 的定时巡检采用固定步骤，按需故障调查交给 Agent，写集群前再进入审批。

这个区分参照 [LangGraph 官方的 Workflows and agents 说明](https://docs.langchain.com/oss/python/langgraph/workflows-agents)，文档核对日期为 2026-09-26。LangGraph 同时支持两类执行；用了 LangGraph、有多个模型、能够并行处理，或者画出多个名为 Agent 的节点，都不足以单独证明存在自主规划。

还要分清**提示词中的步骤**和**代码强制的步骤**。Skill 写了“先调查再发信”，不等于服务端会拦截跳过调查的调用；反过来，工具要求审批凭证，也不会使负责研究的模型自动变成固定流程。各篇将架构判断放在原文讲解之后，并注明依据来自作者描述还是公开源码。

### 2、现有案例的架构判断与证据范围

| 案例 | 本文的架构判断 | 模型判断与程序控制怎样分工，哪些仍未知 |
| --- | --- | --- |
| [Harmonic Scout](./analytics-research/harmonic-scout-investment-research.md) | V2 由 Agent 主导研究 | 模型选择资料工具并继续研究，系统保存与呈现产物；生产控制细节未公开 |
| [Apollo](./sales-marketing/apollo-assistant-skill-routing.md) | 新版由 Agent 组织销售任务 | 模型选择 Skill 并组织步骤；旧版也有 Agent，不能简单视为纯工作流 |
| [Stripe Kai](./knowledge-collaboration/stripe-kai-skills-and-tools.md) | Agent 主导知识工作 | 模型选 Skill、使用工具，运行层提供能力目录与执行环境 |
| [monday.com Sidekick](./knowledge-collaboration/monday-sidekick-workspace-boundaries.md) | Agent 主导任务组织 | 主 Agent 选择工具、委派与沙箱，平台准备可见资料与受限能力 |
| [Lyft](./customer-service/lyft-support-agent-platform.md) | 固定执行结构与对话 Agent 结合 | 子图规定安全与状态处理位置，模型在工具循环中处理对话 |
| [Included Health Dot](./customer-service/included-health-dot-care-navigation.md) | 服务流程与 Agent 混合 | 业务流程承载状态与交接，Agent 根据上下文调用服务能力；全部分支未公开 |
| [客户体验 Agent 生产专题](./customer-service/latam-concierge-passenger-intent.md) | 按任务与系统分别判断 | 对照 Lyft 路由子图、主管与专家、Vodafone 程序排障及混合检索、Compass 知识处理流水线 |
| [LangChain GTM](./sales-marketing/langchain-gtm-approval-timeout.md) | 业务编排与研究 Agent 混合 | 事件和周期任务触发研究，审核与超时规则约束发送；代码强制范围未完整披露 |
| [LangChain 广告运营](./sales-marketing/langchain-paid-media-metric-to-write.md) | Agent 分析与确定性执行结合 | 模型提出分析与提案，代码计算并控制审批写入；博客与公开版本的委派能力有差异 |
| [LangChain SRE](./development-operations/langchain-sre-agent-approval-boundary.md) | 巡检工作流、调查 Agent 与审批流程结合 | 固定取数和单次模型调用完成巡检，按需调查使用专业 Agent，写操作暂停待审 |
| [Kensho Grounding](./analytics-research/kensho-grounding-financial-research.md) | 多 Agent 查询编排，内部自主范围未明 | 确认拆解、分发与聚合；各领域 Agent 是否反复自主调用工具未充分披露 |
| [Credit Genie Insights](./analytics-research/credit-genie-conversation-feedback.md) | 定时会话分析，内部自主范围未明 | 分类与摘要已披露；动态生成类别不能证明动态规划执行步骤 |
| [Toyota GearPal](./knowledge-collaboration/toyota-gearpal-repair-knowledge.md) | 检索与诊断应用，完整控制流未明 | 平台框架与业务能力已披露；不能从 R&D GPT 的检索策略推断 GearPal 实现 |
| [LangChain 数据分析](./analytics-research/langchain-agent-first-data-stack.md) | 数据流水线支撑分析 Agent | 数据采集与转换是独立处理流程，Hex 分析 Agent 的内部执行未完整展开 |
| [Jev 文档审查](./document-processing/jev-document-review-workflow.md) | 预设工作流中的模型判断 | 分类器回答有限问题，代码决定交付、脱敏或人工审核；公开实现使用合成材料 |
| [Open SWE 模型路由](./development-operations/open-swe-model-routing.md) | 分类器选模型，编程 Agent 执行任务 | 运行层保存档位并替换调用模型；博客实验按线程选一次，未验证途中重新路由 |

“未充分披露”表示当前材料不足以判定，不表示产品没有 Agent。任务是否适合模型动态探索、哪些动作必须由程序控制，以及是否需要人工决策，应分别判断；Agent 比例更高也不自动代表更先进或更适合业务。

## 五、编程与文档审查中的模型决策

这两篇讨论模型判断怎样接入具体任务。Open SWE 提供线上实验结果；Jev 文档审查提供合成材料上的示例代码，不能视为客户部署效果。

| 案例 | 服务对象与任务 | 本站拆解的重点 |
| --- | --- | --- |
| [Jev 文档审查](./document-processing/jev-document-review-workflow.md) | 审查人员和律师逐页处理待交付文档 | 相关性与敏感信息判断、脱敏、人工审核，以及分数阈值和恢复后的执行边界 |
| [Open SWE 模型路由](./development-operations/open-swe-model-routing.md) | 工程师从 Slack 或网页发起代码问答与修改 | 任务画像、模型分档、成本与 PR 结果实验，以及路由状态和分类失败回退 |

两篇分别发布于 2026 年 9 月 25 日和 10 月 1 日，均在讲清原文后单列固定版本的源码核验。Jev 在前者判断页面性质，在后者选择执行模型；输出都是有限选择，但所需上下文、错误代价和验收指标不同。
