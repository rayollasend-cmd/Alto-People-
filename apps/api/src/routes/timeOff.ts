import { Router } from 'express';
import {
  TimeOffMyBalanceResponseSchema,
  type TimeOffBalance,
  type TimeOffLedgerEntry,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';

export const timeOffRouter = Router();

/**
 * Phase 26 — read endpoint for an associate's accrued time-off balances
 * (today: SICK only) plus their last 50 ledger entries. Everything is
 * scoped to req.user.associateId; HR-side queries land in a later phase
 * once the request/approval workflow ships.
 */
timeOffRouter.get('/me/balance', async (req, res, next) => {
  try {
    const user = req.user!;
    if (!user.associateId) {
      throw new HttpError(403, 'not_an_associate', 'Only associates have time-off balances');
    }

    const [balances, ledger] = await Promise.all([
      prisma.timeOffBalance.findMany({
        where: { associateId: user.associateId },
        orderBy: { category: 'asc' },
      }),
      prisma.timeOffLedgerEntry.findMany({
        where: { associateId: user.associateId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const payload = TimeOffMyBalanceResponseSchema.parse({
      balances: balances.map<TimeOffBalance>((b) => ({
        category: b.category,
        balanceMinutes: b.balanceMinutes,
      })),
      recentLedger: ledger.map<TimeOffLedgerEntry>((l) => ({
        id: l.id,
        category: l.category,
        reason: l.reason,
        deltaMinutes: l.deltaMinutes,
        sourceTimeEntryId: l.sourceTimeEntryId,
        notes: l.notes,
        createdAt: l.createdAt.toISOString(),
      })),
    });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});
