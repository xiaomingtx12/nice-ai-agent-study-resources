// 生成 1200×630 的社交分享卡片。
const {createCanvas, GlobalFonts} = require('@napi-rs/canvas');
const fs = require('fs');

const W = 1200;
const H = 630;
const OUT = 'static/img/social-card.png';

// 主题色（与 src/css/custom.css 的 editorial 主题对齐）
const BG = '#f7f1e8';
const SURFACE = '#fffaf2';
const BORDER = '#d3c3b0';
const TEXT = '#2b241f';
const MUTED = '#6a5f56';
const ACCENT = '#8a5a38';

let fontLoaded = false;
try {
  GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'MSYH');
  GlobalFonts.registerFromPath('C:/Windows/Fonts/msyhbd.ttc', 'MSYH-Bold');
  fontLoaded = true;
} catch (e) {
  console.error('字体加载失败:', e.message);
}

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

// 背景
ctx.fillStyle = BG;
ctx.fillRect(0, 0, W, H);

// 顶部 logo 三横
const logoX = 90;
const logoY = 90;
const logoW = 220;
const barH = 16;
const gap = 16;
ctx.fillStyle = ACCENT;
ctx.fillRect(logoX, logoY, logoW * 0.55, barH);
ctx.fillRect(logoX, logoY + (barH + gap), logoW * 0.78, barH);
ctx.fillRect(logoX, logoY + 2 * (barH + gap), logoW, barH);

// 右上角：仓库地址（与三横同高，避免压到下方内容）
ctx.fillStyle = MUTED;
ctx.font = '20px MSYH, sans-serif';
ctx.textAlign = 'right';
ctx.fillText('xiaomingtx12.github.io/nice-ai-agent-study-resources', W - 90, logoY + 18);
ctx.textAlign = 'left';

// 站点名
const brandY = logoY + 3 * (barH + gap) + 36;
ctx.fillStyle = TEXT;
ctx.font = 'bold 34px MSYH-Bold, MSYH, sans-serif';
ctx.textBaseline = 'top';
ctx.fillText('Nice AI 学习沉淀', logoX, brandY);

// 主标题（两行：手动断句）
const titleY = brandY + 56;
ctx.fillStyle = TEXT;
ctx.font = 'bold 56px MSYH-Bold, MSYH, sans-serif';
const titleLines = [
  '把优秀学习资源和真实开源项目，',
  '变成人能复用、AI 能调用的工程判断。',
];
titleLines.forEach((line, i) => {
  ctx.fillText(line, logoX, titleY + i * 78);
});

// 副标题
const subY = titleY + titleLines.length * 78 + 24;
ctx.fillStyle = MUTED;
ctx.font = '28px MSYH, sans-serif';
ctx.fillText('人定方向 · AI 铺广度 · 人验真伪', logoX, subY);

// 三栏卡片（贴在底部，避开副标题）
const colsY = H - 110;
const colW = 320;
const colGap = 30;
const cols = [
  {label: '资源导航', sub: '随时可查的参考底座'},
  {label: '应用拆解', sub: 'Dify · Claude Code CLI 等'},
  {label: '方法与复盘', sub: '拆完沉淀工程判断'},
];

cols.forEach((c, i) => {
  const x = logoX + i * (colW + colGap);
  ctx.fillStyle = SURFACE;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 2;
  roundRect(ctx, x, colsY, colW, 80, 12, true, true);
  ctx.fillStyle = TEXT;
  ctx.font = 'bold 26px MSYH-Bold, MSYH, sans-serif';
  ctx.fillText(c.label, x + 20, colsY + 16);
  ctx.fillStyle = MUTED;
  ctx.font = '20px MSYH, sans-serif';
  ctx.fillText(c.sub, x + 20, colsY + 48);
});

if (!fontLoaded) {
  console.warn('警告：中文字体未加载，文字可能显示为方块');
}

canvas.encode('png').then(png => {
  fs.writeFileSync(OUT, png);
  console.log(`已生成 ${OUT}（${W}x${H}）`);
});

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}