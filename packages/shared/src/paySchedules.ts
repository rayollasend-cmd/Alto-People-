import { z } from 'zod';

/**
 * Pay schedules, Fortune-500 grade: who is paid on which schedule is decided
 * by RULES (whole clients, sites, departments, pay types, individuals,
 * exclusions), applied from an EFFECTIVE DATE, and a payroll run pays exactly
 * the people on its schedule for the days they were on it.
 *
 * The API contract shared by the engine (apps/api/src/lib/payScheduleMembership.ts,
 * routes/paySchedules.ts) and the pages (apps/web/src/pages/payroll/schedules/*).
 *
 * Endpoints (all under the API root, capability process:payroll unless noted;
 * view:payroll may read):
 *   GET    /payroll/pay-schedules                       → PayScheduleListResponse
 *   POST   /payroll/pay-schedules                       PayScheduleCreateInput → { schedule: PayScheduleDetail }
 *   GET    /payroll/pay-schedules/:id                   → { schedule: PayScheduleDetail }
 *   PATCH  /payroll/pay-schedules/:id                   PayScheduleUpdateInput → { schedule: PayScheduleDetail }
 *          (name/notes/isActive/isDefault apply now; frequency/anchorDate/payDateOffsetDays
 *           need effectiveFrom = a future period start of the schedule and create a version)
 *   DELETE /payroll/pay-schedules/:id                   (refused while anyone is on it or a rule points at it)
 *   GET    /payroll/pay-schedules/:id/calendar?months=12 → PayCalendarResponse
 *   GET    /payroll/pay-schedules/:id/people?view=...    → PayScheduleRosterResponse
 *   GET    /payroll/pay-schedules/:id/history            → PayScheduleHistoryResponse
 *   POST   /payroll/pay-schedules/:id/membership/preview  MembershipChangeInput → MembershipImpact (dry run)
 *   POST   /payroll/pay-schedules/:id/membership          MembershipChangeInput → { impact: MembershipImpact }
 *   DELETE /payroll/pay-schedules/:id/rules/:ruleId       { effectiveFrom } → { impact: MembershipImpact }
 *   POST   /payroll/pay-schedules/move                    MoveInput → { impact: MembershipImpact } (drag between schedules)
 *   POST   /payroll/pay-schedules/move/preview            MoveInput → MembershipImpact
 *   GET    /payroll/pay-schedules/unassigned              → UnassignedResponse
 *   GET    /payroll/pay-schedules/candidates?clientId&siteId&departmentId&payType&scheduleId&q&status
 *                                                         → ScheduleCandidatesResponse (EVERYONE, new hires included, paged)
 *   GET    /payroll/pay-schedules/preview-pattern?frequency&anchorDate&payDateOffsetDays&months[&scheduleId&effectiveFrom]
 *                                                         → PayCalendarResponse (the setup wizard before saving; with scheduleId
 *                                                           + effectiveFrom, a pattern change's periods from that date, bridge first)
 *   GET    /associates/:id/pay-schedule                   → AssociatePaySchedule (view:payroll, or the person's onboarding reviewer)
 *   PUT    /associates/:id/pay-schedule                   { scheduleId, effectiveFrom? } → AssociatePaySchedule
 *          (an INDIVIDUAL rule; used by onboarding and the person's record)
 *   GET    /associates/:id/pay-schedule/choices           → PayScheduleChoicesResponse (the same readers: the
 *          schedules this person could be put on, for a picker that cannot read /payroll/pay-schedules)
 */

const Ymd = /* @__PURE__ */ (() => z.string().regex(/^\d{4}-\d{2}-\d{2}$/))();
const Id = /* @__PURE__ */ (() => z.string().uuid())();

export const PayFrequencySchema = /* @__PURE__ */ (() => z.enum(['WEEKLY', 'BIWEEKLY', 'SEMIMONTHLY', 'MONTHLY', 'DAILY']))();
export type PayFrequencyKind = z.infer<typeof PayFrequencySchema>;

/** How specific a rule is: an individual beats a site/department, which beats a client, which beats pay type, which beats the company default. */
export const ScheduleRuleKindSchema = /* @__PURE__ */ (() => z.enum(['INDIVIDUAL', 'SITE', 'DEPARTMENT', 'CLIENT', 'PAY_TYPE', 'EXCLUDE']))();
export type ScheduleRuleKind = z.infer<typeof ScheduleRuleKindSchema>;

export const RULE_SPECIFICITY: Record<Exclude<ScheduleRuleKind, 'EXCLUDE'>, number> = {
  INDIVIDUAL: 100,
  SITE: 60,
  DEPARTMENT: 50,
  CLIENT: 30,
  PAY_TYPE: 20,
};

/**
 * Why someone is on a schedule, as a sentence about them. The engine
 * records a short reason ("Client: Coastal Resort Holdings", "Site:
 * Seaside", "Individual", "Company default"); this is how every surface
 * says it — the notice to payroll, the roster, a person's record:
 *
 *   becauseSentence('Client: Coastal Resort Holdings')        → "They work for Coastal Resort Holdings"
 *   becauseSentence('Client: Coastal Resort Holdings', 'Ana') → "Ana works for Coastal Resort Holdings"
 *
 * A reason it doesn't know reads as given, capitalized.
 */
export function becauseSentence(because: string, name?: string | null): string {
  const t = because.trim();
  const who = name?.trim() || null;
  const say = (they: string, one: string) => (who ? `${who} ${one}` : they);
  const named = /^(Site|Department|Client): (.+)$/.exec(t);
  if (named) {
    const [, kind, place] = named;
    if (kind === 'Department') return `${say('They’re in', 'is in')} ${place}`;
    if (kind === 'Site') return `${say('They work at', 'works at')} ${place}`;
    return `${say('They work for', 'works for')} ${place}`;
  }
  switch (t) {
    case 'Individual':
      return `Chosen for ${who ?? 'them'} by name`;
    case 'Company default':
      return `No rule covers ${who ?? 'them'}, so the company default applies`;
    case 'Assigned earlier':
      return 'Assigned before schedule rules existed';
    case 'Salaried staff':
      return say('They’re salaried', 'is salaried');
    case 'Hourly staff':
      return say('They’re paid hourly', 'is paid hourly');
    case 'Planned move cancelled':
      return 'A planned move was called off';
  }
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

export const ScheduleRuleSchema = /* @__PURE__ */ (() => z.object({
  id: Id,
  kind: ScheduleRuleKindSchema,
  /** CLIENT / SITE / DEPARTMENT scope (SITE and DEPARTMENT carry their client when known). */
  clientId: Id.nullable(),
  clientName: z.string().nullable(),
  siteId: Id.nullable(),
  siteName: z.string().nullable(),
  departmentId: Id.nullable(),
  departmentName: z.string().nullable(),
  /** PAY_TYPE: HOURLY or SALARY. */
  payType: z.enum(['HOURLY', 'SALARY']).nullable(),
  /** INDIVIDUAL / EXCLUDE. */
  associateId: Id.nullable(),
  associateName: z.string().nullable(),
  effectiveFrom: Ymd,
  /** Last day the rule applies (null = open). */
  effectiveTo: Ymd.nullable(),
  /** How many people the rule covers today. */
  matches: z.number().int().nonnegative(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
}))();
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

/** One pay period on a calendar: dates, the payday, and a moved payday's reason. */
export const SchedulePeriodSchema = /* @__PURE__ */ (() => z.object({
  periodStart: Ymd,
  periodEnd: Ymd,
  payDate: Ymd,
  /** The date the schedule's rule would give, when a weekend/holiday moved it earlier. */
  unadjustedPayDate: Ymd.nullable(),
  /** "Thanksgiving Day", "Saturday" … */
  adjustedFor: z.string().nullable(),
  /** The run for this period, if any. */
  run: z.object({ id: Id, status: z.string() }).nullable(),
  /** A schedule version starts in this period (the pattern changed). */
  versionChange: z.boolean().optional(),
  /** A short period joining two patterns whose periods don't line up (no day paid twice or not at all). */
  bridge: z.boolean().optional(),
}))();
export type SchedulePeriod = z.infer<typeof SchedulePeriodSchema>;

export const PayCalendarResponseSchema = /* @__PURE__ */ (() => z.object({ periods: z.array(SchedulePeriodSchema) }))();
export type PayCalendarResponse = z.infer<typeof PayCalendarResponseSchema>;

export const PayScheduleSummarySchema = /* @__PURE__ */ (() => z.object({
  id: Id,
  name: z.string(),
  /** Plain sentence: "Every other week, Saturday to Friday, paid the next Friday". */
  pattern: z.string(),
  frequency: PayFrequencySchema,
  anchorDate: Ymd,
  payDateOffsetDays: z.number().int(),
  isActive: z.boolean(),
  /** The company default: anyone no rule covers lands here (when set). */
  isDefault: z.boolean(),
  /** Clients this schedule's CLIENT rules cover (for the table's Client column). */
  clients: z.array(z.object({ id: Id, name: z.string() })),
  people: z.number().int().nonnegative(),
  /** People whose next paycheck is at risk (red) / needs a look (amber). */
  blocked: z.number().int().nonnegative(),
  attention: z.number().int().nonnegative(),
  nextPeriod: SchedulePeriodSchema,
  /** A pattern change waiting to start. */
  pendingVersion: z.object({ effectiveFrom: Ymd, pattern: z.string() }).nullable(),
  /** People moving onto / off this schedule from a future date. */
  pendingJoins: z.number().int().nonnegative(),
  pendingLeaves: z.number().int().nonnegative(),
  notes: z.string().nullable(),
}))();
export type PayScheduleSummary = z.infer<typeof PayScheduleSummarySchema>;

export const PayScheduleListResponseSchema = /* @__PURE__ */ (() => z.object({
  schedules: z.array(PayScheduleSummarySchema),
  /** People no schedule covers (and no company default): they cannot be paid by a run. */
  unassigned: z.number().int().nonnegative(),
}))();
export type PayScheduleListResponse = z.infer<typeof PayScheduleListResponseSchema>;

export const PayScheduleDetailSchema = /* @__PURE__ */ (() => PayScheduleSummarySchema.extend({
  rules: z.array(ScheduleRuleSchema),
  versions: z.array(z.object({ effectiveFrom: Ymd, pattern: z.string(), frequency: PayFrequencySchema, anchorDate: Ymd, payDateOffsetDays: z.number().int(), createdByName: z.string().nullable() })),
}))();
export type PayScheduleDetail = z.infer<typeof PayScheduleDetailSchema>;

export const PayScheduleCreateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(120),
  frequency: PayFrequencySchema,
  /** First day of a pay period (weekly/biweekly), tiebreaker otherwise. */
  anchorDate: Ymd,
  payDateOffsetDays: z.number().int().min(0).max(31),
  notes: z.string().max(1000).nullable().optional(),
  isDefault: z.boolean().optional(),
  /** Who is on it from day one (the setup wizard's last step); optional. */
  membership: z.lazy(() => MembershipChangeInputSchema).optional(),
}))();
export type PayScheduleCreateInput = z.infer<typeof PayScheduleCreateInputSchema>;

export const PayScheduleUpdateInputSchema = /* @__PURE__ */ (() => z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  /** A pattern change: all three optional, but any of them needs effectiveFrom (a future period start). */
  frequency: PayFrequencySchema.optional(),
  anchorDate: Ymd.optional(),
  payDateOffsetDays: z.number().int().min(0).max(31).optional(),
  effectiveFrom: Ymd.optional(),
}))();
export type PayScheduleUpdateInput = z.infer<typeof PayScheduleUpdateInputSchema>;

/** Add rules / individuals / exclusions to a schedule from a date. */
export const MembershipChangeInputSchema = /* @__PURE__ */ (() => z.object({
  add: z
    .array(
      z.object({
        kind: ScheduleRuleKindSchema,
        clientId: Id.optional(),
        siteId: Id.optional(),
        departmentId: Id.optional(),
        payType: z.enum(['HOURLY', 'SALARY']).optional(),
        associateId: Id.optional(),
      }),
    )
    .max(500)
    .default([]),
  /** Rules to end (their last day is the day before effectiveFrom). */
  endRuleIds: z.array(Id).max(500).default([]),
  /** Defaults to the schedule's next period start. */
  effectiveFrom: Ymd.optional(),
  note: z.string().max(500).optional(),
}))();
export type MembershipChangeInput = z.infer<typeof MembershipChangeInputSchema>;

export const MovePersonSchema = /* @__PURE__ */ (() => z.object({
  associateId: Id,
  name: z.string(),
  photoUrl: z.string().nullable(),
  fromScheduleId: Id.nullable(),
  fromScheduleName: z.string().nullable(),
  toScheduleId: Id.nullable(),
  toScheduleName: z.string().nullable(),
  /** First day on the new schedule. */
  effectiveFrom: Ymd,
  /** Why: the rule that decided it ("Client: Coastal Resort Holdings", "Individual") — say it with becauseSentence. */
  because: z.string(),
  /** The paychecks that bridge the move: the old schedule's last check covers through effectiveFrom − 1. */
  transition: z.object({ lastOldPayDate: Ymd.nullable(), firstNewPayDate: Ymd.nullable(), note: z.string().nullable() }),
  /** A rule elsewhere claims this person just as specifically: a person must decide. */
  conflict: z.string().nullable(),
}))();
export type MovePerson = z.infer<typeof MovePersonSchema>;

export const MembershipImpactSchema = /* @__PURE__ */ (() => z.object({
  effectiveFrom: Ymd,
  joins: z.number().int().nonnegative(),
  leaves: z.number().int().nonnegative(),
  /** Already on this schedule: nothing changes for them. */
  unchanged: z.number().int().nonnegative(),
  newHires: z.number().int().nonnegative(),
  /** Moving from another schedule, grouped: "18 from Weekly". */
  movingFrom: z.array(z.object({ scheduleId: Id.nullable(), name: z.string(), count: z.number().int() })),
  conflicts: z.number().int().nonnegative(),
  people: z.array(MovePersonSchema),
  /** True when people were truncated in `people` (the counts are exact). */
  truncated: z.boolean(),
}))();
export type MembershipImpact = z.infer<typeof MembershipImpactSchema>;

export const MoveInputSchema = /* @__PURE__ */ (() => z.object({
  toScheduleId: Id,
  /** People, or whole client groups, being dragged. */
  associateIds: z.array(Id).max(2000).default([]),
  clientIds: z.array(Id).max(50).default([]),
  fromScheduleId: Id.nullable().optional(),
  effectiveFrom: Ymd.optional(),
}))();
export type MoveInput = z.infer<typeof MoveInputSchema>;

/** Whether this person will be paid correctly on the next payday. */
export const ReadinessLevelSchema = /* @__PURE__ */ (() => z.enum(['READY', 'ATTENTION', 'BLOCKED']))();
export type ReadinessLevel = z.infer<typeof ReadinessLevelSchema>;

export const ReadinessIssueSchema = /* @__PURE__ */ (() => z.object({
  code: z.enum([
    'NO_W4',
    'NO_PAYOUT',
    'PAYOUT_UNVERIFIED',
    'NO_RATE',
    'STATE_UNSUPPORTED',
    'NO_ADDRESS',
    'FIRST_CHECK',
    'RATE_CHANGED',
    'ON_LEAVE',
    'SEPARATING',
    'MOVING_SCHEDULE',
    'NO_SSN',
  ]),
  level: ReadinessLevelSchema,
  label: z.string(),
  /** Where to fix it (a path in the app), and the one-tap action label. */
  fixPath: z.string().nullable(),
  fixLabel: z.string().nullable(),
}))();
export type ReadinessIssue = z.infer<typeof ReadinessIssueSchema>;

export const RosterPersonSchema = /* @__PURE__ */ (() => z.object({
  associateId: Id,
  name: z.string(),
  photoUrl: z.string().nullable(),
  jobTitle: z.string().nullable(),
  clientId: Id.nullable(),
  clientName: z.string().nullable(),
  siteName: z.string().nullable(),
  departmentName: z.string().nullable(),
  payType: z.enum(['HOURLY', 'SALARY']).nullable(),
  /** "$18.50/h" or "$62,000/yr". */
  rateLabel: z.string().nullable(),
  lastPay: z.object({ payDate: Ymd, net: z.number() }).nullable(),
  ytdGross: z.number(),
  onScheduleSince: Ymd,
  because: z.string(),
  readiness: ReadinessLevelSchema,
  issues: z.array(ReadinessIssueSchema),
  /** A move already scheduled for this person. */
  pendingMove: z.object({ toScheduleName: z.string().nullable(), effectiveFrom: Ymd }).nullable(),
  isNewHire: z.boolean(),
}))();
export type RosterPerson = z.infer<typeof RosterPersonSchema>;

export const PayScheduleRosterResponseSchema = /* @__PURE__ */ (() => z.object({
  groups: z.array(
    z.object({
      clientId: Id.nullable(),
      clientName: z.string(),
      people: z.array(RosterPersonSchema),
      counts: z.object({ total: z.number().int(), ready: z.number().int(), attention: z.number().int(), blocked: z.number().int() }),
    }),
  ),
  totals: z.object({ total: z.number().int(), ready: z.number().int(), attention: z.number().int(), blocked: z.number().int() }),
}))();
export type PayScheduleRosterResponse = z.infer<typeof PayScheduleRosterResponseSchema>;

export const PayScheduleHistoryResponseSchema = /* @__PURE__ */ (() => z.object({
  events: z.array(
    z.object({
      at: z.string(),
      actorName: z.string().nullable(),
      /** "Added rule: Client Coastal Resort Holdings from Oct 31", "Pattern changes Nov 14", "Kim Nguyen moved here (transfer to Seaside)" … */
      summary: z.string(),
      kind: z.enum(['CREATED', 'RULE_ADDED', 'RULE_ENDED', 'PATTERN_CHANGED', 'PERSON_JOINED', 'PERSON_LEFT', 'SETTINGS']),
    }),
  ),
}))();
export type PayScheduleHistoryResponse = z.infer<typeof PayScheduleHistoryResponseSchema>;

export const ScheduleCandidateSchema = /* @__PURE__ */ (() => z.object({
  associateId: Id,
  name: z.string(),
  photoUrl: z.string().nullable(),
  email: z.string().nullable(),
  clientId: Id.nullable(),
  clientName: z.string().nullable(),
  siteName: z.string().nullable(),
  departmentName: z.string().nullable(),
  payType: z.enum(['HOURLY', 'SALARY']).nullable(),
  /** ACTIVE / NEW_HIRE (onboarding or approved, not worked yet) / INACTIVE. */
  status: z.enum(['ACTIVE', 'NEW_HIRE', 'INACTIVE']),
  currentScheduleId: Id.nullable(),
  currentScheduleName: z.string().nullable(),
}))();
export type ScheduleCandidate = z.infer<typeof ScheduleCandidateSchema>;

export const ScheduleCandidatesResponseSchema = /* @__PURE__ */ (() => z.object({
  people: z.array(ScheduleCandidateSchema),
  /** Exact count of everyone matching the filters (for "Select all 312 matching"). */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
  /** Filter options with counts. */
  facets: z.object({
    clients: z.array(z.object({ id: Id, name: z.string(), count: z.number().int() })),
    sites: z.array(z.object({ id: Id, name: z.string(), clientId: Id.nullable(), count: z.number().int() })),
    departments: z.array(z.object({ id: Id, name: z.string(), count: z.number().int() })),
  }),
}))();
export type ScheduleCandidatesResponse = z.infer<typeof ScheduleCandidatesResponseSchema>;

export const UnassignedResponseSchema = /* @__PURE__ */ (() => z.object({
  people: z.array(ScheduleCandidateSchema),
  total: z.number().int(),
}))();
export type UnassignedResponse = z.infer<typeof UnassignedResponseSchema>;

export const AssociatePayScheduleSchema = /* @__PURE__ */ (() => z.object({
  current: z.object({ scheduleId: Id, name: z.string(), pattern: z.string(), since: Ymd, because: z.string() }).nullable(),
  pending: z.object({ scheduleId: Id.nullable(), name: z.string().nullable(), effectiveFrom: Ymd, because: z.string() }).nullable(),
  /** What the rules would choose with no individual override (for onboarding's "default"). */
  ruleDefault: z.object({ scheduleId: Id, name: z.string(), because: z.string() }).nullable(),
  nextPayDate: Ymd.nullable(),
  /** A new hire (onboarding, or hired in the last 30 days and never paid on a run): the onboarding desk may choose their schedule on the record too. */
  newHire: z.boolean().optional(),
}))();
export type AssociatePaySchedule = z.infer<typeof AssociatePayScheduleSchema>;

/** One schedule a person could be put on — what a picker needs and nothing about who else is on it. */
export const PayScheduleChoiceSchema = /* @__PURE__ */ (() => z.object({
  id: Id,
  name: z.string(),
  pattern: z.string(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  /** The period whose pay date is the next payday. */
  nextPeriod: z.object({ periodStart: Ymd, periodEnd: Ymd, payDate: Ymd }),
  /** The first period that starts today or later — the default date for a move. */
  firstStart: Ymd,
}))();
export type PayScheduleChoice = z.infer<typeof PayScheduleChoiceSchema>;

export const PayScheduleChoicesResponseSchema = /* @__PURE__ */ (() => z.object({ schedules: z.array(PayScheduleChoiceSchema) }))();
export type PayScheduleChoicesResponse = z.infer<typeof PayScheduleChoicesResponseSchema>;
