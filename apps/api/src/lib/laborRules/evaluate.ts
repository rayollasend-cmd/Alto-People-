import type { MinorBand, ResolvedRules, Severity } from './params.js';
import { addDaysToKey } from '../timezone.js';

/**
 * Brief 2-2 step 1 — the evaluators (report §4.2). Pure: no database, no
 * clock, no settings. Callers hand in entries, the resolved rules for each,
 * and the workweek function; step 3 wires them beside today's code (shadow)
 * and step 4 switches pay, per tenant, after the owner signs.
 *
 *   evaluateTime     hour buckets (regular, overtime, double time) and
 *                    penalties (meal, rest, rest between shifts), each with
 *                    a reason line naming the rule set that produced it.
 *   evaluateSchedule warnings and blocks for a shift about to be scheduled:
 *                    overtime ahead, short rest, minors' limits, notice.
 *
 *   Paid time is today's (payroll.payableMs): clock span minus every break.
 *   Where no daily rule applies the weekly split is computed exactly as
 *   splitWeeklyOvertime does, so the Florida pack reproduces today's pay.
 */

export interface WorkBreak {
  type?: 'MEAL' | 'REST' | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface WorkEntry {
  id?: string;
  clockInAt: Date;
  clockOutAt: Date;
  breaks?: WorkBreak[];
  /** The site's zone: days, weeks and hour-of-day are the site's. */
  timezone: string;
  /** The person waived this day's meal, where the rules allow a waiver. */
  mealWaived?: boolean;
}

export interface Reasoned {
  reason: string;
}

export interface PenaltyOutcome extends Reasoned {
  kind: 'MEAL' | 'REST' | 'REST_BETWEEN_SHIFTS' | 'SPREAD_OF_HOURS' | 'SPLIT_SHIFT';
  /** The local work date it belongs to. */
  date: string;
  hours: number;
  /** A flat premium in cents, where the law sets one (NYC). */
  cents?: number;
  /** The hours are paid at this rate (cents an hour), not the person's (spread of hours: the minimum wage). */
  rateCents?: number;
  /** The premium shrinks by (person's rate − rateCents) × these hours, never below zero: what the day paid above the minimum (lib/laborRules/hours.penaltyAmount). */
  offsetHours?: number;
  entryId?: string;
  /** False until every set behind it is signed ACTIVE (decision 8): computed and shown, not paid. */
  payable: boolean;
}

export interface WeekOutcome {
  weekStart: string;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  reasons: string[];
}

export interface TimeOutcome {
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  /** The multipliers the buckets are paid at (most protective in the period). */
  overtimeMultiplier: number;
  doubleMultiplier: number;
  weeks: WeekOutcome[];
  penalties: PenaltyOutcome[];
  /** Every rule-set combination used, so an outcome says which versions produced it. */
  fingerprints: string[];
  /** Whether pay may use this outcome (every contributing set ACTIVE). */
  payable: boolean;
  /**
   * Where each entry's hours landed (unrounded): the week's or day's
   * buckets filled chronologically — regular first, then overtime, then
   * double time — so the overtime is always the latest hours worked. An
   * entry with no paid time has no allocation. The totals above are the
   * pay figures; these split them across entries for per-store, per-client
   * and per-day views that must add up to the same buckets.
   */
  allocations: Map<WorkEntry, EntryAllocation>;
}

export interface EntryAllocation {
  /** The local work date the entry counts on (its clock-in, in the site's zone). */
  date: string;
  workedHours: number;
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
}

export interface TimeContext {
  rulesFor: (e: WorkEntry, date: string) => ResolvedRules;
  /** The company week containing an instant, in the site's zone (lib/timeAnomalies.startOfWeekForSite). */
  weekStart: (d: Date, timezone: string) => Date;
}

const HOUR = 3_600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (h: number) => h.toFixed(2);

/** Local calendar date, hour and weekday of an instant in a zone. */
const partsFormats = new Map<string, Intl.DateTimeFormat>();

export function localParts(d: Date, timezone: string): { date: string; minutes: number; weekday: number } {
  // One formatter per zone: building one costs far more than formatting, and
  // estimators run this over tens of thousands of entries.
  let f = partsFormats.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    partsFormats.set(timezone, f);
  }
  const parts = f.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')), weekday };
}

/**
 * Paid milliseconds of an entry. With no short-break rule it is identical to
 * payroll.payableMs (every break docked); under one (federal: 20 minutes), a
 * break that short is worked time and is not docked.
 */
export function paidMs(e: WorkEntry, paidUpToMinutes: number | null = null): number {
  const end = e.clockOutAt.getTime();
  let ms = end - e.clockInAt.getTime();
  for (const b of e.breaks ?? []) {
    const bEnd = b.endedAt ? b.endedAt.getTime() : end;
    const len = Math.max(0, bEnd - b.startedAt.getTime());
    if (paidUpToMinutes !== null && len <= paidUpToMinutes * 60_000) continue;
    ms -= len;
  }
  return Math.max(0, ms);
}

const by = (r: ResolvedRules, field: string) => r.origin[field] ?? r.layers[r.layers.length - 1] ?? 'no rule set';

interface DayAgg {
  date: string;
  ms: number;
  rules: ResolvedRules;
  /** The day's entries and their paid ms, chronological. */
  parts: Array<{ e: WorkEntry; ms: number }>;
}

/**
 * Fill entries chronologically through the buckets, in order: regular,
 * overtime, double time. Every paid hour lands in exactly one bucket (float
 * dust past the last bucket stays with the bucket before it), so the
 * allocations always add up to the hours worked.
 */
function fill(parts: ReadonlyArray<{ e: WorkEntry; ms: number }>, date: string | ((e: WorkEntry) => string), reg: number, ot: number, dt: number, out: Map<WorkEntry, EntryAllocation>): void {
  let r = Math.max(0, reg);
  let o = Math.max(0, ot);
  for (const { e, ms } of parts) {
    const worked = ms / HOUR;
    let h = worked;
    let a = Math.min(h, r);
    r -= a;
    h -= a;
    let b = Math.min(h, o);
    o -= b;
    h -= b;
    let c = 0;
    if (dt > 0) c = h;
    else if (ot > 0) b += h;
    else a += h;
    out.set(e, { date: typeof date === 'string' ? date : date(e), workedHours: worked, regularHours: a, overtimeHours: b, doubleTimeHours: c });
  }
}

/**
 * A workweek's identity: the local date its first day starts on. Two sites
 * in different zones share a workweek when it starts on the same local date
 * (a Destin Monday and a Pensacola Friday of the same Saturday-start week),
 * so a person's hours at both count toward one 40 — keying by the UTC
 * instant of each zone's midnight split them into two weeks, each under 40.
 */
export function weekKeyOf(weekStart: Date, timezone: string): string {
  return localParts(weekStart, timezone).date;
}

export function evaluateTime(entries: readonly WorkEntry[], ctx: TimeContext): TimeOutcome {
  const closed = entries.filter((e) => e.clockOutAt && e.clockOutAt > e.clockInAt).slice().sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
  const weeks = new Map<string, { key: string; start: Date; days: Map<string, DayAgg>; ms: number; rules: ResolvedRules[]; parts: Array<{ e: WorkEntry; ms: number; date: string }> }>();
  const allocations = new Map<WorkEntry, EntryAllocation>();
  const fingerprints = new Set<string>();
  let payable = true;
  let otMult = 0;
  let dtMult = 0;

  const breakReasons: Array<{ weekKey: string; reason: string }> = [];
  for (const e of closed) {
    const { date } = localParts(e.clockInAt, e.timezone);
    const rules = ctx.rulesFor(e, date);
    const paidUpTo = rules.params.breaks?.paidUpToMinutes ?? null;
    const ms = paidMs(e, paidUpTo);
    if (ms <= 0) continue;
    const counted = ms - paidMs(e);
    if (counted > 0) breakReasons.push({ weekKey: weekKeyOf(ctx.weekStart(e.clockInAt, e.timezone), e.timezone), reason: `Short breaks counted as worked ${date}: ${Math.round(counted / 60_000)} min (≤ ${paidUpTo} min each), ${by(rules, 'breaks.paidUpToMinutes')}` });
    fingerprints.add(rules.fingerprint);
    payable &&= rules.payable;
    otMult = Math.max(otMult, rules.params.overtime?.weeklyMultiplier ?? 1.5, rules.params.overtime?.dailyThreshold != null ? (rules.params.overtime?.dailyMultiplier ?? 1.5) : 0);
    dtMult = Math.max(dtMult, rules.params.overtime?.doubleMultiplier ?? 2);
    const start = ctx.weekStart(e.clockInAt, e.timezone);
    const key = weekKeyOf(start, e.timezone);
    const w = weeks.get(key) ?? { key, start, days: new Map<string, DayAgg>(), ms: 0, rules: [], parts: [] };
    w.ms += ms;
    w.rules.push(rules);
    w.parts.push({ e, ms, date });
    const d = w.days.get(date) ?? { date, ms: 0, rules, parts: [] };
    d.ms += ms;
    d.parts.push({ e, ms });
    w.days.set(date, d);
    weeks.set(key, w);
  }

  const out: WeekOutcome[] = [];
  let reg = 0;
  let ot = 0;
  let dt = 0;
  for (const w of [...weeks.values()].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    // The week's weekly threshold: the most protective of the sets its hours were worked under.
    const weekly = w.rules.reduce<{ t: number | null; r: ResolvedRules | null }>((acc, r) => {
      const t = r.params.overtime?.weeklyThreshold ?? null;
      return t !== null && (acc.t === null || t < acc.t) ? { t, r } : acc;
    }, { t: null, r: null });
    const daily = w.rules.some((r) => r.params.overtime?.dailyThreshold != null || r.params.overtime?.dailyDoubleThreshold != null || r.params.overtime?.seventhDayRule);
    const reasons: string[] = breakReasons.filter((b) => b.weekKey === w.key).map((b) => b.reason);
    let wr = 0;
    let wo = 0;
    let wd = 0;

    if (!daily) {
      // Exactly splitWeeklyOvertime: the week's total, then the threshold.
      const h = w.ms / HOUR;
      if (weekly.t === null || h <= weekly.t) wr = h;
      else {
        wr = weekly.t;
        wo = h - weekly.t;
        reasons.push(`Overtime applied: ${fmt(h)} h > ${weekly.t} (weekly), ${by(weekly.r!, 'overtime.weeklyThreshold')}`);
      }
      const dateOf = new Map(w.parts.map((p) => [p.e, p.date]));
      fill(w.parts, (e) => dateOf.get(e)!, wr, wo, 0, allocations);
    } else {
      // Day by day (the California method): daily overtime and double time first, then the weekly
      // threshold converts regular hours past it, so no hour is counted twice.
      const days = [...w.days.values()].sort((a, b) => a.date.localeCompare(b.date));
      const seventh = days.length === 7;
      days.forEach((d, i) => {
        const o = d.rules.params.overtime ?? {};
        const h = d.ms / HOUR;
        let dr: number;
        let dO = 0;
        let dD = 0;
        if (seventh && i === 6 && o.seventhDayRule) {
          dO = Math.min(h, 8);
          dD = Math.max(0, h - 8);
          dr = 0;
          reasons.push(`Seventh consecutive day ${d.date}: ${fmt(dO)} h at overtime${dD ? `, ${fmt(dD)} h double time` : ''}, ${by(d.rules, 'overtime.seventhDayRule')}`);
        } else {
          if (o.dailyDoubleThreshold != null && h > o.dailyDoubleThreshold) {
            dD = h - o.dailyDoubleThreshold;
            reasons.push(`Double time applied ${d.date}: ${fmt(h)} h > ${o.dailyDoubleThreshold} (daily), ${by(d.rules, 'overtime.dailyDoubleThreshold')}`);
          }
          if (o.dailyThreshold != null && h > o.dailyThreshold) {
            dO = Math.min(h, o.dailyDoubleThreshold ?? Infinity) - o.dailyThreshold;
            reasons.push(`Overtime applied ${d.date}: ${fmt(h)} h > ${o.dailyThreshold} (daily), ${by(d.rules, 'overtime.dailyThreshold')}`);
          }
          dr = h - dO - dD;
        }
        if (weekly.t !== null && wr + dr > weekly.t) {
          const over = wr + dr - weekly.t;
          dO += over;
          dr -= over;
          reasons.push(`Overtime applied ${d.date}: ${fmt(wr + dr + over)} regular h > ${weekly.t} (weekly), ${by(weekly.r!, 'overtime.weeklyThreshold')}`);
        }
        wr += dr;
        wo += dO;
        wd += dD;
        fill(d.parts, d.date, dr, dO, dD, allocations);
      });
    }
    reg += wr;
    ot += wo;
    dt += wd;
    out.push({ weekStart: w.start.toISOString(), regularHours: round2(wr), overtimeHours: round2(wo), doubleTimeHours: round2(wd), reasons });
  }

  return {
    regularHours: round2(reg),
    overtimeHours: round2(ot),
    doubleTimeHours: round2(dt),
    overtimeMultiplier: otMult || 1.5,
    doubleMultiplier: dtMult || 2,
    weeks: out,
    penalties: penalties(closed, ctx),
    fingerprints: [...fingerprints],
    payable,
    allocations,
  };
}

/** Meal, rest and rest-between-shifts premiums; at most one of each kind a day. */
function penalties(entries: readonly WorkEntry[], ctx: TimeContext): PenaltyOutcome[] {
  const out: PenaltyOutcome[] = [];
  const seen = new Set<string>();
  const add = (p: PenaltyOutcome) => {
    const k = `${p.kind}|${p.date}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  let prev: WorkEntry | null = null;
  for (const e of entries) {
    const { date } = localParts(e.clockInAt, e.timezone);
    const rules = ctx.rulesFor(e, date);
    const h = paidMs(e, rules.params.breaks?.paidUpToMinutes ?? null) / HOUR;
    const breaks = e.breaks ?? [];
    const lenMin = (b: WorkBreak) => ((b.endedAt ?? e.clockOutAt).getTime() - b.startedAt.getTime()) / 60_000;

    const meal = rules.params.meal;
    if (meal?.requiredAfterHours != null && (meal.penaltyHours ?? 0) > 0 && h > meal.requiredAfterHours && h >= (meal.minimumDayHours ?? 0) && !(e.mealWaived && meal.waiverAllowed)) {
      const due = (after: number) => breaks.some((b) => b.type === 'MEAL' && lenMin(b) >= (meal.minMinutes ?? 30) && b.startedAt.getTime() <= e.clockInAt.getTime() + after * HOUR);
      const qualifying = breaks.filter((b) => b.type === 'MEAL' && lenMin(b) >= (meal.minMinutes ?? 30));
      const firstOk = due(meal.requiredAfterHours);
      const secondOk = meal.secondRequiredAfterHours == null || h <= meal.secondRequiredAfterHours || qualifying.length >= 2;
      if (!firstOk || !secondOk) {
        add({
          kind: 'MEAL',
          date,
          hours: meal.penaltyHours!,
          entryId: e.id,
          payable: rules.payable,
          reason: `Meal premium ${date}: ${fmt(h)} h worked without ${!firstOk ? `a ${meal.minMinutes ?? 30}-minute meal starting by hour ${meal.requiredAfterHours}` : `a second meal by hour ${meal.secondRequiredAfterHours}`}, ${meal.penaltyHours} h, ${by(rules, 'meal.requiredAfterHours')}`,
        });
      }
    }

    const rest = rules.params.rest;
    if (rest?.perHours != null && (rest.penaltyHours ?? 0) > 0 && h >= (rest.minimumDayHours ?? 0)) {
      const owed = Math.max(1, Math.ceil((h - rest.perHours / 2) / rest.perHours));
      const taken = breaks.filter((b) => b.type === 'REST' && lenMin(b) >= (rest.minMinutes ?? 10)).length;
      if (taken < owed) {
        add({ kind: 'REST', date, hours: rest.penaltyHours!, entryId: e.id, payable: rules.payable, reason: `Rest premium ${date}: ${taken} of ${owed} rest periods for ${fmt(h)} h, ${rest.penaltyHours} h, ${by(rules, 'rest.perHours')}` });
      }
    }

    const rb = rules.params.restBetweenShifts;
    if (prev && rb?.minHours != null && ((rb.premiumHours ?? 0) > 0 || (rb.premiumCents ?? 0) > 0 || (rb.premiumMultiplierInGap ?? 0) > 1)) {
      const gap = (e.clockInAt.getTime() - prev.clockOutAt.getTime()) / HOUR;
      if (gap >= 0 && gap < rb.minHours) {
        // Chicago: the hours worked inside the protected rest are paid at the multiple; the extra share is the premium.
        const inGap = Math.min(h, rb.minHours - gap);
        const extra = (rb.premiumMultiplierInGap ?? 0) > 1 ? inGap * (rb.premiumMultiplierInGap! - 1) : 0;
        const hoursOwed = round2((rb.premiumHours ?? 0) + extra);
        const parts = [hoursOwed ? `${fmt(hoursOwed)} h` : '', rb.premiumCents ? `$${(rb.premiumCents / 100).toFixed(2)}` : ''].filter(Boolean).join(' + ');
        add({
          kind: 'REST_BETWEEN_SHIFTS',
          date,
          hours: hoursOwed,
          ...(rb.premiumCents ? { cents: rb.premiumCents } : {}),
          entryId: e.id,
          payable: rules.payable,
          reason: `Rest-between-shifts premium ${date}: ${fmt(gap)} h since the last shift < ${rb.minHours}, ${parts}, ${by(rules, 'restBetweenShifts.minHours')}`,
        });
      }
    }
    prev = e;
  }
  spreadOfHours(entries, ctx, add);
  return out;
}

/**
 * Spread of hours and split shifts (NY 12 NYCRR 142-2.4, CA Wage Orders
 * §4(C)): one premium a day — an hour at the minimum wage — when the day's
 * spread runs past the threshold or its work isn't consecutive. Days are
 * the site's local dates (an entry counts on its clock-in date).
 */
function spreadOfHours(entries: readonly WorkEntry[], ctx: TimeContext, add: (p: PenaltyOutcome) => void): void {
  const days = new Map<string, WorkEntry[]>();
  for (const e of entries) {
    const { date } = localParts(e.clockInAt, e.timezone);
    const list = days.get(date) ?? [];
    list.push(e);
    days.set(date, list);
  }
  for (const [date, list] of days) {
    const first = list[0]!;
    const rules = ctx.rulesFor(first, date);
    const sp = rules.params.spreadOfHours;
    if (!sp || !(sp.premiumHours && sp.premiumHours > 0) || (sp.thresholdHours == null && sp.splitGapMinutes == null)) continue;
    const start = Math.min(...list.map((e) => e.clockInAt.getTime()));
    const end = Math.max(...list.map((e) => e.clockOutAt.getTime()));
    const spread = (end - start) / HOUR;
    // The longest time off the clock inside the day: gaps between punches and breaks within them.
    let longestGapMin = 0;
    const sorted = [...list].sort((a, b) => a.clockInAt.getTime() - b.clockInAt.getTime());
    let lastOut = sorted[0]!.clockOutAt.getTime();
    for (const e of sorted) {
      longestGapMin = Math.max(longestGapMin, (e.clockInAt.getTime() - lastOut) / 60_000);
      lastOut = Math.max(lastOut, e.clockOutAt.getTime());
      for (const b of e.breaks ?? []) longestGapMin = Math.max(longestGapMin, ((b.endedAt ?? e.clockOutAt).getTime() - b.startedAt.getTime()) / 60_000);
    }
    const overSpread = sp.thresholdHours != null && spread > sp.thresholdHours;
    const split = sp.splitGapMinutes != null && longestGapMin > sp.splitGapMinutes;
    if (!overSpread && !split) continue;
    const minimum = rules.params.minimumWage?.rateCents;
    if (minimum == null) continue;
    const dayHours = list.reduce((a, e) => a + paidMs(e, rules.params.breaks?.paidUpToMinutes ?? null), 0) / HOUR;
    const why = overSpread ? `${fmt(spread)} h from first punch to last > ${sp.thresholdHours}` : `work split by ${Math.round(longestGapMin)} min off the clock (> ${sp.splitGapMinutes})`;
    add({
      kind: overSpread ? 'SPREAD_OF_HOURS' : 'SPLIT_SHIFT',
      date,
      hours: sp.premiumHours,
      rateCents: minimum,
      ...(sp.offsetAboveMinimum ? { offsetHours: round2(dayHours) } : {}),
      entryId: first.id,
      payable: rules.payable,
      reason: `${overSpread ? 'Spread of hours' : 'Split shift'} ${date}: ${why}, ${sp.premiumHours} h at the minimum wage ($${(minimum / 100).toFixed(2)})${sp.offsetAboveMinimum ? ', less what the day paid above it' : ''}, ${by(rules, sp.thresholdHours != null && overSpread ? 'spreadOfHours.thresholdHours' : 'spreadOfHours.splitGapMinutes')}`,
    });
  }
}

/* ------------------------------------------------------------ schedule */

export interface ScheduleShift {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

export interface ScheduleFinding extends Reasoned {
  rule: 'OVERTIME_WEEKLY' | 'OVERTIME_DAILY' | 'REST_BETWEEN_SHIFTS' | 'MINOR_DAILY' | 'MINOR_WEEKLY' | 'MINOR_HOURS_OF_DAY' | 'MINOR_UNDER_AGE' | 'PREDICTIVE_NOTICE';
  severity: Severity;
  /** Premium hours the change would owe (predictive, short rest), when the rules set one. */
  premiumHours?: number;
  /** A flat premium in cents (NYC), when the rules set one. */
  premiumCents?: number;
}

export interface ScheduleContext {
  rules: ResolvedRules;
  /** The person's other shifts that week and around it (not the draft). */
  existing: readonly ScheduleShift[];
  weekStart: (d: Date, timezone: string) => Date;
  /** Age on the shift's date, from Associate.dob (decision 9: only the band is used); null if unknown. */
  age: number | null;
  /** Whether a local date is a school day for a minor (the caller's calendar). */
  isSchoolDay?: (date: string) => boolean;
  /** The instant the shift is published or changed, for the notice rules. */
  now: Date;
  /** The draft changes an already published schedule (predictive premiums apply to changes). */
  change?: 'added' | 'reduced' | 'cancelled' | 'moved';
  /** Hours the change takes away from the person (a cut or cancellation), for a share-of-hours premium. */
  hoursLost?: number;
}

const hoursOf = (s: ScheduleShift) => (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Default school calendar: Monday to Friday outside 1 June – 31 August. Callers with a real calendar pass their own. */
export function defaultIsSchoolDay(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  const m = d.getUTCMonth();
  const wd = d.getUTCDay();
  return wd >= 1 && wd <= 5 && !(m >= 5 && m <= 7);
}

const isSummer = (date: string) => {
  const m = Number(date.slice(5, 7));
  return m >= 6 && m <= 8;
};

export function evaluateSchedule(draft: ScheduleShift, ctx: ScheduleContext): ScheduleFinding[] {
  const out: ScheduleFinding[] = [];
  const p = ctx.rules.params;
  const sev = (k: 'overtime' | 'restBetweenShifts' | 'predictive'): Severity => p.severity?.[k] ?? 'warn';
  const { date } = localParts(draft.startsAt, draft.timezone);
  const weekKey = weekKeyOf(ctx.weekStart(draft.startsAt, draft.timezone), draft.timezone);
  const sameWeek = ctx.existing.filter((s) => weekKeyOf(ctx.weekStart(s.startsAt, s.timezone), s.timezone) === weekKey);
  const sameDay = ctx.existing.filter((s) => localParts(s.startsAt, s.timezone).date === date);
  const weekH = sameWeek.reduce((a, s) => a + hoursOf(s), 0) + hoursOf(draft);
  const dayH = sameDay.reduce((a, s) => a + hoursOf(s), 0) + hoursOf(draft);

  const o = p.overtime;
  if (o?.weeklyThreshold != null && weekH > o.weeklyThreshold) {
    out.push({ rule: 'OVERTIME_WEEKLY', severity: sev('overtime'), reason: `Overtime ahead: ${fmt(weekH)} h this week > ${o.weeklyThreshold} (weekly), ${by(ctx.rules, 'overtime.weeklyThreshold')}` });
  }
  if (o?.dailyThreshold != null && dayH > o.dailyThreshold) {
    out.push({ rule: 'OVERTIME_DAILY', severity: sev('overtime'), reason: `Overtime ahead: ${fmt(dayH)} h on ${date} > ${o.dailyThreshold} (daily), ${by(ctx.rules, 'overtime.dailyThreshold')}` });
  }

  const rb = p.restBetweenShifts;
  if (rb?.minHours != null) {
    for (const s of ctx.existing) {
      const gap = s.endsAt <= draft.startsAt ? (draft.startsAt.getTime() - s.endsAt.getTime()) / HOUR : draft.endsAt <= s.startsAt ? (s.startsAt.getTime() - draft.endsAt.getTime()) / HOUR : null;
      if (gap !== null && gap < rb.minHours) {
        out.push({
          rule: 'REST_BETWEEN_SHIFTS',
          severity: sev('restBetweenShifts'),
          ...(rb.premiumHours ? { premiumHours: rb.premiumHours } : {}),
          ...(rb.premiumCents ? { premiumCents: rb.premiumCents } : {}),
          reason: `Short rest: ${fmt(gap)} h between shifts < ${rb.minHours}${rb.premiumMultiplierInGap && rb.premiumMultiplierInGap > 1 ? `, hours inside it at ${rb.premiumMultiplierInGap}×` : ''}, ${by(ctx.rules, 'restBetweenShifts.minHours')}`,
        });
        break;
      }
    }
  }

  if (ctx.age !== null && ctx.age < 18) out.push(...minorFindings(draft, ctx, date, dayH, sameWeek));

  const pr = p.predictive;
  if (pr?.noticeDays != null) {
    const noticeDays = (draft.startsAt.getTime() - ctx.now.getTime()) / (24 * HOUR);
    if (noticeDays < pr.noticeDays) {
      // The narrowest band the change falls in decides what it owes.
      const band = ctx.change ? (pr.changePremiums ?? []).filter((c) => noticeDays < c.withinDays && c.kind.includes(ctx.change!)).sort((a, b) => a.withinDays - b.withinDays)[0] : undefined;
      const hoursOwed = band ? round2(band.premiumHours + (band.shareOfHoursLost ?? 0) * (ctx.hoursLost ?? 0)) : 0;
      const owes = band ? [hoursOwed ? `${fmt(hoursOwed)} h` : '', band.premiumCents ? `$${(band.premiumCents / 100).toFixed(2)}` : ''].filter(Boolean).join(' + ') : '';
      out.push({
        rule: 'PREDICTIVE_NOTICE',
        severity: sev('predictive'),
        ...(hoursOwed ? { premiumHours: hoursOwed } : {}),
        ...(band?.premiumCents ? { premiumCents: band.premiumCents } : {}),
        reason: `Short notice: ${noticeDays.toFixed(1)} days < ${pr.noticeDays}${owes ? `, owes ${owes} premium` : ''}, ${by(ctx.rules, 'predictive.noticeDays')}`,
      });
    }
  }
  return out;
}

function minorFindings(draft: ScheduleShift, ctx: ScheduleContext, date: string, dayH: number, sameWeek: readonly ScheduleShift[]): ScheduleFinding[] {
  const age = ctx.age!;
  const bands = (ctx.rules.params.minors?.bands ?? []).filter((b: MinorBand) => age >= b.minAge && age <= b.maxAge);
  if (!bands.length) return [];
  const label = ctx.rules.origin['minors.bands'] ?? 'minors';
  const school = (ctx.isSchoolDay ?? defaultIsSchoolDay)(date);
  const weekDates = [...sameWeek.map((s) => localParts(s.startsAt, s.timezone).date), date];
  const schoolWeek = weekDates.some((d) => (ctx.isSchoolDay ?? defaultIsSchoolDay)(d));
  const weekH = sameWeek.reduce((a, s) => a + hoursOf(s), 0) + hoursOf(draft);
  const start = localParts(draft.startsAt, draft.timezone).minutes;
  const endParts = localParts(draft.endsAt, draft.timezone);
  const end = endParts.date === date ? endParts.minutes : 24 * 60 + endParts.minutes;
  const schoolTomorrow = (ctx.isSchoolDay ?? defaultIsSchoolDay)(addDaysToKey(date, 1));
  const out: ScheduleFinding[] = [];
  const block = (rule: ScheduleFinding['rule'], reason: string) => {
    if (!out.some((f) => f.rule === rule)) out.push({ rule, severity: 'block', reason: `${reason}, ${label}` });
  };
  for (const b of bands) {
    const dayMax = school ? b.schoolDayMaxHours : b.nonSchoolDayMaxHours;
    const weekMax = schoolWeek ? b.schoolWeekMaxHours : b.nonSchoolWeekMaxHours;
    if (dayMax === 0 && weekMax === 0) {
      block('MINOR_UNDER_AGE', `Age ${age}: may not be scheduled`);
      continue;
    }
    if (dayMax != null && dayH > dayMax) block('MINOR_DAILY', `Age ${age}: ${fmt(dayH)} h on ${school ? 'a school day' : 'a non-school day'} > ${dayMax}`);
    if (weekMax != null && weekH > weekMax) block('MINOR_WEEKLY', `Age ${age}: ${fmt(weekH)} h in a ${schoolWeek ? 'school' : 'non-school'} week > ${weekMax}`);
    if (b.earliest && start < toMin(b.earliest)) block('MINOR_HOURS_OF_DAY', `Age ${age}: starts before ${b.earliest}`);
    const latest = schoolTomorrow && b.schoolNightLatest ? b.schoolNightLatest : isSummer(date) && b.summerLatest ? b.summerLatest : b.latest;
    if (latest && end > toMin(latest)) block('MINOR_HOURS_OF_DAY', `Age ${age}: ends after ${latest}`);
  }
  return out;
}

/** Whole years on a date, from a date of birth. */
export function ageOn(dob: Date, date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  let age = y - dob.getUTCFullYear();
  if (m < dob.getUTCMonth() + 1 || (m === dob.getUTCMonth() + 1 && d < dob.getUTCDate())) age -= 1;
  return age;
}

/** Shortfall against the minimum wage, in cents an hour (0 when the rate meets it). */
export function minimumWageShortfall(rateCents: number, rules: ResolvedRules): { shortCents: number; reason: string | null } {
  const min = rules.params.minimumWage?.rateCents;
  if (min == null || rateCents >= min) return { shortCents: 0, reason: null };
  return { shortCents: min - rateCents, reason: `Below minimum wage: $${(rateCents / 100).toFixed(2)} < $${(min / 100).toFixed(2)}, ${by(rules, 'minimumWage.rateCents')}` };
}
