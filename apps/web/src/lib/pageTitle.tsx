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
 * Phase 70 — page-title context. PageHeader publishes the current page's
 * title here on mount; Topbar subscribes and shows it in the chrome so
 * users keep the page name visible after they scroll past the in-page
 * heading. Cleared on unmount so the topbar falls back to "Alto People".
 */

interface PageTitleContextValue {
  title: string | null;
  setTitle: (title: string | null) => void;
}

const PageTitleContext = createContext<PageTitleContextValue | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const value = useMemo(() => ({ title, setTitle }), [title]);
  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

export function usePageTitle(): string | null {
  const ctx = useContext(PageTitleContext);
  return ctx?.title ?? null;
}

/** Imperatively set the topbar title for the lifetime of the calling component. */
export function usePublishPageTitle(title: string | null | undefined) {
  const ctx = useContext(PageTitleContext);
  const setTitle = ctx?.setTitle;

  const publish = useCallback(
    (next: string | null) => {
      setTitle?.(next);
    },
    [setTitle]
  );

  useEffect(() => {
    if (!setTitle) return;
    const next = typeof title === 'string' && title.length > 0 ? title : null;
    setTitle(next);
    return () => setTitle(null);
  }, [setTitle, title]);

  return publish;
}
