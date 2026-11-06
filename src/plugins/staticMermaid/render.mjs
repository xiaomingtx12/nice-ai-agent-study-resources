import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
import {applyDiagramPalette, diagramPalette, preserveAuthoredLabelContrast} from '../../theme/Mermaid/palette.mjs';

const require = createRequire(import.meta.url);
const siteDir = fileURLToPath(new URL('../../../', import.meta.url));
const defaultCacheDir = path.join(siteDir, 'node_modules/.cache/mermaid-svg');
const fontFamily = 'Noto Sans SC, sans-serif';
const pending = new Map();
let queue = Promise.resolve();
let browser;
let idleTimer;
let queuedCount = 0;
let fingerprintPromise;

async function fontCSS() {
  const cssPath = require.resolve('@fontsource/noto-sans-sc/400.css');
  const css = await readFile(cssPath, 'utf8');
  return css.replace(/url\(([^)]+)\)/g, (_, name) =>
    `url("${pathToFileURL(path.resolve(path.dirname(cssPath), name)).href}")`);
}

function fingerprint() {
  // 包版本、字体、配色或生成逻辑变化时，旧 SVG 自动失效。
  return fingerprintPromise ??= Promise.all([
    readFile(new URL('./render.mjs', import.meta.url)),
    readFile(new URL('../../theme/Mermaid/palette.mjs', import.meta.url)),
    readFile(require.resolve('@fontsource/noto-sans-sc/package.json')),
    readFile(path.resolve(path.dirname(require.resolve('@mermaid-js/mermaid-cli')), '../package.json')),
    readFile(require.resolve('mermaid/package.json')),
  ]).then(parts => createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
}

export async function closeRenderer() {
  clearTimeout(idleTimer);
  const current = browser;
  browser = undefined;
  await current?.close();
}

async function getRenderer() {
  if (browser?.connected) return browser;
  const {default: puppeteer} = await import('puppeteer');
  // GitHub-hosted Linux runners may disable unprivileged user namespaces; only CI needs the fallback flags.
  const args = process.env.CI ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  browser = await puppeteer.launch({headless: true, args});
  return browser;
}

function enqueue(task) {
  queuedCount += 1;
  clearTimeout(idleTimer);
  const result = queue.then(task);
  queue = result.catch(() => {}).finally(() => {
    queuedCount -= 1;
    if (!queuedCount) {
      idleTimer = setTimeout(() => {void closeRenderer();}, 1000);
    }
  });
  return result;
}

export function prepareSvg(markup, namespace) {
  const dom = new JSDOM(markup, {contentType: 'image/svg+xml'});
  try {
    const document = dom.window.document;
    const svg = document.documentElement;
    const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) {
      throw new Error('生成的 SVG 缺少有效尺寸');
    }
    preserveAuthoredLabelContrast(document);
    // Mermaid 的节点/箭头 ID 不一定包含图表 ID；全部命名空间化，避免同页多图冲突。
    const ids = new Map([...document.querySelectorAll('[id]')].map((el, index) => [el.id, `${namespace}-${index}`]));
    const replaceReferences = text => text.replace(/#([\w-]+)/g, (full, id) => ids.has(id) ? `#${ids.get(id)}` : full);
    for (const element of document.querySelectorAll('*')) {
      for (const attr of [...element.attributes]) {
        if (attr.name === 'id') element.setAttribute('id', ids.get(attr.value));
        else if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby') {
          element.setAttribute(attr.name, attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' '));
        } else if (['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'].includes(attr.name) || ((attr.name === 'href' || attr.name === 'xlink:href') && attr.value.startsWith('#'))) {
          element.setAttribute(attr.name, replaceReferences(attr.value));
        }
      }
      if (element.localName === 'style') element.textContent = replaceReferences(element.textContent);
    }
    const [, , width, height] = box;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;
    svg.style.maxWidth = 'none';
    return {svg: applyDiagramPalette(svg.outerHTML), width, height, diagramId: namespace};
  } finally {
    dom.window.close();
  }
}

async function generate(text, key, config) {
  const renderer = await getRenderer();
  const {renderMermaid} = await import('@mermaid-js/mermaid-cli');
  const css = await fontCSS();
  // CLI 在渲染前等待 document.fonts；提前注入与站点相同的本地中文字体。
  const fontAwareBrowser = {
    async newPage() {
      const page = await renderer.newPage();
      await page.evaluateOnNewDocument(fonts => {
        document.addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style');
          style.textContent = fonts;
          document.head.append(style);
        }, {once: true});
      }, css);
      return page;
    },
  };
  const diagramId = `diagram-${key.slice(0, 20)}`;
  const {data} = await renderMermaid(fontAwareBrowser, text, 'svg', {
    backgroundColor: 'transparent',
    svgId: diagramId,
    mermaidConfig: {
      ...config, startOnLoad: false, theme: 'base', securityLevel: 'strict',
      fontFamily, htmlLabels: false, deterministicIds: true, deterministicIDSeed: diagramId,
      flowchart: {...config.flowchart, htmlLabels: false},
      themeVariables: {...diagramPalette, fontFamily},
    },
  });
  return prepareSvg(Buffer.from(data).toString('utf8'), diagramId);
}

export async function renderDiagram(text, {cacheDir = defaultCacheDir, mermaidConfig = {}} = {}) {
  const key = createHash('sha256').update(await fingerprint()).update(JSON.stringify(mermaidConfig)).update(text).digest('hex');
  const filename = path.join(cacheDir, `${key}.json`);
  if (pending.has(filename)) return pending.get(filename);
  const task = (async () => {
    try {
      const cached = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof cached.svg === 'string' && cached.diagramId === `diagram-${key.slice(0, 20)}` && cached.width > 0 && cached.height > 0) return cached;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const diagram = await enqueue(() => generate(text, key, mermaidConfig));
    await mkdir(cacheDir, {recursive: true});
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(diagram));
    await rename(temporary, filename);
    return diagram;
  })();
  pending.set(filename, task);
  try {return await task;} finally {pending.delete(filename);}
}
