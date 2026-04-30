import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
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
import { InstallPrompt } from './InstallPrompt';

// Per-route Suspense fallback shown while a lazy-loaded page chunk streams in.
// Sized to roughly fill the main content region so layout doesn't jump when
// the real page renders. The motion fade keeps the transition feeling
// intentional rather than a flash of empty.
function RouteFallback() {
  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div
        className="h-8 w-8 rounded-full border-2 border-gold/30 border-t-gold animate-spin"
        aria-label="Loading"
      />
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const { open: shortcutsOpen, setOpen: setShortcutsOpen } = useKeyboardShortcutsHook();
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={250}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-gold focus:px-3 focus:py-2 focus:text-navy focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>
      <div className="min-h-screen flex bg-midnight text-white">
        <Sidebar />
        <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar
            onOpenMobileNav={() => setMobileOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
          />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 focus:outline-none pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] md:pl-[max(1.5rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))] lg:pl-[max(2rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))]"
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
