import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agent, loginAs } from '../../../test/http.js';
import { createAssociate, createUser, prisma, truncateAll } from '../../../test/db.js';

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
});

describe('the recruiter runs the onboarding desk', () => {
  it('reads the document review queue and the kiosk codes (manage:documents, manage:time)', async () => {
    const a = await recruiter();
    for (const path of ['/documents/admin', '/kiosk-pins']) {
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
