import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/Skeleton';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, CalendarCheck, CalendarPlus, CheckCircle2, ClipboardList, Clock, FileSignature, FileUp, FileWarning, Inbox, MessageSquare, type LucideIcon } from 'lucide-react';
import type { InboxSource } from '@alto-people/shared';
import { useInbox } from '@/lib/inboxApi';
import { getMyTraining } from '@/lib/lms94Api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate, fmtDateOnly, fmtWeekday } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

/**
 * The associate's "Needs you" — the things to do, not the unread count.
 *
 * Every row is a source from GET /me/inbox, so the home, the rail and the
 * Inbox page can never disagree. But it lists TASKS (role walk floor 24):
 * "Finish onboarding — 2 of 8 done → Continue", "Upload leave
 * certification — due Mon, Nov 2", "Sign your agreement" — each opening
 * the place it is done. The unread-notices count is not a task: it no
 * longer leads the section or its number, and sits under the tasks as one
 * quiet line, so the email-style reminders about a task never outrank the
 * task itself.
 *
 * When the inbox cannot be read, the card says so rather than claiming
 * "all caught up" — a false all-clear on an unsigned agreement is worse
 * than a missing row.
 */

const ROW: Record<string, { icon: LucideIcon; label: MessageKey }> = {
  'my-onboarding': { icon: ClipboardList, label: 'needs.my-onboarding' },
  'my-leave-certification': { icon: FileUp, label: 'needs.my-leave-certification' },
  'my-agreements': { icon: FileSignature, label: 'needs.my-agreements' },
  'my-pay-notices': { icon: FileSignature, label: 'needs.my-pay-notices' },
  'my-documents': { icon: FileWarning, label: 'needs.my-documents' },
  'my-punch-fixes': { icon: Clock, label: 'needs.my-punch-fixes' },
  'my-shifts': { icon: CalendarCheck, label: 'needs.my-shifts' },
  'my-ot-offers': { icon: CalendarPlus, label: 'needs.my-ot-offers' },
  'my-training': { icon: BookOpen, label: 'needs.my-training' },
  messages: { icon: MessageSquare, label: 'needs.messages' },
};

/** Read, not done: never a task, never the section's number. */
const NOT_A_TASK = new Set(['my-notifications']);

/** Most pressing first: the soonest deadline, then the order above. */
const ORDER = Object.keys(ROW);
function byPressing(a: InboxSource, b: InboxSource): number {
  // A calendar-day deadline (dueDate) sorts as that day's noon; an instant as itself.
  const due = (s: InboxSource) =>
    s.dueDate ? Date.parse(`${s.dueDate}T12:00:00Z`) : s.dueAt ? Date.parse(s.dueAt) : Number.POSITIVE_INFINITY;
  const rank = (s: InboxSource) => (ORDER.includes(s.key) ? ORDER.indexOf(s.key) : ORDER.length);
  return due(a) - due(b) || rank(a) - rank(b);
}

export function useAssociateNeedsYou(opts: { hide?: readonly string[] } = {}) {
  const q = useInbox();
  const hide = new Set(opts.hide ?? []);
  const sources = q.data?.sources ?? [];
  const rows = sources.filter((s) => s.count > 0 && !NOT_A_TASK.has(s.key) && !hide.has(s.key)).sort(byPressing);
  const unread = sources.find((s) => s.key === 'my-notifications' && s.count > 0) ?? null;
  // The number on the section is the tasks, not the unread notices.
  const count = rows.reduce((n, s) => n + s.count, 0);
  return { query: q, rows, unread, count };
}

/** "Mon, Nov 2" — a plain date, not 2026-11-02. */
function plainDay(iso: string): string {
  const d = new Date(iso);
  return `${fmtWeekday(d)}, ${fmtDate(d)}`;
}

export function AssociateNeedsYou({ hide }: { hide?: readonly string[] } = {}) {
  const { t } = useI18n();
  const { query, rows, unread } = useAssociateNeedsYou({ hide });

  if (query.isError) {
    return (
      <ErrorBanner
        severity="warning"
        action={
          <Button size="xs" variant="secondary" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t('dash.checkFailed')}
      </ErrorBanner>
    );
  }
  if (query.isPending) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (!query.data) return null;
  if (rows.length === 0) {
    return (
      <div className="space-y-1">
        <p className="inline-flex items-center gap-1 text-xs text-silver/70">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          {t('dash.allCaughtUp')}
        </p>
        {unread && <UnreadLine source={unread} />}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-navy-secondary rounded-lg border border-gold/40 bg-navy px-4" data-testid="associate-needs-you">
        {rows.map((s) => {
          const def = ROW[s.key];
          const Icon = def?.icon ?? Inbox;
          const done = s.progress?.done ?? null;
          const total = s.progress?.total ?? null;
          return (
            <li key={s.key}>
              <Link
                to={s.path}
                className="group flex items-center gap-2.5 py-2.5 coarse:min-h-11 text-sm text-ink hover:text-gold-bright active:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
              >
                {done !== null && total ? (
                  <ProgressRing done={done} total={total} />
                ) : (
                  <Icon className="h-4 w-4 shrink-0 text-silver transition-colors group-hover:text-gold" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block">{def ? t(def.label) : s.label}</span>
                  {done !== null && total ? (
                    <span className="block text-xs text-silver">{t('needs.progress', { done, total })}</span>
                  ) : s.dueDate ? (
                    // A date-only deadline reads as its own day in every zone (it read a day early west of UTC).
                    <span className="block text-xs text-silver">{t('needs.dueOn', { date: fmtDateOnly(s.dueDate, { weekday: true, year: 'auto' }) })}</span>
                  ) : s.dueAt ? (
                    <span className="block text-xs text-silver">{t('needs.dueOn', { date: plainDay(s.dueAt) })}</span>
                  ) : null}
                </span>
                {s.count > 1 && (
                  <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">{s.count}</span>
                )}
                <span className="shrink-0 text-xs font-medium text-gold">{t('needs.go')}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-silver/70 transition-colors group-hover:text-gold" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
      {unread && <UnreadLine source={unread} />}
    </div>
  );
}

/** The unread notices, as one quiet line under the tasks. */
function UnreadLine({ source }: { source: InboxSource }) {
  const { t } = useI18n();
  return (
    <Link to={source.path} className="inline-flex min-h-6 items-center gap-1.5 py-1 text-xs text-silver hover:text-gold-bright coarse:min-h-11" data-testid="needs-unread">
      <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
      {t('needs.unreadNotices', { n: source.count })}
    </Link>
  );
}

/** A small ring for "2 of 8 done". */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, done / total));
  return (
    <svg viewBox="0 0 18 18" className="h-[18px] w-[18px] shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-navy-secondary" />
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} className="stroke-gold" />
    </svg>
  );
}

/**
 * Training in the flow of work: the day a required course is still open,
 * or a certification is about to lapse, the nudge sits under the shift
 * rather than three taps away in My learning.
 */
export function TrainingNudge({ nextShiftAt }: { nextShiftAt: string | null }) {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['learning', 'mine'], queryFn: () => getMyTraining().catch(() => null), staleTime: 5 * 60_000 });
  const rows = q.data?.enrollments ?? [];
  const horizon = nextShiftAt ? new Date(nextShiftAt).getTime() : Date.now() + 7 * 86_400_000;
  const due = rows.find((r) => r.isRequired && (r.status === 'ASSIGNED' || r.status === 'IN_PROGRESS' || r.status === 'EXPIRED'));
  const expiring = rows.find((r) => r.status === 'COMPLETED' && r.expiresAt && new Date(r.expiresAt).getTime() <= horizon + 30 * 86_400_000);
  const hit = due ?? expiring;
  if (!hit) return null;
  return (
    <Link
      to="/learning"
      data-testid="training-nudge"
      className="mb-4 flex items-center gap-3 rounded-lg border border-gold/40 bg-gold/[0.06] p-3 text-sm transition-colors hover:bg-gold/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <BookOpen className="h-5 w-5 shrink-0 text-gold" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{t('train.dueTitle')}</span>
        <span className="block text-xs text-silver">
          {due ? t('train.dueBody', { title: due.courseTitle }) : t('train.expiring', { title: expiring!.courseTitle, date: fmtDate(expiring!.expiresAt!) })}
        </span>
      </span>
      <span className="shrink-0 text-xs font-medium text-gold">{t('train.open')} →</span>
    </Link>
  );
}
