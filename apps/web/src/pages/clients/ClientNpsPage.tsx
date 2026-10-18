import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, MessageSquareQuote, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ApiError } from '@/lib/api';
import { useAuth, useTerm } from '@/lib/auth';
import { getNpsResults, remindNpsWave, sendNpsWave, type NpsResults } from '@/lib/npsApi';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Client NPS: one question, once a quarter, to every store manager with a
 * portal account, answered on a signed link outside the portal. This page
 * is the result — the quarter's score, each client's, the trend, and what
 * they wrote — for the executive and marketing; a person with
 * manage:clients sends the wave or a reminder from here.
 */

const LINE = 'rgb(var(--color-chart-1))';
const MUTED = 'rgb(var(--color-silver))';

function tone(nps: number | null): string {
  if (nps === null) return 'text-ink-muted';
  if (nps >= 50) return 'text-success';
  if (nps >= 0) return 'text-warning';
  return 'text-alert';
}

export function NpsNumber({ nps, className }: { nps: number | null; className?: string }) {
  return <span className={cn('tabular-nums', tone(nps), className)}>{nps === null ? '—' : nps > 0 ? `+${nps}` : String(nps)}</span>;
}

export function ClientNpsPage() {
  const { can } = useAuth();
  const term = useTerm();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['executive', 'nps'], queryFn: getNpsResults });
  const r: NpsResults | null = q.data ?? null;
  const canSend = can('manage:clients');
  const send = useMutation({
    mutationFn: () => sendNpsWave(),
    onSuccess: (out) => {
      toast.success(`${out.quarter} survey sent to ${out.invited} store manager${out.invited === 1 ? '' : 's'}.`);
      void queryClient.invalidateQueries({ queryKey: ['executive', 'nps'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the survey.'),
  });
  const remind = useMutation({
    mutationFn: remindNpsWave,
    onSuccess: (out) => toast.success(out.reminded ? `Reminded ${out.reminded} who had not answered.` : 'Everyone has answered or was already reminded.'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send reminders.'),
  });
  const cur = r?.current ?? null;
  const trend = (r?.trend ?? []).map((t) => ({ quarter: t.quarter, nps: t.nps ?? 0, responded: t.responded }));

  return (
    <ListTemplate
      title={`${term('label.client')} NPS`}
      topbarTitle="Client NPS"
      subtitle="How likely each store is to recommend you — one question a quarter, straight to leadership."
      breadcrumbs={[{ label: term('nav.clients'), to: '/clients' }, { label: `${term('label.client')} NPS` }]}
      primaryAction={
        canSend ? (
          r?.canSendQuarter ? (
            <Button loading={send.isPending} onClick={() => send.mutate()}>
              <Send className="h-4 w-4" aria-hidden="true" />
              Send {r.canSendQuarter} survey
            </Button>
          ) : cur?.open ? (
            <Button variant="outline" loading={remind.isPending} onClick={() => remind.mutate()}>
              Remind who hasn&rsquo;t answered
            </Button>
          ) : undefined
        ) : undefined
      }
      summary={
        q.isError ? undefined : cur ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label={`NPS · ${cur.quarter}`} value={<NpsNumber nps={cur.nps} />} hint={cur.open ? `open until ${fmtDate(cur.closesAt)}` : `closed ${fmtDate(cur.closesAt)}`} accent />
            <MetricCard label="Answered" value={`${cur.responded} / ${cur.invited}`} hint={cur.responsePct === null ? undefined : `${cur.responsePct}% response`} />
            <MetricCard label="Promoters" value={cur.promoters} hint="scored 9 or 10" />
            <MetricCard label="Detractors" value={cur.detractors} hint="scored 0 to 6" />
          </div>
        ) : r ? (
          <EmptyState
            icon={MessageSquareQuote}
            title="No survey sent yet"
            description={canSend ? 'Send this quarter’s one question to every store manager with a portal account.' : 'The first wave goes out in the first week of a quarter.'}
            className="py-6"
          />
        ) : (
          <Skeleton className="h-24" />
        )
      }
    >
      {q.isError ? (
        <QueryError what="client NPS" query={q} />
      ) : !r ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="p-4 md:p-5">
                <SectionTitle title={`By ${term('label.client').toLowerCase()}`} description="Lowest first — the conversations to have this week." as="h3" />
                {r.byClient.length === 0 ? (
                  <EmptyState title="No answers yet" description="Each client shows here as its store managers answer." className="py-6" />
                ) : (
                  <ul className="mt-2 divide-y divide-line">
                    {r.byClient.map((c) => {
                      const delta = c.nps !== null && c.previousNps !== null ? c.nps - c.previousNps : null;
                      return (
                        <li key={c.clientId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0 text-sm">
                          <Link to={`/clients/${c.clientId}`} className="min-w-0 flex-1 truncate text-ink hover:text-accent hover:underline">
                            {c.clientName}
                          </Link>
                          <span className="text-xs tabular-nums text-ink-muted">
                            {c.responded}/{c.invited} answered{c.avgScore !== null ? ` · avg ${c.avgScore}` : ''}
                          </span>
                          {delta !== null && delta !== 0 && (
                            <span className={cn('inline-flex items-center gap-0.5 text-xs tabular-nums', delta > 0 ? 'text-success' : 'text-alert')}>
                              {delta > 0 ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />}
                              {Math.abs(delta)}
                            </span>
                          )}
                          <NpsNumber nps={c.nps} className="w-12 text-right text-base font-semibold" />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 md:p-5">
                <SectionTitle title="Over time" description="NPS by quarter." as="h3" />
                {trend.length < 2 ? (
                  <p className="mt-2 text-sm text-ink-muted">The trend draws once two quarters have been asked.</p>
                ) : (
                  <div className="mt-2 h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                        <CartesianGrid stroke="rgb(var(--color-silver) / 0.12)" vertical={false} />
                        <XAxis dataKey="quarter" tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} />
                        <YAxis domain={[-100, 100]} tick={{ fill: MUTED, fontSize: 11 }} axisLine={false} tickLine={false} width={40} />
                        <Tooltip contentStyle={{ background: 'rgb(var(--color-surface-raised))', border: '1px solid rgb(var(--color-line))', borderRadius: 8, fontSize: 12 }} />
                        <Area type="monotone" dataKey="nps" name="NPS" stroke={LINE} strokeWidth={2} fill={LINE} fillOpacity={0.15} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <section aria-labelledby="nps-comments" className="space-y-3">
            <SectionTitle id="nps-comments" title="In their words" description="The latest comments this quarter." />
            {r.comments.length === 0 ? (
              <EmptyState icon={MessageSquareQuote} title="No comments yet" description="A store manager's own words appear here as they answer." className="py-6" />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {r.comments.map((c, i) => (
                  <li key={i}>
                    <Card>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-ink">{c.clientName}</span>
                          <Badge variant={c.score >= 9 ? 'success' : c.score >= 7 ? 'pending' : 'destructive'}>{c.score} / 10</Badge>
                        </div>
                        <p className="mt-2 text-sm text-ink-muted">&ldquo;{c.comment}&rdquo;</p>
                        <div className="mt-1 text-2xs text-ink-muted">{fmtDate(c.at)}</div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </ListTemplate>
  );
}
