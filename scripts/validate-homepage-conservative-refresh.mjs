import {readFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const homepagePath = path.join(root, 'docs', 'index.md');
const cssPath = path.join(root, 'src', 'css', 'custom.css');

const homepage = readFileSync(homepagePath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

const homepageMarkers = [
  'class="home-lead"',
  'class="home-route-list"',
  'class="home-library-groups"',
  'class="home-principles"',
  '## 你现在该去哪',
  '## 当前收录怎么分',
  '## 这个站怎么写',
];

const cssMarkers = [
  ".home-lead",
  ".home-route-list",
  ".home-library-groups",
  ".home-principles",
];

const missingHomepageMarkers = homepageMarkers.filter((marker) => !homepage.includes(marker));
const missingCssMarkers = cssMarkers.filter((marker) => !css.includes(marker));

if (missingHomepageMarkers.length > 0 || missingCssMarkers.length > 0) {
  console.error('Homepage conservative refresh contract failed.');

  if (missingHomepageMarkers.length > 0) {
    console.error(`Missing homepage markers: ${missingHomepageMarkers.join(', ')}`);
  }

  if (missingCssMarkers.length > 0) {
    console.error(`Missing CSS markers: ${missingCssMarkers.join(', ')}`);
  }

  process.exit(1);
}

console.log('Homepage conservative refresh contract passed.');
