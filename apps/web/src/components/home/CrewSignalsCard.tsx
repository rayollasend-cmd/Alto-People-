import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, HeartHandshake, PhoneOff } from '@/components/ui/icons';
import { useAuth, useTerm } from '@/lib/auth';
import { listCallOuts } from '@/lib/callOutsApi';
import { getCrewRisk } from '@/lib/retentionApi';
import { Card, CardContent } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * Two signals about the crew, on the lead's and the manager's home:
 * today's call-outs (and whether cover has landed) and how many people on
 * the crew might leave soon. Each is one line with the number and the next
 * step, linking to its desk. Hidden for anyone who can't open either.
 */
export function CrewSignalsCard({ className }: { className?: string }) {
  const { can } = useAuth();
  const term = useTerm();
  const seeCallOuts = can('view:scheduling') || can('manage:scheduling');
  const seeRetention = can('view:org') || can('manage:scheduling');
  const callOuts = useQuery({ queryKey: ['callouts', 'today'], queryFn: () => listCallOuts('today'), enabled: seeCallOuts, refetchInterval: 120_000 });
  const risk = useQuery({ queryKey: ['retention', 'crew'], queryFn: getCrewRisk, enabled: seeRetention });
  if (!seeCallOuts && !seeRetention) return null;

  const rows: Array<{ key: string; to: string; icon: typeof PhoneOff; title: string; detail: string; urgent: boolean }> = [];
  if (seeCallOuts && callOuts.data) {
    const c = callOuts.data;
    rows.push({
      key: 'callouts',
      to: '/call-outs',
      icon: PhoneOff,
      title: c.total === 0 ? 'No call-outs today or tomorrow' : `${c.total} call-out${c.total === 1 ? '' : 's'} today and tomorrow`,
      detail: c.total === 0 ? 'Cover starts on its own if someone calls out.' : c.looking + c.uncovered > 0 ? `${c.looking + c.uncovered} still looking for cover · ${c.covered} covered` : 'All covered',
      urgent: c.looking + c.uncovered > 0,
    });
  }
  if (seeRetention && risk.data) {
    const r = risk.data;
    rows.push({
      key: 'retention',
      to: '/retention',
      icon: HeartHandshake,
      title: r.high > 0 ? `${r.high} ${r.high === 1 ? term('worker').toLowerCase() : term('workers').toLowerCase()} at high risk of leaving` : 'Nobody at high risk of leaving',
      detail: r.high > 0 ? `${r.medium} more at some risk — see why and what helps` : r.medium > 0 ? `${r.medium} at some risk — worth a check-in` : 'Your crew looks steady',
      urgent: r.high > 0,
    });
  }
  const loading = (seeCallOuts && callOuts.isLoading) || (seeRetention && risk.isLoading);

  return (
    <Card className={className}>
      <CardContent className="p-0">
        {loading && rows.length === 0 ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.key}>
                <Link to={r.to} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent coarse:min-h-14">
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full', r.urgent ? 'bg-warning/15 text-warning' : 'bg-surface-raised text-ink-muted')} aria-hidden="true">
                    <r.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">{r.title}</span>
                    <span className="block text-xs text-ink-muted">{r.detail}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
