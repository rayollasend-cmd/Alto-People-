import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Plane } from '@/components/ui/icons';
import { PROGRAM_TYPE_LABELS, type ProgramSummary } from '@alto-people/shared';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { fmtDate } from '@/lib/format';
import { getAssociateProgram } from '@/lib/programsApi';

const STATUS_BADGE: Record<ProgramSummary['status'], { variant: 'success' | 'pending' | 'destructive' | 'info' | 'outline'; label: string }> = {
  UPCOMING: { variant: 'info', label: 'Upcoming' },
  ACTIVE: { variant: 'success', label: 'Active' },
  GRACE: { variant: 'pending', label: 'Grace period' },
  ENDED: { variant: 'outline', label: 'Ended' },
  CLOSED: { variant: 'outline', label: 'Closed' },
};

/**
 * The program on the people record: what visa program this person is here
 * on, who sponsors it, when it ends, and every date that is about to fire.
 * A login without compliance access sees nothing (the read is refused and
 * the section stays quiet).
 */
export function ProgramSection({ associateId }: { associateId: string }) {
  const q = useQuery({
    queryKey: ['programs', 'associate', associateId],
    queryFn: () => getAssociateProgram(associateId).catch(() => ({ program: null, denied: true as const })),
    retry: false,
  });
  if (q.isLoading) return <Skeleton className="h-16" />;
  const data = q.data;
  if (!data || ('denied' in data && data.denied)) return null;
  const p = data.program;
  if (!p) {
    return (
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-silver/80">No program on record.</span>
        <Link to={`/programs?associateId=${associateId}`} className="text-xs text-gold hover:underline">
          Add program
        </Link>
      </div>
    );
  }
  const status = STATUS_BADGE[p.status];
  return (
    <div className="space-y-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Plane className="h-3.5 w-3.5 text-silver/70" aria-hidden="true" />
        <span className="text-white">{PROGRAM_TYPE_LABELS[p.type]}</span>
        <Badge variant={status.variant} size="sm">
          {status.label}
        </Badge>
      </div>
      <div className="text-silver/80">
        {fmtDate(p.programStart)} → {fmtDate(p.programEnd)}
        {p.status === 'ACTIVE' || p.status === 'UPCOMING' ? ` · ${p.daysUntilEnd} days left` : ''}
      </div>
      {p.sponsorName && <div className="text-silver/80">Sponsor: {p.sponsorName}</div>}
      {p.type === 'H2B' && p.petitionClientName && <div className="text-silver/80">Petition: {p.petitionClientName}</div>}
      {p.alerts.length > 0 && (
        <ul className="space-y-0.5">
          {p.alerts.map((a) => (
            <li key={a.kind} className={a.severity === 'critical' ? 'text-alert' : 'text-warning'}>
              {a.label}: {fmtDate(a.dueOn)} ({a.daysUntil < 0 ? `${-a.daysUntil} days overdue` : a.daysUntil === 0 ? 'today' : `in ${a.daysUntil} days`})
            </li>
          ))}
        </ul>
      )}
      <Link to={`/programs?associateId=${associateId}`} className="inline-block text-xs text-gold hover:underline">
        Open program
      </Link>
    </div>
  );
}
