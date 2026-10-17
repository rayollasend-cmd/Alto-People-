import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, CalendarCheck, FileSignature, FileWarning, Inbox, MessageSquare, type LucideIcon } from 'lucide-react';
import { useInbox } from '@/lib/inboxApi';
import { getMyTraining } from '@/lib/lms94Api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

/**
 * The associate's counted "Needs you" — the template's promise, kept:
 * every row is a count from GET /me/inbox, the same number the sidebar
 * badge shows and the same list the Inbox page opens on, so the home,
 * the rail and the page can never disagree. Each row deep-links to where
 * the thing is done.
 *
 * When the inbox cannot be read, the card says so rather than claiming
 * "all caught up" — a false all-clear on an unsigned agreement is worse
 * than a missing row.
 */

const ROW: Record<string, { icon: LucideIcon; label: MessageKey }> = {
  'my-agreements': { icon: FileSignature, label: 'needs.my-agreements' },
  'my-documents': { icon: FileWarning, label: 'needs.my-documents' },
  'my-shifts': { icon: CalendarCheck, label: 'needs.my-shifts' },
  'my-training': { icon: BookOpen, label: 'needs.my-training' },
  'my-notifications': { icon: Inbox, label: 'needs.my-notifications' },
  messages: { icon: MessageSquare, label: 'needs.messages' },
};

export function useAssociateNeedsYou() {
  const q = useInbox();
  const rows = (q.data?.sources ?? []).filter((s) => s.count > 0);
  return { query: q, rows, count: q.data?.total ?? 0 };
}

export function AssociateNeedsYou() {
  const { t } = useI18n();
  const { query, rows } = useAssociateNeedsYou();

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
  if (!query.data) return null;
  if (rows.length === 0) return <p className="text-xs text-silver/70">{t('dash.allCaughtUp')}</p>;

  return (
    <ul className="divide-y divide-navy-secondary rounded-lg border border-gold/40 bg-navy px-4" data-testid="associate-needs-you">
      {rows.map((s) => {
        const def = ROW[s.key];
        const Icon = def?.icon ?? Inbox;
        return (
          <li key={s.key}>
            <Link
              to={s.path}
              className="group flex items-center gap-2.5 py-2.5 coarse:min-h-11 text-sm text-ink hover:text-gold-bright active:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded"
            >
              <Icon className="h-4 w-4 shrink-0 text-silver transition-colors group-hover:text-gold" aria-hidden="true" />
              <span className="min-w-0 flex-1">{def ? t(def.label) : s.label}</span>
              <span className="inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">{s.count}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-silver/70 transition-colors group-hover:text-gold" aria-hidden="true" />
            </Link>
          </li>
        );
      })}
    </ul>
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
