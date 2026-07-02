import { Suspense, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { CommandPalette, useCommandPalette } from '@/components/ui/CommandPalette';
import {
  KeyboardShortcutsDialog,
  useKeyboardShortcutsHook,
} from './KeyboardShortcutsDialog';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';
import { BottomTabBar } from './BottomTabBar';
import { InstallPrompt } from './InstallPrompt';
import { NavigationProgress } from './NavigationProgress';
import { RouteAnnouncer } from './RouteAnnouncer';
import { Skeleton } from '@/components/ui/Skeleton';
import { moduleKeyForPath } from '@/lib/modules';
import { recordRecentModule } from '@/lib/navPersonalization';

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

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const { open: shortcutsOpen, setOpen: setShortcutsOpen } = useKeyboardShortcutsHook();
  const location = useLocation();
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  const prevKey = useRef(location.key);

  // Feed the sidebar's "Recent" section — every module navigation bumps
  // that module to the top of the recents list.
  useEffect(() => {
    const key = moduleKeyForPath(location.pathname);
    if (key) recordRecentModule(key);
  }, [location.pathname]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    // Stash the outgoing scroll position keyed by *the previous* location
    // before swapping. Capture happens before the next paint so the
    // restore on POP sees fresh values.
    scrollPositions.set(prevKey.current, main.scrollTop);
    if (navigationType === 'POP') {
      const saved = scrollPositions.get(location.key);
      // Wait one frame: AnimatePresence is mid-swap, and a synchronous
      // scrollTop = 0 would race the new page's first paint. requestAnimation
      // schedules us after the layout commits.
      requestAnimationFrame(() => {
        main.scrollTop = saved ?? 0;
      });
    } else {
      main.scrollTop = 0;
    }
    prevKey.current = location.key;
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
      */}
      <div
        className="h-screen flex bg-midnight text-white overflow-hidden"
        style={{ height: '100dvh' }}
      >
        <Sidebar />
        <MobileNav
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar
            onOpenMobileNav={() => setMobileOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
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
            className="flex-1 overflow-y-auto overflow-x-clip overscroll-contain p-4 md:p-6 lg:p-8 focus:outline-none pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] md:pl-[max(1.5rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))] lg:pl-[max(2rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))]"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <Suspense fallback={<RouteFallback />}>
                  <Outlet />
                </Suspense>
              </motion.div>
            </AnimatePresence>
          </main>
          <BottomTabBar onOpenMenu={() => setMobileOpen(true)} />
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <KeyboardShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
        />
        <InstallPrompt />
      </div>
    </TooltipProvider>
  );
}
