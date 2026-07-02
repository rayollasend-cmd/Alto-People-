import { Link } from 'react-router-dom';
import {
  Briefcase,
  Calendar,
  CalendarOff,
  DollarSign,
  Menu,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import type { Capability } from '@alto-people/shared';
import { DASHBOARD_NAV, useActiveNavPath } from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';

/**
 * Phone navigation: a persistent bottom tab bar — the native-app idiom —
 * instead of reaching for a top-left hamburger on every section change.
 * Shows the four everyday destinations the user is allowed to see plus a
 * "More" tab that opens the full drawer for the long tail. Hidden at md+
 * where the sidebar takes over.
 *
 * Rendered as a static flex-row sibling BELOW the scrolling <main> (not
 * position:fixed), so it can never overlap content, never fights the iOS
 * keyboard, and inherits the shell's safe-area handling.
 */

interface TabDef {
  path: string;
  label: string;
  icon: LucideIcon;
  requires: Capability | null;
}

const TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, label: 'Home', icon: Briefcase, requires: null },
  { path: '/scheduling', label: 'Schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/time-attendance', label: 'Clock', icon: Timer, requires: 'view:time' },
  { path: '/time-off', label: 'Time off', icon: CalendarOff, requires: 'view:time' },
  { path: '/payroll', label: 'Pay', icon: DollarSign, requires: 'view:payroll' },
];

export function BottomTabBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { can } = useAuth();
  const activePath = useActiveNavPath();
  // Keep at most 4 destination tabs so every target stays comfortably
  // wide on a 360px screen once "More" is added.
  const tabs = TABS.filter((t) => t.requires === null || can(t.requires)).slice(0, 4);

  return (
    <nav
      aria-label="Primary"
      className="md:hidden shrink-0 flex items-stretch border-t border-navy-secondary bg-navy pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((t) => {
        const active = activePath === t.path;
        const Icon = t.icon;
        return (
          <Link
            key={t.path}
            to={t.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex-1 min-h-14 flex flex-col items-center justify-center gap-0.5',
              'transition-colors active:bg-navy-secondary/50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
              active ? 'text-gold' : 'text-silver',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={active ? 2.4 : 2} />
            <span className={cn('text-[10px] leading-none', active && 'font-semibold')}>
              {t.label}
            </span>
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMenu}
        className={cn(
          'flex-1 min-h-14 flex flex-col items-center justify-center gap-0.5 text-silver',
          'transition-colors active:bg-navy-secondary/50',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
        )}
        aria-label="More — open full navigation"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
        <span className="text-[10px] leading-none">More</span>
      </button>
    </nav>
  );
}
