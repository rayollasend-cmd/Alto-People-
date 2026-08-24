import { Link } from 'react-router-dom';
import {
  Briefcase,
  Calendar,
  CalendarOff,
  DollarSign,
  Inbox,
  Menu,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import type { Capability } from '@alto-people/shared';
import { DASHBOARD_NAV, useActiveNavPath } from '@/lib/modules';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';

/**
 * Phone navigation: a persistent bottom tab bar — the native-app idiom —
 * instead of reaching for a top-left hamburger on every section change.
 * Shows the four everyday destinations for the user's role plus a "More"
 * tab that opens the full drawer for the long tail. Hidden at md+ where
 * the sidebar takes over.
 *
 * Tab sets are role-aware rather than a blind capability slice:
 *   - ASSOCIATE: Home / Schedule / Pay / Time off. (No "Clock" tab — the
 *     /time-attendance admin page dead-ends for associates, whose clock
 *     in/out lives on their dashboard.)
 *   - manage:scheduling holders (shift supervisors, managers, admins):
 *     Home / Schedule / Approvals / Time — the daily ops loop.
 *   - Everyone else: the legacy capability-filtered list.
 *
 * Rendered as a static flex-row sibling BELOW the scrolling <main> (not
 * position:fixed), so it can never overlap content, never fights the iOS
 * keyboard, and inherits the shell's safe-area handling.
 */

interface TabDef {
  path: string;
  /** i18n key when one exists… */
  labelKey?: MessageKey;
  /** …or a literal label for tabs without a message key (en-only). */
  label?: string;
  icon: LucideIcon;
  requires: Capability | null;
}

const HOME_TAB: TabDef = {
  path: DASHBOARD_NAV.path,
  labelKey: 'tabs.home',
  icon: Briefcase,
  requires: null,
};

/** Associate daily loop: schedule, paystubs, time off. */
const ASSOCIATE_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/payroll', labelKey: 'tabs.pay', icon: DollarSign, requires: 'view:payroll' },
  { path: '/time-off', labelKey: 'tabs.timeOff', icon: CalendarOff, requires: 'view:time' },
];

/** Ops daily loop for anyone who runs a schedule (supervisor/manager/admin). */
const SCHEDULER_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/approvals', label: 'Approvals', icon: Inbox, requires: 'manage:scheduling' },
  { path: '/time-attendance', label: 'Time', icon: Timer, requires: 'view:time' },
];

/** Executive loop: numbers, clients, compliance — never a punch clock. */
const EXEC_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/analytics', label: 'Analytics', icon: DollarSign, requires: 'view:analytics' },
  { path: '/clients', label: 'Clients', icon: Calendar, requires: 'view:clients' },
  { path: '/compliance', label: 'Compliance', icon: Timer, requires: 'view:compliance' },
];

/** Watch-only floor supervisor: home + the live board, nothing else. */
const FLOOR_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/time-attendance', label: 'Live floor', icon: Timer, requires: 'view:time' },
];

/** Legacy fallback for roles that fit neither bucket. */
const DEFAULT_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/time-attendance', labelKey: 'tabs.clock', icon: Timer, requires: 'view:time' },
  { path: '/time-off', labelKey: 'tabs.timeOff', icon: CalendarOff, requires: 'view:time' },
  { path: '/payroll', labelKey: 'tabs.pay', icon: DollarSign, requires: 'view:payroll' },
];

export function BottomTabBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { can, user } = useAuth();
  const { t } = useI18n();
  const activePath = useActiveNavPath();

  const tabSet =
    user?.role === 'ASSOCIATE'
      ? ASSOCIATE_TABS
      : user?.role === 'EXECUTIVE_CHAIRMAN'
        ? EXEC_TABS
        : user?.role === 'FLOOR_SUPERVISOR'
          ? FLOOR_TABS
          : can('manage:scheduling')
            ? SCHEDULER_TABS
            : DEFAULT_TABS;
  // Keep at most 4 destination tabs so every target stays comfortably
  // wide on a 360px screen once "More" is added.
  const tabs = tabSet
    .filter((tab) => tab.requires === null || can(tab.requires))
    .slice(0, 4);

  return (
    <nav
      aria-label="Primary"
      className="md:hidden shrink-0 flex items-stretch border-t border-navy-secondary bg-navy pb-[env(safe-area-inset-bottom)]"
    >
      {tabs.map((tab) => {
        const active = activePath === tab.path;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex-1 min-h-14 flex flex-col items-center justify-center gap-0.5',
              'transition-colors active:bg-navy-secondary/50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
              active ? 'text-gold' : 'text-silver',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={active ? 2.4 : 2} />
            <span className={cn('text-2xs leading-none', active && 'font-semibold')}>
              {tab.labelKey ? t(tab.labelKey) : tab.label}
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
        aria-label={t('tabs.moreAria')}
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
        <span className="text-2xs leading-none">{t('tabs.more')}</span>
      </button>
    </nav>
  );
}
