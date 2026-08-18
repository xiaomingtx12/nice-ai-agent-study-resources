---
sidebar_position: 15
sidebar_label: 13 RAG 高级检索技术
description: 在 Retriever 协议边界内拼装查询改写、混合检索、父子切片、压缩重排与评估——v1 没有内置这些组件，但协议允许自己组合。
---

# LangChain 源码 13：RAG 高级检索技术——在协议边界内组合

## 源码定位

> **阅读基线**：`langchain-core` 1.4.6（`langchain_v1` 仓库快照内）。  
>
> **核心路径**：
>
> - **组合的协议根**：`libs/core/langchain_core/retrievers/base.py`——`BaseRetriever` 的 `invoke` / `ainvoke` / `batch` / `abatch` 与 `_get_relevant_documents()` 抽象，高级检索的所有组合都收敛到这一个接口。
> - **并行与管道原语**：`libs/core/langchain_core/runnables/`——`RunnableParallel`、`RunnableBranch`、`RunnableLambda` 是查询改写、混合检索与压缩的拼装积木（[01 篇](./01-runnable-and-lcel.md) 已展开）。
> - **切分与存储**：`libs/text-splitters/`、`libs/core/langchain_core/vectorstores/`——父子切片的双粒度 chunk 与两个 VectorStore 的关联方式在正文四节展开。
> - **MMR 的存取实现**：`libs/core/langchain_core/vectorstores/in_memory.py`——`fetch_k` / `lambda_mult` 的真实语义在正文三节展开。
> - **Classic 层的对照物**：`libs/langchain/langchain_classic/retrievers/`——`EnsembleRetriever`、`MultiQueryRetriever`、`ParentDocumentRetriever`、`ContextualCompressionRetriever` 都在这里，正文用它对照"v1 为什么没有内置，但协议允许自己拼"。
> 检索侧的缓存封装器 `CacheBackedEmbeddings` 同样在 Classic 层（`langchain_classic/embeddings/cache.py`），但它的机制是 Embedding 层的 cache-aside，与 Retriever 协议无关，归 [12 篇 §四](./12-rag-components-and-retrieval.md)。

## 为什么读这一篇

[12 篇](./12-rag-components-and-retrieval.md) 讲了基础数据流：Loader → Document → Splitter → Embeddings → VectorStore → Retriever。本篇回答它的下一个问题：**召回质量不够时，在 Retriever 协议边界内能做什么？**

先明确一个包边界事实（[00 篇](./00-project-overview-and-repository-structure.md) 的规则）：

- `MultiQueryRetriever`、`ParentDocumentRetriever`、`ContextualCompressionRetriever`、`EnsembleRetriever` 等**全部在 `langchain_classic` 兼容层**（`libs/langchain/langchain_classic/retrievers/`）；
- `langchain-core` 只定义 `BaseRetriever` 协议，v1 主线没有内置这些高级检索组件。

这不是"框架缺功能"——**协议本身就允许你组合**。`BaseRetriever.invoke(query) -> list[Document]` 是一个开放接口：任何"查询进、文档出"的东西都可以是 Retriever。本篇的每项技术都是这个协议上的组合，用的都是 v1 已有的 Runnable 原语。

## 一、查询改写：入口质量决定召回上限

**问题**：用户问题表述差（口语、指代不明、缺上下文），向量检索直接崩。

**思路**：模型先用多个角度改写查询，再并行检索，最后合并去重。

```python
from langchain_core.runnables import RunnableParallel, RunnableLambda
from langchain_core.output_parsers import StrOutputParser

rewrite_prompt = ChatPromptTemplate.from_template(
    "为下面的问题生成 3 个不同角度的检索查询，每行一个：\n{question}"
)

def parse_queries(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]

def merge_unique(results):
    seen, docs = set(), []
    for channel in results.values():
        for doc in channel:
            key = doc.page_content[:100]      # 粗略去重
            if key not in seen:
                seen.add(key)
                docs.append(doc)
    return docs

# 改写后的 3 个查询并行检索，合并去重
multi_query = (
    rewrite_prompt | model | StrOutputParser() | RunnableLambda(parse_queries)
) | RunnableParallel({f"q{i}": retriever for i in range(3)}) | RunnableLambda(merge_unique)
```

**为什么有效**：向量检索的召回上限由查询与文档的语义距离决定。改写不改变文档，但改变查询——把"用户的一句话"变成"三个角度的检索意图"，抬高了召回上限。

**边界**：改写增加了一次模型调用成本；改写质量依赖模型能力，简单问题反而可能改写坏。用不用要看"召回失败是因为查询表述"还是"因为文档本身缺失"。

## 二、混合检索：关键词 + 向量双通道

**问题**：向量检索对专有名词、代码、精确 ID 召回差（Embedding 模型未必见过这些 token）。

**思路**：BM25 等关键词检索与向量检索并行，合并结果。

```python
from langchain_core.runnables import RunnableParallel, RunnableLambda

bm25_retriever = ...   # 关键词检索器（如 BM25）
vector_retriever = vector_store.as_retriever(search_type="similarity")

def rrf_merge(results, k=60):
    # RRF：倒数排名融合，对异构分数稳健
    scores: dict[str, float] = {}
    docs_by_key: dict[str, Document] = {}
    for channel in results.values():
        for rank, doc in enumerate(channel):
            key = doc.page_content[:100]
            scores[key] = scores.get(key, 0) + 1 / (k + rank + 1)
            docs_by_key.setdefault(key, doc)
    return [docs_by_key[k] for k in sorted(scores, key=scores.get, reverse=True)]

hybrid = RunnableParallel(
    {"bm25": bm25_retriever, "vector": vector_retriever}
) | RunnableLambda(rrf_merge)
```

**为什么有效**：BM25 擅长精确词匹配（代码、型号、人名），向量擅长语义近义。两者失败模式互补。

**RRF 为什么比加权平均稳**：不同检索器的分数尺度完全不同（相似度 0~1 vs BM25 分数无上界），加权平均要先归一化；RRF 只看排名，天然消除尺度差异。这是信息检索的成熟做法。

## 三、MMR 与 metadata 过滤：在 `as_retriever` 边界内

**MMR（最大边际相关）**——`as_retriever(search_type="mmr")` 不只是"换一种排序"。真实语义（`vectorstores/in_memory.py`）：

```python
retriever = vector_store.as_retriever(
    search_type="mmr",
    search_kwargs={"k": 4, "fetch_k": 20, "lambda_mult": 0.5},
)
# fetch_k=20：先取 20 个候选（召回）
# k=4：再从候选中选 4 个（精炼）
# lambda_mult：0~1 之间平衡相关性与多样性
```

- `fetch_k` 是召回池大小，`k` 是最终返回数——`fetch_k` 必须大于 `k`，否则 MMR 没有选择空间；
- `lambda_mult=1` 纯相关性，`lambda_mult=0` 纯多样性，生产常用 0.5~0.7。

**metadata 过滤**——向量检索支持结构化过滤，把"语义相似"与"业务约束"分开：

```python
hits = vector_store.similarity_search(
    "退款政策",
    k=4,
    filter={"source": "policy.md", "tenant": "acme"},
)
```

生产里最常见的错误是"检出不该看的资料"（12 篇故障表第 5 行）——正确做法是在存储层用 filter 挡住，而不是在最终回答层隐藏来源。

## 四、父子切片：检索粒度与上下文粒度的矛盾

**问题**：小 chunk 检索精确但缺少上下文，大 chunk 有上下文但检索粗糙。

**思路**：两个粒度并存——小 chunk 用于检索，命中的小 chunk 通过 metadata 关联回大 chunk，大 chunk 送模型。

```python
# 索引期：两种粒度都存，用 parent_id 关联
for parent in splitter_large.split_documents(docs):
    parent_id = str(uuid.uuid4())
    vector_store.add_documents([parent], ids=[parent_id])
    for child in splitter_small.split_documents([parent]):
        child.metadata["parent_id"] = parent_id
        child_store.add_documents([child])

# 检索期：小 chunk 命中 → 回查大 chunk
def expand_to_parent(results):
    parent_ids = {d.metadata["parent_id"] for d in results}
    return vector_store.get(ids=parent_ids)

child_retriever = child_store.as_retriever(search_kwargs={"k": 4})
parent_expanded = child_retriever | RunnableLambda(expand_to_parent)
```

**为什么有效**：检索的"证据粒度"和生成的"上下文粒度"不是一回事。父子切片让检索精确、上下文完整——这是"用 metadata 设计解决切分粒度问题"的典型。

## 五、压缩与重排：召回后不等于有用

**问题**：检索回来的 chunk 里真正有用的可能就一段，或排序与相关性不一致。

**思路**：召回后加一层"精炼"——压缩（提取/过滤）或重排（cross-encoder）。

```python
from langchain_core.runnables import RunnableLambda

def extract_relevant(results, question):
    # 压缩：对每个 chunk 判断是否与问题相关，只留相关的
    return [d for d in results if is_relevant(question, d.page_content)]

compressed = retriever | RunnableLambda(
    lambda docs: extract_relevant(docs, "退款申请什么时候截止？")
)
```

**重排与向量检索的区别**：向量检索用双编码器（查询和文档分别编码，近似快），重排用 cross-encoder（查询与文档拼接一起编码，精确慢）。生产 RAG 的标准做法是"向量粗召回 + cross-encoder 精重排"——先用便宜的召回 50 个，再精确重排取前 5 个。

**边界**：压缩/重排都增加延迟。只有"召回量大、噪声多"时才值得加；简单场景直接调大 `k` 更划算。

## 六、评估：没有指标就没有定位

12 篇的故障表说"召回不准"要按边界排查——但排查的前提是有指标。

| 指标 | 衡量什么 | 怎么算 |
| --- | --- | --- |
| hit rate | 相关文档是否出现在结果里 | 前 k 名里是否有 gold 文档 |
| MRR（平均倒数排名） | 第一个相关文档排多靠前 | `1/rank` 取平均 |
| nDCG（归一化折损累计增益） | 排序质量（相关度加权） | 折损累计增益 / 理想排序 |

```python
def hit_rate(retriever, eval_set, k=4):
    hits = 0
    for q, gold_doc in eval_set:
        results = retriever.invoke(q)[:k]
        if any(d.page_content == gold_doc for d in results):
            hits += 1
    return hits / len(eval_set)
```

**为什么先定指标**：没有指标，"召回不准"无法定位是查询改写、切分、检索类型还是重排的问题。指标先于优化——先测出基线，再逐层替换并对比。

## 七、组合的边界：哪些能拼，哪些拼不了

| 技术 | 组合方式 | 边界 |
| --- | --- | --- |
| 查询改写 | `RunnableParallel` 扇出 | 增加一次模型调用；改写依赖模型能力 |
| 混合检索 | `RunnableParallel` + RRF 合并 | 需要两种检索器；RRF 只看排名 |
| MMR | `as_retriever(search_type="mmr")` | `fetch_k` > `k`；多样性牺牲相关性 |
| 父子切片 | metadata 关联 + 回查 | 需要维护 parent_id；索引期多存一份 |
| 压缩/重排 | 召回后 Runnable 精炼 | 增加延迟；cross-encoder 要额外模型 |
| 评估 | 离线脚本 | 需要 gold 标注集；指标先于优化 |

**共同约束**：所有技术都遵守 `BaseRetriever.invoke(query) -> list[Document]` 协议——组合后的整体仍然是一个 Retriever，可以继续进入 LCEL 链、包装成 Agent 工具，或与 [12 篇](./12-rag-components-and-retrieval.md) 的故障表配合定位问题。

## 读完后应该能判断什么

- 为什么 v1 没有内置 `MultiQueryRetriever` / `EnsembleRetriever`（它们在 Classic 层），但协议允许自己组合；
- 查询改写、混合检索、父子切片、压缩重排各自解决哪个召回瓶颈；
- RRF 为什么比分数加权稳（只看排名，不关心尺度）；
- MMR 的 `fetch_k` / `lambda_mult` 语义，metadata 过滤为什么要在存储层做；
- 评估指标（hit rate / MRR / nDCG）先于优化——没有基线就无法定位"召回不准"。
