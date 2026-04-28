import { useCallback, useEffect, useState } from 'react';
import type { AvailabilityWindow } from '@alto-people/shared';
import {
  getMyAvailability,
  replaceMyAvailability,
} from '@/lib/schedulingApi';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
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
        <span className="text-xs text-silver/60">
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
                  className="grid grid-cols-12 gap-2 items-center"
                >
                  <select
                    value={w.dayOfWeek}
                    onChange={(e) =>
                      updateWindow(idx, { dayOfWeek: Number(e.target.value) })
                    }
                    className="col-span-3 px-2 py-1.5 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm"
                  >
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    value={w.start}
                    onChange={(e) => updateWindow(idx, { start: e.target.value })}
                    className="col-span-3 px-2 py-1.5 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm"
                  />
                  <span className="col-span-1 text-center text-silver">–</span>
                  <input
                    type="time"
                    value={w.end}
                    onChange={(e) => updateWindow(idx, { end: e.target.value })}
                    className="col-span-3 px-2 py-1.5 rounded bg-navy-secondary/60 border border-navy-secondary text-white text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => removeWindow(idx)}
                    className="col-span-2 text-xs text-silver/70 hover:text-alert"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addWindow}
              className="px-3 py-1.5 rounded text-sm border border-silver/30 text-silver hover:text-white"
            >
              + Add window
            </button>
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
            {info && <span className="text-sm text-emerald-300 ml-2">{info}</span>}
          </div>
        </>
      )}
    </section>
  );
}
