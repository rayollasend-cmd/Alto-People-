import { Router } from 'express';
import { z } from 'zod';
import { patchSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { encryptString } from '../lib/crypto.js';
import { addDomain, ensureEnvIdentity, issueScimToken, revokeScimToken, txtRecordFor, unlinkIdentity, verifyDomain } from '../lib/identity.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { isValidCidr, loadSecurityPolicy, resetSecurityPolicyCache } from '../lib/securityPolicy.js';
import { X509Certificate } from 'node:crypto';
import { acsUrl, spEntityId } from '../lib/saml.js';

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

const ConnectionUpdate = patchSchema(ConnectionInput).strict();

/* ------------------------------------------- Access pack: security policy */

const CidrList = z.array(z.string().trim().min(1).max(60).refine(isValidCidr, 'Not a valid IPv4/IPv6 address or CIDR.')).max(64);
const SecurityPolicySchema = z.object({
  sessionIdleMinutes: z.number().int().min(5).max(24 * 60).nullable(),
  sessionAbsoluteHours: z.number().int().min(1).max(24 * 30).nullable(),
  allowedCidrsInternal: CidrList,
  allowedCidrsClient: CidrList,
  allowedCidrsAssociate: CidrList,
  deviceTrustEnabled: z.boolean(),
  deviceTrustDays: z.number().int().min(1).max(365),
  breakGlassEnabled: z.boolean(),
});

/** GET /identity/security-policy — where sessions may come from and how long they live. */
identityRouter.get('/security-policy', MANAGE, async (_req, res) => {
  res.json(await loadSecurityPolicy(tenantIdForWrite()));
});

/**
 * PUT /identity/security-policy — the whole policy at once. The caller's own
 * address must be inside the internal allowlist they are about to set, or
 * they would lock themselves (and everyone) out with the save.
 */
identityRouter.put('/security-policy', MANAGE, async (req, res) => {
  const tenantId = tenantIdForWrite();
  const input = SecurityPolicySchema.parse(req.body);
  if (input.allowedCidrsInternal.length > 0) {
    const { ipAllowed } = await import('../lib/securityPolicy.js');
    if (!ipAllowed(req.ip, input.allowedCidrsInternal)) {
      throw new HttpError(400, 'allowlist_excludes_you', `Your current address (${req.ip ?? 'unknown'}) is not in the internal allowlist; saving would sign you out. Add it first.`);
    }
  }
  const before = await loadSecurityPolicy(tenantId);
  await prisma.tenantSecurityPolicy.upsert({
    where: { tenantId },
    create: { tenantId, ...input, updatedById: req.user!.id },
    update: { ...input, updatedById: req.user!.id },
  });
  resetSecurityPolicyCache(tenantId);
  await recordCriticalAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId, action: 'identity.security_policy_updated', entityType: 'TenantSecurityPolicy', entityId: tenantId, metadata: JSON.parse(JSON.stringify({ before, after: input })) },
    'identity',
  );
  res.json(await loadSecurityPolicy(tenantId));
});

identityRouter.get('/', MANAGE, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  await ensureEnvIdentity(prisma);
  const [connections, domains, tokens, tenant] = await Promise.all([
    prisma.identityConnection.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { identities: true } } } }),
    prisma.tenantDomain.findMany({ where: { tenantId }, orderBy: { domain: 'asc' } }),
    prisma.scimToken.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
  ]);
  res.json({
    // The organization's own sign-in address (/login/<slug>), for people at a
    // shared email domain — the page shows it as a link, not "<your slug>".
    loginPath: tenant?.slug ? `/login/${tenant.slug}` : null,
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
      // Brief 2-3 step 5: what the IdP's admin needs for a SAML connection.
      ...(c.kind === 'SAML' ? { allowIdpInitiated: c.allowIdpInitiated, spEntityId: spEntityId(c), acsUrl: acsUrl(c), metadataUrl: spEntityId(c) } : {}),
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
  const before = await prisma.identityConnection.findFirst({ where: { id, tenantId, kind: 'OIDC' } });
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

/* Brief 2-3 step 5 — SAML connections: the IdP's SSO URL, entity id and signing certificate. */

const pemOk = (pem: string) => {
  try {
    new X509Certificate(pem);
    return true;
  } catch {
    return false;
  }
};

const SamlInput = z
  .object({
    displayName: z.string().trim().min(2).max(120),
    buttonLabel: z.string().trim().min(2).max(80).nullable().optional(),
    ssoUrl: z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'The sign-on URL must be https.'),
    idpEntityId: z.string().trim().min(1).max(300),
    idpCert: z.string().trim().min(100).max(20_000).refine(pemOk, 'That is not a PEM certificate.'),
    allowIdpInitiated: z.boolean().default(false),
    jitPolicy: z.enum(['NONE', 'INVITED_ONLY']).default('INVITED_ONLY'),
    ssoRequiredForStaff: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();

identityRouter.post('/saml-connections', MANAGE, async (req, res) => {
  const input = SamlInput.parse(req.body);
  const tenantId = tenantIdForWrite();
  const row = await prisma.identityConnection.create({
    data: {
      tenantId,
      kind: 'SAML',
      displayName: input.displayName,
      buttonLabel: input.buttonLabel ?? null,
      issuerUrl: input.ssoUrl,
      clientId: input.idpEntityId,
      clientSecretEnc: Buffer.alloc(0),
      samlIdpCert: input.idpCert,
      allowIdpInitiated: input.allowIdpInitiated,
      jitPolicy: input.jitPolicy,
      ssoRequiredForStaff: input.ssoRequiredForStaff,
      enabled: input.enabled,
      createdById: req.user!.id,
    },
  });
  await recordCriticalAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'identity.connection_created', entityType: 'IdentityConnection', entityId: row.id, metadata: { kind: 'SAML', ssoUrl: row.issuerUrl, idpEntityId: row.clientId, allowIdpInitiated: row.allowIdpInitiated, jitPolicy: row.jitPolicy, ssoRequiredForStaff: row.ssoRequiredForStaff } }, 'identity');
  res.status(201).json({ id: row.id, spEntityId: spEntityId(row), acsUrl: acsUrl(row) });
});

identityRouter.patch('/saml-connections/:id', MANAGE, async (req, res) => {
  const id = Id.parse(req.params.id);
  const input = patchSchema(SamlInput).strict().parse(req.body);
  const tenantId = tenantIdForWrite();
  const before = await prisma.identityConnection.findFirst({ where: { id, tenantId, kind: 'SAML' } });
  if (!before) throw new HttpError(404, 'connection_not_found', 'Connection not found.');
  const { ssoUrl, idpEntityId, idpCert, ...rest } = input;
  await prisma.identityConnection.update({
    where: { id },
    data: { ...rest, ...(ssoUrl ? { issuerUrl: ssoUrl } : {}), ...(idpEntityId ? { clientId: idpEntityId } : {}), ...(idpCert ? { samlIdpCert: idpCert } : {}) },
  });
  await recordCriticalAudit(
    { actorUserId: req.user!.id, clientId: null, tenantId, action: 'identity.connection_updated', entityType: 'IdentityConnection', entityId: id, metadata: { kind: 'SAML', fields: Object.keys(input), certRotated: !!idpCert, enabled: input.enabled ?? before.enabled, allowIdpInitiated: input.allowIdpInitiated ?? before.allowIdpInitiated } },
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
