import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

const api = vi.hoisted(() => ({
  getLaborActivations: vi.fn(),
  getChangeReport: vi.fn(),
  goLive: vi.fn(),
  backToShadow: vi.fn(),
  getMyCorrections: vi.fn(),
  getMyOtOffers: vi.fn(),
  submitCorrection: vi.fn(),
  finishPromptedCorrection: vi.fn(),
  withdrawCorrection: vi.fn(),
  answerMyOtOffer: vi.fn(),
  listCorrections: vi.fn(),
  decideCorrection: vi.fn(),
  listBreakFlags: vi.fn(),
  acknowledgeBreakFlag: vi.fn(),
  getRotation: vi.fn(),
  offerShift: vi.fn(),
  recordOfferAnswer: vi.fn(),
}));
vi.mock('@/lib/laborLiveApi', () => api);

import { LaborGoLiveTab } from '@/pages/payroll/LaborGoLive';
import { PunchFixes } from '@/pages/time/PunchFixes';
import { TimeCorrectionsDesk } from '@/pages/time/TimeCorrectionsDesk';
import { OvertimeRotationPanel } from '@/pages/scheduling/OvertimeRotationPanel';
import { ApiError } from '@/lib/api';

const ATTESTATION = 'I confirm that counsel has reviewed the rules listed here against the cited sources, and that this organization will pay the people who work in this jurisdiction by them from the date this goes live.';

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getLaborActivations.mockResolvedValue({
    attestation: ATTESTATION,
    jurisdictions: [
      { jurisdiction: 'US-CA', label: 'California', sites: [{ id: 's1', name: 'San Diego 12', activation: null }], current: null, history: [] },
      {
        jurisdiction: 'US-NY',
        label: 'New York',
        sites: [],
        current: { id: 'a1', jurisdiction: 'US-NY', siteId: null, status: 'LIVE', signedLabels: ['US-NY 2026-01-01 v1'], counselName: 'Dana Whit', counselFirm: 'Whit & Co', counselSignedOn: '2026-10-01', changeReport: null, approvalRequestId: null, requestedBy: 'Hana Ruiz', activatedBy: 'Omar Diaz', activatedAt: '2026-10-02T10:00:00Z', endedBy: null, endedAt: null, endReason: null, createdAt: '2026-10-01T10:00:00Z' },
        history: [],
      },
    ],
  });
  api.getChangeReport.mockResolvedValue({
    jurisdiction: 'US-CA',
    siteId: null,
    runs: [{ id: 'r1', periodStart: '2026-09-12', periodEnd: '2026-09-25' }],
    people: 1,
    amountDifference: 100,
    premiumAmount: 40,
    byRule: { OVERTIME: 60, MEAL: 20, REST: 20, REST_BETWEEN_SHIFTS: 0 },
    rows: [{ associateId: 'p1', name: 'Ana Ruiz', hourlyRate: 20, paid: 200, live: 300, difference: 100, premiumHours: 2, premiumAmount: 40, reasons: [] }],
    signables: [{ id: 'x1', label: 'US-CA 2026-01-01 v1', source: 'Cal. Lab. Code §510', status: 'DRAFT' }],
  });
});

describe('labor rules: by state', () => {
  it('shows each state’s status, and going live needs the change report read, counsel and the attestation', async () => {
    api.goLive.mockResolvedValue({ pending: true, approvalId: 'ap1', activationId: 'act1', title: 'Waiting' });
    renderAs('HR_ADMINISTRATOR', <LaborGoLiveTab />);
    expect(await screen.findByText('California')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText(/Paying by New York’s rules/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Review and go live' }));
    expect(await screen.findByText('People affected')).toBeInTheDocument();
    expect(screen.getAllByText('+$100.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Cal. Lab. Code §510')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Submit for approval/ });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Counsel’s name/), 'Dana Whit');
    await userEvent.type(screen.getByLabelText(/Firm or role/), 'Whit & Co LLP');
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(api.goLive).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: 'US-CA', counselName: 'Dana Whit', counselFirm: 'Whit & Co LLP', attestation: ATTESTATION })));
  });

  it('back to shadow asks why', async () => {
    api.backToShadow.mockResolvedValue({ id: 'a1', status: 'ENDED' });
    renderAs('HR_ADMINISTRATOR', <LaborGoLiveTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back to shadow' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Back to shadow' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Why/), 'Counsel asked us to pause.');
    await userEvent.click(confirm);
    await waitFor(() => expect(api.backToShadow).toHaveBeenCalledWith('a1', 'Counsel asked us to pause.'));
  });

  it('someone who can only read sees no buttons', async () => {
    renderAs('FINANCE_ACCOUNTANT', <LaborGoLiveTab />);
    expect(await screen.findByText('California')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review and go live' })).toBeNull();
  });
});

describe('punch fixes on the phone', () => {
  it('a worker finishes the missed clock-out the kiosk flagged, with the attestation', async () => {
    api.getMyOtOffers.mockResolvedValue({ offers: [] });
    api.getMyCorrections.mockResolvedValue({
      attestation: 'I certify…',
      requests: [{ id: 'c1', associateId: 'a', name: 'Ana', kind: 'MISSED_CLOCK_OUT', status: 'PROMPTED', workDate: '2026-10-13', siteName: null, timeEntryId: 'e1', proposedClockIn: null, proposedClockOut: null, reason: null, attestationText: null, attestedAt: null, before: null, after: null, decidedBy: null, decidedAt: null, decisionReason: null, createdAt: '2026-10-14T10:00:00Z' }],
      entries: [{ id: 'e1', clockInAt: '2026-10-13T13:00:00Z', clockOutAt: null, status: 'ACTIVE', siteName: 'San Diego 12' }],
      sites: [{ id: 's1', name: 'San Diego 12' }],
    });
    api.finishPromptedCorrection.mockResolvedValue({ id: 'c1', status: 'SUBMITTED' });
    renderAs('ASSOCIATE', <PunchFixes />, '/time', { associateId: 'a' });
    const banner = (await screen.findByText(/didn’t clock out of your shift/)).closest('[role="status"]') as HTMLElement;
    await userEvent.click(within(banner).getByRole('button', { name: 'Tell us when you left' }));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: /Send to my manager/ });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Clock-out'), '2026-10-13T21:30');
    await userEvent.type(within(dialog).getByLabelText(/Why it needs fixing/), 'Phone died.');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(send);
    await waitFor(() => expect(api.finishPromptedCorrection).toHaveBeenCalledWith('c1', expect.objectContaining({ reason: 'Phone died.', attested: true })));
  });

  it('extra hours offered can be taken', async () => {
    api.getMyCorrections.mockResolvedValue({ attestation: 'x', requests: [], entries: [], sites: [] });
    api.getMyOtOffers.mockResolvedValue({ offers: [{ id: 'o1', wouldAddOvertimeHours: 4, offeredAt: '2026-10-14T10:00:00Z', shift: { id: 'sh', position: 'Cashier', startsAt: '2026-10-20T14:00:00Z', endsAt: '2026-10-20T22:00:00Z', siteName: 'San Diego 12', timezone: null } }] });
    api.answerMyOtOffer.mockResolvedValue({ id: 'o1', status: 'ACCEPTED' });
    renderAs('ASSOCIATE', <PunchFixes />, '/time', { associateId: 'a' });
    expect(await screen.findByText(/4 h of overtime/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Take it' }));
    await waitFor(() => expect(api.answerMyOtOffer).toHaveBeenCalledWith('o1', 'ACCEPTED'));
  });
});

describe('approving punch corrections', () => {
  it('shows the change with the signed attestation; approve, or send back with a reason', async () => {
    api.listCorrections.mockResolvedValue({
      truncated: false,
      requests: [{ id: 'c1', associateId: 'a', name: 'Ana Ruiz', kind: 'MISSED_CLOCK_OUT', status: 'SUBMITTED', workDate: '2026-10-13', siteName: 'San Diego 12', timeEntryId: 'e1', proposedClockIn: null, proposedClockOut: '2026-10-13T21:30:00Z', reason: 'Phone died.', attestationText: 'I certify that the times in this request are true and correct.', attestedAt: '2026-10-14T10:00:00Z', before: { clockInAt: '2026-10-13T13:00:00Z', clockOutAt: null, status: 'ACTIVE' }, after: null, decidedBy: null, decidedAt: null, decisionReason: null, createdAt: '2026-10-14T10:00:00Z' }],
    });
    api.decideCorrection.mockResolvedValue({ id: 'c1', status: 'DENIED' });
    renderAs('HR_ADMINISTRATOR', <TimeCorrectionsDesk />);
    expect(await screen.findByText('“Phone died.”')).toBeInTheDocument();
    expect(screen.getByText(/I certify that the times/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Don’t approve' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Why/), 'The camera shows 5:10.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send it back' }));
    await waitFor(() => expect(api.decideCorrection).toHaveBeenCalledWith('c1', 'DENY', 'The camera shows 5:10.'));
  });
});

describe('overtime, in turn', () => {
  it('lists who’d go over in order, and an out-of-turn offer asks for the reason', async () => {
    api.getRotation.mockResolvedValue({
      shiftId: 'sh',
      open: true,
      enabled: true,
      candidates: [
        { associateId: 'c', name: 'Cal Calm', weekHours: 0, wouldAddOvertimeHours: 0, recentOvertimeHours: 0, rank: 1, offer: null },
        { associateId: 'b', name: 'Bea Busy', weekHours: 36, wouldAddOvertimeHours: 4, recentOvertimeHours: 0, rank: 2, offer: null },
        { associateId: 'd', name: 'Dee Done', weekHours: 36, wouldAddOvertimeHours: 4, recentOvertimeHours: 5, rank: 3, offer: null },
      ],
    });
    api.offerShift.mockRejectedValueOnce(new ApiError(409, 'out_of_turn', 'Offer it to Cal first.', { ahead: [{ associateId: 'c', name: 'Cal Calm' }] }));
    api.offerShift.mockResolvedValue({ shiftId: 'sh', enabled: true, candidates: [] });
    renderAs('HR_ADMINISTRATOR', <OvertimeRotationPanel shiftId="sh" />);
    await userEvent.click(screen.getByRole('button', { name: /Who gets overtime first/ }));
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent?.split('+')[0]?.trim())).toEqual(['Bea Busy', 'Dee Done']);
    await userEvent.click(within(list).getAllByRole('button', { name: 'Offer' })[1]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Cal Calm come first');
    await userEvent.type(within(dialog).getByLabelText(/Why skip them/), 'Only Dee holds the forklift card.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Offer with this reason' }));
    await waitFor(() => expect(api.offerShift).toHaveBeenLastCalledWith('sh', 'd', 'Only Dee holds the forklift card.'));
  });
});
