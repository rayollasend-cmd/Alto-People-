import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPinHouse } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  acknowledgeJurisdiction,
  calculateJurisdiction,
  getJurisdictions,
  getReciprocity,
  revokeJurisdiction,
  type JurisdictionKind,
  type JurisdictionRow,
  type PayFrequency,
  type ReviewStatus,
} from '@/lib/taxJurisdictionsApi';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useUrlParam } from '@/lib/useUrlState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Tax jurisdictions: the cities, counties, school districts and transit
 * districts payroll withholds for (lib/taxEngine), which ones apply to the
 * people on payroll, and the review each needs. A jurisdiction starts
 * "awaiting review" and blocks payroll for anyone it applies to until a
 * payroll admin confirms its rate was reviewed with the company's tax
 * adviser — the drawer shows the source and a paycheck calculator.
 */

export const KIND_LABEL: Record<JurisdictionKind, string> = {
  LOCAL: 'Local income tax',
  SCHOOL: 'School district',
  TRANSIT: 'Transit',
  OLT: 'Occupational tax',
  EMPLOYER: 'Employer-paid',
};
const REVIEW_LABEL: Record<ReviewStatus, string> = { reviewed: 'Reviewed', outdated: 'Review again', awaiting: 'Awaiting review' };
const REVIEW_TONE: Record<ReviewStatus, 'success' | 'pending' | 'default'> = { reviewed: 'success', outdated: 'pending', awaiting: 'pending' };
const CONFIDENCE_LABEL: Record<JurisdictionRow['confidence'], string> = {
  high: 'Published rate',
  medium: 'Published rate, check the details',
  low: 'Approximated — check against the jurisdiction',
};

type Filter = 'attention' | 'in-use' | 'all';
const FILTERS: readonly Filter[] = ['attention', 'in-use', 'all'];

/**
 * Tax tables › Local. (It was its own page, /payroll/tax-jurisdictions, with
 * the reciprocity table and the hand-set rules form underneath; those are
 * tabs of their own now — F500 G3.)
 */
export function LocalTaxTables() {
  const term = useTerm();
  const { can } = useAuth();
  const workers = term('workers').toLowerCase();
  const [filter, setFilter] = useUrlParam<Filter>('filter', 'attention', FILTERS);
  const [open, setOpen] = useState<JurisdictionRow | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'tax-jurisdictions'], queryFn: getJurisdictions });
  const rows = useMemo(() => {
    const all = q.data?.jurisdictions ?? [];
    if (filter === 'attention') return all.filter((j) => j.workers > 0 && j.review.status !== 'reviewed');
    if (filter === 'in-use') return all.filter((j) => j.workers > 0);
    return all;
  }, [q.data, filter]);

  const columns: GridColumn<JurisdictionRow>[] = [
    {
      key: 'name',
      header: 'Jurisdiction',
      accessor: (r) => r.name,
      cell: (r) => (
        <span>
          <span className="text-ink">{r.name}</span>
          <span className="ml-1.5 text-xs text-ink-muted">{r.state}</span>
        </span>
      ),
      primary: true,
      sortable: true,
    },
    { key: 'kind', header: 'Type', accessor: (r) => KIND_LABEL[r.kind], cardMeta: true },
    { key: 'rate', header: 'Rate', accessor: (r) => r.rate, cell: (r) => <span className="tabular-nums">{r.rate}</span> },
    {
      key: 'workers',
      header: term('workers'),
      accessor: (r) => r.workers,
      cell: (r) => (r.workers ? <span className="tabular-nums">{r.workers}</span> : <span className="text-ink-muted">—</span>),
      align: 'right',
      sortable: true,
    },
    {
      key: 'review',
      header: 'Review',
      accessor: (r) => REVIEW_LABEL[r.review.status],
      cell: (r) => <Badge variant={REVIEW_TONE[r.review.status]}>{REVIEW_LABEL[r.review.status]}</Badge>,
      cardMeta: true,
    },
    {
      key: 'source',
      header: 'Rate source',
      accessor: (r) => r.confidence,
      cell: (r) => <span className="text-xs text-ink-muted">{r.taxYear} · {r.confidence === 'low' ? 'approximated' : 'published'}</span>,
      defaultHidden: true,
    },
  ];

  const counts = q.data?.counts;
  const engine = q.data?.engine;
  return (
    <div className="space-y-[var(--d-stack)]">
      {counts ? (
        <MetricStrip label="Local taxes at a glance">
          <MetricCard label="In use" value={counts.inUse} hint={`jurisdictions your ${workers} owe`} onClick={() => setFilter('in-use')} selected={filter === 'in-use'} />
          <MetricCard label="Awaiting review" value={counts.awaitingInUse} hint="in use, not yet signed off" tone={counts.awaitingInUse > 0 ? 'warning' : 'default'} onClick={() => setFilter('attention')} selected={filter === 'attention'} />
          <MetricCard
            label="Blocked from payroll"
            value={counts.blockedWorkers}
            nothing={counts.blockedWorkers === 0 ? 'Nobody is blocked' : undefined}
            hint={`${workers} owing a jurisdiction not yet reviewed`}
            tone={counts.blockedWorkers > 0 ? 'alert' : 'default'}
          />
          <MetricCard
            label="Questions to answer"
            value={counts.unresolvedWorkers}
            nothing={counts.unresolvedWorkers === 0 ? 'Every home jurisdiction is known' : undefined}
            hint={`${workers} whose home jurisdiction isn’t known`}
            tone={counts.unresolvedWorkers > 0 ? 'warning' : 'default'}
          />
        </MetricStrip>
      ) : (
        <Skeleton className="h-24" />
      )}
      {engine && (
        <p className="text-sm text-ink-muted">
          {engine.key === 'IN_HOUSE' ? (
            <>Worked out by the built-in tax engine. </>
          ) : (
            <>
              Worked out by {engine.label}
              {engine.environment === 'SANDBOX' ? ' (sandbox)' : ''}; if it doesn’t answer, the built-in engine steps in and the run says so.{' '}
            </>
          )}
          {/* Named for what it opens, and only for someone who can open it. */}
          {can('view:integrations') && (
            <Link to="/integrations" className="text-accent underline-offset-2 hover:underline">
              Change the tax engine in Integrations
            </Link>
          )}
        </p>
      )}
      <SegmentedControl
        className="flex-wrap"
        ariaLabel="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'attention', label: 'Needs review' },
          { value: 'in-use', label: 'In use' },
          { value: 'all', label: 'Every jurisdiction' },
        ]}
      />
      {q.data && q.data.unresolved.length > 0 && <OpenQuestions items={q.data.unresolved} />}
      <DataGrid
        id="tax-jurisdictions"
        caption="Local tax jurisdictions"
        rows={q.data ? rows : undefined}
        columns={columns}
        rowKey={(r) => r.code}
        loading={q.isLoading}
        error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load jurisdictions.') : null}
        onRetry={() => void q.refetch()}
        noun={{ one: 'jurisdiction', many: 'jurisdictions' }}
        defaultSort={{ key: 'workers', direction: 'desc' }}
        onRowClick={(r) => setOpen(r)}
        rowActionLabel={(r) => `Open ${r.name}`}
        empty={{
          icon: MapPinHouse,
          title: filter === 'attention' ? 'Nothing needs review' : 'No jurisdictions here',
          description:
            filter === 'attention'
              ? `Every local tax your ${workers} owe has been reviewed.`
              : filter === 'in-use'
                ? `None of your ${workers} live or work where a local tax applies.`
                : 'Switch to Every jurisdiction to see the whole list.',
        }}
      />
      <JurisdictionDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function OpenQuestions({ items }: { items: Array<{ associateId: string; name: string; questions: string[] }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Questions to answer</CardTitle>
        <CardDescription>Payroll can’t finish for these people until their home jurisdiction is set on their record, under Taxes we withhold.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-line">
          {items.map((p) => (
            <li key={p.associateId} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <AssociateLink associateId={p.associateId} tab="compensation" className="font-medium">
                {p.name}
              </AssociateLink>
              <span className="text-sm text-ink-muted sm:max-w-[60%] sm:text-right">{p.questions.join(' ')}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Tax tables › Reciprocity: which states' residents pay only their home state's tax. */
export function ReciprocityTable() {
  const q = useQuery({ queryKey: ['payroll', 'tax-reciprocity'], queryFn: getReciprocity });
  return (
    <Card>
      <CardHeader>
        <CardTitle>State reciprocity</CardTitle>
        <CardDescription>
          Someone who lives in one of these states and works in the other pays only their home state’s tax — once the work state’s form is on file.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-32" />
        ) : q.isError || !q.data ? (
          <p className="text-sm text-ink-muted">Could not load the reciprocity table.</p>
        ) : (
          <>
            <ul className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {q.data.agreements.map((a) => (
                <li key={a.workState} className="flex justify-between gap-3 border-b border-line py-1.5">
                  <span className="text-ink">
                    Works in {a.workState}, lives in {a.residentStates.join(', ')}
                  </span>
                  <span className="shrink-0 text-ink-muted">{a.form}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-ink-muted">
              {q.data.convenienceOfEmployer.map((c) => c.state).join(', ')} source work-from-home days to the office when the remote work is for the person’s
              convenience. {q.data.source}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function JurisdictionDrawer({ row, onClose }: { row: JurisdictionRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const close = () => {
    setConfirmed(false);
    setNote('');
    onClose();
  };
  const ack = useMutation({
    mutationFn: () => acknowledgeJurisdiction(row!.code, note.trim() || undefined),
    onSuccess: () => {
      toast.success(`${row!.name} reviewed — payroll can withhold it now.`);
      void qc.invalidateQueries({ queryKey: ['payroll', 'tax-jurisdictions'] });
      close();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the review.'),
  });
  const revoke = useMutation({
    mutationFn: () => revokeJurisdiction(row!.code),
    onSuccess: () => {
      toast.success(`${row!.name} is back to awaiting review.`);
      void qc.invalidateQueries({ queryKey: ['payroll', 'tax-jurisdictions'] });
      close();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not take the review back.'),
  });
  const status = row?.review.status;
  return (
    <Drawer open={!!row} onOpenChange={(o) => !o && close()} width="max-w-lg">
      {row && (
        <>
          <DrawerHeader>
            <DrawerTitle>{row.name}</DrawerTitle>
            <DrawerDescription>
              <Badge variant={REVIEW_TONE[row.review.status]}>{REVIEW_LABEL[row.review.status]}</Badge>
              {row.workers > 0 && <span className="ml-2">{row.workers} on payroll owe it</span>}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="space-y-5">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-ink-muted">Type</dt>
              <dd className="text-ink">
                {KIND_LABEL[row.kind]}, {row.state}
              </dd>
              <dt className="text-ink-muted">Rate</dt>
              <dd className="text-ink tabular-nums">{row.rate}</dd>
              {row.administeredBy && (
                <>
                  <dt className="text-ink-muted">Collected by</dt>
                  <dd className="text-ink">{row.administeredBy}</dd>
                </>
              )}
              <dt className="text-ink-muted">Rates for</dt>
              <dd className="text-ink">{row.taxYear}</dd>
              <dt className="text-ink-muted">Read from</dt>
              <dd className="text-ink">{row.source}</dd>
              <dt className="text-ink-muted">How sure</dt>
              <dd className="text-ink">{CONFIDENCE_LABEL[row.confidence]}</dd>
            </dl>
            {row.note && <p className="rounded-md bg-surface-raised p-3 text-sm text-ink">{row.note}</p>}
            <PaycheckCalculator row={row} />
            {row.review.at && (
              <p className="text-sm text-ink-muted">
                Reviewed {fmtDate(row.review.at)}
                {row.review.by ? ` by ${row.review.by}` : ''}
                {row.review.note ? ` — “${row.review.note}”` : ''}
                {status === 'outdated' ? ` (${row.review.taxYear} rates — review the ${row.taxYear} rates again)` : ''}
              </p>
            )}
            {status !== 'reviewed' && can('process:payroll') && (
              <Card>
                <CardContent className="space-y-3 p-4">
                  <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
                    <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    We reviewed the {row.taxYear} {row.name} rate with our tax adviser, and payroll may withhold it.
                  </label>
                  <Field label="Note (optional)" hint="Who you checked with, or what you compared against.">
                    {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
                  </Field>
                </CardContent>
              </Card>
            )}
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            {status === 'reviewed' && (
              <Button variant="outline" onClick={() => revoke.mutate()} loading={revoke.isPending}>
                Take the review back
              </Button>
            )}
            {status !== 'reviewed' && (
              <Button onClick={() => ack.mutate()} disabled={!confirmed} loading={ack.isPending}>
                Record the review
              </Button>
            )}
          </DrawerFooter>
        </>
      )}
    </Drawer>
  );
}

/** One paycheck's state and local taxes here — to compare with the jurisdiction's own figures. */
function PaycheckCalculator({ row }: { row: JurisdictionRow }) {
  const [wages, setWages] = useState(1_500);
  const [frequency, setFrequency] = useState<PayFrequency>('BIWEEKLY');
  const residentOnly = row.basis === 'RESIDENT_ONLY' && !row.nonresidentRate;
  const workOnly = row.basis === 'WORK_CITY' || row.basis === 'EMPLOYER_PAYROLL' || row.basis === 'PA_LST';
  const [resident, setResident] = useState(!workOnly);
  const calc = useQuery({
    queryKey: ['payroll', 'tax-jurisdictions', 'calc', row.code, wages, frequency, resident],
    queryFn: () => calculateJurisdiction({ code: row.code, wages, frequency, resident }),
    enabled: wages >= 0,
    placeholderData: (prev) => prev,
  });
  const lines = (calc.data?.lines ?? []).filter((l) => l.kind !== 'STATE');
  return (
    <section aria-labelledby={`calc-${row.code}`} className="space-y-3">
      <h3 id={`calc-${row.code}`} className="text-sm font-medium text-ink">
        Check a paycheck
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Wages this period ($)">
          {(p) => <Input {...p} type="number" min="0" step="1" value={wages} onChange={(e) => setWages(e.target.value === '' ? 0 : Number(e.target.value))} />}
        </Field>
        <Field label="Pay frequency">
          {(p) => (
            <Select {...p} value={frequency} onChange={(e) => setFrequency(e.target.value as PayFrequency)}>
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Every two weeks</option>
              <option value="SEMIMONTHLY">Twice a month</option>
              <option value="MONTHLY">Monthly</option>
            </Select>
          )}
        </Field>
      </div>
      {!residentOnly && !workOnly && (
        <SegmentedControl
          ariaLabel="Who"
          value={resident ? 'resident' : 'nonresident'}
          onChange={(v) => setResident(v === 'resident')}
          options={[
            { value: 'resident', label: 'Lives and works here' },
            { value: 'nonresident', label: 'Only works here' },
          ]}
        />
      )}
      <div className="rounded-md border border-line p-3 text-sm" aria-live="polite">
        {!calc.data ? (
          <span className="text-ink-muted">Working it out…</span>
        ) : lines.length === 0 ? (
          <span className="text-ink">This paycheck owes no tax here.</span>
        ) : (
          <ul className="space-y-2">
            {lines.map((l) => (
              <li key={`${l.code}-${l.resident}`}>
                <div className="flex justify-between gap-3">
                  <span className="text-ink">{l.label}</span>
                  <span className="tabular-nums text-ink">
                    {fmtMoney(l.amount)}
                    {l.employer ? ' (employer)' : ''}
                  </span>
                </div>
                {l.note && <p className="mt-0.5 text-xs text-ink-muted">{l.note}</p>}
              </li>
            ))}
          </ul>
        )}
        {calc.data && calc.data.unresolved.length > 0 && <p className="mt-2 text-xs text-ink-muted">{calc.data.unresolved.join(' ')}</p>}
      </div>
    </section>
  );
}
