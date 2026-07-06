import {useEffect, useRef, useState} from 'react';
import type {ComponentProps, ReactNode} from 'react';
import MermaidOriginal from '@theme-original/Mermaid';
import styles from './styles.module.css';

type Props = ComponentProps<typeof MermaidOriginal>;

const ROOT_MARGIN = '100px 0px';
const PLACEHOLDER_MIN_HEIGHT = 120;

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

  if (visible) {
    return (
      <div className={styles.lazyWrapper}>
        <MermaidOriginal {...props} />
      </div>
    );
  }

  return <div ref={containerRef} style={{minHeight: PLACEHOLDER_MIN_HEIGHT}} />;
}
