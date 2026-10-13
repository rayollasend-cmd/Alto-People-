import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MyEmergencyResponse } from '@alto-people/shared';

vi.mock('@/lib/emergencyApi', () => ({ getMyEmergency: vi.fn(), emergencyCheckIn: vi.fn() }));

import { emergencyCheckIn, getMyEmergency } from '@/lib/emergencyApi';
import { EmergencyBanner } from '@/components/EmergencyBanner';

/**
 * The one tap. Nothing renders in ordinary times; during an emergency the
 * card leads with the message in the associate's language and two buttons,
 * and after a tap it says what was recorded and when.
 */

const active: MyEmergencyResponse = {
  emergency: {
    id: 'e1',
    title: 'Hurricane Delta',
    message: 'Quédate en casa. Te avisaremos cuando sea seguro volver.',
    startsAt: '2026-10-13T12:00:00.000Z',
    pickupAt: '2026-10-13T18:00:00.000Z',
    declaredAt: '2026-10-13T11:00:00.000Z',
    rideOffered: true,
  },
  checkIn: null,
};

function renderBanner() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EmergencyBanner />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getMyEmergency).mockReset();
  vi.mocked(emergencyCheckIn).mockReset();
});

describe('EmergencyBanner', () => {
  it('renders nothing when no emergency includes this person', async () => {
    vi.mocked(getMyEmergency).mockResolvedValue({ emergency: null, checkIn: null });
    const { container } = renderBanner();
    await waitFor(() => expect(getMyEmergency).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the message as sent and records a one-tap "I\'m safe" with the ride switch', async () => {
    vi.mocked(getMyEmergency).mockResolvedValue(active);
    vi.mocked(emergencyCheckIn).mockResolvedValue({
      ...active,
      checkIn: { status: 'SAFE', needsRide: true, respondedAt: '2026-10-13T11:30:00.000Z', ride: { status: 'REQUESTED', pickupAt: null } },
    });
    renderBanner();
    expect(await screen.findByText('Quédate en casa. Te avisaremos cuando sea seguro volver.')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/I need a ride/i));
    await userEvent.click(screen.getByRole('button', { name: /i'm safe/i }));
    expect(emergencyCheckIn).toHaveBeenCalledWith('e1', { status: 'SAFE', needsRide: true });
    expect(await screen.findByText(/you checked in safe at/i)).toBeInTheDocument();
    expect(screen.getByText(/dispatch is placing you on a van/i)).toBeInTheDocument();
  });

  it('sends "I need help" and says so when the address is missing for a ride', async () => {
    vi.mocked(getMyEmergency).mockResolvedValue(active);
    const { ApiError } = await import('@/lib/api');
    vi.mocked(emergencyCheckIn).mockRejectedValue(new ApiError(409, 'no_address', 'no address'));
    renderBanner();
    await screen.findByText(/Hurricane Delta/);
    await userEvent.click(screen.getByRole('button', { name: /i need help/i }));
    expect(emergencyCheckIn).toHaveBeenCalledWith('e1', { status: 'NEEDS_HELP', needsRide: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(/no address on file/i);
  });
});
