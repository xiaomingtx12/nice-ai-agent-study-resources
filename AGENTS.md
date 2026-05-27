# AGENTS.md

这个仓库是一个 Docusaurus 站点，核心内容是 AI / Agent 学习资源导航、锐评、学习沉淀和应用笔记。

给在这里工作的代理的约定很简单：先看现有结构，再按现有风格改，不要把仓库改成别的样子。

## 先读哪些文件

- `README.md`：仓库定位、内容范围、本地预览方式
- `SITE_STRUCTURE_GUIDE.md`：站点结构、侧栏规则、常见修改路径
- `docusaurus.config.ts`：顶栏、站点信息、docs 挂载方式
- `sidebars.ts`：左侧导航的真实来源
- `docs/templates/how-to-add-resource.md`：新增资源的写法约定

## 这个仓库的内容结构

- `docs/resources/`：资源导航区
- `docs/notes/`：方法论、阶段复盘、学习判断
- `docs/application-notes/`：应用和平台相关的结构化笔记
- `docs/templates/`：共建说明和写作模板
- `src/`：站点主题、搜索页、样式和少量交互组件
- `scripts/`：结构校验和构建辅助脚本

## 资源导航怎么写

每条重点资源通常是一组文档，不是单个页面。

标准结构是：

```text
docs/resources/<resource-slug>/
  index.md
  review.md
  notes/
    index.md
    *.md
```

对应的 sidebar 入口必须在 `sidebars.ts` 里手写加入，通常用 `resourceEntry(...)`。

新增资源后，通常还要同步更新 `docs/resources/index.md` 里的：

- 学习地图
- 常见阅读路线
- 资源角色卡

## 文档风格

- 全站默认中文写作
- 语气要像判断，不像宣传
- 先讲结论，再讲理由
- 不要把目录复述成正文
- 不要堆“很重要”“很值得”这类空判断
- 资源页要说清楚适合谁、不适合谁、为什么收录、怎么用
- 锐评页要明确强项、保留意见、是否值得投入时间
- 学习沉淀页要保留真实笔记，不要变成目录复印件

## 常见页面约定

### `docs/resources/<slug>/index.md`

写资源总览，通常包含：

- 官网 / 仓库链接
- 资源定位
- 讲什么
- 适合谁 / 不适合谁
- 为什么收进来
- 建议怎么用
- 入口链接

### `docs/resources/<slug>/review.md`

写锐评，通常先给结论，再写：

- 最值钱的地方
- 保留意见
- 值不值得投入时间
- 时间有限时先看什么

### `docs/resources/<slug>/notes/index.md`

写学习沉淀入口，只保留真正会继续写下去的内容。

它不是资源页的重复，也不是长目录列表。

## 侧栏和结构

- `sidebars.ts` 是侧栏真相源，别只新建文件不改这里
- 资源导航使用手写分组，不靠整目录自动展开
- `_category_.json` 只在需要目录元数据时用，不是主要导航机制
- 首页和关于页是纯文档页，不挂 sidebar

## 前端和样式

- `src/` 里的实现以现有 React / TypeScript / CSS Modules 风格为准
- `custom.css` 只做少量全站样式修正，不要把它变成大杂烩
- 优先复用现有主题、搜索和布局做法，少加依赖，少做跨文件重构
- 如果要改视觉，保持站点现在这种克制、密度高、偏编辑型的风格

## 修改时的习惯

- 先读相邻的已有文件，再改同类文件
- 只改和当前任务有关的文件
- 不要回滚工作区里不是你改的内容
- 路径、slug、sidebar id 要保持稳定，别频繁重命名

## 验证

常用检查顺序：

```bash
node scripts/validate-page-redesign.mjs
npm run build
npm run start
```

如果你改的是某个资源区，优先再跑对应的结构校验脚本。

如果在 Windows 上构建时报 `EPERM`、`unlink`、`rename` 一类错误，先判断是不是文件锁或环境问题，再怀疑文档内容本身。

## 变更优先级

1. 先保证站点结构和侧栏正确
2. 再保证资源页内容和语气一致
3. 最后才考虑样式和结构优化

