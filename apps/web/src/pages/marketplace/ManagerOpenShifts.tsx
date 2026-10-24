import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Megaphone, UserPlus } from '@/components/ui/icons';
import { toast } from 'sonner';
import { isOpenShift, type Shift } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { listShifts } from '@/lib/schedulingApi';
import { listPendingClaims } from '@/lib/qualApi';
import { listCallOuts, type CallOutItem } from '@/lib/callOutsApi';
import { listInviteCounts, rebroadcastShift, type InviteCounts, type RebroadcastResult } from '@/lib/openShiftInvitesApi';
import { useI18n, type Translate } from '@/lib/i18n';
import { fmtRelativeDayTz, fmtShiftRangeTz, ymdLocal } from '@/lib/format';
import { cn } from '@/lib/cn';
import { enterStagger } from '@/lib/motion';
import { Badge, Button, Card, CardContent, EmptyState, ErrorBanner, SkeletonRows } from '@/components/ui';

/**
 * The manager's "Open shifts" tab (role walk, ops 11). Managers have no
 * associate record, so the marketplace landed them on Pending claims with
 * no list of open shifts — a dead end four clicks from the shifts
 * themselves. This is the real list: published, unfilled and not over
 * (the shared isOpenShift), soonest first, with what has already been
 * tried for each one (who on the bench was asked and who passed, pending
 * claims, a call-out's cover) and the two things to do next: Assign, or
 * Rebroadcast — ask the eligible bench again (lib/openShiftInvites on the
 * API: availability, time off and quiet hours respected; nobody who said
 * no, nobody twice inside half an hour).
 */

export const MANAGER_OPEN_WINDOW_DAYS = 14;

/** "in 3h 20m" / "in 2 days" / started — how soon the hole opens. */
export function startsInParts(startsAt: string, now: number = Date.now()): { kind: 'started' } | { kind: 'hours'; h: number; m: number } | { kind: 'days'; d: number } {
  const ms = new Date(startsAt).getTime() - now;
  if (ms <= 0) return { kind: 'started' };
  const minutes = Math.round(ms / 60_000);
  if (minutes < 48 * 60) return { kind: 'hours', h: Math.floor(minutes / 60), m: minutes % 60 };
  return { kind: 'days', d: Math.round(minutes / (24 * 60)) };
}

export function openShiftsForManager(shifts: readonly Shift[], now: Date = new Date()): Shift[] {
  return shifts
    .filter((s) => isOpenShift(s, now) && !!s.publishedAt)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

/** The toast after a Rebroadcast: what went out, what waits, or why nobody was asked. */
export function rebroadcastMessage(r: RebroadcastResult, t: Translate): { tone: 'success' | 'info'; text: string } {
  if (r.sent > 0) {
    const sent = t('mk.mgr.rebroadcastSent', { n: r.sent });
    return { tone: 'success', text: r.held > 0 ? `${sent} ${t('mk.mgr.rebroadcastHeld', { n: r.held })}` : sent };
  }
  if (r.skipped.recent > 0) return { tone: 'info', text: t('mk.mgr.rebroadcastRecent') };
  return { tone: 'info', text: t('mk.mgr.rebroadcastNone') };
}

export function ManagerOpenShifts() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const from = ymdLocal(new Date());
  const to = ymdLocal(new Date(Date.now() + MANAGER_OPEN_WINDOW_DAYS * 86_400_000));
  const shiftsQuery = useQuery({
    queryKey: ['marketplace', 'manager-open', from, to],
    queryFn: () => listShifts({ status: 'OPEN', from, to }),
  });
  const claimsQuery = useQuery({ queryKey: ['ClaimsTab', 'rows'], queryFn: () => listPendingClaims(), retry: false });
  // Cover state is decoration: a failed read leaves the rows without it.
  const callOutsQuery = useQuery({ queryKey: ['call-outs', 'week'], queryFn: () => listCallOuts('week'), retry: false });
  // Who was asked and who passed is decoration too: a failed read leaves the counts off.
  const invitesQuery = useQuery({ queryKey: ['open-shift-invites', MANAGER_OPEN_WINDOW_DAYS], queryFn: () => listInviteCounts(MANAGER_OPEN_WINDOW_DAYS), retry: false });

  const rows = useMemo(() => (shiftsQuery.data ? openShiftsForManager(shiftsQuery.data.shifts) : null), [shiftsQuery.data]);
  const claimsByShift = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of claimsQuery.data?.claims ?? []) m.set(c.shiftId, (m.get(c.shiftId) ?? 0) + 1);
    return m;
  }, [claimsQuery.data]);
  const coverByShift = useMemo(() => {
    const m = new Map<string, CallOutItem['cover']>();
    for (const c of callOutsQuery.data?.items ?? []) m.set(c.shift.id, c.cover);
    return m;
  }, [callOutsQuery.data]);
  const invitesByShift = useMemo(() => {
    const m = new Map<string, InviteCounts>();
    for (const c of invitesQuery.data?.counts ?? []) m.set(c.shiftId, c);
    return m;
  }, [invitesQuery.data]);

  const rebroadcast = async (s: Shift) => {
    setBusyId(s.id);
    try {
      const r = await rebroadcastShift(s.id);
      const msg = rebroadcastMessage(r, t);
      if (msg.tone === 'success') toast.success(msg.text);
      else toast(msg.text);
      void qc.invalidateQueries({ queryKey: ['open-shift-invites'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('mk.mgr.rebroadcastFailed'));
    } finally {
      setBusyId(null);
    }
  };

  if (shiftsQuery.isError) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="outline" onClick={() => void shiftsQuery.refetch()}>
            {t('mk.retry')}
          </Button>
        }
      >
        {shiftsQuery.error instanceof ApiError ? shiftsQuery.error.message : t('mk.mgr.loadFailed')}
      </ErrorBanner>
    );
  }
  if (!rows) {
    return (
      <Card>
        <CardContent>
          <SkeletonRows count={3} />
        </CardContent>
      </Card>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Briefcase}
        title={t('mk.mgr.emptyTitle')}
        description={t('mk.mgr.emptyDesc', { days: MANAGER_OPEN_WINDOW_DAYS })}
      />
    );
  }

  const startsLabel = (s: Shift) => {
    const p = startsInParts(s.startsAt);
    if (p.kind === 'started') return t('mk.mgr.started');
    if (p.kind === 'hours') return t('mk.mgr.startsIn', { when: t('mk.mgr.inHours', { h: p.h, m: p.m }) });
    return t('mk.mgr.startsIn', { when: t('mk.mgr.inDays', { d: p.d }) });
  };

  return (
    <div className="space-y-3" data-testid="manager-open-shifts">
      <div className="text-sm text-silver">{t('mk.mgr.count', { n: rows.length, days: MANAGER_OPEN_WINDOW_DAYS })}</div>
      <ul className="space-y-2">
        {rows.map((s, i) => {
          const claims = claimsByShift.get(s.id) ?? 0;
          const cover = coverByShift.get(s.id);
          const invites = invitesByShift.get(s.id);
          return (
            <li key={s.id} style={enterStagger(i)} className="animate-enter">
              <Card>
                <CardContent className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink">
                      {s.position}
                      <span className="font-normal text-silver"> · {[s.clientName, s.locationName ?? s.location].filter(Boolean).join(' · ') || '—'}</span>
                    </div>
                    <div className="text-sm tabular-nums text-silver">
                      {fmtRelativeDayTz(s.startsAt, s.timezone)} · {fmtShiftRangeTz(s.startsAt, s.endsAt, s.timezone)}
                      <span className={cn('ml-2 text-xs', startsInParts(s.startsAt).kind === 'hours' ? 'text-warning' : 'text-silver/70')}>
                        {startsLabel(s)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {invites && invites.sent > 0 && <Badge variant="info">{t('mk.mgr.invited', { n: invites.sent })}</Badge>}
                      {invites && invites.declined > 0 && <Badge variant="default">{t('mk.mgr.passed', { n: invites.declined })}</Badge>}
                      {claims > 0 && <Badge variant="pending">{t('mk.mgr.claims', { n: claims })}</Badge>}
                      {cover?.state === 'looking' && <Badge variant="accent">{t('mk.mgr.coverLooking')}</Badge>}
                      {cover?.state === 'uncovered' && <Badge variant="destructive">{t('mk.mgr.coverUncovered')}</Badge>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void rebroadcast(s)}
                      disabled={busyId === s.id}
                      loading={busyId === s.id}
                    >
                      <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('mk.mgr.rebroadcast')}
                    </Button>
                    <Button size="sm" asChild>
                      <Link to={`/scheduling?view=list&open=1&shift=${s.id}`}>
                        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('mk.mgr.assign')}
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
