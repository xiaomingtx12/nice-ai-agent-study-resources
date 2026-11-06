import type {ReactNode} from 'react';
import type {Props} from '@theme/Root';
import {ContentMediaLightbox} from '../components/ContentMediaLightbox';
import {SiteThemeProvider} from '../components/SiteThemeProvider';
import {RouteNavigationFeedback} from '../components/RouteProgress';

export default function Root({children}: Props): ReactNode {
  return (
    <SiteThemeProvider>
      {children}
      <RouteNavigationFeedback />
      <ContentMediaLightbox />
    </SiteThemeProvider>
  );
}
