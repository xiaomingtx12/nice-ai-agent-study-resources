// 在 Docusaurus 默认 Mermaid 插件之前运行，保留其 MDX 组件映射。
module.exports = function staticMermaid(options = {}) {
  return async (tree, file) => {
    const nodes = [];
    function collect(node) {
      if (node.type === 'code' && node.lang === 'mermaid') nodes.push(node);
      node.children?.forEach(collect);
    }
    collect(tree);
    if (!nodes.length) return;
    const {renderDiagram} = await import('./render.mjs');
    for (const node of nodes) {
      try {
        const diagram = await renderDiagram(node.value, options);
        node.type = 'staticMermaid';
        node.data = {hName: 'mermaid', hProperties: diagram};
        delete node.value;
        delete node.lang;
        delete node.meta;
      } catch (error) {
        // 失败在编译时指出文章与行号，不把重计算退回读者浏览器。
        file.fail(`Mermaid 预渲染失败：${error.message}`, node);
      }
    }
  };
};
