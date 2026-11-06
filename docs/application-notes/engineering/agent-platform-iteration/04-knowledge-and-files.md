---
sidebar_position: 4
sidebar_label: 04：知识库与文件
description: 知识库与文件处理模块纵线：原型里的 unstructured 解析、Weaviate 语义检索与 jieba 关键词表，重建阶段的 Celery 索引链路，以及现状的 Embedding 指纹防混检、混合检索、文档与片段在线管理、工作区文件交付。
---
# 知识库与文件处理：从关键词表到 Embedding 指纹

知识库对应总览「共同的功能模块」矩阵里的知识库/RAG 一行，文件上传与解析在外围四块里。这条线对应「数据与交付」那组难题：RAG 链路的工程化（解析、切片、索引的失败记录与增量更新）和跨存储一致性。迭代的主旋律不是换技术——Weaviate、jieba、unstructured 从原型一路用到现状——而是把「能检索」升级成「可运营」：状态可追踪、混检可防、命中可观测、交付可验证。

> **本篇弧线**
>
> - **初识**：五张表的数据分工，unstructured 解析，语义与关键词两路检索
> - **重建**：Celery 异步阶段化的索引链路
> - **现状**：Embedding 指纹防混检、混合检索、文档与片段在线管理、工作区副本与显式交付

## 一、核心工程问题：跨存储的链路怎么可运营

知识库这条线的核心技术没换过——Weaviate、jieba、unstructured 从原型一路用到现状——真正要解决的工程问题是可运营：一条跨关系库、向量库、对象存储的异步链路，出了问题能定位、混了空间能拒绝、命中了能统计、交付了能验证。三个子问题贯穿全文：

- **异步链路的状态可见**。解析到索引四阶段异步推进，任何一步失败都必须落库成状态与错误，不能只活在 Worker 日志里（第三节）。
- **跨存储一致性的诚实边界**。三个存储之间没有分布式事务，靠分阶段更新与错误状态兜底，重试前要核对已写入的片段——不宣称原子提交（第四节）。
- **检索与交付的正确性**。权限在服务端入口收敛（模型只提供 query）、Embedding 指纹拒绝跨空间混检、命中写 DatasetQuery 并累加 hit_count；交付走副本与显式保存，revision 防并发覆盖（第四节）。

暗线是成熟度的判据：判断一个数据模块成熟，看的是「出了问题能定位」，不是「换了更新的组件」——原型链路完整但状态管理是弱项，现状补的全部是这一课。

## 二、初识：原型里的检索两路

### 1、数据分工

原型的对象模型把知识库拆成五张表，向量本体存在 Weaviate（原型依赖 `weaviate-client==4.10.4`、`langchain-weaviate==0.0.3`，向量访问走 LangChain 集成而不是自己的封装层）：

| 表           | 职责                         |
| ------------ | ---------------------------- |
| UploadFile   | 上传文件元数据与对象存储定位 |
| Dataset      | 账号归属与 Embedding 配置    |
| Document     | 处理规则与状态               |
| Segment      | 文本片段                     |
| KeywordTable | 全文检索的关键词索引         |

片段启停的过滤直接做进向量元数据——document_enabled 与 segment_enabled 是向量对象的属性，检索时在向量侧过滤。

### 2、解析：从 COS 到 LangChain Loader

`FileExtractor`（`api/internal/core/file_extractor/file_extractor.py`，unstructured 0.2 生态，`unstructured==0.16.15`）把上传文件从对象存储下载到临时目录，按扩展名分派给 `langchain_community` 的 Unstructured 系列 Loader——xlsx、pdf、md、html、csv、ppt、xml 各有对应实现，其余走通用 Loader 或 TextLoader。解析的产物是 LangChain Document 列表，切片与向量化在下游的知识库服务里完成。

### 3、语义检索与全文检索

语义检索器是 `BaseRetriever` 的薄包装（`api/internal/core/retrievers/semantic_retriever.py`，节选）：

```python
search_result = self.vector_store.similarity_search_with_relevance_scores(
    query=query,
    k=k,
    **{
        "filters": Filter.all_of([
            Filter.by_property("dataset_id").contains_any(
                [str(dataset_id) for dataset_id in self.dataset_ids]),
            Filter.by_property("document_enabled").equal(True),
            Filter.by_property("segment_enabled").equal(True),
        ]),
    }
)
```

两路检索器对照着看：

| 检索器            | 机制                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SemanticRetriever | langchain-weaviate 相似度检索，按 dataset_id 与启停元数据过滤，k 默认 4                                                                       |
| FullTextRetriever | 不用搜索引擎——jieba 抽前 10 个关键词，查数据库里的 KeywordTable（keyword 到 segment_id 列表的映射），按命中频率排序取前 k，再回库取片段正文 |

两路都返回 LangChain Document，上游无感知差别。原型的判断：链路完整、结构清晰，但状态管理是弱项——文档处理失败如何记录、片段编辑后索引如何同步、不同 Embedding 模型的向量能否混检，都没有机制层面的答案。

## 三、重建：异步阶段化的索引链路

重建阶段知识库按「文档处理、向量检索、对象存储」三块重写（现状 `weaviate_client==4.19.2`、`celery==5.6.2`）。索引构建改为 Celery 异步阶段化：文档任务把 ID 列表交给 `build_documents`，Worker 在 Flask 上下文里调用 `IndexingService.build_documents`：

1. `_parsing`：文件提取器取得文本，清掉控制字符与多余空白；
2. `_splitting`：按处理规则（分段器与清洗规则）切片，逐条落库为待处理片段——带稳定 node_id、位置序号与内容哈希；
3. `_indexing`：逐片段 jieba 提取至多 10 个关键词，合并进知识库关键词表（keyword 到片段 ID 集合的映射）；
4. `_completed`：向量入库按每批 10 条、5 个并发线程分批执行，每批成功才把该批片段置为完成并启用，批内失败该批片段置错误并禁用。

每个阶段更新 Document 状态与阶段时间；每个文档独立捕获构建失败，记录错误状态、停止时间与错误信息。HTTP 请求只负责提交任务，不用等整份文档向量化。文档启用与禁用也不再是改一个布尔列——先落库置位并写 600 秒缓存标记挡住并发请求，异步 Worker 逐片段更新向量元数据、按方向增删关键词表，整体失败把文档状态改回去（第四节展开同步链路）。

## 四、现状：指纹、混合检索与文件交付

### 1、检索入口的权限与指纹

现状检索的统一入口是 `search_in_datasets`（`internal/service/dataset/retrieval_service.py`，节选）：

```python
dataset_ids = [dataset.id for dataset in datasets]
fingerprints = {dataset.embedding_fingerprint for dataset in datasets}
if "" in fingerprints:
    raise ValidateErrorException("知识库尚未配置向量模型")
if len(fingerprints) != 1:
    raise ValidateErrorException("一次检索只能使用相同向量模型的知识库")
...
hybrid_retriever = EnsembleRetriever(
    retrievers=[semantic_retriever, full_text_retriever],
    weights=[0.5, 0.5],
)
```

入口先按账号过滤知识库归属，再校验 Embedding 指纹。指纹的语义值得展开：向量维度相同不代表坐标空间相同，换了 Embedding 模型的向量即使维度对上也是不可比的噪声。平台把这件事做成了物理隔离——向量 collection 按指纹命名（指纹前缀拼接集合名），不同模型的知识库根本不在同一个 collection 里，检索器绑定知识库时用第一个知识库的指纹定位 collection。所以一次检索只允许使用相同指纹的知识库，未配置与混用两种情况都在入口被显式拒绝；旧数据带 legacy 前缀的指纹回落到共享旧集合。

两路检索器的现状形态：semantic 在 Weaviate 侧按知识库 ID 列表过滤，同时要求文档与片段两个启用标志都为真（双开关语义），支持相似度阈值；full_text 是 jieba 对查询提至多 10 个关键词，查各知识库的关键词表收集命中片段、按命中频率排序取前 k 再回库取正文——不经过任何搜索引擎，得分记 0。两路都返回 LangChain Document，上游无感知差别，这是从原型保留下来的接口约定。

检索策略三选一——semantic、full_text、hybrid（EnsembleRetriever 以 0.5/0.5 权重融合两路再截断到 k）。命中之后按实际命中的知识库写 DatasetQuery 查询记录（一个知识库一次查询只存一条），并批量累加片段的 hit_count；无命中的查询不生成记录，所以它是命中统计而不是全量查询审计，这个边界文档里写得明确。

Agent 侧的接入用 `create_langchain_tool_from_search`：把已确定的账号、知识库与检索参数封装成工具，模型只提供 query，不负责也不允许决定可以访问哪个账号的知识库——权限在服务端入口收敛。

### 2、在线管理：片段的三存储同步

在线管理的事实基础是：一个片段同时存在于三处——PostgreSQL 记录（正文、关键词、内容哈希、状态、位置）、知识库关键词表（keyword 到片段 ID 集合）、Weaviate 向量（node_id 为向量主键，元数据带账号、知识库、文档、片段标识与文档/片段两个启用标志）。管理接口的每一步都在让三处保持一致，「可检索」等于双开关都开且三处都在。

文档侧的管理面：上传按扩展名白名单过滤，同批文件共享一条处理规则、拿到批次号，异步任务只携带文档 ID；前端按批次号轮询进度（总片段数与已完成片段数）。启停是「先落库、后异步同步」：置位后写缓存标记挡住并发，Worker 逐片段更新向量元数据、按启用方向增删关键词表——向量更新失败的片段单独置错误并禁用，整体失败则把文档状态改回去。删除同样异步：按文档 ID 在向量库批量删除、删片段行、清关键词；删除整个知识库时再带着指纹定位 collection 清掉向量记录。

片段侧的 CRUD 全部同步执行，规则围绕「少做无用功、失败不撒谎」：

- 新增限 1000 token、只有构建完成的文档可加，关键词缺省由 jieba 生成，向量写入带全套元数据，文档的字符与 token 统计随之重算；失败该片段置错误并禁用。
- 修改先比内容哈希——正文没变就不重算向量、不覆盖旧 node_id，只更新记录；关键词表不论变没变都先删后建；正文变了才用新向量覆盖原向量记录。
- 启停用分布式锁串行化同一片段的并发操作；两个启用标志是与的关系——文档禁用时片段启用也不进关键词表，向量元数据里的片段标志同步翻转。
- 删除按 node_id 删向量、按片段清关键词、删记录并重算文档统计。

原型遗留的三个没有答案的问题在这里都有了机制答案：处理失败如何记录靠状态机与逐文档捕获（第三节），片段编辑后索引如何同步靠三存储同步链路（本节），不同 Embedding 模型能否混检靠入口指纹校验与按指纹分库（上一节）。

### 3、跨存储一致性的诚实边界

:::note 跨存储一致性的诚实边界
PostgreSQL、Weaviate 与对象存储之间没有分布式事务。当前实现靠分阶段更新与错误状态处理故障：索引构建失败停在哪个阶段、重试时已有哪些片段，都要按 node_id 与失败阶段核对，不能假设重复提交一次任务就没有残留；删除知识库、编辑片段同样跨关系库与向量库。平台不把这套机制描述成原子提交或 exactly-once 索引。
:::

### 4、文件交付：副本与已保存文件分离

文件侧的迭代终点是工作区交付模型。运行装配创建空的本轮工作副本（`/workspace/`），普通文件工具与 Shell 编辑的是副本，不自动改变平台已保存文件；交付入口三个工具各司其职（`internal/core/agent_v2/execution/workspace_delivery.py`）：

| 工具                 | 行为                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_saved_files` | 查已保存文件元数据，不读正文                                                                                                                                        |
| `load_saved_file`  | 载入指定文件至当前副本，记录真实 revision；只下载选定文件，重复加载同一来源复用已加载副本（不从对象存储覆盖模型刚编辑的内容），目标位置已有别的文件则要求换目标路径 |
| `deliver_file`     | 显式保存指定产物，只读明确指定的文件、不扫描目录或推断该交付什么；成功才返回 saved，连同 revision、大小与摘要，页面用短期地址预览下载                               |

原生 write/edit 只改副本，不隐式交付。版本账本绑定到「具体副本路径加保存目标」的组合：重复加载同一来源复用已加载副本；没加载过的目标按 expected_revision 为 0 只允许新增。并发覆盖在两端被挡住：工具侧，加载到另一个目录不会让旧副本获得覆盖新版本的权限；存储侧，别的会话已保存新版本时本次提交冲突、不强行覆盖（`internal/repository/workspace_file_store.py`）。

存储侧的提交顺序是先算摘要、用唯一对象键上传新对象、作用域锁内校验版本与配额后提交元数据，元数据失败则尽力删除新对象。两个细节把并发覆盖挡死在对象层：每次保存生成全新的不可变对象键（随机标识加扩展名，不复用旧内容的键）——并发写各自写各的新对象，版本校验输掉的一方对象随后被尽力清理，对象存储里不会出现半个新半个旧的内容；版本与配额校验都在作用域 advisory 锁加行锁内按最新数据执行，同会话的写入串行、配额不能被并发绕过。删除同样按版本校验——旧执行删不掉别的执行刚更新的文件。平台侧无显式版本的写入另有内容级幂等：同摘要同类型直接返回现有记录。对象存储与关系库没有原子性，清理失败可能留下无引用对象，这部分靠 best-effort 清理兜底。

这套设计对应一个明确的取舍：显式交付让「文件已保存」对应一次可验证的工具结果，代价是临时脚本、缓存、中间文件不会自动成为用户交付物。

### 5、去留

解析、切片、索引、检索、交付全链路自持，没有交给框架的部分；向量的客户端与 Embedding 调用走 LangChain 生态与 Weaviate 官方库。

原型在这条线上留下的不只是代码骨架，还有两个一路保留下来的接口约定：两路检索器统一返回 LangChain Document，知识库检索对 Agent 暴露为单一工具——后来补上的指纹校验、命中统计、交付版本控制都是长在这两根骨架上的肉。

模块纵线的上一篇是[工作流引擎](./03-workflow-engine.md)，下一篇见[工具体系](./05-tool-system.md)，目录与状态见[专栏入口](./index.md)。
