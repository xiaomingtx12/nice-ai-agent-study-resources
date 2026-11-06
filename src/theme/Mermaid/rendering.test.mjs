import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {applyDiagramPalette, preserveAuthoredLabelContrast} from './palette.mjs';

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
