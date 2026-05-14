# my-dify RAG 检索增强链路与会话记忆机制实现详解
## 1. 先说结论
这个项目里的 RAG 不是一个“单独的检索函数”，而是一条完整的数据生产与消费链路：

+ 数据生产侧：`UploadFile -> Document -> Segment -> KeywordTable/Weaviate`
+ 数据消费侧：`RetrievalService -> BaseTool -> Agent / Workflow`
+ 会话记忆侧：`TokenBufferMemory(短期) + Conversation.summary(长期)`

它的实现重点不在“调用了 LangChain/LangGraph”，而在于把下面几件事真正做成了工程能力：

1. 上传文件后，不是直接扔给向量库，而是先固化 `UploadFile / ProcessRule / Document / Segment` 这些中间态。
2. 检索不是只有语义检索，还同时维护了一份轻量倒排索引 `KeywordTable(JSONB)`，所以支持 `semantic / full_text / hybrid` 三种策略。
3. 召回结果不是匿名文本，而是带着 `dataset_id / document_id / segment_id / node_id` 元数据流动，所以能做片段回溯、命中统计和状态同步。
4. Embedding 不是每次都重新算，而是通过 `CacheBackedEmbeddings + RedisStore` 做缓存，查询和入库两边都能复用。
5. 对话记忆不是“把所有历史都塞给模型”，而是先做短期裁剪，再用异步摘要生成长期记忆，并在下一轮作为 `System Prompt` 的一部分注入。

如果面试官问“你们项目里的 RAG 和记忆到底怎么落地”，最稳的回答方式就是沿着这两条线讲：

+ RAG：上传 -> 解析 -> 切分 -> 关键词索引 -> 向量索引 -> 检索 -> 融合 -> 回写统计
+ Memory：消息落库 -> 短期历史裁剪 -> 长期摘要异步生成 -> 下一轮系统提示注入

---

## 2. 一张图看全链路
<!-- 这是一个文本绘图，源码为：flowchart TD
    A["前端上传文件"] --> B["UploadFileHandler.upload_file"]
    B --> C["CosService.upload_file + UploadFile表"]
    C --> D["DocumentHandler.create_documents"]
    D --> E["DocumentService.create_documents"]
    E --> F["ProcessRule表 + Document表 + batch"]
    F --> G["Celery: build_documents.delay"]
    G --> H["IndexingService.build_documents"]
    H --> I["FileExtractor.load 解析文件"]
    I --> J["ProcessRuleService + RecursiveCharacterTextSplitter 切分"]
    J --> K["Segment表落库"]
    K --> L["Jieba提关键词 -> KeywordTable(JSONB)"]
    K --> M["WeaviateVectorStore.add_documents"]
    M --> N["DashScopeEmbeddings + Redis缓存Embedding"]

    Q["用户提问"] --> R["RetrievalService.search_in_datasets"]
    R --> S["SemanticRetriever"]
    R --> T["FullTextRetriever"]
    S --> U["Hybrid: EnsembleRetriever(RRF)"]
    T --> U
    S --> V["LangChain Documents(带segment元数据)"]
    T --> V
    U --> V
    V --> W["combine_documents 拼接文本"]
    W --> X["Agent Tool / Workflow DatasetRetrievalNode"]

    Y["Message落库"] --> Z["TokenBufferMemory"]
    Y --> AA["ConversationService.summary异步摘要"]
    Z --> AB["短期历史 messages"]
    AA --> AC["Conversation.summary"]
    AB --> AD["AgentState.history"]
    AC --> AE["AgentState.long_term_memory"]
    AD --> AF["FunctionCallAgent/ReACTAgent"]
    AE --> AF -->
![](https://cdn.nlark.com/yuque/__mermaid_v3/febf606fa111d37ed0a4f16fbe5b7e1c.svg)

---

## 3. 先理解几个核心表，不然后面链路会混
## 3.1 知识库侧核心模型
| 模型 | 作用 | 关键字段 |
| --- | --- | --- |
| `UploadFile` | 上传文件的原始记录 | `id`, `key`, `extension`, `mime_type`, `hash` |
| `Dataset` | 知识库 | `id`, `name`, `description` |
| `ProcessRule` | 文档处理规则 | `mode`, `rule(JSONB)` |
| `Document` | 知识库里的文档 | `upload_file_id`, `process_rule_id`, `batch`, `status`, `enabled` |
| `Segment` | 文档切分后的知识片段 | `content`, `keywords`, `segment.id`, `node_id`, `hash`, `enabled`, `hit_count` |
| `KeywordTable` | 轻量倒排索引 | `dataset_id`, `keyword_table(JSONB)` |
| `DatasetQuery` | 检索日志 | `dataset_id`, `query`, `source`, `source_app_id`, `created_by` |


这里最关键的是 `Segment` 里同时有两个 ID：

+ `segment.id`：PostgreSQL 里的主键，用来查片段详情、做分页、做 hit_count、做片段回溯。
+ `segment.node_id`：向量库对象 ID，用来和 Weaviate 里的对象一一对应。

这两个 ID 同时存在，解决的是两个问题：

1. 关系型世界里要做管理、审计、分页、命中追踪。
2. 向量库世界里要做 add/update/delete 和过滤检索。

所以项目不是“只有一张 chunk 表”，而是把“业务主键”和“向量对象主键”分开了。

## 3.2 会话侧核心模型
| 模型 | 作用 | 关键字段 |
| --- | --- | --- |
| `Conversation` | 会话主记录 | `name`, `summary`, `invoke_from`, `created_by` |
| `Message` | 一轮问答 | `query`, `message(JSONB)`, `answer`, `status`, `total_token_count` |
| `MessageAgentThought` | 推理过程/工具调用/检索事件 | `event`, `thought`, `observation`, `tool`, `tool_input` |


这里和记忆最相关的是 `Conversation.summary`，它就是长期记忆的持久化落点，不是临时变量。

---

## 4. 上传到入库：RAG 数据生产链路是怎么跑起来的
## 4.1 第一步：上传文件，先只存原始文件，不立即建索引
前端第一跳不是直接进知识库，而是先调用 `UploadFileHandler.upload_file`：

+ 请求校验在 `UploadFileReq`
+ 单文件大小限制 `15MB`
+ 允许的知识库文件类型来自 `ALLOWED_DOCUMENT_EXTENSION`

当前允许的文档扩展包括：

+ `txt`
+ `markdown`
+ `md`
+ `pdf`
+ `html / htm`
+ `xlsx / xls`
+ `doc / docx`
+ `ppt / pptx`
+ `xml`
+ `csv`

`CosService.upload_file()` 做了三件事：

1. 校验扩展名是否合法。
2. 生成随机对象 key，上传到腾讯云 COS。
3. 在 `upload_file` 表落一条记录，保存 `name / key / size / extension / mime_type / hash`。

这一步的设计意义是：先把“原始文件”稳定保存下来，后续解析失败也能重试，不会因为解析过程出错把原始输入丢掉。

## 4.2 第二步：把上传文件绑定到知识库，并生成一份真实的处理规则
前端拿到 `upload_file_id` 之后，再调用 `DocumentHandler.create_documents()`。

请求体由 `CreateDocumentsReq` 校验，关键约束很具体：

+ `upload_file_ids` 必须是 UUID 数组
+ 一次最多上传 `10` 个文件
+ `process_type` 只能是 `automatic / custom`
+ 如果是 `custom`，必须显式传 `rule`

这里有一个非常适合面试讲的细节：

**所谓 automatic，不是一个黑盒智能切分器，本质上也是落成一份默认 **`ProcessRule`**。**

默认规则 `DEFAULT_PROCESS_RULE` 里写死了：

+ 预处理规则：
    - `remove_extra_space`
    - `remove_url_and_email`
+ 切分规则：
    - `separators`
    - `chunk_size = 500`
    - `chunk_overlap = 50`

也就是说，前端选择“自动模式”，后端并不是“自由发挥”，而是把它固化成一份可追溯的规则记录。

`DocumentService.create_documents()` 的主流程是：

1. 校验当前账号是否拥有这个 `dataset_id`。
2. 根据 `upload_file_ids` 查询 `UploadFile`，并再次过滤扩展名。
3. 生成一个 `batch` 批次号。
4. 创建 `ProcessRule` 记录。
5. 按顺序创建多条 `Document` 记录。
6. 调用 Celery 异步任务：`build_documents.delay([document.id ...])`。

这里返回给前端的不只是文档列表，还会返回 `batch`，后续前端轮询 `get_documents_status` 就靠它追踪进度。

## 4.3 第三步：真正的“上传-解析-切分-向量化”不在 Handler，而在 Celery 任务里
异步入口在 `internal/task/document_task.py`：

+ `build_documents(document_ids)` -> `IndexingService.build_documents(document_ids)`

`IndexingService.build_documents()` 是整条文档构建链路的总控。它对每个 `Document` 顺序执行四段：

1. `_parsing()`
2. `_splitting()`
3. `_indexing()`
4. `_completed()`

并且每一段都对应修改 `Document.status`：

+ `PARSING`
+ `SPLITTING`
+ `INDEXING`
+ `COMPLETED`
+ 异常时 `ERROR`

这就是为什么前端能看到非常细的构建状态，而不是只有“处理中/完成”。

## 4.4 解析：先把 COS 文件下载到本地临时目录，再走对应 Loader
解析真正落在 `FileExtractor.load()`：

1. 创建临时目录。
2. 通过 `CosService.download_file()` 把 COS 文件拉到本地。
3. `load_from_file(file_path)` 根据扩展名选择 Loader。

具体映射是：

+ Excel -> `UnstructuredExcelLoader`
+ PDF -> `UnstructuredPDFLoader`
+ Markdown -> `UnstructuredMarkdownLoader`
+ HTML -> `UnstructuredHTMLLoader`
+ CSV -> `UnstructuredCSVLoader`
+ PPT -> `UnstructuredPowerPointLoader`
+ XML -> `UnstructuredXMLLoader`
+ 其他 -> `UnstructuredFileLoader` 或 `TextLoader`

这说明这个项目的多格式接入不是“自己写解析器”，而是：

+ 文件存储：自己管
+ 文件提取：复用 `langchain_community.document_loaders + unstructured`

`IndexingService._parsing()` 在拿到 `lc_documents` 后，又做了一层文本清洗：

+ 清除异常控制字符
+ 修正异常符号
+ 统计 `character_count`

然后把 `Document.status` 改成 `SPLITTING`，并写入 `parsing_completed_at`。

## 4.5 切分：不是按字符粗暴切，而是把 token 计数函数注入给 TextSplitter
切分逻辑在 `IndexingService._splitting()`，核心调用是：

```python
text_splitter = self.process_rule_service.get_text_splitter_by_process_rule(
    process_rule,
    self.embeddings_service.calculate_token_count,
)
```

这里的重点是：

+ 使用的是 `RecursiveCharacterTextSplitter`
+ 但 `length_function` 不是默认的 `len`
+ 而是 `EmbeddingsService.calculate_token_count`

所以这个项目的 `chunk_size / chunk_overlap` 实际上是按 **token 近似长度** 生效，而不是纯字符长度。

这比“按 500 个字符切一刀”更适合后续给大模型喂上下文。

`ProcessRuleService` 又做了两件事：

1. `clean_text_by_process_rule()`  
根据预处理规则去空白、去 URL/邮箱。
2. `get_text_splitter_by_process_rule()`  
按 `rule["segment"]` 里的 `separators / chunk_size / chunk_overlap` 构造 splitter。

切分后，系统不会只保留内存里的 chunk，而是立刻把每个片段固化到 `segment` 表：

+ `content`
+ `character_count`
+ `token_count`
+ `hash`
+ `position`
+ `status = WAITING`
+ `node_id = uuid.uuid4()`

同时给每个 LangChain `Document` 的 `metadata` 补足：

+ `account_id`
+ `dataset_id`
+ `document_id`
+ `segment_id`
+ `node_id`
+ `document_enabled = False`
+ `segment_enabled = False`

这一步非常关键，因为后面的“检索结果追踪”“回写命中次数”“向量库删除/启用禁用同步”，全靠这份 metadata。

## 4.6 关键词索引：项目里的“关键词倒排检索”不是 ES，而是一张 JSONB 倒排表
`IndexingService._indexing()` 会对每个片段做关键词提取：

```python
keywords = self.jieba_service.extract_keywords(lc_segment.page_content, 10)
```

`JiebaService` 的实现非常直接：

+ 懒加载 `jieba.analyse`
+ 初始化停用词文件 `stopwords.txt`
+ `extract_tags(topK=10)`

提取结果会写回 `segment.keywords`，然后继续更新 `KeywordTable`。

`KeywordTable` 的结构不是一条记录一个关键词，而是：

```json
{
  "关键词A": ["segment_id_1", "segment_id_2"],
  "关键词B": ["segment_id_3"]
}
```

也就是说，它是一个 **按 dataset 维度维护的 JSONB 倒排索引表**。

所以这个项目的全文检索实现要非常准确地表述为：

+ 不是 PostgreSQL Full Text Search
+ 不是 Elasticsearch
+ 也不是 BM25 引擎
+ 而是 “`jieba` 提关键词 + `KeywordTable(JSONB)` 做轻量倒排映射 + `Counter` 做频次排序”

这就是代码里“关键词倒排检索”真正的实现方式。

## 4.7 向量化与入库：真正做向量计算的是 WeaviateVectorStore + CacheBackedEmbeddings
最终向量入库发生在 `IndexingService._completed()`。

它先把每个片段 metadata 的两个状态位改成 `True`：

+ `document_enabled = True`
+ `segment_enabled = True`

然后用 `ThreadPoolExecutor(max_workers=5)` 分批处理，每批 `10` 条 chunk：

```python
self.vector_database_service.vector_store.add_documents(chunks, ids=ids)
```

这里有两个关键点：

### 第一，项目没有手写“embedding = model.embed_documents(...)”这一步
`VectorDatabaseService.vector_store` 返回的是：

```python
WeaviateVectorStore(
    client=self.weaviate.client,
    index_name="Dataset",
    text_key="text",
    embedding=self.embeddings_service.cache_backed_embeddings,
)
```

也就是说：

+ 向量库接入是 `WeaviateVectorStore`
+ Embedding 提供者是 `cache_backed_embeddings`
+ `add_documents()` 时会自动触发 embedding 计算

项目自己做的是：

+ 组织片段元数据
+ 维护关系库状态
+ 提供可缓存的 embedding provider

### 第二，Redis 缓存是在 embedding 层生效，不是在向量库层生效
`EmbeddingsService.initialize_embeddings(account_id)` 做了这些事：

1. 读取用户自己的 `tongyi` API Key。
2. 初始化 `DashScopeEmbeddings(model="text-embedding-v1")`。
3. 用 `RedisStore(client=redis)` 创建底层存储。
4. 用 `CacheBackedEmbeddings.from_bytes_store(...)` 包一层缓存 embedding。

并且自定义了 `blake2b` key encoder：

```python
def blake2b_key_encoder(text: str) -> str:
    return hashlib.blake2b(text.encode(), digest_size=32).hexdigest()
```

所以重复文本的 embedding 不会每次都重新调远端模型。

这个缓存同时会影响两类场景：

+ 文档入库时 `add_documents()`
+ 查询时的相似度检索 embedding 计算

因为二者最终都依赖 `vector_store.embedding = cache_backed_embeddings`。

---

## 5. Redis 缓存 Embedding：项目里到底缓存了什么
这部分面试里很容易被追问，最好讲清楚。

## 5.1 缓存位置不在业务代码，而在 LangChain 的 CacheBackedEmbeddings
项目没有自己维护 `redis.get(text)` / `redis.set(vector)` 这种逻辑，而是把缓存责任交给：

+ `RedisStore`
+ `CacheBackedEmbeddings`

这意味着：

+ 业务层不关心向量如何序列化
+ 业务层只需要保证所有 embedding 请求都走同一个 `cache_backed_embeddings`

## 5.2 用户隔离靠的是“当前请求上下文的 embedding 实例”，不是 Redis key namespace
源码里用户上下文是通过 Flask `g.embeddings_account_id` 维护的：

+ `initialize_embeddings(account_id)` 会设置 `g.embeddings_account_id`
+ `embeddings` / `cache_backed_embeddings` 属性会从 `g` 里读取当前账号

但要注意一个具体实现细节：

**Redis 缓存 key 的生成只看文本内容，没有额外传 namespace。**

这意味着：

+ 当前账号选用哪个 embedding 实例，靠的是 `_embeddings_cache` 和 `g`
+ Redis 里对相同文本的 embedding 结果可以天然复用

从代码看，这是一个“更偏复用”的设计，而不是“严格按用户拆 Redis 命名空间”的设计。

## 5.3 检索路径和入库路径对 embedding 初始化的依赖不完全一样
检索工具 `RetrievalService.create_langchain_tool_from_search()` 在真正搜索前会显式调用：

```python
self.vector_database_service.embeddings_service.initialize_embeddings(account_id)
```

所以查询路径会主动确保 embedding 已初始化。

而文档构建路径里，`IndexingService._completed()` 在线程中只做了：

```python
g.embeddings_account_id = account_id
```

但没有在 `build_documents()` 里显式调用 `initialize_embeddings(account_id)`。

这说明一个很具体的工程事实：

+ 检索路径的前置条件更显式
+ 索引构建路径对 embedding 初始化存在隐式依赖

面试时如果你主动指出这一点，说明你不是停留在“会用框架”，而是真的读过代码。

---

## 6. 召回、融合与知识片段追踪：RAG 消费链路怎么跑
## 6.1 召回入口：所有知识库检索最终都进 `RetrievalService.search_in_datasets`
不管是：

+ 调试页的命中测试
+ App/Agent 里的知识库工具
+ Workflow 里的 `DatasetRetrievalNode`

最后都会复用 `RetrievalService.search_in_datasets()`。

它的输入参数非常清晰：

+ `dataset_ids`
+ `query`
+ `account_id`
+ `retrieval_strategy`
+ `k`
+ `score`
+ `retrival_source`
+ `source_app_id`

第一步先校验 dataset 权限，避免跨账号检索。

## 6.2 语义检索：Weaviate + score_threshold + enabled 过滤
`SemanticRetriever` 的实现基于 `WeaviateVectorStore.similarity_search_with_relevance_scores()`。

它会带三个过滤条件：

1. `dataset_id in dataset_ids`
2. `document_enabled == True`
3. `segment_enabled == True`

这意味着：

+ 文档禁用后，向量检索不会再命中
+ 片段禁用后，向量检索也不会再命中

并且每条结果会把相似度得分写回：

```python
lc_document.metadata["score"] = score
```

所以后面调试页能直接展示 score，不需要再次算一遍。

## 6.3 关键词倒排检索：`KeywordTable -> Counter -> Segment`
`FullTextRetriever` 的逻辑更像一个轻量倒排索引器：

1. 用 `jieba_service.extract_keywords(query, 10)` 提取 query 关键词。
2. 查询所有目标 dataset 的 `KeywordTable.keyword_table`。
3. 遍历倒排表，把命中的 `segment_ids` 汇总到 `all_ids`。
4. 用 `Counter(all_ids)` 统计频次。
5. 取出现频率最高的前 `k` 个片段。
6. 去 `segment` 表查出真实片段内容，再封装成 LangChain `Document`。

这个实现的特点很鲜明：

+ 优点：简单、成本低、依赖少、很适合中小规模知识库。
+ 局限：不是专业全文检索引擎，没有 BM25，也没有倒排 posting list 的高效结构。

所以你在面试里要准确说：

**我们项目支持关键词倒排检索，但实现是“轻量 JSONB 倒排表”，不是 Elasticsearch。**

另外，全文检索路径里 `score` 被固定成了 `0`，因为它不是语义相似度。

## 6.4 混合检索：不是自己手搓融合算法，而是直接复用 LangChain 的 `EnsembleRetriever`
混合检索代码是：

```python
hybrid_retriever = EnsembleRetriever(
    retrievers=[semantic_retriever, full_text_retriever],
    weights=[0.5, 0.5],
)
```

当前本地依赖里的 `EnsembleRetriever` 实现，使用的是：

+ `weighted Reciprocal Rank Fusion`

也就是加权 RRF。

所以这个项目里的“融合”实际上有两层：

### 第一层：检索结果融合
+ 语义检索和关键词检索各自先出一份结果
+ 再通过 `EnsembleRetriever` 做加权 RRF 融合排序

### 第二层：Prompt 上下文融合
拿到最终的 `documents` 后，不会再做二次 rerank，也不会做 citation 结构化拼装，而是直接：

```python
combine_documents(documents)
```

其实现就是：

```python
"\n\n".join([document.page_content for document in documents])
```

也就是说：

+ 当前项目有“检索层融合”
+ 没有“独立 reranker 模型”
+ 最后喂给 LLM 的是纯文本拼接结果

这个细节很重要，因为很多人说“混合检索 + 融合”，但讲不清到底融合发生在哪一层。

## 6.5 检索之后，还会做两件业务回写
`RetrievalService.search_in_datasets()` 在拿到召回结果后，还做了两件很业务化的事情：

### 1. 写 `DatasetQuery`
每次查询会按 dataset 维度记一条 `DatasetQuery`：

+ `query`
+ `source`
+ `source_app_id`
+ `created_by`

这让系统可以区分：

+ 调试命中测试 `HIT_TESTING`
+ 应用真实调用 `APP`

### 2. 批量更新 `Segment.hit_count`
召回到的所有 segment 会做一次 SQL bulk update：

```python
.values(hit_count=Segment.hit_count + 1)
```

所以知识片段的热度统计不是前端埋点，而是后端检索链路天然沉淀出来的。

## 6.6 知识片段追踪是怎么实现的
“知识片段追踪”这个词，面试里最怕讲成一句空话。

这个项目里它的真实落点是：

1. 切分时给每个 chunk 写 `segment_id / document_id / dataset_id / node_id`。
2. 检索返回的 `LCDocument.metadata` 保留这些字段。
3. `DatasetService.hit()` 再根据 `segment_id` 回查 `Segment` 和 `Document`。
4. 最终把下面这些信息一起返回给前端：
    - 文档名
    - 扩展名
    - 片段位置 `position`
    - 片段内容 `content`
    - 关键词 `keywords`
    - 命中次数 `hit_count`
    - 召回分数 `score`

所以它的实现不是“另有一套 tracing 系统”，而是依赖 **片段元数据设计 + 关系库回查**。

但也要把边界讲清楚：

+ 在调试命中测试接口里，片段追踪信息是完整的。
+ 在真正喂给 LLM 的 `combine_documents` 结果里，这些元数据被压平成纯文本了。

所以如果以后要做“答案级引用溯源”，还需要扩展输出格式，而不是直接复用当前 `combine_documents`。

---

## 7. 这套 RAG 如何同时服务 Agent 和 Workflow
## 7.1 App / Agent 路径：知识库被编译成一个 LangChain `BaseTool`
在 `app_service / web_app_service / openapi_service / wechat_service` 这些运行入口里，都会先构造工具列表。

如果 `app_config["datasets"]` 非空，就会执行：

```python
self.retrieval_service.create_langchain_tool_from_search(...)
```

这个方法内部定义了一个带 `args_schema` 的工具：

```python
class DatasetRetrievalInput(BaseModel):
    query: str
```

然后通过 `@tool(DATASET_RETRIEVAL_TOOL_NAME, args_schema=...)` 返回一个真正可执行的 `BaseTool`。

这个工具的职责很纯：

1. 初始化当前用户 embedding。
2. 调 `search_in_datasets()` 检索。
3. 用 `combine_documents()` 拼接结果。
4. 返回字符串给 Agent 观察。

所以在 Agent 视角里，知识库不是“内置特殊能力”，而是一个普通工具，只不过这个工具背后接的是 RAG。

`FunctionCallAgent._tools_node()` 里还会对这个工具做专门事件分流：

+ 普通工具 -> `AGENT_ACTION`
+ 知识库工具 -> `DATASET_RETRIEVAL`

这就是为什么前端或数据库里能把“知识库检索”单独显示出来。

## 7.2 Workflow 路径：复用同一个 RetrievalService，只是外层换成节点抽象
工作流里的知识库节点在：

+ `DatasetRetrievalNodeData`
+ `DatasetRetrievalNode`

这里的抽象很克制：

### 节点数据约束
`DatasetRetrievalNodeData` 强制规定：

+ 输入只能有一个
+ 输入名必须叫 `query`
+ 类型必须是 `string`
+ 必填
+ 输出固定叫 `combine_documents`

所以工作流画布里的知识库节点，不允许你随便改成多个输入或多个输出。

### 节点执行逻辑
`DatasetRetrievalNode.__init__()` 里并没有重新实现检索，而是继续调用：

```python
retrieval_service.create_langchain_tool_from_search(...)
```

也就是说：

+ Agent 用的是这个工具
+ Workflow 节点内部还是用的这个工具

本质上是 **同一个检索核心，两种编排外壳**。

这就是“统一工具抽象”的真正含义。

---

## 8. 文档和片段启停、删除是怎么保证检索一致性的
这部分很容易被忽略，但其实特别体现工程成熟度。

## 8.1 文档启用/禁用
`DocumentService.update_document_enabled()` 不会直接同步处理所有后续逻辑，而是：

1. 先改 `document.enabled`
2. 写 Redis 锁 `LOCK_DOCUMENT_UPDATE_ENABLED`
3. 投递 Celery 任务 `update_document_enabled.delay(document.id)`

后续由 `IndexingService.update_document_enabled()` 去做真正同步：

+ 更新 Weaviate 里所有相关对象的 `document_enabled`
+ 如果启用，则把片段重新加回 `KeywordTable`
+ 如果禁用，则从 `KeywordTable` 删除这些片段

语义检索靠 `document_enabled` 过滤，全文检索靠 `KeywordTable` 加减来保持一致。

## 8.2 片段启用/禁用
`SegmentService.update_segment_enabled()` 用的是另一把 Redis 锁：

+ `LOCK_SEGMENT_UPDATE_ENABLED`

它会同时更新三处：

1. PostgreSQL 的 `segment.enabled`
2. `KeywordTable`
3. Weaviate 的 `segment_enabled`

这说明项目并不是“数据库改了就算完”，而是非常明确地做了多存储同步。

## 8.3 删除文档 / 删除片段
删除也不是只删主表：

+ 删文档：删 `Segment`、删 `KeywordTable` 关联项、删 Weaviate 对象
+ 删片段：删 PostgreSQL 记录、删 `KeywordTable`、删 Weaviate 对象、重算文档字符数和 token 数

这套设计让知识库不是一次性导入后不可维护，而是支持持续运营的。

---

## 9. 短期记忆：`TokenBufferMemory` 到底做了什么
用户说“短期记忆基于 TokenBufferMemory 按 Token 上限动态裁剪历史消息”，在这个项目里是成立的，但要讲精确。

## 9.1 不是全量历史，而是先取最近 N 轮
在 `app_service / web_app_service / openapi_service / wechat_service` 里，都会先这样做：

```python
token_buffer_memory = TokenBufferMemory(...)
history = token_buffer_memory.get_history_prompt_messages(
    message_limit=app_config["dialog_round"],
)
```

这里的 `dialog_round` 来自应用配置，默认是 `3`。

所以第一层裁剪是：

+ 先只取最近 `dialog_round` 轮已完成问答

不是无限拉历史消息。

## 9.2 第二层才是 token 上限裁剪
`TokenBufferMemory.get_history_prompt_messages()` 的逻辑是：

1. 查询 `Message` 表，只取：
    - `conversation_id` 命中
    - `answer != ""`
    - `is_deleted == False`
    - `status == NORMAL`
2. 按 `created_at desc` 取最近 `message_limit` 条。
3. 再 reverse 回正序。
4. 每条 `Message` 转成：
    - `HumanMessage(query)`
    - `AIMessage(answer)`
5. 调 LangChain 的 `trim_messages(...)`：
    - `max_tokens = 2000`
    - `strategy = "last"`
    - `start_on = "human"`
    - `end_on = "ai"`

所以项目里的短期记忆，本质是一个两段式裁剪：

1. 轮次窗口裁剪
2. Token 上限动态裁剪

## 9.3 token 计数不是按模型 SDK，而是 `tiktoken` 通用计数
`TokenBufferMemory._count_tokens()` 的实现顺序是：

1. 优先 `cl100k_base`
2. 失败时退回 `gpt2`
3. 再失败时用 `字符数 / 4` 粗略估算

这意味着短期记忆裁剪是：

+ 尽量精确
+ 不完全依赖具体模型 SDK
+ 更偏通用近似计数

另外一个很细的点是：`TokenBufferMemory` 虽然持有 `model_instance`，但当前计数实现并没有直接使用它，而是用统一编码器。

如果面试官问“为什么不用模型自己的 tokenizer”，你可以回答：

+ 这里更强调统一、稳定、少依赖
+ 是一个工程上的通用近似方案

## 9.4 这套短期记忆最终怎么注入到 Agent
`FunctionCallAgent._long_term_memory_recall_node()` 会做两件事：

1. 构造 `SystemMessage`
2. 把 `history` 追加到系统消息后面
3. 再拼当前用户问题

所以最终给模型的消息顺序是：

1. 系统提示
2. 短期历史问答
3. 当前用户输入

这就是“上下文连续性”在代码里的真实落点。

---

## 10. 长期记忆：为什么是异步摘要，而不是同步塞更多历史
## 10.1 长期记忆持久化在 `Conversation.summary`
`Conversation` 表里有一个明确字段：

```python
summary = Column(Text, ...)
```

这不是缓存字段，而是数据库持久化字段。

对应 migration `b49796d9c797` 也能看到它是专门建出来的。

## 10.2 摘要生成触发时机：在一轮回答完成之后
`ConversationService.save_agent_thoughts()` 在处理 `QueueEvent.AGENT_MESSAGE` 时，会更新 `Message` 的最终答案和统计信息。

如果应用配置里：

```python
app_config["long_term_memory"]["enable"] == True
```

就会异步起线程执行：

```python
_generate_summary_and_update(...)
```

这个线程里再调用：

```python
ConversationService.summary(
    query,
    answer,
    conversation.summary,
    account_id,
    model_config,
)
```

## 10.3 摘要链本身是什么
摘要链很简单，但很典型：

```python
prompt = ChatPromptTemplate.from_template(SUMMARIZER_TEMPLATE)
summary_chain = prompt | llm | StrOutputParser()
```

输入是：

+ `summary`: 原有摘要
+ `new_lines`: 本轮 `Human + AI`

输出是：

+ 新的总结文本

所以它不是每轮重做全文总结，而是 **增量式摘要**。

这也是长期记忆成本低的关键原因。

## 10.4 用哪个模型生成摘要
如果有 `model_config`，就尽量加载应用配置里的模型：

```python
language_model_service.load_language_model(model_config, account_id)
```

如果没有，则回退到默认：

```python
{"provider": "tongyi", "model": "qwen-plus", "parameters": {}}
```

也就是说，长期记忆不是强绑某一个模型，而是优先复用当前应用模型配置。

## 10.5 为什么说它是“异步”的
因为摘要生成是在后台线程里跑的，不阻塞当前回答返回。

所以这套机制的用户体验是：

+ 当前轮回答先返回
+ 摘要随后异步刷新到 `Conversation.summary`
+ 下一轮再把新的 summary 注入给模型

这很重要，因为它直接解释了：

**长期记忆不会增强当前轮，只会增强下一轮。**

## 10.6 长期记忆最终怎么注入 Prompt
在每次 Agent 执行前，运行入口都会把：

```python
"long_term_memory": conversation.summary
```

塞进 Agent 状态。

然后 `FunctionCallAgent._long_term_memory_recall_node()` 会：

1. 如果启用了长期记忆，并且 `summary` 非空：
    - 先发布一个 `LONG_TERM_MEMORY_RECALL` 事件
2. 把 `long_term_memory` 填进：

```python
AGENT_SYSTEM_PROMPT_TEMPLATE.format(
    preset_prompt=...,
    long_term_memory=long_term_memory,
)
```

所以长期记忆不是以“历史消息”的形式注入，而是作为 **系统提示的一部分** 注入。

这和短期记忆的定位完全不同：

+ 短期记忆：保留原始对话轮次
+ 长期记忆：保留压缩后的用户画像/上下文摘要

---

## 11. RAG 与记忆在运行时如何统一到事件流和数据库
这部分很适合面试里体现“不是只会调模型 API”。

## 11.1 知识库检索事件可视化
当 Agent 调用知识库工具时，`FunctionCallAgent._tools_node()` 会发布：

+ `QueueEvent.DATASET_RETRIEVAL`

事件里会带：

+ `tool`
+ `tool_input`
+ `observation`
+ `latency`

随后 `ConversationService.save_agent_thoughts()` 会把这个事件持久化到 `MessageAgentThought`。

所以前端如果要做“推理过程可视化”，知识库检索本身就是有独立事件类型的。

## 11.2 长期记忆召回事件也可视化
Agent 在真正调用 LLM 前，如果读到了 `conversation.summary`，会发布：

+ `QueueEvent.LONG_TERM_MEMORY_RECALL`

它的 `observation` 就是当前长期记忆内容。

这意味着：

+ 前端可展示“本轮用了哪些长期记忆”
+ 后端也能在 `message_agent_thought` 里回放

## 11.3 最终消息和过程消息分开存
`Message` 表存的是：

+ 用户 query
+ 最终 answer
+ token 统计
+ 总耗时

`MessageAgentThought` 存的是：

+ 推理
+ 工具调用
+ 知识库检索
+ 长期记忆召回

这使得系统既能做聊天历史，也能做 reasoning replay。

---

## 12. 这套实现最值得在面试里讲的几个点
## 12.1 “automatic 模式”并不是魔法，而是默认规则模板
这说明你们没有把处理逻辑写死在前端，而是让每次文档导入都落成一份 `ProcessRule`，后续可追溯、可重跑、可扩展。

## 12.2 关键词倒排检索不是 ES，而是自己维护的轻量 JSONB 倒排表
这能说明：

+ 你知道它不是标准全文检索引擎
+ 你知道它适合什么规模
+ 你知道为什么成本低、落地快

## 12.3 `segment.id` 和 `segment.node_id` 分离，是片段追踪和向量库同步的关键
如果只有一个 ID，关系库和向量库的职责会缠在一起。

## 12.4 混合检索的“融合”发生在检索层，不是回答层
当前融合依赖 `EnsembleRetriever` 的 weighted RRF；喂给模型前只是简单拼接文本，没有单独 reranker。

## 12.5 短期记忆和长期记忆解决的是两个不同问题
+ `TokenBufferMemory` 解决最近轮次的原始上下文连续性
+ `Conversation.summary` 解决长会话成本膨胀和上下文漂移

如果只用前者，token 会不断上涨；如果只用后者，会丢掉最近轮次的细节。

## 12.6 这套系统是“关系库 + 向量库 + Redis + Celery”多存储协同，不是单一库就能解决
各自职责是：

+ PostgreSQL：主数据、状态机、追踪、统计
+ Weaviate：语义检索
+ Redis：Embedding 缓存、并发锁
+ Celery：异步构建与状态同步

---

## 13. 面试时最容易被追问的 10 个问题
## 13.1 你们项目里的“上传-解析-切分-向量化”具体在哪儿实现？
回答：

+ 上传：`UploadFileHandler + CosService`
+ 创建文档：`DocumentService.create_documents`
+ 异步总控：`document_task.build_documents -> IndexingService.build_documents`
+ 解析：`FileExtractor`
+ 切分：`ProcessRuleService + RecursiveCharacterTextSplitter`
+ 向量化：`VectorDatabaseService.vector_store.add_documents`

## 13.2 你们的切分是按字符还是按 token？
回答：

+ 切分器是 `RecursiveCharacterTextSplitter`
+ 但 `length_function` 注入的是 `EmbeddingsService.calculate_token_count`
+ 所以 `chunk_size / overlap` 按 token 近似生效

## 13.3 你们的关键词检索是不是 Elasticsearch？
回答：

+ 不是
+ 是 `jieba` 提关键词后，写到 `KeywordTable(JSONB)` 做轻量倒排
+ 查询时通过 `Counter` 统计命中频次

## 13.4 你们的 hybrid 是怎么做的？
回答：

+ 同时构造 `SemanticRetriever` 和 `FullTextRetriever`
+ 用 `EnsembleRetriever(weights=[0.5, 0.5])`
+ 本地依赖实现是 weighted reciprocal rank fusion

## 13.5 检索结果怎么追踪到原始文档片段？
回答：

+ 切分时写入 `segment_id / document_id / dataset_id / node_id` metadata
+ 检索回来先拿 metadata
+ 再用 `segment_id` 回查 `Segment / Document`

## 13.6 Redis 在这条链路里具体做了什么？
回答：

+ `CacheBackedEmbeddings + RedisStore` 缓存 embedding
+ Redis lock 保护 `KeywordTable` 更新、文档启停、片段启停

## 13.7 为什么既要短期记忆又要长期记忆？
回答：

+ 短期记忆保最近轮次原始语义
+ 长期记忆保会话摘要
+ 两者分别解决“细节连续性”和“成本控制”

## 13.8 长期记忆为什么异步生成？
回答：

+ 不阻塞当前回答
+ 在后台增量更新 `Conversation.summary`
+ 下一轮再注入系统提示

## 13.9 你们有没有做 citation？
回答：

+ 调试命中接口能回查到片段、文档、位置、score
+ 但当前真正喂给模型的是 `combine_documents` 纯文本
+ 严格意义上的答案级引用还需要继续扩展

## 13.10 这套实现有什么边界？
回答：

+ 关键词检索是轻量倒排，不是专业全文检索引擎
+ 当前没有独立 reranker
+ 代码里没有显式看到 Weaviate collection schema 创建逻辑，运行时默认依赖已有 `Dataset` collection

---

## 14. 最后给一个能直接复述的项目总结
如果让我用一段话总结这条实现，我会这样说：

> 我们项目把 RAG 做成了一条完整工程链路，而不是单点检索函数。文件先上传到 COS 并落 `UploadFile`，再通过 `DocumentService` 生成 `ProcessRule` 和 `Document` 记录，随后由 Celery 异步执行 `IndexingService` 完成解析、按 token 近似长度切分、`jieba + KeywordTable(JSONB)` 维护轻量倒排索引、再通过 `WeaviateVectorStore + CacheBackedEmbeddings(Redis)` 完成向量化和入库。检索侧统一走 `RetrievalService`，支持 `semantic / full_text / hybrid`，其中 hybrid 用 `EnsembleRetriever` 做加权 RRF 融合；每个召回片段都带 `segment_id / document_id / dataset_id / node_id` 元数据，所以可以做片段回查、命中统计和启停同步。会话记忆这块，短期记忆用 `TokenBufferMemory` 先按对话轮次取最近历史，再按 2000 token 动态裁剪；长期记忆则在回答结束后由 LLM 异步增量总结到 `Conversation.summary`，下一轮作为 `System Prompt` 的一部分注入，实现了上下文连续性、成本控制和对话稳定性的平衡。`
>

