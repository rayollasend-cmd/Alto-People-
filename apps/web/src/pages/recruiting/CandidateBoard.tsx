import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { ArrowRightLeft, FileText, Link2 } from 'lucide-react';
import type { Candidate, CandidateBoardResponse, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { SOURCE_LABEL, STAGE_LABEL, daysSince } from './recruitingLabels';

/**
 * The pipeline as a board.
 *
 * It used to be seven fixed 288px columns — about 2,100px — so on a 1440px
 * screen Offer was cut off and Hired and Rejected sat off to the right. The
 * four working stages now share the width, and the outcomes (hired,
 * rejected, withdrawn) share one column: drop targets with their latest
 * few, and the rest a click away in the list.
 *
 * Every column is a page from the server — the board no longer holds the
 * whole pipeline — with "Show more" underneath.
 *
 * Keyboard: the board is one Tab stop. Arrow keys move between cards,
 * Enter opens one, and M opens "Move to…" — the same moves a drag makes,
 * for anyone not using a mouse (or on a phone, where a drag fights the
 * scroll).
 */

const OPEN: CandidateStage[] = ['APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER'];
const OUTCOMES: CandidateStage[] = ['HIRED', 'REJECTED', 'WITHDRAWN'];
/** Keyboard order: the columns left to right, the outcomes top to bottom. */
const NAV_ORDER: CandidateStage[] = [...OPEN, ...OUTCOMES];
const TERMINAL: ReadonlySet<CandidateStage> = new Set(OUTCOMES);
/** How many of each outcome the board shows before "See all". */
const OUTCOME_PREVIEW = 4;

const STAGE_COL_TONE: Record<CandidateStage, string> = {
  APPLIED: 'border-t-silver/50',
  SCREENING: 'border-t-warning',
  INTERVIEW: 'border-t-accent',
  OFFER: 'border-t-gold',
  HIRED: 'border-t-success',
  WITHDRAWN: 'border-t-silver/30',
  REJECTED: 'border-t-alert',
};

type Column = CandidateBoardResponse['columns'][number];

interface CandidateBoardProps {
  columns: Column[];
  pendingId: string | null;
  canManage: boolean;
  /** Move a candidate. Rejected, withdrawn and hired open their dialogs. */
  onMove: (c: Candidate, target: CandidateStage) => void;
  onOpen: (c: Candidate) => void;
  /** The next page of one working column. */
  onLoadMore: (stage: CandidateStage) => void;
  loadingMore: CandidateStage | null;
  /** Everyone with this outcome, in the list. */
  onSeeAll: (stage: CandidateStage) => void;
}

export function CandidateBoard({
  columns,
  pendingId,
  canManage,
  onMove,
  onOpen,
  onLoadMore,
  loadingMore,
  onSeeAll,
}: CandidateBoardProps) {
  const byStage = useMemo(() => new Map(columns.map((c) => [c.stage, c])), [columns]);
  // The cards as the keyboard walks them, per stage, as drawn.
  const lists = useMemo(
    () =>
      NAV_ORDER.map((stage) => {
        const cands = byStage.get(stage)?.candidates ?? [];
        return TERMINAL.has(stage) ? cands.slice(0, OUTCOME_PREVIEW) : cands;
      }),
    [byStage],
  );

  /* ----- Roving focus -------------------------------------------------- */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const boardHasFocus = useRef(false);
  const firstId = lists.find((l) => l.length)?.[0]?.id ?? null;
  const allIds = useMemo(() => new Set(lists.flat().map((c) => c.id)), [lists]);
  // The card that holds the board's one Tab stop.
  const tabId = activeId && allIds.has(activeId) ? activeId : firstId;

  const focusCard = useCallback((id: string) => {
    setActiveId(id);
    cardRefs.current.get(id)?.focus();
  }, []);

  // After a move the card re-renders in its new column; keep focus on it.
  useEffect(() => {
    if (!boardHasFocus.current || !activeId) return;
    const el = cardRefs.current.get(activeId);
    if (el && document.activeElement !== el && !menuFor) el.focus();
  }, [columns, activeId, menuFor]);

  const onCardKey = (e: KeyboardEvent, c: Candidate) => {
    const col = lists.findIndex((l) => l.some((x) => x.id === c.id));
    const row = lists[col]!.findIndex((x) => x.id === c.id);
    const go = (dc: number, target: 'same' | 'first' | 'last' = 'same') => {
      for (let i = col + dc; i >= 0 && i < lists.length; i += dc) {
        const l = lists[i]!;
        if (!l.length) continue;
        const r = target === 'first' ? 0 : target === 'last' ? l.length - 1 : Math.min(row, l.length - 1);
        focusCard(l[r]!.id);
        return;
      }
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (row < lists[col]!.length - 1) focusCard(lists[col]![row + 1]!.id);
        else if (col >= OPEN.length) go(1, 'first'); // down the outcome sections
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (row > 0) focusCard(lists[col]![row - 1]!.id);
        else if (col > OPEN.length) go(-1, 'last');
        break;
      case 'ArrowRight':
        e.preventDefault();
        go(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        go(-1);
        break;
      case 'Home':
        e.preventDefault();
        focusCard(lists[col]![0]!.id);
        break;
      case 'End':
        e.preventDefault();
        focusCard(lists[col]![lists[col]!.length - 1]!.id);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onOpen(c);
        break;
      case 'm':
      case 'M':
      case 'ContextMenu':
        if (canManage && !TERMINAL.has(c.stage)) {
          e.preventDefault();
          setMenuFor(c.id);
        }
        break;
      case 'F10':
        if (e.shiftKey && canManage && !TERMINAL.has(c.stage)) {
          e.preventDefault();
          setMenuFor(c.id);
        }
        break;
    }
  };

  /* ----- Drag and drop (pointer) -------------------------------------- */
  // 6px before a drag starts, so a click stays a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const id = String(e.active.id);
    const target = String(e.over.id) as CandidateStage;
    const c = columns.flatMap((x) => x.candidates).find((x) => x.id === id);
    if (!c || c.stage === target || TERMINAL.has(c.stage)) return;
    setActiveId(c.id);
    onMove(c, target);
  };

  const cardProps = (c: Candidate, index: number, total: number) => ({
    candidate: c,
    positionLabel: `${STAGE_LABEL[c.stage]}, ${index + 1} of ${total}`,
    pending: pendingId === c.id,
    canManage,
    tabbable: c.id === tabId,
    menuOpen: menuFor === c.id,
    onMenuOpenChange: (open: boolean) => setMenuFor(open ? c.id : null),
    onMove: (target: CandidateStage) => {
      setActiveId(c.id);
      onMove(c, target);
    },
    onOpen,
    onKeyDown: (e: KeyboardEvent) => onCardKey(e, c),
    onFocus: () => setActiveId(c.id),
    refFn: (el: HTMLElement | null) => {
      if (el) cardRefs.current.set(c.id, el);
      else cardRefs.current.delete(c.id);
    },
  });

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <p id="board-keys" className="mb-2 hidden text-2xs text-silver/70 sm:block">
        Keyboard: arrows move between candidates · Enter opens · M moves to another stage
      </p>
      <div
        role="group"
        aria-label="Candidate pipeline"
        aria-describedby="board-keys"
        onFocus={() => (boardHasFocus.current = true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) boardHasFocus.current = false;
        }}
        // Phones swipe a column at a time; wider screens share the width
        // and only scroll when the columns would be narrower than 12rem.
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-2 sm:snap-none"
      >
        {OPEN.map((stage) => {
          const col = byStage.get(stage) ?? { stage, total: 0, candidates: [] };
          return (
            <StageColumn
              key={stage}
              column={col}
              loadingMore={loadingMore === stage}
              onLoadMore={() => onLoadMore(stage)}
            >
              {col.candidates.map((c, i) => (
                <CandidateCard key={c.id} {...cardProps(c, i, col.total)} />
              ))}
            </StageColumn>
          );
        })}
        <section
          aria-label="Outcomes"
          className="w-[85vw] shrink-0 snap-start space-y-3 sm:w-auto sm:min-w-[11rem] sm:flex-[0.85] sm:basis-0"
        >
          {OUTCOMES.map((stage) => {
            const col = byStage.get(stage) ?? { stage, total: 0, candidates: [] };
            return (
              <OutcomeSection key={stage} column={col} onSeeAll={() => onSeeAll(stage)}>
                {col.candidates.slice(0, OUTCOME_PREVIEW).map((c, i) => (
                  <CandidateCard key={c.id} {...cardProps(c, i, col.total)} compact />
                ))}
              </OutcomeSection>
            );
          })}
        </section>
      </div>
    </DndContext>
  );
}

function StageColumn({
  column,
  loadingMore,
  onLoadMore,
  children,
}: {
  column: Column;
  loadingMore: boolean;
  onLoadMore: () => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage });
  const shown = column.candidates.length;
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STAGE_LABEL[column.stage]}, ${column.total} candidate${column.total === 1 ? '' : 's'}`}
      className={cn(
        'w-[85vw] shrink-0 snap-start rounded-md border border-t-2 border-navy-secondary bg-navy/40 transition-colors',
        'sm:w-auto sm:min-w-[12rem] sm:flex-1 sm:basis-0',
        STAGE_COL_TONE[column.stage],
        isOver && 'bg-navy-secondary/40 ring-1 ring-gold/50',
      )}
    >
      <div className="flex items-center justify-between border-b border-navy-secondary px-3 py-2">
        <h3 className="text-xs2 uppercase tracking-widest text-silver">{STAGE_LABEL[column.stage]}</h3>
        <Badge variant="outline" className="tabular-nums">
          {column.total}
        </Badge>
      </div>
      <ul className="max-h-[calc(100vh-24rem)] min-h-[120px] space-y-2 overflow-y-auto p-2">
        {shown === 0 ? (
          <li className="select-none py-6 text-center text-xs2 text-silver/70">Drop here</li>
        ) : (
          children
        )}
        {shown < column.total && (
          <li>
            <Button size="sm" variant="ghost" className="w-full" loading={loadingMore} disabled={loadingMore} onClick={onLoadMore}>
              Show more ({column.total - shown} left)
            </Button>
          </li>
        )}
      </ul>
    </section>
  );
}

function OutcomeSection({
  column,
  onSeeAll,
  children,
}: {
  column: Column;
  onSeeAll: () => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: column.stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${STAGE_LABEL[column.stage]}, ${column.total}`}
      className={cn(
        'rounded-md border border-t-2 border-navy-secondary bg-navy/40 transition-colors',
        STAGE_COL_TONE[column.stage],
        isOver && 'bg-navy-secondary/40 ring-1 ring-gold/50',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <h3 className="text-xs2 uppercase tracking-widest text-silver">{STAGE_LABEL[column.stage]}</h3>
        <Badge variant="outline" className="tabular-nums">
          {column.total}
        </Badge>
      </div>
      {column.total > 0 && (
        <ul className="space-y-1.5 px-2 pb-2">
          {children}
          {column.total > OUTCOME_PREVIEW && (
            <li>
              <button
                type="button"
                onClick={onSeeAll}
                className="w-full rounded px-1 py-1 text-left text-2xs text-gold hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
              >
                See all {column.total} in the list
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function CandidateCard({
  candidate,
  positionLabel,
  pending,
  canManage,
  tabbable,
  menuOpen,
  onMenuOpenChange,
  onMove,
  onOpen,
  onKeyDown,
  onFocus,
  refFn,
  compact = false,
}: {
  candidate: Candidate;
  positionLabel: string;
  pending: boolean;
  canManage: boolean;
  tabbable: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onMove: (target: CandidateStage) => void;
  onOpen: (c: Candidate) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onFocus: () => void;
  refFn: (el: HTMLElement | null) => void;
  compact?: boolean;
}) {
  const locked = TERMINAL.has(candidate.stage) || !canManage;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: candidate.id,
    disabled: locked,
  });
  const cardEl = useRef<HTMLElement | null>(null);
  const fullName = `${candidate.firstName} ${candidate.lastName}`;
  const inStage = daysSince(candidate.stageChangedAt);
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 } : undefined;
  const source = candidate.source ? (SOURCE_LABEL[candidate.source] ?? candidate.source) : null;

  // dnd-kit's own role/tabIndex would make the card a second Tab stop;
  // the roving tabIndex below owns keyboard focus.
  const { role: _role, tabIndex: _tab, ...dragAttributes } = attributes;

  return (
    <li className="group relative" style={style}>
      <div
        ref={(el) => {
          setNodeRef(el);
          cardEl.current = el;
          refFn(el);
        }}
        {...(locked ? {} : dragAttributes)}
        {...(locked ? {} : listeners)}
        role="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={`Open ${fullName}'s details — ${candidate.position ? `${candidate.position}, ` : ''}${positionLabel}`}
        aria-busy={pending || undefined}
        onClick={() => onOpen(candidate)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        className={cn(
          'rounded-md border border-navy-secondary bg-navy text-sm elev-1 transition-all',
          compact ? 'px-2.5 py-2' : 'p-3',
          'text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
          !locked && 'cursor-grab hover:border-silver/40 active:cursor-grabbing',
          locked && 'cursor-pointer hover:border-silver/40',
          isDragging && 'opacity-60 ring-1 ring-gold/60',
          pending && 'opacity-60',
        )}
      >
        <div className="flex items-start gap-2 pr-6">
          {!compact && <Avatar name={fullName} email={candidate.email} size="sm" />}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-white">{fullName}</div>
            {compact ? (
              <div className="truncate text-2xs text-silver/70">
                {candidate.position ? `${candidate.position} · ` : ''}
                {fmtDate(candidate.stageChangedAt)}
              </div>
            ) : (
              candidate.position && <div className="truncate text-xs2 text-gold/90">{candidate.position}</div>
            )}
          </div>
        </div>
        {!compact && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate text-2xs uppercase tracking-wider text-silver/70">
              {source ?? 'No source'}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              {candidate.resumeUrl && (
                <a
                  href={safeHref(candidate.resumeUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Resume"
                  tabIndex={-1}
                  aria-label="Open resume in a new tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className="text-silver/70 transition-colors hover:text-gold"
                >
                  <FileText className="h-3.5 w-3.5" />
                </a>
              )}
              {candidate.linkedinUrl && (
                <a
                  href={safeHref(candidate.linkedinUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="LinkedIn"
                  tabIndex={-1}
                  aria-label="Open LinkedIn profile in a new tab"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className="text-silver/70 transition-colors hover:text-gold"
                >
                  <Link2 className="h-3.5 w-3.5" />
                </a>
              )}
              <span
                title={`${inStage} day${inStage === 1 ? '' : 's'} in ${STAGE_LABEL[candidate.stage]}`}
                className={cn(
                  'rounded px-1 text-2xs tabular-nums',
                  inStage >= 7 ? 'bg-warning/15 text-warning' : 'text-silver/70',
                )}
              >
                {inStage}d
              </span>
            </div>
          </div>
        )}
        {candidate.rejectedReason && !compact && (
          <div className="mt-2 line-clamp-2 text-2xs text-alert/90">{candidate.rejectedReason}</div>
        )}
      </div>
      {!locked && (
        <MoveMenu
          candidate={candidate}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          onMove={onMove}
          returnFocus={() => cardEl.current?.focus()}
        />
      )}
    </li>
  );
}

/** "Move to…" — every move a drag can make, as a menu. */
function MoveMenu({
  candidate,
  open,
  onOpenChange,
  onMove,
  returnFocus,
}: {
  candidate: Candidate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMove: (target: CandidateStage) => void;
  returnFocus: () => void;
}) {
  const name = `${candidate.firstName} ${candidate.lastName}`;
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Move ${name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'absolute right-1.5 top-1.5 rounded p-1 text-silver/70 transition-opacity hover:bg-navy-secondary hover:text-white',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            // Always there on touch; on a mouse, when the card is hovered or focused.
            'opacity-100 fine:opacity-0 fine:group-hover:opacity-100 fine:group-focus-within:opacity-100',
            open && 'fine:opacity-100',
          )}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          // Back to the card, not the little trigger.
          e.preventDefault();
          returnFocus();
        }}
      >
        <DropdownMenuLabel>Move {candidate.firstName} to…</DropdownMenuLabel>
        {OPEN.filter((s) => s !== candidate.stage).map((s) => (
          <DropdownMenuItem key={s} onSelect={() => onMove(s)}>
            {STAGE_LABEL[s]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onMove('HIRED')}>Hire…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMove('WITHDRAWN')}>Withdrawn…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onMove('REJECTED')} className="text-alert focus:text-alert">
          Reject…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
