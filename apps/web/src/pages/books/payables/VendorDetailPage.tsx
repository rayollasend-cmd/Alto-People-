import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Plus, ShieldAlert } from 'lucide-react';
import type { BooksBill, BooksBillPayment, BooksVendor, BooksVendorInput, BooksVendorPaymentMethod } from '@alto-people/shared';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { createVendor, getVendor, PAYABLES_KEY, updateVendor, voidBillPayment } from '@/lib/books/payablesApi';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { BillStatusBadge, METHOD_LABEL, PayBillsDialog, dueWords, errText, invalidatePayables, money, usePayablesOptions, useBooksWrite } from './payablesKit';

/**
 * One vendor: who they are and how they're paid, their bills and the
 * payments made. Their tax ID and bank details are kept encrypted and only
 * the last four digits ever show; changing the bank on file waits for a
 * second person — the classic way a vendor-payment fraud starts.
 */
export function VendorDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  if (id === 'new') return <NewVendor />;
  return <ExistingVendor id={id} />;
}

interface VendorForm {
  name: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  is1099: boolean;
  taxId: string;
  defaultExpenseAccountId: string;
  paymentMethod: BooksVendorPaymentMethod;
  routingNumber: string;
  accountNumber: string;
  termsDays: string;
  notes: string;
}

const emptyForm = (): VendorForm => ({ name: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '', state: '', zip: '', is1099: false, taxId: '', defaultExpenseAccountId: '', paymentMethod: 'ACH', routingNumber: '', accountNumber: '', termsDays: '30', notes: '' });

const fromVendor = (v: BooksVendor): VendorForm => ({
  name: v.name,
  email: v.email ?? '',
  phone: v.phone ?? '',
  addressLine1: v.addressLine1 ?? '',
  addressLine2: v.addressLine2 ?? '',
  city: v.city ?? '',
  state: v.state ?? '',
  zip: v.zip ?? '',
  is1099: v.is1099,
  taxId: '',
  defaultExpenseAccountId: v.defaultExpenseAccountId ?? '',
  paymentMethod: v.paymentMethod,
  routingNumber: '',
  accountNumber: '',
  termsDays: String(v.termsDays),
  notes: v.notes ?? '',
});

/** Only what was filled in (a blank tax ID or bank keeps what's on file). */
function toInput(f: VendorForm): BooksVendorInput {
  const n = (s: string) => s.trim() || null;
  return {
    name: f.name.trim(),
    email: n(f.email),
    phone: n(f.phone),
    addressLine1: n(f.addressLine1),
    addressLine2: n(f.addressLine2),
    city: n(f.city),
    state: f.state.trim() ? f.state.trim().toUpperCase() : null,
    zip: n(f.zip),
    is1099: f.is1099,
    ...(f.taxId.trim() ? { taxId: f.taxId.replace(/\D/g, '') } : {}),
    defaultExpenseAccountId: f.defaultExpenseAccountId || null,
    paymentMethod: f.paymentMethod,
    ...(f.routingNumber.trim() && f.accountNumber.trim() ? { routingNumber: f.routingNumber.trim(), accountNumber: f.accountNumber.trim() } : {}),
    termsDays: Math.max(0, Math.round(Number(f.termsDays) || 0)),
    notes: n(f.notes),
  };
}

function VendorFields({ value, onChange, vendor }: { value: VendorForm; onChange: (f: VendorForm) => void; vendor?: BooksVendor }) {
  const opts = usePayablesOptions();
  const set = (patch: Partial<VendorForm>) => onChange({ ...value, ...patch });
  const expense = (opts.data?.accounts ?? []).filter((a) => a.type === 'EXPENSE' || a.subtype === 'FIXED_ASSET' || a.subtype === 'CURRENT_ASSET');
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0" aria-label="Who they are">
        <Field label="Name" required className="sm:col-span-2">{(p) => <Input value={value.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} {...p} />}</Field>
        <Field label="Email">{(p) => <Input type="email" value={value.email} maxLength={200} onChange={(e) => set({ email: e.target.value })} {...p} />}</Field>
        <Field label="Phone">{(p) => <Input type="tel" value={value.phone} maxLength={40} onChange={(e) => set({ phone: e.target.value })} {...p} />}</Field>
        <Field label="Address" className="sm:col-span-2">{(p) => <Input value={value.addressLine1} maxLength={200} onChange={(e) => set({ addressLine1: e.target.value })} {...p} />}</Field>
        <Field label="Address line 2" className="sm:col-span-2">{(p) => <Input value={value.addressLine2} maxLength={200} onChange={(e) => set({ addressLine2: e.target.value })} {...p} />}</Field>
        <Field label="City">{(p) => <Input value={value.city} maxLength={100} onChange={(e) => set({ city: e.target.value })} {...p} />}</Field>
        <div className="grid grid-cols-2 gap-3 [&>*]:min-w-0">
          <Field label="State">{(p) => <Input value={value.state} maxLength={2} onChange={(e) => set({ state: e.target.value.toUpperCase() })} {...p} />}</Field>
          <Field label="ZIP">{(p) => <Input value={value.zip} maxLength={10} inputMode="numeric" onChange={(e) => set({ zip: e.target.value })} {...p} />}</Field>
        </div>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0" aria-label="How they're paid">
        <Field label="Usually paid by">
          {(p) => (
            <Select value={value.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value as BooksVendorPaymentMethod })} {...p}>
              <option value="ACH">ACH (bank transfer)</option>
              <option value="CHECK">Check</option>
              <option value="CARD">Company card</option>
              <option value="OTHER">Other</option>
            </Select>
          )}
        </Field>
        <Field label="Terms (days to pay)" hint="0 means due on receipt.">{(p) => <Input type="number" min="0" max="365" inputMode="numeric" value={value.termsDays} onChange={(e) => set({ termsDays: e.target.value })} {...p} />}</Field>
        <Field label="Usual account" hint="Pre-fills the first line of their bills." className="sm:col-span-2">
          {(p) => (
            <Select value={value.defaultExpenseAccountId} onChange={(e) => set({ defaultExpenseAccountId: e.target.value })} {...p}>
              <option value="">None</option>
              {expense.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Routing number" hint={vendor?.hasBank ? `On file: account ••• ${vendor.accountLast4}. Fill both to change it — a second person approves.` : 'Optional — needed to pay them over ACH.'}>
          {(p) => <Input value={value.routingNumber} inputMode="numeric" maxLength={9} autoComplete="off" onChange={(e) => set({ routingNumber: e.target.value.replace(/\D/g, '') })} {...p} />}
        </Field>
        <Field label="Account number">{(p) => <Input value={value.accountNumber} maxLength={17} autoComplete="off" onChange={(e) => set({ accountNumber: e.target.value })} {...p} />}</Field>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0" aria-label="Taxes">
        <label className="flex cursor-pointer items-start gap-3 text-sm sm:col-span-2">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={value.is1099} onChange={(e) => set({ is1099: e.target.checked })} />
          <span>
            <span className="block font-medium text-ink">Gets a 1099-NEC</span>
            <span className="block text-ink-muted">An unincorporated contractor you pay for services. Their year’s payments are totaled under Bills › 1099s.</span>
          </span>
        </label>
        <Field label="Tax ID (EIN or SSN)" hint={vendor?.hasTaxId ? `On file: ••• ${vendor.taxIdLast4}. Type a new one to replace it.` : 'From their W-9. Kept encrypted.'}>
          {(p) => <Input value={value.taxId} inputMode="numeric" maxLength={11} autoComplete="off" onChange={(e) => set({ taxId: e.target.value })} {...p} />}
        </Field>
      </section>
      <Field label="Notes">{(p) => <Textarea rows={2} maxLength={1000} value={value.notes} onChange={(e) => set({ notes: e.target.value })} {...p} />}</Field>
    </div>
  );
}

const formReady = (f: VendorForm) => !!f.name.trim() && (!f.routingNumber.trim() === !f.accountNumber.trim()) && (!f.taxId.trim() || f.taxId.replace(/\D/g, '').length === 9);

function NewVendor() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<VendorForm>(emptyForm);
  const save = useMutation({
    mutationFn: () => createVendor(toInput(form)),
    onSuccess: (r) => {
      toast.success(`${r.vendor.name} added.`);
      invalidatePayables(qc);
      navigate(`/books/vendors/${r.vendor.id}`, { replace: true });
    },
    onError: (err) => toast.error(errText(err, 'Could not add the vendor.')),
  });
  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Vendors', to: '/books/vendors' }, { label: 'New vendor' }]}
      title="New vendor"
      subtitle="Their tax ID and bank details are encrypted; only the last four digits are ever shown."
      actions={
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!formReady(form)}>
          Add vendor
        </Button>
      }
      tabs={[{ key: 'details', label: 'Details', content: <Card><CardContent className="p-5"><VendorFields value={form} onChange={setForm} /></CardContent></Card> }]}
    />
  );
}

function ExistingVendor({ id }: { id: string }) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const navigate = useNavigate();
  const write = useBooksWrite();
  const q = useQuery({ queryKey: [...PAYABLES_KEY, 'vendor', id], queryFn: () => getVendor(id) });
  const [tab, setTab] = useState('bills');
  const [form, setForm] = useState<VendorForm | null>(null);
  const [paying, setPaying] = useState(false);
  const save = useMutation({
    mutationFn: (input: Parameters<typeof updateVendor>[1]) => updateVendor(id, input),
    onSuccess: (r) => {
      toast.success('pending' in r ? 'Saved. The new bank account waits for a second person to approve it.' : 'Saved.');
      invalidatePayables(qc);
      setForm(null);
    },
    onError: (err) => toast.error(errText(err, 'Could not save.')),
  });
  const voidPay = useMutation({
    mutationFn: ({ pid, reason }: { pid: string; reason: string }) => voidBillPayment(pid, reason),
    onSuccess: () => {
      toast.success('Payment voided — those bills are owed again.');
      invalidatePayables(qc);
    },
    onError: (err) => toast.error(errText(err, 'Could not void it.')),
  });
  if (q.isPending) return <Skeleton className="h-96 w-full" />;
  if (q.error || !q.data) return <QueryError what="the vendor" query={q} />;
  const { vendor, bills, payments } = q.data;
  const open = bills.filter((b) => (b.status === 'APPROVED' || b.status === 'PARTIALLY_PAID') && b.balance > 0);

  const billCols: GridColumn<BooksBill>[] = [
    { key: 'number', header: 'Invoice', accessor: (b) => b.billNumber ?? fmtDate(b.billDate), sortable: true, primary: true, cell: (b) => <span className="font-medium text-ink">{b.billNumber ?? `Bill of ${fmtDate(b.billDate)}`}</span> },
    { key: 'due', header: 'Due', accessor: (b) => b.dueDate, sortable: true, cell: (b) => dueWords(b) },
    { key: 'status', header: 'Status', accessor: (b) => b.status, sortable: true, cardMeta: true, cell: (b) => <BillStatusBadge bill={b} size="sm" /> },
    { key: 'total', header: 'Total', accessor: (b) => b.total, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (b) => money(b.total) },
    { key: 'owed', header: 'Owed', accessor: (b) => b.balance, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (b) => (b.status === 'VOID' || b.status === 'PAID' ? '—' : money(b.balance)) },
  ];
  const payCols: GridColumn<BooksBillPayment>[] = [
    { key: 'paidOn', header: 'Paid', accessor: (p) => p.paidOn, sortable: true, primary: true, cell: (p) => <span className="font-medium text-ink">{fmtDate(p.paidOn)}</span> },
    { key: 'amount', header: 'Amount', accessor: (p) => p.amount, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (p) => money(p.amount) },
    { key: 'method', header: 'How', accessor: (p) => METHOD_LABEL[p.method], cell: (p) => `${METHOD_LABEL[p.method]}${p.checkNumber ? ` #${p.checkNumber}` : ''}${p.achFileId ? ' · sent over ACH' : ''}` },
    { key: 'from', header: 'From', accessor: (p) => p.bankAccountName },
    { key: 'bills', header: 'Bills', accessor: (p) => p.applications.map((a) => a.billNumber ?? '').join(', '), defaultHidden: true },
    { key: 'status', header: 'Status', accessor: (p) => p.status, cell: (p) => (p.status === 'VOID' ? <Badge size="sm" variant="destructive">Void</Badge> : p.status === 'SCHEDULED' ? <Badge size="sm" variant="info">Scheduled</Badge> : <Badge size="sm" variant="success">Paid</Badge>) },
    {
      key: 'actions',
      header: '',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      align: 'right',
      stopRowClick: true,
      cell: (p) =>
        write && p.status !== 'VOID' ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              const reason = await prompt({ title: `Void the ${money(p.amount)} payment?`, description: 'Its bills are owed again. A payment already sent to the bank over ACH can’t be voided here.', reasonLabel: 'Why', confirmLabel: 'Void payment', destructive: true });
              if (reason) voidPay.mutate({ pid: p.id, reason });
            }}
          >
            Void
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <RecordTemplate
        breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Vendors', to: '/books/vendors' }, { label: vendor.name }]}
        title={vendor.name}
        subtitle={[vendor.termsDays ? `Net ${vendor.termsDays}` : 'Due on receipt', `paid by ${METHOD_LABEL[vendor.paymentMethod].toLowerCase()}${vendor.hasBank ? ` to ••• ${vendor.accountLast4}` : ''}`, vendor.is1099 ? '1099 vendor' : null].filter(Boolean).join(' · ')}
        status={vendor.isActive ? <Badge variant="success">Active</Badge> : <Badge>Inactive</Badge>}
        actions={
          write ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => navigate(`/books/bills/new?vendorId=${vendor.id}`)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                New bill
              </Button>
              {open.length > 0 && <Button onClick={() => setPaying(true)}>Pay {money(vendor.balance)}</Button>}
            </div>
          ) : undefined
        }
        summary={
          vendor.pendingBankChange ? (
            <Card className="border-warning/40">
              <CardContent className="flex items-start gap-3 p-4 text-sm">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
                <div>
                  <p className="font-medium text-ink">New bank account waiting for approval</p>
                  <p className="text-ink-muted">
                    {vendor.pendingBankChange.requestedByName ?? 'Someone'} asked {fmtDateTime(vendor.pendingBankChange.requestedAt)} to pay {vendor.name} at the account ending {vendor.pendingBankChange.accountLast4}. Until a second person approves it, payments still go to ••• {vendor.accountLast4 ?? '—'}. Call the vendor on a number you already had before approving.{' '}
                    <Link to={`/approvals?tab=requests&approval=${vendor.pendingBankChange.approvalId}`} className="text-gold hover:underline">
                      Open the request
                    </Link>
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <p className="flex items-center gap-2 text-sm text-ink-muted">
              <Landmark className="h-4 w-4" aria-hidden="true" />
              {vendor.balance ? `${money(vendor.balance)} owed on ${open.length} ${open.length === 1 ? 'bill' : 'bills'}.` : 'Nothing owed right now.'}
            </p>
          )
        }
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          {
            key: 'bills',
            label: 'Bills',
            count: bills.length,
            content: (
              <DataGrid
                id="books-vendor-bills"
                caption={`Bills from ${vendor.name}`}
                noun={{ one: 'bill', many: 'bills' }}
                rows={bills}
                columns={billCols}
                rowKey={(b) => b.id}
                defaultSort={{ key: 'due', direction: 'desc' }}
                rowHref={(b) => `/books/bills/${b.id}`}
                rowActionLabel={(b) => `Open bill ${b.billNumber ?? fmtDate(b.billDate)}`}
                empty={{ title: 'No bills from this vendor', description: write ? 'Enter their next invoice with New bill.' : undefined }}
              />
            ),
          },
          {
            key: 'payments',
            label: 'Payments',
            count: payments.filter((p) => p.status !== 'VOID').length,
            content: (
              <DataGrid
                id="books-vendor-payments"
                caption={`Payments to ${vendor.name}`}
                noun={{ one: 'payment', many: 'payments' }}
                rows={payments}
                columns={payCols}
                rowKey={(p) => p.id}
                defaultSort={{ key: 'paidOn', direction: 'desc' }}
                empty={{ title: 'No payments yet' }}
              />
            ),
          },
          {
            key: 'details',
            label: 'Details',
            content: (
              <Card>
                <CardContent className="space-y-5 p-5">
                  {form ? (
                    <>
                      <VendorFields value={form} onChange={setForm} vendor={vendor} />
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={() => setForm(null)}>
                          Cancel
                        </Button>
                        <Button onClick={() => save.mutate(toInput(form))} loading={save.isPending} disabled={!formReady(form)}>
                          Save
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                        {[
                          ['Email', vendor.email],
                          ['Phone', vendor.phone],
                          ['Address', [vendor.addressLine1, vendor.addressLine2, [vendor.city, vendor.state].filter(Boolean).join(', '), vendor.zip].filter(Boolean).join(' · ')],
                          ['Usual account', vendor.defaultExpenseAccountName],
                          ['Bank on file', vendor.hasBank ? `••• ${vendor.accountLast4}` : null],
                          ['Tax ID', vendor.hasTaxId ? `••• ${vendor.taxIdLast4}` : null],
                          ['Notes', vendor.notes],
                        ].map(([k, v]) => (
                          <div key={k as string}>
                            <dt className="text-xs uppercase tracking-wide text-ink-muted">{k}</dt>
                            <dd className="text-ink">{v || '—'}</dd>
                          </div>
                        ))}
                      </dl>
                      {write && (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button variant="ghost" onClick={() => save.mutate({ isActive: !vendor.isActive })} disabled={save.isPending}>
                            {vendor.isActive ? 'Make inactive' : 'Make active'}
                          </Button>
                          <Button variant="secondary" onClick={() => setForm(fromVendor(vendor))}>
                            Edit
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            ),
          },
        ]}
      />
      {paying && (
        <PayBillsDialog open onOpenChange={setPaying} vendor={{ id: vendor.id, name: vendor.name, hasBank: vendor.hasBank, paymentMethod: vendor.paymentMethod }} bills={open} />
      )}
    </>
  );
}
