import {memo, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {TransformComponent, TransformWrapper, useControls, useTransformComponent} from 'react-zoom-pan-pinch';
import type {RenderResult} from 'mermaid';
import styles from './styles.module.css';

function Icon({kind}: {kind: 'plus' | 'minus' | 'fit' | 'expand'}): ReactNode {
  const paths = {plus: 'M5 12h14M12 5v14', minus: 'M5 12h14', fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z', expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'};
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

const DiagramMarkup = memo(function DiagramMarkup({result}: {result: RenderResult}) {
  const ref = useRef<HTMLDivElement>(null);
  const prepared = useMemo(() => {
    const svg = new DOMParser().parseFromString(result.svg, 'image/svg+xml').documentElement;
    const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    const width = box?.length === 4 && box[2] > 0 ? box[2] : 800;
    const height = box?.length === 4 && box[3] > 0 ? box[3] : 400;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const style = (svg as unknown as SVGSVGElement).style;
    style.width = width + 'px';
    style.height = height + 'px';
    style.maxWidth = 'none';
    return {svg: new XMLSerializer().serializeToString(svg), width, height};
  }, [result]);
  useEffect(() => {if (ref.current) result.bindFunctions?.(ref.current);}, [result]);
  return <div ref={ref} className={'docusaurus-mermaid-container ' + styles.markup} style={{width: prepared.width + 32, height: prepared.height + 32}} dangerouslySetInnerHTML={{__html: prepared.svg}} />;
});

function ScaleLabel() {
  // 平移时比例没变，不让每次 mousemove 都触发一次 React 更新。
  const percentage = useTransformComponent(({state}) => Math.round(state.scale * 100));
  return <span className={styles.scale} aria-label="图表缩放比例">{percentage}%</span>;
}

function WheelZoom({enabled}: {enabled: boolean}) {
  const controls = useControls();
  const {instance, zoomToPoint} = useRef(controls).current;
  useEffect(() => {
    const canvas = instance.wrapperComponent;
    if (!enabled || !canvas) return;
    let frame = 0;
    let targetScale: number | null = null;
    let point = {x: 0, y: 0};
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY || instance.isPanning || (event.target as Element).closest('a')) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
      const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
      // 按当前比例缩放，兼顾滚轮与触控板；一次最大约 8%，不在小图上突然放大几倍。
      targetScale = Math.max(0.02, Math.min(8, (targetScale ?? instance.state.scale) * Math.exp(-delta * 0.0008)));
      point = {x: event.clientX, y: event.clientY};
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        void zoomToPoint(targetScale!, point.x, point.y, 0);
        targetScale = null;
      });
    };
    canvas.addEventListener('wheel', onWheel, {passive: false});
    return () => {canvas.removeEventListener('wheel', onWheel); cancelAnimationFrame(frame);};
  }, [enabled, instance, zoomToPoint]);
  return null;
}

function FitOnResize() {
  // The library creates new handler functions on render; keep one set so
  // toggling interaction never resets a reader's chosen zoom.
  const controls = useControls();
  const {instance, fitToView} = useRef(controls).current;
  useEffect(() => {
    const canvas = instance.wrapperComponent;
    if (!canvas) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {void fitToView({animationTime: 0});});
    });
    observer.observe(canvas);
    return () => {observer.disconnect(); cancelAnimationFrame(frame);};
  }, [instance, fitToView]);
  return null;
}

function Controls({ready, interactive, setInteractive, fullscreen, expand, reducedMotion}: {
  ready: boolean; interactive: boolean; setInteractive: (value: boolean) => void;
  fullscreen: boolean; expand: () => void; reducedMotion: boolean;
}) {
  const {zoomIn, zoomOut, fitToView, centerView} = useControls();
  const duration = reducedMotion ? 0 : 160;
  return <div className={styles.toolbar} role="group" aria-label="图表工具">
    <span className={styles.title}>图表</span>
    <div className={styles.tools}>
      <button type="button" disabled={!ready} aria-label="缩小图表" title="缩小" onClick={() => void zoomOut(0.25, duration)}><Icon kind="minus" /></button>
      <ScaleLabel />
      <button type="button" disabled={!ready} aria-label="放大图表" title="放大" onClick={() => void zoomIn(0.25, duration)}><Icon kind="plus" /></button>
      <span className={styles.divider} />
      <button type="button" disabled={!ready} aria-label="适应画布" title="适应画布" onClick={() => void fitToView({animationTime: duration})}><Icon kind="fit" /></button>
      <button type="button" disabled={!ready} aria-label="原始比例" title="原始比例" onClick={() => void centerView(1, duration)}>1:1</button>
      <button type="button" disabled={!ready} aria-pressed={interactive} onClick={() => setInteractive(!interactive)}>拖动</button>
      <button type="button" disabled={!ready} aria-label={fullscreen ? '退出图表全屏' : '全屏查看图表'} title={fullscreen ? '退出全屏' : '全屏'} onClick={expand}><Icon kind="expand" /></button>
    </div>
  </div>;
}

export default function DiagramViewer({result}: {result: RenderResult | null}) {
  if (result) return <ReadyDiagramViewer result={result} />;
  // 长文中的离屏图只保留等高占位，不预先创建缩放实例、ResizeObserver 和全局手势监听。
  return <div className={styles.viewer} data-diagram-viewer="" data-interactive="false">
    <div className={styles.toolbar} role="group" aria-label="图表工具">
      <span className={styles.title}>图表</span>
      <div className={styles.tools}>
        <button type="button" disabled aria-label="缩小图表"><Icon kind="minus" /></button>
        <span className={styles.scale} aria-label="图表缩放比例">—</span>
        <button type="button" disabled aria-label="放大图表"><Icon kind="plus" /></button>
        <span className={styles.divider} />
        <button type="button" disabled aria-label="适应画布"><Icon kind="fit" /></button>
        <button type="button" disabled aria-label="原始比例">1:1</button>
        <button type="button" disabled>拖动</button>
        <button type="button" disabled aria-label="全屏查看图表"><Icon kind="expand" /></button>
      </div>
    </div>
    <div className={styles.stage} aria-busy="true"><div className={styles.placeholder} role="status">正在准备图表…</div></div>
    <div className={styles.caption}>滚动阅读文章 · 开启拖动可平移与缩放</div>
  </div>;
}

function ReadyDiagramViewer({result}: {result: RenderResult}) {
  const root = useRef<HTMLDivElement>(null);
  const [interactive, setInteractive] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [message, setMessage] = useState('');
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    const onFullscreen = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {media.removeEventListener('change', update); document.removeEventListener('fullscreenchange', onFullscreen);};
  }, []);
  const expand = async () => {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {setMessage('无法进入全屏，可使用放大和拖动查看。');}
  };
  return <div ref={root} className={styles.viewer} data-diagram-viewer="" data-interactive={interactive} onKeyDown={event => {
    if (event.key === 'Escape') setInteractive(false);
  }}>
    <TransformWrapper
      minScale={0.02}
      maxScale={8}
      fitOnInit
      centerZoomedOut={false}
      // 适应画布后，小图表也允许自由平移；阅读模式仍限制在画布范围内。
      limitToBounds={!interactive}
      wheel={{disabled: true}}
      panning={{disabled: !interactive, velocityDisabled: true, excluded: ['a']}}
      pinch={{disabled: !interactive}} doubleClick={{disabled: true}} keyboard={{disabled: !interactive, animationTime: reducedMotion ? 0 : 100}}
      velocityAnimation={{disabled: true}}
      zoomAnimation={{disabled: true}}
      // 拖动结束后不再自动把内容吸回边界，避免“拖不跟手”和松手跳位。
      autoAlignment={{disabled: true, animationTime: 0}}>
      <Controls ready={!!result} interactive={interactive} setInteractive={setInteractive} fullscreen={fullscreen} expand={() => void expand()} reducedMotion={reducedMotion} />
      <div className={styles.stage} aria-busy={!result}>
        {result ? <TransformComponent wrapperClass={styles.canvas} contentClass={styles.content} wrapperProps={{role: 'region', 'aria-label': '图表画布', tabIndex: interactive ? 0 : -1}}>
          <DiagramMarkup result={result} />
          <FitOnResize />
          <WheelZoom enabled={interactive} />
        </TransformComponent> : <div className={styles.placeholder} role="status">正在准备图表…</div>}
      </div>
      <div className={styles.caption} aria-live="polite">{message || (interactive ? '拖动平移 · 滚轮缩放 · 方向键移动 · Esc 结束拖动' : '滚动阅读文章 · 开启拖动可平移与缩放')}</div>
    </TransformWrapper>
  </div>;
}
