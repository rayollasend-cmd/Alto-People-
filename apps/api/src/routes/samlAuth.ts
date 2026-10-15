import { Router, urlencoded } from 'express';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { loginIpLimiter } from '../middleware/rateLimit.js';
import { safeReturnPath } from '../lib/oidc.js';
import { SamlError, samlAuthorizeUrl, samlMetadata, sweepSamlCache, validateSamlResponse } from '../lib/saml.js';
import { completeSsoSignIn, failToLogin } from './oidcAuth.js';

/**
 * Brief 2-3 step 5 — SAML 2.0 sign-in (lib/saml.ts has the rules).
 *
 *   GET  /auth/saml/start?connection=&next=   302 to the IdP with an AuthnRequest
 *   POST /auth/saml/acs/:connectionId          the IdP's response (form post); signs in like OIDC
 *   GET  /auth/saml/metadata/:connectionId     our SP metadata, for the IdP's admin
 *
 * Every failure is the login page's generic banner, with the reason in an
 * auth.login_failed row (saml_<reason>), exactly like the OIDC flow; the
 * account policy (no provisioning, no status oracle, invited → active,
 * subject binding) is the same function.
 */

export const samlAuthRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function samlConnection(id: unknown) {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  return prisma.identityConnection.findFirst({ where: { id, enabled: true, kind: 'SAML' } });
}

samlAuthRouter.get('/start', loginIpLimiter, async (req, res) => {
  const conn = await samlConnection(req.query.connection);
  if (!conn) throw new HttpError(404, 'sso_not_configured', 'SSO is not configured');
  // Housekeeping now and then: expired request and assertion ids.
  if (Math.random() < 0.05) void sweepSamlCache(prisma).catch(() => undefined);
  try {
    const url = await samlAuthorizeUrl(prisma, conn, safeReturnPath(req.query.next) ?? '');
    res.redirect(302, url);
  } catch (err) {
    await failToLogin(req, res, err instanceof SamlError ? err.reason : 'start_failed', { prefix: 'saml' });
  }
});

samlAuthRouter.post('/acs/:connectionId', loginIpLimiter, urlencoded({ extended: false, limit: '512kb' }), async (req, res) => {
  try {
    const conn = await samlConnection(req.params.connectionId);
    if (!conn) {
      await failToLogin(req, res, 'connection_unavailable', { prefix: 'saml' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, string>;
    let ident: { sub: string; email: string };
    try {
      ident = await validateSamlResponse(prisma, conn, body);
    } catch (err) {
      await failToLogin(req, res, err instanceof SamlError ? err.reason : 'invalid_response', { prefix: 'saml' });
      return;
    }
    await completeSsoSignIn(req, res, conn, ident, safeReturnPath(body.RelayState) ?? undefined, 'saml');
  } catch (err) {
    console.error('[auth.saml.acs] unexpected failure:', err);
    res.redirect(302, '/login?error=sso_failed');
  }
});

samlAuthRouter.get('/metadata/:connectionId', async (req, res) => {
  const conn = await samlConnection(req.params.connectionId);
  if (!conn) throw new HttpError(404, 'not_found', 'Not found.');
  res.type('application/samlmetadata+xml').send(samlMetadata(conn));
});
