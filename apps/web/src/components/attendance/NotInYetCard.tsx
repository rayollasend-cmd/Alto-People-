import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, Clock, Flag, MessageSquareText, Phone, UserX } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getLateNow, type LateNowPerson } from '@/lib/attendanceInsightsApi';
import { raiseFloorFlag, textCrew } from '@/lib/floorApi';
import { fmtTimeTz } from '@/lib/format';
import { useI18n, type MessageKey, type Translate } from '@/lib/i18n';
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
import '@/lib/i18n/en/notIn';

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

const CALLED_OUT: Record<NonNullable<LateNowPerson['calledOutHow']>, MessageKey> = {
  confirmed: 'notIn.calledOut',
  unconfirmed: 'notIn.calledOutUnconfirmed',
  'reminder-no': 'notIn.reminderNo',
};

/** Shifts someone has to cover — nobody is coming. */
const needsCover = (p: LateNowPerson) => p.status === 'no-show-risk' || p.status === 'called-out' || p.status === 'on-leave';

function lateness(t: Translate, p: LateNowPerson): string {
  if (p.status === 'called-out') return t(CALLED_OUT[p.calledOutHow ?? 'confirmed']);
  if (p.status === 'on-leave') return t('notIn.onLeave');
  if (p.minutesLate < 1) return t('notIn.startingNow');
  const h = Math.floor(p.minutesLate / 60);
  const m = p.minutesLate % 60;
  const span = h > 0 ? t('notIn.spanHm', { h, m }) : t('notIn.spanM', { m });
  return p.status === 'due' ? t('notIn.startedAgo', { span }) : t('notIn.late', { span });
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
  quiet,
  className,
}: {
  siteId?: string;
  /** What to say when nobody is listed and nobody is due yet ("Swing starts 2:00 PM — nobody due yet"), instead of "Everyone's in". */
  quiet?: { title: string; description?: string };
  /** Narrow to the people in view (the supervisor's own shift). */
  filter?: (p: LateNowPerson) => boolean;
  /** Offer "find cover" (the caller runs the schedule). */
  canCover?: boolean;
  className?: string;
}) {
  const { can } = useAuth();
  const { t } = useI18n();
  // A watch-only lead can't cover — they raise the flag to whoever can.
  const canFlag = !canCover && can('report:incident');
  const flag = useMutation({
    mutationFn: (p: LateNowPerson) =>
      raiseFloorFlag({ kind: 'NO_SHOW', associateId: p.associateId, shiftId: p.shiftId, clientId: p.clientId, note: t('notIn.flagNote', { name: p.name, status: lateness(t, p).toLowerCase(), time: fmtTimeTz(p.startsAt, p.timezone) }) }),
    onSuccess: (_r, p) => toast.success(t('notIn.flagged', { name: p.name })),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('notIn.flagFailed')),
  });
  const q = useQuery({
    queryKey: lateNowKey(siteId),
    queryFn: () => getLateNow({ siteId }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const [textOpen, setTextOpen] = useState(false);

  if (q.isPending) return <Skeleton className={cn('h-40', className)} />;
  if (q.isError) return <QueryError what={t('notIn.what')} query={q} />;

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
    let failed = 0;
    let optedOut = 0;
    let notConfigured: string | null = null;
    const noPhone: string[] = [];
    for (const [clientId, shiftIds] of byClient) {
      const r = await textCrew({ clientId, shiftIds, body });
      sent += r.sent;
      failed += r.failed;
      optedOut += r.optedOut;
      notConfigured = notConfigured ?? r.notConfigured;
      noPhone.push(...r.noPhone);
    }
    return { sent, failed, optedOut, noPhone, notConfigured };
  };

  return (
    <Card className={className}>
      <CardContent className="space-y-3">
        <SectionTitle
          as="h3"
          icon={UserX}
          title={
            <>
              {t('notIn.title')}
              {missing.length > 0 && <span className="ml-1.5 tabular-nums text-warning">{missing.length}</span>}
            </>
          }
          description={
            people.length > 0
              ? t('notIn.desc', { grace: q.data.graceMinutes, risk: q.data.noShowRiskMinutes })
              : undefined
          }
          trailing={
            q.data.canText && textable.length > 0 ? (
              <Button size="sm" variant="secondary" onClick={() => setTextOpen(true)}>
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {t('notIn.textLate', { n: textable.length })}
              </Button>
            ) : undefined
          }
        />
        {people.length === 0 ? (
          quiet ? (
            <EmptyState size="sm" icon={Clock} title={quiet.title} description={quiet.description} />
          ) : (
            <EmptyState size="sm" icon={CheckCircle2} title={t('notIn.allInTitle')} description={t('notIn.allInDesc')} />
          )
        ) : (
          <ul className="divide-y divide-line" aria-label={t('notIn.listAria')}>
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
                  {lateness(t, p)}
                </Badge>
                <div className="flex flex-wrap gap-1.5">
                  {p.phone && (
                    <>
                      <Button size="xs" variant="outline" asChild>
                        <a href={`tel:${dialable(p.phone)}`} aria-label={t('notIn.callAria', { name: p.name })}>
                          <Phone className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t('notIn.call')}
                        </a>
                      </Button>
                      <Button size="xs" variant="outline" asChild>
                        <a href={`sms:${dialable(p.phone)}`} aria-label={t('notIn.textAria', { name: p.name })}>
                          <MessageSquareText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t('notIn.text')}
                        </a>
                      </Button>
                    </>
                  )}
                  {canCover && needsCover(p) && (
                    // The shift itself: it's still assigned to them, so the
                    // call-outs desk (confirmed, released shifts) wouldn't list it.
                    <Button size="xs" asChild>
                      <Link to={`/scheduling?shift=${p.shiftId}`}>
                        {p.status === 'no-show-risk' ? t('notIn.noShowCover') : t('notIn.findCover')}
                        <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                  {canFlag && (p.status === 'no-show-risk' || p.status === 'late') && (
                    <Button size="xs" variant="outline" loading={flag.isPending && flag.variables?.shiftId === p.shiftId} onClick={() => flag.mutate(p)}>
                      <Flag className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      {t('notIn.flagToSup')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canCover && needCover.length > 1 && <p className="text-xs text-ink-muted">{t('notIn.needCover', { n: needCover.length })}</p>}
      </CardContent>
      {q.data.canText && textable.length > 0 && (
        <CrewTextDialog
          open={textOpen}
          onOpenChange={setTextOpen}
          shiftIds={textable.map((p) => p.shiftId)}
          label={t('notIn.crewLabel')}
          count={textable.length}
          send={sendToLate}
        />
      )}
    </Card>
  );
}
