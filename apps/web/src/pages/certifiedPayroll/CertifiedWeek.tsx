import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Download, FileCode2, PenLine, Send, Users } from 'lucide-react';
import { downloadEcpr, downloadWh347, getWeek, markSubmitted, signWeek, type CertifiedRow, type WeekDetail } from '@/lib/certifiedPayrollApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { fmtDate, fmtDateTime, fmtMoney } from '@/lib/format';
import { WeekStatusBadge } from './CertifiedProject';

/**
 * One week's certified payroll: each worker's hours by day (straight and
 * overtime), the rate paid against the prevailing rate, gross for this
 * project and all work, deductions and net — the WH-347 grid — with what
 * must be fixed before the payroll officer can sign the Statement of
 * Compliance, then the PDF, the California eCPR file and the submission.
 */

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hrs = (n: number) => (n ? String(Math.round(n * 100) / 100) : '');

export function CertifiedWeek() {
  const { id = '', weekEnding = '' } = useParams<{ id: string; weekEnding: string }>();
  const q = useQuery({ queryKey: ['certified-payroll', 'week', id, weekEnding], queryFn: () => getWeek(id, weekEnding), enabled: !!id && !!weekEnding });
  const [signing, setSigning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'xml' | null>(null);

  // Loading and failing keep the page's shell: its title and trail (F500 G3).
  if (q.isError || q.isLoading || !q.data) {
    return (
      <ListTemplate
        title={weekEnding ? `Week ending ${fmtDate(weekEnding)}` : 'Reporting week'}
        breadcrumbs={[
          { label: 'Payroll', to: '/payroll' },
          { label: 'Certified payroll', to: '/payroll/certified' },
          { label: 'Project', to: `/payroll/certified/${id}` },
        ]}
      >
        {q.isError ? <QueryError what="this week" query={q} /> : <SkeletonRows count={8} />}
      </ListTemplate>
    );
  }
  const d = q.data;
  const status = d.report?.status ?? 'OPEN';
  const signed = status === 'SIGNED' || status === 'SUBMITTED';
  const blocking = d.week.exceptions.filter((e) => e.kind !== 'APPRENTICE_RATIO');
  const dl = async (kind: 'pdf' | 'xml') => {
    setBusy(kind);
    try {
      await (kind === 'pdf' ? downloadWh347(id, weekEnding) : downloadEcpr(id, weekEnding));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dayCols: GridColumn<CertifiedRow>[] = d.week.days.map((day, i) => ({
    key: `d${i}`,
    header: `${DAY_ABBR[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))}`,
    accessor: (r) => r.straight[i]! + r.overtime[i]!,
    align: 'right',
    className: 'tabular-nums',
    searchable: false,
    cell: (r) => (
      <span className="whitespace-nowrap">
        {hrs(r.straight[i]!)}
        {r.overtime[i] ? <span className="text-gold">{` +${hrs(r.overtime[i]!)}`}</span> : null}
      </span>
    ),
  }));
  const columns: GridColumn<CertifiedRow>[] = [
    {
      key: 'name',
      header: 'Worker',
      primary: true,
      accessor: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{r.name}</p>
          <p className="truncate text-xs text-ink-muted">{`${r.classification}${r.isApprentice ? ' · apprentice' : ''}${r.idLast4 ? ` · ID ${r.idLast4}` : ''}`}</p>
        </div>
      ),
    },
    ...dayCols,
    { key: 'hours', header: 'Hours', accessor: (r) => r.totalStraight + r.totalOvertime, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (r) => `${hrs(r.totalStraight)}${r.totalOvertime ? ` + ${hrs(r.totalOvertime)} OT` : ''}` },
    {
      key: 'rate',
      header: 'Rate paid',
      accessor: (r) => r.rate ?? 0,
      align: 'right',
      className: 'tabular-nums',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {r.rate !== null ? fmtMoney(r.rate) : '—'}
          {r.belowPrevailing ? <Badge variant="destructive" className="ml-2">{`Needs ${fmtMoney(r.requiredRate ?? 0)}`}</Badge> : null}
        </span>
      ),
    },
    { key: 'required', header: 'Prevailing', accessor: (r) => r.requiredRate ?? 0, align: 'right', className: 'tabular-nums', cell: (r) => (r.requiredRate !== null ? fmtMoney(r.requiredRate) : '—'), defaultHidden: true },
    { key: 'gross', header: 'Gross, this project', accessor: (r) => r.grossThisProject, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.grossThisProject) },
    { key: 'grossAll', header: 'Gross, all work', accessor: (r) => r.grossAllWork, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.grossAllWork), defaultHidden: true },
    { key: 'deductions', header: 'Deductions', accessor: (r) => r.deductions?.total ?? 0, align: 'right', className: 'tabular-nums', cell: (r) => (r.deductions ? fmtMoney(r.deductions.total) : <Badge variant="pending">Not paid yet</Badge>) },
    { key: 'net', header: 'Net paid', accessor: (r) => r.net ?? 0, align: 'right', className: 'tabular-nums', cell: (r) => (r.net !== null ? fmtMoney(r.net) : '—') },
  ];

  return (
    <ListTemplate
      title={`Week ending ${fmtDate(d.weekEnding)}`}
      subtitle={`${d.project.name} · Payroll no. ${d.payrollNumber}`}
      breadcrumbs={[
        { label: 'Payroll', to: '/payroll' },
        { label: 'Certified payroll', to: '/payroll/certified' },
        { label: d.project.name, to: `/payroll/certified/${d.project.id}` },
        { label: fmtDate(d.weekEnding) },
      ]}
      primaryAction={
        status === 'SIGNED' ? (
          <Button onClick={() => setSubmitting(true)}>
            <Send className="mr-1.5 h-4 w-4" aria-hidden />
            Mark submitted
          </Button>
        ) : !signed ? (
          <Button onClick={() => setSigning(true)} disabled={blocking.length > 0} title={blocking.length > 0 ? `Fix the ${blocking.length === 1 ? 'item' : `${blocking.length} items`} listed below first` : undefined}>
            <PenLine className="mr-1.5 h-4 w-4" aria-hidden />
            Sign the statement
          </Button>
        ) : null
      }
      secondaryActions={
        <>
          <Button variant="outline" size="sm" onClick={() => void dl('pdf')} loading={busy === 'pdf'}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden />
            {signed ? 'WH-347' : 'Draft WH-347'}
          </Button>
          {d.ecprAvailable ? (
            <Button variant="outline" size="sm" onClick={() => void dl('xml')} loading={busy === 'xml'} disabled={!signed} title={!signed ? 'Sign first' : undefined}>
              <FileCode2 className="mr-1.5 h-4 w-4" aria-hidden />
              eCPR file
            </Button>
          ) : null}
        </>
      }
      summary={
        <div className="space-y-3">
          <StatusCard d={d} />
          {d.week.exceptions.length > 0 && !signed ? (
            <Card className="border-warning/30 bg-warning/5">
              <CardContent className="flex items-start gap-3 py-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium text-ink">{blocking.length > 0 ? 'Fix these before signing' : 'Check before signing'}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-muted">
                    {d.week.exceptions.map((e, i) => (
                      <li key={i}>{e.message}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label="Workers" value={String(d.week.totals.workers)} />
            <MetricCard label="Hours" value={hrs(d.week.totals.hours) || '0'} />
            <MetricCard label="Gross, this project" value={fmtMoney(d.week.totals.grossThisProject)} />
          </div>
        </div>
      }
    >
      <DataGrid
        id="certified-payroll-week"
        caption={`WH-347 for the week ending ${d.weekEnding}`}
        noun={{ one: 'worker', many: 'workers' }}
        rows={d.week.rows}
        columns={columns}
        rowKey={(r) => r.associateId}
        urlState={false}
        search={false}
        footnote="Hours are straight time; overtime shows after a plus sign."
        empty={{ icon: Users, title: 'No work on the project this week', description: 'Sign it as a week with no work performed. Agencies expect a payroll for every week of the contract.' }}
      />
      <SignDialog d={d} open={signing} onOpenChange={setSigning} />
      <SubmitDialog d={d} open={submitting} onOpenChange={setSubmitting} />
    </ListTemplate>
  );
}

function StatusCard({ d }: { d: WeekDetail }) {
  const r = d.report;
  if (r && (r.status === 'SIGNED' || r.status === 'SUBMITTED')) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardContent className="flex flex-wrap items-start gap-3 py-4">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-ink">{`Signed by ${r.signatureName}${r.signerTitle ? `, ${r.signerTitle}` : ''}`}</p>
              <WeekStatusBadge status={r.status} />
            </div>
            <p className="text-sm text-ink-muted">
              {`${r.signedAt ? fmtDateTime(r.signedAt) : ''}${r.submittedAt ? ` · submitted to ${r.submittedTo}${r.confirmation ? ` (${r.confirmation})` : ''} on ${fmtDate(r.submittedAt)}` : ' · not yet submitted to the agency'}`}
            </p>
            <p className="mt-1 break-all text-xs text-ink-muted">{`Document fingerprint ${r.pdfHash ?? ''}`}</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return null;
}

function SignDialog({ d, open, onOpenChange }: { d: WeekDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    signatureName: d.project.payrollOfficerName ?? '',
    signerTitle: d.project.payrollOfficerTitle ?? '',
    fringeStatement: (d.project.fringeMode === 'PLAN' ? 'PLANS' : d.project.fringeMode) as 'PLANS' | 'CASH' | 'MIXED',
    exceptionsText: '',
    isFinal: false,
    attest: false,
  });
  const sign = useMutation({
    mutationFn: () => signWeek(d.project.id, d.weekEnding, { signatureName: f.signatureName.trim(), signerTitle: f.signerTitle.trim(), fringeStatement: f.fringeStatement, exceptionsText: f.exceptionsText.trim() || null, isFinal: f.isFinal, attest: true }),
    onSuccess: () => {
      toast.success('Statement of Compliance signed');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ok = f.signatureName.trim().length >= 2 && f.signerTitle.trim() && f.attest;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Statement of Compliance</DialogTitle>
          <DialogDescription>{`Payroll no. ${d.payrollNumber}, the week ending ${fmtDate(d.weekEnding)}. Your typed name is your signature.`}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) sign.mutate();
          }}
        >
          <div className="rounded-md border border-navy-secondary p-3 text-sm text-ink-muted">
            <p>I certify that this payroll is correct and complete; that the wage rates are not less than the applicable rates in the wage determination; that every worker was paid the full weekly wages earned, with no rebates or deductions other than those permitted; and that apprentices are registered in an approved program.</p>
          </div>
          <Field label="Fringe benefits were">
            <Select value={f.fringeStatement} onChange={(e) => setF({ ...f, fringeStatement: e.target.value as typeof f.fringeStatement })}>
              <option value="PLANS">Paid to approved plans, funds or programs</option>
              <option value="CASH">Paid in cash to each worker</option>
              <option value="MIXED">Partly to plans, partly in cash</option>
            </Select>
          </Field>
          <Field label="Exceptions" hint="Any craft or worker the statement does not cover, and why">
            <Textarea rows={2} value={f.exceptionsText} onChange={(e) => setF({ ...f, exceptionsText: e.target.value })} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Your full name" required>
              <Input value={f.signatureName} autoComplete="name" onChange={(e) => setF({ ...f, signatureName: e.target.value })} />
            </Field>
            <Field label="Title" required>
              <Input value={f.signerTitle} onChange={(e) => setF({ ...f, signerTitle: e.target.value })} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.isFinal} onChange={(e) => setF({ ...f, isFinal: e.target.checked })} />
            <span>This is the final payroll for the project</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-0.5" checked={f.attest} onChange={(e) => setF({ ...f, attest: e.target.checked })} />
            <span>I have read the statement. I understand that a willful false statement can bring civil or criminal prosecution (18 U.S.C. 1001; 31 U.S.C. 3729).</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ok} loading={sign.isPending}>
              Sign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SubmitDialog({ d, open, onOpenChange }: { d: WeekDetail; open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [to, setTo] = useState(d.ecprAvailable ? 'California DIR eCPR' : d.project.name ? 'Contracting agency' : '');
  const [conf, setConf] = useState('');
  const save = useMutation({
    mutationFn: () => markSubmitted(d.project.id, d.weekEnding, { submittedTo: to.trim(), confirmation: conf.trim() || null }),
    onSuccess: () => {
      toast.success('Marked submitted');
      void qc.invalidateQueries({ queryKey: ['certified-payroll'] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark submitted</DialogTitle>
          <DialogDescription>Record where the signed payroll went, after you upload or send it.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (to.trim()) save.mutate();
          }}
        >
          <Field label="Submitted to" required>
            <Input value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Confirmation number">
            <Input value={conf} onChange={(e) => setConf(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!to.trim()} loading={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
