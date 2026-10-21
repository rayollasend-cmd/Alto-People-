import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, PhoneOff, Repeat, ShieldAlert } from 'lucide-react';
import { getOpsActivity, type OpsActivityKind } from '@/lib/opsActivityApi';
import { fmtRelativeDate } from '@/lib/format';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Recent activity, as the floor lived it: call-outs, weeks published,
 * swaps decided, incidents reported — each row opens where it's worked.
 * (The audit log, sign-ins and all, is one link away.)
 */
const ICON: Record<OpsActivityKind, typeof PhoneOff> = {
  call_out: PhoneOff,
  published: CalendarCheck,
  swap: Repeat,
  incident: ShieldAlert,
};
const TONE: Record<OpsActivityKind, string> = {
  call_out: 'text-warning',
  published: 'text-success',
  swap: 'text-info',
  incident: 'text-alert',
};

export function OpsActivityFeed({ auditLink }: { auditLink: boolean }) {
  const q = useQuery({ queryKey: ['ops-activity', 7], queryFn: () => getOpsActivity(7), staleTime: 60_000 });
  return (
    <section aria-label="Recent activity" className="space-y-3">
      <SectionTitle
        title="Recent activity on the floor"
        description="The last seven days: call-outs, schedules published, swaps decided, incidents."
        trailing={
          auditLink ? (
            <Link to="/audit" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              Audit log <ArrowRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          ) : undefined
        }
      />
      <Card>
        <CardContent className="p-0">
          {q.isPending ? (
            <div className="space-y-3 p-5">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : q.isError ? (
            <div className="p-4">
              <QueryError what="recent activity" query={q} />
            </div>
          ) : q.data.items.length === 0 ? (
            <EmptyState size="sm" icon={CalendarCheck} title="A quiet week" description="No call-outs, publishes, swaps or incidents in the last seven days." />
          ) : (
            <ul className="divide-y divide-line">
              {q.data.items.slice(0, 10).map((i) => {
                const Icon = ICON[i.kind];
                return (
                  <li key={i.id}>
                    <Link to={i.href} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-raised">
                      <Icon className={`h-4 w-4 shrink-0 ${TONE[i.kind]}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{i.title}</span>
                        {i.detail && <span className="block truncate text-xs text-ink-muted">{i.detail}</span>}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-ink-muted">{fmtRelativeDate(i.at)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
