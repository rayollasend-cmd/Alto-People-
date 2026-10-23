import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The home focus row is the app's KPI tile (F500 SH-2): numbers computed
 * from what the APIs return, each tile a link, and an empty day said in
 * words — the ops row used to show "Coverage today 0 / 0 · Every shift
 * filled" and "Open positions 0 · 0 of 0 FTE filled".
 */

const role = { current: 'OPERATIONS_MANAGER' };
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  useAuth: () => ({ role: role.current, user: { id: 'me' }, can: () => true }),
  useTerm: () => (k: string) => (k === 'sites' ? 'Stores' : k === 'workers' ? 'Associates' : k),
}));
const overview = { current: null as unknown };
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => {
    if (path === '/workforce/overview') return overview.current;
    throw new Error(`unexpected ${path}`);
  }),
}));
const labor = { current: { rows: [] as Array<{ workedMinutes: number; scheduledMinutes: number }> } };
vi.mock('@/lib/schedulingApi', () => ({ laborCosts: vi.fn(async () => labor.current) }));
const headcount = { current: { total: 0, byStatus: {}, fteAuthorized: '0', fteFilled: '0' } as unknown };
vi.mock('@/lib/positionsApi', () => ({ getHeadcount: vi.fn(async () => headcount.current) }));
const inbox = { current: { sources: [] as Array<{ key: string; count: number; path: string }> } };
vi.mock('@/lib/inboxApi', async () => {
  const { useQuery } = await import('@tanstack/react-query');
  return { useInbox: () => useQuery({ queryKey: ['inbox-test'], queryFn: async () => inbox.current }) };
});

import { RoleFocusRow } from '@/components/home/RoleFocusRow';

function renderRow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RoleFocusRow />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tile = (label: string) => screen.getByRole('link', { name: new RegExp(label) });

beforeEach(() => {
  role.current = 'OPERATIONS_MANAGER';
});

describe('RoleFocusRow — operations', () => {
  it('computes each tile from the data and links it to the list behind it', async () => {
    overview.current = { now: { onFloor: 6, scheduledNow: 8 }, today: { filled: 5, open: 2 }, week: { start: '2026-10-17', fillRatePct: 84 } };
    labor.current = { rows: [{ workedMinutes: 600, scheduledMinutes: 900 }, { workedMinutes: 330, scheduledMinutes: 300 }] };
    headcount.current = { total: 9, byStatus: { OPEN: 3, FILLED: 6 }, fteAuthorized: '9', fteFilled: '6' };
    renderRow();
    const coverage = await screen.findByRole('link', { name: /Coverage today/ });
    expect(within(coverage).getByText('5 / 7')).toBeInTheDocument();
    expect(within(coverage).getByText('2 shifts still open')).toBeInTheDocument();
    // Every store at once (role walk HR 6), not the month-long list.
    expect(coverage).toHaveAttribute('href', '/scheduling/coverage');
    expect(within(tile('Fill rate this week')).getByText('84%')).toBeInTheDocument();
    // 930 worked minutes → 16h (rounded), against 1,200 scheduled → 20h.
    expect(await within(tile('Hours worked this week')).findByText('16')).toBeInTheDocument();
    expect(within(tile('Hours worked this week')).getByText('against 20 scheduled across stores')).toBeInTheDocument();
    expect(await within(tile('Open positions')).findByText('3')).toBeInTheDocument();
    expect(tile('Open positions')).toHaveAttribute('href', '/org?tab=positions');
    expect(screen.getByRole('group', { name: 'Your floor this week' })).toBeInTheDocument();
  });

  it('an empty day says so in words, never "0 / 0 · Every shift filled"', async () => {
    overview.current = { now: { onFloor: 0, scheduledNow: 0 }, today: { filled: 0, open: 0 }, week: { start: '2026-10-17', fillRatePct: null } };
    labor.current = { rows: [] };
    headcount.current = { total: 0, byStatus: {}, fteAuthorized: '0', fteFilled: '0' };
    renderRow();
    expect(await screen.findByText('No shifts today')).toBeInTheDocument();
    expect(screen.queryByText('0 / 0')).toBeNull();
    expect(screen.queryByText('Every shift filled')).toBeNull();
    expect(screen.getByText('No shifts this week')).toBeInTheDocument();
    expect(await screen.findByText('No hours scheduled this week')).toBeInTheDocument();
    expect(await screen.findByText('No positions set up')).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0 FTE/)).toBeNull();
  });
});

describe('RoleFocusRow — one open shift', () => {
  it('is singular', async () => {
    overview.current = { now: { onFloor: 2, scheduledNow: 2 }, today: { filled: 3, open: 1 }, week: { start: '2026-10-17', fillRatePct: 95 } };
    renderRow();
    expect(await screen.findByText('1 shift still open')).toBeInTheDocument();
  });
});

describe('RoleFocusRow — HR', () => {
  it('legal clocks at zero are real answers, in the quiet colour', async () => {
    role.current = 'HR_ADMINISTRATOR';
    inbox.current = {
      sources: [
        { key: 'leave-desk', count: 0, path: '/leave' },
        { key: 'ui-claims', count: 1, path: '/claims/unemployment' },
        { key: 'wc-claims', count: 0, path: '/claims/workers-comp' },
        { key: 'everify-mismatches', count: 2, path: '/compliance?tab=everify' },
        { key: 'onboarding-stuck', count: 0, path: '/onboarding' },
      ],
    };
    const { container } = renderRow();
    const leave = await screen.findByRole('link', { name: /Leave notices due/ });
    const leaveValue = leave.querySelector('[data-metric-value]')!;
    expect(leaveValue.textContent).toBe('0');
    expect(leaveValue).not.toHaveClass('text-alert');
    const everify = tile('E-Verify mismatches').querySelector('[data-metric-value]')!;
    // Counts up on first paint.
    await waitFor(() => expect(everify.textContent).toBe('2'));
    expect(everify).toHaveClass('text-alert');
    expect(within(tile('Claims to answer')).getByText('1 unemployment · 0 workers’ comp')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-metric-strip] > div')).toHaveLength(4);
  });
});
