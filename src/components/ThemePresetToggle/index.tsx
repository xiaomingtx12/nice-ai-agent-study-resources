import clsx from 'clsx';
import type {ReactNode} from 'react';
import {useSiteTheme} from '@site/src/components/SiteThemeProvider';
import {SITE_THEME_PRESETS, type SiteThemeId} from '@site/src/lib/siteTheme';
import styles from './styles.module.css';

type ThemePresetToggleProps = {
  className?: string;
  mobile?: boolean;
  onClick?: () => void;
};

export default function ThemePresetToggle({
  className,
  mobile = false,
  onClick,
}: ThemePresetToggleProps): ReactNode {
  const {theme, setTheme} = useSiteTheme();

  function handleSelect(nextTheme: SiteThemeId) {
    setTheme(nextTheme);
    onClick?.();
  }

  const controls = (
    <div
      aria-label="Site theme preset"
      className={clsx(styles.wrapper, mobile && styles.mobile)}
      role="group">
      {SITE_THEME_PRESETS.map((preset) => {
        const isActive = preset.id === theme;

        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={isActive}
            className={clsx(styles.button, isActive && styles.buttonActive)}
            onClick={() => handleSelect(preset.id)}>
            {preset.label}
          </button>
        );
      })}
    </div>
  );

  if (mobile) {
    return (
      <li className={clsx('menu__list-item', className)}>
        <div className={clsx('menu__link', styles.mobileItem)}>
          {controls}
        </div>
      </li>
    );
  }

  return (
    <div className={clsx(styles.desktopItem, className)}>{controls}</div>
  );
}
