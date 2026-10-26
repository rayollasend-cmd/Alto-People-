import type { ResolvedRules } from './params.js';
import { evaluateTime, localParts, paidMs, weekKeyOf, type EntryAllocation, type PenaltyOutcome, type WorkBreak, type WorkEntry } from './evaluate.js';
import { FEDERAL_PACK } from './packs.js';
import { resolveRules } from './resolve.js';
import { companyWorkweek, startOfWeekForSite } from '../timeAnomalies.js';

/**
 * One labor-hours engine for every caller (audit 2026-10-21 #11).
 *
 *   The paycheck, the payroll sheet, the client statement, the associate's
 *   estimate, the finance and executive views, the labor-cost page, the
 *   overtime heads-ups and the Assign dialog all split hours here, so the
 *   same punches give the same regular / overtime / double-time hours
 *   everywhere. Before this, pay split by the engine while the sheet ran
 *   its own daily rule from the home-state table, the statement and the
 *   estimators ran "40 h, 1.5×" each in their own way, and a California
 *   day could read as overtime on the sheet and straight time on the check.
 *
 *   What pay is computed by (PayRules, lib/laborRules/live):
 *     - an entry at a site whose jurisdiction a tenant took LIVE is split by
 *       the rule sets counsel signed (daily, weekly, seventh day, double
 *       time), and its premiums are named;
 *     - every other entry is split exactly as pay always split it: the
 *       federal weekly 40 at 1.5×, every break docked, the week in the
 *       site's zone. A person whose period mixes the two is evaluated once,
 *       so their week is counted once.
 *
 *   Each entry also gets its share of the buckets (filled chronologically:
 *   the overtime is the latest hours worked), so a caller that reports by
 *   store, client or day adds up to the same totals the paycheck pays.
 */

export interface LaborSite {
  id: string;
  state: string | null;
  city: string | null;
  /** The site's zone; null falls back to the company zone. */
  timezone: string | null;
}

/** The rules pay is computed by. lib/laborRules/live's LiveRules is one. */
export interface PayRules {
  /** Any live activation at all (nothing live is the fast path: today's weekly split). */
  any: boolean;
  activationFor(site: { id: string; state: string | null; city: string | null } | null): unknown;
  rulesFor(site: { id: string; state: string | null; city: string | null } | null, date: string): ResolvedRules | null;
}

/** No jurisdiction live: every hour splits by the federal weekly rule. Pure callers and tests use it. */
export const NO_LIVE_RULES: PayRules = { any: false, activationFor: () => null, rulesFor: () => null };

/**
 * Today's pay, as resolved rules: the federal weekly 40 at 1.5×, every break
 * docked (no short-break rule) — what entries at a site that isn't live are
 * paid by when they share a week with live ones.
 */
export const TODAYS_RULES: ResolvedRules = resolveRules([
  { ...FEDERAL_PACK, status: 'ACTIVE', params: { overtime: FEDERAL_PACK.params.overtime, breaks: { paidUpToMinutes: null } } },
]);

export interface HoursEntry {
  id?: string;
  clockInAt: Date;
  /** Open entries (null) count nothing; a caller estimating a live punch passes `now`. */
  clockOutAt: Date | null;
  breaks?: ReadonlyArray<WorkBreak> | null;
  site?: LaborSite | null;
  /** The person waived this day's meal, where the rules allow it (pay reads the break attestation). */
  mealWaived?: boolean;
}

export interface EntryHours extends EntryAllocation {
  /** True when the entry's site pays by a live jurisdiction's signed rules. */
  live: boolean;
}

export interface LaborPenalty extends PenaltyOutcome {
  /** "Meal premium (US-CA 2026-01-01 v1)" — the line a paystub prints, citing the rule set. */
  label: string;
}

export interface HoursSplit {
  /** What pay pays, rounded to the cent of an hour exactly as the paycheck rounds. */
  regularHours: number;
  overtimeHours: number;
  doubleTimeHours: number;
  overtimeMultiplier: number;
  doubleMultiplier: number;
  /** FLSA weekly overtime (hours past 40 in a workweek): the W-2 box 12 TT base, whatever a state pays on top. */
  flsaOvertimeHours: number;
  /** Any of these hours split under a live jurisdiction's rules. */
  live: boolean;
  /** Premiums pay owes (meal, rest, rest between shifts…), signed rules only. */
  penalties: LaborPenalty[];
  /** Why: "Overtime applied 2026-10-02: 10.00 h > 8 (daily), US-CA 2026-01-01 v1". */
  reasons: string[];
  /** Per input entry, in input order: the hours it adds to each bucket (unrounded). */
  entries: EntryHours[];
}

const HOUR = 3_600_000;
/** payroll.round2: the EPSILON nudge, so 1.005 rounds up like the paystub. */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const PENALTY_NAME: Record<PenaltyOutcome['kind'], string> = {
  MEAL: 'Meal premium',
  REST: 'Rest premium',
  REST_BETWEEN_SHIFTS: 'Rest-between-shifts premium',
  SPREAD_OF_HOURS: 'Spread-of-hours pay',
  SPLIT_SHIFT: 'Split-shift premium',
};

function penaltyLabel(p: PenaltyOutcome): string {
  const cite = /,\s*([^,]+)$/.exec(p.reason)?.[1]?.trim();
  return cite ? `${PENALTY_NAME[p.kind]} (${cite})` : PENALTY_NAME[p.kind];
}

const tzOf = (e: HoursEntry) => e.site?.timezone ?? companyWorkweek().timezone;
const siteRef = (e: HoursEntry) => (e.site ? { id: e.site.id, state: e.site.state, city: e.site.city } : null);
const closed = (e: HoursEntry): e is HoursEntry & { clockOutAt: Date } => !!e.clockOutAt && e.clockOutAt > e.clockInAt;

/**
 * The federal weekly split pay has always used (payroll.splitWeeklyOvertime
 * delegates here): each workweek's paid hours, the site's zone deciding the
 * week, then the 40-hour line. Totals are byte-for-byte what the paycheck
 * paid before the engine existed; the golden file holds them to it.
 */
export function weeklySplit(entries: readonly HoursEntry[]): { regularHours: number; overtimeHours: number; allocations: Map<HoursEntry, EntryAllocation> } {
  const weeks = new Map<string, { ms: number; parts: Array<{ e: HoursEntry; ms: number }> }>();
  for (const e of entries) {
    if (!closed(e)) continue;
    const ms = paidMs(e as WorkEntry);
    if (ms <= 0) continue;
    // The workweek by its local start date, so a week worked across two zones is one week (evaluate.weekKeyOf).
    const key = weekKeyOf(startOfWeekForSite(e.clockInAt, e.site?.timezone), tzOf(e));
    const w = weeks.get(key) ?? { ms: 0, parts: [] };
    w.ms += ms;
    w.parts.push({ e, ms });
    weeks.set(key, w);
  }
  let reg = 0;
  let ot = 0;
  const allocations = new Map<HoursEntry, EntryAllocation>();
  for (const w of weeks.values()) {
    const h = w.ms / HOUR;
    const wr = h <= 40 ? h : 40;
    const wo = h <= 40 ? 0 : h - 40;
    reg += wr;
    ot += wo;
    // The overtime is the week's latest hours. Counted in milliseconds, so an
    // entry wholly inside the 40 carries exactly zero overtime: in float
    // hours a minute after a 4.75-hour punch kept 1e-15 h of it, and the
    // associate's earnings read "Overtime unlocked" at 12 hours.
    let leftMs = Math.min(w.ms, 40 * HOUR);
    for (const { e, ms } of [...w.parts].sort((a, b) => a.e.clockInAt.getTime() - b.e.clockInAt.getTime())) {
      const regMs = Math.min(ms, Math.max(0, leftMs));
      leftMs -= regMs;
      allocations.set(e, { date: localParts(e.clockInAt, tzOf(e)).date, workedHours: ms / HOUR, regularHours: regMs / HOUR, overtimeHours: (ms - regMs) / HOUR, doubleTimeHours: 0 });
    }
  }
  return { regularHours: round2(reg), overtimeHours: round2(ot), allocations };
}

const ZERO = (e: HoursEntry, live: boolean): EntryHours => ({
  date: localParts(e.clockInAt, tzOf(e)).date,
  workedHours: 0,
  regularHours: 0,
  overtimeHours: 0,
  doubleTimeHours: 0,
  live,
});

/**
 * One person's entries, split the way pay splits them. Pass the entries of
 * ONE person (their week is counted once, across every site and client).
 */
export function splitHours(rules: PayRules, entries: readonly HoursEntry[], opts: { unsignedPenalties?: boolean } = {}): HoursSplit {
  const liveAt = (e: HoursEntry) => rules.any && !!rules.activationFor(siteRef(e));
  const anyLive = rules.any && entries.some(liveAt);

  if (!anyLive) {
    const w = weeklySplit(entries);
    return {
      regularHours: w.regularHours,
      overtimeHours: w.overtimeHours,
      doubleTimeHours: 0,
      overtimeMultiplier: 1.5,
      doubleMultiplier: 2,
      flsaOvertimeHours: w.overtimeHours,
      live: false,
      penalties: [],
      reasons: w.overtimeHours > 0 ? [`Overtime applied: hours past 40 in a workweek at 1.5× (federal weekly rule)`] : [],
      entries: entries.map((e) => {
        const a = w.allocations.get(e);
        return a ? { ...a, live: false } : ZERO(e, false);
      }),
    };
  }

  // A live jurisdiction: the engine splits the hours under the rows counsel
  // signed; the person's other entries count as paid today.
  const work = new Map<WorkEntry, HoursEntry>();
  const list: WorkEntry[] = [];
  for (const e of entries) {
    if (!closed(e)) continue;
    const w: WorkEntry = { id: e.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: (e.breaks ?? []) as WorkBreak[], timezone: tzOf(e), mealWaived: e.mealWaived };
    work.set(w, e);
    list.push(w);
  }
  const out = evaluateTime(list, {
    rulesFor: (w, date) => rules.rulesFor(siteRef(work.get(w)!), date) ?? TODAYS_RULES,
    weekStart: (d, tz) => startOfWeekForSite(d, tz),
  });
  const byEntry = new Map<HoursEntry, EntryAllocation>();
  for (const [w, a] of out.allocations) byEntry.set(work.get(w)!, a);
  return {
    regularHours: out.regularHours,
    overtimeHours: out.overtimeHours,
    doubleTimeHours: out.doubleTimeHours,
    overtimeMultiplier: out.overtimeMultiplier,
    doubleMultiplier: out.doubleMultiplier,
    flsaOvertimeHours: weeklySplit(entries).overtimeHours,
    live: true,
    // Premiums pay owes: signed rules only (decision 8). The go-live change report asks for the unsigned ones too.
    penalties: out.penalties.filter((p) => (p.payable || opts.unsignedPenalties) && (p.hours > 0 || (p.cents ?? 0) > 0)).map((p) => ({ ...p, label: penaltyLabel(p) })),
    reasons: out.weeks.flatMap((w) => w.reasons),
    entries: entries.map((e) => {
      const a = byEntry.get(e);
      return a ? { ...a, live: liveAt(e) } : ZERO(e, liveAt(e));
    }),
  };
}

/**
 * Several people's entries at once: each person split on their own, every
 * entry handed back with its share. `entries` may arrive in any order.
 */
export function splitByPerson<T extends HoursEntry & { associateId: string }>(
  rules: PayRules,
  entries: readonly T[],
): { byEntry: Map<T, EntryHours>; byPerson: Map<string, HoursSplit> } {
  const groups = new Map<string, T[]>();
  for (const e of entries) {
    const g = groups.get(e.associateId) ?? [];
    g.push(e);
    groups.set(e.associateId, g);
  }
  const byEntry = new Map<T, EntryHours>();
  const byPerson = new Map<string, HoursSplit>();
  for (const [id, list] of groups) {
    const s = splitHours(rules, list);
    byPerson.set(id, s);
    list.forEach((e, i) => byEntry.set(e, s.entries[i]!));
  }
  return { byEntry, byPerson };
}

/** Money for hours at a rate, at the split's multipliers (the paycheck's arithmetic, unrounded). */
export function payFor(h: { regularHours: number; overtimeHours: number; doubleTimeHours: number }, rate: number, m: { overtimeMultiplier: number; doubleMultiplier: number } = { overtimeMultiplier: 1.5, doubleMultiplier: 2 }): number {
  return h.regularHours * rate + h.overtimeHours * rate * m.overtimeMultiplier + h.doubleTimeHours * rate * m.doubleMultiplier;
}

/** What a premium pays at a person's rate: its hours (at its own rate when the law sets one, e.g. the minimum wage), plus a flat amount. */
export function penaltyAmount(p: Pick<PenaltyOutcome, 'hours' | 'cents' | 'rateCents' | 'offsetHours'>, rate: number): number {
  const perHour = p.rateCents != null ? p.rateCents / 100 : rate;
  let hoursPart = p.hours * perHour;
  // Spread of hours / split shift where the law offsets it: what the day paid above the minimum counts toward it.
  if (p.offsetHours != null && p.rateCents != null) hoursPart = Math.max(0, hoursPart - Math.max(0, rate - p.rateCents / 100) * p.offsetHours);
  return hoursPart + (p.cents ?? 0) / 100;
}

/**
 * A planned shift as the engine sees it: the span, less the unpaid meal the
 * schedule assumes (`paidMinutes`, from @alto-people/shared paidMinutesForRange),
 * so a projection never promises pay for the meal hour.
 */
export function plannedEntry(input: { startsAt: Date; endsAt: Date; paidMinutes?: number; site?: LaborSite | null; id?: string }): HoursEntry {
  const spanMs = Math.max(0, input.endsAt.getTime() - input.startsAt.getTime());
  const unpaidMs = input.paidMinutes == null ? 0 : Math.max(0, spanMs - input.paidMinutes * 60_000);
  const mid = input.startsAt.getTime() + Math.floor((spanMs - unpaidMs) / 2);
  return {
    id: input.id,
    clockInAt: input.startsAt,
    clockOutAt: input.endsAt,
    breaks: unpaidMs > 0 ? [{ type: null, startedAt: new Date(mid), endedAt: new Date(mid + unpaidMs) }] : [],
    site: input.site ?? null,
  };
}

/** Bucket totals of a set of entry shares (unrounded). */
export function sumHours(list: Iterable<Pick<EntryHours, 'regularHours' | 'overtimeHours' | 'doubleTimeHours'>>): { regularHours: number; overtimeHours: number; doubleTimeHours: number } {
  let r = 0;
  let o = 0;
  let d = 0;
  for (const h of list) {
    r += h.regularHours;
    o += h.overtimeHours;
    d += h.doubleTimeHours;
  }
  return { regularHours: r, overtimeHours: o, doubleTimeHours: d };
}
