import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderAs } from './hrPack/harness';

const api = vi.hoisted(() => ({
  getJurisdictions: vi.fn(),
  acknowledgeJurisdiction: vi.fn(),
  revokeJurisdiction: vi.fn(),
  calculateJurisdiction: vi.fn(),
  getReciprocity: vi.fn(),
  getTaxProfile: vi.fn(),
  saveTaxProfile: vi.fn(),
  addTaxCertificate: vi.fn(),
  revokeTaxCertificate: vi.fn(),
  getRunTaxLines: vi.fn(),
}));
vi.mock('@/lib/taxJurisdictionsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/taxJurisdictionsApi')>()), ...api }));

import { LocalTaxTables, ReciprocityTable } from '@/pages/payroll/TaxJurisdictions';
import { TaxWithholdingCard } from '@/components/payroll/TaxWithholdingCard';
import { RunTaxBreakdown } from '@/components/payroll/RunTaxBreakdown';

const row = (over: Record<string, unknown>) => ({
  code: 'PA-PITTSBURGH',
  state: 'PA',
  name: 'Pittsburgh earned income tax',
  kind: 'LOCAL',
  basis: 'PA_EIT',
  rate: '3% residents, 1% nonresidents',
  residentRate: 0.03,
  nonresidentRate: 0.01,
  annualAmount: null,
  administeredBy: 'Jordan Tax Service',
  taxYear: 2026,
  source: 'PA DCED municipal statistics (EIT/LST)',
  confidence: 'medium',
  note: null,
  workers: 3,
  review: { status: 'awaiting', taxYear: null, at: null, by: null, note: null },
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.getReciprocity.mockResolvedValue({
    source: 'Each state revenue department.',
    agreements: [{ workState: 'NJ', residentStates: ['PA'], form: 'NJ-165' }],
    convenienceOfEmployer: [{ state: 'NY', name: 'New York' }],
  });
  api.calculateJurisdiction.mockResolvedValue({
    code: 'PA-PITTSBURGH',
    resident: true,
    wages: 1500,
    frequency: 'BIWEEKLY',
    lines: [{ code: 'PA-PITTSBURGH', kind: 'LOCAL', label: 'Pittsburgh earned income tax (resident rate)', resident: true, workState: 'PA', wages: 1500, amount: 45, employer: false, note: null }],
    localTotal: 45,
    stateTotal: 46.05,
    employerLocalTotal: 0,
    unresolved: [],
  });
});

describe('Tax tables › Local', () => {
  it('leads with what needs review, checks a paycheck, and records a review only once confirmed', async () => {
    api.getJurisdictions.mockResolvedValue({
      engine: { key: 'IN_HOUSE', label: 'Alto', environment: null },
      counts: { inUse: 2, awaitingInUse: 1, reviewed: 1, blockedWorkers: 3, unresolvedWorkers: 1 },
      jurisdictions: [
        row({}),
        row({ code: 'OH-COLUMBUS', state: 'OH', name: 'Columbus income tax', basis: 'WORK_CITY', workers: 2, review: { status: 'reviewed', taxYear: 2026, at: '2026-10-01T00:00:00Z', by: 'Hana Ruiz', note: null } }),
        row({ code: 'MI-DETROIT', state: 'MI', name: 'Detroit income tax', workers: 0 }),
      ],
      unresolved: [{ associateId: 'a1', name: 'Pat Burgh', questions: ['Lives in Pennsylvania, but the home municipality (PSD code) isn’t set.'] }],
    });
    api.acknowledgeJurisdiction.mockResolvedValue({ ok: true });
    renderAs('HR_ADMINISTRATOR', <LocalTaxTables />, '/payroll/tax-tables?tab=local');
    expect(await screen.findByText('Pittsburgh earned income tax')).toBeInTheDocument();
    expect(screen.queryByText('Columbus income tax')).toBeNull(); // reviewed — not in "Needs review"
    expect(screen.queryByText('Detroit income tax')).toBeNull(); // nobody owes it
    expect(screen.getByText('Questions to answer', { selector: 'h3, [class*="CardTitle"], div' })).toBeInTheDocument();
    expect(screen.getByText('Pat Burgh')).toBeInTheDocument();
    // The reciprocity table is its own tab now (F500 G3); the engine link only shows to someone who can open it.
    expect(screen.queryByText(/Works in NJ, lives in PA/)).toBeNull();

    await userEvent.click(screen.getByRole('row', { name: 'Open Pittsburgh earned income tax' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Jordan Tax Service')).toBeInTheDocument();
    expect(await within(drawer).findByText('$45.00')).toBeInTheDocument();
    const record = within(drawer).getByRole('button', { name: 'Record the review' });
    expect(record).toBeDisabled();
    await userEvent.click(within(drawer).getByRole('checkbox'));
    await userEvent.click(record);
    await waitFor(() => expect(api.acknowledgeJurisdiction).toHaveBeenCalledWith('PA-PITTSBURGH', undefined));
  });

  it('the reciprocity table is its own tab', async () => {
    renderAs('FINANCE_ACCOUNTANT', <ReciprocityTable />, '/payroll/tax-tables?tab=reciprocity');
    expect(await screen.findByText(/Works in NJ, lives in PA/)).toBeInTheDocument();
  });

  it('says so when the list fails to load', async () => {
    api.getJurisdictions.mockRejectedValue(new Error('boom'));
    renderAs('HR_ADMINISTRATOR', <LocalTaxTables />, '/payroll/tax-tables?tab=local');
    expect(await screen.findByText('Could not load jurisdictions.')).toBeInTheDocument();
  });
});

describe('<TaxWithholdingCard>', () => {
  it('shows each tax and why, the open question, and saves the PSD code', async () => {
    const profile = {
      associateId: 'a1',
      name: 'Pat Burgh',
      employmentType: 'W2_EMPLOYEE',
      home: { state: 'PA', city: 'Smalltown', zip: '15001' },
      workSites: [{ name: 'Strip District', state: 'PA', city: 'Pittsburgh' }],
      profile: { residentPsdCode: null, residentMunicipality: null, residentSchoolDistrict: null, residentCountyJan1: null, residentLocalCode: null, notes: null, updatedAt: null },
      certificates: [],
      withholding: [
        { code: 'ST-PA', kind: 'STATE', label: 'PA state income tax', resident: true, employer: false, rate: null, why: 'Lives in PA.', note: null, review: null },
        { code: 'PA-PITTSBURGH-LST', kind: 'LOCAL', label: 'Pittsburgh local services tax', resident: false, employer: false, rate: '$52 a year', why: 'Works in Pittsburgh.', note: null, review: 'awaiting' },
      ],
      unresolved: ['Lives in Pennsylvania, but the home municipality (PSD code) isn’t set.'],
      manualLocalRule: null,
    };
    api.getTaxProfile.mockResolvedValue(profile);
    api.saveTaxProfile.mockResolvedValue({ ...profile, unresolved: [] });
    renderAs('HR_ADMINISTRATOR', <TaxWithholdingCard associateId="a1" />, '/people/a1');
    expect(await screen.findByText('Taxes we withhold')).toBeInTheDocument();
    expect(screen.getByText('Pittsburgh local services tax')).toBeInTheDocument();
    expect(screen.getByText('Works in Pittsburgh.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/PSD code/);
    await userEvent.type(screen.getByLabelText('PSD code'), '700102');
    await userEvent.click(screen.getByRole('button', { name: 'Save home jurisdiction' }));
    await waitFor(() => expect(api.saveTaxProfile).toHaveBeenCalledWith('a1', expect.objectContaining({ residentPsdCode: '700102' })));
  });
});

describe('<RunTaxBreakdown>', () => {
  it('lists the run’s taxes by jurisdiction', async () => {
    api.getRunTaxLines.mockResolvedValue({
      jurisdictions: [
        { code: 'ST-PA', kind: 'STATE', name: 'PA state income tax', employer: false, wages: 3000, amount: 92.1, people: 3 },
        { code: 'PA-PITTSBURGH', kind: 'LOCAL', name: 'Pittsburgh earned income tax', employer: false, wages: 3000, amount: 90, people: 3 },
      ],
      totals: { state: 92.1, local: 90, employer: 0 },
    });
    renderAs('HR_ADMINISTRATOR', <RunTaxBreakdown runId="r1" />, '/payroll');
    expect(await screen.findByText('Pittsburgh earned income tax')).toBeInTheDocument();
    expect(screen.getByText('$90.00')).toBeInTheDocument();
  });

  it('renders nothing for a run without jurisdiction lines', async () => {
    api.getRunTaxLines.mockResolvedValue({ jurisdictions: [], totals: { state: 0, local: 0, employer: 0 } });
    const { container } = renderAs('HR_ADMINISTRATOR', <RunTaxBreakdown runId="r2" />, '/payroll');
    await waitFor(() => expect(api.getRunTaxLines).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});
