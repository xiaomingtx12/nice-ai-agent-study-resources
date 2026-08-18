import { readFileSync, writeFileSync } from 'fs';

const BASE = 'D:/repos/nice-ai-agent-study-resources/docs/application-notes/engineering/deepagents应用案例解析/openwiki';
const FILES = [
  '00-project-overview.md', '01-connectors-and-ingestion.md', '02-agent-assembly.md',
  '03-backend-and-permissions.md', '04-skills-planning-subagents.md', '05-middleware-lifecycle.md',
  '06-okf-and-mermaid-pipeline.md', '07-context-checkpoint-recovery.md',
  '08-model-provider-routing.md', '09-cli-credentials-and-operations.md', '10-runtime-and-testing.md',
];

// Chinese number pattern: 一、二、...十一、etc.
const CN_H = /^(一|二|三|四|五|六|七|八|九|十|十一|十二)、/;
const SUB_H = /^\d+\.\d+ /;

for (const file of FILES) {
  const path = `${BASE}/${file}`;
  let content = readFileSync(path, 'utf-8');
  let changed = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (CN_H.test(lines[i])) {
      lines[i] = '## ' + lines[i];
      changed = true;
    } else if (SUB_H.test(lines[i])) {
      lines[i] = '### ' + lines[i];
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(path, lines.join('\n'), 'utf-8');
    console.log(`FIXED ${file}`);
  } else {
    console.log(`SKIP  ${file}`);
  }
}
