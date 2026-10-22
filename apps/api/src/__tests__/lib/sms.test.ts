import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { createUser, prisma, truncateAll } from '../../../test/db.js';
import { twilioSignature } from '../../lib/callOutChannels.js';
import { PushNotConfiguredError, WhatsAppNotRoutedError, send, statusForSendError } from '../../lib/notifications.js';
import {
  SmsNotConfiguredError,
  SmsOptedOutError,
  handleSmsKeyword,
  isSmsOptedOut,
  isStartKeyword,
  isStopKeyword,
  normalizePhone,
  setSmsTransportForTests,
  smsAvailability,
} from '../../lib/sms.js';

/**
 * Audit 2026-10-21 item 1: SMS was a stub that reported every text as
 * sent. The generic sender now either texts through the transport or
 * tells the truth — NOT_CONFIGURED when no provider is set, SUPPRESSED for
 * a number that texted STOP — and every outcome is a Notification row.
 */

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => setSmsTransportForTests(null));
afterAll(async () => {
  await prisma.$disconnect();
});

describe('phone numbers and keywords', () => {
  it('reads what the roster holds as E.164 and refuses what cannot be dialled', () => {
    expect(normalizePhone('(555) 010-0100')).toBe('+15550100100');
    expect(normalizePhone('1 555 010 0100')).toBe('+15550100100');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('ext 1234')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('knows the carrier keywords in the languages the crew texts in', () => {
    for (const w of ['STOP', 'stop.', 'Unsubscribe', 'PARAR', 'durdur']) expect(isStopKeyword(w)).toBe(true);
    for (const w of ['START', 'unstop', 'empezar']) expect(isStartKeyword(w)).toBe(true);
    expect(isStopKeyword('I cannot make my shift, stop by the desk')).toBe(false);
  });
});

describe('send({ channel: SMS })', () => {
  const recipient = { userId: null, phone: '+1 555 010 0100', email: null };

  it('with no provider: throws SmsNotConfiguredError and records a NOT_CONFIGURED row — never SENT', async () => {
    expect(smsAvailability()).toMatchObject({ available: false, reason: expect.stringMatching(/TWILIO/) });
    await expect(send({ channel: 'SMS', recipient, subject: null, body: 'Shift at 6', category: 'test' })).rejects.toBeInstanceOf(SmsNotConfiguredError);
    const rows = await prisma.notification.findMany({ where: { channel: 'SMS' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'NOT_CONFIGURED', recipientPhone: '+1 555 010 0100', category: 'test', sentAt: null });
    expect(rows[0]!.failureReason).toMatch(/Texting isn’t connected/);
  });

  it('with a provider: the transport gets E.164 + the words and the SID comes back', async () => {
    const calls: Array<{ to: string; body: string }> = [];
    setSmsTransportForTests(async (m) => {
      calls.push(m);
      return { sid: 'SM1', status: 'queued' };
    });
    expect(smsAvailability()).toEqual({ available: true, reason: null });
    const r = await send({ channel: 'SMS', recipient, subject: 'Alto', body: 'Shift at 6', audit: false });
    expect(r).toEqual({ externalRef: 'SM1', providerMessageId: 'SM1' });
    expect(calls).toEqual([{ to: '+15550100100', body: 'Alto\nShift at 6' }]);
    expect(await prisma.notification.count()).toBe(0); // audit:false — the caller owns the row
  });

  it('a provider error is FAILED with the reason, not SENT', async () => {
    setSmsTransportForTests(async () => {
      throw new Error('Twilio 400: 21211 Invalid To number');
    });
    await expect(send({ channel: 'SMS', recipient, subject: null, body: 'x' })).rejects.toThrow(/21211/);
    expect(await prisma.notification.findFirst({ where: { channel: 'SMS' } })).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/21211/) });
  });

  it('a number that texted STOP is suppressed until it texts START', async () => {
    const calls: string[] = [];
    setSmsTransportForTests(async (m) => {
      calls.push(m.to);
      return { sid: 'SM2', status: 'queued' };
    });
    expect(await handleSmsKeyword({ from: '+15550100100', text: 'STOP' })).toMatch(/unsubscribed/i);
    expect(await isSmsOptedOut('555-010-0100')).toBe(true);
    await expect(send({ channel: 'SMS', recipient, subject: null, body: 'x' })).rejects.toBeInstanceOf(SmsOptedOutError);
    expect(calls).toEqual([]);
    expect(await prisma.notification.findFirst({ where: { channel: 'SMS' } })).toMatchObject({ status: 'SUPPRESSED' });
    expect(await handleSmsKeyword({ from: '+15550100100', text: 'start' })).toMatch(/subscribed/i);
    expect(await isSmsOptedOut('+15550100100')).toBe(false);
    await send({ channel: 'SMS', recipient, subject: null, body: 'x', audit: false });
    expect(calls).toEqual(['+15550100100']);
    expect(await handleSmsKeyword({ from: '+15550100100', text: 'running late' })).toBeNull();
  });

  it('maps every send error to the status that tells the truth', () => {
    expect(statusForSendError(new SmsNotConfiguredError())).toBe('NOT_CONFIGURED');
    expect(statusForSendError(new PushNotConfiguredError())).toBe('NOT_CONFIGURED');
    expect(statusForSendError(new SmsOptedOutError('+15550100100'))).toBe('SUPPRESSED');
    expect(statusForSendError(new Error('boom'))).toBe('FAILED');
  });
});

describe('send({ channel: PUSH })', () => {
  it('with no push transport: NOT_CONFIGURED, never SENT', async () => {
    const { user } = await createUser({ role: 'ASSOCIATE' });
    await expect(send({ channel: 'PUSH', recipient: { userId: user.id, phone: null, email: null }, subject: 'Hi', body: 'x' })).rejects.toBeInstanceOf(PushNotConfiguredError);
    expect(await prisma.notification.findFirst({ where: { channel: 'PUSH' } })).toMatchObject({ status: 'NOT_CONFIGURED' });
  });
});

describe('send({ channel: WHATSAPP }) through the generic sender', () => {
  it('refuses — WhatsApp goes out through its templates — and records NOT_CONFIGURED, never a stub SENT', async () => {
    await expect(send({ channel: 'WHATSAPP', recipient: { userId: null, phone: '+15550100100', email: null }, subject: null, body: 'x' })).rejects.toBeInstanceOf(WhatsAppNotRoutedError);
    expect(await prisma.notification.findFirst({ where: { channel: 'WHATSAPP' } })).toMatchObject({ status: 'NOT_CONFIGURED' });
  });
});

describe('POST /voice/sms (Twilio inbound)', () => {
  it('records STOP from any number, signed by Twilio, and answers the confirmation', async () => {
    const token = 'twilio-test-token';
    (env as Record<string, unknown>).TWILIO_AUTH_TOKEN = token;
    (env as Record<string, unknown>).TWILIO_WEBHOOK_BASE_URL = 'https://api.example.test';
    try {
      const params = { From: '+15550100199', Body: 'STOP' };
      const url = 'https://api.example.test/voice/sms';
      const res = await request(createApp())
        .post('/voice/sms')
        .set('x-twilio-signature', twilioSignature(token, url, params))
        .type('form')
        .send(params);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/unsubscribed/i);
      expect(await prisma.smsOptOut.findUnique({ where: { phone: '+15550100199' } })).toMatchObject({ reason: 'STOP', source: 'twilio_sms' });
      // Unsigned: refused, nothing recorded.
      const bad = await request(createApp()).post('/voice/sms').type('form').send({ From: '+15550100198', Body: 'STOP' });
      expect(bad.status).toBe(403);
      expect(await prisma.smsOptOut.count()).toBe(1);
    } finally {
      (env as Record<string, unknown>).TWILIO_AUTH_TOKEN = undefined;
      (env as Record<string, unknown>).TWILIO_WEBHOOK_BASE_URL = undefined;
    }
  });
});
