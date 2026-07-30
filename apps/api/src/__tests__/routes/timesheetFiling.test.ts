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
 * Timesheet filing tenant boundary + determinism.
 *
 * The filing artifact (TimesheetFiling) used to be keyed on the REQUEST's
 * clientId while the row data was scoped per-user — and the router's guard
 * is manage:time, which SHIFT_SUPERVISOR holds. A supervisor omitting
 * clientId hit the org-wide (clientId=null) filing in both directions:
 * filing overwrote HR's org-wide snapshot with one site's workers, and
 * reading computed drift of HR's all-client snapshot against their scoped
 * rows — leaking every other client's worker names and hours.
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

/** An approved 8h Monday entry inside the Sat-Fri week of WEEK_START. */
async function approvedEntry(associateId: string, clientId: string) {
  const clockInAt = new Date('2026-06-15T13:00:00.000Z'); // Mon 9am ET
  return prisma.timeEntry.create({
    data: {
      associateId,
      clientId,
      clockInAt,
      clockOutAt: new Date(clockInAt.getTime() + 8 * 3600_000),
      status: 'APPROVED',
    },
  });
}

// Any instant inside the Sat 2026-06-13 → Fri 2026-06-19 store-local week.
const WEEK_START = '2026-06-15T12:00:00.000Z';

describe('timesheet filing — tenant boundary', () => {
  it('a supervisor filing without clientId is clamped to their client and cannot touch the org-wide filing', async () => {
    const mine = await createClient('Mine LLC');
    const other = await createClient('Other Corp');
    const myAssoc = await createAssociate({ firstName: 'My', lastName: 'Person' });
    const otherAssoc = await createAssociate({ firstName: 'Their', lastName: 'Person' });
    await approvedEntry(myAssoc.id, mine.id);
    await approvedEntry(otherAssoc.id, other.id);

    // HR files the org-wide week first — the artifact the supervisor used
    // to be able to clobber.
    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    const hrFile = await hr
      .post('/time/admin/timesheets/file')
      .send({ weekStart: WEEK_START });
    expect(hrFile.status).toBe(200);
    expect(hrFile.body.filing.filedTotalHours).toBe(16); // both clients

    // Supervisor files with NO clientId in the body.
    const { user: supUser } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: mine.id,
    });
    const sup = await loginAs(supUser.email);
    const supFile = await sup
      .post('/time/admin/timesheets/file')
      .send({ weekStart: WEEK_START });
    expect(supFile.status).toBe(200);
    // Clamped: their filing covers only their client's 8 hours.
    expect(supFile.body.filing.filedTotalHours).toBe(8);

    // The org-wide filing row is untouched — still HR's, still 16h.
    const orgFiling = await prisma.timesheetFiling.findFirst({
      where: { clientId: null },
    });
    expect(orgFiling).toBeTruthy();
    expect(Number(orgFiling!.totalHours)).toBe(16);
    expect(orgFiling!.filedById).toBe(hrUser.id);

    // And the supervisor's filing landed under THEIR clientId.
    const supFiling = await prisma.timesheetFiling.findFirst({
      where: { clientId: mine.id },
    });
    expect(supFiling).toBeTruthy();
    expect(Number(supFiling!.totalHours)).toBe(8);
  });

  it('a supervisor reading without clientId cannot see org-wide drift (the leak)', async () => {
    const mine = await createClient('Mine LLC');
    const other = await createClient('Other Corp');
    const myAssoc = await createAssociate({ firstName: 'My', lastName: 'Person' });
    const otherAssoc = await createAssociate({
      firstName: 'Secret',
      lastName: 'Worker',
    });
    await approvedEntry(myAssoc.id, mine.id);
    await approvedEntry(otherAssoc.id, other.id);

    const { user: hrUser } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(hrUser.email);
    await hr
      .post('/time/admin/timesheets/file')
      .send({ weekStart: WEEK_START })
      .expect(200);

    const { user: supUser } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: mine.id,
    });
    const sup = await loginAs(supUser.email);
    const res = await sup
      .post('/time/admin/timesheets')
      .send({ weekStart: WEEK_START });
    expect(res.status).toBe(200);

    // Before the clamp: the org-wide filing was returned and drift listed
    // "Worker, Secret" (another client's associate) as filed-but-missing —
    // names and hours leaking to a client-bounded role.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Secret');
    if (res.body.filing) {
      // If a filing shows at all, it must be the supervisor's own client's.
      expect(res.body.filing.filedTotalHours).not.toBe(16);
    }
  });

  it('a supervisor with no client on file is refused, not routed org-wide', async () => {
    const { user } = await createUser({ role: 'SHIFT_SUPERVISOR' }); // no clientId
    const sup = await loginAs(user.email);
    await sup
      .post('/time/admin/timesheets')
      .send({ weekStart: WEEK_START })
      .expect(403);
  });

  it('re-filing the org-wide week updates in place — never a duplicate row', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    await approvedEntry(assoc.id, client.id);

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);
    await hr.post('/time/admin/timesheets/file').send({ weekStart: WEEK_START }).expect(200);
    await hr.post('/time/admin/timesheets/file').send({ weekStart: WEEK_START }).expect(200);

    // The compound unique never covered clientId=null (Postgres NULLs are
    // distinct) — the partial unique index and the update-on-conflict path
    // now guarantee exactly one org-wide filing per week.
    const count = await prisma.timesheetFiling.count({ where: { clientId: null } });
    expect(count).toBe(1);
  });
});

describe('associate timesheet detail — determinism and honest rates', () => {
  it('prices the week by the EARLIEST in-week entry when two clients are worked', async () => {
    const clientA = await createClient('Alpha');
    const clientB = await createClient('Beta');
    await prisma.client.update({
      where: { id: clientA.id },
      data: { fieldglassBillRate: 30 },
    });
    await prisma.client.update({
      where: { id: clientB.id },
      data: { fieldglassBillRate: 99 },
    });
    const assoc = await createAssociate();

    // Insert the LATER entry first so an unordered query would surface it
    // first — the regression this test exists to catch.
    const tue = new Date('2026-06-16T13:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: assoc.id,
        clientId: clientB.id,
        clockInAt: tue,
        clockOutAt: new Date(tue.getTime() + 4 * 3600_000),
        status: 'APPROVED',
      },
    });
    const mon = new Date('2026-06-15T13:00:00.000Z');
    await prisma.timeEntry.create({
      data: {
        associateId: assoc.id,
        clientId: clientA.id,
        clockInAt: mon,
        clockOutAt: new Date(mon.getTime() + 4 * 3600_000),
        status: 'APPROVED',
      },
    });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);
    const res = await hr.post('/time/admin/timesheets/associate').send({
      associateId: assoc.id,
      weekStart: WEEK_START,
    });
    expect(res.status).toBe(200);
    // Earliest in-week entry is Monday @ Alpha → billRate 30, not Beta's 99.
    expect(res.body.billRate).toBe(30);
    expect(res.body.amount).toBe(30 * 8);
  });

  it('shows a null pay rate when no comp record exists — no fabricated $15', async () => {
    const client = await createClient();
    const assoc = await createAssociate();
    await approvedEntry(assoc.id, client.id);

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(user.email);
    const res = await hr.post('/time/admin/timesheets/associate').send({
      associateId: assoc.id,
      weekStart: WEEK_START,
    });
    expect(res.status).toBe(200);
    expect(res.body.payRate).toBeNull();
  });
});
