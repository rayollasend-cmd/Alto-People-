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
};
vi.mock('@/lib/certifiedPayrollApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/certifiedPayrollApi')>()),
  getWeek: (...a: unknown[]) => api.getWeek(...a),
  signWeek: (...a: unknown[]) => api.signWeek(...a),
  getMyW9: (...a: unknown[]) => api.getMyW9(...a),
  submitMyW9: (...a: unknown[]) => api.submitMyW9(...a),
  listContractors: (...a: unknown[]) => api.listContractors(...a),
}));

import { CertifiedWeek } from '@/pages/certifiedPayroll/CertifiedWeek';
import { MyW9 } from '@/pages/me/MyW9';
import { ContractorsDesk } from '@/pages/contractors/ContractorsDesk';

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
});
