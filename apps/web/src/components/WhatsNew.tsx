import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { getLatestReleaseNote } from '@/lib/releaseNotesApi';
import { Button } from '@/components/ui/Button';

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
 * Deliberately not a modal: release notes should never block work.
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
  const onHome = location.pathname === '/';

  const latest = useQuery({
    queryKey: ['release-notes', 'latest'],
    queryFn: getLatestReleaseNote,
    enabled: onHome && Boolean(user),
    staleTime: 60 * 60 * 1000,
  });

  // Home only — this is a "welcome back" note, not something that should
  // shadow the user onto Payroll, Scheduling, etc.
  if (!onHome) return null;
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
    <div
      role="status"
      aria-label={t('whatsnew.title')}
      // Phones: full-width, clear of the tab bar AND the home indicator
      // (bottom-20 alone sat on the tab bar on notched iPhones), the list
      // capped so the card never covers half the screen. The supervisor's
      // and store manager's tab bar stays through iPad, hence lg: for the
      // desktop corner.
      className="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 rounded-lg border border-gold/40 bg-navy elev-2 p-4 animate-fade-in sm:inset-x-auto sm:right-4 sm:w-80 lg:bottom-6"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-2xs uppercase tracking-widest text-gold">
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          {t('whatsnew.title')}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={dismiss}
          aria-label="Dismiss what's new"
          className="-mt-1.5 -mr-1.5"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <ul className="mt-2 max-h-[32dvh] space-y-1.5 overflow-y-auto overscroll-contain text-sm text-silver sm:max-h-none">
        {note.items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-gold" aria-hidden="true">
              ·
            </span>
            <span>{lang === 'es' && item.es ? item.es : item.en}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="secondary" className="flex-1" onClick={dismiss}>
          {t('common.gotIt')}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <Link to="/whats-new" onClick={dismiss}>
            {t('whatsnew.seeAll')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
