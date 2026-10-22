import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderAs } from '../hrPack/harness';

vi.mock('@/lib/benefitsApi', () => ({
  listMyEnrollments: vi.fn(),
  listPlans: vi.fn(),
  enrollMe: vi.fn(),
  terminateMyEnrollment: vi.fn(),
}));
vi.mock('@/lib/useClients', () => ({
  useClients: () => ({ clients: [{ id: 'c1', name: 'Life Co' }], isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/payrollDeskApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollDeskApi')>()),
  getFederalW4: vi.fn(),
  saveFederalW4: vi.fn(),
  uploadLockInLetter: vi.fn(),
}));
vi.mock('@/lib/payrollTax91Api', async (orig) => ({
  ...(await orig<typeof import('@/lib/payrollTax91Api')>()),
  listTaxForms: vi.fn(),
}));
vi.mock('@/lib/providersApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/providersApi')>()),
  providerSummary: vi.fn().mockResolvedValue({ connected: {} }),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { enrollMe, listMyEnrollments, listPlans } from '@/lib/benefitsApi';
import { getFederalW4, uploadLockInLetter, type FederalW4Facts } from '@/lib/payrollDeskApi';
import { listTaxForms } from '@/lib/payrollTax91Api';
import { BenefitsHome } from '@/pages/benefits/BenefitsHome';
import { FederalW4Card } from '@/components/payroll/FederalW4Card';
import { financeTasks } from '@/pages/finance/FinanceCockpit';
import type { FinanceOverview } from '@/pages/finance/financeTypes';
import { LegacyPayrollRedirect, legacyPayrollTarget } from '@/pages/payroll/legacyPayrollRoutes';
import { RejectedFormsCard } from '@/pages/payrollTaxes/ReturnsTab';
import { CashForecastPage } from '@/pages/finance/CashForecastPage';

/**
 * Wave 2, money: the life coverage on the enrollment, the IRS lock-in letter
 * on the W-4 card, the missed payday in finance's Today, the retired payroll
 * addresses and the rejected forms on the Returns tab, and the cash
 * forecast's retirement and carrier lines.
 */

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
});

describe('group-term life on the enrollment screen', () => {
  it('asks for the coverage amount, allows $0 per check, and sends the face amount in cents', async () => {
    vi.mocked(listMyEnrollments).mockResolvedValue({ enrollments: [] });
    vi.mocked(listPlans).mockResolvedValue({
      plans: [{ id: 'p-life', clientId: 'c1', kind: 'LIFE_INSURANCE', name: 'Group life', description: null, employerContributionCentsPerPeriod: 0, employeeContributionDefaultCentsPerPeriod: 0, isActive: true }],
    });
    vi.mocked(enrollMe).mockResolvedValue({} as never);
    const user = userEvent.setup();
    renderAs('ASSOCIATE', <BenefitsHome />, '/benefits', { associateId: 'a1' });
    await user.click(await screen.findByRole('button', { name: /Enroll/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Coverage amount/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Your share per check/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Confirm enrollment' }));
    expect(await within(dialog).findByText(/Enter the coverage amount/)).toBeInTheDocument();
    expect(enrollMe).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Coverage amount/), '100000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm enrollment' }));
    await waitFor(() => expect(enrollMe).toHaveBeenCalledWith(expect.objectContaining({ planId: 'p-life', electedAmountCentsPerPeriod: 0, lifeCoverageCents: 10_000_000 })));
  });
});

describe('the IRS lock-in letter on the federal W-4 card', () => {
  it('uploads the letter and shows it on the card', async () => {
    const facts: FederalW4Facts = {
      exempt: false,
      exemptTaxYear: null,
      nonresidentAlien: false,
      pre2020Allowances: null,
      lockIn: { filingStatus: 'SINGLE', multipleJobs: false, effectiveDate: '2026-01-01' },
      lockInLetter: null,
      effective: { filingStatus: 'SINGLE', exempt: false, nonresidentAlien: false, pre2020Allowances: null, flags: ['LOCK_IN_LETTER'] },
    };
    vi.mocked(getFederalW4).mockResolvedValue(facts);
    vi.mocked(uploadLockInLetter).mockResolvedValue({ ...facts, lockInLetter: { documentId: 'd1', filename: 'letter-2800C.pdf', mimeType: 'application/pdf', uploadedAt: '2026-10-22T12:00:00Z', available: true } });
    renderAs('FINANCE_ACCOUNTANT', <FederalW4Card associateId="a1" />);
    expect(await screen.findByText(/The letter itself isn’t on file yet/)).toBeInTheDocument();
    const file = new File(['%PDF-1.4'], 'letter-2800C.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Lock-in letter file'), { target: { files: [file] } });
    await waitFor(() => expect(uploadLockInLetter).toHaveBeenCalledWith('a1', file));
    const link = await screen.findByRole('link', { name: 'letter-2800C.pdf' });
    expect(link).toHaveAttribute('href', '/api/payroll/federal-w4/a1/lock-in-letter');
    expect(screen.getByRole('button', { name: 'Replace the letter' })).toBeInTheDocument();
  });
});

describe('finance Today shows the missed payday', () => {
  it('puts the Inbox’s missed paydays first, with its link', () => {
    const t = ((k: string, v?: Record<string, unknown>) => `${k}${v ? JSON.stringify(v) : ''}`) as never;
    const data = {
      close: { pendingEntries: 0, pendingHours: 0, oldestDay: null, byClient: [] },
      payrollCases: { open: 0, assignedToMe: 0 },
      settlements: { count: 1, total: 50 },
      receivables: { outstandingTotal: 0, outstandingCount: 0, oldestDays: null, avgDaysToPay: null, draftStatements: 0 },
      fieldglassQueue: [],
      financialChanges: { pending: 0, held: 0, open: 0 },
    } as unknown as FinanceOverview;
    const inbox = [{ key: 'payroll-missed-paydays', count: 2, description: '2 paydays passed with no run · 31h approved and unpaid for 3 people.', path: '/payroll?ledger=missed' }];
    const tasks = financeTasks(data, t, Date.now(), { inbox });
    expect(tasks[0]).toMatchObject({ key: 'missed', tone: 'alert', to: '/payroll?ledger=missed', sub: inbox[0]!.description });
    expect(tasks[0]!.title).toContain('"count":2');
    expect(financeTasks(data, t, Date.now(), { inbox: [{ ...inbox[0]!, count: 0 }] }).some((x) => x.key === 'missed')).toBe(false);
  });
});

describe('retired payroll addresses', () => {
  it('maps the old pages to the desks that own the work, keeping other parameters', () => {
    expect(legacyPayrollTarget('/payroll/tax', '')).toBe('/payroll/taxes?tab=returns');
    expect(legacyPayrollTarget('/payroll/tax', '?from=inbox')).toBe('/payroll/taxes?from=inbox&tab=returns');
    expect(legacyPayrollTarget('/payroll/compliance', '?tab=deposits')).toBe('/payroll/taxes?tab=deposits');
    expect(legacyPayrollTarget('/payroll/compliance', '?tab=remittances')).toBe('/payroll/garnishments?tab=remittances');
    expect(legacyPayrollTarget('/payroll/compliance', '?tab=newhire')).toBeNull();
    expect(legacyPayrollTarget('/payroll/compliance', '')).toBeNull();
  });

  it('redirects on the route, and renders the page when it still is one', async () => {
    const Where = () => <p>landed</p>;
    const { unmount } = render(
      <MemoryRouter initialEntries={['/payroll/compliance?tab=deposits']}>
        <Routes>
          <Route path="/payroll/compliance" element={<LegacyPayrollRedirect><p>compliance page</p></LegacyPayrollRedirect>} />
          <Route path="/payroll/taxes" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('landed')).toBeInTheDocument();
    unmount();
    render(
      <MemoryRouter initialEntries={['/payroll/compliance?tab=notices']}>
        <Routes>
          <Route path="/payroll/compliance" element={<LegacyPayrollRedirect><p>compliance page</p></LegacyPayrollRedirect>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('compliance page')).toBeInTheDocument();
  });

  it('the Returns tab lists the forms an agency rejected, with its reason', async () => {
    vi.mocked(listTaxForms).mockResolvedValue({
      forms: [
        { id: 'f1', kind: 'W2', taxYear: 2025, quarter: null, associateId: 'a1', associateName: 'Rae Jones', amounts: {}, status: 'DRAFT', filedAt: null, ein: null, recipientCopySentAt: null, createdAt: '2026-01-20T00:00:00Z', efileStatus: 'REJECTED', efileStatusAt: '2026-02-01T00:00:00Z', efileRejectionReason: 'SSN does not match the name.' },
      ],
    });
    renderAs('FINANCE_ACCOUNTANT', <RejectedFormsCard />, '/payroll/taxes?tab=returns');
    expect(await screen.findByText('Rejected by the agency (1)')).toBeInTheDocument();
    expect(screen.getByText(/W-2 \(Annual employee\) · 2025 · Rae Jones/)).toBeInTheDocument();
    expect(screen.getByText('SSN does not match the name.')).toBeInTheDocument();
    expect(listTaxForms).toHaveBeenCalledWith({ efileStatus: 'REJECTED' });
  });
});

describe('the cash forecast’s retirement and carrier lines', () => {
  it('names them', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      generatedAt: '2026-10-22T12:00:00Z',
      from: '2026-10-22',
      to: '2026-11-18',
      opening: null,
      minimumCash: null,
      lowest: null,
      weeks: [{ weekStart: '2026-10-22', weekEnd: '2026-10-28', inflow: 0, outflow: 380, net: -380, cumulative: -380, balance: -380 }],
      lines: [
        { date: '2026-10-22', kind: 'RETIREMENT', label: 'Alto 401(k) — contributions from the 2026-10-16 payday (not sent yet)', amount: -120, confidence: 'overdue', linkUrl: '/payroll/retirement' },
        { date: '2026-11-01', kind: 'BENEFITS', label: 'Blue Shield premiums — November 2026', amount: -260, confidence: 'estimated', linkUrl: '/benefits/carriers' },
      ],
      totals: { inflow: 0, outflow: 380, net: -380 },
    });
    renderAs('FINANCE_ACCOUNTANT', <CashForecastPage />);
    expect(await screen.findByText('Blue Shield premiums — November 2026')).toBeInTheDocument();
    expect(screen.getByText('Benefit carrier · Estimated')).toBeInTheDocument();
    expect(screen.getByText('Retirement plan · Past due')).toBeInTheDocument();
  });
});
