import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = process.cwd();

const files = [
  'docs/resources/agentic-design-patterns/index.md',
  'docs/resources/agentic-design-patterns/review.md',
  'docs/resources/agentic-design-patterns/notes/index.md',
];

for (const file of files) {
  assert.ok(existsSync(join(root, file)), `${file} should exist`);
}

const sidebar = readFileSync(join(root, 'sidebars.ts'), 'utf8');
const resourcesIndex = readFileSync(join(root, 'docs/resources/index.md'), 'utf8');
const overview = readFileSync(
  join(root, 'docs/resources/agentic-design-patterns/index.md'),
  'utf8',
);

for (const marker of [
  "'Agentic Design Patterns'",
  "'resources/agentic-design-patterns/index'",
  "'resources/agentic-design-patterns/review'",
  "'resources/agentic-design-patterns/notes/index'",
]) {
  assert.match(sidebar, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const marker of [
  'Agentic Design Patterns',
  './agentic-design-patterns/',
  'https://adp.xindoo.xyz/',
]) {
  assert.match(resourcesIndex, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const marker of [
  '官网：[https://adp.xindoo.xyz/](https://adp.xindoo.xyz/)',
  '项目仓库：[https://github.com/xindoo/agentic-design-patterns](https://github.com/xindoo/agentic-design-patterns)',
]) {
  assert.match(overview, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

console.log('Agentic Design Patterns resource contract passed.');
