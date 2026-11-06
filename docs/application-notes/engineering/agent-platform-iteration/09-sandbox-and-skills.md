---
sidebar_position: 9
sidebar_label: 09：执行环境与沙箱
description: 执行环境与 Skill 交付模块纵线：原型的进程内 exec 与源码里自带的危险警告，重建阶段的云函数隔离，现状的沙箱 Provider 矩阵、会话租约池、Skill 压缩上传与安全解包、统一虚拟路径路由。
---
# 执行环境与 Skill 交付：从进程内 exec 到租约化沙箱

执行环境在总览「共同的功能模块」矩阵里不占八行主表的一席，归在外围的文件能力里，但它同时是「接口兼容与安全」那组难题中代码执行隔离的正主。这条模块纵线的弧线比较特殊：它是唯一一个原型明确知道自己缺、还在源码注释里承认了的模块——迭代不是发现新需求，而是把原型欠的债按等级还清。第四篇讲过文件交付的版本控制，本篇讲执行环境本身：沙箱怎么选、怎么复用、Skill 怎么进去。

> **本篇弧线**
>
> - **初识**：进程内 `exec`，AST 只做结构约束，源码自带危险警告
> - **重建**：代码节点外移云函数，第一次隔离
> - **现状**：四 Provider 沙箱矩阵、会话租约池、Skill 压缩上传与安全解包、虚拟路径路由

## 一、核心工程问题：隔离与复用的平衡

执行环境这条线要回答的工程问题：Agent 的执行既要在进程外隔离（安全），又不能每次执行都新建远程沙箱（成本与延迟）——隔离与复用怎么同时成立。三个子问题贯穿全文：

- **隔离分级**。本地 Shell、操作系统级隔离、远程沙箱的安全能力各不相同，Provider 矩阵按场景选择；虚拟路径与访问策略不等于主机级进程隔离（第四节）。
- **复用不踩踏**。同会话并发占用立即失败而不是共享文件系统、空闲 TTL 与容量淘汰控制存量、generation 代际防止旧定时器误杀新租约（第四节）。
- **播种安全**。Skill 进沙箱走压缩上传省流量，解包校验挡住路径穿越、符号链接逃逸与目录伪装（第四节）。

暗线是动因：从原型一行 `exec` 到这套体系，驱动力不是安全洁癖，而是能力扩张——文件工具与 Shell 成为日常能力后，执行环境就是运行时的地基，隔离与复用的平衡是这个地基的承重结构。

## 二、初识：进程内 exec 与原型的自我警告

原型的代码节点做了 AST 校验之后，直接在平台进程里执行用户代码（`api/internal/core/workflow/nodes/code/code_node.py`，节选）：

```python
# todo:2.执行Python代码，该方法目前可以执行任意的Python代码，所以非常危险，后期需要单独将这部分功能迁移到沙箱中或者指定容器中运行和项目分离
result = self._execute_function(self.node_data.code, params=inputs_dict)
...
# 10.代码通过AST校验，执行代码
local_vars = {}
exec(code, {}, local_vars)
```

AST 校验的真实强度值得说清：它检查顶层只允许一个名为 `main`、参数必须叫 `params` 的函数定义，不允许其他语句——这是结构约束，不是安全边界。函数体内写什么它管不了，`import os` 之后的任意系统调用都能通过校验落进 `exec`。

原型作者显然清楚这一点，那条 todo 注释把风险和治理方向（迁移到沙箱或容器、与项目分离）都写明白了。工具侧同样如此：DuckDuckGo、维基百科这些内置工具就是进程内的网络请求，没有隔离层。

## 三、重建：第一次隔离

重建阶段把这条 todo 还掉：代码节点经 AST 校验后交给云函数执行，与平台服务进程隔离，平台只收回执。这次改动确立了一条原则——AST 校验负责「代码长得对不对」的结构约定，真正的隔离来自执行位置的外移，「使用 StateGraph 编排」本身推导不出任何沙箱能力（第三篇工作流也引用过这条原则）。此时的执行环境还是代码节点的附属品：只有用户显式写代码的地方才隔离。

## 四、现状：Provider 矩阵、租约池与安全解包

DeepAgents 换轨把这件事变成了地基问题：文件工具与 Shell 成为 Agent 的日常能力，任何一次执行都可能落盘、起进程——执行环境必须从「代码节点的附属」升级为「运行时的标配」。

### 1、Provider 矩阵与懒加载

装配入口是 `build_sandbox_backend`（`internal/core/agent_v2/backends/sandbox/sandbox_backend_factory.py`）：配置值先归一化（disabled/none/off/false 都视为禁用，bwrap 是 bubblewrap 的别名），再分派到四个 Provider 模块：

| Provider    | 隔离形态           |
| ----------- | ------------------ |
| bubblewrap  | 本地操作系统级隔离 |
| local_shell | 本地 Shell，无隔离 |
| daytona     | 远程沙箱，懒加载   |
| langsmith   | 远程沙箱，懒加载   |

三个设计点：

- 每个 Provider 模块只实现统一签名的 `create_backend` 契约、不向包级导出构造函数，调用方无法绕过 Provider 选择与统一清理。
- 远程 Provider 包在 `LazySandboxBackend` 里，资源延迟到首次实际需要时创建。
- Provider 模块懒 import，Daytona 缺 SDK 时报出明确的依赖提示，可选依赖不拖累其他 Provider。

远程沙箱的资源寻址靠稳定命名：沙箱名由账号、应用、会话与代理身份拼接哈希生成（脱敏且确定），复用与远程删除都按同名定位——换一次执行不换一个名字。

会话删除时另有独立的远程资源清理，与「正常运行结束时关闭 Backend」是两件事；删除失败不回滚已提交的业务删除，保留上下文供排查补偿。

把退出路径合起来看，一次沙箱资源有四种归宿：运行正常结束关闭 Backend（可复用的归还池、不可复用的直接释放）、空闲 TTL 到期被定时器回收、容量淘汰先回收最久未用的空闲资源、会话删除触发远程清理——四条路径最终都收敛到同一个 dispose 流程。

### 2、会话租约池

远程沙箱贵且慢，平台用进程内的会话池做复用（`internal/core/agent_v2/backends/sandbox/session_sandbox_pool.py`）。租约对象本身就把关键机制写在脸上：

```python
@dataclass(eq=False)
class SandboxLease:
    """一次独占租约对应的远程资源；代际标识阻止旧定时器回收新租约。"""

    key: tuple[str, str]
    dispose: Callable[[Any], None]
    sandbox: Any = None
    busy: bool = True
    invalidated: bool = False
    generation: int = 0
    timer: Any = None
    expires_at: float = 0.0
```

规则逐条对应真实的故障场景：

- 同一会话并发占用立即失败而不是共享文件系统——两个执行同时写一个沙箱会互相踩；
- 先在锁内保留会话槽位再发起网络创建，慢 Provider 不阻塞其他会话；创建期间会话被删除或进程关闭，实例返回后立即作废回收；
- 归还时标记可复用才回池，且复用前检查空闲 TTL 未过期、取消挂起的到期定时器；
- 池容量有限（空闲保留上限 3 个），容量淘汰按最近归还顺序先回收最久未用的空闲资源。

`generation` 是防误杀的关键——归还与复用都会递增代际，到期定时器带着创建时的旧代际触发，代际不匹配就放弃回收，防止旧定时器把刚被新执行复用的沙箱销毁。恢复执行时若实例失效，`replace` 在保留独占槽位的前提下更换实例，避免恢复窗口被同会话的下一个执行抢占。

失效与退出也有各自的口径：会话删除按沙箱名失效匹配的租约——空闲的立即回收，正忙的标记作废、本轮结束后回收；进程正常退出时关闭全部已创建实例，实例删除失败只记日志，进程失联的场景靠 Provider 自身的自动停止与过期删除兜底。

### 3、Skill 压缩上传与安全解包

Skill 进入沙箱走独立的播种通道（`internal/core/agent_v2/backends/sandbox/sandbox_skill_upload.py`）。传输与权限是两步：先传文件，再对 `skills`、`subagent_skills` 两个目录递归去掉写权限（`chmod -R a-w`），只读保护只作用于 Skill，工作区副本始终保持可写。传输策略按成本算账：原始内容达到 64KB 才尝试压缩，压缩后体积不超过原来的九成才走 zip 单包上传，否则保留逐文件直传——避免为小包白付一次打包解包。

安全解包的校验在远端脚本里完成（节选）：

```python
for info in archive.infolist():
    name = PurePosixPath(info.filename)
    parts = name.parts
    if (len(parts) < 3 or parts[0] not in {'skills', 'subagent_skills'}
            or '..' in parts or '\\' in info.filename
            or info.filename != name.as_posix() or info.filename in seen
            or stat.S_IFMT(info.external_attr >> 16) not in {0, stat.S_IFREG}):
        raise ValueError('Invalid Skill archive entry')
    seen.add(info.filename)
    target = root.joinpath(*parts)
    for candidate in (target, *target.parents):
        if candidate == root:
            break
        if candidate.is_symlink():
            raise ValueError('Skill destination contains a symlink')
    target.resolve().relative_to(root)
```

归档条目必须以两个授权目录前缀开头、路径里不许有 `..` 与反斜杠、文件名必须是规范 posix 形式且不重复、只允许普通文件；写入前还要检查目标及其父级路径上没有符号链接，`resolve` 之后必须仍落在根目录内。文件名只通过 ZIP 条目传递、不拼进 Shell 命令，解包脚本在 `finally` 里删除临时包。这套校验防的是经典的 zip 攻击面：路径穿越、软链接逃逸、以目录伪装可执行文件。

### 4、统一虚拟路径路由

统一路由的落点是一次运行构造一个 CompositeBackend，按路径前缀把不同后端挂进同一棵虚拟树（`internal/core/agent_v2/assembly/runtime_assembler.py`），长前缀优先匹配：

| 虚拟路径                                             | 内容             | 路由到                                     | 详见   |
| ---------------------------------------------------- | ---------------- | ------------------------------------------ | ------ |
| `/workspace/`                                      | 本轮工作副本     | 无沙箱时本地临时副本，有沙箱时沙箱文件系统 | 第四篇 |
| `skills/`、`subagent_skills/`                    | 只读 Skill 投影  | Skill 投影后端                             | 第五篇 |
| `/memories/`                                       | 文件式长期记忆   | 记忆 Store 后端                            | 第七篇 |
| `/conversation_history/`、`/large_tool_results/` | 压缩归档只读回查 | 会话 Store 后端                            | 第七篇 |

两种形态只差默认路由：无沙箱时 `/workspace/` 指向本地临时副本、其余路径落到内存状态后端；有沙箱时默认与根路由都显式指向沙箱——框架的权限编译要求显式根路由，缺了它图编不过。文件工具看到的一直是虚拟路径；Shell 依据执行后端从各虚拟目录的共同物理父目录启动，提示词向模型说明相对路径的对应关系（第七篇的路径规则）。

工作副本本身的形态值得单独说：每轮新建一个空临时目录，创建时不读任何文件、数据库或对象存储；远程沙箱懒启动时只迁移本轮已加载或生成的文件（枚举时拒绝符号链接），不下载整个持久化文件库；副本内的修改与删除不传播到已保存文件，关闭即丢弃——「副本」二字是字面意思。

交付工具（加载与保存，第四篇）绑定同一个复合后端与按账号、应用作用域的路径策略，交付只能访问授权工作区，借自定义工具绕不过 Skill 与记忆的路由权限。

:::note 安全能力不等于路径策略
本地 Shell、操作系统级隔离、远程沙箱的安全能力各不相同，设置虚拟路径与访问策略不等于主机级进程隔离，部署时要明确实际选择的 Provider 与其资源、网络限制。
:::

### 5、去留

执行环境的管理全部自持——装配入口、租约池、淘汰策略、播种与解包校验都是平台代码；执行能力本身借 Provider SDK（`langchain-daytona==0.0.7` 等）。

从原型一行 `exec` 到这套体系，动因不是安全洁癖，而是能力扩张的必然：当每次执行都可能写文件、起进程，执行环境就是运行时的地基。原型那条 todo 注释预见的方向，最终以 Provider 矩阵加租约池的形态落地。

模块纵线的上一篇是[应用与交付](./08-app-and-delivery.md)，下一篇见[Agent 测评与验收](./10-agent-evaluation.md)，目录与状态见[专栏入口](./index.md)。
