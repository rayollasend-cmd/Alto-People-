import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { randomBytes, createHmac } from 'node:crypto';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { hashPassword } from '../lib/passwords.js';

/**
 * Phase 93 — Public API keys + outbound webhooks.
 *
 * API keys: prefixed `altop_` + 32 random bytes (hex). Stored as a
 * bcrypt hash (same primitive as passwords); plaintext is shown once
 * at create time. The /apikeys/test endpoint accepts the plaintext via
 * Authorization: Bearer <key> for end-to-end verification.
 *
 * Webhooks: customer subscribes a URL + event-type list. The platform
 * enqueues a WebhookDelivery whenever a matching event fires; a separate
 * worker pulls PENDING deliveries and POSTs them. Body is signed with
 * HMAC-SHA256 using the webhook's secret in the X-Alto-Signature header.
 */

export const apiKeysWebhooks93Router = Router();

const VIEW = requireCapability('view:integrations');
const MANAGE = requireCapability('manage:integrations');

const KEY_PREFIX = 'altop_';

function generateApiKey(): { plaintext: string; last4: string } {
  const raw = randomBytes(32).toString('hex');
  const plaintext = `${KEY_PREFIX}${raw}`;
  return { plaintext, last4: raw.slice(-4) };
}

// ----- API keys ---------------------------------------------------------

const ApiKeyInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  capabilities: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

apiKeysWebhooks93Router.get('/api-keys', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.apiKey.findMany({
    where: { ...(clientId ? { clientId } : {}) },
    include: {
      client: { select: { name: true } },
      createdBy: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    keys: rows.map((k) => ({
      id: k.id,
      clientId: k.clientId,
      clientName: k.client?.name ?? null,
      name: k.name,
      last4: k.last4,
      capabilities: k.capabilities,
      createdByEmail: k.createdBy.email,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
});

apiKeysWebhooks93Router.post('/api-keys', MANAGE, async (req, res) => {
  const input = ApiKeyInputSchema.parse(req.body);
  const { plaintext, last4 } = generateApiKey();
  const keyHash = await hashPassword(plaintext);
  const created = await prisma.apiKey.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      last4,
      keyHash,
      capabilities: input.capabilities ?? [],
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({
    id: created.id,
    plaintext, // Shown ONCE — caller must save.
    last4,
  });
});

apiKeysWebhooks93Router.post('/api-keys/:id/revoke', MANAGE, async (req, res) => {
  await prisma.apiKey.update({
    where: { id: req.params.id },
    data: { revokedAt: new Date() },
  });
  res.json({ ok: true });
});

apiKeysWebhooks93Router.delete('/api-keys/:id', MANAGE, async (req, res) => {
  await prisma.apiKey.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ----- Webhooks ---------------------------------------------------------

const WebhookInputSchema = z.object({
  clientId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(120),
  url: z.string().url(),
  eventTypes: z.array(z.string()).default([]),
});

apiKeysWebhooks93Router.get('/webhooks', VIEW, async (req, res) => {
  const clientId = z.string().uuid().optional().parse(req.query.clientId);
  const rows = await prisma.webhook.findMany({
    where: {
      deletedAt: null,
      ...(clientId ? { clientId } : {}),
    },
    include: {
      client: { select: { name: true } },
      _count: { select: { deliveries: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    webhooks: rows.map((w) => ({
      id: w.id,
      clientId: w.clientId,
      clientName: w.client?.name ?? null,
      name: w.name,
      url: w.url,
      eventTypes: w.eventTypes,
      isActive: w.isActive,
      deliveryCount: w._count.deliveries,
      createdAt: w.createdAt.toISOString(),
    })),
  });
});

apiKeysWebhooks93Router.post('/webhooks', MANAGE, async (req, res) => {
  const input = WebhookInputSchema.parse(req.body);
  const secret = randomBytes(32).toString('hex');
  const created = await prisma.webhook.create({
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      url: input.url,
      secret,
      eventTypes: input.eventTypes,
      createdById: req.user!.id,
    },
  });
  res.status(201).json({
    id: created.id,
    // Show the signing secret once at create time so the consumer can
    // store it on their side. Subsequent reads do NOT include this.
    secret,
  });
});

apiKeysWebhooks93Router.put('/webhooks/:id', MANAGE, async (req, res) => {
  const input = WebhookInputSchema.parse(req.body);
  await prisma.webhook.update({
    where: { id: req.params.id },
    data: {
      clientId: input.clientId ?? null,
      name: input.name,
      url: input.url,
      eventTypes: input.eventTypes,
    },
  });
  res.json({ ok: true });
});

apiKeysWebhooks93Router.post('/webhooks/:id/toggle', MANAGE, async (req, res) => {
  const w = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!w) throw new HttpError(404, 'not_found', 'Webhook not found.');
  await prisma.webhook.update({
    where: { id: w.id },
    data: { isActive: !w.isActive },
  });
  res.json({ ok: true, isActive: !w.isActive });
});

apiKeysWebhooks93Router.delete('/webhooks/:id', MANAGE, async (req, res) => {
  await prisma.webhook.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), isActive: false },
  });
  res.status(204).end();
});

apiKeysWebhooks93Router.get('/webhooks/:id/deliveries', VIEW, async (req, res) => {
  const rows = await prisma.webhookDelivery.findMany({
    where: { webhookId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({
    deliveries: rows.map((d) => ({
      id: d.id,
      eventType: d.eventType,
      status: d.status,
      attemptCount: d.attemptCount,
      responseStatus: d.responseStatus,
      lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      createdAt: d.createdAt.toISOString(),
    })),
  });
});

/**
 * Fire a test event so the customer can verify their endpoint without
 * waiting for a real domain event. Inserts a WebhookDelivery row that
 * the worker will pick up just like any other.
 */
apiKeysWebhooks93Router.post('/webhooks/:id/test', MANAGE, async (req, res) => {
  const w = await prisma.webhook.findUnique({ where: { id: req.params.id } });
  if (!w || w.deletedAt) throw new HttpError(404, 'not_found', 'Webhook not found.');

  const eventType = z.string().default('test.ping').parse(req.body?.eventType);
  const payload = {
    event: eventType,
    test: true,
    timestamp: new Date().toISOString(),
  };

  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId: w.id,
      eventType,
      payload: payload as Prisma.InputJsonValue,
    },
  });

  // For a test fire we deliver synchronously so the operator sees the
  // outcome immediately. Real events go through the async worker.
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', w.secret).update(body).digest('hex');
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let ok = false;
  try {
    const r = await fetch(w.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Alto-Signature': signature,
        'X-Alto-Event': eventType,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = r.status;
    responseBody = (await r.text()).slice(0, 1000);
    ok = r.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message.slice(0, 1000) : 'unknown';
  }

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attemptCount: 1,
      lastAttemptAt: new Date(),
      responseStatus,
      responseBody,
      status: ok ? 'DELIVERED' : 'FAILED',
      deliveredAt: ok ? new Date() : null,
    },
  });

  res.json({ ok, responseStatus, responseBody });
});
