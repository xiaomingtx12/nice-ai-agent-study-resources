import type {Options} from '@docusaurus/plugin-content-docs';

type SidebarGenerator = NonNullable<Options['sidebarItemsGenerator']>;
type Sidebar = Awaited<ReturnType<SidebarGenerator>>;
type SidebarItem = Sidebar[number];

const octopDirectory = 'application-notes/engineering/octop';

// 按编号后的文件名组织 Octop 阅读分组；文档 ID 由默认生成器解析，URL 由文章 slug 固定。
const groups = [
  {
    label: '一、Agent 运行主线',
    files: [
      '00-project-and-component-family.md',
      '01-agent-lifecycle-and-providers.md',
      '02-agent-turn-execution.md',
    ],
  },
  {
    label: '二、执行能力',
    files: [
      '03-workspace-and-backend-abstraction.md',
      '04-skills-experts-plugins.md',
      '05-connectors-and-mcp-gateway.md',
      '06-execution-surfaces.md',
    ],
  },
  {
    label: '三、上下文与状态',
    files: [
      '07-middleware-and-context-engineering.md',
      '08-versioned-history-and-trajectory.md',
      '09-memory-system.md',
      '10-knowledge-base-rag.md',
    ],
  },
  {
    label: '四、用户交互',
    files: [
      '11-im-gateway-message-pipeline.md',
      '12-stream-projection-and-rendering.md',
      '13-session-control-slash-hitl-steer.md',
    ],
  },
  {
    label: '五、协作与自动运行',
    files: [
      '14-teams-delegation-bridge.md',
      '15-cron-and-proactive-care.md',
    ],
  },
  {
    label: '六、故障恢复',
    files: ['16-disconnect-reconnect-and-recovery.md'],
  },
];

export const octopSidebarItemsGenerator: SidebarGenerator = async (args) => {
  const items = await args.defaultSidebarItemsGenerator(args);
  const findDoc = (filename: string) =>
    args.docs.find((doc) =>
      doc.source.replace(/\\/g, '/').endsWith(`/${octopDirectory}/${filename}`),
    );
  const index = findDoc('index.md');
  if (!index) {
    return items;
  }

  const groupChapters = (children: Sidebar): Sidebar => {
    const used = new Set<string>();
    const grouped: Sidebar = groups.map(({label, files}) => ({
      type: 'category',
      label,
      collapsible: true,
      collapsed: false,
      items: files.map((filename) => {
        const doc = findDoc(filename);
        const item = children.find((child) => child.type === 'doc' && child.id === doc?.id);
        if (!doc || !item) {
          throw new Error(`Octop 系列分组缺少文档：${filename}`);
        }
        used.add(doc.id);
        return item;
      }),
    }));
    // 新增但尚未归组的文档仍可见，避免维护目录时悄悄丢掉页面。
    return [...grouped, ...children.filter((item) => item.type !== 'doc' || !used.has(item.id))];
  };

  const visit = (item: SidebarItem): SidebarItem => {
    if (item.type !== 'category') {
      return item;
    }
    if (item.link?.type === 'doc' && item.link.id === index.id) {
      return {...item, items: groupChapters(item.items)};
    }
    return {...item, items: item.items.map(visit)};
  };

  return items.map(visit);
};
