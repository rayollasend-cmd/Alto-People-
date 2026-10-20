import { Router, type Request } from 'express';
import { AccrualCreateInputSchema, CloseReopenInputSchema, CloseTaskUpdateInputSchema } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { requireCapability } from '../../middleware/auth.js';
import { pendingResponse } from '../../lib/approvalRequests.js';
import { accrualsFor, closeDetail, closeList, createAccrual, markReady, requestReopen, signOff, unready, updateTask, type Actor } from '../../lib/books/close/period.js';

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
