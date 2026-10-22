import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from './audit.js';
import { booksAfterStatement } from './books/posting/hooks.js';
import type { StatementSnapshot } from './clientStatement.js';
import { notifyUser, trackNotificationWork } from './notify.js';
import { claimAdjustmentsForStatement } from './payBillLink.js';
import { finalizationTerms } from './statementDunning.js';

/**
 * Finalizing a client statement — the one path (the statement row's
 * Finalize, the roll-up's bulk finalize, and the month-end close's inline
 * "Finalize N statements" all come here):
 *
 *   record-then-commit   the next sequential number, who finalized it and
 *                        when, the due date on the client's terms, the PO,
 *                        and payroll's adjustments claimed into the frozen
 *                        snapshot — in one transaction
 *   the books            the statement is a receivable and revenue
 *   the portal           the client's accounts hear it is ready
 */

export const statementLabel = (number: number | null, start: Date, end: Date): string => {
  const d = (x: Date) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${number !== null ? `Statement No. ${String(number).padStart(4, '0')}` : 'Your statement'} (${d(start)} – ${d(end)})`;
};

/** Tell the client's portal accounts a statement was issued or paid. */
export function notifyPortalOfStatement(clientId: string, subject: string, body: string, db: PrismaClient = defaultPrisma): void {
  void trackNotificationWork(
    (async () => {
      const users = await db.user.findMany({
        where: { clientId, role: 'CLIENT_PORTAL', status: 'ACTIVE', deletedAt: null },
        select: { id: true },
        take: 100,
      });
      await Promise.all(users.map((u) => notifyUser(u.id, { subject, body, category: 'portal.statement', linkUrl: '/portal' })));
    })().catch((err: unknown) => {
      console.warn('[clients] statement notice failed:', err instanceof Error ? err.message : err);
    }),
  );
}

const include = { finalizedBy: { select: { email: true } } } as const;

export type FinalizedStatement = Prisma.ClientStatementGetPayload<{ include: typeof include }>;

export async function finalizeStatement(db: PrismaClient, statementId: string, actorUserId: string, opts: { clientId?: string } = {}): Promise<FinalizedStatement> {
  const row = await db.clientStatement.findFirst({ where: { id: statementId, ...(opts.clientId ? { clientId: opts.clientId } : {}) } });
  if (!row) throw new HttpError(404, 'not_found', 'Statement not found');
  if (row.status === 'FINAL') throw new HttpError(409, 'already_final', 'Already finalized.');
  // Record-then-commit: a numbered billing artifact must never exist
  // without a durable record of who issued it.
  const updated = await db.$transaction(async (tx) => {
    // Statement numbers run per tenant (Brief 2-1 migration C); the lock keeps
    // two finalizations in the same tenant from taking the same number.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`statement_number:${row.tenantId}`}, 0))`;
    const max = await tx.clientStatement.aggregate({ where: { tenantId: row.tenantId }, _max: { number: true } });
    const finalizedAt = new Date();
    // Invoicing: due on the client's terms; the standing PO unless the
    // statement already carries its own (lib/statementDunning).
    const terms = await finalizationTerms(tx, row.clientId, finalizedAt);
    // Payroll's adjustments (retro rebills, contract premiums) are claimed by
    // the statement that finalizes first; the frozen snapshot keeps exactly those.
    const snapshot = await claimAdjustmentsForStatement(tx, row.id, row.snapshot as unknown as StatementSnapshot, finalizedAt);
    return tx.clientStatement.update({
      where: { id: row.id },
      data: {
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        status: 'FINAL',
        number: (max._max.number ?? 0) + 1,
        finalizedById: actorUserId,
        finalizedAt,
        dueAt: terms.dueAt,
        poNumber: row.poNumber ?? terms.poNumber,
      },
      include,
    });
  });
  await recordCriticalAudit(
    {
      actorUserId,
      clientId: row.clientId,
      action: 'clients.statement_finalized',
      entityType: 'ClientStatement',
      entityId: row.id,
      metadata: {
        number: updated.number,
        periodStart: row.periodStart.toISOString().slice(0, 10),
        periodEnd: row.periodEnd.toISOString().slice(0, 10),
      },
    },
    'clients.statement_finalized',
  );
  // The books: the statement is a receivable and revenue (lib/books/posting).
  booksAfterStatement(row.id);
  notifyPortalOfStatement(
    row.clientId,
    `${statementLabel(updated.number, row.periodStart, row.periodEnd)} is ready`,
    'Your statement is ready in your portal, with the hours behind it and the PDF to download.',
    db,
  );
  return updated;
}
