import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtMoney, ymdLocal } from '@/lib/format';
import { DecisionRoom } from '@/components/DecisionRoom';
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
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { Textarea } from '@/components/ui/Input';

/**
 * The Decision Console — mission-control presentation of the queue:
 *   · a one-line TRIAGE summary (severity mix + dollars at stake)
 *   · FOCUS: the top decision as a hero with ONE primary action
 *   · calm rows below with relative stakes bars and a single button each
 *   · every other verb (assign / tag / postpone / plan / escalate /
 *     release) lives in the item's ROOM, where the context is
 * The engine, rooms, and actions are unchanged — this is the console
 * skin. Empty queue = "All systems nominal". Fails silent (supplement).
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
  claimedBy: { id: string; name: string; photoUrl: string | null } | null;
  claimedByMe: boolean;
  assigned: boolean;
  note: string | null;
  escalated: boolean;
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

export function RoleDecisionQueue({ title = 'Needs your decision' }: { title?: string }) {
  const [rows, setRows] = useState<RoleDecision[] | null>(null);
  const [error, setError] = useState(false);
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

  const load = useCallback(() => {
    setError(false);
    apiFetch<{ decisions: RoleDecision[] }>('/me/decisions')
      .then((r) => {
        setRows(r.decisions);
        setFocusIdx(0);
      })
      .catch(() => setError(true));
  }, []);
  useEffect(load, [load]);

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
          ? "It's yours — your teammates can see you've got it."
          : action === 'release'
            ? 'Released back to the team.'
            : action === 'assign'
              ? 'Assigned — they were notified and it now sits with them.'
              : action === 'postpone'
                ? `Postponed ${extra?.days ?? 1} day${(extra?.days ?? 1) === 1 ? '' : 's'} — it will come back on its own.`
                : action === 'tag'
                  ? 'Tagged — they got the item with your note.'
                  : 'Escalated — the admins were notified.',
      );
      setPicker(null);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the item.');
    } finally {
      setBusyKey(null);
    }
  };

  const quick = async (item: RoleDecision) => {
    if (busyKey) return;
    setBusyKey(`${item.key}:quick`);
    try {
      const r = await apiFetch<{ summary: string }>('/me/decisions/quick', {
        method: 'POST',
        body: { key: item.key },
      });
      toast.success(r.summary);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not run the quick action.');
    } finally {
      setBusyKey(null);
    }
  };

  const escalate = (item: RoleDecision) => {
    const typed = window.prompt('Add a note for the admins (optional):', '');
    if (typed === null) return;
    void act(item.key, 'escalate', { note: typed.trim() || undefined });
  };
  const postpone = (item: RoleDecision) => {
    const typed = window.prompt('Postpone for how many days? (1–14)', '1');
    if (typed === null) return;
    const days = Math.min(14, Math.max(1, Math.round(Number(typed)) || 1));
    void act(item.key, 'postpone', { days });
  };
  const addToPlan = async (item: RoleDecision) => {
    if (busyKey) return;
    setBusyKey(`${item.key}:plan`);
    try {
      await apiFetch('/me/plan', {
        method: 'POST',
        body: { day: ymdLocal(), title: item.label, decisionKey: item.key, linkUrl: item.linkUrl },
      });
      toast.success('Added to your plan for today.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add to your plan.');
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
      return { label: 'Open room', run: () => setRoomKey(d.key) };
    }
    if (d.quickAction) return { label: d.quickAction, run: () => void quick(d) };
    if (d.claimedByMe) return { label: 'Open room', run: () => setRoomKey(d.key) };
    return { label: "I've got this", run: () => void act(d.key, 'claim') };
  };

  // Supplement card: vanish quietly on failure.
  if (error) return null;
  if (rows !== null && rows.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/20 bg-success/[0.06] px-3 py-2 text-sm text-silver">
        <span className="h-2 w-2 shrink-0 rounded-full bg-success" aria-hidden="true" />
        All systems nominal — nothing needs your decision.
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
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          {/* The triage line — the whole queue in one sentence. */}
          {rows && rows.length > 0 && (
            <span className="text-2xs tabular-nums text-silver">
              {nCritical > 0 && <span className="font-medium text-alert">{nCritical} critical</span>}
              {nCritical > 0 && (nHigh > 0 || nNormal > 0) && ' · '}
              {nHigh > 0 && <span className="text-warning">{nHigh} high</span>}
              {nHigh > 0 && nNormal > 0 && ' · '}
              {nNormal > 0 && <span>{nNormal} routine</span>}
              {totalStakes > 0 && (
                <span className="text-silver/70"> — {fmtMoney(totalStakes)} at stake</span>
              )}
            </span>
          )}
        </div>
      </CardHeader>
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
                  {fmtMoney(focus.stakes)} at stake
                </span>
              )}
              {focus.ageDays !== null && focus.ageDays > 0 && (
                <span className={ageTone(focus.ageDays)}>waiting {focus.ageDays}d</span>
              )}
              {focus.escalated && <span className="text-warning">escalated</span>}
              {focus.claimedBy && (
                <span className="flex items-center gap-1.5 text-silver">
                  <Avatar src={focus.claimedBy.photoUrl} name={focus.claimedBy.name} size="xs" />
                  {focus.claimedByMe ? 'with you' : `with ${focus.claimedBy.name}`}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                loading={busyKey?.startsWith(focus.key) ?? false}
                disabled={busyKey !== null}
                onClick={primaryFor(focus).run}
              >
                {primaryFor(focus).label}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRoomKey(focus.key)}>
                Open room
              </Button>
              {rows && rows.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-silver/70"
                  onClick={() => setFocusIdx((i) => (i + 1) % rows.length)}
                >
                  Next ↓
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
                <li key={d.key} className="group/row flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-navy-secondary/30">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${SEV_DOT[d.severity]}`}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => setRoomKey(d.key)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm text-white hover:text-gold">
                      {d.label}
                    </span>
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
                  <span className="flex shrink-0 items-center gap-2 text-2xs tabular-nums">
                    {d.stakes !== null && <span className="text-silver">{fmtMoney(d.stakes)}</span>}
                    {d.ageDays !== null && d.ageDays > 0 && (
                      <span className={ageTone(d.ageDays)}>{d.ageDays}d</span>
                    )}
                    {d.claimedBy && (
                      <Avatar
                        src={d.claimedBy.photoUrl}
                        name={d.claimedBy.name}
                        size="xs"
                      />
                    )}
                  </span>
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
                </li>
              );
            })}
          </ul>
        )}
        {rest.length > 3 && (
          <button
            type="button"
            className="mt-2 w-full text-center text-2xs text-silver/70 hover:text-gold"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? 'Show less' : `Show all (${rows?.length ?? 0})`}
          </button>
        )}

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
                    Release
                  </Button>
                ) : !roomItem.claimedBy ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${roomItem.key}:claim`}
                    disabled={busyKey !== null}
                    onClick={() => void act(roomItem.key, 'claim')}
                  >
                    I&apos;ve got this
                  </Button>
                ) : null}
                {(!roomItem.claimedBy || roomItem.claimedByMe) && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onClick={() => openPicker('assign', roomItem)}
                  >
                    Assign
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyKey !== null}
                  onClick={() => openPicker('tag', roomItem)}
                >
                  Tag
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  loading={busyKey === `${roomItem.key}:postpone`}
                  disabled={busyKey !== null}
                  onClick={() => postpone(roomItem)}
                >
                  Postpone
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  loading={busyKey === `${roomItem.key}:plan`}
                  disabled={busyKey !== null}
                  onClick={() => void addToPlan(roomItem)}
                >
                  + My day
                </Button>
                {!roomItem.escalated && (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${roomItem.key}:escalate`}
                    disabled={busyKey !== null}
                    onClick={() => escalate(roomItem)}
                  >
                    Escalate
                  </Button>
                )}
              </div>
            ) : undefined
          }
        />

        <Dialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {picker?.mode === 'assign' ? 'Assign to a colleague' : 'Tag a colleague'}
              </DialogTitle>
              <DialogDescription>
                {picker?.item.label}
                {picker?.mode === 'assign'
                  ? ' — it will move to their queue and they will be notified.'
                  : ' — they get a notification with your note; nothing changes hands.'}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1">
                <Label htmlFor="collab-target">Colleague</Label>
                <Select
                  id="collab-target"
                  value={pickTarget}
                  onChange={(e) => setPickTarget(e.target.value)}
                >
                  <option value="">
                    {colleagues === null ? 'Loading…' : 'Pick a colleague…'}
                  </option>
                  {(colleagues ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.roleLabel}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="collab-note">Note (optional)</Label>
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
                      ? 'e.g. "Can you take this one? I\'m on the floor until 3."'
                      : 'e.g. "Heads up — this touches your store."'
                  }
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setPicker(null)}>
                  Cancel
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
                  {picker?.mode === 'assign' ? 'Assign' : 'Tag'}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
