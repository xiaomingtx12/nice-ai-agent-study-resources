import {forwardRef} from 'react';
import type {CSSProperties, ReactNode, RefObject} from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import {Highlight} from 'prism-react-renderer';
import Line from '@theme/CodeBlock/Line';
import styles from './styles.module.css';

// 高亮样式由 CSS token 提供，换配色不再让每个已读代码块重建 token 树。
const syntaxTheme = {plain: {}, styles: []};

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
  const {code, language, lineNumbersStart, lineClassNames} = metadata;
  const codeBlockRef = wordWrap.codeBlockRef as RefObject<HTMLPreElement>;

  // 服务端与浏览器首次渲染都输出完整 token，只有 CSS 决定当前配色。
  return (
    <Highlight theme={syntaxTheme} code={code} language={language}>
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
