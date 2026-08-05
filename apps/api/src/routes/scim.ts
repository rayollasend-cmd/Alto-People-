import {
  Router,
  json,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ROLES, type Role } from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { recordCriticalAudit } from '../lib/audit.js';

/**
 * SCIM 2.0 Users endpoint (RFC 7643 / RFC 7644 — the subset Microsoft
 * Entra ID and Okta actually exercise) so an IdP can provision and
 * deprovision Alto accounts.
 *
 * Auth: a single dedicated long-lived bearer, SCIM_TOKEN. This is
 * deliberately NOT the altop_ ApiKey system (middleware/apiKeyAuth.ts):
 * those keys are read-only partner credentials with per-key capability
 * lists and optional client scoping — semantics that don't fit an IdP
 * that must WRITE the user table org-wide. Wedging a "manage users"
 * capability into that system would turn every future partner-key
 * review into a "can this key create admins?" question. One dedicated
 * secret, one surface, constant-time compared, 503 when unset (mirrors
 * BRANCH_WEBHOOK_SECRET's "never run unauthenticated" posture).
 *
 * Deliberate behaviors (all verified against Entra's provisioning flow):
 *  - POST creates an INVITED user and does NOT send the invite email.
 *    IdP-driven creation happens in bulk on the Entra sync schedule;
 *    auto-mailing every synced account would spam people who may never
 *    use Alto. Admins send invites from the Users & access UI when the
 *    person actually needs in.
 *  - `active: true` can only flip a user to ACTIVE when they hold a
 *    sign-in credential (passwordHash or a WebAuthn passkey). Otherwise
 *    the account stays INVITED — ACTIVE-without-credential would be a
 *    lie the rest of the app doesn't expect.
 *  - DELETE is a soft-deprovision: status DISABLED + tokenVersion bump
 *    (kills live sessions), never a row delete. User rows anchor audit
 *    history, payroll authorship, signatures — hard-deleting on an IdP
 *    hiccup would orphan all of it. Entra treats 204 as success and
 *    re-creates via POST if the person returns.
 *  - Unsupported PATCH paths are ignored with a 200 (Entra sends noisy
 *    patches for displayName, addresses, etc.); what was ignored is
 *    recorded in the audit row so drift is diagnosable.
 *  - No password, SSN, or associate PII beyond name mapping is ever
 *    accepted or emitted. LIVE_ASN (non-human integration role) and
 *    CLIENT_PORTAL (requires a client scope SCIM can't express) may not
 *    be created via SCIM.
 *
 * Every mutation writes a CRITICAL (synchronous) audit row with
 * actorUserId = null and metadata.actor = 'scim' — same null-actor
 * convention as auth.login_failed / payroll.branch_webhook.
 */

export const scimRouter = Router();

const SCIM_CONTENT_TYPE = 'application/scim+json';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

const BASE_PATH = '/scim/v2';

// Roles that may never be assigned through SCIM. LIVE_ASN is the non-human
// integration role (login is refused for it anyway); CLIENT_PORTAL requires
// a client scope that SCIM has no attribute for — an unscoped CLIENT_PORTAL
// account fails closed and confuses everyone.
const SCIM_FORBIDDEN_ROLES: ReadonlySet<string> = new Set(['LIVE_ASN', 'CLIENT_PORTAL']);
const ROLE_NAMES: ReadonlySet<string> = new Set(Object.keys(ROLES));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function sendScim(res: Response, status: number, body: unknown): void {
  // res.json() only sets Content-Type when one isn't already present, so
  // presetting it here makes every response go out as application/scim+json.
  res.status(status).set('Content-Type', SCIM_CONTENT_TYPE).json(body);
}

function scimError(
  res: Response,
  status: number,
  detail: string,
  scimType?: string,
): void {
  sendScim(res, status, {
    schemas: [ERROR_SCHEMA],
    // RFC 7644 §3.12: status is a JSON string.
    status: String(status),
    detail,
    ...(scimType ? { scimType } : {}),
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Constant-time equality over variable-length strings: compare SHA-256
 * digests so neither length nor prefix leaks through timing. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function requireScimToken(req: Request, res: Response, next: NextFunction): void {
  // Read env.SCIM_TOKEN per-request (not captured at module load) so the
  // unset→503 behavior is testable and a future hot-reload of config works.
  const expected = env.SCIM_TOKEN;
  if (!expected || expected.trim() === '') {
    scimError(
      res,
      503,
      'SCIM provisioning is not configured on this deployment (SCIM_TOKEN is unset).',
    );
    return;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  if (!match || !tokenMatches(match[1], expected)) {
    scimError(res, 401, 'Invalid or missing bearer token.');
    return;
  }
  next();
}

// Accept both application/scim+json (what Entra sends) and application/json.
// The app-level express.json() only parses application/json and skips
// anything else, so this router-level parser fills the gap; body-parser's
// req._body flag prevents double-parsing when the global one already ran.
scimRouter.use(json({ type: ['application/json', SCIM_CONTENT_TYPE], limit: '256kb' }));
scimRouter.use(requireScimToken);

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const SCIM_USER_SELECT = {
  id: true,
  email: true,
  role: true,
  status: true,
  scimExternalId: true,
  createdAt: true,
  updatedAt: true,
  associate: { select: { firstName: true, lastName: true } },
} as const;

// Superset used by mutating routes: passwordHash / passkey count decide
// whether `active: true` may flip the account to ACTIVE. Neither field is
// ever emitted — toScimUser() only reads the mapped attributes.
const SCIM_USER_ADMIN_SELECT = {
  ...SCIM_USER_SELECT,
  passwordHash: true,
  tokenVersion: true,
  _count: { select: { webauthnCredentials: true } },
} as const;

type ScimDbUser = Prisma.UserGetPayload<{ select: typeof SCIM_USER_SELECT }>;
type ScimDbUserAdmin = Prisma.UserGetPayload<{ select: typeof SCIM_USER_ADMIN_SELECT }>;

function toScimUser(u: ScimDbUser): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    active: u.status === 'ACTIVE',
    ...(u.scimExternalId !== null ? { externalId: u.scimExternalId } : {}),
    // Name flows from the HR-owned Associate record when one is linked.
    // SCIM cannot write it — associates carry PII this surface must not
    // manage, so `name` is read-only mapping, nothing more.
    ...(u.associate
      ? {
          name: {
            givenName: u.associate.firstName,
            familyName: u.associate.lastName,
            formatted: `${u.associate.firstName} ${u.associate.lastName}`,
          },
        }
      : {}),
    roles: [{ value: u.role, type: 'alto-role', primary: true }],
    meta: {
      resourceType: 'User',
      created: u.createdAt.toISOString(),
      lastModified: u.updatedAt.toISOString(),
      location: `${BASE_PATH}/Users/${u.id}`,
    },
  };
}

/** Entra is known to send active as the strings "True"/"False" as well as
 * real booleans. Returns null when the value is neither. */
function coerceActive(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  return null;
}

function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

/** roles[0].value from a request body, validated against the Role enum and
 * the SCIM-forbidden set. Returns { role } on success, { error } otherwise,
 * and null when the body simply doesn't carry a role. */
function parseRequestedRole(
  body: Record<string, unknown>,
): { role: Role } | { error: string } | null {
  const roles = body.roles;
  if (roles === undefined || roles === null) return null;
  if (!Array.isArray(roles) || roles.length === 0) return null;
  const first = roles[0] as { value?: unknown } | undefined;
  const value = first && typeof first === 'object' ? first.value : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'roles[0].value must be a non-empty string.' };
  }
  const name = value.trim();
  if (!ROLE_NAMES.has(name)) {
    return { error: `Unknown role: ${name}.` };
  }
  if (SCIM_FORBIDDEN_ROLES.has(name)) {
    return { error: `Role ${name} may not be assigned via SCIM.` };
  }
  return { role: name as Role };
}

function scimAuditMeta(req: Request, extra: Record<string, unknown>) {
  return {
    // Marks the SCIM integration as the actor — actorUserId is null (no
    // human behind the request), same convention as auth.login_failed.
    actor: 'scim',
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    requestId: req.id ?? null,
    ...extra,
  };
}

async function loadUser(id: string): Promise<ScimDbUserAdmin | null> {
  if (!UUID_RE.test(id)) return null;
  return prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: SCIM_USER_ADMIN_SELECT,
  });
}

/** Status the account should land in when the IdP says active: true. */
function activationTarget(u: ScimDbUserAdmin): 'ACTIVE' | 'INVITED' {
  const hasCredential = u.passwordHash !== null || u._count.webauthnCredentials > 0;
  return hasCredential ? 'ACTIVE' : 'INVITED';
}

// ---------------------------------------------------------------------------
// Discovery endpoints (static)
// ---------------------------------------------------------------------------

scimRouter.get('/ServiceProviderConfig', (_req, res) => {
  sendScim(res, 200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description:
          'Long-lived bearer token issued by Alto People (SCIM_TOKEN).',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${BASE_PATH}/ServiceProviderConfig`,
    },
  });
});

const USER_SCHEMA_RESOURCE = {
  id: USER_SCHEMA,
  name: 'User',
  description: 'Alto People user account',
  attributes: [
    {
      name: 'userName',
      type: 'string',
      multiValued: false,
      required: true,
      caseExact: false,
      mutability: 'readWrite',
      returned: 'default',
      uniqueness: 'server',
      description: 'The email address the user signs in with.',
    },
    {
      name: 'active',
      type: 'boolean',
      multiValued: false,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      description:
        'true when the account is ACTIVE. Setting false disables the account and revokes sessions.',
    },
    {
      name: 'name',
      type: 'complex',
      multiValued: false,
      required: false,
      mutability: 'readOnly',
      returned: 'default',
      description: 'Read-only; sourced from the linked HR associate record.',
      subAttributes: [
        { name: 'givenName', type: 'string', multiValued: false, mutability: 'readOnly' },
        { name: 'familyName', type: 'string', multiValued: false, mutability: 'readOnly' },
      ],
    },
    {
      name: 'roles',
      type: 'complex',
      multiValued: true,
      required: false,
      mutability: 'readWrite',
      returned: 'default',
      description:
        'roles[0].value must be a valid Alto role name; defaults to ASSOCIATE on create.',
      subAttributes: [
        { name: 'value', type: 'string', multiValued: false, mutability: 'readWrite' },
      ],
    },
  ],
  meta: {
    resourceType: 'Schema',
    location: `${BASE_PATH}/Schemas/${USER_SCHEMA}`,
  },
};

scimRouter.get('/Schemas', (_req, res) => {
  sendScim(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [USER_SCHEMA_RESOURCE],
  });
});

scimRouter.get('/ResourceTypes', (_req, res) => {
  sendScim(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: USER_SCHEMA,
        meta: {
          resourceType: 'ResourceType',
          location: `${BASE_PATH}/ResourceTypes/User`,
        },
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// GET /Users — list + Entra's reconciliation filter
// ---------------------------------------------------------------------------

scimRouter.get('/Users', async (req, res) => {
  const filter = typeof req.query.filter === 'string' ? req.query.filter : undefined;
  let emailEq: string | undefined;
  if (filter !== undefined) {
    // The only filter Entra sends during reconciliation. Everything else
    // is out of scope, and per RFC 7644 an unsupported filter is a 400.
    const m = /^userName\s+eq\s+"([^"]*)"$/i.exec(filter.trim());
    if (!m) {
      scimError(
        res,
        400,
        'Only the filter `userName eq "value"` is supported.',
        'invalidFilter',
      );
      return;
    }
    emailEq = normalizeEmail(m[1]);
  }

  const startIndexRaw = Number(req.query.startIndex);
  const countRaw = Number(req.query.count);
  // SCIM startIndex is 1-based; anything <1 (or absent) means 1.
  const startIndex =
    Number.isInteger(startIndexRaw) && startIndexRaw > 1 ? startIndexRaw : 1;
  // Default page 100, hard cap 200 (matches ServiceProviderConfig.maxResults).
  // count=0 is legal SCIM: totalResults only, no Resources.
  const count = Number.isInteger(countRaw)
    ? Math.min(Math.max(countRaw, 0), 200)
    : 100;

  const where = {
    deletedAt: null,
    ...(emailEq !== undefined
      ? { email: { equals: emailEq, mode: 'insensitive' as const } }
      : {}),
  };

  const totalResults = await prisma.user.count({ where });
  const rows =
    count === 0
      ? []
      : await prisma.user.findMany({
          where,
          select: SCIM_USER_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: startIndex - 1,
          take: count,
        });

  sendScim(res, 200, {
    schemas: [LIST_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map(toScimUser),
  });
});

// ---------------------------------------------------------------------------
// GET /Users/:id
// ---------------------------------------------------------------------------

scimRouter.get('/Users/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user) {
    scimError(res, 404, 'User not found.');
    return;
  }
  sendScim(res, 200, toScimUser(user));
});

// ---------------------------------------------------------------------------
// POST /Users — create
// ---------------------------------------------------------------------------

scimRouter.post('/Users', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Password fields are never accepted. Entra sends a random password on
  // create as part of its default attribute mappings — we drop it on the
  // floor (and never audit-log the body) so no IdP-minted secret ever
  // touches this system. Users set credentials through the invite flow.
  const userName =
    typeof body.userName === 'string' ? normalizeEmail(body.userName) : '';
  if (!userName || !EMAIL_RE.test(userName) || userName.length > 254) {
    scimError(
      res,
      400,
      'userName is required and must be an email address.',
      'invalidValue',
    );
    return;
  }

  let externalId: string | null = null;
  if (body.externalId !== undefined && body.externalId !== null) {
    if (typeof body.externalId !== 'string' || body.externalId.length > 255) {
      scimError(res, 400, 'externalId must be a string.', 'invalidValue');
      return;
    }
    externalId = body.externalId;
  }

  let active = true;
  if (body.active !== undefined) {
    const coerced = coerceActive(body.active);
    if (coerced === null) {
      scimError(res, 400, 'active must be a boolean.', 'invalidValue');
      return;
    }
    active = coerced;
  }

  let role: Role = 'ASSOCIATE';
  const requestedRole = parseRequestedRole(body);
  if (requestedRole !== null) {
    if ('error' in requestedRole) {
      scimError(res, 400, requestedRole.error, 'invalidValue');
      return;
    }
    role = requestedRole.role;
  }

  const conflict = await prisma.user.findFirst({
    where: { email: { equals: userName, mode: 'insensitive' } },
    select: { id: true },
  });
  if (conflict) {
    scimError(
      res,
      409,
      `A user with userName ${userName} already exists.`,
      'uniqueness',
    );
    return;
  }

  // A brand-new account has no credential, so it can never start ACTIVE:
  // active:true → INVITED (admin sends the invite from the UI when the
  // person needs access — deliberately no auto-email here, see header).
  // active:false → DISABLED (pre-staged but blocked).
  const status = active ? ('INVITED' as const) : ('DISABLED' as const);

  let created: ScimDbUser;
  try {
    created = await prisma.user.create({
      data: { email: userName, role, status, scimExternalId: externalId },
      select: SCIM_USER_SELECT,
    });
  } catch (err) {
    // Unique-constraint race between the check above and the insert.
    if (
      err &&
      typeof err === 'object' &&
      (err as { code?: string }).code === 'P2002'
    ) {
      scimError(
        res,
        409,
        `A user with userName ${userName} already exists.`,
        'uniqueness',
      );
      return;
    }
    throw err;
  }

  await recordCriticalAudit(
    {
      actorUserId: null,
      clientId: null,
      action: 'scim.user_created',
      entityType: 'User',
      entityId: created.id,
      metadata: scimAuditMeta(req, {
        email: userName,
        role,
        status,
        externalId,
      }),
    },
    'scim.user_created',
  );

  res.set('Location', `${BASE_PATH}/Users/${created.id}`);
  sendScim(res, 201, toScimUser(created));
});

// ---------------------------------------------------------------------------
// Shared mutation applier (PATCH / PUT / DELETE)
// ---------------------------------------------------------------------------

interface DesiredChanges {
  active?: boolean;
  userName?: string;
  externalId?: string | null;
  role?: Role;
}

interface ApplyOutcome {
  ok: true;
  user: ScimDbUser;
  changed: boolean;
  changes: Record<string, unknown>;
}
interface ApplyError {
  ok: false;
  status: number;
  detail: string;
  scimType?: string;
}

/** Diffs the desired attribute values against the current row, applies the
 * update (with a tokenVersion bump when a session-killing change is made),
 * and returns the fresh row + an audit-ready change map. */
async function applyChanges(
  user: ScimDbUserAdmin,
  desired: DesiredChanges,
): Promise<ApplyOutcome | ApplyError> {
  const data: Prisma.UserUncheckedUpdateInput = {};
  const changes: Record<string, unknown> = {};
  let bumpToken = false;

  if (desired.userName !== undefined && desired.userName !== user.email) {
    const conflict = await prisma.user.findFirst({
      where: {
        email: { equals: desired.userName, mode: 'insensitive' },
        id: { not: user.id },
      },
      select: { id: true },
    });
    if (conflict) {
      return {
        ok: false,
        status: 409,
        detail: `A user with userName ${desired.userName} already exists.`,
        scimType: 'uniqueness',
      };
    }
    data.email = desired.userName;
    changes.email = { from: user.email, to: desired.userName };
  }

  if (
    desired.externalId !== undefined &&
    desired.externalId !== user.scimExternalId
  ) {
    data.scimExternalId = desired.externalId;
    changes.externalId = { from: user.scimExternalId, to: desired.externalId };
  }

  if (desired.role !== undefined && desired.role !== user.role) {
    data.role = desired.role;
    changes.role = { from: user.role, to: desired.role };
    // Same rule as the admin UI (routes/users.ts): a role change kills
    // existing sessions so the new access takes effect immediately.
    bumpToken = true;
  }

  if (desired.active === false) {
    if (user.status !== 'DISABLED') {
      data.status = 'DISABLED';
      changes.status = { from: user.status, to: 'DISABLED' };
      // Same pattern as routes/users.ts: flipping into DISABLED bumps
      // tokenVersion so every live session dies immediately.
      bumpToken = true;
    }
  } else if (desired.active === true) {
    // ACTIVE only when the user can actually sign in (passwordHash or a
    // WebAuthn passkey on file); otherwise the account stays INVITED
    // until they accept an invite and set a credential.
    const target = activationTarget(user);
    if (user.status !== target) {
      data.status = target;
      changes.status = { from: user.status, to: target };
    }
  }

  if (Object.keys(data).length === 0) {
    return { ok: true, user, changed: false, changes };
  }
  if (bumpToken) data.tokenVersion = { increment: 1 };

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: SCIM_USER_SELECT,
  });
  invalidateUserCache(user.id);
  return { ok: true, user: updated, changed: true, changes };
}

// ---------------------------------------------------------------------------
// PATCH /Users/:id — RFC 7644 PatchOp
// ---------------------------------------------------------------------------

/** Lowercases a PatchOp path and strips the core-User URN prefix Entra
 * sometimes includes (`urn:...:2.0:User:active`). */
function normalizePatchPath(path: unknown): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  return path
    .trim()
    .replace(/^urn:ietf:params:scim:schemas:core:2\.0:User[:.]/i, '')
    .toLowerCase();
}

scimRouter.patch('/Users/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user) {
    scimError(res, 404, 'User not found.');
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const ops = body.Operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    scimError(res, 400, 'Operations array is required.', 'invalidSyntax');
    return;
  }

  const desired: DesiredChanges = {};
  const ignoredPaths: string[] = [];

  const applyAttr = (attr: string, value: unknown): ApplyError | null => {
    switch (attr) {
      case 'active': {
        const coerced = coerceActive(value);
        if (coerced === null) {
          return { ok: false, status: 400, detail: 'active must be a boolean.', scimType: 'invalidValue' };
        }
        desired.active = coerced;
        return null;
      }
      case 'username': {
        const email = typeof value === 'string' ? normalizeEmail(value) : '';
        if (!email || !EMAIL_RE.test(email) || email.length > 254) {
          return { ok: false, status: 400, detail: 'userName must be an email address.', scimType: 'invalidValue' };
        }
        desired.userName = email;
        return null;
      }
      case 'externalid': {
        if (value === null) {
          desired.externalId = null;
          return null;
        }
        if (typeof value !== 'string' || value.length > 255) {
          return { ok: false, status: 400, detail: 'externalId must be a string.', scimType: 'invalidValue' };
        }
        desired.externalId = value;
        return null;
      }
      default:
        // Entra sends noisy patches (displayName, addresses[...], etc.).
        // Per the provisioning contract we ignore them with a 200 — but
        // the audit row records exactly what was dropped.
        ignoredPaths.push(attr);
        return null;
    }
  };

  for (const opRaw of ops) {
    const op = (opRaw ?? {}) as Record<string, unknown>;
    const opName = String(op.op ?? '').toLowerCase();
    // `add` is treated as `replace` for single-valued attrs (Entra uses
    // both interchangeably); `remove` and anything else is unsupported.
    if (opName !== 'replace' && opName !== 'add') {
      ignoredPaths.push(`${opName || '(missing op)'}:${typeof op.path === 'string' ? op.path : ''}`);
      continue;
    }
    const path = normalizePatchPath(op.path);
    if (path === null) {
      // No path: value is an object of attribute → value pairs.
      if (op.value === null || typeof op.value !== 'object' || Array.isArray(op.value)) {
        scimError(res, 400, 'A path-less operation requires an object value.', 'invalidSyntax');
        return;
      }
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
        const err = applyAttr(k.toLowerCase(), v);
        if (err) {
          scimError(res, err.status, err.detail, err.scimType);
          return;
        }
      }
    } else {
      const err = applyAttr(path, op.value);
      if (err) {
        scimError(res, err.status, err.detail, err.scimType);
        return;
      }
    }
  }

  const outcome = await applyChanges(user, desired);
  if (!outcome.ok) {
    scimError(res, outcome.status, outcome.detail, outcome.scimType);
    return;
  }

  if (outcome.changed || ignoredPaths.length > 0) {
    await recordCriticalAudit(
      {
        actorUserId: null,
        clientId: null,
        action: 'scim.user_updated',
        entityType: 'User',
        entityId: user.id,
        metadata: scimAuditMeta(req, {
          via: 'PATCH',
          changes: outcome.changes,
          ignoredPaths,
        }),
      },
      'scim.user_updated',
    );
  }

  sendScim(res, 200, toScimUser(outcome.user));
});

// ---------------------------------------------------------------------------
// PUT /Users/:id — full replace (same mapping as POST/PATCH)
// ---------------------------------------------------------------------------

scimRouter.put('/Users/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user) {
    scimError(res, 404, 'User not found.');
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const userName =
    typeof body.userName === 'string' ? normalizeEmail(body.userName) : '';
  if (!userName || !EMAIL_RE.test(userName) || userName.length > 254) {
    scimError(
      res,
      400,
      'userName is required and must be an email address.',
      'invalidValue',
    );
    return;
  }

  const desired: DesiredChanges = { userName };

  if (body.active !== undefined) {
    const coerced = coerceActive(body.active);
    if (coerced === null) {
      scimError(res, 400, 'active must be a boolean.', 'invalidValue');
      return;
    }
    desired.active = coerced;
  }

  // Pragmatic replace: attributes the IdP omits are left unchanged rather
  // than cleared. Strict RFC clearing would wipe externalId every time an
  // IdP PUTs a partial document, which breaks its own correlation.
  if (body.externalId !== undefined) {
    if (body.externalId === null) {
      desired.externalId = null;
    } else if (typeof body.externalId !== 'string' || body.externalId.length > 255) {
      scimError(res, 400, 'externalId must be a string.', 'invalidValue');
      return;
    } else {
      desired.externalId = body.externalId;
    }
  }

  const requestedRole = parseRequestedRole(body);
  if (requestedRole !== null) {
    if ('error' in requestedRole) {
      scimError(res, 400, requestedRole.error, 'invalidValue');
      return;
    }
    desired.role = requestedRole.role;
  }

  const outcome = await applyChanges(user, desired);
  if (!outcome.ok) {
    scimError(res, outcome.status, outcome.detail, outcome.scimType);
    return;
  }

  if (outcome.changed) {
    await recordCriticalAudit(
      {
        actorUserId: null,
        clientId: null,
        action: 'scim.user_updated',
        entityType: 'User',
        entityId: user.id,
        metadata: scimAuditMeta(req, { via: 'PUT', changes: outcome.changes }),
      },
      'scim.user_updated',
    );
  }

  sendScim(res, 200, toScimUser(outcome.user));
});

// ---------------------------------------------------------------------------
// DELETE /Users/:id — soft-deprovision
// ---------------------------------------------------------------------------

scimRouter.delete('/Users/:id', async (req, res) => {
  const user = await loadUser(req.params.id);
  if (!user) {
    scimError(res, 404, 'User not found.');
    return;
  }

  // Soft-deprovision, never a row delete: DISABLED + tokenVersion bump so
  // every live session dies now, while audit history / payroll authorship /
  // signatures keep their anchor row. See header comment.
  if (user.status !== 'DISABLED') {
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'DISABLED', tokenVersion: { increment: 1 } },
    });
    invalidateUserCache(user.id);

    await recordCriticalAudit(
      {
        actorUserId: null,
        clientId: null,
        action: 'scim.user_deprovisioned',
        entityType: 'User',
        entityId: user.id,
        metadata: scimAuditMeta(req, {
          email: user.email,
          status: { from: user.status, to: 'DISABLED' },
        }),
      },
      'scim.user_deprovisioned',
    );
  }
  // Idempotent: a retry against an already-DISABLED user is a 204 no-op.
  res.status(204).end();
});
