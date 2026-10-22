import { describe, expect, it } from 'vitest';
import { dailyOvertimeLookback, type LookbackEntry } from '../../lib/dailyOvertimeLookback.js';
import { NO_LIVE_RULES, TODAYS_RULES, payFor, penaltyAmount, plannedEntry, splitByPerson, splitHours, weeklySplit, type HoursEntry, type PayRules } from '../../lib/laborRules/hours.js';
import { CALIFORNIA_PACKS, FEDERAL_PACK, NEW_YORK_PACKS, SHIPPED_PACKS, jurisdictionsFor } from '../../lib/laborRules/packs.js';
import { resolveFor } from '../../lib/laborRules/resolve.js';
import type { RuleSetDef } from '../../lib/laborRules/params.js';
import { splitWeeklyOvertime } from '../../lib/payroll.js';

/**
 * Audit 2026-10-21 #11 — one labor-hours engine for every caller
 * (lib/laborRules/hours). splitHours is what the paycheck splits by; every
 * other view (sheet, statement, estimate, costs) uses it and its per-entry
 * shares, so these pin: the no-live path is byte-for-byte the old weekly
 * split; a live jurisdiction's daily, seventh-day and double-time rules;
 * the shares always add up to the totals; and the new spread-of-hours /
 * split-shift premium.
 */

const H = 3_600_000;
const pt = (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + 7) * H); // Pacific (PDT)
const et = (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + 4) * H); // Eastern (EDT)

const CA = { id: 'site-ca', state: 'CA', city: 'Los Angeles', timezone: 'America/Los_Angeles' };
const NY = { id: 'site-ny', state: 'NY', city: 'Albany', timezone: 'America/New_York' };
const FL = { id: 'site-fl', state: 'FL', city: 'Destin', timezone: 'America/New_York' };

/** Rules as if a tenant signed these packs for these states (status ACTIVE in memory, like live.ts's signed pool). */
function liveFor(states: string[], packs: readonly RuleSetDef[] = SHIPPED_PACKS): PayRules {
  const signed = packs.map((p) => ({ ...p, status: 'ACTIVE' as const }));
  const on = (site: { state: string | null } | null) => !!site?.state && states.includes(site.state);
  return {
    any: true,
    activationFor: (site) => (on(site) ? { live: true } : null),
    rulesFor: (site, date) => (site && on(site) ? resolveFor(signed, jurisdictionsFor(site), [], date) : null),
  };
}

const day = (site: typeof CA, ymd: string, from: number, to: number, at = pt, breaks: HoursEntry['breaks'] = []): HoursEntry => ({ clockInAt: at(ymd, from), clockOutAt: at(ymd, to), site, breaks });
const sumShares = (s: ReturnType<typeof splitHours>) =>
  s.entries.reduce((a, e) => ({ r: a.r + e.regularHours, o: a.o + e.overtimeHours, d: a.d + e.doubleTimeHours }), { r: 0, o: 0, d: 0 });

describe('the weekly split pay has always used', () => {
  it('is splitWeeklyOvertime to the hundredth, and the overtime is the week’s latest hours', () => {
    // Saturday-start week, 5 × 9 h in Florida.
    const entries = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((d) => day(FL, d, 8, 17, et));
    const w = weeklySplit(entries);
    const old = splitWeeklyOvertime(entries.map((e) => ({ status: 'APPROVED', clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: [], location: { timezone: FL.timezone } })));
    expect({ regularHours: w.regularHours, overtimeHours: w.overtimeHours }).toEqual(old);
    expect(old).toEqual({ regularHours: 40, overtimeHours: 5 });
    const s = splitHours(NO_LIVE_RULES, entries);
    expect(s.entries.map((e) => e.overtimeHours)).toEqual([0, 0, 0, 0, 5]);
    expect(s.entries[4]!.regularHours).toBe(4);
    expect(s.live).toBe(false);
    expect(s.flsaOvertimeHours).toBe(5);
  });

  it('a week worked in two zones is one week: Destin Monday–Thursday and Pensacola Friday cross 40 together', () => {
    // Before, each zone's week was keyed by its own midnight instant, so 36 h Eastern and 9 h Central were two weeks under 40.
    const PNS = { id: 'site-pns', state: 'FL', city: 'Pensacola', timezone: 'America/Chicago' };
    const ct = (ymd: string, h: number) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + (h + 5) * H);
    const entries = [...['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'].map((d) => day(FL, d, 8, 17, et)), day(PNS, '2026-10-02', 8, 17, ct)];
    expect(splitHours(NO_LIVE_RULES, entries)).toMatchObject({ regularHours: 40, overtimeHours: 5 });
    expect(splitWeeklyOvertime(entries.map((e) => ({ status: 'APPROVED', clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: [], location: { timezone: e.site!.timezone! } })))).toEqual({ regularHours: 40, overtimeHours: 5 });
  });

  it('a California 10-hour day is straight time while California is not live — exactly what the paycheck pays', () => {
    const s = splitHours(NO_LIVE_RULES, [day(CA, '2026-09-28', 6, 16)]);
    expect([s.regularHours, s.overtimeHours, s.doubleTimeHours]).toEqual([10, 0, 0]);
    // A live jurisdiction elsewhere changes nothing for this site.
    expect(splitHours(liveFor(['NY']), [day(CA, '2026-09-28', 6, 16)]).overtimeHours).toBe(0);
  });
});

describe('a live jurisdiction', () => {
  it('California: daily overtime, double time past 12, the weekly line and the seventh day — shares add up to the totals', () => {
    // Sat 10 h, Sun 13 h, Mon–Wed 8 h, Thu 4 h, Fri 9 h (seventh consecutive day).
    const entries = [
      day(CA, '2026-09-26', 6, 16),
      day(CA, '2026-09-27', 6, 19),
      day(CA, '2026-09-28', 8, 16),
      day(CA, '2026-09-29', 8, 16),
      day(CA, '2026-09-30', 8, 16),
      day(CA, '2026-10-01', 8, 12),
      day(CA, '2026-10-02', 8, 17),
    ];
    const s = splitHours(liveFor(['CA']), entries);
    expect([s.regularHours, s.overtimeHours, s.doubleTimeHours]).toEqual([40, 18, 2]);
    expect(s.live).toBe(true);
    expect(s.flsaOvertimeHours).toBe(20);
    const t = sumShares(s);
    expect([t.r, t.o, t.d].map((x) => Math.round(x * 100) / 100)).toEqual([40, 18, 2]);
    // Per day: Sun 8/4/1, Thu all overtime (past the weekly 40), Fri seventh day 8 OT + 1 DT.
    expect(s.entries[1]).toMatchObject({ regularHours: 8, overtimeHours: 4, doubleTimeHours: 1 });
    expect(s.entries[5]).toMatchObject({ regularHours: 0, overtimeHours: 4 });
    expect(s.entries[6]).toMatchObject({ regularHours: 0, overtimeHours: 8, doubleTimeHours: 1 });
    expect(s.reasons.some((r) => r.includes('Seventh consecutive day'))).toBe(true);
    // Money at the split's multipliers: 40 × 20 + 18 × 30 + 2 × 40.
    expect(payFor(s, 20, s)).toBe(800 + 540 + 80);
  });

  it('a live week shared with a site that is not live is counted once', () => {
    const entries = [day(CA, '2026-09-28', 6, 16), ...['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].map((d) => day(FL, d, 8, 17, et))];
    const s = splitHours(liveFor(['CA']), entries);
    // 10 + 36 = 46: the CA day's 2 h daily overtime, then the weekly tail.
    expect(s.regularHours + s.overtimeHours).toBe(46);
    expect(s.overtimeHours).toBe(6);
  });

  it('the TODAYS_RULES fallback is the federal weekly split with every break docked', () => {
    expect(TODAYS_RULES.params.overtime?.weeklyThreshold).toBe(40);
    expect(TODAYS_RULES.params.breaks?.paidUpToMinutes).toBeNull();
  });
});

describe('spread of hours and split shifts', () => {
  it('New York: a 13-hour spread owes an hour at the minimum wage, offset by what the day paid above it', () => {
    const entries = [day(NY, '2026-09-28', 8, 12, et), day(NY, '2026-09-28', 17, 21, et)];
    const s = splitHours(liveFor(['NY']), entries);
    const p = s.penalties.find((x) => x.kind === 'SPREAD_OF_HOURS')!;
    expect(p).toMatchObject({ hours: 1, rateCents: 1600, offsetHours: 8 });
    expect(p.label).toMatch(/^Spread-of-hours pay \(US-NY 2026-01-01 v2\)$/);
    // At the minimum wage the hour is owed in full; at $20 the day already paid 8 × $4 more — nothing owed.
    expect(penaltyAmount(p, 16)).toBe(16);
    expect(penaltyAmount(p, 20)).toBe(0);
    expect(penaltyAmount(p, 17)).toBe(8);
  });

  it('California: work split by more than an hour off the clock is a split shift; one long meal of an hour is not', () => {
    const split = splitHours(liveFor(['CA']), [day(CA, '2026-09-29', 6, 10), day(CA, '2026-09-29', 14, 18)]);
    expect(split.penalties.find((p) => p.kind === 'SPLIT_SHIFT')).toMatchObject({ hours: 1, rateCents: 1690 });
    const meal = splitHours(liveFor(['CA']), [day(CA, '2026-09-29', 6, 10), day(CA, '2026-09-29', 11, 15)]);
    expect(meal.penalties.find((p) => p.kind === 'SPLIT_SHIFT')).toBeUndefined();
  });

  it('only version 2 of the packs carries it, so an activation pinned to version 1 keeps paying version 1', () => {
    const v1Only = [FEDERAL_PACK, ...CALIFORNIA_PACKS.filter((p) => p.version === 1), ...NEW_YORK_PACKS.filter((p) => p.version === 1)];
    const s = splitHours(liveFor(['NY'], v1Only), [day(NY, '2026-09-28', 8, 12, et), day(NY, '2026-09-28', 17, 21, et)]);
    expect(s.penalties).toEqual([]);
  });

  it('unsigned packs compute the premium but never pay it (the go-live report asks for them)', () => {
    const draft: PayRules = { ...liveFor(['NY']), rulesFor: (site, date) => (site?.state === 'NY' ? resolveFor(SHIPPED_PACKS, jurisdictionsFor(site), [], date) : null) };
    const entries = [day(NY, '2026-09-28', 8, 12, et), day(NY, '2026-09-28', 17, 21, et)];
    expect(splitHours(draft, entries).penalties).toEqual([]);
    expect(splitHours(draft, entries, { unsignedPenalties: true }).penalties.map((p) => p.kind)).toEqual(['SPREAD_OF_HOURS']);
  });
});

describe('helpers every caller uses', () => {
  it('splitByPerson splits each person on their own and hands each entry its share', () => {
    const a = { ...day(FL, '2026-09-28', 0, 23, et), associateId: 'a' };
    const a2 = { ...day(FL, '2026-09-29', 0, 23, et), associateId: 'a' };
    const b = { ...day(FL, '2026-09-28', 8, 16, et), associateId: 'b' };
    const { byEntry, byPerson } = splitByPerson(NO_LIVE_RULES, [b, a2, a]);
    expect(byPerson.get('a')).toMatchObject({ regularHours: 40, overtimeHours: 6 });
    expect(byEntry.get(a2)).toMatchObject({ regularHours: 17, overtimeHours: 6 });
    expect(byEntry.get(b)).toMatchObject({ regularHours: 8, overtimeHours: 0 });
  });

  it('plannedEntry pays the schedule’s paid minutes, never the unpaid meal', () => {
    const e = plannedEntry({ startsAt: et('2026-09-28', 8), endsAt: et('2026-09-28', 17), paidMinutes: 8 * 60, site: FL });
    expect(splitHours(NO_LIVE_RULES, [e]).regularHours).toBe(8);
  });

  it('the daily-overtime look-back takes what the engine PAID from the engine: a live California day is not "paid at straight time"', () => {
    const entries: LookbackEntry[] = ['2026-09-28', '2026-09-29', '2026-09-30'].map((d) => ({
      associateId: 'ca',
      status: 'APPROVED',
      clockInAt: pt(d, 6),
      clockOutAt: pt(d, 16),
      breaks: [],
      location: { timezone: CA.timezone },
      siteState: 'CA',
      siteTimezone: CA.timezone,
      associateState: 'CA',
      siteId: CA.id,
      siteCity: CA.city,
    }));
    const rates = new Map([['ca', 20]]);
    expect(dailyOvertimeLookback(entries, rates)[0]).toMatchObject({ straightTimeOvertimeHours: 6, difference: 60 });
    expect(dailyOvertimeLookback(entries, rates, liveFor(['CA']))).toEqual([]);
  });
});
