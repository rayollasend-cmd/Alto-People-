import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createApplicationWithChecklist, createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { localFieldglassOnTime, localShiftLeadPresence } from '../../routes/complianceScorecard.js';
import { ALTO_TENANT_ID, runWithTenant } from '../../lib/tenant.js';

/**
 * The deep audit's People fix wave (2026-10-29), onboarding and compliance:
 *
 *   PEOPLE-17  a task card said DONE while nothing was on file behind it.
 *   10-21      the stubbed POST /compliance/background and /compliance/drug-tests
 *              are gone; one person's portal order is recorded through
 *              bulk-initiate, with the provider's reference, in the caller's reach.
 *   CODE-14    a shift's day is its store's day; the Fieldglass deadline is
 *              Monday 2 PM Pacific after the store week.
 */

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function hr() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  return loginAs(agent(), user.email);
}

describe('PEOPLE-17: task status from the evidence', () => {
  it('a DONE task with nothing on file says "missing"; one with its record says "on_file"; open tasks carry nothing', async () => {
    const client = await createClient('Coastal');
    const person = await createAssociate({ firstName: 'Sophia', lastName: 'Delgado' });
    const app = await createApplicationWithChecklist({ associateId: person.id, clientId: client.id });
    const tasks = app.checklist!.tasks;
    const byKind = (k: string) => tasks.find((t) => t.kind === k)!;
    // Marked done by hand (or a seed) with nothing behind W-4 and profile;
    // the payout method is on file; policies stay open.
    await prisma.onboardingTask.updateMany({ where: { id: { in: [byKind('W4').id, byKind('PROFILE_INFO').id, byKind('DIRECT_DEPOSIT').id] } }, data: { status: 'DONE', completedAt: new Date() } });
    await prisma.payoutMethod.create({ data: { associateId: person.id, type: 'BRANCH_CARD', isPrimary: true } });
    await prisma.onboardingChecklist.update({ where: { applicationId: app.id }, data: { tasks: { create: { kind: 'I9_VERIFICATION', title: 'I-9', order: 9, status: 'DONE' } } } });

    const res = await (await hr()).get(`/onboarding/applications/${app.id}`);
    expect(res.status).toBe(200);
    const ev = Object.fromEntries((res.body.tasks as Array<{ kind: string; evidence?: string }>).map((t) => [t.kind, t.evidence ?? null]));
    expect(ev).toMatchObject({ W4: 'missing', PROFILE_INFO: 'missing', DIRECT_DEPOSIT: 'on_file', I9_VERIFICATION: 'missing', POLICY_ACK: null, DOCUMENT_UPLOAD: null });

    // The evidence arrives: the W-4 and a profile — now on file.
    await prisma.w4Submission.create({ data: { associateId: person.id, filingStatus: 'SINGLE' } });
    await prisma.associate.update({ where: { id: person.id }, data: { dob: new Date('1990-04-01'), addressLine1: '1 Main St' } });
    const again = await (await hr()).get(`/onboarding/applications/${app.id}`);
    const ev2 = Object.fromEntries((again.body.tasks as Array<{ kind: string; evidence?: string }>).map((t) => [t.kind, t.evidence ?? null]));
    expect(ev2).toMatchObject({ W4: 'on_file', PROFILE_INFO: 'on_file' });
  });
});

describe('the background-check and drug-test stubs are gone (10-21)', () => {
  it('the stub routes answer 404; one person’s portal order is recorded with its reference', async () => {
    const client = await createClient('Coastal');
    const person = await createAssociate({ firstName: 'Pat', lastName: 'Hopeful' });
    await prisma.application.create({ data: { associateId: person.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED' } });
    const a = await hr();
    expect((await a.post('/compliance/background').send({ associateId: person.id, provider: 'alto-stub' })).status).toBe(404);
    expect((await a.post('/compliance/drug-tests').send({ associateId: person.id, provider: 'checkr' })).status).toBe(404);

    const bg = await a.post('/compliance/background/bulk-initiate').send({ associateIds: [person.id], provider: 'Sterling (portal)', externalId: 'ST-9' });
    expect(bg.status).toBe(200);
    expect(bg.body).toMatchObject({ created: 1, skipped: 0 });
    expect(await prisma.backgroundCheck.findUniqueOrThrow({ where: { id: bg.body.ids[0] } })).toMatchObject({ provider: 'Sterling (portal)', externalId: 'ST-9', status: 'INITIATED', clientId: client.id });
    // A second order for someone who already has a check is skipped, not doubled.
    expect((await a.post('/compliance/background/bulk-initiate').send({ associateIds: [person.id], provider: 'Sterling (portal)' })).body).toMatchObject({ created: 0, skipped: 1 });

    const dt = await a.post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [person.id], provider: 'checkr', externalId: 'scr-1' });
    expect(dt.status).toBe(200);
    expect(await prisma.drugTest.findUniqueOrThrow({ where: { id: dt.body.ids[0] } })).toMatchObject({ externalId: 'scr-1', status: 'INITIATED' });

    // A reference belongs to one person's order.
    const other = await createAssociate({ firstName: 'Bo', lastName: 'Ray' });
    expect((await a.post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [person.id, other.id], provider: 'checkr', externalId: 'x' })).status).toBe(400);
  });

  it('records orders only for people in the caller’s reach', async () => {
    const client = await createClient('Coastal');
    const [siteA] = await prisma.site.findMany({ where: { clientId: client.id } });
    const siteB = await prisma.site.create({ data: { name: 'Bayside', clientId: client.id } });
    const atA = await createAssociate({ firstName: 'In', lastName: 'Reach' });
    const atB = await createAssociate({ firstName: 'Out', lastName: 'Ofreach' });
    await prisma.associateAssignment.create({ data: { associateId: atA.id, locationId: siteA!.id, startedAt: new Date('2026-01-01') } });
    await prisma.associateAssignment.create({ data: { associateId: atB.id, locationId: siteB.id, startedAt: new Date('2026-01-01') } });
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [siteA!.id] } });
    const ops = await loginAs(agent(), user.email);
    const r = await ops.post('/compliance/background/bulk-initiate').send({ associateIds: [atA.id, atB.id], provider: 'Sterling (portal)' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(await prisma.backgroundCheck.count({ where: { associateId: atB.id } })).toBe(0);
    expect((await ops.post('/compliance/drug-tests/bulk-initiate').send({ associateIds: [atB.id], provider: 'checkr' })).status).toBe(404);
  });
});

describe('CODE-14: the store’s day and the Fieldglass deadline', () => {
  it('an evening shift in California counts on its own day, with that day’s lead', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T18:00:00.000Z'));
    const client = await createClient('West');
    const site = (await prisma.site.findFirstOrThrow({ where: { clientId: client.id } }));
    await prisma.site.update({ where: { id: site.id }, data: { timezone: 'America/Los_Angeles' } });
    await prisma.shiftPosition.create({ data: { clientId: client.id, name: 'Shift lead', isLead: true } });
    const worker = await createAssociate();
    const base = { clientId: client.id, locationId: site.id, status: 'ASSIGNED' as const, assignedAssociateId: worker.id };
    // Oct 26 in Los Angeles: a cashier at 10 AM and the lead at 6 PM (01:00 UTC on Oct 27).
    await prisma.shift.create({ data: { ...base, position: 'Cashier', startsAt: new Date('2026-10-26T17:00:00.000Z'), endsAt: new Date('2026-10-26T23:00:00.000Z') } });
    await prisma.shift.create({ data: { ...base, position: 'Shift lead', startsAt: new Date('2026-10-27T01:00:00.000Z'), endsAt: new Date('2026-10-27T06:00:00.000Z') } });
    const pct = await runWithTenant(ALTO_TENANT_ID, 'job', () => localShiftLeadPresence(new Date('2026-10-20T00:00:00.000Z'), client.id));
    // One store day, with its lead — not two UTC days, one of them leaderless.
    expect(pct).toBe(100);
  });

  it('a store week’s timesheet is on time until Monday 2 PM Pacific', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T18:00:00.000Z'));
    const client = await createClient('North');
    const a = await createAssociate();
    const b = await createAssociate();
    // Week Sat Oct 17 – Fri Oct 23; due Mon Oct 26, 2 PM PDT = 21:00 UTC.
    await prisma.fieldglassTimesheet.create({ data: { weekStart: new Date('2026-10-17'), associateId: a.id, clientId: client.id, enteredAt: new Date('2026-10-26T20:59:00.000Z') } });
    await prisma.fieldglassTimesheet.create({ data: { weekStart: new Date('2026-10-17'), associateId: b.id, clientId: client.id, enteredAt: new Date('2026-10-26T21:01:00.000Z') } });
    const pct = await runWithTenant(ALTO_TENANT_ID, 'job', () => localFieldglassOnTime(new Date('2026-10-20T00:00:00.000Z'), client.id));
    expect(pct).toBe(50);
  });
});
