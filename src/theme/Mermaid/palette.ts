// Mermaid 需要十六进制颜色来计算布局。只在生成的 SVG 样式中换成站点变量，
// 让明暗与阅读风格切换由浏览器换色，不再重新计算图的几何布局。
export const diagramPalette = {
  background: "#fbf8f1",
  primaryColor: "#f5efdf",
  primaryTextColor: "#292820",
  primaryBorderColor: "#b5ad98",
  lineColor: "#6b685b",
  secondaryColor: "#eee9dd",
  tertiaryColor: "#fffdf7",
  textColor: "#292820",
  nodeTextColor: "#292820",
  mainBkg: "#f5efdf",
  nodeBorder: "#b5ad98",
  clusterBkg: "#fffdf7",
  clusterBorder: "#b5ad98",
  titleColor: "#292820",
  edgeLabelBackground: "#fbf8f1",
  actorBkg: "#f5efdf",
  actorBorder: "#b5ad98",
  actorTextColor: "#292820",
  actorLineColor: "#6b685b",
  signalColor: "#6b685b",
  signalTextColor: "#292820",
  labelBoxBkgColor: "#fffdf7",
  labelBoxBorderColor: "#b5ad98",
  labelTextColor: "#292820",
  loopTextColor: "#292820",
  noteBkgColor: "#eee9dd",
  noteBorderColor: "#b5ad98",
  noteTextColor: "#292820",
  activationBkgColor: "#eee9dd",
  activationBorderColor: "#b5ad98",
  sequenceNumberColor: "#fffdf7",
};

const tokens: Record<string, string> = {
  "#fbf8f1": "--site-bg",
  "#f5efdf": "--site-surface-strong",
  "#292820": "--site-text",
  "#b5ad98": "--site-border-strong",
  "#6b685b": "--site-text-muted",
  "#eee9dd": "--site-surface-strong",
  "#fffdf7": "--site-surface",
};

export function preserveAuthoredLabelContrast(document: Document): void {
  for (const group of Array.from(document.querySelectorAll('.node, .cluster'))) {
    const shape = group.querySelector<SVGElement>(':scope > rect, :scope > polygon, :scope > path');
    const fill = shape?.style.fill || shape?.getAttribute('fill') || '';
    const hex = /^#([\da-f]{6}|[\da-f]{3})$/i.exec(fill)?.[1];
    const rgb = /^rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)$/i.exec(fill);
    if (!hex && !rgb) continue;
    const full = hex ? (hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex) : rgb!.slice(1).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('');
    if (tokens[`#${full.toLowerCase()}`]) continue;
    // 作者固定了节点底色时，文字也需保持与这个底色匹配，不能随全站变白。
    const channels = [0, 2, 4].map((index) => {
      const value = parseInt(full.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    const foreground = luminance > 0.179 ? '#000000' : '#ffffff';
    const label = group.querySelector<SVGElement>(':scope > .label, :scope > .cluster-label');
    label?.style.setProperty('--site-text', foreground);
  }
}

export function applyDiagramPalette(svg: string): string {
  const replaceColors = (css: string) => css.replace(/#[\da-f]{3,8}\b/gi, (color) => {
    const token = tokens[color.toLowerCase()];
    return token ? `var(${token}, ${color})` : color;
  });
  // 不改图中的文字、id、链接，也不覆盖作者指定的其他语义颜色。
  return svg
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => `${open}${replaceColors(css)}${close}`)
    .replace(/(\s(?:fill|stroke|color|style)=)(["'])(.*?)\2/gi, (_, attr, quote, value) => `${attr}${quote}${replaceColors(value)}${quote}`);
}
