---
sidebar_position: 7
description: "Tool 工程化技巧——分两条线。加载与执行机制（Agent 系统怎么把工具注册、发现、调度、执行、回收、限权）和编写与维护工程技巧（接口契约、description 工程、schema 工程、容错、输出、安全属性、cache、废弃）。"
---

# Tool 篇

工具是 Agent 影响世界的唯一途径。读这篇之前你应该已经了解 Agent 大脑的循环机制——本篇聚焦"工具怎么描述、注册、执行、谁有权限调用"。

工程化的核心拉扯在三组：
- 描述准确性 ↔ 防御多层（description 是命门，但只靠 description 一层防不住）
- 声明执行 ↔ 凭据隔离（schema 给 LLM 看 + instance 留着执行，必须物理分离）
- 用户可见 ↔ 系统安全（最小权限 vs 用户体验）

本篇分两条线：

- **加载与执行机制侧**——Agent 系统怎么把工具注册、发现、调度、执行、回收、限权。三轴即对应这侧：描述层（`description` 给 LLM 看）/ 注册与执行层（声明 vs 实例）/ 权限层（谁能调）。
- **编写与维护侧**——Tool 作者怎么定义接口契约、写 description、设计 schema、自报安全属性、设错误格式、做版本废弃。

不区分这两条线会出典型错位：把"工具被 LLM 选错"问题改在调度层（其实是 description 写法），或把"工具废弃后没人改"问题改在注册层（其实是没接观测 / 没发版本）。

---

## 一、动机

Tool 是 Agent 系统"循环层 → 工具层"的边界。循环层负责"决定调不调"，工具层负责"怎么调、怎么收、谁能调"。

工具系统在 Claude Code 是 60+ 个目录、`buildTool` 构造、`getAllBaseTools()` 集中注册、四阶段管线（注册→调度→执行→截断）。理解这条管线是理解整个工具系统的基础——一次 `tool_use` 走完 "findTool → validateInput → canUseTool → call → mapResult" 五步，每步都可能出错但不抛异常，全部转化为 `is_error: true` 的 `tool_result` 注入下一轮。

---

## 二、关键判断速览

### 加载与执行机制侧

#### 描述层
- description 写"什么时候该调 / 不该调"而不是"我能干什么"
- `description.llm` 和 `description.human` 分两套
- 准确性防御叠 5 层：描述 / Schema / 系统提示 / 容错 / 反馈

#### 注册与执行层
- 工具三层（元数据 / Schema / 执行逻辑）清晰分离
- 5+ 异构来源工具用唯一 ToolManager + 多级缓存（进程级 / 请求级 / 用户级 / 会话级）
- 声明（schema）与执行（instance）物理分离，凭据按请求 fork
- 安全相关属性默认 fail-closed（`isReadOnly` / `isConcurrencySafe` / `isDestructive` 默认 false）
- 工具失败默认注入错误（`is_error: true`）而非抛异常
- 超长结果持久化 + 预览而非截断

#### 权限层
- 权限划分三层（系统级 / 用户级 / 会话级）独立来源 + deny 优先合并
- **用户可见的权限**：工具按"任务场景 + 敏感度"分组暴露，高危工具默认隐藏，过滤在 schema 注入之前
- HITL 在执行前阻塞，审批超时默认拒绝
- 工具被禁用用 logit masking（默认）还是删 schema（仅废弃）

### 编写与维护侧

- 每个 Tool 是一个独立目录 + 单一文件 + 单一 `buildTool(<args>): Tool<Input, Output>` 工厂
- `prompt()`（系统提示层使用手册）+ `description()`（schema 字段描述）必须合并——只写 schema 描述的 LLM 选不准工具
- `inputSchema` 必须是显式 Zod schema，每个字段加 `.describe()`——少一个字段就少一层校验
- 容错是从"脏输入"开始设计：`backfillObservableInput` / `semanticBoolean` / `semanticNumber` 三个口子
- 错误反馈必须人类可读 + 给替代方案——`<tool_use_error>Blocked: ...</tool_use_error>` 是给 LLM 下轮自纠的，不是给开发者看的
- 安全属性自报三件套：`isReadOnly` / `isConcurrencySafe` / `isDestructive`，默认值全 `false`
- 超长结果由各 Tool 自定 `maxResultSizeChars`——统一截断会破坏语义
- 工具名是 cache key 的一部分——`getAllBaseTools()` 顺序固定，避免 cache miss
- 废弃用 `aliases: { old: newName }` 平滑迁移，不删 schema（删除会废 cache）
- 工具得有自己的 README 或 doc-comment——后续接手的工程师要有入门入口

---

## 三、Tool 的加载与执行机制（Agent 系统怎么用 Tool）

### 加载执行三轴：描述层

#### description 是设计命门

description 是 LLM 理解工具的唯一信息源，写得好坏直接决定调用准确率。

检验标准：把 description 给不懂技术的人看——他若不知道该不该用、该填什么，LLM 也不知道。

| 写法 | 效果 |
|---|---|
| 写"我能干什么"（功能列表） | LLM 容易在 BashTool vs Read 之间选错 |
| 写"什么时候该调 + 什么时候不该调 + 填什么参数" | 明确专用工具优先表，准确率高 |

cc-05 §五 5.1 每个工具有 `prompt()`（系统提示层注入的使用手册）+ `description()`（schema 字段描述），BashTool 的 `getSimplePrompt()` 列出"专用工具优先表"（Read 替代 cat、Edit 替代 sed 等），明确告诉 LLM"什么场景不该用我"。

#### `description.llm` 和 `description.human` 分两套

dify-07 把描述拆成两层：`description.human`（给用户看）和 `description.llm`（给 LLM 看）。共用会导致：用户文档会泄漏内部细节，LLM 文档会缺少面向外行的解释。

附录 F 给出"优质 vs 劣质 schema 对比"，`{type: "string"}` 改成带 `minimum/maximum/default/description` 的完整 schema 后参数正确率提升 30%。

#### 准确性防御叠 5 层

LLM 调工具出错（选错 / 填错参数 / 顺序错 / 出错后死循环）怎么防御？

| 层 | 防的错误类型 | 实现 |
|---|---|---|
| 描述层 | 选错工具 | `prompt()` 使用手册 + 专用工具优先表 |
| Schema 层 | 参数结构错 | `strict` 模式 + `z.strictObject` + `.describe()` |
| 系统提示层 | 工具优先级混乱 | `getUsingYourToolsSection` 工具优先级与分类 |
| 容错层 | 参数值机械错 | `semanticBoolean` / `semanticNumber` / `backfillObservableInput` |
| 反馈层 | LLM 自纠失败 | `formatZodValidationError` 人类可读 + 替代方案 |

5 层防御缺一不可，每层防御的错误类型不同。

### 加载执行三轴：注册与执行层

#### 声明与执行物理分离

LLM 拿到工具列表后，怎么让"看到的能力"和"能调用的能力"保持一致？

| 组件 | 谁看 | 包含什么 |
|---|---|---|
| PromptMessageTool | LLM | name + description + parameters |
| Tool instance | 执行器 | 凭据 + `_invoke()` |

dify-07 §五 的 `_convert_tool_to_prompt_message_tool()` 把 Tool 实例拆成两半，`fork_tool_runtime()` 给每个 Agent 请求克隆一份独立凭据副本，互不污染。

不分离的代价：
- 凭据泄漏（API Key 暴露给 LLM 让它误填）
- 同名工具冲突（两个 Provider 都有 `search` 工具）
- LLM 看到不该看的字段（FILE 类型、内部 ID）

凭据必须按请求 fork，不能进程级共享。

#### 唯一注册中心 + 多级缓存

5+ 异构来源的工具（Builtin / Plugin / OpenAPI / Workflow / MCP）怎么统一索引？dify-07 §2.1/2.2 的 ToolManager 是唯一注册中心：

| Provider 类型 | 隔离级别 | 缓存层级 |
|---|---|---|
| Builtin | 无租户差异 | 进程级缓存（`_hardcoded_providers` 类变量 + 双重检查锁） |
| Plugin / MCP | 租户隔离 | 请求级缓存（`contexts.plugin_tool_providers` 按 tenant_id） |
| 用户自定义 | 用户偏好差异 | 用户级缓存 |
| 当前轮动态 | 会话内动态 | 会话级缓存 |

cc-05 §3.5 的 Claude Code 实现顺序（启动时）：`getAllBaseTools()` 集中注册 → `filterToolsByEnv` 环境过滤 → `CORE_TOOLS` 白名单 38 个常驻 → 剩余工具 TF-IDF 按需发现 → `toolToAPISchema` 转 JSON Schema 注入 API 请求。**数组顺序固定**——顺序变了 prompt cache 失配。

#### fail-closed 默认值

工具作者可能漏声明 `isReadOnly` / `isConcurrencySafe` / `isDestructive`，默认值该怎么设？

| 默认值 | 忘声明后果 |
|---|---|
| true（fail-open） | 忘声明当只读 → 并行执行产生数据竞争（正确性损失，不可逆） |
| false（fail-closed） | 忘声明当写操作 → 白白串行（性能损失，可恢复） |

cc-05 §3.2 的 `TOOL_DEFAULTS` 把 `isConcurrencySafe` 和 `isReadOnly` 都默认 `false`。所有"安全相关"属性必须 fail-closed。

#### 工具失败注入错误而非中断

工具执行失败（参数错、文件不存在、命令 exit ≠ 0）时，Agent 循环该中断还是继续？

| 做法 | 后果 |
|---|---|
| 抛出异常中断 | 异常冒泡把"工具失败"变成"系统失败"，触发外层错误处理 |
| 把错误作为 `is_error: true` 的 tool_result 注入 | LLM 下一轮自纠 |
| 静默吞错 | 问题延后暴露 |

工具失败默认注入错误，让 LLM 自纠。这与 Agent "错误即 Observation" 的设计哲学一致。

**关键区分**：退出码非零不等于错误。grep 没匹配也是 exit 1，是正常结果。只有中断、参数错误、权限拒绝才标 `is_error: true`。cc-05 §4.5 给出完整判断：`validateInput` 失败注入 `<tool_use_error>`、用户 abort 注入 `CANCEL_MESSAGE`、其他执行错误才进 `is_error: true` 通道。

#### 超长结果持久化

工具返回超长结果（cat 1GB 日志、find /）该怎么处理？

| 做法 | 后果 |
|---|---|
| 直接截断到 N 字符 + 标记 | LLM 看到截断标记后只能盲改 prompt，丢失主动探索能力 |
| 落盘 + 前 2000 字节预览 | LLM 用 Read 工具按 offset/limit 精准读取 |

cc-05 §4.6 的 `toolResultStorage.ts`：`getPersistenceThreshold()` 阈值由各 Tool 自己定 `maxResultSizeChars`，超阈值落盘 + `buildLargeToolResultMessage` 注入预览。LLM 看到预览后可主动决定再读哪一段，而不是被"被截断"的标签牵着走。

截断阈值下放给各工具——BashTool 要保留 stderr 和 exit code、FileReadTool 已有 offset/limit 不需要二次截断、JSON 工具可能保留结构化信息——强行统一截断会破坏语义。

### 加载执行三轴：权限层

#### 三层权限划分

同一个工具（如 BashTool）应该有几种"权限粒度"？

| 层级 | 谁设 | 覆盖什么 |
|---|---|---|
| 系统级 | 管理员 | 禁止 `rm -rf /` 等安全基线，所有用户生效 |
| 用户级 | 终端用户 | 在 settings.json 的个人偏好，仅当前用户生效 |
| 会话级 | 当前会话 | `--allowedTools` 临时授权，会话结束销毁 |

cc-05 §3.4/§4.3 的 `canUseTool` 是统一权限检查入口，三条规则按 **deny 优先合并**：任何一层 deny 则拒绝。

#### 用户可见的权限

LLM 一次只能看到 N 个工具（30+ 工具会让 schema 占 5%+ context），怎么控制"哪些工具 LLM 看得到"？

| 维度 | 分类 |
|---|---|
| 任务场景维度 | 当前 task type 过滤（如代码任务不暴露 SQL 工具） |
| 敏感度维度 | 高危工具默认隐藏（`rm` / `curl | sh` / 凭据类），需显式授权 |

cc-05 §3.4 的三层工具暴露：

| 层级 | 工具 | 注入策略 |
|---|---|---|
| CORE 常驻 | 高频核心工具（Read / Edit / Bash） | 始终注入 |
| 延迟按需 | 低频工具 | `defer_loading` + `SearchExtraTools` 语义检索 |
| 危险隐藏 | 高危工具 | 默认不可见，需 `--allowedTools` 启用 |

过滤时机在 schema 注入 LLM **之前**做（不要等 LLM 选了再拒绝，浪费一次循环）。`SearchExtraTools` 这种"找工具的工具"必须常驻，否则 LLM 找不到隐藏工具。

#### HITL 拦截时机

人不在终端前，HITL 审批超时了怎么办？

| 做法 | 适用场景 |
|---|---|
| 默认放行（fail-open） | 不可用——安全相关审批会绕过人工审核 |
| 默认拒绝（fail-closed） | 同步 HITL 适合关键决策（删除、批量变更、权限升级） |
| 永久阻塞 | 不可用——用户体验差 |

HITL 阻塞点在执行**前**，审批信息要格式化（操作目的、影响范围、成本预估、建议操作），不扔原始 JSON。超时默认拒绝。

#### 工具被禁用三种处理方式

| 方式 | 副作用 | 适用 |
|---|---|---|
| 删除 schema | cache key 失配，命中率暴跌 | 工具被废弃 |
| logit masking | schema 稳定，cache 命中保留，LLM 不实际选择 | 用户临时禁用 |
| 返回错误 | LLM 已经选了再报错，浪费一次循环 | 工具暂时不可用 |

默认推荐 logit masking，cache 命中保留。

---

## 四、Tool 的编写与维护工程技巧

### 接口契约怎么设计

每个 Tool 都是一个独立目录，`buildTool({ ... }): Tool<Input, Output>` 工厂返回实现：

```ts
// packages/builtin-tools/src/tools/<Name>/<Name>.ts
export const MyTool = buildTool({
  name: 'MyTool',
  description: '...',
  inputSchema: z.object({ ... }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(args, context) { ... },
})
```

cc-05 §3.1 的 `Tool<Input, Output, P>` 类型有 15+ 字段：

| 字段类别 | 字段 | 作用 |
|---|---|---|
| **元数据** | `name`、`displayName`、`mcpInfo` | 注册表排序 / 命名空间 |
| **schema** | `inputSchema` | Zod → JSON Schema → API 注入 |
| **行为** | `isConcurrencySafe`、`isReadOnly`、`isDestructive` | 调度分批 / 权限判定 / UI 提示 |
| **生命周期** | `validateInput`、`checkPermissions`、`call`、`description`、`prompt` | 校验→权限→执行→文档 |
| **观测** | `maxResultSizeChars`、`backfillObservableInput` | 落盘阈值 / 注入 SDK 流 |
| **可发现** | `shouldDefer`、`aliases` | 延迟加载 / 向后兼容 |

最小可用 Tool 必须填：`name` + `description` + `inputSchema` + `call`。其他字段都是按需扩展。

**接口设计三原则**：

1. **职责单一**——一个 Tool 一个动作；想"既能读又能写"的工具拆成两个
2. **输入最小**——只接受必要的参数，复杂状态走环境变量而不是参数
3. **输出明确**——返回 `ToolResult<Output>`，错误走 `is_error: true` 而非抛异常

### description 的两个听众

每个 Tool 的 description 实际上有两类听众，要分层写：

| 字段 | 听众 | 写法 | 长度 |
|---|---|---|---|
| `prompt()` | LLM 的"系统提示层" | 用法手册、使用场景、与别的工具的差异 | < 500 chars |
| `description()` | LLM 的"schema 字段层" | 一句话：该工具做什么、关键参数 | < 200 chars |

合并策略（cc-05 §3.5）：`toolToAPISchema` 在注入 API 时把 `prompt()` + `description()` 合并写到 Anthropic API 的 `description` 字段。LLM 同时看到"用法说明"和"字段说明"。

**写 description 的自检**：

- 把 `description` 拿给一个不懂技术的人看，他能判断"这工具该不该用" → 通过
- 把 `prompt()` 拿给另一个相似工具的 LLM 看，它知道"什么场景下不该选我" → 通过
- 两者都有"专用工具优先表"（BashTool 的 `getSimplePrompt()` 就是这张表，明确告诉 LLM "Read 替代 cat"）→ 通过

**不准写什么**：

- "我能做什么"的功能列表
- "本工具采用 ACME 协议基于 X.X 版本"——内部实现细节泄漏
- "使用前请联系管理员"——文档位置不对
- "支持并发"——这是 `isConcurrencySafe` 的事，不要写进 description

### Schema 工程

`inputSchema` 是 Zod schema，cc-05 §3.5 转换为 JSON Schema 注入 API。Schema 不是"格式校验"，是 LLM 理解参数的第一道防线：

```ts
inputSchema: z.strictObject({
  path: z.string().describe('文件绝对路径或相对 cwd 的路径'),
  offset: z.number().int().min(0).default(0).describe('起始行 0-based'),
  limit: z.number().int().min(1).max(1000).default(100).describe('要读取的行数'),
})
```

**Schema 写作纪律**：

1. **每个字段都有 `.describe()`**——`{type: "string"}` 是给 LLM 的黑盒，写了 description 准确率立升
2. **数值字段加边界**——`min(0)` / `max(1000)` 防止 LLM 给离谱值
3. **字符串加 format**——`z.string().url()` / `.email()` / `.regex()` 比"靠 description 提醒"更可靠
4. **枚举优先于字符串**——固定几个值用 `z.enum(['a','b','c'])` 而非 `z.string()`
5. **用 `z.strictObject` 而非 `z.object`**——LLM 可能给多余字段，严格模式直接报错而不是静默忽略（守住 cache key 不被噪声污染）
6. **`strict: true` 注入 API**——LLM 调用须严格匹配 schema 结构
7. **默认值写 schema 里**——`default(0)` 比 `if (x === undefined) x = 0` 安全，且 description 写明默认值更利于 LLM 判断

dify-07 附录 F 的对比示例：劣质 `{type: "string"}` 改成优质带 `minimum/maximum/default/description` 的完整 schema 后，参数正确率提升 30%。这个数字是真实评测得到的，不是估算。

### 输入容错：让"脏输入"也能动起来

LLM 调用工具的参数经常有"小毛病"：布尔写成字符串、数字写成文字、空数组代替缺失。这些不该全靠 LLM 自纠——Tool 设计可以容错：

| 容错口子 | 用途 | 实现位置 |
|---|---|---|
| `backfillObservableInput` | 注入 SDK 流和 hook 之前 | Tool 调用入口前 |
| `semanticBoolean` | 接受 `"true"` / `"yes"` / `"on"` 等 | Schema parser 或 `validateInput` |
| `semanticNumber` | 接受 `"100"` / `"1k"` / `"1e3"` | 同上 |
| `formatZodValidationError` | Zod 报错转人类可读 | `validateInput` 失败时 |

`backfillObservableInput` 容易被误用——它**不是**"修复输入"，是"在外部观察前注入 ID/timestamp 等元信息"。写它时要幂等，且必须保留 API-bound 副本（保留 prompt cache）。

容错的边界：

- 输入小毛病 → Tool 层兜住（让 95% 的脏输入不浪费一轮循环）
- 输入语义错（路径不存在、参数互斥） → 让 LLM 自纠（`<tool_use_error>` 注入）
- 输入严重越界（路径逃逸目录） → 直接拒绝，HITL 批准前不执行

### 输出截断的工具自定原则

`maxResultSizeChars` 各工具自己定，不要全局统一：

| 工具类型 | 推荐阈值 | 原因 |
|---|---|---|
| BashTool | 30K | stderr + stdout + exit code 都要保留 |
| FileReadTool | 不截断（自身已有 offset/limit） | 二次截断破坏已有语义 |
| Glob/Grep | 5K | LLM 通常关心"匹配了哪些"，不需要全量 |
| WebFetch | 10K | 长文大段丢失可读性差 |
| 长文档类 | 实际不必截断，让 LLM 自取 | 与 FileRead 一致 |

落盘后再注入的预览消息要有结构：

```
[Tool result too large: 125000 chars. Saved to /tmp/.tool-results/abc123]
[Preview (first 2000 chars)]
<原始内容前 2000 字符>
[End of preview; use Read tool with offset to see more]
```

这种格式让 LLM 知道：信息没丢、在哪、用什么工具去取。截图文本式摘要标签（"...结果被截断"）丢这条链路。

### 错误反馈格式

工具执行错误时返回的消息是给 LLM 下轮自纠用的，不是给开发者看日志用的——格式工程：

```
<tool_use_error>Blocked: file not found at path "/tmp/missing.json". 
Use Glob("**/missing*") to find files matching pattern, or check the path.
</tool_use_error>
```

`<tool_use_error>...</tool_use_error>` 包裹（`is_error: true`），内容包含：
1. **问题一句话**——"Blocked: file not found" / "Permission denied" / "Invalid argument format"
2. **关键字段值**——具体路径、参数、上下文
3. **替代方案**——"用 Glob 替代" / "换成 read 模式" / "检查 settings.json"

不抛异常冒泡到调度器——抛异常会让"工具失败"变成"系统失败"，触发外层错误处理（机制详见 §三"工具失败注入错误而非中断"）。

**关键区分**：

| 失败类型 | 标 `is_error: true` | 理由 |
|---|---|---|
| 参数校验失败（Zod 报错） | 是 | LLM 下一轮会改成对 |
| 文件不存在 | 是 | LLM 下一轮换路径 |
| 用户 abort | 否，注入 `CANCEL_MESSAGE` | 中断循环而非注入错误 |
| 内部代码 bug | 是 | 强制 LLM 重试便于发现 |
| 部分成功（如 grep 匹配但命令 exit 1） | 否 | exit code ≠ 错误（grep 没匹配是 exit 1 但正常） |

### 安全属性的自报

`isReadOnly` / `isConcurrencySafe` / `isDestructive` 三件套必须自报——默认全是 `false`。这是 fail-closed 设计：

```ts
isReadOnly: () => false,         // 默认为写
isConcurrencySafe: () => false,  // 默认不可并行
isDestructive: () => false,      // 默认不毁数据
```

**正确填写时**：

| 工具 | isReadOnly | isConcurrencySafe | isDestructive | 备注 |
|---|---|---|---|---|
| Read | true | true | false | 只读 + 可并行 |
| Glob | true | true | false | 同上 |
| Grep | true | true | false | 同上 |
| Edit | false | false | false | 写但并行不安全、不毁数据 |
| Bash | 取决于命令 | 取决于命令 | false | 通常要解析命令自报，WriteTool 等特殊处理 |
| WebFetch | true | true | false | 只读、有网络 |
| FileDelete | false | false | true | 写、不可并行、毁数据 |

**自报的两种模式**：

1. **静态自报**——`isReadOnly: () => true`，适用于行为确定无歧义的工具
2. **动态自报**——`isReadOnly: (input) => ...`，根据 input 动态判断（`isReadOnly` 接受当前 input）

工具作者要决定走哪种。BashTool 的边界是动态的（同一 Bash 调用不同命令），所以分析命令决定行为；Read 的边界是静态的，写常量即可。

**写错后果**：

- 忘标 `isConcurrencySafe: true` → 失并行（性能损失，但可恢复）
- 错标 `isReadOnly: true`（实际有副作用） → 并行时数据竞争（正确性损失，不可逆）

fail-closed 默认保的是后者：忘声明 / 错声明都按最严走，最坏是性能损失，不会变数据竞争。

### 注册位置与 cache 命中

`getAllBaseTools()` 的返回顺序**直接决定 prompt cache 命中率**——Anthropic API 把 tools 数组的序列化作为 cache key 一部分，顺序变了 cache miss。

**注册位置纪律**：

- 核心常驻工具放在数组**前部**，顺序固定
- 条件 import 的工具（feature flag 控制）统一拼在数组**末尾**，避免它们的"在/不在"打乱前部顺序
- 自定义工具按 `name` 字典序排，相同名字的工具按"内置 > 插件 > 用户"优先级去重

环境过滤层（`filterToolsByEnv`）会按用户的 deny rules + 当前 feature flag 过滤，但**不重排**已经注册的顺序——这是关键。

### 工具的 README / 自描述

每个 Tool 必须有一份自我说明（无论是 README.md 还是文件头 doc comment），不然后续接手的工程师没法维护：

```
# WriteTool
## 它做什么
写入文件，覆盖或创建。Edit 工具的"全文覆盖版"。

## 什么时候该用它
- 文件不存在 / 要新建
- 要重写大段文本（Edit 适合小改动）
- 不适合 read-then-Edit 模式（分两次 LLM 调用耗 token）

## 与 Edit 的边界
- Edit：局部 patch、保留其他内容不动
- Write：覆盖全文（大改动）

## 安全属性
- isReadOnly: false
- isConcurrencySafe: false（同一文件不能并行 Write）
- isDestructive: false（覆盖是预期行为，不是删）

## 已知 bug / 边界 case
- ...
```

工具自描述包括：职责、与同族工具的边界、安全属性、已知 bug。这比单看 schema 能让维护者快 10 倍上手。

### 工具的废弃与别名

Tool 改名或废弃的几种方式：

| 方式 | 副作用 | 适用 |
|---|---|---|
| `aliases: { oldName: 'newName' }` | 老名字仍可调用，渐近迁移 | 改名 |
| `deprecated: true` + frontmatter 提示 | LLM 看到新名字优先，但老名字仍可用 | 软废弃 |
| 完全删除 schema | cache key 失配，命中率暴跌 | 硬废弃（最后一步） |
| logit masking | schema 仍在但 LLM 不选 | 用户临时禁用（不是废弃） |

**废弃流程**：

1. 加 `aliases: { oldName: 'newName' }` 平滑迁移——老 transcript 仍可读
2. 给 description 加 "use newToolName instead" 提示
3. 等观测数据显示老名字使用率 < 5%
4. 再考虑是否删除 schema

直接删除 schema 的破坏：
- 老 transcript 里出现老名字无法回放
- 用户的脚本 / 自动化调老名字全部失败
- prompt cache 命中率因 schema 数组变化暴跌

### 工具的测试与自检

Tool 本身要有测试，覆盖至少三类：

| 测试类型 | 覆盖什么 |
|---|---|
| **参数校验** | Zod schema 边界（缺字段、错类型、超范围、错格式） |
| **行为正确** | 输入到输出的预期映射（mock 外部依赖） |
| **错误路径** | 文件不存在 / 权限拒绝 / 网络超时 / 命令失败 |
| **并发安全** | `isConcurrencySafe: true` 的工具必须并发测试不冲突 |

测试结构参考：

```ts
describe('WriteTool', () => {
  describe('validateInput', () => {
    it('rejects missing file_path', () => { ... })
    it('accepts content as empty string', () => { ... })
  })
  describe('call', () => {
    it('creates new file', async () => { ... })
    it('refuses to write outside allowed directory', async () => { ... })
  })
  describe('concurrency', () => {
    it('two simultaneous writes to same file serialize', async () => { ... })
  })
})
```

**自检脚本**（每个工具目录一份）：

```bash
# packages/builtin-tools/src/tools/<Name>/smoke.sh
node -e "
  const { ReadTool } = require('./dist');
  new ReadTool({ ... }).call({ file_path: '/tmp/test.md', offset: 0, limit: 10 })
    .then(r => r.is_error ? process.exit(1) : process.exit(0))
"
```

自检脚本是接盘工程师的福音——改完一个 Tool 跑一遍 smoke.sh 立刻知道有没有破坏基本功能。

### 何时不该把动作做成 Tool

> 总原则：**不属于"单原子动作"的，硬塞成 Tool 都会变成巨型 Tool 或堆满假调用**。

不是所有"动作"都该变成 Tool——判断标准：

| 我想做的是… | 该用什么 |
|---|---|
| 单原子能力（一次动作完成） | Tool |
| 场景化经验（"在某场景下怎么做"） | Skill |
| 每次都不同（业务决策） | 不封装，让 LLM 在主循环判断 |
| 需要多轮独立思考 | Sub-Agent |
| 永久生效的规范 | CLAUDE.md |
| 跟别的工具强耦合（一组动作才有用） | Skill（Skill 内部可调用白名单 Tool） |
| 单一动作且强依赖上下文状态 | 主循环（如 Stream 推送） |

不该做成 Tool 的反例：

- "帮我写代码"——这是 Agent 的核心循环，不是 Tool
- "我要做代码审查"——这是 Skill（带场景 + 多文件 + 评判标准）
- "管理项目"——跨度太大、动作太多，强行拆 Tool 反而割裂
- "翻 100 张 PDF 并交叉引用"——一次工具调用完成不了，是 Skill + 多个 Tool 协同

边界判定口诀：

- **单原子动作** → Tool
- **场景化 SOP** → Skill
- **开放性业务** → 主循环 + LLM 决策
- **永久规范** → CLAUDE.md

**硬约束**（原 §六 内容合并到此）：

- 工具不能代替业务判断——LLM 才是决策者，Tool 只是执行器
- 工具不应该是 Skill——Skill 是带场景的复合，Tool 是单原子
- 工具不能跨进程传递上下文——状态走主循环，Tool 只通过 input/output 通信

---

## 五、反模式

### 加载与执行机制侧反模式

- 把 description 当补充文档最后写，描述差 LLM 调不准
- 只写"我能干什么"不写"什么时候不该用"
- `description.llm` 和 `description.human` 共用
- 只靠 description 一层防御准确性
- 把权限检查塞进 `tool.call()` 内部，权限规则需要全局可见
- 让 Tool 抛异常到调度器
- 直接截断超长结果并附"结果被截断"标记
- 把搜索器（SearchExtraTools）也延迟加载，LLM 找不到隐藏工具
- fail-open 设安全默认值
- 用 `z.coerce.boolean()` 做容错，`"false"` 是非空字符串会变成 `true`
- 把 `form≠LLM` 的参数（如 API Key）暴露给 LLM
- 进程级缓存跨租户隔离的 Provider
- Tool 实例含凭据直接传给 LLM
- 全量注入所有工具到 LLM，30+ 工具 schema 占 5%+ context window
- 高危工具（`rm` / `curl|sh` / 凭据类）默认可见
- 工具过滤在 LLM 选择之后做，浪费一次循环
- HITL 超时默认放行，安全相关审批绕过人工审核
- HITL 阻塞点在执行后，不可逆操作已做完
- HITL 审批信息扔原始 JSON 给用户
- 删除 schema 处理用户禁用，牺牲 cache 命中
- deny 规则被 allow 覆盖

### 编写与维护侧反模式

- 一个 Tool 同时能读又写（应拆成两个，Read 不带 state、写要 HITL）
- `inputSchema` 字段没 `.describe()`，LLM 只能从字段名猜用途
- 用 `z.object` 不用 `z.strictObject`，LLM 给多余字段被静默吃掉
- 数值字段无 `min/max`，LLM 写出 `limit: -5` 也接受
- 字符串字段无 `format` / `regex`，LLM 给空字符串就接受
- `maxResultSizeChars` 用全局值，BashTool 30K 跟 Glob 30K 没区别
- 错误消息写中文或长篇 stack trace——LLM 下轮根本看不过来
- 错误消息只说"失败"不说具体错在哪——LLM 下轮还得试
- 错误消息不给替代方案——LLM 下轮只能重试
- `prompt()` 和 `description()` 写一样内容——浪费 context、LLM 看不出信号差异
- `isReadOnly` / `isConcurrencySafe` 留 `undefined` 不显式写，靠默认 false 兜底——默认值一改就全错
- 删除 Tool 时直接删 schema 不留 aliases——老 transcript 全部失效、cache miss
- 工具改完不跑 smoke 自检，破坏基本功能没察觉
- 工具无 doc-comment / README，接手工程师无从下手
- 多个 Provider 提供同名 Tool 时不按优先级去重——LLM 看到两个看起来一样的工具
- Tool 文件不在工具目录而是塞到 utils 里——破坏扫描顺序、错过常驻注入

---

## 七、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>Claude Code 工具管线（cc-05-tool-execution-pipeline.md）</strong>（点击展开）</summary>

**加载与执行机制**
- §3.2 工具接口契约 + `buildTool` 的 fail-closed 默认值 —— `TOOL_DEFAULTS` 默认 `false`
- §3.4 注册与加载机制：核心白名单 + 延迟发现分层 —— CORE 常驻 / 延迟按需 / 危险隐藏
- §3.5 Schema 注入：Zod → JSON Schema 转换、`defer_loading`、`strict` 模式
- §4.1 单次 tool_use 完整生命周期 —— findTool → validateInput → canUseTool → PreToolUse Hooks → call
- §4.2 分批调度 —— `partitionToolCalls` 按 `isConcurrencySafe` 分批
- §4.3 校验与权限 —— `validateInput` 语义校验 + `canUseTool` 用户授权 + 三层权限合并
- §4.5 错误处理 —— 默认注入错误（`is_error: true`），exit code ≠ 0 不算错误
- §4.6 结果截断与持久化 —— 各工具自定 `maxResultSizeChars`，落盘 + 2000 字节预览
- §5.1-5.6 五层防御体系 —— 描述层 / Schema 层 / 系统提示层 / 容错层 / 反馈层
- §七 可复用的模式 —— 7 种模式（工具管线 / 最小权限工具集 / 错误注入 / 并行默认 + 串行可选 / fail-closed / 持久化 / CORE 常驻 + 延迟按需）

**编写与维护**
- §3.1 `Tool<Input, Output, P>` 接口 15+ 字段 —— 元数据 / schema / 行为 / 生命周期 / 观测 / 可发现
- §3.2 `TOOL_DEFAULTS` —— fail-closed 默认值的代码位置与三类安全属性
- §3.3 工具实现 60+ 目录 —— 按功能分组的工具地图
- §3.5 `prompt()` + `description()` 合并 —— 两个听众分层写法
- §3.5 `toolToAPISchema` Zod → JSON Schema —— `strict` / `defer_loading` 标志
- §4.1 生命周期 5 步 —— findTool / abort / validateInput / canUseTool / call，每步失败都转 `is_error: true`
- §4.4 `backfillObservableInput` —— 注入前 mutate 的幂等性 + 保留 API-bound 副本保护 cache
- §4.6 `getPersistenceThreshold` —— 超长结果落盘 + 预览的格式
- `toolResultStorage.ts` —— 落盘阈值和路径设计

</details>

<details>
<summary><strong>Dify 工具注册（dify-07-tool-registration.md）</strong>（点击展开）</summary>

**加载与执行机制**
- §一 工具声明：Provider-Controller-Tool 三层架构 —— 6 种 Provider 类型枚举
- §2.1 Builtin 懒加载：双重检查锁 + 进程级缓存
- §2.2 Plugin 请求级缓存 —— `contexts.plugin_tool_providers` 按 tenant 隔离
- §三 入口：`_init_prompt_tools` 静默跳过已删除工具
- §四 参数 Schema 生成：只暴露 `form=LLM` 的参数 —— `get_llm_parameters_json_schema` 过滤规则
- §五 运行时转换：声明与执行分离 —— `_convert_tool_to_prompt_message_tool` 拆出 PromptMessageTool + Tool 实例，`fork_tool_runtime` 给每个请求克隆凭据副本
- §六 执行：ToolEngine.agent_invoke 统一入口
- §七 结果回填：ToolInvokeMessage → 纯文本 + 文件列表 + meta
- §附录 F 参数 Schema 的 LLM-Friendliness —— 优质 vs 劣质 schema 对比

**编写与维护**
- §一 Provider-Controller-Tool 三层 —— 声明文件的物理位置决定加载策略
- §二 多级缓存（进程 / 请求 / 用户 / 会话）—— 不同隔离级别的缓存选择
- §五 `_convert_tool_to_prompt_message_tool` —— description.llm / description.human 分流的实现位置
- §附录 F 参数 Schema 的 LLM-Friendliness —— 写优质 schema 的真实回报（正确率 +30%）

</details>
