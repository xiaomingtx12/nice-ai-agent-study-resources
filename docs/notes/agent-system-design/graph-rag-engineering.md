---
sidebar_position: 11
description: "GraphRAG 工程化技巧 —— 什么时候该上 GraphRAG、实体关系抽取、图构建、社区检测与摘要、多跳检索路径。"
---

# GraphRAG 篇

GraphRAG 是 RAG 在"多跳问答 / 跨实体关系 / 全局主题问题"上的旁支形态。读这篇之前你应该已经掌握通用 RAG（详见 [RAG 工程篇](./rag-engineering.md)）——本篇聚焦 GraphRAG 与普通 RAG 的差异、什么时候该上、实体关系抽取、图构建、社区检测与摘要、多跳检索路径。

> **口径说明**：GraphRAG 是一类**思路**而不是一个框架。核心套路是"实体/关系抽取 → 图构建 → 社区检测 → 社区摘要 → 多跳检索"，这套流水线在不同实现里大体一致，但在**检索模式、增量更新能力、成本结构、社区算法**上差异很大。本篇提到的具体默认值、字段、Pipeline 在没有特别说明时都参考 Microsoft GraphRAG（[From Local to Global](https://arxiv.org/abs/2404.16130) 的开源实现）——它是这套思路里文档最完整的参考实现，但**不是唯一标准**。LightRAG / Fast-GraphRAG 等其他实现各有取舍，详见文末「十四、参考实现与生态对比」。

工程化的核心拉扯：图构建成本（实体抽取 + 关系抽取 + 社区检测）↔ 多跳问答能力。

---

## 一、动机

普通 RAG 单跳召回便宜，但答不了"X 和 Y 有什么关系 / 公司整体战略是什么"这类问题。GraphRAG 用图结构 + 社区摘要回答这类问题。

但 GraphRAG 的代价高：图构建一次成本 = 普通 RAG 索引的 5-20 倍，检索延迟 2-5s，多数项目不该用。

---

## 二、关键判断速览

- 核心问法里 ≥ 30% 是跨实体 / 多跳 / 全局主题才考虑 GraphRAG
- 知识量 500-100K 段才适合，太小不值得，太大成本爆炸
- 延迟容忍 2-5s，强实时场景走普通 RAG
- 预算能覆盖 5-20x 索引成本
- 实体抽取 schema 预定义，LLM 不自由抽
- 关系类型清单限定，避免三元组爆炸
- 多分辨率社区检测（Leiden 推荐），多粒度社区摘要
- 多跳检索跳数限制 ≤ 3
- GraphRAG + 普通 RAG 按意图协同

---

## 三、什么时候该上 GraphRAG

### 触发场景

| 场景 | 典型问题 | 普通 RAG 失败模式 |
|---|---|---|
| 跨实体关系 | "A 公司的 CEO 和 B 公司的 CTO 是什么关系？" | 单跳召回无法串联关系 |
| 多跳推理 | "X 事件导致 Y 变化，Y 变化又影响 Z" | 召回独立证据无法串联推理链 |
| 全局主题 | "这批文档讲的核心主题是什么？" | 段级检索只能召回局部 |
| 实体密集型知识 | 医疗 / 法律 / 金融 / 科研 | 实体是核心，段级粒度太粗 |
| 时序演化关系 | "A 产品从 v1 到 v3 经历了哪些变化？" | 历史变更需要图遍历 |

### 不该用 GraphRAG 的场景

| 场景 | 原因 |
|---|---|
| 知识 < 500 段 | 图构建成本远高于收益 |
| 问法单一（无多跳 / 无全局） | 普通 RAG 完全够用 |
| 实体稀疏（文档主体是概念不是实体） | 抽取出来的图很稀疏 |
| 强实时性（毫秒级响应） | 图检索延迟通常 > 1s |
| 强成本敏感 | 图构建成本是普通 RAG 的 5-20 倍 |

判断口诀：核心问法里 ≥ 30% 是跨实体 / 多跳 / 全局主题才考虑，否则不上。

---

## 四、实体抽取

### 抽取策略

| 策略 | 精度 | 成本 | 适用场景 |
|---|---|---|---|
| LLM 抽取 | 高 | 高 | 通用场景，实体类型多样 |
| NLP 工具（spaCy / Stanford NER） | 中（限定类型） | 低 | 实体类型固定（人名 / 地名 / 机构） |
| 混合（NLP 初筛 + LLM 精抽） | 高 | 中 | 大规模文档处理 |
| 领域微调模型 | 高 | 中（需训练） | 特定领域（医疗 / 法律） |

### 工程化要点

- Schema 预定义：实体类型清单（如 `[Person, Organization, Product, Event, Concept]`）+ 属性清单，LLM 按 schema 抽取
- Few-shot 示例：给 3-5 个标注样本，抽取质量显著提升
- Chunk 粒度：按段落或章节抽取（不要按句子，句子级会产生大量噪声三元组）
- 去重与合并：相同实体的不同表述合并（如 "GPT-4" / "GPT4" / "GPT-四" 合并为同一节点）
- 置信度过滤：LLM 输出置信度（high/medium/low），低于阈值丢弃

### 参考实现：微软 GraphRAG 的实体表（`entities.parquet`）

微软的实体抽取输出是一张宽表，关键字段：

| 字段 | 含义 | 工程化要点 |
|---|---|---|
| `id` | 实体的稳定 ID（基于 name hash） | 同一实体不同表述去重后共享一个 id |
| `name` | 实体的规范化名 | 写入图数据库时作为节点主键 |
| `type` | 实体类型 | 来源见下面"类型来源"取舍 |
| `description` | 实体的一段文字描述（LLM 生成） | 用于 Local Search 构造上下文 |
| `frequency` | 该实体在语料中出现的次数 | 用于实体重要性排序 |
| `degree` | 该实体在关系图中的度 | 图遍历时的节点权重 |
| `text_unit_ids` | 该实体出现的所有 text_unit 列表 | 回溯证据用 |

**实体类型的两个来源**：

- **手动 schema**：工程上稳定、可控，但需要先验领域知识，跨域迁移差
- **自动 `discover_entity_types`**：先用少量 text_unit 让 LLM 推断类型清单，再批量抽取。代价是多一次 LLM 调用，收益是开箱即用。生产环境推荐先跑一次 `discover_entity_types` 把类型清单固化下来，再批量抽取

抽取的 chunk 粒度默认 `chunk_size=300, overlap=100`（注意比通用 RAG 的 512/100 更细，因为实体抽取对边界敏感）。`--max_gleanings` 控制同一 chunk 的多轮抽取次数，默认 0；如果发现召回率低，开 1 能补回 10-20% 的边角实体。

### 实体合并：三种策略的取舍（扩展）

同名实体的不同表述（"GPT-4" / "GPT4" / "GPT-四" / "gpt-4 turbo"）必须合并成同一节点，否则下游所有关系都会被打散到不同节点，Local Search 召回率塌一半。

| 策略 | 阈值/算法 | 优点 | 缺点 | 推荐场景 |
|---|---|---|---|---|
| 名称规范化 + hash | lower() + 去标点 + hash(name) | 极快、可解释 | 处理不了语义等价（"川普"/"特朗普"） | 英文 / 技术名词 |
| 向量相似度 | embedding cosine ≥ 0.92 视为同一 | 处理语义等价 | 误合并风险（"苹果公司"/"苹果手机"被合并） | 中文 / 别名多的领域 |
| 关系重叠度 | Jaccard(邻居(A), 邻居(B)) ≥ 0.5 | 语义最准 | 计算昂贵、要先建图 | 高质量精修（小批量） |

**反模式**：单一策略走到底。英文场景纯 hash 就够，中文必须 hash + 向量双路。关系重叠度只用于离线 audit，不进生产管线（每次新实体进来都要算一遍邻居 Jaccard，10K 节点就慢到不可用）。

**工程经验值**：实体合并后节点数应下降 20-40%。下降 < 5% 说明抽取本身就没产生别名；下降 > 60% 说明过度合并，类型边界被破坏了（比如把"阿里"和"阿里巴巴"合并到同一节点，但其实是不同的实体类型）。

### Few-shot 模板（扩展）

实体抽取质量对 prompt 里的示例数量极敏感。0 示例 → 3 示例的提升远大于 3 → 10 示例。

```
任务：从文本中识别实体。
实体类型：{Person, Organization, Product, Event, Concept}

示例 1：
文本："OpenAI 于 2023 年发布 GPT-4，由 Sam Altman 领导。"
输出：[{"name": "OpenAI", "type": "Organization"},
       {"name": "GPT-4", "type": "Product"},
       {"name": "Sam Altman", "type": "Person"}]

示例 2：
文本："苹果公司的 iPhone 15 在中国市场销量下滑。"
输出：[{"name": "苹果公司", "type": "Organization"},
       {"name": "iPhone 15", "type": "Product"}]

示例 3（负例 —— 不要抽）：
文本："公司发布了新的战略。"
输出：[]   ← "公司"太泛，不算实体
```

**反模式**：示例都用同一种文本风格（全是新闻 / 全是技术博客）。示例要覆盖目标语料的 2-3 种典型风格，否则跨风格泛化差。

### discover_entity_types 的决策树（扩展）

```
未知领域 / 跨域迁移？
├── 是 → 跑 discover_entity_types（额外 1 次 LLM 调用 + 5-15K token）
│        ↓
│        固化类型清单（写进 settings.yaml 的 entity_types）
│        ↓
│        后续批量抽取用固定 schema
└── 否（领域稳定）→ 直接用预定义 schema
```

**反模式**：每次抽取都重新跑 `discover_entity_types`。`discover_entity_types` 是 prompt_tune 阶段的一次性成本，不该塞进生产 hot path。

### 实体类型分层（扩展）

不要把 Person / Organization / Product 和领域类型（如 Drug / Symptom / Gene）混在同一层。两层处理：

| 层级 | 类型清单 | 抽取方式 |
|---|---|---|
| 基础类型 | Person, Organization, Product, Event, Location | 通用 prompt / Few-shot |
| 领域类型 | Drug, Disease, Gene（医疗）；Contract, Clause, Party（法律） | 领域 prompt + 词典约束 |

分层抽取的好处：基础类型可以复用、领域类型可以单独调优。混在一起时领域类型容易污染基础类型（LLM 把 "Apple" 抽成 Fruit 而不是 Company）。

### 实体置信度计算（扩展）

LLM 直接输出 high/medium/low 太粗糙，需要加权：

```
confidence = w1 * llm_label + w2 * log(1 + frequency) / log(N) + w3 * degree / max_degree
其中：
  llm_label: high=1.0, medium=0.6, low=0.3
  frequency: 该实体在语料中的出现次数
  degree: 该实体在图中的度数
  推荐权重: w1=0.5, w2=0.3, w3=0.2
```

**阈值**：confidence < 0.4 的实体在索引阶段丢弃，能砍掉 10-20% 的低质量节点，但关系召回率只损失 < 2%。

**反模式**：只用 LLM 标签。LLM 倾向于给所有实体打 high（因为 prompt 里它没说打 high 会怎样），需要 frequency 和 degree 校正。

---

## 五、关系抽取

关系抽取是 GraphRAG 的最大成本——LLM 抽取一次 = 普通 chunk embedding 的 10-50 倍 token。

### 关键不变量：避免三元组爆炸

| 措施 | 作用 |
|---|---|
| 限定关系类型 | 先定义关系清单，LLM 只在清单内抽取 |
| 方向性标注 | `A works_for B` ≠ `B works_for A` |
| 证据保留 | 每条三元组保留来源 chunk_id |
| 置信度阈值 | 低于阈值丢弃 |
| 去重与合并 | 同一对实体的同一关系合并，保留最强证据 |

### 工程化要点

- 批量化抽取：把多个 chunk 合并成一次 LLM 调用
- 增量更新：文档更新时只对新 chunk 抽取
- 质量监控：抽完后统计"实体数 / 关系数 / 平均每个实体的关系数"，异常稀疏或稠密都是问题

### 参考实现：微软 GraphRAG 的关系三件套

`relationships.parquet` 的关键字段：

| 字段 | 含义 | 工程化要点 |
|---|---|---|
| `source` / `target` | 关系两端的实体 ID | 与 `entities.id` 对齐 |
| `weight` | 关系强度（出现频次 + 上下文权重） | 检索时用于路径评分 |
| `description` | 关系的一句话描述（LLM 生成） | 用于 Local Search 上下文构造 |
| `text_unit_ids` | 支撑该关系的所有 text_unit | 回溯证据 |
| `combined_degree` | source 和 target 的度之和 | 用来过滤"哑铃型"噪音边 |

**批量化策略**：微软的默认实现是把同一文档的所有 chunk 一次性送进 LLM，让模型在一次调用里输出所有实体-关系对。这避免了 N 次调用 + N 次拼接，但也要求 prompt 足够长（通常配合 8K/16K context 的模型）。如果文档很长，拆批时按"实体共现密度"分桶——同文档的 chunk 一批，跨文档弱关联的 chunk 不要硬塞同一批次。

**关系合并的去重逻辑**：同一对实体可能多次出现（不同 chunk 都说"A works_for B"），合并时按 description 相似度聚类，保留 weight 最高的那条作为主边，其它合并进 description 或作为 secondary edge。

### 关系消歧：同一对实体的多种关系（扩展）

真实语料里 (A, B) 可能同时是 "A 投资 B"、"A 收购 B"、"A 控股 B"——这三条不是互斥的，但聚合成一条会丢失信息。

| 处理方式 | 实现 | 适用 |
|---|---|---|
| 多边保留 | (A, B) 之间允许多条不同 type 的边 | 真实生产环境推荐 |
| 主导边选取 | 按 weight 取 top-1，其它进 description | 简化版（图谱瘦） |
| 时序边 | 加 `valid_period` 属性 | 时序敏感场景 |

**反模式**：所有关系塞进 description。描述塞不下、检索时无法按 type 过滤、图遍历时无法按 type 加权。

### 关系强度 weight 公式（扩展）

GraphRAG 的 `weight` 字段常被简化成"出现频次"，丢失大量信息。生产环境用：

```
weight = frequency × context_relevance × type_weight

其中：
  frequency: 跨 chunk 的共现次数（log 压缩，cap=10）
  context_relevance: 关系所在 chunk 与关系类型的相关度
                     （如"works_for"关系的 context 应包含职业/雇佣关键词）
  type_weight: 关系类型先验权重
               - 结构化（founded_by / acquired）: 1.0
               - 半结构化（works_for / located_in）: 0.8
               - 弱结构化（related_to / mentioned_with）: 0.5
```

**典型范围**：weight 应在 [0, 5] 之间。> 5 说明类型先验过松，< 0.1 说明抽取噪声。检索时按 weight > 0.5 截断，能砍掉 30% 的边但不损失召回。

### 跨 chunk 关系合并（扩展）

同一个关系 "Sam Altman works_for OpenAI" 可能在 N 个 chunk 里都被抽到。合并流程：

1. **同对识别**：source_id + target_id 完全一致的关系聚为一组
2. **同 type 校验**：组内关系 type 必须一致（不一致时按 type_weight 排序留主导、其余降级为次要边）
3. **证据合并**：text_unit_ids 列表合并（去重），description 取最长 / 最具体的版本
4. **weight 累加**：按上面公式重算，不是简单相加
5. **时间戳**：保留 `first_seen` / `last_seen` 用于时序分析

**反模式**：把不同 type 的 (A, B) 关系直接合并为 RELATES_TO。这是质量最大杀手——图谱失去了关系类型区分能力，Global Search 检索到的"关系"全是模糊语义。

### 关系类型层次化（扩展）

和实体类型一样，关系类型也要分层：

| 层级 | 示例 | 数量 |
|---|---|---|
| 通用关系 | related_to, part_of, located_in | 5-10 个 |
| 领域关系 | clinical_trial_for, treats, has_side_effect | 10-30 个 |
| 实例关系 | 极少直接预定义，由通用 + 领域组合 | 0 |

**反模式**：定义 100+ 关系类型让 LLM 选。LLM 在 > 20 个候选时准确率显著下降（典型曲线：5 个 type 时 precision 85%，20 个时降到 60%，50 个时降到 40%）。

**层次化的好处**：prompt 里只暴露通用 + 当前领域的 10-20 个类型，LLM 选得准；上层（其他领域的关系）由下层（更基础的关系）推断出来。

---

## 六、图构建

### 存储选型

| 存储 | 性能 | 适用规模 | 适用场景 |
|---|---|---|---|
| Neo4j | 高 | 百万级节点 | 生产级 GraphRAG |
| Memgraph | 极高 | 十万级节点 | 实时 GraphRAG |
| NetworkX | 低 | 千级节点 | 原型验证 / 小规模 |
| 向量图混合（Milvus + Neo4j） | 中高 | 百万级 | 实体检索 + 图遍历混合 |

### 图 Schema

- 节点：实体（Entity），属性 = 实体类型 + 抽取时的属性
- 边：关系（Relation），属性 = 关系类型 + 权重 + 来源 chunk_id + 置信度
- 元节点：社区（Community），连接到所有社区成员实体
- 元边：实体 ↔ 社区 / 社区 ↔ 社区 的归属关系

### 工程化要点

- 图谱版本管理：图谱迭代要保留版本
- 图谱增量更新：文档新增 / 修改时只更新受影响子图
- 图谱健康检查：孤立节点数 / 平均度数 / 最大连通分量

### 参考实现：微软 GraphRAG 的 6 类节点 + 7 类关系（Neo4j 落地）

把抽取结果落到 Neo4j 时，节点不是只有"实体"一种。完整建模是 6 类节点 + 7 类关系：

**6 类节点**：

| 节点 | 来源表 | 用途 |
|---|---|---|
| `Document` | `documents.parquet` | 原始文档锚点，便于回溯 |
| `TextUnit` | `text_units.parquet` | 切分后的最小文本块，关联实体和关系 |
| `Entity` | `entities.parquet` | 抽取出来的实体 |
| `Relationship` | `relationships.parquet` | 实体间关系（在某些建模里作为边而非节点） |
| `Community` | `communities.parquet` | 社区检测算法产出的社区 |
| `CommunityReport` | `community_reports.parquet` | 社区的 LLM 摘要，作为 Global Search 的检索对象 |

**7 类关系**（典型实现，可按需裁剪）：

| 关系 | 起点 → 终点 | 关键属性 |
|---|---|---|
| `CONTAINS` | Document → TextUnit | 顺序 |
| `MENTIONS` | TextUnit → Entity | 出现次数 |
| `RELATES_TO` | Entity → Entity | weight, description |
| `BELONGS_TO` | Entity → Community | community_level |
| `REPORTS_ON` | Community → CommunityReport | rank |
| `REFERENCES` | CommunityReport → Entity | 引用列表 |
| `NEXT_CHUNK` | TextUnit → TextUnit | 顺序（支持上下文窗口扩展） |

工程化要点：

- 把 CommunityReport 作为独立节点（而不是 Community 的属性），原因是 Global Search 的检索对象是报告而不是社区本身，独立节点能加向量索引、支持 Rerank
- TextUnit 节点必须保留，否则 Local Search 的"从实体回查到原文"路径就断了——这是普通 RAG 用 chunk 做而 GraphRAG 多走一跳的代价
- 导入时用 batch（UNWIND + MERGE），单文档万级节点的小图几分钟内能完成；超过百万级要分片 + 关索引

### 内存图 vs 磁盘图的选择（扩展）

| 维度 | NetworkX | igraph | Neo4j |
|---|---|---|---|
| 规模上限 | ~10K 节点 | ~1M 节点 | 100M+ 节点 |
| Leiden 支持 | 通过 python-louvain | 原生 | 通过插件 |
| 持久化 | 无（每次重建） | 无 | 原生 |
| 查询语言 | Python | Python/R | Cypher |
| 适用阶段 | 原型 / 调试 | 中等规模离线计算 | 生产 / 检索 |

**经验值**：1 万节点以下 NetworkX 够用；1-100 万用 igraph 跑 Leiden 比 Neo4j 快 5-10x（但只算不查）；100 万以上必须 Neo4j + 索引。

**反模式**：开发期用 Neo4j、调试图遍历逻辑时 Cypher 跑半天。开发期用 NetworkX + Leiden 跑通，落地时再迁 Neo4j——Leiden 计算结果可以直接序列化导出。

### Neo4j 索引策略（扩展）

落地 Neo4j 时不建索引 = 慢查询。生产环境必建：

| 索引 | 类型 | 字段 | 用途 |
|---|---|---|---|
| 实体名全文 | FULLTEXT | `Entity.name` + `Entity.description` | Local Search 实体定位 |
| 实体类型 | BTREE | `Entity.type` | 按类型过滤 |
| 关系权重 | BTREE | `RELATES_TO.weight` | 路径评分、剪枝 |
| 社区层级 | BTREE | `BELONGS_TO.community_level` | Global Search 按层级过滤 |
| 文档回查 | BTREE | `Document.id` / `TextUnit.id` | 回溯原文 |

**反模式**：建索引时不指定 type（如对所有 label 建全文索引）。Neo4j 全文索引会扫描所有 label，百万节点级别显著拖慢写入。

### Cypher 查询优化（扩展）

**批处理导入**：
```cypher
UNWIND $batch AS row
MERGE (e:Entity {id: row.id})
SET e.name = row.name, e.type = row.type, e.description = row.description
```

`UNWIND + MERGE` 比逐条 `CREATE` 快 10-50x。单文档万级节点用 batch（每批 1000 条），百万级要分片 + 关索引。

**慢查询诊断**：
```cypher
PROFILE MATCH (e:Entity {name: "GPT-4"})-[r:RELATES_TO]->(n)
WHERE r.weight > 0.5
RETURN n ORDER BY r.weight DESC LIMIT 10
```

`PROFILE` 看执行计划，重点看是否走了索引扫描。出现 `NodeByLabelScan` 就是没建索引，立即加。

**反模式**：
- 在 MATCH 路径里用 `*`（可变跳数），性能不可预测
- 用 `OPTIONAL MATCH` 不加方向，Cypher 优化器容易全图扫
- 百万级图不关索引就导入，写入性能差 5-10x

### 图版本管理（扩展）

知识图谱每次重建都应该留版本，否则出问题无法回滚：

```cypher
// 创建版本快照
MATCH (e:Entity)
WHERE NOT (e)-[:VERSION_OF]->()
SET e:GraphV2024Q1
CREATE (e)-[:VERSION_OF {snapshot_date: date()}]->(:Snapshot {tag: 'v2024q1'})
```

**简化版**：用 graphrag_version 标签（`Entity:V2024Q1`）+ 时间戳字段。回滚时按标签过滤。

**反模式**：每次重建 `MATCH (n) DETACH DELETE n`——这是破坏性操作，生产环境必须先备份。

### 图谱健康检查指标（扩展）

定期跑（建议每日）：

| 指标 | 公式 | 健康范围 | 异常处理 |
|---|---|---|---|
| 孤立节点比例 | count(no edge) / count(all) | < 5% | > 10% 检查合并逻辑 |
| 平均度数 | sum(degree) / n | 3-15 | < 2 检查合并过度；> 30 检查类型边界 |
| 最大连通分量占比 | size(largest_cc) / n | > 70% | < 50% 检查图是否被切碎 |
| 节点类型分布熵 | Shannon(类型分布) | > 1.5 | < 1.0 说明某种类型过度主导 |
| 关系 type 分布熵 | Shannon(关系分布) | > 2.0 | < 1.0 关系类型过少 |

**反模式**：只看节点 / 边总数。总数正常但孤立节点 30% 也是灾难——Local Search 召回直接报废。

---

## 七、社区检测与摘要

### 社区检测算法

| 算法 | 速度 | 社区质量 | 适用规模 |
|---|---|---|---|
| Louvain | 快 | 中 | 大规模（百万级节点） |
| Leiden | 中 | 高（避免 Louvain 的 badly connected 问题） | 推荐默认 |
| Label Propagation | 极快 | 低 | 极大规模 |
| Infomap | 中 | 高（基于信息流） | 中等规模 |

通常跑多分辨率生成多层社区树。分辨率高 → 小社区（细节多），分辨率低 → 大社区（抽象高）。过小社区（< 3 节点）合并到最近的社区。实体可属于多个社区（重叠社区检测）。

### 社区摘要

- LLM 摘要：把社区内所有实体的描述 + 关系喂给 LLM，生成"这个社区讲什么"的总结
- 多粒度摘要：每个社区生成多个长度（50 / 200 / 500 字）的摘要，按查询复杂度选
- 要点提取：不仅生成全文摘要，还提取"3-5 个要点"作为结构化索引

摘要质量决定全局问答质量。社区摘要是"全局主题问题"的检索对象。摘要要保留实体引用，方便回查。

### 参考实现：微软 GraphRAG 的 Leiden 多分辨率 + 社区报告

**Leiden 多分辨率的默认行为**：微软的实现默认跑三层社区（level 0 / 1 / 2），每层都是 Leiden 但分辨率参数不同——layer 0 是最细粒度（小社区，几十实体），layer 2 是最粗粒度（大社区，几百到上千实体）。Global Search 默认从 layer 2 开始检索，因为大社区的摘要更稳定、更适合回答宏观问题。

**社区报告 parquet 的关键字段**：

| 字段 | 含义 | 工程化要点 |
|---|---|---|
| `community` | 社区 ID | 与 `Community` 节点对齐 |
| `level` | 社区所在层级 | Global Search 时按层级过滤 |
| `title` | 社区的短标题（LLM 生成） | 检索时作为强信号 |
| `summary` | 社区的一句话摘要 | 检索时的语义匹配主体 |
| `findings` | 3-5 个结构化要点 | 比 summary 更适合做引用 |
| `full_content` | 社区报告完整内容 | 喂给 LLM 生成的上下文 |
| `rank` | 社区重要性分 | 配合 Global Search 截断 top-N |
| `entity_ids` | 社区包含的实体列表 | 回查证据 |

**为什么 `findings` 比 `summary` 更值钱**：`summary` 是一段流畅文字，检索时容易和 query 模糊匹配；`findings` 是结构化要点列表，可以逐条比对、更容易触发精确引用。Global Search 的实现里通常先把 `findings` 向量化做粗排，再用 `full_content` 做精排。

**多粒度摘要的取舍**：微软的实现是"一份报告覆盖多个层级"——同一社区在不同 level 都有摘要，但内容是 LLM 重新生成的（不是简单的"父级摘要 = 子级摘要的拼接"）。代价是摘要成本 × 层级数；收益是 Global Search 可以自由选层级。生产环境通常只跑 layer 1-2，layer 0 留给 Local Search 用。

### Leiden vs Louvain：核心差异（扩展）

Louvain 在某些情况下会产生"badly connected"社区——社区内部不连通（社区 A 内部，节点 a 到 b 没有内部路径，必须绕过社区外的节点）。Leiden 通过 refinement 阶段修复这个问题。

| 维度 | Louvain | Leiden |
|---|---|---|
| badly connected 风险 | 有 | 无 |
| 模块度 | 略高（贪心过头） | 略低但更稳健 |
| 速度 | 快 | 慢 20-30% |
| 推荐 | 不推荐生产 | 推荐默认 |

**反模式**：用 Louvain 跑多分辨率社区树。Louvain 在第二层经常合并出 badly connected 社区，下游 Global Search 召回混乱。

### 多分辨率剪枝（扩展）

Leiden 默认会产出大量小社区（2-3 节点的"伪社区"），必须剪枝：

| 剪枝策略 | 阈值 | 收益 | 代价 |
|---|---|---|---|
| 过小社区合并 | size < 3 → 合并到最近的邻居社区 | 砍掉 15-30% 社区数 | 损失少量小主题 |
| 相邻相似合并 | Jaccard(成员) > 0.7 且 size 都 < 10 | 砍掉 5-10% 社区数 | 减少过度切分 |
| 巨型社区拆分 | size > max_cluster_size（默认 10）→ 强制二次 Leiden | 防止 Global Search 跑飞 | 摘要成本上升 |

**经验值**：剪枝后社区数应为剪枝前的 50-70%。剪枝 < 30% 说明剪枝不够；剪枝 > 80% 说明 Leiden 分辨率过高。

### 社区质量度量（扩展）

跑完 Leiden 不代表质量好，必须验证：

| 指标 | 含义 | 健康范围 |
|---|---|---|
| 模块度 Q | 社区内边占比 vs 随机期望 | > 0.3（> 0.5 优秀） |
| 归一化互信息 NMI | 与 ground truth 社区的一致度 | > 0.6（有标注时） |
| 覆盖率 | 节点被分到社区的比例 | > 95%（含孤立点也算） |
| 平均社区大小 | mean(size) | 5-50 |
| 社区大小分布 | 应该是长尾，不是双峰 | 单峰长尾 |

**反模式**：只看模块度。模块度高不代表社区"语义上合理"——可能把所有节点塞进 1-2 个大社区。要配合社区大小分布看。

### 摘要失败模式（扩展）

社区摘要 LLM 调用是 GraphRAG 质量最大变量。常见失败：

| 失败模式 | 表现 | 根因 | 修复 |
|---|---|---|---|
| 摘要过抽象 | "这是一个关于技术的社区"——丢失所有实体名 | prompt 没要求保留实体名 | 显式要求 "列出 5 个最重要实体" |
| 失去实体引用 | summary 里不出现任何实体名 | LLM 倾向概括而非具象 | prompt 加 "每个事实必须标注实体名" |
| 包含幻觉 | 摘要提到了图里没有的关系 | LLM 用先验补全 | 后处理：摘要里的实体名必须在原图里存在，否则丢弃 |
| 摘要太长 | full_content > 2000 字 | max_length 没设上限 | cap=500 |
| 重复摘要 | N 个社区摘要内容雷同 | Leiden 分辨率太低 | 提升分辨率或合并相似社区 |

**后处理校验**：摘要里所有实体名必须存在于该社区的实体列表，缺失的实体名当作幻觉过滤。这一步能砍掉 60-80% 的幻觉内容。

### 多粒度摘要的缓存策略（扩展）

多层级摘要（layer 0 / 1 / 2）的 LLM 调用是 GraphRAG 最大成本之一。缓存策略：

| 策略 | 实现 | 适用 |
|---|---|---|
| 同社区跨层复用 | layer 2 的 summary 直接作为 layer 1 / 0 的简短版（截断） | 牺牲粒度换成本 |
| 同层跨时间复用 | 实体没变就不重抽摘要 | 增量更新场景 |
| Embedding 缓存 | summary 的 embedding 一次算、长期复用 | 所有场景 |
| 摘要索引 | 摘要按"层级 + 社区 ID"做两级 key 缓存 | 重复查询场景 |

**反模式**：每个社区每个层级都跑独立 LLM 调用。1000 社区 × 3 层 = 3000 次 LLM 调用，每次 $0.05 = $150/次重建。复用策略能砍到 500-800 次。

**经验值**：摘要总成本应控制在图构建总成本的 30-50%。超过 60% 说明层级太多或社区太碎；低于 20% 说明摘要质量可能不够细。

---

## 八、多跳检索路径

> **重要补遗**：上一节的"四类路径"是抽象分类，真实工程里 GraphRAG 的检索模式已经远不止"实体定位 → 图遍历"这一种。微软 GraphRAG 开源了 4 种内置检索模式（Local / Global / DRIFT / Basic），分别对应不同的问法。本节先给出抽象分类，再落到这 4 种真实实现。

### 抽象分类（沿用上一版）

| 路径 | 触发场景 | 步骤 |
|---|---|---|
| 实体定位 → 单跳邻居 | "X 的合作伙伴是谁？" | 实体识别 → 图遍历 1 跳 → 邻居实体列表 |
| 实体定位 → 多跳路径 | "X 如何影响 Z？" | 实体识别 → 图遍历 2-3 跳 → 路径实体序列 |
| 全局主题 | "整体讲什么？" | 社区摘要检索 → top-K 社区 → 社区内实体列表 |
| 混合 | 综合问题 | 实体路径 + 全局社区，合并答案 |

工程化要点：

- 跳数限制 ≤ 3，4+ 跳召回噪声爆炸
- 路径评分：图遍历时按"边权重 + 节点重要性（PageRank）"排序
- 路径剪枝：遍历时剪掉低权重分支，避免组合爆炸
- 双向遍历：从 query 实体出发 + 从候选实体出发，双向 BFS 找最优路径

### 参考实现：微软 GraphRAG 的 4 种检索模式

微软 GraphRAG 的查询侧是 4 种模式并存，按问法类型选择，不是非此即彼：

#### Local Search（基于实体的检索）

适用问法：**who / what / when** —— 答案围绕特定实体展开。

底层 6 步流程：

1. **从查询里抽取实体**（用实体抽取的小模型或关键词匹配）
2. **加载 5 类上下文数据**：entities / relationships / communities / community_reports / text_units / covariates（协变量表，如情感、强度）
3. **按实体 1 跳邻居**扩展（拿到邻居实体 + 关系 + 涉及的 text_unit）
4. **按"重要性 + 相似度"排序截断**：用节点 degree + text_unit embedding 与 query 的相似度
5. **构造上下文**：把实体描述 + 关系描述 + text_unit 原文 + 社区摘要拼成 prompt
6. **LLM 生成答案**，要求每个事实标注引用编号

适用与代价：单查询延迟 2-3s（不含社区摘要 Rerank），token 消耗随邻居数线性增长。问题里实体稀疏或实体没在图里时效果退化——这是 Local Search 的最大弱点。

#### Global Search（基于社区摘要的检索）

适用问法：**整体讲什么 / 主题是什么** —— 答案需要跨多个社区汇总。

底层是 map-reduce 流程：

1. **检索候选社区报告**：用社区报告的 `findings` / `summary` 做 embedding，与 query 做相似度
2. **取 top-K 社区报告**（默认按 `rank` 截断，通常 K=10-20）
3. **Map 阶段（并行）**：每个社区报告独立喂给 LLM 生成"部分答案"
4. **Reduce 阶段**：把所有"部分答案"汇总喂给 LLM 生成最终答复
5. **LLM 生成答案**，要求每个事实标注来自哪个社区

适用与代价：单查询延迟 5-15s（因为是两次 LLM 调用 + map 阶段并行），token 消耗高（map 阶段要重复 LLM 调用）。社区摘要质量决定一切。增量更新时 Global Search 是最难的部分——社区变了摘要就要重生成。

#### DRIFT Search（Local + Global 混合）

适用问法：**先具体后宏观** —— "X 是什么 → 那 Y 呢 → 整体上看呢？"

底层思路：

1. 先用 Local Search 找到种子实体和局部子图
2. 从种子出发扩展 1-2 跳
3. 把扩展后的子图映射回所属社区
4. 用 Global Search 思路对涉及社区做 map-reduce

代价是单查询延迟最高（Local + Global 都跑），但能答"基于具体事实的宏观问题"。生产环境只在用户问题明显是"具体 + 宏观"两层结构时才用。

#### Basic Search（向量 RAG 兜底）

适用问法：**和图无关的纯文本问题** —— "文档里有没有提到 X"。

底层就是普通向量检索：query → embedding → text_units 向量库 → top-K → LLM。微软把它也作为内置模式之一，目的是让用户在没有图的场景下也能用同一套 Pipeline。

### 工程化要点（按 4 种模式补充）

- **模式选择靠意图识别**：用户问题先过一次意图分类器（成本极低，关键词 + 规则就够），按问法类型派发到对应模式。意图分类出错时退回到 Basic Search 而不是报错
- **Local Search 的兜底**：实体识别失败时退到 Basic Search（用 query 做 embedding 检索 text_unit），而不是返回空
- **Global Search 的并行度**：map 阶段并发数 = top-K 社区数 / token 预算，单 LLM 调用超时设置 30s，超时社区直接跳过
- **DRIFT Search 的开关**：默认关闭，只在 query 分类器识别出"局部 + 全局"双层结构时才启用

### GraphRAG + 普通 RAG 协同

```
query → 意图识别
  ├─ 跨实体 / 多跳 → GraphRAG Local Search（图遍历 + 邻居扩展）
  ├─ 全局主题 → GraphRAG Global Search（社区摘要 map-reduce）
  ├─ 双层结构 → GraphRAG DRIFT Search（Local + Global 串联）
  ├─ 纯文本 → Basic Search（向量 RAG 兜底）或普通 RAG
  └─ 实体稀疏 → Basic Search 兜底
结果合并 → LLM 生成答案 + 引用标注
```

### Local Search 深度（扩展）

**调用栈骨架**（Python 风格，仅关键步骤）：

```
def local_search(query, graph, config):
    seed_entities = extract_or_match_entities(query, graph)   # ①实体识别
    if not seed_entities: return basic_search(query, ...)    # 兜底：直接走 Basic
    neighbors = one_hop_expand(seed_entities, graph, max_hops=config.hops)  # ②邻居扩展
    candidates = rank_by_importance_and_similarity(
        neighbors, query_embedding,
        weights=(0.4 node_degree, 0.4 edge_weight, 0.2 sim))  # ③排序
    context = build_context(candidates,                       # ④构造 prompt
        include=["entity_desc", "rel_desc", "text_unit", "covariates"],
        token_budget=config.context_window)
    answer = llm.generate(context + query, require_citations=True)
    return answer
```

**失败模式**：

| 场景 | 表现 | 兜底 |
|---|---|---|
| Query 里全是抽象概念（"整体战略 / 核心矛盾"） | 实体识别返回空集 | 退回 Basic Search |
| 实体用了别名、缩写、错别字 | 命中不到图节点 | 同义词词典 + 编辑距离匹配（≤3 字符） |
| 种子实体是孤立点（degree=0） | 邻居为空 | 同名实体合并检查 + 强制走 text_unit 倒排 |
| 邻居 1 跳扩展膨胀（中心节点 degree > 200） | token 爆炸 | degree > 阈值（默认 50）只取 top-K by edge weight |
| 实体识别返回 > 20 个种子 | 拼接上下文超长 | 只取 degree 最高的 3-5 个种子 |

**调优参数**：

| 参数 | 默认 | 影响 | 取舍 |
|---|---|---|---|
| `max_hops` | 1 | 召回深度 / 延迟 / 成本 | 1 跳最稳，2 跳 recall +10-15% 但 token ×3-5 |
| `neighbor_top_k` | 10 | 召回宽度 / context 大小 | 5-30，超过 30 LLM 被噪声淹没 |
| `entity_match_threshold` | 0.7 | 实体识别准确率 | 太低 → 错配；太高 → 召回不到 |
| `degree_fanout_cap` | 50 | 防爆 | 中心节点只取 top-K 边 |
| `context_token_budget` | 8000 | prompt 大小 | 配 16K 模型时调到 12K |
| `require_citations` | True | 忠实度 / 延迟 | 关掉省 15% token，但忠实度 -20% |

**评测方法**：

- 构造 100-300 条 query-答案对，按跳数分桶（1 跳 / 2 跳 / 3 跳 / 4 跳）
- 三个指标：**实体命中率**（ground truth 实体是否在 seed_entities 里）/ **邻居召回率**（ground truth 关系是否在 neighbors 里）/ **答案 EM 分数**
- 退化场景必测：实体稀疏（query 没有具体实体名）/ 别名场景 / 冷启动空图

### Global Search 深度（扩展）

**调用栈骨架**：

```
def global_search(query, community_reports, config):
    q_emb = embed(query)
    ranked = vector_search(community_reports.findings + summary,
                           q_emb, top_k=config.global_top_k)  # ①粗排
    ranked = rerank(ranked, query, top_k=config.global_rerank_k)  # ②精排
    partials = []
    with ThreadPoolExecutor(max_workers=config.map_concurrency) as ex:  # ③map 并行
        partials = list(ex.map(
            lambda r: llm.generate(map_prompt(r, query), timeout=30),
            ranked))
    partials = [p for p in partials if p is not None]  # 过滤超时
    answer = llm.generate(reduce_prompt(partials, query))  # ④reduce
    return answer
```

**失败模式**：

| 场景 | 表现 | 兜底 |
|---|---|---|
| top-K 社区里没有相关内容 | 答案编造 | 把 top-K 扩到 30 再筛，或退回 Local |
| 摘要质量差（过于抽象） | 答非所问 | 强制走 `findings` 字段而不是 `summary` |
| LLM 在 reduce 阶段超 token | 回答截断 | reduce 阶段用二次 map-reduce（10→3→1） |
| 并发打爆 LLM 限流 | 大量超时 | semaphore 控制并发，配 IP 维度的 rate limit |
| 社区摘要过时（增量更新没跑） | 全局问答回退到旧主题 | 摘要带 `generated_at`，过期超 7 天强制重生成 |

**调优参数**：

| 参数 | 默认 | 影响 | 取舍 |
|---|---|---|---|
| `global_top_k`（粗排 K） | 10 | 召回 / 成本 | 5-30，单次查询 LLM 调用次数 = K |
| `global_rerank_k`（精排 K） | 10 | 同上 | ≤ 粗排 K；多花 Rerank 钱换精度 |
| `map_concurrency` | 10 | 延迟 / 限流 | 对齐 LLM provider 的 RPM 限制，gpt-4 一般 ≤ 20 |
| `map_timeout` | 30s | 失败率 | 太短误杀，太长拖死线程池 |
| `reduce_max_partials` | 20 | reduce prompt 大小 | 多了截断 / 二次 map-reduce |
| `community_level_filter` | [2] | 抽象层级 | layer 2 是默认宏观；问"细节"用 layer 0-1 |

**评测方法**：

- 全局主题 query 集 50-100 条，ground truth = 涉及的社区 ID 列表
- **社区命中率** = ground truth 社区出现在 top-K 的比例
- **答案忠实度** = LLM Judge 打分（每事实是否被图证据支撑）
- 对比 baseline：**不用粗排直接全量 map**（成本对照）

### DRIFT Search 深度（扩展）

**调用栈骨架**：

```
def drift_search(query, graph, community_reports, config):
    seed_entities = extract_entities(query, graph)
    subgraph = expand_with_followups(seed_entities, graph,
                                      followup_rounds=2)     # ①Local 扩展
    community_ids = map_entities_to_communities(subgraph.nodes,
                                                community_reports)
    partials = map_phase(community_ids, query)  # ②只对相关社区 map
    return reduce_phase(partials, query)
```

**失败模式**：

| 场景 | 表现 | 兜底 |
|---|---|---|
| 子图膨胀（涉及社区 > 50 个） | 直接退化为 Global Search | 强制截断到 top-20 社区 |
| Local 步骤超时 | DRIFT 整体超时 | 设置 `subgraph_entity_cap=200` |
| followup 扩展无收敛 | LLM 反复追问直到 token 用完 | followup_rounds ≤ 3 |

**调优参数**：

| 参数 | 默认 | 影响 |
|---|---|---|
| `followup_rounds` | 1 | 局部深度，token × 倍数 |
| `subgraph_entity_cap` | 200 | 防爆 |
| `enable_drift`（全局开关） | False | 默认关，只在双层结构问法才开 |

**评测方法**：

- 必须有"具体 + 宏观"双层结构的 query（占总评测集 ≤ 20%）
- 对比 Local-only / Global-only，DRIFT 应在双层 query 上高 10-20%
- 延迟预算：DRIFT 单查询 ≤ 15s，超了直接退回 Global

### Basic Search 关键点（扩展）

**调用栈骨架**：

```
def basic_search(query, vector_store, config):
    chunks = vector_store.similarity_search(embed(query), k=config.k)
    chunks = rerank(chunks, query, top_k=config.rerank_k)
    context = concat(chunks)
    return llm.generate(context + query)
```

**关键点**：

- 不是"凑数"模式，是 GraphRAG 体系的**安全网**——所有其他模式失败时的兜底
- 单查询延迟 < 1s（无图遍历），适合实时场景
- 评测时必须保证 Basic Search 在"图无关 query"上和普通 RAG baseline 持平

### 4 种模式的反模式汇总（扩展）

| 反模式 | 后果 |
|---|---|
| 意图分类器漏判，让"主题问题"走 Local Search | 召回 0，答非所问 |
| 意图分类误派 DRIFT | 延迟飙到 10s+，用户弃用 |
| Local Search 实体识别失败时直接返回空（不回退 Basic） | 30%+ query 无法回答 |
| Global Search 不做粗排直接全量 LLM | 单查询成本 ×10-20 |
| DRIFT 默认开启 | 90% query 走错路，延迟全栈翻倍 |
| 4 种模式共用同一 prompt 模板 | 答案风格混乱，引用编号对不上 |

---

## 九、工程化代价

### 成本对比（相对普通 RAG）

| 环节 | 普通 RAG | GraphRAG | 倍数 |
|---|---|---|---|
| 索引构建（一次性） | embedding + 向量入库 | 实体抽取 + 关系抽取 + 图构建 + 社区检测 + 社区摘要 | 5-20x |
| 检索成本（每次查询） | 向量检索 + Rerank | 实体识别 + 图遍历 + 社区摘要检索 + 普通 RAG | 2-5x |
| 存储 | 向量库 | 图数据库 + 向量库 + 摘要库 | 3-10x |
| 延迟 | 0.5-2s | 2-10s | 2-5x |
| 维护 | 文档更新即重建 | 文档更新 → 增量抽取 → 增量建图 → 增量摘要 | 3-5x |

### 微软 GraphRAG 的默认参数经验值

| 参数 | 默认值 | 经验值范围 | 取舍 |
|---|---|---|---|
| `chunk_size` | 300 | 200-500 | 比通用 RAG 的 512 细，因为实体抽取对边界敏感 |
| `chunk_overlap` | 100 | 50-150 | 与 chunk_size 比例 1:3 到 1:2 |
| `max_gleanings` | 0 | 0-1 | 开 1 能补回 10-20% 边角实体，token 翻倍 |
| Leiden 层级 | 0-2 | 0-3 | 多一层 ≈ 摘要成本 × 1.5 |
| Global Search top-K 社区 | 10-20 | 5-30 | 多了 token 爆炸，少了召回不全 |
| Local Search 邻居跳数 | 1 | 1-2 | 2 跳以上 token 爆炸 |

### 多模态与多源的额外成本

- **PDF 多模态**：用 MinerU 这类工具先做 OCR + 版面分析，单页处理 1-3s，整体索引时间再翻 2-5x
- **CSV / 关系库接入**：行级动态切分 + 结构化元数据注入会让实体数显著膨胀（原本不构成实体的列名、字段值都被建模），实体数 / 关系数通常比纯文本高 3-10x
- **prompt_tune**：第一次跑 11 步流程要额外消耗 5-15K token 的 LLM 调用，但能把 prompt 适配到当前领域，长期收益大于成本

### 何时值得付出

- 业务价值：跨实体关系 / 多跳推理 / 全局主题是核心需求
- 规模合理：知识量 ≥ 500 段 / ≤ 100K 段
- 延迟容忍：用户能接受 2-5s 响应

### 成本模型：token 级别拆解（扩展）

| 环节 | 单次成本公式 | 默认参数下的典型值（GPT-4o 计价） |
|---|---|---|
| 实体抽取 | `N_chunks × (input_tokens + output_tokens) × price` | 1K 文档 × 300 token/chunk × 2.5 prompt 完成 ≈ $15-30 |
| 关系抽取 | `N_chunks × tokens_per_chunk × LLM_cost × 1.3`（prompt 更长） | 同规模 ≈ $20-50 |
| 图构建 | `N_entities × N_relationships × log(N)` 写入开销 | Neo4j MERGE ≈ 5-15 分钟 / 万节点 |
| Leiden | 图规模相关，通常秒级 | 10K 节点 < 30s，100K 节点 1-3min |
| 社区摘要 | `N_communities × LLM_cost × tokens_per_community_summary` | 500 社区 × 500 token × $0.015 ≈ $3-8 |
| 向量嵌入 | `N_entities × embedding_cost` | text-embedding-3 ≈ $0.1 / 1M token，可忽略 |

**单次全量索引总成本 = 实体 + 关系 + 摘要三项之和**，三项里**关系抽取独占 50-60%**。一份 1 万文档、每文档 3 段、单段 300 token 的语料：单次全量 ≈ **$50-120**，加 prompt_tune 加 Leiden 加存储 Neo4j ≈ **$80-150**。

**检索成本（按查询分摊）**：

| 模式 | 单查询 token 消耗 | 延迟 | 单查询成本 |
|---|---|---|---|
| Local | 2K-8K | 2-3s | $0.005-0.02 |
| Global | 15K-50K（map 阶段 + reduce） | 5-15s | $0.03-0.10 |
| DRIFT | 30K-100K | 10-20s | $0.06-0.20 |
| Basic | 1K-3K | 0.5-1s | $0.002-0.005 |

### 各阶段耗时瓶颈（实测经验值）

| 阶段 | 万级文档耗时 | 十万级文档 | 瓶颈点 |
|---|---|---|---|
| 实体抽取 | 30min-2h | 5-20h | **最大瓶颈**，LLM 串行调用 |
| 关系抽取 | 1-3h | 10-50h | **最大瓶颈**，prompt 更长 + batch 内冲突 |
| 图 MERGE 写入 | 5-15min | 1-3h | Neo4j UNWIND + 索引构建 |
| Leiden | < 30s | 1-3min | 不是瓶颈，但社区数爆炸时摘要慢 |
| 社区摘要 | 10-30min | 2-10h | **第二大瓶颈**，LLM 调用次数 = 社区数 |
| 向量嵌入 | < 5min | 30-60min | embedding API 限流 |

**真正决定项目能否落地的瓶颈 = 实体 + 关系抽取**。社区摘要是 LLM 调用数（= 社区数）线性增长，但实体抽取是 token 总量线性增长——**前者是 QPS 瓶颈，后者是 token 预算瓶颈**。

### 加速策略（扩展）

| 策略 | 加速比 | 代价 |
|---|---|---|
| 实体 / 关系抽取并行化（thread + async） | 3-5x | 撞 LLM RPM 限流，需要 semaphore |
| 增量更新（只抽新 chunk） | 10-50x（增量时） | 牺牲一定社区一致性，需定期全量重建 |
| Prompt + 输出缓存（同 chunk 复用） | 1.5-3x（重复文档场景） | 文档变更检测逻辑要准 |
| 模型降级（实体抽取 → gpt-4o-mini） | 5-10x 成本，2-3x 速度 | 实体识别精度降 5-10%，需要对照评测 |
| Batch 抽取（多 chunk 单次 LLM 调用） | 1.5-2x 速度 | prompt 撑大，token 浪费在小样本上 |
| Leiden 跳过分辨率层 | 减少 30-50% 摘要时间 | 摘要粒度变粗 |
| 取消 `discover_entity_types` | 省 5-10min | 必须先手动定 schema |
| `max_gleanings=0` | -50% 抽取时间 | 召回率掉 10-20% |

**反模式**：实体 / 关系抽取都开了 `max_gleanings=1`（token ×2，但召回只 +10-15%）；全量重建当增量用（更新成本和初次一样）；关系抽取 prompt 不限定类型清单（三元组爆炸）。

### 何时该砍 GraphRAG（ROI 阈值，扩展）

**砍掉的硬指标**（任一满足即砍）：

| 指标 | 阈值 | 原因 |
|---|---|---|
| 知识量 | < 500 段 | 图构建成本 < 收益 |
| 多跳 / 全局问题占比 | < 30% | 70% query 走普通 RAG 更省 |
| 延迟预算 | < 2s | GraphRAG 最低 2-3s |
| 索引重建频率 | 每天一次以上 | 增量更新撑不住 |
| 单查询 token 预算 | < 3K | Local 都跑不动 |
| 团队 GraphRAG 经验 | 无 | 出问题排查周期 > 2 周 |

**ROI 计算公式**：

```
单 query 价值 = 业务单价 × 查询带来的转化 / 总 query 数
单 query 成本 = (索引成本 / 索引有效周期内的 query 数) + 单次查询成本
ROI > 3 才值得上
```

举例：1 万文档全量索引 $100，假设 6 个月内承担 5K 次查询：
- 分摊索引成本 = $100 / 5000 = $0.02/query
- Local Search 单查询 = $0.01
- 总成本 = $0.03/query
- 单查询价值至少要 $0.10 才能 ROI > 3

### 真实项目成本案例（扩展）

| 规模 | 文档量 | 实体数 | 关系数 | 社区数 | 索引全量成本 | 单查询（Global） | 月运营成本（1K query/天） |
|---|---|---|---|---|---|---|---|
| 万级 | 1 万段 | 5K-1.5 万 | 2-5 万 | 100-300 | $80-200 | $0.03-0.08 | $30-60 |
| 十万级 | 10 万段 | 3-8 万 | 20-80 万 | 500-2K | $800-2500 | $0.05-0.15 | $300-800 |
| 百万级 | 100 万段 | 30-100 万 | 200 万-2000 万 | 5K-2 万 | $8K-30K | $0.10-0.30 | $3K-10K |

**关键拐点**：

- **万级到十万级**：索引成本不是线性增长，而是 **8-15 倍**——关系数和社区数随文档量超线性膨胀
- **十万到百万**：成本 10-15x，但单查询成本变化小（瓶颈变成图遍历 + LLM 限流）
- **百万级以上**：必须换 LightRAG / NebulaGraph 等增量友好方案，否则每晚索引重建成为不可能任务

**反模式**：

| 反模式 | 后果 |
|---|---|
| 万级文档跑 4 层 Leiden | 摘要成本 ×1.5，问答质量几乎不变 |
| 全量重建当日常运营 | 每月 $2K-10K 烧光预算 |
| Global Search 不做粗排 | 月成本 ×5-10 |
| 百万级用 Microsoft GraphRAG 全量 | 单次重建 1-3 天，根本跑不动 |
| 用 GPT-4 做摘要（应该用 gpt-4o-mini） | 摘要成本 ×8-15 |
| 检索响应超时直接重试 | 用户看到的延迟 ×2 + token ×2 |

---

## 十、GraphRAG 评测

| 指标 | 度量对象 | 计算方式 |
|---|---|---|
| 实体召回率 | 实体识别质量 | ground truth 实体被识别出的比例 |
| 关系召回率 | 关系抽取质量 | ground truth 关系被抽取出的比例 |
| 多跳准确率 | 多跳推理 | 推理链是否正确连接实体 |
| 全局主题召回率 | 社区摘要质量 | ground truth 主题是否在 top-K 社区摘要中 |
| 答案忠实度 | LLM 生成 | 答案是否被图证据支撑 |

评测集要覆盖跳数：1 跳 / 2 跳 / 3 跳分别有 query。每种关系类型至少 10 条 query。

---

## 十一、反模式

### 阶段判断

- 默认上 GraphRAG，普通 RAG 完全够用的场景硬上
- 知识 < 500 段硬上，图构建成本远高于收益
- 强实时性场景上 GraphRAG，延迟 2-5s 不适合实时对话

### 抽取与图构建

- 不定义 schema 直接抽，LLM 自由抽取产生大量无意义实体
- 不合并别名，同实体多节点，图检索时召回分散
- 不设置信度阈值，低质量实体污染图
- 按句子抽取，粒度过细，三元组爆炸
- 关系不限定类型，三元组爆炸
- 不保留证据，无法回溯审计
- 全量重建当增量用

### 社区与摘要

- 只跑一次 Louvain，单层社区粒度单一
- 不调分辨率，默认参数可能产生过大或过小的社区
- 忽略社区重叠，实体唯一社区假设丢失信息
- 摘要过于抽象，失去具体实体
- 摘要无引用，用户问"为什么"时无法回查
- 单层摘要，只有一种粒度

### 多跳检索

- 跳数不限，4+ 跳召回噪声爆炸
- 不剪枝，遍历所有路径组合爆炸
- 不与普通 RAG 协同，所有问题都走 GraphRAG
- Local Search 不做实体识别兜底，query 里没识别出实体就直接返回空
- Global Search 跑全量社区再截断，不先做 embedding 粗排，token 爆炸
- DRIFT Search 默认开启，所有问题都走 Local + Global，延迟飙到 10s+
- 意图分类器出错时硬派 Local Search 而不退回 Basic Search
- 社区报告没向量化就直接全量喂给 LLM，prompt 撑爆

### prompt_tune 与 API 化

- 跳过 prompt_tune 直接用默认 prompt，跨领域时实体抽取质量差
- CLI 跑完后没有 API 封装，业务系统只能手动拼命令
- index / query 两个 Pipeline 没分开部署，更新图谱时检索服务被一起重启
- 增量更新时全量重跑整个 index pipeline，不做"新增 chunk 局部重抽"
- prompt_tune 跑完的领域 prompt 没固化下来，每次重启都重新发现一遍

### 多源与多模态

- CSV 默认按 token 切分，把一行切成多段，每段都重复抽取实体
- PDF 不做版面分析直接喂 GraphRAG，表格被切碎成无意义文本
- 关系库数据硬转 CSV 再走 GraphRAG，丢失外键 / 索引 / 视图结构
- MinerU OCR 抽完文本后丢弃了图片节点，跨模态检索能力丢失
- 多模态文档建图时图片 / 表格没建独立节点，只挂在 TextUnit 下

### 评测

- 不用多跳评测集，只测单跳等于在测普通 RAG
- 图谱更新不重跑评测，图谱质量下降无人发现
- Global Search 的社区报告只测 top-1 命中，不测 top-K 召回
- Local Search 的评测集不覆盖"实体稀疏"场景，召回率虚高

---

## 十二、prompt_tune 与 API 化

CLI 能跑通不意味着能上生产。本节聚焦三个真实工程问题：怎么让 prompt 适配当前领域（`prompt_tune`）、怎么把 CLI 变成业务可调用的 API（`Pipeline API`）、怎么应对知识图谱的持续更新（增量更新）。

### prompt_tune：让 prompt 适配当前领域

默认 prompt 是面向"通用新闻 / 百科"语料设计的。换到医疗、法律、金融、企业内部知识时，实体类型、关系类型、领域术语都不一样，靠默认 prompt 抽出来的东西质量会塌。微软 GraphRAG 提供 `prompt_tune` 流程自动适配，11 步：

1. 加载 `settings.yaml` 配置
2. 找到 `input` 目录下的文档
3. 切成 text_unit（用 `--chunk_size` 控制）
4. 拼接每篇文档的原始文本（用于后续检测 domain / language）
5. 用 `--k` + `--selection-method`（`top` / `random` / `auto`）选代表性 text_unit
6. 用 `--domain` 指定领域（或自动检测）
7. 用 `--language` 指定语言（或自动检测）
8. 拼出系统提示
9. 可选 `--discover_entity_types`，让 LLM 推断当前领域的实体类型
10. 生成 Few-shot 示例
11. 输出到 `--output_path`（默认 `prompts/` 目录），覆盖默认 prompt

**关键经验**：

- `prompt_tune` 是**一次性成本**，跑完一次把生成的 prompt 提交进版本库，不要每次重启都重跑
- `--discover_entity_types` 开一次就够了，结果固化后用 `--entity_types` 直接喂
- `prompt_tune` 的 token 消耗在 5-15K，对小项目不构成问题
- 领域跨度过大（医疗 + 法律混合语料）时 prompt_tune 会冲突，建议按领域分开建索引

### Pipeline API：CLI → 业务集成

微软 GraphRAG 在 `graphrag/api/` 下暴露了 3 个 Pipeline：

| Pipeline | 入口 | 用途 |
|---|---|---|
| `prompt_tune` | `api/prompt_tune.py` | 一次性生成领域 prompt |
| `index` | `api/index.py` | 索引构建入口 |
| `query` | `api/query.py` | 检索入口（4 种模式都封装在这里） |

生产环境的标准做法是用 FastAPI 起一个 RESTful 服务：

```
POST /prompt_tune   - 启动 prompt 适配（异步任务）
POST /index         - 触发索引构建（异步任务，含增量模式）
POST /query/local   - Local Search
POST /query/global  - Global Search
POST /query/drift   - DRIFT Search
POST /query/basic   - Basic Search
GET  /job/{id}      - 查询异步任务状态
GET  /graph/stats   - 图谱健康检查（节点数 / 边数 / 社区数 / 孤立节点比例）
```

**为什么 index 和 query 必须分服务**：

- index 是重计算（小时级），跑在独立的 worker 池里
- query 是低延迟（秒级），跑在与业务同网络的常驻进程
- 两者共享同一份 parquet / Neo4j 存储，但不共享进程。index 期间 query 可以继续读旧图谱（哪怕是 stale 的）

### 增量更新：知识图谱不是一次性的

文档每天都在变，全量重跑 index 的成本不可接受。三种增量策略：

**1. 全量重建兜底**

每月 / 每季度一次全量重建。期间所有变更走日志记录。简单但延迟高。

**2. 增量 chunk 抽取（推荐）**

只对新加的 chunk 跑实体 / 关系抽取，merge 进旧图谱。增量流程：

1. 找出新增 / 修改的 chunk（按文档 hash）
2. 对新 chunk 跑 entity / relationship 抽取
3. 把新实体 / 关系 merge 进 Neo4j（用 MERGE + 同名去重）
4. 不重跑 Leiden、不重跑社区摘要
5. 每周 / 每月重跑一次社区检测 + 摘要

**3. Local 增量 + Global 全量**

Local Search 用增量图谱（代价小），Global Search 用周期性重建的社区摘要（代价大但更新要求不高）。这是**性价比最高的组合**。

增量更新的最大坑：实体改名 / 合并 / 拆分怎么处理？建议维护一个"实体变更日志"表，每次重建前先 apply 日志再 merge。

### 深度扩展

上一节给出的"十二"是骨架——11 步流程、3 个 Pipeline、3 种增量策略。本节拆到工程实现层：每一步在跑什么、生成的 prompt 长什么样、API 怎么异步化、增量怎么 merge。

### 1. prompt_tune 的工程细节

#### 11 步的输入输出与依赖关系

| 步骤 | 输入 | 输出 | 依赖前序 | 串/并行 |
|---|---|---|---|---|
| 1. 加载 settings.yaml | `settings.yaml` | config 对象 | 无 | 串行起点 |
| 2. 扫描 input 目录 | `input_dir` | 文档列表 | 1 | 串行 |
| 3. 切成 text_unit | 文档列表 | text_unit 列表（chunk_size/overlap） | 2 | 串行 |
| 4. 拼接文档全文 | text_unit → 文档级全文 | per-doc 字符串 | 3 | 串行 |
| 5. 选代表性 text_unit | text_unit 列表 + `--k` + `--selection-method` | K 个代表 unit | 3 | **可并行**（多进程切 embedding） |
| 6. 检测 domain | 代表 unit | domain 字符串 | 5 | 串行 |
| 7. 检测 language | 代表 unit | language 字符串 | 5 | **可与 6 并行** |
| 8. 拼系统提示 | domain + language + config | system_prompt 草稿 | 6, 7 | 串行 |
| 9. discover_entity_types | system_prompt + 代表 unit | entity_types 列表 | 8 | 串行 |
| 10. 生成 Few-shot | entity_types + 代表 unit | 5-10 条示例 | 9 | 串行 |
| 11. 输出到 prompts/ | 全部产物 | 6 个 .txt 文件覆盖默认 | 8, 9, 10 | 写盘收尾 |

可并行的只有步骤 5（embedding 计算）、步骤 6/7（两个独立 LLM 调用）。其余步骤严格串行，因为后续步骤依赖前序产物。

#### 跑出来的 prompt 长什么样

`prompt_tune` 输出 6 个文件覆盖 `prompts/` 目录下的默认模板。**实体抽取 prompt** 是核心，生成形态类似：

```
-Goal-
Given a text document that is potentially relevant to this activity, first identify
all entities that are explicitly mentioned. For each entity, describe its attributes
relevant to the activity.

-Domain specific guidance-
{自动检测的 domain 描述，例如 "医疗领域，侧重药物、疾病、临床试验"}

-Entity Types-
{discover_entity_types 推断的类型清单，例如 [Drug, Disease, ClinicalTrial,
Patient, Hospital, Symptom, Treatment]}

-Examples-
Example 1:
Text: "患者男 62 岁，因 2 型糖尿病合并高血压入院，给予二甲双胍 500mg bid ..."
Entities:
- id: 1, name: "2 型糖尿病", type: Disease, description: "慢性代谢性疾病"
- id: 2, name: "高血压", type: Disease, description: "心血管慢性病"
- id: 3, name: "二甲双胍", type: Drug, description: "一线降糖药"
Relationships:
- source: 1, target: 3, type: treats, description: "二甲双胍治疗2型糖尿病"

Example 2:
...
```

要点：

- `-Entity Types-` 段由步骤 9 的 `discover_entity_types` 填入，不是写死的
- `-Examples-` 段由步骤 10 自动生成，质量参差——跑完要人工挑 3-5 条覆盖典型场景
- `-Domain specific guidance-` 通常是 1-2 句话，描述当前语料的整体领域

#### 调优参数取舍

| 参数 | 默认 | 经验范围 | 取舍逻辑 |
|---|---|---|---|
| `--k` | 15 | 10-30 | K 太小代表样本不足，Few-shot 跑偏；太大 token 翻倍、质量不再涨 |
| `--selection-method` | `auto` | `auto` / `top` / `random` | `auto` 用 embedding 中心度选最代表样本；`top` 按出现频次；`random` 随机。生产推荐 `auto` |
| `--n-subset-max` | 100 | 50-300 | 控制 discover_entity_types 输入规模。太大 LLM 推理时间翻倍，太小类型推断不全 |
| `--min-examples-required` | 2 | 1-5 | Few-shot 最少示例数。低于这个值步骤 10 会跳过；高于这个值步骤 10 会主动补足 |
| `--max-gleanings` | 0 | 0-1 | 跑示例生成时的多轮抽取，1 能补回 10-20% 边角 |
| `--discover_entity_types` | false | true | 第一次跑必须开，之后关掉固化清单 |

#### 版本管理

`prompt_tune` 是**一次性成本**（token 消耗 5-15K），跑完必须固化：

```
prompts/
├── entity_extraction.txt      # 步骤 11 产物
├── summarize_descriptions.txt
├── community_report.txt
├── extract_graph.txt
├── claim_extraction.txt
└── prune.txt
```

提交策略：

1. 跑完 prompt_tune → 提交 git，commit message 写清语料变更（如 `prompt_tune: 切换医疗语料 v2`）
2. `settings.yaml` 里 `entity_types` 字段写死发现的清单，不再依赖 `discover_entity_types`
3. 跨语料版本用 git tag 区分（`prompts-v1-medical`、`prompts-v2-legal`），避免不同领域 prompt 互相污染

反模式：每次服务启动重跑 prompt_tune（白耗 token）；`discover_entity_types` 一直开着（每次 LLM 调用多一次推理）；把生成的 prompt 当临时文件不提交（重启就丢）。

#### 失败模式

| 失败现象 | 根因 | 应对 |
|---|---|---|
| `auto` 选出的代表样本聚类失败 | 语料规模 < 100 段 | 降级到 `random`，或手动指定 `--k=10` |
| `discover_entity_types` 给出过细类型（如 20+ 种） | `n-subset_max` 太大或 LLM 过度拆分 | 限制 `--n-subset-max=50`，或在产物上人工合并到 8-12 种 |
| Few-shot 示例质量差（实体 / 关系类型混乱） | `discover_entity_types` 跑偏 | 人工改 `entity_extraction.txt` 里的 `-Examples-` 段，提交进 git |
| 跨领域语料 prompt 冲突 | 医疗 + 法律混合在一个 `input_dir` | 按领域分开建索引，每领域跑独立 prompt_tune |
| LLM 拒答（safety filter） | 语料里包含敏感词（疾病名 / 法律条款） | 换 LLM provider，或预处理脱敏 |
| Token 超限 | `--k` + chunk_size 同时过大 | 降 `--k` 到 10，或降 chunk_size 到 200 |

### 2. Pipeline API 深度

#### 三个 Pipeline 的 Python 入口

```python
# prompt_tune
from graphrag.api.prompt_tune import generate_indexing_prompts
prompts = await generate_indexing_prompts(
    config=config,
    root=root_dir,
    chunk_size=300,
    overlap=100,
    k=15,
    selection_method="auto",
    domain=None,           # None 表示自动检测
    language=None,         # None 表示自动检测
    discover_entity_types=True,
    output_path="prompts/",
)

# index
from graphrag.api.index import build_index
output = await build_index(
    config=config,
    root=root_dir,
    is_update_run=False,   # 增量模式时为 True
)

# query
from graphrag.api.query import local_search, global_search, drift_search, basic_search

# Local Search
result = await local_search(
    config=config,
    query="A 公司的 CEO 和 B 公司的 CTO 是什么关系？",
)

# Global Search
result = await global_search(
    config=config,
    query="这批文档讲的核心主题是什么？",
    community_level=2,     # 从哪一层社区开始
)

# DRIFT Search
result = await drift_search(config=config, query="...")
result = await basic_search(config=config, query="...")
```

注意 `query` Pipeline 暴露的是 4 个独立函数（`local_search` / `global_search` / `drift_search` / `basic_search`），不是 1 个带 mode 参数的统一入口。**工程上要包一层**：

```python
class QueryRouter:
    def __init__(self, config):
        self.config = config
        self.intent_classifier = IntentClassifier()

    async def route(self, query: str) -> dict:
        mode = self.intent_classifier.predict(query)
        if mode == "local":
            return await local_search(self.config, query)
        elif mode == "global":
            return await global_search(self.config, query)
        elif mode == "drift":
            return await drift_search(self.config, query)
        else:
            return await basic_search(self.config, query)  # 兜底
```

意图分类器成本极低（关键词 + 几条规则就够），延迟 < 10ms。分类失败时退到 `basic_search` 而不是报错——这是兜底原则。

#### index Pipeline 的 5 个阶段控制

`index` Pipeline 内部跑 5 个阶段：

```
documents → text_units → graph_elements → communities → community_reports
```

每个阶段可独立控制（`settings.yaml` 的 `pipeline.steps` 字段）：

| 阶段 | 跳过条件 | 重跑成本 | 典型耗时 |
|---|---|---|---|
| documents → text_units | 文档没变 | 低 | 分钟级 |
| text_units → graph_elements | text_unit 没变 | **极高**（LLM 抽取 5-20x） | 小时级 |
| graph_elements → communities | 关系没变 | 中（Leiden） | 分钟-小时 |
| communities → community_reports | 社区没变 | 高（LLM 摘要） | 小时级 |

增量更新时，**只跳过不变的阶段**。判断逻辑：

```python
# 伪代码
def should_skip_stage(stage, current_state):
    stage_hash = compute_hash(stage_input)
    return current_state.get(f"{stage}_hash") == stage_hash
```

`settings.yaml` 里的 `pipeline.steps` 字段直接控制是否跳过（生产环境推荐手动指定，不依赖自动检测）：

```yaml
pipeline:
  steps:
    - create_base_text_units       # 文档切分
    - create_base_extracted_entities  # 实体抽取（最贵）
    - create_summarized_entities     # 实体摘要
    - create_base_extracted_relationships  # 关系抽取（最贵）
    - create_summarized_relationships
    - create_base_graph             # 图构建
    - create_final_nodes
    - create_final_relationships
    - create_communities             # 社区检测
    - create_final_communities
    - create_community_reports       # 社区摘要（次贵）
```

#### 异步任务设计

index Pipeline 是小时级任务，必须异步化。三种方案对比：

| 方案 | 复杂度 | 适用规模 | 失败恢复 | 监控 |
|---|---|---|---|---|
| FastAPI BackgroundTasks | 低 | 单文档 / 小图 | 进程挂掉任务丢 | 无 |
| Celery + Redis | 中 | 中大规模 | 任务持久化、断点续传 | Flower |
| RQ + Redis | 中 | 中等 | 任务持久化 | RQ Dashboard |
| asyncio Task | 低 | 单任务 | 进程挂掉任务丢 | 无 |

推荐：**生产用 Celery，本地用 asyncio**。

```python
# FastAPI + Celery
from celery import Celery
celery_app = Celery("graphrag", broker="redis://localhost:6379/0")

@celery_app.task(bind=True, max_retries=3)
def run_index_pipeline(self, job_id: str, config_path: str):
    try:
        config = load_config(config_path)
        output = await build_index(config=config, root=root_dir)
        save_artifact(job_id, output)
    except Exception as exc:
        raise self.retry(exc=exc, countdown=60)

# API 端
@app.post("/index")
async def trigger_index(background: BackgroundTasks):
    job_id = uuid.uuid4().hex
    run_index_pipeline.delay(job_id, "settings.yaml")
    return {"job_id": job_id, "status": "queued"}

@app.get("/job/{job_id}")
async def get_job_status(job_id: str):
    return redis_client.hgetall(f"job:{job_id}")
```

#### 限流与并发

GraphRAG 的瓶颈是 LLM 调用，并发必须和 provider 限流对齐：

| 调用类型 | 默认并发 | 经验值 | 限流来源 |
|---|---|---|---|
| LLM 抽取（实体 / 关系 / 摘要） | 25 | 10-50 | provider RPM（OpenAI Tier 1 大约 500 RPM） |
| Embedding 调用 | 25 | 50-100 | provider RPM（通常比 LLM 高 5-10x） |
| 图遍历（Neo4j 查询） | 不限 | 50-200 | Neo4j 连接池大小 |
| 向量检索 | 10 | 10-30 | 向量库 QPS |

`settings.yaml` 里的 `concurrent_requests` 控制全局并发。生产环境按 provider RPM 反推：

```
max_concurrent = RPM / 60 / avg_latency_seconds
```

举例：OpenAI Tier 1（500 RPM），单次 LLM 调用平均 2s，`max_concurrent = 500/60/2 = 4`。看起来很低，但实际 4 并发配合 retry 就能跑满 RPM。

#### 监控埋点

每个阶段必须埋点：

```python
import time
import logging

metrics_logger = logging.getLogger("graphrag.metrics")

async def run_stage(name: str, stage_fn, *args):
    start = time.time()
    start_tokens = get_token_counter()
    try:
        result = await stage_fn(*args)
        duration = time.time() - start
        tokens = get_token_counter() - start_tokens
        metrics_logger.info({
            "stage": name,
            "duration_seconds": duration,
            "tokens_used": tokens,
            "status": "success",
        })
        return result
    except Exception as e:
        metrics_logger.error({
            "stage": name,
            "status": "failed",
            "error": str(e),
        })
        raise
```

关键指标：

| 指标 | 用途 |
|---|---|
| 每个阶段耗时 | 识别瓶颈阶段（通常是 entity_extract 和 community_report） |
| token 消耗 | 按阶段、按文档、按 query 统计，定位成本来源 |
| 成功率 | 区分 LLM 失败 vs 代码异常 |
| 实体 / 关系数 | 监控抽取质量（突然下降 = prompt 被改坏了） |
| 社区大小分布 | Leiden 异常时立即发现 |
| 查询 P50 / P95 / P99 延迟 | 用户体验 |
| LLM 调用重试率 | provider 限流信号 |

生产环境把 metrics 推到 Prometheus + Grafana，至少要把"token 消耗 / 阶段耗时 / 成功率"三个面板做出来。

### 3. 增量更新深度

#### 三种策略对比

| 策略 | 增量粒度 | 社区摘要 | 实现复杂度 | 适用场景 |
|---|---|---|---|---|
| 全量重建 | 全量 | 重跑 | 低 | 每月 / 每季度兜底 |
| 增量 chunk | 单 chunk 级别 | 不重跑（周期重跑） | 中 | 文档每日新增 ≤ 10% |
| Local 增量 + Global 全量 | 单 chunk + 周期重建 | 周期重跑 | 中高 | **推荐生产组合** |

#### 增量 chunk 的具体流程

```
新文档到达
  ↓
1. 计算文档 hash（SHA-256）
  ↓
2. 与 Neo4j 现有 documents 比对，找出新增 / 修改的 chunk
  ↓
3. 对新 chunk 跑 entity_extract + relationship_extract
  ↓
4. 把新实体 MERGE 进 Neo4j（同名去重）
  ↓
5. 把新关系 MERGE 进 Neo4j（同 source+target+type 去重）
  ↓
6. 更新实体的 text_unit_ids、frequency 字段
  ↓
7. 写"实体变更日志"表
  ↓
8. 触发社区检测 + 摘要（异步，每周一次）
```

实体变更日志（`entity_changelog.parquet`）：

| 字段 | 含义 |
|---|---|
| `timestamp` | 变更时间 |
| `change_type` | add / merge / rename / delete |
| `entity_id` | 涉及实体 |
| `old_value` | 变更前（rename / merge 时填） |
| `new_value` | 变更后 |
| `chunk_id` | 触发变更的 chunk |

日志的价值：全量重建前先 apply 日志，避免重建时丢失"实体 A 改名为实体 B"这类语义变化。

#### Local 增量 + Global 全量的工程实现

```python
# Local Search 用增量图谱
class IncrementalGraphService:
    def __init__(self, neo4j_uri, full_graph_uri):
        self.incremental = Neo4jClient(neo4j_uri)       # 增量图谱（高频写入）
        self.full = Neo4jClient(full_graph_uri)         # 全量图谱（周期性重建）

    async def local_search(self, query):
        # 合并查询：增量 + 全量
        incremental_results = await self.incremental.search(query)
        full_results = await self.full.search(query)
        return merge_results(incremental_results, full_results)

# Global Search 用全量图谱
class GlobalSearchService:
    def __init__(self, full_graph_uri):
        self.full = Neo4jClient(full_graph_uri)

    async def global_search(self, query):
        # 只用全量图谱 + 周期重建的社区摘要
        return await self.full.global_search(query)

# 周期任务：每周重建 Global Search 用图谱
@celery_app.task
def rebuild_full_graph():
    config = load_config("settings.yaml")
    output = await build_index(config=config, root=root_dir)
    swap_full_graph_atomically()  # 原子切换
```

**为什么这是性价比最高的组合**：

- Local Search 对社区摘要不敏感（答案围绕具体实体），用增量图谱足够
- Global Search 依赖社区摘要的质量，社区变了的旧摘要会误导——必须周期性重跑
- 周期重建的频率取决于业务对"全局主题答案"的新鲜度要求（一般 1-7 天）

#### 增量更新的评测

每次增量更新后必须跑回归评测：

| 评测项 | 方法 | 通过标准 |
|---|---|---|
| 实体召回率不退化 | 跑固定的 100 条 entity query | 召回率 ≥ 上一次 |
| 关系召回率不退化 | 跑固定的 100 条 relationship query | 召回率 ≥ 上一次 |
| 多跳准确率不退化 | 跑固定的 50 条 multi-hop query | 准确率 ≥ 上一次 |
| 社区摘要完整性 | 检查摘要覆盖率（所有社区都有摘要） | 100% |
| 图谱健康指标 | 孤立节点率 < 5%，平均度数稳定 | 不恶化 |

评测集必须固化进 git，每次增量更新自动跑、对比上一次结果、diff > 阈值就报警。

#### 增量更新的失败模式

| 失败现象 | 根因 | 应对 |
|---|---|---|
| 实体引用断裂（旧的 chunk 改了导致实体 text_unit_ids 过期） | merge 时只 append 不 prune | merge 时重算 text_unit_ids |
| 社区摘要陈旧（增量更新后没重跑摘要） | Global Search 用了过期的 community_reports | 强制每周重建摘要 |
| 向量索引过期（text_unit 的 embedding 没更新） | 向量库和 Neo4j 写入不同步 | 写入 Neo4j 后立即触发 embedding 重算 |
| 实体重复（同名不同 ID） | MERGE 时大小写 / 别名没规范化 | 抽取前先 normalize 实体名 |
| 关系权重失真（增量后边的 weight 没重算） | weight 是历史累加，增量时只加不减 | 重跑 weight 计算，或用时间衰减 |
| 社区归属错误（新实体没归到任何社区） | Leiden 没跑、增量实体游离在图外 | 每周一次 Leiden 兜底 |
| Query 找不到增量后的实体 | Local Search 的 embedding 没更新 | 实体描述变更时重算 embedding |
| 增量任务阻塞在线程里 | LLM 调用太慢把 asyncio 撑爆 | 强制 Celery 异步 + token 限流 |

**核心原则**：增量更新不是"只追加"，而是"追加 + 周期重建"。每周 / 每月跑一次全量重建兜底，是兜底不是常态。增量代码写错了用户不会立刻发现，几个月后图谱质量会静默退化——评测集和定期重建都是兜底的兜底。

---

## 十三、多源与多模态数据接入

微软 GraphRAG 默认只支持 `.txt` / `.csv`，2.0.1 后加了 `.json`。真实业务里要处理的关系数据库、PDF、Word、PPT、纯图片怎么办？本节按数据形态给出工程方案。

### 关系数据库

两条路径，**不要硬转 CSV**：

**路径 A：转 JSON 走 GraphRAG（适合表少 + 关系简单）**

把每张表转成 JSON 行（每行一个对象），字段名作为 key。优势是结构化元数据能注入 prompt（"这一行来自 customers 表，country 字段是 Italy"），实体抽取质量比 CSV 高。

**路径 B：直接写 Cypher（适合表多 + 关系复杂）**

实体类型 = 表名，关系 = 外键。直接 MERGE 进 Neo4j。优势是跳过 LLM 抽取这一步，成本低、延迟低、关系无歧义；代价是放弃了 LLM 从非结构化字段里发现隐性关系的能力。

**判断口诀**：5 张表以下走 A，多于 5 张走 B；表里有没有"备注 / 描述 / 备注"这种自由文本字段，有就走 A。

### CSV：默认切分的坑与按行动态切分

**默认切分的问题**：微软 GraphRAG 默认按 token 切 CSV，**把同一行切成多段**，每段重复抽取同一行的实体。后果是实体数虚高 3-5x、关系三元组爆炸。

**正确的按行切分**：

1. 整行作为一个 chunk（不管多长）
2. 把列名 + 列值拼成结构化文本：`"表 customers: CustomerID=ALFKI, CompanyName=Alfreds, Country=Germany"`
3. 注入 prompt："以下是一行结构化数据，请识别其中的实体和关系"
4. 行与行之间保留 `row_id` 用于回查

**Northwind 这种多表数据**：先按表分组（customers / orders / products 各一组），再按行切分；组间关系（customer → order）通过外键在 prompt 里显式提示"CustomerID 相同的行是同一个 customer"。

### PDF 多模态：MinerU 工具栈

PDF 不是纯文本——里面混着文字、图片、表格、公式、页眉页脚。直接喂 GraphRAG 等于把表格切成字符、公式被当成乱码。

**MinerU 是当前工程上最稳的方案**：

- 1.x 版本开源，支持 PDF / Word / PPT / 图片
- 输出结构化 JSON + Markdown + 图片
- 内置版面分析（Layout）、公式识别（Formula）、表格识别（Table）、OCR（PP-OCR）
- Linux 部署为主，Windows 走 Docker

**接入 GraphRAG 的两步**：

1. **写自定义 Document Loader**：把 MinerU 的输出转成 GraphRAG 的 Document 对象。文本段 → TextUnit，图片 → 独立节点（`type=image`），表格 → 独立节点（`type=table`），并保留页码 / 坐标用于回溯
2. **写自定义 Splitter**：文本段走 `chunk_size=300` 默认切分；表格 / 图片**不切分**，作为独立 chunk 注入 prompt

**多模态的图谱价值**：图里多出"图片节点"和"表格节点"，跨模态检索成为可能（"包含产品架构图的章节" → 图查询带图片节点的 TextUnit）。代价是单页处理 1-3s，整体索引时间是纯文本的 2-5x。

### 深度扩展

骨架里给出了三条主线：关系库两条路径、CSV 按行切分、PDF 走 MinerU。本节把每条主线拆到工程实现层：字段类型怎么映射、伪代码长什么样、坑在哪里。

### 1. 关系数据库深度

#### 1.1 字段类型 → 图元素的映射规则

关系库导入 GraphRAG 前，先做一次"字段类型 → 图元素"的映射规划，这是后续所有设计的前置：

| 数据库字段类型 | 图元素 | 处理方式 |
|---|---|---|
| 主键（PK） | 节点 ID | 用作 MERGE 的 key |
| 外键（FK） | 关系 | 边类型 = `REFERENCES` / `BELONGS_TO` |
| 普通字段 | 节点属性 | 写入节点 |
| 枚举字段 | 实体类型 / 节点标签 | `Country` 字段的 Italy/Germany/France → 实体 `Country` |
| 时间戳 | 边属性 | 边加上 `created_at` / `updated_at` |
| 备注 / 描述 / 备注（自由文本） | 文本节点 | 单独建一个 `TextNote` 节点挂回主实体 |
| 多对多中间表 | 关系 + 关系属性 | 边类型 = 中间表名，属性 = 中间表字段 |
| NULL | 跳过 / 默认值 | 不能塞空字符串当属性 |

外键是最容易踩坑的——很多人把外键当字符串处理（"CustomerID=ALFKI"塞进描述），结果图里没有真正的 `CUSTOMER_HAS_ORDER` 关系，多跳查询全废。外键必须建模为**边**。

#### 1.2 路径 A：转 JSON 走 GraphRAG

适用场景：表少（≤ 5 张）、有自由文本字段（`Description` / `Notes` / `Comment`）、希望 LLM 从文本里发现隐性关系。

**Python 伪代码**：

```python
import psycopg2
import json
from pathlib import Path

# 1. 连接数据库
conn = psycopg2.connect("postgresql://user:pwd@host:5432/northwind")
cur = conn.cursor()

# 2. 按表导出 JSONL
tables = ["customers", "orders", "order_details", "products", "categories"]
output_dir = Path("./graphrag_input")
output_dir.mkdir(exist_ok=True)

for table in tables:
    cur.execute(f"SELECT * FROM {table}")
    columns = [desc[0] for desc in cur.description]
    
    with open(output_dir / f"{table}.jsonl", "w", encoding="utf-8") as f:
        for row in cur.fetchall():
            record = dict(zip(columns, [str(v) if v is not None else "" for v in row]))
            # 注入结构化元数据到 prompt
            record["__table__"] = table
            record["__row_id__"] = f"{table}:{record.get('id', record.get(f'{table[:-1]}_id', ''))}"
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

cur.close()
conn.close()
```

JSONL 的关键不是结构本身，而是**把 `__table__` 和 `__row_id__` 注入每一条记录**——LLM 看到 `"__table__": "customers"` 时，实体抽取时知道这是 customer 实体，看到 `"__row_id__": "customers:ALFKI"` 时能在 evidence 里回查。

**Northwind 5 表的完整处理流程**：

| 表 | 关键字段 | 抽取策略 |
|---|---|---|
| `customers` | CustomerID, CompanyName, Country, ContactName | Country 抽成独立实体（Country 节点） |
| `orders` | OrderID, CustomerID, OrderDate, ShipCountry | CustomerID 作为外键建模为关系 |
| `order_details` | OrderID, ProductID, UnitPrice, Quantity | 多对多中间表，作为边 + 属性 |
| `products` | ProductID, ProductName, CategoryID, UnitPrice | CategoryID 作为外键建模为关系 |
| `categories` | CategoryID, CategoryName, Description | Description 是自由文本，走 LLM 抽取隐性关系 |

最后产出的节点类型：`Customer` / `Order` / `Product` / `Category` / `Country` / `Employee`（如果 orders 表里有 EmployeeID）。边类型：`PLACED` / `CONTAINS` / `BELONGS_TO` / `SHIPPED_TO` / `SOLD_BY`。

LLM 抽完后再用脚本把外键关系的 weight 调高（这些是 ground truth 关系，置信度 1.0），LLM 抽出来的关系 weight 默认 0.5-0.8——优先级要区分开。

#### 1.3 路径 B：直接写 Cypher

适用场景：表多（> 5 张）、关系结构清晰、追求低延迟和确定性、不需要 LLM 从文本里"发现"关系。

**核心 Cypher 模板**：

```cypher
// 1. 创建约束（性能 + 去重）
CREATE CONSTRAINT customer_id IF NOT EXISTS FOR (c:Customer) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT product_id IF NOT EXISTS FOR (p:Product) REQUIRE p.id IS UNIQUE;

// 2. 批量导入 Customer（UNWIND + MERGE）
UNWIND $customers AS row
MERGE (c:Customer {id: row.CustomerID})
  ON CREATE SET c.companyName = row.CompanyName,
                c.country = row.Country,
                c.createdAt = datetime()
  ON MATCH SET c.companyName = row.CompanyName,
               c.country = row.Country,
               c.updatedAt = datetime();

// 3. 批量导入 Order + 关系
UNWIND $orders AS row
MERGE (o:Order {id: row.OrderID})
  ON CREATE SET o.orderDate = row.OrderDate,
                o.shipCountry = row.ShipCountry
WITH o, row
MATCH (c:Customer {id: row.CustomerID})
MERGE (c)-[r:PLACED]->(o)
  ON CREATE SET r.orderDate = o.orderDate,
                r.weight = 1.0;
```

**批量导入的工程要点**：

- `UNWIND` 一次传 1000-5000 条，事务里跑；超过 1 万要分批
- 导入前**关索引**（`CALL db.index.fulltext.dropAll()` 或用 `USING PERIODIC COMMIT`），导入完再重建，速度差 10x
- `MERGE` 比 `CREATE` 慢但能去重，导入用 `MERGE`
- 边属性里加 `weight` 和 `source`（数据来源 + 抽取时间），方便后续审计
- 导入完成后跑 `CALL db.stats.retrieve('GRAPH COUNTS')` 检查节点 / 边数量

**Neo4j 索引的配套创建**：

```cypher
// 全文索引（用于实体名模糊匹配）
CREATE FULLTEXT INDEX entityNames IF NOT EXISTS FOR (n:Customer|Product|Category) ON EACH [n.companyName, n.productName, n.categoryName];

// 关系索引（用于多跳查询的性能）
CREATE INDEX rel_weight IF NOT EXISTS FOR ()-[r:PLACED]-() ON (r.weight);
```

#### 1.4 两条路径的决策树

```
表数 ≤ 5 + 有自由文本字段？
  ├─ 是 → 路径 A（转 JSON 走 LLM 抽取）
  │       └─ 优势：LLM 能从 Description / Notes 里挖隐性关系
  │       └─ 代价：成本高（5-20x）、延迟高、关系有噪声
  └─ 否 → 表数 > 5 或纯结构化？
              ├─ 是 → 路径 B（直接 Cypher）
              │       └─ 优势：成本低、关系确定、导入快
              │       └─ 代价：错过文本里的隐性关系
              └─ 否 → 混合
                      ├─ 结构化字段走 B（外键关系）
                      └─ 自由文本字段走 A（Description 单独抽）
```

混合方案最常见：表的外键关系直接 Cypher 写入（ground truth），表的 `Description` / `Notes` 字段单独走 JSON → LLM 抽取，merge 时用 `__row_id__` 对齐。

#### 1.5 关系库反模式

| 反模式 | 后果 |
|---|---|
| 硬转 CSV 再走 GraphRAG | 外键变成字符串、枚举值丢失语义、NULL 变成 "NULL"、表结构信息完全丢失 |
| 外键当字符串塞进 description | 没有 `CUSTOMER_HAS_ORDER` 边，多跳查询返回空 |
| 不处理 NULL | LLM 看到一堆 "None" 污染 prompt；Cypher 写入时空字符串和 NULL 行为不一致 |
| 每次导入都重建图 | 历史数据丢失，文档级回查路径断裂 |
| 关系库字段名直接当实体名 | `c1` / `c2` 这种自增主键没有语义，LLM 无法关联回业务 |
| 导入时不开 batch | 单条 INSERT 千万级数据几天都跑不完 |
| MERGE 用 randomUUID() | 每次重建主键变，等于没去重 |

### 2. CSV 深度

#### 2.1 默认 token 切分的具体问题

微软 GraphRAG 默认按 token 切分文本，CSV 也会被当成纯文本切。具体的问题用例子说明——一个 `customers.csv` 行：

```
ALFKI,Alfreds Futterkiste,Maria Anders,Sales Representative,Obere Str. 57,Berlin,12209,Germany,030-0074321,030-0076545
```

按 `chunk_size=300, overlap=100` 切（CSV 单行通常 100-200 token，所以一行被切 1-2 段）：

| chunk | 内容 | 问题 |
|---|---|---|
| chunk 1 | `ALFKI,Alfreds Futterkiste,Maria Anders,Sales Representative,Obere Str. 57,Berlin,12209,Germany,030-0074321,030-0076545` | 完整一行，实体抽取 OK |
| chunk 2（如果切到） | `030-0076545,ALFKI,Alfreds Futterkiste,...` | 重复 chunk 1 内容 |

更糟的情况：多列 CSV（如 `orders.csv` 有 20+ 列）单行 500+ token，被切成 2-3 段，**每段都被 LLM 当成独立证据**。后果：

- 同一行被抽多次，实体数虚高 3-5x
- 同一行的不同 chunk 抽出不同的实体（chunk 1 抽到 Customer + Country，chunk 2 抽到 Phone），关系断裂
- 跨行的实体关联丢失（chunk 只看到本段，不知道 CustomerID=ALFKI 出现在哪些行）

#### 2.2 按行动态切分的实现

**核心规则**：**整行作为一个 chunk，不切分**。

```python
import csv
from pathlib import Path
from langchain_core.documents import Document

def csv_row_to_documents(csv_path: str, table_name: str) -> list[Document]:
    """按行切分 CSV，每行一个 Document，注入结构化元数据"""
    documents = []
    
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        
        for row_idx, row in enumerate(reader):
            # 1. 构造 row_id（用于回查）
            primary_key = row.get("id") or row.get(f"{table_name[:-1]}_id") or f"row_{row_idx}"
            row_id = f"{table_name}:{primary_key}"
            
            # 2. 拼成结构化文本（列名 + 列值）
            field_text = "\n".join([f"{k}: {v}" for k, v in row.items() if v])
            
            # 3. 构造 page_content
            page_content = f"表 {table_name}，第 {row_idx + 1} 行\n{field_text}"
            
            # 4. 注入元数据
            metadata = {
                "table": table_name,
                "row_id": row_id,
                "row_idx": row_idx,
                "primary_key": str(primary_key),
                "source": csv_path,
            }
            
            documents.append(Document(page_content=page_content, metadata=metadata))
    
    return documents

# 用法
docs = csv_row_to_documents("northwind_customers.csv", "customers")
# 输出：每一行变成一个 Document，page_content 是结构化文本
```

**注入到 LLM prompt 的结构化文本示例**：

```
表 customers，第 1 行
CustomerID: ALFKI
CompanyName: Alfreds Futterkiste
ContactName: Maria Anders
ContactTitle: Sales Representative
Address: Obere Str. 57
City: Berlin
PostalCode: 12209
Country: Germany
Phone: 030-0074321
Fax: 030-0076545
```

LLM 看到这种结构化文本，实体抽取质量比默认 token 切分高 30-50%。

#### 2.3 字段类型提示

在 prompt 里显式标注字段类型，LLM 抽取更准：

```python
# 字段类型提示模板
FIELD_TYPE_HINTS = {
    "CustomerID": "客户唯一标识符（主键），格式为 5 位大写字母",
    "CompanyName": "公司名称",
    "Country": "国家名称（如 Germany / France / Italy），请抽取为 Country 实体",
    "OrderDate": "订单日期（YYYY-MM-DD），请抽取为 Event 节点并关联到 Customer",
    "UnitPrice": "单价（货币），作为属性保留",
    "Quantity": "数量（整数）",
    "Discontinued": "是否停产（1=是，0=否）",
}

def build_csv_prompt(table_name: str, field_hints: dict) -> str:
    """构造注入到 entity_extraction prompt 的字段提示"""
    hint_text = "\n".join([f"- {k}: {v}" for k, v in field_hints.items()])
    
    return f"""以下数据来自 {table_name} 表。

字段说明：
{hint_text}

请按字段语义抽取实体和关系：
- ID 字段作为主键，不抽取为实体
- 名称类字段（CompanyName / ProductName）抽取为实体
- 外键类字段（CustomerID / ProductID）建模为关系
- 日期类字段作为 Event 节点
- 数值类字段作为属性保留
"""
```

#### 2.4 行与行之间的关系表达

按行切分后，行间关系需要显式建模。两种方式：

**方式 1：在 page_content 里拼外键提示**

```python
# 假设 orders.csv 有 CustomerID 字段
# 在 page_content 里加一行："外键关联：CustomerID 指向 customers 表的 CustomerID"
page_content = f"""表 orders，第 {row_idx + 1} 行
外键关联：CustomerID 指向 customers 表的 CustomerID（值 = {row['CustomerID']}）
OrderID: {row['OrderID']}
CustomerID: {row['CustomerID']}
..."""
```

**方式 2：在 prompt 里给"全局外键地图"**

```
本批次数据来自 4 张表，外键关系如下：
- customers.CustomerID ← orders.CustomerID
- orders.OrderID ← order_details.OrderID
- products.ProductID ← order_details.ProductID
- categories.CategoryID ← products.CategoryID

请识别行内的实体和上述外键对应的关系。
```

多表 CSV 的处理流程：

```
1. 检测所有 CSV 文件，按文件名或第一列推断表名
2. 读取每张 CSV 的表头，识别外键列（列名匹配 "<其他表名>ID" 模式）
3. 构造"表间外键地图"
4. 每张表分别按行切分
5. 所有表的 page_content 都注入同一份"表间外键地图"
6. 跑实体抽取时 LLM 知道跨表的外键关系
```

#### 2.5 CSV 评测

CSV 评测要在通用 GraphRAG 评测基础上加几项：

| 指标 | 度量对象 | 计算方式 |
|---|---|---|
| 行覆盖率 | 切分是否漏行 | 抽取出的 row_id 集合 / 实际行数 |
| 列字段识别率 | LLM 是否识别字段语义 | 抽样检查实体类型是否符合字段语义（如 Country 字段抽到 Country 实体） |
| 外键关系准确率 | 跨表外键关系是否正确 | ground truth 的外键对 / 抽取出的外键边 |
| 实体重复率 | 同一行是否被抽多次 | 1 - 唯一实体数 / 总实体数；按行切分应 < 5% |
| 关系密度 | 行间关系是否断裂 | 同一行内的实体数 / 关系数；正常 1:1 到 1:3 |

#### 2.6 CSV 反模式

| 反模式 | 后果 |
|---|---|
| 默认 token 切分 | 同一行被切多段，实体重复、关系断裂 |
| 整张表作为一个 chunk | 几万行一个 chunk，LLM context 超限，只处理开头几百 token |
| 列名直接当列名不做语义提示 | LLM 把 "CustomerID" 当成普通字符串，识别不出主键 |
| 不注入外键地图 | 跨表外键关系丢失，多跳查询失效 |
| 行内 NULL 当成空字符串 | LLM 困惑"为什么这里有空白" |
| 用 Excel 保存 CSV（带 BOM / 特殊分隔符） | Python csv 模块读不到正确列名 |

### 3. PDF 多模态深度

#### 3.1 PDF 解析的难点

PDF 不是纯文本，是绘制指令的集合。直接 `pdftotext` 出来的东西惨不忍睹：

| 难点 | 具体表现 | 后果 |
|---|---|---|
| 图文表公式混排 | 论文 PDF：段落 + 公式 + 图 + 表格交替 | pdftotext 把图跳过、公式乱码、表格顺序错乱 |
| 双栏布局 | 学术论文、期刊 | pdftotext 按行读，栏 1 和栏 2 文字交叉 |
| 跨页表格 | 表格被分页符切断 | 同一张表被切成两半，列名丢了 |
| 扫描件 OCR | 老旧文献、扫描书 | pdftotext 直接返回空 |
| 页眉页脚页码 | 期刊 / 书籍 | 每页重复标题、作者、页码污染文本 |
| 公式 | LaTeX 渲染的数学公式 | 变成乱码字符 |
| 图片说明文字 | "如图 3 所示" | 文字和图的引用关系断裂 |
| 表格内嵌图 | 表格里有 logo / 示意图 | 表格识别跳过图片 |

GraphRAG 直接吃 `pdftotext` 输出等于把上述所有坑踩一遍。**必须做版面分析**。

#### 3.2 MinerU 工具栈

MinerU（[opendatalab/MinerU](https://github.com/opendatalab/MinerU)）是当前工程上最稳的 PDF / Docx / PPT 解析工具。架构是 4 个独立模块串联：

| 模块 | 功能 | 输出 |
|---|---|---|
| Layout | 版面分析，识别页面的文本块 / 图片块 / 表格块 / 公式块 | 区域坐标 + 类别 |
| Formula | 公式识别，把公式图片转 LaTeX | LaTeX 字符串 |
| Table | 表格识别，把表格图片转 HTML / Markdown | 结构化表格 |
| OCR（PP-OCR） | 扫描件文字识别 | 文字 + 坐标 |

部署方式：

- **Linux**：原生部署（conda 环境 + GPU 推荐），pipeline 并行度高
- **Windows**：走 Docker，避免 Python 环境冲突
- **CPU 模式**：能跑但慢，论文级 PDF 单页 5-10s；GPU 模式单页 0.5-2s

调用伪代码：

```python
from mineru import MinerUPipeline

pipeline = MinerUPipeline(
    layout_model="layoutlmv3",      # 版面分析模型
    formula_model="unimernet",      # 公式识别模型
    table_model="tablemaster",      # 表格识别模型
    ocr_model="ppocr_v4",           # OCR 模型
    device="cuda",                  # cuda / cpu
)

# 解析单个 PDF
result = pipeline.parse(
    pdf_path="paper.pdf",
    output_dir="./mineru_output",
    output_formats=["json", "markdown", "images"],  # 三种输出
    start_page=0,
    end_page=None,  # None 表示到末尾
)
```

`output_formats` 三种输出的用途：

| 输出 | 内容 | 用途 |
|---|---|---|
| `json` | 每页的 block 列表（文本 / 图片 / 表格 / 公式 + 坐标） | 程序化处理 |
| `markdown` | 整篇 PDF 的 markdown 文本 | 人工预览 / 走 LLM |
| `images` | 每张图独立保存为 PNG / JPG | 多模态图谱的图片节点 |

#### 3.3 接入 GraphRAG 的完整流程

**步骤 1：自定义 Document Loader**

```python
import json
from pathlib import Path
from langchain_core.documents import Document

class MinerULoader:
    def __init__(self, mineru_output_dir: str):
        self.output_dir = Path(mineru_output_dir)
    
    def load(self, pdf_name: str) -> list[Document]:
        """把 MinerU 输出转成 GraphRAG 的 Document 列表
        
        返回三类 Document：
        - 文本块（可切分）
        - 表格（不可切分）
        - 图片（不可切分）
        """
        documents = []
        json_path = self.output_dir / pdf_name / f"{pdf_name}_content_list.json"
        
        with open(json_path, "r", encoding="utf-8") as f:
            blocks = json.load(f)
        
        for block_idx, block in enumerate(blocks):
            block_type = block.get("type")
            page_num = block.get("page_idx", 0)
            bbox = block.get("bbox", [])  # [x1, y1, x2, y2]
            
            if block_type == "text":
                # 文本块 → 后续走 chunk_size 切分
                documents.append(Document(
                    page_content=block["text"],
                    metadata={
                        "type": "text",
                        "page": page_num,
                        "bbox": bbox,
                        "block_idx": block_idx,
                        "pdf": pdf_name,
                    }
                ))
            
            elif block_type == "table":
                # 表格 → 不可切分，整张表作为一个 Document
                table_html = block.get("html", "")
                documents.append(Document(
                    page_content=f"表格（{block.get('title', '')}）：\n{table_html}",
                    metadata={
                        "type": "table",
                        "page": page_num,
                        "bbox": bbox,
                        "block_idx": block_idx,
                        "pdf": pdf_name,
                        "table_id": f"{pdf_name}:table:{block_idx}",
                    }
                ))
            
            elif block_type == "image":
                # 图片 → 不可切分，page_content 用 caption + 引用上下文
                caption = block.get("caption", "")
                image_path = block.get("image_path", "")
                documents.append(Document(
                    page_content=f"图片（{caption}）：参见 {image_path}",
                    metadata={
                        "type": "image",
                        "page": page_num,
                        "bbox": bbox,
                        "block_idx": block_idx,
                        "pdf": pdf_name,
                        "image_id": f"{pdf_name}:image:{block_idx}",
                        "image_path": image_path,
                    }
                ))
            
            elif block_type == "formula":
                # 公式 → 整段作为 Document
                documents.append(Document(
                    page_content=f"公式：{block.get('latex', '')}",
                    metadata={
                        "type": "formula",
                        "page": page_num,
                        "bbox": bbox,
                        "block_idx": block_idx,
                        "pdf": pdf_name,
                    }
                ))
        
        return documents
```

**步骤 2：自定义 Splitter**

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

class MultimodalSplitter:
    def __init__(self, chunk_size: int = 300, overlap: int = 100):
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=overlap,
        )
    
    def split(self, documents: list[Document]) -> list[Document]:
        """文本块走默认切分，表格 / 图片 / 公式不切分"""
        split_docs = []
        
        for doc in documents:
            if doc.metadata["type"] == "text":
                # 文本块切分
                for sub_doc in self.text_splitter.split_documents([doc]):
                    split_docs.append(sub_doc)
            else:
                # 表格 / 图片 / 公式不切分，原样保留
                split_docs.append(doc)
        
        return split_docs
```

**步骤 3：注入到 GraphRAG 的索引流程**

```python
from graphrag.api.index import build_index

# 1. 自定义 Loader 读取所有 PDF
loader = MinerULoader(mineru_output_dir="./mineru_output")
all_documents = []
for pdf_name in ["paper1", "paper2", "paper3"]:
    all_documents.extend(loader.load(pdf_name))

# 2. 自定义 Splitter 切分
splitter = MultimodalSplitter(chunk_size=300, overlap=100)
chunked_documents = splitter.split(all_documents)

# 3. 写入 GraphRAG 的 input 目录
import shutil
input_dir = Path("./graphrag_input/multimodal")
input_dir.mkdir(parents=True, exist_ok=True)

for doc in chunked_documents:
    # 用 block_idx + page + pdf 构造文件名
    file_name = f"{doc.metadata['pdf']}_p{doc.metadata['page']}_b{doc.metadata['block_idx']}.txt"
    with open(input_dir / file_name, "w", encoding="utf-8") as f:
        # 把元数据写入文件头
        f.write(f"[type={doc.metadata['type']}]\n")
        f.write(f"[page={doc.metadata['page']}]\n")
        f.write(f"[pdf={doc.metadata['pdf']}]\n")
        f.write("\n")
        f.write(doc.page_content)

# 4. 跑 GraphRAG 索引
await build_index(config=config, root="./")
```

#### 3.4 多模态的图谱价值

把图片 / 表格建成独立节点后，图谱多出三类能力：

| 能力 | 传统 RAG | 多模态 GraphRAG |
|---|---|---|
| 跨模态检索 | "产品架构图在哪一章？" 答不出来 | 图查询：`MATCH (t:TextUnit)-[:CONTAINS]->(i:Image) WHERE i.caption CONTAINS '架构图'` |
| 表格结构化查询 | 表格被切碎成文本，"2023 年 Q3 销售额" 找不到 | 表格作为独立节点，TableCaption 走 LLM 转 SQL，再查结构化表格数据 |
| 图片关联问答 | "第三章的流程图说明什么？" 答不出来 | 图遍历：TextUnit → 引用 → Image 节点，喂给多模态 LLM（GPT-4V / Qwen-VL） |

**多模态检索的实际流程**：

```
query: "第三章的产品架构图讲什么？"
  ↓
1. 实体识别：识别"第三章" → Document 节点，"产品架构图" → Image 节点
  ↓
2. 图查询：
   MATCH (d:Document {chapter: "第三章"})-[:CONTAINS]->(t:TextUnit)
         -[:CONTAINS]->(i:Image)
   WHERE i.caption CONTAINS '架构图'
  ↓
3. 拿到 Image 节点 + 关联 TextUnit
  ↓
4. 喂给多模态 LLM（GPT-4V / Qwen-VL / Claude with vision）
  ↓
5. 生成答案
```

#### 3.5 多模态的成本

| 环节 | 纯文本 | 多模态 | 倍数 |
|---|---|---|---|
| 单 PDF 解析 | pdftotext 1-2s | MinerU 单页 1-3s，100 页 PDF 1-5 分钟 | 30-150x |
| 整体索引时间 | 基准 T | 解析 + 切分 + 抽取，整体 2-5x | 2-5x |
| 存储 | 文本为主 | 文本 + 图片 PNG + 表格 HTML + 坐标 JSON | 5-20x |
| LLM 抽取 token | 纯文本 | 表格 HTML / 公式 LaTeX 拼进 prompt，token 翻倍 | 2-3x |
| 检索 | 文本相似度 | 文本 + 图片 embedding + 图遍历 | 1.5-2x |

**成本优化的几个抓手**：

- 只对"含图 ≥ 3 张"或"含表格 ≥ 2 张"的 PDF 走多模态解析，纯文本 PDF 走 `pdftotext` 兜底
- 图片 embedding 单独算（用 CLIP / BLIP），不和文本 embedding 混用一个向量库
- 表格识别结果可以缓存（同一张表出现在多份 PDF 里）
- 公式识别按需启用，纯文字 PDF 关掉 Formula 模块

#### 3.6 多模态评测

| 指标 | 度量对象 | 计算方式 |
|---|---|---|
| 版面分析准确率 | Layout 模块 | 抽 100 页人工标注的 PDF，统计 block 类别识别准确率 |
| 表格识别准确率 | Table 模块 | 表格 HTML 与 ground truth 的 cell 匹配率 |
| 公式识别准确率 | Formula 模块 | LaTeX 编译通过率 + 与 ground truth 公式的符号匹配率 |
| 跨模态检索召回率 | 多模态图谱 | ground truth 的"文字 → 图片 / 表格"对，被图查询命中的比例 |
| 跨页表格完整率 | 跨页处理 | 跨页表格被识别为同一张表的比例（目标 > 95%） |
| OCR 准确率（扫描件） | OCR 模块 | 字符级准确率（目标 > 95%） |

#### 3.7 PDF 多模态反模式

| 反模式 | 后果 |
|---|---|
| OCR / 版面分析后丢弃图片 | 跨模态检索能力完全丢失，"图 X 是什么"答不出来 |
| 表格被切碎走 `chunk_size=300` | 表格单元格被切到不同 chunk，列名和数据分离 |
| 不保留页码 + 坐标 | 用户问"第几页"无法回答，证据回查路径断裂 |
| 用 `pdftotext` 解析学术 PDF | 公式乱码、表格错乱、双栏交叉 |
| 图片和文字混在一个 chunk | LLM 把图片 caption 当成普通文本处理，图片节点丢失 |
| 不分页直接整篇 PDF 喂 LLM | context 超限，只处理开头，论文后半部分全丢 |
| 多模态 PDF 走纯文本 embedding | 图片没有 embedding，跨模态检索无解 |
| 表格识别结果不结构化 | 表格变成一段 HTML 字符串塞进 description，无法做结构化查询 |
| 公式不转 LaTeX | 公式变成乱码字符进 prompt，污染上下文 |
| 不区分扫描件和原生 PDF | 扫描件必须走 OCR，原生 PDF 走文本提取能省 50% 时间 |

---

## 十四、参考实现与生态对比

GraphRAG 是思路不是框架，本节列出主要开源实现的取舍。

### 生态对比

| 项目 | 增量更新 | 查询模式 | 社区算法 | 成本 | 适用规模 | 特点 |
|---|---|---|---|---|---|---|
| Microsoft GraphRAG | 弱（需手动增量） | Local / Global / DRIFT / Basic | Leiden（多层） | 高 | 中大规模（万级实体） | 文档最完整、参考价值最高 |
| LightRAG | 强（原生支持增量） | Local / Global / Hybrid | 实体 + 关系双层 | 低 | 中小规模（千-万级实体） | 增量友好、双层图 |
| Fast-GraphRAG | 中（OASIS 增量） | PageRank 检索 | 不依赖 Leiden | 极低 | 中小规模 | 强调低延迟、强调可解释 |
| NebulaGraph | 强（图数据库原生） | Cypher 查询 | 不依赖 Leiden | 中 | 超大规模（百万级实体） | 图数据库出身，Cypher 灵活 |
| LlamaIndex Property Graph | 中 | LLM 动态构建 | 无固定算法 | 中 | 中小规模 | 集成在 LlamaIndex 生态里 |

**判断口诀**：

- 增量更新是核心需求 → LightRAG
- 延迟敏感 / 可解释要求高 → Fast-GraphRAG
- 已有图数据库基础设施 → NebulaGraph
- 想要最完整的 GraphRAG 流水线参考 → Microsoft GraphRAG
- 已经在用 LlamaIndex → LlamaIndex Property Graph

### 微软 GraphRAG 配置文件关键参数

`settings.yaml` 里的核心字段，按"必须改 / 看场景改 / 别动"分类：

**必须改的**：

| 参数 | 默认 | 推荐 | 说明 |
|---|---|---|---|
| `input.storage.type` | `file` | `blob` / `s3` | 生产环境用对象存储 |
| `vector_store.type` | `lancedb` | 按规模选 | 见 [RAG 工程篇](./rag-engineering.md) |
| `llm.model` | `gpt-4-turbo` | 按预算选 | 中文场景考虑 Qwen / DeepSeek |

**看场景改的**：

| 参数 | 默认 | 推荐场景 | 说明 |
|---|---|---|---|
| `chunking.size` | 300 | 实体稀疏语料降到 200，结构化语料升到 500 | 实体抽取对边界敏感 |
| `chunking.overlap` | 100 | 维持 1:3 比例 | |
| `entity_extract.max_gleanings` | 0 | 召回率不够开 1 | token 翻倍 |
| `community_detection.max_cluster_size` | 10 | 大社区过大时升到 20-50 | 防止 Global Search 跑飞 |
| `summarize_descriptions.max_length` | 500 | 中文场景降到 200-300 | 中文摘要天然更长 |

**别动的**（除非你理解它在干嘛）：

- `embeddings.target` / `dimensions`：改了就重建索引
- `community_detection.seed`：影响 Leiden 随机性，调了之后评测集要重测
- `concurrent_requests`：和你的 LLM 限流对齐，不对齐就是被 ban

### 深度扩展

骨架只给了一张总表和一个参数分级。本节按"项目深度 + 选型决策树 + 配置深度 + 迁移互操作"四块展开。

### 1. 五大开源项目深度对比

#### Microsoft GraphRAG

**核心设计哲学**：把"全局问答"这条最难的问题做了最完整的端到端实现——从实体抽取、关系抽取、Leiden 社区检测、多分辨率社区报告、到 Local / Global / DRIFT / Basic 四种检索模式，文档、Prompt、Pipeline API 全部开源。是事实上的**参考标准**。

**适用场景**：

- 知识库 ≥ 1K 文档、需要 Global Search（"整体讲什么 / 主题是什么"这类问题占核心问法 ≥ 30%）
- 需要一个**长期维护**的参考实现（微软团队在持续迭代，2024 年 12 月发了 2.0 版本做 query 侧的重构）
- 想跑多分辨率社区检测 + Leiden 是必经之路
- 团队愿意吃 Neo4j / LanceDB 这种相对"重型"的栈

**不适用场景**：

- 增量更新是核心需求。微软的增量方案要自己写 Patch Pipeline（详见"十二、prompt_tune 与 API 化"），没有官方增量模式
- 实时性场景。Local Search 单查询 2-3s，Global Search 5-15s，DRIFT 更慢
- 中文 + 小规模语料。中文社区摘要天然偏长（500 字内塞不下），`summarize_descriptions.max_length` 要手动降到 200-300；社区算法的 Leiden 默认参数对中文社区边界的识别不算最优（中文分词 + 实体边界和英文不一样）
- GPU / 内存紧张。索引阶段 5x 普通 RAG，百万级文档必须上分布式，单机跑不起来

**迁移成本**：从其它方案迁过来几乎要重写 prompt。`prompts/` 下的 6 个文件（entity_extraction / summarize_descriptions / community_report / extract_graph / claim_extraction / prune）是微软的格式，其它实现都不能直接复用。从 RAG 本身迁过来（不是从其它 GraphRAG 迁过来）则好得多——`input/` 目录接 `.txt` / `.csv` / `.json`，文档加载层基本不动，只把 embedding + 向量检索换成 GraphRAG 的 5 段 pipeline。

**真实使用案例**：

- 微软官方博客（2024 年 4 月）公开了"私营企业文档问答"的 demo 数据集，跑通 1M token 的代码仓库检索
- 多家上市公司（制造业、能源行业）在内部知识库试点，但公开 repo 不多
- 学术圈大量 paper 用 GraphRAG 作为 baseline（如 PathRAG、HippoRAG 都用 GraphRAG 的实体表做对比基准）

**已知问题和限制**：

- 全量重建思路为主，增量需要 12 章自研的 Local 增量 + Global 全量组合方案
- GraphRAG 2.0（2024-12）做了重构但引入了 break change，老 1.x 升级路径不清晰
- 中文场景 prompt 默认没适配，必须跑 `prompt_tune` + `discover_entity_types`
- 索引阶段不能 resume，OOM 后从头跑
- `parallelization` 模块对中文长文档切分后丢失段落语义敏感（中文段落短，按 chunk_size=300 切时一句话被切成 3 段的比例比英文高）

#### LightRAG（HKUDS / 港大数据智能实验室）

**核心设计哲学**：把 GraphRAG 简化成"实体 + 关系"双层图，省去 Leiden 社区检测。增量更新是它**最大的差异化卖点**——新增文档时只对受影响实体做局部增量，不需要重建社区。

**适用场景**：

- 文档**每天新增 / 修改是常态**，需要原生增量支持
- 规模在千-万级实体，太大成本反而不如微软
- 想跑"实体 + 关系"双层图的简化检索（Local / Global / Hybrid 三种模式都建在这套双层图上）
- 中文场景友好：HKU 团队本身做中文 NLP，prompt 模板对中文术语更鲁棒

**不适用场景**：

- 需要 Leiden 多分辨率社区。LightRAG 没有社区检测，所以 Global Search 走的是"全图遍历 + 评分"，全图万级以上就慢
- 答宏观主题需要全局概览。LightRAG 的 Global Search 是"实体层 + 关系层"双层检索的合集，不是真正的"跨社区摘要"
- 团队在意参考实现的标准性。LightRAG 是论文驱动的二次实现，不算行业标准

**迁移成本**：从 LightRAG 迁到 Microsoft GraphRAG 要重新跑索引——LightRAG 的图存储是自研的 NetworkX pickle 格式，不导出 Neo4j；从 Microsoft GraphRAG 迁到 LightRAG 要把 Neo4j 重新导出成 LightRAG 格式，且 Leiden 社区层不可逆。

**真实使用案例**：HKU 团队论文（[LightRAG: Simple and Fast Retrieval-Augmented Generation](https://arxiv.org/abs/2410.05779)）的 GitHub repo 在 2024-Q4 进入 Trending 榜前三。中文社区有人把它接到 Dify 做 GraphRAG 节点。

**已知问题和限制**：

- 没有官方 Neo4j 后端，要接企业级图存储需要自己写适配
- Global Search 在万级以上实体时性能塌（线性扫描全图）
- 增量更新虽然支持但**没有 conflict resolution**——两个并发的增量任务会冲突
- 自研的文档格式不开放（pickle），lock-in 风险

#### Fast-GraphRAG（circl/airabbit-labs）

**核心设计哲学**：用**OASIS（Open-source Autonomous Self-Improving System）增量算法**做图谱增量 + 用 **PageRank 检索**替代社区摘要。延迟极低（单查询 < 500ms），可解释性强（每次检索能给出 PageRank 分数解释）。

**适用场景**：

- 延迟敏感，需要亚秒级响应
- 业务方对"为什么召回这条"有可解释要求（PageRank 分数可视化比社区摘要更直观）
- 知识库**频繁更新**，OASIS 增量算法比手动写增量 merge 简单
- 中小规模（万级实体以下）

**不适用场景**：

- 需要 Leiden 社区摘要。Fast-GraphRAG 完全放弃了社区检测，Global Search 用 PageRank 排序
- 已经有大厂基础设施（Neo4j / NebulaGraph）。Fast-GraphRAG 是 Python 原生实现，不依赖图数据库
- 答"宏观主题"问题质量不如微软。PageRank 评分倾向于"被引用多的实体"，但全局主题问题需要的是"语义上概括"

**迁移成本**：Fast-GraphRAG 的存储是自研的 CSV + parquet，不兼容图数据库。从 Neo4j 迁过来要重新写导出；从 Fast-GraphRAG 迁走也基本是重抽。

**真实使用案例**：circl 团队（早期开发人员主要在 AI safety 圈）的 demo 主推"个人知识库 + 实时更新"场景——把 ChatGPT 对话记录增量入图，秒级回答"我三个月前讨论过什么"。

**已知问题和限制**：

- 文档不全。Fast-GraphRAG 自述文档比微软少得多，二次开发要看源码
- PageRank 在稀疏图上效果差（少于 1000 实体 PageRank 分数区分度低）
- 没有企业级图存储后端

#### NebulaGraph（vesoft-inc）

**核心设计哲学**：不是 GraphRAG 框架，而是**图数据库 + GraphRAG 参考方案**。NebulaGraph 提供图存储 + Cypher-like 查询语言 nGQL + 自带 GraphRAG 流水线（基于 LLM 的实体抽取 + 关系抽取）。最大的差异在**图数据库出身**——亿级节点能撑住。

**适用场景**：

- 超大规模（百万级节点、千万级边）。NebulaGraph 是分布式图数据库，能水平扩展
- 已经在用 NebulaGraph 或考虑替代 Neo4j 的成本节约（NebulaGraph 开源 + 国产）
- 团队习惯用**类 SQL 的 Cypher / nGQL** 做图查询
- 想自己掌控 GraphRAG pipeline 的每个环节（NebulaGraph 提供的是基础设施 + 范例，不是开箱即用框架）

**不适用场景**：

- 中小规模快速上线。NebulaGraph 学习曲线陡，要部署集群 + 写 nGQL，不如直接用 Microsoft GraphRAG 的本地模式
- 不熟悉图数据库的团队。NebulaGraph 的运维 + 调优比 Neo4j 复杂
- 已有的 GraphRAG 框架（如微软）有官方 NebulaGraph 后端适配吗？没有。微软官方只支持 Neo4j / Memgraph / LanceDB，要接 NebulaGraph 要写自定义 `GraphStore` 适配器

**迁移成本**：从 Neo4j 迁过来要重写 Cypher 为 nGQL（语法 80% 相似，但函数库不一样）。NebulaGraph 项目自己提供 ETL 工具（Exchange / Spark Writer / NebulaGraph Exchange）。从微软 GraphRAG 迁到 NebulaGraph 路径几乎是从零开始——prompt、Pipeline、社区算法都要重写。

**真实使用案例**：小米、快手、美团的部分知识图谱团队用 NebulaGraph 做底层存储，GraphRAG 流水线自研。公开案例集中在反欺诈 / 推荐系统 / 风控领域，纯 GraphRAG 的案例偏少。

**已知问题和限制**：

- 集群运维成本高（至少 3 节点起）
- 中文社区比 Neo4j 小，企业级付费支持不如 Neo4j 成熟
- Storage + Graph + Meta Service 三层架构对 DevOps 要求高
- 和 LangChain / LlamaIndex 的官方集成适配是社区驱动，不如 Neo4j 稳定

#### LlamaIndex Property Graph Index

**核心设计哲学**：把 GraphRAG 作为 LlamaIndex 索引器的**一种实现**而不是独立框架。LlamaIndex 在 RAG 框架里已经统一了"加载 → 切分 → 嵌入 → 索引 → 检索"五层，Property Graph 是其中一种索引结构（和 VectorStoreIndex / KeywordTableIndex 并列）。

**适用场景**：

- 已经在用 LlamaIndex，不需要引入新的框架栈
- 中小规模（千-万级实体），想快速跑通 GraphRAG prototype
- 需要把 GraphRAG 和 LlamaIndex 的其它能力（Query Engine / Agent / Multi-Doc）组合
- 想用 LlamaIndex 的 `PropertyGraphExtractor` 自动抽取实体（schema 简单，不需要 Leiden）

**不适用场景**：

- 需要 Leiden 多分辨率社区 + 社区报告。LlamaIndex Property Graph 没有内置社区检测（2024-Q4 的 PR 还在讨论方向）
- 超大规模（百万级）。LlamaIndex Property Graph 的存储是 NetworkX / 简易 Kuzu，没做分布式
- 严苛的增量更新。Property Graph 的增量需要手动实现 `add` / `delete` API
- 文档完整性要求。LlamaIndex 的 GraphRAG 文档散落在不同模块页里，没有微软那种"从入门到生产"的完整手册

**迁移成本**：从 LlamaIndex Property Graph 迁到独立 GraphRAG 框架（如 LightRAG）要重新抽取实体（LlamaIndex 的 schema 自定义强于微软）；反向迁移只要把 LlamaIndex 的 Schema / Extractor / Retriever 串起来用。

**真实使用案例**：LlamaIndex 官方文档的"GraphRAG 入门"教程就是用 Property Graph Index 跑。社区有把它和 LlamaIndex Workflows 配合做"多步推理 + 图检索"的尝试。

**已知问题和限制**：

- Property Graph 仍处于快速迭代期，API 不稳定，跨版本 break change 频繁
- 社区检测是 Roadmap 项，2025 年才可能 GA
- 自定义 Extractor 的 schema 设计需要工程师自己设计，没有微软那种"领域 prompt_tune"流程
- 不支持 nGQL / Cypher 这类图查询语言，图遍历是 Python API

### 2. 选型决策树

#### 按规模选

| 规模 | 推荐 | 原因 |
|---|---|---|
| 万级（< 1 万段 / < 1K 文档） | 任意（LightRAG 起手最快） | 规模小，所有实现都能跑 |
| 十万级（1-10 万段 / 1-10K 文档） | Microsoft GraphRAG（Neo4j）+ LightRAG（小规模增量） | 需要 Leiden + Neo4j 才能稳 |
| 百万级（10 万-100 万段） | Microsoft GraphRAG + NebulaGraph | 百万级必须分布式存储 |
| 千万级（百万段以上） | NebulaGraph 自研 + 简化版 GraphRAG | 微软 + LightRAG 都没在千万级稳定过 |

#### 按查询模式选

| 主流查询模式 | 推荐 | 原因 |
|---|---|---|
| Local（who / what / when）为主 | 全部都行 | Local Search 是 GraphRAG 最容易做的部分 |
| Global（"整体讲什么"）为主 | Microsoft GraphRAG | Leiden + Community Report 是答案质量决定项 |
| DRIFT（先具体后宏观）为主 | Microsoft GraphRAG | 只有微软官方支持 DRIFT |
| Cypher / nGQL 灵活查询 | NebulaGraph | 图查询语言是它的天然优势 |
| 可解释检索 | Fast-GraphRAG | PageRank 可视化是天然优势 |

#### 按增量需求选

| 增量频率 | 推荐 | 原因 |
|---|---|---|
| 每天更新（> 10% 文档 / 天） | LightRAG | 原生增量，省心 |
| 每周更新 | Microsoft GraphRAG（自己写增量） | 周期性能接受 |
| 每月更新 | 任意，全量重建兜底 | 不必为增量做架构 |
| 不更新（一次性语料） | 任意，看其它维度 | 全量重建无所谓 |

#### 按基础设施选

| 已有基础设施 | 推荐 | 原因 |
|---|---|---|
| 已有 Neo4j | Microsoft GraphRAG | 官方后端 |
| 已有 NebulaGraph | NebulaGraph 自研 | 复用现有集群 |
| 已有 LlamaIndex | LlamaIndex Property Graph | 不引新框架 |
| 已有 Dify | Dify 的 GraphRAG 节点（基于 LightRAG） | 复用 Workflow |
| 从零开始 | Microsoft GraphRAG（参考标准）/ LightRAG（增量） | 看核心需求 |

#### 按团队能力选

| 团队画像 | 推荐 | 原因 |
|---|---|---|
| 1-2 人小团队，无图数据库经验 | LightRAG | 安装即跑，避免 Neo4j 运维 |
| 有图数据库工程师 | Microsoft GraphRAG / NebulaGraph | 能榨干框架能力 |
| 已有 LangChain / LlamaIndex 工程师 | LangChain GraphRAG / LlamaIndex Property Graph | 复用现有技术栈 |
| 中文场景，中小型项目 | LightRAG + Dify / 国产 LLM | Prompt 对中文友好 |
| 大型项目 + 长期维护 | Microsoft GraphRAG | 文档最全、社区最大 |

### 3. 微软 GraphRAG 配置参数深度

骨架里只分了"必须改 / 看场景改 / 别动"。下面把每类展开到配置项 + 决策依据 + 部署环境差异。

#### 必须改的字段

`input.storage.type` 默认 `file`，生产环境必须改。原因：

- 默认是读本地目录，单机跑没问题，但 Pipeline API 异步跑（Celery worker）时读不到 NFS 共享盘会报错
- 推荐 `blob`（Azure Blob）或 `s3`（AWS S3）或 `cos`（腾讯云 COS），OSS 兼容
- 改了之后 input 目录在对象存储上，Pipeline 之间共享 input 不需要共享文件系统

`vector_store.type` 默认 `lancedb`（LanceDB），是个嵌入式向量库。生产环境的选项：

| 后端 | 适用规模 | 优势 | 代价 |
|---|---|---|---|
| LanceDB | 单机、< 100 万向量 | 嵌入式、零部署 | 不能水平扩展 |
| Neo4j（同库复用） | < 1000 万向量 | 一个数据库管图 + 向量 | Neo4j 向量检索比专用向量库慢 3-5x |
| Milvus | 千万级向量 | 高性能、专业向量库 | 多维护一个组件 |
| Qdrant | 十万-百万级 | 单二进制易部署 | 中文文档偏少 |

`llm.model` 必须改。中文场景考虑：

- `qwen-max` / `qwen-plus`：阿里通义，中文实体抽取质量比 GPT-4 高 10-20%
- `deepseek-chat`：成本低（输入 0.14 元/M），中文实体抽取合格但鲁棒性弱于 Qwen
- `gpt-4o`：跨语言效果稳定但贵，按 token 算
- 选型的决策依据是"实体抽取的 F1 分数"，通用 LLM 评测分数不准

#### 看场景改的字段

| 参数 | 默认 | 何时改 | 改后会怎样 |
|---|---|---|---|
| `chunking.size` | 300 | 实体稀疏降到 200，结构化语料升到 500 | 降到 200：实体抽取边界更准，但 token 翻倍；升到 500：token 节省 40%，但跨段实体合并难度上升 |
| `chunking.overlap` | 100 | 维持 1:3（overlap / size） | 比例不对：要么重复抽取（overlap 太大），要么边界实体漏掉（overlap 太小） |
| `entity_extract.max_gleanings` | 0 | 召回率不够开 1 | 0 是 fast 模式（每个 chunk 1 次抽取）；1 是 multi-pass（再跑一次补漏），token 翻倍，召回率 +10-20% |
| `entity_extract.prompt` | 默认 | 跨领域必改 | 默认是"通用新闻"，医疗 / 法律 / 金融场景不预定义类型会抽出大量噪声 |
| `community_detection.max_cluster_size` | 10 | 大社区过大时升到 20-50 | 太小：Global Search 报告碎片化；太大：单社区摘要超 token 上限 |
| `community_detection.leiden_params.resolution` | 1.0 | 大数据集升到 1.5-2.0 | 分辨率高：社区小而多；分辨率低：社区大而粗 |
| `summarize_descriptions.max_length` | 500 | 中文场景降到 200-300 | 中文摘要天然偏长，500 字限制下 LLM 会丢失关键信息 |
| `global_search.max_tokens` | 12000 | 报告长度被截断时升 | 不够：社区信息丢失；太大：单查询成本爆炸 |
| `local_search.max_community_reports` | 默认 | 实体邻居不足时升 | 控制 Local Search 里能从社区报告拿多少上下文 |

#### 别动的字段

`embeddings.target` / `dimensions`：

- 改了就重建索引——向量维度和所有 text_unit 的 embedding 不兼容
- 默认是 OpenAI text-embedding-ada-002 的 1536 维，换 BGE（768）、M3E（768）、Qwen Embedding（1024）后必须重建
- 决策前先确认业务用哪个 embedding provider，再设 `dimensions`，**不要中途换**

`community_detection.seed`：

- Leiden 是随机算法，seed 控制初始化的随机性
- 改 seed 后，社区划分完全不同，评测集分数会波动 ±3-5%
- 改完必须重跑评测 + 重新生成 community_reports

`concurrent_requests`：

- 必须和 LLM provider 的 RPM 对齐，公式：`max_concurrent = provider_RPM / 60 / avg_latency_seconds`
- 对齐 OpenAI Tier 1（500 RPM）大约 4-8 并发
- 不对齐 = 429 Rate Limit 错误，重试堆积 = 成本翻倍
- 改了之后必须重测性能曲线（profile token / 秒）

#### 按部署环境的配置差异

| 环境 | 关键配置 |
|---|---|
| 本地开发 | `vector_store.type=lancedb`，`concurrent_requests=5`，`input.storage.type=file`，关 `parallelization.steps` |
| Docker | `vector_store.type=milvus` + 独立 vector 容器；Neo4j 也独立容器；`concurrent_requests=20` |
| Kubernetes | `vector_store.type=milvus` 或 `qdrant`；Neo4j StatefulSet；Pipeline 用 Celery + Redis；`concurrent_requests` 跑满 RPM / 60 / latency |

#### 按数据规模的配置差异

| 规模 | 关键配置 |
|---|---|
| 万级文档（< 1 万段） | `chunking.size=300`，`max_gleanings=0`，`leiden` 跑 0-2 层，社区摘要全部生成，单机 LanceDB + NetworkX |
| 十万级文档 | `chunking.size=400-500` 节省 token，`max_gleanings=1` 补召回，Neo4j 单机 + Milvus，`concurrent_requests=25-50` |
| 百万级文档 | `chunking.size=500`，分层索引（按 domain / time 分片），Neo4j Causal Cluster + Milvus Cluster，`pipeline.steps` 按域分批跑 |

#### 常见配置错误

| 错误 | 后果 | 修复 |
|---|---|---|
| `vector_store.embedding_dim` 与 `embeddings.dimensions` 不一致 | embedding 写入失败 / 检索精度塌 | 两值必须一致，建议用 yaml anchor 或同一个变量 |
| `chunk_size` 和 embedding provider 的最大输入长度不匹配 | 截断后实体抽取质量塌 | BGE 限 512 token、Qwen Embedding 限 2048 token，chunk_size + overlap 不能超过 |
| `community_detection.max_cluster_size` 设得太大 | 单社区摘要超 token 上限，Global Search 跳过该社区 | 限制 ≤ 50，超过的社区强制 Leiden 再分 |
| `concurrent_requests` 设太高 | 触发 provider 429，token 成本翻倍 | 按 RPM 公式反推 |
| `input.storage.type=file` 在 Celery worker 上跑 | worker 读不到 NFS 共享盘 | 改 `blob` / `s3` |
| `discover_entity_types` 一直开着 | 每次重启都重跑 + 重生 prompt + 重跑索引 | 跑完一次后写死 `entity_types` |
| `parallelization.num_threads` 设得比 CPU 核数多 | 进程上下文切换，性能塌 | 设为 CPU 核数 - 2 |
| `storage.cache=False` 在生产 | 每次 query 都重读 parquet | 生产必须开 cache，否则延迟 5-10s |

### 4. 迁移与互操作

#### 一个 GraphRAG 实现迁到另一个的成本

| 迁移路径 | 成本 | 主要改动 |
|---|---|---|
| Microsoft → LightRAG | 高（重抽） | 数据导出 + LightRAG 格式写入 + 重跑索引；Leiden 社区层不可逆 |
| Microsoft → Fast-GraphRAG | 中（格式转换） | entities / relationships 导出为 CSV，Fast-GraphRAG 导入；社区摘要丢弃 |
| Microsoft → NebulaGraph | 极高 | 自研 Pipeline + 写 nGQL；prompt 重写；社区算法自己实现 |
| LightRAG → Microsoft | 中（重抽） | LightRAG 的双层图映射到 entities + relationships，Leiden 重跑 |
| LlamaIndex Property Graph → Microsoft | 低（导出） | LlamaIndex 的 Extractor 输出基本兼容 entities 表 |
| 任意 → NebulaGraph | 高 | 写自定义 GraphStore 适配器 + nGQL 查询转换 |

#### 导出格式对比

| 格式 | 适用 | 谁消费 |
|---|---|---|
| `entities.parquet` / `relationships.parquet` / `community_reports.parquet` | Microsoft GraphRAG 的标准产出 | 微软生态 + 任何 parquet consumer |
| Neo4j dump（`neo4j-admin dump`） | 完整图（含节点 / 边 / 索引） | 任何兼容 Neo4j 的实现 |
| CSV（节点 / 边分两张表） | 通用、轻量、人类可读 | 任何实现都支持；信息损失大（无嵌套属性、无索引） |
| Kuzu / NetworkX pickle | Python 原生 | 仅 Python 生态 |
| NebulaGraph Exchange 导出的 nGQL 语句 | NebulaGraph 集群 | NebulaGraph 集群迁移 |
| GraphML / GEXF | 学术 / 可视化 | Gephi / Cytoscape |

#### 跨实现的查询兼容性

| 查询模式 | Microsoft | LightRAG | Fast-GraphRAG | NebulaGraph | LlamaIndex Property Graph |
|---|---|---|---|---|---|
| Local Search | 原生 | 原生 | 原生 | 自己写 | 原生 |
| Global Search | 原生（社区摘要） | 双层图版（不是真正的社区摘要） | 不支持（PageRank 替代） | 自己写 | 不支持 |
| DRIFT Search | 原生 | 不支持 | 不支持 | 不支持 | 不支持 |
| Cypher / nGQL 灵活查询 | 仅 Neo4j 模式 | 不支持 | 不支持 | 原生 | 不支持 |
| PageRank 可解释 | 不支持 | 不支持 | 原生 | 自己写 | 不支持 |
| 多模态（图 + 向量） | 原生 | 原生 | 原生 | 自己写 | 原生 |

结论：**没有任何两种实现的查询 API 完全兼容**。从 A 迁到 B 要重写 query 侧。

#### 是否值得为业务做自研

| 条件 | 建议 |
|---|---|
| 业务是"全球宏观主题问答"，需要 Leiden 多分辨率 + 社区摘要 + DRIFT | 不要自研，用 Microsoft GraphRAG |
| 业务是"实体检索 + 跨实体关系"，高频更新 | 用 LightRAG 或者在 LlamaIndex 之上自研 Extractor |
| 业务是"知识库 + 复杂自定义检索策略"（如金融风控、医疗诊断） | 在 Microsoft GraphRAG 之上做 wrapper（不改 pipeline，只重写 query 路由） |
| 业务已有 NebulaGraph 集群 + 工程师 | 在 NebulaGraph 之上自研，但只做 GraphRAG 的"子集"——只要实体抽取 + 图存储 + Cypher 查询，省掉社区检测 |
| 业务是"纯实体关系"的中小规模，团队 1-2 人 | 直接用 Microsoft GraphRAG + Neo4j Community，不要自研 |

**自研最常见的反模式**：

- 团队直接抄一个"GraphRAG-like"框架，但只抄实体抽取不做 Leiden / 社区摘要——结果问"整体讲什么"答不出来
- 自研 Pipeline 但 prompt 模板不沉淀成版本库——prompt 改了不通知，对外接口的回答质量反复横跳
- 自研图存储不用 Neo4j / NebulaGraph——百万级节点后自己写存储的代价远大于复用现成图数据库


---

## 十五、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>Microsoft GraphRAG（公开框架）</strong>（点击展开）</summary>

- [Microsoft GraphRAG 官方文档](https://microsoft.github.io/graphrag/) —— 图构建 / 社区检测 / 摘要生成完整流程
- [GraphRAG 论文：From Local to Global: A Graph RAG Approach to Query-Focused Summarization](https://arxiv.org/abs/2404.16130) —— 全局主题问答的原始方案
- [GraphRAG Prompt 模板](https://github.com/microsoft/graphrag/tree/main/prompts) —— 实体 / 关系 / 社区摘要的 Prompt 工程

</details>

<details>
<summary><strong>Dify GraphRAG 集成（待补充）</strong>（点击展开）</summary>

- [dify GraphRAG 节点](../application-notes/dify/)（应用笔记目录待建）

</details>

<details>
<summary><strong>公开框架对比（外部）</strong>（点击展开）</summary>

- [Neo4j + LangChain](https://neo4j.com/docs/llms-integrations/) —— 图数据库 + LLM 集成
- [LlamaIndex Property Graph Index](https://docs.llamaindex.ai/en/stable/module_guides/indexing/property_graph/) —— 轻量级图索引
- [LangChain Graph RAG](https://blog.langchain.com/graph-rag/) —— LangChain 官方 GraphRAG 实现

</details>