---
sidebar_position: 7
sidebar_label: 05 子图与状态边界
description: 沿父任务调用子图的过程解释输入输出映射、检查点继承、命名空间、恢复重放和事件归属。
---

# LangGraph 源码 05：父任务如何调用和恢复一张子图

## 源码定位

> **源码基线**：langgraph 1.2.10，本文使用的源码快照不含 Git 元数据，commit 未知。版本范围与文件指纹见[导读](./index.md#源码基线)。
>
> - 节点接入：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.add_node()`、`CompiledStateGraph.attach_node()`。
> - 保存器选择：`libs/langgraph/langgraph/pregel/main.py` → `Pregel._defaults()`、`Pregel.stream()`。
> - 命名空间：`libs/langgraph/langgraph/_internal/_config.py` → `recast_checkpoint_ns()`；`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.__init__()`。
> - 行为用例：`libs/langgraph/tests/test_subgraph_persistence.py` → `test_stateless_interrupt_resume()`。

子图是一个可被父图节点调用的编译图。父图调度的是“调用子图”这个任务，子图内部再运行自己的任务与轮次。父子各有状态通道，输入和结果通过节点调用传递；它们不会因为字段同名就共享一份实时可变 State。

`CompiledStateGraph` 继承 `Pregel`，而 Pregel 提供 Runnable 的统一调用接口。`add_node("run_child", child)` 可以直接接受编译后的子图，父节点的执行对象就是 child。若父子字段不同，则用包装函数映射输入与输出。

## 一、一次父子调用经过两个状态提交边界

假设父图持有 `article`，子图处理 `text` 并生成 `summary`，数据流是：

```text
父图已提交的 article
  → 父任务 run_child 的输入
  → 包装函数构造 {text: article}
  → 子图自己的输入、任务轮次与字段更新
  → 子图输出 summary
  → 包装函数返回 {summary: ...}
  → 父任务 writers 暂存更新
  → 父图轮次结束后合并
```

以下是字段映射的应用片段；child、ParentState 由应用定义：

```python
def run_child(state: ParentState):
    result = child.invoke({"text": state["article"]})
    return {"summary": result["summary"]}
```

直接把 child 注册为节点时，也有同样的边界：子图输入由它的输入结构处理，返回值由父图 writer 提取父图已知字段。包装函数的价值是明确转换、裁剪结果，而不只是改一个字段名。

这在列表 reducer 上尤其重要。假设父图已有 `["A"]`，子图接收它后返回完整列表 `["A", "B"]`，父图若再次用列表拼接归并，会得到 `["A", "A", "B"]`。应明确返回增量、覆盖值，或使用按稳定 ID 合并的规则，不能认为“父子用了同一个 Schema”就自动避免重复。

## 二、子图如何获得保存器

父任务的运行配置携带内部保存器和命名空间；嵌套子图读取这一配置。`Pregel._defaults()` 的选择顺序如下：

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel._defaults`（第 2579–2586 行节选；未展示部分省略）。

```python
if self.checkpointer is False:
    checkpointer: BaseCheckpointSaver | None = None
elif CONFIG_KEY_CHECKPOINTER in config.get(CONF, {}):
    checkpointer = config[CONF][CONFIG_KEY_CHECKPOINTER]
elif self.checkpointer is True:
    raise RuntimeError("checkpointer=True cannot be used for root graphs.")
else:
    checkpointer = self.checkpointer
```

`checkpointer=False` 明确禁用子图保存；否则优先使用父运行配置注入的保存器。`checkpointer=True` 不是创建新保存器，根图直接使用它会报错；根图应提供真正的保存器实例，例如 `InMemorySaver` 或数据库后端。

| 子图 compile 配置 | 保存器来源 | 历史范围 |
| --- | --- | --- |
| `None`（默认） | 可继承父图保存器 | 为本次子图调用保存恢复现场，不默认累计到下次独立调用 |
| `True` | 继承父图保存器 | 用稳定的子图命名空间累计同一执行线内的状态 |
| `False` | 不使用保存器 | 无子图自己的持久恢复现场 |

根图也未提供保存器时，默认子图没有可继承的持久化能力。`InMemorySaver` 只在当前进程内保存；把配置写成 `True` 也不会使内存状态跨进程存活。

## 三、命名空间决定是哪一次子图调用

任务准备时生成 `节点名:task_id` 形式的检查点路径，嵌套层次用 `|` 连接。例如父节点 `run_child` 的某次调用拥有自己的路径，子图在该路径下保存历史。相同节点的下一次任务通常拥有新的任务 ID，默认子图不会因此读到上一次独立调用的累计状态。

当 child 配置 `checkpointer=True` 时，`stream()` 会重写路径：

源码：`libs/langgraph/langgraph/pregel/main.py` → `Pregel.stream`（第 2806–2809 行节选；未展示部分省略）。

```python
# 有状态子图将调用级路径转换为稳定路径。
if self.checkpointer is True:
    ns = cast(str, config[CONF][CONFIG_KEY_CHECKPOINT_NS])
    config[CONF][CONFIG_KEY_CHECKPOINT_NS] = recast_checkpoint_ns(ns)
```

源码：`libs/langgraph/langgraph/_internal/_config.py` → `recast_checkpoint_ns`（第 47–49 行节选；未展示部分省略）。

```python
return NS_SEP.join(
    part.split(NS_END)[0] for part in ns.split(NS_SEP) if not part.isdigit()
)
```

`recast_checkpoint_ns()` 去除每一段的任务 ID 和纯数字调用序号，留下节点路径。持久状态的身份因此取决于 **thread_id 加子图路径**，不是仅凭 thread_id。改变节点路径可能改变历史归属；并行复用同一个有状态子图路径，也需要避免多个调用竞争同一份累计状态。

默认子图在一个父任务内被多次调用时，Loop 用 `subgraph_counter()` 为后续调用追加序号。恢复时应保持调用顺序稳定，不能在旧调用前任意插入一次新调用后期待原检查点自然匹配。

## 四、子图暂停时父包装函数也会重跑

子图的 `interrupt()` 抛出可恢复控制信号，沿嵌套调用传出。父图保存当前任务及子图恢复所需配置，调用方再以同一执行线提交 `Command(resume=...)`。

恢复时 Python 调用栈不会回来。父图会重新进入 `run_child`，再次执行 `child.invoke(...)`；子图凭命名空间找到本次暂停的现场，继续其中尚未完成的任务。默认 `checkpointer=None` 的“不跨调用累计”不妨碍恢复这一次尚未完成的调用。

因此包装函数在 `child.invoke()` 前面的请求或写操作也可能重复执行。把不可重复操作放到有明确任务结果记录的步骤，或让外部服务接受幂等键；子图提供恢复边界，但不提供进程、权限或数据库事务隔离。

若 child 使用 `checkpointer=False`，不能依赖父图保存器恢复它内部的完整进度。父图自身有检查点，不等于所有嵌套执行都自动可恢复。

## 五、子图事件与最终输出是两个视图

父图流式调用开启 `subgraphs=True` 后，运行配置将父流出口传给子图。内部事件携带 namespace（命名空间路径），调用方可区分事件来自根图还是某次子图调用。

在普通 `stream(version="v1")` 中，单一 mode 返回 `(namespace, data)`，多个 mode 返回 `(namespace, mode, data)`。根图 namespace 为 `()`，子图路径元素通常含 `run_child:<task_id>`，不能只用节点名假定每次调用都相同。子图的 updates 内容仍按子节点名组织，不是将字段直接摊在事件顶层。

采用 `version="v2"` 时形状统一为含 `type`、`ns`、`data` 的对象。子图可在父任务结束前不断输出事件，但父任务的业务结果仍要等子图返回、父图提交后才成为父图已提交状态。

内部确有独立多步流程、状态规则或恢复需求时，子图能形成清晰边界；若内部只是一个函数，额外的 Schema、命名空间和恢复顺序反而增加维护成本。跨图跳转还需经过 `Command.PARENT` 的传播路径，见[第 04 篇](./04-dynamic-routing-and-send.md)。
