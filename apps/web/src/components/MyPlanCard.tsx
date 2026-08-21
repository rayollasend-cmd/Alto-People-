import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate, ymdLocal } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * "My plan" — the personal day/week planner on every dashboard. Mixes
 * queue items pulled in via "+ My day" with free-form tasks typed here.
 * Check things off, push them to another day, or drop them. Private to
 * the signed-in user.
 */

interface PlanItem {
  id: string;
  day: string;
  title: string;
  decisionKey: string | null;
  linkUrl: string | null;
  done: boolean;
}

function dayLabel(day: string, todayKey: string, tomorrowKey: string): string {
  if (day === todayKey) return 'Today';
  if (day === tomorrowKey) return 'Tomorrow';
  return fmtDate(day);
}

export function MyPlanCard() {
  const [items, setItems] = useState<PlanItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [title, setTitle] = useState('');
  const [day, setDay] = useState<'today' | 'tomorrow'>('today');
  const [busy, setBusy] = useState<string | null>(null);

  const todayKey = ymdLocal();
  const tomorrowKey = ymdLocal(new Date(Date.now() + 86_400_000));

  const load = useCallback(() => {
    setFailed(false);
    apiFetch<{ items: PlanItem[] }>(
      `/me/plan?from=${todayKey}&to=${ymdLocal(new Date(Date.now() + 6 * 86_400_000))}`,
    )
      .then((r) => setItems(r.items))
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || title.trim().length === 0) return;
    setBusy('add');
    try {
      await apiFetch('/me/plan', {
        method: 'POST',
        body: { day: day === 'today' ? todayKey : tomorrowKey, title: title.trim() },
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
    try {
      await apiFetch(`/me/plan/${item.id}`, { method: 'PATCH', body: { done: !item.done } });
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the task.');
    } finally {
      setBusy(null);
    }
  };
  const moveToTomorrow = async (item: PlanItem) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await apiFetch(`/me/plan/${item.id}`, { method: 'PATCH', body: { day: tomorrowKey } });
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

  // Quiet supplement: hide entirely if the planner can't load AND there's
  // nothing local to show.
  if (failed) return null;

  const byDay = new Map<string, PlanItem[]>();
  for (const i of items ?? []) {
    (byDay.get(i.day) ?? byDay.set(i.day, []).get(i.day)!).push(i);
  }
  const days = [...byDay.keys()].sort();
  const openCount = (items ?? []).filter((i) => !i.done).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">My plan</CardTitle>
          {items && items.length > 0 && (
            <span className="text-2xs tabular-nums text-silver/70">
              {openCount} open this week
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {items === null && <Skeleton className="h-16" />}
        {items !== null && items.length === 0 && (
          <p className="text-sm text-silver">
            Plan your day — add a task below, or pull queue items in with
            “+ My day”.
          </p>
        )}
        {days.map((d) => (
          <div key={d}>
            <div className="mb-1 text-2xs uppercase tracking-wider text-silver/60">
              {dayLabel(d, todayKey, tomorrowKey)}
            </div>
            <ul className="space-y-1">
              {byDay.get(d)!.map((item) => (
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
                  {!item.done && d === todayKey && (
                    <button
                      type="button"
                      className="shrink-0 text-2xs text-silver/60 opacity-0 transition-opacity hover:text-gold group-hover:opacity-100 focus:opacity-100"
                      disabled={busy !== null}
                      onClick={() => void moveToTomorrow(item)}
                    >
                      → tomorrow
                    </button>
                  )}
                  <button
                    type="button"
                    className="shrink-0 text-2xs text-silver/60 opacity-0 transition-opacity hover:text-alert group-hover:opacity-100 focus:opacity-100"
                    disabled={busy !== null}
                    onClick={() => void remove(item)}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <form onSubmit={add} className="flex items-center gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add a task…"
            className="h-8 flex-1 text-sm"
            aria-label="New plan task"
          />
          <Select
            size="sm"
            className="w-auto"
            value={day}
            onChange={(e) => setDay(e.target.value as 'today' | 'tomorrow')}
            aria-label="Which day"
          >
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
          </Select>
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
      </CardContent>
    </Card>
  );
}
