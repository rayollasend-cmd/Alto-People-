import { enqueueWrite, isConnectivityFailure, listQueuedWrites, onQueueChange, type QueuedWrite } from './offlineQueue';
import { currentDriverFix } from './driverPosition';
import {
  boardAll,
  completeDriverRun,
  driverArrived,
  markBoarded,
  markNoShow,
  undoRideMark,
  type MarkEvidence,
  type MarkOptions,
  type Ride,
  type RideRun,
} from './transportApi';

/**
 * Floor walk 5 — the driver's taps survive a dead spot.
 *
 * The van is exactly where signal drops. Board, no-show, arrived, undo and
 * complete used to be plain requests: a failure was a toast and the tap
 * was gone. Now each goes through the shared offline queue
 * (lib/offlineQueue) with an idempotency key and a position:
 *
 *   online    sent now, with the phone's fix; the server's answer as before
 *   offline   queued, answered { queued: true }; the row shows "(sending)"
 *   replay    the queue sends it again with `replay: true`, so a mark that
 *             did land before the signal died answers 200, not a 409 the
 *             queue would drop as "refused"
 *
 * `pendingMarks` is what the screen paints while the queue holds taps:
 * which ride is on its way to BOARDED / NO_SHOW / back to SCHEDULED, and
 * which stops the van has arrived at.
 */

export const TRANSPORT_QUEUE_KIND = 'transport-tap';

export type PendingKind = 'board' | 'no-show' | 'arrived' | 'undo' | 'complete';

export interface PendingMark {
  kind: PendingKind;
  /** The ride (board, no-show, undo) or the run (arrived, complete). */
  id: string;
  rideIds?: string[];
  queuedAt: string;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fix(): Pick<MarkOptions, 'lat' | 'lng' | 'accuracy'> {
  const f = currentDriverFix();
  return f ? { lat: f.lat, lng: f.lng, accuracy: f.accuracy } : {};
}

export type TapResult<T> = { queued: false; result: T } | { queued: true; id: string };

async function tap<T>(
  label: string,
  pending: Omit<PendingMark, 'queuedAt'>,
  path: string,
  body: Record<string, unknown>,
  send: (opts: MarkOptions) => Promise<T>,
): Promise<TapResult<T>> {
  const key = newKey();
  const opts: MarkOptions = { ...fix(), idempotencyKey: key };
  const queue = () => {
    const q = enqueueWrite({ kind: TRANSPORT_QUEUE_KIND, label, method: 'POST', path, body: { ...body, ...opts, replay: true, pending } });
    return { queued: true as const, id: q.id };
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return queue();
  try {
    return { queued: false, result: await send(opts) };
  } catch (err) {
    if (isConnectivityFailure(err)) return queue();
    throw err;
  }
}

export const tapBoard = (ride: Pick<Ride, 'id'> & { rider?: { name: string } }) =>
  tap<{ ride: Ride }>(`${ride.rider?.name ?? 'Rider'} on board`, { kind: 'board', id: ride.id }, `/transport/driver/rides/${ride.id}/board`, {}, (o) => markBoarded(ride.id, o));

export const tapNoShow = (ride: Pick<Ride, 'id'> & { rider?: { name: string } }) =>
  tap<{ ride: Ride; evidence: MarkEvidence | null }>(`${ride.rider?.name ?? 'Rider'} no-show`, { kind: 'no-show', id: ride.id }, `/transport/driver/rides/${ride.id}/no-show`, {}, (o) => markNoShow(ride.id, o));

export const tapArrived = (runId: string, rideIds: string[], stopLabel: string) =>
  tap<{ run: RideRun; evidence: MarkEvidence | null }>(`Arrived at ${stopLabel}`, { kind: 'arrived', id: runId, rideIds }, `/transport/driver/runs/${runId}/arrived`, { rideIds }, (o) => driverArrived(runId, rideIds, o));

export const tapBoardAll = (runId: string, rideIds: string[], stopLabel: string) =>
  tap<{ run: RideRun; boarded: string[]; already: string[] }>(`All on board at ${stopLabel}`, { kind: 'board', id: runId, rideIds }, `/transport/driver/runs/${runId}/board-all`, { rideIds }, (o) => boardAll(runId, rideIds, o));

export const tapUndo = (ride: Pick<Ride, 'id'> & { rider?: { name: string } }) =>
  tap<{ ride: Ride }>(`Undo ${ride.rider?.name ?? 'rider'}'s mark`, { kind: 'undo', id: ride.id }, `/transport/driver/rides/${ride.id}/undo`, {}, (o) => undoRideMark(ride.id, o));

export const tapComplete = (runId: string, vanName: string) =>
  tap<{ run: RideRun }>(`Finish ${vanName}'s run`, { kind: 'complete', id: runId }, `/transport/driver/runs/${runId}/complete`, {}, (o) => completeDriverRun(runId, o));

/** The driver's taps still waiting to send, oldest first. */
export function pendingMarks(queue: QueuedWrite[] = listQueuedWrites()): PendingMark[] {
  return queue
    .filter((q) => q.kind === TRANSPORT_QUEUE_KIND)
    .map((q) => {
      const p = (q.body as { pending?: Omit<PendingMark, 'queuedAt'> } | null)?.pending;
      return p ? { ...p, queuedAt: q.queuedAt } : null;
    })
    .filter((p): p is PendingMark => !!p);
}

/** What the queue would make of a ride once it sends: the mark on its way. */
export function pendingFor(rideId: string, runId: string, marks: PendingMark[]): PendingKind | null {
  let out: PendingKind | null = null;
  for (const m of marks) {
    if (m.id === rideId && (m.kind === 'board' || m.kind === 'no-show' || m.kind === 'undo')) out = m.kind;
    else if (m.id === runId && m.kind === 'board' && m.rideIds?.includes(rideId)) out = 'board';
    else if (m.id === runId && m.kind === 'arrived' && m.rideIds?.includes(rideId) && !out) out = 'arrived';
  }
  return out;
}

/** Subscribe to the driver's pending taps (the pill, the row states). */
export function onPendingMarks(cb: (marks: PendingMark[]) => void): () => void {
  cb(pendingMarks());
  return onQueueChange((q) => cb(pendingMarks(q)));
}
