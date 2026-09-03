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
 * OSHA safety tile (scorecard tile 7):
 *   - recordability derived from outcome per 1904.7 (never client-supplied)
 *   - TRIR/DART normalized against real TimeEntry hours
 *   - days-since-last-recordable
 *   - close flow + open-incident actions
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

function incidentBody(associateId: string, overrides: Record<string, unknown> = {}) {
  return {
    associateId,
    occurredAt: new Date(Date.now() - 2 * DAY).toISOString(),
    description: 'Slipped on a wet floor in receiving while unloading pallets.',
    outcome: 'MEDICAL_TREATMENT',
    ...overrides,
  };
}

describe('incident CRUD', () => {
  it('derives recordable from the outcome — never trusts the client', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const medical = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id));
    expect(medical.status).toBe(201);
    expect(medical.body.incident.recordable).toBe(true);
    // Client attribution snapshots the active placement.
    expect(medical.body.incident.clientId).toBe(client.id);

    const nearMiss = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { outcome: 'NEAR_MISS' }));
    expect(nearMiss.status).toBe(201);
    expect(nearMiss.body.incident.recordable).toBe(false);

    const future = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { occurredAt: new Date(Date.now() + DAY).toISOString() }));
    expect(future.status).toBe(400);
  });

  it('closing sets closedAt and re-outcoming re-derives recordable', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { outcome: 'FIRST_AID_ONLY' }));
    const id = created.body.incident.id;

    const upgraded = await a
      .patch(`/compliance-scorecard/safety-incidents/${id}`)
      .send({ outcome: 'RESTRICTED_DUTY', daysRestricted: 5 });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.incident.recordable).toBe(true);
    expect(upgraded.body.incident.daysRestricted).toBe(5);

    const closed = await a
      .patch(`/compliance-scorecard/safety-incidents/${id}`)
      .send({ status: 'CLOSED', closureNotes: 'Returned to full duty; mats installed.' });
    expect(closed.status).toBe(200);
    expect(closed.body.incident.closedAt).not.toBeNull();
    expect(closed.body.incident.closureNotes).toContain('mats');
  });

  it('executive chairman can read the tile but cannot write incidents', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const a = await loginAs(exec.email);

    const read = await a.get('/compliance-scorecard/safety');
    expect(read.status).toBe(200);

    const write = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id));
    expect(write.status).toBe(403);
  });
});

describe('safety tile math', () => {
  it('computes TRIR/DART from real time-entry hours and counts YTD recordables', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // 100 hours worked this year → 1 recordable = TRIR 2000, DART 2000 for
    // a DAYS_AWAY case.
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

    await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { outcome: 'DAYS_AWAY', daysAway: 3 }));

    const res = await a.get('/compliance-scorecard/safety');
    expect(res.status).toBe(200);
    expect(res.body.recordableCountYtd).toBe(1);
    expect(res.body.dartCountYtd).toBe(1);
    expect(res.body.hoursWorkedYtd).toBeCloseTo(100, 0);
    expect(res.body.trir).toBeCloseTo(2000, 0);
    expect(res.body.dart).toBeCloseTo(2000, 0);
    expect(res.body.daysSinceLastRecordable).toBe(2);
    // Open days-away case = critical tile.
    expect(res.body.severity).toBe('critical');
  });

  it('closing the incident clears it from openIncidents and relaxes severity', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    // Attest the annual 300A posting so the only thing driving severity is
    // the incident itself (past Feb 1 the unattested posting is overdue by
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

    const created = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { outcome: 'DAYS_AWAY' }));
    await a
      .patch(`/compliance-scorecard/safety-incidents/${created.body.incident.id}`)
      .send({ status: 'CLOSED' });

    const res = await a.get('/compliance-scorecard/safety');
    expect(res.body.openIncidents).toHaveLength(0);
    // A recordable exists YTD but nothing is open, nothing overdue, and
    // there are no hours yet to push TRIR over target: clean tile.
    expect(res.body.severity).toBe('ok');
  });

  it('scopes to ?clientId=', async () => {
    const clientA = await createClient('Walmart Frontback');
    const clientB = await createClient('Pier Park');
    const assocA = await activeAssociate(clientA.id);
    await activeAssociate(clientB.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    await a.post('/compliance-scorecard/safety-incidents').send(incidentBody(assocA.id));

    const scopedA = await a.get(`/compliance-scorecard/safety?clientId=${clientA.id}`);
    expect(scopedA.body.recordableCountYtd).toBe(1);

    const scopedB = await a.get(`/compliance-scorecard/safety?clientId=${clientB.id}`);
    expect(scopedB.body.recordableCountYtd).toBe(0);
    expect(scopedB.body.daysSinceLastRecordable).toBeNull();
  });
});

describe('actions integration', () => {
  it('an open days-away incident lands in the actions rollup as critical', async () => {
    const client = await createClient();
    const assoc = await activeAssociate(client.id);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const a = await loginAs(hr.email);

    const created = await a
      .post('/compliance-scorecard/safety-incidents')
      .send(incidentBody(assoc.id, { outcome: 'DAYS_AWAY' }));

    const res = await a.get('/compliance-scorecard/actions');
    const saf = res.body.actions.find(
      (x: { id: string }) => x.id === `saf:${created.body.incident.id}`,
    );
    expect(saf).toBeTruthy();
    expect(saf.severity).toBe('critical');
    expect(res.body.score).toBeGreaterThanOrEqual(0);
    expect(res.body.score).toBeLessThanOrEqual(100);
  });
});
