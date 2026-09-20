import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {JSDOM} from 'jsdom';

test('server render reserves the complete viewer without browser globals or an SVG', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(output, {module, exports: module.exports, require(name) {
    if (name.endsWith('.css')) return new Proxy({}, {get: (_, key) => key});
    return require(name);
  }});
  const html = renderToString(React.createElement(module.exports.default, {result: null}));
  const dom = new JSDOM(html);
  try {
    assert.ok(dom.window.document.querySelector('[data-diagram-viewer]'));
    assert.ok(dom.window.document.querySelector('[aria-busy="true"]'));
    assert.equal(dom.window.document.querySelectorAll('button:disabled').length, 6);
    assert.equal(dom.window.document.querySelector('.docusaurus-mermaid-container'), null);
    assert.match(dom.window.document.body.textContent, /正在准备图表/);
  } finally {dom.window.close();}
});
