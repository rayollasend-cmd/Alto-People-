import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLaborRuleSite, listLaborRuleSites, type LaborRuleSite, type LaborRuleSummary } from '@/lib/laborRulesApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { DataGrid } from '@/components/ui/DataGrid';
import { SkeletonRows } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { Drawer, DrawerBody, DrawerDescription, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { fmtMoney } from '@/lib/format';

/**
 * Brief 2-2 step 2 — the Rules page, read-only: for each site, the labor
 * rules in force on a date (federal, its state, its city, then the
 * organization's and the site's own), and for one site which rule set
 * supplied each value, with its citation. Nothing here pays anyone yet: the
 * engine runs in shadow (step 3) and pays only after the owner signs (step 4).
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
      {open && <SiteDrawer id={open} date={date} onClose={() => setOpen(null)} />}
    </div>
  );
}
