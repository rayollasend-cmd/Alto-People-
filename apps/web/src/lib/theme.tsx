import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Light / dark / system theme. Persists the user's choice in localStorage
 * and applies it via `data-theme` on the html element so CSS variables
 * swap with no React re-render cost. Defaults to "system" — a field
 * workforce reads this outdoors, and forcing dark on a light-mode phone
 * is the worst sunlight-legibility case. Users can still pin either.
 *
 * Two values flow through the context:
 *   - preference: what the user picked ('light' | 'dark' | 'system') —
 *     this is what gets persisted and what the settings UI checks.
 *   - theme: the *resolved* concrete value ('light' | 'dark') currently
 *     applied to <html data-theme>. When preference is 'system' this
 *     follows `prefers-color-scheme` and flips live when the OS changes.
 *
 * The early-paint script in main.tsx mirrors the resolution logic so
 * the first frame already has the right data-theme set — no flash.
 */

export type Theme = 'dark' | 'light';
export type ThemePreference = Theme | 'system';

const STORAGE_KEY = 'alto.theme';
const DEFAULT_PREFERENCE: ThemePreference = 'system';

// Browser/OS chrome color per theme (status bar in installed mode, tab
// strip on Android). Mirrors --color-midnight in index.css.
const THEME_COLOR: Record<Theme, string> = {
  dark: '#0B1832',
  light: '#F8FAFC',
};

interface ThemeContextValue {
  /** User's stored choice (drives the settings UI). */
  preference: ThemePreference;
  /** Currently-applied concrete theme (drives styling decisions in JS). */
  theme: Theme;
  setTheme: (preference: ThemePreference) => void;
  /** Cycles light → dark → light (or system → opposite-of-current → ...). */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readSystemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function readInitialPreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') {
      return stored;
    }
  } catch {
    /* localStorage may throw in private mode — fall through */
  }
  return DEFAULT_PREFERENCE;
}

function resolveTheme(pref: ThemePreference): Theme {
  return pref === 'system' ? readSystemTheme() : pref;
}

function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  // Keep the browser/OS chrome in step — a light app under a navy status
  // bar reads as a mismatched website, not an app.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLOR[theme]);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readInitialPreference(),
  );
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(readInitialPreference()),
  );

  // Apply the resolved theme on every preference / OS change. Synchronous
  // before paint so the first render already has the right colors.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // When preference is 'system', listen for OS-level color-scheme flips
  // and re-resolve. Subscribed only while the user has 'system' selected
  // so light/dark users don't pay for an unused listener.
  useEffect(() => {
    if (preference !== 'system') {
      setTheme(preference);
      return;
    }
    setTheme(readSystemTheme());
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(mq.matches ? 'dark' : 'light');
    // Safari < 14 only exposes the legacy addListener API. Both shapes
    // are present in modern browsers; we prefer addEventListener so the
    // signature matches the rest of our DOM listeners.
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [preference]);

  const setThemePreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* persistence is best-effort */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    // Toggle is a quick light/dark flip — it ignores 'system' (intentional
    // shortcut for the keyboard sidekick). Sets an explicit preference so
    // the user's flip "sticks" rather than getting overwritten on the
    // next OS color-scheme change.
    setPreferenceState((prev) => {
      const current = prev === 'system' ? readSystemTheme() : prev;
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      preference,
      theme,
      setTheme: setThemePreference,
      toggleTheme,
    }),
    [preference, theme, setThemePreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
