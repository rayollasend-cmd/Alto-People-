import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { prisma, truncateAll } from '../../../test/db.js';
import { withPlatformScope } from '../../lib/tenant.js';

/**
 * The hotline is per organization (F500 G5). A report used to take the
 * database default — Alto HR — whatever company the worker was at; now
 * /hotline/:slug names the organization, the server resolves it from the
 * slug, writes the report to that tenant, and the tracking code finds it.
 */

const T2 = '00000000-0000-4000-8000-0000000000b2';
const app = () => createApp();

beforeEach(async () => {
  await truncateAll();
  await prisma.tenant.create({ data: { id: T2, slug: 'harbor-staffing', name: 'Harbor Staffing' } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

const report = { category: 'SAFETY', subject: 'Blocked fire exit', description: 'The back fire exit has been blocked by pallets all week.' };

describe('the hotline, per organization', () => {
  it('names the organization a hotline address belongs to; an unknown address is a 404', async () => {
    const res = await request(app()).get('/anonymous-reports/org/harbor-staffing');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ org: { name: 'Harbor Staffing', slug: 'harbor-staffing' } });
    expect((await request(app()).get('/anonymous-reports/org/nobody-here')).status).toBe(404);
    // No address: the default organization, by name.
    const def = await request(app()).get('/anonymous-reports/org');
    expect(def.status).toBe(200);
    expect(def.body.org.name).toEqual(expect.any(String));
  });

  it('files the report into the named organization, and its code finds it there', async () => {
    const filed = await request(app()).post('/anonymous-reports').send({ ...report, org: 'harbor-staffing' });
    expect(filed.status).toBe(201);
    const row = await withPlatformScope(() => prisma.anonymousReport.findUniqueOrThrow({ where: { trackingCode: filed.body.trackingCode } }));
    expect(row.tenantId).toBe(T2);
    const looked = await request(app()).get(`/anonymous-reports/code/${filed.body.trackingCode}`);
    expect(looked.status).toBe(200);
    expect(looked.body.report.subject).toBe('Blocked fire exit');
    const reply = await request(app()).post(`/anonymous-reports/code/${filed.body.trackingCode}/messages`).send({ body: 'It is still blocked today.' });
    expect(reply.status).toBe(201);
    const update = await withPlatformScope(() => prisma.anonymousReportUpdate.findFirstOrThrow({ where: { reportId: row.id } }));
    expect(update.tenantId).toBe(T2);
  });

  it('refuses an unknown organization, and with no address files to the default one', async () => {
    expect((await request(app()).post('/anonymous-reports').send({ ...report, org: 'nobody-here' })).status).toBe(404);
    const filed = await request(app()).post('/anonymous-reports').send(report);
    expect(filed.status).toBe(201);
    const row = await withPlatformScope(() => prisma.anonymousReport.findUniqueOrThrow({ where: { trackingCode: filed.body.trackingCode } }));
    expect(row.tenantId).toBe('00000000-0000-4000-8000-000000000001');
  });
});
