import {useCallback, useEffect, useRef, useState} from 'react';
import {useLocation} from '@docusaurus/router';
import styles from './styles.module.css';
import {
  ARTICLE_IMAGE_SELECTOR,
  ARTICLE_MERMAID_SVG_SELECTOR,
  ARTICLE_SELECTOR,
  collectMutationDecorationRoots,
  decorateContentMediaSubtree,
  redecorateContentImage,
} from './dom';

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

type IdleHandle = number;

function getPreviewLabel(image: HTMLImageElement): string {
  const alt = image.alt.trim();
  return alt || '图片预览';
}

function requestIdleCallbackPolyfill(callback: IdleRequestCallback): IdleHandle {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    return window.requestIdleCallback(callback);
  }

  return window.setTimeout(
    () =>
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      }),
    1,
  ) as IdleHandle;
}

function cancelIdleCallbackPolyfill(handle: IdleHandle): void {
  if (typeof window === 'undefined') {
    return;
  }

  if ('cancelIdleCallback' in window) {
    window.cancelIdleCallback(handle);
    return;
  }

  window.clearTimeout(handle);
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
  const pendingImageListenersRef = useRef(new WeakSet<HTMLImageElement>());
  const decorationStyles = useRef({
    triggerImage: styles.triggerImage,
    triggerMermaid: styles.triggerMermaid,
  });

  const handlePendingImageLoad = useCallback((event: Event) => {
    const image = event.currentTarget;

    if (!(image instanceof HTMLImageElement)) {
      return;
    }

    pendingImageListenersRef.current.delete(image);
    redecorateContentImage(image, decorationStyles.current);
  }, []);

  useEffect(() => {
    setLightbox(null);
  }, [location.pathname]);

  const decorateSubtree = useCallback(
    (root: ParentNode) => {
      const pendingLoadImages = decorateContentMediaSubtree(root, decorationStyles.current);

      pendingLoadImages.forEach((image) => {
        if (pendingImageListenersRef.current.has(image)) {
          return;
        }

        pendingImageListenersRef.current.add(image);
        image.addEventListener('load', handlePendingImageLoad, {once: true});
      });
    },
    [handlePendingImageLoad],
  );

  useEffect(() => {
    const observerRoot = document.querySelector(ARTICLE_SELECTOR) ?? document.querySelector('main');

    if (!observerRoot) {
      return;
    }

    let idleHandle: IdleHandle | null = null;
    const pendingRoots = new Set<Element>();

    const flushDecorations = () => {
      idleHandle = null;

      pendingRoots.forEach((root) => {
        decorateSubtree(root);
      });

      pendingRoots.clear();
    };

    const scheduleDecoration = (root: Element) => {
      pendingRoots.add(root);

      if (idleHandle !== null) {
        return;
      }

      idleHandle = requestIdleCallbackPolyfill(flushDecorations);
    };

    decorateSubtree(observerRoot);

    const observer = new MutationObserver((mutations) => {
      collectMutationDecorationRoots(mutations).forEach((root) => {
        scheduleDecoration(root);
      });
    });

    observer.observe(observerRoot, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      pendingRoots.clear();

      if (idleHandle !== null) {
        cancelIdleCallbackPolyfill(idleHandle);
        idleHandle = null;
      }
    };
  }, [decorateSubtree, location.pathname]);

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

      const mermaidSvg = event.target.closest(ARTICLE_MERMAID_SVG_SELECTOR);

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
