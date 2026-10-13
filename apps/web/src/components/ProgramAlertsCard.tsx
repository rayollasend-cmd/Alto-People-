import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import type { ProgramAlert } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { listMyProgramAlerts } from '@/lib/programsApi';

/**
 * Program dates coming due for the people this user is responsible for:
 * program ends, visa and DS-2019 expiries, I-9 reverifications, sponsor
 * check-ins, petition ends. A supervisor sees their floor; an admin sees
 * everyone. Renders nothing when nothing is due, and nothing for a login
 * the endpoint refuses.
 */
export function ProgramAlertsCard({ className }: { className?: string }) {
  const q = useQuery({
    queryKey: ['programs', 'alerts', 'mine'],
    queryFn: async (): Promise<ProgramAlert[]> => {
      try {
        return (await listMyProgramAlerts()).alerts;
      } catch {
        // A login the endpoint refuses (no client scope, no compliance
        // access) simply has no card.
        return [];
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const alerts = q.data ?? [];
  if (alerts.length === 0) return null;
  const shown = alerts.slice(0, 8);

  return (
    <Card className={cn('animate-enter', className)} data-testid="program-alerts-card">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-white">
            <CalendarClock className="h-4 w-4 text-gold" aria-hidden="true" />
            Program dates coming due
          </h2>
          <span className="text-xs tabular-nums text-silver/70">{alerts.length === 1 ? '1 date' : `${alerts.length} dates`}</span>
        </div>
        <ul className="mt-3 divide-y divide-navy-secondary/60">
          {shown.map((a) => (
            <li key={`${a.programId}-${a.kind}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="text-white">{a.associateName}</span>
                <span className="ml-2 text-xs text-silver/80">
                  {a.label} · {fmtDate(a.dueOn)}
                  {a.siteName ? ` · ${a.siteName}` : ''}
                </span>
              </span>
              <Badge variant={a.severity === 'critical' ? 'destructive' : 'pending'} size="sm">
                {a.daysUntil < 0 ? `${-a.daysUntil}d overdue` : a.daysUntil === 0 ? 'today' : `in ${a.daysUntil}d`}
              </Badge>
            </li>
          ))}
        </ul>
        <Link to="/programs" className="mt-2 inline-block text-xs text-gold hover:underline">
          {alerts.length > shown.length ? `See all ${alerts.length} in Programs` : 'Open Programs'}
        </Link>
      </CardContent>
    </Card>
  );
}
