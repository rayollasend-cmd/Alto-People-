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
 * Phase 69 — density toggle. "comfortable" is the existing roomy spacing;
 * "compact" tightens table cell + card padding for power users who want
 * to see more rows on screen. Persists in localStorage like theme does.
 *
 * Implementation: applies `data-density` to <html>, then a couple of
 * scoped CSS rules in index.css tighten the Table cell and Card paddings
 * when the value is "compact". No per-component refactor required.
 */

export type Density = 'comfortable' | 'compact';

const STORAGE_KEY = 'alto.density';
const DEFAULT_DENSITY: Density = 'comfortable';

interface DensityContextValue {
  density: Density;
  setDensity: (density: Density) => void;
  toggleDensity: () => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

function readInitialDensity(): Density {
  if (typeof window === 'undefined') return DEFAULT_DENSITY;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'comfortable' || stored === 'compact') return stored;
  } catch {
    /* private mode etc. */
  }
  return DEFAULT_DENSITY;
}

function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = density;
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(() => readInitialDensity());

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleDensity = useCallback(() => {
    setDensityState((prev) => {
      const next: Density = prev === 'comfortable' ? 'compact' : 'comfortable';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ density, setDensity, toggleDensity }),
    [density, setDensity, toggleDensity],
  );

  return (
    <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (!ctx) {
    throw new Error('useDensity must be used inside <DensityProvider>');
  }
  return ctx;
}
