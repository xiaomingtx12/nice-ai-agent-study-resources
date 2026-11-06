import React, {isValidElement, type ReactNode} from 'react';
import ElementContent from '@theme/CodeBlock/Content/Element';
import StringContent from '@theme/CodeBlock/Content/String';
import type {Props} from '@theme/CodeBlock';

export default function CodeBlock({children: rawChildren, ...props}: Props): ReactNode {
  const children = React.Children.toArray(rawChildren).some(isValidElement)
    ? rawChildren
    : Array.isArray(rawChildren) ? rawChildren.join('') : rawChildren;
  const Content = typeof children === 'string' ? StringContent : ElementContent;
  // 配色已由 CSS 决定，无需框架默认的 isBrowser key 在挂载后重建全部代码块。
  return <Content {...props}>{children as string}</Content>;
}
