import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAnyCapability, requireAuth } from '../middleware/auth.js';
import { signedLinkIpLimiter } from '../middleware/rateLimit.js';
import { enqueueAudit } from '../lib/audit.js';
import { getBrandingSync } from '../lib/branding.js';
import { assertAssociateInScope } from '../lib/scope.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';
import {
  credentialSources,
  didDocument,
  issueCredential,
  statusEntryFor,
  statusListCredential,
  verifyCredential,
  type SubjectType,
} from '../lib/verifiableCredentials.js';

/**
 * Credentials a worker carries, signed to W3C standards (lib/verifiableCredentials).
 *
 *   GET  /me/wallet/credentials                         my credentials, each signed
 *   GET  /me/wallet/credentials/:type/:id               one, as a file
 *   POST /me/wallet/credentials/offer                   a 15-minute link a wallet app can collect them from
 *   GET  /credentials/offer/:token                      what the link hands over (no login — the link is the key)
 *   GET  /.well-known/did.json                          the first tenant's issuer DID document
 *   GET  /issuers/:slug/did.json                        every other tenant's
 *   GET  /credentials/status/:slug                      the tenant's revocation list (signed)
 *   POST /credentials/verify                            check a credential — no login
 *   POST /credentials/:type/:id/revoke                  HR revokes one
 */
export const credentialsRouter = Router();

const OFFER_AUD = 'alto:credential-offer';
const SubjectTypeParam = z.enum(['qualification', 'training']);

async function tenantRow(tenantId: string) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true, name: true } });
  if (!t) throw new HttpError(404, 'tenant_not_found', 'Unknown organization.');
  // The credential names the organization as the people know it — the branding name.
  return { ...t, name: getBrandingSync(t.id).orgName || t.name };
}

async function myCredentials(associateId: string, tenantId: string) {
  const tenant = await tenantRow(tenantId);
  const sources = await credentialSources(prisma, associateId);
  const out = [];
  for (const src of sources) {
    out.push({ subjectType: src.subjectType, subjectId: src.subjectId, title: src.title, credential: await issueCredential(prisma, tenant, src) });
  }
  return out;
}

credentialsRouter.get('/me/wallet/credentials', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'not_an_associate', 'The wallet is for associate-linked accounts.');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ credentials: await myCredentials(associateId, tenantIdForWrite()) });
  } catch (err) {
    next(err);
  }
});

credentialsRouter.get('/me/wallet/credentials/:type/:id', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'not_an_associate', 'The wallet is for associate-linked accounts.');
    const type = SubjectTypeParam.parse(req.params.type);
    const id = z.string().uuid().parse(req.params.id);
    const src = (await credentialSources(prisma, associateId)).find((s) => s.subjectType === type && s.subjectId === id);
    if (!src) throw new HttpError(404, 'credential_not_found', 'That credential isn’t in your wallet.');
    const credential = await issueCredential(prisma, await tenantRow(tenantIdForWrite()), src);
    enqueueAudit({ actorUserId: req.user!.id, action: 'wallet.credential_downloaded', entityType: 'Associate', entityId: associateId, metadata: { type, id } }, 'wallet.credential');
    res.setHeader('Content-Type', 'application/vc+ld+json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${src.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'credential'}.json"`);
    res.send(JSON.stringify(credential, null, 2));
  } catch (err) {
    next(err);
  }
});

credentialsRouter.post('/me/wallet/credentials/offer', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'not_an_associate', 'The wallet is for associate-linked accounts.');
    const expiresIn = 15 * 60;
    const token = jwt.sign({ sub: associateId, t: tenantIdForWrite() }, env.JWT_SECRET, { algorithm: 'HS256', audience: OFFER_AUD, expiresIn });
    enqueueAudit({ actorUserId: req.user!.id, action: 'wallet.credential_offer', entityType: 'Associate', entityId: associateId, metadata: { minutes: 15 } }, 'wallet.credential');
    res.status(201).json({
      url: `${env.APP_BASE_URL.replace(/\/$/, '')}/api/credentials/offer/${token}`,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

credentialsRouter.get('/credentials/offer/:token', signedLinkIpLimiter, async (req, res, next) => {
  try {
    let decoded: jwt.JwtPayload;
    try {
      const d = jwt.verify(req.params.token, env.JWT_SECRET, { algorithms: ['HS256'], audience: OFFER_AUD });
      if (typeof d === 'string' || !d.sub || typeof d.t !== 'string') throw new Error('bad');
      decoded = d;
    } catch {
      throw new HttpError(404, 'offer_expired', 'This link has expired. Make a new one from your wallet.');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ credentials: (await myCredentials(decoded.sub!, decoded.t as string)).map((c) => c.credential) });
  } catch (err) {
    next(err);
  }
});

/* ----- Public: the issuer and its revocation list ------------------------------ */

credentialsRouter.get('/.well-known/did.json', async (_req, res, next) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: ALTO_TENANT_ID }, select: { id: true, slug: true } });
    if (!t) throw new HttpError(404, 'not_found', 'No issuer here.');
    res.setHeader('Content-Type', 'application/did+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(JSON.stringify(await didDocument(prisma, t)));
  } catch (err) {
    next(err);
  }
});

credentialsRouter.get('/issuers/:slug/did.json', async (req, res, next) => {
  try {
    const slug = z.string().min(1).max(60).parse(req.params.slug);
    const t = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, slug: true } });
    if (!t || t.id === ALTO_TENANT_ID) throw new HttpError(404, 'not_found', 'No issuer by that name.');
    res.setHeader('Content-Type', 'application/did+json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(JSON.stringify(await didDocument(prisma, t)));
  } catch (err) {
    next(err);
  }
});

credentialsRouter.get('/credentials/status/:slug', async (req, res, next) => {
  try {
    const slug = z.string().min(1).max(60).parse(req.params.slug);
    const t = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, slug: true } });
    if (!t) throw new HttpError(404, 'not_found', 'No status list by that name.');
    res.setHeader('Content-Type', 'application/vc+ld+json');
    // Short: a revocation should reach verifiers within minutes.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(JSON.stringify(await statusListCredential(prisma, t)));
  } catch (err) {
    next(err);
  }
});

const VerifyBody = z.object({ credential: z.unknown() });

credentialsRouter.post('/credentials/verify', signedLinkIpLimiter, async (req, res, next) => {
  try {
    const body = VerifyBody.parse(req.body ?? {});
    let credential = body.credential;
    if (typeof credential === 'string') {
      try {
        credential = JSON.parse(credential);
      } catch {
        res.json({ verdict: 'invalid', checks: [{ key: 'format', state: 'fail', label: 'That text isn’t valid JSON.' }], credential: null });
        return;
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(await verifyCredential(prisma, credential));
  } catch (err) {
    next(err);
  }
});

/* ----- HR: revoke one ---------------------------------------------------------------- */

credentialsRouter.post('/credentials/:type/:id/revoke', requireAnyCapability('manage:compliance'), async (req, res, next) => {
  try {
    const type = SubjectTypeParam.parse(req.params.type) as SubjectType;
    const id = z.string().uuid().parse(req.params.id);
    const reason = z.string().trim().min(3).max(500).parse(req.body?.reason);
    const tenantId = tenantIdForWrite();
    const owner =
      type === 'qualification'
        ? await prisma.associateQualification.findFirst({ where: { id, associate: { tenantId } }, select: { associateId: true } })
        : await prisma.courseEnrollment.findFirst({ where: { id, associate: { tenantId } }, select: { associateId: true } });
    if (!owner) throw new HttpError(404, 'credential_not_found', 'No such credential.');
    await assertAssociateInScope(prisma, req.user!, owner.associateId);
    const entry = await statusEntryFor(prisma, tenantId, type, id, owner.associateId);
    await prisma.credentialStatusEntry.update({ where: { id: entry.id }, data: { revokedAt: new Date() } });
    enqueueAudit({ actorUserId: req.user!.id, action: 'credential.revoked', entityType: 'Associate', entityId: owner.associateId, metadata: { type, id, reason, listIndex: entry.listIndex } }, 'credential.revoke');
    res.json({ ok: true, listIndex: entry.listIndex });
  } catch (err) {
    next(err);
  }
});
