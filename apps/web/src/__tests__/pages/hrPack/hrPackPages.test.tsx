import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './harness';

vi.mock('@/lib/policyCampaignsApi', () => ({
  listPolicyCampaigns: vi.fn(),
  getPolicyCampaign: vi.fn(),
  audienceSize: vi.fn(),
  createPolicyCampaign: vi.fn(),
  launchPolicyCampaign: vi.fn(),
  closePolicyCampaign: vi.fn(),
  waivePolicyRecipient: vi.fn(),
  listMyPolicies: vi.fn(),
  signMyPolicy: vi.fn(),
}));
vi.mock('@/lib/documentRetentionApi', () => ({ getRetentionPolicies: vi.fn(), updateRetentionPolicies: vi.fn(), previewRetention: vi.fn() }));
vi.mock('@/lib/verificationLettersApi', () => ({
  requestLetter: vi.fn(),
  listMyLetters: vi.fn(),
  listLetters: vi.fn(),
  approveLetter: vi.fn(),
  declineLetter: vi.fn(),
  letterPdfUrl: (id: string) => `/api/verification-letters/${id}/pdf`,
}));
vi.mock('@/lib/peopleAnalyticsApi', () => ({ getPeopleAnalytics: vi.fn() }));
vi.mock('@/lib/separation119Api', async (orig) => ({ ...(await orig<typeof import('@/lib/separation119Api')>()), getOffboarding: vi.fn(), waiveSeparationAssets: vi.fn() }));
vi.mock('@/lib/assets108Api', async (orig) => ({ ...(await orig<typeof import('@/lib/assets108Api')>()), returnAssetAssignment: vi.fn() }));
vi.mock('@/lib/hrCases123Api', async (orig) => ({ ...(await orig<typeof import('@/lib/hrCases123Api')>()), getSlaTargets: vi.fn(), updateSlaTargets: vi.fn() }));
vi.mock('@/lib/docTemplatesApi', () => ({ listTemplates: vi.fn().mockResolvedValue({ templates: [] }) }));

import { getPolicyCampaign, listMyPolicies, listPolicyCampaigns, signMyPolicy } from '@/lib/policyCampaignsApi';
import { getRetentionPolicies, previewRetention, updateRetentionPolicies } from '@/lib/documentRetentionApi';
import { approveLetter, listLetters, listMyLetters, requestLetter } from '@/lib/verificationLettersApi';
import { getPeopleAnalytics } from '@/lib/peopleAnalyticsApi';
import { getOffboarding, waiveSeparationAssets } from '@/lib/separation119Api';
import { getSlaTargets, updateSlaTargets } from '@/lib/hrCases123Api';
import { PolicyCampaignsHome } from '@/pages/compliance/PolicyCampaignsHome';
import { MyPolicies } from '@/pages/agreements/MyPolicies';
import { DocumentRetentionAdmin } from '@/pages/admin/DocumentRetentionAdmin';
import { LettersSection } from '@/pages/documents/LettersSection';
import { LettersQueue } from '@/pages/documents/LettersQueue';
import { PeopleAnalytics } from '@/pages/reports/PeopleAnalytics';
import { OffboardingPanel } from '@/pages/separation/OffboardingPanel';
import { SlaChip, SlaTargetsDialog } from '@/pages/hrCases/SlaTargetsDialog';

beforeEach(() => {
  vi.clearAllMocks();
});

const campaign = {
  id: 'c1',
  name: 'Code of conduct 2027',
  templateName: 'Code of conduct',
  version: 2,
  audience: { kind: 'ALL' as const },
  dueOn: '2027-01-15',
  reminderEveryDays: 3,
  status: 'ACTIVE' as const,
  launchedAt: '2026-10-01T12:00:00.000Z',
  lastReminderAt: null,
  completion: { total: 4, signed: 2, waived: 1, pending: 1, pct: 75 },
};

describe('policy campaigns', () => {
  it('lists campaigns with their completion and opens one with every recipient', async () => {
    vi.mocked(listPolicyCampaigns).mockResolvedValue({ campaigns: [campaign] });
    vi.mocked(getPolicyCampaign).mockResolvedValue({
      ...campaign,
      body: 'Be kind.',
      audienceSize: 4,
      recipients: [
        { id: 'r1', associateId: 'a1', associateName: 'Ana Lopez', associateEmail: 'ana@example.com', status: 'SIGNED', signedAt: '2026-10-02T12:00:00.000Z', remindedAt: null, waiveReason: null },
        { id: 'r2', associateId: 'a2', associateName: 'Bo Chen', associateEmail: null, status: 'PENDING', signedAt: null, remindedAt: null, waiveReason: null },
      ],
    });
    renderAs('HR_ADMINISTRATOR', <PolicyCampaignsHome />);
    expect(await screen.findAllByText('Code of conduct 2027')).not.toHaveLength(0);
    expect(screen.getAllByText('3 of 4').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /new campaign/i })).toBeInTheDocument();
    await userEvent.click(screen.getAllByText('Code of conduct 2027')[0]!);
    expect(await screen.findByText('2 signed · 1 waived · 1 waiting')).toBeInTheDocument();
    expect(screen.getAllByText('Bo Chen').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Waive' }).length).toBeGreaterThan(0);
  });

  it('the person reads the policy as sent and signs with their name', async () => {
    vi.mocked(listMyPolicies).mockResolvedValue({ policies: [{ id: 'p1', campaignId: 'c1', name: 'Code of conduct 2027', dueOn: '2099-01-15', status: 'PENDING', body: 'Hello Ana, be kind.', signedAt: null, signature: null, contentSha256: null }] });
    vi.mocked(signMyPolicy).mockResolvedValue({ ok: true, signedAt: '2026-10-17T12:00:00.000Z' });
    renderAs('ASSOCIATE', <MyPolicies />, '/', { associateId: 'a1' });
    await userEvent.click(await screen.findByRole('button', { name: 'Read and sign' }));
    expect(screen.getByText('Hello Ana, be kind.')).toBeInTheDocument();
    const sign = screen.getByRole('button', { name: 'Sign' });
    expect(sign).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/full legal name/i), 'Ana Lopez');
    await userEvent.click(sign);
    await waitFor(() => expect(signMyPolicy).toHaveBeenCalledWith('p1', 'Ana Lopez'));
  });
});

describe('document retention', () => {
  it('shows each kind with its legal floor, refuses a value below it, and saves only what changed', async () => {
    vi.mocked(getRetentionPolicies).mockResolvedValue({
      policies: [
        { kind: 'ID', retainYearsAfterSeparation: null, floorYears: null },
        { kind: 'I9_SUPPORTING', retainYearsAfterSeparation: null, floorYears: 3 },
      ],
    });
    vi.mocked(previewRetention).mockResolvedValue({ count: 0, candidates: [] });
    vi.mocked(updateRetentionPolicies).mockResolvedValue({ policies: [] });
    renderAs('HR_ADMINISTRATOR', <DocumentRetentionAdmin />);
    const i9 = await screen.findByLabelText('Years to keep I-9 supporting document');
    expect(screen.getByText('At least 3 years')).toBeInTheDocument();
    await userEvent.type(i9, '1');
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 3');
    expect(screen.getByRole('button', { name: 'Save policies' })).toBeDisabled();
    await userEvent.clear(i9);
    await userEvent.type(screen.getByLabelText('Years to keep Government ID'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Save policies' }));
    await waitFor(() => expect(updateRetentionPolicies).toHaveBeenCalledWith([{ kind: 'ID', retainYearsAfterSeparation: 2 }]));
    expect(screen.getByText('0 files would be purged.')).toBeInTheDocument();
  });
});

describe('verification letters', () => {
  it('the person asks for a letter and downloads an approved one', async () => {
    vi.mocked(listMyLetters).mockResolvedValue({
      letters: [{ id: 'l1', associateId: 'a1', kind: 'INCOME', status: 'APPROVED', addressedTo: 'Sunrise Apartments', purpose: null, decidedAt: '2026-10-10T00:00:00.000Z', declineReason: null, createdAt: '2026-10-09T00:00:00.000Z' }],
    });
    vi.mocked(requestLetter).mockResolvedValue({ id: 'l2' });
    renderAs('ASSOCIATE', <LettersSection />, '/', { associateId: 'a1' });
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/verification-letters/l1/pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Ask HR for this letter' }));
    await waitFor(() => expect(requestLetter).toHaveBeenCalledWith({ kind: 'EMPLOYMENT', addressedTo: null, purpose: null }));
  });

  it('HR approves from the queue', async () => {
    vi.mocked(listLetters).mockResolvedValue({
      letters: [{ id: 'l1', associateId: 'a1', associateName: 'Ana Lopez', associateEmail: 'ana@example.com', kind: 'EMPLOYMENT', status: 'REQUESTED', addressedTo: 'Bank', purpose: 'Loan', decidedAt: null, declineReason: null, createdAt: '2026-10-09T00:00:00.000Z' }],
    });
    vi.mocked(approveLetter).mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <LettersQueue canManage />);
    await userEvent.click((await screen.findAllByRole('button', { name: 'Approve' }))[0]!);
    await waitFor(() => expect(approveLetter).toHaveBeenCalledWith('l1'));
  });
});

describe('people analytics', () => {
  it('leads with turnover, headcount, time to fill and absence', async () => {
    vi.mocked(getPeopleAnalytics).mockResolvedValue({
      months: 12,
      since: '2025-11-01',
      headcount: [
        { month: '2025-11', headcount: 100, hires: 5, separations: 2, voluntary: 1, involuntary: 1 },
        { month: '2026-10', headcount: 110, hires: 6, separations: 1, voluntary: 1, involuntary: 0 },
      ],
      turnover: { annualizedPct: 31.5, separations: 30, averageHeadcount: 105, byTenure: [{ label: 'Under 90 days', headcount: 20, separations: 12, annualizedTurnoverPct: 60 }], bySite: [], byManager: [] },
      cohorts: [],
      timeToFill: { filled: 8, medianDays: 12, averageDays: 15, byDepartment: [] },
      absence: { scheduledShiftDays: 900, absenceDays: 45, absenceRatePct: 4.8, byCategory: [] },
    });
    renderAs('HR_ADMINISTRATOR', <PeopleAnalytics />);
    expect(await screen.findByText('31.5%')).toBeInTheDocument();
    expect(screen.getByText('12 days')).toBeInTheDocument();
    expect(screen.getByText('4.8%')).toBeInTheDocument();
    expect(screen.getByText('+10 since Nov 2025')).toBeInTheDocument();
    expect(screen.getAllByText('Under 90 days').length).toBeGreaterThan(0);
  });
});

describe('offboarding', () => {
  it('shows what final pay owes and by when, and waives property with a reason', async () => {
    vi.mocked(getOffboarding).mockResolvedValue({
      separationId: 's1',
      associateName: 'Ana Lopez',
      finalPay: {
        computedAt: '2026-10-17T00:00:00.000Z',
        state: 'CA',
        rate: 20,
        payType: 'HOURLY',
        paidThrough: '2026-10-03',
        unpaidApprovedHours: 16,
        awaitingApprovalHours: 4,
        leavePayoutHours: 8,
        leaveBalances: [{ category: 'VACATION', hours: 8, paidOut: true }],
        estimatedGross: 480,
        deadline: { date: '2026-10-10', basis: '0 days after the last day worked', note: 'California: immediately on discharge.', minimumWageCents: 1650 },
        paySchedule: null,
        finalPaycheckDate: '2026-10-16',
        finalPaycheckLate: true,
      },
      assets: { outstanding: [{ assignmentId: 'aa1', assetId: 'x1', kind: 'LAPTOP', label: 'MacBook 14', serial: 'C02', assignedAt: '2025-01-01T00:00:00.000Z' }], waivedAt: null, waiveReason: null, clear: false },
      access: { removed: false, activeLogins: 1 },
    });
    vi.mocked(waiveSeparationAssets).mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <OffboardingPanel separationId="s1" canManage />);
    expect(await screen.findByText('MacBook 14')).toBeInTheDocument();
    expect(screen.getByText('1 out')).toBeInTheDocument();
    expect(screen.getByText(/is after that/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Waive with a reason' }));
    await userEvent.type(screen.getByPlaceholderText(/without the property back/), 'Reported stolen');
    await userEvent.click(screen.getByRole('button', { name: 'Waive' }));
    await waitFor(() => expect(waiveSeparationAssets).toHaveBeenCalledWith('s1', 'Reported stolen'));
  });
});

describe('case SLAs', () => {
  it('the chip speaks plainly', () => {
    renderAs('HR_ADMINISTRATOR', <div>
      <SlaChip sla={{ state: 'BREACHED', minutesLeft: -180 }} />
      <SlaChip sla={{ state: 'AT_RISK', minutesLeft: 90 }} />
      <SlaChip sla={{ state: 'PAUSED', minutesLeft: null }} />
    </div>);
    expect(screen.getByText('Past SLA · 3h')).toBeInTheDocument();
    expect(screen.getByText('Due in 2h')).toBeInTheDocument();
    expect(screen.getByText('Clock paused')).toBeInTheDocument();
  });

  it('an administrator edits a target; a cleared cell restores the default', async () => {
    vi.mocked(getSlaTargets).mockResolvedValue({
      targets: [
        { category: 'BENEFITS', priority: 'URGENT', targetHours: 8, custom: false },
        { category: 'BENEFITS', priority: 'HIGH', targetHours: 24, custom: false },
        { category: 'BENEFITS', priority: 'MEDIUM', targetHours: 72, custom: false },
        { category: 'BENEFITS', priority: 'LOW', targetHours: 200, custom: true },
      ],
    });
    vi.mocked(updateSlaTargets).mockResolvedValue({ targets: [] });
    renderAs('HR_ADMINISTRATOR', <SlaTargetsDialog open canManage onClose={vi.fn()} />);
    const low = await screen.findByLabelText('Benefits Low target hours');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Custom')).toBeInTheDocument();
    await userEvent.clear(low);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save targets' }));
    await waitFor(() => expect(updateSlaTargets).toHaveBeenCalledWith([{ category: 'BENEFITS', priority: 'LOW', targetHours: null }]));
  });
});
