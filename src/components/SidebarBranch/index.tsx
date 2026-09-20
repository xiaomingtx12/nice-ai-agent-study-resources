import {memo, useEffect, useState, type ReactNode} from 'react';

// 目录只在首次展开时挂载，收起后保留内部层级状态。
// 直接切换 display，不测 scrollHeight，也不为大目录逐帧改变高度。
export default function SidebarBranch({collapsed, children, className}: {
  collapsed: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [visited, setVisited] = useState(!collapsed);
  useEffect(() => {
    if (!collapsed) setVisited(true);
  }, [collapsed]);
  if (collapsed && !visited) return null;
  return <ul className={className} hidden={collapsed} style={{display: collapsed ? 'none' : 'block'}}>
    <RetainedChildren collapsed={collapsed}>{children}</RetainedChildren>
  </ul>;
}

// 关闭的分支无需因为 tabIndex/activePath 改变而重复遍历；重新打开时接收最新内容。
const RetainedChildren = memo(
  ({children}: {children: ReactNode; collapsed: boolean}) => <>{children}</>,
  (previous, next) => next.collapsed || previous.children === next.children,
);
