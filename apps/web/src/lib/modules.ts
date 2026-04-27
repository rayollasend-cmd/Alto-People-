import type { LucideIcon } from 'lucide-react';
import {
  Award,
  Briefcase,
  Building2,
  Calendar,
  CalendarOff,
  ClipboardList,
  DollarSign,
  FileText,
  HeartPulse,
  LineChart,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Timer,
  UserPlus,
} from 'lucide-react';
import type { Capability } from './roles';

export type ModuleKey =
  | 'onboarding'
  | 'time-attendance'
  | 'time-off'
  | 'scheduling'
  | 'payroll'
  | 'documents'
  | 'communications'
  | 'clients'
  | 'analytics'
  | 'compliance'
  | 'performance'
  | 'recruiting'
  | 'audit'
  | 'benefits'
  | 'org'
  | 'team'
  | 'workflows'
  | 'me'
  | 'compensation'
  | 'marketplace'
  | 'payrules';

/**
 * Phase 67 — sidebar groupings, F500-style. Modules with the same `group`
 * are rendered under a shared header in the sidebar. Order within a group
 * is the array order in `MODULES`. The "core" group is rendered without a
 * header (it's the always-on stuff: dashboard, onboarding, recruiting).
 */
export type ModuleGroup =
  | 'core'
  | 'workforce'
  | 'time-and-pay'
  | 'compliance'
  | 'insights';

export const GROUP_LABEL: Record<Exclude<ModuleGroup, 'core'>, string> = {
  workforce: 'Workforce',
  'time-and-pay': 'Time & Pay',
  compliance: 'Compliance',
  insights: 'Insights',
};

export interface ModuleNav {
  key: ModuleKey;
  path: string;
  label: string;
  description: string;
  requires: Capability;
  /** Phase 27 — icon shown in the sidebar / module launcher. */
  icon: LucideIcon;
  /** Phase 67 — sidebar grouping. */
  group: ModuleGroup;
}

// Re-exported so other components don't need their own lucide imports.
export {
  Award,
  Briefcase,
  Building2,
  Calendar,
  CalendarOff,
  ClipboardList,
  DollarSign,
  FileText,
  HeartPulse,
  LineChart,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Timer,
  UserPlus,
};

import { Network as OrgChartIcon, Users as UsersIcon, Workflow as WorkflowIcon, UserCircle as UserCircleIcon, Wallet as WalletIcon, Store as StoreIcon, BadgeDollarSign as PayRulesIcon } from 'lucide-react';

export const MODULES: ModuleNav[] = [
  {
    key: 'me',
    path: '/me',
    label: 'My profile',
    description:
      'Personal info, emergency contacts, dependents, beneficiaries, life events, and tax documents — all the personal records you can manage yourself.',
    requires: 'view:dashboard',
    icon: UserCircleIcon,
    group: 'core',
  },
  {
    key: 'onboarding',
    path: '/onboarding',
    label: 'Onboarding',
    description:
      'Digital application, document vault, e-signatures, background checks, and J-1 visa tracking.',
    requires: 'view:onboarding',
    icon: ClipboardList,
    group: 'workforce',
  },
  {
    key: 'recruiting',
    path: '/recruiting',
    label: 'Recruiting',
    description:
      'Candidate pipeline, interviews, offers, and hire-to-onboarding handoff.',
    requires: 'view:recruiting',
    icon: UserPlus,
    group: 'workforce',
  },
  {
    key: 'org',
    path: '/org',
    label: 'Org structure',
    description:
      'Departments, cost centers, job profiles, and the manager chain that holds approvals + dimensional reporting together.',
    requires: 'view:org',
    icon: OrgChartIcon,
    group: 'workforce',
  },
  {
    key: 'team',
    path: '/team',
    label: 'My team',
    description:
      'Direct reports, timesheet reviews, and time-off decisions. Visible to anyone with at least one direct report.',
    requires: 'view:my-team',
    icon: UsersIcon,
    group: 'workforce',
  },
  {
    key: 'workflows',
    path: '/workflows',
    label: 'Workflows',
    description:
      'Trigger-condition-action automation that fires on hires, time-off decisions, position changes, and other events.',
    requires: 'view:org',
    icon: WorkflowIcon,
    group: 'insights',
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Clients',
    description:
      'CRM, contracts, SOW renewals, and client portal access.',
    requires: 'view:clients',
    icon: Building2,
    group: 'workforce',
  },
  {
    key: 'performance',
    path: '/performance',
    label: 'Performance',
    description:
      'Reviews, KPIs, PIPs, commendations, disciplinary log, and 360 feedback.',
    requires: 'view:performance',
    icon: Award,
    group: 'workforce',
  },
  {
    key: 'time-attendance',
    path: '/time-attendance',
    label: 'Time & Attendance',
    description:
      'Geofenced clock-in, timesheet approvals, and attendance auditing.',
    requires: 'view:time',
    icon: Timer,
    group: 'time-and-pay',
  },
  {
    key: 'time-off',
    path: '/time-off',
    label: 'Time Off',
    description:
      'PTO requests, sick-leave balances, and HR approval queue.',
    requires: 'view:time',
    icon: CalendarOff,
    group: 'time-and-pay',
  },
  {
    key: 'scheduling',
    path: '/scheduling',
    label: 'Scheduling',
    description:
      'Shift planning, fill rate tracking, and assignment management.',
    requires: 'view:scheduling',
    icon: Calendar,
    group: 'time-and-pay',
  },
  {
    key: 'payroll',
    path: '/payroll',
    label: 'Payroll',
    description:
      'Multi-state payroll, anomaly detection, Branch cards, and Wise transfers.',
    requires: 'view:payroll',
    icon: DollarSign,
    group: 'time-and-pay',
  },
  {
    key: 'marketplace',
    path: '/marketplace',
    label: 'Open shifts',
    description:
      'Marketplace of open shifts qualified associates can pick up. Managers approve claims.',
    requires: 'view:scheduling',
    icon: StoreIcon,
    group: 'time-and-pay',
  },
  {
    key: 'payrules',
    path: '/payrules',
    label: 'Pay rules',
    description:
      'Project codes, premium-pay differentials (overtime, night, holiday), and tip pools.',
    requires: 'view:payroll',
    icon: PayRulesIcon,
    group: 'time-and-pay',
  },
  {
    key: 'compensation',
    path: '/compensation',
    label: 'Compensation',
    description:
      'Pay bands, effective-dated comp history, and merit cycles — plan and apply pay changes for an entire population at once.',
    requires: 'view:comp',
    icon: WalletIcon,
    group: 'time-and-pay',
  },
  {
    key: 'benefits',
    path: '/benefits',
    label: 'Benefits',
    description:
      'Health, dental, vision, 401(k), HSA/FSA — pre-tax elections that come out of every paycheck.',
    requires: 'view:payroll',
    icon: HeartPulse,
    group: 'time-and-pay',
  },
  {
    key: 'documents',
    path: '/documents',
    label: 'Documents',
    description:
      'Centralized storage, e-signatures, expiration alerts, and audit trails.',
    requires: 'view:documents',
    icon: FileText,
    group: 'compliance',
  },
  {
    key: 'compliance',
    path: '/compliance',
    label: 'Compliance',
    description:
      'OSHA, I-9, J-1, multi-state labor law, and certification tracking.',
    requires: 'view:compliance',
    icon: ShieldCheck,
    group: 'compliance',
  },
  {
    key: 'audit',
    path: '/audit',
    label: 'Audit log',
    description:
      'Searchable, exportable feed of every auth, onboarding, payroll, and document event.',
    requires: 'view:audit',
    icon: ScrollText,
    group: 'compliance',
  },
  {
    key: 'communications',
    path: '/communications',
    label: 'Communications',
    description:
      'SMS, push notifications, broadcast messaging, and templates.',
    requires: 'view:communications',
    icon: MessageSquare,
    group: 'insights',
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'Analytics',
    description:
      'Executive dashboard, custom reports, and predictive analytics.',
    requires: 'view:analytics',
    icon: LineChart,
    group: 'insights',
  },
];

/** Sidebar entry for the home dashboard (not a module). */
export const DASHBOARD_NAV = {
  path: '/',
  label: 'Dashboard',
  icon: Briefcase,
} as const;
