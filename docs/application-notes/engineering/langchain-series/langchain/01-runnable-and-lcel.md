---
sidebar_position: 3
sidebar_label: 01 Runnable 抽象与 LCEL
description: 从 LCEL 构造、顺序执行、并行分支和流式传递追踪 Runnable 的实现，区分组件调用、配置传播与 Agent 图调度。
---

# LangChain 源码解析 01：Runnable 抽象与 LCEL 表达式

## 一、源码定位

> **阅读基线**：`langchain` 1.3.7、`langchain-core` 1.4.6（仓库快照 `langchain-core==1.4.6-2-g76c32db9b3`）。
> 源码路径相对 LangChain 仓库根目录；版本与阅读路线见 [系列导读](index.md)。
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
>    - `RunnablePassthrough.assign()` / `RunnableAssign._invoke()`：构造字段映射，再保留原字典并合并新字段。
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

## 二、从一条检索链区分构造、执行与调度

Runnable 是“给一个输入，按统一接口取得输出”的执行协议。模型、工具、检索器等对象实现它，LCEL（LangChain Expression Language，链表达式语言）则用 `|` 和字典等写法组合这些对象。

以“问题 → 检索 → 格式化材料 → 模型回答”为例，构造表达式时只保存步骤，调用 invoke 时才发生检索和模型请求。若使用 stream，上游交给下游的是增量迭代器；中间步骤是否立即输出，取决于它如何处理这个迭代器。

Agent 可以在工具内部复用这样的链。模型与工具循环的节点、条件边、检查点由 LangGraph 管理；Middleware 的 hook 接收状态或请求对象，Reducer 是合并更新的函数，它们不能一概当成 Runnable。

## 三、`Runnable` 基类：Agent 的统一执行协议

聊天模型通过 `invoke(messages, config)` 返回消息，工具通过 `invoke(tool_call, config)` 执行一次调用。它们共享 Runnable 的调用面；中间件包装器则通过 request 和 handler 介入这些调用，接口在第 04 篇展开。

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
- `patch_config()`：组合节点用它派生配置，可替换回调、并发参数和递归上限；它本身不会自动增加或减少递归次数。

下面是 `patch_config()` 替换回调和递归上限的真实分支，省略其他字段处理；英文注释译为中文：

```python
config = ensure_config(config)
if callbacks is not None:
    # 替换回调时移除原运行的名称和 ID，避免子运行复用父身份。
    config["callbacks"] = callbacks
    if "run_name" in config:
        del config["run_name"]
    if "run_id" in config:
        del config["run_id"]
if recursion_limit is not None:
    config["recursion_limit"] = recursion_limit
```

Sequence、Parallel 和 Branch 都会派生子运行配置，并通过执行上下文传播配置。ensure_config 也会读取当前上下文中的配置，不能把这条传播链简化成只有显式参数传递；回调的父子关系由各组合器共同维护。

## 四、表达式构造入口：`|`、`__or__()` 与适配

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

业务代码里通常看不到 `RunnableSequence`，但它就是 `|` 背后的实际对象。真正执行仍然要等到 `chain.invoke(...)`、`chain.batch(...)` 或 `chain.stream(...)`；这些方法分别选择单输入、批量或流式执行。

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
    """将当前 Runnable 与另一对象组合为 RunnableSequence。"""
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

## 五、`RunnableSequence`：顺序数据流

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

        if len(steps_flat) < _RUNNABLE_SEQUENCE_MIN_STEPS:
            msg = (
                f"RunnableSequence must have at least {_RUNNABLE_SEQUENCE_MIN_STEPS} "
                f"steps, got {len(steps_flat)}"
            )
            raise ValueError(msg)

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

`_RUNNABLE_SEQUENCE_MIN_STEPS` 在该文件中为 2，少于两个步骤会在构造期报错。每一步的输出必须能被下一步接收；LCEL 不会在构造时证明业务类型完全匹配，很多类型或字段错误要运行到对应步骤才暴露。

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

### 3. 流式执行逐层连接迭代器

`RunnableSequence._transform()` 没有逐步调用 invoke，而是让下一个步骤接住前一步的输出流。下面保留主体，省略函数签名：

```python
steps = [self.first, *self.middle, self.last]
# 不支持增量处理的步骤，会先缓冲输入，再开始输出。
final_pipeline = cast("Iterator[Output]", inputs)
for idx, step in enumerate(steps):
    config = patch_config(
        config, callbacks=run_manager.get_child(f"seq:step:{idx + 1}")
    )
    if idx == 0:
        final_pipeline = step.transform(final_pipeline, config, **kwargs)
    else:
        final_pipeline = step.transform(final_pipeline, config)

yield from final_pipeline
```

例如模型逐段输出文本，后面接一个必须读取全文的格式转换函数，链的最终消费者就要等模型结束。模型之前的普通字段提取若只处理一份字典，不会仅因使用 RunnableLambda 就吞掉后续模型的 token 流。判断阻塞点要看它接收的是完整值还是正在生成的增量。

## 六、RunnableParallel：同一输入的命名扇出

RunnableParallel 将同一输入交给多个命名分支，最终按 key 合并结果。分支配置预先确定，但每个分支仍可包含条件选择。它适合同时取两类检索结果，或者从同一输入计算多个字段。

同步 invoke 使用执行器运行各分支；异步 ainvoke 使用异步任务收集结果。它不自动为分支建立检查点，也不会将多个外部写入变为事务。某个分支失败时，其他分支可能已经产生副作用。

Agent 的工具批次由工具调用 ID、ToolNode 和图路由管理。可以在一个工具内部使用 RunnableParallel 完成固定扇出；若希望图层单独观察、恢复或审批每项业务动作，就应将这些动作暴露为独立工具或节点。

## 七、`RunnablePassthrough` 与 `assign`

`RunnablePassthrough` 的核心是身份传递——输入即输出，可附带副作用函数。`assign()` 则是它的实用扩展：保留原字典，合并新计算的字段。典型的 RAG 链形状：

```text
{"question": "..."}
  → assign(context = retriever(question))
  → {"question": "...", "context": [Document, ...]}
  → Prompt
```

`assign()` 内部是 `RunnableParallel` + `RunnableAssign` 的字典合并，必须接收 dict 输入——上游是字符串时需要先手动包装。

> **Agent 视角**：`assign()` 在固定 RAG 链中有用（检索结果补字段进 prompt 字典）。但在 Agent 里，State 更新走 LangGraph 的 reducer，不需要手写这套合并逻辑。

## 八、`RunnableLambda`：接入小段确定逻辑

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
                msg = (
                    f"Recursion limit reached when invoking {self} with input {final}."
                )
                raise RecursionError(msg)
            for chunk in output.stream(
                final,
                patch_config(
                    config,
                    callbacks=run_manager.get_child(),
                    recursion_limit=recursion_limit - 1,
                ),
            ):
                yield chunk
        elif not inspect.isgeneratorfunction(self.func):
            yield cast("Output", output)

    @override
    def transform(
        self,
        input: Iterator[Input],
        config: RunnableConfig | None = None,
        **kwargs: Any | None,
    ) -> Iterator[Output]:
        # 同步路径需要 func；只有协程实现时不能同步消费。
        if hasattr(self, "func"):
            yield from self._transform_stream_with_config(
                input,
                self._transform,
                ensure_config(config),
                **kwargs,
            )
        else:
            msg = (
                "Cannot stream a coroutine function synchronously."
                "Use `astream` instead."
            )
            raise TypeError(msg)
```

这里要区分"有 `transform()`"和"能增量流式"：

- `RunnableLambda` 有 `transform()`，所以可以接入 Sequence 的流式协议；
- 它内部的 `_transform()` 会先收集输入，不能像 `RunnableGenerator` 一样边读边产出；
- 把它放在需要持续传递模型增量的位置，会等待上游收完；只处理模型之前的完整输入时，不会自动缓冲后面的输出。

如果函数返回另一个 Runnable，执行器还会继续调用这个 Runnable，并受 `recursion_limit`（递归上限）约束。这使 Lambda 可以做动态适配，但也更不适合隐藏复杂状态机。

Lambda 返回另一个 Runnable 时，会用原输入继续调用它，并将传入配置中的 recursion_limit 减 1。这是嵌套 Runnable 求值的保护，不是模型调用次数计数。图调度虽然也读取同名配置，其步数语义由 LangGraph 定义；遇到上限错误时，应先区分 RecursionError 与 GraphRecursionError，再检查循环来源。

## 九、RunnableBranch：运行时选择首个匹配分支

RunnableBranch 保存一组“条件 Runnable、目标 Runnable”和一个默认分支。每次 invoke 时按顺序计算条件，命中第一个真值就执行对应分支；全部不命中时执行默认分支。条件值来自当前输入，因此路由结果是运行时确定的。

例如输入带 language 字段，可以选择中文或英文检索链。条件甚至可以调用模型，但会增加时延与费用，并可能失败。它可以出现在 Agent 工具内部；区别在于 Branch 自身不提供图检查点、中断恢复或跨轮 State 合并。普通 if/else 更清楚时也无需额外包装。

## 十、Runnable 在 Agent 中的实际位置

| 对象 | 主要调用契约 | 谁负责后续流程 |
| --- | --- | --- |
| 聊天模型、工具、检索器 | Runnable 的 invoke、ainvoke 等 | 调用方或包含它们的组合对象 |
| RunnableSequence、Parallel、Branch | 组合对象仍暴露 Runnable 接口 | 自身调度已声明的步骤与分支 |
| 模型 Middleware 包装器 | ModelRequest 与 handler → ModelResponse 或 AIMessage | 工厂组合包装器并处理结果 |
| 工具 Middleware 包装器 | ToolCallRequest 与 handler → 工具消息或状态命令 | 工具节点接收结果 |
| State Reducer | 旧值与更新 → 新值 | LangGraph 在合并状态时调用 |
| 编译后的 Agent 图 | 对外暴露 invoke、stream 等接口 | LangGraph 调度节点、条件边与恢复 |

同一套应用可以同时使用 LCEL 和 Agent 图。例如主 Agent 决定调用 search 工具，search 内部用 LCEL 完成检索与格式化，工具结果再返回父图。LCEL 的局部组合能力与图的持久化边界可以并存。

继续阅读 [02：聊天模型、消息与工具](02-core-abstractions.md) 可看到这些组件具体交接什么值；[03：create_agent 装配](03-create-agent-assembly.md) 则说明工厂怎样把组件接进循环。

## 十一、工程判断（Agent 视角）

选接口时先确定需要的是一个值、一批值，还是增量流。batch 默认并发多次调用，不保证供应商批量请求；stream 暴露迭代器，也不保证每个步骤都增量处理。

排查延迟时，观察首个输入、首个输出与完整输出的时间，定位在哪个 transform 累积了输入。排查重复执行时，检查重试包在整个 Sequence 外还是单个步骤外；前面已发生的写入不会因为后一步失败而自动撤销。

需要恢复和审批的业务动作，应在图或工具边界保持可见；仅需复用调用配置、追踪和固定组合的小流程，可以留在 LCEL 中。
