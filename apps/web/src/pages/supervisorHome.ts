import { minuteOfDayInZone } from '@alto-people/shared';
import { zonedMinutesOfDay } from '@/lib/format';

/**
 * The shift supervisor's Home, as pure rules (pages/SupervisorDashboard):
 * which windows the hero counts, how the contract is drawn across the day,
 * and how their windows read on one line.
 */

interface Span {
  label: string;
  startMinute: number;
  endMinute: number;
}

/**
 * Off the clock: EVERY window that starts next, together (FLOOR-2). A lead
 * running three Morning windows at three stores is short against all three
 * targets (3 + 5 + 3 = 11), not the first one the sort happened to pick —
 * the hero read "0 / 3" beside a "Today by shift" line of 11 expected.
 * Each window's wait is read on its own store's clock.
 */
export function nextWindows<W extends { startMinute: number; timezone: string }>(windows: readonly W[], now: Date = new Date()): W[] {
  if (windows.length === 0) return [];
  const wait = (w: W) => (w.startMinute - minuteOfDayInZone(now, w.timezone) + 1440) % 1440;
  const soonest = Math.min(...windows.map(wait));
  return windows.filter((w) => wait(w) === soonest);
}

/**
 * Windows that share a name and hours, as one (FLOOR-27): "Morning 6:00 AM –
 * 2:00 PM · 3 stores" instead of the same window repeated per store, run on
 * as one string. Order: by start.
 */
export function groupWindows<W extends Span & { locationName: string; targetCount?: number }>(
  windows: readonly W[],
): Array<Span & { stores: string[]; targetCount: number }> {
  const groups = new Map<string, Span & { stores: string[]; targetCount: number }>();
  for (const w of windows) {
    const key = `${w.label}|${w.startMinute}|${w.endMinute}`;
    const g = groups.get(key) ?? { label: w.label, startMinute: w.startMinute, endMinute: w.endMinute, stores: [], targetCount: 0 };
    if (!g.stores.includes(w.locationName)) g.stores.push(w.locationName);
    g.targetCount += w.targetCount ?? 0;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.startMinute - b.startMinute || a.label.localeCompare(b.label));
}

/**
 * The contract by hour of the store's day (FLOOR-4), indexed 0–23 on the
 * store's clock — what the coverage chart's details table lists beside the
 * scheduled and open counts. null where no contract is set for the hour.
 */
export function contractByStoreHour(hours: ReadonlyArray<{ at: string; target: number | null }>, storeTz: string | null): Array<number | null> {
  const out: Array<number | null> = Array.from({ length: 24 }, () => null);
  for (const h of hours) {
    const i = Math.floor(zonedMinutesOfDay(h.at, storeTz) / 60);
    if (i >= 0 && i < 24 && out[i] === null) out[i] = h.target;
  }
  return out;
}

/** The contract at a store-local minute from labeled windows: the windows covering it, summed (end ≤ start wraps midnight). */
export function windowsContractAt(windows: ReadonlyArray<Span & { targetCount: number }>, minute: number): number | null {
  let total = 0;
  let any = false;
  for (const w of windows) {
    const inside = w.endMinute > w.startMinute ? minute >= w.startMinute && minute < w.endMinute : minute >= w.startMinute || minute < w.endMinute;
    if (!inside) continue;
    any = true;
    total += w.targetCount;
  }
  return any ? total : null;
}
