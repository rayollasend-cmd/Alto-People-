import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { jurisdictionsFor, loadRulePool, rulesForSite, setsInForce, type StoredRuleSet } from '../lib/laborRules/index.js';
import { ApprovalSchema, OverrideInputSchema, OverrideUpdateSchema, activateSet, createOverride, retireSet, updateDraft } from '../lib/laborRules/overrides.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-2 — the Rules page. Reads (steps 2, 3) for payroll, the org's admins
 * and the executive, who see the same rules pay will use; the organization's
 * and sites' own rules (step 6) under manage:org, so the executive stays
 * read-only.
 *
 *   GET /labor-rules/sets         every pack and this tenant's overrides, with citation and status
 *   GET /labor-rules/sites        each site: its jurisdictions and the rules in force on a date
 *   GET /labor-rules/sites/:id    one site, with which set set each value
 *   GET /labor-rules/shadow       step 3: finalized runs recomputed by the engine, with their differences
 *   GET /labor-rules/shadow/:id   one run's differences by person, with the engine's reasons
 *   POST /labor-rules/overrides             step 6: a tenant or site override, DRAFT (manage:org)
 *   PATCH /labor-rules/sets/:id             edit a draft override
 *   POST /labor-rules/sets/:id/activate     sign it (a note is required; packs: the operator, with counsel)
 *   POST /labor-rules/sets/:id/retire       retire it (never deleted)
 */

export const laborRulesRouter = Router();

// view:payroll also reaches every associate (their own pay); these reads are for the desks that run
// pay, the org's admins and the executive.
const VIEW = requireAnyCapability('process:payroll', 'manage:org', 'view:executive');
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

/* --------------------------------------------------------------- shadow */

/** Step 3: each finalized run recomputed by the engine beside what it paid. */
laborRulesRouter.get('/shadow', VIEW, async (_req, res) => {
  const rows = await prisma.laborShadowRun.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: { periodEnd: 'desc' }, take: 52 });
  res.json({
    runs: rows.map((r) => ({
      id: r.id,
      payrollRunId: r.payrollRunId,
      periodStart: r.periodStart.toISOString().slice(0, 10),
      periodEnd: r.periodEnd.toISOString().slice(0, 10),
      associates: r.associates,
      differences: r.differences,
      amountDifference: Number(r.amountDifference),
      penaltyHours: Number(r.penaltyHours),
      ranAt: r.ranAt.toISOString(),
    })),
  });
});

laborRulesRouter.get('/shadow/:id', VIEW, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const run = await prisma.laborShadowRun.findFirst({
    where: { id, tenantId: tenantIdForWrite() },
    include: { diffs: { include: { associate: { select: { firstName: true, lastName: true } } }, orderBy: { amountDifference: 'desc' } } },
  });
  if (!run) throw new HttpError(404, 'shadow_run_not_found', 'Shadow run not found.');
  res.json({
    id: run.id,
    periodStart: run.periodStart.toISOString().slice(0, 10),
    periodEnd: run.periodEnd.toISOString().slice(0, 10),
    associates: run.associates,
    differences: run.diffs.map((d) => ({
      associateId: d.associateId,
      name: `${d.associate.firstName} ${d.associate.lastName}`.trim(),
      paid: { regularHours: Number(d.paidRegular), overtimeHours: Number(d.paidOvertime) },
      engine: { regularHours: Number(d.engineRegular), overtimeHours: Number(d.engineOvertime), doubleTimeHours: Number(d.engineDouble) },
      hourlyRate: Number(d.hourlyRate),
      amountDifference: Number(d.amountDifference),
      penaltyHours: Number(d.penaltyHours),
      reasons: d.reasons,
    })),
  });
});

/* ------------------------------------------------------------ overrides */

/** Step 6: the organization's and each site's own rules (manage:org; the executive stays read-only). */
const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();

laborRulesRouter.post('/overrides', MANAGE, async (req, res) => {
  const row = await createOverride(prisma, tenantIdForWrite(), OverrideInputSchema.parse(req.body), req.user!.id);
  res.status(201).json({ id: row.id, status: row.status, version: row.version });
});

laborRulesRouter.patch('/sets/:id', MANAGE, async (req, res) => {
  const row = await updateDraft(prisma, tenantIdForWrite(), Id.parse(req.params.id), OverrideUpdateSchema.parse(req.body), req.user!.id);
  res.json({ id: row.id, status: row.status });
});

laborRulesRouter.post('/sets/:id/activate', MANAGE, async (req, res) => {
  const row = await activateSet(prisma, tenantIdForWrite(), Id.parse(req.params.id), ApprovalSchema.parse(req.body).note, req.user!.id);
  res.json({ id: row.id, status: row.status, approvedAt: row.approvedAt?.toISOString() ?? null });
});

laborRulesRouter.post('/sets/:id/retire', MANAGE, async (req, res) => {
  const row = await retireSet(prisma, tenantIdForWrite(), Id.parse(req.params.id), req.user!.id);
  res.json({ id: row.id, status: row.status });
});
