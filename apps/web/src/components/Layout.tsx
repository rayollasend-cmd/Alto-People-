import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { noteRouteChange } from '@/lib/webVitals';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CommandPalette, useCommandPalette } from '@/components/ui/CommandPalette';
import {
  KeyboardShortcutsDialog,
  useKeyboardShortcutsHook,
} from './KeyboardShortcutsDialog';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';
import { BottomTabBar, tabBarHiddenFrom } from './BottomTabBar';
import { InstallPrompt } from './InstallPrompt';
import { WhatsNew } from './WhatsNew';
import { HelpSheet } from './HelpSheet';
import { Coachmarks } from './Coachmarks';
import { NavigationProgress } from './NavigationProgress';
import { RouteAnnouncer } from './RouteAnnouncer';
import { Skeleton } from '@/components/ui/Skeleton';
import { moduleKeyForPath } from '@/lib/modules';
import { recordRecentModule } from '@/lib/navPersonalization';
import { useAuth } from '@/lib/auth';
import { startLiveEvents, stopLiveEvents } from '@/lib/liveEvents';
import { useChunkLoading } from '@/lib/chunkLoading';
import { cn } from '@/lib/cn';

// Per-route Suspense fallback shown while a lazy-loaded page chunk streams
// in. A 40vh-centered spinner used to feel like "something is wrong" on
// slow networks; switch to a thin page-shaped skeleton so the transition
// reads as "page on the way" instead of "loading screen." The
// NavigationProgress bar at the top of the viewport already signals work
// is happening — this fills the page body so the chrome doesn't jump.
// Uses Skeleton (which has the real shimmer overlay) so each tile reads
// as actively loading instead of flat placeholder boxes.
function RouteFallback() {
  return (
    <div className="space-y-4 p-4 md:p-6" aria-label="Loading">
      <Skeleton className="h-8 w-1/3" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24 hidden lg:block" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

// Scroll-positions-by-pathname store. We can't use react-router's built-in
// <ScrollRestoration /> because it targets the window scroller, and the
// scrolling element here is the inner <main>. PUSH navigations reset to
// the top; POP (back/forward) navigations restore the previously-captured
// position so a long /people scroll isn't lost when bouncing into a row
// detail and back.
const scrollPositions = new Map<string, number>();

/**
 * Where each SECTION was left, keyed by pathname rather than by history
 * entry.
 *
 * The map above restores on POP, which covers Back and Forward. A bottom
 * tab is a <Link>, so tapping one is a PUSH with a brand-new key — and
 * every PUSH resets to the top. Scroll halfway down Schedule, glance at
 * Pay, tap Schedule again and you are back at the first row, having lost
 * your place for doing the thing a tab bar exists to do. No native tab
 * bar behaves that way.
 *
 * Only section ROOTS are remembered — one path segment, e.g. /scheduling
 * or /rides, which is exactly what the tab bar and the sidebar navigate
 * to. A push into a detail screen still opens at the top, because that is
 * a new thing to read rather than a return to one you were already in.
 */
const sectionScroll = new Map<string, number>();

/** A section root: "/rides", not "/rides/42" and not "/". */
export function isSectionRoot(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length === 1;
}

/**
 * Where the incoming page should be scrolled to. Exported so the test
 * exercises the rule the component actually runs, rather than a copy of
 * it that can drift.
 */
export function scrollTargetFor(args: {
  navigationType: string;
  pathname: string;
  sectionScroll: Map<string, number>;
  keyScroll: number | undefined;
}): number {
  const returningToSection =
    args.navigationType !== 'POP' &&
    isSectionRoot(args.pathname) &&
    args.sectionScroll.has(args.pathname);
  if (args.navigationType === 'POP' || returningToSection) {
    return (
      (returningToSection ? args.sectionScroll.get(args.pathname) : args.keyScroll) ?? 0
    );
  }
  return 0;
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const { open: shortcutsOpen, setOpen: setShortcutsOpen } = useKeyboardShortcutsHook();
  const [helpOpen, setHelpOpen] = useState(false);
  const location = useLocation();
  // A soft navigation closes the books on the previous route's web vitals.
  useEffect(() => {
    noteRouteChange(location.pathname);
  }, [location.pathname]);
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  // True while a page chunk is still on the wire — see lib/chunkLoading.
  const chunkLoading = useChunkLoading();
  const prevKey = useRef(location.key);
  const prevPath = useRef(location.pathname);

  // Feed the sidebar's "Recent" section — every module navigation bumps
  // that module to the top of the signed-in user's recents (per-user
  // keys, so a shared tablet never shows one associate's trail to the
  // next).
  const { user } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    const key = moduleKeyForPath(location.pathname);
    if (key) recordRecentModule(key, userId);
  }, [location.pathname, userId]);

  // Live SSE channel for the authed shell — bell + approvals badge
  // refetch the instant a notification lands instead of on next poll.
  useEffect(() => {
    startLiveEvents();
    return () => stopLiveEvents();
  }, []);

  // The shell owns scrolling: while it's mounted the document itself never
  // scrolls or rubber-bands (index.css `html.app-shell`), so a drag on the
  // top bar or tab bar can't slide the whole app off-screen. Public pages
  // (sign-in, invites) keep normal document scrolling.
  useEffect(() => {
    document.documentElement.classList.add('app-shell');
    return () => document.documentElement.classList.remove('app-shell');
  }, []);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // Stash the outgoing scroll position keyed by *the previous* location
    // before swapping. Capture happens before the next paint so the
    // restore on POP sees fresh values.
    scrollPositions.set(prevKey.current, main.scrollTop);
    if (isSectionRoot(prevPath.current)) {
      sectionScroll.set(prevPath.current, main.scrollTop);
    }
    // A tab tap is a PUSH to a section root we may have been in before —
    // restore it, the way a tab bar is expected to. Anything else pushed
    // is new reading and opens at the top.
    const target = scrollTargetFor({
      navigationType,
      pathname: location.pathname,
      sectionScroll,
      keyScroll: scrollPositions.get(location.key),
    });
    if (target > 0) {
      // Wait one frame: the route swap is mid-commit, and a synchronous
      // scrollTop would race the new page's first paint. requestAnimation
      // schedules us after the layout commits.
      requestAnimationFrame(() => {
        main.scrollTop = target;
      });
    } else {
      main.scrollTop = 0;
    }
    prevKey.current = location.key;
    prevPath.current = location.pathname;
  }, [location.key, navigationType]);

  return (
    <TooltipProvider delayDuration={250}>
      <NavigationProgress />
      <RouteAnnouncer />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-gold focus:px-3 focus:py-2 focus:text-navy focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>
      {/*
        h-screen + overflow-hidden locks the OUTER container to the
        viewport. Without this, `min-h-screen` lets the outer div grow
        taller than the screen whenever any child (sidebar or main) has
        more content than fits — at which point the BODY itself
        scrolls, dragging the sidebar AND main together. Users
        described this as "scrolling the sidebar moves the whole
        page" and "the boundaries keep moving up and down" (iOS
        address bar collapsing as body scrolls). With overflow-hidden,
        body never scrolls; only the inner Sidebar nav and Main
        content scroll, and each is contained to its own area.

        Inline `100dvh` upgrades to the dynamic viewport on Safari
        15.4+, so the iOS URL bar showing/hiding doesn't leave a gap.
        Browsers that don't understand dvh drop the inline rule and
        fall back to the class's 100vh.

        `relative` (here and on <main>): overflow only clips descendants
        whose containing block sits inside it. An absolutely positioned
        element with no positioned ancestor — every `sr-only` label, for
        one — resolved against the page itself, escaped the clip, and
        stretched the DOCUMENT by however far down the page it sat (1,093px
        on the HR home). The whole app then scrolled/bounced as one sheet,
        leaving blank space ("I scroll up and the entire app moves").
      */}
      <div
        className="relative h-screen flex bg-midnight text-white overflow-hidden"
        style={{ height: '100dvh' }}
      >
        <Sidebar />
        <MobileNav
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />
        {/* Whichever element actually touches the bottom of the screen is
            the one that must consume env(safe-area-inset-bottom), and on a
            phone that is the tab bar, not <main>. Both were padding for it:
            34px of dead space above the bar on an iPhone plus the 34px
            inside it, when only the bar's own is doing any work. So the
            inset lives here, and only from the width where the tab bar
            stops rendering and <main> becomes the bottom-most element.
            (On the wrapper rather than on <main> so it can't collide with
            main's own p-4/md:p-6/lg:p-8 shorthand, where which rule wins
            comes down to Tailwind's emit order.) */}
        <div
          className={cn(
            'flex-1 flex flex-col min-w-0',
            // standalone: for the same reason the tab bar uses it — a
            // browser tab's bottom inset is already covered by the
            // browser's own chrome.
            tabBarHiddenFrom(user?.role) === 'lg'
              ? 'lg:standalone:pb-[env(safe-area-inset-bottom)]'
              : 'md:standalone:pb-[env(safe-area-inset-bottom)]',
          )}
        >
          <Topbar
            onOpenCommandPalette={() => setPaletteOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
          />
          <main
            id="main-content"
            ref={mainRef}
            tabIndex={-1}
            // overscroll-contain stops scroll-chaining: hitting the
            // end of main no longer transfers momentum to a parent
            // scroller. With body locked above, there's no parent to
            // chain to anyway — this is defence in depth and also
            // kills iOS rubber-band on the inner scroller.
            // overflow-x-clip: overflow-y:auto silently computes
            // overflow-x to auto, so ANY child 1px wider than the screen
            // made the whole page pan sideways ("the swing"). Clip forbids
            // horizontal panning at the page level; legitimately-wide
            // content (admin grids, paystub tables) lives inside its own
            // overflow-x-auto wrappers, which still scroll.
            className="relative flex-1 overflow-y-auto overflow-x-clip overscroll-contain p-4 md:p-6 lg:p-8 focus:outline-none pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-[max(1.5rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))] lg:pl-[max(2rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))]"
          >
            {/* PERF: pure-CSS route fade (keyed remount replays the
                animation) — this was the ONLY framer-motion usage in the
                app, and it kept 42 KB gz of animation runtime in the
                blocking first-paint path. index.css flattens the
                keyframes under prefers-reduced-motion. */}
            {/* max-w: 49 page roots carry a no-op `mx-auto` (no max-width
                anywhere in the chain), so ultrawide monitors stretched
                every table to 2400px+. One content ceiling here fixes all
                of them. */}
            <div className="mx-auto w-full max-w-[1600px]">
              <InstallPrompt />
            </div>
            {/* The Suspense boundary sits ABOVE the keyed div on purpose.
                It used to be inside, so every navigation mounted a brand
                new boundary with no content and React had no choice but to
                paint the fallback — the screen blanked to a skeleton even
                when the next page was 80ms away. Hoisted, the boundary
                persists across navigations, and with v7_startTransition
                (see App.tsx) React keeps the page you're on painted until
                the next chunk lands. The key stays on the inner div so the
                route fade still replays when the swap actually happens. */}
            <Suspense fallback={<RouteFallback />}>
              <div
                key={location.pathname}
                // While we're holding the old page, say so quietly: a small
                // dip in opacity after a beat, so a fast navigation never
                // flickers but a slow one doesn't look frozen. The chrome
                // stays at full strength and fully interactive — only the
                // outgoing content dims.
                aria-busy={chunkLoading || undefined}
                className={cn(
                  'route-fade mx-auto w-full max-w-[1600px]',
                  chunkLoading
                    ? 'opacity-60 transition-opacity duration-200 delay-150'
                    : 'opacity-100 transition-opacity duration-100',
                )}
              >
                <Outlet />
              </div>
            </Suspense>
          </main>
          <BottomTabBar onOpenMenu={() => setMobileOpen(true)} />
        </div>
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onShowKeyboardShortcuts={() => setShortcutsOpen(true)}
        />
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />
        <HelpSheet
          open={helpOpen}
          onOpenChange={setHelpOpen}
          onShowKeyboardShortcuts={() => {
            setHelpOpen(false);
            setShortcutsOpen(true);
          }}
        />
        <Coachmarks />
        <WhatsNew />
      </div>
    </TooltipProvider>
  );
}
