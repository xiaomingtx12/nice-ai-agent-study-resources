type RouteUpdate = {
  location: {pathname: string};
  previousLocation: {pathname: string} | null;
};

let destination: string | null = null;
const listeners = new Set<() => void>();

function notify() {
  // onRouteUpdate 由路由组件的渲染过程触发，订阅更新移到微任务。
  queueMicrotask(() => listeners.forEach((listener) => listener()));
}

export function onRouteUpdate({location, previousLocation}: RouteUpdate) {
  if (!previousLocation) return;
  if (location.pathname === previousLocation.pathname) {
    // 用户返回仍在显示的文章，也要撤销此前的加载状态。
    if (destination !== null) {destination = null; notify();}
    return;
  }
  destination = location.pathname;
  notify();
}

export function onRouteDidUpdate({location}: RouteUpdate) {
  if (destination !== location.pathname) return;
  destination = null;
  notify();
}

export function subscribeToRouteTransition(listener: () => void) {
  listeners.add(listener);
  return () => {listeners.delete(listener);};
}

export const isRouteTransitionPending = () => destination !== null;
export const serverRouteTransitionSnapshot = () => false;
