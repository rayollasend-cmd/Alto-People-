import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, X } from '@/components/ui/icons';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { getLatestReleaseNote } from '@/lib/releaseNotesApi';
import { seenKey, tourFor } from '@/lib/tours';
import { Button } from '@/components/ui/Button';
import '@/lib/i18n/en/whatsnew';

/**
 * "What's new" card — the newest release note, shown once per note
 * (bottom-right, above the tab bar on phones), dismissed state in
 * localStorage. The note itself comes from the API: an admin writes it
 * on /whats-new and it is on every phone at the next open, no deploy.
 * The server has already filtered the bullets to this reader's audience;
 * the card only picks the language.
 *
 * Only rendered on the home dashboard: it's a "since you were last here"
 * greeting, not page chrome, so it shouldn't trail the user onto every
 * route and overlap their work.
 *
 * Deliberately not a modal: release notes should never block work. And
 * not a floating card either: pinned bottom-right it covered the Hugo
 * card's suggestions, the finance home's Labor costs link and, on a
 * phone, Hugo's own button (F500 audit 2026-10-26). It sits in the page,
 * under the home's title (HomeTemplate), and the page flows around it.
 */

const SEEN_KEY = 'alto.whatsnew.seen.v2';
/** The bundle-era card keyed its seen state by release day. */
const LEGACY_SEEN_KEY = 'alto.whatsnew.seen.v1';

function readSeen(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function WhatsNew() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const location = useLocation();
  const [dismissed, setDismissed] = useState<string | null>(() => readSeen(SEEN_KEY));
  const onHome = location.pathname === '/' || location.pathname === '/portal' || location.pathname === '/region';

  const latest = useQuery({
    queryKey: ['release-notes', 'latest'],
    queryFn: getLatestReleaseNote,
    enabled: onHome && Boolean(user),
    staleTime: 60 * 60 * 1000,
  });

  // Home only — this is a "welcome back" note, not something that should
  // shadow the user onto Payroll, Scheduling, etc.
  if (!onHome) return null;
  // Day one shows the tour, not the news: a brand-new account on a phone
  // had both cards over its first screen (the first design walk). The note
  // waits until the home tour has been seen or skipped.
  const tour = tourFor('/');
  if (user && tour && readSeen(seenKey(tour.id, user.id)) === null) return null;
  const note = latest.data?.note ?? null;
  if (!note || note.items.length === 0) return null;
  // Storage unavailable → the seen state can't stick, so never nag.
  if (readSeen(SEEN_KEY) === null && dismissed === null) {
    try {
      window.localStorage.setItem(`${SEEN_KEY}.probe`, '1');
      window.localStorage.removeItem(`${SEEN_KEY}.probe`);
    } catch {
      return null;
    }
  }
  if (dismissed === note.id || readSeen(LEGACY_SEEN_KEY) === note.day) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, note.id);
    } catch {
      /* best-effort */
    }
    setDismissed(note.id);
  };

  return (
    <section
      role="status"
      aria-label={t('whatsnew.title')}
      data-testid="whats-new"
      className="relative rounded-lg border border-accent/40 bg-accent-fill/[0.06] px-4 py-3 animate-fade-in"
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{t('whatsnew.title')}</p>
          <ul className="mt-1 space-y-1 text-sm text-ink-muted">
            {note.items.slice(0, 3).map((item, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-accent" aria-hidden="true">
                  ·
                </span>
                <span>{lang === 'es' && item.es ? item.es : item.en}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" variant="link" className="h-auto px-0" asChild>
              <Link to="/whats-new" onClick={dismiss}>
                {t('whatsnew.seeAll')}
              </Link>
            </Button>
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t('whatsnew.dismiss')} className="-mr-1.5 -mt-1 shrink-0">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
