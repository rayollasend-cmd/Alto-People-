import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
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
  /**
   * True once the page's own <h1> has scrolled up out of view. The topbar
   * uses it to hand the title off the way iOS hands a large title to the
   * navigation bar: while you can still see the page's heading the chrome
   * stays quiet, and the moment it leaves the compact title takes over.
   * Showing both at once is what made every page read as a web page inside
   * an app frame — the name twice, forty pixels apart.
   */
  heroHidden: boolean;
  setHeroHidden: (hidden: boolean) => void;
}

const PageTitleContext = createContext<PageTitleContextValue | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbSegment[] | null>(null);
  // Starts true so a page that never publishes a hero (or renders before the
  // observer fires) still gets its name in the chrome — the handoff only ever
  // *hides* the compact title, it never withholds it.
  const [heroHidden, setHeroHidden] = useState(true);

  const value = useMemo<PageTitleContextValue>(
    () => ({
      title,
      breadcrumbs,
      heroHidden,
      setHeroHidden,
      setMeta: ({ title: t, breadcrumbs: b }) => {
        setTitle(t);
        setBreadcrumbs(b);
      },
    }),
    [title, breadcrumbs, heroHidden]
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

/** True when the chrome should carry the page name — see `heroHidden`. */
export function useHeroHidden(): boolean {
  const ctx = useContext(PageTitleContext);
  return ctx?.heroHidden ?? true;
}

/**
 * Watch a page's <h1> and tell the topbar when it leaves. The observer's
 * root is the viewport: the shell's <main> is the scroller but it fills the
 * viewport, so an element scrolled out of main is out of the viewport too.
 * The top margin is negative by the topbar's height, so the handoff happens
 * as the heading slides *under* the bar rather than after it has already
 * gone — which is where the eye expects it.
 */
export function useHeroObserver(ref: RefObject<HTMLElement | null>) {
  const ctx = useContext(PageTitleContext);
  const setHeroHidden = ctx?.setHeroHidden;

  useEffect(() => {
    const el = ref.current;
    if (!el || !setHeroHidden) return;
    if (typeof IntersectionObserver === 'undefined') {
      setHeroHidden(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setHeroHidden(!entry?.isIntersecting),
      { rootMargin: '-56px 0px 0px 0px', threshold: 0 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      // Leaving the page hands the title back to the chrome, so the next
      // page's bar is never briefly blank.
      setHeroHidden(true);
    };
  }, [ref, setHeroHidden]);
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
