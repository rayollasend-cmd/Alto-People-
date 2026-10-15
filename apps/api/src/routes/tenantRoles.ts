import { Router } from 'express';
import { z } from 'zod';
import { HUMAN_ROLES, ROLE_MODULE, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import {
  ALL_CAPABILITIES,
  assertRoleOffered,
  assignTenantRole,
  createTenantRole,
  deleteTenantRole,
  listTenantRoles,
  tenantOf,
  updateTenantRole,
} from '../lib/tenantRoles.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { applyGroupRoles } from '../lib/scimGroups.js';

/**
 * Brief 2-3 step 3 — the permission matrix and custom roles.
 *
 *   GET    /tenant-roles                        every capability × the tenant's roles (built-in read-only, custom editable)
 *   POST   /tenant-roles                        a custom role: an archetype and a subset of its capabilities
 *   PATCH  /tenant-roles/:id                    rename, describe, or change its capabilities
 *   DELETE /tenant-roles/:id                    only when nobody holds it (deleting would widen them)
 *   PUT    /tenant-roles/assign/:userId         { tenantRoleId | null } — a person's custom role
 *   GET    /tenant-roles/scim-groups            the identity provider's groups and their mapped roles
 *   POST   /tenant-roles/scim-groups            map a group name to a role
 *   DELETE /tenant-roles/scim-groups/:id        drop a mapping
 */

export const tenantRolesRouter = Router();

const MANAGE = requireCapability('manage:org');
const RoleSchema = z.enum(HUMAN_ROLES as [Role, ...Role[]]);
const CapsSchema = z.array(z.string().max(60)).max(200);

tenantRolesRouter.get('/', requireAnyCapability('manage:org', 'view:executive'), async (req, res) => {
  const tenantId = tenantOf(req.user!);
  const [roles, profile] = await Promise.all([listTenantRoles(tenantId), loadTenantProfile(tenantId)]);
  res.json({
    capabilities: ALL_CAPABILITIES,
    roles: roles.map((r) => {
      const module = ROLE_MODULE[r.archetype];
      return { ...r, offered: !module || profile.modules[module] };
    }),
  });
});

tenantRolesRouter.post('/', MANAGE, async (req, res) => {
  const input = z
    .object({ name: z.string().trim().min(1).max(80), description: z.string().max(300).nullish(), archetype: RoleSchema, capabilities: CapsSchema })
    .parse(req.body);
  const row = await createTenantRole(req.user!, input);
  res.status(201).json({ id: row.id });
});

tenantRolesRouter.patch('/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = z
    .object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().max(300).nullish(), capabilities: CapsSchema.optional() })
    .parse(req.body);
  await updateTenantRole(req.user!, id, input);
  res.json({ ok: true });
});

tenantRolesRouter.delete('/:id', MANAGE, async (req, res) => {
  await deleteTenantRole(req.user!, z.string().uuid().parse(req.params.id));
  res.status(204).end();
});

tenantRolesRouter.put('/assign/:userId', MANAGE, async (req, res) => {
  const userId = z.string().uuid().parse(req.params.userId);
  const { tenantRoleId } = z.object({ tenantRoleId: z.string().uuid().nullable() }).parse(req.body);
  await assignTenantRole(req.user!, userId, tenantRoleId);
  res.json({ ok: true });
});

tenantRolesRouter.get('/scim-groups', MANAGE, async (req, res) => {
  const tenantId = tenantOf(req.user!);
  const [maps, groups] = await Promise.all([
    prisma.scimGroupRoleMap.findMany({ where: { tenantId }, include: { tenantRole: { select: { name: true } } }, orderBy: [{ priority: 'desc' }, { groupName: 'asc' }] }),
    prisma.scimGroup.findMany({ where: { tenantId }, select: { id: true, displayName: true, memberUserIds: true, updatedAt: true }, orderBy: { displayName: 'asc' } }),
  ]);
  res.json({
    mappings: maps.map((m) => ({ id: m.id, groupName: m.groupName, archetype: m.archetype, tenantRoleId: m.tenantRoleId, tenantRoleName: m.tenantRole?.name ?? null, priority: m.priority })),
    groups: groups.map((g) => ({ id: g.id, displayName: g.displayName, members: g.memberUserIds.length, updatedAt: g.updatedAt })),
  });
});

tenantRolesRouter.post('/scim-groups', MANAGE, async (req, res) => {
  const tenantId = tenantOf(req.user!);
  const input = z
    .object({ groupName: z.string().trim().min(1).max(200), archetype: RoleSchema, tenantRoleId: z.string().uuid().nullish(), priority: z.number().int().min(0).max(1000).default(0) })
    .parse(req.body);
  // SCIM never hands out the portal role (it needs a client and store) or
  // a role whose module is off.
  if (input.archetype === 'CLIENT_PORTAL') throw new HttpError(400, 'role_not_provisionable', 'Client portal accounts are invited from the client, not provisioned by SCIM.');
  await assertRoleOffered(input.archetype, tenantId);
  if (input.tenantRoleId) {
    const tr = await prisma.tenantRole.findFirst({ where: { id: input.tenantRoleId, tenantId, deletedAt: null }, select: { archetype: true } });
    if (!tr || tr.archetype !== input.archetype) throw new HttpError(400, 'archetype_mismatch', 'That custom role is not a version of the chosen role.');
  }
  const existing = await prisma.scimGroupRoleMap.findFirst({ where: { tenantId, groupName: input.groupName } });
  if (existing) throw new HttpError(409, 'already_mapped', 'That group already has a role. Remove it first.');
  const row = await prisma.scimGroupRoleMap.create({ data: { tenantId, groupName: input.groupName, archetype: input.archetype, tenantRoleId: input.tenantRoleId ?? null, priority: input.priority, createdById: req.user!.id } });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, tenantId, action: 'permission.changed', entityType: 'ScimGroupRoleMap', entityId: row.id, metadata: { change: 'scim.group_mapped', groupName: row.groupName, before: null, after: { archetype: row.archetype, tenantRoleId: row.tenantRoleId, priority: row.priority } } },
    'scim.group_mapped',
  );
  // Members already in that group take the role now.
  const group = await prisma.scimGroup.findFirst({ where: { tenantId, displayName: input.groupName }, select: { memberUserIds: true } });
  if (group) await applyGroupRoles(tenantId, group.memberUserIds);
  res.status(201).json({ id: row.id });
});

tenantRolesRouter.delete('/scim-groups/:id', MANAGE, async (req, res) => {
  const tenantId = tenantOf(req.user!);
  const id = z.string().uuid().parse(req.params.id);
  const row = await prisma.scimGroupRoleMap.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'not_found', 'Mapping not found.');
  await prisma.scimGroupRoleMap.delete({ where: { id } });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, tenantId, action: 'permission.changed', entityType: 'ScimGroupRoleMap', entityId: id, metadata: { change: 'scim.group_unmapped', groupName: row.groupName, before: { archetype: row.archetype, tenantRoleId: row.tenantRoleId }, after: null } },
    'scim.group_unmapped',
  );
  res.status(204).end();
});
