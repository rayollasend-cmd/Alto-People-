import { describe, expect, it } from 'vitest';
import { dailyOvertimeLookback, type LookbackEntry } from '../../lib/dailyOvertimeLookback.js';

/**
 * Brief 2-2, step 0 — the daily-overtime look-back's rules.
 *
 *   The engine pays weekly overtime only. In a daily-overtime state
 *   (California past 8, Colorado past 12 in the state table) the hours past
 *   the day's threshold are overtime even in a short week. The look-back
 *   reports the overtime hours paid at straight time, per company week, by
 *   the WORK SITE's state, with no hour counted twice.
 */

// Pacific daylight time in this period: UTC-7. Mountain: UTC-6. Eastern: UTC-4.
const at = (offset: number) => (ymd: string, hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCHours(h + offset, m, 0, 0);
  return d;
};
const pt = at(7);
const mt = at(6);
const et = at(4);

const entry = (
  associateId: string,
  inAt: Date,
  outAt: Date,
  site: { state: string | null; tz: string | null },
  extra: Partial<LookbackEntry> = {},
): LookbackEntry => ({
  associateId,
  status: 'APPROVED',
  clockInAt: inAt,
  clockOutAt: outAt,
  breaks: [],
  location: site.tz ? { timezone: site.tz } : null,
  siteState: site.state,
  siteTimezone: site.tz,
  associateState: 'FL',
  ...extra,
});
const CA = { state: 'CA', tz: 'America/Los_Angeles' };
const CO = { state: 'CO', tz: 'America/Denver' };
const FL = { state: 'FL', tz: 'America/New_York' };
const rates = new Map([['ca', 20], ['co', 18], ['fl', 15], ['mix', 20], ['sal', 0]]);

describe('the daily-overtime look-back', () => {
  it('finds California hours past 8 in a short week, paid at straight time', () => {
    // Four 10-hour days: 40 hours, no weekly OT, 8 hours of daily OT.
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];
    const out = dailyOvertimeLookback(days.map((d) => entry('ca', pt(d, '08:00'), pt(d, '18:00'), CA)), rates);
    expect(out).toEqual([
      expect.objectContaining({
        associateId: 'ca',
        workStates: ['CA'],
        weekHours: 40,
        dailyOvertimeHours: 8,
        lawOvertimeHours: 8,
        enginePaidOvertimeHours: 0,
        straightTimeOvertimeHours: 8,
        rate: 20,
        difference: 80, // 8 h x $20 x 0.5
      }),
    ]);
  });

  it('never counts an hour twice: a long week pays the weekly tail the engine already paid', () => {
    // Five 10-hour days: 50 hours. Daily OT 10; weekly OT left after it: 50 - 10 - 40 = 0. Law 10, engine 10: nothing owed.
    const days = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
    expect(dailyOvertimeLookback(days.map((d) => entry('ca', pt(d, '08:00'), pt(d, '18:00'), CA)), rates)).toEqual([]);
    // Six 9-hour days: 54. Daily 6; weekly left 54 - 6 - 40 = 8; law 14; engine 14: nothing owed.
    const six = ['2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
    expect(dailyOvertimeLookback(six.map((d) => entry('ca', pt(d, '08:00'), pt(d, '17:00'), CA)), rates)).toEqual([]);
    // Three 12-hour days: 36. Daily 12; law 12; engine 0: 12 owed.
    const three = dailyOvertimeLookback(['2026-09-28', '2026-09-29', '2026-09-30'].map((d) => entry('ca', pt(d, '06:00'), pt(d, '18:00'), CA)), rates);
    expect(three[0]).toMatchObject({ weekHours: 36, lawOvertimeHours: 12, straightTimeOvertimeHours: 12, difference: 120 });
  });

  it("uses each state's own threshold and the work site's state, not the home state", () => {
    // Colorado: 13 hours is 1 past 12.
    const co = dailyOvertimeLookback([entry('co', mt('2026-09-28', '06:00'), mt('2026-09-28', '19:00'), CO)], rates);
    expect(co[0]).toMatchObject({ workStates: ['CO'], dailyOvertimeHours: 1, straightTimeOvertimeHours: 1, difference: 9 });
    // A Californian working in Florida: no daily overtime.
    expect(dailyOvertimeLookback([entry('fl', et('2026-09-28', '06:00'), et('2026-09-28', '18:00'), FL, { associateState: 'CA' })], rates)).toEqual([]);
    // A Floridian at a California site: daily overtime applies.
    expect(dailyOvertimeLookback([entry('ca', pt('2026-09-28', '06:00'), pt('2026-09-28', '18:00'), CA, { associateState: 'FL' })], rates)[0]).toMatchObject({ straightTimeOvertimeHours: 4 });
    // No site state: the home state decides.
    expect(dailyOvertimeLookback([entry('ca', pt('2026-09-28', '06:00'), pt('2026-09-28', '16:00'), { state: null, tz: 'America/Los_Angeles' }, { associateState: 'CA' })], rates)[0]).toMatchObject({ straightTimeOvertimeHours: 2 });
  });

  it('counts net of breaks, approved hours only, and skips salaried items', () => {
    const d = '2026-09-28';
    // 10-hour span with a 1-hour meal: 9 worked, 1 past 8.
    const withMeal = entry('ca', pt(d, '08:00'), pt(d, '18:00'), CA, { breaks: [{ startedAt: pt(d, '12:00'), endedAt: pt(d, '13:00') }] });
    expect(dailyOvertimeLookback([withMeal], rates)[0]).toMatchObject({ weekHours: 9, straightTimeOvertimeHours: 1 });
    expect(dailyOvertimeLookback([entry('ca', pt(d, '06:00'), pt(d, '18:00'), CA, { status: 'COMPLETED' })], rates)).toEqual([]);
    expect(dailyOvertimeLookback([entry('sal', pt(d, '06:00'), pt(d, '18:00'), CA)], rates)).toEqual([]);
  });

  it('two sites in one week: each day keeps its own state', () => {
    // California and Oregon share the Pacific week; Oregon has no daily overtime in the table.
    const OR = { state: 'OR', tz: 'America/Los_Angeles' };
    const out = dailyOvertimeLookback(
      [
        entry('mix', pt('2026-09-28', '06:00'), pt('2026-09-28', '17:00'), CA), // 11 in CA: 3 past 8
        entry('mix', pt('2026-09-29', '06:00'), pt('2026-09-29', '17:00'), OR), // 11 in OR: none
      ],
      rates,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ workStates: ['CA', 'OR'], weekHours: 22, dailyOvertimeHours: 3, straightTimeOvertimeHours: 3, difference: 30 });
  });
});
