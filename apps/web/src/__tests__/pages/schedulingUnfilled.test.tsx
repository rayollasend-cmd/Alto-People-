import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiMock, makeShift, renderSchedule, type ApiWorld } from './scheduling/scheduleHarness';

/**
 * Role walk, ops 6 / HR 19 — past shifts are unfilled, not open. A shift
 * that ended with nobody assigned reads "Unfilled", offers no Assign or
 * Auto-fill, is left out of the open count, and a one-time close-out
 * cancels it with the reason "unfilled".
 */

const world: ApiWorld = { shifts: [], calls: [] };
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return { ...real, apiFetch: (url: string, init?: { method?: string; body?: unknown }) => apiMock(world)(url, init) };
});
vi.mock('@/lib/storeScope', async (orig) => ({
  ...(await orig<typeof import('@/lib/storeScope')>()),
  useStoreScope: () => ({ clientId: '', setClientId: () => {}, clients: [], loading: false }),
}));

import { AdminSchedulingView } from '@/pages/scheduling/AdminSchedulingView';

const HOUR = 3_600_000;
const PAST = '44444444-4444-4444-8444-444444444444';
const FUTURE = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  world.calls = [];
  world.shifts = [
    makeShift({ id: PAST, startsAt: new Date(Date.now() - 30 * HOUR).toISOString(), endsAt: new Date(Date.now() - 22 * HOUR).toISOString() }),
    makeShift({ id: FUTURE }),
  ];
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('past open shifts are unfilled', () => {
  it('reads Unfilled with no Assign, the open count separates upcoming from unfilled, and close-out cancels them', async () => {
    const user = userEvent.setup();
    // The All chip over a window that holds both (this mock answers every
    // query with both rows; the chips' own queries are schedulingListOpens).
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=list&status=ALL&from=2020-01-01&to=2099-12-31');

    // The KPI line: "1 open · 1 unfilled", never "2 open".
    await waitFor(() => expect(screen.getByTestId('kpi-line')).toHaveTextContent('1 open · 1 unfilled'));

    const unfilled = await screen.findByText('Unfilled');
    const pastRow = unfilled.closest('tr') ?? unfilled.closest('[data-row]') ?? unfilled.parentElement!.parentElement!;
    expect(within(pastRow as HTMLElement).queryByRole('button', { name: /assign/i })).not.toBeInTheDocument();
    expect(within(pastRow as HTMLElement).queryByRole('button', { name: /auto-fill/i })).not.toBeInTheDocument();

    // The future one is still open, with its buttons.
    const openBadges = screen.getAllByText('Open');
    expect(openBadges.length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^assign$/i }).length).toBe(1);

    // Close out: confirm, then the API call scoped to the visible range.
    await user.click(screen.getByTestId('close-out-unfilled'));
    await user.click(await screen.findByRole('button', { name: /^close out$/i }));
    await waitFor(() => expect(world.calls.some((c) => c.url === '/scheduling/shifts/close-out-unfilled' && c.init?.method === 'POST')).toBe(true));
    const call = world.calls.find((c) => c.url === '/scheduling/shifts/close-out-unfilled')!;
    expect(call.init?.body).toMatchObject({ from: expect.any(String), to: expect.any(String) });
  });
});
