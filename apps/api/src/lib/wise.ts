import { env } from '../config/env.js';

/**
 * Wise (TransferWise) USD domestic payout client — the real thing, not the
 * scaffold. Four-call sequence per payout, matching Wise's documented flow:
 *
 *   1. POST /v3/profiles/{profileId}/quotes            — USD→USD quote
 *   2. POST /v1/accounts                               — ABA recipient
 *   3. POST /v1/transfers                              — transfer against the quote
 *   4. POST /v3/profiles/{profileId}/transfers/{id}/payments — fund from balance
 *
 * Idempotency: Wise dedupes transfers on customerTransactionId, which we set
 * to the PayrollItem id (a UUID, which is exactly what Wise expects). A retry
 * of an already-funded transfer therefore cannot double-pay.
 *
 * Status mapping: a successfully FUNDED transfer returns SUCCESS — the funds
 * have left the balance. Wise's later lifecycle events (outgoing_payment_sent,
 * bounced_back) would need a webhook to track; until one exists, a bounce
 * surfaces as a balance credit reviewed out-of-band. Every API failure maps
 * to FAILED with the provider's own error text so the HR failure queue shows
 * something actionable.
 */

export function isWiseConfigured(): boolean {
  return !!(env.WISE_API_KEY && env.WISE_PROFILE_ID);
}

interface WiseRecipientInput {
  fullName: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'CHECKING' | 'SAVINGS';
  address: {
    line1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
}

export interface WiseTransferInput {
  amount: number;
  recipient: WiseRecipientInput;
  /** PayrollItem.id — becomes Wise's customerTransactionId (must be a UUID). */
  idempotencyKey: string;
  memo?: string;
}

export interface WiseTransferResult {
  transferId: string;
  status: 'SUCCESS' | 'FAILED';
  failureReason: string | null;
}

async function wiseFetch(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${env.WISE_API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WISE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body — status code carries the story */
  }
  return { ok: res.ok, status: res.status, json };
}

function wiseError(step: string, status: number, json: Record<string, unknown>): string {
  const detail =
    (Array.isArray(json.errors) &&
      json.errors
        .map((e) => (typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : ''))
        .filter(Boolean)
        .join('; ')) ||
    (typeof json.error === 'string' ? json.error : '') ||
    (typeof json.message === 'string' ? json.message : '');
  return `wise_${step}_failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
}

export async function createWiseTransfer(
  input: WiseTransferInput,
): Promise<WiseTransferResult> {
  const profileId = env.WISE_PROFILE_ID!;

  // 1. Quote — USD to USD, target-amount fixed so the recipient nets the
  // exact paycheck figure and any fee comes off the balance.
  const quote = await wiseFetch(`/v3/profiles/${profileId}/quotes`, {
    sourceCurrency: 'USD',
    targetCurrency: 'USD',
    targetAmount: input.amount,
    payOut: 'BANK_TRANSFER',
  });
  if (!quote.ok || typeof quote.json.id !== 'string') {
    return { transferId: '', status: 'FAILED', failureReason: wiseError('quote', quote.status, quote.json) };
  }

  // 2. Recipient — ABA (US domestic) account. Wise requires an address for
  // ABA recipients; missing pieces fail loudly here rather than at transfer.
  const addr = input.recipient.address;
  if (!addr.line1 || !addr.city || !addr.state || !addr.zip) {
    return {
      transferId: '',
      status: 'FAILED',
      failureReason:
        'wise_recipient_incomplete: Wise ABA payouts require the associate\'s street address, city, state, and ZIP on file',
    };
  }
  const account = await wiseFetch('/v1/accounts', {
    currency: 'USD',
    type: 'aba',
    profile: Number(profileId),
    accountHolderName: input.recipient.fullName,
    details: {
      legalType: 'PRIVATE',
      abartn: input.recipient.routingNumber,
      accountNumber: input.recipient.accountNumber,
      accountType: input.recipient.accountType,
      address: {
        country: 'US',
        city: addr.city,
        state: addr.state,
        postCode: addr.zip,
        firstLine: addr.line1,
      },
    },
  });
  if (!account.ok || typeof account.json.id !== 'number') {
    return { transferId: '', status: 'FAILED', failureReason: wiseError('recipient', account.status, account.json) };
  }

  // 3. Transfer — customerTransactionId is the idempotency anchor.
  const transfer = await wiseFetch('/v1/transfers', {
    targetAccount: account.json.id,
    quoteUuid: quote.json.id,
    customerTransactionId: input.idempotencyKey,
    details: { reference: (input.memo ?? 'Payroll').slice(0, 100) },
  });
  if (!transfer.ok || transfer.json.id === undefined) {
    return { transferId: '', status: 'FAILED', failureReason: wiseError('transfer', transfer.status, transfer.json) };
  }
  const transferId = String(transfer.json.id);

  // 4. Fund from the profile's USD balance.
  const fund = await wiseFetch(
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    { type: 'BALANCE' },
  );
  const fundStatus =
    typeof fund.json.status === 'string' ? fund.json.status.toUpperCase() : '';
  if (!fund.ok || fundStatus === 'REJECTED') {
    return {
      transferId,
      status: 'FAILED',
      failureReason: wiseError('funding', fund.status, fund.json),
    };
  }
  return { transferId, status: 'SUCCESS', failureReason: null };
}
