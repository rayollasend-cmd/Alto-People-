import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { requireAnyCapability, requireCapability } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { recordCriticalAudit } from '../lib/audit.js';
import { WORKER_TYPES, applyStripeEvent, billingContact, invoiceMonth, localToday, planLabel, saveBillingContact, stripeMode, usageCountLabel, verifyStripeSignature } from '../lib/billing.js';
import { ALTO_TENANT_ID, tenantIdForWrite } from '../lib/tenant.js';

/**
 * Brief 2-6 step 4 — the billing page's reads and the platform's levers.
 *
 *   GET  /billing                       plan, this month's running counts by type, the last six months' counts, invoices (manage:org or Finance, decision 11)
 *   GET  /billing/usage?month=          the daily snapshot counts behind a month
 *   PUT  /billing/contact               the billing contact (manage:org); the Stripe customer follows
 *   PUT  /billing/prices                the platform operator sets a plan's price per type (decision 3)
 *   POST /billing/close                 the platform operator closes and invoices a tenant's month now
 *   POST /billing/stripe/webhook        Stripe's events, signature-checked (mounted before express.json)
 */

export const billingRouter = Router();
const VIEW = requireAnyCapability('manage:org', 'process:payroll');
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

function operatorOnly(): void {
  if (tenantIdForWrite() !== ALTO_TENANT_ID) throw new HttpError(404, 'not_found', 'Not found.');
}

/** Each invoice line with its count in words ("1 AI agent"), so no page lower-cases an acronym. */
function withLineLabels(lines: unknown): unknown {
  if (!Array.isArray(lines)) return lines;
  return lines.map((l) => (l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string' && typeof (l as { quantity?: unknown }).quantity === 'number'
    ? { ...l, label: usageCountLabel((l as { type: string }).type, (l as { quantity: number }).quantity) }
    : l));
}

billingRouter.get('/', VIEW, async (_req, res) => {
  const tenantId = tenantIdForWrite();
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const month = localToday().slice(0, 7);
  const from = new Date(`${month}-01T00:00:00Z`);
  const snaps = await prisma.usageSnapshot.findMany({ where: { tenantId, day: { gte: from } }, select: { type: true, ids: true, day: true } });
  const running = Object.fromEntries(WORKER_TYPES.map((t) => [t, new Set(snaps.filter((s) => s.type === t).flatMap((s) => s.ids)).size]));
  const [invoices, contact] = await Promise.all([prisma.billingInvoice.findMany({ where: { tenantId }, orderBy: { month: 'desc' }, take: 24 }), billingContact(prisma, tenantId)]);
  // The six months before this one, by the same rule as the running count:
  // each id active on at least one day of the month counts once (F500 G4).
  const [y, m] = month.split('-').map(Number) as [number, number];
  const monthKey = (offset: number) => {
    const d = new Date(Date.UTC(y, m - 1 - offset, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const historyFrom = new Date(`${monthKey(6)}-01T00:00:00Z`);
  const past = await prisma.usageSnapshot.findMany({ where: { tenantId, day: { gte: historyFrom, lt: from } }, select: { type: true, ids: true, day: true } });
  const history = Array.from({ length: 6 }, (_, i) => monthKey(i + 1)).map((key) => {
    const inMonth = past.filter((s) => s.day.toISOString().slice(0, 7) === key);
    return {
      month: key,
      daysCounted: new Set(inMonth.map((s) => s.day.toISOString())).size,
      counts: Object.fromEntries(WORKER_TYPES.map((t) => [t, new Set(inMonth.filter((s) => s.type === t).flatMap((s) => s.ids)).size])),
    };
  });
  res.json({
    contact,
    plan: tenant?.plan ?? 'internal',
    // The plan in words: never the platform's own code on a customer's page.
    planLabel: planLabel(tenant?.plan, tenantId),
    invoiced: tenant?.plan !== 'internal',
    stripe: stripeMode() ?? 'off',
    month,
    daysCounted: new Set(snaps.map((s) => s.day.toISOString())).size,
    running,
    history,
    invoices: invoices.map((i) => ({ id: i.id, month: i.month, status: i.status, totalCents: i.totalCents, lines: withLineLabels(i.lines), holdReason: i.holdReason, hostedUrl: i.hostedUrl, lastPaymentError: i.lastPaymentError, paidAt: i.paidAt?.toISOString() ?? null })),
  });
});

/** The billing contact the invoices go to (manage:org): saved here, and on the Stripe customer when there is one. */
billingRouter.put('/contact', requireCapability('manage:org'), async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().max(160).nullable(),
      email: z.string().trim().max(254).regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, 'Must be a bare email address.').nullable(),
    })
    .strict()
    .parse(req.body);
  const tenantId = tenantIdForWrite();
  const r = await saveBillingContact(prisma, tenantId, { name: input.name || null, email: input.email || null });
  await recordCriticalAudit({ actorUserId: req.user!.id, clientId: null, tenantId, action: 'billing.contact_saved', entityType: 'Tenant', entityId: tenantId, metadata: { ...input, stripeUpdated: r.stripeUpdated } }, 'billing');
  res.json({ contact: await billingContact(prisma, tenantId), stripeUpdated: r.stripeUpdated });
});

billingRouter.get('/usage', VIEW, async (req, res) => {
  const month = MonthSchema.parse(req.query.month ?? localToday().slice(0, 7));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const rows = await prisma.usageSnapshot.findMany({
    where: { tenantId: tenantIdForWrite(), day: { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) } },
    orderBy: [{ day: 'asc' }, { type: 'asc' }],
    select: { day: true, type: true, count: true },
  });
  res.json({ month, days: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), type: r.type, count: r.count })) });
});

billingRouter.put('/prices', requireCapability('manage:org'), async (req, res) => {
  operatorOnly();
  const input = z.object({ plan: z.string().trim().min(2).max(40), type: z.enum(WORKER_TYPES), unitPriceCents: z.number().int().min(0).max(10_000_000), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(req.body);
  if (input.plan === 'internal') throw new HttpError(400, 'internal_plan', 'The internal plan is never invoiced.');
  const row = await prisma.billingPrice.upsert({
    where: { plan_type_effectiveFrom: { plan: input.plan, type: input.type, effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`) } },
    create: { plan: input.plan, type: input.type, unitPriceCents: input.unitPriceCents, effectiveFrom: new Date(`${input.effectiveFrom}T00:00:00Z`), createdById: req.user!.id },
    update: { unitPriceCents: input.unitPriceCents },
  });
  await recordCriticalAudit({ actorUserId: req.user!.id, clientId: null, tenantId: ALTO_TENANT_ID, action: 'billing.price_set', entityType: 'BillingPrice', entityId: row.id, metadata: input }, 'billing');
  res.json({ id: row.id });
});

billingRouter.post('/close', requireCapability('manage:org'), async (req, res) => {
  operatorOnly();
  const { tenantId, month } = z.object({ tenantId: z.string().uuid(), month: MonthSchema }).strict().parse(req.body);
  const r = await invoiceMonth(prisma, tenantId, month);
  if (!r) throw new HttpError(409, 'not_invoiced', 'That tenant is on the internal plan, or does not exist.');
  res.json(r);
});

/** Mounted before express.json: the signature is over the raw bytes. */
export const stripeWebhookRouter = Router();
stripeWebhookRouter.post('/', express.raw({ type: 'application/json', limit: '512kb' }), async (req, res, next) => {
  try {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      res.status(503).json({ error: { code: 'stripe_not_configured', message: 'Stripe is not configured.' } });
      return;
    }
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyStripeSignature(raw, req.header('stripe-signature') ?? '', secret)) {
      res.status(400).json({ error: { code: 'bad_signature', message: 'The signature does not match.' } });
      return;
    }
    const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
    await applyStripeEvent(prisma, event);
    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});
