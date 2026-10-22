import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderAs } from './hrPack/harness';

/**
 * Paper checks in the web app: the "pay by check this time" control on a
 * paycheck in the run screen, the run's Paper checks page, and the
 * associate's own request. The API is stubbed by path so every client
 * module stays real.
 */

type Call = { path: string; method: string; body: unknown };
const calls: Call[] = [];
let routes: Record<string, unknown> = {};
vi.mock('@/lib/api', async (orig) => {
  const real = await orig<typeof import('@/lib/api')>();
  return {
    ...real,
    apiFetch: async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body });
      const key = `${method} ${path.split('?')[0]}`;
      if (key in routes) {
        const v = routes[key];
        return typeof v === 'function' ? (v as (b: unknown) => unknown)(init?.body) : v;
      }
      // Anything else answers an object whose every field is an empty list, so unrelated widgets render empty.
      return new Proxy({}, { get: (_t, prop) => (prop === 'then' || typeof prop === 'symbol' ? undefined : []) });
    },
  };
});

import { AdminPayrollView } from '@/pages/payroll/AdminPayrollView';
import { PayrollChecksPage } from '@/pages/payroll/PayrollChecksPage';
import { PaperCheckRequestCard } from '@/pages/payroll/PaperCheckRequestCard';

const RUN = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';

const item = {
  id: ITEM,
  payrollRunId: RUN,
  associateId: '33333333-3333-4333-8333-333333333333',
  associateName: 'Ken Ito',
  hoursWorked: 40,
  hourlyRate: 12.5,
  grossPay: 500,
  federalWithholding: 0,
  fica: 0,
  medicare: 0,
  stateWithholding: 0,
  taxState: 'FL',
  ytdWages: 0,
  ytdMedicareWages: 0,
  employerFica: 0,
  employerMedicare: 0,
  employerFuta: 0,
  employerSuta: 0,
  netPay: 500,
  postTaxDeductions: 0,
  status: 'PENDING',
  disbursementRef: null,
  disbursedAt: null,
  failureReason: null,
  earnings: [],
};
const run = {
  id: RUN,
  clientId: null,
  clientName: null,
  periodStart: '2026-10-03',
  periodEnd: '2026-10-09',
  status: 'FINALIZED',
  totalGross: 500,
  totalTax: 0,
  totalNet: 500,
  totalEmployerTax: 0,
  itemCount: 1,
  notes: null,
  finalizedAt: '2026-10-10T12:00:00.000Z',
  disbursedAt: null,
  createdAt: '2026-10-10T12:00:00.000Z',
  kind: 'REGULAR',
  amendsRunId: null,
  approvedAt: null,
  items: [item],
};

const settings = { bankAccountId: 'b1', bankAccountLabel: 'Payroll ••••7788', bankName: 'First Coast Bank', bankAddress: null, fractionalRouting: null, offsetXPt: 0, offsetYPt: 0, hasSignature: false, signatureSignerName: null, twoSignatureOver: null, voidAfterDays: 90, micrFontInstalled: false, ready: true, gaps: ['Install a licensed E-13B MICR font and print on MICR toner so banks can read the check.'] };

beforeEach(() => {
  calls.length = 0;
  routes = {};
});

describe('the run screen', () => {
  it('switches one paycheck to a paper check with a reason, and shows the Check badge', async () => {
    let overrides: unknown[] = [];
    routes = {
      'GET /payroll/runs': { runs: [run] },
      [`GET /payroll/runs/${RUN}`]: run,
      'GET /payroll/config': { requireSecondApproval: false },
      'GET /payroll/upcoming': { nextRun: null, lastRun: null, pendingExceptions: 0, schedules: [] },
      [`GET /payroll/runs/${RUN}/review/status`]: { fingerprint: 'f', signoff: { required: false, current: null, stale: null, history: [], canSign: true, cannotSignReason: null } },
      [`GET /payroll/runs/${RUN}/checks`]: () => ({ run: { id: RUN, status: 'FINALIZED', kind: 'REGULAR', periodStart: '2026-10-03', periodEnd: '2026-10-09' }, checks: [], overrides, requests: [], settings }),
      [`PUT /payroll/items/${ITEM}/pay-by-check`]: (body: unknown) => {
        overrides = [{ itemId: ITEM, associateId: item.associateId, name: 'Ken Ito', reason: (body as { reason: string }).reason, source: 'PAYROLL', setAt: '2026-10-10T12:00:00.000Z', setByUserId: 'u1' }];
        return { override: overrides[0] };
      },
    };
    renderAs('HR_ADMINISTRATOR', <AdminPayrollView canProcess canVoid />, `/payroll?run=${RUN}`);
    const card = await screen.findByRole('button', { name: /ken ito/i, expanded: false });
    await userEvent.click(card);
    await userEvent.click(await screen.findByRole('button', { name: /pay by check this time/i }));
    const dialog = await screen.findByRole('dialog', { name: /pay ken ito by paper check this time/i });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Asked for a check this payday');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Pay by check' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === `/payroll/items/${ITEM}/pay-by-check`)).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ reason: 'Asked for a check this payday' });
    expect(await screen.findByText('Check')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /undo paper check/i })).toBeInTheDocument();
  });
});

describe('<PayrollChecksPage>', () => {
  const page = (data: Record<string, unknown>) => {
    routes = { [`GET /payroll/runs/${RUN}/checks`]: data, [`GET /payroll/runs/${RUN}/check-register.pdf`]: {} };
    return renderAs(
      'HR_ADMINISTRATOR',
      <Routes>
        <Route path="/payroll/runs/:id/checks" element={<PayrollChecksPage />} />
      </Routes>,
      `/payroll/runs/${RUN}/checks`,
    );
  };

  it('lists who is paid by check, the associate requests waiting, the issued checks, and what still needs setting up', async () => {
    page({
      run: { id: RUN, status: 'FINALIZED', kind: 'REGULAR', periodStart: '2026-10-03', periodEnd: '2026-10-09' },
      checks: [],
      overrides: [{ itemId: ITEM, associateId: 'a', name: 'Ken Ito', reason: 'Asked for a check', source: 'PAYROLL', setAt: '2026-10-10T12:00:00.000Z', setByUserId: 'u' }],
      requests: [{ id: 'req1', title: 'Paper check for Jane Doe (Oct 3 – Oct 9)', reason: 'Bank account closing', itemId: 'i2', createdAt: '2026-10-10T12:00:00.000Z' }],
      settings,
    });
    expect(await screen.findByText('Ken Ito')).toBeInTheDocument();
    expect(screen.getByText('Payroll’s call')).toBeInTheDocument();
    expect(screen.getByText('“Bank account closing”')).toBeInTheDocument();
    expect(screen.getByText('Before checks go to a bank')).toBeInTheDocument();
    expect(screen.getByText('Checks are issued at payout')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/approvals/requests/req1/decide' && (c.body as { decision: string }).decision === 'APPROVE')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === `/payroll/items/${ITEM}/pay-by-check`)).toBe(true));
  });

  it('shows each issued check with its status, the reissue chain, and the print action', async () => {
    page({
      run: { id: RUN, status: 'DISBURSED', kind: 'REGULAR', periodStart: '2026-10-03', periodEnd: '2026-10-09' },
      checks: [
        { id: 'c1', checkNumber: 1041, itemId: ITEM, associateId: 'a', payeeName: 'Ken Ito', amount: 500, issuedAt: '2026-10-16T12:00:00.000Z', status: 'VOID', printedAt: null, printCount: 0, voidedAt: '2026-10-16T13:00:00.000Z', voidReason: 'Lost in the mail', stopPaymentAt: null, stopPaymentRef: null, replacesCheckNumber: null, positivePayAt: null },
        { id: 'c2', checkNumber: 1042, itemId: ITEM, associateId: 'a', payeeName: 'Ken Ito', amount: 500, issuedAt: '2026-10-16T13:00:00.000Z', status: 'ISSUED', printedAt: null, printCount: 0, voidedAt: null, voidReason: null, stopPaymentAt: null, stopPaymentRef: null, replacesCheckNumber: 1041, positivePayAt: null },
      ],
      overrides: [],
      requests: [],
      settings: { ...settings, gaps: [] },
    });
    const grid = await screen.findByRole('table', { name: /checks issued/i });
    expect(within(grid).getByText('#1042')).toBeInTheDocument();
    expect(within(grid).getByText('Replaces #1041')).toBeInTheDocument();
    expect(within(grid).getByText('Lost in the mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /print 1 check/i })).toBeEnabled();
  });
});

describe('<PaperCheckRequestCard>', () => {
  it('asks for a check for the open paycheck, then says payroll will answer', async () => {
    routes = {
      'GET /me/pay-by-check': { openPaycheck: { itemId: ITEM, periodStart: '2026-10-03', periodEnd: '2026-10-09' }, override: null, request: null },
      'POST /me/pay-by-check': { openPaycheck: { itemId: ITEM, periodStart: '2026-10-03', periodEnd: '2026-10-09' }, override: null, request: { id: 'r1', status: 'PENDING', reason: 'Bank closing', decidedReason: null, createdAt: '2026-10-10T12:00:00.000Z' } },
    };
    renderAs('ASSOCIATE', <PaperCheckRequestCard />, '/payroll', { associateId: 'a1' });
    await userEvent.click(await screen.findByRole('button', { name: /ask for a paper check/i }));
    await userEvent.type(screen.getByRole('textbox', { name: /why/i }), 'Bank closing');
    await userEvent.click(screen.getByRole('button', { name: /send request/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/me/pay-by-check')).toBe(true));
    expect(await screen.findByText(/payroll will answer before payday/i)).toBeInTheDocument();
  });

  it('shows nothing when no paycheck is open to a change', async () => {
    routes = { 'GET /me/pay-by-check': { openPaycheck: null, override: null, request: null } };
    const { container } = renderAs('ASSOCIATE', <PaperCheckRequestCard />, '/payroll', { associateId: 'a1' });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(container.textContent).toBe('');
  });
});
