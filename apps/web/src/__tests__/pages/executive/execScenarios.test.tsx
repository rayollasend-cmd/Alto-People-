import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import type { ExecTargetsResponse } from '@/lib/executiveApi';
import { ExecScenariosPage } from '@/pages/executive/ScenariosPage';
import type { LegacySummary } from '@/pages/executive/ops/execLegacyApi';
import { parseQuarter, planPace } from '@/pages/executive/scenarios/planPace';
import { renderAsChairman, routeApi } from './execPagesHarness';

/**
 * The chairman's Scenarios page: where the quarter lands at this pace
 * (the plan-pace arithmetic), the rate negotiation model on real volume,
 * and losing or winning a client — with the share sentence in words.
 */

const TARGETS: ExecTargetsResponse = {
  quarter: '2026-Q4',
  elapsedPct: 29,
  targets: { revenueTarget: 300_000, marginTarget: 55_000, headcountTarget: 38, turnoverPctTarget: 30, fillRatePctTarget: null },
  actuals: { revenueQtd: 82_350.3, marginQtd: 17_122.34, headcount: 36, turnoverAnnualizedPct: 0, fillRatePct: 99.1 },
};

const week = (start: string, workedHours: number) => ({ start, end: start, workedHours, otHours: 0, premiumHours: 0, headsWorked: 30, estBilled: workedHours * 21.21, estLaborCost: workedHours * 16.8, estMargin: workedHours * 4.41 });

const SUMMARY: LegacySummary = {
  generatedAt: '2026-10-27T15:00:00.000Z',
  trend: [week('2026-09-26', 1000), week('2026-10-03', 1000), week('2026-10-10', 1000), week('2026-10-17', 1000)],
  rates: { payRate: 15, billRate: 21.21, burdenPct: 12, overheadPerHour: 0 },
  league: [
    { clientId: 'c1', clientName: 'Coastal Resort Holdings', locationId: 'l1', locationName: 'Front Beach 218', hours: 3000, otHours: 0, estBilled: 3000 * 21.21, estMargin: 3000 * 4.41 },
    { clientId: 'c2', clientName: 'Seaside Hospitality Group', locationId: 'l2', locationName: 'Seaside Grand', hours: 1000, otHours: 0, estBilled: 1000 * 21.21, estMargin: 1000 * 4.41 },
  ],
  clients: [
    { clientId: 'c1', clientName: 'Coastal Resort Holdings', activeAssociates: 26 },
    { clientId: 'c2', clientName: 'Seaside Hospitality Group', activeAssociates: 10 },
  ],
  attendance30d: [],
};

const HOTEL_OFF = ['clientPortal', 'billRates', 'programs'] as const;

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('plan pace', () => {
  it('carries the quarter to date forward at the same pace', () => {
    const p = planPace(82_350, 29, 300_000);
    expect(p.projected).toBeCloseTo(283_965.5, 0);
    expect(p.ratio).toBeCloseTo(0.9466, 3);
    expect(p.gap).toBeCloseTo(-16_034.5, 0);
    expect(p.status).toBe('bad');
  });
  it('judges on plan, within 5% short to watch, and further short off plan', () => {
    expect(planPace(100, 50, 200).status).toBe('good');
    expect(planPace(96, 50, 200).status).toBe('watch');
    expect(planPace(94, 50, 200).status).toBe('bad');
  });
  it('has no verdict without a plan, and no projection before the quarter starts', () => {
    expect(planPace(100, 50, null)).toMatchObject({ projected: 200, status: 'none', ratio: null });
    expect(planPace(100, 0, 200)).toMatchObject({ projected: null, status: 'none' });
  });
  it('reads the quarter key', () => {
    expect(parseQuarter('2026-Q4')).toEqual({ year: 2026, q: 4 });
    expect(parseQuarter('Q4')).toBeNull();
  });
});

describe('the Scenarios page', () => {
  it('shows where the quarter lands against the plan, rounded, with the gap in words', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': TARGETS, '/executive/summary': SUMMARY }) as never);
    renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios' });
    const revenue = await screen.findByTestId('exec-pace-revenue');
    expect(revenue).toHaveTextContent('$284k');
    expect(revenue).toHaveTextContent('$82.4k so far');
    expect(revenue).toHaveTextContent('Off plan');
    expect(revenue).toHaveTextContent('Plan $300k: 94.7% of plan, $16.0k short.');
    const margin = screen.getByTestId('exec-pace-margin');
    expect(margin).toHaveTextContent('$59.0k');
    expect(margin).toHaveTextContent('On plan');
    expect(margin).toHaveTextContent('ahead');
    expect(screen.getByTestId('exec-plan-pace')).toHaveTextContent('Q4 2026 is 29% through.');
  });

  it('with no plan set, still projects the quarter and says there is no plan', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': { ...TARGETS, targets: null }, '/executive/summary': SUMMARY }) as never);
    renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios' });
    const revenue = await screen.findByTestId('exec-pace-revenue');
    expect(revenue).toHaveTextContent('$284k');
    expect(revenue).toHaveTextContent('No plan set');
    expect(screen.getByTestId('exec-plan-pace')).toHaveTextContent('No plan is set for Q4 2026');
  });

  it('prices a rate change as one signed, rounded figure a year', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': TARGETS, '/executive/summary': SUMMARY }) as never);
    renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios' });
    const card = await screen.findByTestId('exec-rate-model');
    const result = within(card).getByTestId('exec-rate-result');
    expect(result).toHaveTextContent('±$0');
    const bill = within(card).getByLabelText('Bill rate ($ an hour)');
    await userEvent.clear(bill);
    await userEvent.type(bill, '22.21');
    // +$1 an hour on 1,000 hours a week, 52 weeks.
    expect(result).toHaveTextContent('+$52.0k');
    expect(within(result).getByText(/\+\$52\.0k/)).toHaveAttribute('title', '$52,000.00');
    expect(card).toHaveTextContent('On the last four weeks’ average of 1,000 hours a week');
    await userEvent.click(within(card).getByRole('button', { name: 'Back to today’s rates' }));
    expect(result).toHaveTextContent('±$0');
  });

  it('says what losing a client does to concentration in words', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': TARGETS, '/executive/summary': SUMMARY }) as never);
    renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios' });
    const outcome = await screen.findByTestId('exec-whatif-outcome');
    expect(outcome).toHaveTextContent('Largest client’s share would rise from 75% to 100%.');
    expect(outcome).toHaveTextContent('Largest client afterwards: Seaside Hospitality Group.');
    expect(outcome).toHaveTextContent('−26');
    expect(outcome).not.toHaveTextContent('from 100%');
  });

  it('a staffing company without billing gets the pay model and no client scenario', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': TARGETS, '/executive/summary': SUMMARY }) as never);
    renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios', off: ['billRates'] });
    expect(await screen.findByTestId('exec-pace-headcount')).toBeInTheDocument();
    expect(await screen.findByTestId('exec-rate-model')).toHaveTextContent('Pay rate model');
    expect(screen.queryByTestId('exec-whatif')).not.toBeInTheDocument();
  });

  it('a hotel (no clients, no billing) reads people and fill against the plan and what a pay change costs — no client words', async () => {
    vi.mocked(apiFetch).mockImplementation(routeApi({ '/executive/targets': TARGETS, '/executive/summary': SUMMARY }) as never);
    const { container } = renderAsChairman(<ExecScenariosPage />, { route: '/executive/scenarios', off: [...HOTEL_OFF] });
    const working = await screen.findByTestId('exec-pace-headcount');
    expect(working).toHaveTextContent('36');
    expect(working).toHaveTextContent('Plan 38: 94.7% of plan, 2 short.');
    expect(screen.getByTestId('exec-pace-fill')).toHaveTextContent('99.1%');
    expect(screen.queryByTestId('exec-pace-revenue')).not.toBeInTheDocument();
    const card = await screen.findByTestId('exec-rate-model');
    expect(within(card).queryByLabelText('Bill rate ($ an hour)')).not.toBeInTheDocument();
    const pay = within(card).getByLabelText('Pay rate ($ an hour)');
    await userEvent.clear(pay);
    await userEvent.type(pay, '16');
    // +$1 an hour on 1,000 hours a week, 12% burden, 52 weeks: more cost, the bad news.
    const result = within(card).getByTestId('exec-rate-result');
    expect(result).toHaveTextContent('Change in labor cost, a year');
    expect(result).toHaveTextContent('+$58.2k');
    expect(screen.queryByTestId('exec-whatif')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bclients?\b|\bbill rate/i);
  });
});
