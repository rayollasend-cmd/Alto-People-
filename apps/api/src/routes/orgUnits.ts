import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { createOrgUnit, deleteOrgUnit, getOrgUnit, listOrgUnits, setOrgUnitSites, siteIdsUnder, updateOrgUnit } from '../lib/orgUnits.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { LocationCreateInputSchema } from '@alto-people/shared';
import { HttpError } from '../middleware/error.js';

/**
 * Brief 2-1b, step 5 — the organizational tree.
 *
 *   GET    /admin/org-units            the tenant's units, path order (a tree in one list)
 *   POST   /admin/org-units            a unit under a parent (or at the root)
 *   PATCH  /admin/org-units/:id        rename, code, GL code, move, active
 *   DELETE /admin/org-units/:id        soft delete; children move up, sites and people unpinned
 *   PUT    /admin/org-units/:id/sites  the sites pinned directly to the unit
 *   GET    /admin/org-units/:id/sites  every site under the unit, its descendants included
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
  const created = await prisma.location.create({
    data: {
      clientId: null,
      orgUnitId: input.orgUnitId ?? null,
      // A direct employer's site is a property unless it says otherwise.
      type: input.type ?? 'PROPERTY',
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

orgUnitsRouter.get('/admin/sites', VIEW, async (_req, res) => {
  const rows = await prisma.location.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, type: true, timezone: true, state: true, isActive: true, clientId: true, orgUnitId: true, client: { select: { name: true } }, orgUnit: { select: { name: true, type: true } } },
    orderBy: [{ clientId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
  });
  res.json({ sites: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, timezone: r.timezone, state: r.state, isActive: r.isActive, clientId: r.clientId, clientName: r.client?.name ?? null, orgUnitId: r.orgUnitId, orgUnitName: r.orgUnit?.name ?? null, orgUnitType: r.orgUnit?.type ?? null })) });
});

orgUnitsRouter.get('/admin/org-units/:id/sites', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const ids = await siteIdsUnder(prisma, id);
  const sites = ids.length
    ? await prisma.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, clientId: true, orgUnitId: true, client: { select: { name: true } } }, orderBy: { name: 'asc' } })
    : [];
  res.json({ sites: sites.map((s) => ({ id: s.id, name: s.name, clientId: s.clientId, clientName: s.client?.name ?? null, orgUnitId: s.orgUnitId })) });
});
