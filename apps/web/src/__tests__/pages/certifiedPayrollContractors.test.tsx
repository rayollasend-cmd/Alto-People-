import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderAs } from './hrPack/harness';

const api = {
  getWeek: vi.fn(),
  signWeek: vi.fn(),
  getMyW9: vi.fn(),
  submitMyW9: vi.fn(),
  listContractors: vi.fn(),
  getYearEnd: vi.fn(),
  getProject: vi.fn(),
  listProjects: vi.fn(),
  updateProject: vi.fn(),
  createProject: vi.fn(),
};
vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));
vi.mock('@/lib/certifiedPayrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/certifiedPayrollApi')>()),
  getWeek: (...a: unknown[]) => api.getWeek(...a),
  signWeek: (...a: unknown[]) => api.signWeek(...a),
  getMyW9: (...a: unknown[]) => api.getMyW9(...a),
  submitMyW9: (...a: unknown[]) => api.submitMyW9(...a),
  listContractors: (...a: unknown[]) => api.listContractors(...a),
  getYearEnd: (...a: unknown[]) => api.getYearEnd(...a),
  getProject: (...a: unknown[]) => api.getProject(...a),
  listProjects: (...a: unknown[]) => api.listProjects(...a),
  updateProject: (...a: unknown[]) => api.updateProject(...a),
  createProject: (...a: unknown[]) => api.createProject(...a),
}));

import { CertifiedWeek } from '@/pages/certifiedPayroll/CertifiedWeek';
import { CertifiedProject } from '@/pages/certifiedPayroll/CertifiedProject';
import { CertifiedPayrollDesk } from '@/pages/certifiedPayroll/CertifiedPayrollDesk';
import { MyW9 } from '@/pages/me/MyW9';
import { ContractorsDesk } from '@/pages/contractors/ContractorsDesk';
import { suggestAddresses } from '@/lib/geoApi';

/** One Sacramento suggestion, with a suite typed after the street. */
const SACRAMENTO = {
  label: '1500 Capitol Mall Suite 3',
  address: '1500 Capitol Mall Suite 3, Sacramento, California 95814',
  line1: '1500 Capitol Mall',
  line2: 'Suite 3',
  city: 'Sacramento',
  state: 'CA',
  zip: '95814',
  county: 'Sacramento County',
  lat: 38.577,
  lng: -121.5,
  precision: 'exact' as const,
};

const DAYS = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
const row = (over: Record<string, unknown> = {}) => ({
  associateId: 'a1', name: 'Rosa Lopez', idLast4: '4321', classification: 'Electrician', isApprentice: false,
  straight: [0, 8, 8, 8, 8, 8, 0], overtime: [0, 1, 1, 1, 1, 1, 0], totalStraight: 40, totalOvertime: 5,
  rate: 45, overtimeRate: 67.5, prevailingBase: 40, prevailingFringe: 10, requiredRate: 50, belowPrevailing: true,
  grossThisProject: 2137.5, grossAllWork: 2137.5, deductions: null, net: null, paid: false, ...over,
});
const week = (over: Record<string, unknown> = {}) => ({
  project: { id: 'p1', name: 'Civic Center Retrofit', state: 'CA', fringeMode: 'CASH', payrollOfficerName: 'Pat Payroll', payrollOfficerTitle: 'Payroll Officer' },
  weekEnding: '2026-09-05',
  payrollNumber: 2,
  report: null,
  week: { days: DAYS, rows: [row()], exceptions: [{ kind: 'BELOW_PREVAILING', associateId: 'a1', message: 'Rosa Lopez is paid $45.00 an hour; Electrician needs at least $50.00 including fringe.' }], totals: { hours: 45, grossThisProject: 2137.5, workers: 1 }, allPaid: false },
  ecprAvailable: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

function renderWeek() {
  return renderAs(
    'FINANCE_ACCOUNTANT',
    <Routes>
      <Route path="/payroll/certified/:id/weeks/:weekEnding" element={<CertifiedWeek />} />
    </Routes>,
    '/payroll/certified/p1/weeks/2026-09-05',
  );
}

describe('a certified payroll week', () => {
  it('shows the shortfall and will not let the officer sign over it', async () => {
    api.getWeek.mockResolvedValue(week());
    renderWeek();
    expect(await screen.findByText('Fix these before signing')).toBeInTheDocument();
    expect(screen.getByText(/needs at least \$50\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign the statement/ })).toBeDisabled();
    // The disabled button says what to do, in words.
    expect(screen.getByRole('button', { name: /Sign the statement/ })).toHaveAttribute('title', 'Fix the item listed below first');
    expect(screen.getByRole('button', { name: /eCPR file/ })).toBeDisabled();
  });

  it('signs a clean week with a typed name and the attestation', async () => {
    api.getWeek.mockResolvedValue(week({ week: { days: DAYS, rows: [row({ rate: 55, belowPrevailing: false, paid: true, deductions: { fica: 200, withholding: 400, other: 0, total: 600 }, net: 2012.5 })], exceptions: [], totals: { hours: 45, grossThisProject: 2612.5, workers: 1 }, allPaid: true } }));
    api.signWeek.mockResolvedValue({ status: 'SIGNED', payrollNumber: 2, pdfHash: 'a'.repeat(64) });
    renderWeek();
    await userEvent.click(await screen.findByRole('button', { name: /Sign the statement/ }));
    const sign = await screen.findByRole('button', { name: 'Sign' });
    expect(sign).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/I have read the statement/));
    await userEvent.click(sign);
    await waitFor(() => expect(api.signWeek).toHaveBeenCalledWith('p1', '2026-09-05', expect.objectContaining({ signatureName: 'Pat Payroll', signerTitle: 'Payroll Officer', fringeStatement: 'CASH', attest: true })));
  });
});

describe('the contractor’s W-9', () => {
  it('tells an employee they do not need one', async () => {
    api.getMyW9.mockResolvedValue({ required: false, status: 'NONE', signedAt: null, backupWithholding: false, form: { legalName: 'Ana', businessName: null, taxClassification: null, llcTaxClass: null, exemptPayeeCode: null, fatcaCode: null, addressLine1: null, city: null, state: null, zip: null, tinType: null, tinLast4: null, subjectToBackup: false } });
    renderAs('ASSOCIATE', <MyW9 />, '/me/w9', { associateId: 'a1' });
    expect(await screen.findByText('You don’t need a W-9')).toBeInTheDocument();
    // …and where their W-4 is (F500 G5).
    expect(await screen.findByRole('link', { name: 'See my W-4 on Pay' })).toHaveAttribute('href', '/payroll');
  });

  it('signs only with a nine-digit TIN, a typed name and the perjury statement', async () => {
    api.getMyW9.mockResolvedValue({ required: true, status: 'REQUESTED', signedAt: null, backupWithholding: true, form: { legalName: 'Pat Contractor', businessName: null, taxClassification: null, llcTaxClass: null, exemptPayeeCode: null, fatcaCode: null, addressLine1: '1 Main St', city: 'Sacramento', state: 'CA', zip: '95814', tinType: null, tinLast4: null, subjectToBackup: false } });
    api.submitMyW9.mockResolvedValue({ status: 'SIGNED', signedAt: '2026-10-18T12:00:00Z', tinLast4: '6789' });
    renderAs('ASSOCIATE', <MyW9 />, '/me/w9', { associateId: 'a1' });
    expect(await screen.findByText(/withholding 24% of your payments/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Sign W-9' });
    await userEvent.type(screen.getByLabelText(/Social Security number/), '123-45-678');
    await userEvent.type(screen.getByLabelText(/Type your full name to sign/), 'Pat Contractor');
    await userEvent.click(screen.getByLabelText(/Under penalties of perjury/));
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Social Security number/), '9');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await waitFor(() => expect(api.submitMyW9).toHaveBeenCalledWith(expect.objectContaining({ tin: '123456789', tinType: 'SSN', certify: true, subjectToBackup: false })));
  });

  it('the address picked from a suggestion fills the W-9’s one street line (suite included), city, state and ZIP', async () => {
    vi.mocked(suggestAddresses).mockResolvedValue({ available: true, provider: 'mapbox', outage: false, results: [SACRAMENTO] });
    api.getMyW9.mockResolvedValue({ required: true, status: 'REQUESTED', signedAt: null, backupWithholding: false, form: { legalName: 'Pat Contractor', businessName: null, taxClassification: null, llcTaxClass: null, exemptPayeeCode: null, fatcaCode: null, addressLine1: null, city: null, state: null, zip: null, tinType: null, tinLast4: null, subjectToBackup: false } });
    renderAs('ASSOCIATE', <MyW9 />, '/me/w9', { associateId: 'a1' });
    const street = await screen.findByLabelText(/^Street/);
    await userEvent.type(street, '1500 Capitol Mall Suite 3');
    await userEvent.click(await screen.findByRole('option', { name: /1500 Capitol Mall/ }));
    expect(street).toHaveValue('1500 Capitol Mall Suite 3');
    expect(screen.getByLabelText(/^City/)).toHaveValue('Sacramento');
    expect(screen.getByLabelText(/^State/)).toHaveValue('CA');
    expect(screen.getByLabelText(/^ZIP/)).toHaveValue('95814');
  });
});

describe('the contractors desk', () => {
  it('lists W-9, IRS check and backup withholding for each contractor', async () => {
    api.listContractors.mockResolvedValue({
      truncated: false,
      contractors: [
        { associateId: 'c1', name: 'Nia Contractor', email: 'n@example.com', employmentType: 'CONTRACTOR_1099_INDIVIDUAL', w9Status: 'NONE', w9SignedAt: null, hasTin: false, tinLast4: null, tinMatchStatus: 'NOT_CHECKED', tinMatchLabel: null, backupWithholding: true, backupReason: 'NO_TIN', openBNotices: [] },
      ],
    });
    renderAs('FINANCE_ACCOUNTANT', <ContractorsDesk />, '/payroll/contractors');
    expect((await screen.findAllByText('Nia Contractor')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('24% · no TIN on file').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No W-9').length).toBeGreaterThan(0);
  });

  it('leads with the numbers finance asks for, each a filter or a link (F500 G3)', async () => {
    const c = (id: string, name: string, over: Record<string, unknown>) => ({ associateId: id, name, email: `${id}@example.com`, employmentType: 'CONTRACTOR_1099_INDIVIDUAL', w9Status: 'SIGNED', w9SignedAt: '2026-01-01T00:00:00Z', hasTin: true, tinLast4: '1234', tinMatchStatus: 'MATCHED', tinMatchLabel: null, backupWithholding: false, backupReason: null, openBNotices: [], ...over });
    api.listContractors.mockResolvedValue({
      truncated: false,
      contractors: [c('c1', 'Nia Contractor', { w9Status: 'NONE' }), c('c2', 'Omar Builder', { tinMatchStatus: 'MISMATCH' }), c('c3', 'Pia Painter', { w9Status: 'REQUESTED' }), c('c4', 'Quin Roofer', {})],
    });
    const ye = (rows: Array<{ necBox1: number; miscTotal: number }>, necForms: number, miscForms: number) => ({
      taxYear: 2026,
      threshold: 600,
      rows: rows.map((r, i) => ({ associateId: `c${i}`, name: `C${i}`, necBox4: 0, miscBox4: 0, states: [], needsNec: true, needsMisc: false, issues: [], ...r })),
      totals: { payees: rows.length, necForms, miscForms, necBox1: 0, backupWithheld: 0, withIssues: 0 },
    });
    // This year: $1,200.40 + $300 NEC and $99.60 MISC paid; the filing year's 1099s: 2 NEC + 1 MISC.
    api.getYearEnd.mockImplementation(async (year: number) => (year === new Date().getFullYear() ? ye([{ necBox1: 1200.4, miscTotal: 0 }, { necBox1: 300, miscTotal: 99.6 }], 2, 1) : ye([{ necBox1: 700, miscTotal: 0 }], 2, 1)));
    renderAs('FINANCE_ACCOUNTANT', <ContractorsDesk />, '/payroll/contractors');
    const strip = await screen.findByRole('group', { name: 'Contractors at a glance' });
    // Tiles count up to their value: wait for the end of it.
    await waitFor(() => expect(strip).toHaveTextContent(/Missing a W-92IRS TIN mismatches1Paid in \d{4}\$1,6001099s owed for \d{4}3/));
    // Missing a W-9: Nia (none) and Pia (requested) = 2; mismatches: Omar = 1.
    await userEvent.click(screen.getByRole('button', { name: /Missing a W-9/ }));
    await waitFor(() => expect(screen.queryAllByText('Omar Builder')).toHaveLength(0));
    expect(screen.getAllByText('Nia Contractor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Pia Painter').length).toBeGreaterThan(0);
    // The 1099 forms live on Year-end now: a link, not a ghost button.
    expect(screen.getByRole('link', { name: '1099 forms' })).toHaveAttribute('href', '/payroll/year-end?tab=forms');
    expect(screen.queryByRole('tab', { name: 'Year-end' })).toBeNull();
  });
});

const projectDetail = (over: Record<string, unknown> = {}) => ({
  project: {
    id: 'p1', name: 'Civic Center Retrofit', contractNumber: 'C-12', agency: 'City of Ventura', awardingBody: null, wageDeterminationNumber: 'CA20260001', dirProjectId: null, siteId: null, site: null,
    addressLine1: null, city: null, county: null, state: 'CA', zip: null, startDate: '2026-08-01', endDate: null, weekEndsOn: 6, fringeMode: 'CASH', payrollOfficerName: 'Pat Payroll', payrollOfficerTitle: 'Payroll Officer', status: 'ACTIVE',
    rates: [{ id: 'r1', classification: 'Electrician', baseRate: 40, fringeRate: 10, apprenticesPerJourneyman: null, effectiveFrom: '2026-08-01', effectiveTo: null }],
    workers: [
      { id: 'w1', associateId: 'a1', name: 'Rosa Lopez', classification: 'Electrician', isApprentice: false, apprenticeRegistration: null, apprenticeLevelPercent: null, startedOn: '2026-08-01', endedOn: null },
      { id: 'w2', associateId: 'a2', name: 'Ben Ortiz', classification: 'Electrician', isApprentice: false, apprenticeRegistration: null, apprenticeLevelPercent: null, startedOn: '2026-08-01', endedOn: '2026-08-20' },
    ],
  },
  weeks: [
    { weekEnding: '2026-09-12', status: 'DRAFT', payrollNumber: null, signedAt: null, submittedAt: null },
    { weekEnding: '2026-09-05', status: 'SIGNED', payrollNumber: 2, signedAt: '2026-09-07T10:00:00Z', submittedAt: null },
    { weekEnding: '2026-08-29', status: 'SUBMITTED', payrollNumber: 1, signedAt: '2026-08-31T10:00:00Z', submittedAt: '2026-09-01T10:00:00Z' },
  ],
  totals: { grossReported: 4275, weeksReported: 2 },
  ...over,
});

describe('a certified project record', () => {
  function renderProject() {
    return renderAs(
      'FINANCE_ACCOUNTANT',
      <Routes>
        <Route path="/payroll/certified/:id" element={<CertifiedProject />} />
        <Route path="/payroll/certified/:id/weeks/:weekEnding" element={<p>week page</p>} />
      </Routes>,
      '/payroll/certified/p1',
    );
  }

  it('leads with the facts that matter and opens the oldest week still owed', async () => {
    api.getProject.mockResolvedValue(projectDetail());
    renderProject();
    expect(await screen.findByRole('heading', { name: 'Civic Center Retrofit' })).toBeInTheDocument();
    expect(screen.getByText('Weeks owed')).toBeInTheDocument();
    expect(screen.getByText('Workers on site')).toBeInTheDocument();
    expect(screen.getByText('Gross on signed reports')).toBeInTheDocument();
    expect(screen.getByText('$4,275.00')).toBeInTheDocument();
    expect(screen.getByTitle('2 signed weeks')).toHaveTextContent('$4,275.00');
    // The oldest owed week (Sep 5, signed but not submitted), not the newest.
    await userEvent.click(screen.getByRole('button', { name: 'Open week ending Sep 5, 2026' }));
    expect(await screen.findByText('week page')).toBeInTheDocument();
  });

  it('closing a project asks first', async () => {
    api.getProject.mockResolvedValue(projectDetail({ weeks: [] }));
    api.updateProject.mockResolvedValue({ id: 'p1', status: 'CLOSED' });
    renderProject();
    await screen.findByRole('heading', { name: 'Civic Center Retrofit' });
    expect(screen.queryByRole('button', { name: /Open week ending/ })).toBeNull();
    const more = screen.queryByRole('button', { name: 'Close project' }) ?? (await openOverflow());
    await userEvent.click(more as HTMLElement);
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(dialog).toHaveTextContent('Close Civic Center Retrofit?');
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('a page still loading keeps its title', async () => {
    api.getProject.mockReturnValue(new Promise(() => {}));
    renderProject();
    expect(await screen.findByRole('heading', { name: 'Prevailing-wage project' })).toBeInTheDocument();
  });
});

async function openOverflow(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
  return screen.findByRole('menuitem', { name: 'Close project' });
}

describe('the certified payroll desk', () => {
  it('with no projects, the empty list carries the page, not three zero tiles', async () => {
    api.listProjects.mockResolvedValue({ projects: [] });
    renderAs('FINANCE_ACCOUNTANT', <CertifiedPayrollDesk />, '/payroll/certified');
    expect(await screen.findByText('No prevailing-wage projects')).toBeInTheDocument();
    expect(screen.queryByText('Active projects')).toBeNull();
    expect(screen.queryByText('Waiting for a signature')).toBeNull();
  });

  it('a new project’s address picked from a suggestion brings its county — the wage determination is by county', async () => {
    api.listProjects.mockResolvedValue({ projects: [] });
    api.createProject.mockResolvedValue({ project: { id: 'p9' } });
    vi.mocked(suggestAddresses).mockResolvedValue({ available: true, provider: 'mapbox', outage: false, results: [SACRAMENTO] });
    renderAs('FINANCE_ACCOUNTANT', <CertifiedPayrollDesk />, '/payroll/certified');
    await userEvent.click((await screen.findAllByRole('button', { name: 'New project' }))[0]!);
    await userEvent.type(screen.getByLabelText(/^Project name/), 'Capitol Annex');
    await userEvent.type(screen.getByLabelText(/^Street address/), '1500 Capitol Mall');
    await userEvent.click(await screen.findByRole('option', { name: /1500 Capitol Mall/ }));
    expect(screen.getByLabelText(/^County/)).toHaveValue('Sacramento');
    expect(screen.getByLabelText(/^State/)).toHaveValue('CA');
    await userEvent.click(screen.getByRole('button', { name: /Add project/ }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledTimes(1));
    expect(api.createProject.mock.calls[0]![0]).toMatchObject({ addressLine1: '1500 Capitol Mall Suite 3', city: 'Sacramento', county: 'Sacramento', state: 'CA', zip: '95814' });
  });
});
