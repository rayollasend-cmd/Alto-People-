import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Brief 2-1 — closing the cross-tenant leaks before enforce mode.
 *
 * TENANCY_MODE is still "observe", so nothing filters by tenant on its
 * own. A route that resolves a row by an id from the URL calls this
 * first: when the row exists and belongs to ANOTHER tenant, the request
 * ends in a 404 exactly as if the row did not exist. When the row is the
 * caller's, or does not exist at all, nothing happens and the handler
 * runs unchanged — so a missing row keeps the handler's own 404 and
 * every response for a single-tenant install is byte-identical.
 */

type TenantRow = { tenantId: string | null } | null;

const FINDERS = {
  associate: (id: string) => prisma.associate.findUnique({ where: { id }, select: { tenantId: true } }),
  user: (id: string) => prisma.user.findUnique({ where: { id }, select: { tenantId: true } }),
  garnishment: (id: string) => prisma.garnishment.findUnique({ where: { id }, select: { tenantId: true } }),
  meritCycle: (id: string) => prisma.meritCycle.findUnique({ where: { id }, select: { tenantId: true } }),
} satisfies Record<string, (id: string) => Promise<TenantRow>>;

export type SameTenantModel = keyof typeof FINDERS;

/** True when the row exists and belongs to a tenant other than the caller's. */
export async function belongsToAnotherTenant(model: SameTenantModel, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const row = await FINDERS[model](id);
  return !!row && row.tenantId !== null && row.tenantId !== tenantIdForWrite();
}

/** 404 when the row is another tenant's; otherwise a no-op. */
export async function assertSameTenant(model: SameTenantModel, id: string): Promise<void> {
  if (await belongsToAnotherTenant(model, id)) throw new HttpError(404, 'not_found', 'Not found');
}
