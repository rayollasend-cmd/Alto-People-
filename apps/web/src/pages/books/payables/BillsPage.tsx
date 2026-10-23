import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Check, Download, Plus, Repeat } from 'lucide-react';
import type { BooksBill, BooksRecurringBill, BooksRecurringFrequency } from '@alto-people/shared';
import { fmtDate, ymdLocal } from '@/lib/format';
import { apAging, approveBills, createRecurringBill, listBills, listRecurringBills, listVendors, PAYABLES_KEY, updateRecurringBill, vendor1099, vendor1099CsvUrl, type BillsTab } from '@/lib/books/payablesApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';
import { SavedViewsMenu } from '@/components/SavedViewsMenu';
import { useUrlParam, useUrlWriter } from '@/lib/useUrlState';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toaster';
import { BillStatusBadge, LinesEditor, PayBillsDialog, blankLine, dueWords, errText, invalidatePayables, linesTotal, money, toLineInputs, useBooksWrite, type DraftLine } from './payablesKit';
import { BillRunDialog } from './BillRunDialog';

/**
 * Bills: what the company owes. Bills waiting for a second person's
 * approval, approved bills by when they're due, paid ones — and, behind
 * them, the bills that repeat, AP aging and the year's vendor 1099s.
 */

/**
 * Two things used to share one row of nine tabs: the bills by status (a
 * filter on one list) and three other views. Now the views are tabs
 * (?view=) and the status is a segmented filter on the bills (?status=),
 * which a saved view can keep. Old links still land: ?tab=approve|unpaid|
 * due|paid|draft|all is a status, ?tab=recurring|aging|1099 a view, and
 * ?status=PENDING_APPROVAL the approval queue.
 */
type View = 'bills' | 'recurring' | 'aging' | '1099';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'bills', label: 'Bills' },
  { key: 'recurring', label: 'Recurring' },
  { key: 'aging', label: 'Aging' },
  { key: '1099', label: '1099s' },
];
const VIEW_KEYS = VIEWS.map((v) => v.key);
const STATUSES: Array<{ key: BillsTab; label: string }> = [
  { key: 'approve', label: 'To approve' },
  { key: 'late', label: 'Late' },
  { key: 'due', label: 'Due in 7 days' },
  { key: 'unpaid', label: 'All unpaid' },
  { key: 'paid', label: 'Paid' },
  { key: 'draft', label: 'Drafts' },
  { key: 'all', label: 'All' },
];
const STATUS_KEYS = STATUSES.map((t) => t.key);

/** Where an old ?tab= / ?status= link meant to go, or null when the URL is already new. */
export function legacyBillsParams(params: URLSearchParams): { view?: View; status?: BillsTab } | null {
  const tab = params.get('tab');
  const status = params.get('status');
  if (status === 'PENDING_APPROVAL') return { status: 'approve' };
  if (!tab) return null;
  if ((VIEW_KEYS as string[]).includes(tab)) return { view: tab as View };
  if ((STATUS_KEYS as string[]).includes(tab)) return { status: tab as BillsTab };
  return {};
}

export function BillsPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const writeUrl = useUrlWriter();
  // An old link (?tab=…, ?status=PENDING_APPROVAL) is rewritten once to the new params.
  const legacy = legacyBillsParams(params);
  const legacyKey = legacy ? JSON.stringify(legacy) : '';
  useEffect(() => {
    if (!legacyKey) return;
    const to = JSON.parse(legacyKey) as { view?: View; status?: BillsTab };
    writeUrl((p) => {
      p.delete('tab');
      if (p.get('status') === 'PENDING_APPROVAL') p.delete('status');
      if (to.view && to.view !== 'bills') p.set('view', to.view);
      if (to.status && to.status !== 'unpaid') p.set('status', to.status);
    });
  }, [legacyKey, writeUrl]);
  const [urlView, setView] = useUrlParam<View>('view', 'bills', VIEW_KEYS, { history: 'push' });
  const [urlStatus, setStatus] = useUrlParam<BillsTab>('status', 'unpaid', STATUS_KEYS);
  const view = legacy?.view ?? urlView;
  const status = legacy?.status ?? urlStatus;
  const write = useBooksWrite();
  const bills = useQuery({ queryKey: [...PAYABLES_KEY, 'bills', status], queryFn: () => listBills({ tab: status }), enabled: view === 'bills' });
  const open = useQuery({ queryKey: [...PAYABLES_KEY, 'bills', 'unpaid'], queryFn: () => listBills({ tab: 'unpaid' }) });
  const pending = useQuery({ queryKey: [...PAYABLES_KEY, 'bills', 'approve'], queryFn: () => listBills({ tab: 'approve' }) });
  const s = billsSummary(open.data?.bills ?? []);
  const waiting = pending.data?.bills.length ?? 0;
  const [billRun, setBillRun] = useState(false);
  // A saved view keeps the status and the grid's search and sort — the list's own URL params.
  const viewQuery = useMemo(() => {
    const q: Record<string, string> = {};
    for (const k of ['status', 'q', 'sort', 'dir']) {
      const v = params.get(k);
      if (v) q[k] = v;
    }
    return q;
  }, [params]);
  const applySavedView = (id: string | null, q: Record<string, string>) =>
    writeUrl((p) => {
      for (const k of ['status', 'q', 'sort', 'dir', 'sv']) p.delete(k);
      for (const [k, v] of Object.entries(q)) if (['status', 'q', 'sort', 'dir'].includes(k) && v) p.set(k, v);
      if (id) p.set('sv', id);
    });
  const counts: Partial<Record<BillsTab, number>> = open.data ? { late: s.late.length, due: s.dueSoon.length, unpaid: s.open.length } : {};
  if (pending.data) counts.approve = waiting;

  return (
    <ListTemplate
      title="Bills"
      subtitle="What the company owes its vendors — each one approved by a second person before it’s on the books, then paid by ACH, check or card."
      actions={[
        { label: 'New bill', icon: Plus, to: '/books/bills/new', primary: true, hidden: !write },
        { label: 'Pay bills due…', icon: Banknote, onSelect: () => setBillRun(true), hidden: !write },
      ]}
      related={[{ label: 'Vendors', to: '/books/vendors' }]}
      summary={
        <MetricStrip label="Bills at a glance" empty={open.isSuccess && pending.isSuccess && s.open.length === 0 && waiting === 0}>
          <MetricCard label="Owed" value={money(s.owed)} hint={`${s.open.length} approved ${s.open.length === 1 ? 'bill' : 'bills'} not yet paid`} href="/books/bills?status=unpaid" nothing={s.open.length === 0 ? 'Nothing owed' : undefined} />
          <MetricCard label="Due in the next 7 days" value={money(s.dueSoonTotal)} hint={`${s.dueSoon.length} ${s.dueSoon.length === 1 ? 'bill' : 'bills'}, none of them late`} href="/books/bills?status=due" nothing={s.dueSoon.length === 0 ? 'Nothing due this week' : undefined} />
          <MetricCard label="Late" value={money(s.lateTotal)} tone={s.late.length > 0 ? 'alert' : 'default'} hint={`${s.late.length} past ${s.late.length === 1 ? 'its' : 'their'} due date`} href="/books/bills?status=late" nothing={s.late.length === 0 ? 'Nothing late' : undefined} />
          <MetricCard label="Waiting for approval" value={waiting} tone={waiting > 0 ? 'warning' : 'default'} hint="Owed only once someone approves" href="/books/bills?status=approve" nothing={waiting === 0 ? 'Nothing waiting' : undefined} />
        </MetricStrip>
      }
    >
      <Tabs value={view} onValueChange={(v) => setView(v as View)}>
        <TabsList>
          {VIEWS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mt-4 space-y-3">
        {view === 'bills' && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl
                ariaLabel="Which bills"
                value={status}
                onChange={(v) => setStatus(v)}
                options={STATUSES.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
              />
              <SavedViewsMenu scope="books.bills" current={viewQuery} activeId={params.get('sv')} onApply={applySavedView} allLabel="Saved views" />
            </div>
            <BillsGrid tab={status} bills={bills.data?.bills} loading={bills.isPending} error={bills.error} onRetry={() => void bills.refetch()} onOpen={(b) => navigate(`/books/bills/${b.id}`)} />
          </>
        )}
        {view === 'recurring' && <RecurringSection />}
        {view === 'aging' && <AgingSection />}
        {view === '1099' && <Vendor1099Section />}
      </div>
      {billRun && <BillRunDialog open onOpenChange={setBillRun} />}
    </ListTemplate>
  );
}

/**
 * The strip's numbers from the approved, unpaid bills. Late and due never
 * overlap: a bill past its due date is late; "due in the next 7 days" is
 * today through a week out (daysPastDue -7…0), the server's 'due' list.
 */
export function billsSummary(open: BooksBill[]) {
  const late = open.filter((b) => b.daysPastDue > 0);
  const dueSoon = open.filter((b) => b.daysPastDue > -8 && b.daysPastDue <= 0);
  const sum = (xs: BooksBill[]) => Math.round(xs.reduce((t, b) => t + b.balance * 100, 0)) / 100;
  return { open, owed: sum(open), late, lateTotal: sum(late), dueSoon, dueSoonTotal: sum(dueSoon) };
}

const OPEN_TABS: BillsTab[] = ['unpaid', 'late', 'due'];

const EMPTY: Record<BillsTab, { title: string; description: string }> = {
  approve: { title: 'No bills are waiting for approval', description: 'A bill someone enters and sends for approval lands here for a second person.' },
  late: { title: 'Nothing is late', description: 'Every approved bill is paid or not yet due.' },
  due: { title: 'Nothing is due in the next 7 days', description: 'Approved bills due today or in the coming week show here. Late ones are under Late.' },
  unpaid: { title: 'Nothing is owed', description: 'Approved bills not yet paid show here, oldest due first.' },
  paid: { title: 'No paid bills yet', description: 'Bills paid by ACH, check or card show here.' },
  draft: { title: 'No drafts', description: 'A bill saved without sending it for approval waits here.' },
  all: { title: 'No bills yet', description: 'Enter a vendor’s bill — it goes to a second person to approve, then it’s on the books.' },
};

function BillsGrid({ tab, bills, loading, error, onRetry, onOpen }: { tab: BillsTab; bills: BooksBill[] | undefined; loading: boolean; error: unknown; onRetry: () => void; onOpen: (b: BooksBill) => void }) {
  const write = useBooksWrite();
  const [paying, setPaying] = useState<BooksBill[] | null>(null);
  // Bills of several vendors picked on the grid: one bill run for all of them (finance walk 8).
  const [running, setRunning] = useState<BooksBill[] | null>(null);
  const vendors = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'all'], queryFn: () => listVendors({ active: 'all' }), enabled: !!paying });
  const payVendor = paying ? vendors.data?.vendors.find((v) => v.id === paying[0]?.vendorId) : undefined;
  const columns: GridColumn<BooksBill>[] = [
    { key: 'vendor', header: 'Vendor', accessor: (b) => b.vendorName, sortable: true, primary: true, cell: (b) => <span className="font-medium text-ink">{b.vendorName}</span> },
    { key: 'number', header: 'Invoice', accessor: (b) => b.billNumber ?? '', sortable: true, cardMeta: true },
    { key: 'billDate', header: 'Dated', accessor: (b) => b.billDate, sortable: true, cell: (b) => fmtDate(b.billDate), className: 'whitespace-nowrap' },
    { key: 'due', header: 'Due', accessor: (b) => b.dueDate, sortable: true, cell: (b) => <span className={b.daysPastDue > 0 && b.balance > 0 && b.status !== 'VOID' ? 'text-alert' : undefined}>{dueWords(b)}</span>, className: 'whitespace-nowrap' },
    // On the unpaid lists every bill is approved and its lateness is in Due — a
    // second "25 days late" in a Status column said the same thing twice.
    ...(OPEN_TABS.includes(tab) ? [] : [{ key: 'status', header: 'Status', accessor: (b: BooksBill) => b.status, sortable: true, cardMeta: true, cell: (b: BooksBill) => <BillStatusBadge bill={b} size="sm" /> }]),
    { key: 'total', header: 'Total', accessor: (b) => b.total, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (b) => money(b.total) },
    { key: 'balance', header: 'Owed', accessor: (b) => b.balance, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (b) => (b.status === 'PAID' || b.status === 'VOID' ? '—' : money(b.balance)) },
    {
      key: 'who',
      header: tab === 'approve' ? 'Decides' : 'Approved by',
      accessor: (b) => (tab === 'approve' ? (b.approval?.mayDecide ? 'You' : 'A second person') : (b.approvedByName ?? '')),
      defaultHidden: tab !== 'approve',
    },
  ];
  const payable = (b: BooksBill) => (b.status === 'APPROVED' || b.status === 'PARTIALLY_PAID') && b.balance > 0;
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: (ids: string[]) => approveBills(ids),
    onSuccess: (r) => {
      const total = r.approved.reduce((s, a) => s + a.total, 0);
      if (r.approved.length) toast.success(`${r.approved.length === 1 ? 'Approved' : `${r.approved.length} approved`} — ${money(total)} is on the books.${r.skipped.length ? ` ${r.skipped.length} not: ${r.skipped[0]!.reason}` : ''}`);
      else toast.error(r.skipped[0]?.reason ?? 'None approved.');
      invalidatePayables(qc);
    },
    onError: (err) => toast.error(errText(err, 'Could not approve them.')),
  });
  // Bills this person entered can't be theirs to approve — say so once instead of a dead checkbox.
  const ownWaiting = tab === 'approve' ? (bills ?? []).filter((b) => b.approval && !b.approval.mayDecide).length : 0;
  return (
    <>
      {write && ownWaiting > 0 && (
        <p className="mb-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink-muted">
          {ownWaiting === 1 ? 'One bill here isn’t yours to approve' : `${ownWaiting} bills here aren’t yours to approve`} — the person who entered a bill never approves it. A second person with the books does.
        </p>
      )}
      <DataGrid
        id={`books-bills-${tab}`}
        caption="Bills"
        noun={{ one: 'bill', many: 'bills' }}
        rows={bills}
        loading={loading}
        error={error ? errText(error, 'Could not load the bills.') : null}
        onRetry={onRetry}
        columns={columns}
        rowKey={(b) => b.id}
        defaultSort={{ key: 'due', direction: 'asc' }}
        onRowClick={onOpen}
        rowActionLabel={(b) => `Open the ${money(b.total)} bill from ${b.vendorName}`}
        empty={{ ...EMPTY[tab], action: write ? <Button asChild size="sm"><Link to="/books/bills/new"><Plus className="h-4 w-4" aria-hidden="true" />New bill</Link></Button> : undefined }}
        selectable={
          write && tab === 'approve'
            ? {
                disabled: (b) => !b.approval?.mayDecide,
                selectAllLabel: 'Select every bill you can approve',
                actions: (selected, clear) => {
                  const chosen = (bills ?? []).filter((b) => selected.includes(b.id));
                  return (
                    <Button
                      size="sm"
                      loading={approve.isPending}
                      disabled={chosen.length === 0}
                      onClick={() => approve.mutate(chosen.map((b) => b.id), { onSuccess: () => clear() })}
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      Approve {chosen.length === 1 ? 'this bill' : `${chosen.length} bills`} · {money(chosen.reduce((s, b) => s + b.total, 0))}
                    </Button>
                  );
                },
              }
            : write && (OPEN_TABS.includes(tab) || tab === 'all')
            ? {
                disabled: (b) => !payable(b),
                selectAllLabel: 'Select every unpaid bill',
                actions: (selected, clear) => {
                  const chosen = (bills ?? []).filter((b) => selected.includes(b.id));
                  const vendorCount = new Set(chosen.map((b) => b.vendorId)).size;
                  return (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={chosen.length === 0}
                        onClick={() => {
                          if (vendorCount > 1) setRunning(chosen);
                          else setPaying(chosen);
                          clear();
                        }}
                      >
                        Pay {chosen.length === 1 ? 'this bill' : `${chosen.length} bills`}
                        {vendorCount > 1 ? ` to ${vendorCount} vendors` : ''} · {money(chosen.reduce((s, b) => s + b.balance, 0))}
                      </Button>
                    </div>
                  );
                },
              }
            : undefined
        }
      />
      {running && <BillRunDialog open onOpenChange={(o) => !o && setRunning(null)} preselected={running} />}
      {paying && payVendor && (
        <PayBillsDialog
          open
          onOpenChange={(o) => !o && setPaying(null)}
          vendor={{ id: payVendor.id, name: payVendor.name, hasBank: payVendor.hasBank, paymentMethod: payVendor.paymentMethod }}
          bills={paying}
        />
      )}
    </>
  );
}

/* ---- Recurring ------------------------------------------------------------ */

const FREQ_LABEL: Record<BooksRecurringFrequency, string> = { WEEKLY: 'Every week', MONTHLY: 'Every month', QUARTERLY: 'Every quarter', YEARLY: 'Every year' };

function RecurringSection() {
  const qc = useQueryClient();
  const write = useBooksWrite();
  const list = useQuery({ queryKey: [...PAYABLES_KEY, 'recurring'], queryFn: listRecurringBills });
  const [creating, setCreating] = useState(false);
  const toggle = useMutation({
    mutationFn: (r: BooksRecurringBill) => updateRecurringBill(r.id, { isActive: !r.isActive }),
    onSuccess: (r) => {
      toast.success(r.recurring.isActive ? `${r.recurring.name} resumed.` : `${r.recurring.name} paused — no new bills until it’s resumed.`);
      invalidatePayables(qc);
    },
    onError: (err) => toast.error(errText(err, 'Could not change it.')),
  });
  const columns: GridColumn<BooksRecurringBill>[] = [
    { key: 'name', header: 'Bill', accessor: (r) => r.name, sortable: true, primary: true, cell: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'vendor', header: 'Vendor', accessor: (r) => r.vendorName, sortable: true, cardMeta: true },
    { key: 'freq', header: 'How often', accessor: (r) => FREQ_LABEL[r.frequency] },
    { key: 'next', header: 'Next bill', accessor: (r) => r.nextDate, sortable: true, cell: (r) => (r.isActive ? fmtDate(r.nextDate) : <Badge size="sm">Paused</Badge>) },
    { key: 'amount', header: 'Amount', accessor: (r) => r.amount, align: 'right', searchable: false, className: 'tabular-nums', cell: (r) => money(r.amount) },
    { key: 'approval', header: 'On its date', accessor: (r) => (r.autoSubmit ? 'Goes to approval' : 'Waits as a draft') },
    { key: 'made', header: 'Bills made', accessor: (r) => r.billsMade, align: 'right', searchable: false, className: 'tabular-nums', defaultHidden: true },
    {
      key: 'actions',
      header: '',
      accessor: () => null,
      searchable: false,
      csv: () => '',
      align: 'right',
      stopRowClick: true,
      cell: (r) =>
        write ? (
          <Button size="xs" variant="ghost" onClick={() => toggle.mutate(r)} disabled={toggle.isPending}>
            {r.isActive ? 'Pause' : 'Resume'}
          </Button>
        ) : null,
    },
  ];
  return (
    <div className="space-y-3">
      {write && (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Repeat className="h-4 w-4" aria-hidden="true" />
            New recurring bill
          </Button>
        </div>
      )}
      <DataGrid
        id="books-recurring-bills"
        caption="Recurring bills"
        noun={{ one: 'recurring bill', many: 'recurring bills' }}
        rows={list.data?.recurring}
        loading={list.isPending}
        error={list.error ? errText(list.error, 'Could not load them.') : null}
        onRetry={() => void list.refetch()}
        columns={columns}
        rowKey={(r) => r.id}
        empty={{ title: 'No recurring bills', description: 'Rent, a lease, software that bills the same each month — set it up once and each bill is made on its date.' }}
      />
      <RecurringDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function RecurringDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const vendors = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'active'], queryFn: () => listVendors(), enabled: open });
  const [vendorId, setVendorId] = useState('');
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<BooksRecurringFrequency>('MONTHLY');
  const [nextDate, setNextDate] = useState(ymdLocal());
  const [endDate, setEndDate] = useState('');
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const vendor = vendors.data?.vendors.find((v) => v.id === vendorId);
  const save = useMutation({
    mutationFn: () => createRecurringBill({ vendorId, name: name.trim(), frequency, nextDate, endDate: endDate || null, autoSubmit, lines: toLineInputs(lines) }),
    onSuccess: (r) => {
      toast.success(`${r.recurring.name}: the first bill is made ${fmtDate(r.recurring.nextDate)}.`);
      invalidatePayables(qc);
      onOpenChange(false);
      setLines([blankLine()]);
      setName('');
    },
    onError: (err) => toast.error(errText(err, 'Could not save it.')),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New recurring bill</DialogTitle>
          <DialogDescription>Made on each date by itself. It still needs a second person’s approval before it’s owed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Vendor">
            {(p) => (
              <Select
                value={vendorId}
                onChange={(e) => {
                  setVendorId(e.target.value);
                  const v = vendors.data?.vendors.find((x) => x.id === e.target.value);
                  if (v?.defaultExpenseAccountId) setLines((ls) => ls.map((l, i) => (i === 0 && !l.accountId ? { ...l, accountId: v.defaultExpenseAccountId! } : l)));
                  if (v && !name) setName(v.name);
                }}
                {...p}
              >
                <option value="">Choose a vendor…</option>
                {(vendors.data?.vendors ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">{(p) => <Input value={name} maxLength={160} placeholder={vendor ? `${vendor.name} — monthly` : 'Yard rent'} onChange={(e) => setName(e.target.value)} {...p} />}</Field>
          <Field label="How often">
            {(p) => (
              <Select value={frequency} onChange={(e) => setFrequency(e.target.value as BooksRecurringFrequency)} {...p}>
                {Object.entries(FREQ_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="First bill on">{(p) => <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} {...p} />}</Field>
          <Field label="Last bill on" hint="Optional — leave empty to keep going.">{(p) => <Input type="date" value={endDate} min={nextDate} onChange={(e) => setEndDate(e.target.value)} {...p} />}</Field>
          <label className="flex cursor-pointer items-start gap-3 self-end pb-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-gold" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} />
            <span>
              <span className="block font-medium text-ink">Send each one to approval</span>
              <span className="block text-ink-muted">Otherwise each waits as a draft for you to check.</span>
            </span>
          </label>
        </div>
        <LinesEditor lines={lines} onChange={setLines} />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!vendorId || !name.trim() || linesTotal(lines) <= 0 || !nextDate}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---- Aging and 1099s ------------------------------------------------------- */

function AgingSection() {
  const q = useQuery({ queryKey: [...PAYABLES_KEY, 'aging'], queryFn: apAging });
  type Row = NonNullable<typeof q.data>['rows'][number];
  const cols: GridColumn<Row>[] = [
    { key: 'vendor', header: 'Vendor', accessor: (r) => r.vendorName, sortable: true, primary: true, cell: (r) => <Link className="font-medium text-ink hover:text-gold hover:underline" to={`/books/vendors/${r.vendorId}`}>{r.vendorName}</Link> },
    ...(
      [
        ['current', 'Not yet due'],
        ['days1to30', '1–30 days late'],
        ['days31to60', '31–60'],
        ['days61to90', '61–90'],
        ['over90', 'Over 90'],
        ['total', 'Total'],
      ] as const
    ).map(([k, label]) => ({
      key: k,
      header: label,
      accessor: (r: Row) => r[k],
      sortable: true,
      searchable: false,
      align: 'right' as const,
      className: k === 'total' ? 'tabular-nums font-medium' : 'tabular-nums',
      cell: (r: Row) => (r[k] ? money(r[k]) : '—'),
    })),
  ];
  const t = q.data?.totals;
  return (
    <div className="space-y-3">
      {t && (
        <MetricStrip label="Payables aging" empty={t.total === 0}>
          <MetricCard label="Total owed" value={money(t.total)} />
          <MetricCard label="Not yet due" value={money(t.current)} tone="neutral" />
          <MetricCard label="1–30 days late" value={money(t.days1to30)} tone={t.days1to30 > 0 ? 'warning' : 'neutral'} />
          <MetricCard label="31–60 days late" value={money(t.days31to60)} tone={t.days31to60 > 0 ? 'warning' : 'neutral'} />
          <MetricCard label="61–90 days late" value={money(t.days61to90)} tone={t.days61to90 > 0 ? 'alert' : 'neutral'} />
          <MetricCard label="Over 90 days late" value={money(t.over90)} tone={t.over90 > 0 ? 'alert' : 'neutral'} />
        </MetricStrip>
      )}
      <DataGrid
        id="books-ap-aging"
        caption="Payables aging"
        noun={{ one: 'vendor', many: 'vendors' }}
        rows={q.data?.rows}
        loading={q.isPending}
        error={q.error ? errText(q.error, 'Could not load the aging.') : null}
        onRetry={() => void q.refetch()}
        columns={cols}
        rowKey={(r) => r.vendorId}
        defaultSort={{ key: 'total', direction: 'desc' }}
        empty={{ title: 'Nothing owed', description: 'Approved bills that aren’t paid show here by how late they are.' }}
      />
    </div>
  );
}

function Vendor1099Section() {
  const thisYear = Number(ymdLocal().slice(0, 4));
  // Jan–Mar is filing season for last year's 1099s; the year is in the URL.
  const [yearParam, setYearParam] = useUrlParam('year', String(thisYear - (new Date().getMonth() < 3 ? 1 : 0)));
  const year = /^\d{4}$/.test(yearParam) ? Number(yearParam) : thisYear;
  const setYear = (y: number) => setYearParam(String(y));
  const q = useQuery({ queryKey: [...PAYABLES_KEY, '1099', year], queryFn: () => vendor1099(year) });
  type Row = NonNullable<typeof q.data>['rows'][number];
  const need = (q.data?.rows ?? []).filter((r) => r.needs1099);
  const cols: GridColumn<Row>[] = [
    { key: 'name', header: 'Vendor', accessor: (r) => r.name, sortable: true, primary: true, cell: (r) => <Link className="font-medium text-ink hover:text-gold hover:underline" to={`/books/vendors/${r.vendorId}`}>{r.name}</Link> },
    { key: 'tin', header: 'Tax ID', accessor: (r) => (r.taxIdLast4 ? `••• ${r.taxIdLast4}` : ''), cell: (r) => (r.taxIdLast4 ? `••• ${r.taxIdLast4}` : <span className="text-ink-muted">Not on file</span>) },
    { key: 'total', header: 'Paid (cash, check, ACH)', accessor: (r) => r.total, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => money(r.total) },
    { key: 'card', header: 'By card', accessor: (r) => r.cardTotal, searchable: false, align: 'right', className: 'tabular-nums', defaultHidden: true, cell: (r) => money(r.cardTotal) },
    { key: 'needs', header: '1099-NEC', accessor: (r) => (r.needs1099 ? 'Needed' : 'Not needed'), sortable: true, cardMeta: true, cell: (r) => (r.needs1099 ? <Badge size="sm" variant={r.missing.length ? 'destructive' : 'pending'}>{r.missing.length ? 'Needed · details missing' : 'Needed'}</Badge> : <Badge size="sm">Not needed</Badge>) },
    { key: 'missing', header: 'Missing', accessor: (r) => r.missing.join('; '), cell: (r) => (r.missing.length ? <span className="text-alert">{r.missing.join(', ')}</span> : '—') },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Year paid
          <TaxYearSelect value={year} onChange={setYear} label="Year paid" />
        </label>
        <Button asChild variant="secondary">
          <a href={vendor1099CsvUrl(year)}>
            <Download className="h-4 w-4" aria-hidden="true" />
            Download for filing
          </a>
        </Button>
      </div>
      {q.data && (
        <p className="text-sm text-ink-muted">
          {need.length} of the year’s 1099 vendors were paid {money(q.data.threshold)} or more by cash, check or ACH — each gets a 1099-NEC by January 31. Card payments are reported by the card network on a 1099-K and don’t count.
        </p>
      )}
      <DataGrid
        id="books-vendor-1099"
        caption={`Vendor 1099s ${year}`}
        noun={{ one: 'vendor', many: 'vendors' }}
        rows={q.data?.rows}
        loading={q.isPending}
        error={q.error ? errText(q.error, 'Could not load the 1099 list.') : null}
        onRetry={() => void q.refetch()}
        columns={cols}
        rowKey={(r) => r.vendorId}
        exportCsv={false}
        empty={{ title: 'No 1099 vendors', description: 'Mark a vendor as getting a 1099 on its page; its payments are totaled here each year.' }}
      />
    </div>
  );
}
