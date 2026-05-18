import {copyFileSync, existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');
const root = process.cwd();
const buildDir = path.join(root, 'build');
const staticDir = path.join(root, 'static');
const searchIndexPattern = /^search-index.*\.json$/;

if (!existsSync(buildDir)) {
  if (strict) {
    console.error('Build directory is missing. Run npm run build first.');
    process.exit(1);
  }

  console.warn('Skipping dev search index sync because build/ is missing.');
  process.exit(0);
}

const buildSearchIndexes = readdirSync(buildDir).filter((file) => searchIndexPattern.test(file));

if (buildSearchIndexes.length === 0) {
  if (strict) {
    console.error('No search index files found under build/.');
    process.exit(1);
  }

  console.warn('Skipping dev search index sync because no search index files were found.');
  process.exit(0);
}

mkdirSync(staticDir, {recursive: true});

for (const file of readdirSync(staticDir).filter((entry) => searchIndexPattern.test(entry))) {
  rmSync(path.join(staticDir, file));
}

for (const file of buildSearchIndexes) {
  copyFileSync(path.join(buildDir, file), path.join(staticDir, file));
}

console.log(`Synced ${buildSearchIndexes.length} search index file(s) into static/.`);
