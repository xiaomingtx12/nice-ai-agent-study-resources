import {useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {ErrorBoundaryErrorMessageFallback} from '@docusaurus/theme-common';
import {
  useMermaidThemeConfig,
} from '@docusaurus/theme-mermaid/client';
import type {MermaidConfig, RenderResult} from 'mermaid';
import type {Props} from '@theme/Mermaid';
import DiagramViewer from '../../components/DiagramViewer';
import {applyDiagramPalette, diagramPalette, preserveAuthoredLabelContrast} from './palette';
import {subscribeToRouteTransition, isRouteTransitionPending} from '../../lib/routeTransition';

const ROOT_MARGIN = '100px 0px';

// 图内文字与站点字体对齐：关闭 htmlLabels（foreignObject 按 trebuchet 量宽，
// 实际却回退到系统中文字体渲染，宽度对不上就会截字），改用 SVG <text> 由
// mermaid 用同一套 fontFamily 量与画。配色跟随站点 token。
const MERMAID_FONT_FAMILY = 'Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif';

function withSiteMermaidConfig(config: MermaidConfig): MermaidConfig {
  return {
    ...config,
    theme: 'base',
    fontFamily: MERMAID_FONT_FAMILY,
    htmlLabels: false,
    flowchart: {...config.flowchart, htmlLabels: false},
    themeVariables: {...diagramPalette, fontFamily: MERMAID_FONT_FAMILY},
  };
}

// --- mermaid loader (ELK is stubbed out of the bundle, so we only need mermaid core) ---
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => module.default);
  }
  return mermaidPromise;
}

// 配置只与站点图表选项有关；明暗模式由 SVG 中的 CSS 变量处理。
let lastInitializedConfig: MermaidConfig | null = null;
async function renderMermaid({
  id,
  text,
  config,
}: {
  id: string;
  text: string;
  config: MermaidConfig;
}): Promise<RenderResult> {
  const mermaid = await loadMermaid();
  if (lastInitializedConfig !== config) {
    mermaid.initialize(withSiteMermaidConfig(config));
    lastInitializedConfig = config;
  }
  // Mermaid needs DOM measurement. Keep its temporary nodes outside page flow
  // so even the intermediate, unscaled SVG cannot move the article or scrollbar.
  const measuringHost = document.createElement('div');
  measuringHost.setAttribute('aria-hidden', 'true');
  measuringHost.style.cssText = 'position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;contain:layout style;';
  document.body.append(measuringHost);
  try {
    const rendered = await mermaid.render(id, text, measuringHost);
    const svgDocument = new DOMParser().parseFromString(rendered.svg, 'image/svg+xml');
    preserveAuthoredLabelContrast(svgDocument);
    return {...rendered, svg: applyDiagramPalette(new XMLSerializer().serializeToString(svgDocument.documentElement))};
  } catch (error) {
    // Mermaid leaves a stray error node in the DOM on failure.
    document.querySelector(`#d${id}`)?.remove();
    throw error;
  } finally {
    measuringHost.remove();
  }
}

// --- serial render queue with per-frame yielding + cancellation ---
// Renders are synchronous CPU work that cannot be interrupted mid-render, so we
// serialize them and yield one animation frame between each. This keeps the
// main thread responsive to clicks/paint between renders (fixing the dark-mode
// toggle freeze and the navigate-during-load lag). Cancellation lets unmount
// (navigation) or a superseding config change skip renders that haven't started.
let renderQueue: Promise<void> = Promise.resolve();

// 渲染让行到浏览器空闲帧：diagram 多的页面不再因为连续同步渲染而卡输入与滚动。
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => void;
      }
    ).requestIdleCallback;
    if (ric) {
      ric(() => resolve(), {timeout: 120});
    } else {
      setTimeout(resolve, 16);
    }
  });
}

function enqueueRender(
  task: () => Promise<RenderResult>,
  isCancelled: () => boolean,
): Promise<RenderResult | undefined> {
  let resolveTask!: (value: RenderResult | undefined) => void;
  let rejectTask!: (reason: unknown) => void;
  const settled = new Promise<RenderResult | undefined>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });

  renderQueue = renderQueue.then(async () => {
    await yieldToBrowser();
    if (isCancelled()) {
      resolveTask(undefined);
      return;
    }
    try {
      const result = await task();
      resolveTask(isCancelled() ? undefined : result);
    } catch (error) {
      if (isCancelled()) {
        resolveTask(undefined);
      } else {
        rejectTask(error);
      }
    }
  });
  // Keep the chain alive even if a task rejects.
  renderQueue = renderQueue.catch(() => {});

  return settled;
}

// --- per-(config, text) SVG cache ---
// 缓存按图表选项和内容键控，换配色复用同一个 SVG。实例 id 仍保持唯一。
type CachedSvg = {svg: string; rid: string};

const svgCache = new Map<string, CachedSvg>();

function cacheKey(theme: string | undefined, text: string): string {
  return `${theme ?? ''}:${text}`;
}

function reidentifyRender(cached: CachedSvg, instanceId: string): RenderResult {
  return {svg: cached.svg.split(cached.rid).join(instanceId)} as RenderResult;
}

// 持久化到 sessionStorage：mermaid.render 是同步 CPU 重活、无法分片，
// 回访/前进后退命中缓存可完全跳过渲染，避免进长文时的主线程冻结。
const SVG_CACHE_STORAGE_PREFIX = 'nice-ai-mermaid-svg-v4:';

function hashCacheKey(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 33) ^ key.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function readCachedRender(key: string): CachedSvg | undefined {
  const inMemory = svgCache.get(key);
  if (inMemory) {
    return inMemory;
  }

  try {
    const raw = window.sessionStorage.getItem(SVG_CACHE_STORAGE_PREFIX + hashCacheKey(key));
    if (raw) {
      const parsed = JSON.parse(raw) as CachedSvg;
      svgCache.set(key, parsed);
      return parsed;
    }
  } catch {
    // sessionStorage 不可用或数据损坏时按未命中处理
  }

  return undefined;
}

function writeCachedRender(key: string, result: CachedSvg): void {
  svgCache.set(key, result);

  try {
    window.sessionStorage.setItem(
      SVG_CACHE_STORAGE_PREFIX + hashCacheKey(key),
      JSON.stringify(result),
    );
  } catch {
    // 配额满：清空本类缓存，后续渲染重建
    try {
      Object.keys(window.sessionStorage)
        .filter((name) => name.startsWith(SVG_CACHE_STORAGE_PREFIX))
        .forEach((name) => window.sessionStorage.removeItem(name));
    } catch {
      // 忽略
    }
  }
}

function useQueuedMermaidRenderResult(text: string, enabled: boolean): RenderResult | null {
  const {options} = useMermaidThemeConfig();
  const config = useMemo<MermaidConfig>(() => ({startOnLoad: false, ...options, theme: 'base'}), [options]);
  const configKey = useMemo(() => JSON.stringify(config), [config]);
  const [result, setResult] = useState<RenderResult | null>(null);
  const idRef = useRef<string>(`mermaid-svg-${Math.round(Math.random() * 1e7)}`);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let revision = 0;
    let completed = false;
    const key = cacheKey(configKey, text);
    const startRuntimeRender = () => {
      const request = ++revision;
      if (isRouteTransitionPending() || completed) return;
      const cached = readCachedRender(key);
      if (cached) {
        completed = true;
        setResult(reidentifyRender(cached, idRef.current));
        return;
      }
      const task = () => renderMermaid({id: idRef.current, text, config});
      enqueueRender(task, () => cancelled || request !== revision || isRouteTransitionPending())
        .then((rendered) => {
          if (rendered && !cancelled && request === revision) {
            completed = true;
            writeCachedRender(key, {svg: rendered.svg, rid: idRef.current});
            setResult(rendered);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && request === revision) {
            setResult(() => {
              throw error;
            });
          }
        });
    };
    // 导航只撤销/恢复尚未完成的任务，不让每个图表订阅 React 同步外部状态，
    // 避免路由 transition 被整页图表的同步更新打断。
    const unsubscribe = subscribeToRouteTransition(startRuntimeRender);
    startRuntimeRender();

    return () => {
      cancelled = true;
      revision += 1;
      unsubscribe();
    };
  }, [text, config, configKey, enabled]);

  return result;
}

function MermaidRenderer({value, enabled}: Props & {enabled: boolean}): ReactNode {
  const renderResult = useQueuedMermaidRenderResult(value, enabled);
  return <DiagramViewer result={renderResult} />;
}

export default function Mermaid(props: Props): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null || visible) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      {rootMargin: ROOT_MARGIN},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={containerRef}>
      <ErrorBoundary fallback={(params) => <ErrorBoundaryErrorMessageFallback {...params} />}>
        <MermaidRenderer key={props.value} {...props} enabled={visible} />
      </ErrorBoundary>
    </div>
  );
}
