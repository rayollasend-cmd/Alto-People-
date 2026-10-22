import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { scopeActiveAssociates } from '../lib/scope.js';

/**
 * Phase 111 — Skills & competencies.
 *
 * Two surfaces:
 *   - Catalog management (HR adds the skill master list).
 *   - Per-associate skill claims with proficiency level.
 *
 * Search: GET /skills/search?q=python returns associates ordered by
 * proficiency, optionally filtered to a minimum level. The killer
 * staffing query — "find me everyone who knows Python at advanced+".
 *
 * Self-claims (wave 2): a signed-in person adds skills to their own record
 * (/me/skills) — the permission is the session's own associate, never an
 * id in the body. A self-claim is pending until someone with manage:org
 * verifies it; the claims waiting are GET /associate-skills/pending.
 */

export const skills111Router = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'] as const;

const LEVEL_RANK: Record<typeof LEVELS[number], number> = {
  BEGINNER: 1,
  INTERMEDIATE: 2,
  ADVANCED: 3,
  EXPERT: 4,
};

// ----- Catalog ----------------------------------------------------------

skills111Router.get('/skills', VIEW, async (req, res) => {
  const q = z.string().max(200).optional().parse(req.query.q);
  const rows = await prisma.skill.findMany({
    where: { tenantId: tenantIdForWrite(), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
    // Counted over the active people in the caller's reach.
    include: { _count: { select: { associateSkills: { where: { associate: { is: scopeActiveAssociates(req.user!) } } } } } },
    orderBy: { name: 'asc' },
    take: 200,
  });
  res.json({
    skills: rows.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      associateCount: s._count.associateSkills,
    })),
  });
});

skills111Router.post('/skills', MANAGE, async (req, res) => {
  const input = z
    .object({
      name: z.string().min(1).max(120),
      category: z.string().max(60).optional().nullable(),
    })
    .parse(req.body);
  try {
    const created = await prisma.skill.create({
      data: { name: input.name.trim(), category: input.category ?? null },
    });
    res.status(201).json({ id: created.id });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new HttpError(409, 'name_taken', 'A skill with that name already exists.');
    }
    throw err;
  }
});

skills111Router.delete('/skills/:id', MANAGE, async (req, res) => {
  await prisma.skill.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Associate skills -------------------------------------------------

const ClaimSchema = z.object({
  associateId: z.string().uuid(),
  skillId: z.string().uuid(),
  level: z.enum(LEVELS),
  yearsExperience: z.number().int().min(0).max(60).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

skills111Router.post('/associate-skills', MANAGE, async (req, res) => {
  const input = ClaimSchema.parse(req.body);
  // Upsert so re-claiming bumps the level/notes without dup rows.
  const row = await prisma.associateSkill.upsert({
    where: {
      associateId_skillId: {
        associateId: input.associateId,
        skillId: input.skillId,
      },
    },
    create: {
      associateId: input.associateId,
      skillId: input.skillId,
      level: input.level,
      yearsExperience: input.yearsExperience ?? null,
      notes: input.notes ?? null,
    },
    update: {
      level: input.level,
      yearsExperience: input.yearsExperience ?? null,
      notes: input.notes ?? null,
      // Reset verification — a level change needs re-verification.
      verifiedById: null,
      verifiedAt: null,
      selfClaimedAt: null,
    },
  });
  res.status(201).json({ id: row.id });
});

skills111Router.post(
  '/associate-skills/:id/verify',
  MANAGE,
  async (req, res) => {
    // Only a skill on someone in the caller's tenant and reach.
    const row = await prisma.associateSkill.findFirst({
      where: { id: String(req.params.id), associate: { is: scopeActiveAssociates(req.user!, { former: true }) } },
      select: { id: true, associateId: true, selfClaimedAt: true },
    });
    if (!row) throw new HttpError(404, 'not_found', 'Skill not found.');
    await prisma.associateSkill.update({
      where: { id: row.id },
      data: {
        verifiedById: req.user!.id,
        verifiedAt: new Date(),
      },
    });
    if (row.selfClaimedAt) {
      enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'skills.self_claim_verified', entityType: 'AssociateSkill', entityId: row.id, metadata: { associateId: row.associateId } }, 'skills');
    }
    res.json({ ok: true });
  },
);

/** Self-claims waiting on a verifier, for the people in the caller's reach (oldest first). */
skills111Router.get('/associate-skills/pending', MANAGE, async (req, res) => {
  const rows = await prisma.associateSkill.findMany({
    where: { tenantId: tenantIdForWrite(), selfClaimedAt: { not: null }, verifiedAt: null, associate: { is: scopeActiveAssociates(req.user!) } },
    include: { skill: { select: { name: true, category: true } }, associate: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { selfClaimedAt: 'asc' },
    take: 200,
  });
  res.json({
    claims: rows.map((r) => ({
      id: r.id,
      associateId: r.associate.id,
      name: `${r.associate.firstName} ${r.associate.lastName}`.trim(),
      skillName: r.skill.name,
      category: r.skill.category,
      level: r.level,
      yearsExperience: r.yearsExperience,
      notes: r.notes,
      claimedAt: r.selfClaimedAt!.toISOString(),
    })),
  });
});

/* ----- My skills (self-claims) ------------------------------------------- */

const SelfClaimSchema = z.object({
  skillId: z.string().uuid(),
  level: z.enum(LEVELS),
  yearsExperience: z.number().int().min(0).max(60).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

function ownAssociateId(req: { user?: { associateId: string | null } }): string {
  const id = req.user?.associateId;
  if (!id) throw new HttpError(403, 'no_associate', 'Skills belong to a person record, and this account isn’t linked to one.');
  return id;
}

/** My skills, and the catalog I can pick from. */
skills111Router.get('/me/skills', requireAuth, async (req, res) => {
  const associateId = ownAssociateId(req);
  const [mine, catalog] = await Promise.all([
    prisma.associateSkill.findMany({
      where: { associateId },
      include: { skill: { select: { name: true, category: true } } },
      orderBy: { skill: { name: 'asc' } },
      take: 200,
    }),
    prisma.skill.findMany({ where: { tenantId: tenantIdForWrite() }, select: { id: true, name: true, category: true }, orderBy: { name: 'asc' }, take: 500 }),
  ]);
  res.json({
    skills: mine.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillName: r.skill.name,
      category: r.skill.category,
      level: r.level,
      yearsExperience: r.yearsExperience,
      verified: r.verifiedAt !== null,
      selfClaimed: r.selfClaimedAt !== null,
    })),
    catalog,
  });
});

/** Add (or change) a skill on my own record: pending until someone verifies it. */
skills111Router.post('/me/skills', requireAuth, async (req, res) => {
  const associateId = ownAssociateId(req);
  const input = SelfClaimSchema.parse(req.body);
  const skill = await prisma.skill.findFirst({ where: { id: input.skillId, tenantId: tenantIdForWrite() }, select: { id: true, name: true } });
  if (!skill) throw new HttpError(404, 'skill_not_found', 'That skill isn’t in the list.');
  const existing = await prisma.associateSkill.findUnique({ where: { associateId_skillId: { associateId, skillId: skill.id } } });
  // A verified skill at the same level stays verified; any change goes back for verification.
  if (existing?.verifiedAt && existing.level === input.level && (input.yearsExperience ?? null) === existing.yearsExperience) {
    res.json({ id: existing.id, pending: false });
    return;
  }
  const now = new Date();
  const row = await prisma.associateSkill.upsert({
    where: { associateId_skillId: { associateId, skillId: skill.id } },
    create: { associateId, skillId: skill.id, level: input.level, yearsExperience: input.yearsExperience ?? null, notes: input.notes ?? null, selfClaimedAt: now },
    update: { level: input.level, yearsExperience: input.yearsExperience ?? null, notes: input.notes ?? null, verifiedById: null, verifiedAt: null, selfClaimedAt: now },
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'skills.self_claimed', entityType: 'AssociateSkill', entityId: row.id, metadata: { associateId, skill: skill.name, level: input.level } }, 'skills');
  res.status(existing ? 200 : 201).json({ id: row.id, pending: true });
});

/** Take back a claim of mine that nobody has verified yet. */
skills111Router.delete('/me/skills/:id', requireAuth, async (req, res) => {
  const associateId = ownAssociateId(req);
  const row = await prisma.associateSkill.findFirst({ where: { id: String(req.params.id), associateId }, select: { id: true, verifiedAt: true } });
  if (!row) throw new HttpError(404, 'not_found', 'Skill not found.');
  if (row.verifiedAt) throw new HttpError(409, 'verified', 'A verified skill is on your record; ask HR to change it.');
  await prisma.associateSkill.delete({ where: { id: row.id } });
  res.status(204).end();
});

skills111Router.delete('/associate-skills/:id', MANAGE, async (req, res) => {
  // Only a skill on someone in the caller's tenant and reach.
  const row = await prisma.associateSkill.findFirst({
    where: { id: String(req.params.id), associate: { is: scopeActiveAssociates(req.user!, { former: true }) } },
    select: { id: true },
  });
  if (!row) throw new HttpError(404, 'not_found', 'Skill not found.');
  await prisma.associateSkill.delete({ where: { id: row.id } });
  res.status(204).end();
});

skills111Router.get('/associate-skills', VIEW, async (req, res) => {
  const associateId = z
    .string()
    .uuid()
    .optional()
    .parse(req.query.associateId);
  if (!associateId) {
    throw new HttpError(400, 'associate_required', 'associateId is required.');
  }
  const rows = await prisma.associateSkill.findMany({
    take: 500,
    // Someone in the caller's tenant and reach (former people's skills still read on their record).
    where: { associateId, associate: { is: scopeActiveAssociates(req.user!, { former: true }) } },
    include: {
      skill: { select: { id: true, name: true, category: true } },
      verifiedBy: { select: { email: true } },
    },
    orderBy: [{ level: 'desc' }, { skill: { name: 'asc' } }],
  });
  res.json({
    skills: rows.map((r) => ({
      id: r.id,
      skillId: r.skillId,
      skillName: r.skill.name,
      category: r.skill.category,
      level: r.level,
      yearsExperience: r.yearsExperience,
      notes: r.notes,
      verifiedAt: r.verifiedAt?.toISOString() ?? null,
      verifiedByEmail: r.verifiedBy?.email ?? null,
      /** The person added it themselves; pending until verified. */
      selfClaimedAt: r.selfClaimedAt?.toISOString() ?? null,
    })),
  });
});

// ----- Search -----------------------------------------------------------

skills111Router.get('/skills/search', VIEW, async (req, res) => {
  const q = z.string().min(1).parse(req.query.q ?? '');
  const minLevel = z.enum(LEVELS).optional().parse(req.query.minLevel);
  // Staffing filters: only people placed at this client or store now.
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const locationId = z.string().uuid().optional().parse(req.query.locationId);
  const placedAt: Prisma.AssociateWhereInput =
    locationId || clientId
      ? { assignments: { some: { endedAt: null, ...(locationId ? { locationId } : { location: { is: { clientId } } }) } } }
      : {};
  const minRank = minLevel ? LEVEL_RANK[minLevel] : 1;
  const matches = await prisma.skill.findMany({
    where: { tenantId: tenantIdForWrite(), name: { contains: q, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 5,
  });
  if (matches.length === 0) {
    res.json({ skills: [], associates: [] });
    return;
  }
  const skillIds = matches.map((s) => s.id);
  // The level and the person filter run in the query, before the cap — filtering
  // after it used to return fewer people than there were. Active people in reach only.
  const filtered = await prisma.associateSkill.findMany({
    where: {
      skillId: { in: skillIds },
      level: { in: LEVELS.filter((l) => LEVEL_RANK[l] >= minRank) },
      associate: { is: { AND: [scopeActiveAssociates(req.user!), placedAt] } },
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      skill: { select: { name: true } },
    },
    orderBy: { level: 'desc' },
    take: 200,
  });
  // What a staffer needs beside the level: where they work now, the next
  // day they're free, and the certifications they hold.
  const ids = [...new Set(filtered.map((c) => c.associate.id))];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizon = new Date(today.getTime() + 14 * 86_400_000);
  const [placements, shifts, leave, quals] = ids.length
    ? await Promise.all([
        prisma.associateAssignment.findMany({
          where: { associateId: { in: ids }, endedAt: null },
          orderBy: { startedAt: 'desc' },
          select: { associateId: true, location: { select: { id: true, name: true, client: { select: { name: true } } } } },
        }),
        prisma.shift.findMany({
          where: { assignedAssociateId: { in: ids }, status: { not: 'CANCELLED' }, startsAt: { gte: today, lt: horizon } },
          select: { assignedAssociateId: true, startsAt: true },
        }),
        prisma.timeOffRequest.findMany({
          where: { associateId: { in: ids }, status: 'APPROVED', endDate: { gte: today }, startDate: { lt: horizon } },
          select: { associateId: true, startDate: true, endDate: true },
        }),
        prisma.associateQualification.findMany({
          where: { associateId: { in: ids }, deletedAt: null, qualification: { deletedAt: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: today } }] },
          select: { associateId: true, expiresAt: true, qualification: { select: { name: true, isCert: true } } },
        }),
      ])
    : [[], [], [], []];
  const placeOf = new Map<string, { locationId: string; siteName: string; clientName: string | null }>();
  for (const p of placements) {
    if (!placeOf.has(p.associateId)) placeOf.set(p.associateId, { locationId: p.location.id, siteName: p.location.name, clientName: p.location.client?.name ?? null });
  }
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const nextFree = (id: string): string | null => {
    const busy = new Set(shifts.filter((x) => x.assignedAssociateId === id).map((x) => ymd(x.startsAt)));
    const away = leave.filter((l) => l.associateId === id);
    for (let i = 0; i < 14; i++) {
      const day = new Date(today.getTime() + i * 86_400_000);
      const key = ymd(day);
      if (busy.has(key)) continue;
      if (away.some((l) => ymd(l.startDate) <= key && key <= ymd(l.endDate))) continue;
      return key;
    }
    return null;
  };
  res.json({
    skills: matches,
    associates: filtered.map((c) => ({
      place: placeOf.get(c.associate.id) ?? null,
      nextFreeDay: nextFree(c.associate.id),
      certifications: quals
        .filter((qq) => qq.associateId === c.associate.id)
        .map((qq) => ({ name: qq.qualification.name, isCert: qq.qualification.isCert, expiresAt: qq.expiresAt ? ymd(qq.expiresAt) : null })),
      associateId: c.associate.id,
      name: `${c.associate.firstName} ${c.associate.lastName}`,
      email: c.associate.email,
      skillName: c.skill.name,
      level: c.level,
      yearsExperience: c.yearsExperience,
      verified: c.verifiedAt !== null,
    })),
  });
});
