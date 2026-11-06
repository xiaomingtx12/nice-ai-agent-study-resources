import React, {startTransition, type ReactNode} from 'react';
import {Route} from 'react-router-dom';
import type {Location} from 'history';
import ClientLifecyclesDispatcher, {dispatchLifecycleAction} from '@docusaurus/core/lib/client/ClientLifecyclesDispatcher';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';
import preload from '@docusaurus/core/lib/client/preload';

type Props = {location: Location; children: ReactNode};
type State = {location: Location; previousLocation: Location | null};

// 针对 Docusaurus 3.10 的路由等待边界：保留已提交文章，以最后一次导航为准。
// 升级 Docusaurus 时先运行 PendingNavigation.test.mjs，并核对内部生命周期接口。
export default class PendingNavigation extends React.Component<Props, State> {
  private requestId = 0;
  private cleanup: () => void;

  constructor(props: Props) {
    super(props);
    this.state = {location: props.location, previousLocation: null};
    this.cleanup = ExecutionEnvironment.canUseDOM
      ? dispatchLifecycleAction('onRouteUpdate', {previousLocation: null, location: props.location})
      : () => {};
  }

  componentDidUpdate(previousProps: Props) {
    if (previousProps.location === this.props.location) return;
    const requestId = ++this.requestId;
    const location = this.props.location;
    this.cleanup();
    this.cleanup = dispatchLifecycleAction('onRouteUpdate', {
      previousLocation: this.state.location,
      location,
    });

    preload(location.pathname).then(() => {
      if (requestId !== this.requestId) return;
      this.cleanup();
      this.cleanup = () => {};
      // 长文的 React 渲染可以让出执行权，导航控件保持可响应。
      startTransition(() => this.setState((state) => requestId === this.requestId
        ? {previousLocation: state.location, location}
        : null));
    }).catch((error: unknown) => {
      if (requestId !== this.requestId) return;
      // 当前页面的部署文件已失效时，仍沿用框架的刷新恢复行为。
      console.warn(error);
      window.location.reload();
    });
  }

  componentWillUnmount() {
    this.requestId += 1;
    this.cleanup();
  }

  render() {
    const {location, previousLocation} = this.state;
    return (
      <ClientLifecyclesDispatcher location={location} previousLocation={previousLocation}>
        <Route location={location} render={() => this.props.children} />
      </ClientLifecyclesDispatcher>
    );
  }
}
