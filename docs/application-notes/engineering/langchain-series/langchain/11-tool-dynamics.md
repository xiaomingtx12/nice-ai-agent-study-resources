---
sidebar_position: 13
sidebar_label: 11 工具动态化：选择、模拟与 provider 搜索
description: 从工具声明与执行入口出发，拆解工具预选、模拟执行和供应商延迟加载，说明运行时校验、额外调用和组合边界。
---

# LangChain 源码解析 11：工具动态化——选择、模拟与 provider 搜索

## 一、源码定位

> **阅读基线**：`langchain` 1.3.7、`langchain-core` 1.4.6（仓库快照 `langchain-core==1.4.6-2-g76c32db9b3`）。
> 源码路径相对 LangChain 仓库根目录；版本与阅读路线见 [系列导读](index.md)。
>
> **核心路径**：
>
> - 动态工具校验：`libs/langchain_v1/langchain/agents/factory.py` → _get_bound_model()。
>
> - **选择器实现**：`libs/langchain_v1/langchain/agents/middleware/tool_selection.py`——`LLMToolSelectorMiddleware` 在 `wrap_model_call` 里用小模型预选工具，正文一节展开。
> - **模拟器实现**：`libs/langchain_v1/langchain/agents/middleware/tool_emulator.py`——`LLMToolEmulator` 用 `wrap_tool_call` 拦截并模拟工具输出，正文二节展开。
> - **provider 搜索实现**：`libs/langchain_v1/langchain/agents/middleware/provider_tool_search.py`——`ProviderToolSearchMiddleware` 注入 provider 端搜索工具并延迟加载工具 Schema，正文三节展开。

三种中间件改动的是不同环节：选择器决定主模型这次看到哪些工具，模拟器决定调用结果从哪里来，供应商搜索决定工具定义何时进入模型上下文。它们都使用请求包装接口，但不能混称为“减少工具数量”。

## 二、工具声明与工具执行是两个入口

默认情况下，工厂要求模型请求里的客户端工具已登记在 ToolNode。当前版本还提供动态执行入口，`libs/langchain_v1/langchain/agents/factory.py` 的 _get_bound_model 有如下真实分支，省略错误文本构造：

```python
has_wrap_tool_call = wrap_tool_call_wrapper or awrap_tool_call_wrapper

available_tools_by_name = {}
if tool_node:
    available_tools_by_name = tool_node.tools_by_name.copy()

# 存在工具包装器时，由包装器承接动态工具；否则校验登记名称。
if not has_wrap_tool_call:
    unknown_tool_names = []
    for t in request.tools:
        if isinstance(t, dict):
            continue
        if isinstance(t, BaseTool) and t.name not in available_tools_by_name:
            unknown_tool_names.append(t.name)
```

因此 wrap_model_call 可以向请求加入动态工具声明，配合 wrap_tool_call 解析并执行。校验被跳过只表示工厂允许这条扩展路径；一个只会重试的包装器不会自动知道如何执行新工具。动态处理方要准备实际 BaseTool 或短路返回合法结果，并负责权限与参数校验。

下面的选择器与搜索中间件主要处理已有工具，模拟器则短路执行。它们是三种具体实现，不是动态工具能力的全部限制。

## 三、选择器：用一次辅助调用筛选客户端工具

LLMToolSelectorMiddleware 的 _prepare_selection_request 先排除供应商字典工具，将 always_include 与可选工具分开，再取最后一条 HumanMessage。选择模型接收工具名称和描述形成的系统提示，以及这条用户消息；不会自动看到此前所有工具结果。

未指定选择模型时使用 request.model，并不保证是更小、更便宜的模型。always_include 也不是构造期校验，而是在每次准备当前请求时核对；如果前一层已移除该工具，会在这里报错。

wrap_model_call 通过动态 JSON Schema 约束候选名称，然后由 _process_selection_response 再做确定性检查。下面是选名的实际分支：

```python
selected_tool_names: list[str] = []
invalid_tool_selections = []

for tool_name in response["tools"]:
    if tool_name not in valid_tool_names:
        invalid_tool_selections.append(tool_name)
        continue
    # 去重，并在可选工具范围内应用 max_tools。
    if tool_name not in selected_tool_names and (
        self.max_tools is None or len(selected_tool_names) < self.max_tools
    ):
        selected_tool_names.append(tool_name)

if invalid_tool_selections:
    msg = f"Model selected invalid tools: {invalid_tool_selections}"
    raise ValueError(msg)
```

非法工具名触发 ValueError；非字典响应在包装器中触发 AssertionError，缺字段等形状错误还有对应的普通 Python 异常。不能只凭 schema 里存在枚举就省略运行时校验。

最终工具列表保留选中的 BaseTool，再附加 always_include 和原请求中的供应商字典工具。max_tools 只限制可选部分，因此最终总数可以更大。入选名额按模型返回顺序决定，但选中工具对象按原 available_tools 的顺序重建，不保证最终声明顺序与模型排名一致。

例如主任务是“查订单后发送通知”，最近用户消息没有列出中间查询结果；后续轮次仍按这条用户消息预选，可能漏掉下一步需要的工具。关键收尾工具可设 always_include，或让自定义选择器读取可信任务状态。是否值得预选，应比较额外一次模型调用与减少 schema 后的整体成本和完成率。

## 四、模拟器：保留协议配对，替换结果来源

LLMToolEmulator 根据 emulate_all 或名称集合决定是否模拟。未命中的调用交给 handler；命中后构造包含工具名、描述和参数的提示词，调用模拟模型。下面保留返回分支，省略前面的提示词构造：

```python
response = self.model.invoke([HumanMessage(prompt)])

# 返回配对结果，不进入真实工具 handler。
return ToolMessage(
    content=response.content,
    tool_call_id=request.tool_call["id"],
    name=tool_name,
)
```

原 tool_call_id 保持不变，父 Agent 因而可以沿标准工具协议继续运行。默认 ToolMessage 状态为 success，但这里只证明模拟调用生成了结果，不能证明数据库写入、文件生成或邮件发送发生。

模拟器适合测试编排面对不同工具结果时怎样选择下一步。它本身仍会调用模型，输出也可能波动；需要稳定回归时可使用固定结果。被模拟工具参数还会发送给模拟模型，避免真实工具副作用不等于没有外部数据传输。

## 五、供应商搜索：保留工具对象，设置延迟加载标记

ProviderToolSearchMiddleware 在请求准备阶段验证 searchable_tools 是否存在。工具名称在集合中，或原 extras 已设置 defer_loading=True，都会进入延迟加载路径；未选中任何延迟工具时直接透传。

真正设置标记的是 _defer_tool_if_needed，以下为主体：

```python
if not _is_deferred_tool(tool, tool_names):
    return tool
if not isinstance(tool, BaseTool):
    return tool
extras = {**(tool.extras or {}), "defer_loading": True}
return tool.model_copy(update={"extras": extras})
```

它复制工具并合并 extras，不删除原参数 schema，也不在应用侧建立一个检索索引。_prepare_request 确认供应商受支持后，追加服务端搜索声明：

```python
bound_tools = [_defer_tool_if_needed(tool, self.searchable_tool_names) for tool in tools]
return request.override(tools=[*bound_tools, dict(_SERVER_TOOL_SEARCH_TOOLS[provider])])
```

本快照的映射包含 Anthropic 和 OpenAI；有延迟工具但供应商无法识别或不在映射中时抛 ValueError。适配器如何把 extras 转为请求、供应商怎样向模型提供搜索结果，属于下一层实现。仅从中间件不能推断完整 schema 一定未通过网络发送，也不能据此量化请求字节或 token 节省。

延迟加载后的业务工具仍需要执行端：搜索帮助模型发现工具，不会替应用完成 lookup_order 或 send_email。服务端搜索工具字典与客户端业务工具的生命周期不同。

## 六、组合时核对候选、执行与数据出口

| 机制 | 主要输入 | 主要输出 | 额外行为 |
| --- | --- | --- | --- |
| 选择器 | 当前工具集合、最近用户消息 | 精简的 request.tools | 一次辅助模型调用 |
| 模拟器 | 已提出的工具名与参数 | 人工合成的 ToolMessage | 一次模拟模型调用，跳过真实工具 |
| 供应商搜索 | 工具对象与供应商信息 | 带延迟标记的工具及搜索声明 | 依赖供应商搜索协议 |

选择器若放在搜索中间件外层，可能先移除 searchable_tools 中登记的工具，导致内层的存在性检查失败；反过来放置时，仍需确保搜索声明与剩余工具定义一致。不能只看各自单独运行成功，就认为任意组合顺序都有效。

动态工具的执行权限应在实际执行入口核验。缩小模型可见列表能减少误选，但不是权限系统；模拟成功也不应进入真实业务完成率。装配与动态工具校验见 [03](03-create-agent-assembly.md)，包装器顺序见 [04](04-middleware-control-plane.md)。
