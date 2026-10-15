import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';
import { builtInAgentId, ensureBuiltInAgents, resetAgentRateLimits } from '../../lib/agents.js';
import { catalogFixture, runCapabilityFixture, suspendCapability } from '../../lib/agentCapabilities.js';
import { COVERAGE_CREDENTIALS, runCredentialCoverage } from '../../lib/credentialCoverage.js';
import { flushPendingNotifications } from '../../lib/notify.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { invalidateTenantProfile } from '../../lib/tenantProfile.js';
import { orgDateKey, startOfWeekUTC } from '../../lib/timeAnomalies.js';

/**
 * Agent families step 5 — the Compliance agent's coverage.credentials
 * (docs/agent-families-investigation.md §4).
 *
 *   A site requires a credential; once a week the agent measures who placed
 *   there holds it current, records the week, puts the gap on the desk and
 *   asks each person missing it, in their language. Nothing is required
 *   until someone sets it; a removed requirement is measured no more.
 */

const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
  resetAgentRateLimits();
  invalidateTenantProfile();
});
afterAll(async () => {
  invalidateTenantProfile();
  await prisma.$disconnect();
});

async function world() {
  const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
  await ensureBuiltInAgents(prisma, ALTO_TENANT_ID);
  const workerId = (await builtInAgentId(prisma, 'compliance-agent', ALTO_TENANT_ID))!;
  await prisma.worker.update({ where: { id: workerId }, data: { status: 'ACTIVE' } });
  const hotel = await prisma.site.create({ data: { name: 'The Grand Hotel', clientId: null, timezone: 'America/Chicago' } });
  const people = {
    ana: await createAssociate({ firstName: 'Ana', lastName: 'Current' }),
    ben: await createAssociate({ firstName: 'Ben', lastName: 'Expired' }),
    cy: await createAssociate({ firstName: 'Cy', lastName: 'Never' }),
  };
  for (const p of Object.values(people)) {
    await prisma.associateAssignment.create({ data: { associateId: p.id, locationId: hotel.id, startedAt: new Date(Date.now() - 60 * DAY) } });
  }
  const { user: benUser } = await createUser({ role: 'ASSOCIATE', email: people.ben.email, associateId: people.ben.id });
  await prisma.user.update({ where: { id: benUser.id }, data: { language: 'tr' } });
  await prisma.vaccinationRecord.create({ data: { associateId: people.ana.id, kind: 'TB_TEST', administeredOn: new Date(Date.now() - 100 * DAY), expiresOn: new Date(Date.now() + 200 * DAY) } });
  await prisma.vaccinationRecord.create({ data: { associateId: people.ben.id, kind: 'TB_TEST', administeredOn: new Date(Date.now() - 400 * DAY), expiresOn: new Date(Date.now() - 10 * DAY) } });
  const admin = await loginAs(agent(), hr.email);
  return { hr, workerId, hotel, ...people, benUser, admin };
}

describe('site requirements', () => {
  it('a compliance manager sets one; the target must fit the kind and the site must be this tenant\'s', async () => {
    const w = await world();
    const bad = await w.admin.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', complianceTag: 'FOOD_HANDLER', label: 'Food handler' });
    expect(bad.status).toBe(400);
    const stranger = await w.admin.post('/credential-requirements').send({ locationId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a', kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'TB test' });
    expect(stranger.status).toBe(404);
    const ok = await w.admin.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'TB test' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const list = await w.admin.get('/credential-requirements');
    expect(list.body.requirements).toEqual([expect.objectContaining({ id: ok.body.id, label: 'TB test', place: 'The Grand Hotel', latest: null })]);
    const associate = await loginAs(agent(), w.benUser.email);
    expect((await associate.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'x1' })).status).toBe(403);
  });
});

describe('coverage.credentials', () => {
  it('measures once a week, records it, asks each person missing it in their language, and puts the gap on the desk', async () => {
    const w = await world();
    const req = await w.admin.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'TB test' });
    expect(await runCredentialCoverage(prisma, new Date())).toMatchObject({ measured: 1, gaps: 1, asked: 2 });
    expect(await runCredentialCoverage(prisma, new Date())).toMatchObject({ measured: 0 });
    const week = await prisma.credentialCoverageWeek.findFirstOrThrow({ where: { requirementId: req.body.id } });
    expect(week).toMatchObject({ population: 3, missing: 2 });
    expect((week.missingIds as string[]).sort()).toEqual([w.ben.id, w.cy.id].sort());

    await flushPendingNotifications();
    const asked = await prisma.notification.findFirst({ where: { recipientUserId: w.benUser.id, category: 'compliance.credentials', channel: 'IN_APP' } });
    expect(asked).toMatchObject({ subject: 'The Grand Hotel için gerekli: TB test', linkUrl: '/documents' });

    const items = ((await w.admin.get('/me/decisions')).body.decisions ?? []) as Array<{ key: string; label: string; linkUrl: string }>;
    expect(items.find((d) => d.key === `credentials:gap:${req.body.id}`)).toMatchObject({ label: 'TB test at The Grand Hotel: 2 of 3 without it', linkUrl: '/compliance?tab=requirements' });
    expect((await w.admin.get('/credential-requirements')).body.requirements[0].latest).toMatchObject({ population: 3, missing: 2 });
  });

  it('the scorecard counts the sites below their requirement and the gaps closed since last week', async () => {
    const w = await world();
    const req = await w.admin.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'TB test' });
    const thisWeek = new Date(`${orgDateKey(startOfWeekUTC(new Date()))}T00:00:00Z`);
    const extra = await createAssociate({ firstName: 'Dee', lastName: 'Fixed' });
    await prisma.credentialCoverageWeek.create({ data: { requirementId: req.body.id, weekOf: new Date(thisWeek.getTime() - 7 * DAY), population: 4, missing: 3, missingIds: [w.ben.id, w.cy.id, extra.id] } });
    await runCredentialCoverage(prisma, new Date());
    const sc = await w.admin.get(`/agents/${w.workerId}/capabilities/${COVERAGE_CREDENTIALS}/scorecard?days=14`);
    expect(sc.status, JSON.stringify(sc.body)).toBe(200);
    expect(sc.body.metrics).toMatchObject({ sitesBelowRequirement: 1, gapsClosed: 1 });
  });

  it('nothing required, nothing measured; removed, measured no more; suspended, nothing at all', async () => {
    const w = await world();
    expect(await runCredentialCoverage(prisma, new Date())).toMatchObject({ measured: 0, asked: 0 });
    const req = await w.admin.post('/credential-requirements').send({ locationId: w.hotel.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', label: 'TB test' });
    expect((await w.admin.delete(`/credential-requirements/${req.body.id}`)).status).toBe(204);
    expect(await runCredentialCoverage(prisma, new Date())).toMatchObject({ measured: 0 });
    await suspendCapability(prisma, w.workerId, COVERAGE_CREDENTIALS, ALTO_TENANT_ID, w.hr.id, 'Checking the targets');
    expect(await runCredentialCoverage(prisma, new Date())).toMatchObject({ skipped: 'capability_off' });
  });

  it('the catalog fixture runs through the real read and passes', async () => {
    const fixture = catalogFixture(COVERAGE_CREDENTIALS, 'A hotel requires a TB test: one current, one expired, one never tested; two are missing it')!;
    const r = await runCapabilityFixture(COVERAGE_CREDENTIALS, fixture, new Date());
    expect(r, JSON.stringify(r)).toMatchObject({ passed: true, reason: null });
  });
});
