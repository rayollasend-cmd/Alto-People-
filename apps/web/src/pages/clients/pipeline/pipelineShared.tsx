import { Link } from 'react-router-dom';
import { ArrowRightLeft, Building2, CalendarClock, UserRound } from 'lucide-react';
import {
  OPEN_PROSPECT_STAGES,
  PROSPECT_STAGE_LABELS,
  isOpenProspectStage,
  type ProspectRow,
  type ProspectStageKey,
} from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { fmtDate, fmtMoneyCompact } from '@/lib/format';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

/**
 * What the board, the phone list and the page share: stage words, the
 * "needs a nudge" rule, and the card.
 */

export const STAGE_LABEL = PROSPECT_STAGE_LABELS;

/** A working prospect this long in one stage has stalled. */
export const STALLED_DAYS = 30;

export const STAGE_TONE: Record<ProspectStageKey, string> = {
  LEAD: 'border-t-line',
  CONTACTED: 'border-t-info',
  PROPOSAL: 'border-t-caution',
  VERBAL: 'border-t-accent',
  WON: 'border-t-positive',
  LOST: 'border-t-negative',
};

export function fmtWeight(w: number): string {
  return `${Math.round(w * 100)}%`;
}

/** "$229k/yr" — a prospect's value as the board reads it. */
export function fmtPerYear(v: number | null | undefined): string | null {
  return v == null ? null : `${fmtMoneyCompact(v)}/yr`;
}

/** Why a working prospect needs a nudge, or null when it doesn't. */
export function stalledReason(p: ProspectRow, today: string): string | null {
  if (!isOpenProspectStage(p.stage)) return null;
  if (p.expectedStartDate && p.expectedStartDate < today) return `Start date passed (${fmtDate(p.expectedStartDate)})`;
  if (p.daysInStage >= STALLED_DAYS) return `${p.daysInStage} days in ${STAGE_LABEL[p.stage]}`;
  return null;
}

/** Expected to start today or within the next 90 days (and not lost). */
export function startsWithin90(p: ProspectRow, today: string): boolean {
  if (p.stage === 'LOST' || !p.expectedStartDate) return false;
  const horizon = new Date(`${today}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 90);
  return p.expectedStartDate >= today && p.expectedStartDate <= horizon.toISOString().slice(0, 10);
}

export function sumWeighted(rows: ProspectRow[]): number {
  return rows.reduce((s, p) => s + (p.weightedValue ?? 0), 0);
}

export interface CardActions {
  canWrite: boolean;
  onOpen: (p: ProspectRow) => void;
  onMove: (p: ProspectRow, to: ProspectStageKey) => void;
  onCreateClient: (p: ProspectRow) => void;
}

/** One prospect: name, owner, value, expected start, days in stage. */
export function ProspectCardBody({ p, today, money, compact = false }: { p: ProspectRow; today: string; money: boolean; compact?: boolean }) {
  const stalled = stalledReason(p, today);
  const perYear = money ? fmtPerYear(p.annualValue) : null;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="pr-7 text-sm font-medium leading-snug text-ink [overflow-wrap:anywhere]">{p.name}</div>
      {!compact && (
        <div className={cn('flex items-center gap-1.5 text-xs2', p.ownerName ? 'text-ink-muted' : 'text-caution')}>
          <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{p.ownerName ?? 'No owner'}</span>
        </div>
      )}
      {money && !compact && (
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs2 tabular-nums">
          {perYear ? (
            <>
              <span className="font-medium text-ink">{perYear}</span>
              {p.weightedValue != null && <span className="text-ink-muted">{fmtMoneyCompact(p.weightedValue)} weighted</span>}
            </>
          ) : (
            <span className="text-ink-muted">Not priced yet</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs2">
        <span className={cn('inline-flex items-center gap-1', stalled && p.expectedStartDate && p.expectedStartDate < today ? 'text-caution' : 'text-ink-muted')}>
          <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {p.expectedStartDate ? `Starts ${fmtDate(p.expectedStartDate)}` : 'No start date'}
        </span>
        <span
          className={cn('tabular-nums', p.daysInStage >= STALLED_DAYS && isOpenProspectStage(p.stage) ? 'text-caution' : 'text-ink-muted')}
          title={`${p.daysInStage} day${p.daysInStage === 1 ? '' : 's'} in ${STAGE_LABEL[p.stage]}`}
        >
          {p.daysInStage}d in stage
        </span>
      </div>
      {p.stage === 'LOST' && p.lostReason && <div className="line-clamp-2 text-xs2 text-ink-muted">Lost: {p.lostReason}</div>}
    </div>
  );
}

/** The won card's line: the client it became, or the way to create it. */
export function WonClientLine({ p, actions }: { p: ProspectRow; actions: CardActions }) {
  if (p.stage !== 'WON') return null;
  if (p.wonClientId) {
    return (
      <Link
        to={`/clients/${p.wonClientId}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        className="mt-1.5 inline-flex max-w-full items-center gap-1 text-xs2 text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{p.wonClientName}</span>
      </Link>
    );
  }
  if (!actions.canWrite) return <div className="mt-1.5 text-xs2 text-ink-muted">Client not created</div>;
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        actions.onCreateClient(p);
      }}
      className="mt-1.5 inline-flex items-center gap-1 text-xs2 text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Create the client
    </button>
  );
}

/** "Move to…" — every move a drag makes, as a menu (and the only way on a phone). */
export function MoveMenu({
  p,
  onMove,
  open,
  onOpenChange,
  className,
}: {
  p: ProspectRow;
  onMove: (to: ProspectStageKey) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const closed = !isOpenProspectStage(p.stage);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Move ${p.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'grid h-7 w-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink coarse:h-11 coarse:w-11',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
            className,
          )}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{closed ? 'Reopen as…' : 'Move to…'}</DropdownMenuLabel>
        {OPEN_PROSPECT_STAGES.filter((s) => s !== p.stage).map((s) => (
          <DropdownMenuItem key={s} onSelect={() => onMove(s)}>
            {STAGE_LABEL[s]}
          </DropdownMenuItem>
        ))}
        {!closed && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onMove('WON')}>Won…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onMove('LOST')} className="text-negative focus:text-negative">
              Lost…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
