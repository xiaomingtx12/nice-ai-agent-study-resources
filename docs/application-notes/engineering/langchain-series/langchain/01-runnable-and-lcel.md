---
sidebar_position: 3
sidebar_label: 01 Runnable 抽象与 LCEL
description: Runnable 是 LangChain Agent 的统一执行底座——模型、工具、State 更新都走 invoke/batch/stream/transform 协议。本文追踪这套协议及 LCEL 组合语法，并标注每个抽象在 Agent 里的实际位置和误用陷阱。
---

# LangChain 源码 01：Runnable 抽象与 LCEL 表达式

## 源码定位

> **阅读基线**：`langchain-core` 的 `runnables` 模块，源码位于 `libs/core/langchain_core/runnables/`。
>
> **本篇范围**：聚焦 Runnable 基类的统一执行协议（`invoke`/`batch`/`stream`/`transform`）和 LCEL 管道语法（`|`、`RunnableSequence`、`RunnableParallel`、`RunnableBranch`）。`libs/langchain_v1/langchain/` 下的 `create_agent()`、Middleware 和 LangGraph 图装配不在本文分析范围内；它们只在结尾用于说明 LCEL 与 Agent Runtime 的边界。
>
> **核心包与路径**：
>
> 1. `langchain_core.runnables.base`：`libs/core/langchain_core/runnables/base.py`
>    - **主线文件**：`Runnable` 基类定义统一执行协议；`__or__()` 实现管道语法；`coerce_to_runnable()` 作为构造期适配器。
>    - `Runnable`：抽象方法 `invoke()` 是唯一必须实现的同步入口；`ainvoke()`、`batch()`、`stream()`、`transform()` 提供默认降级实现。
>    - `__or__()` + `coerce_to_runnable()`：把函数、字典、Runnable 统一适配后组成 `RunnableSequence`。
>    - `RunnableSequence`：保存 `first`/`middle`/`last`，按顺序传递数据流。
>    - `RunnableParallel`：固定 key 的并行扇出，输出为字典。
>    - `RunnableLambda`：把 Python callable 接入 Runnable 体系。
> 2. `langchain_core.runnables.passthrough`：`libs/core/langchain_core/runnables/passthrough.py`
>    - `RunnablePassthrough`：身份传递，输入即输出。
>    - `RunnableAssign.assign()`：保留原字典并合并新字段。
> 3. `langchain_core.runnables.branch`：`libs/core/langchain_core/runnables/branch.py`
>    - `RunnableBranch`：按注册顺序执行条件，取首个真值分支。
> 4. `langchain_core.runnables.config`：`libs/core/langchain_core/runnables/config.py`
>    - `RunnableConfig`：定义运行配置类型（`tags`/`metadata`/`callbacks`/`recursion_limit` 等）。
>    - `ensure_config()`、`patch_config()`：配置补齐与子运行派生。

下面的代码块保留真实源码的函数边界和关键调用；为了突出实现机制，省略了类型重载、异常收尾和无关字段。源码里的英文文档字符串会翻译成中文，新增的行内注释用于标出数据流和配置传播位置。

本文先建立 Runnable 抽象和 LCEL 组合语法。具体的模型、消息和工具如何实现这套协议，见 [02：聊天模型、消息与工具](./02-core-abstractions.md)。

阅读这篇文章时，可以把每个 LCEL 表达式拆成两个阶段：

1. **构造阶段**：`|`、字典、函数和条件被转换成 `RunnableSequence`、`RunnableParallel`、`RunnableLambda` 等对象。
2. **运行阶段**：调用组合对象的 `invoke()`、`batch()` 或 `stream()`，输入才会沿着已经构造好的拓扑流动。

很多"为什么函数没有立即执行""为什么流式输出被卡住"的问题，分别发生在构造期适配和运行期调度，不能混在一起理解。

## 先给结论：Runnable 是 Agent 的执行底座

`create_agent()` 的内部没有重新发明一套调用协议。Agent 里的每一个动作——模型推理、工具执行、状态更新、中间件拦截——背后都是 Runnable 的 `invoke()`/`stream()`/`transform()` 和 `RunnableConfig` 传播。

LCEL（`|` 管道语法）是 Runnable 的组合糖，适合**拓扑在构造时确定**的固定流程：

```text
输入 → Prompt → 模型 → Parser → 结果
```

一旦模型需要决定"下一步调用哪个工具、是否继续循环"，拓扑就不再固定，应进入 [03：`create_agent()` 装配主线](./03-create-agent-assembly.md)。

但理解 Agent 之前，必须先理解它脚下的协议。本文按"对 Agent 的实际价值"组织各节：**Runnable 协议层（必读）→ 表达式适配（Agent 无处不在）→ Sequence（链的基础）→ Parallel/Branch（Agent 里尽量别用）→ Passthrough/assign（State 更新原型）→ Lambda（Agent 自定义逻辑的坑）**。

## 一、`Runnable` 基类：Agent 的统一执行协议

Agent 的模型推理是 `ChatModel.invoke(messages, config)`，工具执行是 `BaseTool.invoke(tool_call, config)`，中间件包装也是 Runnable 进、Runnable 出。它们共享同一套调用面，源头就是 `Runnable` 基类。

### 1. `invoke()` 是唯一必须实现的同步入口

`Runnable` 通过抽象方法 `invoke()` 要求每个子类回答一个核心问题：一个输入如何变成一个输出。

```python
@abstractmethod
def invoke(
    self,
    input: Input,
    config: RunnableConfig | None = None,
    **kwargs: Any,
) -> Output:
    # 每个 Runnable 都必须明确：一个输入如何变成一个输出。
    """把单个输入转换成输出。"""
```

`Runnable` 不要求所有组件都继承某种业务基类，但要求它们暴露同一个调用形状。Prompt、Chat Model、Tool、Parser 和 Retriever 才能因此被放进同一条 LCEL 链。

### 2. 异步和批处理默认是降级实现

`ainvoke()` 和 `batch()` 在基类中提供了降级实现：没有原生异步的组件自动走线程池，没有批量能力的组件自动走多次 `invoke()`。

```python
async def ainvoke(
    self,
    input: Input,
    config: RunnableConfig | None = None,
    **kwargs: Any,
) -> Output:
    # 没有原生异步实现时，把同步 invoke 放进执行器。
    return await run_in_executor(config, self.invoke, input, config, **kwargs)

def batch(
    self,
    inputs: list[Input],
    config: RunnableConfig | list[RunnableConfig] | None = None,
    *,
    return_exceptions: bool = False,
    **kwargs: Any | None,
) -> list[Output]:
    if not inputs:
        return []

    configs = get_config_list(config, len(inputs))

    def invoke(input_: Input, config: RunnableConfig) -> Output | Exception:
        # 默认 batch 仍然是多次 invoke；具体 Runnable 可以覆盖为真正的批量请求。
        if return_exceptions:
            try:
                return self.invoke(input_, config, **kwargs)
            except Exception as e:
                return e
        return self.invoke(input_, config, **kwargs)

    with get_executor_for_config(configs[0]) as executor:
        return cast("list[Output]", list(executor.map(invoke, inputs, configs)))
```

所以，调用 `batch()` 只能说明组件支持批量调用面，不能直接推出 provider 收到了一次批量 API 请求。

### 3. `transform()` 决定输入流能否被增量处理

`transform()` 是流式链的核心：它接收上游的 chunk 迭代器，返回输出迭代器。基类的默认实现是先把所有 chunk 合并成一个完整输入，再调用 `stream()`。

```python
def transform(
    self,
    input: Iterator[Input],
    config: RunnableConfig | None = None,
    **kwargs: Any | None,
) -> Iterator[Output]:
    # 基类先把上游 chunk 合并成一个完整输入。
    final: Input
    got_first_val = False
    for ichunk in input:
        if not got_first_val:
            final = ichunk
            got_first_val = True
        else:
            try:
                final = final + ichunk  # type: ignore[operator]
            except TypeError:
                # 不可合并时只保留最后一个 chunk。
                final = ichunk

    if got_first_val:
        # 缓冲完成后才调用普通 stream。
        yield from self.stream(final, config, **kwargs)
```

这就是流式链的核心约束：组合器可以传递 chunk，但具体节点如果没有覆盖 `transform()`，就会成为阻塞点。`RunnableGenerator` 适合增量处理，`RunnableLambda` 默认先收完输入。

### 4. `RunnableConfig` 沿组合树向下传播

`RunnableConfig` 是一个 `TypedDict`，定义了当前运行和所有子运行共享的字段——tags、metadata、callbacks、递归上限、并发上限、可配置参数等。

```python
class RunnableConfig(TypedDict, total=False):
    # 这些字段会影响当前运行和子运行。
    tags: list[str]
    metadata: dict[str, Any]
    callbacks: Callbacks
    run_name: str
    max_concurrency: int
    recursion_limit: int
    configurable: dict[str, Any]
```

两个关键工具函数负责这条传播链路：

- `ensure_config()`：补齐默认 tags、metadata、callbacks 和递归上限，确保空白 config 也能正常工作。
- `patch_config()`：组合节点用它创建子运行配置——可以替换局部回调、调整并发参数、累加递归层级。

```python
def ensure_config(config: RunnableConfig | None = None) -> RunnableConfig:
    # 补齐默认 tags、metadata、callbacks 和递归上限。
    ...

def patch_config(
    config: RunnableConfig | None,
    *,
    callbacks: BaseCallbackManager | None = None,
    recursion_limit: int | None = None,
    max_concurrency: int | None = None,
    **kwargs: Any,
) -> RunnableConfig:
    # 组合节点创建子运行时，用 patch_config 替换局部回调或并发参数。
    ...
```

Sequence、Parallel 和 Branch 都会用 `patch_config()` 创建子运行配置。因此，LCEL 的配置传播不是全局变量，而是沿组合对象的调用树逐层派生。

## 二、表达式构造入口：`|`、`__or__()` 与适配

### 1. `|` 最终得到什么

下面这段业务代码：

```python
chain = prompt | model | parser
```

在构造阶段相当于：

```text
prompt.__or__(model)
  → RunnableSequence(prompt, model)

RunnableSequence(prompt, model).__or__(parser)
  → RunnableSequence(prompt, model, parser)
```

业务代码里通常看不到 `RunnableSequence`，但它就是 `|` 背后的实际对象。真正执行仍然要等到 `chain.invoke(...)`、`chain.batch(...)` 或 `chain.stream(...)`；这些调用方法的协议语义见 01。

### 2. `__or__()` 先适配右侧对象，再构造 Sequence

`Runnable.__or__()` 是 LCEL 管道表达式的实际入口。不论右侧是 Runnable、函数还是字典，它都不会立即执行，而是先交给 `coerce_to_runnable()`，再构造 `RunnableSequence`。

```python
def __or__(
    self,
    other: Runnable[Output, Other]
    | Callable[[Iterator[Output]], Iterator[Other]]
    | Callable[[AsyncIterator[Output]], AsyncIterator[Other]]
    | Callable[[Output], Other]
    | Mapping[str, Runnable[Output, Any] | Callable[[Output], Any] | Any],
) -> RunnableSerializable[Input, Any]:
    """Runnable "or" operator.

    Compose this `Runnable` with another object to create a
    `RunnableSequence`.
    """
    # `|` 只负责构造组合对象，此处不会执行 self 或 other。
    # 右侧对象先统一适配成 Runnable，再交给顺序组合器保存。
    return RunnableSequence(self, coerce_to_runnable(other))
```

### 3. `coerce_to_runnable()` 决定表达式节点类型

`coerce_to_runnable()` 是构造期的类型适配器，决定了 `|` 右侧对象的最终形态：

```python
def coerce_to_runnable(thing: RunnableLike[Input, Output]) -> Runnable[Input, Any]:
    # 已经是 Runnable 的对象直接复用，不再重复包装。
    if isinstance(thing, Runnable):
        return thing
    # Iterator -> Iterator 的生成器函数使用 RunnableGenerator，
    # 这样可以保留按 chunk 处理和输出的能力。
    if is_async_generator(thing) or inspect.isgeneratorfunction(thing):
        return RunnableGenerator(thing)
    # 普通 callable 只承诺"完整输入 -> 完整输出"。
    if callable(thing):
        return RunnableLambda(cast("Callable[[Input], Output]", thing))
    # 字典表达式表示固定 key 的并行分支。
    if isinstance(thing, dict):
        return RunnableParallel(thing)
    msg = (
        f"Expected a Runnable, callable or dict."
        f"Instead got an unsupported type: {type(thing)}"
    )
    raise TypeError(msg)
```

这解释了三个常见现象：

- `prompt | model` 是两个 Runnable 的顺序组合；
- `runnable | some_function` 会自动变成 `RunnableLambda`；
- `runnable | {"a": step_a, "b": step_b}` 会自动变成 `RunnableParallel`。

所以，LCEL 的 `|` 是构造期语法，不是立即调用；它把表达式编译成之后由 Runnable 调用面执行的组合对象。

## 三、`RunnableSequence`：顺序数据流

### 1. `__init__()` 构造时如何保存步骤

`RunnableSequence` 保存 `first`、`middle`、`last` 三部分。这个拆分主要是为了让泛型能够表达"第一步接收什么、最后一步返回什么"；对外通过 `steps` 属性重新还原完整顺序。

构造函数还做了两件容易被忽略的事：

- 嵌套的 `RunnableSequence` 会展开为内部步骤，避免链中再包一层链；
- 每个非 Runnable 对象都会再次经过 `coerce_to_runnable()`，所以函数和字典也能直接出现在 `|` 两侧。

```python
class RunnableSequence(RunnableSerializable[Input, Output]):
    first: Runnable[Input, Any]
    """Sequence 中的第一个 Runnable。"""

    middle: list[Runnable[Any, Any]] = Field(default_factory=list)
    """Sequence 中间的 Runnable 列表。"""

    last: Runnable[Any, Output]
    """Sequence 中的最后一个 Runnable。"""

    # 省略字段声明与类型注解，只保留构造步骤的核心实现。
    def __init__(
        self,
        *steps: RunnableLike[Any, Any],
        name: str | None = None,
        first: Runnable[Any, Any] | None = None,
        middle: list[Runnable[Any, Any]] | None = None,
        last: Runnable[Any, Any] | None = None,
    ) -> None:
        steps_flat: list[Runnable[Any, Any]] = []

        # 直接传 first/middle/last 时，先恢复成一个线性步骤列表。
        if not steps and first is not None and last is not None:
            steps_flat = [first] + (middle or []) + [last]

        for step in steps:
            # 嵌套 Sequence 在构造阶段展开。
            if isinstance(step, RunnableSequence):
                steps_flat.extend(step.steps)
            else:
                # 函数、字典等 Runnable-like 对象在这里统一适配。
                steps_flat.append(coerce_to_runnable(step))

        if len(steps_flat) < 2:
            raise ValueError("RunnableSequence must have at least 2 steps")

        # 用 first/middle/last 保存类型边界，用 steps 属性恢复完整顺序。
        super().__init__(
            first=steps_flat[0],
            middle=list(steps_flat[1:-1]),
            last=steps_flat[-1],
            name=name,
        )
```

它的输入输出形状是线性的：

```text
input
  → first
  → middle[0]
  → middle[1]
  → last
  → output
```

每一步的输出必须能被下一步接收。LCEL 不会在构造时证明业务类型完全匹配；很多链错误只有运行到对应步骤才会暴露。

### 2. `batch()` 是逐步骤传递

`Runnable` 的默认 `batch()` 是并发多次 `invoke()`；`RunnableSequence.batch()` 则按 steps 顺序调用每个组件的 `batch()`，把当前批次结果交给下一步。

```python
for stepidx, step in enumerate(self.steps):
    remaining_idxs = [
        i for i in range(len(configs)) if i not in failed_inputs_map
    ]
    inputs = step.batch(
        [
            inp
            for i, inp in zip(remaining_idxs, inputs, strict=False)
            if i not in failed_inputs_map
        ],
        [
            patch_config(
                config,
                # 每一步都是对应根运行的子运行，追踪中可以看到具体步骤。
                callbacks=rm.get_child(f"seq:step:{stepidx + 1}"),
            )
            for i, (rm, config) in enumerate(
                zip(run_managers, configs, strict=False)
            )
            if i not in failed_inputs_map
        ],
        return_exceptions=return_exceptions,
        **(kwargs if stepidx == 0 else {}),
    )
```

这里的性能机会来自组件自身的 `batch()` 实现。若模型组件支持远端批量 API，它可以在这一层合并请求；若没有覆盖，仍然会退化为线程池并发。

### 3. 流式能力由 `transform()` 决定

Sequence 的流式输出不是自动获得的。基类 `transform()` 的默认行为是先把输入缓冲起来，再调用 `astream()`；只有子类覆盖 `transform()`，才能在输入仍在产生时开始输出。

```python
def transform(
    self,
    input: Iterator[Input],
    config: RunnableConfig | None = None,
    **kwargs: Any | None,
) -> Iterator[Output]:
    """把输入流转换成输出流；默认实现会先缓冲输入，再调用 astream。"""
```

`RunnableSequence` 会沿着每个步骤调用 `transform()`。任一步骤只能在拿到完整输入后运行，后面的输出就必须等它完成。流式链中的阻塞点因此来自具体组件，而不是 `|` 本身。

## 四、`RunnableParallel`：固定扇出，Agent 里不要用

`RunnableParallel` 把一个字典表达式映射为多个 Runnable 的并行扇出，输出按 key 聚合成字典。分支数量和名称在构造期就写死了：

```text
input
  ├─→ step_a  → {"a": result_a}
  └─→ step_b  → {"b": result_b}
```

> **Agent 视角**：`RunnableParallel` 解决的是固定构造期的并发。Agent 的并行工具调用是另一回事——模型运行时输出多个 `tool_calls`，LangGraph 通过 `Send` 动态分发，工具失败可单独恢复。**不要在 Agent 里用 `RunnableParallel` 模拟并行工具调用**。

## 五、`RunnablePassthrough` 与 `assign`

`RunnablePassthrough` 的核心是身份传递——输入即输出，可附带副作用函数。`assign()` 则是它的实用扩展：保留原字典，合并新计算的字段。典型的 RAG 链形状：

```text
{"question": "..."}
  → assign(context = retriever(question))
  → {"question": "...", "context": [Document, ...]}
  → Prompt
```

`assign()` 内部是 `RunnableParallel` + `RunnableAssign` 的字典合并，必须接收 dict 输入——上游是字符串时需要先手动包装。

> **Agent 视角**：`assign()` 在固定 RAG 链中有用（检索结果补字段进 prompt 字典）。但在 Agent 里，State 更新走 LangGraph 的 reducer，不需要手写这套合并逻辑。

## 六、`RunnableLambda`：接入小段确定逻辑

`RunnableLambda` 把 Python callable（可调用对象）接入 Runnable 体系，并自动获得 tracing（追踪）、异步调用和组合能力。

它适合字段提取、格式转换和简单业务规则。但不适合需要增量流式输出的逻辑，因为 `_transform()` 会先消费完整输入，再产生函数结果。

```python
class RunnableLambda(Runnable[Input, Output]):
    def _transform(
        self,
        chunks: Iterator[Input],
        run_manager: CallbackManagerForChainRun,
        config: RunnableConfig,
        **kwargs: Any,
    ) -> Iterator[Output]:
        final: Input
        got_first_val = False

        # Lambda 默认要先消费完上游输入，才能调用普通函数。
        for ichunk in chunks:
            if not got_first_val:
                final = ichunk
                got_first_val = True
            else:
                try:
                    # 可相加的 chunk 会先合并，例如字符串或消息块。
                    final = final + ichunk  # type: ignore[operator]
                except TypeError:
                    # 不可相加时只保留最后一个 chunk。
                    final = ichunk

        if inspect.isgeneratorfunction(self.func):
            output: Output | None = None
            for chunk in call_func_with_variable_args(
                self.func, final, config, run_manager, **kwargs
            ):
                # 生成器函数可以逐个产出结果，但它仍然要等输入收完后才开始。
                yield chunk
                if output is None:
                    output = chunk
                else:
                    try:
                        output = output + chunk
                    except TypeError:
                        output = chunk
        else:
            output = call_func_with_variable_args(
                self.func, final, config, run_manager, **kwargs
            )

        # 如果函数返回 Runnable，继续执行这个 Runnable，并递减递归上限。
        if isinstance(output, Runnable):
            recursion_limit = config["recursion_limit"]
            if recursion_limit <= 0:
                raise RecursionError("Recursion limit reached")
            yield from output.stream(
                final,
                patch_config(
                    config,
                    callbacks=run_manager.get_child(),
                    recursion_limit=recursion_limit - 1,
                ),
            )
        elif not inspect.isgeneratorfunction(self.func):
            yield cast("Output", output)

    @override
    def transform(
        self,
        input: Iterator[Input],
        config: RunnableConfig | None = None,
        **kwargs: Any | None,
    ) -> Iterator[Output]:
        # 这里虽然接入了流式协议，但 _transform 仍会先收完输入。
        yield from self._transform_stream_with_config(
            input,
            self._transform,
            ensure_config(config),
            **kwargs,
        )
```

这里要区分"有 `transform()`"和"能增量流式"：

- `RunnableLambda` 有 `transform()`，所以可以接入 Sequence 的流式协议；
- 它内部的 `_transform()` 会先收集输入，不能像 `RunnableGenerator` 一样边读边产出；
- 把它放在模型前面，可能延迟整个链的首个输出。

如果函数返回另一个 Runnable，执行器还会继续调用这个 Runnable，并受 `recursion_limit`（递归上限）约束。这使 Lambda 可以做动态适配，但也更不适合隐藏复杂状态机。

> **Agent 视角——两大陷阱**：
>
> 1. **流式阻塞**：Agent 用户期望 `stream()` 从第一个 token 就开始返回。如果你在 `create_agent()` 的 `middleware` 或工具函数里用 `RunnableLambda` 做预处理，Lambda 会先收完所有输入才开始产出——整个 Agent 的流式首个输出会被推迟。需要增量处理时应写成 `Iterator[Input] → Iterator[Output]` 的生成器，让 `coerce_to_runnable()` 选择 `RunnableGenerator`。
> 2. **Lambda 返回 Runnable 突破递归上限**：如果 Lambda 内部返回另一个 Runnable（比如在中间件里动态构造子链），每次嵌套消耗一次 `recursion_limit`。Agent 默认递归上限 25，多轮工具调用 + 嵌套 Lambda 很容易触发 `RecursionError`。排查方法：在 `config` 里设置 `recursion_limit=50` 或更高，看问题是否消失；确认后再检查是否真的需要 Lambda 嵌套。

如果需要真正的增量处理，应把函数写成 `Iterator[Input] -> Iterator[Output]`，让 `coerce_to_runnable()` 选择 `RunnableGenerator`。

## 七、`RunnableBranch`：静态路由，Agent 里不适用

`RunnableBranch` 按注册顺序执行条件，取首个真值分支——条件在构造期已经写死，与 Agent 中由模型输出决定的动态路由不兼容。如果在 Agent 图节点内需要静态分支，直接用 `if/else` 即可，不必引入 `RunnableBranch`。

## 八、Runnable 在 Agent 中的实际位置

Runnable 协议不是 Agent 的"前置知识"——它就是 Agent 运行时的每个动作：

| Agent 里的动作 | 背后的 Runnable | 说明 |
| --- | --- | --- |
| 模型推理 | `BaseChatModel.invoke(messages, config)` | ChatModel 继承 Runnable，每次推理走 Runnable 调用面 |
| 工具执行 | `BaseTool.invoke(tool_call, config)` | Tool 继承 RunnableSerializable，工具调用和结果包装都在这层 |
| 状态更新（如 `messages` reducer） | LangGraph State 的 reducer 函数 | reducer 本身不是 Runnable，但它在 Runnable 图节点内执行 |
| Middleware 拦截 | `wrap_model_call` / `wrap_tool_call` 接收 Runnable 并返回 Runnable | 中间件的输入输出都是 Runnable 协议 |
| 图节点内的自定义逻辑 | `RunnableCallable`（LangGraph 提供） | 你写的普通函数被包装成类 Runnable 对象放进图节点 |
| `RunnableConfig` 传播 | `patch_config()` 沿图节点派生 | tags、callbacks、recursion_limit 从 Agent 入口一路传到工具内部 |

关键结论：**Agent 没有绕过 Runnable，它只是在 Runnable 协议之上加了图调度和状态管理**。读 `create_agent()` 源码之前，知道 `invoke()` 接收什么、`config` 怎么传播、`stream()` 和 `transform()` 的区别，这些概念在读图装配时全部复现。

适合继续用 LCEL 固定链的场景：

- Agent 中一个固定步骤：比如检索 `retriever | format_docs | prompt`，这段链路拓扑确定，用 LCEL 比手写节点更简洁。
- 工具内部：一个工具的实现可能是 `api_call | json_parse | map_to_result`，这也是一段固定管道。

必须交给 Agent Runtime 的场景：

- 模型决定是否调用工具、调用哪个工具——这是 `create_agent()` 的条件边在管，不是在 LCEL 里能写的。
- 需要检查点、分叉恢复、动态 fan-out——超出线性组合层，进入 LangGraph。

## 九、工程判断（Agent 视角）

### 必须理解（写 Agent 绕不开）

- `invoke()`/`stream()`/`transform()` 协议——Agent 的模型、工具、中间件全走这套调用面。
- `RunnableConfig` 沿 `patch_config()` 传播——排查 Agent 中 callback 丢失或 recursion_limit 报错时，跟踪的是这条链路。
- `coerce_to_runnable()` 的适配规则——你在 `create_agent()` 里传的函数、字典、Runnable，框架内部都经过它统一。

### 只在特定场景用

- `RunnableSequence`：Agent 内一段固定步骤（如检索→格式化→prompt）用 `|` 串起来比手写节点清晰。
- `RunnablePassthrough.assign()`：RAG 链中保留原字典并补字段，但别在 Agent State 更新里手写这套逻辑——LangGraph 的 reducer 已经做了。
- `RunnableLambda`：工具或中间件里的小段格式转换可以用，但注意流式阻塞和递归上限两个坑。

### 不要用在 Agent 里

- `RunnableParallel` 不能替代 Agent 的并行工具调用。Agent 用 LangGraph `Send` 做动态分发。
- `RunnableBranch` 不能替代 Agent 的动态路由。Agent 的条件边由模型输出决定。
- 不要用一串 `RunnableLambda` 嵌套来模拟 Agent 循环——路由、重试、中断全藏进普通函数，失去可观察的运行时边界。

## 十、读完后应该能判断什么

- Agent 里的模型推理、工具执行、中间件拦截背后都是 Runnable 协议——不是在 LCEL 链里手写这些，而是知道 Agent 的每个动作走的是同一个调用面。
- `RunnableConfig` 沿 `patch_config()` 传播：排查 Agent 中 callback 丢失、trace 不完整、recursion_limit 报错时，跟踪这条链路。
- `RunnableLambda` 的两个 Agent 陷阱：流式首个 token 延迟（先缓冲输入再执行函数）、递归上限（Lambda 返回 Runnable 时消耗 recursion_limit）。
- `RunnableParallel` 和 `RunnableBranch` 是固定构造期的静态组合——Agent 的并行工具调用和动态路由用 LangGraph 的 `Send` 和条件边，不是这两个类。
- Agent 内一段固定步骤（如 RAG 的检索→格式化→ prompt）适合用 `|` 做 LCEL 链；Agent 的循环、路由和工具决策必须交给 `create_agent()`/LangGraph。

一句话概括：**Runnable 是 Agent 的统一执行协议——模型、工具、中间件全走 `invoke()`/`stream()`/`config` 这一套；LCEL 的 `|` 管线适合 Agent 内部的固定子步骤；Agent 的动态路由和并行由 LangGraph 实现，不是 `RunnableParallel` 或 `RunnableBranch`。**
