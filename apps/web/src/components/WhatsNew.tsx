import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';

/**
 * "What's new" card — one entry per release, shown once per version
 * (bottom-right, above the tab bar on phones), dismissed state in
 * localStorage. Newest entry first; bump `id` when adding one, and the
 * card resurfaces for everyone exactly once.
 *
 * Only rendered on the home dashboard: it's a "since you were last here"
 * greeting, not page chrome, so it shouldn't trail the user onto every
 * route and overlap their work.
 *
 * Deliberately not a modal: release notes should never block work.
 */

const SEEN_KEY = 'alto.whatsnew.seen.v1';

interface ChangelogBullet {
  /** Literal English copy — admin-only bullets (admin UI is English). */
  text?: string;
  /** i18n key — associate-visible bullets translate through the dictionary. */
  key?: MessageKey;
  /** Only shown to users who can manage scheduling — an associate on a
   *  phone has no sidebar to hover or ⌘K to press, and reading about
   *  admin features they can't touch is noise, not news. Admin-facing
   *  copy stays English by the app's i18n boundary. */
  adminOnly?: boolean;
}

interface ChangelogEntry {
  id: string;
  bullets: ChangelogBullet[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-09-03',
    bullets: [
      { key: 'whatsnew.photoCrop' },
      { key: 'whatsnew.confirmTap' },
      { key: 'whatsnew.clockNumber' },
      {
        text: 'Cross-client transfers, kiosk PIN tools on the People profile, tiered admin email, and a bell that clears when you open it.',
        adminOnly: true,
      },
    ],
  },
  {
    id: '2026-07-02',
    bullets: [
      {
        text: 'Pin your most-used pages — hover a sidebar item and tap the star.',
        adminOnly: true,
      },
      {
        text: 'Press ⌘K to search people and clients, not just pages.',
        adminOnly: true,
      },
      {
        text: 'Approvals now show a live count badge and update instantly.',
        adminOnly: true,
      },
      { key: 'whatsnew.weekAhead' },
      { key: 'whatsnew.espanol' },
    ],
  },
];

function latestUnseen(): ChangelogEntry | null {
  const latest = CHANGELOG[0];
  if (!latest) return null;
  try {
    if (window.localStorage.getItem(SEEN_KEY) === latest.id) return null;
  } catch {
    return null; // storage unavailable → never nag repeatedly
  }
  return latest;
}

export function WhatsNew() {
  const { can } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const [entry, setEntry] = useState<ChangelogEntry | null>(() => latestUnseen());

  // Home only — this is a "welcome back" note, not something that should
  // shadow the user onto Payroll, Scheduling, etc.
  if (location.pathname !== '/') return null;
  if (!entry) return null;

  const isAdmin = can('manage:scheduling');
  const bullets = entry.bullets.filter((b) => isAdmin || !b.adminOnly);
  if (bullets.length === 0) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(SEEN_KEY, entry.id);
    } catch {
      /* best-effort */
    }
    setEntry(null);
  };

  return (
    <div
      role="status"
      aria-label="What's new"
      className="fixed bottom-20 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gold/40 bg-navy elev-2 p-4 animate-fade-in md:bottom-6"
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
      <ul className="mt-2 space-y-1.5 text-sm text-silver">
        {bullets.map((b) => {
          const label = b.key ? t(b.key) : b.text ?? '';
          return (
            <li key={b.key ?? b.text} className="flex gap-2">
              <span className="text-gold" aria-hidden="true">
                ·
              </span>
              <span>{label}</span>
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={dismiss}>
        {t('common.gotIt')}
      </Button>
    </div>
  );
}
