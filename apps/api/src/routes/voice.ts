import express, { Router, type Request, type Response } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import { resolveTenantFrom } from '../lib/tenant.js';
import { handleSmsKeyword } from '../lib/sms.js';
import {
  CALL_OUT_TEXT,
  CallOutError,
  nextCallableShift,
  placeOf,
  recordCallOut,
  toCallOutLang,
  whenLabel,
  zoneOf,
} from '../lib/callOuts.js';
import {
  VOICE_REASONS,
  VOICE_TEXT,
  associateByPhone,
  handleCallOutText,
  readCallState,
  signCallState,
  twiml,
  verifyTwilioSignature,
} from '../lib/callOutChannels.js';

/**
 * The call-out line (Twilio). Mounted before the session parser, like every
 * webhook; each request must carry a valid X-Twilio-Signature over the
 * exact URL and form body, or it's refused. With no TWILIO_AUTH_TOKEN the
 * line is off (503) — nothing else in the product depends on it.
 *
 *   POST /voice/inbound     a call: who is calling → "press 1 to call out of {shift}"
 *   POST /voice/callout     their key: 1 → the reasons menu, 2 → keep the shift
 *   POST /voice/reason      the reason key → the call-out is recorded and applied
 *   POST /voice/recording   anything else they said, kept on the call-out for the lead
 *   POST /voice/sms         a text message — the same words and YES/NO as WhatsApp
 */

export const voiceRouter = Router();
voiceRouter.use(express.urlencoded({ extended: false, limit: '64kb' }));

function publicUrl(req: Request): string {
  const base = env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  return `${base}${req.originalUrl}`;
}

/** Twilio or nothing: the line is off without a token, and unsigned requests are refused. */
function guard(req: Request, res: Response): boolean {
  if (!env.TWILIO_AUTH_TOKEN) {
    res.status(503).json({ error: { code: 'voice_off', message: 'The call-out line is not configured.' } });
    return false;
  }
  const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  if (!verifyTwilioSignature(publicUrl(req), params, req.header('x-twilio-signature'))) {
    res.status(403).json({ error: { code: 'invalid_signature', message: 'Signature check failed.' } });
    return false;
  }
  return true;
}

const send = (res: Response, body: string) => res.type('text/xml').send(body);
const field = (req: Request, k: string) => String((req.body as Record<string, unknown> | undefined)?.[k] ?? '');

/** Base path for the next step's action, as mounted (stripApiPrefix keeps /voice). */
const step = (req: Request, path: string, state: string) => `${req.baseUrl}${path}?s=${encodeURIComponent(state)}`;

voiceRouter.post('/inbound', async (req, res) => {
  if (!guard(req, res)) return;
  const caller = await associateByPhone(field(req, 'From'));
  if (!caller) return send(res, twiml.doc(twiml.say('en', VOICE_TEXT.unknown())));
  if (caller.tenantId) await resolveTenantFrom(async () => caller.tenantId);
  const lang = toCallOutLang(caller.language);
  const shift = await nextCallableShift(prisma, caller.id);
  if (!shift) return send(res, twiml.doc(twiml.say(lang, CALL_OUT_TEXT.noShift(lang))));
  const state = signCallState({ a: caller.id, s: shift.id, l: lang });
  const when = whenLabel(shift.startsAt, zoneOf(shift), lang);
  send(res, twiml.doc(twiml.gather(step(req, '/callout', state), twiml.say(lang, VOICE_TEXT.menu(lang, placeOf(shift), when))), twiml.say(lang, VOICE_TEXT.noInput(lang))));
});

voiceRouter.post('/callout', async (req, res) => {
  if (!guard(req, res)) return;
  const st = readCallState(typeof req.query.s === 'string' ? req.query.s : undefined);
  if (!st) return send(res, twiml.doc(twiml.say('en', VOICE_TEXT.noInput('en'))));
  const lang = toCallOutLang(st.l);
  if (field(req, 'Digits') !== '1') {
    const shift = await prisma.shift.findUnique({ where: { id: st.s }, select: { startsAt: true, locationRel: { select: { timezone: true } } } });
    return send(res, twiml.doc(twiml.say(lang, shift ? CALL_OUT_TEXT.kept(lang, whenLabel(shift.startsAt, shift.locationRel?.timezone ?? 'America/New_York', lang)) : VOICE_TEXT.thanks(lang))));
  }
  send(res, twiml.doc(twiml.gather(step(req, '/reason', signCallState({ a: st.a!, s: st.s!, l: lang })), twiml.say(lang, VOICE_TEXT.reasons(lang))), twiml.say(lang, VOICE_TEXT.noInput(lang))));
});

voiceRouter.post('/reason', async (req, res) => {
  if (!guard(req, res)) return;
  const st = readCallState(typeof req.query.s === 'string' ? req.query.s : undefined);
  if (!st) return send(res, twiml.doc(twiml.say('en', VOICE_TEXT.noInput('en'))));
  const lang = toCallOutLang(st.l);
  const reason = VOICE_REASONS[field(req, 'Digits') as keyof typeof VOICE_REASONS] ?? 'OTHER';
  const associate = await prisma.associate.findUnique({ where: { id: st.a }, select: { tenantId: true } });
  if (associate?.tenantId) await resolveTenantFrom(async () => associate.tenantId);
  try {
    const r = await recordCallOut({ associateId: st.a!, shiftId: st.s!, channel: 'VOICE', reason, confirm: true });
    const when = whenLabel(r.shift.startsAt, zoneOf(r.shift), lang);
    const said = r.outcome === 'duplicate' ? CALL_OUT_TEXT.already(lang, when) : CALL_OUT_TEXT.confirmed(lang, placeOf(r.shift), when);
    const recState = signCallState({ c: r.callOutId, l: lang });
    send(res, twiml.doc(twiml.say(lang, said), twiml.say(lang, VOICE_TEXT.record(lang)), twiml.record(step(req, '/recording', recState))));
  } catch (err) {
    if (err instanceof CallOutError) return send(res, twiml.doc(twiml.say(lang, err.message)));
    throw err;
  }
});

voiceRouter.post('/recording', async (req, res) => {
  if (!guard(req, res)) return;
  const st = readCallState(typeof req.query.s === 'string' ? req.query.s : undefined);
  const lang = toCallOutLang(st?.l);
  const url = field(req, 'RecordingUrl');
  if (st?.c && /^https:\/\//.test(url)) {
    await prisma.callOut.update({ where: { id: st.c }, data: { recordingUrl: url.slice(0, 500) } }).catch(() => undefined);
  }
  send(res, twiml.doc(twiml.say(lang, VOICE_TEXT.thanks(lang))));
});

voiceRouter.post('/sms', async (req, res) => {
  if (!guard(req, res)) return;
  // STOP / START first, for any number — a candidate who never became an
  // associate can still opt out, and the opt-out is kept here so our own
  // sender never tries the number again (Twilio blocks it on its side too).
  const keyword = await handleSmsKeyword({ from: field(req, 'From'), text: field(req, 'Body').slice(0, 100), source: 'twilio_sms' });
  if (keyword) return send(res, twiml.doc(twiml.message(keyword)));
  const caller = await associateByPhone(field(req, 'From'));
  if (!caller) return send(res, twiml.doc());
  if (caller.tenantId) await resolveTenantFrom(async () => caller.tenantId);
  const handled = await handleCallOutText({ associateId: caller.id, text: field(req, 'Body').slice(0, 1000), channel: 'SMS', language: caller.language });
  send(res, handled ? twiml.doc(twiml.message(handled.reply)) : twiml.doc());
});
