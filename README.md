# Nice AI 学习沉淀

把优秀学习资源和真实开源项目，变成人能复用、AI 能调用的工程判断。

站点按一条分工运转：AI 存着海量知识、能铺广度，但要人给方向才激活，还会自信地出错；人能判断真伪却知识有限。所以能交给 AI 做的（读、梳理、按方向拆）交给 AI，方向和判断留在人手里，AI 铺出来的东西人验真伪再入库。

方法与复盘里产出的技巧目标封成 skill 回喂应用拆解，让工程判断越攒越准——这一条还在建。

在线阅读：[Nice AI 学习沉淀](https://xiaomingtx12.github.io/nice-ai-agent-study-resources/)

## 三栏各做什么

- **资源导航**（`docs/resources/`）：值得反复回看的学习资源，每条一个单页，写清定位、适合谁、为什么收录、怎么用。是拆解和复盘的参考底座。
- **应用拆解**（`docs/application-notes/`）：人先判断一个项目值得拆哪一点（工程实现 / 功能交互 / 商业模式），定方向，AI 再沿方向深挖、人验真伪。现有 Dify v1.15.0（16 篇）和 Claude Code CLI（18 篇）两组。
- **方法与复盘**（`docs/notes/`）：从拆解里提炼能带到下一次的判断、模式和 agent 工程技巧，目标封成 skill 回喂应用拆解。

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
- `AGENTS.md`：协作约定和文档风格
- `docs/`：全部正文内容
