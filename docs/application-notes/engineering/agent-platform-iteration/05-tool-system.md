---
sidebar_position: 5
sidebar_label: 05：工具体系
description: 工具体系模块纵线：原型里的内置工具目录与 API 工具配置转 StructuredTool，重建后的四源统一接入（内置、API、MCP、工作流）与 Skill 授权目录，以及只读工具自动重试的边界。
---
# 工具体系：四源接入与统一 BaseTool

工具体系对应总览「共同的功能模块」矩阵里的工具一行。这条线的行业背景是总览对比里点过的：MCP 正在成为各家平台的收敛点——Dify、Octop connectors、Yuxi、openagent 都接了。本平台的迭代方向是把来源各异的工具收敛成一个统一抽象：无论内置工具、自定义 API、MCP 服务还是发布后的工作流，装配到 Agent 手里的都是同一类可调用对象；来源的差异止步于适配层，授权与校验统一下沉到平台。

> **本篇弧线**
>
> - **初识**：内置工具目录与 API 工具配置转 `StructuredTool` 两类工具源
> - **重建**：两源扩到四源（加 MCP 与工作流工具化），抽象不变
> - **现状**：统一接入表、授权三层次、MCP 桥接与只读重试边界

## 一、核心工程问题：多源工具怎么统一，授权放哪里

工具体系这条线要回答的工程问题：来源各异的工具——内置、自定义 API、MCP、发布后的工作流——怎么收敛成一个统一抽象，让 Agent 侧无感知；以及授权放在哪一层，才不会跟着工具来源散掉。三个子问题贯穿全文：

- **抽象扛得住扩源**。四源工具都收敛为 BaseTool，原型「配置转 StructuredTool」定下的接口约定扛住了两次工具源扩容（第四节）。
- **授权三层次**。工具描述决定模型选不选、args schema 决定输入怎么验、平台授权决定能不能执行——提示词里的「禁止访问」替代不了权限检查（第四节）。
- **副作用的边界**。自动重试只覆盖四个无副作用的只读工具；写入类工具一次异常确认不了上一次是否已经生效（第四节）。

暗线是授权的迁移：原型时代「配置里有哪些工具」就等于「Agent 能用什么」，现状把配置绑定与当次授权分开——工具来源越多，授权越要离开工具本身，落到平台层。

## 二、初识：两类工具源

### 1、内置工具目录

原型的内置工具按「供应商目录 + 清单管理器」组织（`api/internal/core/tools/builtin_tools/`）：providers 目录下每家供应商一个文件夹——dalle3、duckduckgo_search、gaode_weather、google_serper、current_time、wikipedia_search，外加按类目组织的 category 管理器。每个工具就是一个 LangChain Tool，带名称、描述与参数结构，`builtin_provider_manager` 负责把它们聚合给前端选择与后端装配。

### 2、API 工具：配置转代码

自定义 API 工具不写代码，走纯配置。`ToolEntity` 描述一个 HTTP 接口——method、url、请求头，以及参数列表；每个参数标注自己落在 path、query、header、cookie 还是 request_body。`ApiProviderManager` 把这份配置翻译成可执行工具（`api/internal/core/tools/api_tools/providers/api_provider_manager.py`，节选）：

```python
def get_tool(self, tool_entity: ToolEntity) -> BaseTool:
    """根据传递的配置获取自定义API工具"""
    return StructuredTool.from_function(
        func=self._create_tool_func_from_tool_entity(tool_entity),
        name=f"{tool_entity.id}_{tool_entity.name}",
        description=tool_entity.description,
        args_schema=self._create_model_from_parameters(tool_entity.parameters),
    )
```

参数列表用 `create_model` 动态生成 pydantic schema——工具的参数校验结构就是接口配置的直接映射；`tool_func` 在运行时把模型给的参数按标注放回各自的请求位置，发起 HTTP 请求并返回响应文本。工具名带 ID 前缀避免同名冲突，这个细节后来保留在整套工具体系里。

Agent 侧的绑定很直接：`agent_config.tools` 收集所有工具实例，LLM 节点检测到模型支持 `tool_call` 特性后 `bind_tools`（见第二篇运行时）。

## 三、重建：从两源到四源

重建第一批落地的就是自定义 API 工具——工具是平台最早补齐的能力面，因为 Agent 的可用性直接由工具决定。之后工具源两次扩容：MCP Server 工具（依赖 `langchain-mcp-adapters==0.3.2`、`mcp==1.26.0`）与发布后的工作流工具化（第三篇），外加 DeepAgents 带来的 Skills。扩容没有改抽象——四个来源仍然收敛到 BaseTool，这也是原型 `StructuredTool.from_function` 那一步定下的接口约定在起作用。

## 四、现状：统一接入与授权分层

### 1、四源一张表

现状的工具接入面（`internal/service/app/app_config_service.py` 做配置校验与转换，`internal/service/agent/agent_factory.py` 装配）：

| 能力     | 输入来源                       | 执行形式                       |
| -------- | ------------------------------ | ------------------------------ |
| 内置工具 | 平台工具目录与参数             | LangChain Tool                 |
| API Tool | 简化 OpenAPI 描述与连接参数    | HTTP 调用包装为工具            |
| MCP Tool | Server 配置与发现的工具 Schema | MCP 客户端调用                 |
| Workflow | 已发布的节点与边               | 编译为 StateGraph 再包装为工具 |
| Skill    | 内置目录中的指令与资源文件     | 框架原生 Skills 按需读取       |

配置校验先于装配：结构合法、资源归属、可用性三项都过，Factory 才把已解析的工具交给 Core；Core 接收的是可调用对象，不再按浏览器传来的资源 ID 现场查权限。三个层次各司其职：

- **工具描述**：决定模型是否选择工具；
- **args schema**：决定输入怎么验证；
- **平台授权**：决定调用者能否执行。

> 提示词里写「禁止访问」不能替代权限检查。

### 2、MCP 的桥接与缓存

`MCPService` 管理 Server 配置与发现的工具记录；`MCPRuntimeManager`（`internal/core/mcp/runtime/mcp_runtime_manager.py`）把数据库配置转成运行时配置——解密敏感 Header 与环境变量、构造客户端与工具。

运行时工具缓存是进程内的，键为「Server ID 加更新时间」：配置更新后键变化，自然取到新目录；它不是 Redis 共享缓存，也不代表远端永远可用，远端工具实际变了而本地未刷新时需要重新发现。

同步业务边界调用异步 MCP 客户端时有一个容易被忽视的细节：管理器检测当前线程是否已有事件循环，已有循环时在另一线程运行协程并等待结果，避免在 Flask 的同步上下文里直接 `asyncio.run` 炸掉已有循环——桥接仍然会等待，并没有把同步调用变成后台任务。

### 3、重试的边界与 Skill 的授权

自动重试只适合可确认无副作用的读取。主 Agent 的默认重试范围是 ls、read_file、glob、grep 四个文件读取工具，不能推广到付款、发布这类写工具——一次网络抖动重试两次就是三倍扣款。

Skill 走的是目录与授权：`SkillService` 从内置技能仓库读目录、规范化应用绑定，运行时投影只提供已授权资源、按稳定顺序提供名称与路径；框架的 SkillsMiddleware 负责原生使用方式，平台的 ReloadingSkillsMiddleware 负责刷新授权资源。文件路径可见不等于可以跨账号读取，Skill 内容也不授予数据库或工具权限——授权是绑定关系，不是内容属性。

### 4、去留

工具体系的统一适配层、配置校验、授权分层全部自持；MCP 协议客户端与 Skills 加载机制借生态与框架。原型定的两个约定沿用至今：一切工具收敛为 BaseTool、工具名带来源标识防冲突。

真正新建的是授权这一层——原型时代「应用配置里有哪些工具」就等于「Agent 能用什么」，现状把配置绑定与当次授权分开，资源发布后可能被禁用，历史绑定不能代替运行时检查。

模块纵线的上一篇是[知识库与文件处理](./04-knowledge-and-files.md)，下一篇见[模型接入](./06-model-access.md)，目录与状态见[专栏入口](./index.md)。
