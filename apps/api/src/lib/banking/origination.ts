import { randomUUID } from 'node:crypto';
import { ProviderError, hmac, providerFetch, safeEqual, vendorMessage } from '../providers/http.js';
import type { ProviderContext } from '../providers/connections.js';

/**
 * Who sends our ACH entries to the network.
 *
 *   IN_HOUSE         we write the NACHA file; Finance uploads it to the
 *                    company's own bank (most banks take one through their
 *                    treasury portal) and uploads the return file the bank
 *                    sends back. No partner account needed.
 *   MODERN_TREASURY  one payment order per entry through Modern Treasury,
 *                    from the tenant's internal account at its bank.
 *   INCREASE         one ACH transfer per entry from the tenant's Increase
 *                    account.
 *
 * Every adapter takes the same entries, returns a reference per entry, and
 * turns the provider's webhooks into the same small set of events (settled,
 * returned with an R-code, a notification of change with a C-code), so the
 * rest of the product never knows which bank moved the money.
 *
 * Request shapes follow each vendor's public API reference (read
 * 2026-10-18). Fields we could not confirm are marked
 * "CONFIRM WITH <vendor>".
 */

export type OriginationProviderId = 'IN_HOUSE' | 'MODERN_TREASURY' | 'INCREASE';

export interface OriginationEntry {
  /** Our AchEntry id — the idempotency key for the provider. */
  id: string;
  direction: 'credit' | 'debit';
  sec: 'PPD' | 'CCD';
  prenote: boolean;
  amountCents: number;
  routingNumber: string;
  accountNumber: string;
  accountType: 'CHECKING' | 'SAVINGS';
  name: string;
  /** Shown on the receiver's statement (10 characters for ACH). */
  descriptor: string;
  effectiveDate: string;
  sameDay: boolean;
}

export interface OriginationResult {
  entryId: string;
  externalRef: string | null;
  accepted: boolean;
  error: string | null;
}

export type OriginationEvent =
  | { kind: 'SETTLED'; eventId: string; externalRef: string }
  | { kind: 'RETURNED'; eventId: string; externalRef: string; code: string }
  | { kind: 'NOC'; eventId: string; externalRef: string; code: string; correctedData: string }
  | { kind: 'FAILED'; eventId: string; externalRef: string; reason: string };

export interface OriginationProvider {
  readonly id: OriginationProviderId;
  /** Send each entry; IN_HOUSE sends nothing (the file is downloaded). */
  originate(entries: OriginationEntry[]): Promise<OriginationResult[]>;
  test(): Promise<void>;
  parseWebhook(raw: Buffer, headers: Record<string, string | undefined>): OriginationEvent[];
}

/* ----- in-house: the file is the delivery ----------------------------------- */

export const inHouseProvider: OriginationProvider = {
  id: 'IN_HOUSE',
  async originate(entries) {
    return entries.map((e) => ({ entryId: e.id, externalRef: null, accepted: true, error: null }));
  },
  async test() {
    /* nothing to reach: the file goes to your bank by hand */
  },
  parseWebhook() {
    throw new ProviderError('Files made for your own bank have no webhooks — upload the bank’s return file instead.', 400, 'no_webhooks');
  },
};

/* ----- Modern Treasury -------------------------------------------------------- */

/**
 * POST /api/payment_orders with HTTP Basic (organization id : API key).
 * type "ach", direction credit|debit, amount in cents, subtype PPD|CCD,
 * priority "high" asks for same-day ACH, effective_date, the tenant's
 * originating_account_id, and an inline receiving_account with
 * account_details and routing_details. Idempotency-Key header per entry.
 * Webhooks carry X-Signature: hex HMAC-SHA256 of the raw body with the
 * webhook key. Events: payment_order.completed, .returned (the return's
 * code under data.returns or data.return — CONFIRM WITH MODERN TREASURY),
 * .failed, and notification-of-change on the counterparty account
 * (CONFIRM WITH MODERN TREASURY).
 */
export function modernTreasuryProvider(ctx: ProviderContext): OriginationProvider {
  const auth = 'Basic ' + Buffer.from(`${ctx.credentials.organizationId ?? ''}:${ctx.credentials.apiKey ?? ''}`).toString('base64');
  const originating = String(ctx.settings.originatingAccountId ?? '');
  return {
    id: 'MODERN_TREASURY',
    async originate(entries) {
      if (!originating) throw new ProviderError('Add your Modern Treasury internal account ID to the connection.', 400, 'missing_setting');
      const out: OriginationResult[] = [];
      for (const e of entries) {
        const body = {
          type: 'ach',
          direction: e.direction,
          amount: e.amountCents,
          currency: 'USD',
          subtype: e.sec,
          priority: e.sameDay ? 'high' : 'normal',
          effective_date: e.effectiveDate,
          originating_account_id: originating,
          statement_descriptor: e.descriptor.slice(0, 10),
          // A prenote is a zero-dollar entry; Modern Treasury runs prenotes on the counterparty account (CONFIRM WITH MODERN TREASURY).
          metadata: { alto_entry_id: e.id, prenote: String(e.prenote) },
          receiving_account: {
            party_name: e.name,
            account_details: [{ account_number: e.accountNumber, account_number_type: 'other' }],
            routing_details: [{ routing_number: e.routingNumber, routing_number_type: 'aba' }],
            account_type: e.accountType === 'SAVINGS' ? 'savings' : 'checking',
          },
        };
        const r = await providerFetch<{ id?: string }>(`${ctx.baseUrl}/api/payment_orders`, {
          method: 'POST',
          headers: { authorization: auth, 'content-type': 'application/json', 'idempotency-key': e.id },
          body: JSON.stringify(body),
        });
        out.push(r.ok ? { entryId: e.id, externalRef: r.json.id ?? null, accepted: true, error: null } : { entryId: e.id, externalRef: null, accepted: false, error: vendorMessage(r.json, `Modern Treasury refused it (${r.status}).`) });
      }
      return out;
    },
    async test() {
      const r = await providerFetch(`${ctx.baseUrl}/api/ping`, { headers: { authorization: auth } });
      if (!r.ok) throw new ProviderError(vendorMessage(r.json, 'Modern Treasury refused the organization ID or API key.'), r.status, 'auth_failed');
    },
    parseWebhook(raw, headers) {
      const sig = headers['x-signature'] ?? '';
      if (!ctx.webhookSecret || !sig || !safeEqual(hmac(ctx.webhookSecret, raw), sig)) throw new ProviderError('Signature does not match.', 401, 'bad_signature');
      const j = JSON.parse(raw.toString('utf8')) as { event?: string; id?: string; data?: Record<string, unknown> };
      const data = j.data ?? {};
      const ref = String(data.id ?? '');
      const eventId = String(headers['x-webhook-id'] ?? j.id ?? `${ref}:${j.event}`);
      switch (j.event) {
        case 'completed':
        case 'payment_order.completed':
          return [{ kind: 'SETTLED', eventId, externalRef: ref }];
        case 'returned':
        case 'payment_order.returned': {
          const returns = (data.returns ?? data.return) as Array<{ code?: string }> | { code?: string } | undefined;
          const code = Array.isArray(returns) ? returns[0]?.code : returns?.code;
          return [{ kind: 'RETURNED', eventId, externalRef: ref, code: String(code ?? 'R00').toUpperCase() }];
        }
        case 'failed':
        case 'payment_order.failed':
          return [{ kind: 'FAILED', eventId, externalRef: ref, reason: String(data.failure_reason ?? 'The bank did not accept it.') }];
        case 'payment_order.notification_of_change': {
          // CONFIRM WITH MODERN TREASURY: the NOC payload shape.
          const noc = (data.notification_of_change ?? {}) as { code?: string; corrected_data?: string };
          return [{ kind: 'NOC', eventId, externalRef: ref, code: String(noc.code ?? ''), correctedData: String(noc.corrected_data ?? '') }];
        }
        default:
          return [];
      }
    },
  };
}

/* ----- Increase ---------------------------------------------------------------- */

/**
 * POST /ach_transfers with a Bearer API key: account_id, amount in cents
 * (positive sends money out — a credit; negative pulls it in — a debit),
 * account_number, routing_number, funding checking|savings,
 * standard_entry_class_code (ppd / corporate_credit_or_debit for CCD),
 * statement_descriptor, preferred_effective_date with settlement_schedule
 * same_day|future_dated (CONFIRM WITH INCREASE), and an Idempotency-Key.
 * Webhooks: Increase-Webhook-Signature "t=<ts>,v1=<hex HMAC-SHA256 of
 * `${t}.${body}`>". Events name the object (ach_transfer.updated); the
 * transfer's status (returned, with return.return_reason_code) and its
 * notifications_of_change are read back from the event's associated object
 * (CONFIRM WITH INCREASE: which fields arrive inline).
 */
export function increaseProvider(ctx: ProviderContext): OriginationProvider {
  const key = ctx.credentials.apiKey ?? '';
  const accountId = String(ctx.settings.accountId ?? '');
  return {
    id: 'INCREASE',
    async originate(entries) {
      if (!accountId) throw new ProviderError('Add your Increase account ID to the connection.', 400, 'missing_setting');
      const out: OriginationResult[] = [];
      for (const e of entries) {
        const body = {
          account_id: accountId,
          amount: e.direction === 'credit' ? e.amountCents : -e.amountCents,
          account_number: e.accountNumber,
          routing_number: e.routingNumber,
          funding: e.accountType === 'SAVINGS' ? 'savings' : 'checking',
          standard_entry_class_code: e.sec === 'PPD' ? 'prearranged_payments_and_deposit' : 'corporate_credit_or_debit',
          statement_descriptor: e.descriptor.slice(0, 10),
          individual_name: e.name.slice(0, 22),
          preferred_effective_date: { date: e.effectiveDate, settlement_schedule: e.sameDay ? 'same_day' : 'future_dated' },
        };
        const r = await providerFetch<{ id?: string }>(`${ctx.baseUrl}/ach_transfers`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': e.id },
          body: JSON.stringify(body),
        });
        out.push(r.ok ? { entryId: e.id, externalRef: r.json.id ?? null, accepted: true, error: null } : { entryId: e.id, externalRef: null, accepted: false, error: vendorMessage(r.json, `Increase refused it (${r.status}).`) });
      }
      return out;
    },
    async test() {
      const r = await providerFetch(`${ctx.baseUrl}/accounts?limit=1`, { headers: { authorization: `Bearer ${key}` } });
      if (!r.ok) throw new ProviderError(vendorMessage(r.json, 'Increase refused the API key.'), r.status, 'auth_failed');
    },
    parseWebhook(raw, headers) {
      const header = headers['increase-webhook-signature'] ?? '';
      const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
      if (!ctx.webhookSecret || !parts.t || !parts.v1 || !safeEqual(hmac(ctx.webhookSecret, `${parts.t}.${raw.toString('utf8')}`), parts.v1)) {
        throw new ProviderError('Signature does not match.', 401, 'bad_signature');
      }
      const j = JSON.parse(raw.toString('utf8')) as {
        id?: string;
        category?: string;
        associated_object_id?: string;
        associated_object?: { status?: string; return?: { return_reason_code?: string }; notifications_of_change?: Array<{ change_code?: string; corrected_data?: string }> };
      };
      const ref = String(j.associated_object_id ?? '');
      const eventId = String(j.id ?? randomUUID());
      const obj = j.associated_object;
      if (!obj) return [];
      const events: OriginationEvent[] = [];
      if (obj.status === 'returned') events.push({ kind: 'RETURNED', eventId, externalRef: ref, code: String(obj.return?.return_reason_code ?? 'R00').toUpperCase() });
      // 'submitted' only means it reached the Fed; the effective date settles it (lib/banking/cron). CONFIRM WITH INCREASE whether a 'settled' status is sent.
      else if (obj.status === 'settled') events.push({ kind: 'SETTLED', eventId, externalRef: ref });
      else if (obj.status === 'rejected' || obj.status === 'canceled') events.push({ kind: 'FAILED', eventId, externalRef: ref, reason: `Increase ${obj.status} it.` });
      for (const [i, n] of (obj.notifications_of_change ?? []).entries()) {
        events.push({ kind: 'NOC', eventId: `${eventId}:noc:${i}`, externalRef: ref, code: String(n.change_code ?? '').toUpperCase(), correctedData: String(n.corrected_data ?? '') });
      }
      return events;
    },
  };
}

export function originationProviderFor(ctx: ProviderContext | null): OriginationProvider {
  if (!ctx) return inHouseProvider;
  if (ctx.provider === ('MODERN_TREASURY' as string)) return modernTreasuryProvider(ctx);
  if (ctx.provider === ('INCREASE' as string)) return increaseProvider(ctx);
  return inHouseProvider;
}
