import { useEffect, useState, type FormEvent } from 'react';
import type {
  Shift,
  ShiftTeammate,
  SwapCandidate,
  TradeOption,
} from '@alto-people/shared';
import {
  acknowledgeMyShift,
  createSwap,
  getMyShiftDetail,
  listSwapCandidates,
  listTradeOptions,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { fmtDateTz, fmtShiftRangeTz, fmtWeekdayTz } from '@/lib/format';
import { ArrowLeftRight, Check, ChevronDown, MapPin, Users } from 'lucide-react';
import { hapticConfirm } from '@/lib/haptics';
import { useI18n, type Translate } from '@/lib/i18n';

export function statusBadge(
  status: Shift['status'],
  t?: Translate,
): { label: string; variant: 'accent' | 'default' | 'success' | 'destructive' } {
  switch (status) {
    case 'ASSIGNED':
      return { label: t ? t('shift.confirmed') : 'Confirmed', variant: 'accent' };
    case 'OPEN':
      return { label: t ? t('shift.open') : 'Open', variant: 'default' };
    case 'COMPLETED':
      return { label: t ? t('shift.worked') : 'Worked', variant: 'success' };
    case 'DRAFT':
      return { label: t ? t('shift.draft') : 'Draft', variant: 'default' };
    case 'CANCELLED':
      return { label: t ? t('shift.cancelled') : 'Cancelled', variant: 'destructive' };
  }
}

export function shiftMinutes(s: Shift): number {
  const ms = new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime();
  return ms > 0 ? Math.round(ms / 60000) : 0;
}

/** "8h", "7h 30m" — shift length for the detail panel. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The tap-to-expand shift card used by the list, week, and month views of
 * My Schedule. Expanding lazily loads the detail (teammates) and exposes
 * acknowledge + swap-offer actions for upcoming assigned shifts.
 */
export function ShiftCard({
  shift,
  isNext,
  muted = false,
  onSwapCreated,
}: {
  shift: Shift;
  isNext: boolean;
  muted?: boolean;
  onSwapCreated?: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [teammates, setTeammates] = useState<ShiftTeammate[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadDetail = async () => {
    try {
      setDetailError(null);
      const res = await getMyShiftDetail(shift.id);
      setTeammates(res.teammates);
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : 'Could not load shift details.',
      );
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && teammates === null) loadDetail();
  };

  const badge = statusBadge(shift.status, t);
  const detailId = `shift-detail-${shift.id}`;
  return (
    <li
      className={[
        'rounded-lg border',
        isNext
          ? 'bg-navy border-gold/50 ring-1 ring-gold/30'
          : 'bg-navy border-navy-secondary',
        muted ? 'opacity-80' : '',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="w-full flex items-center justify-between gap-4 p-4 text-left rounded-lg transition-colors active:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      >
        <div className="min-w-0">
          <div className="text-white font-medium">
            {shift.position}{' '}
            <span className="text-silver text-sm font-normal">
              · {shift.clientName ?? '—'}
            </span>
          </div>
          <div className="text-sm text-silver tabular-nums">
            {/* Past shifts live in a flat "Recent" list with no day headers,
                so the collapsed card carries its own date. */}
            {muted && (
              <>
                {fmtWeekdayTz(shift.startsAt, shift.timezone)},{' '}
                {fmtDateTz(shift.startsAt, shift.timezone)} ·{' '}
              </>
            )}
            {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)}
            {/* Shift length at a glance — associates plan their day around
                it, and it used to hide behind the expand tap. */}
            <span className="text-silver/60">
              {' '}· {fmtDuration(shift.scheduledMinutes)}
            </span>
          </div>
          {shift.location && (
            <div className="text-xs text-silver/70">{shift.location}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex flex-col items-end gap-1">
            {isNext && (
              <Badge variant="accent" className="bg-gold/15 text-gold border-gold/40">
                {t('shift.next')}
              </Badge>
            )}
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <ChevronDown
            aria-hidden="true"
            className={[
              'h-4 w-4 text-silver/70 transition-transform',
              expanded ? 'rotate-180' : '',
            ].join(' ')}
          />
        </div>
      </button>

      {expanded && (
        <div id={detailId} className="border-t border-navy-secondary px-4 py-3">
          <ShiftDetail shift={shift} muted={muted} onSwapCreated={onSwapCreated} />
          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-wider text-silver/80 mb-1.5 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t('shift.workingWithYou')}
              {teammates && teammates.length > 0 && ` (${teammates.length})`}
            </div>
            {teammates === null && !detailError && (
              <SkeletonRows count={2} rowHeight="h-5" />
            )}
            {detailError && (
              <p role="alert" className="text-xs text-alert">
                {detailError}{' '}
                <button
                  type="button"
                  onClick={loadDetail}
                  className="underline underline-offset-2 hover:text-white"
                >
                  {t('common.retry')}
                </button>
              </p>
            )}
            {teammates && teammates.length === 0 && (
              <p className="text-xs text-silver/70">{t('shift.noTeammates')}</p>
            )}
            {teammates && teammates.length > 0 && (
              <ul className="space-y-1.5">
                {teammates.map((t) => (
                  // Stacked on phones — the one-line layout crushed the
                  // NAME ("Pat Ng…") to make room for position·time·zone
                  // (caught by the visual walk). Single line returns at sm+
                  // where there's room for both.
                  <li
                    key={t.associateId}
                    className="text-sm sm:flex sm:items-baseline sm:justify-between sm:gap-3"
                  >
                    <span className="block text-white sm:truncate">{t.name}</span>
                    <span className="block text-xs text-silver tabular-nums sm:text-right sm:shrink-0">
                      {t.position} ·{' '}
                      {fmtShiftRangeTz(t.startsAt, t.endsAt, shift.timezone)}
                      {t.location ? ` · ${t.location}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

/** The facts row of the expanded card: date, hours, site, manager note. */
function ShiftDetail({
  shift,
  muted,
  onSwapCreated,
}: {
  shift: Shift;
  muted: boolean;
  onSwapCreated?: () => void;
}) {
  const { t } = useI18n();
  const [ackAt, setAckAt] = useState(shift.acknowledgedAt);
  const [acking, setAcking] = useState(false);
  const site = [shift.locationName, shift.location].filter(Boolean).join(' · ');
  const upcoming =
    !muted &&
    shift.status === 'ASSIGNED' &&
    new Date(shift.startsAt).getTime() > Date.now();

  const acknowledge = async () => {
    setAcking(true);
    try {
      const updated = await acknowledgeMyShift(shift.id);
      setAckAt(updated.acknowledgedAt ?? new Date().toISOString());
      hapticConfirm();
      toast.success(t('shift.confirmedToast'));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not confirm the shift.',
      );
    } finally {
      setAcking(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm text-silver">
        <span className="text-white">
          {fmtWeekdayTz(shift.startsAt, shift.timezone)},{' '}
          {fmtDateTz(shift.startsAt, shift.timezone)}
        </span>{' '}
        · {fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)} ·{' '}
        <span className="tabular-nums">{fmtDuration(shift.scheduledMinutes)}</span>
      </div>
      {site && (
        <div className="text-xs text-silver/70 inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" aria-hidden="true" />
          {site}
        </div>
      )}
      {shift.notes && (
        <p className="text-xs text-silver bg-navy-secondary/30 border border-navy-secondary rounded px-2.5 py-1.5">
          <span className="text-silver/70">{t('shift.managerNote')}</span>
          {shift.notes}
        </p>
      )}
      {upcoming && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {ackAt ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('shift.youConfirmed')}
            </span>
          ) : (
            <Button size="sm" onClick={acknowledge} loading={acking} disabled={acking}>
              <Check className="h-3.5 w-3.5" />
              {t('shift.illBeThere')}
            </Button>
          )}
          <SwapOfferForm shiftId={shift.id} onCreated={onSwapCreated} />
        </div>
      )}
    </div>
  );
}

/**
 * "Offer this shift to a teammate" — the associate side of the swap flow.
 * Candidates are the schedulable pool at this client; people already booked
 * (or on PTO / a day off) over this window show as "busy" and can't be
 * picked. Optionally asks for one of the counterparty's shifts in exchange
 * (a true trade — the manager approves both halves).
 */
function SwapOfferForm({
  shiftId,
  onCreated,
}: {
  shiftId: string;
  onCreated?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<SwapCandidate[] | null>(null);
  const [candError, setCandError] = useState<string | null>(null);
  const [counterpartyId, setCounterpartyId] = useState('');
  const [tradeOptions, setTradeOptions] = useState<TradeOption[] | null>(null);
  const [counterpartShiftId, setCounterpartShiftId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Trade half: once a counterparty is picked, offer their upcoming shifts
  // as an optional "take one in exchange" list.
  useEffect(() => {
    setCounterpartShiftId('');
    if (!counterpartyId) {
      setTradeOptions(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await listTradeOptions(counterpartyId);
        if (!cancelled) setTradeOptions(res.options);
      } catch {
        // Trade list failing shouldn't block a plain give-away.
        if (!cancelled) setTradeOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [counterpartyId]);

  const openForm = async () => {
    setOpen(true);
    if (candidates === null) {
      try {
        setCandError(null);
        const res = await listSwapCandidates(shiftId);
        setCandidates(res.candidates);
      } catch (err) {
        setCandError(
          err instanceof ApiError ? err.message : 'Could not load teammates.',
        );
      }
    }
  };

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={openForm}>
        <ArrowLeftRight className="h-3.5 w-3.5" />
        {t('shift.offerToTeammate')}
      </Button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!counterpartyId || submitting) return;
    setSubmitting(true);
    try {
      await createSwap({
        shiftId,
        counterpartyAssociateId: counterpartyId,
        note: note.trim() || undefined,
        counterpartShiftId: counterpartShiftId || undefined,
      });
      hapticConfirm();
      toast.success(
        counterpartShiftId
          ? 'Trade proposed. They accept first, then your manager approves both halves.'
          : 'Swap request sent. Track it under Shift swaps below — your manager has the final say.',
      );
      setOpen(false);
      setCounterpartyId('');
      setCounterpartShiftId('');
      setNote('');
      onCreated?.();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not send the swap request.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 max-w-md w-full">
      {candError && (
        <p role="alert" className="text-xs text-alert">
          {candError}
        </p>
      )}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-silver">
          {t('shift.offerTo')}
        </span>
        <Select
          size="sm"
          required
          value={counterpartyId}
          onChange={(e) => setCounterpartyId(e.target.value)}
          disabled={candidates === null}
          className="mt-1"
        >
          <option value="" disabled>
            {candidates === null ? t('shift.loadingTeammates') : t('shift.pickTeammate')}
          </option>
          {(candidates ?? []).map((c) => (
            <option key={c.associateId} value={c.associateId} disabled={c.busy}>
              {c.name}
              {c.busy ? t('shift.busyDuring') : ''}
            </option>
          ))}
        </Select>
      </label>
      {counterpartyId && (tradeOptions?.length ?? 0) > 0 && (
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-silver">
            {t('shift.tradeLabel')}
          </span>
          <Select
            size="sm"
            value={counterpartShiftId}
            onChange={(e) => setCounterpartShiftId(e.target.value)}
            className="mt-1"
          >
            <option value="">{t('shift.justHandOff')}</option>
            {(tradeOptions ?? []).map((o) => (
              <option key={o.shiftId} value={o.shiftId}>
                {o.position} · {fmtDateTz(o.startsAt, o.timezone)} ·{' '}
                {fmtShiftRangeTz(o.startsAt, o.endsAt, o.timezone)}
              </option>
            ))}
          </Select>
        </label>
      )}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-silver">
          {t('shift.noteOptional')}
        </span>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder={t('shift.notePlaceholder')}
          className="mt-1"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting} disabled={!counterpartyId}>
          {t('shift.sendRequest')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={submitting}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
