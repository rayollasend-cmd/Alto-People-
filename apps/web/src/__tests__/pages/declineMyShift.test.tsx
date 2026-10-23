import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', () => ({
  listMyShifts: vi.fn(),
  getMyShiftDetail: vi.fn(),
  listSwapCandidates: vi.fn(),
  createSwap: vi.fn(),
  getMyCalendarUrl: vi.fn().mockResolvedValue({ url: 'https://x.test/a.ics', webcalUrl: 'webcal://x.test/a.ics' }),
  rotateMyCalendarUrl: vi.fn(),
  listSwapsIncoming: vi.fn().mockResolvedValue({ requests: [] }),
  listSwapsOutgoing: vi.fn().mockResolvedValue({ requests: [] }),
  getMyAvailability: vi.fn().mockResolvedValue({ windows: [] }),
  replaceMyAvailability: vi.fn(),
  listMyShiftHistory: vi.fn().mockResolvedValue({ shifts: [], nextBefore: null }),
  acknowledgeMyShift: vi.fn(),
  listMyOpenShifts: vi.fn().mockResolvedValue({ shifts: [] }),
  claimOpenShift: vi.fn(),
  withdrawOpenShiftClaim: vi.fn(),
  declineMyShift: vi.fn(),
  listTradeOptions: vi.fn().mockResolvedValue({ options: [] }),
  listMyAvailabilityExceptions: vi.fn().mockResolvedValue({ exceptions: [] }),
  addAvailabilityException: vi.fn(),
  deleteAvailabilityException: vi.fn(),
}));
vi.mock('@/lib/timeOffApi', () => ({ listMyRequests: vi.fn().mockResolvedValue({ requests: [] }) }));
vi.mock('@/lib/timeApi', () => ({ getActiveTimeEntry: vi.fn().mockResolvedValue({ active: null }) }));
vi.mock('@/components/ui/Toaster', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/settingsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/settingsApi')>()),
  patchNotificationPreference: vi.fn(),
}));

import { ApiError } from '@/lib/api';
import { declineMyShift, getMyAvailability, listMyShifts } from '@/lib/schedulingApi';
import { patchNotificationPreference } from '@/lib/settingsApi';
import { toast } from '@/components/ui/Toaster';
import { AssociateScheduleView, canDeclineShift } from '@/pages/scheduling/AssociateScheduleView';
import { ConfirmProvider } from '@/lib/confirm';

/**
 * Audit Tier 3 (decline-my-shift) and role walk floor 11: "I can't make
 * it" on a shift the agent asked about; the open-shifts section says why
 * it is empty instead of vanishing; empty availability gets a prompt.
 */

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const H = 3_600_000;
const shift = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  clientId: 'c1',
  clientName: 'Publix 1424',
  position: 'F&D Morning Shift',
  startsAt: new Date(Date.now() + 24 * H).toISOString(),
  endsAt: new Date(Date.now() + 32 * H).toISOString(),
  location: 'Front end',
  hourlyRate: null,
  payRate: null,
  status: 'ASSIGNED',
  notes: null,
  locationId: 'l1',
  locationName: 'Store 1424',
  timezone: browserTz,
  assignedAssociateId: 'a',
  assignedAssociateName: 'Maria Lopez',
  assignedAt: null,
  cancellationReason: null,
  scheduledMinutes: 480,
  publishedAt: new Date().toISOString(),
  lateNoticeReason: null,
  acknowledgedAt: null,
  ...over,
});
const asked = { askedAt: new Date().toISOString(), cutoffAt: new Date(Date.now() + 20 * H).toISOString(), answer: null };

function renderView() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ConfirmProvider>
        <MemoryRouter>
          <AssociateScheduleView />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getMyAvailability).mockResolvedValue({ windows: [] });
});

describe('canDeclineShift', () => {
  const now = Date.now();
  it('is only an asked, unanswered, published, future, assigned shift', () => {
    expect(canDeclineShift(shift({ confirmationAsk: asked }) as never, now)).toBe(true);
    expect(canDeclineShift(shift() as never, now)).toBe(false);
    expect(canDeclineShift(shift({ confirmationAsk: { ...asked, answer: 'YES' } }) as never, now)).toBe(false);
    expect(canDeclineShift(shift({ confirmationAsk: asked, publishedAt: null }) as never, now)).toBe(false);
    expect(canDeclineShift(shift({ confirmationAsk: asked, startsAt: new Date(now - H).toISOString() }) as never, now)).toBe(false);
  });
});

describe('"I can\'t make it"', () => {
  it('declines the asked shift after a confirm and swaps the row in place', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift({ confirmationAsk: asked })] as never });
    vi.mocked(declineMyShift).mockResolvedValue(shift({ confirmationAsk: { ...asked, answer: 'NO' } }) as never);
    const user = renderView();
    const row = await screen.findByTestId('decline-my-shift');
    await user.click(within(row).getByRole('button', { name: /I can't make it/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /I can't make it/ }));
    await waitFor(() => expect(declineMyShift).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(screen.queryByTestId('decline-my-shift')).not.toBeInTheDocument());
  });

  it('is not offered on a shift nobody asked about, and explains a 409', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift()] as never });
    renderView();
    await screen.findByRole('button', { name: /F&D Morning Shift/ });
    expect(screen.queryByTestId('decline-my-shift')).not.toBeInTheDocument();
  });

  it('says to talk to the supervisor when the server answers not_asked', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift({ confirmationAsk: asked })] as never });
    vi.mocked(declineMyShift).mockRejectedValue(new ApiError(409, 'not_asked', 'nope'));
    const user = renderView();
    const row = await screen.findByTestId('decline-my-shift');
    await user.click(within(row).getByRole('button', { name: /I can't make it/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /I can't make it/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Talk to your supervisor, or ask for the day off.'));
    expect(screen.getByTestId('decline-my-shift')).toBeInTheDocument();
  });
});

describe('empty open shifts and empty availability', () => {
  it('shows why nothing is offered, turns notifications on in one tap, and prompts for availability', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift()] as never });
    vi.mocked(patchNotificationPreference).mockResolvedValue(undefined);
    const user = renderView();
    expect(await screen.findByTestId('no-open-shifts')).toHaveTextContent('No open shifts right now');
    await user.click(screen.getByRole('button', { name: /Notify me/ }));
    await waitFor(() => expect(patchNotificationPreference).toHaveBeenCalledWith('scheduling', { inAppEnabled: true, emailEnabled: true, pushEnabled: true }));
    expect(await screen.findByTestId('availability-prompt')).toHaveTextContent('Set your availability');
  });

  it('keeps quiet about availability once windows exist', async () => {
    vi.mocked(listMyShifts).mockResolvedValue({ shifts: [shift()] as never });
    vi.mocked(getMyAvailability).mockResolvedValue({ windows: [{ id: 'w', dayOfWeek: 1, startMinute: 540, endMinute: 1020 }] } as never);
    renderView();
    await screen.findByRole('button', { name: /F&D Morning Shift/ });
    await waitFor(() => expect(screen.queryByTestId('availability-prompt')).not.toBeInTheDocument());
  });
});
