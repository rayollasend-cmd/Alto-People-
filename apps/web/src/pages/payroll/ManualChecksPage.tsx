import { useMemo, useState } from 'react';
import { FileText, Plus } from '@/components/ui/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  getManualChecks,
  recordManualCheck,
  recordSickPay,
  voidManualCheck,
  voidSickPay,
  type ManualCheckRow,
  type SickPayRow,
} from '@/lib/payExpApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { usePrompt } from '@/lib/confirm';
import { useUrlParam } from '@/lib/useUrlState';

/**
 * Manual checks and third-party sick pay. A handwritten check already
 * left: recording it puts it in payroll history, YTD and the tax ledger;
 * void takes it back out, replace voids it and records the new one. Insurer
 * sick pay is recorded for the W-2 (Box 12 J, Box 13) and, when the insurer
 * passed the liability back, the employer's share of FICA and FUTA.
 */

type Tab = 'checks' | 'sick';
const TABS: readonly Tab[] = ['checks', 'sick'];
const r2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export function ManualChecksPage() {
  const term = useTerm();
  const qc = useQueryClient();
  const prompt = usePrompt();
  // The switch lives in the URL (?tab=sick), so Back and a shared link keep it.
  const [tab, setTab] = useUrlParam<Tab>('tab', 'checks', TABS, { history: 'push' });
  // The record dialog: a new check, a replacement for one, or insurer sick pay.
  const [recording, setRecording] = useState<null | { kind: 'check'; replacing: ManualCheckRow | null } | { kind: 'sick' }>(null);
  const q = useQuery({ queryKey: ['payroll', 'manual-checks'], queryFn: () => getManualChecks() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll', 'manual-checks'] });
  const voidCheck = useMutation({
    mutationFn: ({ row, reason }: { row: ManualCheckRow; reason: string }) => voidManualCheck(row.runId, reason),
    onSuccess: (_d, { row }) => {
      toast.success(`Check #${row.checkNumber} is void. It no longer counts toward ${row.associateName}’s year-to-date pay, taxes or W-2.`);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void the check.'),
  });
  const voidSick = useMutation({
    mutationFn: ({ row, reason }: { row: SickPayRow; reason: string }) => voidSickPay(row.id, reason),
    onSuccess: (_d, { row }) => {
      toast.success(`Sick pay from ${row.payerName} is void. It no longer counts toward ${row.associateName}’s W-2.`);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void the sick pay.'),
  });

  // Voiding changes year-to-date pay, the tax ledger and the W-2: asked, with a reason on the record
  // (the same prompt as voiding a printed check on the run's paper checks).
  const onVoidCheck = async (row: ManualCheckRow) => {
    const reason = await prompt({
      title: `Void check #${row.checkNumber}?`,
      description: `${row.associateName} · ${fmtMoney(row.net)} net, paid ${row.payDate ? fmtDate(row.payDate) : 'by hand'}. It comes out of their year-to-date pay, the taxes owed and the W-2. The record stays, marked void.`,
      confirmLabel: 'Void check',
      destructive: true,
      reasonLabel: 'Why is it void?',
      reasonPlaceholder: 'Written for the wrong amount',
    });
    if (reason) voidCheck.mutate({ row, reason });
  };
  const onVoidSick = async (row: SickPayRow) => {
    const reason = await prompt({
      title: `Void sick pay for ${row.associateName}?`,
      description: `${fmtMoney(row.grossAmount)} paid by ${row.payerName} on ${fmtDate(row.payDate)}. It comes off their W-2, and any employer taxes it added are taken back out.`,
      confirmLabel: 'Void sick pay',
      destructive: true,
      reasonLabel: 'Why is it void?',
      reasonPlaceholder: 'The insurer sent a corrected statement',
    });
    if (reason) voidSick.mutate({ row, reason });
  };

  const checkCols: GridColumn<ManualCheckRow>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.associateName, primary: true },
    { key: 'number', header: 'Check #', accessor: (r) => r.checkNumber },
    { key: 'date', header: 'Paid', accessor: (r) => r.payDate ?? '', cell: (r) => (r.payDate ? fmtDate(r.payDate) : '—'), sortable: true, cardMeta: true },
    { key: 'gross', header: 'Gross', accessor: (r) => r.gross, cell: (r) => fmtMoney(r.gross), align: 'right', className: 'tabular-nums' },
    { key: 'taxes', header: 'Taxes', accessor: (r) => r.taxes, cell: (r) => fmtMoney(r.taxes), align: 'right', className: 'tabular-nums', defaultHidden: true },
    { key: 'net', header: 'Net', accessor: (r) => r.net, cell: (r) => fmtMoney(r.net), align: 'right', className: 'tabular-nums' },
    {
      key: 'status',
      header: 'Status',
      accessor: (r) => r.status,
      cell: (r) => <Badge variant={r.status === 'VOIDED' ? 'default' : 'success'}>{r.status === 'VOIDED' ? 'Voided' : 'Recorded'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      stopRowClick: true,
      cell: (r) =>
        r.status === 'RECORDED' ? (
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setRecording({ kind: 'check', replacing: r })} aria-label={`Replace check ${r.checkNumber}`}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" disabled={voidCheck.isPending} onClick={() => void onVoidCheck(r)} aria-label={`Void check ${r.checkNumber}`}>
              Void
            </Button>
          </span>
        ) : null,
    },
  ];
  const sickCols: GridColumn<SickPayRow>[] = [
    { key: 'person', header: term('worker'), accessor: (r) => r.associateName, primary: true },
    { key: 'payer', header: 'Paid by', accessor: (r) => r.payerName },
    { key: 'date', header: 'Paid', accessor: (r) => r.payDate, cell: (r) => fmtDate(r.payDate), sortable: true, cardMeta: true },
    { key: 'gross', header: 'Gross', accessor: (r) => r.grossAmount, cell: (r) => fmtMoney(r.grossAmount), align: 'right', className: 'tabular-nums' },
    { key: 'j', header: 'Box 12 J', accessor: (r) => r.nontaxableAmount, cell: (r) => fmtMoney(r.nontaxableAmount), align: 'right', className: 'tabular-nums' },
    { key: 'who', header: 'Employer taxes', accessor: (r) => r.employerTaxesBy, cell: (r) => (r.employerTaxesBy === 'EMPLOYER' ? 'We owe them' : 'The insurer') },
    {
      key: 'actions',
      header: '',
      accessor: () => '',
      stopRowClick: true,
      cell: (r) =>
        r.voided ? (
          <Badge variant="default">Voided</Badge>
        ) : (
          <Button size="sm" variant="ghost" disabled={voidSick.isPending} onClick={() => void onVoidSick(r)} aria-label={`Void sick pay for ${r.associateName}`}>
            Void
          </Button>
        ),
    },
  ];

  const closeDialog = () => setRecording(null);
  const checks = q.data?.checks;
  const sickPay = q.data?.sickPay;

  return (
    <ListTemplate
      title="Manual checks and sick pay"
      subtitle="Checks written by hand and sick pay an insurer paid, recorded so payroll history, year-to-date, taxes owed and the W-2 are right."
      actions={[
        tab === 'checks'
          ? { key: 'record-check', label: 'Record a manual check', icon: Plus, primary: true, onSelect: () => setRecording({ kind: 'check', replacing: null }) }
          : { key: 'record-sick', label: 'Record sick pay', icon: Plus, primary: true, onSelect: () => setRecording({ kind: 'sick' }) },
      ]}
      filters={
        <SegmentedControl
          ariaLabel="Show"
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: 'checks', label: 'Manual checks' },
            { value: 'sick', label: 'Third-party sick pay' },
          ]}
        />
      }
    >
      {tab === 'checks' ? (
        <DataGrid
          id="manual-checks"
          caption="Manual checks"
          rows={checks}
          columns={checkCols}
          rowKey={(r) => r.itemId}
          loading={q.isLoading}
          error={q.isError ? 'Could not load manual checks.' : null}
          onRetry={() => void q.refetch()}
          noun={{ one: 'check', many: 'checks' }}
          defaultSort={{ key: 'date', direction: 'desc' }}
          empty={{
            icon: FileText,
            title: 'No manual checks recorded',
            description: 'When someone is paid with a check written by hand, record it here so their year-to-date pay, taxes and W-2 include it.',
            action: (
              <Button onClick={() => setRecording({ kind: 'check', replacing: null })}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Record a manual check
              </Button>
            ),
          }}
        />
      ) : (
        <DataGrid
          id="third-party-sick-pay"
          caption="Third-party sick pay"
          rows={sickPay}
          columns={sickCols}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.isError ? 'Could not load sick pay.' : null}
          onRetry={() => void q.refetch()}
          noun={{ one: 'payment', many: 'payments' }}
          defaultSort={{ key: 'date', direction: 'desc' }}
          empty={{
            icon: FileText,
            title: 'No insurer sick pay recorded',
            description: 'When a disability insurer pays someone sick pay, record its statement here so the W-2 and the employer taxes are right.',
            action: (
              <Button onClick={() => setRecording({ kind: 'sick' })}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Record sick pay
              </Button>
            ),
          }}
        />
      )}

      <Dialog open={recording?.kind === 'check'} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-3xl">
          {recording?.kind === 'check' && (
            <ManualCheckForm
              key={recording.replacing?.itemId ?? 'new'}
              replacing={recording.replacing}
              onCancel={closeDialog}
              onDone={() => {
                closeDialog();
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={recording?.kind === 'sick'} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-3xl">
          {recording?.kind === 'sick' && (
            <SickPayForm
              onCancel={closeDialog}
              onDone={() => {
                closeDialog();
                refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </ListTemplate>
  );
}

function MoneyField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(p) => <Input type="number" inputMode="decimal" min="0" step="0.01" value={value} onChange={(e) => onChange(e.target.value)} {...p} />}
    </Field>
  );
}

function ManualCheckForm({ replacing, onDone, onCancel }: { replacing: ManualCheckRow | null; onDone: () => void; onCancel: () => void }) {
  const term = useTerm();
  const [who, setWho] = useState<PickedAssociate | null>(replacing ? { id: replacing.associateId, name: replacing.associateName } : null);
  const [f, setF] = useState({ checkNumber: '', payDate: today(), gross: replacing ? String(replacing.gross) : '', preTax: '', federal: '', ss: '', medicare: '', state: '', local: '', postTax: '', net: '' });
  const n = (s: string) => (s.trim() === '' ? 0 : Number(s));
  const computedNet = useMemo(() => r2(n(f.gross) - n(f.preTax) - n(f.federal) - n(f.ss) - n(f.medicare) - n(f.state) - n(f.local) - n(f.postTax)), [f]);
  const netValue = f.net.trim() === '' ? computedNet : n(f.net);
  const mismatch = f.net.trim() !== '' && Math.abs(netValue - computedNet) > 0.01;
  const save = useMutation({
    mutationFn: () =>
      recordManualCheck({
        associateId: who!.id,
        checkNumber: f.checkNumber.trim(),
        payDate: f.payDate,
        gross: n(f.gross),
        preTaxDeductions: n(f.preTax),
        federal: n(f.federal),
        socialSecurity: n(f.ss),
        medicare: n(f.medicare),
        state: n(f.state),
        local: n(f.local),
        postTaxDeductions: n(f.postTax),
        net: netValue,
        replacesItemId: replacing?.itemId ?? null,
      }),
    onSuccess: () => {
      toast.success(replacing ? 'Replacement recorded; the old check is voided.' : 'Manual check recorded.');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the check.'),
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const valid = !!who && f.checkNumber.trim() !== '' && n(f.gross) > 0 && !mismatch && netValue >= 0;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{replacing ? `Replace check #${replacing.checkNumber}` : 'Record a manual check'}</DialogTitle>
        <DialogDescription>
          {replacing
            ? `The new check is recorded and #${replacing.checkNumber} is voided. Copy the amounts from the new check’s stub; the net must add up.`
            : 'Copy the amounts from the check stub. The net must add up.'}
        </DialogDescription>
      </DialogHeader>
      <form id="manual-check-form" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="sm:col-span-2">
          <Field label={term('worker')}>{() => <AssociatePicker value={who} onChange={setWho} placeholder={`Search ${term('worker').toLowerCase()}…`} />}</Field>
        </div>
        <Field label="Check number">{(p) => <Input value={f.checkNumber} maxLength={20} onChange={(e) => set('checkNumber')(e.target.value)} {...p} />}</Field>
        <Field label="Pay date">{(p) => <Input type="date" value={f.payDate} onChange={(e) => set('payDate')(e.target.value)} {...p} />}</Field>
        <MoneyField label="Gross" value={f.gross} onChange={set('gross')} />
        <MoneyField label="Pre-tax deductions" value={f.preTax} onChange={set('preTax')} />
        <MoneyField label="Federal income tax" value={f.federal} onChange={set('federal')} />
        <MoneyField label="Social Security" value={f.ss} onChange={set('ss')} />
        <MoneyField label="Medicare" value={f.medicare} onChange={set('medicare')} />
        <MoneyField label="State income tax" value={f.state} onChange={set('state')} />
        <MoneyField label="Local tax" value={f.local} onChange={set('local')} />
        <MoneyField label="After-tax deductions" value={f.postTax} onChange={set('postTax')} />
        <MoneyField label="Net (the check’s amount)" value={f.net} onChange={set('net')} hint={`Adds up to ${fmtMoney(computedNet)}`} />
        {mismatch && (
          <p role="alert" className="text-sm text-alert sm:col-span-2 lg:col-span-3">
            The amounts add up to {fmtMoney(computedNet)}, not {fmtMoney(netValue)}.
          </p>
        )}
      </form>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form="manual-check-form" loading={save.isPending} disabled={!valid || save.isPending}>
          {replacing ? 'Record the replacement' : 'Record check'}
        </Button>
      </DialogFooter>
    </>
  );
}

function SickPayForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const term = useTerm();
  const [who, setWho] = useState<PickedAssociate | null>(null);
  const [f, setF] = useState({ payerName: '', payDate: today(), gross: '', nontaxable: '', federal: '', ss: '', medicare: '', state: '', employerTaxesBy: 'EMPLOYER' as 'EMPLOYER' | 'INSURER', w2ReportedBy: 'EMPLOYER' as 'EMPLOYER' | 'INSURER' });
  const n = (s: string) => (s.trim() === '' ? 0 : Number(s));
  const save = useMutation({
    mutationFn: () =>
      recordSickPay({
        associateId: who!.id,
        payerName: f.payerName.trim(),
        payDate: f.payDate,
        grossAmount: n(f.gross),
        nontaxableAmount: n(f.nontaxable),
        federalWithheld: n(f.federal),
        socialSecurityWithheld: n(f.ss),
        medicareWithheld: n(f.medicare),
        stateWithheld: n(f.state),
        employerTaxesBy: f.employerTaxesBy,
        w2ReportedBy: f.w2ReportedBy,
      }),
    onSuccess: (r) => {
      const owed = r2(r.employerTaxes.fica + r.employerTaxes.medicare + r.employerTaxes.futa + r.employerTaxes.suta);
      toast.success(owed > 0 ? `Recorded. Employer taxes owed: ${fmtMoney(owed)}.` : 'Recorded.');
      setWho(null);
      setF({ ...f, gross: '', nontaxable: '', federal: '', ss: '', medicare: '', state: '' });
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record sick pay.'),
  });
  const set = (k: keyof typeof f) => (v: string) => setF({ ...f, [k]: v });
  const valid = !!who && f.payerName.trim().length >= 2 && n(f.gross) > 0 && n(f.nontaxable) <= n(f.gross);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Record insurer-paid sick pay</DialogTitle>
        <DialogDescription>From the insurer’s sick pay statement. The part bought with the employee’s after-tax premiums is nontaxable and goes in Box 12 J.</DialogDescription>
      </DialogHeader>
      <form id="sick-pay-form" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
        <div className="sm:col-span-2">
          <Field label={term('worker')}>{() => <AssociatePicker value={who} onChange={setWho} placeholder={`Search ${term('worker').toLowerCase()}…`} />}</Field>
        </div>
        <Field label="Insurer">{(p) => <Input value={f.payerName} maxLength={200} onChange={(e) => set('payerName')(e.target.value)} {...p} />}</Field>
        <Field label="Pay date">{(p) => <Input type="date" value={f.payDate} onChange={(e) => set('payDate')(e.target.value)} {...p} />}</Field>
        <MoneyField label="Gross sick pay" value={f.gross} onChange={set('gross')} />
        <MoneyField label="Nontaxable part" value={f.nontaxable} onChange={set('nontaxable')} />
        <MoneyField label="Federal withheld" value={f.federal} onChange={set('federal')} />
        <MoneyField label="Social Security withheld" value={f.ss} onChange={set('ss')} />
        <MoneyField label="Medicare withheld" value={f.medicare} onChange={set('medicare')} />
        <MoneyField label="State withheld" value={f.state} onChange={set('state')} />
        <Field label="Employer FICA and FUTA">
          {(p) => (
            <Select value={f.employerTaxesBy} onChange={(e) => set('employerTaxesBy')(e.target.value)} {...p}>
              <option value="EMPLOYER">We owe them (liability passed back)</option>
              <option value="INSURER">The insurer pays them</option>
            </Select>
          )}
        </Field>
        <Field label="Who files the W-2">
          {(p) => (
            <Select value={f.w2ReportedBy} onChange={(e) => set('w2ReportedBy')(e.target.value)} {...p}>
              <option value="EMPLOYER">We do (on our W-2)</option>
              <option value="INSURER">The insurer does</option>
            </Select>
          )}
        </Field>
      </form>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form="sick-pay-form" loading={save.isPending} disabled={!valid || save.isPending}>
          Record sick pay
        </Button>
      </DialogFooter>
    </>
  );
}
