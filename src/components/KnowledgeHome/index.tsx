import {useId, type ReactNode} from 'react';
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
  const id = useId().replace(/:/g, '');
  const paint = (name: string) => `url(#${id}-${name})`;

  return (
    <figure className="kh-atlas">
      <div className="kh-atlas-caption"><span>工程判断的积累</span><span>从学习到实践</span></div>
      <svg viewBox="0 0 480 400" role="img" aria-label="资源导航：精选学习资料；应用拆解：理解真实项目；方法复盘：沉淀工程判断。">
        <defs>
          <linearGradient id={id + '-paper'} x1="0" y1="0" x2="0.5" y2="1">
            <stop className="kh-atlas-paper-light" />
            <stop offset="1" className="kh-atlas-paper-shade" />
          </linearGradient>
          <linearGradient id={id + '-cover'} x1="0" y1="0" x2="0.8" y2="1">
            <stop className="kh-atlas-cover-light" />
            <stop offset="1" className="kh-atlas-cover-shade" />
          </linearGradient>
          <linearGradient id={id + '-edge'} x1="0" y1="0" x2="0" y2="1">
            <stop className="kh-atlas-edge-light" />
            <stop offset="1" className="kh-atlas-edge-shade" />
          </linearGradient>
          <filter id={id + '-shadow'} x="-20%" y="-30%" width="140%" height="180%" colorInterpolationFilters="sRGB">
            <feDropShadow dx="0" dy="10" stdDeviation="6" floodColor="#17150f" floodOpacity="0.12" />
          </filter>
          <filter id={id + '-ground'} x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur stdDeviation="8" />
          </filter>
          {/* 三层共用同一顶面和侧面，确保透视、厚度及接缝一致。 */}
          <path id={id + '-plane'} d="M56 112 240 12 424 84 240 184Z" />
          <path id={id + '-front'} d="M56 112 240 184v14L56 126Z" />
          <path id={id + '-side'} d="M240 184 424 84v14L240 198Z" />
        </defs>
        <path className="kh-atlas-ground" d="m62 291 178 70 181-99v17L240 379 62 309Z" filter={paint('ground')} />
        <g className="kh-atlas-guides">
          <path d="M56 119v174M240 192v182M424 91v174" strokeDasharray="2 6" />
          <path d="m34 292 206 81 207-113M34 212l206 81 207-113" />
        </g>
        {[
          {name: 'foundation', y: 160, title: '方法复盘', detail: '沉淀工程判断'},
          {name: 'practice', y: 80, title: '应用拆解', detail: '理解真实项目'},
          {name: 'reading', y: 0, title: '资源导航', detail: '精选学习资料'},
        ].map((layer) => (
          <g key={layer.name} className={'kh-atlas-layer kh-atlas-' + layer.name} transform={'translate(0 ' + layer.y + ')'}>
            <g filter={paint('shadow')}>
              <use href={'#' + id + '-front'} fill={paint('edge')} className="kh-atlas-front" />
              <use href={'#' + id + '-side'} fill={paint('edge')} className="kh-atlas-side" />
              <use href={'#' + id + '-plane'} fill={paint(layer.name === 'reading' ? 'cover' : 'paper')} className="kh-atlas-plane" />
            </g>
            <path d="M57 112 240 184 423 84" className="kh-atlas-bevel" />
            <path d="m60 123 180 71 180-98" className="kh-atlas-seam" />
            <g transform="matrix(.94 .368 -.86 .467 109 103)" className="kh-atlas-plane-label">
              <text>{layer.title}</text>
              <text y="25" className="kh-atlas-small">{layer.detail}</text>
            </g>
            {layer.name === 'reading' ? (
              <g className="kh-atlas-cover-detail">
                <path d="m306 63 45 18m-58-10 45 18m-58-10 31 12" />
                <path d="m73 110 19-10m291-9 19-10" className="kh-atlas-corner" />
              </g>
            ) : (
              <path d="m85 120 151 59m26-3 135-74" className="kh-atlas-inset" />
            )}
          </g>
        ))}
        <g className="kh-atlas-annotations">
          <path d="M429 186h21M429 266h21M450 191v70" />
          <circle cx="450" cy="186" r="3" />
          <circle cx="450" cy="266" r="3" />
        </g>
      </svg>
      <figcaption>理解设计取舍，形成自己的判断。</figcaption>
    </figure>
  );
}

export default function KnowledgeHome(): ReactNode {
  return (
    <div className="knowledge-home">
      <header className="kh-intro">
        <div className="kh-intro-copy">
          <p className="kh-eyebrow">AI Agent 学习沉淀</p>
          <h1>在学习与实践中，<br />提升判断力。</h1>
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
          <p className="kh-editor-note">这里记录学习过程，也保留实践后的判断。<br />内容随着理解深入，持续补充和修订。</p>
          <Link className="kh-index-more" to="/about/">关于本站 <Arrow /></Link>
        </aside>
      </div>
    </div>
  );
}
