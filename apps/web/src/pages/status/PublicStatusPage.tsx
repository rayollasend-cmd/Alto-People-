import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleDashed, Mail, ShieldAlert, TriangleAlert } from 'lucide-react';
import {
  STATUS_INCIDENT_STATE_LABELS,
  STATUS_STATE_LABELS,
  type PublicStatus,
  type StatusComponentPublic,
  type StatusDayPublic,
  type StatusIncidentPublic,
  type StatusState,
} from '@alto-people/shared';
import { confirmStatusSubscription, getPublicStatus, subscribeToStatus, unsubscribeFromStatus } from '@/lib/statusApi';
import { ApiError } from '@/lib/api';
import { fmtDateOnly, fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { PublicShell } from '@/components/trust/PublicShell';

/**
 * The public status page (beside the Trust Center): is the platform up,
 * component by component, and what the team has posted about it. No
 * sign-in, no app chrome, the Trust Center's look. One hero (the overall
 * state), the components as a list, the incidents as a timeline, and an
 * honest empty state when there has been nothing to report.
 */

const TONE: Record<StatusState, { text: string; ring: string; fill: string; Icon: typeof CheckCircle2 }> = {
  OPERATIONAL: { text: 'text-positive', ring: 'border-positive/30', fill: 'bg-positive/15', Icon: CheckCircle2 },
  DEGRADED: { text: 'text-caution', ring: 'border-caution/40', fill: 'bg-caution/15', Icon: TriangleAlert },
  OUTAGE: { text: 'text-negative', ring: 'border-negative/40', fill: 'bg-negative/15', Icon: ShieldAlert },
  UNMEASURED: { text: 'text-ink-muted', ring: 'border-line', fill: 'bg-surface-raised', Icon: CircleDashed },
};

const HEADLINE: Record<StatusState, string> = {
  OPERATIONAL: 'All systems operational',
  DEGRADED: 'Some systems are degraded',
  OUTAGE: 'A system is down',
  UNMEASURED: 'No recent activity to grade',
};

function stateBadge(state: StatusState) {
  const variant = state === 'OPERATIONAL' ? 'success' : state === 'DEGRADED' ? 'pending' : state === 'OUTAGE' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{STATUS_STATE_LABELS[state]}</Badge>;
}

function Hero({ data }: { data: PublicStatus }) {
  const tone = TONE[data.overall];
  const open = data.incidents.filter((i) => i.state !== 'RESOLVED').length;
  return (
    <Card className={tone.ring}>
      <CardContent className="grid gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-center">
        <div className={cn('grid h-16 w-16 place-items-center rounded-full', tone.fill, tone.text)} aria-hidden="true">
          <tone.Icon className="h-8 w-8" />
        </div>
        <div className="min-w-0">
          <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Right now</div>
          <h2>
            <span className={cn('mt-1 block font-sans text-3xl font-semibold tracking-tight', tone.text)}>{HEADLINE[data.overall]}</span>
          </h2>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">
            {open === 0 ? 'No open incidents.' : open === 1 ? 'One open incident, below.' : `${open} open incidents, below.`} Checked {fmtDateTime(data.generatedAt)}; this page refreshes every minute.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

const CELL: Record<StatusState, string> = {
  OPERATIONAL: 'bg-positive/70',
  DEGRADED: 'bg-caution/80',
  OUTAGE: 'bg-negative/80',
  UNMEASURED: 'bg-line',
};

/** Ninety days, one cell each, coloured by the day's worst state — the same days the % counts (F500 G5). */
function UptimeBar({ days, label }: { days: StatusDayPublic[]; label: string }) {
  const count = (s: StatusState) => days.filter((d) => d.state === s).length;
  const summary = `${label}, last 90 days: ${count('OPERATIONAL')} operational, ${count('DEGRADED')} degraded, ${count('OUTAGE')} down, ${count('UNMEASURED')} not measured.`;
  return (
    <div className="mt-2">
      <div className="flex h-7 gap-px" role="img" aria-label={summary} data-testid="uptime-bar">
        {days.map((d) => (
          <span
            key={d.date}
            className={cn('min-w-0 flex-1 rounded-[1px]', CELL[d.state])}
            title={`${fmtDateOnly(d.date)} · ${STATUS_STATE_LABELS[d.state]}${d.pct !== null ? ` · ${d.pct}%` : ''}`}
            data-state={d.state}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-ink-subtle" aria-hidden="true">
        <span>90 days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function ComponentRow({ c }: { c: StatusComponentPublic }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-ink">{c.label}</div>
          <div className="mt-0.5 text-xs2 text-ink-muted">{c.what}</div>
          <div className="mt-1 text-xs2 text-ink-muted">{c.note}</div>
        </div>
        <div className="flex items-center gap-4">
          {c.uptime90d !== null && (
            <span className="text-xs2 tabular-nums text-ink-muted">
              {c.uptime90d}% <span className="text-ink-subtle">· 90 days</span>
            </span>
          )}
          {stateBadge(c.state)}
        </div>
      </div>
      {c.days && c.days.length > 0 && <UptimeBar days={c.days} label={c.label} />}
    </li>
  );
}

/**
 * "Get updates by email" (F500 G5): double opt-in — the answer is the same
 * whether or not the address was already on the list — and the emailed
 * confirm / unsubscribe links land back here (?confirm= / ?unsubscribe=).
 */
function Subscribe() {
  const [email, setEmail] = useState('');
  const [params, setParams] = useSearchParams();
  const [linkResult, setLinkResult] = useState<{ ok: boolean; text: string } | null>(null);
  const handled = useRef(false);
  const ask = useMutation({ mutationFn: (e: string) => subscribeToStatus(e) });
  useEffect(() => {
    if (handled.current) return;
    const confirm = params.get('confirm');
    const unsub = params.get('unsubscribe');
    if (!confirm && !unsub) return;
    handled.current = true;
    const run = confirm ? confirmStatusSubscription(confirm) : unsubscribeFromStatus(unsub!);
    void run
      .then(() => setLinkResult({ ok: true, text: confirm ? 'You’re subscribed. We’ll email you when an incident starts and when it’s resolved.' : 'You’re unsubscribed. No more status emails.' }))
      .catch((err) => setLinkResult({ ok: false, text: err instanceof ApiError ? err.message : 'That link didn’t work. Try again from the status page.' }))
      .finally(() => {
        const next = new URLSearchParams(params);
        next.delete('confirm');
        next.delete('unsubscribe');
        setParams(next, { replace: true });
      });
  }, [params, setParams]);
  return (
    <section aria-labelledby="status-subscribe">
      <SectionTitle id="status-subscribe" title="Get updates by email" description="An email when an incident starts and when it’s resolved. We confirm the address first, and every email has a link to stop them." />
      <Card>
        <CardContent>
          {linkResult && (
            <p role="status" className={cn('mb-3 text-sm', linkResult.ok ? 'text-positive' : 'text-negative')} data-testid="status-link-result">
              {linkResult.text}
            </p>
          )}
          {ask.isSuccess ? (
            <p role="status" className="text-sm text-ink" data-testid="status-subscribe-done">
              Check your inbox: we sent a link to confirm {email}.
            </p>
          ) : (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim()) ask.mutate(email.trim());
              }}
            >
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Email for status updates" autoComplete="email" className="sm:max-w-xs" />
              <Button type="submit" loading={ask.isPending}>
                <Mail className="h-4 w-4" aria-hidden="true" />
                Get updates
              </Button>
            </form>
          )}
          {ask.isError && (
            <p className="mt-2 text-sm text-negative">{ask.error instanceof ApiError ? ask.error.message : 'That didn’t go through. Try again.'}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Incident({ i, componentLabel }: { i: StatusIncidentPublic; componentLabel: string }) {
  const resolved = i.state === 'RESOLVED';
  return (
    <Card>
      <CardContent>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h3 className="text-base font-medium text-ink">{i.title}</h3>
            <div className="mt-0.5 text-xs2 text-ink-muted">
              {componentLabel} · {i.impact === 'OUTAGE' ? 'Outage' : 'Degraded'} · started {fmtDateTime(i.startedAt)}
              {resolved && i.resolvedAt ? ` · resolved ${fmtDateTime(i.resolvedAt)}` : ''}
            </div>
          </div>
          <Badge variant={resolved ? 'success' : i.impact === 'OUTAGE' ? 'destructive' : 'pending'}>{STATUS_INCIDENT_STATE_LABELS[i.state]}</Badge>
        </div>
        <ol className="mt-4 space-y-3 border-l border-line pl-4">
          {[...i.updates].reverse().map((u) => (
            <li key={`${u.at}-${u.state}`} className="text-sm">
              <div className="text-xs2 text-ink-muted">
                <span className="font-medium text-ink">{STATUS_INCIDENT_STATE_LABELS[u.state]}</span> · {fmtDateTime(u.at)}
              </div>
              <p className="mt-0.5 text-ink">{u.note}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function PublicStatusPage() {
  const q = useQuery({ queryKey: ['status', 'public'], queryFn: getPublicStatus, staleTime: 60_000, refetchInterval: 60_000 });
  const labels = Object.fromEntries((q.data?.components ?? []).map((c) => [c.key, c.label]));
  return (
    <PublicShell eyebrow="Status">
      <div>
        <div className="mb-1 text-2xs uppercase tracking-[0.18em] text-ink-muted">Status</div>
        <PageHeader
          title="Is the platform up?"
          subtitle="Each line is measured from the platform’s own traffic, not reported by hand; the incidents are posted by the team that runs it. No customer’s numbers appear here."
        />
      </div>
      {q.isLoading ? (
        <SkeletonRows count={5} />
      ) : q.isError || !q.data ? (
        <QueryError what="the status page" query={q} />
      ) : (
        <>
          <Hero data={q.data} />
          <section aria-labelledby="status-components">
            <SectionTitle id="status-components" title="Components" description="How each part of the platform is doing, with the share of the last 90 days without a bad day where that is measured." />
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-line">
                  {q.data.components.map((c) => (
                    <ComponentRow key={c.key} c={c} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          </section>
          <section aria-labelledby="status-incidents" className="space-y-4">
            <SectionTitle id="status-incidents" title="Incidents" description="Open incidents first, then what was resolved in the last 90 days." />
            {q.data.incidents.length === 0 ? (
              <EmptyState icon={Activity} title="No incidents in the last 90 days" description="When something is wrong, the team posts it here and keeps it updated until it is resolved." />
            ) : (
              q.data.incidents.map((i) => <Incident key={i.id} i={i} componentLabel={labels[i.component] ?? i.component} />)
            )}
          </section>
          <Subscribe />
        </>
      )}
    </PublicShell>
  );
}
