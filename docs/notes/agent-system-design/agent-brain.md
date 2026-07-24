---
sidebar_position: 4
description: "Agent 大脑工程经验——按 6 大本质问题组织：循环退出信号设计 / 思考深度物理切断 / 撞墙后决策路径 / 状态归属取舍 / 失败可观测机制 / 跨进程续做最小持久化。每章配编写与维护侧的作者选型经验、反模式、何时不该用与样本索引。"
---

# Agent 大脑篇

LLM 本身无状态（每次调用不携带上次会话记忆），但任务有上下文——要办完一件事，必须把模型调用套进一条循环，让它能想一步做一步、做一步看一步，错了重试、成了收口。这一层抽象通常叫 Harness（驾驭LLM）——它把"思考—行动—观察"三件事用一个循环骨架包起来，让模型能办完一件多步任务。

正文按 **6 大本质问题**组织。这 6 个问题是任何 Agent 系统上线前必须回答清楚的"约束设计题"，每问错答都有具体的工程代价：循环空转 / 思考浅 / Plan 死循环 / 失忆 / 静默失败 / 跨进程全断。

> 1. **循环该怎么停**——退出信号的设计
> 2. **模型想多深**——思考深度的物理切断
> 3. **撞墙后怎么决策**——错误信号的分类
> 4. **状态放哪儿**——进程内 vs 进程外
> 5. **错到哪里知道**——失败可观测 vs 静默吃掉
> 6. **跨进程能续吗**——断点续传的最小集合

这 6 问的工程答案不互相孤立：**模型自然结束 + 退出硬护栏**是问题 1 的答案，**Plan-Execute 物理切断**是问题 2 的答案，**硬错/软错分流**是问题 3 的答案，**状态对象 6 字段 + 双文件协议**是问题 4 的答案，**Recovery Hints + Doom Loop + System Reminders**是问题 5 的答案，**进程重启后的三步嗅探（嗅探→读取→校验）**是问题 6 的答案。

正文按两个观察面展开：

- **加载与执行侧**——运行时怎么跑（每问的具体工程答案）
- **编写与维护侧**——作者怎么搭这套引擎（每个答案的选型经验）

---

## 一、动机

Agent 大脑处在 LLM 单次推理与业务系统之间——它把这两种形态合成一种复合工程层：

- **循环骨架借用业务系统的事务思想**——提交 / 回滚 / 检查点，每轮"思考—行动—观察—修复"对应一次事务边界
- **思考分层借用 LLM 自身的提示词工程**——慢思考注入、Self-Refine 自打分都属于提示词层面，但通过"物理切断"成为循环层的工程
- **状态对象与外部化独立**——这是 Agent 大脑独有的设计：把"我在做什么、下一步是什么"既存在内存也写盘，让进程崩溃后能续做、让 IDE 能介入

三条合起来给出 Agent 大脑的工程身份。类比：数据库事务引擎仍跑在 CPU 之上（每条 SQL 仍是单次计算），但事务 / 锁 / 恢复这套封装让它成为独立的工程层。Agent 大脑同理——"循环层"指的是它夹在 LLM 推理与业务系统之间，不是等级居中。

### Agent 大脑 vs 相邻篇的边界

Agent 大脑 **不是** 单独的某一个机制，而是循环层的整体设计——它是其他几篇的"宿主"：

| 维度 | Agent 大脑（本篇） | 与相邻篇的关系 |
|---|---|---|
| **位置** | 全程（每轮都跑）| 宿主层 |
| **输入** | 上一轮状态 + 当前 observation + 历史 | 上下文组装请见 [Context 篇](./agent-context-management.md)；意图识别请见 [Intent 篇](./agent-intent-recognition.md) |
| **输出** | 思考文本 + 行动决策（继续 / 调工具 / 回复 / 退出）| 工具怎么描述 / 注册 / 限权请见 [Tool 篇](./agent-tool-calling.md) |
| **核心张力** | 6 大本质问题（见导读） | — |
| **失败兜底** | Replan / 反思 / 退到上一步 | 多 Agent 协作请见 [Multi-Agent 篇](./agent-multi-agent-orchestration.md) |
| **类比** | 数据库事务引擎 | Intent 是入口分诊台，大脑是持续运转的事务层 |

RAG / Skill 也跟大脑篇有交集——这些是大脑在"做什么"层面的封装（知识从哪来、领域 SOP 怎么挂），大脑篇只处理单一 Agent 内循环层本身的工程约束。

---

## 二、关键判断速览

按 6 大本质问题分组：

### 问题 1 · 循环退出的信号设计

- 循环的"for 还是 while"是循环控制结构的选择（语法层），不解决工程层的"怎么停"问题
- 退出信号必须按"成功 / 失败硬护栏 / 用户主动"三类分流，**deny 优先**——用户主动 > 失败硬护栏 > Hook 拦截 > 成功自然结束
- 6 种 terminal reason 各自走不同处理路径：成功直接收；失败必须落 checkpoint + 对外报错不能静默；用户主动走用户信号处理
- 7 种 continue reason 走"先修复后退出"——prompt 太长压缩 / 输出截断扩容量 / hook 报错反馈 LLM；每种必须设修复次数上限防重试风暴
- 退出信号源不能依赖 SDK 的 `stop_reason`，得用工程层定义的 `needsFollowUp` 标志

### 问题 2 · 思考深度的物理切断

- 模型在工具可用时倾向立即 `tool_use`——这是物理特性，不是提示词能完全约束的
- Plan-Execute 核心是**物理切断**：Phase 1 注册 `tools=[]`，Phase 2 才注入完整工具；`tools` 字段是结构化信号压倒提示词软约束
- 任务节奏按可验证性分流：开放问答 → 提示词注入 / 结构化任务 → Plan-Execute 物理切断 / 输出可验证 → Self-Refine
- Self-Refine 必须有可验证输出标准（编译过 / 测试过 / 字符串匹配），没有时自打分是循环论断

### 问题 3 · 撞墙后的决策路径

- 错误信号按特征分三路：硬错（基础设施层失败）→ Replan / 软错（执行层偏差）→ 反思 / 信息不足 → 重新 Plan
- 混淆硬错和软错会让 Plan 反复推翻自己浪费 token——软错走 Replan 是浪费，Plan 没错只是当前步偏差
- Replan 必须有 N=3-5 次强制退，防止"Replan → 失败 → Replan"死循环直到 maxTurns
- 反思只改当前一步假设，不动整体 Plan；改 Plan 才升级 Replan——粒度边界决定 token 流向

### 问题 4 · 状态归属的工程取舍

- 状态对象 6 字段（`step` / `total_tokens` / `tools_executed` / `elapsed_seconds` / `last_output` / `observations`）是撞墙式追加设计的——每个字段保留对应一个曾发生过的问题，没撞过的字段就是伪字段
- 跨进程长程任务必须状态外部化：`PLAN.md` 写架构级约束 + `TODO.md` 写颗粒度 Checklist；每完成一步立即打勾不事后补
- Plan Mode 是**用户的开关**不是 Agent 自动判断——简单任务不该外部化（写盘开销 + Plan 僵化）
- 进程重启后的三步嗅探（嗅探 → 读取 → 校验）必须顺序执行——防止读到部分写入文件

### 问题 5 · 失败可观测的工程机制

- 工具报错不能让模型只会机械道歉——按 `toolName + 错误关键字` 分类，在 ToolResult 尾部追加 `[系统救援指南]`
- Domain Error Code（`ERR_FILE_NOT_FOUND`）比 `strings.Contains` 正则匹配稳——错误码是协议层稳定信号
- Doom Loop 检测：相同 ToolCall（`md5(toolName + args)`）连续失败 ≥3 次 → 触发 System Reminders 强行打断
- System Reminders 必须伪装成用户消息（`Role: User`）注入会话末尾，利用近因偏差（Recency Bias）抢占注意力——Transformer 注意力机制的物理特性必须利用

### 问题 6 · 跨进程续做的最小持久化

- 完整的"断点续传"不可能——LLM 节点本身不可重放（同 prompt 两次不返回完全相同）
- 折中是"最小可恢复集合"：`PLAN.md` + `TODO.md` + 关键决策点 + 用户明示语境；中间产物不必持久
- 进程重启后必须先 `ls` 嗅探判断"全新任务 / 续传任务 / 异常状态"分流

### 编写与维护侧

- 退出信号源选型：用工程层定义的 `needsFollowUp` 标志，不用 SDK 的 `stop_reason`
- Plan-Execute 物理切断的接缝点是 `tools=[]`——不是 prompt 提示
- Replan 阈值 N=3-5 必须跑评测校准：`maxTurns / 5` 是硬上限
- Doom Loop 阈值 ≥3 起步，fingerprint 必须含 args 否则路径变化就重置
- Recovery Hints 优先 Domain Error Code，回退 `strings.Contains`
- 状态对象 6 字段撞墙式追加，不要设计先行

---

## 三、循环退出的信号设计

**问题：循环该怎么停？**

循环的"for 还是 while"是循环控制结构的选择（语法层），不直接解决工程层的"怎么停"问题。真正要回答的是三个正交维度：

- **谁说了算退出？**——固定 N / 条件判断 / 模型自然结束 / 结构信号
- **最坏情况怎么兜？**——`maxTurns` 兜底硬护栏
- **哪些退出是"用户主动"？**——必须与"失败硬护栏"分路径处理

### 3.1 退出信号源：needsFollowUp 不依赖 SDK stop_reason

每轮把 LLM 返回强制归类：纯文本（`completed`）进入退出判断；工具调用 + 配套文本（`action`）走主线执行工具。

退出门控的来源是 `needsFollowUp` 标志——实际是否收到 `tool_use` block。**不要依赖 SDK 的 `stop_reason` 字段**：SDK 不总是正确设置，会让循环要么空转要么立即崩。

| 返回内容 | 归类 | 后续路径 |
|---|---|---|
| 纯文本 + 无 tool_use | `completed` | 进入退出判断 |
| 工具调用 + 配套文本 | `action` | 执行工具，结果作为 Observation |
| 只有 tool_use 无配套文本 | `action`（异常配对） | 仍执行，但记录提示模型下次补 text |

`stop_reason="end_turn"` 和 `stop_reason="max_tokens"` 在循环层语义完全不同——不区分"已完成"和"被截断"会让循环层失灵。

**AI 消息与工具调用的配对约束**：tool_use block 必须和 text block 同 message（Anthropic API 协议层约束），循环层要做归一化处理。单发 `tool_use` 无配套 `text` 会让模型下一轮困惑——它不知道"为什么被调用了工具"也不知道"它自己说了什么"。

### 3.2 6 种 terminal reason 三类信号分流

| 类别 | terminal reason | 触发条件 | 处理路径 |
|---|---|---|---|
| 成功 | `completed` | LLM 自然结束，无 tool_use | 直接收 |
| 成功 | `stop_hook_prevented` | Stop hook 明确拒绝退出 | 直接收 |
| 失败 | `max_turns` | turnCount 达到 maxTurns 上限 | 落 checkpoint + 对外报错 |
| 失败 | `prompt_too_long` | 上下文压缩等恢复路径全部失败 | 落 checkpoint + 对外报错 |
| 用户主动 | `aborted_streaming` | 流式接收阶段用户按 Ctrl+C | 用户信号处理 |
| 用户主动 | `aborted_tools` | 工具执行阶段用户按 Ctrl+C | 用户信号处理 |

关键纪律：

- **失败类不能静默吃掉**——`max_turns` 是循环结构性问题，不报就丢了根因；`prompt_too_long` 是压缩策略失效，不报就丢了窗口诊断
- **用户主动类是 UI 层信号，不是循环逻辑**——必须走用户信号处理路径（清理未完成写入、释放工具资源）
- **退出优先级 deny 优先**：用户主动 > 失败硬护栏 > Hook 拦截 > 成功自然结束——用户主动和失败类一旦误判为"成功自然结束"，Agent 会对中断视而不见

### 3.3 7 种 continue reason 先修复后退出

可恢复异常走"先修复"路径——修复成功回到顶部重试，修复失败再退出。这是 Agent 系统可靠性的关键：循环不是撞墙就跑，而是能自愈。

| 异常类型 | 修复手段 | 修复次数上限 |
|---|---|---|
| `prompt_too_long` | 上下文压缩（Observation Masking + Head-Tail Truncation） | 2 次 |
| 输出截断 | 扩 maxOutputTokens 或切分请求 | 2 次 |
| Hook 报错 | 把 hook 报错信息反馈给 LLM，让它改行为 | 1 次 |
| 工具瞬时失败（5xx） | 指数退避后重试 | 3 次 |
| 网络超时 | 重连 + 重试 | 3 次 |
| 流式中断 | 重发当前请求 | 1 次 |
| 其他可恢复 | 通用 retry with backoff | 1 次 |

修复次数上限防重试风暴。**关键诊断**：当前是 prompt 太大（压缩）/ 工具输出截断（扩容量）/ hook 报错（反馈 LLM）？诊断对了才能用对的那一层——压缩策略失效时扩容量是无效操作，扩容量是 SDK 配置不是循环逻辑能修的。

---

## 四、思考深度的物理切断

**问题：模型想多深？**

模型在工具可用时倾向立即 `tool_use`——这是物理特性，不是 prompt 能完全约束的。`tools` 字段是结构化信号（Anthropic API 协议层），`prompt` 文本是软约束，结构化信号压倒软约束。

所以工程问题不在于"怎么让模型想得更深"，而在于把"想深"做成可达的操作——物理切断，而不是 prompt 提示。

### 4.1 任务节奏三档分流

| 任务类型 | 推荐策略 | token 代价 | 适用场景 |
|---|---|---|---|
| 开放问答 | prompt 追加"请仔细思考" | 低（+10%） | 单轮推理、闲聊、模糊问题 |
| 结构化任务 | Plan-Execute 两阶段（物理切断） | 中（2x） | 多步操作、文件批量处理、迁移脚本 |
| 有可验证输出标准的任务 | Self-Refine（自打分后重写） | 高（2x+） | 代码生成、单测覆盖、文档校对 |

关键点：

- 开放问答用提示词追加"请仔细思考"够用——结构简单，思考深度有限，token 代价低
- 结构化任务必须 Plan-Execute 物理切断——提示词提示模型"先想再做"会被结构化信号压倒
- Self-Refine 仅对"输出可验证"的任务值得——开放式问答自打分不可靠

### 4.2 Plan-Execute 两阶段是物理切断

Plan-Execute 的核心是**物理切断**：

- Phase 1 节点注册**空工具列表**——模型调用 LLM 时 `tools=[]`，技术上拿不到任何 tool_use 资格
- Phase 1 输出是结构化 Plan（步骤列表 + 每步预期输出）——Phase 2 拿到 Plan 后按步执行
- 节点之间用文件 / 变量传递 Plan，不让 Phase 1 文本直接进入 Phase 2 的提示词

Dify 把这套模式落到产品：Plan 节点是纯推理节点（工具列表为空），Execute 节点拿到 Plan 后按部就班调工具。

为什么不能靠提示词提示：

> 模型在工具可用时倾向立即 `tool_use`——`tools` 字段是结构化信号，提示词文本是软约束，结构化信号压倒软约束。物理切断是约束生效的唯一方式。

### 4.3 Self-Refine 必须有可验证输出标准

```python
for attempt in range(max_refine_attempts):
    output = model.generate(input, feedback if attempt > 0 else None)
    score = verifier.check(output)  # 编译 / 测试 / 字符串匹配
    if score >= threshold:
        return output
    feedback = verifier.explain(output)
return output  # 达到上限仍返回最后一次
```

没有可验证标准时，Self-Refine 等于让模型反复打磨同一个错误方向——自打分是循环论断。token 代价是 Plan-Execute 的 2 倍以上，慎用——只有"输出错一次成本极高"的任务才值得。

---

## 五、撞墙后的决策路径

**问题：撞墙后怎么决策？**

错误信号有三种完全不同的处理路径。混淆它们会让 Plan 反复推翻自己浪费 token，或让 Plan 在正确方向上停滞不前。

### 5.1 硬错 / 软错 / 信息不足分流

| 错误类型 | 典型信号 | 处理路径 | 改动范围 |
|---|---|---|---|
| 硬错 | API 失败 / 权限拒绝 / 工具不存在 / schema 不匹配 | Replan：从头重排 Plan | 整体 Plan 推翻 |
| 软错 | 工具返回成功但结果不符预期 / 部分完成 / 数据格式错 | 反思：只改当前这一步的假设 | 当前一步假设 |
| 信息不足 | 模型不知道下一步该做什么 / 列举多个可能性 | 重新 Plan（不算 Replan） | 还没成形 |

边界判定：

- **硬错的特征**是"基础设施层失败"——上游不允许这个操作发生，Plan 整体假设被推翻，必须 Replan
- **软错的特征**是"执行层偏差"——Plan 没错，只是某一步的具体执行方式不对，只改这一步的假设就够
- **信息不足的特征**是"Plan 不存在"——模型还没想清楚，不是 Plan 错了，是 Plan 还没成形

混淆硬错和软错会让 Plan 反复推翻自己浪费 token——硬错走 Replan 是必要的，软错走 Replan 是浪费。

### 5.2 Replan 必须有 N=3-5 次强制退

Replan 是从头重排 Plan 的工程操作——把当前 Plan 整个丢掉，让模型从零开始想。Replan 代价极高：

| N 值 | 后果 |
|---|---|
| N=1 | 太激进——单次硬错就推翻 Plan，整体稳定性差 |
| N=3-5 | 较合理——给 Plan 留重试空间，又不陷入死循环 |
| N>5 | 几乎必然跑飞——大概率陷入"Replan → 失败 → Replan"死循环直到 maxTurns |

不设上限 = 陷入"Replan → 失败 → Replan"死循环，直到 maxTurns。Replan 触发时落 checkpoint，记录 Plan 历史便于事后归因——**Replan 不是失败信号，是"Plan 假设需要更新"的工程操作**。

### 5.3 反思只改当前一步的假设

反思（Reflection）只改当前这一步的假设，不动整体 Plan。反思的实现形式：

- 工具返回结果后，让模型评估"这次结果是否符合预期"
- 不符合预期 → 改当前步的执行方式（换一个工具 / 换一个参数 / 换一个顺序）
- 符合预期 → 继续下一步

| 维度 | 反思 | Replan |
|---|---|---|
| 改动范围 | 当前一步 | 整体 Plan |
| token 代价 | 低（几百 token） | 高（几千 token） |
| 触发条件 | 软错 | 硬错 |
| 频率 | 高（每步都可能反思） | 低（每 Plan 至多 N 次） |

改 Plan 才升级到 Replan——反思是微调，Replan 是重排，粒度边界决定 token 流向和系统稳定性。

---

## 六、状态归属的工程取舍

**问题：状态放哪儿？**

每个 Agent 都会撞到这道题：状态在内存还是写盘？哪些状态必须持久化？哪些可以丢？

### 6.1 状态对象：撞墙式追加的 6 字段

每轮循环给模型的前置信息 = 状态对象：

```python
state = {
    "step": 0,
    "total_tokens": 0,
    "tools_executed": 0,
    "elapsed_seconds": 0.0,
    "last_output": {},
    "observations": [],
}
```

每个字段对应一个撞过的问题：

| 字段 | 解决的问题 | 不加时的症状 |
|---|---|---|
| `step` | 防死循环 | 模型无限重试同一工具调用 |
| `total_tokens` | 规划预算 | 上下文撑爆后才被动压缩 |
| `tools_executed` | 任务进度可视化 | Agent 不知道自己做了多少 |
| `elapsed_seconds` | 超时判断 | 长任务不知道卡哪一步 |
| `last_output` | 工具结果回填 | 模型忘记上一次调工具的结果 |
| `observations` | 让模型看到工具结果 | 工具结果被吞，模型盲做下一步 |

**关键纪律**：说不出来的字段就是设计先行的伪字段，撞过墙才知道该补。状态对象是事后追溯，不是事前预设。Claude Code 的 `autoCompactTracking` / `maxOutputTokensRecoveryCount` / `hasAttemptedReactiveCompact` 都是这一类——每个字段背后都对应一个曾经撞过的恢复路径。

字段名要"读得出来解决什么"——这是状态对象设计纪律的硬约束。

### 6.2 PLAN.md + TODO.md 双文件协议

跨进程 / 跨会话长程任务必须把"我在做什么、下一步是什么"外部化成文件——让进程崩溃后人类也能用 IDE 直接编辑纠偏、Agent 重启后 `read_file` 一次即恢复。

`PLAN.md` 和 `TODO.md` 是分工的两个文件：

| 文件 | 内容 | 更新频率 | 谁来读 |
|---|---|---|---|
| `PLAN.md` | 架构级约束（高层目标、关键决策、模块划分） | 任务级（Plan 变更时） | Agent + 人类 |
| `TODO.md` | 颗粒度 Checklist（单步可勾的动作） | 步骤级（每完成一步） | Agent + 人类 |

每完成单步立即 `edit_file` 改勾（`- [ ]` → `- [x]`），绝不"事后一锅端"——事后改勾会让断点续传失效，Agent 重启后不知道哪些步已经做完。Markdown Checkbox 是 git diff 友好的进度追踪。

双文件协议的工程意义：把"当前进度"和"整体规划"分离，让人类能在不改 Plan 的前提下介入 Todo（纠偏某一步），也能在不改 Todo 的前提下重排 Plan（调整整体策略）。

### 6.3 Plan Mode 开关避免简单任务被官僚化

Plan Mode 只在用户主动开时注入"先 ls 嗅探 → 创建/续读 PLAN&TODO → 单步完成立即打勾"这套 SOP。**Plan Mode 是用户的开关，不是 Agent 的自动判断**。

简单任务不该走 Plan Mode：

- 单步问答（"Python 怎么打印字典"）——直接调 API 即可，外部化是浪费
- 单文件操作（"读这个文件然后总结"）——几步内完成，写盘开销大于收益
- 一次性脚本（"帮我跑一下这个命令"）——执行完即结束，跨进程语义不存在

Plan Mode 的副作用：外部化有写盘开销、有 Plan 僵化风险——Plan 一旦写入 `PLAN.md` 就成了锚点，Agent 不敢轻易推翻自己（怕 git 历史混乱），反而牺牲灵活性。

Plan Mode 的触发条件：用户明确开 / 任务确实跨多个子任务且不可中断 / 跨进程长程（一次性跑几小时那种）。

---

## 七、失败可观测的工程机制

**问题：错到哪里知道？**

每个 Agent 系统在生产环境都会撞这道题：模型只会机械道歉、Doom Loop 反复同一工具、注意力衰减吃了远端 System Prompt——三个独立机制处理。

### 7.1 Recovery Hints：ToolResult 尾部的行动指令

工具报错不能让模型只会机械道歉——按 `toolName + 错误关键字` 分类，在 ToolResult 尾部追加 `[系统救援指南]`。

```python
def on_tool_result(tool_name, args, error_msg, tool_result):
    hint = classify_error(tool_name, error_msg)
    if hint:
        tool_result += f"\n\n[系统救援指南] {hint}"
    return tool_result
```

Domain Error Code（`ERR_FILE_NOT_FOUND` / `ERR_EDIT_FUZZY_MATCH_FAILED`）比 `strings.Contains` 正则匹配稳——错误码是协议层稳定信号，关键字是字符串层脆弱信号。工业级升级方向：

| 匹配方式 | 鲁棒性 | 维护成本 |
|---|---|---|
| `strings.Contains` 关键字匹配 | 低（误报 / 漏报） | 低（加关键字即可） |
| Domain Error Code 匹配 | 高（协议层稳定） | 中（需要工具层协议化） |
| 工具自描述救援指南 | 最高（工具自己最懂） | 高（每个工具都要写指南） |

错误关键字匹配是上游（工具层 → Reporter），错误自愈指令注入是下游（Reporter → 上下文层）——两层职责清晰。

### 7.2 Doom Loop 检测 = 指纹 + 连续失败计数

Doom Loop / Exploration Spiral：Agent 反复调同一个工具 / 同一组参数，但每次都失败，直到 token 烧光。

```python
fingerprint = md5(tool_name + json.dumps(args, sort_keys=True))
consecutive_failures[fingerprint] += 1
if consecutive_failures[fingerprint] >= 3:
    inject_system_reminder(...)
    consecutive_failures[fingerprint] = 0  # 重置防持续触发
```

`fingerprint = md5(toolName + args)` 做 ToolCall 指纹——相同指纹计数累加，不同指纹互不影响。阈值经验值 ≥3 次，触发 System Reminders 注入。

Doom Loop 指纹的语义等价漏洞：`read_file{"/tmp/a.txt"}` 和 `read_file{"./../tmp/a.txt"}` 在 MD5 下不同——路径归一化（Normalization）是补丁方向（统一相对路径、去掉空格、规范化编码）。

Doom Loop 与 Replan 的边界：Doom Loop 是"反复调同一工具"的死循环检测，触发后注入 System Reminders 而非直接 Replan；Replan 是"硬错后从头重排 Plan"，触发时落 checkpoint——两者触发源不同，Doom Loop 是工具层频繁失败，Replan 是执行层 Plan 失败。

### 7.3 System Reminders 是近因偏差的工程利用

System Reminders 必须伪装成用户消息（`Role: User`）而非系统消息（`Role: System`）注入会话末尾。注入位置：会话末尾，伪装成最新用户消息。

工程原理：

- 系统提示词在远端（消息列表最前），注意力权重低
- 最新用户消息在近端（消息列表最后），**近因偏差（Recency Bias）** 让其注意力权重最高——Transformer 训练时学到的"靠近末尾的消息更重要"
- **中间衰减（Lost-in-the-Middle）**：上下文中间位置注意力最低，远端系统提示词也吃这个亏

`[SYSTEM REMINDER 警告]` 伪装成用户消息是工程利用——前提是模型训练时见过该模式（Claude / GPT 都见过 `<|im_start|>user\n[SYSTEM REMINDER ...]`，这是训练时形成的格式预期）。Recency Bias + Lost-in-the-Middle 是工程利用、不是临时补丁——Transformer 注意力机制的物理特性必须利用。

System Reminders 的触发条件：Doom Loop 检测触发（微观触发）/ Plan 重大变更（宏观触发）。微观触发是工具层频繁失败，宏观触发是循环层检测到整体策略偏移——两类触发共用同一注入机制，但触发源不同。

---

## 八、跨进程续做的最小持久化

**问题：跨进程能续吗？**

### 8.1 完整断点续传是不可能的

LLM 节点本身就不可重放——同一 prompt 两次不会返回完全相同的输出。**完整的"断点续传"工程上不可能**，任何号称能做到的都是任务级特例或受控场景。

### 8.2 折中：最小可恢复集合

| 必须持久化 | 可丢失 |
|---|---|
| 整体 Plan（PLAN.md）| 单轮思考文本 |
| 颗粒度 Checklist（TODO.md）| 工具瞬时输出 |
| 关键决策点 | 子 Agent 中间产物 |
| 用户明示语境 | 流式 buffer |

PLAN-TODO 双文件协议就是这种"最小持久化"的工程实现（见 §6.2）。

### 8.3 进程重启后必须先环境嗅探

Agent 重启后第一步**不直接读** `PLAN.md` / `TODO.md`——先 `ls` 嗅探文件是否存在：

| 嗅探结果 | 判定 | 后续路径 |
|---|---|---|
| `PLAN.md` 不存在 | 全新任务 | 先 Plan（写 `PLAN.md` + `TODO.md`）再 Execute |
| `PLAN.md` 存在 + `TODO.md` 不存在 | 异常状态 | 报错给用户，询问是否续做 |
| `PLAN.md` 存在 + `TODO.md` 存在 | 续传任务 | 按 `TODO.md` 已勾选的位置续做 |

这一步把"我是谁、我之前做到哪"从进程内存里搬出来，让进程崩溃后人类也能用 IDE 直接编辑纠偏——手动改 `TODO.md` 的勾选状态、改 `PLAN.md` 的某个决策。Human-in-the-loop 在文件层介入，不是在循环层介入。

**关键约束**：嗅探 → 读取 → 校验三步必须顺序执行——嗅探完直接读可能读到部分写入的文件，校验判断文件语义完整性（`TODO.md` 是否有未勾选条目、`PLAN.md` 是否有 Plan 结构）。

---

## 九、Agent 大脑的编写与维护工程技巧

**问题：作者怎么搭这套引擎？**

按 6 大本质问题对应的作者选型经验：

### 9.1 退出信号源选型

工程层信号源 = `needsFollowUp` 标志；不要用 SDK 的 `stop_reason`。`maxTurns` 经验值 25-50——低于 25 信任度过低（模型办不完合理任务）、高于 50 几乎必然跑飞（Doom Loop 或任务设计有问题）。

调参纪律：先固定 25 跑评测，根据 fail rate 调整。

### 9.2 Plan-Execute 物理切断的接缝点

接缝点是 `tools=[]` 注册——不是 prompt 提示。Phase 2 注入完整工具**不应包含 prompt 中的 Plan**——文本污染是常见的 Plan 失效原因。

Self-Refine 不属于 Plan-Execute 物理切断的延伸，而是**生成阶段的局部循环**——同一节点内"打分不通过 → 重写"。两者不要混用。

### 9.3 Replan 阈值怎么定

N=3-5 是经验值，不是默认值。

**校准纪律**：

- 收集 100 个真实任务样本
- 跑当前 N 值，统计"Plan 跑完率"（Plan 完成且结果正确占比）
- 调整 N 让跑完率最高且 token 消耗最低

**Hard 经验**：阈值永远不要超过 `maxTurns / 5`——如果 `maxTurns=30`、`Replan=6` 几乎必然跑飞。

### 9.4 状态对象字段怎么选

撞墙式追加——不要设计先行：

1. v0 只放 3 个字段（`step` / `total_tokens` / `observations`）
2. 跑生产 trace 发现新撞墙类型，加新字段
3. 每个字段保留对应一个曾发生过的问题，没撞过的字段就是伪字段

### 9.5 Recovery Hints 怎么分类

| 匹配方式 | 适用 | 升级路径 |
|---|---|---|
| `strings.Contains` 关键字匹配 | 工具层无错误码协议（早期）| 升级到 Domain Error Code |
| Domain Error Code 匹配 | 工具层协议化（工业级）| 进 recovery.hints.json 静态配置 |
| 工具自描述救援指南 | 工具有 metadata 能力（高级）| 工具作者填 `recoverable_errors` 字段 |

匹配方式升级的工程原因：错误码是协议层稳定信号（`ERR_FILE_NOT_FOUND` 不会因文案改版变化），关键字是字符串层脆弱信号（"file not found" 改文案就失效）。

### 9.6 Doom Loop 阈值怎么调

| 阈值 | 含义 | 风险 |
|---|---|---|
| ≥2 次 | 极敏感 | 正常任务中重试 2 次是合理探索，误判多 |
| ≥3 次 | 经验值 | 平衡探索容忍与死循环识别 |
| ≥4-5 次 | 宽松 | 错过真死循环的概率上升 |

调参纪律：从 ≥3 起步——这是经验最低风险值。跑 Doom Loop 测试集（10 个故意带死循环的样本），误判率（误报 Doom Loop）< 5% 且漏判率（漏报真死循环）< 5% 为合格。

**fingerprint 必须含 args 不只是 toolName**：`read_file{"/tmp/a"}` 和 `read_file{"/tmp/b"}` 是两个不同尝试——只算 toolName 就漏掉真死循环。

### 9.7 Plan Mode 怎么开关

Plan Mode 是**用户的开关不是 Agent 的自动判断**。Agent 不该决定"这事够不够大"：

- 用户主动开（`/plan-mode` 或类似命令）→ 注入 Plan Mode SOP
- 用户没开 → Agent 不要自己开，即便任务看起来复杂

**自动判断的风险**：Agent 习惯性"这事太大了该 Plan"会过度外部化所有任务，写盘开销 + Plan 僵化 > 收益。

**用户开关 vs Agent 自动判断**的工程区别：用户开关减少决策路径（用户替 Agent 决定）、Agent 自动判断增加决策路径（Agent 多一步"该开不该开"）。少决策比多决策更可控。

---

## 十、反模式

按 6 大本质问题两栏对应（加载与执行侧 / 编写与维护侧）。

### 加载与执行侧反模式

**循环退出**

- 退出信号源拍脑袋（如直接用 SDK `stop_reason` 或写死固定 N）——用工程层 `needsFollowUp` + `maxTurns` 兜底
- 依赖 SDK 的 `stop_reason` 字段判断退出，SDK 不总是正确设置导致空转——必须用 `needsFollowUp` 标志
- 不分"失败硬护栏"和"用户主动"，Ctrl+C 和 `maxTurns` 走同一路径导致用户体验错乱
- 6 种 terminal reason 失败类静默吃掉，丢根因——`max_turns` 不报就不知道是 maxTurns 不够大还是 Plan 跑偏

**思考深度**

- 用提示词注入"请先思考再行动"代替 Plan-Execute 物理切断，模型在 Phase 2 仍然会立即 `tool_use`——结构化信号压倒软约束
- Self-Refine 用在开放式问答 / 探索性任务上，模型反复打磨同一个错误方向

**撞墙后决策**

- 硬错和软错不分流，Plan 不停推翻自己浪费 token
- Replan 不设 N 次强制退，陷入"Replan → 失败 → Replan"死循环直到 `maxTurns`
- 反思粒度过大，把"反思当前一步"做成"反思整体 Plan"，等于变相 Replan

**状态归属**

- 不外部化状态，长程任务跨进程重启后失忆
- `TODO.md` 事后一锅端打勾，断点续传失效
- 状态对象所有字段"设计先行"没撞过墙就补，伪字段占用 `total_tokens` 还干扰模型注意力

**失败可观测**

- 工具报错只让模型机械道歉，不注入 `[系统救援指南]`，模型反复尝试相同参数
- Doom Loop 检测只用 `toolName` 不用 `args`，`read_file{"/tmp/a"}` 和 `read_file{"/tmp/b"}` 被算成两次不同尝试
- System Reminders 用 `Role: System` 注入，远端注意力低，拦不住近因偏差导致的局部执念

**跨进程续做**

- 进程重启后直接读文件不先 `ls` 嗅探，读到部分写入的文件导致状态错乱
- 想做"完整断点续传"——LLM 节点不可重放，宣称能做到的是任务级特例

### 编写与维护侧反模式

- 退出信号源拍脑袋（直接 `stop_reason` 或硬 N）——用 `needsFollowUp` + `maxTurns`
- `maxTurns` 拍脑袋定数字（10 或 100）——跑评测校准，25-50 起步
- 状态对象一次定义 10+ 字段，多数是伪字段占 context——撞墙式追加才是纪律
- Plan-Execute 用提示词提示代替物理切断——结构化信号压倒软约束，必须注册空工具列表
- Plan 用文件传递但提示词也重复 Plan 文本——Phase 1 长推理污染 Phase 2 执行
- Replan 阈值拍脑袋——N=3-5 是经验不是默认值
- Replan 阈值定超过 `maxTurns / 5`——几乎必然跑飞
- Recovery Hints 用 `strings.Contains` 不升级到 Domain Error Code——协议层更稳定
- Doom Loop 阈值 ≥2 太敏感 / ≥5 太宽松——经验值 ≥3 起步
- Doom Loop fingerprint 只用 toolName 不用 args
- Plan Mode Agent 自动开——用户开关不信任、过度外部化所有任务
- `maxTurns` 与 Replan 阈值不联动——Replan > maxTurns / 5 几乎必然撞墙

---

## 十一、何时不该用

> 总原则：**不属于"6 大本质问题中至少 1 项有收益"的，硬套循环骨架都会变成过度工程**。

Agent 大脑不是"凡是 LLM 都得套循环"。遇到这些场景**别用**：

| 我要做的是… | 应该用 |
|---|---|
| 单步对话 / 一次性问答 | 直接 API 调用 |
| 确定性流程（编译、部署、CI）| 脚本（LLM 反而引入不确定性）|
| 工具调用 < 5 步的简单任务 | 不必外部化 Plan |
| 跨进程长程任务 | 必须外部化（`PLAN.md` / `TODO.md`）|
| 多 Agent 协作的任务 | [Multi-Agent 篇](./agent-multi-agent-orchestration.md) |
| 场景化 SOP | Skill |
| 永久生效的规范 | CLAUDE.md |
| 上下文管理 | [Context 篇](./agent-context-management.md) |

按 6 大本质问题的"不该用"边界判定：

- **问题 1 退出信号** —— 不属于循环退出有歧义的（单步或固定 N），不要为退出信号设计付费
- **问题 2 思考深度** —— 不属于可验证输出标准的任务，不要用 Self-Refine 自打分
- **问题 3 错误分流** —— 软错 / 信息不足都不出现的简单任务，不要预设 Replan 阈值（无意义）
- **问题 4 状态归属** —— 单 Agent 内存里能搞定的任务，不要外部化（写盘开销）
- **问题 5 失败可观测** —— 调用 < 5 步确定能跑完的任务，不要搭 Recovery Hints / Doom Loop / System Reminders
- **问题 6 跨进程续做** —— 一次性任务或小时级以下任务，不要 PLAN-TODO 双文件协议

边界判定口诀：

- **单步 / 一次性 / 简单工具链** → 直接 API
- **确定性流程** → 脚本，不引 LLM 不确定性
- **多轮决策 + 跨进程** → Agent 大脑
- **场景化 SOP** → Skill
- **多 Agent** → Multi-Agent 篇

**硬约束**：

- 6 大问题有强耦合：Replan 上限必须 < `maxTurns / 5`，Doom Loop 触发的 Replan 必须用 System Reminders 注入，状态对象与外部化必须顺序明确
- "想做完整断点续传"是伪问题——LLM 节点不可重放，正确做法是"最小可恢复集合"
- "Plan Mode Agent 自动开" 是反模式——Agent 习惯性"这事太大了该 Plan"会过度外部化所有任务

不属于循环层该处理的，硬套循环都会变成"伪工程师"——把单步任务复杂化、把确定性流程不确定化、把简单任务官僚化。

---

## 十二、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>循环与思考侧样本</strong>（点击展开）</summary>

**Claude Code Agent Loop（cc-03-agent-loop.md）**
- §4.1-4.2 MVP 形态与状态管理 —— ReAct 闭环 + 硬约束 + 6 字段状态对象
- §4.3 正常生命周期 init→think→act→observe→finalize —— 每轮四阶段
- §4.4-4.5 while True 演化 + 停止条件分两路 —— 7 种 continue reason + 6 种 terminal reason
- §4.5 `needsFollowUp` 与 AI 消息 / 工具调用结对 —— 不依赖 `stop_reason` 字段
- §4.6 状态对象的工程痕迹 —— `autoCompactTracking` / `maxOutputTokensRecoveryCount` / `hasAttemptedReactiveCompact`

**Dify Agent 推理（dify-04-agent-reasoning.md）**
- §一 慢思考机制 —— 物理切断的 Plan-Execute 两阶段
- §二 Plan 阶段设计 —— Plan 节点纯推理无工具
- §八 Replan 触发条件 —— 撞硬错回到 Plan 重规划
- §一/二/八 综合 —— Plan-Execute-Replan 完整流程

</details>

<details>
<summary><strong>反脆弱侧样本</strong>（点击展开）</summary>

**Claude Code 错误自愈与反脆弱（cc-09-error-recovery.md）**
- §三 RecoveryManager 字符串特征匹配 —— 关键字 → `[系统救援指南]` 注入
- §四 Domain Error Code 工业化升级 —— `ERR_FILE_NOT_FOUND` / `ERR_EDIT_FUZZY_MATCH_FAILED`
- §五 Doom Loop 检测 —— `md5(toolName + args)` + `consecutiveFailures` map
- §六 System Reminders 注入策略 —— 伪装成用户消息利用近因偏差

**Claude Code 状态外部化（cc-10-externalized-state.md）**
- §二 PLAN.md / TODO.md 双文件协议 —— 架构级约束 vs 颗粒度 Checklist
- §三 Markdown Checkbox 打勾协议 —— 单步立即勾选 vs 事后一锅端
- §四 Plan Mode 开关设计 —— 用户主动开 vs Agent 自动判断
- §五 进程重启后环境嗅探流程 —— `ls` 嗅探 → 全新任务 / 续传分流

</details>
