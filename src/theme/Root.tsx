import type {ReactNode} from 'react';
import type {Props} from '@theme/Root';
import {ContentMediaLightbox} from '../components/ContentMediaLightbox';
import {SiteThemeProvider} from '../components/SiteThemeProvider';

export default function Root({children}: Props): ReactNode {
  return (
    <SiteThemeProvider>
      {children}
      <ContentMediaLightbox />
    </SiteThemeProvider>
  );
}
