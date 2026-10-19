import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney, fmtPercent } from '@/lib/format';
import {
  acknowledgeState,
  calculateStateTax,
  getStateCoverage,
  getStateW4Forms,
  revokeStateAcknowledgment,
  type StateCalcInput,
  type StateCoverage,
  type StateCoverageRow,
} from '@/lib/taxcompApi';
import { ListTemplate } from '@/components/templates';
import { DeductionTreatmentCard } from './DeductionTreatmentCard';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * State tax coverage: every state and DC, and whether payroll can withhold
 * there. The states added from their published methods start "awaiting
 * review" and block payroll for anyone working there until a payroll admin
 * confirms the tables were reviewed with the company's tax adviser — the
 * drawer shows the source and a calculator to check figures against the
 * state's own.
 */

const COVERAGE_LABEL: Record<StateCoverage, string> = {
  verified: 'Covered',
  acknowledged: 'Reviewed',
  awaiting_review: 'Awaiting review',
  none: 'No income tax table',
};
const COVERAGE_TONE: Record<StateCoverage, 'success' | 'info' | 'pending' | 'default'> = {
  verified: 'success',
  acknowledged: 'info',
  awaiting_review: 'pending',
  none: 'default',
};

type Filter = 'attention' | 'with-people' | 'all';

export function StateTaxCoverage() {
  const term = useTerm();
  const [filter, setFilter] = useState<Filter>('attention');
  const [open, setOpen] = useState<StateCoverageRow | null>(null);
  const q = useQuery({ queryKey: ['payroll', 'state-tax', 'coverage'], queryFn: getStateCoverage });
  const rows = useMemo(() => {
    const all = q.data?.states ?? [];
    if (filter === 'attention') return all.filter((s) => s.coverage === 'awaiting_review' || (s.coverage === 'none' && s.people > 0));
    if (filter === 'with-people') return all.filter((s) => s.people > 0);
    return all;
  }, [q.data, filter]);

  const columns: GridColumn<StateCoverageRow>[] = [
    { key: 'name', header: 'State', accessor: (r) => r.name, primary: true, sortable: true },
    {
      key: 'coverage',
      header: 'Withholding',
      accessor: (r) => COVERAGE_LABEL[r.coverage],
      cell: (r) => <Badge variant={COVERAGE_TONE[r.coverage]}>{COVERAGE_LABEL[r.coverage]}</Badge>,
      cardMeta: true,
    },
    {
      key: 'people',
      header: term('workers'),
      accessor: (r) => r.people,
      cell: (r) => (r.people ? <span className="tabular-nums">{r.people}</span> : <span className="text-ink-muted">—</span>),
      align: 'right',
      sortable: true,
    },
    { key: 'year', header: 'Tables', accessor: (r) => r.taxYear ?? '', cell: (r) => (r.taxYear ? `${r.taxYear}` : '—'), defaultHidden: true },
    {
      key: 'programs',
      header: 'Disability & leave',
      accessor: (r) => (r.programs ?? []).map((p) => p.label).join(', '),
      cell: (r) =>
        r.programs?.length ? (
          <span className="text-xs text-ink">{r.programs.map((p) => p.label.replace(/\s*\(.*\)$/, '')).join(' · ')}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: 'reviewed',
      header: 'Reviewed',
      accessor: (r) => r.acknowledgment?.at ?? '',
      cell: (r) =>
        r.acknowledgment ? (
          <span className="text-xs text-ink-muted">
            {fmtDate(r.acknowledgment.at)}
            {r.acknowledgment.by ? ` · ${r.acknowledgment.by}` : ''}
          </span>
        ) : r.coverage === 'awaiting_review' ? (
          <span className="text-xs text-ink-muted">Not yet</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
  ];

  const counts = q.data?.counts;
  return (
    <ListTemplate
      title="State tax coverage"
      subtitle="Where payroll withholds state income tax and the state disability, paid-leave and unemployment contributions, and the states waiting on a review with your tax adviser before it can."
      breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'State tax coverage' }]}
      summary={
        counts ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricCard label="Covered" value={counts.verified} hint="states, including those with no income tax" />
            <MetricCard label="Reviewed" value={counts.acknowledged} hint="added states your team signed off" />
            <MetricCard label="Awaiting review" value={counts.awaitingReview} hint="added states not yet signed off" accent={counts.awaitingReview > 0} />
            <MetricCard
              label="Blocked from payroll"
              value={counts.blockedPeople}
              hint={counts.blockedPeople ? `${term('workers').toLowerCase()} in states payroll can’t withhold for yet` : 'nobody is blocked'}
              accent={counts.blockedPeople > 0}
            />
          </div>
        ) : (
          <Skeleton className="h-24" />
        )
      }
      filters={
        <SegmentedControl
          className="flex-wrap"
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'attention', label: 'Needs attention' },
            { value: 'with-people', label: `Where ${term('workers').toLowerCase()} work` },
            { value: 'all', label: 'Every state' },
          ]}
        />
      }
    >
      <DataGrid
        id="state-tax-coverage"
        caption="State withholding coverage"
        rows={q.data ? rows : undefined}
        columns={columns}
        rowKey={(r) => r.state}
        loading={q.isLoading}
        error={q.isError ? (q.error instanceof ApiError ? q.error.message : 'Could not load coverage.') : null}
        onRetry={() => void q.refetch()}
        noun={{ one: 'state', many: 'states' }}
        defaultSort={{ key: 'people', direction: 'desc' }}
        onRowClick={(r) => setOpen(r)}
        rowActionLabel={(r) => `Open ${r.name}`}
        empty={{
          icon: ShieldCheck,
          title: filter === 'attention' ? 'Nothing needs attention' : 'No states here',
          description: filter === 'attention' ? 'Every state where people work is covered or reviewed.' : 'Switch to Every state to see the whole list.',
        }}
      />
      <DeductionTreatmentCard />
      <StateDrawer row={open} onClose={() => setOpen(null)} />
    </ListTemplate>
  );
}

function StateDrawer({ row, onClose }: { row: StateCoverageRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const reviewable = row?.coverage === 'awaiting_review' || row?.coverage === 'acknowledged';
  const ack = useMutation({
    mutationFn: () => acknowledgeState(row!.state, note.trim() || undefined),
    onSuccess: () => {
      toast.success(`${row!.name} reviewed — payroll can withhold there now.`);
      setConfirmed(false);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['payroll', 'state-tax'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not record the review.'),
  });
  const revoke = useMutation({
    mutationFn: () => revokeStateAcknowledgment(row!.state),
    onSuccess: () => {
      toast.success(`${row!.name} is back to awaiting review.`);
      void qc.invalidateQueries({ queryKey: ['payroll', 'state-tax'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not take the review back.'),
  });
  return (
    <Drawer open={!!row} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      {row && (
        <>
          <DrawerHeader>
            <DrawerTitle>{row.name}</DrawerTitle>
            <DrawerDescription>
              <Badge variant={COVERAGE_TONE[row.coverage]}>{COVERAGE_LABEL[row.coverage]}</Badge>
              {row.people > 0 && <span className="ml-2">{row.people} on payroll here</span>}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="space-y-5">
            {row.coverage === 'verified' && (
              <>
                <p className="text-sm text-ink">Payroll withholds here from the engine’s own tables — nothing to review.</p>
                {row.source && (
                  <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
                    <dt className="text-ink-muted">Tables</dt>
                    <dd className="text-ink">{row.taxYear}</dd>
                    <dt className="text-ink-muted">Method</dt>
                    <dd className="text-ink">{row.source}</dd>
                    {row.form && (
                      <>
                        <dt className="text-ink-muted">State certificate</dt>
                        <dd className="text-ink">{row.form}</dd>
                      </>
                    )}
                  </dl>
                )}
                {row.notes && <p className="rounded-md bg-surface-raised p-3 text-sm text-ink">{row.notes}</p>}
                {row.taxYear && <Calculator state={row.state} />}
              </>
            )}
            <ProgramsSection row={row} />
            {row.coverage === 'none' && <p className="text-sm text-ink">There is no withholding table for this state yet; anyone working here blocks payroll until there is.</p>}
            {reviewable && (
              <>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
                  <dt className="text-ink-muted">Tables</dt>
                  <dd className="text-ink">{row.taxYear}</dd>
                  <dt className="text-ink-muted">Read from</dt>
                  <dd className="text-ink">{row.source}</dd>
                  {row.form && (
                    <>
                      <dt className="text-ink-muted">State certificate</dt>
                      <dd className="text-ink">{row.form}</dd>
                    </>
                  )}
                  <dt className="text-ink-muted">How sure</dt>
                  <dd className="text-ink">{row.confidence === 'low' ? 'Approximated — check against the state’s calculator' : 'Transcribed from the published method'}</dd>
                </dl>
                {row.notes && <p className="rounded-md bg-surface-raised p-3 text-sm text-ink">{row.notes}</p>}
                <Calculator state={row.state} />
                {row.acknowledgment && (
                  <p className="text-sm text-ink-muted">
                    Reviewed {fmtDate(row.acknowledgment.at)}
                    {row.acknowledgment.by ? ` by ${row.acknowledgment.by}` : ''}
                    {row.acknowledgment.note ? ` — “${row.acknowledgment.note}”` : ''}
                    {!row.acknowledgment.current ? ' (an older year’s tables — review again)' : ''}
                  </p>
                )}
                {row.coverage === 'awaiting_review' && can('process:payroll') && (
                  <Card>
                    <CardContent className="space-y-3 p-4">
                      <label className="flex items-start gap-2 text-sm text-ink coarse:min-h-11">
                        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                        We reviewed {row.name}’s {row.taxYear} withholding tables with our tax adviser, and payroll may withhold with them.
                      </label>
                      <Field label="Note (optional)" hint="Who you checked with, or what you compared against.">
                        {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
                      </Field>
                    </CardContent>
                  </Card>
                )}
              </>
            )}
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {row.coverage === 'acknowledged' && (
              <Button variant="outline" onClick={() => revoke.mutate()} loading={revoke.isPending}>
                Take the review back
              </Button>
            )}
            {row.coverage === 'awaiting_review' && (
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

/** The state's disability, paid-leave and employee-UI contributions, with their rates and sources. */
function ProgramsSection({ row }: { row: StateCoverageRow }) {
  const programs = row.programs ?? [];
  const coming = row.programsComing ?? [];
  if (!programs.length && !coming.length) return null;
  const pct = (n: number) => fmtPercent(n, { fromFraction: true, decimals: 3 });
  return (
    <section aria-labelledby={`programs-${row.state}`} className="space-y-3">
      <h3 id={`programs-${row.state}`} className="text-sm font-medium text-ink">
        Disability, leave and unemployment contributions
      </h3>
      <p className="text-xs text-ink-muted">Withheld for work localized in {row.name} (the state its unemployment insurance goes to).</p>
      <ul className="divide-y divide-line rounded-md border border-line">
        {programs.map((p) => (
          <li key={p.code} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-ink">{p.label}</span>
              <Badge variant={p.verified ? 'success' : 'pending'} size="sm" withDot={false}>
                {p.verified ? 'Verified 2026' : 'Awaiting review'}
              </Badge>
            </div>
            <p className="tabular-nums text-ink">
              {p.employeeRate > 0 ? `Worker ${pct(p.employeeRate)}` : 'Nothing from the worker'}
              {p.employerRate > 0 ? ` · employer ${pct(p.employerRate)}` : ''}
              {p.weeklyEmployeeMax !== null ? ` · up to ${fmtMoney(p.weeklyEmployeeMax)} a week` : ''}
              {p.wageCap !== null ? ` · wages up to ${fmtMoney(p.wageCap)}` : ' · no wage cap'}
            </p>
            <p className="text-xs text-ink-muted">{p.source}</p>
          </li>
        ))}
        {coming.map((c) => (
          <li key={c.label} className="space-y-1 p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium text-ink">{c.label}</span>
              <Badge variant="default" size="sm" withDot={false}>
                Starts {fmtDate(c.startsOn)}
              </Badge>
            </div>
            <p className="text-xs text-ink-muted">{c.source}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the engine withholds for a wage — to compare with the state's own calculator. */
function Calculator({ state }: { state: string }) {
  const [form, setForm] = useState<StateCalcInput>({ state, wages: 1_500, frequency: 'BIWEEKLY', filingStatus: 'SINGLE', allowances: 1, dependents: 0, federal: 120 });
  const forms = useQuery({ queryKey: ['payroll', 'state-w4-forms'], queryFn: getStateW4Forms, enabled: state === 'MD' });
  const calc = useQuery({
    queryKey: ['payroll', 'state-tax', 'calc', form],
    queryFn: () => calculateStateTax(form),
    enabled: form.wages >= 0,
    placeholderData: (prev) => prev,
  });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <section aria-labelledby={`calc-${state}`} className="space-y-3">
      <h3 id={`calc-${state}`} className="text-sm font-medium text-ink">
        Check a paycheck
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Wages this period ($)">{(p) => <Input {...p} type="number" min="0" step="1" value={form.wages} onChange={(e) => setForm({ ...form, wages: num(e.target.value) })} />}</Field>
        <Field label="Pay frequency">
          {(p) => (
            <Select {...p} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value as StateCalcInput['frequency'] })}>
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Every two weeks</option>
              <option value="SEMIMONTHLY">Twice a month</option>
              <option value="MONTHLY">Monthly</option>
            </Select>
          )}
        </Field>
        <Field label="Filing status">
          {(p) => (
            <Select {...p} value={form.filingStatus} onChange={(e) => setForm({ ...form, filingStatus: e.target.value as StateCalcInput['filingStatus'] })}>
              <option value="SINGLE">Single</option>
              <option value="MARRIED">Married</option>
              <option value="HEAD_OF_HOUSEHOLD">Head of household</option>
            </Select>
          )}
        </Field>
        <Field label="Allowances">{(p) => <Input {...p} type="number" min="0" max="30" value={form.allowances} onChange={(e) => setForm({ ...form, allowances: num(e.target.value) })} />}</Field>
        <Field label="Dependents">{(p) => <Input {...p} type="number" min="0" max="30" value={form.dependents} onChange={(e) => setForm({ ...form, dependents: num(e.target.value) })} />}</Field>
        <Field label="Federal withheld ($)" hint="Alabama and Oregon subtract it">
          {(p) => <Input {...p} type="number" min="0" step="1" value={form.federal} onChange={(e) => setForm({ ...form, federal: num(e.target.value) })} />}
        </Field>
        {state === 'MD' && (
          <Field label="County" className="col-span-2">
            {(p) => (
              <Select {...p} value={form.county ?? ''} onChange={(e) => setForm({ ...form, county: e.target.value || undefined })}>
                <option value="">No county (3.20%)</option>
                {forms.data?.marylandCounties.map((c) => (
                  <option key={c} value={c}>
                    {titleCase(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <p className="rounded-md border border-line p-3 text-sm text-ink" aria-live="polite">
        {calc.data ? (
          <>
            Withholds <strong className="tabular-nums">{fmtMoney(calc.data.perPeriod)}</strong> this period.
          </>
        ) : (
          'Working it out…'
        )}
      </p>
    </section>
  );
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'.-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
