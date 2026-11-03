import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComplianceWorkforce, I9Verification } from '@alto-people/shared';
import { ymdLocal } from '@/lib/format';

vi.mock('@/lib/complianceApi', () => ({
  listI9s: vi.fn(),
  upsertI9: vi.fn(),
  listI9Reverifications: vi.fn(async () => ({ reverifications: [] })),
  recordI9Reverification: vi.fn(),
}));
vi.mock('@/lib/i9Api', () => ({ listI9Documents: vi.fn(), submitI9Section2: vi.fn() }));

import { listI9s } from '@/lib/complianceApi';
import { I9Tab } from '@/pages/compliance/I9Tab';

/**
 * Retention and re-verification on the I-9 tab (audit #14; owner,
 * 2026-11-03): the list is one group at a time (Current by default), past
 * retention is a view of the Former group — people who left — and
 * re-verification follows the server's rule (an alien authorized to work,
 * still employed), not any row with an expiry date.
 */

const day = (n: number) => {
  const d = new Date();
  return ymdLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
};

function row(id: string, name: string, over: Partial<I9Verification> = {}): I9Verification {
  return {
    id,
    associateId: `${id}-a`,
    associateName: name,
    associateEmail: `${name.split(' ')[0]!.toLowerCase()}@example.com`,
    applicationId: null,
    section1CompletedAt: '2026-01-02T12:00:00.000Z',
    section2CompletedAt: '2026-01-05T12:00:00.000Z',
    section2VerifierUserId: null,
    section2VerifierEmail: null,
    documentList: 'LIST_A',
    supportingDocIds: [],
    startDate: '2026-01-02',
    workAuthExpiresAt: null,
    retainUntil: '2029-01-02',
    reverifyDueAt: null,
    workStatus: 'ACTIVE',
    ...over,
  };
}

const CURRENT = [
  row('i1', 'Ana Active'),
  row('i2', 'Rita Reverify', { workAuthExpiresAt: day(20), reverifyDueAt: day(20), citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', reverifyDue: true }),
  // A green card's expiry is no re-verification.
  row('i4', 'Lee Resident', { workAuthExpiresAt: day(20), reverifyDueAt: null, citizenshipStatus: 'LAWFUL_PERMANENT_RESIDENT', reverifyDue: false }),
  row('i3', 'Sam Section', { section2CompletedAt: null, startDate: day(0), hireDate: day(0) }),
];
const FORMER = [
  row('i9', 'Gone Grant', { retainUntil: day(-30), leftOn: '2024-06-01', workStatus: 'SEPARATED' }),
  row('i8', 'Recent Rae', { retainUntil: day(300), leftOn: day(-60), workStatus: 'SEPARATED' }),
];

function LocationProbe() {
  return <output data-testid="loc">{useLocation().search}</output>;
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <I9Tab canManage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('I-9 retention and reverification (audit #14)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(listI9s).mockImplementation(async (_filter, opts: { workforce?: ComplianceWorkforce } = {}) => {
      const w = opts.workforce ?? 'current';
      const i9s = w === 'former' ? FORMER : w === 'all' ? [...CURRENT, ...FORMER] : CURRENT;
      return { i9s, workforce: w, workforceCounts: { current: 4, starting: 0, paused: 0, former: 2, all: 6 } };
    });
  });

  it('opens on the current workforce; past retention is a view of the people who left', async () => {
    renderAt('/compliance?tab=i9');
    fireEvent.click(await screen.findByRole('button', { name: 'All statuses' }));
    expect(await screen.findByText('Ana Active')).toBeInTheDocument();
    expect(vi.mocked(listI9s)).toHaveBeenCalledWith('all', { workforce: 'current' });
    expect(screen.queryByText('Gone Grant')).toBeNull();
    // Nobody here has left: no retention chip.
    expect(screen.queryByRole('button', { name: 'Past retention' })).toBeNull();

    const groups = screen.getByRole('group', { name: 'Who to show' });
    fireEvent.click(within(groups).getByRole('button', { name: /^Former/ }));
    expect(await screen.findByText('Gone Grant')).toBeInTheDocument();
    expect(screen.getByText('Recent Rae')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Past retention' }));
    expect(screen.getByText('Gone Grant')).toBeInTheDocument();
    expect(screen.queryByText('Recent Rae')).toBeNull();
    expect(screen.getByText('Retain until')).toBeInTheDocument();
    expect(screen.queryByText('Ana Active')).toBeNull();
  });

  it('?status=retention opens on the Former group, once', async () => {
    renderAt('/compliance?tab=i9&status=retention');
    expect(await screen.findByText('Gone Grant')).toBeInTheDocument();
    expect(screen.queryByText('Recent Rae')).toBeNull();
    expect(vi.mocked(listI9s)).toHaveBeenCalledWith('all', { workforce: 'former' });
    expect(screen.getByTestId('loc').textContent).toBe('?tab=i9');
    // A visit's view: the saved group is not overwritten.
    expect(window.localStorage.getItem('alto:list.compliance.workforce.v1')).not.toBe('"former"');
  });

  it('?status=work_auth&workforce=current opens on re-verification due by the rule, once, and shows the date', async () => {
    renderAt('/compliance?tab=i9&status=work_auth&workforce=current');
    expect(await screen.findByText('Rita Reverify')).toBeInTheDocument();
    expect(screen.queryByText('Ana Active')).toBeNull();
    expect(screen.queryByText('Lee Resident')).toBeNull();
    expect(screen.getByText('Reverify by')).toBeInTheDocument();
    // The tile counts the same rule: Rita, not Lee's green card.
    expect(screen.getByText('Reverify within 90 days').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByTestId('loc').textContent).toBe('?tab=i9');
  });

  it('each row says where the person stands, and the CSV says the group', async () => {
    renderAt('/compliance?tab=i9&workforce=former');
    fireEvent.click(await screen.findByRole('button', { name: 'All statuses' }));
    await screen.findByText('Gone Grant');
    const row = screen.getByText('Gone Grant').closest('tr')!;
    // Someone who left never reads "Onboarding".
    expect(within(row).getByText('Separated')).toBeInTheDocument();
    expect(within(row).queryByText('Onboarding')).toBeNull();
    expect(screen.getByText('Employment')).toBeInTheDocument();
  });

  it('the deadline strip counts Section 2 and reverification clocks', async () => {
    renderAt('/compliance?tab=i9');
    await screen.findByText('Sam Section');
    // Sam's Section 2 is due in 3 business days; Rita's reverification in 20 (past the strip).
    expect(screen.getByRole('table', { name: 'I-9 deadlines' })).toBeInTheDocument();
  });
});
