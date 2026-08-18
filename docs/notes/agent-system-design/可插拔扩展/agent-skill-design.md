---
sidebar_position: 8
description: "Skill 经验封装工程技巧——分两条线：加载与发现机制（系统怎么把 Skill 发现、挑出、注入、回收）和编写与维护工程技巧（frontmatter、描述工程、文件结构、安全契约、触发调优、治理）。"
---

# Skill 篇

读这篇之前建议先了解 Tool 调用机制——本篇把 Tool 当作 Skill 的执行底座，开篇先讲清 Skill 与 Tool / Prompt 的边界；正文再把 Skill 拆成两个观察面：

- **加载与发现机制侧**——Agent 系统怎么把 Skill 发现出来、挑出来、注入进去、用完怎么收。这一面是 Agent 运行时视角。
- **编写与维护侧**——Skill 作者怎么写 frontmatter、怎么组织正文、怎么写描述才能被精准触发、怎么迭代维护。这一面是 Skill 作者视角。

这两面是同一 Skill 在不同时刻被两个角色同时看到的——运行时关心"它怎么被找到"，作者关心"它怎么写好"。两面约束叠加生效，单面看不全。

另一条贯穿全文的内在张力正交于这两面：**经验复用 ↔ 激活时机**。经验要重复用就要常驻、要精准触发就要按场景。CLAUDE.md 是常驻那一极端、纯 Prompt Template 是靠人记忆那一极端，Skill 是这条权衡曲线上的工程化折中点。本篇解释这条曲线怎么被工程化出来。

---

## 一、动机

Skill 处在 Tool 与 Prompt 之间——它把这两种形态合成一种复合工程层：

- **内容形态借用 Prompt**——Skill 内部仍然是大段 Markdown 自然语言，LLM 用读 prompt 的方式读 Skill
- **执行能力借用 Tool**——Skill 自己不能直接动文件系统或发网络请求，它通过 `allowed-tools` 声明的子白名单，让 LLM 在执行 Skill 内容时调用底层 Tool
- **触发方式独立**——这是 Skill 独有的设计：frontmatter + TF-IDF 索引让 LLM 不靠人记忆就能从一堆 Skill 里自动挑出当前该用的

这三条合起来才是 Skill 真正的工程身份——**不是某种 Prompt 的语法升级，也不是另一种 Tool 的格式变体**。类比：React 仍然用 HTML/JS 写、Fetch 仍是浏览器 API 调用、但 React 组件的工程化封装（路由、懒加载、版本）让它成为独立的工程层。Skill 同理——"中间层"指的是它夹在两层之间，不是等级居中。

工程化的核心拉扯：**经验复用 ↔ 激活时机**。把经验放进 CLAUDE.md 永远生效（撑爆 context、不分场景）；写成 prompt template 函数（缺发现性、靠人记忆调用）；封成 Skill 目录（按场景自动匹配 + 上下文隔离 + 工具白名单）。Skill 是这条权衡曲线上目前最工程化的折中点。

### Skill vs Tool

Skill **不是**另一种 Tool。Tool 是原子能力，Skill 是经验封装——Skill 内部允许通过 `allowed-tools` 声明可用工具集，SkillTool 在主循环中作为 tool 被 LLM 调用。区别见：Tool 篇 §三 加载执行三轴 与 Skill 这边的触发三路径。

| 维度 | Tool | Skill |
|---|---|---|
| 形态 | 函数 + JSON Schema | Markdown 目录 + SKILL.md |
| LLM 看到的内容 | name + description + parameters | description（常驻段）+ 全文（触发后注入） |
| 执行方式 | LLM 直接 `tool_use` | LLM 选 SkillTool → SkillTool 加载 Skill → Skill 内调子 Tool |
| 触发方式 | LLM 推理中按 description 自选 | 加 frontmatter TF-IDF 索引 + 手动 `/skill-name` + 系统 prefetch 三路径 |
| 数量上限 | 60+（cc-05）/ 5+ 异构来源（dify-07） | 50+ 后 TF-IDF 仍可工作，但 LLM 直选要 paths / when_to_use 辅助 |

### Skill vs Prompt Template / CLAUDE.md

Skill **也不是** Prompt Template 函数或 CLAUDE.md。Prompt Template 缺发现性；CLAUDE.md 永远注入撑爆 context。Skill 多付出来的是 frontmatter 元数据 + 索引维护成本，换来 LLM 能自主挑出该用的。

| 机制 | 适用场景 | 代价 |
|---|---|---|
| CLAUDE.md | 永远成立的规范（提交规范、命名约定） | 容易撑爆 context |
| Prompt Template 函数 | 纯参数化场景（每次只是变量不同） | 缺发现性，靠人记忆调用 |
| Skill | 特定场景才用的复杂流程（专家经验封装） | 需要触发机制 + frontmatter 纪律 |
| Sub-Agent | 多轮独立思考、需要自己上下文 | 上下文完全隔离、IPC 成本 |

Skill 入口代码：`SkillTool.ts:584` 的 `SkillTool.call({skill, args})` 与 `src/commands.ts:656-666` 的 `/skill-name` 解析，是 Skill 两种触发入口；命令行 `/command` 与 Skill 在 `getCommands()` 中由 `cmd.type === 'prompt'` 区分，前者（type 为 `local` / `builtin`）关注"系统行为"，后者关注"领域行为引导"。

---

## 二、关键判断速览

### 加载与发现侧

- Skill 触发必须分三条路径：手动 `/skill-name` > LLM tool_use > 系统 TF-IDF prefetch
- turn-zero 阻塞路径能调 Haiku 翻译 CJK query，inter-turn 非阻塞路径只能用本地 TF-IDF
- 描述侧常驻（1% context 预算 + `MAX_LISTING_DESC_CHARS = 1536`），全文侧按需触发注入
- `when_to_use` 字段权重 2.0 > `description` 权重 1.0，是给 TF-IDF 索引用的触发条件
- 长 Skill（> 5K tokens）必须 `context: fork` 隔离主上下文
- 路径感知激活（`paths: ["src/**/*.ts"]`）能显著降低加载噪音
- 修改 SKILL.md 全文**不会**让已经注入的会话看到新内容——全文触发即冻结为消息，要更新必须用户重新触发

### 编写与维护侧

- frontmatter 不是装饰：每个字段都对应一个加载决策，缺哪个就少了哪种能力
- `name` 是 TF-IDF 权重最高的字段（3.0）——命名的精确性 > 描述文采
- `when_to_use` 给索引用、`description` 给 LLM 概览用，两句话写不同对象
- 单文件 Skill 正文 ≤ 1K tokens；超出就拆 `references/` / `rules/` 子文件按需加载
- `allowed-tools` 必须**白名单**列出子工具——不是禁用项，是能力范围声明
- 凭证（API Key、token）放 `.env`，永不写进 SKILL.md、永不打印在输出中
- 把"每次都用"放 CLAUDE.md；"特定场景才用"才进 Skill
- 一个 Skill < 100 行 token、正文 ≤ 5K tokens、文件目录 ≤ 5 个子文件——三个上限守任意一个就考虑拆

---

## 三、Skill 的加载与发现机制（Agent 系统怎么用 Skill）

### Skill vs 其他机制

| 机制 | 适用场景 | 代价 |
|---|---|---|
| CLAUDE.md | 永远成立的规范（提交规范、命名约定） | 容易撑爆 context |
| Prompt Template 函数 | 纯参数化场景（每次只是参数不同） | 缺发现性，靠人记忆调用 |
| Skill | 特定场景才用的复杂流程（专家经验封装） | 需要触发机制 + frontmatter 纪律 |
| Sub-Agent | 多轮独立思考、需要自己上下文 | 上下文完全隔离、IPC 成本 |

CLAUDE.md 适合"每次都用"的规范。Skill 的价值在"特定场景才用"——经验的结构化字段（触发条件、工具白名单、执行模式、上下文模式）固化下来才能被自动发现。

Prompt Template 函数跟 Skill 的边界：模板函数被显式调用，缺 `description` + `when_to_use` 两个字段，索引层看不见，依赖调用方记得住。Skill 多付出的是发现成本，换来 LLM 能自主挑出来。

### 三条触发路径必须并行

| 路径 | 触发方 | 优先级 | 实现 |
|---|---|---|---|
| 手动 `/skill-name` | 用户 | 最高 | `src/commands.ts:656-666` 解析 |
| LLM tool_use | LLM 推理 | 中 | `SkillTool.call({skill, args})`（`SkillTool.ts:584`） |
| 系统 TF-IDF prefetch | 系统猜测 | 最低 | `getTurnZeroSkillDiscovery` / `startSkillDiscoveryPrefetch` |

cc-09 §三 5 的实现：slash 命令、SkillTool.call、系统 prefetch 三路并行。优先级：明确 `/skill-name` > LLM tool_use > 系统 prefetch。

单一机制会失效：

- 纯手动依赖用户记忆，Skill > 20 个时不可持续
- 纯自动系统猜测的延迟成本和误判率都太高

### turn-zero vs inter-turn 路径设计

| 路径 | 是否阻塞 | 能调模型吗 |
|---|---|---|
| turn-zero 阻塞路径 | 是 | 可以调 Haiku 翻译 CJK query |
| inter-turn 非阻塞路径 | 否 | 只能用本地 TF-IDF |

inter-turn 非阻塞路径不能调翻译模型（latency 不可接受），只能快。CJK 处理的 bigram 兜底（`CJK_MIN_BIGRAM_MATCHES = 2` 要求 ≥ 2 个 bigram 匹配或 1 个 ASCII 匹配）是关键的工程折中。

### `when_to_use` 字段权重非对称设计

| 字段 | 权重 |
|---|---|
| `name` | 3.0 |
| `whenToUse` | 2.0 |
| `description` | 1.0 |
| `allowedTools` | 0.3 |

cc-09 §四 2 的 `searchSkills` 用字段加权 TF-IDF + 余弦相似度。权重设计的工程意图：

- `name` 权重 3.0——命名上的精确性比描述文采重要
- `whenToUse` 权重 2.0 > `description` 1.0——触发短语面向查询场景，与用户意图同构
- `allowedTools` 权重 0.3——纯约束信息，不承载语义，几乎不影响匹配

`when_to_use` 不是装饰，是给 TF-IDF 索引用的触发条件。`max()` 聚合而非 `sum()`，避免跨字段重复 token 多次计入——"`code-review`" 的 name 已含 "code"，description 里再出现 "code" 也不该双倍计分。

### 上下文生命周期：描述常驻 + 全文按需

| 组件 | 注入位置 | 容量 | 时机 |
|---|---|---|---|
| 描述侧（`description + whenToUse`） | 常驻 system | 1% context 预算（`MAX_LISTING_DESC_CHARS = 1536`） | 启动 / 索引构建 |
| 全文（SKILL.md 正文） | 触发后注入 message | 无预算上限 | 触发即冻结为消息，不再保留 |

cc-09 §四 4 的实现：描述常驻保证 LLM 始终看得见有哪些 Skill 可选；正文由触发后注入，触发即焚、不再保留。

100 个 Skill 启动时只看得见 1% 预算内的描述，LLM 不知道有什么可选；100 个 Skill 启动时全部全文加载会消耗 50K+ token。描述常驻 + 全文按需是唯一解。

**关键生命周期陷阱**：正文一旦注入就变成了会话消息里的一员。修改 SKILL.md 文件**不会**让已经在会话中触发过的 Skill 更新——用户必须重新触发才能看到新内容。这个非对称性是新作者最常误解的地方。

### 长 Skill 必须 `context: fork`

| Skill 长度 | 执行方式 |
|---|---|
| ≤ 5K tokens | inline 可接受 |
| > 5K tokens | `context: fork` 隔离 |

长 Skill（> 5K tokens）走 inline 会污染主对话上下文。`context: fork` 把 Skill 内容塞到子 Agent 的独立上下文，主对话只看到 Skill 的最终输出。三条分支由 `SkillTool.call({skill, args})` 决定（`SkillTool.ts`）：Forked / Inline / 远程命令（`!`command``）。

`context: fork` 的代价是子进程 IPC 延迟。Fork 的判断标准不只是长度：中间步骤是私有的（debug 流程、内部决策）必须 fork；中间步骤就是给用户看的（解释性输出）可以 inline。

### 路径感知激活

| Skill 类型 | `paths` 字段 |
|---|---|
| `ts-best-practices` | `["src/**/*.ts"]` |
| `k8s-debug` | `["*.yaml", "**/k8s/**"]` |
| 通用 Skill | 不设 paths |

`paths` 字段是 glob 数组，匹配当前编辑的文件路径才激活该 Skill。不设置 paths 的 Skill 在所有文件场景都会被 TF-IDF 匹配，加载噪音高。

`paths: ["src/**/*.ts"]` 的 Skill 只在编辑 src 文件时激活，能把无关场景的匹配率压到 0。

### Skill 数量与发现成本

| Skill 数量 | LLM 直选准确率 | 推荐策略 |
|---|---|---|
| < 20 | > 90% | 靠 description 直选 |
| 20-50 | 70-85% | TF-IDF 预筛 |
| 50+ | < 70% | TF-IDF 预筛 + paths / when_to_use 精细化 |

LLM 在选 Skill 时是否有"幻觉调了一个不存在的 Skill"的情况？出现 > 5% 时就要加索引层。

使用频率衰减：`score = usageCount × max(0.5^(daysSinceUse / 7), 0.1)`，7 天半衰期排名，常用的 Skill 分数高，不常用的衰减。

---

## 四、Skill 的编写与维护工程技巧

### frontmatter 字段选择与硬规范

frontmatter 不是装饰，每个字段都对应一个加载决策：

| 字段 | 决定的事 | 不写的后果 |
|---|---|---|
| `name` | TF-IDF 索引主键 + `/skill-name` 触发 | LLM 调不出 |
| `description` | Schema 描述常驻段 | LLM 不知道存在 |
| `whenToUse` | 触发短语的索引源 | 匹配率下降、靠 description 兜底噪声大 |
| `allowed-tools` | 子工具白名单 | 默认无工具约束（不一定安全） |
| `paths` | glob 路径过滤 | 所有场景都可能被 TF-IDF 命中 |
| `context` | fork 隔离开关 | 长 Skill 污染主上下文 |
| `disableModelInvocation: true` | 锁定为手动触发 | 内容敏感或成本高场景失去这层防护 |
| `version` / `author` | 治理元信息 | 多个 Skill 来源时无法判定谁新谁旧 |
| `requiresSecrets` / `sensitiveEnvironment` | host 配置策略 | 凭证类 Skill 没被沙箱隔离 |

**最少必须写**：name、description、whenToUse。这三个缺一个就能难用。

**典型组合决策**：

- 通用经验（"如何 review PR"）→ name + description + whenToUse
- 领域专项（"k8s-debug"）→ 加 paths 限定触发场景
- 写操作 Skill（"创建 PR"）→ 加 allowed-tools 白名单 + sensitiveEnvironment 提醒 host
- 长 Skill（多文件 SOP）→ 加 context: fork + multi-file references

**`name` 命名的硬规范**（权重 3.0 的字段，命名精度决定一切）：

- 简洁且唯一；小写字母 + 数字 + 连字符，禁止下划线和驼峰
- 优先动名词（gerund form，如 `running-tests` / `deploy-microservice` / `database-migration`）
- 长度 ≤ 64 字符；不带版本号、不带作者信息
- ✅ 好的例子：`running-tests`、`deploy-microservice`、`database-migration`
- ❌ 坏例子：`test-helper`（语义模糊）/ `data-skill-v2`（带版本）/ `deployService`（命名不规范）

**`description` 与 `whenToUse` 字数的硬规范**：

| 字段 | 推荐上限 | 截断值 | 写法 |
|---|---|---|---|
| `description` | ≤ 200 字 | `MAX_LISTING_DESC_CHARS = 1536` | 第三人称、含核心功能 + 触发时机关键词 |
| `whenToUse` | 5-10 个触发短语 | 无硬上限 | 关键词列表（用户怎么描述这件事） |

坏的 `description` 例子：

- "I can help you review code" —— 第一人称
- "Helps with code review" —— 缺乏触发时机

好的 `description` 例子："Review code for quality, correctness, and maintainability. Use when evaluating pull requests, refactoring existing code, or when the user asks for feedback on implementation details, edge cases, or potential bugs."

### 编写自由度分级

按任务复杂度与容错要求选 Skill 的指导强度——错配会让 Skill 命中率严重下降：

| 自由度 | 适用场景 | 指导方式 |
|---|---|---|
| **高** | 存在多种有效方法；模型决策依赖上下文 | 给原则、给启发式策略（如"代码审查：先看安全性，再看可读性"） |
| **中** | 存在首选模式；允许一定变通；行为受配置参数影响 | 给模板 / 伪代码框架（如"报告生成：按摘要-分析-建议结构"） |
| **低** | 操作脆弱且易错；一致性至关重要；必须遵循特定序列 | 给可执行脚本（如"数据库迁移：按固定顺序执行 SQL"） |

**错配的反模式**：

- 脆弱操作（如删库、生产部署）只给"启发式策略" → 模型自由发挥，事故高发
- 探索性任务（如代码审查的思路）写死成"按步骤 1-5 执行" → 失去灵活性，命中率反降
- 多策略并存的任务只给一种默认 → 模型跑偏或乱选
- 不允许偏差的高一致性任务跳过脚本直接用 prompt → 输出不稳定

**默认路径优先**：存在多个选项时必须指明默认路径，只在边界条件下才允许变通。这是自由度"高"也必须遵守的底线——给原则不是让模型猜默认。

### 内容组织：单文件 vs 多文件

单一 SKILL.md vs `references/` + `rules/` + `scripts/` 多文件目录，按内容规模决定：

| Skill 总规模 | 推荐结构 |
|---|---|
| ≤ 1K tokens | 单 SKILL.md |
| 1K-5K tokens | SKILL.md 主体 + 1-2 个 references 子文件 |
| 5K-20K tokens | SKILL.md 入口契约 + references/ + rules/ + scripts/ 多层 |
| > 20K tokens | 拆成多个 Skill 而不是堆 |

**多文件 Skill 的纪律**（参考 CordysCRM-skills）：

- SKILL.md 只放：入口契约（frontmatter）、总体编排蓝图、加载策略表、安全红线、输出原则
- `core/<engine>.md` 放：单一职责的引擎，按激活信号懒加载
- `references/` 放：API 文档、字段类型速查、OpenAPI 规范——作为事实参考
- `rules/` 放：可扩展的业务/表单/字段映射规则——增强不覆盖系统规则
- `scripts/` 放：执行 CLI——把 HTTP/鉴权/重试封死到子进程，Agent 只看 stdout

**多文件 Skill 的硬规则**：

- SKILL.md 是常驻入口，必须可独立读懂（其他文件可以按需加载）
- 每个子文件都要有"何时读我"的信号写在 SKILL.md 的加载策略表里
- 子文件之间**不直接引用**——所有协同靠 SKILL.md 这条总线，避免链式触发

**渐进式披露的定量纪律**（来自一线工程经验）：

- **SKILL.md 主体 ≤ 500 行**——超出就把"次要但有用"的内容拆到子文件。常驻段是上下文预算的硬约束
- **所有引用保持一层深度**——子文件再引用子文件会让模型只读一半，丢失关键信息。SKILL.md → references/foo.md 是合法；foo.md → bar.md 是链式，越界
- **长文件（> 100 行）顶部加目录**——提供 Table of Contents，让模型秒判"我需不需要读它"。cordys 的 cli-spec.md（526 行）就该配 TOC

CC-09 的 cordys 样本就是这样组织的：`SKILL.md` 仅做"何时调哪份引擎、谁来管安全"的总线，把"怎么做"（`scripts/cordys.sh`，582 行 Bash）和"系统是什么样"（`references/` + `rules/`）拆到子层。Agent 加载时先看 SKILL.md，按需下钻其他子文件。

**子目录承载形态判断**（数据放哪个子目录）：

| 承载形态 | 文件位置 | 用途 | 例子 |
|---|---|---|---|
| **核心 SOP（每次都要看）** | SKILL.md 主体 | 触发后必然用到的步骤 | 写操作五步：表单→校验→预览→写入→回查 |
| **参考文档（按需查阅）** | `references/` | API 字段、类型字典、命令参数速查 | cli-reference.md 字段类型操作符字典 |
| **业务规则（可扩展）** | `rules/` | 客户化校验、行业规则 | `rules/form-rules/{module}.md` |
| **执行代码（操作落到底）** | `scripts/` | 把 HTTP/鉴权/重试封死到子进程 | cordys.sh CLI |
| **运行时身份（不入库）** | `user-role.md` 等 | 缓存推断结果，命中加速 | 角色会话级身份文件 |

边界判定口诀：数据是"事实" → references/；是"规则（可改的判定）" → rules/；是"动作" → scripts/。references/ 和 rules/ 的关键差异：references/ 是客观事实（CLI 命令族、操作符列表），rules/ 是主观偏好。把规则放进 references/ 会让"规则的修改"与"事实的更新"耦合，错改一处全错。

### 输入输出结构化（函数签名风格）

Skill 内每个动作都要把 Input / Output 写得像函数签名——LLM 才能精准填空：

```yaml
Input:
  - prId: string         # PR 编号
  - branch: string       # 分支名称
  - runTests: boolean    # 是否执行单元测试
Output:
  - success: boolean
  - testReport?: object[]
  - errorMessage?: string
```

反面是"帮用户跑测试并返回结果"——LLM 不知道输入有几个必填、输出要不要结构化、错误怎么办。

**结构化的两条纪律**：

1. **类型与语义一起写**——`prId: string` 不够，要写"# PR 编号"；`limit: number` 不够，要写 "# 1-based 行号上限 1000"。`.describe()` 风格的注释必须出现在每个字段
2. **可选字段标 `?`**——LLM 才知道哪些字段能省，省略时不会把"我没传"当成传了 `null`

这条规则跟 Tool 篇的 Schema 工程高度同构，只是 Skill 的 I/O 是 Markdown 文本而非 JSON Schema——结构化思维是一致的。

### 工作流与反馈闭环

对含多步骤、中间结果影响最终质量的复杂任务，仅给最终目标不够——必须显式定义工作流 + 检查清单 + 反馈闭环。

**工作流 vs 检查清单的边界**：

- **工作流**——约束任务执行顺序（Step 1 → Step 2 → Step 3）
- **检查清单**——追踪每步状态（已完成 / 进行中 / 待执行），显式让模型"复制清单 + 逐步打钩"

两者结合显著降低遗漏和跑偏。模板：

```markdown
## 技术方案评估工作流

在开始执行前复制以下清单，并在每一步完成后显式标记状态。

- [ ] Step 1: 明确业务目标与技术约束（性能、成本、时限）
- [ ] Step 2: 列出所有可行的技术方案
- [ ] Step 3: 从复杂度、可维护性、风险角度逐一评估
- [ ] Step 4: 对关键差异点进行对比分析
- [ ] Step 5: 给出结论性建议，并说明取舍理由
```

**反馈闭环**：每一步都可能"推翻前一步"。把反馈闭环显式写进工作流，让模型知道何时该回退：

- Step 4 发现关键信息不足 → 返回 Step 2 / Step 3 补充分析
- Step 5 结论无法支撑目标 → 重新审视 Step 1 的前提条件

代码类任务（重构、依赖升级、配置变更）的"计划 → 验证 → 执行"模式：

```markdown
## 依赖版本升级工作流

- [ ] Step 1（Plan）: 识别需升级的依赖及当前版本；阅读目标版 Release Notes
- [ ] Step 2（Plan）: 更新依赖配置；标注可能受影响的模块
- [ ] Step 3（Validate）: 跑 dependency_check.sh；失败 → 回退 Step 2
- [ ] Step 4（Execute）: 安装新版本；跑完整测试集
- [ ] Step 5（Validate）: 对比前后构建；回归 → 回滚并记录风险点
```

**分析类任务同样适用工作流**——不限于代码。检查清单帮模型明确"当前到哪一步、是否可进下一步"，跑偏概率显著下降。

### 脚本加固三原则

Skill 内 `scripts/` 子目录里的可执行脚本，健壮性始终优先于巧妙性——Skill 只感知 I/O，不读代码逻辑。脚本必须做到：**失败可预期、输出可理解、参数可解释**。

**原则 1 · 显式处理错误，不让模型猜**

不要把异常直接抛给模型。脚本覆盖常见错误场景，把技术异常翻译成"可理解 + 可决策"的输出。

✅ 配置文件校验脚本：

```
ERROR: Config file not found: ./deploy.yaml
HINT: Please check whether the file path is correct or run init-config.sh to generate a default config.
```

实践要点：捕获常见异常（文件缺失、权限不足、配置错误）；为每类错误返回"原因 + 下一步建议"。

**原则 2 · 输出自解释（成功 + 失败都有明确输出）**

脚本输出本身就是模型的上下文。好的输出不仅说明"发生了什么"，还说明"为什么" + "接下来怎么做"。

✅ 构建环境检查脚本：

```
CHECK FAILED: Node.js version mismatch
- Required: >= 18.0.0
- Detected: 16.14.0

VALID OPTIONS:
1. Upgrade Node.js to a supported version
2. Switch to a compatible build image
```

实践要点：成功路径和失败路径都要有输出；验证类脚本明确列出通过项与失败项。

**原则 3 · 避免魔法数字，让常量可解释**

`TIMEOUT = 30` 这种常量若缺解释，模型和人都判断不了它是否合理。任何影响行为的数值都要可解释、可调整。

✅ 部署等待脚本的两种方式：

```python
# 注释 + 命名 + 来源
TIMEOUT_SECONDS = 30  # 服务启动通常 10-20s，超时给 30s 余量

# 或运行时告诉用户
print(f"INFO: Waiting for service to become healthy (timeout: 30s)")
```

实践要点：常量加语义化命名；说明数值来源；必要时允许命令行参数覆盖默认。

### 评测驱动、失败优先的迭代六步

Skill 的开发是**以失败为起点、评测为牵引、持续迭代**的工程化过程。评测不是事后的验证，是 Skill 设计的前提；Skill 不是基于假设的规则集合，是针对已暴露问题的最小化解决方案。

**六步流程**：

#### Step 1 · 建立"无 Skill"基线，识别真实问题

不写 Skill，先让模型直接执行目标任务——这是基线对照。重点观察：

- 模型在哪些情况表现不稳定或不可复现
- 哪些输入会引发歧义、误解或走偏
- 模型是否在错误的时机"主动帮忙"

这些失败点和不确定行为**就是** Skill 要解决的真实能力缺口，也是后续评测用例的来源。

#### Step 2 · 失败优先定义评测用例

优先编写评测用例再开发 Skill——评测是约束，Skill 是落地实现。脱离评测约束的 Skill 是在放大模型行为不确定性。

每个评测用例三要素：

- **输入**：具体任务描述（真实场景取自 Step 1 记录）
- **预期**：通过 / 失败的明确判定标准
- **覆盖意图**：测的是"应该做"还是"不该做"

推荐：3-5 个起步，优先覆盖模型最易误用的场景。

#### Step 3 · 编写最小化 Skill，只走最短成功路径

评测已存在，开始写 Skill。此阶段不追求覆盖所有情况——只写刚好能通过当前评测的最小规则集合。三要素：

- **明确失败条件**——把 Step 2 识别的失败场景显式写入 Skill，作为第一层防护
- **定义最短成功路径**——最简单、最核心的执行流程，确保最精简输入有可预测输出
- **保持职责单一**——单个 Skill 只解决一个明确问题

这一阶段的 Skill 是评测结果的直接产物，而非凭经验预判的方案。

#### Step 4 · 补充边界条件与结构化示例

最短成功路径稳定通过评测后，再扩展 Skill 的适用范围：

- 补充更多边界场景及对应行为约束
- 明确 Skill 输入 / 输出的结构化定义（函数签名风格，详见"输入输出结构化"）
- 补充关键输入、输出示例，帮模型对齐行为预期

核心原则：**新增规则必须对应新增或已有评测用例**，避免在无评测支撑下把 Skill 复杂化。

#### Step 5 · 评测回归与持续迭代

Skill 的迭代始终与评测结果强绑定：

- 新增评测用例 → 推动 Skill 的增量修改
- 对 Skill 的任何修改 → 都必须通过**已有评测**的回归验证
- 评测未通过 → **优先简化 Skill**，不盲目叠加新规则

持续对比"无 Skill 基线" vs "当前 Skill + 评测"的表现，验证 Skill 是否真正提升成功率与稳定性。

#### Step 6 · 真实使用路径校准（闭环回归）

评测只能覆盖已知问题——真实使用会暴露更多新问题。需持续观察：

- 模型是否在非预期场景下误触发 Skill
- 模型执行时是否遗漏关键参考文件或上下文
- 模型是否反复读取同一段内容形成隐性依赖（往往是过度耦合的信号）

上述信号作为新评测输入重新进入 Step 2，形成迭代闭环。

**结合 AI 加速的工作方式**：让 AI 从真实任务中抽象出创建 Skill 所需的信息——让 AI 先执行任务（执行过程的追问、走偏、修正 = 隐式评测），任务完成后引导 AI 从"成功步骤 / 不确定点 / 可抽象的固定流程 / 适用与不适用场景"复盘；AI 按规范生成初版 SKILL.md，人工评审边界后入库。后续迭代同样让 AI 对齐偏差来源（When / What / How 哪个环节）、修改后验证回归。

### 触发精准度调优工作流

当一个 Skill "该被触发时没触发" 或 "不该触发时被触发"时，按这个流程调：

1. **观察真实 query vs 触发匹配**——从 logs 拉被 prefetch 命中的 query 和未命中但实际触发了的 query
2. **区分问题是描述还是路径**：路径不对是 `paths` 没设或设错；路径对了但 TF-IDF 没匹配是 `when_to_use` 或 `description` 没写好关键词
3. **调整优先级**：
   - 路径问题 → 加 / 改 `paths`
   - 描述问题 → 加 trigger 短语到 `whenToUse`
   - 命名问题 → 改 `name`（慎重，破坏外部触发）
4. **回测**：用历史 30 条相关 query 跑一遍索引，看命中率变化
5. **灰度**：先修改一个文件验证一周，再决定是否成为稳定值

不要做的事：

- 直接堆关键词到 `description`——`description` 字数会膨胀，超出 `MAX_LISTING_DESC_CHARS` 会被截断
- 改 `name` 来"帮助触发"——`name` 改了，旧用户输 `/old-skill-name` 还能命中（aliases），但索引层权重最高的就是它，破坏性大
- 多个 Skill 抢同一个触发短语——会出现"该触发的没触发，触发的是别人"

### 安全契约的写法

**凭证隔离**：API Key、token、secret 全部放 `.env`，SKILL.md 中只引用环境变量名（如 `${CORDYS_ACCESS_KEY}`），绝不出现在输出或日志里。CC-09 cordys 样本的安全红线之一就是"绝对禁止输出 `CORDYS_ACCESS_KEY`/`CORDYS_SECRET_KEY` 的值"。

**禁用逃生口的两种方式**：

| 机制 | 配置 | 适用 |
|---|---|---|
| `disableModelInvocation: true` | 锁定只能手动 `/skill-name` | Skill 内容敏感、LLM 误触发代价高 |
| 默认不放 `!`command`` | frontmatter 中不声明 `!command` | 避免 shell 注入扩大攻击面 |

`!`command`` 是 Skill 中允许写 Bash 命令直接执行的"逃生口"（`SkillTool.call` 第三分支）。**远程 / 第三方 Skill 来源必须关闭此机制**——受信 Skill 来源才保留。当前实现没有 sandbox——用户在 SKILL.md 里写 `` !`rm -rf /` `` 会被认真执行，是个"灵活性换安全"的取舍。

**敏感环境标注**：

- `requiresSecrets: true` → host 必须为此 Skill 走 secrets 沙箱
- `sensitiveEnvironment: true` → host 必须把执行环境隔离（不继承其他 Skill 的环境变量）
- `externalNetworkAccess: true` → host 提示该 Skill 需要外网访问，做网络监控分级

**安全红线怎么写**：安全红线**必须**写进 SKILL.md 的常驻段（不是放 rules/），让 Agent 每次加载都看到。CC-09 cordys 样本的安全红线就是这个写法："不提供、不封装、不响应任何删除意图"，写进入口契约让模型无法绕过。

**默认路径优先**：含多个选项的 Skill 必须指明默认路径（详见"编写自由度分级"高自由度的边界），只在有充分理由时才允许变通——避免模型在执行有副作用的操作时自己猜。

**跨平台与术语纪律**：

- 文件路径用 POSIX 风格（`configs/deploy.yaml`），不用 Windows 反斜杠
- 同义术语统一在一个术语下（如全部用 "Service Endpoint" 而非混用 "API URL" / "Endpoint Path"），避免 LLM 把同一概念识别成两个东西

### Skill 数量治理（合并 / 拆分 / 废弃）

Skill 数量随项目增长会失控，需要治理周期：

| 动作 | 适用 | 做法 |
|---|---|---|
| **合并** | 两个 Skill 触发场景重叠 > 70% | 把高频的合并到主 Skill，低频改成主 Skill 内的 `whenToUse` 子分支 |
| **拆分** | 一个 Skill 触发场景差异常大（如"通用代码 review" + "安全专项 review"） | 按场景拆，paths 互不重叠，新 Skill 命中率更高 |
| **废弃** | 90 天未被触发 | 移到 `archive/` 子目录，frontmatter 加 `deprecated: true` + `successor: <new-skill>` |
| **改名** | `name` 不够精确 | 保留旧名作为 aliases，灰度迁移，新文档统一指向新名 |

合并的硬标准：两个 Skill 在真实 query 集合上 > 70% 都该触发其中一个，则合并有收益。单纯描述相似不算。

废弃的硬标准：90 天 0 次触发。但有一条例外——专门用于稀有场景（"季度报税 Skill"）即使半年没触发也不能删，因为它的"缺失即损坏"。

**时效性内容处理**：把易过期信息放在 `deprecated/` 子目录、注明"不再推荐使用"，不要在 SKILL.md 正文里写"2025 年 8 月之后请使用新 API"这类自带过期日的内容。

### 调试与观测

一个 Skill 没按预期工作，需要的诊断手段：

| 现象 | 先查什么 |
|---|---|
| 完全不触发 | Skill 注册了吗？`disableModelInvocation` 设了吗？`paths` glob 命中当前文件了吗？ |
| 触发频次过低 | `whenToUse` 关键词写得好吗？TF-IDF 看看用户 query 在索引里的命中 token |
| 触发频次过高 | `description` 太宽？还是 `paths` 没设？检查评分阈值 |
| 触发后行为不对 | 全文内容是不是过期？上次会话注入的旧版本是否还在 message 里？ |

`score = usageCount × max(0.5^(daysSinceUse / 7), 0.1)` 是按使用频率排序的引擎，写观测时把它当成"健康度"——突然掉到 0.1 floor 的 Skill 要检查是否还有效。

观测必须看三类信号：

- **触发命中**——TF-IDF 给它的评分、是否被注入、注入的版本
- **会话内行为**——触发后 LLM 真的执行了 Skill 内容吗？还是读了不照做
- **失败案例**——用户不满 / 重新触发另一个 Skill / 显式回退

### 版本与热更新边界

Skill 版本变更的可见性矩阵：

| 改动 | 是否需要用户重新触发 |
|---|---|
| `description` 字段 | 否（启动时已被系统读取） |
| `whenToUse` 字段 | 否（索引已 cached 到该 cwd） |
| `allowed-tools` | 否（启动时已注入 system prompt） |
| `context` 字段 | 否 |
| **SKILL.md 全文** | **是（一旦注入即冻结为消息）** |

热更新的硬限制：用户和 LLM 之间的会话历史是不可变的——如果 Skill 在会话 A 中被触发，会话 A 余下的所有轮次看到的都是触发那一刻的全文。改 SKILL.md 文件**不会**让该会话看到新内容，会话外的下次触发才会看到。

工程纪律：

- 关键 Skill 改动发版本时要附"哪些字段变了"——决定是否需要 reset 会话
- 老会话里被触发过的 Skill 全文是不可变的快照——调试"为啥这个会话说得不对"先查那一刻的注入内容

### 何时不该用 Skill

> 总原则：不属于"领域经验封装"范畴的，硬塞成 Skill 都会失败。

Skill 不是"放之四海而皆准"的封装，遇到这些场景**别用 Skill**：

| 场景 | 替代方案 |
|---|---|
| 内容每次都用（"提交规范"、"命名约定"） | CLAUDE.md |
| 纯参数化模板（prompt 里只是变量不同） | Prompt Template 函数 |
| 是单一原子能力（点一个按钮就能完成） | Tool |
| 需要独立多轮思考 + 隔离子上下文 | Sub-Agent |
| 临时一次性指令 | 直接写在 user message 里 |
| 内容每周变（业务规则变更频繁） | 不封成 Skill，每次告诉 LLM |

边界判定口诀：

- **每次都用** → CLAUDE.md
- **场景化但简单** → 单文件 Skill
- **场景化且复杂 SOP** → 多文件 Skill
- **场景化且需要隔离** → `context: fork` Skill 或 Sub-Agent
- **单一动作** → Tool
- **每次都不同** → 别封，prompt 里直接写

---

## 五、反模式

### 加载与发现侧反模式

- Skill 描述写得又臭又长，verbose `whenToUse` 浪费 turn-1 的 cache_creation tokens 而不提升匹配率。`MAX_LISTING_DESC_CHARS = 1536` 是经验值，超过截断
- Skill 全部 inline 执行，长 Skill（如代码审查）走 inline 会污染主对话上下文
- 不区分 turn-zero 阻塞路径和 inter-turn 非阻塞路径，后者不能调 Haiku 翻译 CJK query
- 每次都全量加载 Skill 正文，100 个 Skill 启动时消耗 50K token
- 忽略路径感知的条件激活，`paths: ["src/**/*.ts"]` 能显著降低加载噪音
- 把 Skill 当 Tool 注册，Skill 是 Prompt 经验封装，不是工具
- 远程 Skill 启用 `!`command`` shell 展开，远程内容不可信

### 编写与维护侧反模式

- `name` 命名宽泛不精确——"code-helper" 这样的名字 TF-IDF 评分反而低
- `description` 写"我能干什么"功能列表，不写"什么时候不该调"——LLM 会跟 Read/Edit 选错
- `whenToUse` 写空泛短句（"通常用于代码任务"）——索引层全是噪声 token
- 缺 `allowed-tools` 白名单——Skill 实际允许 LLM 用全部工具，权限边界失效
- 长 Skill 不写 `context: fork`——主上下文被污染
- 路径型 Skill 不写 `paths`——所有场景都被触发
- frontmatter 只写 `name + description`，其他全靠正文凑——加载决策失败
- 把凭证写进 SKILL.md——必须走 `.env`
- SKILL.md 改动完默认下次会话生效——其实会话内已冻结
- 多文件 Skill 写成"链式引用"——A 引用 B，B 引用 C，加载成本不可控
- 多个 Skill 抢同一个 trigger 短语——触发的常常不是你想要的
- 把业务规则（可变规则）写进 `references/`——和事实耦合，应该放 `rules/`
- 用 SKILL.md 装"每周都变的临时指令"——违反"每次都不同就别封成 Skill"
- 改 `name` 来"帮助匹配"——破坏外部 /skill-name 触发和索引权重
- 没有观测手段就上线新 Skill——出问题了不知道怎么调
- 文件路径用 Windows 反斜杠（`configs\deploy.yaml`）——跨平台兼容性差，Unix/Linux 会报错
- 提供过多选项不指明默认路径——模型困惑，增加决策成本（详见"编写自由度分级"高自由度的边界）
- 在 SKILL.md 正文里写时效性内容（"2025 年 8 月之后请使用新 API"）——信息会过期，应放 `deprecated/` 子目录
- 术语不一致（同一概念混用 "API URL" / "Service Endpoint"）——增加模型理解成本
- 复杂操作只给"启发式策略"——脆弱任务缺脚本兜底，输出不稳定
- 同质子规则拆成多个 Skill——触发场景重叠 > 70% 时合并更划算（详见"Skill 数量治理"）
- Skill 内只给最终目标不给工作流——多步骤任务要写 Step 序列 + 复制清单 + 反馈闭环（详见"工作流与反馈闭环"）
- scripts/ 子目录下脚本让异常冒泡到模型——必须显式捕获 + 翻译成"原因 + 建议"（详见"脚本加固三原则"）
- 跳过评测直接扩 Skill——无评测支撑的复杂度是负资产（详见"评测驱动、失败优先的迭代六步"）
- 改完 Skill 不做回归验证——改一个判例破坏全部黄金路径

---

## 七、样本索引

> 应用笔记目录待建，以下引用路径保留为占位，等目录建好后自动生效。

<details>
<summary><strong>Claude Code Skill 系统（cc-09-skill-system.md）</strong>（点击展开）</summary>

**加载与发现机制**
- §三 2 核心抽象 —— Skill = 目录 + SKILL.md，frontmatter 16 字段
- §四 2 查询匹配 TF-IDF 余弦相似度与 CJK 兜底 —— 字段加权 TF + IDF + 余弦 + CJK bigram
- §四 3 触发与执行 三条路径如何协作 —— 手动 / LLM tool_use / 系统 prefetch
- §四 4 上下文生命周期 描述常驻与全文注入 —— 描述侧 1% 预算 + 全文侧触发注入
- §三 2 paths 字段 路径感知激活 —— glob 匹配当前编辑文件路径才激活

**编写与维护**
- §三 2 frontmatter 字段全集 —— name / whenToUse / description / allowedTools / paths / context / disableModelInvocation 等
- §三 5 SkillTool.call 三条分支 —— Forked / Inline / 远程 `!command``
- §四 4 生命周期陷阱 —— 全文注入即冻结为会话消息，会话内改 SKILL.md 不生效
- §六 安全边界 —— `!`command`` 无沙箱、disableModelInvocation 的设计意图
- §三 5 allowedTools 白名单 —— 白名单是能力范围声明，不是禁用项

</details>

<details>
<summary><strong>CordysCRM-skills 样本（cordys-crm-skill-breakdown.md）</strong>（点击展开）</summary>

本文是 Skill 篇编写与维护侧的真实样本——一个企业系统如何按 Skill 规范写成多文件目录结构。

- §二 四层结构 —— 入口层 / 认知层 / 执行层 / 知识层的物理分离
- §二 SKILL.md frontmatter 16 字段 —— name / description / environment / security 的工程意义
- §二 渐进式加载策略表 —— 每个子文件的"何时读我"信号写在 SKILL.md 里
- §二 安全红线写进入口 —— "禁删/禁输出密钥/跨域拒绝"反复写在 SKILL.md 让模型每次都看到
- §三 各引擎按需加载—— role-engine 强制 + 其他按激活信号懒加载
- §四 Skill 规范遵循 —— 入口契约 / 清单 / 加载协议 / 凭证隔离 / 多宿主适配 / 运行时无关

</details>
