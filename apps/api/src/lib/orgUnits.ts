import type { OrgUnitType, Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from './tenant.js';

/**
 * Brief 2-1b, step 5 — the organizational tree.
 *
 *   One tree per tenant: division / region / business unit / cost center.
 *   `path` is the materialized ancestry ("/root/child/…/this"), so "every
 *   site under this unit" is one prefix match, which is what the scope
 *   rules (lib/scope.ts) and the command center read.
 *
 *   Region and CostCenter rows are mirrored here (legacyRegionId,
 *   legacyCostCenterId) and kept in step by their admin routes until they
 *   are dropped; the command center already reads the tree.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface OrgUnitView {
  id: string;
  type: OrgUnitType;
  parentId: string | null;
  name: string;
  code: string | null;
  glCode: string | null;
  path: string;
  clientId: string | null;
  isActive: boolean;
  sites: number;
  legacyRegionId: string | null;
  legacyCostCenterId: string | null;
}

const SELECT = {
  id: true,
  type: true,
  parentId: true,
  name: true,
  code: true,
  glCode: true,
  path: true,
  clientId: true,
  isActive: true,
  legacyRegionId: true,
  legacyCostCenterId: true,
  _count: { select: { locations: { where: { deletedAt: null } } } },
} as const;

const toView = (u: Prisma.OrgUnitGetPayload<{ select: typeof SELECT }>): OrgUnitView => ({
  id: u.id,
  type: u.type,
  parentId: u.parentId,
  name: u.name,
  code: u.code,
  glCode: u.glCode,
  path: u.path,
  clientId: u.clientId,
  isActive: u.isActive,
  sites: u._count.locations,
  legacyRegionId: u.legacyRegionId,
  legacyCostCenterId: u.legacyCostCenterId,
});

/**
 * A nested `connect: { id }` is invisible to the tenant guard (CODE-30): the
 * client a unit names must be this tenant's, checked before the write.
 */
async function assertClientInTenant(db: Db, clientId: string, tenantId: string): Promise<void> {
  const client = await db.client.findFirst({ where: { id: clientId, tenantId, deletedAt: null }, select: { id: true } });
  if (!client) throw new HttpError(400, 'client_not_found', 'That client does not exist.');
}

/** "Under this unit, this one included": the filter a site or a user carries. */
export function underPath(path: string): Prisma.StringFilter {
  return { startsWith: path };
}

export async function listOrgUnits(db: Db = defaultPrisma, tenantId: string = tenantIdForWrite()): Promise<OrgUnitView[]> {
  const rows = await db.orgUnit.findMany({ where: { tenantId, deletedAt: null }, select: SELECT, orderBy: [{ path: 'asc' }] });
  return rows.map(toView);
}

export async function getOrgUnit(db: Db, id: string): Promise<OrgUnitView | null> {
  const u = await db.orgUnit.findFirst({ where: { id, deletedAt: null }, select: SELECT });
  return u ? toView(u) : null;
}

export async function createOrgUnit(
  db: Db,
  input: { type: OrgUnitType; name: string; parentId?: string | null; code?: string | null; glCode?: string | null; clientId?: string | null; legacyRegionId?: string | null; legacyCostCenterId?: string | null },
  tenantId: string = tenantIdForWrite(),
): Promise<OrgUnitView> {
  let parentPath = '';
  if (input.parentId) {
    const parent = await db.orgUnit.findFirst({ where: { id: input.parentId, tenantId, deletedAt: null }, select: { path: true } });
    if (!parent) throw new HttpError(400, 'parent_not_found', 'That parent unit does not exist.');
    parentPath = parent.path;
  }
  if (input.clientId) await assertClientInTenant(db, input.clientId, tenantId);
  const created = await db.orgUnit.create({
    data: { tenantId, type: input.type, name: input.name.trim(), parentId: input.parentId ?? null, code: input.code ?? null, glCode: input.glCode ?? null, clientId: input.clientId ?? null, legacyRegionId: input.legacyRegionId ?? null, legacyCostCenterId: input.legacyCostCenterId ?? null, path: '' },
    select: { id: true },
  });
  const u = await db.orgUnit.update({ where: { id: created.id }, data: { path: `${parentPath}/${created.id}` }, select: SELECT });
  return toView(u);
}

/** Rename, re-code, or move a unit (its subtree's paths move with it). */
export async function updateOrgUnit(
  db: Db,
  id: string,
  input: { name?: string; code?: string | null; glCode?: string | null; parentId?: string | null; isActive?: boolean; clientId?: string | null },
): Promise<OrgUnitView> {
  const unit = await db.orgUnit.findFirst({ where: { id, deletedAt: null }, select: { id: true, tenantId: true, path: true, parentId: true } });
  if (!unit) throw new HttpError(404, 'org_unit_not_found', 'No such unit.');
  const data: Prisma.OrgUnitUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.code !== undefined) data.code = input.code;
  if (input.glCode !== undefined) data.glCode = input.glCode;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.clientId) await assertClientInTenant(db, input.clientId, unit.tenantId);
  if (input.clientId !== undefined) data.client = input.clientId ? { connect: { id: input.clientId } } : { disconnect: true };
  if (input.parentId !== undefined && input.parentId !== unit.parentId) {
    let parentPath = '';
    if (input.parentId) {
      const parent = await db.orgUnit.findFirst({ where: { id: input.parentId, tenantId: unit.tenantId, deletedAt: null }, select: { path: true } });
      if (!parent) throw new HttpError(400, 'parent_not_found', 'That parent unit does not exist.');
      if (parent.path.startsWith(unit.path)) throw new HttpError(400, 'org_unit_cycle', 'A unit cannot move under itself.');
      parentPath = parent.path;
    }
    const newPath = `${parentPath}/${unit.id}`;
    // The subtree follows: every path that starts with the old prefix is re-rooted.
    const subtree = await db.orgUnit.findMany({ where: { path: { startsWith: `${unit.path}/` }, deletedAt: null }, select: { id: true, path: true } });
    for (const s of subtree) {
      await db.orgUnit.update({ where: { id: s.id }, data: { path: newPath + s.path.slice(unit.path.length) } });
    }
    data.parent = input.parentId ? { connect: { id: input.parentId } } : { disconnect: true };
    data.path = newPath;
  }
  const u = await db.orgUnit.update({ where: { id }, data, select: SELECT });
  return toView(u);
}

/** Soft-delete a unit; its sites and people are unpinned, its children move up to its parent. */
export async function deleteOrgUnit(db: Db, id: string, now: Date = new Date()): Promise<void> {
  const unit = await db.orgUnit.findFirst({ where: { id, deletedAt: null }, select: { id: true, parentId: true, path: true } });
  if (!unit) throw new HttpError(404, 'org_unit_not_found', 'No such unit.');
  const children = await db.orgUnit.findMany({ where: { parentId: id, deletedAt: null }, select: { id: true } });
  for (const c of children) await updateOrgUnit(db, c.id, { parentId: unit.parentId });
  await db.site.updateMany({ where: { orgUnitId: id }, data: { orgUnitId: null } });
  await db.user.updateMany({ where: { orgUnitId: id }, data: { orgUnitId: null, tokenVersion: { increment: 1 } } });
  await db.associate.updateMany({ where: { orgUnitId: id }, data: { orgUnitId: null } });
  await db.position.updateMany({ where: { orgUnitId: id }, data: { orgUnitId: null } });
  await db.orgUnit.update({ where: { id }, data: { deletedAt: now, isActive: false } });
}

/** Full replacement of the sites pinned directly to a unit. */
export async function setOrgUnitSites(db: Db, id: string, locationIds: string[]): Promise<void> {
  const unit = await db.orgUnit.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
  if (!unit) throw new HttpError(404, 'org_unit_not_found', 'No such unit.');
  await db.site.updateMany({ where: { orgUnitId: id }, data: { orgUnitId: null } });
  if (locationIds.length) await db.site.updateMany({ where: { id: { in: locationIds }, deletedAt: null }, data: { orgUnitId: id } });
}

/** Every live site under a unit (the unit's own and its descendants'). */
export async function siteIdsUnder(db: Db, unitId: string): Promise<string[]> {
  const unit = await db.orgUnit.findFirst({ where: { id: unitId, deletedAt: null }, select: { path: true } });
  if (!unit) return [];
  const rows = await db.site.findMany({ where: { deletedAt: null, orgUnit: { path: underPath(unit.path), deletedAt: null } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/* ===== The Region mirror (until Region is dropped) ========================= */

export async function regionUnit(db: Db, regionId: string): Promise<{ id: string; path: string } | null> {
  return db.orgUnit.findFirst({ where: { legacyRegionId: regionId, deletedAt: null }, select: { id: true, path: true } });
}

/** A Region's unit, made on first use for a region the migration did not see. */
export async function ensureRegionUnit(db: Db, region: { id: string; name: string; tenantId?: string | null }): Promise<{ id: string; path: string }> {
  const existing = await regionUnit(db, region.id);
  if (existing) return existing;
  const u = await createOrgUnit(db, { type: 'REGION', name: region.name, legacyRegionId: region.id }, region.tenantId ?? ALTO_TENANT_ID);
  return { id: u.id, path: u.path };
}

/** The region's unit path, for an "under" check on a row already loaded with its site's unit. */
export async function regionUnitPath(db: Db, regionId: string): Promise<string | null> {
  return (await regionUnit(db, regionId))?.path ?? null;
}

/**
 * The sites a region account can see: every site under the region's unit,
 * and every site that still names the region directly. Region stays a
 * mirror until it is retired, and a site tagged with a region (the
 * backfill, a write that predates the unit, a region made outside its admin
 * route) must not fall out of its own command center. Never wider than
 * the region: both halves are the region's own.
 */
export async function regionSiteIds(db: Db, regionId: string): Promise<string[]> {
  const u = await regionUnit(db, regionId);
  const [underUnit, tagged] = await Promise.all([
    u ? siteIdsUnder(db, u.id) : Promise.resolve([] as string[]),
    db.site.findMany({ where: { regionId, deletedAt: null }, select: { id: true } }),
  ]);
  return [...new Set([...underUnit, ...tagged.map((s) => s.id)])];
}

/* ===== The CostCenter mirror ============================================== */

export async function ensureCostCenterUnit(db: Db, cc: { id: string; name: string; code: string; clientId: string | null; tenantId?: string | null }): Promise<{ id: string }> {
  const existing = await db.orgUnit.findFirst({ where: { legacyCostCenterId: cc.id, deletedAt: null }, select: { id: true } });
  if (existing) return existing;
  const u = await createOrgUnit(db, { type: 'COST_CENTER', name: cc.name, code: cc.code, clientId: cc.clientId, legacyCostCenterId: cc.id }, cc.tenantId ?? ALTO_TENANT_ID);
  return { id: u.id };
}
