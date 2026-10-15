import { beforeEach, describe, expect, it } from 'vitest';
import { fakeIdpKeys, fakeSamlResponse, type FakeResponseOpts } from '../../../test/samlFakeIdp.js';
import type { IdentityConnection, PrismaClient } from '@prisma/client';
import { SamlError, acsUrl, samlAuthorizeUrl, samlMetadata, spEntityId, validateSamlResponse } from '../../lib/saml.js';

/**
 * Brief 2-3 step 5 — SAML against a local fake IdP (a real RSA key and
 * X.509 certificate, signed assertions): the CI twin of the Okta/Entra
 * acceptance run. A signed answer to our own request signs in once; an
 * unsigned, wrongly signed, wrong-audience, expired, unsolicited or
 * replayed one is refused. No database: the replay cache is in memory.
 */

const { KEY, CERT, OTHER_KEY } = fakeIdpKeys();

const IDP = 'http://www.okta.com/exk-fake';
const conn = {
  id: '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a',
  tenantId: '00000000-0000-4000-8000-000000000001',
  kind: 'SAML',
  issuerUrl: 'https://acme.okta.test/app/sso/saml',
  clientId: IDP,
  samlIdpCert: CERT,
  allowIdpInitiated: false,
} as IdentityConnection;

/** An in-memory stand-in for the SamlCache table. */
function fakeDb() {
  const rows = new Map<string, { key: string; value: string; expiresAt: Date }>();
  const db = {
    samlCache: {
      upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string; expiresAt: Date } }) => {
        if (!rows.has(where.key)) rows.set(where.key, create);
        return rows.get(where.key);
      },
      findUnique: async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null,
      deleteMany: async ({ where }: { where: { key: string } }) => ({ count: rows.delete(where.key) ? 1 : 0 }),
      create: async ({ data }: { data: { key: string; value: string; expiresAt: Date } }) => {
        if (rows.has(data.key)) throw new Error('unique');
        rows.set(data.key, data);
        return data;
      },
    },
  };
  return { db: db as unknown as PrismaClient, rows };
}

const response = (opts: Omit<FakeResponseOpts, 'idp' | 'key'> & { key?: string }) => fakeSamlResponse(conn, { idp: IDP, ...opts, key: opts.key ?? KEY });

let env: ReturnType<typeof fakeDb>;
beforeEach(() => {
  env = fakeDb();
});

/** Start a sign-in: our AuthnRequest's id, as the cache holds it. */
async function start(): Promise<string> {
  const url = await samlAuthorizeUrl(env.db, conn, '/schedule');
  expect(url.startsWith(conn.issuerUrl)).toBe(true);
  expect(new URL(url).searchParams.get('SAMLRequest')).toBeTruthy();
  const key = [...env.rows.keys()].find((k) => k.startsWith(`req:${conn.id}:`));
  expect(key).toBeDefined();
  return key!.slice(`req:${conn.id}:`.length);
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'accepted';
  } catch (err) {
    return err instanceof SamlError ? err.reason : `unexpected: ${String(err)}`;
  }
};

describe('SAML sign-in against a fake IdP', () => {
  it('a signed answer to our request yields the subject and the email, once', async () => {
    const id = await start();
    const body = response({ inResponseTo: id });
    const ok = await validateSamlResponse(env.db, conn, body);
    expect(ok).toMatchObject({ sub: '00u-ana', email: 'ana@acme.test' });
    // The same response again: its request is spent and its assertion remembered.
    expect(await reason(validateSamlResponse(env.db, conn, body))).toMatch(/unsolicited_or_replayed|replayed_assertion/);
  });

  it('refuses unsigned, wrongly signed, wrong-audience and expired answers', async () => {
    expect(await reason(validateSamlResponse(env.db, conn, response({ inResponseTo: await start(), sign: false })))).not.toBe('accepted');
    expect(await reason(validateSamlResponse(env.db, conn, response({ inResponseTo: await start(), key: OTHER_KEY })))).not.toBe('accepted');
    expect(await reason(validateSamlResponse(env.db, conn, response({ inResponseTo: await start(), audience: 'https://evil.example/sp' })))).not.toBe('accepted');
    expect(await reason(validateSamlResponse(env.db, conn, response({ inResponseTo: await start(), notOnOrAfter: -10 * 60_000 })))).not.toBe('accepted');
  });

  it('refuses an unsolicited (IdP-initiated) answer unless the connection allows it; replay is refused either way', async () => {
    expect(await reason(validateSamlResponse(env.db, conn, response({ inResponseTo: null })))).toBe('unsolicited_or_replayed');
    const open = { ...conn, allowIdpInitiated: true } as IdentityConnection;
    const body = response({ inResponseTo: null, assertionId: '_fixed-assertion' });
    expect(await validateSamlResponse(env.db, open, body)).toMatchObject({ sub: '00u-ana', assertionId: '_fixed-assertion' });
    expect(await reason(validateSamlResponse(env.db, open, body))).toBe('replayed_assertion');
  });

  it('publishes SP metadata with our entity id and ACS URL', () => {
    const xml = samlMetadata(conn);
    expect(xml).toContain(`entityID="${spEntityId(conn)}"`);
    expect(xml).toContain(`Location="${acsUrl(conn)}"`);
  });
});
