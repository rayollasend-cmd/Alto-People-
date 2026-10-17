import type { Role, UserStatus } from '@prisma/client';
import type { Capability } from '@alto-people/shared';
import type { RequestLogger } from '../lib/logger.js';
import type { AgentContext } from '../lib/agents.js';

export interface SessionUser {
  id: string;
  email: string;
  /**
   * The role this request is authorized against — the hat the account is
   * WEARING, which for almost everyone is the only one they have. Every
   * capability check, scope clamp and query filter reads this and nothing
   * else, so a supervisor driving a van today is a driver to the whole
   * API for exactly as long as that is true.
   */
  role: Role;
  /** The account's home role, unchanged by switching. */
  primaryRole: Role;
  /** Every role this account may switch to, primary first. */
  availableRoles: Role[];
  status: UserStatus;
  clientId: string | null;
  /** CLIENT_PORTAL store scope — one Location under clientId, or null for
   *  the whole client. Ignored for every other role. */
  locationId: string | null;
  /** CLIENT_PORTAL region scope (command center) — set only when clientId is null. */
  regionId: string | null;
  associateId: string | null;
  tokenVersion: number;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  timezone: string | null;
  /** Brief 2-1b: the account's tenant, part of every client-bounded scope. */
  tenantId?: string | null;
  /** Brief 2-1b step 5: the organizational unit the account is pinned to, and its path for "under" checks. */
  orgUnitId?: string | null;
  orgUnitPath?: string | null;
  /** Email language preference (en/es/tr); null or absent means English. */
  language?: string | null;
  mfaEnabled: boolean;
  /**
   * Brief 2-3 step 3: a custom role's capabilities when the account wears
   * the role it narrows; null/absent = the built-in role's set. Read only
   * through `can()` / `capabilitiesOf()`, which also clamp to the archetype.
   */
  capabilities?: string[] | null;
  tenantRoleId?: string | null;
  tenantRoleName?: string | null;
  /**
   * Access pack: an internal role narrowed to these sites and/or regions
   * (lib/scope internalSites). Empty or absent = the whole tenant.
   */
  scopeSiteIds?: string[];
  scopeRegionIds?: string[];
}

/**
 * Authenticated API-key context. Set by `requireApiKey` middleware on
 * /integrations/v1/* requests. Distinct from `req.user` (cookie session)
 * so route handlers can't accidentally mix the two surfaces.
 */
export interface ApiKeyContext {
  id: string;
  /** null => global key (sees every client). Non-null => store-scoped. */
  clientId: string | null;
  capabilities: Capability[];
  name: string;
}

/** Brief 2-4: the /v1 OAuth client calling, set by requireApiToken. */
export interface ApiClientContext {
  id: string;
  clientId: string;
  name: string;
  scopes: import('@alto-people/shared').ApiScope[];
  /** The accountable person; every write's audit row names them. */
  ownerUserId: string;
  tenantId: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      /** Brief 2-4: set by requireApiToken on /v1. */
      apiClient?: ApiClientContext;
      /** How this session was established (from the token's amr claim). */
      authMethod?: 'password' | 'mfa' | 'passkey' | 'sso';
      apiKey?: ApiKeyContext;
      /** Set by requireAgent on /agent/v1: the registered agent calling (Brief 1D-2). */
      agent?: AgentContext;
      /**
       * Set by `attachUser` when the request had a session cookie that
       * was malformed, expired, or pointed at a now-invalid user.
       * `/auth/me` uses this to distinguish "no cookie" (200 with null)
       * from "stale cookie" (401, signal client to clear).
       */
      sessionStale?: boolean;
      /** Access pack: why attachUser ended the session, when a policy did (idle / absolute). */
      sessionEndedReason?: 'idle' | 'absolute';
      /**
       * Set by `allowMfaEnrollToken` when `req.user` was attached from a
       * short-lived mfa_enroll token (org-enforced MFA enrollment) rather
       * than a real session cookie. The enroll/confirm handler uses it to
       * promote the caller to a real session on success.
       */
      mfaEnrollment?: boolean;
      /**
       * Per-request correlation ID, set by the `requestId` middleware.
       * Echoed back as the `X-Request-Id` response header and surfaced
       * in error bodies + AuditLog metadata so a single trace ties
       * client report → middleware → handler → DB write together.
       */
      id: string;
      /**
       * Per-request structured logger, also set by `requestId`. Already
       * bound with { requestId, method, path } so `req.log.info({...})`
       * lines correlate to the trace automatically.
       */
      log: RequestLogger;
    }
  }
}
