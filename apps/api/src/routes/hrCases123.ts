import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { hasCapability, rolesWithCapability, type Role } from '@alto-people/shared';
import {
  ADMIN_EMAIL_HR_ONLY,
  notifyAllAdmins,
  notifyAssociate,
  notifyUser,
} from '../lib/notify.js';

/**
 * Phase 123 — HR cases (ticketing) — now the company's internal case desk.
 *
 * File / view-mine: open to authenticated associates.
 * Triage / assign / resolve / internal notes: manage:onboarding works
 * every case (the HR/admin role family); process:payroll works PAYROLL
 * cases ONLY — a missing paycheck is Finance's ticket, but a harassment
 * case must never cross into another department's queue.
 *
 * Visibility rule: an associate can only read their own cases and only
 * sees comments where internalNote=false. The route handlers enforce both.
 */

export const hrCases123Router = Router();

/** What slice of the desk a staff role can work: everything, the PAYROLL
 *  category only, or nothing. */
function deskScope(role: Role): 'all' | 'payroll' | null {
  if (hasCapability(role, 'manage:onboarding')) return 'all';
  if (hasCapability(role, 'process:payroll')) return 'payroll';
  return null;
}
function canWorkCase(role: Role, category: string): boolean {
  const scope = deskScope(role);
  return scope === 'all' || (scope === 'payroll' && category === 'PAYROLL');
}

const CATEGORY = z.enum([
  'BENEFITS',
  'PAYROLL',
  'TIME_OFF',
  'PERSONAL_INFO',
  'WORKPLACE_CONCERN',
  'HARASSMENT',
  'PERFORMANCE',
  'OTHER',
]);
const PRIORITY = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
const STATUS = z.enum([
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ASSOCIATE',
  'RESOLVED',
  'CLOSED',
]);

// ----- File a case (associate self-serve) ---------------------------------

const FileInputSchema = z.object({
  category: CATEGORY,
  subject: z.string().min(3).max(200),
  description: z.string().min(1).max(8000),
  priority: PRIORITY.default('MEDIUM'),
});

hrCases123Router.post('/hr-cases', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    throw new HttpError(
      403,
      'no_associate_record',
      'Only associates can file HR cases.',
    );
  }
  const input = FileInputSchema.parse(req.body);
  const created = await prisma.hrCase.create({
    data: {
      associateId: req.user!.associateId,
      category: input.category,
      subject: input.subject,
      description: input.description,
      priority: input.priority,
    },
  });
  // Fire-and-forget after the write — never inside a transaction.
  void notifyAllAdmins({
    subject: `New HR case: ${input.subject}`,
    body: `A new HR case was filed (category ${input.category}, priority ${input.priority}): "${input.subject}".`,
    category: 'hr-cases',
    // ?case=<id> opens that case's drawer directly on the HR-cases page.
    linkUrl: `/hr-cases?case=${created.id}`,
    excludeUserId: req.user!.id,
    emailRoles: ADMIN_EMAIL_HR_ONLY,
  });
  res.status(201).json({ id: created.id });
});

// ----- My cases (associate self-serve) ------------------------------------

hrCases123Router.get('/my/hr-cases', requireAuth, async (req, res) => {
  if (!req.user!.associateId) {
    return res.json({ cases: [] });
  }
  const rows = await prisma.hrCase.findMany({
    take: 100,
    where: { associateId: req.user!.associateId },
    include: {
      assignedTo: { select: { email: true } },
      _count: { select: { comments: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json({
    cases: rows.map((c) => ({
      id: c.id,
      category: c.category,
      subject: c.subject,
      status: c.status,
      priority: c.priority,
      assignedToEmail: c.assignedTo?.email ?? null,
      commentCount: c._count.comments,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      resolvedAt: c.resolvedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Queue (HR-facing) ---------------------------------------------------

hrCases123Router.get('/hr-cases', requireAuth, async (req, res) => {
  const scope = deskScope(req.user!.role);
  if (!scope) {
    throw new HttpError(403, 'forbidden', 'Missing capability: manage:onboarding');
  }
  const status = STATUS.optional().parse(req.query.status);
  const category = CATEGORY.optional().parse(req.query.category);
  const assignedToMe = z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .parse(req.query.assignedToMe);

  const rows = await prisma.hrCase.findMany({
    take: 100,
    where: {
      // Finance sees the PAYROLL desk and nothing else.
      ...(scope === 'payroll' ? { category: 'PAYROLL' } : {}),
      ...(status ? { status } : {}),
      ...(category && scope !== 'payroll' ? { category } : {}),
      ...(assignedToMe === 'true' ? { assignedToId: req.user!.id } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      assignedTo: { select: { email: true } },
      _count: { select: { comments: true } },
    },
    orderBy: [
      // URGENT, HIGH come up first.
      { priority: 'desc' },
      { createdAt: 'desc' },
    ],
  });
  res.json({
    cases: rows.map((c) => ({
      id: c.id,
      associateId: c.associateId,
      associateName: `${c.associate.firstName} ${c.associate.lastName}`,
      associateEmail: c.associate.email,
      category: c.category,
      subject: c.subject,
      priority: c.priority,
      status: c.status,
      assignedToEmail: c.assignedTo?.email ?? null,
      commentCount: c._count.comments,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
});

// ----- Case detail ---------------------------------------------------------

hrCases123Router.get('/hr-cases/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const c = await prisma.hrCase.findUnique({
    where: { id },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      assignedTo: { select: { id: true, email: true } },
      comments: {
        include: {
          authorUser: { select: { email: true } },
          authorAssociate: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!c) {
    throw new HttpError(404, 'not_found', 'Case not found.');
  }

  // Visibility: subject can read only their own; HR reads all; Finance
  // reads PAYROLL cases.
  const isOwner = req.user!.associateId === c.associateId;
  const canManage = canWorkCase(req.user!.role, c.category);
  if (!isOwner && !canManage) {
    throw new HttpError(403, 'forbidden', 'Not yours.');
  }

  res.json({
    id: c.id,
    associateId: c.associateId,
    associateName: `${c.associate.firstName} ${c.associate.lastName}`,
    associateEmail: c.associate.email,
    category: c.category,
    subject: c.subject,
    description: c.description,
    priority: c.priority,
    status: c.status,
    assignedToEmail: c.assignedTo?.email ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    resolution: c.resolution,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    comments: c.comments
      .filter((cm) => canManage || !cm.internalNote)
      .map((cm) => ({
        id: cm.id,
        body: cm.body,
        internalNote: cm.internalNote,
        createdAt: cm.createdAt.toISOString(),
        authorEmail: cm.authorUser?.email ?? null,
        authorName: cm.authorAssociate
          ? `${cm.authorAssociate.firstName} ${cm.authorAssociate.lastName}`
          : null,
      })),
  });
});

// ----- Add comment ---------------------------------------------------------

const CommentInputSchema = z.object({
  body: z.string().min(1).max(8000),
  internalNote: z.boolean().default(false),
});

hrCases123Router.post(
  '/hr-cases/:id/comments',
  requireAuth,
  async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = CommentInputSchema.parse(req.body);
    const c = await prisma.hrCase.findUnique({ where: { id } });
    if (!c) {
      throw new HttpError(404, 'not_found', 'Case not found.');
    }
    const isOwner = req.user!.associateId === c.associateId;
    const canManage = canWorkCase(req.user!.role, c.category);
    if (!isOwner && !canManage) {
      throw new HttpError(403, 'forbidden', 'Not yours.');
    }
    if (input.internalNote && !canManage) {
      throw new HttpError(
        403,
        'internal_only',
        'Only HR can leave internal notes.',
      );
    }
    const created = await prisma.hrCaseComment.create({
      data: {
        caseId: id,
        body: input.body,
        internalNote: input.internalNote,
        authorUserId: canManage ? req.user!.id : null,
        authorAssociateId: !canManage && isOwner ? req.user!.associateId : null,
      },
    });
    // Bump updatedAt on the case.
    await prisma.hrCase.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
    // HR replied (not an internal note) → tell the associate. Skip when the
    // commenter is the case's own associate (they don't need an echo).
    if (
      canManage &&
      !input.internalNote &&
      req.user!.associateId !== c.associateId
    ) {
      void notifyAssociate(c.associateId, {
        subject: 'New reply on your HR case',
        body: `HR replied on your case "${c.subject}". Open HR cases to read and respond.`,
        category: 'hr-cases',
        linkUrl: `/hr-cases?case=${id}`,
        emailFallback: true,
      });
    }
    res.status(201).json({ id: created.id });
  },
);

// ----- Triage: claim / assign / change status / resolve --------------------

const TriageInputSchema = z.object({
  status: STATUS.optional(),
  priority: PRIORITY.optional(),
  assignedToId: z.string().uuid().optional().nullable(),
  resolution: z.string().max(4000).optional().nullable(),
});

hrCases123Router.patch('/hr-cases/:id', requireAuth, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = TriageInputSchema.parse(req.body);
  const c = await prisma.hrCase.findUnique({ where: { id } });
  if (!c) {
    throw new HttpError(404, 'not_found', 'Case not found.');
  }
  if (!canWorkCase(req.user!.role, c.category)) {
    throw new HttpError(403, 'forbidden', 'Missing capability: manage:onboarding');
  }
  const willResolve = input.status === 'RESOLVED' && c.status !== 'RESOLVED';
  await prisma.hrCase.update({
    where: { id },
    data: {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assignedToId !== undefined
        ? { assignedToId: input.assignedToId }
        : {}),
      ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
      ...(willResolve ? { resolvedAt: new Date() } : {}),
    },
  });
  // Cross-department routing: assigning a case to someone else puts it on
  // THEIR desk — they hear about it with a deep link, whatever building
  // they sit in.
  if (
    input.assignedToId !== undefined &&
    input.assignedToId !== null &&
    input.assignedToId !== c.assignedToId &&
    input.assignedToId !== req.user!.id
  ) {
    void notifyUser(input.assignedToId, {
      subject: `HR case routed to you: ${c.subject}`,
      body: `A ${c.category.replace(/_/g, ' ').toLowerCase()} case ("${c.subject}", priority ${c.priority}) was routed to you by ${req.user!.email}.`,
      category: 'hr-cases',
      linkUrl: `/hr-cases?case=${id}`,
    });
  }
  if (willResolve) {
    const resolution =
      input.resolution !== undefined ? input.resolution : c.resolution;
    void notifyAssociate(c.associateId, {
      subject: 'Your HR case was resolved',
      body:
        `Your case "${c.subject}" has been marked resolved.` +
        (resolution ? ` Resolution: ${resolution}` : ''),
      category: 'hr-cases',
      linkUrl: `/hr-cases?case=${id}`,
      emailFallback: true,
    });
  }
  res.json({ ok: true });
});

// ----- Summary -------------------------------------------------------------

hrCases123Router.get('/hr-cases-summary', requireAuth, async (req, res) => {
  const scope = deskScope(req.user!.role);
  if (!scope) {
    throw new HttpError(403, 'forbidden', 'Missing capability: manage:onboarding');
  }
  const desk = scope === 'payroll' ? { category: 'PAYROLL' as const } : {};
  const [openTotal, byStatus, byPriority, byCategory] = await Promise.all([
    prisma.hrCase.count({
      where: { ...desk, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ASSOCIATE'] } },
    }),
    prisma.hrCase.groupBy({ by: ['status'], where: { ...desk }, _count: { _all: true } }),
    prisma.hrCase.groupBy({
      by: ['priority'],
      where: { ...desk, status: { not: 'CLOSED' } },
      _count: { _all: true },
    }),
    prisma.hrCase.groupBy({
      by: ['category'],
      where: { ...desk, status: { not: 'CLOSED' } },
      _count: { _all: true },
    }),
  ]);
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  const category: Record<string, number> = {};
  for (const r of byStatus) status[r.status] = r._count._all;
  for (const r of byPriority) priority[r.priority] = r._count._all;
  for (const r of byCategory) category[r.category] = r._count._all;
  res.json({ openTotal, byStatus: status, byPriority: priority, byCategory: category });
});

// ----- The routing directory ------------------------------------------------
//
// Everyone who can work a desk, so any case can be routed to a specific
// person in another department: HR/admin staff plus the Finance desk.
// Emails only — this is staff-facing, no associate PII involved.

hrCases123Router.get('/hr-cases-staff', requireAuth, async (req, res) => {
  if (!deskScope(req.user!.role)) {
    throw new HttpError(403, 'forbidden', 'Missing capability: manage:onboarding');
  }
  const staffRoles = [
    ...new Set([
      ...rolesWithCapability('manage:onboarding'),
      ...rolesWithCapability('process:payroll'),
    ]),
  ];
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', role: { in: staffRoles } },
    select: {
      id: true,
      email: true,
      role: true,
      associate: { select: { firstName: true, lastName: true } },
    },
    orderBy: { email: 'asc' },
    take: 200,
  });
  res.json({
    staff: users.map((u) => ({
      userId: u.id,
      email: u.email,
      role: u.role,
      name: u.associate
        ? `${u.associate.firstName} ${u.associate.lastName}`.trim()
        : u.email.split('@')[0]!,
      // The desk badge: which slice of cases this person can work.
      desk: deskScope(u.role as Role),
    })),
  });
});
