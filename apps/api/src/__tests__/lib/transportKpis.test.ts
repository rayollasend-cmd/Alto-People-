import { describe, expect, it } from 'vitest';
import { judgeKpi } from '../../lib/transportKpis.js';

/**
 * The dispatcher's KPI words. Cost per ride has no fixed line, so the week
 * before is the yardstick — and a rise is always named, even inside the
 * healthy band, so the label never says "Steady" beside a red +$0.50.
 */
describe('judgeKpi', () => {
  it('cost per ride: named at every size, coloured by how far it moved', () => {
    expect(judgeKpi('costPerRide', 5.5, 5)).toEqual({ status: 'good', statusLabel: 'Up 10% on the week before' });
    expect(judgeKpi('costPerRide', 5.6, 5)).toEqual({ status: 'watch', statusLabel: 'Up 12% on the week before' });
    expect(judgeKpi('costPerRide', 7, 5)).toEqual({ status: 'bad', statusLabel: 'Up 40% on the week before' });
    expect(judgeKpi('costPerRide', 4.5, 5)).toEqual({ status: 'good', statusLabel: 'Down 10% on the week before' });
    expect(judgeKpi('costPerRide', 5.01, 5)).toEqual({ status: 'good', statusLabel: 'Steady' });
    expect(judgeKpi('costPerRide', 5, null)).toEqual({ status: 'none', statusLabel: 'Nothing to compare yet' });
  });

  it('the fixed lines: on time 95/85, seats 60/40, no-shows 3/8', () => {
    expect(judgeKpi('onTime', 95, null).status).toBe('good');
    expect(judgeKpi('onTime', 90, null).status).toBe('watch');
    expect(judgeKpi('utilization', 18.3, 22.9)).toEqual({ status: 'bad', statusLabel: 'Too many empty seats' });
    expect(judgeKpi('noShowRate', 8, null).status).toBe('watch');
    expect(judgeKpi('noShowRate', null, 2)).toEqual({ status: 'none', statusLabel: 'No rides yet' });
  });
});
