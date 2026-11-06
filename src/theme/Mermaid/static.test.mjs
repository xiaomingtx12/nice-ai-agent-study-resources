import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url);
const imported = [];
function loadComponent(file) {
  const source = readFileSync(file, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(output, {module, exports: module.exports, require(name) {
    imported.push(name);
    if (name.endsWith('.css')) return new Proxy({}, {get: (_, key) => key});
    if (name === '../../components/DiagramViewer') return {__esModule: true, default: loadComponent(new URL('../../components/DiagramViewer/index.tsx', import.meta.url))};
    if (name === '@docusaurus/ErrorBoundary') return {__esModule: true, default: ({children}) => children};
    if (name === '@docusaurus/theme-common') return {ErrorBoundaryErrorMessageFallback: () => null};
    if (name === '@docusaurus/theme-mermaid/client') return {useMermaidThemeConfig: () => ({options: {}})};
    if (name === '../../lib/routeTransition') return {};
    if (name === './palette') return {};
    return require(name);
  }});
  return module.exports.default;
}

test('prebuilt diagrams are present in initial HTML without DOM APIs or Mermaid runtime', () => {
  imported.length = 0;
  const Mermaid = loadComponent(new URL('./index.tsx', import.meta.url));
  const props = {diagramId: 'diagram-fixture', width: '300', height: '150', svg: '<svg xmlns="http://www.w3.org/2000/svg" id="diagram-fixture-0" viewBox="0 0 300 150"><defs><marker id="diagram-fixture-arrow"/></defs><path marker-end="url(#diagram-fixture-arrow)"/><text>工程判断</text></svg>'};
  const html = renderToString(React.createElement(React.Fragment, null, React.createElement(Mermaid, props), React.createElement(Mermaid, props)));
  const dom = new JSDOM(html);
  try {
    assert.equal(dom.window.document.querySelectorAll('.docusaurus-mermaid-container svg').length, 2);
    assert.ok(!html.includes('正在准备图表'));
    const ids = [...dom.window.document.querySelectorAll('[id]')].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length, 'repeated diagrams must have independent IDs');
    for (const svg of dom.window.document.querySelectorAll('.docusaurus-mermaid-container svg')) {
      assert.ok(svg.querySelector('path').getAttribute('marker-end').includes(svg.querySelector('marker').id));
    }
    assert.ok(!imported.some(name => name === 'mermaid' || name.includes('theme-mermaid/client')), 'reader must not load the layout engine');
  } finally {dom.window.close();}
});
