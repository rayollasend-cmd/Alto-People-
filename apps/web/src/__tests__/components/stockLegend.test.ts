import { describe, expect, it } from 'vitest';
import { STOCK_LEGEND } from '@/components/ui/charts';

/**
 * LEAD-31: the stock legend kept recharts' default item sort (by name, its
 * `itemSorter: 'value'`), so month series read "Apr, Aug, Jun, Oct, Sep".
 * The kit keeps the series' own order; a chart that wants a sort passes its
 * own itemSorter after the spread.
 */
describe('STOCK_LEGEND', () => {
  it('turns recharts’ name sort off, so the legend follows the series order', () => {
    expect(STOCK_LEGEND).toHaveProperty('itemSorter', null);
  });
});
