import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/schedulingApi', () => ({
  getMyAvailability: vi.fn(),
  replaceMyAvailability: vi.fn(),
  listMyAvailabilityExceptions: vi.fn().mockResolvedValue({ exceptions: [] }),
  addAvailabilityException: vi.fn(),
  deleteAvailabilityException: vi.fn(),
}));

import { getMyAvailability, replaceMyAvailability } from '@/lib/schedulingApi';
import { AvailabilityEditor, presetWindows } from '@/pages/scheduling/AvailabilityEditor';

/**
 * Role walk, floor 11: a new hire with no windows used to read "HR will
 * treat you as fully unavailable" and nothing happened. Now a preset fills
 * the week in one tap.
 */

function renderEditor() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AvailabilityEditor />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMyAvailability).mockResolvedValue({ windows: [] });
});

describe('availability presets', () => {
  it('describe a week', () => {
    expect(presetWindows('weekdays')).toHaveLength(5);
    expect(presetWindows('weekdays')[0]).toEqual({ dayOfWeek: 1, start: '09:00', end: '17:00' });
    expect(presetWindows('weekends').map((w) => w.dayOfWeek)).toEqual([6, 0]);
    expect(presetWindows('nights')).toHaveLength(7);
    expect(presetWindows('nights')[0]).toMatchObject({ start: '16:00', end: '23:00' });
    expect(presetWindows('any')).toHaveLength(7);
  });

  it('offers presets when nothing is set and saves the one tapped', async () => {
    const user = userEvent.setup();
    vi.mocked(replaceMyAvailability).mockResolvedValue({
      windows: presetWindows('weekdays').map((w, i) => ({ id: `w${i}`, dayOfWeek: w.dayOfWeek, startMinute: 540, endMinute: 1020 })),
    } as never);
    renderEditor();
    expect(await screen.findByText('Pick when you can work')).toBeInTheDocument();
    expect(screen.queryByText(/fully unavailable/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Weekdays 9–5' }));
    // Five rows, the presets gone.
    expect(screen.queryByTestId('availability-presets')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(replaceMyAvailability).toHaveBeenCalledTimes(1));
    expect(vi.mocked(replaceMyAvailability).mock.calls[0][0]).toEqual({
      windows: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 })),
    });
  });

  it('shows no presets once windows exist', async () => {
    vi.mocked(getMyAvailability).mockResolvedValue({ windows: [{ id: 'w1', dayOfWeek: 1, startMinute: 540, endMinute: 1020 }] } as never);
    renderEditor();
    expect(await screen.findByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByTestId('availability-presets')).not.toBeInTheDocument();
  });
});
