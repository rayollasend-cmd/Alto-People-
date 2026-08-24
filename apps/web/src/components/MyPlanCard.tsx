import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarDays, Check, CheckCircle2, Link2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { ymdLocal } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';

/**
 * "My plan" — the personal week, finished to the standard of the rest of
 * the console: dated day chips with visible load, hand-drawn check
 * circles with motion, a single Move control that unfolds the week,
 * instant sync from decision rooms ('alto:plan-changed'), per-day
 * progress, and the green "Day complete" moment.
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

// Intl directly — toLocale* is lint-banned; fmt* has no narrow-weekday
// or UTC-pinned day-name shapes.
const NARROW_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'narrow' });
const DAY_NAME_UTC_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function weekDays(): Array<{
  key: string;
  letter: string;
  date: number;
  isToday: boolean;
}> {
  const out: Array<{ key: string; letter: string; date: number; isToday: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86_400_000);
    out.push({
      key: ymdLocal(d),
      letter: NARROW_WEEKDAY_FMT.format(d),
      date: d.getDate(),
      isToday: i === 0,
    });
  }
  return out;
}

function dayName(key: string, todayKey: string, tomorrowKey: string): string {
  if (key === todayKey) return 'Today';
  if (key === tomorrowKey) return 'Tomorrow';
  return DAY_NAME_UTC_FMT.format(new Date(`${key}T12:00:00Z`));
}

/** The check circle — a real control with motion, not a browser checkbox. */
function CheckCircle({
  done,
  onToggle,
  disabled,
  label,
}: {
  done: boolean;
  onToggle: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-all duration-200',
        done
          ? 'scale-100 border-success bg-success text-navy'
          : 'border-silver/40 bg-transparent hover:border-gold hover:scale-110',
      )}
    >
      <Check
        className={cn(
          'h-3 w-3 transition-all duration-200',
          done ? 'scale-100 opacity-100' : 'scale-50 opacity-0',
        )}
        strokeWidth={3}
        aria-hidden="true"
      />
    </button>
  );
}

export function MyPlanCard() {
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
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
      setMovingId(null);
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
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2.5">
            <CardTitle className="text-base">My plan</CardTitle>
            <span className="text-xs text-silver/70">
              {dayName(selectedDay, todayKey, tomorrowKey)}
            </span>
          </div>
          {dayItems.length > 0 && (
            <span className="flex items-center gap-2 text-2xs tabular-nums text-silver/70">
              {dayComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
              ) : null}
              {doneCount}/{dayItems.length}
              <span className="h-1 w-16 overflow-hidden rounded-full bg-navy-secondary/70">
                <span
                  className={cn(
                    'block h-full rounded-full transition-all duration-300',
                    dayComplete ? 'bg-success' : 'bg-gold',
                  )}
                  style={{ width: `${(doneCount / dayItems.length) * 100}%` }}
                />
              </span>
            </span>
          )}
        </div>
        {/* The week — dated chips wearing their load. */}
        <div className="mt-2 flex gap-1.5">
          {days.map((d) => {
            const open = (byDay.get(d.key) ?? []).filter((i) => !i.done).length;
            const all = (byDay.get(d.key) ?? []).length;
            const clear = all > 0 && open === 0;
            const selected = d.key === selectedDay;
            return (
              <button
                key={d.key}
                type="button"
                onClick={() => setSelectedDay(d.key)}
                aria-label={dayName(d.key, todayKey, tomorrowKey)}
                aria-pressed={selected}
                className={cn(
                  'relative flex h-11 w-10 flex-col items-center justify-center rounded-lg transition-all duration-150',
                  selected
                    ? 'bg-gold/20 text-gold ring-1 ring-gold/50'
                    : 'bg-navy-secondary/50 text-silver hover:bg-navy-secondary hover:text-white',
                  d.isToday && !selected && 'ring-1 ring-silver/25',
                )}
              >
                <span className="text-2xs font-medium uppercase leading-none opacity-70">
                  {d.letter}
                </span>
                <span className="mt-0.5 text-sm font-semibold leading-none tabular-nums">
                  {d.date}
                </span>
                {open > 0 && (
                  <span
                    className={cn(
                      'absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-2xs tabular-nums',
                      selected ? 'bg-gold text-navy' : 'bg-steel/80 text-white',
                    )}
                  >
                    {open}
                  </span>
                )}
                {clear && (
                  <span
                    className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success text-navy"
                    aria-hidden="true"
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5 pt-0">
        {items === null && <Skeleton className="h-16" />}
        {items !== null && (
          <>
            {dayComplete && (
              <p className="flex items-center gap-2 rounded-md border border-success/20 bg-success/[0.06] px-3 py-2 text-sm text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Day complete — everything you planned is done.
              </p>
            )}
            {dayItems.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 rounded-md border border-dashed border-navy-secondary py-5 text-center">
                <CalendarDays className="h-5 w-5 text-silver/40" aria-hidden="true" />
                <p className="text-sm text-silver">
                  Nothing planned{selectedDay === todayKey ? ' for today' : ''} yet.
                </p>
                <p className="text-2xs text-silver/60">
                  Add a task below, or pull queue items in with “+ My day”.
                </p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {dayItems.map((item) => (
                  <li
                    key={item.id}
                    className="group -mx-2 rounded-md px-2 py-1.5 transition-colors hover:bg-navy-secondary/30"
                  >
                    <div className="flex items-center gap-2.5">
                      <CheckCircle
                        done={item.done}
                        disabled={busy !== null}
                        onToggle={() => void toggle(item)}
                        label={`Mark "${item.title}" ${item.done ? 'not done' : 'done'}`}
                      />
                      {item.linkUrl ? (
                        <Link
                          to={item.linkUrl}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-1.5 text-sm transition-colors duration-200 hover:text-gold',
                            item.done ? 'text-silver/40 line-through' : 'text-white',
                          )}
                        >
                          <span className="truncate">{item.title}</span>
                          <Link2
                            className="h-3 w-3 shrink-0 text-silver/40"
                            aria-hidden="true"
                          />
                        </Link>
                      ) : (
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-sm transition-colors duration-200',
                            item.done ? 'text-silver/40 line-through' : 'text-white',
                          )}
                        >
                          {item.title}
                        </span>
                      )}
                      {!item.done && (
                        <button
                          type="button"
                          className={cn(
                            'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-all',
                            movingId === item.id
                              ? 'bg-gold/15 text-gold'
                              : 'text-silver/50 opacity-0 hover:text-gold group-focus-within:opacity-100 group-hover:opacity-100',
                          )}
                          disabled={busy !== null}
                          onClick={() => setMovingId(movingId === item.id ? null : item.id)}
                          aria-expanded={movingId === item.id}
                        >
                          Move <ArrowRight className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="shrink-0 rounded p-0.5 text-silver/40 opacity-0 transition-opacity hover:text-alert group-focus-within:opacity-100 group-hover:opacity-100"
                        disabled={busy !== null}
                        onClick={() => void remove(item)}
                        aria-label={`Remove "${item.title}"`}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    {/* The Move control unfolds the same week language. */}
                    {movingId === item.id && !item.done && (
                      <div className="mt-1.5 flex gap-1.5 pl-7">
                        {days
                          .filter((d) => d.key !== item.day)
                          .map((d) => (
                            <button
                              key={d.key}
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void reschedule(item, d.key)}
                              aria-label={`Move to ${dayName(d.key, todayKey, tomorrowKey)}`}
                              className="flex h-8 w-8 flex-col items-center justify-center rounded-md bg-navy-secondary/60 text-silver transition-colors hover:bg-gold/20 hover:text-gold"
                            >
                              <span className="text-2xs uppercase leading-none opacity-70">
                                {d.letter}
                              </span>
                              <span className="text-xs font-semibold leading-none tabular-nums">
                                {d.date}
                              </span>
                            </button>
                          ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={add} className="flex items-center gap-2 pt-0.5">
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
                loading={busy === 'add'}
                disabled={busy !== null || title.trim().length === 0}
                aria-label="Add task"
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
