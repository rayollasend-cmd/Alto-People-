import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { inShiftWindow, minuteOfDayInZone } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { getMyShiftWindows, type MyShiftWindow } from '@/lib/shiftWindowsApi';

/**
 * "My shift" focus — the shift windows a supervisor leads, applied to the
 * day's rows. Focus, not a lock: the same page, the same data, a narrower
 * default view with "Whole store" one tap away. A shift belongs to the
 * window its START falls in, at its own store — the server's alert routing
 * (lib/shiftWindows) uses the same rule, so what a supervisor is paged
 * about is exactly what their shift view shows.
 */

export type Focus = 'mine' | 'store';

export interface WindowSpan {
  locationId: string;
  label: string;
  startMinute: number;
  endMinute: number;
  timezone?: string;
}

/** The window a row starts in (first match), or null. */
export function windowOf<W extends WindowSpan>(
  row: { locationId?: string | null; startsAt: string; timezone: string },
  windows: W[],
): W | null {
  if (!row.locationId) return null;
  for (const w of windows) {
    if (w.locationId !== row.locationId) continue;
    if (inShiftWindow(minuteOfDayInZone(row.startsAt, w.timezone ?? row.timezone), w)) return w;
  }
  return null;
}

export function inWindows(
  row: { locationId?: string | null; startsAt: string; timezone: string },
  windows: WindowSpan[],
): boolean {
  return windowOf(row, windows) !== null;
}

/** The windows running at this instant, each on its store's clock. */
export function activeWindows<W extends WindowSpan>(windows: W[], now: Date = new Date()): W[] {
  return windows.filter((w) => inShiftWindow(minuteOfDayInZone(now, w.timezone), w));
}

/** A clock-in with no scheduled shift belongs to the window it walked in
 *  for — half an hour early still counts as that crew. */
const EARLY_MIN = 30;
export function clockInInWindows(clockInAt: string, windows: WindowSpan[]): boolean {
  const at = new Date(new Date(clockInAt).getTime() + EARLY_MIN * 60_000);
  return windows.some((w) => inShiftWindow(minuteOfDayInZone(at, w.timezone), w));
}

/** "Overnight" · "Morning & Swing" · "3 shifts". */
export function focusName(windows: Array<{ label: string }>): string {
  const labels = [...new Set(windows.map((w) => w.label))];
  if (labels.length <= 2) return labels.join(' & ');
  return `${labels.length} shifts`;
}

const STORAGE_KEY = 'alto.floor.focus';

function readStored(): Focus | null {
  try {
    const v = sessionStorage.getItem(STORAGE_KEY);
    return v === 'mine' || v === 'store' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The signed-in supervisor's windows and the focus toggle. Opens on their
 * shift; a switch to "Whole store" holds for the session so it doesn't
 * snap back on every page. Anyone without windows (a store manager, a
 * supervisor not yet given a shift) is always on the whole store.
 */
export function useShiftFocus(): {
  windows: MyShiftWindow[];
  focus: Focus;
  setFocus: (f: Focus) => void;
  /** True when "My shift" is applied (they have windows AND chose it). */
  mine: boolean;
} {
  const { user } = useAuth();
  // Floor supervisors work a shift too — the same focus.
  const isSupervisor = user?.role === 'SHIFT_SUPERVISOR' || user?.role === 'FLOOR_SUPERVISOR';
  const q = useQuery({
    queryKey: ['me', 'shift-windows'],
    queryFn: getMyShiftWindows,
    enabled: isSupervisor,
    staleTime: 5 * 60_000,
  });
  const [focus, setFocusState] = useState<Focus>(() => readStored() ?? 'mine');
  const setFocus = (f: Focus) => {
    setFocusState(f);
    try {
      sessionStorage.setItem(STORAGE_KEY, f);
    } catch {
      // Private mode — the choice just doesn't outlive the page.
    }
  };
  const windows = isSupervisor ? (q.data?.windows ?? []) : [];
  return { windows, focus, setFocus, mine: windows.length > 0 && focus === 'mine' };
}

type DayRow = {
  associateId: string | null;
  locationId?: string | null;
  startsAt: string;
  timezone: string;
  state: string;
  clockInAt?: string | null;
};

/** Everyone clocked in right now who is on this shift: their scheduled
 *  shift starts in it — or, with no shift on today's roster (a walk-in,
 *  last night's crew), they clocked in for it. */
export function crewOnFloor<P extends { associateId: string; clockInAt?: string | null }>(
  onFloorNow: P[],
  roster: DayRow[],
  windows: WindowSpan[],
): P[] {
  return onFloorNow.filter((p) => {
    const row = roster.find((r) => r.associateId === p.associateId && r.state === 'on-floor');
    if (row) return inWindows(row, windows);
    return p.clockInAt ? clockInInWindows(p.clockInAt, windows) : false;
  });
}

/** The day payload's summary, recounted over a subset of the roster. */
export function summarize(rows: Array<{ state: string }>) {
  return {
    expected: rows.filter((r) => r.state !== 'open').length,
    worked: rows.filter((r) => r.state === 'worked' || r.state === 'on-floor').length,
    onFloor: rows.filter((r) => r.state === 'on-floor').length,
    missed: rows.filter((r) => r.state === 'missed').length,
    open: rows.filter((r) => r.state === 'open').length,
  };
}
