import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import type { TransportBoard } from '@/lib/transportApi';
import { useMoveRide } from '@/lib/transportOpsApi';
import { applyMove, checkMove, seatsText, type MovingRide } from './moves';
import { firstName } from './rideWords';

/**
 * One way to move a rider, for the drag and the Move to… menu alike:
 * check it in words, show it on the board at once, ask the server, roll back
 * if it says no (with its reason), and offer Undo — which moves them back
 * where they were, in the same place in the pickup order.
 */
export function useRideMoves(board: TransportBoard, tz?: string) {
  const qc = useQueryClient();
  const mutation = useMoveRide();
  const key = ['transport', 'board', board.date];

  async function move(m: MovingRide, toRunId: string | null, opts: { undo?: boolean; pickupOrder?: number } = {}): Promise<boolean> {
    // The board as it is now (an Undo comes after the move landed), not as it was when this rendered.
    const now = qc.getQueryData<TransportBoard>(key) ?? board;
    const runName = (runId: string) => now.runs.find((r) => r.id === runId)?.van.name ?? 'the run';
    const who = firstName(m.ride.rider.name);
    const check = checkMove(m, toRunId, now, tz);
    if (!check.ok) {
      toast.error(`Can’t move ${who}`, { description: check.reason });
      return false;
    }
    await qc.cancelQueries({ queryKey: key });
    const before = qc.getQueryData<TransportBoard>(key);
    if (before) qc.setQueryData<TransportBoard>(key, applyMove(before, m.ride.id, toRunId));
    const back = { pickupOrder: m.ride.pickupOrder ?? undefined };
    try {
      const res = await mutation.mutateAsync({ rideId: m.ride.id, toRunId, ...(opts.pickupOrder !== undefined ? { pickupOrder: opts.pickupOrder } : {}) });
      const where = toRunId ? `${opts.undo ? 'back on' : 'moved to'} ${runName(toRunId)}` : 'back on Needs a van';
      const seats = res.seats ?? (check.seatsAfter ? check.seatsAfter : null);
      const title = `${who} ${where}${seats ? ` · ${seatsText(seats)}` : ''}`;
      const description = res.warnings.length > 0 ? res.warnings.join(' ') : undefined;
      if (opts.undo) {
        toast.success(title, { description });
      } else {
        toast.success(title, {
          description,
          action: {
            label: 'Undo',
            onClick: () => void move({ ride: { ...m.ride, status: toRunId ? 'SCHEDULED' : 'REQUESTED' }, fromRunId: toRunId }, m.fromRunId, { undo: true, ...(m.fromRunId ? back : {}) }),
          },
        });
      }
      return true;
    } catch (err) {
      if (before) qc.setQueryData<TransportBoard>(key, before);
      toast.error(`Couldn’t move ${who}`, { description: err instanceof ApiError ? err.message : 'Something went wrong — nothing changed.' });
      return false;
    }
  }

  return { move, pending: mutation.isPending };
}
