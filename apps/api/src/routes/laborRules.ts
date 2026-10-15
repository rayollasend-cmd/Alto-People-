import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { jurisdictionsFor, loadRulePool, rulesForSite, setsInForce, type StoredRuleSet } from '../lib/laborRules/index.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-2 step 2 — the Rules page's reads (read-only; overrides arrive in
 * step 6 under manage:org). view:payroll, so payroll, HR and the executive
 * see the same rules pay will use; the executive stays read-only.
 *
 *   GET /labor-rules/sets         every pack and this tenant's overrides, with citation and status
 *   GET /labor-rules/sites        each site: its jurisdictions and the rules in force on a date
 *   GET /labor-rules/sites/:id    one site, with which set set each value
 */

export const laborRulesRouter = Router();

const VIEW = requireCapability('view:payroll');
const DateQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const today = () => new Date().toISOString().slice(0, 10);

const setOut = (s: StoredRuleSet) => ({
  id: s.id,
  jurisdiction: s.level === 'SITE' ? 'SITE' : s.jurisdiction,
  level: s.level,
  siteId: s.siteId,
  effectiveFrom: s.effectiveFrom,
  version: s.version,
  status: s.status,
  shipped: s.tenantId === null,
  params: s.params,
  source: s.source,
  sourceDate: s.sourceDate,
  approvedBy: s.approvedBy,
  approvedAt: s.approvedAt,
  approvalNote: s.approvalNote,
});

laborRulesRouter.get('/sets', VIEW, async (_req, res) => {
  const pool = await loadRulePool(prisma, tenantIdForWrite());
  res.json({ sets: pool.map(setOut) });
});

const SITE_SELECT = { id: true, name: true, city: true, state: true, timezone: true, isActive: true } as const;

/** The values people ask about first, and which set each came from. */
function summary(r: ReturnType<typeof rulesForSite>) {
  const p = r.params;
  return {
    weeklyOvertimeHours: p.overtime?.weeklyThreshold ?? null,
    dailyOvertimeHours: p.overtime?.dailyThreshold ?? null,
    doubleTimeHours: p.overtime?.dailyDoubleThreshold ?? null,
    seventhDayRule: !!p.overtime?.seventhDayRule,
    minimumWageCents: p.minimumWage?.rateCents ?? null,
    mealRequiredAfterHours: p.meal?.requiredAfterHours ?? null,
    restPerHours: p.rest?.perHours ?? null,
    restBetweenShiftsHours: p.restBetweenShifts?.minHours ?? null,
    predictiveNoticeDays: p.predictive?.noticeDays ?? null,
    minorBands: p.minors?.bands?.length ?? 0,
  };
}

laborRulesRouter.get('/sites', VIEW, async (req, res) => {
  const { date = today() } = DateQuery.parse(req.query);
  const tenantId = tenantIdForWrite();
  const [pool, sites] = await Promise.all([
    loadRulePool(prisma, tenantId),
    prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: SITE_SELECT, orderBy: [{ state: 'asc' }, { name: 'asc' }], take: 2000 }),
  ]);
  res.json({
    date,
    sites: sites.map((s) => {
      const r = rulesForSite(pool, s, date);
      return { id: s.id, name: s.name, city: s.city, state: s.state, active: s.isActive, jurisdictions: jurisdictionsFor(s), layers: r.layers, payable: r.payable, fingerprint: r.fingerprint, summary: summary(r) };
    }),
  });
});

laborRulesRouter.get('/sites/:id', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const { date = today() } = DateQuery.parse(req.query);
  const tenantId = tenantIdForWrite();
  const site = await prisma.site.findFirst({ where: { id, tenantId, deletedAt: null }, select: SITE_SELECT });
  if (!site) throw new HttpError(404, 'site_not_found', 'Site not found.');
  const pool = await loadRulePool(prisma, tenantId);
  const r = rulesForSite(pool, site, date);
  const keys = new Set([...jurisdictionsFor(site), 'TENANT', `SITE:${site.id}`]);
  res.json({
    date,
    site: { id: site.id, name: site.name, city: site.city, state: site.state, timezone: site.timezone },
    jurisdictions: jurisdictionsFor(site),
    layers: r.layers,
    payable: r.payable,
    fingerprint: r.fingerprint,
    params: r.params,
    origin: r.origin,
    summary: summary(r),
    sets: setsInForce(pool.filter((s) => keys.has(s.jurisdiction)), date).map((s) => setOut(s as StoredRuleSet)),
  });
});
