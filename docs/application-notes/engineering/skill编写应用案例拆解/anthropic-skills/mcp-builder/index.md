---
sidebar_position: 2
title: "mcp-builder：从连接对象到评测答案"
description: 从 Anthropic mcp-builder 源码拆解 MCP transport、工具发现、tool loop、评测报告和 Research/Implementation/Test 流程之间的关系。
---

# mcp-builder：从连接对象到评测答案

## 先看真正执行的链

`mcp-builder/SKILL.md:14-193` 给模型的工作顺序是 Research and Planning → Implementation → Review and Test → Evaluation。真正把 MCP 服务接到 Claude 评测代理的，是 `scripts/connections.py` 和 `scripts/evaluation.py`：

```text
transport
  → MCPConnection.__aenter__
  → ClientSession.initialize()
  → list_tools()
  → Claude tools
  → tool_use
  → call_tool()
  → tool_result
  → <response>
  → exact string score
```

下面先沿这条调用链读代码，再回到 `SKILL.md` 解释四阶段文档怎样指导实现。

## 一、connections.py：transport 被收进连接对象

### 初始化不是简单打开 URL

`scripts/connections.py:12-51` 的 `MCPConnection.__aenter__()` 统一处理连接生命周期：建立 `AsyncExitStack`，创建 transport context，拆出 read/write 流，创建 `ClientSession`，最后调用 `initialize()`。

```python
session_ctx = ClientSession(read, write)
self.session = await self._stack.enter_async_context(session_ctx)
await self.session.initialize()
return self
```

输入是具体连接类提供的 context，输出是已经完成 MCP 初始化的连接对象。`__aexit__()` 关闭 stack 并清空 session。下游评测不需要知道 stdio、SSE 和 HTTP 的资源清理细节。

### 工具表面只转换三类字段

`connections.py:54-69` 的 `list_tools()` 将 MCP response 转成评测代理的工具字典：

```python
return [
    {
        "name": tool.name,
        "description": tool.description,
        "input_schema": tool.inputSchema,
    }
    for tool in response.tools
]
```

这里能被源码直接证明的字段只有 `name`、`description`、`input_schema`。`outputSchema`、`structuredContent` 和 read-only/destructive 等 annotations 出现在 `mcp-builder/SKILL.md:97-123` 的设计建议中，并没有被这个适配函数传给 Claude。

### transport 工厂保留兼容分支

`:72-150` 定义 `MCPConnectionStdio`、`MCPConnectionSSE`、`MCPConnectionHTTP`；`create_connection()` 接受 `stdio`、`sse`、`http`、`streamable_http` 和 `streamable-http`。

参考资料推荐远程使用 Streamable HTTP，但脚本仍保留 SSE。文章应把“推荐方向”和“当前代码支持的分支”分开写，不能把前者写成后者已经完成迁移。

## 二、evaluation.py：tool loop 怎样回到消息链

### 输入和输出先由 XML 约束

`parse_evaluation_file():55-75` 读取 `<qa_pair>` 下的 `<question>` 和 `<answer>`。`EVALUATION_PROMPT:20-52` 约束模型把过程放进 `<summary>`，工具意见放进 `<feedback>`，最终答案放进 `<response>`；数字、ID 和名称要求只返回精确值。

```xml
<evaluation>
  <qa_pair>
    <question>...</question>
    <answer>...</answer>
  </qa_pair>
</evaluation>
```

XML 同时是评测输入格式和模型输出的解析边界。`extract_xml_content():78-82` 返回指定标签的最后一次匹配。

### agent_loop 固定了请求参数和循环条件

`scripts/evaluation.py:85-150` 首次请求和后续请求都固定 `max_tokens=4096`，循环条件只有 `response.stop_reason == "tool_use"`：

```python
response = await asyncio.to_thread(
    client.messages.create,
    model=model,
    max_tokens=4096,
    system=EVALUATION_PROMPT,
    messages=messages,
    tools=tools,
)

while response.stop_reason == "tool_use":
    tool_use = next(block for block in response.content
                    if block.type == "tool_use")
    tool_result = await connection.call_tool(tool_name, tool_input)
    messages.append({
        "role": "user",
        "content": [{"type": "tool_result",
                      "tool_use_id": tool_use.id,
                      "content": tool_response}]
    })
    response = await ...
```

消息状态是 assistant response → tool result → assistant response。工具异常不会抛出到任务层：`:113-120` 把异常和 traceback 拼成文本，作为 `tool_result` 交回模型。这样模型可以看到工具失败，但 traceback 也会进入模型上下文，属于当前实现的可见副作用。

代码没有显式处理 `pause_turn` 或 `refusal`。因为循环只匹配 `tool_use`，其它 stop reason 会直接进入最终文本提取；当前快照中没有针对这两类状态的专门分支。

### 评分只比较 `<response>`

`evaluate_single_task():153-183` 提取 response 标签后进行精确字符串比较：

```python
"score": int(response_value == qa_pair["answer"]) if response_value else 0
```

同时保存 expected、actual、duration、tool_calls、summary 和 feedback。这套评分适合数字、ID 和稳定短文本；开放式答案中的同义表达会被判成不同结果。

## 三、Research：`SKILL.md` 怎样路由资料

`SKILL.md:20-75` 先要求研究 MCP specification，再根据实现语言读取不同 reference：

```text
mcp_best_practices.md
  通用命名、分页、错误、transport

node_mcp_server.md
  TypeScript SDK 与 Zod

python_mcp_server.md
  FastMCP 与 Pydantic

evaluation.md
  评测问题、答案验证、XML
```

这里的源码事实是“主文件提供这些读取指针”；“这些指针能减少模型搜索空间”属于设计推论，不是脚本测出的指标。文章应将两者分开。

## 四、Implementation：建议层与执行层

`SKILL.md:77-124` 建议建立 API client、错误处理、响应格式和分页，并为工具提供输入/输出 schema、描述和 annotations。TypeScript 参考使用 `McpServer.registerTool` 与 Zod，Python 参考使用 FastMCP 与 Pydantic。

这些内容描述模型应关注的工具设计约束；在本案例的评测脚本里，实际送入 Claude 的工具字段仍由 `connections.py:list_tools()` 限定为三项。不能把文档中列出的完整 MCP 能力，写成当前适配器已经实现的字段集合。

## 五、Review/Test：编译检查与 Inspector

`SKILL.md:126-146` 要求 TypeScript 运行 `npm run build`，Python 运行 `python -m py_compile`，两者再使用 MCP Inspector 检查工具。

```text
编译 / 语法检查
  → 服务能启动

MCP Inspector
  → 客户端能列出工具、读取 schema、实际调用
```

这里仍是 Skill 文档规定的流程，不是 `evaluation.py` 自动执行的完整测试套件。评测脚本只在建立连接后调用 `list_tools()`，然后运行 XML 中的问题。

## 六、Evaluation：报告是串行生成的

`run_evaluation():219-271` 先加载工具，再解析 QA pair，并按 `for` 循环逐题调用 `evaluate_single_task()`，最后汇总 accuracy、平均耗时、平均工具调用数和总工具调用数。文档要求创建十道复杂问题，但当前脚本不会并行执行所有问题。

CLI `:321-363` 支持 `stdio`、`sse`、`http`，默认模型为 `claude-3-7-sonnet-20250219`。这是当前快照中的旧默认值，文章只记录它对复现的影响，不将其写成当前推荐模型。

## 七、实现边界与代价

这条链把外部 API、transport、工具 schema、Claude tool loop 和答案验证连接起来，能观察一个工具表面是否真的支持多步任务。代价是：

- transport 和 MCP SDK 版本进入运行前提；
- 外部数据必须足够稳定，才能使用精确答案评分；
- traceback 会回到模型上下文；
- `pause_turn`、`refusal` 没有专门分支；
- 开放式答案不适合当前的字符串比较。

`mcp-builder` 的实现价值不在“列出 MCP 最佳实践”，而在于把连接生命周期、工具发现、工具调用和答案报告放在同一个可追踪链路里。`SKILL.md` 的四阶段是工作流说明，`connections.py` 和 `evaluation.py` 才揭示了当前快照真正执行了什么。
