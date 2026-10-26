import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { HugoNoteKind, HugoNoteSettings } from '@alto-people/shared';
import { Sparkles } from '@/components/ui/icons';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { NOTE_ICON } from '@/components/assistant/HugoNoteCard';
import { useAssistant } from '@/lib/assistantContext';
import { getHugoNoteSettings, setHugoNoteKind } from '@/lib/hugoApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';

/**
 * What Hugo may point out on his own, kind by kind (Settings › Notifications).
 * Off clears what is showing of that kind and stops new ones; the channels
 * his notices use are the "Assistant tasks and notes" row above.
 */
export function HugoNotesCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { available, me } = useAssistant();
  const q = useQuery({ queryKey: ['hugo', 'note-settings'], queryFn: getHugoNoteSettings, enabled: available, retry: false });
  const [pending, setPending] = useState<HugoNoteKind | null>(null);
  if (!available || !me || q.isError) return null;
  if (q.data && q.data.kinds.length === 0) return null;
  const name = me.name;

  const toggle = async (kind: HugoNoteKind, on: boolean) => {
    setPending(kind);
    // The switch moves at once; a failure puts it back.
    const before = q.data;
    qc.setQueryData<HugoNoteSettings>(['hugo', 'note-settings'], (old) => (old ? { kinds: old.kinds.map((k) => (k.kind === kind ? { ...k, on } : k)) } : old));
    try {
      qc.setQueryData(['hugo', 'note-settings'], await setHugoNoteKind(kind, on));
      void qc.invalidateQueries({ queryKey: ['hugo', 'notes'] });
      void qc.invalidateQueries({ queryKey: ['hugo', 'summary'] });
    } catch {
      qc.setQueryData(['hugo', 'note-settings'], before);
      toast.error(t('hugoWork.settings.failed'));
    } finally {
      setPending(null);
    }
  };

  return (
    <Card data-testid="hugo-notes-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('hugoWork.settings.title', { name })}
        </CardTitle>
        <CardDescription>{t('hugoWork.settings.body', { name })}</CardDescription>
      </CardHeader>
      <CardContent>
        {!q.data ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <ul className="divide-y divide-navy-secondary">
            {q.data.kinds.map((k) => {
              const Icon = NOTE_ICON[k.kind];
              const label = t(`hugoWork.settings.kind.${k.kind}`);
              return (
                <li key={k.kind} className="flex items-center justify-between gap-4 py-3">
                  <span className="flex min-w-0 items-center gap-2.5 text-sm text-ink">
                    <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                    {label}
                  </span>
                  <label className="inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      role="switch"
                      className="peer sr-only"
                      checked={k.on}
                      aria-checked={k.on}
                      disabled={pending === k.kind}
                      aria-label={label}
                      onChange={() => void toggle(k.kind, !k.on)}
                    />
                    <span className="relative h-6 w-11 rounded-full bg-navy-secondary transition peer-checked:bg-gold/80 peer-focus-visible:ring-2 peer-focus-visible:ring-gold after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition after:content-[''] peer-checked:after:translate-x-5" />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
