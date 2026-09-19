---
sidebar_position: 1
sidebar_label: 导读：图状态机与运行时
description: 沿状态声明、图编译、任务调度、持久化和事件输出理解 LangGraph，并提供源码基线与主题入口。
---

# LangGraph 源码解析：从字段更新到可恢复执行

LangGraph 将节点输出转换成写入，在轮次边界合并状态，再根据触发通道准备下一批任务。检查点保存轮次现场，任务写入记录保存已完成工作，二者共同支持暂停、失败恢复和历史重放。运行中的控制还分为等待人工输入、当前轮次收尾后停止，以及取消正在执行的任务，各自拥有不同的退出和恢复边界。

本系列沿这些真实执行过程解释核心实现。每篇头部保留相对于 LangGraph 仓库根目录的路径与函数入口，正文中的源码保留原始语句，只翻译注释并标明省略。应用示例与执行数据推演另行标注，避免把说明代码当成框架实现。

## 源码基线

分析项目为 **LangGraph Python monorepo**。本系列对应源码树声明的 `langgraph 1.2.10`、`langgraph-prebuilt 1.1.0`、`langgraph-checkpoint 4.1.1`；分析目录为 `D:/open_code/ai-native/langgraph-main`。

该副本不含 Git 元数据，**commit 未知**。包版本来自各自 `pyproject.toml`，不据此保证内容与同名发布 tag 完全一致。以下文件 SHA-256 指纹记录本文引用的具体实现；行号仅对这份副本有效，阅读其他版本时应优先按函数名定位。

<details>
<summary>展开源码文件指纹</summary>

| 相对路径 | SHA-256 |
| --- | --- |
| `libs/langgraph/pyproject.toml` | `0e56b26bc402b863133dae89e52e4ff47bdf551f9e381dd7db0c4c192897cac3` |
| `libs/prebuilt/pyproject.toml` | `700afe262e07a0301190d07c6ff85ae03e1fd1aee2b04b52ac174f507217c0dd` |
| `libs/checkpoint/pyproject.toml` | `8dd841e77d1c33fc2dbbc6dadf35b0a167d4ec9f6a10818ee144be6347032de6` |
| `libs/checkpoint/langgraph/checkpoint/base/__init__.py` | `d29511015e2801630f6580353c107104d4ecc86e4bd14e15cd54e2b861a48e26` |
| `libs/langgraph/langgraph/_internal/_config.py` | `a0f8b4533ab09aeeb7b477d47e4e9a69a47d03abf0de0909c087bc2aabe1e00e` |
| `libs/langgraph/langgraph/channels/binop.py` | `85dbe7cdd3cea5f2973dbf3f358ad04c61c7b8dad5dc74a579739aa328a1b54e` |
| `libs/langgraph/langgraph/channels/delta.py` | `c7de0e212055fcbc6508ef39fa6080653f9e7d25554c093b1507970feca03435` |
| `libs/langgraph/langgraph/channels/last_value.py` | `36cbc586aeaac0f8c9b5a8d8b903039023a7d24294408391eb8c7f10aab3a308` |
| `libs/langgraph/langgraph/channels/untracked_value.py` | `ea15573ce7899269b75b4aa81dec04a08a5efc7b0887d64bb8ff9810155aafee` |
| `libs/langgraph/langgraph/func/__init__.py` | `f07e4a9f9bac75e2b48ac987fb91ca8c13a0a3d40723aa1997840bcde56732b7` |
| `libs/langgraph/langgraph/graph/message.py` | `c811816a1367cd2af060a46724dbd2802ccd7c25f5d94f1d9c0dd127092be6e8` |
| `libs/langgraph/langgraph/graph/state.py` | `39712e49133f2bf31ab607ac551761d396ecdbcd1ffdde1c3e0812537ddd4e6e` |
| `libs/langgraph/langgraph/pregel/_algo.py` | `29d54dc6704e4e4a0385d36317faa74f4fa2ceefd6836aca03f1938b9fa51fa5` |
| `libs/langgraph/langgraph/pregel/_call.py` | `38aa434fc1624e4e2e9140729b8b750f78cd17012620fcb33458a63585e8793d` |
| `libs/langgraph/langgraph/pregel/_loop.py` | `33150cf70fc08fd01affeae0345aa20569d2705704e3d209733d9c7b43dd5c0a` |
| `libs/langgraph/langgraph/pregel/_retry.py` | `667a74090e23fda724e74ad377586e32325510cdd9042d320d60306f783f0a9d` |
| `libs/langgraph/langgraph/pregel/_runner.py` | `316cf133c724163a18ef279322615588b3fa8b96e359289a7cadea90f0df7622` |
| `libs/langgraph/langgraph/pregel/main.py` | `02651dc9471b88f9299d12f6d836e67ad1114ad84498b9ae26df6cd75be8592c` |
| `libs/langgraph/langgraph/stream/run_stream.py` | `bd96e3964931e59373c7923f3b42024cf15249686ea6c106ac8ec6d54a11263b` |
| `libs/langgraph/langgraph/types.py` | `8ba8895d3c1aec51e5ef24d09d983031f52c32939876fd5c63b92fabbb1a1fee` |
| `libs/prebuilt/langgraph/prebuilt/tool_node.py` | `3c6380e257718a0e2753d7ae890bfcbf9edfe0f726f32a7b844f96630bf363a4` |
| `libs/langgraph/langgraph/runtime.py` | `5a5e3aad147f67397481ea47c67cde97938d85b5762a7aa4d4ce511dcd693c42` |
| `libs/langgraph/langgraph/pregel/_executor.py` | `5afb1e7e7bd768fc5ff7ed5e222539abb73bd11f88d8e150eb75c30a8484364d` |
| `libs/langgraph/langgraph/errors.py` | `545e23178efd6159db1dd11c79411103f809b469cea1fa2f92360f61565f00a0` |

</details>

## 一、先建立一条完整执行链

```text
StateGraph：声明字段、节点与边
  → compile：安装通道、触发关系和输出写入器
  → invoke / stream：创建本次运行
  → Loop：读取检查点或输入，准备任务
  → Runner：执行任务，暂存并记录写入
  → apply_writes：归并字段、推进通道版本
  → 保存检查点，准备下一轮或返回结果
```

State（状态）是节点读取和更新的业务数据；Channel（通道）保存一个字段或控制信号；reducer（归并函数）规定多份更新怎样合成新值；task 是某次节点调用的执行实例；superstep（超级步）是准备、执行和提交一批任务的轮次。

例如两个检索节点同轮返回结果，Runner 可以先报告其中一个已经完成，但下游正常任务要等轮次提交后才能读到合并状态。如果另一个失败，已经保存的任务写入可在恢复时复用；这不等于外部 HTTP 请求获得“恰好一次”语义。

## 二、文章地图

| 文章 | 沿哪条实现链阅读 | 需要理解的边界 |
| --- | --- | --- |
| [00 项目总览与执行主线](./00-project-overview-and-repository-structure.md) | 输入 → 隐藏 START → 节点 → 提交 → 返回 | 构建器、编译结果、运行实例 |
| [01 State、Channel 与 Reducer](./01-state-schema-channels-and-reducers.md) | Schema → 通道选择 → 分组写入 → reducer | 并行覆盖、消息 ID、增量保存 |
| [02 Builder 与编译](./02-stategraph-builder-and-compilation.md) | 节点登记 → 输入与 writers → 普通边、屏障、条件边 | 数据字段与触发信号，条件路由的局部视图 |
| [03 Pregel 调度与提交](./03-pregel-supersteps-and-scheduling.md) | tick → 任务准备 → Runner → 重试或超时 → 结果提交 | 超时后的迟到写入，完成与持久保存的时间差 |
| [04 Send 与 Command](./04-dynamic-routing-and-send.md) | 控制对象 → 通道写入 → 动态任务 → 共享状态 | 独立输入、静态边叠加、跨图命令 |
| [05 子图与状态边界](./05-subgraphs-and-cross-graph-control.md) | 父任务 → 子图调用 → 子图输出 → 父图归并 | 状态映射、命名空间与恢复重跑 |
| [06 检查点、恢复与分叉](./06-checkpoints-store-and-recovery.md) | 任务写入 → 检查点 → 加载 → 继续或重放 | durability、查询视图、Store 与副作用 |
| [07 中断、停止与恢复](./07-interrupts-and-command.md) | interrupt / drain / 取消 → 执行边界 → 保存与恢复 | 人工暂停、停止按钮、取消传播与外部副作用 |
| [08 流式输出与事件](./08-stream-system.md) | 事件产生 → 队列 → 投影消费 → abort 与清理 | 停止消费、关闭连接与停止执行的区别 |
| [09 工具执行与参数注入](./09-prebuilt-tool-layer.md) | 输入解析 → 运行上下文 → 参数注入 → 调用 → 消息 | 错误转换、可信参数与工具恢复粒度 |
| [10 函数式工作流](./10-func-api-entrypoint-and-task.md) | entrypoint → Pregel → task Future → 结果复用 | 调用顺序、previous 与缓存区别 |

初读按 00—03 建立执行模型，再按需要读控制流与子图（04—05）、持久化与中断停止（06—07）、观察与扩展层（08—10）。需要实现 Agent 停止按钮时，从第 07 篇区分控制语义，再结合第 03 篇理解超时与任务清理、第 06 篇判断进度能否恢复、第 08 篇处理流式连接和运行对象的退出。

## 三、和 LangChain、Deep Agents 怎样衔接

LangGraph 负责运行图；LangChain 的 `create_agent()` 装配模型、工具和中间件形成的 Agent 图；Deep Agents 的 `create_deep_agent()` 在其上加入规划、文件和上下文管理等能力。

例如“一次模型响应中的多个工具如何并行”涉及两个具体机制：ToolNode 可在一个节点任务内部使用执行器，也可以由上层路由用多个 Send 创建独立图任务。前者没有逐工具的图级结果恢复，后者可以按各 task ID 保留成功写入。要理解装配策略，可以接着读 [LangChain create_agent](../langchain/03-create-agent-assembly.md)；要理解框架提供的运行时边界，继续读本系列的调度与工具章节。
