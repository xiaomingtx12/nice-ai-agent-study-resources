# 如何新增一个教程

建议每个教程一个目录：

```
docs/tutorials/<tutorial-name>/
  index.md
  summaries/
    index.md
  notes/
    index.md
```

最小步骤：
1) 在 `docs/tutorials/` 下创建目录
2) 在 `index.md` 写：官网链接、学习计划、进度、你的总结索引
3) 学习过程中先把碎片记录放 `notes/`，提炼后放 `summaries/`
4) （可选）如需自定义侧栏顺序/分组，可在 `docs/` 对应目录下添加/调整 `_category_.json`
