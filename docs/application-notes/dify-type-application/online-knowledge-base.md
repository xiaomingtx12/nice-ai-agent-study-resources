---
sidebar_position: 5
---

# 平台的 RAG 检索链路设计

如果平台想把“知识库”做成真正可用的能力，那它不能只有上传文档和展示片段。

放到这个项目里看，RAG 更像一条完整的知识生产链和检索消费链。

会话记忆我已经并回 [平台的核心 Agent 层](./core-agent-layer.md) 去讲，因为这个项目里的短期历史裁剪、长期摘要注入和摘要异步更新，本来就是 Agent 运行时装配的一部分，不属于这条知识生产链本身。

## 先说最关键的判断

这个项目里的 RAG 不是一个“单独的检索函数”，而是一条完整的生产链和消费链。

更准确地说，它做的是：

- 数据生产侧：`UploadFile -> Document -> Segment -> KeywordTable / Weaviate`
- 数据消费侧：`RetrievalService -> BaseTool -> Agent / Workflow`

所以这页真正要讲的，不只是“知识怎么检索”，而是平台怎样把文件、规则、片段、索引和检索工具接成一条可复用的知识链路。

## 为什么这一层要单独拆

RAG 一旦做成平台能力，就不能只关注“召回效果”。

它至少还要一起解决：

- 原始文件怎么入库
- 文档怎么切分和索引
- 检索结果怎么追踪回原始片段
- 检索能力怎么给 Agent 和 Workflow 共用

如果这些问题分散在上传逻辑、向量库调用和聊天服务里，平台后面会很难稳定演进。

## 我会把它拆成六个部分

### 1. RAG 先固化中间态，而不是直接把文件扔进向量库

这个项目很重要的一个判断是：上传文件不等于立刻建索引。

它先把文档处理链拆成一组明确中间态：

- `UploadFile` 记录原始文件
- `ProcessRule` 记录处理规则
- `Document` 记录知识库内的文档实体
- `Segment` 记录切分后的知识片段

这意味着平台先保存“原始输入”和“处理规则”，再异步去做解析、切分、向量化。

这样做的价值很直接：

- 解析失败可以重试，不会丢原始文件
- 自动模式也能被追溯成一份真实规则
- 前端可以看到文档构建进度，而不是只有“处理中 / 完成”

这里特别值得沉淀的一点是：所谓 `automatic` 模式并不是魔法，它本质上也是一份默认 `ProcessRule`。

这件事在真实代码里写得很直接：

```python
process_rule = self.create(
    ProcessRule,
    account_id=account.id,
    dataset_id=dataset_id,
    mode=process_type,
    rule=rule,
)

for upload_file in upload_files:
    position += 1
    document = self.create(
        Document,
        account_id=account.id,
        dataset_id=dataset_id,
        upload_file_id=upload_file.id,
        process_rule_id=process_rule.id,
        batch=batch,
        name=upload_file.name,
        position=position,
    )
    documents.append(document)

build_documents.delay([document.id for document in documents])
```

这里不是“上传后顺手建索引”，而是先固化 `ProcessRule + Document`，再把真正的构建扔给异步任务。

### 2. 索引不是只有向量索引，而是向量、关键词和片段元数据一起协作

文档进入切分阶段后，平台没有只做一件事。

它同时维护三类东西：

- 片段文本本身
- 关键词倒排索引
- 向量索引

这里的工程重点有三层。

第一层是切分不按纯字符粗暴裁。

项目用的是 `RecursiveCharacterTextSplitter`，但长度判断更接近 token 计数，而不是简单字符数。这让 `chunk_size / chunk_overlap` 更贴近后面真正喂给模型的上下文成本。

第二层是关键词检索不是 Elasticsearch。

这个项目用的是一张轻量的 `KeywordTable(JSONB)` 来维护倒排映射，再配合关键词抽取和频次统计做全文检索路径。它追求的不是搜索引擎能力的上限，而是平台内可控、轻量、可维护的混合检索底座。

第三层是片段元数据一路跟着走。

每个片段不仅有文本，还会带上：

- `dataset_id`
- `document_id`
- `segment_id`
- `node_id`

这件事非常关键，因为后面的命中统计、片段回溯、启停同步和向量库删除都依赖这层元数据。

这一层最值得直接贴代码，因为它把切分、中间态和元数据保留写得非常具体：

```python
text_splitter = self.process_rule_service.get_text_splitter_by_process_rule(
    process_rule,
    self.embeddings_service.calculate_token_count,
)

lc_segments = text_splitter.split_documents(lc_documents)

for lc_segment in lc_segments:
    position += 1
    content = lc_segment.page_content
    segment = self.create(
        Segment,
        account_id=document.account_id,
        dataset_id=document.dataset_id,
        document_id=document.id,
        node_id=uuid.uuid4(),
        position=position,
        content=content,
        character_count=len(content),
        token_count=self.embeddings_service.calculate_token_count(content),
        hash=generate_text_hash(content),
        status=SegmentStatus.WAITING,
    )
    lc_segment.metadata = {
        "account_id": str(document.account_id),
        "dataset_id": str(document.dataset_id),
        "document_id": str(document.id),
        "segment_id": str(segment.id),
        "node_id": str(segment.node_id),
        "document_enabled": False,
        "segment_enabled": False,
    }
```

所以这里真正被保留下来的不是“一个 chunk 字符串”，而是一个后面还能被追踪、统计、删除和同步的片段对象。

### 3. 检索不是单路召回，而是语义、关键词和融合策略共同完成

这个项目里的检索入口不是“随便查一下向量库”，而是统一走 `RetrievalService` 这类服务层收口。

平台支持的不是单一路径，而是三类检索策略：

- 语义检索
- 关键词检索
- 混合检索

混合检索最有价值的地方，不在“名字叫 hybrid”，而在于融合发生在检索层，而不是等模型回答时再模糊拼接。

这带来几个直接好处：

- 召回策略可以独立调优
- 语义和关键词两条链路都能保留
- 上层拿到的仍然是统一格式的片段结果

而且检索结束后，平台还不只是把文本扔给模型。

它还会继续做：

- `DatasetQuery` 这类查询记录
- 片段命中次数回写
- 结果片段追踪

所以检索结果在这里不是匿名文本，而是可追踪、可统计、可回溯的业务对象。

对应的检索服务代码也很能说明问题：

```python
semantic_retriever = SemanticRetriever(
    dataset_ids=dataset_ids,
    vector_store=self.vector_database_service.vector_store,
    search_kwargs={
        "k": k,
        "score_threshold": score,
    },
)
full_text_retriever = FullTextRetriever(
    db=self.db,
    dataset_ids=dataset_ids,
    jieba_service=self.jieba_service,
    search_kwargs={"k": k},
)
hybrid_retriever = EnsembleRetriever(
    retrievers=[semantic_retriever, full_text_retriever],
    weights=[0.5, 0.5],
)
```

```python
if retrieval_strategy == RetrievalStrategy.SEMANTIC:
    lc_documents = semantic_retriever.invoke(query)[:k]
elif retrieval_strategy == RetrievalStrategy.FULL_TEXT:
    lc_documents = full_text_retriever.invoke(query)[:k]
else:
    lc_documents = hybrid_retriever.invoke(query)[:k]

for dataset_id in unique_dataset_ids:
    self.create(
        DatasetQuery,
        dataset_id=dataset_id,
        query=query,
        source=retrival_source,
        source_app_id=source_app_id,
        created_by=account_id,
    )
```

这说明平台并不是“查一下向量库然后结束”，而是把检索策略、查询记录和后续统计都收到了同一个服务里。

### 4. 检索先统一走服务层，后面才能继续 Tool 化

如果知识库只能在某一个聊天入口里调用，它还不算平台能力。

这个项目真正做对的一点，是先把检索收口到统一服务，再继续往上抽成统一工具能力。

在 Agent / App 路径里，知识库检索会被编译成一个 `BaseTool`，这样 Agent 看待它的方式就和看待普通插件工具、工作流工具类似。

在 Workflow 路径里，平台并没有另造一套检索引擎，而是复用同一套 `RetrievalService`，只是外层换成节点抽象。

这一步非常重要，因为它说明平台统一的不是“页面入口”，而是“运行时能力”。

于是 RAG 在系统里的位置就不再是一个附属模块，而是能被不同执行层复用的上下文工具。

### 5. RAG 最后必须 Tool 化，不然它只是后台接口

这个项目真正做对的一点，是没有把知识库能力锁死在“知识库页面”里。

它把检索继续包成了统一工具，这样 Agent 和 Workflow 都可以拿同一条知识链路：

```python
class DatasetRetrievalInput(BaseModel):
    """知识库检索工具输入结构"""

    query: str = Field(description="知识库搜索query语句，类型为字符串")

@tool(DATASET_RETRIEVAL_TOOL_NAME, args_schema=DatasetRetrievalInput)
def dataset_retrieval(query: str) -> str:
    """如果需要搜索扩展的知识库内容，当你觉得用户的提问超过你的知识范围时，可以尝试调用该工具"""
    with flask_app.app_context():
        self.vector_database_service.embeddings_service.initialize_embeddings(account_id)
        documents = self.search_in_datasets(
            dataset_ids=dataset_ids,
            query=query,
            account_id=account_id,
            retrieval_strategy=retrieval_strategy,
            k=k,
            score=score,
            retrival_source=retrival_source,
            source_app_id=source_app_id,
        )

    if len(documents) == 0:
        return "知识库内没有检索到对应内容"

    return combine_documents(documents)
```

在工作流里，知识库节点也不是自己另写一套检索逻辑，而是复用同一个工具构造过程：

```python
self._retrieval_tool = retrieval_service.create_langchain_tool_from_search(
    flask_app=flask_app,
    dataset_ids=self.node_data.dataset_ids,
    account_id=account_id,
    **self.node_data.retrieval_config.dict(),
)

combine_documents = self._retrieval_tool.invoke(inputs_dict)
```

所以这里统一的不是“页面入口”，而是运行时能力。

### 6. 启停、删除和索引同步，决定它是不是可维护系统

真正的平台不会只关心“能检索到”，还要关心删改启停之后会不会脏。

这个项目在这里至少补了两层同步：

- 文档启用/禁用要同时改向量库和关键词表
- 文档删除要同时删关系数据、关键词表和向量索引

```python
for node_id in node_ids:
    collection.data.update(
        uuid=node_id,
        properties={
            "document_enabled": document.enabled,
        },
    )

if document.enabled is True:
    self.keyword_table_service.add_keyword_table_from_ids(
        document.dataset_id, enabled_segment_ids
    )
else:
    self.keyword_table_service.delete_keyword_table_from_ids(
        document.dataset_id, segment_ids
    )
```

```python
collection.data.delete_many(
    where=Filter.by_property("document_id").equal(document_id),
)

with self.db.auto_commit():
    self.db.session.query(Segment).filter(
        Segment.document_id == document_id,
    ).delete()

self.keyword_table_service.delete_keyword_table_from_ids(
    dataset_id, segment_ids
)
```

这部分很重要，因为它说明这条链路不是“索引建完就不管了”，而是已经把后续的状态一致性也考虑进去了。

## 这套 RAG 检索链路里最值得学的工程判断

### 1. 先固化中间态，再异步建索引

这样文档处理链路更可追踪，也更容易恢复失败任务。

### 2. 自动模式也要落成真实规则

只有这样，平台才不是黑盒。

### 3. 不只做向量检索，还保留轻量关键词路径

这让平台能更稳定地支撑语义、关键词和混合检索。

### 4. 片段元数据必须一路保留

否则后面的引用、追踪、统计和删除同步都会很脆。

### 5. 检索能力要 Tool 化

只有这样，知识库才是真正进入 Agent 和 Workflow 的统一运行时。

### 6. 启停、删除和索引同步必须闭环

否则平台很快就会出现数据库状态、关键词表和向量索引不一致的问题。

## 这一层最容易被讲浅的地方

很多人讲 RAG 时，只会说：

- 上传文件
- 切 chunk
- 做 embedding
- 查向量库

这只说到了中间一段。

真正更值钱的是下面这些问题有没有一起解决：

- 上传和索引是否解耦
- 自动处理规则是否可追踪
- 关键词和语义检索是否并存
- 结果能不能追溯到原始片段
- 检索能力能不能 Tool 化复用
- 启停、删除和索引同步是否闭环

这些问题没一起解决，通常还只是“有 RAG 功能”，还没有真正沉淀成平台里的上下文系统。

## 我现在的判断

这个项目里的 RAG 部分，最重要的不是“接了向量库”，而是它做出了几个对的平台选择：

1. 用 `UploadFile / Document / Segment / ProcessRule` 固化知识生产链
2. 用语义检索、关键词检索和融合策略搭出可控的消费链
3. 用 `BaseTool` 把知识库能力接进 Agent 和 Workflow
4. 用 `KeywordTable + Weaviate + Segment.metadata` 保留可追踪的检索中间态
5. 用状态同步和多存储协同把整条链路做成可治理系统

做到这一步，RAG 在这个平台里就不只是“查资料”，而是 Agent 上下文供给层的核心基础设施。
