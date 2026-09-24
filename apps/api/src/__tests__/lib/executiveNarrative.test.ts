import { describe, expect, it } from 'vitest';
import { executiveNarrative, type ExecutiveSummary, type ExecutiveWeek } from '../../lib/executiveSummary.js';

/**
 * The narrative is arithmetic in sentences: week-over-week movement,
 * net headcount, the attendance headline and client concentration. It
 * must read correctly with and without a prior week, and never divide
 * by a zero week.
 */

const week = (start: string, over: Partial<ExecutiveWeek> = {}): ExecutiveWeek => ({
  start: `${start}T04:00:00.000Z`,
  end: `${start}T04:00:00.000Z`,
  workedHours: 1000,
  otHours: 40,
  headsWorked: 50,
  estBilled: 21_210,
  estLaborCost: 15_000,
  estMargin: 6_210,
  ...over,
});

function summary(over: Partial<ExecutiveSummary> = {}): ExecutiveSummary {
  return {
    generatedAt: '2026-09-23T12:00:00.000Z',
    workforce: { active: 412, deactivated: 3, hires30d: 9, separations30d: 3, onboardingInFlight: 6 },
    lastWeek: week('2026-09-12', { workedHours: 1100, otHours: 30 }),
    thisWeek: week('2026-09-19'),
    trend: [week('2026-08-29'), week('2026-09-05'), week('2026-09-12', { workedHours: 1100, otHours: 30 })],
    attendance30d: [
      { kind: 'NO_SHOW', count: 4 },
      { kind: 'LATE', count: 7 },
    ],
    clients: [
      { clientId: 'a', clientName: 'Destin Grocery', activeAssociates: 260 },
      { clientId: 'b', clientName: 'Panama Beach Retail', activeAssociates: 152 },
    ],
    newHires30d: [],
    rates: { associateHourly: 15, leadHourly: 18, sowBillAssociate: 21.21, sowBillLead: 24.24 },
    ...over,
  } as ExecutiveSummary;
}

describe('executiveNarrative', () => {
  it('reads the week against the one before', () => {
    const lines = executiveNarrative(summary());
    expect(lines[0]).toContain('1100 hours across 50 associates, up 10% on the week before, with 30 hours of overtime (40 the week before).');
    expect(lines[1]).toMatch(/\$21,210\.00 billed against \$15,000\.00 of labor/);
    expect(lines[2]).toContain('412 active associates');
    expect(lines[2]).toContain('9 hires and 3 separations (net +6)');
    expect(lines[3]).toContain('11 unexcused events');
    expect(lines[3]).toContain('most of them late (7)');
    expect(lines[4]).toContain('Destin Grocery carries 260 of 412 placed associates (63%) — concentration worth watching.');
  });

  it('stays honest with no prior week and no activity', () => {
    const lines = executiveNarrative(
      summary({
        trend: [],
        attendance30d: [],
        clients: [],
        lastWeek: week('2026-09-12', { workedHours: 0, otHours: 0, headsWorked: 0, estBilled: 0, estLaborCost: 0, estMargin: 0 }),
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Last week the workforce worked 0 hours across 0 associates, with 0 hours of overtime.');
    expect(lines[0]).not.toContain('week before');
  });
});
