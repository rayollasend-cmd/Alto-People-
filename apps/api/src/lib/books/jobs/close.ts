import type { PrismaClient } from '@prisma/client';
import { orgDateKey } from '../../timeAnomalies.js';
import { tenantIdForWrite } from '../../tenant.js';
import { lastEndedPeriod, runDepreciation } from '../assets/depreciation.js';
import { reverseEntry } from '../ledger.js';

/**
 * The close's scheduled work, for the tenant in context:
 *
 *  1. Accruals whose reverseOn has come are reversed (reverseEntry keys the
 *     reversal `reversal:<id>`, so a second pass changes nothing; a closed
 *     month sends it to the first open one).
 *  2. Depreciation is posted for every month that has ended, for every
 *     active asset (idempotent per asset and month). A month that closed
 *     without it is posted into the first open month and flagged.
 */
export async function runCloseJobs(db: PrismaClient, now: Date = new Date()): Promise<{ reversed: number; depreciation: number }> {
  // The company's day (CODE-14): an accrual reverses on the company's date, not UTC's.
  const today = orgDateKey(now);
  const tenantId = tenantIdForWrite();
  const due = await db.journalEntry.findMany({
    where: { tenantId, status: 'POSTED', reverseOn: { lte: new Date(`${today}T00:00:00.000Z`) } },
    select: { id: true, number: true, reverseOn: true, memo: true },
    take: 500,
  });
  const done = due.length
    ? new Set((await db.journalEntry.findMany({ where: { tenantId, sourceKey: { in: due.map((e) => `reversal:${e.id}`) } }, select: { sourceKey: true } })).map((e) => e.sourceKey))
    : new Set<string | null>();
  let reversed = 0;
  for (const e of due) {
    if (done.has(`reversal:${e.id}`)) continue;
    // eslint-disable-next-line no-restricted-syntax -- UTC on purpose: reverseOn is a @db.Date stored at UTC midnight.
    await reverseEntry(db, e.id, { date: e.reverseOn!.toISOString().slice(0, 10), memo: `Reverses accrual #${e.number}${e.memo ? ` — ${e.memo}` : ''}` });
    reversed += 1;
  }
  const dep = await runDepreciation(db, lastEndedPeriod(now));
  return { reversed, depreciation: dep.posted };
}
