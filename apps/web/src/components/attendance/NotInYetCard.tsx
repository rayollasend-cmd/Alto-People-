import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Flag, MessageSquareText, Phone, UserX } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getLateNow, type LateNowPerson } from '@/lib/attendanceInsightsApi';
import { raiseFloorFlag, textCrew } from '@/lib/floorApi';
import { fmtTimeTz } from '@/lib/format';
import { cn } from '@/lib/cn';
import { toast } from '@/components/ui/Toaster';
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
 * first — a call or a text one tap away, one text to everyone who is late,
 * and for the ones past the no-show line, who called out, or who are on
 * approved time off, the way to cover the shift. A watch-only lead can flag
 * a no-show to the supervisor. Refreshes every minute.
 */

const photoUrl = (associateId: string) => `/api/associates/${associateId}/photo`;

export const lateNowKey = (siteId?: string) => ['attendance', 'late-now', siteId ?? 'all'] as const;

/** tel:/sms: with digits (and a leading +) only — "(305) 555-0101 ext 2" dials wrong otherwise. */
export const dialable = (phone: string) => phone.replace(/(?!^\+)[^\d]/g, '');

const CALLED_OUT: Record<NonNullable<LateNowPerson['calledOutHow']>, string> = {
  confirmed: 'Called out',
  unconfirmed: 'Said they can’t make it · not confirmed',
  'reminder-no': 'Said no to the reminder',
};

/** Shifts someone has to cover — nobody is coming. */
const needsCover = (p: LateNowPerson) => p.status === 'no-show-risk' || p.status === 'called-out' || p.status === 'on-leave';

function lateness(p: LateNowPerson): string {
  if (p.status === 'called-out') return CALLED_OUT[p.calledOutHow ?? 'confirmed'];
  if (p.status === 'on-leave') return 'On approved time off';
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
  'on-leave': 'info',
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
  const { can } = useAuth();
  // A watch-only lead can't cover — they raise the flag to whoever can.
  const canFlag = !canCover && can('report:incident');
  const flag = useMutation({
    mutationFn: (p: LateNowPerson) =>
      raiseFloorFlag({ kind: 'NO_SHOW', associateId: p.associateId, shiftId: p.shiftId, clientId: p.clientId, note: `${p.name} isn’t in — ${lateness(p).toLowerCase()} for the ${fmtTimeTz(p.startsAt, p.timezone)} shift.` }),
    onSuccess: (_r, p) => toast.success(`Flagged to the shift supervisor: ${p.name}.`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not raise the flag.'),
  });
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
  // "Missing" is who we're still waiting on — not the ones who said they
  // aren't coming, and not someone on approved time off.
  const missing = people.filter((p) => p.status === 'due' || p.status === 'late' || p.status === 'no-show-risk');
  // A text goes to the ones actually late — not someone a minute past start.
  const textable = missing.filter((p) => p.textable && (p.status === 'late' || p.status === 'no-show-risk'));
  const needCover = people.filter(needsCover);
  // /floor/crew-text texts one client at a time.
  const sendToLate = async (body: string) => {
    const byClient = new Map<string, string[]>();
    for (const p of textable) byClient.set(p.clientId!, [...(byClient.get(p.clientId!) ?? []), p.shiftId]);
    let sent = 0;
    const noPhone: string[] = [];
    for (const [clientId, shiftIds] of byClient) {
      const r = await textCrew({ clientId, shiftIds, body });
      sent += r.sent;
      noPhone.push(...r.noPhone);
    }
    return { sent, noPhone };
  };

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
                Text the {textable.length} late
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
                        <a href={`tel:${dialable(p.phone)}`} aria-label={`Call ${p.name}`}>
                          <Phone className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          Call
                        </a>
                      </Button>
                      <Button size="xs" variant="outline" asChild>
                        <a href={`sms:${dialable(p.phone)}`} aria-label={`Text ${p.name}`}>
                          <MessageSquareText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          Text
                        </a>
                      </Button>
                    </>
                  )}
                  {canCover && needsCover(p) && (
                    // The shift itself: it's still assigned to them, so the
                    // call-outs desk (confirmed, released shifts) wouldn't list it.
                    <Button size="xs" asChild>
                      <Link to={`/scheduling?shift=${p.shiftId}`}>
                        {p.status === 'no-show-risk' ? 'No-show → find cover' : 'Find cover'}
                        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                  {canFlag && (p.status === 'no-show-risk' || p.status === 'late') && (
                    <Button size="xs" variant="outline" loading={flag.isPending && flag.variables?.shiftId === p.shiftId} onClick={() => flag.mutate(p)}>
                      <Flag className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Flag to supervisor
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canCover && needCover.length > 1 && <p className="text-xs text-ink-muted">{needCover.length} shifts need cover — each opens from its row.</p>}
      </CardContent>
      {q.data.canText && textable.length > 0 && (
        <CrewTextDialog
          open={textOpen}
          onOpenChange={setTextOpen}
          shiftIds={textable.map((p) => p.shiftId)}
          label="Late, not in yet"
          count={textable.length}
          send={sendToLate}
        />
      )}
    </Card>
  );
}
