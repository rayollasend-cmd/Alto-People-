import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { ymdLocal } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "My plan" — the personal week, run like a console:
 *   · a WEEK STRIP of seven tappable day chips showing each day's load
 *     (NVIDIA: see the shape of your week before you pile on)
 *   · tap a day to view it and add straight into it — scheduling is a
 *     tap, never typing (Tesla)
 *   · instant sync: anything added from a decision room appears here the
 *     moment the toast fires (SpaceX: the action IS the telemetry), via
 *     the 'alto:plan-changed' window event
 *   · progress per day, and a green "Day complete" moment at 100%
 */

interface PlanItem {
  id: string;
  day: string;
  title: string;
  decisionKey: string | null;
  linkUrl: string | null;
  done: boolean;
}

export const PLAN_CHANGED_EVENT = 'alto:plan-changed';

function weekDays(): Array<{ key: string; label: string; isToday: boolean }> {
  const out: Array<{ key: string; label: string; isToday: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    out.push({
      key: ymdLocal(d),
      label: d.toLocaleDateString('en-US', { weekday: 'narrow' }),
      isToday: i === 0,
    });
  }
  return out;
}

function dayName(key: string, todayKey: string, tomorrowKey: string): string {
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  return new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function MyPlanCard() {
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const days = useMemo(weekDays, []);
  const todayKey = days[0].key;
  const tomorrowKey = days[1].key;
  const [selectedDay, setSelectedDay] = useState(todayKey);

  const load = useCallback(() => {
    setFailed(false);
    apiFetch<{ items: PlanItem[] }>(`/me/plan?from=${todayKey}&to=${days[6].key}`)
      .then((r) => setItems(r.items))
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);
  // Instant sync: decision rooms announce plan changes; we re-read.
  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener(PLAN_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PLAN_CHANGED_EVENT, onChanged);
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || title.trim().length === 0) return;
    setBusy('add');
    try {
      await apiFetch('/me/plan', {
        method: 'POST',
        body: { day: selectedDay, title: title.trim() },
      });
      setTitle('');
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add the task.');
    } finally {
      setBusy(null);
    }
  };
  const toggle = async (item: PlanItem) => {
    if (busy) return;
    setBusy(item.id);
    // Optimistic: the tap IS the telemetry.
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i)) : prev,
    );
    try {
      await apiFetch(`/me/plan/${item.id}`, { method: 'PATCH', body: { done: !item.done } });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the task.');
      load();
    } finally {
      setBusy(null);
    }
  };
  const reschedule = async (item: PlanItem, day: string) => {
    if (busy || day === item.day) return;
    setBusy(item.id);
    try {
      await apiFetch(`/me/plan/${item.id}`, { method: 'PATCH', body: { day } });
      toast.success(`Moved to ${dayName(day, todayKey, tomorrowKey)}.`);
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not move the task.');
    } finally {
      setBusy(null);
    }
  };
  const remove = async (item: PlanItem) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await apiFetch(`/me/plan/${item.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the task.');
    } finally {
      setBusy(null);
    }
  };

  if (failed) return null;

  const byDay = new Map<string, PlanItem[]>();
  for (const i of items ?? []) {
    (byDay.get(i.day) ?? byDay.set(i.day, []).get(i.day)!).push(i);
  }
  const dayItems = byDay.get(selectedDay) ?? [];
  const doneCount = dayItems.filter((i) => i.done).length;
  const dayComplete = dayItems.length > 0 && doneCount === dayItems.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">My plan</CardTitle>
          {dayItems.length > 0 && (
            <span className="flex items-center gap-2 text-2xs tabular-nums text-silver/70">
              {doneCount}/{dayItems.length} done
              <span className="h-1 w-16 overflow-hidden rounded-full bg-navy-secondary/70">
                <span
                  className={`block h-full rounded-full ${dayComplete ? 'bg-success' : 'bg-gold'}`}
                  style={{ width: `${(doneCount / dayItems.length) * 100}%` }}
                />
              </span>
            </span>
          )}
        </div>
        {/* The week strip — seven taps, load visible. */}
        <div className="mt-1 flex gap-1.5">
          {days.map((d) => {
            const count = (byDay.get(d.key) ?? []).filter((i) => !i.done).length;
            const selected = d.key === selectedDay;
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setSelectedDay(d.key)}
                aria-label={dayName(d.key, todayKey, tomorrowKey)}
                className={`relative flex h-9 w-9 flex-col items-center justify-center rounded-lg text-xs transition-colors ${
                  selected
                    ? 'bg-gold/20 text-gold ring-1 ring-gold/50'
                    : 'bg-navy-secondary/50 text-silver hover:bg-navy-secondary'
                } ${d.isToday && !selected ? 'ring-1 ring-silver/30' : ''}`}
              >
                <span className="font-medium">{d.label}</span>
                {count > 0 && (
                  <span
                    className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs tabular-nums ${selected ? 'bg-gold text-navy' : 'bg-steel/80 text-white'}`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {items === null && <Skeleton className="h-16" />}
        {items !== null && (
          <>
            <div className="text-2xs uppercase tracking-wider text-silver/60">
              {dayName(selectedDay, todayKey, tomorrowKey)}
            </div>
            {dayComplete && (
              <p className="flex items-center gap-1.5 rounded-md border border-success/20 bg-success/[0.06] px-2.5 py-1.5 text-sm text-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Day complete — everything you planned is done.
              </p>
            )}
            {dayItems.length === 0 ? (
              <p className="text-sm text-silver">
                Nothing planned{selectedDay === todayKey ? ' today' : ''} — add a task below,
                or pull queue items in with “+ My day”.
              </p>
            ) : (
              <ul className="space-y-1">
                {dayItems.map((item) => (
                  <li key={item.id} className="group flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={busy !== null}
                      onChange={() => void toggle(item)}
                      aria-label={`Mark "${item.title}" ${item.done ? 'not done' : 'done'}`}
                    />
                    {item.linkUrl ? (
                      <Link
                        to={item.linkUrl}
                        className={`min-w-0 flex-1 truncate hover:text-gold ${item.done ? 'text-silver/50 line-through' : 'text-white'}`}
                      >
                        {item.title}
                      </Link>
                    ) : (
                      <span
                        className={`min-w-0 flex-1 truncate ${item.done ? 'text-silver/50 line-through' : 'text-white'}`}
                      >
                        {item.title}
                      </span>
                    )}
                    {/* Reschedule = tap a day, never type. */}
                    {!item.done && (
                      <span className="hidden shrink-0 gap-1 group-focus-within:flex group-hover:flex">
                        {days
                          .filter((d) => d.key !== item.day)
                          .slice(0, 7)
                          .map((d) => (
                            <button
                              key={d.key}
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void reschedule(item, d.key)}
                              title={`Move to ${dayName(d.key, todayKey, tomorrowKey)}`}
                              className="flex h-5 w-5 items-center justify-center rounded bg-navy-secondary/70 text-2xs text-silver hover:bg-gold/20 hover:text-gold"
                            >
                              {d.label}
                            </button>
                          ))}
                      </span>
                    )}
                    <button
                      type="button"
                      className="shrink-0 text-2xs text-silver/60 opacity-0 transition-opacity hover:text-alert group-focus-within:opacity-100 group-hover:opacity-100"
                      disabled={busy !== null}
                      onClick={() => void remove(item)}
                    >
                      remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={add} className="flex items-center gap-2">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={`Add a task for ${dayName(selectedDay, todayKey, tomorrowKey).toLowerCase()}…`}
                className="h-8 flex-1 text-sm"
                aria-label="New plan task"
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                loading={busy === 'add'}
                disabled={busy !== null || title.trim().length === 0}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
