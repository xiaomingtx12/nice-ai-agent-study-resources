import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const resourceEntry = (
  label: string,
  indexId: string,
  reviewId: string,
  noteIndexId: string,
  noteIds: string[],
) => ({
  type: 'category' as const,
  label,
  link: {type: 'doc' as const, id: indexId},
  collapsed: true,
  items: [
    reviewId,
    {
      type: 'category' as const,
      label: '学习沉淀',
      link: {type: 'doc' as const, id: noteIndexId},
      collapsed: true,
      items: noteIds,
    },
  ],
});

const sidebars: SidebarsConfig = {
  resourcesSidebar: [
    'resources/index',
    {
      type: 'category',
      label: '学习地图与路径',
      collapsed: false,
      items: [
        resourceEntry(
          'HelloAgents',
          'resources/hello-agents/index',
          'resources/hello-agents/review',
          'resources/hello-agents/notes/index',
          [
            'resources/hello-agents/notes/why-i-treat-it-as-a-map',
            'resources/hello-agents/notes/how-i-plan-to-study-it',
          ],
        ),
        resourceEntry(
          'AI Agents From Zero',
          'resources/ai-agents-from-zero/index',
          'resources/ai-agents-from-zero/review',
          'resources/ai-agents-from-zero/notes/index',
          [
            'resources/ai-agents-from-zero/notes/why-i-see-it-as-a-project-driven-agent-path',
            'resources/ai-agents-from-zero/notes/how-i-distinguish-it-from-helloagents-and-easy-vibe',
          ],
        ),
        resourceEntry(
          'Easy-Vibe',
          'resources/easy-vibe/index',
          'resources/easy-vibe/review',
          'resources/easy-vibe/notes/index',
          [
            'resources/easy-vibe/notes/why-i-see-it-as-an-ai-coding-learning-path',
            'resources/easy-vibe/notes/how-i-distinguish-it-from-other-agent-resources',
          ],
        ),
      ],
    },
    {
      type: 'category',
      label: 'Harness / Coding Agent',
      collapsed: false,
      items: [
        resourceEntry(
          'Learn Claude Code',
          'resources/learn-claude-code/index',
          'resources/learn-claude-code/review',
          'resources/learn-claude-code/notes/index',
          [
            'resources/learn-claude-code/notes/why-i-see-it-as-an-agent-harness-course',
            'resources/learn-claude-code/notes/how-i-would-pair-it-with-other-resources',
          ],
        ),
        resourceEntry(
          'Claude Code Architecture（CCB）',
          'resources/claude-code-architecture/index',
          'resources/claude-code-architecture/review',
          'resources/claude-code-architecture/notes/index',
          [
            'resources/claude-code-architecture/notes/why-i-see-it-as-a-reverse-engineering-whitepaper',
            'resources/claude-code-architecture/notes/how-i-separate-it-from-learn-claude-code',
          ],
        ),
      ],
    },
    {
      type: 'category',
      label: '架构与生产化',
      collapsed: false,
      items: [
        resourceEntry(
          'AI Agent Book',
          'resources/ai-agent-book/index',
          'resources/ai-agent-book/review',
          'resources/ai-agent-book/notes/index',
          [
            'resources/ai-agent-book/notes/why-it-feels-like-an-architecture-manual',
            'resources/ai-agent-book/notes/how-i-plan-to-read-it',
            'resources/ai-agent-book/notes/chapter-level-critique',
          ],
        ),
      ],
    },
    {
      type: 'category',
      label: '源码与真实系统',
      collapsed: false,
      items: [
        resourceEntry(
          'OpenClaw 源码解析',
          'resources/openclaw-book/index',
          'resources/openclaw-book/review',
          'resources/openclaw-book/notes/index',
          [
            'resources/openclaw-book/notes/why-i-see-it-as-a-control-plane-walkthrough',
            'resources/openclaw-book/notes/how-to-read-it-without-drowning-in-details',
          ],
        ),
      ],
    },
  ],
  notesSidebar: ['notes/index', 'notes/how-to-learn-agent-with-judgment'],
  applicationNotesSidebar: [
    'application-notes/index',
    {
      type: 'category',
      label: '写作说明',
      collapsed: false,
      items: ['application-notes/what-i-want-to-write-here'],
    },
    {
      type: 'category',
      label: 'Dify 型应用',
      collapsed: false,
      items: [
        'application-notes/dify-type-application/index',
        'application-notes/dify-type-application/one-stop-agent-platform-overview',
        'application-notes/dify-type-application/langchain-component-abstractions',
        'application-notes/dify-type-application/langgraph-orchestration-kernel',
        'application-notes/dify-type-application/core-agent-layer',
        'application-notes/dify-type-application/tool-calling',
        'application-notes/dify-type-application/online-knowledge-base',
        'application-notes/dify-type-application/visual-workflow',
        'application-notes/dify-type-application/multi-model-integration',
        'application-notes/dify-type-application/overall-architecture',
        'application-notes/dify-type-application/how-to-write-useful-dify-app-note',
      ],
    },
    {
      type: 'category',
      label: '准备文档',
      collapsed: true,
      items: [
        'application-notes/dify准备文档/项目中的 LangChain 具体实现详解',
        'application-notes/dify准备文档/项目中的 LangGraph 具体实现详解',
        'application-notes/dify准备文档/智能体双模式执行 LangGraph 实现详解',
        'application-notes/dify准备文档/插件工具平台与多模型统一管理实现详解',
        'application-notes/dify准备文档/RAG 检索增强链路与会话记忆机制实现详解',
        'application-notes/dify准备文档/可视化工作流引擎 LangGraph 实现详解',
        'application-notes/dify准备文档/多LLM模型',
        'application-notes/dify准备文档/自定义AgentQueueManager',
      ],
    },
    {
      type: 'category',
      label: '历史备份',
      collapsed: true,
      items: [
        'application-notes/diyf-type-application-bac/index',
        'application-notes/diyf-type-application-bac/one-stop-agent-platform-overview',
        'application-notes/diyf-type-application-bac/langchain-component-abstractions',
        'application-notes/diyf-type-application-bac/langgraph-orchestration-kernel',
        'application-notes/diyf-type-application-bac/core-agent-layer',
        'application-notes/diyf-type-application-bac/tool-calling',
        'application-notes/diyf-type-application-bac/online-knowledge-base',
        'application-notes/diyf-type-application-bac/visual-workflow',
        'application-notes/diyf-type-application-bac/multi-model-integration',
        'application-notes/diyf-type-application-bac/overall-architecture',
        'application-notes/diyf-type-application-bac/how-to-write-useful-dify-app-note',
      ],
    },
  ],
  templatesSidebar: [
    'templates/index',
    'templates/how-to-add-resource',
    'templates/human-first-contribution',
    'templates/ai-assisted-contribution',
    {
      type: 'category',
      label: '模板',
      collapsed: false,
      items: [
        'templates/resource-note-template',
        'templates/note-template',
      ],
    },
  ],
};

export default sidebars;
