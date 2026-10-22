import { describe, expect, it } from 'vitest';
import { rateWhatIfAnnualMargin, whatIfBaseline, whatIfLose, whatIfWin } from '@/lib/execWhatIf';

/** "What if we lose this client / win this one" — on four weeks of the store league. */

const league = [
  // Walmart: two stores, 4 weeks.
  { clientId: 'w', clientName: 'Walmart', hours: 1600, otHours: 0, estBilled: 40_000, estMargin: 8_000 },
  { clientId: 'w', clientName: 'Walmart', hours: 800, otHours: 0, estBilled: 20_000, estMargin: 4_000 },
  { clientId: 't', clientName: 'Target', hours: 800, otHours: 0, estBilled: 20_000, estMargin: 4_000 },
];
const clients = [
  { clientId: 'w', clientName: 'Walmart', activeAssociates: 30 },
  { clientId: 't', clientName: 'Target', activeAssociates: 10 },
  { clientId: 'n', clientName: 'Newco', activeAssociates: 2 },
];
const rates = { payRate: 15, billRate: 25, burdenPct: 20, overheadPerHour: 1 };

describe('the what-if baseline', () => {
  it('turns four weeks into a week per client, and keeps clients with people but no hours', () => {
    const b = whatIfBaseline(league, clients);
    expect(b.weeklyBilled).toBe(20_000);
    expect(b.weeklyMargin).toBe(4_000);
    expect(b.clients.map((c) => c.clientId)).toEqual(['w', 't', 'n']);
    expect(b.clients[0]).toMatchObject({ weeklyHours: 600, weeklyBilled: 15_000, activeAssociates: 30 });
  });
});

describe('losing a client', () => {
  it('takes its margin, hours and people, and moves concentration', () => {
    const o = whatIfLose(whatIfBaseline(league, clients), 'w');
    expect(o.weeklyMargin).toBe(-3_000);
    expect(o.annualMargin).toBe(-156_000);
    expect(o.weeklyHours).toBe(-600);
    expect(o.headcount).toBe(-30);
    expect(o.topShareBeforePct).toBe(75);
    // Target is now all of it.
    expect(o.topSharePct).toBe(100);
    expect(o.topClientName).toBe('Target');
  });
});

describe('winning one', () => {
  it('prices stores × hours at the burdened standard and adds people at ~32h each', () => {
    const o = whatIfWin(whatIfBaseline(league, clients), rates, { name: 'Costco', stores: 2, hoursPerStoreWeek: 160, billRate: 25, payRate: 15 });
    expect(o.weeklyHours).toBe(320);
    expect(o.weeklyBilled).toBe(8_000);
    // 320 × 15 × 1.2 + 320 × 1 = 6,080 cost.
    expect(o.weeklyMargin).toBe(1_920);
    expect(o.headcount).toBe(10);
    expect(o.topClientName).toBe('Walmart');
    expect(o.topSharePct).toBeCloseTo(53.6, 1);
  });
});

describe('rateWhatIfAnnualMargin', () => {
  const rates = { burdenPct: 10, overheadPerHour: 1 };
  it('prices overtime as the server priced it: premiumHours, not a flat half-time', () => {
    // 40 h with 10 of them overtime and double time: the engine said they add 7 straight-time hours (e.g. 6 OT × 0.5 + 4 DT × 1).
    const m = rateWhatIfAnnualMargin([{ workedHours: 40, otHours: 10, premiumHours: 7 }], 30, 20, rates);
    expect(m).toBeCloseTo(((40 + 7) * 30 - ((40 + 7) * 20 * 1.1 + 40 * 1)) * 52, 6);
  });
  it('falls back to half an hour per overtime hour from an older API', () => {
    const m = rateWhatIfAnnualMargin([{ workedHours: 40, otHours: 10 }], 30, 20, rates);
    expect(m).toBeCloseTo(((40 + 5) * 30 - ((40 + 5) * 20 * 1.1 + 40 * 1)) * 52, 6);
  });
  it('is zero with no weeks', () => {
    expect(rateWhatIfAnnualMargin([], 30, 20, rates)).toBe(0);
  });
});
