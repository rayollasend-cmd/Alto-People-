import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { COMPLIANCE_CONTROL_IDS, EVIDENCE_STATUSES, EvidenceSignoffInputSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { enqueueAudit } from '../lib/audit.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';
import { complianceEvidence, controlHistory, recordEvidence, signOffEvidence } from '../lib/evidence.js';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Brief 2-5 step 1 — the Compliance evidence page.
 *
 *   GET  /admin/compliance-evidence                 every control, its latest evidence and its state
 *   GET  /admin/compliance-evidence/:control         one control's history, newest first
 *   POST /admin/compliance-evidence/:id/signoff      a named person signs one evidence row off
 *
 *   Read on view:org, sign-off on manage:org (the executive stays
 *   read-only). The evidence is Alto People's own, as the service
 *   organization, so only the operator's tenant sees it: any other
 *   tenant's admin gets 404 (until 2-3 brings a platform-operator role).
 */

export const complianceEvidenceRouter = Router();

const VIEW = requireCapability('view:org');
const MANAGE = requireCapability('manage:org');

function operatorOnly(_req: Request, _res: Response, next: NextFunction): void {
  if (tenantIdForWrite() !== ALTO_TENANT_ID) {
    next(new HttpError(404, 'not_found', 'Route not found'));
    return;
  }
  next();
}

complianceEvidenceRouter.get('/admin/compliance-evidence', VIEW, operatorOnly, async (_req, res) => {
  res.json(await complianceEvidence(prisma));
});

complianceEvidenceRouter.get('/admin/compliance-evidence/:control', VIEW, operatorOnly, async (req, res) => {
  const control = z.enum(COMPLIANCE_CONTROL_IDS as [string, ...string[]]).safeParse(req.params.control);
  if (!control.success) throw new HttpError(404, 'control_not_found', 'That control is not in the catalog.');
  res.json({ control: control.data, evidence: await controlHistory(control.data, prisma) });
});

complianceEvidenceRouter.post('/admin/compliance-evidence/:id/signoff', MANAGE, operatorOnly, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const input = EvidenceSignoffInputSchema.parse(req.body ?? {});
  const signed = await signOffEvidence(id, req.user!.id, input.note?.length ? input.note : null, prisma);
  if (!signed) throw new HttpError(404, 'evidence_not_found', 'That evidence row does not exist.');
  enqueueAudit(
    { actorUserId: req.user!.id, clientId: null, action: 'compliance.evidence_signed_off', entityType: 'ComplianceEvidence', entityId: id, metadata: { signoffId: signed.id } },
    'compliance',
  );
  res.status(201).json({ id: signed.id });
});

/*
 * Brief 2-5 step 6 — the access review behind the access-review control.
 *
 *   GET  /admin/access-review        the review now: elevated accounts and flags, and every agent with its flags
 *   POST /admin/access-review/run    record it as evidence (it waits for a named approver's sign-off above)
 *
 * The review names accounts and agents for the reviewer; the evidence it records keeps counts and ids only.
 */
complianceEvidenceRouter.get('/admin/access-review', MANAGE, operatorOnly, async (_req, res) => {
  const { AGENT_FLAG_LABEL, buildAccessReview } = await import('../lib/accessReview.js');
  res.json({ ...(await buildAccessReview(prisma)), agentFlagLabels: AGENT_FLAG_LABEL });
});

complianceEvidenceRouter.post('/admin/access-review/run', MANAGE, operatorOnly, async (req, res) => {
  const { recordAccessReview } = await import('../lib/accessReview.js');
  const id = await recordAccessReview(prisma, req.user!.id);
  if (!id) throw new HttpError(500, 'evidence_not_recorded', 'The review could not be recorded.');
  res.status(201).json({ id });
});

/*
 * Brief 2-5 step 7 — the security contact, and evidence posted from CI.
 *
 *   PUT  /admin/security-contact            who hears the security alerts by email (the operator's admins)
 *   POST /admin/compliance-evidence/ingest  CI posts a control's result with EVIDENCE_INGEST_TOKEN (no session)
 */
complianceEvidenceRouter.get('/admin/security-contact', VIEW, operatorOnly, async (_req, res) => {
  const s = await prisma.orgSetting.findUnique({ where: { tenantId: tenantIdForWrite() }, select: { securityContactEmail: true } });
  res.json({ email: s?.securityContactEmail ?? null });
});

complianceEvidenceRouter.put('/admin/security-contact', MANAGE, operatorOnly, async (req, res) => {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(254).nullable() }).strict().parse(req.body);
  await prisma.orgSetting.upsert({ where: { tenantId: tenantIdForWrite() }, create: { tenantId: tenantIdForWrite(), securityContactEmail: email }, update: { securityContactEmail: email } });
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action: 'security.contact_set', entityType: 'OrgSetting', entityId: 'singleton', metadata: { set: !!email } }, 'compliance');
  res.json({ email });
});

const INGESTIBLE = ['dependency-scanning', 'database-backup', 'restore-test'] as const;

complianceEvidenceRouter.post('/admin/compliance-evidence/ingest', async (req, res) => {
  const token = env.EVIDENCE_INGEST_TOKEN;
  if (!token) throw new HttpError(503, 'ingest_not_configured', 'Evidence ingest is not configured.');
  const m = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  const a = Buffer.from(m?.[1] ?? '');
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, 'unauthenticated', 'A valid ingest token is required.');
  const input = z
    .object({ control: z.enum(INGESTIBLE), status: z.enum(EVIDENCE_STATUSES), summary: z.string().trim().min(3).max(500), details: z.record(z.string(), z.unknown()).default({}) })
    .strict()
    .parse(req.body);
  const id = await recordEvidence(input.control, 'ci', { status: input.status, summary: input.summary, details: input.details }, prisma);
  if (!id) throw new HttpError(500, 'evidence_not_recorded', 'The evidence could not be recorded.');
  res.status(201).json({ id });
});
