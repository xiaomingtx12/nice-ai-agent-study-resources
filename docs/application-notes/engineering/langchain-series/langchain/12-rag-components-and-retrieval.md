---
sidebar_position: 14
sidebar_label: 12 RAG 组件与检索链路
description: 沿 Loader、Document、TextSplitter、Embeddings、VectorStore 与 Retriever 的真实数据流，分清 RAG 基础组件各自负责的转换和边界。
---

# LangChain 源码 12：RAG 组件与检索链路

## 源码定位

> **阅读基线**：`langchain-core` 1.4.6、`langchain-text-splitters`。  
>
> **核心路径**：
>
> - **RAG 的入口边界**：`libs/core/langchain_core/document_loaders/base.py`——`BaseLoader.load()` / `lazy_load()` / `load_and_split()` 在这里分层，正文一节说明 Loader 交付什么而不绑定文件格式。
> - **贯穿索引与检索的数据容器**：`libs/core/langchain_core/documents/base.py`——`Document` 的 `page_content`、`metadata`、`id` 与 `__str__` 兼容逻辑在这里定义，正文二节对应。
> - **切分的实现与选择**：`libs/text-splitters/langchain_text_splitters/{base.py,character.py}`——`TextSplitter._merge_splits()` 的 overlap 规则和 `RecursiveCharacterTextSplitter` 的递归分隔符退化在正文三节展开。
> - **文档与查询的双通道协议**：`libs/core/langchain_core/embeddings/embeddings.py`——`embed_documents` / `embed_query` 在这里定义，正文四节用它说明写入与搜索分别编码。
> - **检索的存取与可读实现**：`libs/core/langchain_core/vectorstores/{base.py,in_memory.py}`——`VectorStore.as_retriever()` 在抽象里，`InMemoryVectorStore` 提供从 Document 到相似度结果的完整路径，正文四、五节对应。
> - **RAG 的出口**：`libs/core/langchain_core/retrievers.py`——`BaseRetriever.invoke()` 把查询收敛为 `list[Document]`，正文五节说明它为何是 Runnable、为何不一定来自向量库。

RAG 的基础链路不是"把文件塞进向量库"。它是一串类型转换：

- 外部数据先成为带 metadata 的 `Document`；
- 再变成可检索的 chunk（切片）；
- 文档与查询分别被 Embedding 映射为向量；
- VectorStore 完成存取与相似度搜索；
- Retriever 最终把查询收敛为 `list[Document]`。

```text
外部数据
  → Loader
  → list[Document]
  → TextSplitter
  → chunks: list[Document]
  → Embeddings + VectorStore
  → Retriever
  → list[Document]
  → Prompt / Tool / Agent 上下文
```

每一箭头都应有可独立评估的输入输出。把"召回不准"笼统归咎于向量库，会掩盖解析、切分、metadata、query、过滤和重排中的真实问题。

## 一、Loader：外部数据到 `Document`

`BaseLoader` 的核心是 `lazy_load()`：实现应以生成器逐个产出 `Document`，避免大数据源被一次性读入内存。

- `load()` 只是 `list(self.lazy_load())` 的便利方法；
- `aload()` 对应异步迭代入口。

```python
documents = loader.load()
# 外部文件 / 网页 / 数据库记录 → list[Document]；
# 此时还没有切分、向量化或任何"检索语义"。
```

`BaseLoader.load_and_split()` 虽仍存在，但源码明确标为 deprecated（已弃用）；它默认偷偷创建 `RecursiveCharacterTextSplitter`。实际应用应显式选择 Loader 与 Splitter，才能记录 chunk 参数并针对数据类型评估效果。

具体 Loader 多数不在当前 `langchain-core` 快照内，而由 community 或 provider 集成包实现。这是包边界，不是 RAG 管道缺失：core 只规定 Loader 交付 `Document` 的方式。

## 二、`Document`：保留文本与来源，而不是消息

`Document` 的主体是 `page_content`，并继承 `BaseMedia` 的 `metadata` 与可选 `id`。它用于 retrieval workflow，不应和模型 Message 混用。

```python
from langchain_core.documents import Document

doc = Document(
    page_content="退款申请需在签收后七天内提交。",
    metadata={"source": "policy.md", "section": "refund"},
)
# page_content 是检索与后续 prompt 格式化的文本；
# metadata 承担来源展示、权限过滤、租户隔离等应用语义。
```

`Document.__str__()` 有意只格式化 `page_content` 与 `metadata`，避免后来加入 `id` 等字段时改变“把 Document 直接格式化进 prompt”的历史行为。这是兼容处理，不代表直接 stringify Document 就是生产 RAG 的最佳上下文拼装方式。

## 三、TextSplitter：原文到可召回 chunk

`TextSplitter.split_documents()` 取每份 Document 的文本和 metadata，交给 `create_documents()`；后者为每个 chunk 复制 metadata 并创建新的 `Document`。

这意味着 source 等属性能跟随切片，但"哪个 chunk 与前后文如何关联"仍要靠应用的 metadata 设计。

`RecursiveCharacterTextSplitter` 默认依次尝试：

```python
["\n\n", "\n", " ", ""]
# 优先在段落、行、词边界切；
# 当前分隔符仍无法满足 chunk_size 时，再递归退化到更细粒度。
```

```python
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=80,
)
chunks = splitter.split_documents(documents)
# Document → 更小的 Document；
# overlap 只是保留相邻文本，不会自动解决跨章节语义、表格或代码块边界。
```

`TextSplitter._merge_splits()` 会在长度达到上限时输出当前片段，并按 overlap 规则从缓冲区移除旧文本。

`chunk_size` 与 `chunk_overlap` 不是框架默认值就能替业务决定的参数：问答需要的证据粒度、文档结构、Embedding 模型和后续重排都会影响选择。

## 四、Embeddings 与 VectorStore：两条向量化路径

`Embeddings` 只规定两个同步抽象方法：

```python
embed_documents(texts: list[str]) -> list[list[float]]
embed_query(text: str) -> list[float]
# 文档与查询可能需要不同的 provider 端编码路径；
# 不应默认它们只是同一函数的不同参数名。
```

两个容易忽略的实现细节：

- 异步默认实现会把同步方法放进 executor（执行器）——只有 provider 集成自己重写异步方法时，才具有原生异步 I/O；
- Embedding 本身不是 Runnable——它描述的是向量计算协议，不是"任意输入接任意输出"的链式组件。

**向量缓存：`CacheBackedEmbeddings`**——在 Embedding 之上包一层缓存，避免重复计算相同文本的向量。它实现了 core 的 `Embeddings` 协议（`langchain_classic/embeddings/cache.py:108`），但类本身在 Classic 兼容层，不在 v1 主线：

```python
from langchain_classic.embeddings import CacheBackedEmbeddings
from langchain_classic.storage import LocalFileStore
from langchain_openai import OpenAIEmbeddings

store = LocalFileStore("./my_cache")

underlying_embedder = OpenAIEmbeddings()
embedder = CacheBackedEmbeddings.from_bytes_store(
    underlying_embedder, store, namespace=underlying_embedder.model
)

# 第一次计算并写入缓存；第二次相同文本直接从缓存读取
embeddings = embedder.embed_documents(["hello", "goodbye"])
```

机制要点（`cache.py:165-199`）：

- 文本先哈希成缓存 key（默认 SHA-1，源码明确警告它不抗碰撞，新应用应换 BLAKE2/SHA-256）；
- `embed_documents` 先 `mget` 查缓存，只对缺失的文本调底层 embedder，再 `mset` 批量回填——文档向量**默认缓存**；
- `embed_query` **默认不缓存**（无 `query_embedding_store` 时直接透传）——查询几乎不重复，缓存无收益还占存储。

**为什么它不在 v1 主线**：缓存协议（`BaseStore`）与哈希编码都属 Classic 层。v1 里若需要同样的效果，做法是自己在 `Embeddings` 实现外面套一层 cache-aside 逻辑，或直接使用集成包的缓存能力——协议允许，但没有内置封装器。

`VectorStore` 则定义文档写入与查询接口。`InMemoryVectorStore.add_documents()` 的实现能把数据路径看得很清楚：

1. 取出每个 `doc.page_content`；
2. 批量调用 `embedding.embed_documents(texts)`；
3. 保存 `id`、`vector`（向量）、原文本和 metadata。

查询时 `similarity_search_with_score()` 会先执行 `embed_query(query)`，再与已存向量计算余弦相似度并重建 `Document`。

```python
from langchain_core.vectorstores import InMemoryVectorStore

vector_store = InMemoryVectorStore(embedding=embeddings)
vector_store.add_documents(chunks)
# 写入时：Document 文本 → 文档向量；
# store 仍保留文本与 metadata，检索结果才能恢复成 Document。

hits = vector_store.similarity_search("退款期限", k=4)
# 查询文本 → 查询向量 → 相似度排序 → list[Document]。
```

生产环境的 Chroma、Qdrant 等实现通常位于伙伴集成包。换向量库不应改变上层 Retrieval 契约，但过滤语法、索引构建、距离度量和一致性保证仍是实现差异——不能完全当作可无代价替换。

## 五、Retriever：把“怎样找”藏到 `query -> Document[]` 后面

`VectorStore.as_retriever()` 创建 `VectorStoreRetriever`。它可选择 `similarity`、`similarity_score_threshold` 或 `mmr`，再在 `_get_relevant_documents()` 分派给底层向量库对应的搜索方法。

```python
retriever = vector_store.as_retriever(
    search_type="mmr",
    search_kwargs={"k": 4, "fetch_k": 20},
)

documents = retriever.invoke("退款申请什么时候截止？")
# str → list[Document]；
# Retriever 是 Runnable，能进入 LCEL，也能被包装为 Agent 工具。
```

`BaseRetriever` 的公开入口是 `invoke` / `ainvoke` / `batch` / `abatch`；自定义检索器实现 `_get_relevant_documents()` 即可。

它不要求底层一定是向量库：关键词、SQL、图数据库、企业搜索或混合检索都可返回相同的 `Document` 列表。

## 六、检索结果怎样回到模型

Retriever 的输出还不是答案。至少还要处理三件事：

1. **上下文格式化**：将多个 Document 变成可读文本，同时保留引用标识；
2. **预算控制**：按 token、得分、来源或权限截断，不能盲目拼全部 chunk（切片）；
3. **生成与引用**：Prompt 说明证据使用方式，应用决定是否展示 source（来源）、何时拒答或回退搜索。

两种组装方式：

- **确定链路**——这些步骤可用 [01：Runnable 抽象与 LCEL](./01-runnable-and-lcel.md) 组合；
- **自主检索**——如果模型需要自己判断"是否检索、查哪个知识库、是否继续调用其他工具"，则将 Retriever 包装为 Tool（工具），交由 [03：`create_agent()`](./03-create-agent-assembly.md) 的模型—工具循环调度。

## 七、RAG 故障定位：按数据边界排查

| 现象 | 优先检查的边界 | 常见误判 |
| --- | --- | --- |
| 资料根本没被检出 | Loader、metadata、写入是否完成 | 直接换模型或调大 `k` |
| 命中内容碎片化或缺前提 | Splitter、chunk overlap、文档结构 | 以为换向量库就会修复 |
| 相似但不回答问题 | Embedding/query、检索类型、metadata filter | 把“语义相似”当成“可回答” |
| 模型无视已召回资料 | 上下文格式、Prompt、token 预算 | 反复修改检索参数 |
| 检出不该看的资料 | metadata 过滤和访问控制 | 只在最终回答层隐藏来源 |

RAG 的每层都可替换，但替换前必须明确失败发生在“资料没变成正确 Document”“切分不保留所需语义”“检索排序不对”还是“正确证据没有进入模型视图”。

## 读完后应该能判断什么

- Loader、Splitter、Embedding、VectorStore、Retriever 的输入输出各是什么；
- 为什么 `Document` 是贯穿索引和检索的容器，却不应该直接等同于消息；
- `as_retriever()` 如何把向量库封装为 Runnable，以及为什么 Retriever 不一定来自向量库；
- `CacheBackedEmbeddings` 缓存什么、不缓存什么（文档向量缓存、查询向量默认不缓存），以及它为什么在 Classic 层；
- 为什么 `load_and_split()` 与 Classic 的一键 RAG chain 不应作为新项目主线；
- 应将 RAG 放在固定 LCEL 链里，还是包装成 Tool 交给 Agent，自主检索只在后者确有必要时引入。

本篇只覆盖基础链路。召回质量不够时的进阶手段——查询改写、混合检索、MMR 细节、父子切片、压缩重排与评估指标——在 [13：RAG 高级检索技术](./13-advanced-retrieval-techniques.md) 展开。
