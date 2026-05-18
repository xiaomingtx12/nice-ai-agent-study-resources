export const SITE_THEME_PRESETS = [
  {id: 'editorial', label: '米白主题'},
  {id: 'signal', label: '蓝灰主题'},
  {id: 'archive', label: '灰绿主题'},
] as const;

export type SiteThemeId = (typeof SITE_THEME_PRESETS)[number]['id'];

export const DEFAULT_SITE_THEME: SiteThemeId = 'editorial';
export const SITE_THEME_STORAGE_KEY = 'nice-ai-site-theme';

export function isSiteThemeId(value: unknown): value is SiteThemeId {
  return SITE_THEME_PRESETS.some((preset) => preset.id === value);
}

export function getInitialSiteTheme(value: unknown): SiteThemeId {
  return isSiteThemeId(value) ? value : DEFAULT_SITE_THEME;
}
