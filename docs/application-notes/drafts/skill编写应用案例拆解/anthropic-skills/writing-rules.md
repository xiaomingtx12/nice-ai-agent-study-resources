---
sidebar_position: 2
title: "Anthropic Skills 的实现分析方法：先还原链路，再抽象规则"
description: 以 skill-creator 和 mcp-builder 为样本，说明如何从入口、状态、消费者和失败边界分析 Skill，而不是把 SKILL.md 改写成教程。
---

# Anthropic Skills 的实现分析方法：先还原链路，再抽象规则

## 一、先还原端到端链路

分析 Skill 时先问“谁调用谁”，不要先给目录贴标签。

### `skill-creator`

```text
用户意图
  → SKILL.md 分流
  → evals.json
  → with_skill / baseline
  → grading.json
  → benchmark.json
  → 人工反馈与下一轮修改
```

这是 `SKILL.md:44-287` 描述的任务质量链。description 优化另走一条脚本链：

```text
trigger eval set
  → run_eval.py
  → run_loop.py
  → improve_description.py
  → held-out test 选择版本
```

这两条链的输入、评分方式和选择目标不同，不能压缩成一个“自动优化 Skill”。

### `mcp-builder`

```text
transport
  → ClientSession.initialize()
  → list_tools()
  → Claude tool_use
  → call_tool()
  → tool_result
  → <response>
  → 精确答案评分
```

这条链来自 `scripts/connections.py` 和 `scripts/evaluation.py`。`SKILL.md` 的 Research、Implementation、Review/Test、Evaluation 是指导模型工作的文档流程；`evaluation.py` 才是当前快照中实际运行评测的程序。

## 二、沿四个问题读每个节点

每个源码片段都应回答四件事：

1. **输入**：函数或阶段接收什么；
2. **状态**：中间结果放在哪里、怎样变化；
3. **消费者**：谁读取输出并决定下一步；
4. **代价**：这层减少了什么不确定性，又增加了什么依赖。

例如 `connections.py:list_tools()` 不是“获取工具列表”这么简单：它把 MCP 对象转成评测代理需要的 `name`、`description`、`input_schema`。下游 `client.messages.create()` 消费的正是这个字典结构。相反，`outputSchema`、`structuredContent` 和 annotations 在本快照中主要是 `mcp-builder/SKILL.md` 的设计要求，并没有出现在这个转换函数的返回值中。

## 三、案例对照

| 观察层 | `skill-creator` | `mcp-builder` |
| --- | --- | --- |
| 主入口 | 根据用户所处阶段分流 | 四阶段工作流说明 |
| 中间状态 | eval、transcript、grading、benchmark | ClientSession、tool result、XML response |
| 证据消费者 | grader、analyzer、viewer | 精确答案比较与报告汇总 |
| 主要边界 | 触发质量与任务质量分离 | 工具建议与脚本实际能力分离 |
| 主要成本 | 多轮模型运行与评测工作区 | SDK、transport 和稳定数据依赖 |

这个对照只用于定位差异，不把两个案例抽成同一种 Skill 模板。

## 四、从实现抽出的规则

### 1. 合同来自消费者

`skill-creator` 的 grading 字段需要使用 `text`、`passed`、`evidence`，因为 viewer 和后续分析读取这些字段。`mcp-builder` 的 XML `<response>` 需要保持可提取，因为 `evaluate_single_task()` 用它和答案做比较。

所以文章应从下游消费者反推接口，而不是把字段名称当作写作风格问题。

### 2. 主文件负责分流，资源文件负责展开

`skill-creator/SKILL.md` 负责决定当前进入意图采集、评测、迭代还是 description 优化；`agents/`、`references/` 和 `scripts/` 分别承载评分规则、数据契约和确定性操作。`mcp-builder/SKILL.md` 负责决定读取通用、Node、Python还是评测资料。

“渐进披露”在这里是资源路由事实。至于它是否在某个具体宿主中按同样的上下文策略执行，不能只由目录结构推导。

### 3. 文档建议不能冒充执行事实

`mcp-builder/SKILL.md:97-123` 建议使用 output schema、structured content 和工具 annotations；`connections.py:54-69` 实际只导出 `name`、`description` 和 `input_schema`。文章必须写出这两个层次的差异。

同理，`SKILL.md` 要求 with-skill 和 baseline 同轮启动，但 `run_loop.py` 的实现是先把 train/test 合并批量运行，再按 query 字符串回分。文档意图和脚本实现需要分别描述。

### 4. 失败路径比成功路径更能说明边界

`evaluation.py` 把工具调用异常转成带 traceback 的 tool result，继续交回模型；但 `agent_loop()` 只在 `stop_reason == "tool_use"` 时进入循环，没有显式处理 `pause_turn` 或 `refusal`。这类缺口比“支持 MCP 评测”更能说明当前实现的真实范围。

## 五、常见误读

- 把 `.skill` ZIP 当成 Claude Code runtime 的安装或注册机制；
- 把 `run_eval.py` 的临时 `.claude/commands` 当成最终交付目录；
- 把 `outputSchema`、annotations 等文档建议写成 `connections.py` 已经传递的字段；
- 把 `run_loop.py` 的批量运行写成完整的实验隔离保证；
- 把 `evaluation.py` 说成并行评测，当前实现按 QA pair 串行处理；
- 把旧默认模型 `claude-3-7-sonnet-20250219` 写成当前推荐模型；
- 只依据 README、目录名或标题推断调用关系。

后续分析继续使用“源码摘录—调用关系—边界—代价”的顺序。抽象规则必须能回指到具体文件；不能回指的内容应标成推论或删除。
