import { Router, type Request } from 'express';
import { z } from 'zod';
import { FixedAssetCreateInputSchema, FixedAssetDisposeInputSchema, FixedAssetUpdateInputSchema } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { disposeAsset, lastEndedPeriod, runDepreciation } from '../../lib/books/assets/depreciation.js';
import { createFixedAsset, fixedAssetDetail, listFixedAssets, updateFixedAsset } from '../../lib/books/assets/register.js';

/** /books/assets — the fixed-asset register and its depreciation (lib/books/assets). */
export const booksAssetsRouter = Router();
const MANAGE = requireCapability('manage:books');
const UUID = z.string().uuid();
const id = (req: Request) => {
  const r = UUID.safeParse(req.params.id);
  if (!r.success) throw new HttpError(404, 'asset_not_found', 'Fixed asset not found.');
  return r.data;
};
const audit = (req: Request, action: string, entityId: string, metadata: Record<string, unknown>) =>
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action, entityType: 'FixedAsset', entityId, metadata: metadata as never }, 'books.assets');

booksAssetsRouter.get('/', async (_req, res) => {
  res.json(await listFixedAssets(prisma));
});

booksAssetsRouter.post('/depreciation/run', MANAGE, async (req, res) => {
  const through = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().parse(req.query.through || undefined) ?? lastEndedPeriod();
  if (through > lastEndedPeriod()) throw new HttpError(400, 'month_not_ended', 'Depreciation posts for months that have ended.');
  const r = await runDepreciation(prisma, through, { userId: req.user!.id });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'books.depreciation.run', entityType: 'FixedAsset', entityId: 'depreciation', metadata: { through, ...r } }, 'books.assets');
  res.json({ through, ...r });
});

booksAssetsRouter.post('/', MANAGE, async (req, res) => {
  const input = FixedAssetCreateInputSchema.parse(req.body);
  const asset = await createFixedAsset(prisma, input, req.user!.id);
  audit(req, 'books.asset.created', asset.id, { name: asset.name, cost: asset.cost, acquisition: !!input.acquisition });
  res.status(201).json({ asset });
});

booksAssetsRouter.get('/:id', async (req, res) => {
  res.json({ asset: await fixedAssetDetail(prisma, id(req)) });
});

booksAssetsRouter.patch('/:id', MANAGE, async (req, res) => {
  const input = FixedAssetUpdateInputSchema.parse(req.body);
  const asset = await updateFixedAsset(prisma, id(req), input);
  audit(req, 'books.asset.updated', asset.id, input as Record<string, unknown>);
  res.json({ asset });
});

booksAssetsRouter.post('/:id/dispose', MANAGE, async (req, res) => {
  const input = FixedAssetDisposeInputSchema.parse(req.body);
  const before = await fixedAssetDetail(prisma, id(req));
  if (before.status === 'DISPOSED') throw new HttpError(409, 'already_disposed', 'This asset is already disposed of.');
  if (input.disposedOn < before.inServiceOn) throw new HttpError(400, 'disposed_before_service', 'It can’t be disposed of before it went into service.');
  if (input.proceeds > 0 && !input.proceedsAccountId) throw new HttpError(400, 'proceeds_account_required', 'Say which account the proceeds went to.');
  await disposeAsset(prisma, before.id, { disposedOn: input.disposedOn, proceeds: input.proceeds, proceedsAccountId: input.proceedsAccountId ?? null, note: input.note ?? null, userId: req.user!.id });
  const asset = await fixedAssetDetail(prisma, before.id);
  audit(req, 'books.asset.disposed', asset.id, { disposedOn: input.disposedOn, proceeds: input.proceeds });
  res.json({ asset });
});
