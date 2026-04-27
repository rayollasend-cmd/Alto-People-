import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Phase 45 — Branch payments client.
 *
 * Branch is our US-domestic disbursement rail. This module wraps Branch's
 * REST API with three concerns:
 *   1) Bearer-auth + idempotency-key on every payment POST so duplicate
 *      Express handler calls never double-pay an associate.
 *   2) A clean status mapping: Branch reports payment lifecycle states,
 *      we collapse them to our SUCCESS / PENDING / FAILED triple. The
 *      adapter layer (lib/disbursement.ts) and route handlers stay
 *      provider-agnostic.
 *   3) HMAC webhook verification so the public webhook route can trust
 *      the body before it touches the database.
 *
 * Stub mode: Branch keeps moving its endpoint paths between docs versions.
 * If you hit a 404 or shape mismatch, leave BRANCH_API_KEY unset to fall
 * back to STUB-BRANCH-... refs (handled in disbursement.ts) and update
 * the request/response shapes here against the live docs before re-enabling.
 */

export type BranchPaymentStatus =
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface CreatePaymentInput {
  /** Dollars (decimal). */
  amount: number;
  /** ISO 4217. We only call BRANCH for USD; non-USD is rejected upstream. */
  currency: string;
  /**
   * Stable identifier Branch uses to address the recipient. For our model
   * this is PayoutMethod.branchCardId for BRANCH_CARD payouts, or a
   * Branch-side employee id we'd provision separately for ACH payouts.
   */
  employeeRef: string;
  /**
   * PayrollItem.id — passed both as the body's customer-side reference AND
   * as the Idempotency-Key header so a retried POST is collapsed into a
   * single payment on Branch's side.
   */
  idempotencyKey: string;
  /** Optional human memo shown on the recipient's transaction history. */
  memo?: string;
}

export interface CreatePaymentResult {
  paymentId: string;
  status: BranchPaymentStatus;
  failureReason: string | null;
}

export interface BranchWebhookPayload {
  event: string;
  payment: {
    id: string;
    status: BranchPaymentStatus;
    failure_reason?: string | null;
  };
}

const TIMEOUT_MS = 10_000;

export function isBranchConfigured(): boolean {
  return (
    env.PAYROLL_DISBURSEMENT_PROVIDER === 'BRANCH' &&
    typeof env.BRANCH_API_KEY === 'string' &&
    env.BRANCH_API_KEY.length > 0
  );
}

/**
 * Map Branch's payment-lifecycle states onto our DisbursementResult triple.
 * Anything we don't recognize collapses to PENDING — safer than treating
 * an unknown state as a hard failure that would mark the item HELD.
 */
export function mapBranchStatus(
  s: BranchPaymentStatus
): 'SUCCESS' | 'PENDING' | 'FAILED' {
  switch (s) {
    case 'COMPLETED':
      return 'SUCCESS';
    case 'FAILED':
    case 'CANCELLED':
      return 'FAILED';
    case 'PROCESSING':
    case 'UNKNOWN':
    default:
      return 'PENDING';
  }
}

export async function createPayment(
  input: CreatePaymentInput
): Promise<CreatePaymentResult> {
  if (!env.BRANCH_API_KEY) {
    throw new Error('BRANCH_API_KEY missing — caller should fall back to stub');
  }
  const url = `${env.BRANCH_API_BASE_URL}/v1/payments`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${env.BRANCH_API_KEY}`,
        'Content-Type': 'application/json',
        // Branch (and most modern payment APIs) honors a customer-supplied
        // idempotency key so a retried POST is collapsed server-side.
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        employee_id: input.employeeRef,
        external_reference: input.idempotencyKey,
        memo: input.memo ?? null,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`branch_network_error: ${msg}`);
  }
  clearTimeout(timer);

  const text = await resp.text();
  if (!resp.ok) {
    // Surface Branch's own error envelope verbatim — finance reads this
    // off the qboSyncError-style failure_reason column when reconciling.
    throw new Error(`branch_${resp.status}: ${text.slice(0, 300)}`);
  }

  let parsed: { id?: string; status?: string; failure_reason?: string | null };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('branch_parse_error: response was not JSON');
  }

  if (typeof parsed.id !== 'string' || typeof parsed.status !== 'string') {
    throw new Error('branch_shape_error: response missing id or status');
  }

  return {
    paymentId: parsed.id,
    status: normalizeStatus(parsed.status),
    failureReason: parsed.failure_reason ?? null,
  };
}

function normalizeStatus(s: string): BranchPaymentStatus {
  const upper = s.toUpperCase();
  if (
    upper === 'PROCESSING' ||
    upper === 'COMPLETED' ||
    upper === 'FAILED' ||
    upper === 'CANCELLED'
  ) {
    return upper;
  }
  return 'UNKNOWN';
}

/**
 * Verify a Branch webhook delivery. Branch signs the raw request body with
 * BRANCH_WEBHOOK_SECRET using HMAC-SHA256 and sends the hex digest in the
 * X-Branch-Signature header. timingSafeEqual avoids early-exit timing
 * leaks on prefix matches.
 *
 * Returns false if the secret isn't configured — the route MUST refuse
 * the request in that case rather than silently accepting unsigned posts.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined
): boolean {
  if (!env.BRANCH_WEBHOOK_SECRET || !signatureHeader) return false;
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', env.BRANCH_WEBHOOK_SECRET)
    .update(buf)
    .digest('hex');
  // Header may be hex with or without a "sha256=" prefix. Handle both.
  const provided = signatureHeader.replace(/^sha256=/i, '').trim();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}
