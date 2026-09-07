import type { PrismaClient } from '@prisma/client';
import { orgDateKey, startOfWeekUTC } from './timeAnomalies.js';
import { soonestPayday } from './payday.js';

/**
 * THE RELAY — the one shared operating picture all four rooms stare at.
 *
 * Two instruments, computed from data that already exists:
 *
 *   LANES (the First-Paycheck Promise): every recently approved hire is a
 *   relay lane through the three departments —
 *     Approved (HR) → Scheduled (WFM) → Fieldglass (Finance)
 *       → First shift worked → Hours approved (Field) → First paycheck
 *   Each stage is owned by a desk and has a due date derived from
 *   reality (the first shift, the Tuesday close, the payday). A lane
 *   flowing on time is quiet; a stalled stage names the desk holding it.
 *
 *   BATONS: every cross-department queue as one row — holder desk, count,
 *   age, status. Silence-means-green with teeth: quiet until at risk,
 *   loud when late (the escalation cron rings the holding desk).
 *
 * One computation serves the /relay board, the Monday-pack agenda, and
 * the escalation sweep, so no two rooms ever read different numbers.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type Desk = 'HR' | 'FINANCE' | 'WORKFORCE';
export type BatonStatus = 'quiet' | 'atRisk' | 'overdue';

export interface LaneStage {
  key:
    | 'approved'
    | 'scheduled'
    | 'fieldglass'
    | 'firstShift'
    | 'hoursApproved'
    | 'paycheck';
  desk: Desk;
  done: boolean;
  at: string | null;
  dueAt: string | null;
  overdue: boolean;
}

export interface Lane {
  associateId: string;
  name: string;
  clientName: string | null;
  approvedAt: string;
  stages: LaneStage[];
  /** First not-done stage key, or null when the promise is kept. */
  currentStage: LaneStage['key'] | null;
  stalled: boolean;
  completed: boolean;
  cohortId: string | null;
}

export interface CohortSummary {
  id: string;
  name: string;
  clientName: string | null;
  targetHeadcount: number;
  landByDate: string;
  daysLeft: number;
  members: number;
  completed: number;
  inFlight: number;
  stalled: number;
}

export interface Baton {
  key: string;
  label: string;
  desk: Desk;
  count: number;
  oldestAt: string | null;
  dueOn: string | null;
  status: BatonStatus;
  link: string;
}

export interface AgendaItem {
  severity: 'red' | 'amber' | 'info';
  desk: Desk | null;
  text: string;
  link: string;
}

export interface RelayBoard {
  generatedAt: string;
  promise: {
    /** % of completed lanes whose check landed within 21 days of the
     *  first shift worked — the company's heartbeat metric. */
    keptPct: number | null;
    completed: number;
    medianDays: number | null;
    windowDays: number;
  };
  lanes: Lane[];
  cohorts: CohortSummary[];
  recentKept: Array<{ associateId: string; name: string; days: number; kept: boolean }>;
  batons: Baton[];
  agenda: AgendaItem[];
}

const LANE_WINDOW_DAYS = 45;
const PAYCHECK_PROMISE_DAYS = 21;

export interface LaneInputs {
  approvedAt: Date;
  firstShift: { startsAt: Date; endsAt: Date } | null;
  regAt: Date | null;
  firstEntry: { clockOutAt: Date; status: string } | null;
  paidAt: Date | null;
}

/** The six stages of one first-paycheck lane — shared by the board's
 *  bulk computation and the associate's own "road to your first
 *  paycheck" card, so both always tell the same story. */
export function buildLaneStages(input: LaneInputs, now: Date): LaneStage[] {
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const stages: LaneStage[] = [];
  const stage = (
    key: LaneStage['key'],
    desk: Desk,
    doneAt: Date | null,
    dueAt: Date | null,
  ) => {
    const done = doneAt !== null;
    stages.push({
      key,
      desk,
      done,
      at: iso(doneAt),
      dueAt: iso(dueAt),
      overdue: !done && dueAt !== null && dueAt.getTime() < now.getTime(),
    });
  };
  const { approvedAt, firstShift, regAt, firstEntry, paidAt } = input;
  stage('approved', 'HR', approvedAt, null);
  stage(
    'scheduled',
    'WORKFORCE',
    firstShift ? firstShift.startsAt : null,
    new Date(approvedAt.getTime() + 5 * DAY_MS),
  );
  stage(
    'fieldglass',
    'FINANCE',
    regAt,
    firstShift ? firstShift.startsAt : new Date(approvedAt.getTime() + 7 * DAY_MS),
  );
  stage(
    'firstShift',
    'WORKFORCE',
    firstEntry ? firstEntry.clockOutAt : null,
    firstShift ? firstShift.endsAt : null,
  );
  stage(
    'hoursApproved',
    'WORKFORCE',
    firstEntry && firstEntry.status === 'APPROVED' ? firstEntry.clockOutAt : null,
    firstEntry ? closeAfter(firstEntry.clockOutAt) : null,
  );
  stage(
    'paycheck',
    'FINANCE',
    paidAt,
    firstEntry
      ? new Date(firstEntry.clockOutAt.getTime() + PAYCHECK_PROMISE_DAYS * DAY_MS)
      : null,
  );
  return stages;
}

/** One associate's lane — the "road to your first paycheck" the new hire
 *  sees on their own dashboard. Null when they have no recent approval. */
export async function computeSingleLane(
  prisma: PrismaClient,
  associateId: string,
  now: Date = new Date(),
): Promise<{
  stages: LaneStage[];
  currentStage: LaneStage['key'] | null;
  completed: boolean;
  approvedAt: string;
} | null> {
  const app = await prisma.application.findFirst({
    where: {
      associateId,
      status: 'APPROVED',
      approvedAt: { gte: new Date(now.getTime() - 90 * DAY_MS) },
      deletedAt: null,
    },
    orderBy: { approvedAt: 'desc' },
    select: { approvedAt: true },
  });
  if (!app?.approvedAt) return null;
  const [firstShift, reg, firstEntry, paid] = await Promise.all([
    prisma.shift.findFirst({
      where: { assignedAssociateId: associateId, status: { in: ['ASSIGNED', 'COMPLETED'] } },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true, endsAt: true },
    }),
    prisma.fieldglassRegistration.findUnique({
      where: { associateId },
      select: { addedAt: true },
    }),
    prisma.timeEntry.findFirst({
      where: { associateId, clockOutAt: { not: null } },
      orderBy: { clockInAt: 'asc' },
      select: { clockOutAt: true, status: true },
    }),
    prisma.payrollItem.findFirst({
      where: { associateId, payrollRun: { status: 'DISBURSED' } },
      orderBy: { payrollRun: { periodEnd: 'asc' } },
      select: { payrollRun: { select: { updatedAt: true } } },
    }),
  ]);
  const stages = buildLaneStages(
    {
      approvedAt: app.approvedAt,
      firstShift,
      regAt: reg?.addedAt ?? null,
      firstEntry: firstEntry
        ? { clockOutAt: firstEntry.clockOutAt!, status: firstEntry.status }
        : null,
      paidAt: paid?.payrollRun.updatedAt ?? null,
    },
    now,
  );
  const current = stages.find((s) => !s.done) ?? null;
  return {
    stages,
    currentStage: current?.key ?? null,
    completed: current === null,
    approvedAt: app.approvedAt.toISOString(),
  };
}

/** Next Tuesday (org-local) strictly after `d` — the hours-approval close
 *  that covers work done on day `d`. */
function closeAfter(d: Date): Date {
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(d.getTime() + i * DAY_MS);
    const weekday = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: 'America/New_York',
    }).format(candidate);
    if (weekday === 'Tue') return candidate;
  }
  return new Date(d.getTime() + 7 * DAY_MS);
}

export async function computeRelayBoard(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<RelayBoard> {
  const windowStart = new Date(now.getTime() - LANE_WINDOW_DAYS * DAY_MS);

  /* ---- LANES ------------------------------------------------------- */

  const apps = await prisma.application.findMany({
    where: {
      status: 'APPROVED',
      approvedAt: { gte: windowStart },
      deletedAt: null,
      associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
    },
    orderBy: { approvedAt: 'desc' },
    take: 80,
    select: {
      associateId: true,
      approvedAt: true,
      cohortId: true,
      client: { select: { name: true } },
      associate: { select: { firstName: true, lastName: true } },
    },
  });
  // One lane per associate — the latest approval wins.
  const laneSeeds = new Map<string, (typeof apps)[number]>();
  for (const a of apps) {
    if (!laneSeeds.has(a.associateId)) laneSeeds.set(a.associateId, a);
  }
  const laneIds = [...laneSeeds.keys()];

  const [laneShifts, laneRegs, laneEntries, lanePaid] =
    laneIds.length > 0
      ? await Promise.all([
          prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: laneIds },
              status: { in: ['ASSIGNED', 'COMPLETED'] },
            },
            orderBy: { startsAt: 'asc' },
            select: { assignedAssociateId: true, startsAt: true, endsAt: true },
            take: 2000,
          }),
          prisma.fieldglassRegistration.findMany({
            where: { associateId: { in: laneIds } },
            select: { associateId: true, addedAt: true },
          }),
          prisma.timeEntry.findMany({
            where: { associateId: { in: laneIds }, clockOutAt: { not: null } },
            orderBy: { clockInAt: 'asc' },
            select: { associateId: true, clockOutAt: true, status: true },
            take: 2000,
          }),
          prisma.payrollItem.findMany({
            where: {
              associateId: { in: laneIds },
              payrollRun: { status: 'DISBURSED' },
            },
            orderBy: { payrollRun: { periodEnd: 'asc' } },
            select: {
              associateId: true,
              payrollRun: { select: { updatedAt: true } },
            },
            take: 2000,
          }),
        ])
      : [[], [], [], []];

  const firstShiftBy = new Map<string, { startsAt: Date; endsAt: Date }>();
  for (const s of laneShifts) {
    if (s.assignedAssociateId && !firstShiftBy.has(s.assignedAssociateId)) {
      firstShiftBy.set(s.assignedAssociateId, { startsAt: s.startsAt, endsAt: s.endsAt });
    }
  }
  const regBy = new Map(laneRegs.map((r) => [r.associateId, r.addedAt]));
  const firstEntryBy = new Map<string, { clockOutAt: Date; status: string }>();
  for (const e of laneEntries) {
    if (!firstEntryBy.has(e.associateId)) {
      firstEntryBy.set(e.associateId, { clockOutAt: e.clockOutAt!, status: e.status });
    }
  }
  const paidBy = new Map<string, Date>();
  for (const p of lanePaid) {
    if (!paidBy.has(p.associateId)) paidBy.set(p.associateId, p.payrollRun.updatedAt);
  }

  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  const lanes: Lane[] = [];
  const keptSamples: Array<{ associateId: string; name: string; days: number; kept: boolean }> =
    [];
  const cohortCompletedIn45d = new Map<string, number>();

  for (const [associateId, seed] of laneSeeds) {
    const approvedAt = seed.approvedAt ?? windowStart;
    const name = `${seed.associate.firstName} ${seed.associate.lastName}`.trim();
    const firstShift = firstShiftBy.get(associateId) ?? null;
    const regAt = regBy.get(associateId) ?? null;
    const firstEntry = firstEntryBy.get(associateId) ?? null;
    const paidAt = paidBy.get(associateId) ?? null;

    const stages = buildLaneStages(
      { approvedAt, firstShift, regAt, firstEntry, paidAt },
      now,
    );
    const current = stages.find((s) => !s.done) ?? null;
    const completed = current === null;
    const lane: Lane = {
      associateId,
      name,
      clientName: seed.client?.name ?? null,
      approvedAt: approvedAt.toISOString(),
      stages,
      currentStage: current?.key ?? null,
      stalled: current !== null && current.overdue,
      completed,
      cohortId: seed.cohortId ?? null,
    };
    if (completed && seed.cohortId) {
      cohortCompletedIn45d.set(
        seed.cohortId,
        (cohortCompletedIn45d.get(seed.cohortId) ?? 0) + 1,
      );
    }
    if (completed && paidAt && firstEntry) {
      keptSamples.push({
        associateId,
        name,
        days: Math.max(
          0,
          Math.round((paidAt.getTime() - approvedAt.getTime()) / DAY_MS),
        ),
        kept:
          paidAt.getTime() <=
          firstEntry.clockOutAt.getTime() + PAYCHECK_PROMISE_DAYS * DAY_MS,
      });
    } else {
      lanes.push(lane);
    }
  }
  // Stalled lanes first, then oldest approval first — the board reads
  // top-down as "what needs a phone call that we're replacing".
  lanes.sort((a, b) => {
    if (a.stalled !== b.stalled) return a.stalled ? -1 : 1;
    return new Date(a.approvedAt).getTime() - new Date(b.approvedAt).getTime();
  });

  const keptCount = keptSamples.filter((k) => k.kept).length;
  const sortedDays = keptSamples.map((k) => k.days).sort((a, b) => a - b);
  const medianDays =
    sortedDays.length > 0 ? sortedDays[Math.floor(sortedDays.length / 2)]! : null;

  // Cohort mode: every active wave with its readiness against the clock.
  // In-flight/stalled/completed counts come from this board's window —
  // waves are near-term by nature, so the 45-day window covers them.
  const activeCohorts = await prisma.cohort.findMany({
    where: { archivedAt: null },
    orderBy: { landByDate: 'asc' },
    take: 12,
    select: {
      id: true,
      name: true,
      targetHeadcount: true,
      landByDate: true,
      client: { select: { name: true } },
      _count: { select: { applications: true } },
    },
  });
  const cohorts: CohortSummary[] = activeCohorts.map((c) => {
    const inLanes = lanes.filter((l) => l.cohortId === c.id);
    return {
      id: c.id,
      name: c.name,
      clientName: c.client?.name ?? null,
      targetHeadcount: c.targetHeadcount,
      landByDate: c.landByDate.toISOString().slice(0, 10),
      daysLeft: Math.ceil((c.landByDate.getTime() - now.getTime()) / DAY_MS),
      members: c._count.applications,
      completed: cohortCompletedIn45d.get(c.id) ?? 0,
      inFlight: inLanes.length,
      stalled: inLanes.filter((l) => l.stalled).length,
    };
  });

  /* ---- BATONS ------------------------------------------------------ */

  const weekStart = startOfWeekUTC(now);
  const CASE_OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] as const;

  const [closeOutCount, transferRegs, addCandidates, pendingEntries, settleRows, payrollCaseOld, hrCaseOld, incidentOld, payrollCasesOpen, hrCasesOpen, incidentsOpen, settleAggCount] =
    await Promise.all([
      prisma.fieldglassRegistration.count({
        where: {
          associate: {
            OR: [{ separatedAt: { not: null } }, { deletedAt: { not: null } }],
          },
        },
      }),
      prisma.fieldglassRegistration.findMany({
        where: {
          clientId: { not: null },
          associate: { deletedAt: null, separatedAt: null },
        },
        select: {
          clientId: true,
          associate: {
            select: {
              assignments: {
                where: { endedAt: null },
                orderBy: { startedAt: 'desc' },
                take: 1,
                select: { location: { select: { clientId: true } } },
              },
            },
          },
        },
        take: 500,
      }),
      prisma.application.findMany({
        where: {
          status: 'APPROVED',
          approvedAt: { gte: new Date(now.getTime() - 60 * DAY_MS) },
          deletedAt: null,
          associate: {
            deletedAt: null,
            separatedAt: null,
            deactivatedAt: null,
            fieldglassRegistration: { is: null },
          },
        },
        select: { associateId: true, approvedAt: true },
        take: 200,
      }),
      prisma.timeEntry.findMany({
        where: { status: 'COMPLETED', clockOutAt: { not: null } },
        orderBy: { clockInAt: 'asc' },
        select: { clockInAt: true },
        take: 1,
      }),
      prisma.reimbursement.findFirst({
        where: { status: 'MANAGER_APPROVED' },
        orderBy: { managerApprovedAt: 'asc' },
        select: { managerApprovedAt: true },
      }),
      prisma.hrCase.findFirst({
        where: { category: 'PAYROLL', status: { in: [...CASE_OPEN] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.hrCase.findFirst({
        where: { category: { not: 'PAYROLL' }, status: { in: [...CASE_OPEN] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.oshaIncident.findFirst({
        where: { status: { not: 'RESOLVED' } },
        orderBy: { reportedAt: 'asc' },
        select: { reportedAt: true },
      }),
      prisma.hrCase.count({
        where: { category: 'PAYROLL', status: { in: [...CASE_OPEN] } },
      }),
      prisma.hrCase.count({
        where: { category: { not: 'PAYROLL' }, status: { in: [...CASE_OPEN] } },
      }),
      prisma.oshaIncident.count({ where: { status: { not: 'RESOLVED' } } }),
      prisma.reimbursement.count({ where: { status: 'MANAGER_APPROVED' } }),
    ]);

  const pendingCount = await prisma.timeEntry.count({
    where: { status: 'COMPLETED', clockOutAt: { not: null } },
  });

  const candidateIds = [...new Set(addCandidates.map((a) => a.associateId))];
  const [everScheduled, upcomingScheduled] =
    candidateIds.length > 0
      ? await Promise.all([
          prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: candidateIds },
              status: { in: ['ASSIGNED', 'COMPLETED'] },
            },
            distinct: ['assignedAssociateId'],
            select: { assignedAssociateId: true },
          }),
          prisma.shift.findMany({
            where: {
              assignedAssociateId: { in: candidateIds },
              status: 'ASSIGNED',
              startsAt: { gte: now },
            },
            orderBy: { startsAt: 'asc' },
            select: { assignedAssociateId: true, startsAt: true },
            take: 500,
          }),
        ])
      : [[], []];
  const everSet = new Set(everScheduled.map((s) => s.assignedAssociateId));
  const upcomingBy = new Map<string, Date>();
  for (const s of upcomingScheduled) {
    if (s.assignedAssociateId && !upcomingBy.has(s.assignedAssociateId)) {
      upcomingBy.set(s.assignedAssociateId, s.startsAt);
    }
  }
  const addIds = candidateIds.filter((id) => everSet.has(id));
  const addSoonest = addIds
    .map((id) => upcomingBy.get(id))
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  // Ready-to-schedule = approved, no UPCOMING shift at all.
  const readyIds = [
    ...new Set(
      addCandidates
        .filter((a) => !upcomingBy.has(a.associateId))
        .map((a) => a.associateId),
    ),
  ];
  const readyOldest = addCandidates
    .filter((a) => readyIds.includes(a.associateId) && a.approvedAt)
    .map((a) => a.approvedAt!)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  const transfers = transferRegs.filter((r) => {
    const cur = r.associate.assignments[0]?.location.clientId;
    return cur !== undefined && cur !== r.clientId;
  }).length;

  const ageDays = (d: Date | null | undefined) =>
    d ? (now.getTime() - d.getTime()) / DAY_MS : null;

  const batons: Baton[] = [];
  const baton = (
    key: string,
    label: string,
    desk: Desk,
    count: number,
    oldestAt: Date | null,
    dueOn: Date | null,
    status: BatonStatus,
    link: string,
  ) =>
    batons.push({
      key,
      label,
      desk,
      count,
      oldestAt: iso(oldestAt),
      dueOn: dueOn ? orgDateKey(dueOn) : null,
      status: count === 0 ? 'quiet' : status,
      link,
    });

  baton(
    'fieldglass-close',
    'Fieldglass close-outs',
    'FINANCE',
    closeOutCount,
    null,
    null,
    'overdue', // a dead account is late the moment it exists
    '/',
  );
  baton(
    'fieldglass-transfer',
    'Fieldglass transfers',
    'FINANCE',
    transfers,
    null,
    null,
    'atRisk',
    '/',
  );
  baton(
    'fieldglass-add',
    'Fieldglass adds',
    'FINANCE',
    addIds.length,
    null,
    addSoonest ?? null,
    addSoonest && addSoonest.getTime() < now.getTime() + 48 * HOUR_MS
      ? addSoonest.getTime() < now.getTime()
        ? 'overdue'
        : 'atRisk'
      : 'quiet',
    '/',
  );
  {
    const age = ageDays(readyOldest ?? null);
    baton(
      'ready-to-schedule',
      'Approved, awaiting first shift',
      'WORKFORCE',
      readyIds.length,
      readyOldest ?? null,
      readyOldest ? new Date(readyOldest.getTime() + 5 * DAY_MS) : null,
      age !== null && age > 5 ? 'overdue' : age !== null && age > 2 ? 'atRisk' : 'quiet',
      '/scheduling',
    );
  }
  {
    const oldest = pendingEntries[0]?.clockInAt ?? null;
    baton(
      'timesheets',
      'Timesheets awaiting approval',
      'WORKFORCE',
      pendingCount,
      oldest,
      closeAfter(now),
      oldest && oldest.getTime() < weekStart.getTime() ? 'overdue' : 'atRisk',
      '/time-attendance',
    );
  }
  {
    const age = ageDays(settleRows?.managerApprovedAt ?? null);
    baton(
      'settlements',
      'Reimbursements to settle',
      'FINANCE',
      settleAggCount,
      settleRows?.managerApprovedAt ?? null,
      null,
      age !== null && age > 14 ? 'overdue' : age !== null && age > 7 ? 'atRisk' : 'quiet',
      '/reimbursements',
    );
  }
  {
    const age = ageDays(payrollCaseOld?.createdAt ?? null);
    baton(
      'payroll-cases',
      'Payroll cases open',
      'FINANCE',
      payrollCasesOpen,
      payrollCaseOld?.createdAt ?? null,
      null,
      age !== null && age > 7 ? 'overdue' : age !== null && age > 3 ? 'atRisk' : 'quiet',
      '/hr-cases',
    );
  }
  {
    const age = ageDays(hrCaseOld?.createdAt ?? null);
    baton(
      'hr-cases',
      'HR cases open',
      'HR',
      hrCasesOpen,
      hrCaseOld?.createdAt ?? null,
      null,
      age !== null && age > 7 ? 'overdue' : age !== null && age > 3 ? 'atRisk' : 'quiet',
      '/hr-cases',
    );
  }
  {
    const age = ageDays(incidentOld?.reportedAt ?? null);
    baton(
      'incidents',
      'Safety incidents to review',
      'HR',
      incidentsOpen,
      incidentOld?.reportedAt ?? null,
      null,
      age !== null && age > 5 ? 'overdue' : age !== null && age > 2 ? 'atRisk' : 'quiet',
      '/compliance/osha',
    );
  }

  // The client in the loop: their open requests are batons like any
  // other — except the person waiting is the customer.
  const openRequests = await prisma.clientRequest.findMany({
    where: { status: { not: 'RESOLVED' } },
    orderBy: { createdAt: 'asc' },
    select: { kind: true, createdAt: true },
    take: 200,
  });
  const staffingReqs = openRequests.filter((r) => r.kind === 'STAFFING');
  const hrReqs = openRequests.filter((r) => r.kind !== 'STAFFING');
  const reqStatus = (rows: typeof openRequests): BatonStatus => {
    const age = ageDays(rows[0]?.createdAt ?? null);
    return age !== null && age > 2 ? 'overdue' : 'atRisk';
  };
  baton(
    'client-requests',
    'Client requests — staffing',
    'WORKFORCE',
    staffingReqs.length,
    staffingReqs[0]?.createdAt ?? null,
    null,
    reqStatus(staffingReqs),
    '/relay#client-requests',
  );
  baton(
    'client-requests-hr',
    'Client requests — feedback & issues',
    'HR',
    hrReqs.length,
    hrReqs[0]?.createdAt ?? null,
    null,
    reqStatus(hrReqs),
    '/relay#client-requests',
  );

  // Decisions with receipts: a pending ruling is a baton on that desk.
  const pendingDecisions = await prisma.workNote.findMany({
    where: { decisionStatus: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { decisionDesk: true, createdAt: true },
    take: 200,
  });
  for (const desk of ['FINANCE', 'HR', 'WORKFORCE'] as const) {
    const rows = pendingDecisions.filter((d) => d.decisionDesk === desk);
    const age = ageDays(rows[0]?.createdAt ?? null);
    baton(
      `decisions-${desk.toLowerCase()}`,
      `Decisions awaiting ${DESK_LABELS[desk]}`,
      desk,
      rows.length,
      rows[0]?.createdAt ?? null,
      null,
      age !== null && age > 3 ? 'overdue' : age !== null && age > 1 ? 'atRisk' : 'quiet',
      '/relay#decisions',
    );
  }

  const RANK: Record<BatonStatus, number> = { overdue: 0, atRisk: 1, quiet: 2 };
  batons.sort((a, b) => RANK[a.status] - RANK[b.status] || b.count - a.count);

  /* ---- AGENDA (the Monday pack writes itself) ----------------------- */

  const agenda: AgendaItem[] = [];
  const stalledLanes = lanes.filter((l) => l.stalled);
  if (stalledLanes.length > 0) {
    const worst = stalledLanes[0]!;
    const stage = worst.stages.find((s) => s.key === worst.currentStage)!;
    agenda.push({
      severity: 'red',
      desk: stage.desk,
      text: `${stalledLanes.length} first-paycheck lane${stalledLanes.length === 1 ? ' is' : 's are'} stalled past due — worst: ${worst.name} at "${STAGE_LABELS[stage.key]}" (${DESK_LABELS[stage.desk]}'s desk).`,
      link: '/relay',
    });
  }
  for (const b of batons.filter((x) => x.status === 'overdue')) {
    agenda.push({
      severity: 'red',
      desk: b.desk,
      text: `${b.label}: ${b.count} overdue on ${DESK_LABELS[b.desk]}'s desk${b.oldestAt ? ` (oldest ${Math.floor(ageDays(new Date(b.oldestAt))!)}d)` : ''}.`,
      link: b.link,
    });
  }
  for (const c of cohorts) {
    if (c.daysLeft <= 14 && c.completed < c.targetHeadcount) {
      agenda.push({
        severity: c.stalled > 0 || c.daysLeft <= 7 ? 'red' : 'amber',
        desk: 'WORKFORCE',
        text: `Cohort "${c.name}": ${c.completed}/${c.targetHeadcount} ready, ${Math.max(0, c.daysLeft)} day${c.daysLeft === 1 ? '' : 's'} to landing${c.stalled > 0 ? ` — ${c.stalled} lane${c.stalled === 1 ? '' : 's'} stalled` : ''}.`,
        link: '/relay',
      });
    }
  }
  const openThisWeek = await prisma.shift.count({
    where: {
      publishedAt: { not: null },
      status: 'OPEN',
      startsAt: { gte: now, lt: new Date(weekStart.getTime() + 7 * DAY_MS) },
    },
  });
  if (openThisWeek > 0) {
    agenda.push({
      severity: 'amber',
      desk: 'WORKFORCE',
      text: `${openThisWeek} open shift${openThisWeek === 1 ? '' : 's'} still unfilled this week.`,
      link: '/scheduling',
    });
  }
  const payday = await soonestPayday(prisma, now);
  if (payday) {
    agenda.push({
      severity: pendingCount > 0 ? 'amber' : 'info',
      desk: pendingCount > 0 ? 'WORKFORCE' : 'FINANCE',
      text:
        `Payday ${orgDateKey(new Date(payday.date))}` +
        (pendingCount > 0
          ? ` — ${pendingCount} timesheet${pendingCount === 1 ? '' : 's'} still unapproved ahead of the close.`
          : ' — the close is clear.'),
      link: '/time-attendance',
    });
  }
  if (keptSamples.length > 0) {
    agenda.push({
      severity: 'info',
      desk: null,
      text: `First-paycheck promise: ${Math.round((keptCount / keptSamples.length) * 100)}% kept over the last ${LANE_WINDOW_DAYS} days (${keptSamples.length} completed, median ${medianDays} days).`,
      link: '/relay',
    });
  }
  const SEV: Record<AgendaItem['severity'], number> = { red: 0, amber: 1, info: 2 };
  agenda.sort((a, b) => SEV[a.severity] - SEV[b.severity]);

  return {
    generatedAt: now.toISOString(),
    promise: {
      keptPct:
        keptSamples.length > 0
          ? Math.round((keptCount / keptSamples.length) * 100)
          : null,
      completed: keptSamples.length,
      medianDays,
      windowDays: LANE_WINDOW_DAYS,
    },
    lanes: lanes.slice(0, 16),
    cohorts,
    recentKept: keptSamples.slice(0, 5),
    batons,
    agenda,
  };
}

export const STAGE_LABELS: Record<LaneStage['key'], string> = {
  approved: 'Approved',
  scheduled: 'Scheduled',
  fieldglass: 'Fieldglass',
  firstShift: 'First shift worked',
  hoursApproved: 'Hours approved',
  paycheck: 'First paycheck',
};

export const DESK_LABELS: Record<Desk, string> = {
  HR: 'HR',
  FINANCE: 'Finance',
  WORKFORCE: 'Workforce',
};
