import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';

/**
 * Brief 2-2 step 2 — the Rules page lists each site's rules and opens one
 * site with where each value came from, its citation and whether it is
 * signed. Axe-clean.
 */

const SUMMARY = { weeklyOvertimeHours: 40, dailyOvertimeHours: null, doubleTimeHours: null, seventhDayRule: false, minimumWageCents: 1500, mealRequiredAfterHours: null, restPerHours: null, restBetweenShiftsHours: null, predictiveNoticeDays: null, minorBands: 4 };

vi.mock('@/lib/laborRulesApi', () => ({
  listLaborRuleSites: vi.fn(async () => ({
    date: '2026-10-15',
    sites: [{ id: 's1', name: 'Destin Store', city: 'Destin', state: 'FL', active: true, jurisdictions: ['FEDERAL', 'US-FL', 'US-FL-DESTIN'], layers: ['FEDERAL 2009-07-24 v1', 'US-FL 2026-09-30 v1'], payable: false, fingerprint: 'abc', summary: SUMMARY }],
  })),
  getLaborRuleSite: vi.fn(async () => ({
    date: '2026-10-15',
    site: { id: 's1', name: 'Destin Store', city: 'Destin', state: 'FL', timezone: 'America/New_York' },
    jurisdictions: ['FEDERAL', 'US-FL', 'US-FL-DESTIN'],
    layers: ['FEDERAL 2009-07-24 v1', 'US-FL 2026-09-30 v1'],
    payable: false,
    fingerprint: 'abc',
    params: {},
    origin: { 'minimumWage.rateCents': 'US-FL 2026-09-30 v1', 'overtime.weeklyThreshold': 'FEDERAL 2009-07-24 v1' },
    summary: SUMMARY,
    sets: [{ id: 'p1', jurisdiction: 'US-FL', level: 'STATE', siteId: null, effectiveFrom: '2026-09-30', version: 1, status: 'DRAFT', shipped: true, params: {}, source: 'Fla. Const. Art. X §24', sourceDate: '2026-10-15', approvedBy: null, approvedAt: null, approvalNote: null }],
  })),
}));

import { LaborRulesPage } from '@/pages/payroll/LaborRulesPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LaborRulesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LaborRulesPage', () => {
  it('lists each site and opens one with where each value came from', async () => {
    const { container } = renderPage();
    expect((await screen.findAllByText('Destin Store')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('$15.00').length).toBeGreaterThan(0);
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);

    fireEvent.click(screen.getAllByText('Destin Store')[0]!);
    expect(await screen.findByText('Fla. Const. Art. X §24')).toBeTruthy();
    expect(screen.getByText('minimumWage.rateCents')).toBeTruthy();
    expect(screen.getByText(/Not signed yet/)).toBeTruthy();
  });
});
