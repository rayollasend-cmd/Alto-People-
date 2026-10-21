import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Inbox } from 'lucide-react';
import type { InboxSource } from '@alto-people/shared';
import { ListTemplate } from '@/components/templates';
import { Badge, Card, EmptyState, SectionTitle, SkeletonRows, buttonVariants } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';
import { inboxLink, useInbox } from '@/lib/inboxApi';
import { useI18n } from '@/lib/i18n';
import { useListKeyboard } from '@/lib/shortcuts';

/**
 * Inbox — every decision waiting on the signed-in person, in one place.
 *
 * The principle (docs/ux-upgrade-investigation.md): the person sees
 * decisions; navigation is how you get elsewhere. So this page is a ranked
 * list of queues with something in them, each a count and an "Open" link
 * into the queue's own page. Queues the person may see but that are empty
 * fold under "All clear" so they still know what is being watched.
 */
export function InboxHome() {
  const { t } = useI18n();
  const inbox = useInbox();
  const navigate = useNavigate();

  const { waiting, quiet } = useMemo(() => {
    const sources = inbox.data?.sources ?? [];
    return {
      waiting: sources.filter((s) => s.count > 0).sort((a, b) => b.count - a.count),
      quiet: sources.filter((s) => s.count === 0),
    };
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
              <ul className="divide-y divide-navy-secondary" aria-label={t('decisions.waitingAria')} {...kb.listProps}>
                {waiting.map((s) => (
                  <SourceRow key={s.key} source={s} rowProps={kb.rowProps(s.key)} />
                ))}
              </ul>
            </Card>
          )}
          {quiet.length > 0 && (
            <section aria-labelledby="inbox-quiet">
              <SectionTitle
                as="h2"
                title={<span id="inbox-quiet">{t('decisions.allClear')}</span>}
                description={t('decisions.allClearBody')}
                className="mb-2"
              />
              <ul className="flex flex-wrap gap-2" aria-label={t('decisions.quietAria')}>
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
            </section>
          )}
        </div>
      )}
    </ListTemplate>
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
        <h3 className="text-base font-medium text-ink">{source.label}</h3>
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
