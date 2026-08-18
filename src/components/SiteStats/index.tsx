import type {ReactNode} from 'react';
import {usePluginData} from '@docusaurus/useGlobalData';
import type {SiteStats as SiteStatsData} from '../../lib/siteStats';

export type SiteStatKey = 'resources' | 'applicationNotes' | 'notes';

type SiteCountProps = {
  stat: SiteStatKey;
};

export default function SiteStats(): ReactNode {
  const stats = usePluginData('site-stats') as SiteStatsData;

  if (!stats) {
    return null;
  }

  return (
    <p className="home-hero-meta">
      {stats.resources} 条收录资源 · {stats.applicationNotes} 篇源码拆解 ·{' '}
      {stats.notes} 篇方法复盘 · 更新至 {stats.updatedAt}
    </p>
  );
}

export function SiteCount({stat}: SiteCountProps): ReactNode {
  const stats = usePluginData('site-stats') as SiteStatsData;
  return stats?.[stat] ?? 0;
}
