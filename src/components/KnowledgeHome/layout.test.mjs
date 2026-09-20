import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import postcss from 'postcss';
import {JSDOM} from 'jsdom';

// Helmet can update before the concurrent article commit. The old page must stay styled.
test('pending document metadata cannot restyle the displayed homepage', () => {
  const dom = new JSDOM('<html data-site-theme="editorial" class="docs-doc-id-index"><body><main class="docMainContainer"><div class="container"><div class="row"><div class="col"><article><div class="theme-doc-markdown"><div class="knowledge-home"><h1>Home</h1><h2>Readings</h2><p class="home-hero-meta">Stats</p><a>Read</a></div></div></article></div></div></div></main></body></html>');
  const rules = [];
  for (const file of ['../../css/custom.css', '../../css/theme-presets.css', './styles.css']) {
    postcss.parse(readFileSync(new URL(file, import.meta.url), 'utf8')).walkRules(rule => {
      if (rule.parent.type === 'atrule' && rule.parent.name.endsWith('keyframes')) return;
      rules.push(rule);
    });
  }
  const root = dom.window.document.createElement('div');
  root.className = 'docRoot_test';
  dom.window.document.body.append(root);
  root.append(dom.window.document.querySelector('main'));
  const elements = [root, ...dom.window.document.querySelectorAll('main, main *')];
  const matched = () => elements.map(element => rules.filter(rule => {
    try {return element.matches(rule.selector);} catch {return false;}
  }).map(rule => rule.toString()));
  try {
    const before = matched();
    dom.window.document.documentElement.className = 'docs-doc-id-resources/index';
    assert.deepEqual(matched(), before, 'pending metadata must not change styles on the old homepage');
  } finally {dom.window.close();}
});
