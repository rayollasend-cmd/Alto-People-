import { describe, expect, it } from 'vitest';
import {
  signResendWebhook,
  verifyResendWebhookSignature,
} from '../../lib/resendWebhook.js';

/**
 * Unit tests for the hand-rolled Svix signature verification. The
 * known-answer fixture is the worked example from Svix's own "verifying
 * webhooks manually" docs, so we're compatible with the real scheme, not
 * merely self-consistent.
 */

// Svix documentation example — signature computed by Svix, not by us.
const SVIX_DOC_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const SVIX_DOC_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const SVIX_DOC_TIMESTAMP = '1614265330';
const SVIX_DOC_PAYLOAD = '{"test": 2432232314}';
const SVIX_DOC_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
// The docs example timestamp is from 2021 — pin "now" next to it so the
// tolerance window doesn't rot the test (fixed-date test rot lesson).
const SVIX_DOC_NOW_MS = Number(SVIX_DOC_TIMESTAMP) * 1000;

// Local fixture secret for the generated-signature cases.
const SECRET = 'whsec_dGVzdC1zZWNyZXQtZm9yLXVuaXQtdGVzdHM=';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('verifyResendWebhookSignature', () => {
  it('accepts the Svix documentation known-answer fixture', () => {
    expect(
      verifyResendWebhookSignature(SVIX_DOC_PAYLOAD, {
        svixId: SVIX_DOC_ID,
        svixTimestamp: SVIX_DOC_TIMESTAMP,
        svixSignature: SVIX_DOC_SIGNATURE,
      }, { secret: SVIX_DOC_SECRET, nowMs: SVIX_DOC_NOW_MS }),
    ).toBe(true);
  });

  it('accepts a valid self-signed delivery', () => {
    const body = Buffer.from(JSON.stringify({ type: 'email.delivered', data: {} }));
    const id = 'msg_valid';
    const ts = String(nowSeconds());
    const sig = signResendWebhook(body, id, ts, SECRET);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: id,
        svixTimestamp: ts,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(true);
  });

  it('rejects a wrong signature', () => {
    const body = '{"type":"email.delivered"}';
    const ts = String(nowSeconds());
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_1',
        svixTimestamp: ts,
        // Valid base64, right length, wrong bytes.
        svixSignature: `v1,${Buffer.alloc(32, 7).toString('base64')}`,
      }, { secret: SECRET }),
    ).toBe(false);
  });

  it('rejects a signature computed over a DIFFERENT body', () => {
    const ts = String(nowSeconds());
    const sig = signResendWebhook('{"a":1}', 'msg_2', ts, SECRET);
    expect(
      verifyResendWebhookSignature('{"a":2}', {
        svixId: 'msg_2',
        svixTimestamp: ts,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(false);
  });

  it('rejects a stale timestamp (older than 5 minutes)', () => {
    const body = '{"type":"email.delivered"}';
    const staleTs = String(nowSeconds() - 6 * 60);
    const sig = signResendWebhook(body, 'msg_3', staleTs, SECRET);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_3',
        svixTimestamp: staleTs,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(false);
  });

  it('accepts a timestamp just inside the tolerance window', () => {
    const body = '{"type":"email.delivered"}';
    const ts = String(nowSeconds() - 4 * 60);
    const sig = signResendWebhook(body, 'msg_4', ts, SECRET);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_4',
        svixTimestamp: ts,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(true);
  });

  it('accepts when ANY of multiple space-separated v1 entries matches (secret rotation)', () => {
    const body = '{"type":"email.bounced"}';
    const ts = String(nowSeconds());
    const good = signResendWebhook(body, 'msg_5', ts, SECRET);
    const badEntry = `v1,${Buffer.alloc(32, 9).toString('base64')}`;
    const otherScheme = 'v2,bm90LXYx';
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_5',
        svixTimestamp: ts,
        svixSignature: `${badEntry} ${otherScheme} ${good}`,
      }, { secret: SECRET }),
    ).toBe(true);
  });

  it('rejects when only non-v1 schemes are present', () => {
    const body = '{"type":"email.bounced"}';
    const ts = String(nowSeconds());
    const good = signResendWebhook(body, 'msg_6', ts, SECRET);
    // Same bytes but labelled v2 — must be skipped, not trusted.
    const relabelled = good.replace(/^v1,/, 'v2,');
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_6',
        svixTimestamp: ts,
        svixSignature: relabelled,
      }, { secret: SECRET }),
    ).toBe(false);
  });

  it('rejects missing headers and missing secret', () => {
    const body = '{}';
    const ts = String(nowSeconds());
    const sig = signResendWebhook(body, 'msg_7', ts, SECRET);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: undefined,
        svixTimestamp: ts,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(false);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_7',
        svixTimestamp: undefined,
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(false);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_7',
        svixTimestamp: ts,
        svixSignature: undefined,
      }, { secret: SECRET }),
    ).toBe(false);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_7',
        svixTimestamp: ts,
        svixSignature: sig,
      }, { secret: '' }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp', () => {
    const body = '{}';
    const sig = signResendWebhook(body, 'msg_8', 'not-a-number', SECRET);
    expect(
      verifyResendWebhookSignature(body, {
        svixId: 'msg_8',
        svixTimestamp: 'not-a-number',
        svixSignature: sig,
      }, { secret: SECRET }),
    ).toBe(false);
  });
});
