---
sidebar_position: 6
sidebar_label: 06：模型接入
description: 模型接入模块纵线：原型的 providers.yaml 静态清单与特性位分支，重建阶段的 Provider Connection 与分段装配计时，以及现状的动态模型目录发现、参数契约与上下文预算。
---
# 模型接入：从静态清单到动态发现

模型接入对应总览「共同的功能模块」矩阵里的模型接入一行，正对「接口兼容与安全」那组难题里的多模型兼容。这条线上各平台的路线分岔最清楚：Dify 自研 Model Runtime 并插件化到独立生态，Octop 在 harness 里收敛 Provider，本平台从「静态清单 + 逐家适配」走到了「协议收敛 + 动态发现」——不做五十家供应商的适配器，只认 OpenAI 兼容目录这一种协议，把适配面收到最小。

> **本篇弧线**
>
> - **初识**：providers.yaml 静态清单，每供应商一个目录，特性位分支
> - **重建**：凭据升级为账号下的连接，装配分段计时
> - **现状**：动态目录发现、参数契约、上下文预算与兼容中间件

## 一、核心工程问题：用最小适配面抹平供应商差异

模型接入这条线要回答的工程问题：各供应商在工具调用格式、流式协议、模型能力上都不一样，平台要用多小的适配面把它们抹平，又不在深度适配上失控。三个子问题贯穿全文：

- **能力差异要建模**。从原型的特性位（TOOL_CALL、AGENT_THOUGHT）到现状的参数契约与模态声明，「模型能力不同」始终是接入层的第一等公民（第二节、第四节）。
- **协议收敛，不逐家适配**。认准 OpenAI 兼容目录一种协议，动态发现加失败兜底，换来「兼容网关后面的模型即填即用」，而不是几十个适配器的维护（第四节）。
- **元数据要可信**。供应商目录参差不齐，类型靠推断、模态靠归一化——推断是便利不是事实，每项来源都记进元数据供人工修正（第四节）。

暗线是接入层的出口接运行时：上下文预算与兼容中间件把「这个模型窗口多大、工具调用什么格式」翻译成下游能直接消费的约束（第四节，与第七篇衔接）。

## 二、初识：providers.yaml 清单

原型的模型接入是清单驱动的。`LanguageModelManager` 在初始化时读取 `providers.yaml`（`api/internal/core/language_model/`），按清单构建供应商注册表；每家供应商一个目录、目录里一个 chat.py——openai、moonshot、tongyi、ollama、deepseek、wenxin 各自维护模型类。清单节选：

```yaml
- name: openai
  label: OpenAI
  description: OpenAI提供的模型，例如GPT-4o-mini和GPT-4o。
  supported_model_types:
    - chat
    - completion
- name: deepseek
  label: 深度求索
  description: 幻方量化提供的LLM大语言模型，涵盖deepseek-chat和deepseek-reasoner等。
  supported_model_types:
    - chat
```

供应商凭据存在 platform 表里，每个模型类自带元数据：定价（供 LLM 节点计费用）、特性位（`ModelFeature.TOOL_CALL`、`AGENT_THOUGHT`）、上下文参数。特性位是这套设计里最有生命力的部分——Agent 循环按特性位决定走函数调用还是 ReAct 降级（第二篇运行时里的 ReACTAgent 就是它的消费方），「不同模型能力不同」这件事从第一天就被建模了。

局限同样清楚：清单是静态的，模型列表是手写的，接入新供应商或新模型都要改代码发版；目录里的元数据（窗口、定价）与供应商真实状态可能脱节。这套结构与 Dify 早期 Model Runtime 的 provider YAML 如出一辙——原型照抄的正是那一代设计。

## 三、重建：连接与装配分段

重建阶段模型接入从「一份供应商配置」升级为「账号下的连接」。`ProviderApiKey` 表把凭据独立成账号资源，同一供应商可以有不同连接；`LanguageModelService.load_language_model` 的装配顺序固定为：解析并授权连接、规范化模型配置、创建实际客户端，`model_load_timing` 把配置处理与客户端构造分开计时。

模型选择独立成服务：默认模型、允许的手动覆盖、失效回退三种规则集中在一处，各入口不再各写一套。这些改造服务的是同一个目标——「等待模型调用开始」这类问题要能定位到具体装配阶段，而不是笼统的慢。

## 四、现状：动态目录发现与参数契约

### 1、目录发现

现状的模型列表不再手写。`ModelDiscoveryClient`（`internal/core/language_model/model_discovery.py`）在用户填写 API Key 时调用供应商的模型目录接口（OpenAI 风格的 models 列表，带候选端点回退），把目录条目统一转换成平台的 ModelEntity。发现结果带短期缓存，缓存与失败兜底的策略值得看（节选）：

```python
cache_key = (
    provider.name,
    service_base_url,
    hashlib.sha256(api_key.encode("utf-8")).hexdigest(),
)
...
if last_error is not None:
    logger.warning(
        "动态发现供应商模型失败 provider=%s，保留上次发现结果",
        provider.name,
    )
return self._copy_models(stale_models)
```

缓存键由供应商、网关地址与 API Key 摘要构成——不同连接各自缓存互不污染；网络失败时返回上一次成功结果而不是空列表，用户界面不会因为一次抖动丢掉整个模型目录。

### 2、从目录条目到可用元数据

供应商目录给的条目参差不齐，转换层要补齐平台需要的元数据：

- **模型用途**：优先读目录显式声明，缺失时按名称推断（rerank、embedding、whisper、tts 一类标记词）；
- **输入输出模态**：别名归一化（text、image、audio、video、file 以及 embedding、rank 等变体）；
- **参数定义**：带契约版本（parameter contract v2），声明来源标注 declared 或 inferred；
- **输出上限**：chat 模型未声明时按预设补缺省值。

> 推断是便利，不是事实——每项推断都在元数据里记下来源，页面可以提示用户人工修正。

### 3、预算与兼容中间件

模型接入的出口接上两块运行时设施。`with_context_budget` 计算上下文预算：结合模型输入限制、总窗口与输出预留得出可用输入上限，再扣掉按上限约 2% 计算的安全余量（限制在 256 到 4096 token），拿不到输入预算时不伪造数值；目录没给窗口时用平台缺省值兜底。

模型兼容 middleware 抹平各供应商工具调用格式与流式协议的差异——原型时代写在 ReACTAgent 里的按特性分叉，现在成为可组合的中间件而不是 Agent 循环里的 if 分支。`ContextWindowMiddleware` 在调用前生成估算、返回后用供应商真实用量回填，页面上的窗口占用与压缩进度都以观测值为准。

### 4、去留与对照

目录发现、连接管理、预算计算、兼容中间件自持；模型客户端本体走 LangChain 生态。与 Dify 的对照在这条线上最鲜明：

|      | Dify                                  | 本平台                     |
| ---- | ------------------------------------- | -------------------------- |
| 选择 | 几十家供应商的 Model Runtime 插件生态 | OpenAI 兼容目录协议        |
| 换来 | 深度适配                              | 兼容网关后面的模型即填即用 |

取舍依据是平台的真实场景——用户模型大多在兼容网关后面，逐家适配的维护成本换不来对等收益。原型清单时代的遗产只剩特性位思想：它演化成了参数契约与模态声明，仍然是「模型能力不同」这件事的标准答案。

模块纵线的上一篇是[工具体系](./05-tool-system.md)，下一篇见[记忆与上下文](./07-memory-and-context.md)，目录与状态见[专栏入口](./index.md)。
