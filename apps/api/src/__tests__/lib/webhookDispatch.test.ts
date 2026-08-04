import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createClient, prisma, truncateAll } from '../../../test/db.js';
import {
  MAX_DELIVERY_ATTEMPTS,
  deliverPendingDeliveries,
  emitWebhookEvent,
} from '../../lib/webhookDispatch.js';

/**
 * Outbound webhook worker tests. All network is mocked — the delivery
 * URLs use a literal public IP (TEST-NET-3, 203.0.113.0/24) so the SSRF
 * guard passes without a DNS round-trip, and global fetch is stubbed so
 * nothing ever actually connects.
 */

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PUBLIC_URL = 'https://203.0.113.10/hook';
const SECRET = 'test-webhook-secret';

async function createHook(overrides: {
  url?: string;
  secret?: string;
  eventTypes?: string[];
  clientId?: string | null;
  isActive?: boolean;
  name?: string;
} = {}) {
  return prisma.webhook.create({
    data: {
      name: overrides.name ?? 'Test hook',
      url: overrides.url ?? PUBLIC_URL,
      secret: overrides.secret ?? SECRET,
      eventTypes: overrides.eventTypes ?? [],
      clientId: overrides.clientId ?? null,
      isActive: overrides.isActive ?? true,
    },
  });
}

type FetchCall = { url: string; init: RequestInit };

function stubFetch(status = 200, body = 'ok') {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => body,
    };
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

describe('emitWebhookEvent', () => {
  it('fans out only to active subscriptions matching the event type', async () => {
    const subscribed = await createHook({ eventTypes: ['associate.hired'] });
    await createHook({ eventTypes: ['payroll.finalized'], name: 'Other' });

    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });

    const rows = await prisma.webhookDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].webhookId).toBe(subscribed.id);
    expect(rows[0].eventType).toBe('associate.hired');
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].attemptCount).toBe(0);
    const payload = rows[0].payload as {
      event: string;
      timestamp: string;
      data: Record<string, unknown>;
    };
    expect(payload.event).toBe('associate.hired');
    expect(payload.data).toEqual({ associateId: 'a-1' });
    expect(payload.timestamp).toBeTruthy();
  });

  it('treats an empty eventTypes array as subscribed to everything', async () => {
    const catchAll = await createHook({ eventTypes: [] });
    await emitWebhookEvent('time_off.approved', { requestId: 'r-1' });
    const rows = await prisma.webhookDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].webhookId).toBe(catchAll.id);
  });

  it('skips inactive and soft-deleted webhooks', async () => {
    await createHook({ isActive: false });
    const deleted = await createHook({ name: 'Deleted' });
    await prisma.webhook.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });
    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('scopes client events: global hooks always hear, client hooks only their own', async () => {
    const clientA = await createClient();
    const clientB = await createClient();
    const globalHook = await createHook({ name: 'Global' });
    const hookA = await createHook({ name: 'A', clientId: clientA.id });
    await createHook({ name: 'B', clientId: clientB.id });

    await emitWebhookEvent(
      'payroll.finalized',
      { payrollRunId: 'run-1' },
      { clientId: clientA.id },
    );
    const scoped = await prisma.webhookDelivery.findMany();
    expect(scoped.map((d) => d.webhookId).sort()).toEqual(
      [globalHook.id, hookA.id].sort(),
    );

    // No clientId on the emit → global hooks only.
    await prisma.webhookDelivery.deleteMany();
    await emitWebhookEvent('payroll.finalized', { payrollRunId: 'run-2' });
    const unscoped = await prisma.webhookDelivery.findMany();
    expect(unscoped.map((d) => d.webhookId)).toEqual([globalHook.id]);
  });

  it('never throws into the caller when the DB write fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      webhook: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaClient;
    await expect(
      emitWebhookEvent('associate.hired', {}, { prisma: broken }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('deliverPendingDeliveries', () => {
  it('POSTs the stored payload with the HMAC signature and marks DELIVERED', async () => {
    const hook = await createHook();
    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });
    const { calls } = stubFetch(200);

    const result = await deliverPendingDeliveries(prisma);
    expect(result).toMatchObject({ claimed: 1, delivered: 1, failed: 0, retried: 0 });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(PUBLIC_URL);
    expect(init.method).toBe('POST');

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    const headers = init.headers as Record<string, string>;
    const expectedSig = createHmac('sha256', SECRET)
      .update(String(init.body))
      .digest('hex');
    expect(headers['X-Alto-Signature']).toBe(expectedSig);
    expect(headers['X-Alto-Event']).toBe('associate.hired');
    expect(headers['X-Alto-Delivery']).toBe(row.id);
    expect(headers['Content-Type']).toBe('application/json');
    // The signed body is exactly the stored payload.
    expect(JSON.parse(String(init.body))).toEqual(row.payload);

    expect(row.webhookId).toBe(hook.id);
    expect(row.status).toBe('DELIVERED');
    expect(row.attemptCount).toBe(1);
    expect(row.responseStatus).toBe(200);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.lastAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt).toBeNull();
  });

  it('schedules exponential backoff on failure and respects nextAttemptAt', async () => {
    await createHook();
    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });
    stubFetch(500, 'boom');

    const t0 = new Date();
    const first = await deliverPendingDeliveries(prisma, t0);
    expect(first).toMatchObject({ claimed: 1, retried: 1 });

    let row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.status).toBe('RETRYING');
    expect(row.attemptCount).toBe(1);
    expect(row.responseStatus).toBe(500);
    expect(row.deliveredAt).toBeNull();
    // First backoff: 1 minute.
    expect(row.nextAttemptAt!.getTime()).toBe(t0.getTime() + 60_000);

    // Not due yet — a sweep "now" claims nothing.
    const early = await deliverPendingDeliveries(prisma, t0);
    expect(early.claimed).toBe(0);

    // Two minutes later it's due; second failure backs off 5 minutes.
    const t1 = new Date(t0.getTime() + 2 * 60_000);
    const second = await deliverPendingDeliveries(prisma, t1);
    expect(second).toMatchObject({ claimed: 1, retried: 1 });
    row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.attemptCount).toBe(2);
    expect(row.nextAttemptAt!.getTime()).toBe(t1.getTime() + 5 * 60_000);
  });

  it('gives up as FAILED once the attempt cap is reached', async () => {
    const hook = await createHook();
    const row = await prisma.webhookDelivery.create({
      data: {
        webhookId: hook.id,
        eventType: 'associate.hired',
        payload: { event: 'associate.hired', data: {} },
        status: 'RETRYING',
        attemptCount: MAX_DELIVERY_ATTEMPTS - 1,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    const { mock } = stubFetch(500);

    const result = await deliverPendingDeliveries(prisma);
    expect(result).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(mock).toHaveBeenCalledTimes(1);

    const after = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe('FAILED');
    expect(after.attemptCount).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(after.nextAttemptAt).toBeNull();
  });

  it('refuses private destinations without attempting the fetch (SSRF guard)', async () => {
    await createHook({ url: 'https://10.0.0.5/internal' });
    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });
    const { mock } = stubFetch(200);

    const result = await deliverPendingDeliveries(prisma);
    expect(result).toMatchObject({ claimed: 1, failed: 1, delivered: 0 });
    expect(mock).not.toHaveBeenCalled();

    const row = await prisma.webhookDelivery.findFirstOrThrow();
    // Permanent failure — never retried, no matter how few attempts.
    expect(row.status).toBe('FAILED');
    expect(row.attemptCount).toBe(1);
    expect(row.responseBody).toContain('unsafe destination refused');
  });

  it('fails out rows whose webhook was deactivated after enqueue', async () => {
    const hook = await createHook();
    await emitWebhookEvent('associate.hired', { associateId: 'a-1' });
    await prisma.webhook.update({
      where: { id: hook.id },
      data: { isActive: false },
    });
    const { mock } = stubFetch(200);

    const result = await deliverPendingDeliveries(prisma);
    expect(result.failed).toBe(1);
    expect(mock).not.toHaveBeenCalled();
    const row = await prisma.webhookDelivery.findFirstOrThrow();
    expect(row.status).toBe('FAILED');
    expect(row.responseBody).toContain('deactivated');
  });

  it('treats a pre-worker row with NULL nextAttemptAt as due', async () => {
    const hook = await createHook();
    await prisma.webhookDelivery.create({
      data: {
        webhookId: hook.id,
        eventType: 'test.ping',
        payload: { event: 'test.ping' },
        // status PENDING, nextAttemptAt omitted (NULL) — as enqueued
        // before the worker existed.
      },
    });
    stubFetch(200);
    const result = await deliverPendingDeliveries(prisma);
    expect(result).toMatchObject({ claimed: 1, delivered: 1 });
  });
});
