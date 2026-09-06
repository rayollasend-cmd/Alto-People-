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
import { orgDateKey, utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';

/**
 * Client portal overview — "the Walmart view."
 *
 * The invariants under test are the ones a partner-facing surface lives
 * or dies by:
 *   - hard tenant isolation (client A never sees a byte of client B);
 *   - NO pay or bill rates anywhere in the payload;
 *   - DRAFT statements and unpublished shifts are invisible;
 *   - admin preview (?clientId=) works for view:executive/manage:org
 *     and is IGNORED for CLIENT_PORTAL callers.
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
  if (r.status !== 200) throw new Error(`loginAs failed: ${r.status}`);
  return a;
}

const HOUR = 3600_000;

async function seedStore() {
  const clientA = await createClient('Front Beach 218');
  const clientB = await createClient('Destin 4411');
  const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const b1 = await createAssociate({ firstName: 'Zed', lastName: 'OtherStore' });
  const now = new Date();

  // Time anchors that hold at ANY run hour (the first CI run at ~7pm EST
  // proved that now+29h can slide past "tomorrow"): shifts that must be
  // TODAY start exactly at `now` (always inside [todayStart, tomorrowStart)),
  // and tomorrow's trio anchors to ORG-local tomorrow NOON, so noon+0..+9h
  // stays inside tomorrow's window whatever wall clock CI runs at.
  const todayKey = orgDateKey(now);
  const dayKeyPlus = (key: string, days: number) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
  };
  const tomorrowNoon = new Date(
    utcInstantOfLocalMidnight(dayKeyPlus(todayKey, 1), 'America/New_York').getTime() +
      12 * HOUR,
  );

  // Today at A: one live shift (Maria, clocked in), one OPEN, one DRAFT
  // (must stay invisible).
  const liveShift = await prisma.shift.create({
    data: {
      clientId: clientA.id,
      assignedAssociateId: a1.id,
      position: 'Stocker',
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR),
      status: 'ASSIGNED',
      publishedAt: now,
      acknowledgedAt: now,
    },
  });
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      position: 'Cashier',
      startsAt: now,
      endsAt: new Date(now.getTime() + 4 * HOUR),
      status: 'OPEN',
      publishedAt: now,
    },
  });
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      position: 'GhostDraft',
      startsAt: now,
      endsAt: new Date(now.getTime() + 4 * HOUR),
      status: 'OPEN',
      publishedAt: null,
    },
  });
  // Tomorrow at A: confirmed + unconfirmed + open.
  const tmr = (h: number) => new Date(tomorrowNoon.getTime() + h * HOUR);
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      assignedAssociateId: a1.id,
      position: 'Stocker',
      startsAt: tmr(0),
      endsAt: tmr(4),
      status: 'ASSIGNED',
      publishedAt: now,
      acknowledgedAt: now,
    },
  });
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      assignedAssociateId: a1.id,
      position: 'Stocker',
      startsAt: tmr(5),
      endsAt: tmr(9),
      status: 'ASSIGNED',
      publishedAt: now,
    },
  });
  await prisma.shift.create({
    data: {
      clientId: clientA.id,
      position: 'Cashier',
      startsAt: tmr(1),
      endsAt: tmr(5),
      status: 'OPEN',
      publishedAt: now,
    },
  });
  // Client B's world — none of this may leak into A's payload.
  await prisma.shift.create({
    data: {
      clientId: clientB.id,
      assignedAssociateId: b1.id,
      position: 'ZedOnlyPosition',
      startsAt: new Date(now.getTime() - HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR),
      status: 'ASSIGNED',
      publishedAt: now,
    },
  });

  // Maria is on the floor right now.
  await prisma.timeEntry.create({
    data: {
      associateId: a1.id,
      clientId: clientA.id,
      shiftId: liveShift.id,
      clockInAt: new Date(now.getTime() - HOUR),
      status: 'ACTIVE',
    },
  });

  // Statements: one FINAL (paid), one FINAL (due), one DRAFT (invisible).
  const period = (offsetDays: number) => {
    const d = new Date(now.getTime() - offsetDays * 24 * HOUR);
    return d;
  };
  await prisma.clientStatement.create({
    data: {
      clientId: clientA.id,
      periodStart: period(21),
      periodEnd: period(15),
      number: 101,
      status: 'FINAL',
      finalizedAt: period(14),
      paidAt: period(7),
      snapshot: { totals: { amount: 4242.5, hours: 200, regularHours: 190, otHours: 10 } },
    },
  });
  await prisma.clientStatement.create({
    data: {
      clientId: clientA.id,
      periodStart: period(14),
      periodEnd: period(8),
      number: 102,
      status: 'FINAL',
      finalizedAt: period(7),
      snapshot: { totals: { amount: 1234.56, hours: 60, regularHours: 60, otHours: 0 } },
    },
  });
  await prisma.clientStatement.create({
    data: {
      clientId: clientA.id,
      periodStart: period(7),
      periodEnd: period(1),
      status: 'DRAFT',
      snapshot: { totals: { amount: 999999, hours: 1, regularHours: 1, otHours: 0 } },
    },
  });

  // Coverage: one unexcused no-show, one EXCUSED late (invisible), and an
  // approved replacement claim this week.
  await prisma.attendanceEvent.create({
    data: {
      associateId: a1.id,
      clientId: clientA.id,
      kind: 'NO_CALL_NO_SHOW',
      points: 4,
      occurredOn: now,
    },
  });
  await prisma.attendanceEvent.create({
    data: {
      associateId: a1.id,
      clientId: clientA.id,
      kind: 'LATE',
      points: 1,
      occurredOn: now,
      excusedAt: now,
    },
  });
  // The replaced shift lives in the PAST so it can never bleed into the
  // exact tomorrow-count assertions above.
  const claimShift = await prisma.shift.create({
    data: {
      clientId: clientA.id,
      position: 'Cashier',
      startsAt: new Date(now.getTime() - 26 * HOUR),
      endsAt: new Date(now.getTime() - 22 * HOUR),
      status: 'COMPLETED',
      assignedAssociateId: a1.id,
      publishedAt: now,
    },
  });
  await prisma.openShiftClaim.create({
    data: {
      shiftId: claimShift.id,
      associateId: a1.id,
      status: 'APPROVED',
      decidedAt: now,
    },
  });

  const { user: portalUser } = await createUser({
    role: 'CLIENT_PORTAL',
    clientId: clientA.id,
  });
  return { clientA, clientB, portalUser };
}

describe('GET /client-portal/overview', () => {
  it('serves the client its own live view — and nothing from other tenants', async () => {
    const { clientA, clientB, portalUser } = await seedStore();
    const res = await (await loginAs(portalUser.email)).get('/client-portal/overview');
    expect(res.status).toBe(200);
    expect(res.body.client).toEqual({ id: clientA.id, name: 'Front Beach 218' });

    // Live floor: Maria, by name.
    expect(res.body.now.onFloor).toHaveLength(1);
    expect(res.body.now.onFloor[0].name).toBe('Maria Lopez');

    // Today's roster: the live shift + the OPEN + the claim shift; the
    // DRAFT stays invisible.
    const positions = res.body.today.roster.map((r: { position: string }) => r.position);
    expect(positions).not.toContain('GhostDraft');
    expect(res.body.today.open).toBeGreaterThanOrEqual(1);
    const live = res.body.today.roster.find(
      (r: { state: string }) => r.state === 'on-floor',
    );
    expect(live?.name).toBe('Maria Lopez');

    // Tomorrow: 1 confirmed, 1 awaiting, 1 open.
    expect(res.body.tomorrow).toEqual({ confirmed: 1, unconfirmed: 1, open: 1 });

    // Statements: FINAL only, newest first, totals surfaced, DRAFT hidden.
    expect(res.body.statements).toHaveLength(2);
    expect(res.body.statements[0].number).toBe(102);
    expect(res.body.statements[0].paidAt).toBeNull();
    expect(res.body.statements[0].amount).toBe(1234.56);
    expect(res.body.statements[1].paidAt).not.toBeNull();

    // Coverage: the excused late is invisible; the replacement counts.
    expect(res.body.coverage.noCallNoShows).toBe(1);
    expect(res.body.coverage.lates).toBe(0);
    expect(res.body.coverage.replacementsFound).toBe(1);

    // Tenant isolation + rate hygiene, checked on the RAW payload.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('ZedOnlyPosition');
    expect(raw).not.toContain('OtherStore');
    expect(raw).not.toContain(clientB.id);
    expect(raw).not.toContain('payRate');
    expect(raw).not.toContain('billRate');
    expect(raw).not.toContain('hourlyRate');

    // Week shape is always the full org week.
    expect(res.body.week.days).toHaveLength(7);
    expect(res.body.week.filled).toBeGreaterThanOrEqual(1);
  });

  it('ignores ?clientId= from CLIENT_PORTAL callers (always clamped to their own)', async () => {
    const { clientA, clientB, portalUser } = await seedStore();
    const res = await (await loginAs(portalUser.email)).get(
      `/client-portal/overview?clientId=${clientB.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.client.id).toBe(clientA.id);
  });

  it('fails closed for a portal account with no client on file', async () => {
    const { user } = await createUser({ role: 'CLIENT_PORTAL' });
    const res = await (await loginAs(user.email)).get('/client-portal/overview');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('no_client_assigned');
  });

  it('rejects roles without portal or preview rights', async () => {
    const associate = await createAssociate();
    const { user } = await createUser({
      role: 'ASSOCIATE',
      email: associate.email,
      associateId: associate.id,
    });
    const res = await (await loginAs(user.email)).get('/client-portal/overview');
    expect(res.status).toBe(403);
  });

  it('lets admins preview any client via ?clientId= — and demands the param', async () => {
    const { clientB } = await seedStore();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(admin.email);

    const missing = await agent.get('/client-portal/overview');
    expect(missing.status).toBe(400);

    const res = await agent.get(`/client-portal/overview?clientId=${clientB.id}`);
    expect(res.status).toBe(200);
    expect(res.body.client.id).toBe(clientB.id);
    expect(res.body.client.name).toBe('Destin 4411');
  });
});
