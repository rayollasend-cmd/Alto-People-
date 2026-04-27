import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';

/**
 * Phase 121 — Vaccination + medical records.
 *
 * Reuses compliance caps because client SLAs (especially healthcare)
 * routinely require proof of vaccination and TB test results.
 */

export const vaccination121Router = Router();

const VIEW = requireCapability('view:compliance');
const MANAGE = requireCapability('manage:compliance');

const KIND = z.enum([
  'COVID19',
  'INFLUENZA_FLU',
  'HEPATITIS_B',
  'TDAP',
  'MMR',
  'TB_TEST',
  'OTHER',
]);

// ----- List ----------------------------------------------------------------

vaccination121Router.get('/vaccinations', VIEW, async (req, res) => {
  const associateId = z.string().uuid().optional().parse(req.query.associateId);
  const kind = KIND.optional().parse(req.query.kind);

  const rows = await prisma.vaccinationRecord.findMany({
    where: {
      ...(associateId ? { associateId } : {}),
      ...(kind ? { kind } : {}),
    },
    include: {
      associate: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: [{ administeredOn: 'desc' }],
  });
  res.json({
    records: rows.map((r) => ({
      id: r.id,
      associateId: r.associateId,
      associateName: `${r.associate.firstName} ${r.associate.lastName}`,
      associateEmail: r.associate.email,
      kind: r.kind,
      customLabel: r.customLabel,
      doseNumber: r.doseNumber,
      totalDoses: r.totalDoses,
      administeredOn: r.administeredOn.toISOString().slice(0, 10),
      administeredBy: r.administeredBy,
      manufacturer: r.manufacturer,
      lotNumber: r.lotNumber,
      documentUrl: r.documentUrl,
      expiresOn: r.expiresOn?.toISOString().slice(0, 10) ?? null,
      notes: r.notes,
    })),
  });
});

// ----- Expiring soon -------------------------------------------------------

vaccination121Router.get(
  '/vaccinations/expiring-soon',
  VIEW,
  async (req, res) => {
    const days = z.coerce.number().int().min(1).max(365).default(60).parse(
      req.query.days,
    );
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setUTCDate(cutoff.getUTCDate() + days);

    const rows = await prisma.vaccinationRecord.findMany({
      where: {
        expiresOn: { not: null, lte: cutoff },
      },
      include: {
        associate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { expiresOn: 'asc' },
    });
    res.json({
      days,
      records: rows.map((r) => {
        const daysUntil = r.expiresOn
          ? Math.round(
              (r.expiresOn.getTime() - today.getTime()) /
                (1000 * 60 * 60 * 24),
            )
          : 0;
        return {
          id: r.id,
          associateId: r.associateId,
          associateName: `${r.associate.firstName} ${r.associate.lastName}`,
          kind: r.kind,
          customLabel: r.customLabel,
          expiresOn: r.expiresOn?.toISOString().slice(0, 10) ?? null,
          daysUntil,
          overdue: daysUntil < 0,
        };
      }),
    });
  },
);

// ----- Coverage rollup -----------------------------------------------------

vaccination121Router.get('/vaccinations/coverage', VIEW, async (_req, res) => {
  const total = await prisma.associate.count({ where: { deletedAt: null } });
  const byKind = await prisma.vaccinationRecord.groupBy({
    by: ['kind', 'associateId'],
  });
  const setByKind: Record<string, Set<string>> = {
    COVID19: new Set(),
    INFLUENZA_FLU: new Set(),
    HEPATITIS_B: new Set(),
    TDAP: new Set(),
    MMR: new Set(),
    TB_TEST: new Set(),
    OTHER: new Set(),
  };
  for (const r of byKind) {
    setByKind[r.kind].add(r.associateId);
  }
  const coverage: Record<string, { count: number; pct: number }> = {};
  for (const k of Object.keys(setByKind)) {
    const count = setByKind[k].size;
    coverage[k] = {
      count,
      pct: total === 0 ? 0 : Math.round((count / total) * 1000) / 10,
    };
  }
  res.json({ totalAssociates: total, coverage });
});

// ----- Create --------------------------------------------------------------

const CreateInputSchema = z.object({
  associateId: z.string().uuid(),
  kind: KIND,
  customLabel: z.string().max(120).optional().nullable(),
  doseNumber: z.number().int().min(1).max(20).default(1),
  totalDoses: z.number().int().min(1).max(20).optional().nullable(),
  administeredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  administeredBy: z.string().max(200).optional().nullable(),
  manufacturer: z.string().max(120).optional().nullable(),
  lotNumber: z.string().max(60).optional().nullable(),
  documentUrl: z.string().url().max(500).optional().nullable(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

vaccination121Router.post('/vaccinations', MANAGE, async (req, res) => {
  const input = CreateInputSchema.parse(req.body);
  if (input.kind === 'OTHER' && !input.customLabel) {
    throw new HttpError(
      400,
      'custom_label_required',
      'OTHER kind requires customLabel.',
    );
  }
  const associate = await prisma.associate.findUnique({
    where: { id: input.associateId },
  });
  if (!associate || associate.deletedAt) {
    throw new HttpError(404, 'associate_not_found', 'Associate not found.');
  }
  const created = await prisma.vaccinationRecord.create({
    data: {
      associateId: input.associateId,
      kind: input.kind,
      customLabel: input.customLabel ?? null,
      doseNumber: input.doseNumber,
      totalDoses: input.totalDoses ?? null,
      administeredOn: new Date(input.administeredOn),
      administeredBy: input.administeredBy ?? null,
      manufacturer: input.manufacturer ?? null,
      lotNumber: input.lotNumber ?? null,
      documentUrl: input.documentUrl ?? null,
      expiresOn: input.expiresOn ? new Date(input.expiresOn) : null,
      notes: input.notes ?? null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({ id: created.id });
});

// ----- Delete --------------------------------------------------------------

vaccination121Router.delete('/vaccinations/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const existing = await prisma.vaccinationRecord.findUnique({ where: { id } });
  if (!existing) {
    throw new HttpError(404, 'not_found', 'Record not found.');
  }
  await prisma.vaccinationRecord.delete({ where: { id } });
  res.status(204).end();
});
