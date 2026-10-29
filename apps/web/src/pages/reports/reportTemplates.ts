import type { Capability } from '@alto-people/shared';
import type { ReportEntity, ReportSpec } from '@/lib/reports96Api';

/**
 * The report builder's starting points (HR walk 17): the questions HR asks
 * every month, already built. Each opens the builder pre-filled and unsaved
 * (the 'draft' seed), so a template is a head start, never a saved report
 * nobody asked for. Every column here is one the server's whitelist
 * (apps/api/src/lib/reportRun.ts ENTITY_COLUMNS) serves. The computed ones
 * (store, pay changes, time to fill, overtime by store) come from
 * apps/api/src/lib/reportComputed.ts.
 */
export interface ReportTemplate {
  key: string;
  name: string;
  hint: string;
  entity: ReportEntity;
  spec: ReportSpec;
  /** Only where the tenant staffs clients (the client-portal module). */
  needsClients?: boolean;
  /** Only for people who may run it (the entity's own capability on the API). */
  requires?: Capability;
}

/** `{client}` / `{store}` in a template's copy read in the tenant's own words. */
export function templateText(text: string, words: { client: string; store: string }): string {
  return text.replace(/\{client\}/g, words.client).replace(/\{store\}/g, words.store);
}

const count = [{ fn: 'count' as const, column: null, alias: 'count' }];

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: 'new-hires-month',
    name: 'New hires this month',
    hint: 'People added this month, newest first.',
    entity: 'ASSOCIATE',
    spec: {
      columns: ['firstName', 'lastName', 'email', 'state', 'createdAt'],
      filters: [{ column: 'createdAt', op: 'period', value: 'month-to-date' }],
      sort: [{ column: 'createdAt', direction: 'desc' }],
      limit: 1000,
    },
  },
  {
    key: 'terminations-by-reason',
    name: 'Terminations by reason, last quarter',
    hint: 'Separations whose last day fell in the last calendar quarter, counted by reason.',
    entity: 'SEPARATION',
    requires: 'view:hr-admin',
    spec: {
      columns: ['reason'],
      filters: [{ column: 'lastDayWorked', op: 'period', value: 'last-quarter' }],
      sort: [],
      limit: 1000,
      groupBy: ['reason'],
      aggregates: count,
    },
  },
  {
    key: 'pending-onboarding-by-client',
    name: 'Pending onboarding by {client}',
    hint: 'Applications waiting on HR review, per {client}.',
    entity: 'APPLICATION',
    needsClients: true,
    spec: {
      columns: ['clientId'],
      filters: [{ column: 'status', op: 'in', value: ['SUBMITTED', 'IN_REVIEW'] }],
      sort: [],
      limit: 1000,
      groupBy: ['clientId'],
      aggregates: count,
    },
  },
  {
    key: 'i9-section2-due',
    name: 'I-9 Section 2 due',
    hint: 'Approved hires, newest first. The I-9 tab under Compliance is the live Section 2 queue with each deadline.',
    entity: 'APPLICATION',
    spec: {
      columns: ['associateId', 'clientId', 'status', 'createdAt'],
      filters: [{ column: 'status', op: 'eq', value: 'APPROVED' }],
      sort: [{ column: 'createdAt', direction: 'desc' }],
      limit: 1000,
    },
  },
  {
    key: 'headcount-by-store',
    name: 'Headcount by {store}',
    // `active` is Working, the one definition every screen counts (LEAD-9) — not account status.
    hint: 'People working now — placed, and worked in the active window or with a shift ahead — counted by the {store} they are placed at.',
    entity: 'ASSOCIATE',
    spec: {
      columns: ['store'],
      filters: [{ column: 'active', op: 'eq', value: true }],
      sort: [],
      limit: 1000,
      groupBy: ['store'],
      aggregates: count,
    },
  },
  {
    key: 'pay-changes',
    name: 'Pay changes',
    hint: 'Every pay change in the last 90 days: the rate before, the new rate, the change and why.',
    entity: 'PAY_CHANGE',
    requires: 'view:comp',
    spec: {
      columns: ['name', 'store', 'effectiveFrom', 'previousAmount', 'amount', 'change', 'changePct', 'reason'],
      filters: [{ column: 'effectiveFrom', op: 'period', value: 'last-90-days' }],
      sort: [{ column: 'effectiveFrom', direction: 'desc' }],
      limit: 1000,
    },
  },
  {
    key: 'time-to-fill',
    name: 'Time to fill',
    hint: 'Days from a posting opening to each hire against it, this year: the average and the longest, per posting.',
    entity: 'TIME_TO_FILL',
    requires: 'view:recruiting',
    spec: {
      columns: ['posting'],
      filters: [{ column: 'hiredAt', op: 'period', value: 'year-to-date' }],
      sort: [],
      limit: 1000,
      groupBy: ['posting'],
      aggregates: [{ fn: 'avg', column: 'daysToFill', alias: 'avgDays' }, { fn: 'max', column: 'daysToFill', alias: 'longestDays' }, { fn: 'count', column: null, alias: 'hires' }],
    },
  },
  {
    key: 'offer-acceptance',
    name: 'Offer acceptance',
    hint: 'Offers this year by outcome: accepted, declined, still out.',
    entity: 'OFFER',
    requires: 'view:recruiting',
    spec: {
      columns: ['status'],
      filters: [{ column: 'createdAt', op: 'period', value: 'year-to-date' }],
      sort: [],
      limit: 1000,
      groupBy: ['status'],
      aggregates: count,
    },
  },
  {
    key: 'overtime-by-store',
    name: 'Overtime by {store}',
    hint: 'Overtime and double-time hours last week per {store}, split the way the paycheck splits them.',
    entity: 'OVERTIME',
    spec: {
      columns: ['store'],
      filters: [{ column: 'weekStart', op: 'period', value: 'last-week' }],
      sort: [],
      limit: 1000,
      groupBy: ['store'],
      aggregates: [
        { fn: 'sum', column: 'overtimeHours', alias: 'overtimeHours' },
        { fn: 'sum', column: 'doubleTimeHours', alias: 'doubleTimeHours' },
        { fn: 'sum', column: 'workedHours', alias: 'workedHours' },
      ],
    },
  },
  {
    key: 'open-leave',
    name: 'Open leave',
    hint: 'Leave cases not yet closed, with their dates.',
    entity: 'LEAVE_CASE',
    requires: 'manage:leave',
    spec: {
      columns: ['associateId', 'type', 'status', 'startDate', 'endDate'],
      filters: [{ column: 'status', op: 'in', value: ['REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED'] }],
      sort: [{ column: 'startDate', direction: 'asc' }],
      limit: 1000,
    },
  },
];
