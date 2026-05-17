import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  DEFAULT_SITE_THEME,
  SITE_THEME_STORAGE_KEY,
  getInitialSiteTheme,
  type SiteThemeId,
} from '../../lib/siteTheme';

type SiteThemeContextValue = {
  theme: SiteThemeId;
  setTheme: Dispatch<SetStateAction<SiteThemeId>>;
};

const SiteThemeContext = createContext<SiteThemeContextValue | null>(null);

function getBrowserTheme(): SiteThemeId {
  if (typeof window === 'undefined') {
    return DEFAULT_SITE_THEME;
  }

  try {
    return getInitialSiteTheme(window.localStorage.getItem(SITE_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_SITE_THEME;
  }
}

export function SiteThemeProvider({children}: {children: ReactNode}) {
  const [theme, setTheme] = useState<SiteThemeId>(() => getBrowserTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-site-theme', theme);

    try {
      window.localStorage.setItem(SITE_THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore blocked storage and keep the in-memory/provider state authoritative.
    }
  }, [theme]);

  return (
    <SiteThemeContext.Provider value={{theme, setTheme}}>
      {children}
    </SiteThemeContext.Provider>
  );
}

export function useSiteTheme() {
  const context = useContext(SiteThemeContext);

  if (context === null) {
    throw new Error('useSiteTheme must be used within SiteThemeProvider');
  }

  return context;
}
