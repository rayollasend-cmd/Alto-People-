import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { jurisdictionsFor, loadRulePool, rulesForSite, setsInForce, type StoredRuleSet } from '../lib/laborRules/index.js';
import { ApprovalSchema, OverrideInputSchema, OverrideUpdateSchema, activateSet, createOverride, retireSet, updateDraft } from '../lib/laborRules/overrides.js';
import { ALTO_TENANT_ID, tenantIdForWrite, withPlatformScope } from '../lib/tenant.js';
import { enqueueAudit } from '../lib/audit.js';
import { EXEMPT_REASONS } from '../lib/predictabilityPay.js';
import { validateRoundingInput } from '../lib/punchRounding.js';
import { orgSettingIdFor } from '../lib/branding.js';
import { assertSiteInScope } from '../lib/scope.js';
import { ATTESTATION_TEXT, LIVE_JURISDICTIONS, buildChangeReport, endLive, jurisdictionLabel, requestGoLive } from '../lib/laborRules/live.js';

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
    // Spread of hours / split shift (lib/laborRules/evaluate): the spread line in hours, and whether a split shift owes it.
    spreadOfHoursHours: p.spreadOfHours?.premiumHours ? (p.spreadOfHours.thresholdHours ?? null) : null,
    splitShiftPremium: !!(p.spreadOfHours?.premiumHours && p.spreadOfHours.splitGapMinutes != null),
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

/** The operator edits, signs and retires the shared packs (no tenant): as the operator, on the record. */
const asOperatorForShared = <T,>(fn: () => Promise<T>): Promise<T> =>
  tenantIdForWrite() === ALTO_TENANT_ID ? withPlatformScope(fn) : fn();

laborRulesRouter.patch('/sets/:id', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const row = await asOperatorForShared(() => updateDraft(prisma, tenantId, Id.parse(req.params.id), OverrideUpdateSchema.parse(req.body), req.user!.id));
  res.json({ id: row.id, status: row.status });
});

laborRulesRouter.post('/sets/:id/activate', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const row = await asOperatorForShared(() => activateSet(prisma, tenantId, Id.parse(req.params.id), ApprovalSchema.parse(req.body).note, req.user!.id));
  res.json({ id: row.id, status: row.status, approvedAt: row.approvedAt?.toISOString() ?? null });
});

laborRulesRouter.post('/sets/:id/retire', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const row = await asOperatorForShared(() => retireSet(prisma, tenantId, Id.parse(req.params.id), req.user!.id));
  res.json({ id: row.id, status: row.status });
});

/* ------------------------------------------------------------- going live */

/**
 * Step 4 — a jurisdiction (or one site) pays by the engine.
 *
 *   GET  /labor-rules/activations               each covered state: shadow, waiting or live, with history
 *   GET  /labor-rules/change-report             what the last runs would have paid, by person and rule
 *   POST /labor-rules/activations               go live: counsel's sign-off + a second person (202 when waiting)
 *   POST /labor-rules/activations/:id/end       back to shadow, at once
 */
const ActivationInput = z.object({
  jurisdiction: z.string().regex(/^US-[A-Z]{2}$/),
  siteId: z.string().uuid().nullable().optional(),
  counselName: z.string().trim().min(2).max(120),
  counselFirm: z.string().trim().min(2).max(160),
  counselSignedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  attestation: z.string().trim().min(10).max(2000),
});

const activationOut = (a: Awaited<ReturnType<typeof prisma.laborRuleActivation.findFirst>>, names: Map<string, string>) =>
  a && {
    id: a.id,
    jurisdiction: a.jurisdiction,
    siteId: a.siteId,
    status: a.status,
    signedLabels: a.signedLabels,
    counselName: a.counselName,
    counselFirm: a.counselFirm,
    counselSignedOn: a.counselSignedOn.toISOString().slice(0, 10),
    changeReport: a.changeReport,
    approvalRequestId: a.approvalRequestId,
    requestedBy: a.requestedById ? names.get(a.requestedById) ?? null : null,
    activatedBy: a.activatedById ? names.get(a.activatedById) ?? null : null,
    activatedAt: a.activatedAt?.toISOString() ?? null,
    endedBy: a.endedById ? names.get(a.endedById) ?? null : null,
    endedAt: a.endedAt?.toISOString() ?? null,
    endReason: a.endReason,
    createdAt: a.createdAt.toISOString(),
  };

async function userNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, email: true, displayName: true, associate: { select: { firstName: true, lastName: true } } } });
  return new Map(users.map((u) => [u.id, u.associate ? `${u.associate.firstName} ${u.associate.lastName}` : u.displayName?.trim() || u.email]));
}

laborRulesRouter.get('/activations', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [rows, sites] = await Promise.all([
    prisma.laborRuleActivation.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, state: true }, orderBy: { name: 'asc' }, take: 2000 }),
  ]);
  const names = await userNames(rows.flatMap((r) => [r.requestedById, r.activatedById, r.endedById]));
  res.json({
    attestation: ATTESTATION_TEXT,
    jurisdictions: LIVE_JURISDICTIONS.map((j) => {
      const code = j.replace(/^US-/, '');
      const mine = rows.filter((r) => r.jurisdiction === j);
      const stateWide = mine.find((r) => !r.siteId && (r.status === 'LIVE' || r.status === 'PENDING')) ?? null;
      return {
        jurisdiction: j,
        label: jurisdictionLabel(j),
        sites: sites.filter((s) => (s.state ?? '').toUpperCase() === code).map((s) => {
          const own = mine.find((r) => r.siteId === s.id && (r.status === 'LIVE' || r.status === 'PENDING')) ?? null;
          return { id: s.id, name: s.name, activation: activationOut(own, names) };
        }),
        current: activationOut(stateWide, names),
        history: mine.slice(0, 20).map((r) => activationOut(r, names)),
      };
    }),
  });
});

laborRulesRouter.get('/change-report', VIEW, async (req, res) => {
  const q = z.object({ jurisdiction: z.string().regex(/^US-[A-Z]{2}$/), siteId: z.string().uuid().optional(), runs: z.coerce.number().int().min(1).max(12).optional() }).parse(req.query);
  const tenantId = tenantIdForWrite();
  if (q.siteId && !(await prisma.site.findFirst({ where: { id: q.siteId, tenantId, deletedAt: null }, select: { id: true } }))) throw new HttpError(404, 'site_not_found', 'Site not found.');
  res.json(await buildChangeReport(prisma, tenantId, { jurisdiction: q.jurisdiction, siteId: q.siteId ?? null, runs: q.runs }));
});

laborRulesRouter.post('/activations', MANAGE, async (req, res) => {
  const out = await requestGoLive(prisma, ActivationInput.parse(req.body), req.user!.id);
  if (out.pending && out.approvalId) {
    res.status(202).json({ pending: true, approvalId: out.approvalId, title: 'Waiting on a second person', activationId: out.activation.id });
    return;
  }
  res.status(201).json({ pending: false, activationId: out.activation.id, status: out.activation.status });
});

laborRulesRouter.post('/activations/:id/end', MANAGE, async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
  const row = await endLive(prisma, Id.parse(req.params.id), req.user!.id, reason);
  res.json({ id: row.id, status: row.status });
});

/* ------------------------------------------------------------ timekeeping */

/**
 *   GET /labor-rules/timekeeping          rounding (organization and per site) and the overtime-rotation switch
 *   PUT /labor-rules/rounding             set a policy (siteId null = the organization's default)
 *   DELETE /labor-rules/rounding/:siteId  a site goes back to the organization's default
 *   PUT /labor-rules/ot-equalization      offer overtime fewest-overtime-first, on or off
 *   GET /labor-rules/schedule-changes     predictability pay recorded for late schedule changes
 */
laborRulesRouter.get('/timekeeping', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const [rows, setting, sites] = await Promise.all([
    prisma.punchRoundingPolicy.findMany({ where: { tenantId }, select: { siteId: true, mode: true, increment: true, updatedAt: true } }),
    prisma.orgSetting.findFirst({ where: { OR: [{ tenantId }, { id: orgSettingIdFor(tenantId) }] }, select: { otEqualization: true } }),
    prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, state: true }, orderBy: { name: 'asc' }, take: 2000 }),
  ]);
  const org = rows.find((r) => r.siteId === null);
  res.json({
    rounding: { mode: org?.mode ?? 'NONE', increment: org?.increment ?? 15, updatedAt: org?.updatedAt?.toISOString() ?? null },
    siteRounding: rows.filter((r) => r.siteId).map((r) => ({ siteId: r.siteId, siteName: sites.find((s) => s.id === r.siteId)?.name ?? 'Site', mode: r.mode, increment: r.increment })),
    sites: sites.map((s) => ({ id: s.id, name: s.name, state: s.state })),
    otEqualization: setting?.otEqualization ?? false,
  });
});

laborRulesRouter.put('/rounding', MANAGE, async (req, res) => {
  const body = z.object({ siteId: z.string().uuid().nullable().optional(), mode: z.string().max(30), increment: z.number().int().optional() }).parse(req.body ?? {});
  const policy = validateRoundingInput(body);
  const tenantId = tenantIdForWrite();
  if (body.siteId && !(await prisma.site.findFirst({ where: { id: body.siteId, tenantId, deletedAt: null }, select: { id: true } }))) throw new HttpError(404, 'site_not_found', 'Site not found.');
  if (body.siteId) await assertSiteInScope(prisma, req.user!, body.siteId);
  const existing = await prisma.punchRoundingPolicy.findFirst({ where: { tenantId, siteId: body.siteId ?? null } });
  const saved = existing
    ? await prisma.punchRoundingPolicy.update({ where: { id: existing.id }, data: { mode: policy.mode, increment: policy.increment, updatedById: req.user!.id } })
    : await prisma.punchRoundingPolicy.create({ data: { tenantId, siteId: body.siteId ?? null, mode: policy.mode, increment: policy.increment, updatedById: req.user!.id } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'time.rounding_policy_set', entityType: 'PunchRoundingPolicy', entityId: saved.id, metadata: { siteId: body.siteId ?? null, before: existing ? { mode: existing.mode, increment: existing.increment } : null, after: { mode: policy.mode, increment: policy.increment } } }, 'laborRules.rounding');
  res.json({ siteId: saved.siteId, mode: saved.mode, increment: saved.increment });
});

laborRulesRouter.delete('/rounding/:siteId', MANAGE, async (req, res) => {
  const siteId = Id.parse(req.params.siteId);
  const tenantId = tenantIdForWrite();
  // The site must be this tenant's and inside the caller's reach.
  if (!(await prisma.site.findFirst({ where: { id: siteId, tenantId, deletedAt: null }, select: { id: true } }))) throw new HttpError(404, 'site_not_found', 'Site not found.');
  await assertSiteInScope(prisma, req.user!, siteId);
  const row = await prisma.punchRoundingPolicy.findFirst({ where: { tenantId, siteId } });
  if (row) {
    await prisma.punchRoundingPolicy.delete({ where: { id: row.id } });
    enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'time.rounding_policy_cleared', entityType: 'PunchRoundingPolicy', entityId: row.id, metadata: { siteId, before: { mode: row.mode, increment: row.increment } } }, 'laborRules.rounding');
  }
  res.status(204).end();
});

laborRulesRouter.put('/ot-equalization', MANAGE, async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const row = await prisma.orgSetting.findFirst({ where: { OR: [{ tenantId }, { id: orgSettingIdFor(tenantId) }] }, select: { id: true, otEqualization: true } });
  if (row) await prisma.orgSetting.update({ where: { id: row.id }, data: { otEqualization: enabled } });
  else await prisma.orgSetting.create({ data: { id: orgSettingIdFor(tenantId), tenantId, otEqualization: enabled } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'time.ot_equalization_set', entityType: 'OrgSetting', entityId: row?.id ?? orgSettingIdFor(tenantId), metadata: { before: row?.otEqualization ?? false, after: enabled } }, 'laborRules.ot');
  res.json({ otEqualization: enabled });
});

laborRulesRouter.get('/schedule-changes', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const rows = await prisma.scheduleChangePremium.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 201,
    include: { associate: { select: { firstName: true, lastName: true } } },
  });
  const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is string => !!x))];
  const sites = new Map((await prisma.site.findMany({ where: { id: { in: siteIds }, tenantId }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  res.json({
    truncated: rows.length > 200,
    changes: rows.slice(0, 200).map((r) => ({
      id: r.id,
      associateId: r.associateId,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      siteName: r.siteId ? sites.get(r.siteId) ?? null : null,
      workDate: r.workDate.toISOString().slice(0, 10),
      change: r.change,
      noticeDays: Number(r.noticeDays),
      premiumHours: Number(r.premiumHours),
      premiumCents: r.premiumCents,
      exempt: r.exempt,
      exemptReason: r.exemptReason,
      rule: r.rule,
      live: r.live,
      paid: !!r.payrollRunId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

/**
 * PATCH /labor-rules/schedule-changes/:id — { exemptReason | null, note }:
 * excuse a late change the law exempts (the worker asked, a mutual swap, a
 * voluntary pick-up, an emergency), or take the excuse back. Scheduling
 * doesn't stop to ask on every drag, so the reason is recorded here, by
 * someone who can answer for pay, and only until payroll has paid it.
 */
const ExemptInput = z.object({
  exemptReason: z.enum(EXEMPT_REASONS).nullable(),
  note: z.string().trim().max(500).optional(),
});
laborRulesRouter.patch('/schedule-changes/:id', requireAnyCapability('manage:org', 'process:payroll'), async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = ExemptInput.parse(req.body ?? {});
  const tenantId = tenantIdForWrite();
  const row = await prisma.scheduleChangePremium.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'not_found', 'Schedule change not found.');
  if (row.payrollRunId) throw new HttpError(409, 'already_paid', 'This was already paid on a payroll run; correct it with an amendment instead.');
  if (row.siteId) await assertSiteInScope(prisma, req.user!, row.siteId);
  if (input.exemptReason && !input.note) throw new HttpError(400, 'note_required', 'Say briefly why — for example, the worker asked by text on Tuesday.');
  const updated = await prisma.scheduleChangePremium.update({
    where: { id },
    data: { exempt: !!input.exemptReason, exemptReason: input.exemptReason, reasonText: input.note ?? row.reasonText },
  });
  enqueueAudit(
    {
      actorUserId: req.user!.id,
      action: input.exemptReason ? 'labor.schedule_change_exempted' : 'labor.schedule_change_exemption_removed',
      entityType: 'ScheduleChangePremium',
      entityId: id,
      metadata: { associateId: row.associateId, from: row.exemptReason, to: input.exemptReason, premiumCents: row.premiumCents, premiumHours: Number(row.premiumHours), note: input.note ?? null },
    },
    'laborRules.scheduleChange',
  );
  res.json({ id: updated.id, exempt: updated.exempt, exemptReason: updated.exemptReason });
});
