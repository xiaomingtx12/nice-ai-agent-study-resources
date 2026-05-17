import type {ReactNode} from 'react';
import type {Props} from '@theme/Root';
import {SiteThemeProvider} from '../components/SiteThemeProvider';

export default function Root({children}: Props): ReactNode {
  return <SiteThemeProvider>{children}</SiteThemeProvider>;
}
