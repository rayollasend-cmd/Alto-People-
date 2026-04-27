import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * Phase 70 — page-title context. PageHeader publishes the current page's
 * title here on mount; Topbar subscribes and shows it in the chrome so
 * users keep the page name visible after they scroll past the in-page
 * heading. Cleared on unmount so the topbar falls back to "Alto People".
 *
 * Phase 71 — also carries the breadcrumb trail. PageHeader publishes both
 * together; Topbar prefers breadcrumbs (full "you are here" context) and
 * falls back to the title alone when none are provided.
 */

interface PageTitleContextValue {
  title: string | null;
  breadcrumbs: BreadcrumbSegment[] | null;
  setMeta: (meta: { title: string | null; breadcrumbs: BreadcrumbSegment[] | null }) => void;
}

const PageTitleContext = createContext<PageTitleContextValue | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbSegment[] | null>(null);

  const value = useMemo<PageTitleContextValue>(
    () => ({
      title,
      breadcrumbs,
      setMeta: ({ title: t, breadcrumbs: b }) => {
        setTitle(t);
        setBreadcrumbs(b);
      },
    }),
    [title, breadcrumbs]
  );

  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

export function usePageTitle(): string | null {
  const ctx = useContext(PageTitleContext);
  return ctx?.title ?? null;
}

export function usePageBreadcrumbs(): BreadcrumbSegment[] | null {
  const ctx = useContext(PageTitleContext);
  return ctx?.breadcrumbs ?? null;
}

/**
 * Publish the current page's title (and optionally breadcrumbs) to the
 * topbar. Cleared on unmount.
 */
export function usePublishPageTitle(
  title: string | null | undefined,
  breadcrumbs?: BreadcrumbSegment[] | null
) {
  const ctx = useContext(PageTitleContext);
  const setMeta = ctx?.setMeta;
  // Memoize a stable key so the effect doesn't re-run on every render when
  // the caller passes a fresh array literal.
  const breadcrumbsKey = breadcrumbs ? JSON.stringify(breadcrumbs) : '';

  useEffect(() => {
    if (!setMeta) return;
    const nextTitle = typeof title === 'string' && title.length > 0 ? title : null;
    const nextCrumbs = breadcrumbs && breadcrumbs.length > 0 ? breadcrumbs : null;
    setMeta({ title: nextTitle, breadcrumbs: nextCrumbs });
    return () => setMeta({ title: null, breadcrumbs: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setMeta, title, breadcrumbsKey]);
}
