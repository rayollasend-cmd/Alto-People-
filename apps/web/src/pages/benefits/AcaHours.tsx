import { useEffect, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useUrlParam } from '@/lib/useUrlState';
import { AcaFiling } from './AcaFiling';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HeartPulse, Settings2 } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useTenant, useTerm } from '@/lib/auth';
import { fmtDate, fmtMoney } from '@/lib/format';
import {
  answerAcaOffer,
  getAcaSettings,
  getAcaSummary,
  listAcaWorkers,
  recordAcaOffer,
  saveAcaSettings,
  setAcaClassification,
  type AcaClassification,
  type AcaSettings,
  type AcaStatus,
  type AcaWorker,
} from '@/lib/taxcompApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { MetricCard } from '@/components/ui/MetricCard';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * ACA hours — the look-back measurement method for variable-hour work. Each
 * worker's average monthly hours in the measurement period, whether that
 * makes them full-time for the stability period that follows, the offer of
 * coverage owed and by when, the employer shared-responsibility exposure —
 * and, on its second tab, the year-end 1095-C filing (one workflow here; it
 * used to be split with Benefits lifecycle).
 */

const STATUS_LABEL: Record<AcaStatus, string> = {
  full_time: 'Full-time',
  approaching: 'Approaching full-time',
  on_track: 'Under the threshold',
  new_hire: 'New hire — measuring',
};
const STATUS_TONE: Record<AcaStatus, 'info' | 'pending' | 'default' | 'outline'> = {
  full_time: 'info',
  approaching: 'pending',
  on_track: 'default',
  new_hire: 'outline',
};
const CLASS_LABEL: Record<AcaClassification, string> = {
  FULL_TIME: 'Hired full-time',
  VARIABLE_HOUR: 'Variable hours',
  SEASONAL: 'Seasonal',
  PART_TIME: 'Part-time',
};
const OFFER_LABEL: Record<AcaWorker['offerState'], string> = {
  not_due: 'Not owed',
  due: 'Offer due',
  overdue: 'Offer overdue',
  offered: 'Offered',
};
const OFFER_TONE: Record<AcaWorker['offerState'], 'default' | 'pending' | 'destructive' | 'success'> = {
  not_due: 'default',
  due: 'pending',
  overdue: 'destructive',
  offered: 'success',
};

type Filter = 'attention' | 'full_time' | 'approaching' | 'all';
const FILTERS: Filter[] = ['attention', 'full_time', 'approaching', 'all'];
type AcaTab = 'hours' | 'filing';
const ACA_TABS: AcaTab[] = ['hours', 'filing'];

/** Average monthly hours against the threshold — the bar is labelled, never colour alone. */
function HoursBar({ avg, threshold }: { avg: number; threshold: number }) {
  const pct = Math.min(100, Math.round((avg / threshold) * 100));
  return (
    <div className="flex min-w-[8rem] items-center gap-2">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={threshold}
        aria-valuenow={Math.round(avg)}
        aria-label={`${avg} hours a month of ${threshold}`}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className={cn('h-full rounded-full', avg >= threshold ? 'bg-accent' : avg >= threshold - 10 ? 'bg-warning' : 'bg-steel')} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-ink">{avg}</span>
    </div>
  );
}

export function AcaHours() {
  const term = useTerm();
  const hasClients = useTenant().moduleOn('clientPortal');
  // The tab and the filter are in the URL: a link to the filing, or to everyone full-time, is that view.
  const [tab, setTab] = useUrlParam<AcaTab>('tab', 'hours', ACA_TABS, { history: 'push' });
  const [filter, setFilter] = useUrlParam<Filter>('show', 'attention', FILTERS);
  const [open, setOpen] = useState<AcaWorker | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const summary = useQuery({ queryKey: ['aca', 'summary'], queryFn: getAcaSummary });
  const workers = useQuery({ queryKey: ['aca', 'workers'], queryFn: listAcaWorkers });
  const threshold = workers.data?.fullTimeHoursPerMonth ?? 130;

  const rows = useMemo(() => {
    const all = workers.data?.workers ?? [];
    if (filter === 'attention') return all.filter((w) => w.offerState === 'due' || w.offerState === 'overdue' || w.measurement.status === 'approaching');
    if (filter === 'full_time') return all.filter((w) => w.measurement.status === 'full_time');
    if (filter === 'approaching') return all.filter((w) => w.measurement.status === 'approaching');
    return all;
  }, [workers.data, filter]);

  const columns: GridColumn<AcaWorker>[] = [
    { key: 'name', header: term('worker'), accessor: (r) => r.name, primary: true, sortable: true },
    { key: 'place', header: term('label.store'), accessor: (r) => [r.siteName, r.clientName].filter(Boolean).join(' · '), cardMeta: true },
    { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.measurement.status], cell: (r) => <Badge variant={STATUS_TONE[r.measurement.status]}>{STATUS_LABEL[r.measurement.status]}</Badge> },
    {
      key: 'avg',
      header: 'Hours a month',
      accessor: (r) => r.measurement.inProgress?.averageHours ?? null,
      cell: (r) => (r.measurement.inProgress ? <HoursBar avg={r.measurement.inProgress.averageHours} threshold={threshold} /> : <span className="text-xs text-ink-muted">Hired full-time</span>),
      sortable: true,
    },
    {
      key: 'offer',
      header: 'Offer of coverage',
      accessor: (r) => OFFER_LABEL[r.offerState],
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge variant={OFFER_TONE[r.offerState]}>{OFFER_LABEL[r.offerState]}</Badge>
          {r.measurement.offerDue && r.offerState !== 'offered' && <span className="text-xs text-ink-muted">by {fmtDate(r.measurement.offerDue.dueBy)}</span>}
        </span>
      ),
    },
    { key: 'class', header: 'Classification', accessor: (r) => CLASS_LABEL[r.measurement.classification], defaultHidden: true },
  ];

  const s = summary.data;
  const owed = s ? s.counts.offersDue + s.counts.offersOverdue : 0;
  return (
    <ListTemplate
      title="ACA hours"
      subtitle={`Variable-hour work measured against ${threshold} hours a month: who is full-time, who is close, the offers of coverage owed — and the year-end 1095-C filing.`}
      actions={[{ label: 'Measurement settings', icon: Settings2, onSelect: () => setSettingsOpen(true) }]}
      summary={
        s ? (
          <MetricStrip label="ACA at a glance">
            <MetricCard
              label="Full-time"
              value={s.counts.fullTime}
              hint={`${s.counts.measured.toLocaleString()} measured`}
              tone="neutral"
              onClick={() => {
                setTab('hours');
                setFilter('full_time');
              }}
              selected={tab === 'hours' && filter === 'full_time'}
              nothing={s.counts.measured === 0 ? 'No one measured yet' : undefined}
            />
            <MetricCard
              label="Approaching"
              value={s.counts.approaching}
              hint={`averaging ${threshold - 10}–${threshold} hours a month`}
              tone="neutral"
              onClick={() => {
                setTab('hours');
                setFilter('approaching');
              }}
              selected={tab === 'hours' && filter === 'approaching'}
              nothing={s.counts.approaching === 0 ? 'No one close to the line' : undefined}
            />
            <MetricCard
              label="Offers owed"
              value={owed}
              hint={s.counts.offersOverdue ? `${s.counts.offersOverdue} past the stability start` : 'None overdue'}
              tone={s.counts.offersOverdue > 0 ? 'alert' : 'warning'}
              onClick={() => {
                setTab('hours');
                setFilter('attention');
              }}
              selected={tab === 'hours' && filter === 'attention'}
              nothing={owed === 0 ? 'No offers owed' : undefined}
            />
            <MetricCard
              label="Penalty exposure"
              value={fmtMoney(Math.max(s.exposure.a, s.exposure.b))}
              hint={s.exposure.failsNinetyFive ? `${s.exposure.offeredShare}% offered — under the 95% line` : `${s.exposure.offeredShare}% of full-time offered`}
              tone={s.exposure.failsNinetyFive ? 'alert' : 'neutral'}
              nothing={s.exposure.fullTime === 0 ? 'Nobody is full-time yet' : undefined}
            />
          </MetricStrip>
        ) : (
          <Skeleton className="h-24" />
        )
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as AcaTab)}>
        <TabsList>
          <TabsTrigger value="hours">Hours & offers</TabsTrigger>
          <TabsTrigger value="filing">Annual filing</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'filing' ? (
        <div className="mt-4">
          <AcaFiling />
        </div>
      ) : (
      <div className="mt-4 space-y-5">
        <SegmentedControl
          ariaLabel="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'attention', label: 'Needs attention' },
            { value: 'full_time', label: 'Full-time' },
            { value: 'approaching', label: 'Approaching' },
            { value: 'all', label: 'Everyone' },
          ]}
        />
        {s && !s.likelyAle && (
          <p className="rounded-md border border-line p-3 text-sm text-ink-muted">
            Fewer than 50 full-time {term('workers').toLowerCase()} are measured right now. The employer mandate applies to employers with 50 or more full-time and full-time-equivalent employees — count part-time hours too before relying on this.
          </p>
        )}
        <DataGrid
          id="aca-workers"
          caption="ACA measurement"
          rows={workers.data ? rows : undefined}
          columns={columns}
          rowKey={(r) => r.associateId}
          loading={workers.isLoading}
          error={workers.isError ? (workers.error instanceof ApiError ? workers.error.message : 'Could not load the measurement.') : null}
          onRetry={() => void workers.refetch()}
          noun={{ one: 'person', many: 'people' }}
          defaultSort={{ key: 'avg', direction: 'desc' }}
          onRowClick={(r) => setOpen(r)}
          rowActionLabel={(r) => `Open ${r.name}`}
          empty={{
            icon: HeartPulse,
            title: filter === 'attention' ? 'Nothing needs attention' : 'No one here',
            description: filter === 'attention' ? 'No offers owed and nobody close to full-time.' : 'Switch to Everyone to see every W-2 worker measured.',
          }}
        />
        {s && s.byClient.some((c) => c.fullTime > 0) && (
          <Card>
            <CardHeader>
              <CardTitle>{hasClients ? `Penalty exposure by ${term('label.client').toLowerCase()}` : 'Penalty exposure'}</CardTitle>
              <CardDescription>
                The most each could cost if full-time {term('workers').toLowerCase()} without an offer claimed a premium tax credit ({fmtMoney(s.exposure.amounts.b)} each for {s.year}). An estimate, not an assessment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-line">
                {s.byClient
                  .filter((c) => c.fullTime > 0)
                  .map((c) => (
                    <li key={c.clientId ?? 'none'} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className="text-ink">{c.clientName ?? (hasClients ? 'Not yet placed' : 'Everyone')}</span>
                      <span className="tabular-nums text-ink-muted">
                        {c.fullTime} full-time · {c.offered} offered · <span className={c.exposureB ? 'text-ink' : ''}>{fmtMoney(c.exposureB)}</span>
                      </span>
                    </li>
                  ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
      )}
      <WorkerDrawer worker={open} threshold={threshold} onClose={() => setOpen(null)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ListTemplate>
  );
}

function WorkerDrawer({ worker, threshold, onClose }: { worker: AcaWorker | null; threshold: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [klass, setKlass] = useState<AcaClassification>('VARIABLE_HOUR');
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  useEffect(() => {
    if (worker) setKlass(worker.measurement.classification);
  }, [worker]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['aca'] });
  const onErr = (fallback: string) => (err: unknown) => toast.error(err instanceof ApiError ? err.message : fallback);
  const classify = useMutation({
    mutationFn: () => setAcaClassification(worker!.associateId, { classification: klass, effectiveFrom: from }),
    onSuccess: () => {
      toast.success('Classification saved.');
      refresh();
      onClose();
    },
    onError: onErr('Could not save the classification.'),
  });
  const offer = useMutation({
    mutationFn: () => recordAcaOffer({ associateId: worker!.associateId, stabilityStart: worker!.measurement.offerDue!.stabilityStart, stabilityEnd: worker!.measurement.offerDue!.stabilityEnd }),
    onSuccess: () => {
      toast.success('Offer of coverage recorded.');
      refresh();
      onClose();
    },
    onError: onErr('Could not record the offer.'),
  });
  const answer = useMutation({
    mutationFn: (r: 'ENROLLED' | 'WAIVED') => answerAcaOffer(worker!.offer!.id, r),
    onSuccess: () => {
      toast.success('Answer recorded.');
      refresh();
      onClose();
    },
    onError: onErr('Could not record the answer.'),
  });
  const m = worker?.measurement;
  return (
    <Drawer open={!!worker} onOpenChange={(o) => !o && onClose()} width="max-w-lg">
      {worker && m && (
        <>
          <DrawerHeader>
            <DrawerTitle>{worker.name}</DrawerTitle>
            <DrawerDescription>
              <Badge variant={STATUS_TONE[m.status]}>{STATUS_LABEL[m.status]}</Badge>
              <span className="ml-2">{CLASS_LABEL[m.classification]}</span>
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="space-y-6">
            {m.inProgress ? (
              <section aria-labelledby="aca-measure" className="space-y-2">
                <h3 id="aca-measure" className="text-sm font-medium text-ink">
                  {m.inProgress.kind === 'initial' ? 'Initial measurement period' : 'Measurement period'}
                </h3>
                <p className="text-sm text-ink-muted">
                  {fmtDate(m.inProgress.start)} – {fmtDate(m.inProgress.end)} · {m.inProgress.monthsElapsed} months in · {m.inProgress.hours.toLocaleString()} hours
                </p>
                <HoursBar avg={m.inProgress.averageHours} threshold={threshold} />
                <p className="text-sm text-ink">
                  {m.inProgress.averageHours >= threshold
                    ? `Running at or above ${threshold} hours a month — full-time for the stability period starting ${fmtDate(m.inProgress.stabilityStart)} if it holds.`
                    : `${Math.max(0, Math.round((threshold - m.inProgress.averageHours) * 10) / 10)} hours a month under the line.`}
                </p>
              </section>
            ) : (
              <p className="text-sm text-ink">Hired as full-time — treated as full-time from the first day of the fourth month after hire.</p>
            )}

            <section aria-labelledby="aca-offer" className="space-y-2">
              <h3 id="aca-offer" className="text-sm font-medium text-ink">
                Offer of coverage
              </h3>
              {worker.offer ? (
                <>
                  <p className="text-sm text-ink">
                    Offered {fmtDate(worker.offer.offeredAt)} for the stability period from {fmtDate(worker.offer.stabilityStart)} ·{' '}
                    {worker.offer.response === 'PENDING' ? 'waiting on their answer' : worker.offer.response === 'ENROLLED' ? 'enrolled' : 'waived'}
                  </p>
                  {worker.offer.response === 'PENDING' && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => answer.mutate('ENROLLED')} loading={answer.isPending && answer.variables === 'ENROLLED'}>
                        They enrolled
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => answer.mutate('WAIVED')} loading={answer.isPending && answer.variables === 'WAIVED'}>
                        They waived
                      </Button>
                    </div>
                  )}
                </>
              ) : m.offerDue ? (
                <>
                  <p className="text-sm text-ink">
                    Owed for {fmtDate(m.offerDue.stabilityStart)} – {fmtDate(m.offerDue.stabilityEnd)}, by {fmtDate(m.offerDue.dueBy)}.
                  </p>
                  <Button size="sm" onClick={() => offer.mutate()} loading={offer.isPending}>
                    Record the offer
                  </Button>
                </>
              ) : (
                <p className="text-sm text-ink-muted">No offer owed right now.</p>
              )}
            </section>

            <section aria-labelledby="aca-class" className="space-y-3">
              <h3 id="aca-class" className="text-sm font-medium text-ink">
                Classification
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Classified as">
                  {(p) => (
                    <Select {...p} value={klass} onChange={(e) => setKlass(e.target.value as AcaClassification)}>
                      {(Object.keys(CLASS_LABEL) as AcaClassification[]).map((k) => (
                        <option key={k} value={k}>
                          {CLASS_LABEL[k]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              </div>
              <Button size="sm" variant="outline" onClick={() => classify.mutate()} disabled={klass === m.classification} loading={classify.isPending}>
                Save classification
              </Button>
            </section>
          </DrawerBody>
          <DrawerFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DrawerFooter>
        </>
      )}
    </Drawer>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['aca', 'settings'], queryFn: getAcaSettings, enabled: open });
  const [f, setF] = useState<AcaSettings | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data.settings);
  }, [q.data, open]);
  const problems = f
    ? [
        f.measurementMonths < 3 || f.measurementMonths > 12 ? 'The measurement period is 3 to 12 months.' : null,
        f.adminDays < 0 || f.adminDays > 90 ? 'The administrative period is at most 90 days.' : null,
        f.stabilityMonths < 6 || f.stabilityMonths < f.measurementMonths ? 'The stability period is at least 6 months and at least as long as the measurement period.' : null,
      ].filter((x): x is string => !!x)
    : [];
  const save = useMutation({
    mutationFn: () => saveAcaSettings(f!),
    onSuccess: () => {
      toast.success('Measurement settings saved.');
      void qc.invalidateQueries({ queryKey: ['aca'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });
  const n = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Measurement settings</DialogTitle>
          <DialogDescription>The look-back periods every variable-hour worker is measured over. Change them only at the start of a measurement period.</DialogDescription>
        </DialogHeader>
        {!f ? (
          <Skeleton className="h-48" />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Measurement period (months)">{(p) => <Input {...p} type="number" min="3" max="12" value={f.measurementMonths} onChange={(e) => setF({ ...f, measurementMonths: n(e.target.value) })} />}</Field>
            <Field label="Administrative period (days)">{(p) => <Input {...p} type="number" min="0" max="90" value={f.adminDays} onChange={(e) => setF({ ...f, adminDays: n(e.target.value) })} />}</Field>
            <Field label="Stability period (months)">{(p) => <Input {...p} type="number" min="6" max="12" value={f.stabilityMonths} onChange={(e) => setF({ ...f, stabilityMonths: n(e.target.value) })} />}</Field>
            <Field label="New-hire measurement (months)">
              {(p) => <Input {...p} type="number" min="3" max="12" value={f.initialMeasurementMonths} onChange={(e) => setF({ ...f, initialMeasurementMonths: n(e.target.value) })} />}
            </Field>
            <Field label="Stability starts">
              {(p) => (
                <Select {...p} value={f.stabilityStartMonth} onChange={(e) => setF({ ...f, stabilityStartMonth: n(e.target.value) })}>
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m} {f.stabilityStartDay}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Full-time hours a month">{(p) => <Input {...p} type="number" min="100" max="200" value={f.fullTimeHoursPerMonth} onChange={(e) => setF({ ...f, fullTimeHoursPerMonth: n(e.target.value) })} />}</Field>
            <Field label="Break in service (weeks)">{(p) => <Input {...p} type="number" min="4" max="52" value={f.breakInServiceWeeks} onChange={(e) => setF({ ...f, breakInServiceWeeks: n(e.target.value) })} />}</Field>
            <Field label="Affordability safe harbor">
              {(p) => (
                <Select {...p} value={f.affordabilitySafeHarbor ?? ''} onChange={(e) => setF({ ...f, affordabilitySafeHarbor: (e.target.value || null) as AcaSettings['affordabilitySafeHarbor'] })}>
                  <option value="2H">Rate of pay (2H)</option>
                  <option value="2F">W-2 wages (2F)</option>
                  <option value="2G">Federal poverty line (2G)</option>
                  <option value="">None</option>
                </Select>
              )}
            </Field>
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink coarse:min-h-11">
              <input type="checkbox" className="h-4 w-4" checked={f.ruleOfParity} onChange={(e) => setF({ ...f, ruleOfParity: e.target.checked })} />
              Apply the rule of parity to shorter breaks
            </label>
            {problems.length > 0 && (
              <ul className="col-span-2 list-disc pl-5 text-sm text-alert" role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!f || problems.length > 0} loading={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
