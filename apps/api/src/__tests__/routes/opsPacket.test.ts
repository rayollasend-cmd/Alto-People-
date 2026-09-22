import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';

/**
 * The SOP packet — the record as a document.
 *
 * What these hold: the packet is a real PDF with a filename, it is
 * clamped to the caller's tenant so a URL cannot be edited into another
 * client's stores, it refuses a shift it cannot show, and the record it
 * summarises names the supervisor ACCOUNT that submitted each shift
 * rather than only the one that opened it.
 */

const app = () => createApp();

async function loginAs(email: string): Promise<TestAgent<Test>> {
  const a = request.agent(app());
  const r = await a.post('/auth/login').send({ email, password: DEFAULT_TEST_PASSWORD });
  expect(r.status).toBe(200);
  return a;
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function seedClosedShift(opts: {
  clientId: string;
  locationId?: string | null;
  openedById: string;
  closedById: string;
  dateKey: string;
  period?: 'MORNING' | 'EVENING' | 'CLOSING' | 'OVERNIGHT';
}) {
  return prisma.opsShift.create({
    data: {
      clientId: opts.clientId,
      locationId: opts.locationId ?? null,
      department: 'Frozen & Dairy',
      departments: ['Frozen & Dairy'],
      period: opts.period ?? 'OVERNIGHT',
      position: 'F&D Overnight Shift',
      dateKey: opts.dateKey,
      status: 'CLOSED',
      openedById: opts.openedById,
      openedAt: new Date(`${opts.dateKey}T22:00:00.000Z`),
      closedById: opts.closedById,
      closedAt: new Date(`${opts.dateKey}T23:30:00.000Z`),
      dueAt: new Date(`${opts.dateKey}T23:00:00.000Z`),
      scheduledHeadcount: 6,
      actualHeadcount: 5,
      sopTotal: 10,
      sopDone: 8,
      taskTotal: 12,
      taskDone: 9,
      closedIncomplete: true,
      incompleteReason: 'Freezer 3 door seal failed; maintenance called out.',
      tempAlerts: 2,
      closingSummary: 'Floor recovered by 05:40.',
    },
  });
}

describe('the SOP packet', () => {
  it('returns a PDF with a filename for a day, a month and one shift', async () => {
    const client = await createClient();
    const { user: runner } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: closer } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const shift = await seedClosedShift({
      clientId: client.id,
      openedById: runner.id,
      closedById: closer.id,
      dateKey: '2026-09-16',
    });
    const agent = await loginAs(exec.email);

    for (const qs of [
      `kind=day&dateKey=2026-09-16`,
      `kind=month&month=2026-09`,
      `kind=shift&shiftId=${shift.id}`,
    ]) {
      const res = await agent
        .get(`/ops/packet.pdf?${qs}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status, qs).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="sop-.*\.pdf"/);
      // A real PDF, not an empty buffer or an error page.
      const buf = res.body as Buffer;
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buf.length).toBeGreaterThan(2000);
    }
  });

  it('is board-only: a supervisor cannot use it to read a shift', async () => {
    const mine = await createClient('Mine');
    const theirs = await createClient('Theirs');
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: mine.id });
    const { user: other } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: theirs.id });
    const foreign = await seedClosedShift({
      clientId: theirs.id,
      openedById: other.id,
      closedById: other.id,
      dateKey: '2026-09-16',
    });

    // Supervisors run shifts; they do not oversee them. The packet is not
    // a way around the board's capability gate — neither for another
    // client's shift nor, by the same door, for their own.
    const supAgent = await loginAs(sup.email);
    expect((await supAgent.get(`/ops/packet.pdf?kind=shift&shiftId=${foreign.id}`)).status).toBe(
      403,
    );
    expect((await supAgent.get('/ops/packet.pdf?kind=month&month=2026-09')).status).toBe(403);
  });

  it('refuses a kind it does not know, and a shift that is not there', async () => {
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const agent = await loginAs(exec.email);
    expect((await agent.get('/ops/packet.pdf?kind=quarter')).status).toBe(400);
    expect(
      (
        await agent.get(
          '/ops/packet.pdf?kind=shift&shiftId=00000000-0000-0000-0000-000000000000',
        )
      ).status,
    ).toBe(404);
  });

  it('names the account that SUBMITTED the shift, not only the one that opened it', async () => {
    const client = await createClient();
    const { user: runner } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: closer } = await createUser({
      role: 'SHIFT_SUPERVISOR',
      clientId: client.id,
    });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const shift = await seedClosedShift({
      clientId: client.id,
      openedById: runner.id,
      closedById: closer.id,
      dateKey: '2026-09-16',
    });
    const agent = await loginAs(exec.email);

    // The record: the closer used to be missing from the lookup entirely,
    // so `submittedBy` was always null.
    const record = await agent.get(`/ops/shifts/${shift.id}`);
    expect(record.status).toBe(200);
    expect(record.body.shift.submittedBy?.email).toBe(closer.email);
    expect(record.body.shift.runBy?.email).toBe(runner.email);

    // The history rows carry both accounts, so a table can show who signed.
    const history = await agent.get('/ops/history?from=2026-09-16&to=2026-09-16');
    expect(history.status).toBe(200);
    const row = history.body.shifts.find((s: { id: string }) => s.id === shift.id);
    expect(row.submittedByAccount).toBe(closer.email);
    expect(row.openedByAccount).toBe(runner.email);
  });

  it('narrows the scorecard and the insights to the filtered store', async () => {
    const client = await createClient();
    const a = await prisma.location.create({
      data: { clientId: client.id, name: 'Destin' },
    });
    const b = await prisma.location.create({
      data: { clientId: client.id, name: 'Front Beach 218' },
    });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const today = new Date().toISOString().slice(0, 10);
    await seedClosedShift({
      clientId: client.id,
      locationId: a.id,
      openedById: sup.id,
      closedById: sup.id,
      dateKey: today,
    });
    await seedClosedShift({
      clientId: client.id,
      locationId: b.id,
      openedById: sup.id,
      closedById: sup.id,
      dateKey: today,
      period: 'MORNING',
    });
    const agent = await loginAs(exec.email);

    const all = await agent.get('/ops/scorecard?weeks=4');
    expect(all.body.rows.length).toBe(2);

    // The filter bar used to be ignored here, so picking one store left
    // the scorecard showing the whole estate.
    const one = await agent.get(`/ops/scorecard?weeks=4&locationId=${a.id}`);
    expect(one.body.rows.length).toBe(1);
    expect(one.body.rows[0].storeName).toBe('Destin');

    const insights = await agent.get(`/ops/insights?locationId=${a.id}`);
    expect(insights.status).toBe(200);
    expect(insights.body.stores.every((s: { name: string }) => s.name === 'Destin')).toBe(true);

    // The disposition totals a scorecard needs to be read honestly.
    expect(all.body.totals).toHaveProperty('handoverPending');
    expect(all.body.totals).toHaveProperty('onTimeOf');
    expect(all.body.weekly.length).toBe(4);
  });
});
