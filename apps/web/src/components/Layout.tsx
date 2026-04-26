import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { Toaster } from '@/components/ui/Toaster';
import { CommandPalette, useCommandPalette } from '@/components/ui/CommandPalette';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileNav } from './MobileNav';

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { open: paletteOpen, setOpen: setPaletteOpen } = useCommandPalette();
  const location = useLocation();

  return (
    <TooltipProvider delayDuration={250}>
      <div className="min-h-screen flex bg-midnight text-white">
        <Sidebar />
        <MobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />
        <div className="flex-1 flex flex-col min-w-0">
          <Topbar
            onOpenMobileNav={() => setMobileOpen(true)}
            onOpenCommandPalette={() => setPaletteOpen(true)}
          />
          <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
