import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Shift } from '@alto-people/shared';
import { wentUnfilled } from '@alto-people/shared';
import { Button } from '@/components/ui/Button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { CalendarPlus, Clock, Copy, Pencil, UserPlus } from '@/components/ui/icons';
import { useAuth } from '@/lib/auth';
import { fmtDayHeaderTz, fmtShiftSpanTz } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { listAdminTimeEntries } from '@/lib/timeApi';
import '@/lib/i18n/en/schedHome';
import type { QuickActions } from './ShiftHoverCard';
import { shiftActions, shiftEnded, shiftOutcome, type ShiftOutcome } from './shiftHistory';

/**
 * The shift's sheet — one tap from a phone card, or a click on a shift that
 * is already over (FLOOR-18, deep audit 2026-10-29). The header says when
 * (start–end on the store's clock), where (the store; the client only for a
 * viewer across clients) and who. A shift that is over is read-only: it
 * says whether it was worked, with the person's time one tap away, and
 * offers only a copy one week on — never Edit, Reassign or Delete on what
 * already happened.
 */

const HOUR = 3_600_000;

export interface ShiftActionSheetProps {
  shift: Shift;
  canManage: boolean;
  /** The viewer works for one client — the client's name says nothing. */
  hideClientName: boolean;
  /** "Assigned", "Open"… — the page's status words. */
  statusLabel: string;
  actions: QuickActions;
  onCloseOut: (s: Shift) => Promise<void> | void;
  onCopyNextWeek: (s: Shift) => Promise<void> | void;
  /** Close the sheet (every action closes it first). */
  onDone: () => void;
}

export function ShiftActionSheetBody({
  shift: s,
  canManage,
  hideClientName,
  statusLabel,
  actions,
  onCloseOut,
  onCopyNextWeek,
  onDone,
}: ShiftActionSheetProps) {
  const { t } = useI18n();
  const { can } = useAuth();
  const ended = shiftEnded(s);
  const set = shiftActions(s, canManage);
  const canSeeTime = can('manage:time');
  const store = s.locationName ?? s.location ?? null;
  const where = [store, hideClientName ? null : s.clientName].filter(Boolean).join(' · ');
  // Was it worked? The holder's punches around the shift's hours — only
  // for a shift that is over, held by someone, read by someone who may.
  const punches = useQuery({
    queryKey: ['scheduling', 'shift-punches', s.id, s.assignedAssociateId, s.startsAt, s.endsAt],
    enabled: ended && !!s.assignedAssociateId && canSeeTime && s.status !== 'CANCELLED',
    queryFn: () =>
      listAdminTimeEntries({
        associateId: s.assignedAssociateId!,
        from: new Date(Date.parse(s.startsAt) - 4 * HOUR).toISOString(),
        to: s.endsAt,
      }),
    staleTime: 60_000,
    retry: false,
  });
  const outcome: ShiftOutcome | null = !ended
    ? null
    : wentUnfilled(s)
      ? { kind: 'unfilled' }
      : punches.data
        ? shiftOutcome(s, punches.data.entries)
        : null;
  const act = (fn: (shift: Shift) => Promise<void> | void) => () => {
    onDone();
    void fn(s);
  };
  const timeLink = s.assignedAssociateId
    ? `/time-attendance?associate=${s.assignedAssociateId}&name=${encodeURIComponent(s.assignedAssociateName ?? '')}`
    : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{s.position}</DialogTitle>
        <DialogDescription asChild>
          <div className="space-y-0.5" data-testid="shift-sheet-facts">
            <div className="tabular-nums">
              {fmtDayHeaderTz(s.startsAt, s.timezone)} · {fmtShiftSpanTz(s.startsAt, s.endsAt, s.timezone)}
            </div>
            {where && <div>{where}</div>}
            <div>
              {ended && !wentUnfilled(s) ? t('schedHome.sheetEnded') : statusLabel}
              {s.assignedAssociateName ? ` · ${s.assignedAssociateName}` : ''}
            </div>
            {ended && (
              <div className="font-medium text-ink" data-testid="shift-sheet-outcome">
                {outcome === null
                  ? canSeeTime && s.assignedAssociateId && s.status !== 'CANCELLED'
                    ? punches.isError
                      ? t('schedHome.sheetPunchUnknown')
                      : t('schedHome.sheetCheckingPunch')
                    : null
                  : outcome.kind === 'worked'
                    ? t('schedHome.sheetWorked', {
                        span: fmtShiftSpanTz(outcome.clockInAt, outcome.clockOutAt, s.timezone),
                      })
                    : outcome.kind === 'no-punch'
                      ? t('schedHome.sheetNoPunch')
                      : outcome.kind === 'unfilled'
                        ? t('schedHome.sheetWentUnfilled')
                        : t('schedHome.sheetCancelled')}
              </div>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-2" data-testid="shift-sheet-actions">
        {ended && timeLink && canSeeTime && (
          <Button variant="secondary" asChild className="col-span-2">
            <Link to={timeLink} onClick={onDone}>
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {t('schedHome.sheetViewTime')}
            </Link>
          </Button>
        )}
        {set.closeOut && (
          <Button variant="secondary" onClick={act(onCloseOut)}>
            {t('schedHome.sheetCloseOut')}
          </Button>
        )}
        {set.edit && (
          <Button variant="secondary" onClick={act(actions.onEdit)}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            {t('schedHome.sheetEdit')}
          </Button>
        )}
        {set.assign && (
          <Button variant="secondary" onClick={act(actions.onAssign)}>
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {s.assignedAssociateId ? t('schedHome.sheetReassign') : t('schedHome.sheetAssign')}
          </Button>
        )}
        {set.unassign && (
          <Button variant="ghost" onClick={act(actions.onUnassign)}>
            {t('schedHome.sheetUnassign')}
          </Button>
        )}
        {set.publish && (
          <Button variant="ghost" onClick={act(actions.onPublish)}>
            {t('schedHome.sheetPublish')}
          </Button>
        )}
        {set.unpublish && (
          <Button variant="ghost" onClick={act(actions.onUnpublish)}>
            {t('schedHome.sheetToDraft')}
          </Button>
        )}
        {set.duplicate && (
          <Button variant="ghost" onClick={act(actions.onDuplicate)}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {t('schedHome.sheetDuplicate')}
          </Button>
        )}
        {ended && set.copyNextWeek && (
          <Button variant="ghost" onClick={act(onCopyNextWeek)}>
            <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('schedHome.sheetCopyNextWeek')}
          </Button>
        )}
        {set.cancel && (
          <Button variant="ghost" className="text-alert hover:text-alert" onClick={act(actions.onCancel)}>
            {t('schedHome.sheetCancelShift')}
          </Button>
        )}
        {set.delete && (
          <Button variant="ghost" className="text-alert hover:text-alert" onClick={act(actions.onDelete)}>
            {t('schedHome.sheetDelete')}
          </Button>
        )}
      </div>
    </>
  );
}
