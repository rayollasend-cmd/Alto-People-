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
import { logger } from '../lib/logger.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { effectiveClientIdFilter, internalSites, scopeApplications } from '../lib/scope.js';
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
  /** The queue's "pending" predicate, scoped as the list route scopes it. */
  count: (user: SessionUser) => Promise<number>;
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
    count: async () => (await buildFieldglassQueue(new Date(), { tenantId: tenantIdForWrite() })).length,
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
    key: 'financial-changes',
    label: 'Pay account changes to verify',
    description: 'Bank, pay card, W-4 and legal-name changes waiting on a verification call before payroll pays into them.',
    path: '/payroll/financial-changes',
    visible: (u) => can(u, 'process:payroll'),
    count: () => prisma.financialChange.count({ where: { status: { in: ['PENDING', 'HELD'] } } }),
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
];

inboxRouter.get('/inbox', requireAuth, async (req, res, next) => {
  try {
    const user = req.user!;
    const profile = await loadTenantProfile();
    const mine = SOURCES.filter((s) => (!s.module || profile.modules[s.module]) && s.visible(user));
    const sources: InboxSource[] = await Promise.all(
      mine.map(async (s) => {
        let count = 0;
        try {
          count = Math.min(CAP, Math.max(0, await s.count(user)));
        } catch (err) {
          logger.error({ err, source: s.key, userId: user.id }, 'inbox source failed');
        }
        return { key: s.key, label: s.label, description: s.description, count, path: s.path };
      }),
    );
    const total = sources.reduce((sum, s) => sum + s.count, 0);
    res.json(InboxResponseSchema.parse({ total, sources }));
  } catch (err) {
    next(err);
  }
});
