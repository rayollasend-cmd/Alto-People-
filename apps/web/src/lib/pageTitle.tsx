import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
 *
 * A page that publishes nothing is named in the bar by its nav label
 * (lib/navTrail useNavLabel) — the wordmark only off the nav entirely.
 *
 * A page with a header of its own (not PageHeader / RecordTemplate — a
 * message thread, a kiosk-style screen) adopts the same behaviour with ONE
 * hook on its heading:
 *
 *   const heroRef = usePageHero(thread.name, [{ label: 'Messages', to: '/messages' }, { label: thread.name }]);
 *   return <h1 ref={heroRef}>{thread.name}</h1>;
 *
 * It publishes the name (and trail) to the bar and hands the bar the name
 * once the heading scrolls under it — the same handoff every template does.
 */

interface PageTitleContextValue {
  title: string | null;
  breadcrumbs: BreadcrumbSegment[] | null;
  setMeta: (meta: { title: string | null; breadcrumbs: BreadcrumbSegment[] | null }) => void;
  /**
   * Where "up" is for a page that has no parent in its URL — an area shell
   * around top-level paths (/audit, /trust inside Settings & trust) sets it,
   * so the phone still gets a Back to the area. Null almost everywhere.
   */
  up: BreadcrumbSegment | null;
  setUp: (up: BreadcrumbSegment | null) => void;
  /**
   * True once the page's own <h1> has scrolled up out of view. The topbar
   * uses it to hand the title off the way iOS hands a large title to the
   * navigation bar: while you can still see the page's heading the chrome
   * stays quiet, and the moment it leaves the compact title takes over.
   * Showing both at once is what made every page read as a web page inside
   * an app frame — the name twice, forty pixels apart.
   */
  heroHidden: boolean;
  /**
   * A page header announcing itself (PageHeader, RecordTemplate). The shell
   * watches the first one registered — one observer for the whole app, so
   * two headers on one screen can never fight over the top bar. Returns the
   * unregister.
   */
  registerHero: (el: HTMLElement) => () => void;
}

const PageTitleContext = createContext<PageTitleContextValue | null>(null);

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbSegment[] | null>(null);
  const [up, setUp] = useState<BreadcrumbSegment | null>(null);
  // Starts true so a page that never publishes a hero (or renders before the
  // observer fires) still gets its name in the chrome — the handoff only ever
  // *hides* the compact title, it never withholds it.
  const [heroHidden, setHeroHidden] = useState(true);
  const [heroEl, setHeroEl] = useState<HTMLElement | null>(null);
  const heroes = useRef<HTMLElement[]>([]);

  const registerHero = useCallback((el: HTMLElement) => {
    // The top-most header is the page's (a header nested in a tab is not),
    // whatever order React mounted them in.
    heroes.current = [...heroes.current, el].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    setHeroEl(heroes.current[0] ?? null);
    return () => {
      heroes.current = heroes.current.filter((h) => h !== el);
      setHeroEl(heroes.current[0] ?? null);
    };
  }, []);

  // The one observer. Its root is the viewport: the shell's <main> is the
  // scroller but it fills the viewport, so an element scrolled out of main is
  // out of the viewport too. The top margin is negative by the top bar's
  // height, so the handoff happens as the header slides *under* the bar
  // rather than after it has already gone — which is where the eye expects it.
  useLayoutEffect(() => {
    if (!heroEl) {
      // No header of the page's own (or the page left): the chrome names it.
      setHeroHidden(true);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setHeroHidden(true);
      return;
    }
    // Measured before the first paint, so a page at rest never flashes its
    // name in the bar while the observer's first answer is on its way.
    const r = heroEl.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) setHeroHidden(r.bottom <= TOP_BAR_PX);
    const io = new IntersectionObserver(
      ([entry]) => setHeroHidden(!entry?.isIntersecting),
      { rootMargin: `-${TOP_BAR_PX}px 0px 0px 0px`, threshold: 0 },
    );
    io.observe(heroEl);
    return () => io.disconnect();
  }, [heroEl]);

  // Stable: a page's publish effect depends on it, and a fresh function on
  // every change re-ran that effect — which re-published, which changed the
  // state, which made a fresh function… (a trail computed per render, as an
  // area's is, never settled).
  const setMeta = useCallback(({ title: t, breadcrumbs: b }: { title: string | null; breadcrumbs: BreadcrumbSegment[] | null }) => {
    setTitle(t);
    setBreadcrumbs(b);
  }, []);

  const value = useMemo<PageTitleContextValue>(
    () => ({
      title,
      breadcrumbs,
      heroHidden,
      registerHero,
      setMeta,
      up,
      setUp,
    }),
    [title, breadcrumbs, heroHidden, registerHero, setMeta, up]
  );

  return <PageTitleContext.Provider value={value}>{children}</PageTitleContext.Provider>;
}

export function usePageTitle(): string | null {
  const ctx = useContext(PageTitleContext);
  return ctx?.title ?? null;
}

/** The area's "up" (see PageTitleContextValue.up), or null. */
export function usePageUp(): BreadcrumbSegment | null {
  const ctx = useContext(PageTitleContext);
  return ctx?.up ?? null;
}

/** Set "up" for the pages inside an area shell; cleared when it unmounts. */
export function usePublishPageUp(up: BreadcrumbSegment | null) {
  const setUp = useContext(PageTitleContext)?.setUp;
  const key = up ? JSON.stringify(up) : '';
  useEffect(() => {
    if (!setUp) return;
    setUp(up);
    return () => setUp(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setUp, key]);
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

/** The top bar's height at rest (min-h-14). */
const TOP_BAR_PX = 56;

/**
 * Mark a page's own heading as its hero: while it is on screen the top bar
 * keeps quiet, and once it scrolls under the bar the compact title takes
 * over. Every template that renders a title and breadcrumb of its own
 * (PageHeader, so ListTemplate; RecordTemplate) calls this; a page that
 * renders none keeps its name in the bar. The observing is the shell's
 * (PageTitleProvider), so it is done once, the same way, everywhere.
 * Leaving the page hands the title back to the chrome.
 */
export function useHeroObserver(ref: RefObject<HTMLElement | null>) {
  const ctx = useContext(PageTitleContext);
  const registerHero = ctx?.registerHero;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !registerHero) return;
    return registerHero(el);
  }, [ref, registerHero]);
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

/**
 * The adoption path for a custom header: publish the page's name (and
 * trail) to the top bar and mark the returned ref's element as the page's
 * hero, so the bar stays quiet while it is on screen. See the file header.
 */
export function usePageHero<T extends HTMLElement = HTMLHeadingElement>(
  title: string | null | undefined,
  breadcrumbs?: BreadcrumbSegment[] | null,
): RefObject<T> {
  usePublishPageTitle(title, breadcrumbs);
  const ref = useRef<T>(null);
  useHeroObserver(ref);
  return ref;
}
