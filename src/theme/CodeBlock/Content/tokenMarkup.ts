import type {Token} from 'prism-react-renderer';

const escapes: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => escapes[character]);

// 代码来自文档，仍逐段转义。只输出固定标签，不把源码当作 HTML 执行。
// 普通文本不包 span，语法 token 不再各自创建 React 组件和 Fiber。
export function renderTokenMarkup(lines: Token[][], lineClasses: Record<number, string>, numbered: boolean): string {
  return lines.map((line, index) => {
    const content = line.map(token => {
      const text = escapeHtml(token.empty ? '' : token.content);
      if (token.types.every(type => type === 'plain')) return text;
      return '<span class="token ' + escapeHtml(token.types.join(' ')) + '">' + text + '</span>';
    }).join('');
    const className = escapeHtml(['token-line', numbered ? 'site-code-line-numbered' : '', lineClasses[index] || ''].filter(Boolean).join(' '));
    const body = numbered
      ? '<span class="site-code-line-number" aria-hidden="true"></span><span class="site-code-line-content">' + content + '</span>'
      : content;
    return '<div class="' + className + '">' + body + '<br/></div>';
  }).join('');
}
