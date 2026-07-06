import {forwardRef, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {CSSProperties, ReactNode, RefObject} from 'react';
import clsx from 'clsx';
import useIsBrowser from '@docusaurus/useIsBrowser';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import {usePrismTheme} from '@docusaurus/theme-common';
import {Highlight} from 'prism-react-renderer';
import Line from '@theme/CodeBlock/Line';
import styles from './styles.module.css';

// useLayoutEffect on the client avoids a 1-frame flash of unhighlighted code
// for above-the-fold blocks (the visibility check + setState complete before
// the browser paints). Falls back to useEffect on the server to avoid the
// useLayoutEffect SSR warning.
const useIsoLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const Pre = forwardRef<HTMLPreElement, React.HTMLAttributes<HTMLPreElement>>(
  (props, ref) => (
    <pre
      ref={ref}
      /* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */
      tabIndex={0}
      {...props}
      className={clsx(props.className, styles.codeBlock, 'thin-scrollbar')}
    />
  ),
);

function Code(
  props: React.HTMLAttributes<HTMLElement> & {children?: ReactNode},
): ReactNode {
  const {metadata} = useCodeBlockContext();
  return (
    <code
      {...props}
      className={clsx(
        props.className,
        styles.codeBlockLines,
        metadata.lineNumbersStart !== undefined &&
          styles.codeBlockLinesWithNumbering,
      )}
      style={{
        ...(props.style as CSSProperties),
        counterReset:
          metadata.lineNumbersStart === undefined
            ? undefined
            : `line-count ${metadata.lineNumbersStart - 1}`,
      }}
    />
  );
}

export default function CodeBlockContent({
  className: classNameProp,
}: {
  className?: string;
}): ReactNode {
  const {metadata, wordWrap} = useCodeBlockContext();
  const prismTheme = usePrismTheme();
  const {code, language, lineNumbersStart, lineClassNames} = metadata;
  const isBrowser = useIsBrowser();
  // wordWrap.codeBlockRef is the <pre> ref the word-wrap button measures. We
  // attach it in BOTH branches so useCodeWordWrap's effect never sees null.
  const codeBlockRef = wordWrap.codeBlockRef as RefObject<HTMLPreElement>;
  const [highlight, setHighlight] = useState(false);

  useIsoLayoutEffect(() => {
    if (!isBrowser || highlight) {
      return;
    }
    const el = codeBlockRef.current;
    if (el === null) {
      return;
    }
    // Degenerate viewport (headless render, hidden tab): can't determine
    // visibility, so highlight immediately rather than waiting forever.
    if (window.innerHeight === 0) {
      setHighlight(true);
      return;
    }
    // Above-the-fold blocks highlight immediately (before paint) to avoid a
    // flash of unstyled code on initial load.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200 && rect.bottom > -200) {
      setHighlight(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setHighlight(true);
          observer.disconnect();
        }
      },
      {rootMargin: '200px 0px'},
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isBrowser, highlight, codeBlockRef]);

  if (isBrowser && highlight) {
    return (
      <Highlight theme={prismTheme} code={code} language={language}>
        {({className, style, tokens: lines, getLineProps, getTokenProps}) => (
          <Pre
            ref={codeBlockRef}
            className={clsx(classNameProp, className)}
            style={style}>
            <Code>
              {lines.map((line, i) => (
                <Line
                  key={i}
                  line={line}
                  getLineProps={getLineProps}
                  getTokenProps={getTokenProps}
                  classNames={lineClassNames[i]}
                  showLineNumbers={lineNumbersStart !== undefined}
                />
              ))}
            </Code>
          </Pre>
        )}
      </Highlight>
    );
  }

  // Fallback: raw code without Prism tokenization. Rendered on SSG and before
  // the block scrolls into view. Same Pre/Code classes as the highlighted
  // branch so layout (height/width) matches and there's no shift on swap.
  return (
    <Pre ref={codeBlockRef} className={clsx(classNameProp)}>
      <Code>{code}</Code>
    </Pre>
  );
}
