import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = process.cwd();

for (const file of [
  'docs/resources/codex-guide/index.md',
  'docs/resources/codex-guide/review.md',
  'docs/resources/codex-guide/notes/index.md',
  'docs/resources/codex-guide/notes/why-i-see-it-as-a-codex-practice-guide.md',
]) {
  assert.ok(existsSync(join(root, file)), `${file} should exist`);
}

const sidebar = readFileSync(join(root, 'sidebars.ts'), 'utf8');
const resourcesIndex = readFileSync(join(root, 'docs/resources/index.md'), 'utf8');
const overview = readFileSync(join(root, 'docs/resources/codex-guide/index.md'), 'utf8');

for (const marker of [
  "'CodexGuide'",
  "'resources/codex-guide/index'",
  "'resources/codex-guide/review'",
  "'resources/codex-guide/notes/index'",
  "'resources/codex-guide/notes/why-i-see-it-as-a-codex-practice-guide'",
]) {
  assert.match(sidebar, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const marker of [
  'CodexGuide',
  'https://codexguide.ai/',
  'https://github.com/freestylefly/CodexGuide',
]) {
  assert.match(resourcesIndex, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

for (const marker of [
  '官网：[https://codexguide.ai/](https://codexguide.ai/)',
  '项目仓库：[https://github.com/freestylefly/CodexGuide](https://github.com/freestylefly/CodexGuide)',
]) {
  assert.match(overview, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

console.log('CodexGuide resource contract passed.');
