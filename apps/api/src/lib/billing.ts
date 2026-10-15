import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { activeWorkersBetween } from './activeDefinition.js';
import { enqueueAudit } from './audit.js';
import { companyWorkweek, utcInstantOfLocalMidnight } from './timeAnomalies.js';
import { ALTO_TENANT_ID, runWithTenant } from './tenant.js';

/**
 * Brief 2-6 step 4 — usage and invoices (docs/agent-product-billing-investigation.md §4.4).
 *
 *   Daily: a snapshot per tenant, day and worker type of who was active
 *   (lib/activeDefinition.activeWorkersBetween, the one rule), with the ids
 *   kept as evidence. Monthly: the billable count is the distinct workers
 *   active on at least one day (decision 1), with a hash of the ids so the
 *   count can be re-proved. Then an invoice: counts × the plan's price per
 *   type. No price ships (decision 3): an invoice without its prices waits
 *   as a draft. The internal plan (Alto HR) is never invoiced.
 *
 *   Stripe (decision 4): counts and prices only, never a worker's name or
 *   id; one customer per tenant; invoice items with quantities; finalize.
 *   TEST MODE ONLY until the owner approves live: a live key is refused
 *   unless STRIPE_LIVE_APPROVED=yes.
 */

type Db = PrismaClient;
export const WORKER_TYPES = ['PERSON', 'AGENT', 'ROBOT'] as const;
export type WorkerType = (typeof WORKER_TYPES)[number];

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Today's date in the organization's zone. */
export function localToday(now: Date = new Date(), tz: string = companyWorkweek().timezone): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

/** One tenant's snapshot of a local day; idempotent (a day once written stays). */
export async function snapshotDay(db: Db, tenantId: string, day: string, tz: string = companyWorkweek().timezone): Promise<number> {
  const from = utcInstantOfLocalMidnight(day, tz);
  const to = utcInstantOfLocalMidnight(nextDay(day), tz);
  const active = await activeWorkersBetween(tenantId, from, to, db);
  const r = await db.usageSnapshot.createMany({
    data: WORKER_TYPES.map((type) => ({ tenantId, day: new Date(`${day}T00:00:00Z`), type, count: active[type].length, ids: active[type] })),
    skipDuplicates: true,
  });
  return r.count;
}

/** The tick: yesterday and the two days before it, for every tenant, if missing. */
export async function runUsageSnapshots(db: Db, now: Date = new Date()): Promise<number> {
  const tenants = await db.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  let wrote = 0;
  const today = localToday(now);
  for (const t of tenants) {
    let day = today;
    for (let i = 0; i < 3; i++) {
      const d = new Date(`${day}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      day = ymd(d);
      const have = await db.usageSnapshot.count({ where: { tenantId: t.id, day: new Date(`${day}T00:00:00Z`) } });
      if (have >= WORKER_TYPES.length) continue;
      wrote += await runWithTenant(t.id, 'job', () => snapshotDay(db, t.id, day));
    }
  }
  return wrote;
}

const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
};

/** The month's billable counts by type, from the snapshots: distinct ids active on at least one day. */
export async function closeMonthUsage(db: Db, tenantId: string, month: string): Promise<Record<WorkerType, number>> {
  const { from, to } = monthBounds(month);
  const snaps = await db.usageSnapshot.findMany({ where: { tenantId, day: { gte: from, lt: to } }, select: { type: true, ids: true } });
  const out = {} as Record<WorkerType, number>;
  for (const type of WORKER_TYPES) {
    const ids = [...new Set(snaps.filter((s) => s.type === type).flatMap((s) => s.ids))].sort();
    out[type] = ids.length;
    const evidenceHash = createHash('sha256').update(ids.join('\n')).digest('hex');
    await db.usageRecord.upsert({
      where: { tenantId_month_type: { tenantId, month, type } },
      create: { tenantId, month, type, billableCount: ids.length, evidenceHash },
      update: { billableCount: ids.length, evidenceHash, computedAt: new Date() },
    });
  }
  return out;
}

/** The plan's price per type in force at the month's start, or null when the owner has not set it. */
async function priceFor(db: Db, plan: string, type: WorkerType, month: string): Promise<number | null> {
  const { from } = monthBounds(month);
  const p = await db.billingPrice.findFirst({ where: { plan, type, effectiveFrom: { lte: from } }, orderBy: { effectiveFrom: 'desc' } });
  return p ? p.unitPriceCents : null;
}

export interface InvoiceLine {
  type: WorkerType;
  quantity: number;
  unitPriceCents: number | null;
  amountCents: number;
}

/**
 * The month's invoice for a tenant: usage closed, lines priced, sent to
 * Stripe (test mode) when everything is in place, else held as a draft
 * with its reason. Idempotent per tenant and month; an OPEN or PAID invoice
 * is never rebuilt.
 */
export async function invoiceMonth(db: Db, tenantId: string, month: string): Promise<{ id: string; status: string; holdReason: string | null } | null> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true, name: true } });
  if (!tenant || tenant.plan === 'internal') return null;
  const existing = await db.billingInvoice.findUnique({ where: { tenantId_month: { tenantId, month } } });
  if (existing && existing.status !== 'DRAFT') return { id: existing.id, status: existing.status, holdReason: existing.holdReason };
  const counts = await closeMonthUsage(db, tenantId, month);
  const lines: InvoiceLine[] = [];
  for (const type of WORKER_TYPES) {
    if (!counts[type]) continue;
    const unit = await priceFor(db, tenant.plan, type, month);
    lines.push({ type, quantity: counts[type], unitPriceCents: unit, amountCents: unit === null ? 0 : unit * counts[type] });
  }
  const holdReason = lines.some((l) => l.unitPriceCents === null) ? 'prices_missing' : !stripeMode() ? 'stripe_not_configured' : null;
  const totalCents = lines.reduce((a, l) => a + l.amountCents, 0);
  const row = await db.billingInvoice.upsert({
    where: { tenantId_month: { tenantId, month } },
    create: { tenantId, month, plan: tenant.plan, lines: lines as unknown as Prisma.InputJsonArray, totalCents, holdReason },
    update: { plan: tenant.plan, lines: lines as unknown as Prisma.InputJsonArray, totalCents, holdReason },
  });
  if (holdReason || totalCents === 0) return { id: row.id, status: row.status, holdReason };
  try {
    const sent = await sendToStripe(tenantId, tenant.name, row.id, month, lines);
    const updated = await db.billingInvoice.update({ where: { id: row.id }, data: { status: 'OPEN', stripeInvoiceId: sent.id, hostedUrl: sent.hostedUrl, holdReason: null } });
    enqueueAudit({ actorUserId: null, clientId: null, tenantId, action: 'billing.invoice_sent', entityType: 'BillingInvoice', entityId: row.id, metadata: { month, totalCents, stripeInvoiceId: sent.id, mode: stripeMode() } }, 'billing');
    return { id: updated.id, status: updated.status, holdReason: null };
  } catch (err) {
    const reason = `stripe_error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120);
    await db.billingInvoice.update({ where: { id: row.id }, data: { holdReason: reason } });
    return { id: row.id, status: 'DRAFT', holdReason: reason };
  }
}

/** On the month's first days: close and invoice the month before, for every tenant not on the internal plan. */
export async function runMonthClose(db: Db, now: Date = new Date()): Promise<number> {
  const today = localToday(now);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const tenants = await db.tenant.findMany({ where: { status: 'ACTIVE', NOT: { plan: 'internal' } }, select: { id: true } });
  let n = 0;
  for (const t of tenants) {
    const inv = await db.billingInvoice.findUnique({ where: { tenantId_month: { tenantId: t.id, month: prev } }, select: { status: true } });
    if (inv && inv.status !== 'DRAFT') continue;
    if (await runWithTenant(t.id, 'job', () => invoiceMonth(db, t.id, prev))) n += 1;
  }
  return n;
}

/* --------------------------------------------------------------- Stripe */

/** 'test' with an sk_test_ key; 'live' only with the owner's approval; null when not configured or refused. */
export function stripeMode(): 'test' | 'live' | null {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_') && env.STRIPE_LIVE_APPROVED === 'yes') return 'live';
  return null;
}

type StripeCall = (method: 'GET' | 'POST', path: string, params: Record<string, string | number>, idempotencyKey?: string) => Promise<Record<string, unknown>>;

const realStripe: StripeCall = async (method, path, params, idempotencyKey) => {
  const body = new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]));
  const url = `https://api.stripe.com/v1${path}${method === 'GET' && body.size ? `?${body}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    ...(method === 'POST' ? { body } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(((json.error as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`).slice(0, 100));
  return json;
};

let stripe: StripeCall = realStripe;
export function setStripeForTests(fn: StripeCall | null): void {
  stripe = fn ?? realStripe;
}

const LABEL: Record<WorkerType, string> = { PERSON: 'Active people', AGENT: 'Active AI agents', ROBOT: 'Active robots' };

async function sendToStripe(tenantId: string, tenantName: string, invoiceId: string, month: string, lines: InvoiceLine[]): Promise<{ id: string; hostedUrl: string | null }> {
  if (!stripeMode()) throw new Error('Stripe is not configured for this mode');
  const found = await stripe('GET', '/customers/search', { query: `metadata['altoTenantId']:'${tenantId}'` });
  let customer = ((found.data as Array<{ id: string }> | undefined) ?? [])[0]?.id;
  if (!customer) {
    const made = await stripe('POST', '/customers', { name: tenantName, 'metadata[altoTenantId]': tenantId }, `alto-customer-${tenantId}`);
    customer = made.id as string;
  }
  for (const l of lines) {
    await stripe(
      'POST',
      '/invoiceitems',
      { customer, currency: 'usd', quantity: l.quantity, unit_amount: l.unitPriceCents ?? 0, description: `${LABEL[l.type]}, ${month}`, 'metadata[altoInvoiceId]': invoiceId },
      `alto-item-${invoiceId}-${l.type}`,
    );
  }
  const inv = await stripe('POST', '/invoices', { customer, collection_method: 'send_invoice', days_until_due: 30, pending_invoice_items_behavior: 'include', 'metadata[altoInvoiceId]': invoiceId, 'metadata[month]': month }, `alto-invoice-${invoiceId}`);
  const fin = await stripe('POST', `/invoices/${inv.id as string}/finalize`, {}, `alto-finalize-${invoiceId}`);
  return { id: inv.id as string, hostedUrl: (fin.hosted_invoice_url as string | undefined) ?? null };
}

/** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.payload">; five minutes' tolerance. */
export function verifyStripeSignature(payload: string, header: string, secret: string, now: Date = new Date()): boolean {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
}

/** The Stripe events that move an invoice. */
export async function applyStripeEvent(db: Db, event: { type: string; data: { object: Record<string, unknown> } }): Promise<boolean> {
  const obj = event.data.object;
  const altoId = (obj.metadata as Record<string, string> | undefined)?.altoInvoiceId;
  const row = altoId ? await db.billingInvoice.findUnique({ where: { id: altoId } }) : obj.id ? await db.billingInvoice.findFirst({ where: { stripeInvoiceId: String(obj.id) } }) : null;
  if (!row) return false;
  if (event.type === 'invoice.paid') await db.billingInvoice.update({ where: { id: row.id }, data: { status: 'PAID', paidAt: new Date(), lastPaymentError: null } });
  else if (event.type === 'invoice.payment_failed') {
    const err = ((obj.last_finalization_error as { message?: string } | undefined)?.message ?? 'The payment failed.').slice(0, 500);
    await db.billingInvoice.update({ where: { id: row.id }, data: { lastPaymentError: err } });
  } else if (event.type === 'invoice.voided') await db.billingInvoice.update({ where: { id: row.id }, data: { status: 'VOID' } });
  else return false;
  enqueueAudit({ actorUserId: null, clientId: null, tenantId: row.tenantId ?? ALTO_TENANT_ID, action: `billing.${event.type.replace('.', '_')}`, entityType: 'BillingInvoice', entityId: row.id, metadata: { month: row.month } }, 'billing');
  return true;
}

/* ------------------------------------------------------------------ cron */

let timer: NodeJS.Timeout | null = null;

export function startBillingCron(db: Db): void {
  if (timer) return;
  const tick = async () => {
    try {
      await runUsageSnapshots(db);
      if (Number(localToday().slice(8, 10)) <= 3) await runMonthClose(db);
    } catch (err) {
      console.error('[alto-people/api] billing tick failed:', err);
    }
  };
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref();
  console.log(`[alto-people/api] usage and billing armed (hourly; Stripe ${stripeMode() ?? 'off'})`);
}
