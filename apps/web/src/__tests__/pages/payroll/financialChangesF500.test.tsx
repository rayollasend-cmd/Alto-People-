import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAs } from '../hrPack/harness';

/**
 * Financial changes (F500 G3): the filter was a select labelled "Needs
 * Finance (pending + held)" with the counts as badges in the header. The
 * views are chips with their counts now, kept in ?filter=; an empty queue
 * says what lands here.
 */
const listFinancialChanges = vi.fn();
vi.mock('@/lib/financialChangesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/financialChangesApi')>()),
  listFinancialChanges: (f: string) => listFinancialChanges(f),
}));

import { FinancialChangesQueue, financialChangeFilters } from '@/pages/payroll/FinancialChangesQueue';

beforeEach(() => {
  listFinancialChanges.mockReset().mockResolvedValue({ rows: [], counts: { pending: 2, held: 1 } });
});

describe('Financial changes', () => {
  it('the views are chips with their counts; nothing waiting says what lands here', async () => {
    renderAs('FINANCE_ACCOUNTANT', <FinancialChangesQueue />, '/payroll/financial-changes');
    expect(await screen.findByText('No changes waiting on Finance')).toBeInTheDocument();
    expect(screen.getByText(/land here the moment they’re made/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).toBeNull();
    expect(screen.queryByText(/2 pending/)).toBeNull();
    expect(listFinancialChanges).toHaveBeenCalledWith('OPEN');
  });

  it('?filter=HELD opens on held changes', async () => {
    renderAs('FINANCE_ACCOUNTANT', <FinancialChangesQueue />, '/payroll/financial-changes?filter=HELD');
    await waitFor(() => expect(listFinancialChanges).toHaveBeenCalledWith('HELD'));
  });

  it('counts sit on the views that wait on Finance', () => {
    const f = financialChangeFilters({ pending: 2, held: 1 });
    expect(f.map((x) => [x.label, x.count ?? null])).toEqual([
      ['Waiting on Finance', 3],
      ['Needs verification', 2],
      ['Held', 1],
      ['Verified', null],
      ['Rejected', null],
      ['Last 90 days', null],
    ]);
  });
});
