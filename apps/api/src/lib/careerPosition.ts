import type { Prisma, PrismaClient, SkillLevel } from '@prisma/client';
import { prisma as defaultPrisma } from '../db.js';
import { tenantIdForWrite } from './tenant.js';

/**
 * Where a person stands on a career ladder, and what the next rung asks of
 * them — measured, not described: each requirement says what they have
 * and what it needs.
 *
 * Placement, in order: the rung whose job profile is theirs; on the field
 * leadership ladder (the staffing template), their role (a shift or floor
 * lead is on the lead rungs; anyone else on the field is crew); else not
 * on a ladder yet.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The staffing template's family — how its role-based placement is recognised. */
export const FIELD_LADDER_FAMILY = 'Field leadership';

export const FIELD_LADDER_TEMPLATE: Array<{
  rank: number;
  title: string;
  description: string;
  minTenureMonths: number | null;
  minReviewRating: number | null;
  requiredQualificationCodes: string[];
}> = [
  { rank: 1, title: 'Crew member', description: 'Works the shift: on time, to standard, safely.', minTenureMonths: null, minReviewRating: null, requiredQualificationCodes: [] },
  { rank: 2, title: 'Lead', description: 'Runs a section of the floor and trains new crew.', minTenureMonths: 3, minReviewRating: 3, requiredQualificationCodes: [] },
  { rank: 3, title: 'Shift supervisor', description: 'Runs the shift: the crew, the plan, the handover.', minTenureMonths: 9, minReviewRating: 4, requiredQualificationCodes: [] },
  { rank: 4, title: 'Store manager', description: 'Owns the store: every shift, the numbers, the client.', minTenureMonths: 18, minReviewRating: 4, requiredQualificationCodes: [] },
];

const SKILL_ORDER: Record<SkillLevel, number> = { BEGINNER: 1, INTERMEDIATE: 2, ADVANCED: 3, EXPERT: 4 };

/**
 * One thing the next rung asks for. Values are raw (a skill level code,
 * months, a 1–5 rating) so the page words them in the reader's language.
 */
export interface Requirement {
  kind: 'skill' | 'certification' | 'tenure' | 'review';
  /** The skill's name or the certification's code; empty for tenure and review. */
  label: string;
  met: boolean;
  have: SkillLevel | number | null;
  need: SkillLevel | number | null;
}

export interface CareerPosition {
  ladder: { id: string; name: string; family: string | null; levels: Array<{ id: string; rank: number; title: string; description: string | null }> } | null;
  currentLevelId: string | null;
  placedBy: 'job_profile' | 'role' | 'field' | null;
  next: { id: string; rank: number; title: string; requirements: Requirement[]; progressPct: number } | null;
  /** Other ladders they could look at. */
  otherLadders: Array<{ id: string; name: string }>;
}

const monthsBetween = (from: Date, to: Date) =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) - (to.getDate() < from.getDate() ? 1 : 0);

export async function careerPositionFor(associateId: string, now = new Date(), db: Db = defaultPrisma): Promise<CareerPosition> {
  const tenantId = tenantIdForWrite();
  const [person, account, ladders] = await Promise.all([
    db.associate.findFirst({
      where: { id: associateId, tenantId, deletedAt: null },
      select: { id: true, jobProfileId: true, hireDate: true, createdAt: true },
    }),
    db.user.findFirst({ where: { associateId, deletedAt: null }, select: { role: true, additionalRoles: true } }),
    db.careerLadder.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ family: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        family: true,
        levels: {
          orderBy: { rank: 'asc' },
          select: {
            id: true,
            rank: true,
            title: true,
            description: true,
            jobProfileId: true,
            requiredQualificationCodes: true,
            minTenureMonths: true,
            minReviewRating: true,
            skills: { select: { skillId: true, minLevel: true, skill: { select: { name: true } } } },
          },
        },
      },
    }),
  ]);
  if (!person) return { ladder: null, currentLevelId: null, placedBy: null, next: null, otherLadders: ladders.map((l) => ({ id: l.id, name: l.name })) };

  // Placement.
  let ladder = person.jobProfileId ? ladders.find((l) => l.levels.some((lv) => lv.jobProfileId === person.jobProfileId)) : undefined;
  let current = ladder?.levels.find((lv) => lv.jobProfileId === person.jobProfileId);
  let placedBy: CareerPosition['placedBy'] = current ? 'job_profile' : null;
  if (!current) {
    const field = ladders.find((l) => l.family === FIELD_LADDER_FAMILY);
    if (field && field.levels.length) {
      const roles = account ? [account.role, ...account.additionalRoles] : [];
      const byTitle = (t: string) => field.levels.find((lv) => lv.title.toLowerCase() === t.toLowerCase());
      if (roles.includes('SHIFT_SUPERVISOR')) {
        current = byTitle('Shift supervisor');
        placedBy = current ? 'role' : null;
      } else if (roles.includes('FLOOR_SUPERVISOR')) {
        current = byTitle('Lead');
        placedBy = current ? 'role' : null;
      }
      if (!current) {
        current = field.levels[0];
        placedBy = 'field';
      }
      ladder = field;
    }
  }
  const otherLadders = ladders.filter((l) => l.id !== ladder?.id).map((l) => ({ id: l.id, name: l.name }));
  if (!ladder || !current) return { ladder: null, currentLevelId: null, placedBy: null, next: null, otherLadders };

  const nextLevel = ladder.levels.find((lv) => lv.rank > current!.rank) ?? null;
  let next: CareerPosition['next'] = null;
  if (nextLevel) {
    const [skills, quals, review] = await Promise.all([
      db.associateSkill.findMany({ where: { associateId }, select: { skillId: true, level: true } }),
      nextLevel.requiredQualificationCodes.length
        ? db.associateQualification.findMany({
            where: {
              associateId,
              deletedAt: null,
              qualification: { code: { in: nextLevel.requiredQualificationCodes }, deletedAt: null },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { qualification: { select: { code: true } } },
          })
        : Promise.resolve([]),
      nextLevel.minReviewRating
        ? db.performanceReview.findFirst({
            where: { associateId, status: { in: ['SUBMITTED', 'ACKNOWLEDGED'] } },
            orderBy: { periodEnd: 'desc' },
            select: { overallRating: true },
          })
        : Promise.resolve(null),
    ]);
    const mine = new Map(skills.map((s) => [s.skillId, s.level]));
    const requirements: Requirement[] = [];
    for (const req of nextLevel.skills) {
      const have = mine.get(req.skillId);
      requirements.push({
        kind: 'skill',
        label: req.skill.name,
        met: !!have && SKILL_ORDER[have] >= SKILL_ORDER[req.minLevel],
        have: have ?? null,
        need: req.minLevel,
      });
    }
    const held = new Set(quals.map((q) => q.qualification.code));
    for (const code of nextLevel.requiredQualificationCodes) {
      requirements.push({ kind: 'certification', label: code, met: held.has(code), have: null, need: null });
    }
    if (nextLevel.minTenureMonths) {
      const months = Math.max(0, monthsBetween(person.hireDate ?? person.createdAt, now));
      requirements.push({ kind: 'tenure', label: '', met: months >= nextLevel.minTenureMonths, have: months, need: nextLevel.minTenureMonths });
    }
    if (nextLevel.minReviewRating) {
      const rating = review?.overallRating ?? null;
      requirements.push({
        kind: 'review',
        label: '',
        met: rating !== null && rating >= nextLevel.minReviewRating,
        have: rating,
        need: nextLevel.minReviewRating,
      });
    }
    const met = requirements.filter((r) => r.met).length;
    next = {
      id: nextLevel.id,
      rank: nextLevel.rank,
      title: nextLevel.title,
      requirements,
      progressPct: requirements.length ? Math.round((met / requirements.length) * 100) : 100,
    };
  }
  return {
    ladder: {
      id: ladder.id,
      name: ladder.name,
      family: ladder.family,
      levels: ladder.levels.map((lv) => ({ id: lv.id, rank: lv.rank, title: lv.title, description: lv.description })),
    },
    currentLevelId: current.id,
    placedBy,
    next,
    otherLadders,
  };
}
