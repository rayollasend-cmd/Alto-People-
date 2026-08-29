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
 * Store Operations: position-driven SOP checklists, typed responses with
 * instant temp alerts, evidence gates, handover with explicit decisions,
 * and the leadership-only library/board split.
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

describe('store ops', () => {
  it('opening a shift derives department+period from the position and snapshots the SOP', async () => {
    const client = await createClient('Walmart Front Beach');
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);

    const open = await agent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Overnight Shift' });
    expect(open.status).toBe(201);
    const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.shift.department).toBe('Frozen & Dairy');
    expect(detail.body.shift.period).toBe('OVERNIGHT');
    expect(detail.body.shift.templateName).toBe('Frozen & Dairy — Overnight');
    // The seeded overnight checklist came along as real task rows.
    const titles = detail.body.tasks.map((t: { title: string }) => t.title);
    expect(titles).toContain('Stock Frozen');
    expect(titles).toContain('Overnight temperature check');

    // Re-opening resumes rather than duplicating.
    const again = await agent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Overnight Shift' });
    expect(again.status).toBe(200);
    expect(again.body.resumed).toBe(true);
    expect(again.body.shiftId).toBe(open.body.shiftId);
  });

  it('an out-of-range temperature flags instantly and alerts admins', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);
    const open = await agent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Overnight Shift' });
    const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
    const tempTask = detail.body.tasks.find(
      (t: { responseType: string }) => t.responseType === 'TEMPERATURE',
    );
    expect(tempTask).toBeTruthy();

    // 22°F in a -10..10 freezer band → flagged + alert.
    const res = await agent
      .patch(`/ops/tasks/${tempTask.id}`)
      .send({ answerNumber: 22, status: 'DONE' });
    expect(res.status).toBe(200);
    expect(res.body.task.tempOutOfRange).toBe(true);
    const alert = await prisma.notification.findFirst({
      where: { recipientUserId: admin.id, category: 'ops.temp_alert' },
    });
    expect(alert).not.toBeNull();
    const shiftRow = await prisma.opsShift.findUniqueOrThrow({
      where: { id: open.body.shiftId },
    });
    expect(shiftRow.tempAlerts).toBe(1);
  });

  it('a photo-required task refuses DONE without a photo', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);
    const open = await agent
      .post('/ops/shifts/open')
      .send({ position: 'GM Closing Shift' });
    const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
    const photoTask = detail.body.tasks.find(
      (t: { photoRequired: boolean }) => t.photoRequired,
    );
    expect(photoTask).toBeTruthy();
    const refused = await agent
      .patch(`/ops/tasks/${photoTask.id}`)
      .send({ status: 'DONE' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('photo_required');
  });

  it('for a PHOTO task, landing the photo IS the completion', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);
    const open = await agent
      .post('/ops/shifts/open')
      .send({ position: 'GM Closing Shift' });
    const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
    const photoTask = detail.body.tasks.find(
      (t: { responseType: string }) => t.responseType === 'PHOTO',
    );
    expect(photoTask).toBeTruthy();

    // Minimal valid PNG (8-byte signature + IHDR) — passes the magic check.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR'),
      Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
      Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
    ]);
    const res = await agent
      .post(`/ops/tasks/${photoTask.id}/photos`)
      .attach('file', png, { filename: 'proof.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.autoCompleted).toBe(true);

    const after = await prisma.opsTask.findUniqueOrThrow({ where: { id: photoTask.id } });
    expect(after.status).toBe('DONE');
    expect(after.completedById).not.toBeNull();
  });

  it('closing stamps completion math and flags incomplete closes to admins', async () => {
    const client = await createClient();
    const { user: admin } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);
    const open = await agent
      .post('/ops/shifts/open')
      .send({ position: 'Food & Consumables Morning' });
    const detail = await agent.get(`/ops/shifts/${open.body.shiftId}`);
    // Complete exactly one plain CHECK task, tagging who did the work.
    const associate = await createAssociate({ firstName: 'Did', lastName: 'TheWork' });
    const check = detail.body.tasks.find(
      (t: { responseType: string }) => t.responseType === 'CHECK',
    );
    await agent
      .patch(`/ops/tasks/${check.id}`)
      .send({ status: 'DONE', doneAssociateId: associate.id });

    const close = await agent
      .post(`/ops/shifts/${open.body.shiftId}/close`)
      .send({ summary: 'Short-staffed; carried stocking to evening.' });
    expect(close.status).toBe(200);
    expect(close.body.shift.status).toBe('CLOSED');
    expect(close.body.shift.sopDone).toBe(1);
    expect(close.body.shift.closedIncomplete).toBe(true);

    const flag = await prisma.notification.findFirst({
      where: { recipientUserId: admin.id, category: 'ops.incomplete_close' },
    });
    expect(flag).not.toBeNull();

    // Closed record is final.
    const late = await agent.patch(`/ops/tasks/${check.id}`).send({ status: 'OPEN' });
    expect(late.status).toBe(409);
  });

  it('handover: the next shift sees pending items and CARRY creates a task', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const agent = await loginAs(sup.email);
    const first = await agent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Overnight Shift' });
    await agent.post(`/ops/shifts/${first.body.shiftId}/handover`).send({
      items: [
        { kind: 'EQUIPMENT', body: 'Freezer door 3 seal is torn — maintenance called.', priority: 'HIGH' },
        { kind: 'STOCKING', body: '2 pallets of dairy left in staging.', priority: 'MEDIUM' },
      ],
    });
    await agent.post(`/ops/shifts/${first.body.shiftId}/close`).send({});

    const second = await agent
      .post('/ops/shifts/open')
      .send({ position: 'F&D Morning Shift' });
    const detail = await agent.get(`/ops/shifts/${second.body.shiftId}`);
    expect(detail.body.handoverIn).toHaveLength(2);

    const equip = detail.body.handoverIn.find(
      (h: { kind: string }) => h.kind === 'EQUIPMENT',
    );
    const carry = await agent
      .post(`/ops/handover/${equip.id}/decide`)
      .send({ action: 'CARRY', shiftId: second.body.shiftId });
    expect(carry.status).toBe(200);
    expect(carry.body.carriedTaskId).toBeTruthy();

    const after = await agent.get(`/ops/shifts/${second.body.shiftId}`);
    const carried = after.body.tasks.find(
      (t: { source: string }) => t.source === 'CARRYOVER',
    );
    expect(carried.title).toContain('Freezer door 3');
    expect(after.body.handoverIn).toHaveLength(1); // the stocking item remains
  });

  it('library edits are for leadership: supervisor 403, chairman 200; board is view:ops only', async () => {
    const client = await createClient();
    const { user: sup } = await createUser({ role: 'SHIFT_SUPERVISOR', clientId: client.id });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const supAgent = await loginAs(sup.email);
    const execAgent = await loginAs(exec.email);

    // Supervisors can READ the library (their checklists) but not edit it.
    expect((await supAgent.get('/ops/library')).status).toBe(200);
    expect(
      (
        await supAgent
          .post('/ops/library/templates')
          .send({ name: 'X', department: 'Frozen & Dairy', period: 'MORNING' })
      ).status,
    ).toBe(403);

    // The chairman's ONE write: the SOP standard.
    const created = await execAgent
      .post('/ops/library/templates')
      .send({ name: 'Chairman special walk', department: 'General Merchandise', period: 'MORNING' });
    expect(created.status).toBe(201);
    const addTask = await execAgent
      .post(`/ops/library/templates/${created.body.id}/tasks`)
      .send({ section: 'Opening', title: 'Walk the front end with the store manager' });
    expect(addTask.status).toBe(201);

    // Board: supervisors are runners, not overseers.
    expect((await supAgent.get('/ops/board')).status).toBe(403);
    expect((await execAgent.get('/ops/board')).status).toBe(200);

    // Bounded supervisor cannot open a shift for another client.
    const other = await createClient('Other Store');
    const cross = await supAgent
      .post('/ops/shifts/open')
      .send({ clientId: other.id, position: 'GM Morning Shift' });
    const opened = await prisma.opsShift.findFirst({ where: { clientId: other.id } });
    expect(cross.status).toBe(201); // clamp silently pins to their own client
    expect(opened).toBeNull();
  });
});
