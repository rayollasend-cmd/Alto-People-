import { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { loadPlan, planIsSet } from '../lib/execFinance.js';
import { computeExecClients } from '../lib/execClients.js';
import { computeExecPeople } from '../lib/execPeople.js';
import { parseExecQuery, quarterOf, quartersBetween, resolveExecWindow, type ExecWindow } from '../lib/execPeriods.js';
import { computeExecRisks } from '../lib/execRisks.js';
import { isInternallyScoped } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * The executive portal's drill-downs (2026-10-27): /executive/clients,
 * /executive/people and /executive/risks — the chairman's Clients, People
 * and Risk pages and the board pack's matching pages. Mounted beside
 * routes/executive.ts on the same /executive prefix; the overview,
 * financials, targets and board pack live there. Shapes:
 * packages/shared/src/executivePortal.ts. Windows: lib/execPeriods.ts.
 *
 *   GET /executive/clients?period=&compare=  → ExecClients  (lib/execClients)
 *   GET /executive/people?period=&compare=   → ExecPeople   (lib/execPeople)
 *   GET /executive/risks                     → ExecRisks    (lib/execRisks)
 *
 * view:executive, and the whole company: an office account narrowed to
 * sites or regions is refused rather than shown a company picture (and
 * other stores' people) it may not hold — the same rule as routes/executive.
 */
export const executivePortalRouter = Router();

export const EXEC_READ = requireCapability('view:executive');

executivePortalRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.user && isInternallyScoped(req.user)) {
    next(new HttpError(403, 'scope_too_narrow', 'The executive view covers the whole company; your access is limited to certain sites.'));
    return;
  }
  next();
});

/** The request's frame: `?period=&compare=`, with the plan comparison available only when the quarter has a plan. */
export async function execWindowFor(query: Record<string, unknown>, now: Date = new Date()): Promise<ExecWindow> {
  const { period, compare } = parseExecQuery(query);
  const first = resolveExecWindow(period, compare, now, { planSet: false });
  const quarterKeys = quartersBetween(first.from, first.to, first.timezone).map((q) => q.key);
  if (quarterKeys.length === 0) quarterKeys.push(quarterOf(first.from, first.timezone).key);
  const plan = await loadPlan(prisma, tenantIdForWrite(), quarterKeys);
  return resolveExecWindow(period, compare, now, { planSet: planIsSet(plan, quarterKeys), quarterKey: quarterKeys[quarterKeys.length - 1] });
}

executivePortalRouter.get('/clients', EXEC_READ, async (req: Request, res: Response) => {
  res.json(await computeExecClients(prisma, await execWindowFor(req.query)));
});

executivePortalRouter.get('/people', EXEC_READ, async (req: Request, res: Response) => {
  res.json(await computeExecPeople(prisma, await execWindowFor(req.query)));
});

executivePortalRouter.get('/risks', EXEC_READ, async (_req: Request, res: Response) => {
  res.json(await computeExecRisks(prisma, new Date()));
});
