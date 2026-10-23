import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderAs } from './hrPack/harness';

const api = vi.hoisted(() => ({
  getStateCoverage: vi.fn(),
  acknowledgeState: vi.fn(),
  revokeStateAcknowledgment: vi.fn(),
  calculateStateTax: vi.fn(),
  getStateW4Forms: vi.fn(),
  getStateCertificates: vi.fn(),
  saveStateCertificate: vi.fn(),
  getMyStateCertificates: vi.fn(),
  saveMyStateCertificate: vi.fn(),
  getWotcApplicant: vi.fn(),
  submitWotcApplicant: vi.fn(),
  getWotcSummary: vi.fn(),
  listWotcScreenings: vi.fn(),
  getWotcScreening: vi.fn(),
  saveWotcEmployer: vi.fn(),
  markWotcSubmitted: vi.fn(),
  recordWotcOutcome: vi.fn(),
  getWotcSettings: vi.fn(),
  saveWotcSettings: vi.fn(),
  saveWotcZips: vi.fn(),
  getAcaSettings: vi.fn(),
  saveAcaSettings: vi.fn(),
  listAcaWorkers: vi.fn(),
  getAcaSummary: vi.fn(),
  setAcaClassification: vi.fn(),
  recordAcaOffer: vi.fn(),
  answerAcaOffer: vi.fn(),
  syncAca1095c: vi.fn(),
}));
vi.mock('@/lib/taxcompApi', async (orig) => ({ ...(await orig<typeof import('@/lib/taxcompApi')>()), ...api }));
// The checklist holds the WOTC task: a task page whose kind isn't on the checklist says "not part of your onboarding" instead.
vi.mock('@/lib/onboardingApi', async (orig) => ({ ...(await orig<typeof import('@/lib/onboardingApi')>()), getApplication: vi.fn().mockResolvedValue({ tasks: [{ id: 't1', kind: 'WOTC_SCREENING', status: 'PENDING', title: 'Tax credit questions' }] }) }));

import { StateTaxTables } from '@/pages/payroll/StateTaxCoverage';
import { WotcDesk } from '@/pages/payroll/WotcDesk';
import { AcaHours } from '@/pages/benefits/AcaHours';
import { WotcScreeningTask } from '@/pages/onboarding/tasks/WotcScreeningTask';
import { StateCertificateCard } from '@/components/payroll/StateCertificateCard';

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getStateW4Forms.mockResolvedValue({ forms: [{ state: 'MD', name: 'Maryland', form: 'MW507' }], marylandCounties: ['HOWARD', 'MONTGOMERY'] });
  api.calculateStateTax.mockResolvedValue({ state: 'DE', perPeriod: 59.35, coverage: 'awaiting_review' });
});

describe('Tax tables › State', () => {
  it('leads with what needs attention, and records a review only once it is confirmed', async () => {
    api.getStateCoverage.mockResolvedValue({
      counts: { verified: 27, acknowledged: 0, awaitingReview: 24, blockedPeople: 3 },
      states: [
        { state: 'DE', name: 'Delaware', coverage: 'awaiting_review', people: 3, taxYear: 2025, confidence: 'medium', source: 'Delaware Division of Revenue (2025)', notes: 'Standard deduction $3,250.', form: null, acknowledgment: null },
        { state: 'FL', name: 'Florida', coverage: 'verified', people: 9, taxYear: null, confidence: null, source: null, notes: null, form: null, acknowledgment: null },
        // Awaiting review, but nobody works there: not anyone's to-do (F500 G3).
        { state: 'VT', name: 'Vermont', coverage: 'awaiting_review', people: 0, taxYear: 2025, confidence: 'medium', source: null, notes: null, form: null, acknowledgment: null },
      ],
    });
    api.acknowledgeState.mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <StateTaxTables />, '/payroll/tax-tables?tab=state');
    expect(await screen.findByText('Delaware')).toBeInTheDocument();
    expect(screen.queryByText('Florida')).toBeNull(); // covered — not in "Needs attention"
    expect(screen.queryByText('Vermont')).toBeNull(); // nobody there
    await userEvent.click(screen.getByRole('row', { name: 'Open Delaware' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/Delaware Division of Revenue/)).toBeInTheDocument();
    expect(await within(drawer).findByText('$59.35')).toBeInTheDocument();
    const record = within(drawer).getByRole('button', { name: 'Record the review' });
    expect(record).toBeDisabled();
    await userEvent.click(within(drawer).getByRole('checkbox'));
    await userEvent.click(record);
    await waitFor(() => expect(api.acknowledgeState).toHaveBeenCalledWith('DE', undefined));
  });
});

const screening = {
  id: 's1',
  associateId: 'a1',
  name: 'Val Vet',
  clientId: 'c1',
  clientName: 'Seaside Co',
  siteId: 'st1',
  siteName: 'Front Beach',
  status: 'LIKELY_ELIGIBLE' as const,
  targetGroups: [{ code: 'VET_UNEMPLOYED_6M', label: 'Veteran, unemployed 6+ months', maxCredit: 5_600 }],
  signedAt: '2026-06-20T10:00:00Z',
  offerDate: null,
  hireDate: null,
  startDate: '2026-07-01',
  startingWage: null,
  position: null,
  filingState: null,
  employerComplete: false,
  deadline: '2026-07-29',
  daysLeft: 3,
  submittedAt: null,
  submissionRef: null,
  filedOnTime: null,
  certifiedAt: null,
  certifiedGroup: null,
  denialReason: null,
  signedAfterOffer: false,
  hours: 0,
  wages: 0,
  creditRate: 0,
  estimatedCredit: 0,
  potentialCredit: 5_600,
};

describe('<WotcDesk>', () => {
  it('shows who to file and how long is left; filing waits on the employer’s section', async () => {
    api.getWotcSummary.mockResolvedValue({ truncated: false, screened: 4, declined: 1, eligible: 1, toFile: 1, overdue: 0, dueThisWeek: 1, submitted: 0, filedOnTime: 0, certified: 0, denied: 0, estimatedCredit: 0, pipelineCredit: 5_600, byPlace: [] });
    api.listWotcScreenings.mockResolvedValue({ screenings: [screening], truncated: false });
    api.getWotcSettings.mockResolvedValue({ enabled: true, designatedZips: 0 });
    api.getWotcScreening.mockResolvedValue({ screening: { ...screening, answers: { veteran: 'yes', vetUnemployed6m: 'yes' }, questions: [] } });
    renderAs('HR_ADMINISTRATOR', <WotcDesk />, '/payroll/wotc');
    expect(await screen.findByText('Val Vet')).toBeInTheDocument();
    expect(screen.getByText('3 days left')).toBeInTheDocument();
    expect(screen.getByText('1 due this week')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('row', { name: /open val vet’s screening/i }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('A U.S. military veteran')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Mark as filed' })).toBeDisabled();
    expect(within(drawer).getByText('Complete the employer’s section first.')).toBeInTheDocument();
  });

  it('screening off is said plainly, and bad ZIP lines are refused', async () => {
    api.getWotcSummary.mockResolvedValue({ truncated: false, screened: 0, declined: 0, eligible: 0, toFile: 0, overdue: 0, dueThisWeek: 0, submitted: 0, filedOnTime: 0, certified: 0, denied: 0, estimatedCredit: 0, pipelineCredit: 0, byPlace: [] });
    api.listWotcScreenings.mockResolvedValue({ screenings: [], truncated: false });
    api.getWotcSettings.mockResolvedValue({ enabled: false, designatedZips: 0 });
    renderAs('HR_ADMINISTRATOR', <WotcDesk />, '/payroll/wotc');
    const turnOn = await screen.findByRole('button', { name: 'Turn on screening' });
    // The banner explains every zero below it, so it comes before the numbers.
    const firstTile = screen.getByText('Credit earned');
    expect(turnOn.compareDocumentPosition(firstTile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A plain label, not a form number in prime space.
    expect(screen.getAllByText('Download Form 9061 data').length).toBeGreaterThan(0);
    await userEvent.click(turnOn);
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/designated zip codes/i), '1234 EZ');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('isn’t a 5-digit ZIP');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('<AcaHours>', () => {
  it('a progress bar against 130 that a screen reader can read, and the offer owed', async () => {
    api.getAcaSummary.mockResolvedValue({
      truncated: false,
      year: 2026,
      threshold: 130,
      counts: { measured: 2, fullTime: 1, approaching: 0, onTrack: 1, newHires: 0, crossingThreshold: 0, offersDue: 1, offersOverdue: 0 },
      exposure: { offeredShare: 0, a: 0, b: 5_010, failsNinetyFive: true, amounts: { a: 3_340, b: 5_010 }, fullTime: 1, offered: 0 },
      likelyAle: false,
      byClient: [],
    });
    api.listAcaWorkers.mockResolvedValue({
      truncated: false,
      fullTimeHoursPerMonth: 130,
      workers: [
        {
          associateId: 'a1',
          name: 'Fay Fulltime',
          clientId: null,
          clientName: null,
          siteName: null,
          hireDate: '2022-01-03',
          measurement: {
            classification: 'VARIABLE_HOUR',
            status: 'full_time',
            today: 'full_time',
            inProgress: { start: '2025-11-02', end: '2026-11-01', monthsElapsed: 6, hours: 900, averageHours: 150, stabilityStart: '2027-01-01', kind: 'standard' },
            offerDue: { stabilityStart: '2026-01-01', stabilityEnd: '2027-01-01', dueBy: '2026-01-01', reason: 'measured_full_time' },
          },
          offer: null,
          offerState: 'due',
        },
      ],
    });
    api.recordAcaOffer.mockResolvedValue({ offer: { id: 'o1', response: 'PENDING' } });
    renderAs('HR_ADMINISTRATOR', <AcaHours />, '/benefits/aca');
    expect(await screen.findByText('Fay Fulltime')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar', { name: '150 hours a month of 130' })[0]).toHaveAttribute('aria-valuenow', '150');
    expect(screen.getByText(/under the 95% line/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('row', { name: 'Open Fay Fulltime' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record the offer' }));
    await waitFor(() => expect(api.recordAcaOffer).toHaveBeenCalledWith({ associateId: 'a1', stabilityStart: '2026-01-01', stabilityEnd: '2027-01-01' }));
  });
});

describe('<WotcScreeningTask>', () => {
  const at = '/onboarding/me/app1/tasks/wotc_screening';
  const page = (
    <Routes>
      <Route path="/onboarding/me/:applicationId/tasks/wotc_screening" element={<WotcScreeningTask />} />
      <Route path="/onboarding/me/:applicationId" element={<p>Checklist</p>} />
    </Routes>
  );
  it('veteran follow-ups appear only after “yes”; every question needs an answer before signing', async () => {
    api.getWotcApplicant.mockResolvedValue({ questions: [], screening: null });
    api.submitWotcApplicant.mockResolvedValue({ status: 'LIKELY_ELIGIBLE', signedAt: '2026-06-20T10:00:00Z' });
    renderAs('ASSOCIATE', page, at, { associateId: 'a1' });
    const veteran = await screen.findByRole('group', { name: /veteran of the u\.s\. armed forces/i });
    expect(screen.queryByText(/service-connected disability/i)).toBeNull();
    await userEvent.click(within(veteran).getByLabelText('Yes'));
    expect(screen.getByText(/service-connected disability/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/type your full name/i), 'Val Vet');
    await userEvent.click(screen.getByRole('button', { name: 'Sign and submit' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/answer each question/i);
    expect(api.submitWotcApplicant).not.toHaveBeenCalled();
  });
  it('“I’d rather not answer” completes it with just a signature', async () => {
    api.getWotcApplicant.mockResolvedValue({ questions: [], screening: null });
    api.submitWotcApplicant.mockResolvedValue({ status: 'DECLINED', signedAt: '2026-06-20T10:00:00Z' });
    renderAs('ASSOCIATE', page, at, { associateId: 'a1' });
    await userEvent.type(await screen.findByLabelText(/type your full name/i), 'Val Vet');
    await userEvent.click(screen.getByRole('button', { name: /rather not answer/i }));
    await waitFor(() => expect(api.submitWotcApplicant).toHaveBeenCalledWith('app1', { declined: true, signedName: 'Val Vet' }));
    expect(await screen.findByText('Checklist')).toBeInTheDocument();
  });
});

describe('<StateCertificateCard>', () => {
  it('a Maryland worker picks a county before the MW507 saves', async () => {
    api.getMyStateCertificates.mockResolvedValue({ workState: 'MD', needed: { state: 'MD', name: 'Maryland', form: 'MW507' }, certificates: [] });
    api.saveMyStateCertificate.mockResolvedValue({ certificate: {} });
    renderAs('ASSOCIATE', <StateCertificateCard mode="self" />, '/', { associateId: 'a1' });
    const save = await screen.findByRole('button', { name: 'Save MW507' });
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/county where you live/i), 'HOWARD');
    await userEvent.click(save);
    await waitFor(() => expect(api.saveMyStateCertificate).toHaveBeenCalledWith(expect.objectContaining({ state: 'MD', county: 'HOWARD', allowances: 1 })));
  });
  it('a state without its own certificate draws nothing', async () => {
    api.getMyStateCertificates.mockResolvedValue({ workState: 'FL', needed: null, certificates: [] });
    const { container } = renderAs('ASSOCIATE', <StateCertificateCard mode="self" />, '/', { associateId: 'a1' });
    await waitFor(() => expect(api.getMyStateCertificates).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
