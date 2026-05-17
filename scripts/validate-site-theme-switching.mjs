import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const requiredMarkers = {
  'src/lib/siteTheme.ts': [
    'editorial',
    'signal',
    'archive',
    'DEFAULT_SITE_THEME',
    'SITE_THEME_STORAGE_KEY',
    'export const SITE_THEME_PRESETS',
    'SiteThemeId',
    'isSiteThemeId',
    'getInitialSiteTheme',
  ],
};

const missingFiles = [];
const missingMarkersByFile = [];

for (const [relativePath, markers] of Object.entries(requiredMarkers)) {
  const absolutePath = path.join(root, relativePath);

  if (!existsSync(absolutePath)) {
    missingFiles.push(relativePath);
    continue;
  }

  const fileContents = readFileSync(absolutePath, 'utf8');
  const missingMarkers = markers.filter((marker) => !fileContents.includes(marker));

  if (missingMarkers.length > 0) {
    missingMarkersByFile.push({relativePath, missingMarkers});
  }
}

if (missingFiles.length > 0 || missingMarkersByFile.length > 0) {
  console.error('Site theme switching contract failed.');

  if (missingFiles.length > 0) {
    console.error(`Missing files: ${missingFiles.join(', ')}`);
  }

  for (const {relativePath, missingMarkers} of missingMarkersByFile) {
    console.error(`Missing markers in ${relativePath}: ${missingMarkers.join(', ')}`);
  }

  process.exit(1);
}

console.log('Site theme switching contract passed.');
