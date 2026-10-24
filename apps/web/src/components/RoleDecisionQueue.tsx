import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { ME_DECISIONS_KEY, decisionsOf, meDecisionsQuery } from '@/lib/meDecisions';
import { QueryError } from '@/components/ui/QueryError';
import { noteDecision } from '@/lib/productEvents';
import { useAuth, useTerm } from '@/lib/auth';
import { usePrompt } from '@/lib/confirm';
import { fmtDayShort, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { DecisionRoom } from '@/components/DecisionRoom';
import { PLAN_CHANGED_EVENT } from '@/components/MyPlanCard';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Label } from '@/components/ui/Label';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';
import '@/lib/i18n/en/rdq';

/**
 * The Decision Console — mission-control presentation of the queue:
 *   · a one-line TRIAGE summary (severity mix + dollars at stake)
 *   · FOCUS: the top decision as a hero with ONE primary action
 *   · calm rows below with relative stakes bars and a single button each
 *   · every other verb (assign / tag / postpone / plan / escalate /
 *     release) lives in the item's ROOM, where the context is
 * The engine, rooms, and actions are unchanged — this is the console
 * skin. Empty queue = "Nothing needs you.".
 *
 * F500 SH-4: the rows come from the ONE decisions query the home's "Needs
 * you" count reads (lib/meDecisions, ['me','decisions']), so the number and
 * the rows are one answer; a failed load says so with Retry instead of the
 * whole section quietly vanishing; the two links read "Discuss" (the
 * item's room) and "Go to it" (the thing itself).
 */

interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  quickAction?: string;
  /** The "no" beside the quick action (an agent's proposed fill: Reject). */
  declineAction?: string;
  claimedBy: { id: string; name: string; photoUrl: string | null } | null;
  claimedByMe: boolean;
  assigned: boolean;
  note: string | null;
  escalated: boolean;
  nextStep: { text: string; ownerName: string | null; dueDay: string | null } | null;
}

interface Colleague {
  id: string;
  name: string;
  roleLabel: string;
}

const SEV_DOT: Record<RoleDecision['severity'], string> = {
  critical: 'bg-alert',
  high: 'bg-warning',
  normal: 'bg-silver/40',
};
const SEV_BAR: Record<RoleDecision['severity'], string> = {
  critical: 'bg-alert/70',
  high: 'bg-warning/70',
  normal: 'bg-steel/70',
};

function ageTone(ageDays: number | null): string {
  if (ageDays === null || ageDays <= 0) return 'text-silver/60';
  if (ageDays >= 14) return 'text-alert';
  if (ageDays >= 7) return 'text-warning';
  return 'text-silver/60';
}

export function RoleDecisionQueue({
  title: titleProp,
  hideWhenEmpty = false,
  scopeLabel,
  excludeKeyPrefix,
  footer,
}: {
  /**
   * The page's own "needs you" rows (a home's counted cards), drawn inside
   * the queue's card under its rows — one list, not a card grid beside it.
   * With an empty queue they keep a card of their own.
   */
  footer?: React.ReactNode;
  /**
   * Leave out items whose key starts with this — the page already shows
   * them as its own card (the supervisor's coverage-gap notice and the
   * queue's `coverage:` item are the same thing). Count them once.
   */
  excludeKeyPrefix?: string;
  /** Says whose decisions these are when the page around them is narrower
   *  (a manager's team home): "Company-wide". Shown only with rows. */
  scopeLabel?: string;
  /** `null` when the page titles the section itself (a home's "Needs you"). */
  title?: string | null;
  /**
   * Render nothing when the queue is empty. A page with its own "waiting
   * on you" (the recruiter's) must not also say "nothing needs your
   * decision" — this queue only knows its own kinds of decision.
   */
  hideWhenEmpty?: boolean;
}) {
  const { user } = useAuth();
  const term = useTerm();
  const { t } = useI18n();
  // The default heading, in the reader's language; `null` still means "the page titles it".
  const title = titleProp === undefined ? t('rdq.title') : titleProp;
  const qc = useQueryClient();
  // Client-portal viewers have no queue at all: don't even ask.
  const decisionsQuery = useQuery({ ...meDecisionsQuery<RoleDecision>(), enabled: user?.role !== 'CLIENT_PORTAL' });
  const rows: RoleDecision[] | null = decisionsQuery.data
    ? decisionsOf<RoleDecision>(decisionsQuery.data).filter((d) => !excludeKeyPrefix || !d.key.startsWith(excludeKeyPrefix))
    : null;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [colleagues, setColleagues] = useState<Colleague[] | null>(null);
  const [picker, setPicker] = useState<{ mode: 'assign' | 'tag'; item: RoleDecision } | null>(
    null,
  );
  const [pickTarget, setPickTarget] = useState('');
  const [pickNote, setPickNote] = useState('');
  const [roomKey, setRoomKey] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);

  // Re-read the one shared query (the home's count follows).
  const load = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ME_DECISIONS_KEY });
  }, [qc]);
  // A fresh answer starts the console at its top item again.
  const dataStamp = decisionsQuery.dataUpdatedAt;
  useEffect(() => setFocusIdx(0), [dataStamp]);

  const ensureColleagues = useCallback(() => {
    if (colleagues !== null) return;
    apiFetch<{ colleagues: Colleague[] }>('/me/colleagues')
      .then((r) => setColleagues(r.colleagues))
      .catch(() => setColleagues([]));
  }, [colleagues]);

  const act = async (
    key: string,
    action: 'claim' | 'release' | 'escalate' | 'assign' | 'postpone' | 'tag',
    extra?: { targetUserId?: string; days?: number; note?: string },
  ) => {
    if (busyKey) return;
    setBusyKey(`${key}:${action}`);
    try {
      await apiFetch('/me/decisions/act', { method: 'POST', body: { key, action, ...extra } });
      toast.success(
        action === 'claim'
          ? t('rdq.claimed')
          : action === 'release'
            ? t('rdq.released')
            : action === 'assign'
              ? t('rdq.assigned')
              : action === 'postpone'
                ? (extra?.days ?? 1) === 1
                  ? t('rdq.postponedOne')
                  : t('rdq.postponedMany', { n: extra?.days ?? 1 })
                : action === 'tag'
                  ? t('rdq.tagged')
                  : t('rdq.escalated'),
      );
      setPicker(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('rdq.updateFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  // Styled prompt dialog — window.prompt() rendered as a raw OS dialog,
  // jarringly off-brand (and unstylable) on phones.
  const promptDialog = usePrompt();
  const quick = async (item: RoleDecision, decline = false) => {
    if (busyKey) return;
    // Rejecting an agent's proposal says why: the reason stays on the proposal and the trail.
    let reason: string | undefined;
    if (decline && item.key.startsWith('agents:')) {
      const typed = await promptDialog({
        title: t('rdq.rejectTitle'),
        reasonLabel: t('rdq.rejectWhy'),
        confirmLabel: t('rdq.reject'),
        required: false,
      });
      if (typed === null) return;
      reason = typed.trim() || undefined;
    }
    setBusyKey(`${item.key}:${decline ? 'decline' : 'quick'}`);
    try {
      const r = await apiFetch<{ summary: string }>('/me/decisions/quick', {
        method: 'POST',
        body: decline ? { key: item.key, decline: true, ...(reason ? { reason } : {}) } : { key: item.key },
      });
      noteDecision();
      toast.success(r.summary);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('rdq.quickFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  const escalate = async (item: RoleDecision) => {
    const typed = await promptDialog({
      title: t('rdq.escalateTitle'),
      reasonLabel: t('rdq.escalateNote'),
      confirmLabel: t('rdq.escalate'),
      required: false,
    });
    if (typed === null) return;
    void act(item.key, 'escalate', { note: typed.trim() || undefined });
  };
  // Postponing is a TAP, never typing — the dialog offers the horizons.
  const [postponeItem, setPostponeItem] = useState<RoleDecision | null>(null);
  const postpone = (item: RoleDecision) => setPostponeItem(item);
  const addToPlan = async (item: RoleDecision) => {
    if (busyKey) return;
    setBusyKey(`${item.key}:plan`);
    try {
      await apiFetch('/me/plan', {
        method: 'POST',
        body: { day: ymdLocal(), title: item.label, decisionKey: item.key, linkUrl: item.linkUrl },
      });
      // Instant sync — the plan card on this dashboard re-reads NOW.
      window.dispatchEvent(new CustomEvent(PLAN_CHANGED_EVENT));
      toast.success(t('rdq.addedToPlan'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('rdq.planFailed'));
    } finally {
      setBusyKey(null);
    }
  };
  const openPicker = (mode: 'assign' | 'tag', item: RoleDecision) => {
    ensureColleagues();
    setPickTarget('');
    setPickNote('');
    setPicker({ mode, item });
  };

  /** ONE primary action per item — quick fix beats claim beats room. */
  const primaryFor = (d: RoleDecision): { label: string; run: () => void } => {
    if (d.claimedBy && !d.claimedByMe) {
      return { label: t('rdq.openRoom'), run: () => setRoomKey(d.key) };
    }
    if (d.quickAction) return { label: d.quickAction, run: () => void quick(d) };
    if (d.claimedByMe) return { label: t('rdq.openRoom'), run: () => setRoomKey(d.key) };
    return { label: t('rdq.gotThis'), run: () => void act(d.key, 'claim') };
  };

  // Client-portal viewers have no queue at all — even a "nominal" chip would be noise.
  if (user?.role === 'CLIENT_PORTAL') return null;
  // A failed load says so, with Retry — never a "Needs you" that silently isn't there.
  // The page's own rows keep a card when the queue has none to share.
  const footerCard = footer ? (
    <Card>
      <CardContent>{footer}</CardContent>
    </Card>
  ) : null;
  if (decisionsQuery.isError && rows === null) {
    return (
      <>
        <QueryError what={t('rdq.what')} query={decisionsQuery} />
        {footerCard}
      </>
    );
  }
  if (rows !== null && rows.length === 0) {
    if (footerCard) return footerCard;
    if (hideWhenEmpty) return null;
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/20 bg-success/[0.06] px-3 py-2 text-sm text-silver">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        {t('rdq.allClear')}
      </div>
    );
  }

  const maxStakes = Math.max(1, ...(rows ?? []).map((d) => d.stakes ?? 0));
  const focus = rows && rows.length > 0 ? rows[Math.min(focusIdx, rows.length - 1)] : null;
  const rest = rows ? rows.filter((_, i) => i !== Math.min(focusIdx, rows.length - 1)) : [];
  const visibleRest = showAll ? rest : rest.slice(0, 3);
  const nCritical = (rows ?? []).filter((d) => d.severity === 'critical').length;
  const nHigh = (rows ?? []).filter((d) => d.severity === 'high').length;
  const nNormal = (rows ?? []).filter((d) => d.severity === 'normal').length;
  const totalStakes = (rows ?? []).reduce((n, d) => n + (d.stakes ?? 0), 0);
  const roomItem = rows?.find((d) => d.key === roomKey) ?? null;

  return (
    <Card className={nCritical > 0 ? 'border-alert/40' : undefined}>
      {(title !== null || (rows && rows.length > 0)) && (
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title !== null && <CardTitle className="text-base">{title}</CardTitle>}
          {scopeLabel && rows && rows.length > 0 && (
            <Badge variant="outline" size="sm">
              {scopeLabel}
            </Badge>
          )}
          {/* The triage line — the whole queue in one sentence. */}
          {rows && rows.length > 0 && (
            <span className="ml-auto text-2xs tabular-nums text-silver">
              {nCritical > 0 && <span className="font-medium text-alert">{t('rdq.nCritical', { n: nCritical })}</span>}
              {nCritical > 0 && (nHigh > 0 || nNormal > 0) && ' · '}
              {nHigh > 0 && <span className="text-warning">{t('rdq.nHigh', { n: nHigh })}</span>}
              {nHigh > 0 && nNormal > 0 && ' · '}
              {nNormal > 0 && <span>{t('rdq.nRoutine', { n: nNormal })}</span>}
              {totalStakes > 0 && (
                <span className="text-silver/70"> — {t('rdq.atStake', { amount: fmtMoney(totalStakes) })}</span>
              )}
            </span>
          )}
        </div>
      </CardHeader>
      )}
      <CardContent>
        {rows === null && <Skeleton className="h-24" />}

        {/* FOCUS — the console asks one question at a time. */}
        {focus && (
          <div
            className={`rounded-lg border-l-4 bg-navy-secondary/40 p-4 ${
              focus.severity === 'critical'
                ? 'border-alert'
                : focus.severity === 'high'
                  ? 'border-warning'
                  : 'border-steel'
            }`}
          >
            <button
              type="button"
              onClick={() => setRoomKey(focus.key)}
              className="group block w-full text-left"
            >
              <div className="text-lg font-semibold leading-snug text-white group-hover:text-gold">
                {focus.label}
              </div>
              <div className="mt-0.5 text-sm text-silver">{focus.detail}</div>
            </button>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
              {focus.stakes !== null && (
                <span
                  className={focus.severity === 'critical' ? 'font-medium text-alert' : 'text-white'}
                >
                  {t('rdq.atStake', { amount: fmtMoney(focus.stakes) })}
                </span>
              )}
              {focus.ageDays !== null && focus.ageDays > 0 && (
                <span className={ageTone(focus.ageDays)}>{t('rdq.waitingDays', { n: focus.ageDays })}</span>
              )}
              {focus.escalated && <span className="text-warning">{t('rdq.escalatedTag')}</span>}
              {focus.claimedBy && (
                <span className="flex items-center gap-1.5 text-silver">
                  <Avatar src={focus.claimedBy.photoUrl} name={focus.claimedBy.name} size="xs" />
                  {focus.claimedByMe ? t('rdq.withYou') : t('rdq.withName', { name: focus.claimedBy.name })}
                </span>
              )}
            </div>
            {focus.nextStep && (
              <div className="mt-1.5 text-xs text-gold">
                → {focus.nextStep.text}
                {focus.nextStep.ownerName ? ` — ${focus.nextStep.ownerName}` : ''}
                {focus.nextStep.dueDay ? `, ${fmtDayShort(parseYmd(focus.nextStep.dueDay) ?? focus.nextStep.dueDay, { anchored: true })}` : ''}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                loading={busyKey?.startsWith(focus.key) ?? false}
                disabled={busyKey !== null}
                onClick={primaryFor(focus).run}
              >
                {primaryFor(focus).label}
              </Button>
              {focus.declineAction && !(focus.claimedBy && !focus.claimedByMe) && (
                <Button size="sm" variant="outline" disabled={busyKey !== null} onClick={() => void quick(focus, true)}>
                  {focus.declineAction}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setRoomKey(focus.key)}>
                {t('rdq.openRoom')}
              </Button>
              {/* Straight to the thing itself — the room is for deciding,
                  this is for doing. */}
              <Button asChild size="sm" variant="ghost">
                <Link to={focus.linkUrl}>{t('rdq.open')}</Link>
              </Button>
              {rows && rows.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-silver/70"
                  onClick={() => setFocusIdx((i) => (i + 1) % rows.length)}
                >
                  {t('rdq.next')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* The quiet stack below. */}
        {visibleRest.length > 0 && (
          <ul className="mt-3 space-y-1">
            {visibleRest.map((d) => {
              const primary = primaryFor(d);
              return (
                <li key={d.key} className="group/row flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-md px-2 py-1.5 hover:bg-navy-secondary/30">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${SEV_DOT[d.severity]}`}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => setRoomKey(d.key)}
                    className="min-w-0 flex-1 text-left"
                  >
                    {/* Two lines on a phone so the title keeps its words; one from sm. */}
                    <span className="block line-clamp-2 text-sm text-white hover:text-gold sm:line-clamp-1" title={d.label}>
                      {d.label}
                    </span>
                    {d.nextStep && (
                      <span className="block truncate text-2xs text-gold/80">
                        → {d.nextStep.text}
                        {d.nextStep.ownerName ? ` — ${d.nextStep.ownerName}` : ''}
                      </span>
                    )}
                    {/* Preattentive stakes: relative bar, not just a number. */}
                    {d.stakes !== null && d.stakes > 0 && (
                      <span className="mt-0.5 block h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-navy-secondary/70">
                        <span
                          className={`block h-full rounded-full ${SEV_BAR[d.severity]}`}
                          style={{ width: `${Math.max(6, ((d.stakes ?? 0) / maxStakes) * 100)}%` }}
                        />
                      </span>
                    )}
                  </button>
                  {/* On a phone the meta and the actions take a second row under the
                      title, so the title keeps its words; from sm they share the line. */}
                  <span className="flex w-full items-center justify-end gap-2 pl-[18px] sm:w-auto sm:pl-0">
                  <span className="flex shrink-0 items-center gap-2 text-2xs tabular-nums">
                    {d.stakes !== null && <span className="text-silver">{fmtMoney(d.stakes)}</span>}
                    {d.ageDays !== null && d.ageDays > 0 && (
                      <span className={ageTone(d.ageDays)}>{t('rdq.ageDays', { n: d.ageDays })}</span>
                    )}
                    {d.claimedBy && (
                      <Avatar
                        src={d.claimedBy.photoUrl}
                        name={d.claimedBy.name}
                        size="xs"
                      />
                    )}
                  </span>
                  {/* Direct jump to the item's own page; the title click
                      keeps opening the room. */}
                  <Button asChild size="xs" variant="ghost" className="shrink-0">
                    <Link to={d.linkUrl}>{t('rdq.open')}</Link>
                  </Button>
                  {d.declineAction && !(d.claimedBy && !d.claimedByMe) && (
                    <Button size="xs" variant="outline" className="shrink-0" disabled={busyKey !== null} onClick={() => void quick(d, true)}>
                      {d.declineAction}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant={d.quickAction && !(d.claimedBy && !d.claimedByMe) ? 'primary' : 'ghost'}
                    className="shrink-0"
                    loading={busyKey?.startsWith(d.key) ?? false}
                    disabled={busyKey !== null}
                    onClick={primary.run}
                  >
                    {primary.label}
                  </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {rest.length > 3 && (
          <button
            type="button"
            className="mt-2 min-h-6 w-full text-center text-2xs text-silver/70 hover:text-gold"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? t('rdq.showLess') : t('rdq.showAll', { n: rows?.length ?? 0 })}
          </button>
        )}
        {footer && <div className="mt-3 border-t border-line pt-3">{footer}</div>}

        <DecisionRoom
          itemKey={roomKey}
          onClose={() => setRoomKey(null)}
          actions={
            roomItem ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {roomItem.claimedByMe ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${roomItem.key}:release`}
                    disabled={busyKey !== null}
                    onClick={() => void act(roomItem.key, 'release')}
                  >
                    {t('rdq.release')}
                  </Button>
                ) : !roomItem.claimedBy ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${roomItem.key}:claim`}
                    disabled={busyKey !== null}
                    onClick={() => void act(roomItem.key, 'claim')}
                  >
                    {t('rdq.gotThis')}
                  </Button>
                ) : null}
                {(!roomItem.claimedBy || roomItem.claimedByMe) && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onClick={() => openPicker('assign', roomItem)}
                  >
                    {t('rdq.assign')}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onClick={() => openPicker('tag', roomItem)}
                >
                  {t('rdq.tag')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  loading={busyKey === `${roomItem.key}:postpone`}
                  disabled={busyKey !== null}
                  onClick={() => postpone(roomItem)}
                >
                  {t('rdq.postpone')}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  loading={busyKey === `${roomItem.key}:plan`}
                  disabled={busyKey !== null}
                  onClick={() => void addToPlan(roomItem)}
                >
                  {t('rdq.myDay')}
                </Button>
                {!roomItem.escalated && (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${roomItem.key}:escalate`}
                    disabled={busyKey !== null}
                    onClick={() => void escalate(roomItem)}
                  >
                    {t('rdq.escalate')}
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />

        <Dialog open={postponeItem !== null} onOpenChange={(o) => !o && setPostponeItem(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('rdq.postpone')}</DialogTitle>
              <DialogDescription>
                {t('rdq.postponeDesc', { label: postponeItem?.label ?? '' })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  [t('rdq.tomorrow'), 1],
                  [t('rdq.threeDays'), 3],
                  [t('rdq.nextWeek'), 7],
                  [t('rdq.twoWeeks'), 14],
                ] as const
              ).map(([label, days]) => (
                <Button
                  key={days}
                  size="sm"
                  variant="outline"
                  disabled={busyKey !== null}
                  onClick={() => {
                    const item = postponeItem;
                    setPostponeItem(null);
                    if (item) void act(item.key, 'postpone', { days });
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {picker?.mode === 'assign' ? t('rdq.assignTitle') : t('rdq.tagTitle')}
              </DialogTitle>
              <DialogDescription>
                {picker?.mode === 'assign'
                  ? t('rdq.assignDesc', { label: picker?.item.label ?? '' })
                  : t('rdq.tagDesc', { label: picker?.item.label ?? '' })}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <Label htmlFor="collab-target">{t('rdq.colleague')}</Label>
                <Select
                  id="collab-target"
                  value={pickTarget}
                  onChange={(e) => setPickTarget(e.target.value)}
                >
                  <option value="">
                    {colleagues === null ? t('rdq.loading') : t('rdq.pickColleague')}
                  </option>
                  {(colleagues ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.roleLabel}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="collab-note">{t('rdq.noteOptional')}</Label>
                <Textarea
                  id="collab-note"
                  rows={2}
                  maxLength={300}
                  value={pickNote}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setPickNote(e.target.value)
                  }
                  placeholder={
                    picker?.mode === 'assign'
                      ? t('rdq.assignPlaceholder')
                      : t('rdq.tagPlaceholder', { place: term('site').toLowerCase() })
                  }
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setPicker(null)}>
                  {t('rdq.cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={!pickTarget || busyKey !== null}
                  loading={busyKey?.endsWith(picker?.mode ?? '') ?? false}
                  onClick={() =>
                    picker &&
                    void act(picker.item.key, picker.mode, {
                      targetUserId: pickTarget,
                      note: pickNote.trim() || undefined,
                    })
                  }
                >
                  {picker?.mode === 'assign' ? t('rdq.assign') : t('rdq.tag')}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
