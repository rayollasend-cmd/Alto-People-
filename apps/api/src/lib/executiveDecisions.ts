// The chairman's decision queue — a rule engine over live data, covering
// the three verbs of the job:
//   RUN     — payroll risk, supervisor gaps, associates stuck in pause,
//             compliance documents about to block workers
//   DEVELOP — candidates stalling in review, bench sitting idle,
//             the J-1 replacement-wave trigger
//   MOVE    — receivables to chase, statements idle, prospects to close
//             or rescue, targets unset / pace failing
//
// Every decision has a STABLE KEY (kind + entity) so human actions
// persist across regeneration: DISMISSED hides it until the stakes grow
// materially (1.25×) past what was dismissed; SNOOZED hides until the
// date; DELEGATED keeps it visible (bottom section) until the condition
// resolves — at which point the generator stops emitting it and it
// disappears on its own. Items ranked by severity then stakes; anything
// waiting 14+ days escalates one severity band.

import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { profilePhotoUrlFor } from './profilePhotoUrl.js';
import { startOfWeekUTC } from './timeAnomalies.js';

const DAY_MS = 24 * 3600_000;

export type DecisionSeverity = 'critical' | 'high' | 'normal';
export type DecisionCategory = 'run' | 'develop' | 'move';
export type DecisionStatus = 'open' | 'delegated';

export interface ExecutiveDecision {
  key: string;
  category: DecisionCategory;
  severity: DecisionSeverity;
  label: string;
  detail: string;
  /** Dollars at stake, when the decision has a price tag. */
  stakes: number | null;
  /** How long this has been waiting, in days (null when not meaningful). */
  ageDays: number | null;
  linkUrl: string;
  status: DecisionStatus;
  /** Days since delegation, when status = delegated. */
  delegatedDays: number | null;
  /** Whoever in the org has TAKEN this item in the shared collaboration
   *  layer (keys are unified with the role queues) — the chairman sees
   *  "Maria is on it" without asking. */
  claimedBy: { id: string; name: string; photoUrl: string | null } | null;
}

const SEVERITY_RANK: Record<DecisionSeverity, number> = {
  critical: 0,
  high: 1,
  normal: 2,
};

function escalate(s: DecisionSeverity): DecisionSeverity {
  return s === 'normal' ? 'high' : 'critical';
}

const statementTotal = (snapshot: unknown): number => {
  const t = (snapshot as { totals?: { amount?: number } } | null)?.totals?.amount;
  return typeof t === 'number' ? t : 0;
};

/** Generate the raw catalog (no human-state overlay). */
async function generateRaw(
  prisma: PrismaClient,
  now: Date,
): Promise<Omit<ExecutiveDecision, 'status' | 'delegatedDays' | 'claimedBy'>[]> {
  const out: Omit<ExecutiveDecision, 'status' | 'delegatedDays' | 'claimedBy'>[] = [];
  const thisWeekStart = startOfWeekUTC(now);
  const quarterKey = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;

  const [
    overdue,
    staleDrafts,
    verbal,
    staleProposals,
    target,
    unapprovedPunches,
    clientsWithWork,
    supervisors,
    pausedLong,
    expiringDocs,
    stuckApps,
    benchIdle,
    j1Active,
    j1Docs,
  ] = await Promise.all([
    prisma.clientStatement.findMany({
      where: {
        status: 'FINAL',
        paidAt: null,
        finalizedAt: { lt: new Date(now.getTime() - 45 * DAY_MS) },
      },
      select: {
        id: true,
        number: true,
        finalizedAt: true,
        snapshot: true,
        client: { select: { name: true } },
      },
      take: 20,
    }),
    prisma.clientStatement.findMany({
      where: { status: 'DRAFT', updatedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } },
      select: { snapshot: true, updatedAt: true },
      take: 50,
    }),
    prisma.clientProspect.findMany({
      where: { deletedAt: null, stage: 'VERBAL' },
      select: { id: true, name: true, estWeeklyHours: true, estBillRate: true, updatedAt: true },
      take: 10,
    }),
    prisma.clientProspect.findMany({
      where: {
        deletedAt: null,
        stage: 'PROPOSAL',
        updatedAt: { lt: new Date(now.getTime() - 10 * DAY_MS) },
      },
      select: { id: true, name: true, updatedAt: true },
      take: 10,
    }),
    prisma.execTarget.findUnique({
      where: { quarter: quarterKey },
      select: { marginTarget: true },
    }),
    prisma.timeEntry.count({
      where: { status: 'COMPLETED', clockInAt: { lt: thisWeekStart } },
    }),
    prisma.associateAssignment.findMany({
      where: { endedAt: null },
      select: { location: { select: { clientId: true, client: { select: { name: true } } } } },
      take: 5_000,
    }),
    prisma.user.findMany({
      where: { role: 'SHIFT_SUPERVISOR', status: 'ACTIVE', deletedAt: null },
      select: { clientId: true },
    }),
    prisma.associate.findMany({
      where: {
        deletedAt: null,
        deactivatedAt: { lt: new Date(now.getTime() - 42 * DAY_MS) },
      },
      select: { id: true, firstName: true, lastName: true, deactivatedAt: true },
      take: 10,
    }),
    prisma.documentRecord.findMany({
      where: {
        deletedAt: null,
        kind: { in: ['ID', 'I9_SUPPORTING', 'J1_VISA', 'J1_DS2019'] },
        expiresAt: { gte: now, lt: new Date(now.getTime() + 30 * DAY_MS) },
        associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
      },
      select: { kind: true, associateId: true },
      take: 500,
    }),
    prisma.application.count({
      where: {
        deletedAt: null,
        status: { in: ['SUBMITTED', 'IN_REVIEW'] },
        updatedAt: { lt: new Date(now.getTime() - 5 * DAY_MS) },
      },
    }),
    prisma.associate.count({
      where: {
        deletedAt: null,
        erasedAt: null,
        separatedAt: null,
        deactivatedAt: null,
        assignments: { none: { endedAt: null } },
        applications: {
          some: {
            status: 'APPROVED',
            deletedAt: null,
            approvedAt: { lt: new Date(now.getTime() - 14 * DAY_MS) },
          },
        },
      },
    }),
    prisma.associate.count({
      where: { deletedAt: null, separatedAt: null, deactivatedAt: null, j1Status: true },
    }),
    prisma.documentRecord.findMany({
      where: {
        deletedAt: null,
        kind: { in: ['J1_VISA', 'J1_DS2019'] },
        expiresAt: { gte: now, lt: new Date(now.getTime() + 60 * DAY_MS) },
        associate: { deletedAt: null, separatedAt: null, deactivatedAt: null },
      },
      select: { associateId: true, expiresAt: true },
      take: 1_000,
    }),
  ]);

  /* ----- MOVE ----------------------------------------------------------- */
  for (const s of overdue) {
    const days = s.finalizedAt
      ? Math.floor((now.getTime() - s.finalizedAt.getTime()) / DAY_MS)
      : 0;
    const amount = statementTotal(s.snapshot);
    out.push({
      key: `receivable:${s.id}`,
      category: 'move',
      severity: days >= 60 || amount >= 5_000 ? 'critical' : 'high',
      label: `Chase ${s.client.name} statement #${s.number ?? '—'}`,
      detail: `${days} days unpaid. Payroll goes out weekly; this cash hasn't come in.`,
      stakes: amount || null,
      ageDays: days,
      linkUrl: '/clients',
    });
  }
  if (staleDrafts.length > 0) {
    const total = staleDrafts.reduce((n, d) => n + statementTotal(d.snapshot), 0);
    const oldest = Math.max(
      ...staleDrafts.map((d) => Math.floor((now.getTime() - d.updatedAt.getTime()) / DAY_MS)),
    );
    out.push({
      key: 'statements:stale-drafts',
      category: 'move',
      severity: 'normal',
      label: `${staleDrafts.length} draft statement${staleDrafts.length === 1 ? '' : 's'} idle over a week`,
      detail: 'Unfinalized drafts are unbilled revenue — have payroll finalize or discard.',
      stakes: total || null,
      ageDays: oldest,
      linkUrl: '/clients',
    });
  }
  for (const p of verbal) {
    const weekly =
      p.estWeeklyHours && p.estBillRate ? p.estWeeklyHours * Number(p.estBillRate) : null;
    out.push({
      key: `prospect:verbal:${p.id}`,
      category: 'move',
      severity: 'high',
      label: `${p.name} is at verbal — close it`,
      detail: 'A verbal yes decays fast. Worth the closing call this week.',
      stakes: weekly ? weekly * 4 : null,
      ageDays: Math.floor((now.getTime() - p.updatedAt.getTime()) / DAY_MS),
      linkUrl: '/clients',
    });
  }
  for (const p of staleProposals) {
    out.push({
      key: `prospect:proposal:${p.id}`,
      category: 'move',
      severity: 'normal',
      label: `${p.name} proposal has gone quiet`,
      detail: `No movement in ${Math.floor((now.getTime() - p.updatedAt.getTime()) / DAY_MS)} days — follow up or mark it lost.`,
      stakes: null,
      ageDays: Math.floor((now.getTime() - p.updatedAt.getTime()) / DAY_MS),
      linkUrl: '/clients',
    });
  }
  if (!target) {
    out.push({
      key: `targets:unset:${quarterKey}`,
      category: 'move',
      severity: 'normal',
      label: 'No targets set for this quarter',
      detail: 'Have an administrator set revenue/margin/turnover targets so pace tracking works.',
      stakes: null,
      ageDays: null,
      linkUrl: '/',
    });
  } else if (target.marginTarget) {
    // Pace check against last complete org week at standard rates.
    const lastWeekStart = startOfWeekUTC(new Date(thisWeekStart.getTime() - 36 * 3600_000));
    const entries = await prisma.timeEntry.findMany({
      where: {
        status: { in: ['APPROVED', 'COMPLETED'] },
        clockInAt: { gte: lastWeekStart, lt: thisWeekStart },
      },
      select: {
        associateId: true,
        clockInAt: true,
        clockOutAt: true,
        breaks: { select: { startedAt: true, endedAt: true } },
      },
      take: 20_000,
    });
    const perAssoc = new Map<string, number>();
    for (const e of entries) {
      if (!e.clockOutAt) continue;
      let ms = e.clockOutAt.getTime() - e.clockInAt.getTime();
      for (const b of e.breaks) {
        const bEnd = b.endedAt ? b.endedAt.getTime() : e.clockOutAt.getTime();
        ms -= Math.max(0, bEnd - b.startedAt.getTime());
      }
      perAssoc.set(
        e.associateId,
        (perAssoc.get(e.associateId) ?? 0) + Math.max(0, Math.round(ms / 60_000)),
      );
    }
    let workedMin = 0;
    let otMin = 0;
    for (const m of perAssoc.values()) {
      workedMin += m;
      otMin += Math.max(0, m - 2_400);
    }
    const hours = workedMin / 60;
    const otHours = otMin / 60;
    const billed = hours * env.DEFAULT_ASSOCIATE_BILL_RATE + otHours * env.DEFAULT_ASSOCIATE_BILL_RATE * 0.5;
    const cost =
      (hours * env.DEFAULT_ASSOCIATE_PAY_RATE + otHours * env.DEFAULT_ASSOCIATE_PAY_RATE * 0.5) *
        (1 + env.LABOR_BURDEN_PERCENT / 100) +
      hours * env.LABOR_OVERHEAD_PER_HOUR;
    const margin = billed - cost;
    const weeklyPace = Number(target.marginTarget) / 13;
    if (weeklyPace > 0 && margin < weeklyPace * 0.85) {
      out.push({
        key: `targets:pace:${quarterKey}`,
        category: 'move',
        severity: 'high',
        label: 'Margin is running behind the quarter target',
        detail: `Last week's est. margin ($${margin.toFixed(0)}) is under 85% of the $${weeklyPace.toFixed(0)}/week the target implies. Intervene or re-forecast.`,
        stakes: Math.round((weeklyPace - margin) * 100) / 100,
        ageDays: null,
        linkUrl: '/',
      });
    }
  }

  /* ----- RUN ------------------------------------------------------------- */
  if (unapprovedPunches >= 25) {
    out.push({
      key: 'time:unapproved',
      category: 'run',
      severity: unapprovedPunches >= 100 ? 'high' : 'normal',
      label: `${unapprovedPunches} punches from past weeks still unapproved`,
      detail: 'Unapproved time is unbillable and delays payroll — have supervisors run timesheet approval.',
      stakes: null,
      ageDays: null,
      linkUrl: '/time-attendance',
    });
  }
  const supervisorClients = new Set(supervisors.map((s) => s.clientId).filter(Boolean));
  const workClients = new Map<string, string>();
  for (const a of clientsWithWork) workClients.set(a.location.clientId, a.location.client.name);
  for (const [clientId, name] of workClients) {
    if (!supervisorClients.has(clientId)) {
      out.push({
        key: `client:no-supervisor:${clientId}`,
        category: 'run',
        severity: 'high',
        label: `${name} has no active site supervisor`,
        detail: 'Associates are placed there with nobody holding the floor — assign or hire a supervisor.',
        stakes: null,
        ageDays: null,
        linkUrl: '/admin/users',
      });
    }
  }
  for (const a of pausedLong) {
    const days = Math.floor((now.getTime() - a.deactivatedAt!.getTime()) / DAY_MS);
    out.push({
      key: `associate:paused:${a.id}`,
      category: 'run',
      severity: 'normal',
      label: `${a.firstName} ${a.lastName} has been paused ${days} days`,
      detail: 'Limbo is the wrong state — reactivate them or run a separation.',
      stakes: null,
      ageDays: days,
      linkUrl: `/people?associateId=${a.id}`,
    });
  }
  if (expiringDocs.length > 0) {
    const people = new Set(expiringDocs.map((d) => d.associateId)).size;
    const hasJ1 = expiringDocs.some((d) => d.kind === 'J1_VISA' || d.kind === 'J1_DS2019');
    out.push({
      key: 'compliance:expiring-docs',
      category: 'run',
      severity: hasJ1 ? 'high' : 'normal',
      label: `${people} associate${people === 1 ? "'s" : "s'"} work documents expire within 30 days`,
      detail: 'Expired identity/visa documents block legal work — get renewals collected now.',
      stakes: null,
      ageDays: null,
      linkUrl: '/expirations',
    });
  }

  /* ----- DEVELOP --------------------------------------------------------- */
  if (stuckApps > 0) {
    out.push({
      key: 'onboarding:stuck',
      category: 'develop',
      severity: stuckApps >= 5 ? 'high' : 'normal',
      label: `${stuckApps} candidate${stuckApps === 1 ? '' : 's'} stuck in review over 5 days`,
      detail: 'Every stalled day risks losing them to another employer — have HR clear the review queue.',
      stakes: null,
      ageDays: null,
      linkUrl: '/onboarding',
    });
  }
  if (benchIdle >= 3) {
    out.push({
      key: 'bench:idle',
      category: 'develop',
      severity: 'normal',
      label: `${benchIdle} approved associates unplaced for 2+ weeks`,
      detail: 'You paid to recruit them and they earn nothing on the bench — place them or plan for it.',
      stakes: null,
      ageDays: null,
      linkUrl: '/people',
    });
  }
  const cliffByAssociate = new Map<string, Date>();
  for (const d of j1Docs) {
    if (!d.expiresAt) continue;
    const cur = cliffByAssociate.get(d.associateId);
    if (!cur || d.expiresAt < cur) cliffByAssociate.set(d.associateId, d.expiresAt);
  }
  const cliffCount = cliffByAssociate.size;
  if (cliffCount >= Math.max(3, Math.ceil(j1Active * 0.25))) {
    out.push({
      key: 'j1:replacement-wave',
      category: 'develop',
      severity: 'critical',
      label: `J-1 cliff: ${cliffCount} of ${j1Active} visas expire within 60 days`,
      detail: 'Recruiting-to-floor takes weeks — start the replacement wave now or the schedule breaks.',
      stakes: null,
      ageDays: null,
      linkUrl: '/',
    });
  }

  return out;
}

/** Generate + overlay human state + rank. */
export async function computeExecutiveDecisions(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<ExecutiveDecision[]> {
  const raw = await generateRaw(prisma, now);
  if (raw.length === 0) return [];
  const [states, claims] = await Promise.all([
    prisma.execDecisionState.findMany({
      where: { key: { in: raw.map((d) => d.key) } },
    }),
    prisma.decisionClaim.findMany({
      where: { key: { in: raw.map((d) => d.key) } },
      include: {
        claimedBy: {
          select: {
            id: true,
            email: true,
            associate: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                photoS3Key: true,
                photoUpdatedAt: true,
              },
            },
          },
        },
      },
    }),
  ]);
  const stateByKey = new Map(states.map((s) => [s.key, s]));
  const claimByKey = new Map(claims.map((c) => [c.key, c]));
  const claimInfo = (key: string) => {
    const c = claimByKey.get(key);
    if (!c) return null;
    const u = c.claimedBy;
    const name = u.associate
      ? `${u.associate.firstName} ${u.associate.lastName}`.trim()
      : (u.email.split('@')[0] ?? u.email);
    return {
      id: u.id,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      photoUrl: u.associate ? profilePhotoUrlFor(u.associate) : null,
    };
  };

  const merged: ExecutiveDecision[] = [];
  for (const d of raw) {
    const st = stateByKey.get(d.key);
    let status: DecisionStatus = 'open';
    let delegatedDays: number | null = null;
    if (st) {
      if (st.status === 'DISMISSED') {
        // Re-raise only when the stakes grew materially past dismissal.
        const base = st.stakesAtAction === null ? null : Number(st.stakesAtAction);
        const grew = d.stakes !== null && base !== null && d.stakes > base * 1.25;
        if (!grew) continue;
      } else if (st.status === 'SNOOZED') {
        if (st.snoozeUntil && st.snoozeUntil > now) continue;
      } else if (st.status === 'DELEGATED') {
        status = 'delegated';
        delegatedDays = Math.floor((now.getTime() - st.actedAt.getTime()) / DAY_MS);
      }
    }
    // Follow-through: anything waiting 14+ days escalates a band.
    const severity =
      d.ageDays !== null && d.ageDays >= 14 && status === 'open'
        ? escalate(d.severity)
        : d.severity;
    merged.push({ ...d, severity, status, delegatedDays, claimedBy: claimInfo(d.key) });
  }
  merged.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return (b.stakes ?? 0) - (a.stakes ?? 0);
  });
  return merged;
}
