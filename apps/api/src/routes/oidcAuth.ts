import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { HUMAN_ROLES } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { signSession } from '../lib/jwt.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { loginIpLimiter } from '../middleware/rateLimit.js';
import {
  enqueueAudit,
  recordLoginFailure,
  recordLoginSuccess,
} from '../lib/audit.js';
import {
  OIDC_FLOW_TTL_MS,
  OidcError,
  consumeFlowState,
  exchangeCode,
  generatePkce,
  getDiscovery,
  getOidcSettings,
  signFlowCookie,
  verifyFlowCookie,
  verifyIdToken,
} from '../lib/oidc.js';

/* ============================================================================
 * Enterprise SSO — OIDC authorization-code + PKCE login.
 *
 * Mounted at /auth/oidc (root path, like the sibling authRouter at /auth) so
 * cookies issued here — the session cookie and the short-lived flow cookie,
 * both path=/ — line up exactly with the password/passkey flows.
 *
 * This is a BROWSER flow end to end: /start and /callback answer 302
 * redirects, never JSON errors. Every failure funnels to
 * /login?error=sso_failed (or sso_no_account) with the machine-readable
 * detail recorded in an auth.login_failed audit row (reason `oidc_<detail>`).
 *
 * Design decisions, documented once here:
 *
 *  - NO auto-provisioning. An SSO identity with no matching Alto User gets
 *    the generic sso_no_account redirect. Account creation is owned by the
 *    invite flow (and, eventually, SCIM provisioning) — letting any member
 *    of the IdP tenant mint themselves an Alto account would bypass the
 *    role/client assignment those flows exist to control.
 *
 *  - DISABLED accounts get the SAME sso_no_account redirect as unknown
 *    emails: the login page must not be an oracle for "this person used to
 *    work here". The audit row keeps the real reason.
 *
 *  - INVITED accounts are activated on first SSO sign-in: the IdP just
 *    proved the person controls the mailbox the invite went to — the same
 *    proof the invite token conveys — so we flip status to ACTIVE and leave
 *    passwordHash null (they can keep signing in via SSO, or set a password
 *    later through the reset flow). Outstanding invite tokens are consumed.
 *
 *  - MFA: OIDC sign-ins are EXEMPT from the TOTP challenge, the same
 *    exemption the passkey path gets. The IdP owns MFA for federated
 *    identities (Entra Conditional Access / security defaults) — layering
 *    our TOTP on top would double-prompt every login and push orgs to turn
 *    one of the two off, usually the stronger one.
 *
 *  - Lockout: no lockout counters are consulted or reset here — no password
 *    was involved, so a successful SSO login says nothing about whether a
 *    password brute-force is in progress, and brute-forcing THIS path means
 *    brute-forcing the IdP, which runs its own lockout (Entra smart
 *    lockout). Clearing local counters on SSO success would let an attacker
 *    reset a victim's lockout clock just by riding a legitimate SSO session.
 * ========================================================================== */

export const oidcAuthRouter = Router();

// Same __Host- convention as the session + mfa_pending cookies: secure,
// path=/, no Domain in production, so a same-origin iframe can't override it.
export const OIDC_FLOW_COOKIE =
  env.NODE_ENV === 'production' ? '__Host-alto.oidc_flow' : 'alto.oidc_flow';

function flowCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const, // lax: the IdP top-level redirect back to us must carry it
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: OIDC_FLOW_TTL_MS,
  };
}

// Mirrors cookieOptions() in routes/auth.ts — the session issued here must
// be byte-for-byte the same shape as one issued by password or passkey login.
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.JWT_TTL_SECONDS * 1000,
  };
}

/**
 * The redirect_uri we send to the IdP — and the one that must be registered
 * in the IdP's app configuration: `{APP_BASE_URL}/api/auth/oidc/callback`.
 *
 * Why the /api prefix, given this router is mounted at the un-prefixed
 * /auth/oidc: the callback is a top-level BROWSER navigation, and the /api
 * form is the one path that reaches this handler in every environment:
 *
 *  - dev: APP_BASE_URL is the Vite server (5173); its proxy forwards only
 *    /api/* to the API (stripping the prefix). An un-prefixed
 *    /auth/oidc/callback would hit the SPA and die.
 *  - prod: the API serves the SPA itself. app.ts#stripApiPrefix answers
 *    browser navigations (Sec-Fetch-Mode: navigate) to /api/* with a 302
 *    to the de-prefixed path, query string intact — so the browser bounces
 *    /api/auth/oidc/callback?code=…&state=… → /auth/oidc/callback?code=…
 *    &state=…, a same-origin top-level GET that carries the sameSite=lax
 *    flow cookie into this handler. (Non-navigation /api/* requests are
 *    prefix-stripped in place and land here directly.)
 *
 * redirect_uri matching (both at the IdP and in the token exchange) is
 * exact-string, so the one canonical form must be used everywhere.
 */
function redirectUri(): string {
  return `${env.APP_BASE_URL.replace(/\/+$/, '')}/api/auth/oidc/callback`;
}

/** 302 to the login page with a coarse, non-oracular error code. */
function redirectToLogin(res: Response, code: 'sso_failed' | 'sso_no_account'): void {
  res.redirect(302, `/login?error=${code}`);
}

/**
 * Audit an OIDC failure, then bounce the browser back to /login. The audit
 * write is critical-flavored (recordLoginFailure throws on DB failure), but
 * nothing security-relevant completes on this path — the login is being
 * REFUSED — so an audit hiccup logs and still redirects rather than
 * dumping a JSON 500 on a browser navigation.
 */
async function failToLogin(
  req: Request,
  res: Response,
  detail: string,
  opts: { email?: string; page?: 'sso_failed' | 'sso_no_account' } = {},
): Promise<void> {
  try {
    await recordLoginFailure({
      email: opts.email ?? 'unknown',
      req,
      reason: `oidc_${detail}`,
    });
  } catch (err) {
    console.error('[auth.oidc] login_failed audit write failed:', err);
  }
  redirectToLogin(res, opts.page ?? 'sso_failed');
}

/**
 * GET /auth/oidc/config
 * Public, secret-free feature probe for the login page. `enabled` drives
 * whether the SSO button renders at all; buttonLabel is admin-set copy.
 */
oidcAuthRouter.get('/config', (_req, res) => {
  const settings = getOidcSettings();
  res.json({
    enabled: settings !== null,
    buttonLabel: settings?.buttonLabel ?? null,
  });
});

/**
 * GET /auth/oidc/start
 * Kicks off the authorization-code flow: mints state + nonce + PKCE pair,
 * stashes them in the HMAC-signed flow cookie, and 302s the browser to the
 * IdP's authorization endpoint. Reached by a top-level navigation
 * (window.location.assign from the login page), never by fetch().
 */
oidcAuthRouter.get('/start', loginIpLimiter, async (req, res, next) => {
  try {
    const settings = getOidcSettings();
    if (!settings) {
      // Feature off: a plain 404 (not a login-page redirect) — nothing
      // links here when config says disabled, so a hit is a probe or typo.
      throw new HttpError(404, 'sso_not_configured', 'SSO is not configured');
    }

    let discovery;
    try {
      discovery = await getDiscovery(settings);
    } catch (err) {
      // The IdP being unreachable is an operational failure, not a user
      // error — but the user is a browser mid-navigation, so send them
      // back to /login with the generic banner and keep the detail in audit.
      const detail = err instanceof OidcError ? err.reason : 'discovery_failed';
      await failToLogin(req, res, detail);
      return;
    }

    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const { verifier, challenge } = generatePkce();

    res.cookie(
      OIDC_FLOW_COOKIE,
      signFlowCookie({ state, nonce, verifier }),
      flowCookieOptions(),
    );

    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('client_id', settings.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri());
    authUrl.searchParams.set('scope', 'openid profile email');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    res.redirect(302, authUrl.toString());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/oidc/callback?code&state
 * The IdP redirects the browser here after authentication. Verifies the
 * flow cookie (single-use), exchanges the code, validates the ID token,
 * maps the email onto a local User, and issues the standard session cookie
 * exactly like the passkey path. See the file-header comment for the
 * account-state policy (no auto-provision / DISABLED oracle / INVITED
 * activation / MFA exemption / lockout non-interaction).
 */
oidcAuthRouter.get('/callback', loginIpLimiter, async (req, res, next) => {
  const settings = getOidcSettings();
  if (!settings) {
    next(new HttpError(404, 'sso_not_configured', 'SSO is not configured'));
    return;
  }

  try {
    // Read + immediately clear the flow cookie: it is single-use whatever
    // the outcome. (Clearing alone doesn't stop a captured value being
    // replayed — consumeFlowState below covers that.)
    const rawCookie = req.cookies?.[OIDC_FLOW_COOKIE] as string | undefined;
    // Same flags as the set, minus maxAge (Express deprecates maxAge on
    // clearCookie — the clear itself carries the immediate expiry).
    const { maxAge: _ignored, ...clearOpts } = flowCookieOptions();
    res.clearCookie(OIDC_FLOW_COOKIE, clearOpts);

    const flow = rawCookie ? verifyFlowCookie(rawCookie) : null;
    if (!flow) {
      await failToLogin(req, res, rawCookie ? 'bad_flow_cookie' : 'missing_flow_cookie');
      return;
    }

    // IdP-reported denial (user cancelled, consent refused, …) arrives as
    // ?error=… instead of ?code=….
    if (typeof req.query.error === 'string' && req.query.error.length > 0) {
      await failToLogin(req, res, `idp_${req.query.error.slice(0, 64)}`);
      return;
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) {
      await failToLogin(req, res, 'missing_code');
      return;
    }
    if (!state || state !== flow.state) {
      await failToLogin(req, res, 'state_mismatch');
      return;
    }
    if (!consumeFlowState(flow.state)) {
      await failToLogin(req, res, 'replayed_state');
      return;
    }

    let claims;
    try {
      const discovery = await getDiscovery(settings);
      const idToken = await exchangeCode({
        settings,
        discovery,
        code,
        redirectUri: redirectUri(),
        codeVerifier: flow.verifier,
      });
      claims = await verifyIdToken(idToken, {
        settings,
        discovery,
        nonce: flow.nonce,
      });
    } catch (err) {
      const detail = err instanceof OidcError ? err.reason : 'token_validation_failed';
      await failToLogin(req, res, detail);
      return;
    }

    const email = claims.email.trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: { email, deletedAt: null },
    });

    if (!user) {
      await failToLogin(req, res, 'unknown_email', { email, page: 'sso_no_account' });
      return;
    }
    if (!HUMAN_ROLES.includes(user.role)) {
      await failToLogin(req, res, 'non_human_role', { email, page: 'sso_no_account' });
      return;
    }
    if (user.status !== 'ACTIVE' && user.status !== 'INVITED') {
      // Same page as unknown_email — no status oracle. Audit keeps the truth.
      await failToLogin(req, res, 'disabled', { email, page: 'sso_no_account' });
      return;
    }

    let sessionUser = user;
    if (user.status === 'INVITED') {
      const now = new Date();
      sessionUser = await prisma.$transaction(async (tx) => {
        // Any outstanding invite links are moot once SSO proved mailbox
        // control — consume them so a stale link can't be accepted later.
        await tx.inviteToken.updateMany({
          where: { userId: user.id, consumedAt: null },
          data: { consumedAt: now },
        });
        return tx.user.update({
          where: { id: user.id },
          data: {
            status: 'ACTIVE',
            // passwordHash stays null on purpose: this account signs in
            // via the IdP. tokenVersion bump mirrors accept-invite —
            // defensive against any pre-activation cookies.
            tokenVersion: { increment: 1 },
          },
        });
      });
      enqueueAudit(
        {
          actorUserId: sessionUser.id,
          clientId: sessionUser.clientId ?? null,
          action: 'auth.sso_activated',
          entityType: 'User',
          entityId: sessionUser.id,
          metadata: {
            ip: req.ip ?? null,
            userAgent: req.headers['user-agent'] ?? null,
            email,
            idpSub: claims.sub,
          },
        },
        'auth.sso_activated',
      );
    }

    // Critical audit BEFORE the cookie goes out: recordLoginSuccess throws
    // on DB failure, and we must never hand a browser a session the audit
    // feed doesn't know about. metadata.method='oidc' distinguishes these
    // rows from password/passkey logins.
    await recordLoginSuccess({
      email: sessionUser.email,
      req,
      userId: sessionUser.id,
      clientId: sessionUser.clientId,
      method: 'oidc',
    });

    const token = signSession({
      sub: sessionUser.id,
      role: sessionUser.role,
      ver: sessionUser.tokenVersion,
    });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.redirect(302, '/');
  } catch (err) {
    // Never JSON-error a redirect flow: last-resort catch (unexpected DB
    // error, audit-write failure post-refusal, …) still lands the browser
    // on the login page. The error itself goes to the logs via console —
    // there's no next(err) here by design.
    console.error('[auth.oidc.callback] unexpected failure:', err);
    redirectToLogin(res, 'sso_failed');
  }
});
