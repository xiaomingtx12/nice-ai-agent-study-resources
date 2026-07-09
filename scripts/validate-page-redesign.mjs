import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();

const requiredMarkers = {
  'sidebars.ts': [
    '学习地图与路径',
    'Harness / Coding Agent',
    '架构与生产化',
    '源码与真实系统',
    'Dify 架构拆解（v1.15.0）',
    'Claude Code CLI 架构拆解',
    "'resources/hello-agents/index'",
    "'resources/learn-claude-code/index'",
    "'application-notes/dify/index'",
    "'application-notes/claude-code-cli/index'",
    "'notes/index'",
    "'templates/index'",
  ],
};

const forbiddenMarkers = {
  'sidebars.ts': ["label: '应用沉淀文档'", "label: '流程文档'"],
};

for (const [relativePath, markers] of Object.entries(requiredMarkers)) {
  const absolutePath = join(root, relativePath);
  const content = readFileSync(absolutePath, 'utf8');

  for (const marker of markers) {
    assert.match(
      content,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${relativePath} is missing marker: ${marker}`,
    );
  }
}

for (const [relativePath, markers] of Object.entries(forbiddenMarkers)) {
  const absolutePath = join(root, relativePath);
  const content = readFileSync(absolutePath, 'utf8');

  for (const marker of markers) {
    assert.doesNotMatch(
      content,
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${relativePath} should not contain marker: ${marker}`,
    );
  }
}

console.log('Page redesign content contract passed.');
