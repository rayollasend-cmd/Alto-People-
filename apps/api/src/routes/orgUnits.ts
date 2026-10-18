import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { createOrgUnit, deleteOrgUnit, getOrgUnit, listOrgUnits, setOrgUnitSites, siteIdsUnder, updateOrgUnit } from '../lib/orgUnits.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { LocationCreateInputSchema, LocationUpdateInputSchema } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';
import { loadTenantProfile } from '../lib/tenantProfile.js';
import { placeSite } from '../lib/structure.js';

/**
 * Brief 2-1b, step 5 — the organizational tree.
 *
 *   GET    /admin/org-units            the tenant's units, path order (a tree in one list)
 *   POST   /admin/org-units            a unit under a parent (or at the root)
 *   PATCH  /admin/org-units/:id        rename, code, GL code, move, active
 *   DELETE /admin/org-units/:id        soft delete; children move up, sites and people unpinned
 *   PUT    /admin/org-units/:id/sites  the sites pinned directly to the unit
 *   GET    /admin/org-units/:id/sites  every site under the unit, its descendants included
 *   POST   /admin/sites                a site with no client, optionally under a unit
 *   PATCH  /admin/sites/:id            name, type, address, time zone, unit, active
 *   GET    /admin/sites                every site with its unit
 */
export const orgUnitsRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const UnitInput = z.object({
  type: z.enum(['DIVISION', 'REGION', 'BUSINESS_UNIT', 'COST_CENTER']),
  name: z.string().trim().min(1).max(160),
  parentId: z.string().uuid().nullable().optional(),
  code: z.string().trim().max(40).nullable().optional(),
  glCode: z.string().trim().max(40).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
});

orgUnitsRouter.get('/admin/org-units', VIEW, async (_req, res) => {
  res.json({ units: await listOrgUnits(prisma) });
});

orgUnitsRouter.post('/admin/org-units', MANAGE, async (req, res) => {
  const input = UnitInput.parse(req.body);
  const unit = await createOrgUnit(prisma, input, tenantIdForWrite());
  enqueueAudit({ actorUserId: req.user!.id, clientId: input.clientId ?? null, action: 'org_unit.created', entityType: 'OrgUnit', entityId: unit.id, metadata: { type: unit.type, name: unit.name, parentId: unit.parentId } }, 'org');
  res.status(201).json({ unit });
});

orgUnitsRouter.patch('/admin/org-units/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = UnitInput.omit({ type: true }).partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
  const unit = await updateOrgUnit(prisma, id, input);
  enqueueAudit({ actorUserId: req.user!.id, clientId: unit.clientId, action: 'org_unit.updated', entityType: 'OrgUnit', entityId: id, metadata: { changed: Object.keys(input) } }, 'org');
  res.json({ unit });
});

orgUnitsRouter.delete('/admin/org-units/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const unit = await getOrgUnit(prisma, id);
  await deleteOrgUnit(prisma, id);
  enqueueAudit({ actorUserId: req.user!.id, clientId: unit?.clientId ?? null, action: 'org_unit.deleted', entityType: 'OrgUnit', entityId: id, metadata: { name: unit?.name ?? null } }, 'org');
  res.status(204).end();
});

orgUnitsRouter.put('/admin/org-units/:id/sites', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = z.object({ locationIds: z.array(z.string().uuid()).max(500) }).parse(req.body);
  await setOrgUnitSites(prisma, id, input.locationIds);
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'org_unit.sites_set', entityType: 'OrgUnit', entityId: id, metadata: { sites: input.locationIds.length } }, 'org');
  res.status(204).end();
});

/**
 * A direct employer's sites carry no client. POST creates one (optionally
 * under a unit); GET lists every site with its unit.
 */
orgUnitsRouter.post('/admin/sites', MANAGE, async (req, res) => {
  const input = LocationCreateInputSchema.extend({ orgUnitId: z.string().uuid().nullable().optional() }).parse(req.body);
  if (input.orgUnitId) {
    const unit = await getOrgUnit(prisma, input.orgUnitId);
    if (!unit) throw new HttpError(400, 'org_unit_not_found', 'That unit does not exist.');
  }
  const created = await prisma.site.create({
    data: {
      clientId: null,
      orgUnitId: input.orgUnitId ?? null,
      // A workforce provider's sites are stores; a direct employer's are properties.
      type: input.type ?? ((await loadTenantProfile()).businessModel === 'DIRECT_EMPLOYER' ? 'PROPERTY' : 'STORE'),
      name: input.name,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    select: { id: true, name: true, timezone: true, orgUnitId: true, state: true, type: true },
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'site.created', entityType: 'Location', entityId: created.id, metadata: { name: created.name, orgUnitId: created.orgUnitId } }, 'org');
  res.status(201).json({ site: created });
});

/** A site's name, type, address, time zone, unit or active flag; a client's store edits through its client, the same way. */
orgUnitsRouter.patch('/admin/sites/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = LocationUpdateInputSchema.partial().extend({ orgUnitId: z.string().uuid().nullable().optional() }).strict().parse(req.body);
  const existing = await prisma.site.findFirst({ where: { id, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true, name: true, orgUnitId: true, clientId: true } });
  if (!existing) throw new HttpError(404, 'site_not_found', 'That site does not exist.');
  // A client's store is the client's record: its name, address, hours and status change there.
  const identity = Object.keys(input).filter((k) => k !== 'orgUnitId');
  if (existing.clientId && identity.length > 0) {
    throw new HttpError(409, 'client_store', 'This store belongs to a client — edit it from the client’s page.');
  }
  // Where it sits (its cost center) goes through the one placement rule.
  if (input.orgUnitId !== undefined) await placeSite(prisma, id, { orgUnitId: input.orgUnitId }, { allowRegionUnits: true });
  const updated = await prisma.site.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
      ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.zip !== undefined ? { zip: input.zip } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    select: { id: true, name: true, type: true, timezone: true, state: true, isActive: true, clientId: true, orgUnitId: true },
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: updated.clientId, action: 'site.updated', entityType: 'Location', entityId: id, metadata: { fields: Object.keys(input), from: { name: existing.name, orgUnitId: existing.orgUnitId } } }, 'org');
  res.json({ site: updated });
});

orgUnitsRouter.get('/admin/sites', VIEW, async (_req, res) => {
  // Explicit tenant: the guard only observes until enforce mode (cross-tenant suite).
  const rows = await prisma.site.findMany({
    where: { deletedAt: null, tenantId: tenantIdForWrite() },
    select: { id: true, name: true, type: true, timezone: true, state: true, isActive: true, clientId: true, orgUnitId: true, regionId: true, client: { select: { name: true } }, orgUnit: { select: { name: true, type: true } }, region: { select: { name: true } } },
    orderBy: [{ clientId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
  });
  res.json({ sites: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, timezone: r.timezone, state: r.state, isActive: r.isActive, clientId: r.clientId, clientName: r.client?.name ?? null, orgUnitId: r.orgUnitId, orgUnitName: r.orgUnit?.name ?? null, orgUnitType: r.orgUnit?.type ?? null, regionId: r.regionId, regionName: r.region?.name ?? null })) });
});

orgUnitsRouter.get('/admin/org-units/:id/sites', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  // Another tenant's unit is not found (the cross-tenant suite counts a 2xx on a foreign id as a leak).
  const unit = await prisma.orgUnit.findFirst({ where: { id, deletedAt: null, tenantId: tenantIdForWrite() }, select: { id: true } });
  if (!unit) throw new HttpError(404, 'org_unit_not_found', 'That unit does not exist.');
  const ids = await siteIdsUnder(prisma, id);
  const sites = ids.length
    ? await prisma.site.findMany({ where: { id: { in: ids }, tenantId: tenantIdForWrite() }, select: { id: true, name: true, clientId: true, orgUnitId: true, client: { select: { name: true } } }, orderBy: { name: 'asc' } })
    : [];
  res.json({ sites: sites.map((s) => ({ id: s.id, name: s.name, clientId: s.clientId, clientName: s.client?.name ?? null, orgUnitId: s.orgUnitId })) });
});
