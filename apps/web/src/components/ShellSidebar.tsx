import { useEffect, useState, type ComponentType } from 'react';
import { trackChunk } from '@/lib/chunkLoading';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useViewport';

/**
 * The sidebar, fetched only where it shows. Below `md` a phone navigates by
 * the tab bar and the drawer, and the sidebar is `hidden` — yet it used to
 * ride in the shell's chunk with an icon for every module (moduleIcons), all
 * of it downloaded on the slowest connections the app has. From `md` up,
 * warmSignedInStart (App.tsx) starts it with the shell, so it is in hand when
 * the shell first renders; if it isn't yet, an empty rail of the same width
 * holds its place, so nothing moves when it lands.
 */

/** Where the sidebar shows — Tailwind's `md`, the `md:flex` on its <aside>. */
export const SIDEBAR_QUERY = '(min-width: 768px)';

let loaded: ComponentType | null = null;
let loading: Promise<ComponentType> | null = null;

export function importSidebar(): Promise<ComponentType> {
  loading ??= trackChunk(() => import('./Sidebar')).then(
    (m) => (loaded = m.Sidebar),
    (err: unknown) => {
      loading = null; // a later mount tries again
      throw err;
    },
  );
  return loading;
}

const RAIL_COLLAPSED_KEY = 'alto.sidebar.collapsed';

export function readRailCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = window.localStorage.getItem(RAIL_COLLAPSED_KEY);
    // Explicit user choice always wins (the toggle writes '1'/'0').
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    /* fall through to the viewport default */
  }
  // No stored preference: on md–lg (iPad portrait) the expanded rail eats
  // 256px of a 768px screen — a third of the width — so default to the
  // icon rail there and to expanded on true desktops.
  try {
    return !window.matchMedia('(min-width: 1024px)').matches;
  } catch {
    return false;
  }
}

export function writeRailCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, value ? '1' : '0');
  } catch {
    /* persistence is best-effort */
  }
}

/** The classes the sidebar's <aside> and its placeholder share — the box, not what's in it. */
export function sidebarFrameClass(railCollapsed: boolean): string {
  return cn(
    'hidden md:flex shrink-0 flex-col bg-navy border-r border-navy-secondary',
    // pt-safe so the brand row aligns with the Topbar (which carries the
    // same env(safe-area-inset-top) padding) on iPad portrait under a notch.
    // pl-safe handles landscape with the notch on the left.
    'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
    railCollapsed ? 'w-14' : 'w-64',
  );
}

export function ShellSidebar() {
  const wide = useMediaQuery(SIDEBAR_QUERY);
  const [Sidebar, setSidebar] = useState<ComponentType | null>(() => loaded);
  useEffect(() => {
    if (!wide || Sidebar) return;
    let live = true;
    importSidebar().then(
      (C) => live && setSidebar(() => C),
      () => undefined, // stays the empty rail; the next mount retries
    );
    return () => {
      live = false;
    };
  }, [wide, Sidebar]);
  if (Sidebar) return <Sidebar />;
  return <aside aria-hidden="true" className={sidebarFrameClass(readRailCollapsed())} />;
}
