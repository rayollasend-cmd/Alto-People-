import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import type { PayrollFrequency, Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  AssociatePayScheduleSchema,
  MembershipChangeInputSchema,
  MembershipImpactSchema,
  MoveInputSchema,
  PayCalendarResponseSchema,
  PayFrequencySchema,
  PayScheduleChoicesResponseSchema,
  PayScheduleCreateInputSchema,
  PayScheduleDetailSchema,
  PayScheduleHistoryResponseSchema,
  PayScheduleListResponseSchema,
  PayScheduleRosterResponseSchema,
  PayScheduleUpdateInputSchema,
  ScheduleCandidatesResponseSchema,
  UnassignedResponseSchema,
  can,
  type MembershipChangeInput,
  type MembershipImpact,
  type MovePerson,
  type PayScheduleDetail,
  type PayScheduleSummary,
  type ReadinessIssue,
  type ReadinessLevel,
  type RosterPerson,
  type ScheduleCandidate,
  type SchedulePeriod,
  type ScheduleRule,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { internalSites, scopeAssociates, scopePayrollSchedules, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { profilePhotoUrlFor } from '../lib/profilePhotoUrl.js';
import { loadTenantHolidays } from '../lib/banking/funding.js';
import { type PeriodWindow } from '../lib/payrollSchedule.js';
import { isStateTaxSupported, primeStateAcknowledgments } from '../lib/payrollTax.js';
import {
  addDaysYmd,
  becauseLabel,
  dateOnly,
  desiredFor,
  loadAssignments,
  loadFacts,
  loadWorld,
  nextPaydayOn,
  onNoScheduleWhere,
  PAY_RUN_POPULATION_WHERE,
  patternOn,
  patternSentence,
  periodContaining,
  periodStartOnOrAfter,
  periodsFrom,
  planFor,
  recompute,
  todayYmd,
  ymd,
  type PersonFacts,
  type PlannedSegment,
  type RuleRow,
  type ScheduleWithVersions,
  type World,
} from '../lib/payScheduleMembership.js';
import type { ScheduleTrigger } from '../lib/payScheduleTriggers.js';
import { hireFacts, newHireForSchedule } from '../lib/hirePay.js';

/**
 * Pay schedules and who is on them — the contract in
 * packages/shared/src/paySchedules.ts.
 *
 * Membership is RULES (a client, a site, a department, a pay type, a
 * person, an exclusion) from a date; the engine (lib/payScheduleMembership)
 * turns them into effective-dated assignments. A change made here is a
 * change by hand: it starts on the date chosen (default: the schedule's
 * next period start) and sends no notice. Automatic moves (hire, transfer,
 * department, pay type, the sweep) start at the new schedule's next period
 * and notify payroll — those happen in the engine, not here.
 *
 * Every read is the caller's tenant and reach: schedules through
 * scopePayrollSchedules, people through scopeAssociates.
 */

type SessionUser = NonNullable<Request['user']>;
type ScheduleRow = Prisma.PayrollScheduleGetPayload<{ include: { versions: true } }>;

const PROCESS = requireCapability('process:payroll');
const UuidParam = z.string().uuid();
const DAY = 86_400_000;
const LIST_CAP = 200;

export const paySchedulesRouter = Router();
export const associatePayScheduleRouter = Router();

const fmtDay = (s: string) => dateOnly(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

async function scheduleInReach(user: SessionUser, id: string): Promise<ScheduleRow> {
  if (!UuidParam.safeParse(id).success) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found');
  const s = await prisma.payrollSchedule.findFirst({
    where: scopeWhere<Prisma.PayrollScheduleWhereInput>({ tenantId: tenantIdForWrite(), id, deletedAt: null }, scopePayrollSchedules(user)),
    include: { versions: true },
  });
  if (!s) throw new HttpError(404, 'schedule_not_found', 'Pay schedule not found');
  return s;
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: want } },
    select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } },
  });
  return new Map(users.map((u) => [u.id, u.associate ? nameOf(u.associate) : (u.displayName ?? u.email)]));
}

/* ---- Periods ------------------------------------------------------------- */

function versionStarts(s: ScheduleWithVersions): string[] {
  const vs = [...(s.versions ?? [])].map((v) => ymd(v.effectiveFrom)).sort();
  return vs.slice(1);
}

function periodDto(s: ScheduleWithVersions, p: PeriodWindow & { bridge?: boolean }, run: { id: string; status: string } | null): SchedulePeriod {
  const starts = versionStarts(s);
  return {
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    payDate: p.payDate,
    unadjustedPayDate: p.nominalPayDate && p.nominalPayDate !== p.payDate ? p.nominalPayDate : null,
    adjustedFor: p.nominalPayDate && p.nominalPayDate !== p.payDate ? (p.payDateShiftReason ?? null) : null,
    run,
    versionChange: starts.some((v) => v >= p.periodStart && v <= p.periodEnd),
    ...(p.bridge ? { bridge: true } : {}),
  };
}

/** The runs for a schedule's periods: its own, else a run from before schedules for its client. */
async function runsByPeriod(schedules: Array<{ id: string; clientId: string | null }>, periodStarts: string[]): Promise<(scheduleId: string, clientId: string | null, periodStart: string) => { id: string; status: string } | null> {
  if (schedules.length === 0 || periodStarts.length === 0) return () => null;
  const runs = await prisma.payrollRun.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      periodStart: { in: [...new Set(periodStarts)].map(dateOnly) },
      status: { not: 'CANCELLED' },
      OR: [{ payrollScheduleId: { in: schedules.map((s) => s.id) } }, { payrollScheduleId: null }],
    },
    select: { id: true, status: true, clientId: true, periodStart: true, payrollScheduleId: true, kind: true },
  });
  return (scheduleId, clientId, periodStart) => {
    const at = runs.filter((r) => ymd(r.periodStart) === periodStart && r.kind === 'REGULAR');
    const own = at.find((r) => r.payrollScheduleId === scheduleId) ?? at.find((r) => r.payrollScheduleId === null && r.clientId === clientId);
    return own ? { id: own.id, status: own.status } : null;
  };
}

/** The period paid next on a schedule (pay lands after the period ends). */
function nextPaidPeriod(s: ScheduleWithVersions, now: Date = new Date()): PeriodWindow {
  return nextPaydayOn(s, todayYmd(now));
}

/* ---- Readiness ----------------------------------------------------------- */

interface Readiness {
  level: ReadinessLevel;
  issues: ReadinessIssue[];
}

const worst = (issues: ReadinessIssue[]): ReadinessLevel =>
  issues.some((i) => i.level === 'BLOCKED') ? 'BLOCKED' : issues.some((i) => i.level === 'ATTENTION') ? 'ATTENTION' : 'READY';

/**
 * Whether each person will be paid correctly on the next payday, with the
 * one place to fix each problem. Batched: one query for everyone.
 */
async function readinessFor(ids: string[], pendingMoves: Map<string, { toName: string | null; effectiveFrom: string }>): Promise<Map<string, Readiness>> {
  const out = new Map<string, Readiness>();
  if (ids.length === 0) return out;
  const today = todayYmd();
  await primeStateAcknowledgments(prisma);
  const people = await prisma.associate.findMany({
    where: { id: { in: ids }, tenantId: tenantIdForWrite() },
    select: {
      id: true,
      employmentType: true,
      ssnLast4: true,
      state: true,
      addressLine1: true,
      separatedAt: true,
      tinEncrypted: true,
      w4Submission: { select: { id: true } },
      payoutMethods: { where: { retiredAt: null }, select: { type: true, branchCardId: true, accountNumberEnc: true, verifiedAt: true, prenoteStatus: true, isPrimary: true } },
      compRecords: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { effectiveFrom: true } },
      timeOffRequests: { where: { status: 'APPROVED', startDate: { lte: dateOnly(today) }, endDate: { gte: dateOnly(today) } }, take: 1, select: { endDate: true } },
      _count: { select: { payrollItems: true } },
    },
  });
  for (const a of people) {
    const pay = `/people/${a.id}?tab=pay`;
    const profile = `/people/${a.id}?tab=profile`;
    const issues: ReadinessIssue[] = [];
    const w2 = a.employmentType === 'W2_EMPLOYEE';
    if (w2 ? !a.w4Submission : !a.tinEncrypted)
      issues.push({ code: 'NO_W4', level: 'ATTENTION', label: w2 ? 'No W-4 — withheld as single with no adjustments' : 'No W-9 — backup withholding applies', fixPath: pay, fixLabel: w2 ? 'Ask for a W-4' : 'Ask for a W-9' });
    const rails = a.payoutMethods.filter((m) => m.branchCardId || m.accountNumberEnc);
    if (rails.length === 0) issues.push({ code: 'NO_PAYOUT', level: 'BLOCKED', label: 'No bank account or pay card — nothing to pay into', fixPath: pay, fixLabel: 'Add a payout method' });
    else if (rails.some((m) => m.accountNumberEnc && (m.prenoteStatus === 'PENDING' || (!m.verifiedAt && m.isPrimary))))
      issues.push({ code: 'PAYOUT_UNVERIFIED', level: 'ATTENTION', label: 'Bank account not verified yet', fixPath: pay, fixLabel: 'Verify the account' });
    if (a.compRecords.length === 0) issues.push({ code: 'NO_RATE', level: 'ATTENTION', label: 'No pay rate on file — the run would use the default rate', fixPath: pay, fixLabel: 'Set a pay rate' });
    else if (dateOnly(today).getTime() - a.compRecords[0]!.effectiveFrom.getTime() < 14 * DAY)
      issues.push({ code: 'RATE_CHANGED', level: 'ATTENTION', label: `Pay rate changed ${fmtDay(ymd(a.compRecords[0]!.effectiveFrom))}`, fixPath: pay, fixLabel: 'Check the rate' });
    if (!a.state) issues.push({ code: 'NO_ADDRESS', level: 'BLOCKED', label: 'No home state — state tax can’t be worked out', fixPath: profile, fixLabel: 'Add their address' });
    else if (!isStateTaxSupported(a.state)) issues.push({ code: 'STATE_UNSUPPORTED', level: 'BLOCKED', label: `${a.state.toUpperCase()} withholding isn’t set up yet`, fixPath: '/payroll/tax-tables?tab=state', fixLabel: 'Set up the state' });
    else if (!a.addressLine1) issues.push({ code: 'NO_ADDRESS', level: 'ATTENTION', label: 'No street address for their W-2', fixPath: profile, fixLabel: 'Add their address' });
    if (w2 && !a.ssnLast4) issues.push({ code: 'NO_SSN', level: 'ATTENTION', label: 'No Social Security number on file', fixPath: profile, fixLabel: 'Add their SSN' });
    if (a._count.payrollItems === 0) issues.push({ code: 'FIRST_CHECK', level: 'ATTENTION', label: 'First paycheck — check their setup once', fixPath: pay, fixLabel: 'Review' });
    if (a.timeOffRequests[0]) issues.push({ code: 'ON_LEAVE', level: 'ATTENTION', label: `On leave through ${fmtDay(ymd(a.timeOffRequests[0].endDate))}`, fixPath: `/people/${a.id}?tab=timeoff`, fixLabel: 'See their leave' });
    if (a.separatedAt) issues.push({ code: 'SEPARATING', level: 'ATTENTION', label: `${a.separatedAt.getTime() > Date.now() ? 'Leaving' : 'Left'} ${fmtDay(ymd(a.separatedAt))} — final pay rules apply`, fixPath: `/people/${a.id}?tab=employment`, fixLabel: 'See final pay' });
    const move = pendingMoves.get(a.id);
    if (move) issues.push({ code: 'MOVING_SCHEDULE', level: 'ATTENTION', label: move.toName ? `Moves to ${move.toName} from ${fmtDay(move.effectiveFrom)}` : `Leaves this schedule ${fmtDay(move.effectiveFrom)}`, fixPath: '/payroll/schedules', fixLabel: 'See the move' });
    out.set(a.id, { level: worst(issues), issues });
  }
  return out;
}

/* ---- Who's on what -------------------------------------------------------- */

interface Membership {
  /** associateId → the assignment in force today (or the legacy mirror). */
  today: Map<string, { scheduleId: string; since: string; because: string }>;
  /** associateId → the next change after today. */
  next: Map<string, { scheduleId: string | null; effectiveFrom: string; because: string }>;
}

async function membershipOf(ids: string[] | null, scheduleIds: string[] | null): Promise<Membership> {
  const today = todayYmd();
  const tenantId = tenantIdForWrite();
  const rows = await prisma.payrollScheduleAssignment.findMany({
    where: {
      tenantId,
      ...(ids ? { associateId: { in: ids } } : {}),
      // Everyone touching these schedules — and the rest of their timeline, so a move off shows.
      ...(scheduleIds && !ids ? { associate: { payScheduleAssignments: { some: { scheduleId: { in: scheduleIds } } } } } : {}),
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(today) } }],
    },
    orderBy: { effectiveFrom: 'asc' },
    select: { associateId: true, scheduleId: true, effectiveFrom: true, effectiveTo: true, reason: true },
  });
  const out: Membership = { today: new Map(), next: new Map() };
  const byPerson = new Map<string, typeof rows>();
  for (const r of rows) byPerson.set(r.associateId, [...(byPerson.get(r.associateId) ?? []), r]);
  for (const [id, list] of byPerson) {
    const cur = list.find((r) => ymd(r.effectiveFrom) <= today);
    if (cur) out.today.set(id, { scheduleId: cur.scheduleId, since: ymd(cur.effectiveFrom), because: cur.reason ?? 'Rule' });
    const fut = list.find((r) => ymd(r.effectiveFrom) > today);
    if (fut) out.next.set(id, { scheduleId: fut.scheduleId, effectiveFrom: ymd(fut.effectiveFrom), because: fut.reason ?? 'Rule' });
    else if (cur?.effectiveTo) out.next.set(id, { scheduleId: null, effectiveFrom: addDaysYmd(ymd(cur.effectiveTo), 1), because: 'Rule ended' });
  }
  // Legacy: on a schedule by the mirror, with no assignment history at all.
  const legacy = await prisma.associate.findMany({
    where: {
      tenantId,
      deletedAt: null,
      payScheduleAssignments: { none: {} },
      ...(ids ? { id: { in: ids } } : {}),
      payrollScheduleId: scheduleIds ? { in: scheduleIds } : { not: null },
    },
    select: { id: true, payrollScheduleId: true, payrollSchedule: { select: { createdAt: true } } },
  });
  for (const l of legacy) {
    if (!out.today.has(l.id) && l.payrollScheduleId) out.today.set(l.id, { scheduleId: l.payrollScheduleId, since: ymd(l.payrollSchedule?.createdAt ?? new Date()), because: 'Assigned earlier' });
  }
  return out;
}

/* ---- Summaries ------------------------------------------------------------ */

async function summarize(user: SessionUser, schedules: ScheduleRow[]): Promise<PayScheduleSummary[]> {
  if (schedules.length === 0) return [];
  await loadTenantHolidays(prisma);
  const today = todayYmd();
  const ids = schedules.map((s) => s.id);
  const reach = await prisma.associate.findMany({
    where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId: tenantIdForWrite(), deletedAt: null }, scopeAssociates(user), {
      OR: [{ payrollScheduleId: { in: ids } }, { payScheduleAssignments: { some: { scheduleId: { in: ids }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(today) } }] } } }],
    }),
    select: { id: true },
  });
  const m = await membershipOf(
    reach.map((r) => r.id),
    ids,
  );
  const names = new Map(schedules.map((s) => [s.id, s.name]));
  const pending = new Map<string, { toName: string | null; effectiveFrom: string }>();
  for (const [id, n] of m.next) pending.set(id, { toName: n.scheduleId ? (names.get(n.scheduleId) ?? 'another schedule') : null, effectiveFrom: n.effectiveFrom });
  const members = [...m.today.entries()].filter(([, t]) => ids.includes(t.scheduleId));
  const readiness = await readinessFor(
    members.map(([id]) => id),
    pending,
  );

  const rules = await prisma.payrollScheduleRule.findMany({
    where: { tenantId: tenantIdForWrite(), scheduleId: { in: ids }, kind: 'CLIENT', OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(today) } }] },
    select: { scheduleId: true, clientId: true },
  });
  const clientIds = [...new Set([...rules.map((r) => r.clientId), ...schedules.map((s) => s.clientId)].filter((x): x is string => !!x))];
  const clients = clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const next = new Map(schedules.map((s) => [s.id, nextPaidPeriod(s)]));
  const runOf = await runsByPeriod(
    schedules,
    [...next.values()].map((p) => p.periodStart),
  );

  return schedules.map((s) => {
    const p = patternOn(s, today);
    const mine = members.filter(([, t]) => t.scheduleId === s.id).map(([id]) => id);
    const pendingVersion = [...s.versions].filter((v) => ymd(v.effectiveFrom) > today).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())[0];
    const cs = [...new Set([...rules.filter((r) => r.scheduleId === s.id).map((r) => r.clientId), s.clientId].filter((x): x is string => !!x))];
    const np = next.get(s.id)!;
    return {
      id: s.id,
      name: s.name,
      pattern: patternSentence(p),
      frequency: p.frequency,
      anchorDate: ymd(typeof p.anchorDate === 'string' ? dateOnly(p.anchorDate) : p.anchorDate),
      payDateOffsetDays: p.payDateOffsetDays,
      isActive: s.isActive,
      isDefault: s.isDefault,
      clients: cs.filter((c) => clientName.has(c)).map((c) => ({ id: c, name: clientName.get(c)! })),
      people: mine.length,
      blocked: mine.filter((id) => readiness.get(id)?.level === 'BLOCKED').length,
      attention: mine.filter((id) => readiness.get(id)?.level === 'ATTENTION').length,
      nextPeriod: periodDto(s, np, runOf(s.id, s.clientId, np.periodStart)),
      pendingVersion: pendingVersion ? { effectiveFrom: ymd(pendingVersion.effectiveFrom), pattern: patternSentence(pendingVersion) } : null,
      pendingJoins: [...m.next.entries()].filter(([, n]) => n.scheduleId === s.id).length,
      pendingLeaves: [...m.next.entries()].filter(([id, n]) => n.scheduleId !== s.id && m.today.get(id)?.scheduleId === s.id).length,
      notes: s.notes,
    };
  });
}

async function ruleDtos(rules: RuleRow[], extra: Map<string, { createdAt: Date; createdById: string | null }>): Promise<ScheduleRule[]> {
  const ids = (k: 'clientId' | 'siteId' | 'departmentId' | 'associateId') => [...new Set(rules.map((r) => r[k]).filter((x): x is string => !!x))];
  const [clients, sites, deps, people, facts, users] = await Promise.all([
    ids('clientId').length ? prisma.client.findMany({ where: { id: { in: ids('clientId') } }, select: { id: true, name: true } }) : [],
    ids('siteId').length ? prisma.site.findMany({ where: { id: { in: ids('siteId') } }, select: { id: true, name: true, clientId: true } }) : [],
    ids('departmentId').length ? prisma.department.findMany({ where: { id: { in: ids('departmentId') } }, select: { id: true, name: true, clientId: true } }) : [],
    ids('associateId').length ? prisma.associate.findMany({ where: { id: { in: ids('associateId') } }, select: { id: true, firstName: true, lastName: true } }) : [],
    loadFacts(prisma, 'all'),
    userNames([...extra.values()].map((e) => e.createdById)),
  ]);
  const cn = new Map(clients.map((c) => [c.id, c.name]));
  const sn = new Map(sites.map((c) => [c.id, c]));
  const dn = new Map(deps.map((c) => [c.id, c]));
  const pn = new Map(people.map((c) => [c.id, nameOf(c)]));
  const extraClientIds = [...sites.map((x) => x.clientId), ...deps.map((x) => x.clientId)].filter((x): x is string => !!x && !cn.has(x));
  if (extraClientIds.length) for (const c of await prisma.client.findMany({ where: { id: { in: extraClientIds } }, select: { id: true, name: true } })) cn.set(c.id, c.name);
  const today = todayYmd();
  const factList = [...facts.values()];
  return rules.map((r) => {
    const clientId = r.clientId ?? sn.get(r.siteId ?? '')?.clientId ?? dn.get(r.departmentId ?? '')?.clientId ?? null;
    const e = extra.get(r.id);
    const inForce = ymd(r.effectiveFrom) <= today && (!r.effectiveTo || ymd(r.effectiveTo) >= today);
    return {
      id: r.id,
      kind: r.kind as ScheduleRule['kind'],
      clientId,
      clientName: clientId ? (cn.get(clientId) ?? null) : null,
      siteId: r.siteId,
      siteName: r.siteId ? (sn.get(r.siteId)?.name ?? null) : null,
      departmentId: r.departmentId,
      departmentName: r.departmentId ? (dn.get(r.departmentId)?.name ?? null) : null,
      payType: (r.payType as 'HOURLY' | 'SALARY' | null) ?? null,
      associateId: r.associateId,
      associateName: r.associateId ? (pn.get(r.associateId) ?? null) : null,
      effectiveFrom: ymd(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? ymd(r.effectiveTo) : null,
      matches: inForce ? factList.filter((f) => ruleMatchesFacts(r, f)).length : 0,
      createdAt: (e?.createdAt ?? new Date()).toISOString(),
      createdByName: e?.createdById ? (users.get(e.createdById) ?? null) : null,
    };
  });
}

function ruleMatchesFacts(r: RuleRow, f: PersonFacts): boolean {
  switch (r.kind) {
    case 'INDIVIDUAL':
    case 'EXCLUDE':
      return r.associateId === f.associateId;
    case 'SITE':
      return !!r.siteId && r.siteId === f.siteId;
    case 'DEPARTMENT':
      return !!r.departmentId && r.departmentId === f.departmentId;
    case 'CLIENT':
      return !!r.clientId && r.clientId === f.clientId;
    case 'PAY_TYPE':
      return !!r.payType && r.payType === f.payType;
    default:
      return false;
  }
}

async function detail(user: SessionUser, s: ScheduleRow): Promise<PayScheduleDetail> {
  const [summary] = await summarize(user, [s]);
  const rules = await prisma.payrollScheduleRule.findMany({ where: { tenantId: tenantIdForWrite(), scheduleId: s.id }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
  const extra = new Map(rules.map((r) => [r.id, { createdAt: r.createdAt, createdById: r.createdById }]));
  const vNames = await userNames(s.versions.map((v) => v.createdById));
  return PayScheduleDetailSchema.parse({
    ...summary!,
    rules: await ruleDtos(rules, extra),
    versions: [...s.versions]
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime())
      .map((v) => ({
        effectiveFrom: ymd(v.effectiveFrom),
        pattern: patternSentence(v),
        frequency: v.frequency,
        anchorDate: ymd(v.anchorDate),
        payDateOffsetDays: v.payDateOffsetDays,
        createdByName: v.createdById ? (vNames.get(v.createdById) ?? null) : null,
      })),
  });
}

/* ---- Changing membership: preview and apply -------------------------------- */

interface Change {
  /** Whose view the impact is told from. */
  scheduleId: string;
  effectiveFrom: string;
  add: Array<Omit<RuleRow, 'effectiveFrom' | 'effectiveTo'>>;
  /** Rules to end on effectiveFrom − 1 (deleted when they haven't started by then). */
  endRuleIds: string[];
  note?: string;
}

/** Validate and resolve a MembershipChangeInput against the caller's reach. */
async function changeFromInput(user: SessionUser, s: ScheduleRow, input: MembershipChangeInput): Promise<Change> {
  const today = todayYmd();
  const effectiveFrom = input.effectiveFrom ?? periodStartOnOrAfter(s, today);
  if (effectiveFrom < today) throw new HttpError(400, 'effective_in_past', 'A membership change starts today or later; past pay periods are already decided.');
  const tenantId = tenantIdForWrite();
  const sites = internalSites(user);
  const add: Change['add'] = [];
  for (const a of input.add) {
    const base = { id: randomUUID(), scheduleId: s.id, kind: a.kind, clientId: null as string | null, siteId: null as string | null, departmentId: null as string | null, payType: null as string | null, associateId: null as string | null };
    switch (a.kind) {
      case 'CLIENT': {
        if (!a.clientId) throw new HttpError(400, 'invalid_rule', 'A client rule names a client.');
        const c = await prisma.client.findFirst({ where: { id: a.clientId, tenantId, deletedAt: null, ...(sites ? { locations: { some: sites } } : {}) }, select: { id: true } });
        if (!c) throw new HttpError(404, 'client_not_found', 'Client not found');
        add.push({ ...base, clientId: c.id });
        break;
      }
      case 'SITE': {
        if (!a.siteId) throw new HttpError(400, 'invalid_rule', 'A site rule names a site.');
        const site = await prisma.site.findFirst({ where: scopeWhere<Prisma.SiteWhereInput>({ id: a.siteId, tenantId, deletedAt: null }, sites), select: { id: true } });
        if (!site) throw new HttpError(404, 'site_not_found', 'Site not found');
        add.push({ ...base, siteId: site.id });
        break;
      }
      case 'DEPARTMENT': {
        if (!a.departmentId) throw new HttpError(400, 'invalid_rule', 'A department rule names a department.');
        const d = await prisma.department.findFirst({ where: { id: a.departmentId, tenantId }, select: { id: true } });
        if (!d) throw new HttpError(404, 'department_not_found', 'Department not found');
        add.push({ ...base, departmentId: d.id });
        break;
      }
      case 'PAY_TYPE':
        if (!a.payType) throw new HttpError(400, 'invalid_rule', 'A pay-type rule names hourly or salaried.');
        add.push({ ...base, payType: a.payType });
        break;
      case 'INDIVIDUAL':
      case 'EXCLUDE': {
        if (!a.associateId) throw new HttpError(400, 'invalid_rule', 'This rule names a person.');
        const p = await prisma.associate.findFirst({ where: scopeWhere<Prisma.AssociateWhereInput>({ id: a.associateId, tenantId, deletedAt: null }, scopeAssociates(user)), select: { id: true } });
        if (!p) throw new HttpError(404, 'associate_not_found', 'Person not found');
        add.push({ ...base, associateId: p.id });
        break;
      }
    }
  }
  if (input.endRuleIds.length) {
    const found = await prisma.payrollScheduleRule.findMany({ where: { id: { in: input.endRuleIds }, tenantId, schedule: scopePayrollSchedules(user) }, select: { id: true } });
    if (found.length !== new Set(input.endRuleIds).size) throw new HttpError(404, 'rule_not_found', 'Rule not found');
  }
  return { scheduleId: s.id, effectiveFrom, add, endRuleIds: [...new Set(input.endRuleIds)], note: input.note };
}

/** The same rule already open on that date: adding it again changes nothing. */
function dedupe(change: Change, rules: RuleRow[]): Change {
  const open = (r: RuleRow) => ymd(r.effectiveFrom) <= change.effectiveFrom && (!r.effectiveTo || ymd(r.effectiveTo) >= change.effectiveFrom) && !change.endRuleIds.includes(r.id);
  const same = (a: Change['add'][number], r: RuleRow) =>
    a.scheduleId === r.scheduleId && a.kind === r.kind && a.clientId === r.clientId && a.siteId === r.siteId && a.departmentId === r.departmentId && a.payType === r.payType && a.associateId === r.associateId;
  return { ...change, add: change.add.filter((a) => !rules.some((r) => open(r) && same(a, r))) };
}

/** The rules as they'd be after the change. */
function proposedRules(rules: RuleRow[], change: Change): RuleRow[] {
  const endDay = addDaysYmd(change.effectiveFrom, -1);
  const out: RuleRow[] = [];
  for (const r of rules) {
    if (!change.endRuleIds.includes(r.id)) {
      out.push(r);
      continue;
    }
    if (ymd(r.effectiveFrom) >= change.effectiveFrom) continue; // never started: gone
    if (r.effectiveTo && ymd(r.effectiveTo) <= endDay) out.push(r);
    else out.push({ ...r, effectiveTo: dateOnly(endDay) });
  }
  for (const a of change.add) out.push({ ...a, effectiveFrom: dateOnly(change.effectiveFrom), effectiveTo: null });
  return out;
}

/** Everyone the change could touch: the people its rules cover (before or after). */
function touchesEveryone(change: Change, rules: RuleRow[]): string[] | 'all' {
  const ended = rules.filter((r) => change.endRuleIds.includes(r.id));
  const all = [...change.add, ...ended];
  if (all.some((r) => r.kind !== 'INDIVIDUAL' && r.kind !== 'EXCLUDE')) return 'all';
  return [...new Set(all.map((r) => r.associateId).filter((x): x is string => !!x))];
}

function transitionFor(w: World, fromId: string | null, toId: string | null, effectiveFrom: string): MovePerson['transition'] {
  const from = fromId ? w.schedules.get(fromId) : undefined;
  const to = toId ? w.schedules.get(toId) : undefined;
  const lastDay = addDaysYmd(effectiveFrom, -1);
  const oldP = from ? periodContaining(from, lastDay) : null;
  const newP = to ? periodContaining(to, effectiveFrom) : null;
  const parts: string[] = [];
  if (oldP && from) {
    parts.push(
      oldP.periodEnd === lastDay
        ? `Last ${from.name} check ${fmtDay(oldP.payDate)} covers through ${fmtDay(lastDay)}`
        : `${from.name} pays ${fmtDay(oldP.periodStart)}–${fmtDay(lastDay)} on ${fmtDay(oldP.payDate)} (a short last period)`,
    );
  }
  if (newP && to) {
    parts.push(
      newP.periodStart === effectiveFrom
        ? `first ${to.name} check ${fmtDay(newP.payDate)}`
        : `first ${to.name} check ${fmtDay(newP.payDate)} covers ${fmtDay(effectiveFrom)}–${fmtDay(newP.periodEnd)}`,
    );
  }
  if (!to && from) parts.push('then on no schedule — no run will pay them');
  return {
    lastOldPayDate: oldP?.payDate ?? null,
    firstNewPayDate: newP?.payDate ?? null,
    note: parts.length ? `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : null,
  };
}

/**
 * What a change does, person by person, without writing anything: the
 * plan under today's rules against the plan under the proposed ones.
 */
async function impactOf(user: SessionUser, change: Change, trigger: ScheduleTrigger): Promise<{ impact: MembershipImpact; affected: string[] }> {
  const today = todayYmd();
  await loadTenantHolidays(prisma);
  const world = await loadWorld(prisma);
  const proposed: World = { ...world, rules: proposedRules(world.rules, change) };
  // Names for what the new rules point at (the world only knows the old rules').
  const [nc, ns, nd] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: change.add.map((a) => a.clientId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.site.findMany({ where: { id: { in: change.add.map((a) => a.siteId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { id: { in: change.add.map((a) => a.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  proposed.names = {
    ...world.names,
    clients: new Map([...world.names.clients, ...nc.map((c) => [c.id, c.name] as const)]),
    sites: new Map([...world.names.sites, ...ns.map((c) => [c.id, c.name] as const)]),
    departments: new Map([...world.names.departments, ...nd.map((c) => [c.id, c.name] as const)]),
  };
  const scope = touchesEveryone(change, world.rules);
  const facts = await loadFacts(prisma, scope, today);
  const ids = [...facts.keys()];
  const rows = await loadAssignments(prisma, ids);
  const key = (plan: PlannedSegment[]) => plan.map((p) => `${p.from}|${p.scheduleId}`).join(',');

  const moved: Array<{ f: PersonFacts; holding: string | null; seg: PlannedSegment }> = [];
  const conflicted: Array<{ f: PersonFacts; holding: string | null; conflict: string }> = [];
  let unchanged = 0;
  for (const f of facts.values()) {
    const r = rows.get(f.associateId) ?? [];
    const before = planFor(f, r, world, today, trigger);
    const after = planFor(f, r, proposed, today, trigger);
    const holding = after.current?.scheduleId ?? f.legacyScheduleId;
    const newConflict = after.conflicts.find((c) => !before.conflicts.includes(c));
    if (newConflict) conflicted.push({ f, holding, conflict: newConflict });
    if (key(before.plan) === key(after.plan)) {
      const touched = change.add.some((a) => ruleMatchesFacts({ ...a, effectiveFrom: new Date(), effectiveTo: null }, f));
      if (touched && holding === change.scheduleId) unchanged += 1;
      continue;
    }
    const seg = after.plan.find((p) => p.scheduleId === change.scheduleId) ?? after.plan[0];
    if (seg) moved.push({ f, holding: seg === after.plan[0] ? holding : (after.plan[after.plan.indexOf(seg) - 1]?.scheduleId ?? holding), seg });
    else if (after.plan.length === 0 && before.plan.length > 0) {
      // The change cancels a move that was planned: they stay where they are.
      unchanged += 1;
    }
  }

  const joiners = moved.filter((m) => m.seg.scheduleId === change.scheduleId);
  const leavers = moved.filter((m) => m.holding === change.scheduleId && m.seg.scheduleId !== change.scheduleId);
  const relevant = [...joiners, ...leavers];
  const personIds = [...new Set([...relevant.map((m) => m.f.associateId), ...conflicted.map((c) => c.f.associateId)])];
  const people = personIds.length
    ? await prisma.associate.findMany({
        where: scopeWhere<Prisma.AssociateWhereInput>({ id: { in: personIds }, tenantId: tenantIdForWrite() }, scopeAssociates(user)),
        select: { id: true, photoS3Key: true, photoUpdatedAt: true, _count: { select: { payrollItems: true } } },
      })
    : [];
  const pmap = new Map(people.map((p) => [p.id, p]));
  const sName = (id: string | null) => (id ? (proposed.names.schedules.get(id) ?? null) : null);

  const list: MovePerson[] = [];
  for (const m of relevant) {
    const p = pmap.get(m.f.associateId);
    if (!p) continue; // outside the caller's reach: counted, not named
    list.push({
      associateId: m.f.associateId,
      name: m.f.name,
      photoUrl: profilePhotoUrlFor(p),
      fromScheduleId: m.holding,
      fromScheduleName: sName(m.holding),
      toScheduleId: m.seg.scheduleId,
      toScheduleName: sName(m.seg.scheduleId),
      effectiveFrom: m.seg.from,
      because: becauseLabel(m.seg.d, proposed.rules, proposed.names),
      transition: transitionFor(proposed, m.holding, m.seg.scheduleId, m.seg.from),
      conflict: null,
    });
  }
  for (const c of conflicted) {
    const p = pmap.get(c.f.associateId);
    if (!p || list.some((x) => x.associateId === c.f.associateId)) continue;
    list.push({
      associateId: c.f.associateId,
      name: c.f.name,
      photoUrl: profilePhotoUrlFor(p),
      fromScheduleId: c.holding,
      fromScheduleName: sName(c.holding),
      toScheduleId: null,
      toScheduleName: null,
      effectiveFrom: change.effectiveFrom,
      because: 'Two schedules claim them',
      transition: { lastOldPayDate: null, firstNewPayDate: null, note: 'They stay where they are until someone decides.' },
      conflict: c.conflict,
    });
  }
  list.sort((a, b) => (a.conflict ? 0 : 1) - (b.conflict ? 0 : 1) || a.name.localeCompare(b.name));

  const groups = new Map<string, { scheduleId: string | null; name: string; count: number }>();
  for (const j of joiners) {
    const k = j.holding ?? 'none';
    const g = groups.get(k) ?? { scheduleId: j.holding, name: sName(j.holding) ?? 'No schedule', count: 0 };
    g.count += 1;
    groups.set(k, g);
  }
  const hires = joiners.filter((j) => !j.holding && (pmap.get(j.f.associateId)?._count.payrollItems ?? 1) === 0).length;

  const impact = MembershipImpactSchema.parse({
    effectiveFrom: change.effectiveFrom,
    joins: joiners.length,
    leaves: leavers.length,
    unchanged,
    newHires: hires,
    movingFrom: [...groups.values()].sort((a, b) => b.count - a.count),
    conflicts: conflicted.length,
    people: list.slice(0, LIST_CAP),
    truncated: list.length > LIST_CAP,
  });
  return { impact, affected: moved.map((m) => m.f.associateId).concat(conflicted.map((c) => c.f.associateId)) };
}

function ruleWords(r: { kind: string; payType?: string | null }, names: { client?: string; site?: string; department?: string; person?: string }): string {
  switch (r.kind) {
    case 'CLIENT':
      return `Client ${names.client ?? ''}`.trim();
    case 'SITE':
      return `Site ${names.site ?? ''}`.trim();
    case 'DEPARTMENT':
      return `Department ${names.department ?? ''}`.trim();
    case 'PAY_TYPE':
      return r.payType === 'SALARY' ? 'Salaried staff' : 'Hourly staff';
    case 'INDIVIDUAL':
      return names.person ?? 'A person';
    case 'EXCLUDE':
      return `Excluding ${names.person ?? 'a person'}`;
    default:
      return 'A rule';
  }
}

async function namesForRules(rules: Array<{ clientId: string | null; siteId: string | null; departmentId: string | null; associateId: string | null }>) {
  const pick = (k: 'clientId' | 'siteId' | 'departmentId' | 'associateId') => [...new Set(rules.map((r) => r[k]).filter((x): x is string => !!x))];
  const [c, s, d, p] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: pick('clientId') } }, select: { id: true, name: true } }),
    prisma.site.findMany({ where: { id: { in: pick('siteId') } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { id: { in: pick('departmentId') } }, select: { id: true, name: true } }),
    prisma.associate.findMany({ where: { id: { in: pick('associateId') } }, select: { id: true, firstName: true, lastName: true } }),
  ]);
  const cn = new Map(c.map((x) => [x.id, x.name]));
  const sn = new Map(s.map((x) => [x.id, x.name]));
  const dn = new Map(d.map((x) => [x.id, x.name]));
  const pn = new Map(p.map((x) => [x.id, nameOf(x)]));
  return (r: { kind: string; payType?: string | null; clientId: string | null; siteId: string | null; departmentId: string | null; associateId: string | null }) =>
    ruleWords(r, { client: cn.get(r.clientId ?? ''), site: sn.get(r.siteId ?? ''), department: dn.get(r.departmentId ?? ''), person: pn.get(r.associateId ?? '') });
}

/** Write the change, then bring everyone it touches in line. Returns the impact as previewed. */
async function applyChange(user: SessionUser, change: Change, trigger: ScheduleTrigger): Promise<MembershipImpact> {
  const { impact, affected } = await impactOf(user, change, trigger);
  const tenantId = tenantIdForWrite();
  const endDay = addDaysYmd(change.effectiveFrom, -1);
  const ended = await prisma.payrollScheduleRule.findMany({ where: { id: { in: change.endRuleIds }, tenantId } });
  await prisma.$transaction(async (tx) => {
    for (const r of ended) {
      if (ymd(r.effectiveFrom) >= change.effectiveFrom) await tx.payrollScheduleRule.delete({ where: { id: r.id } });
      else if (!r.effectiveTo || ymd(r.effectiveTo) > endDay) await tx.payrollScheduleRule.update({ where: { id: r.id }, data: { effectiveTo: dateOnly(endDay) } });
    }
    for (const a of change.add) {
      await tx.payrollScheduleRule.create({
        data: {
          id: a.id,
          tenantId,
          scheduleId: a.scheduleId,
          kind: a.kind,
          clientId: a.clientId,
          siteId: a.siteId,
          departmentId: a.departmentId,
          payType: a.payType,
          associateId: a.associateId,
          effectiveFrom: dateOnly(change.effectiveFrom),
          note: change.note ?? null,
          createdById: user.id,
        },
      });
    }
  });
  const words = await namesForRules([...change.add, ...ended]);
  for (const a of change.add) {
    enqueueAudit(
      { actorUserId: user.id, clientId: null, action: 'payroll.schedule.rule_add', entityType: 'PayrollSchedule', entityId: a.scheduleId, metadata: { ruleId: a.id, kind: a.kind, effectiveFrom: change.effectiveFrom, summary: `Added rule: ${words(a)} from ${fmtDay(change.effectiveFrom)}` } },
      'paySchedules.rule_add',
    );
  }
  for (const r of ended) {
    enqueueAudit(
      { actorUserId: user.id, clientId: null, action: 'payroll.schedule.rule_end', entityType: 'PayrollSchedule', entityId: r.scheduleId, metadata: { ruleId: r.id, kind: r.kind, lastDay: endDay, summary: `Ended rule: ${words(r)} after ${fmtDay(endDay)}` } },
      'paySchedules.rule_end',
    );
  }
  const scope = touchesEveryone(change, [...ended]);
  await recompute(prisma, scope === 'all' ? 'all' : [...new Set([...scope, ...affected])], trigger, { actorUserId: user.id });
  return impact;
}

/** A drag between schedules: individuals and whole clients onto `to`, their old claims ended. */
async function changeFromMove(user: SessionUser, body: unknown): Promise<Change> {
  const input = MoveInputSchema.parse(body);
  const to = await scheduleInReach(user, input.toScheduleId);
  if (!to.isActive) throw new HttpError(409, 'schedule_inactive', 'That schedule is turned off.');
  if (input.associateIds.length === 0 && input.clientIds.length === 0) throw new HttpError(400, 'nothing_to_move', 'Choose people or clients to move.');
  const effectiveFrom = input.effectiveFrom ?? periodStartOnOrAfter(to, todayYmd());
  const change = await changeFromInput(user, to, {
    add: [...input.associateIds.map((associateId) => ({ kind: 'INDIVIDUAL' as const, associateId })), ...input.clientIds.map((clientId) => ({ kind: 'CLIENT' as const, clientId }))],
    endRuleIds: [],
    effectiveFrom,
  });
  // Their claims elsewhere end the day before, so two schedules don't claim them.
  const stale = await prisma.payrollScheduleRule.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      OR: [
        ...(input.associateIds.length ? [{ kind: 'INDIVIDUAL', associateId: { in: input.associateIds }, scheduleId: { not: to.id } }, { kind: 'EXCLUDE', associateId: { in: input.associateIds }, scheduleId: to.id }] : []),
        ...(input.clientIds.length ? [{ kind: 'CLIENT', clientId: { in: input.clientIds }, scheduleId: input.fromScheduleId ? input.fromScheduleId : { not: to.id } }] : []),
      ],
    },
    select: { id: true, effectiveTo: true },
  });
  // Still open on the day the move starts.
  change.endRuleIds = stale.filter((r) => !r.effectiveTo || ymd(r.effectiveTo) >= effectiveFrom).map((r) => r.id);
  return change;
}

/* ---- Candidates: everyone, new hires included ------------------------------ */

interface PersonRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  photoUrl: string | null;
  clientId: string | null;
  clientName: string | null;
  siteId: string | null;
  siteName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  payType: 'HOURLY' | 'SALARY' | null;
  status: ScheduleCandidate['status'];
  currentScheduleId: string | null;
}

async function peopleInReach(user: SessionUser, where: Prisma.AssociateWhereInput = {}): Promise<PersonRow[]> {
  const today = dateOnly(todayYmd());
  const rows = await prisma.associate.findMany({
    where: scopeWhere<Prisma.AssociateWhereInput>({ tenantId: tenantIdForWrite(), deletedAt: null }, scopeAssociates(user), where),
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 20_000,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      photoS3Key: true,
      photoUpdatedAt: true,
      departmentId: true,
      department: { select: { name: true } },
      separatedAt: true,
      deactivatedAt: true,
      payrollScheduleId: true,
      assignments: {
        where: { startedAt: { lte: today }, OR: [{ endedAt: null }, { endedAt: { gte: today } }] },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { location: { select: { id: true, name: true, clientId: true, client: { select: { name: true } } } } },
      },
      applications: { where: { deletedAt: null, status: { notIn: ['REJECTED', 'CANCELLED'] } }, orderBy: { updatedAt: 'desc' }, take: 1, select: { status: true, clientId: true, client: { select: { name: true } } } },
      compRecords: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { payType: true } },
      _count: { select: { payrollItems: true, timeEntries: true } },
    },
  });
  const m = await membershipOf(
    rows.map((r) => r.id),
    null,
  );
  return rows.map((r) => {
    const loc = r.assignments[0]?.location;
    const app = r.applications[0];
    const gone = (!!r.separatedAt && r.separatedAt.getTime() <= Date.now()) || !!r.deactivatedAt;
    const fresh = r._count.payrollItems === 0 && r._count.timeEntries === 0 && !!app;
    return {
      id: r.id,
      name: nameOf(r),
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      photoUrl: profilePhotoUrlFor(r),
      clientId: loc?.clientId ?? app?.clientId ?? null,
      clientName: loc?.client?.name ?? app?.client?.name ?? null,
      siteId: loc?.id ?? null,
      siteName: loc?.name ?? null,
      departmentId: r.departmentId,
      departmentName: r.department?.name ?? null,
      payType: (r.compRecords[0]?.payType as 'HOURLY' | 'SALARY' | undefined) ?? null,
      status: gone ? 'INACTIVE' : fresh ? 'NEW_HIRE' : 'ACTIVE',
      currentScheduleId: m.today.get(r.id)?.scheduleId ?? null,
    };
  });
}

function toCandidate(p: PersonRow, scheduleNames: Map<string, string>): ScheduleCandidate {
  return {
    associateId: p.id,
    name: p.name,
    photoUrl: p.photoUrl,
    email: p.email,
    clientId: p.clientId,
    clientName: p.clientName,
    siteName: p.siteName,
    departmentName: p.departmentName,
    payType: p.payType,
    status: p.status,
    currentScheduleId: p.currentScheduleId,
    currentScheduleName: p.currentScheduleId ? (scheduleNames.get(p.currentScheduleId) ?? null) : null,
  };
}

async function scheduleNameMap(): Promise<Map<string, string>> {
  const all = await prisma.payrollSchedule.findMany({ where: { tenantId: tenantIdForWrite() }, select: { id: true, name: true } });
  return new Map(all.map((s) => [s.id, s.name]));
}

/**
 * People a run would be for (hired, employed) whom no live schedule covers
 * today or later — the one membership rule (lib/payScheduleMembership
 * scheduleMembershipFor / onNoScheduleWhere), so this count, the readiness
 * grid's Schedule column and the payroll home's blocker are one number.
 */
export function unassignedWhere(user: SessionUser): Prisma.AssociateWhereInput {
  return scopeWhere<Prisma.AssociateWhereInput>(
    { tenantId: tenantIdForWrite() },
    PAY_RUN_POPULATION_WHERE,
    scopeAssociates(user),
    onNoScheduleWhere(todayYmd()),
  );
}

/** For the inbox: people on no schedule, when the tenant pays by schedules at all. */
export async function countUnassigned(user: SessionUser): Promise<number> {
  const any = await prisma.payrollSchedule.count({ where: { tenantId: tenantIdForWrite(), isActive: true, deletedAt: null } });
  if (any === 0) return 0;
  return prisma.associate.count({ where: unassignedWhere(user) });
}

/** For the inbox: people whose move to another schedule starts in the next seven days. */
export async function countMovesThisWeek(user: SessionUser): Promise<number> {
  const today = todayYmd();
  const rows = await prisma.payrollScheduleAssignment.findMany({
    where: {
      tenantId: tenantIdForWrite(),
      effectiveFrom: { gte: dateOnly(today), lte: dateOnly(addDaysYmd(today, 7)) },
      source: { not: 'MIGRATION' },
      associate: scopeWhere<Prisma.AssociateWhereInput>({ deletedAt: null }, scopeAssociates(user)),
    },
    distinct: ['associateId'],
    select: { associateId: true },
  });
  return rows.length;
}

/* ===== Routes: the static paths first, then /:id ========================= */

paySchedulesRouter.get('/', async (req, res, next) => {
  try {
    const schedules = await prisma.payrollSchedule.findMany({
      where: scopeWhere<Prisma.PayrollScheduleWhereInput>({ tenantId: tenantIdForWrite(), deletedAt: null }, scopePayrollSchedules(req.user!)),
      orderBy: [{ isActive: 'desc' }, { isDefault: 'desc' }, { name: 'asc' }],
      include: { versions: true },
      take: 500,
    });
    const [summaries, unassigned] = await Promise.all([summarize(req.user!, schedules), prisma.associate.count({ where: unassignedWhere(req.user!) })]);
    res.json(PayScheduleListResponseSchema.parse({ schedules: summaries, unassigned }));
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.post('/', PROCESS, async (req, res, next) => {
  try {
    const input = PayScheduleCreateInputSchema.parse(req.body);
    const tenantId = tenantIdForWrite();
    const today = todayYmd();
    const created = await prisma.$transaction(async (tx) => {
      if (input.isDefault) await tx.payrollSchedule.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
      const s = await tx.payrollSchedule.create({
        data: {
          tenantId,
          name: input.name,
          frequency: input.frequency,
          anchorDate: dateOnly(input.anchorDate),
          payDateOffsetDays: input.payDateOffsetDays,
          notes: input.notes ?? null,
          isDefault: input.isDefault ?? false,
        },
      });
      await tx.payrollScheduleVersion.create({
        data: { tenantId, scheduleId: s.id, effectiveFrom: dateOnly(input.anchorDate < today ? input.anchorDate : today), frequency: input.frequency, anchorDate: dateOnly(input.anchorDate), payDateOffsetDays: input.payDateOffsetDays, createdById: req.user!.id },
      });
      return s;
    });
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'payroll.schedule.create', entityType: 'PayrollSchedule', entityId: created.id, metadata: { name: created.name, frequency: created.frequency, summary: `Created ${created.name}: ${patternSentence(created)}` } },
      'paySchedules.create',
    );
    const s = await scheduleInReach(req.user!, created.id);
    if (input.membership && (input.membership.add.length || input.membership.endRuleIds.length)) {
      const change = dedupe(await changeFromInput(req.user!, s, input.membership), (await loadWorld(prisma)).rules);
      await applyChange(req.user!, change, 'RULE');
    }
    if (input.isDefault) await recompute(prisma, 'all', 'RULE', { actorUserId: req.user!.id });
    res.status(201).json({ schedule: await detail(req.user!, await scheduleInReach(req.user!, created.id)) });
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/preview-pattern', async (req, res, next) => {
  try {
    const q = z
      .object({
        frequency: PayFrequencySchema,
        anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        payDateOffsetDays: z.coerce.number().int().min(0).max(31),
        months: z.coerce.number().int().min(1).max(24).default(3),
        /** A change to an existing schedule: its periods from `effectiveFrom`, the bridge (if any) first. */
        scheduleId: z.string().max(64).optional(),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.query);
    await loadTenantHolidays(prisma);
    const today = todayYmd();
    let s: ScheduleWithVersions = { id: 'preview', name: 'Preview', frequency: q.frequency, anchorDate: dateOnly(q.anchorDate), payDateOffsetDays: q.payDateOffsetDays };
    let from = today;
    if (q.scheduleId && q.effectiveFrom) {
      const existing = await scheduleInReach(req.user!, q.scheduleId);
      s = withVersion(existing, proposedVersion(existing, { frequency: q.frequency, payDateOffsetDays: q.payDateOffsetDays, effectiveFrom: q.effectiveFrom }), today);
      from = q.effectiveFrom;
    }
    const until = ymd(new Date(dateOnly(from).getTime() + q.months * 31 * DAY));
    const periods = periodsFrom(s, from, 400).filter((p) => p.periodStart <= until);
    res.json(PayCalendarResponseSchema.parse({ periods: periods.map((p) => periodDto(s, p, null)) }));
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/unassigned', async (req, res, next) => {
  try {
    const where = unassignedWhere(req.user!);
    const [rows, total, names] = await Promise.all([peopleInReach(req.user!, where), prisma.associate.count({ where }), scheduleNameMap()]);
    res.json(UnassignedResponseSchema.parse({ people: rows.slice(0, 500).map((p) => toCandidate(p, names)), total }));
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/candidates', async (req, res, next) => {
  try {
    const q = z
      .object({
        clientId: z.string().uuid().optional(),
        siteId: z.string().uuid().optional(),
        departmentId: z.string().uuid().optional(),
        payType: z.enum(['HOURLY', 'SALARY']).optional(),
        scheduleId: z.union([z.string().uuid(), z.literal('none')]).optional(),
        q: z.string().trim().max(120).optional(),
        status: z.enum(['ACTIVE', 'NEW_HIRE', 'INACTIVE']).optional(),
        cursor: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const tokens = (q.q ?? '').split(/\s+/).filter(Boolean).slice(0, 4);
    const text: Prisma.AssociateWhereInput = tokens.length
      ? { AND: tokens.map((t) => ({ OR: [{ firstName: { contains: t, mode: 'insensitive' as const } }, { lastName: { contains: t, mode: 'insensitive' as const } }, { email: { contains: t, mode: 'insensitive' as const } }] })) }
      : {};
    const [all, names] = await Promise.all([peopleInReach(req.user!, text), scheduleNameMap()]);
    // Inactive people only when asked for: the builder adds the working.
    const base = all.filter((p) => (q.status ? p.status === q.status : p.status !== 'INACTIVE') && (!q.payType || p.payType === q.payType) && (!q.scheduleId || (q.scheduleId === 'none' ? !p.currentScheduleId : p.currentScheduleId === q.scheduleId)));
    const byClient = (p: PersonRow) => !q.clientId || p.clientId === q.clientId;
    const bySite = (p: PersonRow) => !q.siteId || p.siteId === q.siteId;
    const byDept = (p: PersonRow) => !q.departmentId || p.departmentId === q.departmentId;
    const matching = base.filter((p) => byClient(p) && bySite(p) && byDept(p));
    const count = <K extends string>(rows: PersonRow[], key: (p: PersonRow) => K | null, label: (p: PersonRow) => string) => {
      const m = new Map<K, { name: string; count: number; sample: PersonRow }>();
      for (const p of rows) {
        const k = key(p);
        if (!k) continue;
        const e = m.get(k) ?? { name: label(p), count: 0, sample: p };
        e.count += 1;
        m.set(k, e);
      }
      return [...m.entries()].sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name));
    };
    const offset = q.cursor ? Number.parseInt(Buffer.from(q.cursor, 'base64url').toString('utf8'), 10) || 0 : 0;
    const page = matching.slice(offset, offset + q.limit);
    res.json(
      ScheduleCandidatesResponseSchema.parse({
        people: page.map((p) => toCandidate(p, names)),
        total: matching.length,
        nextCursor: offset + q.limit < matching.length ? Buffer.from(String(offset + q.limit)).toString('base64url') : null,
        facets: {
          clients: count(base.filter((p) => bySite(p) && byDept(p)), (p) => p.clientId, (p) => p.clientName ?? 'Client').map(([id, e]) => ({ id, name: e.name, count: e.count })),
          sites: count(base.filter((p) => byClient(p) && byDept(p)), (p) => p.siteId, (p) => p.siteName ?? 'Site').map(([id, e]) => ({ id, name: e.name, clientId: e.sample.clientId, count: e.count })),
          departments: count(base.filter((p) => byClient(p) && bySite(p)), (p) => p.departmentId, (p) => p.departmentName ?? 'Department').map(([id, e]) => ({ id, name: e.name, count: e.count })),
        },
      }),
    );
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.post('/move/preview', PROCESS, async (req, res, next) => {
  try {
    const change = await changeFromMove(req.user!, req.body);
    const { impact } = await impactOf(req.user!, dedupe(change, (await loadWorld(prisma)).rules), 'MANUAL');
    res.json(impact);
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.post('/move', PROCESS, async (req, res, next) => {
  try {
    const change = await changeFromMove(req.user!, req.body);
    const impact = await applyChange(req.user!, dedupe(change, (await loadWorld(prisma)).rules), 'MANUAL');
    res.json({ impact });
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/:id', async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    res.json({ schedule: await detail(req.user!, s) });
  } catch (err) {
    next(err);
  }
});

interface PatternVersion {
  effectiveFrom: string;
  frequency: PayrollFrequency;
  anchorDate: string;
  payDateOffsetDays: number;
}

/** A pattern change as it would be stored: whatever isn't changing carries over from the pattern in force. */
function proposedVersion(s: ScheduleWithVersions, input: { frequency?: PayrollFrequency; anchorDate?: string; payDateOffsetDays?: number; effectiveFrom: string }): PatternVersion {
  const cur = patternOn(s, input.effectiveFrom);
  const frequency = input.frequency ?? cur.frequency;
  // Week-based periods count from the first new period; calendar-based ones ignore the anchor.
  const weekBased = frequency === 'WEEKLY' || frequency === 'BIWEEKLY' || frequency === 'DAILY';
  const anchorDate = input.anchorDate ?? (weekBased ? input.effectiveFrom : ymd(typeof cur.anchorDate === 'string' ? dateOnly(cur.anchorDate) : cur.anchorDate));
  return { effectiveFrom: input.effectiveFrom, frequency, anchorDate, payDateOffsetDays: input.payDateOffsetDays ?? cur.payDateOffsetDays };
}

/** The schedule's first version (where history starts) when it has none yet. */
const baseVersionFrom = (s: ScheduleWithVersions, today: string): string => (ymd(s.anchorDate) < today ? ymd(s.anchorDate) : today);

/** `s` with `v` added to its pattern history, as it would read once saved. */
function withVersion(s: ScheduleWithVersions, v: PatternVersion, today: string): ScheduleWithVersions {
  const base = s.versions?.length ? s.versions : [{ effectiveFrom: dateOnly(baseVersionFrom(s, today)), frequency: s.frequency, anchorDate: s.anchorDate, payDateOffsetDays: s.payDateOffsetDays }];
  return {
    ...s,
    versions: [...base.filter((x) => ymd(x.effectiveFrom) !== v.effectiveFrom), { effectiveFrom: dateOnly(v.effectiveFrom), frequency: v.frequency, anchorDate: dateOnly(v.anchorDate), payDateOffsetDays: v.payDateOffsetDays }],
  };
}

paySchedulesRouter.patch('/:id', PROCESS, async (req, res, next) => {
  try {
    const input = PayScheduleUpdateInputSchema.parse(req.body);
    const s = await scheduleInReach(req.user!, req.params.id);
    const tenantId = tenantIdForWrite();
    const today = todayYmd();
    const patternChange = input.frequency !== undefined || input.anchorDate !== undefined || input.payDateOffsetDays !== undefined;
    const summaryBits: string[] = [];

    if (input.isActive === false && s.isActive) {
      const m = await membershipOf(null, [s.id]);
      const onIt = [...m.today.values()].filter((t) => t.scheduleId === s.id).length + [...m.next.values()].filter((n) => n.scheduleId === s.id).length;
      if (onIt > 0) throw new HttpError(409, 'schedule_in_use', `${onIt} ${onIt === 1 ? 'person is' : 'people are'} on this schedule now or from a future date. Move them first.`);
      if (s.isDefault) throw new HttpError(409, 'schedule_is_default', 'This is the company default. Make another schedule the default first.');
    }

    let version: PatternVersion | null = null;
    let bridge: PeriodWindow | null = null;
    if (patternChange) {
      if (!input.effectiveFrom) throw new HttpError(400, 'effective_from_required', 'A pattern change starts at a future pay period: say which.');
      if (input.effectiveFrom <= today) throw new HttpError(400, 'effective_in_past', 'A pattern change starts at a future pay period, so no period already running changes.');
      if (periodStartOnOrAfter(s, input.effectiveFrom) !== input.effectiveFrom) {
        throw new HttpError(400, 'not_a_period_start', `${fmtDay(input.effectiveFrom)} isn’t the start of a pay period on this schedule. The next one starts ${fmtDay(periodStartOnOrAfter(s, input.effectiveFrom))}.`);
      }
      version = proposedVersion(s, { ...input, effectiveFrom: input.effectiveFrom });
      // Periods that don't line up with the change get one short bridge period (periodContaining).
      const first = periodContaining(withVersion(s, version, today), input.effectiveFrom);
      if (first.bridge) bridge = first;
    } else if (input.effectiveFrom) {
      throw new HttpError(400, 'nothing_to_version', 'effectiveFrom goes with a frequency, anchor date or pay-date change.');
    }

    await prisma.$transaction(async (tx) => {
      if (input.isDefault === true && !s.isDefault) await tx.payrollSchedule.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
      const data: Prisma.PayrollScheduleUpdateInput = {};
      if (input.name !== undefined && input.name !== s.name) {
        data.name = input.name;
        summaryBits.push(`renamed to ${input.name}`);
      }
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.isActive !== undefined && input.isActive !== s.isActive) {
        data.isActive = input.isActive;
        summaryBits.push(input.isActive ? 'turned on' : 'turned off');
      }
      if (input.isDefault !== undefined && input.isDefault !== s.isDefault) {
        data.isDefault = input.isDefault;
        summaryBits.push(input.isDefault ? 'made the company default' : 'no longer the company default');
      }
      if (Object.keys(data).length) await tx.payrollSchedule.update({ where: { id: s.id }, data });
      if (version) {
        if (s.versions.length === 0) {
          await tx.payrollScheduleVersion.create({ data: { tenantId, scheduleId: s.id, effectiveFrom: dateOnly(baseVersionFrom(s, today)), frequency: s.frequency, anchorDate: s.anchorDate, payDateOffsetDays: s.payDateOffsetDays } });
        }
        await tx.payrollScheduleVersion.upsert({
          where: { scheduleId_effectiveFrom: { scheduleId: s.id, effectiveFrom: dateOnly(version.effectiveFrom) } },
          create: { tenantId, scheduleId: s.id, effectiveFrom: dateOnly(version.effectiveFrom), frequency: version.frequency, anchorDate: dateOnly(version.anchorDate), payDateOffsetDays: version.payDateOffsetDays, createdById: req.user!.id },
          update: { frequency: version.frequency, anchorDate: dateOnly(version.anchorDate), payDateOffsetDays: version.payDateOffsetDays, createdById: req.user!.id },
        });
      }
    });
    if (version) {
      enqueueAudit(
        { actorUserId: req.user!.id, clientId: null, action: 'payroll.schedule.version', entityType: 'PayrollSchedule', entityId: s.id, metadata: { ...version, ...(bridge ? { bridge: { periodStart: bridge.periodStart, periodEnd: bridge.periodEnd, payDate: bridge.payDate } } : {}), summary: `Pattern changes ${fmtDay(version.effectiveFrom)}: ${patternSentence({ ...version, anchorDate: dateOnly(version.anchorDate) })}${bridge ? ` (a short bridge period ${fmtDay(bridge.periodStart)}–${fmtDay(bridge.periodEnd)}, paid ${fmtDay(bridge.payDate)}, joins the two)` : ''}` } },
        'paySchedules.version',
      );
    }
    if (summaryBits.length) {
      enqueueAudit(
        { actorUserId: req.user!.id, clientId: null, action: 'payroll.schedule.update', entityType: 'PayrollSchedule', entityId: s.id, metadata: { summary: `${s.name}: ${summaryBits.join(', ')}` } },
        'paySchedules.update',
      );
    }
    // The default catches everyone no rule covers: who that is just changed.
    if (input.isDefault !== undefined && input.isDefault !== s.isDefault) await recompute(prisma, 'all', 'RULE', { actorUserId: req.user!.id });
    res.json({ schedule: await detail(req.user!, await scheduleInReach(req.user!, s.id)) });
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.delete('/:id', PROCESS, async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    const today = dateOnly(todayYmd());
    const [assigned, legacy, rules] = await Promise.all([
      prisma.payrollScheduleAssignment.count({ where: { scheduleId: s.id, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] } }),
      prisma.associate.count({ where: { payrollScheduleId: s.id, deletedAt: null } }),
      prisma.payrollScheduleRule.count({ where: { scheduleId: s.id, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] } }),
    ]);
    if (assigned + legacy > 0) throw new HttpError(409, 'schedule_in_use', `${assigned + legacy} ${assigned + legacy === 1 ? 'person is' : 'people are'} on this schedule now or from a future date. Move them first.`);
    if (rules > 0) throw new HttpError(409, 'schedule_has_rules', `${rules} ${rules === 1 ? 'rule points' : 'rules point'} at this schedule. End them first.`);
    await prisma.payrollSchedule.update({ where: { id: s.id }, data: { deletedAt: new Date(), isActive: false, isDefault: false } });
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: 'payroll.schedule.delete', entityType: 'PayrollSchedule', entityId: s.id, metadata: { name: s.name, summary: `Deleted ${s.name}` } },
      'paySchedules.delete',
    );
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/:id/calendar', async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    const q = z.object({ months: z.coerce.number().int().min(1).max(36).default(12), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
    await loadTenantHolidays(prisma);
    // Start at the period being paid next: in the days between a period's end and its payday, that is
    // the period already over — the header's "Next payday" must appear on the calendar too.
    const paidNext = nextPaidPeriod(s).periodStart;
    const running = periodContaining(s, todayYmd()).periodStart;
    const from = q.from ?? (paidNext < running ? paidNext : running);
    const until = ymd(new Date(dateOnly(from).getTime() + q.months * 31 * DAY));
    const periods = periodsFrom(s, from, 800).filter((p) => p.periodStart <= until);
    const runOf = await runsByPeriod(
      [s],
      periods.map((p) => p.periodStart),
    );
    res.json(PayCalendarResponseSchema.parse({ periods: periods.map((p) => periodDto(s, p, runOf(s.id, s.clientId, p.periodStart))) }));
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/:id/people', async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    const q = z.object({ view: z.enum(['current', 'joining', 'leaving', 'blocked', 'attention', 'ready', 'all']).default('current') }).parse(req.query);
    const today = todayYmd();
    const m = await membershipOf(null, [s.id]);
    const names = await scheduleNameMap();
    const current = [...m.today.entries()].filter(([, t]) => t.scheduleId === s.id).map(([id]) => id);
    const joining = [...m.next.entries()].filter(([id, n]) => n.scheduleId === s.id && m.today.get(id)?.scheduleId !== s.id).map(([id]) => id);
    const wanted = q.view === 'joining' ? joining : q.view === 'all' ? [...current, ...joining] : current;
    const people = await peopleInReach(req.user!, { id: { in: wanted } });
    const pending = new Map<string, { toName: string | null; effectiveFrom: string }>();
    for (const [id, n] of m.next) if (m.today.get(id)?.scheduleId === s.id && n.scheduleId !== s.id) pending.set(id, { toName: n.scheduleId ? (names.get(n.scheduleId) ?? null) : null, effectiveFrom: n.effectiveFrom });
    const readiness = await readinessFor(
      people.map((p) => p.id),
      pending,
    );

    const ids = people.map((p) => p.id);
    const yearStart = dateOnly(`${today.slice(0, 4)}-01-01`);
    const [details, items] = await Promise.all([
      prisma.associate.findMany({
        where: { id: { in: ids } },
        select: { id: true, jobProfile: { select: { title: true } }, applications: { where: { deletedAt: null, status: 'APPROVED' }, orderBy: { updatedAt: 'desc' }, take: 1, select: { position: true } }, compRecords: { orderBy: { effectiveFrom: 'desc' }, take: 1, select: { payType: true, amount: true } } },
      }),
      prisma.payrollItem.findMany({
        where: { associateId: { in: ids }, status: { not: 'VOIDED' }, payrollRun: { status: { in: ['FINALIZED', 'DISBURSED'] }, periodEnd: { gte: new Date(Date.now() - 400 * DAY) } } },
        select: { associateId: true, grossPay: true, netPay: true, payrollRun: { select: { periodEnd: true, disbursedAt: true } } },
      }),
    ]);
    const det = new Map(details.map((d) => [d.id, d]));
    const offset = patternOn(s, today).payDateOffsetDays;
    const money = (n: number, digits: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

    const rows: RosterPerson[] = people.map((p) => {
      const d = det.get(p.id);
      const comp = d?.compRecords[0];
      const mine = items.filter((i) => i.associateId === p.id);
      const latest = [...mine].sort((a, b) => b.payrollRun.periodEnd.getTime() - a.payrollRun.periodEnd.getTime())[0];
      const t = m.today.get(p.id);
      const n = m.next.get(p.id);
      const rd = readiness.get(p.id) ?? { level: 'READY' as const, issues: [] };
      return {
        associateId: p.id,
        name: p.name,
        photoUrl: p.photoUrl,
        jobTitle: d?.jobProfile?.title ?? d?.applications[0]?.position ?? null,
        clientId: p.clientId,
        clientName: p.clientName,
        siteName: p.siteName,
        departmentName: p.departmentName,
        payType: p.payType,
        rateLabel: comp ? (comp.payType === 'SALARY' ? `${money(Number(comp.amount), 0)}/yr` : `${money(Number(comp.amount), 2)}/h`) : null,
        lastPay: latest ? { payDate: latest.payrollRun.disbursedAt ? ymd(latest.payrollRun.disbursedAt) : addDaysYmd(ymd(latest.payrollRun.periodEnd), offset), net: Number(latest.netPay) } : null,
        ytdGross: Math.round(mine.filter((i) => i.payrollRun.periodEnd >= yearStart).reduce((sum, i) => sum + Number(i.grossPay), 0) * 100) / 100,
        onScheduleSince: t?.scheduleId === s.id ? t.since : (n?.effectiveFrom ?? today),
        because: t?.scheduleId === s.id ? t.because : (n?.because ?? 'Rule'),
        readiness: rd.level,
        issues: rd.issues,
        pendingMove: t?.scheduleId === s.id && n && n.scheduleId !== s.id ? { toScheduleName: n.scheduleId ? (names.get(n.scheduleId) ?? null) : null, effectiveFrom: n.effectiveFrom } : null,
        isNewHire: p.status === 'NEW_HIRE',
      };
    });
    const shown = rows.filter((r) =>
      q.view === 'blocked' ? r.readiness === 'BLOCKED' : q.view === 'attention' ? r.readiness === 'ATTENTION' : q.view === 'ready' ? r.readiness === 'READY' : q.view === 'leaving' ? !!r.pendingMove : true,
    );
    const tally = (list: RosterPerson[]) => ({
      total: list.length,
      ready: list.filter((r) => r.readiness === 'READY').length,
      attention: list.filter((r) => r.readiness === 'ATTENTION').length,
      blocked: list.filter((r) => r.readiness === 'BLOCKED').length,
    });
    const groups = new Map<string, { clientId: string | null; clientName: string; people: RosterPerson[] }>();
    for (const r of shown) {
      const k = r.clientId ?? 'none';
      const g = groups.get(k) ?? { clientId: r.clientId, clientName: r.clientName ?? 'No client', people: [] };
      g.people.push(r);
      groups.set(k, g);
    }
    res.json(
      PayScheduleRosterResponseSchema.parse({
        groups: [...groups.values()]
          .sort((a, b) => (a.clientId ? 0 : 1) - (b.clientId ? 0 : 1) || a.clientName.localeCompare(b.clientName))
          .map((g) => ({ ...g, counts: tally(g.people) })),
        totals: tally(shown),
      }),
    );
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.get('/:id/history', async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    const tenantId = tenantIdForWrite();
    const rows = await prisma.auditLog.findMany({
      where: {
        tenantId,
        OR: [
          { entityType: 'PayrollSchedule', entityId: s.id },
          { action: { in: ['payroll.schedule.auto_move', 'payroll.schedule.move'] }, metadata: { path: ['to'], equals: s.id } },
          { action: { in: ['payroll.schedule.auto_move', 'payroll.schedule.move'] }, metadata: { path: ['from'], equals: s.id } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { action: true, createdAt: true, actorUserId: true, metadata: true },
    });
    const actors = await userNames(rows.map((r) => r.actorUserId));
    const TRIGGER: Record<string, string> = { HIRE: 'hired', TRANSFER: 'transfer', DEPARTMENT: 'department change', PAY_TYPE: 'pay type change', NIGHTLY: 'placement change', RULE: 'rule change', MANUAL: 'moved by hand' };
    const events = rows.map((r) => {
      const md = (r.metadata ?? {}) as Record<string, unknown>;
      const summary = typeof md.summary === 'string' ? md.summary : null;
      let kind: 'CREATED' | 'RULE_ADDED' | 'RULE_ENDED' | 'PATTERN_CHANGED' | 'PERSON_JOINED' | 'PERSON_LEFT' | 'SETTINGS' = 'SETTINGS';
      let text = summary ?? r.action;
      if (r.action === 'payroll.schedule.create') kind = 'CREATED';
      else if (r.action === 'payroll.schedule.rule_add') kind = 'RULE_ADDED';
      else if (r.action === 'payroll.schedule.rule_end') kind = 'RULE_ENDED';
      else if (r.action === 'payroll.schedule.version') kind = 'PATTERN_CHANGED';
      else if (r.action === 'payroll.schedule.auto_move' || r.action === 'payroll.schedule.move') {
        const joined = md.to === s.id;
        kind = joined ? 'PERSON_JOINED' : 'PERSON_LEFT';
        const who = typeof md.name === 'string' ? md.name : 'Someone';
        const when = typeof md.effectiveFrom === 'string' ? ` from ${fmtDay(md.effectiveFrom)}` : '';
        const why = typeof md.trigger === 'string' ? TRIGGER[md.trigger] : null;
        text = `${who} ${joined ? 'moves here' : 'moves off'}${when}${why ? ` (${why})` : ''}`;
      } else if (r.action === 'payroll.schedule.assign') {
        kind = 'PERSON_JOINED';
        text = summary ?? 'People assigned';
      }
      return { at: r.createdAt.toISOString(), actorName: r.actorUserId ? (actors.get(r.actorUserId) ?? null) : null, summary: text, kind };
    });
    res.json(PayScheduleHistoryResponseSchema.parse({ events }));
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.post('/:id/membership/preview', PROCESS, async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    const input = MembershipChangeInputSchema.parse(req.body);
    const change = dedupe(await changeFromInput(req.user!, s, input), (await loadWorld(prisma)).rules);
    const { impact } = await impactOf(req.user!, change, 'RULE');
    res.json(impact);
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.post('/:id/membership', PROCESS, async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    if (!s.isActive) throw new HttpError(409, 'schedule_inactive', 'That schedule is turned off. Turn it on first.');
    const input = MembershipChangeInputSchema.parse(req.body);
    const change = dedupe(await changeFromInput(req.user!, s, input), (await loadWorld(prisma)).rules);
    const impact = await applyChange(req.user!, change, 'RULE');
    res.json({ impact });
  } catch (err) {
    next(err);
  }
});

paySchedulesRouter.delete('/:id/rules/:ruleId', PROCESS, async (req, res, next) => {
  try {
    const s = await scheduleInReach(req.user!, req.params.id);
    if (!UuidParam.safeParse(req.params.ruleId).success) throw new HttpError(404, 'rule_not_found', 'Rule not found');
    const rule = await prisma.payrollScheduleRule.findFirst({ where: { id: req.params.ruleId, scheduleId: s.id, tenantId: tenantIdForWrite() } });
    if (!rule) throw new HttpError(404, 'rule_not_found', 'Rule not found');
    const body = z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
    const change = await changeFromInput(req.user!, s, { add: [], endRuleIds: [rule.id], effectiveFrom: body.effectiveFrom ?? (typeof req.query.effectiveFrom === 'string' ? req.query.effectiveFrom : undefined) });
    const impact = await applyChange(req.user!, change, 'RULE');
    res.json({ impact });
  } catch (err) {
    next(err);
  }
});

/* ===== One person: /associates/:id/pay-schedule ========================== */

async function personInReach(user: SessionUser, id: string) {
  if (!UuidParam.safeParse(id).success) throw new HttpError(404, 'associate_not_found', 'Person not found');
  const p = await prisma.associate.findFirst({
    where: scopeWhere<Prisma.AssociateWhereInput>({ id, tenantId: tenantIdForWrite(), deletedAt: null }, scopeAssociates(user)),
    select: { id: true, firstName: true, lastName: true },
  });
  if (!p) throw new HttpError(404, 'associate_not_found', 'Person not found');
  return p;
}

export async function associateSchedule(associateId: string) {
  const today = todayYmd();
  await loadTenantHolidays(prisma);
  const [m, world, facts] = await Promise.all([membershipOf([associateId], null), loadWorld(prisma), loadFacts(prisma, [associateId], today)]);
  const t = m.today.get(associateId);
  const n = m.next.get(associateId);
  const sched = (id: string | null | undefined) => (id ? world.schedules.get(id) : undefined);
  const f = facts.get(associateId);
  const withoutOverride = world.rules.filter((r) => !(r.kind === 'INDIVIDUAL' && r.associateId === associateId));
  const d = f ? desiredFor({ ...f, legacyScheduleId: null }, withoutOverride, today, { defaultScheduleId: world.defaultScheduleId, activeScheduleIds: world.activeScheduleIds, scheduleNames: world.names.schedules }) : null;
  const cur = sched(t?.scheduleId);
  const nextS = sched(n?.scheduleId);
  // Their first payday from now that covers days they're on the schedule (a joiner isn't paid for the period before).
  let payOn: string | null = null;
  if (cur && t) {
    let p = nextPaidPeriod(cur);
    for (let i = 0; i < 60 && p.periodEnd < t.since; i++) p = periodContaining(cur, addDaysYmd(p.periodEnd, 1));
    payOn = p.payDate;
  } else if (nextS && n) payOn = periodContaining(nextS, n.effectiveFrom).payDate;
  return AssociatePayScheduleSchema.parse({
    current: t && cur ? { scheduleId: cur.id, name: cur.name, pattern: patternSentence(patternOn(cur, today)), since: t.since, because: t.because } : null,
    pending: n ? { scheduleId: n.scheduleId, name: nextS?.name ?? null, effectiveFrom: n.effectiveFrom, because: n.because } : null,
    ruleDefault: d?.scheduleId && sched(d.scheduleId) ? { scheduleId: d.scheduleId, name: sched(d.scheduleId)!.name, because: becauseLabel(d, world.rules, world.names) } : null,
    nextPayDate: payOn,
  });
}

/** A new hire for the schedule (lib/hirePay's window, a pay change since hire aside): the onboarding desk may choose it on their record too. */
async function scheduleNewHire(associateId: string): Promise<boolean> {
  const f = await hireFacts(prisma, associateId);
  return f !== null && newHireForSchedule(f);
}

associatePayScheduleRouter.get('/:id/pay-schedule', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    if (!can(u, 'view:payroll') && !can(u, 'manage:onboarding')) throw new HttpError(403, 'forbidden', 'Not allowed');
    const p = await personInReach(u, req.params.id);
    res.json({ ...(await associateSchedule(p.id)), newHire: await scheduleNewHire(p.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * The schedules this person could be put on, for a picker whose user cannot
 * read /payroll/pay-schedules (view:payroll) — the onboarding desk. Active
 * schedules in the caller's reach: name, pattern, the running period and
 * the first period start from today. Nothing about who else is on them.
 */
associatePayScheduleRouter.get('/:id/pay-schedule/choices', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    if (!can(u, 'view:payroll') && !can(u, 'manage:onboarding')) throw new HttpError(403, 'forbidden', 'Not allowed');
    await personInReach(u, req.params.id);
    await loadTenantHolidays(prisma);
    const today = todayYmd();
    const rows = await prisma.payrollSchedule.findMany({
      where: scopeWhere<Prisma.PayrollScheduleWhereInput>({ tenantId: tenantIdForWrite(), deletedAt: null, isActive: true }, scopePayrollSchedules(u)),
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { versions: true },
      take: 200,
    });
    res.json(
      PayScheduleChoicesResponseSchema.parse({
        schedules: rows.map((s) => {
          const np = nextPaidPeriod(s);
          return {
            id: s.id,
            name: s.name,
            pattern: patternSentence(patternOn(s, today)),
            isActive: s.isActive,
            isDefault: s.isDefault,
            nextPeriod: { periodStart: np.periodStart, periodEnd: np.periodEnd, payDate: np.payDate },
            firstStart: periodStartOnOrAfter(s, today),
          };
        }),
      }),
    );
  } catch (err) {
    next(err);
  }
});

/** The default first day for a person put on `target` by hand: its next period start — or today for someone on no schedule (the engine then backs it to the running period's start, so their first days are paid). */
export async function defaultStartFor(associateId: string, target: ScheduleWithVersions | null): Promise<string> {
  const today = todayYmd();
  const m = await membershipOf([associateId], null);
  return m.today.has(associateId) && target ? periodStartOnOrAfter(target, today) : today;
}

/**
 * Put people on a schedule by hand (an INDIVIDUAL rule each), from a date.
 * Their individual rules on other schedules end the day before, and an
 * exclusion from this one ends. `scheduleId: null` removes the override:
 * the rules decide again. No notice — a person did it.
 */
export async function assignPeople(user: SessionUser, associateIds: string[], scheduleId: string | null, from: string): Promise<void> {
  if (associateIds.length === 0) return;
  if (from < todayYmd()) throw new HttpError(400, 'effective_in_past', 'A schedule change starts today or later.');
  const target = scheduleId ? await scheduleInReach(user, scheduleId) : null;
  if (target && !target.isActive) throw new HttpError(409, 'schedule_inactive', 'That schedule is turned off.');
  const world = await loadWorld(prisma);
  const who = new Set(associateIds);
  const open = (r: RuleRow) => !r.effectiveTo || ymd(r.effectiveTo) >= from;
  const endRuleIds = world.rules
    .filter((r) => !!r.associateId && who.has(r.associateId) && open(r) && ((r.kind === 'INDIVIDUAL' && r.scheduleId !== target?.id) || (r.kind === 'EXCLUDE' && r.scheduleId === target?.id)))
    .map((r) => r.id);
  const base = target ?? (await prisma.payrollSchedule.findFirst({ where: { tenantId: tenantIdForWrite() }, include: { versions: true } }));
  if (!base) return;
  const change = dedupe(await changeFromInput(user, base, { add: target ? associateIds.map((associateId) => ({ kind: 'INDIVIDUAL' as const, associateId })) : [], endRuleIds, effectiveFrom: from }), world.rules);
  if (change.add.length === 0 && change.endRuleIds.length === 0) {
    await recompute(prisma, associateIds, 'MANUAL', { actorUserId: user.id });
    return;
  }
  await applyChange(user, change, 'MANUAL');
}

associatePayScheduleRouter.put('/:id/pay-schedule', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    if (!can(u, 'process:payroll') && !can(u, 'manage:onboarding')) throw new HttpError(403, 'forbidden', 'Not allowed');
    const body = z.object({ scheduleId: z.string().uuid().nullable(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body);
    const p = await personInReach(u, req.params.id);
    // The onboarding desk chooses a NEW hire's schedule; moving anyone else
    // between schedules is payroll's (the screen says so too, but the rule
    // lives here).
    if (!can(u, 'process:payroll') && !(await scheduleNewHire(p.id))) {
      throw new HttpError(403, 'not_a_new_hire', 'Moving someone to another pay schedule is a payroll change now — someone with payroll access makes it.');
    }
    const target = body.scheduleId ? await scheduleInReach(u, body.scheduleId) : null;
    await assignPeople(u, [p.id], body.scheduleId, body.effectiveFrom ?? (await defaultStartFor(p.id, target)));
    res.json({ ...(await associateSchedule(p.id)), newHire: await scheduleNewHire(p.id) });
  } catch (err) {
    next(err);
  }
});
