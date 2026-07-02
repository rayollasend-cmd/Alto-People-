import { useCallback, useEffect, useState } from 'react';
import type {
  AvailabilityException,
  AvailabilityWindow,
} from '@alto-people/shared';
import {
  addAvailabilityException,
  deleteAvailabilityException,
  getMyAvailability,
  listMyAvailabilityExceptions,
  replaceMyAvailability,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { fmtDateTz, fmtWeekdayTz } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface DraftWindow {
  dayOfWeek: number;
  start: string;     // "HH:MM"
  end: string;
}

const minutesToHHMM = (m: number) => {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
};

const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function fromAPI(windows: AvailabilityWindow[]): DraftWindow[] {
  return windows.map((w) => ({
    dayOfWeek: w.dayOfWeek,
    start: minutesToHHMM(w.startMinute),
    end: minutesToHHMM(w.endMinute),
  }));
}

export function AvailabilityEditor() {
  const [drafts, setDrafts] = useState<DraftWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await getMyAvailability();
      setDrafts(fromAPI(res.windows));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load availability.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addWindow = () => {
    setDrafts([...drafts, { dayOfWeek: 1, start: '09:00', end: '17:00' }]);
  };

  const removeWindow = (idx: number) => {
    setDrafts(drafts.filter((_, i) => i !== idx));
  };

  const updateWindow = (idx: number, patch: Partial<DraftWindow>) => {
    setDrafts(drafts.map((w, i) => (i === idx ? { ...w, ...patch } : w)));
  };

  const handleSave = async () => {
    if (submitting) return;
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      const payload = drafts.map((w) => ({
        dayOfWeek: w.dayOfWeek,
        startMinute: hhmmToMinutes(w.start),
        endMinute: hhmmToMinutes(w.end),
      }));
      const res = await replaceMyAvailability({ windows: payload });
      setDrafts(fromAPI(res.windows));
      setInfo('Saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="bg-navy border border-navy-secondary rounded-lg p-5 mb-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-display text-2xl text-white">My availability</h2>
        <span className="text-xs text-silver/70">
          Used by HR to suggest you for open shifts
        </span>
      </div>

      {loading && (
        <div className="space-y-2 mb-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <Skeleton className="col-span-3 h-9" />
              <Skeleton className="col-span-3 h-9" />
              <span className="col-span-1" />
              <Skeleton className="col-span-3 h-9" />
              <Skeleton className="col-span-2 h-9" />
            </div>
          ))}
        </div>
      )}
      {!loading && (
        <>
          {drafts.length === 0 && (
            <p className="text-silver mb-3">
              No availability windows set. HR will treat you as fully unavailable.
            </p>
          )}
          {drafts.length > 0 && (
            <ul className="space-y-2 mb-3">
              {drafts.map((w, idx) => (
                <li
                  key={idx}
                  // Phones: day+Remove on one row, the time range on the
                  // next — the desktop single-line 12-col layout crammed
                  // four controls into ~328px. sm+ restores one line.
                  className="grid grid-cols-12 gap-2 items-center"
                >
                  <div className="col-span-8 sm:col-span-3">
                    <Select
                      value={w.dayOfWeek}
                      onChange={(e) =>
                        updateWindow(idx, { dayOfWeek: Number(e.target.value) })
                      }
                      size="sm"
                    >
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="col-span-4 sm:order-last sm:col-span-2 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => removeWindow(idx)}
                      className="text-silver/70 hover:text-alert hover:bg-transparent"
                    >
                      Remove
                    </Button>
                  </div>
                  <input
                    type="time"
                    value={w.start}
                    onChange={(e) => updateWindow(idx, { start: e.target.value })}
                    className="col-span-5 sm:col-span-3 px-2 py-1.5 coarse:min-h-11 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm coarse:text-base"
                  />
                  <span className="col-span-2 sm:col-span-1 text-center text-silver">–</span>
                  <input
                    type="time"
                    value={w.end}
                    onChange={(e) => updateWindow(idx, { end: e.target.value })}
                    className="col-span-5 sm:col-span-3 px-2 py-1.5 coarse:min-h-11 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm coarse:text-base"
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addWindow}
            >
              + Add window
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSave}
              loading={submitting}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save'}
            </Button>
            {error && <span className="text-sm text-alert ml-2">{error}</span>}
            {info && <span className="text-sm text-success ml-2">{info}</span>}
          </div>

          <DaysOffEditor />
        </>
      )}
    </section>
  );
}

/**
 * One-off "can't work this day" dates, layered over the weekly windows.
 * These block swap offers, open-shift pickup, and auto-scheduling for
 * that specific date — no manager approval needed, it's availability,
 * not time off.
 */
function DaysOffEditor() {
  const [exceptions, setExceptions] = useState<AvailabilityException[] | null>(null);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listMyAvailabilityExceptions();
        if (!cancelled) setExceptions(res.exceptions);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Failed to load days off.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const add = async () => {
    if (!date || saving) return;
    setSaving(true);
    setError(null);
    try {
      const created = await addAvailabilityException({
        date,
        note: note.trim() || undefined,
      });
      setExceptions((prev) => {
        const rest = (prev ?? []).filter((x) => x.date !== created.date);
        return [...rest, created].sort((a, b) => a.date.localeCompare(b.date));
      });
      setDate('');
      setNote('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that day.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteAvailabilityException(id);
      setExceptions((prev) => (prev ?? []).filter((x) => x.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that day.');
    }
  };

  // Build a LOCAL-midnight Date from "2026-07-15" (string parsing would go
  // through UTC and shift the day west of Greenwich), then format via the
  // shared helpers.
  const prettyDay = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    const local = new Date(y!, m! - 1, day!);
    return `${fmtWeekdayTz(local)}, ${fmtDateTz(local)}`;
  };
  const today = new Date();
  const minDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return (
    <div className="mt-5 pt-4 border-t border-navy-secondary">
      <h3 className="text-[11px] uppercase tracking-wider text-silver/80 mb-2">
        Days off (one-time)
      </h3>
      {exceptions && exceptions.length > 0 && (
        <ul className="flex flex-wrap gap-2 mb-3">
          {exceptions.map((x) => (
            <li
              key={x.id}
              className="inline-flex items-center gap-1.5 text-xs text-silver bg-navy-secondary/40 border border-navy-secondary rounded px-2 py-1"
            >
              <span className="text-white">{prettyDay(x.date)}</span>
              {x.note && <span className="text-silver/70">· {x.note}</span>}
              <button
                type="button"
                onClick={() => remove(x.id)}
                aria-label={`Remove day off ${x.date}`}
                // Bare × glyph was a ~14px tap target; pad the hit area
                // without inflating the chip visually.
                className="grid place-items-center h-9 w-9 -my-2 -mr-2 text-silver/60 hover:text-alert active:text-alert rounded"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {exceptions && exceptions.length === 0 && (
        <p className="text-xs text-silver/70 mb-3">
          No upcoming days off. Add a date you can't work and it blocks swap
          offers, pickups, and auto-scheduling for that day.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          min={minDate}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Day off date"
          className="px-2 py-1.5 coarse:min-h-11 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm coarse:text-base"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder="Reason (optional)"
          aria-label="Day off reason"
          className="px-2 py-1.5 coarse:min-h-11 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm coarse:text-base w-44"
        />
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={!date || saving}>
          Add day off
        </Button>
        {error && <span className="text-xs text-alert">{error}</span>}
      </div>
    </div>
  );
}
