import { Router, raw } from 'express';
import { z } from 'zod';
import { WA_TEMPLATES } from '../lib/whatsappContent.js';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireAuth, requireCapability } from '../middleware/auth.js';
import { enqueueAudit } from '../lib/audit.js';
import { applyWhatsAppStatus, normalizePhone, verifyWhatsAppSignature, whatsappConfigured } from '../lib/whatsapp.js';
import { handleInbound } from '../lib/whatsappAssistant.js';

/**
 * WhatsApp (Brief 1C-4).
 *
 *   GET  /whatsapp/me                 the associate's consent + the phone on file
 *   POST /whatsapp/me/consent         { optIn, phone? } — opt in with a number, or out
 *   GET  /whatsapp/webhook            Meta's verification handshake
 *   POST /whatsapp/webhook            receipts and inbound messages (signed)
 *   GET  /whatsapp/admin/overview     configuration, template registry, counts   (manage:communications)
 *   GET  /whatsapp/admin/messages     the message record, newest first            (manage:communications)
 */
export const whatsappRouter = Router();
/** The webhook alone: mounted before the JSON parser so the raw bytes survive for the signature. */
export const whatsappWebhookRouter = Router();

// Every staff role can read communications; the message record names numbers, so it is the managers'.
const VIEW = requireCapability('manage:communications');

whatsappRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) {
      res.json({ configured: whatsappConfigured(), phoneOnFile: null, consent: null });
      return;
    }
    const [associate, consent] = await Promise.all([
      prisma.associate.findUnique({ where: { id: associateId }, select: { phone: true } }),
      prisma.whatsAppConsent.findUnique({ where: { associateId } }),
    ]);
    res.json({
      configured: whatsappConfigured(),
      phoneOnFile: associate?.phone ?? null,
      consent: consent
        ? { status: consent.status, phone: consent.phone, optedInAt: consent.optedInAt.toISOString(), optedOutAt: consent.optedOutAt?.toISOString() ?? null }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.post('/me/consent', requireAuth, async (req, res, next) => {
  try {
    const associateId = req.user!.associateId;
    if (!associateId) throw new HttpError(403, 'no_associate', 'Your login is not linked to an associate record.');
    const input = z.object({ optIn: z.boolean(), phone: z.string().trim().max(40).optional() }).parse(req.body);
    const now = new Date();
    if (input.optIn) {
      const onFile = (await prisma.associate.findUnique({ where: { id: associateId }, select: { phone: true } }))?.phone;
      const phone = normalizePhone(input.phone ?? onFile);
      if (!phone) throw new HttpError(400, 'phone_invalid', 'Enter the mobile number WhatsApp is on, with the area code.');
      await prisma.whatsAppConsent.upsert({
        where: { associateId },
        create: { associateId, phone, status: 'OPTED_IN', source: 'app', optedInAt: now },
        update: { phone, status: 'OPTED_IN', source: 'app', optedInAt: now, optedOutAt: null },
      });
    } else {
      await prisma.whatsAppConsent.updateMany({ where: { associateId }, data: { status: 'OPTED_OUT', optedOutAt: now, source: 'app' } });
    }
    enqueueAudit(
      { actorUserId: req.user!.id, clientId: null, action: input.optIn ? 'whatsapp.opted_in' : 'whatsapp.opted_out', entityType: 'Associate', entityId: associateId, metadata: { source: 'app' } },
      'whatsappConsent',
    );
    const consent = await prisma.whatsAppConsent.findUnique({ where: { associateId } });
    res.json({
      configured: whatsappConfigured(),
      phoneOnFile: null,
      consent: consent
        ? { status: consent.status, phone: consent.phone, optedInAt: consent.optedInAt.toISOString(), optedOutAt: consent.optedOutAt?.toISOString() ?? null }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/** Meta's one-time verification: echo the challenge when the token matches. */
whatsappWebhookRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (!env.WHATSAPP_VERIFY_TOKEN) {
    res.status(503).json({ error: 'webhook_not_configured' });
    return;
  }
  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN && typeof challenge === 'string') {
    res.status(200).type('text/plain').send(challenge);
    return;
  }
  res.status(403).json({ error: 'verify_failed' });
});

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{ from: string; id: string; timestamp?: string; type: string; text?: { body: string } }>;
        statuses?: Array<{ id: string; status: string; timestamp?: string; errors?: Array<{ title?: string; message?: string }> }>;
      };
    }>;
  }>;
}

whatsappWebhookRouter.post('/', raw({ type: '*/*', limit: '512kb' }), async (req, res) => {
  if (!env.WHATSAPP_APP_SECRET) {
    res.status(503).json({ error: 'webhook_not_configured' });
    return;
  }
  const rawBody = req.body as Buffer;
  if (!verifyWhatsAppSignature(rawBody, req.header('x-hub-signature-256'))) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  // Meta retries on anything but a 200, so answer first and work after;
  // each inbound message is idempotent on its id.
  res.status(200).json({ ok: true });
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      for (const s of v.statuses ?? []) {
        const status = s.status as 'sent' | 'delivered' | 'read' | 'failed';
        if (!['sent', 'delivered', 'read', 'failed'].includes(status)) continue;
        const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
        await applyWhatsAppStatus(prisma, s.id, status, at, s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null).catch(() => undefined);
      }
      for (const m of v.messages ?? []) {
        if (m.type !== 'text' || !m.text?.body) continue;
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
        await handleInbound({ from: m.from, waMessageId: m.id, text: m.text.body, timestamp: at }, prisma).catch((err) => {
          console.warn('[whatsapp] inbound failed:', err instanceof Error ? err.message : err);
        });
      }
    }
  }
});

whatsappRouter.get('/admin/overview', VIEW, async (_req, res, next) => {
  try {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [optedIn, optedOut, byStatus, questions, handoffs] = await Promise.all([
      prisma.whatsAppConsent.count({ where: { status: 'OPTED_IN' } }),
      prisma.whatsAppConsent.count({ where: { status: 'OPTED_OUT' } }),
      prisma.whatsAppMessage.groupBy({ by: ['status'], where: { direction: 'OUTBOUND', createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.whatsAppMessage.count({ where: { direction: 'INBOUND', createdAt: { gte: since } } }),
      prisma.whatsAppMessage.count({ where: { kind: 'HANDOFF', createdAt: { gte: since } } }),
    ]);
    const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count._all]));
    res.json({
      configured: whatsappConfigured(),
      webhookConfigured: !!(env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN),
      apiVersion: env.WHATSAPP_API_VERSION,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ? `…${env.WHATSAPP_PHONE_NUMBER_ID.slice(-4)}` : null,
      consent: { optedIn, optedOut },
      last7Days: {
        sent: counts.SENT ?? 0,
        delivered: counts.DELIVERED ?? 0,
        read: counts.READ ?? 0,
        failed: counts.FAILED ?? 0,
        questions,
        handoffs,
      },
      templates: WA_TEMPLATES.map((t) => ({ key: t.key, metaName: t.metaName, metaCategory: t.metaCategory, params: t.params, description: t.description, body: t.body })),
    });
  } catch (err) {
    next(err);
  }
});

whatsappRouter.get('/admin/messages', VIEW, async (req, res, next) => {
  try {
    const q = z.object({ associateId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const rows = await prisma.whatsAppMessage.findMany({
      where: q.associateId ? { associateId: q.associateId } : {},
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      include: { associate: { select: { firstName: true, lastName: true } } },
    });
    res.json({
      messages: rows.map((r) => ({
        id: r.id,
        associateId: r.associateId,
        associateName: r.associate ? `${r.associate.firstName} ${r.associate.lastName}` : null,
        phone: `…${r.phone.slice(-4)}`,
        direction: r.direction,
        kind: r.kind,
        templateName: r.templateName,
        language: r.language,
        body: r.body,
        category: r.category,
        status: r.status,
        statusAt: r.statusAt?.toISOString() ?? null,
        failureReason: r.failureReason,
        conversationId: r.conversationId,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});
