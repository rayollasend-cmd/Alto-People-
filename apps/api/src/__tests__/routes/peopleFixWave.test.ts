import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { flushScheduleRecompute } from '../../lib/payScheduleTriggers.js';
import { foldText, searchWords } from '../../lib/peopleSearch.js';

/**
 * The deep audit's People fix wave (2026-10-29), API side:
 *
 *   PEOPLE-3   the cost-centre list answered 400 for everyone when one had no client.
 *   PEOPLE-4   the workforce manager / shift supervisor couldn't load the client picker.
 *   PEOPLE-6   "Maria Lopez" found nobody on People.
 *   PEOPLE-15  candidate search says where its matches sit across stages.
 *   PEOPLE-9   mass update wrote Associate.payrollScheduleId directly.
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

async function as(role: Parameters<typeof createUser>[0]['role'], extra: { clientId?: string } = {}) {
  const { user } = await createUser({ role, ...extra });
  return loginAs(agent(), user.email);
}

describe('PEOPLE-3: cost centres with no client', () => {
  it('lists a company-wide cost centre with clientId null instead of failing the whole list', async () => {
    const client = await createClient('Coastal Resort');
    await prisma.costCenter.create({ data: { code: 'CC-900', name: 'HR office' } });
    await prisma.costCenter.create({ data: { code: 'CC-100', name: 'Front desk', clientId: client.id } });
    for (const role of ['HR_ADMINISTRATOR', 'WORKFORCE_MANAGER'] as const) {
      const res = await (await as(role)).get('/org/cost-centers');
      expect(res.status).toBe(200);
      const byCode = Object.fromEntries((res.body.costCenters as Array<{ code: string; clientId: string | null }>).map((c) => [c.code, c.clientId]));
      expect(byCode).toEqual({ 'CC-900': null, 'CC-100': client.id });
    }
  });
});

describe('PEOPLE-4 / FLOOR-1: GET /clients/options', () => {
  it('gives whoever invites the names of their clients — and nothing about money', async () => {
    const a = await createClient('Acme Hotels');
    const b = await createClient('Beacon Inn');
    const wfm = await as('WORKFORCE_MANAGER');
    // The accounts list still needs view:clients…
    expect((await wfm.get('/clients')).status).toBe(403);
    // …the picker doesn't.
    const res = await wfm.get('/clients/options');
    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: { name: string }) => c.name)).toEqual(['Acme Hotels', 'Beacon Inn']);
    expect(Object.keys(res.body.clients[0]).sort()).toEqual(['id', 'name', 'state', 'status']);

    // A shift supervisor gets their own client only.
    const sup = await as('SHIFT_SUPERVISOR', { clientId: b.id });
    const mine = await sup.get('/clients/options');
    expect(mine.status).toBe(200);
    expect(mine.body.clients.map((c: { id: string }) => c.id)).toEqual([b.id]);
    void a;
  });

  it('is refused to a role that neither invites nor reads clients', async () => {
    await createClient('Acme Hotels');
    const associate = await as('ASSOCIATE');
    expect((await associate.get('/clients/options')).status).toBe(403);
  });
});

describe('PEOPLE-6: people search finds full names, accents and phone digits', () => {
  it('folds words the way the SQL does', () => {
    expect(foldText('María López')).toBe('maria lopez');
    expect(searchWords('  López,  María ')).toEqual(['lopez', 'maria']);
  });

  it('"Maria Lopez", "lopez maria", "Lopez, María", "maría" and her phone all find her', async () => {
    const maria = await createAssociate({ firstName: 'María', lastName: 'López', email: 'maria.lopez@example.com' });
    await prisma.associate.update({ where: { id: maria.id }, data: { phone: '(555) 555-3183' } });
    await createAssociate({ firstName: 'Maria', lastName: 'Chen' });
    await createAssociate({ firstName: 'Lopez', lastName: 'Garcia' });
    const hr = await as('HR_ADMINISTRATOR');
    const names = async (q: string) => {
      const res = await hr.get('/people/directory').query({ q });
      expect(res.status).toBe(200);
      return (res.body.associates as Array<{ firstName: string; lastName: string }>).map((p) => `${p.firstName} ${p.lastName}`).sort();
    };
    expect(await names('Maria Lopez')).toEqual(['María López']);
    expect(await names('lopez maria')).toEqual(['María López']);
    expect(await names('López, María')).toEqual(['María López']);
    expect(await names('maria')).toEqual(['Maria Chen', 'María López']);
    expect(await names('555-3183')).toEqual(['María López']);
    expect(await names('5553183')).toEqual(['María López']);
    expect(await names('Maria Nobody')).toEqual([]);
    // A LIKE wildcard is a character, not a wildcard.
    expect(await names('%')).toEqual([]);
  });
});

describe('PEOPLE-15: candidate search across stages', () => {
  it('finds a full name and says how many matches sit in each stage, whatever the stage chip', async () => {
    await prisma.candidate.createMany({
      data: [
        { firstName: 'Emmanuel', lastName: 'Estrada', email: 'e1@example.com', stage: 'OFFER', phone: '555-010-3183' },
        { firstName: 'Héctor', lastName: 'Ruiz', email: 'h1@example.com', stage: 'INTERVIEW' },
        { firstName: 'Hector', lastName: 'Lee', email: 'h2@example.com', stage: 'APPLIED' },
      ],
    });
    const rc = await as('INTERNAL_RECRUITER');
    const full = await rc.get('/recruiting/candidates').query({ q: 'Emmanuel Estrada', stage: 'APPLIED' });
    expect(full.status).toBe(200);
    expect(full.body.total).toBe(0);
    expect(full.body.stageCounts).toEqual({ OFFER: 1 });

    const hector = await rc.get('/recruiting/candidates').query({ q: 'hector' });
    expect(hector.body.total).toBe(2);
    expect(hector.body.stageCounts).toEqual({ INTERVIEW: 1, APPLIED: 1 });

    const phone = await rc.get('/recruiting/candidates').query({ q: '0103183' });
    expect(phone.body.candidates.map((c: { lastName: string }) => c.lastName)).toEqual(['Estrada']);

    // No search, no counts.
    expect((await rc.get('/recruiting/candidates')).body.stageCounts).toBeUndefined();
  });
});

describe('PEOPLE-9: a mass update moves pay schedules through the engine', () => {
  const NOW = new Date('2026-10-19T15:00:00.000Z'); // Monday; Weekly periods run Sat–Fri

  async function world() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const hr = await as('HR_ADMINISTRATOR');
    const weekly = await hr.post('/payroll/pay-schedules').send({ name: 'Weekly', frequency: 'WEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7, isDefault: true });
    expect(weekly.status).toBe(201);
    const biweekly = await hr.post('/payroll/pay-schedules').send({ name: 'Biweekly', frequency: 'BIWEEKLY', anchorDate: '2026-10-03', payDateOffsetDays: 7 });
    expect(biweekly.status).toBe(201);
    const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
    await prisma.compensationRecord.create({ data: { associateId: ana.id, effectiveFrom: new Date('2026-01-01'), payType: 'HOURLY', amount: 20, reason: 'HIRE' } });
    await flushScheduleRecompute();
    return { hr, ana, weekly: weekly.body.schedule as { id: string }, biweekly: biweekly.body.schedule as { id: string } };
  }

  it('is a payroll change: the workforce manager (manage:org, no payroll) is refused', async () => {
    const w = await world();
    const wfm = await as('WORKFORCE_MANAGER');
    const body = { filter: { associateIds: [w.ana.id] }, changes: { payrollScheduleId: w.biweekly.id } };
    const res = await wfm.post('/people/mass-update/preview').send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('payroll_only');
    expect((await wfm.post('/people/mass-update').send(body)).status).toBe(403);
  });

  it('writes an INDIVIDUAL rule from a date (never the mirror), and undo ends it', async () => {
    const w = await world();
    const body = { filter: { associateIds: [w.ana.id] }, changes: { payrollScheduleId: w.biweekly.id } };
    const preview = await w.hr.post('/people/mass-update/preview').send(body);
    expect(preview.status).toBe(200);
    // The preview says when the move starts.
    expect(preview.body.rows[0].changes[0].to).toMatch(/^Biweekly from [A-Z][a-z]{2} \d{1,2}$/);

    const applied = await w.hr.post('/people/mass-update').send(body);
    expect(applied.status).toBe(201);
    const rules = await prisma.payrollScheduleRule.findMany({ where: { associateId: w.ana.id, kind: 'INDIVIDUAL' } });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.scheduleId).toBe(w.biweekly.id);
    // The assignment history has the move, so the sweep keeps it.
    const segs = await prisma.payrollScheduleAssignment.findMany({ where: { associateId: w.ana.id }, orderBy: { effectiveFrom: 'asc' } });
    expect(segs.some((s) => s.scheduleId === w.biweekly.id)).toBe(true);

    const undo = await w.hr.post(`/people/mass-update/${applied.body.batchId}/undo`);
    expect(undo.status).toBe(200);
    const after = await prisma.payrollScheduleRule.findMany({ where: { associateId: w.ana.id, kind: 'INDIVIDUAL' } });
    const live = after.filter((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom);
    expect(live.filter((r) => r.scheduleId === w.biweekly.id)).toHaveLength(0);
  });

  it('names who applied a batch, not only their email', async () => {
    const w = await world();
    const cc = await prisma.costCenter.create({ data: { code: '100', name: 'Front' } });
    expect((await w.hr.post('/people/mass-update').send({ filter: { associateIds: [w.ana.id] }, changes: { costCenterId: cc.id } })).status).toBe(201);
    const batches = await w.hr.get('/people/mass-update/batches');
    expect(batches.body.batches[0].actorName).toBeTruthy();
    expect(batches.body.batches[0].actorName).not.toContain('@');
  });
});

describe('PEOPLE-10: one hire date', () => {
  it('the directory reads the employment record, then the hire, then the planned start — and says which', async () => {
    const hr = await as('HR_ADMINISTRATOR');
    const client = await createClient('Coastal Resort');
    const employer = await prisma.employerOrganization.create({ data: { kind: 'TENANT', legalName: 'Alto HR', isDefault: true } });
    // Hired: the spell says Sep 14 while the Associate row still says Jun 2 (the audit's Aaliyah).
    const hired = await createAssociate({ firstName: 'Aaliyah', lastName: 'Brooks' });
    await prisma.associate.update({ where: { id: hired.id }, data: { hireDate: new Date('2026-06-02') } });
    await prisma.employment.create({ data: { associateId: hired.id, employerOrgId: employer.id, hireDate: new Date('2026-09-14') } });
    await prisma.application.create({ data: { associateId: hired.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'APPROVED', startDate: null } });
    // Not hired yet: the application's planned start.
    const invited = await createAssociate({ firstName: 'Ian', lastName: 'Invited' });
    await prisma.application.create({ data: { associateId: invited.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', startDate: new Date('2026-11-09') } });

    const one = await hr.get(`/people/directory/${hired.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ startDate: '2026-09-14', startDateSource: 'employment' });
    const two = await hr.get(`/people/directory/${invited.id}`);
    expect(two.body).toMatchObject({ startDate: '2026-11-09', startDateSource: 'application' });
  });
});

describe('CRAWL-3: employers of record are readable with view:org', () => {
  it('Finance reads the list (the EINs its W-2s print) but cannot add one', async () => {
    const fin = await as('FINANCE_ACCOUNTANT');
    const res = await fin.get('/admin/employers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employers)).toBe(true);
    expect((await fin.post('/admin/employers').send({ legalName: 'X LLC' })).status).toBe(403);
    // An associate still reads nothing here.
    expect((await (await as('ASSOCIATE')).get('/admin/employers')).status).toBe(403);
  });
});

describe('PEOPLE-13: an offer past its expiry is expired everywhere', () => {
  async function lapsedOffer() {
    const client = await createClient('Coastal Resort');
    const cand = await prisma.candidate.create({ data: { firstName: 'Renee', lastName: 'Bennett', email: 'renee@example.com', stage: 'OFFER' } });
    const lapsed = await prisma.offer.create({
      data: { candidateId: cand.id, clientId: client.id, jobTitle: 'Cashier', startDate: new Date('2026-10-28'), hourlyRate: 15, status: 'SENT', sentAt: new Date(Date.now() - 10 * 86_400_000), expiresAt: new Date(Date.now() - 3 * 86_400_000) },
    });
    const live = await prisma.offer.create({
      data: { candidateId: cand.id, clientId: client.id, jobTitle: 'Server', startDate: new Date('2026-11-28'), hourlyRate: 16, status: 'SENT', sentAt: new Date(), expiresAt: new Date(Date.now() + 5 * 86_400_000) },
    });
    return { cand, lapsed, live };
  }

  it('the offers list and the open-offer count read it as expired', async () => {
    const { cand, lapsed, live } = await lapsedOffer();
    const rc = await as('INTERNAL_RECRUITER');
    const summary = await rc.get('/recruiting/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.offersAwaitingReply).toBe(1);
    const list = await rc.get('/offers').query({ candidateId: cand.id });
    const byId = Object.fromEntries((list.body.offers as Array<{ id: string; status: string }>).map((o) => [o.id, o.status]));
    expect(byId).toEqual({ [lapsed.id]: 'EXPIRED', [live.id]: 'SENT' });
  });

  it('nobody can record a yes to a lapsed offer', async () => {
    const { lapsed } = await lapsedOffer();
    const rc = await as('INTERNAL_RECRUITER');
    const res = await rc.post(`/offers/${lapsed.id}/decision`).send({ decision: 'ACCEPTED' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('offer_expired');
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: lapsed.id } })).status).toBe('EXPIRED');
  });
});

describe('PEOPLE-21: the candidate timeline names people, not emails', () => {
  it('says the actor’s name and keeps the email for a tooltip', async () => {
    const { user } = await createUser({ role: 'INTERNAL_RECRUITER', email: 'sam.rivera@altohr.example' });
    await prisma.user.update({ where: { id: user.id }, data: { displayName: 'Sam Rivera' } });
    const rc = await loginAs(agent(), user.email);
    const cand = await prisma.candidate.create({ data: { firstName: 'Ana', lastName: 'Diaz', email: 'ana.d@example.com' } });
    await prisma.candidateEvent.create({ data: { candidateId: cand.id, kind: 'NOTE', body: 'Called.', actorUserId: user.id } });
    const res = await rc.get(`/recruiting/candidates/${cand.id}/events`);
    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ actorName: 'Sam Rivera', actorEmail: 'sam.rivera@altohr.example' });
  });
});
