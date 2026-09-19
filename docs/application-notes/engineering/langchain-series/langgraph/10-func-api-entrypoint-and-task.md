---
sidebar_position: 12
sidebar_label: 10 函数式工作流
description: 追踪 entrypoint 直接构造 Pregel、task 动态调度及结果复用，解释 previous、final、恢复顺序与缓存边界。
---

# LangGraph 源码 10：函数调用如何接入可恢复任务

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 入口构造：`libs/langgraph/langgraph/func/__init__.py` → `entrypoint.__call__()`、`_TaskFunction.__call__()`、`entrypoint.final`。
> - 调用桥接：`libs/langgraph/langgraph/pregel/_call.py` → `_call_with_options()`、`get_runnable_for_task()`。
> - 任务调度：`libs/langgraph/langgraph/pregel/_runner.py` → `_call()`；`libs/langgraph/langgraph/pregel/_loop.py` → `accept_push()`。

函数式 API 允许用普通 Python 控制流组织可恢复工作流。`@entrypoint` 将函数变成可执行的 Pregel 入口；`@task` 将函数调用转换为运行时任务，并返回 Future（未来结果句柄）。它直接构造 Pregel，不先生成一张 StateGraph，也没有另造一套恢复引擎。

区别在控制流的存放位置：StateGraph 用节点和边表达依赖，函数式工作流通过函数中的调用、条件和等待表达依赖。两者都可以有重试、检查点、流式事件和人工中断。

## 一、entrypoint 创建入口节点和三个通道

装饰器先把用户函数包装成 Runnable，再检查输入和返回类型。入口函数必须有输入参数；生成器和异步生成器在此基线中被拒绝。实际构造的 Pregel 含一个入口节点，其输入通道和触发通道都是 `START`。

源码：`libs/langgraph/langgraph/func/__init__.py` → `entrypoint.__call__`（第 576–609 行节选；未展示部分省略）。

```python
graph: Pregel[Any, ContextT, Any, Any] = Pregel(
    nodes={
        func.__name__: PregelNode(
            bound=bound,
            triggers=[START],
            channels=START,
            timeout=self.timeout,
            writers=[
                ChannelWrite(
                    [
                        ChannelWriteEntry(END, mapper=_pluck_return_value),
                        ChannelWriteEntry(PREVIOUS, mapper=_pluck_save_value),
                    ]
                )
            ],
        )
    },
    channels={
        START: EphemeralValue(input_type),
        END: LastValue(output_type, END),
        PREVIOUS: LastValue(save_type, PREVIOUS),
    },
    input_channels=START,
    output_channels=END,
    stream_channels=END,
    stream_mode=stream_mode,
    stream_eager=True,
    checkpointer=self.checkpointer,
    store=self.store,
    cache=self.cache,
    cache_policy=self.cache_policy,
    retry_policy=self.retry_policy or (),
    context_schema=self.context_schema,
)
```

`PregelNode` 是运行节点描述；`ChannelWriteEntry` 指定写哪个通道、如何从返回值取出数据。入口结束时，两项 writer 分别写 `END` 和 `PREVIOUS`。

`START` 用临时通道接收本次输入，`END` 用末值通道保存对外输出，`PREVIOUS` 保存供后续调用读取的值。检查点、Store、缓存和重试策略都直接交给 Pregel。默认流模式变量在前面设为 updates，不代表函数式工作流只能使用这一种观察模式。

## 二、task 调用通过运行配置进入 Runner

`@task` 装饰器保留原函数及重试、缓存、超时等策略。调用装饰后的对象时，`_TaskFunction.__call__()` 把参数交给 `_call_with_options()`，后者取得当前运行配置中的调度回调：

源码：`libs/langgraph/langgraph/pregel/_call.py` → `_call_with_options`（第 288–298 行节选；未展示部分省略）。

```python
config = get_config()
impl = config[CONF][CONFIG_KEY_CALL]
fut = impl(
    func,
    (args, kwargs),
    retry_policy=retry_policy,
    cache_policy=cache_policy,
    callbacks=config["callbacks"],
    timeout=timeout,
)
return fut
```

这里没有直接调用业务函数。`CONFIG_KEY_CALL` 是 Runner 注入的回调；它把函数和 `(args, kwargs)` 交给任务调度，返回可等待的结果句柄。因此 task 必须在提供该上下文的图运行内调用，不能把它当成任意位置都能启动任务的全局线程池。

同步路径 `_call()` 从任务暂存区获取调用序号，再经 `schedule_task` 进入 Loop 的 `accept_push()`：

源码：`libs/langgraph/langgraph/pregel/_runner.py` → `_call`（第 720–733 行节选；未展示部分省略）。

```python
scratchpad: PregelScratchpad = task().config[CONF][CONFIG_KEY_SCRATCHPAD]  # type: ignore[union-attr]
# 使用父任务和调用序号，准备这一次函数调用对应的子任务。
if next_task := schedule_task(
    task(),  # type: ignore[arg-type]
    scratchpad.call_counter(),
    Call(
        func,
        input,
        retry_policy=retry_policy,
        cache_policy=cache_policy,
        callbacks=callbacks,
        timeout=timeout,
    ),
):
```

`Call` 是内部函数调用描述，保存函数、参数和执行策略；它与路由用的 `Send` 不同。Loop 为它建立带独立 ID 的子任务，`get_runnable_for_task()` 将业务返回值写入 `RETURN` 控制通道，Future 再取得这份返回值。

这些动态子任务可在入口函数尚未返回时运行，否则入口等待 Future 就无法完成。它们不要求等待整个入口节点提交后才执行下一轮。

## 三、并行来自先提交多个调用，再等待结果

下面是完整应用示例，用于区分提交和等待：

```python
from langgraph.func import entrypoint, task

@task
def increment(number: int) -> int:
    return number + 1

@entrypoint()
def workflow(numbers: list[int]) -> list[int]:
    futures = [increment(number) for number in numbers]
    return [future.result() for future in futures]

result = workflow.invoke([1, 2])  # [2, 3]
```

第一行列表推导先提交全部调用，第二行才取结果，运行时因此可以并发执行。`.result()` 负责等待，不负责创造并行；如果在每次循环里立刻提交并等待，调用顺序就基本串行。

返回列表按 Future 的收集顺序排列，不按任务完成先后排列。异步入口可用 `await asyncio.gather(...)` 等待多个任务；同步上下文调用异步 task 在该路径中会报错。节点/任务超时策略同样要求异步执行，不能用它强制杀死普通同步函数。

## 四、恢复会重跑入口，但可复用已完成 task 的结果

入口函数在 `interrupt()` 暂停或执行失败后，恢复时从函数入口重跑。再次走到同一 task 调用位置时，Loop 可以按父任务与调用序号找到已保存的写入，Runner 用它完成 Future：

源码：`libs/langgraph/langgraph/pregel/_runner.py` → `_call`（第 745–756 行节选；未展示部分省略）。

```python
elif next_task.writes:
    # 已有任务结果时直接完成 Future，不再调用业务函数。
    fut = concurrent.futures.Future()
    ret = next((v for c, v in next_task.writes if c == RETURN), MISSING)
    if ret is not MISSING:
        fut.set_result(ret)
    elif exc := next((v for c, v in next_task.writes if c == ERROR), None):
        fut.set_exception(
            exc if isinstance(exc, BaseException) else Exception(exc)
        )
    else:
        fut.set_result(None)
```

例如入口依次执行“生成草稿 task → interrupt 审批 → 发送 task”。审批恢复时，入口重新开始；草稿 task 的成功结果若已保存，就直接返回原草稿；随后中断取得审批值，发送任务才被创建。入口中没有包进 task 的普通代码仍会再次执行。

| 代码或数据 | 恢复时的处理 |
| --- | --- |
| 入口函数局部变量 | 从头执行重新构造 |
| 已保存的成功 task 返回值 | 按任务身份复用 |
| 未完成或失败的 task | 根据恢复和重试规则执行 |
| 已匹配的 interrupt 值 | 按任务内中断顺序再次返回 |
| 外部请求的副作用 | 不由图自动回滚或去重 |

这要求恢复前后调用顺序和控制路径稳定。若每次运行随机改变任务数量，或在已有 task 前插入新 task，调用位置可能与历史不再一致。输入、返回值还需能被保存器序列化。

这种复用是**当前执行的任务结果恢复**，不同于 `CachePolicy` 按输入键缓存结果。缓存可以在另一次调用中复用相同输入，任务恢复则依赖保存现场和任务身份；只有装饰器、没有保存器时，不能期待跨进程恢复已完成任务。

## 五、previous 和 final 分开保存值与展示值

入口的 `previous` 参数来自上次保存的 `PREVIOUS` 通道。普通返回值默认同时写入 `END` 和 `PREVIOUS`；`entrypoint.final(value=..., save=...)` 则允许分别指定：

源码：`libs/langgraph/langgraph/func/__init__.py` → `entrypoint.__call__._pluck_return_value / _pluck_save_value`（第 546–552 行节选；未展示部分省略）。

```python
def _pluck_return_value(value: Any) -> Any:
    """从 final 中取对外返回值，普通返回值则直接透传。"""
    return value.value if isinstance(value, entrypoint.final) else value

def _pluck_save_value(value: Any) -> Any:
    """从 final 中取保存值，普通返回值则直接透传。"""
    return value.save if isinstance(value, entrypoint.final) else value
```

假设入口维护累计数，对外返回“本次处理完成”的文本，但下次需要继续累计。它可以把文本放在 value，将累计整数放在 save。下一次使用同一 thread 调用时，previous 是累计整数，而不是文本。

| 本次输入 | 进入时 previous | 返回对象 | 调用方得到 | 下次 previous |
| --- | --- | --- | --- | --- |
| 3 | `None` | `final(value="已处理 3", save=3)` | `"已处理 3"` | 3 |
| 2 | 3 | `final(value="已处理 2", save=5)` | `"已处理 2"` | 5 |

这需要配置保存器并复用执行身份。`previous` 是已保存的值，不是上次函数的局部变量或完整调用栈，也不意味着入口每次重跑都已经完成一次新的累计。

## 六、两种 API 的选择取决于控制结构

| 设计问题 | 函数式 API | StateGraph |
| --- | --- | --- |
| 依赖写在哪里 | Python 调用和 Future 等待 | 节点、边和路由 |
| 状态如何组织 | 参数、任务结果及 previous | 字段通道及 reducer |
| 恢复要保持什么稳定 | 入口控制路径与任务调用顺序 | 节点身份、状态结构和路由兼容性 |
| 适合怎样阅读 | 从函数入口顺着业务过程看 | 从拓扑及各节点边界看 |

已有过程式代码、分支主要是普通 Python 控制流时，函数式入口能减少图装配代码；多人维护的工作流若需要明确展示节点依赖、状态更新和子流程边界，StateGraph 通常更直观。没有“四个分支以上必须改用图”的实现限制，函数式 API 也不缺少中断和子图能力。

两者的共同约束仍是持久化与副作用：把需要独立记录结果的工作放进任务，确保恢复路径可重放，并用外部幂等解决“操作已经完成、结果尚未保存”的故障窗口。
