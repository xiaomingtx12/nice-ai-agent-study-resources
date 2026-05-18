const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;
const LIGHTBOX_IMAGE_SELECTOR = 'img';
const LIGHTBOX_MERMAID_SELECTOR = '.docusaurus-mermaid-container svg';

export const ARTICLE_SELECTOR = 'article';
export const ARTICLE_IMAGE_SELECTOR = `${ARTICLE_SELECTOR} ${LIGHTBOX_IMAGE_SELECTOR}`;
export const ARTICLE_MERMAID_SVG_SELECTOR = `${ARTICLE_SELECTOR} ${LIGHTBOX_MERMAID_SELECTOR}`;
export const LIGHTBOX_TRIGGER_ATTRIBUTE = 'data-content-lightbox-trigger';

type DecorationStyles = {
  triggerImage: string;
  triggerMermaid: string;
};

function isElementNode(node: unknown): node is Element {
  return Boolean(node) && (node as Node).nodeType === ELEMENT_NODE;
}

function getOwnerDocument(root: ParentNode): Document | null {
  const candidate = root as Node & {ownerDocument?: Document | null};

  if (candidate.nodeType === DOCUMENT_NODE) {
    return candidate as unknown as Document;
  }

  return candidate.ownerDocument ?? null;
}

function getElementConstructors(root: ParentNode) {
  const defaultView = getOwnerDocument(root)?.defaultView;

  return {
    HTMLImageElement: defaultView?.HTMLImageElement,
    SVGSVGElement: defaultView?.SVGSVGElement,
  };
}

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

function collectSubtreeElements<T extends Element>(
  root: ParentNode,
  selector: string,
  matchesElement: (node: Element) => node is T,
): T[] {
  const matches: T[] = [];

  if (isElementNode(root) && root.matches(selector) && matchesElement(root)) {
    matches.push(root);
  }

  root.querySelectorAll(selector).forEach((node) => {
    if (matchesElement(node)) {
      matches.push(node);
    }
  });

  return matches;
}

function decorateContentImage(image: HTMLImageElement, styles: DecorationStyles): boolean {
  const isEligible = isQualifyingContentImage(image);

  image.classList.toggle(styles.triggerImage, isEligible);
  image.toggleAttribute(LIGHTBOX_TRIGGER_ATTRIBUTE, isEligible);

  return !image.complete;
}

function decorateMermaidSvg(svg: SVGSVGElement, styles: DecorationStyles): void {
  svg.classList.add(styles.triggerMermaid);
  svg.setAttribute(LIGHTBOX_TRIGGER_ATTRIBUTE, 'true');
}

export function collectMutationDecorationRoots(
  mutations: Iterable<Pick<MutationRecord, 'addedNodes'>>,
): Element[] {
  const roots: Element[] = [];
  const seen = new Set<Element>();

  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (!isElementNode(node) || seen.has(node)) {
        return;
      }

      seen.add(node);
      roots.push(node);
    });
  }

  return roots;
}

export function decorateContentMediaSubtree(
  root: ParentNode,
  styles: DecorationStyles,
): HTMLImageElement[] {
  const {HTMLImageElement, SVGSVGElement} = getElementConstructors(root);

  if (!HTMLImageElement || !SVGSVGElement) {
    return [];
  }

  const pendingLoadImages: HTMLImageElement[] = [];
  const contentImages = collectSubtreeElements(
    root,
    LIGHTBOX_IMAGE_SELECTOR,
    (node): node is HTMLImageElement => node instanceof HTMLImageElement,
  );

  contentImages.forEach((image) => {
    if (decorateContentImage(image, styles)) {
      pendingLoadImages.push(image);
    }
  });

  const mermaidSvgs = collectSubtreeElements(
    root,
    LIGHTBOX_MERMAID_SELECTOR,
    (node): node is SVGSVGElement => node instanceof SVGSVGElement,
  );

  mermaidSvgs.forEach((svg) => {
    decorateMermaidSvg(svg, styles);
  });

  return pendingLoadImages;
}
