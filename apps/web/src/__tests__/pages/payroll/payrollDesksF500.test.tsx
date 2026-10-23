import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from '../hrPack/harness';

/**
 * F500 G3 — the desks' headers lead with the job in front of them:
 * Garnishments (numbers above the tabs; an e-IWO for nobody on file is
 * rejected first), Retirement (the people the plan can't place, and the
 * next pay date's file as the primary) and the W-4 re-collection in plain words.
 */

const ded = vi.hoisted(() => ({
  getDesk: vi.fn(),
  listEiwo: vi.fn(),
  listRemittances: vi.fn(),
  listPlans: vi.fn(),
  listPayDates: vi.fn(),
  listElections: vi.fn(),
  listPlanFiles: vi.fn(),
  makeContributionFile: vi.fn(),
}));
vi.mock('@/lib/deductionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/deductionsApi')>()), ...ded }));

const w4 = vi.hoisted(() => ({ getW4Recollection: vi.fn(), emailW4Recollection: vi.fn() }));
vi.mock('@/lib/w4RecollectionApi', async (orig) => ({ ...(await orig<typeof import('@/lib/w4RecollectionApi')>()), ...w4 }));

import { GarnishmentDesk } from '@/pages/deductions/GarnishmentDesk';
import { RetirementPlans } from '@/pages/deductions/RetirementPlans';
import { W4SsnRecollection } from '@/pages/payroll/W4SsnRecollection';

beforeEach(() => {
  for (const f of [...Object.values(ded), ...Object.values(w4)]) f.mockReset();
});

const eiwo = (over: Record<string, unknown> = {}) => ({
  id: 'e1', receivedAt: '2026-10-20T10:00:00Z', documentActionCode: 'ORG', caseIdentifier: 'CS-1', orderIdentifier: null, remittanceIdentifier: null, issuingState: 'FL',
  employeeName: 'Pat Nobody', employeeSsnLast4: '9999', parsed: { problems: ['No one on file has this SSN.'], match: 'No one on file has this SSN' }, status: 'RECEIVED',
  rejectReasonCode: null, rejectReason: null, associateId: null, garnishmentId: null, hasAck: false, ackGeneratedAt: null, ...over,
});

describe('garnishments', () => {
  beforeEach(() => {
    ded.getDesk.mockResolvedValue({ orders: [], totals: { active: 0, eiwoToReview: 2, remittancesPending: 1, remittancesPendingAmount: 312.5, overdue: 0 }, stateRules: [], levyYears: [], rejectReasons: [{ code: '01', label: 'Not our employee' }] });
    ded.listRemittances.mockResolvedValue({ remittances: [] });
  });

  it('the numbers span the tabs, so they sit above them', async () => {
    ded.listEiwo.mockResolvedValue({ documents: [], truncated: false });
    renderAs('FINANCE_ACCOUNTANT', <GarnishmentDesk />, '/payroll/garnishments');
    const tile = await screen.findByText('e-IWO to answer');
    const tabs = screen.getByRole('tablist');
    expect(tile.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A tile opens its tab.
    await userEvent.click(tile);
    await waitFor(() => expect(screen.getByRole('tab', { name: /e-IWO inbox/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('button', { name: 'Add an order' })).toBeInTheDocument();
  });

  it('an e-IWO for nobody on file makes “Reject: not our employee” the primary; a matched one keeps Accept', async () => {
    ded.listEiwo.mockResolvedValue({ documents: [eiwo(), eiwo({ id: 'e2', employeeName: 'Ana Ruiz', parsed: { match: 'Matched Ana Ruiz' }, associateId: 'a1' })], truncated: false });
    renderAs('FINANCE_ACCOUNTANT', <GarnishmentDesk />, '/payroll/garnishments?tab=eiwo');
    const reject = (await screen.findAllByRole('button', { name: 'Reject: not our employee' }))[0]!;
    // The primary is the gold button; Accept sits beside it, outlined.
    expect(reject.className).toMatch(/btn-gold/);
    const accepts = screen.getAllByRole('button', { name: 'Accept' });
    const besideReject = accepts.find((b) => b.parentElement === reject.parentElement)!;
    expect(besideReject.className).not.toMatch(/btn-gold/);
    // The matched order: Accept is the primary, Reject is outlined.
    const plainReject = screen.getAllByRole('button', { name: 'Reject' })[0]!;
    expect(plainReject.className).not.toMatch(/btn-gold/);
    expect(accepts.find((b) => b.parentElement === plainReject.parentElement)!.className).toMatch(/btn-gold/);
  });
});

const plan = {
  id: 'pl1', name: 'Alto 401(k)', planNumber: '001', employerId: 'em1', employerName: 'Coastal Staffing', benefitsPlanId: null, recordkeeper: 'GUIDELINE', recordkeeperLabel: 'Guideline', transport: 'DOWNLOAD',
  connection: { host: null, username: null, remoteDir: null, baseUrl: null, hasSecret: false }, status: 'ACTIVE', establishedOn: '2026-01-01', eligibilityMinAge: 21, eligibilityServiceDays: 0, entryTiming: 'IMMEDIATE',
  autoEnroll: true, autoEnrollPercent: 3, autoEscalatePercent: 1, autoEscalateMax: 10, optOutDays: 30, matchFormula: [], safeHarbor: 'NONE', rothEnabled: true, catchUpEnabled: true, mustAutoEnroll: false, counts: {},
};
const election = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, associateId: `a-${id}`, name, hireDate: null, status: 'NOT_ELIGIBLE', preTaxPercent: 0, rothPercent: 0, flatAmountPerPay: null, eligibleOn: null, enrolledOn: null, optOutDeadline: null, nextEscalationOn: null, source: 'AUTO', updatedAt: '2026-10-01T00:00:00Z', ...over,
});

describe('retirement plans', () => {
  beforeEach(() => {
    ded.listPlans.mockResolvedValue({ plans: [plan], employers: [], recordkeepers: [], benefitsPlans: [] });
    ded.listPlanFiles.mockResolvedValue({ files: [] });
    ded.listElections.mockResolvedValue({
      elections: [election('e1', 'Ana Ruiz'), election('e2', 'Ben Cole'), election('e3', 'Cara Diaz', { status: 'ENROLLED', eligibleOn: '2026-02-01', enrolledOn: '2026-02-01', preTaxPercent: 5 })],
      loans: [],
    });
  });

  it('says who the plan can’t place and links each one to fix', async () => {
    ded.listPayDates.mockResolvedValue({ payDates: [] });
    renderAs('FINANCE_ACCOUNTANT', <RetirementPlans />, '/payroll/retirement');
    const callout = await screen.findByTestId('retirement-missing-dates');
    expect(callout).toHaveTextContent('2 people are missing a birth or hire date, so the plan can’t tell when they may join.');
    expect(within(callout).getByRole('link', { name: 'Fix Ana Ruiz' })).toHaveAttribute('href', '/people?associateId=a-e1&tab=employment');
  });

  it('with a plan live, the primary is the oldest pay date with no file; adding a plan moves to the overflow', async () => {
    ded.listPayDates.mockResolvedValue({
      payDates: [
        { payDate: '2026-10-16', people: 3, employee: 120, employer: 60, fileStatus: null },
        { payDate: '2026-10-02', people: 3, employee: 120, employer: 60, fileStatus: null },
        { payDate: '2026-09-18', people: 3, employee: 120, employer: 60, fileStatus: 'SENT' },
      ],
    });
    ded.makeContributionFile.mockResolvedValue({ file: { id: 'f1' } });
    renderAs('FINANCE_ACCOUNTANT', <RetirementPlans />, '/payroll/retirement');
    const primary = await screen.findByRole('button', { name: 'Make the Oct 2, 2026 file' });
    expect(screen.queryByRole('button', { name: 'Set up a plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a plan' })).toBeNull();
    await userEvent.click(primary);
    await waitFor(() => expect(ded.makeContributionFile).toHaveBeenCalledWith('pl1', '2026-10-02'));
  });

  it('with no plan, setting one up is the job', async () => {
    ded.listPlans.mockResolvedValue({ plans: [], employers: [], recordkeepers: [], benefitsPlans: [] });
    renderAs('FINANCE_ACCOUNTANT', <RetirementPlans />, '/payroll/retirement');
    expect((await screen.findAllByRole('button', { name: 'Set up a plan' })).length).toBeGreaterThan(0);
  });
});

describe('W-4 re-collection', () => {
  it('speaks plainly and gives the same zero the same colour', async () => {
    w4.getW4Recollection.mockResolvedValue({ rows: [], summary: { outstanding: 0, notified: 0, resolved: 0 } });
    renderAs('HR_ADMINISTRATOR', <W4SsnRecollection />, '/payroll/w4-recollection');
    expect(await screen.findByText('All Social Security numbers and card photos are in')).toBeInTheDocument();
    expect(screen.getByText('Nobody outstanding')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/decrypt|current key/i);
    expect(document.querySelector('[data-tone="success"], .text-success [data-metric-value]')).toBeNull();
  });

  it('counts people, not “associates”', async () => {
    w4.getW4Recollection.mockResolvedValue({
      rows: [{ associateId: 'a1', firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com', hasAccount: true, applicationId: null, hireDate: null, w4SubmittedAt: null, ssnLast4: null, needsNumber: true, needsCard: false, hasSsnDocument: false, emailCount: 0, lastEmailedAt: null }],
      summary: { outstanding: 1, notified: 0, resolved: 0 },
    });
    renderAs('HR_ADMINISTRATOR', <W4SsnRecollection />, '/payroll/w4-recollection');
    expect(await screen.findByText('1 person outstanding')).toBeInTheDocument();
    expect(screen.queryByText(/associate/i)).toBeNull();
  });
});
