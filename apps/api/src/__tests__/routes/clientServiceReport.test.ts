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

/** Weekly client service report: a letterheaded PDF built from the same
 *  computation as the statement, for handing to the client. */

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

describe('GET /clients/:id/service-report.pdf', () => {
  it('renders a PDF for a week with real activity', async () => {
    const client = await createClient('Walmart Front Beach');
    const worker = await createAssociate({ firstName: 'On', lastName: 'Floor' });
    const start = new Date('2026-08-24T14:00:00.000Z');
    await prisma.shift.create({
      data: {
        clientId: client.id,
        position: 'F&D Overnight',
        startsAt: start,
        endsAt: new Date(start.getTime() + 9 * 3600_000),
        status: 'ASSIGNED',
        assignedAssociateId: worker.id,
        publishedAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    });
    await prisma.timeEntry.create({
      data: {
        associateId: worker.id,
        clientId: client.id,
        clockInAt: start,
        clockOutAt: new Date(start.getTime() + 9 * 3600_000),
        status: 'APPROVED',
      },
    });

    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent
      .get(`/clients/${client.id}/service-report.pdf?week=2026-08-24`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const buf = res.body as Buffer;
    expect(buf.length).toBeGreaterThan(2000);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('404s an unknown client', async () => {
    const { user: hr } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const agent = await loginAs(hr.email);
    const res = await agent.get(
      '/clients/00000000-0000-0000-0000-000000000000/service-report.pdf',
    );
    expect(res.status).toBe(404);
  });
});
