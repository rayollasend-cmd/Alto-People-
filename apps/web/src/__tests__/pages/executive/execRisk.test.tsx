import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExecRisk, ExecRisks } from '@alto-people/shared';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { ApiError, apiFetch } from '@/lib/api';
import { ExecRiskPage } from '@/pages/executive/RiskPage';
import type { LegacyBriefing } from '@/pages/executive/ops/execLegacyApi';
import { location, renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Risk page: the register as a grid (severity chip, the
 * risk, what it means, owner, trend, measure, Open), the summary strip
 * (a severity coloured only when something is there), the area filter
 * chips kept in the URL, the honest "nothing on the register" state, and
 * seasonal capacity under it.
 */

const risk = (over: Partial<ExecRisk> & Pick<ExecRisk, 'id' | 'title'>): ExecRisk => ({
  category: 'client',
  severity: 'medium',
  detail: 'What it means.',
  owner: 'Clients',
  trend: 'steady',
  metric: null,
  href: '/executive/clients',
  ...over,
});

const REGISTER: ExecRisks = {
  asOf: '2026-10-27T15:45:00.000Z',
  risks: [
    risk({ id: 'conc', title: 'Coastal Resort Holdings is 76% of revenue', severity: 'high', metric: '75.7% of est. billing, last 4 weeks' }),
    // The API's shape since the deep audit (LEAD-6): no desk the chairman cannot open — the leave
    // risk reads in place, and the leave desk rides along for the role that holds manage:leave.
    risk({
      id: 'leave-deadlines',
      title: '1 leave notice past the legal deadline',
      category: 'compliance',
      severity: 'high',
      owner: 'HR',
      trend: 'new',
      href: '/executive/risk?open=leave-deadlines',
      desk: { href: '/leave?status=notices', label: 'Open the leave desk', requires: 'manage:leave' },
      items: [{ label: 'Eligibility and rights notice', sub: 'Due Oct 23 · 6 days late' }],
    }),
    risk({ id: 'sup', title: 'Seaside Grand has 10 people and no supervisor', category: 'operations', owner: 'Operations', trend: 'rising' }),
  ],
};

const briefing = (over: Partial<LegacyBriefing['capacity']> = {}): Partial<LegacyBriefing> => ({
  capacity: { bench: 2, funnel: { inFlight: 3, approved30d: 4 }, j1Active: 8, j1Cliff: [{ month: '2026-11', count: 3 }], ...over },
});

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('the Risk page', () => {
  it('lists the register highest severity first, with each risk’s owner, trend, measure and Open link', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk' });

    const table = await screen.findByRole('table', { name: 'Risk register' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('High');
    expect(rows[2]).toHaveTextContent('Medium');
    expect(within(rows[2]!).getByText('Rising')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('75.7% of est. billing, last 4 weeks')).toBeInTheDocument();
    // Nothing on the register opens the chairman's own "My leave".
    expect(within(table).queryByRole('link', { name: 'Open: 1 leave notice past the legal deadline' })).toBeNull();
    expect(within(table).getByRole('button', { name: 'Details: 1 leave notice past the legal deadline' })).toBeInTheDocument();
    expect(table.querySelector('a[href^="/leave"]')).toBeNull();

    // The summary: a severity is coloured only when there is one of it.
    const summary = screen.getByTestId('exec-risk-summary');
    expect(summary).toHaveTextContent('open risks on the register');
    expect(within(screen.getByTestId('exec-risk-sev-high')).getByText('2 high').closest('[data-tone]')).toHaveAttribute('data-tone', 'status');
    expect(within(screen.getByTestId('exec-risk-sev-low')).getByText('0 low').closest('[data-tone]')).toHaveAttribute('data-tone', 'none');
  });

  it('narrows the register by area, in the URL', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk' });
    const table = await screen.findByRole('table', { name: 'Risk register' });

    await userEvent.click(screen.getByRole('button', { name: 'Compliance 1' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(2));
    expect(within(table).getByText('1 leave notice past the legal deadline')).toBeInTheDocument();
    expect(location()).toContain('category=compliance');
    expect(screen.getByRole('button', { name: 'Compliance 1' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'All areas 3' }));
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(location()).not.toContain('category=');
  });

  it('opens on a filtered link', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk?category=operations' });
    const table = await screen.findByRole('table', { name: 'Risk register' });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Seaside Grand has 10 people and no supervisor')).toBeInTheDocument();
  });

  it('says so in green only when the register loaded and is empty', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': { asOf: REGISTER.asOf, risks: [] }, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk' });
    const clear = await screen.findByTestId('exec-risk-clear');
    expect(clear).toHaveTextContent('No open risks — nothing on the register');
    expect(screen.queryByTestId('exec-risk-summary')).not.toBeInTheDocument();
  });

  it('a failed register is an error with a retry, never the green all-clear', async () => {
    vi.mocked(apiFetch).mockImplementation(
      routeApi({
        '/executive/risks': () => {
          throw new ApiError(500, 'boom', 'Request failed (500)');
        },
        '/executive/briefing': briefing(),
      }) as never,
    );
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk' });
    expect(await screen.findByText(/Couldn.t load the risk register/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('exec-risk-clear')).not.toBeInTheDocument();
  });

  it('shows seasonal capacity and the J-1 cliff by month', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk' });
    const card = await screen.findByTestId('exec-seasonal-capacity');
    await within(card).findByText('hired and ready to place');
    expect(card).toHaveTextContent('onboarding now · 4 approved in 30 days');
    expect(card).toHaveTextContent('Nov 2026');
  });

  it('leaves the J-1 cliff out for a company without programs', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk', off: ['programs'] });
    const card = await screen.findByTestId('exec-seasonal-capacity');
    await within(card).findByText('hired and ready to place');
    expect(card).not.toHaveTextContent('J-1');
  });

  it('a company with no clients has no client area to filter by', async () => {
    const noClientRisks = { ...REGISTER, risks: REGISTER.risks.filter((r) => r.category !== 'client') };
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': noClientRisks, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk', off: ['clientPortal', 'programs'] });
    await screen.findByRole('table', { name: 'Risk register' });
    expect(screen.queryByRole('button', { name: /^Client/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('exec-risk-summary')).not.toHaveTextContent('Client');
  });
});

describe('a risk the chairman cannot work (deep audit LEAD-6, LEAD-15)', () => {
  it('opens in place with the records behind it, and never offers a desk her role cannot open', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk?open=leave-deadlines' });
    const detail = await screen.findByTestId('exec-risk-detail');
    expect(detail).toHaveTextContent('1 leave notice past the legal deadline');
    expect(within(screen.getByTestId('exec-risk-items')).getByText('Eligibility and rights notice')).toBeInTheDocument();
    expect(detail).toHaveTextContent('Due Oct 23 · 6 days late');
    expect(screen.queryByTestId('exec-risk-detail-desk')).toBeNull();
    expect(detail).toHaveTextContent('HR works this from their own desk.');
  });

  it('shows the desk to a role that holds its capability', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk?open=leave-deadlines', role: 'HR_ADMINISTRATOR' });
    expect(await screen.findByTestId('exec-risk-detail-desk')).toHaveAttribute('href', '/leave?status=notices');
  });

  it('keeps the frame on executive drill links, and only there', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/risks': REGISTER, '/executive/briefing': briefing() }) as never);
    renderAsChairman(<ExecRiskPage />, { route: '/executive/risk?period=month&compare=year' });
    const table = await screen.findByRole('table', { name: 'Risk register' });
    expect(within(table).getByRole('link', { name: 'Open: Coastal Resort Holdings is 76% of revenue' })).toHaveAttribute('href', '/executive/clients?period=month&compare=year');
  });
});
