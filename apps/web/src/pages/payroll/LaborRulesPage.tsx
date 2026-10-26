import { useState } from 'react';
import { useUrlParam } from '@/lib/useUrlState';
import { useQuery } from '@tanstack/react-query';
import { getLaborRuleSite, getLaborShadowRun, listLaborRuleSites, listLaborShadowRuns, type LaborRuleSite, type LaborRuleSummary, type LaborShadowRun } from '@/lib/laborRulesApi';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { DateField } from '@/components/ui/DateField';
import { EmptyState } from '@/components/ui/EmptyState';
import { DataGrid } from '@/components/ui/DataGrid';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { fmtDate, fmtDateOnly, fmtDateOnlyRange, fmtMoney, parseYmd } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { LaborOverridesSection } from './LaborOverridesSection';
import { LaborGoLiveTab } from './LaborGoLive';
import { LaborScheduleChangesTab, LaborTimekeepingTab } from './LaborTimekeeping';

/**
 * Brief 2-2 — the Rules page: for each site, the labor rules in force on a
 * date (federal, its state, its city, then the organization's and the site's
 * own), and for one site which rule set supplied each value, with its
 * citation (step 2); the organization's own rules, drafted and signed under
 * manage:org (step 6, LaborOverridesSection); and test runs: each finalized
 * pay run recomputed under the rules beside what it paid (step 3); and, state by state, the switch to paying
 * by them (step 4: counsel's sign-off and a second person, LaborGoLive), with
 * the timekeeping rules beside them (rounding, fair overtime, predictability pay).
 */

type Tab = 'states' | 'sites' | 'tests' | 'timekeeping' | 'schedule';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'states', label: 'By state' },
  { value: 'sites', label: 'Rules by site' },
  { value: 'tests', label: 'Test runs' },
  { value: 'timekeeping', label: 'Timekeeping' },
  { value: 'schedule', label: 'Schedule changes' },
];

const TAB_VALUES: ReadonlyArray<Tab | 'shadow'> = [...TABS.map((t) => t.value), 'shadow'];

const hours = (h: number | null, none = 'None') => (h === null ? none : `${h} h`);

function SummaryList({ s }: { s: LaborRuleSummary }) {
  const rows: Array<[string, string]> = [
    ['Weekly overtime', hours(s.weeklyOvertimeHours)],
    ['Daily overtime', hours(s.dailyOvertimeHours)],
    ['Double time', hours(s.doubleTimeHours)],
    ['Seventh consecutive day', s.seventhDayRule ? 'Applies' : 'No'],
    ['Minimum wage', s.minimumWageCents === null ? 'None' : `${fmtMoney(s.minimumWageCents / 100)}/h`],
    ['Meal required after', hours(s.mealRequiredAfterHours, 'No meal law')],
    ['Rest period per', hours(s.restPerHours, 'No rest law')],
    ['Rest between shifts', hours(s.restBetweenShiftsHours)],
    ['Spread of hours', hours(s.spreadOfHoursHours ?? null)],
    ['Split-shift premium', s.splitShiftPremium ? 'Applies' : 'No'],
    ['Schedule notice', s.predictiveNoticeDays === null ? 'No notice law' : `${s.predictiveNoticeDays} days`],
    ['Minors’ age bands', String(s.minorBands)],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SiteDrawer({ id, date, onClose }: { id: string; date: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['labor-rules', 'site', id, date], queryFn: () => getLaborRuleSite(id, date) });
  const d = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{d?.site.name ?? 'Site'}</DrawerTitle>
        <DrawerDescription>{d ? `${d.jurisdictions.join(' → ')} · in force on ${fmtDate(parseYmd(d.date))}` : 'Loading…'}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {q.isError ? (
          <QueryError what="this site’s rules" query={q} />
        ) : !d ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            {!d.payable && <p className="text-sm text-warning">Not live here yet: these rules are shown and checked, but pay uses them only once this state goes live (the By state tab).</p>}
            <SummaryList s={d.summary} />
            <section aria-labelledby="where-from">
              <h3 id="where-from" className="mb-2 text-sm font-semibold text-ink">Where each value comes from</h3>
              <ul className="space-y-1 text-xs">
                {Object.entries(d.origin).map(([field, from]) => (
                  <li key={field} className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-ink-muted">{field}</span>
                    <span className="text-ink">{from}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="sets" className="space-y-2">
              <h3 id="sets" className="text-sm font-semibold text-ink">Rule sets</h3>
              {d.sets.map((s) => (
                <div key={s.id} className="rounded-md border border-line p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{s.jurisdiction}</span>
                    <span className="text-ink-muted">from {fmtDateOnly(s.effectiveFrom, { year: 'auto' })} · v{s.version}</span>
                    <Badge variant={s.status === 'ACTIVE' ? 'success' : 'pending'} size="sm">{s.status === 'ACTIVE' ? 'Signed' : 'Not signed'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">{s.source}</p>
                  {s.approvedAt && <p className="mt-1 text-xs text-ink-muted">Signed {fmtDate(s.approvedAt)} by {s.approvedBy}{s.approvalNote ? ` — ${s.approvalNote}` : ''}</p>}
                </div>
              ))}
            </section>
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}

export function LaborRulesPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [open, setOpen] = useState<string | null>(null);
  // "shadow" was the test-runs tab's old name; a link that still says it opens the same tab.
  const [raw, setTab] = useUrlParam<Tab | 'shadow'>('tab', 'states', TAB_VALUES, { history: 'push' });
  const tab: Tab = raw === 'shadow' ? 'tests' : raw;
  const q = useQuery({ queryKey: ['labor-rules', 'sites', date], queryFn: () => listLaborRuleSites(date), enabled: tab === 'sites' && /^\d{4}-\d{2}-\d{2}$/.test(date) });

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Labor rules"
        subtitle="Overtime, meal, rest and schedule rules by state and site — which ones pay today, and the timekeeping rules beside them."
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList className="max-w-full overflow-x-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'states' && <LaborGoLiveTab />}
      {tab === 'timekeeping' && <LaborTimekeepingTab />}
      {tab === 'schedule' && <LaborScheduleChangesTab />}
      {tab === 'tests' && <LaborShadowSection />}
      {tab === 'sites' && (
      <>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm text-ink-muted">
          In force on
          <DateField value={date} onChange={(v) => v && setDate(v)} clearable={false} aria-label="Rules in force on" />
        </span>
        <p className="text-xs text-ink-muted">Rules follow the site where the hours are worked, not the person’s home address.</p>
      </div>
      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="p-6"><QueryError what="the labor rules" query={q} /></div>
          ) : !q.data ? (
            <div className="p-6"><SkeletonRows count={5} /></div>
          ) : (
            <DataGrid<LaborRuleSite>
              id="labor-rules-sites"
              caption="Labor rules by site"
              rows={q.data.sites}
              rowKey={(s) => s.id}
              urlState={false}
              search={{ placeholder: 'Search sites…' }}
              exportCsv={{ filename: `labor-rules-${date}` }}
              onRowClick={(s) => setOpen(s.id)}
              columns={[
                { key: 'name', header: 'Site', accessor: (s) => s.name, sortable: true, primary: true, className: 'font-medium text-ink' },
                { key: 'where', header: 'Jurisdiction', accessor: (s) => s.jurisdictions.slice(1).join(' · ') || 'Federal only', sortable: true, cardMeta: true },
                { key: 'wage', header: 'Minimum wage', accessor: (s) => s.summary.minimumWageCents, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (s) => (s.summary.minimumWageCents === null ? '—' : fmtMoney(s.summary.minimumWageCents / 100)) },
                { key: 'ot', header: 'Overtime', accessor: (s) => `${hours(s.summary.weeklyOvertimeHours)} weekly${s.summary.dailyOvertimeHours !== null ? `, ${s.summary.dailyOvertimeHours} h daily` : ''}`, searchable: false },
                { key: 'breaks', header: 'Meal / rest law', accessor: (s) => (s.summary.mealRequiredAfterHours !== null || s.summary.restPerHours !== null ? 'Yes' : 'No'), searchable: false },
                {
                  key: 'signed',
                  header: 'Signed',
                  accessor: (s) => (s.payable ? 'Signed' : 'Not signed'),
                  sortable: true,
                  cell: (s) => <Badge variant={s.payable ? 'success' : 'pending'} size="sm">{s.payable ? 'Signed' : 'Not signed'}</Badge>,
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <LaborOverridesSection sites={q.data?.sites ?? []} />
      </>
      )}
      {open && <SiteDrawer id={open} date={date} onClose={() => setOpen(null)} />}
    </ListTemplate>
  );
}

/* Brief 2-2 step 3 — test runs: each finalized run recomputed under the rules beside what it paid. */

function ShadowRunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['labor-rules', 'shadow', id], queryFn: () => getLaborShadowRun(id) });
  const d = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{d ? `Pay period ${fmtDateOnlyRange(d.periodStart, d.periodEnd)}` : 'Test run'}</DrawerTitle>
        <DrawerDescription>What these rules would have paid, beside what was paid. Nothing here changes pay.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-3">
        {q.isError ? (
          <QueryError what="this test run" query={q} />
        ) : !d ? (
          <SkeletonRows count={3} />
        ) : d.differences.length === 0 ? (
          <p className="text-sm text-ink-muted">No differences for the {d.associates} people paid in this period.</p>
        ) : (
          d.differences.map((x) => (
            <div key={x.associateId} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-ink">{x.name}</span>
                <span className={x.amountDifference > 0 ? 'text-warning' : 'text-ink-muted'}>{fmtMoney(x.amountDifference)}</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                Paid {x.paid.regularHours} h + {x.paid.overtimeHours} h overtime · under the rules {x.engine.regularHours} h + {x.engine.overtimeHours} h overtime
                {x.engine.doubleTimeHours ? ` + ${x.engine.doubleTimeHours} h double time` : ''} at {fmtMoney(x.hourlyRate)}/h
                {x.penaltyHours ? ` · ${x.penaltyHours} premium h shown, not paid` : ''}
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
                {x.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </DrawerBody>
    </Drawer>
  );
}

export function LaborShadowSection() {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['labor-rules', 'shadow'], queryFn: () => listLaborShadowRuns() });
  const runs = q.data?.runs;
  const total = runs?.reduce((a, r) => a + r.differences, 0) ?? 0;
  return (
    <section aria-labelledby="shadow-title" className="space-y-2">
      <h2 id="shadow-title" className="text-base font-semibold text-ink">Test runs</h2>
      <p className="text-sm text-ink-muted">
        Each finalized pay run is recomputed under the state rules beside what it paid. Nothing here changes pay: a state pays by its rules only once it goes live (the By state tab).
        {runs && runs.length > 0 && (total === 0 ? ' No differences so far.' : ` ${total} difference${total === 1 ? '' : 's'} to review.`)}
      </p>
      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="p-6"><QueryError what="the test runs" query={q} /></div>
          ) : !runs ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : runs.length === 0 ? (
            <EmptyState size="sm" title="No test runs yet" description="Each finalized pay run is recomputed under the state rules within the hour after it is finalized." />
          ) : (
            <DataGrid<LaborShadowRun>
              id="labor-rules-shadow"
              caption="Pay runs recomputed under the state rules"
              rows={runs}
              rowKey={(r) => r.id}
              urlState={false}
              search={false}
              onRowClick={(r) => setOpen(r.id)}
              columns={[
                { key: 'period', header: 'Pay period', accessor: (r) => r.periodStart, sortable: true, primary: true, cell: (r) => fmtDateOnlyRange(r.periodStart, r.periodEnd) },
                // Counts and money right-aligned in tabular figures, so columns of numbers line up.
                { key: 'people', header: 'People paid', accessor: (r) => r.associates, sortable: true, searchable: false, align: 'right', className: 'tabular-nums' },
                {
                  key: 'diffs',
                  header: 'Differences',
                  accessor: (r) => r.differences,
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  className: 'tabular-nums',
                  // A zero is not news: no green "0" badge.
                  cell: (r) => (r.differences ? <Badge variant="pending" size="sm">{r.differences}</Badge> : <span className="text-ink-muted">0</span>),
                },
                { key: 'amount', header: 'Difference vs. what was paid', accessor: (r) => r.amountDifference, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => fmtMoney(r.amountDifference) },
                { key: 'premium', header: 'Premium hours shown', accessor: (r) => r.penaltyHours, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => `${(r.penaltyHours ?? 0).toFixed(1)}h` },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {open && <ShadowRunDrawer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
