import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'vitest-axe';
import type { AuthUser } from '@alto-people/shared';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { AuthContext } from '@/lib/auth';

/**
 * Brief 2-2 step 2 — the Rules page lists each site's rules and opens one
 * site with where each value came from, its citation and whether it is
 * signed. Axe-clean.
 */

const SUMMARY = { weeklyOvertimeHours: 40, dailyOvertimeHours: null, doubleTimeHours: null, seventhDayRule: false, minimumWageCents: 1500, mealRequiredAfterHours: null, restPerHours: null, restBetweenShiftsHours: null, predictiveNoticeDays: null, minorBands: 4 };

vi.mock('@/lib/laborLiveApi', () => ({ getLaborActivations: vi.fn(async () => ({ attestation: 'x', jurisdictions: [] })) }));
vi.mock('@/lib/laborRulesApi', () => ({
  listLaborRuleSets: vi.fn(async () => ({ sets: [{ id: 'o1', jurisdiction: 'TENANT', level: 'TENANT', siteId: null, effectiveFrom: '2026-10-01', version: 1, status: 'DRAFT', shipped: false, params: { restBetweenShifts: { minHours: 11 } }, source: 'Union contract section 7', sourceDate: '2026-10-15', approvedBy: null, approvedAt: null, approvalNote: null }] })),
  createLaborOverride: vi.fn(),
  activateLaborRuleSet: vi.fn(),
  retireLaborRuleSet: vi.fn(),
  listLaborShadowRuns: vi.fn(async () => ({ runs: [{ id: 'r1', payrollRunId: 'p1', periodStart: '2026-09-26', periodEnd: '2026-10-09', associates: 12, differences: 0, amountDifference: 0, penaltyHours: 0, ranAt: '2026-10-10T05:00:00Z' }] })),
  getLaborShadowRun: vi.fn(async () => ({ id: 'r1', periodStart: '2026-09-26', periodEnd: '2026-10-09', associates: 12, differences: [] })),
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

const USER: AuthUser = { id: '00000000-0000-4000-8000-000000000001', email: 'admin@altohr.com', role: 'HR_ADMINISTRATOR', status: 'ACTIVE', clientId: null, associateId: null, firstName: 'Ada', lastName: 'Admin', photoUrl: null, timezone: null, mfaEnabled: false };
const AUTH = {
  isInitializing: false,
  isOffline: false,
  user: USER,
  role: USER.role,
  capabilities: ROLE_CAPABILITIES[USER.role],
  signIn: vi.fn(async () => ({ mfaRequired: false })),
  submitMfaChallenge: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  refreshUser: vi.fn(async () => {}),
  can: () => true,
};

function renderPage(route = '/payroll/labor-rules?tab=sites') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AuthContext.Provider value={AUTH}>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[route]}>
          <LaborRulesPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  );
}

describe('LaborRulesPage', () => {
  it('lists each site and opens one with where each value came from', async () => {
    const { container } = renderPage();
    expect((await screen.findAllByText('Destin Store')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('$15.00').length).toBeGreaterThan(0);
    expect(await screen.findByText('Union contract section 7')).toBeTruthy();
    expect(screen.getByRole('button', { name: /New rule/ })).toBeTruthy();
    const results = await axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(results.violations).toHaveLength(0);

    fireEvent.click(screen.getAllByText('Destin Store')[0]!);
    expect(await screen.findByText('Fla. Const. Art. X §24')).toBeTruthy();
    expect(screen.getByText('minimumWage.rateCents')).toBeTruthy();
    expect(screen.getByText(/Not live here yet/)).toBeTruthy();
    // Spread of hours and split shifts (v2 packs) list with the other rules; Florida has neither.
    expect(screen.getAllByText('Spread of hours').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Split-shift premium').length).toBeGreaterThan(0);
  });

  it('the shadow runs have their own tab', async () => {
    renderPage('/payroll/labor-rules?tab=shadow');
    expect(await screen.findByText(/No differences so far/)).toBeTruthy();
  });
});
