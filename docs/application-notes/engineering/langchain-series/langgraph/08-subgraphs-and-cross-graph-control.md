---
sidebar_position: 10
sidebar_label: 08 子图与跨图控制
description: 沿父任务调用子图追踪状态映射、检查点继承、中断重跑与父图命令，解释嵌套执行的身份和提交边界。
---

# LangGraph 源码 08：父子图如何划分状态、恢复与控制边界

## 源码定位

> **源码基线**：langgraph 1.2.10。以下路径相对于 LangGraph 源码仓库根目录，供查阅原实现。
>
> - 节点接入：`libs/langgraph/langgraph/graph/state.py` → `StateGraph.add_node()`、`CompiledStateGraph.attach_node()`。
> - 保存器选择：`libs/langgraph/langgraph/pregel/main.py` → `Pregel._defaults()`、`Pregel.stream()`。
> - 命名空间：`libs/langgraph/langgraph/_internal/_config.py` → `recast_checkpoint_ns()`；`libs/langgraph/langgraph/pregel/_loop.py` → `PregelLoop.__init__()`。
> - 跨图命令：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry()`；`libs/langgraph/langgraph/graph/state.py` → `_control_branch()`。
> - 行为用例：`libs/langgraph/tests/test_subgraph_persistence.py` → `test_stateless_interrupt_resume()`。

你可以把编译好的 child 交给 `parent.add_node("run_child", child)`，也可以在父节点函数里调用 `child.invoke(...)`。两种写法都会遇到同样的问题：父图的数据怎样传进去，子图结果怎样传出来，内部暂停后要从哪里继续？

子图是一个可被父图节点调用的编译图。父图调度的是“调用子图”这个任务，子图内部再运行自己的任务与轮次。父子各有状态通道，输入和结果通过节点调用传递；它们不会因为字段同名就共享一份实时可变 State。

`CompiledStateGraph` 继承 `Pregel`，而 Pregel 提供 Runnable 的统一调用接口。`add_node("run_child", child)` 可以直接接受编译后的子图，父节点的执行对象就是 child。若父子字段不同，则用包装函数映射输入与输出。

本篇依赖[持久化](./06-checkpoints-store-and-recovery.md)和[中断恢复](./07-interrupts-and-command.md)：先理解一张图如何保存与重跑，再看这些机制进入父子调用后怎样分配身份和传播控制。

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

下面是完整应用示例。子图先清理文本，再截取前五个字符作为演示摘要；父图只关心 article 输入与 summary 结果。

```python
from typing_extensions import TypedDict
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, END, StateGraph

class ChildState(TypedDict):
    text: str
    summary: str

def normalize(state: ChildState):
    return {"text": state["text"].strip()}

def summarize(state: ChildState):
    return {"summary": state["text"][:5]}

child_builder = StateGraph(ChildState)
child_builder.add_node("normalize", normalize)
child_builder.add_node("summarize", summarize)
child_builder.add_edge(START, "normalize")
child_builder.add_edge("normalize", "summarize")
child_builder.add_edge("summarize", END)
child = child_builder.compile()  # 默认可继承父运行的保存器。

class ParentState(TypedDict):
    article: str
    summary: str

def run_child(state: ParentState):
    result = child.invoke({"text": state["article"]})
    return {"summary": result["summary"]}

parent_builder = StateGraph(ParentState)
parent_builder.add_node("run_child", run_child)
parent_builder.add_edge(START, "run_child")
parent_builder.add_edge("run_child", END)
parent = parent_builder.compile(checkpointer=InMemorySaver())
config = {"configurable": {"thread_id": "article-42"}}
result = parent.invoke({"article": "  hello world  ", "summary": ""}, config)
assert result == {"article": "  hello world  ", "summary": "hello"}
```

子图中的 text 已变成 `"hello world"`，父图的 article 仍保留两侧空格。因为父包装函数只返回 summary，子图修改 text 不会直接修改父图 article。

从父图看，run_child 是一个尚未完成的任务；从子图看，normalize 和 summarize 已先后完成两轮更新。子图结束后，summary 才变成父任务的返回值，再由父图合并。这里的两层提交，对应两套状态通道，不是两份变量指向同一个字典。

直接把 child 注册为节点时，也有同样的边界：子图输入由它的输入结构处理，返回值由父图 writer 提取父图已知字段。包装函数的价值是明确转换、裁剪结果，而不只是改一个字段名。

这在列表 reducer 上尤其重要。假设父图已有 `["A"]`，子图接收它后返回完整列表 `["A", "B"]`，父图若再次用列表拼接归并，会得到 `["A", "A", "B"]`。应明确返回增量、覆盖值，或使用按稳定 ID 合并的规则，不能认为“父子用了同一个 Schema”就自动避免重复。

## 二、子图如何获得保存器

上面的 child 没有显式配置保存器，也没有手动传入 config。它在父节点执行上下文中调用，运行时可以取得父任务的配置；不能据此推断在图外任意调用 child 都会找到 article-42 的历史。

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

`NS_SEP` 是层级分隔符 `|`，`NS_END` 是节点名与任务 ID 之间的分隔符 `:`。`recast_checkpoint_ns()` 去除每一段的任务 ID 和纯数字调用序号，留下节点路径。

例如下表中的 task-A、task-B 是为了阅读而写的身份占位符，不是真实任务 ID：

| 子图设置 | 同一 thread 的两次独立调用 | 能否默认读取上次累计状态 |
| --- | --- | --- |
| 默认 `None` | `run_child:task-A`、`run_child:task-B` | 各自保存本次调用现场，不因此累计 |
| `True` | 两次都转换为 `run_child` | 稳定路径可关联上次历史；新输入仍按字段规则更新 |

持久状态的身份取决于 **thread_id 加子图路径**，不是仅凭 thread_id。改变节点路径可能改变历史归属；并行复用同一个有状态子图路径，也需要避免多个调用竞争同一份累计状态。

默认子图在一个父任务内被多次调用时，Loop 用 `subgraph_counter()` 为后续调用追加序号。恢复时应保持调用顺序稳定，不能在旧调用前任意插入一次新调用后期待原检查点自然匹配。

## 四、子图暂停时父包装函数也会重跑

子图的 `interrupt()` 抛出可恢复控制信号，沿嵌套调用传出。父图保存当前任务及子图恢复所需配置，调用方再以同一执行线提交 `Command(resume=...)`。

如果把示例的 summarize 改成先调用 interrupt 等待确认，第一次 parent.invoke 就会携带子图暂停记录返回。调用方仍向 parent 提交恢复命令，不必单独找到 child 再 invoke。

恢复时 Python 调用栈不会回来。父图会重新进入 `run_child`，再次执行 `child.invoke(...)`；子图凭命名空间找到本次暂停的现场，继续其中尚未完成的任务。默认 `checkpointer=None` 的“不跨调用累计”不妨碍恢复这一次尚未完成的调用。

因此包装函数在 `child.invoke()` 前面的请求或写操作也可能重复执行。把不可重复操作放到有明确任务结果记录的步骤，或让外部服务接受幂等键；子图提供恢复边界，但不提供进程、权限或数据库事务隔离。

若 child 使用 `checkpointer=False`，不能依赖父图保存器恢复它内部的完整进度。父图自身有检查点，不等于所有嵌套执行都自动可恢复。

## 五、Command.PARENT 沿调用边界向上传播

子图中的节点可以返回 `Command(graph=Command.PARENT, update=..., goto=...)`。子图的状态 writer 跳过这份更新，控制 writer 抛出 `ParentCommand`。它是内部控制异常，不代表业务节点失败。

`run_with_retry()` 沿图调用边界处理该异常：

源码：`libs/langgraph/langgraph/pregel/_retry.py` → `run_with_retry`（第 618–631 行节选；未展示部分省略）。

```python
except ParentCommand as exc:
    ns: str = config[CONF][CONFIG_KEY_CHECKPOINT_NS]
    cmd = exc.args[0]
    # 比较命名空间时去掉任务 ID，以匹配目标图。
    if cmd.graph in (ns, recast_checkpoint_ns(ns), task.name):
        # 命令属于当前边界，交给此任务的 writers 处理。
        for w in task.writers:
            w.invoke(cmd, config)
        break
    elif cmd.graph == Command.PARENT:
        # 将 PARENT 改写为具体父图命名空间。
        exc.args = (replace(cmd, graph=_checkpoint_ns_for_parent_command(ns)),)
    # 未到目标边界时继续向外传播。
    raise
```

到达目标边界后，父节点的 writers 处理命令，于是 `update` 按父图字段过滤并归并，`goto` 转换为父图触发信号。它没有在子图内部直接调用父图函数，也不做任意层级节点查找。

父图已有静态后继依然可能随 writers 一起执行。父子共享字段上的 reducer 也要按实际输出设计，尤其避免把已累计的完整列表再次作为增量返回。跨图接口最好只返回需要交给父图的结果或控制对象，减少两层对同一字段重复归并。

## 六、子图事件与最终输出是两个视图

父图流式调用开启 `subgraphs=True` 后，运行配置将父流出口传给子图。内部事件携带 namespace（命名空间路径），调用方可区分事件来自根图还是某次子图调用。

在普通 `stream(version="v1")` 中，单一 mode 返回 `(namespace, data)`，多个 mode 返回 `(namespace, mode, data)`。根图 namespace 为 `()`，子图路径元素通常含 `run_child:<task_id>`，不能只用节点名假定每次调用都相同。子图的 updates 内容仍按子节点名组织，不是将字段直接摊在事件顶层。

采用 `version="v2"` 时形状统一为含 `type`、`ns`、`data` 的对象。子图可在父任务结束前不断输出事件，但父任务的业务结果仍要等子图返回、父图提交后才成为父图已提交状态。

内部确有独立多步流程、状态规则或恢复需求时，子图能形成清晰边界；若内部只是一个函数，额外的 Schema、命名空间和恢复顺序反而增加维护成本。普通动态图内派发见[第 05 篇](./05-dynamic-routing-and-send.md)，完整事件消费链路见[第 09 篇](./09-stream-system.md)。
