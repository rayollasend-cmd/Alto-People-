import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartHandshake, RefreshCw } from 'lucide-react';
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
} from '@/lib/retentionApi';
import { ListTemplate } from '@/components/templates';
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
  SegmentedControl,
  SkeletonRows,
} from '@/components/ui';

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
  RECOGNITION: 'Recognise their work',
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
                {PLAY_LABEL[open.kind]} · logged {fmtRelativeDayTz(open.createdAt, null, Date.now()).toLowerCase()}
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

export function RetentionDesk() {
  const { can } = useAuth();
  const term = useTerm();
  const qc = useQueryClient();
  const [band, setBand] = useState<'AT_RISK' | 'HIGH' | 'ALL'>('AT_RISK');
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
      breadcrumbs={[{ label: 'People', to: '/people' }, { label: 'Retention' }]}
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
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="High risk" value={s.bands.HIGH} hint="Act this week" />
            <MetricCard label="Some risk" value={s.bands.MEDIUM} hint="Keep an eye on them" />
            <MetricCard label="Low risk" value={s.bands.LOW} hint="Steady" />
            <MetricCard
              label="Best play so far"
              value={bestPlay ? `${bestPlay.stayRate}%` : '—'}
              hint={bestPlay ? `stayed after “${PLAY_LABEL[bestPlay.kind].toLowerCase()}”` : 'Shows once plays have 90-day outcomes'}
            />
          </div>
        )}
        {s && s.stores.length > 0 && (
          <p className="text-sm text-ink-muted">
            Most at risk:{' '}
            {s.stores.slice(0, 4).map((st, i) => (
              <span key={st.id}>
                {i > 0 ? ', ' : ''}
                <span className="text-ink">{st.name}</span> ({[st.high ? `${st.high} at high risk` : null, st.medium ? `${st.medium} at some risk` : null].filter(Boolean).join(', ')})
              </span>
            ))}
          </p>
        )}
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
              {list.data.computedAt && <p className="mt-3 text-xs text-ink-muted">Scored {fmtRelativeDayTz(list.data.computedAt, null, Date.now()).toLowerCase()}.</p>}
            </CardContent>
          </Card>
        )}
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
