import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseYmd, ymdLocal } from '@/lib/format';

/**
 * View state in the URL — a tab, a filter, a period — so Back returns to
 * it, a reload keeps it and a link sends it.
 *
 * Twelve pages kept their tabs and filters in useState (lost on Back);
 * TransportHome, GarnishmentDesk, ExpirationsHome and BillsPage each
 * hand-rolled the same five lines around useSearchParams. This is those
 * lines, once:
 *
 *   const [status, setStatus] = useUrlParam('status', 'all', STATUSES);
 *   const [tab, setTab] = useUrlParam('tab', 'overview', TABS, { history: 'push' });
 *   const [days, setDays] = useUrlState('days', 30, urlNumber({ min: 1, max: 365 }));
 *
 * The rules every caller gets:
 *   - a default is never written: the clean URL IS the default view, and a
 *     param that is present always means "off its default";
 *   - a value the page doesn't know (a stale link, a hand edit) reads as
 *     the default, and nothing is rewritten just by reading;
 *   - filters REPLACE the history entry (Back leaves the page, it doesn't
 *     step back through every chip you tapped); tabs PUSH one, so Back
 *     returns to the tab you came from — pass `{ history: 'push' }`;
 *   - the rest of the URL is kept: other params, the #hash, the history
 *     state, and the scroll position;
 *   - two writes in one tick (a "Clear filters" that resets three params,
 *     a grid reporting its sort while the page sets a filter) compose
 *     instead of the second one undoing the first.
 *
 * Needs a router (every page has one). A component that must also render
 * without one — the DataGrid in a preview — checks useInRouterContext
 * before mounting the part that calls these.
 */

export type UrlHistory = 'replace' | 'push';

export interface UrlWriteOptions {
  /** 'replace' (default) for filters; 'push' for tabs and steps, so Back returns to the last one. */
  history?: UrlHistory;
}

/** How one value lives in a query param. `parse` returns undefined for a value it doesn't accept. */
export interface UrlCodec<T> {
  parse: (raw: string) => T | undefined;
  /** null or '' removes the param. */
  serialize: (value: T) => string | null;
}

/* ---- composing writes ---------------------------------------------------
 * react-router's setSearchParams builds the next URL from the params of the
 * LAST RENDER, and the data router renders a navigation a beat later (in a
 * transition). So two writes before that render each started from the same
 * old URL, and the second erased the first. Each write records where it
 * went, keyed by where it started (path + query); the next write follows
 * that chain to the newest URL. Once a render shows a URL the chain doesn't
 * continue from, the router has caught up and the chain is dropped — so a
 * Back press or a link is never overridden by an old write.
 */
const chain = new Map<string, string>();
let liveWriters = 0;

function newestSearch(pathname: string, search: string): string {
  let s = search;
  const seen = new Set<string>();
  while (chain.has(pathname + s) && !seen.has(s)) {
    seen.add(s);
    s = chain.get(pathname + s)!;
  }
  return s;
}

/**
 * The low-level writer: change any params in one step. Use it for several
 * at once ("Clear filters"); useUrlParam/useUrlState for one.
 *
 *   const write = useUrlWriter();
 *   write((p) => { p.delete('status'); p.delete('site'); });
 */
export function useUrlWriter(): (mutate: (params: URLSearchParams) => void, options?: UrlWriteOptions) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const latest = React.useRef(location);
  React.useLayoutEffect(() => {
    latest.current = location;
  });
  React.useEffect(() => {
    liveWriters += 1;
    return () => {
      liveWriters -= 1;
      if (liveWriters === 0) chain.clear();
    };
  }, []);
  React.useEffect(() => {
    // The router has rendered a URL no pending write continues from: it
    // has caught up (or someone navigated). Start from what it shows.
    if (!chain.has(location.pathname + location.search)) chain.clear();
  }, [location.pathname, location.search]);
  return React.useCallback(
    (mutate, options) => {
      const loc = latest.current;
      const base = newestSearch(loc.pathname, loc.search);
      const params = new URLSearchParams(base);
      mutate(params);
      const qs = params.toString();
      const next = qs ? `?${qs}` : '';
      if (next === base) return;
      chain.set(loc.pathname + base, next);
      navigate(
        { pathname: loc.pathname, search: next, hash: loc.hash },
        { replace: (options?.history ?? 'replace') === 'replace', state: loc.state, preventScrollReset: true },
      );
    },
    [navigate],
  );
}

/**
 * One typed value in one query param. Returns the value (the fallback when
 * the param is absent or not understood) and a setter that takes a value or
 * an updater. Setting the fallback removes the param.
 */
export function useUrlState<T>(
  key: string,
  fallback: T,
  codec: UrlCodec<T>,
  options?: UrlWriteOptions,
): [T, (next: T | ((prev: T) => T)) => void] {
  const location = useLocation();
  const write = useUrlWriter();
  const raw = new URLSearchParams(location.search).get(key);
  // Keep the codec and fallback in refs so the setter is stable across
  // renders even when the caller builds them inline.
  const ref = React.useRef({ codec, fallback, options });
  React.useLayoutEffect(() => {
    ref.current = { codec, fallback, options };
  });
  const fallbackKey = codec.serialize(fallback);
  // A list or a date parses to a new object every time; memoize on the
  // raw text so the value is stable while the URL doesn't change.
  const value = React.useMemo(() => {
    if (raw == null) return fallback;
    const parsed = codec.parse(raw);
    return parsed === undefined ? fallback : parsed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, fallbackKey]);
  const set = React.useCallback(
    (next: T | ((prev: T) => T)) => {
      const { codec: c, fallback: f, options: o } = ref.current;
      write((params) => {
        // The previous value comes from the newest URL, so updaters compose.
        const prevRaw = params.get(key);
        const prevParsed = prevRaw == null ? undefined : c.parse(prevRaw);
        const prev = prevParsed === undefined ? f : prevParsed;
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        const text = c.serialize(resolved);
        if (text == null || text === '' || text === c.serialize(f)) params.delete(key);
        else params.set(key, text);
      }, o);
    },
    [key, write],
  );
  return [value, set];
}

/**
 * A string param — usually one of a fixed set (a tab, a status). With
 * `allowed`, anything else in the URL reads as the fallback.
 */
export function useUrlParam<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
  options?: UrlWriteOptions,
): [T, (next: T | ((prev: T) => T)) => void] {
  // One codec object per allowed-set, so the memo inside stays stable.
  const codec = React.useMemo(
    () => (allowed ? urlEnum(allowed) : (urlString as unknown as UrlCodec<T>)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allowed ? allowed.join('\u0000') : null],
  );
  return useUrlState<T>(key, fallback, codec, options);
}

/* ---- codecs ------------------------------------------------------------- */

export const urlString: UrlCodec<string> = {
  parse: (raw) => raw,
  serialize: (v) => v,
};

/** One of a fixed set; anything else is not understood. */
export function urlEnum<T extends string>(allowed: readonly T[]): UrlCodec<T> {
  return {
    parse: (raw) => ((allowed as readonly string[]).includes(raw) ? (raw as T) : undefined),
    serialize: (v) => v,
  };
}

/** A number, optionally an integer within bounds. */
export function urlNumber(opts: { min?: number; max?: number; integer?: boolean } = {}): UrlCodec<number> {
  return {
    parse: (raw) => {
      if (raw.trim() === '') return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) return undefined;
      if (opts.integer && !Number.isInteger(n)) return undefined;
      if (opts.min != null && n < opts.min) return undefined;
      if (opts.max != null && n > opts.max) return undefined;
      return n;
    },
    serialize: (v) => String(v),
  };
}

/** On/off: "1"/"0" (also reads "true"/"false"). */
export const urlBoolean: UrlCodec<boolean> = {
  parse: (raw) => (raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : undefined),
  serialize: (v) => (v ? '1' : '0'),
};

/** A calendar day, YYYY-MM-DD (kept as the string: a day is not an instant). */
export const urlDay: UrlCodec<string> = {
  parse: (raw) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
    // A real calendar day reads back the same (Feb 30 rolls to Mar 2 and doesn't).
    const d = parseYmd(raw);
    return d && ymdLocal(d) === raw ? raw : undefined;
  },
  serialize: (v) => v,
};

/**
 * Several values, comma-separated (ids, statuses). With `allowed`, unknown
 * items are dropped. Order is kept as written; an empty list removes the param.
 */
export function urlList<T extends string = string>(allowed?: readonly T[]): UrlCodec<T[]> {
  return {
    parse: (raw) => {
      const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const kept = allowed ? items.filter((s) => (allowed as readonly string[]).includes(s)) : items;
      return [...new Set(kept)] as T[];
    },
    serialize: (v) => (v.length ? v.join(',') : null),
  };
}

/**
 * How many of these params are set — and because a default is never
 * written, a set param is a filter in use. For a "Filters (2)" summary.
 */
export function countSetParams(search: string, keys: readonly string[]): number {
  const params = new URLSearchParams(search);
  return keys.filter((k) => params.has(k)).length;
}

/**
 * The filters a page keeps in the URL, as one unit: how many are in use
 * and a Clear that removes them all in one history entry.
 */
export function useUrlFilters(keys: readonly string[]): { active: number; clear: () => void } {
  const location = useLocation();
  const write = useUrlWriter();
  const signature = keys.join('\u0000');
  const active = countSetParams(location.search, keys);
  const clear = React.useCallback(
    () =>
      write((params) => {
        for (const k of signature.split('\u0000')) if (k) params.delete(k);
      }),
    [signature, write],
  );
  return { active, clear };
}
