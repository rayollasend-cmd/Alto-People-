import type { Prisma, PrismaClient } from '@prisma/client';
import { RuleParamsSchema, type ResolvedRules, type RuleLevel, type RuleSetDef } from './params.js';
import { SHIPPED_PACKS, jurisdictionsFor } from './packs.js';
import { resolveFor } from './resolve.js';

/**
 * Brief 2-2 step 2 — the rule sets in the database.
 *
 *   The pool for a tenant is every shipped pack (tenantId NULL) plus that
 *   tenant's own overrides; another tenant's rows are never read, so one
 *   tenant's override cannot move another's resolution. Status comes from
 *   the row: a pack is DRAFT until counsel's sign-off is recorded on it.
 *
 *   A tenant-wide override resolves under the key TENANT, a site's under
 *   SITE:<siteId>, so a site sees its own override and no other site's.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface StoredRuleSet extends RuleSetDef {
  id: string;
  tenantId: string | null;
  siteId: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Row = {
  id: string;
  tenantId: string | null;
  jurisdiction: string;
  level: string;
  siteId: string | null;
  effectiveFrom: Date;
  version: number;
  params: Prisma.JsonValue;
  source: string;
  sourceDate: Date;
  status: string;
  approvedAt: Date | null;
  approvalNote: string | null;
  approvedBy: { email: string } | null;
};

function toDef(r: Row): StoredRuleSet {
  const parsed = RuleParamsSchema.safeParse(r.params);
  return {
    id: r.id,
    tenantId: r.tenantId,
    siteId: r.siteId,
    // Overrides resolve under a key only their own tenant's and site's lookups name.
    jurisdiction: r.level === 'SITE' ? `SITE:${r.siteId}` : r.level === 'TENANT' ? 'TENANT' : r.jurisdiction,
    level: r.level as RuleLevel,
    effectiveFrom: ymd(r.effectiveFrom),
    version: r.version,
    // A row that no longer validates contributes nothing rather than something wrong.
    params: parsed.success ? parsed.data : {},
    source: r.source,
    sourceDate: ymd(r.sourceDate),
    status: r.status as RuleSetDef['status'],
    approvedBy: r.approvedBy?.email ?? null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvalNote: r.approvalNote,
  };
}

const SELECT = {
  id: true,
  tenantId: true,
  jurisdiction: true,
  level: true,
  siteId: true,
  effectiveFrom: true,
  version: true,
  params: true,
  source: true,
  sourceDate: true,
  status: true,
  approvedAt: true,
  approvalNote: true,
  approvedBy: { select: { email: true } },
} as const;

/** The shipped packs and this tenant's overrides (never another tenant's). */
export async function loadRulePool(db: Db, tenantId: string): Promise<StoredRuleSet[]> {
  const rows = await db.laborRuleSet.findMany({
    where: { OR: [{ tenantId: null }, { tenantId }] },
    select: SELECT,
    orderBy: [{ jurisdiction: 'asc' }, { effectiveFrom: 'asc' }, { version: 'asc' }],
  });
  return rows.map(toDef);
}

/** The rules for one site on one date, from a loaded pool. */
export function rulesForSite(pool: readonly RuleSetDef[], site: { id: string; state: string | null; city: string | null }, date: string): ResolvedRules {
  return resolveFor(pool, jurisdictionsFor(site), ['TENANT', `SITE:${site.id}`], date);
}

/**
 * Inserts any shipped pack the database lacks (by jurisdiction, date and
 * version), DRAFT. The migration seeds them in production; the test harness
 * calls this after each truncate, since cascades from Location and User clear
 * the table.
 */
export async function seedShippedPacks(db: Db): Promise<number> {
  const have = await db.laborRuleSet.findMany({ where: { tenantId: null }, select: { jurisdiction: true, effectiveFrom: true, version: true } });
  const key = (j: string, d: string, v: number) => `${j}|${d}|${v}`;
  const seen = new Set(have.map((h) => key(h.jurisdiction, ymd(h.effectiveFrom), h.version)));
  const missing = SHIPPED_PACKS.filter((p) => !seen.has(key(p.jurisdiction, p.effectiveFrom, p.version)));
  if (!missing.length) return 0;
  await db.laborRuleSet.createMany({
    data: missing.map((p) => ({
      tenantId: null,
      jurisdiction: p.jurisdiction,
      level: p.level,
      effectiveFrom: new Date(`${p.effectiveFrom}T00:00:00Z`),
      version: p.version,
      params: p.params as Prisma.InputJsonObject,
      source: p.source,
      sourceDate: new Date(`${p.sourceDate}T00:00:00Z`),
      status: 'DRAFT',
    })),
  });
  return missing.length;
}

/** Packs whose stored parameters differ from the code (a pack change without its migration). */
export async function packsDifferingFromCode(db: Db): Promise<string[]> {
  const rows = await db.laborRuleSet.findMany({ where: { tenantId: null }, select: { jurisdiction: true, effectiveFrom: true, version: true, params: true, source: true } });
  const out: string[] = [];
  for (const p of SHIPPED_PACKS) {
    const r = rows.find((x) => x.jurisdiction === p.jurisdiction && ymd(x.effectiveFrom) === p.effectiveFrom && x.version === p.version);
    const label = `${p.jurisdiction} ${p.effectiveFrom} v${p.version}`;
    if (!r) out.push(`${label}: missing`);
    else if (JSON.stringify(sortKeys(r.params)) !== JSON.stringify(sortKeys(p.params)) || r.source !== p.source) out.push(`${label}: differs`);
  }
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
