import { useEffect, useRef, useState } from 'react';
import type { ExecStatus } from '@alto-people/shared';

/**
 * Small pieces the chairman's home shares (2026-10-27): how a plan quarter
 * reads, how a client-health score reads as a status, and when the
 * below-the-fold previews may start loading.
 */

/** "2026-Q4" → { short: "Q4", long: "Q4 2026" }; anything else is said as it came. */
export function quarterWords(key: string | null | undefined): { short: string; long: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(key ?? '');
  if (!m) return { short: key ?? '', long: key ?? '' };
  return { short: `Q${m[2]}`, long: `Q${m[2]} ${m[1]}` };
}

/**
 * A client-health reading as a status: the word the clients list uses
 * (Good · Watch · At risk) — the API sends the word; a score, should one
 * ever come with no word, reads by the briefing's bands (80 good, 60 watch).
 */
export function healthStatus(score: number | null, label: string | null): ExecStatus {
  const word = (label ?? '').toLowerCase();
  if (/risk|poor|bad|critical/.test(word)) return 'bad';
  if (/watch|fair|amber/.test(word)) return 'watch';
  if (/good|healthy|strong|green/.test(word)) return 'good';
  if (score === null || !Number.isFinite(score)) return 'none';
  return score >= 80 ? 'good' : score >= 60 ? 'watch' : 'bad';
}

/**
 * Whether the previews below the fold may load: once the scorecard has
 * answered (and the first screen has painted — `delayMs` later), or as soon
 * as the reader scrolls near them, whichever comes first. The scorecard's
 * request goes out alone, so the first screen is never waiting on charts
 * nobody can see yet.
 */
export function useBelowTheFold<T extends Element>(scorecardSettled: boolean, delayMs = 250) {
  const ref = useRef<T | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || !scorecardSettled) return;
    const id = window.setTimeout(() => setReady(true), delayMs);
    return () => window.clearTimeout(id);
  }, [ready, scorecardSettled, delayMs]);
  useEffect(() => {
    const el = ref.current;
    if (ready || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setReady(true);
      },
      { rootMargin: '0px 0px 120px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ready]);
  return { ref, ready };
}
