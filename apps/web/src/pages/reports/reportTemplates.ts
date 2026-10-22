import type { ReportEntity, ReportSpec } from '@/lib/reports96Api';

/**
 * The report builder's starting points (HR walk 17): the questions HR asks
 * every month, already built. Each opens the builder pre-filled and unsaved
 * (the 'draft' seed), so a template is a head start, never a saved report
 * nobody asked for. Every column here is one the server's whitelist
 * (apps/api/src/lib/reportRun.ts ENTITY_COLUMNS) serves; where the engine
 * has no column for the exact question, the hint says what it shows instead.
 */
export interface ReportTemplate {
  key: string;
  name: string;
  hint: string;
  entity: ReportEntity;
  spec: ReportSpec;
  /** Only where the tenant staffs clients (the client-portal module). */
  needsClients?: boolean;
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
    name: 'Terminations by reason',
    hint: 'Separations last month, counted by reason.',
    entity: 'SEPARATION',
    spec: {
      columns: ['reason'],
      filters: [{ column: 'lastDayWorked', op: 'period', value: 'last-month' }],
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
    key: 'headcount-by-state',
    name: 'Headcount by state',
    hint: 'People per state. The engine has no {store} column yet; the People list filters by {store}.',
    entity: 'ASSOCIATE',
    spec: {
      columns: ['state'],
      filters: [],
      sort: [],
      limit: 1000,
      groupBy: ['state'],
      aggregates: count,
    },
  },
  {
    key: 'gross-by-run',
    name: 'Gross pay by payroll run',
    hint: 'Total gross per run. Individual pay changes are on each person’s Pay tab.',
    entity: 'PAYROLL_ITEM',
    spec: {
      columns: ['runId'],
      filters: [],
      sort: [],
      limit: 1000,
      groupBy: ['runId'],
      aggregates: [{ fn: 'sum', column: 'grossAmount', alias: 'gross' }, ...count],
    },
  },
  {
    key: 'time-to-fill',
    name: 'Hires this month',
    hint: 'Candidates hired, with the day they applied — the start of time to fill.',
    entity: 'CANDIDATE',
    spec: {
      columns: ['firstName', 'lastName', 'stage', 'createdAt'],
      filters: [{ column: 'stage', op: 'eq', value: 'HIRED' }],
      sort: [{ column: 'createdAt', direction: 'asc' }],
      limit: 1000,
    },
  },
  {
    key: 'offer-acceptance',
    name: 'Offer acceptance',
    hint: 'Offers this year by outcome: accepted, declined, still out.',
    entity: 'OFFER',
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
    key: 'time-entries-last-week',
    name: 'Punches last week by status',
    hint: 'Time entries last week by where they stand. Hours and overtime by {store} are on Labor costs.',
    entity: 'TIME_ENTRY',
    spec: {
      columns: ['status'],
      filters: [{ column: 'clockIn', op: 'period', value: 'last-week' }],
      sort: [],
      limit: 1000,
      groupBy: ['status'],
      aggregates: count,
    },
  },
  {
    key: 'open-leave',
    name: 'Open leave',
    hint: 'Leave cases not yet closed, with their dates.',
    entity: 'LEAVE_CASE',
    spec: {
      columns: ['associateId', 'type', 'status', 'startDate', 'endDate'],
      filters: [{ column: 'status', op: 'in', value: ['REQUESTED', 'PENDING_CERTIFICATION', 'APPROVED'] }],
      sort: [{ column: 'startDate', direction: 'asc' }],
      limit: 1000,
    },
  },
];
