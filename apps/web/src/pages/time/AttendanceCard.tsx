import { useEffect, useState } from 'react';
import { CalendarX2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AttendanceEvent, AttendanceListResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  excuseAttendanceEvent,
  getAdminAttendance,
  getMyAttendance,
} from '@/lib/timeApi';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Rolling 90-day attendance score + event history. Two modes:
 *  - admin (associateId given): supervisors see the record and can excuse
 *    an event (attributed; points zero out, the row stays).
 *  - self (no associateId): the associate's own transparent view.
 */

const KIND_LABEL: Record<AttendanceEvent['kind'], string> = {
  LATE: 'Late arrival',
  EARLY_OUT: 'Left early',
  CALL_OUT: 'Call-out',
  NO_CALL_NO_SHOW: 'No-call no-show',
};

// Policy ladder — mirror of the API's thresholds, display only.
function scoreTone(score: number): { label: string; tone: 'success' | 'pending' | 'destructive' } {
  if (score >= 7) return { label: 'final warning territory', tone: 'destructive' };
  if (score >= 5) return { label: 'written warning territory', tone: 'destructive' };
  if (score >= 3) return { label: 'verbal warning territory', tone: 'pending' };
  return { label: 'in good standing', tone: 'success' };
}

export function AttendanceCard({
  associateId,
  canManage = false,
}: {
  /** Omit for the associate's own self-view. */
  associateId?: string;
  canManage?: boolean;
}) {
  const [data, setData] = useState<AttendanceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      setData(
        associateId ? await getAdminAttendance(associateId) : await getMyAttendance(),
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load attendance.',
      );
    }
  };
  useEffect(() => {
    setData(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [associateId]);

  const excuse = async (id: string) => {
    setBusyId(id);
    try {
      await excuseAttendanceEvent(id);
      toast.success('Excused — points removed.');
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not excuse.');
    } finally {
      setBusyId(null);
    }
  };

  const tone = data ? scoreTone(data.score) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Attendance</CardTitle>
          {data && tone && (
            <span className="flex items-center gap-2 text-sm">
              <span className="font-semibold tabular-nums text-white">
                {data.score} pts
              </span>
              <Badge variant={tone.tone}>{tone.label}</Badge>
            </span>
          )}
        </div>
        <p className="text-xs text-silver">
          Rolling {data?.windowDays ?? 90}-day score — late 0.5 · left early 0.5 ·
          call-out 1 · no-call no-show 2. Excused events count zero.
        </p>
      </CardHeader>
      <CardContent>
        {error && (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            {error}
          </ErrorBanner>
        )}
        {!data && !error && <Skeleton className="h-16" />}
        {data && data.events.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-silver">
            <CalendarX2 className="h-4 w-4" />
            No attendance events on record — a clean 180-day history.
          </p>
        )}
        {data && data.events.length > 0 && (
          <ul className="divide-y divide-navy-secondary/60">
            {data.events.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className={e.excused ? 'text-silver line-through' : 'text-white'}>
                    {KIND_LABEL[e.kind]}
                  </span>
                  <span className="ml-2 text-xs text-silver">
                    {fmtDate(e.occurredOn)}
                    {e.note ? ` · ${e.note}` : ''}
                    {e.excused
                      ? ` · excused${e.excusedByEmail ? ` by ${e.excusedByEmail}` : ''}`
                      : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`tabular-nums text-xs ${e.excused ? 'text-silver/50 line-through' : 'text-warning'}`}
                  >
                    +{e.points}
                  </span>
                  {canManage && !e.excused && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => void excuse(e.id)}
                      loading={busyId === e.id}
                      disabled={busyId !== null}
                    >
                      Excuse
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
