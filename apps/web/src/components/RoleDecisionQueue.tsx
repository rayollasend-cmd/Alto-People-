import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtMoney, ymdLocal } from '@/lib/format';
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
 * "Needs your decision" for every seat — collaborative: claim ("I've got
 * this"), hand off to a colleague (assign/reassign, they're notified and
 * it lands in their chips), tag someone for awareness, postpone to a
 * later day, escalate upward with a note, or pull the item into your own
 * day plan. Items auto-clear when the underlying work is done. Renders
 * nothing when empty or unavailable — every item has a primary surface.
 */

interface RoleDecision {
  key: string;
  severity: 'critical' | 'high' | 'normal';
  label: string;
  detail: string;
  stakes: number | null;
  ageDays: number | null;
  linkUrl: string;
  claimedBy: { id: string; name: string } | null;
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

export function RoleDecisionQueue({ title = 'Needs your decision' }: { title?: string }) {
  const [rows, setRows] = useState<RoleDecision[] | null>(null);
  const [error, setError] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [colleagues, setColleagues] = useState<Colleague[] | null>(null);
  const [picker, setPicker] = useState<{
    mode: 'assign' | 'tag';
    item: RoleDecision;
  } | null>(null);
  const [pickTarget, setPickTarget] = useState('');
  const [pickNote, setPickNote] = useState('');

  const load = useCallback(() => {
    setError(false);
    apiFetch<{ decisions: RoleDecision[] }>('/me/decisions')
      .then((r) => setRows(r.decisions))
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
      await apiFetch('/me/decisions/act', {
        method: 'POST',
        body: { key, action, ...extra },
      });
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
        body: {
          day: ymdLocal(),
          title: item.label,
          decisionKey: item.key,
          linkUrl: item.linkUrl,
        },
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

  // Supplement card: vanish quietly on failure or empty — every item has
  // a primary surface with its own error handling.
  if (error) return null;
  if (rows !== null && rows.length === 0) return null;

  return (
    <Card className={rows?.some((d) => d.severity === 'critical') ? 'border-alert/40' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {rows && rows.length > 0 && (
            <span className="text-2xs tabular-nums text-silver/70">{rows.length} waiting</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {rows === null && <Skeleton className="h-20" />}
        {rows && rows.length > 0 && (
          <ul className="space-y-2">
            {rows.slice(0, 6).map((d) => (
              <li
                key={d.key}
                className={`rounded-md border-l-2 bg-navy-secondary/30 px-3 py-2 ${
                  d.severity === 'critical'
                    ? 'border-alert'
                    : d.severity === 'high'
                      ? 'border-warning'
                      : 'border-navy-secondary'
                }`}
              >
                <Link to={d.linkUrl} className="group block">
                  <div className="flex flex-wrap items-center justify-between gap-x-2">
                    <span className="text-sm text-white group-hover:text-gold">{d.label}</span>
                    <span className="flex items-center gap-1.5 text-2xs tabular-nums text-silver">
                      {d.stakes !== null && <span>{fmtMoney(d.stakes)} at stake</span>}
                      {d.ageDays !== null && d.ageDays > 0 && (
                        <span className="text-silver/60">waiting {d.ageDays}d</span>
                      )}
                      {d.escalated && (
                        <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-warning">
                          escalated
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="text-xs text-silver">{d.detail}</div>
                </Link>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {d.claimedBy && !d.claimedByMe ? (
                    <span
                      className="rounded-full bg-steel/20 px-2 py-0.5 text-2xs text-white"
                      title={d.note ?? undefined}
                    >
                      With {d.claimedBy.name}
                    </span>
                  ) : d.claimedByMe ? (
                    <>
                      <span className="rounded-full bg-gold/15 px-2 py-0.5 text-2xs text-gold">
                        {d.assigned ? 'Assigned to you' : "You've got this"}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost"
                        loading={busyKey === `${d.key}:release`}
                        disabled={busyKey !== null}
                        onClick={() => void act(d.key, 'release')}
                      >
                        Release
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:claim`}
                      disabled={busyKey !== null}
                      onClick={() => void act(d.key, 'claim')}
                    >
                      I&apos;ve got this
                    </Button>
                  )}
                  {(!d.claimedBy || d.claimedByMe) && (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busyKey !== null}
                      onClick={() => openPicker('assign', d)}
                    >
                      Assign
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busyKey !== null}
                    onClick={() => openPicker('tag', d)}
                  >
                    Tag
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${d.key}:postpone`}
                    disabled={busyKey !== null}
                    onClick={() => postpone(d)}
                  >
                    Postpone
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busyKey === `${d.key}:plan`}
                    disabled={busyKey !== null}
                    onClick={() => void addToPlan(d)}
                  >
                    + My day
                  </Button>
                  {!d.escalated && (
                    <Button
                      size="xs"
                      variant="ghost"
                      loading={busyKey === `${d.key}:escalate`}
                      disabled={busyKey !== null}
                      onClick={() => escalate(d)}
                    >
                      Escalate
                    </Button>
                  )}
                </div>
              </li>
            ))}
            {rows.length > 6 && (
              <li className="text-center text-2xs text-silver/60">
                +{rows.length - 6} more waiting
              </li>
            )}
          </ul>
        )}

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
