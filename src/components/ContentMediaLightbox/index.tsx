import {useEffect, useRef, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import styles from './styles.module.css';

const ARTICLE_MERMAID_SVG_SELECTOR = 'article .docusaurus-mermaid-container svg';

type LightboxState = {label: string; markup: string} | null;

function cloneMermaidMarkup(svg: SVGSVGElement): string {
  const clonedSvg = svg.cloneNode(true) as SVGSVGElement;
  const viewBox = clonedSvg
    .getAttribute('viewBox')
    ?.trim()
    .split(/\s+/)
    .map((value) => Number(value));
  const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined;

  clonedSvg.removeAttribute('width');
  clonedSvg.removeAttribute('height');
  clonedSvg.style.maxWidth = 'none';
  clonedSvg.style.height = 'auto';

  if (viewBoxWidth && Number.isFinite(viewBoxWidth)) {
    clonedSvg.style.width = String(viewBoxWidth) + 'px';
  }

  return clonedSvg.outerHTML;
}

export function ContentMediaLightbox() {
  const location = useLocation();
  const [lightbox, setLightbox] = useState<LightboxState>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLightbox(null);
  }, [location.pathname]);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-diagram-viewer]')) return;

      const mermaidSvg = event.target.closest(ARTICLE_MERMAID_SVG_SELECTOR);
      if (!(mermaidSvg instanceof SVGSVGElement)) return;

      event.preventDefault();
      setLightbox({
        label: '流程图预览',
        markup: cloneMermaidMarkup(mermaidSvg),
      });
    };

    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, []);

  useEffect(() => {
    if (!lightbox) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightbox(null);
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleEscape);
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleEscape);
    };
  }, [lightbox]);

  if (!lightbox) return null;

  return (
    <div className={styles.overlay} onClick={() => setLightbox(null)}>
      <div
        aria-label={lightbox.label}
        aria-modal="true"
        className={styles.dialog}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}>
        <button
          aria-label="关闭预览"
          className={styles.closeButton}
          onClick={() => setLightbox(null)}
          type="button">
          ×
        </button>
        <div className={styles.surface}>
          <div
            className={styles.contentMermaid}
            dangerouslySetInnerHTML={{__html: lightbox.markup}}
          />
        </div>
      </div>
    </div>
  );
}
