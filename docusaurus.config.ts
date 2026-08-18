import type {PrismTheme} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import {
  DEFAULT_SITE_THEME,
  SITE_THEME_PRESETS,
  SITE_THEME_STORAGE_KEY,
} from './src/lib/siteTheme';
import siteStatsPlugin from './src/plugins/siteStats';

// 暖纸气质的语法高亮：关键词暗红、字符串墨绿、函数深金、注释暖灰，
// 与 --site-* token 同族；暗色版对应 editorial 深色变量。
const niceCodeLight: PrismTheme = {
  plain: {color: '#2C1810', backgroundColor: '#EFE5D0'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#8A7A66', fontStyle: 'italic'}},
    {types: ['punctuation'], style: {color: '#5A4530'}},
    {types: ['keyword', 'rule', 'important', 'tag', 'builtin'], style: {color: '#7B1F2A', fontWeight: 'bold'}},
    {types: ['string', 'char', 'attr-value', 'regex'], style: {color: '#0E4D3C'}},
    {types: ['function', 'class-name', 'maybe-class-name'], style: {color: '#8F6E32'}},
    {types: ['number', 'boolean', 'constant', 'symbol'], style: {color: '#5A2E3A'}},
    {types: ['attr-name', 'selector', 'property', 'variable'], style: {color: '#5A2E3A'}},
    {types: ['operator', 'entity', 'url'], style: {color: '#5A4530'}},
  ],
};

const niceCodeDark: PrismTheme = {
  plain: {color: '#F1E6DA', backgroundColor: '#2B221D'},
  styles: [
    {types: ['comment', 'prolog', 'doctype', 'cdata'], style: {color: '#8A7A66', fontStyle: 'italic'}},
    {types: ['punctuation'], style: {color: '#C4B2A2'}},
    {types: ['keyword', 'rule', 'important', 'tag', 'builtin'], style: {color: '#D98A92', fontWeight: 'bold'}},
    {types: ['string', 'char', 'attr-value', 'regex'], style: {color: '#AAC0A4'}},
    {types: ['function', 'class-name', 'maybe-class-name'], style: {color: '#DDBC7E'}},
    {types: ['number', 'boolean', 'constant', 'symbol'], style: {color: '#C492A3'}},
    {types: ['attr-name', 'selector', 'property', 'variable'], style: {color: '#C492A3'}},
    {types: ['operator', 'entity', 'url'], style: {color: '#C4B2A2'}},
  ],
};

const configuredBaseUrl = process.env.SITE_BASE_URL;
const siteBaseUrl = (() => {
  if (!configuredBaseUrl) {
    return '/';
  }

  // GitHub Pages 的 configure-pages 输出是完整 URL，Docusaurus 的 baseUrl 只接受路径。
  try {
    const pathname = new URL(configuredBaseUrl).pathname;
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  } catch {
    const pathname = configuredBaseUrl.startsWith('/')
      ? configuredBaseUrl
      : `/${configuredBaseUrl}`;
    return pathname.endsWith('/') ? pathname : `${pathname}/`;
  }
})();
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

  // 字体走本地打包（见 src/lib/siteFonts.js），不再依赖 fonts.googleapis.com
  clientModules: [require.resolve('./src/lib/siteFonts.js')],

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  organizationName: 'xiaomingtx12',
  projectName: 'nice-ai-agent-study-resources',

  favicon: 'img/favicon.svg',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',

  i18n: {
    defaultLocale: 'zh-Hans',
    locales: ['zh-Hans'],
  },

  presets: [
    [
      'classic',
      {
        // The debug plugin is not part of the published site and can be
        // implicitly enabled when NODE_ENV is unset on Windows.
        debug: false,
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
    function resolveSearchGeneratedModules() {
      return {
        name: 'resolve-search-generated-modules',
        configureWebpack() {
          const generatedModule = require.resolve(
            './.docusaurus/@easyops-cn/docusaurus-search-local/default/generated.js',
          );
          const generatedConstantsModule = require.resolve(
            './.docusaurus/@easyops-cn/docusaurus-search-local/default/generated-constants.js',
          );

          return {
            resolve: {
              alias: {
                [require.resolve(
                  '@easyops-cn/docusaurus-search-local/dist/client/client/utils/proxiedGenerated',
                )]: generatedModule,
                [require.resolve(
                  '@easyops-cn/docusaurus-search-local/dist/client/client/utils/proxiedGeneratedConstants',
                )]: generatedConstantsModule,
              },
            },
          };
        },
      };
    },
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
    siteStatsPlugin,
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
      title: 'Nice AI 学习沉淀',
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
      theme: niceCodeLight,
      darkTheme: niceCodeDark,
    },
  },
};

export default config;
