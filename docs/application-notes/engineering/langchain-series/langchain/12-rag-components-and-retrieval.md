---
sidebar_position: 14
sidebar_label: 12 RAG 组件与检索链路
description: 沿 Document 切分、向量写入、查询编码和 Retriever 分派追踪 RAG 数据流，解释来源标识、缓存和模型上下文之间的边界。
---

# LangChain 源码解析 12：RAG 组件与检索链路

> 固定提交与已阅读测试见[源码基线](source-baseline.md)。

**源码定位**

> **阅读基线**：langchain 1.3.7、langchain-core 1.4.6、langchain-text-splitters 1.1.2、langchain-classic 1.0.8；仓库快照 `76c32db9b38dfc287c958dc2a914d4834f022c1c`。路径均相对 LangChain 仓库根目录。
>
> - 加载协议：`libs/core/langchain_core/document_loaders/base.py` → BaseLoader.load、lazy_load、alazy_load。
> - 文档容器：`libs/core/langchain_core/documents/base.py` → BaseMedia、Document。
> - 切分与 metadata 复制：`libs/text-splitters/langchain_text_splitters/base.py` → TextSplitter.create_documents、split_documents、_merge_splits。
> - 递归分隔：`libs/text-splitters/langchain_text_splitters/character.py` → RecursiveCharacterTextSplitter._split_text。
> - 向量协议：`libs/core/langchain_core/embeddings/embeddings.py` → Embeddings。
> - 写入与相似度查询：`libs/core/langchain_core/vectorstores/in_memory.py` → InMemoryVectorStore.add_documents、_similarity_search_with_score_by_vector。
> - 检索分派：`libs/core/langchain_core/vectorstores/base.py` → VectorStore.as_retriever、VectorStoreRetriever._get_relevant_documents。
> - Runnable 检索入口：`libs/core/langchain_core/retrievers.py` → BaseRetriever.invoke。
> - Classic 向量缓存：`libs/langchain/langchain_classic/embeddings/cache.py` → CacheBackedEmbeddings.embed_documents、embed_query、from_bytes_store。

## 一、用一条资料和一个问题区分索引与查询

RAG（检索增强生成）先找出能支持回答的资料，再将资料交给模型。以 policy.md 中的退货说明为例，系统需要保存条款正文、来源和版本；用户问“收货多久以后还能申请”时，再用问题检索对应条款。

这包含两条数据流：

```text
索引：外部资料 → Loader → Document → Splitter → 切片 → 文档向量与存储
查询：问题 → 查询向量 → 搜索 → Document 列表 → 证据格式化 → 模型回答
```

Document 是正文与元数据容器；Embeddings 负责把文本编码为向量；VectorStore 存取向量及相关文档；Retriever 将查询封装成返回文档列表的调用接口。检索完成还没有生成答案，也没有自动核实引用是否支持答案。

## 二、Loader 交付 Document，不负责检索

BaseLoader 建议子类实现 lazy_load，逐份产生 Document。load 与 aload 都会把结果收集为列表，下面是省略文档字符串后的实际方法：

```python
def load(self) -> list[Document]:
    return list(self.lazy_load())

async def aload(self) -> list[Document]:
    return [document async for document in self.alazy_load()]
```

因此调用 aload 不表示结果按文档逐项返回；需要增量消费时使用 alazy_load。默认异步加载也可能通过执行器调用同步实现，原生异步能力由具体 Loader 决定。

Document 的 page_content 保存文本，metadata 保存来源、章节、租户或版本等应用字段，id 可作为标识。metadata 中写入 tenant 并不会自动执行权限过滤；谁能看到资料，由检索与交付路径使用这些字段来决定。

load_and_split 仍保留在基类中，文档字符串明确建议视为弃用；未指定切分器时会创建 RecursiveCharacterTextSplitter。显式分开加载与切分，可以检查解析文本并记录切分配置，避免把解析错误误当成检索问题。

## 三、Splitter 怎样保留来源并生成切片

TextSplitter.split_documents 只提取原文与 metadata，再交给 create_documents：

```python
texts, metadatas = [], []
for doc in documents:
    texts.append(doc.page_content)
    metadatas.append(doc.metadata)
return self.create_documents(texts, metadatas=metadatas)
```

create_documents 遍历每段文本的切分结果，深复制 metadata，并创建新的 Document。以下摘录内层循环：

```python
for chunk in self.split_text(text):
    metadata = copy.deepcopy(metadatas_[i])
    if self._add_start_index:
        offset = index + previous_chunk_len - self._chunk_overlap
        index = text.find(chunk, max(0, offset))
        metadata["start_index"] = index
        previous_chunk_len = len(chunk)
    new_doc = Document(page_content=chunk, metadata=metadata)
    documents.append(new_doc)
```

原 Document.id 没有沿这段路径传给切片。若要稳定更新、去重或引用，应另外设计 source_id、版本和 chunk_id；只依赖入库时随机生成的 ID，重新切分后容易留下重复或过期记录。start_index 来自文本查找，也需要与解析后的原文对应。

RecursiveCharacterTextSplitter 默认尝试段落、换行、空格和字符级分隔。能放入目标长度的片段交给 _merge_splits 合并，过长片段再用更细分隔符递归。默认 length_function 是 len，因此 chunk_size 默认按字符计，不是 token 预算。

_merge_splits 输出一块后移除旧片段，使后续块保留一定重叠。重叠受片段边界影响，不承诺相邻块精确重复 chunk_overlap 个字符。自定义分隔符若无法继续拆分，也可能保留超长块；表格、代码与标题层级需要按文档类型评估。

## 四、文档写入与问题检索分别编码

Embeddings 定义 embed_documents 和 embed_query，两者允许采用不同的任务编码方式。它本身不继承 Runnable；Retriever 才负责把检索暴露为 Runnable 调用。

InMemoryVectorStore.add_documents 先批量编码正文。下面保留编码与存储循环，省略 ID 数量校验和迭代器准备：

```python
texts = [doc.page_content for doc in documents]
vectors = self.embedding.embed_documents(texts)
# ……校验 ids 并准备 id_iterator……
ids_ = []
for doc, vector in zip(documents, vectors, strict=False):
    doc_id = next(id_iterator)
    doc_id_ = doc_id or str(uuid.uuid4())
    ids_.append(doc_id_)
    self.store[doc_id_] = {
        "id": doc_id_,
        "vector": vector,
        "text": doc.page_content,
        "metadata": doc.metadata,
    }
```

显式 ids 优先，否则用 Document.id，再否则生成 UUID。同一个 ID 再写入会覆盖这个内存字典条目；它不是数据库事务或持久索引。metadata 在这里直接引用 doc.metadata，写入后原地修改该字典可能影响存储记录，需要稳定快照时由调用方管理副本。

查询先执行 embed_query，再调用 _similarity_search_with_score_by_vector。该方法取出全部记录、应用可选 filter，随后做余弦相似度计算并截取前 k 项：

```python
similarity = cosine_similarity([embedding], [doc["vector"] for doc in docs])[0]
# 按相似度降序取结果索引。
top_k_idx = similarity.argsort()[::-1][:k]
```

这里的 k 控制返回条数，不代表只比较 k 份文档。InMemoryVectorStore 对通过过滤的记录计算相似度，适合看清机制和小规模使用；其他向量库可能采用近似索引，并具有不同的更新一致性、过滤语法和距离定义。

文档与查询应使用兼容的向量空间。更换模型、维度或预处理后，需要重新构建对应索引；即使维度相同，也不能据此判断两个模型的向量可混用。

## 五、Retriever 把搜索方式变成统一调用

VectorStore.as_retriever 返回持有该向量库的 VectorStoreRetriever，不复制数据或建立新索引。它的 _get_relevant_documents 按 search_type 分派，以下摘录主体：

```python
kwargs_ = self.search_kwargs | kwargs
if self.search_type == "similarity":
    docs = self.vectorstore.similarity_search(query, **kwargs_)
elif self.search_type == "similarity_score_threshold":
    docs_and_similarities = self.vectorstore.similarity_search_with_relevance_scores(
        query, **kwargs_
    )
    docs = [doc for doc, _ in docs_and_similarities]
elif self.search_type == "mmr":
    docs = self.vectorstore.max_marginal_relevance_search(query, **kwargs_)
else:
    msg = f"search_type of {self.search_type} not allowed."
    raise ValueError(msg)
return docs
```

调用参数覆盖同名 search_kwargs。声明支持某个 search_type 不等于每个 VectorStore 都实现了对应方法，例如相关性分数转换或 MMR 仍可能由具体实现抛出未实现错误。

BaseRetriever.invoke 处理配置、回调和调用生命周期，再交给 _get_relevant_documents。结果是 list[Document]，可进入 LCEL 或包装成工具；关键词检索、SQL 和企业搜索同样能实现这个协议，并不要求底层一定有 Embeddings。

## 六、检索器怎样接进订单 Agent 的工具循环

`create_retriever_tool` 把返回文档列表的 Retriever 包装成 `StructuredTool`，即带名称、参数结构和执行函数的工具对象。教学场景中的 `search_return_policy` 可以采用这个入口：模型提供 query，检索器取回退货条款，再把正文作为工具结果交回模型。

源码为 `libs/core/langchain_core/tools/retriever.py`。下面保留其中同步闭包的完整执行逻辑，省略外层参数、异步闭包和工具对象构造：

```python
def func(
    query: str, callbacks: Callbacks = None
) -> str | tuple[str, list[Document]]:
    # 检索器返回原始 Document 列表，并向下传递回调。
    docs = retriever.invoke(query, config={"callbacks": callbacks})
    content = document_separator.join(
        format_document(doc, document_prompt_) for doc in docs
    )
    if response_format == "content_and_artifact":
        # 正文供模型阅读；原始文档另存为工具产物。
        return (content, docs)
    return content
```

外层默认文档模板只有 `{page_content}`，不会自动把 metadata 中的来源、条款版本和引用编号拼进正文。若希望模型引用政策版本，应用需要配置包含对应字段的 document_prompt，并确保每份文档都具备这些字段。

在 Agent 工具调用路径中，`BaseTool` 根据 `c_policy` 这样的 tool_call_id 将返回值包装成 ToolMessage；下一轮模型读取其 content。使用 `content_and_artifact` 时，原始 Documents 进入 artifact，便于应用继续做来源展示与核验；artifact 不默认发送给模型，但仍可能随消息进入状态或追踪，并非保密存储。

这里的 `response_format` 只决定工具返回值如何拆成 content 与 artifact。[14](14-structured-output-and-repair.md) 的 Agent response_format 则控制最终结构化结果，两处同名参数不能互相替代。检索到正确条款后，还需要结合 `lookup_order` 的订单事实判断条件；检索器不会自动批准 `submit_return`。

## 七、向量缓存缓存的是编码结果

CacheBackedEmbeddings 位于 langchain-classic 1.0.8，但实现的是 core 的 Embeddings 协议，可以与上述组件配合。它使用的 Store 抽象来自 core，不能因封装器属于 Classic 就推断整个缓存协议都属于 Classic。

embed_documents 先读取缓存中的向量，找出缺失位置，再按批次调用底层编码器并回填。以下是实际缺失处理，省略首次 mget 与最终返回：

```python
all_missing_indices: list[int] = [
    i for i, vector in enumerate(vectors) if vector is None
]
for missing_indices in batch_iterate(self.batch_size, all_missing_indices):
    missing_texts = [texts[i] for i in missing_indices]
    missing_vectors = self.underlying_embeddings.embed_documents(missing_texts)
    self.document_embedding_store.mset(
        list(zip(missing_texts, missing_vectors, strict=False)),
    )
    for index, updated_vector in zip(missing_indices, missing_vectors, strict=False):
        vectors[index] = updated_vector
```

from_bytes_store 将文本键转换为带 namespace 的哈希键并序列化向量。namespace 应覆盖模型、维度和会影响编码的配置；缓存层不会从文本自动识别模型已经升级。默认键算法使用 SHA-1 派生 UUID，也支持其他算法或自定义编码器。

查询缓存默认关闭，是否开启取决于查询重复率、更新策略与存储成本，不能预设查询永远不重复。向量缓存命中也不表示检索答案有效：文档权限、版本和正文可读性仍要在检索路径核对。

## 八、证据怎样进入模型，失败怎样定位

检索得到 Document 后，应用还需组织引用标识、正文和来源，并控制总输入长度。将文档转成文本不会自动验证证据内容，模型也可能忽视条件或引用错误条款。

| 现象 | 先检查哪份中间结果 |
| --- | --- |
| 目标材料完全没有命中 | Loader 输出、切片内容和入库 ID |
| 命中片段但缺少例外条件 | 原文章节边界、相邻块和父文档 |
| 内容相似但答非所问 | 查询向量、候选排序与实际证据标签 |
| 命中材料正确但回答错误 | 最终拼给模型的证据、指令和引用 |
| 出现过期或越权材料 | 版本删除策略、过滤条件和结果授权 |

metadata 是承载约束的数据，不会自行执行约束。InMemoryVectorStore 的 filter 接收 Callable[[Document], bool]；其他库常使用字典表达式，切换存储前应核对接口。只在最终回答隐藏来源，不能阻止未授权正文进入模型。

固定的检索与生成流程可用 [01](01-runnable-and-lcel.md) 的组合协议；模型需要自行决定何时检索时，再将检索器注册为 [03](03-create-agent-assembly.md) 中的工具。查询改写、融合与父子回查的源码见 [13](13-advanced-retrieval-techniques.md)。
