import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';
import type { LeaveCase, MyLeaveCase } from '@/lib/leaveApi';
import type { ClaimEvidence, UiClaim, WcClaim } from '@/lib/claimsApi';

const leave = vi.hoisted(() => ({
  getLeaveSummary: vi.fn(),
  listLeaveCases: vi.fn(),
  getLeaveCase: vi.fn(),
  sendLeaveNotice: vi.fn(),
  decideLeave: vi.fn(),
  listLeavePrograms: vi.fn(),
  getEligibility: vi.fn(),
  listMyLeave: vi.fn(),
  requestMyLeave: vi.fn(),
  uploadLeaveDocument: vi.fn(),
  getProtectedLeave: vi.fn(),
}));
vi.mock('@/lib/leaveApi', async (orig) => ({ ...(await orig<typeof import('@/lib/leaveApi')>()), ...leave }));
const claims = vi.hoisted(() => ({
  getUiSummary: vi.fn(),
  listUiClaims: vi.fn(),
  getUiClaim: vi.fn(),
  respondUiClaim: vi.fn(),
  getWcSummary: vi.fn(),
  listUnclaimedIncidents: vi.fn(),
  listWcClaims: vi.fn(),
  getWcClaim: vi.fn(),
  openWcClaim: vi.fn(),
  getDutyMatches: vi.fn(),
}));
vi.mock('@/lib/claimsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/claimsApi')>()), ...claims }));

import { LeaveHome } from '@/pages/leave/LeaveHome';
import { UnemploymentClaimsHome, mostUrgent } from '@/pages/claims/UnemploymentClaimsHome';
import { WorkersCompHome } from '@/pages/claims/WorkersCompHome';

const leaveCase = (o: Partial<LeaveCase> = {}): LeaveCase => ({
  id: 'lc1',
  associateId: 'a1',
  associateName: 'Vera Long',
  type: 'FMLA',
  reason: 'OWN_HEALTH',
  stateProgram: null,
  stateProgramName: null,
  schedule: 'CONTINUOUS',
  startDate: '2026-12-01',
  endDate: '2026-12-29',
  intermittentPattern: null,
  reducedHoursPerWeek: null,
  status: 'REQUESTED',
  requestedBySelf: true,
  eligibility: { eligible: true, coveredEmployer: true, monthsOfService: 24, hoursLast12Months: 1320, worksiteMeets50In75: true, averageWeeklyHours: 25.4, reasons: [], asOf: '2026-12-01' },
  noticeSentAt: null,
  designationSentAt: null,
  designatedFmla: null,
  certificationRequired: true,
  certificationDueAt: null,
  certificationReceivedAt: null,
  decidedAt: null,
  decisionNote: null,
  fitnessForDutyRequired: false,
  fitnessForDutyReceivedAt: null,
  expectedReturnDate: '2026-12-30',
  actualReturnDate: null,
  benefitsNote: null,
  shiftsReleased: 0,
  jobProtected: false,
  notes: null,
  documents: [],
  usage: [],
  usedHours: 0,
  next: { key: 'notice', label: 'Send the eligibility notice', dueAt: '2026-11-20', overdue: true },
  createdAt: '2026-11-13T10:00:00.000Z',
  ...o,
});

beforeEach(() => {
  Object.values(leave).forEach((f) => f.mockReset());
  Object.values(claims).forEach((f) => f.mockReset());
  leave.getLeaveSummary.mockResolvedValue({ open: 3, onLeave: 1, certificationsDueThisWeek: 2, noticesOwed: 1, returningThisWeek: 0 });
  leave.listLeavePrograms.mockResolvedValue({ programs: [] });
  leave.getProtectedLeave.mockResolvedValue({ protectedLeave: null });
});

describe('the leave desk', () => {
  it('orders by what is overdue and moves a case with its one next action', async () => {
    leave.listLeaveCases.mockResolvedValue({ cases: [leaveCase()], total: 1, page: 1, pageSize: 50, hasMore: false });
    leave.getLeaveCase.mockResolvedValue({ case: leaveCase(), balance: { periodStart: '2025-12-01', periodEnd: '2026-11-30', method: 'ROLLING_BACKWARD', weeklyHours: 25.4, entitlementHours: 304.8, usedHours: 0, remainingHours: 304.8, remainingWeeks: 12 } });
    leave.sendLeaveNotice.mockResolvedValue({ case: leaveCase({ status: 'PENDING_CERTIFICATION' }) });
    renderAs('HR_ADMINISTRATOR', <LeaveHome />, '/leave');
    expect(await screen.findByText('Overdue: Send the eligibility notice · by Nov 20, 2026', { exact: false })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /vera long/i }));
    expect(await screen.findByText('FMLA eligibility')).toBeInTheDocument();
    expect(screen.getByText(/1,320 hours worked in the last 12 months/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send the eligibility notice' }));
    await waitFor(() => expect(leave.sendLeaveNotice).toHaveBeenCalledWith('lc1'));
  });

  it('a denial needs a reason before it can be sent', async () => {
    const c = leaveCase({ status: 'PENDING_CERTIFICATION', next: { key: 'decide', label: 'Review the certification and decide', dueAt: null, overdue: false } });
    leave.listLeaveCases.mockResolvedValue({ cases: [c], total: 1, page: 1, pageSize: 50, hasMore: false });
    leave.getLeaveCase.mockResolvedValue({ case: c, balance: null });
    renderAs('HR_ADMINISTRATOR', <LeaveHome />, '/leave?case=lc1');
    await userEvent.click(await screen.findByRole('button', { name: 'Decide' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Deny' }));
    const deny = within(dialog).getByRole('button', { name: 'Deny' });
    expect(deny).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/why it is denied/i), 'Not a qualifying reason.');
    expect(deny).toBeEnabled();
  });

  it('the tiles are the filter: a tile narrows the queue to its own cases, and tapping it again goes back (F500 G2)', async () => {
    leave.listLeaveCases.mockResolvedValue({ cases: [leaveCase()], total: 1, page: 1, pageSize: 50, hasMore: false });
    renderAs('HR_ADMINISTRATOR', <LeaveHome />, '/leave');
    await screen.findByText('Overdue: Send the eligibility notice · by Nov 20, 2026', { exact: false });
    expect(screen.queryByRole('button', { name: 'Waiting on certification' })).not.toBeInTheDocument();
    const notices = screen.getByRole('button', { name: /Notices to send/ });
    await userEvent.click(notices);
    await waitFor(() => expect(leave.listLeaveCases).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'notices' })));
    expect(screen.getByRole('button', { name: /Notices to send/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Notices to send/ }));
    await waitFor(() => expect(leave.listLeaveCases).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'open' })));
  });

  it('on a wide screen the most urgent case opens beside the queue (F500 G2)', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1024px'), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      leave.listLeaveCases.mockResolvedValue({ cases: [leaveCase()], total: 1, page: 1, pageSize: 50, hasMore: false });
      leave.getLeaveCase.mockResolvedValue({ case: leaveCase(), balance: null });
      renderAs('HR_ADMINISTRATOR', <LeaveHome />, '/leave');
      await waitFor(() => expect(leave.getLeaveCase).toHaveBeenCalledWith('lc1'));
      expect(screen.queryByText('Pick a case')).not.toBeInTheDocument();
    } finally {
      window.matchMedia = mm;
    }
  });

  it('staff without leave admin get their own leave, not the desk', async () => {
    leave.listMyLeave.mockResolvedValue({ cases: [], linked: true });
    renderAs('OPERATIONS_MANAGER', <LeaveHome />, '/leave');
    expect(await screen.findByText('No leave requests yet')).toBeInTheDocument();
    expect(leave.listLeaveCases).not.toHaveBeenCalled();
  });
});

describe('my leave (the worker)', () => {
  it('asks for leave in plain words and sends the certification HR needs', async () => {
    const mine: MyLeaveCase = {
      id: 'lc1',
      type: 'FMLA',
      reason: 'OWN_HEALTH',
      stateProgramName: null,
      schedule: 'CONTINUOUS',
      startDate: '2026-12-01',
      endDate: null,
      status: 'PENDING_CERTIFICATION',
      certificationRequired: true,
      certificationDueAt: '2026-12-16',
      certificationReceived: false,
      fitnessForDutyRequired: false,
      fitnessForDutyReceived: false,
      noticeAvailable: true,
      designationAvailable: false,
      decisionNote: null,
      expectedReturnDate: null,
      jobProtected: true,
      documents: [],
      createdAt: '2026-11-30T10:00:00.000Z',
    };
    leave.listMyLeave.mockResolvedValue({ cases: [mine], linked: true });
    leave.requestMyLeave.mockResolvedValue({ case: mine });
    renderAs('ASSOCIATE', <LeaveHome />, '/leave', { associateId: 'a1' });
    expect(await screen.findByText(/Send your certification by Dec 16, 2026/)).toBeInTheDocument();
    expect(screen.getByText('Your job is protected while you’re on this leave')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /your rights notice/i })).toHaveAttribute('href', '/api/me/leave/lc1/notices/eligibility');
    // Everyday time off is its own page, one line away (F500 G2).
    expect(screen.getByRole('link', { name: 'Time off →' })).toHaveAttribute('href', '/time-off');

    await userEvent.click(screen.getByRole('button', { name: 'Ask for leave' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('What is the leave for?'), 'BONDING');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send to HR' }));
    await waitFor(() => expect(leave.requestMyLeave).toHaveBeenCalledWith(expect.objectContaining({ type: 'FMLA', reason: 'BONDING', schedule: 'CONTINUOUS' })));
  });
});

describe('unemployment claims', () => {
  it('opens a claim with a read of the record and a response that needs a statement', async () => {
    const claim: UiClaim = {
      id: 'u1',
      associateId: 'a2',
      associateName: 'Kai Gone',
      clientId: 'c1',
      clientName: 'Coastal',
      separationId: 's1',
      state: 'FL',
      claimDate: '2026-12-01',
      noticeReceivedAt: '2026-12-02',
      responseDueAt: '2026-12-12',
      stateClaimNumber: null,
      status: 'NEW',
      decision: null,
      decisionReason: null,
      respondedAt: null,
      determination: null,
      determinationAt: null,
      chargesAmount: null,
      hearingAt: null,
      hearingOutcome: null,
      appealFiledAt: null,
      appealOutcome: null,
      outcome: null,
      notes: null,
      next: { key: 'respond', label: 'Respond to the state', dueAt: '2026-12-12', overdue: false },
      createdAt: '2026-12-02T10:00:00.000Z',
    };
    const evidence: ClaimEvidence = {
      separation: { id: 's1', reason: 'INVOLUNTARY_MISCONDUCT', reasonLabel: 'Discharged — misconduct', lastDayWorked: '2026-11-20', noticeDate: null, status: 'COMPLETE', notes: null, finalPaycheckDate: null },
      lastAssignment: { store: 'Front Beach', client: 'Coastal', startedAt: '2026-05-01', endedAt: '2026-11-20', reason: null, stillPlaced: false },
      discipline: [{ id: 'd1', kind: 'WRITTEN_WARNING', label: 'Written warning', incidentDate: '2026-10-01', description: 'Left the register.', acknowledged: true }],
      attendance: { score: 4, asOf: '2026-11-20', events: [] },
      signedPolicies: [],
      workOffers: [],
      posture: { kind: 'strong', points: ['Discharged for misconduct after 1 written or final warning.'] },
    };
    claims.getUiSummary.mockResolvedValue({ open: 1, responsesDueThisWeek: 1, overdue: 0, hearingsNext14Days: 0, contestedDecided: 0, winRate: null, estimatedSuiImpact: 0, suiImpactFactor: 1, byClient: [] });
    claims.listUiClaims.mockResolvedValue({ claims: [claim], total: 1, hasMore: false });
    claims.getUiClaim.mockResolvedValue({ claim, evidence });
    renderAs('HR_ADMINISTRATOR', <UnemploymentClaimsHome />, '/claims/unemployment?claim=u1');
    expect(await screen.findByText('The record supports a contest')).toBeInTheDocument();
    expect(screen.getByText('Discharged — misconduct', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/None recorded\. An ended assignment with no offer usually reads as a layoff\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Respond' }));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Record the response' });
    expect(send).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/your statement/i), 'Discharged after a written warning.');
    await userEvent.click(send);
    await waitFor(() => expect(claims.respondUiClaim).toHaveBeenCalledWith('u1', { decision: 'CONTEST', reason: 'Discharged after a written warning.' }));
  });
});

describe('workers’ comp claims', () => {
  it('starts a claim from an injury in the safety log, and shows what the first report still needs', async () => {
    const wc: WcClaim = {
      id: 'w1',
      oshaIncidentId: 'i1',
      associateId: 'a3',
      associateName: 'Ana Hurt',
      clientId: 'c1',
      clientName: 'Coastal',
      locationId: 's1',
      storeName: 'Front Beach',
      jurisdiction: 'CA',
      injuryDate: '2026-12-01T15:00:00.000Z',
      reportedToEmployerAt: '2026-12-01',
      froiDueAt: '2026-12-06',
      froi: {
        employer: { name: 'Alto HR', fein: null, address: null, policyNumber: null },
        employee: { name: 'Ana Hurt', address: null, phone: null, dob: null, ssnLast4: null, hireDate: null, jobTitle: null, wageRate: 16, wageUnit: 'HOUR', hoursPerWeek: 30 },
        injury: { occurredAt: '2026-12-01T15:00:00.000Z', where: null, description: 'Strained back.', bodyPart: 'Lower back', nature: null, cause: null, objectOrSubstance: null, witnesses: null, treatment: 'CLINIC', physician: null, lastDayWorked: '2026-12-01', returnedToWork: null, fatal: false },
        reportedBy: { name: null, title: null },
      },
      froiSubmittedAt: null,
      carrierName: null,
      carrierClaimNumber: null,
      status: 'OPEN',
      claimType: 'MEDICAL_ONLY',
      lostTimeDays: 0,
      restrictedDays: 0,
      reserveMedical: null,
      reserveIndemnity: null,
      restrictions: null,
      restrictionRules: null,
      rtwDate: null,
      notes: null,
      dutyOffers: [],
      next: { key: 'froi', label: 'Send the first report to the carrier', dueAt: '2026-12-06', overdue: false },
      createdAt: '2026-12-02T10:00:00.000Z',
    };
    claims.getWcSummary.mockResolvedValue({ open: 0, froiDue: 0, froiOverdue: 0, lostTimeDaysOpen: 0, restrictedDaysOpen: 0, claimsLast12Months: 0, incidentRate: null, hoursWorkedLast12Months: 0, byPlace: [] });
    claims.listUnclaimedIncidents.mockResolvedValue({ incidents: [{ id: 'i1', occurredAt: '2026-12-01T15:00:00.000Z', severity: 'MEDICAL_TREATMENT', description: 'Strained back.', bodyPart: 'Lower back', associateName: 'Ana Hurt', clientName: 'Coastal', storeName: 'Front Beach' }] });
    claims.listWcClaims.mockResolvedValue({ claims: [], total: 0, hasMore: false });
    claims.openWcClaim.mockResolvedValue({ claim: wc });
    claims.getWcClaim.mockResolvedValue({ claim: wc, froiDefaultDays: 5 });
    claims.getDutyMatches.mockResolvedValue({ rules: null, shifts: [] });
    renderAs('HR_ADMINISTRATOR', <WorkersCompHome />, '/claims/workers-comp');
    await userEvent.click(await screen.findByRole('button', { name: 'Start a claim' }));
    await waitFor(() => expect(claims.openWcClaim).toHaveBeenCalledWith({ oshaIncidentId: 'i1' }));
    expect(await screen.findByText(/Still to fill: employer FEIN, policy number, nature of injury, cause\./)).toBeInTheDocument();
    expect(screen.getByText(/A 5-day window for CA by default/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record it as sent/i })).toBeInTheDocument();
    // Its own request (duty matches) can land after the summary's on a slow runner: wait for it.
    expect(await screen.findByText('No open shift in the next two weeks fits these restrictions.')).toBeInTheDocument();
  });
});

describe('claims, read first and urgent first (F500 G6)', () => {
  const uiClaim = (o: Partial<UiClaim> = {}): UiClaim => ({
    id: 'u1', associateId: 'a2', associateName: 'Kai Gone', clientId: 'c1', clientName: 'Coastal', separationId: 's1', state: 'FL',
    claimDate: '2026-12-01', noticeReceivedAt: '2026-12-02', responseDueAt: '2026-12-12', stateClaimNumber: null, status: 'NEW', decision: null, decisionReason: null,
    respondedAt: null, determination: null, determinationAt: null, chargesAmount: null, hearingAt: null, hearingOutcome: null, appealFiledAt: null, appealOutcome: null,
    outcome: null, notes: null, next: { key: 'respond', label: 'Respond to the state', dueAt: '2026-12-12', overdue: false }, createdAt: '2026-12-02T10:00:00.000Z', ...o,
  });
  const evidence: ClaimEvidence = {
    separation: { id: 's1', reason: 'INVOLUNTARY_MISCONDUCT', reasonLabel: 'Discharged — misconduct', lastDayWorked: '2026-11-20', noticeDate: null, status: 'COMPLETE', notes: null, finalPaycheckDate: null },
    lastAssignment: { store: 'Front Beach', client: 'Coastal', startedAt: '2026-05-01', endedAt: '2026-11-20', reason: null, stillPlaced: false },
    discipline: [], attendance: { score: 4, asOf: '2026-11-20', events: [] }, signedPolicies: [], workOffers: [],
    posture: { kind: 'strong', points: ['Discharged for misconduct.'] },
  };
  const summary = { open: 2, responsesDueThisWeek: 1, overdue: 0, hearingsNext14Days: 0, contestedDecided: 0, winRate: null, estimatedSuiImpact: 0, suiImpactFactor: 1, byClient: [] };

  it('mostUrgent: overdue first, then the soonest deadline', () => {
    const later = uiClaim({ id: 'a', next: { key: 'respond', label: 'x', dueAt: '2026-12-20', overdue: false } });
    const soon = uiClaim({ id: 'b', next: { key: 'respond', label: 'x', dueAt: '2026-12-10', overdue: false } });
    const late = uiClaim({ id: 'c', next: { key: 'respond', label: 'x', dueAt: '2026-12-01', overdue: true } });
    expect(mostUrgent([later, soon])?.id).toBe('b');
    expect(mostUrgent([later, soon, late])?.id).toBe('c');
    expect(mostUrgent([])).toBeNull();
  });

  it('on a wide screen the most urgent claim opens by itself — no “Pick a claim”; no $0.00 tax impact before any charge', async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('min-width: 1024px'), media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
    try {
      const soon = uiClaim({ id: 'u9', associateName: 'Due Friday', next: { key: 'respond', label: 'Respond', dueAt: '2026-10-24', overdue: false } });
      claims.getUiSummary.mockResolvedValue(summary);
      claims.listUiClaims.mockResolvedValue({ claims: [uiClaim({ next: { key: 'respond', label: 'Respond', dueAt: '2026-11-30', overdue: false } }), soon], total: 2, hasMore: false });
      claims.getUiClaim.mockResolvedValue({ claim: soon, evidence });
      renderAs('HR_ADMINISTRATOR', <UnemploymentClaimsHome />, '/claims/unemployment');
      await waitFor(() => expect(claims.getUiClaim).toHaveBeenCalledWith('u9'));
      expect(screen.queryByText('Pick a claim')).not.toBeInTheDocument();
      const strip = screen.getByRole('group', { name: 'Claims at a glance' });
      expect(within(strip).getByText('No charges yet')).toBeInTheDocument();
    } finally {
      window.matchMedia = mm;
    }
  });

  it('a decided claim reads its outcome; changing it is “Update outcome”', async () => {
    const decided = uiClaim({ status: 'DETERMINED', determination: 'DENIED', outcome: 'DENIED', chargesAmount: 0, next: null });
    claims.getUiSummary.mockResolvedValue(summary);
    claims.listUiClaims.mockResolvedValue({ claims: [decided], total: 1, hasMore: false });
    claims.getUiClaim.mockResolvedValue({ claim: decided, evidence });
    renderAs('HR_ADMINISTRATOR', <UnemploymentClaimsHome />, '/claims/unemployment?claim=u1');
    expect(await screen.findByText('First determination')).toBeInTheDocument();
    expect(screen.queryByLabelText('First determination')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Update outcome' }));
    expect(await screen.findByLabelText('First determination')).toHaveValue('DENIED');
  });
});

