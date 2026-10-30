import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { HugoActivityItem, HugoNoteView, HugoTaskEventView, HugoTaskEventCode } from '@alto-people/shared';
import { ArrowLeft, CheckCircle2, Hourglass, Lightbulb, XCircle, type LucideIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { listHugoActivity } from '@/lib/hugoApi';
import { useI18n, type Lang, type MessageKey, type Translate } from '@/lib/i18n';
import '@/lib/i18n/en/hugoWork';
import { TASK_ICON } from './HugoTaskCard';
import { eventLine, fmtDay, noteText, taskTitle } from './hugoWorkText';

/**
 * "See everything Hugo did" (GET /hugo/activity): the person's own history,
 * newest first, grouped by day — "Today", "Yesterday", "Mon, Oct 26" — each
 * line in plain words from its codes: a step on one of their tasks, a note
 * they acted on, something they confirmed through him and how it went, the
 * month's thinking time running out. Paged: "Show earlier".
 */

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-HT', pt: 'pt-BR', uk: 'uk-UA' };
const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Today", "Yesterday", or "Mon, Oct 26" — the reader's own calendar. */
export function dayHeading(iso: string, t: Translate, lang: Lang, now: Date = new Date()): string {
  const d = new Date(iso);
  const key = localKey(d);
  if (key === localKey(now)) return t('hugoWork.activity.today');
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === localKey(y)) return t('hugoWork.activity.yesterday');
  return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(d);
}

const timeOf = (iso: string, lang: Lang) => new Intl.DateTimeFormat(LOCALE[lang], { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

interface Line {
  icon: LucideIcon;
  title: string;
  detail: string | null;
  tone: 'default' | 'positive' | 'negative';
}

/** One history line in the reader's words. */
export function activityLine(item: HugoActivityItem, t: Translate, lang: Lang): Line {
  switch (item.kind) {
    case 'task': {
      const task = item.task!;
      const ev: HugoTaskEventView = { id: item.id, code: item.code as HugoTaskEventCode, data: item.data, at: item.at };
      return { icon: TASK_ICON[task.kind] ?? CheckCircle2, title: taskTitle({ kind: task.kind, subject: task.subject }, t, lang), detail: eventLine(ev, task.kind, t, lang), tone: 'default' };
    }
    case 'note': {
      const note = item.note!;
      const text = noteText({ id: note.id, kind: note.kind, status: 'ACCEPTED', data: note.data, action: { kind: 'link', url: '/' }, createdAt: item.at } as HugoNoteView, t, lang);
      return { icon: Lightbulb, title: t(item.code === 'ACCEPTED' ? 'hugoWork.activity.note.ACCEPTED' : 'hugoWork.activity.note.DISMISSED'), detail: text.title, tone: 'default' };
    }
    case 'action': {
      const code = ['DONE', 'SENT_FOR_APPROVAL', 'FAILED'].includes(item.code) ? item.code : 'DONE';
      return {
        icon: code === 'FAILED' ? XCircle : CheckCircle2,
        title: t(`hugoWork.activity.action.${code}` as MessageKey),
        detail: String(item.data.title ?? ''),
        tone: code === 'FAILED' ? 'negative' : code === 'DONE' ? 'positive' : 'default',
      };
    }
    case 'usage': {
      const renews = typeof item.data.renewsAt === 'string' ? item.data.renewsAt : null;
      return { icon: Hourglass, title: t('hugoWork.activity.usage.USED_UP'), detail: renews ? t('hugoWork.activity.usage.back', { date: fmtDay(localKey(new Date(renews)), lang) }) : null, tone: 'default' };
    }
  }
}

export default function HugoActivity({ name, onBack, onNavigate }: { name: string; onBack: () => void; onNavigate: () => void }) {
  const { t, lang } = useI18n();
  const q = useInfiniteQuery({
    queryKey: ['hugo', 'activity'],
    queryFn: ({ pageParam }) => listHugoActivity(pageParam, 30),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const days = useMemo(() => {
    const out: Array<{ heading: string; items: HugoActivityItem[] }> = [];
    for (const item of items) {
      const heading = dayHeading(item.at, t, lang);
      const last = out[out.length - 1];
      if (last && last.heading === heading) last.items.push(item);
      else out.push({ heading, items: [item] });
    }
    return out;
  }, [items, t, lang]);

  return (
    <div className="space-y-4" data-testid="hugo-activity">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="h-8 px-2" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('hugoWork.activity.back')}
        </Button>
      </div>
      <h3 className="font-display text-2xl text-ink">{t('hugoWork.activity.title', { name })}</h3>

      {q.isLoading && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      )}
      {q.isError && (
        <div className="space-y-2 text-center" role="alert">
          <p className="text-sm text-ink-muted">{t('hugoWork.activity.loadFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            {t('hugoWork.retry')}
          </Button>
        </div>
      )}
      {q.isSuccess && !items.length && <p className="text-sm text-ink-muted">{t('hugoWork.activity.empty', { name })}</p>}

      {days.map((day) => (
        <section key={day.heading} aria-label={day.heading}>
          <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wider text-ink-muted">{day.heading}</h4>
          <ol className="divide-y divide-line rounded-xl border border-line bg-surface-raised">
            {day.items.map((item) => {
              const line = activityLine(item, t, lang);
              const Icon = line.icon;
              return (
                <li key={`${item.kind}-${item.id}`} className="flex gap-3 px-3 py-2.5" data-testid="hugo-activity-line" data-kind={item.kind}>
                  <Icon
                    className={line.tone === 'negative' ? 'mt-0.5 h-4 w-4 shrink-0 text-negative' : line.tone === 'positive' ? 'mt-0.5 h-4 w-4 shrink-0 text-positive' : 'mt-0.5 h-4 w-4 shrink-0 text-ink-muted'}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm leading-snug text-ink">
                      {item.linkUrl ? (
                        <Link to={item.linkUrl} onClick={onNavigate} className="underline-offset-2 hover:underline">
                          {line.title}
                        </Link>
                      ) : (
                        line.title
                      )}
                    </p>
                    {line.detail && <p className="mt-0.5 line-clamp-3 break-words text-xs leading-relaxed text-ink-muted">{line.detail}</p>}
                  </div>
                  <time dateTime={item.at} className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-muted">
                    {timeOf(item.at, lang)}
                  </time>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {q.hasNextPage && (
        <div className="text-center">
          <Button size="sm" variant="outline" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('hugoWork.activity.more')}
          </Button>
        </div>
      )}
    </div>
  );
}
