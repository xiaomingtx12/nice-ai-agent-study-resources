import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const configPath = path.join(root, 'docusaurus.config.ts');
const gitignorePath = path.join(root, '.gitignore');
const packageJsonPath = path.join(root, 'package.json');
const workflowPath = path.join(root, '.github', 'workflows', 'deploy-docusaurus.yml');
const buildSearchIndexPath = path.join(root, 'build', 'search-index.json');
const staticSearchIndexPath = path.join(root, 'static', 'search-index.json');
const searchSyncScriptPath = path.join(root, 'scripts', 'sync-dev-search-index.mjs');
const searchRuntimePath = path.join(root, 'src', 'lib', 'search', 'searchByWorker.js');
const searchBarPath = path.join(root, 'src', 'theme', 'SearchBar', 'index.js');
const searchPagePath = path.join(root, 'src', 'theme', 'SearchPage', 'index.js');

const config = readFileSync(configPath, 'utf8');
const gitignore = readFileSync(gitignorePath, 'utf8');
const packageJson = readFileSync(packageJsonPath, 'utf8');
const workflow = readFileSync(workflowPath, 'utf8');
const searchBar = readFileSync(searchBarPath, 'utf8');
const searchPage = readFileSync(searchPagePath, 'utf8');

const requiredConfigMarkers = [
  'SITE_BASE_URL',
  "baseUrl: siteBaseUrl",
  "docsRouteBasePath: ['/']",
  "require.resolve('@easyops-cn/docusaurus-search-local')",
];

const requiredWorkflowMarkers = [
  'SITE_BASE_URL: /nice-ai-agent-study-resources/',
  'npm run build',
];

const requiredGitignoreMarkers = ['static/search-index*.json'];

const requiredPackageMarkers = [
  '"prestart": "npm run build"',
  '"postbuild": "node scripts/sync-dev-search-index.mjs --strict"',
];

const requiredSearchBarMarkers = [
  "../../lib/search/searchByWorker",
  '开发模式搜索索引未准备好',
];

const requiredSearchPageMarkers = [
  "../../lib/search/searchByWorker",
  '开发模式搜索索引未准备好',
];

const missingConfigMarkers = requiredConfigMarkers.filter((marker) => !config.includes(marker));
const missingGitignoreMarkers = requiredGitignoreMarkers.filter(
  (marker) => !gitignore.includes(marker),
);
const missingPackageMarkers = requiredPackageMarkers.filter(
  (marker) => !packageJson.includes(marker),
);
const missingWorkflowMarkers = requiredWorkflowMarkers.filter((marker) => !workflow.includes(marker));
const missingSearchBarMarkers = requiredSearchBarMarkers.filter(
  (marker) => !searchBar.includes(marker),
);
const missingSearchPageMarkers = requiredSearchPageMarkers.filter(
  (marker) => !searchPage.includes(marker),
);
const missingBuildSearchIndex = !existsSync(buildSearchIndexPath);
const missingStaticSearchIndex = !existsSync(staticSearchIndexPath);
const missingSearchSyncScript = !existsSync(searchSyncScriptPath);
const missingSearchRuntime = !existsSync(searchRuntimePath);

if (
  missingConfigMarkers.length > 0 ||
  missingGitignoreMarkers.length > 0 ||
  missingPackageMarkers.length > 0 ||
  missingWorkflowMarkers.length > 0 ||
  missingSearchBarMarkers.length > 0 ||
  missingSearchPageMarkers.length > 0 ||
  missingBuildSearchIndex ||
  missingStaticSearchIndex ||
  missingSearchSyncScript ||
  missingSearchRuntime
) {
  console.error('Search functionality contract failed.');

  if (missingConfigMarkers.length > 0) {
    console.error(`Missing config markers: ${missingConfigMarkers.join(', ')}`);
  }

  if (missingGitignoreMarkers.length > 0) {
    console.error(`Missing gitignore markers: ${missingGitignoreMarkers.join(', ')}`);
  }

  if (missingPackageMarkers.length > 0) {
    console.error(`Missing package markers: ${missingPackageMarkers.join(', ')}`);
  }

  if (missingWorkflowMarkers.length > 0) {
    console.error(`Missing workflow markers: ${missingWorkflowMarkers.join(', ')}`);
  }

  if (missingSearchBarMarkers.length > 0) {
    console.error(`Missing search bar markers: ${missingSearchBarMarkers.join(', ')}`);
  }

  if (missingSearchPageMarkers.length > 0) {
    console.error(`Missing search page markers: ${missingSearchPageMarkers.join(', ')}`);
  }

  if (missingBuildSearchIndex) {
    console.error('Missing build artifact: build/search-index.json');
  }

  if (missingStaticSearchIndex) {
    console.error('Missing static artifact: static/search-index.json');
  }

  if (missingSearchSyncScript) {
    console.error('Missing script: scripts/sync-dev-search-index.mjs');
  }

  if (missingSearchRuntime) {
    console.error('Missing runtime: src/lib/search/searchByWorker.js');
  }

  process.exit(1);
}

console.log('Search functionality contract passed.');
