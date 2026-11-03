import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { coverageOf } from '../../lib/credentialCoverage.js';
import { workAuthorizationFor } from '../../lib/workAuthorization.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { orgDateKey, utcInstantOfLocalMidnight } from '../../lib/timeAnomalies.js';
import { addDaysToKey } from '../../lib/timezone.js';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * The Cleared to work tab (owner, 2026-11-03): GET /compliance/cleared
 * opens on the current workforce in the caller's reach, one row per person
 * with each check's state; the exceptions queue puts blockers and shifts
 * booked past them first; the Inbox count is the tab's "scheduled" filter;
 * requirements gain background-check and drug-test kinds with a maximum
 * age; and the J-1 tab reads the same program end, flags shifts and punches
 * after it, and counts the last day as 0.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const TZ = 'America/New_York';
const today = () => orgDateKey(new Date());
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
function shiftOn(offset: number) {
  const midnight = utcInstantOfLocalMidnight(addDaysToKey(today(), offset), TZ);
  return { startsAt: new Date(midnight.getTime() + 10 * 3_600_000), endsAt: new Date(midnight.getTime() + 18 * 3_600_000) };
}

async function twoStores() {
  const client = await createClient('Bay Resort');
  const north = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
  await prisma.site.update({ where: { id: north.id }, data: { timezone: TZ } });
  const south = await prisma.site.create({ data: { name: 'South Store', clientId: client.id, timezone: TZ } });
  const at = async (first: string, siteId: string) => {
    const a = await createAssociate({ firstName: first, lastName: 'Person' });
    await prisma.application.create({ data: { associateId: a.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', approvedAt: new Date() } });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: siteId, startedAt: day('2026-01-05') } });
    await prisma.i9Verification.create({ data: { associateId: a.id, citizenshipStatus: 'US_CITIZEN', section1CompletedAt: new Date(), section2CompletedAt: new Date(), eVerifyStatus: 'EMPLOYMENT_AUTHORIZED', eVerifyCaseNumber: `C-${first}` } });
    return a;
  };
  return { client, north, south, at };
}

type Row = { associateId: string; standing: string; workStatus: string | null; workAuth: { state: string }; j1: { state: string; date: string | null }; scheduledAfterBlock: Array<{ id: string }> };

describe('GET /compliance/cleared', () => {
  it('opens on the current workforce, counts every group, and says who is cleared, needs attention or is not', async () => {
    const w = await twoStores();
    const ok = await w.at('Ok', w.north.id);
    // Ended work authorization, still on a shift next week.
    const ended = await w.at('Ended', w.north.id);
    await prisma.i9Verification.update({ where: { associateId: ended.id }, data: { citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day(addDaysToKey(today(), -2)) } });
    const booked = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cook', ...shiftOn(4), status: 'ASSIGNED', assignedAssociateId: ended.id, publishedAt: new Date() } });
    // Ending in 10 days: needs attention.
    const ending = await w.at('Ending', w.north.id);
    await prisma.i9Verification.update({ where: { associateId: ending.id }, data: { citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day(addDaysToKey(today(), 10)) } });
    // Paused and separated people are not on the default list.
    const paused = await w.at('Paused', w.north.id);
    await prisma.associate.update({ where: { id: paused.id }, data: { deactivatedAt: new Date() } });
    const gone = await w.at('Gone', w.north.id);
    await prisma.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date() } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);
    const r = await hr.get('/compliance/cleared');
    expect(r.status).toBe(200);
    expect(r.body.workforce).toBe('current');
    expect(r.body.workforceCounts).toMatchObject({ current: 3, paused: 1, former: 1, all: 5 });
    const rows = r.body.rows as Row[];
    expect(rows.map((x) => x.associateId).sort()).toEqual([ok.id, ended.id, ending.id].sort());
    const by = new Map(rows.map((x) => [x.associateId, x]));
    expect(by.get(ok.id)!.standing).toBe('CLEARED');
    expect(by.get(ok.id)!.workAuth.state).toBe('not_required');
    expect(by.get(ended.id)!.standing).toBe('NOT_CLEARED');
    expect(by.get(ended.id)!.scheduledAfterBlock.map((s) => s.id)).toEqual([booked.id]);
    expect(by.get(ending.id)!.standing).toBe('NEEDS_ATTENTION');

    // The queue: the blocker and the booked shift first, then the warning.
    const queue = r.body.exceptions as Array<{ severity: string; associateId: string; shift: { id: string } | null; fixLink: string }>;
    expect(queue.slice(0, 2).map((e) => e.severity).sort()).toEqual(['blocker', 'scheduled']);
    expect(queue.find((e) => e.severity === 'scheduled')!.shift!.id).toBe(booked.id);
    expect(queue.find((e) => e.severity === 'warning')!.associateId).toBe(ending.id);
    expect(queue.find((e) => e.severity === 'blocker')!.fixLink).toContain(`tab=i9&associateId=${ended.id}`);

    const pausedOnly = await hr.get('/compliance/cleared?workforce=paused');
    expect((pausedOnly.body.rows as Row[]).map((x) => x.associateId)).toEqual([paused.id]);
  });

  it('a store-bound manager sees only their store', async () => {
    const w = await twoStores();
    const mine = await w.at('North', w.north.id);
    const theirs = await w.at('South', w.south.id);
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [w.north.id] } });
    const ops = await loginAs(agent(), user.email);
    const r = await ops.get('/compliance/cleared');
    expect(r.status).toBe(200);
    const ids = (r.body.rows as Row[]).map((x) => x.associateId);
    expect(ids).toEqual([mine.id]);
    expect(JSON.stringify(r.body)).not.toContain(theirs.id);
    expect(r.body.workforceCounts.all).toBe(1);
  });

  it('lists the overrides of the last 90 days', async () => {
    const w = await twoStores();
    const a = await w.at('Over', w.north.id);
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    await prisma.auditLog.create({
      data: { actorUserId: user.id, action: 'work_authorization.override', entityType: 'Shift', entityId: a.id, metadata: { associateId: a.id, shiftId: a.id, reason: 'Receipt notice on file', blockers: [{ kind: 'WORK_AUTH_ENDED' }] } },
    });
    const hr = await loginAs(agent(), user.email);
    const r = await hr.get('/compliance/cleared');
    expect(r.body.overrides).toEqual([expect.objectContaining({ associateId: a.id, associateName: 'Over Person', reason: 'Receipt notice on file', blockerKind: 'WORK_AUTH_ENDED' })]);
  });
});

describe('Inbox: Scheduled but not cleared to work', () => {
  it('counts the current people booked past their end, and links to exactly that view', async () => {
    const w = await twoStores();
    const ended = await w.at('Ended', w.north.id);
    await prisma.i9Verification.update({ where: { associateId: ended.id }, data: { citizenshipStatus: 'ALIEN_AUTHORIZED_TO_WORK', workAuthExpiresAt: day(addDaysToKey(today(), 1)) } });
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cook', ...shiftOn(3), status: 'ASSIGNED', assignedAssociateId: ended.id, publishedAt: new Date() } });
    // A J-1 past the program end, booked — but paused: not the current workforce.
    const j1 = await w.at('Jay', w.north.id);
    await prisma.j1Profile.create({ data: { associateId: j1.id, programStartDate: day('2026-05-01'), programEndDate: day(addDaysToKey(today(), -1)), ds2019Number: 'N9', sponsorAgency: 'S', country: 'Chile' } });
    await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cook', ...shiftOn(2), status: 'ASSIGNED', assignedAssociateId: j1.id, publishedAt: new Date() } });
    await prisma.associate.update({ where: { id: j1.id }, data: { deactivatedAt: new Date() } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);
    const inbox = await hr.get('/me/inbox');
    const src = (inbox.body.sources as Array<{ key: string; count: number; path: string; urgency: string }>).find((s) => s.key === 'scheduled-not-cleared')!;
    expect(src.count).toBe(1);
    expect(src.urgency).toBe('legal');
    const q = new URLSearchParams(src.path.split('?')[1]);
    expect(q.get('tab')).toBe('cleared');
    expect(q.get('workforce')).toBe('current');
    expect(q.get('status')).toBe('scheduled');

    const tab = await hr.get(`/compliance/cleared?workforce=${q.get('workforce')}`);
    expect((tab.body.rows as Row[]).filter((x) => x.scheduledAfterBlock.length > 0).map((x) => x.associateId)).toEqual([ended.id]);
  });
});

describe('requirements: background checks and drug tests with a maximum age', () => {
  it('HR sets one on a client; coverage counts the latest passed one within the age; a target kind may not carry an age', async () => {
    const w = await twoStores();
    const fresh = await w.at('Fresh', w.north.id);
    const stale = await w.at('Stale', w.north.id);
    await prisma.backgroundCheck.create({ data: { associateId: fresh.id, provider: 'manual', status: 'PASSED', completedAt: new Date(Date.now() - 30 * 86_400_000) } });
    await prisma.backgroundCheck.create({ data: { associateId: stale.id, provider: 'manual', status: 'PASSED', completedAt: new Date(Date.now() - 400 * 86_400_000) } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);

    const bad = await hr.post('/credential-requirements').send({ clientId: w.client.id, kind: 'VACCINATION', vaccinationKind: 'TB_TEST', maxAgeDays: 30, label: 'TB test' });
    expect(bad.status).toBe(400);
    const made = await hr.post('/credential-requirements').send({ clientId: w.client.id, kind: 'BACKGROUND_CHECK', maxAgeDays: 365, label: 'Yearly background check' });
    expect(made.status).toBe(201);
    const list = await hr.get('/credential-requirements');
    expect(list.body.requirements).toEqual([expect.objectContaining({ kind: 'BACKGROUND_CHECK', maxAgeDays: 365, clientId: w.client.id })]);

    const req = await prisma.credentialRequirement.findUniqueOrThrow({ where: { id: made.body.id } });
    const cov = await coverageOf(prisma, ALTO_TENANT_ID, req, new Date());
    expect(cov.population.sort()).toEqual([fresh.id, stale.id].sort());
    expect(cov.missing).toEqual([stale.id]);

    const tab = await hr.get('/compliance/cleared');
    const by = new Map((tab.body.rows as Array<Row & { background: { state: string } }>).map((x) => [x.associateId, x]));
    expect(by.get(fresh.id)!.background.state).toBe('done');
    expect(by.get(stale.id)!.background.state).toBe('late');
    expect(by.get(stale.id)!.standing).toBe('NEEDS_ATTENTION');
  });
});

describe('company-wide requirements (owner, 2026-11-03: every client requires a background check and a drug test)', () => {
  it('a requirement with no site and no client counts everyone placed anywhere, and applies to people placed nowhere', async () => {
    const w = await twoStores();
    const other = await createClient('Other Client');
    const otherSite = await prisma.site.findFirstOrThrow({ where: { clientId: other.id } });
    const north = await w.at('North', w.north.id);
    const elsewhere = await w.at('Elsewhere', otherSite.id);
    await prisma.backgroundCheck.create({ data: { associateId: north.id, provider: 'manual', status: 'PASSED', completedAt: new Date() } });
    const unplaced = await createAssociate({ firstName: 'No', lastName: 'Place' });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);
    const made = await hr.post('/credential-requirements').send({ companyWide: true, kind: 'BACKGROUND_CHECK', label: 'Background check' });
    expect(made.status).toBe(201);
    const both = await hr.post('/credential-requirements').send({ companyWide: true, clientId: w.client.id, kind: 'DRUG_TEST', label: 'Drug test' });
    expect(both.status).toBe(400);
    const list = await hr.get('/credential-requirements');
    expect(list.body.requirements).toEqual([expect.objectContaining({ kind: 'BACKGROUND_CHECK', locationId: null, clientId: null, place: 'Every client' })]);

    const req = await prisma.credentialRequirement.findUniqueOrThrow({ where: { id: made.body.id } });
    const cov = await coverageOf(prisma, ALTO_TENANT_ID, req, new Date());
    expect(cov.population.sort()).toEqual([north.id, elsewhere.id].sort());
    expect(cov.missing).toEqual([elsewhere.id]);

    const r = await workAuthorizationFor(prisma, [north.id, elsewhere.id, unplaced.id], new Date());
    expect(r.get(north.id)!.cells.background.state).toBe('done');
    expect(r.get(elsewhere.id)!.cells.background.state).toBe('missing');
    expect(r.get(unplaced.id)!.cells.background.state).toBe('missing');
    // Missing screening is a warning, never a block.
    expect(r.get(unplaced.id)!.cleared).toBe(true);
    expect(r.get(unplaced.id)!.warnings.map((x) => x.kind)).toContain('BACKGROUND_REQUIRED');
  });

  it("the migration's seed adds Alto HR's two company-wide requirements once — running it again adds nothing", async () => {
    const sql = readFileSync(fileURLToPath(new URL('../../../prisma/migrations/20270212100000_cleared_to_work/migration.sql', import.meta.url)), 'utf8');
    const insert = sql.slice(sql.indexOf('INSERT INTO "CredentialRequirement"'));
    expect(insert.trim().endsWith(';')).toBe(true);
    await prisma.$executeRawUnsafe(insert);
    await prisma.$executeRawUnsafe(insert);
    const rows = await prisma.credentialRequirement.findMany({ where: { deletedAt: null }, select: { tenantId: true, kind: true, locationId: true, clientId: true, maxAgeDays: true } });
    expect(rows.map((r) => r.kind).sort()).toEqual(['BACKGROUND_CHECK', 'DRUG_TEST']);
    for (const r of rows) expect(r).toMatchObject({ tenantId: ALTO_TENANT_ID, locationId: null, clientId: null, maxAgeDays: null });
  });
});

describe('the J-1 tab', () => {
  it('opens on the current workforce, reads the later program end, counts the last day as 0, and flags shifts and punches after the end', async () => {
    const w = await twoStores();
    // Ends today: 0 days left, and a shift booked tomorrow is after the end.
    const last = await w.at('Last', w.north.id);
    await prisma.j1Profile.create({ data: { associateId: last.id, programStartDate: day('2026-05-01'), programEndDate: day(today()), ds2019Number: 'N1', sponsorAgency: 'S', country: 'Peru' } });
    const tomorrow = await prisma.shift.create({ data: { clientId: w.client.id, locationId: w.north.id, position: 'Cook', ...shiftOn(1), status: 'ASSIGNED', assignedAssociateId: last.id, publishedAt: new Date() } });
    // Ended a week ago and clocked in since.
    const worked = await w.at('Worked', w.north.id);
    await prisma.j1Profile.create({ data: { associateId: worked.id, programStartDate: day('2026-05-01'), programEndDate: day(addDaysToKey(today(), -7)), ds2019Number: 'N2', sponsorAgency: 'S', country: 'Peru' } });
    const punchAt = new Date(utcInstantOfLocalMidnight(addDaysToKey(today(), -2), TZ).getTime() + 14 * 3_600_000);
    await prisma.timeEntry.create({ data: { associateId: worked.id, clientId: w.client.id, locationId: w.north.id, clockInAt: punchAt, clockOutAt: new Date(punchAt.getTime() + 4 * 3_600_000), status: 'COMPLETED' } });
    // The profile says it ended, an open Program record says it was extended.
    const extended = await w.at('Extended', w.north.id);
    await prisma.j1Profile.create({ data: { associateId: extended.id, programStartDate: day('2026-05-01'), programEndDate: day(addDaysToKey(today(), -3)), ds2019Number: 'N3', sponsorAgency: 'S', country: 'Peru' } });
    await prisma.program.create({ data: { associateId: extended.id, type: 'J1_SWT', programStart: day('2026-05-01'), programEnd: day(addDaysToKey(today(), 40)), ds2019ExpiresOn: day(addDaysToKey(today(), 40)), gracePeriodDays: 30 } });
    // Separated: on the Former chip only.
    const gone = await w.at('Gone', w.north.id);
    await prisma.j1Profile.create({ data: { associateId: gone.id, programStartDate: day('2026-05-01'), programEndDate: day('2026-09-01'), ds2019Number: 'N4', sponsorAgency: 'S', country: 'Peru' } });
    await prisma.associate.update({ where: { id: gone.id }, data: { separatedAt: new Date() } });

    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const hr = await loginAs(agent(), user.email);
    const r = await hr.get('/compliance/j1');
    expect(r.status).toBe(200);
    expect(r.body.workforce).toBe('current');
    expect(r.body.workforceCounts).toMatchObject({ current: 3, former: 1, all: 4 });
    const by = new Map((r.body.profiles as Array<Record<string, unknown> & { associateId: string }>).map((p) => [p.associateId, p]));
    expect(by.has(gone.id)).toBe(false);
    expect(by.get(last.id)).toMatchObject({ daysUntilEnd: 0, programEndSource: 'profile', workStatus: 'ACTIVE' });
    expect((by.get(last.id)!.scheduledAfterEnd as { id: string }).id).toBe(tomorrow.id);
    expect((by.get(last.id)!.nextShift as { id: string }).id).toBe(tomorrow.id);
    expect(by.get(worked.id)).toMatchObject({ daysUntilEnd: -7, workedAfterEndOn: addDaysToKey(today(), -2), scheduledAfterEnd: null });
    expect(by.get(extended.id)).toMatchObject({ programEndDate: addDaysToKey(today(), 40), programEndSource: 'program', daysUntilEnd: 40, graceEndsOn: addDaysToKey(today(), 70) });

    const former = await hr.get('/compliance/j1?workforce=former');
    expect((former.body.profiles as Array<{ associateId: string }>).map((p) => p.associateId)).toEqual([gone.id]);
  });

  it('a J-1 write outside the caller’s reach is a 404', async () => {
    const w = await twoStores();
    const south = await w.at('South', w.south.id);
    const { user } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: user.id }, data: { scopeSiteIds: [w.north.id] } });
    const ops = await loginAs(agent(), user.email);
    const body = { programStartDate: '2026-05-01', programEndDate: '2026-09-30', ds2019Number: 'N5', sponsorAgency: 'S', country: 'Peru' };
    const r = await ops.post(`/compliance/j1/${south.id}`).send(body);
    expect(r.status).toBe(404);
    expect(await prisma.j1Profile.count({ where: { associateId: south.id } })).toBe(0);
    const mine = await w.at('North', w.north.id);
    const ok = await ops.post(`/compliance/j1/${mine.id}`).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ associateId: mine.id, programEndDate: '2026-09-30' });
  });
});
