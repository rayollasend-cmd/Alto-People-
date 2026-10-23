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
vi.mock('@/lib/geoApi', () => ({ suggestAddresses: vi.fn() }));

import { suggestAddresses } from '@/lib/geoApi';
import { BillsPage, billsSummary, legacyBillsParams } from '@/pages/books/payables/BillsPage';
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
  paidThisYear: 0,
  lastPaidOn: null,
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

describe('<BillsPage> — one meaning per number (F500)', () => {
  const open = [
    bill({ id: '00000000-0000-4000-8000-00000000c001', billNumber: 'SVR-311', total: 3310, balance: 2310, daysPastDue: 25, dueDate: '2026-09-24' }),
    bill({ id: '00000000-0000-4000-8000-00000000c002', billNumber: 'SF-10422', total: 1840.55, balance: 1840.55, daysPastDue: 6, dueDate: '2026-10-13' }),
    bill({ id: '00000000-0000-4000-8000-00000000c003', billNumber: 'RENT-NOV', total: 8500, balance: 8500, daysPastDue: -3, dueDate: '2026-10-22' }),
    bill({ id: '00000000-0000-4000-8000-00000000c004', billNumber: 'HM-10', total: 6250, balance: 6250, daysPastDue: -13, dueDate: '2026-11-01' }),
  ];
  beforeEach(() => {
    api.listBills.mockImplementation(async ({ tab }: { tab?: string }) => ({
      bills: tab === 'approve' ? [] : tab === 'late' ? open.slice(0, 2) : tab === 'due' ? [open[2]!] : open,
    }));
  });

  it('“Due in the next 7 days” leaves out the late bills — they are counted once, under Late', async () => {
    renderPage(<BillsPage />, '/books/bills', '/books/bills');
    const strip = await screen.findByRole('group', { name: 'Bills at a glance' });
    const tile = (label: string) => within(strip).getByText(label).closest('a')!;
    await waitFor(() => expect(tile('Late')).toHaveTextContent('$4,150.55'));
    expect(tile('Due in the next 7 days')).toHaveTextContent('$8,500.00');
    expect(tile('Due in the next 7 days')).toHaveTextContent('1 bill, none of them late');
    expect(tile('Owed')).toHaveTextContent('$18,900.55');
    // Each number opens the list behind it.
    expect(tile('Late')).toHaveAttribute('href', '/books/bills?status=late');
    expect(tile('Due in the next 7 days')).toHaveAttribute('href', '/books/bills?status=due');
  });

  it('billsSummary: late and due-in-7 never share a bill', () => {
    const s = billsSummary(open);
    expect(s.lateTotal).toBe(4150.55);
    expect(s.dueSoonTotal).toBe(8500);
    expect(s.owed).toBe(18900.55);
    expect(s.late.filter((b) => s.dueSoon.includes(b))).toEqual([]);
  });

  it('status is a filter on one list; the unpaid lists drop the Status column (lateness is in Due)', async () => {
    const user = userEvent.setup();
    renderPage(<BillsPage />, '/books/bills', '/books/bills');
    const table = await screen.findByRole('table', { name: /Bills/ });
    expect(within(table).queryByRole('columnheader', { name: /Status/ })).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^Late/ }));
    await waitFor(() => expect(api.listBills).toHaveBeenCalledWith({ tab: 'late' }));
    expect(await screen.findByText('SVR-311')).toBeInTheDocument();
    expect(screen.queryByText('RENT-NOV')).toBeNull();
    await user.click(screen.getByRole('radio', { name: /^All$/ }));
    expect(await screen.findByRole('columnheader', { name: /Status/ })).toBeInTheDocument();
  });

  it('old links land: ?tab=due is the due filter, ?tab=aging the Aging view, ?status=PENDING_APPROVAL the approval queue', () => {
    expect(legacyBillsParams(new URLSearchParams('tab=due'))).toEqual({ status: 'due' });
    expect(legacyBillsParams(new URLSearchParams('tab=aging'))).toEqual({ view: 'aging' });
    expect(legacyBillsParams(new URLSearchParams('status=PENDING_APPROVAL'))).toEqual({ status: 'approve' });
    expect(legacyBillsParams(new URLSearchParams('status=late'))).toBeNull();
  });

  it('opens an old ?tab=aging link on the Aging view', async () => {
    api.apAging.mockResolvedValue({ asOf: '2026-10-19', totals: { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0, bills: 0 }, rows: [] });
    renderPage(<BillsPage />, '/books/bills?tab=aging', '/books/bills');
    expect(await screen.findByText('Nothing owed')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Aging' })).toHaveAttribute('aria-selected', 'true');
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
  it('a new vendor’s address fills from a picked suggestion', async () => {
    api.payablesOptions.mockResolvedValue(OPTIONS);
    vi.mocked(suggestAddresses).mockResolvedValue({
      available: true,
      provider: 'mapbox',
      outage: false,
      results: [
        { label: '200 Harbor Boulevard Suite 4', address: '200 Harbor Boulevard Suite 4, Destin, Florida 32541', line1: '200 Harbor Boulevard', line2: 'Suite 4', city: 'Destin', state: 'FL', zip: '32541', county: 'Okaloosa County', lat: 30.39, lng: -86.5, precision: 'exact' },
      ],
    });
    const user = userEvent.setup();
    renderPage(<VendorDetailPage />, '/books/vendors/new', '/books/vendors/:id');
    await user.type(await screen.findByLabelText('Address'), '200 Harbor Suite 4');
    await user.click(await screen.findByRole('option', { name: /200 Harbor Boulevard/ }));
    expect(screen.getByLabelText('Address')).toHaveValue('200 Harbor Boulevard');
    expect(screen.getByLabelText('Address line 2')).toHaveValue('Suite 4');
    expect(screen.getByLabelText('City')).toHaveValue('Destin');
    expect(screen.getByLabelText('State')).toHaveValue('FL');
    expect(screen.getByLabelText('ZIP')).toHaveValue('32541');
  });

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

describe('<VendorDetailPage> — the numbers first (F500)', () => {
  it('owed now, paid this year, last payment and open bills; “paid by ACH” keeps its capitals', async () => {
    api.getVendor.mockResolvedValue({
      vendor: vendor({ balance: 300, paidThisYear: 1600, lastPaidOn: '2026-10-12' }),
      bills: [bill()],
      payments: [
        { id: 'p1', vendorId: SHELL, vendorName: 'Shell Fleet', paidOn: '2026-10-12', method: 'CHECK', amount: 600, bankAccountId: CASH, bankAccountName: '1000 Operating checking', reference: null, checkNumber: 1042, achFileId: null, status: 'SENT', applications: [], createdAt: '2026-10-12T12:00:00.000Z' },
        { id: 'p2', vendorId: SHELL, vendorName: 'Shell Fleet', paidOn: '2026-10-15', method: 'CHECK', amount: 250, bankAccountId: CASH, bankAccountName: '1000 Operating checking', reference: null, checkNumber: 1043, achFileId: null, status: 'VOID', applications: [], createdAt: '2026-10-15T12:00:00.000Z' },
      ],
    });
    renderPage(<VendorDetailPage />, `/books/vendors/${SHELL}`, '/books/vendors/:id');
    const strip = await screen.findByRole('group', { name: 'Shell Fleet at a glance' });
    await waitFor(() => expect(within(strip).getByText('Paid this year').parentElement).toHaveTextContent('$1,600.00'));
    expect(within(strip).getByText('Owed now').parentElement).toHaveTextContent('$300.00');
    // The voided Oct 15 check isn't the last payment.
    expect(within(strip).getByText('Last payment').parentElement).toHaveTextContent('$600.00');
    expect(within(strip).getByText('Last payment').parentElement).toHaveTextContent('Oct 12, 2026');
    await waitFor(() => expect(within(strip).getByText('Open bills').parentElement).toHaveTextContent('Open bills1'));
    expect(screen.getByText(/paid by ACH to ••• 6789/)).toBeInTheDocument();
  });
});

describe('<BillDetailPage> — one bill at a glance (F500)', () => {
  it('names the vendor, due date and terms as facts; Void and Reopen sit in More; the invoice is beside the lines', async () => {
    api.getBill.mockResolvedValue({ bill: bill({ hasAttachment: false }) });
    const user = userEvent.setup();
    renderPage(<BillDetailPage />, '/books/bills/b1', '/books/bills/:id');
    expect(await screen.findByRole('link', { name: /Shell Fleet/ })).toHaveAttribute('href', `/books/vendors/${SHELL}`);
    await waitFor(() => expect(screen.getByText('Net 15')).toBeInTheDocument());
    // "3 days late" is said once — in the status badge, not again in the subtitle.
    expect(screen.getAllByText('3 days late')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Void bill' })).toBeNull();
    expect(screen.getByRole('region', { name: 'The vendor’s invoice' })).toHaveTextContent('No invoice attached');
    expect(screen.queryByRole('tab', { name: 'Invoice' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /More/ }));
    expect(await screen.findByRole('menuitem', { name: 'Void bill' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reopen to change' })).toBeInTheDocument();
  });
});

