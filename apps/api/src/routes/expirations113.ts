import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';

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

expirations113Router.get('/expirations', VIEW, async (req, res) => {
  const { days, isCert } = QuerySchema.parse(req.query);
  const now = new Date();
  const dueSoonEnd = new Date(now.getTime() + days * 86_400_000);
  const dueLaterEnd = new Date(now.getTime() + 365 * 86_400_000);

  const rows = await prisma.associateQualification.findMany({
    where: {
      deletedAt: null,
      expiresAt: { not: null, lte: dueLaterEnd },
      qualification: {
        deletedAt: null,
        ...(typeof isCert === 'boolean' ? { isCert } : {}),
      },
      associate: { deletedAt: null },
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      qualification: {
        select: { id: true, code: true, name: true, isCert: true },
      },
    },
    orderBy: { expiresAt: 'asc' },
    take: 1000,
  });

  const items = rows.map((r) => ({
    id: r.id,
    associateId: r.associate.id,
    associateName: `${r.associate.firstName} ${r.associate.lastName}`,
    associateEmail: r.associate.email,
    qualificationId: r.qualification.id,
    qualificationCode: r.qualification.code,
    qualificationName: r.qualification.name,
    isCert: r.qualification.isCert,
    expiresAt: r.expiresAt!.toISOString().slice(0, 10),
    daysUntilExpiry: Math.round(
      (r.expiresAt!.getTime() - now.getTime()) / 86_400_000,
    ),
  }));

  // Bucketize for the UI's three-column layout.
  const expired = items.filter((i) => i.daysUntilExpiry < 0);
  const dueSoon = items.filter(
    (i) => i.daysUntilExpiry >= 0 && new Date(i.expiresAt) < dueSoonEnd,
  );
  const dueLater = items.filter(
    (i) => i.daysUntilExpiry >= 0 && new Date(i.expiresAt) >= dueSoonEnd,
  );

  res.json({
    days,
    counts: {
      expired: expired.length,
      dueSoon: dueSoon.length,
      dueLater: dueLater.length,
    },
    expired,
    dueSoon,
    dueLater,
  });
});
