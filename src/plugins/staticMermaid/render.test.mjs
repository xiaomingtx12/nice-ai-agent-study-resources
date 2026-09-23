import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {compile, run} from '@mdx-js/mdx';
import * as jsxRuntime from 'react/jsx-runtime';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {JSDOM} from 'jsdom';
import staticMermaid from './index.cjs';
import {closeRenderer, prepareSvg, renderDiagram} from './render.mjs';

const require = createRequire(import.meta.url);
const docusaurusMermaid = require('@docusaurus/mdx-loader/lib/remark/mermaid/index.js').default;
const {createProcessorUncached} = require('@docusaurus/mdx-loader/lib/processor.js');
const {DEFAULT_MARKDOWN_CONFIG} = require('@docusaurus/core/lib/server/configValidation.js');

test('generated SVG preserves paint and text while isolating IDs and references', () => {
  const result = prepareSvg('<svg xmlns="http://www.w3.org/2000/svg" id="chart" viewBox="0 0 200 100" aria-labelledby="title"><title id="title">chart</title><style>#chart .node{fill:#f5efdf}</style><defs><marker id="arrow"/></defs><g class="node" id="A"><rect style="fill:#123"/><g class="label"><text>chart #arrow</text></g></g><path marker-end="url(#arrow)"/><a href="https://example.com/#arrow">link</a></svg>', 'diagram-test');
  assert.equal(result.width, 200);
  assert.equal(result.height, 100);
  assert.match(result.svg, /var\(--site-surface-strong/);
  assert.match(result.svg, /--site-text: #ffffff/);
  assert.match(result.svg, /chart #arrow/);
  assert.match(result.svg, /https:\/\/example.com\/#arrow/);
  const dom = new JSDOM(result.svg, {contentType: 'image/svg+xml'});
  try {
    const doc = dom.window.document;
    assert.equal(doc.documentElement.getAttribute('aria-labelledby'), doc.querySelector('title').id);
    assert.equal(doc.querySelector('path').getAttribute('marker-end'), `url(#${doc.querySelector('marker').id})`);
  } finally {dom.window.close();}
});

test('real Mermaid compilation emits static SVG props, caches unchanged content, and reports source errors', {timeout: 120000}, async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'nice-static-mermaid-'));
  const text = 'flowchart LR\n  A[学习资料] --> B[工程判断]\n  style B fill:#123,color:#fff';
  try {
    const diagram = await renderDiagram(text, {cacheDir});
    assert.match(diagram.svg, /学习资料/);
    assert.match(diagram.svg, /工程判断/);
    assert.match(diagram.svg, /Noto Sans SC/);
    assert.ok(diagram.width > 0 && diagram.height > 0);
    const [cacheName] = await readdir(cacheDir);
    const before = await stat(path.join(cacheDir, cacheName));
    await closeRenderer();
    assert.deepEqual(await renderDiagram(text, {cacheDir}), diagram);
    assert.equal((await stat(path.join(cacheDir, cacheName))).mtimeMs, before.mtimeMs);

    const markdown = '# 测试\n\n```mermaid\n' + text + '\n```\n\n> ```mermaid\n> sequenceDiagram\n>   读者->>站点: 阅读图表\n> ```\n';
    const compiled = await compile({value: markdown, path: 'fixture.mdx'}, {
      remarkPlugins: [[staticMermaid, {cacheDir}], docusaurusMermaid],
      outputFormat: 'function-body',
    });
    const {default: Content} = await run(compiled, {...jsxRuntime, baseUrl: import.meta.url});
    const propsSeen = [];
    const html = renderToString(React.createElement(Content, {components: {mermaid: props => {
      propsSeen.push(props);
      return React.createElement('div', {dangerouslySetInnerHTML: {__html: props.svg}});
    }}}));
    assert.equal(propsSeen.length, 2);
    assert.ok(propsSeen.every(props => typeof props.diagramId === 'string' && props.width > 0 && props.height > 0 && props.value === undefined));
    assert.match(html, /学习资料/);
    assert.match(html, /阅读图表/);
    assert.ok(!String(compiled).includes('flowchart LR'));

    // 走站点实际的 Markdown 插件顺序，覆盖 .md 的 rehype-raw 和 .mdx。
    for (const format of ['md', 'mdx']) {
      const processor = await createProcessorUncached({format, options: {
        siteDir: process.cwd(), staticDirs: [],
        markdownConfig: {...DEFAULT_MARKDOWN_CONFIG, mermaid: true},
        beforeDefaultRemarkPlugins: [[staticMermaid, {cacheDir}]],
      }});
      const output = await processor.process({content: markdown, filePath: path.join(cacheDir, `fixture.${format}`), frontMatter: {}, compilerName: 'client'});
      assert.match(output.content, /diagramId:/);
      assert.match(output.content, /svg:/);
      assert.ok(!output.content.includes('flowchart LR'));
    }

    await assert.rejects(compile({value: '# Broken\n\n```mermaid\nnot-a-diagram\n```', path: 'broken.mdx'}, {remarkPlugins: [[staticMermaid, {cacheDir}]]}), error => {
      assert.match(error.message, /Mermaid 预渲染失败/);
      assert.equal(error.line, 3);
      return true;
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(cacheDir, cacheName), 'utf8')), diagram);
  } finally {
    await closeRenderer();
    await rm(cacheDir, {recursive: true, force: true});
  }
});
