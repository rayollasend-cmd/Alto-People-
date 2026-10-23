import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';

/**
 * System audit #16: the Internal Recruiter held the full admin capability
 * set, so its curated menu hid SSN reveal, role changes and API keys that a
 * typed URL still reached. It now has its own charter — the hiring funnel,
 * the whole onboarding desk (invite, document approval, compliance, kiosk
 * code — the owner's correction of 2026-10-22), reads of people — and the
 * server refuses everything else. These are the URLs the audit named.
 */

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function recruiter() {
  const { user } = await createUser({ role: 'INTERNAL_RECRUITER', email: `rec-${Math.random().toString(36).slice(2, 8)}@example.com` });
  return loginAs(agent(), user.email);
}

describe('the recruiter is refused outside recruiting', () => {
  it('cannot reveal an SSN', async () => {
    const a = await recruiter();
    const person = await createAssociate();
    const r = await a.post(`/org/associates/${person.id}/ssn/reveal`).send({ reason: 'checking' });
    expect(r.status).toBe(403);
  });

  it('cannot change anyone’s role or read the user list', async () => {
    const a = await recruiter();
    const { user: other } = await createUser({ role: 'FINANCE_ACCOUNTANT' });
    const patch = await a.patch(`/admin/users/${other.id}`).send({ role: 'HR_ADMINISTRATOR' });
    expect(patch.status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).role).toBe('FINANCE_ACCOUNTANT');
    expect((await a.get('/admin/users')).status).toBe(403);
  });

  it('cannot mint or list API keys', async () => {
    const a = await recruiter();
    expect((await a.post('/api-keys').send({ name: 'mine', capabilities: ['view:org'] })).status).toBe(403);
    expect((await a.get('/api-keys')).status).toBe(403);
    expect(await prisma.apiKey.count()).toBe(0);
  });

  it('cannot run payroll or read the audit log', async () => {
    const a = await recruiter();
    expect((await a.get('/payroll/runs')).status).toBe(403);
    expect((await a.get('/audit')).status).toBe(403);
  });

  // Hire access (set:hire-pay, owner 2026-10-23) is a new hire's starting
  // pay — not the compensation desk, its bands, merit cycles, mass pay
  // changes or the payroll PII exports.
  it('cannot reach the compensation desk, bands, merit cycles, batch pay changes or a PII export', async () => {
    const a = await recruiter();
    const client = await createClient('Boundary Client');
    for (const path of ['/comp/overview', '/comp/bands', '/comp/cycles', '/comp/changes', '/payroll/new-hire-report.csv']) {
      expect((await a.get(path)).status, path).toBe(403);
    }
    expect((await a.post('/comp/bands').send({ clientId: client.id, name: 'B', payType: 'HOURLY', minAmount: 1, midAmount: 2, maxAmount: 3 })).status).toBe(403);
    expect((await a.post('/comp/cycles').send({ clientId: client.id, name: 'Merit 2027', reviewPeriodStart: '2026-01-01T00:00:00.000Z', reviewPeriodEnd: '2026-12-31T00:00:00.000Z', effectiveDate: '2027-01-01T00:00:00.000Z' })).status).toBe(403);
    expect((await a.post('/comp/batch').send({ changes: [] })).status).toBe(403);
    expect((await a.post('/org/associates/payroll-census-export').send({})).status).toBe(403);
    expect(await prisma.compBand.count()).toBe(0);
  });

  it('cannot read or change the pay of someone past the new-hire window', async () => {
    const a = await recruiter();
    const person = await createAssociate();
    await prisma.associate.update({ where: { id: person.id }, data: { hireDate: new Date('2024-05-01') } });
    await prisma.compensationRecord.create({ data: { associateId: person.id, effectiveFrom: new Date('2024-05-01'), payType: 'HOURLY', amount: 15, reason: 'HIRE' } });
    expect((await a.get(`/comp/associates/${person.id}/records`)).status).toBe(403);
    const change = await a.post(`/comp/associates/${person.id}/records`).send({ payType: 'HOURLY', amount: 30, reason: 'MERIT' });
    expect(change.status).toBe(403);
    const startAgain = await a.post(`/comp/associates/${person.id}/records`).send({ payType: 'HOURLY', amount: 30, reason: 'HIRE' });
    expect(startAgain.status).toBe(403);
    expect(startAgain.body.error.message).toContain('This is a pay change now — someone with compensation access makes it.');
    expect(await prisma.compensationRecord.count({ where: { associateId: person.id } })).toBe(1);
  });
});

describe('the recruiter sets a new hire’s pay', () => {
  it('sets the starting pay and pay schedule of someone onboarding, and reads their employment', async () => {
    const a = await recruiter();
    const client = await createClient('Hire Pay Client');
    const person = await createAssociate();
    await prisma.application.create({ data: { associateId: person.id, clientId: client.id, onboardingTrack: 'STANDARD', status: 'SUBMITTED', position: 'Cashier' } });
    // No band or rate card for Cashier: nothing to hold it against, so it applies at once (owner 2026-10-23).
    await createUser({ role: 'HR_ADMINISTRATOR' });
    const pay = await a.post(`/comp/associates/${person.id}/records`).send({ payType: 'HOURLY', amount: 15, reason: 'HIRE' });
    expect(pay.status).toBe(201);
    expect((await a.get(`/comp/associates/${person.id}/hire-pay`)).body).toMatchObject({ newHire: true, canSet: true, pending: null });
    expect((await a.get(`/comp/associates/${person.id}/records`)).status).toBe(200);
    expect((await a.get(`/associates/${person.id}/pay-schedule`)).status).toBe(200);
    expect((await a.get(`/associates/${person.id}/pay-schedule/choices`)).status).toBe(200);
    expect((await a.get(`/org/associates/${person.id}/employment`)).status).toBe(200);
  });
});

describe('the recruiter runs the onboarding desk', () => {
  it('reads the document review queue, the kiosk codes and the accounts she hires for (manage:documents, manage:time, view:clients)', async () => {
    const a = await recruiter();
    for (const path of ['/documents/admin', '/kiosk-pins', '/clients']) {
      const r = await a.get(path);
      expect(r.status, path).toBe(200);
    }
  });
});

describe('the recruiter still does the job', () => {
  it('reads candidates, postings, interviews, offers and the people directory', async () => {
    const a = await recruiter();
    for (const path of ['/recruiting/candidates', '/job-postings', '/interviews', '/offers', '/people/directory']) {
      const r = await a.get(path);
      expect(r.status, path).toBe(200);
    }
  });

  it('can add a candidate (manage:recruiting)', async () => {
    const a = await recruiter();
    const r = await a.post('/recruiting/candidates').send({ firstName: 'Ana', lastName: 'Reyes', email: 'ana.reyes@example.com' });
    expect(r.status).toBe(201);
  });
});
