import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from './api';

/**
 * ACT NOW, RECONCILE LATER.
 *
 * Approving a timesheet meant: tap, wait for the round-trip, wait for the
 * refetch, watch the row disappear. On a good connection that's 400ms of
 * nothing; on a store tablet it's long enough to tap again. A manager
 * clearing forty rows felt every one of them.
 *
 * The fix is always the same four steps, and getting any of them wrong is
 * subtle — which is why thirteen files had each hand-rolled their own copy
 * with slightly different rollback:
 *
 *   1. Cancel in-flight refetches for the affected keys. Skip this and a
 *      response that was already on the wire lands after your patch and
 *      puts the row back.
 *   2. Snapshot what's cached, so a failure can undo exactly what it did.
 *   3. Apply the change to the cache now, so the UI moves this frame.
 *   4. On failure, restore the snapshot and say so. On settle — success or
 *      failure — invalidate, so the server has the last word.
 *
 * `keys` are matched as prefixes, the same way `invalidateQueries` does, so
 * `['team', 'timesheets']` covers every filter variation of that list.
 *
 * Optimism is only honest when the server almost always agrees. Use it for
 * approvals, claims, toggles and removals — not for anything whose outcome
 * you can't predict (a payroll run, a document scan), where showing a
 * result you then take away is worse than a spinner.
 */
export interface OptimisticMutationOptions<TVars, TData> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Query keys (prefix-matched) whose cached data this mutation changes. */
  keys: readonly QueryKey[];
  /**
   * Patch the cache to reflect the change as if it had already succeeded.
   * Runs before the request. Use `qc.setQueryData` — the snapshot for
   * rollback is taken for you.
   */
  apply: (vars: TVars, qc: QueryClient) => void;
  /** Shown on failure, after the rollback. */
  errorMessage?: string;
  onSuccess?: (data: TData, vars: TVars) => void;
}

interface Rollback {
  snapshots: Array<[QueryKey, unknown]>;
}

export function useOptimisticMutation<TVars, TData = unknown>({
  mutationFn,
  keys,
  apply,
  errorMessage,
  onSuccess,
}: OptimisticMutationOptions<TVars, TData>): UseMutationResult<TData, Error, TVars, Rollback> {
  const qc = useQueryClient();

  return useMutation<TData, Error, TVars, Rollback>({
    mutationFn,
    onMutate: async (vars) => {
      // A refetch already on the wire would otherwise overwrite the patch
      // below with pre-change data the moment it lands.
      await Promise.all(keys.map((key) => qc.cancelQueries({ queryKey: key })));
      const snapshots = keys.flatMap((key) => qc.getQueriesData({ queryKey: key }));
      apply(vars, qc);
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      // Put back exactly what was there — every matching query, not just
      // the one the caller happened to think about.
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
      toast.error(
        err instanceof ApiError ? err.message : (errorMessage ?? 'That didn’t go through.'),
      );
    },
    onSuccess,
    onSettled: () => {
      // The server has the last word either way: a success may have changed
      // more than we guessed, and a failure needs the truth back.
      for (const key of keys) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * The commonest patch: drop the rows this action resolves out of every
 * cached list under `keys`.
 *
 * Our endpoints return a few different envelopes — a bare array, or an
 * object with the rows under `items` / `entries` / `requests` — and one
 * action often clears rows from several of them at once (approving a
 * timesheet empties it from the queue AND from the inbox). So rather than
 * make every caller name the field, this filters every top-level array of
 * id-bearing objects it finds. Anything else in the payload is untouched.
 */
export function removeFromLists(
  qc: QueryClient,
  keys: readonly QueryKey[],
  ids: readonly string[],
): void {
  const gone = new Set(ids);
  const strip = (rows: unknown[]) =>
    rows.filter((row) => !(row && typeof row === 'object' && gone.has((row as { id?: string }).id!)));

  for (const key of keys) {
    for (const [queryKey, data] of qc.getQueriesData({ queryKey: key })) {
      if (Array.isArray(data)) {
        qc.setQueryData(queryKey, strip(data));
        continue;
      }
      if (!data || typeof data !== 'object') continue;
      let touched = false;
      const next: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      for (const [field, value] of Object.entries(next)) {
        if (!Array.isArray(value)) continue;
        const filtered = strip(value);
        if (filtered.length !== value.length) {
          next[field] = filtered;
          touched = true;
        }
      }
      if (touched) qc.setQueryData(queryKey, next);
    }
  }
}
