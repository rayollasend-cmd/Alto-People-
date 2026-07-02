import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

/**
 * useState that survives revisits via localStorage (JSON-encoded).
 *
 * Convention — persist list *filters* only: status tabs/chips, client or
 * entity selects, boolean toggles. Do NOT persist free-text search or date
 * ranges — a stale date window silently hides data on the next visit.
 *
 * Keys are namespaced `alto:list.<page>.<field>.v1`; bump the version suffix
 * when a field's value space changes shape so old values get discarded.
 *
 * Reads localStorage once on init — a missing key, JSON parse error, or a
 * value the `validate` guard rejects (e.g. a filter option that has since
 * been removed) falls back to `initial`. Writes are best-effort on every
 * change; quota / private-mode failures just lose persistence. No cross-tab
 * sync.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      if (validate && !validate(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Best-effort — persistence quietly degrades to per-session state.
    }
  }, [key, value]);

  return [value, setValue];
}
