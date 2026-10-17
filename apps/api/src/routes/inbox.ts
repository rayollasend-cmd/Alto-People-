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
import { effectiveClientIdFilter, scopeApplications } from '../lib/scope.js';
import { canUseMessenger } from '../lib/messaging.js';
import { buildFieldglassQueue } from '../lib/fieldglassQueue.js';
import { countApprovalQueues } from './approvals.js';
import { countUnreadMessages } from './messages.js';
import { deskOf } from './relay.js';

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
    count: async (u) => (await countApprovalQueues(u)).total,
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
      return prisma.kioskPunch.count({
        where: {
          reviewStatus: 'PENDING',
          ...(clamp ? { device: { is: { clientId: clamp } } } : {}),
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
    key: 'hr-cases',
    label: 'HR cases',
    description: 'Open cases assigned to you, plus unassigned ones your desk can pick up.',
    path: '/hr-cases',
    module: 'hrCases',
    visible: (u) => caseDeskScope(u) !== null,
    count: (u) => {
      const scope = caseDeskScope(u);
      return prisma.hrCase.count({
        where: {
          ...(scope === 'payroll' ? { category: 'PAYROLL' } : {}),
          status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] },
          OR: [{ assignedToId: u.id }, { assignedToId: null }],
        },
      });
    },
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
        where: { status: { in: ['RECEIVED', 'TRIAGING', 'INVESTIGATING'] } },
      }),
  },
  {
    key: 'expirations',
    label: 'Expiring qualifications',
    description: 'Certifications and licenses that have expired or expire within 30 days.',
    path: '/expirations',
    module: 'compliance',
    visible: (u) => can(u, 'view:org'),
    count: () =>
      prisma.associateQualification.count({
        where: {
          deletedAt: null,
          expiresAt: { not: null, lte: new Date(Date.now() + 30 * DAY_MS) },
          qualification: { deletedAt: null },
          associate: { deletedAt: null },
        },
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
    key: 'fieldglass-setup',
    label: 'Fieldglass setup',
    description: 'Workers to add, transfer or close out in Fieldglass.',
    path: '/fieldglass',
    module: 'payrollSync',
    visible: (u) => can(u, 'process:payroll'),
    count: async () => (await buildFieldglassQueue(new Date(), { tenantId: tenantIdForWrite() })).length,
  },
  {
    key: 'messages',
    label: 'Unread messages',
    description: 'Messages in your threads you have not read yet.',
    path: '/messages',
    visible: (u) => canUseMessenger(u.role),
    count: (u) => countUnreadMessages(u.id),
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
