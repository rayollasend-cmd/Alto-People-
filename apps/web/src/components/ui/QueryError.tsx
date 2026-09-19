import { ApiError } from '@/lib/api';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';

/**
 * "We couldn't load this, and here's how to try again."
 *
 * A failed fetch that renders nothing is the worst outcome in the app: an
 * empty van list reads exactly like a quiet afternoon, and a dispatcher has
 * no way to tell "no rides booked" from "the request died." The transport
 * screens had 22 queries between them and five error branches, none of
 * which offered a retry — so the only recovery was a full page reload.
 *
 * One line per query site:
 *
 *   {rides.isError && <QueryError what="today's rides" query={rides} />}
 *
 * `what` completes the sentence "Couldn't load ___", so write it as the
 * user would name the thing, lowercase: "today's rides", "the fleet",
 * "this driver's stops".
 */
export function QueryError({
  what,
  query,
  className,
}: {
  what: string;
  query: { error: unknown; refetch: () => unknown; isFetching?: boolean };
  className?: string;
}) {
  const { error } = query;
  // ApiError carries the server's own sentence, which is almost always
  // more useful than a generic one. Anything else (a NetworkError, a
  // parse failure) gets the plain-language fallback rather than a raw
  // stringified exception in front of a store manager.
  const detail = error instanceof ApiError ? error.message : 'The request didn’t get through.';
  return (
    <ErrorBanner
      className={className}
      action={
        <Button size="xs" variant="secondary" loading={query.isFetching} onClick={() => query.refetch()}>
          Retry
        </Button>
      }
    >
      Couldn’t load {what}. {detail}
    </ErrorBanner>
  );
}
