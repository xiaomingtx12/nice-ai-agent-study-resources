import type {ReactNode} from 'react';
import styles from './styles.module.css';

export function RouteProgress(): ReactNode {
  return <div className={styles.bar} role="status" aria-label="页面加载中" />;
}
