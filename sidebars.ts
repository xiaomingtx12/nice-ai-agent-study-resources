import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  resourcesSidebar: [
    'resources/index',
    {
      type: 'category',
      label: '学习地图与路径',
      collapsed: false,
      items: [
        'resources/hello-agents/index',
        'resources/ai-agents-from-zero/index',
        'resources/easy-vibe/index',
        'resources/codex-guide/index',
      ],
    },
    {
      type: 'category',
      label: 'Harness / Coding Agent',
      collapsed: false,
      items: [
        'resources/learn-claude-code/index',
        'resources/claude-code-architecture/index',
      ],
    },
    {
      type: 'category',
      label: '架构与生产化',
      collapsed: false,
      items: [
        'resources/agentic-design-patterns/index',
        'resources/ai-agent-book/index',
      ],
    },
    {
      type: 'category',
      label: '源码与真实系统',
      collapsed: false,
      items: [
        'resources/openclaw-book/index',
      ],
    },
  ],
  notesSidebar: [
    'notes/index',
    {
      type: 'category',
      label: '架构理解与入门',
      collapsed: false,
      items: ['notes/agent-thinking-transformer-from-prompt'],
    },
    {
      type: 'category',
      label: 'Agent 系统设计',
      collapsed: false,
      items: [
        'notes/agent-loop-design',
        'notes/agent-tool-calling',
        'notes/agent-context-management',
        'notes/agent-rag-design',
        'notes/agent-mcp-skill-design',
        'notes/agent-observability',
      ],
    },
    {
      type: 'category',
      label: 'Claude Code 应用',
      collapsed: false,
      items: [
        'notes/agent-claude-code-user-perspective',
        'notes/agent-claude-code-project-onboarding',
        'notes/agent-claude-code-engine-perspective',
      ],
    },
    {
      type: 'category',
      label: '设计模式与元认知',
      collapsed: false,
      items: ['notes/agent-coding-strategy-state-reflect'],
    },
    {
      type: 'category',
      label: '实践落地',
      collapsed: false,
      items: ['notes/agent-from-paradigm-to-practice'],
    },
    {
      type: 'category',
      label: '学习方法与复盘',
      collapsed: false,
      items: [
        'notes/how-to-learn-agent-with-judgment',
        'notes/ai-coding-learning-method-stage-review',
      ],
    },
  ],
  applicationNotesSidebar: [
    'application-notes/index',
    {
      type: 'category',
      label: 'Agent 开发平台',
      collapsed: false,
      items: [
        'application-notes/agent-development-platform/index',
        'application-notes/agent-development-platform/reading-map-and-key-terms',
        'application-notes/agent-development-platform/platform-definition-and-overview',
        'application-notes/agent-development-platform/configuration-assets-and-platform-foundation',
        'application-notes/agent-development-platform/agent-runtime-and-memory',
        'application-notes/agent-development-platform/tools-and-external-capabilities',
        'application-notes/agent-development-platform/knowledge-base-and-retrieval-pipeline',
        'application-notes/agent-development-platform/workflow-orchestration-engine',
        'application-notes/agent-development-platform/langchain-component-abstractions',
        'application-notes/agent-development-platform/langgraph-orchestration-kernel',
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
