import {readdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = process.cwd();
const staticDir = path.join(root, 'static');
const searchIndexPattern = /^search-index.*\.json$/;

function hasDevSearchIndex() {
  if (!existsSync(staticDir)) {
    return false;
  }

  return readdirSync(staticDir).some((entry) => searchIndexPattern.test(entry));
}

if (hasDevSearchIndex()) {
  console.log('[prestart] 搜索索引已存在，跳过构建。如需刷新：npm run build');
  process.exit(0);
}

console.log('[prestart] 搜索索引缺失，执行完整构建以生成索引...');

const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.error('[prestart] 构建失败，搜索索引未生成。');
  process.exit(result.status ?? 1);
}
