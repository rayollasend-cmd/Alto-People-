import type { FixedAsset, PrismaClient } from '@prisma/client';
import { monthWords } from '../words.js';
import { Prisma as P } from '@prisma/client';
import { tenantIdForWrite } from '../../tenant.js';
import { accountIndex, fromCents, isPeriodClosed, postEntry, toCents } from '../ledger.js';

/**
 * Fixed-asset depreciation: the schedule (pure), and posting what's due.
 *
 *  - Full-month convention: the in-service month takes a whole month.
 *  - STRAIGHT_LINE: (cost − salvage) ÷ life, every month; the last month
 *    takes the rounding, so the total is exactly cost − salvage.
 *  - DECLINING_BALANCE: double-declining — book value × 2 ÷ life each
 *    month, switching to straight line over the months left as soon as
 *    that's larger, never below salvage.
 *  - A disposed asset depreciates through the month before disposal.
 *
 * Posting is idempotent twice over: the DepreciationEntry (asset, month)
 * row is unique, and the entry's sourceKey is depreciation:<asset>:<month>.
 * A month that closed without its depreciation is a gap: it's posted into
 * the first open month, its memo says so, and the schedule flags it late.
 */

export interface ScheduleMonth {
  periodKey: string;
  /** cents */
  amount: number;
  /** cents, after this month */
  accumulated: number;
  /** cents, after this month */
  netBookValue: number;
}

export type ScheduleInput = Pick<FixedAsset, 'inServiceOn' | 'cost' | 'salvageValue' | 'usefulLifeMonths' | 'method' | 'disposedOn'>;

export const periodKeyOf = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString()).slice(0, 7);

export function addMonths(periodKey: string, n: number): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthEnd(periodKey: string): string {
  const [y, m] = periodKey.split('-').map(Number) as [number, number];
  return `${periodKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** The last month that has fully ended before `now`. */
export function lastEndedPeriod(now: Date = new Date()): string {
  return addMonths(periodKeyOf(now), -1);
}

/** Every month of depreciation the asset will ever take (pure). */
export function depreciationSchedule(a: ScheduleInput): ScheduleMonth[] {
  const cost = toCents(a.cost);
  const salvage = Math.min(toCents(a.salvageValue), cost);
  const base = cost - salvage;
  const life = Math.max(1, a.usefulLifeMonths);
  const start = periodKeyOf(a.inServiceOn);
  // Disposal: depreciate through the month before it.
  const stopBefore = a.disposedOn ? periodKeyOf(a.disposedOn) : null;
  const out: ScheduleMonth[] = [];
  let accumulated = 0;
  for (let i = 0; i < life; i++) {
    const periodKey = addMonths(start, i);
    if (stopBefore && periodKey >= stopBefore) break;
    const nbv = cost - accumulated;
    const remainingBase = nbv - salvage;
    if (remainingBase <= 0) break;
    const monthsLeft = life - i;
    let amount: number;
    if (a.method === 'DECLINING_BALANCE') {
      const ddb = Math.round((nbv * 2) / life);
      const sl = Math.round(remainingBase / monthsLeft);
      amount = Math.max(ddb, sl);
    } else {
      amount = Math.round(base / life);
    }
    if (i === life - 1 || amount > remainingBase) amount = remainingBase;
    accumulated += amount;
    out.push({ periodKey, amount, accumulated, netBookValue: cost - accumulated });
  }
  return out;
}

/** The ledger accounts a category depreciates through (systemKeys). */
export function defaultAccountsFor(category: string): { asset: string; accumulated: string; expense: string } {
  const asset =
    category === 'VEHICLE' ? 'FA_VEHICLES' : category === 'COMPUTERS' ? 'FA_COMPUTERS' : category === 'LEASEHOLD' ? 'FA_LEASEHOLD' : 'FA_EQUIPMENT';
  return { asset, accumulated: 'ACCUM_DEPRECIATION', expense: 'DEPRECIATION_EXPENSE' };
}

export interface PostDepreciationResult {
  posted: number;
  amount: number;
  late: number;
}

/**
 * Post every month of this asset's depreciation that has ended, through
 * `through` (inclusive), not posted yet. Months in order.
 */
export async function postAssetDepreciation(db: PrismaClient, assetId: string, through: string, opts: { userId?: string | null } = {}): Promise<PostDepreciationResult> {
  const tenantId = tenantIdForWrite();
  const asset = await db.fixedAsset.findFirst({ where: { id: assetId, tenantId }, include: { depreciation: true } });
  const result: PostDepreciationResult = { posted: 0, amount: 0, late: 0 };
  if (!asset || asset.status === 'FULLY_DEPRECIATED') return result;
  const done = new Set(asset.depreciation.map((d) => d.periodKey));
  const schedule = depreciationSchedule(asset);
  for (const m of schedule) {
    if (m.periodKey > through) break;
    if (done.has(m.periodKey) || m.amount === 0) continue;
    const late = await isPeriodClosed(db, m.periodKey);
    const entry = await postEntry(db, {
      date: monthEnd(m.periodKey),
      memo: late ? `Depreciation for ${monthWords(m.periodKey)} — ${asset.name} (posted late: ${monthWords(m.periodKey)} closed without it)` : `Depreciation for ${monthWords(m.periodKey)} — ${asset.name}`,
      source: 'DEPRECIATION',
      sourceType: 'FixedAsset',
      sourceId: asset.id,
      sourceKey: `depreciation:${asset.id}:${m.periodKey}`,
      createdById: opts.userId ?? null,
      lines: [
        { account: asset.expenseAccountId, debit: fromCents(m.amount), clientId: asset.clientId, siteId: asset.siteId, departmentId: asset.departmentId },
        { account: asset.accumulatedAccountId, credit: fromCents(m.amount), clientId: asset.clientId, siteId: asset.siteId, departmentId: asset.departmentId },
      ],
    });
    await db.depreciationEntry.upsert({
      where: { fixedAssetId_periodKey: { fixedAssetId: asset.id, periodKey: m.periodKey } },
      create: { tenantId, fixedAssetId: asset.id, periodKey: m.periodKey, amount: new P.Decimal(fromCents(m.amount)), journalEntryId: entry.id },
      update: {},
    });
    result.posted += 1;
    result.amount += m.amount;
    if (late) result.late += 1;
  }
  // Fully depreciated once the schedule's last month is posted (a disposed asset keeps DISPOSED).
  const last = schedule[schedule.length - 1];
  if (asset.status === 'ACTIVE' && !asset.disposedOn && (!last || last.periodKey <= through)) {
    const posted = await db.depreciationEntry.count({ where: { fixedAssetId: asset.id } });
    if (posted >= schedule.length) await db.fixedAsset.update({ where: { id: asset.id }, data: { status: 'FULLY_DEPRECIATED' } });
  }
  return result;
}

/** Depreciation for every active asset through `through` (the job and POST /books/assets/depreciation/run). */
export async function runDepreciation(db: PrismaClient, through: string, opts: { userId?: string | null } = {}): Promise<PostDepreciationResult & { assets: number }> {
  const assets = await db.fixedAsset.findMany({ where: { tenantId: tenantIdForWrite(), status: 'ACTIVE', inServiceOn: { lte: new Date(`${monthEnd(through)}T00:00:00.000Z`) } }, select: { id: true } });
  const total = { posted: 0, amount: 0, late: 0, assets: 0 };
  for (const a of assets) {
    const r = await postAssetDepreciation(db, a.id, through, opts);
    if (r.posted > 0) total.assets += 1;
    total.posted += r.posted;
    total.amount += r.amount;
    total.late += r.late;
  }
  return { ...total, amount: fromCents(total.amount) };
}

/**
 * Take an asset off the books: depreciation through the month before,
 * then Dr accumulated depreciation, Dr the proceeds account, Cr the asset
 * at cost, and the difference to gain or loss on disposal.
 */
export async function disposeAsset(
  db: PrismaClient,
  assetId: string,
  input: { disposedOn: string; proceeds: number; proceedsAccountId?: string | null; note?: string | null; userId?: string | null },
): Promise<void> {
  const tenantId = tenantIdForWrite();
  const asset = await db.fixedAsset.findFirst({ where: { id: assetId, tenantId } });
  if (!asset) return;
  // Stop the schedule at disposal, then post what's still due before it.
  await db.fixedAsset.update({ where: { id: asset.id }, data: { disposedOn: new Date(`${input.disposedOn}T00:00:00.000Z`) } });
  await postAssetDepreciation(db, asset.id, addMonths(periodKeyOf(input.disposedOn), -1), { userId: input.userId });
  const agg = await db.depreciationEntry.aggregate({ where: { fixedAssetId: asset.id }, _sum: { amount: true } });
  const accumulated = toCents(agg._sum.amount);
  const cost = toCents(asset.cost);
  const proceeds = toCents(input.proceeds);
  const lossOrGain = cost - accumulated - proceeds; // > 0 a loss, < 0 a gain
  const dims = { clientId: asset.clientId, siteId: asset.siteId, departmentId: asset.departmentId };
  const { byKey } = await accountIndex(db);
  const lines = [
    { account: asset.accumulatedAccountId, debit: fromCents(accumulated), ...dims },
    ...(proceeds > 0 ? [{ account: input.proceedsAccountId ?? byKey.get('CASH_OPERATING')!.id, debit: fromCents(proceeds), ...dims }] : []),
    { account: asset.assetAccountId, credit: fromCents(cost), ...dims },
    ...(lossOrGain !== 0 ? [{ account: 'ASSET_DISPOSAL_GAIN_LOSS', debit: lossOrGain > 0 ? fromCents(lossOrGain) : 0, credit: lossOrGain < 0 ? fromCents(-lossOrGain) : 0, ...dims }] : []),
  ];
  const entry = await postEntry(db, {
    date: input.disposedOn,
    memo: `Disposal of ${asset.name}${lossOrGain > 0 ? ` — loss ${fromCents(lossOrGain).toFixed(2)}` : lossOrGain < 0 ? ` — gain ${fromCents(-lossOrGain).toFixed(2)}` : ''}${input.note ? ` (${input.note})` : ''}`,
    source: 'ASSET_DISPOSAL',
    sourceType: 'FixedAsset',
    sourceId: asset.id,
    sourceKey: `asset-disposal:${asset.id}`,
    createdById: input.userId ?? null,
    lines,
  });
  await db.fixedAsset.update({
    where: { id: asset.id },
    data: { status: 'DISPOSED', disposedOn: new Date(`${input.disposedOn}T00:00:00.000Z`), disposalProceeds: new P.Decimal(fromCents(proceeds)), disposalEntryId: entry.id },
  });
}
