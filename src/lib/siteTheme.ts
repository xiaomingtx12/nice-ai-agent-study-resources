export const SITE_THEME_PRESETS = [
  {id: 'editorial', label: '纸上书房', description: '暖纸底色 · 深金点缀'},
  {id: 'ivory', label: '清晰文档', description: '冷白底色 · 靛蓝点缀'},
  {id: 'signal', label: '工程手册', description: '青灰底色 · 湖蓝点缀'},
  {id: 'archive', label: '知识索引', description: '灰绿底色 · 松绿点缀'},
  {id: 'classic', label: '极简黑白', description: '中性黑白 · 克制对比'},
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
