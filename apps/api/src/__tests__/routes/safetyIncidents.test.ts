import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * Scorecard safety tile (tile 7) — reads the Phase 88 OSHA injury log
 * (OshaIncident via /osha/incidents), it does NOT own a second incident
 * store. Covers:
 *   - TRIR/DART normalized against real TimeEntry hours
 *   - days-since-last-recordable
 *   - unresolved incidents driving tile severity + the actions rollup
 *   - client scoping and the executive read-only boundary
 */

const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  if (r.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return a;
}

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;

async function activeAssociate(clientId: string) {
  const associate = await createAssociate();
  await prisma.application.create({
    data: {
      associateId: associate.id,
      clientId,
      onboardingTrack: 'STANDARD',
      status: 'APPROVED',
    },
  });
  return associate;
}

function incidentBody(
  clientId: string,
  associateId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    clientId,
    associateId,
    occurredAt: new Date(Date.now() - 2 * DAY).toISOString(),
    description: 'Slipped on a wet floor in receiving while unloading pallets.',
    severity: 'MEDICAL_TREATMENT',
    ...overrides,
  };
}

describe('safety tile reads the existing OSHA injury log', () => {
  it('computes TRIR/DART from real time-entry hours and counts YTD recordables', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // 100 hours worked this year → 1 recordable = TRIR 2000; DAYS_AWAY
    // also counts toward DART.
    const clockInAt = new Date(Date.now() - 10 * DAY);
    await prisma.timeEntry.create({
      data: {
        associateId: assoc.id,
        clientId: client.id,
        clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + 100 * HOUR),
        status: 'COMPLETED',
      },
    });

    const created = await a
      .post('/osha/incidents')
      .send(incidentBody(client.id, assoc.id, { severity: 'DAYS_AWAY', daysAway: 3 }));
    expect(created.status).toBe(201);

    const res = await a.get('/compliance-scorecard/safety');
    expect(res.status).toBe(200);
    expect(res.body.recordableCountYtd).toBe(1);
    expect(res.body.dartCountYtd).toBe(1);
    expect(res.body.hoursWorkedYtd).toBeCloseTo(100, 0);
    expect(res.body.trir).toBeCloseTo(2000, 0);
    expect(res.body.dart).toBeCloseTo(2000, 0);
    expect(res.body.daysSinceLastRecordable).toBe(2);
    // Unresolved days-away case = critical tile.
    expect(res.body.severity).toBe('critical');
    // The tile surfaces the log's row, same id — one source of truth.
    expect(res.body.openIncidents.map((i: { id: string }) => i.id)).toContain(
      created.body.id,
    );
  });

  it('first-aid cases are not recordable and resolving clears the open list', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Attest the annual 300A posting so the only severity driver left is
    // the incident state (past Feb 1 an unattested posting is overdue by
    // design, same as the insurance attestations).
    const jan1 = `${new Date().getUTCFullYear()}-01-01`;
    const att = await a.post('/compliance-scorecard/attestations').send({
      key: 'OSHA_300A_POSTING',
      periodStart: jan1,
      outcome: 'YES',
      actionTakenAt: new Date().toISOString(),
      notes: null,
      evidenceDocumentId: null,
    });
    expect(att.status).toBe(201);

    const firstAid = await a
      .post('/osha/incidents')
      .send(incidentBody(client.id, assoc.id, { severity: 'FIRST_AID' }));
    expect(firstAid.status).toBe(201);

    let res = await a.get('/compliance-scorecard/safety');
    expect(res.body.recordableCountYtd).toBe(0);
    // Unresolved (but non-recordable) incident = warn, not critical.
    expect(res.body.severity).toBe('warn');

    const resolve = await a
      .put(`/osha/incidents/${firstAid.body.id}`)
      .send({ status: 'RESOLVED', resolutionNote: 'Bandaged on site; mats installed.' });
    expect(resolve.status).toBe(200);

    res = await a.get('/compliance-scorecard/safety');
    expect(res.body.openIncidents).toHaveLength(0);
    expect(res.body.severity).toBe('ok');
  });

  it('scopes to ?clientId=', async () => {
    const clientA = await createClient('Walmart Frontback');
    const clientB = await createClient('Pier Park');
    const assocA = await activeAssociate(clientA.id);
    await activeAssociate(clientB.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    await a.post('/osha/incidents').send(incidentBody(clientA.id, assocA.id));

    const scopedA = await a.get(`/compliance-scorecard/safety?clientId=${clientA.id}`);
    expect(scopedA.body.recordableCountYtd).toBe(1);

    const scopedB = await a.get(`/compliance-scorecard/safety?clientId=${clientB.id}`);
    expect(scopedB.body.recordableCountYtd).toBe(0);
    expect(scopedB.body.daysSinceLastRecordable).toBeNull();
  });

  it('executive chairman can read the tile but cannot write to the injury log', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const a = await loginAs(exec.email);

    const read = await a.get('/compliance-scorecard/safety');
    expect(read.status).toBe(200);

    const write = await a.post('/osha/incidents').send(incidentBody(client.id, assoc.id));
    expect(write.status).toBe(403);
  });
});

describe('actions integration', () => {
  it('an unresolved days-away incident lands in the actions rollup as critical with a fix link', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a
      .post('/osha/incidents')
      .send(incidentBody(client.id, assoc.id, { severity: 'DAYS_AWAY' }));

    const res = await a.get('/compliance-scorecard/actions');
    const saf = res.body.actions.find(
      (x: { id: string }) => x.id === `saf:${created.body.id}`,
    );
    expect(saf).toBeTruthy();
    expect(saf.severity).toBe('critical');
    expect(saf.link).toBe('/compliance/osha');
    expect(res.body.score).toBeGreaterThanOrEqual(0);
    expect(res.body.score).toBeLessThanOrEqual(100);
  });
});
