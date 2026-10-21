import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, MessageSquareText, Phone, UserX } from 'lucide-react';
import { getLateNow, type LateNowPerson } from '@/lib/attendanceInsightsApi';
import { fmtTimeTz } from '@/lib/format';
import { cn } from '@/lib/cn';
import { CrewTextDialog } from '@/components/floor/CrewTextDialog';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Not in yet: everyone whose shift has started with no punch, most late
 * first — a call or a text one tap away, one text to all of them, and for
 * the ones past the no-show line (or who called out) the way to cover the
 * shift. Refreshes every minute.
 */

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

export const lateNowKey = (siteId?: string) => ['attendance', 'late-now', siteId ?? 'all'] as const;

function lateness(p: LateNowPerson): string {
  if (p.status === 'called-out') return 'Called out';
  if (p.minutesLate < 1) return 'Starting now';
  const h = Math.floor(p.minutesLate / 60);
  const m = p.minutesLate % 60;
  const span = h > 0 ? `${h}h ${m}m` : `${m} min`;
  return p.status === 'due' ? `Started ${span} ago` : `${span} late`;
}

const STATUS_BADGE: Record<LateNowPerson['status'], 'outline' | 'pending' | 'destructive' | 'info'> = {
  due: 'outline',
  late: 'pending',
  'no-show-risk': 'destructive',
  'called-out': 'info',
};

export function NotInYetCard({
  siteId,
  filter,
  canCover = false,
  className,
}: {
  siteId?: string;
  /** Narrow to the people in view (the supervisor's own shift). */
  filter?: (p: LateNowPerson) => boolean;
  /** Offer "find cover" (the caller runs the schedule). */
  canCover?: boolean;
  className?: string;
}) {
  const q = useQuery({
    queryKey: lateNowKey(siteId),
    queryFn: () => getLateNow({ siteId }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const [textOpen, setTextOpen] = useState(false);

  if (q.isPending) return <Skeleton className={cn('h-40', className)} />;
  if (q.isError) return <QueryError what="who isn’t in yet" query={q} />;

  const people = filter ? q.data.people.filter(filter) : q.data.people;
  const missing = people.filter((p) => p.status !== 'called-out');
  const textable = missing.filter((p) => p.hasPhone);
  const needCover = people.filter((p) => p.status === 'no-show-risk' || p.status === 'called-out');

  return (
    <Card className={className}>
      <CardContent className="space-y-3">
        <SectionTitle
          as="h3"
          icon={UserX}
          title={
            <>
              Who isn’t in yet
              {missing.length > 0 && <span className="ml-1.5 tabular-nums text-warning">{missing.length}</span>}
            </>
          }
          description={
            people.length > 0
              ? `Shift started, no punch. Late after ${q.data.graceMinutes} minutes; find cover after ${q.data.noShowRiskMinutes}.`
              : undefined
          }
          trailing={
            q.data.canText && textable.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => setTextOpen(true)}>
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Text the {textable.length} not in
              </Button>
            ) : undefined
          }
        />
        {people.length === 0 ? (
          <EmptyState size="sm" icon={CheckCircle2} title="Everyone’s in" description="Everyone whose shift has started has punched in." />
        ) : (
          <ul className="divide-y divide-line" aria-label="Not in yet">
            {people.map((p) => (
              <li key={p.shiftId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                <Avatar src={photoUrl(p.associateId)} name={p.name} email="" size="sm" />
                <div className="min-w-0 flex-1">
                  <Link to={`/people/${p.associateId}`} className="block truncate text-sm font-medium text-ink hover:text-gold hover:underline">
                    {p.name}
                  </Link>
                  <span className="block truncate text-xs text-ink-muted">
                    {p.position} · {fmtTimeTz(p.startsAt, p.timezone)}
                    {p.siteName ? ` · ${p.siteName}` : ''}
                  </span>
                </div>
                <Badge variant={STATUS_BADGE[p.status]} size="sm" className="tabular-nums">
                  {lateness(p)}
                </Badge>
                <div className="flex flex-wrap gap-1.5">
                  {p.phone && (
                    <>
                      <Button size="xs" variant="outline" asChild>
                        <a href={`tel:${p.phone}`} aria-label={`Call ${p.name}`}>
                          <Phone className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          Call
                        </a>
                      </Button>
                      <Button size="xs" variant="outline" asChild>
                        <a href={`sms:${p.phone}`} aria-label={`Text ${p.name}`}>
                          <MessageSquareText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          Text
                        </a>
                      </Button>
                    </>
                  )}
                  {canCover && (p.status === 'no-show-risk' || p.status === 'called-out') && (
                    <Button size="xs" asChild>
                      <Link to={p.status === 'called-out' ? '/call-outs' : `/scheduling?shift=${p.shiftId}`}>
                        {p.status === 'called-out' ? 'Find cover' : 'No-show → find cover'}
                        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canCover && needCover.length > 1 && (
          <p className="text-xs text-ink-muted">
            {needCover.length} shifts need cover — <Link to="/call-outs" className="text-accent hover:underline">open the call-outs desk</Link>.
          </p>
        )}
      </CardContent>
      {q.data.canText && textable.length > 0 && (
        <CrewTextDialog
          open={textOpen}
          onOpenChange={setTextOpen}
          shiftIds={textable.map((p) => p.shiftId)}
          label="Not in yet"
          count={textable.length}
        />
      )}
    </Card>
  );
}
