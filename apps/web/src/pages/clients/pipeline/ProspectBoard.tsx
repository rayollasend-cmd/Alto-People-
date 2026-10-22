import { useState } from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { OPEN_PROSPECT_STAGES, type OpenProspectStage, type ProspectRow, type ProspectStageKey } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtMoneyCompact } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { MoveMenu, ProspectCardBody, STAGE_LABEL, STAGE_TONE, WonClientLine, fmtWeight, sumWeighted, type CardActions } from './pipelineShared';

/**
 * The pipeline as a board (lg and up): the four working stages share the
 * width, and the outcomes — Won and Lost — sit folded in one narrower column
 * at the end, still drop targets. A card drags to another stage, or moves
 * from its menu; Won and Lost open their own steps (create the client; say
 * why) before anything is saved.
 */

interface BoardProps extends CardActions {
  rows: ProspectRow[];
  today: string;
  money: boolean;
  weights: Record<OpenProspectStage, number>;
  pendingId: string | null;
}

export function ProspectBoard({ rows, today, money, weights, pendingId, ...actions }: BoardProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const byStage = (s: ProspectStageKey) => rows.filter((r) => r.stage === s);
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const p = rows.find((r) => r.id === String(e.active.id));
    const to = String(e.over.id) as ProspectStageKey;
    if (!p || p.stage === to) return;
    actions.onMove(p, to);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {/* Below xl the four stages share the width and the outcomes sit in a
          row beneath; from xl they are a fifth, narrower column. Nothing
          scrolls sideways at 1024 or at 1440. */}
      <div role="group" aria-label="Pipeline board" className="grid grid-cols-4 gap-3 pb-2 xl:flex" data-testid="pipeline-board">
        {OPEN_PROSPECT_STAGES.map((stage) => {
          const list = byStage(stage);
          return (
            <StageColumn
              key={stage}
              stage={stage}
              count={list.length}
              subtitle={
                <span className="tabular-nums">
                  {fmtWeight(weights[stage])} chance
                  {money && list.length > 0 && <> · {fmtMoneyCompact(sumWeighted(list))} weighted</>}
                </span>
              }
            >
              {list.map((p) => (
                <BoardCard key={p.id} p={p} today={today} money={money} pending={pendingId === p.id} actions={actions} />
              ))}
            </StageColumn>
          );
        })}
        <section aria-label="Closed" className="col-span-4 grid grid-cols-2 items-start gap-3 xl:block xl:w-48 xl:shrink-0 xl:space-y-3 2xl:w-56">
          {(['WON', 'LOST'] as const).map((stage) => (
            <OutcomeSection key={stage} stage={stage} rows={byStage(stage)} today={today} money={money} pendingId={pendingId} actions={actions} />
          ))}
        </section>
      </div>
    </DndContext>
  );
}

function StageColumn({ stage, count, subtitle, children }: { stage: OpenProspectStage; count: number; subtitle: React.ReactNode; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STAGE_LABEL[stage]}, ${count} prospect${count === 1 ? '' : 's'}`}
      data-stage={stage}
      className={cn(
        'flex min-w-0 flex-col rounded-lg border border-t-2 border-line bg-surface transition-colors xl:min-w-[11rem] xl:flex-1 xl:basis-0',
        STAGE_TONE[stage],
        isOver && 'bg-surface-raised ring-1 ring-accent/50',
      )}
    >
      <header className="border-b border-line px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs2 font-medium uppercase tracking-[0.18em] text-ink-muted">{STAGE_LABEL[stage]}</h3>
          <Badge variant="outline" className="tabular-nums">
            {count}
          </Badge>
        </div>
        <div className="mt-0.5 text-2xs text-ink-muted">{subtitle}</div>
      </header>
      <ul className="max-h-[70vh] min-h-[8rem] flex-1 space-y-2 overflow-y-auto p-2">
        {count === 0 ? <li className="select-none py-6 text-center text-xs2 text-ink-subtle">Drop a prospect here</li> : children}
      </ul>
    </section>
  );
}

function OutcomeSection({
  stage,
  rows,
  today,
  money,
  pendingId,
  actions,
}: {
  stage: 'WON' | 'LOST';
  rows: ProspectRow[];
  today: string;
  money: boolean;
  pendingId: string | null;
  actions: CardActions;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });
  // Folded by default: the outcomes are the record, not the work.
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STAGE_LABEL[stage]}, ${rows.length}`}
      data-stage={stage}
      className={cn('rounded-lg border border-t-2 border-line bg-surface transition-colors', STAGE_TONE[stage], isOver && 'bg-surface-raised ring-1 ring-accent/50')}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <span className="inline-flex items-center gap-1 text-xs2 font-medium uppercase tracking-[0.18em] text-ink-muted">
          <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
          {STAGE_LABEL[stage]}
        </span>
        <Badge variant="outline" className="tabular-nums">
          {rows.length}
        </Badge>
      </button>
      {open && (
        <ul className="max-h-[50vh] space-y-1.5 overflow-y-auto px-2 pb-2">
          {rows.length === 0 ? (
            <li className="py-3 text-center text-xs2 text-ink-subtle">Drop a prospect here</li>
          ) : (
            rows.map((p) => <BoardCard key={p.id} p={p} today={today} money={money} pending={pendingId === p.id} actions={actions} compact />)
          )}
        </ul>
      )}
    </section>
  );
}

function BoardCard({ p, today, money, pending, actions, compact = false }: { p: ProspectRow; today: string; money: boolean; pending: boolean; actions: CardActions; compact?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: p.id, disabled: !actions.canWrite });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 } : undefined;
  // dnd-kit's role/tabIndex would make a second tab stop; the card is one button.
  const { role: _role, tabIndex: _tab, ...dragAttributes } = attributes;
  return (
    <li className="group relative" style={style} data-testid="prospect-card">
      <div
        ref={setNodeRef}
        {...(actions.canWrite ? dragAttributes : {})}
        {...(actions.canWrite ? listeners : {})}
        role="button"
        tabIndex={0}
        aria-label={`${p.name}, ${STAGE_LABEL[p.stage]}. Open details`}
        aria-busy={pending || undefined}
        onClick={() => actions.onOpen(p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actions.onOpen(p);
          }
        }}
        className={cn(
          'rounded-md border border-line bg-surface-sunken text-left elev-1 transition-all',
          compact ? 'px-2.5 py-2' : 'p-3',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright hover:border-ink-subtle',
          actions.canWrite ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
          isDragging && 'opacity-60 ring-1 ring-accent/60',
          pending && 'opacity-60',
        )}
      >
        <ProspectCardBody p={p} today={today} money={money} compact={compact} />
        <WonClientLine p={p} actions={actions} />
      </div>
      {actions.canWrite && <MoveMenu p={p} onMove={(to) => actions.onMove(p, to)} className="absolute right-1.5 top-1.5" />}
    </li>
  );
}
