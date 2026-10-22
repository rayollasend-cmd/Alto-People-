import { describe, expect, it } from 'vitest';
import {
  ALABAMA_PACK,
  FEDERAL_PACK,
  FLORIDA_PACKS,
  RuleParamsSchema,
  SHIPPED_PACKS,
  ageOn,
  evaluateSchedule,
  evaluateTime,
  jurisdictionsFor,
  minimumWageShortfall,
  resolveFor,
  resolveRules,
  setsInForce,
  shadowAssociate,
  type ShadowEntry,
  type ResolvedRules,
  type RuleSetDef,
  type WorkEntry,
} from '../../lib/laborRules/index.js';
import { splitWeeklyOvertime } from '../../lib/payroll.js';
import { startOfWeekForSite } from '../../lib/timeAnomalies.js';
import { GOLDEN_ASSOCIATES, GOLDEN_SITES } from '../../../test/laborGolden.js';

/**
 * Brief 2-2 step 1 — the engine core, one family at a time, and the gate
 * that matters most: under the Florida and Alabama packs the engine's hour
 * split equals today's splitWeeklyOvertime for every golden fixture.
 *
 * The California-shaped set below is a TEST set, not a pack: the CA pack
 * arrives in step 5 with counsel's numbers. It is here to prove each family
 * works and says why.
 */

const PACKS = [...SHIPPED_PACKS];
const rulesForSite = (site: { state: string; city?: string | null }, date: string, extra: RuleSetDef[] = []) =>
  resolveFor([...PACKS, ...extra], jurisdictionsFor(site), extra.map((s) => s.jurisdiction), date);

const CA_TEST: RuleSetDef = {
  jurisdiction: 'US-ZZ',
  level: 'STATE',
  effectiveFrom: '2020-01-01',
  version: 1,
  params: {
    overtime: { dailyThreshold: 8, dailyDoubleThreshold: 12, seventhDayRule: true },
    meal: { requiredAfterHours: 5, minMinutes: 30, secondRequiredAfterHours: 10, penaltyHours: 1, waiverAllowed: true },
    rest: { perHours: 4, minMinutes: 10, minimumDayHours: 3.5, penaltyHours: 1 },
    restBetweenShifts: { minHours: 10, premiumHours: 1, premiumMultiplierInGap: 0 },
    predictive: { noticeDays: 14, changePremiums: [{ withinDays: 1, premiumHours: 4, kind: ['reduced', 'cancelled'] }, { withinDays: 14, premiumHours: 1, kind: ['added', 'reduced', 'cancelled', 'moved'] }], goodFaithEstimate: true },
    minimumWage: { rateCents: 1650 },
  },
  source: 'test',
  sourceDate: '2026-10-15',
  status: 'ACTIVE',
  approvedBy: 'test',
};
const caRules = (date = '2026-10-05') => rulesForSite({ state: 'ZZ' }, date, [CA_TEST]);

const LA = 'America/Los_Angeles';
/** A Pacific wall-clock instant in October 2026 (UTC−7). */
const pt = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00-07:00`);
const entry = (ymd: string, from: string, to: string, breaks: WorkEntry['breaks'] = []): WorkEntry => {
  const inAt = pt(ymd, from);
  let outAt = pt(ymd, to);
  if (outAt <= inAt) outAt = new Date(outAt.getTime() + 86_400_000);
  return { clockInAt: inAt, clockOutAt: outAt, breaks, timezone: LA };
};
const meal = (ymd: string, from: string, to: string) => ({ type: 'MEAL' as const, startedAt: pt(ymd, from), endedAt: pt(ymd, to) });
const rest = (ymd: string, from: string, to: string) => ({ type: 'REST' as const, startedAt: pt(ymd, from), endedAt: pt(ymd, to) });

const ctxWith = (rules: ResolvedRules) => ({ rulesFor: () => rules, weekStart: startOfWeekForSite });

describe('packs', () => {
  it('every shipped pack validates, cites a source and ships DRAFT until counsel signs', () => {
    for (const p of SHIPPED_PACKS) {
      expect(RuleParamsSchema.safeParse(p.params).success, p.jurisdiction).toBe(true);
      expect(p.source.length, p.jurisdiction).toBeGreaterThan(10);
      expect(p.status).toBe('DRAFT');
      expect(p.approvedBy).toBeNull();
    }
  });

  it('a site resolves through federal, its state and its city; New York City by any of its names', () => {
    expect(jurisdictionsFor({ state: 'fl', city: 'Destin' })).toEqual(['FEDERAL', 'US-FL', 'US-FL-DESTIN']);
    expect(jurisdictionsFor({ state: 'NY', city: 'Brooklyn' })).toEqual(['FEDERAL', 'US-NY', 'US-NY-NYC']);
    expect(jurisdictionsFor({ state: null })).toEqual(['FEDERAL']);
  });
});

describe('resolution', () => {
  it('picks the set in force on the date: Florida’s minimum wage steps each 30 September', () => {
    expect(rulesForSite({ state: 'FL' }, '2025-09-29').params.minimumWage?.rateCents).toBe(1300);
    expect(rulesForSite({ state: 'FL' }, '2025-09-30').params.minimumWage?.rateCents).toBe(1400);
    expect(rulesForSite({ state: 'FL' }, '2026-10-15').params.minimumWage?.rateCents).toBe(1500);
    expect(rulesForSite({ state: 'AL' }, '2026-10-15').params.minimumWage?.rateCents).toBe(725);
    expect(setsInForce(FLORIDA_PACKS, '2024-01-01')).toEqual([]);
  });

  it('the protective value wins: an override cannot raise the OT threshold or lower the minimum wage below the law', () => {
    const loose: RuleSetDef = { ...CA_TEST, jurisdiction: 'TENANT', level: 'TENANT', params: { overtime: { weeklyThreshold: 50, dailyThreshold: null }, minimumWage: { rateCents: 900 } } };
    const r = rulesForSite({ state: 'FL' }, '2026-10-15', [loose]);
    expect(r.params.overtime?.weeklyThreshold).toBe(40);
    expect(r.params.minimumWage?.rateCents).toBe(1500);
    expect(r.origin['overtime.weeklyThreshold']).toBe('FEDERAL 2009-07-24 v1');

    const union: RuleSetDef = { ...loose, params: { overtime: { weeklyThreshold: 37.5 }, custom: { seniorityPremium: 0.5 } } };
    const u = rulesForSite({ state: 'FL' }, '2026-10-15', [union]);
    expect(u.params.overtime?.weeklyThreshold).toBe(37.5);
    expect(u.origin['overtime.weeklyThreshold']).toBe('TENANT 2020-01-01 v1');
    expect(u.params.custom).toEqual({ seniorityPremium: 0.5 });
  });

  it('an override fills what the law leaves open and its own policy, never removes a protection the law set', () => {
    const site: RuleSetDef = { ...CA_TEST, jurisdiction: 'SITE:s1', level: 'SITE', params: { meal: { requiredAfterHours: null, penaltyHours: 0 }, restBetweenShifts: { minHours: 11, premiumHours: 1 }, severity: { overtime: 'block' }, custom: { shiftLead: true } } };
    const ca = resolveFor([...PACKS, CA_TEST, site], ['FEDERAL', 'US-ZZ'], ['SITE:s1'], '2026-10-05');
    expect(ca.params.meal).toMatchObject({ requiredAfterHours: 5, penaltyHours: 1 });
    expect(ca.params.restBetweenShifts).toMatchObject({ minHours: 10, premiumHours: 1 });
    expect(ca.params.severity?.overtime).toBe('block');
    expect(ca.params.custom).toEqual({ shiftLead: true });

    // Florida sets no rest-between rule (null) and no premium (0): the site's fills both.
    const fl = resolveFor([...PACKS, site], ['FEDERAL', 'US-FL'], ['SITE:s1'], '2026-10-05');
    expect(fl.params.restBetweenShifts).toMatchObject({ minHours: 11, premiumHours: 1 });
    expect(fl.origin['restBetweenShifts.minHours']).toBe('SITE:s1 2020-01-01 v1');
  });

  it('a DRAFT set is never payable; the fingerprint names the combination', () => {
    const r = rulesForSite({ state: 'FL' }, '2026-10-15');
    expect(r.payable).toBe(false);
    expect(r.layers).toEqual(['FEDERAL 2009-07-24 v1', 'US-FL 2026-09-30 v1']);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const signed = resolveRules([{ ...FEDERAL_PACK, status: 'ACTIVE' }, { ...FLORIDA_PACKS[2]!, status: 'ACTIVE' }]);
    expect(signed.payable).toBe(true);
    expect(signed.fingerprint).toBe(r.fingerprint);
  });

  it('minors: every band of every layer applies', () => {
    const r = rulesForSite({ state: 'AL' }, '2026-10-15');
    expect(r.params.minors?.bands?.filter((b) => b.minAge <= 15 && b.maxAge >= 14)).toHaveLength(2);
    expect(r.origin['minors.bands']).toBe(`FEDERAL 2009-07-24 v1, ${ALABAMA_PACK.jurisdiction} 2009-07-24 v1`);
  });
});

describe('the Florida and Alabama packs reproduce today’s hour split', () => {
  for (const a of GOLDEN_ASSOCIATES) {
    it(a.key, () => {
      const approved = a.entries.filter((e) => e.status === 'APPROVED');
      const today = splitWeeklyOvertime(approved.map((e) => ({ status: e.status, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, location: { timezone: GOLDEN_SITES[e.site].timezone } })));
      const outcome = evaluateTime(
        approved.map((e) => ({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, timezone: GOLDEN_SITES[e.site].timezone, site: e.site }) as WorkEntry & { site: keyof typeof GOLDEN_SITES }),
        { rulesFor: (e, date) => rulesForSite(GOLDEN_SITES[(e as WorkEntry & { site: keyof typeof GOLDEN_SITES }).site], date), weekStart: startOfWeekForSite },
      );
      expect({ regularHours: outcome.regularHours, overtimeHours: outcome.overtimeHours }).toEqual(today);
      expect(outcome.doubleTimeHours).toBe(0);
      expect(outcome.penalties).toEqual([]);
      expect(outcome.payable).toBe(false);
    });
  }

  it('says why: the weekly reason names the federal set', () => {
    const a = GOLDEN_ASSOCIATES.find((x) => x.key === 'ot-42-split-shift')!;
    const outcome = evaluateTime(a.entries.map((e) => ({ clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, timezone: GOLDEN_SITES[e.site].timezone })), ctxWith(rulesForSite({ state: 'FL' }, '2026-10-01')));
    expect(outcome.weeks.flatMap((w) => w.reasons)).toEqual(['Overtime applied: 42.00 h > 40 (weekly), FEDERAL 2009-07-24 v1']);
  });
});

describe('overtime families (test set)', () => {
  it('daily overtime past 8 and double time past 12, without counting an hour twice', () => {
    const r = caRules();
    const out = evaluateTime([entry('2026-10-05', '06:00', '16:00'), entry('2026-10-06', '06:00', '19:00')], ctxWith(r));
    // 10 h: 8 + 2 OT. 13 h: 8 + 4 OT + 1 DT.
    expect(out).toMatchObject({ regularHours: 16, overtimeHours: 6, doubleTimeHours: 1 });
    expect(out.weeks[0]!.reasons).toEqual([
      'Overtime applied 2026-10-05: 10.00 h > 8 (daily), US-ZZ 2020-01-01 v1',
      'Double time applied 2026-10-06: 13.00 h > 12 (daily), US-ZZ 2020-01-01 v1',
      'Overtime applied 2026-10-06: 13.00 h > 8 (daily), US-ZZ 2020-01-01 v1',
    ]);
  });

  it('weekly overtime counts only regular hours past 40, after the daily split', () => {
    const r = caRules();
    // Sat 3 Oct – Thu 8 Oct: five 9-hour days = 40 regular + 5 daily OT, then a sixth day of 8 h is all weekly OT.
    const days = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map((d) => entry(d, '08:00', '17:00'));
    const out = evaluateTime([...days, entry('2026-10-08', '08:00', '16:00')], ctxWith(r));
    expect(out).toMatchObject({ regularHours: 40, overtimeHours: 13, doubleTimeHours: 0 });
  });

  it('the seventh consecutive day: first 8 at overtime, beyond at double time', () => {
    const r = caRules();
    const week = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map((d) => entry(d, '08:00', '12:00'));
    const out = evaluateTime([...week, entry('2026-10-09', '08:00', '18:00')], ctxWith(r));
    expect(out).toMatchObject({ regularHours: 24, overtimeHours: 8, doubleTimeHours: 2 });
    expect(out.weeks[0]!.reasons.at(-1)).toBe('Seventh consecutive day 2026-10-09: 8.00 h at overtime, 2.00 h double time, US-ZZ 2020-01-01 v1');
  });
});

describe('meal, rest and rest between shifts (test set)', () => {
  it('a late meal owes one hour; a meal on time with the rests taken owes nothing', () => {
    const r = caRules();
    const late = evaluateTime([entry('2026-10-05', '08:00', '16:30', [meal('2026-10-05', '13:30', '14:00'), rest('2026-10-05', '10:00', '10:10'), rest('2026-10-05', '15:00', '15:10')])], ctxWith(r));
    // The federal layer under the test set is DRAFT, so the premium is computed and shown, not paid (decision 8).
    expect(late.penalties).toEqual([expect.objectContaining({ kind: 'MEAL', hours: 1, date: '2026-10-05', payable: false })]);
    expect(late.penalties[0]!.reason).toContain('without a 30-minute meal starting by hour 5');

    const fine = evaluateTime([entry('2026-10-05', '08:00', '16:30', [meal('2026-10-05', '12:00', '12:30'), rest('2026-10-05', '10:00', '10:10'), rest('2026-10-05', '14:30', '14:40')])], ctxWith(r));
    expect(fine.penalties).toEqual([]);
  });

  it('a long day needs a second meal; a waived meal on a short day owes nothing', () => {
    const r = caRules();
    const long = evaluateTime([entry('2026-10-05', '06:00', '18:00', [meal('2026-10-05', '10:00', '10:30'), rest('2026-10-05', '08:00', '08:10'), rest('2026-10-05', '13:00', '13:10'), rest('2026-10-05', '16:00', '16:10')])], ctxWith(r));
    expect(long.penalties.map((p) => p.kind)).toEqual(['MEAL']);
    expect(long.penalties[0]!.reason).toContain('second meal by hour 10');

    const waived = evaluateTime([{ ...entry('2026-10-05', '08:00', '13:45', [rest('2026-10-05', '10:00', '10:10')]), mealWaived: true }], ctxWith(r));
    expect(waived.penalties).toEqual([]);
  });

  it('missing rests owe one hour a day, however many are missing', () => {
    // 11 h on the clock less a 30-minute meal: 10.5 paid hours owe three rests.
    const out = evaluateTime([entry('2026-10-05', '08:00', '19:00', [meal('2026-10-05', '12:00', '12:30')])], ctxWith(caRules()));
    const rests = out.penalties.filter((p) => p.kind === 'REST');
    expect(rests).toEqual([expect.objectContaining({ kind: 'REST', hours: 1 })]);
    expect(rests[0]!.reason).toContain('0 of 3 rest periods');
  });

  it('a clopen under the minimum rest owes the premium', () => {
    const out = evaluateTime([entry('2026-10-05', '14:00', '23:00'), entry('2026-10-06', '06:00', '10:00')], ctxWith(caRules()));
    expect(out.penalties.filter((p) => p.kind === 'REST_BETWEEN_SHIFTS')).toEqual([expect.objectContaining({ date: '2026-10-06', hours: 1 })]);
  });

  it('Florida has no meal or rest law: nothing owed for the same day', () => {
    const out = evaluateTime([{ ...entry('2026-10-05', '08:00', '18:30'), timezone: 'America/New_York' }], ctxWith(rulesForSite({ state: 'FL' }, '2026-10-05')));
    expect(out.penalties).toEqual([]);
  });
});

describe('scheduling', () => {
  const base = { weekStart: startOfWeekForSite, isSchoolDay: () => true, now: new Date('2026-09-01T00:00:00Z') };
  const shift = (ymd: string, from: string, to: string) => {
    const e = entry(ymd, from, to);
    return { startsAt: e.clockInAt, endsAt: e.clockOutAt, timezone: LA };
  };

  it('warns of weekly overtime ahead under the federal default', () => {
    const existing = ['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map((d) => shift(d, '08:00', '16:00'));
    const f = evaluateSchedule(shift('2026-10-08', '08:00', '12:00'), { ...base, rules: rulesForSite({ state: 'FL' }, '2026-10-08'), existing, age: 30 });
    expect(f).toEqual([expect.objectContaining({ rule: 'OVERTIME_WEEKLY', severity: 'warn' })]);
    expect(f[0]!.reason).toBe('Overtime ahead: 44.00 h this week > 40 (weekly), FEDERAL 2009-07-24 v1');
  });

  it('blocks a 15-year-old past three hours on a school day and after 19:00; a 13-year-old not at all', () => {
    const r = rulesForSite({ state: 'FL' }, '2026-10-06');
    const f = evaluateSchedule(shift('2026-10-06', '16:00', '20:00'), { ...base, rules: r, existing: [], age: 15 });
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ['MINOR_DAILY', 'block'],
      ['MINOR_HOURS_OF_DAY', 'block'],
    ]);
    expect(evaluateSchedule(shift('2026-10-06', '16:00', '18:00'), { ...base, rules: r, existing: [], age: 13 }).map((x) => x.rule)).toEqual(['MINOR_UNDER_AGE']);
    expect(evaluateSchedule(shift('2026-10-06', '16:00', '18:00'), { ...base, rules: r, existing: [], age: 15 })).toEqual([]);
  });

  it('a 16-year-old in Florida stops at 23:00 before a school day', () => {
    const f = evaluateSchedule(shift('2026-10-06', '17:00', '23:30'), { ...base, rules: rulesForSite({ state: 'FL' }, '2026-10-06'), existing: [], age: 16 });
    expect(f.map((x) => x.rule)).toEqual(['MINOR_HOURS_OF_DAY']);
    expect(f[0]!.reason).toContain('ends after 23:00');
  });

  it('short rest and short notice, with the premium a late cut would owe', () => {
    const r = caRules('2026-10-06');
    const f = evaluateSchedule(shift('2026-10-06', '06:00', '10:00'), { ...base, rules: r, existing: [shift('2026-10-05', '14:00', '23:00')], age: 30, now: new Date('2026-10-05T20:00:00Z'), change: 'reduced' });
    expect(f.map((x) => x.rule)).toEqual(['REST_BETWEEN_SHIFTS', 'PREDICTIVE_NOTICE']);
    expect(f[1]).toMatchObject({ premiumHours: 4 });
  });
});

describe('helpers', () => {
  it('age on a date, and the minimum-wage shortfall with its reason', () => {
    expect(ageOn(new Date('2010-10-16T00:00:00Z'), '2026-10-15')).toBe(15);
    expect(ageOn(new Date('2010-10-15T00:00:00Z'), '2026-10-15')).toBe(16);
    const fl = rulesForSite({ state: 'FL' }, '2026-10-15');
    expect(minimumWageShortfall(1500, fl)).toEqual({ shortCents: 0, reason: null });
    expect(minimumWageShortfall(1400, fl)).toEqual({ shortCents: 100, reason: 'Below minimum wage: $14.00 < $15.00, US-FL 2026-09-30 v1' });
  });
});

/*
 * Brief 2-2 step 5 — the California, New York City and Chicago packs. Values are the
 * statutes' as encoded in packs.ts, every one DRAFT until counsel confirms it; these
 * tests hold the engine to them.
 */
describe('California: the fixed week (acceptance line 2)', () => {
  // Sat 3 – Fri 9 Oct 2026, a Los Angeles site, seven consecutive days.
  const ca = (date: string) => rulesForSite({ state: 'CA', city: 'Los Angeles' }, date);
  const week = () => [
    entry('2026-10-03', '07:00', '17:30', [meal('2026-10-03', '11:00', '11:30'), rest('2026-10-03', '09:00', '09:10'), rest('2026-10-03', '13:00', '13:10'), rest('2026-10-03', '15:30', '15:40')]), // 10 h
    entry('2026-10-04', '06:00', '20:00', [meal('2026-10-04', '10:00', '10:30'), meal('2026-10-04', '15:00', '15:30'), rest('2026-10-04', '08:00', '08:10'), rest('2026-10-04', '12:30', '12:40'), rest('2026-10-04', '17:00', '17:10')]), // 13 h
    entry('2026-10-05', '09:00', '13:00', [rest('2026-10-05', '11:00', '11:10')]), // 4 h
    entry('2026-10-06', '09:00', '15:30', [meal('2026-10-06', '15:00', '15:30'), rest('2026-10-06', '11:00', '11:10'), rest('2026-10-06', '13:00', '13:10')]), // 6 h, meal at hour 6: late
    entry('2026-10-07', '09:00', '13:00', [rest('2026-10-07', '11:00', '11:10')]), // 4 h
    entry('2026-10-08', '09:00', '13:00', [rest('2026-10-08', '11:00', '11:10')]), // 4 h
    entry('2026-10-09', '08:00', '17:30', [meal('2026-10-09', '12:00', '12:30'), rest('2026-10-09', '10:00', '10:10'), rest('2026-10-09', '14:30', '14:40')]), // 9 h, the seventh day
  ];

  // Version 2 of the pack (spread of hours / split shift) is the newest set in force, so the reasons cite it.
  it('daily overtime, double time past 12, the seventh day and a late meal, each with its reason', () => {
    const out = evaluateTime(week(), { rulesFor: (_e, date) => ca(date), weekStart: startOfWeekForSite });
    // Paid rests are worked time (≤ 20 min): 10 + 13 + 4 + 6 + 4 + 4 + 9 = 50 h.
    // Sat 10: 8 + 2 OT. Sun 13: 8 + 4 OT + 1 DT. Mon–Thu 18 regular (34 so far). Fri, the seventh day: 8 OT + 1 DT.
    expect(out).toMatchObject({ regularHours: 34, overtimeHours: 14, doubleTimeHours: 2, overtimeMultiplier: 1.5, doubleMultiplier: 2 });
    const reasons = out.weeks[0]!.reasons;
    expect(reasons).toContain('Overtime applied 2026-10-03: 10.00 h > 8 (daily), US-CA 2026-01-01 v2');
    expect(reasons).toContain('Double time applied 2026-10-04: 13.00 h > 12 (daily), US-CA 2026-01-01 v2');
    expect(reasons).toContain('Seventh consecutive day 2026-10-09: 8.00 h at overtime, 1.00 h double time, US-CA 2026-01-01 v2');
    expect(out.penalties).toEqual([expect.objectContaining({ kind: 'MEAL', date: '2026-10-06', hours: 1, payable: false })]);
    expect(out.penalties[0]!.reason).toBe('Meal premium 2026-10-06: 6.00 h worked without a 30-minute meal starting by hour 5, 1 h, US-CA 2026-01-01 v2');
  });

  it('the minimum wage steps on 1 January', () => {
    expect(ca('2025-12-31').params.minimumWage?.rateCents).toBe(1650);
    expect(ca('2026-01-01').params.minimumWage?.rateCents).toBe(1690);
  });
});

describe('New York City and Chicago', () => {
  const nyc = rulesForSite({ state: 'NY', city: 'Brooklyn' }, '2026-10-15');
  const chi = rulesForSite({ state: 'IL', city: 'Chicago' }, '2026-10-15');
  const base = { weekStart: startOfWeekForSite, isSchoolDay: () => true, age: 30, existing: [] as Array<{ startsAt: Date; endsAt: Date; timezone: string }> };
  const at = (iso: string) => new Date(iso);

  it('New York City: the city’s minimum wage over the state’s, a clopening owes $100, a late cut owes by notice band', () => {
    expect(nyc.params.minimumWage?.rateCents).toBe(1700);
    expect(nyc.origin['minimumWage.rateCents']).toBe('US-NY-NYC 2026-01-01 v1');
    const close = { clockInAt: at('2026-10-05T19:00:00-04:00'), clockOutAt: at('2026-10-06T00:00:00-04:00'), timezone: 'America/New_York' };
    const open = { clockInAt: at('2026-10-06T07:00:00-04:00'), clockOutAt: at('2026-10-06T12:00:00-04:00'), timezone: 'America/New_York' };
    const out = evaluateTime([close, open], ctxWith(nyc));
    expect(out.penalties).toEqual([expect.objectContaining({ kind: 'REST_BETWEEN_SHIFTS', cents: 10000, hours: 0 })]);

    const draft = { startsAt: at('2026-10-20T09:00:00-04:00'), endsAt: at('2026-10-20T17:00:00-04:00'), timezone: 'America/New_York' };
    const tenDays = evaluateSchedule(draft, { ...base, rules: nyc, now: at('2026-10-10T09:00:00-04:00'), change: 'reduced' });
    expect(tenDays).toEqual([expect.objectContaining({ rule: 'PREDICTIVE_NOTICE', premiumCents: 2000 })]);
    const threeDays = evaluateSchedule(draft, { ...base, rules: nyc, now: at('2026-10-17T09:00:00-04:00'), change: 'added' });
    expect(threeDays[0]).toMatchObject({ premiumCents: 1500 });
  });

  it('Chicago: hours inside the 10-hour rest at 1.25×; an hour of predictability pay; half the hours cut inside 24 hours', () => {
    expect(chi.params.minimumWage?.rateCents).toBe(1660);
    const close = { clockInAt: at('2026-10-05T15:00:00-05:00'), clockOutAt: at('2026-10-05T23:00:00-05:00'), timezone: 'America/Chicago' };
    const open = { clockInAt: at('2026-10-06T06:00:00-05:00'), clockOutAt: at('2026-10-06T14:00:00-05:00'), timezone: 'America/Chicago' };
    // 7 h of rest: the first 3 h of the opening shift fall inside the 10-hour rest → 3 × 0.25 = 0.75 h premium.
    const out = evaluateTime([close, open], ctxWith(chi));
    expect(out.penalties).toEqual([expect.objectContaining({ kind: 'REST_BETWEEN_SHIFTS', hours: 0.75 })]);

    const draft = { startsAt: at('2026-10-20T09:00:00-05:00'), endsAt: at('2026-10-20T17:00:00-05:00'), timezone: 'America/Chicago' };
    expect(evaluateSchedule(draft, { ...base, rules: chi, now: at('2026-10-12T09:00:00-05:00'), change: 'moved' })[0]).toMatchObject({ premiumHours: 1 });
    expect(evaluateSchedule(draft, { ...base, rules: chi, now: at('2026-10-19T20:00:00-05:00'), change: 'cancelled', hoursLost: 8 })[0]).toMatchObject({ premiumHours: 4 });
  });

  it('Illinois: the meal law reaches only a day of 7.5 hours, and owes no premium pay', () => {
    expect(chi.params.meal).toMatchObject({ requiredAfterHours: 5, minMinutes: 20, minimumDayHours: 7.5, penaltyHours: 0 });
  });
});

describe('short breaks (29 CFR 785.18)', () => {
  it('a break of 20 minutes or less is worked time; the engine says so where today’s pay docked it', () => {
    const e = { ...entry('2026-10-05', '08:00', '16:00', [rest('2026-10-05', '10:00', '10:15'), meal('2026-10-05', '12:00', '12:30')]), timezone: 'America/New_York' };
    const today = splitWeeklyOvertime([{ status: 'APPROVED', clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, location: { timezone: e.timezone } }]);
    const out = evaluateTime([e], ctxWith(rulesForSite({ state: 'FL' }, '2026-10-05')));
    expect(today.regularHours).toBe(7.25);
    expect(out.regularHours).toBe(7.5);
    expect(out.weeks[0]!.reasons).toEqual(['Short breaks counted as worked 2026-10-05: 15 min (≤ 20 min each), FEDERAL 2009-07-24 v1']);
  });
});

// Brief 2-2 step 3: the dry run's gate, on the fixtures.
describe('the golden fixtures in shadow', () => {
  for (const a of GOLDEN_ASSOCIATES) {
    it(`${a.key}: no difference`, () => {
      const entries: ShadowEntry[] = a.entries
        .filter((e) => e.status === 'APPROVED')
        .map((e) => ({ associateId: a.id, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt, breaks: e.breaks, site: { id: GOLDEN_SITES[e.site].id, state: GOLDEN_SITES[e.site].state, city: null, timezone: GOLDEN_SITES[e.site].timezone } }));
      const r = shadowAssociate(SHIPPED_PACKS, a.id, entries, 15);
      expect(r.differs, r.reasons.join('\n')).toBe(false);
      expect(r.amountDifference).toBe(0);
    });
  }
});
