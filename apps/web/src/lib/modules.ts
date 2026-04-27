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
  | 'org-chart'
  | 'celebrations'
  | 'assets'
  | 'pulse'
  | 'headcount'
  | 'skills'
  | 'mentorship'
  | 'expirations'
  | 'learning-paths'
  | 'succession'
  | 'probation'
  | 'holidays'
  | 'discipline'
  | 'separations'
  | 'internal-jobs'
  | 'vaccinations'
  | 'agreements'
  | 'hr-cases'
  | 'help-center'
  | 'team'
  | 'workflows'
  | 'me'
  | 'compensation'
  | 'marketplace'
  | 'payrules'
  | 'dircomms';

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

import { Network as OrgChartIcon, Users as UsersIcon, Workflow as WorkflowIcon, UserCircle as UserCircleIcon, Wallet as WalletIcon, Store as StoreIcon, BadgeDollarSign as PayRulesIcon, Megaphone as MegaphoneIcon, PartyPopper as CelebrationsIcon, Laptop as AssetsIcon, Activity as PulseIcon, BarChart3 as HeadcountIcon, Sparkles as SkillsIcon, GraduationCap as MentorshipIcon, ShieldAlert as ExpirationsIcon, Route as LearningPathsIcon, Crown as SuccessionIcon, ShieldQuestion as ProbationIcon, CalendarDays as HolidayIcon, Gavel as DisciplineIcon, LogOut as SeparationIcon, Briefcase as InternalJobsIcon, Syringe as VaccinationsIcon, FileSignature as AgreementsIcon, MessageCircle as HrCasesIcon, BookOpen as KbIcon } from 'lucide-react';

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
    key: 'org-chart',
    path: '/org/chart',
    label: 'Org chart',
    description:
      'Visual reporting tree across the company. Search by name, title, or department to focus a chain.',
    requires: 'view:org',
    icon: OrgChartIcon,
    group: 'workforce',
  },
  {
    key: 'celebrations',
    path: '/celebrations',
    label: 'Celebrations',
    description:
      'Upcoming birthdays and work anniversaries. Send a quick high-five from any row.',
    requires: 'view:org',
    icon: CelebrationsIcon,
    group: 'workforce',
  },
  {
    key: 'assets',
    path: '/assets',
    label: 'Assets',
    description:
      'Physical items assigned to associates: laptops, phones, badges, keys, vehicles. Track who has what and when it came back.',
    requires: 'view:org',
    icon: AssetsIcon,
    group: 'workforce',
  },
  {
    key: 'pulse',
    path: '/pulse',
    label: 'Pulse',
    description:
      'Anonymous one-question check-ins for engagement signal. Score distributions and verbatim comments — never the responder.',
    requires: 'view:dashboard',
    icon: PulseIcon,
    group: 'workforce',
  },
  {
    key: 'headcount',
    path: '/headcount',
    label: 'Headcount',
    description:
      'Active associates across the company, hires & separations over the last 30 / 90 / 365 days, annualized turnover.',
    requires: 'view:org',
    icon: HeadcountIcon,
    group: 'workforce',
  },
  {
    key: 'skills',
    path: '/skills',
    label: 'Skills',
    description:
      'Catalog of competencies and per-associate skill claims with proficiency level. Search the company by skill — useful for staffing and internal mobility.',
    requires: 'view:org',
    icon: SkillsIcon,
    group: 'workforce',
  },
  {
    key: 'mentorship',
    path: '/mentorship',
    label: 'Mentorship',
    description:
      'Pair experienced associates with juniors. Suggestions use skills data to recommend ADVANCED+ mentors for a target growth skill.',
    requires: 'view:org',
    icon: MentorshipIcon,
    group: 'workforce',
  },
  {
    key: 'expirations',
    path: '/expirations',
    label: 'Expirations',
    description:
      'Qualifications and certifications expiring soon — chase renewals before they lapse. Bucketed expired / due soon / due later.',
    requires: 'view:org',
    icon: ExpirationsIcon,
    group: 'compliance',
  },
  {
    key: 'learning-paths',
    path: '/learning-paths',
    label: 'Learning paths',
    description:
      'Sequence multiple courses into ordered tracks. Associates work through them in order; status reflects the next incomplete step.',
    requires: 'view:compliance',
    icon: LearningPathsIcon,
    group: 'compliance',
  },
  {
    key: 'succession',
    path: '/succession',
    label: 'Succession',
    description:
      'Designate successors for each position with a readiness band — ready now, 1–2 years, 3+ years, or emergency cover.',
    requires: 'view:performance',
    icon: SuccessionIcon,
    group: 'workforce',
  },
  {
    key: 'probation',
    path: '/probation',
    label: 'Probation',
    description:
      'New-hire probation periods. See who is active, ending soon, or overdue. Pass, extend, or fail before the end date.',
    requires: 'view:onboarding',
    icon: ProbationIcon,
    group: 'workforce',
  },
  {
    key: 'holidays',
    path: '/holidays',
    label: 'Holidays',
    description:
      'Federal, state, company, and client-specific holidays. Drives premium pay multipliers and shift planning.',
    requires: 'view:scheduling',
    icon: HolidayIcon,
    group: 'time-and-pay',
  },
  {
    key: 'discipline',
    path: '/discipline',
    label: 'Discipline',
    description:
      'Formal warning ladder — verbal, written, final, suspension, termination. Associates can acknowledge; HR can rescind.',
    requires: 'view:performance',
    icon: DisciplineIcon,
    group: 'workforce',
  },
  {
    key: 'separations',
    path: '/separations',
    label: 'Separations',
    description:
      'Plan, process, and complete associate departures. Capture exit-interview feedback — rating, what worked, what to change.',
    requires: 'view:onboarding',
    icon: SeparationIcon,
    group: 'workforce',
  },
  {
    key: 'internal-jobs',
    path: '/internal-jobs',
    label: 'Internal jobs',
    description:
      'Open positions across the company that current associates can apply to directly. Hiring managers review and decide.',
    requires: 'view:dashboard',
    icon: InternalJobsIcon,
    group: 'workforce',
  },
  {
    key: 'vaccinations',
    path: '/vaccinations',
    label: 'Vaccinations',
    description:
      'Vaccination + TB-test records. Required by many client SLAs. Coverage % per kind, expiring-soon feed.',
    requires: 'view:compliance',
    icon: VaccinationsIcon,
    group: 'compliance',
  },
  {
    key: 'agreements',
    path: '/agreements',
    label: 'Agreements',
    description:
      'NDAs, non-competes, IP assignments, equity grants — per-associate one-off legal agreements with electronic signature.',
    requires: 'view:dashboard',
    icon: AgreementsIcon,
    group: 'compliance',
  },
  {
    key: 'hr-cases',
    path: '/hr-cases',
    label: 'HR cases',
    description:
      'Ticketing for HR. File a question or concern, HR triages and replies. Internal notes stay hidden from the requester.',
    requires: 'view:dashboard',
    icon: HrCasesIcon,
    group: 'workforce',
  },
  {
    key: 'help-center',
    path: '/help-center',
    label: 'Help center',
    description:
      'Self-service knowledge base. Search articles by category and tag; vote helpful / not helpful. Deflects HR cases.',
    requires: 'view:dashboard',
    icon: KbIcon,
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
    key: 'dircomms',
    path: '/directory',
    label: 'Directory & comms',
    description:
      'Search the people directory, send broadcasts, and run pulse / eNPS / open-ended surveys.',
    requires: 'view:dashboard',
    icon: MegaphoneIcon,
    group: 'insights',
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
