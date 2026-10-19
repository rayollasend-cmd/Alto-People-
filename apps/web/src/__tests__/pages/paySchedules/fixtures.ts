import type {
  MembershipImpact,
  PayScheduleDetail,
  PayScheduleSummary,
  RosterPerson,
  ScheduleCandidate,
  ScheduleCandidatesResponse,
  SchedulePeriod,
  ScheduleRule,
} from '@alto-people/shared';

export const COASTAL = 'c0000000-0000-4000-8000-000000000001';
export const HARBOR = 'c0000000-0000-4000-8000-000000000002';

export const period = (o: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  periodStart: '2099-10-24',
  periodEnd: '2099-11-06',
  payDate: '2099-11-13',
  unadjustedPayDate: null,
  adjustedFor: null,
  run: null,
  ...o,
});

export const THANKSGIVING = period({ periodStart: '2099-11-14', periodEnd: '2099-11-20', payDate: '2099-11-25', unadjustedPayDate: '2099-11-26', adjustedFor: 'Thanksgiving Day' });

export const summary = (o: Partial<PayScheduleSummary> & Pick<PayScheduleSummary, 'id' | 'name'>): PayScheduleSummary => ({
  pattern: 'Every other week, Saturday to Friday, paid the Friday after',
  frequency: 'BIWEEKLY',
  anchorDate: '2099-10-10',
  payDateOffsetDays: 7,
  isActive: true,
  isDefault: false,
  clients: [],
  people: 0,
  blocked: 0,
  attention: 0,
  nextPeriod: period(),
  pendingVersion: null,
  pendingJoins: 0,
  pendingLeaves: 0,
  notes: null,
  ...o,
});

export const BIWEEKLY = summary({ id: 's1', name: 'Biweekly Hourly', people: 3, blocked: 1, attention: 1, clients: [{ id: COASTAL, name: 'Coastal Resort' }] });
export const WEEKLY = summary({ id: 's2', name: 'Weekly', frequency: 'WEEKLY', pattern: 'Every week, Saturday to Friday, paid the Thursday after', people: 2, nextPeriod: period({ periodStart: '2099-10-24', periodEnd: '2099-10-30', payDate: '2099-11-05' }) });

export const rule = (o: Partial<ScheduleRule> & Pick<ScheduleRule, 'id' | 'kind'>): ScheduleRule => ({
  clientId: null,
  clientName: null,
  siteId: null,
  siteName: null,
  departmentId: null,
  departmentName: null,
  payType: null,
  associateId: null,
  associateName: null,
  effectiveFrom: '2026-01-03',
  effectiveTo: null,
  matches: 0,
  createdAt: '2026-01-02T12:00:00Z',
  createdByName: 'Pat Payroll',
  ...o,
});

export const detail = (o: Partial<PayScheduleDetail> = {}): PayScheduleDetail => ({
  ...BIWEEKLY,
  rules: [
    rule({ id: 'r1', kind: 'CLIENT', clientId: COASTAL, clientName: 'Coastal Resort', matches: 3 }),
    rule({ id: 'r2', kind: 'EXCLUDE', associateId: 'a9', associateName: 'Lee Park' }),
  ],
  versions: [],
  ...o,
});

export const person = (o: Partial<RosterPerson> & Pick<RosterPerson, 'associateId' | 'name'>): RosterPerson => ({
  photoUrl: null,
  jobTitle: 'Housekeeper',
  clientId: COASTAL,
  clientName: 'Coastal Resort',
  siteName: 'North Tower',
  departmentName: null,
  payType: 'HOURLY',
  rateLabel: '$18.50/h',
  lastPay: { payDate: '2099-10-16', net: 812.4 },
  ytdGross: 21450,
  onScheduleSince: '2026-01-03',
  because: 'Client: Coastal Resort',
  readiness: 'READY',
  issues: [],
  pendingMove: null,
  isNewHire: false,
  ...o,
});

export const MARIA = person({ associateId: 'a1', name: 'Maria Lopez' });
export const SAM = person({
  associateId: 'a2',
  name: 'Sam Okafor',
  readiness: 'BLOCKED',
  issues: [{ code: 'NO_W4', level: 'BLOCKED', label: 'No W-4 on file', fixPath: '/people/a2?tab=tax', fixLabel: 'Collect W-4' }],
});
export const KIM = person({ associateId: 'a3', name: 'Kim Nguyen', readiness: 'ATTENTION', isNewHire: true, issues: [{ code: 'FIRST_CHECK', level: 'ATTENTION', label: 'First paycheck', fixPath: null, fixLabel: null }] });

export const candidate = (o: Partial<ScheduleCandidate> & Pick<ScheduleCandidate, 'associateId' | 'name'>): ScheduleCandidate => ({
  photoUrl: null,
  email: null,
  clientId: COASTAL,
  clientName: 'Coastal Resort',
  siteName: null,
  departmentName: null,
  payType: 'HOURLY',
  status: 'ACTIVE',
  currentScheduleId: null,
  currentScheduleName: null,
  ...o,
});

export const FACETS: ScheduleCandidatesResponse['facets'] = {
  clients: [
    { id: COASTAL, name: 'Coastal Resort', count: 3 },
    { id: HARBOR, name: 'Harbor Inn', count: 2 },
  ],
  sites: [],
  departments: [],
};

export const impact = (o: Partial<MembershipImpact> = {}): MembershipImpact => ({
  effectiveFrom: '2099-10-24',
  joins: 0,
  leaves: 0,
  unchanged: 0,
  newHires: 0,
  movingFrom: [],
  conflicts: 0,
  people: [],
  truncated: false,
  ...o,
});
