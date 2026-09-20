import {useMemo, type ReactNode} from 'react';
import clsx from 'clsx';
import {useCodeBlockContext} from '@docusaurus/theme-common/internal';
import {Prism, useTokenize} from 'prism-react-renderer';
import {renderTokenMarkup} from './tokenMarkup';
import styles from './styles.module.css';

export default function CodeBlockContent({className}: {className?: string}): ReactNode {
  const {metadata, wordWrap} = useCodeBlockContext();
  const {code, lineNumbersStart, lineClassNames} = metadata;
  const language = metadata.language.toLowerCase();
  const lines = useTokenize({prism: Prism, code, language, grammar: Prism.languages[language]});
  // Word-wrap state recreates metadata; compare its content instead of its identity.
  const lineClassesKey = JSON.stringify(lineClassNames);
  const numbered = lineNumbersStart !== undefined;
  const markup = useMemo(() => ({__html: renderTokenMarkup(lines, JSON.parse(lineClassesKey), numbered)}), [lines, lineClassesKey, numbered]);

  // Both SSR and the first browser render include all syntax highlighting.
  return (
    <pre ref={wordWrap.codeBlockRef} tabIndex={0} className={clsx(className, 'prism-code', 'language-' + language, styles.codeBlock, 'thin-scrollbar')}>
      <code
        className={clsx(styles.codeBlockLines, numbered && styles.codeBlockLinesWithNumbering)}
        style={numbered ? {counterReset: 'line-count ' + (lineNumbersStart - 1)} : undefined}
        dangerouslySetInnerHTML={markup}
      />
    </pre>
  );
}
