import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApplicationDetail } from '@alto-people/shared';
import { renderAs } from '../hrPack/harness';

/**
 * Role walk HR 11 and 21 on the application page:
 *   - a "First day" card — start date, store, manager, pay schedule,
 *     clock-in number, first shift, I-9 Section 2 date — each line fixed
 *     where it is shown;
 *   - the header uses the standard small buttons, keeps Resend, Cancel and
 *     Download behind More, and says under Approve why it is off.
 */

vi.mock('@/lib/onboardingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/onboardingApi')>()),
  getFirstDay: vi.fn(),
  patchFirstDay: vi.fn(),
}));
vi.mock('@/lib/kiosk99Api', () => ({ assignKioskPin: vi.fn().mockResolvedValue({ id: 'p1', employeeNumber: '4821' }) }));
vi.mock('@/lib/schedulingApi', () => ({
  listShifts: vi.fn().mockResolvedValue({ shifts: [] }),
  assignShift: vi.fn(),
}));
vi.mock('@/components/ui/AssociatePicker', () => ({
  AssociatePicker: ({ value, onChange }: { value: { id: string; name: string } | null; onChange: (v: { id: string; name: string } | null) => void }) => (
    <button type="button" onClick={() => onChange({ id: 'mgr-2', name: 'Dana Reyes' })}>
      {value ? value.name : 'Pick a manager'}
    </button>
  ),
}));

import { getFirstDay, patchFirstDay, type FirstDay } from '@/lib/onboardingApi';
import { assignKioskPin } from '@/lib/kiosk99Api';
import { FirstDayCard } from '@/pages/onboarding/FirstDayCard';
import { DetailActions } from '@/pages/onboarding/ApplicationDetail';

const FIRST_DAY: FirstDay = {
  startDate: '2026-10-26',
  store: { id: 's1', name: 'Front Beach 218' },
  stores: [
    { id: 's1', name: 'Front Beach 218' },
    { id: 's2', name: 'Bayside' },
  ],
  manager: null,
  employeeNumber: { issued: true, clientId: 'other-client', validAtClient: false },
  firstShift: null,
  i9: { section1CompletedAt: '2026-10-20T12:00:00.000Z', section2CompletedAt: null, section2DueBy: '2026-10-29' },
};

describe('<FirstDayCard> (HR 11)', () => {
  it('lists the seven things day one needs and fixes them in place', async () => {
    vi.mocked(getFirstDay).mockResolvedValue(FIRST_DAY);
    vi.mocked(patchFirstDay).mockImplementation(async (_id, body) => ({ ...FIRST_DAY, startDate: body.startDate ?? FIRST_DAY.startDate }));
    renderAs(
      'HR_ADMINISTRATOR',
      <FirstDayCard applicationId="app1" associateId="a1" clientId="c1" status="APPROVED" payScheduleName="Biweekly (Sat–Fri)" />,
    );
    for (const label of ['Start date', 'Placed at', 'Manager', 'Pay schedule', 'Clock-in number', 'First shift', 'I-9 Section 2']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Biweekly (Sat–Fri)')).toBeInTheDocument();
    expect(screen.getByText(/Filed under another client/)).toBeInTheDocument();
    expect(screen.getByText(/Due .* 3 business days after the start/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the I-9' })).toHaveAttribute('href', '/compliance?tab=i9&associateId=a1');

    // One change, one save.
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-02' } });
    await waitFor(() => expect(patchFirstDay).toHaveBeenCalledWith('app1', { startDate: '2026-11-02' }));

    await userEvent.click(screen.getByRole('button', { name: 'Pick a manager' }));
    await waitFor(() => expect(patchFirstDay).toHaveBeenCalledWith('app1', { managerId: 'mgr-2' }));

    await userEvent.selectOptions(screen.getByLabelText('Store'), 's2');
    await waitFor(() => expect(patchFirstDay).toHaveBeenCalledWith('app1', { locationId: 's2' }));

    // A number filed under another client is re-issued for this one.
    await userEvent.click(screen.getByRole('button', { name: 'Re-issue for this client' }));
    await waitFor(() => expect(assignKioskPin).toHaveBeenCalledWith({ associateId: 'a1', clientId: 'c1' }));

    // No first shift yet: the open shifts at their store, one tap each.
    await userEvent.click(screen.getByRole('button', { name: 'Book one' }));
    expect(await screen.findByText('Every shift at this store is taken')).toBeInTheDocument();
  });

  it('before approval it says what waits for approval instead of offering a dead button', async () => {
    vi.mocked(getFirstDay).mockResolvedValue({ ...FIRST_DAY, employeeNumber: { issued: false, clientId: null, validAtClient: false } });
    renderAs('HR_ADMINISTRATOR', <FirstDayCard applicationId="app1" associateId="a1" clientId="c1" status="SUBMITTED" payScheduleName={null} />);
    expect(await screen.findByText('Issued once the application is approved.')).toBeInTheDocument();
    expect(screen.getByText('Booked once the application is approved.')).toBeInTheDocument();
    expect(screen.getByText(/None covers this hire/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Issue/ })).not.toBeInTheDocument();
  });
});

const detail = (over: Partial<ApplicationDetail> = {}): ApplicationDetail =>
  ({
    id: 'app1',
    associateId: 'a1',
    associateName: 'Maria Lopez',
    clientName: 'Coastal',
    status: 'SUBMITTED',
    percentComplete: 38,
    tasks: [
      { id: 't1', kind: 'PROFILE_INFO', title: 'Profile', status: 'DONE' },
      { id: 't2', kind: 'W4', title: 'W-4', status: 'SKIPPED' },
      { id: 't3', kind: 'POLICY_ACK', title: 'Policies', status: 'PENDING' },
      { id: 't4', kind: 'DIRECT_DEPOSIT', title: 'Payout', status: 'IN_PROGRESS' },
    ],
    ...over,
  }) as unknown as ApplicationDetail;

function renderActions(d: ApplicationDetail, over: Partial<Parameters<typeof DetailActions>[0]> = {}) {
  const handlers = { onResend: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onCancel: vi.fn(), onReopen: vi.fn(), onDirectApprove: vi.fn() };
  renderAs(
    'HR_ADMINISTRATOR',
    <DetailActions
      detail={d}
      {...handlers}
      reopening={false}
      directApproveDate={null}
      directApproveSchedule={null}
      needsSchedule={false}
      directApproving={false}
      {...over}
    />,
  );
  return handlers;
}

describe('<DetailActions> — the application header (HR 21)', () => {
  it('keeps Resend, Cancel and Download behind More', async () => {
    const h = renderActions(detail());
    expect(screen.queryByRole('button', { name: /Resend invite/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View packet/ })).toHaveAttribute('href', expect.stringContaining('?inline=1'));
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
      'Resend invite',
      'Cancel invite',
      'Download packet (PDF)',
    ]);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Resend invite' }));
    expect(h.onResend).toHaveBeenCalled();
  });

  it('says under Approve why it is off — in words, not a hover', () => {
    renderActions(detail());
    const approve = screen.getByRole('button', { name: /^Approve/ });
    expect(approve).toBeDisabled();
    expect(screen.getByText('2 of 4 tasks pending')).toBeInTheDocument();
    expect(approve).toHaveAttribute('aria-describedby', 'approve-why-app1');
  });

  it('a finished checklist with no schedule says so under Approve', () => {
    renderActions(detail({ percentComplete: 100, tasks: [] }), { needsSchedule: true });
    expect(screen.getByRole('button', { name: /^Approve/ })).toBeEnabled();
    expect(screen.getByText('No pay schedule covers this hire yet — choose one as you approve')).toBeInTheDocument();
  });
});
