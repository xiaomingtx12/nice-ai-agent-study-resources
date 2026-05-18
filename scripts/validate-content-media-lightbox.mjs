import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const rootComponentPath = path.join(root, 'src', 'theme', 'Root.tsx');
const lightboxComponentPath = path.join(
  root,
  'src',
  'components',
  'ContentMediaLightbox',
  'index.tsx',
);
const lightboxStylesPath = path.join(
  root,
  'src',
  'components',
  'ContentMediaLightbox',
  'styles.module.css',
);

const failures = [];

if (!existsSync(lightboxComponentPath)) {
  failures.push('Missing component: src/components/ContentMediaLightbox/index.tsx');
}

if (!existsSync(lightboxStylesPath)) {
  failures.push('Missing styles: src/components/ContentMediaLightbox/styles.module.css');
}

const rootComponent = readFileSync(rootComponentPath, 'utf8');

if (!rootComponent.includes('ContentMediaLightbox')) {
  failures.push('Root.tsx does not mount ContentMediaLightbox');
}

if (existsSync(lightboxComponentPath)) {
  const lightboxComponent = readFileSync(lightboxComponentPath, 'utf8');
  const requiredMarkers = [
    '.docusaurus-mermaid-container svg',
    'article img',
    'Escape',
    'dialog',
    'cloneNode(true)',
  ];

  for (const marker of requiredMarkers) {
    if (!lightboxComponent.includes(marker)) {
      failures.push(`ContentMediaLightbox missing marker: ${marker}`);
    }
  }
}

if (existsSync(lightboxStylesPath)) {
  const lightboxStyles = readFileSync(lightboxStylesPath, 'utf8');
  const requiredMarkers = ['overlay', 'contentImage', 'contentMermaid', 'cursor: zoom-in'];

  for (const marker of requiredMarkers) {
    if (!lightboxStyles.includes(marker)) {
      failures.push(`ContentMediaLightbox styles missing marker: ${marker}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Content media lightbox contract failed.');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Content media lightbox contract passed.');
