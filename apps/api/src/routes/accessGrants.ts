import { Router } from 'express';
import { z } from 'zod';
import { AccessGrantInputSchema, HUMAN_ROLES, ROLE_CAPABILITIES, capabilitiesOf, type AccessGrant } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { grantTemporaryRole, revertGrant } from '../lib/accessChanges.js';
import { assertRoleOffered, tenantOf } from '../lib/tenantRoles.js';

/**
 * Temporary elevated access: a role until a date (at most 30 days),
 * reverted by the sweep. The same no-escalation rule as a role change —
 * nobody grants more than they hold — and every grant and revert is on
 * the audit trail.
 */
export const accessGrantsRouter = Router();

const MANAGE = requireCapability('manage:org');
const PERSON = { select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } } as const;
type Person = { id: string; email: string; displayName: string | null; associate: { firstName: string; lastName: string } | null };
const nameOf = (u: Person) => u.displayName ?? (u.associate ? `${u.associate.firstName} ${u.associate.lastName}`.trim() : u.email);

async function shape(g: { id: string; userId: string; role: AccessGrant['role']; grantedById: string | null; reason: string; expiresAt: Date; revertedAt: Date | null; revertedWhy: string | null; createdAt: Date }): Promise<AccessGrant> {
  const [user, by] = await Promise.all([prisma.user.findUnique({ where: { id: g.userId }, ...PERSON }), g.grantedById ? prisma.user.findUnique({ where: { id: g.grantedById }, ...PERSON }) : null]);
  return {
    id: g.id,
    user: { id: g.userId, name: user ? nameOf(user) : '—', email: user?.email ?? '' },
    role: g.role,
    grantedBy: by ? { id: by.id, name: nameOf(by) } : null,
    reason: g.reason,
    expiresAt: g.expiresAt.toISOString(),
    revertedAt: g.revertedAt?.toISOString() ?? null,
    revertedWhy: g.revertedWhy,
    createdAt: g.createdAt.toISOString(),
  };
}

accessGrantsRouter.get('/', requireCapability('view:hr-admin'), async (req, res, next) => {
  try {
    const q = z.object({ userId: z.string().uuid().optional(), open: z.enum(['true', 'false']).optional() }).parse(req.query);
    const rows = await prisma.accessGrant.findMany({
      where: { tenantId: tenantIdForWrite(), ...(q.userId ? { userId: q.userId } : {}), ...(q.open === 'true' ? { revertedAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ grants: await Promise.all(rows.map(shape)) });
  } catch (err) {
    next(err);
  }
});

accessGrantsRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = AccessGrantInputSchema.parse(req.body);
    if (input.userId === req.user!.id) throw new HttpError(400, 'self_edit_forbidden', 'You cannot grant yourself access.');
    if (!HUMAN_ROLES.includes(input.role)) throw new HttpError(400, 'non_human_role', 'That role is reserved for system integrations.');
    const callerCaps = capabilitiesOf(req.user!);
    const escalating = [...ROLE_CAPABILITIES[input.role]].filter((c) => !callerCaps.has(c));
    if (escalating.length > 0) throw new HttpError(403, 'role_escalation_forbidden', `You cannot grant ${input.role}: it holds capabilities you don't have (${escalating.join(', ')}).`);
    await assertRoleOffered(input.role, tenantOf(req.user!));
    const grant = await grantTemporaryRole(prisma, { userId: input.userId, role: input.role, until: new Date(input.until), reason: input.reason }, req.user!.id);
    res.status(201).json(await shape(grant));
  } catch (err) {
    next(err);
  }
});

accessGrantsRouter.post('/:id/revert', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const grant = await prisma.accessGrant.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
    if (!grant) throw new HttpError(404, 'not_found', 'Grant not found.');
    await revertGrant(prisma, id, { userId: req.user!.id, why: 'reverted by an administrator' });
    res.json(await shape((await prisma.accessGrant.findUniqueOrThrow({ where: { id } }))));
  } catch (err) {
    next(err);
  }
});
