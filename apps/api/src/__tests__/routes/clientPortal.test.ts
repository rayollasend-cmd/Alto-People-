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
    expect(res.body.tomorrow).toEqual({ confirmed: 1, unconfirmed: 1, open: 1, coverInFlight: 0 });

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

describe('the store site — scope, targets, evidence, downloads', () => {
  async function seedTwoStores() {
    const client = await createClient('Walmart 218');
    // createClient seeds one default Location named after the client; a
    // second store makes the client a "market".
    const [storeA] = await prisma.location.findMany({ where: { clientId: client.id } });
    const storeB = await prisma.location.create({
      data: { clientId: client.id, name: 'Walmart 4411', city: 'Destin', state: 'FL' },
    });
    const other = await createClient('Target 9');
    const [otherStore] = await prisma.location.findMany({ where: { clientId: other.id } });
    const a1 = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
    const a2 = await createAssociate({ firstName: 'Ben', lastName: 'Okafor' });
    const now = new Date();

    const shiftA = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: storeA!.id,
        assignedAssociateId: a1.id,
        position: 'StoreAOnly',
        startsAt: now,
        endsAt: new Date(now.getTime() + 4 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
        acknowledgedAt: now,
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: storeB.id,
        assignedAssociateId: a2.id,
        position: 'StoreBOnly',
        startsAt: now,
        endsAt: new Date(now.getTime() + 4 * HOUR),
        status: 'ASSIGNED',
        publishedAt: now,
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        locationId: storeA!.id,
        shiftId: shiftA.id,
        clockInAt: new Date(now.getTime() - HOUR),
        status: 'ACTIVE',
      },
    });
    // Contracted headcount for store A: 3 on the floor at any hour.
    await prisma.staffingTarget.create({
      data: { locationId: storeA!.id, targetCount: 3, effectiveFrom: new Date('2020-01-01') },
    });
    // Alto's lead at this client: a shift supervisor with a phone on file.
    const sup = await createAssociate({ firstName: 'Dana', lastName: 'Reyes' });
    await prisma.associate.update({ where: { id: sup.id }, data: { phone: '850-555-0101' } });
    await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
      associateId: sup.id,
      email: 'dana.reyes@alto.example',
    });
    // Crew clearance: Maria fully cleared, Ben's background check in flight.
    await prisma.i9Verification.create({
      data: { associateId: a1.id, section1CompletedAt: now, section2CompletedAt: now },
    });
    await prisma.backgroundCheck.create({
      data: { associateId: a1.id, provider: 'checkr', status: 'PASSED' },
    });
    await prisma.backgroundCheck.create({
      data: { associateId: a2.id, provider: 'checkr', status: 'IN_PROGRESS' },
    });
    // A FINAL statement with per-store lines.
    const statement = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 14 * 24 * HOUR),
        periodEnd: new Date(now.getTime() - 8 * 24 * HOUR),
        number: 7,
        status: 'FINAL',
        finalizedAt: now,
        snapshot: {
          clientName: 'Walmart 218',
          periodStart: '2026-01-03',
          periodEnd: '2026-01-09',
          lines: [{ label: 'Associate', hours: 100, rate: 21.21, amount: 2121 }],
          stores: [
            { locationName: storeA!.name, hours: 60, amount: 1272.6 },
            { locationName: 'Walmart 4411', hours: 40, amount: 848.4 },
          ],
          totals: { hours: 100, regularHours: 100, otHours: 0, amount: 2121 },
          sla: {
            publishedShifts: 20,
            assignedShifts: 20,
            fillRatePct: 100,
            punctualPct: 100,
            noShows: 0,
            pendingEntries: 0,
          },
        },
      },
    });
    const draft = await prisma.clientStatement.create({
      data: {
        clientId: client.id,
        periodStart: new Date(now.getTime() - 7 * 24 * HOUR),
        periodEnd: new Date(now.getTime() - 1 * 24 * HOUR),
        status: 'DRAFT',
        snapshot: { totals: { amount: 1, hours: 1, regularHours: 1, otHours: 0 } },
      },
    });

    const { user: storeUser } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    await prisma.user.update({ where: { id: storeUser.id }, data: { locationId: storeA!.id } });
    const { user: marketUser } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    return {
      client,
      storeA: storeA!,
      storeB,
      other,
      otherStore: otherStore!,
      storeUser,
      marketUser,
      statement,
      draft,
    };
  }

  it('pins a store account to its store and rolls the client up for a market account', async () => {
    const s = await seedTwoStores();

    // The store manager: one store, its target, its people — nothing from
    // the sister store.
    const store = await (await loginAs(s.storeUser.email)).get('/client-portal/overview');
    expect(store.status).toBe(200);
    expect(store.body.store.id).toBe(s.storeA.id);
    expect(store.body.stores).toEqual([]);
    expect(store.body.now.onFloor).toHaveLength(1);
    expect(store.body.now.target).toBe(3);
    const storePositions = store.body.today.roster.map((r: { position: string }) => r.position);
    expect(storePositions).toContain('StoreAOnly');
    expect(storePositions).not.toContain('StoreBOnly');
    expect(JSON.stringify(store.body)).not.toContain('Okafor');
    // Statement shows the store's share alongside the client total.
    expect(store.body.statements[0].storeHours).toBe(60);
    expect(store.body.statements[0].amount).toBe(2121);
    // A store account cannot widen itself to the sister store.
    const widened = await (await loginAs(s.storeUser.email)).get(
      `/client-portal/overview?locationId=${s.storeB.id}`,
    );
    expect(widened.body.store.id).toBe(s.storeA.id);

    // The market manager: the whole client with a per-store strip, and
    // the right to drill into one of their OWN stores.
    const market = await (await loginAs(s.marketUser.email)).get('/client-portal/overview');
    expect(market.status).toBe(200);
    expect(market.body.store).toBeNull();
    expect(market.body.stores).toHaveLength(2);
    const strip = market.body.stores.find((x: { id: string }) => x.id === s.storeA.id);
    expect(strip.onFloor).toBe(1);
    expect(market.body.today.roster).toHaveLength(2);
    const drilled = await (await loginAs(s.marketUser.email)).get(
      `/client-portal/overview?locationId=${s.storeB.id}`,
    );
    expect(drilled.body.store.id).toBe(s.storeB.id);
    expect(drilled.body.today.roster.map((r: { position: string }) => r.position)).toEqual([
      'StoreBOnly',
    ]);
    // …but never into another tenant's store.
    const foreign = await (await loginAs(s.marketUser.email)).get(
      `/client-portal/overview?locationId=${s.otherStore.id}`,
    );
    expect(foreign.status).toBe(404);
  });

  it('answers the store manager: lead on site, clearance, reliability, safety, evidence', async () => {
    const s = await seedTwoStores();
    const res = await (await loginAs(s.marketUser.email)).get('/client-portal/overview');
    expect(res.status).toBe(200);

    // The Alto lead — name and phone, never an email as a name.
    expect(res.body.leads.people).toHaveLength(1);
    expect(res.body.leads.people[0].name).toBe('Dana Reyes');
    expect(res.body.leads.people[0].phone).toBe('850-555-0101');

    // Clearance is counts only: 2 on the crew, 1 I-9 complete, 1 check in flight.
    expect(res.body.clearance).toEqual({ total: 2, i9Complete: 1, checksInFlight: 1, flagged: 0 });

    // Reliability: 4 completed weeks + this one; this week has 2 filled shifts.
    expect(res.body.reliability.weeks).toHaveLength(5);
    const current = res.body.reliability.weeks.find((w: { current: boolean }) => w.current);
    expect(current.filled).toBe(2);
    expect(current.total).toBe(2);
    // The grade is the showed-up rate: assigned minus no-call no-shows,
    // over everything published. No history yet, so this week stands in.
    expect(current.reliabilityPct).toBe(100);
    expect(res.body.reliability).toMatchObject({ grade: 'A', score: 100 });

    // Safety: no incidents ever → 365+ (null) and nothing open.
    expect(res.body.safety).toEqual({ monthIncidents: 0, open: 0, daysSinceLast: null });

    // Evidence: no ops shifts yet → null, not a fake zero.
    expect(res.body.ops).toBeNull();

    // Downloads are addressed to the portal's own routes.
    expect(res.body.serviceReport.url).toMatch(/^\/api\/client-portal\/service-report\.pdf\?week=/);
    expect(res.body.statements[0].pdfUrl).toBe(
      `/api/client-portal/statements/${s.statement.id}.pdf`,
    );

    // Rate hygiene holds on the new payload: the sister tenant's name and
    // every rate word stay out.
    const raw = JSON.stringify(res.body);
    for (const word of ['payRate', 'billRate', 'hourlyRate', '"rate"', 'Target 9']) {
      expect(raw).not.toContain(word);
    }
  });

  it('serves the week schedule and the PDFs, clamped to the tenant', async () => {
    const s = await seedTwoStores();
    const agent = await loginAs(s.storeUser.email);

    const sched = await agent.get('/client-portal/schedule');
    expect(sched.status).toBe(200);
    expect(sched.body.days).toHaveLength(7);
    expect(sched.body.store.id).toBe(s.storeA.id);
    const positions = sched.body.days.flatMap((d: { shifts: { position: string }[] }) =>
      d.shifts.map((x) => x.position),
    );
    expect(positions).toEqual(['StoreAOnly']);
    expect(JSON.stringify(sched.body)).not.toContain('payRate');
    expect((await agent.get('/client-portal/schedule?week=nope')).status).toBe(400);

    const pdf = await agent.get(`/client-portal/statements/${s.statement.id}.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    // Drafts don't exist for the client.
    expect((await agent.get(`/client-portal/statements/${s.draft.id}.pdf`)).status).toBe(404);
    // Another tenant's statement is simply not found.
    const foreignStatement = await prisma.clientStatement.create({
      data: {
        clientId: s.other.id,
        periodStart: new Date(),
        periodEnd: new Date(),
        number: 1,
        status: 'FINAL',
        finalizedAt: new Date(),
        snapshot: { totals: { amount: 5, hours: 1, regularHours: 1, otHours: 0 } },
      },
    });
    expect(
      (await agent.get(`/client-portal/statements/${foreignStatement.id}.pdf`)).status,
    ).toBe(404);

    const report = await agent.get('/client-portal/service-report.pdf');
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('application/pdf');
  });

  it('lets an admin provision the store scope, and the session carries it', async () => {
    const s = await seedTwoStores();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(hr.email);

    // A store from another client is refused.
    const wrong = await admin
      .patch(`/admin/users/${s.marketUser.id}`)
      .send({ locationId: s.otherStore.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('location_not_found');

    const ok = await admin
      .patch(`/admin/users/${s.marketUser.id}`)
      .send({ locationId: s.storeB.id });
    expect(ok.status).toBe(204);
    const me = await (await loginAs(s.marketUser.email)).get('/auth/me');
    expect(me.body.user.locationId).toBe(s.storeB.id);
    expect(me.body.user.locationName).toBe('Walmart 4411');
    const list = await admin.get('/admin/users');
    const row = list.body.users.find((u: { id: string }) => u.id === s.marketUser.id);
    expect(row.locationName).toBe('Walmart 4411');

    // Moving the account to another client drops the store with it.
    const moved = await admin
      .patch(`/admin/users/${s.marketUser.id}`)
      .send({ clientId: s.other.id });
    expect(moved.status).toBe(204);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: s.marketUser.id } });
    expect(after.locationId).toBeNull();
  });
});
