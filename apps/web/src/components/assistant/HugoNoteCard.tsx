import type { HugoNoteKind, HugoNoteView } from '@alto-people/shared';
import { CalendarPlus, FileText, Users, Wallet, X, type LucideIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import '@/lib/i18n/en/hugoWork';
import { noteText } from './hugoWorkText';

export const NOTE_ICON: Record<HugoNoteKind, LucideIcon> = {
  CREDENTIAL_EXPIRING: FileText,
  OPEN_SHIFT_MATCH: CalendarPlus,
  DIRECT_DEPOSIT_MISSING: Wallet,
  UNCONFIRMED_TOMORROW: Users,
};

/**
 * Something Hugo noticed in the person's own records, with the one thing it
 * could do about it. Nothing happens until they tap it; "Not now" puts it
 * away for good.
 */
export function HugoNoteCard({
  note,
  busy,
  compact = false,
  onAccept,
  onDismiss,
}: {
  note: HugoNoteView;
  busy: 'accept' | 'dismiss' | null;
  /** The home seat's slimmer row. */
  compact?: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t, lang } = useI18n();
  const words = noteText(note, t, lang);
  const Icon = NOTE_ICON[note.kind];
  return (
    <article
      aria-label={words.title}
      data-testid="hugo-note"
      data-kind={note.kind}
      className={cn('relative rounded-xl border border-accent/40 bg-accent-fill/[0.07]', compact ? 'p-2.5' : 'p-3')}
    >
      <div className="flex gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-fill/20 text-accent" aria-hidden="true">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1 pr-6">
          <p className="text-sm font-medium leading-snug text-ink">
            {note.status === 'NEW' && <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-gold-bright align-middle" aria-label={t('hugoWork.new')} role="img" />}
            {words.title}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{words.body}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onAccept} loading={busy === 'accept'} disabled={busy !== null && busy !== 'accept'}>
              {words.action}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss} loading={busy === 'dismiss'} disabled={busy !== null && busy !== 'dismiss'} aria-label={t('hugoWork.note.dismissAria', { title: words.title })}>
              {t('hugoWork.note.dismiss')}
            </Button>
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        disabled={busy !== null}
        aria-label={t('hugoWork.note.dismissAria', { title: words.title })}
        className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-md text-ink-muted hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </article>
  );
}
