import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Shift } from '@alto-people/shared';
import { I18nProvider } from '@/lib/i18n';
import { TooltipProvider } from '@/components/ui/Tooltip';

/**
 * Audit Tier 1 #9 — schedule-change pay is owed but was never captured.
 * The API parses `changeReason` on the four scheduling writes; no form
 * sent one. Now the Cancel dialog carries the field, requires it for a
 * published shift inside a fair-workweek notice window, and sends it.
 */

vi.mock('@/lib/schedulingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/schedulingApi')>()),
  cancelShift: vi.fn(async () => ({})),
}));

import { cancelShift } from '@/lib/schedulingApi';
import { changeReasonRequired } from '@/pages/scheduling/ChangeReasonField';
import { CancelDialog } from '@/pages/scheduling/AdminSchedulingView';

const DAY = 86_400_000;
function shift(over: Partial<Shift>): Shift {
  const startsAt = new Date(Date.now() + 3 * DAY).toISOString();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    clientId: null,
    clientName: null,
    position: 'Housekeeper',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 8 * 3_600_000).toISOString(),
    location: null,
    locationId: null,
    locationName: 'Front Beach',
    timezone: 'America/Chicago',
    fairWorkweekNoticeDays: 14,
    hourlyRate: null,
    payRate: null,
    effectivePayRate: null,
    status: 'ASSIGNED',
    assignedAssociateId: '22222222-2222-4222-8222-222222222222',
    assignedAssociateName: 'Ana Lopez',
    notes: null,
    cancellationReason: null,
    publishedAt: new Date().toISOString(),
    lateNoticeReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as Shift;
}

function renderCancel(target: Shift) {
  const onCancelled = vi.fn();
  render(
    <I18nProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <MemoryRouter>
            <CancelDialog target={target} onClose={vi.fn()} onCancelled={onCancelled} />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { onCancelled };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('changeReasonRequired', () => {
  it('is required for a published shift in a fair-workweek jurisdiction inside its notice window', () => {
    expect(changeReasonRequired(shift({}))).toBe(true);
  });
  it('is not required outside the window, for a draft, or where no notice rule applies', () => {
    expect(changeReasonRequired(shift({ startsAt: new Date(Date.now() + 20 * DAY).toISOString() }))).toBe(false);
    expect(changeReasonRequired(shift({ status: 'DRAFT', publishedAt: null }))).toBe(false);
    expect(changeReasonRequired(shift({ fairWorkweekNoticeDays: null }))).toBe(false);
  });
});

describe('<CancelDialog> schedule-change reason', () => {
  it('blocks a cancel without a reason in a predictability-pay jurisdiction, then sends the reason', async () => {
    const user = userEvent.setup();
    const { onCancelled } = renderCancel(shift({}));
    await user.type(screen.getByPlaceholderText(/required for the audit trail/i), 'Client cut the shift');
    await user.click(screen.getByRole('button', { name: /^cancel shift$/i }));
    expect(await screen.findByText(/pick a reason/i)).toBeInTheDocument();
    expect(cancelShift).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByTestId('change-reason'), 'EMERGENCY');
    await user.click(screen.getByRole('button', { name: /^cancel shift$/i }));
    await waitFor(() => expect(cancelShift).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cancelShift).mock.calls[0]![1]).toMatchObject({ reason: 'Client cut the shift', changeReason: 'EMERGENCY' });
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
  });

  it('needs no reason where predictability pay does not apply', async () => {
    const user = userEvent.setup();
    renderCancel(shift({ fairWorkweekNoticeDays: null }));
    // Folded: the field is one line to open, not in the way.
    expect(screen.queryByTestId('change-reason')).not.toBeInTheDocument();
    expect(screen.getByTestId('change-reason-toggle')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/required for the audit trail/i), 'No longer needed');
    await user.click(screen.getByRole('button', { name: /^cancel shift$/i }));
    await waitFor(() => expect(cancelShift).toHaveBeenCalledTimes(1));
    expect(vi.mocked(cancelShift).mock.calls[0]![1]).not.toHaveProperty('changeReason');
  });
});
