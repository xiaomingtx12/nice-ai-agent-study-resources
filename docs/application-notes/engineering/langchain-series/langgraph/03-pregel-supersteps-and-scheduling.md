---
sidebar_position: 5
sidebar_label: 03 Pregel 调度与执行
description: 追踪 PregelLoop 的任务准备、PregelRunner 的并发执行、apply_writes 的统一提交，以及同一轮内节点互不可见的约束。
---

# LangGraph 源码 03：一轮任务如何运行和提交

## 源码定位

> **适用版本**：`langgraph` 1.2.10。
>
> **核心路径**：
>
> - 运行入口：`libs/langgraph/langgraph/pregel/main.py`
> - 轮次控制：`libs/langgraph/langgraph/pregel/_loop.py`（`PregelLoop.tick()`、`after_tick()`）
> - 任务准备与提交：`libs/langgraph/langgraph/pregel/_algo.py`（`prepare_next_tasks()`、`apply_writes()`）
> - 并发执行：`libs/langgraph/langgraph/pregel/_runner.py`（`PregelRunner`）

## 先抓住一轮执行

[第 02 篇](./02-stategraph-builder-and-compilation.md)编译出的 `CompiledStateGraph(Pregel)` 在 `invoke()` 后进入 Runtime。Runtime 每轮做四件事：

```text
1. prepare_next_tasks()  准备本轮可运行的任务
2. PregelRunner          并发执行任务
3. 收集 task.writes      每个任务产生的局部写入
4. apply_writes()        统一提交到 State Channel
```

核心约束只有一句：**同一轮任务读同一版 State，写入在统一提交后才对下一轮可见。**

## 一、两轮执行的直观感受

用一张带 reducer + 等待边的图看完整流程：

```python
class State(TypedDict):
    items: Annotated[list[str], add]

builder = StateGraph(State)
builder.add_node("left", lambda _: {"items": ["left"]})
builder.add_node("right", lambda _: {"items": ["right"]})
builder.add_node("merge", lambda s: {"items": [f"{s['items']} merged"]})
builder.add_edge(START, "left")
builder.add_edge(START, "right")
builder.add_edge(["left", "right"], "merge")
builder.add_edge("merge", END)
graph = builder.compile()
```

```text
第 1 轮准备  START 触发 left、right
第 1 轮执行  left、right 读同一版 items
第 1 轮提交  items 收到两份更新，交 reducer 合并 → ["left", "right"]
第 2 轮准备  left、right 都完成，barrier 满足 → merge 获得触发资格
第 2 轮执行  merge 读合并后的 items → ["['left', 'right'] merged"]
```

## 二、`PregelLoop.tick()`：准备本轮任务

`tick()` 是每轮的入口，调用 `prepare_next_tasks()` 决定哪些节点现在能运行：

```python
# libs/langgraph/langgraph/pregel/_loop.py（节选）
def tick(self) -> bool:
    if self.step > self.stop:       # 超过 recursion_limit
        return False

    self.tasks = prepare_next_tasks(
        self.checkpoint, self.checkpoint_pending_writes,
        self.nodes, self.channels, self.managed,
        self.config, self.step, self.stop, for_execution=True,
        ...
    )
    if not self.tasks:
        self.status = "done"
        return False
    return True
```

任务有两种来源：

| 类型 | 来源 | 输入 |
| --- | --- | --- |
| **PULL task** | Channel 更新触发的节点（普通边、等待边、条件边写入的触发 Channel 就绪） | 图 State（按节点 input_schema 过滤） |
| **PUSH task** | `TASKS` Channel 中的 `Send`（条件路由返回） | `Send.arg` |

`prepare_next_tasks()` 先处理 `TASKS` Channel 中的 `Send` → 创建 PUSH task；再根据 `trigger_to_nodes` 映射找出本轮被触发的节点 → 创建 PULL task。两种 task 都交给同一个 `PregelRunner` 执行。

## 三、`PregelRunner`：并发执行任务

任务提交后批量运行：

```python
# libs/langgraph/langgraph/pregel/_runner.py（节选）
for t in tasks:
    fut = self.submit()(run_with_retry, t, retry_policy, ...)
    futures[fut] = t

# 使用 FIRST_COMPLETED 逐个处理完成事件
while futures:
    done, _ = concurrent.futures.wait(futures, return_when=FIRST_COMPLETED)
    for fut in done:
        task = futures.pop(fut)
        # 成功 → 保留 task.writes；可重试错误 → 在当前 task 边界重跑
        # 致命错误 → 停止其他任务
```

每个任务独立拥有：输入、task path、writes、retry 策略、错误处理。retry 作用于节点任务不会重跑整张图；timeout 只对异步节点支持取消。`left` 和 `right` 无依赖关系可并发；`merge` 等 barrier 满足后才能准备，不与它们同轮。

## 四、`apply_writes()`：统一提交

Runner 完成后，`PregelLoop.after_tick()` 调用 `apply_writes()`：

```python
# libs/langgraph/langgraph/pregel/_loop.py（节选）
def after_tick(self) -> None:
    self.updated_channels = apply_writes(
        self.checkpoint, self.channels, self.tasks.values(),
        self.checkpointer_get_next_version, self.trigger_to_nodes,
    )
    self._put_checkpoint({"source": "loop"})
```

`apply_writes()` 的三步操作：

```text
1. 按 task path 排序 tasks → 确定提交顺序稳定
2. 遍历 tasks.writes → 按 Channel 分组（跳过控制信号如 INTERRUPT/RESUME/ERROR）
3. channel.update(grouped_values) → 交给每个 Channel 自己的 update()
```

Channel 语义在这一步真正生效：`LastValue` 拒绝多写、`BinaryOperatorAggregate` 逐份调 reducer、`NamedBarrierValue` 检查到齐。第 01 篇的规则在第 03 篇被执行。

### 同一轮互不可见

任务启动时 Runtime 已从 Channel 读取了当前 State 快照作为输入。任务执行期间 `task.writes` 只是挂在本地的暂存，`apply_writes()` 统一提交后才更新 Channel。所以并行节点读不到彼此本轮刚产生的值。要建立顺序依赖，用图边而不是 reducer。

## 五、中断恢复：pending writes 的角色

一轮中可能出现 `node_a` 成功、`node_b` 中断的局面。Saver 把 `node_a` 的写入记录为 pending writes，恢复时重新挂回：

```python
# libs/langgraph/langgraph/pregel/_loop.py（节选）
def _reapply_writes_to_succeeded_nodes(self, tasks):
    for tid, key, value in self.checkpoint_pending_writes:
        if key in (ERROR, ERROR_SOURCE_NODE, INTERRUPT, RESUME):
            continue
        if task := tasks.get(tid):
            task.writes.append((key, value))
```

控制信号被跳过，成功任务的 State 写入重新参与提交。checkpoint、replay、fork 的完整机制见[第 06 篇](./06-checkpoints-store-and-recovery.md)。

## 六、PregelRunner 的并发 vs 其他层的并发

PregelRunner 处理的是**图级 task 并发**——同一轮中无依赖的节点可以并行。除此之外，"工具并行"在另外两层也有含义（ToolNode 内部并发、工具函数资源并发），它们的分工和边界见[第 09 篇](./09-prebuilt-tool-layer.md)的并发分层讨论。本篇只需记住：PregelRunner 给每个 task 独立的 retry、checkpoint 和 interrupt 边界；节点内部的并行（executor/asyncio.gather）没有图级恢复能力。

## 排查速查

| 现象 | 优先检查 |
| --- | --- |
| 并行节点没同时运行 | 图边、任务是否同轮、并发限制 |
| 并行写同字段报错 | State 字段 Channel 和 reducer（[第 01 篇](./01-state-schema-channels-and-reducers.md)） |
| 下游读不到上游值 | 是否缺图边，或误把同轮当实时共享 |
| 恢复后成功节点重复执行 | checkpoint、pending writes 和 task 划分 |
| 工具打满 CPU | 工具自身 executor、连接池配置 |

## 工程判断

- **照搬**：State 更新集中到 `apply_writes()`，并行节点读取稳定快照。
- **换实现**：外部副作用加幂等键；工具调需独立恢复时提升到 `Send` 级别。
- **别碰**：不要依赖任务完成先后定业务顺序；不要用 reducer 替代图边。

## 读完后应该能判断什么

- `prepare_next_tasks()` 如何从 Channel 更新和 `TASKS` 中准备 PULL/PUSH task；
- `PregelRunner` 的并发模型：FIRST_COMPLETED、retry 边界、timeout 限制；
- `apply_writes()` 为什么在轮次结束后统一调 Channel.update()；
- pending writes 如何让成功的任务在恢复时不重复执行。
