import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { BooksBill, BooksPayablesOptions, BooksVendor } from '@alto-people/shared';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { renderAs } from '../../hrPack/harness';

const api = vi.hoisted(() => ({
  listVendors: vi.fn(),
  getVendor: vi.fn(),
  createVendor: vi.fn(),
  updateVendor: vi.fn(),
  listBills: vi.fn(),
  getBill: vi.fn(),
  createBill: vi.fn(),
  updateBill: vi.fn(),
  submitBill: vi.fn(),
  approveBills: vi.fn(),
  withdrawBill: vi.fn(),
  reopenBill: vi.fn(),
  voidBill: vi.fn(),
  uploadBillAttachment: vi.fn(),
  payablesOptions: vi.fn(),
  payBills: vi.fn(),
  payBillsBatch: vi.fn(),
  voidBillPayment: vi.fn(),
  listRecurringBills: vi.fn(),
  createRecurringBill: vi.fn(),
  updateRecurringBill: vi.fn(),
  apAging: vi.fn(),
  vendor1099: vi.fn(),
}));
vi.mock('@/lib/books/payablesApi', async (orig) => ({ ...(await orig<typeof import('@/lib/books/payablesApi')>()), ...api }));
const approvals = vi.hoisted(() => ({ decideApprovalRequest: vi.fn() }));
vi.mock('@/lib/approvalRequestsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/approvalRequestsApi')>()), ...approvals }));

import { BillsPage } from '@/pages/books/payables/BillsPage';
import { BillDetailPage } from '@/pages/books/payables/BillDetailPage';
import { VendorDetailPage } from '@/pages/books/payables/VendorDetailPage';

/**
 * Payables on screen: bills by what needs doing, one vendor's bills paid in
 * one go, a new bill sent to a second person, that person approving it, and
 * a vendor's bank change waiting for approval.
 */

const FUEL = '00000000-0000-4000-8000-0000000000f1';
const CASH = '00000000-0000-4000-8000-0000000000c1';
const SHELL = '00000000-0000-4000-8000-00000000a001';

const OPTIONS: BooksPayablesOptions = {
  accounts: [{ id: FUEL, code: '6200', name: 'Vehicle fuel', type: 'EXPENSE', subtype: 'EXPENSE' }],
  payFrom: [{ id: CASH, code: '1000', name: 'Operating checking', subtype: 'BANK' }],
  clients: [],
  sites: [],
  ownAch: true,
};

const vendor = (o: Partial<BooksVendor> = {}): BooksVendor => ({
  id: SHELL,
  name: 'Shell Fleet',
  email: null,
  phone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  zip: null,
  is1099: false,
  hasTaxId: false,
  taxIdLast4: null,
  defaultExpenseAccountId: FUEL,
  defaultExpenseAccountName: '6200 Vehicle fuel',
  paymentMethod: 'ACH',
  hasBank: true,
  accountLast4: '6789',
  termsDays: 15,
  notes: null,
  isActive: true,
  balance: 500,
  pendingBankChange: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...o,
});

const bill = (o: Partial<BooksBill> = {}): BooksBill => ({
  id: '00000000-0000-4000-8000-00000000b001',
  vendorId: SHELL,
  vendorName: 'Shell Fleet',
  billNumber: 'SF-1',
  billDate: '2026-10-01',
  dueDate: '2026-10-16',
  status: 'APPROVED',
  total: 300,
  balance: 300,
  memo: null,
  hasAttachment: false,
  attachmentName: null,
  daysPastDue: 3,
  approval: null,
  approvedAt: '2026-10-02T12:00:00.000Z',
  approvedByName: 'Pat Owner',
  journalEntryId: 'e1',
  journalEntryNumber: 12,
  recurringName: null,
  lines: [{ id: 'l1', lineNo: 1, accountId: FUEL, accountCode: '6200', accountName: 'Vehicle fuel', description: 'Fleet fuel', amount: 300, clientId: null, clientName: null, siteId: null, departmentId: null, costCenterId: null }],
  payments: [],
  createdByName: 'Fin Person',
  createdAt: '2026-10-01T12:00:00.000Z',
  ...o,
});

function renderPage(ui: ReactNode, route: string, path: string) {
  return renderAs(
    'FINANCE_ACCOUNTANT',
    <TooltipProvider>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<p>Navigated away</p>} />
      </Routes>
    </TooltipProvider>,
    route,
  );
}

beforeEach(() => {
  for (const f of [...Object.values(api), ...Object.values(approvals)]) f.mockReset();
  localStorage.clear();
  api.payablesOptions.mockResolvedValue(OPTIONS);
  api.listVendors.mockResolvedValue({ vendors: [vendor()] });
});

describe('<BillsPage>', () => {
  it('shows what is owed and late, and pays one vendor’s bills together over ACH', async () => {
    const late = bill();
    const second = bill({ id: '00000000-0000-4000-8000-00000000b002', billNumber: 'SF-2', total: 200, balance: 200, daysPastDue: -4, dueDate: '2026-10-23' });
    api.listBills.mockImplementation(async ({ tab }: { tab?: string }) => ({ bills: tab === 'approve' ? [] : [late, second] }));
    api.payBills.mockResolvedValue({ payment: { amount: 500, achFileId: 'f1' } });
    const user = userEvent.setup();
    renderPage(<BillsPage />, '/books/bills', '/books/bills');
    expect((await screen.findAllByText('3 days late')).length).toBeGreaterThan(0);
    expect(screen.getByText('Due in 4 days')).toBeInTheDocument();
    expect(screen.getAllByText('$500.00').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('checkbox', { name: /Select every unpaid bill/i }));
    await user.click(await screen.findByRole('button', { name: /Pay 2 bills · \$500\.00/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pay Shell Fleet' });
    expect(within(dialog).getByRole('checkbox', { name: /Send it over the company’s ACH/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Send $500.00' }));
    await waitFor(() =>
      expect(api.payBills).toHaveBeenCalledWith(expect.objectContaining({ vendorId: SHELL, method: 'ACH', bankAccountId: CASH, sendAch: true, applications: [{ billId: late.id, amount: 300 }, { billId: second.id, amount: 200 }] })),
    );
  });
});

describe('<BillsPage> — one bill run for several vendors (finance walk 8)', () => {
  const LEASE = '00000000-0000-4000-8000-00000000a002';
  it('pays every bill due by Friday, grouped by vendor, with the cash left afterwards — in one request', async () => {
    const shell = bill({ dueDate: '2026-10-20' });
    const lease = bill({ id: '00000000-0000-4000-8000-00000000b009', vendorId: LEASE, vendorName: 'Coastal Van Lease', billNumber: 'L-1', total: 450, balance: 450, dueDate: '2026-10-21' });
    const later = bill({ id: '00000000-0000-4000-8000-00000000b010', billNumber: 'SF-9', total: 99, balance: 99, dueDate: '2099-01-01', daysPastDue: -9999 });
    api.listBills.mockImplementation(async ({ tab }: { tab?: string }) => ({ bills: tab === 'approve' ? [] : [shell, lease, later] }));
    api.payablesOptions.mockResolvedValue({ ...OPTIONS, ownAch: false, cashOnHand: 2000 });
    api.listVendors.mockResolvedValue({ vendors: [vendor(), vendor({ id: LEASE, name: 'Coastal Van Lease', paymentMethod: 'CHECK' })] });
    api.payBillsBatch.mockResolvedValue({ payments: [{ amount: 300 }, { amount: 450 }], cashAfter: 1250 });
    const user = userEvent.setup();
    renderPage(<BillsPage />, '/books/bills', '/books/bills');
    await user.click(await screen.findByRole('button', { name: /Pay bills due/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pay bills due' });
    fireEvent.change(within(dialog).getByLabelText('Pay bills due by'), { target: { value: '2026-10-23' } });
    const list = within(dialog).getByRole('list', { name: 'Vendors in this run' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    // Total = the sum of the vendor rows; cash left = cash today less the total.
    const run = within(dialog).getByRole('list', { name: 'Vendors in this run' }).parentElement!;
    expect(within(run).getByText('$750.00')).toBeInTheDocument();
    expect(within(run).getByText('$1,250.00')).toBeInTheDocument();
    // Take one vendor out: the total follows.
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pay Coastal Van Lease' }));
    expect(within(run).getByText('$300.00', { selector: 'dd' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Pay Coastal Van Lease' }));
    await user.click(within(dialog).getByRole('button', { name: 'Pay 2 vendors · $750.00' }));
    await waitFor(() =>
      expect(api.payBillsBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'ACH',
          bankAccountId: CASH,
          sendAch: false,
          vendors: [
            { vendorId: LEASE, applications: [{ billId: lease.id, amount: 450 }] },
            { vendorId: SHELL, applications: [{ billId: shell.id, amount: 300 }] },
          ],
        }),
      ),
    );
  });

  it('bills of two vendors picked on the grid open one run, not “one vendor at a time”', async () => {
    const shell = bill();
    const lease = bill({ id: '00000000-0000-4000-8000-00000000b009', vendorId: LEASE, vendorName: 'Coastal Van Lease', billNumber: 'L-1', total: 450, balance: 450 });
    api.listBills.mockImplementation(async ({ tab }: { tab?: string }) => ({ bills: tab === 'approve' ? [] : [shell, lease] }));
    const user = userEvent.setup();
    renderPage(<BillsPage />, '/books/bills', '/books/bills');
    await user.click(await screen.findByRole('checkbox', { name: /Select every unpaid bill/i }));
    await user.click(await screen.findByRole('button', { name: /Pay 2 bills to 2 vendors · \$750\.00/ }));
    expect(await screen.findByRole('dialog', { name: 'Pay 2 vendors' })).toBeInTheDocument();
  });
});

describe('<BillsPage> — To approve', () => {
  const pending = (id: string, total: number, mayDecide: boolean) =>
    bill({ id, total, balance: total, status: 'PENDING_APPROVAL', approvedAt: null, approvedByName: null, journalEntryId: null, approval: { id: `a-${id}`, status: 'PENDING', requesterName: mayDecide ? 'Fin Person' : 'You', decidedByName: null, reason: null, mayDecide, createdAt: '2026-10-02T12:00:00.000Z' } });

  it('opens on ?tab=approve, approves the selection in one go, and says why the requester’s own can’t be picked', async () => {
    const one = pending('00000000-0000-4000-8000-00000000b011', 100, true);
    const two = pending('00000000-0000-4000-8000-00000000b012', 250, true);
    const mine = pending('00000000-0000-4000-8000-00000000b013', 75, false);
    api.listBills.mockImplementation(async ({ tab }: { tab?: string }) => ({ bills: tab === 'approve' ? [one, two, mine] : [] }));
    api.approveBills.mockResolvedValue({ approved: [{ id: one.id, total: 100, vendorName: 'Shell Fleet' }, { id: two.id, total: 250, vendorName: 'Shell Fleet' }], skipped: [] });
    const user = userEvent.setup();
    renderPage(<BillsPage />, '/books/bills?tab=approve', '/books/bills');
    expect(await screen.findByText(/One bill here isn’t yours to approve/)).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: /Select every bill you can approve/i }));
    await user.click(await screen.findByRole('button', { name: /Approve 2 bills · \$350\.00/ }));
    await waitFor(() => expect(api.approveBills).toHaveBeenCalledWith([one.id, two.id]));
  });
});

describe('<BillDetailPage>', () => {
  it('a new bill takes the vendor’s usual account and goes to a second person', async () => {
    api.createBill.mockResolvedValue({ bill: bill({ status: 'DRAFT' }) });
    api.submitBill.mockResolvedValue({ pending: true, approvalId: 'a1', title: 'x' });
    const user = userEvent.setup();
    renderPage(<BillDetailPage />, '/books/bills/new', '/books/bills/:id');
    const vendorSelect = await screen.findByLabelText('Vendor');
    await waitFor(() => expect(within(vendorSelect as HTMLElement).getByRole('option', { name: 'Shell Fleet' })).toBeInTheDocument());
    fireEvent.change(vendorSelect, { target: { value: SHELL } });
    expect((screen.getByLabelText('Line 1 — account') as HTMLSelectElement).value).toBe(FUEL);
    await user.type(screen.getByLabelText('Amount'), '412.50');
    expect(screen.getByText('$412.50')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(api.createBill).toHaveBeenCalledWith(expect.objectContaining({ vendorId: SHELL, lines: [expect.objectContaining({ accountId: FUEL, amount: 412.5 })] })));
    await waitFor(() => expect(api.submitBill).toHaveBeenCalled());
  });

  it('“Send & enter another” keeps the vendor and clears the rest', async () => {
    api.createBill.mockResolvedValue({ bill: bill({ status: 'DRAFT' }) });
    api.submitBill.mockResolvedValue({ pending: true, approvalId: 'a1', title: 'x' });
    const user = userEvent.setup();
    renderPage(<BillDetailPage />, '/books/bills/new', '/books/bills/:id');
    const vendorSelect = await screen.findByLabelText('Vendor');
    await waitFor(() => expect(within(vendorSelect as HTMLElement).getByRole('option', { name: 'Shell Fleet' })).toBeInTheDocument());
    fireEvent.change(vendorSelect, { target: { value: SHELL } });
    await user.type(screen.getByLabelText('Invoice number'), 'SF-9');
    await user.type(screen.getByLabelText('Amount'), '80');
    await user.click(screen.getByRole('button', { name: 'Send & enter another' }));
    await waitFor(() => expect(api.submitBill).toHaveBeenCalled());
    expect(await screen.findByText(/1 sent for approval this sitting/)).toBeInTheDocument();
    expect(screen.queryByText('Navigated away')).toBeNull();
    expect((screen.getByLabelText('Vendor') as HTMLSelectElement).value).toBe(SHELL);
    expect(screen.getByLabelText('Invoice number')).toHaveValue('');
    expect(screen.getByLabelText('Amount')).toHaveValue(null);
    expect((screen.getByLabelText('Line 1 — account') as HTMLSelectElement).value).toBe(FUEL);
  });

  it('“Approve & next” approves and opens the next bill waiting on this person', async () => {
    const waiting = (id: string, total: number) =>
      bill({ id, total, status: 'PENDING_APPROVAL', approvedAt: null, approvedByName: null, journalEntryId: null, approval: { id: `a-${id}`, status: 'PENDING', requesterName: 'Fin Person', decidedByName: null, reason: null, mayDecide: true, createdAt: '2026-10-02T12:00:00.000Z' } });
    const here = waiting('00000000-0000-4000-8000-00000000b021', 300);
    const next = waiting('00000000-0000-4000-8000-00000000b022', 90);
    api.getBill.mockResolvedValue({ bill: here });
    api.listBills.mockResolvedValue({ bills: [here, next] });
    approvals.decideApprovalRequest.mockResolvedValue({});
    const user = userEvent.setup();
    renderAs(
      'FINANCE_ACCOUNTANT',
      <TooltipProvider>
        <Routes>
          <Route path="/books/bills/:id" element={<BillDetailPage />} />
        </Routes>
      </TooltipProvider>,
      `/books/bills/${here.id}`,
    );
    await user.click(await screen.findByRole('button', { name: /Approve & next/ }));
    await waitFor(() => expect(approvals.decideApprovalRequest).toHaveBeenCalledWith(`a-${here.id}`, { decision: 'APPROVE' }));
    await waitFor(() => expect(api.getBill).toHaveBeenCalledWith(next.id));
  });

  it('the second person approves it from the bill', async () => {
    api.getBill.mockResolvedValue({
      bill: bill({ status: 'PENDING_APPROVAL', approvedAt: null, approvedByName: null, journalEntryId: null, approval: { id: 'a1', status: 'PENDING', requesterName: 'Fin Person', decidedByName: null, reason: null, mayDecide: true, createdAt: '2026-10-02T12:00:00.000Z' } }),
    });
    approvals.decideApprovalRequest.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage(<BillDetailPage />, '/books/bills/b1', '/books/bills/:id');
    expect(await screen.findByText('Waiting for a second person')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Approve \$300\.00/ }));
    await waitFor(() => expect(approvals.decideApprovalRequest).toHaveBeenCalledWith('a1', { decision: 'APPROVE' }));
  });
});

describe('<VendorDetailPage>', () => {
  it('a bank change waits for a second person, and says so', async () => {
    api.getVendor.mockResolvedValue({
      vendor: vendor({ pendingBankChange: { approvalId: 'a9', accountLast4: '7766', requestedAt: '2026-10-18T12:00:00.000Z', requestedByName: 'Fin Person' } }),
      bills: [bill()],
      payments: [],
    });
    renderPage(<VendorDetailPage />, `/books/vendors/${SHELL}`, '/books/vendors/:id');
    expect(await screen.findByText('New bank account waiting for approval')).toBeInTheDocument();
    expect(screen.getByText(/account ending 7766/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the request' })).toHaveAttribute('href', '/approvals?tab=requests&approval=a9');
  });
});
