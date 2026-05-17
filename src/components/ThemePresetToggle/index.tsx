import clsx from 'clsx';
import type {ReactNode} from 'react';
import {useSiteTheme} from '@site/src/components/SiteThemeProvider';
import {SITE_THEME_PRESETS} from '@site/src/lib/siteTheme';
import styles from './styles.module.css';

type ThemePresetToggleProps = {
  className?: string;
  mobile?: boolean;
};

export default function ThemePresetToggle({
  className,
  mobile = false,
}: ThemePresetToggleProps): ReactNode {
  const {theme, setTheme} = useSiteTheme();

  return (
    <div
      aria-label="Site theme preset"
      className={clsx(styles.wrapper, className, mobile && styles.mobile)}
      role="group">
      {SITE_THEME_PRESETS.map((preset) => {
        const isActive = preset.id === theme;

        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={isActive}
            className={clsx(styles.button, isActive && styles.buttonActive)}
            onClick={() => setTheme(preset.id)}>
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
