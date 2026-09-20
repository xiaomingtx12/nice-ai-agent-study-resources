import {useSyncExternalStore, type ReactNode} from 'react';
import {subscribeToRouteTransition, isRouteTransitionPending, serverRouteTransitionSnapshot} from '../../lib/routeTransition';
import styles from './styles.module.css';

export function RouteProgress(): ReactNode {
  return <div className={styles.bar} role="status" aria-label="页面加载中" />;
}

// Docusaurus 在目标文章就绪前保留旧页面，Loading fallback 不会显示。
// 订阅路由生命周期，在这段等待时间提供真实的加载反馈。
export function RouteNavigationFeedback(): ReactNode {
  const pending = useSyncExternalStore(subscribeToRouteTransition, isRouteTransitionPending, serverRouteTransitionSnapshot);
  return pending ? <RouteProgress /> : null;
}
