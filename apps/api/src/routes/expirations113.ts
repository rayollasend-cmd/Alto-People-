import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { requireCapability } from '../middleware/auth.js';
import { expiringQualificationsWhere } from '../lib/expirationScope.js';

/**
 * Phase 113 — Expiration dashboard.
 *
 * Aggregates AssociateQualification rows by expiresAt window:
 *   - expired: expiresAt < now
 *   - dueSoon: now <= expiresAt < now + days (default 60)
 *   - dueLater: expiresAt >= now + days, capped at 365 days out
 *
 * Each row links the holder so HR can drill in. Filterable by
 * isCert (cert vs license vs general qualification).
 */

export const expirations113Router = Router();

const VIEW = requireCapability('view:org');

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(60),
  isCert: z
    .preprocess((v) => (v === undefined ? undefined : v === 'true'), z.boolean().optional()),
});

/** Rows drawn per bucket; the counts are exact whatever the cap. */
const BUCKET = 500;

expirations113Router.get('/expirations', VIEW, async (req, res) => {
  const { days, isCert } = QuerySchema.parse(req.query);
  const now = new Date();
  const dueSoonEnd = new Date(now.getTime() + days * 86_400_000);
  const dueLaterEnd = new Date(now.getTime() + 365 * 86_400_000);
  const base = expiringQualificationsWhere(req.user!, { isCert });
  const within = (expiresAt: Prisma.DateTimeNullableFilter): Prisma.AssociateQualificationWhereInput => ({ AND: [base, { expiresAt }] });
  const include = {
    associate: { select: { id: true, firstName: true, lastName: true, email: true } },
    qualification: { select: { id: true, code: true, name: true, isCert: true } },
  } as const;

  // Each column is its own query, so a pile of old lapses can never crowd
  // "due soon" out of the page. Expired reads newest lapse first; the
  // coming ones soonest first.
  const [expiredRows, soonRows, laterRows, expiredCount, soonCount, laterCount] = await Promise.all([
    prisma.associateQualification.findMany({ where: within({ lt: now }), include, orderBy: { expiresAt: 'desc' }, take: BUCKET }),
    prisma.associateQualification.findMany({ where: within({ gte: now, lt: dueSoonEnd }), include, orderBy: { expiresAt: 'asc' }, take: BUCKET }),
    prisma.associateQualification.findMany({ where: within({ gte: dueSoonEnd, lte: dueLaterEnd }), include, orderBy: { expiresAt: 'asc' }, take: BUCKET }),
    prisma.associateQualification.count({ where: within({ lt: now }) }),
    prisma.associateQualification.count({ where: within({ gte: now, lt: dueSoonEnd }) }),
    prisma.associateQualification.count({ where: within({ gte: dueSoonEnd, lte: dueLaterEnd }) }),
  ]);

  const toItem = (r: (typeof expiredRows)[number]) => ({
    id: r.id,
    associateId: r.associate.id,
    associateName: `${r.associate.firstName} ${r.associate.lastName}`,
    associateEmail: r.associate.email,
    qualificationId: r.qualification.id,
    qualificationCode: r.qualification.code,
    qualificationName: r.qualification.name,
    isCert: r.qualification.isCert,
    expiresAt: r.expiresAt!.toISOString().slice(0, 10),
    daysUntilExpiry: Math.round((r.expiresAt!.getTime() - now.getTime()) / 86_400_000),
  });

  res.json({
    days,
    counts: { expired: expiredCount, dueSoon: soonCount, dueLater: laterCount },
    expired: expiredRows.map(toItem),
    dueSoon: soonRows.map(toItem),
    dueLater: laterRows.map(toItem),
    /** A column holding more than it draws says so. */
    truncated: { expired: expiredCount > BUCKET, dueSoon: soonCount > BUCKET, dueLater: laterCount > BUCKET },
  });
});
