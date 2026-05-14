---
sidebar_position: 4
---

# 平台的工具调用设计

如果说 Agent 层负责决定“下一步做什么”，那工具层负责的就是“怎么把动作真的执行出去”。

但放到这个项目里看，工具层不只是几条调用链路，而是一套插件化平台：Builtin Tool、API Tool、MCP Tool 三种来源统一治理，最后都收口到同一种运行时抽象，再注入 App、Agent 和 Workflow。

## 先说最关键的判断

这个项目真正统一的，不是工具的存储形态，而是工具的运行时接口。

更准确地说，它做的是：

- 三种工具来源
- 三套不同的注册和发现方式
- 一套统一的 `BaseTool` 运行时抽象
- 一套统一的装配和注入路径

所以这套能力本质上不是“插件列表管理”，而是“配置驱动 + 统一抽象 + 运行时装配”的插件工具平台。

## 为什么这一层要单独拆

工具系统一旦做成平台能力，就不能只停留在“能调通一个外部接口”。

它至少还要同时解决：

- 工具从哪里来
- 工具参数怎么定义
- 工具怎么被前端配置
- 工具怎么被 Agent 和 Workflow 复用
- 调试路径和正式运行路径能不能保持一致
- 外部配置和敏感信息怎么治理

如果这些问题没有一起设计，工具会越接越多，但平台本身会越来越脆。

## 我会把它拆成六个部分

### 1. 三类工具不是三套孤岛，而是三种来源、一套接口

这个项目里的工具来源分成三类：

- Builtin Tool：项目内置工具，走文件化注册
- API Tool：用户导入 OpenAPI Schema 后生成的接口工具
- MCP Tool：数据库里存 Server 配置，运行时动态发现远程工具

它们的来源完全不同，但平台最后不会让上层感知这三种差异。

统一收口的目标很明确：

- Agent 只拿一组 `tools`
- Workflow 的 `ToolNode` 只拿一个 `_tool`
- App 配置层只存工具配置，不存工具实例

这也是为什么项目最核心的抽象落点是 `BaseTool`，而不是某一种具体 provider。

### 2. 三类工具的注册方式不同，但都被平台接成可配置能力

#### Builtin Tool

Builtin Tool 不是存数据库，而是走“YAML + Python”文件化注册。

它更像平台自己的内置插件目录：

- `providers.yaml` 定义 provider 元数据
- `positions.yaml` 管理工具顺序
- 单个工具的 YAML 管展示信息
- 对应 Python 模块管真实实现

这里的设计重点不是“少建一张表”，而是承认这类工具本来就是仓库内置能力，适合跟代码一起版本化。

#### API Tool

API Tool 不是运行时直接吃一份 OpenAPI 文本，而是先做一次导入和展开。

项目支持的是“面向工具生成的 OpenAPI 子集”：

- 只接特定 method 和参数结构
- 先校验 schema
- 再把 provider 元数据和单接口工具拆开保存

也就是说，平台不是在做一个完整 OpenAPI 引擎，而是在做一个受控的接口工具导入器。

#### MCP Tool

MCP Tool 更不一样。

数据库里存的不是工具实现，而是：

- Server 连接配置
- 最近一次发现出来的工具目录快照

真正的工具目录来自远程 MCP Server，要在运行时 discovery。

所以 MCP 的核心不是“多一种工具类型”，而是“把远程工具网络接进统一插件平台”。

### 3. 参数 schema 不是附属信息，而是整套平台的共同底座

这三类工具都要向平台暴露一个共同东西：参数 schema。

因为没有稳定的参数描述，前端配置、调试运行、Agent 调用和 Workflow 节点执行都会变得不可靠。

这三类工具分别通过不同方式拿到 schema：

- Builtin Tool：直接从工具自身的 `args_schema` 反射参数
- API Tool：从导入后的参数定义动态 `create_model(...)` 生成 schema
- MCP Tool：从远程工具目录里的 `input_schema` 转成 Pydantic 模型

这一步带来的平台价值很大：

- 前端可以按 schema 自动生成参数面板
- 调试接口可以复用同一套参数约束
- Agent 和 Workflow 不需要各自维护一份工具参数解释逻辑

所以 `args_schema` 在这里不是装饰字段，而是工具平台真正的调用协议。

### 4. 三类工具最终都被压成同一种运行时对象

这一步是整套设计的核心。

三类工具最后统一变成：

- Builtin Tool -> LangChain Tool / `BaseTool`
- API Tool -> `StructuredTool`
- MCP Tool -> `MCPManagedTool(BaseTool)`

也就是说，平台在运行时统一看到的不是：

- “这是 Google 搜索”
- “这是 OpenAPI 接口”
- “这是远程 MCP Server”

而是统一看到：

- 这是一个有 `name`
- 有 `description`
- 有 `args_schema`
- 能 `invoke(...)`

的标准工具对象。

这正是插件平台最值钱的地方：统一的不是业务来源，而是执行语义。

### 5. 调试和正式运行尽量走同一条实现

这篇准备稿里有一个非常重要的工程判断，值得直接沉淀下来：

调试路径不应该另写一套逻辑。

这个项目在 API Tool 和 MCP Tool 上都尽量做到了这一点：

- 调试接口先把配置还原成真正的运行时工具
- 然后直接走 `tool.invoke(parameters)` 或对应执行器
- 返回结果和错误再做统一包装

这样做的价值是：

- 调试和正式注入不会逐渐分叉
- “调试能跑、正式运行不行”的概率更低
- 平台后续排查问题时，链路更可追踪

Builtin Tool 虽然没有单独的 debug API，但它同样依赖运行时工具本身的 `args_schema` 和 `invoke` 语义。

所以这套平台不是“给每类工具各写一套调试器”，而是尽量复用同一条运行时执行路径。

### 6. App、Agent、Workflow 统一注入，才算真正的平台能力

如果工具只能在某一个聊天入口里用，它还不算平台层能力。

这个项目真正做对的一点，是把统一注入放到了公共装配层。

统一注入口的意义在于：

- App 配置里存的是工具配置 JSON，不是工具实例
- 运行前由服务层把配置装配成 `list[BaseTool]`
- Agent 拿这批工具做推理和工具循环
- Workflow 的 `ToolNode` 也最终只持有一个 `BaseTool`

于是三类工具都可以被同样地复用到：

- App / WebApp / OpenAPI
- 对话 Agent
- Workflow 节点

再进一步，工作流自己也被做成 `BaseTool`，这样平台里普通工具、检索工具和工作流工具在 Agent 看来就是平级能力。

这一步非常关键，因为它把“插件工具系统”和“工作流系统”真正接成了一个运行时生态。

## 真实代码里，插件层其实用了三种很典型的模式

如果只写“支持 Builtin / API / MCP 三类工具”，这一层还是会显得很虚。

但把真实代码拿出来看，会发现这里至少用了三种很清楚的工程组织方式：

- 文件化注册 + 工厂装配
- 运行时适配
- 公共装配器

### 1. Builtin Tool 用的是文件化注册 + 工厂装配

内置工具不是一张数据库表，而是启动时把 provider 和 tool 目录扫描成内存注册表。

```python
class BuiltinProviderManager(BaseModel):
    """服务提供商工厂类"""

    provider_map: dict[str, Provider] = Field(default_factory=dict)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._get_provider_tool_map()

    def get_tool(self, provider_name: str, tool_name: str) -> Any:
        provider = self.get_provider(provider_name)
        if provider is None:
            return None
        return provider.get_tool(tool_name)
```

```python
def _provider_init(self):
    current_path = os.path.abspath(__file__)
    entities_path = os.path.dirname(current_path)
    provider_path = os.path.join(
        os.path.dirname(entities_path), "providers", self.name
    )

    positions_yaml_path = os.path.join(provider_path, "positions.yaml")
    with open(positions_yaml_path, encoding="utf-8") as f:
        positions_yaml_data = yaml.safe_load(f)

    for tool_name in positions_yaml_data:
        tool_yaml_path = os.path.join(provider_path, f"{tool_name}.yaml")
        with open(tool_yaml_path, encoding="utf-8") as f:
            tool_yaml_data = yaml.safe_load(f)

        self.tool_entity_map[tool_name] = ToolEntity(**tool_yaml_data)
        self.tool_func_map[tool_name] = dynamic_import(
            f"internal.core.tools.builtin_tools.providers.{self.name}",
            tool_name,
        )
```

这就是很典型的工厂注册器思路：

- `BuiltinProviderManager` 负责全局 provider 注册
- `Provider` 负责单 provider 下 tool 元数据和 tool 工厂函数
- 上层只管按 `provider_name + tool_name` 拿实例，不关心磁盘目录怎么组织

### 2. API Tool 用的是动态 schema 工厂

API Tool 不是把 OpenAPI 文本一路带到运行时，而是先转成平台自己的 `ToolEntity`，再在运行时动态生产 `StructuredTool`。

```python
def get_tool(self, tool_entity: ToolEntity) -> BaseTool:
    return StructuredTool.from_function(
        func=self._create_tool_func_from_tool_entity(tool_entity),
        name=f"{tool_entity.id}_{tool_entity.name}",
        description=tool_entity.description,
        args_schema=self._create_model_from_parameters(tool_entity.parameters),
    )
```

```python
def _create_model_from_parameters(cls, parameters: list[dict]) -> Type[BaseModel]:
    fields = {}
    for parameter in parameters:
        field_name = parameter.get("name")
        field_type = ParameterTypeMap.get(parameter.get("type"), str)
        field_required = parameter.get("required", True)
        field_description = parameter.get("description", "")

        fields[field_name] = (
            field_type if field_required else Optional[field_type],
            Field(description=field_description),
        )

    return create_model("DynamicModel", **fields)
```

这说明 API Tool 的关键不是“发一个 requests 请求”，而是：

- 先把接口参数压成统一 schema
- 再把 schema 变成工具的 `args_schema`
- 最后让 Agent、Workflow、调试接口共用同一个运行时对象

### 3. MCP Tool 用的是适配器 + 代理

MCP 最不像普通插件，因为数据库里并没有工具实现，只有 server 配置和 discovery 后的目录快照。

所以项目多补了一层 MCP 运行时，把远程工具适配成 LangChain `BaseTool`：

```python
def list_langchain_tools(
    self, server: MCPServer | MCPServerConfig, force_refresh: bool = False
) -> list[BaseTool]:
    server_config = self.build_server_config(server)
    cache_key = self._cache_key(server_config)

    if cache_key in self._tool_cache:
        return self._tool_cache[cache_key]

    tool_catalogs = self.discover_tools(server_config)
    tools = [
        build_langchain_tool(self, server_config, tool_catalog)
        for tool_catalog in tool_catalogs
    ]
    self._tool_cache[cache_key] = tools
    return tools
```

```python
class MCPManagedTool(BaseTool):
    def __init__(
        self,
        *,
        runtime_manager: Any,
        server_config: MCPServerConfig,
        tool_catalog: MCPToolCatalog,
        **kwargs: Any,
    ):
        super().__init__(
            name=tool_catalog.name,
            description=tool_catalog.description,
            args_schema=_build_args_schema(tool_catalog),
            **kwargs,
        )
        self._runtime_manager = runtime_manager
        self._server_config = server_config
        self._tool_name = tool_catalog.name

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        return self._runtime_manager.execute_tool(
            server_config=self._server_config,
            tool_name=self._tool_name,
            parameters=kwargs,
        )
```

这里其实同时用了两层模式：

- `MCPRuntimeManager` 是运行时工厂，负责 discovery、缓存、实例化
- `MCPManagedTool` 是适配器/代理，把远程工具调用转成统一的 `_run(...)`

### 4. 三类工具最后还要再经过一次公共装配

真正的平台化不是“每类工具都能自己跑”，而是它们能被 App、Agent、Workflow 走同一条装配路径。

```python
def get_langchain_tools_by_tools_config(
    self, tools_config: list[dict]
) -> list[BaseTool]:
    tools = []
    for tool in tools_config:
        if tool["type"] == "builtin_tool":
            builtin_tool = self.builtin_provider_manager.get_tool(
                tool["provider"]["id"], tool["tool"]["name"]
            )
            if not builtin_tool:
                continue
            tools.append(builtin_tool(**tool["tool"]["params"]))
        elif tool["type"] == "mcp_tool":
            server = self.get(MCPServer, tool["provider"]["id"])
            if not server or not server.enabled:
                continue
            try:
                tools.append(
                    self.mcp_runtime_manager.get_langchain_tool(
                        server, tool["tool"]["name"]
                    )
                )
            except Exception:
                continue
        else:
            api_tool = self.get(ApiTool, tool["tool"]["id"])
            if not api_tool:
                continue
            tools.append(
                self.api_provider_manager.get_tool(
                    ToolEntity(
                        id=str(api_tool.id),
                        name=api_tool.name,
                        url=api_tool.url,
                        method=api_tool.method,
                        description=api_tool.description,
                        headers=api_tool.provider.headers,
                        parameters=api_tool.parameters,
                    )
                )
            )

    return tools
```

这段代码很关键，因为它说明“统一运行时”不是口号，而是已经被写成了一个公共装配器。

同样的统一思想，在工作流节点里也存在：

```python
if self.node_data.tool_type == "builtin_tool":
    builtin_provider_manager = injector.get(BuiltinProviderManager)
    _tool = builtin_provider_manager.get_tool(
        self.node_data.provider_id, self.node_data.tool_id
    )
    self._tool = _tool(**self.node_data.params)
elif self.node_data.tool_type == "api_tool":
    api_provider_manager = injector.get(ApiProviderManager)
    self._tool = api_provider_manager.get_tool(
        ToolEntity(
            id=str(api_tool.id),
            name=api_tool.name,
            url=api_tool.url,
            method=api_tool.method,
            description=api_tool.description,
            headers=api_tool.provider.headers,
            parameters=api_tool.parameters,
        )
    )
elif self.node_data.tool_type == "mcp_tool":
    mcp_runtime_manager = injector.get(MCPRuntimeManager)
    self._tool = mcp_runtime_manager.get_langchain_tool(
        mcp_server, self.node_data.tool_id
    )
```

所以真正统一的不是“数据库长得一样”，而是：

- 都能被装成 `BaseTool`
- 都能在 App 层被批量装配
- 都能在 Workflow 节点里被按同一接口执行

## 这套插件工具平台里最值得学的工程判断

### 1. 不统一存储，统一运行时

Builtin 适合文件化，API Tool 适合导入展开，MCP 适合配置持久化加运行时发现。强行统一存储模型反而会让平台变形。

### 2. OpenAPI 只做受控子集

不是所有标准都要一次吃满。先收敛到工具生成真正需要的那部分，平台会更稳。

### 3. MCP 先 discovery，再启用

先验证外部连接有效，再把配置存成启用态，这比“先存后修”更像平台能力。

### 4. 敏感配置不裸存

MCP 的 env / headers 做加密存储，说明这个项目不是只顾着接通，还考虑了配置安全。

### 5. 调试路径复用正式路径

这一点看似细，但决定了后续维护成本。

## 这一层最容易被讲浅的地方

很多人讲插件工具平台时，只会说：

- 支持 Builtin Tool
- 支持 API Tool
- 支持 MCP Tool

这只是在罗列类型。

真正更值钱的是下面这些问题有没有答清楚：

- 三类工具为什么不需要统一存储形态
- 它们最后为什么都要变成 `BaseTool`
- 参数 schema 怎么变成平台调用协议
- 调试路径为什么要复用正式运行路径
- App、Agent、Workflow 为什么能共享一套工具装配结果

这些问题答不清，通常还只是“接了几种工具”，还没有真正沉淀成平台设计。

## 我现在的判断

这个项目里的工具层，最重要的不是“接了多少插件”，而是它做出了几个对的平台选择：

1. 允许三类工具保留各自最合适的注册方式
2. 用 `args_schema` 和 `BaseTool` 统一调用协议
3. 用公共装配层把工具注入 App / Agent / Workflow
4. 用 discovery、加密、调试复用这些细节把插件系统做成可治理的运行时平台

做到这一步，工具调用才不只是一个按钮，而是这个类 Dify 平台里真正可扩展的插件能力底座。
