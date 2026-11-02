---
sidebar_position: 0
sidebar_label: 专栏入口
description: 按迭代顺序复盘一个 Agent 开发平台后端的演进：从慕课 LLMOps 课程原型（LangGraph 0.2）、1.0 基线重建、DeerFlow 参照，到转向 DeepAgents 借运行时自持业务，并对照 LangChain 系同类平台、Dify 与 Octop（断线重连专题）。
---

# Agent 平台迭代记录

这个专栏记录一个 Agent 应用开发平台后端的迭代过程：账号创建应用、配置模型与提示词、绑定知识库和工具，通过工作台、WebApp 和开放 API 运行 Agent。专栏不出现项目名，正文一律以"这个平台"指代；范围限定后端模块，前端只在影响后端接口契约时提及。

迭代主线只有一条：运行时从初识的 LangGraph 0.2 图执行原型，换成 1.0 时代的自建图，最终落到 DeepAgents 装配；业务面（应用配置、知识库、工作流、工具、事件流、恢复）自始至终自持。每次换轨以功能变化与依赖版本为证，选型动机属于作者复盘自述。

## 一、迭代对象与证据口径

| 字段 | 内容 |
| --- | --- |
| 迭代对象 | 一个自建 Agent 应用开发平台的后端：Flask + SQLAlchemy + PostgreSQL + Redis + Celery + Weaviate 的平台壳，运行时历经 LangGraph 0.2 原型 → LangGraph 1.0 自建图 → DeepAgents 装配 |
| 初识原型 | 慕课 LLMOps 课程项目（api / ui 前后端分离），后端钉 `langgraph==0.2.67`、`langchain==0.2.17`；本专栏只看它的 api 后端 |
| 版本现状 | `deepagents==0.6.12`、`langgraph==1.2.9`、`langchain==1.3.14`、`langchain_core==1.5.1` |
| 证据来源 | 两侧仓库（原型与平台）的功能清单与依赖版本（可回查）；平台内文档与复盘叙述（作者自述）；LangChain、Dify 官方资料与对照对象（openagent、Yuxi、Octop）仓库声明（公开事实） |
| 验证范围 | 迭代决策与版本事实以功能与依赖为据；各阶段运行效果仅在对应篇目引用实测时成立，本专栏不提供同负载对照 |
| 排除范围 | 前端实现与运维部署流水线；仅在影响迭代决策时提及 |

## 二、目录

分四层：总览给功能、对比与换轨主线；模块纵线每篇追一个后端模块，弧线固定为「初识（原型实现）→ 重建（取舍）→ 现状（DeepAgents 时代的去留）」；跨模块决策单独成篇，换轨事实集中在总览与决策篇，模块篇引用不重述；对照篇把本平台放回外部坐标系。

| 篇目 | 层 | 主题 | 状态 |
| --- | --- | --- | --- |
| 01 [迭代总览](01-iteration-overview.md) | 总览 | 平台功能与依赖版本总览、同类平台对比总览（LLMOps 原型、Dify、openagent、Yuxi、Octop）、共同模块与工程难题矩阵，以及从 LangGraph 0.2 原型到 DeepAgents 的迭代主线 | 已发布 |
| 02 [Agent 运行时](02-agent-runtime.md) | 模块纵线 | 原型手写 StateGraph 与线程队列、ReACTAgent 兼容降级 → 1.0 重建与自建多 Agent 图模式 → `create_deep_agent` 装配、执行生命周期与 V2 边界 | 已发布 |
| 03 [工作流引擎](03-workflow-engine.md) | 模块纵线 | 原型 Workflow 即 BaseTool 的 DSL→StateGraph 编译与并行汇聚边 → 条件分支与汇聚语义分家、Agent 节点子图嵌入与延迟编译、流式调试与发布门、Agent 工具化调用 | 已发布 |
| 04 [知识库与文件处理](04-knowledge-and-files.md) | 模块纵线 | 原型 unstructured 解析、Weaviate 语义检索与 jieba 关键词表（向量走 langchain-weaviate）→ Celery 索引链路、Embedding 指纹防混检、混合检索、文档与片段在线管理（三存储同步）、工作区文件交付 | 已发布 |
| 05 [工具体系](05-tool-system.md) | 模块纵线 | 原型内置工具目录与 API 工具配置转 StructuredTool → 内置 / API / MCP / 工作流四源统一 BaseTool、授权分层与只读重试边界 | 已发布 |
| 06 [模型接入](06-model-access.md) | 模块纵线 | 原型 providers.yaml 静态清单与特性位 → Provider Connection、动态模型目录发现、参数契约与上下文预算 | 已发布 |
| 07 [记忆与上下文](07-memory-and-context.md) | 模块纵线 | 原型数据库裁剪短期记忆与拼进提示词的长期记忆 → 动静分离提示词与前缀稳定、预算化压缩与历史归档、Store 文件式长期记忆 | 已发布 |
| 08 [应用与交付](08-app-and-delivery.md) | 模块纵线 | 原型草稿发布模型、InvokeFrom 多入口与 Redis 停止标志 → 配置版本与定义指纹、四入口授权、任务状态机与交互恢复（ask_user 中断、表单批次幂等、取消协调）、事件缓冲与快照恢复、测评闭环 | 已发布 |
| 09 [执行环境与 Skill 交付](09-sandbox-and-skills.md) | 模块纵线 | 原型进程内 exec（源码自带危险警告）→ SCF 云函数隔离 → 四 Provider 沙箱矩阵、会话租约池与代际校验、Skill 压缩上传与安全解包、统一虚拟路径路由 | 已发布 |
| 10 [Agent 测评与验收](10-agent-evaluation.md) | 模块纵线 | 原型没有的模块：历史评分与执行验收双链、条件更新认领与截止时间、证据与候选哈希绑定、Rubric 修订循环与终审放行门槛 | 已发布 |
| 11 [断线重连对照](11-disconnect-reconnect-comparison.md) | 对照 | 同一断点的两个答案：本平台的强恢复（持久序号 + 快照水位 + 孤儿收敛）对 Octop 的弱恢复（断开不杀轮 + 刷新补历史）；执行宿主与连接定位如何决定恢复语义 | 已发布 |

全部篇目已成文；后续新的复盘入册时，从本目录继续编号并同步此表。
