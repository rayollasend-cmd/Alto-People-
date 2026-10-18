import { useMemo, useState } from 'react';
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';

/**
 * Manual checks and third-party sick pay. A handwritten check already
 * left: recording it puts it in payroll history, YTD and the tax ledger;
 * void takes it back out, replace voids it and records the new one. Insurer
 * sick pay is recorded for the W-2 (Box 12 J, Box 13) and, when the insurer
 * passed the liability back, the employer's share of FICA and FUTA.
 */

type Tab = 'checks' | 'sick';
const r2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export function ManualChecksPage() {
  const term = useTerm();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('checks');
  const [replacing, setReplacing] = useState<ManualCheckRow | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'manual-checks'], queryFn: () => getManualChecks() });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll', 'manual-checks'] });
  const voidCheck = useMutation({
    mutationFn: (r: ManualCheckRow) => voidManualCheck(r.runId, 'Voided from the manual checks page'),
    onSuccess: () => {
      toast.success('Check voided. It’s out of YTD.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void.'),
  });
  const voidSick = useMutation({
    mutationFn: (id: string) => voidSickPay(id),
    onSuccess: () => {
      toast.success('Sick pay record voided.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not void.'),
  });

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
      cell: (r) =>
        r.status === 'RECORDED' ? (
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setReplacing(r)} aria-label={`Replace check ${r.checkNumber}`}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" disabled={voidCheck.isPending} onClick={() => voidCheck.mutate(r)} aria-label={`Void check ${r.checkNumber}`}>
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
      cell: (r) =>
        r.voided ? (
          <Badge variant="default">Voided</Badge>
        ) : (
          <Button size="sm" variant="ghost" disabled={voidSick.isPending} onClick={() => voidSick.mutate(r.id)} aria-label={`Void sick pay for ${r.associateName}`}>
            Void
          </Button>
        ),
    },
  ];

  return (
    <ListTemplate
      title="Manual checks and sick pay"
      subtitle="Checks written by hand and sick pay an insurer paid — recorded so payroll history, year-to-date, taxes owed and the W-2 are right."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Manual checks' }]}
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
      <div className="space-y-4">
        {tab === 'checks' ? (
          <>
            <ManualCheckForm key={replacing?.itemId ?? 'new'} replacing={replacing} onDone={() => { setReplacing(null); refresh(); }} />
            <DataGrid
              id="manual-checks"
              caption="Manual checks"
              rows={q.data?.checks}
              columns={checkCols}
              rowKey={(r) => r.itemId}
              loading={q.isLoading}
              error={q.isError ? 'Could not load manual checks.' : null}
              onRetry={() => void q.refetch()}
              noun={{ one: 'check', many: 'checks' }}
              defaultSort={{ key: 'date', direction: 'desc' }}
            />
          </>
        ) : (
          <>
            <SickPayForm onDone={refresh} />
            <DataGrid
              id="third-party-sick-pay"
              caption="Third-party sick pay"
              rows={q.data?.sickPay}
              columns={sickCols}
              rowKey={(r) => r.id}
              loading={q.isLoading}
              error={q.isError ? 'Could not load sick pay.' : null}
              onRetry={() => void q.refetch()}
              noun={{ one: 'payment', many: 'payments' }}
              defaultSort={{ key: 'date', direction: 'desc' }}
            />
          </>
        )}
      </div>
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

function ManualCheckForm({ replacing, onDone }: { replacing: ManualCheckRow | null; onDone: () => void }) {
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
    <Card>
      <CardHeader>
        <CardTitle>{replacing ? `Replace check #${replacing.checkNumber}` : 'Record a manual check'}</CardTitle>
        <CardDescription>Copy the amounts from the check stub. The net must add up.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
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
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
            {mismatch && <p role="alert" className="text-sm text-destructive">The amounts add up to {fmtMoney(computedNet)}, not {fmtMoney(netValue)}.</p>}
          </div>
          <div className="flex items-end gap-2 lg:col-span-4">
            <Button type="submit" loading={save.isPending} disabled={!valid || save.isPending}>
              {replacing ? 'Record the replacement' : 'Record check'}
            </Button>
            {replacing && (
              <Button type="button" variant="ghost" onClick={onDone}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SickPayForm({ onDone }: { onDone: () => void }) {
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
    <Card>
      <CardHeader>
        <CardTitle>Record insurer-paid sick pay</CardTitle>
        <CardDescription>From the insurer’s sick pay statement. The part bought with the employee’s after-tax premiums is nontaxable and goes in Box 12 J.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
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
          <div className="flex items-end lg:col-span-4">
            <Button type="submit" loading={save.isPending} disabled={!valid || save.isPending}>
              Record sick pay
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
