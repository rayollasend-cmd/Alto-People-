import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Capability } from '@alto-people/shared';
import { AuthContext, DEFAULT_TENANT } from '@/lib/auth';

/**
 * Floor walk 26: the associate home's pay-period ring — what this pay
 * period has earned so far, from the hours clocked at their rate, labelled
 * as an estimate; and the period it reads is the one running today, even
 * when the next payday pays for a period that already closed.
 */

vi.mock('@/lib/timeApi', () => ({
  getActiveTimeEntry: vi.fn().mockResolvedValue(null),
  listMyTimeEntries: vi.fn(),
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  tryGetGeolocation: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn().mockResolvedValue({ shifts: [] }),
  getMyShiftDetail: vi.fn(),
  acknowledgeMyShift: vi.fn(),
}));
vi.mock('@/lib/qualApi', () => ({ listOpenShifts: vi.fn().mockResolvedValue({ shifts: [] }) }));
vi.mock('@/lib/payrollApi', () => ({
  listMyPayrollItems: vi.fn().mockResolvedValue({ items: [] }),
  getMyNextPayday: vi.fn(),
}));
vi.mock('@/lib/timeOffApi', () => ({ getMyBalance: vi.fn().mockResolvedValue({ balances: [] }) }));
vi.mock('@/lib/inboxApi', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return {
    getInbox: vi.fn(),
    INBOX_QUERY_KEY: ['inbox'],
    useInbox: () => useQuery({ queryKey: ['inbox'], queryFn: () => ({ total: 0, sources: [] }) }),
  };
});
vi.mock('@/lib/lms94Api', () => ({ getMyTraining: vi.fn().mockResolvedValue({ enrollments: [] }) }));
vi.mock('@/lib/emergencyApi', () => ({
  getMyEmergency: vi.fn().mockResolvedValue({ emergency: null, checkIn: null }),
  emergencyCheckIn: vi.fn(),
}));
vi.mock('@/lib/onboardingApi', () => ({
  listApplications: vi.fn().mockResolvedValue({ applications: [], total: 0, page: 1, pageSize: 50 }),
}));
vi.mock('@/components/EarningsCard', () => ({
  EarningsCard: () => null,
  useMyEarnings: () => ({ data: { hourlyRate: 20, onClock: false }, dataUpdatedAt: 0 }),
  useTickSeconds: () => 0,
}));

import { listMyTimeEntries } from '@/lib/timeApi';
import { getMyNextPayday } from '@/lib/payrollApi';
import { AssociateDashboard, currentPeriod } from '@/pages/AssociateDashboard';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (n: number) => {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const caps = new Set<Capability>(['view:dashboard']);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthContext.Provider
          value={{
            isInitializing: false,
            isOffline: false,
            user: { id: 'u1', email: 'maria@example.com', role: 'ASSOCIATE', status: 'ACTIVE', clientId: null, associateId: 'a1' } as never,
            role: 'ASSOCIATE',
            primaryRole: 'ASSOCIATE',
            availableRoles: ['ASSOCIATE'],
            capabilities: caps,
            tenant: DEFAULT_TENANT,
            signIn: vi.fn(),
            submitMfaChallenge: vi.fn(),
            signOut: vi.fn(),
            refreshUser: vi.fn(),
            switchRole: vi.fn(),
            can: (c: Capability) => caps.has(c),
          }}
        >
          <AssociateDashboard />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('currentPeriod', () => {
  it('is the next payday’s period when today is inside it', () => {
    expect(currentPeriod({ payDate: '2026-10-16', periodStart: '2026-09-26', periodEnd: '2026-10-09', schedule: 'Biweekly' }, '2026-10-01')).toEqual({
      start: '2026-09-26',
      end: '2026-10-09',
      payDate: '2026-10-16',
    });
  });

  it('steps to the period running today when the next payday pays a closed one', () => {
    // Paid the Friday after: on Oct 12 the next payday (Oct 16) pays Sep 26–Oct 9.
    expect(currentPeriod({ payDate: '2026-10-16', periodStart: '2026-09-26', periodEnd: '2026-10-09', schedule: 'Biweekly' }, '2026-10-12')).toEqual({
      start: '2026-10-10',
      end: '2026-10-23',
      payDate: '2026-10-30',
    });
  });
});

describe('<AssociateDashboard> — earned this pay period', () => {
  it('shows the estimate from clocked hours at their rate, with the ring and the period', async () => {
    vi.mocked(getMyNextPayday).mockResolvedValue({
      nextPayday: { payDate: plus(9), periodStart: plus(-3), periodEnd: plus(10), schedule: 'Biweekly' },
    });
    vi.mocked(listMyTimeEntries).mockResolvedValue({
      entries: [
        { id: 'e1', status: 'APPROVED', minutesElapsed: 480, netMinutes: 450 },
        { id: 'e2', status: 'COMPLETED', minutesElapsed: 300 },
        { id: 'e3', status: 'REJECTED', minutesElapsed: 600 },
      ] as never,
    });
    renderHome();
    const card = await screen.findByTestId('earned-this-period');
    // 450 + 300 minutes = 12.5h × $20 = $250.00; the rejected entry is not counted.
    expect(card).toHaveTextContent('$250.00');
    expect(card).toHaveTextContent('Earned this pay period');
    expect(card).toHaveTextContent('An estimate before taxes');
    expect(screen.getByRole('meter', { name: 'Day 4 of 14' })).toBeInTheDocument();
    expect(vi.mocked(listMyTimeEntries)).toHaveBeenCalled();
  });

  it('is hidden when there is no pay schedule to measure a period by', async () => {
    vi.mocked(getMyNextPayday).mockResolvedValue({ nextPayday: null });
    renderHome();
    // No shifts ahead: the 14-day strip is one line (F500 G5) — the page has rendered.
    expect(await screen.findByTestId('next-14-none')).toHaveTextContent('No shifts in the next 14 days.');
    expect(screen.queryByTestId('earned-this-period')).not.toBeInTheDocument();
  });

  it('is hidden with nothing clocked this period — no "$0.00 · 0h" beside a day ring (F500 G5)', async () => {
    vi.mocked(getMyNextPayday).mockResolvedValue({
      nextPayday: { payDate: plus(9), periodStart: plus(-3), periodEnd: plus(10), schedule: 'Biweekly' },
    });
    vi.mocked(listMyTimeEntries).mockResolvedValue({ entries: [] as never });
    renderHome();
    expect(await screen.findByTestId('next-14-none')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('earned-this-period')).not.toBeInTheDocument();
  });
});
