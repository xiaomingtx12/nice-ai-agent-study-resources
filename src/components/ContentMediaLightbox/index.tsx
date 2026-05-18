import {useCallback, useEffect, useRef, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import styles from './styles.module.css';

const ARTICLE_IMAGE_SELECTOR = 'article img';
const MERMAID_SVG_SELECTOR = 'article .docusaurus-mermaid-container svg';

type LightboxState =
  | {
      kind: 'image';
      alt: string;
      src: string;
    }
  | {
      kind: 'mermaid';
      label: string;
      markup: string;
    }
  | null;

function isQualifyingContentImage(image: HTMLImageElement): boolean {
  if (image.closest('a')) {
    return false;
  }

  const src = image.currentSrc || image.src;

  if (!src) {
    return false;
  }

  const rect = image.getBoundingClientRect();
  const intrinsicWidth = image.naturalWidth || rect.width;
  const intrinsicHeight = image.naturalHeight || rect.height;

  return intrinsicWidth >= 96 || intrinsicHeight >= 96;
}

function getPreviewLabel(image: HTMLImageElement): string {
  const alt = image.alt.trim();
  return alt || '图片预览';
}

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
    clonedSvg.style.width = `${viewBoxWidth}px`;
  }

  return clonedSvg.outerHTML;
}

export function ContentMediaLightbox() {
  const location = useLocation();
  const [lightbox, setLightbox] = useState<LightboxState>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const decorateContentMedia = useCallback(() => {
    const contentImages = document.querySelectorAll(ARTICLE_IMAGE_SELECTOR);

    contentImages.forEach((node) => {
      if (!(node instanceof HTMLImageElement)) {
        return;
      }

      const isEligible = isQualifyingContentImage(node);

      node.classList.toggle(styles.triggerImage, isEligible);
      node.toggleAttribute('data-content-lightbox-trigger', isEligible);
    });

    const mermaidSvgs = document.querySelectorAll(MERMAID_SVG_SELECTOR);

    mermaidSvgs.forEach((node) => {
      if (!(node instanceof SVGSVGElement)) {
        return;
      }

      node.classList.add(styles.triggerMermaid);
      node.setAttribute('data-content-lightbox-trigger', 'true');
    });
  }, []);

  useEffect(() => {
    setLightbox(null);
  }, [location.pathname]);

  useEffect(() => {
    let frame = 0;

    const scheduleDecoration = () => {
      if (frame !== 0) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        frame = 0;
        decorateContentMedia();
      });
    };

    decorateContentMedia();

    const observer = new MutationObserver(() => {
      scheduleDecoration();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();

      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [decorateContentMedia, location.pathname]);

  useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) {
        return;
      }

      if (!(event.target instanceof Element)) {
        return;
      }

      const image = event.target.closest(ARTICLE_IMAGE_SELECTOR);

      if (image instanceof HTMLImageElement && image.classList.contains(styles.triggerImage)) {
        event.preventDefault();
        setLightbox({
          kind: 'image',
          alt: getPreviewLabel(image),
          src: image.currentSrc || image.src,
        });
        return;
      }

      const mermaidSvg = event.target.closest(MERMAID_SVG_SELECTOR);

      if (mermaidSvg instanceof SVGSVGElement) {
        event.preventDefault();
        setLightbox({
          kind: 'mermaid',
          label: '流程图预览',
          markup: cloneMermaidMarkup(mermaidSvg),
        });
      }
    };

    document.addEventListener('click', handleDocumentClick);

    return () => {
      document.removeEventListener('click', handleDocumentClick);
    };
  }, []);

  useEffect(() => {
    if (!lightbox) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLightbox(null);
      }
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

  if (!lightbox) {
    return null;
  }

  return (
    <div
      className={styles.overlay}
      onClick={() => {
        setLightbox(null);
      }}>
      <div
        aria-label={lightbox.kind === 'image' ? lightbox.alt : lightbox.label}
        aria-modal="true"
        className={styles.dialog}
        onClick={(event) => {
          event.stopPropagation();
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}>
        <button
          aria-label="关闭预览"
          className={styles.closeButton}
          onClick={() => {
            setLightbox(null);
          }}
          type="button">
          ×
        </button>
        <div className={styles.surface}>
          {lightbox.kind === 'image' ? (
            <img alt={lightbox.alt} className={styles.contentImage} src={lightbox.src} />
          ) : (
            <div
              className={styles.contentMermaid}
              dangerouslySetInnerHTML={{__html: lightbox.markup}}
            />
          )}
        </div>
      </div>
    </div>
  );
}
