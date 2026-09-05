import { useEffect, useState, type FormEvent } from 'react';
import {
  paidMinutesForRange,
  type Shift,
  type ShiftTeammate,
  type SwapCandidate,
  type TradeOption,
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
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { toast } from '@/components/ui/Toaster';
import { fmtCompactRange, fmtDateTz, fmtMoneyEst, fmtShiftRangeTz, fmtWeekdayTz, mapsUrl } from '@/lib/format';
import { ArrowLeftRight, Check, ChevronDown, MapPin, Users, X } from 'lucide-react';
import { hapticConfirm } from '@/lib/haptics';
import { enterStagger } from '@/lib/motion';
import { useI18n, type Translate } from '@/lib/i18n';
import { colorForPosition } from '@/lib/positionColor';
import { statusLabelClass, statusTileClass } from './shiftTile';

export function statusBadge(
  status: Shift['status'],
  t?: Translate,
  /** For ASSIGNED shifts: has the associate tapped "I'll be there"?
   *  The badge used to say "Confirmed" for every assigned shift while
   *  the dashboard simultaneously nagged "1 shift to confirm". */
  acknowledged?: boolean,
): { label: string; variant: 'accent' | 'default' | 'success' | 'destructive' } {
  switch (status) {
    case 'ASSIGNED':
      if (acknowledged === false) {
        return {
          label: t ? t('shift.confirmNeeded') : 'Confirm needed',
          variant: 'default',
        };
      }
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

/** WALL-CLOCK length — the card's "9h" label stays the true span. */
export function shiftMinutes(s: Shift): number {
  const ms = new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime();
  return ms > 0 ? Math.round(ms / 60000) : 0;
}

/** PAID minutes (shared unpaid-break rule) — hour TOTALS use this. */
export function paidShiftMinutes(s: Shift): number {
  return paidMinutesForRange(s.startsAt, s.endsAt);
}

/** "8h", "7h 30m" — shift length for the detail panel. */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Status as a shape on the tile face — the admin calendar's mark language
 * (shiftTile.tsx StatusMark), re-cut for the associate: what they owe comes
 * first (gold disc = still needs their confirmation), and the sr labels go
 * through the translator instead of the admin's English constants.
 */
function TileMark({
  shift,
  needsConfirm,
  t,
}: {
  shift: Shift;
  needsConfirm: boolean;
  t: Translate;
}) {
  const nowMs = Date.now();
  const inProgress =
    shift.status === 'ASSIGNED' &&
    new Date(shift.startsAt).getTime() <= nowMs &&
    new Date(shift.endsAt).getTime() > nowMs;
  let shape: React.ReactNode;
  let label: string;
  if (needsConfirm) {
    shape = <span className="h-2 w-2 rounded-full bg-gold" />;
    label = t('shift.confirmNeeded');
  } else if (inProgress) {
    // The same live pulse as the hero and earnings card — a shift that's
    // happening RIGHT NOW shouldn't look like any other confirmed row.
    shape = (
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
      </span>
    );
    label = t('sched.heroNow');
  } else {
    switch (shift.status) {
      case 'COMPLETED':
        shape = <Check className="h-3 w-3 text-success" strokeWidth={3} />;
        label = t('shift.worked');
        break;
      case 'CANCELLED':
        shape = <X className="h-3 w-3 text-alert" strokeWidth={3} />;
        label = t('shift.cancelled');
        break;
      case 'OPEN':
        shape = (
          <span className="h-2 w-2 rounded-full border-[1.5px] border-warning" />
        );
        label = t('shift.open');
        break;
      default:
        shape = <span className="h-2 w-2 rounded-full bg-success" />;
        label = t('shift.confirmed');
    }
  }
  return (
    <span
      className="shrink-0 inline-flex h-3 w-3 items-center justify-center"
      title={label}
    >
      {shape}
      <span className="sr-only">{label}</span>
    </span>
  );
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
  appearIndex,
  estRate,
  onAcknowledged,
  face = 'card',
}: {
  shift: Shift;
  isNext: boolean;
  muted?: boolean;
  onSwapCreated?: () => void;
  /** Position in the list — drives the capped entrance stagger. */
  appearIndex?: number;
  /** The associate's hourly rate — paints the shift's ~$ worth on the
   *  card face. Null/undefined (rate fetch failed, calendar views) just
   *  leaves the money off. */
  estRate?: number | null;
  /** Confirming here also updates the page's copy of the shift, so the
   *  next-shift hero above never disagrees with this card. */
  onAcknowledged?: (shiftId: string, acknowledgedAt: string) => void;
  /** 'tile' renders the admin calendar's compact tile as the collapsed
   *  face — position-color tint + accent bar, compact time, status shape —
   *  with the same expand/confirm/swap machinery underneath. */
  face?: 'card' | 'tile';
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [teammates, setTeammates] = useState<ShiftTeammate[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Ack state lives HERE (not in ShiftDetail) so the collapsed badge and
  // the inline confirm strip stay in sync with the detail panel's button.
  const [ackAt, setAckAt] = useState(shift.acknowledgedAt);
  const [acking, setAcking] = useState(false);
  // Confirming from the next-shift hero updates the page's shift object —
  // adopt that here so the badge/confirm strip flip without a remount.
  useEffect(() => {
    if (shift.acknowledgedAt) setAckAt(shift.acknowledgedAt);
  }, [shift.acknowledgedAt]);
  const needsConfirm =
    !muted &&
    shift.status === 'ASSIGNED' &&
    !ackAt &&
    new Date(shift.startsAt).getTime() > Date.now();

  const acknowledge = async () => {
    setAcking(true);
    try {
      const updated = await acknowledgeMyShift(shift.id);
      const at = updated.acknowledgedAt ?? new Date().toISOString();
      setAckAt(at);
      onAcknowledged?.(shift.id, at);
      hapticConfirm();
      toast.success(t('shift.confirmedToast'));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('shift.confirmFailed'),
      );
    } finally {
      setAcking(false);
    }
  };

  const loadDetail = async () => {
    try {
      setDetailError(null);
      const res = await getMyShiftDetail(shift.id);
      setTeammates(res.teammates);
    } catch (err) {
      setDetailError(
        err instanceof ApiError ? err.message : t('shift.detailFailed'),
      );
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && teammates === null) loadDetail();
  };

  const badge = statusBadge(
    shift.status,
    t,
    shift.status === 'ASSIGNED' && !muted ? Boolean(ackAt) : undefined,
  );
  const detailId = `shift-detail-${shift.id}`;
  const tile = face === 'tile';
  const tileColor = tile ? colorForPosition(shift.position) : null;
  return (
    <li
      style={{
        ...enterStagger(appearIndex ?? 0),
        ...(tileColor
          ? { backgroundColor: tileColor.bg, borderColor: tileColor.border }
          : {}),
      }}
      className={[
        'border animate-enter',
        tile
          ? `relative rounded ${statusTileClass(shift.status)}`
          : 'rounded-lg',
        !tile &&
          (isNext
            ? 'bg-navy border-gold/50 ring-1 ring-gold/30'
            : 'bg-navy border-navy-secondary'),
        muted ? 'opacity-80' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Position-color accent bar — the admin calendar's coverage-heatmap
          cue, so an associate's week reads by role at a glance too. */}
      {tile && (
        <div
          aria-hidden="true"
          className="absolute left-0 top-0 bottom-0 w-1 rounded-l"
          style={{ backgroundColor: tileColor!.accent }}
        />
      )}
      {tile ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={detailId}
          // The tooltip carries what the truncating label can't — same
          // affordance as the admin tiles.
          title={`${fmtShiftRangeTz(shift.startsAt, shift.endsAt, shift.timezone)} · ${shift.position}${shift.clientName ? ` · ${shift.clientName}` : ''}`}
          className="w-full flex items-center gap-1.5 pl-3 pr-2 py-2 coarse:min-h-11 text-left rounded transition-colors active:bg-navy-secondary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
        >
          <span className="text-xs2 text-silver/90 tabular-nums shrink-0">
            {fmtCompactRange(shift.startsAt, shift.endsAt, shift.timezone)}
          </span>
          <span
            className={[
              'flex-1 min-w-0 truncate text-xs font-medium text-white',
              statusLabelClass(shift.status),
            ].join(' ')}
          >
            {shift.position}
            {/* The client matters when someone works two stores — admin
                tiles hide it behind a hover card, but associates have no
                hover. It shares the truncating span so narrow phones drop
                it gracefully instead of crushing the time or the money. */}
            {shift.clientName && (
              <span className="text-silver/70 font-normal">
                {' '}· {shift.clientName}
              </span>
            )}
          </span>
          {!muted && estRate != null && shift.status !== 'CANCELLED' && (
            <span className="shrink-0 text-xs2 font-medium text-gold tabular-nums">
              {fmtMoneyEst((paidShiftMinutes(shift) / 60) * estRate)}
            </span>
          )}
          <TileMark shift={shift} needsConfirm={needsConfirm} t={t} />
          {/* The card face advertises expandability with a chevron; the
              tile face must too, or it reads as inert decoration. */}
          <ChevronDown
            aria-hidden="true"
            className={[
              'h-3.5 w-3.5 shrink-0 text-silver/50 transition-transform',
              expanded ? 'rotate-180' : '',
            ].join(' ')}
          />
        </button>
      ) : (
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
            {/* What this shift is WORTH — paid minutes at the associate's
                rate. They work shifts for the money; the schedule should
                say so. "~" keeps the estimate honest (gross, base rate). */}
            {!muted && estRate != null && shift.status !== 'CANCELLED' && (
              <span className="font-medium text-gold">
                {' '}· {fmtMoneyEst((paidShiftMinutes(shift) / 60) * estRate)}
              </span>
            )}
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
      )}

      {/* Inline confirm on the COLLAPSED card — confirming used to cost an
          expand + a hunt into the detail panel for every shift past the
          first. Sibling of the toggle button (never nested inside it). */}
      {!expanded && needsConfirm && (
        <div
          className={
            tile
              ? 'border-t border-navy-secondary px-3 py-2'
              : 'border-t border-navy-secondary px-4 py-2.5'
          }
        >
          <Button
            size="sm"
            onClick={acknowledge}
            loading={acking}
            disabled={acking}
            className="w-full sm:w-auto"
          >
            <Check className="h-3.5 w-3.5" />
            {t('shift.illBeThere')}
          </Button>
        </div>
      )}

      {expanded && (
        // The unfold: grid-rows 0fr→1fr animates TRUE auto-height with no
        // JS measuring. Open only — close unmounts instantly, matching the
        // house "land softly, depart quickly" cadence (and keeping the
        // collapsed DOM free of focusable ghosts).
        <div className="grid animate-unfold">
          <div className="overflow-hidden">
            <div
              id={detailId}
              className={
                tile
                  ? 'border-t border-navy-secondary px-3 py-3'
                  : 'border-t border-navy-secondary px-4 py-3'
              }
            >
          <ShiftDetail
            shift={shift}
            muted={muted}
            onSwapCreated={onSwapCreated}
            ackAt={ackAt}
            acking={acking}
            onAcknowledge={acknowledge}
          />
          <div className="mt-3">
            <div className="text-xs2 uppercase tracking-wider text-silver/80 mb-1.5 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" aria-hidden="true" />
              {t('shift.workingWithYou')}
              {teammates && teammates.length > 0 && ` (${teammates.length})`}
            </div>
            {teammates === null && !detailError && (
              <SkeletonRows count={2} rowHeight="h-5" />
            )}
            {detailError && (
              <ErrorBanner
                className="text-xs"
                action={
                  <button
                    type="button"
                    onClick={loadDetail}
                    className="underline underline-offset-2 hover:text-white"
                  >
                    {t('common.retry')}
                  </button>
                }
              >
                {detailError}
              </ErrorBanner>
            )}
            {teammates && teammates.length === 0 && (
              <p className="text-xs text-silver/70">{t('shift.noTeammates')}</p>
            )}
            {teammates && teammates.length > 0 && (
              <ul className="space-y-1.5">
                {/* `mate`, not `t` — `t` is the translator from useI18n in
                    the enclosing scope, and shadowing it here means the next
                    translated string added inside this block fails at
                    runtime rather than at compile time. */}
                {teammates.map((mate) => (
                  // Stacked on phones — the one-line layout crushed the
                  // NAME ("Pat Ng…") to make room for position·time·zone
                  // (caught by the visual walk). Single line returns at sm+
                  // where there's room for both.
                  <li
                    key={mate.associateId}
                    className="text-sm sm:flex sm:items-baseline sm:justify-between sm:gap-3"
                  >
                    <span className="block text-white sm:truncate">{mate.name}</span>
                    <span className="block text-xs text-silver tabular-nums sm:text-right sm:shrink-0">
                      {mate.position} ·{' '}
                      {fmtShiftRangeTz(mate.startsAt, mate.endsAt, shift.timezone)}
                      {mate.location ? ` · ${mate.location}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/** The facts row of the expanded card: date, hours, site, manager note.
 *  Ack state + handler are owned by ShiftCard so the collapsed badge,
 *  the inline confirm strip, and this panel can never disagree. */
function ShiftDetail({
  shift,
  muted,
  onSwapCreated,
  ackAt,
  acking,
  onAcknowledge,
}: {
  shift: Shift;
  muted: boolean;
  onSwapCreated?: () => void;
  ackAt: string | null;
  acking: boolean;
  onAcknowledge: () => void;
}) {
  const { t } = useI18n();
  const site = [shift.locationName, shift.location].filter(Boolean).join(' · ');
  const upcoming =
    !muted &&
    shift.status === 'ASSIGNED' &&
    new Date(shift.startsAt).getTime() > Date.now();

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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-silver/70">
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" aria-hidden="true" />
            {site}
          </span>
          {/* The address is a destination, not decoration — one tap opens
              the phone's maps app with the site pre-searched. */}
          <a
            href={mapsUrl([shift.clientName, shift.locationName, shift.location].filter(Boolean).join(' '))}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-gold hover:text-gold-bright underline underline-offset-2 coarse:min-h-11"
            onClick={(e) => e.stopPropagation()}
          >
            {t('shift.directions')}
          </a>
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
            // The confirmation lands as one event: haptic (fired in the
            // handler) + this check popping in.
            <span className="inline-flex items-center gap-1 text-xs text-success animate-enter">
              <Check className="h-3.5 w-3.5 animate-check-pop" aria-hidden="true" />
              {t('shift.youConfirmed')}
            </span>
          ) : (
            <Button size="sm" onClick={onAcknowledge} loading={acking} disabled={acking}>
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
          err instanceof ApiError ? err.message : t('shift.teammatesFailed'),
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
          ? t('shift.tradeProposedToast')
          : t('shift.swapSentToast'),
      );
      setOpen(false);
      setCounterpartyId('');
      setCounterpartShiftId('');
      setNote('');
      onCreated?.();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : t('shift.swapSendFailed'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 max-w-md w-full">
      {candError && <ErrorBanner className="text-xs">{candError}</ErrorBanner>}
      <label className="block">
        <span className="text-xs2 uppercase tracking-wider text-silver">
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
          <span className="text-xs2 uppercase tracking-wider text-silver">
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
        <span className="text-xs2 uppercase tracking-wider text-silver">
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
