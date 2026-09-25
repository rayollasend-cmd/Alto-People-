import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, CalendarClock, Users } from 'lucide-react';
import { fmtDate } from '@/lib/format';
import { getReadyToWorkStatus } from '@/lib/readyToWorkApi';

/**
 * HR's closure line on an approved application: whether the clock-in
 * number went out, who at the store was told, and whether a first shift
 * followed. The handoff is a loop; this is where HR sees it close.
 */
export function ReadyToWorkLine({ associateId }: { associateId: string }) {
  const q = useQuery({
    queryKey: ['ready-to-work', 'associate', associateId],
    queryFn: () => getReadyToWorkStatus(associateId).catch(() => null),
    staleTime: 60_000,
  });
  if (q.isPending) return null;
  const status = q.data;
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-silver/70">
        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
        Clock-in number not issued yet
      </span>
    );
  }
  const names = status.supervisors.map((s) => s.name);
  const told =
    names.length === 0
      ? 'nobody at the store yet'
      : names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-xs text-silver">
      <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Handed to <span className="text-white">{told}</span>
        {status.store ? ` at ${status.store.name}` : ''} on {fmtDate(status.issuedAt)}
      </span>
      <span className="text-silver/50">·</span>
      {status.firstShiftAt ? (
        <span className="inline-flex items-center gap-1 text-success">
          <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
          First shift {fmtDate(status.firstShiftAt)}
        </span>
      ) : status.firstPunchAt ? (
        <span className="inline-flex items-center gap-1 text-success">
          <CalendarCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Punched in {fmtDate(status.firstPunchAt)}
        </span>
      ) : (
        <span className={status.nudgedAt ? 'text-warning' : 'text-silver'}>
          {status.nudgedAt ? 'No first shift yet — store nudged, Workforce told' : 'No first shift yet'}
        </span>
      )}
    </span>
  );
}
