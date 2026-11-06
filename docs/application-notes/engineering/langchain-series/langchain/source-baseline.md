---
sidebar_position: 17
sidebar_label: 源码基线与测试证据
description: 记录 LangChain 系列的固定提交、包版本、依赖边界以及已阅读的测试设置和断言，区分源码核验与运行验证。
---

# LangChain 源码解析：源码基线与测试证据

> 固定提交与已阅读测试见[源码基线](source-baseline.md)。

本页说明系列中的代码来自哪里、哪些断言可回到仓库核对，以及本次没有验证的运行行为。核对日期为 2026 年 10 月 3 日；日期表示本站阅读时间，不是源码发布日期。

## 一、固定提交与包版本

仓库为 langchain-ai/langchain，提交固定为 `76c32db9b38dfc287c958dc2a914d4834f022c1c`。正文的 `libs/…` 路径相对该仓库根目录。引用的版本来自这份工作树的项目声明与锁文件，不用于宣称当前最新版。

| 包或依赖 | 本系列基线 | 核对位置 |
| --- | --- | --- |
| langchain | 1.3.7 | [libs/langchain_v1/pyproject.toml](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/pyproject.toml) |
| langchain-core | 1.4.6 | [libs/core/pyproject.toml](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/core/pyproject.toml) |
| langchain-classic | 1.0.8 | [libs/langchain/pyproject.toml](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain/pyproject.toml) |
| langchain-text-splitters | 1.1.2 | [libs/text-splitters/pyproject.toml](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/text-splitters/pyproject.toml) |
| langgraph / langgraph-prebuilt | 1.2.4 / 1.1.0 | [langchain_v1/uv.lock](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/uv.lock) |

源码工作树中已有的说明文件改动及未跟踪生成文档不作为实现证据；本次未修改 LangChain 源码。分析范围内的 libs 路径对 HEAD 无差异。

## 二、核心实现入口

| 要追踪的问题 | 固定源码 | 主要入口 |
| --- | --- | --- |
| Agent 怎样装配和路由 | [factory.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/factory.py) | create_agent、_get_bound_model、_handle_model_output、_make_model_to_tools_edge |
| 中间件怎样声明请求与 hook | [middleware/types.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/middleware/types.py) | AgentMiddleware、ModelRequest、ModelResponse |
| 输出策略怎样解析结果 | [structured_output.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/structured_output.py) | ToolStrategy、ProviderStrategyBinding、_parse_with_schema |
| 模型层怎样提供结构化包装 | [chat_models.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/core/langchain_core/language_models/chat_models.py) | BaseChatModel.with_structured_output |
| 审批怎样改变待执行调用 | [human_in_the_loop.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/middleware/human_in_the_loop.py) | after_model、_process_decision |
| 重试和回退怎样重复 handler | [model_retry.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/middleware/model_retry.py)、[model_fallback.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/langchain/agents/middleware/model_fallback.py) | wrap_model_call |
| 检索怎样变成工具结果 | [tools/retriever.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/core/langchain_core/tools/retriever.py)、[tools/base.py](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/core/langchain_core/tools/base.py) | create_retriever_tool、BaseTool.run、_format_output |

固定提交链接用于长期回查；各篇仍保留对应文件、函数和必要片段。引用某个函数时省略其他分支，不表示那些分支不存在。

## 三、已阅读的测试设置与断言

下表记录源码中写出的测试，并未在本次执行。测试名可以在对应文件内直接查找；“说明什么”限于该测试的设置和断言。

| 测试 | 设置与断言 | 证据边界 |
| --- | --- | --- |
| [test_three_handlers_composition](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/core/test_composition.py) | 三层包装器按 first、second、third 进入，再反向返回 | 验证 handler 嵌套顺序，未验证整笔订单流程 |
| [test_model_retry_succeeds_after_retries](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_model_retry.py) | 模型前两次失败，断言第三次成功且 attempt == 3 | 测试模型，不涉及真实网络请求与供应商计费 |
| [test_human_in_the_loop_middleware_default_rejection_message](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_human_in_the_loop.py) | mock interrupt 后直接调用 hook；断言两条更新消息及拒绝结果的 status、name、tool_call_id | 验证消息配对，不是持久化恢复端到端测试 |
| [test_human_in_the_loop_middleware_single_tool_respond](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_human_in_the_loop.py) | 原调用保留，人工文本成为同一 ID 的成功 ToolMessage | 不证明外部工具实际执行 |
| [test_multiple_structured_outputs_with_retry](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/test_response_format.py) | 首次两个结构化调用、第二次一个；断言六条消息和预期结构化对象 | 验证 ToolStrategy 的图循环反馈路径 |
| [test_multiple_structured_outputs_error_without_retry](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/test_response_format.py) | handle_errors=False；断言 MultipleStructuredOutputsError | 只覆盖多结构化调用的异常分支 |
| [TestResponseFormatAsProviderStrategy.test_validation_error_with_invalid_response](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/test_response_format.py) | 无效原生响应触发 StructuredOutputValidationError | 不证明全部 provider 使用同一传输协议 |
| [test_structured_output_retry_first_attempt_invalid](https://github.com/langchain-ai/langchain/blob/76c32db9b38dfc287c958dc2a914d4834f022c1c/libs/langchain_v1/tests/unit_tests/agents/middleware/implementations/test_structured_output_retry.py) | 测试自定义包装器、handle_errors=False；前两次无效，第三次成功，断言模型 index == 3 | StructuredOutputRetryMiddleware 定义在测试文件内，不是内置导出能力 |

原始 JSON Schema 字典在 `_parse_with_schema` 中直接返回数据，不执行与 Pydantic 类型相同的本地字段校验。该结论来自解析函数的显式分支，不能用天气对象的成功测试泛化为“所有 Schema 都严格校验”。

## 四、跨系列与业务案例的边界

本系列解释 LangChain 如何组装模型、工具与中间件；[LangGraph 系列](../langgraph/index.md) 另以 1.2.10 分析调度和持久化源码。这里锁定的 1.2.4 依赖不能用相邻系列的文件行号直接替代，需要验证具体部署时应回到其实际安装版本。

订单退货场景、c_order 等调用 ID，以及调用次数推演均为教学假设。它们帮助解释数据流，不构成可运行应用、真实交易记录或集成测试。生产中的权限、政策适用性、提交去重和结果核验仍属于业务实现。

本次只做文档静态核验与源码对照，未运行框架测试、Agent 工作流、模型调用或站点构建。阅读入口见[系列导读](index.md)。
