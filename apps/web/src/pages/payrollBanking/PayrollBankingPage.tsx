import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Banknote, Building2, CheckCircle2, Info, Landmark } from 'lucide-react';
import {
  centsToMoney,
  clockText,
  etDeadline,
  fundingSentence,
  getBankingSummary,
  pullFunding,
  recordWire,
  shortDay,
  type BankingSummary,
  type FundingStatus,
  type RunToFund,
} from '@/lib/bankingApi';
import { ListTemplate } from '@/components/templates';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { FundingBadge, FundingBreakdownList } from './FundingCard';
import { AccountsTab } from './AccountsTab';
import { DepositsTab } from './DepositsTab';
import { FilesTab } from './FilesTab';
import { CalendarTab } from './CalendarTab';
import { SetupTab } from './SetupTab';

/**
 * Payroll banking — the money behind each run when payroll pays bank
 * accounts through the company's own ACH: what to fund and by when, the
 * operating account it comes from, every file sent to the bank and what
 * came back, employee accounts and their prenotes, and the payroll
 * calendar. Built on the list template with tabs.
 */

type Tab = 'funding' | 'accounts' | 'deposits' | 'files' | 'calendar' | 'setup';
const TABS: Tab[] = ['funding', 'accounts', 'deposits', 'files', 'calendar', 'setup'];

const RAIL_LABEL: Record<string, string> = {
  PLATFORM: 'the platform’s payout provider',
  BRANCH: 'Branch',
  WISE: 'Wise',
  CHECK: 'paper check',
  ACH: 'your own ACH',
};

export function PayrollBankingPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'funding') as Tab;
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === 'funding') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const summary = useQuery({ queryKey: ['payroll-banking', 'summary'], queryFn: getBankingSummary });

  return (
    <ListTemplate
      title="Payroll banking"
      subtitle="The money behind each payroll: what to fund and by when, the account it comes from, and every file sent to the bank."
      breadcrumbs={[{ label: 'Pay & finance' }, { label: 'Payroll banking' }]}
      summary={summary.data ? <StatusBanner s={summary.data} onSetup={() => setTab('setup')} /> : null}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList>
            <TabsTrigger value="funding">Funding</TabsTrigger>
            <TabsTrigger value="accounts">Bank accounts</TabsTrigger>
            <TabsTrigger value="deposits">Direct deposit</TabsTrigger>
            <TabsTrigger value="files">ACH files</TabsTrigger>
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="setup">Setup</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="funding">
          <FundingTab query={summary} onTab={setTab} highlightRun={params.get('run')} />
        </TabsContent>
        <TabsContent value="accounts">
          <AccountsTab summary={summary.data} />
        </TabsContent>
        <TabsContent value="deposits">
          <DepositsTab requirePrenote={summary.data?.profile.requirePrenote ?? true} onAch={summary.data?.profile.bankRail === 'ACH'} />
        </TabsContent>
        <TabsContent value="files">
          <FilesTab inHouse={!summary.data?.connection} />
        </TabsContent>
        <TabsContent value="calendar">
          <CalendarTab />
        </TabsContent>
        <TabsContent value="setup">
          {summary.data ? <SetupTab summary={summary.data} /> : summary.isError ? <QueryError what="payroll banking" query={summary} /> : <SkeletonRows count={6} />}
        </TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/* ----- What mode we're in, and what's left to set up ------------------------------ */

function StatusBanner({ s, onSetup }: { s: BankingSummary; onSetup: () => void }) {
  const p = s.profile;
  if (p.bankRail !== 'ACH') {
    return (
      <Card className="border-steel/40 bg-steel/5">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-sky" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">{`Bank-account pay goes through ${RAIL_LABEL[p.bankRail] ?? p.bankRail}`}</p>
            <p className="text-sm text-ink-muted">Switch to your own ACH to pull payroll from your operating account, send one file per run, and handle returns here.</p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" onClick={onSetup}>
            Set up your own ACH
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (p.gaps.length) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink">Finish setup before payroll can be sent</p>
            <p className="text-sm text-ink-muted">{`Still needed: ${p.gaps.join('; ')}.`}</p>
          </div>
          <Button size="sm" className="shrink-0" onClick={onSetup}>
            Finish setup
          </Button>
        </CardContent>
      </Card>
    );
  }
  const live = s.connection?.environment === 'PRODUCTION';
  if (live && p.kybStatus !== 'APPROVED') {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="flex items-start gap-3 py-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <p className="font-medium text-ink">Your bank hasn’t approved this employer yet</p>
            <p className="text-sm text-ink-muted">Live payroll can’t be pulled until the business check (KYB) is approved. Record the result in Setup when your bank confirms it.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border-success/30 bg-success/5">
      <CardContent className="flex items-start gap-3 py-4">
        {s.connection ? <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden /> : <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />}
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {s.connection ? `Sent through ${s.connection.name}${s.connection.environment === 'SANDBOX' ? ' (sandbox)' : ''}` : 'Files for your own bank'}
          </p>
          <p className="text-sm text-ink-muted">
            {s.connection
              ? 'Each entry goes to your bank partner as it’s made; returns and corrections come back on their own.'
              : 'Download each file from ACH files and upload it to your bank’s portal before its cutoff. Upload the return file your bank sends back so returns and corrections are applied.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ----- Funding ----------------------------------------------------------------------- */

const canPull = (st: FundingStatus) => st === 'NOT_STARTED' || st === 'DRAFT' || st === 'RETURNED';

function FundingTab({ query, onTab, highlightRun }: { query: ReturnType<typeof useQuery<BankingSummary>>; onTab: (t: Tab) => void; highlightRun: string | null }) {
  const [wiring, setWiring] = useState<{ run: RunToFund; state: 'WIRE_PENDING' | 'WIRE_RECEIVED' } | null>(null);
  if (query.isError) return <QueryError what="payroll funding" query={query} />;
  if (query.isLoading || !query.data) return <SkeletonRows count={5} />;
  const s = query.data;
  if (s.profile.bankRail !== 'ACH') {
    return <EmptyState icon={Banknote} title="Nothing to fund here" description="Funding applies when payroll pays bank accounts through your own ACH. Turn it on in Setup." action={<Button size="sm" variant="outline" onClick={() => onTab('setup')}>Open setup</Button>} />;
  }
  const account = s.accounts.find((a) => a.id === s.profile.fundingAccountId) ?? null;
  const next = s.runs.find((r) => canPull(r.funding.status));
  const speed = s.profile.achSpeed === 'SAME_DAY' ? 'Same day' : s.profile.achSpeed === 'TWO_DAY' ? 'Two days' : 'Next day';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="To fund next" value={next ? centsToMoney(next.funding.amountCents) : '—'} hint={next ? `By ${etDeadline(next.funding.fundingDeadline)}` : 'Every approved run is funded'} accent={!!next && new Date(next.funding.fundingDeadline) < new Date()} />
        <MetricCard label="Pulled from" value={account ? `····${account.accountLast4}` : 'Not chosen'} hint={account ? account.label : 'Add and verify an account'} accent={!account} />
        <MetricCard label="Came back (30 days)" value={String(s.openReturns)} hint="Returned entries" accent={s.openReturns > 0} />
        <MetricCard label="Speed" value={speed} hint={`Bank cutoff ${clockText(s.profile.submitCutoffEt)} ET`} />
      </div>
      {!account && (
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <AlertTriangle className="h-5 w-5 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 flex-1 text-sm text-ink">Payroll needs a verified operating account to pull from.</p>
            <Button size="sm" onClick={() => onTab('accounts')}>Add an account</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Runs to fund</CardTitle>
          <CardDescription>Approved runs, oldest first. Pay goes out only after the money settles.</CardDescription>
        </CardHeader>
        <CardContent>
          {s.runs.length === 0 ? (
            <EmptyState size="sm" icon={CheckCircle2} title="No runs waiting for money" description="A run appears here once it’s finalized." action={<Button asChild size="sm" variant="outline"><Link to="/payroll">Open payroll</Link></Button>} />
          ) : (
            <ul className="divide-y divide-navy-secondary">
              {s.runs.map((r) => (
                <RunRow key={r.runId} r={r} highlight={r.runId === highlightRun} canFund={!!account && s.profile.gaps.length === 0} onWire={(state) => setWiring({ run: r, state })} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {wiring && <WireDialog run={wiring.run} state={wiring.state} onClose={() => setWiring(null)} />}
    </div>
  );
}

function RunRow({ r, highlight, canFund, onWire }: { r: RunToFund; highlight: boolean; canFund: boolean; onWire: (state: 'WIRE_PENDING' | 'WIRE_RECEIVED') => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(highlight);
  const f = r.funding;
  const pull = useMutation({
    mutationFn: () => pullFunding(r.runId),
    onSuccess: (x) => {
      toast.success(x.pending ? 'Over a funding limit — sent to a second person to approve.' : `${centsToMoney(x.funding.amountCents)} is on its way from your account.`);
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <li className={cn('py-3', highlight && 'rounded-md bg-gold/5 px-2')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-medium text-ink">{`${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}${r.clientName ? ` · ${r.clientName}` : ''}`}</p>
          <p className="text-sm text-ink-muted">{fundingSentence(f)}</p>
        </div>
        <FundingBadge status={f.status} />
        <span className="tabular-nums font-medium text-ink">{centsToMoney(f.amountCents)}</span>
        <div className="flex flex-wrap gap-1.5">
          {canPull(f.status) && (
            <Button size="sm" onClick={() => pull.mutate()} loading={pull.isPending} disabled={!canFund} aria-label={`Pull ${centsToMoney(f.amountCents)} for pay on ${shortDay(f.payDate)}`}>
              {f.status === 'RETURNED' ? 'Pull again' : 'Pull funds'}
            </Button>
          )}
          {(f.status === 'RETURNED' || canPull(f.status)) && f.id && (
            <Button size="sm" variant="outline" onClick={() => onWire('WIRE_PENDING')}>
              Wire instead
            </Button>
          )}
          {f.status === 'WIRE_PENDING' && (
            <Button size="sm" onClick={() => onWire('WIRE_RECEIVED')}>
              Wire received
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide details' : 'Details'}
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <FundingBreakdownList f={f} />
          <dl className="mt-3 space-y-1 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Pull by</dt><dd className="text-ink">{etDeadline(f.fundingDeadline)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Debit settles</dt><dd className="text-ink">{shortDay(f.debitEffectiveDate)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-muted">Pay lands</dt><dd className="text-ink">{shortDay(f.payDate)}</dd></div>
            {f.note && <p className="pt-1 text-xs text-ink-muted">{f.note}</p>}
          </dl>
        </div>
      )}
    </li>
  );
}

function WireDialog({ run, state, onClose }: { run: RunToFund; state: 'WIRE_PENDING' | 'WIRE_RECEIVED'; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const amount = centsToMoney(run.funding.amountCents);
  const save = useMutation({
    mutationFn: () => recordWire(run.runId, state, note.trim()),
    onSuccess: () => {
      toast.success(state === 'WIRE_RECEIVED' ? 'Wire recorded. Pay can go out now.' : 'Noted. Mark the wire received when it lands.');
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state === 'WIRE_RECEIVED' ? `Record the ${amount} wire` : `Wire ${amount} instead`}</DialogTitle>
          <DialogDescription>
            {state === 'WIRE_RECEIVED'
              ? 'Only record it once the money is in the account your bank settles payroll from. This releases pay.'
              : `Send ${amount} by wire to the account your bank settles payroll from, before ${shortDay(run.funding.payDate)}. Pay stays held until you record that it arrived.`}
          </DialogDescription>
        </DialogHeader>
        <Field label={state === 'WIRE_RECEIVED' ? 'Wire reference (Fed reference or IMAD)' : 'Note'} required hint={state === 'WIRE_RECEIVED' ? 'From your bank’s incoming wire report.' : 'Who is sending it and when.'}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!note.trim()}>
            {state === 'WIRE_RECEIVED' ? 'Record wire' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

