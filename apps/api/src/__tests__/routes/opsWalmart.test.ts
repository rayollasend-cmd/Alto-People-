import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request, { type Test } from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { minuteOfDayInZone } from '@alto-people/shared';
import { createApp } from '../../app.js';
import {
  DEFAULT_TEST_PASSWORD,
  createAssociate,
  createClient,
  createUser,
  prisma,
  truncateAll,
} from '../../../test/db.js';
import { WALMART_TEMPLATES } from '../../lib/opsSopsWalmart.js';
import { localDateKey } from '../../lib/timezone.js';

/**
 * The Walmart department manual as the SOP library — timed blocks,
 * measured work — and the store operations page the store manager and
 * their team leads read it through.
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
  if (r.status !== 200) throw new Error(`loginAs(${email}) failed: ${r.status}`);
  return a;
}

const NY = 'America/New_York';
const H = 3_600_000;

type Task = {
  id: string;
  title: string;
  section: string;
  responseType: string;
  dueAt: string | null;
  metricKey: string | null;
};

async function store() {
  const client = await createClient('Front Beach 218');
  const loc = await prisma.location.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.location.update({ where: { id: loc.id }, data: { timezone: NY } });
  const lead = await createAssociate({ firstName: 'Tori', lastName: 'Banks' });
  const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id, associateId: lead.id });
  const { user: manager } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
  await prisma.user.update({ where: { id: manager.id }, data: { locationId: loc.id } });
  return { client, loc, sup, lead: await loginAs(sup.email), manager: await loginAs(manager.email) };
}

async function openRun(agent: TestAgent<Test>, position: string) {
  const open = await agent.post('/ops/shifts/open').send({ position });
  expect(open.status).toBe(201);
  const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
  return { shiftId: open.body.shiftId as string, tasks: detail.body.tasks as Task[] };
}

describe('the Walmart SOP library', () => {
  it('a new library is the manual: every shift, timed blocks, measured work', async () => {
    const { lead } = await store();
    const lib = await lead.get('/ops/library');
    expect(lib.status).toBe(200);
    const names = (lib.body.templates as Array<{ name: string }>).map((t) => t.name);
    for (const tpl of WALMART_TEMPLATES) expect(names).toContain(tpl.name);
    expect(names).toContain('Deli & Bakery — Morning');
    expect(names).toContain('General Merchandise — Closing');
    expect(names).not.toContain('Frozen & Dairy — Morning');

    const overnight = (lib.body.templates as Array<{ name: string; tasks: Array<Task & { dueTime: string | null }> }>).find(
      (t) => t.name === 'Frozen & Dairy — Overnight (10 PM–7 AM)',
    )!;
    expect(overnight.tasks.every((t) => /^\d\d:\d\d$/.test(t.dueTime ?? ''))).toBe(true);
    expect(overnight.tasks[0]!.dueTime).toBe('22:30');
    expect(overnight.tasks.at(-1)!.dueTime).toBe('07:00');
    const metrics = new Set(overnight.tasks.map((t) => t.metricKey).filter(Boolean));
    expect(metrics).toEqual(new Set(['pallets_received', 'cases_stocked', 'items_discarded', 'claims_processed']));
  });

  it('upgrades a first-generation library once — retires, moves its store shifts, keeps the rest', async () => {
    const { loc, lead } = await store();
    const v1 = await prisma.opsSopTemplate.create({
      data: { name: 'Frozen & Dairy — Morning', department: 'Frozen & Dairy', period: 'MORNING' },
    });
    const gm = await prisma.opsSopTemplate.create({
      data: { name: 'General Merchandise — Morning', department: 'General Merchandise', period: 'MORNING' },
    });
    await prisma.storeShiftSop.create({ data: { locationId: loc.id, label: 'Morning', templateId: v1.id } });

    expect((await lead.get('/ops/library')).status).toBe(200);
    const [old, kept, mapping] = await Promise.all([
      prisma.opsSopTemplate.findUniqueOrThrow({ where: { id: v1.id } }),
      prisma.opsSopTemplate.findUniqueOrThrow({ where: { id: gm.id } }),
      prisma.storeShiftSop.findFirstOrThrow({ where: { locationId: loc.id }, include: { template: true } }),
    ]);
    expect(old.retiredAt).not.toBeNull();
    expect(kept.retiredAt).toBeNull();
    expect(mapping.template.name).toBe('Frozen & Dairy — Morning (7 AM–4 PM)');

    const count = await prisma.opsSopTemplate.count();
    await lead.get('/ops/library');
    expect(await prisma.opsSopTemplate.count()).toBe(count);
  });

  it("a run carries each block's deadline; my-sop names the block to work and what's overdue", async () => {
    const { lead } = await store();
    const { shiftId, tasks } = await openRun(lead, 'F&D Morning Shift');
    expect(tasks.every((t) => t.dueAt)).toBe(true);
    const first = tasks.filter((t) => t.section === tasks[0]!.section);
    expect(new Set(first.map((t) => t.dueAt)).size).toBe(1);
    const dues = tasks.map((t) => Date.parse(t.dueAt!));
    expect([...dues].sort((a, b) => a - b)).toEqual(dues);

    // Whatever the hour: the first block ran out ten minutes ago, the rest are ahead.
    await prisma.opsTask.updateMany({ where: { opsShiftId: shiftId }, data: { dueAt: new Date(Date.now() + 3 * H) } });
    await prisma.opsTask.updateMany({
      where: { opsShiftId: shiftId, section: tasks[0]!.section },
      data: { dueAt: new Date(Date.now() - 10 * 60_000) },
    });
    await lead.patch(`/ops/tasks/${first[0]!.id}`).send({ status: 'DONE' });
    const mine = await lead.get('/ops/my-sop');
    expect(mine.body.sop.overdue).toBe(first.length - 1);
    expect(mine.body.sop.block).toMatchObject({ section: tasks[0]!.section, open: first.length - 1 });
  });

  it('the library times a whole block at once; a new task joins its block; bad times are refused', async () => {
    await store();
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const agent = await loginAs(exec.email);
    const lib = await agent.get('/ops/library');
    const tpl = (lib.body.templates as Array<{ id: string; name: string; tasks: Task[] }>).find(
      (t) => t.name === 'Food & Consumables — Morning (6 AM–3 PM)',
    )!;
    const section = tpl.tasks[0]!.section;

    expect((await agent.patch(`/ops/library/templates/${tpl.id}/sections`).send({ section, dueTime: '7:15' })).status).toBe(400);
    const timed = await agent.patch(`/ops/library/templates/${tpl.id}/sections`).send({ section, dueTime: '07:15' });
    expect(timed.status).toBe(200);
    expect(timed.body.updated).toBe(tpl.tasks.filter((t) => t.section === section).length);

    const added = await agent
      .post(`/ops/library/templates/${tpl.id}/tasks`)
      .send({ section, title: 'Walk the grocery aisles with the store manager' });
    expect(added.status).toBe(201);
    const row = await prisma.opsSopTemplateTask.findUniqueOrThrow({ where: { id: added.body.id } });
    expect(row.dueTime).toBe('07:15');
  });
});

describe('store operations, in the portal', () => {
  it('the store manager sees the day — attention first, food safety, production — and no money', async () => {
    const { lead, manager } = await store();
    const { shiftId, tasks } = await openRun(lead, 'F&D Evening Shift');

    const cooler = tasks.find((t) => t.responseType === 'TEMPERATURE')!;
    const warm = await lead.patch(`/ops/tasks/${cooler.id}`).send({ answerNumber: 44, status: 'DONE' });
    expect(warm.body.followUp).toBeTruthy();
    const truck = tasks.find((t) => t.title === 'Truck received')!;
    await lead.patch(`/ops/tasks/${truck.id}`).send({ answerNumber: 12, status: 'DONE' });
    const refill = tasks.find((t) => t.responseType === 'YES_NO_PARTIAL')!;
    await lead.patch(`/ops/tasks/${refill.id}`).send({ answerChoice: 'PARTIAL', status: 'DONE' });
    // Whatever the hour the test runs: the first block is overdue, the rest ahead.
    await prisma.opsTask.updateMany({ where: { opsShiftId: shiftId }, data: { dueAt: new Date(Date.now() + 3 * H) } });
    await prisma.opsTask.updateMany({
      where: { opsShiftId: shiftId, section: tasks[0]!.section },
      data: { dueAt: new Date(Date.now() - 5 * 60_000) },
    });

    const res = await manager.get('/client-portal/ops');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({ department: 'Frozen & Dairy', period: 'EVENING', status: 'ACTIVE', runBy: 'Tori Banks' });
    const kinds = (res.body.attention as Array<{ kind: string }>).map((a) => a.kind);
    expect(kinds[0]).toBe('TEMP');
    expect(kinds).toEqual(expect.arrayContaining(['TEMP', 'OVERDUE', 'COMPLIANCE']));
    expect(res.body.summary).toMatchObject({ sops: 1, running: 1, tempAlerts: 1, tempOpen: 1, overdueBlocks: 1 });
    const reading = (res.body.temps as Array<{ taskId: string; value: number; outOfRange: boolean }>).find(
      (t) => t.taskId === cooler.id,
    );
    expect(reading).toMatchObject({ value: 44, outOfRange: true, min: 33, max: 41 });
    const pallets = (res.body.metrics as Array<{ key: string; total: number; byDepartment: Record<string, number> }>).find(
      (m) => m.key === 'pallets_received',
    );
    expect(pallets).toMatchObject({ total: 12, byDepartment: { 'Frozen & Dairy': 12 } });
    expect(JSON.stringify(res.body)).not.toMatch(/billRate|payRate|hourlyRate|Cents|wage/i);

    // The re-check comes back in range: the alert is closed out.
    await lead.patch(`/ops/tasks/${warm.body.followUp.id}`).send({ answerNumber: 38, status: 'DONE' });
    const after = await manager.get('/client-portal/ops');
    expect((after.body.attention as Array<{ kind: string }>).map((a) => a.kind)).not.toContain('TEMP');
    expect(after.body.temps.find((t: { taskId: string }) => t.taskId === cooler.id).recheck).toMatchObject({
      value: 38,
      outOfRange: false,
    });

    // The team lead reads the same page; an associate doesn't.
    expect((await lead.get('/client-portal/ops')).status).toBe(200);
    const { user: assoc } = await createUser({ role: 'ASSOCIATE' });
    expect((await (await loginAs(assoc.email)).get('/client-portal/ops')).status).toBe(403);
  });

  it("calls out a store shift whose SOP never opened", async () => {
    const { loc, manager } = await store();
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    const opsAgent = await loginAs(ops.email);
    const lib = await opsAgent.get('/ops/library');
    const tpl = (lib.body.templates as Array<{ id: string; name: string }>).find(
      (t) => t.name === 'Frozen & Dairy — Morning (7 AM–4 PM)',
    )!;
    const started = new Date(Date.now() - 2 * H);
    await prisma.staffingTarget.create({
      data: {
        locationId: loc.id,
        targetCount: 6,
        effectiveFrom: new Date('2026-01-01'),
        label: 'Morning',
        startMinute: minuteOfDayInZone(started, NY),
        endMinute: minuteOfDayInZone(new Date(Date.now() + 6 * H), NY),
      },
    });
    expect(
      (await opsAgent.put('/ops/store-shifts').send({ locationId: loc.id, label: 'Morning', templateId: tpl.id })).status,
    ).toBe(200);

    const res = await manager.get(`/client-portal/ops?date=${localDateKey(started, NY)}`);
    expect(res.status).toBe(200);
    const missed = (res.body.attention as Array<{ kind: string; title: string }>).find((a) => a.kind === 'NOT_STARTED');
    expect(missed?.title).toBe('Morning — SOP not started');
    expect(res.body.summary.notStarted).toBe(1);
    const cell = res.body.grid[0].cells.find((c: { period: string }) => c.period === 'MORNING');
    expect(cell.expected[0]).toMatchObject({ windowLabel: 'Morning', missed: true });
  });

  it('shows photo evidence to its own store only', async () => {
    const { lead, manager } = await store();
    const { tasks } = await openRun(lead, 'F&D Evening Shift');
    const photoTask = tasks.find((t) => t.responseType === 'PHOTO')!;
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR'),
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
      Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
    ]);
    const up = await lead
      .post(`/ops/tasks/${photoTask.id}/photos`)
      .attach('file', png, { filename: 'zone.png', contentType: 'image/png' });
    expect(up.status).toBe(201);

    const day = await manager.get('/client-portal/ops');
    const photoId = day.body.runs[0].finalPhotoId as string;
    expect(photoId).toBeTruthy();
    const img = await manager.get(`/client-portal/ops/photos/${photoId}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');

    const other = await createClient('Other Store');
    const { user: stranger } = await createUser({ role: 'CLIENT_PORTAL', clientId: other.id });
    expect((await (await loginAs(stranger.email)).get(`/client-portal/ops/photos/${photoId}`)).status).toBe(404);
  });
});
