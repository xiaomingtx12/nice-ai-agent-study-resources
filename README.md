# Nice AI 资源库（GitHub Pages）

这是一个**文档型仓库**，用于沉淀：
- 值得长期跟踪的 AI 学习资源导航
- 对这些资源的直接判断和锐评
- 学习过程中留下来的个人笔记、复盘与模板

站点由 **Docusaurus** 构建，内容统一放在 `docs/` 下。

## 目录结构（核心）

```
.
├─ docs/                 # 站点内容（Markdown）
├─ docusaurus.config.ts  # Docusaurus 配置
├─ sidebars.ts           # 侧栏（自动从 docs/ 生成）
├─ package.json          # Node 依赖与脚本
└─ .github/workflows/    # 自动部署到 GitHub Pages
```

## 本地预览

```bash
npm install
npm run start
```

然后打开终端输出的本地地址即可预览。

## 部署到 GitHub Pages

工作流已配置：推送到 `main` 分支会自动构建并发布到 GitHub Pages。

你需要在 GitHub 仓库设置中：
- Settings → Pages → Build and deployment：选择 **GitHub Actions**

## 内容入口

- 首页：docs/index.md
- 资源导航：docs/resources/
- HelloAgents：docs/resources/hello-agents/
- 方法与复盘：docs/notes/

## 备注

本仓库已完全切换到 Docusaurus 构建与部署。
