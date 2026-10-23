import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptString } from '../../lib/crypto.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * HR walk 11 — nothing got a new hire ready for day one: no start date, no
 * store, no manager, a clock-in number filed under the wrong client, and an
 * I-9 task that said PENDING while both sections were recorded. The
 * first-day card reads and fixes those in one place.
 * HR walk 23 — the new-application dialog shows the pay schedule the rules
 * will put the hire on, before the hire exists.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function setup() {
  const client = await createClient('Coastal Resort');
  const other = await createClient('Elsewhere');
  const store = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  const second = await prisma.site.create({ data: { clientId: client.id, name: 'Front Beach 218' } });
  const hire = await createAssociate({ firstName: 'Maria', lastName: 'Lopez' });
  const app = await prisma.application.create({
    data: {
      associateId: hire.id,
      clientId: client.id,
      onboardingTrack: 'STANDARD',
      status: 'SUBMITTED',
      startDate: new Date('2026-11-06T00:00:00Z'), // a Friday
      checklist: {
        create: {
          tasks: {
            create: [
              { kind: 'PROFILE_INFO', title: 'Profile', order: 1, status: 'DONE' },
              { kind: 'I9_VERIFICATION', title: 'I-9', order: 2, status: 'PENDING' },
            ],
          },
        },
      },
    },
  });
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return { client, other, store, second, hire, app, a: await loginAs(agent(), user.email) };
}

describe('first day', () => {
  it('reads every first-day fact, honestly empty where nothing is set', async () => {
    const { a, app, other, store, second } = await setup();
    // A number filed under the wrong client: the kiosk would refuse it.
    await prisma.kioskPin.create({ data: { associateId: app.associateId, clientId: other.id, pinHmac: randomBytes(32) } });
    const r = await a.get(`/onboarding/applications/${app.id}/first-day`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      startDate: '2026-11-06',
      store: null,
      manager: null,
      // No readable plaintext on this row: the number reads null, never a guess.
      employeeNumber: { issued: true, clientId: other.id, validAtClient: false, number: null },
      firstShift: null,
      // Friday + 3 business days skips the weekend.
      i9: { section1CompletedAt: null, section2CompletedAt: null, section2DueBy: '2026-11-11' },
    });
    expect(r.body.stores.map((s: { id: string }) => s.id).sort()).toEqual([store.id, second.id].sort());
  });

  it('reads the clock-in number itself once it is filed for this client, so the desk can hand it over', async () => {
    const { a, app, client } = await setup();
    await prisma.kioskPin.create({
      data: { associateId: app.associateId, clientId: client.id, pinHmac: randomBytes(32), pinEncrypted: encryptString('4821') },
    });
    const r = await a.get(`/onboarding/applications/${app.id}/first-day`);
    expect(r.status).toBe(200);
    expect(r.body.employeeNumber).toEqual({ issued: true, clientId: client.id, validAtClient: true, number: '4821' });
  });

  it('finds the first booked shift from the start date', async () => {
    const { a, app, client, store } = await setup();
    await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt: new Date('2026-11-01T14:00:00Z'), endsAt: new Date('2026-11-01T22:00:00Z'), status: 'ASSIGNED', assignedAssociateId: app.associateId } });
    const first = await prisma.shift.create({ data: { clientId: client.id, locationId: store.id, position: 'Cashier', startsAt: new Date('2026-11-07T14:00:00Z'), endsAt: new Date('2026-11-07T22:00:00Z'), status: 'ASSIGNED', assignedAssociateId: app.associateId } });
    const r = await a.get(`/onboarding/applications/${app.id}/first-day`);
    expect(r.body.firstShift).toMatchObject({ id: first.id, locationName: store.name });
  });

  it('PATCH sets the start date, the store and the manager in one call', async () => {
    const { a, app, second } = await setup();
    const boss = await createAssociate({ firstName: 'Dana', lastName: 'Cruz' });
    const r = await a.patch(`/onboarding/applications/${app.id}/first-day`).send({ startDate: '2026-11-09', locationId: second.id, managerId: boss.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ startDate: '2026-11-09', store: { id: second.id }, manager: { id: boss.id, name: 'Dana Cruz' } });
    const saved = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(saved.locationId).toBe(second.id);
    expect((await prisma.associate.findUniqueOrThrow({ where: { id: app.associateId } })).managerId).toBe(boss.id);
    expect(await prisma.associateHistory.count({ where: { associateId: app.associateId, managerId: boss.id } })).toBe(1);
  });

  it('PATCH refuses another client’s store and the person as their own manager', async () => {
    const { a, app, other } = await setup();
    const elsewhere = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    expect((await a.patch(`/onboarding/applications/${app.id}/first-day`).send({ locationId: elsewhere.id })).status).toBe(400);
    expect((await a.patch(`/onboarding/applications/${app.id}/first-day`).send({ managerId: app.associateId })).status).toBe(400);
    expect((await a.patch(`/onboarding/applications/${app.id}/first-day`).send({})).status).toBe(400);
  });

  it('after approval, a store change moves the live placement', async () => {
    const { a, app, store, second } = await setup();
    await prisma.application.update({ where: { id: app.id }, data: { status: 'APPROVED', locationId: store.id } });
    await prisma.associateAssignment.create({ data: { associateId: app.associateId, locationId: store.id, startedAt: new Date('2026-01-01T00:00:00Z') } });
    const r = await a.patch(`/onboarding/applications/${app.id}/first-day`).send({ locationId: second.id });
    expect(r.status).toBe(200);
    const open = await prisma.associateAssignment.findMany({ where: { associateId: app.associateId, endedAt: null } });
    expect(open.map((o) => o.locationId)).toEqual([second.id]);
  });

  it('only the onboarding desk (manage:onboarding)', async () => {
    const { app } = await setup();
    // An executive reads onboarding but doesn't run it.
    const { user } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const r = await loginAs(agent(), user.email);
    expect((await r.get(`/onboarding/applications/${app.id}/first-day`)).status).toBe(403);
    // The recruiter owns onboarding from the first invite through the kiosk code (owner, 2026-10-22).
    const { user: recruiter } = await createUser({ role: 'INTERNAL_RECRUITER' });
    expect((await (await loginAs(agent(), recruiter.email)).get(`/onboarding/applications/${app.id}/first-day`)).status).toBe(200);
  });
});

describe('the I-9 task follows the I-9 record', () => {
  it('reads DONE (and stays DONE) once both sections are recorded', async () => {
    const { a, app } = await setup();
    const before = await a.get(`/onboarding/applications/${app.id}`);
    expect(before.body.tasks.find((t: { kind: string }) => t.kind === 'I9_VERIFICATION').status).toBe('PENDING');
    await prisma.i9Verification.create({
      data: { associateId: app.associateId, section1CompletedAt: new Date('2026-11-05T12:00:00Z'), section2CompletedAt: new Date('2026-11-06T12:00:00Z') },
    });
    const after = await a.get(`/onboarding/applications/${app.id}`);
    expect(after.body.tasks.find((t: { kind: string }) => t.kind === 'I9_VERIFICATION').status).toBe('DONE');
    expect(after.body.percentComplete).toBe(100);
    const task = await prisma.onboardingTask.findFirstOrThrow({ where: { kind: 'I9_VERIFICATION', checklist: { applicationId: app.id } } });
    expect(task.status).toBe('DONE');
  });

  it('Section 1 alone leaves it open', async () => {
    const { a, app } = await setup();
    await prisma.i9Verification.create({ data: { associateId: app.associateId, section1CompletedAt: new Date() } });
    const r = await a.get(`/onboarding/applications/${app.id}`);
    expect(r.body.tasks.find((t: { kind: string }) => t.kind === 'I9_VERIFICATION').status).toBe('PENDING');
  });
});

describe('pay schedule for a hire (HR walk 23)', () => {
  it('resolves the client rule, read-only', async () => {
    const { a, client } = await setup();
    const sched = await prisma.payrollSchedule.create({ data: { name: 'Coastal biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-05') } });
    await prisma.payrollScheduleRule.create({ data: { scheduleId: sched.id, kind: 'CLIENT', clientId: client.id, effectiveFrom: new Date('2026-01-01') } });
    const before = await prisma.payrollScheduleAssignment.count();
    const r = await a.get(`/onboarding/pay-schedule-for-hire?clientId=${client.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schedule: { id: sched.id, name: 'Coastal biweekly' }, conflict: null });
    expect(r.body.schedule.because).toMatch(/Coastal Resort/);
    expect(await prisma.payrollScheduleAssignment.count()).toBe(before);
  });

  it('answers null when no rule and no default covers the hire', async () => {
    const { a, other } = await setup();
    const r = await a.get(`/onboarding/pay-schedule-for-hire?clientId=${other.id}`);
    expect(r.body).toEqual({ schedule: null, conflict: null });
  });

  it('falls back to the company default', async () => {
    const { a, other } = await setup();
    const d = await prisma.payrollSchedule.create({ data: { name: 'Company biweekly', frequency: 'BIWEEKLY', anchorDate: new Date('2026-09-05'), isDefault: true } });
    const r = await a.get(`/onboarding/pay-schedule-for-hire?clientId=${other.id}`);
    expect(r.body.schedule).toMatchObject({ id: d.id, because: 'Company default' });
  });
});
