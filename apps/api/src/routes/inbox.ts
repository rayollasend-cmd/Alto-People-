import { Router, type Request } from 'express';
import {
  InboxResponseSchema,
  can,
  hasCapability,
  type InboxSource,
  type TenantModule,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { wotcFilingsDue } from './wotc.js';
import { acaOffersDue } from './aca.js';
import { stateTablesAwaitingReview } from './stateTax.js';
import { localJurisdictionsAwaitingReview } from './taxJurisdictions.js';
import { payrollTaxesNeedingYou } from '../lib/payrollTaxLedger.js';
import { runsAwaitingReview } from '../lib/payrollReview.js';
import { isClientBoundedRole, isInternallyScoped } from '../lib/scope.js';
import { logger } from '../lib/logger.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { scopeActiveAssociates, scopeAssociates, scopeAssociatesIncludingFormer, effectiveClientIdFilter, internalSites, scopeApplications, scopePayrollRuns } from '../lib/scope.js';
import { canUseMessenger } from '../lib/messaging.js';
import { buildFieldglassQueue } from '../lib/fieldglassQueue.js';
import { countApprovalQueues, deciderOf } from './approvals.js';
import { countDecidableApprovals } from '../lib/proposalDecisions.js';
import { countDecidable } from '../lib/approvalRequests.js';
import { deciderFrom } from './approvalRequests.js';
import { countUnreadMessages } from './messages.js';
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
  /** The queue's "pending" predicate, scoped as the list route scopes it.
   *  May answer a description of its own, when the size is best told in money. */
  count: (user: SessionUser) => Promise<number | { count: number; description: string }>;
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
    description: 'Shift swaps, open-shift pickups, time off, timesheets and walk-in clock-ins waiting for a manager.',
    path: '/approvals',
    module: 'scheduling',
    visible: (u) => can(u, 'manage:scheduling'),
    // Agent proposals are their own source below; the badge total carries both.
    count: async (u) => {
      const c = await countApprovalQueues(u);
      return c.total - c.proposals;
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
    path: '/onboarding',
    visible: (u) => can(u, 'view:onboarding') && can(u, 'manage:onboarding'),
    count: (u) =>
      prisma.application.count({
        where: { ...scopeApplications(u), status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
      }),
  },
  {
    key: 'i9-section2',
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
  {
    key: 'everify',
    label: 'E-Verify cases to open',
    description: 'I-9s with Section 2 done and no E-Verify case yet — the federal portal wants the case within three business days.',
    path: '/compliance?tab=everify',
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
    label: 'E-Verify mismatches to act on',
    description: 'E-Verify returned a Tentative Nonconfirmation: give the employee the notice and record whether they will take action.',
    path: '/compliance?tab=everify',
    module: 'compliance',
    visible: (u) => can(u, 'manage:compliance'),
    count: (u) =>
      prisma.i9Verification.count({
        where: {
          tenantId: tenantIdForWrite(),
          eVerifyStatus: 'TENTATIVE_NONCONFIRMATION',
          eVerifyTncDecision: null,
          associate: scopeActiveAssociates(u),
        },
      }),
  },
  {
    key: 'screening-decisions',
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
            { adjudication: 'PRE_ADVERSE', adverseWaitUntil: { lte: new Date() } },
          ],
        },
      }),
  },
  {
    key: 'drug-results-review',
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
    label: 'Tax filings rejected',
    description: 'The agency rejected an e-filed form. Fix what it named and file again.',
    path: '/payroll/tax',
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
    count: (u) => {
      const t = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
      return prisma.leaveCase.count({
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
      });
    },
  },
  {
    key: 'ui-claims',
    label: 'Unemployment claims',
    description: 'State notices to answer within 3 days, and hearings in the next week.',
    path: '/claims/unemployment',
    visible: (u) => can(u, 'manage:claims'),
    count: (u) => {
      const now = Date.now();
      return prisma.unemploymentClaim.count({
        where: {
          tenantId: tenantIdForWrite(),
          associate: { AND: [{ tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(u)] },
          OR: [
            { status: 'NEW', responseDueAt: { lte: new Date(now + 3 * DAY_MS) } },
            { status: 'HEARING_SCHEDULED', hearingAt: { gte: new Date(now - DAY_MS), lte: new Date(now + 7 * DAY_MS) } },
          ],
        },
      });
    },
  },
  {
    key: 'wc-claims',
    label: 'Workers’ comp reports due',
    description: 'First reports of injury not yet sent to the carrier that are due within 2 days.',
    path: '/claims/workers-comp',
    visible: (u) => can(u, 'manage:claims'),
    count: (u) =>
      prisma.wcClaim.count({
        where: {
          tenantId: tenantIdForWrite(),
          associate: { AND: [{ tenantId: tenantIdForWrite() }, scopeAssociatesIncludingFormer(u)] },
          froiSubmittedAt: null,
          status: { notIn: ['CLOSED', 'DENIED'] },
          froiDueAt: { lte: new Date(Date.now() + 2 * DAY_MS) },
        },
      }),
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
  {
    key: 'my-notifications',
    label: 'Unread in your inbox',
    description: 'Notices you have not opened yet.',
    path: '/communications',
    visible: (u) => u.role === 'ASSOCIATE',
    count: (u) => prisma.notification.count({ where: { recipientUserId: u.id, channel: 'IN_APP', readAt: null } }),
  },
  {
    key: 'payroll-review',
    label: 'Payroll to review and sign',
    description: 'Payroll runs whose review report no one has signed off on yet, or whose numbers changed after the sign-off. They can’t pay out until someone does.',
    path: '/payroll/review',
    visible: (u) => can(u, 'process:payroll') && !internalSites(u),
    count: async (u) => (await runsAwaitingReview(prisma, u.id, { AND: [{ tenantId: tenantIdForWrite() }, scopePayrollRuns(u)] })).length,
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
    label: 'Pay account changes to verify',
    description: 'Bank, pay card, W-4 and legal-name changes waiting on a verification call before payroll pays into them.',
    path: '/payroll/financial-changes',
    visible: (u) => can(u, 'process:payroll'),
    count: () => prisma.financialChange.count({ where: { status: { in: ['PENDING', 'HELD'] } } }),
  },
  {
    key: 'unbilled-pay',
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
    label: 'Pay notices not signed',
    description: 'State pay notices (NY, CA, IL, WA) sent more than 7 days ago and still not acknowledged.',
    path: '/payroll/compliance?tab=notices',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => unsignedPayNoticesCount(u),
  },
  {
    key: 'new-hire-reports',
    label: 'New-hire reports due',
    description: 'Hires to report to the state new-hire directory within five days, or already late.',
    path: '/payroll/compliance?tab=newhire',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => newHireReportsDueCount(u),
  },
  {
    key: 'wotc-filings',
    label: 'WOTC filings due',
    description: 'Hires whose tax credit screening points to a target group and whose 28-day state filing deadline is this week or past.',
    path: '/payroll/wotc',
    visible: (u) => can(u, 'process:payroll') || can(u, 'manage:onboarding'),
    count: (u) => wotcFilingsDue(u),
  },
  {
    key: 'aca-offers-due',
    label: 'ACA offers due',
    description: 'Full-time workers (by hours or by hire) with no offer of coverage recorded for the stability period that starts within 30 days.',
    path: '/benefits/aca',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => acaOffersDue(u),
  },
  {
    key: 'state-tax-review',
    label: 'State tax tables to review',
    description: 'States where people work whose withholding was added but not yet reviewed with your tax adviser — payroll can’t finalize with them until it is.',
    path: '/payroll/state-tax',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => stateTablesAwaitingReview(u),
  },
  {
    key: 'local-tax-review',
    label: 'Local taxes to review',
    description: 'Cities, counties and school districts your people live or work in whose rates haven’t been reviewed with your tax adviser — payroll can’t finalize with them until they are.',
    path: '/payroll/tax-jurisdictions',
    visible: (u) => can(u, 'process:payroll'),
    count: (u) => localJurisdictionsAwaitingReview(u),
  },
  {
    key: 'payroll-taxes',
    label: 'Payroll taxes',
    description: 'Tax deposits due this week or late, payments that failed, returns due within two weeks and agency notices waiting on a response.',
    path: '/payroll/taxes',
    // The desk is whole-company only (routes/payrollTaxes.ts), so the count is too.
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u) && !isInternallyScoped(u),
    count: () => payrollTaxesNeedingYou(prisma),
  },
  {
    key: 'certified-payroll',
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
    label: 'Payroll funding',
    description: 'Approved runs whose money hasn’t been pulled, debits the bank returned, and new accounts waiting for their deposit amounts.',
    path: '/payroll/banking',
    // Company-wide money (routes/banking.ts), so the count is too.
    visible: (u) => can(u, 'process:payroll') && !isClientBoundedRole(u) && !isInternallyScoped(u),
    count: () => payrollFundingNeedingYou(prisma),
  },
  {
    key: 'contractors',
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
    label: 'Bills',
    description: 'Vendor bills waiting for your approval, and approved bills due in the next week.',
    path: '/books/bills',
    visible: (u) => can(u, 'manage:books'),
    count: async (u) => {
      const tenantId = tenantIdForWrite();
      const [toApprove, dueSoon] = await Promise.all([
        prisma.bill.count({ where: { tenantId, status: 'PENDING_APPROVAL', NOT: { createdById: u.id } } }),
        prisma.bill.count({ where: { tenantId, status: { in: ['APPROVED', 'PARTIALLY_PAID'] }, dueDate: { lte: new Date(Date.now() + 7 * DAY_MS) } } }),
      ]);
      return toApprove + dueSoon;
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
    const timings: string[] = [];
    const sources: InboxSource[] = await Promise.all(
      mine.map(async (s) => {
        let count = 0;
        let description = s.description;
        const t0 = performance.now();
        try {
          const got = await s.count(user);
          if (typeof got !== 'number') description = got.description;
          count = Math.min(CAP, Math.max(0, typeof got === 'number' ? got : got.count));
        } catch (err) {
          logger.error({ err, source: s.key, userId: user.id }, 'inbox source failed');
        }
        timings.push(`${s.key.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${(performance.now() - t0).toFixed(1)}`);
        return { key: s.key, label: s.label, description, count, path: s.path };
      }),
    );
    // Which source is slow, visible in any browser's network panel.
    res.setHeader('Server-Timing', timings.join(', '));
    const total = sources.reduce((sum, s) => sum + s.count, 0);
    res.json(InboxResponseSchema.parse({ total, sources }));
  } catch (err) {
    next(err);
  }
});
