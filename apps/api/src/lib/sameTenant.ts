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

/**
 * The positive check, for a route that lists a PARENT's children by the
 * parent's id (a cycle's proposals, a course's modules, a survey's
 * questions). The negative check above lets an id that exists nowhere
 * fall through to an empty 2xx, which the cross-tenant suite rightly
 * counts: the route answered for a parent the caller does not have. Here
 * the parent must exist in the caller's tenant (or carry no tenant, as a
 * legacy row may), otherwise 404 — so an existing row of the caller's
 * answers exactly as before, and only a missing or foreign parent changes
 * from an empty list to "not found".
 */
const IN_TENANT = {
  meritCycle: (id: string, t: string) => prisma.meritCycle.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  garnishment: (id: string, t: string) => prisma.garnishment.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  course: (id: string, t: string) => prisma.course.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  documentTemplate: (id: string, t: string) => prisma.documentTemplate.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  jobPosting: (id: string, t: string) => prisma.jobPosting.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  learningPath: (id: string, t: string) => prisma.learningPath.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  survey: (id: string, t: string) => prisma.survey.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
  broadcast: (id: string, t: string) => prisma.broadcast.findFirst({ where: { id, OR: [{ tenantId: t }, { tenantId: null }] }, select: { id: true } }),
} satisfies Record<string, (id: string, tenantId: string) => Promise<{ id: string } | null>>;

export type InTenantModel = keyof typeof IN_TENANT;

/** 404 unless the row exists in the caller's tenant (or carries no tenant). */
export async function assertInTenant(model: InTenantModel, id: string, message = 'Not found'): Promise<void> {
  const found = /^[0-9a-f-]{36}$/i.test(id) ? await IN_TENANT[model](id, tenantIdForWrite()) : null;
  if (!found) throw new HttpError(404, 'not_found', message);
}
