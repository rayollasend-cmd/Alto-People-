import { useState } from 'react';
import { ChevronDown, ChevronRight } from '@/components/ui/icons';
import { OPEN_PROSPECT_STAGES, type OpenProspectStage, type ProspectRow, type ProspectStageKey } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtMoneyCompact } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { MoveMenu, ProspectCardBody, STAGE_LABEL, WonClientLine, fmtWeight, sumWeighted, type CardActions } from './pipelineShared';

/**
 * The pipeline on a phone: one list, a section per working stage, the
 * outcomes folded at the end. A drag fights the scroll on a touch screen,
 * so each card moves from its menu.
 */

interface ListProps extends CardActions {
  rows: ProspectRow[];
  today: string;
  money: boolean;
  weights: Record<OpenProspectStage, number>;
  pendingId: string | null;
}

export function ProspectList({ rows, today, money, weights, pendingId, ...actions }: ListProps) {
  const byStage = (s: ProspectStageKey) => rows.filter((r) => r.stage === s);
  return (
    <div className="space-y-5" data-testid="pipeline-list">
      {OPEN_PROSPECT_STAGES.map((stage) => {
        const list = byStage(stage);
        if (list.length === 0) return null;
        return (
          <section key={stage} aria-label={`${STAGE_LABEL[stage]}, ${list.length}`}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs2 font-medium uppercase tracking-[0.18em] text-ink-muted">
                {STAGE_LABEL[stage]} <span className="tabular-nums">· {list.length}</span>
              </h3>
              <span className="text-2xs tabular-nums text-ink-muted">
                {fmtWeight(weights[stage])}
                {money && <> · {fmtMoneyCompact(sumWeighted(list))} weighted</>}
              </span>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
              {list.map((p) => (
                <ListRow key={p.id} p={p} today={today} money={money} pending={pendingId === p.id} actions={actions} />
              ))}
            </ul>
          </section>
        );
      })}
      {(['WON', 'LOST'] as const).map((stage) => (
        <Outcome key={stage} stage={stage} rows={byStage(stage)} today={today} money={money} pendingId={pendingId} actions={actions} />
      ))}
    </div>
  );
}

function Outcome({ stage, rows, today, money, pendingId, actions }: { stage: 'WON' | 'LOST'; rows: ProspectRow[]; today: string; money: boolean; pendingId: string | null; actions: CardActions }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  if (rows.length === 0) return null;
  return (
    <section aria-label={`${STAGE_LABEL[stage]}, ${rows.length}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <span className="inline-flex items-center gap-1 text-xs2 font-medium uppercase tracking-[0.18em] text-ink-muted">
          <Chevron className="h-4 w-4" aria-hidden="true" />
          {STAGE_LABEL[stage]}
        </span>
        <Badge variant="outline" className="tabular-nums">
          {rows.length}
        </Badge>
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {rows.map((p) => (
            <ListRow key={p.id} p={p} today={today} money={money} pending={pendingId === p.id} actions={actions} compact />
          ))}
        </ul>
      )}
    </section>
  );
}

function ListRow({ p, today, money, pending, actions, compact = false }: { p: ProspectRow; today: string; money: boolean; pending: boolean; actions: CardActions; compact?: boolean }) {
  return (
    <li className={cn('relative', pending && 'opacity-60')} data-testid="prospect-row">
      <button
        type="button"
        onClick={() => actions.onOpen(p)}
        aria-label={`${p.name}, ${STAGE_LABEL[p.stage]}. Open details`}
        className="block w-full px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold-bright active:bg-surface-raised"
      >
        <ProspectCardBody p={p} today={today} money={money} compact={compact} />
      </button>
      {p.stage === 'WON' && (
        <div className="px-4 pb-3">
          <WonClientLine p={p} actions={actions} />
        </div>
      )}
      {actions.canWrite && <MoveMenu p={p} onMove={(to) => actions.onMove(p, to)} className="absolute right-1 top-1" />}
    </li>
  );
}
