import { Router, type Request } from 'express';
import { AccrualCreateInputSchema, CloseReopenInputSchema, CloseTaskUpdateInputSchema } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { requireCapability } from '../../middleware/auth.js';
import { pendingResponse } from '../../lib/approvalRequests.js';
import { accrualsFor, assertPeriodKey, closeDetail, closeList, createAccrual, markReady, requestReopen, signOff, unready, updateTask, type Actor } from '../../lib/books/close/period.js';
import { monthEnd } from '../../lib/books/assets/depreciation.js';
import { backfillPosting } from '../../lib/books/posting/gaps.js';
import { finalizeStatement } from '../../lib/statementFinalize.js';
import { enqueueAudit } from '../../lib/audit.js';
import { tenantIdForWrite } from '../../lib/tenant.js';

/**
 * /books/close — the month-end close (lib/books/close). Reads need
 * view:books (the parent router); every write needs manage:books, and
 * the sign-off a SECOND person with it.
 */
export const booksCloseRouter = Router();
const MANAGE = requireCapability('manage:books');
const actor = (req: Request): Actor => req.user! as unknown as Actor;
const key = (req: Request) => String(req.params.periodKey);

booksCloseRouter.get('/', async (_req, res) => {
  res.json(await closeList(prisma));
});

booksCloseRouter.post('/accruals', MANAGE, async (req, res) => {
  const input = AccrualCreateInputSchema.parse(req.body);
  res.status(201).json(await createAccrual(prisma, input, actor(req)));
});

booksCloseRouter.get('/:periodKey', async (req, res) => {
  res.json(await closeDetail(prisma, key(req), actor(req)));
});

booksCloseRouter.get('/:periodKey/accruals', async (req, res) => {
  res.json(await accrualsFor(prisma, key(req)));
});

booksCloseRouter.post('/:periodKey/tasks/:key', MANAGE, async (req, res) => {
  const input = CloseTaskUpdateInputSchema.parse(req.body);
  await updateTask(prisma, key(req), String(req.params.key), input, actor(req));
  res.json(await closeDetail(prisma, key(req), actor(req)));
});

/**
 * Finance walk 16 — two steps done from the checklist itself. Each answers
 * with the refreshed month, so the step's own check says what's left.
 */
booksCloseRouter.post('/:periodKey/finalize-statements', MANAGE, async (req, res) => {
  const periodKey = key(req);
  assertPeriodKey(periodKey);
  const tenantId = tenantIdForWrite();
  const drafts = await prisma.clientStatement.findMany({
    where: { tenantId, status: 'DRAFT', periodEnd: { gte: new Date(`${periodKey}-01T00:00:00.000Z`), lte: new Date(`${monthEnd(periodKey)}T00:00:00.000Z`) } },
    select: { id: true, clientId: true, client: { select: { name: true } } },
    take: 200,
  });
  const finalized: string[] = [];
  const failed: Array<{ id: string; clientName: string; error: string }> = [];
  for (const d of drafts) {
    try {
      await finalizeStatement(prisma, d.id, req.user!.id, { clientId: d.clientId });
      finalized.push(d.id);
    } catch (err) {
      failed.push({ id: d.id, clientName: d.client.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.close_statements_finalized', entityType: 'FiscalPeriod', entityId: periodKey, metadata: { finalized: finalized.length, failed: failed.length } }, 'books.close');
  res.json({ finalized: finalized.length, failed, month: await closeDetail(prisma, periodKey, actor(req)) });
});

booksCloseRouter.post('/:periodKey/post-history', MANAGE, async (req, res) => {
  const periodKey = key(req);
  assertPeriodKey(periodKey);
  const result = await backfillPosting(prisma, { since: new Date(`${periodKey}-01T00:00:00.000Z`) });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.posting_backfilled', entityType: 'FiscalPeriod', entityId: periodKey, metadata: { ...result, failed: result.failed.length } }, 'books.close');
  res.json({ ...result, month: await closeDetail(prisma, periodKey, actor(req)) });
});

booksCloseRouter.post('/:periodKey/ready', MANAGE, async (req, res) => {
  await markReady(prisma, key(req), actor(req));
  res.json(await closeDetail(prisma, key(req), actor(req)));
});

booksCloseRouter.post('/:periodKey/unready', MANAGE, async (req, res) => {
  await unready(prisma, key(req), actor(req));
  res.json(await closeDetail(prisma, key(req), actor(req)));
});

booksCloseRouter.post('/:periodKey/sign-off', MANAGE, async (req, res) => {
  await signOff(prisma, key(req), actor(req));
  res.json(await closeDetail(prisma, key(req), actor(req)));
});

booksCloseRouter.post('/:periodKey/reopen', MANAGE, async (req, res) => {
  const { reason } = CloseReopenInputSchema.parse(req.body);
  const row = await requestReopen(prisma, key(req), reason, actor(req));
  res.status(202).json(pendingResponse(row));
});
