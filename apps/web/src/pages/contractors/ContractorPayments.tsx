import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Banknote, Download, Landmark, Plus, ReceiptText, Trash2 } from '@/components/ui/icons';
import {
  addPayment,
  approvePaymentRun,
  cancelPaymentRun,
  createPaymentRun,
  downloadStateExport,
  getPaymentRun,
  getYearEnd,
  listPaymentRuns,
  listStateFiling,
  markPaymentRunPaid,
  removePayment,
  saveStateFiling,
  type ContractorPayment,
  type PaymentRun,
  type StateFiling,
  type YearEndRow,
} from '@/lib/certifiedPayrollApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { TaxYearSelect } from '@/components/ui/TaxYearSelect';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtMoney } from '@/lib/format';

/* The contractors desk's money tabs: payment runs, state 1099 filing and the year-end summary. */

function RunBadge({ status }: { status: PaymentRun['status'] }) {
  const map = { DRAFT: ['pending', 'Draft'], APPROVED: ['info', 'Approved'], PAID: ['success', 'Paid'], CANCELLED: ['default', 'Cancelled'] } as const;
  const [v, t] = map[status];
  return <Badge variant={v}>{t}</Badge>;
}

/* ----- Payment runs ----------------------------------------------------------------- */

export function PaymentRunsTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contractors', 'runs'], queryFn: listPaymentRuns });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', payDate: new Date().toISOString().slice(0, 10) });
  const create = useMutation({
    mutationFn: () => createPaymentRun({ name: f.name.trim(), payDate: f.payDate }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['contractors', 'runs'] });
      setCreating(false);
      setF({ name: '', payDate: f.payDate });
      setOpen(r.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const columns: GridColumn<PaymentRun>[] = [
    { key: 'name', header: 'Run', primary: true, accessor: (r) => r.name, cell: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'pay', header: 'Pay date', accessor: (r) => r.payDate, cell: (r) => fmtDate(r.payDate), cardMeta: true },
    { key: 'status', header: 'Status', accessor: (r) => r.status, cell: (r) => <RunBadge status={r.status} /> },
    { key: 'count', header: 'Payments', accessor: (r) => r.count, align: 'right', className: 'tabular-nums' },
    { key: 'amount', header: 'Gross', accessor: (r) => r.totals.amount, cell: (r) => fmtMoney(r.totals.amount), align: 'right', className: 'tabular-nums' },
    { key: 'backup', header: 'Backup withheld', accessor: (r) => r.totals.backupWithheld, cell: (r) => fmtMoney(r.totals.backupWithheld), align: 'right', className: 'tabular-nums' },
    { key: 'net', header: 'Net', accessor: (r) => r.totals.net, cell: (r) => fmtMoney(r.totals.net), align: 'right', className: 'tabular-nums' },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Invoices and project fees paid outside the hourly run. Someone other than the builder approves each run.</p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          New run
        </Button>
      </div>
      <DataGrid
        id="contractors-payment-runs"
        caption="Contractor payment runs"
        noun={{ one: 'run', many: 'runs' }}
        rows={q.data?.runs ?? null}
        columns={columns}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.isError ? 'The payment runs could not be loaded.' : null}
        onRetry={() => void q.refetch()}
        search={false}
        urlState={false}
        onRowClick={(r) => setOpen(r.id)}
        rowActionLabel={(r) => `Open ${r.name}`}
        empty={{ icon: Banknote, title: 'No contractor payment runs', description: 'Start a run, add each invoice, and a second person approves it before it is paid.', action: <Button size="sm" onClick={() => setCreating(true)}>New run</Button> }}
      />
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New payment run</DialogTitle>
            <DialogDescription>The pay date decides the 1099 tax year.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (f.name.trim()) create.mutate();
            }}
          >
            <Field label="Name" required>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="October invoices" />
            </Field>
            <Field label="Pay date" required>
              <Input type="date" value={f.payDate} onChange={(e) => setF({ ...f, payDate: e.target.value })} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!f.name.trim()} loading={create.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <RunDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function RunDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['contractors', 'run', id], queryFn: () => getPaymentRun(id!), enabled: !!id });
  const [adding, setAdding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['contractors'] });
  const act = useMutation({
    mutationFn: async (what: 'approve' | 'paid' | 'cancel') => (what === 'approve' ? approvePaymentRun(id!) : what === 'paid' ? markPaymentRunPaid(id!, { paymentMethod: 'ACH' }) : cancelPaymentRun(id!)),
    onSuccess: (_r, what) => {
      toast.success(what === 'approve' ? 'Run approved' : what === 'paid' ? 'Run marked paid' : 'Run cancelled');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({ mutationFn: (p: ContractorPayment) => removePayment(id!, p.id), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const run = q.data?.run;
  const mine = run && q.data?.me === run.createdById;
  return (
    <Drawer open={!!id} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>{run?.name ?? 'Payment run'}</DrawerTitle>
        <DrawerDescription>{run ? `Pays ${fmtDate(run.payDate)}` : ''}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {q.isError ? <QueryError what="this run" query={q} /> : null}
        {q.isLoading || !q.data || !run ? (
          q.isError ? null : <SkeletonRows count={5} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RunBadge status={run.status} />
              {run.status === 'DRAFT' && mine ? <span className="text-sm text-ink-muted">You built this run, so someone else approves it.</span> : null}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label="Gross" value={fmtMoney(run.totals.amount)} />
              <MetricCard label="Backup withheld" value={fmtMoney(run.totals.backupWithheld)} accent={run.totals.backupWithheld > 0} />
              <MetricCard label="State withheld" value={fmtMoney(run.totals.stateWithheld)} />
              <MetricCard label="Net" value={fmtMoney(run.totals.net)} />
            </div>
            {q.data.payments.length === 0 ? (
              <EmptyState size="sm" icon={ReceiptText} title="No payments in this run" description="Add each invoice or fee. Backup withholding is figured for you." />
            ) : (
              <ul className="divide-y divide-navy-secondary">
                {q.data.payments.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{p.name}</p>
                      <p className="truncate text-sm text-ink-muted">{`${p.description}${p.invoiceNumber ? ` · ${p.invoiceNumber}` : ''} · 1099-${p.form}${p.workState ? ` · ${p.workState}` : ''}`}</p>
                    </div>
                    <div className="text-right tabular-nums">
                      <p className="font-medium text-ink">{fmtMoney(p.amount)}</p>
                      {p.backupWithheld > 0 ? <p className="text-xs text-alert">{`${fmtMoney(p.backupWithheld)} backup withheld`}</p> : null}
                    </div>
                    {run.status === 'DRAFT' ? (
                      <Button variant="ghost" size="sm" aria-label={`Remove ${p.name}'s payment`} onClick={() => remove.mutate(p)}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </DrawerBody>
      {run ? (
        <DrawerFooter className="flex flex-wrap gap-2">
          {run.status === 'DRAFT' ? (
            <>
              <Button variant="outline" onClick={() => setAdding(true)}>
                <Plus className="mr-1.5 h-4 w-4" aria-hidden />
                Add payment
              </Button>
              <Button onClick={() => act.mutate('approve')} disabled={!!mine || run.count === 0} loading={act.isPending} title={mine ? 'Someone else approves a run you built' : undefined}>
                Approve
              </Button>
            </>
          ) : null}
          {run.status === 'APPROVED' ? (
            <Button onClick={async () => (await confirm({ title: 'Mark this run paid?', description: 'Do this after the money has gone out. Paid runs count toward 1099s for the pay date’s year.', confirmLabel: 'Mark paid' })) && act.mutate('paid')} loading={act.isPending}>
              Mark paid
            </Button>
          ) : null}
          {run.status === 'DRAFT' || run.status === 'APPROVED' ? (
            <Button variant="ghost" onClick={async () => (await confirm({ title: 'Cancel this run?', confirmLabel: 'Cancel run', destructive: true })) && act.mutate('cancel')}>
              Cancel run
            </Button>
          ) : null}
        </DrawerFooter>
      ) : null}
      {id ? <AddPaymentDialog runId={id} open={adding} onOpenChange={setAdding} /> : null}
    </Drawer>
  );
}

function AddPaymentDialog({ runId, open, onOpenChange }: { runId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [person, setPerson] = useState<PickedAssociate | null>(null);
  const blank = { description: '', invoiceNumber: '', form: 'NEC' as 'NEC' | 'MISC', miscBox: '3', amount: '', workState: '', stateWithheld: '' };
  const [f, setF] = useState(blank);
  const save = useMutation({
    mutationFn: () =>
      addPayment(runId, {
        associateId: person!.id,
        description: f.description.trim(),
        invoiceNumber: f.invoiceNumber.trim() || null,
        form: f.form,
        miscBox: f.form === 'MISC' ? Number(f.miscBox) : null,
        amount: Number(f.amount),
        workState: f.workState.trim().toUpperCase() || null,
        stateWithheld: Number(f.stateWithheld || 0),
      }),
    onSuccess: (r) => {
      toast.success(r.backupWithheld > 0 ? `Added, with ${fmtMoney(r.backupWithheld)} backup withholding` : 'Payment added');
      void qc.invalidateQueries({ queryKey: ['contractors'] });
      setF(blank);
      setPerson(null);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ok = person && f.description.trim() && Number(f.amount) > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a payment</DialogTitle>
          <DialogDescription>24% backup withholding applies when the contractor has no TIN, an unanswered B-notice, or the IRS said so.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate();
          }}
        >
          <Field label="Contractor" required className="col-span-2">
            {({ id }) => <AssociatePicker id={id} value={person} onChange={setPerson} />}
          </Field>
          <Field label="What for" required className="col-span-2">
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </Field>
          <Field label="Invoice number">
            <Input value={f.invoiceNumber} onChange={(e) => setF({ ...f, invoiceNumber: e.target.value })} />
          </Field>
          <Field label="Amount" required>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
          <Field label="Reported on">
            <Select value={f.form} onChange={(e) => setF({ ...f, form: e.target.value as 'NEC' | 'MISC' })}>
              <option value="NEC">1099-NEC</option>
              <option value="MISC">1099-MISC</option>
            </Select>
          </Field>
          {f.form === 'MISC' ? (
            <Field label="MISC box">
              <Select value={f.miscBox} onChange={(e) => setF({ ...f, miscBox: e.target.value })}>
                <option value="1">1 Rents</option>
                <option value="2">2 Royalties</option>
                <option value="3">3 Other income</option>
                <option value="6">6 Medical payments</option>
                <option value="10">10 Attorney proceeds</option>
              </Select>
            </Field>
          ) : (
            <div />
          )}
          <Field label="Work state" hint="For the state 1099">
            <Input maxLength={2} value={f.workState} onChange={(e) => setF({ ...f, workState: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="State tax withheld">
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={f.stateWithheld} onChange={(e) => setF({ ...f, stateWithheld: e.target.value })} />
          </Field>
          <DialogFooter className="col-span-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={save.isPending}>
              Add payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ----- State filing ------------------------------------------------------------------ */

export function StateFilingTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['contractors', 'states'], queryFn: listStateFiling });
  const [year, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0));
  const [editing, setEditing] = useState<StateFiling | null>(null);
  const columns: GridColumn<StateFiling>[] = [
    { key: 'state', header: 'State', primary: true, accessor: (s) => s.state, cell: (s) => <span className="font-medium text-ink">{s.state}</span>, width: '80px' },
    {
      key: 'route',
      header: 'How it gets 1099s',
      accessor: (s) => `${s.cfsf ? 'cfsf' : ''}${s.directFiling ? 'direct' : ''}`,
      cardMeta: true,
      cell: (s) =>
        s.noIncomeTax && !s.cfsf && !s.directFiling ? (
          <span className="text-sm text-ink-muted">No state filing (no income tax)</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {s.cfsf ? <Badge variant="info">Through the IRS (CF/SF)</Badge> : null}
            {s.directFiling ? <Badge variant="accent">Filed directly</Badge> : null}
            {!s.cfsf && !s.directFiling ? <Badge variant="pending">Not set</Badge> : null}
          </span>
        ),
    },
    { key: 'id', header: 'Payer state ID', accessor: (s) => s.payerStateId ?? '', defaultHidden: false },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      searchable: false,
      stopRowClick: true,
      align: 'right',
      cell: (s) => (
        <span className="flex justify-end gap-1">
          {s.directFiling ? (
            <Button variant="ghost" size="sm" aria-label={`Download the ${s.state} 1099 file`} onClick={() => void downloadStateExport(s.state, year).catch((e: Error) => toast.error(e.message))}>
              <Download className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
            Edit
          </Button>
        </span>
      ),
    },
  ];
  return (
    <div className="space-y-3">
      {q.data ? (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center">
            <Landmark className="h-5 w-5 shrink-0 text-gold" aria-hidden />
            <p className="min-w-0 flex-1 text-sm text-ink-muted">
              {q.data.cfsfStates.length
                ? `The IRS forwards your 1099s to ${q.data.cfsfStates.join(', ')} when the federal file is sent with these states (Combined Federal/State Filing). States marked “filed directly” need their own file below.`
                : 'No state takes your 1099s through the IRS yet. Turn on Combined Federal/State Filing for the states that participate.'}
            </p>
            <Field label="Tax year" className="w-32 shrink-0">
              <Input type="number" value={year} min={2020} max={2100} onChange={(e) => setYear(Number(e.target.value))} />
            </Field>
          </CardContent>
        </Card>
      ) : null}
      <DataGrid
        id="contractors-state-filing"
        caption="State 1099 filing"
        noun={{ one: 'state', many: 'states' }}
        rows={q.data?.states ?? null}
        columns={columns}
        rowKey={(s) => s.state}
        loading={q.isLoading}
        error={q.isError ? 'The state settings could not be loaded.' : null}
        onRetry={() => void q.refetch()}
        search={{ placeholder: 'Find a state' }}
        urlState={false}
        empty={{ icon: Landmark, title: 'No states' }}
      />
      <StateDialog s={editing} participants={q.data?.cfsfParticipants ?? []} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ['contractors', 'states'] })} />
    </div>
  );
}

function StateDialog({ s, participants, onClose, onSaved }: { s: StateFiling | null; participants: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<{ cfsf: boolean; directFiling: boolean; payerStateId: string; notes: string } | null>(null);
  const cur = f ?? (s ? { cfsf: s.cfsf, directFiling: s.directFiling, payerStateId: s.payerStateId ?? '', notes: s.notes ?? '' } : null);
  const canCfsf = s ? participants.includes(s.state) : false;
  const save = useMutation({
    mutationFn: () => saveStateFiling(s!.state, { cfsf: cur!.cfsf, directFiling: cur!.directFiling, payerStateId: cur!.payerStateId.trim() || null, notes: cur!.notes.trim() || null }),
    onSuccess: () => {
      toast.success(`${s!.state} saved`);
      onSaved();
      setF(null);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open={!!s}
      onOpenChange={(o) => {
        if (!o) {
          setF(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{s ? `${s.state} 1099 filing` : ''}</DialogTitle>
          <DialogDescription>{canCfsf ? 'This state takes 1099s through the IRS Combined Federal/State program. Some also want a direct file when state tax was withheld.' : 'This state isn’t in the Combined Federal/State program, so it is filed directly.'}</DialogDescription>
        </DialogHeader>
        {cur ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5" disabled={!canCfsf} checked={cur.cfsf} onChange={(e) => setF({ ...cur, cfsf: e.target.checked })} />
              <span>Send through the IRS (Combined Federal/State Filing)</span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" className="mt-0.5" checked={cur.directFiling} onChange={(e) => setF({ ...cur, directFiling: e.target.checked })} />
              <span>File directly with the state</span>
            </label>
            <Field label="Payer state ID" hint="Your withholding or registration number with the state">
              <Input value={cur.payerStateId} onChange={(e) => setF({ ...cur, payerStateId: e.target.value })} />
            </Field>
            <Field label="Notes">
              <Input value={cur.notes} onChange={(e) => setF({ ...cur, notes: e.target.value })} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ----- Year-end ------------------------------------------------------------------------ */

/**
 * The contractors' 1099 summary for a tax year. On the Year-end page's Forms
 * tab the page's tax-year picker drives it (`year`); there is no second
 * year box here (F500 G3: the tax-year picker existed three ways).
 */
export function YearEndTab({ year: fixedYear }: { year?: number } = {}) {
  const [ownYear, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0));
  const year = fixedYear ?? ownYear;
  const q = useQuery({ queryKey: ['contractors', 'year-end', year], queryFn: () => getYearEnd(year) });
  const columns: GridColumn<YearEndRow>[] = [
    { key: 'name', header: 'Contractor', primary: true, accessor: (r) => r.name, cell: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'nec', header: 'NEC box 1', accessor: (r) => r.necBox1, cell: (r) => fmtMoney(r.necBox1), align: 'right', className: 'tabular-nums' },
    { key: 'box4', header: 'Backup withheld', accessor: (r) => r.necBox4 + r.miscBox4, cell: (r) => fmtMoney(r.necBox4 + r.miscBox4), align: 'right', className: 'tabular-nums' },
    { key: 'misc', header: 'MISC', accessor: (r) => r.miscTotal, cell: (r) => fmtMoney(r.miscTotal), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'states', header: 'States', accessor: (r) => r.states.join(', ') },
    {
      key: 'forms',
      header: 'Forms owed',
      accessor: (r) => `${r.needsNec ? 'NEC' : ''}${r.needsMisc ? 'MISC' : ''}`,
      cardMeta: true,
      cell: (r) => (r.needsNec || r.needsMisc ? [r.needsNec && '1099-NEC', r.needsMisc && '1099-MISC'].filter(Boolean).join(', ') : <span className="text-ink-muted">Under the threshold</span>),
    },
    {
      key: 'ready',
      header: 'Ready to file',
      accessor: (r) => r.issues.length,
      cell: (r) => (r.issues.length ? <span className="text-sm text-alert">{r.issues.join(', ')}</span> : r.needsNec || r.needsMisc ? <Badge variant="success">Ready</Badge> : null),
    },
  ];
  const t = q.data?.totals;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-ink-muted">{q.data ? `Everyone paid as a contractor in ${q.data.taxYear}, from payroll and contractor payment runs. A 1099-NEC is owed at ${fmtMoney(q.data.threshold)} or more, or any backup withholding.` : ''}</p>
        {fixedYear === undefined && <TaxYearSelect value={year} onChange={setYear} since={2020} span={5} />}
      </div>
      {q.isError ? <QueryError what="the year-end summary" query={q} /> : null}
      {t ? (
        // No one paid as a contractor in the year: four zeros say nothing; the empty list says it once.
        <MetricStrip label={`1099s for ${year}`} empty={(q.data?.rows.length ?? 0) === 0}>
          <MetricCard label="1099-NEC forms" value={String(t.necForms)} />
          <MetricCard label="1099-MISC forms" value={String(t.miscForms)} />
          <MetricCard label="Backup withheld" value={fmtMoney(t.backupWithheld)} />
          <MetricCard label="Not ready" value={String(t.withIssues)} hint="Missing a TIN, W-9 or address" tone={t.withIssues > 0 ? 'alert' : 'default'} />
        </MetricStrip>
      ) : null}
      {t && t.withIssues > 0 ? (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
            <p className="text-sm text-ink-muted">Request a W-9 from each contractor marked below before you file. 1099s are due to contractors and the IRS by January 31.</p>
          </CardContent>
        </Card>
      ) : null}
      <DataGrid
        id="contractors-year-end"
        caption={`1099 summary ${year}`}
        noun={{ one: 'contractor', many: 'contractors' }}
        rows={q.data?.rows ?? null}
        columns={columns}
        rowKey={(r) => r.associateId}
        loading={q.isLoading}
        search={{ placeholder: 'Search contractors' }}
        urlState={false}
        exportCsv={{ filename: `1099-summary-${year}` }}
        empty={{ icon: ReceiptText, title: `No contractor payments in ${year}`, description: 'Payments to contractors from payroll or payment runs add up here.' }}
      />
    </div>
  );
}
