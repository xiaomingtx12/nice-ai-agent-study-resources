import type {ReactNode} from 'react';
import Link from '@docusaurus/Link';
import SiteStats, {SiteCount, type SiteStatKey} from '../SiteStats';
import './styles.css';

type Collection = {
  title: string;
  to: string;
  stat: SiteStatKey;
  unit: string;
};

const collections: Collection[] = [
  {title: '资源导航', to: '/resources/', stat: 'resources', unit: '条资源'},
  {title: '应用拆解', to: '/application-notes/', stat: 'applicationNotes', unit: '篇拆解'},
  {title: '方法与复盘', to: '/notes/', stat: 'notes', unit: '篇复盘'},
];

const readings = [
  {
    title: '从 LangGraph 到 Deep Agents',
    to: '/application-notes/engineering/langchain-series/',
    category: '框架源码',
    description: '从图状态机到长任务 Harness，沿着真实代码看状态、工具与上下文如何逐层装配。',
    topics: ['LangGraph', 'LangChain', 'Deep Agents'],
  },
  {
    title: 'Claude Code CLI 的工作循环',
    to: '/application-notes/engineering/claude-code-cli/',
    category: 'CCB v2.8.2 复刻仓库',
    description: '主循环怎样驱动推理与工具调用，上下文如何压缩，权限在哪里生效。',
    topics: ['Harness', '上下文', '权限'],
  },
  {
    title: 'Dify：从配置到执行引擎',
    to: '/application-notes/engineering/dify/',
    category: 'Dify v1.15.0',
    description: '把 Agent、RAG 和 Workflow 放回完整系统，追踪进程、数据与事件的协作。',
    topics: ['Agent', 'RAG', 'Workflow'],
  },
];

const questions = [
  {title: '上下文应该怎样装配？', detail: '输入、预算与信息边界', to: '/notes/agent-system-design/view/agent-context-management'},
  {title: '记忆应该存什么、何时忘？', detail: '写入、召回与生命周期', to: '/notes/agent-system-design/view/agent-memory-design'},
  {title: '什么时候需要多 Agent？', detail: '分工、通信与协作代价', to: '/notes/agent-system-design/decision/agent-multi-agent-orchestration'},
];

function Arrow(): ReactNode {
  return (
    <svg className="kh-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function LearningLayers(): ReactNode {
  return (
    <figure className="kh-atlas">
      <div className="kh-atlas-caption"><span>学习的积累</span><span>从理解到复用</span></div>
      <svg viewBox="0 0 480 380" role="img" aria-label="学习的三个层次：阅读形成理解，源码与实践加深认识，复盘沉淀出可复用的方法。">
        <g className="kh-atlas-guides" fill="none" stroke="currentColor">
          <path d="M42 252 250 330 448 214M42 173 250 251 448 135M42 94 250 172 448 56" />
          <path d="M66 56v213M250 122v210M432 46v190" strokeDasharray="3 6" />
        </g>
        <path className="kh-atlas-shadow" d="m68 307 184 68 180-93-184-61Z" />
        <g className="kh-atlas-foundation">
          <path d="m64 276 184 68 184-96v16l-184 96-184-68Z" className="kh-atlas-edge" />
          <path d="m64 276 184 68 184-96-184-68Z" className="kh-atlas-plane" />
          <path d="m94 276 150 55M270 316l132-69" className="kh-atlas-line" />
          <g transform="matrix(.91 .335 -.88 .458 121 274)"><text>复盘 / 方法</text><text y="27" className="kh-atlas-small">留下可复用的经验</text></g>
        </g>
        <g className="kh-atlas-execution">
          <path d="m64 186 184 68 184-96v16l-184 96-184-68Z" className="kh-atlas-edge" />
          <path d="m64 186 184 68 184-96-184-68Z" className="kh-atlas-plane" />
          <path d="m94 186 150 55M270 226l132-69" className="kh-atlas-line" />
          <g transform="matrix(.91 .335 -.88 .458 121 184)"><text>源码 / 实践</text><text y="27" className="kh-atlas-small">在真实问题中验证</text></g>
          <path d="m291 158 45 16-33 17-45-16Z" className="kh-atlas-chip" />
          <path d="m310 153 16 6m-42 26 16 6m34-18 12-6m-76 28 12-6" className="kh-atlas-line" />
        </g>
        <g className="kh-atlas-context">
          <path d="m64 98 184 68L432 70v16l-184 96L64 114Z" className="kh-atlas-edge" />
          <path d="m64 98 184 68L432 70 248 2Z" className="kh-atlas-plane" />
          <g transform="matrix(.91 .335 -.88 .458 121 81)"><text>阅读 / 理解</text><text y="27" className="kh-atlas-small">从一份好资料开始</text></g>
          <path d="m310 70 45 17m-58-10 45 17m-58-10 30 11" className="kh-atlas-line" />
        </g>
        <g className="kh-atlas-annotations"><path d="M434 187h22M434 277h22" /><circle cx="456" cy="187" r="3" /><circle cx="456" cy="277" r="3" /><path d="M456 193v78" strokeDasharray="2 4" /></g>
      </svg>
      <figcaption>读过、做过，再整理成自己的理解。</figcaption>
    </figure>
  );
}

export default function KnowledgeHome(): ReactNode {
  return (
    <div className="knowledge-home">
      <header className="kh-intro">
        <div className="kh-intro-copy">
          <p className="kh-eyebrow">AI Agent 学习沉淀</p>
          <h1>把学到的，<br />留给下一次实践。</h1>
          <p className="kh-lead">记录值得读的资料、拆过的源码与实践后的复盘。<br />把零散的理解，慢慢整理成下次用得上的经验。</p>
          <div className="kh-actions">
            <Link className="kh-action-primary" to="/resources/">浏览学习资源 <Arrow /></Link>
            <Link className="kh-action-secondary" to="/application-notes/">阅读源码拆解 <Arrow /></Link>
          </div>
          <SiteStats />
        </div>
        <LearningLayers />
      </header>

      <div className="kh-body">
        <section className="kh-readings" aria-labelledby="kh-readings-title">
          <div className="kh-section-head">
            <h2 id="kh-readings-title">源码专题</h2>
            <Link to="/application-notes/">全部拆解 <Arrow /></Link>
          </div>
          <div className="kh-reading-list">
            {readings.map((reading, index) => (
              <Link
                to={reading.to}
                key={reading.to}
                className={index === 0 ? 'kh-reading kh-reading-featured' : 'kh-reading'}>
                <span className="kh-category">{reading.category}</span>
                <div className="kh-reading-heading">
                  <h3>{reading.title}</h3>
                  <Arrow />
                </div>
                <p>{reading.description}</p>
                <ul className="kh-topics" aria-label="专题内容">
                  {reading.topics.map((topic) => <li key={topic}>{topic}</li>)}
                </ul>
              </Link>
            ))}
          </div>
        </section>

        <aside className="kh-index" aria-label="阅读索引">
          <section aria-labelledby="kh-questions-title">
            <div className="kh-section-head">
              <h2 id="kh-questions-title">按问题阅读</h2>
            </div>
            <div className="kh-question-list">
              {questions.map((question) => (
                <Link className="kh-question" to={question.to} key={question.to}>
                  <span>
                    <strong>{question.title}</strong>
                    <small>{question.detail}</small>
                  </span>
                  <Arrow />
                </Link>
              ))}
            </div>
            <Link className="kh-index-more" to="/notes/agent-system-design/">查看工程方法 <Arrow /></Link>
          </section>
          <section className="kh-collections" aria-labelledby="kh-collections-title">
            <div className="kh-section-head">
              <h2 id="kh-collections-title">学习内容</h2>
            </div>
            {collections.map((collection) => (
              <Link className="kh-collection" to={collection.to} key={collection.stat}>
                <span>{collection.title}</span>
                <span className="kh-count"><SiteCount stat={collection.stat} /> {collection.unit}</span>
              </Link>
            ))}
          </section>
          <p className="kh-editor-note">这里记录学习过程，也保留实践后的判断。<br />内容随着理解深入，持续补充和修订。</p>
          <Link className="kh-index-more" to="/about/">关于本站 <Arrow /></Link>
        </aside>
      </div>
    </div>
  );
}
