import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import { flushPendingNotifications } from '../../lib/notify.js';
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
    expect(live?.clockInAt).toBeTruthy();

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
    // Yesterday: Maria worked her shift (punch linked), Ben's shift at the
    // sister store came and went with no punch — a miss with no event.
    // Anchored to ORG-local yesterday noon→4pm: "now − 30h" slides into the
    // day before when CI runs near midnight Eastern.
    const yKey = dayKeyPlus(orgDateKey(now), -1);
    const yStart = new Date(utcInstantOfLocalMidnight(yKey, 'America/New_York').getTime() + 12 * HOUR);
    const yEnd = new Date(yStart.getTime() + 4 * HOUR);
    const workedShift = await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: storeA!.id,
        assignedAssociateId: a1.id,
        position: 'StoreAOnly',
        startsAt: yStart,
        endsAt: yEnd,
        status: 'COMPLETED',
        publishedAt: now,
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: a1.id,
        clientId: client.id,
        locationId: storeA!.id,
        shiftId: workedShift.id,
        clockInAt: yStart,
        clockOutAt: yEnd,
        status: 'APPROVED',
      },
    });
    await prisma.shift.create({
      data: {
        clientId: client.id,
        locationId: storeB.id,
        assignedAssociateId: a2.id,
        position: 'StoreBOnly',
        startsAt: yStart,
        endsAt: yEnd,
        status: 'ASSIGNED',
        publishedAt: now,
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

describe('the store site — scope, targets, evidence, downloads', () => {
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
    // The statement shows this store's share and NOT the client total —
    // that figure is every other store's labour spend — and the whole-
    // client PDF is withheld.
    expect(store.body.statements[0].storeHours).toBe(60);
    expect(store.body.statements[0].storeAmount).toBe(1272.6);
    expect(store.body.statements[0].amount).toBeNull();
    expect(store.body.statements[0].hours).toBeNull();
    expect(store.body.statements[0].pdfUrl).toBeNull();
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
    // Store A grades against its CONTRACT: target 3 for the 4 hours anything
    // was scheduled yesterday, Maria alone on the floor → 4 of 12, F.
    expect(store.body.reliability).toMatchObject({ grade: 'F', score: 33, basis: 'contract' });
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
    // Yesterday may sit in the previous org week (Saturday runs), so sum
    // across the trend rather than pinning one week.
    const weeks = res.body.reliability.weeks as Array<{ filled: number; total: number }>;
    expect(weeks.reduce((a, w) => a + w.filled, 0)).toBe(4);
    expect(weeks.reduce((a, w) => a + w.total, 0)).toBe(4);
    expect(current).toBeTruthy();
    // Market account: only store A has a floor target, so the contract
    // basis grades those hours (4 of 12 → 33%); store B's missed shift
    // shows in the showed-up rate (1 of 2), which is context, not the grade.
    expect(res.body.reliability).toMatchObject({ grade: 'F', score: 33, basis: 'contract' });
    expect(current).toBeTruthy();

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
    // Yesterday's worked shift sits in this week too on most run days.
    expect(positions.length).toBeGreaterThanOrEqual(1);
    expect(positions.every((p: string) => p === 'StoreAOnly')).toBe(true);
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

    // The service report is the portal on paper: today by default, any
    // day by `date`, a span by `from`/`to`, the org week by `week`.
    const report = await agent.get('/client-portal/service-report.pdf');
    expect(report.status).toBe(200);
    expect(report.headers['content-type']).toContain('application/pdf');
    const todayKey = orgDateKey(new Date());
    const yesterdayKey = dayKeyPlus(todayKey, -1);
    const back = await agent.get(`/client-portal/service-report.pdf?date=${yesterdayKey}`);
    expect(back.status).toBe(200);
    expect(back.headers['content-type']).toContain('application/pdf');
    expect(back.headers['content-disposition']).toContain(`-${yesterdayKey}.pdf`);
    const span = await agent.get(`/client-portal/service-report.pdf?from=${dayKeyPlus(todayKey, -6)}&to=${todayKey}`);
    expect(span.status).toBe(200);
    expect(span.headers['content-disposition']).toContain(`${dayKeyPlus(todayKey, -6)}-to-${todayKey}.pdf`);
    expect((await agent.get(`/client-portal/service-report.pdf?week=${yesterdayKey}`)).status).toBe(200);
    expect((await agent.get('/client-portal/service-report.pdf?date=nope')).status).toBe(400);
    expect((await agent.get(`/client-portal/service-report.pdf?from=${dayKeyPlus(todayKey, -40)}&to=${todayKey}`)).status).toBe(400);
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

function dayKeyPlus(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

describe('the historical lenses — a day, and a range', () => {
  it('reads any day from the punch record, store-scoped, and grades a range', async () => {
    const s = await seedTwoStores();
    const yesterday = dayKeyPlus(orgDateKey(new Date()), -1);
    const store = await loginAs(s.storeUser.email);

    // Yesterday at store A: Maria worked (in/out on the row); nothing
    // from the sister store, and no "late" label anywhere.
    const day = await store.get(`/client-portal/day?date=${yesterday}`);
    expect(day.status).toBe(200);
    expect(day.body.date).toBe(yesterday);
    expect(day.body.store.id).toBe(s.storeA.id);
    const worked = day.body.roster.filter((r: { state: string }) => r.state === 'worked');
    expect(worked).toHaveLength(1);
    expect(worked[0].name).toBe('Maria Lopez');
    expect(worked[0].clockInAt).toBeTruthy();
    expect(worked[0].clockOutAt).toBeTruthy();
    expect(day.body.summary).toMatchObject({ expected: 1, worked: 1, missed: 0, open: 0 });
    expect(JSON.stringify(day.body)).not.toContain('Okafor');
    expect(JSON.stringify(day.body).toLowerCase()).not.toContain('late');

    // The market account sees both stores yesterday: Ben's shift came and
    // went with no punch → missed.
    const market = await loginAs(s.marketUser.email);
    const mday = await market.get(`/client-portal/day?date=${yesterday}`);
    expect(mday.body.summary).toMatchObject({ expected: 2, worked: 1, missed: 1 });
    const missed = mday.body.roster.find((r: { state: string }) => r.state === 'missed');
    expect(missed.name).toBe('Ben Okafor');
    expect(missed.clockInAt).toBeNull();

    // Today reads live: Maria is on the floor with a punch time.
    const today = await store.get('/client-portal/day');
    expect(today.body.summary.onFloor).toBe(1);
    expect(today.body.roster[0].state).toBe('on-floor');

    // Bad dates are refused; a foreign store is not found.
    expect((await store.get('/client-portal/day?date=nope')).status).toBe(400);
    expect(
      (await market.get(`/client-portal/day?date=${yesterday}&locationId=${s.otherStore.id}`)).status,
    ).toBe(404);

    // The range: last 7 days for the market account — 2 ended shifts, 1
    // showed → 50%, F; fill counts every published shift in the range.
    const from = dayKeyPlus(yesterday, -6);
    const hist = await market.get(`/client-portal/history?from=${from}&to=${yesterday}`);
    expect(hist.status).toBe(200);
    expect(hist.body.range).toEqual({ from, to: yesterday, days: 7 });
    expect(hist.body.days).toHaveLength(7);
    expect(hist.body.totals).toMatchObject({
      published: 2,
      filled: 2,
      ended: 2,
      showed: 1,
      showedUpPct: 50,
      grade: 'F',
      reliabilityPct: 33,
      basis: 'contract',
      contractedHours: 12,
      deliveredHours: 4,
    });
    expect(hist.body.totals.workedHours).toBe(4);
    expect(hist.body.totals.scheduledHours).toBe(8);
    // Statement #7 closed inside a wider range and carries its PDF link.
    const wide = await market.get(`/client-portal/history?from=${dayKeyPlus(yesterday, -20)}&to=${yesterday}`);
    expect(wide.body.statements.map((x: { number: number }) => x.number)).toContain(7);
    expect(wide.body.serviceReports.length).toBeGreaterThanOrEqual(3);
    const raw = JSON.stringify(wide.body);
    for (const word of ['payRate', 'billRate', 'hourlyRate', 'Target 9']) expect(raw).not.toContain(word);

    // Guard rails: reversed and oversized ranges.
    expect((await market.get(`/client-portal/history?from=${yesterday}&to=${from}`)).status).toBe(400);
    expect(
      (await market.get(`/client-portal/history?from=${dayKeyPlus(yesterday, -120)}&to=${yesterday}`)).status,
    ).toBe(400);
  });
});

describe('one store, one set of numbers', () => {
  /**
   * A store account must never read a sibling store — not a count, not a
   * dollar, not a closing note, not a supervisor's phone number. These
   * are the surfaces that used to filter on clientId alone.
   */
  it('keeps safety, Store Ops, statements and leads inside the store', async () => {
    const s = await seedTwoStores();
    const now = new Date();

    // A safety incident at the SISTER store only.
    await prisma.oshaIncident.create({
      data: {
        clientId: s.client.id,
        locationId: s.storeB.id,
        occurredAt: new Date(now.getTime() - 2 * HOUR),
        description: 'Slip near the freezer at the other store',
        severity: 'MEDICAL_TREATMENT',
        status: 'REPORTED',
      },
    });
    // A Store Ops run at the sister store, with a closing note.
    const { user: opener } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: s.client.id,
    });
    await prisma.opsShift.create({
      data: {
        clientId: s.client.id,
        locationId: s.storeB.id,
        department: 'Grocery',
        departments: ['Grocery'],
        period: 'OPENING',
        position: 'Lead',
        dateKey: orgDateKey(now),
        openedById: opener.id,
        sopTotal: 10,
        sopDone: 9,
        taskTotal: 4,
        taskDone: 4,
        tempAlerts: 3,
        closingSummary: 'Freezer alarm at the other store',
      },
    });
    // A supervisor who belongs to the sister store.
    const { user: otherLead } = await createUser({
      role: 'FLOOR_SUPERVISOR',
      clientId: s.client.id,
    });
    await prisma.user.update({
      where: { id: otherLead.id },
      data: { locationId: s.storeB.id },
    });

    const store = await (await loginAs(s.storeUser.email)).get('/client-portal/overview');
    expect(store.status).toBe(200);
    expect(store.body.safety.monthIncidents).toBe(0);
    expect(store.body.safety.open).toBe(0);
    expect(store.body.safety.daysSinceLast).toBeNull();
    expect(JSON.stringify(store.body.ops ?? {})).not.toContain('Freezer alarm');
    expect(store.body.leads.people.map((p: { email: string }) => p.email)).not.toContain(
      otherLead.email,
    );

    // The market account still sees the whole account.
    const market = await (await loginAs(s.marketUser.email)).get('/client-portal/overview');
    expect(market.body.safety.monthIncidents).toBe(1);
    expect(market.body.safety.open).toBe(1);
  });

  it('keeps one store's reviewed mark off another store's report', async () => {
    const s = await seedTwoStores();
    const { user: otherStoreUser } = await createUser({
      role: 'CLIENT_PORTAL',
      clientId: s.client.id,
    });
    await prisma.user.update({
      where: { id: otherStoreUser.id },
      data: { locationId: s.storeB.id },
    });

    const week = (await (await loginAs(s.storeUser.email)).get('/client-portal/overview'))
      .body.serviceReport.weekStart as string;

    // Store B signs off its own week.
    const marked = await (await loginAs(otherStoreUser.email))
      .post('/client-portal/acknowledge')
      .send({ kind: 'SERVICE_REPORT', key: week });
    expect(marked.status).toBe(201);
    expect(marked.body.key).toBe(week);

    // Store A's report for the same week is still unsigned.
    const a = await (await loginAs(s.storeUser.email)).get('/client-portal/overview');
    expect(a.body.serviceReport.weekStart).toBe(week);
    expect(a.body.serviceReport.reviewed).toBeNull();

    // And signing it is store A's own act, not a no-op on B's row.
    const own = await (await loginAs(s.storeUser.email))
      .post('/client-portal/acknowledge')
      .send({ kind: 'SERVICE_REPORT', key: week });
    expect(own.status).toBe(201);
    expect(await prisma.clientAcknowledgement.count({ where: { kind: 'SERVICE_REPORT' } })).toBe(2);
  });

  it('withholds the client-wide statement PDF from a store account', async () => {
    const s = await seedTwoStores();

    const blocked = await (await loginAs(s.storeUser.email)).get(
      `/client-portal/statements/${s.statement.id}.pdf`,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.error?.code).toBe('statement_is_client_wide');

    const allowed = await (await loginAs(s.marketUser.email)).get(
      `/client-portal/statements/${s.statement.id}.pdf`,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-type']).toBe('application/pdf');
  });

  it('clamps an ad-hoc report to the store, not the client', async () => {
    const s = await seedTwoStores();
    // Placement is what puts a person on a store's roster.
    const here = await createAssociate({ firstName: 'Rosa', lastName: 'Marchetti' });
    const there = await createAssociate({ firstName: 'Dmitri', lastName: 'Vance' });
    await prisma.associateAssignment.createMany({
      data: [
        { associateId: here.id, locationId: s.storeA.id, startedAt: new Date('2020-01-01') },
        { associateId: there.id, locationId: s.storeB.id, startedAt: new Date('2020-01-01') },
      ],
    });
    const a = await loginAs(s.storeUser.email);

    const res = await a.post('/reports/preview').send({
      name: 'Roster',
      entity: 'ASSOCIATE',
      spec: { columns: ['firstName', 'lastName'], filters: [], sort: [], limit: 100 },
    });
    // The report builder is open to portal accounts (view:analytics), so
    // what it returns has to stop at the store the account is pinned to.
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body.rows);
    expect(body).toContain('Marchetti');
    expect(body).not.toContain('Vance');
  });
});

describe('closing the loops — people, reviewed marks, the store roll-up', () => {
  it('names a person from the roster, marks documents reviewed, and ranks stores', async () => {
    const s = await seedTwoStores();
    const store = await loginAs(s.storeUser.email);
    const market = await loginAs(s.marketUser.email);

    // The store's own people: Maria (store A) only; the market sees both.
    const people = await store.get('/client-portal/people');
    expect(people.status).toBe(200);
    expect(people.body.people.map((p: { name: string }) => p.name)).toEqual(['Maria Lopez']);
    const mpeople = await market.get('/client-portal/people');
    expect(mpeople.body.people.map((p: { name: string }) => p.name)).toEqual(['Ben Okafor', 'Maria Lopez']);

    // Reviewed marks: a FINAL statement and a service report week, once each.
    const first = await store.post('/client-portal/acknowledge').send({ kind: 'STATEMENT', key: s.statement.id });
    expect(first.status).toBe(201);
    expect(first.body.reviewedAt).toBeTruthy();
    const again = await store.post('/client-portal/acknowledge').send({ kind: 'STATEMENT', key: s.statement.id });
    expect(again.status).toBe(200);
    expect(again.body.reviewedAt).toBe(first.body.reviewedAt);
    // Drafts and other tenants' statements can't be marked; bad keys are refused.
    expect((await store.post('/client-portal/acknowledge').send({ kind: 'STATEMENT', key: s.draft.id })).status).toBe(404);
    expect((await store.post('/client-portal/acknowledge').send({ kind: 'SERVICE_REPORT', key: 'nope' })).status).toBe(400);
    const week = await store.post('/client-portal/acknowledge').send({ kind: 'SERVICE_REPORT', key: '2026-01-03' });
    expect(week.status).toBe(201);
    // The marks show up on the overview and on the staff statements list.
    const overview = await store.get('/client-portal/overview');
    const st = overview.body.statements.find((x: { id: string }) => x.id === s.statement.id);
    expect(st.reviewed.reviewedAt).toBe(first.body.reviewedAt);
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const staff = await loginAs(hr.email);
    const list = await staff.get(`/clients/${s.client.id}/statements`);
    expect(list.status).toBe(200);
    const staffRow = list.body.statements.find((x: { id: string }) => x.id === s.statement.id);
    expect(staffRow.clientReviewed.reviewedAt).toBe(first.body.reviewedAt);
    // A preview can't sign for the client.
    expect(
      (await staff.post('/client-portal/acknowledge').send({ kind: 'STATEMENT', key: s.statement.id })).status,
    ).toBe(403);

    // The market roll-up: both stores, ranked by the same contract grade —
    // store A (4 of 12 contracted person-hours, 33%) ahead of the sister
    // store, which has no target and falls back to 0 of 1 showed up.
    const yesterday = dayKeyPlus(orgDateKey(new Date()), -1);
    const hist = await market.get(`/client-portal/history?from=${dayKeyPlus(yesterday, -6)}&to=${yesterday}`);
    expect(hist.status).toBe(200);
    expect(hist.body.stores.map((x: { name: string; grade: string | null }) => [x.name, x.grade])).toEqual([
      ['Walmart 218', 'F'],
      ['Walmart 4411', 'F'],
    ]);
    expect(hist.body.stores[0].reliabilityPct).toBe(33);
    expect(hist.body.stores[1].reliabilityPct).toBe(0);
    // A store account never gets the roll-up.
    const shist = await store.get(`/client-portal/history?from=${dayKeyPlus(yesterday, -6)}&to=${yesterday}`);
    expect(shist.body.stores).toEqual([]);
  });

  it('provisions and pulls portal logins from the client page, with a readiness check', async () => {
    const s = await seedTwoStores();
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const admin = await loginAs(hr.email);

    const before = await admin.get(`/clients/${s.client.id}/portal-users`);
    expect(before.status).toBe(200);
    expect(before.body.users).toHaveLength(2);

    // Invite a store manager for store B.
    const invited = await admin
      .post(`/clients/${s.client.id}/portal-users`)
      .send({ email: 'Manager.4411@walmart.example', locationId: s.storeB.id, name: 'Jordan Lee' });
    expect(invited.status).toBe(201);
    expect(invited.body.email).toBe('manager.4411@walmart.example');
    expect(invited.body.locationName).toBe('Walmart 4411');
    const created = await prisma.user.findUniqueOrThrow({ where: { email: 'manager.4411@walmart.example' } });
    expect(created.role).toBe('CLIENT_PORTAL');
    expect(created.status).toBe('INVITED');
    expect(created.locationId).toBe(s.storeB.id);
    expect(await prisma.inviteToken.count({ where: { userId: created.id, consumedAt: null } })).toBe(1);
    // The store manager's note: their store site, by name only — never
    // the associate's pre-employment onboarding.
    const note = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: created.id, channel: 'EMAIL', category: 'portal.invite' },
    });
    expect(note.subject).toBe('Your Walmart 4411 store site is ready');
    expect(note.body.startsWith('Jordan Lee,')).toBe(true);
    expect(note.body).toContain('Open my store site');
    for (const w of ['onboarding', 'Position', 'Start date', '15 minutes']) expect(note.body).not.toContain(w);
    // A store from another client, an Alto staff email, are refused.
    expect(
      (await admin.post(`/clients/${s.client.id}/portal-users`).send({ email: 'x@y.example', locationId: s.otherStore.id }))
        .status,
    ).toBe(400);
    expect((await admin.post(`/clients/${s.client.id}/portal-users`).send({ email: hr.email })).status).toBe(409);

    // Readiness: store B has no headcount, no lead position, no supervisor phone…
    await flushPendingNotifications();
    const ready = await admin.get(`/clients/${s.client.id}/portal-readiness`);
    expect(ready.status).toBe(200);
    expect(ready.body.stores.find((x: { id: string }) => x.id === s.storeA.id).hasTarget).toBe(true);
    expect(ready.body.stores.find((x: { id: string }) => x.id === s.storeB.id).hasTarget).toBe(false);
    expect(ready.body.gaps.some((g: string) => g.includes('Walmart 4411'))).toBe(true);
    // …and the Workforce desk was rung about it (once).
    const { user: wfm } = await createUser({ role: 'WORKFORCE_MANAGER' });
    const marketInvite = await admin.post(`/clients/${s.client.id}/portal-users`).send({ email: 'second@walmart.example' });
    expect(marketInvite.status).toBe(201);
    // A client-wide login is a market manager: the command-center note,
    // addressed by the front of the email when no name was given.
    const marketNote = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: marketInvite.body.id, channel: 'EMAIL', category: 'portal.invite' },
    });
    expect(marketNote.subject).toBe('Your Walmart 218 command center is ready');
    expect(marketNote.body.startsWith('second,')).toBe(true);
    expect(marketNote.body).toContain('2 stores');
    expect(marketNote.body).toContain('Open my command center');
    await flushPendingNotifications();
    const bells = await prisma.notification.findMany({
      where: { category: 'portal.readiness', channel: 'IN_APP', recipientUserId: wfm.id },
    });
    expect(bells).toHaveLength(1);
    expect(bells[0]!.linkUrl).toBe(`/clients/${s.client.id}?section=portal`);

    // Pull a login: signed out, disabled, and only portal accounts of THIS client are reachable.
    const pulled = await admin.post(`/clients/${s.client.id}/portal-users/${created.id}/disable`);
    expect(pulled.status).toBe(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).status).toBe('DISABLED');
    expect((await admin.post(`/clients/${s.other.id}/portal-users/${created.id}/disable`)).status).toBe(404);
    expect((await admin.post(`/clients/${s.client.id}/portal-users/${hr.id}/disable`)).status).toBe(404);
  });
});
