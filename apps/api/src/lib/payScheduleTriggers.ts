import { currentTenantId } from './tenant.js';

/**
 * The queue between "something about a person changed" and "work out their
 * pay schedule again". The database client (db.ts) notes a change whenever
 * a person's placement (AssociateAssignment), pay type (CompensationRecord)
 * or department changes — at every call site, without any of them knowing —
 * and the membership engine (lib/payScheduleMembership) recomputes them a
 * moment later, after the writing transaction has committed.
 *
 * Kept free of imports from db.ts / the engine so db.ts can use it without a
 * cycle: the engine registers the handler when it loads.
 */

export type ScheduleTrigger = 'HIRE' | 'TRANSFER' | 'DEPARTMENT' | 'PAY_TYPE' | 'NIGHTLY' | 'RULE' | 'MANUAL';

type Handler = (tenantId: string, associateIds: string[], trigger: ScheduleTrigger) => Promise<void>;

let handler: Handler | null = null;
const pending = new Map<string, { ids: Set<string>; trigger: ScheduleTrigger }>();
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> = Promise.resolve();
const DELAY_MS = 1200;
const PRIORITY: ScheduleTrigger[] = ['HIRE', 'TRANSFER', 'DEPARTMENT', 'PAY_TYPE', 'RULE', 'MANUAL', 'NIGHTLY'];

export function setScheduleRecomputeHandler(fn: Handler): void {
  handler = fn;
}

/** Note that these people's schedule facts changed. Never throws. */
export function queueScheduleRecompute(associateIds: Array<string | null | undefined>, trigger: ScheduleTrigger): void {
  try {
    const tenantId = currentTenantId();
    const ids = associateIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (!tenantId || ids.length === 0) return;
    const key = `${tenantId}|${trigger}`;
    const entry = pending.get(key) ?? { ids: new Set<string>(), trigger };
    for (const id of ids) entry.ids.add(id);
    pending.set(key, entry);
    if (!timer) {
      timer = setTimeout(() => void flushScheduleRecompute(), DELAY_MS);
      timer.unref?.();
    }
  } catch {
    // A note that can't be taken is picked up by the nightly sweep.
  }
}

/** Run everything queued now (tests, and the timer). */
export async function flushScheduleRecompute(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // One recompute per person, under the trigger that best says why: a hire
  // that also opened a placement is a hire, not a transfer.
  const batch = [...pending.entries()].sort((a, b) => PRIORITY.indexOf(a[1].trigger) - PRIORITY.indexOf(b[1].trigger));
  pending.clear();
  const seen = new Set<string>();
  for (const [key, entry] of batch) {
    const tenantId = key.split('|')[0]!;
    for (const id of [...entry.ids]) {
      if (seen.has(`${tenantId}|${id}`)) entry.ids.delete(id);
      else seen.add(`${tenantId}|${id}`);
    }
  }
  const run = async () => {
    for (const [key, entry] of batch) {
      const tenantId = key.split('|')[0]!;
      if (!handler || entry.ids.size === 0) continue;
      try {
        await handler(tenantId, [...entry.ids], entry.trigger);
      } catch (err) {
        console.warn('[paySchedules] recompute failed:', err instanceof Error ? err.message : err);
      }
    }
  };
  inFlight = inFlight.then(run, run);
  await inFlight;
}
