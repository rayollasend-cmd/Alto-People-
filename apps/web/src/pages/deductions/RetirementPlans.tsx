import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Download, FileUp, PiggyBank, Plus, RefreshCw, Send, Trash2, Upload, Users } from 'lucide-react';
import {
  addLoan,
  changeElection,
  createPlan,
  downloadPlanFile,
  listElections,
  listPayDates,
  listPlanFiles,
  listPlans,
  makeCensusFile,
  makeContributionFile,
  makeTrueUpFile,
  savePlanConnection,
  sendPlanFile,
  setLoanStatus,
  syncPlan,
  updatePlan,
  uploadDeferralChanges,
  type Election,
  type Loan,
  type PlanInput,
  type RetirementFile,
  type RetirementPlan,
} from '@/lib/deductionsApi';
import { useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

/**
 * Retirement plans: a 401(k) per employer of record — who is eligible and
 * enrolled, auto-enrollment and escalation, loans — and the files the
 * recordkeeper needs each pay date, plus the census and the year-end
 * true-up. Rate changes people make on the recordkeeper's site come back
 * through a deferral-change file.
 */

type Tab = 'people' | 'files' | 'setup';
const TABS: Tab[] = ['people', 'files', 'setup'];

const STATUS: Record<Election['status'], [React.ComponentProps<typeof Badge>['variant'], string]> = {
  NOT_ELIGIBLE: ['default', 'Not eligible yet'],
  ELIGIBLE: ['info', 'Eligible'],
  ENROLLED: ['success', 'Enrolled'],
  AUTO_ENROLLED: ['success', 'Auto-enrolled'],
  OPTED_OUT: ['default', 'Opted out'],
};
const SAFE_HARBOR: Record<RetirementPlan['safeHarbor'], string> = {
  NONE: 'Match formula',
  BASIC: 'Safe harbor basic match (100% of 3%, 50% of the next 2%)',
  ENHANCED: 'Safe harbor enhanced match (100% of 4%)',
  NONELECTIVE_3: 'Safe harbor 3% for everyone eligible',
};

function matchText(p: RetirementPlan): string {
  if (p.safeHarbor !== 'NONE') return SAFE_HARBOR[p.safeHarbor];
  if (!p.matchFormula.length) return 'No employer match';
  let floor = 0;
  return p.matchFormula
    .map((t) => {
      const s = `${t.matchPercent}% of ${floor ? `the next ${t.upToPercent - floor}%` : `the first ${t.upToPercent}%`}`;
      floor = t.upToPercent;
      return s;
    })
    .join(', then ');
}

export function RetirementPlans() {
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['retirement', 'plans'], queryFn: listPlans });
  const [creating, setCreating] = useState(false);
  const plans = q.data?.plans ?? [];
  const planId = params.get('plan') ?? plans[0]?.id ?? null;
  const plan = plans.find((p) => p.id === planId) ?? null;
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'people') as Tab;
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  // Once a plan is live, the job every pay date is its contribution file: the oldest pay date with no file is the primary.
  const qc = useQueryClient();
  const dates = useQuery({ queryKey: ['retirement', 'pay-dates', plan?.id], queryFn: () => listPayDates(plan!.id), enabled: !!plan });
  const nextFile = [...(dates.data?.payDates ?? [])].filter((d) => !d.fileStatus).sort((a, b) => a.payDate.localeCompare(b.payDate))[0] ?? null;
  const makeFile = useMutation({
    mutationFn: (d: string) => makeContributionFile(plan!.id, d),
    onSuccess: () => {
      toast.success('Contribution file made. Send it or download it under Pay dates and files.');
      void qc.invalidateQueries({ queryKey: ['retirement'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <ListTemplate
      title="Retirement plans"
      subtitle="401(k) plans for each employer: who is in, what they save, the match, and the files your recordkeeper needs every pay date."
      actions={[
        ...(plan && nextFile
          ? [{ key: 'file', label: `Make the ${fmtDate(nextFile.payDate)} file`, primary: true, loading: makeFile.isPending, onSelect: () => makeFile.mutate(nextFile.payDate) }]
          : []),
        // No plan yet: setting one up is the page's job. With one live, adding another is occasional (F500 G3).
        { key: 'add', label: plans.length ? 'Add a plan' : 'Set up a plan', icon: Plus, primary: !plans.length, overflow: plans.length > 0, onSelect: () => setCreating(true) },
      ]}
      filters={
        plans.length > 1 ? (
          <Select size="sm" aria-label="Plan" className="w-72 max-w-full" value={planId ?? ''} onChange={(e) => setParam('plan', e.target.value)}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>{`${p.name}${p.employerName ? ` · ${p.employerName}` : ''}`}</option>
            ))}
          </Select>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="retirement plans" query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={6} />
      ) : !plan ? (
        <EmptyState icon={PiggyBank} title="No retirement plan yet" description="Set up your 401(k): who can join and when, auto-enrollment, the match, and which recordkeeper gets the files." action={<Button onClick={() => setCreating(true)}>Set up a plan</Button>} />
      ) : (
        <>
          <PlanSummary plan={plan} />
          <Tabs value={tab} onValueChange={(v) => setParam('tab', v === 'people' ? null : v)} className="mt-4">
            <div className="-mx-1 overflow-x-auto px-1">
              <TabsList>
                <TabsTrigger value="people">People</TabsTrigger>
                <TabsTrigger value="files">Pay dates and files</TabsTrigger>
                <TabsTrigger value="setup">Plan setup</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="people">
              <PeopleTab plan={plan} />
            </TabsContent>
            <TabsContent value="files">
              <FilesTab plan={plan} />
            </TabsContent>
            <TabsContent value="setup">
              <PlanForm key={plan.id} plan={plan} employers={q.data?.employers ?? []} recordkeepers={q.data?.recordkeepers ?? []} benefitsPlans={q.data?.benefitsPlans ?? []} />
              <ConnectionCard key={`c-${plan.id}`} plan={plan} />
            </TabsContent>
          </Tabs>
        </>
      )}
      {creating && (
        <Dialog open onOpenChange={(o) => !o && setCreating(false)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Set up a retirement plan</DialogTitle>
              <DialogDescription>Plans set up after December 29, 2022 must auto-enroll new hires (SECURE 2.0).</DialogDescription>
            </DialogHeader>
            <PlanForm
              plan={null}
              employers={q.data?.employers ?? []}
              recordkeepers={q.data?.recordkeepers ?? []}
              benefitsPlans={q.data?.benefitsPlans ?? []}
              onSaved={(id) => {
                setCreating(false);
                setParam('plan', id);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </ListTemplate>
  );
}

function PlanSummary({ plan }: { plan: RetirementPlan }) {
  const enrolled = (plan.counts.ENROLLED ?? 0) + (plan.counts.AUTO_ENROLLED ?? 0);
  const eligible = enrolled + (plan.counts.ELIGIBLE ?? 0) + (plan.counts.OPTED_OUT ?? 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Enrolled" value={String(enrolled)} hint={eligible ? `${Math.round((enrolled / eligible) * 100)}% of those eligible` : 'No one eligible yet'} />
        <MetricCard label="Eligible, not saving" value={String(plan.counts.ELIGIBLE ?? 0)} hint={plan.autoEnroll ? 'Auto-enroll after the opt-out window' : 'Waiting to choose'} />
        <MetricCard label="Opted out" value={String(plan.counts.OPTED_OUT ?? 0)} />
        <MetricCard label="Recordkeeper" value={<span className="text-lg">{plan.recordkeeperLabel}</span>} hint={plan.connection.hasSecret ? 'Connected' : 'Files download until connected'} />
      </div>
      <p className="text-sm text-ink-muted">{`${plan.employerName ?? 'All employers'} · ${matchText(plan)}${plan.autoEnroll ? ` · auto-enroll at ${plan.autoEnrollPercent}%${plan.autoEscalatePercent ? `, rising ${plan.autoEscalatePercent}% a year to ${plan.autoEscalateMax}%` : ''}` : ''}`}</p>
    </div>
  );
}

/* ----- People ---------------------------------------------------------------- */

function PeopleTab({ plan }: { plan: RetirementPlan }) {
  const term = useTerm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['retirement', 'elections', plan.id], queryFn: () => listElections(plan.id) });
  const [editing, setEditing] = useState<Election | null>(null);
  const [loanFor, setLoanFor] = useState(false);
  const sync = useMutation({
    mutationFn: () => syncPlan(plan.id),
    onSuccess: (r) => {
      toast.success(r.eligible + r.autoEnrolled + r.escalated ? `${r.eligible} newly eligible, ${r.autoEnrolled} auto-enrolled, ${r.escalated} rates raised.` : 'Everyone is up to date.');
      void qc.invalidateQueries({ queryKey: ['retirement'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const loanStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => setLoanStatus(id, status),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['retirement', 'elections', plan.id] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const loansBy = useMemo(() => {
    const m = new Map<string, Loan[]>();
    for (const l of q.data?.loans ?? []) m.set(l.associateId, [...(m.get(l.associateId) ?? []), l]);
    return m;
  }, [q.data]);
  const columns: GridColumn<Election>[] = [
    { key: 'name', header: term('worker'), primary: true, sortable: true, accessor: (e) => e.name, cell: (e) => <span className="font-medium text-ink">{e.name}</span> },
    { key: 'status', header: 'Status', sortable: true, accessor: (e) => STATUS[e.status][1], cell: (e) => <Badge variant={STATUS[e.status][0]}>{STATUS[e.status][1]}</Badge>, cardMeta: true },
    { key: 'pre', header: 'Pre-tax', align: 'right', sortable: true, searchable: false, accessor: (e) => e.preTaxPercent, cell: (e) => (e.flatAmountPerPay != null ? `${fmtMoney(e.flatAmountPerPay)} a check` : `${e.preTaxPercent}%`), className: 'tabular-nums' },
    { key: 'roth', header: 'Roth', align: 'right', sortable: true, searchable: false, accessor: (e) => e.rothPercent, cell: (e) => `${e.rothPercent}%`, className: 'tabular-nums' },
    {
      key: 'dates',
      header: 'Key date',
      searchable: false,
      accessor: (e) => e.optOutDeadline ?? e.eligibleOn ?? '',
      cell: (e) => (
        <span className="text-ink-muted">
          {e.status === 'NOT_ELIGIBLE' ? (e.eligibleOn ? `Eligible ${fmtDate(e.eligibleOn)}` : 'Birth or hire date missing') : e.status === 'ELIGIBLE' && plan.autoEnroll && e.optOutDeadline ? `Auto-enrolls ${fmtDate(e.optOutDeadline)}` : e.nextEscalationOn ? `Rises ${fmtDate(e.nextEscalationOn)}` : e.enrolledOn ? `Since ${fmtDate(e.enrolledOn)}` : '—'}
        </span>
      ),
    },
    {
      key: 'loans',
      header: 'Loans',
      searchable: false,
      accessor: (e) => loansBy.get(e.associateId)?.filter((l) => l.status === 'ACTIVE').length ?? 0,
      cell: (e) => {
        const active = (loansBy.get(e.associateId) ?? []).filter((l) => l.status === 'ACTIVE');
        return active.length ? <span className="tabular-nums">{active.map((l) => `${l.loanNumber} · ${fmtMoney(l.perPayAmount)}`).join(', ')}</span> : <span className="text-ink-muted">None</span>;
      },
    },
    { key: 'source', header: 'Last changed by', accessor: (e) => e.source, defaultHidden: true, cell: (e) => ({ EMPLOYEE: 'Employee', AUTO: 'Auto-enrollment', RECORDKEEPER: 'Recordkeeper', HR: 'HR' } as Record<string, string>)[e.source] ?? e.source },
  ];
  // People the plan can't place: no birth or hire date, so payroll can't tell when they may join (F500 G3: the real to-do is data).
  const noDates = (q.data?.elections ?? []).filter((e) => e.status === 'NOT_ELIGIBLE' && !e.eligibleOn);
  return (
    <div className="space-y-3">
      {noDates.length > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/[0.06] p-3 text-sm sm:flex-row sm:items-start" data-testid="retirement-missing-dates">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-ink">
              {noDates.length === 1 ? '1 person is missing a birth or hire date' : `${noDates.length} people are missing a birth or hire date`}, so the plan can’t tell when they may join.
            </p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
              {noDates.slice(0, 6).map((e) => (
                <Link key={e.id} to={`/people?associateId=${e.associateId}&tab=employment`} className="text-accent underline underline-offset-2">
                  {`Fix ${e.name}`}
                </Link>
              ))}
              {noDates.length > 6 && <span className="text-ink-muted">{`and ${noDates.length - 6} more`}</span>}
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => sync.mutate()} loading={sync.isPending}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Update eligibility now
        </Button>
        <Button size="sm" variant="outline" onClick={() => setLoanFor(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          Add a loan
        </Button>
        <DeferralChangesButton planId={plan.id} />
      </div>
      {q.isError ? (
        <QueryError what="plan members" query={q} />
      ) : (
        <DataGrid
          id="retirement-people"
          caption="Plan members"
          rows={q.data?.elections}
          loading={q.isLoading}
          columns={columns}
          rowKey={(e) => e.id}
          noun={{ one: 'person', many: 'people' }}
          onRowClick={(e) => e.status !== 'NOT_ELIGIBLE' && setEditing(e)}
          rowActionLabel={(e) => `Change ${e.name}’s savings rate`}
          expandable={{
            render: (e) => {
              const loans = loansBy.get(e.associateId) ?? [];
              if (!loans.length) return <p className="text-sm text-ink-muted">No loans.</p>;
              return (
                <ul className="space-y-1">
                  {loans.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="text-ink">{`Loan ${l.loanNumber}`}</span>
                      <span className="tabular-nums text-ink-muted">{`${fmtMoney(l.perPayAmount)} a paycheck${l.balance != null ? ` · ${fmtMoney(l.balance)} left` : ''}`}</span>
                      <Badge variant={l.status === 'ACTIVE' ? 'success' : 'default'}>{l.status === 'ACTIVE' ? 'Repaying' : l.status === 'PAID_OFF' ? 'Paid off' : l.status.toLowerCase()}</Badge>
                      {l.status === 'ACTIVE' && (
                        <Button size="sm" variant="ghost" onClick={() => loanStatus.mutate({ id: l.id, status: 'PAID_OFF' })}>Mark paid off</Button>
                      )}
                    </li>
                  ))}
                </ul>
              );
            },
          }}
          empty={{ icon: Users, title: 'No one in this plan yet', description: 'Update eligibility to add everyone who works for this employer.' }}
        />
      )}
      {editing && <ElectionDialog election={editing} rothEnabled={plan.rothEnabled} onClose={() => setEditing(null)} />}
      {loanFor && <LoanDialog planId={plan.id} onClose={() => setLoanFor(false)} />}
    </div>
  );
}

function ElectionDialog({ election, rothEnabled, onClose }: { election: Election; rothEnabled: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [pre, setPre] = useState(String(election.preTaxPercent));
  const [roth, setRoth] = useState(String(election.rothPercent));
  const m = useMutation({
    mutationFn: (status: 'ENROLLED' | 'OPTED_OUT') => changeElection(election.id, { status, preTaxPercent: Number(pre) || 0, rothPercent: rothEnabled ? Number(roth) || 0 : 0 }),
    onSuccess: () => {
      toast.success('Saved. The next payroll uses the new rate.');
      void qc.invalidateQueries({ queryKey: ['retirement'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`${election.name}’s savings rate`}</DialogTitle>
          <DialogDescription>A percent of each paycheck. Annual limits and catch-up are applied in payroll.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pre-tax, %">{(p) => <Input {...p} type="number" min="0" max="100" step="0.5" value={pre} onChange={(e) => setPre(e.target.value)} />}</Field>
          {rothEnabled && <Field label="Roth, %">{(p) => <Input {...p} type="number" min="0" max="100" step="0.5" value={roth} onChange={(e) => setRoth(e.target.value)} />}</Field>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => m.mutate('OPTED_OUT')} disabled={m.isPending}>Opt out</Button>
          <Button onClick={() => m.mutate('ENROLLED')} loading={m.isPending}>Save rate</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoanDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const [who, setWho] = useState<PickedAssociate | null>(null);
  const [f, setF] = useState({ loanNumber: '', perPayAmount: '', startDate: '', endDate: '', balance: '' });
  const m = useMutation({
    mutationFn: () => addLoan(planId, { associateId: who!.id, loanNumber: f.loanNumber, perPayAmount: Number(f.perPayAmount), startDate: f.startDate, endDate: f.endDate || null, balance: f.balance ? Number(f.balance) : null }),
    onSuccess: () => {
      toast.success('Loan added. Repayments start with the first payroll on or after the start date.');
      void qc.invalidateQueries({ queryKey: ['retirement', 'elections', planId] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a 401(k) loan</DialogTitle>
          <DialogDescription>Use the loan number and repayment the recordkeeper sent. Repayments go in the contribution file with the loan number.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={term('worker')} required className="sm:col-span-2">{(p) => <AssociatePicker {...p} value={who} onChange={setWho} />}</Field>
          <Field label="Loan number" required>{(p) => <Input {...p} value={f.loanNumber} onChange={(e) => setF({ ...f, loanNumber: e.target.value })} />}</Field>
          <Field label="Repayment each paycheck" required>{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.perPayAmount} onChange={(e) => setF({ ...f, perPayAmount: e.target.value })} />}</Field>
          <Field label="First repayment" required>{(p) => <Input {...p} type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />}</Field>
          <Field label="Last repayment">{(p) => <Input {...p} type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />}</Field>
          <Field label="Balance">{(p) => <Input {...p} type="number" min="0" step="0.01" value={f.balance} onChange={(e) => setF({ ...f, balance: e.target.value })} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!who || !f.loanNumber || !(Number(f.perPayAmount) > 0) || !f.startDate}>Add loan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeferralChangesButton({ planId }: { planId: string }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const m = useMutation({
    mutationFn: async (file: File) => uploadDeferralChanges(planId, await file.text()),
    onSuccess: (r) => {
      const extra = [r.unmatched.length ? `${r.unmatched.length} not matched (${r.unmatched.slice(0, 3).join(', ')})` : '', r.skipped.length ? `${r.skipped.length} skipped` : ''].filter(Boolean).join(' · ');
      toast.success(`${r.applied} ${r.applied === 1 ? 'rate' : 'rates'} updated.${extra ? ` ${extra}.` : ''}`);
      void qc.invalidateQueries({ queryKey: ['retirement'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".csv,.txt,text/csv,text/plain"
        className="sr-only"
        aria-label="Choose a deferral change file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) m.mutate(file);
          e.target.value = '';
        }}
      />
      <Button size="sm" variant="outline" onClick={() => ref.current?.click()} loading={m.isPending}>
        <Upload className="h-4 w-4" aria-hidden />
        Rate changes from the recordkeeper
      </Button>
    </>
  );
}

/* ----- Pay dates and files ------------------------------------------------ */

const FILE_KIND: Record<RetirementFile['kind'], string> = { CONTRIBUTION: 'Contributions', CENSUS: 'Census', TRUE_UP: 'Year-end true-up' };

function FilesTab({ plan }: { plan: RetirementPlan }) {
  const qc = useQueryClient();
  const dates = useQuery({ queryKey: ['retirement', 'pay-dates', plan.id], queryFn: () => listPayDates(plan.id) });
  const files = useQuery({ queryKey: ['retirement', 'files', plan.id], queryFn: () => listPlanFiles(plan.id) });
  const [year, setYear] = useState(String(new Date().getFullYear() - (new Date().getMonth() < 3 ? 1 : 0)));
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: ['retirement'] });
  };
  const fail = (e: Error) => toast.error(e.message);
  const contrib = useMutation({ mutationFn: (d: string) => makeContributionFile(plan.id, d), onSuccess: () => done('Contribution file made. Send it or download it.'), onError: fail });
  const census = useMutation({ mutationFn: () => makeCensusFile(plan.id), onSuccess: () => done('Census made.'), onError: fail });
  const trueUp = useMutation({
    mutationFn: () => makeTrueUpFile(plan.id, Number(year)),
    onSuccess: (r) => (r.file ? done(`True-up file made: ${r.owed.length} ${r.owed.length === 1 ? 'person is' : 'people are'} owed ${fmtMoney(r.owed.reduce((s, o) => s + o.amount, 0))}.`) : toast.success(r.message ?? 'No one is owed a true-up.')),
    onError: fail,
  });
  const send = useMutation({ mutationFn: sendPlanFile, onSuccess: () => done('Sent to the recordkeeper.'), onError: (e: Error) => { fail(e); void qc.invalidateQueries({ queryKey: ['retirement', 'files', plan.id] }); } });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Pay dates</CardTitle>
          <CardDescription>What each payroll withheld and the employer added. Make the file for each pay date; the recordkeeper invests from it.</CardDescription>
        </CardHeader>
        <CardContent>
          {dates.isError ? (
            <QueryError what="pay dates" query={dates} />
          ) : dates.isLoading ? (
            <SkeletonRows count={3} />
          ) : !dates.data?.payDates.length ? (
            <EmptyState size="sm" icon={PiggyBank} title="No contributions yet" description="They appear after the first payroll for someone enrolled." />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {dates.data.payDates.map((d) => (
                <li key={d.payDate} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{fmtDate(d.payDate)}</p>
                    <p className="text-sm text-ink-muted">{`${d.people} ${d.people === 1 ? 'person' : 'people'} · employees ${fmtMoney(d.employee)} · employer ${fmtMoney(d.employer)}`}</p>
                  </div>
                  {d.fileStatus && <Badge variant={d.fileStatus === 'SENT' ? 'success' : d.fileStatus === 'FAILED' ? 'destructive' : 'pending'}>{d.fileStatus === 'SENT' ? 'Sent' : d.fileStatus === 'FAILED' ? 'Not sent' : 'File made'}</Badge>}
                  <Button size="sm" variant={d.fileStatus ? 'ghost' : 'primary'} onClick={() => contrib.mutate(d.payDate)} loading={contrib.isPending && contrib.variables === d.payDate}>
                    {d.fileStatus ? 'Make again' : 'Make file'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Census</CardTitle>
            <CardDescription>Everyone in the plan with hire and birth dates, pay and hours so far this year. Recordkeepers ask for it at setup and each year for testing.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => census.mutate()} loading={census.isPending}>Make the census</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Year-end true-up</CardTitle>
            <CardDescription>Match someone missed by reaching the limit early, worked on the whole year’s pay.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <Field label="Plan year" className="w-32">{(p) => <Input {...p} type="number" value={year} onChange={(e) => setYear(e.target.value)} />}</Field>
            <Button variant="outline" onClick={() => trueUp.mutate()} loading={trueUp.isPending}>Work out the true-up</Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
          <CardDescription>{plan.connection.hasSecret ? `Sent to ${plan.recordkeeperLabel} by ${plan.transport === 'SFTP' ? 'SFTP' : 'secure upload'}.` : 'Not connected yet: download each file and upload it on the recordkeeper’s site.'}</CardDescription>
        </CardHeader>
        <CardContent>
          {files.isError ? (
            <QueryError what="files" query={files} />
          ) : (
            <DataGrid
              id="retirement-files"
              caption="Recordkeeper files"
              rows={files.data?.files}
              loading={files.isLoading}
              rowKey={(f) => f.id}
              noun={{ one: 'file', many: 'files' }}
              search={false}
              columns={[
                { key: 'kind', header: 'File', primary: true, accessor: (f) => FILE_KIND[f.kind], cell: (f) => <div><p className="font-medium text-ink">{FILE_KIND[f.kind]}</p><p className="text-xs text-ink-muted">{f.payDate ? `Pay date ${fmtDate(f.payDate)}` : `Made ${fmtDate(f.createdAt)}`}</p></div> },
                { key: 'rows', header: 'People', align: 'right', searchable: false, accessor: (f) => f.rowCount, className: 'tabular-nums' },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (f) => f.status,
                  cardMeta: true,
                  cell: (f) => (
                    <div>
                      <Badge variant={f.status === 'SENT' ? 'success' : f.status === 'FAILED' ? 'destructive' : 'pending'}>{f.status === 'SENT' ? 'Sent' : f.status === 'FAILED' ? 'Not sent' : 'Ready'}</Badge>
                      {f.error && <p className="mt-1 max-w-xs text-xs text-ink-muted">{f.error}</p>}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  searchable: false,
                  stopRowClick: true,
                  accessor: () => '',
                  cell: (f) => (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => void downloadPlanFile(f.id).catch(fail)} aria-label={`Download the ${FILE_KIND[f.kind].toLowerCase()} file`}>
                        <Download className="h-4 w-4" aria-hidden />
                      </Button>
                      {f.status !== 'SENT' && (
                        <Button size="sm" variant="outline" onClick={() => send.mutate(f.id)} loading={send.isPending && send.variables === f.id}>
                          <Send className="h-4 w-4" aria-hidden />
                          Send
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
              empty={{ icon: FileUp, title: 'No files yet', description: 'Make a contribution file from a pay date above.' }}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ----- Plan setup ------------------------------------------------------------ */

function blank(): PlanInput {
  return {
    name: '',
    planNumber: null,
    employerId: null,
    benefitsPlanId: null,
    recordkeeper: 'GUIDELINE',
    status: 'ACTIVE',
    establishedOn: null,
    eligibilityMinAge: 21,
    eligibilityServiceDays: 0,
    entryTiming: 'IMMEDIATE',
    autoEnroll: true,
    autoEnrollPercent: 3,
    autoEscalatePercent: 1,
    autoEscalateMax: 10,
    optOutDays: 30,
    matchFormula: [],
    safeHarbor: 'NONE',
    rothEnabled: true,
    catchUpEnabled: true,
  };
}

function PlanForm({ plan, employers, recordkeepers, benefitsPlans, onSaved }: { plan: RetirementPlan | null; employers: Array<{ id: string; name: string }>; recordkeepers: Array<{ id: string; label: string }>; benefitsPlans: Array<{ id: string; name: string }>; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<PlanInput>(() => (plan ? { ...plan } : blank()));
  const set = <K extends keyof PlanInput>(k: K, v: PlanInput[K]) => setF((p) => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => (plan ? updatePlan(plan.id, f) : createPlan(f)),
    onSuccess: (r) => {
      toast.success(plan ? 'Plan saved.' : 'Plan set up. Update eligibility to bring people in.');
      void qc.invalidateQueries({ queryKey: ['retirement'] });
      onSaved?.(r.plan.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const n = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <Card className={plan ? '' : 'border-0 bg-transparent shadow-none'}>
      {plan && (
        <CardHeader>
          <CardTitle>Plan rules</CardTitle>
          <CardDescription>Changes apply from the next payroll and the next eligibility update.</CardDescription>
        </CardHeader>
      )}
      <CardContent className={plan ? 'space-y-5' : 'space-y-5 p-0'}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan name" required>{(p) => <Input {...p} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Acme 401(k) Plan" />}</Field>
          <Field label="Plan number" hint="From the recordkeeper">{(p) => <Input {...p} value={f.planNumber ?? ''} onChange={(e) => set('planNumber', e.target.value || null)} />}</Field>
          <Field label="Employer of record">
            {(p) => (
              <Select {...p} value={f.employerId ?? ''} onChange={(e) => set('employerId', e.target.value || null)}>
                <option value="">Everyone, all employers</option>
                {employers.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Deductions come from" required hint={benefitsPlans.length ? 'The 401(k) plan on the Benefits page. Each person’s rate is their election there.' : 'Add a 401(k) plan on the Benefits page first.'}>
            {(p) => (
              <Select {...p} value={f.benefitsPlanId ?? ''} onChange={(e) => set('benefitsPlanId', e.target.value || null)}>
                <option value="">Choose a 401(k) benefits plan…</option>
                {benefitsPlans.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Recordkeeper" required>
            {(p) => (
              <Select {...p} value={f.recordkeeper} onChange={(e) => set('recordkeeper', e.target.value as PlanInput['recordkeeper'])}>
                {recordkeepers.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Plan set up on" hint="Plans after December 29, 2022 must auto-enroll">{(p) => <Input {...p} type="date" value={f.establishedOn ?? ''} onChange={(e) => set('establishedOn', e.target.value || null)} />}</Field>
          {plan && (
            <Field label="Status">
              {(p) => (
                <Select {...p} value={f.status} onChange={(e) => set('status', e.target.value as PlanInput['status'])}>
                  <option value="ACTIVE">Active</option>
                  <option value="FROZEN">Frozen: no new contributions</option>
                  <option value="TERMINATED">Ended</option>
                </Select>
              )}
            </Field>
          )}
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Who can join</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Minimum age">{(p) => <Input {...p} type="number" min="0" max="21" value={f.eligibilityMinAge} onChange={(e) => set('eligibilityMinAge', n(e.target.value))} />}</Field>
            <Field label="Days of service">{(p) => <Input {...p} type="number" min="0" max="365" value={f.eligibilityServiceDays} onChange={(e) => set('eligibilityServiceDays', n(e.target.value))} />}</Field>
            <Field label="Joins on">
              {(p) => (
                <Select {...p} value={f.entryTiming} onChange={(e) => set('entryTiming', e.target.value as PlanInput['entryTiming'])}>
                  <option value="IMMEDIATE">The day they qualify</option>
                  <option value="MONTHLY">The first of the next month</option>
                  <option value="QUARTERLY">The next quarter</option>
                </Select>
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Auto-enrollment</legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4 accent-gold" checked={f.autoEnroll} onChange={(e) => set('autoEnroll', e.target.checked)} />
            Enroll people automatically unless they opt out
          </label>
          {f.autoEnroll && (
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Starting rate, %" hint="3–10%">{(p) => <Input {...p} type="number" min="0" max="15" step="0.5" value={f.autoEnrollPercent} onChange={(e) => set('autoEnrollPercent', n(e.target.value))} />}</Field>
              <Field label="Rises each year, %">{(p) => <Input {...p} type="number" min="0" max="5" step="0.5" value={f.autoEscalatePercent} onChange={(e) => set('autoEscalatePercent', n(e.target.value))} />}</Field>
              <Field label="Up to, %" hint="10–15%">{(p) => <Input {...p} type="number" min="0" max="15" step="0.5" value={f.autoEscalateMax} onChange={(e) => set('autoEscalateMax', n(e.target.value))} />}</Field>
              <Field label="Days to opt out">{(p) => <Input {...p} type="number" min="0" max="90" value={f.optOutDays} onChange={(e) => set('optOutDays', n(e.target.value))} />}</Field>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Employer money</legend>
          <Field label="Kind">
            {(p) => (
              <Select {...p} value={f.safeHarbor} onChange={(e) => set('safeHarbor', e.target.value as PlanInput['safeHarbor'])}>
                {Object.entries(SAFE_HARBOR).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            )}
          </Field>
          {f.safeHarbor === 'NONE' && (
            <div className="space-y-2">
              {f.matchFormula.map((t, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field label={i === 0 ? 'Match, %' : 'Then match, %'} className="w-32">{(p) => <Input {...p} type="number" min="0" max="200" value={t.matchPercent} onChange={(e) => set('matchFormula', f.matchFormula.map((x, j) => (j === i ? { ...x, matchPercent: n(e.target.value) } : x)))} />}</Field>
                  <Field label="of deferrals up to, % of pay" className="w-48">{(p) => <Input {...p} type="number" min="0" max="100" step="0.5" value={t.upToPercent} onChange={(e) => set('matchFormula', f.matchFormula.map((x, j) => (j === i ? { ...x, upToPercent: n(e.target.value) } : x)))} />}</Field>
                  <Button size="sm" variant="ghost" aria-label="Remove this tier" onClick={() => set('matchFormula', f.matchFormula.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
              {f.matchFormula.length < 5 && (
                <Button size="sm" variant="outline" onClick={() => set('matchFormula', [...f.matchFormula, { matchPercent: f.matchFormula.length ? 50 : 100, upToPercent: (f.matchFormula[f.matchFormula.length - 1]?.upToPercent ?? 0) + (f.matchFormula.length ? 2 : 3) }])}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add a match tier
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="h-4 w-4 accent-gold" checked={f.rothEnabled} onChange={(e) => set('rothEnabled', e.target.checked)} />
              Roth savings allowed
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" className="h-4 w-4 accent-gold" checked={f.catchUpEnabled} onChange={(e) => set('catchUpEnabled', e.target.checked)} />
              Catch-up for 50 and older
            </label>
          </div>
        </fieldset>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={f.name.trim().length < 2 || !f.benefitsPlanId}>{plan ? 'Save plan' : 'Set up plan'}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectionCard({ plan }: { plan: RetirementPlan }) {
  const qc = useQueryClient();
  const sftp = plan.transport === 'SFTP';
  const [f, setF] = useState({ baseUrl: plan.connection.baseUrl ?? '', apiKey: '', host: plan.connection.host ?? '', port: '22', username: plan.connection.username ?? '', password: '', privateKey: '', remoteDir: plan.connection.remoteDir ?? '' });
  const m = useMutation({
    mutationFn: () =>
      savePlanConnection(
        plan.id,
        sftp
          ? { host: f.host || undefined, port: Number(f.port) || 22, username: f.username || undefined, password: f.password || undefined, privateKey: f.privateKey || undefined, remoteDir: f.remoteDir || undefined }
          : { baseUrl: f.baseUrl || undefined, apiKey: f.apiKey || undefined },
      ),
    onSuccess: () => {
      toast.success('Connection saved. Secrets are stored encrypted.');
      setF((p) => ({ ...p, apiKey: '', password: '', privateKey: '' }));
      void qc.invalidateQueries({ queryKey: ['retirement', 'plans'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>{`Connection to ${plan.recordkeeperLabel}`}</CardTitle>
        <CardDescription>{plan.connection.hasSecret ? 'Connected. Leave a secret blank to keep the one saved.' : 'Until this is filled in, files are downloaded and uploaded by hand.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sftp ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SFTP host">{(p) => <Input {...p} value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="sftp.recordkeeper.com" />}</Field>
            <Field label="Port">{(p) => <Input {...p} type="number" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />}</Field>
            <Field label="User name">{(p) => <Input {...p} value={f.username} autoComplete="off" onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
            <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder={plan.connection.hasSecret ? 'Saved' : ''} />}</Field>
            <Field label="Folder">{(p) => <Input {...p} value={f.remoteDir} onChange={(e) => setF({ ...f, remoteDir: e.target.value })} placeholder="/inbound" />}</Field>
            <Field label="Private key, instead of a password" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={f.privateKey} onChange={(e) => setF({ ...f, privateKey: e.target.value })} placeholder={plan.connection.hasSecret ? 'Saved' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />}</Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="File upload address" hint="Starts with https://">{(p) => <Input {...p} value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />}</Field>
            <Field label="API key">{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} placeholder={plan.connection.hasSecret ? 'Saved' : ''} />}</Field>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => m.mutate()} loading={m.isPending}>Save connection</Button>
        </div>
      </CardContent>
    </Card>
  );
}
