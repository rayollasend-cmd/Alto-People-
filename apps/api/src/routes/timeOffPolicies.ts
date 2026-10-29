import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { assertSameTenant } from '../lib/sameTenant.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { resolvePoliciesForAssociate, syncPolicyEntitlements } from '../lib/timeOffPolicy.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * Time-off policies (lib/timeOffPolicy.ts): how leave is earned, for whom.
 * Mounted at /time-off/policies — reading needs view:time, writing
 * manage:time.
 */
export const timeOffPoliciesRouter = Router();

const MANAGE = requireCapability('manage:time');

const Category = z.enum(['SICK', 'VACATION', 'PTO', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER']);
const Mode = z.enum(['PER_HOUR_WORKED', 'PER_PERIOD', 'ANNUAL_GRANT']);
const Scope = z.enum(['ALL', 'CLIENT', 'SITE', 'DEPARTMENT', 'JOB_PROFILE']);

const Tier = z.object({
  afterMonths: z.number().int().min(1).max(600),
  accrualPerHour: z.number().min(0).max(1).nullable().optional(),
  minutesPerPeriod: z.number().int().min(0).max(100_000).nullable().optional(),
  annualMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

const PolicyInput = z.object({
  name: z.string().trim().min(2).max(120),
  category: Category,
  accrualMode: Mode,
  accrualPerHour: z.number().min(0).max(1).nullable().optional(),
  minutesPerPeriod: z.number().int().min(0).max(100_000).nullable().optional(),
  annualMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
  policyAnchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  capMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
  carryoverMaxMinutes: z.number().int().min(0).max(1_000_000).optional(),
  waitingPeriodDays: z.number().int().min(0).max(3650).optional(),
  tenureTiers: z.array(Tier).max(10).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

function validateRate(input: z.infer<typeof PolicyInput>) {
  if (input.accrualMode === 'PER_HOUR_WORKED' && !(input.accrualPerHour && input.accrualPerHour > 0)) {
    throw new HttpError(400, 'rate_required', 'A per-hour policy needs hours of leave earned per hour worked (1 per 30 = 0.0333).');
  }
  if (input.accrualMode === 'PER_PERIOD' && !(input.minutesPerPeriod && input.minutesPerPeriod > 0)) {
    throw new HttpError(400, 'rate_required', 'A monthly policy needs minutes granted each month.');
  }
  if (input.accrualMode === 'ANNUAL_GRANT' && !(input.annualMinutes && input.annualMinutes > 0)) {
    throw new HttpError(400, 'rate_required', 'A yearly policy needs the minutes granted each year.');
  }
}

function toRow(p: {
  id: string;
  name: string;
  category: string;
  accrualMode: string;
  accrualPerHour: Prisma.Decimal | null;
  minutesPerPeriod: number | null;
  annualMinutes: number | null;
  policyAnchorDate: Date;
  capMinutes: number | null;
  carryoverMaxMinutes: number;
  waitingPeriodDays: number;
  tenureTiers: unknown;
  isActive: boolean;
  notes: string | null;
  updatedAt: Date;
  assignments: Array<{ id: string; scopeKind: string; scopeId: string | null }>;
  _count?: { entitlements: number };
}) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    accrualMode: p.accrualMode,
    accrualPerHour: p.accrualPerHour ? Number(p.accrualPerHour) : null,
    minutesPerPeriod: p.minutesPerPeriod,
    annualMinutes: p.annualMinutes,
    policyAnchorDate: dateColumnKey(p.policyAnchorDate),
    capMinutes: p.capMinutes,
    carryoverMaxMinutes: p.carryoverMaxMinutes,
    waitingPeriodDays: p.waitingPeriodDays,
    tenureTiers: Array.isArray(p.tenureTiers) ? p.tenureTiers : [],
    isActive: p.isActive,
    notes: p.notes,
    updatedAt: p.updatedAt.toISOString(),
    assignments: p.assignments.map((a) => ({ id: a.id, scopeKind: a.scopeKind, scopeId: a.scopeId })),
    people: p._count?.entitlements ?? 0,
  };
}

const INCLUDE = { assignments: true, _count: { select: { entitlements: true } } } as const;

timeOffPoliciesRouter.get('/', async (_req, res, next) => {
  try {
    const rows = await prisma.timeOffPolicy.findMany({ where: { deletedAt: null }, include: INCLUDE, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
    // Names for the scopes, so the page never shows a bare id.
    const ids = { CLIENT: new Set<string>(), SITE: new Set<string>(), DEPARTMENT: new Set<string>(), JOB_PROFILE: new Set<string>() };
    for (const p of rows) for (const a of p.assignments) if (a.scopeId && a.scopeKind !== 'ALL') ids[a.scopeKind].add(a.scopeId);
    const [clients, sites, departments, jobProfiles] = await Promise.all([
      ids.CLIENT.size ? prisma.client.findMany({ where: { id: { in: [...ids.CLIENT] } }, select: { id: true, name: true } }) : [],
      ids.SITE.size ? prisma.site.findMany({ where: { id: { in: [...ids.SITE] } }, select: { id: true, name: true } }) : [],
      ids.DEPARTMENT.size ? prisma.department.findMany({ where: { id: { in: [...ids.DEPARTMENT] } }, select: { id: true, name: true } }) : [],
      ids.JOB_PROFILE.size ? prisma.jobProfile.findMany({ where: { id: { in: [...ids.JOB_PROFILE] } }, select: { id: true, title: true } }) : [],
    ]);
    const names: Record<string, string> = {};
    for (const c of clients) names[c.id] = c.name;
    for (const s of sites) names[s.id] = s.name;
    for (const d of departments) names[d.id] = d.name;
    for (const j of jobProfiles) names[j.id] = j.title;
    res.json({ policies: rows.map(toRow), scopeNames: names });
  } catch (err) {
    next(err);
  }
});

/** The scopes a policy can be assigned to, for the picker. */
timeOffPoliciesRouter.get('/scopes', async (_req, res, next) => {
  try {
    // Only this organization's places and groups: the picker names them.
    const tenantId = tenantIdForWrite();
    const [clients, sites, departments, jobProfiles] = await Promise.all([
      prisma.client.findMany({ where: { tenantId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
      prisma.site.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 1000 }),
      prisma.department.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' }, take: 500 }),
      prisma.jobProfile.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, title: true }, orderBy: { title: 'asc' }, take: 500 }),
    ]);
    res.json({
      CLIENT: clients,
      SITE: sites,
      DEPARTMENT: departments,
      JOB_PROFILE: jobProfiles.map((j) => ({ id: j.id, name: j.title })),
    });
  } catch (err) {
    next(err);
  }
});

/** What applies to one person, category by category. */
timeOffPoliciesRouter.get('/for/:associateId', async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertSameTenant('associate', associateId);
    const map = await resolvePoliciesForAssociate(prisma, associateId);
    res.json({ policies: [...map.values()].map((p) => ({ id: p.id, name: p.name, category: p.category, accrualMode: p.accrualMode })) });
  } catch (err) {
    next(err);
  }
});

timeOffPoliciesRouter.post('/', MANAGE, async (req, res, next) => {
  try {
    const input = PolicyInput.parse(req.body ?? {});
    validateRate(input);
    const created = await prisma.timeOffPolicy.create({
      data: {
        name: input.name,
        category: input.category,
        accrualMode: input.accrualMode,
        accrualPerHour: input.accrualPerHour ?? null,
        minutesPerPeriod: input.minutesPerPeriod ?? null,
        annualMinutes: input.annualMinutes ?? null,
        ...(input.policyAnchorDate ? { policyAnchorDate: new Date(`${input.policyAnchorDate}T00:00:00.000Z`) } : {}),
        capMinutes: input.capMinutes ?? null,
        carryoverMaxMinutes: input.carryoverMaxMinutes ?? 0,
        waitingPeriodDays: input.waitingPeriodDays ?? 0,
        tenureTiers: (input.tenureTiers ?? []) as unknown as Prisma.InputJsonValue,
        isActive: input.isActive ?? true,
        notes: input.notes ?? null,
      },
      include: INCLUDE,
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'timeoff.policy_created', entityType: 'TimeOffPolicy', entityId: created.id, metadata: { name: created.name, category: created.category, mode: created.accrualMode } }, 'timeoff.policy');
    res.status(201).json(toRow(created));
  } catch (err) {
    next(err);
  }
});

timeOffPoliciesRouter.patch('/:id', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.timeOffPolicy.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new HttpError(404, 'not_found', 'Policy not found.');
    const input = PolicyInput.partial().parse(req.body ?? {});
    const merged = PolicyInput.parse({
      name: input.name ?? existing.name,
      category: input.category ?? existing.category,
      accrualMode: input.accrualMode ?? existing.accrualMode,
      accrualPerHour: input.accrualPerHour !== undefined ? input.accrualPerHour : existing.accrualPerHour ? Number(existing.accrualPerHour) : null,
      minutesPerPeriod: input.minutesPerPeriod !== undefined ? input.minutesPerPeriod : existing.minutesPerPeriod,
      annualMinutes: input.annualMinutes !== undefined ? input.annualMinutes : existing.annualMinutes,
      capMinutes: input.capMinutes !== undefined ? input.capMinutes : existing.capMinutes,
      carryoverMaxMinutes: input.carryoverMaxMinutes ?? existing.carryoverMaxMinutes,
      waitingPeriodDays: input.waitingPeriodDays ?? existing.waitingPeriodDays,
      tenureTiers: input.tenureTiers ?? (existing.tenureTiers as unknown as z.infer<typeof Tier>[]),
      isActive: input.isActive ?? existing.isActive,
      notes: input.notes !== undefined ? input.notes : existing.notes,
      ...(input.policyAnchorDate ? { policyAnchorDate: input.policyAnchorDate } : {}),
    });
    validateRate(merged);
    const updated = await prisma.timeOffPolicy.update({
      where: { id },
      data: {
        name: merged.name,
        category: merged.category,
        accrualMode: merged.accrualMode,
        accrualPerHour: merged.accrualPerHour ?? null,
        minutesPerPeriod: merged.minutesPerPeriod ?? null,
        annualMinutes: merged.annualMinutes ?? null,
        ...(merged.policyAnchorDate ? { policyAnchorDate: new Date(`${merged.policyAnchorDate}T00:00:00.000Z`) } : {}),
        capMinutes: merged.capMinutes ?? null,
        carryoverMaxMinutes: merged.carryoverMaxMinutes ?? 0,
        waitingPeriodDays: merged.waitingPeriodDays ?? 0,
        tenureTiers: (merged.tenureTiers ?? []) as unknown as Prisma.InputJsonValue,
        isActive: merged.isActive ?? true,
        notes: merged.notes ?? null,
      },
      include: INCLUDE,
    });
    // People already on an annual policy follow its new numbers.
    if (updated.accrualMode === 'ANNUAL_GRANT') {
      const ents = await prisma.timeOffEntitlement.findMany({ where: { policyId: id }, select: { associateId: true } });
      for (const e of ents) await syncPolicyEntitlements(prisma, e.associateId);
    }
    enqueueAudit({ actorUserId: req.user!.id, action: 'timeoff.policy_updated', entityType: 'TimeOffPolicy', entityId: id, metadata: { changed: Object.keys(input) } }, 'timeoff.policy');
    res.json(toRow(updated));
  } catch (err) {
    next(err);
  }
});

timeOffPoliciesRouter.delete('/:id', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.timeOffPolicy.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new HttpError(404, 'not_found', 'Policy not found.');
    await prisma.timeOffPolicy.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'timeoff.policy_retired', entityType: 'TimeOffPolicy', entityId: id, metadata: { name: existing.name } }, 'timeoff.policy');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const AssignmentsInput = z.object({
  assignments: z.array(z.object({ scopeKind: Scope, scopeId: z.string().uuid().nullable().optional() })).max(200),
});

/** Replace who a policy applies to. ALL needs no id; the rest name one. */
timeOffPoliciesRouter.put('/:id/assignments', MANAGE, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const existing = await prisma.timeOffPolicy.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new HttpError(404, 'not_found', 'Policy not found.');
    const input = AssignmentsInput.parse(req.body ?? {});
    for (const a of input.assignments) {
      if (a.scopeKind !== 'ALL' && !a.scopeId) throw new HttpError(400, 'scope_required', `${a.scopeKind} needs an id.`);
    }
    const updated = await prisma.$transaction(async (tx) => {
      await tx.timeOffPolicyAssignment.deleteMany({ where: { policyId: id } });
      if (input.assignments.length > 0) {
        await tx.timeOffPolicyAssignment.createMany({
          data: input.assignments.map((a) => ({ policyId: id, scopeKind: a.scopeKind, scopeId: a.scopeKind === 'ALL' ? null : a.scopeId! })),
        });
      }
      return tx.timeOffPolicy.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    });
    enqueueAudit({ actorUserId: req.user!.id, action: 'timeoff.policy_assigned', entityType: 'TimeOffPolicy', entityId: id, metadata: { assignments: input.assignments } }, 'timeoff.policy');
    res.json(toRow(updated));
  } catch (err) {
    next(err);
  }
});
