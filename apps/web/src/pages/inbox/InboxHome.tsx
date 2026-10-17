import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Inbox } from 'lucide-react';
import type { InboxSource } from '@alto-people/shared';
import { ListTemplate } from '@/components/templates';
import { Badge, Card, EmptyState, SectionTitle, SkeletonRows, buttonVariants } from '@/components/ui';
import { QueryError } from '@/components/ui/QueryError';
import { cn } from '@/lib/cn';
import { useInbox } from '@/lib/inboxApi';

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
  const inbox = useInbox();

  const { waiting, quiet } = useMemo(() => {
    const sources = inbox.data?.sources ?? [];
    return {
      waiting: sources.filter((s) => s.count > 0).sort((a, b) => b.count - a.count),
      quiet: sources.filter((s) => s.count === 0),
    };
  }, [inbox.data]);

  return (
    <ListTemplate title="Inbox" subtitle="Every decision waiting on you, in one place.">
      {inbox.isPending && <SkeletonRows count={4} rowHeight="h-16" />}
      {inbox.isError && <QueryError what="your inbox" query={inbox} />}
      {inbox.data && (
        <div className="space-y-[var(--d-stack)]">
          {inbox.data.total === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Nothing is waiting on you."
              description="When a decision needs you — an approval, a review, a ruling — it shows up here."
            />
          ) : (
            <Card animate={false}>
              <ul className="divide-y divide-navy-secondary" aria-label="Decisions waiting on you">
                {waiting.map((s) => (
                  <SourceRow key={s.key} source={s} />
                ))}
              </ul>
            </Card>
          )}
          {quiet.length > 0 && (
            <section aria-labelledby="inbox-quiet">
              <SectionTitle
                as="h2"
                title={<span id="inbox-quiet">All clear</span>}
                description="Queues you can act on that are empty right now."
                className="mb-2"
              />
              <ul className="flex flex-wrap gap-2" aria-label="Queues with nothing waiting">
                {quiet.map((s) => (
                  <li key={s.key}>
                    <Link
                      to={s.path}
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

function SourceRow({ source }: { source: InboxSource }) {
  return (
    <li className="flex items-center gap-4 p-[var(--d-card)]">
      <Badge
        variant="pending"
        size="lg"
        withDot={false}
        className="min-w-[2.75rem] justify-center tabular-nums"
        aria-label={`${source.count} waiting`}
      >
        {source.count >= 999 ? '999+' : source.count}
      </Badge>
      <div className="min-w-0 flex-1">
        <h3 className="text-base font-medium text-ink">{source.label}</h3>
        <p className="mt-0.5 text-sm text-silver">{source.description}</p>
      </div>
      <Link
        to={source.path}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
        aria-label={`Open ${source.label}`}
      >
        Open
        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </li>
  );
}
