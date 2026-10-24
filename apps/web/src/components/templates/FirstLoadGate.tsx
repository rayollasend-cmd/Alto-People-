import * as React from 'react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { HomeSkeleton } from './HomeSkeleton';

/**
 * How long a page's first screen may wait for its data before it shows
 * what it has, and how long fetching must stay quiet before it counts as
 * done (a query that another one's answer enables starts a render later).
 */
const SETTLE_CAP_MS = 2500;
const SETTLE_QUIET_MS = 100;
/** The gated pages already shown whole in this page load. */
const shownWhole = new Set<string>();

/**
 * True once the page's first data has landed — every query that is
 * fetching with nothing to show yet has answered — or SETTLE_CAP_MS passed.
 * Only the first visit of a page load waits: a revisit, or a cold start from
 * the saved offline cache, has its data already and shows at once.
 */
function useFirstLoadSettled(page: string): boolean {
  const queryClient = useQueryClient();
  const [settled, setSettled] = React.useState(() => shownWhole.has(page));
  React.useEffect(() => {
    if (settled) {
      shownWhole.add(page);
      return;
    }
    // A parent's effect runs after its children's, so every card's first
    // fetch has started by now.
    const firstLoads = { predicate: (q: Query) => q.state.data === undefined };
    let waited = false;
    let quiet: number | undefined;
    const check = () => {
      if (queryClient.isFetching(firstLoads) > 0) {
        waited = true;
        window.clearTimeout(quiet);
        quiet = undefined;
      } else if (!waited) {
        setSettled(true);
      } else if (quiet === undefined) {
        quiet = window.setTimeout(() => setSettled(true), SETTLE_QUIET_MS);
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
    const cap = window.setTimeout(() => setSettled(true), SETTLE_CAP_MS);
    return () => {
      unsubscribe();
      window.clearTimeout(quiet);
      window.clearTimeout(cap);
    };
  }, [page, settled, queryClient]);
  return settled;
}

/**
 * A page whose first screen appears whole: rendered hidden under one
 * skeleton until its first data has landed, then shown at once.
 *
 * For pages built from cards that each fetch their own data and render
 * nothing (or a skeleton of another height) until it lands. Shown as they
 * loaded, they moved under the reader at every answer: the associate's hero
 * turned into the onboarding card and pushed the shift down, "Needs you"
 * grew, the push nudge slid in above the numbers; on the admin's home the
 * decisions card doubled when the KPIs arrived; on Payroll "Needs you"
 * landed above the pay-cycle hero. Lighthouse measured layout shifts of
 * 0.10–0.23 on the two homes. Hidden rather than withheld, so every card
 * starts its fetch at once and lays out at its real size; hidden with
 * visibility, so nothing waiting can be focused or read aloud.
 *
 * `page` names the page for the once-per-page-load rule.
 */
export function FirstLoadGate({ page, children }: { page: string; children: React.ReactNode }) {
  const settled = useFirstLoadSettled(page);
  return (
    <div className="relative">
      <div className={cn(!settled && 'invisible')} aria-busy={settled ? undefined : true}>
        {children}
      </div>
      {!settled && <HomeSkeleton className="absolute inset-x-0 top-0" />}
    </div>
  );
}
