import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Briefcase, CheckCircle2, ChevronRight, Eye, History, MapPin, Pencil, Save } from 'lucide-react';
import { toast } from 'sonner';
import type { ClientActivityItem, ClientHealth, ClientNeedsYouItem, ClientOverview as Overview, ClientSummary } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { updateClient } from '@/lib/clientsApi';
import { clientOverviewKey, getClientOverview, listOwnerOptions } from '@/lib/clientAccountApi';
import { displayLocale, fmtDate, fmtHours, fmtMoney, fmtMonthYearTz, fmtPercent, fmtRelativeDate } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { DeltaChip, MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ClientContactsCard } from './ClientContactsCard';
import { termsLabel } from './ClientBasicsCard';
import { useCanSeeClientPerformance } from './ClientPerformance';

/**
 * The client's Overview — the first screen of the account (CL-A,
 * 2026-10-22). It answers "how is this account doing, and what needs me?"
 * before anything about configuring it:
 *
 *   KPIs        people on assignment, hours this week against the same
 *               point last week, fill rate for the next 7 days, overtime
 *               last week; for statements readers, what the client owes
 *               (aged), what was billed this month and the margin. Each
 *               tile opens the list behind it.
 *   Needs you   risks first, each with the exact count and a link.
 *   Account     owner, contract term with days left, payment terms.
 *   Contacts, locations, recent activity.
 *
 * Numbers that cannot be computed say so ("No hours yet"); money is
 * absent, not zero, for people who cannot read statements.
 */

export function useClientOverview(clientId: string) {
  return useQuery({ queryKey: clientOverviewKey(clientId), queryFn: () => getClientOverview(clientId), staleTime: 60_000 });
}

/** A count with grouping: 1,284. */
export const fmtCount = (n: number) => n.toLocaleString(displayLocale());

/** A same-page link to one of the record's tabs. */
const tabLink = (key: string) => ({ search: `?section=${key}` });

export function ClientOverview({
  client,
  onOpenTab,
  onSaved,
}: {
  client: ClientSummary;
  onOpenTab: (key: string) => void;
  onSaved: (c: ClientSummary) => void;
}) {
  const { can } = useAuth();
  const q = useClientOverview(client.id);
  const location = useLocation();

  // "#account" / "#contacts" links from the needs-you list land on their card.
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (!loaded || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [loaded, location.hash]);

  if (q.isError) return <QueryError what="this account's overview" query={q} />;
  if (!q.data) {
    return (
      <div className="space-y-6" aria-busy="true">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }
  const o = q.data;
  const canManage = can('manage:clients');
  return (
    <div className="space-y-6" data-testid="client-overview">
      <KpiStrip o={o} clientId={client.id} />
      {/* Desktop: what needs you, then the activity, beside the account. A phone
          reads needs-you, the account and its people, and the activity last. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <NeedsYouCard items={o.needsYou} health={o.kpis?.health ?? null} reasons={o.kpis?.healthReasons ?? []} />
        </div>
        <div className="min-w-0 space-y-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <AccountCard client={client} o={o} canManage={canManage} onSaved={onSaved} />
          <ClientContactsCard clientId={client.id} clientName={client.name} contacts={o.contacts} canManage={canManage} />
          <LocationsCard o={o} onOpenTab={onOpenTab} />
        </div>
        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <ActivityCard items={o.recentActivity} />
        </div>
      </div>
    </div>
  );
}

/* ----- KPIs ------------------------------------------------------------------ */

/** Long figures ("$987,654.32", "31,245.75h") step down a size in a half-width phone tile instead of running out of it. */
const LONG_FIGURE = 9;

function Tile(props: { to: string | { search: string } | null; label: string; value: ReactNode; hint?: ReactNode; accent?: boolean; className?: string; testId?: string; wide?: boolean }) {
  const { to, testId, className, wide, ...raw } = props;
  const rest = { ...raw, value: !wide && typeof raw.value === 'string' && raw.value.length >= LONG_FIGURE ? <span className="text-[0.75em] sm:text-[1em]">{raw.value}</span> : raw.value };
  const wrap = to ? (card: ReactElement) => <Link to={to} className={cn('block min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright', className)} data-testid={testId}>{card}</Link> : undefined;
  if (wrap) return <MetricCard {...rest} wrap={wrap} cta={false} className="h-full" />;
  return (
    <div className={cn('min-w-0', className)} data-testid={testId}>
      <MetricCard {...rest} className="h-full" />
    </div>
  );
}

/** A KPI that can't be a number this week says so in its value slot (not an empty state). */
const NO_HOURS = 'No hours yet';

/** Words in the value slot ("No hours yet") read smaller than a number. */
const Words = ({ children }: { children: ReactNode }) => <span className="text-xl leading-tight">{children}</span>;

const AGING = [
  { key: 'current', label: 'Not yet due', tone: 'bg-success/60' },
  { key: 'd1_30', label: '1–30 days', tone: 'bg-warning/50' },
  { key: 'd31_60', label: '31–60', tone: 'bg-warning/80' },
  { key: 'd61_90', label: '61–90', tone: 'bg-alert/60' },
  { key: 'd90plus', label: 'Over 90', tone: 'bg-alert' },
] as const;

function KpiStrip({ o, clientId }: { o: Overview; clientId: string }) {
  const { can } = useAuth();
  const showPerformance = useCanSeeClientPerformance();
  const k = o.kpis;
  if (!k) {
    return <EmptyState size="sm" icon={AlertTriangle} title="The account's numbers could not be worked out just now." description="The rest of the page is current." />;
  }
  const m = k.money;
  const peopleTo = can('view:org') ? `/people?client=${clientId}&status=ACTIVE` : null;
  const timeTo = can('manage:time') ? `/time-attendance/timesheets?client=${clientId}` : null;
  const shiftsTo = can('view:scheduling') ? `/scheduling?client=${clientId}&open=1` : null;
  const month = fmtMonthYearTz(new Date(o.asOf));

  return (
    <section aria-label="How the account is doing" className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="client-kpis">
      {m && (
        <>
          <Tile
            to={tabLink('statements')}
            testId="kpi-outstanding"
            wide
            className="col-span-2"
            label="Outstanding"
            value={fmtMoney(m.outstanding)}
            accent={m.aging.d31_60 + m.aging.d61_90 + m.aging.d90plus > 0}
            hint={<AgingBar m={m} />}
          />
          <Tile
            to={tabLink('statements')}
            testId="kpi-billed"
            label="Billed this month"
            value={fmtMoney(m.billedThisMonth)}
            hint={m.lastStatementTotal !== null && m.lastStatementAt ? `Last statement ${fmtMoney(m.lastStatementTotal)}, ${fmtDate(m.lastStatementAt)}` : `No statement finalized in ${month}`}
          />
          <Tile
            to={showPerformance ? tabLink('performance') : tabLink('settings')}
            testId="kpi-margin"
            label="Margin"
            value={m.marginPct !== null ? fmtPercent(m.marginPct) : <Words>{m.billedThisMonth > 0 ? 'Not yet' : 'Nothing billed'}</Words>}
            accent={m.marginPct !== null && m.targetMarginPct !== null && m.marginPct < m.targetMarginPct}
            hint={m.billedThisMonth > 0 ? marginHint(m.marginPct, m.targetMarginPct) : `Nothing billed in ${month} to measure${m.targetMarginPct !== null ? ` (target ${fmtPercent(m.targetMarginPct)})` : ''}.`}
          />
        </>
      )}
      <Tile
        to={peopleTo}
        testId="kpi-people"
        label="On assignment"
        value={fmtCount(k.onAssignment)}
        hint={peopleHint(k.onAssignment, o.locations)}
      />
      <Tile to={timeTo} testId="kpi-hours" label="Hours this week" value={k.hoursThisWeek > 0 ? fmtHours(k.hoursThisWeek) : <Words>{NO_HOURS}</Words>} hint={<HoursHint k={k} />} />
      <Tile
        to={shiftsTo}
        testId="kpi-fill"
        label="Fill rate, next 7 days"
        value={k.fillRatePct !== null ? fmtPercent(k.fillRatePct) : <Words>No shifts</Words>}
        accent={k.fillRatePct !== null && k.fillRatePct < 95}
        hint={k.fillRatePct !== null ? `${fmtCount(k.shiftsNext7.filled)} of ${fmtCount(k.shiftsNext7.total)} shifts filled` : 'None published for the next 7 days'}
      />
      <Tile
        to={timeTo}
        testId="kpi-overtime"
        label="Overtime last week"
        value={k.overtimePct !== null ? fmtPercent(k.overtimePct) : <Words>No hours</Words>}
        hint={k.overtimePct !== null ? `Of ${fmtHours(k.hoursLastWeek)} worked` : 'None worked last week'}
      />
    </section>
  );
}

/** Where the people are: the busiest store, from the same count. */
function peopleHint(total: number, locations: Overview['locations']): string {
  if (total <= 0) return 'No one working here now';
  const top = locations.items[0];
  if (!top || top.onAssignment <= 0) return 'Placed here and working recently';
  if (top.onAssignment === total) return `All at ${top.name}`;
  return `${fmtCount(top.onAssignment)} at ${top.name}, the busiest`;
}

function marginHint(margin: number | null, target: number | null): string {
  if (margin === null) return target !== null ? `Target ${fmtPercent(target)}. Shows once this month's billed hours are paid.` : "Shows once this month's billed hours are paid.";
  if (target === null) return 'No target set';
  const diff = Math.round((margin - target) * 10) / 10;
  if (diff === 0) return `On the ${fmtPercent(target)} target`;
  return `${Math.abs(diff)} pts ${diff > 0 ? 'over' : 'under'} the ${fmtPercent(target)} target`;
}

function HoursHint({ k }: { k: NonNullable<Overview['kpis']> }) {
  if (k.hoursChangePct !== null && k.hoursLastWeekToDate !== null) {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        {/* The label wraps beside the chip rather than truncating in a narrow tile. */}
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <DeltaChip delta={k.hoursChangePct} format={(n) => `${n}%`} good="up" />
          <span>vs {fmtHours(k.hoursLastWeekToDate)} by now last week</span>
        </span>
        <span>Last week in all: {fmtHours(k.hoursLastWeek)}</span>
      </span>
    );
  }
  return <>{k.hoursLastWeek > 0 ? `Last week: ${fmtHours(k.hoursLastWeek)}` : 'None last week either'}</>;
}

function AgingBar({ m }: { m: NonNullable<NonNullable<Overview['kpis']>['money']> }) {
  const total = AGING.reduce((s, a) => s + m.aging[a.key], 0);
  if (total <= 0) return <>Every finalized statement is paid.</>;
  return (
    <span className="block" data-testid="aging-bar">
      <span className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-surface-raised" role="img" aria-label={`By age: ${AGING.map((a) => `${a.label} ${fmtMoney(m.aging[a.key])}`).join(', ')}`}>
        {AGING.map((a) => (m.aging[a.key] > 0 ? <span key={a.key} className={a.tone} style={{ width: `${(m.aging[a.key] / total) * 100}%` }} /> : null))}
      </span>
      <span className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-5">
        {AGING.map((a) => (
          // A phone lists only the buckets that hold money; the bar still shows them all.
          <span key={a.key} className={cn('min-w-0', m.aging[a.key] <= 0 && 'hidden sm:block')}>
            <span className="flex items-center gap-1.5 text-2xs text-ink-muted">
              <span className={cn('h-2 w-2 shrink-0 rounded-sm', a.tone)} aria-hidden="true" />
              {a.label}
            </span>
            <span className="block tabular-nums text-ink">{fmtMoney(m.aging[a.key])}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/* ----- Needs you ---------------------------------------------------------------- */

export const HEALTH: Record<ClientHealth, { label: string; variant: 'success' | 'pending' | 'destructive' }> = {
  good: { label: 'Healthy', variant: 'success' },
  watch: { label: 'Watch', variant: 'pending' },
  risk: { label: 'At risk', variant: 'destructive' },
};

function NeedsYouCard({ items, health, reasons }: { items: ClientNeedsYouItem[]; health: ClientHealth | null; reasons: string[] }) {
  return (
    <Card id="needs-you" className="scroll-mt-24">
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          as="h3"
          icon={AlertTriangle}
          title="Needs you"
          trailing={
            health ? (
              <Badge variant={HEALTH[health].variant} title={reasons.length ? reasons.join('\n') : undefined} data-testid="client-health">
                {HEALTH[health].label}
              </Badge>
            ) : undefined
          }
        />
        {items.length === 0 ? (
          <EmptyState size="sm" icon={CheckCircle2} title="Nothing needs you on this account." />
        ) : (
          <ul className="-mx-2 divide-y divide-line" data-testid="needs-you">
            {items.map((n) => (
              <li key={n.kind}>
                <Link to={n.href} className="group flex items-start gap-3 rounded-md px-2 py-3 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright">
                  {n.severity === 'risk' ? (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alert" aria-label="Risk" />
                  ) : (
                    <Eye className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Watch" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{n.title}</span>
                    <span className="block text-xs text-ink-muted">{n.detail}</span>
                  </span>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- Recent activity ----------------------------------------------------------- */

function ActivityCard({ items }: { items: ClientActivityItem[] }) {
  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle as="h3" icon={History} title="Recent activity" />
        {items.length === 0 ? (
          <EmptyState size="sm" title="No activity on record for this account." description="Statements, client requests, portal logins, rate changes and contacts show here as they happen." />
        ) : (
          <ol className="space-y-3" data-testid="client-activity">
            {items.map((a) => (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent/70" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  {a.href ? (
                    <Link to={a.href} className="text-ink hover:text-accent hover:underline">
                      {a.text}
                    </Link>
                  ) : (
                    <span className="text-ink">{a.text}</span>
                  )}
                  <span className="block text-xs text-ink-muted">
                    {a.actor ? `${a.actor} · ` : ''}
                    <time dateTime={a.at} title={fmtDate(a.at)}>
                      {fmtRelativeDate(a.at)}
                    </time>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- Account: owner, contract, terms -------------------------------------------- */

export function contractWords(c: Overview['contract']): { text: string; tone: 'default' | 'pending' | 'destructive' } | null {
  if (c.daysLeft === null) return null;
  if (c.daysLeft < 0) return { text: `Ended ${-c.daysLeft === 1 ? '1 day' : `${-c.daysLeft} days`} ago`, tone: 'destructive' };
  if (c.daysLeft === 0) return { text: 'Ends today', tone: 'destructive' };
  const text = `${c.daysLeft === 1 ? '1 day' : `${c.daysLeft} days`} left`;
  return { text, tone: c.daysLeft <= 30 ? 'destructive' : c.daysLeft <= 60 ? 'pending' : 'default' };
}

function AccountCard({ client, o, canManage, onSaved }: { client: ClientSummary; o: Overview; canManage: boolean; onSaved: (c: ClientSummary) => void }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(o.owner?.id ?? '');
  const [start, setStart] = useState(o.contract.start ?? '');
  const [end, setEnd] = useState(o.contract.end ?? '');
  const [saving, setSaving] = useState(false);
  const options = useQuery({ queryKey: ['clients', client.id, 'owner-options'], queryFn: () => listOwnerOptions(client.id), enabled: editing, staleTime: 5 * 60_000 });

  const open = () => {
    setOwner(o.owner?.id ?? '');
    setStart(o.contract.start ?? '');
    setEnd(o.contract.end ?? '');
    setEditing(true);
  };
  const dirty = owner !== (o.owner?.id ?? '') || start !== (o.contract.start ?? '') || end !== (o.contract.end ?? '');
  const badDates = !!start && !!end && end < start;

  const save = async () => {
    if (badDates) {
      toast.error('The contract cannot end before it starts.');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateClient(client.id, { accountOwnerUserId: owner || null, contractStartDate: start || null, contractEndDate: end || null });
      onSaved(updated);
      await queryClient.invalidateQueries({ queryKey: clientOverviewKey(client.id) });
      setEditing(false);
      toast.success('Account saved.');
    } catch (err) {
      toast.error('Could not save.', { description: err instanceof ApiError ? err.message : 'Something went wrong.' });
    } finally {
      setSaving(false);
    }
  };

  const left = contractWords(o.contract);
  return (
    <Card id="account" className="scroll-mt-24">
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          as="h3"
          icon={Briefcase}
          title="Account"
          trailing={
            canManage && !editing ? (
              <Button size="sm" variant="outline" onClick={open}>
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            ) : undefined
          }
        />
        {!editing ? (
          <dl className="space-y-3 text-sm" data-testid="client-account">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 text-ink-muted">Owner</dt>
              <dd className="min-w-0 text-right">
                {o.owner ? (
                  <a href={`mailto:${o.owner.email}`} className="text-ink hover:text-accent hover:underline" title={o.owner.email}>
                    {o.owner.name}
                  </a>
                ) : (
                  <span className="text-ink-muted">No one named</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 text-ink-muted">Contract</dt>
              <dd className="min-w-0 text-right">
                {o.contract.start || o.contract.end ? (
                  <span className="text-ink">
                    {o.contract.start ? fmtDate(o.contract.start) : 'No start'} – {o.contract.end ? fmtDate(o.contract.end) : 'open-ended'}
                  </span>
                ) : (
                  <span className="text-ink-muted">No dates on file</span>
                )}
                {left && (
                  <Badge variant={left.tone} size="sm" className="ml-2 align-middle" withDot={false}>
                    {left.text}
                  </Badge>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="shrink-0 text-ink-muted">Payment terms</dt>
              <dd className="text-right text-ink">{termsLabel(o.paymentTermsDays)}</dd>
            </div>
          </dl>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Account owner" hint="Who at your company runs this account.">
              {(p) => (
                <Select value={owner} onChange={(e) => setOwner(e.target.value)} disabled={options.isPending} {...p}>
                  <option value="">No one named</option>
                  {/* The current owner stays selectable while the list loads (or if they can no longer own accounts). */}
                  {o.owner && !options.data?.options.some((x) => x.id === o.owner!.id) && <option value={o.owner.id}>{o.owner.name}</option>}
                  {(options.data?.options ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name === x.email ? x.email : `${x.name} (${x.email})`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Contract starts">
                {(p) => <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} {...p} />}
              </Field>
              <Field label="Contract ends" error={badDates ? 'Ends before it starts.' : undefined}>
                {(p) => <Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} {...p} />}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={!dirty || badDates} loading={saving}>
                <Save className="h-3.5 w-3.5" />
                Save
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/* ----- Locations ------------------------------------------------------------------- */

function LocationsCard({ o, onOpenTab }: { o: Overview; onOpenTab: (key: string) => void }) {
  const { count, items } = o.locations;
  return (
    <Card>
      <CardContent className="p-[var(--d-card)]">
        <SectionTitle
          as="h3"
          icon={MapPin}
          title={`Locations${count ? ` (${count})` : ''}`}
          trailing={
            count > 0 ? (
              <Button size="xs" variant="ghost" onClick={() => onOpenTab('locations')}>
                {count > items.length ? `All ${fmtCount(count)} locations` : 'Manage'}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            ) : undefined
          }
        />
        {items.length === 0 ? (
          <EmptyState
            size="sm"
            title="No active locations."
            action={
              <Button size="sm" variant="outline" onClick={() => onOpenTab('locations')}>
                Open Locations
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-line" data-testid="client-locations">
            {items.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block break-words text-ink">{l.name}</span>
                  {(l.city || l.state) && <span className="block text-xs text-ink-muted">{[l.city, l.state].filter(Boolean).join(', ')}</span>}
                </span>
                <span className="shrink-0 text-right text-xs text-ink-muted">
                  <span className="tabular-nums text-ink">{fmtCount(l.onAssignment)}</span> on assignment
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
