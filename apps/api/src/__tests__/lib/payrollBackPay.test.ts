import { describe, expect, it } from 'vitest';
import { missedByUtcCut, priceBackPay, weekOf, type BackPayPunch, type BackPayRun } from '../../lib/payrollBackPay.js';

/**
 * The back-pay detector and pricing, pure (the owner's answer to the deep
 * audit: pay the evening hours the old UTC cut never paid). Chicago; Alto's
 * biweekly Sat → Fri periods Sep 26 – Oct 9, Oct 10 – 23, Oct 24 – Nov 6.
 */

const CHI = { timezone: 'America/Chicago' };
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
let n = 0;
const punch = (iso: string, hours: number, associateId = 'ana'): BackPayPunch => ({
  id: `p${++n}`,
  associateId,
  clientId: null,
  status: 'APPROVED',
  clockInAt: new Date(iso),
  clockOutAt: new Date(new Date(iso).getTime() + hours * 3_600_000),
  location: CHI,
});
const run = (id: string, start: string, end: string, extra: Partial<BackPayRun> = {}): BackPayRun => ({
  id,
  periodStart: d(start),
  periodEnd: d(end),
  payrollScheduleId: 'sched',
  clientId: null,
  kind: 'REGULAR',
  status: 'DISBURSED',
  timeCut: 'UTC',
  payees: new Set(['ana']),
  ...extra,
});
const everyone = new Map([['sched', new Map([['ana', [{ start: '2026-09-01', end: '2026-12-31' }]], ['ben', [{ start: '2026-09-01', end: '2026-12-31' }]]])]]);

describe('missedByUtcCut', () => {
  it('finds a 7:30 PM Friday Chicago punch on a UTC-cut run’s last day that no run paid', () => {
    const evening = punch('2026-10-10T00:30:00Z', 6); // Fri Oct 9, 7:30 PM CDT
    const day = punch('2026-10-08T14:00:00Z', 8); // Thu Oct 8 — the run's own UTC day
    const runs = [run('r1', '2026-09-26', '2026-10-09'), run('r2', '2026-10-10', '2026-10-23')];
    const out = missedByUtcCut({ runs, punches: [evening, day], windows: everyone, claimed: new Set() });
    expect(out.map((m) => [m.punch.id, m.workDay, m.sourceRun.id])).toEqual([[evening.id, '2026-10-09', 'r1']]);
  });

  it('never finds what the first site-day run carries in', () => {
    const evening = punch('2026-10-24T00:30:00Z', 6); // Fri Oct 23, 7:30 PM CDT
    const runs = [run('r2', '2026-10-10', '2026-10-23'), run('d3', '2026-10-24', '2026-11-06', { status: 'DRAFT', timeCut: 'SITE_DAY', payees: new Set() })];
    expect(missedByUtcCut({ runs, punches: [evening], windows: everyone, claimed: new Set() })).toEqual([]);
    // Locked, with a paycheck for her, the carry-in paid it too.
    const locked = [run('r2', '2026-10-10', '2026-10-23'), run('r3', '2026-10-24', '2026-11-06', { timeCut: 'SITE_DAY' })];
    expect(missedByUtcCut({ runs: locked, punches: [evening], windows: everyone, claimed: new Set() })).toEqual([]);
  });

  it('never finds a punch a later run paid (runs not on a schedule took the next UTC day)', () => {
    const evening = punch('2026-10-24T00:30:00Z', 6, 'ben');
    const runs = [
      run('l1', '2026-10-10', '2026-10-23', { payrollScheduleId: null, payees: new Set(['ben']) }),
      run('l2', '2026-10-24', '2026-11-06', { payrollScheduleId: null, payees: new Set(['ben']) }),
    ];
    expect(missedByUtcCut({ runs, punches: [evening], windows: new Map(), claimed: new Set() })).toEqual([]);
    // Without a paycheck for him on the later run, it was never paid: found.
    const unpaid = [runs[0]!, { ...runs[1]!, payees: new Set<string>() }];
    expect(missedByUtcCut({ runs: unpaid, punches: [evening], windows: new Map(), claimed: new Set() }).map((m) => m.sourceRun.id)).toEqual(['l1']);
  });

  it('skips a punch already claimed, someone off the schedule, and cancelled runs', () => {
    const evening = punch('2026-10-10T00:30:00Z', 6);
    const runs = [run('r1', '2026-09-26', '2026-10-09')];
    expect(missedByUtcCut({ runs, punches: [evening], windows: everyone, claimed: new Set([evening.id]) })).toEqual([]);
    expect(missedByUtcCut({ runs, punches: [evening], windows: new Map([['sched', new Map()]]), claimed: new Set() })).toEqual([]);
    expect(missedByUtcCut({ runs: [run('r1', '2026-09-26', '2026-10-09', { status: 'CANCELLED' })], punches: [evening], windows: everyone, claimed: new Set() })).toEqual([]);
  });
});

describe('priceBackPay', () => {
  const r1 = run('r1', '2026-09-26', '2026-10-09');
  it('hours × the rate that day, plus the overtime the week would have paid', () => {
    // Week Sat Oct 3 – Fri Oct 9: 40 hours paid Mon–Thu, then the missed 6 on Friday evening.
    const paid = ['05', '06', '07', '08'].map((dd) => punch(`2026-10-${dd}T14:00:00Z`, 10));
    const evening = punch('2026-10-10T00:30:00Z', 6);
    const [p] = priceBackPay({
      missed: [{ punch: evening, workDay: '2026-10-09', sourceRun: r1 }],
      weekEntries: new Map([['ana', [...paid, evening]]]),
      rateOn: () => 20,
      nameOf: () => 'Ana Reyes',
    });
    expect(weekOf('2026-10-09')).toBe('2026-10-03');
    expect(p).toMatchObject({ associateId: 'ana', name: 'Ana Reyes', hours: 6, rates: [20], overtimeHours: 6, overtimePremium: 60, amount: 180 });
    expect(p!.periods).toEqual([{ periodStart: '2026-09-26', periodEnd: '2026-10-09' }]);
    expect(p!.punches).toEqual([{ timeEntryId: evening.id, workDay: '2026-10-09', hours: 6, rate: 20, sourceRunId: 'r1', amount: 180 }]);
  });

  it('no overtime when the week stays under 40; a salaried day is never hourly back pay', () => {
    const evening = punch('2026-10-10T00:30:00Z', 6);
    const [p] = priceBackPay({ missed: [{ punch: evening, workDay: '2026-10-09', sourceRun: r1 }], weekEntries: new Map(), rateOn: () => 18.5, nameOf: () => 'Ana' });
    expect(p).toMatchObject({ hours: 6, overtimeHours: 0, overtimePremium: 0, amount: 111 });
    expect(priceBackPay({ missed: [{ punch: evening, workDay: '2026-10-09', sourceRun: r1 }], weekEntries: new Map(), rateOn: () => null, nameOf: () => 'Ana' })).toEqual([]);
  });
});
