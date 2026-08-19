import { useEffect, useState, type ReactNode } from 'react';

/**
 * Minute-ticking clock scoped to ONE render-prop subtree.
 *
 * The dashboards used to hold `now` in page-level state with a 60s
 * interval, re-rendering the entire (1000+ line) page every minute just
 * to refresh a greeting and a date label. This component owns the tick,
 * so only the header text re-renders.
 */
export function LiveNow({ render }: { render: (now: Date) => ReactNode }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return <>{render(now)}</>;
}
