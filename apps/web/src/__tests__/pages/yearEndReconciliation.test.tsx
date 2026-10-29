import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { YearEndReconciliation as Recon } from '@/lib/yearEndApi';
import { renderAs } from './hrPack/harness';

const getYearEndReconciliation = vi.fn();
const getPersonVariances = vi.fn();
vi.mock('@/lib/yearEndApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/yearEndApi')>()),
  getYearEndReconciliation: (...a: unknown[]) => getYearEndReconciliation(...a),
  getPersonVariances: (...a: unknown[]) => getPersonVariances(...a),
}));
let phone = false;
vi.mock('@/lib/useViewport', () => ({ useMediaQuery: () => phone, useIsPhone: () => phone }));

import { YearEndReconciliation } from '@/pages/payroll/YearEndPage';

const RECON: Recon = {
  year: 2025,
  generatedAt: '2026-01-10T15:00:00Z',
  people: 2,
  w2Count: 2,
  storedW2s: 1,
  generatedQuarters: ['2025-Q4'],
  summary: { rows: 2, variances: 1, blocking: 1, warnings: 0 },
  checklist: [{ severity: 'BLOCKING', code: 'missing_ssn', message: 'No Social Security number on file: the W-2 can’t be filed.', count: 1, people: [{ associateId: 'a1', name: 'Rae Lind' }] }],
  sections: [
    {
      key: 'federal',
      title: 'Federal: paychecks, Forms 941 and W-2s',
      sources: [
        { key: 'paychecks', label: 'Paychecks' },
        { key: 'f941', label: 'Four 941s' },
        { key: 'w2', label: 'W-2s (W-3)' },
      ],
      rows: [
        { key: 'wages', label: 'Wages, tips and other pay (941 line 2 · W-2 box 1)', values: { paychecks: 7000, f941: 7000, w2: 6500 }, variance: 500, ok: false, drill: 'box1' },
        { key: 'fit', label: 'Federal income tax withheld (941 line 3 · box 2)', values: { paychecks: 700, f941: 700, w2: 700 }, variance: 0, ok: true, drill: 'box2' },
      ],
    },
  ],
};

beforeEach(() => {
  phone = false;
  getYearEndReconciliation.mockReset().mockResolvedValue(RECON);
  getPersonVariances.mockReset().mockResolvedValue({ metric: 'box1', people: [{ associateId: 'a1', name: 'Rae Lind', paychecks: 4000, w2: 3500, difference: -500, w2Source: 'stored', checks: [{ itemId: 'i1', paidAt: '2025-03-13T15:00:00Z', amount: 4000 }] }] });
});

describe('<YearEndReconciliation>', () => {
  it('shows the checklist, each source side by side, and the variance', async () => {
    renderAs('HR_ADMINISTRATOR', <YearEndReconciliation />, '/payroll/year-end/reconciliation');
    expect(await screen.findByText('Before you file')).toBeInTheDocument();
    expect(screen.getByText(/No Social Security number on file/)).toBeInTheDocument();
    // A 941 quarter with no return on file is a "Before you file" item from the API; it isn't said twice (F500 G3).
    expect(screen.queryByText(/No return on file for 2025-Q4/)).toBeNull();
    const table = screen.getByRole('table');
    const wages = within(table).getByText(/Wages, tips and other pay/).closest('tr')!;
    expect(within(wages).getByText('$6,500.00')).toBeInTheDocument();
    expect(within(wages).getByText('$500.00')).toBeInTheDocument();
  });

  it('the people behind a variance open in a drawer, largest difference first', async () => {
    // The page opens on the year with the work (2026 from October 1, MONEY-27): this case reads 2025.
    renderAs('HR_ADMINISTRATOR', <YearEndReconciliation />, '/payroll/year-end/reconciliation?year=2025');
    await userEvent.click(await screen.findByRole('button', { name: /People behind Wages, tips/ }));
    expect(getPersonVariances).toHaveBeenCalledWith(2025, 'box1');
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Rae Lind')).toBeInTheDocument();
    expect(within(dialog).getByText(/\$3,500\.00 on W-2 · −\$500\.00/)).toBeInTheDocument();
  });

  it('a year with nothing paid says so, not a page of $0 tables marked "Agrees"', async () => {
    getYearEndReconciliation.mockResolvedValue({ ...RECON, people: 0, w2Count: 0, storedW2s: 0, generatedQuarters: [], summary: { rows: 2, variances: 0, blocking: 0, warnings: 0 }, checklist: [] });
    renderAs('HR_ADMINISTRATOR', <YearEndReconciliation />, '/payroll/year-end?tab=reconcile&year=2025');
    expect(await screen.findByText('No pay in 2025')).toBeInTheDocument();
    expect(screen.queryByText('Agrees')).toBeNull();
  });

  it('the yearly 940 with no return on file is the one note left', async () => {
    getYearEndReconciliation.mockResolvedValue({ ...RECON, generatedQuarters: ['2025-Q4', '2025'] });
    renderAs('HR_ADMINISTRATOR', <YearEndReconciliation />, '/payroll/year-end?tab=reconcile&year=2025');
    expect(await screen.findByText(/No Form 940 on file for 2025/)).toBeInTheDocument();
  });
});
