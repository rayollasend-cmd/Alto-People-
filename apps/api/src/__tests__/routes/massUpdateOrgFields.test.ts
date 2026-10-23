import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * Mass update carries cost center and job profile (F500 G1 /org): the People
 * tab of Departments & job profiles — a second list of everyone, with its
 * own bulk "assign org fields" — is gone, and its bulk edit lives in the one
 * bulk tool. A job profile move that is really a promotion (overtime
 * exemption, comp class, tipped code) stays a promotion: a batch that would
 * do it for anyone is refused, naming them.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
  const hr = await loginAs(agent(), user.email);
  const ana = await createAssociate({ firstName: 'Ana', lastName: 'Lopez' });
  const bo = await createAssociate({ firstName: 'Bo', lastName: 'Chen' });
  const front = await prisma.costCenter.create({ data: { code: '100', name: 'Front of house' } });
  const back = await prisma.costCenter.create({ data: { code: '200', name: 'Back of house' } });
  const houseman = await prisma.jobProfile.create({ data: { code: 'HSK1', title: 'Houseman' } });
  const lead = await prisma.jobProfile.create({ data: { code: 'HSK2', title: 'Housekeeping lead' } });
  const manager = await prisma.jobProfile.create({ data: { code: 'MGR', title: 'Housekeeping manager', isExempt: true } });
  await prisma.associate.updateMany({ where: { id: { in: [ana.id, bo.id] } }, data: { costCenterId: front.id, jobProfileId: houseman.id } });
  return { hr, ana, bo, front, back, houseman, lead, manager };
}

describe('mass update: cost center and job profile', () => {
  it('previews, applies and undoes a cost center and job profile change for a picked cohort', async () => {
    const w = await world();
    const body = { filter: { associateIds: [w.ana.id, w.bo.id] }, changes: { costCenterId: w.back.id, jobProfileId: w.lead.id } };
    const preview = await w.hr.post('/people/mass-update/preview').send(body);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ matched: 2, willChange: 2 });
    expect(preview.body.rows[0].changes).toEqual([
      { field: 'costCenter', from: '100 · Front of house', to: '200 · Back of house' },
      { field: 'jobProfile', from: 'Houseman', to: 'Housekeeping lead' },
    ]);
    const applied = await w.hr.post('/people/mass-update').send(body);
    expect(applied.status).toBe(201);
    expect(await prisma.associate.count({ where: { costCenterId: w.back.id, jobProfileId: w.lead.id } })).toBe(2);
    const batches = await w.hr.get('/people/mass-update/batches');
    expect(batches.body.batches[0].changes).toMatchObject({ costCenterName: '200 · Back of house', jobProfileName: 'Housekeeping lead' });
    const undo = await w.hr.post(`/people/mass-update/${applied.body.batchId}/undo`);
    expect(undo.body.restored).toBe(2);
    expect(await prisma.associate.count({ where: { costCenterId: w.front.id, jobProfileId: w.houseman.id } })).toBe(2);
  });

  it('refuses a job profile move that is a promotion, or that a waiting promotion would overtake, naming who', async () => {
    const w = await world();
    const exempt = await w.hr.post('/people/mass-update/preview').send({ filter: { associateIds: [w.ana.id, w.bo.id] }, changes: { jobProfileId: w.manager.id } });
    expect(exempt.status).toBe(409);
    expect(exempt.body.error.code).toBe('job_profile_needs_approval');
    expect(exempt.body.error.message).toContain('Ana Lopez');
    expect(await prisma.associate.count({ where: { jobProfileId: w.manager.id } })).toBe(0);

    await prisma.promotion.create({ data: { associateId: w.bo.id, jobProfileId: w.lead.id, effectiveFrom: new Date('2026-11-01') } });
    const waiting = await w.hr.post('/people/mass-update').send({ filter: { associateIds: [w.ana.id, w.bo.id] }, changes: { jobProfileId: w.lead.id } });
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.message).toContain('Bo Chen');
    expect(waiting.body.error.message).not.toContain('Ana Lopez');
    // Nothing applied: one batch, all or none.
    expect(await prisma.associate.count({ where: { jobProfileId: w.lead.id } })).toBe(0);
    // A cost center alone is never a promotion.
    expect((await w.hr.post('/people/mass-update').send({ filter: { associateIds: [w.bo.id] }, changes: { costCenterId: w.back.id } })).status).toBe(201);
  });

  it('another tenant’s cost center or job profile is not found', async () => {
    const w = await world();
    const other = await prisma.tenant.create({ data: { name: 'Other staffing', slug: `other-${Date.now()}` } });
    const theirs = await prisma.costCenter.create({ data: { tenantId: other.id, code: '900', name: 'Theirs' } });
    const res = await w.hr.post('/people/mass-update/preview').send({ filter: { associateIds: [w.ana.id] }, changes: { costCenterId: theirs.id } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('cost_center_not_found');
  });
});
