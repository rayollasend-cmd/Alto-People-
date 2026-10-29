import { Link } from 'react-router-dom';
import { ApiError } from '@/lib/api';
import { useAuthIfMounted } from '@/lib/navTrail';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from './Button';
import { ErrorBanner } from './ErrorBanner';

/**
 * "We couldn't load this, and here's how to try again."
 *
 * A failed fetch that renders nothing is the worst outcome in the app: an
 * empty van list reads exactly like a quiet afternoon, and a dispatcher has
 * no way to tell "no rides booked" from "the request died."
 *
 * One line per query site:
 *
 *   {rides.isError && <QueryError what="today's rides" query={rides} />}
 *
 * `what` completes the sentence "Couldn't load ___", so write it as the
 * user would name the thing, lowercase: "today's rides", "the fleet",
 * "this driver's stops". On an associate-facing screen pass it through
 * `t()` too — the sentence around it is already in their language.
 *
 * The failure decides the words (F500 fix-up 2026-10-22) — the server's
 * own text is never shown for a refusal or a crash ("Missing capability:
 * view:org", "Request failed (500)"):
 *   - 401/403   "You don't have access to ___." and who to ask; no Retry
 *               (trying again won't change the answer).
 *   - 404       "Couldn't find ___." — it may have gone; no Retry.
 *   - 5xx, a crash, an unknown error
 *               "Something went wrong on our side." + Retry, with the
 *               request's reference tucked away for support.
 *   - offline / timed out
 *               "We couldn't reach the server." + Retry.
 *   - any other 4xx (a rule the request broke) — the API's sentence, which
 *     is written for people, + Retry.
 *
 * A section that is only a part of the page (a tile row, a side panel) can
 * pass `access="hide"`: a refusal then renders nothing, so the person reads
 * the page they may see instead of a warning about the part they may not.
 * Better still, skip the read: `enabled: useReadable(cap)` (lib/useReadable).
 * A capability string ("view:org") is never rendered — lib/api's ApiError
 * replaces the API's "Missing capability: …" with plain words.
 */
export type QueryErrorKind = 'access' | 'notFound' | 'server' | 'offline' | 'rule';

/** An ApiError — checked by shape too, so a test's stand-in class (or none) still reads. */
function apiErrorOf(error: unknown): { status: number; message: string; requestId?: string } | null {
  try {
    if (error instanceof ApiError) return error;
  } catch {
    /* lib/api mocked without ApiError */
  }
  const e = error as { name?: unknown; status?: unknown; message?: unknown } | null;
  if (e && e.name === 'ApiError' && typeof e.status === 'number') return e as { status: number; message: string };
  return null;
}

export function queryErrorKind(error: unknown): QueryErrorKind {
  const api = apiErrorOf(error);
  if (api) {
    if (api.status === 401 || api.status === 403) return 'access';
    if (api.status === 404) return 'notFound';
    if (api.status === 0) return 'offline';
    if (api.status >= 500) return 'server';
    return api.message.trim() ? 'rule' : 'server';
  }
  // NetworkError / TimeoutError (lib/api), by name: no request reached an answer.
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'NetworkError' || name === 'TimeoutError') return 'offline';
  return 'server';
}

/** Who to ask for access, by the kind of account. */
export function useAccessAskKey(): MessageKey {
  const role = useAuthIfMounted()?.user?.role;
  if (role === 'CLIENT_PORTAL') return 'access.askClient';
  if (role === 'ASSOCIATE' || role === 'DRIVER') return 'access.askAssociate';
  return 'access.askStaff';
}

export function QueryError({
  what,
  query,
  className,
  access = 'explain',
}: {
  what: string;
  query: { error: unknown; refetch: () => unknown; isFetching?: boolean };
  className?: string;
  /** On a refusal: say so (default), or render nothing — for a part of a page, not the page. */
  access?: 'explain' | 'hide';
}) {
  const { t } = useI18n();
  const askKey = useAccessAskKey();
  const { error } = query;
  const kind = queryErrorKind(error);
  if (kind === 'access' && access === 'hide') return null;
  const retry = (
    <Button size="xs" variant="secondary" loading={query.isFetching} onClick={() => query.refetch()}>
      {t('common.retry')}
    </Button>
  );

  if (kind === 'access') {
    return (
      <ErrorBanner
        className={className}
        severity="warning"
        data-kind="access"
        action={
          <Button size="xs" variant="secondary" asChild>
            <Link to="/">{t('access.home')}</Link>
          </Button>
        }
      >
        {t('queryError.noAccess', { what })} {t(askKey)}
      </ErrorBanner>
    );
  }
  if (kind === 'notFound') {
    return (
      <ErrorBanner className={className} severity="warning" data-kind="notFound">
        {t('queryError.notFound', { what })}
      </ErrorBanner>
    );
  }
  const api = apiErrorOf(error);
  const requestId = api?.requestId;
  return (
    <ErrorBanner className={className} action={retry} data-kind={kind}>
      {t('queryError.title', { what })}{' '}
      {kind === 'rule' && api
        ? api.message
        : kind === 'offline'
          ? t('queryError.offline')
          : t('queryError.server')}
      {kind === 'server' && requestId && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer">{t('queryError.details')}</summary>
          {t('queryError.reference', { id: requestId })}
        </details>
      )}
    </ErrorBanner>
  );
}
