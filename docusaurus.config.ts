import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';

const config: Config = {
  title: 'Nice AI 资源库',
  tagline: '资源导航、锐评与个人学习沉淀',
  url: 'https://xiaomingtx12.github.io',
  baseUrl: '/nice-ai-agent-study-resources/',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  organizationName: 'xiaomingtx12',
  projectName: 'nice-ai-agent-study-resources',

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
      },
    ],
  ],

  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    navbar: {
      title: 'Nice AI',
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
          to: '/notes',
          label: '方法与复盘',
          position: 'left',
        },
        {
          to: '/application-notes',
          label: '应用沉淀',
          position: 'left',
        },
        {
          to: '/templates',
          label: '共建与模板',
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
