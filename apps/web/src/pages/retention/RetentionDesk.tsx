import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartHandshake, RefreshCw } from '@/components/ui/icons';
import { toast } from 'sonner';
import { useAuth, useTerm } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { fmtRelativeDayTz } from '@/lib/format';
import {
  getRetentionSummary,
  listRetention,
  logPlay,
  markPlayDone,
  recomputeRetention,
  type PlayKind,
  type RetentionItem,
  type RiskBand,
  type RetentionSummary,
} from '@/lib/retentionApi';
import { ListTemplate } from '@/components/templates';
import { ChartFrame } from '@/components/ui/ChartFrame';
import { lazyPlot } from '@/components/ui/charts/lazyPlot';
import { Avatar } from '@/components/ui/Avatar';
import { QueryError } from '@/components/ui/QueryError';
import { Input, Textarea } from '@/components/ui/Input';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  MetricCard,
  MetricStrip,
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';
import { useUrlParam } from '@/lib/useUrlState';

/** The drawings (recharts) load with the first chart, not the page (lazyPlot). */
const RiskByPlacePlot = lazyPlot(() => import('./RetentionDesk.plot').then((m) => ({ default: m.RiskByPlacePlot })));
const StayRatePlot = lazyPlot(() => import('./RetentionDesk.plot').then((m) => ({ default: m.StayRatePlot })));

/**
 * Retention: who might leave soon, why, and what to do about it this week.
 * Every score comes with its reasons; every suggestion is a conversation,
 * not a verdict. Scores are never shown to the worker, never used for
 * discipline, and use nothing about who someone is — only their schedule,
 * attendance, pay and rides (apps/api/src/lib/retention.ts).
 */

export const PLAY_LABEL: Record<PlayKind, string> = {
  MORE_HOURS: 'Offer more hours',
  CHECK_IN: 'Check in with them',
  SCHEDULE_FIX: 'Fix their schedule',
  RIDE_HELP: 'Help with their ride',
  RECOGNITION: 'Recognize their work',
  PAY_REVIEW: 'Review their pay',
};

const PLAY_HINT: Record<PlayKind, string> = {
  MORE_HOURS: 'Offer open shifts that fit their availability.',
  CHECK_IN: 'Ten minutes, one to one: how’s it going, what would help?',
  SCHEDULE_FIX: 'Ask what isn’t working about their shifts and fix the pattern.',
  RIDE_HELP: 'Help them get a ride, or find a shift that matches the bus.',
  RECOGNITION: 'Thank them by name — kudos, a note, in front of the crew.',
  PAY_REVIEW: 'Propose a new rate. A second person who holds pay decides.',
};

const BAND_LABEL: Record<RiskBand, string> = { HIGH: 'High risk', MEDIUM: 'Some risk', LOW: 'Low risk' };
const BAND_VARIANT: Record<RiskBand, 'destructive' | 'pending' | 'outline'> = { HIGH: 'destructive', MEDIUM: 'pending', LOW: 'outline' };

/** "today" mid-sentence, but a date keeps its capitals: "Scored Sat, Oct 17", never "sat, oct 17". */
function relativeDay(iso: string): string {
  const s = fmtRelativeDayTz(iso, null, Date.now());
  return /^(Today|Tomorrow|Hoy|Mañana)$/.test(s) ? s.toLowerCase() : s;
}

function ScoreBar({ score, band }: { score: number; band: RiskBand }) {
  return (
    <div className="flex items-center gap-2" aria-label={`Risk ${score} of 100, ${BAND_LABEL[band].toLowerCase()}`} role="img">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-raised">
        <div className={band === 'HIGH' ? 'h-full bg-alert' : band === 'MEDIUM' ? 'h-full bg-warning' : 'h-full bg-ink-muted/50'} style={{ width: `${Math.max(4, score)}%` }} />
      </div>
      <span className="text-xs tabular-nums text-ink-muted">{score}</span>
    </div>
  );
}

function PlayDialog({ item, kind, onClose }: { item: RetentionItem | null; kind: PlayKind | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [rate, setRate] = useState('');
  const save = useMutation({
    mutationFn: () => logPlay(item!.associateId, { kind: kind!, note: note.trim() || undefined, ...(kind === 'PAY_REVIEW' ? { proposedRate: Number(rate) } : {}) }),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Pay review sent for a second person’s decision.' : `Logged — we’ll show whether ${item!.name.split(' ')[0]} stayed in 90 days.`);
      void qc.invalidateQueries({ queryKey: ['retention'] });
      setNote('');
      setRate('');
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not log that.'),
  });
  const rateOk = kind !== 'PAY_REVIEW' || (Number(rate) > 0 && Number(rate) < 500);
  return (
    <Dialog open={!!item && !!kind} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind ? PLAY_LABEL[kind] : ''}
            {item ? ` — ${item.name}` : ''}
          </DialogTitle>
          <DialogDescription>{kind ? PLAY_HINT[kind] : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {kind === 'PAY_REVIEW' && (
            <Field label="Proposed hourly rate" required hint="It goes to someone who holds compensation; nothing changes until they approve.">
              {(p) => <Input {...p} type="number" inputMode="decimal" min={1} max={499} step="0.25" value={rate} onChange={(e) => setRate(e.target.value)} />}
            </Field>
          )}
          <Field label="What you did or plan to do (optional)">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!rateOk} loading={save.isPending}>
            {kind === 'PAY_REVIEW' ? 'Send for approval' : 'Log it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PersonRow({ item, onPlay }: { item: RetentionItem; onPlay: (k: PlayKind) => void }) {
  const term = useTerm();
  const qc = useQueryClient();
  const done = useMutation({
    mutationFn: (id: string) => markPlayDone(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['retention'] }),
    // A failed "Done" said nothing and the play stayed open (CODE-29).
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not mark that done. Try again.'),
  });
  const open = item.recentPlays.find((p) => p.status === 'OPEN');
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-3">
        <Avatar src={item.photoUrl} name={item.name} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink">{item.name}</span>
            <Badge variant={BAND_VARIANT[item.band]}>{BAND_LABEL[item.band]}</Badge>
            <ScoreBar score={item.score} band={item.band} />
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{[item.store?.name, item.client?.name].filter(Boolean).join(' · ') || `No ${term('site').toLowerCase()} yet`}</div>
          {item.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {item.reasons.map((r) => (
                <li key={r.key} className="text-sm">
                  <span className="font-medium text-ink">{r.label}.</span> <span className="text-ink-muted">{r.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">Their record looks steady.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {item.plays.map((k) => (
              <Button key={k} size="sm" variant="secondary" onClick={() => onPlay(k)}>
                {PLAY_LABEL[k]}
              </Button>
            ))}
          </div>
          {open && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span>
                {PLAY_LABEL[open.kind]} · logged {relativeDay(open.createdAt)}
                {open.approvalId ? ' · waiting on a pay decision' : ''}
              </span>
              <Button size="sm" variant="link" className="h-auto px-0" onClick={() => done.mutate(open.id)} loading={done.isPending}>
                Mark done
              </Button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

const RISK_VIEWS = ['AT_RISK', 'HIGH', 'ALL'] as const;

export function RetentionDesk() {
  const { can } = useAuth();
  const term = useTerm();
  const qc = useQueryClient();
  // ?risk=HIGH / ?risk=ALL — the view lives in the URL.
  const [band, setBand] = useUrlParam<'AT_RISK' | 'HIGH' | 'ALL'>('risk', 'AT_RISK', RISK_VIEWS);
  const [playing, setPlaying] = useState<{ item: RetentionItem; kind: PlayKind } | null>(null);
  const list = useQuery({ queryKey: ['retention', 'list', band], queryFn: () => listRetention({ band: band === 'ALL' ? undefined : band }) });
  const summary = useQuery({ queryKey: ['retention', 'summary'], queryFn: getRetentionSummary });
  const recompute = useMutation({
    mutationFn: recomputeRetention,
    onSuccess: (r) => {
      toast.success(`Scored ${r.scored} people · ${r.high} at high risk.`);
      void qc.invalidateQueries({ queryKey: ['retention'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not score right now.'),
  });
  const s = summary.data;
  const bestPlay = s?.plays.filter((p) => p.stayRate !== null && p.stayed + p.left >= 3).sort((a, b) => (b.stayRate ?? 0) - (a.stayRate ?? 0))[0];

  return (
    <ListTemplate
      title="Retention"
      subtitle={`Who might leave soon, why, and what you can do this week. Scores are a prompt for a conversation — never shown to the ${term('worker').toLowerCase()}, never used for discipline.`}
      secondaryActions={
        can('manage:org') ? (
          <Button variant="outline" size="sm" onClick={() => recompute.mutate()} loading={recompute.isPending}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Score now
          </Button>
        ) : undefined
      }
      filters={
        <SegmentedControl
          ariaLabel="Who to show"
          value={band}
          onChange={setBand}
          options={[
            { value: 'AT_RISK', label: 'At risk' },
            { value: 'HIGH', label: 'High risk' },
            { value: 'ALL', label: 'Everyone' },
          ]}
        />
      }
    >
      <div className="space-y-6">
        {s && (
          <MetricStrip label="Risk at a glance">
            <MetricCard label="High risk" value={s.bands.HIGH} hint="Act this week" tone={s.bands.HIGH > 0 ? 'alert' : 'default'} onClick={() => setBand('HIGH')} selected={band === 'HIGH'} />
            <MetricCard label="Some risk" value={s.bands.MEDIUM} hint="Keep an eye on them" />
            <MetricCard label="Low risk" value={s.bands.LOW} hint="Steady" />
            <MetricCard
              label="Best play so far"
              value={bestPlay ? `${bestPlay.stayRate}%` : '—'}
              hint={bestPlay ? `stayed after “${PLAY_LABEL[bestPlay.kind].toLowerCase()}”` : undefined}
              nothing={bestPlay ? undefined : 'Shows once plays have 90-day outcomes'}
            />
          </MetricStrip>
        )}
        {s && s.stores.length > 0 && <RiskByPlace stores={s.stores} />}
        {list.isError ? (
          <QueryError what="retention" query={list} />
        ) : list.isLoading || !list.data ? (
          <Card>
            <CardContent className="p-4">
              <SkeletonRows count={5} />
            </CardContent>
          </Card>
        ) : list.data.items.length === 0 ? (
          <Card>
            <CardContent className="p-0">
              <EmptyState
                icon={HeartHandshake}
                title={band === 'ALL' ? 'No scores yet' : 'Nobody at risk right now'}
                description={
                  list.data.computedAt || band !== 'ALL'
                    ? 'Scores refresh every night from schedules, attendance, pay and rides. When someone’s pattern changes, they show up here with the reasons.'
                    : 'Scores are computed every night. Someone who manages the organization can score now.'
                }
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4 md:p-5">
              <ul className="divide-y divide-line">
                {list.data.items.map((i) => (
                  <PersonRow key={i.associateId} item={i} onPlay={(kind) => setPlaying({ item: i, kind })} />
                ))}
              </ul>
              {list.data.truncated && <p className="mt-3 text-xs text-ink-muted">Showing the 500 highest scores.</p>}
              {list.data.computedAt && <p className="mt-3 text-xs text-ink-muted">Scored {relativeDay(list.data.computedAt)}.</p>}
            </CardContent>
          </Card>
        )}
        {s && s.plays.some((p) => p.stayRate !== null) && <StayRateChart plays={s.plays} />}
        {s && s.plays.some((p) => p.taken > 0) && (
          <section aria-labelledby="ret-plays">
            <h2 id="ret-plays" className="mb-2 text-sm font-medium text-ink">
              Which plays keep people
            </h2>
            <Card>
              <CardContent className="p-4">
                <ul className="divide-y divide-line">
                  {s.plays
                    .filter((p) => p.taken > 0)
                    .map((p) => (
                      <li key={p.kind} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className="text-ink">{PLAY_LABEL[p.kind]}</span>
                        <span className="tabular-nums text-ink-muted">
                          {p.taken} taken · {p.stayed} stayed · {p.left} left{p.pending ? ` · ${p.pending} too soon to tell` : ''}
                          {p.stayRate !== null ? ` · ${p.stayRate}% stayed` : ''}
                        </span>
                      </li>
                    ))}
                </ul>
              </CardContent>
            </Card>
          </section>
        )}
      </div>
      <PlayDialog item={playing?.item ?? null} kind={playing?.kind ?? null} onClose={() => setPlaying(null)} />
    </ListTemplate>
  );
}

/** Where the risk sits: high and some risk, stacked, for every location with anyone at risk. */
function RiskByPlace({ stores }: { stores: RetentionSummary['stores'] }) {
  const term = useTerm();
  const rows = [...stores].sort((a, b) => b.high - a.high || b.medium - a.medium).map((st) => ({ name: st.name, high: st.high, medium: st.medium }));
  const shown = rows.slice(0, 12);
  const place = term('label.store').toLowerCase();
  const top = rows[0];
  return (
    <ChartFrame
      title={`At risk, by ${place}`}
      description={rows.length > shown.length ? `The ${shown.length} with the most people at risk — the table has all ${rows.length}.` : undefined}
      summary={top ? `${top.name} has the most people at risk: ${top.high} high and ${top.medium} some.` : 'Nobody at risk.'}
      csvName="retention-by-location"
      height={Math.max(140, shown.length * 30 + 40)}
      columns={[
        { key: 'name', label: term('label.store') },
        { key: 'high', label: 'High risk', numeric: true },
        { key: 'medium', label: 'Some risk', numeric: true },
      ]}
      rows={rows}
    >
      <RiskByPlacePlot shown={shown} />
    </ChartFrame>
  );
}

/** Of the people a play was tried with, the share still here 90 days on. */
function StayRateChart({ plays }: { plays: RetentionSummary['plays'] }) {
  const rows = plays
    .filter((p) => p.stayRate !== null)
    .sort((a, b) => (b.stayRate ?? 0) - (a.stayRate ?? 0))
    .map((p) => ({ play: PLAY_LABEL[p.kind], stayRate: p.stayRate, measured: p.stayed + p.left }));
  return (
    <ChartFrame
      title="Stayed 90 days, by play"
      description="Only plays with a 90-day outcome count. A small number of people makes a rate shaky — the table has how many."
      summary={`${rows[0]!.play} kept the most: ${rows[0]!.stayRate}% stayed.`}
      csvName="retention-plays"
      height={Math.max(140, rows.length * 32 + 30)}
      columns={[
        { key: 'play', label: 'Play' },
        { key: 'stayRate', label: 'Stayed', numeric: true, format: (v) => `${v}%` },
        { key: 'measured', label: 'People measured', numeric: true },
      ]}
      rows={rows}
    >
      <StayRatePlot rows={rows} />
    </ChartFrame>
  );
}
