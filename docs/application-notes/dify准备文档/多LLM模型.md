# 多LLM集成模块实现详解
## 1. 模块概述
多LLM集成模块是系统的核心能力之一，实现了对多个大语言模型提供商的统一管理和调用。该模块采用插件化设计，支持快速集成新的LLM提供商，并提供统一的接口供上层应用使用。

### 1.1 核心特性
1. **多提供商支持**：支持OpenAI、Moonshot(月之暗面)、Tongyi(通义千问)、Ollama、DeepSeek等多个提供商
2. **统一接口**：所有LLM提供商通过统一的接口进行调用
3. **插件化设计**：新增提供商只需添加配置文件和实现类
4. **参数模板化**：通用参数使用模板配置，减少重复代码
5. **特性标记**：支持标记模型特性(工具调用、智能体推理、图片输入)
6. **价格管理**：内置价格信息，支持成本计算
7. **动态加载**：运行时动态加载模型类和配置
8. **降级策略**：加载失败时自动降级到默认模型

### 1.2 技术架构
```plain
┌─────────────────────────────────────────────────────────────────┐
│                    多LLM集成模块架构                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              LanguageModelService                        │  │
│  │  • get_language_models()                                │  │
│  │  • get_language_model()                                 │  │
│  │  • load_language_model()                                │  │
│  │  • load_default_language_model()                        │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           LanguageModelManager (单例)                    │  │
│  │  • get_provider()                                       │  │
│  │  • get_providers()                                      │  │
│  │  • get_model_class_by_provider_and_type()              │  │
│  └──────────────────────┬───────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                Provider (提供商)                         │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  ProviderEntity (提供商实体)                       │ │  │
│  │  │  • name, label, description                       │ │  │
│  │  │  • icon, background                               │ │  │
│  │  │  • supported_model_types                          │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  model_entity_map (模型实体映射)                   │ │  │
│  │  │  • ModelEntity: model_name, features, parameters  │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  model_class_map (模型类映射)                      │ │  │
│  │  │  • Chat, Completion                               │ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              具体提供商实现                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐              │  │
│  │  │ OpenAI   │  │ Moonshot │  │ DeepSeek │  ...         │  │
│  │  │  Chat    │  │  Chat    │  │  Chat    │              │  │
│  │  └──────────┘  └──────────┘  └──────────┘              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                         │                                       │
│                         ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              LangChain基础类                              │  │
│  │  • ChatOpenAI, MoonshotChat, ChatTongyi, ...            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 2. 核心数据模型
### 2.1 模型实体(ModelEntity)
```python
class ModelEntity(BaseModel):
    """语言模型实体，记录模型的相关信息"""
    model_name: str = Field(default="", alias="model")  # 模型名字
    label: str = ""                                      # 模型标签
    model_type: ModelType = ModelType.CHAT               # 模型类型
    features: list[ModelFeature] = Field(...)            # 模型特征
    context_window: int = 0                              # 上下文窗口长度
    max_output_tokens: int = 0                           # 最大输出长度
    attributes: dict[str, Any] = Field(...)              # 模型固定属性
    parameters: list[ModelParameter] = Field(...)        # 模型参数规则
    metadata: dict[str, Any] = Field(...)                # 模型元数据(价格等)
```

**模型类型枚举**：

```python
class ModelType(str, Enum):
    CHAT = "chat"              # 聊天模型
    COMPLETION = "completion"  # 文本生成模型
```

**模型特性枚举**：

```python
class ModelFeature(str, Enum):
    TOOL_CALL = "tool_call"          # 支持工具调用
    AGENT_THOUGHT = "agent_thought"  # 支持智能体推理
    IMAGE_INPUT = "image_input"      # 支持图片输入(多模态)
```

### 2.2 模型参数(ModelParameter)
```python
class ModelParameter(BaseModel):
    """模型参数实体信息"""
    name: str = ""                                       # 参数名字
    label: str = ""                                      # 参数标签
    type: ModelParameterType = ModelParameterType.STRING # 参数类型
    help: str = ""                                       # 帮助信息
    required: bool = False                               # 是否必填
    default: Optional[Any] = None                        # 默认值
    min: Optional[float] = None                          # 最小值
    max: Optional[float] = None                          # 最大值
    precision: int = 2                                   # 小数位数
    options: list[ModelParameterOption] = Field(...)     # 可选参数
```

**参数类型枚举**：

```python
class ModelParameterType(str, Enum):
    FLOAT = "float"
    INT = "int"
    STRING = "string"
    BOOLEAN = "boolean"
```

### 2.3 提供商实体(ProviderEntity)
```python
class ProviderEntity(BaseModel):
    """模型提供商实体信息"""
    name: str = ""                                       # 提供商名字
    label: str = ""                                      # 提供商标签
    description: str = ""                                # 提供商描述
    icon: str = ""                                       # 提供商图标
    background: str = ""                                 # 图标背景色
    supported_model_types: list[ModelType] = Field(...)  # 支持的模型类型
```

### 2.4 基础语言模型(BaseLanguageModel)
```python
class BaseLanguageModel(LCBaseLanguageModel, ABC):
    """基础语言模型，继承LangChain的BaseLanguageModel"""
    features: list[ModelFeature] = Field(...)  # 模型特性
    metadata: dict[str, Any] = Field(...)      # 模型元数据
    
    def get_pricing(self) -> tuple[float, float, float]:
        """获取LLM价格信息，返回(输入价格, 输出价格, 单位)"""
        input_price = self.metadata.get("pricing", {}).get("input", 0.0)
        output_price = self.metadata.get("pricing", {}).get("output", 0.0)
        unit = self.metadata.get("pricing", {}).get("unit", 0.0)
        return input_price, output_price, unit
    
    def convert_to_human_message(self, query: str, image_urls: list[str] = None) -> HumanMessage:
        """将query+image_url转换成HumanMessage"""
        # 如果没有图片或不支持图片输入，返回普通消息
        if not image_urls or ModelFeature.IMAGE_INPUT not in self.features:
            return HumanMessage(content=query)
        
        # 支持多模态，按OpenAI格式转换
        return HumanMessage(content=[
            {"type": "text", "text": query},
            *[{"type": "image_url", "image_url": {"url": url}} 
              for url in image_urls],
        ])
```

## 3. 语言模型管理器
### 3.1 LanguageModelManager实现
```python
@inject
@singleton
class LanguageModelManager(BaseModel):
    """语言模型管理器(单例模式)"""
    provider_map: dict[str, Provider] = Field(default_factory=dict)
    
    @root_validator(pre=False)
    def validate_language_model_manager(cls, values: dict[str, Any]):
        """初始化时加载所有提供商配置"""
        # 1.获取providers目录路径
        current_path = os.path.abspath(__file__)
        providers_path = os.path.join(os.path.dirname(current_path), "providers")
        providers_yaml_path = os.path.join(providers_path, "providers.yaml")
        
        # 2.读取providers.yaml配置
        with open(providers_yaml_path, encoding="utf-8") as f:
            providers_yaml_data = yaml.safe_load(f)
        
        # 3.循环创建Provider实例
        values["provider_map"] = {}
        for index, provider_yaml_data in enumerate(providers_yaml_data):
            provider_entity = ProviderEntity(**provider_yaml_data)
            values["provider_map"][provider_entity.name] = Provider(
                name=provider_entity.name,
                position=index + 1,
                provider_entity=provider_entity,
            )
        
        return values
    
    def get_provider(self, provider_name: str) -> Optional[Provider]:
        """根据提供商名字获取提供商"""
        provider = self.provider_map.get(provider_name, None)
        if provider is None:
            raise NotFoundException("该模型服务提供商不存在")
        return provider
    
    def get_providers(self) -> list[Provider]:
        """获取所有提供商列表"""
        return list(self.provider_map.values())
```

### 3.2 Provider实现
```python
class Provider(BaseModel):
    """大语言模型服务提供商"""
    name: str                                                    # 提供商名字
    position: int                                                # 位置(排序)
    provider_entity: ProviderEntity                              # 提供商实体
    model_entity_map: dict[str, ModelEntity] = Field(...)        # 模型实体映射
    model_class_map: dict[str, Type[BaseLanguageModel]] = Field(...)  # 模型类映射
    
    @root_validator(pre=False)
    def validate_provider(cls, provider: dict[str, Any]):
        """初始化时加载该提供商的所有模型"""
        provider_entity: ProviderEntity = provider["provider_entity"]
        
        # 1.动态导入模型类
        for model_type in provider_entity.supported_model_types:
            # 将类型首字母大写作为类名(chat -> Chat)
            symbol_name = model_type[0].upper() + model_type[1:]
            provider["model_class_map"][model_type] = dynamic_import(
                f"internal.core.language_model.providers.{provider_entity.name}.{model_type}",
                symbol_name
            )
        
        # 2.获取提供商目录路径
        current_path = os.path.abspath(__file__)
        entities_path = os.path.dirname(current_path)
        provider_path = os.path.join(
            os.path.dirname(entities_path), 
            "providers", 
            provider_entity.name
        )
        
        # 3.读取positions.yaml获取模型列表
        positions_yaml_path = os.path.join(provider_path, "positions.yaml")
        with open(positions_yaml_path, encoding="utf-8") as f:
            positions_yaml_data = yaml.safe_load(f) or []
        
        # 4.循环加载每个模型的配置
        for model_name in positions_yaml_data:
            model_yaml_path = os.path.join(provider_path, f"{model_name}.yaml")
            with open(model_yaml_path, encoding="utf-8") as f:
                model_yaml_data = yaml.safe_load(f)
            
            # 5.处理参数模板
            yaml_parameters = model_yaml_data.get("parameters")
            parameters = []
            for parameter in yaml_parameters:
                use_template = parameter.get("use_template")
                if use_template:
                    # 使用模板补全参数
                    default_parameter = DEFAULT_MODEL_PARAMETER_TEMPLATE.get(use_template)
                    del parameter["use_template"]
                    parameters.append({**default_parameter, **parameter})
                else:
                    parameters.append(parameter)
            
            # 6.创建ModelEntity
            model_yaml_data["parameters"] = parameters
            provider["model_entity_map"][model_name] = ModelEntity(**model_yaml_data)
        
        return provider
    
    def get_model_class(self, model_type: ModelType) -> Type[BaseLanguageModel]:
        """根据模型类型获取模型类"""
        model_class = self.model_class_map.get(model_type, None)
        if model_class is None:
            raise NotFoundException("该模型类不存在")
        return model_class
    
    def get_model_entity(self, model_name: str) -> ModelEntity:
        """根据模型名字获取模型实体"""
        model_entity = self.model_entity_map.get(model_name, None)
        if model_entity is None:
            raise NotFoundException("该模型实体不存在")
        return model_entity
    
    def get_model_entities(self) -> list[ModelEntity]:
        """获取所有模型实体列表"""
        return list(self.model_entity_map.values())
```

## 4. 配置文件结构
### 4.1 providers.yaml
定义所有支持的提供商：

```yaml
- name: openai
  label: OpenAI
  description: OpenAI提供的模型，例如GPT-4o-mini和GPT-4o。
  icon: icon.svg
  background: "#E5E7EB"
  supported_model_types:
    - chat
    - completion

- name: moonshot
  label: 月之暗面
  description: Moonshot提供的模型，例如moonshot-v1-8k、moonshot-v1-32k和moonshot-v1-128k。
  icon: icon.png
  background: "#FFFFFF"
  supported_model_types:
    - chat

- name: deepseek
  label: 深度求索
  description: 幻方量化提供的LLM大语言模型，涵盖deepseek-chat和deepseek-reasoner等。
  icon: icon.svg
  background: "#FFFFF"
  supported_model_types:
    - chat
```

### 4.2 positions.yaml
定义提供商下的模型列表及顺序：

```yaml
# openai/positions.yaml
- gpt-4o-mini
- gpt-4o

# moonshot/positions.yaml
- moonshot-v1-8k
- moonshot-v1-32k
- moonshot-v1-128k
```

### 4.3 模型配置文件
每个模型一个YAML文件，定义模型的详细信息：

```yaml
# openai/gpt-4o-mini.yaml
model: gpt-4o-mini
label: gpt-4o-mini
model_type: chat
features:
  - tool_call
  - agent_thought
  - image_input
context_window: 128000
max_output_tokens: 16384
attributes:
  model: gpt-4o-mini
parameters:
  - name: temperature
    use_template: temperature
  - name: top_p
    use_template: top_p
  - name: presence_penalty
    use_template: presence_penalty
  - name: frequency_penalty
    use_template: frequency_penalty
  - name: max_tokens
    use_template: max_tokens
    default: 4096
metadata:
  pricing:
    input: 0.0011    # 输入价格(每千tokens)
    output: 0.0044   # 输出价格(每千tokens)
    unit: 0.001      # 单位(千tokens)
    currency: RMB    # 货币单位
```

### 4.4 参数模板
通用参数使用模板配置，减少重复：

```python
DEFAULT_MODEL_PARAMETER_TEMPLATE = {
    "temperature": {
        "label": "温度",
        "type": ModelParameterType.FLOAT,
        "help": "温度控制随机性，较低的温度会导致较少的随机生成",
        "required": False,
        "default": 1,
        "min": 0,
        "max": 2,
        "precision": 2,
    },
    "top_p": {
        "label": "Top P",
        "type": ModelParameterType.FLOAT,
        "help": "通过核心采样控制多样性",
        "required": False,
        "default": 0,
        "min": 0,
        "max": 1,
        "precision": 2,
    },
    "max_tokens": {
        "label": "最大标记",
        "type": ModelParameterType.INT,
        "help": "要生成的标记的最大数量",
        "required": False,
        "default": None,
        "min": 1,
        "max": 16384,
        "precision": 0,
    },
    # ... 其他参数
}
```

## 5. 提供商实现
### 5.1 OpenAI提供商
```python
# internal/core/language_model/providers/openai/chat.py
from langchain_openai import ChatOpenAI
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(ChatOpenAI, BaseLanguageModel):
    """OpenAI聊天模型基类"""
    pass
```

**特点**：

+ 直接继承LangChain的ChatOpenAI
+ 添加BaseLanguageModel混入，增加features和metadata支持
+ 无需额外配置，使用环境变量中的API Key

### 5.2 Moonshot(月之暗面)提供商
```python
# internal/core/language_model/providers/moonshot/chat.py
from typing import Tuple
import tiktoken
from langchain_community.chat_models.moonshot import MoonshotChat
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(MoonshotChat, BaseLanguageModel):
    """月之暗面聊天模型"""
    
    def _get_encoding_model(self) -> Tuple[str, tiktoken.Encoding]:
        """重写获取编码模型，使用gpt-3.5-turbo词表"""
        model = "gpt-3.5-turbo"
        return model, tiktoken.encoding_for_model(model)
```

**特点**：

+ 继承LangChain的MoonshotChat
+ 重写 `_get_encoding_model` 方法，使用OpenAI的词表避免错误
+ Moonshot API兼容OpenAI格式

### 5.3 DeepSeek提供商
```python
# internal/core/language_model/providers/deepseek/chat.py
import os
from typing import Tuple
import tiktoken
from langchain_openai.chat_models.base import BaseChatOpenAI
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(BaseChatOpenAI, BaseLanguageModel):
    """深度求索大语言模型基类"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(
            *args,
            openai_api_key=os.getenv("DEEPSEEK_API_KEY"),
            openai_api_base=os.getenv("DEEPSEEK_API_BASE"),
            **kwargs
        )
    
    def _get_encoding_model(self) -> Tuple[str, tiktoken.Encoding]:
        """重写获取编码模型，使用gpt-3.5-turbo词表"""
        model = "gpt-3.5-turbo"
        return model, tiktoken.encoding_for_model(model)
```

**特点**：

+ 继承BaseChatOpenAI，兼容OpenAI接口
+ 构造函数中设置自定义API Key和Base URL
+ 使用环境变量配置认证信息

### 5.4 Tongyi(通义千问)提供商
```python
# internal/core/language_model/providers/tongyi/chat.py
from langchain_community.chat_models.tongyi import ChatTongyi
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(ChatTongyi, BaseLanguageModel):
    """通义千问聊天模型"""
    pass
```

**特点**：

+ 直接继承LangChain的ChatTongyi
+ 使用阿里云的API接口
+ 通过环境变量配置API Key

### 5.5 Ollama提供商
```python
# internal/core/language_model/providers/ollama/chat.py
from langchain_ollama import ChatOllama
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(ChatOllama, BaseLanguageModel):
    """Ollama聊天模型"""
    pass
```

**特点**：

+ 支持本地部署的开源模型
+ 无需API Key，连接本地Ollama服务
+ 适合离线环境和隐私保护场景

## 6. 语言模型服务
### 6.1 LanguageModelService实现
```python
@inject
@dataclass
class LanguageModelService(BaseService):
    """语言模型服务"""
    db: SQLAlchemy
    language_model_manager: LanguageModelManager
    
    def get_language_models(self) -> list[dict[str, Any]]:
        """获取所有模型列表信息"""
        # 1.获取所有提供商
        providers = self.language_model_manager.get_providers()
        
        # 2.构建响应列表
        language_models = []
        for provider in providers:
            provider_entity = provider.provider_entity
            model_entities = provider.get_model_entities()
            
            language_model = {
                "name": provider_entity.name,
                "position": provider.position,
                "label": provider_entity.label,
                "icon": provider_entity.icon,
                "description": provider_entity.description,
                "background": provider_entity.background,
                "support_model_types": provider_entity.supported_model_types,
                "models": convert_model_to_dict(model_entities),
            }
            language_models.append(language_model)
        
        return language_models
    
    def get_language_model(self, provider_name: str, model_name: str) -> dict:
        """获取指定模型的详细信息"""
        # 1.获取提供商
        provider = self.language_model_manager.get_provider(provider_name)
        if not provider:
            raise NotFoundException("该服务提供者不存在")
        
        # 2.获取模型实体
        model_entity = provider.get_model_entity(model_name)
        if not model_entity:
            raise NotFoundException("该模型不存在")
        
        return convert_model_to_dict(model_entity)
    
    def get_language_model_icon(self, provider_name: str) -> tuple[bytes, str]:
        """获取提供商图标"""
        # 1.获取提供商
        provider = self.language_model_manager.get_provider(provider_name)
        if not provider:
            raise NotFoundException("该服务提供者不存在")
        
        # 2.构建图标路径
        root_path = os.path.dirname(os.path.dirname(current_app.root_path))
        provider_path = os.path.join(
            root_path,
            "internal", "core", "language_model", "providers", provider_name,
        )
        icon_path = os.path.join(provider_path, "_asset", provider.provider_entity.icon)
        
        # 3.检查图标是否存在
        if not os.path.exists(icon_path):
            raise NotFoundException("该模型提供者未提供图标")
        
        # 4.读取图标数据
        mimetype, _ = mimetypes.guess_type(icon_path)
        mimetype = mimetype or "application/octet-stream"
        
        with open(icon_path, "rb") as f:
            byte_data = f.read()
            return byte_data, mimetype
    
    def load_language_model(self, model_config: dict[str, Any]) -> BaseLanguageModel:
        """根据配置加载语言模型"""
        try:
            # 1.提取配置信息
            provider_name = model_config.get("provider", "")
            model_name = model_config.get("model", "")
            parameters = model_config.get("parameters", {})
            
            # 2.获取提供商、模型实体、模型类
            provider = self.language_model_manager.get_provider(provider_name)
            model_entity = provider.get_model_entity(model_name)
            model_class = provider.get_model_class(model_entity.model_type)
            
            # 3.实例化模型
            return model_class(
                **model_entity.attributes,
                **parameters,
                features=model_entity.features,
                metadata=model_entity.metadata,
            )
        except Exception as error:
            logging.error(f"获取模型失败: {error}", exc_info=True)
            return self.load_default_language_model()
    
    def load_default_language_model(self) -> BaseLanguageModel:
        """加载默认模型(降级策略)"""
        # 使用gpt-4o-mini作为默认模型
        provider = self.language_model_manager.get_provider("openai")
        model_entity = provider.get_model_entity("gpt-4o-mini")
        model_class = provider.get_model_class(model_entity.model_type)
        
        return model_class(
            **model_entity.attributes,
            temperature=1,
            max_tokens=8192,
            features=model_entity.features,
            metadata=model_entity.metadata,
        )
```

### 6.2 模型加载流程
```plain
┌─────────────────────────────────────────────────────────────────┐
│                    模型加载流程                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 接收模型配置                                                 │
│     ├─ provider: "openai"                                      │
│     ├─ model: "gpt-4o-mini"                                    │
│     └─ parameters: {temperature: 0.7, max_tokens: 4096}        │
│                                                                 │
│  2. 获取提供商                                                   │
│     ├─ language_model_manager.get_provider("openai")           │
│     └─ 返回Provider实例                                         │
│                                                                 │
│  3. 获取模型实体                                                 │
│     ├─ provider.get_model_entity("gpt-4o-mini")                │
│     └─ 返回ModelEntity(包含features, attributes, metadata)     │
│                                                                 │
│  4. 获取模型类                                                   │
│     ├─ provider.get_model_class(ModelType.CHAT)                │
│     └─ 返回Chat类(继承ChatOpenAI和BaseLanguageModel)           │
│                                                                 │
│  5. 实例化模型                                                   │
│     ├─ 合并attributes(固定属性)                                │
│     ├─ 合并parameters(用户配置)                                │
│     ├─ 添加features(模型特性)                                  │
│     ├─ 添加metadata(价格等元数据)                              │
│     └─ 返回模型实例                                             │
│                                                                 │
│  6. 异常处理                                                     │
│     ├─ 捕获任何异常                                             │
│     ├─ 记录错误日志                                             │
│     └─ 降级到默认模型(gpt-4o-mini)                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## 7. 模型使用示例
### 7.1 在应用中使用模型
```python
# 在应用服务中加载模型
class AppService(BaseService):
    language_model_service: LanguageModelService
    
    def chat(self, req: ChatReq, account: Account):
        # 1.获取应用配置
        app_config = self.app_config_service.get_app_config(app)
        
        # 2.加载语言模型
        llm = self.language_model_service.load_language_model(
            app_config.get("model_config", {})
        )
        
        # 3.使用模型
        # 检查模型特性
        if ModelFeature.TOOL_CALL in llm.features:
            # 支持工具调用，使用FunctionCallAgent
            agent = FunctionCallAgent(llm=llm, ...)
        else:
            # 不支持工具调用，使用ReACTAgent
            agent = ReACTAgent(llm=llm, ...)
        
        # 4.转换消息(支持多模态)
        human_message = llm.convert_to_human_message(
            query=req.query.data,
            image_urls=req.image_urls.data
        )
        
        # 5.调用Agent
        result = agent.invoke({"messages": [human_message]})
        
        # 6.计算成本
        input_price, output_price, unit = llm.get_pricing()
        total_cost = (input_tokens * input_price + output_tokens * output_price) * unit
```

### 7.2 模型配置示例
```python
# 应用的模型配置
model_config = {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "parameters": {
        "temperature": 0.7,
        "top_p": 0.9,
        "max_tokens": 4096,
        "presence_penalty": 0.0,
        "frequency_penalty": 0.0,
    }
}

# 加载模型
llm = language_model_service.load_language_model(model_config)

# 使用模型
response = llm.invoke("你好，请介绍一下你自己")
```

### 7.3 多模态输入示例
```python
# 支持图片输入的模型
llm = language_model_service.load_language_model({
    "provider": "openai",
    "model": "gpt-4o",  # 支持image_input特性
    "parameters": {"temperature": 0.7}
})

# 转换为多模态消息
message = llm.convert_to_human_message(
    query="这张图片里有什么？",
    image_urls=["https://example.com/image.jpg"]
)

# 调用模型
response = llm.invoke([message])
```

## 8. 新增提供商指南
### 8.1 添加新提供商的步骤
**1. 在providers.yaml中添加配置**：

```yaml
- name: new_provider
  label: 新提供商
  description: 新提供商的描述信息
  icon: icon.svg
  background: "#FFFFFF"
  supported_model_types:
    - chat
```

**2. 创建提供商目录结构**：

```plain
internal/core/language_model/providers/new_provider/
├── _asset/
│   └── icon.svg
├── __init__.py
├── chat.py
├── positions.yaml
├── model-1.yaml
└── model-2.yaml
```

**3. 实现模型类(chat.py)**：

```python
from langchain_xxx import ChatXXX  # 使用LangChain的实现
from internal.core.language_model.entities.model_entity import BaseLanguageModel

class Chat(ChatXXX, BaseLanguageModel):
    """新提供商聊天模型"""
    
    def __init__(self, *args, **kwargs):
        # 如果需要自定义初始化
        super().__init__(
            *args,
            api_key=os.getenv("NEW_PROVIDER_API_KEY"),
            base_url=os.getenv("NEW_PROVIDER_BASE_URL"),
            **kwargs
        )
    
    def _get_encoding_model(self):
        # 如果需要自定义词表
        model = "gpt-3.5-turbo"
        return model, tiktoken.encoding_for_model(model)
```

**4. 创建positions.yaml**：

```yaml
- model-1
- model-2
```

**5. 创建模型配置文件(model-1.yaml)**：

```yaml
model: model-1
label: Model 1
model_type: chat
features:
  - tool_call
  - agent_thought
context_window: 8192
max_output_tokens: 4096
attributes:
  model: model-1
parameters:
  - name: temperature
    use_template: temperature
  - name: max_tokens
    use_template: max_tokens
    default: 2048
metadata:
  pricing:
    input: 0.001
    output: 0.002
    unit: 0.001
    currency: RMB
```

**6. 添加图标文件**：

+ 将图标文件放在 `_asset/` 目录下
+ 支持SVG、PNG等格式

### 8.2 注意事项
1. **继承关系**：
    - 必须继承LangChain的对应模型类
    - 必须混入BaseLanguageModel
2. **词表处理**：
    - 如果提供商没有自己的词表，使用OpenAI的词表
    - 重写 `_get_encoding_model` 方法
3. **API认证**：
    - 使用环境变量配置API Key
    - 在构造函数中设置认证信息
4. **参数模板**：
    - 优先使用 `use_template` 引用通用参数
    - 可以覆盖模板的默认值
5. **特性标记**：
    - 准确标记模型支持的特性
    - 影响Agent类型选择和功能可用性

## 9. API接口文档
### 9.1 获取所有模型列表
**接口地址**：`GET /api/llmops/language-models`

**请求头**：

```plain
Authorization: Bearer {access_token}
```

**响应示例**：

```json
{
  "code": 0,
  "data": [
    {
      "name": "openai",
      "position": 1,
      "label": "OpenAI",
      "icon": "icon.svg",
      "description": "OpenAI提供的模型",
      "background": "#E5E7EB",
      "support_model_types": ["chat", "completion"],
      "models": [
        {
          "model_name": "gpt-4o-mini",
          "label": "gpt-4o-mini",
          "model_type": "chat",
          "features": ["tool_call", "agent_thought", "image_input"],
          "context_window": 128000,
          "max_output_tokens": 16384,
          "parameters": [
            {
              "name": "temperature",
              "label": "温度",
              "type": "float",
              "help": "温度控制随机性",
              "required": false,
              "default": 1,
              "min": 0,
              "max": 2,
              "precision": 2
            }
          ],
          "metadata": {
            "pricing": {
              "input": 0.0011,
              "output": 0.0044,
              "unit": 0.001,
              "currency": "RMB"
            }
          }
        }
      ]
    }
  ]
}
```

### 9.2 获取指定模型详情
**接口地址**：`GET /api/llmops/language-models/{provider_name}/{model_name}`

**请求头**：

```plain
Authorization: Bearer {access_token}
```

**响应示例**：

```json
{
  "code": 0,
  "data": {
    "model_name": "gpt-4o-mini",
    "label": "gpt-4o-mini",
    "model_type": "chat",
    "features": ["tool_call", "agent_thought", "image_input"],
    "context_window": 128000,
    "max_output_tokens": 16384,
    "attributes": {
      "model": "gpt-4o-mini"
    },
    "parameters": [...],
    "metadata": {
      "pricing": {
        "input": 0.0011,
        "output": 0.0044,
        "unit": 0.001,
        "currency": "RMB"
      }
    }
  }
}
```

### 9.3 获取提供商图标
**接口地址**：`GET /api/llmops/language-models/{provider_name}/icon`

**响应**：

+ Content-Type: image/svg+xml 或 image/png
+ 返回图标的二进制数据

## 10. 性能优化
### 10.1 单例模式
```python
@inject
@singleton
class LanguageModelManager(BaseModel):
    """使用单例模式，整个应用生命周期只创建一次"""
    pass
```

**优势**：

+ 避免重复加载配置文件
+ 减少内存占用
+ 提高初始化速度

### 10.2 延迟加载
```python
# 模型类在首次使用时才动态导入
model_class = dynamic_import(
    f"internal.core.language_model.providers.{provider_name}.{model_type}",
    symbol_name
)
```

**优势**：

+ 减少启动时间
+ 只加载需要的提供商
+ 降低内存占用

### 10.3 配置缓存
```python
# Provider在初始化时加载所有模型配置
@root_validator(pre=False)
def validate_provider(cls, provider: dict):
    # 一次性加载所有模型配置
    for model_name in positions_yaml_data:
        model_entity = ModelEntity(**model_yaml_data)
        provider["model_entity_map"][model_name] = model_entity
    return provider
```

**优势**：

+ 避免重复读取YAML文件
+ 提高模型查询速度
+ 减少IO操作

## 11. 监控与日志
### 11.1 关键指标
1. **模型使用统计**
    - 各提供商调用次数
    - 各模型调用次数
    - 调用成功率
    - 平均响应时间
2. **成本统计**
    - 总Token消耗
    - 输入/输出Token分布
    - 总成本
    - 各模型成本占比
3. **错误监控**
    - 模型加载失败次数
    - 降级到默认模型次数
    - API调用失败次数
    - 超时次数

### 11.2 日志记录
```python
import logging

logger = logging.getLogger(__name__)

# 模型加载日志
logger.info(f"Loading language model: provider={provider_name}, model={model_name}")
logger.info(f"Model loaded successfully: features={features}, context_window={context_window}")

# 模型调用日志
logger.info(f"Model invocation: model={model_name}, input_tokens={input_tokens}, output_tokens={output_tokens}")
logger.info(f"Model cost: input_cost={input_cost}, output_cost={output_cost}, total_cost={total_cost}")

# 错误日志
logger.error(f"Failed to load model: provider={provider_name}, model={model_name}, error={error}", exc_info=True)
logger.warning(f"Falling back to default model: gpt-4o-mini")
```

## 12. 异常处理
### 12.1 常见错误场景
**1. 提供商不存在**

```json
{
  "code": 404,
  "message": "该模型服务提供商不存在，请核实后重试"
}
```

**2. 模型不存在**

```json
{
  "code": 404,
  "message": "该模型实体不存在，请核实后重试"
}
```

**3. 模型类不存在**

```json
{
  "code": 404,
  "message": "该模型类不存在，请核实后重试"
}
```

**4. 图标文件不存在**

```json
{
  "code": 404,
  "message": "该模型提供者未提供图标"
}
```

**5. 模型加载失败**

+ 自动降级到默认模型(gpt-4o-mini)
+ 记录错误日志
+ 不影响业务流程

### 12.2 降级策略
```python
def load_language_model(self, model_config: dict) -> BaseLanguageModel:
    """加载模型，失败时自动降级"""
    try:
        # 尝试加载指定模型
        return self._load_model(model_config)
    except Exception as error:
        # 记录错误
        logging.error(f"模型加载失败: {error}", exc_info=True)
        
        # 降级到默认模型
        return self.load_default_language_model()
```

**降级原因**：

+ 提供商配置错误
+ 模型配置错误
+ API Key无效
+ 网络连接失败
+ 模型不可用

## 13. 最佳实践
### 13.1 模型选择
1. **根据任务选择模型**
    - 简单对话：使用小模型(gpt-4o-mini)
    - 复杂推理：使用大模型(gpt-4o)
    - 工具调用：选择支持tool_call的模型
    - 多模态：选择支持image_input的模型
2. **成本优化**
    - 优先使用性价比高的模型
    - 根据context_window选择合适的模型
    - 控制max_tokens减少成本
    - 监控Token消耗
3. **性能优化**
    - 使用流式输出提升用户体验
    - 合理设置temperature控制随机性
    - 避免过长的上下文

### 13.2 参数配置
1. **Temperature(温度)**
    - 0.0-0.3：确定性任务(翻译、摘要)
    - 0.4-0.7：平衡任务(对话、问答)
    - 0.8-1.0：创造性任务(写作、头脑风暴)
2. **Max Tokens(最大标记)**
    - 根据任务需求设置
    - 避免设置过大浪费成本
    - 考虑context_window限制
3. **Top P(核采样)**
    - 通常设置为0.9-1.0
    - 与temperature配合使用
    - 控制输出多样性

### 13.3 错误处理
1. **优雅降级**
    - 模型加载失败时使用默认模型
    - 记录错误但不中断服务
    - 通知管理员处理
2. **重试机制**

```python
from tenacity import retry, stop_after_attempt, wait_exponential

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=10)
)
def call_llm_with_retry(llm, messages):
    return llm.invoke(messages)
```

3. **超时控制**

```python
from langchain_core.runnables import RunnableConfig

config = RunnableConfig(timeout=30)  # 30秒超时
response = llm.invoke(messages, config=config)
```

### 13.4 安全性
1. **API Key管理**
    - 使用环境变量存储
    - 不要硬编码在代码中
    - 定期轮换API Key
    - 使用密钥管理服务
2. **输入验证**
    - 验证用户输入长度
    - 过滤敏感信息
    - 防止注入攻击
3. **输出审核**
    - 使用审核配置过滤敏感词
    - 记录异常输出
    - 实施内容安全策略

## 14. 故障排查
### 14.1 模型加载失败
**问题现象**：

+ 应用启动时报错
+ 模型调用时返回默认模型
+ 日志显示模型加载失败

**排查步骤**：

1. 检查providers.yaml配置是否正确
2. 检查模型配置文件是否存在
3. 检查positions.yaml中的模型名称
4. 检查模型类是否正确实现
5. 查看错误日志获取详细信息

**解决方案**：

+ 修正配置文件
+ 补充缺失的文件
+ 修复模型类实现
+ 检查依赖包是否安装

### 14.2 API调用失败
**问题现象**：

+ 模型调用超时
+ 返回401/403错误
+ 返回429限流错误

**排查步骤**：

1. 检查API Key是否有效
2. 检查网络连接
3. 检查API配额
4. 查看提供商状态页面
5. 检查请求参数是否正确

**解决方案**：

+ 更新API Key
+ 检查网络配置
+ 升级API套餐
+ 实施限流和重试策略
+ 修正请求参数

### 14.3 Token计算错误
**问题现象**：

+ Token数量与预期不符
+ 成本计算错误
+ 超出context_window限制

**排查步骤**：

1. 检查词表配置是否正确
2. 检查是否重写了 `_get_encoding_model`
3. 验证Token计算逻辑
4. 检查消息格式是否正确

**解决方案**：

+ 使用正确的词表
+ 实现词表兼容方法
+ 优化消息长度
+ 使用更大context_window的模型

### 14.4 特性不支持
**问题现象**：

+ 工具调用失败
+ 图片输入无效
+ Agent推理异常

**排查步骤**：

1. 检查模型配置中的features字段
2. 验证模型是否真正支持该特性
3. 检查Agent类型选择逻辑
4. 查看模型文档确认支持情况

**解决方案**：

+ 更新features配置
+ 选择支持该特性的模型
+ 使用正确的Agent类型
+ 降级到不依赖该特性的实现

## 15. 扩展功能
### 15.1 自定义Token计算
```python
class CustomChat(ChatOpenAI, BaseLanguageModel):
    """自定义Token计算的模型"""
    
    def get_num_tokens(self, text: str) -> int:
        """自定义Token计算逻辑"""
        # 实现自定义计算
        return len(text) // 4  # 简化示例
    
    def get_num_tokens_from_messages(self, messages: list) -> int:
        """计算消息列表的Token数"""
        total = 0
        for message in messages:
            total += self.get_num_tokens(message.content)
        return total
```

### 15.2 自定义价格策略
```python
class CustomPricingModel(BaseLanguageModel):
    """自定义价格策略的模型"""
    
    def get_pricing(self) -> tuple[float, float, float]:
        """动态价格计算"""
        # 根据时间、用量等因素动态调整价格
        base_input_price = self.metadata.get("pricing", {}).get("input", 0.0)
        base_output_price = self.metadata.get("pricing", {}).get("output", 0.0)
        
        # 应用折扣
        discount = self._get_discount()
        input_price = base_input_price * discount
        output_price = base_output_price * discount
        
        return input_price, output_price, 0.001
```

### 15.3 模型池管理
```python
class ModelPool:
    """模型池，支持负载均衡和故障转移"""
    
    def __init__(self, models: list[BaseLanguageModel]):
        self.models = models
        self.current_index = 0
    
    def get_model(self) -> BaseLanguageModel:
        """轮询获取模型"""
        model = self.models[self.current_index]
        self.current_index = (self.current_index + 1) % len(self.models)
        return model
    
    def invoke_with_fallback(self, messages: list):
        """带故障转移的调用"""
        for model in self.models:
            try:
                return model.invoke(messages)
            except Exception as e:
                logging.warning(f"Model {model} failed: {e}")
                continue
        raise Exception("All models failed")
```

## 16. 总结
多LLM集成模块通过以下设计实现了灵活、可扩展的多模型支持：

### 16.1 核心优势
1. **插件化架构**：新增提供商只需添加配置和实现类
2. **统一接口**：所有模型通过统一接口调用，上层无感知
3. **特性标记**：清晰标记模型能力，支持智能选择
4. **参数模板**：减少配置重复，提高维护效率
5. **降级策略**：自动降级保证服务可用性
6. **成本管理**：内置价格信息，支持成本计算

### 16.2 技术亮点
1. **单例模式**：LanguageModelManager使用单例，提高性能
2. **动态加载**：运行时动态导入模型类，减少启动时间
3. **配置驱动**：通过YAML配置管理模型，无需修改代码
4. **多继承**：模型类同时继承LangChain类和BaseLanguageModel
5. **词表兼容**：统一使用OpenAI词表，避免计算错误

### 16.3 使用建议
1. 根据任务特点选择合适的模型和提供商
2. 合理配置参数平衡效果和成本
3. 监控模型使用情况和成本
4. 实施降级和重试策略保证可用性
5. 定期更新模型配置和价格信息
6. 做好API Key管理和安全防护

通过本文档，开发者可以全面了解多LLM集成模块的设计思想和实现细节，快速集成新的LLM提供商，并在应用中灵活使用多种大语言模型。

