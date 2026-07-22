# Nice AI 学习沉淀

得益于强大的开源社区，今天已经有非常多优秀的 AI、Agent 和 AI Coding 学习资源。这个仓库基于这些公开资料做了一次持续整理：不是简单把链接堆在一起，而是把资源放回学习路径里，再补上我的判断、取舍和学习沉淀。

这里更关心两件事：

- 什么资源值得投入时间
- 学完之后什么内容值得留下来反复回看

在线阅读：[Nice AI 学习沉淀](https://xiaomingtx12.github.io/nice-ai-agent-study-resources/)

## 这个仓库在做什么

- 资源整合：把分散的书、教程、源码解析和实践材料按学习目标重新组织。
- 直接判断：会写清楚我怎么看这份资源，适合谁，不适合谁。
- 学习沉淀：为重要资源补充笔记、复盘、问题意识和后续延展。
- 应用延伸：带着真实问题进开源项目，看人家怎么解决，从“看资源”继续走到“拆真实系统”。

## 适合谁看

- 想系统进入 AI Agent / AI Coding 方向，但不想只看零散链接的人
- 已经开始学，但希望减少试错成本、提高选材质量的人
- 不满足于“总结一下内容”，更想看判断、取舍和学习路径的人
- 想从资源导航继续走到应用理解、系统拆解和实践沉淀的人

## 第一次访问建议怎么读

1. 如果你还没决定先学什么，先看 [资源导航](https://xiaomingtx12.github.io/nice-ai-agent-study-resources/resources/)。
2. 如果你已经在学某个资源，想知道它值不值得继续投入，就去看对应资源的单页：定位、适合谁、为什么收录、怎么用都写在一页里。
3. 如果你更关心学习方法、阶段复盘和判断标准，直接看 [方法与复盘](https://xiaomingtx12.github.io/nice-ai-agent-study-resources/notes/)。
4. 如果你更想看 AI 应用或 Agent 系统应该怎么拆，直接看 [应用拆解](https://xiaomingtx12.github.io/nice-ai-agent-study-resources/application-notes/)。

## 主要内容

- `docs/resources/`
  资源导航区。每条资源是一个单页，把定位、适合谁、为什么收录、怎么用和值不值得投入的判断都写在一页里。
- `docs/notes/`
  方法论、阶段复盘和学习判断标准，不只记录“学了什么”，更强调“为什么这样学”。
- `docs/application-notes/`
  带着真实问题拆开源项目源码与架构，现有 Dify v1.15.0（16 篇）和 Claude Code CLI（18 篇）两组系统级沉淀。
- `docs/templates/`
  共建说明和写法，适合之后继续扩展资源或复用写法。
- `docs/about/`
  站点作者和写作背景说明。

## 这个仓库和普通收藏夹的区别

- 不追求全，而是优先收录值得反复回看的材料。
- 不只给链接，而是尽量补上选择理由和阅读顺序。
- 不停留在“摘要式总结”，而是保留判断、问题和可复用的学习结果。
- 让应用拆解和方法与复盘构成一个循环：拆项目、抽技巧、技巧回喂下一轮；资源导航是旁边随时可查的参考底座。

## 本地预览

环境要求：

- Node.js `18+`，建议使用 `20`

启动方式：

```bash
npm install
npm run start
```

常用命令：

```bash
npm run start   # 本地开发预览
npm run build   # 生产构建
npm run serve   # 本地预览构建产物
npm run clear   # 清理 Docusaurus 缓存
```

## 部署说明

这个站点使用 Docusaurus 构建，并通过 GitHub Actions 部署到 GitHub Pages。

- 工作流文件：`/.github/workflows/deploy-docusaurus.yml`
- 发布方式：推送到 `main` 分支后自动构建并部署
- Pages 设置：仓库 `Settings -> Pages -> Build and deployment` 选择 `GitHub Actions`

## 维护入口

如果你后续要调整站点结构、栏目或侧栏，优先看这些文件：

- `SITE_STRUCTURE_GUIDE.md`：站点结构维护说明
- `docusaurus.config.ts`：顶栏、站点信息和挂载方式
- `sidebars.ts`：各栏目侧栏结构
- `docs/`：全部正文内容
