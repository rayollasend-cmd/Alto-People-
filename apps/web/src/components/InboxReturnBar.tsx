import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CheckCircle2, X } from 'lucide-react';
import { INBOX_QUERY_KEY, getInbox, inboxLink } from '@/lib/inboxApi';
import { useI18n } from '@/lib/i18n';

/**
 * The way back from a queue opened in the Inbox. A link from the Inbox
 * carries `from=inbox&inbox=<queue>` (inboxLink); the page it opens shows
 * this slim bar — "Back to inbox", how many are left in that queue, and,
 * once it is empty, the next queue with work in it. The trip survives the
 * page rewriting its own URL (tabs, filters): it is remembered for the tab's
 * session against the page's path, and ends when the person goes elsewhere.
 */

const KEY = 'alto.inboxReturn';

interface Trip {
  queue: string;
  /** The page the queue opened on — the bar shows while the person stays on it. */
  base: string;
}

function readTrip(): Trip | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    const t = raw ? (JSON.parse(raw) as Partial<Trip>) : null;
    return t && typeof t.queue === 'string' && typeof t.base === 'string' ? { queue: t.queue, base: t.base } : null;
  } catch {
    return null;
  }
}

function writeTrip(t: Trip | null) {
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private mode: the bar lives as long as the URL carries it.
  }
}

/** On the queue's page, or a record opened from it (/people → /people/123). */
const onBase = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

export function InboxReturnBar() {
  const { t } = useI18n();
  const location = useLocation();
  const qc = useQueryClient();
  const [trip, setTrip] = useState<Trip | null>(() => readTrip());

  // A link from the Inbox starts (or replaces) the trip; leaving its page ends it.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const queue = params.get('inbox');
    if (params.get('from') === 'inbox' && queue) {
      if (trip?.queue === queue && trip.base === location.pathname) return;
      const next = { queue, base: location.pathname };
      writeTrip(next);
      setTrip(next);
      return;
    }
    if (trip && !onBase(location.pathname, trip.base)) {
      writeTrip(null);
      setTrip(null);
    }
  }, [location.pathname, location.search, trip]);

  const active = trip !== null && onBase(location.pathname, trip.base);
  // Fresher than the Inbox's own minute while a queue is being worked, so
  // "done" shows soon after the last item; any successful change refetches too.
  const inbox = useQuery({ queryKey: INBOX_QUERY_KEY, queryFn: getInbox, enabled: active, refetchInterval: active ? 15_000 : false, staleTime: 5_000 });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = qc.getMutationCache().subscribe((e) => {
      if (e.type !== 'updated' || e.mutation.state.status !== 'success') return;
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY }), 400);
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [active, qc]);

  const { here, next } = useMemo(() => {
    const sources = inbox.data?.sources ?? [];
    const mine = sources.find((s) => s.key === trip?.queue) ?? null;
    const others = sources.filter((s) => s.key !== trip?.queue && s.count > 0).sort((a, b) => b.count - a.count);
    return { here: mine, next: others[0] ?? null };
  }, [inbox.data, trip?.queue]);

  if (!active || !inbox.data) return null;
  const done = !here || here.count === 0;
  const end = () => {
    writeTrip(null);
    setTrip(null);
  };

  return (
    <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-navy-secondary bg-navy-secondary/30 px-4 py-1.5 text-sm text-ink">
      <Link to="/inbox" onClick={end} className="inline-flex items-center gap-1 text-silver hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        {t('decisions.backToInbox')}
      </Link>
      <span className="min-w-0 flex-1 truncate">
        {done ? (
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
            {here ? t('decisions.queueDone', { label: here.label }) : null} {next ? null : t('decisions.inboxClear')}
          </span>
        ) : (
          <span className="text-silver">{t('decisions.leftHere', { label: here.label, n: here.count >= 999 ? '999+' : here.count })}</span>
        )}
      </span>
      {done && next && (
        <Link to={inboxLink(next.path, next.key)} className="inline-flex items-center gap-1 font-medium text-gold hover:underline">
          {t('decisions.next', { label: next.label, n: next.count >= 999 ? '999+' : next.count })}
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      )}
      <button type="button" onClick={end} className="rounded p-0.5 text-silver hover:text-ink" aria-label={t('decisions.hideReturn')}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
