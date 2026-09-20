import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {applyDiagramPalette, preserveAuthoredLabelContrast} from './palette.ts';

const require = createRequire(import.meta.url);
const delay = () => new Promise(resolve => setTimeout(resolve, 20));

function harness(render) {
  const dom = new JSDOM('<div id="app"></div>', {url: 'http://localhost/'});
  const previous = {window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT};
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.requestIdleCallback = callback => setTimeout(callback, 0);
  const Mode = React.createContext('light');
  const options = {};
  const mermaid = {initialize() {}, render};
  let navigating = false;
  const navigationListeners = new Set();
  const source = readFileSync(process.env.MERMAID_TEST_SOURCE ?? new URL('./index.tsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true}}).outputText;
  const module = {exports: {}};
  vm.runInNewContext(compiled, {
    DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
    module, exports: module.exports, window: dom.window, document: dom.window.document, setTimeout,
    IntersectionObserver: class {
      constructor(callback) {this.callback = callback;}
      observe() {this.callback([{isIntersecting: true}]);}
      disconnect() {}
    },
    require(name) {
      // Viewer behavior is tested separately; this suite isolates rendering/cancellation.
      if (name === '../../components/DiagramViewer') return {__esModule: true, default: ({result}) => result ? React.createElement('div', {dangerouslySetInnerHTML: {__html: result.svg}}) : null};
      if (name === 'mermaid') return {__esModule: true, default: mermaid};
      if (name === '../../lib/routeTransition') return {subscribeToRouteTransition: listener => {navigationListeners.add(listener); return () => navigationListeners.delete(listener);}, isRouteTransitionPending: () => navigating, serverRouteTransitionSnapshot: () => false};
      if (name === './palette') return require('./palette.ts');
      if (name.endsWith('.css')) return {};
      if (name === '@docusaurus/ErrorBoundary') return {__esModule: true, default: ({children}) => children};
      if (name === '@docusaurus/theme-common') return {ErrorBoundaryErrorMessageFallback: () => null};
      if (name === '@docusaurus/theme-mermaid/client') return {
        MermaidContainerClassName: 'docusaurus-mermaid-container',
        useMermaidThemeConfig: () => ({options}),
        useMermaidConfig: () => {
          const mode = React.useContext(Mode);
          return React.useMemo(() => ({theme: mode === 'light' ? 'default' : 'forest'}), [mode]);
        },
      };
      return require(name);
    },
  });
  const Component = module.exports.default;
  const root = createRoot(dom.window.document.getElementById('app'));
  return {
    document: dom.window.document,
    async navigate(value) {await act(async () => {navigating = value; navigationListeners.forEach(listener => listener());}); await act(delay);},
    async show(mode, value = 'graph TD; A-->B') {
      await act(async () => {root.render(React.createElement(Mode.Provider, {value: mode}, React.createElement(Component, {value})));});
      await act(delay);
    },
    async close() {await act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, previous);},
  };
}

test('a mounted diagram keeps its SVG and performs no layout work when switching light/dark', async () => {
  let renders = 0;
  const h = harness(async id => {renders++; return {svg: '<svg id="' + id + '"><text>diagram</text></svg>'};});
  try {
    await h.show('light');
    const svg = h.document.querySelector('svg');
    assert.ok(svg);
    await h.show('dark');
    await h.show('light');
    assert.equal(renders, 1, 'switching mode must not invoke Mermaid again');
    assert.equal(h.document.querySelector('svg'), svg, 'mode change must preserve the displayed SVG');
  } finally {await h.close();}
});

test('temporary Mermaid measurement is outside article flow and removed after rendering', async () => {
  let host;
  const h = harness(async (id, text, container) => {
    host = container;
    assert.equal(container.style.position, 'fixed');
    assert.equal(container.style.visibility, 'hidden');
    assert.ok(container.isConnected);
    return {svg: '<svg><text>measured</text></svg>'};
  });
  try {
    await h.show('light');
    assert.equal(host.isConnected, false);
    assert.equal(h.document.querySelector('text').textContent, 'measured');
  } finally {await h.close();}
});

test('an obsolete in-flight render cannot replace the current diagram', async () => {
  const pending = [];
  const h = harness((id, text) => new Promise(resolve => pending.push({text, resolve: () => resolve({svg: '<svg><text>' + text + '</text></svg>'})})));
  try {
    await h.show('light', 'old');
    assert.equal(pending.length, 1);
    await h.show('light', 'new');
    await act(async () => {pending[0].resolve(); await delay();});
    assert.equal(h.document.querySelector('svg'), null, 'cancelled output must never be committed');
    assert.equal(pending[1].text, 'new');
    await act(async () => {pending[1].resolve(); await delay();});
    assert.equal(h.document.querySelector('text').textContent, 'new');
  } finally {await h.close();}
});

test('palette conversion touches SVG paint only, preserving labels, IDs and authored semantic colors', () => {
  const svg = '<svg id="diagram"><style>.node{fill:#f5efdf;stroke:#B5AD98}.error{fill:#ff0000!important}</style><rect fill="#f5efdf"/><text>#f5efdf</text><a href="#f5efdf">label</a></svg>';
  const converted = applyDiagramPalette(svg);
  assert.match(converted, /fill:var\(--site-surface-strong, #f5efdf\)/);
  assert.match(converted, /stroke:var\(--site-border-strong, #B5AD98\)/);
  assert.ok(converted.includes('<rect fill="var(--site-surface-strong, #f5efdf)"/>'));
  assert.ok(converted.includes('<text>#f5efdf</text>'));
  assert.ok(converted.includes('href="#f5efdf"'));
  assert.ok(converted.includes('.error{fill:#ff0000!important}'));
});


test('authored light and dark node fills retain readable labels in either site mode', () => {
  const dom = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><g class="cluster"><rect style="fill:#fff3e0!important"/><g class="cluster-label"><text>light panel</text></g><g class="node"><rect/><g class="label"><text>themed child</text></g></g></g><g class="node"><path style="fill:#123"/><g class="label"><text>dark panel</text></g></g></svg>', {contentType: 'image/svg+xml'});
  try {
    preserveAuthoredLabelContrast(dom.window.document);
    assert.equal(dom.window.document.querySelector('.cluster-label').style.getPropertyValue('--site-text'), '#000000');
    assert.equal(dom.window.document.querySelector('.cluster .node .label').style.getPropertyValue('--site-text'), '');
    assert.equal(dom.window.document.querySelector('svg > .node .label').style.getPropertyValue('--site-text'), '#ffffff');
    assert.equal(dom.window.document.querySelector('.cluster > rect').getAttribute('style'), 'fill:#fff3e0!important');
  } finally {dom.window.close();}
});


test('navigation cancels old diagram work and allows it to resume only when navigation ends', async () => {
  const pending = [];
  const h = harness((id) => new Promise(resolve => pending.push(() => resolve({svg: '<svg><text>ready</text></svg>'}))));
  try {
    await h.show('light');
    assert.equal(pending.length, 1);
    await h.navigate(true);
    await act(async () => {pending[0](); await delay();});
    assert.equal(h.document.querySelector('svg'), null);
    await h.navigate(false);
    assert.equal(pending.length, 2);
    await act(async () => {pending[1](); await delay();});
    assert.equal(h.document.querySelector('text').textContent, 'ready');
  } finally {await h.close();}
});
