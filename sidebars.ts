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
            'resources/hello-agents/notes/which-modules-are-worth-reading-first',
            'resources/hello-agents/notes/how-i-plan-to-study-it',
            'resources/hello-agents/notes/how-to-check-whether-you-learned-more-than-vocabulary',
          ],
        ),
        resourceEntry(
          'AI Agents From Zero',
          'resources/ai-agents-from-zero/index',
          'resources/ai-agents-from-zero/review',
          'resources/ai-agents-from-zero/notes/index',
          [
            'resources/ai-agents-from-zero/notes/why-i-see-it-as-a-project-driven-agent-path',
            'resources/ai-agents-from-zero/notes/which-projects-are-worth-doing-first',
            'resources/ai-agents-from-zero/notes/which-parts-of-workflow-mcp-and-rag-are-portable',
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
        resourceEntry(
          'CodexGuide',
          'resources/codex-guide/index',
          'resources/codex-guide/review',
          'resources/codex-guide/notes/index',
          [
            'resources/codex-guide/notes/why-i-see-it-as-a-codex-practice-guide',
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
            'resources/learn-claude-code/notes/what-in-s01-to-s06-is-the-real-backbone',
            'resources/learn-claude-code/notes/which-runtime-mechanisms-i-would-steal-first',
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
            'resources/claude-code-architecture/notes/which-layers-are-most-worth-reusing-as-a-framework',
            'resources/claude-code-architecture/notes/how-i-separate-it-from-learn-claude-code',
            'resources/claude-code-architecture/notes/why-queryengine-permissions-compaction-and-telemetry-are-the-real-product-divide',
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
          'Agentic Design Patterns',
          'resources/agentic-design-patterns/index',
          'resources/agentic-design-patterns/review',
          'resources/agentic-design-patterns/notes/index',
          [
            'resources/agentic-design-patterns/notes/why-i-see-it-as-agent-pattern-language',
          ],
        ),
        resourceEntry(
          'AI Agent Book',
          'resources/ai-agent-book/index',
          'resources/ai-agent-book/review',
          'resources/ai-agent-book/notes/index',
          [
            'resources/ai-agent-book/notes/why-it-feels-like-an-architecture-manual',
            'resources/ai-agent-book/notes/how-i-plan-to-read-it',
            'resources/ai-agent-book/notes/chapter-level-critique',
            'resources/ai-agent-book/notes/which-questions-have-to-enter-your-head-first',
            'resources/ai-agent-book/notes/which-patterns-are-worth-using-now-and-which-should-wait',
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
            'resources/openclaw-book/notes/if-i-only-follow-one-line-i-follow-gateway-to-runtime',
            'resources/openclaw-book/notes/which-implementations-are-worth-extracting-into-general-patterns',
          ],
        ),
      ],
    },
  ],
  notesSidebar: [
    'notes/index',
    'notes/how-to-learn-agent-with-judgment',
    'notes/ai-coding-learning-method-stage-review',
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
