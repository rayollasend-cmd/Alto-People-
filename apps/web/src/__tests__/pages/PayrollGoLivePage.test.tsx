import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollGoLive } from '@alto-people/shared';
import { renderAs } from './hrPack/harness';

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';
import { PayrollGoLivePage } from '@/pages/payroll/PayrollGoLivePage';

/** Running payroll in-house: what's needed first, each with where to fix it; everything on request. */

const report = (over: Partial<PayrollGoLive> = {}): PayrollGoLive => ({
  ready: false,
  missing: 2,
  warnings: 1,
  done: 2,
  total: 5,
  states: ['FL', 'NJ'],
  generatedAt: new Date().toISOString(),
  sections: [
    {
      key: 'company',
      title: 'Company',
      checks: [
        { key: 'employer', title: 'Legal name and EIN', status: 'DONE', detail: 'Coastal Staffing LLC, EIN ending 6789.', fix: { label: 'Open employers', to: '/admin/employers' } },
        { key: 'workers-comp', title: 'Workers’ compensation policy', status: 'WARNING', detail: 'No carrier and policy number on file.', fix: { label: 'Open employers', to: '/admin/employers' } },
      ],
    },
    {
      key: 'states',
      title: 'State and local taxes',
      checks: [
        { key: 'state-FL', title: 'FL', status: 'DONE', detail: 'No state income tax; unemployment 2.70% for 2026.', fix: null },
        { key: 'state-NJ', title: 'NJ', status: 'MISSING', detail: 'No state withholding account; no state unemployment account.', fix: { label: 'Open tax accounts', to: '/payroll/taxes?tab=agencies' } },
      ],
    },
    { key: 'controls', title: 'Controls', checks: [{ key: 'two-people', title: 'Two people can approve payroll', status: 'MISSING', detail: 'Only 1 person can run payroll.', fix: { label: 'Open users', to: '/admin/users' } }] },
  ],
  ...over,
});

beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('<PayrollGoLivePage>', () => {
  it('opens on what needs doing, each with a link to fix it, and shows everything on request', async () => {
    vi.mocked(apiFetch).mockResolvedValue(report());
    const user = userEvent.setup();
    renderAs('FINANCE_ACCOUNTANT', <PayrollGoLivePage />, '/payroll/go-live');
    expect(await screen.findByText(/Not yet — 2 needed/)).toBeInTheDocument();
    expect(screen.getByText('2 of 5 set up')).toBeInTheDocument();
    const nj = screen.getByText('NJ').closest('li')!;
    expect(within(nj).getByRole('link', { name: /Open tax accounts/ })).toHaveAttribute('href', '/payroll/taxes?tab=agencies');
    // Done items wait behind "Everything".
    expect(screen.queryByText('Legal name and EIN')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Everything \(5\)/ }));
    expect(screen.getByText('Legal name and EIN')).toBeInTheDocument();
    expect(screen.getByText('FL')).toBeInTheDocument();
  });

  it('says so when nothing is left to do', async () => {
    vi.mocked(apiFetch).mockResolvedValue(report({ ready: true, missing: 0, warnings: 0, done: 5, sections: [{ key: 'company', title: 'Company', checks: [{ key: 'employer', title: 'Legal name and EIN', status: 'DONE', detail: 'On file.', fix: null }] }] }));
    renderAs('FINANCE_ACCOUNTANT', <PayrollGoLivePage />, '/payroll/go-live');
    expect(await screen.findByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Nothing left to do')).toBeInTheDocument();
  });
});
