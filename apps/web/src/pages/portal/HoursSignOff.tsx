import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, ClipboardCheck, Flag } from '@/components/ui/icons';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { fmtDateOnly, fmtDateOnlyRange, fmtDateTime, fmtHours } from '@/lib/format';
import { getWeekHours, signWeekHours, type SignOffState, type WeekHours } from '@/lib/hoursSignOffApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { shiftDays } from './scope';
import '@/lib/i18n/en/portal';

/**
 * The client signs off a finished store week's hours — the timesheet
 * approval Fieldglass and Beeline clients do every week. The store manager
 * reads each person's worked hours (closed punches, breaks out) and signs
 * the week off, or flags the lines they question with a note; Alto's desk
 * hears a flag at once, and the client's page and statements show the
 * sign-off. Hours only — no rates, ever.
 */

export const hoursKey = (scopeQs: string, week?: string | null) => ['clientPortal', 'hours', scopeQs, week ?? 'last'] as const;

const STATE_VARIANT: Record<SignOffState, 'success' | 'pending' | 'destructive' | 'default'> = {
  signed: 'success',
  flagged: 'pending',
  changed: 'destructive',
  unsigned: 'default',
};

/** "Signed off by Lauren W. · Oct 24, 9:12 AM", or what is still to do. */
export function SignOffLine({ data }: { data: Pick<WeekHours, 'state' | 'signOff'> }) {
  const { t } = useI18n();
  const s = data.signOff;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge variant={STATE_VARIANT[data.state]} size="sm">
        {t(`portal.hoursState.${data.state}`)}
      </Badge>
      {s && (
        <span className="text-xs text-silver">
          {t(s.status === 'FLAGGED' ? 'portal.hoursFlaggedBy' : 'portal.hoursSignedBy', {
            name: s.signedByName,
            when: fmtDateTime(s.signedAt),
            hours: fmtHours(s.totalHours),
          })}
        </span>
      )}
    </span>
  );
}

/** The review: each person's hours, a flag and a note per line, and the signature. */
export function HoursSignOffDialog({
  open,
  onClose,
  scopeQs,
  initialWeek = null,
}: {
  open: boolean;
  onClose: () => void;
  scopeQs: string;
  initialWeek?: string | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [week, setWeek] = useState<string | null>(initialWeek);
  const q = useQuery({ queryKey: hoursKey(scopeQs, week), queryFn: () => getWeekHours(scopeQs, week), enabled: open });
  const data = q.data;
  const [flagged, setFlagged] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // A new week (or a reload) starts from that week's own flags.
  useEffect(() => {
    if (!data) return;
    setFlagged(Object.fromEntries((data.signOff?.flags ?? []).map((f) => [f.associateId, f.note])));
    setNote(data.signOff?.note ?? '');
  }, [data]);
  const flagCount = Object.keys(flagged).length;
  const flagsReady = Object.values(flagged).every((n) => n.trim().length >= 3);
  const canSign = !!data && data.canSign && data.signable && data.people > 0 && flagsReady && !busy;

  const toggle = (id: string) =>
    setFlagged((f) => {
      const next = { ...f };
      if (id in next) delete next[id];
      else next[id] = '';
      return next;
    });

  const sign = async () => {
    if (!data || !canSign) return;
    setBusy(true);
    try {
      await signWeekHours(scopeQs, {
        week: data.week.start,
        flags: Object.entries(flagged).map(([associateId, n]) => ({ associateId, note: n.trim() })),
        ...(note.trim() ? { note: note.trim() } : {}),
        expectTotalHours: data.totalHours,
      });
      toast.success(flagCount > 0 ? t('portal.hoursFlaggedToast', { count: flagCount }) : t('portal.hoursSignedToast'));
      await queryClient.invalidateQueries({ queryKey: ['clientPortal', 'hours'] });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('portal.loadFailed'));
      if (err instanceof ApiError && err.status === 409) void q.refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('portal.hoursTitle')}</DialogTitle>
          <DialogDescription>{t('portal.hoursIntro')}</DialogDescription>
        </DialogHeader>
        {!data ? (
          q.isError ? (
            <p className="text-sm text-alert">{q.error instanceof ApiError ? q.error.message : t('portal.loadFailed')}</p>
          ) : (
            <Skeleton className="h-48" />
          )
        ) : (
          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                size="sm"
                value={data.week.start}
                onChange={(e) => setWeek(e.target.value)}
                aria-label={t('portal.hoursPickWeek')}
                className="w-auto"
              >
                {data.weeks.map((w) => (
                  <option key={w} value={w}>
                    {fmtDateOnlyRange(w, shiftDays(w, 6))}
                  </option>
                ))}
              </Select>
              <span className="text-sm text-silver">{data.store.name}</span>
            </div>
            <SignOffLine data={data} />
            {data.state === 'changed' && <p className="text-xs text-alert">{t('portal.hoursChangedHint')}</p>}
            {data.openPunches > 0 && (
              <p className="text-xs text-warning">{t('portal.hoursOpenPunches', { count: data.openPunches })}</p>
            )}
            {data.people === 0 ? (
              <p className="py-4 text-sm text-silver">{t('portal.hoursNone')}</p>
            ) : (
              <ul className="divide-y divide-navy-secondary/60 rounded-lg border border-navy-secondary/70" aria-label={t('portal.hoursLines')}>
                {data.lines.map((l) => {
                  const isFlagged = l.associateId in flagged;
                  return (
                    <li key={l.associateId} className={cn('px-3 py-2', isFlagged && 'bg-warning/[0.06]')}>
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">{l.name}</span>
                          <span className="block text-2xs text-silver/70">{t('portal.hoursPunches', { count: l.punches })}</span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{fmtHours(l.hours)}</span>
                        {data.canSign && data.signable && (
                          <Button
                            size="xs"
                            variant={isFlagged ? 'secondary' : 'ghost'}
                            onClick={() => toggle(l.associateId)}
                            aria-pressed={isFlagged}
                            aria-label={t(isFlagged ? 'portal.hoursUnflagLine' : 'portal.hoursFlagLine', { name: l.name })}
                            className="shrink-0 coarse:min-h-11"
                          >
                            <Flag className="h-3.5 w-3.5 sm:mr-1" aria-hidden="true" />
                            <span className="hidden sm:inline">{isFlagged ? t('portal.hoursFlagged') : t('portal.hoursFlag')}</span>
                          </Button>
                        )}
                      </div>
                      {isFlagged && (
                        <Input
                          value={flagged[l.associateId] ?? ''}
                          onChange={(e) => setFlagged((f) => ({ ...f, [l.associateId]: e.target.value }))}
                          placeholder={t('portal.hoursFlagNote')}
                          aria-label={t('portal.hoursFlagNoteFor', { name: l.name })}
                          maxLength={500}
                          className="mt-2"
                        />
                      )}
                    </li>
                  );
                })}
                <li className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="text-silver">{t('portal.hoursTotal', { count: data.people })}</span>
                  <span className="font-semibold tabular-nums text-ink">{fmtHours(data.totalHours)}</span>
                </li>
              </ul>
            )}
            {data.canSign && data.signable && data.people > 0 && (
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('portal.hoursNote')}
                aria-label={t('portal.hoursNote')}
                maxLength={1000}
              />
            )}
            {!data.canSign && <p className="text-xs text-silver/70">{t('portal.hoursPreviewOnly')}</p>}
            {data.canSign && !data.signable && <p className="text-xs text-silver/70">{t('portal.hoursNotSignable')}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {data?.canSign && data.signable && (
            <Button onClick={() => void sign()} disabled={!canSign} loading={busy}>
              {flagCount > 0
                ? t('portal.hoursSignFlagged', { count: flagCount })
                : t('portal.hoursSign', { hours: fmtHours(data.totalHours) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** History's card: the last finished week's sign-off, one tap from the review. */
export function HoursSignOffPanel({ scopeQs }: { scopeQs: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: hoursKey(scopeQs, null), queryFn: () => getWeekHours(scopeQs, null), retry: false });
  // A market account at a several-store client signs store by store: the card waits for a store.
  const hidden = q.isError && q.error instanceof ApiError && q.error.status === 400;
  const data = q.data;
  const subtitle = useMemo(() => (data ? fmtDateOnlyRange(data.week.start, data.week.end) : ''), [data]);
  if (hidden) return null;
  return (
    <Card data-testid="portal-hours-signoff">
      <CardContent>
        <SectionTitle
          size="sm"
          className="mb-0"
          icon={ClipboardCheck}
          title={t('portal.hoursTitle')}
          trailing={data ? <span className="text-xs text-silver/70">{subtitle}</span> : undefined}
        />
        {!data ? (
          q.isError ? (
            <p className="mt-3 text-sm text-silver/70">{t('portal.loadFailed')}</p>
          ) : (
            <Skeleton className="mt-3 h-16" />
          )
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-2xl font-semibold tabular-nums text-ink">{fmtHours(data.totalHours)}</div>
              <div className="text-xs text-silver">{t('portal.hoursPeople', { count: data.people })}</div>
              <div className="mt-1.5">
                <SignOffLine data={data} />
              </div>
            </div>
            <Button size="sm" variant={data.state === 'unsigned' || data.state === 'changed' ? 'primary' : 'secondary'} onClick={() => setOpen(true)} className="coarse:min-h-11">
              {data.state === 'signed' || data.state === 'flagged' ? (
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              )}
              {data.canSign && data.signable && (data.state === 'unsigned' || data.state === 'changed')
                ? t('portal.hoursReview')
                : t('portal.hoursOpen')}
            </Button>
          </div>
        )}
        {open && <HoursSignOffDialog open={open} onClose={() => setOpen(false)} scopeQs={scopeQs} />}
      </CardContent>
    </Card>
  );
}

/** A finished week the client hasn't signed (or that changed since) — for the home's Needs you. */
export function useHoursToSign(scopeQs: string, enabled: boolean) {
  return useQuery({
    queryKey: hoursKey(scopeQs, null),
    queryFn: () => getWeekHours(scopeQs, null),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}


/** "Oct 17": a week's first day, for the Needs-you line. */
export const weekStartLabel = (ymd: string) => fmtDateOnly(ymd, { year: 'auto' });
