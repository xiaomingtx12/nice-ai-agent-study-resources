import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';

const require = createRequire(import.meta.url);
test('nested sidebar state survives rapid collapse without height measurement or stale animation jobs', async () => {
  const dom = new JSDOM('<div id="app"></div>');
  const previous = {window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT};
  Object.assign(globalThis, {window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true});
  let measurements = 0;
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {get() {measurements++; return 2000;}});
  const source = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(js, {module, exports: module.exports, require});
  const Branch = module.exports.default;
  let mounts = 0;
  function Nested() {
    const [closed, setClosed] = useState(true);
    React.useEffect(() => {mounts++;}, []);
    return React.createElement('li', null,
      React.createElement('button', {onClick: () => setClosed(!closed)}, 'nested'),
      React.createElement(Branch, {collapsed: closed}, React.createElement('li', null, 'leaf')));
  }
  const root = createRoot(document.getElementById('app'));
  const show = async closed => act(async () => root.render(React.createElement(Branch, {collapsed: closed}, React.createElement(Nested))));
  try {
    await show(true); assert.equal(mounts, 0);
    await show(false); assert.equal(mounts, 1);
    await act(async () => document.querySelector('button').click());
    for (let i = 0; i < 5; i++) {await show(true); assert.equal(document.querySelector('ul').hidden, true); await show(false);}
    assert.equal(mounts, 1, 'closing a parent must preserve its descendant state');
    assert.ok([...document.querySelectorAll('ul')].every(list => !list.hidden));
    assert.equal(measurements, 0, 'large branches must not force scrollHeight layout');
    assert.equal(document.querySelector('[style*="height"]'), null);
  } finally {await act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, previous);}
});
