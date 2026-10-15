import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { createApiClient } from '../../lib/apiClients.js';
import { signatureV2 } from '../../lib/webhookSecrets.js';
import { ALTO_TENANT_ID } from '../../lib/tenant.js';
import { ensureWorkerForAssociate } from '../../lib/workers.js';
import { createAssociate, createClient, createUser, prisma, truncateAll } from '../../../test/db.js';
import { runSampleIntegration, verifyAltoSignature } from '../../../scripts/sample-integration.js';

/**
 * Brief 2-4 step 6 — the sample integration runs in CI against a real
 * listening server, through plain fetch, end to end: token, paging, a
 * shift created, assigned and cancelled, a webhook subscribed and removed.
 * If the API changes under it, this fails before a customer finds out.
 */

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await truncateAll();
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

describe('the sample integration', () => {
  it('runs read-only, then with writes, against the API as a customer would', async () => {
    const { user } = await createUser({ role: 'HR_ADMINISTRATOR' });
    const c = await createClient('Sample Co');
    const site = await prisma.site.findFirstOrThrow({ where: { clientId: c.id } });
    const a = await createAssociate({ firstName: 'Sam', lastName: 'Sample' });
    await prisma.associateAssignment.create({ data: { associateId: a.id, locationId: site.id, startedAt: new Date() } });
    const workerId = await ensureWorkerForAssociate(prisma, a.id, user.id);
    await prisma.worker.update({ where: { id: workerId! }, data: { status: 'ACTIVE' } });

    const issued = await createApiClient(prisma, ALTO_TENANT_ID, { name: 'Sample', scopes: ['sites:read', 'workers:read', 'schedules:read', 'schedules:write', 'webhooks:manage'], ownerUserId: user.id }, user.id);
    const lines: string[] = [];
    const opts = { baseUrl, clientId: issued.client.clientId, clientSecret: issued.clientSecret, webhookUrl: 'https://203.0.113.10/hook', log: (l: string) => lines.push(l) };

    const read = await runSampleIntegration(opts);
    expect(read).toEqual({ sites: 1, workers: 1, shifts: 0 });

    const written = await runSampleIntegration({ ...opts, write: true });
    expect(written.created).toMatchObject({ assignedWorkerId: workerId, cancelled: true });
    const shift = await prisma.shift.findUniqueOrThrow({ where: { id: written.created!.shiftId } });
    expect(shift.status).toBe('CANCELLED');
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: written.created!.webhookId } })).deletedAt).not.toBeNull();
    expect(lines.some((l) => l.startsWith('created draft shift'))).toBe(true);
  });

  it('its signature check agrees with what Alto sends', () => {
    const body = JSON.stringify({ event: 'shift.created', data: {} });
    const header = signatureV2('s3cret', body, new Date());
    expect(verifyAltoSignature('s3cret', body, header)).toBe(true);
    expect(verifyAltoSignature('s3cret', `${body} `, header)).toBe(false);
    expect(verifyAltoSignature('s3cret', body, header, Date.now() + 600_000)).toBe(false);
  });
});
