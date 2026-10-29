import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { env } from '../config/env.js';
import type { SessionUser } from '../types/express.js';
import { currentRateCards } from './rateCards.js';
import { internalSites, scopeWhere } from './scope.js';
import { tenantIdForWrite } from './tenant.js';
import { runForEachTenant } from './tenantJobs.js';
import { CBSA_CATALOG, SOC_CATALOG, cbsaByCode, positionKey, socByCode } from './marketCatalog.js';
import { logger } from './logger.js';

/**
 * Pay and bill-rate intelligence.
 *
 *   wage data   BLS Occupational Employment and Wage Statistics (OEWS):
 *               hourly 10th/25th/median/75th/90th percentile by metro area
 *               (CBSA) and occupation (SOC). Fetched from the BLS public API
 *               for the (metro, occupation) pairs a tenant actually uses,
 *               refreshed weekly, or imported from the published OEWS table.
 *               Stored once for everyone (MarketWage is reference data).
 *   our side    each store's metro (Site.marketAreaCode), each role's
 *               occupation (PositionSocMap), the rate card in force, and
 *               the store's own fill and no-show record by role.
 *   the answer  where each role's pay sits in its metro, what fill looks
 *               like at different pay levels across the company (a plain
 *               elasticity estimate, flagged when the data is thin), a
 *               recommended pay rate, and the bill rate that keeps the
 *               client's margin at that pay. A rate change still goes
 *               through the dated rate card and its approval.
 *
 * `marketPosition` is the stable entry point other modules (the retention
 * score) import: where one person's — or one store-role's — pay sits.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const BLS_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const DAY_MS = 86_400_000;
const STALE_DAYS = 7;

/* ----- BLS client ------------------------------------------------------------- */

/** OEWS data types we read (hourly figures). */
const DATATYPE = { mean: '03', p10: '06', p25: '07', median: '08', p75: '09', p90: '10', employment: '01' } as const;
type Field = keyof typeof DATATYPE;

/** OEU + M (metro) + 7-digit area + 000000 (all industries) + 6-digit SOC + 2-digit data type. */
export function oewsSeriesId(areaCode: string, socCode: string, field: Field): string {
  return `OEUM${areaCode.padStart(7, '0')}000000${socCode.replace('-', '')}${DATATYPE[field]}`;
}

function parseSeriesId(id: string): { areaCode: string; socCode: string; field: Field } | null {
  const m = /^OEUM(\d{7})000000(\d{6})(\d{2})$/.exec(id);
  if (!m) return null;
  const field = (Object.keys(DATATYPE) as Field[]).find((f) => DATATYPE[f] === m[3]);
  if (!field) return null;
  return { areaCode: m[1]!.replace(/^0+/, '').padStart(5, '0'), socCode: `${m[2]!.slice(0, 2)}-${m[2]!.slice(2)}`, field };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
let fetchImpl: FetchLike | null = null;
/** Tests inject a fake; production uses the global fetch. */
export function setBlsFetchForTests(f: FetchLike | null): void {
  fetchImpl = f;
}

export interface WageRow {
  areaCode: string;
  areaName: string;
  socCode: string;
  socTitle: string;
  year: number;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  mean: number | null;
  employment: number | null;
}

/** Fetch OEWS figures for these pairs. BLS answers "-" or "*" when a figure is suppressed; those come back null. */
export async function fetchOews(pairs: Array<{ areaCode: string; socCode: string }>): Promise<{ rows: WageRow[]; messages: string[] }> {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const fields = Object.keys(DATATYPE) as Field[];
  const ids = pairs.flatMap((p) => fields.map((f) => oewsSeriesId(p.areaCode, p.socCode, f)));
  const perRequest = env.BLS_API_KEY ? 50 : 25;
  const acc = new Map<string, WageRow>();
  const messages: string[] = [];
  for (let i = 0; i < ids.length; i += perRequest) {
    const batch = ids.slice(i, i + perRequest);
    const body: Record<string, unknown> = { seriesid: batch, latest: true };
    if (env.BLS_API_KEY) body.registrationkey = env.BLS_API_KEY;
    const res = await doFetch(BLS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      messages.push(`BLS answered ${res.status}`);
      continue;
    }
    const json = (await res.json()) as { status?: string; message?: string[]; Results?: { series?: Array<{ seriesID: string; data?: Array<{ year: string; value: string }> }> } };
    if (json.message?.length) messages.push(...json.message);
    for (const series of json.Results?.series ?? []) {
      const parsed = parseSeriesId(series.seriesID);
      const point = series.data?.[0];
      if (!parsed || !point) continue;
      const key = `${parsed.areaCode}|${parsed.socCode}|${point.year}`;
      const row =
        acc.get(key) ??
        ({
          areaCode: parsed.areaCode,
          areaName: cbsaByCode(parsed.areaCode)?.name ?? `Metro ${parsed.areaCode}`,
          socCode: parsed.socCode,
          socTitle: socByCode(parsed.socCode)?.title ?? parsed.socCode,
          year: Number(point.year),
          p10: null,
          p25: null,
          median: null,
          p75: null,
          p90: null,
          mean: null,
          employment: null,
        } as WageRow);
      const value = Number(String(point.value).replace(/,/g, ''));
      if (Number.isFinite(value)) (row as unknown as Record<Field, number | null>)[parsed.field] = value;
      acc.set(key, row);
    }
  }
  return { rows: [...acc.values()], messages };
}

export async function upsertWages(db: Db, rows: WageRow[], source = 'BLS_OEWS'): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (r.median === null && r.p10 === null && r.p90 === null) continue;
    const data = {
      areaName: r.areaName.slice(0, 160),
      socTitle: r.socTitle.slice(0, 200),
      p10: r.p10,
      p25: r.p25,
      median: r.median,
      p75: r.p75,
      p90: r.p90,
      mean: r.mean,
      employment: r.employment,
      source,
      fetchedAt: new Date(),
    };
    await db.marketWage.upsert({
      where: { areaCode_socCode_year: { areaCode: r.areaCode, socCode: r.socCode, year: r.year } },
      create: { areaCode: r.areaCode, socCode: r.socCode, year: r.year, ...data },
      update: data,
    });
    n += 1;
  }
  return n;
}

/* ----- OEWS table import -------------------------------------------------------- */

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * The published OEWS table (the "MSA" file, saved as CSV): AREA, AREA_TITLE,
 * OCC_CODE, OCC_TITLE, TOT_EMP, H_MEAN, H_PCT10 … H_PCT90. "#" means the wage
 * is at or above the top of the survey's range and "*" that it isn't
 * published; both are left empty rather than guessed.
 */
export function parseOewsCsv(text: string, year: number): { rows: WageRow[]; skipped: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], skipped: 0 };
  const header = splitCsv(lines[0]!).map((h) => h.trim().toUpperCase());
  const col = (name: string) => header.indexOf(name);
  const need = ['AREA', 'OCC_CODE'];
  if (need.some((n) => col(n) < 0)) throw new Error('This file is missing the AREA and OCC_CODE columns of the OEWS table.');
  const num = (v: string | undefined) => {
    if (v === undefined) return null;
    const t = v.replace(/[$,]/g, '').trim();
    if (!t || t === '*' || t === '#' || t === '**') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };
  const rows: WageRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const area = (cells[col('AREA')] ?? '').trim().replace(/^0+/, '').padStart(5, '0');
    const soc = (cells[col('OCC_CODE')] ?? '').trim();
    // "All occupations" (00-0000) and major groups (53-0000) are totals, not jobs anyone holds.
    if (!/^\d{5}$/.test(area) || !/^\d{2}-\d{4}$/.test(soc) || soc.endsWith('-0000')) {
      skipped += 1;
      continue;
    }
    const at = (name: string) => (col(name) >= 0 ? cells[col(name)] : undefined);
    rows.push({
      areaCode: area,
      areaName: (at('AREA_TITLE') ?? '').trim() || cbsaByCode(area)?.name || `Metro ${area}`,
      socCode: soc,
      socTitle: (at('OCC_TITLE') ?? '').trim() || socByCode(soc)?.title || soc,
      year,
      p10: num(at('H_PCT10')),
      p25: num(at('H_PCT25')),
      median: num(at('H_MEDIAN')),
      p75: num(at('H_PCT75')),
      p90: num(at('H_PCT90')),
      mean: num(at('H_MEAN')),
      employment: num(at('TOT_EMP')),
    });
  }
  return { rows, skipped };
}

/* ----- What a tenant uses, and the refresh -------------------------------------- */

/** The (metro, occupation) pairs this tenant benchmarks: every mapped store metro × every mapped role. */
export async function tenantPairs(db: Db = defaultPrisma): Promise<Array<{ areaCode: string; socCode: string }>> {
  const tenantId = tenantIdForWrite();
  const [sites, maps] = await Promise.all([
    db.site.findMany({ where: { tenantId, deletedAt: null, isActive: true, marketAreaCode: { not: null } }, select: { marketAreaCode: true }, distinct: ['marketAreaCode'] }),
    db.positionSocMap.findMany({ where: { tenantId }, select: { socCode: true }, distinct: ['socCode'] }),
  ]);
  const out: Array<{ areaCode: string; socCode: string }> = [];
  for (const s of sites) for (const m of maps) out.push({ areaCode: s.marketAreaCode!, socCode: m.socCode });
  return out;
}

/** Fetch whatever this tenant uses that is missing or older than a week. */
export async function refreshTenantWages(db: Db = defaultPrisma, opts: { force?: boolean } = {}): Promise<{ pairs: number; fetched: number; saved: number; messages: string[] }> {
  const pairs = await tenantPairs(db);
  if (pairs.length === 0) return { pairs: 0, fetched: 0, saved: 0, messages: [] };
  const since = new Date(Date.now() - STALE_DAYS * DAY_MS);
  const fresh = opts.force
    ? []
    : await db.marketWage.findMany({
        where: { OR: pairs.map((p) => ({ areaCode: p.areaCode, socCode: p.socCode })), fetchedAt: { gte: since } },
        select: { areaCode: true, socCode: true },
      });
  const freshKey = new Set(fresh.map((f) => `${f.areaCode}|${f.socCode}`));
  const todo = pairs.filter((p) => !freshKey.has(`${p.areaCode}|${p.socCode}`));
  if (todo.length === 0) return { pairs: pairs.length, fetched: 0, saved: 0, messages: [] };
  const { rows, messages } = await fetchOews(todo);
  const saved = await upsertWages(db, rows);
  return { pairs: pairs.length, fetched: todo.length, saved, messages };
}

let timer: NodeJS.Timeout | null = null;
export function startMarketWageCron(): void {
  if (timer || env.NODE_ENV === 'test') return;
  const tick = () => runForEachTenant('market-wages', () => refreshTenantWages());
  const every = env.MARKET_WAGE_REFRESH_HOURS * 3_600_000;
  // First run a few minutes after boot, so a deploy doesn't stampede BLS.
  setTimeout(() => void tick().catch((err) => console.error('[alto-people/api] market wage refresh failed:', err)), 5 * 60_000).unref();
  timer = setInterval(() => void tick().catch((err) => console.error('[alto-people/api] market wage refresh failed:', err)), every);
  timer.unref();
  logger.info(`market wage refresh armed (every ${env.MARKET_WAGE_REFRESH_HOURS}h)`);
}

/* ----- Reading the data ------------------------------------------------------------ */

export interface MarketFigures {
  areaCode: string;
  areaName: string;
  socCode: string;
  socTitle: string;
  year: number;
  p10: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  source: string;
  fetchedAt: string;
}

const n = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

/** The newest figures for each requested pair. */
export async function latestWages(db: Db, pairs: Array<{ areaCode: string; socCode: string }>): Promise<Map<string, MarketFigures>> {
  const out = new Map<string, MarketFigures>();
  if (pairs.length === 0) return out;
  const rows = await db.marketWage.findMany({
    where: { OR: pairs.map((p) => ({ areaCode: p.areaCode, socCode: p.socCode })) },
    orderBy: { year: 'desc' },
  });
  for (const r of rows) {
    const key = `${r.areaCode}|${r.socCode}`;
    if (out.has(key)) continue;
    out.set(key, {
      areaCode: r.areaCode,
      areaName: r.areaName,
      socCode: r.socCode,
      socTitle: r.socTitle,
      year: r.year,
      p10: n(r.p10),
      p25: n(r.p25),
      median: n(r.median),
      p75: n(r.p75),
      p90: n(r.p90),
      source: r.source,
      fetchedAt: r.fetchedAt.toISOString(),
    });
  }
  return out;
}

/** Where a pay rate falls among the published percentiles, as an approximate percentile (straight lines between the points). */
export function percentileOf(pay: number, m: Pick<MarketFigures, 'p10' | 'p25' | 'median' | 'p75' | 'p90'>): number | null {
  const pts: Array<[number, number]> = (
    [
      [10, m.p10],
      [25, m.p25],
      [50, m.median],
      [75, m.p75],
      [90, m.p90],
    ] as Array<[number, number | null]>
  ).filter((p): p is [number, number] => p[1] !== null);
  if (pts.length < 2) return null;
  if (pay <= pts[0]![1]) return pts[0]![0];
  if (pay >= pts[pts.length - 1]![1]) return pts[pts.length - 1]![0];
  for (let i = 1; i < pts.length; i++) {
    const [pa, va] = pts[i - 1]!;
    const [pb, vb] = pts[i]!;
    if (pay <= vb) return Math.round(pa + ((pay - va) / Math.max(0.01, vb - va)) * (pb - pa));
  }
  return null;
}

async function socMapFor(db: Db): Promise<Map<string, { socCode: string; socTitle: string }>> {
  const rows = await db.positionSocMap.findMany({ where: { tenantId: tenantIdForWrite() }, select: { positionKey: true, socCode: true, socTitle: true } });
  return new Map(rows.map((r) => [r.positionKey, { socCode: r.socCode, socTitle: r.socTitle }]));
}

/* ----- Fill and no-show by store and role ------------------------------------------- */

export interface FillStats {
  shifts: number;
  filled: number;
  noShows: number;
}

/** Last `days` of non-cancelled shifts per (store, role): how many had someone, how many were no-call no-shows. */
export async function fillByStoreRole(db: Db, siteIds: string[], days = 90, now = new Date()): Promise<Map<string, FillStats>> {
  const out = new Map<string, FillStats>();
  if (siteIds.length === 0) return out;
  const since = new Date(now.getTime() - days * DAY_MS);
  const [shifts, noShows] = await Promise.all([
    db.shift.groupBy({
      by: ['locationId', 'position'],
      where: { locationId: { in: siteIds }, status: { not: 'CANCELLED' }, startsAt: { gte: since, lte: now } },
      _count: { _all: true, assignedAssociateId: true },
    }),
    db.attendanceEvent.findMany({
      where: { kind: 'NO_CALL_NO_SHOW', excusedAt: null, occurredOn: { gte: since }, shiftId: { not: null } },
      select: { shiftId: true },
    }),
  ]);
  for (const g of shifts) {
    if (!g.locationId) continue;
    out.set(`${g.locationId}|${positionKey(g.position)}`, { shifts: g._count._all, filled: g._count.assignedAssociateId, noShows: 0 });
  }
  if (noShows.length) {
    const shiftRows = await db.shift.findMany({
      where: { id: { in: noShows.map((x) => x.shiftId!) }, locationId: { in: siteIds } },
      select: { locationId: true, position: true },
    });
    for (const s of shiftRows) {
      const key = `${s.locationId}|${positionKey(s.position)}`;
      const cur = out.get(key);
      if (cur) cur.noShows += 1;
    }
  }
  return out;
}

/* ----- The desk's rows ---------------------------------------------------------------- */

export type PayBand = 'below' | 'at' | 'above';
export const bandOf = (ratio: number): PayBand => (ratio < 0.97 ? 'below' : ratio > 1.03 ? 'above' : 'at');

export interface BandStats {
  band: PayBand;
  shifts: number;
  filled: number;
  fillRate: number | null;
  noShowRate: number | null;
}

export interface Recommendation {
  payRate: number;
  billRate: number | null;
  /** Plain sentence the desk shows. */
  reason: string;
  /** 'thin' when fewer than 30 shifts back the comparison. */
  confidence: 'solid' | 'thin';
  /** The margin the bill rate is priced to, and where it came from. */
  marginPct: number;
  marginSource: 'target' | 'current' | 'default';
}

export interface MarketRow {
  key: string;
  clientId: string;
  clientName: string;
  siteId: string;
  siteName: string;
  position: string;
  payRate: number;
  billRate: number | null;
  markupPct: number | null;
  area: { code: string; name: string } | null;
  soc: { code: string; title: string } | null;
  market: MarketFigures | null;
  percentile: number | null;
  gapToMedian: number | null;
  fill: FillStats & { fillRate: number | null; noShowRate: number | null };
  recommendation: Recommendation | null;
}

const MIN_SHIFTS = 30;
const round2 = (x: number) => Math.round(x * 100) / 100;
const loadedCost = (pay: number) => pay * (1 + env.LABOR_BURDEN_PERCENT / 100) + env.LABOR_OVERHEAD_PER_HOUR;

/** The bill rate that keeps `marginPct` at this pay: loaded cost ÷ (1 − margin). */
export function billForMargin(pay: number, marginPct: number): number {
  return round2(loadedCost(pay) / (1 - marginPct / 100));
}

export function marginOf(pay: number, bill: number): number {
  return Math.round(((bill - loadedCost(pay)) / bill) * 1000) / 10;
}

/**
 * The recommendation for one store-role, given the company-wide fill at
 * each pay band for its occupation. Never recommends a pay cut: above
 * market with full fill reads as "room to hold".
 */
export function recommend(input: {
  payRate: number;
  billRate: number | null;
  market: MarketFigures;
  fill: FillStats;
  bands: Map<PayBand, BandStats>;
  targetMarginPct: number | null;
  positionLabel: string;
}): Recommendation | null {
  const { payRate, market } = input;
  if (market.median === null) return null;
  const ratio = payRate / market.median;
  const band = bandOf(ratio);
  const here = input.fill.shifts ? input.fill.filled / input.fill.shifts : null;
  const at = input.bands.get('at');
  const mine = input.bands.get(band);
  const thin = (mine?.shifts ?? 0) < MIN_SHIFTS || (at?.shifts ?? 0) < MIN_SHIFTS;
  const margin =
    input.targetMarginPct !== null
      ? { pct: input.targetMarginPct, source: 'target' as const }
      : input.billRate
        ? { pct: marginOf(payRate, input.billRate), source: 'current' as const }
        : { pct: env.DEFAULT_TARGET_MARGIN_PCT, source: 'default' as const };
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? null : `${Math.round(x * 100)}%`);
  const gap = round2(market.median - payRate);
  let pay = payRate;
  let reason: string;
  if (band === 'below') {
    pay = round2(market.median);
    const fillLine =
      here !== null && at?.fillRate != null
        ? ` Fill here is ${pct(here)} against ${pct(at.fillRate)} where you pay at the median.`
        : '';
    reason = `Pay $${gap.toFixed(2)} below the ${market.areaName} median for ${input.positionLabel.toLowerCase()}.${fillLine}`;
  } else if (band === 'above') {
    reason =
      here !== null && here >= 0.95
        ? `Above the metro median by $${(-gap).toFixed(2)} and ${pct(here)} filled — room to hold this rate.`
        : `Above the metro median by $${(-gap).toFixed(2)}; fill here is ${pct(here) ?? 'not yet measured'}, so pay isn't what's holding it back.`;
  } else {
    reason = `At the ${market.areaName} median. ${here !== null ? `Fill here is ${pct(here)}.` : 'No shifts here yet to measure fill.'}`;
  }
  return {
    payRate: pay,
    billRate: billForMargin(pay, margin.pct),
    reason: thin ? `${reason} Few shifts back this comparison yet — read it as a direction, not a number.` : reason,
    confidence: thin ? 'thin' : 'solid',
    marginPct: margin.pct,
    marginSource: margin.source,
  };
}

/** Every (store, role) with a rate card, in the caller's reach, priced against its metro. */
export async function marketRows(
  user: SessionUser,
  filters: { clientId?: string | null; siteId?: string | null; position?: string | null } = {},
  db: Db = defaultPrisma,
  now = new Date(),
): Promise<{ rows: MarketRow[]; bands: Record<string, BandStats[]>; truncated: boolean }> {
  const tenantId = tenantIdForWrite();
  const reach = internalSites(user);
  const sites = await db.site.findMany({
    where: scopeWhere<Prisma.SiteWhereInput>(
      { tenantId, deletedAt: null, isActive: true, clientId: { not: null } },
      reach ?? undefined,
      filters.clientId ? { clientId: filters.clientId } : undefined,
      filters.siteId ? { id: filters.siteId } : undefined,
    ),
    orderBy: [{ name: 'asc' }],
    take: 1001,
    select: { id: true, name: true, clientId: true, marketAreaCode: true, marketAreaName: true, client: { select: { id: true, name: true, targetMarginPct: true, deletedAt: true } } },
  });
  const truncated = sites.length > 1000;
  const live = sites.slice(0, 1000).filter((s) => s.client && !s.client.deletedAt);
  const clientIds = [...new Set(live.map((s) => s.clientId!))];
  const cardsByClient = new Map<string, Awaited<ReturnType<typeof currentRateCards>>>();
  for (const id of clientIds) cardsByClient.set(id, await currentRateCards(db as PrismaClient, id));
  const socMap = await socMapFor(db);
  const fill = await fillByStoreRole(db, live.map((s) => s.id), 90, now);

  const pairs: Array<{ areaCode: string; socCode: string }> = [];
  for (const s of live) {
    if (!s.marketAreaCode) continue;
    for (const c of cardsByClient.get(s.clientId!) ?? []) {
      const soc = socMap.get(positionKey(c.position));
      if (soc) pairs.push({ areaCode: s.marketAreaCode, socCode: soc.socCode });
    }
  }
  const wages = await latestWages(db, pairs);

  // Company-wide fill at each pay band, per occupation: the elasticity read.
  type Draft = { s: (typeof live)[number]; card: { position: string; payRate: number; billRate: number | null }; soc: { socCode: string; socTitle: string } | null; market: MarketFigures | null; f: FillStats };
  const drafts: Draft[] = [];
  for (const s of live) {
    for (const card of cardsByClient.get(s.clientId!) ?? []) {
      if (filters.position && positionKey(card.position) !== positionKey(filters.position)) continue;
      const soc = socMap.get(positionKey(card.position)) ?? null;
      const market = soc && s.marketAreaCode ? (wages.get(`${s.marketAreaCode}|${soc.socCode}`) ?? null) : null;
      drafts.push({ s, card, soc, market, f: fill.get(`${s.id}|${positionKey(card.position)}`) ?? { shifts: 0, filled: 0, noShows: 0 } });
    }
  }
  const bandAcc = new Map<string, Map<PayBand, { shifts: number; filled: number; noShows: number }>>();
  for (const d of drafts) {
    if (!d.soc || !d.market?.median) continue;
    const band = bandOf(d.card.payRate / d.market.median);
    const m = bandAcc.get(d.soc.socCode) ?? new Map();
    const cur = m.get(band) ?? { shifts: 0, filled: 0, noShows: 0 };
    cur.shifts += d.f.shifts;
    cur.filled += d.f.filled;
    cur.noShows += d.f.noShows;
    m.set(band, cur);
    bandAcc.set(d.soc.socCode, m);
  }
  const bandStats = new Map<string, Map<PayBand, BandStats>>();
  const bandsOut: Record<string, BandStats[]> = {};
  for (const [soc, m] of bandAcc) {
    const stats = new Map<PayBand, BandStats>();
    for (const band of ['below', 'at', 'above'] as PayBand[]) {
      const v = m.get(band) ?? { shifts: 0, filled: 0, noShows: 0 };
      stats.set(band, { band, shifts: v.shifts, filled: v.filled, fillRate: v.shifts ? v.filled / v.shifts : null, noShowRate: v.filled ? v.noShows / v.filled : null });
    }
    bandStats.set(soc, stats);
    bandsOut[soc] = [...stats.values()];
  }

  const rows: MarketRow[] = drafts.map((d) => {
    const median = d.market?.median ?? null;
    const target = d.s.client!.targetMarginPct === null ? null : Number(d.s.client!.targetMarginPct);
    return {
      key: `${d.s.id}|${positionKey(d.card.position)}`,
      clientId: d.s.clientId!,
      clientName: d.s.client!.name,
      siteId: d.s.id,
      siteName: d.s.name,
      position: d.card.position,
      payRate: d.card.payRate,
      billRate: d.card.billRate,
      markupPct: d.card.billRate ? Math.round((d.card.billRate / d.card.payRate - 1) * 1000) / 10 : null,
      area: d.s.marketAreaCode ? { code: d.s.marketAreaCode, name: d.s.marketAreaName ?? cbsaByCode(d.s.marketAreaCode)?.name ?? d.s.marketAreaCode } : null,
      soc: d.soc ? { code: d.soc.socCode, title: d.soc.socTitle } : null,
      market: d.market,
      percentile: d.market ? percentileOf(d.card.payRate, d.market) : null,
      gapToMedian: median !== null ? round2(median - d.card.payRate) : null,
      fill: { ...d.f, fillRate: d.f.shifts ? d.f.filled / d.f.shifts : null, noShowRate: d.f.filled ? d.f.noShows / d.f.filled : null },
      recommendation:
        d.market && d.soc
          ? recommend({
              payRate: d.card.payRate,
              billRate: d.card.billRate,
              market: d.market,
              fill: d.f,
              bands: bandStats.get(d.soc.socCode) ?? new Map(),
              targetMarginPct: target,
              positionLabel: d.card.position,
            })
          : null,
    };
  });
  rows.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.siteName.localeCompare(b.siteName) || a.position.localeCompare(b.position));
  return { rows, bands: bandsOut, truncated };
}

/* ----- The stable helper ------------------------------------------------------------------- */

export interface MarketPosition {
  siteId: string;
  position: string;
  payRate: number;
  areaName: string;
  socTitle: string;
  median: number;
  /** pay ÷ metro median: 0.9 = 10% below. */
  ratioToMedian: number;
  percentile: number | null;
  gapToMedian: number;
  year: number;
}

/**
 * Where one person's — or one store-role's — pay sits in its metro. Null
 * when the store has no metro, the role no occupation, or there are no
 * figures yet. The person form reads their open store placement, their
 * latest shift's role there, and the rate in force for it (their own
 * hourly pay record wins when they have one).
 */
export async function marketPosition(
  input: { associateId: string } | { siteId: string; position: string },
  db: Db = defaultPrisma,
): Promise<MarketPosition | null> {
  let siteId: string;
  let position: string;
  let personalRate: number | null = null;
  if ('associateId' in input) {
    const assignment = await db.associateAssignment.findFirst({ where: { associateId: input.associateId, endedAt: null }, orderBy: { startedAt: 'desc' }, select: { locationId: true } });
    if (!assignment) return null;
    siteId = assignment.locationId;
    const shift = await db.shift.findFirst({ where: { assignedAssociateId: input.associateId, locationId: siteId }, orderBy: { startsAt: 'desc' }, select: { position: true } });
    if (!shift) return null;
    position = shift.position;
    const comp = await db.compensationRecord.findFirst({
      where: { associateId: input.associateId, payType: 'HOURLY', effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
      select: { amount: true },
    });
    personalRate = comp ? Number(comp.amount) : null;
  } else {
    siteId = input.siteId;
    position = input.position;
  }
  const site = await db.site.findFirst({ where: { id: siteId, deletedAt: null }, select: { clientId: true, marketAreaCode: true, tenantId: true } });
  if (!site?.marketAreaCode) return null;
  const map = await db.positionSocMap.findFirst({ where: { tenantId: site.tenantId, positionKey: positionKey(position) }, select: { socCode: true } });
  if (!map) return null;
  const wage = (await latestWages(db, [{ areaCode: site.marketAreaCode, socCode: map.socCode }])).get(`${site.marketAreaCode}|${map.socCode}`);
  if (!wage?.median) return null;
  let payRate = personalRate;
  if (payRate === null && site.clientId) {
    const card = (await currentRateCards(db as PrismaClient, site.clientId)).find((c) => positionKey(c.position) === positionKey(position));
    payRate = card?.payRate ?? null;
  }
  if (payRate === null) return null;
  return {
    siteId,
    position,
    payRate,
    areaName: wage.areaName,
    socTitle: wage.socTitle,
    median: wage.median,
    ratioToMedian: Math.round((payRate / wage.median) * 1000) / 1000,
    percentile: percentileOf(payRate, wage),
    gapToMedian: round2(wage.median - payRate),
    year: wage.year,
  };
}

/** Catalog exports for the mapping screen. */
export const MARKET_CATALOG = { soc: SOC_CATALOG, cbsa: CBSA_CATALOG };
