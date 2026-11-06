---
sidebar_position: 15
sidebar_label: 13 RAG 高级检索技术
description: 从 MultiQuery、Ensemble、MMR、父子文档与压缩检索器的真实实现，解释查询扩展、排名融合、候选选择和两层存储的代价。
---

# LangChain 源码解析 13：RAG 高级检索技术

> 固定提交与已阅读测试见[源码基线](source-baseline.md)。

**源码定位**

> **阅读基线**：langchain 1.3.7、langchain-core 1.4.6、langchain-classic 1.0.8、langchain-text-splitters 1.1.2；仓库快照 `76c32db9b38dfc287c958dc2a914d4834f022c1c`。路径均相对 LangChain 仓库根目录。
>
> - 检索协议：`libs/core/langchain_core/retrievers.py` → BaseRetriever.invoke。
> - 多查询生成与检索：`libs/langchain/langchain_classic/retrievers/multi_query.py` → MultiQueryRetriever._get_relevant_documents、aretrieve_documents、unique_union。
> - 排名融合：`libs/langchain/langchain_classic/retrievers/ensemble.py` → EnsembleRetriever.weighted_reciprocal_rank。
> - MMR 候选池：`libs/core/langchain_core/vectorstores/in_memory.py` → InMemoryVectorStore.max_marginal_relevance_search_by_vector。
> - MMR 贪心选择：`libs/core/langchain_core/vectorstores/utils.py` → maximal_marginal_relevance。
> - 父子索引：`libs/langchain/langchain_classic/retrievers/parent_document_retriever.py` → ParentDocumentRetriever._split_docs_for_adding、add_documents。
> - 子片段命中后回查父文档：`libs/langchain/langchain_classic/retrievers/multi_vector.py` → MultiVectorRetriever._get_relevant_documents。
> - 查询相关压缩：`libs/langchain/langchain_classic/retrievers/contextual_compression.py` → ContextualCompressionRetriever._get_relevant_documents。

## 一、从失败位置选择检索机制

“没找到能回答问题的证据”至少有几种原因：查询表述与资料不同、不同检索方式命中不同材料、候选过于重复、小片段缺少前提，或者相关材料被无关内容淹没。增加同一种检索的 k 不会同时解决这些问题。

本篇直接分析现有实现。MultiQuery、Ensemble、ParentDocument 和 ContextualCompression 属于 Classic 发布包；它们仍使用 core 的 Document、Retriever 等协议。包归属决定依赖和版本核对，不意味着必须自行重写。

| 机制 | 改变的对象 | 不会自动解决的问题 |
| --- | --- | --- |
| MultiQuery | 一个问题扩展成多条检索查询 | 原始材料根本不存在 |
| Ensemble / RRF | 融合多个检索结果排名 | 错误证据的事实真实性 |
| MMR | 从候选池中减少重复 | 候选池之外的资料召回 |
| ParentDocument | 小片段检索、大文档返回 | 两个存储之间的一致性 |
| ContextualCompression | 根据原问题处理候选文档 | 上游完全没有召回的证据 |

## 二、MultiQuery：逐条查询，然后合并文档

MultiQueryRetriever 先让模型生成多个查询，再分别调用同一个检索器。同步入口的核心如下，省略函数签名：

```python
queries = self.generate_queries(query, run_manager)
if self.include_original:
    queries.append(query)
documents = self.retrieve_documents(queries, run_manager)
return self.unique_union(documents)
```

include_original 控制是否额外保留原问题。生成器输出与去重没有保证每条查询都更好；改写可能遗漏实体、时间或否定条件，应对照原查询命中的证据。

同步 retrieve_documents 逐条 invoke；异步 aretrieve_documents 使用 gather。下面是异步实现主体：

```python
document_lists = await asyncio.gather(
    *(
        self.retriever.ainvoke(
            query,
            config={"callbacks": run_manager.get_child()},
        )
        for query in queries
    ),
)
return [doc for docs in document_lists for doc in docs]
```

每个调用收到的是一条 query。把完整查询列表直接送给 RunnableParallel 的多个同一检索器，会让每个分支都收到整个列表，不会自动按索引分配查询。需要自己组合时，应明确逐条映射的输入。

unique_union 根据 Document 对象相等性去重，不是截取正文前 100 个字符；相同文本但 metadata 或 ID 不同的文档可能仍保留。合并保持首次出现顺序，也不是重排。异步并行减少等待，但这段 gather 本身没有设置并发限额，生成查询很多时应控制扇出量。

## 三、Ensemble：按排名融合，按标识去重

EnsembleRetriever 将多个检索器的有序结果交给加权倒数排名融合（RRF）。例如关键词通道命中精确型号，向量通道命中语义近似条款，两者的原始分数不必处于相同尺度。

weighted_reciprocal_rank 的计分代码如下，省略长度校验与最后排序：

```python
rrf_score: dict[str, float] = defaultdict(float)
for doc_list, weight in zip(doc_lists, self.weights, strict=False):
    for rank, doc in enumerate(doc_list, start=1):
        rrf_score[
            (
                doc.page_content
                if self.id_key is None
                else doc.metadata[self.id_key]
            )
        ] += weight / (rank + self.c)
```

每个排名从 1 开始，文档在某通道贡献 weight/(rank+c)，多通道贡献相加，再按相同键去重并降序返回。假设两个通道权重各为 0.5、c=60，一份文档分别排第 1、第 3，则得分为 0.5/61+0.5/63；只在一个通道排第 1 的文档只有 0.5/61。

默认用完整正文作键，跨来源相同文本会合并；设置 id_key 后从 metadata 取该键，并非自动使用 Document.id。各通道需要使用一致且存在的文档标识。RRF 消除了直接比较原始分数的需要，却仍受权重、候选数和通道质量影响，不能保证融合必然优于任一单通道。

## 四、MMR：先取候选，再贪心选择不重复的证据

MMR（最大边际相关性）在候选池内兼顾问题相关性与已选结果的相似程度。InMemoryVectorStore 先通过普通相似度搜索取 fetch_k 个候选，再调用 maximal_marginal_relevance 选最多 k 项。

算法先选与问题最相似的一项，后续逐轮减去与已选集合的最大相似度。下面是循环中的实际评分分支：

```python
redundant_score = max(similarity_to_selected[i])
equation_score = (
    lambda_mult * query_score - (1 - lambda_mult) * redundant_score
)
if equation_score > best_score:
    best_score = equation_score
    idx_to_add = i
```

lambda_mult 越大越偏向相关性；值为 0 时，首项仍按查询相关性选择，其后的选择才完全依赖去冗余项。fetch_k 大于 k 通常能留下更多选择空间，但源码并不要求它必须更大；候选不足时只返回已有候选。

InMemoryVectorStore 的初始搜索对通过过滤的全部存储记录计算相似度；随后 MMR 又比较候选与已选集合。因此成本不是“只做 fetch_k 次相似度计算”。调大候选池会增加第二阶段工作量，具体外部向量库的首阶段成本则由其索引实现决定。

过滤条件与 MMR 是不同职责。当前内存实现的 filter 是接收 Document 的函数，并在相似度计算前应用；不能直接照搬某个外部向量库的字典过滤语法。租户与版本等业务条件还要覆盖后续父文档回查，避免只过滤小片段却返回了不应可见的父正文。

## 五、ParentDocument：子片段进向量库，父文档进文档存储

ParentDocumentRetriever 继承 MultiVectorRetriever，用小片段匹配查询，再按父 ID 回查完整上下文。它不要求父子两份内容都进入向量库。

_split_docs_for_adding 可先用 parent_splitter 切出父文档，再用 child_splitter 生成子片段。每个子片段的 metadata[self.id_key] 指向父文档 ID。add_documents 的写入顺序如下，省略参数准备：

```python
docs, full_docs = self._split_docs_for_adding(
    documents,
    ids,
    add_to_docstore=add_to_docstore,
)
self.vectorstore.add_documents(docs, **kwargs)
if add_to_docstore:
    self.docstore.mset(full_docs)
```

docs 是子片段，full_docs 是父 ID 与父 Document 的配对。向量写入在先，父文档写入在后，两项调用不构成原子事务。父写入失败会留下可检索但无法展开的子片段，更新和删除也需维护两侧关系。

MultiVectorRetriever 检索到子片段后，按首次出现顺序收集父 ID，再批量回查：

```python
# 保持命中结果里父 ID 首次出现的顺序。
ids = []
for d in sub_docs:
    if self.id_key in d.metadata and d.metadata[self.id_key] not in ids:
        ids.append(d.metadata[self.id_key])
docs = self.docstore.mget(ids)
return [d for d in docs if d is not None]
```

父文档缺失时被过滤，不会自动重建；多个子片段属于同一父文档时只回传一份，所以检索 k 个子片段不等于返回 k 份父文档。回查后的文本可能显著变长，送模型前还要检查证据范围与总长度。

## 六、压缩与重排：把原问题继续传给候选处理器

ContextualCompressionRetriever 先调用 base_retriever，再把候选和同一个 query 交给 base_compressor。下面摘录非空结果分支：

```python
if docs:
    compressed_docs = self.base_compressor.compress_documents(
        docs,
        query,
        callbacks=run_manager.get_child(),
    )
    return list(compressed_docs)
return []
```

压缩器可以筛除文档、提取片段或重排，具体工作与成本由实现决定；不是每个压缩器都会再调用语言模型。交叉编码器重排会联合处理问题与候选正文，与分别编码再算相似度的向量检索不同。

这个包装器的重要交接点是 query 没有丢失。只把检索结果列表传给一个固定问题的过滤函数，会让不同用户问题共用错误判据。压缩后还应保留来源和必要前提，避免删除否定词、限制条件或引用信息。

## 七、用证据标识比较每一步的收益

评估应将原始问题、可接受证据 ID、文档版本与权限范围绑定。改变切分方式后，同一证据可能对应不同 chunk_id，比较前需要明确是按切片、父文档还是原始条款标注。

| 指标 | 含义 | 需固定的口径 |
| --- | --- | --- |
| Hit@k | 前 k 项是否至少命中一份标注证据 | 按问题统计比例，未命中为 0 |
| MRR@k | 首个相关结果的倒数排名再取平均 | 未在前 k 出现的查询按 0 计入 |
| Recall@k | 标注相关证据中有多少被召回 | 一个问题可能需要多份证据，不能用 Hit 代替 |
| nDCG@k | 带相关度等级的折损排序收益 | 相关度映射、截断位置与无相关证据的处理 |

这些是应用的评估口径，不是上述类自动产出的分数。除了检索指标，还要记录改写调用数、查询扇出、最终正文长度、时延以及答案是否被证据支持。

先保留基础检索的逐问题结果，再只改变一个阶段。MultiQuery 可能提升覆盖却增加噪声，MMR 可能减少重复却排开近似证据，父文档回查可能补全条件却挤占上下文。选择应依据具体失败集与代价。

返回 list[Document] 的 LCEL 组合可以作为可调用的检索流程使用，但不会因此自动变为 BaseRetriever 实例；需要其类型契约或检索回调时，再提供相应适配。组件输入输出的基础链路见 [12](12-rag-components-and-retrieval.md)。
