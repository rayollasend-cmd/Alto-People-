import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { encryptString } from '../lib/crypto.js';
import { addDomain, ensureEnvIdentity, issueScimToken, revokeScimToken, txtRecordFor, unlinkIdentity, verifyDomain } from '../lib/identity.js';
import { tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-3 step 2 — a tenant's own sign-in, managed by its admins
 * (manage:org; the executive reads nothing here). Secrets are write-only:
 * a client secret is sealed on the way in and never returned; a SCIM token
 * is shown once.
 *
 *   GET    /identity                                 connections, domains (with the TXT record to add), SCIM tokens
 *   POST   /identity/connections                     a new OIDC connection
 *   PATCH  /identity/connections/:id                 change it (a new secret rotates it; enabled false turns it off)
 *   POST   /identity/domains                         claim a domain; returns the TXT record
 *   POST   /identity/domains/:id/verify              look the TXT record up now
 *   DELETE /identity/domains/:id                     release it
 *   POST   /identity/scim-tokens                     a new SCIM token, shown once
 *   POST   /identity/scim-tokens/:id/revoke          stop it at once
 *   DELETE /identity/links/:userId/:connectionId     unlink a person from an IdP (they relink on next sign-in)
 */

export const identityRouter = Router();

const MANAGE = requireCapability('manage:org');
const Id = z.string().uuid();

const ConnectionInput = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    buttonLabel: z.string().trim().min(2).max(80).nullable().optional(),
    issuerUrl: z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'The issuer must be https.'),
    clientId: z.string().trim().min(1).max(300),
    clientSecret: z.string().min(1).max(2000),
    jitPolicy: z.enum(['NONE', 'INVITED_ONLY']).default('INVITED_ONLY'),
    ssoRequiredForStaff: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();

const ConnectionUpdate = ConnectionInput.partial().strict();

identityRouter.get('/', MANAGE, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  await ensureEnvIdentity(prisma);
  const [connections, domains, tokens] = await Promise.all([
    prisma.identityConnection.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { identities: true } } } }),
    prisma.tenantDomain.findMany({ where: { tenantId }, orderBy: { domain: 'asc' } }),
    prisma.scimToken.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({
    connections: connections.map((c) => ({
      id: c.id,
      kind: c.kind,
      displayName: c.displayName,
      buttonLabel: c.buttonLabel,
      issuerUrl: c.issuerUrl,
      clientId: c.clientId,
      jitPolicy: c.jitPolicy,
      ssoRequiredForStaff: c.ssoRequiredForStaff,
      enabled: c.enabled,
      fromEnvironment: c.fromEnvironment,
      linkedPeople: c._count.identities,
      createdAt: c.createdAt.toISOString(),
    })),
    domains: domains.map((d) => ({ id: d.id, domain: d.domain, verified: !!d.verifiedAt, verifiedAt: d.verifiedAt?.toISOString() ?? null, txtRecord: txtRecordFor(d.verificationToken), lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null })),
    scimTokens: tokens.map((t) => ({ id: t.id, name: t.name, last4: t.last4, lastUsedAt: t.lastUsedAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null, createdAt: t.createdAt.toISOString() })),
  });
});

identityRouter.post('/connections', MANAGE, async (req, res) => {
  const input = ConnectionInput.parse(req.body);
  const tenantId = tenantIdForWrite();
  const row = await prisma.identityConnection.create({
    data: {
      tenantId,
      kind: 'OIDC',
      displayName: input.displayName,
      buttonLabel: input.buttonLabel ?? null,
      issuerUrl: input.issuerUrl,
      clientId: input.clientId,
      clientSecretEnc: encryptString(input.clientSecret),
      jitPolicy: input.jitPolicy,
      ssoRequiredForStaff: input.ssoRequiredForStaff,
      enabled: input.enabled,
      createdById: req.user!.id,
    },
  });
  await recordCriticalAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'identity.connection_created', entityType: 'IdentityConnection', entityId: row.id, metadata: { issuerUrl: row.issuerUrl, clientId: row.clientId, jitPolicy: row.jitPolicy, ssoRequiredForStaff: row.ssoRequiredForStaff } }, 'identity');
  res.status(201).json({ id: row.id });
});

identityRouter.patch('/connections/:id', MANAGE, async (req, res) => {
  const id = Id.parse(req.params.id);
  const input = ConnectionUpdate.parse(req.body);
  const tenantId = tenantIdForWrite();
  const before = await prisma.identityConnection.findFirst({ where: { id, tenantId } });
  if (!before) throw new HttpError(404, 'connection_not_found', 'Connection not found.');
  const { clientSecret, ...rest } = input;
  await prisma.identityConnection.update({ where: { id }, data: { ...rest, ...(clientSecret ? { clientSecretEnc: encryptString(clientSecret) } : {}) } });
  await recordCriticalAudit(
    {
      actorUserId: req.user!.id,
      clientId: null,
      tenantId,
      action: 'identity.connection_updated',
      entityType: 'IdentityConnection',
      entityId: id,
      // Field names and non-secret values only; a rotated secret is recorded as rotated, never its value.
      metadata: { fields: Object.keys(input), secretRotated: !!clientSecret, enabled: input.enabled ?? before.enabled, ssoRequiredForStaff: input.ssoRequiredForStaff ?? before.ssoRequiredForStaff },
    },
    'identity',
  );
  res.json({ ok: true });
});

identityRouter.post('/domains', MANAGE, async (req, res) => {
  const { domain } = z.object({ domain: z.string().min(3).max(253) }).strict().parse(req.body);
  const row = await addDomain(prisma, tenantIdForWrite(), domain, req.user!.id);
  res.status(201).json({ id: row.id, domain: row.domain, txtRecord: txtRecordFor(row.verificationToken) });
});

identityRouter.post('/domains/:id/verify', MANAGE, async (req, res) => {
  const row = await verifyDomain(prisma, tenantIdForWrite(), Id.parse(req.params.id), req.user!.id);
  res.json({ id: row.id, domain: row.domain, verified: !!row.verifiedAt, txtRecord: txtRecordFor(row.verificationToken) });
});

identityRouter.delete('/domains/:id', MANAGE, async (req, res) => {
  const id = Id.parse(req.params.id);
  const tenantId = tenantIdForWrite();
  const row = await prisma.tenantDomain.findFirst({ where: { id, tenantId } });
  if (!row) throw new HttpError(404, 'domain_not_found', 'Domain not found.');
  await prisma.tenantDomain.delete({ where: { id } });
  await recordCriticalAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'identity.domain_released', entityType: 'TenantDomain', entityId: id, metadata: { domain: row.domain } }, 'identity');
  res.status(204).end();
});

identityRouter.post('/scim-tokens', MANAGE, async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(120) }).strict().parse(req.body);
  res.status(201).json(await issueScimToken(prisma, tenantIdForWrite(), name, req.user!.id));
});

identityRouter.post('/scim-tokens/:id/revoke', MANAGE, async (req, res) => {
  await revokeScimToken(prisma, tenantIdForWrite(), Id.parse(req.params.id), req.user!.id);
  res.json({ ok: true });
});

identityRouter.delete('/links/:userId/:connectionId', MANAGE, async (req, res) => {
  await unlinkIdentity(prisma, tenantIdForWrite(), Id.parse(req.params.userId), Id.parse(req.params.connectionId), req.user!.id);
  res.status(204).end();
});
