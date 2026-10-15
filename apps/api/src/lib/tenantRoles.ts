import type { Prisma, Role } from '@prisma/client';
import {
  HUMAN_ROLES,
  ROLE_CAPABILITIES,
  ROLE_LABELS,
  ROLE_MODULE,
  capabilitiesOf,
  type Capability,
  type CapabilityHolder,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { recordCriticalAudit } from './audit.js';
import { ALTO_TENANT_ID } from './tenant.js';
import { moduleOn } from './tenantProfile.js';

/**
 * Brief 2-3 step 3 — tenant roles over archetypes
 * (docs/identity-rbac-audit-investigation.md §4.3).
 *
 *   The built-in roles stay the code's ROLE_CAPABILITIES: listed here as
 *   read-only "system" columns, never stored, so they cannot drift.
 *   A custom role picks an archetype and holds a subset of its ceiling
 *   (owner decision 3); attachUser applies it while the account wears that
 *   archetype, and `can()` clamps to the ceiling on every check anyway.
 *
 *   Every write is a critical `permission.changed` audit with before/after.
 *   Nobody may create, widen or assign a role holding a capability they do
 *   not hold themselves (the users route's no-escalation rule, extended).
 */

export interface Actor extends CapabilityHolder {
  id: string;
  tenantId?: string | null;
}

export const tenantOf = (u: { tenantId?: string | null }): string => u.tenantId ?? ALTO_TENANT_ID;

/** Every capability any role holds, in a stable order. */
export const ALL_CAPABILITIES: Capability[] = [
  ...new Set(Object.values(ROLE_CAPABILITIES).flatMap((s) => [...s])),
].sort();

/** The role a person may be given at all: human, and its module on (closes gap 7). */
export async function assertRoleOffered(role: Role, tenantId: string): Promise<void> {
  if (!HUMAN_ROLES.includes(role)) {
    throw new HttpError(400, 'non_human_role', `${role} is reserved for system integrations.`);
  }
  const module = ROLE_MODULE[role];
  if (module && !(await moduleOn(module, tenantId))) {
    throw new HttpError(400, 'role_module_off', `${ROLE_LABELS[role]} needs the ${module === 'clientPortal' ? 'client portal' : 'transportation'} module, which is off for this organization.`);
  }
}

function assertNoEscalation(actor: Actor, caps: Iterable<Capability>, what: string): void {
  const mine = capabilitiesOf(actor);
  const over = [...caps].filter((c) => !mine.has(c));
  if (over.length) {
    throw new HttpError(403, 'role_escalation_forbidden', `You cannot grant ${what}: it holds capabilities you don't have (${over.join(', ')}).`);
  }
}

function cleanCapabilities(archetype: Role, caps: string[]): Capability[] {
  const ceiling = ROLE_CAPABILITIES[archetype];
  const out = [...new Set(caps)];
  const outside = out.filter((c) => !ceiling.has(c as Capability));
  if (outside.length) {
    throw new HttpError(400, 'outside_archetype', `A custom ${ROLE_LABELS[archetype]} role can only narrow it; it cannot hold ${outside.join(', ')}.`);
  }
  return (out as Capability[]).sort();
}

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  archetype: Role;
  system: boolean;
  capabilities: Capability[];
  holders: number;
}

export async function listTenantRoles(tenantId: string): Promise<RoleView[]> {
  const [custom, counts, systemCounts] = await Promise.all([
    prisma.tenantRole.findMany({ where: { tenantId, deletedAt: null }, orderBy: [{ archetype: 'asc' }, { name: 'asc' }] }),
    prisma.user.groupBy({ by: ['tenantRoleId'], where: { tenantId, deletedAt: null, tenantRoleId: { not: null } }, _count: true }),
    prisma.user.groupBy({ by: ['role'], where: { tenantId, deletedAt: null, tenantRoleId: null }, _count: true }),
  ]);
  const held = new Map(counts.map((c) => [c.tenantRoleId, c._count]));
  const sysHeld = new Map(systemCounts.map((c) => [c.role, c._count]));
  const system: RoleView[] = HUMAN_ROLES.map((r) => ({
    id: `system:${r}`,
    name: ROLE_LABELS[r],
    description: null,
    archetype: r,
    system: true,
    capabilities: [...ROLE_CAPABILITIES[r]].sort(),
    holders: sysHeld.get(r) ?? 0,
  }));
  return [
    ...system,
    ...custom.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      archetype: t.archetype,
      system: false,
      capabilities: t.capabilities as Capability[],
      holders: held.get(t.id) ?? 0,
    })),
  ];
}

async function audit(actor: Actor, tenantId: string, action: string, entityId: string, metadata: Prisma.InputJsonObject) {
  await recordCriticalAudit({ actorUserId: actor.id, tenantId, action, entityType: 'TenantRole', entityId, metadata }, action);
}

async function loadCustom(tenantId: string, id: string) {
  const row = await prisma.tenantRole.findFirst({ where: { id, tenantId, deletedAt: null } });
  if (!row) throw new HttpError(404, 'not_found', 'Role not found.');
  return row;
}

async function dropSessions(tenantRoleId: string) {
  const users = await prisma.user.findMany({ where: { tenantRoleId }, select: { id: true } });
  for (const u of users) invalidateUserCache(u.id);
}

export async function createTenantRole(actor: Actor, input: { name: string; description?: string | null; archetype: Role; capabilities: string[] }) {
  const tenantId = tenantOf(actor);
  await assertRoleOffered(input.archetype, tenantId);
  const capabilities = cleanCapabilities(input.archetype, input.capabilities);
  assertNoEscalation(actor, capabilities, `“${input.name}”`);
  const row = await prisma.tenantRole.create({
    data: { tenantId, name: input.name.trim(), description: input.description?.trim() || null, archetype: input.archetype, capabilities, createdById: actor.id },
  });
  await audit(actor, tenantId, 'permission.changed', row.id, { change: 'role.created', name: row.name, archetype: row.archetype, before: null, after: { capabilities } });
  return row;
}

export async function updateTenantRole(actor: Actor, id: string, input: { name?: string; description?: string | null; capabilities?: string[] }) {
  const tenantId = tenantOf(actor);
  const before = await loadCustom(tenantId, id);
  const capabilities = input.capabilities ? cleanCapabilities(before.archetype, input.capabilities) : (before.capabilities as Capability[]);
  // Only the capabilities being ADDED need the actor to hold them: anyone
  // who can manage roles may narrow one.
  assertNoEscalation(actor, capabilities.filter((c) => !before.capabilities.includes(c)), `“${before.name}”`);
  const row = await prisma.tenantRole.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      capabilities,
    },
  });
  const added = capabilities.filter((c) => !before.capabilities.includes(c));
  const removed = before.capabilities.filter((c) => !capabilities.includes(c as Capability));
  await audit(actor, tenantId, 'permission.changed', id, {
    change: 'role.updated',
    name: row.name,
    archetype: row.archetype,
    before: { name: before.name, capabilities: before.capabilities },
    after: { name: row.name, capabilities },
    added,
    removed,
  });
  await dropSessions(id);
  return row;
}

/**
 * A custom role only ever narrows: deleting it would quietly WIDEN everyone
 * holding it back to the built-in role, so a role in use cannot be deleted.
 */
export async function deleteTenantRole(actor: Actor, id: string) {
  const tenantId = tenantOf(actor);
  const row = await loadCustom(tenantId, id);
  const holders = await prisma.user.count({ where: { tenantRoleId: id, deletedAt: null } });
  if (holders > 0) {
    throw new HttpError(409, 'role_in_use', `${holders} ${holders === 1 ? 'person holds' : 'people hold'} “${row.name}”. Move them to another role first.`);
  }
  await prisma.tenantRole.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(actor, tenantId, 'permission.changed', id, { change: 'role.deleted', name: row.name, archetype: row.archetype, before: { capabilities: row.capabilities }, after: null });
}

/** Give a person a custom role (or null: back to the built-in one). */
export async function assignTenantRole(actor: Actor, userId: string, tenantRoleId: string | null) {
  const tenantId = tenantOf(actor);
  if (userId === actor.id) throw new HttpError(400, 'self_edit_forbidden', 'You cannot change your own role.');
  const target = await prisma.user.findFirst({
    where: { id: userId, tenantId, deletedAt: null },
    select: { id: true, role: true, tenantRoleId: true, tenantRole: { select: { name: true, capabilities: true } } },
  });
  if (!target) throw new HttpError(404, 'not_found', 'User not found.');
  let next: { id: string; name: string; capabilities: string[] } | null = null;
  if (tenantRoleId) {
    const row = await loadCustom(tenantId, tenantRoleId);
    if (row.archetype !== target.role) {
      throw new HttpError(400, 'archetype_mismatch', `“${row.name}” is a ${ROLE_LABELS[row.archetype]} role; this person is a ${ROLE_LABELS[target.role]}. Change their role first.`);
    }
    await assertRoleOffered(row.archetype, tenantId);
    assertNoEscalation(actor, row.capabilities as Capability[], `“${row.name}”`);
    next = row;
  } else {
    // Back to the built-in role widens them to the whole archetype.
    assertNoEscalation(actor, ROLE_CAPABILITIES[target.role], ROLE_LABELS[target.role]);
  }
  if ((target.tenantRoleId ?? null) === (next?.id ?? null)) return;
  await prisma.user.update({ where: { id: userId }, data: { tenantRoleId: next?.id ?? null } });
  invalidateUserCache(userId);
  await recordCriticalAudit(
    {
      actorUserId: actor.id,
      tenantId,
      action: 'permission.changed',
      entityType: 'User',
      entityId: userId,
      metadata: {
        change: 'user.role_assigned',
        archetype: target.role,
        before: target.tenantRole ? { tenantRoleId: target.tenantRoleId, name: target.tenantRole.name } : { tenantRoleId: null, name: ROLE_LABELS[target.role] },
        after: next ? { tenantRoleId: next.id, name: next.name } : { tenantRoleId: null, name: ROLE_LABELS[target.role] },
      },
    },
    'permission.changed',
  );
}
