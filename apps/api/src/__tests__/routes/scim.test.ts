import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import {
  DEFAULT_TEST_PASSWORD,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

const app = () => createApp();

const TOKEN = process.env.SCIM_TOKEN!;
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function authed(r: request.Test): request.Test {
  return r
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Content-Type', 'application/scim+json');
}

describe('SCIM auth gating', () => {
  it('returns 503 with a SCIM error body when SCIM_TOKEN is unset', async () => {
    // env is parsed once at module load; the router reads env.SCIM_TOKEN
    // per-request, so temporarily blanking the parsed value simulates an
    // unconfigured deployment.
    const saved = env.SCIM_TOKEN;
    (env as { SCIM_TOKEN?: string }).SCIM_TOKEN = undefined;
    try {
      const res = await authed(request(app()).get('/scim/v2/Users'));
      expect(res.status).toBe(503);
      expect(res.body.schemas).toEqual([ERROR_SCHEMA]);
      expect(res.body.status).toBe('503');
    } finally {
      (env as { SCIM_TOKEN?: string }).SCIM_TOKEN = saved;
    }
  });

  it('returns 401 for a bad token and for a missing header', async () => {
    const bad = await request(app())
      .get('/scim/v2/Users')
      .set('Authorization', 'Bearer definitely-not-the-scim-token-000000');
    expect(bad.status).toBe(401);
    expect(bad.body.schemas).toEqual([ERROR_SCHEMA]);

    const missing = await request(app()).get('/scim/v2/Users');
    expect(missing.status).toBe(401);
  });

  it('serves ServiceProviderConfig with the advertised feature set', async () => {
    const res = await authed(request(app()).get('/scim/v2/ServiceProviderConfig'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/scim+json');
    expect(res.body.patch).toEqual({ supported: true });
    expect(res.body.bulk.supported).toBe(false);
    expect(res.body.filter.supported).toBe(true);
    expect(res.body.sort.supported).toBe(false);
  });
});

describe('POST /scim/v2/Users → GET → filter roundtrip', () => {
  it('creates an INVITED user, reads it back by id and by userName filter', async () => {
    const create = await authed(request(app()).post('/scim/v2/Users')).send({
      schemas: [USER_SCHEMA],
      userName: 'Provisioned.User@Example.com',
      externalId: 'entra-obj-123',
      active: true,
      // Entra's default mappings include a random password; it must be
      // silently dropped, never stored.
      password: 'IdP-Minted-Secret-1!',
    });
    expect(create.status).toBe(201);
    expect(create.headers['content-type']).toContain('application/scim+json');
    expect(create.body.schemas).toEqual([USER_SCHEMA]);
    // Email is normalized to lowercase like every other entry point.
    expect(create.body.userName).toBe('provisioned.user@example.com');
    expect(create.body.externalId).toBe('entra-obj-123');
    // No credential yet → INVITED, so active reads false until the person
    // accepts an invite. And no password may have been persisted.
    expect(create.body.active).toBe(false);
    const id = create.body.id as string;

    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('INVITED');
    expect(row.role).toBe('ASSOCIATE');
    expect(row.passwordHash).toBeNull();
    expect(row.scimExternalId).toBe('entra-obj-123');

    // Creation is audited with the SCIM integration as actor (no user id).
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'scim.user_created', entityId: id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBeNull();
    expect((audit!.metadata as { actor?: string }).actor).toBe('scim');

    const single = await authed(request(app()).get(`/scim/v2/Users/${id}`));
    expect(single.status).toBe(200);
    expect(single.body.id).toBe(id);
    expect(single.body.userName).toBe('provisioned.user@example.com');

    // Entra's reconciliation filter.
    const filtered = await authed(
      request(app()).get(
        `/scim/v2/Users?filter=${encodeURIComponent('userName eq "provisioned.user@example.com"')}`,
      ),
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.schemas).toEqual([LIST_SCHEMA]);
    expect(filtered.body.totalResults).toBe(1);
    expect(filtered.body.Resources[0].id).toBe(id);
  });

  it('409s a duplicate userName with the SCIM uniqueness error', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const res = await authed(request(app()).post('/scim/v2/Users')).send({
      schemas: [USER_SCHEMA],
      userName: user.email.toUpperCase(),
    });
    expect(res.status).toBe(409);
    expect(res.body.schemas).toEqual([ERROR_SCHEMA]);
    expect(res.body.status).toBe('409');
    expect(res.body.scimType).toBe('uniqueness');
  });

  it('400s an unknown role and the SCIM-forbidden roles', async () => {
    const unknown = await authed(request(app()).post('/scim/v2/Users')).send({
      userName: 'role-test@example.com',
      roles: [{ value: 'SUPER_ADMIN' }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.schemas).toEqual([ERROR_SCHEMA]);

    for (const forbidden of ['LIVE_ASN', 'CLIENT_PORTAL']) {
      const res = await authed(request(app()).post('/scim/v2/Users')).send({
        userName: 'role-test@example.com',
        roles: [{ value: forbidden }],
      });
      expect(res.status).toBe(400);
      expect(res.body.detail).toContain(forbidden);
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it('accepts a valid role via roles[0].value', async () => {
    const res = await authed(request(app()).post('/scim/v2/Users')).send({
      userName: 'supervisor@example.com',
      roles: [{ value: 'HR_ADMINISTRATOR' }],
    });
    expect(res.status).toBe(201);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.role).toBe('HR_ADMINISTRATOR');
  });
});

describe('PATCH /scim/v2/Users/:id', () => {
  it('active:false disables, bumps tokenVersion, and kills the live session', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });

    // Establish a real session first so we can prove it dies.
    const login = await request(app())
      .post('/auth/login')
      .send({ email: user.email, password: DEFAULT_TEST_PASSWORD });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeDefined();

    const res = await authed(request(app()).patch(`/scim/v2/Users/${user.id}`)).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      // Entra sends active as a capitalized string — must be coerced.
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DISABLED');
    expect(row.tokenVersion).toBe(user.tokenVersion + 1);

    // The pre-disable cookie must now be rejected.
    const me = await request(app()).get('/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'scim.user_updated', entityId: user.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBeNull();
  });

  it('active:true reactivates a disabled user with a password, but leaves a credential-less user INVITED', async () => {
    const withPassword = (
      await createUser({ role: 'ASSOCIATE', status: 'DISABLED' })
    ).user;
    const reactivate = await authed(
      request(app()).patch(`/scim/v2/Users/${withPassword.id}`),
    ).send({ Operations: [{ op: 'replace', path: 'active', value: true }] });
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.active).toBe(true);

    const noCredential = await prisma.user.create({
      data: { email: 'no-cred@example.com', role: 'ASSOCIATE', status: 'DISABLED' },
    });
    const res = await authed(
      request(app()).patch(`/scim/v2/Users/${noCredential.id}`),
    ).send({ Operations: [{ op: 'replace', path: 'active', value: true }] });
    expect(res.status).toBe(200);
    // No password / passkey → cannot be ACTIVE; parked at INVITED.
    expect(res.body.active).toBe(false);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: noCredential.id } });
    expect(row.status).toBe('INVITED');
  });

  it('ignores unsupported paths with a 200 and audits what was ignored', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const res = await authed(request(app()).patch(`/scim/v2/Users/${user.id}`)).send({
      Operations: [
        { op: 'replace', path: 'displayName', value: 'Noisy Entra Value' },
        { op: 'replace', path: 'externalId', value: 'ext-42' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.externalId).toBe('ext-42');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'scim.user_updated', entityId: user.id },
    });
    expect(audit).not.toBeNull();
    const meta = audit!.metadata as { ignoredPaths?: string[] };
    expect(meta.ignoredPaths).toContain('displayname');
  });

  it('409s a userName change onto an existing email', async () => {
    const { user: a } = await createUser({ role: 'ASSOCIATE' });
    const { user: b } = await createUser({ role: 'ASSOCIATE' });
    const res = await authed(request(app()).patch(`/scim/v2/Users/${a.id}`)).send({
      Operations: [{ op: 'replace', path: 'userName', value: b.email }],
    });
    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe('uniqueness');
  });
});

describe('DELETE /scim/v2/Users/:id', () => {
  it('soft-deprovisions: DISABLED + tokenVersion bump, row survives', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    const res = await authed(request(app()).delete(`/scim/v2/Users/${user.id}`));
    expect(res.status).toBe(204);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.status).toBe('DISABLED');
    expect(row.tokenVersion).toBe(user.tokenVersion + 1);
    expect(row.deletedAt).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'scim.user_deprovisioned', entityId: user.id },
    });
    expect(audit).not.toBeNull();

    // Idempotent retry: still 204, no second tokenVersion bump.
    const again = await authed(request(app()).delete(`/scim/v2/Users/${user.id}`));
    expect(again.status).toBe(204);
    const rowAgain = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(rowAgain.tokenVersion).toBe(user.tokenVersion + 1);
  });

  it('404s an unknown id with a SCIM error body', async () => {
    const res = await authed(
      request(app()).delete('/scim/v2/Users/00000000-0000-4000-8000-000000000000'),
    );
    expect(res.status).toBe(404);
    expect(res.body.schemas).toEqual([ERROR_SCHEMA]);
  });
});

describe('GET /scim/v2/Users — pagination envelope', () => {
  it('returns the SCIM list envelope with startIndex/count paging', async () => {
    for (let i = 0; i < 3; i++) {
      await createUser({ role: 'ASSOCIATE', email: `page-${i}@example.com` });
    }

    const page = await authed(request(app()).get('/scim/v2/Users?startIndex=2&count=1'));
    expect(page.status).toBe(200);
    expect(page.body.schemas).toEqual([LIST_SCHEMA]);
    expect(page.body.totalResults).toBe(3);
    expect(page.body.startIndex).toBe(2);
    expect(page.body.itemsPerPage).toBe(1);
    expect(page.body.Resources).toHaveLength(1);
    // Never leak credentials or PII beyond the mapped attributes.
    const resource = page.body.Resources[0];
    expect(resource.password).toBeUndefined();
    expect(resource.passwordHash).toBeUndefined();

    const all = await authed(request(app()).get('/scim/v2/Users'));
    expect(all.body.itemsPerPage).toBe(3);

    // Unsupported filters are rejected per RFC 7644.
    const badFilter = await authed(
      request(app()).get(
        `/scim/v2/Users?filter=${encodeURIComponent('emails co "example"')}`,
      ),
    );
    expect(badFilter.status).toBe(400);
    expect(badFilter.body.scimType).toBe('invalidFilter');
  });
});
