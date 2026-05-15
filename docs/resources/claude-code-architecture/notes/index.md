---
sidebar_position: 1
---

# Claude Code Architecture（CCB）学习沉淀

这里放我真正读这条资源时留下来的东西。重点不是“Claude Code 很强”，而是把强点背后的工程结构提炼出来。

## 当前内容

- [为什么我把它看成逆向架构白皮书](./why-i-see-it-as-a-reverse-engineering-whitepaper.md)
- [五层架构里，哪几层最值得拿来当通用分析框架](./which-layers-are-most-worth-reusing-as-a-framework.md)
- [怎么把它和 Learn Claude Code 区分开来看](./how-i-separate-it-from-learn-claude-code.md)
- [QueryEngine、权限、压缩、遥测里，哪些是真正的产品级分水岭](./why-queryengine-permissions-compaction-and-telemetry-are-the-real-product-divide.md)

## 建议先看顺序

1. 先看 [为什么我把它看成逆向架构白皮书](./why-i-see-it-as-a-reverse-engineering-whitepaper.md)，先抓住它的定位
2. 再看 [五层架构里，哪几层最值得拿来当通用分析框架](./which-layers-are-most-worth-reusing-as-a-framework.md)，先把复用价值最高的骨架抓住
3. 再看 [怎么把它和 Learn Claude Code 区分开来看](./how-i-separate-it-from-learn-claude-code.md)，避免和教学型材料混读
4. 最后看 [QueryEngine、权限、压缩、遥测里，哪些是真正的产品级分水岭](./why-queryengine-permissions-compaction-and-telemetry-are-the-real-product-divide.md)，把“会拆”推进到“会判断产品级系统差异”

## 下一批最值得补的内容

- 五层架构和主数据流的章节级锐评
- QueryEngine、权限链路、压缩链路的更细颗粒度专题
- Telemetry、远程配置和设置同步这一段的治理判断
