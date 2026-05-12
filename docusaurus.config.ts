import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';

const config: Config = {
  title: 'Nice AI 资源库',
  tagline: '资源导航、锐评与个人学习沉淀',
  url: 'https://xiaomingtx12.github.io',
  baseUrl: '/nice-ai-agent-study-resources/',

  organizationName: 'xiaomingtx12',
  projectName: 'nice-ai-agent-study-resources',

  onBrokenLinks: 'throw',

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

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

  themeConfig: {
    navbar: {
      title: 'Nice AI',
      items: [
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
          to: '/templates',
          label: '写作模板',
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
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  },
};

export default config;
