# 自定义 AgentQueueManager 
## 1. AgentQueueManager 简介
### 1.1 什么是 AgentQueueManager
AgentQueueManager（智能体队列管理器）是项目中用于管理 Agent 执行过程中事件流的核心组件。它负责：

+ **事件发布**：Agent 执行过程中产生的各种事件（推理、工具调用、消息生成等）
+ **事件监听**：客户端通过流式接口实时接收 Agent 的执行状态
+ **任务控制**：支持停止正在执行的 Agent 任务
+ **超时管理**：自动检测和处理超时任务
+ **状态同步**：通过 Redis 实现分布式环境下的状态同步

### 1.2 为什么需要队列管理器
在 Agent 执行过程中，存在以下挑战：

1. **异步执行**：Agent 的执行是异步的，可能需要几秒到几分钟
2. **实时反馈**：用户需要实时看到 Agent 的推理过程和中间结果
3. **流式输出**：LLM 生成内容是流式的，需要逐字推送给用户
4. **任务控制**：用户可能需要中途停止 Agent 的执行
5. **分布式环境**：多个服务器实例需要共享任务状态

AgentQueueManager 通过队列机制优雅地解决了这些问题。

### 1.3 核心特性
+ **基于 Python Queue**：使用内存队列实现高性能的事件传递
+ **Redis 状态同步**：使用 Redis 实现分布式环境下的任务状态管理
+ **流式接口**：通过 Generator 实现流式事件推送
+ **自动超时检测**：内置超时机制，防止任务无限期挂起
+ **心跳机制**：定期发送 PING 事件，保持连接活跃
+ **优雅停止**：支持外部停止信号，安全终止任务

---

## 2. 核心概念与架构
### 2.1 整体架构
```plain
┌─────────────────────────────────────────────────────────────┐
│                        Client (前端)                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  SSE/WebSocket 连接                                   │  │
│  │  实时接收 Agent 执行事件                              │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            │ HTTP Stream
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                    Flask Server (后端)                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  AgentQueueManager.listen(task_id)                   │  │
│  │  └─> Generator 流式返回事件                          │  │
│  └──────────────────────────────────────────────────────┘  │
│                            │                                 │
│                            │ 监听队列                        │
│                            │                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Queue (内存队列)                                     │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ AgentThought 1 (长期记忆召回)                  │  │  │
│  │  │ AgentThought 2 (推理)                          │  │  │
│  │  │ AgentThought 3 (工具调用)                      │  │  │
│  │  │ AgentThought 4 (消息生成)                      │  │  │
│  │  │ AgentThought 5 (结束)                          │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│                            ▲                                 │
│                            │ 发布事件                        │
│                            │                                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Agent (FunctionCallAgent / ReACTAgent)              │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ preset_operation_node                          │  │  │
│  │  │   └─> publish(LONG_TERM_MEMORY_RECALL)        │  │  │
│  │  │                                                 │  │  │
│  │  │ llm_node                                       │  │  │
│  │  │   └─> publish(AGENT_THOUGHT)                  │  │  │
│  │  │   └─> publish(AGENT_MESSAGE)                  │  │  │
│  │  │                                                 │  │  │
│  │  │ tools_node                                     │  │  │
│  │  │   └─> publish(AGENT_ACTION)                   │  │  │
│  │  │   └─> publish(DATASET_RETRIEVAL)              │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           │ Redis 状态同步
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                      Redis (状态存储)                         │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ generate_task_belong:{task_id}                          │ │
│  │   → "account-{user_id}" (任务归属)                      │ │
│  │                                                          │ │
│  │ generate_task_stopped:{task_id}                         │ │
│  │   → "1" (停止标记)                                       │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件
#### 2.2.1 AgentQueueManager 类
```python
class AgentQueueManager:
    """智能体队列管理器"""
    user_id: UUID                    # 用户 ID
    invoke_from: InvokeFrom          # 调用来源（WEB_APP、DEBUGGER 等）
    redis_client: Redis              # Redis 客户端
    _queues: dict[str, Queue]        # 任务队列字典 {task_id: Queue}
```

**职责**：

+ 管理多个任务的队列
+ 发布和监听事件
+ 处理任务停止和超时
+ 与 Redis 交互同步状态

#### 2.2.2 Queue（Python 内存队列）
```python
from queue import Queue

# 每个任务对应一个独立的队列
task_queue = Queue()
```

**特性**：

+ **线程安全**：支持多线程并发访问
+ **阻塞操作**：`get()` 方法支持超时等待
+ **FIFO**：先进先出，保证事件顺序
+ **内存存储**：高性能，但不持久化

#### 2.2.3 Redis（分布式状态存储）
**存储的数据**：

1. **任务归属键**：`generate_task_belong:{task_id}`
    - 值：`account-{user_id}` 或 `end-user-{user_id}`
    - 过期时间：1800 秒（30 分钟）
    - 作用：标识任务属于哪个用户，用于权限验证
2. **任务停止键**：`generate_task_stopped:{task_id}`
    - 值：`1`
    - 过期时间：600 秒（10 分钟）
    - 作用：标记任务已被停止

### 2.3 数据流转过程
```plain
1. Agent 节点执行
   └─> 产生事件（如 LLM 生成内容）
       └─> agent_queue_manager.publish(task_id, AgentThought)
           └─> 事件放入 Queue
               └─> listen() 方法从 Queue 取出事件
                   └─> yield 返回给客户端
                       └─> 客户端实时显示
```

---

## 3. 队列事件系统
### 3.1 事件类型（QueueEvent）
```python
class QueueEvent(str, Enum):
    """队列事件枚举类型"""
    LONG_TERM_MEMORY_RECALL = "long_term_memory_recall"  # 长期记忆召回
    AGENT_THOUGHT = "agent_thought"                      # 智能体推理
    AGENT_MESSAGE = "agent_message"                      # 智能体消息
    AGENT_ACTION = "agent_action"                        # 智能体动作（工具调用）
    DATASET_RETRIEVAL = "dataset_retrieval"              # 知识库检索
    AGENT_END = "agent_end"                              # 智能体结束
    STOP = "stop"                                        # 停止
    ERROR = "error"                                      # 错误
    TIMEOUT = "timeout"                                  # 超时
    PING = "ping"                                        # 心跳
```

### 3.2 事件详解
#### 3.2.1 LONG_TERM_MEMORY_RECALL（长期记忆召回）
**触发时机**：Agent 开始执行时，如果启用了长期记忆功能

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.LONG_TERM_MEMORY_RECALL,
    observation="召回的长期记忆内容...",
)
```

**用途**：

+ 告知用户 Agent 正在使用历史对话摘要
+ 显示召回的记忆内容
+ 提升用户对 Agent 行为的理解

#### 3.2.2 AGENT_THOUGHT（智能体推理）
**触发时机**：LLM 决定调用工具时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.AGENT_THOUGHT,
    thought=json.dumps(tool_calls),  # 工具调用参数
    message=messages_to_dict(state["messages"]),
    message_token_count=input_token_count,
    answer_token_count=output_token_count,
    total_token_count=total_token_count,
    total_price=total_price,
    latency=execution_time,
)
```

**用途**：

+ 显示 Agent 的推理过程
+ 展示将要调用的工具和参数
+ 统计 token 消耗和成本

#### 3.2.3 AGENT_MESSAGE（智能体消息）
**触发时机**：LLM 生成文本内容时（流式）

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.AGENT_MESSAGE,
    thought=chunk_content,  # 流式内容片段
    answer=chunk_content,
    latency=execution_time,
)
```

**特点**：

+ **流式推送**：每生成一小段内容就推送一次
+ **相同 ID**：同一次生成的所有片段使用相同的 ID
+ **实时显示**：用户可以看到打字机效果

#### 3.2.4 AGENT_ACTION（智能体动作）
**触发时机**：Agent 调用工具（非知识库检索）时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.AGENT_ACTION,
    observation=json.dumps(tool_result),  # 工具返回结果
    tool=tool_name,                       # 工具名称
    tool_input=tool_args,                 # 工具输入参数
    latency=execution_time,
)
```

**用途**：

+ 显示工具调用的名称和参数
+ 展示工具返回的结果
+ 记录工具执行时间

#### 3.2.5 DATASET_RETRIEVAL（知识库检索）
**触发时机**：Agent 调用知识库检索工具时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.DATASET_RETRIEVAL,
    observation=json.dumps(retrieval_result),  # 检索结果
    tool="dataset_retrieval",
    tool_input={"query": "检索查询"},
    latency=execution_time,
)
```

**特点**：

+ 与 AGENT_ACTION 类似，但专门用于知识库检索
+ 可以在前端特殊展示（如高亮显示检索到的文档）

#### 3.2.6 AGENT_END（智能体结束）
**触发时机**：Agent 正常完成任务时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.AGENT_END,
)
```

**作用**：

+ 通知客户端 Agent 已完成
+ 触发队列停止监听
+ 客户端可以显示"完成"状态

#### 3.2.7 STOP（停止）
**触发时机**：用户主动停止任务时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.STOP,
)
```

**作用**：

+ 通知客户端任务已被停止
+ 触发队列停止监听
+ 客户端显示"已停止"状态

#### 3.2.8 ERROR（错误）
**触发时机**：Agent 执行过程中发生错误时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.ERROR,
    observation=str(error),  # 错误信息
)
```

**作用**：

+ 通知客户端发生错误
+ 显示错误详情
+ 触发队列停止监听

#### 3.2.9 TIMEOUT（超时）
**触发时机**：任务执行超过 600 秒（10 分钟）时

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.TIMEOUT,
)
```

**作用**：

+ 防止任务无限期挂起
+ 自动终止超时任务
+ 释放服务器资源

#### 3.2.10 PING（心跳）
**触发时机**：每 10 秒自动发送一次

**包含信息**：

```python
AgentThought(
    id=uuid.uuid4(),
    task_id=task_id,
    event=QueueEvent.PING,
)
```

**作用**：

+ 保持 HTTP 连接活跃
+ 防止代理服务器超时断开连接
+ 客户端可以显示"正在处理中"状态

### 3.3 事件数据结构（AgentThought）
```python
class AgentThought(BaseModel):
    """智能体推理观察输出内容"""
    # 基础信息
    id: UUID                          # 事件 ID
    task_id: UUID                     # 任务 ID
    event: QueueEvent                 # 事件类型

    # 推理与观察
    thought: str = ""                 # LLM 推理内容
    observation: str = ""             # 观察内容（工具返回结果等）

    # 工具相关
    tool: str = ""                    # 工具名称
    tool_input: dict = {}             # 工具输入参数

    # 消息相关（输入）
    message: list[dict] = []          # 推理使用的消息列表
    message_token_count: int = 0      # 消息 token 数
    message_unit_price: float = 0     # 消息单价
    message_price_unit: float = 0     # 价格单位

    # 答案相关（输出）
    answer: str = ""                  # LLM 生成的答案
    answer_token_count: int = 0       # 答案 token 数
    answer_unit_price: float = 0      # 答案单价
    answer_price_unit: float = 0      # 价格单位

    # 统计信息
    total_token_count: int = 0        # 总 token 数
    total_price: float = 0            # 总价格
    latency: float = 0                # 执行耗时（秒）
```

**字段说明**：

1. **id**：同一个事件的多次推送使用相同的 ID（如流式消息）
2. **task_id**：任务的唯一标识，用于区分不同的对话
3. **event**：事件类型，决定客户端如何处理
4. **thought**：LLM 的推理内容，如工具调用参数
5. **observation**：观察到的结果，如工具返回值
6. **tool** 和 **tool_input**：工具调用的详细信息
7. **message**：输入给 LLM 的消息列表
8. **answer**：LLM 生成的答案内容
9. **token 和 price 相关字段**：用于成本统计和展示
10. **latency**：执行耗时，用于性能分析

---

## 4. 核心功能详解
### 4.1 初始化（**init**）
```python
def __init__(
    self,
    user_id: UUID,
    invoke_from: InvokeFrom,
) -> None:
    """构造函数，初始化智能体队列管理器"""
    # 1. 初始化数据
    self.user_id = user_id
    self.invoke_from = invoke_from
    self._queues = {}

    # 2. 内部初始化 redis_client
    from app.http.module import injector
    self.redis_client = injector.get(Redis)
```

**参数说明**：

+ **user_id**：用户的唯一标识（Account ID 或 End User ID）
+ **invoke_from**：调用来源，用于区分不同的应用场景
    - `InvokeFrom.WEB_APP`：Web 应用
    - `InvokeFrom.DEBUGGER`：调试器
    - `InvokeFrom.ASSISTANT_AGENT`：助手 Agent
    - `InvokeFrom.SERVICE_API`：服务 API

**初始化流程**：

1. 保存用户 ID 和调用来源
2. 初始化空的队列字典
3. 通过依赖注入获取 Redis 客户端

**使用示例**：

```python
# 在 BaseAgent 中初始化
self._agent_queue_manager = AgentQueueManager(
    user_id=agent_config.user_id,
    invoke_from=agent_config.invoke_from,
)
```



### 4.2 监听队列（listen）
```python
def listen(self, task_id: UUID) -> Generator:
    """监听队列返回的生成式数据"""
    # 1. 定义基础数据记录超时时间、开始时间、最后一次 ping 通时间
    listen_timeout = 600  # 10 分钟超时
    start_time = time.time()
    last_ping_time = 0

    # 2. 创建循环队列执行死循环读取数据，直到超时或者数据读取完毕
    while True:
        try:
            # 3. 从队列中提取数据并检测数据是否存在
            item = self.queue(task_id).get(timeout=1)
            if item is None:  # None 表示停止监听
                break
            yield item  # 返回事件给客户端
        except queue.Empty:
            continue  # 队列为空，继续等待
        finally:
            # 4. 计算获取数据的总耗时
            elapsed_time = time.time() - start_time

            # 5. 每 10 秒发起一个 ping 请求
            if elapsed_time // 10 > last_ping_time:
                self.publish(task_id, AgentThought(
                    id=uuid.uuid4(),
                    task_id=task_id,
                    event=QueueEvent.PING,
                ))
                last_ping_time = elapsed_time // 10

            # 6. 判断总耗时是否超时
            if elapsed_time >= listen_timeout:
                self.publish(task_id, AgentThought(
                    id=uuid.uuid4(),
                    task_id=task_id,
                    event=QueueEvent.TIMEOUT,
                ))

            # 7. 检测是否停止
            if self._is_stopped(task_id):
                self.publish(task_id, AgentThought(
                    id=uuid.uuid4(),
                    task_id=task_id,
                    event=QueueEvent.STOP,
                ))
```

**功能详解**：

#### 4.2.1 核心循环
```python
while True:
    try:
        item = self.queue(task_id).get(timeout=1)
        if item is None:
            break
        yield item
    except queue.Empty:
        continue
```

**工作原理**：

1. **阻塞获取**：`get(timeout=1)` 会阻塞最多 1 秒等待队列中的数据
2. **超时继续**：如果 1 秒内没有数据，抛出 `queue.Empty` 异常，继续下一次循环
3. **停止信号**：如果获取到 `None`，表示停止监听，跳出循环
4. **流式返回**：使用 `yield` 返回事件，实现流式推送

**为什么使用 timeout=1**：

+ 避免无限期阻塞
+ 每秒检查一次超时和停止状态
+ 定期发送心跳包

#### 4.2.2 心跳机制
```python
# 每 10 秒发送一次 PING 事件
if elapsed_time // 10 > last_ping_time:
    self.publish(task_id, AgentThought(
        id=uuid.uuid4(),
        task_id=task_id,
        event=QueueEvent.PING,
    ))
    last_ping_time = elapsed_time // 10
```

**作用**：

1. **保持连接**：防止 HTTP 连接因长时间无数据而被代理服务器断开
2. **状态反馈**：告知客户端任务仍在执行中
3. **超时检测**：客户端可以根据 PING 间隔判断连接是否正常

**心跳间隔**：10 秒

+ 太短：增加网络开销
+ 太长：连接可能被断开

#### 4.2.3 超时检测
```python
listen_timeout = 600  # 10 分钟

if elapsed_time >= listen_timeout:
    self.publish(task_id, AgentThought(
        id=uuid.uuid4(),
        task_id=task_id,
        event=QueueEvent.TIMEOUT,
    ))
```

**超时策略**：

+ **超时时间**：600 秒（10 分钟）
+ **触发条件**：从开始监听到现在超过 10 分钟
+ **处理方式**：发送 TIMEOUT 事件，停止监听

**为什么需要超时**：

1. **防止资源泄漏**：避免任务无限期占用资源
2. **用户体验**：超过 10 分钟的任务通常不合理
3. **系统稳定性**：防止异常任务影响系统

#### 4.2.4 停止检测
```python
if self._is_stopped(task_id):
    self.publish(task_id, AgentThought(
        id=uuid.uuid4(),
        task_id=task_id,
        event=QueueEvent.STOP,
    ))
```

**检测机制**：

+ 每秒检查一次 Redis 中的停止标记
+ 如果发现停止标记，发送 STOP 事件
+ 停止监听，释放资源

**使用场景**：

+ 用户点击"停止"按钮
+ 系统管理员强制停止任务
+ 分布式环境下的任务控制

### 4.3 发布事件（publish）
```python
def publish(self, task_id: UUID, agent_thought: AgentThought) -> None:
    """发布事件信息到队列"""
    # 1. 将事件添加到队列中
    self.queue(task_id).put(agent_thought)

    # 2. 检测事件类型是否为需要停止的类型
    if agent_thought.event in [
        QueueEvent.STOP, 
        QueueEvent.ERROR, 
        QueueEvent.TIMEOUT, 
        QueueEvent.AGENT_END
    ]:
        self.stop_listen(task_id)
```

**功能详解**：

#### 4.3.1 事件入队
```python
self.queue(task_id).put(agent_thought)
```

**工作原理**：

1. 获取或创建任务对应的队列
2. 将事件对象放入队列
3. 如果有监听者在等待，立即返回事件

**线程安全**：

+ Python Queue 是线程安全的
+ 多个线程可以同时 `put()` 和 `get()`
+ 不需要额外的锁机制

#### 4.3.2 自动停止
```python
if agent_thought.event in [QueueEvent.STOP, QueueEvent.ERROR, QueueEvent.TIMEOUT, QueueEvent.AGENT_END]:
    self.stop_listen(task_id)
```

**停止事件**：

+ **STOP**：用户主动停止
+ **ERROR**：发生错误
+ **TIMEOUT**：执行超时
+ **AGENT_END**：正常结束

**停止流程**：

1. 发送停止事件到队列
2. 调用 `stop_listen()` 放入 `None` 标记
3. 监听循环收到 `None` 后退出

**使用示例**：

```python
# 在 Agent 节点中发布事件

# 1. 发布长期记忆召回事件
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    id=uuid.uuid4(),
    task_id=state["task_id"],
    event=QueueEvent.LONG_TERM_MEMORY_RECALL,
    observation=long_term_memory,
))

# 2. 发布推理事件
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    id=id,
    task_id=state["task_id"],
    event=QueueEvent.AGENT_THOUGHT,
    thought=json.dumps(tool_calls),
    total_token_count=total_token_count,
    total_price=total_price,
    latency=execution_time,
))

# 3. 发布流式消息事件
for chunk in llm.stream(messages):
    self.agent_queue_manager.publish(state["task_id"], AgentThought(
        id=id,  # 相同的 ID
        task_id=state["task_id"],
        event=QueueEvent.AGENT_MESSAGE,
        thought=chunk.content,
        answer=chunk.content,
        latency=time.perf_counter() - start_at,
    ))

# 4. 发布结束事件
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    id=uuid.uuid4(),
    task_id=state["task_id"],
    event=QueueEvent.AGENT_END,
))
```

### 4.4 发布错误（publish_error）
```python
def publish_error(self, task_id: UUID, error) -> None:
    """发布错误信息到队列"""
    self.publish(task_id, AgentThought(
        id=uuid.uuid4(),
        task_id=task_id,
        event=QueueEvent.ERROR,
        observation=str(error),
    ))
```

**功能**：

+ 简化错误发布的代码
+ 自动构造 ERROR 事件
+ 将错误信息转换为字符串

**使用示例**：

```python
try:
    result = llm.invoke(messages)
except Exception as e:
    # 发布错误事件
    self.agent_queue_manager.publish_error(
        state["task_id"],
        f"LLM 调用失败: {str(e)}"
    )
    raise
```

### 4.5 停止监听（stop_listen）
```python
def stop_listen(self, task_id: UUID) -> None:
    """停止监听队列信息"""
    self.queue(task_id).put(None)
```

**功能**：

+ 向队列中放入 `None` 标记
+ 监听循环收到 `None` 后退出
+ 释放资源

**调用时机**：

1. 发布停止类事件时自动调用
2. 外部主动停止任务时调用

### 4.6 获取队列（queue）
```python
def queue(self, task_id: UUID) -> Queue:
    """根据传递的 task_id 获取对应的任务队列信息"""
    # 1. 从队列字典中获取对应的任务队列
    q = self._queues.get(str(task_id))

    # 2. 检测队列是否存在，如果不存在则创建队列
    if not q:
        # 3. 添加缓存键标识
        user_prefix = "account" if self.invoke_from in [
            InvokeFrom.WEB_APP, 
            InvokeFrom.DEBUGGER, 
            InvokeFrom.ASSISTANT_AGENT,
        ] else "end-user"

        # 4. 设置任务对应的缓存键，代表这次任务已经开始了
        self.redis_client.setex(
            self.generate_task_belong_cache_key(task_id),
            1800,  # 30 分钟过期
            f"{user_prefix}-{str(self.user_id)}",
        )

        # 5. 将任务队列添加到队列字典中
        q = Queue()
        self._queues[str(task_id)] = q

    return q
```

**功能详解**：

#### 4.6.1 懒加载机制
```python
q = self._queues.get(str(task_id))
if not q:
    q = Queue()
    self._queues[str(task_id)] = q
```

**优点**：

+ 只在需要时创建队列
+ 节省内存资源
+ 支持多任务并发

#### 4.6.2 任务归属标记
```python
user_prefix = "account" if self.invoke_from in [
    InvokeFrom.WEB_APP, 
    InvokeFrom.DEBUGGER, 
    InvokeFrom.ASSISTANT_AGENT,
] else "end-user"

self.redis_client.setex(
    self.generate_task_belong_cache_key(task_id),
    1800,
    f"{user_prefix}-{str(self.user_id)}",
)
```

**Redis 键**：`generate_task_belong:{task_id}`

**值格式**：

+ `account-{user_id}`：内部用户（登录用户）
+ `end-user-{user_id}`：外部用户（API 调用）

**作用**：

1. **权限验证**：停止任务时验证用户身份
2. **任务追踪**：记录任务属于哪个用户
3. **分布式支持**：多个服务器实例共享任务状态

**过期时间**：1800 秒（30 分钟）

+ 任务通常在几分钟内完成
+ 30 分钟足够长，避免误删
+ 自动清理过期数据

### 4.7 设置停止标记（set_stop_flag）
```python
@classmethod
def set_stop_flag(cls, task_id: UUID, invoke_from: InvokeFrom, user_id: UUID) -> None:
    """根据传递的任务 id + 调用来源停止某次会话"""
    # 1. 获取 redis_client 客户端
    from app.http.module import injector
    redis_client = injector.get(Redis)

    # 2. 获取当前任务的缓存键，如果任务没执行，则不需要停止
    result = redis_client.get(cls.generate_task_belong_cache_key(task_id))
    if not result:
        return

    # 3. 计算对应缓存键的结果
    user_prefix = "account" if invoke_from in [
        InvokeFrom.WEB_APP, 
        InvokeFrom.DEBUGGER, 
        InvokeFrom.ASSISTANT_AGENT,
    ] else "end-user"
    
    if result.decode("utf-8") != f"{user_prefix}-{str(user_id)}":
        return  # 用户不匹配，无权停止

    # 4. 生成停止键标识
    stopped_cache_key = cls.generate_task_stopped_cache_key(task_id)
    redis_client.setex(stopped_cache_key, 600, 1)
```

**功能详解**：

#### 4.7.1 类方法设计
```python
@classmethod
def set_stop_flag(cls, task_id: UUID, invoke_from: InvokeFrom, user_id: UUID) -> None:
```

**为什么是类方法**：

+ 不需要 AgentQueueManager 实例
+ 可以在任何地方调用
+ 适合在 Service 层调用

**使用场景**：

```python
# 在 WebAppService 中停止任务
AgentQueueManager.set_stop_flag(
    task_id=task_id,
    invoke_from=InvokeFrom.WEB_APP,
    user_id=account.id,
)
```

#### 4.7.2 权限验证
```python
# 1. 检查任务是否存在
result = redis_client.get(cls.generate_task_belong_cache_key(task_id))
if not result:
    return  # 任务不存在或已完成

# 2. 验证用户身份
user_prefix = "account" if invoke_from in [...] else "end-user"
if result.decode("utf-8") != f"{user_prefix}-{str(user_id)}":
    return  # 用户不匹配，无权停止
```

**安全机制**：

1. **任务存在性检查**：防止停止不存在的任务
2. **用户身份验证**：只有任务所有者可以停止
3. **调用来源匹配**：确保调用来源一致

**防止的攻击**：

+ 用户 A 无法停止用户 B 的任务
+ 外部 API 无法停止内部用户的任务
+ 恶意停止请求被拒绝

#### 4.7.3 停止标记
```python
stopped_cache_key = cls.generate_task_stopped_cache_key(task_id)
redis_client.setex(stopped_cache_key, 600, 1)
```

**Redis 键**：`generate_task_stopped:{task_id}`

**值**：`1`（任意非空值）

**过期时间**：600 秒（10 分钟）

+ 停止标记不需要长期保存
+ 10 分钟足够监听循环检测到
+ 自动清理，避免 Redis 膨胀

### 4.8 检测停止状态（_is_stopped）
```python
def _is_stopped(self, task_id: UUID) -> bool:
    """检测任务是否停止"""
    task_stopped_cache_key = self.generate_task_stopped_cache_key(task_id)
    result = self.redis_client.get(task_stopped_cache_key)

    if result is not None:
        return True
    return False
```

**功能**：

+ 检查 Redis 中是否存在停止标记
+ 返回布尔值表示是否停止

**调用时机**：

+ 监听循环每秒检查一次
+ 发现停止标记后发送 STOP 事件

### 4.9 缓存键生成
```python
@classmethod
def generate_task_belong_cache_key(cls, task_id: UUID) -> str:
    """生成任务专属的缓存键"""
    return f"generate_task_belong:{str(task_id)}"

@classmethod
def generate_task_stopped_cache_key(cls, task_id: UUID) -> str:
    """生成任务已停止的缓存键"""
    return f"generate_task_stopped:{str(task_id)}"
```

**键命名规范**：

+ **前缀**：功能描述（`generate_task_belong`、`generate_task_stopped`）
+ **分隔符**：冒号（`:`）
+ **标识符**：task_id

**优点**：

+ 统一的命名规范
+ 易于理解和维护
+ 支持 Redis 键空间分析

---

## 5. 工作流程与时序图
### 5.1 完整执行流程
```plain
┌─────────┐                                                    ┌─────────┐
│ Client  │                                                    │ Server  │
└────┬────┘                                                    └────┬────┘
     │                                                              │
     │ 1. POST /chat (发起对话)                                    │
     │─────────────────────────────────────────────────────────────>│
     │                                                              │
     │                                                              │ 2. 创建 Agent
     │                                                              │    和 QueueManager
     │                                                              │
     │                                                              │ 3. 启动监听
     │                                                              │    listen(task_id)
     │                                                              │
     │ 4. SSE Stream 开始                                           │
     │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
     │                                                              │
     │                                                              │ 5. Agent 开始执行
     │                                                              │    (异步)
     │                                                              │
     │                                                              │ 6. 长期记忆召回
     │ 7. Event: LONG_TERM_MEMORY_RECALL                            │    publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │                                                              │ 8. LLM 推理
     │ 9. Event: AGENT_THOUGHT                                      │    publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │                                                              │ 10. 工具调用
     │ 11. Event: AGENT_ACTION                                      │     publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │                                                              │ 12. LLM 生成答案
     │ 13. Event: AGENT_MESSAGE (chunk 1)                           │     publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │ 14. Event: AGENT_MESSAGE (chunk 2)                           │     publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │ ...                                                          │
     │                                                              │
     │ 15. Event: AGENT_MESSAGE (chunk N)                           │     publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │                                                              │ 16. Agent 完成
     │ 17. Event: AGENT_END                                         │     publish()
     │<─────────────────────────────────────────────────────────────│
     │                                                              │
     │ 18. SSE Stream 结束                                          │
     │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
     │                                                              │
```

### 5.2 用户停止任务流程
```plain
┌─────────┐                    ┌─────────┐                    ┌─────────┐
│ Client  │                    │ Server  │                    │  Redis  │
└────┬────┘                    └────┬────┘                    └────┬────┘
     │                              │                              │
     │ 1. POST /stop (停止任务)     │                              │
     │─────────────────────────────>│                              │
     │                              │                              │
     │                              │ 2. 验证任务归属               │
     │                              │─────────────────────────────>│
     │                              │                              │
     │                              │ 3. 返回任务归属信息           │
     │                              │<─────────────────────────────│
     │                              │                              │
     │                              │ 4. 设置停止标记               │
     │                              │─────────────────────────────>│
     │                              │                              │
     │ 5. 返回停止成功               │                              │
     │<─────────────────────────────│                              │
     │                              │                              │
     │                              │ 6. 监听循环检测到停止标记      │
     │                              │<─────────────────────────────│
     │                              │                              │
     │ 7. Event: STOP               │                              │
     │<─────────────────────────────│                              │
     │                              │                              │
     │ 8. SSE Stream 结束           │                              │
     │<─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │                              │
     │                              │                              │
```

### 5.3 超时处理流程
```plain
时间轴：
0s    ────────────────────────────────────────────> 600s (超时)
│                                                    │
│ Agent 开始执行                                     │ 监听循环检测超时
│                                                    │
│ 正常事件流                                         │ 发送 TIMEOUT 事件
│ ├─ LONG_TERM_MEMORY_RECALL                        │
│ ├─ AGENT_THOUGHT                                  │ 停止监听
│ ├─ AGENT_ACTION                                   │
│ ├─ AGENT_MESSAGE                                  │ 客户端显示超时
│ └─ ...                                            │
│                                                    │
│ 每 10s 发送 PING                                   │
│ ├─ PING (10s)                                     │
│ ├─ PING (20s)                                     │
│ ├─ PING (30s)                                     │
│ └─ ...                                            │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 5.4 心跳机制流程
```plain
监听循环：

while True:
    ├─ 尝试获取事件 (timeout=1s)
    │  ├─ 有事件 → yield 返回
    │  └─ 无事件 → queue.Empty 异常
    │
    ├─ 计算已运行时间
    │
    ├─ 每 10s 发送 PING
    │  └─ if elapsed_time // 10 > last_ping_time:
    │      └─ publish(PING)
    │
    ├─ 检查超时 (600s)
    │  └─ if elapsed_time >= 600:
    │      └─ publish(TIMEOUT)
    │
    └─ 检查停止标记
       └─ if _is_stopped():
           └─ publish(STOP)
```

---

## 6. 实战应用场景
### 6.1 Web 应用对话场景
**场景描述**：用户在 Web 界面与 Agent 对话

**代码示例**：

```python
# web_app_service.py

def chat(self, app_id: UUID, query: str, account: Account) -> Generator:
    """Web 应用对话"""
    # 1. 创建任务 ID
    task_id = uuid.uuid4()
    
    # 2. 创建 Agent 配置
    agent_config = AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.WEB_APP,
        preset_prompt=app.preset_prompt,
        tools=tools,
        enable_long_term_memory=True,
    )
    
    # 3. 创建 Agent
    agent = FunctionCallAgent(
        agent_config=agent_config,
        llm=llm,
    )
    
    # 4. 异步执行 Agent
    def run_agent():
        agent.invoke({
            "messages": [HumanMessage(content=query)],
            "task_id": task_id,
            "iteration_count": 0,
            "history": history_messages,
            "long_term_memory": long_term_memory,
        })
    
    # 启动异步线程
    thread = threading.Thread(target=run_agent)
    thread.start()
    
    # 5. 监听队列，流式返回事件
    for event in agent.agent_queue_manager.listen(task_id):
        yield event
```

**前端处理**：

```javascript
// 使用 EventSource 接收 SSE 流
const eventSource = new EventSource('/api/chat');

eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.event) {
        case 'long_term_memory_recall':
            // 显示长期记忆召回
            showMemoryRecall(data.observation);
            break;
            
        case 'agent_thought':
            // 显示推理过程
            showThought(data.thought);
            break;
            
        case 'agent_message':
            // 流式显示消息
            appendMessage(data.answer);
            break;
            
        case 'agent_action':
            // 显示工具调用
            showToolCall(data.tool, data.tool_input, data.observation);
            break;
            
        case 'agent_end':
            // 对话结束
            eventSource.close();
            showComplete();
            break;
            
        case 'error':
            // 显示错误
            showError(data.observation);
            eventSource.close();
            break;
    }
};
```

### 6.2 调试器场景
**场景描述**：开发者在调试器中测试 Agent 配置

**代码示例**：

```python
# app_service.py

def debug_app(self, app_id: UUID, inputs: dict, account: Account) -> Generator:
    """调试应用"""
    task_id = uuid.uuid4()
    
    # 创建 Agent 配置（调试模式）
    agent_config = AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.DEBUGGER,  # 调试器来源
        preset_prompt=app.preset_prompt,
        tools=tools,
        enable_long_term_memory=False,  # 调试时不使用长期记忆
    )
    
    # 创建 Agent
    agent = FunctionCallAgent(
        agent_config=agent_config,
        llm=llm,
    )
    
    # 异步执行
    def run_agent():
        agent.invoke({
            "messages": [HumanMessage(content=inputs["query"])],
            "task_id": task_id,
            "iteration_count": 0,
            "history": [],
            "long_term_memory": "",
        })
    
    thread = threading.Thread(target=run_agent)
    thread.start()
    
    # 监听队列
    for event in agent.agent_queue_manager.listen(task_id):
        yield event
```

**调试器特点**：

+ 不使用长期记忆（每次都是全新对话）
+ 详细显示所有推理步骤
+ 支持修改配置后立即测试
+ 可以查看 token 消耗和成本

### 6.3 助手 Agent 场景
**场景描述**：智能助手应用，支持多轮对话

**代码示例**：

```python
# assistant_agent_service.py

def chat(self, assistant_id: UUID, query: str, account: Account) -> Generator:
    """助手对话"""
    task_id = uuid.uuid4()
    
    # 创建 Agent 配置
    agent_config = AgentConfig(
        user_id=account.id,
        invoke_from=InvokeFrom.ASSISTANT_AGENT,
        preset_prompt=assistant.system_prompt,
        tools=assistant_tools,
        enable_long_term_memory=True,
    )
    
    # 创建 Agent
    agent = FunctionCallAgent(
        agent_config=agent_config,
        llm=llm,
    )
    
    # 异步执行
    def run_agent():
        agent.invoke({
            "messages": [HumanMessage(content=query)],
            "task_id": task_id,
            "iteration_count": 0,
            "history": conversation_history,
            "long_term_memory": memory_summary,
        })
    
    thread = threading.Thread(target=run_agent)
    thread.start()
    
    # 监听队列
    for event in agent.agent_queue_manager.listen(task_id):
        yield event
```

### 6.4 停止任务场景
**场景描述**：用户在任务执行过程中点击停止按钮

**代码示例**：

```python
# web_app_service.py

def stop_chat(self, task_id: UUID, account: Account) -> None:
    """停止对话"""
    # 调用类方法设置停止标记
    AgentQueueManager.set_stop_flag(
        task_id=task_id,
        invoke_from=InvokeFrom.WEB_APP,
        user_id=account.id,
    )
```

**前端处理**：

```javascript
// 停止按钮点击事件
stopButton.onclick = async () => {
    await fetch('/api/stop', {
        method: 'POST',
        body: JSON.stringify({ task_id: currentTaskId })
    });
    
    // 关闭 EventSource
    eventSource.close();
    
    // 显示已停止状态
    showStopped();
};
```

---

## 7. 最佳实践与技巧
### 7.1 事件发布最佳实践
#### 7.1.1 使用相同 ID 标识同一事件
```python
# ✅ 推荐：流式消息使用相同 ID
id = uuid.uuid4()
for chunk in llm.stream(messages):
    self.agent_queue_manager.publish(state["task_id"], AgentThought(
        id=id,  # 相同的 ID
        task_id=state["task_id"],
        event=QueueEvent.AGENT_MESSAGE,
        answer=chunk.content,
    ))

# ❌ 不推荐：每次都生成新 ID
for chunk in llm.stream(messages):
    self.agent_queue_manager.publish(state["task_id"], AgentThought(
        id=uuid.uuid4(),  # 不同的 ID
        task_id=state["task_id"],
        event=QueueEvent.AGENT_MESSAGE,
        answer=chunk.content,
    ))
```

**原因**：

+ 前端可以根据 ID 判断是否是同一个事件
+ 方便实现打字机效果
+ 便于统计和分析

#### 7.1.2 及时发布事件
```python
# ✅ 推荐：立即发布事件
start_at = time.perf_counter()
result = tool.invoke(args)
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    event=QueueEvent.AGENT_ACTION,
    tool=tool_name,
    observation=result,
    latency=time.perf_counter() - start_at,
))

# ❌ 不推荐：延迟发布
results = []
for tool_call in tool_calls:
    result = tool.invoke(tool_call["args"])
    results.append(result)

# 所有工具执行完才发布
for result in results:
    self.agent_queue_manager.publish(...)
```

**原因**：

+ 用户可以实时看到进度
+ 提升用户体验
+ 便于调试和排查问题

#### 7.1.3 包含完整的统计信息
```python
# ✅ 推荐：包含 token 和成本信息
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    event=QueueEvent.AGENT_THOUGHT,
    thought=json.dumps(tool_calls),
    message_token_count=input_token_count,
    answer_token_count=output_token_count,
    total_token_count=total_token_count,
    total_price=total_price,
    latency=execution_time,
))

# ❌ 不推荐：缺少统计信息
self.agent_queue_manager.publish(state["task_id"], AgentThought(
    event=QueueEvent.AGENT_THOUGHT,
    thought=json.dumps(tool_calls),
))
```

**原因**：

+ 用户可以了解成本
+ 便于性能分析
+ 支持计费功能



### 7.2 监听队列最佳实践
#### 7.2.1 使用异步线程执行 Agent
```python
# ✅ 推荐：使用异步线程
def run_agent():
    agent.invoke(input_data)

thread = threading.Thread(target=run_agent)
thread.start()

# 立即开始监听
for event in agent.agent_queue_manager.listen(task_id):
    yield event

# ❌ 不推荐：同步执行
agent.invoke(input_data)  # 阻塞，无法实时推送事件
for event in agent.agent_queue_manager.listen(task_id):
    yield event
```

**原因**：

+ Agent 执行和事件监听需要并发进行
+ 同步执行会导致无法实时推送事件
+ 异步线程不会阻塞主线程

#### 7.2.2 正确处理异常
```python
# ✅ 推荐：捕获异常并发布错误事件
def run_agent():
    try:
        agent.invoke(input_data)
    except Exception as e:
        agent.agent_queue_manager.publish_error(
            task_id,
            f"Agent 执行失败: {str(e)}"
        )

thread = threading.Thread(target=run_agent)
thread.start()

for event in agent.agent_queue_manager.listen(task_id):
    yield event
```

**原因**：

+ 异常不会导致监听循环卡住
+ 用户可以看到错误信息
+ 便于调试和排查问题

#### 7.2.3 设置合理的超时时间
```python
# 当前默认超时时间
listen_timeout = 600  # 10 分钟

# 根据场景调整超时时间
# 简单对话：300 秒（5 分钟）
# 复杂任务：900 秒（15 分钟）
# 长时间任务：1800 秒（30 分钟）
```

**建议**：

+ 根据实际业务场景调整
+ 过短：可能导致正常任务超时
+ 过长：占用资源，影响系统稳定性

### 7.3 停止任务最佳实践
#### 7.3.1 验证用户权限
```python
# ✅ 推荐：使用 set_stop_flag 自动验证
AgentQueueManager.set_stop_flag(
    task_id=task_id,
    invoke_from=InvokeFrom.WEB_APP,
    user_id=account.id,
)

# ❌ 不推荐：直接操作 Redis
redis_client.setex(f"generate_task_stopped:{task_id}", 600, 1)
```

**原因**：

+ `set_stop_flag` 包含权限验证
+ 防止用户停止他人的任务
+ 确保安全性

#### 7.3.2 提供停止反馈
```python
# 前端：显示停止状态
eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.event === 'stop') {
        showMessage('任务已停止');
        eventSource.close();
    }
};
```

**原因**：

+ 用户需要知道任务已停止
+ 提升用户体验
+ 避免用户重复点击停止按钮

### 7.4 性能优化技巧
#### 7.4.1 避免频繁发布事件
```python
# ✅ 推荐：合并小的内容片段
buffer = ""
for chunk in llm.stream(messages):
    buffer += chunk.content
    if len(buffer) >= 10:  # 累积到一定长度再发布
        self.agent_queue_manager.publish(...)
        buffer = ""

# 发布剩余内容
if buffer:
    self.agent_queue_manager.publish(...)

# ❌ 不推荐：每个字符都发布
for chunk in llm.stream(messages):
    self.agent_queue_manager.publish(...)  # 太频繁
```

**原因**：

+ 减少网络传输次数
+ 降低客户端处理压力
+ 提升整体性能

#### 7.4.2 及时清理队列
```python
# 队列会在任务结束后自动清理
# 但如果有大量短期任务，可以手动清理

def cleanup_old_queues(self):
    """清理超过 30 分钟的队列"""
    current_time = time.time()
    for task_id, queue in list(self._queues.items()):
        # 检查 Redis 中的任务归属键是否存在
        if not self.redis_client.exists(
            self.generate_task_belong_cache_key(task_id)
        ):
            # 任务已过期，删除队列
            del self._queues[task_id]
```

**原因**：

+ 防止内存泄漏
+ 释放不再使用的资源
+ 保持系统稳定

---

## 8. 常见问题与解决方案
### 8.1 问题：事件丢失
**现象**：客户端没有收到某些事件

**可能原因**：

1. 网络问题导致连接断开
2. 事件发布在监听开始之前
3. 队列满了（理论上不会发生）

**解决方案**：

```python
# 1. 确保监听在 Agent 执行之前开始
def run_agent():
    agent.invoke(input_data)

thread = threading.Thread(target=run_agent)
thread.start()  # 先启动线程

# 立即开始监听
for event in agent.agent_queue_manager.listen(task_id):
    yield event

# 2. 前端实现重连机制
eventSource.onerror = () => {
    // 重新连接
    setTimeout(() => {
        eventSource = new EventSource('/api/chat');
    }, 1000);
};
```

### 8.2 问题：任务无法停止
**现象**：点击停止按钮后，任务仍在执行

**可能原因**：

1. 停止标记未设置成功
2. 监听循环未检测到停止标记
3. Agent 执行在停止检测之间的间隙

**解决方案**：

```python
# 1. 检查停止标记是否设置成功
result = redis_client.get(f"generate_task_stopped:{task_id}")
if result:
    print("停止标记已设置")

# 2. 确保监听循环正常运行
# 检查是否有异常导致循环退出

# 3. 在 Agent 节点中检查停止标记
def _llm_node(self, state: AgentState) -> AgentState:
    # 在耗时操作前检查停止标记
    if self.agent_queue_manager._is_stopped(state["task_id"]):
        return {"messages": [AIMessage("任务已停止")]}
    
    # 执行 LLM 调用
    result = llm.invoke(messages)
    return {"messages": [result]}
```

### 8.3 问题：内存占用过高
**现象**：服务器内存持续增长

**可能原因**：

1. 队列未及时清理
2. 大量并发任务
3. 事件对象过大

**解决方案**：

```python
# 1. 定期清理过期队列
def cleanup_expired_queues(self):
    for task_id in list(self._queues.keys()):
        if not self.redis_client.exists(
            self.generate_task_belong_cache_key(task_id)
        ):
            del self._queues[task_id]

# 2. 限制并发任务数
MAX_CONCURRENT_TASKS = 100

if len(self._queues) >= MAX_CONCURRENT_TASKS:
    raise Exception("并发任务数已达上限")

# 3. 减小事件对象大小
# 不要在事件中包含大量数据
AgentThought(
    event=QueueEvent.AGENT_MESSAGE,
    answer=chunk.content,  # 只包含必要的内容
    # 不要包含完整的 messages 列表
)
```

### 8.4 问题：超时时间不合理
**现象**：任务经常超时或超时时间过长

**解决方案**：

```python
# 根据任务类型动态调整超时时间
class AgentQueueManager:
    def listen(self, task_id: UUID, timeout: int = 600) -> Generator:
        """监听队列，支持自定义超时时间"""
        listen_timeout = timeout
        # ... 其他代码

# 使用时指定超时时间
for event in agent.agent_queue_manager.listen(task_id, timeout=300):
    yield event
```

### 8.5 问题：Redis 连接失败
**现象**：无法设置或获取 Redis 键

**解决方案**：

```python
# 1. 添加重试机制
def set_stop_flag_with_retry(task_id, invoke_from, user_id, max_retries=3):
    for i in range(max_retries):
        try:
            AgentQueueManager.set_stop_flag(task_id, invoke_from, user_id)
            return
        except Exception as e:
            if i == max_retries - 1:
                raise
            time.sleep(1)

# 2. 添加降级方案
# 如果 Redis 不可用，使用内存标记
_stop_flags = {}  # 内存中的停止标记

def _is_stopped(self, task_id: UUID) -> bool:
    try:
        # 优先使用 Redis
        result = self.redis_client.get(
            self.generate_task_stopped_cache_key(task_id)
        )
        return result is not None
    except Exception:
        # Redis 不可用，使用内存标记
        return _stop_flags.get(str(task_id), False)
```

---

## 9. 性能优化
### 9.1 队列性能优化
#### 9.1.1 使用合适的队列大小
```python
# Python Queue 默认无限大小
# 可以设置最大大小防止内存溢出
q = Queue(maxsize=1000)
```

**建议**：

+ 一般任务：maxsize=1000
+ 大量事件：maxsize=5000
+ 简单任务：maxsize=100

#### 9.1.2 批量处理事件
```python
# 批量获取事件
def listen_batch(self, task_id: UUID, batch_size: int = 10) -> Generator:
    """批量监听队列事件"""
    batch = []
    
    while True:
        try:
            item = self.queue(task_id).get(timeout=0.1)
            if item is None:
                if batch:
                    yield batch
                break
            
            batch.append(item)
            
            if len(batch) >= batch_size:
                yield batch
                batch = []
        except queue.Empty:
            if batch:
                yield batch
                batch = []
```

**优点**：

+ 减少网络传输次数
+ 提升吞吐量
+ 降低客户端处理压力

### 9.2 Redis 性能优化
#### 9.2.1 使用 Pipeline
```python
# 批量操作 Redis
def set_multiple_flags(task_ids: list[UUID]):
    pipe = redis_client.pipeline()
    for task_id in task_ids:
        pipe.setex(
            f"generate_task_stopped:{task_id}",
            600,
            1
        )
    pipe.execute()
```

#### 9.2.2 合理设置过期时间
```python
# 任务归属键：30 分钟（1800 秒）
# 足够长，避免任务执行期间过期
redis_client.setex(task_belong_key, 1800, value)

# 停止标记键：10 分钟（600 秒）
# 不需要太长，停止后很快就会被检测到
redis_client.setex(task_stopped_key, 600, 1)
```

### 9.3 内存优化
#### 9.3.1 及时清理队列
```python
# 在任务结束后清理队列
def stop_listen(self, task_id: UUID) -> None:
    """停止监听并清理队列"""
    self.queue(task_id).put(None)
    
    # 延迟清理，确保监听循环已退出
    def cleanup():
        time.sleep(5)
        if str(task_id) in self._queues:
            del self._queues[str(task_id)]
    
    threading.Thread(target=cleanup).start()
```

#### 9.3.2 限制事件对象大小
```python
# ✅ 推荐：只包含必要信息
AgentThought(
    event=QueueEvent.AGENT_MESSAGE,
    answer=chunk.content,  # 小片段
    latency=execution_time,
)

# ❌ 不推荐：包含大量数据
AgentThought(
    event=QueueEvent.AGENT_MESSAGE,
    answer=chunk.content,
    message=messages_to_dict(state["messages"]),  # 可能很大
    observation=json.dumps(large_data),  # 可能很大
)
```

---

## 10. 总结
### 10.1 核心要点回顾
1. **AgentQueueManager 的作用**
    - 管理 Agent 执行过程中的事件流
    - 实现实时的流式推送
    - 支持任务控制和超时管理
2. **核心组件**
    - Python Queue：内存队列，高性能
    - Redis：分布式状态同步
    - Generator：流式接口
3. **事件类型**
    - 10 种事件类型，覆盖 Agent 执行的各个阶段
    - 每种事件都有特定的用途和数据结构
4. **核心功能**
    - `listen()`：监听队列，流式返回事件
    - `publish()`：发布事件到队列
    - `set_stop_flag()`：设置停止标记
    - 心跳机制、超时检测、停止检测
5. **最佳实践**
    - 使用相同 ID 标识同一事件
    - 及时发布事件
    - 包含完整的统计信息
    - 正确处理异常
    - 验证用户权限

### 10.2 适用场景
+ **Web 应用对话**：实时显示 Agent 推理过程
+ **调试器**：详细展示执行步骤
+ **助手 Agent**：支持多轮对话
+ **API 服务**：提供流式 API 接口

### 10.3 性能特点
+ **高性能**：基于内存队列，延迟低
+ **可扩展**：支持分布式部署
+ **可靠性**：自动超时检测和错误处理
+ **用户体验**：实时反馈，流式输出

### 10.4 未来改进方向
1. **持久化支持**
    - 支持将事件持久化到数据库
    - 便于事件回放和分析
2. **更灵活的超时配置**
    - 支持动态调整超时时间
    - 根据任务类型自动选择超时时间
3. **更强大的监控**
    - 添加性能指标收集
    - 支持实时监控和告警
4. **更好的错误处理**
    - 更详细的错误信息
    - 支持错误重试机制

### 10.5 学习建议
1. **理解核心概念**
    - 队列的工作原理
    - Generator 的使用
    - Redis 的作用
2. **阅读源码**
    - `agent_queue_manager.py`
    - `queue_entity.py`
    - Agent 节点中的使用
3. **实践应用**
    - 在项目中使用 AgentQueueManager
    - 尝试不同的事件类型
    - 实现自定义的事件处理
4. **性能优化**
    - 分析性能瓶颈
    - 优化事件发布频率
    - 合理配置超时时间

---

## 附录
### A. 完整代码示例
```python
# 完整的使用示例

from internal.core.agent.agents import FunctionCallAgent, AgentQueueManager
from internal.core.agent.entities.agent_entity import AgentConfig
from langchain_core.messages import HumanMessage
import threading
import uuid

def chat_with_agent(query: str, user_id: UUID):
    """与 Agent 对话的完整示例"""
    # 1. 创建任务 ID
    task_id = uuid.uuid4()
    
    # 2. 创建 Agent 配置
    agent_config = AgentConfig(
        user_id=user_id,
        invoke_from=InvokeFrom.WEB_APP,
        preset_prompt="你是一个智能助手",
        tools=[],
        enable_long_term_memory=False,
    )
    
    # 3. 创建 Agent
    agent = FunctionCallAgent(
        agent_config=agent_config,
        llm=llm,
    )
    
    # 4. 异步执行 Agent
    def run_agent():
        try:
            agent.invoke({
                "messages": [HumanMessage(content=query)],
                "task_id": task_id,
                "iteration_count": 0,
                "history": [],
                "long_term_memory": "",
            })
        except Exception as e:
            agent.agent_queue_manager.publish_error(
                task_id,
                f"Agent 执行失败: {str(e)}"
            )
    
    thread = threading.Thread(target=run_agent)
    thread.start()
    
    # 5. 监听队列，处理事件
    for event in agent.agent_queue_manager.listen(task_id):
        print(f"事件类型: {event.event}")
        
        if event.event == "agent_message":
            print(f"消息: {event.answer}")
        elif event.event == "agent_thought":
            print(f"推理: {event.thought}")
        elif event.event == "agent_action":
            print(f"工具调用: {event.tool}")
        elif event.event == "agent_end":
            print("对话结束")
            break
        elif event.event == "error":
            print(f"错误: {event.observation}")
            break

# 使用示例
chat_with_agent("你好，请介绍一下自己", user_id)
```

### B. 相关文档
+ **LangGraph 使用详解与教程**：`docs/LangGraph使用详解与教程.md`
+ **Agent 多应用及工作流模块实现详解**：`docs/Agent多应用及工作流模块实现详解.md`
+ **记忆与流式响应模块实现详解**：`docs/记忆与流式响应模块实现详解.md`

