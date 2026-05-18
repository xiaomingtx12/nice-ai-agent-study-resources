import clsx from 'clsx';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const desktopRef = useRef<HTMLDivElement | null>(null);
  const currentPreset =
    SITE_THEME_PRESETS.find((preset) => preset.id === theme) ?? SITE_THEME_PRESETS[0];

  useEffect(() => {
    if (mobile || !isOpen) {
      return undefined;
    }

    function handlePointerDown(event: MouseEvent) {
      if (
        desktopRef.current &&
        event.target instanceof Node &&
        !desktopRef.current.contains(event.target)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, mobile]);

  function handleSelect(nextTheme: SiteThemeId) {
    setTheme(nextTheme);
    setIsOpen(false);
    onClick?.();
  }

  const controls = (
    <div
      aria-label="选择站点主题"
      className={clsx(styles.options, mobile ? styles.mobileOptions : styles.desktopOptions)}
      role="group">
      {SITE_THEME_PRESETS.map((preset) => {
        const isActive = preset.id === theme;

        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={isActive}
            aria-label={`切换到${preset.label}`}
            className={clsx(
              styles.optionButton,
              isActive && styles.buttonActive,
            )}
            onClick={() => handleSelect(preset.id)}>
            <span
              aria-hidden="true"
              className={styles.palettePreview}
              data-preset={preset.id}>
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
            </span>
            <span className={styles.optionLabel}>{preset.label}</span>
          </button>
        );
      })}
    </div>
  );

  if (mobile) {
    return (
      <li className={clsx('menu__list-item', className)}>
        <div className={styles.mobilePanel}>
          <button
            type="button"
            className={styles.mobileTrigger}
            aria-label={`切换主题，当前为${currentPreset.label}`}
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={() => setIsOpen((open) => !open)}>
            <span className={styles.mobileTriggerCopy}>
              <span className={styles.mobileTitle}>主题样式</span>
              <span className={styles.mobileCurrent}>{currentPreset.label}</span>
            </span>
            <span
              aria-hidden="true"
              className={styles.mobileTriggerPreview}
              data-preset={theme}>
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
              <span className={styles.previewSwatch} />
            </span>
          </button>
          {isOpen ? (
            <div id={panelId} className={styles.mobileTray}>
              {controls}
            </div>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <div ref={desktopRef} className={clsx(styles.desktopItem, className)}>
      <button
        type="button"
        className={styles.desktopTrigger}
        aria-label={`切换主题，当前为${currentPreset.label}`}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((open) => !open)}>
        <span
          aria-hidden="true"
          className={styles.desktopTriggerPreview}
          data-preset={theme}>
          <span className={styles.previewSwatch} />
          <span className={styles.previewSwatch} />
          <span className={styles.previewSwatch} />
        </span>
      </button>
      {isOpen ? (
        <div id={panelId} className={styles.desktopPopover}>
          <p className={styles.panelTitle}>主题样式</p>
          {controls}
        </div>
      ) : null}
    </div>
  );
}
