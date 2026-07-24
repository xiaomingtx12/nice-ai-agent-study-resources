// 字体自托管：替代 Google Fonts 外链（渲染阻塞 + 国内可达性差会导致首屏白屏）。
// Fontsource 的 CJK 字体按 unicode-range 分包，浏览器只下载页面实际用到的子集；
// font-display 均为 swap。权重与原先 Google Fonts css2 请求保持一致。
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/500.css';
import '@fontsource/noto-serif-sc/600.css';
import '@fontsource/noto-serif-sc/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
