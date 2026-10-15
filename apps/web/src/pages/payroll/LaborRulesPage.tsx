import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLaborRuleSite, getLaborShadowRun, listLaborRuleSites, listLaborShadowRuns, type LaborRuleSite, type LaborRuleSummary, type LaborShadowRun } from '@/lib/laborRulesApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { DataGrid } from '@/components/ui/DataGrid';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { fmtMoney } from '@/lib/format';
import { LaborOverridesSection } from './LaborOverridesSection';

/**
 * Brief 2-2 — the Rules page: for each site, the labor rules in force on a
 * date (federal, its state, its city, then the organization's and the site's
 * own), and for one site which rule set supplied each value, with its
 * citation (step 2); the organization's own rules, drafted and signed under
 * manage:org (step 6, LaborOverridesSection); and the engine in shadow beside
 * each finalized pay run (step 3). Nothing here pays anyone yet: pay switches
 * to the engine only after the owner signs a clean dry run (step 4).
 */

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
    ['Schedule notice', s.predictiveNoticeDays === null ? 'No notice law' : `${s.predictiveNoticeDays} days`],
    ['Minors’ age bands', String(s.minorBands)],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-navy-secondary/50 py-1">
          <dt className="text-silver">{k}</dt>
          <dd className="text-white">{v}</dd>
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
        <DrawerDescription>{d ? `${d.jurisdictions.join(' → ')} · in force on ${d.date}` : 'Loading…'}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-5">
        {q.isError ? (
          <QueryError what="this site’s rules" query={q} />
        ) : !d ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            {!d.payable && <p className="text-sm text-warning">Not signed yet: these rules are shown and checked, but pay does not use them until counsel signs each set.</p>}
            <SummaryList s={d.summary} />
            <section aria-labelledby="where-from">
              <h3 id="where-from" className="mb-2 text-sm font-semibold text-white">Where each value comes from</h3>
              <ul className="space-y-1 text-xs">
                {Object.entries(d.origin).map(([field, from]) => (
                  <li key={field} className="flex flex-wrap justify-between gap-2">
                    <span className="font-mono text-silver">{field}</span>
                    <span className="text-white">{from}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="sets" className="space-y-2">
              <h3 id="sets" className="text-sm font-semibold text-white">Rule sets</h3>
              {d.sets.map((s) => (
                <div key={s.id} className="rounded-md border border-navy-secondary p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-white">{s.jurisdiction}</span>
                    <span className="text-silver">from {s.effectiveFrom} · v{s.version}</span>
                    <Badge variant={s.status === 'ACTIVE' ? 'success' : 'pending'} size="sm">{s.status === 'ACTIVE' ? 'Signed' : 'Not signed'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-silver">{s.source}</p>
                  {s.approvedAt && <p className="mt-1 text-xs text-silver">Signed {s.approvedAt.slice(0, 10)} by {s.approvedBy}{s.approvalNote ? ` — ${s.approvalNote}` : ''}</p>}
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
  const q = useQuery({ queryKey: ['labor-rules', 'sites', date], queryFn: () => listLaborRuleSites(date), enabled: /^\d{4}-\d{2}-\d{2}$/.test(date) });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Labor rules"
        subtitle="The overtime, meal, rest, minors’ and minimum-wage rules in force at each site — federal, then the site’s state and city."
        breadcrumbs={[{ label: 'Payroll', to: '/payroll' }, { label: 'Labor rules' }]}
      />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-silver">
          In force on
          <Input type="date" className="mt-1 w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <p className="text-xs text-silver">Rules follow the site where the hours are worked, not the person’s home address.</p>
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
                { key: 'name', header: 'Site', accessor: (s) => s.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'where', header: 'Jurisdiction', accessor: (s) => s.jurisdictions.slice(1).join(' · ') || 'Federal only', sortable: true, cardMeta: true },
                { key: 'wage', header: 'Minimum wage', accessor: (s) => s.summary.minimumWageCents, sortable: true, searchable: false, cell: (s) => (s.summary.minimumWageCents === null ? '—' : fmtMoney(s.summary.minimumWageCents / 100)) },
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
      <LaborShadowSection />
      {open && <SiteDrawer id={open} date={date} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* Brief 2-2 step 3 — the engine in shadow: each finalized run recomputed beside what it paid. */

function ShadowRunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['labor-rules', 'shadow', id], queryFn: () => getLaborShadowRun(id) });
  const d = q.data;
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{d ? `Pay period ${d.periodStart} – ${d.periodEnd}` : 'Shadow run'}</DrawerTitle>
        <DrawerDescription>What the rules engine would have paid, beside what was paid. Nothing here changes pay.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-3">
        {q.isError ? (
          <QueryError what="this shadow run" query={q} />
        ) : !d ? (
          <SkeletonRows count={3} />
        ) : d.differences.length === 0 ? (
          <p className="text-sm text-silver">No differences for the {d.associates} people paid in this period.</p>
        ) : (
          d.differences.map((x) => (
            <div key={x.associateId} className="rounded-md border border-navy-secondary p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-medium text-white">{x.name}</span>
                <span className={x.amountDifference > 0 ? 'text-warning' : 'text-silver'}>{fmtMoney(x.amountDifference)}</span>
              </div>
              <p className="mt-1 text-xs text-silver">
                Paid {x.paid.regularHours} h + {x.paid.overtimeHours} h overtime · engine {x.engine.regularHours} h + {x.engine.overtimeHours} h overtime
                {x.engine.doubleTimeHours ? ` + ${x.engine.doubleTimeHours} h double time` : ''} at {fmtMoney(x.hourlyRate)}/h
                {x.penaltyHours ? ` · ${x.penaltyHours} premium h shown, not paid` : ''}
              </p>
              <ul className="mt-1 list-disc pl-5 text-xs text-silver">
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
      <h2 id="shadow-title" className="text-base font-semibold text-white">Engine in shadow</h2>
      <p className="text-sm text-silver">
        Each finalized pay run is recomputed under these rules beside what it paid. Pay switches to the rules engine only after the owner signs a dry run with no differences.
        {runs && runs.length > 0 && (total === 0 ? ' No differences so far.' : ` ${total} difference${total === 1 ? '' : 's'} to review.`)}
      </p>
      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="p-6"><QueryError what="the shadow runs" query={q} /></div>
          ) : !runs ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : runs.length === 0 ? (
            <p className="p-6 text-sm text-silver">No finalized pay runs shadowed yet; each one is recomputed within the hour after it is finalized.</p>
          ) : (
            <DataGrid<LaborShadowRun>
              id="labor-rules-shadow"
              caption="Pay runs recomputed by the rules engine"
              rows={runs}
              rowKey={(r) => r.id}
              urlState={false}
              search={false}
              onRowClick={(r) => setOpen(r.id)}
              columns={[
                { key: 'period', header: 'Pay period', accessor: (r) => r.periodStart, sortable: true, primary: true, cell: (r) => `${r.periodStart} – ${r.periodEnd}` },
                { key: 'people', header: 'People paid', accessor: (r) => r.associates, sortable: true },
                { key: 'diffs', header: 'Differences', accessor: (r) => r.differences, sortable: true, cell: (r) => <Badge variant={r.differences ? 'pending' : 'success'} size="sm">{r.differences}</Badge> },
                { key: 'amount', header: 'Engine − paid', accessor: (r) => r.amountDifference, sortable: true, cell: (r) => fmtMoney(r.amountDifference) },
                { key: 'premium', header: 'Premium hours shown', accessor: (r) => r.penaltyHours, sortable: true },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {open && <ShadowRunDrawer id={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
