import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallOutChannel, PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../db.js';
import {
  CALL_OUT_TEXT,
  cancelCallOut,
  confirmCallOut,
  detectCallOut,
  nextCallableShift,
  pendingCallOutFor,
  placeOf,
  recordCallOut,
  toCallOutLang,
  whenLabel,
  zoneOf,
  type CallOutLang,
} from './callOuts.js';

/**
 * The ways a call-out arrives without the app: a WhatsApp or text message
 * (the same words, the same YES/NO), and a phone call to the call-out line
 * (Twilio Voice). Every Twilio request is verified with its signature;
 * state carried between the steps of a call is signed too, so a caller
 * can't be steered onto someone else's shift.
 */

type Db = PrismaClient;

/* ----- Who is texting or calling ------------------------------------------- */

const digits = (s: string) => s.replace(/\D/g, '');
const last10 = (s: string) => digits(s).slice(-10);

/** The one active worker behind a phone number, or null when it's unknown or ambiguous. */
export async function associateByPhone(phone: string, db: Db = defaultPrisma): Promise<{ id: string; tenantId: string | null; language: string | null } | null> {
  const want = last10(phone);
  if (want.length < 10) return null;
  const consent = await db.whatsAppConsent.findFirst({ where: { phone: { endsWith: want } }, orderBy: { updatedAt: 'desc' }, select: { associateId: true } });
  let ids = consent?.associateId ? [consent.associateId] : [];
  if (ids.length === 0) {
    const rows = await db.associate.findMany({
      where: { deletedAt: null, deactivatedAt: null, phone: { contains: want.slice(-4) } },
      select: { id: true, phone: true },
      take: 50,
    });
    ids = rows.filter((r) => r.phone && last10(r.phone) === want).map((r) => r.id);
  }
  // Two people on one number: never guess.
  if (ids.length !== 1) return null;
  const a = await db.associate.findUnique({ where: { id: ids[0] }, select: { id: true, tenantId: true } });
  if (!a) return null;
  const user = await db.user.findFirst({ where: { associateId: a.id, deletedAt: null }, select: { language: true } });
  return { id: a.id, tenantId: a.tenantId, language: user?.language ?? null };
}

/* ----- WhatsApp and SMS: the same words ----------------------------------- */

const YES = /^\s*(yes|y|yeah|yep|confirm|s[ií]|evet|e|wi|sim|так|да)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|nope|hayır|hayir|non|n[ãa]o|ні|нет)\s*[.!]*\s*$/i;

export function yesNo(text: string): 'YES' | 'NO' | null {
  if (YES.test(text)) return 'YES';
  if (NO.test(text)) return 'NO';
  return null;
}

/**
 * A message from a known worker: answer an open call-out ask, or start one.
 * Returns the reply, or null when the message isn't about a call-out (the
 * channel's own assistant takes it from there).
 */
export async function handleCallOutText(
  input: { associateId: string; text: string; channel: Extract<CallOutChannel, 'WHATSAPP' | 'SMS'>; language: string | null; now?: Date },
  db: Db = defaultPrisma,
): Promise<{ reply: string; outcome: 'asked' | 'confirmed' | 'kept' | 'already' | 'no_shift' } | null> {
  const now = input.now ?? new Date();
  const lang = toCallOutLang(input.language);
  const pending = await pendingCallOutFor(db, input.associateId, now);
  const yn = yesNo(input.text);
  if (pending && yn) {
    const when = whenLabel(pending.shift.startsAt, zoneOf(pending.shift), lang);
    if (yn === 'NO') {
      await cancelCallOut(db, pending.id);
      return { reply: CALL_OUT_TEXT.kept(lang, when), outcome: 'kept' };
    }
    const done = await confirmCallOut(pending.id, now, db);
    if (!done) return { reply: CALL_OUT_TEXT.already(lang, when), outcome: 'already' };
    return { reply: CALL_OUT_TEXT.confirmed(lang, placeOf(done.shift), when), outcome: 'confirmed' };
  }
  const hit = detectCallOut(input.text);
  if (!hit) return null;
  const shift = await nextCallableShift(db, input.associateId, now);
  if (!shift) {
    // Already called out of the next one? Say so rather than "no shift".
    return { reply: CALL_OUT_TEXT.noShift(lang), outcome: 'no_shift' };
  }
  const r = await recordCallOut({ associateId: input.associateId, shiftId: shift.id, channel: input.channel, reason: hit.reason, note: input.text.slice(0, 500), confirm: false, now }, db);
  const when = whenLabel(shift.startsAt, zoneOf(shift), lang);
  if (r.outcome === 'duplicate') return { reply: CALL_OUT_TEXT.already(lang, when), outcome: 'already' };
  return { reply: CALL_OUT_TEXT.ask(lang, placeOf(shift), when), outcome: 'asked' };
}

/* ----- Twilio: signatures, signed state, TwiML ----------------------------- */

/** Twilio's request signature: HMAC-SHA1 over the URL plus the sorted POST params, base64. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + (params[k] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!env.TWILIO_AUTH_TOKEN || !header) return false;
  const want = Buffer.from(twilioSignature(env.TWILIO_AUTH_TOKEN, url, params));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

function stateSecret(): string {
  return env.ASSISTANT_ACTION_SECRET ?? `${env.JWT_SECRET}:call-out-line`;
}

/** Sign what one step of a call hands the next: who, which shift, until when. */
export function signCallState(payload: Record<string, string>, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function readCallState(token: string | undefined): Record<string, string> | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, string> & { exp: number };
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now() / 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The voice each language is read in (Twilio <Say language>). Haitian Creole is read in French. */
export const VOICE_LANG: Record<CallOutLang, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR', ht: 'fr-FR', pt: 'pt-BR', uk: 'uk-UA' };

export const twiml = {
  say: (lang: CallOutLang, text: string) => `<Say language="${VOICE_LANG[lang]}">${xml(text)}</Say>`,
  gather: (action: string, inner: string) => `<Gather input="dtmf" numDigits="1" timeout="8" action="${xml(action)}" method="POST">${inner}</Gather>`,
  record: (action: string) => `<Record maxLength="30" playBeep="true" trim="trim-silence" action="${xml(action)}" method="POST"/>`,
  message: (text: string) => `<Message>${xml(text)}</Message>`,
  doc: (...parts: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`,
};

/** What the call-out line says, in the caller's language. */
export const VOICE_TEXT = {
  menu: (l: CallOutLang, place: string, when: string) =>
    ({
      en: `Hi. To call out of your shift at ${place}, ${when}, press 1. To keep your shift, press 2.`,
      es: `Hola. Para avisar que no irás a tu turno en ${place}, ${when}, marca 1. Para mantener tu turno, marca 2.`,
      tr: `Merhaba. ${place}, ${when} vardiyana gelemeyeceğini bildirmek için 1'e, vardiyanı tutmak için 2'ye bas.`,
      ht: `Bonjou. Pou di ou p ap vini nan chif ou nan ${place}, ${when}, peze 1. Pou kenbe chif ou, peze 2.`,
      pt: `Olá. Para avisar que não vai ao seu turno em ${place}, ${when}, digite 1. Para manter o turno, digite 2.`,
      uk: `Вітаємо. Щоб повідомити, що не вийдете на зміну в ${place}, ${when}, натисніть 1. Щоб залишити зміну, натисніть 2.`,
    })[l],
  reasons: (l: CallOutLang) =>
    ({
      en: 'Why can’t you make it? Press 1 for sick, 2 for family, 3 for transportation, 4 for an emergency, 5 for something else.',
      es: '¿Por qué no puedes ir? Marca 1 si estás enfermo, 2 por familia, 3 por transporte, 4 por una emergencia, 5 por otra razón.',
      tr: 'Neden gelemiyorsun? Hastalık için 1, aile için 2, ulaşım için 3, acil durum için 4, başka bir sebep için 5.',
      ht: 'Poukisa ou p ap ka vini? Peze 1 si ou malad, 2 pou fanmi, 3 pou transpò, 4 pou yon ijans, 5 pou lòt bagay.',
      pt: 'Por que não pode ir? Digite 1 se estiver doente, 2 por família, 3 por transporte, 4 por emergência, 5 por outro motivo.',
      uk: 'Чому не зможете? Натисніть 1 — хвороба, 2 — сім’я, 3 — транспорт, 4 — надзвичайна ситуація, 5 — інше.',
    })[l],
  record: (l: CallOutLang) =>
    ({
      en: 'If your lead should know anything else, say it after the tone, then hang up.',
      es: 'Si tu líder debe saber algo más, dilo después del tono y luego cuelga.',
      tr: 'Liderinin bilmesi gereken başka bir şey varsa sinyalden sonra söyle, sonra kapat.',
      ht: 'Si lidè ou ta dwe konnen lòt bagay, di l apre son an, epi rakwoche.',
      pt: 'Se o seu líder precisar saber mais alguma coisa, fale após o sinal e desligue.',
      uk: 'Якщо керівнику варто знати щось ще, скажіть після сигналу і покладіть слухавку.',
    })[l],
  thanks: (l: CallOutLang) => ({ en: 'Thank you. Goodbye.', es: 'Gracias. Adiós.', tr: 'Teşekkürler. Hoşça kal.', ht: 'Mèsi. Orevwa.', pt: 'Obrigado. Tchau.', uk: 'Дякуємо. До побачення.' })[l],
  unknown: () =>
    'We couldn’t match this phone number to a worker. Please call your lead, or add this number to your profile in the app. Goodbye.',
  noInput: (l: CallOutLang) =>
    ({ en: 'We didn’t get that. Nothing has changed. Goodbye.', es: 'No recibimos tu respuesta. No cambió nada. Adiós.', tr: 'Yanıt alamadık. Hiçbir şey değişmedi. Hoşça kal.', ht: 'Nou pa resevwa repons ou. Anyen pa chanje. Orevwa.', pt: 'Não recebemos sua resposta. Nada mudou. Tchau.', uk: 'Ми не отримали відповіді. Нічого не змінилося. До побачення.' })[l],
};

export const VOICE_REASONS = { '1': 'SICK', '2': 'FAMILY', '3': 'TRANSPORT', '4': 'EMERGENCY', '5': 'OTHER' } as const;
