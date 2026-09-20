import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {normalizeTokens} from 'prism-react-renderer';
import {renderTokenMarkup} from './tokenMarkup.ts';

test('plain text uses no token spans and keeps blank lines, Unicode, and significant spaces', () => {
  const code = '  中文 <tag> & "quoted"\n\n  next';
  const dom = new JSDOM('<pre><code>' + renderTokenMarkup(normalizeTokens([code]), {}, false) + '</code></pre>');
  try {
    assert.equal([...dom.window.document.querySelectorAll('.token-line')].map(line => line.textContent).join('\n'), code);
    assert.equal(dom.window.document.querySelectorAll('span').length, 0);
  } finally {dom.window.close();}
});

test('source code, token names and highlight classes cannot inject markup or attributes', () => {
  const dangerous = '\"><img src=x onerror=alert(1)>';
  const html = renderTokenMarkup([[{types: ['string', dangerous], content: dangerous}]], {0: dangerous}, true);
  const dom = new JSDOM('<pre><code>' + html + '</code></pre>');
  try {
    assert.equal(dom.window.document.querySelectorAll('img,script,[onerror]').length, 0);
    assert.equal(dom.window.document.querySelector('.site-code-line-content').textContent, dangerous);
    assert.ok(dom.window.document.querySelector('.site-code-line-number[aria-hidden="true"]'));
  } finally {dom.window.close();}
});
