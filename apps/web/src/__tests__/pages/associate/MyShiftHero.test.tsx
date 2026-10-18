import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', () => ({
  getMyShiftDetail: vi.fn().mockResolvedValue({ shift: {}, teammates: [], supervisors: [] }),
  acknowledgeMyShift: vi.fn(),
}));
const callOutMine = vi.fn().mockResolvedValue({ callOutId: 'c1', outcome: 'confirmed', message: 'Got it — you are called out.' });
vi.mock('@/lib/callOutsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callOutsApi')>()),
  callOutMine: (...a: unknown[]) => callOutMine(...a),
  listMyCallOuts: vi.fn().mockResolvedValue({ callOuts: [] }),
}));
vi.mock('@/components/EarningsCard', () => ({
  useMyEarnings: () => ({
    data: { onClock: true, currentShiftEarned: 48.5, currentRatePerHour: 15 },
    dataUpdatedAt: Date.now(),
  }),
  useTickSeconds: () => 0,
}));

import { MyShiftHero } from '@/pages/associate/MyShiftHero';

describe('<MyShiftHero> on the clock', () => {
  it('shows what this shift has earned so far, at the top, while they work', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <MyShiftHero
            active={{ active: { id: 'e1', clockInAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } } as never}
            shifts={[]}
            openShiftCount={null}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('$48.50 earned this shift')).toBeInTheDocument();
    expect(screen.getByText('3h')).toBeInTheDocument();
  });
});

/** A shift tomorrow, assigned and not yet confirmed; `ask` is the Workforce agent's attendance.confirm. */
function upcoming(ask: { answer: 'YES' | 'NO' | null } | null) {
  const startsAt = new Date(Date.now() + 26 * 3_600_000);
  return {
    id: 's1',
    status: 'ASSIGNED',
    position: 'Housekeeper',
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 8 * 3_600_000).toISOString(),
    acknowledgedAt: null,
    locationName: 'The Grand Hotel',
    location: null,
    timezone: 'America/Chicago',
    confirmationAsk: ask ? { askedAt: new Date().toISOString(), cutoffAt: new Date(startsAt.getTime() - 12 * 3_600_000).toISOString(), answer: ask.answer } : null,
  };
}

function renderHero(shift: ReturnType<typeof upcoming>) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MyShiftHero active={{ active: null } as never} shifts={[shift] as never} openShiftCount={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<MyShiftHero> calling out', () => {
  it('offers "I can\x27t make it" on any upcoming shift; it calls out with a reason, after the person picks one', async () => {
    renderHero(upcoming(null));
    expect(await screen.findByRole('button', { name: "I'll be there" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "I can't make it" }));
    const send = await screen.findByRole('button', { name: 'Call out' });
    expect(send).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'Ride or transportation' }));
    await userEvent.type(screen.getByLabelText(/anything your lead should know/i), 'Car won’t start');
    await userEvent.click(send);
    await waitFor(() => expect(callOutMine).toHaveBeenCalledWith({ shiftId: 's1', reason: 'TRANSPORT', note: 'Car won’t start' }));
  });

  it('after a NO to the agent, says cover is being found and still lets them change their mind', async () => {
    renderHero(upcoming({ answer: 'NO' }));
    expect(await screen.findByText("You said you can't make it. We are looking for cover.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I can't make it" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I'll be there" })).toBeInTheDocument();
  });
});
