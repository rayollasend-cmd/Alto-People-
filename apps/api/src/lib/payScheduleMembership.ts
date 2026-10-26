import type { PayrollFrequency, Prisma, PrismaClient } from '@prisma/client';
import { RULE_SPECIFICITY, becauseSentence, type ScheduleRuleKind } from '@alto-people/shared';
import { prisma as defaultPrisma } from '../db.js';
import { enqueueAudit } from './audit.js';
import { notifyUser } from './notify.js';
import { getCurrentPeriod, windowBetween, type PeriodWindow, type ScheduleInput } from './payrollSchedule.js';
export { inWindows, workDayOf } from './payrollSchedule.js';
import { rolesHolding } from './approvalPolicy.js';
import { runWithTenant, tenantIdForWrite } from './tenant.js';
import { setScheduleRecomputeHandler, type ScheduleTrigger } from './payScheduleTriggers.js';

/**
 * Who is paid on which pay schedule, and from when.
 *
 * RULES decide membership: a whole client, a site, a department, a pay
 * type, an individual, or an exclusion, each from a date. The most specific
 * rule wins (individual › site › department › client › pay type), the
 * company default catches everyone else, and two different schedules
 * claiming someone just as specifically is a conflict a person decides
 * (the current assignment stands meanwhile).
 *
 * ASSIGNMENTS are what the rules produce, effective-dated and never
 * overlapping: a payroll run pays exactly the people on its schedule for
 * the days they were on it, so a move mid-period splits the pay cleanly.
 *
 * Moves start at a period boundary of the NEW schedule. An automatic move
 * (a hire, a transfer, a department or pay-type change, the nightly sweep)
 * starts at the new schedule's next pay period on or after today — the
 * owner's rule — and payroll gets a notice. A move someone makes by hand in
 * the builder starts on the date they chose (default: the schedule's next
 * period start) and sends no notice.
 *
 * Associate.payrollScheduleId mirrors the assignment in force today;
 * older code (frequency for withholding, counts) still reads it.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY = 86_400_000;

/* ---- Dates ---------------------------------------------------------------- */

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const dateOnly = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
export const addDaysYmd = (s: string, n: number): string => ymd(new Date(dateOnly(s).getTime() + n * DAY));
export const todayYmd = (now: Date = new Date()): string => ymd(now);

/* ---- Patterns and periods (version-aware) ---------------------------------- */

export interface ScheduleWithVersions {
  id: string;
  name: string;
  frequency: PayrollFrequency;
  anchorDate: Date;
  payDateOffsetDays: number;
  isActive?: boolean;
  isDefault?: boolean;
  deletedAt?: Date | null;
  versions?: Array<{ effectiveFrom: Date; frequency: PayrollFrequency; anchorDate: Date; payDateOffsetDays: number }>;
}

/** The pattern in force on a date: the latest version starting on or before it, else the schedule's own fields. */
export function patternOn(s: ScheduleWithVersions, on: string): ScheduleInput {
  const vs = [...(s.versions ?? [])].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  const v = vs.find((x) => ymd(x.effectiveFrom) <= on);
  if (v) return { frequency: v.frequency, anchorDate: v.anchorDate, payDateOffsetDays: v.payDateOffsetDays };
  // Before the first version: the earliest version's pattern (history starts there).
  const first = vs[vs.length - 1];
  if (first) return { frequency: first.frequency, anchorDate: first.anchorDate, payDateOffsetDays: first.payDateOffsetDays };
  return { frequency: s.frequency, anchorDate: s.anchorDate, payDateOffsetDays: s.payDateOffsetDays };
}

/**
 * The period of `s` containing `on`. A period never reaches back across a
 * pattern change nor past the next one: where the new pattern's periods
 * don't line up with the change (every other week → twice a month from a
 * Saturday), the days between are one short BRIDGE period under the new
 * pattern, so no day is paid twice or not at all.
 */
export function periodContaining(s: ScheduleWithVersions, on: string): PeriodWindow & { bridge?: boolean } {
  const pattern = patternOn(s, on);
  const p = getCurrentPeriod(pattern, dateOnly(on));
  // The first version is where history starts, not a change.
  const changes = (s.versions ?? []).map((v) => ymd(v.effectiveFrom)).sort().slice(1);
  const began = changes.filter((d) => d <= on).pop();
  const ends = changes.find((d) => d > on);
  const start = began && p.periodStart < began ? began : p.periodStart;
  const end = ends && p.periodEnd >= ends ? addDaysYmd(ends, -1) : p.periodEnd;
  if (start === p.periodStart && end === p.periodEnd) return p;
  const w = end === p.periodEnd ? { ...p, periodStart: start } : windowBetween(start, end, pattern.payDateOffsetDays);
  return { ...w, bridge: true };
}

/** The period paid next on or after `today` (pay lands after a period ends, so often the one just over). */
export function nextPaydayOn(s: ScheduleWithVersions, today: string = todayYmd()): PeriodWindow & { bridge?: boolean } {
  const cur = periodContaining(s, today);
  const prev = periodContaining(s, addDaysYmd(cur.periodStart, -1));
  return prev.payDate >= today ? prev : cur;
}

/** The period right after `w` on `s`. */
export function periodAfter(s: ScheduleWithVersions, w: PeriodWindow): PeriodWindow & { bridge?: boolean } {
  return periodContaining(s, addDaysYmd(w.periodEnd, 1));
}

/** The first day of a period of `s` on or after `on` (on itself when it starts one). */
export function periodStartOnOrAfter(s: ScheduleWithVersions, on: string): string {
  const p = periodContaining(s, on);
  return p.periodStart === on ? on : addDaysYmd(p.periodEnd, 1);
}

/** Periods of `s` from the one containing `from`, `count` of them. */
export function periodsFrom(s: ScheduleWithVersions, from: string, count: number): PeriodWindow[] {
  const out: PeriodWindow[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const p = periodContaining(s, cursor);
    out.push(p);
    cursor = addDaysYmd(p.periodEnd, 1);
  }
  return out;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** "Every other week, Saturday to Friday, paid the next Friday" — the pattern in words. */
export function patternSentence(p: { frequency: PayrollFrequency; anchorDate: Date | string; payDateOffsetDays: number }): string {
  const anchor = typeof p.anchorDate === 'string' ? dateOnly(p.anchorDate) : p.anchorDate;
  const startDow = anchor.getUTCDay();
  const off = p.payDateOffsetDays;
  const paid = (len: number) => {
    const endDow = (startDow + len - 1) % 7;
    const payDow = (endDow + off) % 7;
    if (off === 0) return 'paid the same day';
    if (off === 7) return `paid the ${WEEKDAY[payDow]} a week later`;
    if (off < 7) return `paid the next ${WEEKDAY[payDow]}`;
    return `paid ${off} days later (${WEEKDAY[payDow]})`;
  };
  switch (p.frequency) {
    case 'WEEKLY':
      return `Every week, ${WEEKDAY[startDow]} to ${WEEKDAY[(startDow + 6) % 7]}, ${paid(7)}`;
    case 'BIWEEKLY':
      return `Every other week, ${WEEKDAY[startDow]} to ${WEEKDAY[(startDow + 6) % 7]}, ${paid(14)}`;
    case 'SEMIMONTHLY':
      return `Twice a month, the 1st–15th and 16th–end, paid ${off === 0 ? 'the same day' : `${off} day${off === 1 ? '' : 's'} after`}`;
    case 'MONTHLY':
      return off === 0 ? 'Monthly, paid on the last day of the month' : `Monthly, paid on the ${ordinal(off)} of the next month`;
    case 'DAILY':
      return 'Daily, paid the next morning';
  }
}

/* ---- Rules and facts -------------------------------------------------------- */

export interface RuleRow {
  id: string;
  scheduleId: string;
  kind: string;
  clientId: string | null;
  siteId: string | null;
  departmentId: string | null;
  payType: string | null;
  associateId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface PersonFacts {
  associateId: string;
  name: string;
  clientId: string | null;
  siteId: string | null;
  departmentId: string | null;
  payType: 'HOURLY' | 'SALARY' | null;
  /** Legacy: on a schedule (the mirror) with no assignment history at all. */
  legacyScheduleId: string | null;
}

export const ruleInForce = (r: { effectiveFrom: Date; effectiveTo: Date | null }, on: string) => ymd(r.effectiveFrom) <= on && (!r.effectiveTo || ymd(r.effectiveTo) >= on);

export function ruleMatches(r: RuleRow, f: PersonFacts): boolean {
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

export interface Desired {
  scheduleId: string | null;
  ruleId: string | null;
  kind: ScheduleRuleKind | 'DEFAULT' | 'LEGACY' | null;
  /** A conflict between schedules claiming the person just as specifically. */
  conflict: string | null;
}

/**
 * The schedule the rules choose for a person on a date. Pure: the caller
 * passes the rules (possibly with proposed changes for a preview).
 */
export function desiredFor(f: PersonFacts, rules: RuleRow[], on: string, opts: { defaultScheduleId: string | null; activeScheduleIds: Set<string>; scheduleNames?: Map<string, string> }): Desired {
  const live = rules.filter((r) => ruleInForce(r, on) && opts.activeScheduleIds.has(r.scheduleId) && ruleMatches(r, f));
  const excluded = new Set(live.filter((r) => r.kind === 'EXCLUDE').map((r) => r.scheduleId));
  const claims = live.filter((r) => r.kind !== 'EXCLUDE' && !excluded.has(r.scheduleId));
  if (claims.length === 0) {
    if (opts.defaultScheduleId && !excluded.has(opts.defaultScheduleId)) return { scheduleId: opts.defaultScheduleId, ruleId: null, kind: 'DEFAULT', conflict: null };
    if (f.legacyScheduleId) return { scheduleId: f.legacyScheduleId, ruleId: null, kind: 'LEGACY', conflict: null };
    return { scheduleId: null, ruleId: null, kind: null, conflict: null };
  }
  const spec = (r: RuleRow) => RULE_SPECIFICITY[r.kind as Exclude<ScheduleRuleKind, 'EXCLUDE'>] ?? 0;
  const top = Math.max(...claims.map(spec));
  const best = claims.filter((r) => spec(r) === top);
  const schedules = [...new Set(best.map((r) => r.scheduleId))];
  if (schedules.length > 1) {
    const names = schedules.map((id) => opts.scheduleNames?.get(id) ?? 'another schedule');
    return { scheduleId: null, ruleId: null, kind: null, conflict: `${names.join(' and ')} both claim this person (${(best[0]!.kind as string).toLowerCase()} rules)` };
  }
  const winner = best.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0]!;
  return { scheduleId: winner.scheduleId, ruleId: winner.id, kind: winner.kind as ScheduleRuleKind, conflict: null };
}

/** "Client: Coastal Resort Holdings", "Individual", "Company default". */
export function becauseLabel(d: Desired, rules: RuleRow[], names: { clients: Map<string, string>; sites: Map<string, string>; departments: Map<string, string> }): string {
  if (d.kind === 'DEFAULT') return 'Company default';
  if (d.kind === 'LEGACY') return 'Assigned earlier';
  const r = rules.find((x) => x.id === d.ruleId);
  if (!r) return d.conflict ?? 'No schedule';
  switch (r.kind) {
    case 'INDIVIDUAL':
      return 'Individual';
    case 'SITE':
      return `Site: ${names.sites.get(r.siteId ?? '') ?? 'a site'}`;
    case 'DEPARTMENT':
      return `Department: ${names.departments.get(r.departmentId ?? '') ?? 'a department'}`;
    case 'CLIENT':
      return `Client: ${names.clients.get(r.clientId ?? '') ?? 'a client'}`;
    case 'PAY_TYPE':
      return r.payType === 'SALARY' ? 'Salaried staff' : 'Hourly staff';
    default:
      return 'Rule';
  }
}

/** Everything the resolver needs about the tenant, loaded once. */
export interface World {
  tenantId: string;
  rules: RuleRow[];
  schedules: Map<string, ScheduleWithVersions>;
  activeScheduleIds: Set<string>;
  defaultScheduleId: string | null;
  names: { clients: Map<string, string>; sites: Map<string, string>; departments: Map<string, string>; schedules: Map<string, string> };
}

export async function loadWorld(db: Db): Promise<World> {
  const tenantId = tenantIdForWrite();
  const [rules, schedules] = await Promise.all([
    db.payrollScheduleRule.findMany({ where: { tenantId } }),
    db.payrollSchedule.findMany({ where: { tenantId }, include: { versions: true } }),
  ]);
  const clientIds = [...new Set(rules.map((r) => r.clientId).filter((x): x is string => !!x))];
  const siteIds = [...new Set(rules.map((r) => r.siteId).filter((x): x is string => !!x))];
  const depIds = [...new Set(rules.map((r) => r.departmentId).filter((x): x is string => !!x))];
  const [clients, sites, deps] = await Promise.all([
    clientIds.length ? db.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    siteIds.length ? db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } }) : [],
    depIds.length ? db.department.findMany({ where: { id: { in: depIds } }, select: { id: true, name: true } }) : [],
  ]);
  const active = schedules.filter((s) => s.isActive && !s.deletedAt);
  return {
    tenantId,
    rules,
    schedules: new Map(schedules.map((s) => [s.id, s])),
    activeScheduleIds: new Set(active.map((s) => s.id)),
    defaultScheduleId: active.find((s) => s.isDefault)?.id ?? null,
    names: {
      clients: new Map(clients.map((c) => [c.id, c.name])),
      sites: new Map(sites.map((c) => [c.id, c.name])),
      departments: new Map(deps.map((c) => [c.id, c.name])),
      schedules: new Map(schedules.map((s) => [s.id, s.name])),
    },
  };
}

/**
 * The facts the rules read, for a set of people (or everyone not gone).
 * Client: the open placement's client, else the approved application's.
 */
export async function loadFacts(db: Db, ids: string[] | 'all', on: string = todayYmd()): Promise<Map<string, PersonFacts>> {
  const tenantId = tenantIdForWrite();
  const onDate = dateOnly(on);
  const people = await db.associate.findMany({
    where: { tenantId, deletedAt: null, ...(ids === 'all' ? { separatedAt: null } : { id: { in: ids } }) },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      departmentId: true,
      payrollScheduleId: true,
      assignments: {
        where: { startedAt: { lte: onDate }, OR: [{ endedAt: null }, { endedAt: { gte: onDate } }] },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: { locationId: true, location: { select: { clientId: true } } },
      },
      applications: { where: { status: 'APPROVED', deletedAt: null }, orderBy: { updatedAt: 'desc' }, take: 1, select: { clientId: true } },
      compRecords: { where: { effectiveFrom: { lte: new Date(onDate.getTime() + DAY) } }, orderBy: { effectiveFrom: 'desc' }, take: 1, select: { payType: true } },
      _count: { select: { payScheduleAssignments: true } },
    },
  });
  const out = new Map<string, PersonFacts>();
  for (const p of people) {
    const a = p.assignments[0];
    out.set(p.id, {
      associateId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      siteId: a?.locationId ?? null,
      clientId: a?.location.clientId ?? p.applications[0]?.clientId ?? null,
      departmentId: p.departmentId,
      payType: (p.compRecords[0]?.payType as 'HOURLY' | 'SALARY' | undefined) ?? null,
      legacyScheduleId: p._count.payScheduleAssignments === 0 ? p.payrollScheduleId : null,
    });
  }
  return out;
}

/* ---- Materializing assignments -------------------------------------------- */

export interface Move {
  associateId: string;
  name: string;
  fromScheduleId: string | null;
  toScheduleId: string | null;
  effectiveFrom: string;
  because: string;
  conflict: string | null;
}

export interface AssignmentRow {
  id: string;
  associateId: string;
  scheduleId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
}

/** The person's schedule over time from today, as the rules have it: [start, scheduleId, desired]. */
function desiredTimeline(f: PersonFacts, w: World, today: string): Array<{ from: string; d: Desired }> {
  const points = new Set<string>([today]);
  for (const r of w.rules) {
    if (!ruleMatches(r, f)) continue;
    const from = ymd(r.effectiveFrom);
    if (from > today) points.add(from);
    if (r.effectiveTo) {
      const after = addDaysYmd(ymd(r.effectiveTo), 1);
      if (after > today) points.add(after);
    }
  }
  const out: Array<{ from: string; d: Desired }> = [];
  for (const p of [...points].sort()) {
    const d = desiredFor(f, w.rules, p, { defaultScheduleId: w.defaultScheduleId, activeScheduleIds: w.activeScheduleIds, scheduleNames: w.names.schedules });
    const last = out[out.length - 1];
    if (last && last.d.scheduleId === d.scheduleId && !d.conflict) continue;
    out.push({ from: p, d });
  }
  return out;
}

const sourceFor = (kind: Desired['kind'], trigger: ScheduleTrigger): string =>
  kind === 'INDIVIDUAL' ? 'INDIVIDUAL' : kind === 'DEFAULT' ? 'DEFAULT' : kind === 'LEGACY' ? 'MIGRATION' : trigger === 'TRANSFER' ? 'TRANSFER' : trigger === 'MANUAL' ? 'MOVE' : 'RULE';

export interface PlannedSegment {
  from: string;
  scheduleId: string | null;
  d: Desired;
}

/**
 * What a person's assignments should be from today on, given the rules
 * (pure — a preview passes proposed rules in `w`). Each segment is a move
 * away from what they hold.
 *
 * Automatic triggers start a move at the new schedule's next period start
 * on or after the day the rules change. A change made by hand (MANUAL /
 * RULE) starts exactly on the rule's date. A person on no schedule at all
 * (a new hire) starts with the period that's running, so it's paid.
 */
export function planFor(f: PersonFacts, rows: AssignmentRow[], w: World, today: string, trigger: ScheduleTrigger): { current: AssignmentRow | null; plan: PlannedSegment[]; conflicts: string[] } {
  const current = rows.find((a) => ymd(a.effectiveFrom) <= today && (!a.effectiveTo || ymd(a.effectiveTo) >= today)) ?? null;
  const timeline = desiredTimeline(f, w, today);
  const byHand = trigger === 'MANUAL' || trigger === 'RULE';
  const plan: PlannedSegment[] = [];
  const conflicts: string[] = [];
  let holding: string | null = current?.scheduleId ?? null;
  for (const seg of timeline) {
    if (seg.d.conflict) {
      conflicts.push(seg.d.conflict);
      continue; // keep whatever is planned before it
    }
    const target = seg.d.scheduleId;
    if (target === holding) continue;
    let from = seg.from;
    if (target) {
      const s = w.schedules.get(target)!;
      const rule = seg.d.ruleId ? w.rules.find((r) => r.id === seg.d.ruleId) : undefined;
      const datedToday = !!rule && ymd(rule.effectiveFrom) === today;
      if (!current && plan.length === 0 && seg.from === today) {
        // On no schedule today (a new hire, a rehire): from the period that's
        // running, so its days are paid — never before their last day on another.
        const lastEnd = rows.map((a) => (a.effectiveTo ? ymd(a.effectiveTo) : '')).filter((e) => e && e < today).sort().pop();
        const periodStart = periodContaining(s, today).periodStart;
        from = lastEnd && addDaysYmd(lastEnd, 1) > periodStart ? addDaysYmd(lastEnd, 1) : periodStart;
      } else if (byHand && (seg.from > today || datedToday)) {
        from = seg.from;
      } else {
        from = periodStartOnOrAfter(s, seg.from);
      }
    }
    plan.push({ from, scheduleId: target, d: seg.d });
    holding = target;
  }
  return { current, plan, conflicts };
}

/** The writes are the same plan whatever asked for them; nothing to write when it's already so. */
function planIsWritten(current: AssignmentRow | null, rows: AssignmentRow[], plan: PlannedSegment[], today: string): boolean {
  const future = rows.filter((a) => ymd(a.effectiveFrom) > today);
  const already = future.map((a) => `${ymd(a.effectiveFrom)}|${a.scheduleId}`).join(',');
  const wanted = plan.filter((p) => p.scheduleId && p.from > today).map((p) => `${p.from}|${p.scheduleId}`).join(',');
  if (already !== wanted) return false;
  const first = plan[0]!;
  if (first.from <= today) return false;
  if (!current) return true;
  return current.effectiveTo ? ymd(current.effectiveTo) === addDaysYmd(first.from, -1) : false;
}

export async function loadAssignments(db: Db, personIds: string[]): Promise<Map<string, AssignmentRow[]>> {
  const existing = (await db.payrollScheduleAssignment.findMany({
    where: { associateId: { in: personIds } },
    orderBy: { effectiveFrom: 'asc' },
    select: { id: true, associateId: true, scheduleId: true, effectiveFrom: true, effectiveTo: true, source: true },
  })) as AssignmentRow[];
  const byPerson = new Map<string, AssignmentRow[]>();
  for (const a of existing) byPerson.set(a.associateId, [...(byPerson.get(a.associateId) ?? []), a]);
  return byPerson;
}

/**
 * Bring each person's assignments in line with the rules from today on.
 * Past assignments are never touched; the one in force today ends the day
 * before a move; future ones are rewritten. Returns the moves made.
 */
export async function materialize(db: PrismaClient, ids: string[] | 'all', opts: { trigger: ScheduleTrigger; actorUserId?: string | null; now?: Date; world?: World }): Promise<{ moves: Move[]; conflicts: Array<{ associateId: string; name: string; conflict: string }> }> {
  const today = todayYmd(opts.now);
  const w = opts.world ?? (await loadWorld(db));
  const facts = await loadFacts(db, ids, today);
  const personIds = [...facts.keys()];
  if (personIds.length === 0) return { moves: [], conflicts: [] };
  const byPerson = await loadAssignments(db, personIds);

  const moves: Move[] = [];
  const conflicts: Array<{ associateId: string; name: string; conflict: string }> = [];
  for (const f of facts.values()) {
    const rows = byPerson.get(f.associateId) ?? [];
    const { current, plan, conflicts: cs } = planFor(f, rows, w, today, opts.trigger);
    for (const c of cs) conflicts.push({ associateId: f.associateId, name: f.name, conflict: c });
    if (plan.length === 0) {
      // They stay where they are: drop a move planned earlier that the rules no longer want.
      const stale = rows.filter((a) => ymd(a.effectiveFrom) > today);
      const reopen = current?.effectiveTo ? current : null;
      if (stale.length || reopen) {
        await db.$transaction(async (tx) => {
          if (stale.length) await tx.payrollScheduleAssignment.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } });
          if (reopen) await tx.payrollScheduleAssignment.update({ where: { id: reopen.id }, data: { effectiveTo: null } });
        });
        moves.push({ associateId: f.associateId, name: f.name, fromScheduleId: stale[0]?.scheduleId ?? null, toScheduleId: current?.scheduleId ?? null, effectiveFrom: stale[0] ? ymd(stale[0].effectiveFrom) : today, because: 'Planned move cancelled', conflict: null });
      }
      continue;
    }
    if (planIsWritten(current, rows, plan, today)) continue;

    await db.$transaction(async (tx) => {
      const first = plan[0]!;
      // Rewrite everything from the first change on (past rows stay).
      const later = rows.filter((a) => a.id !== current?.id && ymd(a.effectiveFrom) >= (first.from < today ? first.from : addDaysYmd(today, 1)));
      if (later.length) await tx.payrollScheduleAssignment.deleteMany({ where: { id: { in: later.map((a) => a.id) } } });
      if (current) {
        if (first.from <= ymd(current.effectiveFrom)) {
          // Starts the same day the current one did (a same-day correction): replace it.
          await tx.payrollScheduleAssignment.delete({ where: { id: current.id } });
        } else {
          await tx.payrollScheduleAssignment.update({ where: { id: current.id }, data: { effectiveTo: dateOnly(addDaysYmd(first.from, -1)) } });
        }
      }
      for (let i = 0; i < plan.length; i++) {
        const seg = plan[i]!;
        if (!seg.scheduleId) continue;
        const next = plan[i + 1];
        await tx.payrollScheduleAssignment.create({
          data: {
            tenantId: w.tenantId,
            associateId: f.associateId,
            scheduleId: seg.scheduleId,
            effectiveFrom: dateOnly(seg.from),
            effectiveTo: next ? dateOnly(addDaysYmd(next.from, -1)) : null,
            source: sourceFor(seg.d.kind, opts.trigger),
            ruleId: seg.d.ruleId,
            reason: becauseLabel(seg.d, w.rules, w.names).slice(0, 300),
            createdById: opts.actorUserId ?? null,
          },
        });
      }
    });
    let from = current?.scheduleId ?? null;
    for (const seg of plan) {
      moves.push({ associateId: f.associateId, name: f.name, fromScheduleId: from, toScheduleId: seg.scheduleId, effectiveFrom: seg.from, because: becauseLabel(seg.d, w.rules, w.names), conflict: null });
      from = seg.scheduleId;
    }
  }
  await syncMirror(db, moves.map((m) => m.associateId), today);
  return { moves, conflicts };
}

/** Associate.payrollScheduleId = the assignment in force today (older readers use it). */
export async function syncMirror(db: Db, ids: string[] | 'all', today: string = todayYmd()): Promise<number> {
  const tenantId = tenantIdForWrite();
  const where: Prisma.PayrollScheduleAssignmentWhereInput = {
    tenantId,
    effectiveFrom: { lte: dateOnly(today) },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(today) } }],
    ...(ids === 'all' ? {} : { associateId: { in: ids } }),
  };
  if (ids !== 'all' && ids.length === 0) return 0;
  const inForce = await db.payrollScheduleAssignment.findMany({ where, select: { associateId: true, scheduleId: true } });
  const want = new Map(inForce.map((a) => [a.associateId, a.scheduleId]));
  const people = await db.associate.findMany({
    where: { tenantId, ...(ids === 'all' ? { payScheduleAssignments: { some: {} } } : { id: { in: ids } }) },
    select: { id: true, payrollScheduleId: true, _count: { select: { payScheduleAssignments: true } } },
  });
  let changed = 0;
  for (const p of people) {
    if (p._count.payScheduleAssignments === 0) continue; // legacy: leave the mirror alone
    const target = want.get(p.id) ?? null;
    if (p.payrollScheduleId !== target) {
      await db.associate.update({ where: { id: p.id }, data: { payrollScheduleId: target } });
      changed += 1;
    }
  }
  return changed;
}

/* ---- Automatic moves: the notice to payroll -------------------------------- */

export async function recompute(db: PrismaClient, ids: string[] | 'all', trigger: ScheduleTrigger, opts: { actorUserId?: string | null; now?: Date } = {}): Promise<{ moves: Move[]; conflicts: number }> {
  const world = await loadWorld(db);
  const { moves, conflicts } = await materialize(db, ids, { trigger, world, ...opts });
  const automatic = trigger !== 'MANUAL' && trigger !== 'RULE';
  for (const m of moves) {
    enqueueAudit(
      {
        actorUserId: opts.actorUserId ?? null,
        clientId: null,
        action: automatic ? 'payroll.schedule.auto_move' : 'payroll.schedule.move',
        entityType: 'Associate',
        entityId: m.associateId,
        metadata: { name: m.name, from: m.fromScheduleId, to: m.toScheduleId, effectiveFrom: m.effectiveFrom, because: m.because, trigger },
      },
      'paySchedules.recompute',
    );
  }
  if (automatic && moves.length > 0) await noticeToPayroll(db, world, moves, trigger);
  return { moves, conflicts: conflicts.length };
}

const TRIGGER_WORDS: Record<ScheduleTrigger, string> = {
  HIRE: 'hired',
  TRANSFER: 'transferred',
  DEPARTMENT: 'changed department',
  PAY_TYPE: 'changed pay type',
  NIGHTLY: 'their placement changed',
  RULE: 'a rule changed',
  MANUAL: 'moved by hand',
};

async function noticeToPayroll(db: Db, w: World, moves: Move[], trigger: ScheduleTrigger): Promise<void> {
  const fmtDay = (s: string) => dateOnly(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const name = (id: string | null) => (id ? (w.names.schedules.get(id) ?? 'a schedule') : 'no schedule');
  // "Ana Worker — Weekly → Biweekly from Oct 31 (transferred; Ana works for Seaside Inn)"
  const lines = moves.slice(0, 8).map((m) => `${m.name} — ${name(m.fromScheduleId)} → ${name(m.toScheduleId)} from ${fmtDay(m.effectiveFrom)} (${TRIGGER_WORDS[trigger]}; ${becauseSentence(m.because, m.name.split(' ')[0])})`);
  const more = moves.length > 8 ? `\n…and ${moves.length - 8} more.` : '';
  const target = moves.find((m) => m.toScheduleId)?.toScheduleId;
  const roles = rolesHolding('process:payroll');
  const users = await db.user.findMany({ where: { tenantId: w.tenantId, status: 'ACTIVE', deletedAt: null, role: { in: roles } }, select: { id: true }, take: 50 });
  for (const u of users) {
    void notifyUser(u.id, {
      subject: `${moves.length} ${moves.length === 1 ? 'person moves' : 'people move'} pay schedules`,
      body: `${lines.join('\n')}${more}\nEach move starts with the new schedule's next pay period.`,
      category: 'payroll',
      linkUrl: target ? `/payroll/schedules/${target}` : '/payroll/schedules',
    });
  }
}

/** Whether the tenant decides membership by rules (any rule or a company default) rather than the old per-person picker. */
export async function tenantUsesScheduleRules(db: Db, tenantId: string = tenantIdForWrite()): Promise<boolean> {
  const [rules, dflt] = await Promise.all([
    db.payrollScheduleRule.count({ where: { tenantId } }),
    db.payrollSchedule.count({ where: { tenantId, isDefault: true, deletedAt: null } }),
  ]);
  return rules > 0 || dflt > 0;
}

// The database client queues people whose placement, department or pay type
// changed; this runs them (lib/payScheduleTriggers).
setScheduleRecomputeHandler(async (tenantId, associateIds, trigger) => {
  await runWithTenant(tenantId, 'job', async () => {
    const { prisma } = await import('../db.js');
    // A tenant with no rules and no default has nothing to recompute.
    if (!(await tenantUsesScheduleRules(prisma, tenantId))) return;
    await recompute(prisma, associateIds, trigger);
  });
});

/**
 * The sweep, for the tenant in context: everyone against the rules (a
 * placement that changed outside the API, a rule whose date arrived), and
 * the mirror flipped for moves that start today. Idempotent.
 */
export async function sweepTenantSchedules(db: PrismaClient = defaultPrisma): Promise<{ moves: number }> {
  let moves = 0;
  await rollPatternsForward(db);
  if (await tenantUsesScheduleRules(db)) moves = (await recompute(db, 'all', 'NIGHTLY')).moves.length;
  await syncMirror(db, 'all');
  return { moves };
}

/** A pattern change whose day has come: the schedule's own fields (which older readers use) take it. */
export async function rollPatternsForward(db: Db, today: string = todayYmd()): Promise<number> {
  const schedules = await db.payrollSchedule.findMany({ where: { tenantId: tenantIdForWrite(), deletedAt: null, versions: { some: {} } }, include: { versions: true } });
  let changed = 0;
  for (const s of schedules) {
    const p = patternOn(s, today);
    const anchor = typeof p.anchorDate === 'string' ? dateOnly(p.anchorDate) : p.anchorDate;
    if (p.frequency !== s.frequency || ymd(anchor) !== ymd(s.anchorDate) || p.payDateOffsetDays !== s.payDateOffsetDays) {
      await db.payrollSchedule.update({ where: { id: s.id }, data: { frequency: p.frequency, anchorDate: anchor, payDateOffsetDays: p.payDateOffsetDays } });
      changed += 1;
    }
  }
  return changed;
}

/** The sweep across every tenant (tests and one-off scripts; the server uses runForEachTenant). */
export async function nightlyScheduleSweep(db: PrismaClient = defaultPrisma): Promise<{ moves: number }> {
  const tenants = await db.tenant.findMany({ select: { id: true } });
  let total = 0;
  for (const t of tenants) {
    await runWithTenant(t.id, 'job', async () => {
      total += (await sweepTenantSchedules(db)).moves;
    });
  }
  return { moves: total };
}

/* ---- Windows for payroll runs ---------------------------------------------- */

export interface Window {
  start: string;
  end: string;
}

/**
 * Who a run on `scheduleId` pays for `from`..`to` (inclusive): each person's
 * days on the schedule inside the period. People on the schedule only by
 * the legacy mirror (no assignment history) are on it for the whole period.
 */
export async function membershipWindows(db: Db, scheduleId: string, from: string, to: string): Promise<Map<string, Window[]>> {
  return (await membershipWindowsFor(db, [{ scheduleId, from, to }])).get(scheduleId)!;
}

/**
 * membershipWindows for several schedules (one range each) in two queries,
 * however many schedules there are. Asked one schedule at a time it was the
 * /me/inbox N+1 (Sentry ALTO-PEOPLE-API-13): two queries per schedule, 16
 * for eight schedules, about 2 s of a 3.5 s request behind every nav badge.
 */
export async function membershipWindowsFor(db: Db, ranges: ReadonlyArray<{ scheduleId: string; from: string; to: string }>): Promise<Map<string, Map<string, Window[]>>> {
  const out = new Map<string, Map<string, Window[]>>(ranges.map((r) => [r.scheduleId, new Map()]));
  if (ranges.length === 0) return out;
  const byId = new Map(ranges.map((r) => [r.scheduleId, r]));
  const ids = [...byId.keys()];
  const minFrom = ranges.reduce((m, r) => (r.from < m ? r.from : m), ranges[0]!.from);
  const maxTo = ranges.reduce((m, r) => (r.to > m ? r.to : m), ranges[0]!.to);
  const [rows, legacy] = await Promise.all([
    db.payrollScheduleAssignment.findMany({
      where: { scheduleId: { in: ids }, effectiveFrom: { lte: dateOnly(maxTo) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(minFrom) } }] },
      select: { scheduleId: true, associateId: true, effectiveFrom: true, effectiveTo: true },
    }),
    db.associate.findMany({
      where: { payrollScheduleId: { in: ids }, deletedAt: null, payScheduleAssignments: { none: {} } },
      select: { id: true, payrollScheduleId: true },
    }),
  ]);
  for (const r of rows) {
    const { from, to } = byId.get(r.scheduleId)!;
    const start = ymd(r.effectiveFrom) > from ? ymd(r.effectiveFrom) : from;
    const end = r.effectiveTo && ymd(r.effectiveTo) < to ? ymd(r.effectiveTo) : to;
    if (start > end) continue;
    const m = out.get(r.scheduleId)!;
    m.set(r.associateId, [...(m.get(r.associateId) ?? []), { start, end }]);
  }
  for (const l of legacy) {
    const range = byId.get(l.payrollScheduleId!)!;
    const m = out.get(range.scheduleId)!;
    if (!m.has(l.id)) m.set(l.id, [{ start: range.from, end: range.to }]);
  }
  return out;
}

/** People with approved time in the period who are on no schedule for those days. */
export async function unscheduledWithTime(db: Db, from: string, to: string, clientId: string | null): Promise<Array<{ associateId: string; name: string }>> {
  const entries = await db.timeEntry.findMany({
    where: { status: 'APPROVED', clockInAt: { gte: dateOnly(from), lt: dateOnly(addDaysYmd(to, 1)) }, ...(clientId ? { clientId } : {}) },
    select: { associateId: true, associate: { select: { firstName: true, lastName: true, payrollScheduleId: true } } },
    distinct: ['associateId'],
  });
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.associateId);
  // Covered by the one membership rule (scheduleMembershipFor below): an
  // assignment on a live schedule overlapping the days, or — no assignment
  // history — the legacy mirror on a live schedule.
  const [covered, history, legacy] = await Promise.all([
    db.payrollScheduleAssignment.findMany({
      where: { associateId: { in: ids }, schedule: { isActive: true, deletedAt: null }, effectiveFrom: { lte: dateOnly(to) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(from) } }] },
      select: { associateId: true },
    }),
    db.payrollScheduleAssignment.groupBy({ by: ['associateId'], where: { associateId: { in: ids } }, _count: { _all: true } }),
    db.associate.findMany({ where: { id: { in: ids }, payrollSchedule: { is: { isActive: true, deletedAt: null } } }, select: { id: true } }),
  ]);
  const has = new Set(covered.map((c) => c.associateId));
  const withHistory = new Set(history.map((h) => h.associateId));
  for (const l of legacy) if (!withHistory.has(l.id)) has.add(l.id);
  return entries.filter((e) => !has.has(e.associateId)).map((e) => ({ associateId: e.associateId, name: `${e.associate.firstName} ${e.associate.lastName}` }));
}


/** The aggregator's filter for a run on one schedule: its people, their days, its pattern's frequency. */
export async function scheduleFilterFor(db: Db, scheduleId: string, periodStart: Date, periodEnd: Date): Promise<{ windows: Map<string, Window[]>; frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY' }> {
  const s = await db.payrollSchedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { versions: true } });
  const from = ymd(periodStart);
  const windows = await membershipWindows(db, scheduleId, from, ymd(periodEnd));
  const freq = patternOn(s, from).frequency;
  // DAILY's run of record is its weekly true-up, withheld as weekly.
  return { windows, frequency: freq === 'DAILY' ? 'WEEKLY' : freq };
}

/* ---- Membership: THE answer to "is this person on a pay schedule?" -------- */

/**
 * ONE DEFINITION OF "ON A PAY SCHEDULE" (Fortune 500 fix-up, SH-4).
 *
 *   A person is on schedule S from day D when an assignment row puts them
 *   on S for D (effectiveFrom ≤ D, and no effectiveTo or effectiveTo ≥ D),
 *   or — someone with no assignment history at all, from before rules —
 *   when the legacy mirror Associate.payrollScheduleId names S. S must be
 *   live (active, not deleted): a run is never made on a retired schedule.
 *
 *   That is exactly who a run on S pays (membershipWindows above), so every
 *   reader that asks "will a run pay them?" reads this and nothing else:
 *   the readiness grid's Schedule column, the pay schedules page's "on no
 *   schedule", the payroll home's blocker, the Inbox's count, and the
 *   associate's next payday. Before, readiness read the legacy column alone
 *   (22 missing), pay schedules read the assignments (10), and My pay fell
 *   back to the client's or the first org schedule — promising a payday no
 *   run would pay.
 *
 *   A move booked to start later (the owner's rule: automatic moves start at
 *   the new schedule's next period) counts: the person is on that schedule
 *   from its first day, and their first payday is that period's.
 *
 * Membership is computed from rules (lib/payScheduleMembership materialize);
 * nothing here writes it.
 */
export interface Membership {
  scheduleId: string;
  /** The first day the membership covers (in the past when in force; the booked start when later; 1970-01-01 for the legacy mirror). */
  from: string;
  /** True when it comes from the legacy per-person picker (no assignment history). */
  legacy: boolean;
}

const LIVE_SCHEDULE = { isActive: true, deletedAt: null } as const;

/** Each person's membership on `on` (or the next booked one); null for someone on no schedule. */
export async function scheduleMembershipFor(db: Db, associateIds: string[], on: string = todayYmd()): Promise<Map<string, Membership | null>> {
  const out = new Map<string, Membership | null>();
  if (associateIds.length === 0) return out;
  for (const id of associateIds) out.set(id, null);
  const BATCH = 10_000;
  for (let i = 0; i < associateIds.length; i += BATCH) {
    const ids = associateIds.slice(i, i + BATCH);
    const [rows, history, legacy] = await Promise.all([
      db.payrollScheduleAssignment.findMany({
        where: { associateId: { in: ids }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(on) } }], schedule: LIVE_SCHEDULE },
        orderBy: { effectiveFrom: 'asc' },
        select: { associateId: true, scheduleId: true, effectiveFrom: true },
      }),
      db.payrollScheduleAssignment.groupBy({ by: ['associateId'], where: { associateId: { in: ids } }, _count: { _all: true } }),
      db.associate.findMany({ where: { id: { in: ids }, payrollScheduleId: { not: null }, payrollSchedule: { is: LIVE_SCHEDULE } }, select: { id: true, payrollScheduleId: true } }),
    ]);
    for (const r of rows) {
      const cur = out.get(r.associateId);
      const from = ymd(r.effectiveFrom);
      // In force on `on` beats a booked one; among booked ones, the soonest.
      if (!cur || (from <= on && cur.from > on)) out.set(r.associateId, { scheduleId: r.scheduleId, from, legacy: false });
    }
    const hasHistory = new Set(history.map((h) => h.associateId));
    for (const l of legacy) {
      if (!hasHistory.has(l.id) && !out.get(l.id)) out.set(l.id, { scheduleId: l.payrollScheduleId!, from: '1970-01-01', legacy: true });
    }
  }
  return out;
}

/**
 * The same rule as a where clause: people NO live schedule covers on `on`
 * or later — for counts and lists that must match scheduleMembershipFor.
 */
export function onNoScheduleWhere(on: string = todayYmd()): Prisma.AssociateWhereInput {
  return {
    AND: [
      { payScheduleAssignments: { none: { schedule: LIVE_SCHEDULE, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateOnly(on) } }] } } },
      // …and not a legacy member (no history, the mirror names a live schedule).
      {
        OR: [
          { payScheduleAssignments: { some: {} } },
          { payrollScheduleId: null },
          { payrollSchedule: { is: { OR: [{ isActive: false }, { deletedAt: { not: null } }] } } },
        ],
      },
    ],
  };
}

/**
 * Who a payroll run is for: hired (an approved application or an open
 * placement) and employed (not deleted, separated or paused). The readiness
 * grid and the "on no schedule" counts read the same population, so the
 * Schedule column's misses are the pay schedules page's number.
 */
export const PAY_RUN_POPULATION_WHERE: Prisma.AssociateWhereInput = {
  AND: [
    { deletedAt: null, separatedAt: null, deactivatedAt: null },
    { OR: [{ applications: { some: { status: 'APPROVED', deletedAt: null } } }, { assignments: { some: { endedAt: null } } }] },
  ],
};
