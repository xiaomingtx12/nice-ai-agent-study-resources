import { readFileSync, writeFileSync } from 'fs';

const SCHEMA = {
  '00-project-overview.md': {
    '## LLM-wiki 范式：为什么用 LLM 维护 Wiki':                         '## 一、LLM-wiki 范式：为什么用 LLM 维护 Wiki',
    '## 模块地图与工程实现':                                              '## 二、模块地图与工程实现',
    '### 模块地图':                                                       '### 2.1 模块地图',
    '### 五个源码阶段':                                                   '### 2.2 五个源码阶段',
    '### 框架与项目各负责什么':                                           '### 2.3 框架与项目各负责什么',
    '## 操作方式':                                                        '## 三、操作方式',
    '## 输出模式':                                                        '## 四、输出模式',
    '## 运行产物':                                                        '## 五、运行产物',
    '## 文章分工':                                                        '## 六、文章分工',
    '## 阅读结论':                                                        '## 七、阅读结论',
  },
  '01-connectors-and-ingestion.md': {
    '## 来源注册与模式入口':                                              '## 一、来源注册与模式入口',
    '## 个人模式':                                                        '## 二、个人模式',
    '### 按来源串行编排':                                                 '### 2.1 按来源串行编排',
    '### MCP 只读工具准入':                                               '### 2.2 MCP 只读工具准入',
    '## 代码模式':                                                        '## 三、代码模式',
    '### Git：证据底座':                                                  '### 3.1 Git：证据底座',
    '### LangSmith：运行 trace 证据':                                     '### 3.2 LangSmith：运行 trace 证据',
    '## 原始文件：两种模式共同的证据缓存':                                '## 四、原始文件：两种模式共同的证据缓存',
    '## 边界与延伸':                                                      '## 五、边界与延伸',
  },
  '02-agent-assembly.md': {
    '## 先看完整装配链':                                                  '## 一、先看完整装配链',
    '## `runOpenWikiAgent`：在 graph 外做准备':                           '## 二、`runOpenWikiAgent`：在 graph 外做准备',
    '## `runOpenWikiAgentCore`：创建本次 run 的资源':                     '## 三、`runOpenWikiAgentCore`：创建本次 run 的资源',
    '## `createDeepAgent`：把对象关系交给框架':                           '## 四、`createDeepAgent`：把对象关系交给框架',
    '## 默认 Middleware 与项目 Middleware 如何合并':                       '## 五、默认 Middleware 与项目 Middleware 如何合并',
    '## Prompt 如何进入框架':                                             '## 六、Prompt 如何进入框架',
    '## 执行图事件流是运行接口':                                          '## 七、执行图事件流是运行接口',
    '## 这份契约的边界':                                                  '## 八、这份契约的边界',
  },
  '03-backend-and-permissions.md': {
    '## 先给结论':                                                        '## 一、先给结论',
    '## 一、两个 Backend 组成一个文件视图':                               '## 二、两个 Backend 组成一个文件视图',
    '## 二、`virtualMode` 只解决路径语义':                                '## 三、`virtualMode` 只解决路径语义',
    '## 三、写入检查由 Backend override 执行':                            '## 四、写入检查由 Backend override 执行',
    '## 四、忽略规则覆盖所有文件工具':                                    '## 五、忽略规则覆盖所有文件工具',
    '## 五、`.openwikiignore` 使用最后匹配规则':                          '## 六、`.openwikiignore` 使用最后匹配规则',
    '## 六、忽略规则激活后，shell 只剩 allowlist':                        '## 七、忽略规则激活后，shell 只剩 allowlist',
    '## 七、permissions 与自定义 Backend 各管一层':                       '## 八、permissions 与自定义 Backend 各管一层',
    '## 八、工程取舍':                                                    '## 九、工程取舍',
    '### 适合照搬':                                                       '### 9.1 适合照搬',
    '### 应该换实现':                                                     '### 9.2 应该换实现',
    '### 不要照搬':                                                       '### 9.3 不要照搬',
    '## 测试锁定的边界':                                                  '## 十、测试锁定的边界',
    '## 读完后应该能判断什么':                                            '## 十一、读完后应该能判断什么',
  },
  '04-skills-planning-subagents.md': {
    '## Skills：发布包内容先复制到用户目录':                              '## 一、Skills：发布包内容先复制到用户目录',
    '## Skill 挂载与渐进披露':                                            '## 二、Skill 挂载与渐进披露',
    '## TodoList 与 `_plan.md` 分别控制运行和文档结构':                   '## 三、TodoList 与 `_plan.md` 分别控制运行和文档结构',
    '## Sub-agent 继承能力，不继承只读保证':                              '## 四、Sub-agent 继承能力，不继承只读保证',
    '## 委派链路':                                                        '## 五、委派链路',
    '## 设计边界':                                                        '## 六、设计边界',
  },
  '05-middleware-lifecycle.md': {
    '## 三个 hook 观察三种状态':                                          '## 一、三个 hook 观察三种状态',
    '## `beforeAgent`：先处理既有页面':                                  '## 二、`beforeAgent`：先处理既有页面',
    '## `wrapToolCall`：只检查真实成功写入':                              '## 三、`wrapToolCall`：只检查真实成功写入',
    '### wrapper 中的失败怎样传播':                                       '### 3.1 wrapper 中的失败怎样传播',
    '## `afterAgent`：主循环结束后的收尾':                                '## 四、`afterAgent`：主循环结束后的收尾',
    '## 失败如何进入 repository run 的恢复逻辑':                          '## 五、失败如何进入 repository run 的恢复逻辑',
    '## 生命周期边界':                                                    '## 六、生命周期边界',
  },
  '06-okf-and-mermaid-pipeline.md': {
    // May already be numbered from manual edits; match both numbered and un-numbered
    '## 一条 Middleware 中有两种写入者':                                  '## 一、一条 Middleware 中有两种写入者',
    '## 一、一条 Middleware 中有两种写入者':                              '## 一、一条 Middleware 中有两种写入者',
    '## Front matter 校验与迁移不是同一套规则':                           '## 二、Front matter 校验与迁移不是同一套规则',
    '## 二、Front matter 校验与迁移不是同一套规则':                       '## 二、Front matter 校验与迁移不是同一套规则',
    '## Index 同步是从子目录回到父目录':                                  '## 三、Index 同步是从子目录回到父目录',
    '## 三、Index 同步是从子目录回到父目录':                              '## 三、Index 同步是从子目录回到父目录',
    '## Mermaid 校验：完整 parser 可选，heuristic 会漏报':                '## 四、Mermaid 校验：完整 parser 可选，heuristic 会漏报',
    '## Mermaid 的 bottom-up 是同文件反向 splice':                        '## 五、Mermaid 的 bottom-up 是同文件反向 splice',
    '## 保证范围':                                                        '## 六、保证范围',
  },
  '07-context-checkpoint-recovery.md': {
    '## Run context：一次运行的派生输入':                                 '## 一、Run context：一次运行的派生输入',
    '## Checkpoint：chat 有持久能力，init/update 没有':                   '## 二、Checkpoint：chat 有持久能力，init/update 没有',
    '## Wiki 文档：init/update 的长期结果':                               '## 三、Wiki 文档：init/update 的长期结果',
    '## Update metadata：调度提示，不是回滚日志':                         '## 四、Update metadata：调度提示，不是回滚日志',
    '## Deep Agents 摘要与 Backend 的组合行为':                           '## 五、Deep Agents 摘要与 Backend 的组合行为',
    '## 一次 repository run 的状态流':                                    '## 六、一次 repository run 的状态流',
    '## 恢复边界':                                                        '## 七、恢复边界',
  },
  '08-model-provider-routing.md': {
    '## Provider 是配置入口':                                             '## 一、Provider 是配置入口',
    '## `createModel` 统一返回 ChatModel':                                '## 二、`createModel` 统一返回 ChatModel',
    '## Vertex provider 内部还要按模型 family 分流':                      '## 三、Vertex provider 内部还要按模型 family 分流',
    '### Anthropic family':                                               '### 3.1 Anthropic family',
    '### OpenAI-compatible MaaS family':                                  '### 3.2 OpenAI-compatible MaaS family',
    '### Gemini family':                                                  '### 3.3 Gemini family',
    '## Gemini thought signature workaround 绑定具体依赖版本':            '## 四、Gemini thought signature workaround 绑定具体依赖版本',
    '## ChatGPT 登录接的是 OpenWiki 0.2.4 当前 Codex surface':           '## 五、ChatGPT 登录接的是 OpenWiki 0.2.4 当前 Codex surface',
    '## OpenAI-compatible 只说明协议外壳':                                '## 六、OpenAI-compatible 只说明协议外壳',
    '## 路由边界':                                                        '## 七、路由边界',
  },
  '09-cli-credentials-and-operations.md': {
    '## 从 argv 到运行入口':                                              '## 一、从 argv 到运行入口',
    '## 运行命令如何真正进入 Agent':                                      '## 二、运行命令如何真正进入 Agent',
    '### cron 与 ngrok 是独立命令种类':                                   '### 2.1 cron 与 ngrok 是独立命令种类',
    '## 环境加载只补缺失值':                                              '## 三、环境加载只补缺失值',
    '## 凭据文件的权限分成两条实现':                                      '## 四、凭据文件的权限分成两条实现',
    '### Unix 路径':                                                      '### 4.1 Unix 路径',
    '### Windows 路径':                                                   '### 4.2 Windows 路径',
    '## 配置向导不等于运行时认证':                                        '## 五、配置向导不等于运行时认证',
    '## 诊断先脱敏，失败不覆盖主错误':                                    '## 六、诊断先脱敏，失败不覆盖主错误',
    '## Telemetry 记录运行元数据':                                        '## 七、Telemetry 记录运行元数据',
    '## 平台支持要看实际 CI 矩阵':                                        '## 八、平台支持要看实际 CI 矩阵',
  },
  '10-runtime-and-testing.md': {
    '## 一次 run 的状态转换':                                             '## 一、一次 run 的状态转换',
    '### Startup：先决定是否需要 Agent':                                  '### 1.1 Startup：先决定是否需要 Agent',
    '### Prepared：构造本次运行依赖':                                     '### 1.2 Prepared：构造本次运行依赖',
    '### Streaming：graph 边运行边产生副作用':                            '### 1.3 Streaming：graph 边运行边产生副作用',
    '### Complete：stream 完成后才记录完成状态':                          '### 1.4 Complete：stream 完成后才记录完成状态',
    '### Interrupted：保留部分写入并阻止错误的无需更新判断':              '### 1.5 Interrupted：保留部分写入并阻止错误的无需更新判断',
    '## Ingestion 与 repository run 的关系':                              '## 二、Ingestion 与 repository run 的关系',
    '## 四类验证回答四种问题':                                            '## 三、四类验证回答四种问题',
    '### 1. 单元测试：局部规则是否按预期':                                '### 3.1 单元测试：局部规则是否按预期',
    '### 2. 集成测试：多个模块组合后边界是否成立':                        '### 3.2 集成测试：多个模块组合后边界是否成立',
    '### 3. 真实 E2E：外部协议是否真的可调用':                            '### 3.3 真实 E2E：外部协议是否真的可调用',
    '### 4. DeepSWE eval：加入 OpenWiki 是否改变 coding agent 结果':      '### 3.4 DeepSWE eval：加入 OpenWiki 是否改变 coding agent 结果',
    '## 证据层级':                                                        '## 四、证据层级',
  },
};

const BASE = 'D:/repos/nice-ai-agent-study-resources/docs/application-notes/engineering/deepagents应用案例解析/openwiki';

for (const [file, mapping] of Object.entries(SCHEMA)) {
  const path = `${BASE}/${file}`;
  let content = readFileSync(path, 'utf-8');
  let changed = false;
  for (const [oldHeading, newHeading] of Object.entries(mapping)) {
    const escaped = oldHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped}$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, newHeading);
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(path, content, 'utf-8');
    console.log(`OK    ${file}`);
  } else {
    console.log(`SKIP  ${file} (no changes)`);
  }
}

// Verify
console.log('\n=== VERIFICATION ===');
for (const file of Object.keys(SCHEMA)) {
  const path = `${BASE}/${file}`;
  const content = readFileSync(path, 'utf-8');
  const fences = (content.match(/^```/gm) || []).length;
  const ok = fences % 2 === 0 ? 'OK' : 'ODD';
  console.log(`${file}: fences=${fences} ${ok}`);
  // Print headings for sanity
  const headings = content.match(/^#{2,3} .+$/gm) || [];
  for (const h of headings) {
    console.log(`  ${h}`);
  }
}
