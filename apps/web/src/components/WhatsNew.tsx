import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';

/**
 * "What's new" card — one entry per release, shown once per version
 * (bottom-right, above the tab bar on phones), dismissed state in
 * localStorage. Newest entry first; bump `id` when adding one, and the
 * card resurfaces for everyone exactly once.
 *
 * Deliberately not a modal: release notes should never block work.
 */

const SEEN_KEY = 'alto.whatsnew.seen.v1';

interface ChangelogBullet {
  text: string;
  /** Only shown to users who can manage scheduling — an associate on a
   *  phone has no sidebar to hover or ⌘K to press, and reading about
   *  admin features they can't touch is noise, not news. */
  adminOnly?: boolean;
}

interface ChangelogEntry {
  id: string;
  title: string;
  bullets: ChangelogBullet[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-07-02',
    title: 'New this week',
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
      {
        text: "You'll get “Your week ahead” the evening before your work week starts.",
      },
      { text: 'La aplicación ahora habla español — cámbialo en el menú.' },
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
  const [entry, setEntry] = useState<ChangelogEntry | null>(() => latestUnseen());
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
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gold">
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          {entry.title}
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
        {bullets.map((b) => (
          <li key={b.text} className="flex gap-2">
            <span className="text-gold" aria-hidden="true">
              ·
            </span>
            <span>{b.text}</span>
          </li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" className="mt-3 w-full" onClick={dismiss}>
        Got it
      </Button>
    </div>
  );
}
