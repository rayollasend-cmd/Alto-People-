import { Router } from 'express';
import { z } from 'zod';
import { can } from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { assertSiteInScope, isInternallyScoped } from '../lib/scope.js';
import { ensureRegionUnit } from '../lib/orgUnits.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { placeSite } from '../lib/structure.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import type { SessionUser } from '../types/express.js';

/**
 * The business structure, edited in one place (the Org chart's field view).
 *
 *   GET    /org/structure/options                 regions, cost centers, clients — the pickers
 *   GET    /org/structure/sites/:id               one site's details for the drawer
 *   POST   /org/structure/regions                 a region (and its unit in the tree)
 *   PATCH  /org/structure/regions/:id             rename
 *   DELETE /org/structure/regions/:id             retire; its stores stay, unplaced
 *   PUT    /org/structure/sites/:id/placement     region and/or cost center (lib/structure.placeSite)
 *   POST   /org/structure/sites                   a store for a client, or a property of your own
 *
 * Not gated on the client portal: a direct employer (a hotel group) has
 * regions and properties too. Moving stores between regions and adding
 * sites is for someone who manages the whole organization — an account
 * narrowed to some sites can't move one out of its own reach.
 */
export const structureRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

function wholeOrgOnly(user: SessionUser, what: string): void {
  if (isInternallyScoped(user)) {
    throw new HttpError(403, 'scoped_account', `Only someone who manages the whole organization can ${what}.`);
  }
}

structureRouter.get('/org/structure/options', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const profile = await loadTenantProfile(tenantId);
  const [regions, units, clients] = await Promise.all([
    prisma.region.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
    prisma.orgUnit.findMany({
      where: { tenantId, deletedAt: null, isActive: true },
      select: { id: true, type: true, name: true, code: true, glCode: true, path: true, legacyRegionId: true },
      orderBy: { path: 'asc' },
      take: 2000,
    }),
    profile.modules.clientPortal
      ? prisma.client.findMany({ where: { tenantId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);
  // Which region (if any) each cost center sits under: the nearest REGION ancestor on its path.
  const regionByUnitId = new Map(units.filter((u) => u.type === 'REGION' && u.legacyRegionId).map((u) => [u.id, u.legacyRegionId!]));
  const costCenters = units
    .filter((u) => u.type !== 'REGION')
    .map((u) => {
      const ancestors = u.path.split('/').filter(Boolean).slice(0, -1).reverse();
      const regionId = ancestors.map((id) => regionByUnitId.get(id)).find(Boolean) ?? null;
      return { id: u.id, type: u.type, name: u.name, code: u.code, glCode: u.glCode, regionId };
    });
  res.json({ regions, costCenters, clients, businessModel: profile.businessModel });
});

structureRouter.get('/org/structure/sites/:id', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  await assertSiteInScope(prisma, req.user!, id);
  const s = await prisma.site.findFirst({
    where: { id, tenantId: tenantIdForWrite(), deletedAt: null },
    select: {
      id: true,
      name: true,
      type: true,
      timezone: true,
      isActive: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      zip: true,
      clientId: true,
      client: { select: { name: true } },
      regionId: true,
      orgUnitId: true,
      orgUnit: { select: { name: true, type: true, code: true, glCode: true } },
    },
  });
  if (!s) throw new HttpError(404, 'site_not_found', 'That site does not exist.');
  res.json({
    site: {
      ...s,
      clientName: s.client?.name ?? null,
      // A pin to the region's own unit is "no cost center", not a cost center called the region.
      costCenter: s.orgUnit && s.orgUnit.type !== 'REGION' ? { id: s.orgUnitId, name: s.orgUnit.name, code: s.orgUnit.code, glCode: s.orgUnit.glCode } : null,
      client: undefined,
      orgUnit: undefined,
    },
  });
});

const RegionName = z.object({ name: z.string().trim().min(2).max(120) });

structureRouter.post('/org/structure/regions', MANAGE, async (req, res) => {
  wholeOrgOnly(req.user!, 'add regions');
  const { name } = RegionName.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const region = await prisma.$transaction(async (tx) => {
    const r = await tx.region.create({ data: { name, tenantId }, select: { id: true, name: true, tenantId: true } });
    await ensureRegionUnit(tx, r);
    return r;
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'region.created', entityType: 'Region', entityId: region.id, metadata: { name } }, 'structure');
  res.status(201).json({ region: { id: region.id, name: region.name } });
});

structureRouter.patch('/org/structure/regions/:id', MANAGE, async (req, res) => {
  wholeOrgOnly(req.user!, 'rename regions');
  const id = z.string().uuid().parse(req.params.id);
  const { name } = RegionName.parse(req.body ?? {});
  const region = await prisma.region.findFirst({ where: { id, tenantId: tenantIdForWrite(), deletedAt: null }, select: { id: true, name: true, tenantId: true } });
  if (!region) throw new HttpError(404, 'region_not_found', 'That region does not exist.');
  await prisma.$transaction(async (tx) => {
    const unit = await ensureRegionUnit(tx, region);
    await tx.region.update({ where: { id }, data: { name } });
    await tx.orgUnit.update({ where: { id: unit.id }, data: { name } });
  });
  enqueueAudit({ actorUserId: req.user!.id, action: 'region.renamed', entityType: 'Region', entityId: id, metadata: { from: region.name, to: name } }, 'structure');
  res.json({ region: { id, name } });
});

structureRouter.delete('/org/structure/regions/:id', MANAGE, async (req, res) => {
  wholeOrgOnly(req.user!, 'retire regions');
  const id = z.string().uuid().parse(req.params.id);
  const region = await prisma.region.findFirst({ where: { id, tenantId: tenantIdForWrite(), deletedAt: null }, select: { id: true, name: true } });
  if (!region) throw new HttpError(404, 'region_not_found', 'That region does not exist.');
  const now = new Date();
  const stores = await prisma.site.count({ where: { regionId: id, deletedAt: null } });
  await prisma.$transaction([
    prisma.site.updateMany({ where: { regionId: id }, data: { regionId: null } }),
    // Region accounts lose their region: their sessions end so the change is felt at once.
    prisma.user.updateMany({ where: { regionId: id }, data: { regionId: null, tokenVersion: { increment: 1 } } }),
    prisma.region.update({ where: { id }, data: { deletedAt: now } }),
    prisma.site.updateMany({ where: { orgUnit: { is: { legacyRegionId: id } } }, data: { orgUnitId: null } }),
    prisma.user.updateMany({ where: { orgUnit: { is: { legacyRegionId: id } } }, data: { orgUnitId: null } }),
    prisma.orgUnit.updateMany({ where: { legacyRegionId: id, deletedAt: null }, data: { deletedAt: now, isActive: false } }),
  ]);
  enqueueAudit({ actorUserId: req.user!.id, action: 'region.retired', entityType: 'Region', entityId: id, metadata: { name: region.name, storesUnplaced: stores } }, 'structure');
  res.status(204).end();
});

const Placement = z
  .object({ regionId: z.string().uuid().nullable().optional(), orgUnitId: z.string().uuid().nullable().optional() })
  .refine((v) => v.regionId !== undefined || v.orgUnitId !== undefined, { message: 'Nothing to change.' });

structureRouter.put('/org/structure/sites/:id/placement', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = Placement.parse(req.body ?? {});
  await assertSiteInScope(prisma, req.user!, id);
  if (input.regionId !== undefined) wholeOrgOnly(req.user!, 'move stores between regions');
  const before = await prisma.site.findFirst({ where: { id, tenantId: tenantIdForWrite() }, select: { regionId: true, orgUnitId: true, name: true } });
  const result = await prisma.$transaction((tx) => placeSite(tx, id, input));
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: 'site.placed',
      entityType: 'Location',
      entityId: id,
      metadata: { name: before?.name ?? null, from: { regionId: before?.regionId ?? null, orgUnitId: before?.orgUnitId ?? null }, to: { ...result } },
    },
    'structure',
  );
  res.json(result);
});

const NewSite = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['STORE', 'PROPERTY', 'OFFICE', 'WAREHOUSE', 'OTHER']).optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().length(2).toUpperCase().nullable().optional(),
  zip: z.string().trim().max(20).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  regionId: z.string().uuid().nullable().optional(),
});

structureRouter.post('/org/structure/sites', MANAGE, async (req, res) => {
  wholeOrgOnly(req.user!, 'add sites');
  const input = NewSite.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const profile = await loadTenantProfile(tenantId);
  if (input.clientId) {
    // A client's store is also the client's record: the same right as adding it from the client.
    if (!can(req.user!, 'manage:clients')) throw new HttpError(403, 'forbidden', 'Adding a store to a client needs the right to manage clients.');
    const client = await prisma.client.findFirst({ where: { id: input.clientId, tenantId, deletedAt: null }, select: { id: true } });
    if (!client) throw new HttpError(404, 'client_not_found', 'That client does not exist.');
  }
  const site = await prisma.$transaction(async (tx) => {
    const created = await tx.site.create({
      data: {
        tenantId,
        clientId: input.clientId ?? null,
        name: input.name,
        // A workforce provider's sites are stores; a direct employer's are properties.
        type: input.type ?? (profile.businessModel === 'DIRECT_EMPLOYER' ? 'PROPERTY' : 'STORE'),
        addressLine1: input.addressLine1 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        zip: input.zip ?? null,
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
      select: { id: true, name: true, type: true, clientId: true },
    });
    if (input.regionId) await placeSite(tx, created.id, { regionId: input.regionId });
    return created;
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: input.clientId ?? null, action: 'site.created', entityType: 'Location', entityId: site.id, metadata: { name: site.name, regionId: input.regionId ?? null } }, 'structure');
  res.status(201).json({ site });
});
