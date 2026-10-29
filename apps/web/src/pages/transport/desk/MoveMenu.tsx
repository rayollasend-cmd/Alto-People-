import { ArrowRightLeft } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { fmtTimeTz } from '@/lib/format';
import type { RideRun } from '@/lib/transportApi';
import { checkMoveToRun, seatsText, type MovingRide } from './moves';
import { firstName } from './rideWords';

/**
 * "Move to…" — the drag's twin for a keyboard, a finger and a screen reader:
 * the runs going the same way that day, each with its seats after the move
 * (a full one says so and can't be picked), and "Back to Needs a van" for a
 * rider already on a run.
 */
export function MoveMenu({ moving, runs, tz, onMove }: { moving: MovingRide; runs: RideRun[]; tz?: string; onMove: (toRunId: string | null) => void }) {
  const who = firstName(moving.ride.rider.name);
  const sameWay = runs
    .filter((r) => r.id !== moving.fromRunId && r.direction === moving.ride.direction && r.status === 'PLANNED' && !r.notRun)
    .sort((a, b) => a.departAt.localeCompare(b.departAt));
  const way = moving.ride.direction === 'TO_WORK' ? 'to work' : 'home from work';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Move ${moving.ride.rider.name}`} title={`Move ${who} to another run`}>
          <ArrowRightLeft className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs2 font-normal text-ink-muted">Move {who} to…</DropdownMenuLabel>
        {sameWay.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-muted">No other run goes {way} this day.</p>}
        {sameWay.map((run) => {
          const check = checkMoveToRun(moving, run, tz);
          return (
            <DropdownMenuItem
              key={run.id}
              disabled={!check.ok}
              onSelect={() => onMove(run.id)}
              aria-label={`${run.van.name}, leaves ${fmtTimeTz(run.departAt, tz)}, ${run.driver.name}${check.ok ? `, ${check.seatsAfter ? seatsText(check.seatsAfter) : ''} after the move` : `: ${check.reason}`}`}
              className="items-start"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-ink">
                  {run.van.name} · leaves <span className="tabular-nums">{fmtTimeTz(run.departAt, tz)}</span>
                </span>
                <span className="block text-xs2 text-ink-muted">
                  {run.driver.name}
                  {check.ok && check.caution ? ` · ${check.caution}` : ''}
                  {!check.ok ? ` · ${check.reason}` : ''}
                </span>
              </span>
              {check.ok && check.seatsAfter && (
                <span className="shrink-0 text-xs2 tabular-nums text-ink-muted">{seatsText(check.seatsAfter)} after</span>
              )}
            </DropdownMenuItem>
          );
        })}
        {moving.fromRunId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onMove(null)}>Back to Needs a van</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
