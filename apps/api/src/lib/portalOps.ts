import type { OpsPeriod, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { METRIC_LABEL } from './opsSops.js';
import { personName } from './floorLeads.js';
import { currentStoreWindows } from './shiftWindows.js';
import { zonedWallTimeToUtcInstant } from './timezone.js';
import { nextKey, type PortalScope, type StoreCalendar } from './portalMetrics.js';

/**
 * Store operations, one day — what a Walmart store manager and their team
 * leads want from the SOPs without opening a single checklist:
 *
 *   the grid       every department × shift: submitted, running (and how
 *                  far along), late, or never started
 *   attention      what needs a manager NOW, worst first — a temperature
 *                  out of range and not re-checked, overdue blocks, an SOP
 *                  that never opened, blocked work, No/Partial answers,
 *                  equipment down, SOPs submitted incomplete
 *   food safety    every temperature taken, against its range, with the
 *                  re-check that closed it out
 *   production     freight received, cases stocked, picks, overstock,
 *                  claims, discards, markdowns, donations — by department
 *   handoffs       what each shift told the next, and whether it was taken
 *
 * Operations only — no money, no pay, no rates. Team leads are named (the
 * portal's Day page names them too); associates are not.
 */

const H = 3_600_000;
/** An expected SOP that hasn't opened this long after its shift started. */
const NOT_STARTED_GRACE_MS = 30 * 60_000;

export type AttentionKind =
  | 'TEMP'
  | 'NOT_STARTED'
  | 'OVERDUE'
  | 'NOT_SUBMITTED'
  | 'BLOCKED'
  | 'EQUIPMENT'
  | 'COMPLIANCE'
  | 'INCOMPLETE';

const SEVERITY: Record<AttentionKind, 'high' | 'medium'> = {
  TEMP: 'high',
  NOT_STARTED: 'high',
  OVERDUE: 'high',
  NOT_SUBMITTED: 'high',
  EQUIPMENT: 'high',
  BLOCKED: 'medium',
  COMPLIANCE: 'medium',
  INCOMPLETE: 'medium',
};
const KIND_ORDER: AttentionKind[] = [
  'TEMP',
  'EQUIPMENT',
  'NOT_STARTED',
  'NOT_SUBMITTED',
  'OVERDUE',
  'BLOCKED',
  'COMPLIANCE',
  'INCOMPLETE',
];
const PERIOD_ORDER: OpsPeriod[] = ['MORNING', 'EVENING', 'CLOSING', 'OVERNIGHT'];

const shiftSelect = {
  id: true,
  department: true,
  period: true,
  position: true,
  windowLabel: true,
  templateName: true,
  status: true,
  openedAt: true,
  closedAt: true,
  dueAt: true,
  sopDone: true,
  sopTotal: true,
  closedIncomplete: true,
  incompleteReason: true,
  closingSummary: true,
  locationId: true,
  location: { select: { name: true } },
  openedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
} satisfies Prisma.OpsShiftSelect;

const taskSelect = {
  id: true,
  opsShiftId: true,
  source: true,
  section: true,
  order: true,
  title: true,
  status: true,
  responseType: true,
  required: true,
  dueAt: true,
  completedAt: true,
  tempLabel: true,
  tempMin: true,
  tempMax: true,
  tempOutOfRange: true,
  answerNumber: true,
  answerChoice: true,
  answerText: true,
  blockedReason: true,
  metricKey: true,
  unit: true,
  parentTaskId: true,
  photos: { select: { id: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OpsTaskSelect;

type TaskRow = Prisma.OpsTaskGetPayload<{ select: typeof taskSelect }>;

const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

export async function buildStoreOps(
  scope: PortalScope,
  opts: { dateKey: string; cal: StoreCalendar; now: Date },
) {
  const { dateKey, cal, now } = opts;
  const dayStart = cal.midnight(dateKey);
  const dayEnd = cal.midnight(nextKey(dateKey, 1));

  const stores = scope.locationId
    ? [{ id: scope.locationId, name: scope.location!.name, timezone: scope.location!.timezone }]
    : await prisma.location.findMany({
        where: { clientId: scope.clientId, deletedAt: null, isActive: true },
        select: { id: true, name: true, timezone: true },
        orderBy: { name: 'asc' },
      });
  // A hand-opened SOP carries no store; at a single-store client it can
  // only be that store's.
  const soleStore = stores.length === 1;
  const locWhere: Prisma.OpsShiftWhereInput = scope.locationId
    ? soleStore && (await isSoleStore(scope.clientId))
      ? { OR: [{ locationId: scope.locationId }, { locationId: null }] }
      : { locationId: scope.locationId }
    : {};

  const [shifts, windows, assigned] = await Promise.all([
    prisma.opsShift.findMany({
      where: { clientId: scope.clientId, ...locWhere, openedAt: { gte: dayStart, lt: dayEnd } },
      select: shiftSelect,
      orderBy: { openedAt: 'asc' },
      take: 200,
    }),
    currentStoreWindows(
      prisma,
      stores.map((s) => s.id),
      now,
    ),
    prisma.storeShiftSop.findMany({
      where: { locationId: { in: stores.map((s) => s.id) } },
      select: {
        locationId: true,
        label: true,
        template: { select: { name: true, department: true, period: true, active: true, retiredAt: true } },
      },
    }),
  ]);
  const shiftIds = shifts.map((s) => s.id);
  const [tasks, handovers] = shiftIds.length
    ? await Promise.all([
        prisma.opsTask.findMany({
          where: { opsShiftId: { in: shiftIds } },
          select: taskSelect,
          orderBy: [{ opsShiftId: 'asc' }, { order: 'asc' }],
          take: 5000,
        }),
        prisma.opsHandoverItem.findMany({
          where: { fromShiftId: { in: shiftIds } },
          select: {
            id: true,
            fromShiftId: true,
            kind: true,
            body: true,
            priority: true,
            status: true,
            createdAt: true,
            decidedAt: true,
            decidedBy: { select: { email: true, associate: { select: { firstName: true, lastName: true } } } },
          },
          orderBy: { createdAt: 'asc' },
          take: 500,
        }),
      ])
    : [[], []];

  const tasksByShift = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const list = tasksByShift.get(t.opsShiftId) ?? [];
    list.push(t);
    tasksByShift.set(t.opsShiftId, list);
  }
  const childrenOf = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const list = childrenOf.get(t.parentTaskId) ?? [];
    list.push(t);
    childrenOf.set(t.parentTaskId, list);
  }

  type Attention = {
    kind: AttentionKind;
    severity: 'high' | 'medium';
    shiftId: string | null;
    department: string;
    period: OpsPeriod;
    storeName: string | null;
    title: string;
    detail: string | null;
    at: string | null;
  };
  const attention: Attention[] = [];
  const shiftName = new Map<string, { department: string; period: OpsPeriod; storeName: string | null }>();

  /* ----- the runs ------------------------------------------------------- */
  const runs = shifts.map((s) => {
    const list = tasksByShift.get(s.id) ?? [];
    const sop = list.filter((t) => t.source === 'SOP');
    const active = s.status === 'ACTIVE';
    const done = active ? sop.filter((t) => t.status === 'DONE').length : s.sopDone;
    const total = active ? sop.length : s.sopTotal;
    const storeName = s.location?.name ?? (soleStore ? stores[0]!.name : null);
    shiftName.set(s.id, { department: s.department, period: s.period, storeName });

    // Blocks: the SOP's timed sections, in the order they fall due.
    const bySection = new Map<string, TaskRow[]>();
    for (const t of sop) {
      if (!t.dueAt) continue;
      const key = `${t.dueAt.toISOString()}|${t.section ?? ''}`;
      bySection.set(key, [...(bySection.get(key) ?? []), t]);
    }
    const blocks = [...bySection.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, items]) => {
        const due = items[0]!.dueAt!;
        const open = items.filter((t) => t.status !== 'DONE');
        const late = items.filter((t) => t.status === 'DONE' && t.completedAt && t.completedAt > due).length;
        const lastDone = items
          .filter((t) => t.completedAt)
          .reduce<Date | null>((m, t) => (!m || t.completedAt! > m ? t.completedAt! : m), null);
        const state: 'done' | 'late' | 'overdue' | 'open' | 'upcoming' =
          open.length === 0
            ? late > 0
              ? 'late'
              : 'done'
            : due <= now
              ? 'overdue'
              : items.some((t) => t.status === 'DONE') || due.getTime() - now.getTime() < 2 * H
                ? 'open'
                : 'upcoming';
        return {
          section: items[0]!.section ?? '',
          dueAt: due.toISOString(),
          total: items.length,
          done: items.length - open.length,
          late,
          state,
          finishedAt: open.length === 0 && lastDone ? lastDone.toISOString() : null,
        };
      });
    const onTimePct = onTime(sop, now);
    const overdueItems = active ? sop.filter((t) => t.status !== 'DONE' && t.dueAt && t.dueAt <= now).length : 0;
    const current = active ? blocks.find((b) => b.state !== 'done' && b.state !== 'late') ?? null : null;
    const finalPhoto = [...sop].reverse().find((t) => t.responseType === 'PHOTO' && t.photos.length > 0);

    // What needs a manager, from this run.
    const base = { shiftId: s.id, department: s.department, period: s.period, storeName };
    if (active) {
      for (const b of blocks.filter((x) => x.state === 'overdue')) {
        attention.push({
          ...base,
          kind: 'OVERDUE',
          severity: SEVERITY.OVERDUE,
          title: `${b.section} — ${b.total - b.done} of ${b.total} not done`,
          detail: null,
          at: b.dueAt,
        });
      }
      if (s.dueAt && s.dueAt <= now) {
        attention.push({
          ...base,
          kind: 'NOT_SUBMITTED',
          severity: SEVERITY.NOT_SUBMITTED,
          title: 'Shift ended — SOP not submitted',
          detail: `${done} of ${total} done · ${personName(s.openedBy)}`,
          at: s.dueAt.toISOString(),
        });
      }
    }
    if (s.status === 'CLOSED' && s.closedIncomplete) {
      attention.push({
        ...base,
        kind: 'INCOMPLETE',
        severity: SEVERITY.INCOMPLETE,
        title: `Submitted incomplete — ${s.sopDone} of ${s.sopTotal} done`,
        detail: s.incompleteReason,
        at: s.closedAt?.toISOString() ?? null,
      });
    }
    for (const t of list) {
      if (t.status === 'BLOCKED') {
        attention.push({
          ...base,
          kind: 'BLOCKED',
          severity: SEVERITY.BLOCKED,
          title: t.title,
          detail: t.blockedReason,
          at: null,
        });
      }
      if (t.source !== 'FOLLOWUP' && (t.answerChoice === 'NO' || t.answerChoice === 'PARTIAL')) {
        const fix = childrenOf.get(t.id)?.[0];
        const equipment = /equipment|refrigeration|cooler|freezer/i.test(t.title) && t.answerChoice === 'NO';
        attention.push({
          ...base,
          kind: equipment ? 'EQUIPMENT' : 'COMPLIANCE',
          severity: equipment ? SEVERITY.EQUIPMENT : SEVERITY.COMPLIANCE,
          title: `${t.title} — ${t.answerChoice === 'NO' ? 'No' : 'Partial'}`,
          detail: fix?.answerText ?? (fix ? (fix.status === 'DONE' ? 'Corrected' : 'Correction open') : null),
          at: t.completedAt?.toISOString() ?? null,
        });
      }
    }

    return {
      id: s.id,
      department: s.department,
      period: s.period,
      windowLabel: s.windowLabel,
      storeName,
      templateName: s.templateName,
      status: s.status,
      runBy: personName(s.openedBy),
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
      dueAt: s.dueAt?.toISOString() ?? null,
      done,
      total,
      overdueItems,
      onTimePct,
      closedIncomplete: s.closedIncomplete,
      incompleteReason: s.incompleteReason,
      summary: s.closingSummary,
      current: current ? { section: current.section, dueAt: current.dueAt, open: current.total - current.done } : null,
      blocks,
      finalPhotoId: finalPhoto?.photos.at(-1)?.id ?? null,
    };
  });

  /* ----- SOPs that should have started and didn't ---------------------- */
  const tzOf = new Map(stores.map((s) => [s.id, s]));
  const expected: Array<{
    department: string;
    period: OpsPeriod;
    storeName: string;
    windowLabel: string;
    templateName: string;
    startsAt: string;
    endsAt: string;
    started: boolean;
  }> = [];
  for (const a of assigned) {
    if (!a.template.active || a.template.retiredAt) continue;
    const w = windows.get(`${a.locationId}|${a.label}`);
    const store = tzOf.get(a.locationId);
    if (!w || !store) continue;
    const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number];
    const start = zonedWallTimeToUtcInstant(y, m, d, w.startMinute, store.timezone);
    const length = (w.endMinute - w.startMinute + 1440) % 1440 || 1440;
    const end = new Date(start.getTime() + length * 60_000);
    const started = shifts.some((s) => s.locationId === a.locationId && s.windowLabel === a.label);
    expected.push({
      department: a.template.department,
      period: a.template.period,
      storeName: store.name,
      windowLabel: a.label,
      templateName: a.template.name,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      started,
    });
    if (!started && start.getTime() + NOT_STARTED_GRACE_MS <= now.getTime()) {
      attention.push({
        kind: 'NOT_STARTED',
        severity: SEVERITY.NOT_STARTED,
        shiftId: null,
        department: a.template.department,
        period: a.template.period,
        storeName: store.name,
        title: end <= now ? `${a.label} — no SOP was run` : `${a.label} — SOP not started`,
        detail: a.template.name,
        at: start.toISOString(),
      });
    }
  }

  /* ----- food safety ---------------------------------------------------- */
  const temps = tasks
    .filter((t) => t.responseType === 'TEMPERATURE' && t.source !== 'FOLLOWUP')
    .map((t) => {
      const owner = shiftName.get(t.opsShiftId)!;
      const recheck = (childrenOf.get(t.id) ?? []).find((c) => c.responseType === 'TEMPERATURE');
      return {
        taskId: t.id,
        shiftId: t.opsShiftId,
        department: owner.department,
        period: owner.period,
        storeName: owner.storeName,
        label: t.tempLabel ?? t.title,
        title: t.title,
        min: num(t.tempMin),
        max: num(t.tempMax),
        value: num(t.answerNumber),
        outOfRange: t.tempOutOfRange,
        at: t.completedAt?.toISOString() ?? null,
        dueAt: t.dueAt?.toISOString() ?? null,
        recheck: recheck
          ? {
              value: num(recheck.answerNumber),
              outOfRange: recheck.tempOutOfRange,
              at: recheck.completedAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  for (const t of temps) {
    if (!t.outOfRange) continue;
    const fixed = t.recheck && t.recheck.value !== null && !t.recheck.outOfRange;
    if (fixed) continue;
    attention.push({
      kind: 'TEMP',
      severity: SEVERITY.TEMP,
      shiftId: t.shiftId,
      department: t.department,
      period: t.period,
      storeName: t.storeName,
      title: `${t.title}: ${t.value}°F — outside ${t.min}–${t.max}°F`,
      detail: t.recheck?.value != null ? `Re-check still out: ${t.recheck.value}°F` : 'Not re-checked yet',
      at: t.at,
    });
  }

  /* ----- production ----------------------------------------------------- */
  const metricMap = new Map<string, { key: string; label: string; unit: string | null; total: number; byDepartment: Record<string, number> }>();
  for (const t of tasks) {
    if (!t.metricKey || t.status !== 'DONE' || t.answerNumber == null) continue;
    const dept = shiftName.get(t.opsShiftId)!.department;
    const row = metricMap.get(t.metricKey) ?? {
      key: t.metricKey,
      label: METRIC_LABEL[t.metricKey] ?? t.metricKey.replace(/_/g, ' '),
      unit: t.unit,
      total: 0,
      byDepartment: {},
    };
    const n = Number(t.answerNumber);
    row.total += n;
    row.byDepartment[dept] = (row.byDepartment[dept] ?? 0) + n;
    metricMap.set(t.metricKey, row);
  }
  const METRIC_ORDER = [
    'pallets_received',
    'cases_stocked',
    'picks_worked',
    'overstock_binned',
    'returns_worked',
    'freight_left',
    'oos_found',
    'claims_processed',
    'items_discarded',
    'items_marked_down',
    'donations_logged',
  ];
  const metrics = [...metricMap.values()].sort(
    (a, b) => (METRIC_ORDER.indexOf(a.key) + 1 || 99) - (METRIC_ORDER.indexOf(b.key) + 1 || 99),
  );

  /* ----- handoffs ------------------------------------------------------- */
  const handoffs = handovers.map((h) => {
    const owner = shiftName.get(h.fromShiftId)!;
    if (h.kind === 'EQUIPMENT' && h.status === 'PENDING') {
      attention.push({
        kind: 'EQUIPMENT',
        severity: SEVERITY.EQUIPMENT,
        shiftId: h.fromShiftId,
        department: owner.department,
        period: owner.period,
        storeName: owner.storeName,
        title: h.body,
        detail: 'Handed over — not picked up yet',
        at: h.createdAt.toISOString(),
      });
    }
    return {
      id: h.id,
      shiftId: h.fromShiftId,
      department: owner.department,
      period: owner.period,
      kind: h.kind,
      body: h.body,
      priority: h.priority,
      status: h.status,
      createdAt: h.createdAt.toISOString(),
      decidedAt: h.decidedAt?.toISOString() ?? null,
      decidedBy: h.decidedBy ? personName(h.decidedBy) : null,
    };
  });

  /* ----- the grid ------------------------------------------------------- */
  const departments = [...new Set([...runs.map((r) => r.department), ...expected.map((e) => e.department)])].sort();
  const periods = PERIOD_ORDER.filter(
    (p) => runs.some((r) => r.period === p) || expected.some((e) => e.period === p),
  );
  const grid = departments.map((department) => ({
    department,
    cells: periods.map((period) => {
      const cellRuns = runs.filter((r) => r.department === department && r.period === period);
      const waiting = expected.filter(
        (e) => e.department === department && e.period === period && !e.started,
      );
      return {
        period,
        runIds: cellRuns.map((r) => r.id),
        expected: waiting.map((e) => ({
          windowLabel: e.windowLabel,
          storeName: e.storeName,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          missed: Date.parse(e.startsAt) + NOT_STARTED_GRACE_MS <= now.getTime(),
        })),
      };
    }),
  }));

  attention.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.at ?? '').localeCompare(b.at ?? ''),
  );

  const sopTotal = runs.reduce((n, r) => n + r.total, 0);
  const sopDone = runs.reduce((n, r) => n + r.done, 0);
  return {
    date: dateKey,
    tz: cal.tz,
    storeToday: cal.key(now),
    summary: {
      sops: runs.length,
      submitted: runs.filter((r) => r.status === 'CLOSED').length,
      running: runs.filter((r) => r.status === 'ACTIVE').length,
      notStarted: expected.filter((e) => !e.started && Date.parse(e.startsAt) + NOT_STARTED_GRACE_MS <= now.getTime())
        .length,
      completionPct: sopTotal ? Math.round((sopDone / sopTotal) * 100) : null,
      onTimePct: onTime(
        tasks.filter((t) => t.source === 'SOP'),
        now,
      ),
      overdueBlocks: runs.reduce((n, r) => n + r.blocks.filter((b) => b.state === 'overdue').length, 0),
      tempChecks: temps.filter((t) => t.value !== null).length,
      tempsDue: temps.filter((t) => t.value === null && t.dueAt && Date.parse(t.dueAt) <= now.getTime()).length,
      tempAlerts: temps.filter((t) => t.outOfRange).length,
      tempOpen: attention.filter((a) => a.kind === 'TEMP').length,
      needsAttention: attention.filter((a) => a.severity === 'high').length,
      photos: tasks.reduce((n, t) => n + t.photos.length, 0),
    },
    periods,
    grid,
    runs,
    attention,
    temps,
    metrics,
    handoffs,
  };
}

/** Of the items that have come due (or were done early), the share done by
 *  their due time — an overdue item counts against it, not just a late one. */
function onTime(items: TaskRow[], now: Date): number | null {
  const due = items.filter((t) => t.dueAt && (t.status === 'DONE' || t.dueAt <= now));
  if (due.length === 0) return null;
  const kept = due.filter((t) => t.status === 'DONE' && t.completedAt && t.completedAt <= t.dueAt!).length;
  return Math.round((kept / due.length) * 100);
}

async function isSoleStore(clientId: string): Promise<boolean> {
  const n = await prisma.location.count({ where: { clientId, deletedAt: null, isActive: true } });
  return n <= 1;
}

/** A photo on an SOP run the scope may see — the final-zone evidence. */
export async function scopedOpsPhoto(scope: PortalScope, photoId: string) {
  const photo = await prisma.opsTaskPhoto.findUnique({
    where: { id: photoId },
    select: {
      s3Key: true,
      mimeType: true,
      task: { select: { opsShift: { select: { clientId: true, locationId: true } } } },
    },
  });
  if (!photo) return null;
  const shift = photo.task.opsShift;
  if (shift.clientId !== scope.clientId) return null;
  if (scope.locationId && shift.locationId !== scope.locationId) {
    if (shift.locationId || !(await isSoleStore(scope.clientId))) return null;
  }
  return photo;
}
