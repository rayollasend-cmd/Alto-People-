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
  | 'audit';

export interface ModuleNav {
  key: ModuleKey;
  path: string;
  label: string;
  description: string;
  requires: Capability;
  /** Phase 27 — icon shown in the sidebar / module launcher. */
  icon: LucideIcon;
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
  LineChart,
  MessageSquare,
  ScrollText,
  ShieldCheck,
  Timer,
  UserPlus,
};

export const MODULES: ModuleNav[] = [
  {
    key: 'onboarding',
    path: '/onboarding',
    label: 'Onboarding',
    description:
      'Digital application, document vault, e-signatures, background checks, and J-1 visa tracking.',
    requires: 'view:onboarding',
    icon: ClipboardList,
  },
  {
    key: 'time-attendance',
    path: '/time-attendance',
    label: 'Time & Attendance',
    description:
      'Geofenced clock-in, timesheet approvals, and attendance auditing.',
    requires: 'view:time',
    icon: Timer,
  },
  {
    key: 'time-off',
    path: '/time-off',
    label: 'Time Off',
    description:
      'PTO requests, sick-leave balances, and HR approval queue.',
    requires: 'view:time',
    icon: CalendarOff,
  },
  {
    key: 'scheduling',
    path: '/scheduling',
    label: 'Scheduling',
    description:
      'Shift planning, fill rate tracking, and assignment management.',
    requires: 'view:scheduling',
    icon: Calendar,
  },
  {
    key: 'payroll',
    path: '/payroll',
    label: 'Payroll',
    description:
      'Multi-state payroll, anomaly detection, Branch cards, and Wise transfers.',
    requires: 'view:payroll',
    icon: DollarSign,
  },
  {
    key: 'documents',
    path: '/documents',
    label: 'Document Vault',
    description:
      'Centralized storage, e-signatures, expiration alerts, and audit trails.',
    requires: 'view:documents',
    icon: FileText,
  },
  {
    key: 'communications',
    path: '/communications',
    label: 'Communications',
    description:
      'SMS, push notifications, broadcast messaging, and templates.',
    requires: 'view:communications',
    icon: MessageSquare,
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Client Management',
    description:
      'CRM, contracts, SOW renewals, and client portal access.',
    requires: 'view:clients',
    icon: Building2,
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'Analytics & Reporting',
    description:
      'Executive dashboard, custom reports, and predictive analytics.',
    requires: 'view:analytics',
    icon: LineChart,
  },
  {
    key: 'compliance',
    path: '/compliance',
    label: 'Compliance & Legal',
    description:
      'OSHA, I-9, J-1, multi-state labor law, and certification tracking.',
    requires: 'view:compliance',
    icon: ShieldCheck,
  },
  {
    key: 'performance',
    path: '/performance',
    label: 'Performance Management',
    description:
      'Reviews, KPIs, PIPs, commendations, disciplinary log, and 360 feedback.',
    requires: 'view:performance',
    icon: Award,
  },
  {
    key: 'recruiting',
    path: '/recruiting',
    label: 'Recruiting',
    description:
      'Candidate pipeline, interviews, offers, and hire-to-onboarding handoff.',
    requires: 'view:recruiting',
    icon: UserPlus,
  },
  {
    key: 'audit',
    path: '/audit',
    label: 'Audit Log',
    description:
      'Searchable, exportable feed of every auth, onboarding, payroll, and document event.',
    requires: 'view:audit',
    icon: ScrollText,
  },
];

/** Sidebar entry for the home dashboard (not a module). */
export const DASHBOARD_NAV = {
  path: '/',
  label: 'Dashboard',
  icon: Briefcase,
} as const;
