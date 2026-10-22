import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiMock, asPhone, makeShift, renderSchedule, type ApiWorld } from './scheduling/scheduleHarness';

/**
 * Role walk, ops 14 / floor 9 — scheduling on a phone: a day agenda with
 * a sticky 7-day strip, cards that name the store and client, the KPIs
 * as one scrolling line, the filters in a sheet, and a bottom sheet with
 * Assign / Edit / Cancel on tap.
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

let restore: () => void;
beforeEach(() => {
  restore = asPhone();
  world.calls = [];
  const today = new Date();
  today.setHours(9, 0, 0, 0);
  world.shifts = [makeShift({ id: '66666666-6666-4666-8666-666666666666', startsAt: today.toISOString(), endsAt: new Date(today.getTime() + 8 * 3_600_000).toISOString() })];
  window.localStorage.clear();
});
afterEach(() => {
  restore();
  cleanup();
  vi.clearAllMocks();
});

describe('scheduling on a phone', () => {
  it('shows the day agenda with a 7-day strip, store and client on the card, the filter sheet, and the action sheet on tap', async () => {
    const user = userEvent.setup();
    renderSchedule(<AdminSchedulingView canManage />, '/scheduling?view=day');

    // The sticky strip and the card with store · client.
    const strip = await screen.findByTestId('mobile-day-strip');
    const list = within(strip.parentElement as HTMLElement);
    const card = await list.findByText(/Housekeeper/, { selector: 'div' });
    expect(card).toHaveTextContent('The Grand Hotel');
    expect(card).toHaveTextContent('Front Beach');

    // KPIs read as one line.
    await waitFor(() => expect(screen.getByTestId('kpi-line')).toHaveTextContent(/open/));

    // The filters live in a sheet.
    await user.click(screen.getByRole('button', { name: /filter…|edit filters/i }));
    expect(await screen.findByRole('heading', { name: 'Filters' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Tapping the card opens the action sheet with Assign / Edit / Cancel.
    await user.click(card.closest('button')!);
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveTextContent('Housekeeper');
    expect(screen.getByRole('button', { name: /^assign$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel shift/i })).toBeInTheDocument();
  });
});
