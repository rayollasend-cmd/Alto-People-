import { Router, type Request } from 'express';
import {
  InboxResponseSchema,
  can,
  hasCapability,
  timesheetQueuePath,
  type InboxSource,
  type InboxUrgency,
  type TenantModule,
} from '@alto-people/shared';
import { pendingTimeWhere, pendingTimeWindow } from '../lib/pendingTime.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { wotcFilingsDue } from './wotc.js';
import { acaOffersDue } from './aca.js';
import { stateTablesAwaitingReview } from './stateTax.js';
import { localJurisdictionsAwaitingReview } from './taxJurisdictions.js';
import { payrollTaxesNeedingYou } from '../lib/payrollTaxLedger.js';
import { runsAwaitingReview } from '../lib/payrollReview.js';
import { missedPaydaysNeedingYou } from '../lib/payrollPeriodLedger.js';
import { isClientBoundedRole, isInternallyScoped } from '../lib/scope.js';
import { logger } from '../lib/logger.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { scopeActiveAssociates, scopeAssociates, scopeAssociatesIncludingFormer, effectiveClientIdFilter, internalSites, scopeApplications, scopePayrollRuns } from '../lib/scope.js';
import { canUseMessenger } from '../lib/messaging.js';
import { buildFieldglassQueue } from '../lib/fieldglassQueue.js';
import { countApprovalQueues, deciderOf } from './approvals.js';
import { billTabWhere } from '../lib/books/payables/bills.js';
import { companyWorkweek } from '../lib/timeAnomalies.js';
import { localDateKey } from '../lib/timezone.js';
import { utcInstantOfLocalMidnight } from '../lib/timeAnomalies.js';
import { countDecidableApprovals } from '../lib/proposalDecisions.js';
import { countDecidable } from '../lib/approvalRequests.js';
import { deciderFrom } from './approvalRequests.js';
import { countUnreadMessages } from './messages.js';
import { QUEUE_DESK_ROLES, QUEUE_REGISTRY, staffsQueueDesk, type QueueDesk } from '@alto-people/shared';
import { deskOf } from './relay.js';
import { transportNeedsYou } from './transportOps.js';
import { countToCertify } from '../lib/accessCertification.js';
import { expiringQualificationsWhere } from '../lib/expirationScope.js';
import { hrCaseReach } from '../lib/hrCaseScope.js';
import { myPayNoticesToSign, newHireReportsDueCount, unsignedPayNoticesCount } from './payrollCompliance.js';
import { unbilledGapCached } from '../lib/payBillRecon.js';
import { certifiedWeeksDue } from '../lib/certifiedPayroll.js';
import { contractorsNeedingYou } from '../lib/contractors.js';
import { payrollFundingNeedingYou } from '../lib/banking/funding.js';
import { countMovesThisWeek, countUnassigned } from './paySchedules.js';
import { i9ReverificationWhere, i9RetentionWhere } from '../lib/hiringCompliance.js';
import { certificationRequired } from '../lib/leaveOfAbsence.js';
import { coverageGapLabel, coverageGapPath, coverageGapsForUser } from '../lib/coverageGaps.js';
import { daysPastDue, portalScopeOf, serviceReportToReview, unpaidStatementsWhere, waitingCandidatesWhere } from '../lib/portalNeedsYou.js';
import { portalCalendar } from '../lib/portalMetrics.js';
import { overdueContractDuties, seesContractDuties } from '../lib/contractDuties.js';
import { stuckWhere } from '../lib/applicationFilters.js';

/**
 * GET /me/inbox — every decision waiting on the signed-in person, across
 * modules, as counts with deep links.
 *
 * The principle (docs/ux-upgrade-investigation.md): the person sees
 * decisions; navigation is how you get elsewhere. So this endpoint never
 * loads a queue — it asks each queue for its size, with the SAME
 * capability gate, tenant-module gate and client-bounded scope the queue's
 * own list route applies, so the number here equals what the person finds
 * when they open the link.
 *
 * One failing source never fails the inbox: each count runs inside its
 * own try/catch, logs, and reports 0. Counts are capped at 999.
 */
export const inboxRouter = Router();

type SessionUser = NonNullable<Request['user']>;

const CAP = 999;
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 86_400_000;

interface SourceDef {
  key: string;
  label: string;
  description: string;
  path: string;
  /** The tenant module this queue belongs to (mirrors the nav's MODULE_GATE); none = core. */
  module?: TenantModule;
  /** May this person see the queue at all? The list route's own gate. */
  visible: (user: SessionUser) => boolean;
  /** How the queue ranks against the others (role walk HR 4): a legal clock
   *  above money above routine. Routine when unsaid. */
  urgency?: InboxUrgency;
  /** The queue's "pending" predicate, scoped as the list route scopes it.
   *  May answer a description of its own, when the size is best told in money,
   *  a narrower link, when the work sits in one corner of the queue, and the
   *  soonest deadline among what it counted. */
  count: (user: SessionUser) => Promise<
    | number
    | {
        count: number;
        description?: string;
        path?: string;
        dueAt?: Date | string | null;
        /** A calendar-day deadline ('YYYY-MM-DD' or a @db.Date value): shown as that day, never shifted by a zone. */
        dueDate?: Date | string | null;
        /** The items' names, shown when the queue holds three or fewer. */
        preview?: string[];
        /** Ranks above the queue's own band right now (a same-day staffing gap). */
        urgency?: InboxUrgency;
        progress?: { done: number; total: number };
      }
  >;
}

/** The earliest calendar day given, as 'YYYY-MM-DD' (a @db.Date reads as UTC midnight). */
function soonestDay(...dates: Array<Date | string | null | undefined>): string | null {
  const days = dates
    .filter((d): d is Date | string => !!d)
    .map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d.slice(0, 10)))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  return days[0] ?? null;
}

/** When a window that starts at `startMinute` (the store's clock) begins today, as an instant. */
function windowStartToday(startMinute: number, timeZone: string): Date {
  const midnight = utcInstantOfLocalMidnight(localDateKey(new Date(), timeZone), timeZone);
  return new Date(midnight.getTime() + startMinute * 60_000);
}

/** The earliest of the dates given, as the ISO the contract carries; null when none. */
function soonest(...dates: Array<Date | string | null | undefined>): string | null {
  let best: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = d instanceof Date ? d.getTime() : Date.parse(d);
    if (Number.isNaN(t)) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * One request asks two sources (approvals, timesheets) for the same queue
 * counts — share the computation per user for the request's lifetime.
 */
const approvalCountMemo = new WeakMap<SessionUser, ReturnType<typeof countApprovalQueues>>();
function approvalCounts(u: SessionUser): ReturnType<typeof countApprovalQueues> {
  let hit = approvalCountMemo.get(u);
  if (!hit) {
    hit = countApprovalQueues(u);
    approvalCountMemo.set(u, hit);
  }
  return hit;
}

/**
 * The timesheet queue's link, opened on the rows its count counted: from
 * the oldest pending entry's company-local day (else the start of the
 * 90-day window) through today. Same predicate as the count
 * (lib/pendingTime), same builder as every other "N timesheets" link
 * (shared timesheetQueuePath).
 */
async function pendingTimesheetQueuePath(u: SessionUser, now: Date = new Date()): Promise<string> {
  const tz = companyWorkweek().timezone;
  const window = pendingTimeWindow(now);
  const oldest = await prisma.timeEntry.findFirst({
    where: pendingTimeWhere(u, window),
    orderBy: { clockInAt: 'asc' },
    select: { clockInAt: true },
  });
  return timesheetQueuePath({ from: localDateKey(oldest?.clockInAt ?? window.from, tz), to: localDateKey(now, tz) });
}

/** Same clamp as kioskClientClamp in kiosk99.ts: bounded callers see
 *  their own client's devices; an unassigned bounded caller sees none. */
function clientClamp(user: SessionUser): string | undefined {
  const bounded = effectiveClientIdFilter(user, undefined);
  return bounded === null ? NO_CLIENT : bounded;
}

/** What slice of the case desk this role works — deskScope in hrCases123.ts. */
function caseDeskScope(user: SessionUser): 'all' | 'payroll' | null {
  if (hasCapability(user.role, 'manage:onboarding')) return 'all';
  if (hasCapability(user.role, 'process:payroll')) return 'payroll';
  return null;
}

const SOURCES: SourceDef[] = [
  {
    key: 'approvals',
    label: 'Approvals',
    description: 'Shift swaps, open-shift pickups, time off and walk-in clock-ins waiting for a manager.',
    path: '/approvals',
    module: 'scheduling',
    visible: (u) => can(u, 'manage:scheduling'),
    // Only what the Approvals page lists: agent proposals and timesheets are
    // their own sources (their own pages), so this count reaches 0 exactly
    // when the page is empty. When the work is all in one queue, the link
    // opens that queue.
    count: async (u) => {
      const c = await approvalCounts(u);
      const queues: Array<[number, string]> = [
        [c.swaps, '/approvals?tab=swaps'],
        [c.pickups, '/approvals?tab=pickups'],
        [c.timeOff, '/approvals?tab=timeoff'],
        [c.clockIns, '/approvals?tab=walkins'],
      ];
      const busy = queues.filter(([n]) => n > 0);
      return { count: c.swaps + c.pickups + c.timeOff + c.clockIns, path: busy.length === 1 ? busy[0]![1] : undefined };
    },
  },
  {
    key: 'timesheets',
    label: 'Timesheets to approve',
    description: 'Finished punches from the last 90 days waiting for approval — unapproved time can’t be paid or billed.',
    path: '/time-attendance?tab=queue',
    module: 'time',
    // Whoever approves time — the queue's own gate.
    visible: (u) => can(u, 'manage:time'),
    // The link opens the queue on exactly the rows the count counted —
    // the oldest pending day through today.
    count: async (u) => {
      const c = await approvalCounts(u);
      return { count: c.timesheets, path: c.timesheets > 0 ? await pendingTimesheetQueuePath(u) : undefined };
    },
  },
  {
    key: 'agent-proposals',
    label: 'Agent proposals',
    description: 'Shifts to fill, cases to open and other actions an agent proposes. Nothing happens until you decide.',
    path: '/approvals?tab=proposals',
    visible: (u) => can(u, 'manage:org') || can(u, 'manage:scheduling') || can(u, 'manage:onboarding'),
    count: (u) => countDecidableApprovals(prisma, tenantIdForWrite(), deciderOf(u)),
  },
  {
    key: 'time-corrections',
    label: 'Punch corrections',
    description: 'Workers asking to fix a missed or wrong punch, each with their signed attestation.',
    path: '/time-attendance?tab=corrections',
    visible: (u) => can(u, 'manage:time'),
    count: (u) =>
      prisma.timeCorrectionRequest.count({
        where: { AND: [{ tenantId: tenantIdForWrite(), status: 'SUBMITTED' }, { associate: scopeAssociates(u) }] },
      }),
  },
  {
    key: 'break-flags',
    label: 'Missed breaks reported',
    description: 'Workers who said at clock-out they didn’t get a meal or rest break, where the labor rules aren’t paid live yet.',
    path: '/time-attendance?tab=breaks',
    visible: (u) => can(u, 'manage:time'),
    count: (u) =>
      prisma.breakAttestation.count({
        where: { AND: [{ tenantId: tenantIdForWrite(), flagged: true }, { associate: scopeAssociates(u) }] },
      }),
  },
  {
    key: 'reimbursements',
    urgency: 'money',
    label: 'Reimbursements',
    description: 'Expense claims waiting on a manager’s approval, and approved ones waiting on Finance to settle into the next run.',
    path: '/reimbursements',
    // Two desks, one row: the manager step (SUBMITTED) and the HR/Finance
    // settle step (MANAGER_APPROVED) — reimbursements97.ts gates them apart.
    visible: (u) => can(u, 'approve:reimbursement') || can(u, 'settle:reimbursement'),
    count: (u) => {
      const statuses: Array<'SUBMITTED' | 'MANAGER_APPROVED'> = [];
      if (can(u, 'approve:reimbursement')) statuses.push('SUBMITTED');
      if (can(u, 'settle:reimbursement')) statuses.push('MANAGER_APPROVED');
      return prisma.reimbursement.count({
        where: { tenantId: tenantIdForWrite(), status: { in: statuses }, associate: { deletedAt: null } },
      });
    },
  },
  {
    key: 'approval-requests',
    label: 'Approvals waiting on you',
    description: 'Pay and bill-rate changes, separations, promotions, requisitions and access changes that need a second person — you.',
    path: '/approvals?tab=requests',
    visible: (u) => u.role !== 'ASSOCIATE' && u.role !== 'CLIENT_PORTAL' && u.role !== 'DRIVER',
    count: (u) => countDecidable(prisma, deciderFrom(u)),
  },
  {
    key: 'workflow-tasks',
    label: 'Tasks from workflows',
    description: 'What a workflow handed you, or your role, to do.',
    path: '/workflows?tab=tasks',
    visible: (u) => u.role !== 'ASSOCIATE' && u.role !== 'CLIENT_PORTAL',
    count: (u) =>
      prisma.workflowTask.count({
        where: { tenantId: tenantIdForWrite(), status: 'OPEN', OR: [{ assigneeUserId: u.id }, { assigneeRole: u.role }] },
      }),
  },
  {
    key: 'referral-bonuses',
    label: 'Referral bonuses',
    description: 'Referral bonuses marketing has proposed, waiting on Finance to approve onto a payroll run.',
    path: '/marketing/bonuses',
    visible: (u) => can(u, 'process:payroll'),
    count: () => prisma.referralBonusPayout.count({ where: { tenantId: tenantIdForWrite(), status: 'PROPOSED' } }),
  },
  {
    key: 'kiosk-review',
    label: 'Kiosk punches to review',
    description: 'Clock-ins the kiosk flagged — a face mismatch or impossible travel — waiting for a ruling.',
    path: '/time-attendance/kiosk?tab=review',
    module: 'time',
    visible: (u) => can(u, 'manage:time'),
    count: (u) => {
      const clamp = clientClamp(u);
      const reach = internalSites(u);
      // The punches the review tab shows: this tenant's, at kiosks in reach.
      return prisma.kioskPunch.count({
        where: {
          AND: [
            { tenantId: tenantIdForWrite(), reviewStatus: 'PENDING' },
            clamp ? { device: { is: { clientId: clamp } } } : {},
            reach ? { device: { is: { location: { is: reach } } } } : {},
          ],
        },
      });
    },
  },
  {
    key: 'onboarding-review',
    label: 'Applications to review',
    description: 'New hires who submitted their paperwork and are waiting on HR.',
    path: '/onboarding?status=TO_REVIEW',
    visible: (u) => can(u, 'view:onboarding') && can(u, 'manage:onboarding'),
    count: (u) =>
      prisma.application.count({
        where: { ...scopeApplications(u), status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
      }),
  },
  {
    // Role walk HR 2: applications nothing has moved in a week. The link opens
    // the applications list's "Stuck" filter — the one rule
    // (lib/applicationFilters stuckWhere), so the count is the list, the
    // banner and the rows' "idle" (F500 SH-4). AND, never spread: both
    // halves may carry their own AND.
    key: 'onboarding-stuck',
    label: 'Onboarding stuck',
    description: 'New hires whose onboarding has not moved in more than 7 days: no task done and no invite. A nudge now saves the start date.',
    path: '/onboarding?status=STUCK',
    visible: (u) => can(u, 'view:onboarding') && can(u, 'manage:onboarding'),
    count: (u) =>
      prisma.application.count({
        where: { AND: [scopeApplications(u), stuckWhere()] },
      }),
  },
  {
    key: 'i9-section2',
    urgency: 'legal',
    label: 'I-9 Section 2 to complete',
    description: 'New hires who signed Section 1 and uploaded their documents — HR has three business days from their first day to examine them.',
    path: '/compliance?tab=i9',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: () =>
      prisma.i9Verification.count({
        where: {
          tenantId: tenantIdForWrite(),
          documentsSubmittedAt: { not: null },
          section2CompletedAt: null,
          associate: { deletedAt: null },
        },
      }),
  },
  // Audit 2026-10-21 #14: the same predicates the I-9 list's ?status= filters use (lib/hiringCompliance).
  {
    key: 'i9-reverification',
    urgency: 'legal',
    label: 'I-9 reverification due',
    description: 'Work authorizations that have expired or expire within 90 days — Supplement B is due by the expiry date.',
    path: '/compliance?tab=i9&status=work_auth',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: async (u) => {
      const where = { AND: [{ tenantId: tenantIdForWrite() }, i9ReverificationWhere(), { associate: scopeActiveAssociates(u) }] };
      const [count, first] = await Promise.all([
        prisma.i9Verification.count({ where }),
        prisma.i9Verification.findFirst({ where, orderBy: { workAuthExpiresAt: 'asc' }, select: { workAuthExpiresAt: true } }),
      ]);
      return { count, dueDate: soonestDay(first?.workAuthExpiresAt) };
    },
  },
  {
    key: 'i9-retention',
    label: 'I-9s past retention',
    description: 'People who left more than a year ago and were hired more than three years ago — their I-9s may now be destroyed.',
    path: '/compliance?tab=i9&status=retention',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: (u) =>
      prisma.i9Verification.count({
        where: { AND: [{ tenantId: tenantIdForWrite() }, i9RetentionWhere(), { associate: { AND: [{ deletedAt: null }, scopeAssociatesIncludingFormer(u)] } }] },
      }),
  },
  {
    key: 'everify',
    urgency: 'legal',
    label: 'E-Verify cases to open',
    description: 'I-9s with Section 2 done and no E-Verify case yet — the federal portal wants the case within three business days.',
    // Role walk HR 3: the link carries the filter its count uses.
    path: '/compliance?tab=everify&status=not_run',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: () =>
      prisma.i9Verification.count({
        where: {
          tenantId: tenantIdForWrite(),
          section2CompletedAt: { not: null },
          eVerifyStatus: null,
          eVerifyCaseNumber: null,
          associate: {
            deletedAt: null,
            applications: { some: { deletedAt: null, status: { notIn: ['REJECTED', 'CANCELLED'] } } },
          },
        },
      }),
  },
  // Connected providers (lib/providers): the steps their answers leave for a person.
  {
    key: 'everify-mismatches',
    urgency: 'legal',
    label: 'E-Verify mismatches to act on',
    description: 'E-Verify returned a Tentative Nonconfirmation: give the employee the notice and record whether they will take action.',
    path: '/compliance?tab=everify&status=issue',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    // Role walk HR 3: the list opens filtered to mismatches; with exactly
    // one, straight onto that person's case.
    count: async (u) => {
      const where = {
        tenantId: tenantIdForWrite(),
        eVerifyStatus: 'TENTATIVE_NONCONFIRMATION' as const,
        eVerifyTncDecision: null,
        associate: scopeActiveAssociates(u),
      };
      const [count, rows] = await Promise.all([
        prisma.i9Verification.count({ where }),
        prisma.i9Verification.findMany({ where, select: { associateId: true }, take: 2 }),
      ]);
      const path = count === 1 && rows[0] ? `/compliance?tab=everify&status=issue&associateId=${rows[0].associateId}` : '/compliance?tab=everify&status=issue';
      return { count, path };
    },
  },
  {
    key: 'screening-decisions',
    urgency: 'legal',
    label: 'Background checks to decide',
    description: 'Reports that came back “consider”, and adverse actions whose waiting period is over.',
    path: '/compliance?tab=background',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: (u) =>
      prisma.backgroundCheck.count({
        where: {
          tenantId: tenantIdForWrite(),
          associate: scopeActiveAssociates(u),
          OR: [
            { result: 'consider', adjudication: null },
            // Hand-recorded checks that came back for review (audit 2026-10-21 #14).
            { status: 'NEEDS_REVIEW', adjudication: null },
            { adjudication: 'PRE_ADVERSE', adverseWaitUntil: { lte: new Date() } },
          ],
        },
      }),
  },
  {
    key: 'drug-results-review',
    urgency: 'legal',
    label: 'Drug test results to review',
    description: 'Results that are not a verified negative — a positive awaiting the Medical Review Officer, a dilute, or a cancelled test.',
    path: '/compliance?tab=drug-tests',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: (u) =>
      prisma.drugTest.count({
        where: { tenantId: tenantIdForWrite(), status: 'NEEDS_REVIEW', resultCode: { not: null }, associate: scopeActiveAssociates(u) },
      }),
  },
  {
    key: 'efile-rejected',
    urgency: 'legal',
    label: 'Tax filings rejected',
    description: 'The agency rejected an e-filed form. Fix what it named and file again.',
    // Year-end › Forms lists the rejected W-2 / 1099 / 941 forms first (F500 G3: one home for the forms;
    // the old /payroll/tax and /payroll/taxes?tab=returns links still work).
    path: '/payroll/year-end?tab=forms',
    visible: (u) => can(u, 'process:payroll'),
    count: () => prisma.taxForm.count({ where: { tenantId: tenantIdForWrite(), efileStatus: 'REJECTED' } }),
  },
  {
    key: 'provider-health',
    label: 'Connections failing',
    description: 'A connected provider (E-Verify, screening, drug tests, tax filing or payouts) is answering with errors.',
    path: '/integrations',
    visible: (u) => can(u, 'manage:integrations'),
    count: async () => {
      const rows = await prisma.providerConnection.findMany({
        where: { tenantId: tenantIdForWrite(), active: true, lastErrorAt: { not: null } },
        select: { lastErrorAt: true, lastSuccessAt: true },
      });
      return rows.filter((r) => (r.lastErrorAt?.getTime() ?? 0) > (r.lastSuccessAt?.getTime() ?? 0)).length;
    },
  },
  {
    key: 'access-certifications',
    urgency: 'legal',
    label: 'Access to certify',
    description: 'Accounts in an open access certification waiting on your decision.',
    path: '/admin/access-certifications',
    visible: () => true,
    count: (u) => countToCertify(prisma, u.id),
  },
  {
    key: 'hr-cases',
    label: 'HR cases',
    description: 'Open cases assigned to you, plus unassigned ones your desk can pick up.',
    path: '/hr-cases',
    module: 'hrCases',
    visible: (u) => caseDeskScope(u) !== null,
    count: (u) => {
      const scope = caseDeskScope(u);
      // The cases this desk can open (lib/hrCaseScope), so the badge matches the list.
      return prisma.hrCase.count({
        where: {
          AND: [
            hrCaseReach(u),
            scope === 'payroll' ? { category: 'PAYROLL' } : {},
            { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] } },
            { OR: [{ assignedToId: u.id }, { assignedToId: null }] },
          ],
        },
      });
    },
  },
  {
    key: 'hr-cases-sla',
    urgency: 'legal',
    label: 'HR cases past their SLA',
    description: 'Open cases that passed their resolution target. Oldest breach first.',
    path: '/hr-cases?sla=breached',
    module: 'hrCases',
    visible: (u) => caseDeskScope(u) !== null,
    count: (u) => {
      const scope = caseDeskScope(u);
      return prisma.hrCase.count({
        where: { AND: [hrCaseReach(u), scope === 'payroll' ? { category: 'PAYROLL' } : {}, { status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: new Date() } }] },
      });
    },
  },
  {
    key: 'policies-to-sign',
    label: 'Policies to sign',
    description: 'Policies sent to you that are waiting for your signature.',
    path: '/agreements?tab=policies',
    visible: (u) => Boolean(u.associateId),
    count: (u) => prisma.policyCampaignRecipient.count({ where: { associateId: u.associateId!, status: 'PENDING', campaign: { status: 'ACTIVE' } } }),
  },
  {
    key: 'leave-desk',
    label: 'Leave of absence',
    description: 'Notices owed, certifications due within 3 days, and returns to work due this week.',
    path: '/leave',
    visible: (u) => can(u, 'manage:leave'),
    urgency: 'legal',
    count: async (u) => {
      const t = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
      const rows = await prisma.leaveCase.findMany({
        where: {
          tenantId: tenantIdForWrite(),
          associate: scopeActiveAssociates(u, { former: true }),
          OR: [
            { status: 'REQUESTED' },
            { status: 'PENDING_CERTIFICATION', certificationReceivedAt: null, certificationDueAt: { lte: new Date(t.getTime() + 3 * DAY_MS) } },
            { status: 'PENDING_CERTIFICATION', certificationReceivedAt: { not: null } },
            { status: 'APPROVED', actualReturnDate: null, expectedReturnDate: { lte: new Date(t.getTime() + 7 * DAY_MS) } },
          ],
        },
        select: { status: true, certificationReceivedAt: true, certificationDueAt: true, expectedReturnDate: true, actualReturnDate: true },
        take: CAP,
      });
      return {
        count: rows.length,
        dueAt: soonest(
          ...rows.map((r) =>
            r.status === 'PENDING_CERTIFICATION' && !r.certificationReceivedAt
              ? r.certificationDueAt
              : r.status === 'APPROVED' && !r.actualReturnDate
                ? r.expectedReturnDate
                : null,
          ),
        ),
      };
    },
  },
  {
    key: 'ui-claims',
    label: 'Unemployment claims',
    description: 'State notices to answer within 3 days, and hearings in the next week.',
    path: '/claims/unemployment',
    visible: (u) => can(u, 'manage:claims'),
    urgency: 'legal',
    count: async (u) => {
      const now = Date.now();
      const rows = await prisma.unemploymentClaim.findMany({
        where: {
          tenantId: tenantIdForWrite(),
          associate: { AND: [{ tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(u)] },
          OR: [
            { status: 'NEW', responseDueAt: { lte: new Date(now + 3 * DAY_MS) } },
            { status: 'HEARING_SCHEDULED', hearingAt: { gte: new Date(now - DAY_MS), lte: new Date(now + 7 * DAY_MS) } },
          ],
        },
        select: { status: true, responseDueAt: true, hearingAt: true },
        take: CAP,
      });
      return { count: rows.length, dueAt: soonest(...rows.map((r) => (r.status === 'NEW' ? r.responseDueAt : r.hearingAt))) };
    },
  },
  {
    key: 'wc-claims',
    label: 'Workers’ comp reports due',
    description: 'First reports of injury not yet sent to the carrier that are due within 2 days.',
    path: '/claims/workers-comp',
    visible: (u) => can(u, 'manage:claims'),
    urgency: 'legal',
    count: async (u) => {
      const rows = await prisma.wcClaim.findMany({
        where: {
          tenantId: tenantIdForWrite(),
          associate: { AND: [{ tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(u)] },
          froiSubmittedAt: null,
          status: { notIn: ['CLOSED', 'DENIED'] },
          froiDueAt: { lte: new Date(Date.now() + 2 * DAY_MS) },
        },
        select: { froiDueAt: true },
        take: CAP,
      });
      return { count: rows.length, dueAt: soonest(...rows.map((r) => r.froiDueAt)) };
    },
  },
  {
    key: 'verification-letters',
    label: 'Letters to approve',
    description: 'Employment and income verification letters people have asked for.',
    path: '/documents?tab=letters',
    visible: (u) => can(u, 'manage:documents'),
    count: () => prisma.verificationLetter.count({ where: { tenantId: tenantIdForWrite(), status: 'REQUESTED' } }),
  },
  {
    key: 'hotline',
    label: 'Hotline reports',
    description: 'Anonymous reports that are received, being triaged or under investigation.',
    path: '/hotline-admin',
    module: 'hrCases',
    visible: (u) => can(u, 'manage:performance'),
    count: () =>
      prisma.anonymousReport.count({
        where: { tenantId: tenantIdForWrite(), status: { in: ['RECEIVED', 'TRIAGING', 'INVESTIGATING'] } },
      }),
  },
  {
    key: 'expirations',
    urgency: 'legal',
    label: 'Expiring qualifications',
    description: 'Certifications and licenses that have expired or expire within 30 days.',
    path: '/expirations',
    module: 'compliance',
    visible: (u) => can(u, 'view:org'),
    // The same people the Expirations page shows (lib/expirationScope).
    count: (u) =>
      prisma.associateQualification.count({
        where: { AND: [expiringQualificationsWhere(u), { expiresAt: { lte: new Date(Date.now() + 30 * DAY_MS) } }] },
      }),
  },
  {
    // Role walk HR 2: the client contracts' recurring duties (monthly report,
    // Fieldglass timesheet, insurance certificates…) past due and not
    // confirmed — one read with the HR home (lib/contractDuties).
    key: 'contract-duties',
    urgency: 'legal',
    label: 'Contract duties overdue',
    description: 'Duties the client contracts require that are past due and not confirmed on the compliance scorecard.',
    path: '/compliance?tab=scorecard',
    visible: (u) => seesContractDuties(u),
    count: async (u) => {
      const d = await overdueContractDuties(prisma, u);
      return {
        count: d.count,
        // A calendar day: the chip shows it as that day in every zone (F500 G5).
        dueDate: d.oldestDue,
        // Named as what is owed ("Workers' comp certificate"), not as a status ("…insurance current").
        preview: d.count <= 3 ? d.items.map((i) => i.deliverable) : undefined,
        description:
          d.count > 3
            ? `${d.items.map((i) => i.deliverable).slice(0, 2).join('; ')}; and ${d.count - 2} more.`
            : d.count
              ? 'Confirm each on the compliance scorecard once it is filed.'
              : 'Every contract duty is confirmed for its period.',
      };
    },
  },
  {
    key: 'tasks',
    label: 'Tasks needing a person',
    description: 'Work the engine queued for a person, or that a worker stalled on or failed.',
    path: '/tasks',
    visible: (u) => can(u, 'view:time-live'),
    count: () =>
      prisma.workTask.count({
        where: { tenantId: tenantIdForWrite(), status: { in: ['QUEUED', 'STALLED', 'FAILED'] } },
      }),
  },
  {
    key: 'relay',
    label: 'Relay rulings',
    description: 'Decisions another desk asked yours to rule on.',
    path: '/relay',
    visible: (u) => can(u, 'view:org') && deskOf(u.role) !== null,
    count: (u) =>
      prisma.workNote.count({
        where: { tenantId: tenantIdForWrite(), decisionStatus: 'PENDING', decisionDesk: deskOf(u.role) },
      }),
  },
  {
    key: 'client-requests',
    label: 'Client requests',
    description: 'Staffing, issue, billing and feedback requests from client stores that nobody has resolved — each on an SLA clock.',
    path: '/relay?tab=requests',
    module: 'clientPortal',
    // The internal owners' view only (clientRequests.ts GET /client-requests,
    // view:org). The store manager's portal has no view:org, so it is untouched.
    visible: (u) => can(u, 'view:org'),
    count: () =>
      prisma.clientRequest.count({
        where: { tenantId: tenantIdForWrite(), status: { not: 'RESOLVED' } },
      }),
  },
  {
    key: 'fieldglass-setup',
    label: 'Fieldglass setup',
    description: 'Workers to add, transfer or close out in Fieldglass.',
    path: '/fieldglass',
    module: 'payrollSync',
    visible: (u) => can(u, 'process:payroll'),
    // Building the queue walks every worker; a badge can be half a minute old.
    count: () => memoCount(`fieldglass-setup:${tenantIdForWrite()}`, 30_000, async () => (await buildFieldglassQueue(new Date(), { tenantId: tenantIdForWrite() })).length),
  },
  // ---- The floor (field roles, 2026-10) ------------------------------------
  {
    key: 'floor-flags',
    label: 'Flags from the floor',
    description: 'A no-show or a hazard a floor supervisor raised at your store, waiting for your acknowledgement.',
    path: '/',
    module: 'scheduling',
    visible: (u) => u.role === 'SHIFT_SUPERVISOR' || u.role === 'WORKFORCE_MANAGER',
    count: (u) => {
      const clamp = clientClamp(u);
      return prisma.floorFlag.count({ where: { tenantId: tenantIdForWrite(), status: 'OPEN', ...(clamp ? { clientId: clamp } : {}) } });
    },
  },
  {
    key: 'call-outs',
    label: 'Call-outs looking for cover',
    description: 'Someone called out of a shift in the next day and a half and nobody has taken it yet — the cover flow is already running.',
    path: '/call-outs',
    module: 'scheduling',
    visible: (u) => can(u, 'manage:scheduling'),
    count: (u) =>
      prisma.callOut.count({
        where: {
          AND: [
            { tenantId: tenantIdForWrite(), status: 'CONFIRMED' },
            { shift: { startsAt: { gt: new Date(), lte: new Date(Date.now() + 36 * 3_600_000) }, OR: [{ assignedAssociateId: null }, { status: 'OPEN' }] } },
            { associate: scopeActiveAssociates(u, { former: true }) },
          ],
        },
      }),
  },
  {
    key: 'coverage-gaps',
    label: 'Short shift windows today',
    description: 'A shift window you lead today with fewer people scheduled than the store contracted — fill it from the bench or the schedule.',
    path: '/scheduling?view=day',
    module: 'scheduling',
    // Whoever leads a window: the same definition the supervisor's home
    // notice draws (lib/coverageGaps), so the bell and the badge agree.
    visible: (u) => u.role === 'SHIFT_SUPERVISOR' || u.role === 'WORKFORCE_MANAGER' || u.role === 'OPERATIONS_MANAGER',
    count: async (u) => {
      const gaps = await coverageGapsForUser(prisma, u.id);
      // A same-day staffing gap outranks 34-day-old timesheets: the money band,
      // due when its first window starts (F500 G5).
      return {
        count: gaps.length,
        path: gaps.length > 0 ? coverageGapPath(gaps[0]!) : undefined,
        urgency: 'money' as const,
        dueAt: soonest(...gaps.map((g) => windowStartToday(g.window.startMinute, g.window.timezone))),
        preview: gaps.length <= 3 ? gaps.map(coverageGapLabel) : undefined,
      };
    },
  },
  {
    key: 'floor-watch',
    label: 'On the floor now',
    description: 'Shifts at your store that started with nobody punched in, and today’s unfilled shifts — the watch, not a decision.',
    path: '/today',
    module: 'scheduling',
    visible: (u) => u.role === 'FLOOR_SUPERVISOR',
    count: async (u) => {
      const clamp = clientClamp(u);
      if (!clamp) return 0;
      const now = new Date();
      const dayAgo = new Date(now.getTime() - DAY_MS);
      const [notIn, open] = await Promise.all([
        prisma.shift.count({
          where: {
            clientId: clamp,
            status: 'ASSIGNED',
            publishedAt: { not: null },
            startsAt: { gte: dayAgo, lte: new Date(now.getTime() - 15 * 60_000) },
            endsAt: { gt: now },
            timeEntries: { none: {} },
          },
        }),
        prisma.shift.count({
          where: { clientId: clamp, status: 'OPEN', publishedAt: { not: null }, startsAt: { gte: now, lt: new Date(now.getTime() + DAY_MS) } },
        }),
      ]);
      return notIn + open;
    },
  },
  // ---- The associate's own: the counted "Needs you" the home promises -------
  {
    key: 'my-agreements',
    label: 'Agreements to sign',
    description: 'Agreements waiting for your signature.',
    path: '/agreements',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) => prisma.agreement.count({ where: { associateId: u.associateId!, status: 'PENDING_SIGNATURE' } }),
  },
  {
    key: 'my-documents',
    label: 'Documents needing attention',
    description: 'Documents that expired, were sent back, or expire within 60 days.',
    path: '/documents',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) =>
      prisma.documentRecord.count({
        where: {
          associateId: u.associateId!,
          deletedAt: null,
          OR: [{ status: { in: ['EXPIRED', 'REJECTED'] } }, { expiresAt: { not: null, lte: new Date(Date.now() + 60 * DAY_MS) } }],
        },
      }),
  },
  {
    key: 'my-pay-notices',
    label: 'Pay notice to sign',
    description: 'A written notice of your pay rate and payday that state law asks you to sign.',
    path: '/me/pay-notices',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) => myPayNoticesToSign(u.associateId!),
  },
  {
    key: 'my-punch-fixes',
    label: 'Punches to fix',
    description: 'A shift you didn’t clock out of — tell us when you left.',
    path: '/time-attendance?fix=1',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) => prisma.timeCorrectionRequest.count({ where: { associateId: u.associateId!, status: 'PROMPTED' } }),
  },
  {
    key: 'my-ot-offers',
    label: 'Extra hours offered',
    description: 'Open shifts offered to you — take them or pass.',
    path: '/time-attendance?tab=offers',
    module: 'scheduling',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) => prisma.overtimeOffer.count({ where: { associateId: u.associateId!, status: 'OFFERED', shift: { startsAt: { gt: new Date() } } } }),
  },
  {
    key: 'my-shifts',
    label: 'Shifts to confirm',
    description: 'Upcoming shifts you have not confirmed yet.',
    path: '/scheduling',
    module: 'scheduling',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) =>
      prisma.shift.count({
        where: { assignedAssociateId: u.associateId!, status: 'ASSIGNED', publishedAt: { not: null }, startsAt: { gt: new Date() }, acknowledgedAt: null },
      }),
  },
  {
    key: 'my-training',
    label: 'Training due',
    description: 'Required courses not yet complete, and certifications that expire within 30 days.',
    path: '/learning',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: (u) =>
      prisma.courseEnrollment.count({
        where: {
          associateId: u.associateId!,
          OR: [
            { status: { in: ['ASSIGNED', 'IN_PROGRESS'] }, course: { isRequired: true, status: 'PUBLISHED' } },
            { status: 'COMPLETED', expiresAt: { not: null, lte: new Date(Date.now() + 30 * DAY_MS) } },
            { status: 'EXPIRED' },
          ],
        },
      }),
  },
  // A client account's own decisions (F500 G5) — the same list the store
  // home's "Needs you" shows (lib/portalNeedsYou), scoped to the account's
  // client and store. A region account (no client) has its command center.
  {
    key: 'portal-statements-past-due',
    label: 'Statements past due',
    description: 'Statements past their due date and not yet paid.',
    path: '/#portal-statements',
    module: 'clientPortal',
    urgency: 'money',
    visible: (u) => u.role === 'CLIENT_PORTAL' && !!u.clientId,
    count: async (u) => {
      const scope = await portalScopeOf(u);
      if (!scope) return 0;
      const cal = await portalCalendar(scope);
      const today = cal.key(new Date());
      const rows = await prisma.clientStatement.findMany({
        where: unpaidStatementsWhere(scope.clientId),
        select: { number: true, dueAt: true, snapshot: true },
        orderBy: { dueAt: 'asc' },
        take: CAP,
      });
      const late = rows.filter((r) => daysPastDue(r.dueAt, today) !== null);
      if (late.length === 0) return 0;
      // Money only where the account holds the whole statement: a client-wide
      // account, or the one store of a one-store client.
      const ownsTotals = !scope.locationId || (await prisma.site.count({ where: { clientId: scope.clientId, deletedAt: null } })) === 1;
      const total = late.reduce((a, r) => a + Number((r.snapshot as { totals?: { amount?: number } } | null)?.totals?.amount ?? 0), 0);
      const oldest = Math.max(...late.map((r) => daysPastDue(r.dueAt, today) ?? 0));
      const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total);
      const shortDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      return {
        count: late.length,
        description: `${ownsTotals ? `${money} · ` : ''}oldest ${oldest} ${oldest === 1 ? 'day' : 'days'} past due.`,
        // A calendar day (@db.Date): the chip shows that day in every zone.
        dueDate: soonestDay(...late.map((r) => r.dueAt)),
        // "No. 0004 · due Oct 7" — the statements themselves when there are few.
        ...(late.length <= 3
          ? { preview: late.map((r) => `${r.number !== null ? `No. ${String(r.number).padStart(4, '0')}` : 'Statement'}${r.dueAt ? ` · due ${shortDay(r.dueAt)}` : ''}`) }
          : {}),
      };
    },
  },
  {
    key: 'portal-service-report',
    label: 'Service report to review',
    description: 'Last week’s service report is ready — read it and mark it reviewed.',
    path: '/#portal-needs-you',
    module: 'clientPortal',
    visible: (u) => u.role === 'CLIENT_PORTAL' && !!u.clientId,
    count: async (u) => {
      const scope = await portalScopeOf(u);
      if (!scope) return 0;
      const r = await serviceReportToReview(scope);
      return r.hadShifts && !r.reviewed ? 1 : 0;
    },
  },
  {
    key: 'portal-candidates',
    label: 'Candidates waiting for your answer',
    description: 'People put forward for your team — approve, or pass and say why.',
    path: '/portal/candidates',
    module: 'clientPortal',
    visible: (u) => u.role === 'CLIENT_PORTAL' && !!u.clientId,
    count: async (u) => {
      const scope = await portalScopeOf(u);
      return scope ? prisma.candidateSubmittal.count({ where: waitingCandidatesWhere(scope) }) : 0;
    },
  },
  {
    key: 'my-notifications',
    label: 'Unread in your inbox',
    description: 'Notices you have not opened yet.',
    path: '/communications',
    visible: (u) => u.role === 'ASSOCIATE',
    count: (u) => prisma.notification.count({ where: { recipientUserId: u.id, channel: 'IN_APP', readAt: null } }),
  },
  // The associate's tasks, not their unread count (role walk floor 24): the
  // home's Needs-you lists the thing to do, with the link that does it.
  {
    key: 'my-onboarding',
    label: 'Finish onboarding',
    description: 'Your onboarding checklist is not finished yet.',
    path: '/onboarding',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: async (u) => {
      const open = await prisma.application.findFirst({
        where: { associateId: u.associateId!, deletedAt: null, status: { notIn: ['REJECTED', 'CANCELLED'] } },
        orderBy: { invitedAt: 'desc' },
        select: { id: true, checklist: { select: { tasks: { select: { status: true } } } } },
      });
      const tasks = open?.checklist?.tasks ?? [];
      const done = tasks.filter((t) => t.status === 'DONE' || t.status === 'SKIPPED').length;
      if (!open || tasks.length === 0 || done === tasks.length) return 0;
      return { count: 1, description: `${done} of ${tasks.length} tasks done.`, path: `/onboarding/me/${open.id}`, progress: { done, total: tasks.length } };
    },
  },
  // A new hire with no availability on file is "fully unavailable" to the
  // schedule and never knows it (role walk supervisor 11): say so on the
  // home, with the editor one tap away.
  {
    key: 'my-availability',
    label: 'Set when you can work',
    description: 'The schedule cannot offer you shifts until it knows your availability.',
    path: '/scheduling#availability',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: async (u) => {
      const windows = await prisma.associateAvailability.count({ where: { associateId: u.associateId! } });
      return windows === 0 ? 1 : 0;
    },
  },
  {
    key: 'my-leave-certification',
    label: 'Upload leave certification',
    description: 'A leave of absence is waiting on a certification from you.',
    path: '/leave',
    visible: (u) => u.role === 'ASSOCIATE' && !!u.associateId,
    count: async (u) => {
      const rows = await prisma.leaveCase.findMany({
        where: { associateId: u.associateId!, status: { in: ['REQUESTED', 'PENDING_CERTIFICATION'] }, certificationReceivedAt: null },
        select: { type: true, reason: true, certificationDueAt: true },
        take: CAP,
      });
      const needing = rows.filter((r) => certificationRequired(r));
      return { count: needing.length, dueDate: soonestDay(...needing.map((r) => r.certificationDueAt)) };
    },
  },
  {
    key: 'payroll-review',
    urgency: 'money',
    label: 'Payroll to review and sign',
    description: 'Payroll runs whose review report no one has signed off on yet, or whose numbers changed after the sign-off. They can’t pay out until someone does.',
    path: '/payroll/review',
    visible: (u) => can(u, 'process:payroll') && !internalSites(u),
    count: async (u) => (await runsAwaitingReview(prisma, u.id, { AND: [{ tenantId: tenantIdForWrite() }, scopePayrollRuns(u)] })).length,
  },
  {
    key: 'payroll-missed-paydays',
    urgency: 'money',
    label: 'Paydays with no run',
    description: 'Scheduled paydays that passed with no payroll run, and the approved hours they left unpaid. Pay them off-cycle from the payroll home.',
    path: '/payroll?ledger=missed',
    visible: (u) => can(u, 'process:payroll') && !internalSites(u),
    count: (u) => missedPaydaysNeedingYou(prisma, u),
  },
  {
    key: 'pay-schedule-unassigned',
    label: 'People on no pay schedule',
    description: 'Hired people no pay schedule covers. No payroll run will pay them until a rule, the company default or a person puts them on one.',
    path: '/payroll/schedules?view=unassigned',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => countUnassigned(u),
  },
  {
    key: 'pay-schedule-moves',
    label: 'Pay schedule moves starting this week',
    description: 'People whose pay schedule changes in the next seven days — a transfer, a hire or a rule change. Their last check on the old schedule covers through the day before.',
    path: '/payroll/schedules',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => countMovesThisWeek(u),
  },
  {
    key: 'financial-changes',
    urgency: 'money',
    label: 'Pay account changes to verify',
    description: 'Bank, pay card, W-4 and legal-name changes waiting on a verification call before payroll pays into them.',
    path: '/payroll/financial-changes',
    visible: (u) => can(u, 'process:payroll'),
    count: () => prisma.financialChange.count({ where: { status: { in: ['PENDING', 'HELD'] } } }),
  },
  {
    key: 'unbilled-pay',
    urgency: 'money',
    label: 'Billable pay not billed',
    description: 'Pay for client work that is on no statement: no statement covers those days, a rebill is waiting for review, or there is no bill rate.',
    path: '/finance/pay-bill',
    module: 'clientPortal',
    // Company-wide money: never for an account narrowed to some stores.
    visible: (u) => can(u, 'process:payroll') && !internalSites(u),
    count: async (u) => {
      const gap = await unbilledGapCached(prisma, `${tenantIdForWrite()}:${u.role}`, { AND: [{ tenantId: tenantIdForWrite() }, scopePayrollRuns(u)] });
      const dollars = gap.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      return { count: gap.count, description: gap.count ? `${dollars} of billable pay is not on any statement.` : 'All billable pay is on a statement.' };
    },
  },
  {
    key: 'pay-notices-unsigned',
    urgency: 'legal',
    label: 'Pay notices not signed',
    description: 'State pay notices (NY, CA, IL, WA) sent more than 7 days ago and still not acknowledged.',
    path: '/payroll/compliance?tab=notices',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => unsignedPayNoticesCount(u),
  },
  {
    key: 'new-hire-reports',
    urgency: 'legal',
    label: 'New-hire reports due',
    description: 'Hires to report to the state new-hire directory within five days, or already late.',
    path: '/payroll/compliance?tab=newhire',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => newHireReportsDueCount(u),
  },
  {
    key: 'wotc-filings',
    urgency: 'legal',
    label: 'WOTC filings due',
    description: 'Hires whose tax credit screening points to a target group and whose 28-day state filing deadline is this week or past.',
    path: '/payroll/wotc',
    visible: (u) => can(u, 'process:payroll') || can(u, 'manage:onboarding'),
    count: (u) => wotcFilingsDue(u),
  },
  {
    key: 'aca-offers-due',
    urgency: 'legal',
    label: 'ACA offers due',
    description: 'Full-time workers (by hours or by hire) with no offer of coverage recorded for the stability period that starts within 30 days.',
    path: '/benefits/aca',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => acaOffersDue(u),
  },
  {
    key: 'state-tax-review',
    urgency: 'legal',
    label: 'State tax tables to review',
    description: 'States where people work whose withholding was added but not yet reviewed with your tax adviser — payroll can’t finalize with them until it is.',
    path: '/payroll/tax-tables?tab=state',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => stateTablesAwaitingReview(u),
  },
  {
    key: 'local-tax-review',
    urgency: 'legal',
    label: 'Local taxes to review',
    description: 'Cities, counties and school districts your people live or work in whose rates haven’t been reviewed with your tax adviser — payroll can’t finalize with them until they are.',
    path: '/payroll/tax-tables?tab=local',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => localJurisdictionsAwaitingReview(u),
  },
  {
    key: 'payroll-taxes',
    urgency: 'money',
    label: 'Payroll taxes',
    description: 'Tax deposits due this week or late, payments that failed, returns due within two weeks and agency notices waiting on a response.',
    path: '/payroll/taxes',
    // The desk is whole-company only (routes/payrollTaxes.ts), so the count is too.
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u) && !isInternallyScoped(u),
    count: () => payrollTaxesNeedingYou(prisma),
  },
  {
    key: 'certified-payroll',
    urgency: 'legal',
    label: 'Certified payroll',
    description: 'Prevailing-wage weeks that have ended without a signed WH-347 submitted to the agency.',
    path: '/payroll/certified',
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u),
    count: (u) => {
      const sites = internalSites(u);
      return certifiedWeeksDue(prisma, sites ? { tenantId: tenantIdForWrite(), site: { is: sites } } : { tenantId: tenantIdForWrite() });
    },
  },
  {
    key: 'payroll-funding',
    urgency: 'money',
    label: 'Payroll funding',
    description: 'Approved runs whose money hasn’t been pulled, debits the bank returned, and new accounts waiting for their deposit amounts.',
    path: '/payroll/banking',
    // Company-wide money (routes/banking.ts), so the count is too.
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u) && !isInternallyScoped(u),
    count: () => payrollFundingNeedingYou(prisma),
  },
  {
    key: 'contractors',
    urgency: 'money',
    label: 'Contractors',
    description: 'IRS mismatch notices to answer before backup withholding starts, and contractor payment runs waiting for a second approver.',
    path: '/payroll/contractors',
    // Company-wide money, like the desk itself (routes/contractors.ts).
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u) && !isInternallyScoped(u),
    count: (u) => contractorsNeedingYou(prisma, u.id),
  },
  {
    key: 'messages',
    label: 'Unread messages',
    description: 'Messages in your threads you have not read yet.',
    path: '/messages',
    visible: (u) => canUseMessenger(u.role),
    count: (u) => countUnreadMessages(u.id),
  },
  {
    key: 'transport',
    label: 'Transportation',
    description: 'An SOS or an unanswered driver, seats today without a van, vans running late, incidents, safety issues, lapsing papers and driver requests.',
    path: '/transport',
    module: 'transportation',
    visible: (u) => can(u, 'view:transport'),
    count: async () => (await transportNeedsYou()).total,
  },
  {
    key: 'books-bills',
    urgency: 'money',
    label: 'Bills to approve',
    description: 'Vendor bills a second person entered, waiting for your approval.',
    path: '/books/bills?tab=approve',
    visible: (u) => can(u, 'manage:books'),
    // Your own bills are a second person's to approve — not counted here.
    count: (u) => prisma.bill.count({ where: { tenantId: tenantIdForWrite(), status: 'PENDING_APPROVAL', NOT: { createdById: u.id } } }),
  },
  {
    key: 'books-bills-late',
    label: 'Late bills',
    description: 'Approved vendor bills past their due date and not yet paid.',
    path: '/books/bills?status=late',
    visible: (u) => can(u, 'manage:books'),
    urgency: 'money',
    // billTabWhere('late') — the list this opens shows exactly these.
    count: async () => {
      const rows = await prisma.bill.findMany({ where: { tenantId: tenantIdForWrite(), ...billTabWhere('late') }, select: { dueDate: true }, take: CAP });
      return { count: rows.length, dueAt: soonest(...rows.map((r) => r.dueDate)) };
    },
  },
  {
    key: 'books-bills-due',
    label: 'Bills due in the next 7 days',
    description: 'Approved vendor bills due today or in the next seven days. Late ones are under Late bills.',
    path: '/books/bills?status=due',
    visible: (u) => can(u, 'manage:books'),
    urgency: 'money',
    // billTabWhere('due') — the list this opens shows exactly these.
    count: async () => {
      const rows = await prisma.bill.findMany({ where: { tenantId: tenantIdForWrite(), ...billTabWhere('due') }, select: { dueDate: true }, take: CAP });
      return { count: rows.length, dueAt: soonest(...rows.map((r) => r.dueDate)) };
    },
  },
];

/**
 * A short-lived memo for the counts that are expensive to compute (they walk
 * every worker): concurrent callers share one computation, and the answer is
 * reused for `ttlMs`. Keyed per tenant by the caller.
 */
const countMemo = new Map<string, { at: number; value: Promise<number> }>();
function memoCount(key: string, ttlMs: number, run: () => Promise<number>): Promise<number> {
  const hit = countMemo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = run().catch((err) => {
    countMemo.delete(key);
    throw err;
  });
  countMemo.set(key, { at: Date.now(), value });
  return value;
}

inboxRouter.get('/inbox', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const profile = await loadTenantProfile();
    const mine = SOURCES.filter((s) => (!s.module || profile.modules[s.module]) && s.visible(user));
    // Owner desks (queues.ts QUEUE_REGISTRY, F500 SH-4): a company-wide queue
    // counts toward the badge of the desk whose job it is. Anyone else who may
    // see it watches it. A desk nobody in the company staffs leaves its queues
    // to everyone who sees them — never an orphan.
    const deskStaffed = new Map<QueueDesk, boolean>();
    const desksNeeded = new Set(mine.map((s) => QUEUE_REGISTRY[s.key]?.ownerDesk).filter((d): d is QueueDesk => !!d));
    if (desksNeeded.size > 0) {
      const roles = [...new Set([...desksNeeded].flatMap((d) => [...QUEUE_DESK_ROLES[d]]))];
      const staffed = await prisma.user.groupBy({
        by: ['role'],
        where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', deletedAt: null, role: { in: roles } },
        _count: { _all: true },
      });
      const has = new Set(staffed.map((r) => r.role));
      for (const d of desksNeeded) deskStaffed.set(d, QUEUE_DESK_ROLES[d].some((r) => has.has(r)));
    }
    const watches = (key: string): boolean => {
      const desk = QUEUE_REGISTRY[key]?.ownerDesk;
      return !!desk && deskStaffed.get(desk) === true && !staffsQueueDesk(key, user.role);
    };
    const timings: string[] = [];
    const sources: InboxSource[] = await Promise.all(
      mine.map(async (s) => {
        let count = 0;
        let description = s.description;
        let path = s.path;
        let dueAt: string | null = null;
        let dueDate: string | null = null;
        let preview: string[] | undefined;
        let urgency: InboxUrgency = s.urgency ?? 'routine';
        let progress: { done: number; total: number } | undefined;
        const t0 = performance.now();
        try {
          const got = await s.count(user);
          if (typeof got !== 'number') {
            description = got.description ?? description;
            path = got.path ?? path;
            dueAt = soonest(got.dueAt);
            dueDate = soonestDay(got.dueDate);
            preview = got.preview?.slice(0, 3);
            if (got.urgency) urgency = got.urgency;
            progress = got.progress;
          }
          count = Math.min(CAP, Math.max(0, typeof got === 'number' ? got : got.count));
        } catch (err) {
          logger.error({ err, source: s.key, userId: user.id }, 'inbox source failed');
        }
        timings.push(`${s.key.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${(performance.now() - t0).toFixed(1)}`);
        // A deadline only means something while the queue has items.
        // The one name for the queue both pages use (queues.ts).
        return {
          key: s.key,
          label: QUEUE_REGISTRY[s.key]?.label ?? s.label,
          description,
          count,
          path,
          urgency,
          dueAt: count > 0 ? dueAt : null,
          ...(count > 0 && dueDate ? { dueDate } : {}),
          // Names only when there are few enough to read at a glance.
          ...(count > 0 && count <= 3 && preview && preview.length > 0 ? { preview } : {}),
          ...(count > 0 && progress ? { progress } : {}),
          ...(watches(s.key) ? { watching: true } : {}),
        };
      }),
    );
    // Which source is slow, visible in any browser's network panel.
    res.setHeader('Server-Timing', timings.join(', '));
    // The badge: only the queues this person owns.
    const total = sources.reduce((sum, s) => sum + (s.watching ? 0 : s.count), 0);
    res.json(InboxResponseSchema.parse({ total, sources }));
  } catch (err) {
    next(err);
  }
});
