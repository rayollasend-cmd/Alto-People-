import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarClock, ChevronRight, Inbox } from 'lucide-react';
import { INBOX_URGENCIES, rankInboxSources, type InboxSource, type InboxUrgency } from '@alto-people/shared';
import { ListTemplate } from '@/components/templates';
import { Badge, Card, EmptyState, SkeletonRows, buttonVariants } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';
import { fmtDateOnly } from '@/lib/format';
import { inboxLink, useInbox } from '@/lib/inboxApi';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { useListKeyboard } from '@/lib/shortcuts';

/**
 * Inbox — every decision waiting on the signed-in person, in one place.
 *
 * The principle (docs/ux-upgrade-investigation.md): the person sees
 * decisions; navigation is how you get elsewhere. So this page is a ranked
 * list of queues with something in them, each a count and an "Open" link
 * into the queue's own page.
 *
 * Ranked by what it costs to be late, not by size (role walk HR 4): a
 * legal clock — an E-Verify mismatch, a claim's three-day notice — sits
 * above money, above routine work, however big the routine queue is;
 * within a band the soonest deadline first, and each row says when. The
 * queues the person may see but that are empty fold behind one line
 * ("40 queues clear", ops 20) so they still know what is being watched
 * without scrolling past forty zeros.
 */

const BAND_LABEL: Record<InboxUrgency, MessageKey> = {
  legal: 'decisions.bandLegal',
  money: 'decisions.bandMoney',
  routine: 'decisions.bandRoutine',
};

export function InboxHome() {
  const { t } = useI18n();
  const inbox = useInbox();
  const navigate = useNavigate();

  const { waiting, quiet, watching, bands } = useMemo(() => {
    const sources = inbox.data?.sources ?? [];
    // Company-wide queues another desk owns (packages/shared queues.ts):
    // shown below, folded, and never in the count (F500 SH-4).
    const waiting = rankInboxSources(sources.filter((s) => s.count > 0 && !s.watching));
    const watching = rankInboxSources(sources.filter((s) => s.count > 0 && s.watching));
    const quiet = sources.filter((s) => s.count === 0);
    const bands = INBOX_URGENCIES.map((urgency) => ({
      urgency,
      rows: waiting.filter((s) => (s.urgency ?? 'routine') === urgency),
    })).filter((b) => b.rows.length > 0);
    return { waiting, quiet, watching, bands };
  }, [inbox.data]);
  // j/k move over the queues, Enter opens one (lib/shortcuts).
  const kb = useListKeyboard({ items: waiting, idOf: (s) => s.key, onOpen: (s) => navigate(inboxLink(s.path, s.key)) });

  return (
    <ListTemplate title={t('decisions.title')} subtitle={t('decisions.subtitle')}>
      {inbox.isPending && <SkeletonRows count={4} rowHeight="h-16" />}
      {inbox.isError && <QueryError what={t('decisions.loadWhat')} query={inbox} />}
      {inbox.data && (
        <div className="space-y-[var(--d-stack)]">
          {inbox.data.total === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t('decisions.emptyTitle')}
              description={t('decisions.emptyBody')}
            />
          ) : (
            <Card animate={false}>
              <div {...kb.listProps} className="focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-lg">
                {bands.map((band) => (
                  <section key={band.urgency} aria-labelledby={`inbox-band-${band.urgency}`}>
                    <h2
                      id={`inbox-band-${band.urgency}`}
                      className={cn(
                        'border-b border-navy-secondary px-[var(--d-card)] pt-3 pb-1.5 text-2xs font-semibold uppercase tracking-widest',
                        band.urgency === 'legal' ? 'text-alert' : band.urgency === 'money' ? 'text-gold' : 'text-silver/80',
                      )}
                    >
                      {t(BAND_LABEL[band.urgency])}
                      <span className="ml-1.5 font-normal tabular-nums text-silver/60">{band.rows.length}</span>
                    </h2>
                    <ul className="divide-y divide-navy-secondary" aria-label={t('decisions.waitingAria')}>
                      {band.rows.map((s) => (
                        <SourceRow key={s.key} source={s} rowProps={kb.rowProps(s.key)} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </Card>
          )}
          {watching.length > 0 && (
            // Another desk's job: seen, not counted, out of the way.
            <details className="group rounded-lg border border-navy-secondary/60" data-testid="inbox-watching">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-[var(--d-card)] py-3 text-sm text-silver hover:text-ink [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span className="font-medium">{t('decisions.watchingFold', { n: watching.length })}</span>
                <span className="hidden text-xs text-silver/70 sm:inline">· {t('decisions.watchingBody')}</span>
              </summary>
              <ul className="divide-y divide-navy-secondary border-t border-navy-secondary" aria-label={t('decisions.watchingFold', { n: watching.length })}>
                {watching.map((s) => (
                  <SourceRow key={s.key} source={s} />
                ))}
              </ul>
            </details>
          )}
          {quiet.length > 0 && (
            // Folded: the names still answer "is that being watched?", the
            // zeros no longer take 1,200px of scroll (ops 20).
            <details className="group rounded-lg border border-navy-secondary/60" data-testid="inbox-quiet">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-[var(--d-card)] py-3 text-sm text-silver hover:text-ink [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span id="inbox-quiet" className="font-medium">
                  {quiet.length === 1 ? t('decisions.quietFoldOne') : t('decisions.quietFold', { n: quiet.length })}
                </span>
                <span className="hidden text-xs text-silver/70 sm:inline">· {t('decisions.allClearBody')}</span>
              </summary>
              <ul className="flex flex-wrap gap-2 px-[var(--d-card)] pb-[var(--d-card)]" aria-label={t('decisions.quietAria')}>
                {quiet.map((s) => (
                  <li key={s.key}>
                    <Link
                      to={inboxLink(s.path, s.key)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-navy-secondary px-3 py-1 text-xs text-silver transition-colors hover:border-steel hover:text-ink"
                    >
                      {s.label}
                      <span className="text-silver/60">0</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </ListTemplate>
  );
}

/** "Next due Oct 24" — in alert tone once the day has passed. */
function DueChip({ dueAt }: { dueAt: string }) {
  const { t } = useI18n();
  const overdue = Date.parse(dueAt) < Date.now() - 86_400_000;
  return (
    <Badge variant={overdue ? 'destructive' : 'default'} size="sm" withDot={false} className="gap-1 tabular-nums" data-testid="inbox-due">
      <CalendarClock className="h-3 w-3" aria-hidden="true" />
      {/* A date-only due date arrives as UTC midnight: read it as the day it names (it showed Jan 30 for a Jan 31 deadline west of UTC). */}
      {overdue ? t('decisions.overdue', { date: fmtDateOnly(dueAt) }) : t('decisions.nextDue', { date: fmtDateOnly(dueAt) })}
    </Badge>
  );
}

function SourceRow({ source, rowProps }: { source: InboxSource; rowProps?: ReturnType<ReturnType<typeof useListKeyboard>['rowProps']> }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-4 p-[var(--d-card)]" {...rowProps}>
      <Badge
        variant="pending"
        size="lg"
        withDot={false}
        className="min-w-[2.75rem] justify-center tabular-nums"
        aria-label={t('decisions.nWaiting', { n: source.count })}
      >
        {source.count >= 999 ? '999+' : source.count}
      </Badge>
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-medium text-ink">
          <span>{source.label}</span>
          {source.dueAt && <DueChip dueAt={source.dueAt} />}
        </h3>
        <p className="mt-0.5 text-sm text-silver">{source.description}</p>
      </div>
      <Link
        to={inboxLink(source.path, source.key)}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
        aria-label={t('decisions.openX', { label: source.label })}
      >
        {t('decisions.open')}
        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </li>
  );
}
