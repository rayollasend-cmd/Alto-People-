import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, HeartPulse } from '@/components/ui/icons';
import { getBenefitsOverview, type BenefitsOverview, type BenefitsOverviewPlan } from '@/lib/benefitsApi';
import { getAcaSummary } from '@/lib/taxcompApi';
import { useAuth, useTenant } from '@/lib/auth';
import { fmtDateOnly, fmtDateOnlyRange, fmtMoney } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';
import type { RelatedLink } from '@/components/ui/PageHeader';
import { KIND_LABEL } from './benefitsWords';

/**
 * Benefits for the people who run it (HR, finance): plans by client, who is
 * enrolled and what they put in each pay period, open enrollment, and what
 * is waiting — life events, COBRA elections, ACA offers, carrier files.
 * Finance and HR used to land on one sentence ("this account isn't linked
 * to a person"), because the page was only the associate's.
 */

type Row = BenefitsOverviewPlan & { clientName: string };

const perPeriod = (cents: number) => fmtMoney(cents / 100);

export function BenefitsAdminHome() {
  const { can, user } = useAuth();
  const overview = useQuery({ queryKey: ['benefits', 'overview'], queryFn: getBenefitsOverview });
  const aca = useQuery({ queryKey: ['aca', 'summary'], queryFn: getAcaSummary, retry: false });
  const hrAdmin = can('view:hr-admin');
  // A staffing firm's plans belong to its clients; a hotel's are its own.
  const staffing = useTenant().moduleOn('clientPortal');
  const sendsFiles = can('process:payroll');
  const related: RelatedLink[] = [
    ...(hrAdmin ? [{ label: 'Enrollment, life events & COBRA', to: '/benefits/lifecycle' }] : []),
    { label: 'ACA hours & filing', to: '/benefits/aca' },
    ...(sendsFiles ? [{ label: 'Carrier feeds', to: '/benefits/carriers' }] : []),
    ...(user?.associateId ? [{ label: 'Your own benefits', to: '/benefits?view=mine' }] : []),
  ];

  return (
    <ListTemplate title="Benefits" subtitle={staffing ? 'Plans by client, who’s enrolled, and what’s waiting on you.' : 'Your plans, who’s enrolled, and what’s waiting on you.'} related={related}>
      {overview.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : overview.isError ? (
        <QueryError what="the benefits overview" query={overview} />
      ) : (
        <Desk o={overview.data} acaOwed={aca.data ? aca.data.counts.offersDue + aca.data.counts.offersOverdue : null} acaOverdue={aca.data?.counts.offersOverdue ?? 0} hrAdmin={hrAdmin} staffing={staffing} />
      )}
    </ListTemplate>
  );
}

function Desk({ o, acaOwed, acaOverdue, hrAdmin, staffing }: { o: BenefitsOverview; acaOwed: number | null; acaOverdue: number; hrAdmin: boolean; staffing: boolean }) {
  const rows: Row[] = o.clients.flatMap((c) => c.plans.map((p) => ({ ...p, clientName: c.clientName })));
  const t = o.totals;
  const columns: GridColumn<Row>[] = [
    { key: 'name', header: 'Plan', accessor: (r) => r.name, sortable: true, primary: true, cell: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'kind', header: 'Kind', accessor: (r) => KIND_LABEL[r.kind], sortable: true, cardMeta: true },
    ...(staffing
      ? [
          {
            key: 'client',
            header: 'Client',
            accessor: (r: Row) => r.clientName,
            sortable: true,
            cell: (r: Row) => (
              <Link to={`/clients/${r.clientId}?section=benefits`} className="text-ink hover:text-gold hover:underline">
                {r.clientName}
              </Link>
            ),
          },
        ]
      : []),
    { key: 'enrolled', header: 'Enrolled', accessor: (r) => r.enrolled, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.enrolled ? r.enrolled : <span className="text-ink-muted">None</span>) },
    { key: 'employee', header: 'Employees put in', accessor: (r) => r.employeeCentsPerPeriod / 100, csv: (r) => (r.employeeCentsPerPeriod / 100).toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.employeeCentsPerPeriod ? perPeriod(r.employeeCentsPerPeriod) : '—') },
    { key: 'employer', header: 'Company puts in', accessor: (r) => r.employerCentsPerPeriod / 100, csv: (r) => (r.employerCentsPerPeriod / 100).toFixed(2), sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cell: (r) => (r.employerCentsPerPeriod ? perPeriod(r.employerCentsPerPeriod) : '—') },
    { key: 'status', header: 'Status', accessor: (r) => (r.isActive ? 'Offered' : 'Retired'), sortable: true, cell: (r) => (r.isActive ? <Badge size="sm" variant="success">Offered</Badge> : <Badge size="sm">Retired</Badge>) },
  ];
  const openNow = o.openEnrollment.filter((w) => w.status === 'OPEN');
  const upcoming = o.openEnrollment.filter((w) => w.status !== 'OPEN');
  const failedFeeds = (o.carriers ?? []).filter((c) => c.lastFile?.status === 'FAILED').length;
  return (
    <div className="space-y-[var(--d-stack-lg)]">
      <MetricStrip label="Benefits at a glance">
        <MetricCard label="People enrolled" value={t.enrolledPeople} hint={`${t.activePlans} ${t.activePlans === 1 ? 'plan' : 'plans'} offered`} nothing={t.activePlans === 0 ? 'No plans set up yet' : t.enrolledPeople === 0 ? 'No one enrolled yet' : undefined} />
        <MetricCard
          label="Each pay period"
          value={perPeriod(t.employeeCentsPerPeriod + t.employerCentsPerPeriod)}
          hint={`Employees ${perPeriod(t.employeeCentsPerPeriod)} · company ${perPeriod(t.employerCentsPerPeriod)}`}
          nothing={t.employeeCentsPerPeriod + t.employerCentsPerPeriod === 0 ? 'Nothing withheld yet' : undefined}
        />
        <MetricCard label="Life events waiting" value={t.lifeEventsWaiting} tone={t.lifeEventsWaiting ? 'warning' : 'default'} href={hrAdmin ? '/benefits/lifecycle?tab=qle' : undefined} nothing={t.lifeEventsWaiting ? undefined : 'No life events waiting'} />
        <MetricCard label="COBRA offers open" value={t.cobraPending} tone="neutral" hint={t.cobraPending ? 'Waiting on the person to elect or waive' : undefined} href={hrAdmin ? '/benefits/lifecycle?tab=cobra' : undefined} nothing={t.cobraPending ? undefined : 'No COBRA offers open'} />
        <MetricCard
          label="ACA offers owed"
          value={acaOwed ?? '—'}
          tone={acaOverdue ? 'alert' : acaOwed ? 'warning' : 'default'}
          hint={acaOverdue ? `${acaOverdue} overdue` : undefined}
          href="/benefits/aca"
          nothing={acaOwed === 0 ? 'Every full-timer has an offer' : undefined}
        />
        {o.carriers && (
          <MetricCard
            label="Carrier feeds"
            value={o.carriers.length}
            tone={failedFeeds ? 'alert' : 'neutral'}
            hint={failedFeeds ? `${failedFeeds} last file failed` : undefined}
            href="/benefits/carriers"
            nothing={o.carriers.length === 0 ? 'No carriers set up' : undefined}
          />
        )}
      </MetricStrip>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4 text-gold" aria-hidden="true" />
            Open enrollment
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {o.openEnrollment.length === 0 ? (
            <p className="text-ink-muted">
              No open enrollment scheduled.
              {hrAdmin && (
                <>
                  {' '}
                  <Link to="/benefits/lifecycle?tab=oe" className="text-gold hover:underline">
                    Schedule one
                  </Link>
                </>
              )}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {[...openNow, ...upcoming].map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">
                      {staffing ? `${w.clientName} · ${w.name}` : w.name}
                    </span>
                    <span className="block text-ink-muted">
                      {fmtDateOnlyRange(w.startsOn, w.endsOn)} · coverage from {fmtDateOnly(w.effectiveOn)}
                    </span>
                  </span>
                  {w.status === 'OPEN' ? <Badge size="sm" variant="success">Open now</Badge> : <Badge size="sm">Not open yet</Badge>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <DataGrid
        id="benefits-plans-by-client"
        caption={staffing ? 'Plans by client' : 'Plans'}
        noun={{ one: 'plan', many: 'plans' }}
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        defaultSort={{ key: staffing ? 'client' : 'name', direction: 'asc' }}
        empty={
          staffing
            ? { icon: HeartPulse, title: 'No plans set up yet', description: 'Each client’s plans are set up on the client’s Benefits tab; they show here with who is enrolled.', action: <Link to="/clients" className="text-sm text-gold hover:underline">Go to clients</Link> }
            : { icon: HeartPulse, title: 'No plans set up yet', description: 'Plans you offer show here with who is enrolled and what each pay period takes.' }
        }
        footnote={rows.length ? 'Contributions are per pay period, as elected — not converted to a month, because pay schedules differ.' : undefined}
      />

      {o.carriers && o.carriers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Carrier feeds</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-line text-sm">
              {o.carriers.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{c.name}</span>
                    <span className="block text-ink-muted">
                      {c.members} {c.members === 1 ? 'person' : 'people'} in the feed ·{' '}
                      {c.lastFile ? `last file ${fmtDateOnly(c.lastFile.createdAt.slice(0, 10))} (${c.lastFile.mode === 'FULL' ? 'full' : 'changes'}, #${c.lastFile.controlNumber})` : 'no file sent yet'}
                    </span>
                  </span>
                  {c.lastFile?.status === 'FAILED' ? (
                    <Badge size="sm" variant="destructive">Last file failed</Badge>
                  ) : c.lastFile?.status === 'SENT' ? (
                    <Badge size="sm" variant="success">Sent</Badge>
                  ) : c.lastFile ? (
                    <Badge size="sm" variant="pending">Made, not sent</Badge>
                  ) : (
                    <Badge size="sm">No file sent</Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
