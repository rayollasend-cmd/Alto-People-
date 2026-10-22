import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_CAPABILITIES } from '@alto-people/shared';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { agent, loginAs } from '../../../test/http.js';
import { orgDateKey } from '../../lib/timeAnomalies.js';
import { listProspects } from '../../lib/clientProspects.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { flushPendingAudits } from '../../lib/audit.js';

/**
 * The new-business pipeline (Clients → Pipeline).
 *
 *   The header's numbers are computed from what we hold and checked to the
 *   dollar: annual value = hours × rate × 52, weighted by stage (LEAD 10%,
 *   CONTACTED 25%, PROPOSAL 50%, VERBAL 80%); prospects without hours or a
 *   rate are counted as unpriced, never as $0. A move to LOST needs a
 *   reason; WON links the client it became. Reads are the caller's tenant;
 *   money is left out for a caller who cannot read client money; the
 *   executive dashboard keeps reading the same rows.
 */

const T2 = '22222222-2222-4222-8222-222222222222';
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

function dayFromToday(days: number): string {
  const d = new Date(`${orgDateKey(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A fresh address each time: the login limiter counts per account.
async function admin(email = `hr-${Math.random().toString(36).slice(2, 8)}@pipeline.example`) {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email });
  return { user, http: await loginAs(agent(), user.email) };
}

describe('the pipeline API', () => {
  it('computes the header to the dollar: weighted value, unpriced, starts in the next 90 days', async () => {
    const { http } = await admin();
    const add = async (body: Record<string, unknown>) => {
      const r = await http.post('/client-prospects').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body.id as string;
    };
    await add({ name: 'Harbor Hotel', estWeeklyHours: 200, estBillRate: 22, expectedStartDate: dayFromToday(10) }); // LEAD
    await add({ name: 'Gulf Logistics', stage: 'PROPOSAL', estWeeklyHours: 100, estBillRate: 30, expectedStartDate: dayFromToday(100) });
    await add({ name: 'Bay Foods', stage: 'VERBAL', estWeeklyHours: 40, estBillRate: 25 });
    await add({ name: 'Pine Resort', stage: 'CONTACTED', estWeeklyHours: 80 }); // no rate: unpriced
    const client = await createClient('Sand Dollar Inn');
    await add({ name: 'Sand Dollar Inn', stage: 'WON', estWeeklyHours: 60, estBillRate: 20, expectedStartDate: dayFromToday(30), wonClientId: client.id });
    await add({ name: 'Old Mill', stage: 'LOST', lostReason: 'Went with the incumbent.', estWeeklyHours: 500, estBillRate: 40, expectedStartDate: dayFromToday(5) });
    await add({ name: 'Past Start Co', stage: 'LEAD', expectedStartDate: dayFromToday(-3) });

    const r = await http.get('/client-prospects');
    expect(r.status).toBe(200);
    expect(r.body.money).toBe(true);
    expect(r.body.canWrite).toBe(true);
    expect(r.body.weights).toEqual({ LEAD: 0.1, CONTACTED: 0.25, PROPOSAL: 0.5, VERBAL: 0.8 });
    // Open = LEAD×2, CONTACTED, PROPOSAL, VERBAL.
    expect(r.body.totals.open).toBe(5);
    expect(r.body.totals.unpriced).toBe(2); // Pine Resort (no rate), Past Start Co (nothing)
    // 200×22×52×0.1 + 100×30×52×0.5 + 40×25×52×0.8 = 22,880 + 78,000 + 41,600
    expect(r.body.totals.weightedValue).toBe(142_480);
    expect(r.body.totals.unweightedValue).toBe(228_800 + 156_000 + 52_000);
    // Harbor (open, +10) and Sand Dollar (won, +30); not Gulf (+100), Old Mill (lost), Past Start (-3).
    expect(r.body.totals.startsNext90).toBe(2);
    expect(r.body.totals.startsNext90Won).toBe(1);

    const harbor = r.body.prospects.find((p: { name: string }) => p.name === 'Harbor Hotel');
    expect(harbor).toMatchObject({ stage: 'LEAD', annualValue: 228_800, weightedValue: 22_880, estBillRate: 22, daysInStage: 0, expectedStartDate: dayFromToday(10) });
    const won = r.body.prospects.find((p: { name: string }) => p.name === 'Sand Dollar Inn');
    expect(won).toMatchObject({ stage: 'WON', wonClientId: client.id, wonClientName: 'Sand Dollar Inn', weightedValue: null, annualValue: 62_400 });
    const pine = r.body.prospects.find((p: { name: string }) => p.name === 'Pine Resort');
    expect(pine.annualValue).toBeNull();
    expect(pine.weightedValue).toBeNull();
  });

  it('a stage move restarts days in stage; LOST needs a reason and leaving LOST clears it', async () => {
    const { http } = await admin();
    const id = (await http.post('/client-prospects').send({ name: 'Harbor Hotel', estWeeklyHours: 10, estBillRate: 20 })).body.id as string;
    await prisma.clientProspect.update({ where: { id }, data: { stageChangedAt: new Date(Date.now() - 12 * DAY - 3_600_000) } });
    expect((await http.get(`/client-prospects/${id}`)).body.daysInStage).toBe(12);

    // An edit that is not a move keeps the clock.
    const edited = await http.patch(`/client-prospects/${id}`).send({ notes: 'Met the GM.' });
    expect(edited.status).toBe(200);
    expect(edited.body.daysInStage).toBe(12);

    const moved = await http.patch(`/client-prospects/${id}`).send({ stage: 'CONTACTED' });
    expect(moved.status).toBe(200);
    expect(moved.body.stage).toBe('CONTACTED');
    expect(moved.body.daysInStage).toBe(0);
    await flushPendingAudits();
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'client_prospect.stage_changed' } });
    expect(audit?.metadata).toMatchObject({ from: 'LEAD', to: 'CONTACTED' });

    const noReason = await http.patch(`/client-prospects/${id}`).send({ stage: 'LOST' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe('lost_reason_required');
    const blank = await http.patch(`/client-prospects/${id}`).send({ stage: 'LOST', lostReason: '   ' });
    expect(blank.status).toBe(400);

    const lost = await http.patch(`/client-prospects/${id}`).send({ stage: 'LOST', lostReason: 'Price too high.' });
    expect(lost.status).toBe(200);
    expect(lost.body).toMatchObject({ stage: 'LOST', lostReason: 'Price too high.' });

    const reopened = await http.patch(`/client-prospects/${id}`).send({ stage: 'LEAD' });
    expect(reopened.body).toMatchObject({ stage: 'LEAD', lostReason: null });
  });

  it('WON links the client it became; only a won prospect links; leaving WON unlinks', async () => {
    const { http } = await admin();
    const id = (await http.post('/client-prospects').send({ name: 'Bay Foods', stage: 'VERBAL', contactEmail: 'gm@bayfoods.example' })).body.id as string;
    // The page's flow: create the client, then mark the prospect won with it.
    const client = await http.post('/clients').send({ name: 'Bay Foods', contactEmail: 'gm@bayfoods.example' });
    expect(client.status).toBe(201);

    const notWon = await http.patch(`/client-prospects/${id}`).send({ wonClientId: client.body.id });
    expect(notWon.status).toBe(400);
    expect(notWon.body.error.code).toBe('won_client_needs_won');

    const won = await http.patch(`/client-prospects/${id}`).send({ stage: 'WON', wonClientId: client.body.id });
    expect(won.status, JSON.stringify(won.body)).toBe(200);
    expect(won.body).toMatchObject({ stage: 'WON', wonClientId: client.body.id, wonClientName: 'Bay Foods', contactEmail: 'gm@bayfoods.example' });
    const row = await prisma.clientProspect.findUniqueOrThrow({ where: { id } });
    expect(row.wonClientId).toBe(client.body.id);

    // Another tenant's client cannot be linked.
    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const foreign = await prisma.client.create({ data: { name: 'Elsewhere', tenantId: T2 } });
    const cross = await http.patch(`/client-prospects/${id}`).send({ stage: 'WON', wonClientId: foreign.id });
    expect(cross.status).toBe(400);
    expect(cross.body.error.code).toBe('invalid_client');

    // Reopening unlinks.
    const back = await http.patch(`/client-prospects/${id}`).send({ stage: 'VERBAL' });
    expect(back.body).toMatchObject({ stage: 'VERBAL', wonClientId: null });
  });

  it('owners: only accounts that can work the pipeline, named; the owner comes back on the card', async () => {
    const { user, http } = await admin();
    await prisma.user.update({ where: { id: user.id }, data: { displayName: 'Rosa Ortiz' } });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const person = await createAssociate({ firstName: 'Ann', lastName: 'Worker' });
    const { user: assoc } = await createUser({ role: 'ASSOCIATE', associateId: person.id });

    const owners = await http.get('/client-prospects/owners');
    expect(owners.status).toBe(200);
    const ids = owners.body.owners.map((o: { id: string }) => o.id);
    expect(ids).toContain(user.id);
    expect(ids).not.toContain(exec.id); // reads, never works it
    expect(ids).not.toContain(assoc.id);

    const bad = await http.post('/client-prospects').send({ name: 'Harbor Hotel', ownerUserId: assoc.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_owner');

    const ok = await http.post('/client-prospects').send({ name: 'Harbor Hotel', ownerUserId: user.id, contactName: 'Dana Fox' });
    expect(ok.status).toBe(201);
    const row = (await http.get(`/client-prospects/${ok.body.id}`)).body;
    expect(row).toMatchObject({ ownerUserId: user.id, ownerName: 'Rosa Ortiz', contactName: 'Dana Fox' });
  });

  it('capabilities: executives read but never write; finance, portal and store-bound accounts are turned away', async () => {
    const { http: hr } = await admin();
    const created = await hr.post('/client-prospects').send({ name: 'Harbor Hotel' });
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const execHttp = await loginAs(agent(), exec.email);
    expect((await execHttp.get('/client-prospects')).status).toBe(200);
    expect((await execHttp.get('/client-prospects')).body.canWrite).toBe(false);
    expect((await execHttp.post('/client-prospects').send({ name: 'Nope' })).status).toBe(403);
    expect((await execHttp.patch(`/client-prospects/${created.body.id}`).send({ stage: 'VERBAL' })).status).toBe(403);
    expect((await execHttp.delete(`/client-prospects/${created.body.id}`)).status).toBe(403);

    const { user: fin } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    expect((await (await loginAs(agent(), fin.email)).get('/client-prospects')).status).toBe(403);

    const client = await createClient('Coastal Resort');
    const { user: portal } = await createUser({ role: 'CLIENT_PORTAL', clientId: client.id });
    expect((await (await loginAs(agent(), portal.email)).get('/client-prospects')).status).toBe(403);

    // An ops manager narrowed to one store holds manage:clients, but the
    // pipeline is the whole company's: refused, like the executive layer.
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: client.id } });
    const { user: ops } = await createUser({ role: 'OPERATIONS_MANAGER' });
    await prisma.user.update({ where: { id: ops.id }, data: { scopeSiteIds: [site.id] } });
    const scoped = await (await loginAs(agent(), ops.email)).get('/client-prospects');
    expect(scoped.status).toBe(403);
    expect(scoped.body.error.code).toBe('scope_too_narrow');

    // Delete is soft and the row leaves the board.
    expect((await hr.delete(`/client-prospects/${created.body.id}`)).status).toBe(200);
    expect((await hr.get('/client-prospects')).body.prospects).toHaveLength(0);
  });

  it('money is left out (not zero) for a caller who cannot read client money', async () => {
    // A custom role: the HR archetype without the money capabilities.
    const caps = [...ROLE_CAPABILITIES.HR_ADMINISTRATOR].filter((c) => c !== 'view:executive' && c !== 'process:payroll');
    const role = await prisma.tenantRole.create({ data: { name: 'Account desk', archetype: 'HR_ADMINISTRATOR', capabilities: caps } });
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'desk@pipeline.example' });
    await prisma.user.update({ where: { id: user.id }, data: { tenantRoleId: role.id } });
    const http = await loginAs(agent(), user.email);
    expect((await http.post('/client-prospects').send({ name: 'Harbor Hotel', estWeeklyHours: 200, estBillRate: 22 })).status).toBe(201);
    const r = await http.get('/client-prospects');
    expect(r.status).toBe(200);
    expect(r.body.money).toBe(false);
    expect(r.body.totals).not.toHaveProperty('weightedValue');
    expect(r.body.totals).not.toHaveProperty('unweightedValue');
    expect(r.body.totals.open).toBe(1);
    expect(r.body.prospects[0]).not.toHaveProperty('estBillRate');
    expect(r.body.prospects[0]).not.toHaveProperty('annualValue');
    expect(r.body.prospects[0]).not.toHaveProperty('weightedValue');
    expect(r.body.prospects[0].estWeeklyHours).toBe(200);

    // The library says the same without HTTP.
    const lib = await listProspects(ALTO_TENANT_ID, { read: true, write: false, money: false });
    expect(lib.totals.weightedValue).toBeUndefined();
  });

  it('tenants never see or touch each other’s pipeline', async () => {
    const { http: alto } = await admin('hr@alto.example');
    const altoId = (await alto.post('/client-prospects').send({ name: 'Alto Prospect', estWeeklyHours: 10, estBillRate: 10 })).body.id as string;

    await prisma.tenant.create({ data: { id: T2, slug: 'tenant-two', name: 'Tenant Two' } });
    const { user: twoAdmin } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'hr@tenant-two.example' });
    await prisma.user.update({ where: { id: twoAdmin.id }, data: { tenantId: T2 } });
    const two = await loginAs(agent(), twoAdmin.email);
    const twoCreated = await two.post('/client-prospects').send({ name: 'Two Prospect', estWeeklyHours: 1, estBillRate: 1 });
    expect(twoCreated.status).toBe(201);
    expect((await prisma.clientProspect.findUniqueOrThrow({ where: { id: twoCreated.body.id } })).tenantId).toBe(T2);

    const twoList = await two.get('/client-prospects');
    expect(twoList.body.prospects.map((p: { name: string }) => p.name)).toEqual(['Two Prospect']);
    expect(twoList.body.totals.open).toBe(1);
    expect((await two.get(`/client-prospects/${altoId}`)).status).toBe(404);
    expect((await two.patch(`/client-prospects/${altoId}`).send({ stage: 'VERBAL' })).status).toBe(404);
    expect((await two.delete(`/client-prospects/${altoId}`)).status).toBe(404);
    // Tenant one's owner cannot own tenant two's prospect.
    const { user: altoHr } = await createUser({ role: 'HR_ADMINISTRATOR', email: 'other@alto.example' });
    expect((await two.post('/client-prospects').send({ name: 'Cross Owner', ownerUserId: altoHr.id })).status).toBe(400);
    expect((await two.get('/client-prospects/owners')).body.owners.map((o: { id: string }) => o.id)).toEqual([twoAdmin.id]);

    const altoList = await alto.get('/client-prospects');
    expect(altoList.body.prospects.map((p: { name: string }) => p.name)).toEqual(['Alto Prospect']);
    expect((await prisma.clientProspect.findUniqueOrThrow({ where: { id: altoId } })).stage).toBe('LEAD');
  });

  it('the executive dashboard keeps reading the same rows, and its writes keep the stage rules', async () => {
    const { http } = await admin();
    const id = (await http.post('/client-prospects').send({ name: 'Target PCB', estWeeklyHours: 200, estBillRate: 22, ownerUserId: null })).body.id as string;
    const { user: exec } = await createUser({ role: 'EXECUTIVE_CHAIRMAN' });
    const execHttp = await loginAs(agent(), exec.email);
    const list = await execHttp.get('/executive/prospects');
    expect(list.status).toBe(200);
    expect(list.body.prospects).toEqual([
      expect.objectContaining({ id, name: 'Target PCB', stage: 'LEAD', estWeeklyHours: 200, estBillRate: 22 }),
    ]);

    await prisma.clientProspect.update({ where: { id }, data: { stageChangedAt: new Date(Date.now() - 5 * DAY) } });
    expect((await http.patch(`/executive/prospects/${id}`).send({ stage: 'VERBAL' })).status).toBe(200);
    const row = await prisma.clientProspect.findUniqueOrThrow({ where: { id } });
    expect(row.stage).toBe('VERBAL');
    expect(Date.now() - row.stageChangedAt.getTime()).toBeLessThan(60_000);
    expect((await http.patch(`/executive/prospects/${id}`).send({ stage: 'LOST' })).status).toBe(400);
    // And the morning brief still finds the verbal prospect.
    const brief = await execHttp.get('/executive/briefing');
    expect((brief.body.decisions as Array<{ key: string }>).some((d) => d.key === `prospect:verbal:${id}`)).toBe(true);
  });
});
