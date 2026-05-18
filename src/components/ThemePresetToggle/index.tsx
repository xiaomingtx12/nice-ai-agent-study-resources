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
      className={clsx(styles.wrapper, mobile ? styles.mobileWrapper : styles.desktopWrapper)}
      role="group">
      {SITE_THEME_PRESETS.map((preset) => {
        const isActive = preset.id === theme;

        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={isActive}
            aria-label={preset.label}
            className={clsx(
              styles.button,
              mobile ? styles.buttonMobile : styles.buttonDesktop,
              isActive && styles.buttonActive,
            )}
            data-preset={preset.id}
            onClick={() => handleSelect(preset.id)}>
            <span aria-hidden="true" className={styles.preview}>
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
            </span>
            <span className={styles.buttonLabel}>{preset.label}</span>
          </button>
        );
      })}
    </div>
  );

  if (mobile) {
    return (
      <li className={clsx('menu__list-item', className)}>
        <div className={styles.mobilePanel}>
          <p className={styles.mobileTitle}>主题样式</p>
          {controls}
        </div>
      </li>
    );
  }

  return (
    <div className={clsx(styles.desktopItem, className)}>
      <span className={styles.desktopTitle}>Styles</span>
      {controls}
    </div>
  );
}
