import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '../middleware/error.js';
import { ensureRegionUnit, regionUnit } from './orgUnits.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Where a site sits in the business structure — the one rule every editor
 * (the Org chart's field view, Sites, Cost centers) goes through.
 *
 *   A site carries two things: the region it belongs to (Site.regionId) and
 *   the one org unit it is pinned to (Site.orgUnitId). Regions are mirrored
 *   as REGION units, and a region-bound account sees every site under its
 *   unit's path (lib/scope.siteFilter) — so a store's cost center must sit
 *   UNDER its region's unit, or the store would fall out of its own
 *   region's view. Hence:
 *
 *   - moving a store to a region pins it to the region's unit, keeping its
 *     cost center only when that cost center already sits under the new
 *     region (the caller is told when one is cleared);
 *   - choosing a cost center for a store in a region must name one under
 *     that region (409 otherwise, with how to fix it);
 *   - clearing the cost center pins the store back to its region's unit.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Unit types a store can be costed to: the ledger side of the tree. */
const COSTING_TYPES = ['COST_CENTER', 'BUSINESS_UNIT', 'DIVISION'] as const;

export interface PlacementResult {
  regionId: string | null;
  orgUnitId: string | null;
  /** True when a move to another region cleared a cost center that sat outside it. */
  costCenterCleared: boolean;
}

export async function placeSite(
  db: Db,
  siteId: string,
  change: { regionId?: string | null; orgUnitId?: string | null },
  opts: { allowRegionUnits?: boolean } = {},
): Promise<PlacementResult> {
  const tenantId = tenantIdForWrite();
  // Sites (the older editor) may pin to a REGION unit of the tree: a mirrored
  // Region becomes a region move; a tree-only REGION unit is pinned as is.
  if (opts.allowRegionUnits && change.orgUnitId) {
    const target = await db.orgUnit.findFirst({ where: { id: change.orgUnitId, tenantId, deletedAt: null }, select: { type: true, legacyRegionId: true } });
    if (target?.type === 'REGION' && target.legacyRegionId) {
      change = { regionId: target.legacyRegionId };
    }
  }
  const site = await db.site.findFirst({
    where: { id: siteId, tenantId, deletedAt: null },
    select: { id: true, regionId: true, orgUnitId: true, orgUnit: { select: { path: true, type: true, legacyRegionId: true } } },
  });
  if (!site) throw new HttpError(404, 'site_not_found', 'That site does not exist.');

  let regionId = site.regionId;
  let orgUnitId = site.orgUnitId;
  let costCenterCleared = false;

  if (change.regionId !== undefined && change.regionId !== site.regionId) {
    if (change.regionId) {
      const region = await db.region.findFirst({ where: { id: change.regionId, tenantId, deletedAt: null }, select: { id: true, name: true, tenantId: true } });
      if (!region) throw new HttpError(404, 'region_not_found', 'That region does not exist.');
      const unit = await ensureRegionUnit(db, region);
      regionId = region.id;
      // Keep a cost center that already sits under the new region; otherwise pin to the region.
      const keeps = !!site.orgUnit && site.orgUnit.type !== 'REGION' && site.orgUnit.path.startsWith(`${unit.path}/`);
      if (!keeps && site.orgUnitId && site.orgUnit?.type !== 'REGION') costCenterCleared = true;
      orgUnitId = keeps ? site.orgUnitId : unit.id;
    } else {
      regionId = null;
      // Out of every region: a pin to the old region's unit goes; a cost center stays.
      if (site.orgUnit?.type === 'REGION') orgUnitId = null;
    }
  }

  if (change.orgUnitId !== undefined) {
    if (change.orgUnitId) {
      const unit = await db.orgUnit.findFirst({
        where: { id: change.orgUnitId, tenantId, deletedAt: null },
        select: { id: true, type: true, path: true, name: true },
      });
      if (!unit) throw new HttpError(404, 'org_unit_not_found', 'That cost center does not exist.');
      if (!(COSTING_TYPES as readonly string[]).includes(unit.type) && !(opts.allowRegionUnits && unit.type === 'REGION')) {
        throw new HttpError(400, 'not_a_cost_center', 'Pick a cost center or business unit — regions are set with "Move to region".');
      }
      if (regionId) {
        const ru = await regionUnit(db, regionId);
        if (ru && !unit.path.startsWith(`${ru.path}/`)) {
          throw new HttpError(
            409,
            'outside_region',
            `${unit.name} sits outside this store's region. Pick a cost center under the region, or move ${unit.name} under it in Cost centers & ledger codes.`,
          );
        }
      }
      orgUnitId = unit.id;
      costCenterCleared = false;
    } else {
      const ru = regionId ? await regionUnit(db, regionId) : null;
      orgUnitId = ru?.id ?? null;
    }
  }

  if (regionId !== site.regionId || orgUnitId !== site.orgUnitId) {
    await db.site.update({ where: { id: site.id }, data: { regionId, orgUnitId } });
  }
  return { regionId, orgUnitId, costCenterCleared };
}
