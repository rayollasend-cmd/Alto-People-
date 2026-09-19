import { useMemo, useState } from 'react';
import { CalendarCheck, MessageSquare, Search, Trophy, Waypoints } from 'lucide-react';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { DeskChip, FacePile, OwnerControl, SectionHead } from './RelayParts';
import {
  DESK_BAR,
  STAGE_LABELS,
  claimKey,
  type Claim,
  type Desk,
  type DeskPerson,
  type Lane,
  type RelayBoardData,
  type StageKey,
} from './relayTypes';

/**
 * The first-paycheck pipeline — every new hire's run from approval to a
 * first check, as a board: six stages, each owned by a desk, with the
 * people standing at each one. Tap a stage to see its lanes; tap a lane
 * for its timeline, its next move, and the conversation about it.
 */

const STAGES: StageKey[] = ['approved', 'scheduled', 'fieldglass', 'firstShift', 'hoursApproved', 'paycheck'];
const DAY_MS = 86_400_000;

export function dueText(dueAt: string | null, overdue: boolean): string | null {
  if (!dueAt) return null;
  const days = Math.round((Date.parse(dueAt) - Date.now()) / DAY_MS);
  if (overdue) return days === 0 ? 'late today' : `${Math.max(1, -days)}d late`;
  if (days <= 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}

export function RelayPipeline({
  data,
  lens,
  claims,
  desks,
  meId,
  onOpenLane,
  onChanged,
}: {
  data: RelayBoardData;
  lens: Desk | 'ALL';
  claims: Record<string, Claim>;
  desks: Record<Desk, DeskPerson[]> | undefined;
  meId: string | undefined;
  onOpenLane: (associateId: string) => void;
  onChanged: () => void;
}) {
  const [stage, setStage] = useState<StageKey | null>(null);
  const [search, setSearch] = useState('');
  const [stalledOnly, setStalledOnly] = useState(false);

  const current = (l: Lane) => l.stages.find((s) => s.key === l.currentStage) ?? null;
  const byStage = useMemo(() => {
    const m = new Map<StageKey, Lane[]>();
    for (const l of data.lanes) {
      if (!l.currentStage) continue;
      m.set(l.currentStage, [...(m.get(l.currentStage) ?? []), l]);
    }
    return m;
  }, [data.lanes]);

  const lanes = data.lanes.filter((l) => {
    const cur = current(l);
    if (lens !== 'ALL' && cur?.desk !== lens) return false;
    if (stage && l.currentStage !== stage) return false;
    if (stalledOnly && !l.stalled) return false;
    const q = search.trim().toLowerCase();
    return !q || `${l.name} ${l.clientName ?? ''}`.toLowerCase().includes(q);
  });
  const stalled = data.lanes.filter((l) => l.stalled).length;
  const p = data.promise;

  return (
    <section aria-labelledby="relay-pipeline">
      <SectionHead
        icon={Waypoints}
        title="First-paycheck pipeline"
        meta={data.lanes.length === 0 ? 'no lanes open' : `${data.lanes.length} in flight${stalled ? ` · ${stalled} stalled` : ''}`}
        id="relay-pipeline"
      >
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-0.5 text-xs text-gold"
          title="Kept when the first check lands within 21 days of the first shift worked — never late, never short."
        >
          <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
          {p.keptPct !== null ? `${p.keptPct}% of promises kept` : 'Promise: no checks yet'}
          {p.medianDays !== null && <span className="text-gold/70">· median {p.medianDays}d</span>}
          <span className="text-gold/60">· {p.windowDays} days</span>
        </span>
      </SectionHead>

      {/* The stages, left to right — each a filter. */}
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[40rem] grid-cols-6 gap-1.5" role="group" aria-label="Pipeline stages">
          {STAGES.map((key, i) => {
            const here = byStage.get(key) ?? [];
            const late = here.filter((l) => l.stalled).length;
            const desk = data.lanes[0]?.stages.find((s) => s.key === key)?.desk ?? (key === 'fieldglass' || key === 'paycheck' ? 'FINANCE' : key === 'approved' ? 'HR' : 'WORKFORCE');
            const on = stage === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setStage(on ? null : key)}
                className={cn(
                  'group relative flex flex-col overflow-hidden rounded-lg border bg-navy/60 px-2.5 pb-2 pt-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                  on ? 'border-gold/70 ring-1 ring-gold/50' : 'border-navy-secondary hover:border-gold/30',
                )}
              >
                <span className={cn('absolute inset-x-0 top-0 h-1', DESK_BAR[desk])} aria-hidden="true" />
                <span className="min-h-[2rem] text-2xs font-semibold uppercase leading-tight tracking-wider text-silver/70">
                  {i + 1}. {STAGE_LABELS[key]}
                </span>
                <span className="mt-1 flex items-baseline gap-1.5">
                  <span className={cn('text-2xl font-semibold tabular-nums', here.length === 0 ? 'text-silver/40' : late ? 'text-alert' : 'text-white')}>{here.length}</span>
                  {late > 0 && <span className="text-2xs font-medium text-alert">{late} late</span>}
                </span>
                <span className="mb-1.5 mt-1.5 flex h-6 items-center">
                  <FacePile people={here.map((l) => ({ key: l.associateId, name: l.name, photoUrl: `/api/associates/${l.associateId}/photo` }))} max={3} />
                </span>
                <DeskChip desk={desk} className="mt-auto self-start pt-0.5" />
              </button>
            );
          })}
        </div>
      </div>

      <Card className="mt-2 overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-navy-secondary/60 p-2.5">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-silver/60" aria-hidden="true" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a new hire…" aria-label="Find a new hire" className="h-9 pl-8" />
          </div>
          <button
            type="button"
            aria-pressed={stalledOnly}
            onClick={() => setStalledOnly((v) => !v)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
              stalledOnly ? 'border-alert/60 bg-alert/15 text-alert' : 'border-navy-secondary text-silver hover:text-white',
            )}
          >
            Stalled only{stalled ? ` (${stalled})` : ''}
          </button>
          {stage && (
            <Button size="xs" variant="secondary" onClick={() => setStage(null)} aria-label={`Show every stage, not just ${STAGE_LABELS[stage]}`}>
              {STAGE_LABELS[stage]} ✕
            </Button>
          )}
        </div>
        {lanes.length === 0 ? (
          <p className="px-4 py-4 text-sm text-silver">
            {data.lanes.length === 0
              ? 'No first-paycheck lanes in flight — every recent hire has been paid.'
              : 'No lanes match — clear a filter to see the rest.'}
          </p>
        ) : (
          <ul className="divide-y divide-navy-secondary/60">
            {lanes.map((l) => {
              const cur = current(l);
              const due = cur ? dueText(cur.dueAt, cur.overdue) : null;
              return (
                <li key={l.associateId} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5', l.stalled && 'bg-alert/[0.04]')}>
                  <button
                    type="button"
                    onClick={() => onOpenLane(l.associateId)}
                    className="group flex min-w-0 flex-1 items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
                    aria-label={`Open ${l.name}’s lane`}
                  >
                    <Avatar src={`/api/associates/${l.associateId}/photo`} name={l.name} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-white group-hover:text-gold-bright">{l.name}</span>
                        {(l.notes ?? 0) > 0 && (
                          <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-silver/70" title={`${l.notes} notes in the thread`}>
                            <MessageSquare className="h-3 w-3" aria-hidden="true" />
                            {l.notes}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-silver/60">
                        {l.clientName ?? 'No client yet'} · approved {fmtDate(l.approvedAt)}
                      </span>
                    </span>
                  </button>
                  {/* The six segments, labeled for everyone. */}
                  <span className="order-last flex w-full items-center gap-2 sm:order-none sm:w-56">
                    <span className="flex flex-1 gap-0.5" role="img" aria-label={`${l.stages.filter((s) => s.done).length} of 6 stages done${cur ? `; now at ${STAGE_LABELS[cur.key]}` : ''}`}>
                      {l.stages.map((s) => (
                        <span
                          key={s.key}
                          title={`${STAGE_LABELS[s.key]}${s.done && s.at ? ` — ${fmtDate(s.at)}` : s.dueAt ? ` — by ${fmtDate(s.dueAt)}` : ''}`}
                          className={cn(
                            'h-1.5 flex-1 rounded-full',
                            s.done
                              ? 'bg-gold/80'
                              : s.key === l.currentStage
                                ? s.overdue
                                  ? 'bg-alert animate-pulse motion-reduce:animate-none'
                                  : 'bg-warning/80 animate-pulse motion-reduce:animate-none'
                                : 'bg-navy-secondary',
                          )}
                        />
                      ))}
                    </span>
                  </span>
                  {cur && (
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs text-white">{STAGE_LABELS[cur.key]}</span>
                        <DeskChip desk={cur.desk} />
                      </span>
                      {due && <span className={cn('text-2xs tabular-nums', cur.overdue ? 'font-semibold text-alert' : 'text-silver/70')}>{due}</span>}
                    </span>
                  )}
                  <OwnerControl
                    subjectType="LANE"
                    subjectKey={l.associateId}
                    what={`${l.name}’s lane`}
                    claim={claims[claimKey('LANE', l.associateId)]}
                    desks={desks}
                    meId={meId}
                    onChanged={onChanged}
                    compact
                  />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {data.recentKept.length > 0 && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-silver/70">
          <CalendarCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          Recently paid:
          {data.recentKept.map((k) => (
            <button key={k.associateId} type="button" onClick={() => onOpenLane(k.associateId)} className="tabular-nums hover:text-white">
              {k.name} ({k.days}d{k.kept ? '' : ' · late'})
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
