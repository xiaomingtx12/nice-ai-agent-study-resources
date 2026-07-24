import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import {
  DEFAULT_SITE_THEME,
  SITE_THEME_PRESETS,
  SITE_THEME_STORAGE_KEY,
} from './src/lib/siteTheme';

const siteBaseUrl = process.env.SITE_BASE_URL ?? '/';
const siteThemeIds = SITE_THEME_PRESETS.map((preset) => preset.id);
const siteThemeBootstrapScript = `(function(){try{var storageKey=${JSON.stringify(
  SITE_THEME_STORAGE_KEY,
)};var defaultTheme=${JSON.stringify(
  DEFAULT_SITE_THEME,
)};var theme=window.localStorage.getItem(storageKey);if(!${JSON.stringify(
  siteThemeIds,
)}.includes(theme)){theme=defaultTheme;}document.documentElement.setAttribute('data-site-theme',theme);}catch(error){document.documentElement.setAttribute('data-site-theme',${JSON.stringify(
  DEFAULT_SITE_THEME,
)});}})()`;

const config: Config = {
  title: 'Nice AI 学习沉淀',
  tagline: '资源导航、应用拆解与方法复盘',
  url: 'https://xiaomingtx12.github.io',
  baseUrl: siteBaseUrl,
  headTags: [
    {
      tagName: 'script',
      attributes: {},
      innerHTML: siteThemeBootstrapScript,
    },
  ],

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  organizationName: 'xiaomingtx12',
  projectName: 'nice-ai-agent-study-resources',

  favicon: 'img/favicon.svg',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/xiaomingtx12/nice-ai-agent-study-resources/edit/main/',
          showLastUpdateAuthor: true,
          showLastUpdateTime: true,
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],

  plugins: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        language: ['zh', 'en'],
        indexBlog: false,
        docsRouteBasePath: ['/'],
      },
    ],
    function stubLayoutElkPlugin() {
      return {
        name: 'stub-layout-elk',
        configureWebpack() {
          return {
            resolve: {
              alias: {
                '@mermaid-js/layout-elk': require.resolve('./src/lib/layoutElkStub'),
              },
            },
          };
        },
      };
    },
    function stubKatexPlugin() {
      return {
        name: 'stub-katex',
        configureWebpack() {
          return {
            resolve: {
              alias: {
                katex: require.resolve('./src/lib/katexStub'),
              },
            },
          };
        },
      };
    },
  ],

  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    image: 'img/social-card.png',
    metadata: [
      {name: 'description', content: '把优秀学习资源和真实开源项目，变成人能复用、AI 能调用的工程判断。人定方向，AI 铺广度，人验真伪。'},
      {name: 'keywords', content: 'AI Agent, Claude Code, Dify, LLM, 学习沉淀, 工程判断, 资源导航'},
      {property: 'og:title', content: 'Nice AI 学习沉淀'},
      {property: 'og:description', content: '把优秀学习资源和真实开源项目，变成人能复用、AI 能调用的工程判断。'},
      {property: 'og:type', content: 'website'},
      {property: 'og:locale', content: 'zh_CN'},
      {name: 'twitter:card', content: 'summary_large_image'},
    ],
    navbar: {
      title: 'Nice AI',
      logo: {
        alt: 'Nice AI',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
        width: 32,
        height: 32,
      },
      items: [
        {
          to: '/',
          label: '首页',
          position: 'left',
          activeBaseRegex: '^/$',
        },
        {
          to: '/resources',
          label: '资源导航',
          position: 'left',
        },
        {
          to: '/application-notes',
          label: '应用拆解',
          position: 'left',
        },
        {
          to: '/notes',
          label: '方法与复盘',
          position: 'left',
        },
        {
          to: '/about',
          label: '关于我',
          position: 'left',
        },
        {
          type: 'search',
          position: 'right',
        },
        {
          type: 'custom-siteThemePreset',
          position: 'right',
        },
        {
          href: 'https://github.com/xiaomingtx12/nice-ai-agent-study-resources',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [],
      copyright: `Copyright © ${new Date().getFullYear()} xiaomingtx12`,
    },
    mermaid: {
      theme: {
        light: 'base',
        dark: 'forest',
      },
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  },
};

export default config;
