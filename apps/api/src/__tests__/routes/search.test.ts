import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { createAssociate, createClient, createUser, DEFAULT_TEST_PASSWORD, prisma, truncateAll } from '../../../test/db.js';

/**
 * Universal search: one query, every record kind — and, the part worth
 * guarding, every group behind the capability that gates its page.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(createApp());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

async function seedDestin() {
  const client = await createClient('Destin Grocery');
  const store = await prisma.location.create({ data: { clientId: client.id, name: 'Destin Commons', city: 'Destin', state: 'FL' } });
  const associate = await createAssociate({ firstName: 'Dee', lastName: 'Destinova', email: 'dee@example.com' });
  const application = await prisma.application.create({
    data: { associateId: associate.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', position: 'Overnight Stocker' },
  });
  const shift = await prisma.shift.create({
    data: {
      clientId: client.id,
      position: 'Destin Overnight',
      startsAt: new Date(Date.now() + 24 * 3600_000),
      endsAt: new Date(Date.now() + 32 * 3600_000),
      status: 'OPEN',
    },
  });
  const doc = await prisma.documentRecord.create({
    data: { associateId: associate.id, kind: 'ID', s3Key: 'test/destin-license.png', filename: 'destin-license.png', mimeType: 'image/png', size: 10, status: 'UPLOADED' },
  });
  const statement = await prisma.clientStatement.create({
    data: {
      clientId: client.id,
      periodStart: new Date('2026-09-05T00:00:00Z'),
      periodEnd: new Date('2026-09-11T00:00:00Z'),
      status: 'DRAFT',
      snapshot: { totals: { amount: 100, hours: 5, regularHours: 5, otHours: 0 } },
    },
  });
  const article = await prisma.kbArticle.create({
    data: { title: 'Destin store opening checklist', slug: 'destin-opening', body: 'x', category: 'Stores', status: 'PUBLISHED', publishedAt: new Date() },
  });
  await prisma.kbArticle.create({
    data: { title: 'Destin draft (unpublished)', slug: 'destin-draft', body: 'x', category: 'Stores', status: 'DRAFT' },
  });
  return { client, store, associate, application, shift, doc, statement, article };
}

const kinds = (body: { groups: { kind: string }[] }) => body.groups.map((g) => g.kind);

describe('GET /search', () => {
  it('finds every kind for someone who may see everything, with a place to land', async () => {
    const seed = await seedDestin();
    const a = await loginAs((await createUser({ role: 'HR_ADMINISTRATOR' })).user.email);
    const res = await a.get('/search?q=destin');
    expect(res.status).toBe(200);
    expect(kinds(res.body)).toEqual(['people', 'clients', 'locations', 'applications', 'shifts', 'documents', 'statements', 'help']);
    const by = (kind: string) => res.body.groups.find((g: { kind: string }) => g.kind === kind).hits;
    expect(by('people')[0].href).toBe(`/people?associateId=${seed.associate.id}`);
    expect(by('clients')[0].href).toBe(`/clients/${seed.client.id}`);
    expect(by('locations')[0].hint).toBe('Destin Grocery');
    expect(by('applications')[0].href).toBe(`/onboarding/applications/${seed.application.id}`);
    expect(by('applications')[0].hint).toContain('Overnight Stocker');
    expect(by('shifts')[0].href).toContain(`client=${seed.client.id}`);
    expect(by('documents')[0].href).toBe(`/people?associateId=${seed.associate.id}&tab=documents`);
    expect(by('statements')[0].href).toBe(`/clients/statements?statement=${seed.statement.id}`);
    // Only the published article; the draft never surfaces.
    expect(by('help')).toHaveLength(1);
    expect(by('help')[0].href).toBe('/help-center?article=destin-opening');
  });

  it('shows an associate only the help center', async () => {
    await seedDestin();
    const a = await loginAs((await createUser({ role: 'ASSOCIATE' })).user.email);
    const res = await a.get('/search?q=destin');
    expect(res.status).toBe(200);
    expect(kinds(res.body)).toEqual(['help']);
  });

  it('narrows a signed-in associate to their own records', async () => {
    const seed = await seedDestin();
    const dee = await loginAs((await createUser({ role: 'ASSOCIATE', associateId: seed.associate.id })).user.email);
    const res = await dee.get('/search?q=destin');
    expect(res.status).toBe(200);
    // Their own application and file; the shift is unassigned, and the
    // roster, clients and statements are not theirs to search.
    expect(kinds(res.body)).toEqual(['applications', 'documents', 'help']);
    // Someone else's application stays out of reach even when it matches.
    const other = await createAssociate({ firstName: 'Destiny', lastName: 'Other', email: 'destiny@example.com' });
    await prisma.application.create({
      data: { associateId: other.id, clientId: seed.client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', position: 'Destin Cashier' },
    });
    const again = await dee.get('/search?q=destin');
    expect(again.body.groups.find((g: { kind: string }) => g.kind === 'applications').hits).toHaveLength(1);
  });

  it('clamps a client-bound account to its own client', async () => {
    await seedDestin();
    const other = await createClient('Other Grocery');
    // A store account and a shift supervisor at another client hold the
    // scheduling and onboarding capabilities, but Destin is not theirs.
    const portal = await loginAs((await createUser({ role: 'CLIENT_PORTAL', clientId: other.id })).user.email);
    expect(kinds((await portal.get('/search?q=destin')).body)).toEqual(['help']);
    const supervisor = await loginAs((await createUser({ role: 'SHIFT_SUPERVISOR', clientId: other.id })).user.email);
    expect(kinds((await supervisor.get('/search?q=destin')).body)).toEqual(['help']);
  });

  it('needs two characters, a session, and drops empty groups', async () => {
    await seedDestin();
    expect((await request(createApp()).get('/search?q=destin')).status).toBe(401);
    const a = await loginAs((await createUser({ role: 'HR_ADMINISTRATOR' })).user.email);
    expect((await a.get('/search?q=d')).status).toBe(400);
    const none = await a.get('/search?q=zzzzzz');
    expect(none.status).toBe(200);
    expect(none.body.groups).toEqual([]);
  });
});
