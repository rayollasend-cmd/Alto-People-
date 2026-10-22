import type { Shift } from '@alto-people/shared';

/**
 * Lane layout for the day view (role walk, ops 9). Four open Housekeeper
 * 9a–5p shifts used to draw as one blue block; interval partitioning puts
 * each shift of an overlap cluster in its own lane, and identical open
 * shifts (same position, same times, nobody assigned) fold into one
 * counted chip so a cluster of ten stays readable.
 */

export interface LaidOutShift {
  shift: Shift;
  /** 0-based lane inside the overlap cluster. */
  lane: number;
  /** Lanes the cluster needs — the chip is 1/lanes wide. */
  lanes: number;
  /** Identical open shifts folded into this chip (itself included). */
  group: Shift[];
  /** The fold the chip belongs to (null when it never folds) — the key a
   *  view keeps in its "expanded" set. */
  foldKey: string | null;
}

const ms = (iso: string) => new Date(iso).getTime();

export function foldKeyOf(s: Shift): string | null {
  if (s.assignedAssociateId || s.status === 'CANCELLED') return null;
  return `${s.position}|${s.startsAt}|${s.endsAt}|${s.status}|${s.clientId ?? ''}`;
}

/** Collapse identical open shifts into one representative with its group. */
export function foldIdenticalOpen(
  shifts: readonly Shift[],
  opts: { minToFold?: number; unfoldKeys?: ReadonlySet<string> } = {},
): Array<{ shift: Shift; group: Shift[]; foldKey: string | null }> {
  const minToFold = opts.minToFold ?? 2;
  const groups = new Map<string, Shift[]>();
  const order: Array<{ shift: Shift; group: Shift[]; foldKey: string | null }> = [];
  for (const s of shifts) {
    const key = foldKeyOf(s);
    if (!key || opts.unfoldKeys?.has(key)) {
      order.push({ shift: s, group: [s], foldKey: key });
      continue;
    }
    const g = groups.get(key);
    if (g) {
      g.push(s);
      continue;
    }
    const group = [s];
    groups.set(key, group);
    order.push({ shift: s, group, foldKey: key });
  }
  // Groups under the fold threshold go back to one chip per shift.
  return order.flatMap((o) =>
    o.group.length >= minToFold || o.group.length === 1 ? [o] : o.group.map((s) => ({ shift: s, group: [s], foldKey: o.foldKey })),
  );
}

/**
 * Sort by start, then assign each shift the first lane whose last end is
 * at or before its start. A cluster is a run of shifts that transitively
 * overlap; every chip in a cluster shares the cluster's lane count.
 */
export function layoutLanes(
  shifts: readonly Shift[],
  opts: { foldOpen?: boolean; minToFold?: number; unfoldKeys?: ReadonlySet<string> } = {},
): LaidOutShift[] {
  const items =
    opts.foldOpen === false
      ? shifts.map((s) => ({ shift: s, group: [s], foldKey: foldKeyOf(s) }))
      : foldIdenticalOpen(shifts, { minToFold: opts.minToFold, unfoldKeys: opts.unfoldKeys });
  const sorted = [...items].sort((a, b) => ms(a.shift.startsAt) - ms(b.shift.startsAt) || ms(a.shift.endsAt) - ms(b.shift.endsAt));
  const out: LaidOutShift[] = [];
  let cluster: LaidOutShift[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const closeCluster = () => {
    const lanes = laneEnds.length;
    for (const c of cluster) c.lanes = lanes;
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };
  for (const it of sorted) {
    const start = ms(it.shift.startsAt);
    const end = ms(it.shift.endsAt);
    if (cluster.length > 0 && start >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    const row: LaidOutShift = { shift: it.shift, lane, lanes: 1, group: it.group, foldKey: it.foldKey };
    cluster.push(row);
    out.push(row);
    if (end > clusterEnd) clusterEnd = end;
  }
  if (cluster.length > 0) closeCluster();
  return out;
}
