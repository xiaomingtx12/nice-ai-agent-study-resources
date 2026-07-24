// WCAG 2.1 对比度校验
// 参考 https://www.w3.org/TR/WCAG21/#contrast-minimum
const PALETTE = {
  // —— editorial（米白主题）——
  'editorial-light': {
    bg: '#f7f1e8', surface: '#fffaf2', surfaceStrong: '#f2e7d9',
    text: '#2b241f', textMuted: '#6a5f56',
    border: '#d3c3b0', borderStrong: '#bda88f',
    accent: '#8a5a38', accentSoft: '#b8825c', accentStrong: '#6f4528',
    codeBg: '#f3eadf',
  },
  'editorial-dark': {
    bg: '#181310', surface: '#221b17', surfaceStrong: '#2b221d',
    text: '#f1e6da', textMuted: '#c4b2a2',
    border: '#5a4738', borderStrong: '#745a45',
    accent: '#cf9b72', accentSoft: '#dfb089', accentStrong: '#b07a55',
    codeBg: '#1f1814',
  },
  // —— signal（蓝灰主题）——
  'signal-light': {
    bg: '#eef5fb', surface: '#f9fcfe', surfaceStrong: '#dceaf3',
    text: '#20303a', textMuted: '#58717f',
    border: '#c2d7e5', borderStrong: '#98b8cb',
    accent: '#1b6e94', accentSoft: '#4e90b1', accentStrong: '#145777',
    codeBg: '#e4f0f7',
  },
  'signal-dark': {
    bg: '#0e1820', surface: '#142230', surfaceStrong: '#1a2c3d',
    text: '#dde8ef', textMuted: '#8aa1b0',
    border: '#2f4458', borderStrong: '#3f5a73',
    accent: '#6fb2d4', accentSoft: '#92c5e0', accentStrong: '#4f9bc2',
    codeBg: '#152532',
  },
  // —— archive（灰绿主题）——
  'archive-light': {
    bg: '#f2f0eb', surface: '#fbfaf7', surfaceStrong: '#e6e2d8',
    text: '#2c2a26', textMuted: '#636058',
    border: '#ccc6b8', borderStrong: '#ada492',
    accent: '#5e6c57', accentSoft: '#7b8975', accentStrong: '#4a5643',
    codeBg: '#ebe7de',
  },
  'archive-dark': {
    bg: '#161614', surface: '#1f1f1c', surfaceStrong: '#272723',
    text: '#e2e0d8', textMuted: '#9c9a8e',
    border: '#3a3a35', borderStrong: '#4a4a44',
    accent: '#94a78c', accentSoft: '#a8b8a0', accentStrong: '#7d9275',
    codeBg: '#1c1c1a',
  },
  // —— classic（Docusaurus 默认黑白）——
  'classic-light': {
    bg: '#ffffff', surface: '#f8f8fa', surfaceStrong: '#f0f0f2',
    text: '#1c1e21', textMuted: '#717172',
    border: '#e0e0e2', borderStrong: '#c8c8ca',
    accent: '#16735b', accentSoft: '#4dd4b8', accentStrong: '#0f5946',
    codeBg: '#f0f0f2',
  },
  'classic-dark': {
    bg: '#1b1b1d', surface: '#232326', surfaceStrong: '#2c2c2f',
    text: '#e3e3e5', textMuted: '#a6a6a8',
    border: '#3a3a3d', borderStrong: '#4a4a4d',
    accent: '#2dd4ad', accentSoft: '#5ee0c0', accentStrong: '#1ab592',
    codeBg: '#2c2c2f',
  },
};

// —— 实际会用到的"前景/背景"配对（按 UI 真实场景）——
const PAIRS = [
  // 正文文字 vs 底色
  {name: '正文文字 vs 底色', fg: 'text', bg: 'bg', kind: 'body'},
  {name: '次要文字 vs 底色', fg: 'textMuted', bg: 'bg', kind: 'body'},
  // 强调色（链接/重点）vs 底色
  {name: '强调色 vs 底色', fg: 'accent', bg: 'bg', kind: 'body'},
  {name: '强调色（浅） vs 底色', fg: 'accentSoft', bg: 'bg', kind: 'body'},
  {name: '强调色（深） vs 底色', fg: 'accentStrong', bg: 'bg', kind: 'body'},
  // 文字 vs 表面色（卡片底）
  {name: '文字 vs 表面', fg: 'text', bg: 'surface', kind: 'body'},
  {name: '次要文字 vs 表面', fg: 'textMuted', bg: 'surface', kind: 'body'},
  {name: '强调色 vs 表面', fg: 'accent', bg: 'surface', kind: 'body'},
  // 文字 vs 代码块底
  {name: '代码块底 vs 底色（边界可见性）', fg: 'codeBg', bg: 'bg', kind: 'ui'},
  {name: '边框 vs 底色（UI 边界）', fg: 'border', bg: 'bg', kind: 'ui'},
  // 链接 vs 底色（链接 hover 前通常是 accent；这是 body 文字规格）
  {name: '次要文字 vs 强表面', fg: 'textMuted', bg: 'surfaceStrong', kind: 'body'},
];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(hexToRgb(fg));
  const L2 = relativeLuminance(hexToRgb(bg));
  const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// AA：body ≥ 4.5，large ≥ 3；AAA：body ≥ 7，large ≥ 4.5
function verdict(ratio, kind) {
  const pass = (v) => v === '✓' || v === 'AA-large' || v === 'AAA';
  const a = ratio >= 4.5 ? '✓ AA' : ratio >= 3 ? 'AA-large only' : '✗ FAIL';
  const aaa = ratio >= 7 ? '✓ AAA' : ratio >= 4.5 ? 'AA' : '< AA';
  if (kind === 'body') return `${a}  | AAA: ${aaa}`;
  return `UI  |  ${a}  | AAA: ${aaa}`;
}

console.log('WCAG 对比度校验\n');
console.log('阈值：AA 正文 ≥ 4.5  AA 大字 ≥ 3.0  AAA 正文 ≥ 7.0\n');
console.log('='.repeat(78));

for (const [themeName, palette] of Object.entries(PALETTE)) {
  console.log(`\n【${themeName}】`);
  for (const pair of PAIRS) {
    const fg = palette[pair.fg];
    const bg = palette[pair.bg];
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const v = verdict(ratio, pair.kind);
    const tag = ratio < 4.5 && pair.kind === 'body' ? '  ⚠️' : ratio < 3 ? '  ⚠️' : '';
    console.log(
      `  ${pair.name.padEnd(28)} ${fg} on ${bg}  ratio=${ratio.toFixed(2)}${tag}`
    );
    console.log(`    → ${v}`);
  }
}

console.log('\n' + '='.repeat(78));
console.log('注：body = 正文/链接，须达 4.5:1；UI = 装饰边框/分隔，3:1 即可。');