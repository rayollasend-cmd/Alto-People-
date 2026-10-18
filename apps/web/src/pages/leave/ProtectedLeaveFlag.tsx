import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { getProtectedLeave } from '@/lib/leaveApi';
import { Badge } from '@/components/ui';
import { TYPE_LABEL } from './leaveWords';

/**
 * The job-protection flag on a person record: shown while approved (or
 * provisionally protected) leave is open, so nobody schedules, disciplines
 * or separates someone on protected leave without seeing it. Leave admins
 * get a link to the case; everyone else sees only that the job is protected.
 */
export function ProtectedLeaveFlag({ associateId }: { associateId: string }) {
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['leave', 'person', associateId],
    queryFn: () => getProtectedLeave(associateId),
    enabled: !!associateId && can('view:org'),
    staleTime: 60_000,
  });
  const leave = q.data?.protectedLeave;
  if (!leave) return null;
  const until = leave.to ? ` until ${fmtDate(leave.to)}` : '';
  const badge = (
    <Badge variant="info" caps={false}>
      On protected leave{until}
    </Badge>
  );
  return can('manage:leave') ? (
    <Link to={`/leave?case=${leave.caseId}`} title={`${TYPE_LABEL[leave.type]} — open the case`} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      {badge}
    </Link>
  ) : (
    badge
  );
}
