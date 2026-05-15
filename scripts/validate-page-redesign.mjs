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
    '写作说明',
    'Dify 型应用',
    '准备文档',
    '历史备份',
    '模板',
    "'HelloAgents'",
    "'resources/hello-agents/review'",
    "'resources/hello-agents/notes/index'",
    "'Learn Claude Code'",
    "'resources/learn-claude-code/review'",
    "'resources/learn-claude-code/notes/index'",
    "'application-notes/dify-type-application/index'",
    "'application-notes/dify准备文档/项目中的 LangChain 具体实现详解'",
    "'application-notes/diyf-type-application-bac/index'",
    "'templates/index'",
    "'templates/resource-note-template'",
  ],
  'docs/application-notes/dify准备文档/_category_.json': ['准备文档'],
  'docs/application-notes/diyf-type-application-bac/_category_.json': ['历史备份'],
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
