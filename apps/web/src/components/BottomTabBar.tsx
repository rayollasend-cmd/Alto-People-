import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { unreadMessages } from '@/lib/messagesApi';
import { onLiveEvent } from '@/lib/liveEvents';
import { useApprovalsCount } from '@/lib/useApprovalsCount';
import { useInbox } from '@/lib/inboxApi';
import {
  BarChart3,
  Briefcase,
  Building2,
  Bus,
  Calendar,
  CalendarOff,
  ClipboardList,
  DollarSign,
  CheckCheck,
  Inbox,
  Menu,
  Rocket,
  MessageSquare,
  ShieldCheck,
  Store,
  Timer,
  UserPlus,
  Users,
  type LucideIcon,
} from '@/components/ui/icons';
import type { Capability } from '@alto-people/shared';
import { DASHBOARD_NAV, useActiveNavPath } from '@/lib/modules';
import { prefetchRoute } from '@/lib/prefetch';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/tabs';

/**
 * Phone navigation: a persistent bottom tab bar — the native-app idiom —
 * instead of reaching for a top-left hamburger on every section change.
 * Shows the four everyday destinations for the user's role plus a "More"
 * tab that opens the full drawer for the long tail. Hidden at md+ where
 * the sidebar takes over.
 *
 * Tab sets are role-aware rather than a blind capability slice:
 *   - ASSOCIATE: Home / Schedule / Pay / Ride. (No "Clock" tab — the
 *     /time-attendance admin page dead-ends for associates, whose clock
 *     in/out lives on their dashboard. Time off is in More.)
 *   - manage:scheduling holders (shift supervisors, managers, admins):
 *     Home / Schedule / Approvals / Time — the daily ops loop.
 *   - Everyone else: the legacy capability-filtered list.
 *
 * Rendered as a static flex-row sibling BELOW the scrolling <main> (not
 * position:fixed), so it can never overlap content, never fights the iOS
 * keyboard, and inherits the shell's safe-area handling.
 */

export interface TabDef {
  path: string;
  /** i18n key when one exists… */
  labelKey?: MessageKey;
  /** …or a literal label for tabs without a message key (en-only). */
  label?: string;
  icon: LucideIcon;
  requires: Capability | null;
  /** Live count shown on the tab — the messenger, the supervisor's
   *  decisions inbox, and the HR admin's Inbox total. */
  badge?: 'messages' | 'approvals' | 'inbox';
}

const HOME_TAB: TabDef = {
  path: DASHBOARD_NAV.path,
  labelKey: 'tabs.home',
  icon: Briefcase,
  requires: null,
};

/** Associate daily loop: schedule, paystubs, the van to work. Time off
 *  lives in More. */
const ASSOCIATE_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/payroll', labelKey: 'tabs.pay', icon: DollarSign, requires: 'view:payroll' },
  { path: '/rides', labelKey: 'tabs.ride', icon: Bus, requires: 'ride:transport' },
];

/** The driver: their runs (home), and messages. */
const DRIVER_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'drive.title', icon: Bus, requires: null },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

/** The Transportation Director: the command center (home), and messages. */
const TRANSPORT_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'tabs.commandCenter', icon: Bus, requires: null },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

/** Ops daily loop for anyone who runs a schedule (supervisor/manager/admin). */
// Finance's day is payday: the runs, the hours sheets they sign off, and the
// messenger. Their sidebar calls the hours surface Timesheets (/timesheets),
// so the phone does too — the rail-consistency test holds the two together.
const FINANCE_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/payroll', labelKey: 'tabs.pay', icon: DollarSign, requires: 'view:payroll' },
  { path: '/timesheets', label: 'Timesheets', icon: Timer, requires: 'view:time' },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

const SCHEDULER_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/approvals', labelKey: 'tabs.approvals', icon: CheckCheck, requires: 'manage:scheduling', badge: 'approvals' },
  { path: '/time-attendance', labelKey: 'tabs.time', icon: Timer, requires: 'view:time' },
];

/** The HR admin's day (role walk HR 14): what is waiting on them, the
 *  people, the hires in flight — not the scheduler's Schedule/Time loop
 *  they used to fall through to. Every tab is a page their sidebar shows
 *  (navCoverage holds the two to one menu). */
const HR_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/inbox', labelKey: 'tabs.inbox', icon: Inbox, requires: null, badge: 'inbox' },
  { path: '/people', labelKey: 'tabs.people', icon: Users, requires: 'view:org' },
  { path: '/onboarding', labelKey: 'tabs.onboarding', icon: ClipboardList, requires: 'view:onboarding' },
];

/** The line manager (HR pack 2026-10): their team's approvals are the
 *  team inbox — timesheets, time off, reimbursements, goals at risk — not
 *  the scheduling desk, which is a supervisor's queue. */
const MANAGER_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/team', labelKey: 'tabs.approvals', icon: CheckCheck, requires: 'view:my-team' },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
  { path: '/time-off', labelKey: 'tabs.timeOff', icon: CalendarOff, requires: 'view:time' },
];

/** The recruiter: their day on Home, the pipeline, messages, and the new
 *  hires they hand to onboarding. They hold scheduling rights, so they
 *  used to get the scheduler's tabs — Schedule, Approvals, Time — and
 *  their own pipeline was behind More. */
const RECRUITER_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/recruiting', labelKey: 'tabs.recruiting', icon: UserPlus, requires: 'view:recruiting' },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
  { path: '/onboarding', labelKey: 'tabs.onboarding', icon: ClipboardList, requires: 'view:onboarding' },
];

/** The shift supervisor's floor, the store manager's grammar: the floor
 *  home, today's face wall, the schedule, and what's waiting on them. */
const SUPERVISOR_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'floor.title', icon: Store, requires: null },
  { path: '/today', labelKey: 'portal.todayNav', icon: Users, requires: null },
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/approvals', labelKey: 'tabs.approvals', icon: CheckCheck, requires: 'manage:scheduling', badge: 'approvals' },
];

/** Marketing: their funnel (home), the pipeline it feeds, messages. */
const MARKETING_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/marketing', label: 'Marketing', icon: Rocket, requires: 'view:marketing' },
  { path: '/recruiting', labelKey: 'tabs.recruiting', icon: UserPlus, requires: 'view:recruiting' },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

/** Executive loop: numbers, clients, compliance — never a punch clock. */
// The chairman's board topics (2026-10-27): the scorecard, the money, the
// client book and the risk register — the rest is one tap into More.
const EXEC_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/executive/financials', label: 'Financials', icon: BarChart3, requires: 'view:executive' },
  { path: '/executive/clients', label: 'Clients', icon: Building2, requires: 'view:executive' },
  { path: '/executive/risk', label: 'Risk', icon: ShieldCheck, requires: 'view:executive' },
];

/** The floor supervisor: the shift supervisor's floor, watch-only — their
 *  floor home, today's faces, the live board, and messages. */
const FLOOR_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'floor.title', icon: Store, requires: null },
  { path: '/today', labelKey: 'portal.todayNav', icon: Users, requires: null },
  { path: '/time-attendance', labelKey: 'tabs.liveBoard', icon: Timer, requires: 'view:time' },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

/** The store manager (client portal): their store, the week, the loop. */
const PORTAL_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'portal.title', icon: Store, requires: null },
  { path: '/portal/today', labelKey: 'portal.todayNav', icon: Users, requires: null },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
  { path: '/portal/requests', labelKey: 'portal.reqTitle', icon: Inbox, requires: null },
];

/** The region command center account: the region, and messages. */
const REGION_TABS: TabDef[] = [
  { path: DASHBOARD_NAV.path, labelKey: 'region.title', icon: Store, requires: null },
  { path: '/messages', labelKey: 'msg.title', icon: MessageSquare, requires: null, badge: 'messages' },
];

/** Legacy fallback for roles that fit neither bucket. */
const DEFAULT_TABS: TabDef[] = [
  HOME_TAB,
  { path: '/scheduling', labelKey: 'tabs.schedule', icon: Calendar, requires: 'view:scheduling' },
  { path: '/time-attendance', labelKey: 'tabs.clock', icon: Timer, requires: 'view:time' },
  { path: '/time-off', labelKey: 'tabs.timeOff', icon: CalendarOff, requires: 'view:time' },
  { path: '/payroll', labelKey: 'tabs.pay', icon: DollarSign, requires: 'view:payroll' },
];


/**
 * Which tabs a role gets. Exported so a test can hold the phone and the
 * desktop rail to the same menu: every tab here is a destination the
 * sidebar also shows that role (see __tests__/lib/navCoverage.test.ts).
 */
export function tabSetFor(
  user: { role: string; regionId?: string | null; clientId?: string | null } | null | undefined,
  can: (c: Capability) => boolean,
): TabDef[] {
  return user?.role === 'ASSOCIATE'
    ? ASSOCIATE_TABS
    : user?.role === 'DRIVER'
      ? DRIVER_TABS
      : user?.role === 'TRANSPORTATION_DIRECTOR'
        ? TRANSPORT_TABS
        : user?.role === 'EXECUTIVE_CHAIRMAN'
          ? EXEC_TABS
          : user?.role === 'FLOOR_SUPERVISOR'
            ? FLOOR_TABS
            : user?.role === 'SHIFT_SUPERVISOR'
              ? SUPERVISOR_TABS
              : user?.role === 'CLIENT_PORTAL'
                ? user.regionId && !user.clientId
                  ? REGION_TABS
                  : PORTAL_TABS
                : user?.role === 'INTERNAL_RECRUITER'
                  ? RECRUITER_TABS
                  : user?.role === 'MARKETING_MANAGER'
                    ? MARKETING_TABS
                  : user?.role === 'FINANCE_ACCOUNTANT'
                    ? FINANCE_TABS
                  : user?.role === 'MANAGER'
                    ? MANAGER_TABS
                  : user?.role === 'HR_ADMINISTRATOR'
                    ? HR_TABS
                  : can('manage:scheduling')
                    ? SCHEDULER_TABS
                    : DEFAULT_TABS;
}

/**
 * The width at which the tab bar stops being rendered.
 *
 * The store manager's and the supervisors' four destinations are labeled
 * tabs, not icon-rail guesses, so they keep them through iPad widths.
 *
 * Layout reads this too: whichever element actually touches the bottom of
 * the screen is the one that must consume env(safe-area-inset-bottom), and
 * that swaps at exactly this breakpoint. Exported rather than duplicated
 * because the two drifting apart is invisible until someone holds a phone.
 */
export function tabBarHiddenFrom(role: string | null | undefined): 'md' | 'lg' {
  return role === 'CLIENT_PORTAL' || role === 'SHIFT_SUPERVISOR' || role === 'FLOOR_SUPERVISOR'
    ? 'lg'
    : 'md';
}

export function BottomTabBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { can, user } = useAuth();
  const { t } = useI18n();
  const activePath = useActiveNavPath();

  const tabSet = tabSetFor(user, can);
  // Keep at most 4 destination tabs so every target stays comfortably
  // wide on a 360px screen once "More" is added.
  const tabs = tabSet
    .filter((tab) => tab.requires === null || can(tab.requires))
    .slice(0, 4);

  return (
    <nav
      aria-label={t('tabs.primaryAria')}
      className={cn(
        tabBarHiddenFrom(user?.role) === 'lg' ? 'lg:hidden' : 'md:hidden',
        // The bar owns the bottom safe area: its background extends under
        // the home indicator the way a native tab bar's does, so the labels
        // clear it. Layout must NOT also pad <main> for that inset while
        // this bar is on screen — see the note there.
        //
        // Nothing reserved in a browser tab. iOS Safari reports a bottom
        // inset there too, but its own toolbar is already drawn across
        // that region — padding for it as well just stacks a dead strip
        // on top of the browser chrome, which is the space that looked
        // wrong on an iPhone.
        //
        // Installed, the page really does reach the indicator, so the bar
        // extends under it the way a native tab bar does — at 65% of the
        // reported inset. iOS says 34pt, but the indicator is a 5pt pill
        // sitting 8pt up: it occupies 8–13pt and the rest is Apple being
        // generous. ~22pt still leaves 9pt of clearance, and nothing
        // interactive lives down there either way, since the tap targets
        // are in the row above this padding.
        'shrink-0 flex items-stretch border-t border-navy-secondary bg-navy',
        'standalone:pb-[calc(env(safe-area-inset-bottom)*0.65)]',
      )}
    >
      {tabs.map((tab) => {
        const active = activePath === tab.path;
        const Icon = tab.icon;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            aria-current={active ? 'page' : undefined}
            // Warm the tab's chunk on touch-down — see MobileNav.
            onTouchStart={() => prefetchRoute(tab.path)}
            className={cn(
              'flex-1 min-h-14 flex flex-col items-center justify-center gap-0.5',
              'transition-colors active:bg-navy-secondary/50',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright',
              active ? 'text-gold' : 'text-silver',
            )}
          >
            <span className="relative">
              <Icon className={cn('h-5 w-5', active && 'icon-active')} aria-hidden="true" />
              {tab.badge === 'messages' && <UnreadMessagesBadge />}
              {tab.badge === 'approvals' && <ApprovalsBadge />}
              {tab.badge === 'inbox' && <InboxBadge />}
            </span>
            <span className={cn('w-full truncate px-1 text-center text-2xs leading-none', active && 'font-semibold')}>
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

/** Decisions waiting on a supervisor — the same count as the nav badge. */
function ApprovalsBadge() {
  const n = useApprovalsCount() ?? 0;
  if (n <= 0) return null;
  return (
    <span className="absolute -right-2 -top-1.5 rounded-full bg-gold px-1 text-3xs font-semibold leading-4 text-on-accent" aria-label={`${n} waiting`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** The Inbox total on the HR admin's tab — the same number as the rail. */
function InboxBadge() {
  const n = useInbox().data?.total ?? 0;
  if (n <= 0) return null;
  return (
    <span className="absolute -right-2 -top-1.5 rounded-full bg-gold px-1 text-3xs font-semibold leading-4 text-on-accent" aria-label={`${n} waiting`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

/** Live unread count for the Messages tab. Its own component so the
 *  query only mounts for roles that have the tab. */
function UnreadMessagesBadge() {
  const queryClient = useQueryClient();
  const unread = useQuery({
    queryKey: ['messages', 'unread'],
    queryFn: unreadMessages,
    refetchInterval: 60_000,
  });
  useEffect(
    () => onLiveEvent('message', () => void queryClient.invalidateQueries({ queryKey: ['messages'] })),
    [queryClient],
  );
  const n = unread.data?.unread ?? 0;
  if (n <= 0) return null;
  return (
    <span className="absolute -right-2 -top-1.5 rounded-full bg-gold px-1 text-3xs font-semibold leading-4 text-on-accent" aria-label={`${n} waiting`}>
      {n > 99 ? '99+' : n}
    </span>
  );
}
