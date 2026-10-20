import type { Prisma, PrismaClient } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import { entryForKey, voidEntry, type PostLine } from '../ledger.js';

/**
 * Shared pieces of the automatic posting (lib/books/posting/*): a line
 * accumulator that sums by account × client × site in cents, the "take it
 * off the books" helper for a source that went away, and the fire-and-forget
 * runner the operational code calls after its own work commits.
 */

export type Db = PrismaClient | Prisma.TransactionClient;

export const ymd = (d: Date): string => d.toISOString().slice(0, 10);
export const cents = (v: Prisma.Decimal | number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100);

export interface Dims {
  clientId?: string | null;
  siteId?: string | null;
}

/** Sums lines by account and dimensions, in cents, signed debit-positive. */
export class LineBook {
  private readonly rows = new Map<string, { account: string; clientId: string | null; siteId: string | null; memo: string | null; net: number }>();

  /** Debit `c` cents (negative = credit). */
  add(account: string, c: number, dims: Dims = {}, memo: string | null = null): void {
    if (!c) return;
    const clientId = dims.clientId ?? null;
    const siteId = dims.siteId ?? null;
    const key = `${account}|${clientId ?? ''}|${siteId ?? ''}|${memo ?? ''}`;
    const cur = this.rows.get(key) ?? { account, clientId, siteId, memo, net: 0 };
    cur.net += c;
    this.rows.set(key, cur);
  }

  debit(account: string, c: number, dims?: Dims, memo?: string | null): void {
    this.add(account, c, dims, memo ?? null);
  }

  credit(account: string, c: number, dims?: Dims, memo?: string | null): void {
    this.add(account, -c, dims, memo ?? null);
  }

  /** Debits minus credits so far, cents. */
  balance(): number {
    let n = 0;
    for (const r of this.rows.values()) n += r.net;
    return n;
  }

  lines(): PostLine[] {
    return [...this.rows.values()]
      .filter((r) => r.net !== 0)
      .sort((a, b) => a.account.localeCompare(b.account) || (a.clientId ?? '').localeCompare(b.clientId ?? '') || (a.siteId ?? '').localeCompare(b.siteId ?? ''))
      .map((r) => ({
        account: r.account,
        debit: r.net > 0 ? r.net / 100 : 0,
        credit: r.net < 0 ? -r.net / 100 : 0,
        memo: r.memo,
        clientId: r.clientId,
        siteId: r.siteId,
      }));
  }

  isEmpty(): boolean {
    return this.lines().length < 2;
  }
}

/**
 * Take what a source posted off the books — the entry under `sourceKey` and
 * its adjustments. Open months void; a closed month gets a reversal.
 */
export async function voidByKey(db: Db, sourceKey: string, reason: string): Promise<number> {
  let n = 0;
  const tenantId = tenantIdForWrite();
  const main = await entryForKey(db, sourceKey);
  const adjustments = await db.journalEntry.findMany({ where: { tenantId, sourceKey: { startsWith: `${sourceKey}:adj:` }, status: 'POSTED' }, select: { id: true } });
  for (const e of [...(main && main.status === 'POSTED' ? [main] : []), ...adjustments]) {
    // A closed month answers with a reversal; reversing twice is a no-op (same key).
    const alreadyReversed = await db.journalEntry.findFirst({ where: { tenantId, sourceKey: `reversal:${e.id}` }, select: { id: true } });
    if (alreadyReversed) continue;
    await voidEntry(db, e.id, { reason });
    n += 1;
  }
  return n;
}

/* ---- After-commit runner ---------------------------------------------- */

const pending = new Set<Promise<unknown>>();

/**
 * Run posting after the operation that caused it, never failing it: errors
 * are logged and the backfill (and the close checklist's gaps) catch up.
 * The tenant context of the caller carries into the promise.
 */
export function bookLater(label: string, fn: () => Promise<unknown>): void {
  const p = (async () => {
    try {
      await fn();
    } catch (err) {
      console.warn(`[books] posting ${label} failed (the backfill will retry):`, err);
    }
  })();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Wait for posting started by bookLater (tests, and graceful shutdown). */
export async function flushPendingBooks(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}
