import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const requiredMarkers = {
  'src/lib/siteTheme.ts': [
    'editorial',
    'signal',
    'archive',
    '米白主题',
    '蓝灰主题',
    '灰绿主题',
    'DEFAULT_SITE_THEME',
    'SITE_THEME_STORAGE_KEY',
    'export const SITE_THEME_PRESETS',
    'SiteThemeId',
    'isSiteThemeId',
    'getInitialSiteTheme',
  ],
  'src/components/SiteThemeProvider/index.tsx': [
    'createContext',
    'useSiteTheme',
    'document.documentElement.setAttribute',
    'SITE_THEME_STORAGE_KEY',
    'try',
    'catch',
  ],
  'src/theme/Root.tsx': [
    'SiteThemeProvider',
    'children',
  ],
  'docusaurus.config.ts': [
    'headTags',
    'data-site-theme',
    'SITE_THEME_STORAGE_KEY',
    'DEFAULT_SITE_THEME',
    'SITE_THEME_PRESETS',
    "type: 'custom-siteThemePreset'",
    "position: 'right'",
  ],
  'src/theme/NavbarItem/ComponentTypes.js': [
    'custom-siteThemePreset',
    'ThemePresetToggle',
  ],
  'src/components/ThemePresetToggle/index.tsx': [
    'useSiteTheme',
    'SITE_THEME_PRESETS',
    'setTheme',
    'aria-expanded',
    'desktopPopover',
    'mobileTray',
    '切换主题',
    '主题样式',
  ],
  'src/components/ThemePresetToggle/styles.module.css': [
    '.desktopTrigger',
    '.desktopPopover',
    '.panelTitle',
    '.optionButton',
    '.palettePreview',
    '.mobileTrigger',
    '.mobileTray',
  ],
  'src/css/custom.css': [
    '--site-bg',
    '--site-surface',
    '--site-text',
    '--site-border',
    '--site-accent',
    "html[data-site-theme='editorial']",
    "html[data-site-theme='signal']",
    "html[data-site-theme='archive']",
    "html[data-theme='dark']",
    "html[data-site-theme='editorial'][data-theme='dark']",
    "html[data-site-theme='signal'][data-theme='dark']",
    "html[data-site-theme='archive'][data-theme='dark']",
    '--ifm-navbar-search-input-background-color',
    '--ifm-navbar-search-input-color',
    '--ifm-navbar-search-input-placeholder-color',
    '--search-local-modal-background',
    '--search-local-hit-background',
    '.navbar__search-input',
    '--ifm-background-color',
    '--ifm-color-primary',
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
