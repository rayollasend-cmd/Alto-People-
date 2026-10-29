import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { latestCoverage } from '../lib/credentialCoverage.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { dateColumnKey } from '../lib/timezone.js';

/**
 * What a site or client requires its people to hold (agent families step 5;
 * the Compliance agent's coverage.credentials measures it weekly).
 *
 *   GET    /credential-requirements      each requirement with its latest week (view:compliance)
 *   POST   /credential-requirements      a site or client, and exactly one target (manage:compliance)
 *   DELETE /credential-requirements/:id  soft delete; past weeks keep their meaning (manage:compliance)
 *
 * Nothing is required until someone sets it here. Every change is audited.
 */

export const credentialRequirementsRouter = Router();

const MANAGE = requireCapability('manage:compliance');

const InputSchema = z
  .object({
    locationId: z.string().uuid().nullable().optional(),
    clientId: z.string().uuid().nullable().optional(),
    kind: z.enum(['VACCINATION', 'TRAINING', 'QUALIFICATION']),
    vaccinationKind: z.enum(['COVID19', 'INFLUENZA_FLU', 'HEPATITIS_B', 'TDAP', 'MMR', 'TB_TEST', 'OTHER']).nullable().optional(),
    complianceTag: z.enum(['EEO_HARASSMENT', 'OSHA_SAFETY', 'WALMART_CADE', 'FOOD_HANDLER']).nullable().optional(),
    qualificationId: z.string().uuid().nullable().optional(),
    label: z.string().trim().min(2).max(120),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.locationId && !v.clientId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['locationId'], message: 'Name a site or a client.' });
    const target = { VACCINATION: v.vaccinationKind, TRAINING: v.complianceTag, QUALIFICATION: v.qualificationId }[v.kind];
    if (!target) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Name what is required for this kind.' });
  });

credentialRequirementsRouter.get('/', async (_req, res) => {
  const rows = await latestCoverage(prisma, tenantIdForWrite());
  res.json({
    requirements: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      locationId: r.locationId,
      clientId: r.clientId,
      place: r.place,
      vaccinationKind: r.vaccinationKind,
      complianceTag: r.complianceTag,
      qualificationId: r.qualificationId,
      latest: r.latest ? { weekOf: dateColumnKey(r.latest.weekOf), population: r.latest.population, missing: r.latest.missing } : null,
    })),
  });
});

credentialRequirementsRouter.post('/', MANAGE, async (req, res) => {
  const input = InputSchema.parse(req.body);
  const tenantId = tenantIdForWrite();
  // The scope and the qualification must be this tenant's.
  if (input.locationId && !(await prisma.site.findFirst({ where: { id: input.locationId, tenantId, deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(404, 'site_not_found', 'That site does not exist.');
  }
  if (input.clientId && !(await prisma.client.findFirst({ where: { id: input.clientId, tenantId }, select: { id: true } }))) {
    throw new HttpError(404, 'client_not_found', 'That client does not exist.');
  }
  if (input.kind === 'QUALIFICATION' && !(await prisma.qualification.findFirst({ where: { id: input.qualificationId!, tenantId, deletedAt: null }, select: { id: true } }))) {
    throw new HttpError(404, 'qualification_not_found', 'That qualification does not exist.');
  }
  const created = await prisma.credentialRequirement.create({
    data: {
      tenantId,
      locationId: input.locationId ?? null,
      clientId: input.locationId ? null : (input.clientId ?? null),
      kind: input.kind,
      vaccinationKind: input.kind === 'VACCINATION' ? input.vaccinationKind : null,
      complianceTag: input.kind === 'TRAINING' ? input.complianceTag : null,
      qualificationId: input.kind === 'QUALIFICATION' ? input.qualificationId : null,
      label: input.label,
      createdById: req.user!.id,
    },
    select: { id: true },
  });
  enqueueAudit({ actorUserId: req.user!.id, clientId: input.clientId ?? null, action: 'credential_requirement.created', entityType: 'CredentialRequirement', entityId: created.id, metadata: { kind: input.kind, label: input.label, locationId: input.locationId ?? null } }, 'credentialRequirements');
  res.status(201).json({ id: created.id });
});

credentialRequirementsRouter.delete('/:id', MANAGE, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const r = await prisma.credentialRequirement.updateMany({ where: { id, tenantId: tenantIdForWrite(), deletedAt: null }, data: { deletedAt: new Date() } });
  if (!r.count) throw new HttpError(404, 'requirement_not_found', 'No such requirement.');
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'credential_requirement.removed', entityType: 'CredentialRequirement', entityId: id, metadata: {} }, 'credentialRequirements');
  res.status(204).end();
});
