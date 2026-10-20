import { Prisma, type DepreciationEntry, type FixedAsset, type PrismaClient } from '@prisma/client';
import type {
  FixedAssetCategory,
  FixedAssetCreateInput,
  FixedAssetDetail,
  FixedAssetListResponse,
  FixedAssetSuggestion,
  FixedAssetSummary,
  FixedAssetUpdateInput,
} from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { accountIndex, fromCents, postEntry, toCents } from '../ledger.js';
import { defaultAccountsFor, depreciationSchedule, lastEndedPeriod, periodKeyOf } from './depreciation.js';

/**
 * The fixed-asset register: what's on the books, its net book value, the
 * schedule month by month, and the vans and assets the company owns that
 * aren't on the register yet.
 */

type Db = PrismaClient | Prisma.TransactionClient;
type Row = FixedAsset & { depreciation: DepreciationEntry[] };

const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function linkedLabels(db: Db, rows: Row[]): Promise<Map<string, string>> {
  const vanIds = rows.map((r) => r.vanId).filter((x): x is string => !!x);
  const assetIds = rows.map((r) => r.assetId).filter((x): x is string => !!x);
  const [vans, assets] = await Promise.all([
    vanIds.length ? db.van.findMany({ where: { id: { in: vanIds } }, select: { id: true, name: true, plate: true } }) : [],
    assetIds.length ? db.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, label: true, serial: true } }) : [],
  ]);
  return new Map<string, string>([
    ...vans.map((v) => [v.id, `${v.name}${v.plate ? ` · ${v.plate}` : ''}`] as [string, string]),
    ...assets.map((a) => [a.id, `${a.label}${a.serial ? ` · ${a.serial}` : ''}`] as [string, string]),
  ]);
}

function summarize(r: Row, labels: Map<string, string>, now: Date): FixedAssetSummary {
  const schedule = depreciationSchedule(r);
  const accumulated = r.depreciation.reduce((s, d) => s + toCents(d.amount), 0);
  const posted = new Set(r.depreciation.map((d) => d.periodKey));
  const through = lastEndedPeriod(now);
  const current = periodKeyOf(now);
  const thisMonth = schedule.find((m) => m.periodKey === current) ?? schedule.find((m) => !posted.has(m.periodKey));
  const lastPosted = [...posted].sort().pop() ?? null;
  return {
    id: r.id,
    name: r.name,
    category: r.category as FixedAssetCategory,
    status: r.status as FixedAssetSummary['status'],
    method: r.method as FixedAssetSummary['method'],
    acquiredOn: ymd(r.acquiredOn)!,
    inServiceOn: ymd(r.inServiceOn)!,
    cost: fromCents(toCents(r.cost)),
    salvageValue: fromCents(toCents(r.salvageValue)),
    usefulLifeMonths: r.usefulLifeMonths,
    accumulated: fromCents(accumulated),
    netBookValue: r.status === 'DISPOSED' ? 0 : fromCents(toCents(r.cost) - accumulated),
    monthlyDepreciation: r.status === 'ACTIVE' && thisMonth ? fromCents(thisMonth.amount) : 0,
    lastPostedPeriod: lastPosted,
    duePeriods: r.status === 'ACTIVE' ? schedule.filter((m) => m.periodKey <= through && !posted.has(m.periodKey)).length : 0,
    assetId: r.assetId,
    vanId: r.vanId,
    linkedLabel: (r.vanId && labels.get(r.vanId)) || (r.assetId && labels.get(r.assetId)) || null,
  };
}

export async function listFixedAssets(db: Db, now: Date = new Date()): Promise<FixedAssetListResponse> {
  const tenantId = tenantIdForWrite();
  const rows = await db.fixedAsset.findMany({ where: { tenantId }, include: { depreciation: true }, orderBy: [{ status: 'asc' }, { acquiredOn: 'desc' }] });
  const labels = await linkedLabels(db, rows);
  const assets = rows.map((r) => summarize(r, labels, now));
  const live = assets.filter((a) => a.status !== 'DISPOSED');
  const sum = (f: (a: FixedAssetSummary) => number) => fromCents(live.reduce((s, a) => s + toCents(f(a)), 0));
  return {
    assets,
    totals: { cost: sum((a) => a.cost), accumulated: sum((a) => a.accumulated), netBookValue: sum((a) => a.netBookValue), monthly: sum((a) => a.monthlyDepreciation) },
    suggestions: await suggestions(db, rows),
  };
}

/** Vans and recorded assets with a price that aren't on the register. */
async function suggestions(db: Db, rows: Row[]): Promise<FixedAssetSuggestion[]> {
  const tenantId = tenantIdForWrite();
  const onVan = new Set(rows.map((r) => r.vanId).filter(Boolean));
  const onAsset = new Set(rows.map((r) => r.assetId).filter(Boolean));
  const [vans, assets] = await Promise.all([
    db.van.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true, plate: true, year: true, make: true, model: true }, take: 200 }),
    db.asset.findMany({ where: { tenantId, purchasePrice: { gte: 500 }, status: { notIn: ['RETIRED', 'LOST'] } }, select: { id: true, label: true, kind: true, purchasePrice: true, purchasedAt: true }, take: 200 }),
  ]);
  return [
    ...vans
      .filter((v) => !onVan.has(v.id))
      .map((v) => ({ kind: 'VAN' as const, id: v.id, label: [v.name, v.year, v.make, v.model, v.plate].filter(Boolean).join(' · '), cost: null, acquiredOn: null, category: 'VEHICLE' as const })),
    ...assets
      .filter((a) => !onAsset.has(a.id))
      .map((a) => ({ kind: 'ASSET' as const, id: a.id, label: a.label, cost: a.purchasePrice ? Number(a.purchasePrice) : null, acquiredOn: ymd(a.purchasedAt), category: (a.kind === 'VEHICLE' ? 'VEHICLE' : a.kind === 'LAPTOP' || a.kind === 'PHONE' || a.kind === 'TABLET' ? 'COMPUTERS' : 'EQUIPMENT') as FixedAssetCategory })),
  ].slice(0, 50);
}

export async function fixedAssetDetail(db: Db, id: string, now: Date = new Date()): Promise<FixedAssetDetail> {
  const tenantId = tenantIdForWrite();
  const r = await db.fixedAsset.findFirst({ where: { id, tenantId }, include: { depreciation: true } });
  if (!r) throw new HttpError(404, 'asset_not_found', 'Fixed asset not found.');
  const labels = await linkedLabels(db, [r]);
  const { byId } = await accountIndex(db);
  const name = (aid: string) => {
    const a = byId.get(aid);
    return a ? `${a.code} ${a.name}` : '—';
  };
  const posted = new Map(r.depreciation.map((d) => [d.periodKey, d]));
  const entries = r.depreciation.length
    ? await db.journalEntry.findMany({ where: { id: { in: r.depreciation.map((d) => d.journalEntryId).filter((x): x is string => !!x) } }, select: { id: true, periodKey: true } })
    : [];
  const entryPeriod = new Map(entries.map((e) => [e.id, e.periodKey]));
  // Posted amounts are the truth; months not yet posted follow the schedule from there.
  let accumulated = 0;
  const cost = toCents(r.cost);
  const schedule = depreciationSchedule(r).map((m) => {
    const p = posted.get(m.periodKey);
    const amount = p ? toCents(p.amount) : m.amount;
    accumulated += amount;
    return {
      periodKey: m.periodKey,
      amount: fromCents(amount),
      accumulated: fromCents(accumulated),
      netBookValue: fromCents(cost - accumulated),
      posted: !!p,
      entryId: p?.journalEntryId ?? null,
      postedLate: !!p?.journalEntryId && (entryPeriod.get(p.journalEntryId) ?? m.periodKey) !== m.periodKey,
    };
  });
  return {
    ...summarize(r, labels, now),
    assetAccountId: r.assetAccountId,
    accumulatedAccountId: r.accumulatedAccountId,
    expenseAccountId: r.expenseAccountId,
    accounts: { asset: name(r.assetAccountId), accumulated: name(r.accumulatedAccountId), expense: name(r.expenseAccountId) },
    clientId: r.clientId,
    siteId: r.siteId,
    departmentId: r.departmentId,
    notes: r.notes,
    disposedOn: ymd(r.disposedOn),
    disposalProceeds: r.disposalProceeds === null ? null : Number(r.disposalProceeds),
    acquisitionEntryId: r.acquisitionEntryId,
    disposalEntryId: r.disposalEntryId,
    schedule,
  };
}

async function accountFor(db: Db, given: string | undefined, systemKey: string, types: string[]): Promise<string> {
  const { byId, byKey } = await accountIndex(db);
  if (given) {
    const a = byId.get(given);
    if (!a) throw new HttpError(400, 'unknown_account', 'That ledger account doesn’t exist.');
    if (!types.includes(a.type)) throw new HttpError(400, 'wrong_account_type', `${a.code} ${a.name} can’t be used there.`);
    return a.id;
  }
  const a = byKey.get(systemKey);
  if (!a) throw new HttpError(500, 'account_missing', `No ledger account for ${systemKey}.`);
  return a.id;
}

export async function createFixedAsset(db: PrismaClient, input: FixedAssetCreateInput, userId: string | null): Promise<FixedAssetDetail> {
  const tenantId = tenantIdForWrite();
  if (input.vanId && !(await db.van.findFirst({ where: { id: input.vanId, tenantId }, select: { id: true } }))) throw new HttpError(400, 'van_not_found', 'That van doesn’t exist.');
  if (input.assetId && !(await db.asset.findFirst({ where: { id: input.assetId, tenantId }, select: { id: true } }))) throw new HttpError(400, 'asset_record_not_found', 'That asset record doesn’t exist.');
  if (input.vanId && (await db.fixedAsset.findFirst({ where: { tenantId, vanId: input.vanId, status: { not: 'DISPOSED' } } }))) throw new HttpError(409, 'already_registered', 'That van is already on the register.');
  if (input.assetId && (await db.fixedAsset.findFirst({ where: { tenantId, assetId: input.assetId, status: { not: 'DISPOSED' } } }))) throw new HttpError(409, 'already_registered', 'That asset is already on the register.');
  const defaults = defaultAccountsFor(input.category);
  // One after another: the first read of the books seeds the chart.
  const assetAccountId = await accountFor(db, input.assetAccountId, defaults.asset, ['ASSET']);
  const accumulatedAccountId = await accountFor(db, input.accumulatedAccountId, defaults.accumulated, ['ASSET']);
  const expenseAccountId = await accountFor(db, input.expenseAccountId, defaults.expense, ['EXPENSE']);
  const inServiceOn = input.inServiceOn ?? input.acquiredOn;
  if (inServiceOn < input.acquiredOn) throw new HttpError(400, 'in_service_before_acquired', 'It can’t go into service before it was acquired.');
  const row = await db.fixedAsset.create({
    data: {
      tenantId,
      name: input.name,
      category: input.category,
      assetId: input.assetId ?? null,
      vanId: input.vanId ?? null,
      acquiredOn: dateOnly(input.acquiredOn),
      inServiceOn: dateOnly(inServiceOn),
      cost: new Prisma.Decimal(input.cost),
      salvageValue: new Prisma.Decimal(input.salvageValue ?? 0),
      usefulLifeMonths: input.usefulLifeMonths,
      method: input.method ?? 'STRAIGHT_LINE',
      assetAccountId,
      accumulatedAccountId,
      expenseAccountId,
      clientId: input.clientId ?? null,
      siteId: input.siteId ?? null,
      departmentId: input.departmentId ?? null,
      notes: input.notes ?? null,
      createdById: userId,
    },
  });
  if (input.acquisition) {
    const credit = await accountFor(db, input.acquisition.creditAccountId, 'CASH_OPERATING', ['ASSET', 'LIABILITY', 'EQUITY']);
    const entry = await postEntry(db, {
      date: input.acquiredOn,
      memo: `Acquired ${input.name}`,
      source: 'MANUAL',
      sourceType: 'FixedAsset',
      sourceId: row.id,
      sourceKey: `asset-acquisition:${row.id}`,
      createdById: userId,
      lines: [
        { account: assetAccountId, debit: input.cost, clientId: row.clientId, siteId: row.siteId, departmentId: row.departmentId },
        { account: credit, credit: input.cost },
      ],
    });
    await db.fixedAsset.update({ where: { id: row.id }, data: { acquisitionEntryId: entry.id } });
  }
  return fixedAssetDetail(db, row.id);
}

export async function updateFixedAsset(db: PrismaClient, id: string, input: FixedAssetUpdateInput): Promise<FixedAssetDetail> {
  const tenantId = tenantIdForWrite();
  const r = await db.fixedAsset.findFirst({ where: { id, tenantId }, include: { depreciation: true } });
  if (!r) throw new HttpError(404, 'asset_not_found', 'Fixed asset not found.');
  const reshapes = input.salvageValue !== undefined || input.usefulLifeMonths !== undefined || input.method !== undefined;
  if (reshapes && r.depreciation.length > 0) {
    throw new HttpError(409, 'schedule_started', 'Depreciation has been posted, so the life, method and salvage value are fixed. Dispose of it and register it again to change them.');
  }
  if (input.salvageValue !== undefined && input.salvageValue > Number(r.cost)) throw new HttpError(400, 'salvage_over_cost', 'Salvage value can’t be more than the cost.');
  await db.fixedAsset.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.salvageValue !== undefined ? { salvageValue: new Prisma.Decimal(input.salvageValue) } : {}),
      ...(input.usefulLifeMonths !== undefined ? { usefulLifeMonths: input.usefulLifeMonths } : {}),
      ...(input.method !== undefined ? { method: input.method } : {}),
    },
  });
  return fixedAssetDetail(db, id);
}
