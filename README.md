# Nice AI 应用开发教程整理（GitHub Pages）

这是一个**文档型仓库**，用于沉淀：
- 优秀开源 AI 应用开发教程/文档的索引与总结（以链接 + 你的总结为主）
- 个人学习心得与方法论

站点由 **MkDocs** 构建，内容统一放在 `docs/` 下。

## 目录结构（核心）

```
.
├─ docs/                 # 站点内容（Markdown）
├─ mkdocs.yml            # 站点导航与配置
├─ requirements.txt      # MkDocs 依赖
└─ .github/workflows/    # 自动部署到 GitHub Pages
```

## 本地预览

```bash
pip install -r requirements.txt
mkdocs serve
```

然后打开终端输出的本地地址即可预览。

## 部署到 GitHub Pages

工作流已配置：推送到 `main` 分支会自动构建并发布到 GitHub Pages。

你需要在 GitHub 仓库设置中：
- Settings → Pages → Build and deployment：选择 **GitHub Actions**

## 内容入口

- 首页：docs/index.md
- 教程：docs/tutorials/
- HelloAgents：docs/tutorials/hello-agents/
