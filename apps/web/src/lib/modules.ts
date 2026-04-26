import type { Capability } from './roles';

export type ModuleKey =
  | 'onboarding'
  | 'time-attendance'
  | 'scheduling'
  | 'payroll'
  | 'documents'
  | 'communications'
  | 'clients'
  | 'analytics'
  | 'compliance'
  | 'performance'
  | 'recruiting';

export interface ModuleNav {
  key: ModuleKey;
  path: string;
  label: string;
  description: string;
  requires: Capability;
}

export const MODULES: ModuleNav[] = [
  {
    key: 'onboarding',
    path: '/onboarding',
    label: 'Onboarding',
    description:
      'Digital application, document vault, e-signatures, background checks, and J-1 visa tracking.',
    requires: 'view:onboarding',
  },
  {
    key: 'time-attendance',
    path: '/time-attendance',
    label: 'Time & Attendance',
    description:
      'Geofenced clock-in, timesheet approvals, and attendance auditing.',
    requires: 'view:time',
  },
  {
    key: 'scheduling',
    path: '/scheduling',
    label: 'Scheduling',
    description:
      'Shift planning, fill rate tracking, and assignment management.',
    requires: 'view:scheduling',
  },
  {
    key: 'payroll',
    path: '/payroll',
    label: 'Payroll',
    description:
      'Multi-state payroll, anomaly detection, Branch cards, and Wise transfers.',
    requires: 'view:payroll',
  },
  {
    key: 'documents',
    path: '/documents',
    label: 'Document Vault',
    description:
      'Centralized storage, e-signatures, expiration alerts, and audit trails.',
    requires: 'view:documents',
  },
  {
    key: 'communications',
    path: '/communications',
    label: 'Communications',
    description:
      'SMS, push notifications, broadcast messaging, and templates.',
    requires: 'view:communications',
  },
  {
    key: 'clients',
    path: '/clients',
    label: 'Client Management',
    description:
      'CRM, contracts, SOW renewals, and client portal access.',
    requires: 'view:clients',
  },
  {
    key: 'analytics',
    path: '/analytics',
    label: 'Analytics & Reporting',
    description:
      'Executive dashboard, custom reports, and predictive analytics.',
    requires: 'view:analytics',
  },
  {
    key: 'compliance',
    path: '/compliance',
    label: 'Compliance & Legal',
    description:
      'OSHA, I-9, J-1, multi-state labor law, and certification tracking.',
    requires: 'view:compliance',
  },
  {
    key: 'performance',
    path: '/performance',
    label: 'Performance Management',
    description:
      'Reviews, KPIs, PIPs, commendations, disciplinary log, and 360 feedback.',
    requires: 'view:performance',
  },
  {
    key: 'recruiting',
    path: '/recruiting',
    label: 'Recruiting',
    description:
      'Candidate pipeline, interviews, offers, and hire-to-onboarding handoff.',
    requires: 'view:recruiting',
  },
];
